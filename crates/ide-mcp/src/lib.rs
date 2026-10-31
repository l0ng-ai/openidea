//! The built-in MCP server (Settings › Tools › MCP Server): external AI agents
//! (Claude Code, Codex, Cursor, ...) and the IDE's own agents use the IDE's files,
//! search, code insight, VCS, run configurations and terminal through it.
//!
//! It serves the streamable HTTP transport and the legacy SSE transport ([`http`]) on
//! `127.0.0.1` and needs a bearer token. Tools ([`tools`]) run on the [`ide_host::Host`]
//! against the project a call is for ([`project`]); what only a window can answer
//! (confirmations, open editors) goes through [`McpHost::ask`]; confirmations go to the
//! client as elicitations only when the settings opt in and the client supports them.

pub mod clients;
mod elicitation;
pub mod filter;
pub mod history;
pub mod http;
pub mod markdown;
mod progress;
pub mod project;
pub mod protocol;
mod session;
pub mod skills;
pub mod stdio;
pub mod tool;
pub mod tools;

use futures::future::BoxFuture;
use ide_core::mcp::{McpCallRecord, McpClient, McpSettings, McpStatus, McpToolInfo, McpUiRequest};
use ide_core::{CancellationToken, IdeResult};
use ide_host::Host;
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use session::Session;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tool::Tool;

/// What the server needs from the application around it.
pub trait McpHost: Send + Sync + 'static {
    fn host(&self) -> Arc<Host>;
    /// The focused project window: calls without `projectPath` go to its project.
    fn focused_window(&self) -> Option<String>;
    /// Asks `window`'s UI (a confirmation, the open editors) and waits for its answer.
    fn ask(&self, window: &str, request: McpUiRequest) -> BoxFuture<'static, IdeResult<Value>>;
    /// The server started or stopped, or a client connected.
    fn status_changed(&self, status: &McpStatus);
    /// The application's current log file, for `get_ide_diagnostics`.
    fn log_file(&self) -> Option<PathBuf> {
        None
    }
}

pub(crate) struct Config {
    pub token: String,
    pub brave_mode: bool,
    /// Confirmations may go to the client as elicitations ([`McpSettings::client_confirmations`]).
    pub client_confirmations: bool,
    /// Which tools are offered, and how ([`filter`]).
    pub filter: filter::FilterSettings,
}

/// Sessions kept at most; clients rarely end theirs, so the oldest idle ones go first.
pub(crate) const MAX_SESSIONS: usize = 256;
/// Intervals that tests shorten.
#[derive(Clone, Copy)]
pub(crate) struct Timing {
    /// Progress notifications: at most one per interval, repeated as a keep-alive (JetBrains: 1 s).
    pub progress: Duration,
    /// Heartbeat comments on SSE streams (JetBrains: 5 s).
    pub heartbeat: Duration,
    /// How long the user gets to answer an elicitation (JetBrains: 300 s).
    pub elicitation: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            progress: Duration::from_secs(1),
            heartbeat: Duration::from_secs(5),
            elicitation: Duration::from_secs(300),
        }
    }
}

pub(crate) struct Shared {
    pub ui: Arc<dyn McpHost>,
    pub tools: Vec<Tool>,
    pub config: RwLock<Config>,
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    pub clients: Mutex<Vec<McpClient>>,
    pub timing: RwLock<Timing>,
    /// Running `tools/call`s by session and request id (`notifications/cancelled`).
    pub inflight: Mutex<HashMap<String, CancellationToken>>,
    /// Cancelled when the current listener stops; replaced on each start.
    pub stop: Mutex<CancellationToken>,
    /// The port while listening.
    pub running: Mutex<Option<u16>>,
    /// Why the last start failed.
    pub error: Mutex<Option<String>>,
    /// When a call count was last reported.
    pub status_sent: Mutex<Option<std::time::Instant>>,
    /// The recent tool calls.
    pub history: history::CallHistory,
}

impl Shared {
    /// The tools `tools/list` offers and `tools/call` accepts.
    pub fn enabled_tools(&self) -> Vec<Tool> {
        self.config.read().filter.listed_tools(&self.tools)
    }

    /// The tools `execute_tool` can call.
    pub fn routable_tools(&self) -> Vec<Tool> {
        self.config.read().filter.routable_tools(&self.tools)
    }

    pub fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().get(id).cloned()
    }

    /// Adds a session; `false` when the server holds [`MAX_SESSIONS`] busy ones already.
    pub fn add_session(&self, session: Arc<Session>) -> bool {
        session::insert(&mut self.sessions.lock(), session, MAX_SESSIONS)
    }

    pub fn remove_session(&self, id: &str) -> bool {
        let removed = self.sessions.lock().remove(id);
        removed.map(|s| s.close()).is_some()
    }

    /// Ends every session; their streams close.
    pub fn close_sessions(&self) {
        let sessions: Vec<_> = self.sessions.lock().drain().map(|(_, s)| s).collect();
        for s in sessions {
            s.close();
        }
    }

    /// Tells every session that listed the tools that the list changed.
    pub fn tools_changed(&self) {
        let sessions: Vec<_> = self.sessions.lock().values().cloned().collect();
        for s in sessions.iter().filter(|s| s.advertised_stripped.lock().is_some()) {
            s.notify(None, "notifications/tools/list_changed", serde_json::json!({}));
        }
    }

    pub fn client_seen(&self, client: McpClient) {
        let changed = {
            let mut clients = self.clients.lock();
            match clients.iter().position(|c| c.name == client.name) {
                Some(i) => {
                    let mut existing = clients.remove(i);
                    let changed = existing.version != client.version || i != 0;
                    existing.version = client.version;
                    clients.insert(0, existing);
                    changed
                }
                None => {
                    clients.insert(0, client);
                    true
                }
            }
        };
        if changed {
            self.ui.status_changed(&self.status_snapshot());
        }
    }

    pub fn count_call(&self, client: &str) {
        if let Some(c) = self.clients.lock().iter_mut().find(|c| c.name == client) {
            c.calls += 1;
        }
        // The UI shows the counts; at most one update a second.
        let now = std::time::Instant::now();
        let due = {
            let mut last = self.status_sent.lock();
            let due = last.is_none_or(|t| now.duration_since(t) >= std::time::Duration::from_secs(1));
            if due {
                *last = Some(now);
            }
            due
        };
        if due {
            self.ui.status_changed(&self.status_snapshot());
        }
    }

    fn status_snapshot(&self) -> McpStatus {
        let running = *self.running.lock();
        McpStatus {
            running: running.is_some(),
            url: running.map(endpoint_url),
            port: running,
            error: self.error.lock().clone(),
            clients: self.clients.lock().clone(),
        }
    }
}

/// The endpoint URL for `port`.
pub fn endpoint_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{}", http::ENDPOINT)
}

/// The server: started, stopped and reconfigured by [`McpServer::apply`].
pub struct McpServer {
    shared: Arc<Shared>,
    /// Serializes `apply`; holds the accept loop's task while listening.
    lifecycle: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl McpServer {
    pub fn new(ui: Arc<dyn McpHost>, token: String) -> Self {
        Self::with_tools(ui, token, tools::all())
    }

    pub fn with_tools(ui: Arc<dyn McpHost>, token: String, tools: Vec<Tool>) -> Self {
        Self {
            shared: Arc::new(Shared {
                ui,
                tools,
                config: RwLock::new(Config {
                    token,
                    brave_mode: false,
                    client_confirmations: false,
                    filter: Default::default(),
                }),
                sessions: Mutex::default(),
                clients: Mutex::default(),
                timing: RwLock::default(),
                inflight: Mutex::default(),
                stop: Mutex::new(CancellationToken::new()),
                running: Mutex::default(),
                error: Mutex::default(),
                status_sent: Mutex::default(),
                history: Default::default(),
            }),
            lifecycle: tokio::sync::Mutex::new(None),
        }
    }

    /// Starts, stops or restarts the server for `settings`; returns the new status.
    pub async fn apply(&self, settings: &McpSettings) -> McpStatus {
        let mut task = self.lifecycle.lock().await;
        let tools_changed = {
            let mut config = self.shared.config.write();
            config.brave_mode = settings.brave_mode;
            config.client_confirmations = settings.client_confirmations;
            let before = config.filter.offered(&self.shared.tools);
            config.filter = settings.into();
            config.filter.offered(&self.shared.tools) != before
        };
        if tools_changed {
            self.shared.tools_changed();
        }
        let running = *self.shared.running.lock();
        let before = self.status();
        match (settings.enabled, running) {
            (false, Some(_)) => self.stop_listener(&mut task).await,
            (false, None) => *self.shared.error.lock() = None,
            (true, Some(port)) if port == settings.port => {}
            (true, _) => {
                self.stop_listener(&mut task).await;
                *task = self.start_listener(settings.port).await;
            }
        }
        let status = self.status();
        if status != before {
            self.shared.ui.status_changed(&status);
        }
        status
    }

    async fn start_listener(&self, port: u16) -> Option<tokio::task::JoinHandle<()>> {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                let port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
                let stop = CancellationToken::new();
                *self.shared.stop.lock() = stop.clone();
                *self.shared.running.lock() = Some(port);
                *self.shared.error.lock() = None;
                tracing::info!("MCP server on {}", endpoint_url(port));
                Some(tokio::spawn(http::serve(listener, self.shared.clone(), stop)))
            }
            Err(e) => {
                let message = if e.kind() == std::io::ErrorKind::AddrInUse {
                    format!("Port {port} is in use by another program; choose another port.")
                } else {
                    format!("Cannot listen on 127.0.0.1:{port}: {e}")
                };
                tracing::warn!("MCP server: {message}");
                *self.shared.error.lock() = Some(message);
                None
            }
        }
    }

    /// Stops listening and waits until the port is free again (a restart rebinds it).
    async fn stop_listener(&self, task: &mut Option<tokio::task::JoinHandle<()>>) {
        self.cancel_listener();
        if let Some(task) = task.take() {
            let _ = task.await;
        }
    }

    fn cancel_listener(&self) {
        self.shared.stop.lock().cancel();
        self.shared.close_sessions();
        *self.shared.running.lock() = None;
        *self.shared.error.lock() = None;
    }

    /// Stops serving (application exit).
    pub fn shutdown(&self) {
        self.cancel_listener();
    }

    pub fn status(&self) -> McpStatus {
        self.shared.status_snapshot()
    }

    /// The URL and token to reach the server while it runs.
    pub fn endpoint(&self) -> Option<(String, String)> {
        let port = (*self.shared.running.lock())?;
        Some((endpoint_url(port), self.shared.config.read().token.clone()))
    }

    pub fn token(&self) -> String {
        self.shared.config.read().token.clone()
    }

    /// Replaces the token; sessions of the old one end.
    pub fn set_token(&self, token: String) {
        self.shared.config.write().token = token;
        self.shared.close_sessions();
    }

    /// Every tool, for the settings page.
    pub fn tools(&self, settings: &McpSettings) -> Vec<McpToolInfo> {
        let filter = filter::FilterSettings::from(settings);
        let context = filter.context(&self.shared.tools);
        let listed = filter.listed_tools(&self.shared.tools);
        self.shared
            .tools
            .iter()
            .map(|t| {
                let state = context.state(t.name).unwrap_or_default();
                McpToolInfo {
                    name: t.name.into(),
                    description: t.description.trim().into(),
                    kind: t.kind,
                    enabled: state.enabled || listed.iter().any(|l| l.name == t.name),
                    group: t.group.into(),
                    group_name: filter::group_display_name(t.group),
                    fully_qualified_name: t.fully_qualified_name(),
                    experimental: t.experimental,
                    router_only: state.router_only && t.name != filter::ROUTER_TOOL_NAME,
                }
            })
            .collect()
    }

    /// The tools offered under `settings` (listed or behind the router) as Markdown.
    pub fn tools_markdown(&self, settings: &McpSettings) -> String {
        let filter = filter::FilterSettings::from(settings);
        let mut tools = filter.routable_tools(&self.shared.tools);
        tools
            .extend(filter.listed_tools(&self.shared.tools).into_iter().filter(|t| t.name == filter::ROUTER_TOOL_NAME));
        markdown::generate_markdown(&tools)
    }

    /// The recent tool calls, most recent first.
    pub fn call_history(&self) -> Vec<McpCallRecord> {
        self.shared.history.snapshot()
    }

    /// Handles one HTTP request to the endpoint (tests drive the server without a
    /// socket); an SSE response is read to its end.
    #[doc(hidden)]
    pub async fn handle_for_test(
        &self,
        port: u16,
        method: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> (u16, Vec<(String, String)>, String) {
        let mut r = self.request_for_test(port, method, http::ENDPOINT, headers, body).await;
        let mut text = r.body;
        if let Some(events) = &mut r.events {
            while let Some(event) = events.recv().await {
                text.push_str(&event);
            }
        }
        (r.status, r.headers, text)
    }

    /// Handles one HTTP request to `target` (a path, maybe with a query); the events
    /// of an SSE response arrive on `events` as they are written.
    #[doc(hidden)]
    pub async fn request_for_test(
        &self,
        port: u16,
        method: &str,
        target: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> http::TestResponse {
        http::request_for_test(&self.shared, port, method, target, headers, body).await
    }

    /// Shortens the progress and heartbeat intervals and the elicitation timeout.
    #[doc(hidden)]
    pub fn set_timing_for_test(&self, progress: Duration, heartbeat: Duration, elicitation: Duration) {
        *self.shared.timing.write() = Timing { progress, heartbeat, elicitation };
    }
}

/// Reads the token from `file`, creating a random one (readable by the user only) if missing.
pub fn load_or_create_token(file: &Path) -> std::io::Result<String> {
    if let Ok(text) = std::fs::read_to_string(file) {
        let token = text.trim();
        if token.len() >= 32 {
            return Ok(token.to_owned());
        }
    }
    write_new_token(file)
}

/// A random 64-hex-digit token.
pub fn random_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Writes a fresh random token to `file` and returns it.
pub fn write_new_token(file: &Path) -> std::io::Result<String> {
    let token = random_token();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("tmp");
    // A leftover file would keep its permissions: start from a new one.
    let _ = std::fs::remove_file(&tmp);
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut f = options.open(&tmp)?;
        std::io::Write::write_all(&mut f, token.as_bytes())?;
    }
    std::fs::rename(&tmp, file)?;
    Ok(token)
}
