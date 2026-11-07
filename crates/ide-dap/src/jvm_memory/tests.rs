use super::scan::*;
use super::snapshot::*;
use super::*;
use ide_jvm_attach::{AttachError, HistogramRow, JavaVersion};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

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
    /// JDWP port → pid of the JVM listening on it.
    jdwp: Option<(u16, u32)>,
    scans: AtomicUsize,
    asked: parking_lot::Mutex<Vec<u32>>,
    /// Pids the scan sent a request to.
    queried: parking_lot::Mutex<Vec<u32>>,
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
            jdwp: None,
            scans: AtomicUsize::new(0),
            asked: parking_lot::Mutex::new(Vec::new()),
            queried: parking_lot::Mutex::new(Vec::new()),
        }
    }
}

impl AttachProbe for FakeProbe {
    fn has_listener(&self, pid: u32) -> bool {
        self.asked.lock().push(pid);
        pid == self.listener
    }
    fn find_by_jdwp_port(&self, port: u16, may_query: &dyn Fn(u32) -> bool) -> Option<u32> {
        self.scans.fetch_add(1, Ordering::SeqCst);
        let (listening, pid) = self.jdwp?;
        if !may_query(pid) {
            return None;
        }
        self.queried.lock().push(pid);
        (listening == port).then_some(pid)
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

fn unavailable(r: IdeResult<Result<(JvmMemorySnapshot, ClassCounts), JvmMemoryUnavailable>>) -> JvmMemoryUnavailable {
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
    assert_eq!(unavailable(take_snapshot(&probe, &[10, 12], false, None)), JvmMemoryUnavailable::ListenerNotRunning);
}

#[test]
fn no_listener_in_tree() {
    let mut probe = FakeProbe::new(99, Vec::new());
    assert_eq!(unavailable(take_snapshot(&probe, &[10, 12], false, None)), JvmMemoryUnavailable::ListenerNotRunning);
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

#[test]
fn local_jdwp_port_accepts_loopback_only() {
    let port = |args: serde_json::Value| local_jdwp_port(&args);
    for host in ["127.0.0.1", "localhost", "LocalHost", "::1", "[::1]"] {
        assert_eq!(port(serde_json::json!({"hostName": host, "port": 5005})), Some(5005), "{host}");
    }
    assert_eq!(port(serde_json::json!({"port": 5005})), Some(5005));
    assert_eq!(port(serde_json::json!({"hostName": "localhost", "port": "5005"})), Some(5005));
    assert_eq!(port(serde_json::json!({"hostName": "10.0.0.5", "port": 5005})), None);
    assert_eq!(port(serde_json::json!({"hostName": "build-box", "port": 5005})), None);
    assert_eq!(port(serde_json::json!({"hostName": "localhost", "port": 0})), None);
    assert_eq!(port(serde_json::json!({"hostName": "localhost", "port": 70000})), None);
    assert_eq!(port(serde_json::json!({"hostName": "localhost", "port": "x"})), None);
    assert_eq!(port(serde_json::json!({"hostName": "localhost"})), None);
}

#[tokio::test]
async fn attach_with_pid_takes_snapshot() {
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let running = Suspension::default();
    let jvm_pid = AtomicI64::new(4242);
    let fake = Arc::new(FakeProbe::new(4242, vec![Ok(HISTOGRAM.into())]));
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let target = JvmTarget::Attached { pid: &jvm_pid, jdwp_port: Some(5005) };
    let r = snapshot(&state, &running, |_| probe, target).await.unwrap();
    assert!(matches!(r, JvmMemoryResult::Ready { .. }), "{r:?}");
    // The attached JVM's own pid only: its children are not part of the session.
    assert_eq!(*fake.asked.lock(), [4242]);
    assert_eq!(fake.scans.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn refresh_rescans_local_attach_without_pid() {
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let running = Suspension::default();
    let jvm_pid = AtomicI64::new(0);

    let missing = Arc::new(FakeProbe::new(4242, Vec::new()));
    let probe: Arc<dyn AttachProbe> = missing.clone();
    let target = JvmTarget::Attached { pid: &jvm_pid, jdwp_port: Some(5005) };
    assert_eq!(
        snapshot(&state, &running, |_| probe, target).await.unwrap(),
        JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::AttachedJvmNotFound }
    );
    assert_eq!(missing.scans.load(Ordering::SeqCst), 1);
    assert_eq!(jvm_pid.load(Ordering::Acquire), 0);

    let mut found = FakeProbe::new(4242, vec![Ok(HISTOGRAM.into()), Ok(HISTOGRAM.into())]);
    found.jdwp = Some((5005, 4242));
    let found = Arc::new(found);
    let probe: Arc<dyn AttachProbe> = found.clone();
    let target = || JvmTarget::Attached { pid: &jvm_pid, jdwp_port: Some(5005) };
    let r = snapshot(&state, &running, |_| probe.clone(), target()).await.unwrap();
    assert!(matches!(r, JvmMemoryResult::Ready { .. }), "{r:?}");
    assert_eq!(jvm_pid.load(Ordering::Acquire), 4242);
    snapshot(&state, &running, |_| probe, target()).await.unwrap();
    assert_eq!(found.scans.load(Ordering::SeqCst), 1, "a found pid is kept");
}

#[tokio::test]
async fn remote_attach_without_pid_is_not_scanned() {
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let running = Suspension::default();
    let jvm_pid = AtomicI64::new(0);
    let mut fake = FakeProbe::new(4242, Vec::new());
    fake.jdwp = Some((5005, 4242));
    let fake = Arc::new(fake);
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let target = JvmTarget::Attached { pid: &jvm_pid, jdwp_port: None };
    assert_eq!(
        snapshot(&state, &running, |_| probe, target).await.unwrap(),
        JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::AttachedJvmNotFound }
    );
    assert_eq!(fake.scans.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn retries_find_until_the_jvm_appears() {
    let tries = Arc::new(AtomicUsize::new(0));
    let counted = tries.clone();
    let find = move |_| (counted.fetch_add(1, Ordering::SeqCst) >= 2).then_some(4242);
    let found = retry_find(find, || RUNNING, Duration::from_millis(1), Duration::from_secs(5)).await;
    assert_eq!(found, Some(4242));
    assert_eq!(tries.load(Ordering::SeqCst), 3);
}

const RUNNING: ScanGate = ScanGate::Scan { suspended: false };

#[tokio::test]
async fn retry_find_tells_each_try_whether_the_jvm_is_suspended() {
    let seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let recorded = seen.clone();
    // The JVM is an old JDK, so a suspended try skips it.
    let find = move |suspended: bool| {
        recorded.lock().push(suspended);
        (!suspended).then_some(4242)
    };
    let checks = AtomicUsize::new(0);
    // Suspended for the first three checks, then resumed.
    let gate = || ScanGate::Scan { suspended: checks.fetch_add(1, Ordering::SeqCst) < 3 };
    let found = retry_find(find, gate, Duration::from_millis(1), Duration::from_secs(5)).await;
    assert_eq!(found, Some(4242));
    assert_eq!(*seen.lock(), [true, true, true, false]);
}

#[test]
fn only_a_known_jdk_17_or_later_is_safe_while_suspended() {
    let jdk = |major| Some(JavaVersion { major, text: major.to_string() });
    assert!(safe_while_suspended(jdk(21).as_ref()));
    assert!(safe_while_suspended(jdk(17).as_ref()));
    assert!(!safe_while_suspended(jdk(11).as_ref()));
    assert!(!safe_while_suspended(None));
}

/// A suspended local attach session whose JVM (pid 4242, JDWP 5005) is not known yet.
async fn suspended_scan(fake: FakeProbe) -> (JvmMemoryResult, Arc<FakeProbe>, i64) {
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let suspended = Suspension::default();
    suspended.stopped();
    let jvm_pid = AtomicI64::new(0);
    let fake = Arc::new(fake);
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let target = JvmTarget::Attached { pid: &jvm_pid, jdwp_port: Some(5005) };
    let result = snapshot(&state, &suspended, |_| probe, target).await.unwrap();
    (result, fake, jvm_pid.load(Ordering::Acquire))
}

#[tokio::test]
async fn suspended_scan_finds_a_jdk_17_or_later() {
    let mut fake = FakeProbe::new(4242, vec![Ok(HISTOGRAM.into())]);
    fake.jdwp = Some((5005, 4242));
    let (result, fake, pid) = suspended_scan(fake).await;
    let JvmMemoryResult::Ready { snapshot } = result else { panic!("{result:?}") };
    assert!(snapshot.taken_while_suspended);
    assert_eq!(*fake.queried.lock(), [4242]);
    assert_eq!(pid, 4242);
}

#[tokio::test]
async fn suspended_scan_never_asks_an_older_jdk() {
    for (version, java_major) in [(Some(JavaVersion { major: 11, text: "11.0.25".into() }), 11), (None, 0)] {
        let mut fake = FakeProbe::new(4242, Vec::new());
        fake.jdwp = Some((5005, 4242));
        fake.version = version;
        let (result, fake, pid) = suspended_scan(fake).await;
        assert_eq!(
            result,
            JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::UnsafeWhileSuspended { java_major } }
        );
        assert!(fake.queried.lock().is_empty());
        assert!(fake.asked.lock().is_empty());
        assert_eq!(pid, 0);
    }
}

#[tokio::test]
async fn suspended_scan_without_candidates_is_not_found() {
    let (result, _, _) = suspended_scan(FakeProbe::new(4242, Vec::new())).await;
    assert_eq!(result, JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::AttachedJvmNotFound });
}

#[tokio::test]
async fn retry_find_gives_up_after_its_window() {
    let tries = Arc::new(AtomicUsize::new(0));
    let counted = tries.clone();
    let find = move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        None
    };
    let started = std::time::Instant::now();
    let found = retry_find(find, || RUNNING, Duration::from_millis(10), Duration::from_millis(100)).await;
    assert_eq!(found, None);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(tries.load(Ordering::SeqCst) >= 2);
}

#[tokio::test]
async fn retry_find_stops_when_the_session_ends() {
    let tries = Arc::new(AtomicUsize::new(0));
    let counted = tries.clone();
    let find = move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        None
    };
    let live = AtomicBool::new(true);
    let gate = || if live.swap(false, Ordering::SeqCst) { RUNNING } else { ScanGate::Ended };
    let found = retry_find(find, gate, Duration::from_millis(1), Duration::from_secs(5)).await;
    assert_eq!(found, None);
    assert_eq!(tries.load(Ordering::SeqCst), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn histogram_lock_released_after_timeout() {
    let pid = std::process::id();
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let running = Suspension::default();
    let probe: Arc<dyn AttachProbe> =
        Arc::new(FakeProbe::new(pid, vec![Err(AttachError::Timeout), Ok(HISTOGRAM.into())]));
    let first = snapshot(&state, &running, |_| probe.clone(), JvmTarget::Launched(pid as i32)).await.unwrap();
    assert_eq!(first, JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::TimedOut });
    let second = tokio::time::timeout(
        Duration::from_secs(5),
        snapshot(&state, &running, |_| probe, JvmTarget::Launched(pid as i32)),
    )
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
    let running = Suspension::default();
    let (a, b) = tokio::join!(
        snapshot(&state, &running, |_| probe.clone(), JvmTarget::Launched(pid as i32)),
        snapshot(&state, &running, |_| probe.clone(), JvmTarget::Launched(pid as i32))
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
    let suspended = Suspension::default();
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
        JvmTarget::Launched(pid as i32),
    ));
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut queued).await.is_err());
    // The program hits a breakpoint while the request waits behind another one.
    suspended.stopped();
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
    let running = Suspension::default();
    let probe = |histograms: Vec<_>| -> Arc<dyn AttachProbe> { Arc::new(FakeProbe::new(pid, histograms)) };
    snapshot(&state, &running, |_| probe(vec![Ok(HISTOGRAM.into())]), JvmTarget::Launched(pid as i32)).await.unwrap();
    // An empty fake panics on its histogram call, failing the blocking task.
    assert!(snapshot(&state, &running, |_| probe(Vec::new()), JvmTarget::Launched(pid as i32)).await.is_err());
    let third = snapshot(&state, &running, |_| probe(vec![Ok(HISTOGRAM.into())]), JvmTarget::Launched(pid as i32))
        .await
        .unwrap();
    let JvmMemoryResult::Ready { snapshot } = third else { panic!("{third:?}") };
    assert!(snapshot.has_baseline);
}
