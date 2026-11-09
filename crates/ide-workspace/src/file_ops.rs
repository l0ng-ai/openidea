//! Project-aware file operations. Plain files retain the VFS behavior; project
//! rules may expand a resource operation before the common transaction runs.

use crate::FileMove;
use ide_core::{IdeError, IdeResult, WorkspaceEdit};
use std::path::{Path, PathBuf};

mod project;

pub fn copy(from: &Path, to: &Path) -> IdeResult<()> {
    project::copy(from, to).unwrap_or_else(|| ide_vfs::copy(from, to))
}

pub fn delete(path: &Path) -> IdeResult<()> {
    project::delete(path).unwrap_or_else(|| ide_vfs::delete(path))
}

/// Files Local History must capture before deletion.
pub fn deletion_paths(path: &Path) -> IdeResult<Vec<PathBuf>> {
    project::deletion_paths(path).unwrap_or_else(|| Ok(vec![path.to_path_buf()]))
}

pub fn rename(from: &Path, to: &Path) -> IdeResult<()> {
    if !project::has_move_rules(from, to) {
        return ide_vfs::rename(from, to);
    }
    let moves = expand_moves(&[FileMove { from: from.into(), to: to.into() }])?;
    move_files(&moves)
}

pub(crate) fn expand_moves(moves: &[FileMove]) -> IdeResult<Vec<FileMove>> {
    let expanded = project::expand_moves(moves)?;
    validate_moves(&expanded)?;
    Ok(expanded)
}

fn path_key(path: &Path) -> PathBuf {
    #[cfg(windows)]
    return path.to_string_lossy().replace('\\', "/").to_lowercase().into();
    #[cfg(not(windows))]
    path.to_path_buf()
}

fn validate_moves(moves: &[FileMove]) -> IdeResult<()> {
    let mut sources = std::collections::HashSet::new();
    let mut targets = std::collections::HashSet::new();
    for m in moves {
        ide_vfs::validate_rename(&m.from, &m.to)?;
        let from = path_key(&m.from);
        let to = path_key(&m.to);
        if to != from && to.starts_with(&from) {
            return Err(IdeError::invalid("Cannot move a directory into itself"));
        }
        if !sources.insert(from) || !targets.insert(to) {
            return Err(IdeError::invalid("Duplicate source or destination in file operation"));
        }
    }
    Ok(())
}

pub(crate) fn move_files(moves: &[FileMove]) -> IdeResult<()> {
    execute_moves(moves, &|from, to| project::rename_entry(from, to).unwrap_or_else(|| ide_vfs::rename(from, to)))
}

/// Executes an expanded batch. Rollback never overwrites a newly occupied path;
/// failures report where the caller can recover the remaining files.
pub(crate) fn execute_moves(moves: &[FileMove], rename: &dyn Fn(&Path, &Path) -> IdeResult<()>) -> IdeResult<()> {
    validate_moves(moves)?;
    for (i, m) in moves.iter().enumerate() {
        if let Err(mut error) = rename(&m.from, &m.to) {
            for done in moves[..i].iter().rev() {
                if let Err(rollback) =
                    ide_vfs::validate_rename(&done.to, &done.from).and_then(|()| rename(&done.to, &done.from))
                {
                    error.message.push_str(&format!(
                        "; rollback {} -> {} failed: {rollback}",
                        done.to.display(),
                        done.from.display()
                    ));
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

pub(crate) fn validate_workspace_edit_paths(edit: &WorkspaceEdit) -> IdeResult<()> {
    project::validate_workspace_edit_paths(edit)
}

pub(crate) fn expand_workspace_edit(edit: &mut WorkspaceEdit) -> IdeResult<()> {
    project::expand_workspace_edit(edit)
}
