//! `<app-data>/mcp/server.json`: where the running IDE's server listens and
//! its token, for the stdio bridge. Readable only by the user; removed when
//! the server stops. `<app-data>/mcp/token` keeps the token across runs when
//! the user chose a fixed token.

use serde::{Deserialize, Serialize};
use std::io;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};

/// The discovery file, relative to the app data directory.
pub const DISCOVERY_FILE: &str = "mcp/server.json";

/// The discovery file of the IDE whose app data directory is `app_data`.
pub fn discovery_path(app_data: &Path) -> PathBuf {
    app_data.join(DISCOVERY_FILE)
}

/// The kept token, relative to the app data directory.
pub const TOKEN_FILE: &str = "mcp/token";

/// The kept token of the IDE whose app data directory is `app_data`.
pub fn token_path(app_data: &Path) -> PathBuf {
    app_data.join(TOKEN_FILE)
}

/// The token kept at `path`; a new one is made and kept there when there is none (or the
/// file doesn't hold one). Readable only by the user.
pub fn kept_token(path: &Path) -> io::Result<String> {
    if let Ok(text) = std::fs::read_to_string(path) {
        let token = text.trim();
        if token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(token.to_owned());
        }
    }
    let token = crate::server::new_token()?;
    write_atomic(path, token.as_bytes())?;
    Ok(token)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Discovery {
    /// Where a client on this computer connects (the file of an IDE without this field: `127.0.0.1`).
    #[serde(default = "loopback")]
    pub address: IpAddr,
    pub port: u16,
    pub token: String,
    /// The IDE's process.
    pub pid: u32,
    /// The IDE's version.
    pub version: String,
}

fn loopback() -> IpAddr {
    IpAddr::V4(Ipv4Addr::LOCALHOST)
}

impl Discovery {
    pub fn read(path: &Path) -> io::Result<Self> {
        let bytes = std::fs::read(path)?;
        serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    /// Writes the file atomically, readable only by the user, and records a per-server
    /// entry alongside it so multiple `openidea-server` processes sharing one data
    /// directory remain discoverable by project.
    pub fn write(&self, path: &Path) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        write_atomic(path, &bytes)?;
        if let Some(entry) = server_entry_path(path, self.pid, self.port) {
            let _ = write_atomic(&entry, &bytes);
        }
        // Entries of servers that ended without removing theirs (a crash) go now, so bridges
        // stop trying them.
        for (file, other) in sibling_entry_files(path) {
            if (other.pid, other.port) != (self.pid, self.port) && !other.listening() {
                let _ = std::fs::remove_file(file);
            }
        }
        Ok(())
    }

    fn listening(&self) -> bool {
        let addr = std::net::SocketAddr::new(self.address, self.port);
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(50)).is_ok()
    }

    /// Removes the file at `path` if it still describes this process's server.
    pub fn remove_if_ours(path: &Path) {
        if let Ok(d) = Self::read(path)
            && d.pid == std::process::id()
        {
            Self::remove_server(path, d.port);
        }
    }

    /// Removes this server's entry and updates `path` to another live entry when one exists.
    pub fn remove_server(path: &Path, port: u16) {
        let pid = std::process::id();
        if let Some(entry) = server_entry_path(path, pid, port) {
            let _ = std::fs::remove_file(entry);
        }
        if Self::read(path).is_ok_and(|d| d.pid == pid && d.port == port) {
            for (file, other) in sibling_entry_files(path) {
                if other.pid == pid && other.port == port {
                    continue;
                }
                if other.listening() {
                    if let Ok(bytes) = serde_json::to_vec_pretty(&other)
                        && write_atomic(path, &bytes).is_ok()
                    {
                        return;
                    }
                } else {
                    let _ = std::fs::remove_file(file);
                }
            }
            let _ = std::fs::remove_file(path);
        }
    }

    /// Running server entries recorded for `path`, starting with `path` itself.
    pub fn candidates(path: &Path) -> Vec<Self> {
        let mut out = Vec::new();
        if let Ok(primary) = Self::read(path) {
            out.push(primary);
        }
        for (_, item) in sibling_entry_files(path) {
            if !out.iter().any(|d| d.address == item.address && d.port == item.port) {
                out.push(item);
            }
        }
        out
    }
}

fn servers_dir(path: &Path) -> Option<PathBuf> {
    path.parent().map(|dir| dir.join("servers"))
}

fn server_entry_path(path: &Path, pid: u32, port: u16) -> Option<PathBuf> {
    servers_dir(path).map(|dir| dir.join(format!("{pid}-{port}.json")))
}

fn sibling_entry_files(path: &Path) -> Vec<(PathBuf, Discovery)> {
    let Some(dir) = servers_dir(path) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files.into_iter().filter_map(|p| Discovery::read(&p).ok().map(|d| (p, d))).collect()
}

/// Writes `bytes` to `path` atomically, readable only by the user.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::other("no parent directory"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    let written = write_private(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
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
        let ours = Discovery {
            address: "100.92.72.95".parse().unwrap(),
            port: 1234,
            token: "t".into(),
            pid: std::process::id(),
            version: "0.1.0".into(),
        };
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

        // The file of an IDE that listened on 127.0.0.1 only has no address.
        std::fs::write(&path, r#"{"port":1,"token":"t","pid":1,"version":"0.1.0"}"#).unwrap();
        assert_eq!(Discovery::read(&path).unwrap().address, loopback());
    }

    #[test]
    fn keeps_one_token_until_its_file_is_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = token_path(tmp.path());
        let first = kept_token(&path).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(kept_token(&path).unwrap(), first, "the same token on the next run");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(&path, "not a token").unwrap();
        let replaced = kept_token(&path).unwrap();
        assert_ne!(replaced, first);
        std::fs::remove_file(&path).unwrap();
        assert_ne!(kept_token(&path).unwrap(), replaced, "a removed token is made anew");
    }
}
