//! Imports from the client filesystem into a remote project, without deployment mappings.
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_ssh::RemoteFs;
use std::path::Path;

/// Copies one entry, including empty folders. Removes partial imports on failure.
pub async fn import_local(fs: &RemoteFs, from: &Path, to: &str, cancel: &CancellationToken) -> IdeResult<()> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    if fs.stat(to).await?.is_some() {
        return Err(IdeError::new(ide_core::error::ErrorKind::AlreadyExists, format!("{to} already exists")));
    }
    let meta = tokio::fs::symlink_metadata(from).await?;
    if meta.is_symlink() || (!meta.is_file() && !meta.is_dir()) {
        return Err(IdeError::invalid(format!("Cannot import a symbolic link or special file: {}", from.display())));
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
            Box::pin(import_local(fs, &entry.path(), &ide_ssh::sftp::join(to, name), cancel)).await?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = fs.remove(to).await;
    }
    result
}
