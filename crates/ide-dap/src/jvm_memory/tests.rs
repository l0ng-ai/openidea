use super::fallback::{debugger_snapshot, falls_back};
use super::heap::*;
use super::scan::*;
use super::snapshot::*;
use super::test_support::{BareSession, FakeInspector, bare_session, bare_session_of};
use super::threads::*;
use super::*;
use ide_core::CancellationToken;
use ide_jvm_attach::{AttachError, HeapDumpReply, HistogramRow, JavaVersion};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
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
    /// Attach commands sent, in order: `histogram`, `vm_flags`, `heap_dump`.
    commands: parking_lot::Mutex<Vec<&'static str>>,
    dumps: parking_lot::Mutex<VecDeque<Result<HeapDumpReply, AttachError>>>,
    dump_paths: parking_lot::Mutex<Vec<PathBuf>>,
    /// Each heap dump waits for this gate to open.
    dump_gate: Option<Arc<Gate>>,
    /// A `Created` reply writes this many bytes to the dump path first.
    dump_bytes: usize,
    free: Option<u64>,
    /// Answering this command stops the program: runs the hook.
    stops_on: Option<(&'static str, StopHook)>,
    thread_dumps: parking_lot::Mutex<VecDeque<Result<String, AttachError>>>,
    /// Replies to `ensure_listener`, in order; `Ok` once empty.
    listener_starts: parking_lot::Mutex<VecDeque<Result<(), AttachError>>>,
    /// Pids `is_application_jvm` confirms.
    application_jvms: Vec<u32>,
    /// Pids `ensure_listener` was asked for.
    ensured: parking_lot::Mutex<Vec<u32>>,
    json_dumps: parking_lot::Mutex<VecDeque<Result<String, AttachError>>>,
    json_dirs: parking_lot::Mutex<Vec<PathBuf>>,
}

type StopHook = Box<dyn Fn() + Send + Sync>;

/// Holds a blocking call until the test opens it.
#[derive(Default)]
struct Gate {
    entered: tokio::sync::Notify,
    open: parking_lot::Mutex<bool>,
    opened: parking_lot::Condvar,
}

impl Gate {
    fn pass(&self) {
        self.entered.notify_one();
        let mut open = self.open.lock();
        while !*open {
            self.opened.wait(&mut open);
        }
    }

    fn release(&self) {
        *self.open.lock() = true;
        self.opened.notify_all();
    }
}

/// Opens the gate when dropped: a failed assertion must not leave a blocking thread waiting,
/// since the runtime's shutdown waits for it.
struct OpenOnDrop(Arc<Gate>);

impl Drop for OpenOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
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
            commands: parking_lot::Mutex::new(Vec::new()),
            dumps: parking_lot::Mutex::new(VecDeque::new()),
            dump_paths: parking_lot::Mutex::new(Vec::new()),
            dump_gate: None,
            dump_bytes: 64,
            free: None,
            stops_on: None,
            thread_dumps: parking_lot::Mutex::new(VecDeque::new()),
            listener_starts: parking_lot::Mutex::new(VecDeque::new()),
            application_jvms: Vec::new(),
            ensured: parking_lot::Mutex::new(Vec::new()),
            json_dumps: parking_lot::Mutex::new(VecDeque::new()),
            json_dirs: parking_lot::Mutex::new(Vec::new()),
        }
    }

    fn record(&self, command: &'static str) {
        self.commands.lock().push(command);
        if let Some((on, stop)) = &self.stops_on
            && *on == command
        {
            stop();
        }
    }

    fn enter(&self, command: &'static str) {
        self.record(command);
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(now, Ordering::SeqCst);
    }

    fn leave(&self) {
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
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
        self.enter("histogram");
        std::thread::sleep(self.delay);
        self.leave();
        self.histograms.lock().pop_front().expect("unexpected histogram request")
    }
    fn alive(&self, _pid: u32) -> bool {
        self.alive
    }
    fn vm_flags(&self, _pid: u32) -> Result<String, AttachError> {
        self.record("vm_flags");
        Ok(FLAGS.into())
    }
    fn heap_dump(&self, _pid: u32, path: &Path, _timeout: Duration) -> Result<HeapDumpReply, AttachError> {
        self.enter("heap_dump");
        self.dump_paths.lock().push(path.to_owned());
        if let Some(gate) = &self.dump_gate {
            gate.pass();
        }
        let reply = self.dumps.lock().pop_front().expect("unexpected heap dump request");
        if matches!(reply, Ok(HeapDumpReply::Created { .. })) && self.dump_bytes > 0 {
            // Fails like the JVM's write once the directory is gone.
            let _ = std::fs::write(path, vec![0; self.dump_bytes]);
        }
        self.leave();
        reply
    }
    fn free_bytes(&self, _dir: &Path) -> Option<u64> {
        self.free
    }
    fn thread_print(&self, _pid: u32) -> Result<String, AttachError> {
        self.enter("thread_print");
        std::thread::sleep(self.delay);
        self.leave();
        self.thread_dumps.lock().pop_front().expect("unexpected thread dump request")
    }
    fn ensure_listener(&self, pid: u32) -> Result<(), AttachError> {
        self.record("ensure_listener");
        self.ensured.lock().push(pid);
        self.listener_starts.lock().pop_front().unwrap_or(Ok(()))
    }
    fn is_application_jvm(&self, pid: u32) -> bool {
        self.application_jvms.contains(&pid)
    }
    fn thread_dump_json(&self, _pid: u32, dir: &Path) -> Result<String, AttachError> {
        self.enter("thread_dump_json");
        self.json_dirs.lock().push(dir.to_owned());
        self.leave();
        self.json_dumps.lock().pop_front().expect("unexpected JSON thread dump request")
    }
}

const FLAGS: &str = "-XX:+UseCompressedOops -XX:+StartAttachListener";

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
    let r = JvmMemoryResult::Unavailable {
        reason: JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 },
        can_count_when_paused: true,
    };
    assert_eq!(
        serde_json::to_value(r).unwrap(),
        serde_json::json!({
            "status": "unavailable",
            "reason": {"kind": "unsafeWhileSuspended", "javaMajor": 11},
            "canCountWhenPaused": true
        })
    );
    assert_eq!(serde_json::to_value(JvmMemorySource::Debugger).unwrap(), "debugger");
    let stale = JvmFieldsResult::Unavailable { reason: JvmInspectUnavailable::Stale };
    assert_eq!(
        serde_json::to_value(stale).unwrap(),
        serde_json::json!({"status": "unavailable", "reason": {"kind": "stale"}})
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
    let r = snapshot(&state, &running, |_| probe, target, None).await.unwrap();
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
        snapshot(&state, &running, |_| probe, target, None).await.unwrap(),
        JvmMemoryResult::Unavailable {
            reason: JvmMemoryUnavailable::AttachedJvmNotFound,
            can_count_when_paused: false
        }
    );
    assert_eq!(missing.scans.load(Ordering::SeqCst), 1);
    assert_eq!(jvm_pid.load(Ordering::Acquire), 0);

    let mut found = FakeProbe::new(4242, vec![Ok(HISTOGRAM.into()), Ok(HISTOGRAM.into())]);
    found.jdwp = Some((5005, 4242));
    let found = Arc::new(found);
    let probe: Arc<dyn AttachProbe> = found.clone();
    let target = || JvmTarget::Attached { pid: &jvm_pid, jdwp_port: Some(5005) };
    let r = snapshot(&state, &running, |_| probe.clone(), target(), None).await.unwrap();
    assert!(matches!(r, JvmMemoryResult::Ready { .. }), "{r:?}");
    assert_eq!(jvm_pid.load(Ordering::Acquire), 4242);
    snapshot(&state, &running, |_| probe, target(), None).await.unwrap();
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
        snapshot(&state, &running, |_| probe, target, None).await.unwrap(),
        JvmMemoryResult::Unavailable {
            reason: JvmMemoryUnavailable::AttachedJvmNotFound,
            can_count_when_paused: false
        }
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
    suspended.stopped(None, true);
    let jvm_pid = AtomicI64::new(0);
    let fake = Arc::new(fake);
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let target = JvmTarget::Attached { pid: &jvm_pid, jdwp_port: Some(5005) };
    let result = snapshot(&state, &suspended, |_| probe, target, None).await.unwrap();
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
            JvmMemoryResult::Unavailable {
                reason: JvmMemoryUnavailable::UnsafeWhileSuspended { java_major },
                can_count_when_paused: false,
            }
        );
        assert!(fake.queried.lock().is_empty());
        assert!(fake.asked.lock().is_empty());
        assert_eq!(pid, 0);
    }
}

#[tokio::test]
async fn suspended_scan_without_candidates_is_not_found() {
    let (result, _, _) = suspended_scan(FakeProbe::new(4242, Vec::new())).await;
    assert_eq!(
        result,
        JvmMemoryResult::Unavailable {
            reason: JvmMemoryUnavailable::AttachedJvmNotFound,
            can_count_when_paused: false
        }
    );
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
    let first = snapshot(&state, &running, |_| probe.clone(), JvmTarget::Launched(pid as i32), None).await.unwrap();
    assert_eq!(
        first,
        JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::TimedOut, can_count_when_paused: false }
    );
    let second = tokio::time::timeout(
        Duration::from_secs(5),
        snapshot(&state, &running, |_| probe, JvmTarget::Launched(pid as i32), None),
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
        snapshot(&state, &running, |_| probe.clone(), JvmTarget::Launched(pid as i32), None),
        snapshot(&state, &running, |_| probe.clone(), JvmTarget::Launched(pid as i32), None)
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
        None,
    ));
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut queued).await.is_err());
    // The program hits a breakpoint while the request waits behind another one.
    suspended.stopped(None, true);
    drop(running);
    assert_eq!(
        queued.await.unwrap(),
        JvmMemoryResult::Unavailable {
            reason: JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 },
            can_count_when_paused: false,
        }
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
    snapshot(&state, &running, |_| probe(vec![Ok(HISTOGRAM.into())]), JvmTarget::Launched(pid as i32), None)
        .await
        .unwrap();
    // An empty fake panics on its histogram call, failing the blocking task.
    assert!(snapshot(&state, &running, |_| probe(Vec::new()), JvmTarget::Launched(pid as i32), None).await.is_err());
    let third =
        snapshot(&state, &running, |_| probe(vec![Ok(HISTOGRAM.into())]), JvmTarget::Launched(pid as i32), None)
            .await
            .unwrap();
    let JvmMemoryResult::Ready { snapshot } = third else { panic!("{third:?}") };
    assert!(snapshot.has_baseline);
}

fn class(name: &str, instances: u64) -> ide_jvm_inspect::ClassCount {
    ide_jvm_inspect::ClassCount { name: name.into(), instances }
}

fn jdk11(listener: u32) -> FakeProbe {
    let mut probe = FakeProbe::new(listener, Vec::new());
    probe.version = Some(JavaVersion { major: 11, text: "11.0.25".into() });
    probe
}

/// The class table of `bare`'s session, histogram from `probe` or else `target`'s reason.
async fn table(bare: &BareSession, probe: FakeProbe, target: JvmTarget<'_>) -> JvmMemoryResult {
    let s = &bare.session;
    let probe: Arc<dyn AttachProbe> = Arc::new(probe);
    snapshot(&s.jvm_memory, &s.suspended, |_| probe, target, Some(s)).await.unwrap()
}

fn inspected(bare: &BareSession, fake: FakeInspector) -> Arc<FakeInspector> {
    let fake = Arc::new(fake);
    *bare.session.jvm_inspector.lock() = Some(fake.clone());
    fake
}

#[cfg(unix)]
#[tokio::test]
async fn suspended_jdk11_falls_back_to_debugger_counts() {
    let pid = std::process::id();
    let bare = bare_session("launch");
    bare.session.suspended.stopped(None, true);
    let fake = inspected(&bare, FakeInspector::default());
    fake.counts.lock().extend([class("A", 3), class("B", 0)]);
    let target = JvmTarget::Launched(pid as i32);
    let result = table(&bare, jdk11(pid), target).await;
    let JvmMemoryResult::Ready { snapshot } = result else { panic!("{result:?}") };
    assert_eq!(snapshot.source, JvmMemorySource::Debugger);
    assert_eq!(
        snapshot.rows,
        [JvmClassRow {
            name: "A".into(),
            module: None,
            instances: 3,
            bytes: 0,
            delta_instances: None,
            delta_bytes: None,
            ambiguous: false
        }]
    );
    assert_eq!((snapshot.total_instances, snapshot.total_bytes), (3, 0));
    assert!(snapshot.taken_while_suspended && !snapshot.has_baseline);
    assert_eq!(fake.calls(), 1);
}

#[tokio::test]
async fn reasons_found_before_asking_the_jvm_fall_back_too() {
    let bare = bare_session("launch");
    bare.session.suspended.stopped(None, true);
    let fake = inspected(&bare, FakeInspector::default());
    fake.counts.lock().push(class("A", 3));
    let result = table(&bare, jdk11(1), JvmTarget::Unavailable(JvmMemoryUnavailable::UnsupportedPlatform)).await;
    assert!(matches!(&result, JvmMemoryResult::Ready { snapshot } if snapshot.source == JvmMemorySource::Debugger));
}

#[tokio::test]
async fn running_without_listener_offers_counting_when_paused() {
    let bare = bare_session("launch");
    let reason = JvmMemoryUnavailable::ListenerNotRunning;
    let target = JvmTarget::Unavailable(reason);
    let without = table(&bare, jdk11(1), target).await;
    assert_eq!(without, JvmMemoryResult::Unavailable { reason, can_count_when_paused: false });

    let fake = inspected(&bare, FakeInspector::default());
    let with = table(&bare, jdk11(1), target).await;
    assert_eq!(with, JvmMemoryResult::Unavailable { reason, can_count_when_paused: true });
    assert_eq!(fake.calls(), 0);
}

#[tokio::test]
async fn other_reasons_do_not_fall_back() {
    let bare = bare_session("attach");
    bare.session.suspended.stopped(None, true);
    let fake = inspected(&bare, FakeInspector::default());
    for reason in [JvmMemoryUnavailable::ProgramExited, JvmMemoryUnavailable::TimedOut] {
        let result = table(&bare, jdk11(1), JvmTarget::Unavailable(reason)).await;
        assert_eq!(result, JvmMemoryResult::Unavailable { reason, can_count_when_paused: false });
    }
    assert_eq!(fake.calls(), 0);
}

#[tokio::test]
async fn failed_debugger_count_reports_the_histogram_reason() {
    let bare = bare_session("launch");
    bare.session.suspended.stopped(None, true);
    inspected(&bare, FakeInspector::failing(ide_jvm_inspect::InspectError::TimedOut));
    let reason = JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 };
    let result = table(&bare, jdk11(1), JvmTarget::Unavailable(reason)).await;
    assert_eq!(result, JvmMemoryResult::Unavailable { reason, can_count_when_paused: false });
}

#[tokio::test]
async fn unsupported_count_turns_the_backend_off() {
    use ide_core::event::{DebugEvent, JvmBackendState};
    let bare = bare_session("launch");
    bare.session.suspended.stopped(None, true);
    inspected(&bare, FakeInspector::failing(ide_jvm_inspect::InspectError::Unsupported("x".into())));
    let reason = JvmMemoryUnavailable::UnsupportedPlatform;
    let result = table(&bare, jdk11(1), JvmTarget::Unavailable(reason)).await;
    assert_eq!(result, JvmMemoryResult::Unavailable { reason, can_count_when_paused: false });
    assert!(bare.session.jvm_inspector.lock().is_none());
    let events: Vec<_> = bare
        .events
        .lock()
        .iter()
        .filter_map(|e| match e {
            ide_core::IdeEvent::Debug { event, .. } => Some(event.clone()),
            _ => None,
        })
        .collect();
    assert!(
        matches!(
            events.as_slice(),
            [DebugEvent::JvmBackend { state: JvmBackendState::Unsupported { .. } }, DebugEvent::Capabilities]
        ),
        "{events:?}"
    );
}

#[test]
fn falls_back_only_where_the_debugger_can_count() {
    use JvmMemoryUnavailable as U;
    for reason in [
        U::UnsafeWhileSuspended { java_major: 11 },
        U::UnsupportedPlatform,
        U::AttachedJvmNotFound,
        U::ListenerNotRunning,
        U::ListenModeNotSupported,
        U::NoJvmProcess,
    ] {
        assert!(falls_back(&reason), "{reason:?}");
    }
    assert!(!falls_back(&U::ProgramExited) && !falls_back(&U::TimedOut));
}

#[test]
fn deltas_only_against_the_same_source() {
    use JvmMemorySource::{Debugger, Histogram};
    let mut state = JvmMemoryState::default();
    let probe = FakeProbe::new(12, vec![Ok(HISTOGRAM.into())]);
    let (_, counts) = take_snapshot(&probe, &[12], false, None).unwrap().unwrap();
    state.remember(Histogram, counts);

    let (snapshot, counts) =
        debugger_snapshot(vec![class("A", 3), class("C", 1)], state.baseline(Debugger).as_deref(), 0);
    assert!(!snapshot.has_baseline);
    assert!(snapshot.rows.iter().all(|r| r.delta_instances.is_none() && r.delta_bytes.is_none()), "{snapshot:?}");
    state.remember(Debugger, counts);
    assert!(state.baseline(Histogram).is_none());

    let (snapshot, _) = debugger_snapshot(vec![class("A", 4)], state.baseline(Debugger).as_deref(), 0);
    assert!(snapshot.has_baseline);
    assert_eq!((snapshot.rows[0].delta_instances, snapshot.rows[0].delta_bytes), (Some(1), None));
}

#[test]
fn debugger_rows_are_ordered_by_instances() {
    let (snapshot, _) = debugger_snapshot(vec![class("B", 1), class("A", 9), class("C", 9)], None, 0);
    let names: Vec<_> = snapshot.rows.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["A", "C", "B"]);
}

/// A snapshot directory inside a temporary one, so the capture may delete it.
fn snapshot_dir(name: &str) -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(name);
    std::fs::create_dir(&dir).unwrap();
    (root, dir)
}

/// JVM 12 at Java `major`, answering [`HISTOGRAM`] once and `dumps` in turn.
fn dumping(major: u32, dumps: Vec<Result<HeapDumpReply, AttachError>>) -> FakeProbe {
    let mut probe = FakeProbe::new(12, vec![Ok(HISTOGRAM.into())]);
    probe.version = Some(JavaVersion { major, text: format!("{major}.0.1") });
    probe.dumps = parking_lot::Mutex::new(dumps.into());
    probe
}

fn created() -> Result<HeapDumpReply, AttachError> {
    Ok(HeapDumpReply::Created { bytes: Some(64) })
}

fn memory(reason: JvmMemoryUnavailable) -> JvmHeapOutcome {
    JvmHeapOutcome::Unavailable(JvmHeapUnavailable::Memory { reason })
}

fn dump_failed(message: &str) -> JvmHeapOutcome {
    JvmHeapOutcome::Unavailable(JvmHeapUnavailable::DumpFailed { message: message.into() })
}

fn ready(outcome: IdeResult<JvmHeapOutcome>) -> JvmHeapDump {
    match outcome.unwrap() {
        JvmHeapOutcome::Ready(dump) => dump,
        other => panic!("{other:?}"),
    }
}

fn entry(name: &str, instances: u64, bytes: u64) -> ide_heap::HistogramEntry {
    ide_heap::HistogramEntry { name: name.into(), instances, bytes }
}

#[test]
fn suspended_jdk11_refuses_without_sending() {
    let (_root, dir) = snapshot_dir("snap");
    let probe = dumping(11, vec![created()]);
    let outcome = take_heap_dump(&probe, &[12], true, &|| true, &dir, &CancellationToken::new()).unwrap();
    assert_eq!(outcome, memory(JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 }));
    assert!(probe.commands.lock().is_empty());
    assert!(!dir.exists());
}

#[test]
fn suspended_jdk17_dumps() {
    let (_root, dir) = snapshot_dir("snap");
    let probe = dumping(17, vec![created()]);
    let dump = ready(take_heap_dump(&probe, &[10, 12], true, &|| true, &dir, &CancellationToken::new()));
    assert_eq!(*probe.commands.lock(), ["histogram", "vm_flags", "heap_dump"]);
    assert_eq!(*probe.dump_paths.lock(), [dir.join("dump.hprof")]);
    let expected = JvmHeapDump {
        path: dir.join("dump.hprof"),
        histogram: vec![entry("A", 5, 80), entry("B", 1, 16)],
        vm_flags: FLAGS.into(),
        java_major: 17,
        java_version: "17.0.1".into(),
        pid: 12,
        taken_while_suspended: true,
        dump_ms: dump.dump_ms,
    };
    assert_eq!(dump, expected);
    assert!(dump.path.is_file());
}

#[test]
fn running_jdk8_dumps() {
    let (_root, dir) = snapshot_dir("snap");
    let probe = dumping(8, vec![created()]);
    let dump = ready(take_heap_dump(&probe, &[12], false, &|| false, &dir, &CancellationToken::new()));
    assert_eq!((dump.java_major, dump.taken_while_suspended), (8, false));
    assert_eq!(*probe.commands.lock(), ["histogram", "vm_flags", "heap_dump"]);
}

#[test]
fn not_enough_disk_space_refuses_before_dump() {
    let (_root, dir) = snapshot_dir("snap");
    let mut probe = dumping(21, vec![created()]);
    let gib = 1u64 << 30;
    let histogram = format!("   1:      10000000     {gib}  [B\nTotal      10000000     {gib}\n");
    probe.histograms = parking_lot::Mutex::new(vec![Ok(histogram)].into());
    probe.free = Some(512 << 20);
    let outcome = take_heap_dump(&probe, &[12], false, &|| false, &dir, &CancellationToken::new()).unwrap();
    let needed = gib + 1_060_000_000 + gib;
    assert_eq!(
        outcome,
        JvmHeapOutcome::Unavailable(JvmHeapUnavailable::NotEnoughDiskSpace { needed, available: 512 << 20 })
    );
    assert_eq!(*probe.commands.lock(), ["histogram"]);
    assert!(!dir.exists());
}

#[test]
fn refused_dump_reports_message() {
    let (_root, dir) = snapshot_dir("snap");
    let message = "Unable to create /tmp/snap/dump.hprof: File exists";
    let probe = dumping(21, vec![Ok(HeapDumpReply::Refused { message: message.into() })]);
    let outcome = take_heap_dump(&probe, &[12], false, &|| false, &dir, &CancellationToken::new()).unwrap();
    assert_eq!(outcome, dump_failed(message));
    assert!(!dir.exists());
}

#[test]
fn refused_dump_without_a_reason_says_so() {
    for body in ["", "Dumping heap to /tmp/snap/dump.hprof ..."] {
        let (_root, dir) = snapshot_dir("snap");
        let probe = dumping(21, vec![Ok(HeapDumpReply::Refused { message: body.into() })]);
        let outcome = take_heap_dump(&probe, &[12], false, &|| false, &dir, &CancellationToken::new()).unwrap();
        let JvmHeapOutcome::Unavailable(JvmHeapUnavailable::DumpFailed { message }) = outcome else {
            panic!("{body:?}: {outcome:?}")
        };
        assert!(!message.is_empty() && !message.starts_with("Dumping heap to"), "{body:?}: {message:?}");
        assert!(!dir.exists());
    }
}

#[test]
fn timed_out_dump_removes_snapshot_dir() {
    let (_root, dir) = snapshot_dir("snap");
    let probe = dumping(21, vec![Err(AttachError::Timeout)]);
    let outcome = take_heap_dump(&probe, &[12], false, &|| false, &dir, &CancellationToken::new()).unwrap();
    assert_eq!(outcome, JvmHeapOutcome::Unavailable(JvmHeapUnavailable::DumpTimedOut { seconds: 30 }));
    assert!(!dir.exists());
}

#[test]
fn capture_dir_with_space_is_quoted() {
    let (_root, dir) = snapshot_dir("a b");
    let probe = dumping(21, vec![created()]);
    ready(take_heap_dump(&probe, &[12], false, &|| false, &dir, &CancellationToken::new()));
    let path = probe.dump_paths.lock()[0].clone();
    assert!(path.to_str().unwrap().contains("a b"), "{path:?}");
    let command = ide_jvm_attach::heap_dump_command(&path).unwrap();
    assert_eq!(command, format!("GC.heap_dump -all \"{}\"", path.display()));
}

#[test]
fn created_without_a_file_fails() {
    let (_root, dir) = snapshot_dir("snap");
    let mut probe = dumping(21, vec![created()]);
    probe.dump_bytes = 0;
    let outcome = take_heap_dump(&probe, &[12], false, &|| false, &dir, &CancellationToken::new()).unwrap();
    assert!(matches!(outcome, JvmHeapOutcome::Unavailable(JvmHeapUnavailable::DumpFailed { .. })), "{outcome:?}");
    assert!(!dir.exists());
}

#[test]
fn dump_errors_map_like_the_class_table() {
    let message = "java.lang.IllegalArgumentException: Unknown argument";
    let cases = [
        (Err(AttachError::Refused), false, memory(JvmMemoryUnavailable::ProgramExited)),
        (Err(AttachError::NoListener), true, memory(JvmMemoryUnavailable::ListenerNotRunning)),
        (Err(AttachError::Command { code: -1, message: message.into() }), true, dump_failed(message)),
    ];
    for (reply, alive, expected) in cases {
        let (_root, dir) = snapshot_dir("snap");
        let mut probe = dumping(21, vec![reply]);
        probe.alive = alive;
        assert_eq!(take_heap_dump(&probe, &[12], false, &|| false, &dir, &CancellationToken::new()).unwrap(), expected);
        assert!(!dir.exists());
    }

    let (_root, dir) = snapshot_dir("snap");
    let probe = dumping(21, vec![Err(AttachError::Protocol("bad".into()))]);
    assert!(take_heap_dump(&probe, &[12], false, &|| false, &dir, &CancellationToken::new()).is_err());
    assert!(!dir.exists());
}

/// JDK `major`, running when the capture starts, stopped by the time it answers `command`.
fn stopping_after(major: u32, command: &'static str) -> (FakeProbe, Arc<AtomicBool>) {
    let stopped = Arc::new(AtomicBool::new(false));
    let mut probe = dumping(major, vec![created()]);
    let flag = stopped.clone();
    probe.stops_on = Some((command, Box::new(move || flag.store(true, Ordering::SeqCst))));
    (probe, stopped)
}

#[test]
fn jdk11_stopped_during_the_histogram_gets_no_further_request() {
    for (command, sent) in [("histogram", &["histogram"][..]), ("vm_flags", &["histogram", "vm_flags"][..])] {
        let (_root, dir) = snapshot_dir("snap");
        let (probe, stopped) = stopping_after(11, command);
        let suspended_now = || stopped.load(Ordering::SeqCst);
        let outcome = take_heap_dump(&probe, &[12], false, &suspended_now, &dir, &CancellationToken::new()).unwrap();
        assert_eq!(outcome, memory(JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 }), "{command}");
        assert_eq!(*probe.commands.lock(), sent, "{command}");
        assert!(!dir.exists(), "{command}");
    }
}

#[tokio::test]
async fn session_stopped_during_the_histogram_is_read_again_before_the_dump() {
    let bare = bare_session("attach");
    let mut probe = dumping(11, vec![created()]);
    let stopping = bare.session.clone();
    probe.stops_on = Some(("histogram", Box::new(move || stopping.suspended.stopped(Some(1), true))));
    let fake = Arc::new(probe);
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let pid = AtomicI64::new(12);
    let target = JvmTarget::Attached { pid: &pid, jdwp_port: None };
    let (_root, dir) = snapshot_dir("snap");
    let session = bare.session.clone();
    let suspended = move || capture_suspended(&session);
    let s = &bare.session;
    let outcome = heap_dump_with(&s.jvm_memory, suspended, |_| probe, target, dir.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(outcome, memory(JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 }));
    assert_eq!(*fake.commands.lock(), ["histogram"]);
    assert!(!dir.exists());
    assert!(s.jvm_memory.try_lock().is_ok(), "the lock is released");
}

#[test]
fn jdk17_stopped_during_the_histogram_still_dumps() {
    let (_root, dir) = snapshot_dir("snap");
    let (probe, stopped) = stopping_after(17, "histogram");
    let suspended_now = || stopped.load(Ordering::SeqCst);
    let dump = ready(take_heap_dump(&probe, &[12], false, &suspended_now, &dir, &CancellationToken::new()));
    assert!(!dump.taken_while_suspended, "the stop read when the capture began");
    assert_eq!(*probe.commands.lock(), ["histogram", "vm_flags", "heap_dump"]);
}

#[test]
fn cancelled_capture_sends_no_dump() {
    let (_root, dir) = snapshot_dir("snap");
    let probe = dumping(21, vec![created()]);
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(take_heap_dump(&probe, &[12], false, &|| false, &dir, &cancel).unwrap(), JvmHeapOutcome::Cancelled);
    assert!(!probe.commands.lock().contains(&"heap_dump"));
    assert!(!dir.exists());
}

#[tokio::test]
async fn cancelled_capture_releases_lock() {
    let state = Arc::new(tokio::sync::Mutex::new(JvmMemoryState::default()));
    let gate = Arc::new(Gate::default());
    let opener = OpenOnDrop(gate.clone());
    let mut fake = dumping(21, vec![created()]);
    fake.histograms.lock().push_back(Ok(HISTOGRAM.into()));
    fake.dump_gate = Some(gate.clone());
    let fake = Arc::new(fake);
    let jvm_pid = Arc::new(AtomicI64::new(12));
    let (_root, dir) = snapshot_dir("snap");
    let cancel = CancellationToken::new();
    let capture = {
        let (state, fake, jvm_pid, dir, cancel) =
            (state.clone(), fake.clone(), jvm_pid.clone(), dir.clone(), cancel.clone());
        async move {
            let target = JvmTarget::Attached { pid: &jvm_pid, jdwp_port: None };
            heap_dump_with(&state, || false, |_| -> Arc<dyn AttachProbe> { fake }, target, dir, cancel).await
        }
    };
    let caller = tokio::spawn(detached(capture, dir.clone(), cancel.clone()));
    gate.entered.notified().await;
    cancel.cancel();
    assert_eq!(caller.await.unwrap().unwrap(), JvmHeapOutcome::Cancelled);
    assert_eq!(fake.in_flight.load(Ordering::SeqCst), 1, "the JVM is still writing the dump");
    assert!(!dir.exists());

    let mut table = tokio::spawn({
        let (state, fake, jvm_pid) = (state.clone(), fake.clone(), jvm_pid.clone());
        async move {
            let target = JvmTarget::Attached { pid: &jvm_pid, jdwp_port: None };
            let probe: Arc<dyn AttachProbe> = fake;
            snapshot(&state, &Suspension::default(), |_| probe, target, None).await
        }
    });
    // While the gate is shut the dump holds the session's turn, so the class table cannot finish.
    let early = tokio::time::timeout(Duration::from_millis(100), &mut table).await;
    assert!(early.is_err(), "the class table ran beside the dump: {early:?}");
    drop(opener);
    let table = table.await.unwrap().unwrap();
    assert!(matches!(table, JvmMemoryResult::Ready { .. }), "{table:?}");
    assert_eq!(fake.max_in_flight.load(Ordering::SeqCst), 1);
    assert_eq!(*fake.commands.lock(), ["histogram", "vm_flags", "heap_dump", "histogram"]);
    assert!(!dir.exists(), "the dump that finished after the cancel is deleted");
}

#[tokio::test]
async fn capture_keeps_the_memory_baseline() {
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let running = Suspension::default();
    let pid = AtomicI64::new(12);
    let target = || JvmTarget::Attached { pid: &pid, jdwp_port: None };
    let table = |fake: FakeProbe| {
        let probe: Arc<dyn AttachProbe> = Arc::new(fake);
        snapshot(&state, &running, |_| probe, target(), None)
    };
    table(FakeProbe::new(12, vec![Ok(HISTOGRAM.into())])).await.unwrap();

    let mut capture = dumping(21, vec![created()]);
    let grown = "   1:            50            800  A\nTotal            50            800\n";
    capture.histograms = parking_lot::Mutex::new(vec![Ok(grown.into())].into());
    let probe: Arc<dyn AttachProbe> = Arc::new(capture);
    let (_root, dir) = snapshot_dir("snap");
    ready(heap_dump_with(&state, || false, |_| probe, target(), dir, CancellationToken::new()).await);

    let JvmMemoryResult::Ready { snapshot } = table(FakeProbe::new(12, vec![Ok(HISTOGRAM.into())])).await.unwrap()
    else {
        panic!("no class table")
    };
    let a = snapshot.rows.iter().find(|r| r.name == "A").unwrap();
    assert_eq!((a.delta_instances, a.delta_bytes), (Some(0), Some(0)));
}

#[tokio::test]
async fn attached_session_dumps_the_scanned_jvm() {
    let mut fake = dumping(21, vec![created()]);
    fake.listener = 4242;
    fake.jdwp = Some((5005, 4242));
    let fake = Arc::new(fake);
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let pid = AtomicI64::new(0);
    let target = JvmTarget::Attached { pid: &pid, jdwp_port: Some(5005) };
    let (_root, dir) = snapshot_dir("snap");
    let dump = ready(heap_dump_with(&state, || false, |_| probe, target, dir, CancellationToken::new()).await);
    assert_eq!(dump.pid, 4242);
    assert_eq!(pid.load(Ordering::SeqCst), 4242);
    assert_eq!(fake.scans.load(Ordering::SeqCst), 1);
}

/// A JDWP link whose fake JVM sent a suspending event, which the adapter would report next:
/// (link, adapter end, JVM end).
async fn suspended_link() -> (ide_jdwp::JdwpLink, tokio::net::TcpStream, tokio::net::TcpStream) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const HANDSHAKE: &[u8; 14] = b"JDWP-Handshake";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let options = ide_jdwp::LinkOptions { hold_resumes: false };
    let (link, link_port) = ide_jdwp::JdwpLink::start("127.0.0.1".into(), port, options).await.unwrap();
    let mut adapter = tokio::net::TcpStream::connect(("127.0.0.1", link_port)).await.unwrap();
    adapter.write_all(HANDSHAKE).await.unwrap();
    let (mut jvm, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept()).await.unwrap().unwrap();
    let mut buf = [0; 14];
    jvm.read_exact(&mut buf).await.unwrap();
    jvm.write_all(HANDSHAKE).await.unwrap();
    adapter.read_exact(&mut buf).await.unwrap();
    // Event.Composite (64/100): SUSPEND_ALL, one VM_START event, request 0, thread 1.
    let body = [2, 0, 0, 0, 1, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let mut packet = u32::try_from(11 + body.len()).unwrap().to_be_bytes().to_vec();
    packet.extend(1u32.to_be_bytes());
    packet.extend([0, 64, 100]);
    packet.extend(body);
    jvm.write_all(&packet).await.unwrap();
    let mut states = link.subscribe();
    let suspended = states.wait_for(|s| matches!(s, ide_jdwp::LinkState::Suspended { .. }));
    tokio::time::timeout(Duration::from_secs(2), suspended).await.unwrap().unwrap();
    (link, adapter, jvm)
}

#[tokio::test]
async fn jdk11_is_refused_while_the_link_is_suspended_before_dap_stops() {
    let bare = bare_session_of(crate::kotlin::ADAPTER, "attach");
    let s = &bare.session;
    let (link, _adapter, _jvm) = suspended_link().await;
    *s.jdwp_link.lock() = Some(link);
    assert!(!s.suspended.get());

    let fake = Arc::new(jdk11(12));
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let probe = |suspended: bool| {
        assert!(suspended, "the probe must not ask a suspended JVM's version over attach");
        probe
    };
    let pid = AtomicI64::new(12);
    let target = JvmTarget::Attached { pid: &pid, jdwp_port: None };
    let (_root, dir) = snapshot_dir("snap");
    let session = bare.session.clone();
    let suspended = move || capture_suspended(&session);
    let outcome =
        heap_dump_with(&s.jvm_memory, suspended, probe, target, dir.clone(), CancellationToken::new()).await.unwrap();
    assert_eq!(outcome, memory(JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 }));
    assert!(fake.commands.lock().is_empty());
    assert!(!dir.exists());
}

const THREADS: &str = "Full thread dump OpenJDK 64-Bit Server VM (21.0.5+11-LTS mixed mode, sharing):\n\n\"main\" #1 [259] prio=5 os_prio=31 cpu=31.20ms elapsed=1.70s tid=0x1 nid=259 runnable  [0x2]\n   java.lang.Thread.State: RUNNABLE\n";

fn dumping_threads(listener: u32, dumps: Vec<Result<String, AttachError>>) -> FakeProbe {
    let fake = FakeProbe::new(listener, Vec::new());
    *fake.thread_dumps.lock() = dumps.into();
    fake
}

fn threads_unavailable(r: JvmThreadsResult) -> JvmThreadsUnavailable {
    match r {
        JvmThreadsResult::Unavailable { reason } => reason,
        other => panic!("{other:?}"),
    }
}

fn threads_jvm(reason: JvmMemoryUnavailable) -> JvmThreadsUnavailable {
    JvmThreadsUnavailable::Jvm { reason }
}

/// The text dump alone: without a directory no JSON dump is asked for.
fn dump_text(fake: &FakeProbe, pid: u32, suspended: bool) -> JvmThreadsResult {
    dump_threads(fake, pid, suspended, None, &|| suspended)
}

fn ready_dump(r: JvmThreadsResult) -> JvmThreadDump {
    match r {
        JvmThreadsResult::Ready { dump } => dump,
        other => panic!("{other:?}"),
    }
}

const VIRTUAL_JSON: &str = r#"{"threadDump":{"threadContainers":[]}}"#;

fn json_dir() -> &'static Path {
    Path::new("/data/cache/heap-snapshots/x")
}

#[test]
fn threads_below_21_ask_for_no_json() {
    let mut fake = dumping_threads(99, vec![Ok(THREADS.into())]);
    fake.version = Some(JavaVersion { major: 17, text: "17.0.13".into() });
    let dump = ready_dump(dump_threads(&fake, 12, false, Some(json_dir()), &|| false));
    assert_eq!((dump.virtual_json, dump.virtual_note), (None, None));
    assert_eq!(*fake.commands.lock(), ["ensure_listener", "thread_print"]);
}

#[test]
fn threads_on_21_add_the_json_after_the_text() {
    let fake = dumping_threads(99, vec![Ok(THREADS.into())]);
    *fake.json_dumps.lock() = vec![Ok(VIRTUAL_JSON.into())].into();
    let dump = ready_dump(dump_threads(&fake, 12, false, Some(json_dir()), &|| false));
    assert_eq!(dump.text, THREADS);
    assert_eq!((dump.virtual_json.as_deref(), dump.virtual_note), (Some(VIRTUAL_JSON), None));
    assert_eq!(*fake.commands.lock(), ["ensure_listener", "thread_print", "thread_dump_json"]);
    assert_eq!(*fake.json_dirs.lock(), [json_dir()]);
}

#[test]
fn a_failed_json_dump_keeps_the_text_dump() {
    let cases = [
        (AttachError::TooLarge, VirtualThreadsNote::TooLarge),
        (AttachError::Timeout, VirtualThreadsNote::Failed),
        (AttachError::Protocol("no thread dump file".into()), VirtualThreadsNote::Failed),
    ];
    for (error, note) in cases {
        let fake = dumping_threads(99, vec![Ok(THREADS.into())]);
        *fake.json_dumps.lock() = vec![Err(error)].into();
        let dump = ready_dump(dump_threads(&fake, 12, false, Some(json_dir()), &|| false));
        assert_eq!((dump.text.as_str(), dump.virtual_json, dump.virtual_note), (THREADS, None, Some(note)));
    }

    // No directory to write the file into.
    let fake = dumping_threads(99, vec![Ok(THREADS.into())]);
    let dump = ready_dump(dump_text(&fake, 12, false));
    assert_eq!((dump.virtual_json, dump.virtual_note), (None, Some(VirtualThreadsNote::Failed)));
    assert_eq!(*fake.commands.lock(), ["ensure_listener", "thread_print"]);
}

#[test]
fn a_failed_text_dump_asks_for_no_json() {
    let fake = dumping_threads(99, vec![Err(AttachError::Timeout)]);
    let r = dump_threads(&fake, 12, false, Some(json_dir()), &|| false);
    assert_eq!(threads_unavailable(r), threads_jvm(JvmMemoryUnavailable::TimedOut));
    assert_eq!(*fake.commands.lock(), ["ensure_listener", "thread_print"]);
}

#[test]
fn threads_while_suspended_on_21_skip_the_json() {
    let fake = dumping_threads(12, vec![Ok(THREADS.into())]);
    let dump = ready_dump(dump_threads(&fake, 12, true, Some(json_dir()), &|| true));
    assert_eq!((dump.virtual_json, dump.virtual_note), (None, Some(VirtualThreadsNote::WhileSuspended)));
    assert_eq!(*fake.commands.lock(), ["thread_print"]);

    // The program hits a breakpoint while the text dump is taken.
    let stopped = Arc::new(AtomicBool::new(false));
    let mut fake = dumping_threads(99, vec![Ok(THREADS.into())]);
    let stop = stopped.clone();
    fake.stops_on = Some(("thread_print", Box::new(move || stop.store(true, Ordering::SeqCst))));
    let dump = ready_dump(dump_threads(&fake, 12, false, Some(json_dir()), &|| stopped.load(Ordering::SeqCst)));
    assert!(!dump.taken_while_suspended);
    assert_eq!((dump.virtual_json, dump.virtual_note), (None, Some(VirtualThreadsNote::WhileSuspended)));
    assert_eq!(*fake.commands.lock(), ["ensure_listener", "thread_print"]);
}

#[test]
fn threads_while_running_start_the_listener() {
    let fake = dumping_threads(99, vec![Ok(THREADS.into())]);
    let r = dump_text(&fake, 12, false);
    let JvmThreadsResult::Ready { dump } = r else { panic!("{r:?}") };
    assert_eq!((dump.text.as_str(), dump.pid, dump.java_version.as_str()), (THREADS, 12, "21.0.5"));
    assert!(!dump.taken_while_suspended);
    assert_eq!(*fake.commands.lock(), ["ensure_listener", "thread_print"]);
}

#[test]
fn threads_while_suspended_without_listener_do_not_attach() {
    let fake = dumping_threads(99, Vec::new());
    assert_eq!(threads_unavailable(dump_text(&fake, 12, true)), threads_jvm(JvmMemoryUnavailable::ListenerNotRunning));
    assert!(fake.commands.lock().is_empty());
}

#[test]
fn threads_while_suspended_on_11_are_refused() {
    let mut fake = dumping_threads(12, Vec::new());
    fake.version = Some(JavaVersion { major: 11, text: "11.0.25".into() });
    assert_eq!(
        threads_unavailable(dump_text(&fake, 12, true)),
        threads_jvm(JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 })
    );
    fake.version = None;
    assert_eq!(
        threads_unavailable(dump_text(&fake, 12, true)),
        threads_jvm(JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 0 })
    );
    assert!(fake.commands.lock().is_empty());
}

#[test]
fn threads_while_suspended_on_17_use_the_running_listener() {
    let mut fake = dumping_threads(12, vec![Ok(THREADS.into())]);
    fake.version = Some(JavaVersion { major: 17, text: "17.0.13".into() });
    let r = dump_text(&fake, 12, true);
    let JvmThreadsResult::Ready { dump } = r else { panic!("{r:?}") };
    assert!(dump.taken_while_suspended);
    assert_eq!(dump.java_version, "17.0.13");
    assert_eq!(*fake.commands.lock(), ["thread_print"]);
}

#[test]
fn threads_of_a_tree_without_a_listener_go_to_its_first_application_jvm() {
    // A shell (10) started a Gradle client (11) that started the program's JVM (12).
    let mut fake = dumping_threads(99, vec![Ok(THREADS.into())]);
    fake.application_jvms = vec![12];
    let r = dump_tree(&fake, &[10, 11, 12], false, None, &|| false);
    let JvmThreadsResult::Ready { dump } = r else { panic!("{r:?}") };
    assert_eq!(dump.pid, 12);
    assert_eq!(*fake.ensured.lock(), [12]);

    // No JVM at all: the reported pid is asked, which tells an exited program from a non-JVM.
    let fake = dumping_threads(99, Vec::new());
    *fake.listener_starts.lock() = vec![Err(AttachError::NotAJvm)].into();
    assert_eq!(
        threads_unavailable(dump_tree(&fake, &[10, 11], false, None, &|| false)),
        threads_jvm(JvmMemoryUnavailable::NoJvmProcess)
    );
    assert_eq!(*fake.ensured.lock(), [10]);
}

#[cfg(unix)]
#[tokio::test]
async fn launched_thread_dump_without_a_listener_finds_the_jvm_below_the_reported_pid() {
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let child = Child(std::process::Command::new("sleep").arg("30").spawn().unwrap());
    let jvm = child.0.id();
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let mut fake = dumping_threads(0, vec![Ok(THREADS.into())]);
    fake.application_jvms = vec![jvm];
    let fake = Arc::new(fake);
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let target = JvmTarget::Launched(std::process::id() as i32);
    let r = thread_dump(&state, || false, |_| probe, target, None).await.unwrap();
    let JvmThreadsResult::Ready { dump } = r else { panic!("{r:?}") };
    assert_eq!(dump.pid, jvm);
    assert_eq!(*fake.ensured.lock(), [jvm]);
}

#[tokio::test]
async fn a_session_debugs_the_jvm_it_launched_or_found() {
    let attach = bare_session("attach");
    attach.session.jvm_pid.store(4242, Ordering::Release);
    assert!(debugs_jvm(&attach.session, 4242));
    assert!(!debugs_jvm(&attach.session, 4243));
    let launch = bare_session("launch");
    launch.session.debuggee_pid.store(77, Ordering::Release);
    assert!(debugs_jvm(&launch.session, 77));
    let python = bare_session_of("debugpy", "attach");
    python.session.jvm_pid.store(4242, Ordering::Release);
    assert!(!debugs_jvm(&python.session, 4242));
    attach.session.terminated.store(true, Ordering::Release);
    assert!(!debugs_jvm(&attach.session, 4242));
    // An attach whose JVM is not found yet debugs no pid.
    assert!(!debugs_jvm(&bare_session("attach").session, 0));
}

#[tokio::test]
async fn a_session_attached_to_a_run_may_hold_its_jvm_before_it_is_located() {
    let run = ide_core::RunId(7);
    let mut bare = bare_session("attach");
    Arc::get_mut(&mut bare.session).unwrap().run = Some(run);
    // Gradle bootRun Debug opens no attach listener, so the attach-time scan finds no pid.
    assert!(attached_to_run(&bare.session, run, 555));
    assert!(!attached_to_run(&bare.session, ide_core::RunId(8), 555));
    bare.session.jvm_pid.store(4242, Ordering::Release);
    assert!(attached_to_run(&bare.session, run, 4242));
    assert!(!attached_to_run(&bare.session, run, 555), "another JVM of the same run");
    bare.session.terminated.store(true, Ordering::Release);
    assert!(!attached_to_run(&bare.session, run, 4242));

    let mut python = bare_session_of("debugpy", "attach");
    Arc::get_mut(&mut python.session).unwrap().run = Some(run);
    assert!(!attached_to_run(&python.session, run, 555));
    assert!(!attached_to_run(&bare_session("attach").session, run, 555), "not linked to a run");
}

#[tokio::test]
async fn run_dump_through_a_linked_session_whose_jvm_is_not_located() {
    // Stopped at a breakpoint, no listener: refused with the resume reason, no listener start.
    let bare = stopped_attach(0);
    let fake = Arc::new(dumping_threads(99, Vec::new()));
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let r = known_pid_dump(&bare.session, |_| probe, 555, None).await.unwrap();
    assert_eq!(threads_unavailable(r), threads_jvm(JvmMemoryUnavailable::ListenerNotRunning));
    assert!(fake.commands.lock().is_empty());

    // Running: the run's JVM is dumped under the session's turn.
    let bare = bare_session("attach");
    let fake = Arc::new(dumping_threads(99, vec![Ok(THREADS.into())]));
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let r = known_pid_dump(&bare.session, |_| probe, 555, None).await.unwrap();
    let JvmThreadsResult::Ready { dump } = r else { panic!("{r:?}") };
    assert_eq!((dump.pid, dump.taken_while_suspended), (555, false));
    assert_eq!(*fake.ensured.lock(), [555]);
}

/// A run's JVM held at a breakpoint by a debugger attached to it (Debug of `spring-boot:run`).
fn stopped_attach(pid: u32) -> BareSession {
    let bare = bare_session("attach");
    bare.session.jvm_pid.store(i64::from(pid), Ordering::Release);
    bare.session.suspended.stopped(None, true);
    bare
}

#[tokio::test]
async fn run_dump_of_a_suspended_debugged_jvm_takes_the_suspended_path() {
    let bare = stopped_attach(4242);
    let mut fake = dumping_threads(4242, Vec::new());
    fake.version = Some(JavaVersion { major: 11, text: "11.0.25".into() });
    let fake = Arc::new(fake);
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let r = known_pid_dump(&bare.session, |_| probe, 4242, None).await.unwrap();
    assert_eq!(threads_unavailable(r), threads_jvm(JvmMemoryUnavailable::UnsafeWhileSuspended { java_major: 11 }));
    assert!(fake.commands.lock().is_empty());

    // No listener: none is started, the JVM's Signal Dispatcher being stopped.
    let fake = Arc::new(dumping_threads(99, Vec::new()));
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let r = known_pid_dump(&bare.session, |_| probe, 4242, None).await.unwrap();
    assert_eq!(threads_unavailable(r), threads_jvm(JvmMemoryUnavailable::ListenerNotRunning));
    assert!(fake.commands.lock().is_empty());

    let mut fake = dumping_threads(4242, vec![Ok(THREADS.into())]);
    fake.version = Some(JavaVersion { major: 17, text: "17.0.13".into() });
    let probe: Arc<dyn AttachProbe> = Arc::new(fake);
    let r = known_pid_dump(&bare.session, |_| probe, 4242, None).await.unwrap();
    let JvmThreadsResult::Ready { dump } = r else { panic!("{r:?}") };
    assert!(dump.taken_while_suspended);
    assert_eq!(dump.pid, 4242);
}

#[tokio::test]
async fn run_dump_of_a_debugged_jvm_asks_for_no_json_while_the_session_holds_it() {
    let bare = stopped_attach(4242);
    let fake = Arc::new(dumping_threads(4242, vec![Ok(THREADS.into())]));
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let dump = ready_dump(known_pid_dump(&bare.session, |_| probe, 4242, Some(json_dir().into())).await.unwrap());
    assert!(dump.taken_while_suspended);
    assert_eq!((dump.virtual_json, dump.virtual_note), (None, Some(VirtualThreadsNote::WhileSuspended)));
    assert_eq!(*fake.commands.lock(), ["thread_print"]);

    // Running at first, the program hits a breakpoint while the text dump is taken.
    let bare = bare_session("attach");
    bare.session.jvm_pid.store(4242, Ordering::Release);
    let mut fake = dumping_threads(4242, vec![Ok(THREADS.into())]);
    let session = bare.session.clone();
    fake.stops_on = Some(("thread_print", Box::new(move || session.suspended.stopped(None, true))));
    let fake = Arc::new(fake);
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let dump = ready_dump(known_pid_dump(&bare.session, |_| probe, 4242, Some(json_dir().into())).await.unwrap());
    assert!(!dump.taken_while_suspended);
    assert_eq!((dump.virtual_json, dump.virtual_note), (None, Some(VirtualThreadsNote::WhileSuspended)));
    assert_eq!(*fake.commands.lock(), ["ensure_listener", "thread_print"]);
}

#[tokio::test]
async fn run_dump_through_a_linked_session_whose_jvm_is_not_located_asks_for_no_json_while_stopped() {
    // Gradle bootRun Debug after an earlier run dump opened the listener: the session's pid is still 0.
    let bare = stopped_attach(0);
    let fake = Arc::new(dumping_threads(555, vec![Ok(THREADS.into())]));
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let dump = ready_dump(known_pid_dump(&bare.session, |_| probe, 555, Some(json_dir().into())).await.unwrap());
    assert_eq!((dump.pid, dump.taken_while_suspended), (555, true));
    assert_eq!((dump.virtual_json, dump.virtual_note), (None, Some(VirtualThreadsNote::WhileSuspended)));
    assert_eq!(*fake.commands.lock(), ["thread_print"]);

    // Running, the same session gets the JSON dump too.
    let bare = bare_session("attach");
    let fake = Arc::new(dumping_threads(555, vec![Ok(THREADS.into())]));
    *fake.json_dumps.lock() = vec![Ok(VIRTUAL_JSON.into())].into();
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let dump = ready_dump(known_pid_dump(&bare.session, |_| probe, 555, Some(json_dir().into())).await.unwrap());
    assert_eq!((dump.virtual_json.as_deref(), dump.virtual_note), (Some(VIRTUAL_JSON), None));
    assert_eq!(*fake.commands.lock(), ["ensure_listener", "thread_print", "thread_dump_json"]);
}

#[tokio::test]
async fn run_dump_of_a_debugged_jvm_waits_for_the_session_turn() {
    let bare = bare_session("attach");
    bare.session.jvm_pid.store(4242, Ordering::Release);
    let fake = Arc::new(dumping_threads(99, Vec::new()));
    let probe: Arc<dyn AttachProbe> = fake.clone();

    let histogram = bare.session.jvm_memory.lock().await;
    let mut queued = Box::pin(known_pid_dump(&bare.session, |_| probe, 4242, None));
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut queued).await.is_err());
    // The program hits a breakpoint while the dump waits behind the session's histogram.
    bare.session.suspended.stopped(None, true);
    drop(histogram);
    assert_eq!(threads_unavailable(queued.await.unwrap()), threads_jvm(JvmMemoryUnavailable::ListenerNotRunning));
    assert!(fake.commands.lock().is_empty());
}

#[test]
fn threads_of_an_exited_program() {
    let mut fake = dumping_threads(99, Vec::new());
    fake.alive = false;
    *fake.listener_starts.lock() = vec![Err(AttachError::NoListener)].into();
    assert_eq!(threads_unavailable(dump_text(&fake, 12, false)), threads_jvm(JvmMemoryUnavailable::ProgramExited));
    assert_eq!(threads_unavailable(dump_text(&fake, 12, true)), threads_jvm(JvmMemoryUnavailable::ProgramExited));
}

#[test]
fn thread_dump_errors_map_to_reasons() {
    let fake = dumping_threads(12, vec![Err(AttachError::Timeout)]);
    assert_eq!(threads_unavailable(dump_text(&fake, 12, false)), threads_jvm(JvmMemoryUnavailable::TimedOut));

    let fake = dumping_threads(99, Vec::new());
    *fake.listener_starts.lock() = vec![Err(AttachError::ListenerDidNotStart)].into();
    assert_eq!(threads_unavailable(dump_text(&fake, 12, false)), JvmThreadsUnavailable::ListenerDidNotStart);
    assert_eq!(*fake.commands.lock(), ["ensure_listener"]);

    let mut fake = dumping_threads(99, Vec::new());
    *fake.listener_starts.lock() = vec![Err(AttachError::NotAJvm), Err(AttachError::NotAJvm)].into();
    assert_eq!(threads_unavailable(dump_text(&fake, 12, false)), threads_jvm(JvmMemoryUnavailable::NoJvmProcess));
    fake.alive = false;
    assert_eq!(threads_unavailable(dump_text(&fake, 12, false)), threads_jvm(JvmMemoryUnavailable::ProgramExited));

    let fake = dumping_threads(12, vec![Err(AttachError::Command { code: 1, message: "no".into() })]);
    let JvmThreadsUnavailable::Failed { message } = threads_unavailable(dump_text(&fake, 12, false)) else {
        panic!("not a failure")
    };
    assert!(message.contains("no"), "{message}");
}

#[test]
fn thread_results_serialize_with_camel_case_tags() {
    let r = JvmThreadsResult::Unavailable { reason: threads_jvm(JvmMemoryUnavailable::ListenerNotRunning) };
    assert_eq!(
        serde_json::to_value(r).unwrap(),
        serde_json::json!({"status": "unavailable", "reason": {"kind": "jvm", "reason": {"kind": "listenerNotRunning"}}})
    );
    let r = JvmThreadsResult::Unavailable { reason: JvmThreadsUnavailable::ListenerDidNotStart };
    assert_eq!(
        serde_json::to_value(r).unwrap(),
        serde_json::json!({"status": "unavailable", "reason": {"kind": "listenerDidNotStart"}})
    );
    let dump = JvmThreadDump {
        text: "t".into(),
        pid: 7,
        java_version: String::new(),
        taken_while_suspended: true,
        elapsed_ms: 3,
        virtual_json: None,
        virtual_note: Some(VirtualThreadsNote::WhileSuspended),
    };
    assert_eq!(
        serde_json::to_value(JvmThreadsResult::Ready { dump }).unwrap(),
        serde_json::json!({
            "status": "ready",
            "dump": {
                "text": "t", "pid": 7, "javaVersion": "", "takenWhileSuspended": true, "elapsedMs": 3,
                "virtualJson": null, "virtualNote": "whileSuspended"
            }
        })
    );
    assert_eq!(serde_json::to_value(VirtualThreadsNote::TooLarge).unwrap(), serde_json::json!("tooLarge"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn threads_take_the_memory_lock() {
    let pid = std::process::id();
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let mut fake = dumping_threads(pid, vec![Ok(THREADS.into())]);
    *fake.histograms.lock() = vec![Ok(HISTOGRAM.into())].into();
    fake.delay = Duration::from_millis(100);
    let fake = Arc::new(fake);
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let running = Suspension::default();
    let (classes, threads) = tokio::join!(
        snapshot(&state, &running, |_| probe.clone(), JvmTarget::Launched(pid as i32), None),
        thread_dump(&state, || false, |_| probe.clone(), JvmTarget::Launched(pid as i32), None)
    );
    assert!(matches!(classes.unwrap(), JvmMemoryResult::Ready { .. }));
    let threads = threads.unwrap();
    assert!(matches!(threads, JvmThreadsResult::Ready { .. }), "{threads:?}");
    assert_eq!(fake.max_in_flight.load(Ordering::SeqCst), 1);
    assert_eq!(*fake.commands.lock(), ["histogram", "ensure_listener", "thread_print"]);
}

#[cfg(unix)]
#[tokio::test]
async fn queued_thread_dump_reads_suspension_under_the_lock() {
    let pid = std::process::id();
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let suspended = Arc::new(Suspension::default());
    let fake = Arc::new(dumping_threads(0, Vec::new()));
    let probe: Arc<dyn AttachProbe> = fake.clone();

    let running = state.lock().await;
    let stopped = suspended.clone();
    let target = JvmTarget::Launched(pid as i32);
    let mut queued = Box::pin(thread_dump(&state, move || stopped.get(), |_| probe, target, Some(json_dir().into())));
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut queued).await.is_err());
    // The program hits a breakpoint while the dump waits behind a class-table request.
    suspended.stopped(None, true);
    drop(running);
    assert_eq!(threads_unavailable(queued.await.unwrap()), threads_jvm(JvmMemoryUnavailable::ListenerNotRunning));
    assert!(fake.commands.lock().is_empty());
}

#[tokio::test]
async fn attached_thread_dump_keeps_the_scanned_jvm() {
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let jvm_pid = AtomicI64::new(0);
    let mut fake = dumping_threads(4242, vec![Ok(THREADS.into())]);
    fake.jdwp = Some((5005, 4242));
    let probe: Arc<dyn AttachProbe> = Arc::new(fake);
    let target = JvmTarget::Attached { pid: &jvm_pid, jdwp_port: Some(5005) };
    let r = thread_dump(&state, || false, |_| probe, target, None).await.unwrap();
    let JvmThreadsResult::Ready { dump } = r else { panic!("{r:?}") };
    assert_eq!(dump.pid, 4242);
    assert_eq!(jvm_pid.load(Ordering::SeqCst), 4242);
}

#[cfg(unix)]
#[tokio::test]
async fn session_thread_dump_writes_the_json_into_the_given_directory() {
    let pid = std::process::id();
    let state = tokio::sync::Mutex::new(JvmMemoryState::default());
    let fake = dumping_threads(pid, vec![Ok(THREADS.into())]);
    *fake.json_dumps.lock() = vec![Ok(VIRTUAL_JSON.into())].into();
    let fake = Arc::new(fake);
    let probe: Arc<dyn AttachProbe> = fake.clone();
    let target = JvmTarget::Launched(pid as i32);
    let r = thread_dump(&state, || false, |_| probe, target, Some(json_dir().into())).await.unwrap();
    assert_eq!(ready_dump(r).virtual_json.as_deref(), Some(VIRTUAL_JSON));
    assert_eq!(*fake.json_dirs.lock(), [json_dir()]);
}

#[tokio::test]
async fn capability_matches_memory() {
    for adapter in JVM_MEMORY_ADAPTERS.iter().copied().chain(["debugpy"]) {
        let bare = bare_session_of(adapter, "launch");
        let caps = crate::session_capabilities(&bare.session);
        let jvm = adapter != "debugpy";
        assert_eq!((caps.jvm_heap, caps.jvm_memory), (jvm, jvm), "{adapter}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn session_without_a_jvm_reports_no_process() {
    let bare = bare_session("launch");
    let (_root, dir) = snapshot_dir("snap");
    let outcome = session_heap_dump(bare.session.clone(), dir.clone(), CancellationToken::new()).await.unwrap();
    assert_eq!(outcome, memory(JvmMemoryUnavailable::NoJvmProcess));
    assert!(!dir.exists());
}

#[cfg(not(unix))]
#[tokio::test]
async fn capture_is_unsupported_off_unix() {
    let bare = bare_session("launch");
    let (_root, dir) = snapshot_dir("snap");
    let outcome = session_heap_dump(bare.session.clone(), dir.clone(), CancellationToken::new()).await.unwrap();
    assert_eq!(outcome, memory(JvmMemoryUnavailable::UnsupportedPlatform));
    assert!(!dir.exists());
}
