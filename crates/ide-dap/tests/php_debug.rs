//! Drives php-debug (vscode-php-debug) the way a PHP Remote Debug (Xdebug)
//! configuration does: a launch without a program makes it listen, and every PHP
//! run that Xdebug connects stops at the breakpoint set in the local copy of the
//! file, through `pathMappings`, until the session is stopped. A second listener on
//! the same port fails to start and names the port.
//!
//! Ignored by default (needs PHP with Xdebug 3, Node.js and php-debug). Run with
//! `PHP_DEBUG_ADAPTER=<php-debug-adapter> cargo test -p ide-dap --test php_debug -- --ignored --nocapture`
//! (`PHP_BIN` picks the PHP executable, default `php`).

use ide_core::event::DebugEvent;
use ide_core::ipc_path::to_ipc;
use ide_core::{IdeEvent, SharedSink};
use ide_dap::*;
use ide_language::LanguageRegistry;
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const SCRIPT: &str = "<?php\n$greeting = \"hello\";\n$n = 40 + 2;\necho \"$greeting $n\\n\";\n";
/// 0-based line of `$n = 40 + 2;`.
const BREAK_LINE: u32 = 2;

async fn wait_for(events: &Mutex<Vec<IdeEvent>>, timeout: Duration, pred: impl Fn(&DebugEvent) -> bool) -> DebugEvent {
    let start = Instant::now();
    loop {
        if let Some(e) = events.lock().iter().find_map(|e| match e {
            IdeEvent::Debug { event, .. } if pred(event) => Some(event.clone()),
            _ => None,
        }) {
            return e;
        }
        assert!(start.elapsed() < timeout, "timed out; events: {:#?}", events.lock());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn listen_config(port: u16, served: &Path, local: &Path) -> LaunchConfig {
    // As remote.ts builds it for Remote root = `served`, Local root = `local`.
    let mapping = serde_json::Map::from_iter([(to_ipc(served), to_ipc(local).into())]);
    LaunchConfig {
        name: "PHP Remote".into(),
        adapter: "php-debug".into(),
        request: "launch".into(),
        program: None,
        args: vec![],
        cwd: Some(local.to_path_buf().into()),
        env: BTreeMap::new(),
        extra_json: Some(serde_json::json!({ "port": port, "pathMappings": mapping }).to_string()),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn listens_for_xdebug_until_stopped_with_path_mappings() {
    let Ok(adapter) = std::env::var("PHP_DEBUG_ADAPTER") else {
        eprintln!("PHP_DEBUG_ADAPTER not set; skipping");
        return;
    };
    let php = std::env::var("PHP_BIN").unwrap_or_else(|_| "php".into());
    let dir = tempfile::tempdir().unwrap();
    // The project here, and the copy PHP runs from (a container's /var/www/html).
    let (local, served) = (dir.path().join("local"), dir.path().join("served"));
    for d in [&local, &served] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("index.php"), SCRIPT).unwrap();
    }
    // Resolved like the project root the UI sends (`/private/var` on macOS, no `\\?\` on Windows).
    let resolved = |p: &Path| PathBuf::from(to_ipc(&std::fs::canonicalize(p).unwrap()));
    let (local, served) = (resolved(&local), resolved(&served));
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();

    let manager = DebugManager::new(Arc::new(LanguageRegistry::load(None).unwrap()));
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink: SharedSink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let local_script = local.join("index.php");
    manager
        .set_breakpoints(
            local_script.clone(),
            vec![Breakpoint {
                line: BREAK_LINE,
                condition: None,
                hit_condition: None,
                log_message: None,
                enabled: true,
            }],
        )
        .await
        .unwrap();
    let id = manager
        .start_with(listen_config(port, &served, &local), SessionOwner::new("main", sink.clone()), |_| {
            Some(adapter.clone())
        })
        .await
        .unwrap_or_else(|e| panic!("start: {e:?}"));

    // Requests in a row each stop; the session keeps listening between them.
    for request in 1..=2 {
        events.lock().clear();
        let run = std::process::Command::new(&php)
            .args([
                "-dxdebug.mode=debug",
                "-dxdebug.start_with_request=yes",
                "-dxdebug.client_host=127.0.0.1",
                &format!("-dxdebug.client_port={port}"),
                "index.php",
            ])
            .current_dir(&served)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stopped = wait_for(&events, Duration::from_secs(30), |e| matches!(e, DebugEvent::Stopped { .. })).await;
        let DebugEvent::Stopped { thread_id, .. } = stopped else { unreachable!() };
        let frames = manager.stack_trace(id, thread_id).await.unwrap();
        assert_eq!(frames[0].line, BREAK_LINE, "request {request}");
        let top = frames[0].path.as_deref().and_then(|p| p.canonicalize().ok());
        assert_eq!(top, local_script.canonicalize().ok(), "request {request}");
        manager.resume(id, thread_id).await.unwrap();
        wait_for(&events, Duration::from_secs(30), |e| matches!(e, DebugEvent::Thread { started: false, .. })).await;
        let out = run.wait_with_output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello 42\n", "request {request}");
        assert!(manager.sessions(None).iter().any(|s| s.id == id), "still listening after request {request}");
    }

    // Another listener on the port (another IDE): the start fails and says why.
    let err = manager
        .start_with(listen_config(port, &served, &local), SessionOwner::new("main", sink), |_| Some(adapter.clone()))
        .await
        .expect_err("a second listener on the same port");
    assert!(err.message.contains("EADDRINUSE") && err.message.ends_with(&format!(":{port}")), "{err:?}");
    assert_eq!(manager.sessions(None).len(), 1);

    manager.stop(id).await.unwrap();
    assert!(manager.sessions(None).is_empty());
}
