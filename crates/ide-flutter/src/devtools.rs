//! One `dart devtools` server per project window, started when first asked for. In `--machine`
//! mode it reports its port as a `server.started` line on stdout. A server that fails or exits
//! is not restarted on its own: the next request starts a new one.

use crate::{KILL_GRACE, OUTPUT_TAIL, keep_output, read_lines, spawn_watched};
use ide_core::process::{kill_tree, terminate_tree};
use ide_core::tool_path::{find_command, search_path_in};
use parking_lot::{Condvar, Mutex};
use serde_json::Value;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Arc;
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(60);
/// The address embedded pages are allowed to come from, so never `localhost`.
const HOST: &str = "127.0.0.1";
const ARGS: [&str; 7] = ["devtools", "--machine", "--allow-embedding", "--host", HOST, "--port", "0"];

fn started_port(line: &str) -> Option<u16> {
    let message: Value = serde_json::from_str(line.trim()).ok()?;
    if message.get("event")?.as_str()? != "server.started" {
        return None;
    }
    u16::try_from(message.get("params")?.get("port")?.as_u64()?).ok()
}

/// The `dart` of the SDK `flutter` belongs to, so that DevTools matches the debugged app.
fn dart_executable(root: &Path) -> Option<PathBuf> {
    let path = search_path_in(root);
    find_command("flutter", &path, root)
        .and_then(|flutter| {
            // On the search path `flutter` is often a link into the SDK.
            let flutter = if cfg!(unix) { std::fs::canonicalize(&flutter).unwrap_or(flutter) } else { flutter };
            let dart = flutter.with_file_name(if cfg!(windows) { "dart.bat" } else { "dart" });
            dart.is_file().then_some(dart)
        })
        .or_else(|| find_command("dart", &path, root))
}

#[derive(Default)]
enum Status {
    #[default]
    Stopped,
    Starting,
    Ready(String),
    Failed(String),
}

#[derive(Default)]
struct State {
    /// Bumped by every start and stop: a reader of an older process no longer has a say.
    generation: u64,
    child: Option<Child>,
    status: Status,
}

impl State {
    fn shut_down(&mut self) {
        self.generation += 1;
        if let Some(mut child) = self.child.take() {
            std::thread::spawn(move || terminate_tree(&mut child, KILL_GRACE));
        }
    }
}

struct Shared {
    root: PathBuf,
    /// Replaces the lookup on the search path (tests).
    executable: Option<PathBuf>,
    timeout: Duration,
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    /// Applies `status` unless this process was replaced or stopped; false if it was.
    fn set(&self, generation: u64, status: Status) -> bool {
        let mut state = self.state.lock();
        if state.generation != generation {
            return false;
        }
        state.status = status;
        self.changed.notify_all();
        true
    }
}

pub struct DevToolsServer(Arc<Shared>);

impl DevToolsServer {
    pub fn new(root: PathBuf) -> Self {
        Self::with_executable(root, None, START_TIMEOUT)
    }

    fn with_executable(root: PathBuf, executable: Option<PathBuf>, timeout: Duration) -> Self {
        Self(Arc::new(Shared { root, executable, timeout, state: Mutex::default(), changed: Condvar::new() }))
    }

    /// The server's address, starting it if none runs. Blocks until it is known.
    pub fn url(&self) -> Result<String, String> {
        let shared = &self.0;
        let deadline = Instant::now() + shared.timeout;
        let mut state = shared.state.lock();
        if matches!(state.status, Status::Stopped | Status::Failed(_)) {
            state.generation += 1;
            state.status = Status::Starting;
            let (shared, generation) = (shared.clone(), state.generation);
            std::thread::spawn(move || run(&shared, generation));
        }
        loop {
            match &state.status {
                Status::Ready(url) => return Ok(url.clone()),
                Status::Failed(message) => return Err(message.clone()),
                Status::Stopped => return Err("Flutter DevTools was stopped".into()),
                Status::Starting => {}
            }
            if shared.changed.wait_until(&mut state, deadline).timed_out() {
                state.shut_down();
                let message = "Flutter DevTools did not start in time".to_owned();
                state.status = Status::Failed(message.clone());
                shared.changed.notify_all();
                return Err(message);
            }
        }
    }

    /// Ends the server (project closed, or no longer trusted).
    pub fn stop(&self) {
        let mut state = self.0.state.lock();
        state.shut_down();
        state.status = Status::Stopped;
        self.0.changed.notify_all();
    }

    /// Ends the server before returning, for a process about to exit.
    pub fn kill(&self) {
        let mut state = self.0.state.lock();
        state.generation += 1;
        state.status = Status::Stopped;
        if let Some(mut child) = state.child.take() {
            kill_tree(&mut child);
        }
        self.0.changed.notify_all();
    }
}

/// One server's whole life, on its own thread.
fn run(shared: &Arc<Shared>, generation: u64) {
    let fail = |message: String| {
        shared.set(generation, Status::Failed(message));
    };
    let Some(executable) = shared.executable.clone().or_else(|| dart_executable(&shared.root)) else {
        return fail("Dart SDK not found: install Flutter or add it to PATH".into());
    };
    let mut child = match spawn_watched(&executable, &ARGS, &shared.root) {
        Ok(child) => child,
        Err(e) => return fail(format!("could not run {}: {e}", executable.display())),
    };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        terminate_tree(&mut child, Duration::ZERO);
        return fail("no output pipe".into());
    };
    {
        let mut state = shared.state.lock();
        if state.generation != generation {
            drop(state);
            terminate_tree(&mut child, KILL_GRACE);
            return;
        }
        state.child = Some(child);
    }
    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(OUTPUT_TAIL)));
    let errors = {
        let tail = tail.clone();
        std::thread::spawn(move || {
            read_lines(stderr, |line| {
                keep_output(&tail, line);
                true
            });
        })
    };
    read_lines(stdout, |line| match started_port(line) {
        Some(port) => shared.set(generation, Status::Ready(format!("http://{HOST}:{port}"))),
        None => {
            keep_output(&tail, line);
            true
        }
    });
    let _ = errors.join();

    let mut state = shared.state.lock();
    if state.generation != generation {
        return;
    }
    let child = state.child.take();
    state.status = if matches!(state.status, Status::Ready(_)) {
        Status::Stopped
    } else {
        let message = Vec::from(std::mem::take(&mut *tail.lock())).join("\n");
        Status::Failed(if message.is_empty() { "dart devtools exited".into() } else { message })
    };
    shared.changed.notify_all();
    drop(state);
    if let Some(mut child) = child {
        std::thread::spawn(move || terminate_tree(&mut child, Duration::ZERO));
    }
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

        const STARTED: &str = r#"echo '{"event":"server.started","params":{"port":4242}}'"#;

        fn server(dir: &Path, script: &str, timeout: Duration) -> DevToolsServer {
            let path = dir.join("dart");
            std::fs::write(&path, format!("#!/bin/sh\necho run >> runs\n{script}")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            DevToolsServer::with_executable(dir.to_owned(), Some(path), timeout)
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
            assert_eq!(devtools.url().unwrap(), "http://127.0.0.1:4242");
            assert_eq!(devtools.url().unwrap(), "http://127.0.0.1:4242");
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
            assert_eq!(devtools.url().unwrap_err(), "boom");
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(runs(dir.path()), 1);
            assert_eq!(devtools.url().unwrap_err(), "boom");
            assert_eq!(runs(dir.path()), 2);
        }

        #[test]
        fn a_server_that_exits_is_not_restarted_until_asked() {
            let dir = tempfile::tempdir().unwrap();
            let devtools = server(dir.path(), STARTED, Duration::from_secs(10));
            devtools.url().unwrap();
            wait_for("the exit to be noticed", || matches!(devtools.0.state.lock().status, Status::Stopped));
            assert_eq!(runs(dir.path()), 1);
            devtools.url().unwrap();
            assert_eq!(runs(dir.path()), 2);
        }

        #[test]
        fn a_server_that_never_reports_times_out() {
            let dir = tempfile::tempdir().unwrap();
            let devtools = server(dir.path(), "exec sleep 30", Duration::from_millis(200));
            assert_eq!(devtools.url().unwrap_err(), "Flutter DevTools did not start in time");
        }
    }
}
