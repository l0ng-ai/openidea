//! Closing a project takes the background processes of its window with it, as IDEA does,
//! and leaves the other windows' processes alone.
#![cfg(unix)]

use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn options(root: &std::path::Path) -> ide_terminal::TerminalOptions {
    ide_terminal::TerminalOptions {
        cwd: root.to_path_buf().into(),
        // A fixed shell: the test must not depend on the login shell of this machine.
        shell: Some("/bin/sh".into()),
        args: vec![],
        env: Default::default(),
        cols: 80,
        rows: 24,
        shell_integration: false,
    }
}

#[test]
fn closing_a_project_closes_its_terminals_and_keeps_other_windows() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    runtime.block_on(async {
        let host = Arc::new(Host::new(HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        host.trust.decide(&root, true, false).unwrap();
        host.open_project("main", &root).unwrap();
        let project_shell =
            ops::term::spawn(&host, "main", options(&root), Arc::new(|_| {})).expect("project terminal");
        let other_shell = ops::term::spawn(&host, "other", options(&root), Arc::new(|_| {})).expect("other terminal");
        assert_eq!(host.terminals.list().len(), 2);

        host.close_project("main");

        let left: Vec<_> = host.terminals.list().into_iter().map(|t| t.id).collect();
        assert!(!left.contains(&project_shell.id), "the closing window's shell is gone");
        assert!(left.contains(&other_shell.id), "another window keeps its shell");
        host.terminals.kill_key("other");
    });
}

/// The desktop closes a project on the event-loop thread while runtime workers may be
/// blocked waiting for that thread (IPC responses, window queries): closing must not
/// wait for workers that need the runtime, and exit still waits for them once free.
#[test]
fn detached_close_returns_while_runtime_workers_wait_for_the_closing_thread() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    let _guard = runtime.enter();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: tmp.path().join("config"),
        data_dir: tmp.path().join("data"),
        local_data_dir: tmp.path().join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: runtime.handle().clone(),
        project_environment: false,
    }));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();

    // Occupy the only runtime worker until "the event loop" answers.
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    runtime.spawn(async move {
        started_tx.send(()).unwrap();
        let _ = release_rx.recv();
    });
    started_rx.recv().unwrap();

    let (closed_tx, closed_rx) = std::sync::mpsc::channel();
    let closer = host.clone();
    std::thread::spawn(move || {
        closer.close_project_detached("main");
        let _ = closed_tx.send(());
    });
    let returned = closed_rx.recv_timeout(Duration::from_secs(5));
    release_tx.send(()).unwrap();
    assert!(returned.is_ok(), "closing waited for a runtime worker that waits for the closing thread");
    assert!(host.project("main").is_err(), "the window no longer has the project");
    host.open_project("main", &root).expect("the window opens a project once the close has finished");

    let started = Instant::now();
    host.shutdown_notebooks_on_exit();
    assert!(started.elapsed() < Duration::from_secs(5), "exit joined the finished close instead of timing out");
}
