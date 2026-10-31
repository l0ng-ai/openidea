// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.stdio/src/McpStdioRunner.kt), Apache-2.0.
//! The stdio bridge: clients that only start servers as commands (Claude Desktop) run
//! `openidea mcp-stdio`, which forwards newline-delimited JSON-RPC from stdin to
//! `POST /mcp` of the running IDE and writes the replies (plain JSON or an SSE
//! stream) to stdout, one message per line.
//!
//! It keeps the session id, and when the IDE restarted (the session is unknown) it
//! initializes again with the client's original `initialize` and retries.

use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// The executable's argument that starts the bridge instead of the IDE.
pub const SUBCOMMAND: &str = "mcp-stdio";
/// The server's port (JetBrains: `IJ_MCP_SERVER_PORT`).
pub const PORT_ENV: &str = "OPENIDEA_MCP_PORT";
/// The bearer token itself.
pub const TOKEN_ENV: &str = "OPENIDEA_MCP_TOKEN";
/// A file holding the token (the app's own `mcp-token`): survives regenerating it.
pub const TOKEN_FILE_ENV: &str = "OPENIDEA_MCP_TOKEN_FILE";
/// The project tool calls go to unless they name one (JetBrains: `IJ_MCP_SERVER_PROJECT_PATH`).
pub const PROJECT_ENV: &str = "OPENIDEA_MCP_PROJECT_PATH";
/// Any value prints every forwarded message to stderr.
pub const DEBUG_ENV: &str = "OPENIDEA_MCP_DEBUG";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long messages still in flight get once stdin closes.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_HEAD: usize = 64 * 1024;

/// Where the bridge forwards to.
#[derive(Clone, Debug)]
pub struct Bridge {
    pub port: u16,
    pub token: String,
    pub project_path: Option<String>,
    pub debug: bool,
}

impl Bridge {
    /// From the variables `var` returns; without a token, from the token file
    /// (`OPENIDEA_MCP_TOKEN_FILE`, else `default_token_file`).
    pub fn from_vars(var: impl Fn(&str) -> Option<String>, default_token_file: Option<&Path>) -> Result<Self, String> {
        // Set at all, even empty, turns debugging on.
        let debug = var(DEBUG_ENV).is_some();
        let var = |name: &str| var(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let port = var(PORT_ENV).and_then(|p| p.parse::<u16>().ok()).filter(|p| *p != 0).ok_or_else(|| {
            format!("Please specify the port of OpenIDEA's MCP server (Settings › Tools › MCP Server) in {PORT_ENV}")
        })?;
        let token = match var(TOKEN_ENV) {
            Some(token) => token,
            None => {
                let file = var(TOKEN_FILE_ENV).map(PathBuf::from).or_else(|| default_token_file.map(Path::to_path_buf));
                let Some(file) = file else {
                    return Err(format!("Please specify the MCP server's token in {TOKEN_ENV} or {TOKEN_FILE_ENV}"));
                };
                let text = std::fs::read_to_string(&file)
                    .map_err(|e| format!("Cannot read the MCP server's token from {}: {e}", file.display()))?;
                text.trim().to_owned()
            }
        };
        Ok(Self { port, token, project_path: var(PROJECT_ENV), debug })
    }
}

/// Runs the bridge on this process's stdin / stdout; the exit code.
pub fn main(default_token_file: Option<&Path>) -> i32 {
    let bridge = match Bridge::from_vars(|n| std::env::var(n).ok(), default_token_file) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[ERROR] {e}");
            return 2;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[ERROR] {e}");
            return 1;
        }
    };
    if !bridge.debug {
        eprintln!("[INFO] Set {DEBUG_ENV} to print the forwarded messages to stderr.");
    }
    match runtime.block_on(run(bridge, tokio::io::stdin(), tokio::io::stdout())) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("[ERROR] {e}");
            1
        }
    }
}

struct Link {
    bridge: Bridge,
    session: Mutex<Option<String>>,
    protocol_version: Mutex<Option<String>>,
    /// The client's `initialize`, replayed when the server forgot the session.
    initialize: Mutex<Option<Value>>,
    reinitializing: tokio::sync::Mutex<()>,
    out: mpsc::UnboundedSender<String>,
}

/// Forwards `input` (one JSON-RPC message per line) to the server and its replies to
/// `output` until `input` ends.
pub async fn run<R, W>(bridge: Bridge, input: R, mut output: W) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (out, mut lines_out) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(line) = lines_out.recv().await {
            output.write_all(line.as_bytes()).await?;
            output.write_all(b"\n").await?;
            output.flush().await?;
        }
        std::io::Result::Ok(())
    });
    let link = Arc::new(Link {
        bridge,
        session: Mutex::default(),
        protocol_version: Mutex::default(),
        initialize: Mutex::default(),
        reinitializing: tokio::sync::Mutex::new(()),
        out,
    });
    let mut lines = BufReader::new(input).lines();
    let mut inflight = tokio::task::JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        link.debug("STDIO->HTTP", &line);
        let message: Value = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                link.send(&crate::protocol::error(
                    Value::Null,
                    crate::protocol::PARSE_ERROR,
                    format!("invalid JSON: {e}"),
                ));
                continue;
            }
        };
        if method(&message) == Some("initialize") {
            // Later messages need its session.
            link.forward(message).await;
        } else {
            let link = link.clone();
            inflight.spawn(async move { link.forward(message).await });
        }
        while inflight.try_join_next().is_some() {}
    }
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, async { while inflight.join_next().await.is_some() {} }).await;
    inflight.abort_all();
    link.end_session().await;
    drop(link);
    writer.await.map_err(std::io::Error::other)?
}

fn method(message: &Value) -> Option<&str> {
    message.get("method").and_then(Value::as_str)
}

/// The id of a request (a message with a method and an id); notifications and
/// responses get no error reply.
fn request_id(message: &Value) -> Option<Value> {
    method(message)?;
    message.get("id").cloned()
}

impl Link {
    fn send(&self, message: &Value) {
        let line = message.to_string();
        self.debug("HTTP->STDIO", &line);
        let _ = self.out.send(line);
    }

    fn debug(&self, direction: &str, line: &str) {
        if self.bridge.debug {
            eprintln!("[DEBUG] {direction}: {line}");
        }
    }

    async fn forward(&self, message: Value) {
        if let Err(e) = self.deliver(&message).await {
            match request_id(&message) {
                Some(id) => self.send(&crate::protocol::error(id, -32000, e)),
                None => eprintln!("[ERROR] {e}"),
            }
        }
    }

    async fn deliver(&self, message: &Value) -> Result<(), String> {
        let initializes = method(message) == Some("initialize");
        if initializes {
            *self.initialize.lock() = Some(message.clone());
            *self.session.lock() = None;
        }
        let session = self.session.lock().clone();
        let mut response = self.post(message, session.as_deref()).await?;
        if response.status == 404 && !initializes && session.is_some() {
            // The IDE restarted: start a new session and try once more.
            self.reinitialize(session.as_deref()).await?;
            let session = self.session.lock().clone();
            response = self.post(message, session.as_deref()).await?;
        }
        if initializes && let Some(s) = response.headers.get("mcp-session-id") {
            *self.session.lock() = Some(s.clone());
        }
        self.relay(response, initializes).await
    }

    /// Writes the reply's messages to stdout.
    async fn relay(&self, mut response: HttpResponse, initializes: bool) -> Result<(), String> {
        let status = response.status;
        let streams = response.headers.get("content-type").is_some_and(|t| t.starts_with("text/event-stream"));
        if (200..300).contains(&status) && streams {
            let mut events = SseParser::default();
            while let Some(chunk) = response.body.chunk().await.map_err(|e| e.to_string())? {
                for data in events.feed(&chunk) {
                    self.relay_message(&data, initializes);
                }
            }
            return Ok(());
        }
        let body = response.body.read_all().await.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&body);
        if (200..300).contains(&status) {
            if !text.trim().is_empty() {
                self.relay_message(&text, initializes);
            }
            return Ok(());
        }
        // The server's JSON-RPC errors (400, 404) reach the client as they are.
        if let Ok(error) = serde_json::from_str::<Value>(&text)
            && error.get("error").is_some()
            && !error.get("id").is_none_or(Value::is_null)
        {
            self.send(&error);
            return Ok(());
        }
        Err(match status {
            401 => format!(
                "OpenIDEA rejected the MCP token; Auto-Configure the client again in Settings › Tools › MCP Server ({})",
                text.trim()
            ),
            _ => format!("OpenIDEA's MCP server answered HTTP {status}: {}", text.trim()),
        })
    }

    fn relay_message(&self, data: &str, initializes: bool) {
        let Ok(message) = serde_json::from_str::<Value>(data) else {
            eprintln!("[ERROR] The server sent invalid JSON: {data}");
            return;
        };
        if initializes && let Some(version) = message.pointer("/result/protocolVersion").and_then(Value::as_str) {
            *self.protocol_version.lock() = Some(version.to_owned());
        }
        self.send(&message);
    }

    async fn reinitialize(&self, failed: Option<&str>) -> Result<(), String> {
        let _guard = self.reinitializing.lock().await;
        if self.session.lock().as_deref() != failed {
            // Another message already started a new session.
            return Ok(());
        }
        let Some(initialize) = self.initialize.lock().clone() else {
            return Err("The MCP session ended; initialize again".into());
        };
        let response = self.post(&initialize, None).await?;
        if !(200..300).contains(&response.status) {
            return Err(format!("OpenIDEA's MCP server refused a new session (HTTP {})", response.status));
        }
        *self.session.lock() = response.headers.get("mcp-session-id").cloned();
        // Read the reply off the connection; the client already has one.
        let _ = response.body.read_all().await;
        let session = self.session.lock().clone();
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let _ = self.post(&initialized, session.as_deref()).await?.body.read_all().await;
        Ok(())
    }

    async fn end_session(&self) {
        let Some(session) = self.session.lock().take() else { return };
        let _ = self.request("DELETE", None, Some(&session)).await;
    }

    async fn post(&self, message: &Value, session: Option<&str>) -> Result<HttpResponse, String> {
        self.request("POST", Some(message), session).await
    }

    async fn request(&self, method: &str, body: Option<&Value>, session: Option<&str>) -> Result<HttpResponse, String> {
        let port = self.bridge.port;
        let unreachable = |e: &dyn std::fmt::Display| {
            format!(
                "OpenIDEA's MCP server is not reachable on 127.0.0.1:{port} ({e}). Start OpenIDEA and enable Settings › Tools › MCP Server."
            )
        };
        let sock = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(("127.0.0.1", port)))
            .await
            .map_err(|e| unreachable(&e))?
            .map_err(|e| unreachable(&e))?;
        let body = body.map(Value::to_string).unwrap_or_default();
        let mut head = format!(
            "{method} {} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nAccept: application/json, text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n",
            crate::http::ENDPOINT,
            self.bridge.token,
            body.len()
        );
        if !body.is_empty() {
            head.push_str("Content-Type: application/json\r\n");
        }
        if let Some(session) = session {
            head.push_str(&format!("Mcp-Session-Id: {session}\r\n"));
        }
        // The server picks the project from this header and leaves `projectPath` out of the
        // tool schemas, as JetBrains' stdio runner does.
        if let Some(project) = self.bridge.project_path.as_deref().filter(|p| !p.contains(['\r', '\n'])) {
            head.push_str(&format!("{}: {project}\r\n", crate::project::PROJECT_PATH_HEADER));
        }
        if let Some(version) = self.protocol_version.lock().as_deref() {
            head.push_str(&format!("MCP-Protocol-Version: {version}\r\n"));
        }
        head.push_str("\r\n");
        let (read, mut write) = sock.into_split();
        let sent = async {
            write.write_all(head.as_bytes()).await?;
            write.write_all(body.as_bytes()).await?;
            write.flush().await
        };
        sent.await.map_err(|e| unreachable(&e))?;
        read_response(BufReader::new(read)).await.map_err(|e| format!("Reading OpenIDEA's MCP reply failed: {e}"))
    }
}

struct HttpResponse {
    status: u16,
    /// Lower-cased names.
    headers: HashMap<String, String>,
    body: Body,
}

async fn read_response(mut reader: BufReader<tokio::net::tcp::OwnedReadHalf>) -> std::io::Result<HttpResponse> {
    let bad = |why: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, why.to_owned());
    let mut total = 0;
    let mut line = String::new();
    let status = loop {
        line.clear();
        total += (&mut reader).take(MAX_HEAD as u64).read_line(&mut line).await?;
        if line.is_empty() {
            return Err(bad("connection closed before the reply"));
        }
        let status: u16 =
            line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| bad("bad status line"))?;
        // Interim replies (100 Continue) precede the real one.
        if status >= 200 {
            break status;
        }
        loop {
            line.clear();
            total += (&mut reader).take(MAX_HEAD as u64).read_line(&mut line).await?;
            if line.trim().is_empty() {
                break;
            }
        }
    };
    let mut headers = HashMap::new();
    loop {
        line.clear();
        total += (&mut reader).take(MAX_HEAD as u64).read_line(&mut line).await?;
        if total > MAX_HEAD {
            return Err(bad("reply head too large"));
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((name, value)) = l.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let mode = if headers.get("transfer-encoding").is_some_and(|t| t.to_ascii_lowercase().contains("chunked")) {
        Mode::Chunked
    } else if let Some(len) = headers.get("content-length") {
        Mode::Length(len.parse().map_err(|_| bad("bad Content-Length"))?)
    } else {
        Mode::UntilClose
    };
    Ok(HttpResponse { status, headers, body: Body { reader, mode } })
}

enum Mode {
    Length(usize),
    Chunked,
    UntilClose,
    Done,
}

/// A reply body, read as it arrives (an SSE stream is relayed event by event).
struct Body {
    reader: BufReader<tokio::net::tcp::OwnedReadHalf>,
    mode: Mode,
}

impl Body {
    async fn chunk(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        let mut buf = vec![0; 16 * 1024];
        match self.mode {
            Mode::Done | Mode::Length(0) => Ok(None),
            Mode::Length(left) => {
                let n = self.reader.read(&mut buf[..left.min(16 * 1024)]).await?;
                if n == 0 {
                    return Err(std::io::ErrorKind::UnexpectedEof.into());
                }
                self.mode = Mode::Length(left - n);
                buf.truncate(n);
                Ok(Some(buf))
            }
            Mode::UntilClose => {
                let n = self.reader.read(&mut buf).await?;
                if n == 0 {
                    self.mode = Mode::Done;
                    return Ok(None);
                }
                buf.truncate(n);
                Ok(Some(buf))
            }
            Mode::Chunked => {
                let mut line = String::new();
                (&mut self.reader).take(1024).read_line(&mut line).await?;
                let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)
                    .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad chunk"))?;
                if size == 0 {
                    self.mode = Mode::Done;
                    return Ok(None);
                }
                let mut data = vec![0; size];
                self.reader.read_exact(&mut data).await?;
                line.clear();
                (&mut self.reader).take(1024).read_line(&mut line).await?;
                Ok(Some(data))
            }
        }
    }

    async fn read_all(mut self) -> std::io::Result<Vec<u8>> {
        let mut all = Vec::new();
        while let Some(chunk) = self.chunk().await? {
            all.extend(chunk);
        }
        Ok(all)
    }
}

/// Splits a `text/event-stream` into the `data` of its events.
#[derive(Default)]
struct SseParser {
    pending: Vec<u8>,
    data: Option<String>,
}

impl SseParser {
    fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(i) = self.pending.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.pending.drain(..=i).collect();
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                events.extend(self.data.take());
            } else if let Some(value) = line.strip_prefix("data:") {
                let value = value.strip_prefix(' ').unwrap_or(value);
                match &mut self.data {
                    Some(data) => {
                        data.push('\n');
                        data.push_str(value);
                    }
                    None => self.data = Some(value.to_owned()),
                }
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_sse_events_across_chunks() {
        let mut p = SseParser::default();
        assert!(p.feed(b"event: message\r\ndata: {\"a\":").is_empty());
        assert_eq!(
            p.feed(b"1}\r\n\r\n: ping\n\ndata: x\ndata: y\n\n"),
            vec!["{\"a\":1}".to_owned(), "x\ny".to_owned()]
        );
    }

    #[test]
    fn reads_settings_from_variables() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp-token");
        std::fs::write(&file, "secret\n").unwrap();
        let vars = |p: &'static str, t: Option<&'static str>| {
            move |n: &str| match n {
                PORT_ENV => Some(p.to_owned()),
                TOKEN_ENV => t.map(str::to_owned),
                _ => None,
            }
        };
        let b = Bridge::from_vars(vars("6000", None), Some(&file)).unwrap();
        assert_eq!((b.port, b.token.as_str(), b.project_path), (6000, "secret", None));
        assert_eq!(Bridge::from_vars(vars("6000", Some("t")), None).unwrap().token, "t");
        assert!(Bridge::from_vars(vars("x", Some("t")), None).unwrap_err().contains(PORT_ENV));
        assert!(Bridge::from_vars(vars("6000", None), None).is_err());
    }
}
