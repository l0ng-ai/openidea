//! Saved data source passwords, in the OS credential store like the other saved
//! passwords ([`SecretFile`]). One index file for all projects; each credential is
//! keyed by project root, then credential key.

use ide_core::IdeResult;
use ide_ssh::secrets::SecretFile;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub struct SecretStore {
    file: SecretFile,
    project: String,
}

/// Credential key of the SSH password / key passphrase of data source `id`.
pub fn ssh_key(id: &str) -> String {
    format!("{id}#ssh")
}

/// The key of `key` of project `project` in the shared file.
fn file_key(project: &str, key: &str) -> String {
    format!("{project}|{key}")
}

/// Older versions' plaintext file: project root → credential key → secret.
fn legacy(value: serde_json::Value) -> Option<BTreeMap<String, String>> {
    let all: BTreeMap<String, BTreeMap<String, String>> = serde_json::from_value(value).ok()?;
    Some(
        all.into_iter()
            .flat_map(|(project, keys)| keys.into_iter().map(move |(k, s)| (file_key(&project, &k), s)))
            .collect(),
    )
}

impl SecretStore {
    pub fn new(path: PathBuf, root: &Path) -> Self {
        Self { file: SecretFile::with_legacy(path, legacy), project: root.to_string_lossy().into_owned() }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.file.get(&file_key(&self.project, key))
    }

    pub fn set(&self, key: &str, secret: &str) -> IdeResult<()> {
        self.file.set(&file_key(&self.project, key), secret)
    }

    pub fn delete(&self, key: &str) {
        self.file.delete(&file_key(&self.project, key))
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
