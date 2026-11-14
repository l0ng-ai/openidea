//! Memory footprint of everything OpenIDEA runs: the backend, its WebView helper
//! processes, language servers and the processes started by Run / Debug /
//! terminals.
//!
//! Per process the number is what the OS reports as the process's memory:
//! macOS `phys_footprint` (Activity Monitor's "Memory", `footprint -p`),
//! Linux PSS (`/proc/<pid>/smaps_rollup`, else RSS), Windows private bytes.
//! Process trees come from one [`ProcessTable`] snapshot per measurement.
//!
//! WebKit helpers on macOS are XPC services launched by launchd, not our
//! children. Their pids come from each `WKWebView` ([`webkit_process_ids`]):
//! exact per window, and also right for `tauri dev`, where the binary runs
//! under a terminal and responsibility-based matching cannot tell our helpers
//! from those of other apps started by that terminal. Responsibility
//! ([`responsible_webkit_helpers`]) is the fallback for a bundled app.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// One row of a process listing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

/// A snapshot of the processes on the machine with their parent links.
#[derive(Clone, Debug, Default)]
pub struct ProcessTable {
    entries: HashMap<u32, ProcEntry>,
    children: HashMap<u32, Vec<u32>>,
}

impl ProcessTable {
    /// Every process the OS lists (empty where unsupported).
    pub fn snapshot() -> Self {
        Self::from_entries(imp::list_processes())
    }

    pub fn from_entries(entries: impl IntoIterator<Item = ProcEntry>) -> Self {
        let mut table = Self::default();
        for e in entries {
            if e.ppid != e.pid {
                table.children.entry(e.ppid).or_default().push(e.pid);
            }
            table.entries.insert(e.pid, e);
        }
        for kids in table.children.values_mut() {
            kids.sort_unstable();
        }
        table
    }

    pub fn get(&self, pid: u32) -> Option<&ProcEntry> {
        self.entries.get(&pid)
    }

    /// Direct children of `pid`, ascending.
    pub fn children(&self, pid: u32) -> &[u32] {
        self.children.get(&pid).map(Vec::as_slice).unwrap_or_default()
    }

    /// `root` and all its descendants (empty if `root` is not running).
    pub fn tree(&self, root: u32) -> Vec<u32> {
        if !self.entries.contains_key(&root) {
            return Vec::new();
        }
        let mut out = vec![root];
        let mut seen = HashSet::from([root]);
        let mut i = 0;
        while i < out.len() {
            for &c in self.children(out[i]) {
                if seen.insert(c) {
                    out.push(c);
                }
            }
            i += 1;
        }
        out
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MemoryCategory {
    /// The backend and its WebView processes.
    App,
    LanguageServer,
    /// Debug adapters, Run processes, terminal shells and other children.
    Process,
}

/// A process (tree) to attribute, e.g. a language server and its children.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryRoot {
    pub pid: u32,
    pub category: MemoryCategory,
    pub label: String,
    pub detail: Option<String>,
    /// Count the root's descendants too.
    pub with_children: bool,
}

/// Memory of one row of the breakdown.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemory {
    pub category: MemoryCategory,
    pub label: String,
    /// Project, run kind or similar.
    pub detail: Option<String>,
    /// The row's top process (the language server, run or terminal shell).
    pub pid: u32,
    /// Number of processes counted in this row.
    pub processes: u32,
    pub bytes: Option<u64>,
    /// CPU use since the previous measurement, in percent of one core (Activity
    /// Monitor's "% CPU"); `None` on the first measurement of every process.
    pub cpu_percent: Option<f32>,
}

/// Recognises WebView helpers that are our children (WebKitGTK, WebView2).
fn webview_helper_label(name: &str) -> Option<&'static str> {
    let name = name.trim_end_matches(".exe");
    match name {
        "WebKitWebProcess" => Some("Web content"),
        "WebKitNetworkProcess" => Some("Networking"),
        "WebKitGPUProcess" => Some("GPU"),
        "msedgewebview2" => Some("WebView2"),
        _ => None,
    }
}

/// Splits the processes of `self_pid` into rows. Each process is counted once:
/// the backend first, then `roots` in order (WebKit helpers, language servers,
/// runs, terminals), then whatever else descends from the backend, grouped by
/// the backend's direct child and labelled with its process name.
pub fn attribute(
    table: &ProcessTable,
    self_pid: u32,
    roots: &[MemoryRoot],
    footprint: impl Fn(u32) -> Option<u64>,
    mut cpu: impl FnMut(u32) -> Option<f32>,
) -> Vec<ProcessMemory> {
    let mut claimed = HashSet::from([self_pid]);
    let mut out = Vec::new();
    let mut push = |category, label: String, detail, pids: Vec<u32>| {
        let sizes: Vec<u64> = pids.iter().filter_map(|&p| footprint(p)).collect();
        let loads: Vec<f32> = pids.iter().filter_map(|&p| cpu(p)).collect();
        out.push(ProcessMemory {
            category,
            label,
            detail,
            pid: pids[0],
            processes: pids.len() as u32,
            bytes: (!sizes.is_empty()).then(|| sizes.iter().sum()),
            cpu_percent: (!loads.is_empty()).then(|| loads.iter().sum()),
        });
    };
    push(MemoryCategory::App, "Backend".into(), None, vec![self_pid]);

    for r in roots {
        let pids = if r.with_children {
            table.tree(r.pid)
        } else if r.pid != 0 && (table.get(r.pid).is_some() || table.entries.is_empty()) {
            vec![r.pid]
        } else {
            Vec::new()
        };
        let pids: Vec<u32> = pids.into_iter().filter(|p| claimed.insert(*p)).collect();
        if !pids.is_empty() {
            push(r.category, r.label.clone(), r.detail.clone(), pids);
        }
    }

    for &child in table.children(self_pid) {
        let pids: Vec<u32> = table.tree(child).into_iter().filter(|p| claimed.insert(*p)).collect();
        if pids.is_empty() {
            continue;
        }
        let name = table.get(child).map(|e| e.name.clone()).unwrap_or_default();
        match webview_helper_label(&name) {
            Some(label) => push(MemoryCategory::App, label.into(), None, pids),
            None => push(MemoryCategory::Process, name, None, pids),
        }
    }
    out
}

/// CPU load per process from the change of its CPU time between measurements.
#[derive(Debug, Default)]
pub struct CpuSampler {
    last: HashMap<u32, CpuSample>,
}

#[derive(Clone, Copy, Debug)]
struct CpuSample {
    time: Duration,
    at: Instant,
    percent: Option<f32>,
}

/// Shorter gaps (several windows polling at once) keep the previous value
/// instead of measuring over a few milliseconds.
const MIN_CPU_INTERVAL: Duration = Duration::from_millis(500);

impl CpuSampler {
    /// Percent of one core used by `pid` since its previous sample.
    pub fn percent(&mut self, pid: u32) -> Option<f32> {
        self.record(pid, cpu_time(pid)?, Instant::now())
    }

    fn record(&mut self, pid: u32, time: Duration, at: Instant) -> Option<f32> {
        let percent = match self.last.get(&pid) {
            Some(prev) if at.duration_since(prev.at) < MIN_CPU_INTERVAL => return prev.percent,
            // A reused pid restarts its CPU time.
            Some(prev) if time >= prev.time => {
                Some((time - prev.time).as_secs_f32() / at.duration_since(prev.at).as_secs_f32() * 100.0)
            }
            _ => None,
        };
        self.last.insert(pid, CpuSample { time, at, percent });
        percent
    }

    /// Forgets processes that are no longer listed.
    pub fn retain(&mut self, table: &ProcessTable) {
        if !table.entries.is_empty() {
            self.last.retain(|pid, _| table.get(*pid).is_some());
        }
    }
}

/// CPU time (user + system) `pid` has used so far.
pub fn cpu_time(pid: u32) -> Option<Duration> {
    imp::cpu_time(pid)
}

/// Ends `pid` and every process it started, children first: a polite request
/// (`SIGTERM`), then a forced kill after `grace` for whatever is still running.
/// Refuses (returns false) unless `pid` descends from `self_pid`.
pub fn end_process_tree(self_pid: u32, pid: u32, grace: Duration) -> bool {
    let table = ProcessTable::snapshot();
    if pid == self_pid || !table.tree(self_pid).contains(&pid) {
        return false;
    }
    let pids: Vec<u32> = table.tree(pid).into_iter().rev().collect();
    for &p in &pids {
        imp::terminate(p, false);
    }
    let deadline = Instant::now() + grace;
    loop {
        let now = ProcessTable::snapshot();
        let left: Vec<u32> = pids.iter().copied().filter(|p| now.get(*p).is_some()).collect();
        if left.is_empty() {
            return true;
        }
        if Instant::now() >= deadline {
            for p in left {
                imp::terminate(p, true);
            }
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Bytes the OS attributes to `pid` (see the module docs); `None` when the
/// process is gone or not readable.
pub fn footprint_bytes(pid: u32) -> Option<u64> {
    imp::footprint_bytes(pid)
}

/// Processes serving one `WKWebView` (0 = none / unknown).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WebKitPids {
    pub web_content: u32,
    pub gpu: u32,
    pub networking: u32,
}

/// Asks a `WKWebView` for its WebContent, GPU and Networking process ids
/// (`_webProcessIdentifier` & co., WebKit SPI that Safari's tooling uses).
/// Selectors the running WebKit lacks yield 0.
///
/// # Safety
/// `webview` must be a live `WKWebView*`, and this must run on the main thread.
#[cfg(target_os = "macos")]
pub unsafe fn webkit_process_ids(webview: *mut std::ffi::c_void) -> WebKitPids {
    // SAFETY: forwarded from the caller.
    unsafe { imp::webkit_process_ids(webview) }
}

/// Fallback when the WebView cannot be asked: WebKit helpers whose
/// "responsible process" is us. Only meaningful when we are our own
/// responsible process (a bundled app), not under a terminal in `tauri dev`.
/// Returns `(pid, label)` pairs.
pub fn responsible_webkit_helpers(table: &ProcessTable, self_pid: u32) -> Vec<(u32, &'static str)> {
    let Some(responsible) = imp::responsible_pid(self_pid) else { return Vec::new() };
    if responsible != self_pid {
        return Vec::new();
    }
    let mut out: Vec<(u32, &'static str)> = table
        .entries
        .values()
        .filter_map(|e| {
            let label = match e.name.as_str() {
                n if n.starts_with("com.apple.WebKit.WebContent") => "Web content",
                n if n.starts_with("com.apple.WebKit.GPU") => "GPU",
                n if n.starts_with("com.apple.WebKit.Networking") => "Networking",
                _ => return None,
            };
            (imp::responsible_pid(e.pid) == Some(self_pid)).then_some((e.pid, label))
        })
        .collect();
    out.sort_unstable();
    out
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod imp {
    use super::{ProcEntry, WebKitPids};
    use std::ffi::{c_char, c_void};

    const PROC_PIDTBSDINFO: i32 = 3;
    const RUSAGE_INFO_V4: i32 = 4;
    /// Index of `ri_phys_footprint` in `rusage_info_v4` read as u64 words
    /// (16-byte uuid, then user/system time, idle/interrupt wakeups, pageins,
    /// wired size, resident size).
    const PHYS_FOOTPRINT_WORD: usize = 9;

    /// `struct proc_bsdinfo` from `<sys/proc_info.h>` (pbi_ppid is word 4).
    #[repr(C)]
    struct ProcBsdInfo {
        flags_to_svgid: [u32; 12],
        comm: [u8; 16],
        name: [u8; 32],
        rest: [u32; 5],
        nice: i32,
        start_tvsec: u64,
        start_tvusec: u64,
    }

    unsafe extern "C" {
        fn proc_listallpids(buffer: *mut c_void, size: i32) -> i32;
        fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, size: i32) -> i32;
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut c_void) -> i32;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
        fn kill(pid: i32, signal: i32) -> i32;
    }

    #[repr(C)]
    #[derive(Default)]
    struct MachTimebaseInfo {
        numer: u32,
        denom: u32,
    }

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_msgSend();
        fn sel_registerName(name: *const c_char) -> *const c_void;
    }

    /// `RTLD_DEFAULT` on Darwin.
    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

    fn c_name(bytes: &[u8]) -> String {
        let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
        String::from_utf8_lossy(&bytes[..end]).into_owned()
    }

    pub fn list_processes() -> Vec<ProcEntry> {
        // SAFETY: a null buffer asks for the number of pids.
        let n = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
        if n <= 0 {
            return Vec::new();
        }
        let mut pids = vec![0i32; n as usize + 64];
        let bytes = (pids.len() * std::mem::size_of::<i32>()) as i32;
        // SAFETY: `pids` is a writable buffer of `bytes` bytes.
        let n = unsafe { proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        pids.truncate(n.max(0) as usize);
        let size = std::mem::size_of::<ProcBsdInfo>() as i32;
        pids.into_iter()
            .filter(|&p| p > 0)
            .filter_map(|pid| {
                // SAFETY: an all-zero proc_bsdinfo is a valid value of this plain C struct.
                let mut info: ProcBsdInfo = unsafe { std::mem::zeroed() };
                // SAFETY: `info` is a writable buffer of `size` bytes for PROC_PIDTBSDINFO.
                let got =
                    unsafe { proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, (&mut info as *mut ProcBsdInfo).cast(), size) };
                (got == size).then(|| {
                    let name = c_name(&info.name);
                    ProcEntry {
                        pid: pid as u32,
                        ppid: info.flags_to_svgid[4],
                        name: if name.is_empty() { c_name(&info.comm) } else { name },
                    }
                })
            })
            .collect()
    }

    pub fn footprint_bytes(pid: u32) -> Option<u64> {
        let mut info = [0u64; 64];
        // SAFETY: `info` (512 bytes) is larger than `rusage_info_v4`.
        let rc = unsafe { proc_pid_rusage(pid as i32, RUSAGE_INFO_V4, info.as_mut_ptr().cast()) };
        (rc == 0).then_some(info[PHYS_FOOTPRINT_WORD])
    }

    /// `ri_user_time + ri_system_time` (words 2 and 3), in Mach absolute time units.
    pub fn cpu_time(pid: u32) -> Option<std::time::Duration> {
        static TIMEBASE: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();
        let &(numer, denom) = TIMEBASE.get_or_init(|| {
            let mut tb = MachTimebaseInfo::default();
            // SAFETY: `tb` is a writable mach_timebase_info_data_t.
            let ok = unsafe { mach_timebase_info(&mut tb) } == 0 && tb.denom != 0;
            if ok { (tb.numer as u64, tb.denom as u64) } else { (1, 1) }
        });
        let mut info = [0u64; 64];
        // SAFETY: `info` (512 bytes) is larger than `rusage_info_v4`.
        let rc = unsafe { proc_pid_rusage(pid as i32, RUSAGE_INFO_V4, info.as_mut_ptr().cast()) };
        let ticks = (rc == 0).then(|| info[2].saturating_add(info[3]))?;
        Some(std::time::Duration::from_nanos((ticks as u128 * numer as u128 / denom as u128) as u64))
    }

    pub fn terminate(pid: u32, force: bool) {
        // SAFETY: plain syscall.
        unsafe { kill(pid as i32, if force { 9 } else { 15 }) };
    }

    /// `responsibility_get_pid_responsible_for_pid` (libsystem SPI used by
    /// Activity Monitor), looked up at run time so a missing symbol only
    /// disables the fallback.
    pub fn responsible_pid(pid: u32) -> Option<u32> {
        type F = unsafe extern "C" fn(i32) -> i32;
        static FN: std::sync::OnceLock<Option<F>> = std::sync::OnceLock::new();
        let f = FN.get_or_init(|| {
            // SAFETY: dlsym with RTLD_DEFAULT and a NUL-terminated name.
            let p = unsafe { dlsym(RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) };
            // SAFETY: the symbol has this C signature (pid_t -> pid_t).
            (!p.is_null()).then(|| unsafe { std::mem::transmute::<*mut c_void, F>(p) })
        });
        // SAFETY: plain C call taking and returning a pid.
        let r = unsafe { (*f)?(pid as i32) };
        (r > 0).then_some(r as u32)
    }

    pub unsafe fn webkit_process_ids(webview: *mut c_void) -> WebKitPids {
        if webview.is_null() {
            return WebKitPids::default();
        }
        type Responds = unsafe extern "C" fn(*mut c_void, *const c_void, *const c_void) -> bool;
        type GetPid = unsafe extern "C" fn(*mut c_void, *const c_void) -> i32;
        // SAFETY: objc_msgSend must be called through a cast to the method's signature.
        let responds: Responds = unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
        // SAFETY: as above.
        let get_pid: GetPid = unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
        let query = |name: &std::ffi::CStr| -> u32 {
            // SAFETY: NUL-terminated selector names; `webview` is a live object
            // (caller contract) and the selector is only sent when implemented.
            unsafe {
                let responds_sel = sel_registerName(c"respondsToSelector:".as_ptr());
                let sel = sel_registerName(name.as_ptr());
                if !responds(webview, responds_sel, sel) {
                    return 0;
                }
                get_pid(webview, sel).max(0) as u32
            }
        };
        WebKitPids {
            web_content: query(c"_webProcessIdentifier"),
            gpu: query(c"_gpuProcessIdentifier"),
            networking: query(c"_networkProcessIdentifier"),
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::ProcEntry;

    /// `/proc/<pid>/stat`: `pid (comm) state ppid …`; comm may contain spaces and parens.
    fn parse_stat(pid: u32, text: &str) -> Option<ProcEntry> {
        let open = text.find('(')?;
        let close = text.rfind(')')?;
        let name = text.get(open + 1..close)?.to_owned();
        let mut rest = text.get(close + 1..)?.split_whitespace();
        rest.next()?; // state
        let ppid = rest.next()?.parse().ok()?;
        Some(ProcEntry { pid, ppid, name })
    }

    pub fn list_processes() -> Vec<ProcEntry> {
        let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
        dir.flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(|pid| parse_stat(pid, &std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?))
            .collect()
    }

    fn kb_field(text: &str, key: &str) -> Option<u64> {
        let line = text.lines().find(|l| l.starts_with(key))?;
        let kb: u64 = line[key.len()..].split_whitespace().next()?.parse().ok()?;
        Some(kb * 1024)
    }

    pub fn footprint_bytes(pid: u32) -> Option<u64> {
        if let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup"))
            && let Some(pss) = kb_field(&text, "Pss:")
        {
            return Some(pss);
        }
        kb_field(&std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?, "VmRSS:")
    }

    pub fn responsible_pid(_pid: u32) -> Option<u32> {
        None
    }

    unsafe extern "C" {
        fn sysconf(name: i32) -> i64;
        fn kill(pid: i32, signal: i32) -> i32;
    }
    const SC_CLK_TCK: i32 = 2;

    /// `utime + stime` of `/proc/<pid>/stat` (fields 14 and 15, in clock ticks).
    fn stat_ticks(text: &str) -> Option<u64> {
        let mut rest = text.get(text.rfind(')')? + 1..)?.split_whitespace().skip(11);
        Some(rest.next()?.parse::<u64>().ok()? + rest.next()?.parse::<u64>().ok()?)
    }

    pub fn cpu_time(pid: u32) -> Option<std::time::Duration> {
        static HZ: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
        // SAFETY: plain libc call.
        let hz =
            *HZ.get_or_init(|| u64::try_from(unsafe { sysconf(SC_CLK_TCK) }).ok().filter(|&h| h > 0).unwrap_or(100));
        let ticks = stat_ticks(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)?;
        Some(std::time::Duration::from_nanos(ticks * 1_000_000_000 / hz))
    }

    pub fn terminate(pid: u32, force: bool) {
        // SAFETY: plain syscall.
        unsafe { kill(pid as i32, if force { 9 } else { 15 }) };
    }

    #[cfg(test)]
    #[test]
    fn reads_cpu_ticks_from_stat() {
        let text = "7 (a (b) c) S 3 7 7 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 1 0";
        assert_eq!(stat_ticks(text), Some(300));
    }

    #[cfg(test)]
    #[test]
    fn parses_stat_with_parens_in_name() {
        let e = parse_stat(7, "7 (a (b) c) S 3 7 7 0").unwrap();
        assert_eq!((e.ppid, e.name.as_str()), (3, "a (b) c"));
    }
}

#[cfg(windows)]
#[allow(non_snake_case, unsafe_code)]
mod imp {
    use super::ProcEntry;
    use std::ffi::c_void;

    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const INVALID_HANDLE_VALUE: *mut c_void = -1isize as *mut c_void;

    #[repr(C)]
    struct ProcessEntry32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    /// `PROCESS_MEMORY_COUNTERS_EX`.
    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCountersEx {
        cb: u32,
        PageFaultCount: u32,
        PeakWorkingSetSize: usize,
        WorkingSetSize: usize,
        QuotaPeakPagedPoolUsage: usize,
        QuotaPagedPoolUsage: usize,
        QuotaPeakNonPagedPoolUsage: usize,
        QuotaNonPagedPoolUsage: usize,
        PagefileUsage: usize,
        PeakPagefileUsage: usize,
        PrivateUsage: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn K32GetProcessMemoryInfo(process: *mut c_void, counters: *mut c_void, cb: u32) -> i32;
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut u64,
            exit: *mut u64,
            kernel: *mut u64,
            user: *mut u64,
        ) -> i32;
        fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
    }

    const PROCESS_TERMINATE: u32 = 0x1;

    pub fn list_processes() -> Vec<ProcEntry> {
        // SAFETY: plain Win32 call; the handle is closed below.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let mut out = Vec::new();
        // SAFETY: an all-zero PROCESSENTRY32W is valid; dwSize is set before use.
        let mut e: ProcessEntry32W = unsafe { std::mem::zeroed() };
        e.dwSize = std::mem::size_of::<ProcessEntry32W>() as u32;
        // SAFETY: `snap` is a valid snapshot and `e` a writable entry with dwSize set.
        let mut ok = unsafe { Process32FirstW(snap, &mut e) };
        while ok != 0 {
            let end = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            out.push(ProcEntry {
                pid: e.th32ProcessID,
                ppid: e.th32ParentProcessID,
                name: String::from_utf16_lossy(&e.szExeFile[..end]),
            });
            // SAFETY: as above.
            ok = unsafe { Process32NextW(snap, &mut e) };
        }
        // SAFETY: `snap` was returned by CreateToolhelp32Snapshot.
        unsafe { CloseHandle(snap) };
        out
    }

    pub fn footprint_bytes(pid: u32) -> Option<u64> {
        // SAFETY: plain Win32 call; the handle is closed below.
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return None;
        }
        let mut c =
            ProcessMemoryCountersEx { cb: std::mem::size_of::<ProcessMemoryCountersEx>() as u32, ..Default::default() };
        // SAFETY: `h` is a process handle and `c` a writable counters struct with `cb` set.
        let ok = unsafe { K32GetProcessMemoryInfo(h, (&raw mut c).cast(), c.cb) };
        // SAFETY: `h` came from OpenProcess.
        unsafe { CloseHandle(h) };
        (ok != 0).then_some(c.PrivateUsage as u64)
    }

    /// Kernel + user time from `GetProcessTimes` (100 ns units).
    pub fn cpu_time(pid: u32) -> Option<std::time::Duration> {
        // SAFETY: plain Win32 call; the handle is closed below.
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return None;
        }
        let (mut creation, mut exit, mut kernel, mut user) = (0u64, 0u64, 0u64, 0u64);
        // SAFETY: `h` is a process handle; the FILETIMEs are written as u64s.
        let ok = unsafe { GetProcessTimes(h, &mut creation, &mut exit, &mut kernel, &mut user) };
        // SAFETY: `h` came from OpenProcess.
        unsafe { CloseHandle(h) };
        (ok != 0).then(|| std::time::Duration::from_nanos(kernel.saturating_add(user).saturating_mul(100)))
    }

    /// Windows has no polite request for a console process; both steps terminate it.
    pub fn terminate(pid: u32, _force: bool) {
        // SAFETY: plain Win32 call; the handle is closed below.
        let h = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if h.is_null() {
            return;
        }
        // SAFETY: `h` is a process handle opened with PROCESS_TERMINATE.
        unsafe { TerminateProcess(h, 1) };
        // SAFETY: `h` came from OpenProcess.
        unsafe { CloseHandle(h) };
    }

    pub fn responsible_pid(_pid: u32) -> Option<u32> {
        None
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod imp {
    use super::ProcEntry;

    pub fn list_processes() -> Vec<ProcEntry> {
        Vec::new()
    }
    pub fn footprint_bytes(_pid: u32) -> Option<u64> {
        None
    }
    pub fn cpu_time(_pid: u32) -> Option<std::time::Duration> {
        None
    }
    pub fn terminate(_pid: u32, _force: bool) {}
    pub fn responsible_pid(_pid: u32) -> Option<u32> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(pid: u32, ppid: u32, name: &str) -> ProcEntry {
        ProcEntry { pid, ppid, name: name.into() }
    }

    /// 100 = OpenIDEA; 200 jdtls (java) with a child; 300 rust-analyzer with a
    /// proc-macro server; 400 a terminal shell running cargo → rustc; 500 a
    /// debug adapter; 600 a WebView2-style child; 900 an unrelated process.
    fn table() -> ProcessTable {
        ProcessTable::from_entries([
            e(1, 0, "launchd"),
            e(100, 1, "openidea"),
            e(200, 100, "java"),
            e(201, 200, "java-helper"),
            e(300, 100, "rust-analyzer"),
            e(301, 300, "rust-analyzer-proc-macro-srv"),
            e(400, 100, "zsh"),
            e(401, 400, "cargo"),
            e(402, 401, "rustc"),
            e(500, 100, "codelldb"),
            e(600, 100, "msedgewebview2.exe"),
            e(601, 600, "msedgewebview2.exe"),
            e(700, 1, "com.apple.WebKit.WebContent"),
            e(900, 1, "Safari"),
        ])
    }

    fn mb(pid: u32) -> Option<u64> {
        (pid != 401).then_some(pid as u64 * 1_000_000)
    }

    fn root(pid: u32, category: MemoryCategory, label: &str, with_children: bool) -> MemoryRoot {
        MemoryRoot { pid, category, label: label.into(), detail: None, with_children }
    }

    #[test]
    fn tree_includes_descendants_and_survives_cycles() {
        let t = table();
        assert_eq!(t.tree(400), vec![400, 401, 402]);
        assert!(t.tree(4242).is_empty());
        let cyclic = ProcessTable::from_entries([e(1, 2, "a"), e(2, 1, "b")]);
        assert_eq!(cyclic.tree(1), vec![1, 2]);
    }

    #[test]
    fn groups_every_process_once() {
        let t = table();
        let mut jdtls = root(200, MemoryCategory::LanguageServer, "jdtls", true);
        jdtls.detail = Some("idea".into());
        let roots = [
            root(700, MemoryCategory::App, "Web content", false),
            jdtls,
            root(300, MemoryCategory::LanguageServer, "rust-analyzer", true),
            root(400, MemoryCategory::Process, "Terminal: zsh", true),
            // Gone since the snapshot: no row.
            root(800, MemoryCategory::Process, "Run: old", true),
            // Already counted under rust-analyzer: no row.
            root(301, MemoryCategory::Process, "dup", true),
        ];
        let rows = attribute(&t, 100, &roots, mb, |pid| (pid == 300 || pid == 301).then_some(25.0));
        let summary: Vec<(MemoryCategory, &str, u32, Option<u64>)> =
            rows.iter().map(|r| (r.category, r.label.as_str(), r.processes, r.bytes)).collect();
        assert_eq!(
            summary,
            vec![
                (MemoryCategory::App, "Backend", 1, Some(100_000_000)),
                (MemoryCategory::App, "Web content", 1, Some(700_000_000)),
                (MemoryCategory::LanguageServer, "jdtls", 2, Some(401_000_000)),
                (MemoryCategory::LanguageServer, "rust-analyzer", 2, Some(601_000_000)),
                // 401 has no readable footprint; the row still counts it.
                (MemoryCategory::Process, "Terminal: zsh", 3, Some(802_000_000)),
                (MemoryCategory::Process, "codelldb", 1, Some(500_000_000)),
                (MemoryCategory::App, "WebView2", 2, Some(1_201_000_000)),
            ]
        );
        assert_eq!(rows[2].detail.as_deref(), Some("idea"));
        let pids: Vec<u32> = rows.iter().map(|r| r.pid).collect();
        assert_eq!(pids, vec![100, 700, 200, 300, 400, 500, 600]);
        assert_eq!(rows[3].cpu_percent, Some(50.0));
        assert_eq!(rows[2].cpu_percent, None);
        assert!(!rows.iter().any(|r| r.label == "Safari"));
    }

    #[test]
    fn unreadable_rows_have_no_bytes() {
        let t = table();
        let rows = attribute(&t, 100, &[root(401, MemoryCategory::Process, "cargo", false)], mb, |_| None);
        let cargo = rows.iter().find(|r| r.label == "cargo").unwrap();
        assert_eq!((cargo.processes, cargo.bytes), (1, None));
    }

    #[test]
    fn cpu_percent_comes_from_the_change_in_cpu_time() {
        let mut s = CpuSampler::default();
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        assert_eq!(s.record(7, ms(1000), t0), None, "first sample has nothing to compare with");
        assert_eq!(s.record(7, ms(1500), t0 + ms(1000)), Some(50.0));
        assert_eq!(s.record(7, ms(1900), t0 + ms(1100)), Some(50.0), "too soon: previous value");
        assert_eq!(s.record(7, ms(3500), t0 + ms(2000)), Some(200.0), "two busy cores");
        assert_eq!(s.record(7, ms(10), t0 + ms(3000)), None, "pid reused by a new process");
        s.retain(&ProcessTable::from_entries([e(8, 1, "other")]));
        assert_eq!(s.record(7, ms(500), t0 + ms(4000)), None, "forgotten once unlisted");
    }

    #[test]
    fn ends_only_descendants() {
        let me = std::process::id();
        assert!(!end_process_tree(me, me, Duration::ZERO));
        assert!(!end_process_tree(me, 1, Duration::ZERO));
    }

    #[cfg(unix)]
    #[test]
    fn ends_a_child_and_its_children() {
        let mut child = std::process::Command::new("sh").args(["-c", "sleep 30 & wait"]).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while ProcessTable::snapshot().children(child.id()).is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let sleeper = ProcessTable::snapshot().children(child.id())[0];
        assert!(end_process_tree(std::process::id(), child.id(), Duration::from_secs(2)));
        assert!(child.wait().is_ok());
        assert!(ProcessTable::snapshot().get(sleeper).is_none(), "grandchild ended too");
    }

    #[test]
    fn measures_this_process() {
        if cfg!(any(target_os = "macos", target_os = "linux", windows)) {
            let me = std::process::id();
            let t = ProcessTable::snapshot();
            assert!(t.get(me).is_some(), "own pid listed");
            let bytes = footprint_bytes(me).expect("own footprint");
            assert!(bytes > 1 << 16 && bytes < 1 << 40, "{bytes}");
            let before = cpu_time(me).expect("own CPU time");
            let spin = Instant::now();
            while spin.elapsed() < Duration::from_millis(50) {
                std::hint::black_box(spin.elapsed());
            }
            let used = cpu_time(me).unwrap() - before;
            assert!(used > Duration::from_millis(10) && used < Duration::from_secs(5), "{used:?}");
        }
        if cfg!(target_os = "macos") {
            assert!(imp::responsible_pid(std::process::id()).is_some(), "responsibility SPI resolved");
        }
    }
}
