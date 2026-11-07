use std::time::Duration;
#[cfg(unix)]
use std::{path::Path, sync::mpsc, thread, time::Instant};

#[cfg(unix)]
use crate::properties::jdwp_port;
#[cfg(unix)]
use crate::socket::{agent_properties_at, has_listener_at, temp_dir};

/// Pid of the local JVM whose JDWP agent listens on `port`, found through the `.java_pid<pid>`
/// sockets of JVMs run by the current user. Returns within `budget` even if a JVM never answers;
/// `per_socket` bounds each individual query.
pub fn find_jvm_by_jdwp_port(port: u16, per_socket: Duration, budget: Duration) -> Option<u32> {
    #[cfg(unix)]
    {
        find_in(&temp_dir(), port, per_socket, budget)
    }
    #[cfg(not(unix))]
    {
        let _ = (port, per_socket, budget);
        None
    }
}

#[cfg(unix)]
fn pid_of_socket_name(name: &str) -> Option<u32> {
    let digits = name.strip_prefix(".java_pid")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

#[cfg(unix)]
pub(crate) fn find_in(dir: &Path, port: u16, per_socket: Duration, budget: Duration) -> Option<u32> {
    let deadline = Instant::now() + budget;
    let (found, results) = mpsc::channel();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(pid_of_socket_name) else { continue };
        let path = entry.path();
        // Same trust checks as a real request: never talk to a socket another user could own.
        if !has_listener_at(&path) {
            continue;
        }
        let found = found.clone();
        // Detached on purpose: a thread stuck on a silent JVM ends by its own `per_socket`
        // deadline and must not hold up the caller.
        let _ = thread::Builder::new().name(format!("jvm-attach-probe-{pid}")).spawn(move || {
            if let Ok(props) = agent_properties_at(&path, per_socket)
                && jdwp_port(&props) == Some(port)
            {
                let _ = found.send(pid);
            }
        });
    }
    drop(found);
    // Timeout and Disconnected (every probe finished without a match) both mean "not found".
    results.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};
    use std::{fs, sync::mpsc::Sender};

    /// Fake JVM: after the request's five NULs, answers with `port` as its JDWP port.
    /// With `None` it accepts and then stays silent until the returned sender fires or drops.
    fn fake_jvm(dir: &Path, name: &str, port: Option<u16>) -> Sender<()> {
        let path = dir.join(name);
        let listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let (release, hold) = mpsc::channel::<()>();
        thread::spawn(move || {
            let Ok((mut conn, _)) = listener.accept() else { return };
            let mut nuls = 0;
            let mut byte = [0u8; 1];
            while nuls < 5 {
                if conn.read_exact(&mut byte).is_err() {
                    return;
                }
                nuls += usize::from(byte[0] == 0);
            }
            match port {
                Some(port) => {
                    let body = format!("0\n#Thu\nsun.jdwp.listenerAddress=dt_socket\\:{port}\nother=1\n");
                    let _ = conn.write_all(body.as_bytes());
                }
                None => {
                    let _ = hold.recv();
                }
            }
        });
        release
    }

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn scan_matches_port_not_first_listener() {
        let dir = tempfile::tempdir().unwrap();
        let _a = fake_jvm(dir.path(), ".java_pid111", Some(5005));
        let _b = fake_jvm(dir.path(), ".java_pid222", Some(6006));
        assert_eq!(find_in(dir.path(), 6006, SECOND, 2 * SECOND), Some(222));
    }

    #[test]
    fn scan_returns_none_when_no_port_matches() {
        let dir = tempfile::tempdir().unwrap();
        let _a = fake_jvm(dir.path(), ".java_pid111", Some(5005));
        assert_eq!(find_in(dir.path(), 6006, SECOND, 2 * SECOND), None);
    }

    #[test]
    fn scan_skips_silent_listener_within_budget() {
        let dir = tempfile::tempdir().unwrap();
        let _silent = fake_jvm(dir.path(), ".java_pid111", None);
        let _b = fake_jvm(dir.path(), ".java_pid222", Some(6006));
        let started = Instant::now();
        assert_eq!(find_in(dir.path(), 6006, SECOND, 2 * SECOND), Some(222));
        assert!(started.elapsed() < Duration::from_millis(2500), "{:?}", started.elapsed());
    }

    #[test]
    fn scan_gives_up_at_the_budget_even_if_a_query_could_run_longer() {
        let dir = tempfile::tempdir().unwrap();
        let _silent = fake_jvm(dir.path(), ".java_pid111", None);
        let started = Instant::now();
        assert_eq!(find_in(dir.path(), 6006, Duration::from_secs(30), Duration::from_millis(500)), None);
        assert!(started.elapsed() < Duration::from_millis(2500), "{:?}", started.elapsed());
    }

    #[test]
    fn scan_ignores_non_matching_names() {
        let dir = tempfile::tempdir().unwrap();
        let _a = fake_jvm(dir.path(), ".java_pidabc", Some(6006));
        let _b = fake_jvm(dir.path(), ".java_pid", Some(6006));
        let _c = fake_jvm(dir.path(), "java_pid12", Some(6006));
        let _d = fake_jvm(dir.path(), ".java_pid12x", Some(6006));
        assert_eq!(find_in(dir.path(), 6006, SECOND, 2 * SECOND), None);
    }

    #[test]
    fn scan_applies_the_socket_trust_checks() {
        let dir = tempfile::tempdir().unwrap();
        let _a = fake_jvm(dir.path(), ".java_pid111", Some(6006));
        fs::set_permissions(dir.path().join(".java_pid111"), fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(find_in(dir.path(), 6006, SECOND, 2 * SECOND), None);
    }

    #[test]
    fn scan_of_a_missing_directory_finds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(find_in(&dir.path().join("gone"), 6006, SECOND, SECOND), None);
    }
}
