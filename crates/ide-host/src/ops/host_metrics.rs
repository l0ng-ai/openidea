//! Host resource metrics (`host_metrics`, `host_end_process`) for the Remote Host
//! Resources status bar widget and popover dashboard.

use crate::Host;
use ide_command::command;
use ide_core::IdeResult;
use ide_workspace::memory::{self, CpuSampler, MemoryCategory, MemoryRoot, ProcessMemory, ProcessTable};
use ide_workspace::system::SystemSampler;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Default)]
pub(crate) struct HostMetricsSampler {
    system: SystemSampler,
    cpu: CpuSampler,
}

/// One process outside OpenIDEA's own process tree on the host (read-only in the UI).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostProcess {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: Option<f32>,
    pub memory_bytes: Option<u64>,
}

/// Snapshot of host-wide CPU, memory, network, disk and process usage.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostMetrics {
    /// Overall CPU utilization across all logical cores (`0..=100`); `null` on the first sample.
    pub cpu_percent: Option<f32>,
    /// Logical CPU cores available to this host or container.
    pub cpu_cores: u32,
    /// Unix 1m, 5m, 15m load averages; `null` on Windows.
    pub load_average: Option<[f32; 3]>,
    /// Host or container memory in use, in bytes.
    pub memory_used_bytes: Option<u64>,
    /// Total physical (or container limit) memory, in bytes.
    pub memory_total_bytes: Option<u64>,
    /// Bytes/s received across non-loopback network interfaces; `null` on the first sample or unsupported OS.
    pub net_rx_bytes_per_sec: Option<f64>,
    /// Bytes/s sent across non-loopback network interfaces; `null` on the first sample or unsupported OS.
    pub net_tx_bytes_per_sec: Option<f64>,
    /// Bytes/s read from block storage; `null` on the first sample or unsupported OS.
    pub disk_read_bytes_per_sec: Option<f64>,
    /// Bytes/s written to block storage; `null` on the first sample or unsupported OS.
    pub disk_write_bytes_per_sec: Option<f64>,
    /// Free bytes available to the user on the project volume (or `$HOME` fallback).
    pub disk_available_bytes: Option<u64>,
    /// Total capacity in bytes of the project volume (or `$HOME` fallback).
    pub disk_total_bytes: Option<u64>,
    /// Uptime of the backend process in milliseconds.
    pub uptime_ms: f64,
    /// OpenIDEA backend, language servers, runs, terminals, debug adapters and agents (`includeProcesses = true`).
    pub processes: Vec<ProcessMemory>,
    /// Highest-usage processes on the host outside OpenIDEA's own process tree (`includeProcesses = true`).
    pub external_processes: Vec<HostProcess>,
}

const MAX_EXTERNAL_PROCESSES: usize = 5;
const MIN_EXTERNAL_CPU_PERCENT: f32 = 0.5;
const MIN_EXTERNAL_MEMORY_BYTES: u64 = 32 << 20;

fn project_name(root: &Path) -> String {
    root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string())
}

fn process_root(pid: u32, label: String, kind: &str) -> MemoryRoot {
    MemoryRoot { pid, category: MemoryCategory::Process, label, detail: Some(kind.into()), with_children: true }
}

fn volume_path(host: &Host, window: &str) -> PathBuf {
    if let Ok(p) = host.project(window) {
        return p.root.clone();
    }
    if let Some(p) = host.projects().into_iter().next() {
        return p.root.clone();
    }
    dirs::home_dir().unwrap_or_else(|| host.data_dir.clone())
}

fn disk_space(path: &Path) -> Option<(u64, u64)> {
    #[cfg(unix)]
    #[allow(clippy::unnecessary_cast)]
    {
        let stat = rustix::fs::statvfs(path).ok()?;
        let frsize = stat.f_frsize as u64;
        let total = (stat.f_blocks as u64).saturating_mul(frsize);
        let avail = (stat.f_bavail as u64).saturating_mul(frsize);
        (total > 0).then_some((avail.min(total), total))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        // SAFETY: `wide` is NUL-terminated and all three u64 out-pointers are writable.
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut avail,
                &mut total,
                &mut free,
            )
        };
        (ok != 0 && total > 0).then_some((avail.min(total), total))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        None
    }
}

fn collect_roots(host: &Host) -> Vec<MemoryRoot> {
    let mut roots = Vec::new();
    for p in host.projects() {
        for s in p.lsp.servers() {
            if let Some(pid) = s.pid {
                roots.push(MemoryRoot {
                    pid,
                    category: MemoryCategory::LanguageServer,
                    label: s.name,
                    detail: Some(project_name(s.root.as_ref())),
                    with_children: true,
                });
            }
        }
    }
    for r in host.processes.list().into_iter().filter(|r| r.running) {
        if let Some(pid) = r.pid {
            roots.push(process_root(pid, r.name, "Run"));
        }
    }
    for t in host.terminals.list() {
        if let Some(pid) = t.pid {
            roots.push(process_root(pid, t.title, "Terminal"));
        }
    }
    roots
}

fn resource_share(p: &HostProcess, cores: u32, total_memory: Option<u64>) -> f64 {
    let cpu_share = p.cpu_percent.map(|c| c as f64 / (cores.max(1) as f64 * 100.0)).unwrap_or(0.0);
    let mem_share = match (p.memory_bytes, total_memory.filter(|&t| t > 0)) {
        (Some(b), Some(t)) => b as f64 / t as f64,
        _ => 0.0,
    };
    cpu_share.max(mem_share)
}

/// Snapshot of host-wide resource counters (CPU, memory, network, disk) and, when
/// `include_processes` is true, the process breakdown of OpenIDEA and top host processes.
#[command(trust = always)]
pub async fn host_metrics(host: &Arc<Host>, window: &str, include_processes: bool) -> IdeResult<HostMetrics> {
    let disk_target = volume_path(host, window);
    let roots = if include_processes { collect_roots(host) } else { Vec::new() };
    let h = host.clone();
    host.blocking(move || {
        let table = include_processes.then(ProcessTable::snapshot);
        let (disk_available_bytes, disk_total_bytes) = match disk_space(&disk_target) {
            Some((a, t)) => (Some(a), Some(t)),
            None => (None, None),
        };
        let uptime_ms =
            ide_workspace::process::process_age().unwrap_or_else(ide_workspace::process::uptime).as_secs_f64() * 1000.0;

        let mut sampler = h.metrics_sampler.lock();
        let rates = sampler.system.sample();

        let (processes, external_processes) = if let Some(table) = table {
            sampler.cpu.retain(&table);
            let me = std::process::id();
            let processes =
                memory::attribute(&table, me, &roots, memory::footprint_bytes, |pid| sampler.cpu.percent(pid));
            let claimed: HashSet<u32> = table.tree(me).into_iter().collect();
            let mut external: Vec<HostProcess> = table
                .entries()
                .filter(|e| e.pid != 0 && !claimed.contains(&e.pid))
                .filter_map(|e| {
                    let cpu_percent = sampler.cpu.percent(e.pid);
                    let memory_bytes = memory::fast_resident_bytes(e.pid);
                    let active = cpu_percent.unwrap_or(0.0) >= MIN_EXTERNAL_CPU_PERCENT
                        || memory_bytes.unwrap_or(0) >= MIN_EXTERNAL_MEMORY_BYTES;
                    active.then(|| HostProcess { pid: e.pid, name: e.name.clone(), cpu_percent, memory_bytes })
                })
                .collect();
            external.sort_by(|a, b| {
                resource_share(b, rates.cpu_cores, rates.memory_total_bytes)
                    .total_cmp(&resource_share(a, rates.cpu_cores, rates.memory_total_bytes))
                    .then_with(|| b.memory_bytes.unwrap_or(0).cmp(&a.memory_bytes.unwrap_or(0)))
                    .then_with(|| a.pid.cmp(&b.pid))
            });
            external.truncate(MAX_EXTERNAL_PROCESSES);
            (processes, external)
        } else {
            (Vec::new(), Vec::new())
        };

        Ok(HostMetrics {
            cpu_percent: rates.cpu_percent,
            cpu_cores: rates.cpu_cores,
            load_average: rates.load_average,
            memory_used_bytes: rates.memory_used_bytes,
            memory_total_bytes: rates.memory_total_bytes,
            net_rx_bytes_per_sec: rates.net_rx_bytes_per_sec,
            net_tx_bytes_per_sec: rates.net_tx_bytes_per_sec,
            disk_read_bytes_per_sec: rates.disk_read_bytes_per_sec,
            disk_write_bytes_per_sec: rates.disk_write_bytes_per_sec,
            disk_available_bytes,
            disk_total_bytes,
            uptime_ms,
            processes,
            external_processes,
        })
    })
    .await
}

/// Ends a child process started by this OpenIDEA host (language server, run, terminal,
/// debug adapter or agent) and its descendants; refuses processes outside this host's tree.
#[command(trust = trusted)]
pub async fn host_end_process(host: &Arc<Host>, pid: u32) -> IdeResult<bool> {
    host.blocking(move || Ok(memory::end_process_tree(std::process::id(), pid, Duration::from_secs(3)))).await
}

ide_command::domain!(host_metrics: host_metrics, host_end_process);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostConfig;

    #[tokio::test]
    async fn collects_light_and_detailed_host_metrics() {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(Host::new(HostConfig::for_test(dir.path())));

        let light = host_metrics(&host, "main", false).await.unwrap();
        assert!(light.cpu_cores >= 1);
        assert!(light.processes.is_empty());
        assert!(light.external_processes.is_empty());
        if cfg!(any(unix, windows)) {
            let avail = light.disk_available_bytes.expect("disk_available_bytes");
            let total = light.disk_total_bytes.expect("disk_total_bytes");
            assert!(total > 0 && avail <= total, "{avail} / {total}");
        }

        let detailed = host_metrics(&host, "main", true).await.unwrap();
        assert!(!detailed.processes.is_empty());
        assert_eq!(detailed.processes[0].label, "Backend");
        assert!(detailed.external_processes.len() <= MAX_EXTERNAL_PROCESSES);

        // Refuses to terminate the backend itself or PID 1.
        assert!(!host_end_process(&host, std::process::id()).await.unwrap());
        assert!(!host_end_process(&host, 1).await.unwrap());
    }
}
