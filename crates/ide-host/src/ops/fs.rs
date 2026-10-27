use crate::Host;
use ide_core::IdeResult;
use ide_vfs::FileEntry;
use std::path::PathBuf;

/// Files of a deleted folder snapshotted in Local History.
const DELETE_SNAPSHOT_LIMIT: usize = 2000;

pub fn read_dir(host: &Host, window: &str, path: PathBuf) -> IdeResult<Vec<FileEntry>> {
    let excludes = host
        .project(window)
        .map(|p| {
            let globs = p.exclude_globs();
            // `read_dir` matches relative to the enclosing repository: re-anchor
            // project-root patterns (`/build`) when the project is a repo subfolder.
            let repo = p.root.ancestors().find(|d| d.join(".git").exists());
            match repo.and_then(|r| p.root.strip_prefix(r).ok()).filter(|rel| !rel.as_os_str().is_empty()) {
                Some(rel) => {
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    globs.into_iter().map(|g| if g.starts_with('/') { format!("/{rel}{g}") } else { g }).collect()
                }
                None => globs,
            }
        })
        .unwrap_or_default();
    ide_vfs::read_dir(&path, &excludes)
}

/// Creates an empty file; inside a project, honours the EditorConfig
/// `charset` (writes the BOM for `utf-8-bom` / UTF-16).
pub fn create_file(host: &Host, window: &str, path: PathBuf) -> IdeResult<()> {
    match host.project(window) {
        Ok(p) => {
            let defaults = p.documents.file_defaults();
            if defaults.editorconfig {
                ide_workspace::editorconfig::create_file(p.documents.editorconfig(), &path)?;
            } else {
                ide_vfs::create_file(&path)?;
            }
            // No EditorConfig charset: File Encodings › "Create UTF-8 files with BOM".
            let empty = std::fs::metadata(&path).map(|m| m.len() == 0).unwrap_or(false);
            let bom = defaults.new_file_bytes();
            if empty && !bom.is_empty() {
                std::fs::write(&path, bom)?;
            }
            Ok(())
        }
        Err(_) => ide_vfs::create_file(&path),
    }
}

/// Toggle Read-only Attribute: sets the writable bit (and the open document's
/// state). Returns whether the file is read-only now.
pub fn set_writable(host: &Host, window: &str, path: PathBuf, writable: bool) -> IdeResult<bool> {
    match host.project(window) {
        Ok(p) => p.documents.set_writable(&path, writable),
        Err(_) => ide_vfs::set_writable(&path, writable).map(|()| !writable),
    }
}

/// Moves to the trash; Local History keeps the contents so deleted files can be restored.
pub async fn delete(host: &Host, window: &str, path: PathBuf) -> IdeResult<()> {
    let history = host.project(window).ok().map(|p| p.history.clone());
    host.blocking(move || {
        if let Some(h) = history {
            h.record_deletion(&path, DELETE_SNAPSHOT_LIMIT);
        }
        ide_vfs::delete(&path)
    })
    .await
}

pub async fn copy(host: &Host, from: PathBuf, to: PathBuf) -> IdeResult<()> {
    host.blocking(move || ide_vfs::copy(&from, &to)).await
}

/// Reads a text file without opening it as a document; prefers the unsaved buffer.
pub async fn read_text(host: &Host, window: &str, path: PathBuf) -> IdeResult<String> {
    let project = host.project(window).ok();
    host.blocking(move || match project {
        Some(p) => p.text_of(&path),
        None => Ok(ide_vfs::load_text(&path)?.text),
    })
    .await
}
