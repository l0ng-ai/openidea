//! Process-level diagnostics: resident memory, heap in use, uptime.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

static START: OnceLock<Instant> = OnceLock::new();
static BEFORE_MAIN: OnceLock<Option<Duration>> = OnceLock::new();

/// Records the process start; call as early as possible in `main`. Later
/// calls are ignored. [`uptime`] falls back to the first call of either.
pub fn mark_start() {
    START.get_or_init(Instant::now);
    BEFORE_MAIN.get_or_init(process_age);
}

/// Time since [`mark_start`].
pub fn uptime() -> Duration {
    START.get_or_init(Instant::now).elapsed()
}

/// OS process start → [`mark_start`]: exec, code-signature checks (macOS scans
/// a freshly linked, unsigned binary for seconds) and dynamic loading.
pub fn before_main() -> Option<Duration> {
    BEFORE_MAIN.get().copied().flatten()
}

/// Time since the operating system started this process (includes everything
/// before `main`: dynamic loading, Tauri and WebView set-up when called later).
pub fn process_age() -> Option<Duration> {
    let start = imp::process_start()?;
    std::time::SystemTime::now().duration_since(start).ok()
}

/// Resident set size in bytes (what IDEA's memory indicator approximates).
pub fn resident_bytes() -> Option<u64> {
    imp::resident_bytes()
}

/// Bytes currently allocated by the system allocator, when it can tell.
pub fn heap_bytes() -> Option<u64> {
    imp::heap_bytes()
}

/// Physical memory of the machine, for the indicator's "of" part.
pub fn total_memory_bytes() -> Option<u64> {
    imp::total_memory_bytes()
}

#[cfg(target_os = "macos")]
#[allow(non_camel_case_types, unsafe_code)]
mod imp {
    use std::ffi::c_void;

    type kern_return_t = i32;
    type mach_port_t = u32;
    type natural_t = u32;
    type mach_msg_type_number_t = u32;

    #[repr(C)]
    #[derive(Default)]
    struct TimeValue {
        seconds: i32,
        microseconds: i32,
    }

    /// `struct mach_task_basic_info` (MACH_TASK_BASIC_INFO = 20).
    #[repr(C, packed(4))]
    #[derive(Default)]
    struct MachTaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: TimeValue,
        system_time: TimeValue,
        policy: i32,
        suspend_count: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct MallocStatistics {
        blocks_in_use: u32,
        size_in_use: usize,
        max_size_in_use: usize,
        size_allocated: usize,
    }

    const MACH_TASK_BASIC_INFO: u32 = 20;
    const PROC_PIDTBSDINFO: i32 = 3;

    /// `struct proc_bsdinfo` from `<sys/proc_info.h>`.
    #[repr(C)]
    struct ProcBsdInfo {
        flags_to_svgid: [u32; 12],
        comm: [u8; 16],
        name: [u8; 32],
        nfiles_to_tpgid: [u32; 5],
        nice: i32,
        start_tvsec: u64,
        start_tvusec: u64,
    }

    unsafe extern "C" {
        static mach_task_self_: mach_port_t;
        fn task_info(
            task: mach_port_t,
            flavor: u32,
            info: *mut natural_t,
            count: *mut mach_msg_type_number_t,
        ) -> kern_return_t;
        fn malloc_zone_statistics(zone: *mut c_void, stats: *mut MallocStatistics);
        fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, size: i32) -> i32;
        fn sysctlbyname(
            name: *const std::ffi::c_char,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> i32;
    }

    pub fn resident_bytes() -> Option<u64> {
        let mut info = MachTaskBasicInfo::default();
        let mut count = (std::mem::size_of::<MachTaskBasicInfo>() / std::mem::size_of::<natural_t>()) as u32;
        // SAFETY: `info` is a correctly sized, writable MACH_TASK_BASIC_INFO
        // buffer and `count` holds its size in natural_t units.
        let rc = unsafe {
            task_info(mach_task_self_, MACH_TASK_BASIC_INFO, &mut info as *mut _ as *mut natural_t, &mut count)
        };
        (rc == 0).then_some(info.resident_size)
    }

    pub fn process_start() -> Option<std::time::SystemTime> {
        // SAFETY: an all-zero proc_bsdinfo is a valid value of this plain C struct.
        let mut info: ProcBsdInfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<ProcBsdInfo>() as i32;
        // SAFETY: `info` is a writable buffer of `size` bytes for PROC_PIDTBSDINFO.
        let n = unsafe {
            proc_pidinfo(std::process::id() as i32, PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut c_void, size)
        };
        (n == size && info.start_tvsec > 0).then(|| {
            std::time::UNIX_EPOCH + std::time::Duration::new(info.start_tvsec, info.start_tvusec as u32 * 1000)
        })
    }

    pub fn heap_bytes() -> Option<u64> {
        let mut stats = MallocStatistics::default();
        // SAFETY: a null zone asks for statistics over all zones; `stats` is writable.
        unsafe { malloc_zone_statistics(std::ptr::null_mut(), &mut stats) };
        (stats.size_in_use > 0).then_some(stats.size_in_use as u64)
    }

    pub fn total_memory_bytes() -> Option<u64> {
        let mut value: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: "hw.memsize" is a u64; buffer and length match.
        let rc = unsafe {
            sysctlbyname(
                c"hw.memsize".as_ptr(),
                &mut value as *mut u64 as *mut c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        (rc == 0 && value > 0).then_some(value)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    fn kb_field(file: &str, key: &str) -> Option<u64> {
        let text = std::fs::read_to_string(file).ok()?;
        let line = text.lines().find(|l| l.starts_with(key))?;
        let kb: u64 = line[key.len()..].split_whitespace().next()?.parse().ok()?;
        Some(kb * 1024)
    }

    pub fn resident_bytes() -> Option<u64> {
        kb_field("/proc/self/status", "VmRSS:")
    }

    /// procfs creates `/proc/<pid>` when the process starts.
    pub fn process_start() -> Option<std::time::SystemTime> {
        std::fs::metadata(format!("/proc/{}", std::process::id())).ok()?.modified().ok()
    }

    pub fn heap_bytes() -> Option<u64> {
        None
    }

    pub fn total_memory_bytes() -> Option<u64> {
        kb_field("/proc/meminfo", "MemTotal:")
    }
}

#[cfg(windows)]
#[allow(non_snake_case, unsafe_code)]
mod imp {
    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCounters {
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
    }

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
        fn GetCurrentProcess() -> *mut std::ffi::c_void;
        fn K32GetProcessMemoryInfo(process: *mut std::ffi::c_void, counters: *mut std::ffi::c_void, cb: u32) -> i32;
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }

    pub fn resident_bytes() -> Option<u64> {
        let mut c =
            ProcessMemoryCounters { cb: std::mem::size_of::<ProcessMemoryCounters>() as u32, ..Default::default() };
        // SAFETY: `c` is a writable PROCESS_MEMORY_COUNTERS with `cb` set.
        let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), (&raw mut c).cast(), c.cb) };
        (ok != 0).then_some(c.WorkingSetSize as u64)
    }

    pub fn heap_bytes() -> Option<u64> {
        None
    }

    pub fn process_start() -> Option<std::time::SystemTime> {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            // The same signature `memory.rs` declares: FILETIMEs read as packed u64s.
            fn GetProcessTimes(
                process: *mut std::ffi::c_void,
                creation: *mut u64,
                exit: *mut u64,
                kernel: *mut u64,
                user: *mut u64,
            ) -> i32;
        }
        let (mut c, mut e, mut k, mut u) = Default::default();
        // SAFETY: all out-pointers are valid 64-bit FILETIME slots.
        let ok = unsafe { GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) };
        if ok == 0 {
            return None;
        }
        let ticks = c; // 100 ns since 1601-01-01
        let unix_100ns = ticks.checked_sub(116_444_736_000_000_000)?;
        Some(std::time::UNIX_EPOCH + std::time::Duration::from_nanos(unix_100ns * 100))
    }

    pub fn total_memory_bytes() -> Option<u64> {
        let mut m = MemoryStatusEx { dwLength: std::mem::size_of::<MemoryStatusEx>() as u32, ..Default::default() };
        // SAFETY: `m` is a writable MEMORYSTATUSEX with `dwLength` set.
        let ok = unsafe { GlobalMemoryStatusEx(&mut m) };
        (ok != 0).then_some(m.ullTotalPhys)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod imp {
    pub fn process_start() -> Option<std::time::SystemTime> {
        None
    }
    pub fn resident_bytes() -> Option<u64> {
        None
    }
    pub fn heap_bytes() -> Option<u64> {
        None
    }
    pub fn total_memory_bytes() -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_plausible_numbers() {
        super::mark_start();
        if cfg!(any(target_os = "macos", target_os = "linux", windows)) {
            let rss = super::resident_bytes().expect("rss");
            assert!(rss > 1 << 20 && rss < 1 << 40, "{rss}");
            let total = super::total_memory_bytes().expect("total");
            assert!(total > rss);
        }
        if cfg!(target_os = "macos") {
            let before = super::heap_bytes().unwrap();
            let big = vec![1u8; 64 << 20];
            let after = super::heap_bytes().unwrap();
            assert!(after >= before + (32 << 20), "{before} -> {after}");
            drop(big);
        }
        assert!(super::uptime() < std::time::Duration::from_secs(3600));
        if cfg!(any(target_os = "macos", target_os = "linux", windows)) {
            let age = super::process_age().expect("process age");
            assert!(age < std::time::Duration::from_secs(3600), "{age:?}");
        }
    }
}
