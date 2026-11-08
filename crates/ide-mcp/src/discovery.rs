//! `<app-data>/mcp/server.json`: where the running IDE's server listens and
//! its token, for the stdio bridge. Readable only by the user; removed when
//! the server stops.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// The discovery file, relative to the app data directory.
pub const DISCOVERY_FILE: &str = "mcp/server.json";

/// The discovery file of the IDE whose app data directory is `app_data`.
pub fn discovery_path(app_data: &Path) -> PathBuf {
    app_data.join(DISCOVERY_FILE)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Discovery {
    pub port: u16,
    pub token: String,
    /// The IDE's process.
    pub pid: u32,
    /// The IDE's version.
    pub version: String,
}

impl Discovery {
    pub fn read(path: &Path) -> io::Result<Self> {
        let bytes = std::fs::read(path)?;
        serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    /// Writes the file atomically, readable only by the user.
    pub fn write(&self, path: &Path) -> io::Result<()> {
        let dir = path.parent().ok_or_else(|| io::Error::other("no parent directory"))?;
        std::fs::create_dir_all(dir)?;
        let tmp = path.with_extension(format!("tmp{}", std::process::id()));
        let bytes = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        let written = write_private(&tmp, &bytes).and_then(|()| std::fs::rename(&tmp, path));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        written
    }

    /// Removes the file at `path` if it still describes this process's server.
    pub fn remove_if_ours(path: &Path) {
        if Self::read(path).is_ok_and(|d| d.pid == std::process::id()) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::remove_file(path);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// The app data directory is the user's own on Windows.
#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    std::fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_privately_and_only_its_owner_removes_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = discovery_path(tmp.path());
        let ours = Discovery { port: 1234, token: "t".into(), pid: std::process::id(), version: "0.1.0".into() };
        ours.write(&path).unwrap();
        assert_eq!(Discovery::read(&path).unwrap(), ours);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let theirs = Discovery { pid: ours.pid.wrapping_add(1), ..ours.clone() };
        theirs.write(&path).unwrap();
        Discovery::remove_if_ours(&path);
        assert!(path.is_file(), "another process's file stays");
        ours.write(&path).unwrap();
        Discovery::remove_if_ours(&path);
        assert!(!path.exists());
    }
}
