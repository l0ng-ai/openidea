//! The HTTP side: one endpoint, `/mcp`, on the loopback interface.

use crate::discovery::Discovery;
use crate::{PROJECT_HEADER, ToolRegistry, protocol};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::watch;

/// Largest request body.
const MAX_BODY: usize = 8 << 20;

struct Shared {
    registry: Arc<dyn ToolRegistry>,
    token: String,
    port: u16,
}

/// The running server. Stopping it (or dropping it) closes the port and
/// removes its discovery file.
pub struct McpServer {
    port: u16,
    token: String,
    discovery: Option<PathBuf>,
    shutdown: watch::Sender<bool>,
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
        let shared = Arc::new(Shared { registry, token: token.clone(), port });
        runtime.spawn(accept(listener, shared, stopped));
        tracing::info!("MCP server on 127.0.0.1:{port}");
        Ok(Self { port, token, discovery, shutdown })
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
        let _ = self.shutdown.send(true);
        if let Some(path) = &self.discovery {
            Discovery::remove_if_ours(path);
        }
    }
}

fn new_token() -> std::io::Result<String> {
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
            let service = hyper::service::service_fn(move |req| serve(req, shared.clone()));
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

async fn serve(req: Request<Incoming>, shared: Arc<Shared>) -> Result<Response<Full<Bytes>>, Infallible> {
    Ok(match respond(req, &shared).await {
        Ok(response) | Err(response) => response,
    })
}

type Reply = Result<Response<Full<Bytes>>, Response<Full<Bytes>>>;

async fn respond(req: Request<Incoming>, shared: &Arc<Shared>) -> Reply {
    if req.uri().path() != "/mcp" {
        return Err(plain(StatusCode::NOT_FOUND, "not found: the endpoint is /mcp"));
    }
    if !local_request(req.headers(), shared.port) {
        return Err(plain(StatusCode::FORBIDDEN, "requests from web pages are refused"));
    }
    if !authorized(req.headers(), &shared.token) {
        let mut response = plain(StatusCode::UNAUTHORIZED, "missing or wrong bearer token");
        response.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        return Err(response);
    }
    if req.method() != Method::POST {
        // No server-sent event streams: every answer is in the POST's response.
        let mut response = plain(StatusCode::METHOD_NOT_ALLOWED, "only POST");
        response.headers_mut().insert(header::ALLOW, HeaderValue::from_static("POST"));
        return Err(response);
    }
    if let Some(version) = req.headers().get("mcp-protocol-version")
        && !version.to_str().is_ok_and(|v| protocol::SUPPORTED.contains(&v))
    {
        return Err(plain(StatusCode::BAD_REQUEST, "unsupported MCP-Protocol-Version"));
    }
    let project = project_of(&req);
    let body = match Limited::new(req.into_body(), MAX_BODY).collect().await {
        Ok(body) => body.to_bytes(),
        Err(e) => return Err(plain(StatusCode::PAYLOAD_TOO_LARGE, &format!("request body: {e}"))),
    };
    let registry = shared.registry.clone();
    let handled =
        tokio::task::spawn_blocking(move || protocol::handle_body(registry.as_ref(), project.as_deref(), &body)).await;
    match handled {
        Ok(Ok(Some(reply))) => Ok(json(StatusCode::OK, &reply)),
        Ok(Ok(None)) => Ok(empty(StatusCode::ACCEPTED)),
        Ok(Err(parse_error)) => Err(json(StatusCode::BAD_REQUEST, &parse_error)),
        Err(e) => Err(plain(StatusCode::INTERNAL_SERVER_ERROR, &format!("the request failed: {e}"))),
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

fn plain(status: StatusCode, text: &str) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(text.to_owned())));
    *response.status_mut() = status;
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response
}

fn json(status: StatusCode, value: &serde_json::Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())));
    *response.status_mut() = status;
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

fn empty(status: StatusCode) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

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
