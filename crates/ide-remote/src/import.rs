//! Imports from the client filesystem into a remote project, without deployment mappings.
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_ssh::RemoteFs;
use std::path::Path;

/// Copies entries, preserving symlinks and empty folders. Reports skipped special files.
pub async fn import_local(fs: &RemoteFs, from: &Path, to: &str, cancel: &CancellationToken) -> IdeResult<Vec<String>> {
    let mut skipped = Vec::new();
    import_entry(fs, from, to, cancel, &mut skipped).await?;
    Ok(skipped)
}

async fn import_entry(
    fs: &RemoteFs,
    from: &Path,
    to: &str,
    cancel: &CancellationToken,
    skipped: &mut Vec<String>,
) -> IdeResult<()> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    if fs.stat(to).await?.is_some() {
        return Err(IdeError::new(ide_core::error::ErrorKind::AlreadyExists, format!("{to} already exists")));
    }
    let meta = tokio::fs::symlink_metadata(from).await?;
    if meta.is_symlink() {
        let result = async {
            let target = tokio::fs::read_link(from).await?;
            let target = target.to_str().ok_or_else(|| IdeError::invalid("Link target is not valid UTF-8"))?;
            fs.symlink(target, to).await
        }
        .await;
        if let Err(e) = result {
            skipped.push(format!("{}: {e}", from.display()));
        }
        return Ok(());
    }
    if !meta.is_file() && !meta.is_dir() {
        skipped.push(format!("{}: skipped special file", from.display()));
        return Ok(());
    }
    if meta.is_file() {
        return fs.upload_new(from, to, cancel).await;
    }
    fs.create_dir(to).await?;
    let result = async {
        let mut entries = tokio::fs::read_dir(from).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| IdeError::invalid("File name is not valid UTF-8"))?;
            Box::pin(import_entry(fs, &entry.path(), &ide_ssh::sftp::join(to, name), cancel, skipped)).await?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = fs.remove(to).await;
    }
    result
}
