//! Class-table snapshots of a debugged JVM, read over the HotSpot attach listener.

use crate::session::Session;
use ide_core::IdeResult;
use ide_jvm_attach::{AttachError, HistogramRow, JavaVersion};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
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

/// Version probe for a JVM whose `release` file could not be read.
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);

/// One try of the scan at attach time, and the limit per socket within it: a silent socket's
/// query thread lives that long, so a longer per-socket limit piles threads up across tries.
const ATTACH_SCAN_TRY: Duration = Duration::from_millis(500);
const ATTACH_SCAN_INTERVAL: Duration = Duration::from_millis(150);
/// The JVM's attach socket can appear a little after the JDWP "Listening" banner, which is
/// when the IDE attaches.
const ATTACH_SCAN_WINDOW: Duration = Duration::from_secs(3);
/// The single scan a refresh makes while the attach-time one found nothing.
const RESCAN_PER_SOCKET: Duration = Duration::from_secs(1);
const RESCAN_BUDGET: Duration = Duration::from_secs(2);

/// JDWP port of an attach to this machine (`hostName` loopback or absent): only such a JVM has
/// an attach socket the IDE can find.
pub(crate) fn local_jdwp_port(arguments: &Value) -> Option<u16> {
    let local = match arguments.get("hostName") {
        None | Some(Value::Null) => true,
        Some(Value::String(host)) => {
            let host = host.trim();
            let ip = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
            host.eq_ignore_ascii_case("localhost") || ip.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
        }
        Some(_) => false,
    };
    let port = match arguments.get("port")? {
        Value::Number(n) => n.as_u64().and_then(|p| u16::try_from(p).ok()),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    };
    port.filter(|&p| local && p != 0)
}

/// Looks for the JVM behind a local attach in the background, so a JVM that never opens an
/// attach socket does not hold the attach up.
pub(crate) fn find_attached_jvm(session: &Arc<Session>, port: u16) {
    let _ = session.jdwp_port.set(port);
    let weak = Arc::downgrade(session);
    tokio::spawn(async move {
        let live = || weak.upgrade().is_some_and(|s| !s.terminated.load(Ordering::Acquire) && !s.conn.is_closed());
        let find = move || ide_jvm_attach::find_jvm_by_jdwp_port(port, ATTACH_SCAN_TRY, ATTACH_SCAN_TRY);
        let Some(pid) = retry_find(find, live, ATTACH_SCAN_INTERVAL, ATTACH_SCAN_WINDOW).await else {
            tracing::debug!(port, "no local JVM found for the JDWP port yet");
            return;
        };
        if let Some(s) = weak.upgrade() {
            let _ = s.jvm_pid.compare_exchange(0, i64::from(pid), Ordering::AcqRel, Ordering::Acquire);
        }
    });
}

/// Calls `find` on a blocking thread until it returns a pid, `live` turns false or `window`
/// has passed.
pub(crate) async fn retry_find<F>(find: F, live: impl Fn() -> bool, interval: Duration, window: Duration) -> Option<u32>
where
    F: Fn() -> Option<u32> + Clone + Send + 'static,
{
    let deadline = tokio::time::Instant::now() + window;
    while live() {
        if let Ok(Some(pid)) = tokio::task::spawn_blocking(find.clone()).await {
            return Some(pid);
        }
        if tokio::time::Instant::now() + interval >= deadline {
            break;
        }
        tokio::time::sleep(interval).await;
    }
    None
}

/// The attach calls a snapshot makes, so tests can stand in for a JVM.
pub(crate) trait AttachProbe: Send + Sync {
    fn has_listener(&self, pid: u32) -> bool;
    fn find_by_jdwp_port(&self, port: u16) -> Option<u32>;
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

    fn find_by_jdwp_port(&self, port: u16) -> Option<u32> {
        ide_jvm_attach::find_jvm_by_jdwp_port(port, RESCAN_PER_SOCKET, RESCAN_BUDGET)
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
    let lookup = match target {
        JvmTarget::Launched(pid) => Lookup::Tree(pid),
        JvmTarget::Attached { pid, jdwp_port } => match i32::try_from(pid.load(Ordering::Acquire)) {
            Ok(p) if p > 0 => Lookup::Known(p),
            _ => match jdwp_port {
                Some(port) => Lookup::Scan(port),
                None => {
                    return Ok(JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::AttachedJvmNotFound });
                }
            },
        },
    };
    let suspended = suspended.load(Ordering::Acquire);
    let probe = probe(suspended);
    let previous = state.previous.clone();
    let (found, outcome) = tokio::task::spawn_blocking(move || {
        let (found, tree) = match lookup {
            Lookup::Tree(pid) => (None, pid_tree(pid)),
            Lookup::Known(pid) => (None, vec![pid]),
            Lookup::Scan(port) => match probe.find_by_jdwp_port(port).and_then(|p| i32::try_from(p).ok()) {
                Some(pid) if pid > 0 => (Some(pid), vec![pid]),
                _ => return (None, Ok(Err(JvmMemoryUnavailable::AttachedJvmNotFound))),
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
        /// JDWP port → pid of the JVM listening on it.
        jdwp: Option<(u16, u32)>,
        scans: AtomicUsize,
        asked: parking_lot::Mutex<Vec<u32>>,
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
            }
        }
    }

    impl AttachProbe for FakeProbe {
        fn has_listener(&self, pid: u32) -> bool {
            self.asked.lock().push(pid);
            pid == self.listener
        }
        fn find_by_jdwp_port(&self, port: u16) -> Option<u32> {
            self.scans.fetch_add(1, Ordering::SeqCst);
            self.jdwp.filter(|(p, _)| *p == port).map(|(_, pid)| pid)
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
        let running = AtomicBool::new(false);
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
        let running = AtomicBool::new(false);
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
        let running = AtomicBool::new(false);
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
        let find = move || (counted.fetch_add(1, Ordering::SeqCst) >= 2).then_some(4242);
        let found = retry_find(find, || true, Duration::from_millis(1), Duration::from_secs(5)).await;
        assert_eq!(found, Some(4242));
        assert_eq!(tries.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn retry_find_gives_up_after_its_window() {
        let tries = Arc::new(AtomicUsize::new(0));
        let counted = tries.clone();
        let find = move || {
            counted.fetch_add(1, Ordering::SeqCst);
            None
        };
        let started = std::time::Instant::now();
        let found = retry_find(find, || true, Duration::from_millis(10), Duration::from_millis(100)).await;
        assert_eq!(found, None);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(tries.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn retry_find_stops_when_the_session_ends() {
        let tries = Arc::new(AtomicUsize::new(0));
        let counted = tries.clone();
        let find = move || {
            counted.fetch_add(1, Ordering::SeqCst);
            None
        };
        let live = AtomicBool::new(true);
        let live_check = || live.swap(false, Ordering::SeqCst);
        let found = retry_find(find, live_check, Duration::from_millis(1), Duration::from_secs(5)).await;
        assert_eq!(found, None);
        assert_eq!(tries.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn histogram_lock_released_after_timeout() {
        let pid = std::process::id();
        let state = tokio::sync::Mutex::new(JvmMemoryState::default());
        let running = AtomicBool::new(false);
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
        let running = AtomicBool::new(false);
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
            JvmTarget::Launched(pid as i32),
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
        snapshot(&state, &running, |_| probe(vec![Ok(HISTOGRAM.into())]), JvmTarget::Launched(pid as i32))
            .await
            .unwrap();
        // An empty fake panics on its histogram call, failing the blocking task.
        assert!(snapshot(&state, &running, |_| probe(Vec::new()), JvmTarget::Launched(pid as i32)).await.is_err());
        let third = snapshot(&state, &running, |_| probe(vec![Ok(HISTOGRAM.into())]), JvmTarget::Launched(pid as i32))
            .await
            .unwrap();
        let JvmMemoryResult::Ready { snapshot } = third else { panic!("{third:?}") };
        assert!(snapshot.has_baseline);
    }
}
