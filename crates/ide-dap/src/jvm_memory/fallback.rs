//! The class table counted by the debugger (JDWP `InstanceCounts`) where no histogram can be
//! taken: JDK 8-16 while suspended, Windows, a remote JVM. Only while suspended, and slow on a
//! large heap (seconds on JDK 17+).

use super::inspect::Call;
use super::snapshot::diff_rows;
use super::{ClassCounts, JvmMemoryResult, JvmMemorySnapshot, JvmMemorySource, JvmMemoryState, JvmMemoryUnavailable};
use crate::session::Session;
use ide_core::IdeResult;
use ide_jvm_attach::HistogramRow;
use ide_jvm_inspect::ClassCount;

/// Reasons the debugger may be able to work around; the others (the program exited, the JVM
/// did not answer) would fail for it too.
pub(super) fn falls_back(reason: &JvmMemoryUnavailable) -> bool {
    use JvmMemoryUnavailable as U;
    matches!(
        reason,
        U::UnsafeWhileSuspended { .. }
            | U::UnsupportedPlatform
            | U::AttachedJvmNotFound
            | U::ListenerNotRunning
            | U::ListenModeNotSupported
            | U::NoJvmProcess
    )
}

/// `histogram` unless it is unavailable for a reason `session`'s inspector can work around.
pub(super) async fn or_debugger_counts(
    state: &mut JvmMemoryState,
    histogram: Result<JvmMemorySnapshot, JvmMemoryUnavailable>,
    session: Option<&Session>,
) -> IdeResult<JvmMemoryResult> {
    let reason = match histogram {
        Ok(snapshot) => return Ok(JvmMemoryResult::Ready { snapshot }),
        Err(reason) => reason,
    };
    let unavailable = |can_count_when_paused| Ok(JvmMemoryResult::Unavailable { reason, can_count_when_paused });
    let Some(session) = session.filter(|_| falls_back(&reason)) else {
        return unavailable(false);
    };
    let call = match Call::begin(session, None).await {
        Ok(call) => call,
        Err(super::JvmInspectUnavailable::NotSuspended) => return unavailable(true),
        Err(_) => return unavailable(false),
    };
    let started = std::time::Instant::now();
    let result = call.run(call.inspector.class_counts(&call.target)).await;
    match call.finish(result) {
        Ok(counts) => {
            let elapsed_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
            let previous = state.baseline(JvmMemorySource::Debugger);
            let (snapshot, counts) = debugger_snapshot(counts, previous.as_deref(), elapsed_ms);
            state.remember(JvmMemorySource::Debugger, counts);
            Ok(JvmMemoryResult::Ready { snapshot })
        }
        Err(e) => {
            tracing::debug!("debugger class counts: {e}");
            let running = !session.suspended.get();
            unavailable(running && session.jvm_inspector.lock().is_some())
        }
    }
}

/// Classes without instances are left out; most instances first.
pub(super) fn debugger_snapshot(
    counts: Vec<ClassCount>,
    previous: Option<&ClassCounts>,
    elapsed_ms: u32,
) -> (JvmMemorySnapshot, ClassCounts) {
    let rows = counts
        .into_iter()
        .filter(|c| c.instances > 0)
        .map(|c| HistogramRow { name: c.name, module: None, instances: c.instances, bytes: 0 })
        .collect();
    let (mut rows, counts) = diff_rows(rows, previous);
    for row in &mut rows {
        row.delta_bytes = None;
    }
    rows.sort_by(|a, b| b.instances.cmp(&a.instances).then_with(|| a.name.cmp(&b.name)));
    let snapshot = JvmMemorySnapshot {
        total_instances: rows.iter().map(|r| r.instances).sum(),
        total_bytes: 0,
        rows,
        java_version: String::new(),
        taken_while_suspended: true,
        has_baseline: previous.is_some(),
        elapsed_ms,
        source: JvmMemorySource::Debugger,
    };
    (snapshot, counts)
}
