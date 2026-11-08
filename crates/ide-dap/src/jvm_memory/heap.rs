//! A heap dump of a debugged JVM, written over its attach listener into a snapshot directory.

use super::snapshot::{AttachProbe, JdkProbe, attach_failure, gone, pick_jvm_pid};
use super::{
    JvmMemoryState, JvmMemoryUnavailable, JvmTarget, histogram_pid, keep_found, lookup, resolve_jvm,
    safe_while_suspended, session_target,
};
use crate::session::Session;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_jvm_attach::{AttachError, HeapDumpReply};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const DUMP_FILE: &str = "dump.hprof";
/// For a refusal whose reply holds no reason: empty, or only the line announcing the dump.
const NO_REASON: &str = "the JVM wrote no heap dump and gave no reason";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmHeapUnavailable {
    /// The reason a class table could not be read applies to the dump too.
    Memory {
        reason: JvmMemoryUnavailable,
    },
    /// Bytes.
    NotEnoughDiskSpace {
        needed: u64,
        available: u64,
    },
    DumpFailed {
        message: String,
    },
    DumpTimedOut {
        seconds: u32,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct JvmHeapDump {
    pub path: PathBuf,
    /// The class histogram taken just before the dump.
    pub histogram: Vec<ide_heap::HistogramEntry>,
    /// Raw `VM.flags`; empty when the JVM did not answer.
    pub vm_flags: String,
    /// 0 when unknown.
    pub java_major: u32,
    /// Empty when unknown.
    pub java_version: String,
    pub pid: u32,
    pub taken_while_suspended: bool,
    pub dump_ms: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum JvmHeapOutcome {
    Ready(JvmHeapDump),
    /// The snapshot directory has been deleted.
    Unavailable(JvmHeapUnavailable),
    /// The snapshot directory has been deleted.
    Cancelled,
}

pub(crate) async fn session_heap_dump(
    session: Arc<Session>,
    dir: PathBuf,
    cancel: CancellationToken,
) -> IdeResult<JvmHeapOutcome> {
    let launched = histogram_pid(&session);
    let capture = {
        let (dir, cancel) = (dir.clone(), cancel.clone());
        async move {
            let target = session_target(&session, launched);
            let probe = |suspended| -> Arc<dyn AttachProbe> { Arc::new(JdkProbe { suspended }) };
            heap_dump_with(&session.jvm_memory, || capture_suspended(&session), probe, target, dir, cancel).await
        }
    };
    detached(capture, dir, cancel).await
}

/// The JVM can be suspended before the adapter reports the stop, so a session with a JDWP link
/// also counts the link's view.
pub(super) fn capture_suspended(session: &Session) -> bool {
    session.suspended.get()
        || session
            .jdwp_link
            .lock()
            .as_ref()
            .is_some_and(|link| matches!(link.state(), ide_jdwp::LinkState::Suspended { .. }))
}

/// Runs `capture` in a task of its own, so a caller that stops waiting cannot release the
/// session's lock while the JVM is still writing the dump and let a class-table request run
/// next to it. On `cancel` returns at once and deletes `dir`.
pub(super) async fn detached(
    capture: impl Future<Output = IdeResult<JvmHeapOutcome>> + Send + 'static,
    dir: PathBuf,
    cancel: CancellationToken,
) -> IdeResult<JvmHeapOutcome> {
    let task = tokio::spawn(capture);
    tokio::select! {
        joined = task => joined.map_err(|e| IdeError::internal(format!("JVM heap dump failed: {e}")))?,
        () = cancel.cancelled() => {
            discard_later(dir).await;
            Ok(JvmHeapOutcome::Cancelled)
        }
    }
}

/// Holds `state`'s lock throughout, as a class-table request does; `suspended` and then `probe`
/// are read once it is held. Anything but `Ready` deletes `dir`.
pub(super) async fn heap_dump_with(
    state: &tokio::sync::Mutex<JvmMemoryState>,
    suspended: impl FnOnce() -> bool,
    probe: impl FnOnce(bool) -> Arc<dyn AttachProbe>,
    target: JvmTarget<'_>,
    dir: PathBuf,
    cancel: CancellationToken,
) -> IdeResult<JvmHeapOutcome> {
    // The capture's histogram never becomes the Memory view's baseline, so the state is unused.
    let _turn = state.lock().await;
    let outcome = capture(suspended(), probe, target, dir.clone(), cancel).await;
    if !matches!(outcome, Ok(JvmHeapOutcome::Ready(_))) {
        discard_later(dir).await;
    }
    outcome
}

async fn capture(
    suspended: bool,
    probe: impl FnOnce(bool) -> Arc<dyn AttachProbe>,
    target: JvmTarget<'_>,
    dir: PathBuf,
    cancel: CancellationToken,
) -> IdeResult<JvmHeapOutcome> {
    if cancel.is_cancelled() {
        return Ok(JvmHeapOutcome::Cancelled);
    }
    let lookup = match lookup(target) {
        Ok(lookup) => lookup,
        Err(reason) => return Ok(memory(reason)),
    };
    let probe = probe(suspended);
    let (found, outcome) = tokio::task::spawn_blocking(move || match resolve_jvm(lookup, &*probe, suspended) {
        Ok((tree, found)) => (found, take_heap_dump(&*probe, &tree, suspended, &dir, &cancel)),
        Err(reason) => (None, Ok(memory(reason))),
    })
    .await
    .map_err(|e| IdeError::internal(format!("JVM heap dump failed: {e}")))?;
    keep_found(target, found);
    outcome
}

/// `tree` starts with the session's reported pid, followed by its descendants. Anything but
/// `Ready` deletes `dir`.
pub(crate) fn take_heap_dump(
    probe: &dyn AttachProbe,
    tree: &[i32],
    suspended: bool,
    dir: &Path,
    cancel: &CancellationToken,
) -> IdeResult<JvmHeapOutcome> {
    let outcome = dump(probe, tree, suspended, dir, cancel);
    if !matches!(outcome, Ok(JvmHeapOutcome::Ready(_))) {
        discard(dir);
    }
    outcome
}

fn dump(
    probe: &dyn AttachProbe,
    tree: &[i32],
    suspended: bool,
    dir: &Path,
    cancel: &CancellationToken,
) -> IdeResult<JvmHeapOutcome> {
    use JvmHeapUnavailable as H;
    use JvmMemoryUnavailable as U;
    let Some(root) = tree.first().and_then(|&p| u32::try_from(p).ok()) else {
        return Ok(memory(U::NoJvmProcess));
    };
    let Some(jvm) = pick_jvm_pid(tree, |p| probe.has_listener(p)) else {
        return Ok(memory(gone(probe, root)));
    };

    let version = probe.version(jvm);
    let java_major = version.as_ref().map_or(0, |v| v.major);
    if suspended && !safe_while_suspended(version.as_ref()) {
        return Ok(memory(U::UnsafeWhileSuspended { java_major }));
    }

    let text = match probe.histogram(jvm) {
        Ok(text) => text,
        Err(e) => return attach_failure(probe, jvm, e, "class histogram").map(memory),
    };
    let histogram: Vec<ide_heap::HistogramEntry> = ide_jvm_attach::parse_class_histogram(&text)
        .rows
        .into_iter()
        .map(|r| ide_heap::HistogramEntry { name: r.name, instances: r.instances, bytes: r.bytes })
        .collect();
    let (instances, bytes) =
        histogram.iter().fold((0u64, 0u64), |(i, b), e| (i.saturating_add(e.instances), b.saturating_add(e.bytes)));
    let needed = ide_heap::capture_need(bytes, instances);
    if let Some(available) = probe.free_bytes(dir)
        && available < needed
    {
        return Ok(JvmHeapOutcome::Unavailable(H::NotEnoughDiskSpace { needed, available }));
    }

    // Without flags the index assumes the default object layout.
    let vm_flags = probe.vm_flags(jvm).unwrap_or_else(|e| {
        tracing::debug!("VM.flags of JVM {jvm}: {e}");
        String::new()
    });
    if cancel.is_cancelled() {
        return Ok(JvmHeapOutcome::Cancelled);
    }

    let path = dir.join(DUMP_FILE);
    let timeout = ide_jvm_attach::dump_timeout(bytes);
    let started = std::time::Instant::now();
    let reply = probe.heap_dump(jvm, &path, timeout);
    let dump_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    if cancel.is_cancelled() {
        return Ok(JvmHeapOutcome::Cancelled);
    }
    let failed = |message: String| Ok(JvmHeapOutcome::Unavailable(H::DumpFailed { message }));
    match reply {
        Ok(HeapDumpReply::Created { .. }) => {
            if !std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() > 0) {
                return failed(format!("the JVM reported a heap dump, but {} is missing or empty", path.display()));
            }
            Ok(JvmHeapOutcome::Ready(JvmHeapDump {
                path,
                histogram,
                vm_flags,
                java_major,
                java_version: version.map(|v| v.text).unwrap_or_default(),
                pid: jvm,
                taken_while_suspended: suspended,
                dump_ms,
            }))
        }
        Ok(HeapDumpReply::Refused { message }) if message.is_empty() || message.starts_with("Dumping heap to") => {
            failed(NO_REASON.into())
        }
        Ok(HeapDumpReply::Refused { message }) => failed(message),
        Err(AttachError::Timeout) => {
            let seconds = u32::try_from(timeout.as_secs()).unwrap_or(u32::MAX);
            Ok(JvmHeapOutcome::Unavailable(H::DumpTimedOut { seconds }))
        }
        // A running JDK rejects an argument with a non-zero result code.
        Err(AttachError::Command { message, .. }) => failed(message),
        Err(e) => attach_failure(probe, jvm, e, "heap dump").map(memory),
    }
}

fn memory(reason: JvmMemoryUnavailable) -> JvmHeapOutcome {
    JvmHeapOutcome::Unavailable(JvmHeapUnavailable::Memory { reason })
}

fn discard(dir: &Path) {
    if let Err(e) = std::fs::remove_dir_all(dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("could not delete heap snapshot directory {}: {e}", dir.display());
    }
}

/// A dump may be large, so it is deleted off the async threads.
async fn discard_later(dir: PathBuf) {
    let _ = tokio::task::spawn_blocking(move || discard(&dir)).await;
}
