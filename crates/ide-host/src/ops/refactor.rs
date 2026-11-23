//! File move / rename refactoring: reference updates from the language
//! servers, the move itself (one undoable step) and its undo.
use crate::Host;
use ide_command::command;

use ide_core::{FileEdit, IdeResult, RequestId, WorkspaceEdit};
use ide_language::Syntax;
use ide_lsp::types::FileRenameEdits;
use ide_workspace::file_moves::moved_path;
use ide_workspace::roots::{ProjectRoots, RootKind};
use ide_workspace::{FileMove, UndoOutcome};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};

use super::doc::blocking;

fn pairs(moves: &[FileMove]) -> Vec<(PathBuf, PathBuf)> {
    moves.iter().map(|m| (m.from.to_path_buf(), m.to.to_path_buf())).collect()
}

/// `workspace/willRenameFiles` on every interested server (before the move). Cancellable.
#[command(trust = always)]
pub async fn refactor_file_move_edits(
    host: &Host,
    window: &str,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<FileRenameEdits> {
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let result = project.lsp.will_rename_files(&pairs(&moves), token.clone()).await;
    host.end_request(request);
    let mut result = result?;
    let syntax = host.syntax();
    blocking(move || {
        // basedpyright has no `workspace/willRenameFiles`; a Python server that answered wins.
        if !result.edit.files.iter().any(|f| matches!(f, FileEdit::Edit { path, .. } if is_python(path))) {
            let python = python_import_edits(&project, &syntax, &moves, &|| token.is_cancelled());
            result.edit.files.extend(python.files);
        }
        project.documents.prepare_workspace_edit(&mut result.edit)?;
        Ok(result)
    })
    .await
}

fn is_python(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "py" || e == "pyi")
}

/// The dotted name of a Python module file or package folder, from its project's Python roots
/// (`src/a/b.py` → `a.b` in a `src` layout).
fn python_module(root: &Path, roots: &ProjectRoots, path: &Path, is_dir: bool) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    let base = roots
        .root_for(&rel)
        .filter(|r| matches!(r.kind, RootKind::Source | RootKind::Test))
        .map_or("", |r| r.path.as_str());
    let inner = if base.is_empty() { rel.as_str() } else { rel.strip_prefix(base)?.trim_start_matches('/') };
    let inner = if is_dir { inner } else { inner.strip_suffix(".py").or_else(|| inner.strip_suffix(".pyi"))? };
    let inner = inner.strip_suffix("/__init__").unwrap_or(inner);
    let valid = |s: &str| {
        s.chars().next().is_some_and(|c| !c.is_ascii_digit()) && s.chars().all(|c| c == '_' || c.is_alphanumeric())
    };
    (!inner.is_empty() && inner.split('/').all(valid)).then(|| inner.replace('/', "."))
}

/// The package relative imports in `file` start from.
fn python_package(root: &Path, roots: &ProjectRoots, file: &Path) -> String {
    let Some(module) = python_module(root, roots, file, false) else { return String::new() };
    if file.file_stem().is_some_and(|s| s == "__init__") {
        module
    } else {
        module.rsplit_once('.').map_or(String::new(), |(p, _)| p.to_owned())
    }
}

/// Import updates in the project's Python files for `moves` (paths before the move).
fn python_import_edits(
    project: &crate::project::Project,
    syntax: &Syntax,
    moves: &[FileMove],
    cancelled: &(dyn Fn() -> bool + Sync),
) -> WorkspaceEdit {
    let root = &project.root;
    let roots = project.roots();
    let renames: Vec<(String, String)> = moves
        .iter()
        .filter_map(|m| {
            let is_dir = m.from.is_dir();
            if !is_dir && (!is_python(&m.from) || m.from.file_stem().is_some_and(|s| s == "__init__")) {
                return None;
            }
            let old = python_module(root, &roots, &m.from, is_dir)?;
            let new = python_module(root, &roots, &m.to, is_dir)?;
            (old != new).then_some((old, new))
        })
        .collect();
    if renames.is_empty() {
        return WorkspaceEdit::default();
    }
    let names: Vec<&str> = renames.iter().map(|(old, _)| old.rsplit('.').next().unwrap_or(old)).collect();
    let found: Mutex<Vec<(PathBuf, Vec<ide_core::TextEdit>)>> = Mutex::new(Vec::new());
    ide_vfs::walk_files(root, &project.exclude_globs(), |path| {
        if cancelled() || !is_python(path) {
            return;
        }
        let moved = moved_path(path, moves);
        let text = match project.documents.text_of(path) {
            Some(t) => t,
            None => match std::fs::read_to_string(path) {
                Ok(t) => t,
                Err(_) => return,
            },
        };
        if moved == path && !names.iter().any(|n| text.contains(n)) {
            return;
        }
        let edits = syntax.python_import_edits(
            &text,
            &python_package(root, &roots, path),
            &python_package(root, &roots, &moved),
            &renames,
        );
        if !edits.is_empty() {
            found.lock().push((path.to_path_buf(), edits));
        }
    });
    let mut files = found.into_inner();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let files = files.into_iter().map(|(path, edits)| FileEdit::Edit { path: path.into(), edits, version: None });
    WorkspaceEdit { files: files.collect(), ..Default::default() }
}

/// Applies `edit` (from [`refactor_file_move_edits`], possibly empty), moves the
/// files and notifies the servers. Returns the id for [`refactor_undo_file_move`].
#[command(trust = always)]
pub async fn refactor_move_files(
    host: &Host,
    window: &str,
    moves: Vec<FileMove>,
    edit: WorkspaceEdit,
    label: String,
) -> IdeResult<u32> {
    let project = host.project(window)?;
    let p = project.clone();
    let moved = moves.clone();
    let id = blocking(move || {
        let apply = |e: &WorkspaceEdit| p.documents.apply_file_move_edits(e);
        p.moves.perform(&p.documents, Some(&p.history), &moved, &edit, &label, &apply)
    })
    .await?;
    project.lsp.did_rename_files(&pairs(&moves));
    Ok(id)
}

/// Undoes a file move: moves back and reverts the reference updates.
#[command(trust = always)]
pub async fn refactor_undo_file_move(host: &Host, window: &str, id: u32) -> IdeResult<UndoOutcome> {
    let project = host.project(window)?;
    let p = project.clone();
    let outcome = blocking(move || p.moves.undo(&p.documents, id)).await?;
    project.lsp.did_rename_files(&pairs(&outcome.moves));
    Ok(outcome)
}

/// Whether the file move `id` can still be undone.
#[command(trust = always)]
pub fn refactor_can_undo_file_move(host: &Host, window: &str, id: u32) -> IdeResult<bool> {
    Ok(host.project(window)?.moves.can_undo(id))
}

/// "Search in comments and strings": textual occurrences of the moved files'
/// names, qualified names and paths (before the move). Cancellable.
#[command(trust = always)]
pub async fn refactor_file_move_text_edits(
    host: &Host,
    window: &str,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<WorkspaceEdit> {
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let cancel = token.clone();
    let result = blocking(move || {
        let replacements = ide_workspace::text_refs::move_replacements(&project.root, &project.roots(), &moves);
        let mut edit = ide_workspace::text_refs::find_text_occurrences(
            &project.root,
            &project.exclude_globs(),
            &replacements,
            &|| cancel.is_cancelled(),
        );
        if cancel.is_cancelled() {
            return Err(ide_core::IdeError::cancelled());
        }
        project.documents.prepare_workspace_edit(&mut edit)?;
        Ok(edit)
    })
    .await;
    host.end_request(request);
    result
}

ide_command::domain!(
    refactor:
    refactor_can_undo_file_move,
    refactor_file_move_edits,
    refactor_file_move_text_edits,
    refactor_move_files,
    refactor_undo_file_move,
);

#[cfg(test)]
mod tests {
    use super::*;
    use ide_workspace::roots::SourceFolder;

    #[test]
    fn python_module_names_follow_the_roots() {
        let root = Path::new("/p");
        let folder = |path: &str, kind| SourceFolder { path: path.into(), kind, detected_from: None };
        let roots = ProjectRoots::compute(
            vec![folder("src", RootKind::Source), folder("tests", RootKind::Test)],
            &Default::default(),
        );
        let name = |p: &str, dir| python_module(root, &roots, &root.join(p), dir);
        assert_eq!(name("src/tasks/models.py", false).as_deref(), Some("tasks.models"));
        assert_eq!(name("src/tasks/__init__.py", false).as_deref(), Some("tasks"));
        assert_eq!(name("src/tasks", true).as_deref(), Some("tasks"));
        assert_eq!(name("tests/test_models.py", false).as_deref(), Some("test_models"));
        assert_eq!(name("scripts/run.pyi", false).as_deref(), Some("scripts.run"));
        assert_eq!(name("my-scripts/run.py", false), None);
        assert_eq!(name("src/tasks/notes.txt", false), None);
        assert_eq!(python_package(root, &roots, &root.join("src/tasks/cli.py")), "tasks");
        assert_eq!(python_package(root, &roots, &root.join("src/tasks/__init__.py")), "tasks");
    }
}
