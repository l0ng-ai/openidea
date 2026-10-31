// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/PatchToolset.kt, FileToolset.kt), Apache-2.0.
//! Changing the project and the editor: new files, patches, formatting and imports,
//! rename, open editors.
//!
//! Text changes go through the document layer: an open editor's buffer is
//! patched in place (it updates live and the change is undoable there), files
//! that are not open are opened transiently and closed again, and every changed
//! file is saved, because agents read the result back from disk. Saves record
//! Local History like the IDE's own edits.

mod diff;
mod format;
mod imports;
mod patch;
mod rename;

use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::mcp::{McpOpenEditors, McpToolKind, McpUiRequest};
use ide_core::{DocId, IdeError, IdeResult, Pos, Range, TextEdit, WorkspaceEdit};
use ide_host::Project;
use patch::FileOp;
use serde_json::json;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

pub fn tools() -> Vec<Tool> {
    vec![
        create_new_file(),
        apply_patch(),
        format::reformat_file(),
        format::optimize_imports(),
        imports::add_missing_imports(),
        rename::rename_refactoring(),
        open_file_in_editor(),
        get_all_open_file_paths(),
    ]
}

/// What tools without a result value answer (JetBrains renders `Unit` so).
const SUCCESS: &str = "[success]";

// --- the document layer ----------------------------------------------------------

/// Whether the file is open with unsaved changes.
fn is_dirty(project: &Project, path: &Path) -> bool {
    project.documents.by_path(path).is_some_and(|d| project.documents.is_dirty(d).unwrap_or(false))
}

/// Replaces the whole text (minimal diff, so editors keep their state) and saves.
fn write_document(project: &Project, path: &Path, text: &str) -> IdeResult<()> {
    let docs = &project.documents;
    let (doc, transient) = open_document(project, path)?;
    let result = docs.replace_all(doc, text).and_then(|_| docs.save(doc));
    if transient {
        docs.close(doc);
    }
    result
}

/// The open document of `path`, or a transient one (`true`: close it after use).
fn open_document(project: &Project, path: &Path) -> IdeResult<(DocId, bool)> {
    match project.documents.by_path(path) {
        Some(doc) => Ok((doc, false)),
        None => Ok((project.documents.open(path)?.id, true)),
    }
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// The range of a whole text.
fn whole_range(text: &str) -> Range {
    let count = text.split('\n').count();
    let last = text.rsplit('\n').next().unwrap_or("");
    Range::new(Pos::new(0, 0), Pos::new(count.saturating_sub(1) as u32, last.encode_utf16().count() as u32))
}

/// Byte offset of a 0-based line / UTF-16 column position, clamped to the text.
fn byte_offset(line_starts: &[usize], text: &str, pos: Pos) -> usize {
    let Some(&start) = line_starts.get(pos.line as usize) else { return text.len() };
    let end = text[start..].find('\n').map_or(text.len(), |i| start + i);
    let mut units = 0u32;
    for (i, c) in text[start..end].char_indices() {
        if units >= pos.col {
            return start + i;
        }
        units += c.len_utf16() as u32;
    }
    end
}

/// Applies edits made against `text` (LSP rules: non-overlapping, same-position
/// inserts in order). `None` when two edits overlap.
fn apply_text_edits(text: &str, edits: &[TextEdit]) -> Option<String> {
    let starts: Vec<usize> = std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1)).collect::<Vec<_>>();
    let mut spans: Vec<(usize, usize, usize)> = edits
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let from = byte_offset(&starts, text, e.range.start);
            (from, byte_offset(&starts, text, e.range.end).max(from), i)
        })
        .collect();
    spans.sort();
    if spans.windows(2).any(|w| w[0].1 > w[1].0) {
        return None;
    }
    let mut out = text.to_owned();
    for &(from, to, i) in spans.iter().rev() {
        out.replace_range(from..to, &edits[i].new_text);
    }
    Some(out)
}

/// Whether two paths name the same file (language servers report canonical paths; on a
/// case-insensitive file system `a.txt` and `A.txt` are one file).
fn same_file(a: &Path, b: &Path) -> bool {
    if a == b || matches!((dunce::canonicalize(a), dunce::canonicalize(b)), (Ok(x), Ok(y)) if x == y) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(x), Ok(y)) = (std::fs::metadata(a), std::fs::metadata(b)) {
            return x.dev() == y.dev() && x.ino() == y.ino();
        }
    }
    false
}

/// The text edits of `edit` for `path`.
fn edits_for(edit: &WorkspaceEdit, path: &Path) -> Vec<TextEdit> {
    edit.files
        .iter()
        .filter_map(|f| match f {
            ide_core::FileEdit::Edit { path: p, edits } if same_file(p, path) => Some(edits.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

/// Re-reads the open, unmodified documents of `paths` whose files changed on disk, before
/// a tool reads or changes them: an agent that just wrote a file itself must not have
/// that write undone from a stale buffer because the file watcher has not caught up yet
/// (JetBrains refreshes the VFS first). Documents with unsaved changes are left alone.
fn refresh_from_disk(project: &Project, paths: &[PathBuf]) {
    project.documents.on_disk_changed(paths);
}

/// Project files a tool works on: `files` resolved inside the project, existing,
/// regular, without duplicates (the first spelling is kept), changeable
/// ([`Call::check_writable`]) and with their open documents up to date with the disk.
async fn requested_files(call: &Call) -> IdeResult<Vec<(String, PathBuf)>> {
    let files = call.str_list("files")?;
    if files.is_empty() {
        return Err(IdeError::invalid("files must contain at least one path"));
    }
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for raw in files {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(IdeError::invalid("files must not contain blank paths"));
        }
        let path = call.resolve_inside(raw)?;
        if !path.exists() {
            return Err(IdeError::not_found(format!("File not found: {raw}")));
        }
        if !path.is_file() {
            return Err(IdeError::invalid(format!("Not a file: {raw}")));
        }
        if !out.iter().any(|(_, p)| *p == path) {
            out.push((raw.to_owned(), path));
        }
    }
    for (_, path) in &out {
        call.check_writable(path).await?;
    }
    let (project, paths) = (call.project().clone(), out.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>());
    call.host()
        .blocking(move || {
            refresh_from_disk(&project, &paths);
            Ok(())
        })
        .await?;
    Ok(out)
}

// --- create_new_file ----------------------------------------------------------------

fn create_new_file() -> Tool {
    Tool::new(
        "create_new_file",
        McpToolKind::Edit,
        "Creates a new file at the specified path within the project directory and optionally populates it with \
text if provided.
Use this tool to generate new files in your project structure.
Note: Creates any necessary parent directories automatically",
        |call| async move {
            let raw = call.str("pathInProject")?;
            let path = call.resolve_writable(&raw).await?;
            let text = call.opt_str("text")?.map(|t| normalize_newlines(&t));
            let overwrite = call.flag("overwrite", false)?;
            let cannot =
                |e: &dyn std::fmt::Display| IdeError::invalid(format!("Can't create file: {}: {e}", path.display()));
            if path.is_dir() {
                return Err(cannot(&"it is a directory"));
            }
            if path.exists() && !overwrite {
                return Err(IdeError::new(
                    ide_core::error::ErrorKind::AlreadyExists,
                    format!("File already exists: {raw}. Specify 'overwrite=true' to overwrite it"),
                ));
            }
            let host = call.host();
            if !path.exists() {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| cannot(&e))?;
                }
                ide_host::ops::fs::create_file(&host, call.window(), path.clone()).map_err(|e| cannot(&e.message))?;
                call.record_change(&path);
            }
            if let Some(text) = text {
                let (project, target) = (call.project().clone(), path.clone());
                host.blocking(move || write_document(&project, &target, &text)).await?;
                call.record_change(&path);
            }
            Ok(Output::text(SUCCESS))
        },
    )
    .param(Param::required(
        "pathInProject",
        ParamType::String,
        "Path where the file should be created relative to the project root",
    ))
    .param(Param::optional("text", ParamType::String, "Content to write into the new file"))
    .param(Param::optional(
        "overwrite",
        ParamType::Boolean,
        "Whether to overwrite an existing file if exists. If false, an exception is thrown in case of a conflict.",
    ))
}

// --- apply_patch --------------------------------------------------------------------

fn apply_patch() -> Tool {
    Tool::new(
        "apply_patch",
        McpToolKind::Edit,
        "Apply a patch using the Codex apply_patch format or unified git diff format.
Supports Add, Delete, and Update operations with optional Move to path for updates.
Paths must stay inside the project directory.",
        |call| async move {
            let input = [call.opt_str("input")?, call.opt_str("patch")?]
                .into_iter()
                .flatten()
                .find(|s| !s.trim().is_empty())
                .ok_or_else(|| IdeError::invalid("input must be a non-empty string"))?;
            let ops = patch::parse(&input).map_err(IdeError::invalid)?;
            let total = ops.iter().filter(|op| !matches!(op, FileOp::Skip { .. })).count();
            let mut applied = 0usize;
            let mut errors = Vec::new();
            let mut notes = Vec::new();
            // Each operation stands alone, as in JetBrains: a failed one leaves the others applied.
            for op in ops {
                if let FileOp::Skip { path, note } = op {
                    notes.push(format!("{path}: {note}"));
                    continue;
                }
                let path = op.path().to_owned();
                match apply_op(&call, op, &mut notes).await {
                    Ok(()) => applied += 1,
                    Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Err(e),
                    Err(e) => errors.push(format!("{path}: {}", e.message)),
                }
            }
            let mut out = format!("{applied} out of {total} operations applied.");
            if !errors.is_empty() {
                let _ = write!(
                    out,
                    " {} operations failed to be applied due to errors:\n{}",
                    errors.len(),
                    errors.join("\n")
                );
            }
            if !notes.is_empty() {
                out.push_str("\nNotes:");
                for n in notes {
                    let _ = write!(out, "\n- {n}");
                }
            }
            Ok(Output::text(out))
        },
    )
    .param(Param::optional(
        "input",
        ParamType::String,
        "Patch text in the apply_patch format or unified git diff format.",
    ))
    .param(Param::optional(
        "patch",
        ParamType::String,
        "Alias of `input` for compatibility with clients that send `{patch: ...}`.",
    ))
}

/// Applies one operation of a patch; its checks come first, so a failed operation changes nothing.
async fn apply_op(call: &Call, op: FileOp, notes: &mut Vec<String>) -> IdeResult<()> {
    let host = call.host();
    let project = call.project().clone();
    match op {
        // Noted by the caller.
        FileOp::Skip { .. } => Ok(()),
        FileOp::Add { path: raw, text } => {
            let path = call.resolve_writable(&raw).await?;
            if path.exists() {
                return Err(IdeError::new(
                    ide_core::error::ErrorKind::AlreadyExists,
                    format!("File already exists: {raw}"),
                ));
            }
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            ide_host::ops::fs::create_file(&host, call.window(), path.clone())?;
            call.record_change(&path);
            let target = path.clone();
            host.blocking(move || write_document(&project, &target, &text)).await
        }
        FileOp::Delete { path: raw } => {
            let path = call.resolve_writable(&raw).await?;
            if !path.exists() {
                return Err(IdeError::not_found(format!("File not found: {raw}")));
            }
            if !path.is_file() {
                return Err(IdeError::invalid(format!("Path is not a file: {raw}")));
            }
            let dirty = is_dirty(&project, &path);
            let target = path.clone();
            host.blocking(move || {
                // Local History keeps the contents; agent deletions stay out of the OS trash.
                project.history.record_deletion(&target, 1);
                ide_vfs::delete_permanently(&target)
            })
            .await?;
            call.record_change(&path);
            if dirty {
                notes.push(format!("{} had unsaved changes in the editor; they were discarded", call.display(&path)));
            }
            Ok(())
        }
        FileOp::Update { path: first, move_to, hunks, or } => {
            // A plain diff's other names count when its `+++` path does not exist.
            let mut raw = first.clone();
            let mut path = call.resolve_inside(&raw)?;
            for other in &or {
                if path.exists() {
                    break;
                }
                let candidate = call.resolve_inside(other)?;
                if candidate.exists() {
                    (raw, path) = (other.clone(), candidate);
                }
            }
            if !path.exists() {
                let tried = if or.is_empty() { String::new() } else { format!(" (also tried {})", or.join(", ")) };
                return Err(IdeError::not_found(format!("File not found: {first}{tried}")));
            }
            if !path.is_file() {
                return Err(IdeError::invalid(format!("Path is not a file: {raw}")));
            }
            if !hunks.is_empty() || move_to.is_some() {
                call.check_writable(&path).await?;
            }
            let to = match &move_to {
                Some(m) => {
                    let to = call.resolve_writable(m).await?;
                    // A move that changes only the case on a case-insensitive file system finds itself.
                    if to != path && to.exists() && !same_file(&to, &path) {
                        return Err(IdeError::new(
                            ide_core::error::ErrorKind::AlreadyExists,
                            format!("File already exists: {m}"),
                        ));
                    }
                    Some(to).filter(|t| *t != path)
                }
                None => None,
            };
            let shown = call.display(&path);
            let mut before = None;
            if !hunks.is_empty() {
                let (p, target) = (project.clone(), path.clone());
                let (text, dirty, applied) = host
                    .blocking(move || {
                        refresh_from_disk(&p, std::slice::from_ref(&target));
                        let text = p.text_of(&target)?;
                        let dirty = is_dirty(&p, &target);
                        let applied = patch::apply(&text, &hunks).map_err(|e| {
                            let mut msg = e;
                            if dirty {
                                msg.push_str(
                                    "\n(The file has unsaved changes in the editor; the patch was matched against \
the editor's text.)",
                                );
                            }
                            IdeError::invalid(msg)
                        })?;
                        Ok((text, dirty, applied))
                    })
                    .await?;
                if applied.text != text || dirty {
                    let (p, target, after) = (project.clone(), path.clone(), applied.text);
                    host.blocking(move || write_document(&p, &target, &after)).await?;
                    call.record_change(&path);
                    before = Some(text);
                }
                if dirty {
                    notes.push(format!(
                        "{shown} had unsaved changes in the editor; the patch was applied on top of them and the file \
was saved"
                    ));
                }
                for (hunk, fuzz) in applied.fuzzy {
                    notes.push(format!("{shown}: hunk {hunk} matched only {}", fuzz.describe()));
                }
            }
            let Some(to) = to else { return Ok(()) };
            let moves = vec![ide_workspace::FileMove { from: path.clone().into(), to: to.clone().into() }];
            let moved = ide_host::ops::refactor::refactor_move_files(
                &host,
                call.window(),
                moves,
                WorkspaceEdit::default(),
                "Apply patch".into(),
            )
            .await;
            if let (Err(_), Some(text)) = (&moved, before) {
                // The operation fails as a whole: put the text back.
                let target = path.clone();
                if let Err(e) = host.blocking(move || write_document(&project, &target, &text)).await {
                    tracing::warn!("apply_patch: restoring {shown} failed: {e}");
                }
            }
            if moved.is_ok() {
                call.record_change(&path);
                call.record_change(&to);
            }
            moved.map(|_| ())
        }
    }
}

// --- the editor ------------------------------------------------------------------------

fn open_file_in_editor() -> Tool {
    Tool::new(
        "open_file_in_editor",
        McpToolKind::Edit,
        "Opens the specified file in the IDE editor.
Requires a filePath parameter containing the path to the file to open.
The file path can be absolute or relative to the project root.
Optionally puts the caret at a 1-based line and column.",
        |call| async move {
            let raw = call.str("filePath")?;
            // Opening shows the file to the user: outside the project the user agrees first.
            let path = call.resolve_readable(&raw).await?;
            if !path.is_file() {
                return Err(IdeError::not_found(format!("File {raw} doesn't exist or can't be opened")));
            }
            let positive = |name: &str| -> IdeResult<Option<u32>> {
                match call.opt_i64(name)? {
                    None => Ok(None),
                    Some(n) if n < 1 => Err(IdeError::invalid(format!("`{name}` is 1-based and must be at least 1"))),
                    Some(n) => Ok(Some(n as u32)),
                }
            };
            let (line, column) = (positive("line")?, positive("column")?);
            call.ask(McpUiRequest::OpenFile { path: path.into(), line, column }).await?;
            Ok(Output::text(SUCCESS))
        },
    )
    .param(Param::required("filePath", ParamType::String, "Path relative to the project root"))
    .param(Param::optional("line", ParamType::Integer, "1-based line to put the caret on"))
    .param(Param::optional("column", ParamType::Integer, "1-based column on that line"))
}

fn get_all_open_file_paths() -> Tool {
    Tool::new(
        "get_all_open_file_paths",
        McpToolKind::Read,
        "Returns active editor's and other open editors' file paths relative to the project root.

Use this tool to explore current open editors.",
        |call| async move {
            let answer = call.ask(McpUiRequest::OpenEditors).await?;
            let editors: McpOpenEditors = if answer.is_null() {
                McpOpenEditors::default()
            } else {
                serde_json::from_value(answer)
                    .map_err(|e| IdeError::internal(format!("unexpected open editors answer: {e}")))?
            };
            let shown = |p: &Path| call.display(p);
            Output::json(json!({
                "activeFilePath": editors.active.as_deref().map(shown),
                "openFiles": editors.open.iter().map(|p| shown(p)).collect::<Vec<_>>(),
            }))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(sl: u32, sc: u32, el: u32, ec: u32, text: &str) -> TextEdit {
        TextEdit { range: Range::new(Pos::new(sl, sc), Pos::new(el, ec)), new_text: text.into() }
    }

    #[test]
    fn applies_text_edits_in_utf16_columns() {
        let text = "use a;\nfn ä() { b }\n";
        let edits = [edit(0, 0, 0, 0, "use x;\n"), edit(0, 0, 0, 0, "use y;\n"), edit(1, 9, 1, 10, "c")];
        assert_eq!(apply_text_edits(text, &edits).unwrap(), "use x;\nuse y;\nuse a;\nfn ä() { c }\n");
        assert!(apply_text_edits(text, &[edit(0, 0, 0, 5, "x"), edit(0, 2, 0, 3, "y")]).is_none());
        assert_eq!(whole_range("a\nbc"), Range::new(Pos::new(0, 0), Pos::new(1, 2)));
    }

    #[test]
    fn request_ids_stay_out_of_the_ui_range() {
        assert!(crate::tool::request_id().0 >= 0x8000_0000);
    }
}
