//! A thread dump (`Thread.print -l`) of a debugged or running JVM.

use super::heap::capture_suspended;
use super::snapshot::{AttachProbe, JdkProbe, attach_failure, gone, pick_jvm_pid};
use super::{
    JvmMemoryState, JvmMemoryUnavailable, JvmTarget, histogram_pid, keep_found, lookup, resolve_jvm,
    safe_while_suspended, session_target, until_located,
};
use crate::session::Session;
use ide_core::{IdeError, IdeResult};
use ide_jvm_attach::{AttachError, JavaVersion};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The first release whose virtual threads are final and that writes the JSON dump.
const VIRTUAL_THREADS_MAJOR: u32 = 21;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JvmThreadDump {
    pub text: String,
    pub pid: u32,
    /// Empty when unknown.
    pub java_version: String,
    pub taken_while_suspended: bool,
    /// Wall time of the `Thread.print` request.
    pub elapsed_ms: u32,
    /// `Thread.dump_to_file -format=json`, which also lists virtual threads; JDK 21+ only.
    pub virtual_json: Option<String>,
    /// Why `virtual_json` is missing from a JDK 21+ dump; none below 21.
    pub virtual_note: Option<VirtualThreadsNote>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum VirtualThreadsNote {
    /// A debugger holds the VM, which would hang the JSON request until it resumes.
    WhileSuspended,
    /// Over the attach reply limit (64 MiB).
    TooLarge,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmThreadsUnavailable {
    /// The reason a class table could not be read applies to the dump too.
    Jvm {
        reason: JvmMemoryUnavailable,
    },
    /// The JVM ignored the request to open its attach listener (`-XX:+DisableAttachMechanism`).
    ListenerDidNotStart,
    /// A run on a remote host, whose JVM this machine cannot attach to.
    RemoteRun,
    Failed {
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmThreadsResult {
    Ready { dump: JvmThreadDump },
    Unavailable { reason: JvmThreadsUnavailable },
}

/// A thread dump of `pid`, a JVM no debugger holds; `json_dir` is an absolute, owner-only
/// directory the JVM may write the JSON dump into. Blocking for up to the listener start and
/// dump timeouts, so callers run it in `spawn_blocking`.
pub fn run_jvm_thread_dump(pid: u32, json_dir: Option<&Path>) -> JvmThreadsResult {
    dump_threads(&JdkProbe { suspended: false }, pid, false, json_dir, &|| false)
}

pub(crate) async fn session_thread_dump(
    session: Arc<Session>,
    json_dir: Option<PathBuf>,
) -> IdeResult<JvmThreadsResult> {
    until_located(&session).await;
    let launched = histogram_pid(&session);
    // Detached, so a caller that gives up cannot release the lock while the JVM is still
    // answering and let a class-table request run next to it.
    tokio::spawn(async move {
        let target = session_target(&session, launched);
        let probe = |suspended| -> Arc<dyn AttachProbe> { Arc::new(JdkProbe { suspended }) };
        let stopped = session.clone();
        let suspended = move || capture_suspended(&stopped);
        thread_dump(&session.jvm_memory, suspended, probe, target, json_dir).await
    })
    .await
    .map_err(|e| IdeError::internal(format!("JVM thread dump failed: {e}")))?
}

/// A thread dump of `pid`, a run's JVM that `session` debugs, taken as the session's own dump
/// is: a JVM the debugger holds suspended is never asked to open a listener.
pub(crate) async fn debugged_run_thread_dump(
    session: Arc<Session>,
    pid: u32,
    json_dir: Option<PathBuf>,
) -> IdeResult<JvmThreadsResult> {
    // Detached for the same reason as `session_thread_dump`.
    tokio::spawn(async move {
        let probe = |suspended| -> Arc<dyn AttachProbe> { Arc::new(JdkProbe { suspended }) };
        known_pid_dump(&session, probe, pid, json_dir).await
    })
    .await
    .map_err(|e| IdeError::internal(format!("JVM thread dump failed: {e}")))?
}

/// The session's suspension decides the JSON dump too: it is read again before that request.
pub(super) async fn known_pid_dump(
    session: &Arc<Session>,
    probe: impl FnOnce(bool) -> Arc<dyn AttachProbe>,
    pid: u32,
    json_dir: Option<PathBuf>,
) -> IdeResult<JvmThreadsResult> {
    let target =
        i32::try_from(pid).map_or(JvmTarget::Unavailable(JvmMemoryUnavailable::NoJvmProcess), JvmTarget::Known);
    let stopped = session.clone();
    let suspended = move || capture_suspended(&stopped);
    thread_dump(&session.jvm_memory, suspended, probe, target, json_dir).await
}

/// Takes the class-table lock, so a dump never runs beside a histogram or heap dump of the same
/// session; `suspended_now` and then `probe` are read once it is held, and `suspended_now` again
/// before the JSON dump.
pub(super) async fn thread_dump(
    state: &tokio::sync::Mutex<JvmMemoryState>,
    suspended_now: impl Fn() -> bool + Send + Sync + 'static,
    probe: impl FnOnce(bool) -> Arc<dyn AttachProbe>,
    target: JvmTarget<'_>,
    json_dir: Option<PathBuf>,
) -> IdeResult<JvmThreadsResult> {
    let _turn = state.lock().await;
    let suspended = suspended_now();
    let lookup = match lookup(target) {
        Ok(lookup) => lookup,
        Err(reason) => return Ok(jvm(reason)),
    };
    let probe = probe(suspended);
    let (found, outcome) = tokio::task::spawn_blocking(move || match resolve_jvm(lookup, &*probe, suspended) {
        Ok((tree, found)) => (found, dump_tree(&*probe, &tree, suspended, json_dir.as_deref(), &suspended_now)),
        Err(reason) => (None, jvm(reason)),
    })
    .await
    .map_err(|e| IdeError::internal(format!("JVM thread dump failed: {e}")))?;
    keep_found(target, found);
    Ok(outcome)
}

/// `tree` starts with the session's reported pid, followed by its descendants: the JVM is the
/// first with a listener, else the first application JVM (the reported pid may be a shell or a
/// Gradle client), else the reported pid.
pub(super) fn dump_tree(
    probe: &dyn AttachProbe,
    tree: &[i32],
    suspended: bool,
    json_dir: Option<&Path>,
    suspended_now: &dyn Fn() -> bool,
) -> JvmThreadsResult {
    let jvm_pid = pick_jvm_pid(tree, |p| probe.has_listener(p))
        .or_else(|| pick_jvm_pid(tree, |p| probe.is_application_jvm(p)))
        .or_else(|| tree.first().and_then(|&p| u32::try_from(p).ok()).filter(|&p| p > 0));
    match jvm_pid {
        Some(pid) => dump_threads(probe, pid, suspended, json_dir, suspended_now),
        None => jvm(JvmMemoryUnavailable::NoJvmProcess),
    }
}

/// Blocking. A JVM a debugger holds suspended cannot open a listener (its Signal Dispatcher is
/// stopped), and one below 17 hangs even with one, so it is asked only when both are ruled out.
/// The JSON dump follows a text dump that succeeded; its failure only sets the note.
pub(crate) fn dump_threads(
    probe: &dyn AttachProbe,
    pid: u32,
    suspended: bool,
    json_dir: Option<&Path>,
    suspended_now: &dyn Fn() -> bool,
) -> JvmThreadsResult {
    if suspended {
        if !probe.has_listener(pid) {
            return jvm(gone(probe, pid));
        }
    } else if let Err(e) = probe.ensure_listener(pid) {
        return failure(probe, pid, e);
    }
    let version = probe.version(pid);
    if suspended && !safe_while_suspended(version.as_ref()) {
        return jvm(JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: version.map_or(0, |v| v.major) });
    }

    let started = std::time::Instant::now();
    let text = match probe.thread_print(pid) {
        Ok(text) => text,
        Err(e) => return failure(probe, pid, e),
    };
    let elapsed_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    let (virtual_json, virtual_note) =
        virtual_threads(probe, pid, version.as_ref(), suspended, json_dir, suspended_now);
    JvmThreadsResult::Ready {
        dump: JvmThreadDump {
            text,
            pid,
            java_version: version.map(|v| v.text).unwrap_or_default(),
            taken_while_suspended: suspended,
            elapsed_ms,
            virtual_json,
            virtual_note,
        },
    }
}

/// The program may have stopped during the text dump, so the suspension is read again.
fn virtual_threads(
    probe: &dyn AttachProbe,
    pid: u32,
    version: Option<&JavaVersion>,
    suspended: bool,
    json_dir: Option<&Path>,
    suspended_now: &dyn Fn() -> bool,
) -> (Option<String>, Option<VirtualThreadsNote>) {
    if version.is_none_or(|v| v.major < VIRTUAL_THREADS_MAJOR) {
        return (None, None);
    }
    if suspended || suspended_now() {
        return (None, Some(VirtualThreadsNote::WhileSuspended));
    }
    let Some(dir) = json_dir else {
        return (None, Some(VirtualThreadsNote::Failed));
    };
    match probe.thread_dump_json(pid, dir) {
        Ok(json) => (Some(json), None),
        Err(AttachError::TooLarge) => (None, Some(VirtualThreadsNote::TooLarge)),
        Err(e) => {
            tracing::warn!("JSON thread dump of JVM {pid}: {e}");
            (None, Some(VirtualThreadsNote::Failed))
        }
    }
}

fn failure(probe: &dyn AttachProbe, pid: u32, error: AttachError) -> JvmThreadsResult {
    let reason = match error {
        AttachError::ListenerDidNotStart => JvmThreadsUnavailable::ListenerDidNotStart,
        // A program that exited leaves no perf-data file, so it fails the HotSpot check too.
        AttachError::NotAJvm if probe.alive(pid) => {
            JvmThreadsUnavailable::Jvm { reason: JvmMemoryUnavailable::NoJvmProcess }
        }
        AttachError::NotAJvm => JvmThreadsUnavailable::Jvm { reason: JvmMemoryUnavailable::ProgramExited },
        e => match attach_failure(probe, pid, e, "thread dump") {
            Ok(reason) => JvmThreadsUnavailable::Jvm { reason },
            Err(e) => JvmThreadsUnavailable::Failed { message: e.message },
        },
    };
    JvmThreadsResult::Unavailable { reason }
}

fn jvm(reason: JvmMemoryUnavailable) -> JvmThreadsResult {
    JvmThreadsResult::Unavailable { reason: JvmThreadsUnavailable::Jvm { reason } }
}
