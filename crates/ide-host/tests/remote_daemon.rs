//! End-to-end tests of persistent `openidea-server --attach <project>`:
//! closing a client relay keeps the daemon, project index, terminals, runs
//! (including `stopCommand` configs such as `docker compose`) and dirty buffers
//! running until a client sends `"shutdown"`.

#![cfg(unix)]

use ide_host::rpc::{self, ChannelMessage, EventMessage, Invoke, ServerInfo};
use ide_jsonrpc::{Handler, Peer};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

#[derive(Default)]
struct Client {
    channels: Mutex<Vec<ChannelMessage>>,
    events: Mutex<Vec<EventMessage>>,
}

impl Handler for Client {
    fn on_notification(&self, method: &str, params: Value) {
        match method {
            "channel" => self.channels.lock().push(serde_json::from_value(params).unwrap()),
            "event" => self.events.lock().push(serde_json::from_value(params).unwrap()),
            _ => {}
        }
    }

    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
    }
}

async fn invoke(peer: &Peer, cmd: &str, args: Value) -> Result<Value, ide_core::IdeError> {
    let call = Invoke { window: "main".into(), cmd: cmd.into(), args };
    peer.request::<_, Value>("invoke", call, None).await.map_err(rpc::error_from_reply)
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..600 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    panic!("timed out waiting for {what}");
}

struct DaemonGuard(std::path::PathBuf);

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        use std::io::{BufRead, BufReader, Write};
        if let Ok(mut stream) = std::os::unix::net::UnixStream::connect(&self.0) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = stream.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"shutdown\",\"params\":null}\n");
            let _ = stream.flush();
            let mut line = String::new();
            let _ = BufReader::new(stream).read_line(&mut line);
        }
    }
}

fn attach_client(home: &Path, server_home: &Path, attach_arg: &str) -> (Peer, Arc<Client>) {
    let bin = env!("CARGO_BIN_EXE_openidea-server");
    let client = Arc::new(Client::default());
    let args = vec!["--attach".to_owned(), attach_arg.to_owned()];
    let env = vec![
        ("HOME".to_owned(), home.to_string_lossy().into_owned()),
        ("OPENIDEA_SERVER_HOME".to_owned(), server_home.to_string_lossy().into_owned()),
        ("OPENIDEA_SKIP_SHELL_ENV".to_owned(), "1".into()),
    ];
    let peer = Peer::spawn(bin, &args, home, &env, client.clone(), Box::new(|_| {})).unwrap();
    (peer, client)
}

fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else { return false };
    if pid <= 0 {
        return false;
    }
    // Check `kill(pid, 0)` and exclude zombies on macOS/Linux via `ps`.
    let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output();
    match out {
        Ok(o) if o.status.success() => {
            let stat = String::from_utf8_lossy(&o.stdout);
            let s = stat.trim();
            !s.is_empty() && !s.starts_with('Z')
        }
        _ => false,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_persists_terminals_runs_index_and_dirty_docs_across_disconnect_until_shutdown() {
    let tmp = tempfile::tempdir().unwrap();
    let home = dunce::canonicalize(tmp.path()).unwrap().join("home");
    let project = home.join("demo");
    let subdir = project.join("sub");
    std::fs::create_dir_all(&subdir).unwrap();
    std::fs::write(project.join("app.py"), "def greet():\n    return 42\n").unwrap();
    let server_home = home.join(".openidea");
    let _guard = DaemonGuard(
        ide_host::daemon::paths_for(
            &server_home,
            &home,
            Path::new(env!("CARGO_BIN_EXE_openidea-server")),
            &project.to_string_lossy(),
        )
        .unwrap()
        .socket,
    );

    // --- Session 1: open project, start a TUI terminal (`watch date`) and a compose-like run ---
    let (peer1, client1) = attach_client(&home, &server_home, &project.to_string_lossy());
    let info1: ServerInfo =
        peer1.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None).await.unwrap();
    assert_eq!(info1.protocol, rpc::PROTOCOL_VERSION);

    let opened = invoke(&peer1, "open_project", json!({ "path": project })).await.unwrap();
    assert_eq!(opened["name"], "demo");
    invoke(&peer1, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();

    // Wait for background indexing to index `greet`.
    for _ in 0..200 {
        let syms =
            invoke(&peer1, "find_symbols", json!({ "query": "greet", "filter": "all", "limit": 10 })).await.unwrap();
        if syms.as_array().is_some_and(|a| !a.is_empty()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Spawn a long-running terminal emitting OSC 7 cwd, OSC 2 title (`watch date`), OSC 133;C and periodic ticks.
    let term_script = format!(
        "printf '\\033]7;file://localhost{}\\007\\033]2;watch date\\007\\033]133;C\\007'; \
         i=0; while true; do i=$((i+1)); echo \"tick-$i\"; sleep 0.05; done",
        subdir.display()
    );
    let term = invoke(
        &peer1,
        "term_spawn",
        json!({
            "options": {
                "cwd": project,
                "shell": "/bin/sh",
                "args": ["-c", term_script],
                "env": {},
                "cols": 80,
                "rows": 24,
                "shellIntegration": false
            },
            "onOutput": { "$channel": 101 }
        }),
    )
    .await
    .unwrap();
    let term_id = term["id"].as_u64().unwrap();
    let term_pid = term["pid"].as_u64().unwrap() as u32;
    until("initial terminal tick", || {
        client1.channels.lock().iter().any(|c| c.id == 101 && c.data.as_str().is_some_and(|s| s.contains("tick-")))
    })
    .await;

    // Start a Docker-Compose-style run with a `stopCommand` that writes `down.marker` ONLY when stopped.
    let down_marker = project.join("down.marker");
    let run_config = json!({
        "id": "docker:compose:up",
        "name": "docker compose up",
        "kind": "docker-compose",
        "command": "/bin/sh",
        "args": ["-c", "n=0; while true; do n=$((n+1)); echo \"compose-$n\"; sleep 0.05; done"],
        "cwd": project,
        "env": {},
        "detected": false,
        "isTest": false,
        "debugAdapter": null,
        "stopCommand": format!("touch '{}'", down_marker.display()),
    });
    let run = invoke(
        &peer1,
        "run_start",
        json!({
            "config": run_config,
            "onOutput": { "$channel": 102 },
            "request": 1
        }),
    )
    .await
    .unwrap();
    let run_id = run["id"].as_u64().unwrap();
    let run_pid = run["pid"].as_u64().unwrap() as u32;
    until("initial compose output", || {
        client1
            .channels
            .lock()
            .iter()
            .any(|c| c.id == 102 && c.data["text"].as_str().is_some_and(|s| s.contains("compose-")))
    })
    .await;

    // Leave an unsaved edit in `app.py` to simulate an unexpected disconnect, plus a clean file `clean.txt`.
    std::fs::write(project.join("clean.txt"), "before\n").unwrap();
    let _clean_doc = invoke(&peer1, "doc_open", json!({ "path": project.join("clean.txt") })).await.unwrap();
    let dirty_doc = invoke(&peer1, "doc_open", json!({ "path": project.join("app.py") })).await.unwrap();
    invoke(
        &peer1,
        "doc_edit",
        json!({
            "doc": dirty_doc["id"],
            "baseVersion": dirty_doc["version"],
            "changes": { "changes": [{ "from": 0, "to": 0, "insert": "# unsaved\n" }] }
        }),
    )
    .await
    .unwrap();

    // --- Close window / disconnect client #1 ---
    peer1.kill();
    peer1.exited().await;

    // Let both background processes produce output while NO client is connected, and update `clean.txt` on disk.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(pid_alive(term_pid), "terminal PTY process must keep running after window close");
    assert!(pid_alive(run_pid), "docker-compose run process must keep running after window close");
    assert!(!down_marker.exists(), "closing the remote window must NOT run docker compose down");
    std::fs::write(project.join("clean.txt"), "updated-while-closed\n").unwrap();

    // --- Session 2: reopen via `~/demo` (tests `~` canonicalization attaching to the SAME daemon) ---
    let (peer2, client2) = attach_client(&home, &server_home, "~/demo");
    let _: ServerInfo = peer2.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None).await.unwrap();
    let reopened = invoke(&peer2, "open_project", json!({ "path": project })).await.unwrap();
    assert_eq!(reopened["trusted"], true);

    // 1. Terminal list & reattach restores `watch date` title, cwd, buffered ticks and live output!
    let terms = invoke(&peer2, "term_list", json!({})).await.unwrap();
    let listed = terms.as_array().unwrap();
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0]["id"], term_id);
    assert_eq!(listed[0]["appTitle"], "watch date");
    assert_eq!(listed[0]["commandRunning"], true);
    assert_eq!(listed[0]["cwd"], subdir.to_string_lossy().as_ref());

    let attached_term = invoke(
        &peer2,
        "term_attach",
        json!({ "id": term_id, "cols": 100, "rows": 30, "onOutput": { "$channel": 201 } }),
    )
    .await
    .unwrap();
    assert!(attached_term["buffered"].as_str().unwrap().contains("tick-"));
    until("live terminal ticks on client 2", || {
        client2.channels.lock().iter().any(|c| c.id == 201 && c.data.as_str().is_some_and(|s| s.contains("tick-")))
    })
    .await;

    // 2. Run list & reattach restores the running `docker compose up` session and streams live output!
    let runs = invoke(&peer2, "run_list", json!({})).await.unwrap();
    assert!(runs.as_array().unwrap().iter().any(|r| r["id"] == run_id && r["running"] == true));
    let attached_run =
        invoke(&peer2, "run_attach", json!({ "id": run_id, "onOutput": { "$channel": 202 } })).await.unwrap();
    assert_eq!(attached_run["config"]["id"], "docker:compose:up");
    assert!(
        attached_run["buffered"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["text"].as_str().is_some_and(|s| s.contains("compose-")))
    );
    until("live compose output on client 2", || {
        client2
            .channels
            .lock()
            .iter()
            .any(|c| c.id == 202 && c.data["text"].as_str().is_some_and(|s| s.contains("compose-")))
    })
    .await;

    // 3. Clean documents reload external disk changes; dirty documents retain unsaved edits without ref leaks!
    let clean_reopened = invoke(&peer2, "doc_open", json!({ "path": project.join("clean.txt") })).await.unwrap();
    assert_eq!(clean_reopened["text"], "updated-while-closed\n");
    let dirty_reopened = invoke(&peer2, "doc_open", json!({ "path": project.join("app.py") })).await.unwrap();
    assert!(dirty_reopened["text"].as_str().unwrap().starts_with("# unsaved\n"));
    assert_eq!(dirty_reopened["dirty"], true);

    // 4. Explicit `"shutdown"` (Stop Remote Backend) stops the daemon and cleans up processes.
    let _: Value = peer2.request("shutdown", Value::Null, None).await.unwrap();
    peer2.exited().await;
    until("terminal and run processes terminated on explicit backend shutdown", || {
        !pid_alive(term_pid) && !pid_alive(run_pid)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ongoing_agent_session_continues_running_while_remote_window_is_closed() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::tempdir().unwrap();
    let home = dunce::canonicalize(tmp.path()).unwrap().join("home");
    let project = home.join("agent-demo");
    std::fs::create_dir_all(&project).unwrap();
    let server_home = home.join(".openidea");
    let _guard = DaemonGuard(
        ide_host::daemon::paths_for(
            &server_home,
            &home,
            Path::new(env!("CARGO_BIN_EXE_openidea-server")),
            &project.to_string_lossy(),
        )
        .unwrap()
        .socket,
    );
    let agents_dir = server_home.join("config/agents");
    std::fs::create_dir_all(&agents_dir).unwrap();

    let agent_script = home.join("mock-acp-agent.py");
    std::fs::write(
        &agent_script,
        r#"#!/usr/bin/env python3
import json, sys, time

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

while True:
    raw = sys.stdin.readline()
    if not raw:
        break
    raw = raw.strip()
    if not raw:
        continue
    msg = json.loads(raw)
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 2, "capabilities": {}, "info": {"name": "mock", "version": "1.0"}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "sess-1", "configOptions": []}})
    elif method == "session/prompt":
        send({"jsonrpc": "2.0", "id": mid, "result": {"messageId": "u1"}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sess-1", "update": {"sessionUpdate": "state_update", "state": "running"}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sess-1", "update": {"sessionUpdate": "agent_message_chunk", "messageId": "a1", "content": {"type": "text", "text": "part-1 "}}}})
        time.sleep(0.35)
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sess-1", "update": {"sessionUpdate": "agent_message_chunk", "messageId": "a1", "content": {"type": "text", "text": "finished-while-window-closed"}}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sess-1", "update": {"sessionUpdate": "state_update", "state": "idle", "stopReason": "end_turn"}}})
"#,
    )
    .unwrap();
    std::fs::set_permissions(&agent_script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        agents_dir.join("mock-agent.toml"),
        format!("name = \"Mock Agent\"\ncommand = \"{}\"\nargs = []\n", agent_script.display()),
    )
    .unwrap();

    // Client 1 opens the project, starts the agent task, then disconnects mid-turn.
    let (peer1, _) = attach_client(&home, &server_home, &project.to_string_lossy());
    let _: ServerInfo = peer1.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None).await.unwrap();
    invoke(&peer1, "open_project", json!({ "path": project })).await.unwrap();
    invoke(&peer1, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();
    let _ = invoke(&peer1, "agent_subscribe", json!({ "onEvent": { "$channel": 301 } })).await.unwrap();

    let created = invoke(
        &peer1,
        "agent_create",
        json!({
            "request": {
                "provider": "mock-agent",
                "prompt": { "text": "run background task", "files": [], "images": [] },
                "isolation": "local",
                "baseBranch": null,
                "config": [],
                "projectRoot": project,
                "mcpOverrides": {}
            }
        }),
    )
    .await
    .unwrap();
    let task_id = created["id"].as_str().unwrap().to_owned();

    // Disconnect Client 1 while the agent is sleeping mid-turn!
    tokio::time::sleep(Duration::from_millis(80)).await;
    peer1.kill();
    peer1.exited().await;

    // Wait for the agent turn to complete while NO window is connected.
    tokio::time::sleep(Duration::from_millis(450)).await;

    // Client 2 reconnects and observes the completed agent task + full reply!
    let (peer2, _) = attach_client(&home, &server_home, &project.to_string_lossy());
    let _: ServerInfo = peer2.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None).await.unwrap();
    invoke(&peer2, "open_project", json!({ "path": project })).await.unwrap();

    for _ in 0..200 {
        let tasks = invoke(&peer2, "agent_subscribe", json!({ "onEvent": { "$channel": 401 } })).await.unwrap();
        let task = tasks.as_array().unwrap().iter().find(|t| t["id"] == task_id).expect("persisted agent task");
        if task["status"] == "ready" {
            break;
        }
        assert_ne!(task["status"], "failed", "{task:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let tasks = invoke(&peer2, "agent_subscribe", json!({ "onEvent": { "$channel": 401 } })).await.unwrap();
    let task = tasks.as_array().unwrap().iter().find(|t| t["id"] == task_id).expect("persisted agent task");
    assert_eq!(task["status"], "ready", "{task:?}");

    let entries = invoke(&peer2, "agent_entries", json!({ "task": task_id, "subagent": null })).await.unwrap();
    let texts: Vec<&str> = entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "agent")
        .filter_map(|e| e["text"].as_str())
        .collect();
    assert!(
        texts.iter().any(|t| t.contains("part-1 finished-while-window-closed")),
        "expected full agent output across window close, got: {entries:?}"
    );

    let _: Value = peer2.request("shutdown", Value::Null, None).await.unwrap();
    peer2.exited().await;
}
