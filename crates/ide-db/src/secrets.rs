//! Saved data source passwords, in the app's data directory rather than the OS
//! credential store (no system prompts). One JSON file for all projects, keyed
//! by project root, then credential key; owner-only on Unix.

use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Project root → credential key → secret.
type Contents = BTreeMap<String, BTreeMap<String, String>>;

/// Serialises read-modify-write across the projects sharing the file.
static LOCK: Mutex<()> = Mutex::new(());

pub struct SecretStore {
    path: PathBuf,
    project: String,
}

/// Credential key of the SSH password / key passphrase of data source `id`.
pub fn ssh_key(id: &str) -> String {
    format!("{id}#ssh")
}

impl SecretStore {
    pub fn new(path: PathBuf, root: &Path) -> Self {
        Self { path, project: root.to_string_lossy().into_owned() }
    }

    /// The same file, keyed by `scope` instead (global data sources: the app data directory).
    pub fn scoped(&self, scope: &Path) -> Self {
        Self::new(self.path.clone(), scope)
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let _g = LOCK.lock();
        self.read().remove(&self.project)?.remove(key)
    }

    pub fn set(&self, key: &str, secret: &str) -> IdeResult<()> {
        let _g = LOCK.lock();
        let mut all = self.read();
        all.entry(self.project.clone()).or_default().insert(key.to_owned(), secret.to_owned());
        self.write(&all)
    }

    pub fn delete(&self, key: &str) {
        let _g = LOCK.lock();
        let mut all = self.read();
        let Some(project) = all.get_mut(&self.project) else { return };
        if project.remove(key).is_none() {
            return;
        }
        if project.is_empty() {
            all.remove(&self.project);
        }
        if let Err(e) = self.write(&all) {
            tracing::warn!("saved passwords: {}", e.message);
        }
    }

    fn read(&self) -> Contents {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!("saved passwords: {}: {e}", self.path.display());
                Contents::new()
            }),
            Err(_) => Contents::new(),
        }
    }

    fn write(&self, all: &Contents) -> IdeResult<()> {
        let err = |e: std::io::Error| IdeError::unavailable(format!("saved passwords: {e}"));
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let bytes = serde_json::to_vec_pretty(all).map_err(|e| IdeError::internal(e.to_string()))?;
        std::io::Write::write_all(&mut options.open(&tmp).map_err(err)?, &bytes).map_err(err)?;
        std::fs::rename(&tmp, &self.path).map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_projects_apart_and_drops_empty_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("db-passwords.json");
        let a = SecretStore::new(file.clone(), Path::new("/p/a"));
        let b = SecretStore::new(file.clone(), Path::new("/p/b"));
        a.set("s1", "pw-a").unwrap();
        b.set("s1", "pw-b").unwrap();
        b.set(&ssh_key("s1"), "pass").unwrap();
        assert_eq!(a.get("s1").as_deref(), Some("pw-a"));
        assert_eq!(b.get("s1#ssh").as_deref(), Some("pass"));
        a.delete("s1");
        assert_eq!(a.get("s1"), None);
        assert_eq!(b.get("s1").as_deref(), Some("pw-b"));
        assert!(!std::fs::read_to_string(&file).unwrap().contains("/p/a"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
}
