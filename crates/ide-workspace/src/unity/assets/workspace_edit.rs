//! Include sidecars in the document transaction's preflight, recovery and undo.
use super::{exists, key, meta_path, no_links, project_root, validate_asset};
use ide_core::{FileEdit, IdeError, IdeResult, WorkspaceEdit};
use std::path::Path;

// Resolve against the state produced by earlier operations without touching disk.
// This also handles renaming a folder before renaming/deleting a child asset.
fn present(path: &Path, preceding: &[FileEdit]) -> bool {
    let mut path = path.to_path_buf();
    for op in preceding.iter().rev() {
        match op {
            FileEdit::Rename { from, to } => {
                if let Ok(relative) = path.strip_prefix(to) {
                    // Joining an empty suffix adds a separator to a file path;
                    // that makes an existing sidecar look like a missing directory.
                    path = if relative.as_os_str().is_empty() { from.to_path_buf() } else { from.join(relative) };
                } else if path.starts_with(from) {
                    return false;
                }
            }
            FileEdit::Delete { path: deleted, .. } if path.starts_with(deleted) => return false,
            FileEdit::Create { path: created, .. } if path == created.to_path_buf() => return true,
            _ => {}
        }
    }
    exists(&path)
}

pub(crate) fn expand_workspace_edit(edit: &mut WorkspaceEdit) -> IdeResult<()> {
    let mut files = Vec::new();
    for file in &edit.files {
        match file {
            FileEdit::Rename { from, to } if project_root(from).is_some() || project_root(to).is_some() => {
                validate_asset(from)?;
                validate_asset(to)?;
                let source = meta_path(from);
                let destination = meta_path(to);
                no_links(&source)?;
                no_links(&destination)?;
                if present(&destination, &files) && key(&source) != key(&destination) {
                    return Err(IdeError::invalid(format!("{} already exists", destination.display())));
                }
                if present(&source, &files) {
                    files.push(FileEdit::Rename { from: source.into(), to: destination.into() });
                }
            }
            FileEdit::Delete { path, .. } if project_root(path).is_some() => {
                validate_asset(path)?;
                let meta = meta_path(path);
                no_links(&meta)?;
                if present(&meta, &files) {
                    files.push(FileEdit::Delete { path: meta.into(), recursive: false });
                }
            }
            _ => {}
        }
        files.push(file.clone());
    }
    edit.files = files;
    Ok(())
}
