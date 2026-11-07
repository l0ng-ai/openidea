//! Class-table snapshots of a debugged JVM, read over the HotSpot attach listener.

mod scan;
mod snapshot;
#[cfg(test)]
mod tests;

use crate::session::Session;
use ide_core::IdeResult;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

#[cfg(all(test, unix))]
pub(crate) use scan::watch_for_attached_jvm;
pub(crate) use scan::{find_attached_jvm, local_jdwp_port};
use snapshot::{AttachProbe, JdkProbe, take_snapshot};

pub const JVM_MEMORY_ADAPTERS: &[&str] = &["java-debug", crate::kotlin::ADAPTER];
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
    pub has_baseline: bool,
    /// Wall time of the histogram request.
    pub elapsed_ms: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmMemoryUnavailable {
    /// An attach session whose JVM is remote, or local but not found by its JDWP port.
    AttachedJvmNotFound,
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
    Ready { snapshot: JvmMemorySnapshot },
    Unavailable { reason: JvmMemoryUnavailable },
}

/// Instances and bytes per class name, for the next snapshot's deltas; `None` for a name
/// several classes shared, so it gets no delta next time either.
type ClassCounts = HashMap<String, Option<(u64, u64)>>;

/// Per-session baseline; its mutex also keeps one histogram request per session at a time.
#[derive(Default)]
pub struct JvmMemoryState {
    /// Shared with the blocking task, so a task that panics leaves it in place.
    previous: Option<Arc<ClassCounts>>,
}

pub(crate) async fn session_classes(session: Arc<Session>) -> IdeResult<JvmMemoryResult> {
    let unavailable = |reason| Ok(JvmMemoryResult::Unavailable { reason });
    if !JVM_MEMORY_ADAPTERS.contains(&session.adapter.as_str()) {
        return unavailable(JvmMemoryUnavailable::NoJvmProcess);
    }
    if !cfg!(unix) {
        return unavailable(JvmMemoryUnavailable::UnsupportedPlatform);
    }
    let launched = if session.request == "launch" {
        let pid = match session.jvm_pid.load(Ordering::Acquire) {
            p if p > 0 => p,
            _ => session.debuggee_pid.load(Ordering::Acquire),
        };
        let Some(pid) = i32::try_from(pid).ok().filter(|&p| p > 0) else {
            return unavailable(JvmMemoryUnavailable::NoJvmProcess);
        };
        Some(pid)
    } else {
        None
    };
    // Detached, so a caller that gives up cannot release the lock while the JVM is still
    // answering and let a second histogram request run next to it.
    tokio::spawn(async move {
        let target = match launched {
            Some(pid) => JvmTarget::Launched(pid),
            None => JvmTarget::Attached { pid: &session.jvm_pid, jdwp_port: session.jdwp_port.get().copied() },
        };
        snapshot(&session.jvm_memory, &session.suspended, |suspended| Arc::new(JdkProbe { suspended }), target).await
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(format!("JVM memory snapshot failed: {e}")))?
}

#[derive(Clone, Copy)]
pub(crate) enum JvmTarget<'a> {
    /// The program a launch session started: its pid and everything it started.
    Launched(i32),
    /// The JVM of an attach session. While `pid` is 0 it is looked up by `jdwp_port`, which is
    /// `None` for a remote JVM.
    Attached { pid: &'a AtomicI64, jdwp_port: Option<u16> },
}

enum Lookup {
    Tree(i32),
    Known(i32),
    Scan(u16),
}

/// `probe` is built from the suspension read once the lock is held: a request queued behind
/// another must not decide on a state from before the program hit a breakpoint.
pub(crate) async fn snapshot(
    state: &tokio::sync::Mutex<JvmMemoryState>,
    suspended: &AtomicBool,
    probe: impl FnOnce(bool) -> Arc<dyn AttachProbe>,
    target: JvmTarget<'_>,
) -> IdeResult<JvmMemoryResult> {
    let mut state = state.lock().await;
    let suspended = suspended.load(Ordering::Acquire);
    let unavailable = |reason| Ok(JvmMemoryResult::Unavailable { reason });
    let lookup = match target {
        JvmTarget::Launched(pid) => Lookup::Tree(pid),
        JvmTarget::Attached { pid, jdwp_port } => match i32::try_from(pid.load(Ordering::Acquire)) {
            Ok(p) if p > 0 => Lookup::Known(p),
            _ => match jdwp_port {
                Some(port) => Lookup::Scan(port),
                None => return unavailable(JvmMemoryUnavailable::AttachedJvmNotFound),
            },
        },
    };
    let probe = probe(suspended);
    let previous = state.previous.clone();
    let (found, outcome) = tokio::task::spawn_blocking(move || {
        let (found, tree) = match lookup {
            Lookup::Tree(pid) => (None, pid_tree(pid)),
            Lookup::Known(pid) => (None, vec![pid]),
            Lookup::Scan(port) => match scan_for_jvm(&*probe, port, suspended) {
                Ok(pid) => (Some(pid), vec![pid]),
                Err(reason) => return (None, Ok(Err(reason))),
            },
        };
        (found, take_snapshot(&*probe, &tree, suspended, previous.as_deref()))
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(format!("JVM memory snapshot failed: {e}")))?;
    if let (Some(found), JvmTarget::Attached { pid, .. }) = (found, target) {
        // The attach-time scan may have found it meanwhile; either answer is the same JVM.
        let _ = pid.compare_exchange(0, i64::from(found), Ordering::AcqRel, Ordering::Acquire);
    }
    Ok(match outcome? {
        Ok((snapshot, counts)) => {
            state.previous = Some(Arc::new(counts));
            JvmMemoryResult::Ready { snapshot }
        }
        Err(reason) => JvmMemoryResult::Unavailable { reason },
    })
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
        crate::session::process_tree(pid)
    }
    #[cfg(not(unix))]
    {
        vec![pid]
    }
}
