//! Values coding agents are configured with that may be secrets (MCP servers' environment
//! variables and HTTP headers, agents' environment), kept with the saved passwords in the OS
//! credential store; the files that configure them keep only the names. Without a credential
//! store (a headless Linux host) a value is kept in an owner-only file of the user's data
//! instead, never in a project's files, and the user is told.

use ide_core::event::NotifyLevel;
use ide_core::{IdeEvent, IdeResult, SharedSink};
use ide_ssh::secrets::SecretFile;
use parking_lot::Mutex;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub struct AgentSecrets {
    store: SecretFile,
    /// Values the credential store refused, by key.
    local: PathBuf,
    lock: Mutex<()>,
}

/// Where [`AgentSecrets::set`] kept a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kept {
    Store,
    LocalFile,
}

impl AgentSecrets {
    pub fn new(data_dir: &Path) -> Self {
        Self::with_store(
            SecretFile::new(data_dir.join("agent-secrets.json")),
            data_dir.join("agent-secrets.local.json"),
        )
    }

    pub fn with_store(store: SecretFile, local: PathBuf) -> Self {
        Self { store, local, lock: Mutex::new(()) }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.store.get(key).or_else(|| self.read_local().remove(key))
    }

    pub fn set(&self, key: &str, value: &str) -> IdeResult<Kept> {
        match self.store.set(key, value) {
            Ok(()) => {
                self.edit_local(|local| local.remove(key).is_some())?;
                Ok(Kept::Store)
            }
            Err(e) => {
                tracing::warn!("agent settings: {key} is kept in {}: {}", self.local.display(), e.message);
                self.edit_local(|local| local.insert(key.to_owned(), value.to_owned()).as_deref() != Some(value))?;
                Ok(Kept::LocalFile)
            }
        }
    }

    pub fn delete(&self, key: &str) {
        self.store.delete(key);
        if let Err(e) = self.edit_local(|local| local.remove(key).is_some()) {
            tracing::warn!("agent settings: could not forget {key}: {}", e.message);
        }
    }

    /// The keys that start with `prefix`, sorted.
    pub fn keys(&self, prefix: &str) -> Vec<String> {
        let keys: BTreeSet<String> = self.store.keys().into_iter().chain(self.read_local().into_keys()).collect();
        keys.into_iter().filter(|k| k.starts_with(prefix)).collect()
    }

    /// Tells the window that values went to the owner-only file rather than the credential store.
    pub fn notify_kept_locally(&self, sink: &SharedSink) {
        sink.emit(IdeEvent::Notify {
            level: NotifyLevel::Warning,
            title: "No credential store".into(),
            body: Some(format!(
                "Values of agent and MCP server settings are kept in {}, readable only by you.",
                self.local.display()
            )),
        });
    }

    fn read_local(&self) -> BTreeMap<String, String> {
        match std::fs::read(&self.local) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!("agent settings: {}: {e}", self.local.display());
                BTreeMap::new()
            }),
            Err(_) => BTreeMap::new(),
        }
    }

    fn edit_local(&self, edit: impl FnOnce(&mut BTreeMap<String, String>) -> bool) -> IdeResult<()> {
        let _g = self.lock.lock();
        let mut local = self.read_local();
        if !edit(&mut local) {
            return Ok(());
        }
        if local.is_empty() {
            return match std::fs::remove_file(&self.local) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
                _ => Ok(()),
            };
        }
        if let Some(dir) = self.local.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let bytes = serde_json::to_vec_pretty(&local).map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
        ide_vfs::write_atomic_private(&self.local, &bytes)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_ssh::secrets::testing::{files_containing, use_memory_store};
    use ide_ssh::secrets::{StoreError, StoreResult, Vault};
    use std::sync::Arc;

    /// A machine without a credential store (a headless Linux host).
    struct NoStore;

    impl Vault for NoStore {
        fn available(&self) -> bool {
            false
        }
        fn get(&self, _: &str, _: &str) -> StoreResult<String> {
            Err(StoreError::NoDefaultStore)
        }
        fn set(&self, _: &str, _: &str, _: &str) -> StoreResult<()> {
            Err(StoreError::NoDefaultStore)
        }
        fn delete(&self, _: &str, _: &str) -> StoreResult<()> {
            Err(StoreError::NoDefaultStore)
        }
    }

    #[test]
    fn values_go_to_the_credential_store() {
        use_memory_store();
        let tmp = tempfile::tempdir().unwrap();
        let secrets = AgentSecrets::new(tmp.path());
        assert_eq!(secrets.set("mcp/user/a/env/TOKEN", "value-7c1e").unwrap(), Kept::Store);
        assert_eq!(files_containing(tmp.path(), "value-7c1e"), Vec::<PathBuf>::new());
        assert_eq!(AgentSecrets::new(tmp.path()).get("mcp/user/a/env/TOKEN").as_deref(), Some("value-7c1e"));
        assert_eq!(secrets.keys("mcp/user/"), ["mcp/user/a/env/TOKEN"]);
        secrets.delete("mcp/user/a/env/TOKEN");
        assert_eq!(secrets.get("mcp/user/a/env/TOKEN"), None);
    }

    #[test]
    fn without_a_credential_store_values_stay_in_an_owner_only_file() {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("agent-secrets.local.json");
        let store = SecretFile::with_vault(
            tmp.path().join("agent-secrets.json"),
            |v| serde_json::from_value(v).ok(),
            Arc::new(NoStore),
        );
        let secrets = AgentSecrets::with_store(store, local.clone());
        assert_eq!(secrets.set("mcp/user/a/env/TOKEN", "value-7c1e").unwrap(), Kept::LocalFile);
        assert_eq!(files_containing(tmp.path(), "value-7c1e"), std::slice::from_ref(&local));
        assert_eq!(secrets.get("mcp/user/a/env/TOKEN").as_deref(), Some("value-7c1e"));
        assert_eq!(secrets.keys("mcp/"), ["mcp/user/a/env/TOKEN"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&local).unwrap().permissions().mode() & 0o777, 0o600);
        }
        secrets.delete("mcp/user/a/env/TOKEN");
        assert_eq!(secrets.get("mcp/user/a/env/TOKEN"), None);
        assert!(!local.exists());
    }
}
