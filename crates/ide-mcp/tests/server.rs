//! The server over real HTTP, and the stdio bridge in front of it, with a
//! registry standing in for the IDE host.

use ide_mcp::{Discovery, McpServer, Tool, ToolCallError, ToolRegistry, discovery_path, stdio};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Registry {
    project: PathBuf,
}

impl ToolRegistry for Registry {
    fn projects(&self) -> Vec<PathBuf> {
        vec![self.project.clone()]
    }

    fn tools(&self, project: &Path) -> Result<Vec<Tool>, String> {
        assert_eq!(project, self.project);
        Ok(vec![Tool {
            name: "echo".into(),
            description: "Says it back".into(),
            input_schema: json!({ "type": "object", "properties": { "text": { "type": "string" } } }),
            read_only: true,
            destructive: false,
            output_schema: None,
        }])
    }

    fn call(
        &self,
        project: &Path,
        name: &str,
        arguments: &str,
        _cancel: ide_mcp::CancellationToken,
    ) -> Result<String, ToolCallError> {
        let args: Value = serde_json::from_str(arguments).unwrap();
        match name {
            "echo" if args["text"] == "fail" => Err(ToolCallError::Failed("it failed".into())),
            "echo" => Ok(format!("{} in {}", args["text"].as_str().unwrap_or(""), project.display())),
            _ => Err(ToolCallError::UnknownTool(format!("no tool {name:?}"))),
        }
    }
}

struct Setup {
    _tmp: tempfile::TempDir,
    project: PathBuf,
    discovery: PathBuf,
    server: Option<McpServer>,
}

fn setup() -> Setup {
    let tmp = tempfile::tempdir().unwrap();
    let project = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    let discovery = discovery_path(&tmp.path().join("app-data"));
    let registry = Arc::new(Registry { project: project.clone() });
    let server = McpServer::start(registry, Some(discovery.clone()), &tokio::runtime::Handle::current()).unwrap();
    Setup { _tmp: tmp, project, discovery, server: Some(server) }
}

impl Setup {
    fn server(&self) -> &McpServer {
        self.server.as_ref().unwrap()
    }
}

/// A raw HTTP/1.1 exchange: (status, body).
async fn http(port: u16, request: &str) -> (u16, String) {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.unwrap();
    let status = out.split(' ').nth(1).unwrap().parse().unwrap();
    let body = out.split_once("\r\n\r\n").map(|(_, b)| b.to_owned()).unwrap_or_default();
    (status, body)
}

/// POSTs `body` to `path` with extra header lines; closes the connection after.
async fn post(s: &Setup, path: &str, headers: &[&str], body: &Value) -> (u16, String) {
    let body = body.to_string();
    let port = s.server().port();
    let mut head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for h in headers {
        head.push_str(h);
        head.push_str("\r\n");
    }
    http(port, &format!("{head}\r\n{body}")).await
}

fn bearer(s: &Setup) -> String {
    format!("Authorization: Bearer {}", s.server().token())
}

async fn rpc(s: &Setup, method: &str, params: Value) -> Value {
    let project = format!("X-OpenIDEA-Project: {}", s.project.display());
    let (status, body) = post(
        s,
        "/mcp",
        &[&bearer(s), &project],
        &json!({ "jsonrpc": "2.0", "id": 7, "method": method, "params": params }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let reply: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(reply["id"], 7);
    reply
}

#[tokio::test(flavor = "multi_thread")]
async fn initialize_list_and_call_tools() {
    let s = setup();
    let init = rpc(
        &s,
        "initialize",
        json!({ "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } }),
    )
    .await;
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(init["result"]["serverInfo"]["name"], "OpenIDEA");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    let newer = rpc(&s, "initialize", json!({ "protocolVersion": "2099-01-01" })).await;
    assert_eq!(newer["result"]["protocolVersion"], "2025-06-18");

    // Notifications are accepted without a body.
    let (status, body) =
        post(&s, "/mcp", &[&bearer(&s)], &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    assert_eq!((status, body.as_str()), (202, ""));

    let list = rpc(&s, "tools/list", json!({})).await;
    let tool = &list["result"]["tools"][0];
    assert_eq!(tool["name"], "echo");
    assert_eq!(tool["inputSchema"]["type"], "object");
    assert_eq!(tool["annotations"], json!({ "readOnlyHint": true, "destructiveHint": false }));

    let call = rpc(&s, "tools/call", json!({ "name": "echo", "arguments": { "text": "hi" } })).await;
    let expected = format!("hi in {}", s.project.display());
    assert_eq!(call["result"], json!({ "content": [{ "type": "text", "text": expected }], "isError": false }));
    let failed = rpc(&s, "tools/call", json!({ "name": "echo", "arguments": { "text": "fail" } })).await;
    assert_eq!(failed["result"]["isError"], true);
    assert_eq!(failed["result"]["content"][0]["text"], "it failed");
    let unknown = rpc(&s, "tools/call", json!({ "name": "nope" })).await;
    assert_eq!(unknown["error"]["code"], -32602);
    assert_eq!(rpc(&s, "ping", json!({})).await["result"], json!({}));
    assert_eq!(rpc(&s, "resources/list", json!({})).await["error"]["code"], -32601);

    // The project by query, from a folder inside it; a batch.
    let query = format!("/mcp?project={}", ide_mcp::endpoint_url(1, &s.project.join("src")).split_once('=').unwrap().1);
    let batch = json!([
        { "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "echo", "arguments": { "text": "a" } } },
        { "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 9 } },
        { "jsonrpc": "2.0", "id": 2, "method": "ping" }
    ]);
    let (status, body) = post(&s, &query, &[&bearer(&s)], &batch).await;
    assert_eq!(status, 200, "{body}");
    let replies: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(replies.as_array().unwrap().len(), 2);
    assert_eq!(replies[0]["result"]["content"][0]["text"], expected.replacen("hi", "a", 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn requests_without_the_token_or_from_web_pages_are_refused() {
    let s = setup();
    let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    assert_eq!(post(&s, "/mcp", &[], &ping).await.0, 401);
    assert_eq!(post(&s, "/mcp", &["Authorization: Bearer wrong"], &ping).await.0, 401);
    assert_eq!(post(&s, "/mcp", &[&bearer(&s), "Origin: https://evil.example"], &ping).await.0, 403);
    let port = s.server().port();
    let (status, _) = http(
        port,
        &format!(
            "POST /mcp HTTP/1.1\r\nHost: evil.example:{port}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        ),
    )
    .await;
    assert_eq!(status, 403, "a rebound host name");
    // No SSE stream to open; other paths don't exist.
    let get = format!("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{}\r\nConnection: close\r\n\r\n", bearer(&s));
    assert_eq!(http(port, &get).await.0, 405);
    assert_eq!(post(&s, "/other", &[&bearer(&s)], &ping).await.0, 404);
    assert_eq!(post(&s, "/mcp", &[&bearer(&s), "MCP-Protocol-Version: 1999-01-01"], &ping).await.0, 400);
    let (status, body) = post(&s, "/mcp", &[&bearer(&s)], &json!("{")).await;
    assert_eq!(status, 200, "a JSON string is a message, just not a request: {body}");
    let garbage = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\n{{",
        bearer(&s)
    );
    let (status, body) = http(port, &garbage).await;
    assert_eq!(status, 400);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["error"]["code"], -32700);
}

#[tokio::test(flavor = "multi_thread")]
async fn folders_that_are_not_open_are_named_in_the_error() {
    let s = setup();
    let elsewhere = s.project.parent().unwrap().join("elsewhere");
    let header = format!("X-OpenIDEA-Project: {}", elsewhere.display());
    let (status, body) =
        post(&s, "/mcp", &[&bearer(&s), &header], &json!({"jsonrpc":"2.0","id":3,"method":"tools/list"})).await;
    assert_eq!(status, 200);
    let reply: Value = serde_json::from_str(&body).unwrap();
    assert!(reply["error"]["message"].as_str().unwrap().contains("isn't open in OpenIDEA"));
    let (_, body) = post(&s, "/mcp", &[&bearer(&s)], &json!({"jsonrpc":"2.0","id":3,"method":"tools/list"})).await;
    assert!(serde_json::from_str::<Value>(&body).unwrap()["result"]["tools"].is_array());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_discovery_file_lives_while_the_server_runs() {
    let mut s = setup();
    let info = Discovery::read(&s.discovery).unwrap();
    assert_eq!((info.port, info.token.as_str(), info.pid), (s.server().port(), s.server().token(), std::process::id()));
    let port = info.port;
    s.server.take().unwrap().stop();
    assert!(!s.discovery.exists());
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err(), "the port is closed");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_stdio_bridge_relays_lines_and_explains_a_missing_ide() {
    let mut s = setup();
    let input = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "echo", "arguments": { "text": "x" } } }),
    ]
    .iter()
    .map(|m| format!("{m}\n"))
    .collect::<String>()
        + "\n";
    let mut output = Vec::new();
    stdio::bridge(&s.discovery, &s.project.join("src"), input.as_bytes(), &mut output).await.unwrap();
    let mut replies: Vec<Value> =
        String::from_utf8(output).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    replies.sort_by_key(|r| r["id"].as_i64());
    assert_eq!(replies.len(), 2, "nothing for the notification: {replies:?}");
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(replies[1]["result"]["content"][0]["text"], format!("x in {}", s.project.display()));

    // The IDE quit: each request gets an error saying what to do.
    s.server.take().unwrap().stop();
    let mut output = Vec::new();
    let input = format!("{}\n", json!({ "jsonrpc": "2.0", "id": 5, "method": "initialize", "params": {} }));
    stdio::bridge(&s.discovery, &s.project, input.as_bytes(), &mut output).await.unwrap();
    let reply: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(reply["id"], 5);
    assert!(reply["error"]["message"].as_str().unwrap().contains("MCP server is not running"), "{reply}");
}

#[tokio::test(flavor = "multi_thread")]
async fn routing_an_argument_overrides_the_header_and_ambiguity_lists_projects() {
    struct Many(Vec<PathBuf>);
    impl ToolRegistry for Many {
        fn projects(&self) -> Vec<PathBuf> {
            self.0.clone()
        }
        fn tools(&self, _: &Path) -> Result<Vec<Tool>, String> {
            Ok(Vec::new())
        }
        fn call(
            &self,
            project: &Path,
            _: &str,
            _: &str,
            _: ide_mcp::CancellationToken,
        ) -> Result<String, ToolCallError> {
            Ok(json!({"project":project}).to_string())
        }
    }
    let mut s = setup();
    s.server.take().unwrap().stop();
    let second = s.project.parent().unwrap().join("second");
    std::fs::create_dir_all(second.join("nested")).unwrap();
    s.server = Some(
        McpServer::start(
            Arc::new(Many(vec![s.project.clone(), second.clone()])),
            None,
            &tokio::runtime::Handle::current(),
        )
        .unwrap(),
    );
    let (_, body) = post(&s, "/mcp", &[&bearer(&s)], &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).await;
    let reply: Value = serde_json::from_str(&body).unwrap();
    let message = reply["error"]["message"].as_str().unwrap();
    assert!(message.contains(s.project.to_str().unwrap()) && message.contains(second.to_str().unwrap()));
    let result = rpc(&s, "tools/call", json!({"name":"where","arguments":{"projectPath":second.join("nested")}})).await;
    assert_eq!(result["result"]["structuredContent"]["project"], json!(second));
    let unknown = rpc(&s, "tools/call", json!({"name":"where","arguments":{"projectPath":"/unknown/project"}})).await;
    assert_eq!(unknown["error"]["code"], -32001);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_reaches_a_running_tool_without_affecting_another_client() {
    struct Waiting(Arc<tokio::sync::Notify>);
    impl ToolRegistry for Waiting {
        fn projects(&self) -> Vec<PathBuf> {
            vec![PathBuf::from("/project")]
        }
        fn tools(&self, _: &Path) -> Result<Vec<Tool>, String> {
            Ok(Vec::new())
        }
        fn call(
            &self,
            _: &Path,
            _: &str,
            _: &str,
            cancel: ide_mcp::CancellationToken,
        ) -> Result<String, ToolCallError> {
            self.0.notify_one();
            tokio::runtime::Handle::current().block_on(cancel.cancelled());
            Err(ToolCallError::Failed("cancelled".into()))
        }
    }
    let mut s = setup();
    s.server.take().unwrap().stop();
    let started = Arc::new(tokio::sync::Notify::new());
    s.server =
        Some(McpServer::start(Arc::new(Waiting(started.clone())), None, &tokio::runtime::Handle::current()).unwrap());
    let body = json!({"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"wait"}});
    let auth = bearer(&s);
    let headers = [&*auth, "Mcp-Session-Id: client-one"];
    let call = post(&s, "/mcp", &headers, &body);
    let cancel = async {
        started.notified().await;
        let notification = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":11}});
        assert_eq!(post(&s, "/mcp", &[&bearer(&s), "Mcp-Session-Id: client-two"], &notification).await.0, 202);
        assert_eq!(post(&s, "/mcp", &[&bearer(&s), "Mcp-Session-Id: client-one"], &notification).await.0, 202);
    };
    let ((status, body), ()) =
        tokio::time::timeout(std::time::Duration::from_secs(5), async { tokio::join!(call, cancel) }).await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"]["isError"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancellation_that_arrives_before_the_call_is_remembered() {
    let s = setup();
    let auth = bearer(&s);
    let headers = [auth.as_str(), "Mcp-Session-Id: early-cancel"];
    let notification = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":8}});
    assert_eq!(post(&s, "/mcp", &headers, &notification).await.0, 202);
    let call = json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}});
    let (_, body) = post(&s, "/mcp", &headers, &call).await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"]["isError"], true);
}
