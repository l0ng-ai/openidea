//! A stopped run reports its exit only once the whole process group is gone, so the next
//! start cannot meet a port the previous process still holds.
#![cfg(unix)]

use ide_core::{IdeEvent, RunId, SharedSink};
use ide_run::{ProcessManager, RunConfig, StartOptions};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

fn channel_sink() -> (SharedSink, Receiver<IdeEvent>) {
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink: SharedSink = Arc::new(move |e: IdeEvent| {
        let _ = tx.lock().send(e);
    });
    (sink, events)
}

fn wait_exit(events: &Receiver<IdeEvent>, id: RunId, timeout: Duration) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(left) {
            Ok(IdeEvent::RunExited { run, code }) if run == id => return code,
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

#[test]
fn a_stopped_run_keeps_its_port_until_the_group_is_gone() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = channel_sink();
    let pm = ProcessManager::new();
    // The `mvn`-starts-a-JVM shape: the direct child dies on SIGINT while the process it
    // started ignores it and keeps its socket open for a moment.
    let script = tmp.path().join("hold.py");
    std::fs::write(
        &script,
        "import signal, socket, sys, time\n\
         signal.signal(signal.SIGINT, signal.SIG_IGN)\n\
         s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen()\n\
         open(sys.argv[1], 'w').write(str(s.getsockname()[1]))\n\
         time.sleep(2)\n",
    )
    .unwrap();
    let port_file = tmp.path().join("port");
    let config = RunConfig {
        id: "boot".into(),
        name: "boot".into(),
        kind: "shell".into(),
        command: "/bin/sh".into(),
        args: vec!["-c".into(), format!("python3 {} {} & sleep 60", script.display(), port_file.display())],
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let info = pm.start(tmp.path(), &config, &StartOptions::default(), sink, Box::new(|_| {})).expect("start");
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::fs::read_to_string(&port_file).is_err() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let port: u16 = std::fs::read_to_string(&port_file).expect("port").trim().parse().unwrap();

    let stopped = Instant::now();
    pm.stop(info.id).unwrap();
    let code = wait_exit(&events, info.id, Duration::from_secs(20));
    let elapsed = stopped.elapsed();
    assert!(code.is_some(), "the run reports its exit");
    assert!(elapsed >= Duration::from_millis(1500), "exit came {elapsed:?} after Stop, before the port was free");
    assert!(
        std::net::TcpStream::connect(("127.0.0.1", port)).is_err(),
        "the port is still bound when the run reports finished"
    );
}

#[test]
fn a_first_stop_does_not_kill_a_program_that_is_still_shutting_down() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = channel_sink();
    let pm = ProcessManager::new();
    // Ignores SIGINT, then exits by itself after 2 s, like a slow Spring Boot shutdown: a first
    // Stop waits for it instead of killing it (exit code 137).
    let script = tmp.path().join("slow.py");
    std::fs::write(
        &script,
        "import signal, sys, time\n\
         signal.signal(signal.SIGINT, signal.SIG_IGN)\n\
         print('ready', flush=True)\n\
         time.sleep(2)\n",
    )
    .unwrap();
    let config = RunConfig {
        id: "slow".into(),
        name: "slow".into(),
        kind: "shell".into(),
        command: "python3".into(),
        args: vec![script.display().to_string()],
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let info = pm.start(tmp.path(), &config, &StartOptions::default(), sink, Box::new(|_| {})).expect("start");
    std::thread::sleep(Duration::from_millis(500)); // let the program install its handler
    let start = Instant::now();
    pm.stop(info.id).unwrap();
    let code = wait_exit(&events, info.id, Duration::from_secs(10));
    assert_eq!(code, Some(0), "the program exited by itself, not by SIGKILL");
    assert!(start.elapsed() >= Duration::from_millis(1500), "stop waited for the shutdown, not a timer");
}

#[test]
fn a_second_stop_kills_a_program_that_ignores_the_first() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = channel_sink();
    let pm = ProcessManager::new();
    let script = tmp.path().join("stuck.py");
    std::fs::write(
        &script,
        "import signal, time\n\
         signal.signal(signal.SIGINT, signal.SIG_IGN)\n\
         time.sleep(60)\n",
    )
    .unwrap();
    let config = RunConfig {
        id: "stuck".into(),
        name: "stuck".into(),
        kind: "shell".into(),
        command: "python3".into(),
        args: vec![script.display().to_string()],
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let info = pm.start(tmp.path(), &config, &StartOptions::default(), sink, Box::new(|_| {})).expect("start");
    std::thread::sleep(Duration::from_millis(500));
    pm.stop(info.id).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    pm.stop(info.id).unwrap();
    let code = wait_exit(&events, info.id, Duration::from_secs(10));
    assert_eq!(code, Some(137), "the second Stop SIGKILLs");
}
