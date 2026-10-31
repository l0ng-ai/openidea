//! The streamable HTTP transport on `127.0.0.1`: `POST /mcp` carries JSON-RPC
//! messages and gets JSON back, `DELETE /mcp` ends a session. Every request needs
//! the bearer token; `Host` and `Origin` must be local (no DNS rebinding, no web pages).

use crate::Shared;
use crate::protocol::{self, Handled, PARSE_ERROR};
use ide_core::CancellationToken;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

pub const ENDPOINT: &str = "/mcp";
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
    /// Lower-cased names.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

pub(crate) struct Response {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Response {
    fn new(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: Vec::new() }
    }

    fn json(status: u16, value: &Value) -> Self {
        let mut r = Self::new(status);
        r.headers.push(("Content-Type", "application/json".into()));
        r.body = serde_json::to_vec(value).unwrap_or_default();
        r
    }

    fn text(status: u16, text: &str) -> Self {
        let mut r = Self::new(status);
        r.headers.push(("Content-Type", "text/plain; charset=utf-8".into()));
        r.body = text.as_bytes().to_vec();
        r
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
    let path = target.split(['?', '#']).next().unwrap_or("").to_owned();
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
    Ok(Some(Request { method, path, headers, body: Vec::new() }))
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
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    }
}

async fn write_response<W: tokio::io::AsyncWrite + Unpin>(
    write: &mut W,
    response: Response,
    keep_alive: bool,
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, reason(response.status));
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "Content-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: {}\r\n\r\n",
        response.body.len(),
        if keep_alive { "keep-alive" } else { "close" }
    ));
    write.write_all(head.as_bytes()).await?;
    write.write_all(&response.body).await?;
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
    if !matches!(request.path.as_str(), ENDPOINT | "/mcp/" | "/") {
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

pub(crate) async fn route(shared: &Arc<Shared>, port: u16, request: Request) -> Response {
    if let Some(rejected) = precheck(shared, port, &request) {
        return rejected;
    }
    if let Some(version) = request.header("mcp-protocol-version")
        && !protocol::PROTOCOL_VERSIONS.contains(&version)
    {
        return Response::text(400, "Unsupported MCP-Protocol-Version");
    }
    let session = request.header(SESSION_HEADER).map(str::to_owned);
    match request.method.as_str() {
        "POST" => post(shared, session, &request.body).await,
        "DELETE" => match session {
            Some(s) if shared.sessions.lock().remove(&s).is_some() => Response::new(200),
            Some(_) => Response::text(404, "Unknown session"),
            None => Response::text(400, "Missing Mcp-Session-Id"),
        },
        // No server-initiated stream: the spec allows 405 for GET.
        _ => {
            let mut r = Response::text(405, "Method Not Allowed");
            r.headers.push(("Allow", "POST, DELETE".into()));
            r
        }
    }
}

async fn post(shared: &Arc<Shared>, session: Option<String>, body: &[u8]) -> Response {
    let body: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return Response::json(400, &protocol::error(Value::Null, PARSE_ERROR, format!("invalid JSON: {e}"))),
    };
    let initializes = |m: &Value| m.get("method").and_then(Value::as_str) == Some("initialize");
    let is_initialize = match &body {
        Value::Array(items) => items.iter().any(initializes),
        m => initializes(m),
    };
    // An unknown session (the server restarted): 404 tells the client to initialize again.
    if let Some(s) = &session
        && !is_initialize
        && !shared.sessions.lock().contains_key(s)
    {
        return Response::json(404, &protocol::error(Value::Null, -32001, "Session not found; initialize again"));
    }
    let mut new_session = None;
    let handled = protocol::handle(shared, if is_initialize { None } else { session }, body, &mut new_session).await;
    let mut response = match handled {
        Handled::Reply(v) => Response::json(200, &v),
        Handled::Accepted => Response::new(202),
    };
    if let Some(s) = new_session {
        response.headers.push(("Mcp-Session-Id", s));
    }
    response
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

        let raw = b"POST /mcp?x=1 HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n";
        let mut r = BufReader::new(&raw[..]);
        let req = read_request(&mut r).await.ok().flatten().unwrap();
        assert_eq!((req.path.as_str(), req.body.as_slice()), ("/mcp", &b"abcde"[..]));
    }
}
