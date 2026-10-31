//! The MCP protocol over the HTTP handler: initialize, sessions, auth, tools/list, tools/call.

mod common;

use common::{Harness, PORT, TOKEN};
use serde_json::{Value, json};

#[tokio::test(flavor = "multi_thread")]
async fn initializes_and_lists_tools() {
    let h = Harness::new(&[("a.txt", "hello\n")]).await;
    let init = h.initialize("claude-code").await;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "OpenIDEA MCP Server");
    assert_eq!(init["result"]["capabilities"]["tools"]["listChanged"], true);
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
    // A notification stream needs a session.
    let (s, _, _) = h.server.handle_for_test(PORT, "GET", &[("Host", &host), ("Authorization", &auth)], "").await;
    assert_eq!(s, 400);
    let (s, _, _) = h.server.handle_for_test(PORT, "PUT", &[("Host", &host), ("Authorization", &auth)], "").await;
    assert_eq!(s, 405);
    let (s, _, _) = h.server.handle_for_test(PORT, "POST", &[("Host", &host), ("Authorization", &auth)], "{nope").await;
    assert_eq!(s, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn calls_tools_and_reports_errors_as_tool_results() {
    let h = Harness::new(&[("src/a.txt", "one\ntwo\n")]).await;
    assert_eq!(h.call("read_file", json!({ "file_path": "src/a.txt" })).await, "L1: one\nL2: two\nL3: ");
    let root = h.root.to_string_lossy().into_owned();
    assert_eq!(
        h.call("read_file", json!({ "file_path": "src/a.txt", "offset": 2, "projectPath": root })).await,
        "L2: two\nL3: "
    );
    let msg = h.call_err("read_file", json!({ "file_path": "missing.txt" })).await;
    assert!(!msg.is_empty());
    let msg =
        h.call_err("read_file", json!({ "file_path": "src/a.txt", "projectPath": "/definitely/elsewhere" })).await;
    assert!(msg.contains("`projectPath`=`/definitely/elsewhere` doesn't correspond to any open project."), "{msg}");
    assert!(msg.contains("Currently open projects: {\"projects\":[{\"path\":"), "{msg}");
    let msg = h.call_err("read_file", json!({})).await;
    assert!(msg.contains("file_path"), "{msg}");

    let (_, _, body) = h
        .post(json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": "no_such_tool" } }))
        .await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["error"]["code"], -32602);
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

#[tokio::test(flavor = "multi_thread")]
async fn asks_before_reading_outside_the_project() {
    let h = Harness::new(&[("a.txt", "x\n")]).await;
    let outside = h.dir.path().join("secret.txt");
    std::fs::write(&outside, "token\n").unwrap();
    let path = outside.to_string_lossy().into_owned();
    *h.ui.answer.lock() = Value::Bool(false);
    let msg = h.call_err("read_file", json!({ "file_path": path })).await;
    assert!(msg.contains("declined"), "{msg}");
    assert!(matches!(h.ui.asked.lock().last(), Some(ide_core::mcp::McpUiRequest::Confirm { .. })));
    *h.ui.answer.lock() = Value::Bool(true);
    assert_eq!(h.call("read_file", json!({ "file_path": path })).await, "L1: token\nL2: ");
    // Inside the project nobody is asked.
    let asked = h.ui.asked.lock().len();
    h.call("read_file", json!({ "file_path": "a.txt" })).await;
    assert_eq!(h.ui.asked.lock().len(), asked);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_read_binary_files_as_text() {
    let h = Harness::new(&[]).await;
    std::fs::write(h.path("img.bin"), [0u8, 159, 146, 150, 0, 0, 1, 2]).unwrap();
    let msg = h.call_err("read_file", json!({ "file_path": "img.bin" })).await;
    assert!(msg.contains("binary"), "{msg}");
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_strangers_before_reading_bodies_and_restarts_quickly() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let h = Harness::new(&[]).await;
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let on = ide_core::mcp::McpSettings { enabled: true, port, ..Default::default() };
    assert!(h.server.apply(&on).await.running);

    // No token and a body that never comes: answered at once, not after reading it.
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 1000000\r\n\r\n");
    sock.write_all(head.as_bytes()).await.unwrap();
    let mut out = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(5), sock.read_to_string(&mut out)).await.unwrap().unwrap();
    assert!(out.starts_with("HTTP/1.1 401"), "{out}");

    // `Expect: 100-continue` gets its interim answer.
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let head = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nExpect: 100-continue\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    sock.write_all(head.as_bytes()).await.unwrap();
    let mut buf = [0u8; 25];
    sock.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"HTTP/1.1 100 Continue\r\n\r\n");
    sock.write_all(body.as_bytes()).await.unwrap();
    let mut out = String::new();
    sock.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");

    // Off and on again at once: the port is free by then.
    let off = ide_core::mcp::McpSettings { enabled: false, ..on.clone() };
    for _ in 0..3 {
        assert!(!h.server.apply(&off).await.running);
        let status = h.server.apply(&on).await;
        assert!(status.running, "{status:?}");
    }
    h.server.apply(&off).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn restricted_mode_keeps_execution_and_language_servers_off() {
    let h = Harness::restricted(&[("a.txt", "hello\n")]).await;
    assert!(h.call("read_file", json!({ "file_path": "a.txt" })).await.contains("hello"));
    h.call("search_text", json!({ "q": "hello" })).await;
    for (tool, args) in [
        ("execute_terminal_command", json!({ "command": "echo hi" })),
        ("git_status", json!({})),
        ("get_file_problems", json!({ "filePath": "a.txt" })),
        ("build_project", json!({})),
    ] {
        let msg = h.call_err(tool, args).await;
        assert!(msg.contains("Restricted Mode"), "{tool}: {msg}");
    }
    // Nothing was asked: the call is refused before any confirmation.
    assert!(h.ui.asked.lock().is_empty());
    let msg = h.call_err("execute_tool", json!({ "command": "execute_terminal_command --command 'echo hi'" })).await;
    assert!(msg.contains("Restricted Mode"), "{msg}");
}
