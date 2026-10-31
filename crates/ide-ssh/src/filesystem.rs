//! Filesystem operations shared by deployment and remote development bootstrap.
use crate::sftp::{RemoteEntry, SftpFs};
use ide_core::{IdeError, IdeResult};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FsConnection {
    Sftp { ssh: String },
    Local,
}

pub enum RemoteFs {
    Sftp(SftpFs),
    Local,
}

impl RemoteFs {
    /// Keeps SSH bootstrap callers explicitly on SFTP.
    pub fn new(sftp: SftpSession) -> Self {
        Self::Sftp(SftpFs::new(sftp))
    }

    pub async fn home(&self) -> IdeResult<String> {
        match self {
            Self::Sftp(fs) => fs.home().await,
            Self::Local => {
                dirs::home_dir().map(|p| path_string(&p)).ok_or_else(|| IdeError::invalid("Home folder is unavailable"))
            }
        }
    }

    pub async fn resolve(&self, path: &str) -> IdeResult<String> {
        match self {
            Self::Sftp(fs) => fs.resolve(path).await,
            Self::Local => {
                let expanded = crate::expand(path.trim());
                let path = if path.trim().is_empty() || path.trim() == "~" {
                    std::path::PathBuf::from(self.home().await?)
                } else {
                    expanded
                };
                let path = if path.is_absolute() { path } else { std::env::current_dir()?.join(path) };
                Ok(path_string(&path))
            }
        }
    }

    pub async fn stat(&self, path: &str) -> IdeResult<Option<RemoteEntry>> {
        match self {
            Self::Sftp(fs) => fs.stat(path).await,
            Self::Local => match tokio::fs::metadata(path).await {
                Ok(meta) => Ok(Some(local_entry(path, meta).await?)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            },
        }
    }

    pub async fn list(&self, dir: &str) -> IdeResult<Vec<RemoteEntry>> {
        match self {
            Self::Sftp(fs) => fs.list(dir).await,
            Self::Local => {
                let mut read = tokio::fs::read_dir(dir).await?;
                let mut entries = Vec::new();
                while let Some(e) = read.next_entry().await? {
                    let path = path_string(&e.path());
                    entries.push(local_entry(&path, tokio::fs::symlink_metadata(e.path()).await?).await?);
                }
                entries.sort_by(|a, b| {
                    b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                });
                Ok(entries)
            }
        }
    }

    pub async fn read(&self, path: &str) -> IdeResult<Vec<u8>> {
        match self {
            Self::Sftp(fs) => fs.read(path).await,
            Self::Local => Ok(tokio::fs::read(path).await?),
        }
    }

    pub async fn write(&self, path: &str, data: &[u8], mtime: Option<u32>) -> IdeResult<()> {
        match self {
            Self::Sftp(fs) => fs.write(path, data, mtime).await,
            Self::Local => {
                if let Some(parent) = Path::new(path).parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(path, data).await?;
                if let Some(t) = mtime {
                    set_mtime(path, t).await;
                }
                Ok(())
            }
        }
    }

    pub async fn upload(&self, local: &Path, remote: &str, preserve_time: bool) -> IdeResult<()> {
        match self {
            Self::Sftp(fs) => fs.upload(local, remote, preserve_time).await,
            Self::Local => {
                reject_same_file(local, Path::new(remote)).await?;
                copy_file(local, Path::new(remote)).await?;
                if let Some(t) = preserve_time.then(|| crate::sftp::mtime_of(local)).flatten() {
                    set_mtime(remote, t).await;
                }
                Ok(())
            }
        }
    }

    pub async fn download(&self, remote: &str, local: &Path) -> IdeResult<()> {
        match self {
            Self::Sftp(fs) => fs.download(remote, local).await,
            Self::Local => {
                reject_same_file(Path::new(remote), local).await?;
                copy_file(Path::new(remote), local).await
            }
        }
    }

    pub async fn mkdir_all(&self, path: &str) -> IdeResult<()> {
        match self {
            Self::Sftp(fs) => fs.mkdir_all(path).await,
            Self::Local => Ok(tokio::fs::create_dir_all(path).await?),
        }
    }

    pub async fn remove(&self, path: &str) -> IdeResult<()> {
        match self {
            Self::Sftp(fs) => fs.remove(path).await,
            Self::Local => {
                let meta = tokio::fs::symlink_metadata(path).await?;
                if meta.is_dir() {
                    tokio::fs::remove_dir_all(path).await?;
                } else {
                    tokio::fs::remove_file(path).await?;
                }
                Ok(())
            }
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> IdeResult<()> {
        match self {
            Self::Sftp(fs) => fs.rename(from, to).await,
            Self::Local => Ok(tokio::fs::rename(from, to).await?),
        }
    }

    /// Probe actual write access, including ACLs and read-only mounts.
    pub async fn test(&self, path: &str) -> IdeResult<()> {
        let path = self.resolve(path).await?;
        let entry =
            self.stat(&path).await?.ok_or_else(|| IdeError::not_found(format!("Folder does not exist: {path}")))?;
        if !entry.is_dir {
            return Err(IdeError::invalid(format!("Not a folder: {path}")));
        }
        if matches!(self, Self::Local) {
            let name = format!(
                ".openidea-write-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
            );
            let probe = Path::new(&path).join(name);
            let mut file =
                tokio::fs::OpenOptions::new().write(true).create_new(true).open(&probe).await.map_err(|e| {
                    IdeError::new(
                        ide_core::error::ErrorKind::PermissionDenied,
                        format!("Folder is not writable: {path}: {e}"),
                    )
                })?;
            use tokio::io::AsyncWriteExt;
            let result = file.write_all(b"test").await;
            drop(file);
            let cleanup = tokio::fs::remove_file(probe).await;
            result.and(cleanup).map_err(|e| {
                IdeError::new(
                    ide_core::error::ErrorKind::PermissionDenied,
                    format!("Folder is not writable: {path}: {e}"),
                )
            })?;
        } else {
            self.list(&path).await?;
        }
        Ok(())
    }

    pub async fn close(&self) {
        if let Self::Sftp(fs) = self {
            fs.close().await;
        }
    }
}

/// Copies without holding the file in memory: deployments can include large archives.
async fn copy_file(from: &Path, to: &Path) -> IdeResult<()> {
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::copy(from, to).await?;
    Ok(())
}

async fn set_mtime(path: &str, seconds: u32) {
    let result = async {
        let file = tokio::fs::OpenOptions::new().write(true).open(path).await?.into_std().await;
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(u64::from(seconds)))
    };
    if let Err(e) = result.await {
        tracing::debug!("Cannot set the time of {path}: {e}");
    }
}

fn path_string(path: &Path) -> String {
    let path = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    let path = path.replace('\\', "/");
    path
}

async fn local_entry(path: &str, meta: std::fs::Metadata) -> IdeResult<RemoteEntry> {
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        crate::sftp::mode_string(meta.permissions().mode())
    };
    #[cfg(not(unix))]
    let permissions = if meta.permissions().readonly() { "r--r--r--" } else { "rw-rw-rw-" }.to_owned();
    let is_dir = meta.is_dir() || (meta.is_symlink() && tokio::fs::metadata(path).await.is_ok_and(|m| m.is_dir()));
    Ok(RemoteEntry {
        name: Path::new(path).file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_owned(),
        is_dir,
        is_symlink: meta.is_symlink(),
        size: meta.len(),
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|t| t.as_secs().try_into().ok()),
        permissions,
    })
}

async fn reject_same_file(from: &Path, to: &Path) -> IdeResult<()> {
    let source = tokio::fs::metadata(from).await?;
    let target = match tokio::fs::metadata(to).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    #[cfg(unix)]
    let same = {
        use std::os::unix::fs::MetadataExt;
        source.dev() == target.dev() && source.ino() == target.ino()
    };
    #[cfg(not(unix))]
    let same = {
        let _ = (source, target);
        tokio::fs::canonicalize(from).await? == tokio::fs::canonicalize(to).await?
    };
    if same {
        Err(IdeError::invalid(format!("Source and destination are the same file: {}", from.display())))
    } else {
        Ok(())
    }
}
