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
        match events.recv_timeout(left).expect("RunExited event") {
            IdeEvent::RunExited { run, code } if run == id => return code,
            _ => {}
        }
    }
}

fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn assert_still_running(events: &Receiver<IdeEvent>, timeout: Duration) {
    let event = events.recv_timeout(timeout);
    assert!(
        matches!(event, Err(mpsc::RecvTimeoutError::Timeout)),
        "run exited before shutdown was released: {event:?}"
    );
}

#[test]
fn a_stopped_run_keeps_its_port_until_the_group_is_gone() {
    stopped_launcher_with_descendant(false);
}

#[test]
fn a_second_stop_reaches_descendants_after_the_launcher_exits() {
    stopped_launcher_with_descendant(true);
}

fn stopped_launcher_with_descendant(force: bool) {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = channel_sink();
    let pm = Arc::new(ProcessManager::new());
    // The `mvn`-starts-a-JVM shape: the direct child dies on SIGINT while the process it
    // started ignores it and keeps its socket open until the test releases it.
    let script = tmp.path().join("hold.py");
    std::fs::write(
        &script,
        "import pathlib, signal, socket, sys, time\n\
         signal.signal(signal.SIGINT, signal.SIG_IGN)\n\
         s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen()\n\
         open(sys.argv[1], 'w').write(str(s.getsockname()[1]))\n\
         while not pathlib.Path(sys.argv[2]).exists(): time.sleep(0.01)\n",
    )
    .unwrap();
    let port_file = tmp.path().join("port");
    let release_file = tmp.path().join("release");
    let config = RunConfig {
        id: "boot".into(),
        name: "boot".into(),
        kind: "shell".into(),
        command: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            "python3 \"$1\" \"$2\" \"$3\" & sleep 60".into(),
            "sh".into(),
            script.display().to_string(),
            port_file.display().to_string(),
            release_file.display().to_string(),
        ],
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let info = pm.start(tmp.path(), &config, &StartOptions::default(), sink, Box::new(|_| {})).expect("start");
    wait_for("the listening port", || {
        std::fs::read_to_string(&port_file).ok().is_some_and(|text| text.trim().parse::<u16>().is_ok())
    });
    let port: u16 = std::fs::read_to_string(&port_file).expect("port").trim().parse().unwrap();

    pm.stop(info.id).unwrap();
    let pid = info.pid.expect("child pid") as libc::pid_t;
    wait_for("the direct child to exit", || unsafe { libc::kill(pid, 0) != 0 });
    let exit = events.recv_timeout(Duration::from_secs(1));
    let port_held = std::net::TcpStream::connect(("127.0.0.1", port)).is_ok();
    if force {
        let (tx, rx) = mpsc::channel();
        let pm = pm.clone();
        std::thread::spawn(move || {
            let _ = tx.send(pm.stop(info.id));
        });
        let result = rx.recv_timeout(Duration::from_secs(1));
        if result.is_err() {
            std::fs::write(&release_file, "").unwrap();
        }
        result.expect("second Stop blocked waiting for the run's pid lock").unwrap();
    } else {
        std::fs::write(&release_file, "").unwrap();
    }
    assert!(
        matches!(exit, Err(mpsc::RecvTimeoutError::Timeout)),
        "run exited while its descendant held the port: {exit:?}"
    );
    assert!(port_held, "the descendant still holds its port");
    let code = wait_exit(&events, info.id, Duration::from_secs(20));
    assert!(code.is_some(), "the run reports its exit");
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
    // Ignores SIGINT until stdin releases the shutdown, like a slow Spring Boot shutdown.
    // A first Stop must wait even past the grace period instead of killing it (exit code 137).
    let script = tmp.path().join("slow.py");
    let ready_file = tmp.path().join("ready");
    std::fs::write(
        &script,
        "import pathlib, signal, sys\n\
         signal.signal(signal.SIGINT, signal.SIG_IGN)\n\
         pathlib.Path(sys.argv[1]).touch()\n\
         sys.stdin.readline()\n",
    )
    .unwrap();
    let config = RunConfig {
        id: "slow".into(),
        name: "slow".into(),
        kind: "shell".into(),
        command: "python3".into(),
        args: vec![script.display().to_string(), ready_file.display().to_string()],
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let info = pm.start(tmp.path(), &config, &StartOptions::default(), sink, Box::new(|_| {})).expect("start");
    wait_for("the SIGINT handler", || ready_file.exists());
    pm.stop_with_grace(info.id, Duration::from_millis(100)).unwrap();
    assert_still_running(&events, Duration::from_secs(1));
    pm.write_stdin(info.id, "finish shutdown\n").unwrap();
    let code = wait_exit(&events, info.id, Duration::from_secs(10));
    assert_eq!(code, Some(0), "the program exited by itself, not by SIGKILL");
}

#[test]
fn a_second_stop_kills_a_program_that_ignores_the_first() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = channel_sink();
    let pm = ProcessManager::new();
    let script = tmp.path().join("stuck.py");
    let ready_file = tmp.path().join("ready");
    std::fs::write(
        &script,
        "import pathlib, signal, sys\n\
         signal.signal(signal.SIGINT, signal.SIG_IGN)\n\
         pathlib.Path(sys.argv[1]).touch()\n\
         sys.stdin.readline()\n",
    )
    .unwrap();
    let config = RunConfig {
        id: "stuck".into(),
        name: "stuck".into(),
        kind: "shell".into(),
        command: "python3".into(),
        args: vec![script.display().to_string(), ready_file.display().to_string()],
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let info = pm.start(tmp.path(), &config, &StartOptions::default(), sink, Box::new(|_| {})).expect("start");
    wait_for("the SIGINT handler", || ready_file.exists());
    pm.stop(info.id).unwrap();
    assert_still_running(&events, Duration::from_millis(200));
    pm.stop(info.id).unwrap();
    let code = wait_exit(&events, info.id, Duration::from_secs(10));
    assert_eq!(code, Some(137), "the second Stop SIGKILLs");
}
