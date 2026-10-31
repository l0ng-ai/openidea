//! The built-in MCP server (Settings › Tools › MCP Server): external AI agents
//! (Claude Code, Codex, Cursor, ...) and the IDE's own agents use the IDE's files,
//! search, code insight, VCS, run configurations and terminal through it.
//!
//! It serves the streamable HTTP transport ([`http`]) on `127.0.0.1` and needs a
//! bearer token. Tools ([`tools`]) run on the [`ide_host::Host`] against the
//! project a call names with `projectPath`; what only a window can answer
//! (confirmations, open editors) goes through [`McpHost::ask`].

pub mod clients;
pub mod http;
pub mod project;
pub mod protocol;
pub mod tool;
pub mod tools;

use futures::future::BoxFuture;
use ide_core::mcp::{McpClient, McpSettings, McpStatus, McpToolInfo, McpUiRequest};
use ide_core::{CancellationToken, IdeResult};
use ide_host::Host;
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
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
}

pub(crate) struct Config {
    pub token: String,
    pub brave_mode: bool,
    pub disabled: HashSet<String>,
}

pub(crate) struct Session {
    pub client: String,
}

pub(crate) struct Shared {
    pub ui: Arc<dyn McpHost>,
    pub tools: Vec<Tool>,
    pub config: RwLock<Config>,
    pub sessions: Mutex<HashMap<String, Session>>,
    pub clients: Mutex<Vec<McpClient>>,
    /// Running `tools/call`s by session and request id (`notifications/cancelled`).
    pub inflight: Mutex<HashMap<String, CancellationToken>>,
    /// Cancelled when the current listener stops; replaced on each start.
    pub stop: Mutex<CancellationToken>,
    /// The port while listening.
    pub running: Mutex<Option<u16>>,
    /// Why the last start failed.
    pub error: Mutex<Option<String>>,
}

impl Shared {
    pub fn enabled_tools(&self) -> Vec<Tool> {
        let config = self.config.read();
        self.tools.iter().filter(|t| !config.disabled.contains(t.name)).cloned().collect()
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
    /// Serializes `apply`.
    lifecycle: tokio::sync::Mutex<()>,
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
                config: RwLock::new(Config { token, brave_mode: false, disabled: HashSet::new() }),
                sessions: Mutex::default(),
                clients: Mutex::default(),
                inflight: Mutex::default(),
                stop: Mutex::new(CancellationToken::new()),
                running: Mutex::default(),
                error: Mutex::default(),
            }),
            lifecycle: tokio::sync::Mutex::new(()),
        }
    }

    /// Starts, stops or restarts the server for `settings`; returns the new status.
    pub async fn apply(&self, settings: &McpSettings) -> McpStatus {
        let _guard = self.lifecycle.lock().await;
        {
            let mut config = self.shared.config.write();
            config.brave_mode = settings.brave_mode;
            config.disabled = settings.disabled_tools.iter().cloned().collect();
        }
        let running = *self.shared.running.lock();
        let before = self.status();
        match (settings.enabled, running) {
            (false, Some(_)) => self.stop_listener(),
            (false, None) => *self.shared.error.lock() = None,
            (true, Some(port)) if port == settings.port => {}
            (true, _) => {
                self.stop_listener();
                self.start_listener(settings.port).await;
            }
        }
        let status = self.status();
        if status != before {
            self.shared.ui.status_changed(&status);
        }
        status
    }

    async fn start_listener(&self, port: u16) {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                let port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
                let stop = CancellationToken::new();
                *self.shared.stop.lock() = stop.clone();
                *self.shared.running.lock() = Some(port);
                *self.shared.error.lock() = None;
                tokio::spawn(http::serve(listener, self.shared.clone(), stop));
                tracing::info!("MCP server on {}", endpoint_url(port));
            }
            Err(e) => {
                let message = if e.kind() == std::io::ErrorKind::AddrInUse {
                    format!("Port {port} is in use by another program; choose another port.")
                } else {
                    format!("Cannot listen on 127.0.0.1:{port}: {e}")
                };
                tracing::warn!("MCP server: {message}");
                *self.shared.error.lock() = Some(message);
            }
        }
    }

    fn stop_listener(&self) {
        self.shared.stop.lock().cancel();
        self.shared.sessions.lock().clear();
        *self.shared.running.lock() = None;
        *self.shared.error.lock() = None;
    }

    /// Stops serving (application exit).
    pub fn shutdown(&self) {
        self.stop_listener();
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
        self.shared.sessions.lock().clear();
    }

    /// Every tool, for the settings page.
    pub fn tools(&self, settings: &McpSettings) -> Vec<McpToolInfo> {
        self.shared
            .tools
            .iter()
            .map(|t| McpToolInfo {
                name: t.name.into(),
                description: t.description.trim().into(),
                kind: t.kind,
                enabled: !settings.disabled_tools.iter().any(|d| d == t.name),
            })
            .collect()
    }

    /// Handles one HTTP request (tests drive the server without a socket).
    #[doc(hidden)]
    pub async fn handle_for_test(
        &self,
        port: u16,
        method: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> (u16, Vec<(String, String)>, String) {
        let request = http::Request {
            method: method.into(),
            path: http::ENDPOINT.into(),
            headers: headers.iter().map(|(k, v)| (k.to_ascii_lowercase(), (*v).to_owned())).collect(),
            body: body.as_bytes().to_vec(),
        };
        let r = http::route(&self.shared, port, request).await;
        (
            r.status,
            r.headers.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
            String::from_utf8_lossy(&r.body).into_owned(),
        )
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
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut f = options.open(&tmp)?;
        std::io::Write::write_all(&mut f, token.as_bytes())?;
    }
    std::fs::rename(&tmp, file)?;
    Ok(token)
}
