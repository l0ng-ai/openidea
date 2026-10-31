//! The MCP protocol over the HTTP handler: initialize, sessions, auth, tools/list, tools/call.

mod common;

use common::{Harness, PORT, TOKEN};
use serde_json::{Value, json};

#[tokio::test(flavor = "multi_thread")]
async fn initializes_and_lists_tools() {
    let h = Harness::new(&[("a.txt", "hello\n")]).await;
    let init = h.initialize("claude-code").await;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "openidea");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    assert_eq!(h.server.status().clients[0].name, "claude-code");

    let (status, _, body) = h.post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    assert_eq!((status, body.as_str()), (202, ""));

    let (_, _, body) = h.post(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    let v: Value = serde_json::from_str(&body).unwrap();
    let tools = v["result"]["tools"].as_array().unwrap();
    let read = tools.iter().find(|t| t["name"] == "read_file").expect("read_file listed");
    assert_eq!(read["inputSchema"]["required"], json!(["file_path"]));
    assert!(read["inputSchema"]["properties"]["projectPath"].is_object());
    assert_eq!(read["annotations"]["readOnlyHint"], true);

    let (_, _, body) = h.post(json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" })).await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"], json!({}));
    let (_, _, body) = h.post(json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" })).await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["error"]["code"], -32601);
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_versions_get_the_newest() {
    let h = Harness::new(&[]).await;
    let (_, _, body) = h
        .post(
            json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } }),
        )
        .await;
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["result"]["protocolVersion"], ide_mcp::protocol::PROTOCOL_VERSIONS[0]);
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_bad_token_host_origin_and_sessions() {
    let h = Harness::new(&[]).await;
    let host = format!("127.0.0.1:{PORT}");
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let (s, _, _) = h.server.handle_for_test(PORT, "POST", &[("Host", &host)], body).await;
    assert_eq!(s, 401);
    let (s, _, _) =
        h.server.handle_for_test(PORT, "POST", &[("Host", &host), ("Authorization", "Bearer wrong")], body).await;
    assert_eq!(s, 401);
    let auth = format!("Bearer {TOKEN}");
    let (s, _, _) =
        h.server.handle_for_test(PORT, "POST", &[("Host", "evil.example:80"), ("Authorization", &auth)], body).await;
    assert_eq!(s, 403);
    let (s, _, _) = h
        .server
        .handle_for_test(
            PORT,
            "POST",
            &[("Host", &host), ("Authorization", &auth), ("Origin", "https://evil.example")],
            body,
        )
        .await;
    assert_eq!(s, 403);
    let (s, _, _) = h
        .server
        .handle_for_test(PORT, "POST", &[("Host", &host), ("Authorization", &auth), ("Mcp-Session-Id", "gone")], body)
        .await;
    assert_eq!(s, 404);
    let (s, _, _) = h.server.handle_for_test(PORT, "GET", &[("Host", &host), ("Authorization", &auth)], "").await;
    assert_eq!(s, 405);
    let (s, _, _) = h.server.handle_for_test(PORT, "POST", &[("Host", &host), ("Authorization", &auth)], "{nope").await;
    assert_eq!(s, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn calls_tools_and_reports_errors_as_tool_results() {
    let h = Harness::new(&[("src/a.txt", "one\ntwo\n")]).await;
    assert_eq!(h.call("read_file", json!({ "file_path": "src/a.txt" })).await, "1\tone\n2\ttwo\n");
    let root = h.root.to_string_lossy().into_owned();
    assert_eq!(
        h.call("read_file", json!({ "file_path": "src/a.txt", "offset": 2, "projectPath": root })).await,
        "2\ttwo\n"
    );
    let msg = h.call_err("read_file", json!({ "file_path": "missing.txt" })).await;
    assert!(!msg.is_empty());
    let msg =
        h.call_err("read_file", json!({ "file_path": "src/a.txt", "projectPath": "/definitely/elsewhere" })).await;
    assert!(msg.contains("No open project"), "{msg}");
    let msg = h.call_err("read_file", json!({})).await;
    assert!(msg.contains("file_path"), "{msg}");

    let (_, _, body) = h
        .post(json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": "no_such_tool" } }))
        .await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["error"]["code"], -32602);
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_directory_trees() {
    let h = Harness::new(&[("src/main.rs", ""), ("src/lib/mod.rs", ""), ("README.md", "")]).await;
    let tree = h.call("list_directory_tree", json!({ "directoryPath": "." })).await;
    assert!(tree.contains("├── src/") || tree.contains("└── src/"), "{tree}");
    assert!(tree.contains("main.rs") && tree.contains("mod.rs") && tree.contains("README.md"), "{tree}");
    let shallow = h.call("list_directory_tree", json!({ "maxDepth": 1 })).await;
    assert!(!shallow.contains("main.rs"), "{shallow}");
}

#[tokio::test(flavor = "multi_thread")]
async fn batches_and_disabled_tools() {
    let h = Harness::new(&[("a.txt", "x\n")]).await;
    h.initialize("c").await;
    let (_, _, body) = h
        .post(json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }, { "jsonrpc": "2.0", "method": "notifications/initialized" }]))
        .await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap().as_array().unwrap().len(), 1);
    let settings = ide_core::mcp::McpSettings { disabled_tools: vec!["read_file".into()], ..Default::default() };
    h.server.apply(&settings).await;
    let (_, _, body) = h.post(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    assert!(!body.contains("\"read_file\""));
    assert!(!h.server.tools(&settings).iter().find(|t| t.name == "read_file").unwrap().enabled);
}

#[tokio::test(flavor = "multi_thread")]
async fn starts_and_stops_listening() {
    let h = Harness::new(&[]).await;
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let on = ide_core::mcp::McpSettings { enabled: true, port, ..Default::default() };
    let status = h.server.apply(&on).await;
    assert!(status.running, "{status:?}");
    assert_eq!(status.url.as_deref(), Some(format!("http://127.0.0.1:{port}/mcp").as_str()));
    // A second server on the same port reports the conflict.
    let other = Harness::new(&[]).await;
    let status = other.server.apply(&on).await;
    assert!(!status.running && status.error.as_deref().unwrap_or("").contains("in use"), "{status:?}");
    // Real HTTP round trip.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let req = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(req.as_bytes()).await.unwrap();
    let mut out = String::new();
    sock.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(out.ends_with(r#"{"id":1,"jsonrpc":"2.0","result":{}}"#), "{out}");
    let status = h.server.apply(&ide_core::mcp::McpSettings { enabled: false, port, ..Default::default() }).await;
    assert!(!status.running);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err());
}
