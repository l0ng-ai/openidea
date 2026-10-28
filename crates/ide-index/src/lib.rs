//! Background project index (files + symbols).
//!
//! Indexing never blocks the UI: queries answer from whatever is indexed so far
//! and `IdeEvent::IndexState` tells the UI when it is complete ("dumb mode").

use ide_core::{IdeResult, MatchIndices, Range, SharedSink, SymbolKind};
use ide_language::{LanguageRegistry, Syntax};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use std::time::Duration;

mod data;
mod filter;
mod matching;
mod store;
mod worker;

pub use worker::MAX_SYMBOL_FILE;
use worker::{Job, MAX_RECENT, Shared};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub path: ide_core::IpcPath,
    /// Path relative to the project root, as displayed.
    pub rel_path: String,
    pub score: u32,
    /// Matched char indices within `rel_path`.
    pub indices: MatchIndices,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMatch {
    pub name: String,
    pub kind: SymbolKind,
    pub container: Option<String>,
    pub path: ide_core::IpcPath,
    pub rel_path: String,
    pub range: Range,
    pub score: u32,
    /// Matched char indices within `name`.
    pub indices: MatchIndices,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SymbolFilter {
    All,
    /// Go to Class (⌘O): classes, interfaces, structs, enums, traits, type aliases.
    Types,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub indexing: bool,
    pub files: u32,
    pub symbols: u32,
}

pub struct ProjectIndex {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
    root: PathBuf,
}

impl ProjectIndex {
    /// Opens (or creates) the persistent index at `cache_dir` and starts a
    /// background full scan that skips files whose content hash is unchanged.
    /// `content_roots` are folders outside `root` indexed with it (not persisted).
    pub fn open(
        root: &Path,
        cache_dir: &Path,
        content_roots: Vec<PathBuf>,
        excludes: Vec<String>,
        languages: Arc<LanguageRegistry>,
        syntax: Arc<Syntax>,
        sink: SharedSink,
    ) -> IdeResult<Arc<Self>> {
        let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_owned());
        if !root.is_dir() {
            return Err(ide_core::IdeError::not_found(format!("{} is not a directory", root.display())));
        }
        let store = store::Store::open(cache_dir, &root, &syntax.fingerprint());
        let filter = filter::PathFilter::new(&root, &content_roots, &excludes);
        let shared = Arc::new(Shared::new(filter, languages, syntax, sink, store));
        Self::start(shared, root, true)
    }

    /// An index that never scans or persists anything (a window editing loose
    /// files): queries answer empty, recent files are kept in memory only.
    pub fn unindexed(
        root: &Path,
        languages: Arc<LanguageRegistry>,
        syntax: Arc<Syntax>,
        sink: SharedSink,
    ) -> IdeResult<Arc<Self>> {
        let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_owned());
        let filter = filter::PathFilter::new(&root, &[], &[]);
        let shared = Arc::new(Shared::new(filter, languages, syntax, sink, None));
        Self::start(shared, root, false)
    }

    fn start(shared: Arc<Shared>, root: PathBuf, scan: bool) -> IdeResult<Arc<Self>> {
        let worker = {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("openidea-index".into())
                .spawn(move || shared.run(scan))
                .map_err(|e| ide_core::IdeError::internal(format!("cannot start indexer: {e}")))?
        };
        Ok(Arc::new(Self { shared, worker: Mutex::new(Some(worker)), root }))
    }

    /// Changes what is indexed besides the root (content roots) and the exclude
    /// globs, rescanning in the background (unchanged files are not re-read).
    /// Returns whether anything changed.
    pub fn set_scope(&self, content_roots: Vec<PathBuf>, excludes: Vec<String>) -> bool {
        if self.shared.filter().same_config(&content_roots, &excludes) {
            return false;
        }
        self.shared.set_filter(filter::PathFilter::new(&self.root, &content_roots, &excludes));
        self.shared.enqueue(Job::Rescan);
        true
    }

    /// File types changed (the registry the index shares was updated): re-parses
    /// the files whose language under `before` differs from the current one.
    pub fn languages_changed(&self, before: Arc<LanguageRegistry>) {
        self.shared.enqueue(Job::Reparse(before));
    }

    pub fn status(&self) -> IndexStatus {
        let d = self.shared.data.read();
        IndexStatus {
            indexing: self.shared.indexing.load(Ordering::SeqCst),
            files: d.file_count,
            symbols: d.symbol_count,
        }
    }

    /// Fuzzy file search. IDEA-like ranking: file-name matches beat directory
    /// matches; `/` in the query matches path segments; recently opened files boost.
    pub fn find_files(&self, query: &str, limit: usize) -> Vec<FileMatch> {
        let recent = self.shared.recent.lock().clone();
        let d = self.shared.data.read();
        matching::find_files(&d, &matching::Recents { paths: &recent }, query, limit)
    }

    /// Fuzzy symbol search; CamelHump aware (`OCo` → `OrderController`).
    pub fn find_symbols(&self, query: &str, filter: SymbolFilter, limit: usize) -> Vec<SymbolMatch> {
        let recent = self.shared.recent.lock().clone();
        let d = self.shared.data.read();
        matching::find_symbols(&d, &matching::Recents { paths: &recent }, query, filter, limit)
    }

    /// Symbols named exactly `name` (of `kind`, if given): `.card` selectors for `class="card"`.
    pub fn symbols_named(&self, name: &str, kind: Option<SymbolKind>, limit: usize) -> Vec<SymbolMatch> {
        matching::symbols_named(&self.shared.data.read(), name, kind, limit)
    }

    /// Incrementally re-indexes changed paths (called from the vfs watcher).
    /// Cheap: the work is queued for the indexing thread.
    pub fn update(&self, changed: &[PathBuf], removed: &[PathBuf]) {
        let changed: Vec<PathBuf> = changed.iter().filter_map(|p| self.normalize(p)).collect();
        let removed: Vec<PathBuf> = removed.iter().filter_map(|p| self.normalize(p)).collect();
        if !removed.is_empty() {
            self.shared.enqueue(Job::Removed(removed));
        }
        if !changed.is_empty() {
            self.shared.enqueue(Job::Changed(changed));
        }
    }

    /// Boost for "recent files" ranking.
    /// Records a recently opened file; a virtual document's URI (library
    /// class) is kept verbatim, like IDEA lists library classes in Recent Files.
    pub fn mark_recent(&self, path: &Path) {
        let path = match path.to_str() {
            Some(s) if ide_core::text::is_virtual_uri(s) => path.to_owned(),
            _ => match self.normalize(path) {
                Some(p) => p,
                None => return,
            },
        };
        {
            let mut r = self.shared.recent.lock();
            r.retain(|p| p != &path);
            r.insert(0, path);
            r.truncate(MAX_RECENT);
        }
        self.shared.enqueue(Job::SaveRecent);
    }

    /// Drops a file from Recent Files (Delete in the ⌘E popup).
    pub fn remove_recent(&self, path: &Path) {
        let path = match path.to_str() {
            Some(s) if ide_core::text::is_virtual_uri(s) => path.to_owned(),
            _ => match self.normalize(path) {
                Some(p) => p,
                None => return,
            },
        };
        {
            let mut r = self.shared.recent.lock();
            let before = r.len();
            r.retain(|p| p != &path);
            if r.len() == before {
                return;
            }
        }
        self.shared.enqueue(Job::SaveRecent);
    }

    /// Recently opened files, most recent first; files deleted since (also while
    /// the IDE was closed) are left out. Virtual documents are always listed.
    pub fn recent_files(&self) -> Vec<PathBuf> {
        let recent = self.shared.recent.lock().clone();
        recent.into_iter().filter(|p| p.to_str().is_some_and(ide_core::text::is_virtual_uri) || p.exists()).collect()
    }

    /// Blocks until the initial scan and every queued update has been applied
    /// (tests, benchmarks, headless tools). Returns `false` on timeout.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        self.shared.wait_idle(timeout)
    }

    /// Releases spare memory and compacts the on-disk cache ("Clear caches").
    /// Blocking; call off the UI thread.
    pub fn compact(&self) {
        self.shared.data.write().shrink();
        if let Some(store) = &self.shared.store
            && let Err(e) = store.compact()
        {
            tracing::debug!("index compact: {e}");
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Absolute path inside the root (or a content root), or `None` for paths outside the project.
    fn normalize(&self, path: &Path) -> Option<PathBuf> {
        let filter = self.shared.filter();
        let root = &self.root;
        let path = if path.is_absolute() { path.to_owned() } else { root.join(path) };
        let path = if filter.contains(&path) {
            path
        } else {
            // Watchers / the UI may report non-canonical spellings (`/tmp` vs `/private/tmp`).
            match dunce::canonicalize(&path) {
                Ok(p) => p,
                Err(_) => {
                    let parent = dunce::canonicalize(path.parent()?).ok()?;
                    parent.join(path.file_name()?)
                }
            }
        };
        (filter.contains(&path) && filter.rel(&path).is_some()).then_some(path)
    }
}

impl Drop for ProjectIndex {
    fn drop(&mut self) {
        self.shared.cancel();
        if let Some(handle) = self.worker.lock().take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests;

/// Synthetic in-memory index for benchmarks (`benches/index.rs`); not a stable API.
#[doc(hidden)]
pub mod bench_support {
    use super::*;
    use crate::data::{FileEntry, FileRecord, IndexData, StoredSymbol};

    pub struct SyntheticIndex {
        data: IndexData,
        recent: Vec<PathBuf>,
    }

    const DIRS: &[&str] = &["src", "lib", "app", "core", "ui", "server", "client", "util", "test", "model"];
    const WORDS: &[&str] = &[
        "order", "user", "account", "payment", "invoice", "session", "cache", "event", "report", "search", "index",
        "query", "parser", "token", "render", "layout", "widget", "store", "action", "service",
    ];
    const SUFFIX: &[&str] = &["Controller", "Service", "Repository", "Factory", "Handler", "View", "Model", "Util"];

    impl SyntheticIndex {
        /// `files` files spread over nested directories, each with `symbols_per_file` symbols.
        pub fn new(files: usize, symbols_per_file: usize) -> Self {
            let mut data = IndexData::default();
            let mut seed = 0x9E37_79B9_7F4A_7C15u64;
            let mut next = |n: usize| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                (seed % n as u64) as usize
            };
            for i in 0..files {
                let depth = 1 + next(4);
                let mut rel = String::new();
                for _ in 0..depth {
                    rel.push_str(DIRS[next(DIRS.len())]);
                    rel.push('/');
                }
                let w = WORDS[next(WORDS.len())];
                let s = SUFFIX[next(SUFFIX.len())];
                rel.push_str(&format!("{w}{s}{i}.rs"));
                let symbols = (0..symbols_per_file)
                    .map(|k| StoredSymbol {
                        name: format!("{}{}{k}", WORDS[next(WORDS.len())], SUFFIX[next(SUFFIX.len())]),
                        kind: if k % 3 == 0 { SymbolKind::Class } else { SymbolKind::Method },
                        container: (k % 3 != 0).then(|| format!("{w}{s}")),
                        range: Range::default(),
                    })
                    .collect();
                let record = FileRecord { symbols, ..Default::default() };
                data.insert(FileEntry::new(PathBuf::from("/bench").join(&rel), rel, record));
            }
            let recent = data.paths().take(MAX_RECENT).cloned().collect();
            Self { data, recent }
        }

        pub fn file_count(&self) -> u32 {
            self.data.file_count
        }

        pub fn symbol_count(&self) -> u32 {
            self.data.symbol_count
        }

        pub fn find_files(&self, query: &str, limit: usize) -> Vec<FileMatch> {
            matching::find_files(&self.data, &matching::Recents { paths: &self.recent }, query, limit)
        }

        pub fn find_symbols(&self, query: &str, filter: SymbolFilter, limit: usize) -> Vec<SymbolMatch> {
            matching::find_symbols(&self.data, &matching::Recents { paths: &self.recent }, query, filter, limit)
        }
    }
}
