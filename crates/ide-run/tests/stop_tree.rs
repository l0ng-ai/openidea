//! Stopping a run on Windows ends the whole launched tree: the kernel job over the
//! launch reaches what a launcher started even when the launcher exited first (where a
//! `taskkill /T /F` from the tracked pid no longer finds the orphan), and the run only
//! reports its exit once the port the tree held is free again.
#![cfg(windows)]

use ide_core::{IdeEvent, RunId, SharedSink};
use ide_run::{OutputChunk, ProcessManager, RunConfig, StartOptions};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

static CONSOLE: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn channel_sink() -> (SharedSink, Receiver<IdeEvent>) {
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink: SharedSink = Arc::new(move |e: IdeEvent| {
        let _ = tx.lock().send(e);
    });
    (sink, events)
}

fn capture_output() -> Box<dyn Fn(OutputChunk) + Send + Sync> {
    Box::new(move |chunk: OutputChunk| {
        let text = match &chunk {
            OutputChunk::Stdout { text } | OutputChunk::Stderr { text } | OutputChunk::System { text } => text,
        };
        CONSOLE.lock().push(text.clone());
    })
}

fn console_log() -> String {
    CONSOLE.lock().join("")
}

fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}; console:\n{}", console_log());
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn wait_exit(events: &Receiver<IdeEvent>, id: RunId, timeout: Duration) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(left).expect("RunExited event") {
            IdeEvent::RunExited { run, code } if run == id => return code,
            _ => {}
        }
    }
}

/// A program that binds a port and holds it, like a Spring Boot JVM: the `mvn`-starts-a-JVM
/// shape. PowerShell is the one interpreter every Windows runner has.
fn port_holder(dir: &std::path::Path) -> String {
    let script = dir.join("hold-port.ps1");
    std::fs::write(
        &script,
        "$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)\n\
         $l.Start()\n\
         Set-Content -Path $args[0] -Value $l.LocalEndpoint.Port\n\
         Start-Sleep -Seconds 300\n",
    )
    .unwrap();
    let port_file = dir.join("port");
    // Unquoted exe: under `start /B` a quoted first token would be the window title, and
    // the path has no spaces anyway.
    format!(
        "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy \
         Bypass -File \"{}\" \"{}\"",
        script.display(),
        port_file.display()
    )
}

fn config(line: &str) -> RunConfig {
    RunConfig {
        id: "boot".into(),
        name: "boot".into(),
        kind: "shell".into(),
        // A shell line, as a run configuration holds one: it runs through `cmd /D /S /C`,
        // which parses the line itself (the CRT quoting of separate args would mangle it).
        command: line.to_owned(),
        args: Vec::new(),
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    }
}

fn holder_port(dir: &std::path::Path) -> u16 {
    // The file appears as soon as the holder creates it, before the port is written and
    // the handle closed: on a loaded machine (defender, indexer) the first reads can hit
    // a sharing violation or a partial write, so keep reading until it parses.
    let mut port = None;
    wait_for("the holder's port", || {
        port = std::fs::read_to_string(dir.join("port")).ok().and_then(|s| s.trim().parse().ok());
        port.is_some()
    });
    port.unwrap()
}

#[test]
fn a_stop_reaches_the_tree_a_dead_launcher_left_behind() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = channel_sink();
    let pm = ProcessManager::new();
    let holder = port_holder(tmp.path());
    // `start /B` detaches the holder from cmd's lifetime: cmd exits at once, the holder
    // keeps its port, and the run reports its exit while the port is still taken.
    let line = format!("start /B {}", holder);
    let info = pm.start(tmp.path(), &config(&line), &StartOptions::default(), sink, capture_output()).expect("start");
    let port = holder_port(tmp.path());

    // The launcher exited on its own; the run is over, but the holder it started lives.
    let code = wait_exit(&events, info.id, Duration::from_secs(30));
    assert_eq!(code, Some(0), "cmd exited by itself; console:\n{}", console_log());

    // Stop must still reach what it started: this is the reported bug, a port the next
    // start cannot bind because the launcher's orphan holds it.
    pm.stop(info.id).unwrap();
    wait_for("the holder's port to be free", || TcpListener::bind(("127.0.0.1", port)).is_ok());
}

#[test]
fn a_stop_kills_a_launch_whose_launcher_is_still_up() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = channel_sink();
    let pm = ProcessManager::new();
    let holder = port_holder(tmp.path());
    let info = pm.start(tmp.path(), &config(&holder), &StartOptions::default(), sink, capture_output()).expect("start");
    let port = holder_port(tmp.path());

    pm.stop(info.id).unwrap();
    // The run is only finished once the tree is gone, so the port is free by the time the
    // console reports the exit and the next start can bind it.
    let code = wait_exit(&events, info.id, Duration::from_secs(30));
    assert_eq!(code, Some(1), "the job's termination exit code; console:\n{}", console_log());
    wait_for("the holder's port to be free", || TcpListener::bind(("127.0.0.1", port)).is_ok());
}

/// The reported shape itself: `cmd` starting a JVM that holds its port (a Spring Boot run
/// or debug launch). Runs where a JDK is installed (CI's Windows runners have one).
#[test]
fn a_stop_kills_the_jvm_a_launcher_started() {
    let Some(javac) = which_javac() else {
        eprintln!("skipped: no javac on this machine");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("HoldPort.java"),
        "import java.net.ServerSocket;\n\
         public class HoldPort {\n\
             public static void main(String[] args) throws Exception {\n\
                 ServerSocket server = new ServerSocket(Integer.parseInt(args[0]), 1, java.net.InetAddress.getByName(\"127.0.0.1\"));\n\
                 System.out.println(\"listening\");\n\
                 System.out.flush();\n\
                 Thread.sleep(Long.MAX_VALUE);\n\
             }\n\
         }\n",
    )
    .unwrap();
    let status = std::process::Command::new(javac)
        .args(["-d", &tmp.path().display().to_string(), &tmp.path().join("HoldPort.java").display().to_string()])
        .stdout(std::process::Stdio::null())
        .status()
        .expect("javac runs");
    assert!(status.success(), "the holder compiles; console:\n{}", console_log());

    // A free port chosen by this process, handed to the JVM.
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    let (sink, events) = channel_sink();
    let pm = ProcessManager::new();
    let line = format!("java -cp \"{}\" HoldPort {port}", tmp.path().display());
    let info = pm.start(tmp.path(), &config(&line), &StartOptions::default(), sink, capture_output()).expect("start");
    // The JVM is cmd's child and announces itself on the run's console.
    wait_for("the JVM to listen", || std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());

    pm.stop(info.id).unwrap();
    wait_exit(&events, info.id, Duration::from_secs(30));
    wait_for("the JVM's port to be free", || TcpListener::bind(("127.0.0.1", port)).is_ok());
}

/// `javac` as the run would resolve it: on the process's PATH.
fn which_javac() -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    ide_run::which::find_executable("javac", &path)
}
