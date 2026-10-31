//! Move / rename of files and folders as one undoable refactoring: the
//! reference updates (a [`WorkspaceEdit`] from the language servers), then the
//! file system operation. Undo moves the files back and reverts the edits.

use crate::documents::Documents;
use crate::history::LocalHistory;
use ide_core::{FileEdit, IdeError, IdeResult, WorkspaceEdit};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// One file or folder move.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileMove {
    pub from: ide_core::IpcPath,
    pub to: ide_core::IpcPath,
}

/// What [`FileMoves::undo`] did.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    /// Moves reverted (each `from` is the original location again).
    pub moves: Vec<FileMove>,
    /// Edited files changed since the refactoring, so their edits were kept.
    pub conflicts: Vec<ide_core::IpcPath>,
}

struct EditedFile {
    /// Where the file is after the refactoring.
    path: PathBuf,
    before: String,
    after: String,
}

struct MoveRecord {
    id: u32,
    moves: Vec<FileMove>,
    edited: Vec<EditedFile>,
}

/// Undo stack of file refactorings for one project.
#[derive(Default)]
pub struct FileMoves {
    records: Mutex<Vec<MoveRecord>>,
    next: Mutex<u32>,
}

/// Undo records kept per project.
const MAX_RECORDS: usize = 20;

/// `path` after `moves` (a file inside a moved folder moves with it).
pub fn moved_path(path: &Path, moves: &[FileMove]) -> PathBuf {
    let mut out = path.to_path_buf();
    for m in moves {
        if let Ok(rest) = out.strip_prefix(&m.from) {
            out = if rest.as_os_str().is_empty() { m.to.to_path_buf() } else { m.to.join(rest) };
        }
    }
    out
}

/// Text as the document layer sees it (normalized line endings, unsaved edits).
fn read_text(documents: &Documents, path: &Path) -> IdeResult<String> {
    if let Some(text) = documents.text_of(path) {
        return Ok(text);
    }
    let info = documents.open(path)?;
    let text = documents.text_snapshot(info.id).map(|s| s.text);
    documents.close(info.id);
    text
}

/// Replaces the whole text through the document layer (open editors update) and saves.
fn write_text(documents: &Documents, path: &Path, text: &str) -> IdeResult<()> {
    let (doc, transient) = match documents.by_path(path) {
        Some(doc) => (doc, false),
        None => (documents.open(path)?.id, true),
    };
    let result = documents.replace_all(doc, text).and_then(|_| documents.save(doc));
    if transient {
        documents.close(doc);
    }
    result
}

fn edited_paths(edit: &WorkspaceEdit) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for f in &edit.files {
        if let FileEdit::Edit { path, edits, .. } = f
            && !edits.is_empty()
            && !out.iter().any(|p| p == path)
        {
            out.push(path.to_path_buf());
        }
    }
    out
}

impl FileMoves {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies `edit` (paths as before the move, as `workspace/willRenameFiles`
    /// returns them), then performs `moves`. Edited files are snapshotted in
    /// Local History first. On failure everything done so far is rolled back.
    /// Returns the id for [`undo`](Self::undo).
    pub fn perform(
        &self,
        documents: &Documents,
        history: Option<&LocalHistory>,
        moves: &[FileMove],
        edit: &WorkspaceEdit,
        label: &str,
        apply_edit: &dyn Fn(&WorkspaceEdit) -> IdeResult<()>,
    ) -> IdeResult<u32> {
        if moves.is_empty() {
            return Err(IdeError::invalid("nothing to move"));
        }
        for m in moves {
            if !m.from.exists() {
                return Err(IdeError::not_found(format!("{} does not exist", m.from.display())));
            }
            if m.to.starts_with(&m.from) && m.to != m.from {
                return Err(IdeError::invalid(format!("cannot move {} into itself", m.from.display())));
            }
        }
        let paths = edited_paths(edit);
        let mut before = Vec::with_capacity(paths.len());
        for p in &paths {
            let text = read_text(documents, p)?;
            if let Some(h) = history
                && let Err(e) = h.record_event(p, &text, &format!("Before refactoring: {label}"))
            {
                tracing::warn!("local history: {e}");
            }
            before.push(text);
        }
        if !paths.is_empty()
            && let Err(e) = apply_edit(edit)
        {
            restore(documents, &paths, &before);
            return Err(e);
        }
        let mut done: Vec<&FileMove> = Vec::new();
        for m in moves {
            if let Err(e) = ide_vfs::rename(&m.from, &m.to) {
                for d in done.iter().rev() {
                    let _ = ide_vfs::rename(&d.to, &d.from);
                }
                restore(documents, &paths, &before);
                return Err(e);
            }
            done.push(m);
        }
        let mut edited = Vec::with_capacity(paths.len());
        for (p, before) in paths.iter().zip(before) {
            let path = moved_path(p, moves);
            let after = read_text(documents, &path).unwrap_or_default();
            edited.push(EditedFile { path, before, after });
        }
        let id = {
            let mut next = self.next.lock();
            *next += 1;
            *next
        };
        let mut records = self.records.lock();
        records.push(MoveRecord { id, moves: moves.to_vec(), edited });
        if records.len() > MAX_RECORDS {
            records.remove(0);
        }
        Ok(id)
    }

    /// Whether `id` can still be undone.
    pub fn can_undo(&self, id: u32) -> bool {
        self.records.lock().iter().any(|r| r.id == id)
    }

    /// Id of the latest undoable refactoring.
    pub fn last(&self) -> Option<u32> {
        self.records.lock().last().map(|r| r.id)
    }

    /// Moves the files back and restores the edited files' text. Files changed
    /// since the refactoring keep their content and are reported as conflicts.
    pub fn undo(&self, documents: &Documents, id: u32) -> IdeResult<UndoOutcome> {
        let record = {
            let mut records = self.records.lock();
            let i = records
                .iter()
                .position(|r| r.id == id)
                .ok_or_else(|| IdeError::not_found("the refactoring can no longer be undone"))?;
            records.remove(i)
        };
        for m in &record.moves {
            if !m.to.exists() {
                return Err(IdeError::not_found(format!("{} no longer exists", m.to.display())));
            }
            if m.from.exists() {
                return Err(IdeError::new(
                    ide_core::error::ErrorKind::AlreadyExists,
                    format!("{} exists again", m.from.display()),
                ));
            }
        }
        let mut outcome = UndoOutcome::default();
        for m in record.moves.iter().rev() {
            ide_vfs::rename(&m.to, &m.from)?;
            outcome.moves.push(FileMove { from: m.to.clone(), to: m.from.clone() });
        }
        let back: Vec<FileMove> = outcome.moves.clone();
        for f in &record.edited {
            let path = moved_path(&f.path, &back);
            match read_text(documents, &path) {
                Ok(now) if now == f.after => write_text(documents, &path, &f.before)?,
                Ok(now) if now == f.before => {}
                _ => outcome.conflicts.push(path.into()),
            }
        }
        Ok(outcome)
    }
}

fn restore(documents: &Documents, paths: &[PathBuf], before: &[String]) {
    for (p, text) in paths.iter().zip(before) {
        if let Err(e) = write_text(documents, p, text) {
            tracing::warn!("rollback {}: {e}", p.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{LanguageId, Pos, Range, TextEdit};
    use std::fs;
    use std::sync::Arc;

    fn documents() -> Documents {
        Documents::new(Arc::new(|_| {}), Box::new(|_: &Path, _: Option<&str>| LanguageId::new("plaintext")))
    }

    fn apply(documents: &Documents) -> impl Fn(&WorkspaceEdit) -> IdeResult<()> + '_ {
        move |edit| documents.apply_file_move_edits(edit)
    }

    #[test]
    fn move_with_edits_and_undo() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/util.ts"), "export const x = 1;\n").unwrap();
        fs::write(root.join("main.ts"), "import { x } from './a/util';\n").unwrap();
        let docs = documents();
        let history = LocalHistory::open(&root.join(".history"), root).unwrap();
        let moves = FileMoves::new();
        let mv = vec![FileMove { from: root.join("a").into(), to: root.join("b").into() }];
        let edit = WorkspaceEdit {
            files: vec![FileEdit::Edit {
                path: root.join("main.ts").into(),
                version: None,
                edits: vec![TextEdit { range: Range::new(Pos::new(0, 21), Pos::new(0, 22)), new_text: "b".into() }],
            }],
            ..Default::default()
        };
        let id = moves.perform(&docs, Some(&history), &mv, &edit, "Move", &apply(&docs)).unwrap();
        assert!(root.join("b/util.ts").exists() && !root.join("a").exists());
        assert_eq!(fs::read_to_string(root.join("main.ts")).unwrap(), "import { x } from './b/util';\n");
        let snaps = history.list(&root.join("main.ts")).unwrap();
        assert_eq!(snaps[0].label, "Before refactoring: Move");
        assert_eq!(moves.last(), Some(id));

        let undone = moves.undo(&docs, id).unwrap();
        assert!(undone.conflicts.is_empty());
        assert_eq!(undone.moves, vec![FileMove { from: root.join("b").into(), to: root.join("a").into() }]);
        assert!(root.join("a/util.ts").exists() && !root.join("b").exists());
        assert_eq!(fs::read_to_string(root.join("main.ts")).unwrap(), "import { x } from './a/util';\n");
        assert!(!moves.can_undo(id));
        assert!(moves.undo(&docs, id).is_err());
    }

    #[test]
    fn undo_keeps_files_changed_since_and_failed_moves_roll_back() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("Foo.java"), "class Foo {}\n").unwrap();
        fs::write(root.join("Use.java"), "Foo f;\n").unwrap();
        let docs = documents();
        let moves = FileMoves::new();
        let edit = WorkspaceEdit {
            files: vec![
                FileEdit::Edit {
                    path: root.join("Foo.java").into(),
                    version: None,
                    edits: vec![TextEdit { range: Range::new(Pos::new(0, 6), Pos::new(0, 9)), new_text: "Bar".into() }],
                },
                FileEdit::Edit {
                    path: root.join("Use.java").into(),
                    version: None,
                    edits: vec![TextEdit { range: Range::new(Pos::new(0, 0), Pos::new(0, 3)), new_text: "Bar".into() }],
                },
            ],
            ..Default::default()
        };
        let mv = vec![FileMove { from: root.join("Foo.java").into(), to: root.join("Bar.java").into() }];
        let id = moves.perform(&docs, None, &mv, &edit, "Rename", &apply(&docs)).unwrap();
        assert_eq!(fs::read_to_string(root.join("Bar.java")).unwrap(), "class Bar {}\n");
        fs::write(root.join("Use.java"), "Bar f; // edited\n").unwrap();
        let undone = moves.undo(&docs, id).unwrap();
        assert_eq!(fs::read_to_string(root.join("Foo.java")).unwrap(), "class Foo {}\n");
        assert_eq!(undone.conflicts, vec![root.join("Use.java")]);
        assert_eq!(fs::read_to_string(root.join("Use.java")).unwrap(), "Bar f; // edited\n");

        // The target exists: the edit is rolled back and nothing moves.
        fs::write(root.join("Bar.java"), "taken").unwrap();
        let err = moves.perform(&docs, None, &mv, &edit, "Rename", &apply(&docs)).unwrap_err();
        assert_eq!(err.kind, ide_core::error::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(root.join("Foo.java")).unwrap(), "class Foo {}\n");
        assert_eq!(fs::read_to_string(root.join("Use.java")).unwrap(), "Bar f; // edited\n");
    }

    #[test]
    fn moved_paths() {
        let mv = vec![FileMove { from: "/p/a".into(), to: "/p/b/a".into() }];
        assert_eq!(moved_path(Path::new("/p/a"), &mv), PathBuf::from("/p/b/a"));
        assert_eq!(moved_path(Path::new("/p/a/x.rs"), &mv), PathBuf::from("/p/b/a/x.rs"));
        assert_eq!(moved_path(Path::new("/p/ab"), &mv), PathBuf::from("/p/ab"));
    }
}
