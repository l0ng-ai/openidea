use std::time::Duration;

use crate::socket::AttachError;
#[cfg(unix)]
use crate::socket::{check_socket, has_listener, has_listener_at, socket_path, temp_dir};
#[cfg(any(target_os = "linux", target_os = "macos", all(unix, test)))]
use std::time::UNIX_EPOCH;
#[cfg(unix)]
use std::{
    fs::{Metadata, OpenOptions},
    io,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Instant, SystemTime},
};

/// Default budget for `ensure_listener`.
pub const LISTENER_START_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(unix)]
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// True when `pid` is confirmed to be a HotSpot JVM: it has an attach listener, a perf-data
/// file of the current user written since it started, or runs an executable named `java`
/// (`-XX:-UsePerfData` JVMs).
pub fn is_hotspot(pid: u32) -> bool {
    #[cfg(unix)]
    {
        signal_target(pid).is_some() && (has_listener(pid) || has_perf_data(pid) || runs_java(pid))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Opens `pid`'s attach listener if it has none, as the JDK's attach API does: a
/// `.attach_pid<pid>` trigger file, then SIGQUIT. Refuses anything `is_hotspot` does not
/// confirm (`NotAJvm`), because SIGQUIT's default action terminates any other process, and a
/// socket that fails the ownership check (`ForeignListener`).
///
/// Blocks for up to `timeout`. A JVM that ignores attach (`-XX:+DisableAttachMechanism`) still
/// handles the SIGQUIT: it prints a thread dump to its own stdout.
pub fn ensure_listener(pid: u32, timeout: Duration) -> Result<(), AttachError> {
    #[cfg(unix)]
    {
        ensure_listener_at(&socket_path(pid), pid, timeout)
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, timeout);
        Err(AttachError::Unsupported)
    }
}

#[cfg(unix)]
fn ensure_listener_at(socket: &Path, pid: u32, timeout: Duration) -> Result<(), AttachError> {
    // `has_listener` reads a socket that fails the trust check as absent; signalling past it
    // would leave its owner answering in the JVM's place.
    match check_socket(socket) {
        Ok(()) => return Ok(()),
        Err(AttachError::NoListener) => {}
        Err(e) => return Err(e),
    }
    let Some(target) = signal_target(pid).filter(|_| is_hotspot(pid)) else {
        return Err(AttachError::NotAJvm);
    };
    let deadline = Instant::now() + timeout;
    let _trigger = Trigger::create(pid)?;
    signal(target, libc::SIGQUIT)?;
    loop {
        if has_listener_at(socket) {
            return Ok(());
        }
        signal(target, 0)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(AttachError::ListenerDidNotStart);
        }
        std::thread::sleep(remaining.min(POLL_INTERVAL));
    }
}

/// `kill` treats 0 and negative pids as process groups, which would signal the IDE itself.
#[cfg(unix)]
fn signal_target(pid: u32) -> Option<libc::pid_t> {
    libc::pid_t::try_from(pid).ok().filter(|p| *p > 0)
}

#[cfg(unix)]
fn signal(pid: libc::pid_t, signal: libc::c_int) -> Result<(), AttachError> {
    // SAFETY: kill has no memory preconditions; `pid` is positive, so only that process is targeted.
    if unsafe { libc::kill(pid, signal) } == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) { Err(AttachError::NoListener) } else { Err(err.into()) }
}

/// `.attach_pid<pid>`, removed on every path out of `ensure_listener`.
#[cfg(unix)]
struct Trigger(PathBuf);

#[cfg(unix)]
impl Trigger {
    fn create(pid: u32) -> Result<Self, AttachError> {
        let name = format!(".attach_pid{pid}");
        // HotSpot looks in its working directory before the temp dir; through /proc that also
        // reaches a JVM in another mount namespace.
        #[cfg(target_os = "linux")]
        let candidates = [PathBuf::from(format!("/proc/{pid}/cwd")).join(&name), temp_dir().join(&name)];
        #[cfg(not(target_os = "linux"))]
        let candidates = [temp_dir().join(&name)];
        let mut failure = None;
        for path in candidates {
            match create_private(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(e) => failure = Some(e),
            }
        }
        Err(failure.expect("at least one candidate").into())
    }
}

#[cfg(unix)]
impl Drop for Trigger {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `create_new` refuses to follow a symlink planted in a shared directory.
#[cfg(unix)]
fn create_private(path: &Path) -> io::Result<()> {
    match OpenOptions::new().write(true).create_new(true).mode(0o600).open(path) {
        Ok(_) => Ok(()),
        // Left by an attempt that died before its cleanup; nobody else's file is adopted.
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists && owned_regular_file(path) => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn owned_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| owned_regular(&meta))
}

#[cfg(unix)]
fn owned_regular(meta: &Metadata) -> bool {
    // SAFETY: geteuid has no preconditions and cannot fail.
    meta.is_file() && meta.uid() == unsafe { libc::geteuid() }
}

/// `<temp>/hsperfdata_<user>/<pid>`, which HotSpot writes unless run with `-XX:-UsePerfData`.
/// Ownership matters outside macOS, where the directory sits in a shared `/tmp`.
#[cfg(unix)]
fn has_perf_data(pid: u32) -> bool {
    let Some(user) = effective_user_name() else { return false };
    let path = temp_dir().join(format!("hsperfdata_{user}")).join(pid.to_string());
    std::fs::symlink_metadata(path).is_ok_and(|meta| {
        owned_regular(&meta) && meta.modified().is_ok_and(|modified| written_since_start(modified, process_start(pid)))
    })
}

/// Absorbs the coarser clock of the start time: Linux knows the boot time only to the second.
#[cfg(unix)]
const START_SLACK: Duration = Duration::from_secs(2);

/// A perf-data file older than the process was left by a JVM that died without removing it
/// (SIGKILL) and whose pid was reused. An unknown start time proves nothing.
#[cfg(unix)]
fn written_since_start(modified: SystemTime, started: Option<SystemTime>) -> bool {
    started.and_then(|start| start.checked_sub(START_SLACK)).is_some_and(|earliest| modified >= earliest)
}

#[cfg(target_os = "macos")]
fn process_start(pid: u32) -> Option<SystemTime> {
    let pid = libc::c_int::try_from(pid).ok()?;
    // SAFETY: proc_bsdinfo is plain data; all-zero is a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is writable for `size` bytes, the most PROC_PIDTBSDINFO writes.
    let written = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    if written != size {
        return None;
    }
    Some(UNIX_EPOCH + Duration::from_secs(info.pbi_start_tvsec) + Duration::from_micros(info.pbi_start_tvusec))
}

#[cfg(target_os = "linux")]
fn process_start(pid: u32) -> Option<SystemTime> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let system = std::fs::read_to_string("/proc/stat").ok()?;
    // SAFETY: sysconf has no preconditions.
    let ticks_per_sec = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    start_from_proc(&stat, &system, u64::try_from(ticks_per_sec).ok().filter(|t| *t > 0)?)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process_start(_pid: u32) -> Option<SystemTime> {
    None
}

/// `/proc/<pid>/stat` field 22 is the start in clock ticks since boot; `btime` in `/proc/stat`
/// is the boot time in seconds since the epoch.
#[cfg(any(target_os = "linux", all(unix, test)))]
fn start_from_proc(stat: &str, system: &str, ticks_per_sec: u64) -> Option<SystemTime> {
    // The command name (field 2) may contain spaces and parentheses; the fields after it start at 3.
    let ticks: u64 = stat.rsplit_once(')')?.1.split_whitespace().nth(22 - 3)?.parse().ok()?;
    let boot: u64 = system.lines().find_map(|line| line.strip_prefix("btime "))?.trim().parse().ok()?;
    let since_boot = Duration::from_millis(ticks.checked_mul(1000)? / ticks_per_sec);
    Some(UNIX_EPOCH + Duration::from_secs(boot) + since_boot)
}

/// HotSpot names the perf-data directory after the effective user's passwd entry.
#[cfg(unix)]
fn effective_user_name() -> Option<String> {
    let mut buf = vec![0 as libc::c_char; 4096];
    // SAFETY: passwd is plain data; all-zero is a valid value.
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer refers to a live local buffer of the stated size.
    let rc = unsafe { libc::getpwuid_r(libc::geteuid(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc != 0 || result.is_null() || pwd.pw_name.is_null() {
        return None;
    }
    // SAFETY: on success `pw_name` is a NUL-terminated string inside `buf`.
    let name = unsafe { std::ffi::CStr::from_ptr(pwd.pw_name) };
    Some(name.to_string_lossy().into_owned())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn runs_java(pid: u32) -> bool {
    crate::jvm::exe_path(pid)
        .is_some_and(|exe| exe.file_name().is_some_and(|name| name == "java") && !crate::jvm::is_openj9(&exe))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn runs_java(_pid: u32) -> bool {
    false
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;

    /// Kills the child even when an assertion fails.
    struct ChildGuard(std::process::Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn spawn_sleep() -> ChildGuard {
        ChildGuard(Command::new("sleep").arg("30").spawn().expect("spawn sleep"))
    }

    #[test]
    fn is_hotspot_false_for_sleep() {
        let _serial = crate::test_serial::hold();
        let sleep = spawn_sleep();
        assert!(!is_hotspot(sleep.0.id()));
    }

    /// `sleep` copied to `<jdk>/bin/java`: confirmed HotSpot by its name alone, unless the
    /// JDK's `release` file says OpenJ9.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn sleep_as_java(release: &str) -> (tempfile::TempDir, ChildGuard) {
        let jdk = tempfile::tempdir().unwrap();
        let java = jdk.path().join("bin/java");
        std::fs::create_dir(java.parent().unwrap()).unwrap();
        let sleep = ["/bin/sleep", "/usr/bin/sleep"].into_iter().find(|p| Path::new(p).exists()).expect("sleep");
        std::fs::copy(sleep, &java).unwrap();
        std::fs::write(jdk.path().join("release"), release).unwrap();
        let child = ChildGuard(Command::new(&java).arg("30").spawn().expect("spawn java"));
        (jdk, child)
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn an_executable_named_java_is_hotspot_unless_its_jdk_is_openj9() {
        let _serial = crate::test_serial::hold();
        let (_jdk, hotspot) = sleep_as_java("IMPLEMENTOR=\"Eclipse Adoptium\"\nJAVA_VERSION=\"21.0.5\"\n");
        assert!(is_hotspot(hotspot.0.id()));
        let (_jdk, openj9) = sleep_as_java("IMPLEMENTOR=\"IBM Corporation\"\nJVM_VARIANT=\"Openj9\"\n");
        let pid = openj9.0.id();
        assert!(!is_hotspot(pid));
        let result = ensure_listener(pid, Duration::from_millis(500));
        assert!(matches!(result, Err(AttachError::NotAJvm)), "{result:?}");
    }

    #[test]
    fn ensure_listener_refuses_a_non_jvm() {
        let _serial = crate::test_serial::hold();
        let sleep = spawn_sleep();
        let pid = sleep.0.id();
        let result = ensure_listener(pid, Duration::from_millis(500));
        assert!(matches!(result, Err(AttachError::NotAJvm)), "{result:?}");
        // SAFETY: signal 0 only checks that the pid exists.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, 0, "the process must still be alive");
    }

    #[test]
    fn foreign_socket_is_refused_without_a_signal() {
        let _serial = crate::test_serial::hold();
        use std::os::unix::{fs::PermissionsExt, net::UnixListener};

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join(".java_pid1");
        let _listener = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o666)).unwrap();
        let sleep = spawn_sleep();
        let pid = sleep.0.id();
        let result = ensure_listener_at(&socket, pid, Duration::from_millis(500));
        assert!(matches!(result, Err(AttachError::ForeignListener)), "{result:?}");
        assert!(!temp_dir().join(format!(".attach_pid{pid}")).exists());
        // SAFETY: signal 0 only checks that the pid exists.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, 0, "the process must still be alive");
    }

    #[test]
    fn perf_data_counts_only_when_written_since_the_process_started() {
        let start = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        assert!(!written_since_start(start - Duration::from_secs(60), Some(start)));
        assert!(!written_since_start(start - Duration::from_secs(3), Some(start)));
        assert!(written_since_start(start - Duration::from_secs(1), Some(start)));
        assert!(written_since_start(start + Duration::from_secs(5), Some(start)));
        assert!(!written_since_start(start + Duration::from_secs(5), None));
    }

    #[test]
    fn our_own_start_time_is_known_and_recent() {
        let start = process_start(std::process::id()).expect("start time of this process");
        let age = SystemTime::now().duration_since(start).expect("started in the past");
        assert!(age < Duration::from_secs(24 * 3600), "{age:?}");
    }

    #[test]
    fn start_time_from_proc_files() {
        let stat = "1234 (my (odd) proc) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 5000 1000 50";
        let system = "cpu  1 2 3
btime 1700000000
processes 9
";
        let start = start_from_proc(stat, system, 100).unwrap();
        assert_eq!(start, UNIX_EPOCH + Duration::from_secs(1_700_000_050));
        assert_eq!(
            start_from_proc(
                stat,
                "cpu 1 2 3
",
                100
            ),
            None
        );
        assert_eq!(start_from_proc("1234 (short) S 1", system, 100), None);
    }

    #[test]
    fn process_group_pids_are_never_signalled() {
        for pid in [0, u32::MAX, i32::MAX as u32 + 1] {
            assert!(!is_hotspot(pid), "{pid}");
            let result = ensure_listener(pid, Duration::from_millis(100));
            assert!(matches!(result, Err(AttachError::NotAJvm)), "{pid}: {result:?}");
        }
    }

    #[test]
    fn trigger_file_is_private_and_removed_on_drop() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".attach_pid1");
        create_private(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        create_private(&path).expect("our own leftover is reused");
        drop(Trigger(path.clone()));
        assert!(!path.exists());
    }

    #[test]
    fn trigger_file_refuses_a_planted_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("elsewhere");
        let path = dir.path().join(".attach_pid1");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(create_private(&path).is_err());
        assert!(!target.exists());
    }
}
