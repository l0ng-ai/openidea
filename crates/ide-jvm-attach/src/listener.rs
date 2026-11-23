use std::time::Duration;

use crate::socket::AttachError;
#[cfg(unix)]
use crate::socket::{has_listener, temp_dir};
#[cfg(unix)]
use std::{
    fs::OpenOptions,
    io,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Instant,
};

/// Budget for `ensure_listener`; an idle JVM opens its listener in about 200 ms.
pub const LISTENER_START_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(unix)]
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// True when `pid` is confirmed to be a HotSpot JVM: it has an attach listener, a perf-data
/// file of the current user, or runs an executable named `java` (`-XX:-UsePerfData` JVMs).
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
/// confirm, because SIGQUIT's default action terminates any other process.
pub fn ensure_listener(pid: u32, timeout: Duration) -> Result<(), AttachError> {
    #[cfg(unix)]
    {
        if has_listener(pid) {
            return Ok(());
        }
        let Some(target) = signal_target(pid).filter(|_| is_hotspot(pid)) else {
            return Err(AttachError::NotAJvm);
        };
        let deadline = Instant::now() + timeout;
        let _trigger = Trigger::create(pid)?;
        signal(target, libc::SIGQUIT)?;
        loop {
            if has_listener(pid) {
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
    #[cfg(not(unix))]
    {
        let _ = (pid, timeout);
        Err(AttachError::Unsupported)
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
    // SAFETY: geteuid has no preconditions and cannot fail.
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && meta.uid() == unsafe { libc::geteuid() })
}

/// `<temp>/hsperfdata_<user>/<pid>`, which HotSpot writes unless run with `-XX:-UsePerfData`.
/// Ownership matters outside macOS, where the directory sits in a shared `/tmp`.
#[cfg(unix)]
fn has_perf_data(pid: u32) -> bool {
    effective_user_name()
        .is_some_and(|user| owned_regular_file(&temp_dir().join(format!("hsperfdata_{user}")).join(pid.to_string())))
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
    crate::jvm::exe_path(pid).is_some_and(|exe| exe.file_name().is_some_and(|name| name == "java"))
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
        let sleep = spawn_sleep();
        assert!(!is_hotspot(sleep.0.id()));
    }

    #[test]
    fn ensure_listener_refuses_a_non_jvm() {
        let sleep = spawn_sleep();
        let pid = sleep.0.id();
        let result = ensure_listener(pid, Duration::from_millis(500));
        assert!(matches!(result, Err(AttachError::NotAJvm)), "{result:?}");
        // SAFETY: signal 0 only checks that the pid exists.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, 0, "the process must still be alive");
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
