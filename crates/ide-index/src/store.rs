//! Persistence of file records in redb, so a restart only re-parses changed files.

use crate::data::{FileEntry, FileRecord, IndexData, Sym, char_mask};
use ide_core::{Range, SymbolKind};
use parking_lot::RwLock;
use redb::{Database, Durability, ReadableDatabase, ReadableTable, TableDefinition, TableError};
use serde::{Deserialize, Serialize};
use std::path::Path;

const FILES: TableDefinition<&str, &[u8]> = TableDefinition::new("files");
const META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
/// Bump when [`FileRecord`] or its encoding changes.
const SCHEMA: &str = "openidea-index-3";

/// One file's fixed-size columns in the start-up snapshot.
#[derive(Clone, Copy, Serialize, Deserialize, Default)]
struct FileMeta {
    mtime: u64,
    size: u64,
    hash: [u8; 32],
    ignored: bool,
    /// End of this file's symbols in [`Snapshot::symbols`].
    sym_end: u32,
}

/// One symbol's fixed-size columns; names and containers share [`Snapshot::text`].
#[derive(Clone, Copy, Serialize, Deserialize)]
struct FlatSymbol {
    name_start: u32,
    name_len: u32,
    container_start: u32,
    container_len: u32,
    kind: SymbolKind,
    range: Range,
}

/// A columnar copy of the index for fast start-up: a handful of contiguous
/// arrays and two string arenas instead of one postcard record per redb key.
#[derive(Serialize, Deserialize, Default)]
pub(crate) struct Snapshot {
    rels: String,
    rel_ends: Vec<u32>,
    meta: Vec<FileMeta>,
    symbols: Vec<FlatSymbol>,
    text: String,
}

impl Snapshot {
    pub(crate) fn len(&self) -> usize {
        self.meta.len()
    }

    /// Rejects a corrupt snapshot before any offsets are used for slicing.
    fn valid(&self) -> bool {
        if self.rel_ends.len() != self.meta.len() {
            return false;
        }
        let mut rel_end = 0;
        for end in &self.rel_ends {
            if *end < rel_end || *end as usize > self.rels.len() {
                return false;
            }
            rel_end = *end;
        }
        if rel_end as usize != self.rels.len() {
            return false;
        }
        let mut sym_end = 0;
        for meta in &self.meta {
            if meta.sym_end < sym_end || meta.sym_end as usize > self.symbols.len() {
                return false;
            }
            sym_end = meta.sym_end;
        }
        if sym_end as usize != self.symbols.len() {
            return false;
        }
        self.symbols.iter().all(|s| {
            let name_end = s.name_start as usize + s.name_len as usize;
            let container_end = s.container_start as usize + s.container_len as usize;
            name_end <= self.text.len()
                && (s.container_start == u32::MAX
                    || (s.container_start as usize <= self.text.len() && container_end <= self.text.len()))
        })
    }

    pub(crate) fn rel(&self, file: usize) -> &str {
        let start = if file == 0 { 0 } else { self.rel_ends[file - 1] as usize };
        &self.rels[start..self.rel_ends[file] as usize]
    }

    pub(crate) fn entry(&self, file: usize, root: &Path) -> FileEntry {
        let meta = self.meta[file];
        let sym_start = if file == 0 { 0 } else { self.meta[file - 1].sym_end as usize };
        let symbols = (sym_start..meta.sym_end as usize)
            .map(|i| {
                let s = self.symbols[i];
                let name = &self.text[s.name_start as usize..(s.name_start + s.name_len) as usize];
                let container = (s.container_start != u32::MAX)
                    .then(|| &self.text[s.container_start as usize..(s.container_start + s.container_len) as usize]);
                Sym {
                    mask: char_mask(name),
                    name: name.into(),
                    kind: s.kind,
                    container: container.map(Into::into),
                    range: s.range,
                }
            })
            .collect::<Vec<_>>()
            .into_boxed_slice();
        let rel = self.rel(file);
        FileEntry::from_flat(root.join(rel), rel.to_owned(), meta.mtime, meta.size, meta.hash, meta.ignored, symbols)
    }
}

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
        let stamp = format!("{SCHEMA}\n{}\n{fingerprint}\n{}", env!("INDEX_SOURCE_HASH"), root.display());
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
            meta.remove("snapshot").map_err(err)?;
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
        let iter = table.iter().map_err(err)?;
        let mut out = Vec::with_capacity(iter.size_hint().0);
        for item in iter {
            let (k, v) = item.map_err(err)?;
            if let Ok(rec) = postcard::from_bytes::<FileRecord>(v.value()) {
                out.push((k.value().to_owned(), rec));
            }
        }
        Ok(out)
    }

    /// Writes the current index as one columnar snapshot for fast next start-up.
    /// Only records persisted below `root` are included; content roots outside it
    /// are rescanned, as they are for the per-file records.
    pub(crate) fn save_snapshot(&self, data: &IndexData, root: &Path) -> Result<()> {
        let mut snap = Snapshot::default();
        for e in data.files.iter().flatten().filter(|e| e.path.starts_with(root)) {
            snap.rels.push_str(&e.rel);
            snap.rel_ends.push(snap.rels.len() as u32);
            for s in e.symbols.iter() {
                let name_start = snap.text.len() as u32;
                snap.text.push_str(&s.name);
                let (container_start, container_len) = match s.container.as_deref() {
                    Some(c) => {
                        let start = snap.text.len() as u32;
                        snap.text.push_str(c);
                        (start, c.len() as u32)
                    }
                    None => (u32::MAX, 0),
                };
                snap.symbols.push(FlatSymbol {
                    name_start,
                    name_len: s.name.len() as u32,
                    container_start,
                    container_len,
                    kind: s.kind,
                    range: s.range,
                });
            }
            snap.meta.push(FileMeta {
                mtime: e.mtime,
                size: e.size,
                hash: e.hash,
                ignored: e.ignored,
                sym_end: snap.symbols.len() as u32,
            });
        }
        let bytes = postcard::to_allocvec(&snap).map_err(err)?;
        self.set_meta("snapshot", &bytes)
    }

    /// The columnar start-up snapshot, if it was written and still decodes.
    pub(crate) fn load_snapshot(&self) -> Option<Snapshot> {
        let snapshot: Snapshot = self.meta("snapshot").ok().flatten().and_then(|v| postcard::from_bytes(&v).ok())?;
        snapshot.valid().then_some(snapshot)
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
        // Any file change makes the columnar start-up snapshot stale.
        txn.open_table(META).map_err(err)?.remove("snapshot").map_err(err)?;
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

    #[test]
    fn snapshot_roundtrips_and_is_invalidated_by_changes() {
        use crate::data::{FileEntry, IndexData, StoredSymbol};
        use ide_core::{Range, SymbolKind};

        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), Path::new("/p"), "fp").unwrap();
        let record = FileRecord {
            mtime: 7,
            size: 3,
            symbols: vec![StoredSymbol {
                name: "OrderController".into(),
                kind: SymbolKind::Class,
                container: Some("Order".into()),
                range: Range::default(),
            }],
            ..Default::default()
        };
        let mut data = IndexData::default();
        data.insert(FileEntry::new(std::path::PathBuf::from("/p/src/Order.rs"), "src/Order.rs".into(), record));
        // Content roots outside the project root are rescanned, not snapshotted.
        data.insert(FileEntry::new(std::path::PathBuf::from("/elsewhere/x.rs"), "x.rs".into(), FileRecord::default()));
        store.save_snapshot(&data, Path::new("/p")).unwrap();

        let snapshot = store.load_snapshot().expect("snapshot");
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot.rel(0), "src/Order.rs");
        let entry = snapshot.entry(0, Path::new("/p"));
        assert_eq!(&*entry.rel, "src/Order.rs");
        assert_eq!(entry.symbols.len(), 1);
        assert_eq!(&*entry.symbols[0].name, "OrderController");
        assert_eq!(entry.symbols[0].container.as_deref(), Some("Order"));

        store.apply(&[], &[], false).unwrap();
        assert!(store.load_snapshot().is_none(), "a file change invalidates the snapshot");
    }
}
