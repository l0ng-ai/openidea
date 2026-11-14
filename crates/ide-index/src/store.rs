//! Persistence of file records in redb, so a restart only re-parses changed files.

use crate::data::{FileEntry, FileRecord, IndexData, Sym, char_mask};
use crate::filter::{PathFilter, mtime_of};
use ide_core::{Range, SymbolKind};
use parking_lot::RwLock;
use redb::{Database, Durability, ReadableDatabase, ReadableTable, TableDefinition, TableError};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const FILES: TableDefinition<&str, &[u8]> = TableDefinition::new("files");
const META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
/// Bump when [`FileRecord`] or its encoding changes.
const SCHEMA: &str = "openidea-index-3";

/// The real Git directory for a checkout/worktree (`root/.git` may be a file
/// containing `gitdir: ...`).
fn git_dir(root: &Path) -> Option<std::path::PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text.strip_prefix("gitdir:")?.trim();
    let path = Path::new(target);
    Some(if path.is_absolute() { path.to_owned() } else { root.join(path) })
}

/// Every ignore/config input the walker may consult, including candidates that
/// do not exist yet. Comparing the full set (plus presence/mtime/size) catches
/// new `.git/info/exclude` files, redirected `core.excludesFile`, and worktrees.
pub(crate) fn ignore_candidates(root: &Path, dirs: &[String]) -> Vec<std::path::PathBuf> {
    let mut out = std::collections::BTreeSet::new();
    for rel in dirs {
        let dir = if rel.is_empty() { root.to_owned() } else { root.join(rel) };
        out.insert(dir.join(".gitignore"));
        out.insert(dir.join(".ignore"));
    }
    if let Some(git) = git_dir(root) {
        out.insert(git.join("config"));
        out.insert(git.join("info/exclude"));
    }
    out.insert(root.join(".git/config"));
    out.insert(root.join(".git/info/exclude"));
    if let Some(path) = ignore::gitignore::gitconfig_excludes_path() {
        out.insert(path);
    }
    out.insert(std::path::PathBuf::from("/etc/gitconfig"));
    if let Some(path) = std::env::var_os("GIT_CONFIG_GLOBAL") {
        out.insert(path.into());
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        out.insert(home.join(".gitconfig"));
        out.insert(
            std::env::var_os("XDG_CONFIG_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
                .join("git/config"),
        );
    }
    out.into_iter().collect()
}

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
    dirs: String,
    dir_ends: Vec<u32>,
    dir_mtimes: Vec<u64>,
    dir_counts: Vec<u32>,
    filter: String,
    stamp: String,
    ignore_paths: String,
    ignore_ends: Vec<u32>,
    ignore_mtimes: Vec<u64>,
    ignore_sizes: Vec<u64>,
    ignore_present: Vec<bool>,
}

impl Snapshot {
    pub(crate) fn len(&self) -> usize {
        self.meta.len()
    }

    pub(crate) fn filter(&self) -> &str {
        &self.filter
    }

    pub(crate) fn dirs_len(&self) -> usize {
        self.dir_mtimes.len()
    }

    pub(crate) fn dir(&self, dir: usize) -> &str {
        let start = if dir == 0 { 0 } else { self.dir_ends[dir - 1] as usize };
        &self.dirs[start..self.dir_ends[dir] as usize]
    }

    pub(crate) fn dir_mtime(&self, dir: usize) -> u64 {
        self.dir_mtimes[dir]
    }

    pub(crate) fn dir_count(&self, dir: usize) -> u32 {
        self.dir_counts[dir]
    }

    pub(crate) fn ignore_len(&self) -> usize {
        self.ignore_mtimes.len()
    }

    pub(crate) fn ignore_path(&self, i: usize) -> &str {
        let start = if i == 0 { 0 } else { self.ignore_ends[i - 1] as usize };
        &self.ignore_paths[start..self.ignore_ends[i] as usize]
    }

    pub(crate) fn ignore_mtime(&self, i: usize) -> u64 {
        self.ignore_mtimes[i]
    }

    pub(crate) fn ignore_size(&self, i: usize) -> u64 {
        self.ignore_sizes[i]
    }

    pub(crate) fn ignore_present(&self, i: usize) -> bool {
        self.ignore_present[i]
    }

    pub(crate) fn mtime(&self, file: usize) -> u64 {
        self.meta[file].mtime
    }

    pub(crate) fn size(&self, file: usize) -> u64 {
        self.meta[file].size
    }

    /// Rejects a corrupt snapshot before any offsets are used for slicing.
    fn valid(&self) -> bool {
        let max = u32::MAX as usize;
        if self.rels.len() > max || self.text.len() > max || self.dirs.len() > max || self.ignore_paths.len() > max {
            return false;
        }
        if self.rel_ends.len() != self.meta.len() {
            return false;
        }
        let boundary = |text: &str, end: u32| end as usize <= text.len() && text.is_char_boundary(end as usize);
        let mut rel_end = 0;
        for end in &self.rel_ends {
            if *end < rel_end || !boundary(&self.rels, *end) {
                return false;
            }
            rel_end = *end;
        }
        if rel_end as usize != self.rels.len() {
            return false;
        }
        let mut start = 0;
        for end in &self.rel_ends {
            let rel = &self.rels[start..*end as usize];
            if !crate::data::safe_rel(rel) {
                return false;
            }
            start = *end as usize;
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
        if !self.symbols.iter().all(|s| {
            let Some(name_end) = (s.name_start as usize).checked_add(s.name_len as usize) else {
                return false;
            };
            let Some(container_end) = (s.container_start as usize).checked_add(s.container_len as usize) else {
                return false;
            };
            name_end <= self.text.len()
                && self.text.is_char_boundary(s.name_start as usize)
                && self.text.is_char_boundary(name_end)
                && (s.container_start == u32::MAX
                    || (s.container_start as usize <= self.text.len()
                        && container_end <= self.text.len()
                        && self.text.is_char_boundary(s.container_start as usize)
                        && self.text.is_char_boundary(container_end)))
        }) {
            return false;
        }
        if self.dir_ends.len() != self.dir_mtimes.len() || self.dir_counts.len() != self.dir_mtimes.len() {
            return false;
        }
        if self.dir_ends.first() != Some(&0) {
            return false;
        }
        let mut dir_end = 0;
        for end in &self.dir_ends {
            if *end < dir_end || !boundary(&self.dirs, *end) {
                return false;
            }
            dir_end = *end;
        }
        if dir_end as usize != self.dirs.len() {
            return false;
        }
        let mut start = 0;
        for end in &self.dir_ends {
            let dir = &self.dirs[start..*end as usize];
            if !dir.is_empty() && !crate::data::safe_rel(dir) {
                return false;
            }
            start = *end as usize;
        }
        if self.ignore_ends.len() != self.ignore_mtimes.len()
            || self.ignore_sizes.len() != self.ignore_mtimes.len()
            || self.ignore_present.len() != self.ignore_mtimes.len()
        {
            return false;
        }
        let mut ignore_end = 0;
        for end in &self.ignore_ends {
            if *end < ignore_end || !boundary(&self.ignore_paths, *end) {
                return false;
            }
            ignore_end = *end;
        }
        if ignore_end as usize != self.ignore_paths.len() {
            return false;
        }
        let mut start = 0;
        for end in &self.ignore_ends {
            if start == *end as usize {
                return false;
            }
            start = *end as usize;
        }
        true
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
                let name_start = s.name_start as usize;
                let name_end = name_start + s.name_len as usize;
                let name = &self.text[name_start..name_end];
                let container = (s.container_start != u32::MAX).then(|| {
                    let start = s.container_start as usize;
                    &self.text[start..start + s.container_len as usize]
                });
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

fn fit(n: usize) -> Result<u32> {
    u32::try_from(n).map_err(|_| "index snapshot exceeds the 4 GiB span limit".to_owned())
}

pub(crate) struct Store {
    /// Opened lazily: a valid warm-start snapshot serves start-up without
    /// touching redb. Write-locked only for [`Store::compact`].
    db: RwLock<Option<Database>>,
    /// Columnar warm-start snapshot, kept beside the database.
    snapshot: std::path::PathBuf,
    /// Recent-file list, readable without opening redb.
    recent_file: std::path::PathBuf,
    stamp: String,
}

impl Store {
    /// Opens (or creates) the cache directory. The redb database itself is opened
    /// lazily so a valid columnar snapshot can serve start-up without touching it.
    /// Returns `None` only when the cache directory cannot be created; the index
    /// then runs in memory only.
    pub(crate) fn open(cache_dir: &Path, root: &Path, fingerprint: &str) -> Option<Self> {
        if let Err(e) = std::fs::create_dir_all(cache_dir) {
            tracing::warn!("index cache {}: {e}", cache_dir.display());
            return None;
        }
        let stamp = format!("{SCHEMA}\n{}\n{fingerprint}\n{}", env!("INDEX_SOURCE_HASH"), root.display());
        Some(Self {
            db: RwLock::new(None),
            snapshot: cache_dir.join("index.snapshot"),
            recent_file: cache_dir.join("recent.snapshot"),
            stamp,
        })
    }

    fn open_db(&self) -> Result<Database> {
        let file = self.snapshot.with_file_name("index.redb");
        let db = match Database::create(&file) {
            Ok(db) => db,
            Err(redb::DatabaseError::DatabaseAlreadyOpen) => {
                return Err(format!("{} is in use", file.display()));
            }
            Err(e) => {
                tracing::warn!("index cache {} unreadable ({e}); rebuilding", file.display());
                let _ = std::fs::remove_file(&file);
                let _ = std::fs::remove_file(&self.snapshot);
                Database::create(&file).map_err(err)?
            }
        };
        let valid = {
            let txn = db.begin_read().map_err(err)?;
            match txn.open_table(META) {
                Ok(table) => table.get("stamp").map_err(err)?.is_some_and(|v| v.value() == self.stamp.as_bytes()),
                Err(TableError::TableDoesNotExist(_)) => false,
                Err(e) => return Err(err(e)),
            }
        };
        if !valid {
            let _ = std::fs::remove_file(&self.snapshot);
            let _ = std::fs::remove_file(&self.recent_file);
            Self::reset_db(&db, &self.stamp)?;
        }
        Ok(db)
    }

    fn ensure_db(&self) -> Result<()> {
        if self.db.read().is_some() {
            return Ok(());
        }
        let mut slot = self.db.write();
        if slot.is_none() {
            *slot = Some(self.open_db()?);
        }
        Ok(())
    }

    fn reset_db(db: &Database, stamp: &str) -> Result<()> {
        let txn = db.begin_write().map_err(err)?;
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

    fn meta(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.ensure_db()?;
        let db = self.db.read();
        let txn = db.as_ref().expect("ensured").begin_read().map_err(err)?;
        let table = match txn.open_table(META) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(e) => return Err(err(e)),
        };
        Ok(table.get(key).map_err(err)?.map(|v| v.value().to_vec()))
    }

    /// All persisted records; undecodable entries are skipped (and re-indexed).
    pub(crate) fn load(&self) -> Result<Vec<(String, FileRecord)>> {
        self.ensure_db()?;
        let db = self.db.read();
        let txn = db.as_ref().expect("ensured").begin_read().map_err(err)?;
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
    pub(crate) fn save_snapshot(&self, data: &IndexData, filter: &PathFilter, not_after: SystemTime) -> Result<()> {
        let guard = not_after.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
        let root = filter.root();
        let mut snap = Snapshot { filter: filter.stamp(), stamp: self.stamp.clone(), ..Default::default() };
        let mut dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        dirs.insert(String::new());
        for dir in filter.dirs(root) {
            if let Ok(rel) = dir.strip_prefix(root) {
                dirs.insert(rel.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_owned());
            }
        }
        for e in data.files.iter().flatten().filter(|e| e.path.starts_with(root)) {
            dirs.insert(e.dir().trim_end_matches('/').to_owned());
            snap.rels.push_str(&e.rel);
            snap.rel_ends.push(fit(snap.rels.len())?);
            for s in e.symbols.iter() {
                let name_start = fit(snap.text.len())?;
                snap.text.push_str(&s.name);
                let (container_start, container_len) = match s.container.as_deref() {
                    Some(c) => {
                        let start = fit(snap.text.len())?;
                        snap.text.push_str(c);
                        (start, fit(c.len())?)
                    }
                    None => (u32::MAX, 0),
                };
                snap.symbols.push(FlatSymbol {
                    name_start,
                    name_len: fit(s.name.len())?,
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
                sym_end: fit(snap.symbols.len())?,
            });
        }
        let dir_list: Vec<String> = dirs.into_iter().collect();
        for rel in &dir_list {
            let path = if rel.is_empty() { root.to_owned() } else { root.join(rel) };
            let mtime = std::fs::symlink_metadata(&path).ok().map(|m| mtime_of(&m)).unwrap_or(0);
            if mtime > guard {
                let _ = std::fs::remove_file(&self.snapshot);
                return Ok(());
            }
            let count = if rel.is_empty() {
                0
            } else {
                let key = format!("{rel}/");
                data.dirs.get(key.as_str()).map_or(0, |d| d.1)
            };
            snap.dirs.push_str(rel);
            snap.dir_ends.push(fit(snap.dirs.len())?);
            snap.dir_mtimes.push(mtime);
            snap.dir_counts.push(count);
        }
        for path in ignore_candidates(root, &dir_list) {
            let meta = std::fs::metadata(&path).ok();
            let present = meta.is_some();
            let mtime = meta.as_ref().map_or(0, mtime_of);
            if mtime > guard {
                let _ = std::fs::remove_file(&self.snapshot);
                return Ok(());
            }
            snap.ignore_paths.push_str(&path.to_string_lossy());
            snap.ignore_ends.push(fit(snap.ignore_paths.len())?);
            snap.ignore_mtimes.push(if present { mtime } else { 0 });
            snap.ignore_sizes.push(if present { meta.as_ref().map_or(0, |m| m.len()) } else { 0 });
            snap.ignore_present.push(present);
        }
        fit(snap.rels.len())?;
        fit(snap.text.len())?;
        fit(snap.dirs.len())?;
        fit(snap.ignore_paths.len())?;
        let bytes = postcard::to_allocvec(&snap).map_err(err)?;
        let tmp = self.snapshot.with_extension("snapshot.tmp");
        std::fs::write(&tmp, &bytes).map_err(err)?;
        let _ = std::fs::remove_file(&self.snapshot);
        std::fs::rename(&tmp, &self.snapshot).map_err(err)
    }

    /// The columnar start-up snapshot, if it was written and still decodes.
    pub(crate) fn load_snapshot(&self) -> Option<Snapshot> {
        let bytes = std::fs::read(&self.snapshot).ok()?;
        let snapshot: Snapshot = postcard::from_bytes(&bytes).ok()?;
        (snapshot.stamp == self.stamp && snapshot.valid()).then_some(snapshot)
    }

    /// Applies upserts and deletions in one transaction. Non-durable commits
    /// are cheap (no fsync) and become durable with the next durable one.
    pub(crate) fn apply(&self, puts: &[(String, FileRecord)], deletes: &[String], durable: bool) -> Result<()> {
        self.ensure_db()?;
        let db = self.db.read();
        let mut txn = db.as_ref().expect("ensured").begin_write().map_err(err)?;
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
        let _ = std::fs::remove_file(&self.snapshot);
        txn.commit().map_err(err)
    }

    /// Reclaims free pages in the database file; `true` if anything was compacted.
    pub(crate) fn compact(&self) -> Result<bool> {
        self.ensure_db()?;
        let mut db = self.db.write();
        db.as_mut().expect("ensured").compact().map_err(err)
    }

    pub(crate) fn load_recent(&self) -> Vec<String> {
        if let Some(recent) = self.load_recent_file() {
            return recent;
        }
        self.meta("recent").ok().flatten().and_then(|v| postcard::from_bytes(&v).ok()).unwrap_or_default()
    }

    /// Recent files without opening redb (the warm-start path).
    pub(crate) fn load_recent_file(&self) -> Option<Vec<String>> {
        let bytes = std::fs::read(&self.recent_file).ok()?;
        postcard::from_bytes(&bytes).ok()
    }

    pub(crate) fn save_recent(&self, recent: &[String]) -> Result<()> {
        self.save_recent_file(recent)?;
        let bytes = postcard::to_allocvec(recent).map_err(err)?;
        self.set_meta("recent", &bytes)
    }

    /// Rewrites only the recent sidecar, without opening redb.
    pub(crate) fn save_recent_file(&self, recent: &[String]) -> Result<()> {
        let bytes = postcard::to_allocvec(recent).map_err(err)?;
        std::fs::write(&self.recent_file, &bytes).map_err(err)
    }

    fn set_meta(&self, key: &str, value: &[u8]) -> Result<()> {
        self.ensure_db()?;
        let db = self.db.read();
        let txn = db.as_ref().expect("ensured").begin_write().map_err(err)?;
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
        store
            .save_snapshot(&data, &PathFilter::new(Path::new("/p"), &Vec::new().into(), &[]), SystemTime::now())
            .unwrap();

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

    #[test]
    fn snapshot_validation_rejects_bad_paths_and_split_utf8() {
        let escaping =
            Snapshot { rels: "../x".into(), rel_ends: vec![4], meta: vec![FileMeta::default()], ..Default::default() };
        assert!(!escaping.valid());

        let split =
            Snapshot { rels: "é".into(), rel_ends: vec![1], meta: vec![FileMeta::default()], ..Default::default() };
        assert!(!split.valid());
    }
}
