//! Language servers reached over TCP (`connect`, the Godot editor's GDScript
//! server) against a mock LSP server on a local socket.

use ide_core::event::ServerStatus;
use ide_core::{CancellationToken, DocId, IdeEvent, LanguageId, Pos};
use ide_jsonrpc::{Handler, Peer};
use ide_language::{LanguageConfig, LanguageRegistry, LanguageServerConfig};
use ide_lsp::{LaunchError, Launcher, LspManager, ProcessLauncher};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Default)]
struct ServerLog {
    requests: Mutex<Vec<String>>,
    notifications: Mutex<Vec<String>>,
    /// Server ends of the accepted connections.
    peers: Mutex<Vec<Peer>>,
}

struct MockHandler(Arc<ServerLog>);

impl Handler for MockHandler {
    fn on_notification(&self, method: &str, _params: Value) {
        self.0.notifications.lock().push(method.to_owned());
    }

    fn on_request(&self, method: &str, _params: Value) -> Result<Value, (i64, String)> {
        self.0.requests.lock().push(method.to_owned());
        match method {
            "initialize" => Ok(json!({
                "capabilities": { "textDocumentSync": 1, "hoverProvider": true },
                "serverInfo": { "name": "mock-godot" }
            })),
            "textDocument/hover" => Ok(json!({ "contents": { "kind": "markdown", "value": "**Node2D**" } })),
            _ => Ok(Value::Null),
        }
    }
}

/// Accepts LSP connections on a local port, like the Godot editor on 6005.
async fn mock_server() -> (u16, Arc<ServerLog>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let log = Arc::new(ServerLog::default());
    let accept = {
        let log = log.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (r, w) = stream.into_split();
                let peer = Peer::connect(r, w, Arc::new(MockHandler(log.clone())));
                log.peers.lock().push(peer);
            }
        })
    };
    (port, log, accept)
}

fn godot_cfg(port: u16, command: &str) -> LanguageServerConfig {
    toml::from_str(&format!(
        "name = \"godot\"\ncommand = \"{command}\"\nconnect = \"127.0.0.1:{port}\"\nroot-markers = [\"project.godot\"]\ninstall-hint = \"Open the project in the Godot editor\""
    ))
    .unwrap()
}

struct Harness {
    _dir: tempfile::TempDir,
    root: PathBuf,
    mgr: Arc<LspManager>,
    events: Arc<Mutex<Vec<IdeEvent>>>,
}

fn harness(server: LanguageServerConfig) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("project.godot"), "config_version=5\n").unwrap();
    let lang: LanguageConfig = toml::from_str("id = \"gdscript\"\nname = \"GDScript\"\nextensions = [\"gd\"]").unwrap();
    let lang = LanguageConfig { language_servers: vec![server], ..lang };
    let registry = Arc::new(LanguageRegistry::from_configs(vec![lang]));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let mgr = LspManager::with_launcher(root.clone(), registry, sink, Arc::new(ProcessLauncher));
    Harness { _dir: dir, root, mgr, events }
}

impl Harness {
    fn open(&self, name: &str, text: &str) -> DocId {
        let path = self.root.join(name);
        std::fs::write(&path, text).unwrap();
        let doc = DocId::next();
        self.mgr.did_open(doc, &path, &LanguageId::new("gdscript"), 1, text);
        doc
    }

    fn statuses(&self) -> Vec<(ServerStatus, Option<String>)> {
        self.events
            .lock()
            .iter()
            .filter_map(|e| match e {
                IdeEvent::LanguageServer { status, message, .. } => Some((*status, message.clone())),
                _ => None,
            })
            .collect()
    }

    async fn wait_status(&self, status: ServerStatus, count: usize) {
        eventually(|| self.statuses().iter().filter(|(s, _)| *s == status).count() >= count).await;
    }
}

async fn eventually(mut f: impl FnMut() -> bool) {
    for _ in 0..1000 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached in time");
}

#[tokio::test(flavor = "multi_thread")]
async fn connects_to_a_running_server_requests_and_reconnects() {
    let (port, log, _accept) = mock_server().await;
    let h = harness(godot_cfg(port, "openidea-no-such-godot"));
    let doc = h.open("player.gd", "extends Node2D\n");
    h.wait_status(ServerStatus::Ready, 1).await;
    assert_eq!(log.requests.lock().first().map(String::as_str), Some("initialize"));
    eventually(|| log.notifications.lock().iter().any(|m| m == "textDocument/didOpen")).await;

    let hover = h.mgr.hover(doc, Pos::new(0, 9), CancellationToken::new()).await.unwrap().unwrap();
    assert!(format!("{hover:?}").contains("Node2D"), "{hover:?}");
    // Attached to a server it didn't start: no process id.
    assert_eq!(h.mgr.servers()[0].pid, None);

    // The editor drops the connection (closed or restarted): the client reconnects and reopens.
    log.peers.lock().remove(0).kill();
    h.wait_status(ServerStatus::Crashed, 1).await;
    let (_, message) = h.statuses().into_iter().rfind(|(s, _)| *s == ServerStatus::Crashed).unwrap();
    assert!(message.unwrap().contains(&format!("127.0.0.1:{port}")));
    h.wait_status(ServerStatus::Ready, 2).await;
    eventually(|| log.notifications.lock().iter().filter(|m| *m == "textDocument/didOpen").count() == 2).await;
    assert_eq!(log.requests.lock().iter().filter(|m| *m == "initialize").count(), 2);

    // Shutting down leaves a server it didn't start running: no `shutdown` / `exit`.
    h.mgr.shutdown_all().await;
    eventually(|| log.peers.lock().iter().all(Peer::is_closed)).await;
    assert!(!log.requests.lock().iter().any(|m| m == "shutdown"));
    assert!(!log.notifications.lock().iter().any(|m| m == "exit"));
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_listening_and_no_executable_reports_how_to_fix_it() {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    let h = harness(godot_cfg(port, "openidea-no-such-godot"));
    h.open("player.gd", "extends Node\n");
    h.wait_status(ServerStatus::Missing, 1).await;
    let (_, message) = h.statuses().into_iter().rfind(|(s, _)| *s == ServerStatus::Missing).unwrap();
    assert_eq!(message.as_deref(), Some("Open the project in the Godot editor"));
}

/// The command is started when nothing listens yet, the client waits until the
/// port accepts, and the started process belongs to the connection.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn starts_the_command_and_waits_until_it_listens() {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    let cfg = LanguageServerConfig { args: vec!["30".into()], ..godot_cfg(port, "sleep") };
    let root = tempfile::tempdir().unwrap();
    // The "server" (`sleep`) never listens itself; a listener comes up a moment later.
    let log = Arc::new(ServerLog::default());
    let server = {
        let log = log.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
            let (stream, _) = listener.accept().await.unwrap();
            let (r, w) = stream.into_split();
            log.peers.lock().push(Peer::connect(r, w, Arc::new(MockHandler(log.clone()))));
        })
    };
    let path = root.path().to_path_buf();
    let peer = tokio::task::spawn_blocking(move || {
        ProcessLauncher.launch(&cfg, &path, Arc::new(ide_jsonrpc::NoopHandler), Box::new(|_| {}))
    })
    .await
    .unwrap()
    .unwrap_or_else(|e| panic!("{e:?}"));
    server.await.unwrap();
    let pid = peer.pid().expect("owns the started process");
    let init: Value = peer.request("initialize", json!({}), None).await.unwrap();
    assert_eq!(init["serverInfo"]["name"], "mock-godot");

    peer.kill();
    peer.closed().await;
    eventually(|| !process_alive(pid)).await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_command_that_exits_without_listening_fails_and_cancel_stops_waiting() {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    let root = tempfile::tempdir().unwrap();
    let path = root.path().to_path_buf();
    let cfg = godot_cfg(port, "false");
    let err = tokio::task::spawn_blocking(move || {
        ProcessLauncher.launch(&cfg, &path, Arc::new(ide_jsonrpc::NoopHandler), Box::new(|_| {}))
    })
    .await
    .unwrap()
    .err()
    .expect("fails");
    assert!(matches!(&err, LaunchError::Failed(m) if m.contains("exited before accepting connections")), "{err:?}");

    let cfg = LanguageServerConfig { args: vec!["30".into()], ..godot_cfg(port, "sleep") };
    let path = root.path().to_path_buf();
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let started = std::time::Instant::now();
    let waiting = tokio::task::spawn_blocking(move || {
        ProcessLauncher.launch_cancellable(&cfg, &path, Arc::new(ide_jsonrpc::NoopHandler), Box::new(|_| {}), &token)
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    cancel.cancel();
    let err = waiting.await.unwrap().err().expect("cancelled");
    assert!(matches!(&err, LaunchError::Failed(m) if m.contains("cancelled")), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
