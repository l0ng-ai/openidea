//! End-to-end tests of persistent `openidea-server --attach <project>`:
//! closing a client relay keeps the daemon, project index, terminals, runs
//! (including `stopCommand` configs such as `docker compose`) and dirty buffers
//! running until a client sends `"shutdown"` or the backend has been idle long enough.

#![cfg(unix)]

use ide_host::rpc::{self, ChannelMessage, EventMessage, Invoke, ServerInfo};
use ide_jsonrpc::{Handler, Peer};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const SERVER: &str = env!("CARGO_BIN_EXE_openidea-server");
const IDLE_TIMEOUT: &str = "OPENIDEA_SERVER_IDLE_TIMEOUT_SECONDS";

#[derive(Default)]
struct Client {
    channels: Mutex<Vec<ChannelMessage>>,
    events: Mutex<Vec<EventMessage>>,
    taken_over: AtomicBool,
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
        if method == rpc::SESSION_REPLACED {
            self.taken_over.store(true, Ordering::Release);
            return Ok(Value::Null);
        }
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
    }
}

async fn invoke(peer: &Peer, cmd: &str, args: Value) -> Result<Value, ide_core::IdeError> {
    let call = Invoke { window: "main".into(), cmd: cmd.into(), args };
    tokio::time::timeout(Duration::from_secs(15), peer.request::<_, Value>("invoke", call, None))
        .await
        .unwrap_or_else(|_| panic!("timed out calling {cmd}"))
        .map_err(rpc::error_from_reply)
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

struct DaemonGuard(PathBuf);

fn test_build() -> &'static [u8] {
    static BUILD: OnceLock<String> = OnceLock::new();
    BUILD
        .get_or_init(|| {
            let mut hasher = blake3::Hasher::new();
            hasher.update_reader(std::fs::File::open(SERVER).unwrap()).unwrap();
            hasher.finalize().to_hex()[..16].to_owned()
        })
        .as_bytes()
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        use std::io::{Read, Write};
        if let Ok(mut stream) = std::os::unix::net::UnixStream::connect(&self.0) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut reply = [0];
            if stream.write_all(test_build()).and_then(|_| stream.read_exact(&mut reply)).is_ok() && reply == *b"A" {
                let request = r#"{"jsonrpc":"2.0","id":1,"method":"shutdown"}"#;
                let _ = write!(stream, "Content-Length: {}\r\n\r\n{request}", request.len());
                let _ = std::io::copy(&mut stream, &mut std::io::sink());
            }
        }
    }
}

fn server_env(home: &Path, server_home: &Path, idle_seconds: u64) -> [(String, String); 4] {
    [
        ("HOME".to_owned(), home.to_string_lossy().into_owned()),
        ("OPENIDEA_SERVER_HOME".to_owned(), server_home.to_string_lossy().into_owned()),
        ("OPENIDEA_SKIP_SHELL_ENV".to_owned(), "1".into()),
        (IDLE_TIMEOUT.into(), idle_seconds.to_string()),
    ]
}

fn attach_client(home: &Path, server_home: &Path, attach_arg: &str, idle_seconds: u64) -> (Peer, Arc<Client>) {
    let client = Arc::new(Client::default());
    let args = vec!["--attach".to_owned(), attach_arg.to_owned()];
    let env = server_env(home, server_home, idle_seconds);
    let peer = Peer::spawn(SERVER, &args, home, &env, client.clone(), Box::new(|line| eprintln!("{line}"))).unwrap();
    (peer, client)
}

async fn ssh_server(home: &Path, server_home: &Path, project: &Path) -> Arc<ide_ssh::Session> {
    use ide_core::remote_settings::{SshAuth, SshConfiguration};
    use ide_ssh::{SshFiles, SshManager};
    let project = project.to_owned();
    let env = server_env(home, server_home, 10_800);
    let port = ide_ssh::testing::sshd_with_process(home.join("sftp"), move |command| {
        let path = if command == "openidea-test-attach" {
            project.to_str().unwrap()
        } else if command == "openidea-test-reattach" {
            "~/demo"
        } else {
            return None;
        };
        let mut cmd = tokio::process::Command::new(SERVER);
        cmd.args(["--attach", path]).envs(env.iter().cloned());
        Some(cmd)
    })
    .await;
    let ssh = SshManager::with_files(
        home.join("secrets.json"),
        SshFiles { known_hosts: home.join("known_hosts"), config: None },
    );
    ssh.set_configs(vec![SshConfiguration {
        id: "local-test".into(),
        host: "127.0.0.1".into(),
        port: Some(port),
        user: "dev".into(),
        auth: SshAuth::Password,
        save_secret: true,
        ..Default::default()
    }]);
    ssh.set_secret("local-test", Some("secret".into()), true);
    assert!(ssh.session("local-test").await.is_err(), "unknown host key first");
    ssh.trust_host("local-test").await.unwrap();
    ssh.session("local-test").await.unwrap()
}

async fn ssh_attach(ssh: &ide_ssh::Session, command: &str) -> (Peer, Arc<Client>) {
    let stream = ssh.exec_stream(command).await.unwrap();
    let (reader, writer) = tokio::io::split(stream);
    let client = Arc::new(Client::default());
    (Peer::connect(reader, writer, client.clone()), client)
}

async fn initialize(peer: &Peer) -> ServerInfo {
    tokio::time::timeout(
        Duration::from_secs(15),
        peer.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None),
    )
    .await
    .expect("initialize timed out")
    .unwrap()
}

async fn shutdown(peer: &Peer) {
    tokio::time::timeout(Duration::from_secs(15), async {
        peer.request::<_, ()>("shutdown", Value::Null, None).await.unwrap();
        peer.closed().await;
    })
    .await
    .expect("backend did not shut down");
}

async fn assert_indexed(peer: &Peer, name: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let syms =
                invoke(peer, "find_symbols", json!({ "query": name, "filter": "all", "limit": 10 })).await.unwrap();
            if syms.as_array().is_some_and(|a| a.iter().any(|sym| sym["name"] == name)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("symbol {name} was not indexed"));
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
async fn ssh_disconnect_keeps_terminals_runs_index_and_dirty_docs_until_shutdown() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("h");
    let project = home.join("demo");
    let subdir = project.join("sub");
    std::fs::create_dir_all(&subdir).unwrap();
    let subdir = dunce::canonicalize(subdir).unwrap();
    std::fs::write(project.join("app.py"), "def greet():\n    return 42\n").unwrap();
    let server_home = tmp.path().join("s");
    let guard = DaemonGuard(ide_host::daemon::paths_for(&server_home, &home, "~/demo").unwrap().socket);
    let ssh = ssh_server(&home, &server_home, &project).await;

    // --- Session 1: open project, start a TUI terminal (`watch date`) and a compose-like run ---
    let (peer1, client1) = ssh_attach(&ssh, "openidea-test-attach").await;
    let info1 = initialize(&peer1).await;
    assert_eq!(info1.protocol, rpc::PROTOCOL_VERSION);
    assert_eq!(info1.idle_policy.unwrap().override_seconds, Some(10_800));

    let opened = invoke(&peer1, "open_project", json!({ "path": project })).await.unwrap();
    assert_eq!(opened["name"], "demo");
    invoke(&peer1, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();

    assert_indexed(&peer1, "greet").await;

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
    peer1.closed().await;

    // Let both background processes produce output while NO client is connected, and update `clean.txt` on disk.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(pid_alive(term_pid), "terminal PTY process must keep running after window close");
    assert!(pid_alive(run_pid), "docker-compose run process must keep running after window close");
    assert!(!down_marker.exists(), "closing the remote window must NOT run docker compose down");
    std::fs::write(project.join("clean.txt"), "updated-while-closed\n").unwrap();
    std::fs::write(project.join("added.py"), "def indexed_while_disconnected():\n    pass\n").unwrap();

    // --- Session 2: reopen via `~/demo` (tests `~` canonicalization attaching to the SAME daemon) ---
    let (peer2, client2) = ssh_attach(&ssh, "openidea-test-reattach").await;
    initialize(&peer2).await;
    let reopened = invoke(&peer2, "open_project", json!({ "path": project })).await.unwrap();
    assert_eq!(reopened["trusted"], true);
    assert_indexed(&peer2, "indexed_while_disconnected").await;

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
    shutdown(&peer2).await;
    until("terminal and run processes terminated on explicit backend shutdown", || {
        !pid_alive(term_pid) && !pid_alive(run_pid)
    })
    .await;
    assert!(down_marker.exists(), "stopping the backend runs the configured stop command");
    assert!(!guard.0.exists(), "the shutdown connection stays open until daemon cleanup finishes");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ongoing_agent_session_continues_running_while_remote_window_is_closed() {
    agent_roundtrip(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stopping_the_backend_terminates_an_agent_mid_turn() {
    agent_roundtrip(true).await;
}

async fn agent_roundtrip(stop_during_turn: bool) {
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("h");
    let project = home.join("agent-demo");
    std::fs::create_dir_all(&project).unwrap();
    let server_home = tmp.path().join("s");
    let guard = DaemonGuard(ide_host::daemon::paths_for(&server_home, &home, "~/agent-demo").unwrap().socket);
    let agents_dir = server_home.join("config/agents");
    std::fs::create_dir_all(&agents_dir).unwrap();

    let agent_script = home.join("mock-acp-agent.py");
    std::fs::write(
        &agent_script,
        r#"#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path

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
        Path("agent.pid").write_text(str(os.getpid()))
        while not Path("agent.release").exists():
            time.sleep(0.03)
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sess-1", "update": {"sessionUpdate": "agent_message_chunk", "messageId": "a1", "content": {"type": "text", "text": "finished-while-window-closed"}}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sess-1", "update": {"sessionUpdate": "state_update", "state": "idle", "stopReason": "end_turn"}}})
        Path("agent.finished").touch()
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
    let (peer1, _) = attach_client(&home, &server_home, "~/agent-demo", 1);
    initialize(&peer1).await;
    invoke(&peer1, "open_project", json!({ "path": project })).await.unwrap();
    invoke(&peer1, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();
    invoke(&peer1, "agent_subscribe", json!({ "subscriber": "main", "onEvent": { "$channel": 301 } })).await.unwrap();

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

    let pid_path = project.join("agent.pid");
    let read_pid = || std::fs::read_to_string(&pid_path).ok().and_then(|text| text.parse::<u32>().ok());
    until("agent prompt started", || read_pid().is_some()).await;
    let agent_pid = read_pid().unwrap();
    peer1.kill();
    peer1.exited().await;

    // The turn alone keeps the daemon running past its idle deadline.
    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert!(guard.0.exists(), "the daemon expired during an agent turn");
    assert!(pid_alive(agent_pid));

    if !stop_during_turn {
        std::fs::write(project.join("agent.release"), "").unwrap();
        until("agent completed with the window closed", || project.join("agent.finished").exists()).await;
    }

    let (peer2, _) = attach_client(&home, &server_home, "~/agent-demo", 1);
    initialize(&peer2).await;
    invoke(&peer2, "open_project", json!({ "path": project })).await.unwrap();

    if stop_during_turn {
        shutdown(&peer2).await;
        until("agent process stopped", || !pid_alive(agent_pid)).await;
        assert!(!project.join("agent.finished").exists());
        assert!(!guard.0.exists());
        return;
    }

    for _ in 0..200 {
        let tasks = invoke(&peer2, "agent_subscribe", json!({ "subscriber": "main", "onEvent": { "$channel": 401 } }))
            .await
            .unwrap();
        let task = tasks.as_array().unwrap().iter().find(|t| t["id"] == task_id).expect("persisted agent task");
        if task["status"] == "ready" {
            break;
        }
        assert_ne!(task["status"], "failed", "{task:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let tasks = invoke(&peer2, "agent_subscribe", json!({ "subscriber": "main", "onEvent": { "$channel": 401 } }))
        .await
        .unwrap();
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

    shutdown(&peer2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_idle_open_project_expires_but_an_attached_view_does_not() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("h");
    let base = tmp.path().join("s");
    let project = home.join("demo");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("hello.py"), "def kept_during_index():\n    pass\n").unwrap();
    let guard = DaemonGuard(ide_host::daemon::paths_for(&base, &home, "~/demo").unwrap().socket);
    let (peer, _) = attach_client(&home, &base, "~/demo", 1);
    initialize(&peer).await;
    invoke(&peer, "open_project", json!({ "path": project })).await.unwrap();
    assert_indexed(&peer, "kept_during_index").await;
    invoke(
        &peer,
        "settings_set",
        json!({ "scope": "global", "key": "remoteDevelopment.idleTimeoutMinutes", "value": "0" }),
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert!(!invoke(&peer, "project_current", json!({})).await.unwrap().is_null());
    peer.kill();
    peer.exited().await;
    until("a disconnected, opened project expires", || !guard.0.exists()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unsaved_edits_of_a_dropped_connection_keep_an_idle_daemon() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("h");
    let base = tmp.path().join("s");
    let project = home.join("demo");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("app.py"), "print(1)\n").unwrap();
    let guard = DaemonGuard(ide_host::daemon::paths_for(&base, &home, "~/demo").unwrap().socket);
    let (peer, _) = attach_client(&home, &base, "~/demo", 1);
    initialize(&peer).await;
    invoke(&peer, "open_project", json!({ "path": project })).await.unwrap();
    let doc = invoke(&peer, "doc_open", json!({ "path": project.join("app.py") })).await.unwrap();
    invoke(
        &peer,
        "doc_edit",
        json!({
            "doc": doc["id"],
            "baseVersion": doc["version"],
            "changes": { "changes": [{ "from": 0, "to": 0, "insert": "# unsaved\n" }] }
        }),
    )
    .await
    .unwrap();
    peer.kill();
    peer.exited().await;
    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert!(guard.0.exists(), "an idle daemon expired with unsaved edits");

    let (again, _) = attach_client(&home, &base, "~/demo", 1);
    initialize(&again).await;
    let reopened = invoke(&again, "doc_open", json!({ "path": project.join("app.py") })).await.unwrap();
    assert!(reopened["text"].as_str().unwrap().starts_with("# unsaved\n"));
    shutdown(&again).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn applying_the_host_timeout_expires_the_running_daemon_without_a_restart() {
    saved_idle_policy(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn never_keeps_the_same_idle_daemon_until_explicit_shutdown() {
    saved_idle_policy(true).await;
}

async fn saved_idle_policy(never: bool) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("h");
    let base = tmp.path().join("s");
    let project = home.join("demo");
    std::fs::create_dir_all(&project).unwrap();
    let guard = DaemonGuard(ide_host::daemon::paths_for(&base, &home, "~/demo").unwrap().socket);
    let mut daemon = tokio::process::Command::new(SERVER)
        .arg("--daemon")
        .arg(&guard.0)
        .arg(std::str::from_utf8(test_build()).unwrap())
        .envs(server_env(&home, &base, 1))
        .env_remove(IDLE_TIMEOUT)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    until("daemon bound its socket", || guard.0.exists()).await;
    let (peer, _) = attach_client(&home, &base, "~/demo", 1);
    assert_eq!(initialize(&peer).await.idle_policy.unwrap().override_seconds, None);
    invoke(&peer, "open_project", json!({ "path": project })).await.unwrap();
    let set = |scope: &str, value: &str| {
        invoke(
            &peer,
            "settings_set",
            json!({ "scope": scope, "key": "remoteDevelopment.idleTimeoutMinutes", "value": value }),
        )
    };
    let global = invoke(&peer, "settings_get_global", json!({})).await.unwrap();
    assert_eq!(global["remoteDevelopment"]["idleTimeoutMinutes"], 180);
    assert!(set("global", "-1").await.is_err());
    assert!(set("project", "1").await.is_err());
    let updated = set("global", "1").await.unwrap();
    assert_eq!(updated["remoteDevelopment"]["idleTimeoutMinutes"], 1);
    assert!(std::fs::read_to_string(base.join("config/settings.toml")).unwrap().contains("idleTimeoutMinutes = 1"));
    if never {
        // A different project's daemon can change the host preference after this window connected.
        let other = ide_workspace::SettingsStore::load(&base.join("config"), None);
        other.set(ide_workspace::SettingsScope::Global, "remoteDevelopment.idleTimeoutMinutes", json!(0)).unwrap();
        assert_eq!(invoke(&peer, "remote_idle_timeout_minutes", json!({})).await.unwrap(), 0);
    }
    let disconnect = std::time::Instant::now();
    peer.kill();
    peer.exited().await;
    if never {
        assert!(
            tokio::time::timeout(Duration::from_secs(72), daemon.wait()).await.is_err(),
            "Never expired at the previous one-minute timeout"
        );
        let (resumed, _) = attach_client(&home, &base, "~/demo", 1);
        assert!(!invoke(&resumed, "project_current", json!({})).await.unwrap().is_null());
        shutdown(&resumed).await;
    }
    let status =
        tokio::time::timeout(Duration::from_secs(80), daemon.wait()).await.expect("saved timeout not used").unwrap();
    assert!(status.success());
    assert!(disconnect.elapsed() >= Duration::from_secs(60), "daemon stopped before the configured minute");
    assert!(!guard.0.exists());
}

async fn looping_terminal(peer: &Peer, project: &Path) -> Value {
    invoke(
        peer,
        "term_spawn",
        json!({
            "options": {
                "cwd": project, "shell": "/bin/sh", "args": ["-c", "exec sleep 300"],
                "env": {}, "cols": 80, "rows": 24, "shellIntegration": false
            },
            "onOutput": { "$channel": 1 }
        }),
    )
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_takeover_notifies_the_first_window_and_keeps_its_terminal() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("h");
    let base = tmp.path().join("s");
    let project = home.join("demo");
    std::fs::create_dir_all(&project).unwrap();
    let _guard = DaemonGuard(ide_host::daemon::paths_for(&base, &home, "~/demo").unwrap().socket);
    let (first, original) = attach_client(&home, &base, "~/demo", 1);
    initialize(&first).await;
    invoke(&first, "open_project", json!({ "path": project })).await.unwrap();
    invoke(&first, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();
    let term = looping_terminal(&first, &project).await;

    let (second, _) = attach_client(&home, &base, "~/demo", 1);
    initialize(&second).await;
    tokio::time::timeout(Duration::from_secs(5), first.closed()).await.expect("first window was not disconnected");
    assert!(original.taken_over.load(Ordering::Acquire), "the first window saw an unexplained EOF");
    assert_eq!(invoke(&second, "term_list", json!({})).await.unwrap()[0]["id"], term["id"]);

    second.kill();
    second.exited().await;
    tokio::time::sleep(Duration::from_millis(2300)).await;
    let (third, _) = attach_client(&home, &base, "~/demo", 1);
    initialize(&third).await;
    assert_eq!(invoke(&third, "term_list", json!({})).await.unwrap()[0]["id"], term["id"]);
    shutdown(&third).await;
    until("terminal child stopped", || !pid_alive(term["pid"].as_u64().unwrap() as u32)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upgraded_build_refuses_live_work_and_then_replaces_idle_backend() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    const OLD_BUILD: &str = "0123456789abcdef";
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("h");
    let base = tmp.path().join("s");
    let project = home.join("demo");
    std::fs::create_dir_all(&project).unwrap();
    let guard = DaemonGuard(ide_host::daemon::paths_for(&base, &home, "~/demo").unwrap().socket);
    let mut previous_build = tokio::process::Command::new(SERVER)
        .arg("--daemon")
        .arg(&guard.0)
        .arg(OLD_BUILD)
        .envs(server_env(&home, &base, 10_800))
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    until("old backend socket", || guard.0.exists()).await;
    let old_open = || async {
        let mut stream = UnixStream::connect(&guard.0).await.unwrap();
        stream.write_all(OLD_BUILD.as_bytes()).await.unwrap();
        assert_eq!(stream.read_u8().await.unwrap(), b'A');
        let (reader, writer) = stream.into_split();
        Peer::connect(reader, writer, Arc::new(Client::default()))
    };
    let old = old_open().await;
    initialize(&old).await;
    invoke(&old, "open_project", json!({ "path": project })).await.unwrap();
    invoke(&old, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();
    let term = looping_terminal(&old, &project).await;
    old.kill();
    old.closed().await;

    let rejected = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(SERVER)
            .args(["--attach", "~/demo"])
            .envs(server_env(&home, &base, 10_800))
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("Another build of OpenIDEA"), "{rejected:?}");
    assert!(previous_build.try_wait().unwrap().is_none(), "the live backend was replaced");
    let resumed = old_open().await;
    assert_eq!(invoke(&resumed, "term_list", json!({})).await.unwrap()[0]["id"], term["id"]);
    invoke(&resumed, "term_kill", json!({ "id": term["id"] })).await.unwrap();
    resumed.kill();
    resumed.closed().await;

    let (new, _) = attach_client(&home, &base, "~/demo", 10_800);
    initialize(&new).await;
    let old_exit = tokio::time::timeout(Duration::from_secs(5), previous_build.wait()).await.unwrap().unwrap();
    assert!(old_exit.success(), "handoff did not shut down the old daemon cleanly");
    assert!(invoke(&new, "project_current", json!({})).await.unwrap().is_null());
    shutdown(&new).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a Docker context with Docker Compose and the busybox image"]
async fn compose_service_survives_disconnect_and_is_removed_on_stop() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("h");
    let base = tmp.path().join("s");
    let project = home.join("demo");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(
        project.join("compose.yml"),
        "services:\n  worker:\n    image: busybox:latest\n    command: ['sleep', '300']\n    stop_grace_period: 1s\n",
    )
    .unwrap();
    let suffix = tmp.path().file_name().unwrap().to_str().unwrap().trim_start_matches('.').to_ascii_lowercase();
    let name = format!("openidea-compose-{suffix}");
    let docker = ide_docker::docker_executable().expect("Docker is not installed");
    // The test server has its own HOME; keep Docker Desktop's CLI plugins and context accessible.
    let docker_config = std::env::var_os("DOCKER_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().expect("home").join(".docker"));

    struct ComposeCleanup<'a>(&'a Path, &'a Path, &'a str);
    impl Drop for ComposeCleanup<'_> {
        fn drop(&mut self) {
            let _ = std::process::Command::new(self.0)
                .current_dir(self.1)
                .args(["compose", "-p", self.2, "down", "--timeout", "1"])
                .output();
        }
    }

    let _compose = ComposeCleanup(&docker, &project, &name);
    let guard = DaemonGuard(ide_host::daemon::paths_for(&base, &home, "~/demo").unwrap().socket);
    let compose_ids = |all| {
        let mut cmd = tokio::process::Command::new(&docker);
        cmd.current_dir(&project).args(["compose", "-p", &name, "ps", "-q"]);
        if all {
            cmd.arg("-a");
        }
        async move {
            let out = cmd.output().await.unwrap();
            assert!(out.status.success(), "docker compose ps: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8(out.stdout).unwrap().trim().to_owned()
        }
    };

    let (first, client) = attach_client(&home, &base, "~/demo", 1);
    initialize(&first).await;
    invoke(&first, "open_project", json!({ "path": project })).await.unwrap();
    invoke(&first, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();
    let run = invoke(
        &first,
        "run_start",
        json!({
            "config": {
                "id": "docker:compose:worker", "name": "Compose worker", "kind": "docker-compose",
                "command": docker, "args": ["compose", "-p", name, "up", "--pull", "never"], "cwd": project,
                "env": { "DOCKER_CONFIG": docker_config }, "detected": false, "isTest": false,
                "stopCommand": format!("{} compose -p {name} down", ide_ssh::shell::quote(docker.to_str().unwrap())),
            },
            "onOutput": { "$channel": 1 }, "request": 1,
        }),
    )
    .await
    .unwrap();
    let container = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let id = compose_ids(false).await;
            if !id.is_empty() {
                break id;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the compose service did not start: {:?}", client.channels.lock()));

    first.kill();
    first.exited().await;
    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert_eq!(compose_ids(false).await, container, "close without stop interrupted the compose service");
    let (second, _) = attach_client(&home, &base, "~/demo", 1);
    initialize(&second).await;
    let runs = invoke(&second, "run_list", json!({})).await.unwrap();
    assert!(runs.as_array().unwrap().iter().any(|r| r["id"] == run["id"] && r["running"] == true));
    shutdown(&second).await;
    assert!(!guard.0.exists());
    assert!(compose_ids(true).await.is_empty(), "the stop command did not remove the compose service");
}
