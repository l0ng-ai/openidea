//! Changing the project and the editor: new files, patches, formatting, rename, open editors.
//!
//! Text changes go through the document layer: an open editor's buffer is
//! patched in place (it updates live and the change is undoable there), files
//! that are not open are opened transiently and closed again, and every changed
//! file is saved, because agents read the result back from disk. Saves record
//! Local History like the IDE's own edits.

mod patch;

use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::mcp::{McpOpenEditors, McpToolKind, McpUiRequest};
use ide_core::{DocId, FileEdit, IdeError, IdeResult, Pos, WorkspaceEdit};
use ide_host::Project;
use patch::{FileOp, Fuzz};
use serde_json::json;
use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

pub fn tools() -> Vec<Tool> {
    vec![
        create_new_file(),
        apply_patch(),
        reformat_file(),
        rename_refactoring(),
        open_file_in_editor(),
        get_all_open_file_paths(),
    ]
}

// --- the document layer ----------------------------------------------------------

/// Whether the file is open with unsaved changes.
fn is_dirty(project: &Project, path: &Path) -> bool {
    project.documents.by_path(path).is_some_and(|d| project.documents.is_dirty(d).unwrap_or(false))
}

/// Replaces the whole text (minimal diff, so editors keep their state) and saves.
fn write_document(project: &Project, path: &Path, text: &str) -> IdeResult<()> {
    let docs = &project.documents;
    let (doc, transient) = match docs.by_path(path) {
        Some(doc) => (doc, false),
        None => (docs.open(path)?.id, true),
    };
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

// --- create_new_file ----------------------------------------------------------------

fn create_new_file() -> Tool {
    Tool::new(
        "create_new_file",
        McpToolKind::Edit,
        "Creates a file in the project with the given text, creating missing parent directories. Fails if the \
file exists unless `overwrite` is true. Line endings and encoding follow the project's settings (EditorConfig).",
        |call| async move {
            let path = call.resolve_inside(&call.str("pathInProject")?)?;
            let text = normalize_newlines(&call.opt_str("text")?.unwrap_or_default());
            let overwrite = call.flag("overwrite", false)?;
            let shown = call.display(&path);
            if path.is_dir() {
                return Err(IdeError::invalid(format!("{shown} is a directory")));
            }
            let existed = path.exists();
            if existed && !overwrite {
                return Err(IdeError::new(
                    ide_core::error::ErrorKind::AlreadyExists,
                    format!(
                        "{shown} already exists; pass `overwrite: true` to replace it, or edit it with apply_patch"
                    ),
                ));
            }
            let host = call.host();
            let dirty = existed && is_dirty(call.project(), &path);
            if !existed {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                ide_host::ops::fs::create_file(&host, call.window(), path.clone())?;
            }
            let project = call.project().clone();
            let target = path.clone();
            host.blocking(move || write_document(&project, &target, &text)).await?;
            let mut out = format!("{} {shown}", if existed { "Overwrote" } else { "Created" });
            if dirty {
                out.push_str(" (its unsaved editor changes were replaced)");
            }
            Ok(Output::text(out))
        },
    )
    .param(Param::required("pathInProject", ParamType::String, "Path of the new file, relative to the project root"))
    .param(Param::optional("text", ParamType::String, "Contents of the file (default: empty)"))
    .param(Param::optional("overwrite", ParamType::Boolean, "Replace the file if it exists (default false)"))
}

// --- apply_patch --------------------------------------------------------------------

fn apply_patch() -> Tool {
    Tool::new(
        "apply_patch",
        McpToolKind::Edit,
        "Adds, deletes, moves and edits project files with one patch. Accepts the apply_patch format:
*** Begin Patch
*** Add File: path/new.txt
+line of the new file
*** Delete File: path/old.txt
*** Update File: path/file.rs
*** Move to: path/renamed.rs   (optional)
@@ fn name()   (optional: a line near the change, to locate it)
 context line
-removed line
+added line
*** End of File   (optional: the hunk ends the file)
*** End Patch
or a unified diff (`git diff` output: `--- a/path`, `+++ b/path`, `@@ -1,3 +1,4 @@`, /dev/null for new and \
deleted files). Paths are project-relative. Give about 3 lines of context around each change; hunks match by \
their context (exactly, else ignoring whitespace), not by line numbers. Everything is checked before anything is \
changed. Open editors update live (undoable there) and every file is saved.",
        |call| async move {
            let input = match call.opt_str("input")? {
                Some(s) if !s.trim().is_empty() => s,
                _ => call.opt_str("patch")?.ok_or_else(|| IdeError::invalid("missing required argument `input`"))?,
            };
            let ops = patch::parse(&input).map_err(|e| IdeError::invalid(format!("cannot parse the patch: {e}")))?;
            let plan = plan_patch(&call, ops).await?;
            run_patch(&call, plan).await
        },
    )
    .param(Param::required("input", ParamType::String, "The patch text (apply_patch format or unified diff)"))
    .param(Param::optional("patch", ParamType::String, "Alias of `input`"))
}

enum Step {
    Add { path: PathBuf, text: String },
    Delete { path: PathBuf, bytes: Vec<u8>, dirty: bool },
    Update { path: PathBuf, to: Option<PathBuf>, before: String, after: String, dirty: bool, fuzzy: Vec<(usize, Fuzz)> },
}

/// Resolves and checks every file and computes the new texts; changes nothing.
async fn plan_patch(call: &Call, ops: Vec<FileOp>) -> IdeResult<Vec<Step>> {
    let mut seen = HashSet::new();
    let mut claim = |path: &Path, raw: &str| {
        if seen.insert(path.to_path_buf()) {
            Ok(())
        } else {
            Err(IdeError::invalid(format!("the patch changes {raw} more than once; merge those changes")))
        }
    };
    let mut resolved = Vec::with_capacity(ops.len());
    for op in ops {
        match op {
            FileOp::Add { path: raw, text } => {
                let path = call.resolve_inside(&raw)?;
                claim(&path, &raw)?;
                if path.exists() {
                    return Err(IdeError::invalid(format!(
                        "cannot add {raw}: it already exists; use `*** Update File:` to change it"
                    )));
                }
                resolved.push((FileOp::Add { path: raw, text }, path, None));
            }
            FileOp::Delete { path: raw } => {
                let path = call.resolve_inside(&raw)?;
                claim(&path, &raw)?;
                if !path.is_file() {
                    return Err(IdeError::not_found(format!("cannot delete {raw}: no such file")));
                }
                resolved.push((FileOp::Delete { path: raw }, path, None));
            }
            FileOp::Update { path: first, move_to, hunks, or } => {
                // A plain diff's other names count when its `+++` path does not exist.
                let mut raw = first.clone();
                let mut path = call.resolve_inside(&raw)?;
                for other in &or {
                    if path.is_file() {
                        break;
                    }
                    let candidate = call.resolve_inside(other)?;
                    if candidate.is_file() {
                        (raw, path) = (other.clone(), candidate);
                    }
                }
                claim(&path, &raw)?;
                if !path.is_file() {
                    let tried = if or.is_empty() { String::new() } else { format!(" (nor {})", or.join(", ")) };
                    return Err(IdeError::not_found(format!("cannot update {first}{tried}: no such file")));
                }
                let to = match &move_to {
                    Some(m) => {
                        let to = call.resolve_inside(m)?;
                        if to != path {
                            claim(&to, m)?;
                            if to.exists() {
                                return Err(IdeError::invalid(format!("cannot move {raw} to {m}: it already exists")));
                            }
                        }
                        Some(to).filter(|t| *t != path)
                    }
                    None => None,
                };
                resolved.push((FileOp::Update { path: raw, move_to, hunks, or: Vec::new() }, path, to));
            }
        }
    }
    let project = call.project().clone();
    call.host()
        .blocking(move || {
            let mut steps = Vec::with_capacity(resolved.len());
            for (op, path, to) in resolved {
                steps.push(match op {
                    FileOp::Add { text, .. } => Step::Add { path, text },
                    FileOp::Delete { .. } => {
                        let bytes = std::fs::read(&path)?;
                        Step::Delete { dirty: is_dirty(&project, &path), path, bytes }
                    }
                    FileOp::Update { path: raw, hunks, .. } => {
                        let before = project.text_of(&path)?;
                        let dirty = is_dirty(&project, &path);
                        let applied = patch::apply(&before, &hunks).map_err(|e| {
                            let mut msg = format!("{raw}: {e}");
                            if dirty {
                                msg.push_str(
                                    "\n(The file has unsaved changes in the editor; the patch was matched against \
the editor's text.)",
                                );
                            }
                            IdeError::invalid(msg)
                        })?;
                        Step::Update { path, to, before, after: applied.text, dirty, fuzzy: applied.fuzzy }
                    }
                });
            }
            Ok(steps)
        })
        .await
}

/// What [`run_patch`] undoes when a later step fails.
enum Done {
    Created(PathBuf),
    Rewrote(PathBuf, String),
    /// The IDE's file move, undone through it (references updated by it are reverted too).
    Moved(u32),
    Deleted(PathBuf, Vec<u8>),
}

async fn run_patch(call: &Call, steps: Vec<Step>) -> IdeResult<Output> {
    let host = call.host();
    let window = call.window().to_owned();
    let project = call.project().clone();
    let mut done: Vec<Done> = Vec::new();
    let mut summary = String::new();
    let mut notes = Vec::new();
    for step in steps {
        let result: IdeResult<()> = async {
            match step {
                Step::Add { path, text } => {
                    if let Some(dir) = path.parent() {
                        std::fs::create_dir_all(dir)?;
                    }
                    ide_host::ops::fs::create_file(&host, &window, path.clone())?;
                    done.push(Done::Created(path.clone()));
                    let p = project.clone();
                    let target = path.clone();
                    host.blocking(move || write_document(&p, &target, &text)).await?;
                    let _ = writeln!(summary, "A {}", call.display(&path));
                }
                Step::Delete { path, bytes, dirty } => {
                    let p = project.clone();
                    let target = path.clone();
                    host.blocking(move || {
                        // Local History keeps the contents; agent deletions stay out of the OS trash.
                        p.history.record_deletion(&target, 1);
                        ide_vfs::delete_permanently(&target)
                    })
                    .await?;
                    done.push(Done::Deleted(path.clone(), bytes));
                    let shown = call.display(&path);
                    if dirty {
                        notes.push(format!("{shown} had unsaved changes in the editor; they were discarded"));
                    }
                    let _ = writeln!(summary, "D {shown}");
                }
                Step::Update { path, to, before, after, dirty, fuzzy } => {
                    let shown = call.display(&path);
                    if before != after || dirty {
                        let p = project.clone();
                        let target = path.clone();
                        host.blocking(move || write_document(&p, &target, &after)).await?;
                        done.push(Done::Rewrote(path.clone(), before));
                    }
                    if dirty {
                        notes.push(format!(
                            "{shown} had unsaved changes in the editor; the patch was applied on top of them and \
the file was saved"
                        ));
                    }
                    for (hunk, fuzz) in fuzzy {
                        let how = match fuzz {
                            Fuzz::TrailingWhitespace => "ignoring trailing whitespace",
                            _ => "ignoring indentation and whitespace",
                        };
                        notes.push(format!("{shown}: hunk {hunk} matched only {how}"));
                    }
                    match to {
                        Some(to) => {
                            let moves =
                                vec![ide_workspace::FileMove { from: path.clone().into(), to: to.clone().into() }];
                            let id = ide_host::ops::refactor::refactor_move_files(
                                &host,
                                &window,
                                moves,
                                WorkspaceEdit::default(),
                                "Apply patch".into(),
                            )
                            .await?;
                            done.push(Done::Moved(id));
                            let _ = writeln!(summary, "R {shown} -> {}", call.display(&to));
                        }
                        None => {
                            let _ = writeln!(summary, "M {shown}");
                        }
                    }
                }
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            let rolled = roll_back(&host, &window, &project, done).await;
            let state = if rolled {
                "the files changed before it were restored"
            } else {
                "restoring the files changed before it failed partly; check them"
            };
            return Err(IdeError::new(e.kind, format!("applying the patch failed: {}; {state}", e.message)));
        }
    }
    let mut out = format!("Applied the patch:\n{summary}");
    if !notes.is_empty() {
        out.push_str("Notes:\n");
        for n in notes {
            let _ = writeln!(out, "- {n}");
        }
    }
    Ok(Output::text(out.trim_end()))
}

/// Undoes completed steps, newest first; `false` if something could not be restored.
async fn roll_back(host: &ide_host::Host, window: &str, project: &std::sync::Arc<Project>, done: Vec<Done>) -> bool {
    let mut ok = true;
    for d in done.into_iter().rev() {
        let r = match d {
            Done::Moved(id) => ide_host::ops::refactor::refactor_undo_file_move(host, window, id).await.map(|_| ()),
            d => {
                let p = project.clone();
                host.blocking(move || match d {
                    Done::Created(path) => ide_vfs::delete_permanently(&path),
                    Done::Rewrote(path, text) => write_document(&p, &path, &text),
                    Done::Deleted(path, bytes) => std::fs::write(&path, bytes).map_err(IdeError::from),
                    Done::Moved(_) => Ok(()),
                })
                .await
            }
        };
        if let Err(e) = r {
            tracing::warn!("apply_patch rollback: {e}");
            ok = false;
        }
    }
    ok
}

// --- reformat_file --------------------------------------------------------------------

fn reformat_file() -> Tool {
    Tool::new(
        "reformat_file",
        McpToolKind::Edit,
        "Reformats whole files with the formatter of their language server (as Code › Reformat Code) and saves \
them. Reports per file whether it was formatted, already formatted, or has no formatter.",
        |call| async move {
            let files = call.str_list("files")?;
            if files.is_empty() {
                return Err(IdeError::invalid("missing required argument `files`"));
            }
            let mut lines = Vec::new();
            let mut ok = 0usize;
            for raw in files {
                match reformat_one(&call, &raw).await {
                    Ok(status) => {
                        ok += 1;
                        lines.push(format!("{raw}: {status}"));
                    }
                    Err(e) => lines.push(format!("{raw}: not formatted: {}", e.message)),
                }
            }
            let text = lines.join("\n");
            if ok == 0 { Err(IdeError::unavailable(text)) } else { Ok(Output::text(text)) }
        },
    )
    .param(Param::required("files", ParamType::StringList, "Project-relative paths of the files to reformat"))
}

async fn reformat_one(call: &Call, raw: &str) -> IdeResult<String> {
    let path = call.resolve_inside(raw)?;
    if !path.is_file() {
        return Err(IdeError::not_found("no such file"));
    }
    let host = call.host();
    let project = call.project().clone();
    let p = project.clone();
    let target = path.clone();
    let (doc, transient, info, dirty) = host
        .blocking(move || {
            let dirty = is_dirty(&p, &target);
            let (doc, transient) = open_document(&p, &target)?;
            match p.documents.snapshot(doc) {
                Ok(info) => Ok((doc, transient, info, dirty)),
                Err(e) => {
                    if transient {
                        p.documents.close(doc);
                    }
                    Err(e)
                }
            }
        })
        .await?;
    let result = async {
        if info.read_only {
            return Err(IdeError::invalid("the file is read-only"));
        }
        let editor = project.settings.effective().editor;
        let ec = info.editorconfig.as_ref();
        let insert_spaces = match ec.and_then(|e| e.indent_style) {
            Some(style) => style != ide_workspace::editorconfig::IndentStyle::Tab,
            None => editor.insert_spaces,
        };
        let tab_size = ec.and_then(|e| e.indent_size.or(e.tab_width)).unwrap_or(editor.tab_size);
        let options = ide_lsp::types::FormatOptions { tab_size, insert_spaces };
        let edits = tokio::select! {
            r = ide_host::ops::lsp::lsp_format(&host, call.window(), doc, None, options) => r?,
            _ = call.cancel.cancelled() => return Err(IdeError::cancelled()),
        };
        let p = project.clone();
        let count = edits.len();
        let version = info.version;
        let changed = host
            .blocking(move || {
                if p.documents.text_snapshot(doc)?.version != version {
                    return Err(IdeError::unavailable("the file changed while it was being formatted; try again"));
                }
                let before = p.documents.text_snapshot(doc)?.text;
                p.documents.apply_edits(doc, &edits)?;
                let changed = p.documents.text_snapshot(doc)?.text != before;
                p.documents.save(doc)?;
                Ok(changed)
            })
            .await?;
        let mut status = if changed { format!("formatted ({count} edits)") } else { "already formatted".to_owned() };
        if dirty {
            status.push_str("; its unsaved editor changes were saved too");
        }
        Ok(status)
    }
    .await;
    if transient {
        project.documents.close(doc);
    }
    result
}

// --- rename_refactoring ----------------------------------------------------------------

/// Words that introduce a declaration of the name after them.
const DECLARATION_KEYWORDS: &[&str] = &[
    "fn",
    "def",
    "class",
    "struct",
    "enum",
    "trait",
    "interface",
    "type",
    "func",
    "function",
    "fun",
    "let",
    "const",
    "var",
    "val",
    "mod",
    "module",
    "object",
    "record",
    "typealias",
    "protocol",
    "union",
    "namespace",
    "package",
    "static",
    "macro_rules!",
];

fn rename_refactoring() -> Tool {
    Tool::new(
        "rename_refactoring",
        McpToolKind::Edit,
        "Renames a symbol semantically with the language server, updating its declaration and every reference \
across the project (unlike a text replace, it leaves unrelated same-named symbols, comments and strings alone). \
Give a file that declares or uses the symbol; its declaration there is preferred. Changed files are saved.",
        |call| async move {
            let path = call.resolve_inside(&call.str("pathInProject")?)?;
            let name = call.str("symbolName")?.trim().to_owned();
            let new_name = call.str("newName")?.trim().to_owned();
            if name.is_empty() || new_name.is_empty() {
                return Err(IdeError::invalid("`symbolName` and `newName` must not be empty"));
            }
            if name == new_name {
                return Err(IdeError::invalid("`newName` is the symbol's current name"));
            }
            if !path.is_file() {
                return Err(IdeError::not_found(format!("{} is not a file", call.display(&path))));
            }
            let host = call.host();
            let project = call.project().clone();
            let (p, target) = (project.clone(), path.clone());
            let (doc, transient) = host.blocking(move || open_document(&p, &target)).await?;
            let result = rename_in(&call, doc, &path, &name, &new_name).await;
            if transient {
                project.documents.close(doc);
            }
            result
        },
    )
    .param(Param::required("pathInProject", ParamType::String, "Project-relative path of a file containing the symbol"))
    .param(Param::required("symbolName", ParamType::String, "The symbol's current name"))
    .param(Param::required("newName", ParamType::String, "The new name"))
}

async fn rename_in(call: &Call, doc: DocId, path: &Path, name: &str, new_name: &str) -> IdeResult<Output> {
    let host = call.host();
    let window = call.window();
    let shown = call.display(path);
    let text = call.project().documents.text_snapshot(doc)?.text;
    // Identifiers outside comments and strings where a grammar exists, else whole words.
    let positions: Vec<Pos> =
        match ide_host::ops::syntax::syntax_identifiers(&host, window, doc, name.to_owned(), None).await {
            Ok(found) if !found.is_empty() => found.into_iter().map(|o| o.range.start).collect(),
            _ => word_positions(&text, name),
        };
    if positions.is_empty() {
        return Err(IdeError::not_found(format!("`{name}` does not occur in {shown}")));
    }
    let candidates = declarations_first(&text, positions);
    let mut target = None;
    for pos in candidates.iter().take(5) {
        match ide_host::ops::lsp::lsp_prepare_rename(&host, window, doc, *pos).await {
            Ok(Some(_)) => {
                target = Some(*pos);
                break;
            }
            Ok(None) => {}
            Err(e) => {
                return Err(IdeError::new(
                    e.kind,
                    format!(
                        "cannot rename `{name}` in {shown}: {}. Rename needs a running language server for the \
file's language; without one, change the occurrences with apply_patch.",
                        e.message
                    ),
                ));
            }
        }
    }
    let pos = target.ok_or_else(|| {
        IdeError::invalid(format!("the language server cannot rename `{name}` in {shown} (not a renameable symbol)"))
    })?;
    let request = crate::tool::request_id();
    let renamed = tokio::select! {
        r = ide_host::ops::lsp::lsp_rename(&host, window, request, doc, pos, new_name.to_owned()) => r?,
        _ = call.cancel.cancelled() => {
            host.cancel_request(request);
            return Err(IdeError::cancelled());
        }
    };
    let edit = renamed.edit;
    if edit.files.is_empty() {
        return Err(IdeError::invalid(format!("the language server found nothing to rename for `{name}`")));
    }
    let mut lines = Vec::new();
    for f in &edit.files {
        match f {
            FileEdit::Edit { path, edits } => {
                crate::project::ensure_inside(call.root(), path)?;
                lines.push(format!("{} ({} occurrences)", call.display(path), edits.len()));
            }
            FileEdit::Create { path, .. } => {
                crate::project::ensure_inside(call.root(), path)?;
                lines.push(format!("{} (created)", call.display(path)));
            }
            FileEdit::Rename { from, to } => {
                crate::project::ensure_inside(call.root(), from)?;
                crate::project::ensure_inside(call.root(), to)?;
                lines.push(format!("{} -> {} (renamed)", call.display(from), call.display(to)));
            }
            FileEdit::Delete { path, .. } => {
                crate::project::ensure_inside(call.root(), path)?;
                lines.push(format!("{} (deleted)", call.display(path)));
            }
        }
    }
    let (h, w) = (host.clone(), window.to_owned());
    host.blocking(move || ide_host::ops::lsp::apply_workspace_edit(&h, &w, edit)).await?;
    let mut out = format!("Renamed `{name}` to `{new_name}`; changed files:\n{}", lines.join("\n"));
    if renamed.incomplete.is_some() {
        out.push_str("\nNote: the language server reported that the references may be incomplete.");
    }
    Ok(Output::text(out))
}

/// Whole-word occurrences of `name` (0-based line, UTF-16 column).
fn word_positions(text: &str, name: &str) -> Vec<Pos> {
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    let mut out = Vec::new();
    for (line_no, line) in text.split('\n').enumerate() {
        for (at, _) in line.match_indices(name) {
            let before = line[..at].chars().next_back();
            let after = line[at + name.len()..].chars().next();
            if before.is_some_and(is_word) || after.is_some_and(is_word) {
                continue;
            }
            let col = line[..at].encode_utf16().count() as u32;
            out.push(Pos::new(line_no as u32, col));
        }
    }
    out
}

/// `positions` with the ones that look like declarations (`fn name`, `class name`) first.
fn declarations_first(text: &str, positions: Vec<Pos>) -> Vec<Pos> {
    let lines: Vec<&str> = text.split('\n').collect();
    let is_declaration = |p: &Pos| {
        let Some(line) = lines.get(p.line as usize) else { return false };
        let mut units = 0u32;
        let byte = line
            .char_indices()
            .find(|(_, c)| {
                let here = units >= p.col;
                units += c.len_utf16() as u32;
                here
            })
            .map_or(line.len(), |(i, _)| i);
        let mut words = line[..byte].split_whitespace().rev();
        match words.next() {
            Some("mut") => words.next() == Some("let"),
            Some(w) => DECLARATION_KEYWORDS.contains(&w),
            None => false,
        }
    };
    let (mut first, rest): (Vec<Pos>, Vec<Pos>) = positions.into_iter().partition(is_declaration);
    first.extend(rest);
    first
}

// --- the editor ------------------------------------------------------------------------

fn open_file_in_editor() -> Tool {
    Tool::new(
        "open_file_in_editor",
        McpToolKind::Edit,
        "Opens a file in the IDE's editor, so the user sees it; optionally puts the caret at a 1-based line and \
column.",
        |call| async move {
            let path = call.resolve(&call.str("filePath")?)?;
            if !path.is_file() {
                return Err(IdeError::not_found(format!("{} is not a file", call.display(&path))));
            }
            let positive = |name: &str| -> IdeResult<Option<u32>> {
                match call.opt_i64(name)? {
                    None => Ok(None),
                    Some(n) if n < 1 => Err(IdeError::invalid(format!("`{name}` is 1-based and must be at least 1"))),
                    Some(n) => Ok(Some(n as u32)),
                }
            };
            let (line, column) = (positive("line")?, positive("column")?);
            call.ask(McpUiRequest::OpenFile { path: path.clone().into(), line, column }).await?;
            let mut out = format!("Opened {}", call.display(&path));
            if let Some(l) = line {
                let _ = write!(out, " at line {l}");
                if let Some(c) = column {
                    let _ = write!(out, ", column {c}");
                }
            }
            Ok(Output::text(out))
        },
    )
    .param(Param::required("filePath", ParamType::String, "Path of the file: project-relative or absolute"))
    .param(Param::optional("line", ParamType::Integer, "1-based line to put the caret on"))
    .param(Param::optional("column", ParamType::Integer, "1-based column on that line"))
}

fn get_all_open_file_paths() -> Tool {
    Tool::new(
        "get_all_open_file_paths",
        McpToolKind::Read,
        "Lists the files open in the IDE's editors: `activeFilePath` is the one the user is looking at (null when \
none), `openFiles` all open files. Paths inside the project are project-relative.",
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

    #[test]
    fn finds_whole_words_in_utf16_columns() {
        let text = "let foo = foo_bar + foo;\n// ä foo\nfoofoo";
        assert_eq!(word_positions(text, "foo"), vec![Pos::new(0, 4), Pos::new(0, 20), Pos::new(1, 5)]);
    }

    #[test]
    fn puts_declarations_first() {
        let text = "use x;\nprint(count)\nlet mut count = 1;\nfn count() {}\n";
        let ps = vec![Pos::new(1, 6), Pos::new(2, 8), Pos::new(3, 3)];
        assert_eq!(declarations_first(text, ps), vec![Pos::new(2, 8), Pos::new(3, 3), Pos::new(1, 6)]);
    }

    #[test]
    fn request_ids_stay_out_of_the_ui_range() {
        assert!(crate::tool::request_id().0 >= 0x8000_0000);
    }
}
