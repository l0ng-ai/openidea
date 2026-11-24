//! Binary command arguments over the remote protocol: base64 strings, not arrays of numbers.

mod common;

use ide_core::IpcBytes;
use ide_host::Host;
use ide_host::rpc::{self, Dispatcher, Invoke};
use ide_jsonrpc::{Handler, Peer};
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};

struct Client;

impl Handler for Client {
    fn on_notification(&self, _: &str, _: Value) {}
    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
    }
}

async fn connect(base: &std::path::Path) -> Peer {
    let host = Arc::new(Host::new(common::host_config(base)));
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host, Dispatcher::standard(), Arc::new(OnceLock::new()), sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    Peer::connect(cr, cw, Arc::new(Client))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn file_bytes_cross_the_protocol_as_base64() {
    let tmp = tempfile::tempdir().unwrap();
    let peer = connect(tmp.path()).await;
    let bytes: Vec<u8> = (0..=255).cycle().take(3 * 1024 * 1024 + 1).collect();
    let path = tmp.path().join("image.bin");

    let args = json!({ "path": path, "data": IpcBytes(bytes.clone()) });
    assert!(args["data"].is_string());
    // Measure the envelope separately so the assertion is independent of the temp directory.
    let envelope = serde_json::to_vec(&json!({ "path": path, "data": "" })).unwrap();
    let body = serde_json::to_vec(&args).unwrap();
    assert_eq!(body.len(), envelope.len() + bytes.len().div_ceil(3) * 4);

    let call = Invoke { window: "main".into(), cmd: "fs_create_file_bytes".into(), args };
    peer.request::<_, Value>("invoke", call, None).await.map_err(rpc::error_from_reply).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_array_of_numbers_is_not_accepted_as_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let peer = connect(tmp.path()).await;
    let path = tmp.path().join("old.bin");
    let call = Invoke {
        window: "main".into(),
        cmd: "fs_create_file_bytes".into(),
        args: json!({ "path": path, "data": [1, 2, 3] }),
    };
    let error = peer.request::<_, Value>("invoke", call, None).await.map_err(rpc::error_from_reply).unwrap_err();
    assert!(error.message.contains("argument data"), "{error:?}");
    assert!(!path.exists());
}
