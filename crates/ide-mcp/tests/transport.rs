//! The MCP runtime: SSE responses, notification streams, progress, elicitation, roots
//! and header based project resolution, `tools/list_changed`, the legacy SSE
//! transport, the call history. Ported in part from JetBrains' `TransportTest`,
//! `ProgressNotificationsTest` and `McpProjectLocationInputsTest`.

mod common;

use common::{Harness, PORT, TOKEN};
use ide_core::mcp::{McpCallOutcome, McpInvocationMode, McpSettings, McpToolKind};
use ide_core::{IdeError, IdeResult};
use ide_mcp::McpServer;
use ide_mcp::project::{self, Sources};
use ide_mcp::tool::{Call, Output, Tool};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

const HEADER: &str = "OPENIDEA_MCP_PROJECT_PATH";

fn test_tools() -> Vec<Tool> {
    vec![
        Tool::new("where", McpToolKind::Read, "The project root.", |call: Call| async move {
            Ok(Output::text(call.root().display().to_string()))
        }),
        Tool::new("slow", McpToolKind::Read, "Reports progress.", |call: Call| async move {
            for i in 1..=3 {
                call.report_progress(i as f64, Some(3.0), Some(&format!("step {i}")));
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            Ok(Output::text("done"))
        }),
        Tool::new("guarded", McpToolKind::Execute, "Asks first.", |call: Call| async move {
            call.confirm("echo hi", Some("in /tmp".into())).await?;
            Ok(Output::text("ran"))
        }),
        Tool::new("writes", McpToolKind::Edit, "Records a change.", |call: Call| async move {
            call.record_change(&call.root().join("new.txt"));
            Ok(Output::text("ok"))
        }),
        Tool::new("waits", McpToolKind::Read, "Waits for cancellation.", |call: Call| async move {
            call.cancel.cancelled().await;
            IdeResult::<Output>::Err(IdeError::cancelled())
        }),
        Tool::new("boom", McpToolKind::Read, "Panics.", |call: Call| async move {
            call.args.get("never").map(|_| ()).expect("kaboom");
            Ok(Output::text("unreachable"))
        }),
    ]
}

/// The harness's host and UI with a server that has the test tools; a second project
/// is open in window `second`.
async fn setup() -> (Harness, McpServer, PathBuf) {
    let h = Harness::new(&[("a.txt", "x\n")]).await;
    let second = dunce::canonicalize(h.dir.path()).unwrap().join("second");
    std::fs::create_dir_all(&second).unwrap();
    h.host().open_project("second", &second).unwrap();
    let server = McpServer::with_tools(h.ui.clone(), TOKEN.into(), test_tools());
    server.set_timing_for_test(Duration::from_millis(50), Duration::from_millis(100), Duration::from_secs(10));
    (h, server, second)
}

struct Client<'a> {
    server: &'a McpServer,
    session: Option<String>,
}

impl<'a> Client<'a> {
    fn new(server: &'a McpServer) -> Self {
        Self { server, session: None }
    }

    async fn request(
        &self,
        method: &str,
        target: &str,
        body: Value,
        sse: bool,
        extra: &[(&str, &str)],
    ) -> ide_mcp::http::TestResponse {
        let host = format!("127.0.0.1:{PORT}");
        let auth = format!("Bearer {TOKEN}");
        let accept = if sse { "application/json, text/event-stream" } else { "application/json" };
        let mut headers = vec![("Host", host.as_str()), ("Authorization", auth.as_str()), ("Accept", accept)];
        if let Some(s) = &self.session {
            headers.push(("Mcp-Session-Id", s.as_str()));
        }
        headers.extend_from_slice(extra);
        let body = if body.is_null() { String::new() } else { body.to_string() };
        self.server.request_for_test(PORT, method, target, &headers, &body).await
    }

    async fn initialize(&mut self, capabilities: Value, extra: &[(&str, &str)]) -> Value {
        let r = self
            .request(
                "POST",
                "/mcp",
                json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                    "protocolVersion": "2025-06-18", "capabilities": capabilities,
                    "clientInfo": { "name": "test-client", "version": "1.0" } } }),
                false,
                extra,
            )
            .await;
        assert_eq!(r.status, 200, "{}", r.body);
        self.session = r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("mcp-session-id")).map(|(_, v)| v.clone());
        self.post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        serde_json::from_str(&r.body).unwrap()
    }

    /// A POST answered with JSON (or nothing).
    async fn post(&self, body: Value) -> Value {
        let r = self.request("POST", "/mcp", body, false, &[]).await;
        assert!(r.events.is_none());
        if r.body.is_empty() { Value::Null } else { serde_json::from_str(&r.body).unwrap() }
    }

    async fn call(&self, id: u64, tool: &str, args: Value, extra: &[(&str, &str)]) -> Value {
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": args } });
        let r = self.request("POST", "/mcp", body, false, extra).await;
        serde_json::from_str::<Value>(&r.body).unwrap()["result"].clone()
    }

    /// A POST answered with an SSE stream.
    async fn post_sse(&self, body: Value) -> UnboundedReceiver<String> {
        let r = self.request("POST", "/mcp", body, true, &[]).await;
        assert_eq!(r.status, 200);
        assert!(r.headers.iter().any(|(k, v)| k == "Content-Type" && v == "text/event-stream"), "{:?}", r.headers);
        r.events.expect("an SSE response")
    }

    /// The session's notification stream.
    async fn open_stream(&self) -> UnboundedReceiver<String> {
        let r = self.request("GET", "/mcp", Value::Null, true, &[]).await;
        assert_eq!(r.status, 200, "{}", r.body);
        r.events.expect("an SSE response")
    }

    async fn tool_names_with_project_path(&self) -> Vec<String> {
        let list = self.post(json!({ "jsonrpc": "2.0", "id": 90, "method": "tools/list" })).await;
        list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["inputSchema"]["properties"].get("projectPath").is_some())
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect()
    }
}

/// The next JSON-RPC message of an SSE stream (heartbeats skipped).
async fn next_message(events: &mut UnboundedReceiver<String>) -> Value {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("an event in time")
            .expect("the stream is open");
        if let Some(data) = event.lines().find_map(|l| l.strip_prefix("data: ")) {
            return serde_json::from_str(data).unwrap_or_else(|_| Value::String(data.to_owned()));
        }
    }
}

fn text(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_progress_with_keep_alives_before_the_result() {
    let (_h, server, _) = setup().await;
    let mut c = Client::new(&server);
    c.initialize(json!({}), &[]).await;
    let mut events = c
        .post_sse(json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "name": "slow", "arguments": {}, "_meta": { "progressToken": "tok" } } }))
        .await;
    let mut progress = Vec::new();
    let result = loop {
        let m = next_message(&mut events).await;
        if m["method"] == "notifications/progress" {
            assert_eq!(m["params"]["progressToken"], "tok");
            progress.push(m["params"].clone());
        } else {
            break m;
        }
    };
    assert_eq!(result["id"], 5);
    assert_eq!(text(&result["result"]), "done");
    assert!(progress.len() >= 3, "{progress:?}");
    assert_eq!(progress[0]["progress"], 0.0);
    assert!(progress.iter().any(|p| p["message"] == "step 2"), "{progress:?}");
    // Nothing changes for 150 ms while the interval is 50 ms: the latest repeats.
    assert!(progress.windows(2).any(|w| w[0] == w[1]), "no keep-alive: {progress:?}");
    assert_eq!(progress.last().unwrap()["message"], "step 3");
    assert!(events.recv().await.is_none(), "the stream ends after the result");
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_progress_of_json_answered_calls_on_the_notification_stream() {
    let (_h, server, _) = setup().await;
    let mut c = Client::new(&server);
    c.initialize(json!({}), &[]).await;
    let mut stream = c.open_stream().await;
    let result = c
        .post(json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/call",
            "params": { "name": "slow", "arguments": {}, "_meta": { "progressToken": 7 } } }))
        .await;
    assert_eq!(text(&result["result"]), "done");
    let m = next_message(&mut stream).await;
    assert_eq!((m["method"].as_str(), &m["params"]["progressToken"]), (Some("notifications/progress"), &json!(7)));
    // A second stream for the same session is refused.
    assert_eq!(c.request("GET", "/mcp", Value::Null, true, &[]).await.status, 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn confirms_through_elicitation_when_the_client_supports_it() {
    let (h, server, _) = setup().await;
    let mut c = Client::new(&server);
    c.initialize(json!({ "elicitation": {} }), &[]).await;
    let call = |id: u64| json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": "guarded", "arguments": {} } });

    // Allowed.
    let mut events = c.post_sse(call(1)).await;
    let ask = next_message(&mut events).await;
    assert_eq!(ask["method"], "elicitation/create");
    assert!(ask["params"]["message"].as_str().unwrap().contains("echo hi"), "{ask}");
    assert_eq!(ask["params"]["requestedSchema"]["properties"]["decision"]["enum"], json!(["allow", "deny"]));
    assert_eq!(ask["params"]["requestedSchema"]["required"], json!(["decision"]));
    let answer = json!({ "jsonrpc": "2.0", "id": ask["id"], "result": { "action": "accept", "content": { "decision": "allow" } } });
    assert_eq!(c.post(answer).await, Value::Null);
    let result = next_message(&mut events).await;
    assert_eq!(text(&result["result"]), "ran");

    // Declined.
    let mut events = c.post_sse(call(2)).await;
    let ask = next_message(&mut events).await;
    c.post(json!({ "jsonrpc": "2.0", "id": ask["id"], "result": { "action": "decline" } })).await;
    let result = next_message(&mut events).await;
    assert_eq!(result["result"]["isError"], true);
    assert!(text(&result["result"]).contains("declined"), "{result}");
    assert!(h.ui.asked.lock().is_empty(), "the IDE was not asked");

    // The client cannot elicit after all: the IDE asks.
    let mut events = c.post_sse(call(3)).await;
    let ask = next_message(&mut events).await;
    c.post(json!({ "jsonrpc": "2.0", "id": ask["id"], "error": { "code": -32601, "message": "no" } })).await;
    let result = next_message(&mut events).await;
    assert_eq!(text(&result["result"]), "ran");
    assert_eq!(h.ui.asked.lock().len(), 1);

    // Answered with JSON and no stream reaches the client: the IDE asks.
    let result = c.call(4, "guarded", json!({}), &[]).await;
    assert_eq!(text(&result), "ran");
    assert_eq!(h.ui.asked.lock().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn clients_without_elicitation_get_the_ide_dialog() {
    let (h, server, _) = setup().await;
    let mut c = Client::new(&server);
    c.initialize(json!({}), &[]).await;
    let r = c
        .request(
            "POST",
            "/mcp",
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "guarded", "arguments": {} } }),
            true,
            &[],
        )
        .await;
    // Nothing to send while the call runs: plain JSON.
    assert!(r.events.is_none());
    assert_eq!(text(&serde_json::from_str::<Value>(&r.body).unwrap()["result"]), "ran");
    assert_eq!(h.ui.asked.lock().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn resolves_the_project_from_the_client_roots() {
    let (_h, server, second) = setup().await;
    let mut c = Client::new(&server);
    c.initialize(json!({ "roots": { "listChanged": true } }), &[]).await;
    let mut stream = c.open_stream().await;
    let ask = next_message(&mut stream).await;
    assert_eq!(ask["method"], "roots/list");
    // Listed before the roots are known: with `projectPath`.
    assert!(!c.tool_names_with_project_path().await.is_empty());
    let uri = format!("file://{}", second.display());
    c.post(json!({ "jsonrpc": "2.0", "id": ask["id"], "result": { "roots": [{ "uri": uri, "name": "second" }] } }))
        .await;
    let changed = next_message(&mut stream).await;
    assert_eq!(changed["method"], "notifications/tools/list_changed");
    assert!(c.tool_names_with_project_path().await.is_empty());
    // The focused window is `main`, but the roots name `second`.
    assert_eq!(text(&c.call(1, "where", json!({}), &[]).await), second.display().to_string());

    // The roots changed: asked again.
    c.post(json!({ "jsonrpc": "2.0", "method": "notifications/roots/list_changed" })).await;
    assert_eq!(next_message(&mut stream).await["method"], "roots/list");
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_for_roots_on_the_call_stream_without_a_notification_stream() {
    let (h, server, second) = setup().await;
    let mut c = Client::new(&server);
    c.initialize(json!({ "roots": {} }), &[]).await;
    let mut events = c
        .post_sse(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "where", "arguments": {} } }))
        .await;
    let ask = next_message(&mut events).await;
    assert_eq!(ask["method"], "roots/list");
    let uri = format!("file://{}", second.display());
    c.post(json!({ "jsonrpc": "2.0", "id": ask["id"], "result": { "roots": [{ "uri": uri }] } })).await;
    let result = next_message(&mut events).await;
    assert_eq!(text(&result["result"]), second.display().to_string());
    // Known now: the next call needs no stream.
    assert_eq!(text(&c.call(4, "where", json!({}), &[]).await), second.display().to_string());
    let root = h.root.display().to_string();
    assert_eq!(text(&c.call(5, "where", json!({ "projectPath": root }), &[]).await), root);
}

#[tokio::test(flavor = "multi_thread")]
async fn uses_the_project_path_headers_and_strips_the_parameter() {
    let (h, server, second) = setup().await;
    let second_path = second.display().to_string();
    let main_path = h.root.display().to_string();
    let mut c = Client::new(&server);
    let init = c.initialize(json!({}), &[(HEADER, second_path.as_str())]).await;
    assert!(!init["result"]["instructions"].as_str().unwrap().contains("projectPath"));
    assert!(c.tool_names_with_project_path().await.is_empty());
    assert_eq!(text(&c.call(1, "where", json!({}), &[]).await), second_path);
    // The call's header wins over the session's, and so does `_meta`.
    assert_eq!(text(&c.call(2, "where", json!({}), &[(HEADER, main_path.as_str())]).await), main_path);
    let r = c
        .post(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "where", "arguments": {}, "_meta": { HEADER: main_path } } }))
        .await;
    assert_eq!(text(&r["result"]), main_path);
    // An explicit `projectPath` must name an open project: no fallback.
    let r = c.call(4, "where", json!({ "projectPath": "/tmp/not-an-open-project" }), &[]).await;
    assert_eq!(r["isError"], true);
    let message = text(&r);
    assert!(message.starts_with("`projectPath`=`/tmp/not-an-open-project` doesn't correspond to any open project."));
    assert!(message.contains("You may specify the project path via `projectPath` parameter"), "{message}");
    assert!(!message.contains(HEADER) && !message.contains("header"), "{message}");

    // Without the header the schemas keep `projectPath`.
    let mut plain = Client::new(&server);
    let init = plain.initialize(json!({}), &[]).await;
    assert!(init["result"]["instructions"].as_str().unwrap().contains("projectPath"));
    assert!(plain.tool_names_with_project_path().await.contains(&"where".to_owned()));
}

#[tokio::test(flavor = "multi_thread")]
async fn resolves_in_the_jetbrains_order() {
    let (h, _server, second) = setup().await;
    let host = h.host();
    let (main, second) = (h.root.display().to_string(), second.display().to_string());
    let second_uri = format!("file://{second}");
    let roots = vec![format!("file://{main}")];
    let root_of = |s: &Sources| project::target(host, s, None).map(|t| t.project.root.display().to_string());
    // The argument wins over everything.
    let s = Sources { argument: Some(&second), call_header: Some(&main), session_header: Some(&main), roots: &roots };
    assert_eq!(root_of(&s).unwrap(), second);
    // The call header over the session header.
    let s = Sources { call_header: Some(&second), session_header: Some(&main), roots: &roots, ..Default::default() };
    assert_eq!(root_of(&s).unwrap(), second);
    // The session header over the roots, also when the call header names nothing open.
    let s = Sources {
        call_header: Some("/tmp/not-an-open-project"),
        session_header: Some(&second),
        roots: &roots,
        ..Default::default()
    };
    assert_eq!(root_of(&s).unwrap(), second);
    // The roots last.
    let only = vec![second_uri];
    let s = Sources { session_header: Some("/tmp/also-not-open"), roots: &only, ..Default::default() };
    assert_eq!(root_of(&s).unwrap(), second);
    // A subdirectory resolves to its project; a relative path to none.
    let sub = format!("{main}/src/deep");
    assert_eq!(root_of(&Sources { argument: Some(&sub), ..Default::default() }).unwrap(), main);
    assert!(root_of(&Sources { argument: Some("relative/dir"), ..Default::default() }).is_err());
    // Nothing names a project, nothing is focused, two are open.
    let e = root_of(&Sources::default()).unwrap_err();
    assert!(
        e.message.starts_with("No exact project is specified while multiple projects are opened."),
        "{}",
        e.message
    );
    assert!(e.message.contains(&format!("{{\"path\":\"{second}\"}}")), "{}", e.message);
}

#[tokio::test(flavor = "multi_thread")]
async fn tells_clients_when_the_tool_list_changes() {
    let (_h, server, _) = setup().await;
    let mut c = Client::new(&server);
    c.initialize(json!({}), &[]).await;
    let mut stream = c.open_stream().await;
    c.tool_names_with_project_path().await;
    let disabled = McpSettings { disabled_tools: vec!["slow".into()], ..Default::default() };
    server.apply(&disabled).await;
    assert_eq!(next_message(&mut stream).await["method"], "notifications/tools/list_changed");
    // The same tools again: nothing to announce. Router mode lists other tools: announced once.
    server.apply(&disabled).await;
    server.apply(&McpSettings { invocation_mode: McpInvocationMode::ViaRouter, ..disabled.clone() }).await;
    assert_eq!(next_message(&mut stream).await["method"], "notifications/tools/list_changed");
    let more = tokio::time::timeout(Duration::from_millis(300), next_message(&mut stream)).await;
    assert!(more.is_err(), "one notification per change: {more:?}");
    // DELETE ends the session and its stream.
    assert_eq!(c.request("DELETE", "/mcp", Value::Null, false, &[]).await.status, 200);
    let end = tokio::time::timeout(Duration::from_secs(5), async { while stream.recv().await.is_some() {} }).await;
    assert!(end.is_ok(), "the stream ended");
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_legacy_sse_transport() {
    let (h, server, _) = setup().await;
    let c = Client::new(&server);
    let r = c.request("GET", "/sse", Value::Null, true, &[]).await;
    assert_eq!(r.status, 200);
    let mut events = r.events.unwrap();
    let first = events.recv().await.unwrap();
    assert!(first.starts_with("event: endpoint\ndata: /message?sessionId="), "{first}");
    let endpoint = first.lines().nth(1).unwrap().strip_prefix("data: ").unwrap().to_owned();

    let post = |body: Value| c.request("POST", endpoint.as_str(), body, false, &[]);
    let r = post(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "old-cursor", "version": "0.4" } } }))
    .await;
    assert_eq!((r.status, r.body.as_str()), (202, "Accepted"));
    let init = next_message(&mut events).await;
    assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(server.status().clients[0].name, "old-cursor");
    post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    post(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "where", "arguments": {} } }))
        .await;
    let result = next_message(&mut events).await;
    assert_eq!((result["id"].as_i64(), text(&result["result"])), (Some(2), h.root.display().to_string().as_str()));
    assert_eq!(server.call_history()[0].client, "old-cursor");

    let r = c.request("POST", "/message?sessionId=nope", json!({}), false, &[]).await;
    assert_eq!(r.status, 404);
    let r = c.request("POST", "/message", json!({}), false, &[]).await;
    assert_eq!((r.status, r.body.as_str()), (400, "sessionId query parameter is not provided"));

    // The session ends with its stream.
    drop(events);
    let gone = async {
        loop {
            let r = c.request("POST", &endpoint, json!({ "jsonrpc": "2.0", "method": "ping" }), false, &[]).await;
            if r.status == 404 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), gone).await.expect("the session ended");
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_call_history_with_changes_and_outcomes() {
    let (h, server, _) = setup().await;
    let mut c = Client::new(&server);
    c.initialize(json!({}), &[]).await;
    c.call(1, "writes", json!({ "token": "s3cret", "env": { "API_KEY": "k", "HOME": "/h" } }), &[]).await;
    let r = c.call(2, "boom", json!({}), &[]).await;
    assert_eq!(text(&r), "MCP tool call has been failed: kaboom");
    let history = server.call_history();
    // Most recent first.
    let [boom, writes] = history.as_slice() else { panic!("{history:?}") };
    assert_eq!((writes.client.as_str(), writes.tool.as_str()), ("test-client", "writes"));
    assert_eq!(writes.arguments, r#"{"env":{"API_KEY":"***","HOME":"/h"},"token":"***"}"#);
    assert_eq!(writes.changed_files, vec!["new.txt"]);
    assert_eq!((writes.outcome, writes.error.as_deref()), (McpCallOutcome::Success, None));
    assert_eq!(writes.project.as_deref(), Some(h.root.display().to_string().as_str()));
    assert_eq!(boom.outcome, McpCallOutcome::Failed);
    assert!(boom.error.as_deref().is_some_and(|m| m.contains("kaboom")), "{boom:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_cancelled_calls_like_jetbrains() {
    let (_h, server, _) = setup().await;
    let server = Arc::new(server);
    let mut c = Client::new(&server);
    c.initialize(json!({}), &[]).await;
    let session = c.session.clone();
    let canceller = {
        let server = server.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let c = Client { server: &server, session };
            c.post(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 8 } }))
                .await;
        })
    };
    let r = c.call(8, "waits", json!({}), &[]).await;
    canceller.await.unwrap();
    assert_eq!(r["isError"], true);
    assert!(text(&r).starts_with("MCP tool call has been cancelled likely by a user interaction"), "{r}");
    assert_eq!(server.call_history()[0].outcome, McpCallOutcome::Cancelled);
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_over_a_real_socket() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (_h, server, _) = setup().await;
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    assert!(server.apply(&McpSettings { enabled: true, port, ..Default::default() }).await.running);
    let send = move |body: String, extra: String| async move {
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\n\
             Accept: application/json, text/event-stream\r\n{extra}Connection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        sock.read_to_string(&mut out).await.unwrap();
        out
    };
    let init =
        json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } });
    let out = send(init.to_string(), String::new()).await;
    let session = out.lines().find_map(|l| l.strip_prefix("Mcp-Session-Id: ")).expect("a session id").trim().to_owned();
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": "slow", "arguments": {}, "_meta": { "progressToken": "p" } } });
    let out = send(call.to_string(), format!("Mcp-Session-Id: {session}\r\n")).await;
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(
        out.contains("Content-Type: text/event-stream\r\n") && out.contains("Transfer-Encoding: chunked\r\n"),
        "{out}"
    );
    assert!(out.contains("\"method\":\"notifications/progress\""), "{out}");
    assert!(out.contains("\"text\":\"done\""), "{out}");
    assert!(out.ends_with("0\r\n\r\n"), "{out}");

    // The legacy stream names its message endpoint first.
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let req = format!(
        "GET /sse HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nAccept: text/event-stream\r\n\r\n"
    );
    sock.write_all(req.as_bytes()).await.unwrap();
    let mut buf = vec![0u8; 4096];
    let mut seen = String::new();
    while !seen.contains("data: /message?sessionId=") {
        let n = tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await.unwrap().unwrap();
        assert!(n > 0, "{seen}");
        seen.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    assert!(seen.contains("event: endpoint\n"), "{seen}");
    server.apply(&McpSettings { enabled: false, port, ..Default::default() }).await;
}
