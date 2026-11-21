use super::Channel;
use crate::Host;
use ide_command::command;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_vfs::FileEntry;
use ide_workspace::DeletionUndo;
use std::path::{Path, PathBuf};

#[command(trust = always)]
pub async fn fs_entry_kind(host: &Host, path: PathBuf) -> IdeResult<ide_vfs::EntryKind> {
    host.blocking(move || {
        let meta = std::fs::metadata(path)?;
        Ok(if meta.is_dir() { ide_vfs::EntryKind::Dir } else { ide_vfs::EntryKind::File })
    })
    .await
}

#[command(trust = always)]
pub async fn fs_compare_directories(
    host: &Host,
    window: &str,
    left: PathBuf,
    right: PathBuf,
    mode: ide_vfs::DirectoryCompareMode,
    request: RequestId,
    on_progress: Channel<ide_vfs::DirectoryCompareProgress>,
) -> IdeResult<Vec<ide_vfs::DirectoryCompareEntry>> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = host
        .blocking(move || {
            let last = std::cell::Cell::new(std::time::Instant::now() - std::time::Duration::from_secs(1));
            ide_vfs::compare_directories(
                &left,
                &right,
                mode,
                Some(&project.root),
                &project.exclude_globs(),
                &cancel,
                |p| {
                    // Bound IPC traffic even when hashing multi-gigabyte files.
                    if last.get().elapsed() >= std::time::Duration::from_millis(80) || p.total == Some(p.compared) {
                        let _ = on_progress.send(p);
                        last.set(std::time::Instant::now());
                    }
                },
            )
        })
        .await;
    host.end_request(request);
    result
}

#[command(trust = always)]
pub async fn fs_copy_merge(
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

#[command(trust = always)]
pub async fn fs_read_dir(host: &Host, window: &str, path: PathBuf) -> IdeResult<Vec<FileEntry>> {
    // Runs on the blocking pool: on a network share (`\\wsl.localhost`) every stat is slow.
    let project = host.project(window);
    host.blocking(move || {
        let excludes = project
            .map(|p| {
                // An attached project's folders follow its own exclusions.
                let root = p.root_of(&path);
                let globs = p.exclude_globs_in(&root);
                // `read_dir` matches relative to the enclosing repository: re-anchor
                // root patterns (`/build`) when the project is a repo subfolder.
                let repo = root.ancestors().find(|d| d.join(".git").exists());
                match repo.and_then(|r| root.strip_prefix(r).ok()).filter(|rel| !rel.as_os_str().is_empty()) {
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
#[command(trust = always)]
pub fn fs_create_file(host: &Host, window: &str, path: PathBuf) -> IdeResult<()> {
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
            // A checkout backend opens the file for add; Git's hook is a no-op.
            if let Err(e) = p.with_backend_of(&path, |r| r.files_added(std::slice::from_ref(&path))) {
                tracing::debug!("vcs files_added for {}: {e}", path.display());
            }
            Ok(())
        }
        Err(_) => ide_vfs::create_file(&path),
    }
}

#[command(trust = always)]
pub async fn fs_create_file_bytes(host: &Host, window: &str, path: PathBuf, data: Vec<u8>) -> IdeResult<()> {
    let project = host.project(window).ok();
    host.blocking(move || {
        ide_vfs::create_file_bytes(&path, &data)?;
        if let Some(p) = project
            && let Err(e) = p.with_backend_of(&path, |r| r.files_added(std::slice::from_ref(&path)))
        {
            tracing::debug!("vcs files_added for {}: {e}", path.display());
        }
        Ok(())
    })
    .await
}

#[command(trust = always)]
pub fn fs_create_dir(path: PathBuf) -> IdeResult<()> {
    ide_vfs::create_dir(&path)
}

/// Toggle Read-only Attribute: sets the writable bit (and the open document's
/// state). Returns whether the file is read-only now.
#[command(trust = always)]
pub fn fs_set_writable(host: &Host, window: &str, path: PathBuf, writable: bool) -> IdeResult<bool> {
    match host.project(window) {
        Ok(p) => p.documents.set_writable(&path, writable),
        Err(_) => ide_vfs::set_writable(&path, writable).map(|()| !writable),
    }
}

/// Moving to the trash can take a while (large trees): kept off the main thread.
#[command(trust = always)]
pub async fn fs_delete(host: &Host, window: &str, path: PathBuf) -> IdeResult<()> {
    delete_with_history(host, window, path, false).await.map(|_| ())
}

/// Moves an item to the Trash and returns the snapshot for Project View Undo.
#[command(trust = always)]
pub async fn fs_delete_with_undo(host: &Host, window: &str, path: PathBuf) -> IdeResult<DeletionUndo> {
    delete_with_history(host, window, path, true).await
}

async fn delete_with_history(host: &Host, window: &str, path: PathBuf, undoable: bool) -> IdeResult<DeletionUndo> {
    let project = if undoable { Some(host.project(window)?) } else { host.project(window).ok() };
    host.blocking(move || {
        let paths = ide_workspace::file_ops::deletion_paths(&path)?;
        let mut undo = DeletionUndo::default();
        if let Some(p) = &project {
            if undoable {
                undo = p.history.capture_deletion_undo(&paths, DELETE_SNAPSHOT_LIMIT);
            } else {
                for pth in &paths {
                    p.history.record_deletion(pth, DELETE_SNAPSHOT_LIMIT);
                }
            }
        }
        ide_workspace::file_ops::delete(&path)?;
        // A checkout backend opens the paths for delete; Git's hook is a no-op.
        if let Some(p) = project {
            let _ = p.with_backend_of(&path, |r| r.files_deleted(&paths));
        }
        Ok(undo)
    })
    .await
}

#[command(trust = always)]
pub async fn fs_undo_delete(host: &Host, window: &str, undo: DeletionUndo) -> IdeResult<Vec<ide_core::IpcPath>> {
    let project = host.project(window)?;
    host.blocking(move || Ok(project.history.restore_deletion_undo(undo))).await
}

#[command(trust = always)]
pub async fn fs_copy(host: &Host, window: &str, from: PathBuf, to: PathBuf) -> IdeResult<()> {
    let project = host.project(window).ok();
    host.blocking(move || {
        ide_workspace::file_ops::copy(&from, &to)?;
        // A copy is an add at the destination; Git's hook is a no-op.
        if let Some(p) = project
            && let Err(e) = p.with_backend_of(&to, |r| r.files_added(std::slice::from_ref(&to)))
        {
            tracing::debug!("vcs files_added for {}: {e}", to.display());
        }
        Ok(())
    })
    .await
}

#[command(trust = always)]
pub async fn fs_rename(host: &Host, window: &str, from: PathBuf, to: PathBuf) -> IdeResult<()> {
    let project = host.project(window).ok();
    host.blocking(move || {
        ide_workspace::file_ops::rename(&from, &to)?;
        // A checkout backend records the rename so history follows the file;
        // Git's hook is a no-op.
        if let Some(p) = project
            && let Err(e) = p.with_backend_of(&to, |r| r.file_moved(&from, &to))
        {
            tracing::debug!("vcs file_moved {} → {}: {e}", from.display(), to.display());
        }
        Ok(())
    })
    .await
}

/// Reads a text file without opening it as a document (previews, quick
/// definition). Prefers the unsaved buffer when the file is open.
#[command(trust = always)]
pub async fn fs_read_text(host: &Host, window: &str, path: PathBuf) -> IdeResult<String> {
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

ide_command::domain!(
    fs:
    fs_compare_directories,
    fs_copy,
    fs_copy_merge,
    fs_create_dir,
    fs_create_file,
    fs_create_file_bytes,
    fs_delete,
    fs_delete_with_undo,
    fs_entry_kind,
    fs_read_dir,
    fs_read_text,
    fs_rename,
    fs_set_writable,
    fs_undo_delete,
);
