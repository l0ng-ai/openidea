//! HTTP + WebSocket web server for running OpenIDEA in a browser on a configurable host and port.
//!
//! Serves the built frontend assets alongside a WebSocket RPC endpoint (`api/ws`) backed by the
//! same [`Host`] and [`Dispatcher`] used by remote development. Designed to work directly and
//! behind reverse proxies regardless of whether the proxy strips or preserves its URL prefix.

pub mod commands;

use crate::plugins::remote::{RemotePluginLanguages, SYNC_COMMAND};
use crate::rpc::{self, ChannelSignal, ChannelSink, Dispatcher, ServerInfo};
use crate::{Host, HostConfig};
use bytes::Bytes;
use commands::WebShellState;
use flate2::Compression;
use flate2::write::GzEncoder;
use futures::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use ide_core::{EventSink, IdeError, IdeEvent, IdeResult, RequestId, SharedSink};
use ide_language::LanguageRegistry;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;

/// Keepalive ping interval so reverse proxies do not drop idle WebSocket sessions.
const WS_PING_INTERVAL: Duration = Duration::from_secs(25);
/// Maximum queued outbound frames per WebSocket session to bound server memory under slow clients.
const WS_OUTBOUND_CAPACITY: usize = 2048;
/// Minimum uncompressed asset size (bytes) before applying gzip compression.
const GZIP_MIN_BYTES: usize = 1024;
const AUTH_COOKIE_NAME: &str = "openidea_token";
const WEB_META_TAG: &str = r#"<meta name="openidea-web" content="1">"#;

/// Runtime configuration for `openidea-server --web`.
#[derive(Debug, Clone)]
pub struct WebServerConfig {
    /// Interface address to bind (e.g. `127.0.0.1` or `0.0.0.0`).
    pub host: String,
    /// TCP port to listen on (0 lets the OS assign an ephemeral port).
    pub port: u16,
    /// Optional URL prefix when deployed behind a reverse proxy (e.g. `/ide`).
    pub base_path: Option<String>,
    /// Directory containing the built frontend (`index.html`, `boot.js`, `assets/`).
    pub web_dir: PathBuf,
    /// Optional workspace directory opened automatically on first connect.
    pub project: Option<PathBuf>,
    /// Automatically trust `project` for this process without prompting.
    pub trust_project: bool,
    /// Optional bearer/cookie authentication token; `None` disables authentication.
    pub auth_token: Option<String>,
}

/// Handle to a running web server instance (useful for tests and graceful shutdown).
pub struct RunningWebServer {
    pub addr: SocketAddr,
    shutdown_tx: Option<oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
}

impl RunningWebServer {
    /// Signals the server to stop accepting connections and shuts down its [`Host`].
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        let _ = self.join.await;
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Hello {
        #[serde(default)]
        window: Option<String>,
        #[serde(default)]
        project: Option<String>,
    },
    Invoke {
        id: u64,
        cmd: String,
        #[serde(default)]
        args: Value,
    },
    Ping,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage {
    Ready {
        window: String,
        server: ServerInfo,
    },
    Response {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<IdeError>,
    },
    Channel {
        id: u64,
        data: Value,
    },
    ChannelEnd {
        id: u64,
    },
    Event {
        window: Option<String>,
        event: IdeEvent,
    },
    Pong,
}

type Subscriber = (u64, mpsc::Sender<ServerMessage>);

/// Fans out [`IdeEvent`]s emitted by [`Host`] to active WebSocket connections per window label.
#[derive(Default)]
struct WebEventHub {
    next_id: AtomicU64,
    /// `window_label` -> active connection senders.
    subscribers: RwLock<HashMap<String, Vec<Subscriber>>>,
}

impl WebEventHub {
    fn subscribe(&self, window: &str, tx: mpsc::Sender<ServerMessage>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.subscribers.write().entry(window.to_owned()).or_default().push((id, tx));
        id
    }

    fn unsubscribe(&self, window: &str, conn_id: u64) {
        let mut map = self.subscribers.write();
        if let Some(list) = map.get_mut(window) {
            list.retain(|(id, _)| *id != conn_id);
            if list.is_empty() {
                map.remove(window);
            }
        }
    }

    fn emit(&self, window: Option<&str>, event: IdeEvent) {
        let map = self.subscribers.read();
        match window {
            Some(w) => {
                if let Some(list) = map.get(w) {
                    for (_, tx) in list {
                        let _ = tx.try_send(ServerMessage::Event { window: Some(w.to_owned()), event: event.clone() });
                    }
                }
            }
            None => {
                for (w, list) in map.iter() {
                    for (_, tx) in list {
                        let _ = tx.try_send(ServerMessage::Event { window: Some(w.clone()), event: event.clone() });
                    }
                }
            }
        }
    }

    fn sink_for(self: &Arc<Self>, window: String) -> SharedSink {
        Arc::new(HubSink { hub: self.clone(), window })
    }
}

struct HubSink {
    hub: Arc<WebEventHub>,
    window: String,
}

impl EventSink for HubSink {
    fn emit(&self, event: IdeEvent) {
        self.hub.emit(Some(&self.window), event);
    }
}

struct ServerState {
    host: Arc<Host>,
    dispatcher: Dispatcher,
    shell: Arc<WebShellState>,
    hub: Arc<WebEventHub>,
    web_dir: PathBuf,
    base_path: Option<String>,
    auth_token: Option<String>,
}

/// Starts the web server bound to `config.host:config.port` and returns a handle immediately.
pub async fn start(config: WebServerConfig, base: PathBuf) -> IdeResult<RunningWebServer> {
    let (config_dir, data_dir) = (base.join("config"), base.join("data"));
    for dir in [&config_dir, &data_dir] {
        std::fs::create_dir_all(dir)
            .map_err(|e| IdeError::internal(format!("cannot create {}: {e}", dir.display())))?;
    }
    let web_dir = dunce::canonicalize(&config.web_dir).map_err(|e| {
        IdeError::invalid(format!(
            "web assets directory {} is not readable: {e} (build the frontend with `pnpm build` or pass --web-dir)",
            config.web_dir.display()
        ))
    })?;
    if !web_dir.join("index.html").is_file() {
        return Err(IdeError::invalid(format!(
            "web assets directory {} does not contain index.html (build the frontend with `pnpm build`)",
            web_dir.display()
        )));
    }
    let languages = LanguageRegistry::load(Some(&config_dir.join("languages")))
        .map(Arc::new)
        .map_err(|e| IdeError::internal(format!("language definitions: {e}")))?;
    let plugin_languages = RemotePluginLanguages::new(Some(&data_dir));
    languages.attach_plugins(plugin_languages.store().clone());

    let hub = Arc::new(WebEventHub::default());
    let sink_hub = hub.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: config_dir.clone(),
        local_data_dir: data_dir.clone(),
        data_dir,
        languages,
        syntax: Arc::default(),
        sink_for: Box::new(move |window| sink_hub.sink_for(window.to_owned())),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: true,
    }));
    host.mcp.set_stdio_link(base.join("bin").join("openidea-server"));
    host.mcp_background.serve_none();
    host.mcp.apply(&host);

    if let Some(root) = std::env::var_os(crate::trust::TRUSTED_ROOT_ENV)
        && let Err(e) = host.trust.inherit(Path::new(&root))
    {
        tracing::warn!("cannot trust {}: {e}", root.to_string_lossy());
    }

    let default_project = config.project.as_ref().map(|p| dunce::canonicalize(p).unwrap_or_else(|_| p.clone()));
    if config.trust_project
        && let Some(ref root) = default_project
        && let Err(e) = host.trust.inherit(root)
    {
        tracing::warn!("cannot trust {}: {e}", root.display());
    }

    let shell = Arc::new(WebShellState::new(&config_dir, default_project, config.trust_project));
    let mut dispatcher = Dispatcher::standard();
    dispatcher.add(SYNC_COMMAND, crate::catalogue::TrustClass::Trusted, move |c| {
        let remote = plugin_languages.clone();
        async move {
            let report = remote.sync(c.arg("languages")?);
            c.host.plugin_languages_changed();
            Ok(report)
        }
    });
    commands::register(&mut dispatcher, shell.clone());

    let bind_addr = format!("{}:{}", config.host, config.port);
    let listener =
        TcpListener::bind(&bind_addr).await.map_err(|e| IdeError::internal(format!("cannot bind {bind_addr}: {e}")))?;
    let addr = listener.local_addr().map_err(|e| IdeError::internal(e.to_string()))?;

    let state = Arc::new(ServerState {
        host: host.clone(),
        dispatcher,
        shell,
        hub,
        web_dir,
        base_path: config.base_path.as_deref().and_then(normalize_base_path),
        auth_token: config.auth_token,
    });

    if state.auth_token.is_none() && !addr.ip().is_loopback() {
        tracing::warn!(
            "listening on non-loopback address {} without --token authentication; ensure an authenticating reverse proxy sits in front",
            addr
        );
    }

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let (stream, peer_addr) = match accepted {
                        Ok(pair) => pair,
                        Err(e) => {
                            tracing::warn!("accept failed: {e}");
                            continue;
                        }
                    };
                    let state = state.clone();
                    tokio::spawn(async move {
                        let io = TokioIo::new(stream);
                        let svc = service_fn(move |req| {
                            let state = state.clone();
                            async move { Ok::<_, std::convert::Infallible>(handle_http(req, state).await) }
                        });
                        if let Err(e) = http1::Builder::new().serve_connection(io, svc).with_upgrades().await {
                            tracing::debug!("HTTP connection {peer_addr} ended: {e}");
                        }
                    });
                }
            }
        }
        host.mcp.stop(&host);
        if tokio::time::timeout(Duration::from_secs(10), host.shutdown()).await.is_err() {
            tracing::warn!("language servers did not shut down in time");
        }
    });

    Ok(RunningWebServer { addr, shutdown_tx: Some(shutdown_tx), join })
}

/// Runs the web server until `SIGINT` or `SIGTERM` is received.
pub async fn run(config: WebServerConfig, base: PathBuf) -> i32 {
    let running = match start(config.clone(), base).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("openidea-server --web: {e}");
            return 1;
        }
    };
    let prefix = config
        .base_path
        .as_deref()
        .and_then(normalize_base_path)
        .map(|p| format!("/{p}/"))
        .unwrap_or_else(|| "/".into());
    let display_host =
        if running.addr.ip().is_unspecified() { "localhost".to_owned() } else { running.addr.ip().to_string() };
    tracing::info!(
        "openidea-server {} web mode listening on http://{}{}",
        env!("CARGO_PKG_VERSION"),
        running.addr,
        prefix
    );
    eprintln!("OpenIDEA Web IDE listening on http://{}:{}{}", display_host, running.addr.port(), prefix);
    if let Some(ref token) = config.auth_token {
        eprintln!("Access URL with token: http://{}:{}{}?token={}", display_host, running.addr.port(), prefix, token);
    }

    wait_for_shutdown_signal().await;
    tracing::info!("shutting down openidea-server web mode");
    running.shutdown().await;
    0
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                if let Some(ref mut s) = sigterm {
                    s.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Auto-discovers a built frontend directory (`dist/`) when `--web-dir` is not explicitly given.
pub fn default_web_dir() -> PathBuf {
    if let Some(env_dir) = std::env::var_os("OPENIDEA_WEB_DIR") {
        return PathBuf::from(env_dir);
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        for candidate in [dir.join("dist"), dir.join("../share/openidea/web"), dir.join("../../dist")] {
            if candidate.join("index.html").is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("dist")
}

/// Generates a random 24-byte URL-safe hex authentication token.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 24];
    let _ = getrandom::fill(&mut bytes);
    let mut out = String::with_capacity(48);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn normalize_base_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() { None } else { Some(trimmed.to_owned()) }
}

fn strip_base_path<'a>(path: &'a str, base_path: Option<&str>) -> &'a str {
    let Some(base) = base_path else { return path };
    let without_slash = path.strip_prefix('/').unwrap_or(path);
    if let Some(rest) = without_slash.strip_prefix(base)
        && (rest.is_empty() || rest.starts_with('/'))
    {
        return if rest.is_empty() { "/" } else { rest };
    }
    path
}

fn is_endpoint(path: &str, suffix: &str) -> bool {
    let clean = path.trim_end_matches('/');
    clean == suffix || clean.ends_with(suffix)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    for pair in query?.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return percent_decode(v);
        }
    }
    None
}

fn strip_query_param(query: Option<&str>, drop_key: &str) -> String {
    let Some(q) = query else { return String::new() };
    let kept: Vec<&str> = q
        .split('&')
        .filter(|pair| {
            let k = pair.split_once('=').map(|(k, _)| k).unwrap_or(pair);
            !pair.is_empty() && k != drop_key
        })
        .collect();
    if kept.is_empty() { String::new() } else { format!("?{}", kept.join("&")) }
}

fn cookie_value(req: &Request<Incoming>, name: &str) -> Option<String> {
    for val in req.headers().get_all(header::COOKIE) {
        let Ok(s) = val.to_str() else { continue };
        for part in s.split(';') {
            let Some((k, v)) = part.trim().split_once('=') else { continue };
            if k == name {
                return Some(v.to_owned());
            }
        }
    }
    None
}

fn bearer_token(req: &Request<Incoming>) -> Option<&str> {
    let header = req.headers().get(header::AUTHORIZATION)?.to_str().ok()?;
    header.strip_prefix("Bearer ").or_else(|| header.strip_prefix("bearer "))
}

enum AuthStatus {
    Authorized,
    QueryTokenValid,
    Unauthorized,
}

fn check_auth(req: &Request<Incoming>, expected: Option<&str>) -> AuthStatus {
    let Some(expected) = expected else { return AuthStatus::Authorized };
    if let Some(token) = bearer_token(req)
        && constant_time_eq(token, expected)
    {
        return AuthStatus::Authorized;
    }
    if let Some(cookie) = cookie_value(req, AUTH_COOKIE_NAME)
        && constant_time_eq(&cookie, expected)
    {
        return AuthStatus::Authorized;
    }
    if let Some(qtok) = query_param(req.uri().query(), "token")
        && constant_time_eq(&qtok, expected)
    {
        return AuthStatus::QueryTokenValid;
    }
    AuthStatus::Unauthorized
}

fn auth_cookie_header(token: &str) -> HeaderValue {
    HeaderValue::from_str(&format!("{AUTH_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax"))
        .unwrap_or_else(|_| HeaderValue::from_static(""))
}

fn text_response(status: StatusCode, content_type: &'static str, body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    Response::builder().status(status).header(header::CONTENT_TYPE, content_type).body(Full::new(body.into())).unwrap()
}

fn is_websocket_upgrade(req: &Request<Incoming>) -> bool {
    let has_upgrade = req
        .headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let has_key = req.headers().contains_key(header::SEC_WEBSOCKET_KEY);
    has_upgrade && has_key
}

async fn handle_http(req: Request<Incoming>, state: Arc<ServerState>) -> Response<Full<Bytes>> {
    let raw_path = req.uri().path().to_owned();
    let effective_path = strip_base_path(&raw_path, state.base_path.as_deref()).to_owned();

    // Unauthenticated health endpoint for container liveness / readiness probes.
    if req.method() == Method::GET && is_endpoint(&effective_path, "/api/health") {
        let body = json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": rpc::PROTOCOL_VERSION,
        });
        return text_response(StatusCode::OK, "application/json", body.to_string());
    }

    // Token login POST endpoint when auth is enabled.
    if req.method() == Method::POST && is_endpoint(&effective_path, "/api/auth") {
        return handle_auth_post(req, &state).await;
    }

    // WebSocket RPC upgrade endpoint.
    if is_endpoint(&effective_path, "/api/ws") && is_websocket_upgrade(&req) {
        if matches!(check_auth(&req, state.auth_token.as_deref()), AuthStatus::Unauthorized) {
            return text_response(StatusCode::UNAUTHORIZED, "application/json", r#"{"error":"unauthorized"}"#);
        }
        return handle_ws_upgrade(req, state);
    }

    if req.method() != Method::GET && req.method() != Method::HEAD {
        return text_response(StatusCode::METHOD_NOT_ALLOWED, "text/plain; charset=utf-8", "Method Not Allowed");
    }

    let head_only = req.method() == Method::HEAD;
    let gzip = accepts_gzip(&req);

    // Resolve static assets inside `web_dir` (supporting reverse-proxy subpaths even when rewrite=false).
    if let Some((file_path, rel_path)) = resolve_static_asset(&state.web_dir, &effective_path) {
        if rel_path != "index.html" {
            return serve_static_file(&file_path, &rel_path, head_only, gzip).await;
        }
    } else if looks_like_asset_path(&effective_path) {
        return text_response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "Not Found");
    }

    // Entry HTML page: enforce auth if configured.
    match check_auth(&req, state.auth_token.as_deref()) {
        AuthStatus::Unauthorized => return login_page_response(),
        AuthStatus::QueryTokenValid => {
            if let Some(ref token) = state.auth_token {
                let rest = strip_query_param(req.uri().query(), "token");
                let target =
                    if raw_path.ends_with('/') { format!("{raw_path}{rest}") } else { format!("{raw_path}/{rest}") };
                return Response::builder()
                    .status(StatusCode::FOUND)
                    .header(header::LOCATION, target)
                    .header(header::SET_COOKIE, auth_cookie_header(token))
                    .body(Full::new(Bytes::new()))
                    .unwrap();
            }
        }
        AuthStatus::Authorized => {}
    }

    // Ensure a trailing slash on subpath entry URLs so relative `./boot.js`, `./assets/...`,
    // and `api/ws` resolve beneath the reverse-proxy prefix.
    if !raw_path.ends_with('/') && !raw_path.ends_with("/index.html") {
        let last_segment = raw_path.rsplit('/').next().unwrap_or("");
        if !last_segment.is_empty() {
            let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
            return Response::builder()
                .status(StatusCode::TEMPORARY_REDIRECT)
                .header(header::LOCATION, format!("{last_segment}/{query}"))
                .body(Full::new(Bytes::new()))
                .unwrap();
        }
    }

    serve_index_html(&state.web_dir, head_only, gzip).await
}

async fn handle_auth_post(req: Request<Incoming>, state: &ServerState) -> Response<Full<Bytes>> {
    let Some(expected) = state.auth_token.as_deref() else {
        return text_response(StatusCode::OK, "application/json", r#"{"ok":true}"#);
    };
    let body = match req.into_body().collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return text_response(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", "Bad Request"),
    };
    let supplied = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("token").and_then(Value::as_str).map(str::to_owned))
        .or_else(|| {
            let text = std::str::from_utf8(&body).ok()?;
            query_param(Some(text), "token")
        });
    if let Some(token) = supplied
        && constant_time_eq(&token, expected)
    {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::SET_COOKIE, auth_cookie_header(expected))
            .body(Full::new(Bytes::from_static(br#"{"ok":true}"#)))
            .unwrap();
    }
    text_response(StatusCode::UNAUTHORIZED, "application/json", r#"{"error":"invalid token"}"#)
}

fn login_page_response() -> Response<Full<Bytes>> {
    const HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>OpenIDEA — Sign In</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #1e1f22; color: #dfe1e5; display: grid; place-items: center; min-height: 100vh; }
  form { background: #2b2d30; border: 1px solid #393b40; border-radius: 8px; padding: 24px; width: min(360px, 90vw); display: flex; flex-direction: column; gap: 12px; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; }
  p { margin: 0; font-size: 13px; color: #9da0a8; }
  input { background: #1e1f22; border: 1px solid #4e5157; border-radius: 4px; color: #dfe1e5; padding: 8px 10px; font-size: 13px; }
  button { background: #3574f0; border: none; border-radius: 4px; color: #fff; padding: 8px 12px; font-size: 13px; font-weight: 500; cursor: pointer; }
  #err { color: #f75464; font-size: 12px; min-height: 16px; }
</style>
</head>
<body>
<form id="f">
  <h1>OpenIDEA Web</h1>
  <p>Enter the server access token to continue.</p>
  <input id="t" name="token" type="password" placeholder="Access token" autocomplete="current-password" autofocus required />
  <button type="submit">Connect</button>
  <div id="err" role="alert"></div>
</form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = document.getElementById("t").value.trim();
  const res = await fetch(new URL("api/auth", location.href), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (res.ok) location.reload();
  else document.getElementById("err").textContent = "Invalid token";
});
</script>
</body>
</html>"#;
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Full::new(Bytes::from_static(HTML.as_bytes())))
        .unwrap()
}

fn handle_ws_upgrade(req: Request<Incoming>, state: Arc<ServerState>) -> Response<Full<Bytes>> {
    let Some(key) = req.headers().get(header::SEC_WEBSOCKET_KEY).and_then(|v| v.to_str().ok()).map(str::to_owned)
    else {
        return text_response(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", "Missing Sec-WebSocket-Key");
    };
    let accept = derive_accept_key(key.as_bytes());
    tokio::spawn(async move {
        match hyper::upgrade::on(req).await {
            Ok(upgraded) => {
                let ws = WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, None).await;
                serve_ws_session(ws, state).await;
            }
            Err(e) => tracing::warn!("WebSocket upgrade failed: {e}"),
        }
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(header::SEC_WEBSOCKET_ACCEPT, accept)
        .body(Full::new(Bytes::new()))
        .unwrap()
}

fn collect_arg_channels(val: &Value, out: &mut Vec<u64>) {
    match val {
        Value::Object(map) => {
            if map.len() == 1
                && let Some(id) = map.get("$channel").and_then(Value::as_u64)
            {
                out.push(id);
                return;
            }
            for v in map.values() {
                collect_arg_channels(v, out);
            }
        }
        Value::Array(items) => {
            for v in items {
                collect_arg_channels(v, out);
            }
        }
        _ => {}
    }
}

fn send_channel_end(tx: &mpsc::Sender<ServerMessage>, id: u64) {
    if let Err(mpsc::error::TrySendError::Full(msg)) = tx.try_send(ServerMessage::ChannelEnd { id }) {
        let tx = tx.clone();
        tokio::spawn(async move {
            let _ = tx.send(msg).await;
        });
    }
}

async fn serve_ws_session<S>(ws: WebSocketStream<S>, state: Arc<ServerState>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (out_tx, mut out_rx) = mpsc::channel::<ServerMessage>(WS_OUTBOUND_CAPACITY);
    let active_requests: Arc<Mutex<HashSet<RequestId>>> = Arc::new(Mutex::new(HashSet::new()));

    // Writer task forwards queued server messages and emits periodic keepalive pings.
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(WS_PING_INTERVAL);
        ping.tick().await;
        loop {
            tokio::select! {
                msg = out_rx.recv() => {
                    let Some(msg) = msg else { break };
                    match serde_json::to_string(&msg) {
                        Ok(text) => {
                            if ws_tx.send(WsMessage::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => tracing::warn!("failed to serialize WebSocket message: {e}"),
                    }
                }
                _ = ping.tick() => {
                    if ws_tx.send(WsMessage::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut window_label: Option<String> = None;
    let mut sub_id: Option<u64> = None;

    while let Some(frame) = ws_rx.next().await {
        let msg = match frame {
            Ok(WsMessage::Text(text)) => text,
            Ok(WsMessage::Ping(_)) | Ok(WsMessage::Pong(_)) => continue,
            Ok(WsMessage::Close(_)) => break,
            Ok(WsMessage::Binary(_)) | Ok(WsMessage::Frame(_)) => continue,
            Err(e) => {
                tracing::debug!("WebSocket read error: {e}");
                break;
            }
        };

        let parsed: ClientMessage = match serde_json::from_str(&msg) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("invalid WebSocket client message: {e}");
                continue;
            }
        };

        match parsed {
            ClientMessage::Ping => {
                let _ = out_tx.try_send(ServerMessage::Pong);
            }
            ClientMessage::Hello { window, project } => {
                if let (Some(old_w), Some(old_id)) = (window_label.take(), sub_id.take()) {
                    state.hub.unsubscribe(&old_w, old_id);
                }
                let label = sanitize_window_label(window.as_deref());
                let id = state.hub.subscribe(&label, out_tx.clone());
                let requested = project.filter(|p| !p.trim().is_empty()).map(PathBuf::from);
                state.shell.seed_launch(&state.host, &label, requested);
                window_label = Some(label.clone());
                sub_id = Some(id);
                if out_tx.send(ServerMessage::Ready { window: label, server: rpc::server_info() }).await.is_err() {
                    break;
                }
            }
            ClientMessage::Invoke { id, cmd, args } => {
                let window = match &window_label {
                    Some(w) => w.clone(),
                    None => {
                        let label = "main".to_owned();
                        let sid = state.hub.subscribe(&label, out_tx.clone());
                        state.shell.seed_launch(&state.host, &label, None);
                        window_label = Some(label.clone());
                        sub_id = Some(sid);
                        label
                    }
                };
                let mut arg_channels = Vec::new();
                collect_arg_channels(&args, &mut arg_channels);
                let req_id = args.get("request").and_then(|v| serde_json::from_value::<RequestId>(v.clone()).ok());
                if let Some(req) = req_id {
                    active_requests.lock().insert(req);
                }
                let state = state.clone();
                let tx = out_tx.clone();
                let active_requests = active_requests.clone();
                tokio::spawn(async move {
                    let opened_channels: Arc<Mutex<HashSet<u64>>> = Arc::new(Mutex::new(HashSet::new()));
                    let ch_tx = tx.clone();
                    let opened_for_sink = opened_channels.clone();
                    let channel_sink: ChannelSink = Arc::new(move |signal: ChannelSignal| match signal {
                        ChannelSignal::Opened(cid) => {
                            opened_for_sink.lock().insert(cid);
                        }
                        ChannelSignal::Data(msg) => {
                            let _ = ch_tx.try_send(ServerMessage::Channel { id: msg.id, data: msg.data });
                        }
                        ChannelSignal::End(cid) => {
                            send_channel_end(&ch_tx, cid);
                        }
                    });
                    let reply =
                        match state.dispatcher.invoke(state.host.clone(), window, &cmd, args, channel_sink).await {
                            Ok(data) => ServerMessage::Response { id, ok: true, data: Some(data), error: None },
                            Err(error) => ServerMessage::Response { id, ok: false, data: None, error: Some(error) },
                        };
                    if let Some(req) = req_id {
                        active_requests.lock().remove(&req);
                    }
                    // Close any channel arguments the command never claimed (e.g. validation or trust error).
                    if !arg_channels.is_empty() {
                        let opened = opened_channels.lock();
                        for cid in arg_channels {
                            if !opened.contains(&cid) {
                                send_channel_end(&tx, cid);
                            }
                        }
                    }
                    let _ = tx.send(reply).await;
                });
            }
        }
    }

    // Cancel any cancellable requests still running for this disconnected session.
    let pending_reqs: Vec<RequestId> = active_requests.lock().drain().collect();
    for req in pending_reqs {
        state.host.cancel_request(req);
    }

    if let (Some(w), Some(id)) = (window_label, sub_id) {
        state.hub.unsubscribe(&w, id);
    }
    drop(out_tx);
    let _ = writer.await;
}

fn sanitize_window_label(raw: Option<&str>) -> String {
    let Some(s) = raw else { return "main".into() };
    let clean: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    if clean.is_empty() { "main".into() } else { clean }
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_val(bytes[i + 1])?;
            let lo = hex_val(bytes[i + 2])?;
            let byte = (hi << 4) | lo;
            if byte == 0 {
                return None;
            }
            out.push(byte);
            i += 3;
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Resolves a static asset inside `web_dir`.
///
/// First attempts a direct match, then progressively strips leading path segments so that
/// reverse proxies forwarding unstripped prefixes (`rewrite: false`) still resolve `./boot.js`,
/// `./splash.css`, and `./assets/*` cleanly without allowing directory traversal outside `web_dir`.
fn resolve_static_asset(web_dir: &Path, request_path: &str) -> Option<(PathBuf, String)> {
    let decoded = percent_decode(request_path)?;
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.ends_with('/') {
        return None;
    }
    let segments: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if segments.iter().any(|s| *s == "." || *s == ".." || s.contains('\\')) {
        return None;
    }
    for start in 0..segments.len() {
        let rel = segments[start..].join("/");
        let mut candidate = web_dir.to_path_buf();
        for seg in &segments[start..] {
            candidate.push(seg);
        }
        // Only accept clean normal components that canonicalize inside `web_dir`.
        if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
            continue;
        }
        if let Ok(canon) = dunce::canonicalize(&candidate)
            && canon.starts_with(web_dir)
            && canon.is_file()
        {
            return Some((canon, rel));
        }
    }
    None
}

fn looks_like_asset_path(path: &str) -> bool {
    let last = path.rsplit('/').next().unwrap_or("");
    let Some((_, ext)) = last.rsplit_once('.') else { return false };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "js" | "mjs"
            | "css"
            | "map"
            | "svg"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "wasm"
            | "json"
            | "txt"
    )
}

fn content_type_for(rel: &str) -> &'static str {
    let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn accepts_gzip(req: &Request<Incoming>) -> bool {
    req.headers().get_all(header::ACCEPT_ENCODING).iter().filter_map(|v| v.to_str().ok()).any(|s| {
        s.split(',').any(|part| part.split(';').next().is_some_and(|enc| enc.trim().eq_ignore_ascii_case("gzip")))
    })
}

fn is_compressible(rel: &str) -> bool {
    let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "html" | "htm" | "js" | "mjs" | "css" | "json" | "map" | "svg" | "wasm" | "txt")
}

fn gzip_bytes(input: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::with_capacity(input.len() / 3), Compression::fast());
    encoder.write_all(input).ok()?;
    let compressed = encoder.finish().ok()?;
    (compressed.len() < input.len()).then_some(compressed)
}

async fn serve_static_file(path: &Path, rel: &str, head_only: bool, gzip: bool) -> Response<Full<Bytes>> {
    let cache = if rel.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    let compressible = is_compressible(rel);
    if head_only {
        let Ok(meta) = tokio::fs::metadata(path).await else {
            return text_response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "Not Found");
        };
        let mut builder = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type_for(rel))
            .header(header::CONTENT_LENGTH, meta.len().to_string())
            .header(header::CACHE_CONTROL, cache);
        if compressible {
            builder = builder.header(header::VARY, "Accept-Encoding");
        }
        return builder.body(Full::new(Bytes::new())).unwrap();
    }
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(_) => return text_response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "Not Found"),
    };
    let (payload, encoded_gzip) = if gzip && compressible && bytes.len() >= GZIP_MIN_BYTES {
        match gzip_bytes(&bytes) {
            Some(compressed) => (compressed, true),
            None => (bytes, false),
        }
    } else {
        (bytes, false)
    };
    let len = payload.len();
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type_for(rel))
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::CACHE_CONTROL, cache);
    if compressible {
        builder = builder.header(header::VARY, "Accept-Encoding");
    }
    if encoded_gzip {
        builder = builder.header(header::CONTENT_ENCODING, "gzip");
    }
    builder.body(Full::new(Bytes::from(payload))).unwrap()
}

fn inject_web_meta(html: &str) -> String {
    if html.contains(r#"name="openidea-web""#) {
        return html.to_owned();
    }
    if let Some(pos) = html.find("</head>") {
        let mut out = String::with_capacity(html.len() + WEB_META_TAG.len() + 6);
        out.push_str(&html[..pos]);
        out.push_str("    ");
        out.push_str(WEB_META_TAG);
        out.push('\n');
        out.push_str(&html[pos..]);
        out
    } else {
        format!("{WEB_META_TAG}\n{html}")
    }
}

async fn serve_index_html(web_dir: &Path, head_only: bool, gzip: bool) -> Response<Full<Bytes>> {
    let raw = match tokio::fs::read_to_string(web_dir.join("index.html")).await {
        Ok(s) => s,
        Err(_) => return text_response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "index.html not found"),
    };
    let html = inject_web_meta(&raw);
    let (payload, encoded_gzip) = if !head_only && gzip && html.len() >= GZIP_MIN_BYTES {
        match gzip_bytes(html.as_bytes()) {
            Some(compressed) => (Bytes::from(compressed), true),
            None => (Bytes::from(html), false),
        }
    } else {
        (Bytes::from(html), false)
    };
    let len = payload.len();
    let body = if head_only { Bytes::new() } else { payload };
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::VARY, "Accept-Encoding");
    if encoded_gzip {
        builder = builder.header(header::CONTENT_ENCODING, "gzip");
    }
    builder.body(Full::new(body)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_direct_and_reverse_proxy_prefixed_assets_safely() {
        let dir = tempfile::tempdir().unwrap();
        let web_dir = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(web_dir.join("assets")).unwrap();
        std::fs::write(web_dir.join("boot.js"), "console.log('boot');").unwrap();
        std::fs::write(web_dir.join("assets/app.js"), "export {};").unwrap();

        let (_, rel) = resolve_static_asset(&web_dir, "/boot.js").unwrap();
        assert_eq!(rel, "boot.js");

        // Unstripped reverse-proxy prefix (rewrite: false).
        let (_, rel) = resolve_static_asset(&web_dir, "/user/proj/r/session/abc/assets/app.js").unwrap();
        assert_eq!(rel, "assets/app.js");

        let (_, rel) = resolve_static_asset(&web_dir, "/proxy/prefix/boot.js").unwrap();
        assert_eq!(rel, "boot.js");

        // Directory traversal is rejected.
        assert!(resolve_static_asset(&web_dir, "/../etc/passwd").is_none());
        assert!(resolve_static_asset(&web_dir, "/prefix/%2e%2e/secret").is_none());
    }

    #[test]
    fn injects_web_meta_tag_into_head() {
        let html = "<!doctype html><html><head><title>OpenIDEA</title></head><body></body></html>";
        let injected = inject_web_meta(html);
        assert!(injected.contains(WEB_META_TAG));
        assert!(injected.find(WEB_META_TAG).unwrap() < injected.find("</head>").unwrap());
        // Idempotent.
        assert_eq!(inject_web_meta(&injected), injected);
    }

    #[test]
    fn strips_configured_base_path() {
        assert_eq!(strip_base_path("/ide/api/health", Some("ide")), "/api/health");
        assert_eq!(strip_base_path("/ide", Some("ide")), "/");
        assert_eq!(strip_base_path("/other/path", Some("ide")), "/other/path");
    }

    async fn http_get(
        addr: SocketAddr,
        path: &str,
        extra_headers: &[(&str, &str)],
    ) -> (u16, HashMap<String, String>, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
        for (k, v) in extra_headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        let text = String::from_utf8(buf).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let mut lines = head.split("\r\n");
        let status: u16 = lines.next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
        let mut headers = HashMap::new();
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
            }
        }
        (status, headers, body.to_owned())
    }

    #[tokio::test]
    async fn end_to_end_http_and_websocket_rpc() {
        let tmp = tempfile::tempdir().unwrap();
        let web_dir = tmp.path().join("dist");
        let home_dir = tmp.path().join("home");
        let project_dir = tmp.path().join("sample-project");
        std::fs::create_dir_all(web_dir.join("assets")).unwrap();
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(web_dir.join("index.html"), "<!doctype html><html><head></head><body>ok</body></html>").unwrap();
        std::fs::write(web_dir.join("boot.js"), "window.__BOOT=1;").unwrap();
        std::fs::write(project_dir.join("hello.txt"), "hello web ide\n").unwrap();

        let server = start(
            WebServerConfig {
                host: "127.0.0.1".into(),
                port: 0,
                base_path: None,
                web_dir,
                project: Some(project_dir.clone()),
                trust_project: true,
                auth_token: None,
            },
            home_dir,
        )
        .await
        .expect("start web server");

        // 1. Health check works at root and under arbitrary reverse-proxy prefix.
        let (status, _, health_txt) = http_get(server.addr, "/api/health", &[]).await;
        assert_eq!(status, 200);
        let health: Value = serde_json::from_str(&health_txt).unwrap();
        assert_eq!(health["status"], "ok");

        let (status, _, health2_txt) = http_get(server.addr, "/u/proj/session/42/api/health", &[]).await;
        assert_eq!(status, 200);
        let health2: Value = serde_json::from_str(&health2_txt).unwrap();
        assert_eq!(health2["status"], "ok");

        // 2. Entry HTML injects web meta tag; proxy subpath without trailing slash redirects cleanly.
        let (status, headers, _) = http_get(server.addr, "/u/proj/session/42", &[]).await;
        assert_eq!(status, 307);
        assert_eq!(headers.get("location").map(String::as_str), Some("42/"));

        let (status, _, html) = http_get(server.addr, "/u/proj/session/42/", &[]).await;
        assert_eq!(status, 200);
        assert!(html.contains(WEB_META_TAG));

        // 3. Static asset works under unstripped reverse-proxy prefix.
        let (status, _, js) = http_get(server.addr, "/u/proj/session/42/boot.js", &[]).await;
        assert_eq!(status, 200);
        assert_eq!(js, "window.__BOOT=1;");

        // 4. WebSocket RPC works under unstripped reverse-proxy prefix.
        let ws_url = format!("ws://{}/u/proj/session/42/api/ws", server.addr);
        let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await.expect("ws connect");
        ws.send(WsMessage::Text(json!({ "type": "hello", "window": "main" }).to_string().into())).await.unwrap();
        let ready_txt = ws.next().await.unwrap().unwrap().into_text().unwrap();
        let ready: Value = serde_json::from_str(&ready_txt).unwrap();
        assert_eq!(ready["type"], "ready");
        assert_eq!(ready["window"], "main");

        // `window_take_launch` returns the configured `--project` directory once.
        ws.send(WsMessage::Text(
            json!({ "type": "invoke", "id": 1, "cmd": "window_take_launch", "args": {} }).to_string().into(),
        ))
        .await
        .unwrap();
        let launch_reply: Value =
            serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(launch_reply["ok"], true);
        let launch_project = launch_reply["data"]["project"].as_str().unwrap().to_owned();

        // `open_project` opens the project and `fs_read_file` reads a file from it.
        ws.send(WsMessage::Text(
            json!({ "type": "invoke", "id": 2, "cmd": "open_project", "args": { "path": launch_project } })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        let open_reply = loop {
            let msg: Value = serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
            if msg["type"] == "response" && msg["id"] == 2 {
                break msg;
            }
        };
        assert_eq!(open_reply["ok"], true);
        assert_eq!(open_reply["data"]["trusted"], true);

        let file_path = project_dir.join("hello.txt");
        ws.send(WsMessage::Text(
            json!({ "type": "invoke", "id": 3, "cmd": "fs_read_text", "args": { "path": file_path } })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        let read_reply = loop {
            let msg: Value = serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
            if msg["type"] == "response" && msg["id"] == 3 {
                break msg;
            }
        };
        assert_eq!(read_reply["ok"], true, "read_reply={read_reply}");
        assert_eq!(read_reply["data"], "hello web ide\n");

        ws.close(None).await.ok();
        server.shutdown().await;
    }

    #[tokio::test]
    async fn token_authentication_guards_page_and_websocket() {
        let tmp = tempfile::tempdir().unwrap();
        let web_dir = tmp.path().join("dist");
        let home_dir = tmp.path().join("home");
        std::fs::create_dir_all(&web_dir).unwrap();
        std::fs::write(web_dir.join("index.html"), "<!doctype html><html><head></head><body>ok</body></html>").unwrap();

        let server = start(
            WebServerConfig {
                host: "127.0.0.1".into(),
                port: 0,
                base_path: None,
                web_dir,
                project: None,
                trust_project: true,
                auth_token: Some("secret-token-123".into()),
            },
            home_dir,
        )
        .await
        .unwrap();

        // Health stays open for readiness probes.
        let (status, _, _) = http_get(server.addr, "/api/health", &[]).await;
        assert_eq!(status, 200);
        // Unauthenticated entry returns 401 login page.
        let (status, _, _) = http_get(server.addr, "/", &[]).await;
        assert_eq!(status, 401);
        // Valid query token sets cookie and redirects cleanly without token in URL.
        let (status, headers, _) = http_get(server.addr, "/?token=secret-token-123", &[]).await;
        assert_eq!(status, 302);
        assert_eq!(headers.get("location").map(String::as_str), Some("/"));
        assert!(headers.get("set-cookie").unwrap().contains("openidea_token=secret-token-123"));

        // Bearer token authorizes entry HTML.
        let (status, _, html) = http_get(server.addr, "/", &[("Authorization", "Bearer secret-token-123")]).await;
        assert_eq!(status, 200);
        assert!(html.contains(WEB_META_TAG));

        server.shutdown().await;
    }

    #[tokio::test]
    async fn compresses_large_js_assets_with_gzip() {
        use flate2::read::GzDecoder;
        use std::io::Read as _;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let tmp = tempfile::tempdir().unwrap();
        let web_dir = tmp.path().join("dist");
        let home_dir = tmp.path().join("home");
        std::fs::create_dir_all(web_dir.join("assets")).unwrap();
        std::fs::write(web_dir.join("index.html"), "<!doctype html><html><head></head><body>ok</body></html>").unwrap();
        let original = "export const message = 'hello openidea web';\n".repeat(120);
        std::fs::write(web_dir.join("assets/bundle.js"), &original).unwrap();

        let server = start(
            WebServerConfig {
                host: "127.0.0.1".into(),
                port: 0,
                base_path: None,
                web_dir,
                project: None,
                trust_project: true,
                auth_token: None,
            },
            home_dir,
        )
        .await
        .unwrap();

        let mut stream = tokio::net::TcpStream::connect(server.addr).await.unwrap();
        let req = format!(
            "GET /assets/bundle.js HTTP/1.1\r\nHost: {}\r\nAccept-Encoding: gzip, deflate\r\nConnection: close\r\n\r\n",
            server.addr
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        let sep = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = std::str::from_utf8(&buf[..sep]).unwrap();
        let body = &buf[sep + 4..];
        assert!(head.contains("content-encoding: gzip"), "head={head}");
        assert!(body.len() < original.len() / 5, "expected strong gzip compression");

        let mut decoder = GzDecoder::new(body);
        let mut decoded = String::new();
        decoder.read_to_string(&mut decoded).unwrap();
        assert_eq!(decoded, original);

        server.shutdown().await;
    }

    #[tokio::test]
    async fn emits_channel_end_on_streaming_command_completion_and_error() {
        let tmp = tempfile::tempdir().unwrap();
        let web_dir = tmp.path().join("dist");
        let home_dir = tmp.path().join("home");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&web_dir).unwrap();
        std::fs::create_dir_all(&proj_dir).unwrap();
        std::fs::write(web_dir.join("index.html"), "<!doctype html><html><head></head><body>ok</body></html>").unwrap();

        let server = start(
            WebServerConfig {
                host: "127.0.0.1".into(),
                port: 0,
                base_path: None,
                web_dir,
                project: Some(proj_dir),
                trust_project: true,
                auth_token: None,
            },
            home_dir,
        )
        .await
        .unwrap();

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/api/ws", server.addr)).await.unwrap();
        ws.send(WsMessage::Text(json!({ "type": "hello", "window": "main" }).to_string().into())).await.unwrap();
        let _ready = ws.next().await.unwrap().unwrap();

        // Command that fails before claiming its channel must still close the channel on the client.
        ws.send(WsMessage::Text(
            json!({
                "type": "invoke",
                "id": 10,
                "cmd": "nonexistent_streaming_cmd",
                "args": { "onEvent": { "$channel": 77 } }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let mut saw_end = false;
        let mut saw_reply = false;
        while !saw_end || !saw_reply {
            let msg: Value = serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
            if msg["type"] == "channelEnd" && msg["id"] == 77 {
                saw_end = true;
            } else if msg["type"] == "response" && msg["id"] == 10 {
                saw_reply = true;
            }
        }
        assert!(saw_end && saw_reply);

        ws.close(None).await.ok();
        server.shutdown().await;
    }
}
