//! File move / rename refactoring: reference updates from the language
//! servers, the move itself (one undoable step) and its undo.
use crate::Host;
use ide_command::command;

use ide_core::{FileEdit, IdeResult, RequestId, WorkspaceEdit};
use ide_language::Syntax;
use ide_lsp::types::FileRenameEdits;
use ide_workspace::Documents;
use ide_workspace::file_moves::{moved_path, read_text};
use ide_workspace::roots::{PYTHON_FILES, ProjectRoots, RootKind, SourceFolder};
use ide_workspace::{FileMove, UndoOutcome};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};

use super::blocking;

fn pairs(moves: &[FileMove]) -> Vec<(PathBuf, PathBuf)> {
    moves.iter().map(|m| (m.from.to_path_buf(), m.to.to_path_buf())).collect()
}

/// `workspace/willRenameFiles` on every interested server (before the move), plus the
/// Python import updates the IDE makes itself. Cancellable.
#[command(trust = always)]
pub async fn refactor_file_move_edits(
    host: &Host,
    window: &str,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<FileRenameEdits> {
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let syntax = host.syntax();
    let result = async {
        let mut result = project.lsp.will_rename_files(&pairs(&moves), token.clone()).await?;
        blocking(move || {
            // basedpyright has no `workspace/willRenameFiles`; a Python server that answered wins.
            if !result.edit.files.iter().any(|f| matches!(f, FileEdit::Edit { path, .. } if is_python(path))) {
                let python = python_import_edits(
                    &project.root,
                    &project.roots(),
                    &project.exclude_globs(),
                    &project.documents,
                    &syntax,
                    &moves,
                    &|| token.is_cancelled(),
                );
                result.edit.files.extend(python.files);
            }
            if token.is_cancelled() {
                return Err(ide_core::IdeError::cancelled());
            }
            project.documents.prepare_workspace_edit(&mut result.edit)?;
            Ok(result)
        })
        .await
    }
    .await;
    host.end_request(request);
    result
}

fn is_python(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "py" || e == "pyi")
}

/// The folders Python imports modules from: source and test roots of Python projects (or marked
/// by the user), else the project root. Other languages' roots (`frontend/src`) don't count.
fn python_root<'a>(roots: &'a ProjectRoots, rel: &str) -> &'a str {
    let python = |r: &&SourceFolder| {
        matches!(r.kind, RootKind::Source | RootKind::Test)
            && r.detected_from.as_deref().is_none_or(|f| PYTHON_FILES.iter().any(|p| f.rsplit('/').next() == Some(*p)))
    };
    let inside = |r: &&SourceFolder| r.path.is_empty() || rel == r.path || rel.starts_with(&format!("{}/", r.path));
    roots.roots.iter().filter(python).filter(inside).max_by_key(|r| r.path.len()).map_or("", |r| r.path.as_str())
}

fn rel_path(root: &Path, path: &Path) -> Option<String> {
    Some(path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"))
}

/// The dotted name of a Python module file or package folder and the root it is imported from
/// (`src/a/b.py` → `a.b` from `src` in a `src` layout).
fn python_module(root: &Path, roots: &ProjectRoots, path: &Path, is_dir: bool) -> Option<(String, String)> {
    let rel = rel_path(root, path)?;
    let base = python_root(roots, &rel);
    let inner = if base.is_empty() { rel.as_str() } else { rel.strip_prefix(base)?.trim_start_matches('/') };
    let inner = if is_dir { inner } else { inner.strip_suffix(".py").or_else(|| inner.strip_suffix(".pyi"))? };
    let inner = inner.strip_suffix("/__init__").unwrap_or(inner);
    let valid = |s: &str| {
        s.chars().next().is_some_and(|c| !c.is_ascii_digit()) && s.chars().all(|c| c == '_' || c.is_alphanumeric())
    };
    (!inner.is_empty() && inner.split('/').all(valid)).then(|| (inner.replace('/', "."), base.to_owned()))
}

/// The package relative imports in `file` start from.
fn python_package(root: &Path, roots: &ProjectRoots, file: &Path) -> String {
    let Some((module, _)) = python_module(root, roots, file, false) else { return String::new() };
    if file.file_stem().is_some_and(|s| s == "__init__") {
        module
    } else {
        module.rsplit_once('.').map_or(String::new(), |(p, _)| p.to_owned())
    }
}

/// Whether `dir` holds Python modules (a package or namespace package), at any depth.
fn has_python(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| {
        let path = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            !name.starts_with('.') && !matches!(name.as_ref(), "node_modules" | "__pycache__") && has_python(&path)
        } else {
            is_python(&path)
        }
    })
}

/// Import updates in the project's Python files for `moves` (paths before the move).
fn python_import_edits(
    root: &Path,
    roots: &ProjectRoots,
    excludes: &[String],
    documents: &Documents,
    syntax: &Syntax,
    moves: &[FileMove],
    cancelled: &(dyn Fn() -> bool + Sync),
) -> WorkspaceEdit {
    // (old, new, root the old module is imported from)
    let mut renames: Vec<(String, String, String)> = Vec::new();
    for m in moves {
        let is_dir = m.from.is_dir();
        let module = if is_dir {
            has_python(&m.from)
        } else {
            let stub_only = m.from.extension().is_some_and(|e| e == "pyi")
                && !moves.iter().any(|o| *o.from == m.from.with_extension("py"));
            // A stub may describe a compiled module that stays where it is.
            is_python(&m.from) && !stub_only && m.from.file_stem().is_some_and(|s| s != "__init__")
        };
        if !module {
            continue;
        }
        let (Some((old, base)), Some((new, _))) =
            (python_module(root, roots, &m.from, is_dir), python_module(root, roots, &m.to, is_dir))
        else {
            continue;
        };
        if old != new && !renames.iter().any(|r| r.0 == old) {
            renames.push((old, new, base));
        }
    }
    if renames.is_empty() {
        return WorkspaceEdit::default();
    }
    // `import utils` in `backend/app.py` means `backend/utils.py`, not `backend/tests/utils.py`.
    let shadowed = |base: &str, module: &str| {
        let p = root.join(base).join(module.replace('.', "/"));
        p.with_extension("py").is_file() || p.with_extension("pyi").is_file() || p.is_dir()
    };
    let names: Vec<&str> = renames.iter().map(|(old, ..)| old.rsplit('.').next().unwrap_or(old)).collect();
    let found: Mutex<Vec<(PathBuf, Vec<ide_core::TextEdit>)>> = Mutex::new(Vec::new());
    ide_vfs::walk_files(root, excludes, |path| {
        if cancelled() || !is_python(path) {
            return;
        }
        let moved = moved_path(path, moves);
        if moved == path {
            let Ok(bytes) = std::fs::read(path) else { return };
            let raw = String::from_utf8_lossy(&bytes);
            if !names.iter().any(|n| raw.contains(n)) {
                return;
            }
        }
        // Through the documents layer: unsaved edits, BOM and encodings as the edits will see them.
        let Ok(text) = read_text(documents, path) else { return };
        let Some(rel) = rel_path(root, path) else { return };
        let base = python_root(roots, &rel);
        let visible: Vec<(String, String)> = renames
            .iter()
            .filter(|(old, _, from)| from == base || !shadowed(base, old))
            .map(|(old, new, _)| (old.clone(), new.clone()))
            .collect();
        let edits = syntax.python_import_edits(
            &text,
            &python_package(root, roots, path),
            &python_package(root, roots, &moved),
            &visible,
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

    #[test]
    fn python_module_names_follow_the_roots() {
        let root = Path::new("/p");
        let folder = |path: &str, kind| SourceFolder { path: path.into(), kind, detected_from: None };
        let roots = ProjectRoots::compute(
            vec![folder("src", RootKind::Source), folder("tests", RootKind::Test)],
            &Default::default(),
        );
        let name = |p: &str, dir| python_module(root, &roots, &root.join(p), dir).map(|(m, _)| m);
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

    #[test]
    fn python_imports_in_a_mixed_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let write = |p: &str, text: &str| {
            let path = root.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write("backend/pyproject.toml", "[project]\nname = \"b\"\n");
        write("backend/utils.py", "");
        write("backend/app.py", "import utils\nfrom api import routes\n");
        write("backend/api/__init__.py", "");
        write("backend/api/routes.py", "");
        write("backend/bom.py", "\u{feff}from api import routes\n");
        write("backend/tests/utils.py", "");
        write("backend/tests/test_a.py", "import utils\n");
        write("backend/native/_ext.pyi", "");
        write("backend/uses_ext.py", "from native import _ext\n");
        write("frontend/package.json", "{}");
        write("frontend/src/api/index.js", "");
        let roots = ProjectRoots::compute(ide_workspace::roots::detect(root), &Default::default());
        let documents = Documents::new(
            std::sync::Arc::new(|_| {}),
            Box::new(|_: &Path, _: Option<&str>| ide_core::LanguageId::new("python")),
        );
        let edits = |from: &str, to: &str| {
            let moves = vec![FileMove { from: root.join(from).into(), to: root.join(to).into() }];
            let edit = python_import_edits(root, &roots, &[], &documents, &Syntax::new(), &moves, &|| false);
            edit.files
                .into_iter()
                .filter_map(|f| match f {
                    FileEdit::Edit { path, edits, .. } => Some((rel_path(root, &path).unwrap(), edits)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        // Not Python: a JavaScript folder of the same name.
        assert!(edits("frontend/src/api", "frontend/src/client").is_empty());
        // Same-named modules of different roots.
        let files = edits("backend/tests/utils.py", "backend/tests/helpers.py");
        assert_eq!(files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), ["backend/tests/test_a.py"]);
        // A BOM doesn't shift the edit.
        let files = edits("backend/api", "backend/web");
        assert_eq!(files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), ["backend/app.py", "backend/bom.py"]);
        assert_eq!(files[1].1[0].range.start, ide_core::Pos { line: 0, col: 5 });
        // A stub without its module.
        assert!(edits("backend/native/_ext.pyi", "backend/native/_ext2.pyi").is_empty());
    }
}
