// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/PatchToolset.kt, FileToolset.kt), Apache-2.0.
//! Changing the project and the editor: new files, patches, formatting and imports,
//! rename, open editors.
//!
//! Text changes go through the document layer: an open editor's buffer is
//! patched in place and remains unsaved. Other files are opened transiently,
//! saved and closed. Saves record Local History like the IDE's own edits.

mod diff;
mod format;
mod patch;
mod rename;

use crate::Project;
use crate::mcp::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::event::McpUiRequest;
use ide_core::{DocId, FileEdit, IdeError, IdeResult, Pos, Range, TextEdit, WorkspaceEdit};
use patch::FileOp;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

pub fn tools() -> Vec<Tool> {
    vec![create_new_file(), apply_patch(), format::reformat_file(), rename::rename_refactoring(), open_file_in_editor()]
}

/// What tools without a result value answer (JetBrains renders `Unit` so).
const SUCCESS: &str = "[success]";

// --- the document layer ----------------------------------------------------------

/// Whether the file is open with unsaved changes.
fn is_dirty(project: &Project, path: &Path) -> bool {
    project.documents.by_path(path).is_some_and(|d| project.documents.is_dirty(d).unwrap_or(false))
}

async fn create_or_replace(call: &Call, path: PathBuf, text: Option<String>, overwrite: bool) -> IdeResult<()> {
    let project = call.project.clone();
    let edit = call
        .host
        .blocking(move || {
            let mut files = Vec::new();
            if path.exists() {
                if !overwrite {
                    return Err(IdeError::invalid("File already exists"));
                }
                if let Some(text) = text {
                    let info = project.documents.open(&path)?;
                    let result: IdeResult<()> = (|| {
                        let snap = project.documents.text_snapshot(info.id)?;
                        let doc = ide_text::Document::new(&snap.text);
                        let edits = doc
                            .diff(&text)
                            .changes
                            .into_iter()
                            .map(|c| TextEdit {
                                range: Range::new(doc.offset_to_pos(c.from), doc.offset_to_pos(c.to)),
                                new_text: c.insert,
                            })
                            .collect();
                        files.push(FileEdit::Edit {
                            path: path.into(),
                            edits,
                            version: Some(
                                i32::try_from(snap.version)
                                    .map_err(|_| IdeError::invalid("document version is out of range"))?,
                            ),
                        });
                        Ok(())
                    })();
                    project.documents.close(info.id);
                    result?;
                }
            } else {
                files.push(FileEdit::Create { path: path.clone().into(), overwrite: false });
                if let Some(text) = text {
                    files.push(FileEdit::Edit {
                        path: path.into(),
                        edits: vec![TextEdit { range: Range::point(Pos::new(0, 0)), new_text: text }],
                        version: None,
                    });
                }
            }
            Ok(WorkspaceEdit { files, preconditions: Vec::new() })
        })
        .await?;
    if edit.files.is_empty() {
        return Ok(());
    }
    let edit = crate::ops::lsp::prepare_workspace_edit(&call.host, call.window(), edit).await?;
    crate::ops::lsp::apply_workspace_edit(&call.host, call.window(), edit).await
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

/// Whether two paths name the same file (language servers report canonical paths; on a
/// case-insensitive file system `a.txt` and `A.txt` are one file).
fn same_file(a: &Path, b: &Path) -> bool {
    a == b || matches!((dunce::canonicalize(a), dunce::canonicalize(b)), (Ok(x), Ok(y)) if x == y) || same_inode(a, b)
}

#[cfg(unix)]
fn same_inode(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    matches!((std::fs::metadata(a), std::fs::metadata(b)), (Ok(x), Ok(y)) if x.dev() == y.dev() && x.ino() == y.ino())
}

#[cfg(not(unix))]
fn same_inode(_: &Path, _: &Path) -> bool {
    false
}

/// The text edits of `edit` for `path`.
fn edits_for(edit: &WorkspaceEdit, path: &Path) -> Vec<TextEdit> {
    edit.files
        .iter()
        .filter_map(|f| match f {
            ide_core::FileEdit::Edit { path: p, edits, .. } if same_file(p, path) => Some(edits.clone()),
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
            create_or_replace(&call, path, text, overwrite).await?;
            Ok(Output::text(SUCCESS))
        },
    )
    .write()
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
    .write()
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
                return Err(IdeError::invalid(format!("File already exists: {raw}")));
            }
            create_or_replace(call, path, Some(text), false).await
        }
        FileOp::Delete { path: raw } => {
            let path = call.resolve_writable(&raw).await?;
            if !path.is_file() {
                return Err(IdeError::not_found(format!("File not found: {raw}")));
            }
            if is_dirty(&project, &path) {
                return Err(IdeError::invalid("cannot delete a file with unsaved editor changes"));
            }
            let edit = WorkspaceEdit {
                files: vec![FileEdit::Delete { path: path.into(), recursive: false }],
                preconditions: Vec::new(),
            };
            let edit = crate::ops::lsp::prepare_workspace_edit(&host, call.window(), edit).await?;
            crate::ops::lsp::apply_workspace_edit(&host, call.window(), edit).await
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
            let (p, target) = (project.clone(), path.clone());
            let (mut edit, fuzzy, dirty) = host
                .blocking(move || {
                    refresh_from_disk(&p, std::slice::from_ref(&target));
                    let info = p.documents.open(&target)?;
                    let result = (|| {
                        let snap = p.documents.text_snapshot(info.id)?;
                        let dirty = p.documents.is_dirty(info.id)?;
                        let applied = patch::apply(&snap.text, &hunks).map_err(IdeError::invalid)?;
                        let text = ide_text::Document::new(&snap.text);
                        let edits = text
                            .diff(&applied.text)
                            .changes
                            .into_iter()
                            .map(|c| TextEdit {
                                range: Range::new(text.offset_to_pos(c.from), text.offset_to_pos(c.to)),
                                new_text: c.insert,
                            })
                            .collect();
                        Ok((
                            WorkspaceEdit {
                                files: vec![FileEdit::Edit {
                                    path: target.clone().into(),
                                    edits,
                                    version: Some(
                                        i32::try_from(snap.version)
                                            .map_err(|_| IdeError::invalid("document version is out of range"))?,
                                    ),
                                }],
                                preconditions: Vec::new(),
                            },
                            applied.fuzzy,
                            dirty,
                        ))
                    })();
                    p.documents.close(info.id);
                    result
                })
                .await?;
            if let Some(to) = to {
                edit.files.push(FileEdit::Rename { from: path.into(), to: to.into() });
            }
            let edit = crate::ops::lsp::prepare_workspace_edit(&host, call.window(), edit).await?;
            crate::ops::lsp::apply_workspace_edit(&host, call.window(), edit).await?;
            if dirty {
                notes.push(format!("{shown}: patched the unsaved editor buffer"));
            }
            for (hunk, fuzz) in fuzzy {
                notes.push(format!("{shown}: hunk {hunk} matched only {}", fuzz.describe()));
            }
            Ok(())
        }
    }
}

// --- the editor ------------------------------------------------------------------------

fn open_file_in_editor() -> Tool {
    Tool::new(
        "open_file_in_editor",
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
                    Some(n) if n < 1 || n > u32::MAX as i64 => {
                        Err(IdeError::invalid(format!("`{name}` is 1-based and must be at least 1")))
                    }
                    Some(n) => Ok(Some(n as u32)),
                }
            };
            let (line, column) = (positive("line")?, positive("column")?);
            call.ask(McpUiRequest::OpenFile { path: path.into(), line, column }).await?;
            Ok(Output::text(SUCCESS))
        },
    )
    .write()
    .param(Param::required("filePath", ParamType::String, "Path relative to the project root"))
    .param(Param::optional("line", ParamType::Integer, "1-based line to put the caret on"))
    .param(Param::optional("column", ParamType::Integer, "1-based column on that line"))
}
