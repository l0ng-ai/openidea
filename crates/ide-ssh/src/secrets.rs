//! Saved passwords (SSH passwords / key passphrases by configuration id, git HTTPS
//! credentials, the HTTP proxy's) in the OS credential store: Windows Credential
//! Manager, the macOS Keychain, the Secret Service on Linux. The file at `path` only
//! indexes them (an id and the keys, never a secret); owner-only on Unix.
//!
//! Older versions kept the secrets themselves in that file: they are moved to the
//! credential store on first use. Without a credential store (a headless Linux
//! host) such a file is still read, but no secret is written to disk: saving fails
//! and callers keep the secret for the session only.

use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

const SERVICE: &str = "ai.l0ng.openidea";

/// Serialises read-modify-write of the index files (several stores may share one).
static LOCK: Mutex<()> = Mutex::new(());

/// Reads the secrets of an older version's file, by key (`None`: not that format).
pub type Legacy = fn(serde_json::Value) -> Option<BTreeMap<String, String>>;

pub struct SecretFile {
    path: PathBuf,
    legacy: Legacy,
}

/// The file's contents. `id` keeps the credentials of different data directories
/// (and of tests) apart in the one OS store.
#[derive(Serialize, Deserialize)]
struct Index {
    id: String,
    keys: BTreeSet<String>,
}

enum Contents {
    Index(Index),
    /// An older version's file that could not be moved (no credential store).
    Plaintext(BTreeMap<String, String>),
}

impl SecretFile {
    pub fn new(path: PathBuf) -> Self {
        Self::with_legacy(path, |v| serde_json::from_value(v).ok())
    }

    pub fn with_legacy(path: PathBuf, legacy: Legacy) -> Self {
        Self { path, legacy }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let _g = LOCK.lock();
        match self.load() {
            Contents::Index(index) if index.keys.contains(key) => match entry(&index.id, key)?.get_password() {
                Ok(secret) => Some(secret),
                Err(keyring_core::Error::NoEntry) => None,
                Err(e) => {
                    tracing::warn!("saved passwords: {key}: {e}");
                    None
                }
            },
            Contents::Index(_) => None,
            Contents::Plaintext(mut all) => all.remove(key),
        }
    }

    pub fn set(&self, key: &str, secret: &str) -> IdeResult<()> {
        let _g = LOCK.lock();
        let Contents::Index(mut index) = self.load() else {
            return Err(unavailable("no credential store"));
        };
        let entry = entry(&index.id, key).ok_or_else(|| unavailable("no credential store"))?;
        entry.set_password(secret).map_err(|e| unavailable(&e.to_string()))?;
        if index.keys.insert(key.to_owned()) {
            self.write(&index)?;
        }
        Ok(())
    }

    pub fn delete(&self, key: &str) {
        let _g = LOCK.lock();
        let written = match self.load() {
            Contents::Index(mut index) => {
                if !index.keys.remove(key) {
                    return;
                }
                if let Some(Err(e)) = entry(&index.id, key).map(|e| e.delete_credential())
                    && !matches!(e, keyring_core::Error::NoEntry)
                {
                    tracing::warn!("saved passwords: {key}: {e}");
                }
                self.write(&index)
            }
            Contents::Plaintext(mut all) => {
                if all.remove(key).is_none() {
                    return;
                }
                self.write(&all)
            }
        };
        if let Err(e) = written {
            tracing::warn!("{}", e.message);
        }
    }

    /// Every stored key, sorted (the secrets themselves stay private).
    pub fn keys(&self) -> Vec<String> {
        let _g = LOCK.lock();
        match self.load() {
            Contents::Index(index) => index.keys.into_iter().collect(),
            Contents::Plaintext(all) => all.into_keys().collect(),
        }
    }

    /// Reads the file, moving an older version's secrets to the credential store.
    /// The old file is replaced only once every secret was moved, so a failure or a
    /// crash halfway keeps it, and the next call moves them again.
    fn load(&self) -> Contents {
        let fresh = || Index { id: uuid::Uuid::new_v4().to_string(), keys: BTreeSet::new() };
        let value = match std::fs::read(&self.path).map(|b| serde_json::from_slice::<serde_json::Value>(&b)) {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                tracing::warn!("saved passwords: {}: {e}", self.path.display());
                return Contents::Index(fresh());
            }
            Err(_) => return Contents::Index(fresh()),
        };
        if let Ok(index) = serde_json::from_value::<Index>(value.clone()) {
            return Contents::Index(index);
        }
        let Some(old) = (self.legacy)(value) else {
            tracing::warn!("saved passwords: {}: unknown format", self.path.display());
            return Contents::Index(fresh());
        };
        let index = Index { keys: old.keys().cloned().collect(), ..fresh() };
        let moved = old.iter().all(|(key, secret)| match entry(&index.id, key).map(|e| e.set_password(secret)) {
            Some(Ok(())) => true,
            Some(Err(e)) => {
                tracing::warn!("saved passwords: could not move {key} to the credential store: {e}");
                false
            }
            None => false,
        });
        if moved && self.write(&index).is_ok() {
            return Contents::Index(index);
        }
        for key in &index.keys {
            if let Some(e) = entry(&index.id, key) {
                let _ = e.delete_credential();
            }
        }
        Contents::Plaintext(old)
    }

    fn write(&self, contents: &impl Serialize) -> IdeResult<()> {
        let err = |e: std::io::Error| IdeError::unavailable(format!("saved passwords: {}: {e}", self.path.display()));
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let bytes = serde_json::to_vec_pretty(contents).map_err(|e| IdeError::internal(e.to_string()))?;
        std::io::Write::write_all(&mut options.open(&tmp).map_err(err)?, &bytes).map_err(err)?;
        std::fs::rename(&tmp, &self.path).map_err(err)
    }
}

fn unavailable(why: &str) -> IdeError {
    IdeError::unavailable(format!("saved passwords: {why}"))
}

/// The credential of `key` among those of file `id`; `None` without a credential store.
fn entry(id: &str, key: &str) -> Option<keyring_core::Entry> {
    if keyring_core::get_default_store().is_none() {
        #[cfg(any(test, feature = "testing"))]
        testing::use_memory_store();
        #[cfg(not(any(test, feature = "testing")))]
        if let Err(e) = keyring::Entry::store_status() {
            tracing::warn!("saved passwords: no credential store: {e}");
            return None;
        }
    }
    keyring_core::Entry::new(&format!("{SERVICE}/{id}"), key)
        .inspect_err(|e| tracing::warn!("saved passwords: {key}: {e}"))
        .ok()
}

/// Helpers for tests of crates that save secrets (feature `testing`).
#[cfg(any(test, feature = "testing"))]
pub mod testing {
    use std::path::{Path, PathBuf};

    /// Makes an in-memory credential store the default, so that tests never touch
    /// the user's keychain.
    pub fn use_memory_store() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| keyring_core::set_default_store(keyring_core::sample::Store::new().expect("memory store")));
    }

    /// Every file under `dir` whose bytes contain `needle`.
    pub fn files_containing(dir: &Path, needle: &str) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(d) = pending.pop() {
            for entry in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if std::fs::read(&path).is_ok_and(|b| b.windows(needle.len()).any(|w| w == needle.as_bytes())) {
                    found.push(path);
                }
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::testing::files_containing;
    use super::*;

    #[test]
    fn saved_secrets_never_reach_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ssh-passwords.json");
        SecretFile::new(path.clone()).set("a", "hunter2-ssh").unwrap();
        assert_eq!(files_containing(tmp.path(), "hunter2-ssh"), Vec::<PathBuf>::new());
        let reopened = SecretFile::new(path);
        assert_eq!(reopened.get("a").as_deref(), Some("hunter2-ssh"));
        assert_eq!(reopened.keys(), ["a"]);
    }

    #[test]
    fn moves_plaintext_files_of_older_versions_off_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("git-credentials.json");
        std::fs::write(&path, r#"{"https://example.com": "me\nold-pw"}"#).unwrap();
        let file = SecretFile::new(path.clone());
        assert_eq!(file.keys(), ["https://example.com"]);
        assert_eq!(files_containing(tmp.path(), "old-pw"), Vec::<PathBuf>::new());
        assert_eq!(SecretFile::new(path).get("https://example.com").as_deref(), Some("me\nold-pw"));
    }

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
