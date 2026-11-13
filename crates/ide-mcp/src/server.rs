//! The HTTP side: one endpoint, `/mcp`, on the loopback interface.

use crate::discovery::Discovery;
use crate::{CancellationToken, PROJECT_HEADER, ToolRegistry, protocol};
use bytes::Bytes;
use http_body_util::{BodyExt, Either, Full, Limited};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{Value, json};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::DropGuard;

/// Largest request body.
const MAX_BODY: usize = 8 << 20;
/// A call still running after this long is answered on an event stream (when the client
/// takes one), so that it can take as long as it needs: clients give up on a POST whose
/// response has not started (Claude Code after a minute).
#[cfg(not(test))]
const STREAM_AFTER: Duration = Duration::from_secs(1);
#[cfg(test)]
const STREAM_AFTER: Duration = Duration::from_millis(100);
/// How often a streamed call reports that it is still running: progress notifications reset
/// the client's idle timeout (Claude Code's is five minutes).
#[cfg(not(test))]
const HEARTBEAT: Duration = Duration::from_secs(15);
#[cfg(test)]
const HEARTBEAT: Duration = Duration::from_millis(100);

type Handled = Result<Option<Value>, Value>;
type Body = Either<Full<Bytes>, EventStream>;

struct Shared {
    registry: Arc<dyn ToolRegistry>,
    token: String,
    port: u16,
    requests: protocol::Requests,
    cancel: CancellationToken,
}

/// The running server. Stopping it (or dropping it) closes the port and
/// removes its discovery file.
pub struct McpServer {
    port: u16,
    token: String,
    discovery: Option<PathBuf>,
    shutdown: watch::Sender<bool>,
    cancel: CancellationToken,
}

impl McpServer {
    /// Starts listening on `127.0.0.1:<random port>` with a new token, on
    /// `runtime`, and writes the discovery file at `discovery` if given.
    pub fn start(
        registry: Arc<dyn ToolRegistry>,
        discovery: Option<PathBuf>,
        runtime: &tokio::runtime::Handle,
    ) -> std::io::Result<Self> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = new_token()?;
        let listener = {
            let _entered = runtime.enter();
            tokio::net::TcpListener::from_std(listener)?
        };
        if let Some(path) = &discovery {
            let info = Discovery {
                port,
                token: token.clone(),
                pid: std::process::id(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
            };
            info.write(path)?;
        }
        let (shutdown, stopped) = watch::channel(false);
        let cancel = CancellationToken::new();
        let shared = Arc::new(Shared {
            registry,
            token: token.clone(),
            port,
            requests: Default::default(),
            cancel: cancel.clone(),
        });
        runtime.spawn(accept(listener, shared, stopped));
        tracing::info!("MCP server on 127.0.0.1:{port}");
        Ok(Self { port, token, discovery, shutdown, cancel })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The bearer token of this run.
    pub fn token(&self) -> &str {
        &self.token
    }

    /// The endpoint URL for `project`.
    pub fn url(&self, project: &Path) -> String {
        crate::endpoint_url(self.port, project)
    }

    pub fn stop(self) {}
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.cancel.cancel();
        let _ = self.shutdown.send(true);
        if let Some(path) = &self.discovery {
            Discovery::remove_if_ours(path);
        }
    }
}

pub(crate) fn new_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

async fn accept(listener: tokio::net::TcpListener, shared: Arc<Shared>, mut stopped: watch::Receiver<bool>) {
    loop {
        let stream = tokio::select! {
            _ = stopped.changed() => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(e) => {
                    tracing::warn!("MCP server accept: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }
            },
        };
        let (shared, mut stopped) = (shared.clone(), stopped.clone());
        tokio::spawn(async move {
            let scope = match new_token() {
                Ok(scope) => scope,
                Err(_) => return,
            };
            let service = hyper::service::service_fn(move |req| serve(req, shared.clone(), scope.clone()));
            let conn = hyper::server::conn::http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service);
            tokio::pin!(conn);
            tokio::select! {
                result = conn.as_mut() => {
                    if let Err(e) = result {
                        tracing::debug!("MCP connection: {e}");
                    }
                }
                _ = stopped.changed() => {}
            }
        });
    }
}

async fn serve(req: Request<Incoming>, shared: Arc<Shared>, scope: String) -> Result<Response<Body>, Infallible> {
    Ok(respond(req, &shared, scope).await)
}

type Reply = Response<Body>;

async fn respond(req: Request<Incoming>, shared: &Arc<Shared>, scope: String) -> Reply {
    if req.uri().path() != "/mcp" {
        return plain(StatusCode::NOT_FOUND, "not found: the endpoint is /mcp");
    }
    if !local_request(req.headers(), shared.port) {
        return plain(StatusCode::FORBIDDEN, "requests from web pages are refused");
    }
    if !authorized(req.headers(), &shared.token) {
        let mut response = plain(StatusCode::UNAUTHORIZED, "missing or wrong bearer token");
        response.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        return response;
    }
    if req.method() != Method::POST {
        // No stream of server-initiated messages: every answer is in the POST's response.
        let mut response = plain(StatusCode::METHOD_NOT_ALLOWED, "only POST");
        response.headers_mut().insert(header::ALLOW, HeaderValue::from_static("POST"));
        return response;
    }
    if let Some(version) = req.headers().get("mcp-protocol-version")
        && !version.to_str().is_ok_and(|v| protocol::SUPPORTED.contains(&v))
    {
        return plain(StatusCode::BAD_REQUEST, "unsupported MCP-Protocol-Version");
    }
    let scope = req.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).unwrap_or(&scope).to_owned();
    let project = project_of(&req);
    let streams =
        req.headers().get_all(header::ACCEPT).iter().any(|v| v.to_str().is_ok_and(|v| v.contains("text/event-stream")));
    let body = match Limited::new(req.into_body(), MAX_BODY).collect().await {
        Ok(body) => body.to_bytes(),
        Err(e) => return plain(StatusCode::PAYLOAD_TOO_LARGE, &format!("request body: {e}")),
    };
    let message = serde_json::from_slice::<Value>(&body).ok();
    let initializing = message.as_ref().is_some_and(|m| m.get("method").and_then(|v| v.as_str()) == Some("initialize"));
    let id = message.as_ref().and_then(|m| m.get("id")).cloned().unwrap_or(Value::Null);
    let progress_token = message.as_ref().and_then(|m| m.pointer("/params/_meta/progressToken")).cloned();
    let response_scope = scope.clone();
    let registry = shared.registry.clone();
    let shared = shared.clone();
    let cancel = shared.cancel.child_token();
    // Cancels the call when the client goes away (the response is dropped).
    let guard = cancel.clone().drop_guard();
    let mut handled = tokio::task::spawn_blocking(move || {
        protocol::handle_body(registry.as_ref(), project.as_deref(), &body, &shared.requests, &scope, cancel)
    });
    if streams && !initializing {
        match tokio::time::timeout(STREAM_AFTER, &mut handled).await {
            Ok(done) => return answer(done, false, &response_scope),
            Err(_) => return event_stream(handled, id, progress_token, guard),
        }
    }
    let done = handled.await;
    drop(guard);
    answer(done, initializing, &response_scope)
}

fn answer(handled: Result<Handled, JoinError>, initializing: bool, scope: &str) -> Reply {
    match handled {
        Ok(Ok(Some(reply))) => {
            let mut response = json(StatusCode::OK, &reply);
            if initializing && let Ok(value) = HeaderValue::from_str(scope) {
                response.headers_mut().insert("mcp-session-id", value);
            }
            response
        }
        Ok(Ok(None)) => empty(StatusCode::ACCEPTED),
        Ok(Err(parse_error)) => json(StatusCode::BAD_REQUEST, &parse_error),
        Err(e) => plain(StatusCode::INTERNAL_SERVER_ERROR, &format!("the request failed: {e}")),
    }
}

/// Answers a call that is still running on an event stream: a progress notification every
/// [`HEARTBEAT`] while it runs (a comment when the client gave no progress token), then its
/// answer. The call is cancelled as soon as the client goes away.
fn event_stream(mut handled: JoinHandle<Handled>, id: Value, token: Option<Value>, guard: DropGuard) -> Reply {
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(4);
    tokio::spawn(async move {
        let _guard = guard;
        let started = tokio::time::Instant::now();
        let mut beat = tokio::time::interval_at(started + HEARTBEAT, HEARTBEAT);
        loop {
            tokio::select! {
                done = &mut handled => {
                    let reply = match done {
                        Ok(Ok(Some(reply)) | Err(reply)) => reply,
                        Ok(Ok(None)) => return,
                        Err(e) => protocol::error_response(id, -32603, &format!("the request failed: {e}")),
                    };
                    let _ = tx.send(event(&reply)).await;
                    return;
                }
                _ = beat.tick() => {
                    let elapsed = started.elapsed();
                    let still_running = match &token {
                        Some(token) => event(&json!({
                            "jsonrpc": "2.0",
                            "method": "notifications/progress",
                            "params": {
                                "progressToken": token,
                                "progress": elapsed.as_secs_f64(),
                                "message": format!("running for {}s", elapsed.as_secs()),
                            },
                        })),
                        None => Bytes::from_static(b": running\n\n"),
                    };
                    if tx.send(still_running).await.is_err() {
                        return;
                    }
                }
                _ = tx.closed() => return,
            }
        }
    });
    let mut response = Response::new(Either::Right(EventStream(rx)));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

/// One server-sent event carrying a JSON-RPC message.
fn event(message: &Value) -> Bytes {
    Bytes::from(format!("event: message\ndata: {message}\n\n"))
}

/// A `text/event-stream` body, written by [`event_stream`]'s task.
pub(crate) struct EventStream(tokio::sync::mpsc::Receiver<Bytes>);

impl hyper::body::Body for EventStream {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.get_mut().0.poll_recv(cx).map(|data| data.map(|data| Ok(Frame::data(data))))
    }
}

/// No `Origin` other than this server's own, and a loopback `Host`: a web
/// page (DNS rebinding) can't reach the tools even before the token check.
fn local_request(headers: &HeaderMap, port: u16) -> bool {
    let ours = |authority: &str| {
        ["127.0.0.1", "localhost", "[::1]"].iter().any(|host| authority.eq_ignore_ascii_case(&format!("{host}:{port}")))
    };
    let host_ok = headers.get(header::HOST).is_none_or(|h| h.to_str().is_ok_and(ours));
    let origin_ok = headers.get(header::ORIGIN).is_none_or(|o| {
        o.to_str()
            .is_ok_and(|o| o.strip_prefix("http://").is_some_and(|authority| ours(authority.trim_end_matches('/'))))
    });
    host_ok && origin_ok
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let Some(given) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) else { return false };
    let Some((scheme, given)) = given.trim().split_once(' ') else { return false };
    scheme.eq_ignore_ascii_case("bearer") && constant_time_eq(given.trim().as_bytes(), token.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The project the request names: the header (UTF-8), else `?project=` (percent-encoded).
fn project_of(req: &Request<Incoming>) -> Option<String> {
    if let Some(value) = req.headers().get(PROJECT_HEADER) {
        return String::from_utf8(value.as_bytes().to_vec()).ok();
    }
    req.uri().query()?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "project").then(|| {
            let value = value.replace('+', " ");
            percent_encoding::percent_decode_str(&value).decode_utf8_lossy().into_owned()
        })
    })
}

fn plain(status: StatusCode, text: &str) -> Reply {
    let mut response = Response::new(Either::Left(Full::new(Bytes::from(text.to_owned()))));
    *response.status_mut() = status;
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response
}

fn json(status: StatusCode, value: &Value) -> Reply {
    let mut response = Response::new(Either::Left(Full::new(Bytes::from(value.to_string()))));
    *response.status_mut() = status;
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

fn empty(status: StatusCode) -> Reply {
    let mut response = Response::new(Either::Left(Full::new(Bytes::new())));
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// `slow` sleeps `ms` milliseconds; `wait` runs until it is cancelled, which it records.
    struct Slow(Arc<AtomicBool>);

    impl ToolRegistry for Slow {
        fn projects(&self) -> Vec<PathBuf> {
            vec![PathBuf::from("/project")]
        }
        fn tools(&self, _: &Path) -> Result<Vec<crate::Tool>, String> {
            Ok(Vec::new())
        }
        fn call(
            &self,
            _: &Path,
            name: &str,
            arguments: &str,
            cancel: CancellationToken,
        ) -> Result<String, crate::ToolCallError> {
            if name == "wait" {
                while !cancel.is_cancelled() {
                    std::thread::sleep(Duration::from_millis(10));
                }
                self.0.store(true, Ordering::SeqCst);
                return Err(crate::ToolCallError::Failed("cancelled".into()));
            }
            let ms = serde_json::from_str::<Value>(arguments).unwrap()["ms"].as_u64().unwrap();
            std::thread::sleep(Duration::from_millis(ms));
            Ok("done".into())
        }
    }

    fn start() -> (McpServer, Arc<AtomicBool>) {
        let cancelled = Arc::new(AtomicBool::new(false));
        let registry = Arc::new(Slow(cancelled.clone()));
        (McpServer::start(registry, None, &tokio::runtime::Handle::current()).unwrap(), cancelled)
    }

    fn call(name: &str, ms: u64, token: Option<&str>) -> Value {
        let mut params = json!({ "name": name, "arguments": { "ms": ms } });
        if let Some(token) = token {
            params["_meta"] = json!({ "progressToken": token });
        }
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": params })
    }

    async fn send(server: &McpServer, accept: &str, body: &Value) -> tokio::net::TcpStream {
        let body = body.to_string();
        let port = server.port();
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nAccept: {accept}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            server.token(),
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        stream
    }

    /// The whole response, lowercased headers and the body as sent (chunked or not).
    async fn exchange(server: &McpServer, accept: &str, body: &Value) -> (String, String) {
        let mut out = String::new();
        send(server, accept, body).await.read_to_string(&mut out).await.unwrap();
        let (head, body) = out.split_once("\r\n\r\n").unwrap();
        (head.to_ascii_lowercase(), body.to_owned())
    }

    fn events(body: &str) -> Vec<Value> {
        body.lines().filter_map(|l| l.strip_prefix("data: ")).map(|d| serde_json::from_str(d).unwrap()).collect()
    }

    const BOTH: &str = "application/json, text/event-stream";

    #[tokio::test(flavor = "multi_thread")]
    async fn long_calls_are_answered_on_an_event_stream_that_reports_progress() {
        let (server, _) = start();

        let (head, body) = exchange(&server, BOTH, &call("slow", 0, Some("p"))).await;
        assert!(head.contains("content-type: application/json"), "{head}");
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"]["content"][0]["text"], "done");

        let (head, body) = exchange(&server, BOTH, &call("slow", 450, Some("p"))).await;
        assert!(head.contains("content-type: text/event-stream"), "{head}");
        let messages = events(&body);
        let (answer, progress) = messages.split_last().unwrap();
        assert_eq!(answer["id"], 3);
        assert_eq!(answer["result"]["content"][0]["text"], "done");
        assert!(progress.len() >= 2, "{body}");
        for pair in progress.windows(2) {
            assert!(pair[0]["params"]["progress"].as_f64() < pair[1]["params"]["progress"].as_f64(), "{body}");
        }
        for p in progress {
            assert_eq!((&p["method"], &p["params"]["progressToken"]), (&json!("notifications/progress"), &json!("p")));
        }

        // Without a progress token, comments keep the stream going.
        let (_, body) = exchange(&server, BOTH, &call("slow", 300, None)).await;
        assert!(body.contains(": running"), "{body}");
        assert_eq!(events(&body).len(), 1, "{body}");

        // A client that takes only JSON waits for it.
        let (head, body) = exchange(&server, "application/json", &call("slow", 300, Some("p"))).await;
        assert!(head.contains("content-type: application/json"), "{head}");
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["id"], 3);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_streamed_call_is_cancelled_when_the_client_goes_away() {
        let (server, cancelled) = start();
        let mut stream = send(&server, BOTH, &call("wait", 0, Some("p"))).await;
        let mut head = Vec::new();
        while !String::from_utf8_lossy(&head).contains("\r\n\r\n") {
            let mut buf = [0u8; 1024];
            let n = stream.read(&mut buf).await.unwrap();
            assert!(n > 0, "the stream ended early");
            head.extend_from_slice(&buf[..n]);
        }
        assert!(String::from_utf8_lossy(&head).to_ascii_lowercase().contains("text/event-stream"));
        drop(stream);
        tokio::time::timeout(Duration::from_secs(10), async {
            while !cancelled.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the call was cancelled");
    }

    #[test]
    fn only_loopback_hosts_and_origins_of_this_server_pass() {
        let headers = |pairs: &[(header::HeaderName, &str)]| {
            let mut h = HeaderMap::new();
            for (k, v) in pairs {
                h.insert(k.clone(), HeaderValue::from_str(v).unwrap());
            }
            h
        };
        assert!(local_request(&headers(&[]), 80));
        assert!(local_request(&headers(&[(header::HOST, "127.0.0.1:80")]), 80));
        assert!(local_request(
            &headers(&[(header::HOST, "localhost:80"), (header::ORIGIN, "http://localhost:80")]),
            80
        ));
        assert!(!local_request(&headers(&[(header::HOST, "evil.example:80")]), 80));
        assert!(!local_request(&headers(&[(header::HOST, "127.0.0.1:81")]), 80));
        assert!(!local_request(&headers(&[(header::ORIGIN, "https://evil.example")]), 80));
        assert!(!local_request(&headers(&[(header::ORIGIN, "null")]), 80));
    }

    #[test]
    fn bearer_tokens_compare_exactly() {
        let mut h = HeaderMap::new();
        assert!(!authorized(&h, "abc"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer abc"));
        assert!(authorized(&h, "abc"));
        assert!(!authorized(&h, "abcd"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        assert!(!authorized(&h, "abc"));
        assert_eq!(new_token().unwrap().len(), 64);
    }
}
