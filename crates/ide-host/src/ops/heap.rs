//! Heap snapshots for the debugger's JVM Memory view: captured from a debug session or opened from
//! an `.hprof`, analyzed into an index, then queried, compared, saved and closed. A snapshot
//! belongs to the window that made it and closes with that window's project.

use crate::Host;
use crate::ops::Channel;
use crate::rpc::Dispatcher;
use ide_core::{CancellationToken, DebugSessionId, IdeError, IdeResult, IpcPath, RequestId};
use ide_dap::{JvmHeapOutcome, JvmHeapUnavailable};
use ide_heap::{AnalyzeOptions, HeapError, HeapOrigin, OpenSnapshot};
pub use ide_heap::{
    HeapClassDiff, HeapClassRow, HeapObjectPage, HeapObjectRef, HeapPhase, HeapRootPath, HeapSnapshotId,
    HeapSnapshotInfo,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::cell::Cell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Shortest gap between two progress messages of one phase.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Longest each of [`shutdown`]'s two waits lasts; `openidea-server` gives the whole host
/// shutdown 10 s.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HeapProgress {
    Dumping,
    Analyzing { phase: HeapPhase, done: u64, total: u64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HeapCaptureResult {
    Ready { snapshot: HeapSnapshotInfo },
    Unavailable { reason: JvmHeapUnavailable },
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HeapOpenResult {
    Ready {
        snapshot: HeapSnapshotInfo,
    },
    /// Bytes, for the index next to the dump.
    NotEnoughDiskSpace {
        needed: u64,
        available: u64,
    },
    Cancelled,
}

/// Dumps the session's JVM into a new snapshot directory and analyzes the dump there; cancel with
/// `request`. Anything but `Ready` leaves no directory behind.
pub async fn debug_heap_capture(
    host: &Host,
    window: &str,
    session: DebugSessionId,
    request: RequestId,
    on_progress: Channel<HeapProgress>,
) -> IdeResult<HeapCaptureResult> {
    host.require_trust(window)?;
    let cancel = host.begin_project_request(window, request);
    let running = Running::begin(host, request, &cancel);
    let result = capture(host, window, session, &cancel, &on_progress).await;
    drop(running);
    host.end_request(request);
    result
}

async fn capture(
    host: &Host,
    window: &str,
    session: DebugSessionId,
    cancel: &CancellationToken,
    on_progress: &Channel<HeapProgress>,
) -> IdeResult<HeapCaptureResult> {
    if cancel.is_cancelled() {
        return Ok(HeapCaptureResult::Cancelled);
    }
    let dir = new_snapshot_dir(host).await?;
    let _ = on_progress.send(HeapProgress::Dumping);
    // `jvm_heap_dump` deletes the directory itself on every outcome but `Ready`.
    let dump = match host.debugger.jvm_heap_dump(session, dir.clone(), cancel.clone()).await {
        Ok(JvmHeapOutcome::Ready(dump)) => dump,
        Ok(JvmHeapOutcome::Unavailable(reason)) => return Ok(HeapCaptureResult::Unavailable { reason }),
        Ok(JvmHeapOutcome::Cancelled) => return Ok(HeapCaptureResult::Cancelled),
        Err(e) => {
            remove_dir(host, dir).await;
            return Err(e);
        }
    };
    let origin = HeapOrigin::Captured {
        session,
        pid: dump.pid,
        java_version: dump.java_version,
        taken_while_suspended: dump.taken_while_suspended,
        dump_ms: dump.dump_ms,
    };
    let options = AnalyzeOptions {
        histogram: Some(dump.histogram).filter(|h| !h.is_empty()),
        vm_flags: Some(dump.vm_flags).filter(|f| !f.is_empty()),
        java_major: Some(dump.java_major).filter(|&v| v > 0),
        in_memory: false,
    };
    // The capture already checked the space for the dump and its index before dumping.
    let analyzed = analyze(host, window, origin, dump.path, dir, options, false, cancel, on_progress).await?;
    Ok(match analyzed {
        Analyzed::Ready(snapshot) => HeapCaptureResult::Ready { snapshot },
        Analyzed::NotEnoughDiskSpace { needed, available } => {
            HeapCaptureResult::Unavailable { reason: JvmHeapUnavailable::NotEnoughDiskSpace { needed, available } }
        }
        Analyzed::Cancelled => HeapCaptureResult::Cancelled,
    })
}

/// Analyzes the `.hprof` at `path` into a new snapshot directory; the file itself is never
/// changed or deleted. Cancel with `request`.
pub async fn debug_heap_open(
    host: &Host,
    window: &str,
    path: IpcPath,
    request: RequestId,
    on_progress: Channel<HeapProgress>,
) -> IdeResult<HeapOpenResult> {
    host.require_trust(window)?;
    let cancel = host.begin_project_request(window, request);
    let running = Running::begin(host, request, &cancel);
    let result = open(host, window, path.into_path_buf(), &cancel, &on_progress).await;
    drop(running);
    host.end_request(request);
    result
}

/// The captures and opens in progress, so [`shutdown`] can cancel them and wait for them to delete
/// their directories.
#[derive(Default)]
pub(crate) struct HeapRequests(parking_lot::Mutex<RequestsState>);

#[derive(Default)]
struct RequestsState {
    /// Set by [`shutdown`]: what begins afterwards starts out cancelled.
    closed: bool,
    running: HashMap<RequestId, CancellationToken>,
}

/// One capture or open, from its start until it has cleaned up after itself.
struct Running<'a> {
    host: &'a Host,
    request: RequestId,
}

impl<'a> Running<'a> {
    fn begin(host: &'a Host, request: RequestId, cancel: &CancellationToken) -> Self {
        let mut state = host.heap_requests.0.lock();
        if state.closed {
            cancel.cancel();
        } else {
            state.running.insert(request, cancel.clone());
        }
        Self { host, request }
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.host.heap_requests.0.lock().running.remove(&self.request);
    }
}

async fn open(
    host: &Host,
    window: &str,
    path: PathBuf,
    cancel: &CancellationToken,
    on_progress: &Channel<HeapProgress>,
) -> IdeResult<HeapOpenResult> {
    if cancel.is_cancelled() {
        return Ok(HeapOpenResult::Cancelled);
    }
    let dir = new_snapshot_dir(host).await?;
    let origin = HeapOrigin::File { path: path.clone().into() };
    // The snapshot maps its dump for as long as it is open; a file that something else truncates or
    // rewrites meanwhile would crash the app, so it works on a private copy (a clone on APFS / btrfs).
    let copy = {
        let (path, dir) = (path.clone(), dir.clone());
        host.blocking(move || private_copy(&path, &dir)).await
    };
    let dump = match copy {
        Ok(Ok(dump)) => dump,
        Ok(Err((needed, available))) => {
            remove_dir(host, dir).await;
            return Ok(HeapOpenResult::NotEnoughDiskSpace { needed, available });
        }
        Err(e) => {
            remove_dir(host, dir).await;
            return Err(e);
        }
    };
    let analyzed =
        analyze(host, window, origin, dump, dir, AnalyzeOptions::default(), true, cancel, on_progress).await?;
    Ok(match analyzed {
        Analyzed::Ready(snapshot) => HeapOpenResult::Ready { snapshot },
        Analyzed::NotEnoughDiskSpace { needed, available } => HeapOpenResult::NotEnoughDiskSpace { needed, available },
        Analyzed::Cancelled => HeapOpenResult::Cancelled,
    })
}

enum Analyzed {
    Ready(HeapSnapshotInfo),
    NotEnoughDiskSpace { needed: u64, available: u64 },
    Cancelled,
}

/// Indexes `dump` into `dir` and registers the snapshot for `window`. Anything but `Ready` deletes
/// `dir`, a captured dump inside it included.
#[allow(clippy::too_many_arguments)]
async fn analyze(
    host: &Host,
    window: &str,
    origin: HeapOrigin,
    dump: PathBuf,
    dir: PathBuf,
    options: AnalyzeOptions,
    check_disk: bool,
    cancel: &CancellationToken,
    on_progress: &Channel<HeapProgress>,
) -> IdeResult<Analyzed> {
    let indexed = {
        let (dump, dir, cancel, progress) = (dump.clone(), dir.clone(), cancel.clone(), on_progress.clone());
        tokio::task::spawn_blocking(move || {
            let free = || if check_disk { ide_heap::free_bytes(&dir) } else { None };
            ide_heap::analyze(&dump, &dir, options, &reporter(&progress, free), &cancel)
        })
        .await
    };
    let failed = match indexed {
        Ok(Ok(index)) => {
            let info = HeapSnapshotInfo {
                id: HeapSnapshotId(0),
                label: origin.label(),
                summary: index.summary().clone(),
                origin,
                created_ms: now_ms(),
            };
            let info = host.heap.insert(|_| OpenSnapshot::new(info, index, dir, dump));
            host.heap_windows.lock().insert(info.id, host.owner_window(window).to_owned());
            // A project close cancels the request before it closes the window's snapshots, so one
            // registered after that close is caught here.
            if cancel.is_cancelled() {
                close(host, info.id).await?;
                return Ok(Analyzed::Cancelled);
            }
            return Ok(Analyzed::Ready(info));
        }
        Ok(Err(HeapError::Cancelled)) => Ok(Analyzed::Cancelled),
        Ok(Err(HeapError::NotEnoughDiskSpace { needed, available })) => {
            Ok(Analyzed::NotEnoughDiskSpace { needed, available })
        }
        Ok(Err(e)) => Err(IdeError::invalid(format!("{e}"))),
        Err(e) => Err(IdeError::internal(format!("heap analysis failed: {e}"))),
    };
    remove_dir(host, dir).await;
    failed
}

/// The progress callback of an analysis: sends a phase's first report and then at most one every
/// [`PROGRESS_INTERVAL`]. Once the dump's objects are counted (the first `Linking` report), it
/// fails with `NotEnoughDiskSpace` when `free` reports less than their index needs.
fn reporter<'a>(
    progress: &'a Channel<HeapProgress>,
    free: impl Fn() -> Option<u64> + 'a,
) -> impl Fn(HeapPhase, u64, u64) -> Result<(), HeapError> + 'a {
    let last: Cell<Option<(HeapPhase, Instant)>> = Cell::new(None);
    move |phase, done, total| {
        let now = Instant::now();
        let previous = last.get();
        if phase == HeapPhase::Linking
            && previous.is_none_or(|(p, _)| p != HeapPhase::Linking)
            && let Some(available) = free()
        {
            let needed = ide_heap::index_need(total);
            if available < needed {
                return Err(HeapError::NotEnoughDiskSpace { needed, available });
            }
        }
        if previous.is_none_or(|(p, at)| p != phase || now.duration_since(at) >= PROGRESS_INTERVAL) {
            last.set(Some((phase, now)));
            let _ = progress.send(HeapProgress::Analyzing { phase, done, total });
        }
        Ok(())
    }
}

/// The class table of a snapshot.
pub async fn debug_heap_classes(host: &Host, window: &str, snapshot: HeapSnapshotId) -> IdeResult<Vec<HeapClassRow>> {
    let snapshot = open_snapshot(host, window, snapshot)?;
    host.blocking(move || Ok(snapshot.index().class_rows())).await
}

/// A page of the dominator tree; see [`ide_heap::HeapIndex::dominated`] for what `parent` and
/// `class_index` select.
pub async fn debug_heap_dominators(
    host: &Host,
    window: &str,
    snapshot: HeapSnapshotId,
    parent: Option<HeapObjectRef>,
    class_index: Option<u32>,
    offset: u32,
    limit: u32,
) -> IdeResult<HeapObjectPage> {
    let snapshot = open_snapshot(host, window, snapshot)?;
    host.blocking(move || Ok(snapshot.index().dominated(parent, class_index, offset, limit))).await
}

/// The shortest path from `object` to a GC root; `None` when it is unreachable.
pub async fn debug_heap_path(
    host: &Host,
    window: &str,
    snapshot: HeapSnapshotId,
    object: HeapObjectRef,
) -> IdeResult<Option<HeapRootPath>> {
    let snapshot = open_snapshot(host, window, snapshot)?;
    host.blocking(move || Ok(snapshot.index().path_to_root(object))).await
}

/// Class-by-class differences from `base` to `current`.
pub async fn debug_heap_compare(
    host: &Host,
    window: &str,
    base: HeapSnapshotId,
    current: HeapSnapshotId,
) -> IdeResult<Vec<HeapClassDiff>> {
    let base = open_snapshot(host, window, base)?;
    let current = open_snapshot(host, window, current)?;
    host.blocking(move || Ok(ide_heap::compare(base.index(), current.index()))).await
}

/// Copies the snapshot's dump to `path`, replacing a file there (the UI has asked).
pub async fn debug_heap_save(host: &Host, window: &str, snapshot: HeapSnapshotId, path: IpcPath) -> IdeResult<()> {
    let snapshot = open_snapshot(host, window, snapshot)?;
    let target = path.into_path_buf();
    host.blocking(move || copy_replacing(&snapshot.dump, &target)).await
}

/// Forgets the snapshot and deletes its directory once no query is using it.
pub async fn debug_heap_close(host: &Host, window: &str, snapshot: HeapSnapshotId) -> IdeResult<()> {
    open_snapshot(host, window, snapshot)?;
    close(host, snapshot).await
}

async fn close(host: &Host, id: HeapSnapshotId) -> IdeResult<()> {
    let closed = take(host, id);
    // Usually the last reference: dropping it deletes files.
    host.blocking(move || {
        drop(closed);
        Ok(())
    })
    .await
}

/// Forgets the snapshot and returns it, so the caller chooses the thread that deletes its files.
fn take(host: &Host, id: HeapSnapshotId) -> Option<Arc<OpenSnapshot>> {
    host.heap_windows.lock().remove(&id);
    let snapshot = host.heap.get(id);
    host.heap.close(id);
    snapshot
}

/// Closes the snapshots `window` owns; their directories are deleted on the blocking pool.
pub(crate) fn close_window_snapshots(host: &Host, window: &str) {
    let owner = host.owner_window(window);
    let ids: Vec<HeapSnapshotId> =
        host.heap_windows.lock().iter().filter(|(_, w)| *w == owner).map(|(id, _)| *id).collect();
    let closed: Vec<Arc<OpenSnapshot>> = ids.into_iter().filter_map(|id| take(host, id)).collect();
    if !closed.is_empty() {
        host.runtime.spawn_blocking(move || drop(closed));
    }
}

/// For a process that exits without dropping the host (the remote server): cancels the captures
/// and opens in progress and waits for them, closes every snapshot, then removes what is left of
/// this process's snapshot directories. Each wait gives up after [`SHUTDOWN_WAIT`] (a stuck
/// analysis or delete).
pub(crate) async fn shutdown(host: &Host) {
    shutdown_within(host, SHUTDOWN_WAIT).await;
}

async fn shutdown_within(host: &Host, wait: Duration) {
    let deadline = tokio::time::Instant::now() + wait;
    {
        let mut state = host.heap_requests.0.lock();
        state.closed = true;
        for token in state.running.values() {
            token.cancel();
        }
    }
    let ids: Vec<HeapSnapshotId> = host.heap.list().into_iter().map(|info| info.id).collect();
    let closed: Vec<Arc<OpenSnapshot>> = ids.into_iter().filter_map(|id| take(host, id)).collect();
    while !host.heap_requests.0.lock().running.is_empty() {
        if tokio::time::Instant::now() >= deadline {
            tracing::warn!("heap captures or opens still running at shutdown");
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let root = host.heap.root().to_path_buf();
    let me = std::process::id();
    let cleanup = host.runtime.spawn_blocking(move || {
        drop(closed);
        // Directories of work that did not finish in time count as abandoned, like a dead host's.
        ide_heap::remove_stale(&root, |pid| pid != me && ide_core::process::process_alive(pid));
    });
    if tokio::time::timeout(wait, cleanup).await.is_err() {
        tracing::warn!("heap snapshot directories were not deleted within {wait:?}");
    }
}

/// Every op that takes a snapshot id goes through here, so none skips the trust check.
fn open_snapshot(host: &Host, window: &str, id: HeapSnapshotId) -> IdeResult<Arc<OpenSnapshot>> {
    host.require_trust(window)?;
    let owned = host.heap_windows.lock().get(&id).is_some_and(|w| w == host.owner_window(window));
    owned
        .then(|| host.heap.get(id))
        .flatten()
        .ok_or_else(|| IdeError::not_found(format!("heap snapshot {} is not open", id.0)))
}

async fn new_snapshot_dir(host: &Host) -> IdeResult<PathBuf> {
    let root = host.heap.root().to_path_buf();
    host.blocking(move || Ok(ide_heap::create_snapshot_dir(&root)?)).await
}

async fn remove_dir(host: &Host, dir: PathBuf) {
    let _ = host
        .blocking(move || {
            if let Err(e) = std::fs::remove_dir_all(&dir)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!("could not delete heap snapshot directory {}: {e}", dir.display());
            }
            Ok(())
        })
        .await;
}

/// Copies an opened dump into its snapshot directory; `Err((needed, available))` when the disk
/// can't hold the copy.
fn private_copy(source: &Path, dir: &Path) -> IdeResult<Result<PathBuf, (u64, u64)>> {
    let needed = std::fs::metadata(source)?.len();
    if let Some(available) = ide_heap::free_bytes(dir)
        && available < needed
    {
        return Ok(Err((needed, available)));
    }
    let target = dir.join("opened.hprof");
    std::fs::copy(source, &target)?;
    Ok(Ok(target))
}

/// Written beside `target` and renamed over it: `target` may be the dump of an open snapshot,
/// whose index maps that file and must keep reading the old bytes.
fn copy_replacing(source: &Path, target: &Path) -> IdeResult<()> {
    let name =
        target.file_name().ok_or_else(|| IdeError::invalid(format!("{} is not a file path", target.display())))?;
    let partial = target.with_file_name(format!(".{}.{}.tmp", name.to_string_lossy(), uuid::Uuid::new_v4()));
    let copied = std::fs::copy(source, &partial).and_then(|_| std::fs::rename(&partial, target));
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&partial);
        return Err(e.into());
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("debug_heap_capture", |c| async move {
        debug_heap_capture(&c.host, &c.window, c.arg("session")?, c.arg("request")?, c.sender("onProgress")?).await
    });
    d.add("debug_heap_open", |c| async move {
        debug_heap_open(&c.host, &c.window, c.arg("path")?, c.arg("request")?, c.sender("onProgress")?).await
    });
    d.add("debug_heap_classes", |c| async move { debug_heap_classes(&c.host, &c.window, c.arg("snapshot")?).await });
    d.add("debug_heap_dominators", |c| async move {
        debug_heap_dominators(
            &c.host,
            &c.window,
            c.arg("snapshot")?,
            c.arg("parent")?,
            c.arg("classIndex")?,
            c.arg("offset")?,
            c.arg("limit")?,
        )
        .await
    });
    d.add("debug_heap_path", |c| async move {
        debug_heap_path(&c.host, &c.window, c.arg("snapshot")?, c.arg("object")?).await
    });
    d.add("debug_heap_compare", |c| async move {
        debug_heap_compare(&c.host, &c.window, c.arg("base")?, c.arg("current")?).await
    });
    d.add("debug_heap_save", |c| async move {
        debug_heap_save(&c.host, &c.window, c.arg("snapshot")?, c.arg("path")?).await
    });
    d.add("debug_heap_close", |c| async move { debug_heap_close(&c.host, &c.window, c.arg("snapshot")?).await });
}

#[cfg(test)]
mod tests;
