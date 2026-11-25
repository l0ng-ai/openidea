//! The devices a Flutter project can run on, from one `flutter daemon` per project window.
//!
//! The daemon speaks JSON-RPC over stdio, one bracketed message per line. After
//! `daemon.connected` it is asked for `device.enable`, which makes it report `device.added` /
//! `device.removed`, and once for `device.getDevices`, whose answer ends the "discovering" state.
//!
//! The daemon keeps running after its stdin closes, so closing the pipe does not end it: on Unix
//! a watcher in its process group ends the group once the IDE is gone, even after a crash. A
//! daemon that fails stays failed until the user restarts it.

mod devtools;

pub use devtools::DevToolsServer;

use ide_android::AndroidDevice;
use ide_core::event::{FlutterDaemonStatus, FlutterDevice, FlutterDeviceList};
use ide_core::process::{kill_tree, own_group, prepare, terminate_tree};
use ide_core::tool_path::{find_command, search_path_in};
use ide_core::{IdeEvent, SharedSink};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

const ENABLE: u64 = 1;
const GET_DEVICES: u64 = 2;
/// How long the daemon gets to exit on `SIGTERM`.
const KILL_GRACE: Duration = Duration::from_millis(200);
/// Lines of unrecognised output kept to explain a failure.
const OUTPUT_TAIL: usize = 8;

#[derive(Debug, PartialEq, Eq)]
enum Message {
    Connected,
    Added(FlutterDevice),
    Removed(String),
    Devices(Vec<FlutterDevice>),
    Other,
}

fn device(value: &Value) -> Option<FlutterDevice> {
    let text = |key| value.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(FlutterDevice {
        id: text("id")?,
        name: text("name")?,
        platform_type: text("platformType"),
        category: text("category"),
        emulator: value.get("emulator").and_then(Value::as_bool).unwrap_or(false),
        unavailable: None,
    })
}

/// The messages of one stdout line; `None` for anything outside the protocol (the tool's own
/// chatter, such as waiting for the startup lock).
fn parse_line(line: &str) -> Option<Vec<Message>> {
    let line = line.trim();
    if !line.starts_with('[') {
        return None;
    }
    let messages: Vec<Value> = serde_json::from_str(line).ok()?;
    Some(messages.iter().map(parse_message).collect())
}

fn parse_message(message: &Value) -> Message {
    let params = message.get("params").unwrap_or(&Value::Null);
    match message.get("event").and_then(Value::as_str) {
        Some("daemon.connected") => Message::Connected,
        Some("device.added") => device(params).map_or(Message::Other, Message::Added),
        Some("device.removed") => {
            params.get("id").and_then(Value::as_str).map_or(Message::Other, |id| Message::Removed(id.to_owned()))
        }
        Some(_) => Message::Other,
        None if message.get("id").and_then(Value::as_u64) == Some(GET_DEVICES) => {
            let result = message.get("result").and_then(Value::as_array);
            Message::Devices(result.into_iter().flatten().filter_map(device).collect())
        }
        None => Message::Other,
    }
}

fn request(id: u64, method: &str) -> String {
    format!("{}\n", json!([{ "id": id, "method": method }]))
}

/// The daemon's devices, plus the Android devices adb sees that Flutter leaves out until they
/// are usable. A daemon Android device's id is its adb serial.
fn merged(daemon: &BTreeMap<String, FlutterDevice>, adb: &[AndroidDevice]) -> Vec<FlutterDevice> {
    let mut devices: Vec<FlutterDevice> = daemon.values().cloned().collect();
    devices.extend(adb.iter().filter(|d| !d.is_online() && !daemon.contains_key(&d.serial)).map(|d| FlutterDevice {
        id: d.serial.clone(),
        name: d.label().replace('_', " "),
        platform_type: Some("android".into()),
        category: Some("mobile".into()),
        emulator: d.serial.starts_with("emulator-"),
        unavailable: Some(d.state.clone()),
    }));
    let rank = |d: &FlutterDevice| match d.category.as_deref() {
        Some("mobile") => 0,
        Some("desktop") => 1,
        Some("web") => 2,
        _ => 3,
    };
    devices.sort_by_cached_key(|d| (d.unavailable.is_some(), rank(d), d.emulator, d.name.to_lowercase(), d.id.clone()));
    devices
}

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
struct State {
    /// Bumped by every start and stop: a reader of an older process no longer has a say.
    generation: u64,
    running: Option<Running>,
    status: FlutterDaemonStatus,
    devices: BTreeMap<String, FlutterDevice>,
    adb: Vec<AndroidDevice>,
}

impl State {
    fn list(&self) -> FlutterDeviceList {
        FlutterDeviceList { status: self.status.clone(), devices: merged(&self.devices, &self.adb) }
    }

    fn shut_down(&mut self) {
        self.generation += 1;
        if let Some(Running { mut child, stdin }) = self.running.take() {
            drop(stdin);
            // Off the caller's thread: closing a window must not wait for the grace period.
            std::thread::spawn(move || terminate_tree(&mut child, KILL_GRACE));
        }
    }
}

struct Shared {
    root: PathBuf,
    sink: SharedSink,
    /// Replaces the lookup on the search path (tests).
    executable: Option<PathBuf>,
    state: Mutex<State>,
}

impl Shared {
    fn emit(&self, list: FlutterDeviceList) {
        self.sink.emit(IdeEvent::FlutterDevices { list });
    }
}

/// One project window's `flutter daemon`, started on first use.
pub struct FlutterDaemon(Arc<Shared>);

impl FlutterDaemon {
    pub fn new(root: PathBuf, sink: SharedSink) -> Self {
        Self::with_executable(root, sink, None)
    }

    fn with_executable(root: PathBuf, sink: SharedSink, executable: Option<PathBuf>) -> Self {
        Self(Arc::new(Shared { root, sink, executable, state: Mutex::default() }))
    }

    /// The current list; starts the daemon unless it already ran. Never blocks on the process.
    pub fn devices(&self) -> FlutterDeviceList {
        let mut state = self.0.state.lock();
        if state.status == FlutterDaemonStatus::Stopped {
            start(&self.0, &mut state);
        }
        state.list()
    }

    /// Replaces the daemon with a new one (the user's way out of a failure).
    pub fn restart(&self) -> FlutterDeviceList {
        let mut state = self.0.state.lock();
        state.shut_down();
        start(&self.0, &mut state);
        state.list()
    }

    /// Reads adb again: a device awaiting authorization changes no daemon event.
    pub fn refresh(&self) {
        let generation = self.0.state.lock().generation;
        refresh_adb(&self.0, generation);
    }

    /// Ends the daemon (project closed, or no longer trusted).
    pub fn stop(&self) {
        let mut state = self.0.state.lock();
        state.shut_down();
        state.status = FlutterDaemonStatus::Stopped;
        state.devices.clear();
        state.adb.clear();
    }

    /// Ends the daemon before returning, for a process about to exit.
    pub fn kill(&self) {
        let mut state = self.0.state.lock();
        state.generation += 1;
        if let Some(mut running) = state.running.take() {
            kill_tree(&mut running.child);
        }
    }
}

fn start(shared: &Arc<Shared>, state: &mut State) {
    state.generation += 1;
    state.status = FlutterDaemonStatus::Starting;
    state.devices.clear();
    state.adb.clear();
    let (shared, generation) = (shared.clone(), state.generation);
    std::thread::spawn(move || run(&shared, generation));
}

fn refresh_adb(shared: &Arc<Shared>, generation: u64) {
    let shared = shared.clone();
    std::thread::spawn(move || {
        // Without adb there is simply nothing to add.
        let adb = ide_android::devices().unwrap_or_default();
        let mut state = shared.state.lock();
        if state.generation != generation || state.adb == adb {
            return;
        }
        state.adb = adb;
        let list = state.list();
        drop(state);
        shared.emit(list);
    });
}

/// A tool that does not end with its stdin, ended with its whole process group when process
/// `parent` is gone.
#[cfg(unix)]
fn watched_command(executable: &Path, args: &[&str], parent: u32) -> Command {
    const WATCHED: &str = r#"(while kill -0 "$1" 2>/dev/null; do sleep 5; done; kill -KILL 0) </dev/null >/dev/null 2>&1 &
shift
exec "$@""#;
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", WATCHED, "sh"]).arg(parent.to_string()).arg(executable).args(args);
    cmd
}

// No watcher on Windows, so a crashed IDE leaves the tool; a Job Object would cover it.
#[cfg(not(unix))]
fn watched_command(executable: &Path, args: &[&str], _parent: u32) -> Command {
    let mut cmd = Command::new(executable);
    cmd.args(args);
    cmd
}

fn spawn_watched(executable: &Path, args: &[&str], root: &Path) -> std::io::Result<Child> {
    let mut cmd = watched_command(executable, args, std::process::id());
    cmd.current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    prepare(own_group(&mut cmd));
    cmd.spawn()
}

/// Sets the final status of a daemon that is gone, unless it was replaced or stopped meanwhile.
fn finish(shared: &Shared, generation: u64, status: FlutterDaemonStatus) {
    let mut state = shared.state.lock();
    if state.generation != generation {
        return;
    }
    let running = state.running.take();
    state.status = status;
    let list = state.list();
    drop(state);
    if let Some(Running { mut child, .. }) = running {
        std::thread::spawn(move || terminate_tree(&mut child, Duration::ZERO));
    }
    shared.emit(list);
}

fn keep_output(tail: &Mutex<VecDeque<String>>, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    let mut tail = tail.lock();
    if tail.len() == OUTPUT_TAIL {
        tail.pop_front();
    }
    tail.push_back(line.trim_end().to_owned());
}

fn read_lines(pipe: impl Read, mut on_line: impl FnMut(&str) -> bool) {
    let mut reader = BufReader::new(pipe);
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) | Err(_) => return,
            Ok(_) if !on_line(&String::from_utf8_lossy(&bytes)) => return,
            Ok(_) => {}
        }
    }
}

/// One daemon's whole life, on its own thread.
fn run(shared: &Arc<Shared>, generation: u64) {
    let executable =
        shared.executable.clone().or_else(|| find_command("flutter", &search_path_in(&shared.root), &shared.root));
    let Some(executable) = executable else {
        return finish(shared, generation, FlutterDaemonStatus::NotInstalled);
    };
    let mut child = match spawn_watched(&executable, &["daemon"], &shared.root) {
        Ok(child) => child,
        Err(e) => {
            let message = format!("could not run {}: {e}", executable.display());
            return finish(shared, generation, FlutterDaemonStatus::Failed { message });
        }
    };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return finish(shared, generation, FlutterDaemonStatus::Failed { message: "no output pipe".into() });
    };
    let stdin = child.stdin.take();
    {
        let mut state = shared.state.lock();
        if state.generation != generation {
            drop(state);
            drop(stdin);
            terminate_tree(&mut child, KILL_GRACE);
            return;
        }
        state.running = Some(Running { child, stdin });
    }
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    let errors = {
        let tail = tail.clone();
        std::thread::spawn(move || {
            read_lines(stderr, |line| {
                keep_output(&tail, line);
                true
            });
        })
    };
    read_lines(stdout, |line| match parse_line(line) {
        Some(messages) => messages.into_iter().all(|message| handle(shared, generation, message)),
        None => {
            keep_output(&tail, line);
            true
        }
    });
    let _ = errors.join();
    let message = Vec::from(std::mem::take(&mut *tail.lock())).join("\n");
    let message = if message.is_empty() { "flutter daemon exited".to_owned() } else { message };
    finish(shared, generation, FlutterDaemonStatus::Failed { message });
}

/// Applies one message; false once this daemon has been replaced or stopped.
fn handle(shared: &Arc<Shared>, generation: u64, message: Message) -> bool {
    let mut state = shared.state.lock();
    if state.generation != generation {
        return false;
    }
    match message {
        Message::Other => return true,
        Message::Connected => {
            if let Some(stdin) = state.running.as_mut().and_then(|r| r.stdin.as_mut()) {
                let requests = request(ENABLE, "device.enable") + &request(GET_DEVICES, "device.getDevices");
                let _ = stdin.write_all(requests.as_bytes()).and_then(|()| stdin.flush());
            }
            return true;
        }
        Message::Added(device) => {
            state.devices.insert(device.id.clone(), device);
        }
        Message::Removed(id) => {
            state.devices.remove(&id);
        }
        // Merged, not replaced: events may have overtaken this answer.
        Message::Devices(devices) => {
            state.devices.extend(devices.into_iter().map(|d| (d.id.clone(), d)));
            state.status = FlutterDaemonStatus::Ready;
        }
    }
    let list = state.list();
    drop(state);
    shared.emit(list);
    refresh_adb(shared, generation);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(id: &str, name: &str, category: &str, emulator: bool) -> FlutterDevice {
        FlutterDevice {
            id: id.into(),
            name: name.into(),
            platform_type: None,
            category: Some(category.into()),
            emulator,
            unavailable: None,
        }
    }

    fn adb(serial: &str, state: &str) -> AndroidDevice {
        AndroidDevice {
            serial: serial.into(),
            state: state.into(),
            model: None,
            product: None,
            device: None,
            transport_id: None,
        }
    }

    #[test]
    fn reads_the_daemon_protocol() {
        assert_eq!(
            parse_line(r#"[{"event":"daemon.connected","params":{"version":"0.6.1","pid":7}}]"#),
            Some(vec![Message::Connected])
        );
        let added = parse_line(
            r#"[{"event":"device.added","params":{"id":"emulator-5554","name":"Pixel","platform":"android-arm64",
                "emulator":true,"category":"mobile","platformType":"android","ephemeral":true}}]"#
                .replace('\n', " ")
                .as_str(),
        );
        let Some([Message::Added(device)]) = added.as_deref() else { panic!("{added:?}") };
        assert_eq!(device.id, "emulator-5554");
        assert_eq!(device.platform_type.as_deref(), Some("android"));
        assert!(device.emulator);
        assert_eq!(
            parse_line(r#"[{"event":"device.removed","params":{"id":"macos","name":"macOS"}}]"#),
            Some(vec![Message::Removed("macos".into())])
        );
        let answer = parse_line(r#"[{"id":2,"result":[{"id":"chrome","name":"Chrome","category":null}]}]"#);
        let Some([Message::Devices(devices)]) = answer.as_deref() else { panic!("{answer:?}") };
        assert_eq!((devices[0].id.as_str(), devices[0].category.as_deref()), ("chrome", None));
        assert_eq!(parse_line(r#"[{"id":1,"result":null}]"#), Some(vec![Message::Other]));
    }

    #[test]
    fn output_outside_the_protocol_is_not_a_message() {
        assert_eq!(parse_line("Waiting for another flutter command to release the startup lock..."), None);
        assert_eq!(parse_line("[not json"), None);
    }

    #[test]
    fn lists_usable_devices_first_and_adds_what_only_adb_sees() {
        let daemon: BTreeMap<_, _> = [
            dev("chrome", "Chrome", "web", false),
            dev("macos", "macOS", "desktop", false),
            dev("emulator-5554", "Pixel", "mobile", true),
            dev("R5C", "Galaxy", "mobile", false),
        ]
        .into_iter()
        .map(|d| (d.id.clone(), d))
        .collect();
        let adb = [adb("R5C", "device"), adb("emulator-5554", "offline"), adb("X1", "unauthorized")];
        let list = merged(&daemon, &adb);
        let ids: Vec<_> = list.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, ["R5C", "emulator-5554", "macos", "chrome", "X1"]);
        assert_eq!(list[4].unavailable.as_deref(), Some("unauthorized"));
        assert_eq!(list[1].unavailable, None, "what the daemon lists is usable");
    }

    #[cfg(unix)]
    mod process {
        use super::super::*;
        use ide_core::EventSink;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;

        #[derive(Default)]
        struct Lists(Mutex<Vec<FlutterDeviceList>>);

        impl EventSink for Lists {
            fn emit(&self, event: IdeEvent) {
                if let IdeEvent::FlutterDevices { list } = event {
                    self.0.lock().push(list);
                }
            }
        }

        fn daemon(dir: &Path, script: &str) -> (FlutterDaemon, Arc<Lists>) {
            let path = dir.join("flutter");
            std::fs::write(&path, format!("#!/bin/sh\n{script}")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            let lists = Arc::new(Lists::default());
            (FlutterDaemon::with_executable(dir.to_owned(), lists.clone(), Some(path)), lists)
        }

        fn wait_for(what: &str, done: impl Fn() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(Instant::now() < deadline, "timed out waiting for {what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        const SESSION: &str = r#"
echo $$ > pid
echo 'Waiting for another flutter command to release the startup lock...'
echo '[{"event":"daemon.connected","params":{"version":"0.6.1","pid":1}}]'
read enable; read get; echo "$enable$get" > requests
echo '[{"id":1,"result":null}]'
echo '[{"id":2,"result":[{"id":"macos","name":"macOS","category":"desktop","emulator":false}]}]'
echo '[{"event":"device.added","params":{"id":"chrome","name":"Chrome","category":"web","emulator":false}}]'
echo '[{"event":"device.removed","params":{"id":"macos","name":"macOS"}}]'
cat > /dev/null
"#;

        #[test]
        fn follows_devices_and_ends_with_the_project() {
            let dir = tempfile::tempdir().unwrap();
            let (daemon, lists) = daemon(dir.path(), SESSION);
            assert_eq!(daemon.devices().status, FlutterDaemonStatus::Starting);
            wait_for("the removal", || {
                let list = daemon.devices();
                list.status == FlutterDaemonStatus::Ready
                    && list.devices.iter().map(|d| d.id.as_str()).collect::<Vec<_>>() == ["chrome"]
            });
            let requests = std::fs::read_to_string(dir.path().join("requests")).unwrap();
            assert!(requests.contains("device.enable") && requests.contains("device.getDevices"), "{requests}");
            assert!(lists.0.lock().iter().any(|l| l.devices.iter().any(|d| d.id == "macos")));

            let pid = std::fs::read_to_string(dir.path().join("pid")).unwrap();
            let alive =
                || Command::new("kill").args(["-0", pid.trim()]).stderr(Stdio::null()).status().unwrap().success();
            assert!(alive());
            daemon.stop();
            wait_for("the process to end", || !alive());
            assert_eq!(daemon.0.state.lock().status, FlutterDaemonStatus::Stopped);
        }

        #[test]
        fn the_daemon_does_not_outlive_the_ide() {
            let dir = tempfile::tempdir().unwrap();
            let flutter = dir.path().join("flutter");
            std::fs::write(&flutter, "#!/bin/sh\necho $$ > pid\nexec sleep 60\n").unwrap();
            std::fs::set_permissions(&flutter, std::fs::Permissions::from_mode(0o755)).unwrap();
            let mut ide = Command::new("sleep").arg("60").spawn().unwrap();
            let mut cmd = watched_command(&flutter, &["daemon"], ide.id());
            cmd.current_dir(dir.path()).stdin(Stdio::piped());
            let mut daemon = own_group(&mut cmd).spawn().unwrap();
            wait_for("the daemon", || dir.path().join("pid").is_file());
            assert_eq!(daemon.try_wait().unwrap(), None);
            ide.kill().unwrap();
            ide.wait().unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while daemon.try_wait().unwrap().is_none() {
                assert!(Instant::now() < deadline, "the daemon outlived its parent");
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        #[test]
        fn a_crash_is_reported_and_not_restarted_until_asked() {
            let dir = tempfile::tempdir().unwrap();
            let (daemon, _lists) = daemon(dir.path(), "echo run >> runs\necho 'SDK is broken' >&2\nexit 3\n");
            daemon.devices();
            let failed = || matches!(daemon.0.state.lock().status, FlutterDaemonStatus::Failed { .. });
            wait_for("the failure", failed);
            let FlutterDaemonStatus::Failed { message } = daemon.devices().status else { panic!("still failed") };
            assert_eq!(message, "SDK is broken");
            std::thread::sleep(Duration::from_millis(100));
            let runs = || std::fs::read_to_string(dir.path().join("runs")).unwrap().lines().count();
            assert_eq!(runs(), 1);
            daemon.restart();
            wait_for("the second run", || runs() == 2);
        }
    }
}
