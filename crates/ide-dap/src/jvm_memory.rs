//! Class-table snapshots of a debugged JVM, read over the HotSpot attach listener.

use crate::session::Session;
use ide_core::IdeResult;
use ide_jvm_attach::{AttachError, HistogramRow, JavaVersion};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

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
    NotLaunchedByIde,
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

/// Version probe for a JVM whose `release` file could not be read.
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);

fn launched_jvm(adapter: &str, request: &str) -> bool {
    JVM_MEMORY_ADAPTERS.contains(&adapter) && request == "launch"
}

pub(crate) fn jvm_memory_supported(adapter: &str, request: &str) -> bool {
    launched_jvm(adapter, request) && cfg!(unix)
}

/// The attach calls a snapshot makes, so tests can stand in for a JVM.
pub(crate) trait AttachProbe: Send + Sync {
    fn has_listener(&self, pid: u32) -> bool;
    fn version(&self, pid: u32) -> Option<JavaVersion>;
    fn histogram(&self, pid: u32) -> Result<String, AttachError>;
    fn alive(&self, pid: u32) -> bool;
}

struct JdkProbe {
    suspended: bool,
}

impl AttachProbe for JdkProbe {
    fn has_listener(&self, pid: u32) -> bool {
        ide_jvm_attach::has_listener(pid)
    }

    fn version(&self, pid: u32) -> Option<JavaVersion> {
        ide_jvm_attach::java_version_of(pid).or_else(|| {
            // The version decides whether attaching to a suspended VM hangs it, so never
            // attach to learn it while suspended.
            if self.suspended {
                return None;
            }
            let out = ide_jvm_attach::jcmd(pid, "VM.version", VERSION_TIMEOUT).ok()?;
            ide_jvm_attach::parse_vm_version(&out)
        })
    }

    fn histogram(&self, pid: u32) -> Result<String, AttachError> {
        ide_jvm_attach::jcmd(pid, "GC.class_histogram -all", HISTOGRAM_TIMEOUT)
    }

    fn alive(&self, pid: u32) -> bool {
        alive(pid)
    }
}

fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // 0 and negative pids address process groups.
        let Ok(pid) = i32::try_from(pid) else { return false };
        // SAFETY: signal 0 only checks that the process exists and may be signalled.
        pid > 0
            && (unsafe { libc::kill(pid, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

pub(crate) fn pick_jvm_pid(tree: &[i32], has_listener: impl Fn(u32) -> bool) -> Option<u32> {
    tree.iter().filter_map(|&p| u32::try_from(p).ok()).filter(|&p| p > 0).find(|&p| has_listener(p))
}

pub(crate) fn diff_rows(rows: Vec<HistogramRow>, previous: Option<&ClassCounts>) -> (Vec<JvmClassRow>, ClassCounts) {
    let mut seen: HashMap<&str, u32> = HashMap::with_capacity(rows.len());
    for r in &rows {
        *seen.entry(r.name.as_str()).or_default() += 1;
    }
    let ambiguous: Vec<bool> = rows.iter().map(|r| seen[r.name.as_str()] > 1).collect();
    drop(seen);

    let mut counts = ClassCounts::with_capacity(rows.len());
    let mut out: Vec<JvmClassRow> = rows
        .into_iter()
        .zip(ambiguous)
        .map(|(r, ambiguous)| {
            counts.insert(r.name.clone(), (!ambiguous).then_some((r.instances, r.bytes)));
            let delta = match previous {
                _ if ambiguous => None,
                None => None,
                Some(p) => match p.get(&r.name) {
                    Some(None) => None,
                    // Absent: new since the previous snapshot, so it grew from nothing.
                    before => {
                        let (instances, bytes) = before.copied().flatten().unwrap_or_default();
                        Some((delta(r.instances, instances), delta(r.bytes, bytes)))
                    }
                },
            };
            JvmClassRow {
                name: r.name,
                module: r.module,
                instances: r.instances,
                bytes: r.bytes,
                delta_instances: delta.map(|d| d.0),
                delta_bytes: delta.map(|d| d.1),
                ambiguous,
            }
        })
        .collect();
    out.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    (out, counts)
}

/// Exact while the difference fits in an i64 (two's complement).
fn delta(now: u64, before: u64) -> i64 {
    now.wrapping_sub(before) as i64
}

/// `pid_tree` starts with the session's reported pid, followed by its descendants.
pub(crate) fn take_snapshot(
    probe: &dyn AttachProbe,
    pid_tree: &[i32],
    suspended: bool,
    previous: Option<&ClassCounts>,
) -> IdeResult<Result<(JvmMemorySnapshot, ClassCounts), JvmMemoryUnavailable>> {
    use JvmMemoryUnavailable as U;
    let gone = |pid: u32| if probe.alive(pid) { U::ListenerNotRunning } else { U::ProgramExited };
    let Some(root) = pid_tree.first().and_then(|&p| u32::try_from(p).ok()) else {
        return Ok(Err(U::NoJvmProcess));
    };
    let Some(jvm) = pick_jvm_pid(pid_tree, |p| probe.has_listener(p)) else {
        return Ok(Err(gone(root)));
    };

    let version = probe.version(jvm);
    if suspended && !version.as_ref().is_some_and(|v| ide_jvm_attach::histogram_safe_while_suspended(v.major)) {
        return Ok(Err(U::UnsafeWhileSuspended { java_major: version.map_or(0, |v| v.major) }));
    }

    let started = std::time::Instant::now();
    let text = match probe.histogram(jvm) {
        Ok(text) => text,
        Err(AttachError::Timeout) => return Ok(Err(U::TimedOut)),
        Err(AttachError::Refused | AttachError::NoListener) => return Ok(Err(gone(jvm))),
        Err(AttachError::ForeignListener) => {
            tracing::warn!("attach socket of JVM {jvm} is no longer private to this user; not using it");
            return Ok(Err(U::ListenerNotRunning));
        }
        Err(AttachError::Unsupported) => return Ok(Err(U::UnsupportedPlatform)),
        Err(e) => return Err(ide_core::IdeError::internal(format!("class histogram of JVM {jvm}: {e}"))),
    };
    let elapsed_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);

    let histogram = ide_jvm_attach::parse_class_histogram(&text);
    if histogram.skipped_lines > 0 {
        tracing::debug!("class histogram of JVM {jvm}: {} unreadable lines", histogram.skipped_lines);
    }
    let (rows, counts) = diff_rows(histogram.rows, previous);
    let snapshot = JvmMemorySnapshot {
        total_instances: rows.iter().map(|r| r.instances).sum(),
        total_bytes: rows.iter().map(|r| r.bytes).sum(),
        rows,
        java_version: version.map(|v| v.text).unwrap_or_default(),
        taken_while_suspended: suspended,
        has_baseline: previous.is_some(),
        elapsed_ms,
    };
    Ok(Ok((snapshot, counts)))
}

pub(crate) async fn session_classes(session: Arc<Session>) -> IdeResult<JvmMemoryResult> {
    let unavailable = |reason| Ok(JvmMemoryResult::Unavailable { reason });
    if !launched_jvm(&session.adapter, &session.request) {
        return unavailable(JvmMemoryUnavailable::NotLaunchedByIde);
    }
    if !cfg!(unix) {
        return unavailable(JvmMemoryUnavailable::UnsupportedPlatform);
    }
    let pid = match session.jvm_pid.load(Ordering::Acquire) {
        p if p > 0 => p,
        _ => session.debuggee_pid.load(Ordering::Acquire),
    };
    let Some(pid) = i32::try_from(pid).ok().filter(|&p| p > 0) else {
        return unavailable(JvmMemoryUnavailable::NoJvmProcess);
    };
    // Detached, so a caller that gives up cannot release the lock while the JVM is still
    // answering and let a second histogram request run next to it.
    tokio::spawn(async move {
        snapshot(&session.jvm_memory, &session.suspended, |suspended| Arc::new(JdkProbe { suspended }), pid).await
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(format!("JVM memory snapshot failed: {e}")))?
}

/// `probe` is built from the suspension read once the lock is held: a request queued behind
/// another must not decide on a state from before the program hit a breakpoint.
pub(crate) async fn snapshot(
    state: &tokio::sync::Mutex<JvmMemoryState>,
    suspended: &AtomicBool,
    probe: impl FnOnce(bool) -> Arc<dyn AttachProbe>,
    pid: i32,
) -> IdeResult<JvmMemoryResult> {
    let mut state = state.lock().await;
    let suspended = suspended.load(Ordering::Acquire);
    let probe = probe(suspended);
    let previous = state.previous.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let tree = pid_tree(pid);
        take_snapshot(&*probe, &tree, suspended, previous.as_deref())
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(format!("JVM memory snapshot failed: {e}")))?;
    Ok(match outcome? {
        Ok((snapshot, counts)) => {
            state.previous = Some(Arc::new(counts));
            JvmMemoryResult::Ready { snapshot }
        }
        Err(reason) => JvmMemoryResult::Unavailable { reason },
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn row(name: &str, instances: u64, bytes: u64) -> HistogramRow {
        HistogramRow { name: name.into(), module: None, instances, bytes }
    }

    struct FakeProbe {
        listener: u32,
        version: Option<JavaVersion>,
        histograms: parking_lot::Mutex<VecDeque<Result<String, AttachError>>>,
        alive: bool,
        delay: Duration,
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
    }

    impl FakeProbe {
        fn new(listener: u32, histograms: Vec<Result<String, AttachError>>) -> Self {
            Self {
                listener,
                version: Some(JavaVersion { major: 21, text: "21.0.5".into() }),
                histograms: parking_lot::Mutex::new(histograms.into()),
                alive: true,
                delay: Duration::ZERO,
                in_flight: AtomicUsize::new(0),
                max_in_flight: AtomicUsize::new(0),
            }
        }
    }

    impl AttachProbe for FakeProbe {
        fn has_listener(&self, pid: u32) -> bool {
            pid == self.listener
        }
        fn version(&self, _pid: u32) -> Option<JavaVersion> {
            self.version.clone()
        }
        fn histogram(&self, _pid: u32) -> Result<String, AttachError> {
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(self.delay);
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            self.histograms.lock().pop_front().expect("unexpected histogram request")
        }
        fn alive(&self, _pid: u32) -> bool {
            self.alive
        }
    }

    const HISTOGRAM: &str = " num     #instances         #bytes  class name (module)\n-------------------------------------------------------\n   1:             5             80  A\n   2:             1             16  B\nTotal             6             96\n";

    fn unavailable(
        r: IdeResult<Result<(JvmMemorySnapshot, ClassCounts), JvmMemoryUnavailable>>,
    ) -> JvmMemoryUnavailable {
        r.unwrap().map(|_| ()).unwrap_err()
    }

    #[test]
    fn picks_first_descendant_with_listener() {
        assert_eq!(pick_jvm_pid(&[10, 11, 12], |p| p == 12), Some(12));
        assert_eq!(pick_jvm_pid(&[10], |_| false), None);
    }

    #[test]
    fn first_snapshot_has_no_deltas() {
        let (rows, map) = diff_rows(vec![row("A", 5, 80), row("B", 1, 16)], None);
        assert!(rows.iter().all(|r| r.delta_instances.is_none() && r.delta_bytes.is_none() && !r.ambiguous));
        assert_eq!(map, HashMap::from([("A".into(), Some((5, 80))), ("B".into(), Some((1, 16)))]));
    }

    #[test]
    fn deltas_against_previous_snapshot() {
        let previous = HashMap::from([("A".to_owned(), Some((2, 32)))]);
        let (rows, _) = diff_rows(vec![row("A", 5, 80), row("B", 1, 16)], Some(&previous));
        assert_eq!((rows[0].name.as_str(), rows[0].delta_instances, rows[0].delta_bytes), ("A", Some(3), Some(48)));
        assert_eq!((rows[1].name.as_str(), rows[1].delta_instances, rows[1].delta_bytes), ("B", Some(1), Some(16)));

        let previous = HashMap::from([("A".to_owned(), Some((9, 144)))]);
        let (rows, _) = diff_rows(vec![row("A", 5, 80)], Some(&previous));
        assert_eq!((rows[0].delta_instances, rows[0].delta_bytes), (Some(-4), Some(-64)));
    }

    #[test]
    fn duplicate_names_are_ambiguous_without_delta() {
        let previous = HashMap::from([("Foo".to_owned(), Some((1, 16)))]);
        let (rows, map) = diff_rows(vec![row("Foo", 2, 32), row("Foo", 3, 48), row("Bar", 1, 8)], Some(&previous));
        let foos: Vec<_> = rows.iter().filter(|r| r.name == "Foo").collect();
        assert_eq!(foos.len(), 2);
        assert!(foos.iter().all(|r| r.ambiguous && r.delta_instances.is_none() && r.delta_bytes.is_none()));
        assert_eq!(map.get("Foo"), Some(&None));
        assert_eq!(map.get("Bar"), Some(&Some((1, 8))));
    }

    #[test]
    fn previously_duplicate_now_unique_has_no_delta() {
        let (_, previous) = diff_rows(vec![row("Foo", 2, 32), row("Foo", 3, 48)], None);
        let (rows, map) = diff_rows(vec![row("Foo", 4, 64)], Some(&previous));
        assert!(!rows[0].ambiguous);
        assert_eq!((rows[0].delta_instances, rows[0].delta_bytes), (None, None));
        assert_eq!(map.get("Foo"), Some(&Some((4, 64))));
    }

    #[test]
    fn rows_sorted_by_bytes_descending() {
        let (rows, _) = diff_rows(vec![row("S", 1, 8), row("L", 1, 800), row("M", 1, 80)], None);
        let names: Vec<_> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["L", "M", "S"]);
    }

    #[test]
    fn refused_socket_reports_program_exited() {
        let mut probe = FakeProbe::new(12, vec![Err(AttachError::Refused)]);
        probe.alive = false;
        assert_eq!(unavailable(take_snapshot(&probe, &[10, 12], false, None)), JvmMemoryUnavailable::ProgramExited);

        let probe = FakeProbe::new(12, vec![Err(AttachError::Refused)]);
        assert_eq!(
            unavailable(take_snapshot(&probe, &[10, 12], false, None)),
            JvmMemoryUnavailable::ListenerNotRunning
        );
    }

    #[test]
    fn no_listener_in_tree() {
        let mut probe = FakeProbe::new(99, Vec::new());
        assert_eq!(
            unavailable(take_snapshot(&probe, &[10, 12], false, None)),
            JvmMemoryUnavailable::ListenerNotRunning
        );
        probe.alive = false;
        assert_eq!(unavailable(take_snapshot(&probe, &[10, 12], false, None)), JvmMemoryUnavailable::ProgramExited);
    }

    #[test]
    fn suspended_vm_needs_a_safe_jdk() {
        let mut probe = FakeProbe::new(12, Vec::new());
        probe.version = Some(JavaVersion { major: 11, text: "11.0.25".into() });
        assert_eq!(
            unavailable(take_snapshot(&probe, &[12], true, None)),
            JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 }
        );
        probe.version = None;
        assert_eq!(
            unavailable(take_snapshot(&probe, &[12], true, None)),
            JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 0 }
        );

        let probe = FakeProbe::new(12, vec![Ok(HISTOGRAM.into())]);
        let (snapshot, _) = take_snapshot(&probe, &[12], true, None).unwrap().unwrap();
        assert!(snapshot.taken_while_suspended);
        assert_eq!(snapshot.java_version, "21.0.5");
    }

    #[test]
    fn command_errors_are_internal() {
        let probe = FakeProbe::new(12, vec![Err(AttachError::Command { code: 1, message: "no".into() })]);
        let err = take_snapshot(&probe, &[12], false, None).unwrap_err();
        assert_eq!(err.kind, ide_core::error::ErrorKind::Internal);
    }

    #[test]
    fn result_serializes_with_camel_case_tags() {
        let r = JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 } };
        assert_eq!(
            serde_json::to_value(r).unwrap(),
            serde_json::json!({"status": "unavailable", "reason": {"kind": "unsafeWhileSuspended", "javaMajor": 11}})
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn histogram_lock_released_after_timeout() {
        let pid = std::process::id();
        let state = tokio::sync::Mutex::new(JvmMemoryState::default());
        let running = AtomicBool::new(false);
        let probe: Arc<dyn AttachProbe> =
            Arc::new(FakeProbe::new(pid, vec![Err(AttachError::Timeout), Ok(HISTOGRAM.into())]));
        let first = snapshot(&state, &running, |_| probe.clone(), pid as i32).await.unwrap();
        assert_eq!(first, JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::TimedOut });
        let second = tokio::time::timeout(Duration::from_secs(5), snapshot(&state, &running, |_| probe, pid as i32))
            .await
            .expect("second request blocked by the first")
            .unwrap();
        let JvmMemoryResult::Ready { snapshot } = second else { panic!("{second:?}") };
        assert!(!snapshot.has_baseline);
        assert_eq!((snapshot.total_instances, snapshot.total_bytes), (6, 96));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn one_histogram_at_a_time_per_session() {
        let pid = std::process::id();
        let state = tokio::sync::Mutex::new(JvmMemoryState::default());
        let mut fake = FakeProbe::new(pid, vec![Ok(HISTOGRAM.into()), Ok(HISTOGRAM.into())]);
        fake.delay = Duration::from_millis(100);
        let fake = Arc::new(fake);
        let probe: Arc<dyn AttachProbe> = fake.clone();
        let running = AtomicBool::new(false);
        let (a, b) = tokio::join!(
            snapshot(&state, &running, |_| probe.clone(), pid as i32),
            snapshot(&state, &running, |_| probe.clone(), pid as i32)
        );
        assert_eq!(fake.max_in_flight.load(Ordering::SeqCst), 1);
        let has_baseline = |r: JvmMemoryResult| match r {
            JvmMemoryResult::Ready { snapshot } => snapshot.has_baseline,
            other => panic!("{other:?}"),
        };
        let mut baselines = [has_baseline(a.unwrap()), has_baseline(b.unwrap())];
        baselines.sort();
        assert_eq!(baselines, [false, true]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queued_request_reads_suspension_under_the_lock() {
        let pid = std::process::id();
        let state = tokio::sync::Mutex::new(JvmMemoryState::default());
        let suspended = AtomicBool::new(false);
        let mut fake = FakeProbe::new(pid, Vec::new());
        fake.version = Some(JavaVersion { major: 11, text: "11.0.25".into() });
        let probe: Arc<dyn AttachProbe> = Arc::new(fake);
        let seen = parking_lot::Mutex::new(None);

        let running = state.lock().await;
        let mut queued = Box::pin(snapshot(
            &state,
            &suspended,
            |s| {
                *seen.lock() = Some(s);
                probe
            },
            pid as i32,
        ));
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut queued).await.is_err());
        // The program hits a breakpoint while the request waits behind another one.
        suspended.store(true, Ordering::Release);
        drop(running);
        assert_eq!(
            queued.await.unwrap(),
            JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 } }
        );
        assert_eq!(*seen.lock(), Some(true));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_blocking_task_keeps_the_baseline() {
        let pid = std::process::id();
        let state = tokio::sync::Mutex::new(JvmMemoryState::default());
        let running = AtomicBool::new(false);
        let probe = |histograms: Vec<_>| -> Arc<dyn AttachProbe> { Arc::new(FakeProbe::new(pid, histograms)) };
        snapshot(&state, &running, |_| probe(vec![Ok(HISTOGRAM.into())]), pid as i32).await.unwrap();
        // An empty fake panics on its histogram call, failing the blocking task.
        assert!(snapshot(&state, &running, |_| probe(Vec::new()), pid as i32).await.is_err());
        let third = snapshot(&state, &running, |_| probe(vec![Ok(HISTOGRAM.into())]), pid as i32).await.unwrap();
        let JvmMemoryResult::Ready { snapshot } = third else { panic!("{third:?}") };
        assert!(snapshot.has_baseline);
    }
}
