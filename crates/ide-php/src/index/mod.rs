//! Persistent indexes over the [`FileSummary`]s of a project.
//!
//! The indexes live in one redb database, `php-index.redb`, in the directory
//! the caller passes (the project cache directory, `Project::cache_dir`).
//! Following `crates/ide-index/src/store.rs` and `worker.rs`:
//!
//! - **files**: path → [`FileRecord`] (content hash, mtime, size). A file
//!   whose mtime and size are unchanged is not even read again, and one whose
//!   content hash is unchanged is not parsed again.
//! - **summaries**: content hash → postcard [`FileSummary`], with a
//!   reference count per hash. Files with the same content (copies, vendored
//!   duplicates, a reverted edit) share one summary and are parsed once.
//! - **fqns**: kind + FQN key → [`Decl`]. Class-likes and functions are keyed
//!   case-insensitively; a constant keeps the case of its own name.
//! - **short names**: lower-case short name → [`Decl`].
//! - **subclasses**: lower-case class-like FQN → the [`Decl`]s of class-likes
//!   that extend or implement it directly.
//! - **namespaces**: lower-case namespace (empty for the global one) → its
//!   child declarations and child namespaces.
//! - **meta files**: [`META_FILES_KEY`] → a `PHPSTORM_META` namespace
//!   [`Decl`] per file with `.phpstorm.meta.php` directives;
//!   [`LARAVEL_FILES_KEY`] → a [`Decl`] per file with Laravel bindings,
//!   migrations or casts (same table).
//! - **words**: lower-case identifier ([`words`]) → the files containing it
//!   anywhere (code, comments, strings), by a 64-bit id of the path; the
//!   candidates of a find-usages search. Each content hash keeps its word
//!   list, so a file's entries are removed exactly.
//!
//! The name tables are multimaps whose values carry the declaring file, so
//! two files declaring the same name (polyfills, stubs) keep both entries,
//! and a file's entries can be removed exactly when it changes. Queries
//! deduplicate where only the names matter.
//!
//! A stamp in the `meta` table records [`INDEX_SCHEMA`] and the summary
//! [`SCHEMA_VERSION`]; a database written with another stamp is cleared on
//! open. A database that can't be opened (locked by another window, or
//! unreadable twice) falls back to an in-memory one, so the engine still
//! works, only without persistence.
//!
//! [`PhpIndex::sync`] makes the index match a complete file list (the first
//! build, and every rescan); [`PhpIndex::update`] applies watcher batches.
//! Both read, hash and parse in parallel with rayon, commit in chunks of
//! [`CHUNK`] files, and stop with [`ide_core::error::ErrorKind::Cancelled`] between chunks
//! once the token is cancelled. Committed chunks stay valid, so a cancelled
//! build resumes where it stopped.

mod tables;
#[cfg(test)]
mod tests;
pub(crate) mod words;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use ide_core::{CancellationToken, IdeError, IdeResult};
use rayon::prelude::*;
use redb::backends::InMemoryBackend;
use redb::{
    Database, Durability, ReadableDatabase, ReadableMultimapTable, ReadableTable, ReadableTableMetadata, TableError,
};
use serde::{Deserialize, Serialize};

use crate::names::NameKind;
use crate::summary::{ClassKind, FileSummary, SCHEMA_VERSION};
use crate::syntax::ParsedFile;
use tables::*;
pub use tables::{LARAVEL_FILES_KEY, META_FILES_KEY};
pub use words::words;

/// Bump whenever the tables or their encodings change.
pub const INDEX_SCHEMA: u32 = 3;

/// The database file inside the cache directory.
pub const FILE_NAME: &str = "php-index.redb";

/// Files read, parsed and committed per write transaction.
pub const CHUNK: usize = 256;

/// What a [`Decl`] declares.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum DeclKind {
    ClassLike(ClassKind),
    Function,
    Constant,
    /// A namespace, as a child of its parent namespace.
    Namespace,
}

impl DeclKind {
    pub fn name_kind(self) -> NameKind {
        match self {
            Self::ClassLike(_) => NameKind::ClassLike,
            Self::Function => NameKind::Function,
            Self::Constant => NameKind::Constant,
            Self::Namespace => NameKind::Namespace,
        }
    }
}

/// One declaration in one file: what the index tables point to.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Decl {
    pub kind: DeclKind,
    /// The fully qualified name as declared, without the leading `\`.
    pub fqn: String,
    /// The declaring file, as indexed (see [`path_key`]).
    pub file: String,
    /// The position in the file summary's `class_likes`, `functions` or
    /// `constants` (0 for namespaces).
    pub index: u32,
}

impl Decl {
    /// The short name: the part after the last `\`.
    pub fn short_name(&self) -> &str {
        short_name(&self.fqn)
    }

    /// The declaring file, with the platform's separators.
    pub fn path(&self) -> PathBuf {
        key_path(&self.file)
    }
}

/// What the index knows about one file.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRecord {
    /// blake3 of the content.
    pub hash: [u8; 32],
    /// Modification time in nanoseconds since the Unix epoch.
    pub mtime: u64,
    pub size: u64,
}

/// What one [`PhpIndex::sync`] or [`PhpIndex::update`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IndexStats {
    /// Files parsed.
    pub parsed: usize,
    /// Files with new content whose summary was already stored.
    pub reused: usize,
    /// Files read again whose content hash had not changed.
    pub rehashed: usize,
    /// Files skipped because their mtime and size had not changed.
    pub unchanged: usize,
    /// Files removed from the index (deleted, unreadable or no longer
    /// listed).
    pub removed: usize,
}

/// The persistent PHP indexes of one project.
pub struct PhpIndex {
    db: Database,
    persistent: bool,
}

impl PhpIndex {
    /// Opens (or creates) `cache_dir/php-index.redb`. A database with another
    /// schema stamp is cleared. When the file can't be used, the index runs
    /// in memory.
    pub fn open(cache_dir: &Path) -> IdeResult<Self> {
        let db = match open_file(cache_dir) {
            Some(db) => Self { db, persistent: true },
            None => return Self::in_memory(),
        };
        db.check_stamp()?;
        Ok(db)
    }

    /// An index that is never written to disk.
    pub fn in_memory() -> IdeResult<Self> {
        let db = Database::builder().create_with_backend(InMemoryBackend::new()).map_err(internal)?;
        let index = Self { db, persistent: false };
        index.check_stamp()?;
        Ok(index)
    }

    /// Whether the index is stored on disk.
    pub fn is_persistent(&self) -> bool {
        self.persistent
    }

    fn check_stamp(&self) -> IdeResult<()> {
        let stamp = stamp();
        let current = {
            let txn = self.db.begin_read().map_err(internal)?;
            match txn.open_table(META) {
                Ok(table) => table.get("stamp").map_err(internal)?.map(|v| v.value().to_vec()),
                Err(TableError::TableDoesNotExist(_)) => None,
                Err(e) => return Err(internal(e)),
            }
        };
        if current.as_deref() == Some(stamp.as_bytes()) {
            return Ok(());
        }
        let txn = self.db.begin_write().map_err(internal)?;
        clear(&txn).map_err(internal)?;
        txn.open_table(META).map_err(internal)?.insert("stamp", stamp.as_bytes()).map_err(internal)?;
        txn.commit().map_err(internal)
    }

    // ------------------------------------------------------------- updates

    /// Makes the index match `files`, the complete list of PHP files of the
    /// project: files no longer listed are removed, new and changed ones are
    /// indexed, unchanged ones are left alone.
    pub fn sync(&self, files: &[PathBuf], cancel: &CancellationToken) -> IdeResult<IndexStats> {
        let listed: HashSet<String> = files.iter().map(|p| path_key(p)).collect();
        let stale: Vec<String> = self.file_keys()?.into_iter().filter(|k| !listed.contains(k)).collect();
        let mut stats = IndexStats::default();
        self.remove_keys(&stale, &mut stats)?;
        self.index_paths(files, cancel, &mut stats)?;
        Ok(stats)
    }

    /// Applies a watcher batch: `changed` files are indexed again when their
    /// content changed (or dropped when they can't be read any more), and
    /// `removed` ones are dropped.
    pub fn update(
        &self,
        changed: &[PathBuf],
        removed: &[PathBuf],
        cancel: &CancellationToken,
    ) -> IdeResult<IndexStats> {
        let mut stats = IndexStats::default();
        let removed: Vec<String> = removed.iter().map(|p| path_key(p)).collect();
        self.remove_keys(&removed, &mut stats)?;
        self.index_paths(changed, cancel, &mut stats)?;
        Ok(stats)
    }

    fn remove_keys(&self, keys: &[String], stats: &mut IndexStats) -> IdeResult<()> {
        if keys.is_empty() {
            return Ok(());
        }
        let txn = self.db.begin_write().map_err(internal)?;
        {
            let mut w = Writer::open(&txn).map_err(internal)?;
            for key in keys {
                if w.remove_file(key).map_err(internal)? {
                    stats.removed += 1;
                }
            }
        }
        txn.commit().map_err(internal)
    }

    fn index_paths(&self, paths: &[PathBuf], cancel: &CancellationToken, stats: &mut IndexStats) -> IdeResult<()> {
        let mut seen = HashSet::new();
        let paths: Vec<(&PathBuf, String)> =
            paths.iter().map(|p| (p, path_key(p))).filter(|(_, key)| seen.insert(key.clone())).collect();
        if paths.is_empty() {
            return Ok(());
        }
        let mut known = self.known_hashes()?;
        for chunk in paths.chunks(CHUNK) {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let previous = self.records(chunk.iter().map(|(_, key)| key.as_str()))?;
            let scanned: Vec<(&str, Scanned)> = chunk
                .par_iter()
                .map(|(path, key)| {
                    let scanned = if cancel.is_cancelled() {
                        Scanned::Skipped
                    } else {
                        scan(path, key, previous.get(key.as_str()), &known)
                    };
                    (key.as_str(), scanned)
                })
                .collect();
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let mut txn = self.db.begin_write().map_err(internal)?;
            // Chunk commits skip the fsync; the last one below makes them durable.
            txn.set_durability(Durability::None).map_err(internal)?;
            {
                let mut w = Writer::open(&txn).map_err(internal)?;
                for (key, scanned) in scanned {
                    match scanned {
                        Scanned::Skipped => {}
                        Scanned::Unchanged => stats.unchanged += 1,
                        Scanned::Gone => {
                            if w.remove_file(key).map_err(internal)? {
                                stats.removed += 1;
                            }
                        }
                        Scanned::Rehashed(record) => {
                            w.put_record(key, &record).map_err(internal)?;
                            stats.rehashed += 1;
                        }
                        Scanned::Reused(record) => {
                            w.set_file(key, record, None).map_err(internal)?;
                            stats.reused += 1;
                        }
                        Scanned::Parsed(record, summary, words) => {
                            w.set_file(key, record, Some((&summary, &words))).map_err(internal)?;
                            known.insert(record.hash);
                            stats.parsed += 1;
                        }
                    }
                }
            }
            txn.commit().map_err(internal)?;
        }
        // An empty durable commit persists the non-durable ones before it.
        let txn = self.db.begin_write().map_err(internal)?;
        txn.commit().map_err(internal)
    }

    fn known_hashes(&self) -> IdeResult<HashSet<[u8; 32]>> {
        let txn = self.db.begin_read().map_err(internal)?;
        let table = match txn.open_table(REFS) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(HashSet::new()),
            Err(e) => return Err(internal(e)),
        };
        let mut out = HashSet::new();
        for item in table.iter().map_err(internal)? {
            out.insert(item.map_err(internal)?.0.value());
        }
        Ok(out)
    }

    fn records<'a>(&self, keys: impl Iterator<Item = &'a str>) -> IdeResult<HashMap<String, FileRecord>> {
        let txn = self.db.begin_read().map_err(internal)?;
        let table = match txn.open_table(FILES) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(HashMap::new()),
            Err(e) => return Err(internal(e)),
        };
        let mut out = HashMap::new();
        for key in keys {
            if let Some(record) = table.get(key).map_err(internal)?.and_then(|v| decode_record(v.value())) {
                out.insert(key.to_owned(), record);
            }
        }
        Ok(out)
    }

    // ------------------------------------------------------------- queries

    /// Every indexed file, sorted.
    pub fn files(&self) -> IdeResult<Vec<PathBuf>> {
        Ok(self.file_keys()?.into_iter().map(PathBuf::from).collect())
    }

    fn file_keys(&self) -> IdeResult<Vec<String>> {
        let txn = self.db.begin_read().map_err(internal)?;
        let table = match txn.open_table(FILES) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(Vec::new()),
            Err(e) => return Err(internal(e)),
        };
        let mut out = Vec::new();
        for item in table.iter().map_err(internal)? {
            out.push(item.map_err(internal)?.0.value().to_owned());
        }
        Ok(out)
    }

    /// How many files and declarations (class-likes, functions and
    /// constants, counting each declaring file) the index holds.
    pub fn counts(&self) -> IdeResult<(u64, u64)> {
        let txn = self.db.begin_read().map_err(internal)?;
        let files = match txn.open_table(FILES) {
            Ok(t) => t.len().map_err(internal)?,
            Err(TableError::TableDoesNotExist(_)) => 0,
            Err(e) => return Err(internal(e)),
        };
        let decls = match txn.open_multimap_table(FQNS) {
            Ok(t) => t.len().map_err(internal)?,
            Err(TableError::TableDoesNotExist(_)) => 0,
            Err(e) => return Err(internal(e)),
        };
        Ok((files, decls))
    }

    /// The stored record of a file.
    pub fn record(&self, path: &Path) -> IdeResult<Option<FileRecord>> {
        let key = path_key(path);
        Ok(self.records(std::iter::once(key.as_str()))?.remove(&key))
    }

    /// The summary of an indexed file.
    pub fn summary(&self, path: &Path) -> IdeResult<Option<FileSummary>> {
        let Some(record) = self.record(path)? else { return Ok(None) };
        let txn = self.db.begin_read().map_err(internal)?;
        let table = txn.open_table(SUMMARIES).map_err(internal)?;
        let Some(bytes) = table.get(record.hash).map_err(internal)? else { return Ok(None) };
        Ok(FileSummary::from_bytes(bytes.value()).ok())
    }

    /// The declarations of a fully qualified name (with or without the
    /// leading `\`). Class-like and function names match case-insensitively,
    /// constants by the exact case of their last segment. Sorted by file.
    pub fn declarations(&self, kind: NameKind, fqn: &str) -> IdeResult<Vec<Decl>> {
        let Some(key) = fqn_key(kind, fqn) else { return Ok(Vec::new()) };
        self.multimap(FQNS, &key)
    }

    /// Every declaration whose short name matches `name` case-insensitively,
    /// namespaces excluded.
    pub fn by_short_name(&self, name: &str) -> IdeResult<Vec<Decl>> {
        self.multimap(SHORT_NAMES, &name.to_ascii_lowercase())
    }

    /// Every distinct lower-case short name in the index (for fuzzy symbol
    /// search: score the keys, then look up the few that match with
    /// [`by_short_name`](Self::by_short_name)). Sorted.
    pub fn short_names(&self, cancel: &CancellationToken) -> IdeResult<Vec<String>> {
        let txn = self.db.begin_read().map_err(internal)?;
        let table = match txn.open_multimap_table(SHORT_NAMES) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(Vec::new()),
            Err(e) => return Err(internal(e)),
        };
        let mut out = Vec::new();
        for (i, item) in table.iter().map_err(internal)?.enumerate() {
            if i % 4096 == 0 && cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            out.push(item.map_err(internal)?.0.value().to_owned());
        }
        Ok(out)
    }

    /// The class-likes that directly extend or implement `fqn`.
    pub fn direct_subclasses(&self, fqn: &str) -> IdeResult<Vec<Decl>> {
        self.multimap(SUBCLASSES, &trim_fqn(fqn).to_ascii_lowercase())
    }

    /// The declarations and child namespaces directly inside namespace `ns`
    /// (`""` for the global namespace). A child namespace is listed once,
    /// whichever files contribute to it.
    pub fn namespace_children(&self, ns: &str) -> IdeResult<Vec<Decl>> {
        let mut out = self.multimap(NAMESPACES, &trim_fqn(ns).to_ascii_lowercase())?;
        let mut namespaces = HashSet::new();
        out.retain(|d| d.kind != DeclKind::Namespace || namespaces.insert(d.fqn.to_ascii_lowercase()));
        Ok(out)
    }

    /// The indexed files containing `word` (an identifier, compared
    /// case-insensitively) anywhere in their text, sorted.
    pub fn files_with_word(&self, word: &str) -> IdeResult<Vec<PathBuf>> {
        let txn = self.db.begin_read().map_err(internal)?;
        let words = match txn.open_multimap_table(WORDS) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(Vec::new()),
            Err(e) => return Err(internal(e)),
        };
        let ids = txn.open_table(FILE_IDS).map_err(internal)?;
        let mut out = Vec::new();
        for id in words.get(word.to_ascii_lowercase().as_str()).map_err(internal)? {
            if let Some(key) = ids.get(id.map_err(internal)?.value()).map_err(internal)? {
                out.push(key_path(key.value()));
            }
        }
        out.sort();
        Ok(out)
    }

    /// The files with `.phpstorm.meta.php` directives, sorted.
    pub fn meta_files(&self) -> IdeResult<Vec<PathBuf>> {
        Ok(self.multimap(META_FILES, META_FILES_KEY)?.iter().map(Decl::path).collect())
    }

    /// The files with Laravel bindings, migrations or casts, sorted.
    pub fn laravel_files(&self) -> IdeResult<Vec<PathBuf>> {
        Ok(self.multimap(META_FILES, LARAVEL_FILES_KEY)?.iter().map(Decl::path).collect())
    }

    fn multimap(&self, def: MultiDef, key: &str) -> IdeResult<Vec<Decl>> {
        let txn = self.db.begin_read().map_err(internal)?;
        let table = match txn.open_multimap_table(def) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(Vec::new()),
            Err(e) => return Err(internal(e)),
        };
        let mut out = Vec::new();
        for value in table.get(key).map_err(internal)? {
            if let Ok(decl) = postcard::from_bytes::<Decl>(value.map_err(internal)?.value()) {
                out.push(decl);
            }
        }
        out.sort_by(|a, b| (&a.file, a.kind, a.index, &a.fqn).cmp(&(&b.file, b.kind, b.index, &b.fqn)));
        Ok(out)
    }
}

/// The result of reading one file.
enum Scanned {
    /// Cancelled before the file was looked at.
    Skipped,
    /// Same mtime and size as the stored record.
    Unchanged,
    /// Missing or unreadable.
    Gone,
    /// Read again, same content.
    Rehashed(FileRecord),
    /// New content whose summary is already stored.
    Reused(FileRecord),
    Parsed(FileRecord, Box<FileSummary>, Vec<String>),
}

fn scan(path: &Path, key: &str, previous: Option<&FileRecord>, known: &HashSet<[u8; 32]>) -> Scanned {
    let Ok(meta) = std::fs::metadata(path) else { return Scanned::Gone };
    if !meta.is_file() {
        return Scanned::Gone;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos().min(u64::MAX as u128) as u64);
    let size = meta.len();
    if let Some(prev) = previous
        && prev.mtime == mtime
        && prev.size == size
        && mtime != 0
    {
        return Scanned::Unchanged;
    }
    let Ok(bytes) = std::fs::read(path) else { return Scanned::Gone };
    let record = FileRecord { hash: *blake3::hash(&bytes).as_bytes(), mtime, size: bytes.len() as u64 };
    if previous.is_some_and(|prev| prev.hash == record.hash) {
        return Scanned::Rehashed(record);
    }
    if known.contains(&record.hash) {
        return Scanned::Reused(record);
    }
    let text = String::from_utf8_lossy(&bytes);
    let parsed = ParsedFile::parse(key, text.as_ref());
    Scanned::Parsed(record, Box::new(FileSummary::extract(&parsed)), words(text.as_ref()))
}

fn open_file(cache_dir: &Path) -> Option<Database> {
    if let Err(e) = std::fs::create_dir_all(cache_dir) {
        tracing::warn!("php index {}: {e}; indexing in memory", cache_dir.display());
        return None;
    }
    let file = cache_dir.join(FILE_NAME);
    match Database::create(&file) {
        Ok(db) => Some(db),
        Err(redb::DatabaseError::DatabaseAlreadyOpen) => {
            tracing::warn!("php index {} is in use; indexing in memory", file.display());
            None
        }
        Err(e) => {
            tracing::warn!("php index {} unreadable ({e}); rebuilding", file.display());
            let _ = std::fs::remove_file(&file);
            Database::create(&file).map_err(|e| tracing::warn!("php index: {e}; indexing in memory")).ok()
        }
    }
}

fn stamp() -> String {
    format!("ide-php-index {INDEX_SCHEMA} summary {SCHEMA_VERSION}")
}

fn internal(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(format!("php index: {e}"))
}

/// The key a path is stored under: the path as given, with `/` separators on
/// Windows so `C:\a\b.php` and `C:/a/b.php` are the same file.
pub fn path_key(path: &Path) -> String {
    let key = path.to_string_lossy();
    if cfg!(windows) { key.replace('\\', "/") } else { key.into_owned() }
}

/// The path a [`path_key`] stands for, with the platform's separators.
pub fn key_path(key: &str) -> PathBuf {
    if cfg!(windows) { PathBuf::from(key.replace('/', "\\")) } else { PathBuf::from(key) }
}

fn trim_fqn(fqn: &str) -> &str {
    fqn.strip_prefix('\\').unwrap_or(fqn)
}

fn short_name(fqn: &str) -> &str {
    fqn.rsplit_once('\\').map_or(fqn, |(_, name)| name)
}

fn namespace_of(fqn: &str) -> &str {
    fqn.rsplit_once('\\').map_or("", |(ns, _)| ns)
}

/// The key of a name in the `fqns` table: a kind tag, then the name with
/// the case-insensitive parts lower-cased.
fn fqn_key(kind: NameKind, fqn: &str) -> Option<String> {
    let fqn = trim_fqn(fqn);
    Some(match kind {
        NameKind::ClassLike => format!("c:{}", fqn.to_ascii_lowercase()),
        NameKind::Function => format!("f:{}", fqn.to_ascii_lowercase()),
        NameKind::Constant => match fqn.rsplit_once('\\') {
            Some((ns, name)) => format!("k:{}\\{name}", ns.to_ascii_lowercase()),
            None => format!("k:{fqn}"),
        },
        NameKind::Namespace => return None,
    })
}
