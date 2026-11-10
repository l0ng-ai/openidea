//! The integration boundary for project-specific resource rules. These rules
//! never replace the plain VFS path unless an operation touches project assets.

use crate::{FileMove, unity::assets};
use ide_core::{FileEdit, IdeResult, WorkspaceEdit};
use std::path::{Path, PathBuf};

pub(super) fn has_move_rules(from: &Path, to: &Path) -> bool {
    assets::project_root(from).is_some() || assets::project_root(to).is_some()
}

pub(super) fn copy(from: &Path, to: &Path) -> Option<IdeResult<()>> {
    has_move_rules(from, to).then(|| assets::copy(from, to))
}

pub(super) fn delete(path: &Path) -> Option<IdeResult<()>> {
    assets::project_root(path).map(|_| assets::delete(path))
}

pub(super) fn deletion_paths(path: &Path) -> Option<IdeResult<Vec<PathBuf>>> {
    assets::project_root(path).map(|_| assets::deletion_paths(path))
}

pub(super) fn rename_entry(from: &Path, to: &Path) -> Option<IdeResult<()>> {
    has_move_rules(from, to).then(|| assets::move_one(from, to))
}

pub(super) fn expand_moves(moves: &[FileMove]) -> IdeResult<Vec<FileMove>> {
    if moves.iter().any(|m| has_move_rules(&m.from, &m.to)) { assets::expand_moves(moves) } else { Ok(moves.to_vec()) }
}

fn has_edit_rules(edit: &WorkspaceEdit) -> bool {
    edit.files.iter().any(|file| match file {
        FileEdit::Rename { from, to } => has_move_rules(from, to),
        FileEdit::Delete { path, .. } => assets::project_root(path).is_some(),
        _ => false,
    })
}

pub(super) fn validate_workspace_edit_paths(edit: &WorkspaceEdit) -> IdeResult<()> {
    if has_edit_rules(edit) {
        assets::validate_workspace_edit_paths(edit)?;
    }
    Ok(())
}

pub(super) fn expand_workspace_edit(edit: &mut WorkspaceEdit) -> IdeResult<()> {
    if has_edit_rules(edit) {
        assets::expand_workspace_edit(edit)?;
    }
    Ok(())
}
