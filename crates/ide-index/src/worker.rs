//! The background indexing thread: initial load + full scan, then incremental
//! updates queued by the watcher.

use crate::data::{FileEntry, FileRecord, IndexData, StoredSymbol};
use crate::filter::{Found, PathFilter, mtime_of};
use crate::store::Store;
use ide_core::{IdeEvent, SharedSink, TaskId};
use ide_language::{LanguageRegistry, Syntax};
use parking_lot::{Condvar, Mutex, RwLock};
use rayon::prelude::*;
use std::collections::{HashSet, VecDeque};
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
    /// Files whose content was (re)read and parsed; observability for tests.
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
        let root = self.filter().root().to_owned();
        match store.load() {
            Ok(records) => {
                let entries: Vec<FileEntry> =
                    records.into_par_iter().map(|(rel, rec)| FileEntry::new(root.join(&rel), rel, rec)).collect();
                let mut d = self.data.write();
                for e in entries {
                    d.insert(e);
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
        for root in filter.roots() {
            found.extend(filter.walk(root, &self.cancelled));
        }
        if self.is_cancelled() {
            return self.end_scan(task);
        }
        let seen: HashSet<&Path> = found.iter().map(|f| f.path.as_path()).collect();
        let (todo, stale): (Vec<&Found>, Vec<PathBuf>) = {
            let d = self.data.read();
            let todo = found
                .iter()
                .filter(|f| d.get(&f.path).is_none_or(|e| e.mtime != f.mtime || e.size != f.size))
                .collect();
            let stale = d.paths().filter(|p| !seen.contains(p.as_path())).cloned().collect();
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

        let total = todo.len();
        let mut done = 0usize;
        let mut last_progress = Instant::now();
        for chunk in todo.chunks(CHUNK) {
            if self.is_cancelled() {
                return self.end_scan(task);
            }
            self.index_files(chunk.iter().copied(), false);
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
        self.persist(&[], &[], true);
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
        let d = self.data.read();
        tracing::info!(
            "indexed {} files ({} parsed, {} symbols) in {:?}",
            d.file_count,
            total,
            d.symbol_count,
            started.elapsed()
        );
    }

    /// Extracts records in parallel, then publishes them to memory and disk.
    /// `force` re-parses files whose content is unchanged (their language changed).
    fn index_files<'a>(&self, files: impl Iterator<Item = &'a Found>, force: bool) {
        let files: Vec<&Found> = files.collect();
        let filter = self.filter();
        let extracted: Vec<(String, FileRecord, PathBuf)> = files
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
                        let d = self.data.read();
                        let mut rec = d.get(&f.path)?.record();
                        rec.mtime = f.mtime;
                        rec.size = f.size;
                        Some((rel, rec, f.path.clone()))
                    }
                    Extracted::New(rec) => Some((rel, rec, f.path.clone())),
                }
            })
            .collect();
        if extracted.is_empty() {
            return;
        }
        let puts: Vec<(String, FileRecord)> =
            extracted.iter().filter_map(|(_, rec, path)| Some((filter.store_key(path)?, rec.clone()))).collect();
        {
            let entries: Vec<FileEntry> =
                extracted.into_iter().map(|(rel, rec, path)| FileEntry::new(path, rel, rec)).collect();
            let mut d = self.data.write();
            for e in entries {
                d.insert(e);
            }
        }
        self.persist(&puts, &[], false);
    }

    fn persist(&self, puts: &[(String, FileRecord)], deletes: &[String], durable: bool) {
        if let Some(store) = &self.store
            && let Err(e) = store.apply(puts, deletes, durable)
        {
            tracing::warn!("index cache write failed: {e}");
        }
    }

    fn extract(&self, f: &Found, prev_hash: Option<[u8; 32]>) -> Extracted {
        let mut rec = FileRecord { mtime: f.mtime, size: f.size, ..Default::default() };
        if f.size > MAX_SYMBOL_FILE {
            return Extracted::New(rec);
        }
        let mut bytes = Vec::with_capacity(f.size as usize);
        match std::fs::File::open(&f.path).and_then(|mut file| file.read_to_end(&mut bytes)) {
            Ok(_) => {}
            Err(e) => {
                tracing::debug!("index: cannot read {}: {e}", f.path.display());
                return Extracted::New(rec);
            }
        }
        rec.hash = *blake3::hash(&bytes).as_bytes();
        if prev_hash == Some(rec.hash) {
            return Extracted::Unchanged;
        }
        self.parsed.fetch_add(1, Ordering::Relaxed);
        if bytes[..bytes.len().min(8192)].contains(&0) {
            return Extracted::New(rec);
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
        }
        Extracted::New(rec)
    }

    fn process(&self, jobs: Vec<Job>) {
        let mut changed: Vec<PathBuf> = Vec::new();
        let mut removed: Vec<PathBuf> = Vec::new();
        let mut save_recent = false;
        let mut rescan = false;
        let mut reparse: Vec<std::sync::Arc<LanguageRegistry>> = Vec::new();
        for job in jobs {
            match job {
                Job::Changed(p) => changed.extend(p),
                Job::Removed(p) => removed.extend(p),
                Job::SaveRecent => save_recent = true,
                Job::Rescan => rescan = true,
                Job::Reparse(before) => reparse.push(before),
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
        for path in changed {
            if !seen.insert(path.clone()) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if filter.is_excluded(&path, meta.is_dir()) {
                continue;
            }
            if meta.is_dir() {
                files.extend(filter.walk(&path, &self.cancelled));
            } else if meta.is_file() {
                files.push(Found { mtime: mtime_of(&meta), size: meta.len(), path });
            }
        }
        let files: Vec<Found> = {
            let d = self.data.read();
            files
                .into_iter()
                .filter(|f| d.get(&f.path).is_none_or(|e| e.mtime != f.mtime || e.size != f.size))
                .collect()
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
                        Some(Found { path: p.clone(), mtime: e.mtime, size: e.size })
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
    New(FileRecord),
}
