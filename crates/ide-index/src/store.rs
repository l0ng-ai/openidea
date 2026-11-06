//! Persistence of file records in redb, so a restart only re-parses changed files.

use crate::data::FileRecord;
use parking_lot::RwLock;
use redb::{Database, Durability, ReadableDatabase, ReadableTable, TableDefinition, TableError};
use std::path::Path;

const FILES: TableDefinition<&str, &[u8]> = TableDefinition::new("files");
const META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
/// Bump when [`FileRecord`] or its encoding changes.
const SCHEMA: &str = "openidea-index-6";

type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub(crate) struct Store {
    /// Write-locked only for [`Store::compact`].
    db: RwLock<Database>,
}

impl Store {
    /// Opens (or creates) `cache_dir/index.redb`. Records written by another
    /// schema / extractor version or for another root are discarded. Returns
    /// `None` when the database cannot be used (e.g. locked by another window);
    /// the index then runs in memory only.
    pub(crate) fn open(cache_dir: &Path, root: &Path, fingerprint: &str) -> Option<Self> {
        if let Err(e) = std::fs::create_dir_all(cache_dir) {
            tracing::warn!("index cache {}: {e}", cache_dir.display());
            return None;
        }
        let file = cache_dir.join("index.redb");
        let db = match Database::create(&file) {
            Ok(db) => db,
            Err(redb::DatabaseError::DatabaseAlreadyOpen) => {
                tracing::warn!("index cache {} is in use; indexing in memory only", file.display());
                return None;
            }
            Err(e) => {
                tracing::warn!("index cache {} unreadable ({e}); rebuilding", file.display());
                let _ = std::fs::remove_file(&file);
                Database::create(&file).map_err(|e| tracing::warn!("index cache: {e}")).ok()?
            }
        };
        let store = Self { db: RwLock::new(db) };
        let stamp = format!("{SCHEMA}\n{fingerprint}\n{}", root.display());
        match store.meta("stamp") {
            Ok(Some(v)) if v == stamp.as_bytes() => {}
            _ => {
                if let Err(e) = store.reset(&stamp) {
                    tracing::warn!("index cache reset failed: {e}");
                    return None;
                }
            }
        }
        Some(store)
    }

    fn meta(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let txn = self.db.read().begin_read().map_err(err)?;
        let table = match txn.open_table(META) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(e) => return Err(err(e)),
        };
        Ok(table.get(key).map_err(err)?.map(|v| v.value().to_vec()))
    }

    fn reset(&self, stamp: &str) -> Result<()> {
        let txn = self.db.read().begin_write().map_err(err)?;
        match txn.delete_table(FILES) {
            Ok(_) | Err(TableError::TableDoesNotExist(_)) => {}
            Err(e) => return Err(err(e)),
        }
        {
            let mut meta = txn.open_table(META).map_err(err)?;
            meta.insert("stamp", stamp.as_bytes()).map_err(err)?;
            txn.open_table(FILES).map_err(err)?;
        }
        txn.commit().map_err(err)
    }

    /// All persisted records; undecodable entries are skipped (and re-indexed).
    pub(crate) fn load(&self) -> Result<Vec<(String, FileRecord)>> {
        let txn = self.db.read().begin_read().map_err(err)?;
        let table = match txn.open_table(FILES) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(Vec::new()),
            Err(e) => return Err(err(e)),
        };
        let mut out = Vec::new();
        for item in table.iter().map_err(err)? {
            let (k, v) = item.map_err(err)?;
            if let Ok(rec) = postcard::from_bytes::<FileRecord>(v.value()) {
                out.push((k.value().to_owned(), rec));
            }
        }
        Ok(out)
    }

    /// Applies upserts and deletions in one transaction. Non-durable commits
    /// are cheap (no fsync) and become durable with the next durable one.
    pub(crate) fn apply(&self, puts: &[(String, FileRecord)], deletes: &[String], durable: bool) -> Result<()> {
        let mut txn = self.db.read().begin_write().map_err(err)?;
        if !durable {
            txn.set_durability(Durability::None).map_err(err)?;
        }
        {
            let mut table = txn.open_table(FILES).map_err(err)?;
            let mut buf = Vec::new();
            for (rel, rec) in puts {
                buf.clear();
                let bytes = postcard::to_extend(rec, std::mem::take(&mut buf)).map_err(err)?;
                table.insert(rel.as_str(), bytes.as_slice()).map_err(err)?;
                buf = bytes;
            }
            for rel in deletes {
                table.remove(rel.as_str()).map_err(err)?;
            }
        }
        txn.commit().map_err(err)
    }

    /// Reclaims free pages in the database file; `true` if anything was compacted.
    pub(crate) fn compact(&self) -> Result<bool> {
        self.db.write().compact().map_err(err)
    }

    pub(crate) fn load_recent(&self) -> Vec<String> {
        self.meta("recent").ok().flatten().and_then(|v| postcard::from_bytes(&v).ok()).unwrap_or_default()
    }

    pub(crate) fn save_recent(&self, recent: &[String]) -> Result<()> {
        let bytes = postcard::to_allocvec(recent).map_err(err)?;
        self.set_meta("recent", &bytes)
    }

    fn set_meta(&self, key: &str, value: &[u8]) -> Result<()> {
        let txn = self.db.read().begin_write().map_err(err)?;
        txn.open_table(META).map_err(err)?.insert(key, value).map_err(err)?;
        txn.commit().map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_reset_on_new_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let root = Path::new("/proj");
        {
            let s = Store::open(dir.path(), root, "fp1").unwrap();
            let rec = FileRecord { mtime: 7, size: 3, ..Default::default() };
            s.apply(&[("a.rs".into(), rec.clone()), ("b.rs".into(), rec)], &[], false).unwrap();
            s.apply(&[], &["b.rs".into()], true).unwrap();
            s.save_recent(&["a.rs".into()]).unwrap();
        }
        {
            let s = Store::open(dir.path(), root, "fp1").unwrap();
            let all = s.load().unwrap();
            assert_eq!(all.len(), 1);
            assert_eq!((all[0].0.as_str(), all[0].1.mtime), ("a.rs", 7));
            assert_eq!(s.load_recent(), vec!["a.rs".to_owned()]);
        }
        let s = Store::open(dir.path(), root, "fp2").unwrap();
        assert!(s.load().unwrap().is_empty());
        let recs: Vec<(String, FileRecord)> = (0..500).map(|i| (format!("f{i}.rs"), FileRecord::default())).collect();
        s.apply(&recs, &[], true).unwrap();
        let dels: Vec<String> = recs.iter().map(|(k, _)| k.clone()).collect();
        s.apply(&[], &dels, true).unwrap();
        s.compact().unwrap();
        assert!(s.load().unwrap().is_empty());
    }

    #[test]
    fn corrupt_file_is_rebuilt() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.redb"), b"garbage, not a database").unwrap();
        let s = Store::open(dir.path(), Path::new("/p"), "fp").unwrap();
        assert!(s.load().unwrap().is_empty());
    }
}
