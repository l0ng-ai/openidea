//! Ad-hoc uploads into a chosen directory, independent of deployment mappings.
use crate::deploy::TransferReport;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_ssh::{
    RemoteEntry, RemoteFs,
    sftp::{join, parent},
};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

struct Entry {
    local: PathBuf,
    relative: String,
    directory: bool,
}

fn name(path: &Path) -> IdeResult<&str> {
    path.file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !matches!(*n, "" | "." | "..") && !n.contains(['/', '\\']))
        .ok_or_else(|| IdeError::invalid(format!("Cannot upload this file name: {}", path.display())))
}

async fn collect(
    path: &Path,
    relative: String,
    entries: &mut Vec<Entry>,
    report: &mut TransferReport,
    cancel: &CancellationToken,
) -> IdeResult<()> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let meta = tokio::fs::symlink_metadata(path).await?;
    if meta.is_symlink() || (!meta.is_dir() && !meta.is_file()) {
        report.skipped += 1;
        return Ok(());
    }
    entries.push(Entry { local: path.into(), relative: relative.clone(), directory: meta.is_dir() });
    if meta.is_dir() {
        let mut children = tokio::fs::read_dir(path).await?;
        while let Some(child) = children.next_entry().await? {
            let child = child.path();
            let relative = format!("{relative}/{}", name(&child)?);
            Box::pin(collect(&child, relative, entries, report, cancel)).await?;
        }
    }
    Ok(())
}

fn temporary(parent: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    join(parent, &format!(".openidea-upload-{}-{now}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
}

fn parent_folder(path: &str) -> IdeResult<&str> {
    let folder = parent(path).ok_or_else(|| IdeError::invalid("Upload target has no parent"))?;
    // Local deployment paths use forward slashes too; `C:` would address a drive's cwd.
    Ok(if folder.len() == 2 && folder.ends_with(':') { &path[..3] } else { folder })
}

async fn replace_file(fs: &RemoteFs, local: &Path, target: &str, cancel: &CancellationToken) -> IdeResult<()> {
    let folder = parent_folder(target)?;
    let staged = temporary(folder);
    fs.upload_new(local, &staged, cancel).await?;
    let result = async {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let current = fs.list(folder).await?.into_iter().find(|entry| entry.path == target);
        if current.as_ref().is_some_and(|entry| entry.is_dir || entry.is_symlink) {
            return Err(IdeError::invalid(format!("Cannot replace a folder or symbolic link: {target}")));
        }
        // SFTP v3 rename need not replace a destination. Keep the old file recoverable until
        // the completed replacement has its final name; never truncate it while uploading.
        let backup = current.map(|_| temporary(folder));
        if let Some(backup) = &backup {
            fs.rename(target, backup).await?;
        }
        if let Err(error) = fs.rename(&staged, target).await {
            if let Some(backup) = &backup
                && (!matches!(fs.stat(target).await, Ok(None)) || fs.rename(backup, target).await.is_err())
            {
                return Err(IdeError::invalid(format!("{error}; the original file is preserved at {backup}")));
            }
            return Err(error);
        }
        if let Some(backup) = backup {
            fs.remove(&backup).await?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = fs.remove(&staged).await;
    }
    result
}

/// Copies each source under its own name. Existing folders merge only after explicit replacement
/// approval. Links and special source files are skipped; destination links are not replaced.
pub async fn upload_into(
    fs: &RemoteFs,
    paths: &[PathBuf],
    directory: &str,
    replace: bool,
    cancel: &CancellationToken,
    progress: &mut (dyn FnMut(&str, usize, usize) + Send),
) -> IdeResult<TransferReport> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    progress(directory, 0, 0);
    let directory = fs.resolve(directory).await?;
    if !fs.stat(&directory).await?.is_some_and(|entry| entry.is_dir) {
        return Err(IdeError::invalid(format!("Not an upload folder: {directory}")));
    }
    let unique: HashSet<_> = paths.iter().cloned().collect();
    let mut seen = HashSet::new();
    let roots: Vec<_> = paths
        .iter()
        .filter(|path| seen.insert(*path) && !unique.iter().any(|other| other != *path && path.starts_with(other)))
        .collect();
    let mut names = HashSet::new();
    for path in &roots {
        if !path.is_absolute() {
            return Err(IdeError::invalid("Upload sources must be absolute paths"));
        }
        if !names.insert(name(path)?) {
            return Err(IdeError::invalid("Selected upload sources have the same name"));
        }
        if matches!(fs, RemoteFs::Local) {
            let source = tokio::fs::canonicalize(path).await?;
            let destination = tokio::fs::canonicalize(&directory).await?;
            if destination.starts_with(&source)
                || tokio::fs::canonicalize(join(&directory, name(path)?)).await.is_ok_and(|p| p == source)
            {
                return Err(IdeError::invalid("Cannot upload a file or folder onto itself"));
            }
        }
    }
    let mut report = TransferReport::default();
    let mut entries = Vec::new();
    for path in roots {
        if let Err(error) = collect(path, name(path)?.into(), &mut entries, &mut report, cancel).await {
            if error.kind == ide_core::error::ErrorKind::Cancelled {
                return Err(error);
            }
            report.fail(path.display().to_string(), error);
        }
    }
    let total = entries.iter().filter(|entry| !entry.directory).count();
    let mut listed: HashMap<String, Vec<RemoteEntry>> = HashMap::new();
    let mut blocked: Vec<String> = Vec::new();
    let mut index = 0;
    for entry in entries {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if blocked.iter().any(|root| entry.relative.starts_with(&format!("{root}/"))) {
            if !entry.directory {
                report.skipped += 1;
            }
            continue;
        }
        let target = join(&directory, &entry.relative);
        let folder = parent_folder(&target)?;
        progress(&entry.relative, index, total);
        let result = async {
            if !listed.contains_key(folder) {
                listed.insert(folder.to_owned(), fs.list(folder).await?);
            }
            let existing = listed.get(folder).and_then(|entries| entries.iter().find(|e| e.path == target));
            if let Some(existing) = existing {
                if !replace {
                    return Err(IdeError::new(
                        ide_core::error::ErrorKind::AlreadyExists,
                        format!("{target} already exists"),
                    ));
                }
                if existing.is_symlink || existing.is_dir != entry.directory {
                    return Err(IdeError::invalid(format!(
                        "Cannot replace a different file type or symbolic link: {target}"
                    )));
                }
            }
            if entry.directory {
                if existing.is_none() {
                    fs.create_dir(&target).await?;
                    listed.insert(target.clone(), Vec::new());
                }
                Ok(())
            } else if replace {
                replace_file(fs, &entry.local, &target, cancel).await
            } else {
                fs.upload_new(&entry.local, &target, cancel).await
            }
        }
        .await;
        match result {
            Ok(()) => {
                if !entry.directory {
                    report.files += 1;
                }
            }
            Err(error) => {
                if error.kind == ide_core::error::ErrorKind::Cancelled {
                    return Err(error);
                }
                if entry.directory {
                    blocked.push(entry.relative.clone());
                }
                report.fail(target, error);
            }
        }
        if !entry.directory {
            index += 1;
        }
    }
    Ok(report)
}
