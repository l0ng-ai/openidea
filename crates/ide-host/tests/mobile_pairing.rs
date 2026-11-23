//! A phone paired over iroh drives the desktop's backend: it pairs with a ticket's code,
//! opens a project in a window of its own and gets that window's events back, the way
//! `src-tauri/src/mobile.rs` wires `ide_pair` to `rpc::serve_scoped`.

use ide_host::rpc::{self, Dispatcher, EventMessage, Invoke};
use ide_host::{Host, HostConfig};
use ide_jsonrpc::{Handler, Peer};
use ide_pair::{DeviceStore, Listener, SessionHandler};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

#[derive(Default)]
struct Phone {
    events: Mutex<Vec<EventMessage>>,
}

impl Handler for Phone {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "event" {
            self.events.lock().push(serde_json::from_value(params).unwrap());
        }
    }
    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
    }
}

type Peers = Arc<Mutex<HashMap<String, Arc<OnceLock<Peer>>>>>;

fn scope_for(id: &str) -> String {
    format!("mobile-{}-", &id[..12])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_paired_phone_opens_a_project_on_the_desktop_and_gets_its_events() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("demo");
    std::fs::create_dir_all(&project).unwrap();
    let base = tmp.path().join("desktop");

    // The desktop: one host, its phones' windows routed to their connections.
    let peers: Peers = Peers::default();
    let sink_peers = peers.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |w| {
            let scope = w.splitn(3, '-').take(2).collect::<Vec<_>>().join("-") + "-";
            let peer = sink_peers.lock().entry(scope).or_default().clone();
            rpc::event_sink(peer, Some(w.to_owned()))
        }),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let serving_host = host.clone();
    let serving_peers = peers.clone();
    let handler: SessionHandler = Arc::new(move |session| {
        let host = serving_host.clone();
        let peers = serving_peers.clone();
        Box::pin(async move {
            let scope = scope_for(&session.device.id);
            let peer = Arc::new(OnceLock::new());
            peers.lock().insert(scope.clone(), peer.clone());
            rpc::serve_scoped(host, Dispatcher::standard(), peer, session.recv, session.send, Some(scope)).await;
        })
    });
    let listener = Listener::start(
        ide_pair::bind_local(true).await,
        DeviceStore::load(base.join("config").join("mobile-devices.json")),
        "Workstation".into(),
        handler,
        Arc::new(|| {}),
    );
    let ticket = listener.ticket(Duration::from_secs(60)).await.0;

    // The phone scans the ticket.
    let scanned = ide_pair::Ticket::decode(&ticket.encode()).unwrap();
    let phone = ide_pair::bind_local(false).await;
    let (_conn, welcome, send, recv) =
        ide_pair::connect(&phone, scanned.addr, "Pixel", Some(&scanned.code)).await.unwrap();
    assert_eq!(welcome.desktop, "Workstation");
    let client = Arc::new(Phone::default());
    let peer = Peer::connect(recv, send, client.clone());
    let window = format!("{}1", scope_for(&phone.id().to_string()));
    let invoke = |cmd: &str, args: Value| Invoke { window: window.clone(), cmd: cmd.into(), args };

    let opened: Value = peer.request("invoke", invoke("open_project", json!({ "path": project })), None).await.unwrap();
    assert_eq!(opened["name"], "demo");

    let file = project.join("notes.txt");
    std::fs::write(&file, "old").unwrap();
    let edit = json!({ "files": [{ "kind": "edit", "path": file, "edits": [{
        "range": { "start": { "line": 0, "col": 0 }, "end": { "line": 0, "col": 3 } },
        "new_text": "new"
    }] }] });
    let prepared: Value =
        peer.request("invoke", invoke("prepare_workspace_edit", json!({ "edit": edit })), None).await.unwrap();
    let _: Value =
        peer.request("invoke", invoke("apply_workspace_edit", json!({ "edit": prepared })), None).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
    for _ in 0..500 {
        let got = client.events.lock().iter().any(|e| {
            e.window.as_deref() == Some(window.as_str())
                && matches!(e.event, ide_core::IdeEvent::WorkspaceEditApplied { .. })
        });
        if got {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the phone got no event for its window");
}
