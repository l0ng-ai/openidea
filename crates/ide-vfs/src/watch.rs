//! Debounced file watching with ignore filtering and coalescing.
//!
//! Two strategies: the platform's native recursive watch (FSEvents on macOS,
//! ReadDirectoryChangesW on Windows), or one non-recursive watch per directory
//! that skips excluded / git-ignored directories (Linux, where a recursive
//! inotify watch would register every directory of `node_modules` and
//! `target` and exhaust `max_user_watches`).
//!
//! When the OS watcher cannot start (inotify limits used up, a file system
//! without change notifications), the same directories are polled instead.

use crate::FsBatch;
use crate::rules::{ExcludeMatcher, GitignoreStack};
use ide_core::{IdeError, IdeEvent, IdeResult, SharedSink};
use notify::event::{ModifyKind, RenameMode};
use notify::{ErrorKind, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, WatcherKind};
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
/// How often the polling fallback rescans the watched directories.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Directories watched synchronously in [`Watcher::start`] before handing the
/// remainder of a large tree to the watcher thread.
const SYNC_WATCH_BUDGET: usize = 256;

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
type Emit = Arc<dyn Fn(&FsBatch) + Send + Sync>;

/// Debounced watcher. Emits `IdeEvent::FsChanged` to `sink` and invokes
/// `on_change` (used by the index) with the same batch. Stops when dropped;
/// no callback runs after `drop` returns.
pub struct Watcher {
    inner: Inner,
    excludes: SharedExcludes,
    rules: Arc<GitignoreStack>,
    polling: Option<String>,
}

type SharedExcludes = Arc<RwLock<ExcludeMatcher>>;

struct Inner {
    state: Arc<DirState>,
    thread: Option<JoinHandle<()>>,
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
        let emit: Emit = Arc::new(move |batch: &FsBatch| {
            // VCS-metadata-only batches (`batch.vcs`) carry no worktree paths:
            // consumers that refresh on any `fsChanged` would reschedule purely
            // from the backend's own `.git/index` write.
            if !(batch.created.is_empty() && batch.modified.is_empty() && batch.removed.is_empty()) {
                sink.emit(IdeEvent::FsChanged {
                    created: batch.created.iter().map(Into::into).collect(),
                    modified: batch.modified.iter().map(Into::into).collect(),
                    removed: batch.removed.iter().map(Into::into).collect(),
                });
            }
            if !batch.excluded_dirs.is_empty() {
                sink.emit(IdeEvent::ExcludedDirsChanged { dirs: batch.excluded_dirs.iter().map(Into::into).collect() });
            }
            on_change(batch);
        });
        let (inner, polling) = match Self::start_native(&root, filter.clone(), emit.clone(), mode) {
            Ok(inner) => (inner, None),
            // Rather than failing to open the project, keep it in sync a little later.
            Err(e) => {
                tracing::warn!("{e}; polling {} for changes instead", root.display());
                (Self::start_polling(&root, filter, emit, mode)?, Some(e.message))
            }
        };
        Ok(Self { inner, excludes: shared, rules, polling })
    }

    /// Why changes are polled for instead of reported by the OS; `None` when they are.
    pub fn polling(&self) -> Option<&str> {
        self.polling.as_deref()
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
        self.inner.state.watched.lock().len()
    }

    fn start_native(root: &Path, filter: EventFilter, emit: Emit, mode: WatchMode) -> IdeResult<Inner> {
        Self::start_queued::<RecommendedWatcher>(root, filter, emit, mode, notify::Config::default())
    }

    /// Polls per directory unless flat: a recursive poll would rescan
    /// `node_modules` and `target` every round.
    fn start_polling(root: &Path, filter: EventFilter, emit: Emit, mode: WatchMode) -> IdeResult<Inner> {
        let config = notify::Config::default().with_poll_interval(POLL_INTERVAL);
        let mode = if mode == WatchMode::Flat { mode } else { WatchMode::PerDirectory };
        Self::start_queued::<PollWatcher>(root, filter, emit, mode, config)
    }

    fn start_queued<W: notify::Watcher + Send + 'static>(
        root: &Path,
        filter: EventFilter,
        emit: Emit,
        mode: WatchMode,
        config: notify::Config,
    ) -> IdeResult<Inner> {
        let polled = W::kind() == WatcherKind::PollWatcher;
        let state = Arc::new(DirState {
            filter,
            mode,
            watcher: Mutex::new(None),
            watched: Mutex::default(),
            queue: Mutex::default(),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
        });
        let weak: Weak<DirState> = Arc::downgrade(&state);
        let watcher = W::new(
            move |event: notify::Result<notify::Event>| {
                let Some(state) = weak.upgrade() else { return };
                match event {
                    Ok(event) if polled && is_dir_touch(&event) => {}
                    Ok(event) => {
                        state.queue.lock().push((event, Instant::now()));
                        state.wake.notify_one();
                    }
                    Err(e) => tracing::warn!("file watcher: {e}"),
                }
            },
            config,
        )
        .map_err(|e| watcher_error("cannot start file watcher", e))?;
        *state.watcher.lock() = Some(Box::new(watcher));
        let deferred = if mode == WatchMode::PerDirectory {
            state.watch_tree_bounded(root, SYNC_WATCH_BUDGET)
        } else {
            state.add_watch(root);
            Vec::new()
        };
        if state.watched.lock().is_empty() {
            return Err(io_error(format!("cannot watch {}", root.display())));
        }
        let thread = {
            let state = state.clone();
            std::thread::Builder::new()
                .name("openidea-fs-watch".into())
                .spawn(move || state.run(deferred, &*emit))
                .map_err(|e| io_error(format!("cannot start file watcher: {e}")))?
        };
        Ok(Inner { state, thread: Some(thread) })
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        let state = &self.state;
        {
            let _queue = state.queue.lock();
            state.stop.store(true, Ordering::SeqCst);
            state.wake.notify_all();
        }
        let watcher = state.watcher.lock().take();
        drop(watcher);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn io_error(msg: String) -> IdeError {
    IdeError::new(ide_core::error::ErrorKind::Io, msg)
}

/// A directory's own mtime moving as entries come and go: polling sees it, the
/// OS watchers report only the entries (also seen, through that directory's watch).
fn is_dir_touch(event: &notify::Event) -> bool {
    matches!(event.kind, EventKind::Modify(_)) && event.paths.iter().all(|p| p.is_dir())
}

const MAX_WATCHES_HINT: &str = "the inotify watch limit is exhausted (fs.inotify.max_user_watches); raise it, e.g. \
                                `sudo sysctl -w fs.inotify.max_user_watches=524288`";

/// `io_error` with a fix hint when Linux's inotify limits are exhausted: one
/// instance per watcher (`EMFILE`, os error 24) or one watch per directory
/// (`ENOSPC`, mapped by notify to [`ErrorKind::MaxFilesWatch`]). A bare OS
/// error sends users off to search engines otherwise (issue #788).
fn watcher_error(what: &str, error: notify::Error) -> IdeError {
    let hint = match error.kind {
        ErrorKind::MaxFilesWatch => Some(MAX_WATCHES_HINT),
        ErrorKind::Io(ref e) if cfg!(target_os = "linux") && e.raw_os_error() == Some(24) => Some(
            "the inotify instance limit is exhausted (fs.inotify.max_user_instances); raise it, e.g. \
                  `sudo sysctl -w fs.inotify.max_user_instances=1024`",
        ),
        ErrorKind::Io(ref e) if cfg!(target_os = "linux") && e.raw_os_error() == Some(28) => Some(MAX_WATCHES_HINT),
        _ => None,
    };
    match hint {
        Some(hint) => io_error(format!("{what}: {error}; {hint}")),
        None => io_error(format!("{what}: {error}")),
    }
}

/// Shared with the notify callback (weakly) and the debounce thread.
struct DirState {
    filter: EventFilter,
    mode: WatchMode,
    watcher: Mutex<Option<Box<dyn notify::Watcher + Send>>>,
    watched: Mutex<HashSet<PathBuf>>,
    queue: Mutex<Vec<(notify::Event, Instant)>>,
    wake: Condvar,
    stop: AtomicBool,
}

impl DirState {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Debounce loop: finishes any deferred startup watches, then waits for a
    /// quiet period and processes each batch.
    fn run(&self, deferred: Vec<(PathBuf, bool)>, emit: impl Fn(&FsBatch)) {
        if !deferred.is_empty() {
            self.watch_stack(deferred, false, &mut Vec::new(), None);
        }
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
            // A scan may publish a path before its create event is delivered:
            // keep create + remove pairs so the consumer still sees the removal.
            let events: Vec<Event> = events.into_iter().map(|(e, _)| e).collect();
            let (mut batch, rule_dirs) = self.filter.batch_detailed(&events);
            if self.mode == WatchMode::PerDirectory {
                self.update_watches(&mut batch, &rule_dirs);
            }
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
        // VCS metadata directories (`.git`, `.git/worktrees/<name>`) need
        // watches too: a worktree registered in the main gitdir writes its
        // entry below `.git/worktrees`, and the events in a gitdir created
        // during this batch would otherwise never be seen.
        for path in &batch.vcs {
            if !self.watched.lock().contains(path) && path.symlink_metadata().is_ok_and(|m| m.is_dir()) {
                self.filter.gitignore.invalidate_tree(path);
                self.watch_tree(path, false, &mut discovered);
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
        let recursive =
            if self.mode == WatchMode::Recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
        match w.watch(dir, recursive) {
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
        self.watch_stack(vec![(dir.to_path_buf(), false)], report, found, None);
    }

    /// Watches up to `budget` directories synchronously and returns any
    /// remaining `(dir, parent_verified)` entries for background registration.
    fn watch_tree_bounded(&self, dir: &Path, budget: usize) -> Vec<(PathBuf, bool)> {
        self.watch_stack(vec![(dir.to_path_buf(), false)], false, &mut Vec::new(), Some(budget))
    }

    fn watch_stack(
        &self,
        mut stack: Vec<(PathBuf, bool)>,
        report: bool,
        found: &mut Vec<PathBuf>,
        budget: Option<usize>,
    ) -> Vec<(PathBuf, bool)> {
        let mut watched_now = 0;
        while let Some((dir, parent_ok)) = stack.pop() {
            if self.stopped() {
                break;
            }
            let should_watch =
                if parent_ok { self.filter.should_watch_child_dir(&dir) } else { self.filter.should_watch_dir(&dir) };
            if !should_watch || !self.add_watch(&dir) {
                continue;
            }
            watched_now += 1;
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
                if report && self.filter.is_reported(&path, is_dir) {
                    found.push(path.clone());
                }
                if is_dir {
                    stack.push((path, true));
                }
            }
            if budget.is_some_and(|max| watched_now >= max) {
                break;
            }
        }
        stack
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
        // FSEvents reports a deleted file's history as create, remove, then modify: a
        // modify can't bring back a path that went away, only a create can.
        (Some(Transient), Modified) => Transient,
        (Some(Created | Transient), Modified | Created) => Created,
        (Some(Created | Transient), Removed) => Transient,
        (Some(Removed), Created | Modified) => Modified,
        (Some(Modified), Created | Modified) => Modified,
        (Some(_), Removed) => Removed,
        (Some(p), Transient) => p,
    }
}

#[derive(Clone)]
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
            // `refs` and `worktrees` are directories whose creation is itself a
            // registration event (`git init`, the first `git worktree add`);
            // they must surface even though the depth below them is handled
            // separately.
            [one] => matches!(one.to_str(), Some("HEAD" | "index" | "packed-refs" | "refs" | "worktrees" | "info")),
            [first, ..] => {
                let metadata = *first == "refs"
                    // Linked-worktree gitdirs: a worktree added or removed below
                    // the project writes its HEAD here.
                    || *first == "worktrees";
                metadata && !rest.last().is_some_and(|l| l.to_string_lossy().ends_with(".lock"))
            }
            // The `.git` path itself: a linked worktree's `.git` is a plain
            // file (gitfile), and it is the only marker a new worktree writes
            // inside its own directory.
            [] => true,
        })
    }

    /// Whether a directory deserves its own watch in per-directory mode: not
    /// excluded or git-ignored; inside `.git` the directory itself, `refs/`
    /// and `worktrees/` (HEAD, index, refs and worktree metadata are what VCS
    /// refresh needs).
    pub fn should_watch_dir(&self, dir: &Path) -> bool {
        self.should_watch_dir_inner(dir, false)
    }

    /// Fast path when `dir`'s parent directory is already known to be watchable.
    fn should_watch_child_dir(&self, dir: &Path) -> bool {
        self.should_watch_dir_inner(dir, true)
    }

    fn should_watch_dir_inner(&self, dir: &Path, parent_ok: bool) -> bool {
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
                [first, ..] if *first == "worktrees" => true,
                [only] => *only == "info",
                _ => false,
            };
        }
        if parent_ok {
            !self.excludes.read().is_match(rel) && !self.gitignore.is_ignored_self(dir, true)
        } else {
            !self.excludes.read().is_excluded(rel) && !self.gitignore.is_ignored(dir, true)
        }
    }

    /// Whether a path found by scanning a new directory would be reported.
    fn is_reported(&self, path: &Path, is_dir: bool) -> bool {
        let Ok(rel) = path.strip_prefix(&self.root) else { return false };
        Self::git_internal(rel).is_none()
            && !self.excludes.read().is_excluded(rel)
            && !self.gitignore.is_ignored(path, is_dir)
    }

    /// Whether a filtered-out file is ignored by a rule on the file itself, in a folder
    /// that is neither excluded nor ignored.
    fn is_ignored_file(&self, path: &Path, rel: &Path) -> bool {
        !self.excludes.read().is_excluded(rel)
            && path.parent().is_some_and(|dir| dir == self.root || !self.gitignore.is_ignored(dir, true))
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
    pub fn batch(&self, events: &[Event]) -> FsBatch {
        self.batch_detailed(events).0
    }

    /// The coalesced, filtered batch plus the directories whose ignore rules
    /// changed (their cached matchers have been rebuilt already).
    pub fn batch_detailed(&self, events: &[Event]) -> (FsBatch, Vec<PathBuf>) {
        let mut changes: BTreeMap<PathBuf, Change> = BTreeMap::new();
        for ev in events {
            let paths = &ev.paths;
            match ev.kind {
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
        if events.iter().flat_map(|e| &e.paths).any(|p| p.ends_with(".git/info/exclude")) {
            self.gitignore.reload_repo_level();
            rule_dirs.insert(self.root.clone());
        }
        for dir in changes.iter().filter(|(_, c)| !matches!(c, Change::Modified | Change::Vcs)).map(|(p, _)| p) {
            // A directory that appeared or vanished takes its cached rules with it.
            self.gitignore.invalidate_tree(dir);
        }

        let mut batch = FsBatch::default();
        let mut excluded_dirs = BTreeSet::new();
        for (path, change) in changes {
            if change == Change::Vcs {
                batch.vcs.push(path);
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
                let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
                // Directories that match an exclude / gitignore rule themselves
                // still report their own create / remove / modify — the tree
                // needs to see `target/` or `node_modules/` appear (marked
                // excluded/ignored) instead of silently swallowing the events
                // `client install` produces.
                // A removed path has no metadata to tell file from directory;
                // let it through on the off chance it is the excluded directory
                // itself — reporting one extra file removal is harmless.
                let self_excluded = (is_dir || change == Change::Removed)
                    && (self.excludes.read().is_match(rel) || self.gitignore.is_ignored_self(&path, true));
                if !self_excluded && (self.excludes.read().is_excluded(rel) || self.gitignore.is_ignored(&path, is_dir))
                {
                    // Only a file appearing or going changes what the folder lists.
                    if change != Change::Modified {
                        excluded_dirs.extend(path.parent().map(Path::to_path_buf));
                    }
                    if !is_dir && self.is_ignored_file(&path, rel) {
                        batch.ignored.push(path);
                    }
                    continue;
                }
            }
            match change {
                Change::Created => batch.created.push(path),
                Change::Removed => batch.removed.push(path),
                _ => batch.modified.push(path),
            }
        }
        batch.excluded_dirs = excluded_dirs.into_iter().collect();
        (batch, rule_dirs.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, MetadataKind, RemoveKind};

    fn ev(kind: EventKind, paths: Vec<PathBuf>) -> Event {
        Event { kind, paths, attrs: Default::default() }
    }

    const TRANSIENT_PATHS: &[&str] = &["fresh.txt", "src/fresh.rs", "src/tasks/fresh.py"];

    /// Delivers a whole debounce window without depending on OS scheduling.
    struct TransientWatcher(Box<dyn notify::EventHandler>);

    impl notify::Watcher for TransientWatcher {
        fn new<F: notify::EventHandler>(handler: F, _: notify::Config) -> notify::Result<Self> {
            Ok(Self(Box::new(handler)))
        }

        fn watch(&mut self, root: &Path, _: RecursiveMode) -> notify::Result<()> {
            for rel in TRANSIENT_PATHS {
                for kind in [
                    EventKind::Create(CreateKind::File),
                    EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                    EventKind::Remove(RemoveKind::File),
                ] {
                    self.0.handle_event(Ok(Event::new(kind).add_path(root.join(rel))));
                }
            }
            for kind in [EventKind::Create(CreateKind::Folder), EventKind::Remove(RemoveKind::Folder)] {
                self.0.handle_event(Ok(Event::new(kind).add_path(root.join("new"))));
            }
            for (rel, kind) in [
                ("from.py", EventKind::Create(CreateKind::File)),
                ("from.py", EventKind::Modify(ModifyKind::Name(RenameMode::From))),
                ("to.py", EventKind::Modify(ModifyKind::Name(RenameMode::To))),
                ("to.py", EventKind::Remove(RemoveKind::File)),
            ] {
                self.0.handle_event(Ok(Event::new(kind).add_path(root.join(rel))));
            }
            for kind in [EventKind::Remove(RemoveKind::File), EventKind::Create(CreateKind::File)] {
                self.0.handle_event(Ok(Event::new(kind).add_path(root.join("kept.py"))));
            }
            Ok(())
        }

        fn unwatch(&mut self, _: &Path) -> notify::Result<()> {
            Ok(())
        }

        fn kind() -> WatcherKind {
            WatcherKind::NullWatcher
        }
    }

    #[test]
    fn debounce_preserves_transient_removals_and_atomic_replacements() {
        for mode in [WatchMode::Recursive, WatchMode::Flat, WatchMode::PerDirectory] {
            let tmp = tempfile::tempdir().unwrap();
            let root = dunce::canonicalize(tmp.path()).unwrap();
            std::fs::write(root.join("kept.py"), "class Kept: pass\n").unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            let emit: Emit = Arc::new(move |b| tx.send(b.clone()).unwrap());
            let _watcher = Watcher::start_queued::<TransientWatcher>(
                &root,
                EventFilter::new(root.clone(), &[]),
                emit,
                mode,
                notify::Config::default(),
            )
            .unwrap();
            let batch = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let removed: BTreeSet<_> = batch.removed.into_iter().collect();
            let expected =
                TRANSIENT_PATHS.iter().copied().chain(["new", "from.py", "to.py"]).map(|rel| root.join(rel)).collect();
            assert_eq!(removed, expected, "{mode:?}: scans may have already published transient paths");
            assert_eq!(batch.modified, vec![root.join("kept.py")]);
            assert!(batch.created.is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn native_watch_reports_quickly_removed_files() {
        for mode in [WatchMode::Recursive, WatchMode::Flat, WatchMode::PerDirectory] {
            let tmp = tempfile::tempdir().unwrap();
            let root = dunce::canonicalize(tmp.path()).unwrap();
            std::fs::create_dir_all(root.join("src/tasks")).unwrap();
            let batches: Arc<Mutex<Vec<FsBatch>>> = Arc::default();
            let watcher = {
                let batches = batches.clone();
                Watcher::start_with(
                    &root,
                    Vec::new(),
                    Arc::new(ide_core::NullSink),
                    Box::new(move |b| batches.lock().push(b.clone())),
                    mode,
                )
                .unwrap()
            };
            assert!(watcher.polling().is_none());
            assert_eq!(watcher.watch_count(), if mode == WatchMode::PerDirectory { 3 } else { 1 });
            let paths: Vec<_> = TRANSIENT_PATHS
                .iter()
                .filter(|rel| mode != WatchMode::Flat || !rel.contains('/'))
                .map(|rel| root.join(rel))
                .collect();
            for path in &paths {
                std::fs::write(path, "class FreshWidget:\n    pass\n").unwrap();
                std::fs::remove_file(path).unwrap();
            }
            assert!(
                wait_for(&batches, |b| paths.iter().all(|p| b.iter().any(|batch| batch.removed.contains(p)))),
                "{mode:?}: {:?}",
                batches.lock()
            );
            drop(watcher);
            let count = batches.lock().len();
            std::fs::write(root.join("after-drop.txt"), "x").unwrap();
            std::thread::sleep(DEBOUNCE * 2);
            assert_eq!(batches.lock().len(), count, "no callback after drop in {mode:?}");
        }
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
        assert_eq!(batch.vcs, vec![root.join(".git/HEAD"), root.join(".git/refs/heads/feature")]);
        assert_eq!(batch.modified, vec![root.join("kept.txt")]);
        assert_eq!(batch.removed, vec![root.join("from.txt"), root.join("gone.txt"), root.join("old.txt")]);
        assert_eq!(batch.ignored, vec![root.join("debug.log")], "ignored files are reported apart");
    }

    /// What FSEvents delivers when a file is deleted: its coalesced history flags as
    /// create, remove, then modify events, all for a path that no longer exists.
    #[test]
    fn fsevents_deletion_with_history_flags_is_a_removal() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let filter = EventFilter::new(root.clone(), &[]);
        let gone = root.join("src/Fresh.java");
        let batch = filter.batch(&[
            ev(EventKind::Create(CreateKind::File), vec![gone.clone()]),
            ev(EventKind::Remove(RemoveKind::File), vec![gone.clone()]),
            ev(EventKind::Modify(ModifyKind::Metadata(MetadataKind::Extended)), vec![gone.clone()]),
            ev(EventKind::Modify(ModifyKind::Data(DataChange::Content)), vec![gone.clone()]),
        ]);
        assert_eq!(batch.removed, vec![gone]);
        assert!(batch.created.is_empty() && batch.modified.is_empty());
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

    /// `client install` produces an excluded / ignored directory wholesale:
    /// the directory's own create passes through so the tree shows it appear
    /// (marked excluded/ignored), while everything inside stays filtered out.
    #[test]
    fn excluded_and_ignored_directories_report_themselves_but_not_contents() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), "dist\n*.log\n").unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::create_dir_all(root.join("dist/assets")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        for f in ["target/debug/out.o", "dist/app.js", "src/main.rs", "debug.log"] {
            std::fs::write(root.join(f), "x").unwrap();
        }
        let filter = EventFilter::new(root.clone(), &["**/target".into()]);
        let create_dir = EventKind::Create(CreateKind::Folder);
        let create_file = EventKind::Create(CreateKind::File);

        // The ignored / excluded directory itself is reported.
        let batch = filter.batch(&[ev(create_dir, vec![root.join("target")]), ev(create_dir, vec![root.join("dist")])]);
        assert_eq!(batch.created, vec![root.join("dist"), root.join("target")]);

        // Everything inside the ignored / excluded directories stays filtered,
        // as do files matching ignore patterns at the project root.
        let batch = filter.batch(&[
            ev(create_file, vec![root.join("target/debug/out.o")]),
            ev(create_file, vec![root.join("dist/app.js")]),
            ev(create_file, vec![root.join("debug.log")]),
        ]);
        assert!(batch.created.is_empty() && batch.modified.is_empty() && batch.removed.is_empty(), "{batch:?}");
        assert_eq!(batch.excluded_dirs, vec![root.clone(), root.join("dist"), root.join("target/debug")]);
        assert_eq!(batch.ignored, vec![root.join("debug.log")], "only the ignored file outside ignored folders");

        // An ignored file's edit and removal reach the index too (nothing else changes).
        let modify = EventKind::Modify(ModifyKind::Data(DataChange::Content));
        let batch = filter.batch(&[ev(modify, vec![root.join("debug.log")])]);
        assert_eq!(batch.ignored, vec![root.join("debug.log")]);
        assert!(!batch.is_empty() && batch.excluded_dirs.is_empty());
        std::fs::remove_file(root.join("debug.log")).unwrap();
        let batch = filter.batch(&[
            ev(EventKind::Remove(RemoveKind::File), vec![root.join("debug.log")]),
            ev(EventKind::Remove(RemoveKind::File), vec![root.join("dist/app.js")]),
        ]);
        // A removed path can't tell file from folder: it goes out as a removal, as before.
        assert_eq!(batch.removed, vec![root.join("debug.log")]);

        // Sibling files in unignored directories still come through.
        let batch = filter.batch(&[ev(create_file, vec![root.join("src/main.rs")])]);
        assert_eq!(batch.created, vec![root.join("src/main.rs")]);

        // Removing the ignored / excluded directory reports the directory.
        std::fs::remove_dir_all(root.join("target")).unwrap();
        let batch = filter.batch(&[ev(EventKind::Remove(RemoveKind::Folder), vec![root.join("target")])]);
        assert_eq!(batch.removed, vec![root.join("target")]);
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
        // The `.git` path itself: a repo dir, or a linked worktree's gitfile.
        assert_eq!(g(".git"), Some(true));
        assert_eq!(g("wt/.git"), Some(true));
        // Linked-worktree gitdir metadata below the main repository.
        assert_eq!(g(".git/worktrees/wt/HEAD"), Some(true));
        assert_eq!(g(".git/worktrees/wt/index.lock"), Some(false));
        // The depth-1 directories themselves: `git init` or the first
        // `git worktree add` creates them in an already-watched gitdir.
        assert_eq!(g(".git/refs"), Some(true));
        assert_eq!(g(".git/worktrees"), Some(true));
        assert_eq!(g(".git/info"), Some(true));
        assert_eq!(g(".git/objects"), Some(false));
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
        let touch = |paths: &[&str]| -> Vec<Event> { paths.iter().map(|p| ev(modify, vec![root.join(p)])).collect() };
        let (batch, rules) = filter.batch_detailed(&touch(&["pkg/a.tmp", "pkg/gen/x.rs", "pkg/keep.rs", "b.tmp"]));
        assert_eq!(batch.modified, vec![root.join("b.tmp"), root.join("pkg/keep.rs")]);
        assert_eq!(batch.ignored, vec![root.join("pkg/a.tmp")], "nested rules, but not inside ignored folders");
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
        assert!(batch.modified.is_empty() && batch.vcs.is_empty(), "{batch:?}");
        assert_eq!(batch.ignored, vec![root.join("b.tmp")]);
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
        // Linked-worktree gitdirs are watched so worktrees added below the
        // project while it is open are discovered.
        assert!(w(".git/worktrees") && w(".git/worktrees/wt") && w(".git/worktrees/wt/rebase-merge"));
        assert!(!filter.should_watch_dir(Path::new("/elsewhere")));
        // Excludes are replaced in place (Watcher::set_excludes).
        *filter.excludes.write() = ExcludeMatcher::new(&["gen".into()]);
        assert!(w("node_modules") && !w("src/gen"));
    }

    fn watcher_state(w: &Watcher) -> &DirState {
        &w.inner.state
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
    fn per_directory_mode_watches_the_rest_of_a_large_tree_after_start() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let dirs = SYNC_WATCH_BUDGET + 40;
        for i in 0..dirs {
            std::fs::create_dir_all(root.join(format!("d{i:03}"))).unwrap();
        }
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        let batches: Arc<Mutex<Vec<FsBatch>>> = Arc::default();
        let sink: SharedSink = Arc::new(|_e: IdeEvent| {});
        let watcher = {
            let batches = batches.clone();
            Watcher::start_with(
                &root,
                vec!["**/node_modules".into()],
                sink,
                Box::new(move |b| batches.lock().push(b.clone())),
                WatchMode::PerDirectory,
            )
            .unwrap()
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while watcher.watch_count() < dirs + 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        // root and every d*, but not node_modules
        assert_eq!(watcher.watch_count(), dirs + 1);
        std::thread::sleep(Duration::from_millis(200));
        for i in [0, dirs - 1] {
            let file = root.join(format!("d{i:03}/f.rs"));
            std::fs::write(&file, "x").unwrap();
            assert!(wait_for(&batches, |b| all_paths(b).contains(&file)), "{file:?}");
        }
    }

    #[test]
    fn per_directory_mode_follows_worktree_registrations() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        for d in ["wt", ".git/refs/heads"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        // The worktree's gitfile is written before any watch on the worktree
        // directory could register it — the same window a real
        // `git worktree add` runs into.
        std::fs::write(root.join("wt/.git"), "gitdir: ../.git/worktrees/wt\n").unwrap();
        let batches: Arc<Mutex<Vec<FsBatch>>> = Arc::default();
        let sink: SharedSink = Arc::new(|_e: IdeEvent| {});
        let watcher = {
            let batches = batches.clone();
            Watcher::start_with(
                &root,
                Vec::new(),
                sink,
                Box::new(move |b| batches.lock().push(b.clone())),
                WatchMode::PerDirectory,
            )
            .unwrap()
        };
        // Registering the worktree in the main gitdir surfaces as VCS metadata
        // (the deepest directory itself may be created before its parent gains
        // a watch, so `.git/worktrees` is the event that reliably fires)...
        std::fs::create_dir_all(root.join(".git/worktrees/wt")).unwrap();
        assert!(
            wait_for(&batches, |b| b.iter().any(|b| b.vcs.contains(&root.join(".git/worktrees")))),
            "{:?}",
            batches.lock()
        );
        // ...and the registered gitdir gains a watch, so writes inside it are
        // seen even though nothing reported the directory itself.
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(root.join(".git/worktrees/wt/HEAD"), "ref: refs/heads/topic\n").unwrap();
        assert!(
            wait_for(&batches, |b| b.iter().any(|b| b.vcs.contains(&root.join(".git/worktrees/wt/HEAD")))),
            "{:?}",
            batches.lock()
        );
        drop(watcher);
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

    /// The fallback used when the OS watcher cannot start.
    fn polling_watcher(root: &Path, excludes: Vec<String>, batches: Arc<Mutex<Vec<FsBatch>>>) -> Watcher {
        let filter = EventFilter::new(root.to_path_buf(), &excludes);
        let (excludes, rules) = (filter.excludes.clone(), filter.gitignore.clone());
        let emit: Emit = Arc::new(move |b: &FsBatch| batches.lock().push(b.clone()));
        let inner = Watcher::start_polling(root, filter, emit, WatchMode::default()).unwrap();
        Watcher { inner, excludes, rules, polling: Some("cannot start file watcher".into()) }
    }

    #[test]
    fn polling_skips_excluded_dirs_and_follows_new_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        for d in ["src/a", "node_modules/x"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let batches: Arc<Mutex<Vec<FsBatch>>> = Arc::default();
        let watcher = polling_watcher(&root, vec!["**/node_modules".into()], batches.clone());
        // root, src, src/a
        assert_eq!(watcher.watch_count(), 3);

        std::fs::write(root.join("node_modules/x/z.js"), "x").unwrap();
        std::fs::write(root.join("src/a/f.rs"), "x").unwrap();
        std::fs::create_dir_all(root.join("src/new/inner")).unwrap();
        std::fs::write(root.join("src/new/inner/g.rs"), "x").unwrap();
        assert!(
            wait_for(&batches, |b| {
                let paths = all_paths(b);
                paths.contains(&root.join("src/a/f.rs")) && paths.contains(&root.join("src/new/inner/g.rs"))
            }),
            "{:?}",
            batches.lock()
        );
        let paths = all_paths(&batches.lock());
        assert!(!paths.iter().any(|p| p.starts_with(root.join("node_modules"))), "{paths:?}");
        // Folders whose entries changed aren't reported as modified, as with inotify.
        assert!(!paths.contains(&root.join("src")) && !paths.contains(&root.join("src/a")), "{paths:?}");
        assert_eq!(watcher.watch_count(), 5);

        // Later writes inside a new folder are seen through its own poll.
        std::fs::write(root.join("src/new/inner/h.rs"), "x").unwrap();
        assert!(wait_for(&batches, |b| all_paths(b).contains(&root.join("src/new/inner/h.rs"))));
    }

    #[test]
    fn ordinary_watcher_errors_keep_the_bare_message() {
        let other = notify::Error::io(std::io::Error::other("no space left"));
        assert_eq!(
            watcher_error("cannot start file watcher", other).message,
            "cannot start file watcher: no space left"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn inotify_limits_get_a_sysctl_hint() {
        let emfile = notify::Error::io(std::io::Error::from_raw_os_error(24));
        let msg = watcher_error("cannot start file watcher", emfile).message;
        assert!(msg.contains("os error 24"), "{msg}");
        assert!(msg.contains("max_user_instances"), "{msg}");
        let enospc = notify::Error::io(std::io::Error::from_raw_os_error(28));
        assert!(watcher_error("cannot watch /proj", enospc).message.contains("max_user_watches"));
        let max_files = notify::Error::new(ErrorKind::MaxFilesWatch);
        assert!(watcher_error("cannot watch /proj", max_files).message.contains("max_user_watches"));
        let other = notify::Error::io(std::io::Error::from_raw_os_error(13));
        assert!(!watcher_error("cannot start file watcher", other).message.contains("inotify"));
    }
}
