//! Debounced file watching with ignore filtering and coalescing.
//!
//! Two strategies: the platform's native recursive watch (FSEvents on macOS,
//! ReadDirectoryChangesW on Windows), or one non-recursive watch per directory
//! that skips excluded / git-ignored directories (Linux, where a recursive
//! inotify watch would register every directory of `node_modules` and
//! `target` and exhaust `max_user_watches`).

use crate::FsBatch;
use crate::rules::{ExcludeMatcher, GitignoreStack};
use ide_core::{IdeError, IdeEvent, IdeResult, SharedSink};
use notify_debouncer_full::notify::event::{ModifyKind, RenameMode};
use notify_debouncer_full::notify::{self, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use notify_debouncer_full::{DebounceEventResult, DebouncedEvent, Debouncer, NoCache, new_debouncer_opt};
use parking_lot::{Condvar, Mutex, RwLock};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(100);
/// Upper bound on how long a continuous stream of events is held back.
const MAX_DELAY: Duration = Duration::from_millis(1000);

/// How directories are registered with the OS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchMode {
    /// One recursive watch on the root.
    Recursive,
    /// One non-recursive watch per directory, skipping excluded and ignored
    /// directories; new directories are picked up as they appear.
    PerDirectory,
    /// The root's own entries only (loose files edited outside a project).
    Flat,
}

impl Default for WatchMode {
    fn default() -> Self {
        if cfg!(target_os = "linux") { Self::PerDirectory } else { Self::Recursive }
    }
}

type OnChange = Box<dyn Fn(&FsBatch) + Send + Sync>;

/// Debounced watcher. Emits `IdeEvent::FsChanged` to `sink` and invokes
/// `on_change` (used by the index) with the same batch. Stops when dropped;
/// no callback runs after `drop` returns.
pub struct Watcher {
    inner: Inner,
    excludes: SharedExcludes,
    rules: Arc<GitignoreStack>,
}

type SharedExcludes = Arc<RwLock<ExcludeMatcher>>;

enum Inner {
    Recursive(#[allow(dead_code)] Debouncer<RecommendedWatcher, NoCache>),
    PerDirectory { state: Arc<DirState>, thread: Option<JoinHandle<()>> },
}

impl Watcher {
    pub fn start(root: &Path, excludes: Vec<String>, sink: SharedSink, on_change: OnChange) -> IdeResult<Self> {
        Self::start_with(root, excludes, sink, on_change, WatchMode::default())
    }

    pub fn start_with(
        root: &Path,
        excludes: Vec<String>,
        sink: SharedSink,
        on_change: OnChange,
        mode: WatchMode,
    ) -> IdeResult<Self> {
        let root = dunce::canonicalize(root)?;
        let filter = EventFilter::new(root.clone(), &excludes);
        let shared = filter.excludes.clone();
        let rules = filter.gitignore.clone();
        let emit = move |batch: &FsBatch| {
            sink.emit(IdeEvent::FsChanged {
                created: batch.created.iter().map(Into::into).collect(),
                modified: batch.modified.iter().map(Into::into).collect(),
                removed: batch.removed.iter().map(Into::into).collect(),
            });
            on_change(batch);
        };
        let inner = match mode {
            WatchMode::Recursive => Self::start_recursive(root, filter, emit, RecursiveMode::Recursive),
            WatchMode::Flat => Self::start_recursive(root, filter, emit, RecursiveMode::NonRecursive),
            WatchMode::PerDirectory => Self::start_per_directory(root, filter, emit),
        }?;
        Ok(Self { inner, excludes: shared, rules })
    }

    /// Replaces the exclude globs (Settings › Project Structure / File Types
    /// changed): later events below newly excluded folders are dropped. In
    /// per-directory mode, folders no longer excluded are watched once they change.
    pub fn set_excludes(&self, excludes: &[String]) {
        *self.excludes.write() = ExcludeMatcher::new(excludes);
    }

    /// Explicit refresh for writes to Git common metadata outside the watched root.
    pub fn reload_ignore_rules(&self) {
        self.rules.reload_repo_level();
        self.rules.invalidate_tree(self.rules.repo_root().unwrap_or(Path::new("/")));
    }

    /// Number of OS-level watches (1 in recursive and flat mode).
    pub fn watch_count(&self) -> usize {
        match &self.inner {
            Inner::Recursive(_) => 1,
            Inner::PerDirectory { state, .. } => state.watched.lock().len(),
        }
    }

    fn start_recursive(
        root: PathBuf,
        filter: EventFilter,
        emit: impl Fn(&FsBatch) + Send + 'static,
        recursive: RecursiveMode,
    ) -> IdeResult<Inner> {
        // No file-id cache: building it walks and stats the whole tree before `watch` returns,
        // which made opening large projects block for seconds. Renames arrive as remove + create.
        let handler = move |result: DebounceEventResult| match result {
            Ok(events) => {
                let (batch, _) = filter.batch_detailed(&events);
                if !batch.is_empty() {
                    emit(&batch);
                }
            }
            Err(errors) => {
                for e in errors {
                    tracing::warn!("file watcher: {e}");
                }
            }
        };
        let mut debouncer =
            new_debouncer_opt::<_, RecommendedWatcher, _>(DEBOUNCE, None, handler, NoCache, notify::Config::default())
                .map_err(|e| io_error(format!("cannot start file watcher: {e}")))?;
        debouncer.watch(&root, recursive).map_err(|e| io_error(format!("cannot watch {}: {e}", root.display())))?;
        Ok(Inner::Recursive(debouncer))
    }

    fn start_per_directory(
        root: PathBuf,
        filter: EventFilter,
        emit: impl Fn(&FsBatch) + Send + 'static,
    ) -> IdeResult<Inner> {
        let state = Arc::new(DirState {
            filter,
            watcher: Mutex::new(None),
            watched: Mutex::default(),
            queue: Mutex::default(),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
        });
        let weak: Weak<DirState> = Arc::downgrade(&state);
        let watcher = RecommendedWatcher::new(
            move |event: notify::Result<notify::Event>| {
                let Some(state) = weak.upgrade() else { return };
                match event {
                    Ok(event) => {
                        state.queue.lock().push((event, Instant::now()));
                        state.wake.notify_one();
                    }
                    Err(e) => tracing::warn!("file watcher: {e}"),
                }
            },
            notify::Config::default(),
        )
        .map_err(|e| io_error(format!("cannot start file watcher: {e}")))?;
        *state.watcher.lock() = Some(watcher);
        let mut created = Vec::new();
        state.watch_tree(&root, false, &mut created);
        if state.watched.lock().is_empty() {
            return Err(io_error(format!("cannot watch {}", root.display())));
        }
        let thread = {
            let state = state.clone();
            std::thread::Builder::new()
                .name("openidea-fs-watch".into())
                .spawn(move || state.run(emit))
                .map_err(|e| io_error(format!("cannot start file watcher: {e}")))?
        };
        Ok(Inner::PerDirectory { state, thread: Some(thread) })
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        if let Inner::PerDirectory { state, thread } = &mut self.inner {
            state.stop.store(true, Ordering::SeqCst);
            state.wake.notify_all();
            let watcher = state.watcher.lock().take();
            drop(watcher);
            if let Some(t) = thread.take() {
                let _ = t.join();
            }
        }
    }
}

fn io_error(msg: String) -> IdeError {
    IdeError::new(ide_core::error::ErrorKind::Io, msg)
}

/// State of the per-directory strategy, shared with the notify callback
/// (weakly) and the debounce thread.
struct DirState {
    filter: EventFilter,
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched: Mutex<HashSet<PathBuf>>,
    queue: Mutex<Vec<(notify::Event, Instant)>>,
    wake: Condvar,
    stop: AtomicBool,
}

impl DirState {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Debounce loop: waits for a quiet period, then processes the batch.
    fn run(&self, emit: impl Fn(&FsBatch)) {
        loop {
            let events = {
                let mut q = self.queue.lock();
                while q.is_empty() && !self.stopped() {
                    self.wake.wait(&mut q);
                }
                if self.stopped() {
                    return;
                }
                let first = q[0].1;
                loop {
                    let last = q.last().map_or(first, |e| e.1);
                    let now = Instant::now();
                    if self.stopped() {
                        return;
                    }
                    if now >= last + DEBOUNCE || now >= first + MAX_DELAY {
                        break;
                    }
                    let wait = (last + DEBOUNCE).min(first + MAX_DELAY) - now;
                    self.wake.wait_for(&mut q, wait);
                }
                std::mem::take(&mut *q)
            };
            let events: Vec<DebouncedEvent> = events.into_iter().map(|(e, t)| DebouncedEvent::new(e, t)).collect();
            let (mut batch, rule_dirs) = self.filter.batch_detailed(&events);
            self.update_watches(&mut batch, &rule_dirs);
            if !batch.is_empty() && !self.stopped() {
                emit(&batch);
            }
        }
    }

    /// Follows directory creation / removal and ignore-rule changes.
    fn update_watches(&self, batch: &mut FsBatch, rule_dirs: &[PathBuf]) {
        let mut discovered = Vec::new();
        for path in &batch.created {
            if path.symlink_metadata().is_ok_and(|m| m.is_dir()) {
                self.watch_tree(path, true, &mut discovered);
            }
        }
        // Renames / atomic replaces of directories surface as `modified`.
        for path in &batch.modified {
            if !self.watched.lock().contains(path) && path.symlink_metadata().is_ok_and(|m| m.is_dir()) {
                self.watch_tree(path, true, &mut discovered);
            }
        }
        for path in &batch.removed {
            self.unwatch_tree(path);
        }
        for dir in rule_dirs {
            self.resync(dir);
        }
        if !discovered.is_empty() {
            let known: HashSet<&PathBuf> = batch.created.iter().chain(&batch.modified).collect();
            let fresh: Vec<PathBuf> = discovered.into_iter().filter(|p| !known.contains(p)).collect();
            batch.created.extend(fresh);
            batch.created.sort();
            batch.created.dedup();
        }
    }

    fn add_watch(&self, dir: &Path) -> bool {
        if self.watched.lock().contains(dir) {
            return true;
        }
        let mut guard = self.watcher.lock();
        let Some(w) = guard.as_mut() else { return false };
        match w.watch(dir, RecursiveMode::NonRecursive) {
            Ok(()) => {
                self.watched.lock().insert(dir.to_path_buf());
                true
            }
            Err(e) => {
                tracing::debug!("cannot watch {}: {e}", dir.display());
                false
            }
        }
    }

    fn remove_watch(&self, dir: &Path) {
        if self.watched.lock().remove(dir)
            && let Some(w) = self.watcher.lock().as_mut()
        {
            // Fails harmlessly when the OS already dropped the watch.
            let _ = w.unwatch(dir);
        }
    }

    /// Watches `dir` and every watchable directory below it. With `report`,
    /// files and directories found inside (created before the watch was in
    /// place) are appended to `found`.
    fn watch_tree(&self, dir: &Path, report: bool, found: &mut Vec<PathBuf>) {
        let mut stack = vec![dir.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if self.stopped() || !self.filter.should_watch_dir(&dir) || !self.add_watch(&dir) {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
                if report && self.filter.is_reported(&path, is_dir) {
                    found.push(path.clone());
                }
                if is_dir {
                    stack.push(path);
                }
            }
        }
    }

    fn unwatch_tree(&self, dir: &Path) {
        let under: Vec<PathBuf> = self.watched.lock().iter().filter(|p| p.starts_with(dir)).cloned().collect();
        for p in under {
            self.remove_watch(&p);
        }
    }

    /// Re-applies ignore rules below `dir` after a `.gitignore` changed.
    fn resync(&self, dir: &Path) {
        let under: Vec<PathBuf> = self.watched.lock().iter().filter(|p| p.starts_with(dir)).cloned().collect();
        for p in under {
            if p.as_path() != dir && !self.filter.should_watch_dir(&p) {
                self.unwatch_tree(&p);
            }
        }
        let mut ignored = Vec::new();
        self.watch_tree(dir, false, &mut ignored);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Change {
    Created,
    Modified,
    Removed,
    /// Created and removed again within the batch.
    Transient,
    /// VCS metadata (`.git/HEAD`, …): always reported as modified.
    Vcs,
}

fn merge(prev: Option<Change>, next: Change) -> Change {
    use Change::*;
    match (prev, next) {
        (None, n) => n,
        (Some(Vcs), _) | (_, Vcs) => Vcs,
        (Some(Created | Transient), Modified | Created) => Created,
        (Some(Created | Transient), Removed) => Transient,
        (Some(Removed), Created | Modified) => Modified,
        (Some(Modified), Created | Modified) => Modified,
        (Some(_), Removed) => Removed,
        (Some(p), Transient) => p,
    }
}

pub(crate) struct EventFilter {
    root: PathBuf,
    excludes: SharedExcludes,
    gitignore: Arc<GitignoreStack>,
}

impl EventFilter {
    pub fn new(root: PathBuf, excludes: &[String]) -> Self {
        Self {
            gitignore: Arc::new(GitignoreStack::new(&root)),
            excludes: Arc::new(RwLock::new(ExcludeMatcher::new(excludes))),
            root,
        }
    }

    /// `Some(true)` for interesting VCS metadata, `Some(false)` for other `.git`
    /// internals, `None` outside `.git`.
    fn git_internal(rel: &Path) -> Option<bool> {
        let comps: Vec<&std::ffi::OsStr> = rel
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s),
                _ => None,
            })
            .collect();
        let idx = comps.iter().position(|c| *c == ".git")?;
        let rest = &comps[idx + 1..];
        Some(match rest {
            [one] => *one == "HEAD" || *one == "index" || *one == "packed-refs",
            [first, ..] => *first == "refs" && !rest.last().is_some_and(|l| l.to_string_lossy().ends_with(".lock")),
            [] => false,
        })
    }

    /// Whether a directory deserves its own watch in per-directory mode: not
    /// excluded or git-ignored; inside `.git` only the directory itself and
    /// `refs/` (HEAD, index and refs are what VCS refresh needs).
    pub fn should_watch_dir(&self, dir: &Path) -> bool {
        let Ok(rel) = dir.strip_prefix(&self.root) else { return false };
        if rel.as_os_str().is_empty() {
            return true;
        }
        let comps: Vec<_> = rel.components().collect();
        if let Some(i) = comps.iter().position(|c| c.as_os_str() == ".git") {
            let rest: Vec<_> = comps[i + 1..].iter().map(|c| c.as_os_str()).collect();
            return match rest.as_slice() {
                [] => true,
                [first, ..] if *first == "refs" => true,
                [only] => *only == "info",
                _ => false,
            };
        }
        !self.excludes.read().is_excluded(rel) && !self.gitignore.is_ignored(dir, true)
    }

    /// Whether a path found by scanning a new directory would be reported.
    fn is_reported(&self, path: &Path, is_dir: bool) -> bool {
        let Ok(rel) = path.strip_prefix(&self.root) else { return false };
        Self::git_internal(rel).is_none()
            && !self.excludes.read().is_excluded(rel)
            && !self.gitignore.is_ignored(path, is_dir)
    }

    fn classify(&self, path: &Path, change: Change, out: &mut BTreeMap<PathBuf, Change>) {
        let rel = match path.strip_prefix(&self.root) {
            Ok(rel) if rel.as_os_str().is_empty() => return,
            Ok(rel) => Some(rel),
            Err(_) => None,
        };
        let change = match rel.and_then(Self::git_internal) {
            Some(true) => Change::Vcs,
            Some(false) => return,
            None if crate::encoding::is_atomic_temp(path) => return,
            None => change,
        };
        let entry = out.get(path).copied();
        out.insert(path.to_path_buf(), merge(entry, change));
    }

    #[cfg(test)]
    pub fn batch(&self, events: &[DebouncedEvent]) -> FsBatch {
        self.batch_detailed(events).0
    }

    /// The coalesced, filtered batch plus the directories whose ignore rules
    /// changed (their cached matchers have been rebuilt already).
    pub fn batch_detailed(&self, events: &[DebouncedEvent]) -> (FsBatch, Vec<PathBuf>) {
        let mut changes: BTreeMap<PathBuf, Change> = BTreeMap::new();
        for ev in events {
            let paths = &ev.event.paths;
            match ev.event.kind {
                EventKind::Access(_) => {}
                EventKind::Create(_) => paths.iter().for_each(|p| self.classify(p, Change::Created, &mut changes)),
                EventKind::Remove(_) => paths.iter().for_each(|p| self.classify(p, Change::Removed, &mut changes)),
                EventKind::Modify(ModifyKind::Name(mode)) => match (mode, paths.as_slice()) {
                    (RenameMode::Both, [from, to]) => {
                        self.classify(from, Change::Removed, &mut changes);
                        self.classify(to, Change::Created, &mut changes);
                    }
                    (RenameMode::From, _) => paths.iter().for_each(|p| self.classify(p, Change::Removed, &mut changes)),
                    (RenameMode::To, _) => paths.iter().for_each(|p| self.classify(p, Change::Created, &mut changes)),
                    _ => {
                        for p in paths {
                            let c = if p.symlink_metadata().is_ok() { Change::Created } else { Change::Removed };
                            self.classify(p, c, &mut changes);
                        }
                    }
                },
                EventKind::Modify(_) | EventKind::Any | EventKind::Other => {
                    paths.iter().for_each(|p| self.classify(p, Change::Modified, &mut changes))
                }
            }
        }

        // Rebuild ignore rules first, so files in the same batch are filtered
        // by the new rules regardless of path order.
        let mut rule_dirs: BTreeSet<PathBuf> = BTreeSet::new();
        for path in changes.keys() {
            let name = path.file_name().and_then(|n| n.to_str());
            if matches!(name, Some(".gitignore" | ".ignore"))
                && let Some(dir) = path.parent()
            {
                self.gitignore.invalidate(dir);
                rule_dirs.insert(dir.to_path_buf());
            }
        }
        if events.iter().flat_map(|e| &e.event.paths).any(|p| p.ends_with(".git/info/exclude")) {
            self.gitignore.reload_repo_level();
            rule_dirs.insert(self.root.clone());
        }
        for dir in changes.iter().filter(|(_, c)| !matches!(c, Change::Modified | Change::Vcs)).map(|(p, _)| p) {
            // A directory that appeared or vanished takes its cached rules with it.
            self.gitignore.invalidate_tree(dir);
        }

        let mut batch = FsBatch::default();
        for (path, change) in changes {
            if change == Change::Vcs {
                batch.modified.push(path);
                continue;
            }
            let meta = path.symlink_metadata().ok();
            let exists = meta.is_some();
            let change = match (change, exists) {
                (Change::Created, false) => continue,
                // FSEvents coalesces history into one event with both "created" and
                // "removed" flags, so a transient path may well be a real deletion of
                // something the consumer knows; reporting an unknown path as removed
                // is harmless, missing a deletion is not.
                (Change::Transient, false) => Change::Removed,
                (Change::Transient, true) => Change::Created,
                (Change::Modified, false) => Change::Removed,
                (Change::Removed, true) => Change::Modified,
                (c, _) => c,
            };
            if let Ok(rel) = path.strip_prefix(&self.root) {
                if self.excludes.read().is_excluded(rel) {
                    continue;
                }
                let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
                if self.gitignore.is_ignored(&path, is_dir) {
                    continue;
                }
            }
            match change {
                Change::Created => batch.created.push(path),
                Change::Removed => batch.removed.push(path),
                _ => batch.modified.push(path),
            }
        }
        (batch, rule_dirs.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_debouncer_full::notify::Event;
    use notify_debouncer_full::notify::event::{CreateKind, DataChange, RemoveKind};

    fn ev(kind: EventKind, paths: Vec<PathBuf>) -> DebouncedEvent {
        DebouncedEvent::new(Event { kind, paths, attrs: Default::default() }, Instant::now())
    }

    #[test]
    fn coalesces_and_filters() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(root.join(".git/refs/heads")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        std::fs::write(root.join("kept.txt"), "k").unwrap();
        std::fs::write(root.join("debug.log"), "x").unwrap();
        let filter = EventFilter::new(root.clone(), &["**/node_modules".into()]);

        let modify = EventKind::Modify(ModifyKind::Data(DataChange::Content));
        let events = vec![
            ev(EventKind::Create(CreateKind::File), vec![root.join("a.txt")]),
            ev(modify, vec![root.join("a.txt")]),
            ev(EventKind::Create(CreateKind::File), vec![root.join("gone.txt")]),
            ev(EventKind::Remove(RemoveKind::File), vec![root.join("gone.txt")]),
            ev(EventKind::Remove(RemoveKind::File), vec![root.join("kept.txt")]),
            ev(EventKind::Create(CreateKind::File), vec![root.join("kept.txt")]),
            ev(modify, vec![root.join("debug.log")]),
            ev(modify, vec![root.join("node_modules/x.js")]),
            ev(modify, vec![root.join(".git/objects/ab/cdef")]),
            ev(modify, vec![root.join(".git/index.lock")]),
            ev(modify, vec![root.join(".git/HEAD")]),
            ev(EventKind::Remove(RemoveKind::File), vec![root.join(".git/refs/heads/feature")]),
            ev(EventKind::Remove(RemoveKind::File), vec![root.join("old.txt")]),
            ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), vec![root.join("from.txt"), root.join("a.txt")]),
        ];
        let batch = filter.batch(&events);
        assert_eq!(batch.created, vec![root.join("a.txt")]);
        assert_eq!(
            batch.modified,
            vec![root.join(".git/HEAD"), root.join(".git/refs/heads/feature"), root.join("kept.txt")]
        );
        assert_eq!(batch.removed, vec![root.join("from.txt"), root.join("gone.txt"), root.join("old.txt")]);
    }

    #[test]
    fn atomic_save_temp_files_are_not_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let temp = root.join(".a.py.openidea-tmp-42-0");
        std::fs::write(&temp, "x").unwrap();
        std::fs::write(root.join("a.py"), "x").unwrap();
        let filter = EventFilter::new(root.clone(), &[]);

        let batch = filter.batch(&[ev(EventKind::Create(CreateKind::File), vec![temp.clone()])]);
        assert!(batch.is_empty());
        let batch =
            filter.batch(&[ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), vec![temp, root.join("a.py")])]);
        assert_eq!(batch.created, vec![root.join("a.py")]);
        assert!(batch.removed.is_empty());
    }

    #[test]
    fn git_internal_paths() {
        let g = |s: &str| EventFilter::git_internal(Path::new(s));
        assert_eq!(g("src/main.rs"), None);
        assert_eq!(g(".git/HEAD"), Some(true));
        assert_eq!(g(".git/index"), Some(true));
        assert_eq!(g(".git/refs/heads/main"), Some(true));
        assert_eq!(g(".git/refs/heads/main.lock"), Some(false));
        assert_eq!(g(".git/objects/aa/bb"), Some(false));
        assert_eq!(g(".git"), Some(false));
    }

    #[test]
    fn nested_gitignore_and_rule_changes_in_one_batch() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("pkg/gen")).unwrap();
        std::fs::write(root.join("pkg/.gitignore"), "gen/\n*.tmp\n").unwrap();
        for f in ["pkg/a.tmp", "pkg/gen/x.rs", "pkg/keep.rs", "b.tmp"] {
            std::fs::write(root.join(f), "x").unwrap();
        }
        let filter = EventFilter::new(root.clone(), &[]);
        let modify = EventKind::Modify(ModifyKind::Data(DataChange::Content));
        let touch =
            |paths: &[&str]| -> Vec<DebouncedEvent> { paths.iter().map(|p| ev(modify, vec![root.join(p)])).collect() };
        let (batch, rules) = filter.batch_detailed(&touch(&["pkg/a.tmp", "pkg/gen/x.rs", "pkg/keep.rs", "b.tmp"]));
        assert_eq!(batch.modified, vec![root.join("b.tmp"), root.join("pkg/keep.rs")]);
        assert!(rules.is_empty());
        assert!(!filter.should_watch_dir(&root.join("pkg/gen")));

        // The nested .gitignore changes in the same batch as files it governs;
        // `pkg/.gitignore` sorts after `pkg/-x.tmp`, so order must not matter.
        std::fs::write(root.join("pkg/.gitignore"), "*.rs\n").unwrap();
        std::fs::write(root.join("pkg/-x.tmp"), "x").unwrap();
        let (batch, rules) =
            filter.batch_detailed(&touch(&["pkg/-x.tmp", "pkg/.gitignore", "pkg/keep.rs", "pkg/a.tmp"]));
        assert_eq!(batch.modified, vec![root.join("pkg/-x.tmp"), root.join("pkg/.gitignore"), root.join("pkg/a.tmp")]);
        assert_eq!(rules, vec![root.join("pkg")]);
        assert!(filter.should_watch_dir(&root.join("pkg/gen")));

        // .git/info/exclude is not reported but rebuilds the repository rules.
        std::fs::create_dir_all(root.join(".git/info")).unwrap();
        std::fs::write(root.join(".git/info/exclude"), "b.tmp\n").unwrap();
        let (batch, rules) = filter.batch_detailed(&touch(&[".git/info/exclude", "b.tmp"]));
        assert!(batch.is_empty(), "{batch:?}");
        assert_eq!(rules, vec![root.clone()]);
    }

    #[test]
    fn watch_dir_selection() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::write(root.join(".gitignore"), "/build\n").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let filter = EventFilter::new(root.clone(), &["**/node_modules".into()]);
        let w = |p: &str| filter.should_watch_dir(&root.join(p));
        assert!(filter.should_watch_dir(&root));
        assert!(w("src") && w("src/deep"));
        assert!(!w("node_modules") && !w("a/node_modules/b"));
        assert!(!w("build") && w("src/build"));
        assert!(w(".git") && w(".git/refs") && w(".git/refs/heads") && w(".git/info"));
        assert!(!w(".git/objects") && !w(".git/objects/ab") && !w(".git/logs"));
        assert!(!filter.should_watch_dir(Path::new("/elsewhere")));
        // Excludes are replaced in place (Watcher::set_excludes).
        *filter.excludes.write() = ExcludeMatcher::new(&["gen".into()]);
        assert!(w("node_modules") && !w("src/gen"));
    }

    fn watcher_state(w: &Watcher) -> &DirState {
        match &w.inner {
            Inner::PerDirectory { state, .. } => state,
            Inner::Recursive(_) => panic!("not per-directory"),
        }
    }

    fn wait_for(events: &Mutex<Vec<FsBatch>>, pred: impl Fn(&[FsBatch]) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if pred(&events.lock()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn all_paths(b: &[FsBatch]) -> BTreeSet<PathBuf> {
        b.iter().flat_map(|b| b.created.iter().chain(&b.modified).chain(&b.removed).cloned()).collect()
    }

    #[test]
    fn per_directory_mode_skips_excluded_dirs_and_follows_new_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        for d in ["src/a", "node_modules/x/y", "target/debug", ".git/refs/heads", ".git/objects/aa", "lib/out"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("lib/.gitignore"), "out/\n").unwrap();
        let batches: Arc<Mutex<Vec<FsBatch>>> = Arc::default();
        let sink: SharedSink = Arc::new(|_e: IdeEvent| {});
        let watcher = {
            let batches = batches.clone();
            Watcher::start_with(
                &root,
                vec!["**/node_modules".into(), "target".into()],
                sink,
                Box::new(move |b| batches.lock().push(b.clone())),
                WatchMode::PerDirectory,
            )
            .unwrap()
        };
        // root, src, src/a, lib, .git, .git/refs, .git/refs/heads
        assert_eq!(watcher.watch_count(), 7);

        // A new directory tree created in one go: its contents are reported
        // even when written before the watch on it was registered.
        std::fs::create_dir_all(root.join("src/new/inner")).unwrap();
        std::fs::write(root.join("src/new/inner/f.rs"), "x").unwrap();
        assert!(
            wait_for(&batches, |b| all_paths(b).contains(&root.join("src/new/inner/f.rs"))),
            "{:?}",
            batches.lock()
        );
        assert!(watcher.watch_count() >= 9);
        // ...and later writes inside it are seen through the new watches.
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(root.join("src/new/inner/g.rs"), "x").unwrap();
        assert!(wait_for(&batches, |b| all_paths(b).contains(&root.join("src/new/inner/g.rs"))));

        std::fs::write(root.join("node_modules/x/y/z.js"), "x").unwrap();
        std::fs::write(root.join("lib/out/o.txt"), "x").unwrap();
        std::fs::write(root.join("src/a/after.rs"), "x").unwrap();
        assert!(wait_for(&batches, |b| all_paths(b).contains(&root.join("src/a/after.rs"))));
        let paths = all_paths(&batches.lock());
        assert!(!paths.iter().any(|p| p.starts_with(root.join("node_modules"))), "{paths:?}");
        assert!(!paths.contains(&root.join("lib/out/o.txt")));

        // Un-ignoring lib/out registers a watch on it.
        let before = watcher.watch_count();
        std::fs::write(root.join("lib/.gitignore"), "*.log\n").unwrap();
        assert!(wait_for(&batches, |b| all_paths(b).contains(&root.join("lib/.gitignore"))));
        let deadline = Instant::now() + Duration::from_secs(5);
        while watcher.watch_count() == before && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(watcher.watch_count(), before + 1);
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(root.join("lib/out/now.txt"), "x").unwrap();
        assert!(wait_for(&batches, |b| all_paths(b).contains(&root.join("lib/out/now.txt"))));

        // Removed directories drop their watches. Only checked with inotify:
        // FSEvents (where this mode is not the default) sometimes drops the
        // removal of a directory that is itself a watch root.
        if cfg!(target_os = "linux") {
            let before = watcher.watch_count();
            std::fs::remove_dir_all(root.join("src/new")).unwrap();
            assert!(
                wait_for(&batches, |b| b.iter().any(|b| b.removed.contains(&root.join("src/new")))),
                "{:?}",
                batches.lock()
            );
            let deadline = Instant::now() + Duration::from_secs(5);
            while watcher.watch_count() > before - 2 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(watcher.watch_count(), before - 2);
        } else {
            let before = watcher.watch_count();
            watcher_state(&watcher).unwatch_tree(&root.join("src/new"));
            assert_eq!(watcher.watch_count(), before - 2);
        }

        drop(watcher);
        let n = batches.lock().len();
        std::fs::write(root.join("src/after-drop.txt"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(batches.lock().len(), n, "no events after drop");
    }

    #[test]
    fn flat_mode_reports_the_roots_own_entries_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let batches: Arc<Mutex<Vec<FsBatch>>> = Arc::default();
        let sink: SharedSink = Arc::new(|_e: IdeEvent| {});
        let watcher = {
            let batches = batches.clone();
            Watcher::start_with(
                &root,
                Vec::new(),
                sink,
                Box::new(move |b| batches.lock().push(b.clone())),
                WatchMode::Flat,
            )
            .unwrap()
        };
        assert_eq!(watcher.watch_count(), 1);
        std::fs::write(root.join("sub/deep.txt"), "x").unwrap();
        std::fs::write(root.join("a.txt"), "x").unwrap();
        assert!(wait_for(&batches, |b| all_paths(b).contains(&root.join("a.txt"))), "{:?}", batches.lock());
        std::thread::sleep(Duration::from_millis(300));
        assert!(!all_paths(&batches.lock()).contains(&root.join("sub/deep.txt")));
    }
}
