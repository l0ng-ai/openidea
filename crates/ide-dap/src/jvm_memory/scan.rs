//! Finding the JVM behind an attach session by its JDWP port.

use super::safe_while_suspended;
use crate::session::Session;
use serde_json::Value;
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// One try of the scan at attach time, and the limit per socket within it: a silent socket's
/// query thread lives that long, so a longer per-socket limit piles threads up across tries.
const ATTACH_SCAN_TRY: Duration = Duration::from_millis(500);
const ATTACH_SCAN_INTERVAL: Duration = Duration::from_millis(150);
/// The JVM's attach socket can appear a little after the JDWP "Listening" banner, which is
/// when the IDE attaches.
const ATTACH_SCAN_WINDOW: Duration = Duration::from_secs(3);
/// The single scan a refresh makes while the attach-time one found nothing.
pub(super) const RESCAN_PER_SOCKET: Duration = Duration::from_secs(1);
pub(super) const RESCAN_BUDGET: Duration = Duration::from_secs(2);

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
    jdwp_port(arguments).filter(|_| local)
}

/// `port` of an attach request: a number or a numeric string, never 0.
fn jdwp_port(arguments: &Value) -> Option<u16> {
    let port = match arguments.get("port")? {
        Value::Number(n) => n.as_u64().and_then(|p| u16::try_from(p).ok()),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    };
    port.filter(|&p| p != 0)
}

/// `hostName` (empty when absent) and `port` of an attach request, local or not.
pub(crate) fn attach_target(arguments: &Value) -> Option<(String, u16)> {
    let host = arguments.get("hostName").and_then(Value::as_str).unwrap_or_default();
    Some((host.to_owned(), jdwp_port(arguments)?))
}

/// Pid of the local JVM listening on a JDWP port (first argument), given whether the session is
/// suspended (second). Replaceable so tests never send attach requests to real JVMs.
pub(crate) type JvmFinder = Arc<dyn Fn(u16, bool) -> Option<u32> + Send + Sync>;

/// The [`JvmFinder`] of the attach-time scan.
pub(crate) fn find_local_jvm(port: u16, suspended: bool) -> Option<u32> {
    let may_query = |pid| !suspended || safe_while_suspended(ide_jvm_attach::java_version_of(pid).as_ref());
    ide_jvm_attach::find_jvm_by_jdwp_port(port, ATTACH_SCAN_TRY, ATTACH_SCAN_TRY, may_query)
}

/// Looks for the JVM behind a local attach: one try now, the rest in the background, so a JVM
/// that never opens an attach socket holds the attach up by one try at most. Call it before the
/// debugger connects: the JVM clears its JDWP listener address then, and a scan can no longer
/// tell it by its port.
pub(crate) async fn find_attached_jvm(session: &Arc<Session>, port: u16, finder: JvmFinder) {
    let _ = session.jdwp_port.set(port);
    let find = move |suspended: bool| finder(port, suspended);
    let first = find.clone();
    if let Ok(Some(pid)) = tokio::task::spawn_blocking(move || first(false)).await {
        let _ = session.jvm_pid.compare_exchange(0, i64::from(pid), Ordering::AcqRel, Ordering::Acquire);
        return;
    }
    drop(watch_for_attached_jvm(session, port, find, ATTACH_SCAN_INTERVAL, ATTACH_SCAN_WINDOW));
}

/// Retries `find` for the session's `jvm_pid`, holding the session weakly so an ended session
/// is not kept alive. `find` is told whether the session is suspended.
pub(crate) fn watch_for_attached_jvm<F>(
    session: &Arc<Session>,
    port: u16,
    find: F,
    interval: Duration,
    window: Duration,
) -> tokio::task::JoinHandle<()>
where
    F: Fn(bool) -> Option<u32> + Clone + Send + 'static,
{
    let weak = Arc::downgrade(session);
    tokio::spawn(async move {
        let gate = || match weak.upgrade() {
            Some(s) if !s.terminated.load(Ordering::Acquire) && !s.conn.is_closed() => {
                if s.jvm_pid.load(Ordering::Acquire) > 0 {
                    ScanGate::Ended
                } else {
                    ScanGate::Scan { suspended: s.suspended.get() }
                }
            }
            _ => ScanGate::Ended,
        };
        let Some(pid) = retry_find(find, gate, interval, window).await else {
            tracing::debug!("no local JVM found for JDWP port {port} yet");
            return;
        };
        if let Some(s) = weak.upgrade() {
            let _ = s.jvm_pid.compare_exchange(0, i64::from(pid), Ordering::AcqRel, Ordering::Acquire);
        }
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ScanGate {
    Scan { suspended: bool },
    Ended,
}

/// Calls `find` on a blocking thread, on each try `gate` allows, until it returns a pid, `gate`
/// reports the end or `window` has passed.
pub(crate) async fn retry_find<F>(
    find: F,
    gate: impl Fn() -> ScanGate,
    interval: Duration,
    window: Duration,
) -> Option<u32>
where
    F: Fn(bool) -> Option<u32> + Clone + Send + 'static,
{
    let deadline = tokio::time::Instant::now() + window;
    loop {
        match gate() {
            ScanGate::Ended => break,
            ScanGate::Scan { suspended } => {
                let find = find.clone();
                if let Ok(Some(pid)) = tokio::task::spawn_blocking(move || find(suspended)).await {
                    return Some(pid);
                }
            }
        }
        if tokio::time::Instant::now() + interval >= deadline {
            break;
        }
        tokio::time::sleep(interval).await;
    }
    None
}
