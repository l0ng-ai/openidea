//! Identities of index files last written by status, shared with filesystem watchers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::SystemTime;

#[derive(PartialEq, Eq)]
struct Identity {
    len: u64,
    modified: SystemTime,
}

fn identity(path: &Path) -> Option<Identity> {
    let metadata = path.metadata().ok()?;
    Some(Identity { len: metadata.len(), modified: metadata.modified().ok()? })
}

#[derive(Default)]
pub(crate) struct IndexWrites(HashMap<PathBuf, Identity>);

pub(crate) fn lock() -> MutexGuard<'static, IndexWrites> {
    static WRITES: OnceLock<Mutex<IndexWrites>> = OnceLock::new();
    WRITES.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}

impl IndexWrites {
    pub(crate) fn record(&mut self, path: &Path) {
        let Ok(path) = path.canonicalize() else { return };
        // Bound memory even when many repositories are opened over the process lifetime.
        if self.0.len() >= 256 && !self.0.contains_key(&path) {
            self.0.clear();
        }
        if let Some(identity) = identity(&path) {
            self.0.insert(path, identity);
        }
    }
}

/// Whether the current index still matches our last status write-back. Retain a
/// match for duplicate watcher notifications; invalidate it on an external write.
pub fn is_own_index_write(path: &Path) -> bool {
    let mut writes = lock();
    let Ok(path) = path.canonicalize() else { return false };
    if let Some(current) = identity(&path)
        && writes.0.get(&path) == Some(&current)
    {
        return true;
    }
    writes.0.remove(&path);
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_are_scoped_to_paths_and_invalidated_by_metadata_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("index");
        let second = tmp.path().join("other-index");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "first").unwrap();
        lock().record(&first);
        assert!(is_own_index_write(&first));
        assert!(!is_own_index_write(&second));
        let file = std::fs::File::options().write(true).open(&first).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH).unwrap();
        assert!(!is_own_index_write(&first));
        lock().record(&first);
        file.set_len(10).unwrap();
        assert!(!is_own_index_write(&first));
        std::fs::remove_file(&first).unwrap();
        assert!(!is_own_index_write(&first));
    }
}
