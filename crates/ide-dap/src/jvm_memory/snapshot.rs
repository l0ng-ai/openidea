//! One class histogram of a JVM and its deltas against the previous one.

use super::scan::{RESCAN_BUDGET, RESCAN_PER_SOCKET};
use super::{ClassCounts, HISTOGRAM_TIMEOUT, JvmClassRow, JvmMemorySnapshot, JvmMemoryUnavailable};
use ide_core::IdeResult;
use ide_jvm_attach::{AttachError, HistogramRow, JavaVersion};
use std::collections::HashMap;
use std::time::Duration;

/// Version probe for a JVM whose `release` file could not be read.
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);

/// The attach calls a snapshot makes, so tests can stand in for a JVM.
pub(crate) trait AttachProbe: Send + Sync {
    fn has_listener(&self, pid: u32) -> bool;
    fn find_by_jdwp_port(&self, port: u16) -> Option<u32>;
    fn version(&self, pid: u32) -> Option<JavaVersion>;
    fn histogram(&self, pid: u32) -> Result<String, AttachError>;
    fn alive(&self, pid: u32) -> bool;
}

pub(super) struct JdkProbe {
    pub(super) suspended: bool,
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
