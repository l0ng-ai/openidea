//! Class-table snapshots of a debugged JVM, read over the HotSpot attach listener or, where
//! that is unavailable, counted by the debugger; and the JVM's objects through the debugger.

mod fallback;
mod heap;
mod inspect;
mod scan;
mod snapshot;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;

use crate::session::Session;
use crate::session::Suspension;
use ide_core::IdeResult;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

pub use heap::*;
pub use inspect::{JvmFieldsResult, JvmInspectUnavailable, JvmInstancesResult, JvmObjectRef, JvmReferrersResult};
pub(crate) use inspect::{fields, instances, referrers, set_inspector, watch_link};
#[cfg(all(test, unix))]
pub(crate) use scan::watch_for_attached_jvm;
pub(crate) use scan::{JvmFinder, attach_target, find_attached_jvm, find_local_jvm, local_jdwp_port};
use snapshot::{AttachProbe, JdkProbe, take_snapshot};

pub const JVM_MEMORY_ADAPTERS: &[&str] = &["java-debug", crate::kotlin::ADAPTER, crate::kotlin_lsp::ADAPTER];
pub const HISTOGRAM_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JvmClassRow {
    pub name: String,
    pub module: Option<String>,
    pub instances: u64,
    pub bytes: u64,
    /// Change since the previous snapshot; `None` on the first one and for ambiguous rows.
    pub delta_instances: Option<i64>,
    pub delta_bytes: Option<i64>,
    /// Several classes share this name (different class loaders), so it has no delta.
    pub ambiguous: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JvmMemorySnapshot {
    /// Largest `bytes` first.
    pub rows: Vec<JvmClassRow>,
    pub total_instances: u64,
    pub total_bytes: u64,
    /// Empty when unknown.
    pub java_version: String,
    pub taken_while_suspended: bool,
    /// A previous snapshot from the same source exists; deltas are against it.
    pub has_baseline: bool,
    /// Wall time of the histogram or count request.
    pub elapsed_ms: u32,
    pub source: JvmMemorySource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JvmMemorySource {
    /// `GC.class_histogram -all`: sizes, and objects not yet collected.
    Histogram,
    /// JDWP `InstanceCounts`: reachable objects only, no sizes (`bytes` is 0).
    Debugger,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmMemoryUnavailable {
    /// An attach session whose JVM is remote, or local but not found by its JDWP port.
    AttachedJvmNotFound,
    /// An attach through the IDE's listen-mode relay: the JVM connected to the IDE, so it has
    /// no JDWP listener to be found by.
    ListenModeNotSupported,
    UnsupportedPlatform,
    NoJvmProcess,
    ListenerNotRunning,
    /// `java_major` is 0 when the version is unknown.
    UnsafeWhileSuspended {
        java_major: u32,
    },
    ProgramExited,
    TimedOut,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmMemoryResult {
    Ready {
        snapshot: JvmMemorySnapshot,
    },
    Unavailable {
        reason: JvmMemoryUnavailable,
        /// The debugger could count the classes if the program were paused.
        can_count_when_paused: bool,
    },
}

/// Instances and bytes per class name, for the next snapshot's deltas; `None` for a name
/// several classes shared, so it gets no delta next time either.
type ClassCounts = HashMap<String, Option<(u64, u64)>>;

/// Per-session baseline; its mutex also keeps one class-table request per session at a time.
#[derive(Default)]
pub struct JvmMemoryState {
    /// Shared with the blocking task, so a task that panics leaves it in place.
    previous: Option<(JvmMemorySource, Arc<ClassCounts>)>,
}

impl JvmMemoryState {
    /// The previous snapshot's counts if it came from `source`: counts from the other source
    /// are not comparable (only reachable objects versus all of them).
    pub(crate) fn baseline(&self, source: JvmMemorySource) -> Option<Arc<ClassCounts>> {
        self.previous.as_ref().filter(|(s, _)| *s == source).map(|(_, counts)| counts.clone())
    }

    pub(crate) fn remember(&mut self, source: JvmMemorySource, counts: ClassCounts) {
        self.previous = Some((source, Arc::new(counts)));
    }
}

pub(crate) async fn session_classes(session: Arc<Session>) -> IdeResult<JvmMemoryResult> {
    until_located(&session).await;
    let launched = histogram_pid(&session);
    // Detached, so a caller that gives up cannot release the lock while the JVM is still
    // answering and let a second histogram request run next to it.
    tokio::spawn(async move {
        let target = session_target(&session, launched);
        let probe = |suspended| -> Arc<dyn AttachProbe> { Arc::new(JdkProbe { suspended }) };
        snapshot(&session.jvm_memory, &session.suspended, probe, target, Some(&session)).await
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(format!("JVM memory snapshot failed: {e}")))?
}

/// Bounds the wait of [`until_located`]; `configure` has its own timeouts, this only guards them.
const LOCATE_WAIT: Duration = Duration::from_secs(30);

/// Until `configure` has recorded where `session`'s JVM is. The Memory view asks as soon as the
/// session appears; looked up earlier, an attached JVM is reported as missing.
async fn until_located(session: &Session) {
    let mut located = session.jvm_located.subscribe();
    tokio::select! {
        _ = located.wait_for(|v| *v) => {}
        () = session.ended.cancelled() => {}
        () = tokio::time::sleep(LOCATE_WAIT) => {}
    }
}

/// `launched`: [`histogram_pid`] of `session`.
fn session_target(session: &Session, launched: Result<Option<i32>, JvmMemoryUnavailable>) -> JvmTarget<'_> {
    match launched {
        Ok(Some(pid)) => JvmTarget::Launched(pid),
        Ok(None) => JvmTarget::Attached { pid: &session.jvm_pid, jdwp_port: session.jdwp_port.get().copied() },
        Err(reason) => JvmTarget::Unavailable(reason),
    }
}

/// The pid of a launch session's program (`None` for an attach session), or why no histogram
/// can be taken.
fn histogram_pid(session: &Session) -> Result<Option<i32>, JvmMemoryUnavailable> {
    if !JVM_MEMORY_ADAPTERS.contains(&session.adapter.as_str()) {
        return Err(JvmMemoryUnavailable::NoJvmProcess);
    }
    if !cfg!(unix) {
        return Err(JvmMemoryUnavailable::UnsupportedPlatform);
    }
    if session.request == "launch" {
        return match i32::try_from(launch_pid(session)).ok().filter(|&p| p > 0) {
            Some(pid) => Ok(Some(pid)),
            None => Err(JvmMemoryUnavailable::NoJvmProcess),
        };
    }
    if session.jvm_pid.load(Ordering::Acquire) <= 0 {
        if session.terminated.load(Ordering::Acquire) {
            return Err(JvmMemoryUnavailable::ProgramExited);
        }
        if session.listen_relay.load(Ordering::Acquire) {
            return Err(JvmMemoryUnavailable::ListenModeNotSupported);
        }
    }
    Ok(None)
}

/// The JVM a launch session started: the one the IDE started for an app-launched (Kotlin)
/// session, else the program the adapter reported; 0 when neither is known.
pub(crate) fn launch_pid(session: &Session) -> i64 {
    match session.jvm_pid.load(Ordering::Acquire) {
        p if p > 0 => p,
        _ => session.debuggee_pid.load(Ordering::Acquire),
    }
}

#[derive(Clone, Copy)]
pub(crate) enum JvmTarget<'a> {
    /// The program a launch session started: its pid and everything it started.
    Launched(i32),
    /// The JVM of an attach session. While `pid` is 0 it is looked up by `jdwp_port`, which is
    /// `None` for a remote JVM.
    Attached { pid: &'a AtomicI64, jdwp_port: Option<u16> },
    /// Known without asking any JVM: no histogram can be taken, for this reason.
    Unavailable(JvmMemoryUnavailable),
}

enum Lookup {
    Tree(i32),
    Known(i32),
    Scan(u16),
}

/// `probe` is built from the suspension read once the lock is held: a request queued behind
/// another must not decide on a state from before the program hit a breakpoint. Where no
/// histogram can be taken, `debugger` (the session) may count the classes instead.
pub(crate) async fn snapshot(
    state: &tokio::sync::Mutex<JvmMemoryState>,
    suspended: &Suspension,
    probe: impl FnOnce(bool) -> Arc<dyn AttachProbe>,
    target: JvmTarget<'_>,
    debugger: Option<&Session>,
) -> IdeResult<JvmMemoryResult> {
    let mut state = state.lock().await;
    let outcome = histogram(&mut state, suspended, probe, target).await?;
    fallback::or_debugger_counts(&mut state, outcome, debugger).await
}

async fn histogram(
    state: &mut JvmMemoryState,
    suspended: &Suspension,
    probe: impl FnOnce(bool) -> Arc<dyn AttachProbe>,
    target: JvmTarget<'_>,
) -> IdeResult<Result<JvmMemorySnapshot, JvmMemoryUnavailable>> {
    let suspended = suspended.get();
    let lookup = match lookup(target) {
        Ok(lookup) => lookup,
        Err(reason) => return Ok(Err(reason)),
    };
    let probe = probe(suspended);
    let previous = state.baseline(JvmMemorySource::Histogram);
    let (found, outcome) = tokio::task::spawn_blocking(move || match resolve_jvm(lookup, &*probe, suspended) {
        Ok((tree, found)) => (found, take_snapshot(&*probe, &tree, suspended, previous.as_deref())),
        Err(reason) => (None, Ok(Err(reason))),
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(format!("JVM memory snapshot failed: {e}")))?;
    keep_found(target, found);
    Ok(outcome?.map(|(snapshot, counts)| {
        state.remember(JvmMemorySource::Histogram, counts);
        snapshot
    }))
}

/// Where to look for `target`'s JVM, or why there is none to ask.
fn lookup(target: JvmTarget<'_>) -> Result<Lookup, JvmMemoryUnavailable> {
    match target {
        JvmTarget::Launched(pid) => Ok(Lookup::Tree(pid)),
        JvmTarget::Attached { pid, jdwp_port } => match i32::try_from(pid.load(Ordering::Acquire)) {
            Ok(p) if p > 0 => Ok(Lookup::Known(p)),
            _ => jdwp_port.map(Lookup::Scan).ok_or(JvmMemoryUnavailable::AttachedJvmNotFound),
        },
        JvmTarget::Unavailable(reason) => Err(reason),
    }
}

/// Blocking. The pids to pick the JVM from, and the pid a scan found (for [`keep_found`]).
fn resolve_jvm(
    lookup: Lookup,
    probe: &dyn AttachProbe,
    suspended: bool,
) -> Result<(Vec<i32>, Option<i32>), JvmMemoryUnavailable> {
    match lookup {
        Lookup::Tree(pid) => Ok((pid_tree(pid), None)),
        Lookup::Known(pid) => Ok((vec![pid], None)),
        Lookup::Scan(port) => scan_for_jvm(probe, port, suspended).map(|pid| (vec![pid], Some(pid))),
    }
}

fn keep_found(target: JvmTarget<'_>, found: Option<i32>) {
    if let (Some(found), JvmTarget::Attached { pid, .. }) = (found, target) {
        // The attach-time scan may have found it meanwhile; either answer is the same JVM.
        let _ = pid.compare_exchange(0, i64::from(found), Ordering::AcqRel, Ordering::Acquire);
    }
}

/// A suspended JDK below 17 hangs on an attach request, so while suspended only a JVM known to
/// be 17 or later is asked anything. Pass a version read without attaching (the `release` file).
fn safe_while_suspended(version: Option<&ide_jvm_attach::JavaVersion>) -> bool {
    version.is_some_and(|v| ide_jvm_attach::histogram_safe_while_suspended(v.major))
}

/// The JVM listening on JDWP `port`. While suspended the scan reaches the session's own JVM
/// too, so JVMs unsafe to ask are skipped, and when one of them may be the session's the
/// answer is a refusal rather than "not found".
fn scan_for_jvm(probe: &dyn AttachProbe, port: u16, suspended: bool) -> Result<i32, JvmMemoryUnavailable> {
    // Majors of the JVMs left out; 0 for an unknown version.
    let skipped = std::cell::RefCell::new(std::collections::BTreeSet::new());
    let may_query = |pid: u32| {
        if !suspended {
            return true;
        }
        let version = probe.version(pid);
        let safe = safe_while_suspended(version.as_ref());
        if !safe {
            skipped.borrow_mut().insert(version.map_or(0, |v| v.major));
        }
        safe
    };
    match probe.find_by_jdwp_port(port, &may_query).and_then(|p| i32::try_from(p).ok()) {
        Some(pid) if pid > 0 => Ok(pid),
        _ => {
            let skipped = skipped.into_inner();
            Err(match skipped.first() {
                None => JvmMemoryUnavailable::AttachedJvmNotFound,
                Some(&major) => JvmMemoryUnavailable::UnsafeWhileSuspended {
                    java_major: if skipped.len() == 1 { major } else { 0 },
                },
            })
        }
    }
}

fn pid_tree(pid: i32) -> Vec<i32> {
    #[cfg(unix)]
    {
        ide_core::process::process_tree(pid)
    }
    #[cfg(not(unix))]
    {
        vec![pid]
    }
}
