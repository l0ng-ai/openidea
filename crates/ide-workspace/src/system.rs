//! Host-wide resource counters (CPU, memory, load average, network and disk I/O)
//! and rate sampling for the Remote Host Resources status bar widget and dashboard.
//!
//! On Linux (including cgroup v2 containers such as Dev Containers and Kubernetes
//! pods) container CPU and memory quotas take precedence when narrower than the
//! physical host, so percentages reflect the headroom actually available to builds,
//! language servers and coding agents.

use std::time::{Duration, Instant};

/// Raw cumulative CPU counters at one instant.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CpuCounters {
    /// Aggregate host ticks (`busy <= total`).
    Ticks { busy: u64, total: u64 },
    /// Container cgroup v2 `usage_usec` against a quota of `cores` logical CPUs.
    CgroupUsec { usage_usec: u64, cores: f64 },
}

/// Cumulative byte counters at one instant (network RX/TX or disk read/write).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TransferCounters {
    pub read_or_rx_bytes: u64,
    pub write_or_tx_bytes: u64,
}

/// Raw OS counters captured in one snapshot.
#[derive(Clone, Debug, PartialEq)]
pub struct RawSystemCounters {
    pub cpu: Option<CpuCounters>,
    pub cpu_cores: u32,
    pub load_average: Option<[f32; 3]>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub net: Option<TransferCounters>,
    pub disk_io: Option<TransferCounters>,
}

/// Sampled host metrics with computed rates (`None` on the first sample).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SystemRates {
    /// Overall CPU utilization across all available cores (`0.0..=100.0`).
    pub cpu_percent: Option<f32>,
    pub cpu_cores: u32,
    pub load_average: Option<[f32; 3]>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub net_rx_bytes_per_sec: Option<f64>,
    pub net_tx_bytes_per_sec: Option<f64>,
    pub disk_read_bytes_per_sec: Option<f64>,
    pub disk_write_bytes_per_sec: Option<f64>,
}

/// Shorter gaps (multiple windows polling at once) reuse the previous rates
/// instead of dividing over a few milliseconds.
const MIN_SAMPLE_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Debug)]
struct PrevSample {
    at: Instant,
    raw: RawSystemCounters,
    rates: SystemRates,
}

/// Stateful sampler that turns cumulative OS counters into percentages and bytes/s.
#[derive(Debug, Default)]
pub struct SystemSampler {
    prev: Option<PrevSample>,
}

impl SystemSampler {
    pub fn sample(&mut self) -> SystemRates {
        self.record(snapshot(), Instant::now())
    }

    pub fn record(&mut self, raw: RawSystemCounters, at: Instant) -> SystemRates {
        if let Some(prev) = &self.prev
            && at.saturating_duration_since(prev.at) < MIN_SAMPLE_INTERVAL
        {
            return SystemRates {
                cpu_cores: raw.cpu_cores,
                load_average: raw.load_average,
                memory_used_bytes: raw.memory_used_bytes,
                memory_total_bytes: raw.memory_total_bytes,
                ..prev.rates
            };
        }

        let elapsed = self.prev.as_ref().map(|p| at.saturating_duration_since(p.at).as_secs_f64()).filter(|&s| s > 0.0);

        let cpu_percent = match (self.prev.as_ref().and_then(|p| p.raw.cpu), raw.cpu, elapsed) {
            (
                Some(CpuCounters::Ticks { busy: b0, total: t0 }),
                Some(CpuCounters::Ticks { busy: b1, total: t1 }),
                Some(_),
            ) if b1 >= b0 && t1 > t0 => Some(((b1 - b0) as f64 / (t1 - t0) as f64 * 100.0).clamp(0.0, 100.0) as f32),
            (
                Some(CpuCounters::CgroupUsec { usage_usec: u0, .. }),
                Some(CpuCounters::CgroupUsec { usage_usec: u1, cores }),
                Some(secs),
            ) if u1 >= u0 && cores > 0.0 => {
                let wall_usec = secs * 1_000_000.0 * cores;
                (wall_usec > 0.0).then(|| ((u1 - u0) as f64 / wall_usec * 100.0).clamp(0.0, 100.0) as f32)
            }
            _ => None,
        };

        let (net_rx_bytes_per_sec, net_tx_bytes_per_sec) =
            transfer_rate(self.prev.as_ref().and_then(|p| p.raw.net), raw.net, elapsed);
        let (disk_read_bytes_per_sec, disk_write_bytes_per_sec) =
            transfer_rate(self.prev.as_ref().and_then(|p| p.raw.disk_io), raw.disk_io, elapsed);

        let rates = SystemRates {
            cpu_percent,
            cpu_cores: raw.cpu_cores,
            load_average: raw.load_average,
            memory_used_bytes: raw.memory_used_bytes,
            memory_total_bytes: raw.memory_total_bytes,
            net_rx_bytes_per_sec,
            net_tx_bytes_per_sec,
            disk_read_bytes_per_sec,
            disk_write_bytes_per_sec,
        };
        self.prev = Some(PrevSample { at, raw, rates });
        rates
    }
}

fn transfer_rate(
    prev: Option<TransferCounters>,
    curr: Option<TransferCounters>,
    elapsed: Option<f64>,
) -> (Option<f64>, Option<f64>) {
    let (Some(p), Some(c), Some(secs)) = (prev, curr, elapsed) else {
        return (None, None);
    };
    let rx = c.read_or_rx_bytes.checked_sub(p.read_or_rx_bytes).map(|d| d as f64 / secs);
    let tx = c.write_or_tx_bytes.checked_sub(p.write_or_tx_bytes).map(|d| d as f64 / secs);
    (rx, tx)
}

/// Captures raw OS counters right now.
pub fn snapshot() -> RawSystemCounters {
    imp::snapshot()
}

pub(crate) fn host_cpu_cores() -> u32 {
    std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1).max(1)
}

#[cfg(any(target_os = "linux", test))]
mod linux_parse {
    use super::{CpuCounters, TransferCounters};

    pub fn proc_stat_cpu(text: &str) -> Option<CpuCounters> {
        let line = text.lines().find(|l| l.starts_with("cpu "))?;
        let fields: Vec<u64> = line["cpu ".len()..].split_whitespace().take(8).filter_map(|s| s.parse().ok()).collect();
        if fields.len() < 4 {
            return None;
        }
        let idle = fields[3].saturating_add(fields.get(4).copied().unwrap_or(0));
        let total = fields.iter().copied().fold(0u64, u64::saturating_add);
        Some(CpuCounters::Ticks { busy: total.saturating_sub(idle), total })
    }

    pub fn cgroup_cpu_quota_cores(cpu_max: &str) -> Option<f64> {
        let mut parts = cpu_max.split_whitespace();
        let quota_str = parts.next()?;
        if quota_str == "max" {
            return None;
        }
        let quota: u64 = quota_str.parse().ok()?;
        let period: u64 = parts.next()?.parse().ok()?;
        (quota > 0 && period > 0).then(|| quota as f64 / period as f64)
    }

    pub fn cgroup_cpu_usage_usec(cpu_stat: &str) -> Option<u64> {
        for line in cpu_stat.lines() {
            let mut parts = line.split_whitespace();
            if parts.next() == Some("usage_usec") {
                return parts.next()?.parse().ok();
            }
        }
        None
    }

    fn kb_field(text: &str, key: &str) -> Option<u64> {
        let line = text.lines().find(|l| l.starts_with(key))?;
        let kb: u64 = line[key.len()..].split_whitespace().next()?.parse().ok()?;
        Some(kb.saturating_mul(1024))
    }

    pub fn meminfo(text: &str) -> Option<(u64, u64)> {
        let total = kb_field(text, "MemTotal:")?;
        let avail = kb_field(text, "MemAvailable:").or_else(|| {
            let free = kb_field(text, "MemFree:")?;
            let buffers = kb_field(text, "Buffers:").unwrap_or(0);
            let cached = kb_field(text, "Cached:").unwrap_or(0);
            Some(free.saturating_add(buffers).saturating_add(cached))
        })?;
        Some((total.saturating_sub(avail), total))
    }

    pub fn cgroup_memory(
        max_text: &str,
        current_text: &str,
        stat_text: Option<&str>,
        host_total: Option<u64>,
    ) -> Option<(u64, u64)> {
        let max_str = max_text.trim();
        if max_str == "max" {
            return None;
        }
        let max_bytes: u64 = max_str.parse().ok()?;
        if max_bytes == 0 || host_total.is_some_and(|ht| max_bytes >= ht) {
            return None;
        }
        let current_bytes: u64 = current_text.trim().parse().ok()?;
        let inactive_file = stat_text
            .and_then(|s| {
                s.lines().find_map(|l| {
                    let mut p = l.split_whitespace();
                    (p.next() == Some("inactive_file")).then(|| p.next()?.parse::<u64>().ok())?
                })
            })
            .unwrap_or(0);
        let used = current_bytes.saturating_sub(inactive_file).min(max_bytes);
        Some((used, max_bytes))
    }

    pub fn loadavg(text: &str) -> Option<[f32; 3]> {
        let mut p = text.split_whitespace();
        Some([p.next()?.parse().ok()?, p.next()?.parse().ok()?, p.next()?.parse().ok()?])
    }

    pub fn net_dev(text: &str) -> Option<TransferCounters> {
        let mut rx = 0u64;
        let mut tx = 0u64;
        let mut any = false;
        for line in text.lines() {
            let Some((iface, rest)) = line.split_once(':') else { continue };
            if iface.trim() == "lo" {
                continue;
            }
            let mut cols = rest.split_whitespace();
            let Some(ibytes) = cols.next().and_then(|s| s.parse::<u64>().ok()) else { continue };
            let Some(obytes) = cols.nth(7).and_then(|s| s.parse::<u64>().ok()) else { continue };
            rx = rx.saturating_add(ibytes);
            tx = tx.saturating_add(obytes);
            any = true;
        }
        any.then_some(TransferCounters { read_or_rx_bytes: rx, write_or_tx_bytes: tx })
    }

    pub fn is_whole_disk(name: &str) -> bool {
        if let Some(rest) = name.strip_prefix("nvme") {
            let Some((ctrl, ns)) = rest.split_once('n') else { return false };
            return !ctrl.is_empty()
                && ctrl.bytes().all(|b| b.is_ascii_digit())
                && !ns.is_empty()
                && ns.bytes().all(|b| b.is_ascii_digit());
        }
        if let Some(rest) = name.strip_prefix("mmcblk") {
            return !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit());
        }
        for prefix in ["xvd", "sd", "hd", "vd"] {
            if let Some(rest) = name.strip_prefix(prefix) {
                return !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase());
            }
        }
        false
    }

    pub fn diskstats(text: &str) -> Option<TransferCounters> {
        let mut r = 0u64;
        let mut w = 0u64;
        let mut any = false;
        for line in text.lines() {
            let mut parts = line.split_whitespace();
            let Some(name) = parts.nth(2) else { continue };
            if !is_whole_disk(name) {
                continue;
            }
            let Some(sectors_read) = parts.nth(2).and_then(|s| s.parse::<u64>().ok()) else { continue };
            let Some(sectors_written) = parts.nth(3).and_then(|s| s.parse::<u64>().ok()) else { continue };
            r = r.saturating_add(sectors_read.saturating_mul(512));
            w = w.saturating_add(sectors_written.saturating_mul(512));
            any = true;
        }
        any.then_some(TransferCounters { read_or_rx_bytes: r, write_or_tx_bytes: w })
    }

    pub fn cgroup_io_stat(text: &str) -> Option<TransferCounters> {
        let mut r = 0u64;
        let mut w = 0u64;
        let mut any = false;
        for line in text.lines() {
            for token in line.split_whitespace().skip(1) {
                if let Some(v) = token.strip_prefix("rbytes=").and_then(|s| s.parse::<u64>().ok()) {
                    r = r.saturating_add(v);
                    any = true;
                } else if let Some(v) = token.strip_prefix("wbytes=").and_then(|s| s.parse::<u64>().ok()) {
                    w = w.saturating_add(v);
                    any = true;
                }
            }
        }
        any.then_some(TransferCounters { read_or_rx_bytes: r, write_or_tx_bytes: w })
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{CpuCounters, RawSystemCounters, host_cpu_cores, linux_parse};
    use std::fs;

    pub fn snapshot() -> RawSystemCounters {
        let physical_cores = host_cpu_cores();
        let cgroup_cores = fs::read_to_string("/sys/fs/cgroup/cpu.max")
            .ok()
            .and_then(|s| linux_parse::cgroup_cpu_quota_cores(&s))
            .filter(|&c| c < physical_cores as f64);

        let (cpu, cpu_cores) = if let Some(cores) = cgroup_cores
            && let Ok(stat) = fs::read_to_string("/sys/fs/cgroup/cpu.stat")
            && let Some(usage_usec) = linux_parse::cgroup_cpu_usage_usec(&stat)
        {
            (Some(CpuCounters::CgroupUsec { usage_usec, cores }), (cores.ceil() as u32).max(1))
        } else {
            let ticks = fs::read_to_string("/proc/stat").ok().and_then(|s| linux_parse::proc_stat_cpu(&s));
            (ticks, physical_cores)
        };

        let host_mem = fs::read_to_string("/proc/meminfo").ok().and_then(|s| linux_parse::meminfo(&s));
        let cgroup_mem = fs::read_to_string("/sys/fs/cgroup/memory.max")
            .ok()
            .zip(fs::read_to_string("/sys/fs/cgroup/memory.current").ok())
            .and_then(|(max, cur)| {
                let stat = fs::read_to_string("/sys/fs/cgroup/memory.stat").ok();
                linux_parse::cgroup_memory(&max, &cur, stat.as_deref(), host_mem.map(|(_, t)| t))
            });
        let (memory_used_bytes, memory_total_bytes) = match cgroup_mem.or(host_mem) {
            Some((used, total)) => (Some(used), Some(total)),
            None => (None, None),
        };

        let load_average = fs::read_to_string("/proc/loadavg").ok().and_then(|s| linux_parse::loadavg(&s));
        let net = fs::read_to_string("/proc/net/dev").ok().and_then(|s| linux_parse::net_dev(&s));
        let disk_io = fs::read_to_string("/proc/diskstats")
            .ok()
            .and_then(|s| linux_parse::diskstats(&s))
            .filter(|c| c.read_or_rx_bytes > 0 || c.write_or_tx_bytes > 0)
            .or_else(|| fs::read_to_string("/sys/fs/cgroup/io.stat").ok().and_then(|s| linux_parse::cgroup_io_stat(&s)))
            .or_else(|| fs::read_to_string("/proc/diskstats").ok().and_then(|s| linux_parse::diskstats(&s)));

        RawSystemCounters { cpu, cpu_cores, load_average, memory_used_bytes, memory_total_bytes, net, disk_io }
    }
}

#[cfg(target_os = "macos")]
#[allow(non_camel_case_types, unsafe_code)]
mod imp {
    use super::{CpuCounters, RawSystemCounters, TransferCounters, host_cpu_cores};
    use std::ffi::c_void;
    use std::sync::OnceLock;

    type kern_return_t = i32;
    type mach_port_t = u32;
    type natural_t = u32;
    type integer_t = i32;
    type mach_msg_type_number_t = u32;

    const HOST_CPU_LOAD_INFO: i32 = 3;
    const HOST_VM_INFO64: i32 = 4;

    const CTL_NET: i32 = 4;
    const PF_ROUTE: i32 = 17;
    const NET_RT_IFLIST2: i32 = 6;
    const RTM_IFINFO2: u8 = 0x12;
    const IFF_LOOPBACK: i32 = 0x8;

    #[repr(C)]
    #[derive(Default)]
    struct HostCpuLoadInfo {
        cpu_ticks: [natural_t; 4],
    }

    #[repr(C, packed(4))]
    #[derive(Default)]
    struct VmStatistics64 {
        free_count: natural_t,
        active_count: natural_t,
        inactive_count: natural_t,
        wire_count: natural_t,
        zero_fill_count: u64,
        reactivations: u64,
        pageins: u64,
        pageouts: u64,
        faults: u64,
        cow_faults: u64,
        lookups: u64,
        hits: u64,
        purges: u64,
        purgeable_count: natural_t,
        speculative_count: natural_t,
        decompressions: u64,
        compressions: u64,
        swapins: u64,
        swapouts: u64,
        compressor_page_count: natural_t,
        throttled_count: natural_t,
        external_page_count: natural_t,
        internal_page_count: natural_t,
        total_uncompressed_pages_in_compressor: u64,
    }

    unsafe extern "C" {
        fn mach_host_self() -> mach_port_t;
        fn host_page_size(host: mach_port_t, out_page_size: *mut usize) -> kern_return_t;
        fn host_statistics(
            host: mach_port_t,
            flavor: i32,
            host_info_out: *mut integer_t,
            host_info_out_cnt: *mut mach_msg_type_number_t,
        ) -> kern_return_t;
        fn host_statistics64(
            host: mach_port_t,
            flavor: i32,
            host_info_out: *mut integer_t,
            host_info_out_cnt: *mut mach_msg_type_number_t,
        ) -> kern_return_t;
        fn getloadavg(loadavg: *mut f64, nelem: i32) -> i32;
        fn sysctl(
            name: *const i32,
            namelen: u32,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *const c_void,
            newlen: usize,
        ) -> i32;
    }

    fn host_port() -> mach_port_t {
        static PORT: OnceLock<mach_port_t> = OnceLock::new();
        // SAFETY: plain Mach trap; cached once so no send rights accumulate.
        *PORT.get_or_init(|| unsafe { mach_host_self() })
    }

    fn cpu_counters() -> Option<CpuCounters> {
        let mut info = HostCpuLoadInfo::default();
        let mut count = (std::mem::size_of::<HostCpuLoadInfo>() / std::mem::size_of::<integer_t>()) as u32;
        // SAFETY: `info` is a writable HOST_CPU_LOAD_INFO buffer and `count` matches its integer_t length.
        let rc = unsafe { host_statistics(host_port(), HOST_CPU_LOAD_INFO, (&raw mut info).cast(), &mut count) };
        if rc != 0 {
            return None;
        }
        let user = info.cpu_ticks[0] as u64;
        let system = info.cpu_ticks[1] as u64;
        let idle = info.cpu_ticks[2] as u64;
        let nice = info.cpu_ticks[3] as u64;
        let busy = user.saturating_add(system).saturating_add(nice);
        Some(CpuCounters::Ticks { busy, total: busy.saturating_add(idle) })
    }

    fn memory_usage() -> Option<(u64, u64)> {
        let total = crate::process::total_memory_bytes()?;
        let mut page_size: usize = 0;
        // SAFETY: `page_size` is writable.
        if unsafe { host_page_size(host_port(), &mut page_size) } != 0 || page_size == 0 {
            return None;
        }
        let mut vm = VmStatistics64::default();
        let mut count = (std::mem::size_of::<VmStatistics64>() / std::mem::size_of::<integer_t>()) as u32;
        // SAFETY: `vm` is a writable HOST_VM_INFO64 buffer and `count` matches its integer_t length.
        let rc = unsafe { host_statistics64(host_port(), HOST_VM_INFO64, (&raw mut vm).cast(), &mut count) };
        if rc != 0 {
            return None;
        }
        // Activity Monitor's "Memory Used": App Memory (internal - purgeable) + Wired + Compressed.
        let app_pages = (vm.internal_page_count as u64).saturating_sub(vm.purgeable_count as u64);
        let used_pages = app_pages.saturating_add(vm.wire_count as u64).saturating_add(vm.compressor_page_count as u64);
        let used = used_pages.saturating_mul(page_size as u64).min(total);
        Some((used, total))
    }

    fn load_average() -> Option<[f32; 3]> {
        let mut avg = [0.0f64; 3];
        // SAFETY: `avg` holds 3 doubles.
        let got = unsafe { getloadavg(avg.as_mut_ptr(), 3) };
        (got == 3).then_some([avg[0] as f32, avg[1] as f32, avg[2] as f32])
    }

    fn net_counters() -> Option<TransferCounters> {
        let mib = [CTL_NET, PF_ROUTE, 0, 0, NET_RT_IFLIST2, 0];
        let mut len: usize = 0;
        // SAFETY: null buffer queries the required byte count for NET_RT_IFLIST2.
        if unsafe { sysctl(mib.as_ptr(), 6, std::ptr::null_mut(), &mut len, std::ptr::null(), 0) } != 0 || len == 0 {
            return None;
        }
        let mut buf = vec![0u8; len.saturating_add(4096)];
        let mut got = buf.len();
        // SAFETY: `buf` has `got` writable bytes.
        if unsafe { sysctl(mib.as_ptr(), 6, buf.as_mut_ptr().cast(), &mut got, std::ptr::null(), 0) } != 0 {
            return None;
        }
        buf.truncate(got);
        let mut off = 0usize;
        let mut rx = 0u64;
        let mut tx = 0u64;
        let mut any = false;
        // `struct if_msghdr2` header is 32 bytes followed by `struct if_data64`, where
        // `ifi_ibytes` is at offset 32 + 64 = 96 and `ifi_obytes` at 32 + 72 = 104.
        // Note: on 64-bit Darwin `if_data64` starts with 8 u8s, 2 u32s, 1 u64 (`ifi_baudrate`),
        // then 5 u64 packet/collision counters (40 bytes) before `ifi_ibytes` & `ifi_obytes`:
        // 8 + 8 + 8 + 40 = 64 -> 32 + 64 = 96, 32 + 72 = 104.
        while off + 4 <= buf.len() {
            let msglen = u16::from_ne_bytes([buf[off], buf[off + 1]]) as usize;
            if msglen < 4 || off + msglen > buf.len() {
                break;
            }
            let msg_type = buf[off + 3];
            if msg_type == RTM_IFINFO2 && msglen >= 112 {
                let flags = i32::from_ne_bytes(buf[off + 8..off + 12].try_into().unwrap());
                if flags & IFF_LOOPBACK == 0 {
                    let ibytes = u64::from_ne_bytes(buf[off + 96..off + 104].try_into().unwrap());
                    let obytes = u64::from_ne_bytes(buf[off + 104..off + 112].try_into().unwrap());
                    rx = rx.saturating_add(ibytes);
                    tx = tx.saturating_add(obytes);
                    any = true;
                }
            }
            off += msglen;
        }
        any.then_some(TransferCounters { read_or_rx_bytes: rx, write_or_tx_bytes: tx })
    }

    pub fn snapshot() -> RawSystemCounters {
        let (memory_used_bytes, memory_total_bytes) = match memory_usage() {
            Some((u, t)) => (Some(u), Some(t)),
            None => (None, crate::process::total_memory_bytes()),
        };
        RawSystemCounters {
            cpu: cpu_counters(),
            cpu_cores: host_cpu_cores(),
            load_average: load_average(),
            memory_used_bytes,
            memory_total_bytes,
            net: net_counters(),
            disk_io: None,
        }
    }
}

#[cfg(windows)]
#[allow(non_snake_case, unsafe_code)]
mod imp {
    use super::{CpuCounters, RawSystemCounters, host_cpu_cores};

    #[repr(C)]
    #[derive(Default)]
    struct MemoryStatusEx {
        dwLength: u32,
        dwMemoryLoad: u32,
        ullTotalPhys: u64,
        ullAvailPhys: u64,
        ullTotalPageFile: u64,
        ullAvailPageFile: u64,
        ullTotalVirtual: u64,
        ullAvailVirtual: u64,
        ullAvailExtendedVirtual: u64,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemTimes(idle: *mut u64, kernel: *mut u64, user: *mut u64) -> i32;
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }

    fn cpu_counters() -> Option<CpuCounters> {
        let (mut idle, mut kernel, mut user) = (0u64, 0u64, 0u64);
        // SAFETY: FILETIME pointers read as packed u64s (`kernel` includes `idle` on Win32).
        let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
        if ok == 0 {
            return None;
        }
        let total = kernel.saturating_add(user);
        Some(CpuCounters::Ticks { busy: total.saturating_sub(idle), total })
    }

    fn memory_usage() -> Option<(u64, u64)> {
        let mut m = MemoryStatusEx { dwLength: std::mem::size_of::<MemoryStatusEx>() as u32, ..Default::default() };
        // SAFETY: `m` is a writable MEMORYSTATUSEX with `dwLength` set.
        let ok = unsafe { GlobalMemoryStatusEx(&mut m) };
        (ok != 0 && m.ullTotalPhys > 0).then(|| (m.ullTotalPhys.saturating_sub(m.ullAvailPhys), m.ullTotalPhys))
    }

    pub fn snapshot() -> RawSystemCounters {
        let (memory_used_bytes, memory_total_bytes) = match memory_usage() {
            Some((u, t)) => (Some(u), Some(t)),
            None => (None, None),
        };
        RawSystemCounters {
            cpu: cpu_counters(),
            cpu_cores: host_cpu_cores(),
            load_average: None,
            memory_used_bytes,
            memory_total_bytes,
            net: None,
            disk_io: None,
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod imp {
    use super::{RawSystemCounters, host_cpu_cores};

    pub fn snapshot() -> RawSystemCounters {
        RawSystemCounters {
            cpu: None,
            cpu_cores: host_cpu_cores(),
            load_average: None,
            memory_used_bytes: None,
            memory_total_bytes: None,
            net: None,
            disk_io: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn parses_linux_proc_and_cgroup_counters() {
        let stat = "cpu  1000 200 300 8000 500 50 25 10 999 888\ncpu0 500 100 150 4000 250 25 12 5 0 0\n";
        assert_eq!(linux_parse::proc_stat_cpu(stat), Some(CpuCounters::Ticks { busy: 1585, total: 10085 }));

        assert_eq!(linux_parse::cgroup_cpu_quota_cores("max 100000\n"), None);
        assert_eq!(linux_parse::cgroup_cpu_quota_cores("250000 100000\n"), Some(2.5));
        assert_eq!(
            linux_parse::cgroup_cpu_usage_usec("usage_usec 482910\nuser_usec 300000\nsystem_usec 182910\n"),
            Some(482910)
        );

        let mem = "MemTotal:       16384000 kB\nMemFree:         2048000 kB\nMemAvailable:    6144000 kB\n";
        assert_eq!(linux_parse::meminfo(mem), Some((10_240_000 * 1024, 16_384_000 * 1024)));

        // Container memory quota narrower than host RAM subtracts reclaimable `inactive_file`.
        let cg = linux_parse::cgroup_memory(
            "4294967296\n",
            "2147483648\n",
            Some("anon 1073741824\ninactive_file 536870912\n"),
            Some(16 * 1024 * 1024 * 1024),
        );
        assert_eq!(cg, Some((1_610_612_736, 4_294_967_296)));
        assert_eq!(linux_parse::cgroup_memory("max\n", "100\n", None, Some(1000)), None);

        assert_eq!(linux_parse::loadavg("0.42 1.25 2.50 2/812 9912\n"), Some([0.42, 1.25, 2.5]));

        let net = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:   99999      10    0    0    0     0          0         0    99999      10    0    0    0     0       0          0
  eth0: 1048576     500    0    0    0     0          0         0   524288     400    0    0    0     0       0          0
 wlan0:    4096      10    0    0    0     0          0         0     2048       5    0    0    0     0       0          0
";
        assert_eq!(
            linux_parse::net_dev(net),
            Some(TransferCounters { read_or_rx_bytes: 1_052_672, write_or_tx_bytes: 526_336 })
        );

        let disks = "\
   7       0 loop0 10 0 80 1 0 0 0 0 0 1 1
 259       0 nvme0n1 100 0 2000 10 50 0 1000 20 0 15 30
 259       1 nvme0n1p1 90 0 1800 9 45 0 900 18 0 14 27
   8       0 sda 10 0 400 2 5 0 200 4 0 3 6
   8       1 sda1 10 0 400 2 5 0 200 4 0 3 6
";
        assert_eq!(
            linux_parse::diskstats(disks),
            Some(TransferCounters { read_or_rx_bytes: 2400 * 512, write_or_tx_bytes: 1200 * 512 })
        );

        let io_stat = "259:0 rbytes=10240 wbytes=20480 rios=1 wios=2\n8:0 rbytes=512 wbytes=1024\n";
        assert_eq!(
            linux_parse::cgroup_io_stat(io_stat),
            Some(TransferCounters { read_or_rx_bytes: 10752, write_or_tx_bytes: 21504 })
        );
    }

    #[test]
    fn sampler_computes_rates_and_throttles_burst_polls() {
        let mut sampler = SystemSampler::default();
        let t0 = Instant::now();
        let first = sampler.record(
            RawSystemCounters {
                cpu: Some(CpuCounters::Ticks { busy: 100, total: 1000 }),
                cpu_cores: 8,
                load_average: Some([1.0, 0.5, 0.25]),
                memory_used_bytes: Some(4 << 30),
                memory_total_bytes: Some(16 << 30),
                net: Some(TransferCounters { read_or_rx_bytes: 1_000, write_or_tx_bytes: 2_000 }),
                disk_io: Some(TransferCounters { read_or_rx_bytes: 4_000, write_or_tx_bytes: 8_000 }),
            },
            t0,
        );
        assert_eq!(first.cpu_percent, None);
        assert_eq!(first.net_rx_bytes_per_sec, None);

        let second = sampler.record(
            RawSystemCounters {
                cpu: Some(CpuCounters::Ticks { busy: 350, total: 2000 }),
                cpu_cores: 8,
                load_average: Some([1.5, 0.75, 0.3]),
                memory_used_bytes: Some(6 << 30),
                memory_total_bytes: Some(16 << 30),
                net: Some(TransferCounters { read_or_rx_bytes: 21_000, write_or_tx_bytes: 12_000 }),
                disk_io: Some(TransferCounters { read_or_rx_bytes: 104_000, write_or_tx_bytes: 48_000 }),
            },
            t0 + Duration::from_secs(2),
        );
        assert_eq!(second.cpu_percent, Some(25.0));
        assert_eq!(second.net_rx_bytes_per_sec, Some(10_000.0));
        assert_eq!(second.net_tx_bytes_per_sec, Some(5_000.0));
        assert_eq!(second.disk_read_bytes_per_sec, Some(50_000.0));
        assert_eq!(second.disk_write_bytes_per_sec, Some(20_000.0));

        // A second window polling 100 ms later reuses the rate window rather than dividing over 100 ms.
        let burst = sampler.record(
            RawSystemCounters {
                cpu: Some(CpuCounters::Ticks { busy: 360, total: 2020 }),
                cpu_cores: 8,
                load_average: Some([1.6, 0.75, 0.3]),
                memory_used_bytes: Some(7 << 30),
                memory_total_bytes: Some(16 << 30),
                net: Some(TransferCounters { read_or_rx_bytes: 21_500, write_or_tx_bytes: 12_100 }),
                disk_io: Some(TransferCounters { read_or_rx_bytes: 104_000, write_or_tx_bytes: 48_000 }),
            },
            t0 + Duration::from_millis(2100),
        );
        assert_eq!(burst.cpu_percent, Some(25.0));
        assert_eq!(burst.memory_used_bytes, Some(7 << 30));
    }

    #[test]
    fn live_os_snapshot_reports_plausible_values() {
        let s = snapshot();
        assert!(s.cpu_cores >= 1);
        if cfg!(any(target_os = "macos", target_os = "linux", windows)) {
            assert!(s.cpu.is_some());
            let used = s.memory_used_bytes.expect("memory_used_bytes");
            let total = s.memory_total_bytes.expect("memory_total_bytes");
            assert!(used > 0 && used <= total, "{used} / {total}");
        }
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            let load = s.load_average.expect("load_average");
            assert!(load.iter().all(|v| v.is_finite() && *v >= 0.0), "{load:?}");
        }
        if cfg!(target_os = "macos") {
            let net = s.net.expect("macos net counters");
            assert!(net.read_or_rx_bytes > 0 || net.write_or_tx_bytes > 0, "{net:?}");
        }
    }
}
