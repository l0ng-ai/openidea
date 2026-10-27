//! Remote files over SFTP. Remote paths are POSIX strings.

use ide_core::{IdeError, IdeResult, error::ErrorKind};
use russh_sftp::client::SftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, StatusCode};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A remote directory entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    /// Absolute remote path.
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub mtime: Option<u32>,
    /// `rwxr-xr-x`.
    pub permissions: String,
}

/// `dir/name` without doubling the separator.
pub fn join(dir: &str, name: &str) -> String {
    if name.starts_with('/') {
        return name.to_owned();
    }
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() && !name.is_empty() { format!("/{name}") } else { format!("{dir}/{name}") }
}

/// The parent of a remote path (`/` for top-level entries).
pub fn parent(path: &str) -> Option<&str> {
    let trimmed = path.trim_end_matches('/');
    let i = trimmed.rfind('/')?;
    Some(if i == 0 { "/" } else { &trimmed[..i] })
}

fn mode_string(mode: u32) -> String {
    let bits = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o40, 'r'),
        (0o20, 'w'),
        (0o10, 'x'),
        (0o4, 'r'),
        (0o2, 'w'),
        (0o1, 'x'),
    ];
    bits.iter().map(|&(b, c)| if mode & b != 0 { c } else { '-' }).collect()
}

fn entry(path: String, name: String, attrs: &FileAttributes, target_is_dir: bool) -> RemoteEntry {
    RemoteEntry {
        name,
        path,
        is_dir: attrs.is_dir() || target_is_dir,
        is_symlink: attrs.is_symlink(),
        size: attrs.size.unwrap_or(0),
        mtime: attrs.mtime,
        permissions: attrs.permissions.map(mode_string).unwrap_or_default(),
    }
}

fn err(path: &str, e: SftpError) -> IdeError {
    let kind = match &e {
        SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile => ErrorKind::NotFound,
        SftpError::Status(s) if s.status_code == StatusCode::PermissionDenied => ErrorKind::PermissionDenied,
        _ => ErrorKind::Io,
    };
    IdeError::new(kind, format!("{path}: {e}"))
}

/// Higher-level operations on an [`SftpSession`].
pub struct RemoteFs {
    sftp: SftpSession,
}

impl RemoteFs {
    pub fn new(sftp: SftpSession) -> Self {
        Self { sftp }
    }

    /// The login directory.
    pub async fn home(&self) -> IdeResult<String> {
        self.sftp.canonicalize(".").await.map_err(|e| err(".", e))
    }

    /// Absolute form of `path`; `~` and `~/…` are relative to the login directory.
    pub async fn resolve(&self, path: &str) -> IdeResult<String> {
        let path = path.trim();
        if path.is_empty() || path == "~" {
            return self.home().await;
        }
        if let Some(rest) = path.strip_prefix("~/") {
            return Ok(join(&self.home().await?, rest));
        }
        if path.starts_with('/') {
            return Ok(path.to_owned());
        }
        Ok(join(&self.home().await?, path))
    }

    pub async fn stat(&self, path: &str) -> IdeResult<Option<RemoteEntry>> {
        match self.sftp.metadata(path).await {
            Ok(a) => {
                let name = path.rsplit('/').next().unwrap_or(path).to_owned();
                Ok(Some(entry(path.to_owned(), name, &a, false)))
            }
            Err(e) if err(path, e.clone()).kind == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(err(path, e)),
        }
    }

    /// Entries of `dir`, folders first, then by name; symlinks to folders count as folders.
    pub async fn list(&self, dir: &str) -> IdeResult<Vec<RemoteEntry>> {
        let read = self.sftp.read_dir(dir).await.map_err(|e| err(dir, e))?;
        let mut out = Vec::new();
        for e in read {
            let name = e.file_name();
            // A name with `/` (from a hostile server) would point elsewhere once joined.
            if name == "." || name == ".." || name.contains('/') {
                continue;
            }
            let path = join(dir, &name);
            let attrs = e.metadata();
            let target_is_dir =
                attrs.is_symlink() && self.sftp.metadata(path.as_str()).await.map(|m| m.is_dir()).unwrap_or(false);
            out.push(entry(path, name, &attrs, target_is_dir));
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    pub async fn read(&self, path: &str) -> IdeResult<Vec<u8>> {
        let mut file = self.sftp.open(path).await.map_err(|e| err(path, e))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).await?;
        Ok(buf)
    }

    /// Writes `data`, creating missing parent folders.
    pub async fn write(&self, path: &str, data: &[u8], mtime: Option<u32>) -> IdeResult<()> {
        if let Some(dir) = parent(path) {
            self.mkdir_all(dir).await?;
        }
        let mut file = self.sftp.create(path).await.map_err(|e| err(path, e))?;
        file.write_all(data).await?;
        file.shutdown().await?;
        if let Some(t) = mtime {
            let attrs = FileAttributes { atime: Some(t), mtime: Some(t), ..FileAttributes::empty() };
            if let Err(e) = self.sftp.set_metadata(path, attrs).await {
                tracing::debug!("SFTP: cannot set the time of {path}: {e}");
            }
        }
        Ok(())
    }

    pub async fn upload(&self, local: &Path, remote: &str, preserve_time: bool) -> IdeResult<()> {
        let data = tokio::fs::read(local).await?;
        let mtime = if preserve_time { mtime_of(local) } else { None };
        self.write(remote, &data, mtime).await
    }

    pub async fn download(&self, remote: &str, local: &Path) -> IdeResult<()> {
        let data = self.read(remote).await?;
        if let Some(dir) = local.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        tokio::fs::write(local, data).await?;
        Ok(())
    }

    /// `mkdir -p`.
    pub async fn mkdir_all(&self, dir: &str) -> IdeResult<()> {
        if dir.is_empty() || dir == "/" {
            return Ok(());
        }
        match self.sftp.metadata(dir).await {
            Ok(a) if a.is_dir() => return Ok(()),
            Ok(_) => return Err(IdeError::new(ErrorKind::AlreadyExists, format!("{dir} is not a folder"))),
            Err(_) => {}
        }
        if let Some(p) = parent(dir) {
            Box::pin(self.mkdir_all(p)).await?;
        }
        match self.sftp.create_dir(dir).await {
            Ok(()) => Ok(()),
            // Created meanwhile by a concurrent upload.
            Err(_) if self.sftp.metadata(dir).await.is_ok_and(|a| a.is_dir()) => Ok(()),
            Err(e) => Err(err(dir, e)),
        }
    }

    /// Deletes a file, or a folder with its contents.
    pub async fn remove(&self, path: &str) -> IdeResult<()> {
        let attrs = self.sftp.symlink_metadata(path).await.map_err(|e| err(path, e))?;
        if attrs.is_dir() {
            for e in self.list(path).await? {
                if e.is_dir && !e.is_symlink {
                    Box::pin(self.remove(&e.path)).await?;
                } else {
                    self.sftp.remove_file(e.path.as_str()).await.map_err(|x| err(&e.path, x))?;
                }
            }
            self.sftp.remove_dir(path).await.map_err(|e| err(path, e))
        } else {
            self.sftp.remove_file(path).await.map_err(|e| err(path, e))
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> IdeResult<()> {
        self.sftp.rename(from, to).await.map_err(|e| err(from, e))
    }

    pub async fn close(&self) {
        let _ = self.sftp.close().await;
    }
}

/// Seconds since the epoch of a local file's modification.
pub fn mtime_of(path: &Path) -> Option<u32> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    u32::try_from(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_and_splits_paths() {
        assert_eq!(join("/srv/app/", "a.txt"), "/srv/app/a.txt");
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/x", "/abs"), "/abs");
        assert_eq!(parent("/srv/app/a.txt"), Some("/srv/app"));
        assert_eq!(parent("/etc"), Some("/"));
        assert_eq!(parent("rel"), None);
        assert_eq!(mode_string(0o755), "rwxr-xr-x");
    }
}
