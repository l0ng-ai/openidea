//! Perforce file status: which files are opened, modified against have, or
//! untracked, mapped onto the shared [`ide_vcs`]-style status model.
//!
//! Perforce has no index: a file is *opened* (staged) or it is not, and a
//! opened file that differs on disk is also *modified* (unstaged). Untracked is
//! a file under the client root that `p4 fstat` reports unmapped — matching
//! `FileStatus`'s staged/unstaged split so the VCS tool window can show P4
//! changes with the same rows it uses for Git.

use crate::client::{Client, Connection};
use ide_core::IdeResult;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

use crate::client::ChangeAction;

/// One file's Perforce status, aligned to the Git `FileStatus` shape.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct P4FileStatus {
    pub path: ide_core::IpcPath,
    pub rel_path: String,
    /// Opened to a changelist (`staged` equivalent).
    pub opened: Option<ChangeAction>,
    /// Differs from the have revision on disk (`unstaged` equivalent).
    pub modified: bool,
    /// Under the client root but not in the depot (`untracked`).
    pub untracked: bool,
    /// Changelist the file is opened to (`0` = default).
    pub change: u32,
}

/// A Perforce workspace (client root + its connection), discovered under a path.
#[derive(Clone)]
pub struct Workspace {
    pub root: PathBuf,
    pub conn: Connection,
    exe: Option<PathBuf>,
}

impl Workspace {
    /// The workspace `path` belongs to (`p4 info`), or `Ok(None)` when `path`
    /// is not inside a Perforce client root.
    pub fn discover(path: &Path) -> IdeResult<Option<Self>> {
        let exe = crate::detected_p4_executable();
        Self::discover_with(path, exe.as_deref())
    }

    /// `discover` with an explicit `p4` executable (tests, settings override).
    pub fn discover_with(path: &Path, exe: Option<&Path>) -> IdeResult<Option<Self>> {
        let start = if path.is_file() { path.parent().unwrap_or(path) } else { path };
        let mut dir = start;
        loop {
            if let Some(conn) = Client::info(exe, dir)? {
                if conn.client_root.is_empty() {
                    return Ok(None);
                }
                let root = PathBuf::from(&conn.client_root);
                return Ok(Some(Workspace { root, conn, exe: exe.map(|p| p.to_path_buf()) }));
            }
            match dir.parent() {
                Some(p) => dir = p,
                None => return Ok(None),
            }
        }
    }

    /// The bound [`Client`] for write operations.
    pub fn client(&self) -> IdeResult<Client> {
        Client::new(self.conn.clone(), self.exe.as_deref())
    }

    /// Status of every file under `paths` (relative or absolute; `[]` = the
    /// whole client). Combines `p4 opened` (staged) with `p4 fstat` (modified
    /// against have) and a walk for untracked files.
    pub fn status(&self, paths: &[&str]) -> IdeResult<Vec<P4FileStatus>> {
        let client = self.client()?;
        let specs: Vec<String> = paths.iter().map(|p| self.to_spec(p)).collect();
        let specs_ref: Vec<&str> = specs.iter().map(|s| s.as_str()).collect();
        let opened = client.opened(&specs_ref).unwrap_or_default();
        let mut by_path: std::collections::HashMap<PathBuf, P4FileStatus> = std::collections::HashMap::new();
        for of in opened {
            let rel = self.rel(&of.path.0);
            by_path.insert(
                of.path.0.clone(),
                P4FileStatus {
                    path: of.path.clone(),
                    rel_path: rel,
                    opened: Some(of.action),
                    modified: of.action != ChangeAction::Other,
                    untracked: false,
                    change: of.change,
                },
            );
        }
        // fstat marks files differing from have (`status`/`...diff`) so a synced
        // but locally-edited file shows Modified even before `p4 edit`.
        for of in client.fstat(&specs_ref).unwrap_or_default() {
            let entry = by_path.entry(of.path.0.clone()).or_insert_with(|| P4FileStatus {
                path: of.path.clone(),
                rel_path: self.rel(&of.path.0),
                opened: None,
                modified: false,
                untracked: false,
                change: 0,
            });
            if of.action != ChangeAction::Other {
                entry.opened = Some(of.action);
                entry.modified = true;
            }
        }
        Ok(by_path.into_values().collect())
    }

    /// Local path or depot spec → a `p4` path spec. Absolute local paths and
    /// `//depot/…` pass through; bare names become `root/name`.
    fn to_spec(&self, p: &str) -> String {
        if p.starts_with("//") || Path::new(p).is_absolute() {
            return p.to_string();
        }
        self.root.join(p).to_string_lossy().into_owned()
    }

    fn rel(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .map(|r| r.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string_lossy().into_owned())
    }
}

/// Marks a file read-write so `p4 edit` can open it (Perforce keeps unopened
/// files read-only). Called by the checkout prompt for read-only depot files.
#[allow(dead_code)]
pub fn make_writable(path: &Path) -> IdeResult<()> {
    let mut perms = std::fs::metadata(path)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(perms.mode() | 0o200);
    }
    #[cfg(windows)]
    {
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
    }
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

/// Whether `path` is read-only on disk — the signal for "checkout on edit".
#[allow(dead_code)]
pub fn is_readonly(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.permissions().readonly()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_spec_maps_relative_paths() {
        let w = Workspace {
            root: PathBuf::from("/ws"),
            conn: crate::client::Connection {
                server_address: "perforce:1666".into(),
                user_name: "u".into(),
                client_name: "c".into(),
                client_root: "/ws".into(),
                client_host: None,
                server_version: None,
            },
            exe: None,
        };
        assert_eq!(w.to_spec("//depot/x.rs"), "//depot/x.rs");
        assert_eq!(w.to_spec("/abs/x.rs"), "/abs/x.rs");
        assert_eq!(w.to_spec("src/x.rs"), Path::new("/ws").join("src/x.rs").to_string_lossy());
    }

    #[test]
    fn readonly_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, "x").unwrap();
        assert!(!is_readonly(&f));
        let mut p = std::fs::metadata(&f).unwrap().permissions();
        p.set_readonly(true);
        std::fs::set_permissions(&f, p).unwrap();
        assert!(is_readonly(&f));
        make_writable(&f).unwrap();
        assert!(!is_readonly(&f));
    }
}
