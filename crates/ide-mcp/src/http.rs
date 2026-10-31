// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/impl/util/network/mcp.sdk.util.kt, StreamableHttpSession.kt), Apache-2.0.
//! HTTP on `127.0.0.1`. Every request needs the bearer token; `Host` and `Origin` must
//! be local (no DNS rebinding, no web pages), and both are checked before a body is read.
//!
//! - Streamable HTTP on `/mcp` (also `/stream`, JetBrains' path): `POST` carries JSON-RPC
//!   messages and gets JSON back, or an SSE stream when the client accepts one and a tool
//!   call may send progress, elicitations or `roots/list` while it runs; `GET` opens the
//!   session's notification stream; `DELETE` ends the session.
//! - The legacy SSE transport (older client configurations): `GET /sse` opens a session
//!   and its stream, whose first event names `/message?sessionId=…`; messages POSTed
//!   there get `202` and their answers come on the stream.

use crate::Shared;
use crate::project::PROJECT_PATH_HEADER;
use crate::protocol::{self, Ctx, Handled, PARSE_ERROR};
use crate::session::Session;
use ide_core::CancellationToken;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

pub const ENDPOINT: &str = "/mcp";
/// The legacy SSE transport's stream.
pub const SSE_ENDPOINT: &str = "/sse";
/// Where the legacy SSE transport's messages go.
pub const MESSAGE_ENDPOINT: &str = "/message";
const MAX_HEAD: usize = 64 * 1024;
const MAX_BODY: usize = 32 * 1024 * 1024;
/// How long an idle keep-alive connection waits for its next request.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const SESSION_HEADER: &str = "mcp-session-id";

/// Accepts connections until `stop` is cancelled.
pub(crate) async fn serve(listener: TcpListener, shared: Arc<Shared>, stop: CancellationToken) {
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    loop {
        let accepted = tokio::select! {
            a = listener.accept() => a,
            _ = stop.cancelled() => return,
        };
        match accepted {
            Ok((sock, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let shared = shared.clone();
                let stop = stop.clone();
                tokio::spawn(async move {
                    tokio::select! {
                        r = connection(sock, &shared, port) => {
                            if let Err(e) = r {
                                tracing::debug!("MCP connection: {e}");
                            }
                        }
                        _ = stop.cancelled() => {}
                    }
                });
            }
            Err(e) => {
                tracing::warn!("MCP server accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

pub(crate) struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    /// Lower-cased names.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    fn query_param(&self, name: &str) -> Option<&str> {
        self.query.split('&').filter_map(|p| p.split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v)
    }

    fn project_header(&self) -> Option<String> {
        self.header(&PROJECT_PATH_HEADER.to_ascii_lowercase()).map(str::to_owned)
    }
}

pub(crate) enum Body {
    Full(Vec<u8>),
    Sse(Sse),
}

pub(crate) struct Response {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Body,
}

impl Response {
    fn new(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: Body::Full(Vec::new()) }
    }

    fn json(status: u16, value: &Value) -> Self {
        let mut r = Self::new(status);
        r.headers.push(("Content-Type", "application/json".into()));
        r.body = Body::Full(serde_json::to_vec(value).unwrap_or_default());
        r
    }

    fn text(status: u16, text: &str) -> Self {
        let mut r = Self::new(status);
        r.headers.push(("Content-Type", "text/plain; charset=utf-8".into()));
        r.body = Body::Full(text.as_bytes().to_vec());
        r
    }

    fn sse(sse: Sse) -> Self {
        let mut r = Self::new(200);
        r.headers.push(("Content-Type", "text/event-stream".into()));
        r.body = Body::Sse(sse);
        r
    }
}

/// An SSE response: JSON-RPC messages as `message` events, and a heartbeat comment
/// whenever nothing went out for a while (a failed write is how a dropped client shows).
pub(crate) struct Sse {
    /// A raw event written first (the legacy transport's `endpoint`).
    prelude: Option<String>,
    rx: mpsc::UnboundedReceiver<Value>,
    /// A POST's stream ends once the responses to these request ids went out; a
    /// notification stream (`None`) runs until its session ends.
    until: Option<HashSet<String>>,
    closed: CancellationToken,
    heartbeat: Duration,
    /// Runs when the stream ends, however it ends.
    _on_end: OnEnd,
}

struct OnEnd(Option<Box<dyn FnOnce() + Send>>);

impl Drop for OnEnd {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

async fn connection(sock: TcpStream, shared: &Arc<Shared>, port: u16) -> std::io::Result<()> {
    let (read, mut write) = sock.into_split();
    let mut reader = BufReader::new(read);
    loop {
        let head = match tokio::time::timeout(IDLE_TIMEOUT, read_head(&mut reader)).await {
            Err(_) => return Ok(()),
            Ok(Err(RequestError::Io(e))) => return Err(e),
            Ok(Err(RequestError::Bad(status, why))) => {
                write_response(&mut write, Response::text(status, why), false).await?;
                return Ok(());
            }
            Ok(Ok(None)) => return Ok(()),
            Ok(Ok(Some(r))) => r,
        };
        // Who is asking is checked before a body is read (no buffering for strangers).
        if let Some(rejected) = precheck(shared, port, &head) {
            write_response(&mut write, rejected, false).await?;
            return Ok(());
        }
        if head.header("expect").is_some_and(|e| e.eq_ignore_ascii_case("100-continue")) {
            write.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await?;
        }
        let request = match tokio::time::timeout(IDLE_TIMEOUT, read_body(&mut reader, head)).await {
            Err(_) => return Ok(()),
            Ok(Err(RequestError::Io(e))) => return Err(e),
            Ok(Err(RequestError::Bad(status, why))) => {
                write_response(&mut write, Response::text(status, why), false).await?;
                return Ok(());
            }
            Ok(Ok(r)) => r,
        };
        let keep_alive = !request.header("connection").is_some_and(|c| c.eq_ignore_ascii_case("close"));
        let response = route(shared, port, request).await;
        write_response(&mut write, response, keep_alive).await?;
        if !keep_alive {
            return Ok(());
        }
    }
}

enum RequestError {
    Io(std::io::Error),
    Bad(u16, &'static str),
}

impl From<std::io::Error> for RequestError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Splits a request target into path and query.
fn split_target(target: &str) -> (String, String) {
    let target = target.split('#').next().unwrap_or("");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    (path.to_owned(), query.to_owned())
}

/// The request line and headers; the body is read by [`read_body`].
async fn read_head<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Request>, RequestError> {
    let mut head_len = 0usize;
    let mut line = String::new();
    // Tolerate blank lines between keep-alive requests.
    loop {
        line.clear();
        if read_line(reader, &mut line, &mut head_len).await? == 0 {
            return Ok(None);
        }
        if !line.trim().is_empty() {
            break;
        }
    }
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Err(RequestError::Bad(400, "Bad Request"));
    };
    let method = method.to_ascii_uppercase();
    let (path, query) = split_target(target);
    let mut headers = HashMap::new();
    loop {
        line.clear();
        if read_line(reader, &mut line, &mut head_len).await? == 0 {
            return Ok(None);
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((name, value)) = l.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    Ok(Some(Request { method, path, query, headers, body: Vec::new() }))
}

async fn read_body<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    mut head: Request,
) -> Result<Request, RequestError> {
    let headers = &head.headers;
    let chunked = headers.get("transfer-encoding").is_some_and(|t| t.to_ascii_lowercase().contains("chunked"));
    let body = if chunked {
        read_chunked(reader).await?
    } else {
        let len: usize = match headers.get("content-length") {
            None => 0,
            Some(l) => l.parse().map_err(|_| RequestError::Bad(400, "Bad Content-Length"))?,
        };
        if len > MAX_BODY {
            return Err(RequestError::Bad(413, "Payload Too Large"));
        }
        let mut body = vec![0; len];
        reader.read_exact(&mut body).await?;
        body
    };
    head.body = body;
    Ok(head)
}

#[cfg(test)]
async fn read_request<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Request>, RequestError> {
    match read_head(reader).await? {
        Some(head) => Ok(Some(read_body(reader, head).await?)),
        None => Ok(None),
    }
}

async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut String,
    total: &mut usize,
) -> Result<usize, RequestError> {
    // `take` bounds a line without a newline too.
    let budget = (MAX_HEAD + 1).saturating_sub(*total) as u64;
    let n = (&mut *reader).take(budget).read_line(line).await?;
    *total += n;
    if *total > MAX_HEAD {
        return Err(RequestError::Bad(431, "Request Header Fields Too Large"));
    }
    Ok(n)
}

async fn read_chunked<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, RequestError> {
    let mut body = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        (&mut *reader).take(1024).read_line(&mut line).await?;
        let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)
            .map_err(|_| RequestError::Bad(400, "Bad chunk"))?;
        if size == 0 {
            // Trailers until the empty line.
            loop {
                line.clear();
                if (&mut *reader).take(8192).read_line(&mut line).await? == 0 || line.trim().is_empty() {
                    return Ok(body);
                }
            }
        }
        if body.len() + size > MAX_BODY {
            return Err(RequestError::Bad(413, "Payload Too Large"));
        }
        let start = body.len();
        body.resize(start + size, 0);
        reader.read_exact(&mut body[start..]).await?;
        line.clear();
        (&mut *reader).take(1024).read_line(&mut line).await?;
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    }
}

async fn write_response<W: AsyncWrite + Unpin>(
    write: &mut W,
    response: Response,
    keep_alive: bool,
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, reason(response.status));
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    let length = match &response.body {
        Body::Full(bytes) => format!("Content-Length: {}", bytes.len()),
        Body::Sse(_) => "Transfer-Encoding: chunked".to_owned(),
    };
    head.push_str(&format!(
        "{length}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: {}\r\n\r\n",
        if keep_alive { "keep-alive" } else { "close" }
    ));
    write.write_all(head.as_bytes()).await?;
    match response.body {
        Body::Full(bytes) => write.write_all(&bytes).await?,
        Body::Sse(sse) => write_sse(write, sse, true).await?,
    }
    write.flush().await
}

/// Writes the events of `sse` until it ends; `chunked` frames them for HTTP.
async fn write_sse<W: AsyncWrite + Unpin>(write: &mut W, mut sse: Sse, chunked: bool) -> std::io::Result<()> {
    async fn put<W: AsyncWrite + Unpin>(write: &mut W, text: &str, chunked: bool) -> std::io::Result<()> {
        if chunked {
            write.write_all(format!("{:x}\r\n{text}\r\n", text.len()).as_bytes()).await?;
        } else {
            write.write_all(text.as_bytes()).await?;
        }
        write.flush().await
    }
    if let Some(prelude) = sse.prelude.take() {
        put(write, &prelude, chunked).await?;
    }
    while !sse.until.as_ref().is_some_and(HashSet::is_empty) {
        tokio::select! {
            biased;
            message = sse.rx.recv() => {
                let Some(message) = message else { break };
                if let Some(until) = &mut sse.until
                    && message.get("method").is_none()
                    && let Some(id) = message.get("id")
                {
                    until.remove(&id.to_string());
                }
                put(write, &format!("event: message\ndata: {message}\n\n"), chunked).await?;
            }
            _ = sse.closed.cancelled() => break,
            _ = tokio::time::sleep(sse.heartbeat) => put(write, ": heartbeat\n\n", chunked).await?,
        }
    }
    if chunked {
        write.write_all(b"0\r\n\r\n").await?;
    }
    write.flush().await
}

/// `Host` must name this server on a loopback address (no DNS rebinding).
fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host.map(str::to_ascii_lowercase) else { return false };
    ["127.0.0.1", "localhost", "[::1]"].iter().any(|h| host == format!("{h}:{port}") || (port == 80 && host == *h))
}

/// Browsers send `Origin`; only pages of a loopback origin may call (CLI clients send none).
fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    let rest = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://"));
    let Some(rest) = rest else { return false };
    let host = rest.split('/').next().unwrap_or("");
    let host = if host.starts_with('[') { host.split(']').next().map(|h| &h[1..]) } else { host.split(':').next() };
    matches!(host, Some("127.0.0.1" | "localhost" | "::1"))
}

/// Constant-time comparison of the presented bearer token.
fn token_matches(header: Option<&str>, token: &str) -> bool {
    let Some(presented) = header.and_then(|h| {
        let (scheme, value) = h.trim().split_once(' ')?;
        scheme.eq_ignore_ascii_case("bearer").then(|| value.trim())
    }) else {
        return false;
    };
    let (a, b) = (presented.as_bytes(), token.as_bytes());
    if a.len() != b.len() || token.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The checks that need only the head: Host, Origin, path and token.
fn precheck(shared: &Arc<Shared>, port: u16, request: &Request) -> Option<Response> {
    if !host_allowed(request.header("host"), port) {
        return Some(Response::text(403, "Forbidden: unexpected Host"));
    }
    if !origin_allowed(request.header("origin")) {
        return Some(Response::text(403, "Forbidden: cross-origin requests are not allowed"));
    }
    if !matches!(request.path.as_str(), ENDPOINT | "/mcp/" | "/" | "/stream" | SSE_ENDPOINT | MESSAGE_ENDPOINT) {
        return Some(Response::text(404, "Not Found"));
    }
    let token = shared.config.read().token.clone();
    if !token_matches(request.header("authorization"), &token) {
        let mut r = Response::json(
            401,
            &protocol::error(
                Value::Null,
                -32001,
                "Unauthorized: send the token from OpenIDEA's Settings › Tools › MCP Server as `Authorization: Bearer <token>`",
            ),
        );
        r.headers.push(("WWW-Authenticate", "Bearer realm=\"OpenIDEA\"".into()));
        return Some(r);
    }
    None
}

fn method_not_allowed(allow: &str) -> Response {
    let mut r = Response::text(405, "Method Not Allowed");
    r.headers.push(("Allow", allow.into()));
    r
}

pub(crate) async fn route(shared: &Arc<Shared>, port: u16, request: Request) -> Response {
    if let Some(rejected) = precheck(shared, port, &request) {
        return rejected;
    }
    if let Some(version) = request.header("mcp-protocol-version")
        && !protocol::PROTOCOL_VERSIONS.contains(&version)
    {
        return Response::text(400, "Unsupported MCP-Protocol-Version");
    }
    match (request.path.as_str(), request.method.as_str()) {
        (SSE_ENDPOINT, "GET") => legacy_stream(shared, &request),
        (SSE_ENDPOINT, _) => method_not_allowed("GET"),
        (MESSAGE_ENDPOINT, "POST") => legacy_post(shared, &request),
        (MESSAGE_ENDPOINT, _) => method_not_allowed("POST"),
        (_, "POST") => post(shared, &request).await,
        (_, "GET") => notification_stream(shared, &request),
        (_, "DELETE") => match request.header(SESSION_HEADER) {
            Some(s) if shared.remove_session(s) => Response::new(200),
            Some(_) => Response::text(404, "Unknown session"),
            None => Response::text(400, "Missing Mcp-Session-Id"),
        },
        _ => method_not_allowed("GET, POST, DELETE"),
    }
}

fn accepts_sse(request: &Request) -> bool {
    request.header("accept").is_some_and(|a| a.to_ascii_lowercase().contains("text/event-stream"))
}

async fn post(shared: &Arc<Shared>, request: &Request) -> Response {
    let body: Value = match serde_json::from_slice(&request.body) {
        Ok(v) => v,
        Err(e) => return Response::json(400, &protocol::error(Value::Null, PARSE_ERROR, format!("invalid JSON: {e}"))),
    };
    let initializes = |m: &Value| m.get("method").and_then(Value::as_str) == Some("initialize");
    let is_initialize = match &body {
        Value::Array(items) => items.iter().any(initializes),
        m => initializes(m),
    };
    let session = match request.header(SESSION_HEADER) {
        Some(_) if is_initialize => None,
        // An unknown session (the server restarted): 404 tells the client to initialize again.
        Some(id) => match shared.session(id) {
            Some(s) if !s.legacy => Some(s),
            _ => {
                return Response::json(
                    404,
                    &protocol::error(Value::Null, -32001, "Session not found; initialize again"),
                );
            }
        },
        None => None,
    };
    let project_header = request.project_header();
    if let Some(s) = &session
        && accepts_sse(request)
        && protocol::wants_stream(shared, s, &body)
    {
        let (tx, rx) = mpsc::unbounded_channel();
        let id = body.get("id").map(Value::to_string).unwrap_or_default();
        let ctx = Ctx { session: Some(s.clone()), outbound: Some(tx.clone()), project_header };
        let heartbeat = shared.timing.read().heartbeat;
        let shared = shared.clone();
        // Not tied to the connection: a dropped stream does not cancel the call.
        tokio::spawn(async move {
            if let Handled::Reply(reply) = protocol::handle(&shared, &ctx, body, &mut None).await {
                let _ = tx.send(reply);
            }
        });
        return Response::sse(Sse {
            prelude: None,
            rx,
            until: Some(HashSet::from([id])),
            closed: s.closed.clone(),
            heartbeat,
            _on_end: OnEnd(None),
        });
    }
    let mut new_session = None;
    let ctx = Ctx { session, outbound: None, project_header };
    let handled = protocol::handle(shared, &ctx, body, &mut new_session).await;
    let mut response = match handled {
        Handled::Reply(v) => Response::json(200, &v),
        Handled::Accepted => Response::new(202),
    };
    if let Some(s) = new_session {
        response.headers.push(("Mcp-Session-Id", s));
    }
    response
}

/// `GET` on the endpoint: the session's stream for notifications and the server's
/// requests that belong to no call (`roots/list`, `notifications/tools/list_changed`).
fn notification_stream(shared: &Arc<Shared>, request: &Request) -> Response {
    let Some(id) = request.header(SESSION_HEADER) else {
        return Response::text(400, "Missing Mcp-Session-Id");
    };
    let Some(session) = shared.session(id).filter(|s| !s.legacy) else {
        return Response::text(404, "Streamable HTTP session not found");
    };
    if !accepts_sse(request) {
        return Response::text(406, "Not Acceptable: the client must accept text/event-stream");
    }
    let Some((generation, rx)) = session.open_stream() else {
        return Response::text(409, "Conflict: only one notification stream is allowed per session");
    };
    protocol::refresh_roots(shared, &session);
    let ended = session.clone();
    let mut response = Response::sse(Sse {
        prelude: None,
        rx,
        until: None,
        closed: session.closed.clone(),
        heartbeat: shared.timing.read().heartbeat,
        _on_end: OnEnd(Some(Box::new(move || ended.stream_closed(generation)))),
    });
    response.headers.push(("Mcp-Session-Id", session.id.clone()));
    response
}

/// `GET /sse`: a legacy session lives as long as its stream.
fn legacy_stream(shared: &Arc<Shared>, request: &Request) -> Response {
    if !accepts_sse(request) && request.header("accept").is_some_and(|a| !a.contains("*/*")) {
        return Response::text(406, "Not Acceptable: the client must accept text/event-stream");
    }
    let session = Arc::new(Session::new(uuid::Uuid::new_v4().simple().to_string(), true, request.project_header()));
    let Some((_, rx)) = session.open_stream() else { unreachable!("a new session has no stream") };
    shared.add_session(session.clone());
    let prelude = format!("event: endpoint\ndata: {MESSAGE_ENDPOINT}?sessionId={}\n\n", session.id);
    let (owner, id) = (shared.clone(), session.id.clone());
    Response::sse(Sse {
        prelude: Some(prelude),
        rx,
        until: None,
        closed: session.closed.clone(),
        heartbeat: shared.timing.read().heartbeat,
        _on_end: OnEnd(Some(Box::new(move || {
            owner.remove_session(&id);
        }))),
    })
}

/// `POST /message?sessionId=…`: accepted at once; the answers go out on the session's stream.
fn legacy_post(shared: &Arc<Shared>, request: &Request) -> Response {
    let Some(id) = request.query_param("sessionId") else {
        return Response::text(400, "sessionId query parameter is not provided");
    };
    let Some(session) = shared.session(id).filter(|s| s.legacy) else {
        return Response::text(404, "Session not found");
    };
    let body: Value = match serde_json::from_slice(&request.body) {
        Ok(v) => v,
        Err(e) => return Response::json(400, &protocol::error(Value::Null, PARSE_ERROR, format!("invalid JSON: {e}"))),
    };
    let ctx = Ctx { session: Some(session.clone()), outbound: None, project_header: request.project_header() };
    let shared = shared.clone();
    tokio::spawn(async move {
        if let Handled::Reply(reply) = protocol::handle(&shared, &ctx, body, &mut None).await {
            session.send(None, reply);
        }
    });
    Response::text(202, "Accepted")
}

/// What a test request got: the status, the headers, a plain body, and for an SSE
/// response its events as they are written (heartbeat comments included).
#[doc(hidden)]
pub struct TestResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub events: Option<mpsc::UnboundedReceiver<String>>,
}

pub(crate) async fn request_for_test(
    shared: &Arc<Shared>,
    port: u16,
    method: &str,
    target: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> TestResponse {
    let (path, query) = split_target(target);
    let request = Request {
        method: method.into(),
        path,
        query,
        headers: headers.iter().map(|(k, v)| (k.to_ascii_lowercase(), (*v).to_owned())).collect(),
        body: body.as_bytes().to_vec(),
    };
    let r = route(shared, port, request).await;
    let headers = r.headers.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
    match r.body {
        Body::Full(bytes) => {
            TestResponse { status: r.status, headers, body: String::from_utf8_lossy(&bytes).into_owned(), events: None }
        }
        Body::Sse(sse) => {
            let (mut write, mut read) = tokio::io::duplex(1 << 16);
            tokio::spawn(async move { write_sse(&mut write, sse, false).await });
            let (tx, rx) = mpsc::unbounded_channel();
            tokio::spawn(async move {
                let mut buffer = String::new();
                let mut chunk = vec![0u8; 1 << 16];
                while let Ok(n) = read.read(&mut chunk).await {
                    if n == 0 {
                        break;
                    }
                    buffer.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    while let Some(end) = buffer.find("\n\n") {
                        let event: String = buffer.drain(..end + 2).collect();
                        if tx.send(event).is_err() {
                            return;
                        }
                    }
                }
            });
            TestResponse { status: r.status, headers, body: String::new(), events: Some(rx) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_host_origin_and_token() {
        assert!(host_allowed(Some("127.0.0.1:5000"), 5000));
        assert!(host_allowed(Some("LOCALHOST:5000"), 5000));
        assert!(!host_allowed(Some("evil.com:5000"), 5000));
        assert!(!host_allowed(Some("127.0.0.1:5001"), 5000));
        assert!(!host_allowed(None, 5000));

        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("http://localhost:3000")));
        assert!(origin_allowed(Some("http://[::1]:3000")));
        assert!(!origin_allowed(Some("https://evil.com")));
        assert!(!origin_allowed(Some("http://localhost.evil.com")));
        assert!(!origin_allowed(Some("null")));

        assert!(token_matches(Some("Bearer abc"), "abc"));
        assert!(token_matches(Some("bearer  abc "), "abc"));
        assert!(!token_matches(Some("Bearer abd"), "abc"));
        assert!(!token_matches(Some("Basic abc"), "abc"));
        assert!(!token_matches(None, "abc"));
        assert!(!token_matches(Some("Bearer "), ""));
    }

    #[tokio::test]
    async fn reads_content_length_and_chunked_bodies() {
        let raw = b"POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nabcd";
        let mut r = BufReader::new(&raw[..]);
        let req = read_request(&mut r).await.ok().flatten().unwrap();
        assert_eq!((req.method.as_str(), req.path.as_str(), req.body.as_slice()), ("POST", "/mcp", &b"abcd"[..]));

        let raw = b"POST /message?x=1&sessionId=ab HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n";
        let mut r = BufReader::new(&raw[..]);
        let req = read_request(&mut r).await.ok().flatten().unwrap();
        assert_eq!((req.path.as_str(), req.body.as_slice()), ("/message", &b"abcde"[..]));
        assert_eq!(req.query_param("sessionId"), Some("ab"));
    }

    #[tokio::test]
    async fn writes_sse_until_the_responses_went_out() {
        let (tx, rx) = mpsc::unbounded_channel();
        let sse = Sse {
            prelude: None,
            rx,
            until: Some(HashSet::from(["7".to_owned()])),
            closed: CancellationToken::new(),
            heartbeat: Duration::from_secs(60),
            _on_end: OnEnd(None),
        };
        tx.send(serde_json::json!({ "method": "notifications/progress", "params": {} })).unwrap();
        tx.send(serde_json::json!({ "id": 3, "method": "elicitation/create" })).unwrap();
        tx.send(serde_json::json!({ "id": 7, "result": {} })).unwrap();
        let mut out = Vec::new();
        write_sse(&mut out, sse, true).await.unwrap();
        let out = String::from_utf8(out).unwrap();
        assert_eq!(out.matches("event: message\ndata: ").count(), 3, "{out}");
        assert!(out.ends_with("\r\n0\r\n\r\n"), "{out}");
    }
}
