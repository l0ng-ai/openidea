//! One `dart devtools` server per project window. In `--machine` mode it reports its port as a
//! `server.started` line on stdout.

use crate::flutter_executable;
use crate::server::{Line, Spec, ToolServer};
use ide_core::tool_path::{find_command, search_path_in};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The address embedded pages are allowed to come from, so never `localhost`.
pub(crate) const HOST: &str = "127.0.0.1";
const ARGS: [&str; 7] = ["devtools", "--machine", "--allow-embedding", "--host", HOST, "--port", "0"];

pub(crate) static DEVTOOLS: Spec = Spec {
    name: "Flutter DevTools",
    args: &ARGS,
    timeout: Duration::from_secs(60),
    executable: dart_executable,
    not_found: "Dart SDK not found: install Flutter or add it to PATH",
    line,
    failed: |message| if message.is_empty() { "dart devtools exited".into() } else { message },
};

impl ToolServer {
    /// `dart` is the configured one, else the one of the `flutter` on the search path.
    pub fn devtools(root: PathBuf, dart: crate::Configured) -> Self {
        Self::new(root, &DEVTOOLS, dart)
    }
}

fn started_port(line: &str) -> Option<u16> {
    let message: Value = serde_json::from_str(line.trim()).ok()?;
    if message.get("event")?.as_str()? != "server.started" {
        return None;
    }
    u16::try_from(message.get("params")?.get("port")?.as_u64()?).ok()
}

fn line(line: &str) -> Line {
    match started_port(line) {
        Some(port) => Line::Url(format!("http://{HOST}:{port}")),
        None => Line::Output(line.to_owned()),
    }
}

/// The `dart` of the SDK `flutter` belongs to, so that DevTools matches the debugged app.
fn dart_executable(root: &Path) -> Option<PathBuf> {
    flutter_executable(root)
        .and_then(|flutter| {
            // On the search path `flutter` is often a link into the SDK.
            let flutter = if cfg!(unix) { std::fs::canonicalize(&flutter).unwrap_or(flutter) } else { flutter };
            let dart = flutter.with_file_name(if cfg!(windows) { "dart.bat" } else { "dart" });
            dart.is_file().then_some(dart)
        })
        .or_else(|| find_command("dart", &search_path_in(root), root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_server_started_gives_a_port() {
        let line =
            r#"{"event":"server.started","method":"server.started","params":{"host":"127.0.0.1","port":9100,"pid":1}}"#;
        assert_eq!(started_port(line), Some(9100));
        assert_eq!(started_port(r#"{"event":"server.dtdStarted","params":{"uri":"ws://x"}}"#), None);
        assert_eq!(started_port("Serving DevTools"), None);
    }

    #[cfg(unix)]
    mod process {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;

        const STARTED: &str = r#"echo '{"event":"server.started","params":{"port":4242}}'"#;

        fn server(dir: &Path, script: &str, timeout: Duration) -> ToolServer {
            let path = dir.join("dart");
            std::fs::write(&path, format!("#!/bin/sh\necho run >> runs\n{script}")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            ToolServer::with_executable(dir.to_owned(), &DEVTOOLS, Box::new(move || Some(path.clone())), timeout)
        }

        fn runs(dir: &Path) -> usize {
            std::fs::read_to_string(dir.join("runs")).map_or(0, |s| s.lines().count())
        }

        fn wait_for(what: &str, done: impl Fn() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(Instant::now() < deadline, "timed out waiting for {what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        #[test]
        fn a_running_server_is_shared_and_stop_ends_it() {
            let dir = tempfile::tempdir().unwrap();
            let script = format!("echo \"$*\" > args\necho $$ > pid\n{STARTED}\nexec sleep 30");
            let devtools = server(dir.path(), &script, Duration::from_secs(10));
            assert_eq!(devtools.url(&[]).unwrap(), "http://127.0.0.1:4242");
            assert_eq!(devtools.url(&[]).unwrap(), "http://127.0.0.1:4242");
            assert_eq!(runs(dir.path()), 1);
            let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
            assert_eq!(args.trim(), ARGS.join(" "));

            let pid = std::fs::read_to_string(dir.path().join("pid")).unwrap();
            devtools.stop();
            let alive = || {
                let mut probe = std::process::Command::new("kill");
                probe.args(["-0", pid.trim()]).stderr(std::process::Stdio::null()).status().unwrap().success()
            };
            wait_for("the server to end", || !alive());
        }

        #[test]
        fn a_failure_is_reported_and_only_a_new_request_retries() {
            let dir = tempfile::tempdir().unwrap();
            let devtools = server(dir.path(), "echo boom >&2\nexit 3", Duration::from_secs(10));
            assert_eq!(devtools.url(&[]).unwrap_err(), "boom");
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(runs(dir.path()), 1);
            assert_eq!(devtools.url(&[]).unwrap_err(), "boom");
            assert_eq!(runs(dir.path()), 2);
        }

        #[test]
        fn a_server_that_exits_is_not_restarted_until_asked() {
            let dir = tempfile::tempdir().unwrap();
            let devtools = server(dir.path(), STARTED, Duration::from_secs(10));
            devtools.url(&[]).unwrap();
            wait_for("the exit to be noticed", || devtools.is_stopped());
            assert_eq!(runs(dir.path()), 1);
            devtools.url(&[]).unwrap();
            assert_eq!(runs(dir.path()), 2);
        }

        #[test]
        fn a_server_that_never_reports_times_out() {
            let dir = tempfile::tempdir().unwrap();
            let devtools = server(dir.path(), "exec sleep 30", Duration::from_millis(200));
            assert_eq!(devtools.url(&[]).unwrap_err(), "Flutter DevTools did not start in time");
        }
    }
}
