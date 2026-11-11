use super::Channel;
use crate::Host;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_vfs::FileEntry;
use std::path::{Path, PathBuf};

pub async fn entry_kind(host: &Host, path: PathBuf) -> IdeResult<ide_vfs::EntryKind> {
    host.blocking(move || {
        let meta = std::fs::metadata(path)?;
        Ok(if meta.is_dir() { ide_vfs::EntryKind::Dir } else { ide_vfs::EntryKind::File })
    })
    .await
}

pub async fn compare_directories(
    host: &Host,
    window: &str,
    left: PathBuf,
    right: PathBuf,
    request: RequestId,
    on_progress: Channel<ide_vfs::DirectoryCompareProgress>,
) -> IdeResult<Vec<ide_vfs::DirectoryCompareEntry>> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = host
        .blocking(move || {
            let last = std::cell::Cell::new(std::time::Instant::now() - std::time::Duration::from_secs(1));
            ide_vfs::compare_directories(&left, &right, Some(&project.root), &project.exclude_globs(), &cancel, |p| {
                // Bound IPC traffic even when hashing multi-gigabyte files.
                if last.get().elapsed() >= std::time::Duration::from_millis(80) || p.total == Some(p.compared) {
                    let _ = on_progress.send(p);
                    last.set(std::time::Instant::now());
                }
            })
        })
        .await;
    host.end_request(request);
    result
}

pub async fn copy_merge(
    host: &Host,
    window: &str,
    source_root: PathBuf,
    destination_root: PathBuf,
    path: PathBuf,
    overwrite: bool,
) -> IdeResult<()> {
    if path.as_os_str().is_empty() || path.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(ide_core::IdeError::invalid("expected a relative comparison entry path"));
    }
    let project = host.project(window)?;
    host.blocking(move || {
        let from = source_root.join(&path);
        let to = destination_root.join(&path);
        if overwrite {
            project.history.record_deletion(&to, DELETE_SNAPSHOT_LIMIT);
        }
        project.with_disk_sync(|| {
            ide_vfs::copy_merge(
                &from,
                &to,
                overwrite,
                Some(&project.root),
                &project.exclude_globs(),
                (&source_root, &destination_root),
            )
        })
    })
    .await
}

/// Files of a deleted folder snapshotted in Local History.
const DELETE_SNAPSHOT_LIMIT: usize = 2000;

/// Runs on the blocking pool: on a network share (`\\wsl.localhost`) every stat is slow.
pub async fn read_dir(host: &Host, window: &str, path: PathBuf) -> IdeResult<Vec<FileEntry>> {
    let project = host.project(window);
    host.blocking(move || {
        let excludes = project
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
    })
    .await
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

pub async fn create_file_bytes(host: &Host, path: PathBuf, data: Vec<u8>) -> IdeResult<()> {
    host.blocking(move || ide_vfs::create_file_bytes(&path, &data)).await
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
        let paths = ide_workspace::file_ops::deletion_paths(&path)?;
        if let Some(h) = history {
            for p in paths {
                h.record_deletion(&p, DELETE_SNAPSHOT_LIMIT);
            }
        }
        ide_workspace::file_ops::delete(&path)
    })
    .await
}

pub async fn copy(host: &Host, from: PathBuf, to: PathBuf) -> IdeResult<()> {
    host.blocking(move || ide_workspace::file_ops::copy(&from, &to)).await
}

pub async fn rename(host: &Host, from: PathBuf, to: PathBuf) -> IdeResult<()> {
    host.blocking(move || ide_workspace::file_ops::rename(&from, &to)).await
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

/// The file `window` may hand to the OS's default application: `path` itself, resolved, when it is a
/// file inside the window's project (its folder or a content root). The window must be trusted and
/// open locally; a remote window's files live on its own machine and are not launched here.
pub fn system_open_target(host: &Host, window: &str, path: PathBuf) -> IdeResult<PathBuf> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let real =
        dunce::canonicalize(&path).map_err(|_| IdeError::not_found(format!("{}: no such file", path.display())))?;
    if !real.is_file() {
        return Err(IdeError::invalid(format!("{}: not a file", path.display())));
    }
    let roots: Vec<PathBuf> = std::iter::once(project.root.clone())
        .chain(project.content_roots())
        .filter_map(|root| dunce::canonicalize(root).ok())
        .collect();
    if !inside_any_root(&real, &roots) {
        return Err(IdeError::invalid(format!("{}: outside the project", path.display())));
    }
    Ok(real)
}

/// Whether `path` lies inside one of `roots`, comparing whole path components (`/a/bc` is not inside `/a/b`).
pub(crate) fn inside_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

#[cfg(test)]
mod tests {
    use super::inside_any_root;
    use std::path::{Path, PathBuf};

    #[test]
    fn system_open_is_limited_to_paths_inside_a_project_root() {
        let roots = vec![PathBuf::from("/work/app"), PathBuf::from("/work/shared")];
        assert!(inside_any_root(Path::new("/work/app/docs/spec.pdf"), &roots));
        assert!(inside_any_root(Path::new("/work/shared/a.docx"), &roots));
        assert!(inside_any_root(Path::new("/work/app"), &roots));
        assert!(!inside_any_root(Path::new("/work/app2/spec.pdf"), &roots));
        assert!(!inside_any_root(Path::new("/home/me/.ssh/id_rsa"), &roots));
        assert!(!inside_any_root(Path::new("/work/spec.pdf"), &[]));
    }
}
