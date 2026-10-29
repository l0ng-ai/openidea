//! Saved passwords (SSH passwords / key passphrases by configuration id, the HTTP
//! proxy's), in the app's data directory rather than the OS credential store (no
//! system prompts). One JSON object, key → secret; owner-only on Unix.

use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::PathBuf;

pub struct SecretFile {
    path: PathBuf,
    lock: Mutex<()>,
}

impl SecretFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let _g = self.lock.lock();
        self.read().remove(key)
    }

    pub fn set(&self, key: &str, secret: &str) -> IdeResult<()> {
        let _g = self.lock.lock();
        let mut all = self.read();
        all.insert(key.to_owned(), secret.to_owned());
        self.write(&all)
    }

    pub fn delete(&self, key: &str) {
        let _g = self.lock.lock();
        let mut all = self.read();
        if all.remove(key).is_some()
            && let Err(e) = self.write(&all)
        {
            tracing::warn!("{}", e.message);
        }
    }

    fn read(&self) -> BTreeMap<String, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!("saved passwords: {}: {e}", self.path.display());
                BTreeMap::new()
            }),
            Err(_) => BTreeMap::new(),
        }
    }

    fn write(&self, all: &BTreeMap<String, String>) -> IdeResult<()> {
        let err = |e: std::io::Error| IdeError::unavailable(format!("saved passwords: {}: {e}", self.path.display()));
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
    fn stores_and_forgets_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let file = SecretFile::new(tmp.path().join("ssh-passwords.json"));
        file.set("a", "pw").unwrap();
        assert_eq!(file.get("a").as_deref(), Some("pw"));
        file.delete("a");
        assert_eq!(file.get("a"), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(tmp.path().join("ssh-passwords.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
