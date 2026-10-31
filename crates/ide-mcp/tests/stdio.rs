//! The stdio bridge against the server listening on a real socket.

mod common;

use common::{Harness, TOKEN};
use ide_core::mcp::McpSettings;
use ide_mcp::stdio::{Bridge, run};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines};

struct Client {
    input: Option<DuplexStream>,
    output: Lines<BufReader<DuplexStream>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Client {
    fn start(port: u16, project_path: Option<String>) -> Self {
        let (input, bridge_in) = tokio::io::duplex(1 << 16);
        let (bridge_out, output) = tokio::io::duplex(1 << 16);
        let bridge = Bridge { port, token: TOKEN.into(), project_path, debug: false };
        let task = tokio::spawn(run(bridge, bridge_in, bridge_out));
        Self { input: Some(input), output: BufReader::new(output).lines(), task }
    }

    async fn send_line(&mut self, line: &str) {
        let input = self.input.as_mut().unwrap();
        input.write_all(line.as_bytes()).await.unwrap();
        input.write_all(b"\n").await.unwrap();
    }

    async fn send(&mut self, message: Value) {
        self.send_line(&message.to_string()).await;
    }

    async fn receive(&mut self) -> Value {
        let line = tokio::time::timeout(std::time::Duration::from_secs(20), self.output.next_line())
            .await
            .expect("no reply in time")
            .unwrap()
            .expect("bridge closed stdout");
        assert!(!line.contains('\n'));
        serde_json::from_str(&line).unwrap()
    }

    async fn initialize(&mut self) -> Value {
        self.send(json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "claude-ai", "version": "1" } } }))
            .await;
        let reply = self.receive().await;
        self.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        reply
    }

    async fn read_file(&mut self, id: u64, path: &str) -> Value {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": { "name": "read_file", "arguments": { "file_path": path } } }))
            .await;
        self.receive().await
    }

    async fn close(mut self) {
        self.input.take();
        tokio::time::timeout(std::time::Duration::from_secs(10), self.task).await.unwrap().unwrap().unwrap();
    }
}

async fn listening(h: &Harness, port: u16) -> u16 {
    let status = h.server.apply(&McpSettings { enabled: true, port, ..McpSettings::default() }).await;
    status.port.unwrap_or_else(|| panic!("server did not start: {:?}", status.error))
}

fn text(reply: &Value) -> &str {
    reply["result"]["content"][0]["text"].as_str().unwrap_or_else(|| panic!("no text in {reply}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn round_trip_through_the_bridge() {
    let h = Harness::new(&[("a.txt", "hello bridge\n")]).await;
    let port = listening(&h, 0).await;
    let mut client = Client::start(port, None);

    let init = client.initialize().await;
    assert_eq!(init["id"], 0);
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert!(init["result"]["serverInfo"]["name"].is_string(), "{init}");
    assert_eq!(h.server.status().clients[0].name, "claude-ai");

    // The notification got no reply: the next line answers the next request.
    client.send(json!({ "jsonrpc": "2.0", "id": "p", "method": "ping" })).await;
    assert_eq!(client.receive().await["id"], "p");

    let reply = client.read_file(1, "a.txt").await;
    assert_eq!(reply["id"], 1);
    assert!(text(&reply).contains("hello bridge"), "{reply}");

    client.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    let tools = client.receive().await;
    assert!(tools["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "read_file"));

    // Not JSON: a parse error, and the bridge keeps going.
    client.send_line("{oops").await;
    assert_eq!(client.receive().await["error"]["code"], -32700);

    // The IDE restarts its server: the session is gone, the bridge starts a new one.
    h.server.apply(&McpSettings { enabled: false, port, ..McpSettings::default() }).await;
    listening(&h, port).await;
    let reply = client.read_file(3, "a.txt").await;
    assert!(text(&reply).contains("hello bridge"), "{reply}");

    client.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_calls_go_to_the_configured_project() {
    let h = Harness::new(&[("a.txt", "x\n")]).await;
    let port = listening(&h, 0).await;
    let missing = h.dir.path().join("elsewhere").display().to_string();
    let mut client = Client::start(port, Some(missing));
    client.initialize().await;
    let reply = client.read_file(1, "a.txt").await;
    assert_eq!(reply["result"]["isError"], true, "{reply}");
    assert!(text(&reply).contains("No open project contains"), "{reply}");
    client.close().await;

    let mut client = Client::start(port, Some(h.root.display().to_string()));
    client.initialize().await;
    assert!(text(&client.read_file(1, "a.txt").await).contains('x'));
    client.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn requests_fail_clearly_when_the_ide_is_not_running() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut client = Client::start(port, None);
    let reply = client.initialize().await;
    assert_eq!(reply["id"], 0);
    assert_eq!(reply["error"]["code"], -32000);
    assert!(reply["error"]["message"].as_str().unwrap().contains("not reachable"), "{reply}");
    client.close().await;
}
