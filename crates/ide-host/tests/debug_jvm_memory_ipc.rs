//! The JVM instance commands resolve the caller's project through the window label, so a
//! client that sends no real window (the desktop shell once passed `""`) never reaches the debugger.

use ide_core::{IdeError, NullSink};
use ide_host::rpc::{self, Dispatcher, Invoke};
use ide_host::{Host, HostConfig};
use ide_jsonrpc::{Handler, Peer};
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};

struct Silent;
impl Handler for Silent {
    fn on_notification(&self, _: &str, _: Value) {}
    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
    }
}

async fn invoke(peer: &Peer, window: &str, cmd: &str, args: Value) -> Result<Value, IdeError> {
    let call = Invoke { window: window.into(), cmd: cmd.into(), args };
    peer.request::<_, Value>("invoke", call, None).await.map_err(rpc::error_from_reply)
}

const NO_SESSION: i64 = 4242;

fn calls() -> [(&'static str, Value); 3] {
    let object = json!({"generation": 1, "id": 7});
    [
        ("debug_jvm_memory_instances", json!({"session": NO_SESSION, "className": "java.lang.String", "limit": 10})),
        ("debug_jvm_memory_fields", json!({"session": NO_SESSION, "object": object})),
        ("debug_jvm_memory_referrers", json!({"session": NO_SESSION, "object": object, "limit": 10})),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn instance_commands_reach_the_debugger_from_a_trusted_window() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    std::fs::create_dir(&root).unwrap();
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

    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host, Dispatcher::standard(), Arc::new(OnceLock::new()), sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let peer = Peer::connect(cr, cw, Arc::new(Silent));
    peer.request::<_, Value>("initialize", json!({"version": rpc::PROTOCOL_VERSION}), None).await.unwrap();

    for (command, args) in calls() {
        let error = invoke(&peer, "main", command, args.clone()).await.unwrap_err();
        assert!(
            error.message.contains(&format!("no debug session {NO_SESSION}")),
            "{command} should get as far as the session lookup: {error:?}"
        );
        let error = invoke(&peer, "", command, args).await.unwrap_err();
        assert!(error.message.contains("no project"), "{command} without a window label: {error:?}");
    }
}
