//! Include sidecars in the document transaction's preflight, recovery and undo.
use super::{exists, fs, is_link, key, meta_path, no_links, project_root, validate_asset};
use ide_core::{FileEdit, IdeError, IdeResult, WorkspaceEdit};
use std::path::Path;

pub(crate) fn validate_workspace_edit_paths(edit: &WorkspaceEdit) -> IdeResult<()> {
    for file in &edit.files {
        let validate = |path: &Path| -> IdeResult<()> {
            validate_asset(path)?;
            no_links(&meta_path(path))?;
            no_nested_links(path)
        };
        match file {
            FileEdit::Rename { from, to } if project_root(from).is_some() || project_root(to).is_some() => {
                validate(from)?;
                validate(to)?;
            }
            FileEdit::Delete { path, .. } if project_root(path).is_some() => validate(path)?,
            _ => {}
        }
    }
    Ok(())
}

// Transactions snapshot directories recursively. Reject linked descendants
// before backup, including junctions and children renamed by a later operation.
fn no_nested_links(path: &Path) -> IdeResult<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if is_link(&metadata) {
        return Err(IdeError::invalid(format!("Unity asset operations do not follow links: {}", path.display())));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            no_nested_links(&entry?.path())?;
        }
    }
    Ok(())
}

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
