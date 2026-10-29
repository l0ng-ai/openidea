//! The remote protocol end to end: a server on one side of an in-memory pipe,
//! a JSON-RPC client on the other.

use ide_host::rpc::{self, ChannelMessage, Dispatcher, EventMessage, Invoke, ServerInfo};
use ide_host::{Host, HostConfig};
use ide_jsonrpc::{Handler, Peer};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
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
    for _ in 0..500 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn serves_projects_files_documents_search_and_runs() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("demo");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("src/main.py"), "print('needle')\n").unwrap();
    let base = tmp.path().join("server");

    let peer_slot = Arc::new(OnceLock::new());
    let sink_peer = peer_slot.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |w| rpc::event_sink(sink_peer.clone(), Some(w.to_owned()))),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host, Dispatcher::standard(), peer_slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let client = Arc::new(Client::default());
    let peer = Peer::connect(cr, cw, client.clone());

    let info: ServerInfo = peer.request("initialize", json!({ "version": 1 }), None).await.unwrap();
    assert_eq!(info.protocol, rpc::PROTOCOL_VERSION);

    let opened = invoke(&peer, "open_project", json!({ "path": project })).await.unwrap();
    assert_eq!(opened["name"], "demo");
    let current = invoke(&peer, "project_current", json!({})).await.unwrap();
    assert_eq!(current["name"], "demo");

    let entries = invoke(&peer, "fs_read_dir", json!({ "path": project })).await.unwrap();
    assert!(entries.as_array().unwrap().iter().any(|e| e["name"] == "src"), "{entries}");

    // Edit and save a document.
    let file = project.join("src/main.py");
    let doc = invoke(&peer, "doc_open", json!({ "path": file })).await.unwrap();
    let id = doc["id"].clone();
    let version = doc["version"].as_u64().unwrap();
    let changes = json!({ "changes": [{ "from": 16, "to": 16, "insert": "print('more')\n" }] });
    invoke(&peer, "doc_edit", json!({ "doc": id, "baseVersion": version, "changes": changes })).await.unwrap();
    invoke(&peer, "doc_save", json!({ "doc": id })).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "print('needle')\nprint('more')\n");

    // Commands shared with the desktop shell (camelCase argument names, as Tauri takes them).
    invoke(&peer, "doc_set_line_ending", json!({ "doc": id, "lineEnding": "crLf" })).await.unwrap();
    invoke(&peer, "doc_save", json!({ "doc": id })).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "print('needle')\r\nprint('more')\r\n");
    let settings = invoke(
        &peer,
        "settings_set",
        json!({ "scope": "project", "key": "deployment.autoUpload",
        "value": "\"always\"" }),
    )
    .await
    .unwrap();
    assert_eq!(settings["deployment"]["autoUpload"], "always");
    assert!(std::fs::read_to_string(project.join(".openidea/settings.toml")).unwrap().contains("autoUpload"));
    invoke(&peer, "vcs_init", json!({ "dir": project })).await.unwrap();
    until("git repository", || project.join(".git").is_dir()).await;

    // Real project-host ignore writes travel through the remote command dispatcher.
    assert!(Dispatcher::standard().commands().contains(&"vcs_add_to_ignore"));
    let ignore_root = dunce::canonicalize(&project).unwrap();
    for (name, destination) in [("shared.tmp", "gitignore"), ("private.tmp", "localExclude")] {
        let path = ignore_root.join(name);
        std::fs::write(&path, "temporary").unwrap();
        invoke(&peer, "vcs_add_to_ignore", json!({ "paths": [path], "destination": destination })).await.unwrap();
        let entries = invoke(&peer, "fs_read_dir", json!({ "path": ignore_root })).await.unwrap();
        let entry = entries.as_array().unwrap().iter().find(|e| e["name"] == name).unwrap();
        assert_eq!(entry["ignored"], true);
        assert_eq!(entry["excluded"], false);
    }
    assert!(std::fs::read_to_string(project.join(".gitignore")).unwrap().contains("/shared.tmp"));
    assert!(std::fs::read_to_string(project.join(".git/info/exclude")).unwrap().contains("/private.tmp"));
    let outside = tmp.path().join("outside.tmp");
    std::fs::write(&outside, "keep").unwrap();
    assert!(
        invoke(&peer, "vcs_add_to_ignore", json!({ "paths": [outside], "destination": "gitignore" })).await.is_err()
    );

    // Unknown commands and bad arguments come back as IdeErrors.
    let e = invoke(&peer, "window_minimize", json!({})).await.unwrap_err();
    assert!(e.message.contains("not available remotely"), "{e:?}");
    let e = invoke(&peer, "doc_save", json!({ "doc": "nope" })).await.unwrap_err();
    assert_eq!(e.kind, ide_core::error::ErrorKind::InvalidInput, "{e:?}");

    // Find in Files streams through a channel.
    let query = json!({ "pattern": "needle", "isRegex": false, "caseSensitive": false, "wholeWord": false,
        "include": [], "exclude": [], "scope": { "kind": "project" }, "maxMatches": 0 });
    invoke(&peer, "search_start", json!({ "request": 7, "query": query, "onEvent": { "$channel": 1 } })).await.unwrap();
    let found = client.channels.lock().iter().filter(|c| c.id == 1).map(|c| c.data.clone()).collect::<Vec<_>>();
    assert!(found.iter().any(|d| d["type"] == "file"), "{found:?}");
    assert_eq!(found.last().unwrap()["type"], "done");

    // A run's output streams through a channel and its exit is an event.
    let config = json!({ "id": "echo", "name": "echo", "kind": "shell", "command": "echo", "args": ["remote-hi"],
        "cwd": null, "env": {}, "detected": false, "isTest": false, "debugAdapter": null });
    invoke(&peer, "run_start", json!({ "config": config, "onOutput": { "$channel": 2 } })).await.unwrap();
    until("run exit", || client.events.lock().iter().any(|e| e.event_type() == "runExited")).await;
    let out: String = client
        .channels
        .lock()
        .iter()
        .filter(|c| c.id == 2)
        .filter_map(|c| c.data["text"].as_str().map(str::to_owned))
        .collect();
    assert!(out.contains("remote-hi"), "{out}");
    assert_eq!(
        client.events.lock().iter().find(|e| e.event_type() == "runExited").unwrap().window.as_deref(),
        Some("main")
    );
}

trait EventType {
    fn event_type(&self) -> String;
}

impl EventType for EventMessage {
    fn event_type(&self) -> String {
        serde_json::to_value(&self.event).unwrap()["type"].as_str().unwrap_or_default().to_owned()
    }
}
