//! The background indexing thread: initial load + full scan, then incremental
//! updates queued by the watcher.

use crate::data::{FileEntry, FileRecord, IndexData, StoredSymbol};
use crate::filter::{Found, PathFilter};
use crate::store::Store;
use ide_core::{IdeEvent, SharedSink, TaskId};
use ide_language::{LanguageRegistry, Syntax};
use parking_lot::{Condvar, Mutex, RwLock};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Files larger than this are listed but not parsed for symbols.
pub const MAX_SYMBOL_FILE: u64 = 2 * 1024 * 1024;
const CHUNK: usize = 512;
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
pub(crate) const MAX_RECENT: usize = 50;

pub(crate) enum Job {
    Changed(Vec<PathBuf>),
    Removed(Vec<PathBuf>),
    SaveRecent,
    /// The roots or excludes changed: scan again (unchanged files are kept).
    Rescan,
    IgnoreRules(Vec<PathBuf>),
    /// File types changed: re-parse the indexed files whose language under the
    /// previous registry differs from the current one.
    Reparse(std::sync::Arc<LanguageRegistry>),
}

#[derive(Default)]
struct Queue {
    jobs: VecDeque<Job>,
    busy: bool,
    started: bool,
}

pub(crate) struct Shared {
    filter: RwLock<std::sync::Arc<PathFilter>>,
    pub languages: std::sync::Arc<LanguageRegistry>,
    pub syntax: std::sync::Arc<Syntax>,
    pub sink: SharedSink,
    pub data: RwLock<IndexData>,
    /// Most recent first.
    pub recent: Mutex<Vec<PathBuf>>,
    pub store: Option<Store>,
    pub indexing: AtomicBool,
    pub cancelled: AtomicBool,
    /// Non-cached content reads, including binary/unsupported files; used by tests.
    pub parsed: std::sync::atomic::AtomicUsize,
    queue: Mutex<Queue>,
    wake: Condvar,
    idle: Condvar,
}

impl Shared {
    pub(crate) fn new(
        filter: PathFilter,
        languages: std::sync::Arc<LanguageRegistry>,
        syntax: std::sync::Arc<Syntax>,
        sink: SharedSink,
        store: Option<Store>,
    ) -> Self {
        Self {
            filter: RwLock::new(std::sync::Arc::new(filter)),
            languages,
            syntax,
            sink,
            data: RwLock::default(),
            recent: Mutex::default(),
            store,
            indexing: AtomicBool::new(true),
            cancelled: AtomicBool::new(false),
            parsed: Default::default(),
            queue: Mutex::default(),
            wake: Condvar::new(),
            idle: Condvar::new(),
        }
    }

    pub(crate) fn filter(&self) -> std::sync::Arc<PathFilter> {
        self.filter.read().clone()
    }

    pub(crate) fn set_filter(&self, filter: PathFilter) {
        *self.filter.write() = std::sync::Arc::new(filter);
    }

    pub(crate) fn enqueue(&self, job: Job) {
        self.queue.lock().jobs.push_back(job);
        self.wake.notify_one();
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let _q = self.queue.lock();
        self.wake.notify_all();
        self.idle.notify_all();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Blocks until the initial scan and all queued updates are done.
    pub(crate) fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut q = self.queue.lock();
        while !(q.started && !q.busy && q.jobs.is_empty()) {
            if self.is_cancelled() || self.idle.wait_until(&mut q, deadline).timed_out() {
                return q.started && !q.busy && q.jobs.is_empty();
            }
        }
        true
    }

    fn emit_state(&self) {
        let (files, symbols) = {
            let d = self.data.read();
            (d.file_count, d.symbol_count)
        };
        self.sink.emit(IdeEvent::IndexState { indexing: self.indexing.load(Ordering::SeqCst), files, symbols });
    }

    // ---------------------------------------------------------------- thread

    /// `scan`: load the persisted index and scan the roots before serving updates.
    pub(crate) fn run(&self, scan: bool) {
        {
            let mut q = self.queue.lock();
            q.busy = true;
        }
        if scan {
            self.load_persisted();
            self.full_scan();
        } else {
            self.indexing.store(false, Ordering::SeqCst);
        }
        {
            let mut q = self.queue.lock();
            q.busy = false;
            q.started = true;
            self.idle.notify_all();
        }
        loop {
            let jobs: Vec<Job> = {
                let mut q = self.queue.lock();
                while q.jobs.is_empty() && !self.is_cancelled() {
                    self.wake.wait(&mut q);
                }
                if self.is_cancelled() {
                    return;
                }
                q.busy = true;
                q.jobs.drain(..).collect()
            };
            self.process(jobs);
            let mut q = self.queue.lock();
            q.busy = false;
            if q.jobs.is_empty() {
                self.idle.notify_all();
            }
        }
    }

    fn load_persisted(&self) {
        let Some(store) = &self.store else { return };
        let filter = self.filter();
        let root = filter.root().to_owned();
        match store.load() {
            Ok(records) => {
                let entries: Vec<(FileEntry, Vec<StoredSymbol>)> = records
                    .into_par_iter()
                    .filter(|(rel, _)| {
                        let path = root.join(rel);
                        !filter.is_excluded(&path, false) && dunce::canonicalize(&path).is_ok_and(|real| real == path)
                    })
                    .map(|(rel, rec)| FileEntry::new(root.join(&rel), rel, rec))
                    .collect();
                let mut d = self.data.write();
                for (e, symbols) in entries {
                    d.insert(e, symbols);
                }
            }
            Err(e) => tracing::warn!("index cache load failed: {e}"),
        }
        let recent: Vec<PathBuf> = store.load_recent().into_iter().map(|rel| root.join(rel)).collect();
        let mut r = self.recent.lock();
        for p in recent {
            if !r.contains(&p) {
                r.push(p);
            }
        }
        r.truncate(MAX_RECENT);
    }

    /// A cancelled scan (project closed) still ends its progress task and the indexing state.
    fn end_scan(&self, task: TaskId) {
        self.indexing.store(false, Ordering::SeqCst);
        self.sink.emit(IdeEvent::Task {
            id: task,
            title: "Indexing".into(),
            message: None,
            fraction: None,
            done: true,
            cancellable: false,
        });
        self.emit_state();
    }

    fn full_scan(&self) {
        self.scan(None);
    }

    fn scan(&self, dirs: Option<&[PathBuf]>) -> Option<ScanCounts> {
        let started = Instant::now();
        self.indexing.store(true, Ordering::SeqCst);
        self.emit_state();
        let task = TaskId::next();
        self.sink.emit(IdeEvent::Task {
            id: task,
            title: "Indexing".into(),
            message: Some("Scanning files…".into()),
            fraction: None,
            done: false,
            cancellable: false,
        });

        let filter = self.filter();
        let mut found = Vec::new();
        let roots: Vec<&Path> = match dirs {
            Some(dirs) => dirs.iter().map(PathBuf::as_path).collect(),
            None => filter.roots().collect(),
        };
        let walk_started = Instant::now();
        for root in roots {
            found.extend(filter.walk(root, &self.cancelled));
        }
        let walk_elapsed = walk_started.elapsed();
        if self.is_cancelled() {
            self.end_scan(task);
            return None;
        }
        let reconcile_started = Instant::now();
        let seen: HashSet<&Path> = found.iter().map(|f| f.path.as_path()).collect();
        let (todo, stale): (Vec<&Found>, Vec<PathBuf>) = {
            let d = self.data.read();
            let todo = found.iter().filter(|f| d.get(&f.path).is_none_or(|e| e.stale_for(f))).collect();
            let stale = d
                .paths()
                .filter(|p| dirs.is_none_or(|dirs| dirs.iter().any(|dir| p.starts_with(dir))))
                .filter(|p| !seen.contains(p.as_path()))
                .cloned()
                .collect();
            (todo, stale)
        };
        if !stale.is_empty() {
            let mut d = self.data.write();
            for path in &stale {
                d.remove(path);
            }
        }
        let stale: Vec<String> = stale.iter().filter_map(|p| filter.store_key(p)).collect();
        self.persist(&[], &stale, false);

        let reconcile_elapsed = reconcile_started.elapsed();
        let update_started = Instant::now();
        let mut outcomes = ExtractionCounts::default();
        let total = todo.len();
        let mut done = 0usize;
        let mut last_progress = Instant::now();
        for chunk in todo.chunks(CHUNK) {
            if self.is_cancelled() {
                self.end_scan(task);
                return None;
            }
            outcomes.add(self.index_files(chunk.iter().copied(), false));
            done += chunk.len();
            if last_progress.elapsed() >= PROGRESS_EVERY {
                last_progress = Instant::now();
                self.sink.emit(IdeEvent::Task {
                    id: task,
                    title: "Indexing".into(),
                    message: Some(format!("{done} / {total} files")),
                    fraction: Some(done as f32 / total.max(1) as f32),
                    done: false,
                    cancellable: false,
                });
            }
        }
        if self.is_cancelled() {
            self.end_scan(task);
            return None;
        }
        self.persist(&[], &[], true);
        let update_elapsed = update_started.elapsed();
        self.indexing.store(false, Ordering::SeqCst);
        self.sink.emit(IdeEvent::Task {
            id: task,
            title: "Indexing".into(),
            message: None,
            fraction: Some(1.0),
            done: true,
            cancellable: false,
        });
        self.emit_state();
        let counts =
            ScanCounts { discovered: found.len(), metadata_reused: found.len() - total, scheduled: total, outcomes };
        let outcomes = &counts.outcomes;
        let d = self.data.read();
        tracing::info!(
            scope = if dirs.is_some() { "subtree" } else { "full" },
            files = d.file_count,
            symbols = d.symbol_count,
            discovered = counts.discovered,
            metadata_reused = counts.metadata_reused,
            scheduled = counts.scheduled,
            hash_reused = outcomes.hash_reused,
            symbol_extractions = outcomes.symbol_extractions,
            ignored = outcomes.ignored,
            oversized = outcomes.oversized,
            binary = outcomes.binary,
            unsupported = outcomes.unsupported,
            read_failed = outcomes.read_failed,
            not_processed = outcomes.not_processed,
            walk_ms = walk_elapsed.as_millis() as u64,
            reconcile_ms = reconcile_elapsed.as_millis() as u64,
            update_ms = update_elapsed.as_millis() as u64,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "index scan completed"
        );
        Some(counts)
    }

    /// Extracts records in parallel, then publishes them to memory and disk.
    /// `force` re-parses files whose content is unchanged (their language changed).
    fn index_files<'a>(&self, files: impl Iterator<Item = &'a Found>, force: bool) -> ExtractionCounts {
        let files: Vec<&Found> = files.collect();
        let filter = self.filter();
        let extracted: Vec<(String, FileRecord, PathBuf, Extraction)> = files
            .par_iter()
            .filter_map(|f| {
                if self.is_cancelled() {
                    return None;
                }
                let rel = filter.rel(&f.path)?;
                let prev_hash = if force { None } else { self.data.read().get(&f.path).map(|e| e.hash) };
                match self.extract(f, prev_hash) {
                    Extracted::Unchanged => {
                        // Same content, new mtime: keep the symbols, refresh metadata.
                        let mut rec = self.data.read().record_of(&f.path)?;
                        rec.mtime = f.mtime;
                        rec.size = f.size;
                        rec.ignored = f.ignored;
                        Some((rel, rec, f.path.clone(), Extraction::HashReused))
                    }
                    Extracted::New(rec, outcome) => Some((rel, rec, f.path.clone(), outcome)),
                }
            })
            .collect();
        let mut counts = ExtractionCounts { not_processed: files.len() - extracted.len(), ..Default::default() };
        for (_, _, _, outcome) in &extracted {
            counts.record(*outcome);
        }
        if extracted.is_empty() {
            return counts;
        }
        let puts: Vec<(String, FileRecord)> =
            extracted.iter().filter_map(|(_, rec, path, _)| Some((filter.store_key(path)?, rec.clone()))).collect();
        {
            let entries: Vec<(FileEntry, Vec<StoredSymbol>)> =
                extracted.into_iter().map(|(rel, rec, path, _)| FileEntry::new(path, rel, rec)).collect();
            let mut d = self.data.write();
            for (e, symbols) in entries {
                d.insert(e, symbols);
            }
        }
        self.persist(&puts, &[], false);
        counts
    }

    fn persist(&self, puts: &[(String, FileRecord)], deletes: &[String], durable: bool) {
        if let Some(store) = &self.store
            && let Err(e) = store.apply(puts, deletes, durable)
        {
            tracing::warn!("index cache write failed: {e}");
        }
    }

    fn extract(&self, f: &Found, prev_hash: Option<[u8; 32]>) -> Extracted {
        let mut rec = FileRecord { mtime: f.mtime, size: f.size, ignored: f.ignored, ..Default::default() };
        if f.ignored {
            return Extracted::New(rec, Extraction::Ignored);
        }
        if f.size > MAX_SYMBOL_FILE {
            return Extracted::New(rec, Extraction::Oversized);
        }
        let mut bytes = Vec::with_capacity(f.size as usize);
        match std::fs::File::open(&f.path).and_then(|mut file| file.read_to_end(&mut bytes)) {
            Ok(_) => {}
            Err(e) => {
                tracing::debug!("index: cannot read {}: {e}", f.path.display());
                return Extracted::New(rec, Extraction::ReadFailed);
            }
        }
        rec.hash = *blake3::hash(&bytes).as_bytes();
        if prev_hash == Some(rec.hash) {
            return Extracted::Unchanged;
        }
        self.parsed.fetch_add(1, Ordering::Relaxed);
        if bytes[..bytes.len().min(8192)].contains(&0) {
            return Extracted::New(rec, Extraction::Binary);
        }
        let text = String::from_utf8_lossy(&bytes);
        let lang = self.languages.detect(&f.path, Some(first_line(&text)));
        if self.syntax.has_symbols(&lang) {
            rec.symbols = self
                .syntax
                .tags(&lang, &text)
                .into_iter()
                .map(|t| StoredSymbol { name: t.name, kind: t.kind, container: t.container, range: t.range })
                .collect();
            return Extracted::New(rec, Extraction::Symbols);
        }
        Extracted::New(rec, Extraction::Unsupported)
    }

    fn process(&self, jobs: Vec<Job>) {
        let mut changed: Vec<PathBuf> = Vec::new();
        let mut removed: Vec<PathBuf> = Vec::new();
        let mut save_recent = false;
        let mut rescan = false;
        let mut rule_dirs = Vec::new();
        let mut reparse: Vec<std::sync::Arc<LanguageRegistry>> = Vec::new();
        for job in jobs {
            match job {
                Job::Changed(p) => changed.extend(p),
                Job::Removed(p) => removed.extend(p),
                Job::SaveRecent => save_recent = true,
                Job::Rescan => rescan = true,
                Job::IgnoreRules(dirs) => rule_dirs.extend(dirs),
                Job::Reparse(before) => reparse.push(before),
            }
        }
        if !rule_dirs.is_empty() {
            {
                let mut filter = self.filter.write();
                *filter = std::sync::Arc::new(filter.reload());
            }
            rule_dirs.sort();
            rule_dirs.dedup();
            let mut roots: Vec<PathBuf> = Vec::new();
            for dir in rule_dirs {
                if !roots.iter().any(|root| dir.starts_with(root)) {
                    roots.push(dir);
                }
            }
            if !rescan {
                self.scan(Some(&roots));
                changed.retain(|p| !roots.iter().any(|root| p.starts_with(root)));
                removed.retain(|p| !roots.iter().any(|root| p.starts_with(root)));
            }
        }
        if rescan {
            // The scan also picks up whatever `changed` / `removed` reported.
            self.full_scan();
            changed.clear();
            removed.clear();
        }
        let filter = self.filter();
        let mut touched = false;

        // Removals first; a path removed then re-created shows up in `changed` too.
        let mut deletes = Vec::new();
        for path in removed {
            if path.exists() {
                changed.push(path);
                continue;
            }
            let mut d = self.data.write();
            let gone = match d.remove(&path) {
                Some(_) => vec![path],
                None => d.remove_tree(&path),
            };
            deletes.extend(gone.iter().filter_map(|p| filter.store_key(p)));
        }
        if !deletes.is_empty() {
            touched = true;
            self.persist(&[], &deletes, false);
        }

        let mut files: Vec<Found> = Vec::new();
        let mut seen = HashSet::new();
        let mut by_dir: HashMap<PathBuf, HashSet<PathBuf>> = HashMap::new();
        for path in changed {
            // A watcher path may have a symlink ancestor even when its spelling
            // is inside the root. Resolve it on the worker before reading it.
            let Ok(path) = dunce::canonicalize(&path) else { continue };
            if !filter.contains(&path) || !seen.insert(path.clone()) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if filter.is_excluded(&path, meta.is_dir()) {
                continue;
            }
            if meta.is_dir() {
                files.extend(filter.walk(&path, &self.cancelled));
            } else if meta.is_file()
                && let Some(dir) = path.parent()
            {
                by_dir.entry(dir.to_owned()).or_default().insert(path);
            }
        }
        // Listing the folder applies every ignore file (nested, global) to tell ignored files apart.
        for (dir, wanted) in by_dir {
            files.extend(filter.list_dir(&dir).into_iter().filter(|f| wanted.contains(&f.path)));
        }
        let files: Vec<Found> = {
            let d = self.data.read();
            files.into_iter().filter(|f| d.get(&f.path).is_none_or(|e| e.stale_for(f))).collect()
        };
        if !files.is_empty() {
            touched = true;
            for chunk in files.chunks(CHUNK) {
                if self.is_cancelled() {
                    return;
                }
                self.index_files(chunk.iter(), false);
            }
        }
        for before in reparse {
            let affected: Vec<Found> = {
                let d = self.data.read();
                d.paths()
                    .filter(|p| before.detect(p, None) != self.languages.detect(p, None))
                    .filter_map(|p| {
                        let e = d.get(p)?;
                        Some(Found { path: p.clone(), mtime: e.mtime, size: e.size, ignored: e.ignored })
                    })
                    .collect()
            };
            if !affected.is_empty() {
                touched = true;
                for chunk in affected.chunks(CHUNK) {
                    if self.is_cancelled() {
                        return;
                    }
                    self.index_files(chunk.iter(), true);
                }
            }
        }
        if save_recent && let Some(store) = &self.store {
            let rels: Vec<String> = self.recent.lock().iter().filter_map(|p| filter.store_key(p)).collect();
            if let Err(e) = store.save_recent(&rels) {
                tracing::warn!("index cache: saving recent files failed: {e}");
            }
        }
        if touched {
            self.persist(&[], &[], true);
            self.emit_state();
        }
    }
}

/// The first line, capped at 256 bytes (for shebang / `<?xml` detection).
fn first_line(text: &str) -> &str {
    let line = text.lines().next().unwrap_or_default();
    let mut end = line.len().min(256);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    &line[..end]
}

enum Extracted {
    /// Content hash matches the indexed version.
    Unchanged,
    New(FileRecord, Extraction),
}

/// Mutually exclusive outcomes for this batch, not all files in the index. "Symbols"
/// means tags() was called, even when no symbols were found.
#[derive(Clone, Copy)]
enum Extraction {
    HashReused,
    Symbols,
    Ignored,
    Oversized,
    Binary,
    Unsupported,
    ReadFailed,
}

#[derive(Default, Debug, PartialEq, Eq)]
struct ExtractionCounts {
    hash_reused: usize,
    symbol_extractions: usize,
    ignored: usize,
    oversized: usize,
    binary: usize,
    unsupported: usize,
    read_failed: usize,
    /// Cancellation, a changed root configuration, or a concurrently removed entry.
    not_processed: usize,
}

impl ExtractionCounts {
    fn record(&mut self, outcome: Extraction) {
        *match outcome {
            Extraction::HashReused => &mut self.hash_reused,
            Extraction::Symbols => &mut self.symbol_extractions,
            Extraction::Ignored => &mut self.ignored,
            Extraction::Oversized => &mut self.oversized,
            Extraction::Binary => &mut self.binary,
            Extraction::Unsupported => &mut self.unsupported,
            Extraction::ReadFailed => &mut self.read_failed,
        } += 1;
    }

    fn add(&mut self, other: Self) {
        self.hash_reused += other.hash_reused;
        self.symbol_extractions += other.symbol_extractions;
        self.ignored += other.ignored;
        self.oversized += other.oversized;
        self.binary += other.binary;
        self.unsupported += other.unsupported;
        self.read_failed += other.read_failed;
        self.not_processed += other.not_processed;
    }
}

struct ScanCounts {
    /// Files yielded by the filtered walker, not every file on disk.
    discovered: usize,
    /// Metadata matched an in-memory entry (possibly loaded from disk cache).
    metadata_reused: usize,
    scheduled: usize,
    outcomes: ExtractionCounts,
}

#[cfg(test)]
mod metric_tests {
    use super::*;
    use std::sync::Arc;

    fn shared(root: &Path) -> Shared {
        Shared::new(
            PathFilter::new(root, &crate::IndexRoots::from(Vec::new()), &[]),
            Arc::new(LanguageRegistry::load(None).unwrap()),
            Arc::new(Syntax::new()),
            Arc::new(ide_core::NullSink),
            None,
        )
    }

    #[test]
    fn scan_distinguishes_cold_metadata_and_hash_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let path = root.join("main.rs");
        std::fs::write(&path, "fn main() {}\n").unwrap();
        let shared = shared(&root);
        let cold = shared.scan(None).unwrap();
        assert_eq!((cold.discovered, cold.metadata_reused, cold.scheduled), (1, 0, 1));
        assert_eq!(cold.outcomes, ExtractionCounts { symbol_extractions: 1, ..Default::default() });
        let hot = shared.scan(None).unwrap();
        assert_eq!((hot.discovered, hot.metadata_reused, hot.scheduled), (1, 1, 0));
        assert_eq!(hot.outcomes, ExtractionCounts::default());
        // Force a metadata mismatch without a timestamp-resolution-dependent sleep.
        let mut rec = shared.data.read().record_of(&path).unwrap();
        rec.mtime = rec.mtime.wrapping_add(1);
        let (entry, symbols) = FileEntry::new(path.clone(), "main.rs".into(), rec);
        shared.data.write().insert(entry, symbols);
        let touched = shared.scan(None).unwrap();
        assert_eq!((touched.discovered, touched.metadata_reused, touched.scheduled), (1, 0, 1));
        assert_eq!(touched.outcomes, ExtractionCounts { hash_reused: 1, ..Default::default() });
        assert_eq!(shared.data.read().symbol_count, 1);
    }

    #[test]
    fn extraction_outcomes_are_exclusive_and_forced_parsing_is_counted() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let shared = shared(&root);
        let mut found = Vec::new();
        for (name, contents, ignored, size) in [
            ("source.rs", "fn source() {}", false, 14),
            ("ignored.rs", "fn hidden() {}", true, 14),
            ("huge.rs", "", false, MAX_SYMBOL_FILE + 1),
            ("binary.rs", "\0", false, 1),
            ("plain.unknown", "plain", false, 5),
            ("missing.rs", "", false, 0),
        ] {
            let path = root.join(name);
            if name != "missing.rs" {
                std::fs::write(&path, contents).unwrap();
            }
            found.push(Found { path, mtime: 0, size, ignored });
        }
        let counts = shared.index_files(found.iter(), false);
        assert_eq!(
            counts,
            ExtractionCounts {
                symbol_extractions: 1,
                ignored: 1,
                oversized: 1,
                binary: 1,
                unsupported: 1,
                read_failed: 1,
                hash_reused: 0,
                not_processed: 0,
            }
        );
        assert_eq!(shared.data.read().file_count as usize, found.len());
        assert_eq!(shared.index_files(found[..1].iter(), false).hash_reused, 1);
        assert_eq!(shared.index_files(found[..1].iter(), true).symbol_extractions, 1);
    }

    #[test]
    fn reopened_cache_counts_metadata_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        std::fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
        let cache = dir.path().join("cache");
        {
            let mut index = shared(&root);
            index.store = Some(Store::open(&cache, &root, "metrics-test").unwrap());
            assert_eq!(index.scan(None).unwrap().outcomes.symbol_extractions, 1);
        }
        let mut index = shared(&root);
        index.store = Some(Store::open(&cache, &root, "metrics-test").unwrap());
        index.load_persisted();
        let counts = index.scan(None).unwrap();
        assert_eq!((counts.discovered, counts.metadata_reused, counts.scheduled), (1, 1, 0));
        assert_eq!(counts.outcomes, ExtractionCounts::default());
        assert_eq!(index.data.read().symbol_count, 1);
    }

    #[test]
    fn files_outside_current_scope_and_cancelled_batches_are_accounted_for() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let index = shared(&root);
        // A scan can retain Found values from a root removed by set_scope.
        let outside = Found { path: dir.path().join("outside.rs"), mtime: 0, size: 0, ignored: false };
        assert_eq!(
            index.index_files([&outside].into_iter(), false),
            ExtractionCounts { not_processed: 1, ..Default::default() }
        );
        index.cancel();
        let inside = Found { path: root.join("inside.rs"), mtime: 0, size: 0, ignored: false };
        assert_eq!(
            index.index_files([&inside].into_iter(), false),
            ExtractionCounts { not_processed: 1, ..Default::default() }
        );
    }

    #[test]
    fn cancelled_scan_does_not_report_completion() {
        let dir = tempfile::tempdir().unwrap();
        let shared = shared(dir.path());
        shared.cancel();
        assert!(shared.scan(None).is_none());
        assert!(!shared.indexing.load(Ordering::Relaxed));
    }
}
