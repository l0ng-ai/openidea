//! Remote development protocol: JSON-RPC 2.0 (`Content-Length` framing) between
//! the desktop app and `openidea-server`, over the server's stdio (an SSH exec
//! channel).
//!
//! * client → server request `initialize` `{ version, secret? }` → [`ServerInfo`.
//!   On a `--listen` (TCP) connection `secret` must be the server's per-launch
//!   token (`OPENIDEA_LISTEN_SECRET` or the one it prints to stderr) and must be
//!   the first request — every other request is refused until it authenticates,
//!   and a wrong secret closes the connection. stdio needs none: SSH already
//!   authenticated the channel. TCP is plaintext: bind loopback or tunnel it;
//! * client → server request `invoke` `{ window, cmd, args }` → the command's
//!   result, `args` as the desktop command takes them (camelCase names). A
//!   streaming argument is `{ "$channel": <id> }`;
//! * server → client notification `event` `{ window, event }` (an `IdeEvent`
//!   for that window, or every window when `window` is null);
//! * server → client notification `channel` `{ id, data }`: one value of a
//!   streaming argument;
//! * server → client notification `plugin` `{ window, event }` and request
//!   `plugin_secret` `{ plugin, name }` → `string | null`: code plugins of the
//!   remote project (`plugins::remote_host`).

use crate::Host;
use crate::catalogue::TrustClass;
use crate::ops::{self, Emit};
use ide_core::{IdeError, IdeEvent, IdeResult};
use ide_jsonrpc::{Handler, Peer, codes};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub version: String,
    pub protocol: u32,
    pub os: String,
    pub arch: String,
    pub home: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invoke {
    pub window: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventMessage {
    pub window: Option<String>,
    pub event: IdeEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMessage {
    pub id: u64,
    pub data: Value,
}

/// One `invoke`: its arguments and a way to stream values back.
pub struct Call {
    pub host: Arc<Host>,
    pub window: String,
    pub args: Value,
    peer: Arc<OnceLock<Peer>>,
}

impl Call {
    /// Argument `name` (missing = `null`, so `Option`s may be omitted).
    pub fn arg<T: DeserializeOwned>(&self, name: &str) -> IdeResult<T> {
        let v = self.args.get(name).cloned().unwrap_or(Value::Null);
        serde_json::from_value(v).map_err(|e| IdeError::invalid(format!("argument {name}: {e}")))
    }

    /// Streaming argument `name` as an [`ops::Channel`].
    pub fn sender<T: Serialize + 'static>(&self, name: &str) -> IdeResult<ops::Channel<T>> {
        let emit = self.channel(name)?;
        Ok(ops::Channel::new(move |v| emit(v)))
    }

    /// Streaming argument `name` (`{ "$channel": id }`).
    pub fn channel<T: Serialize + 'static>(&self, name: &str) -> IdeResult<Emit<T>> {
        let id = self
            .args
            .get(name)
            .and_then(|v| v.get("$channel"))
            .and_then(Value::as_u64)
            .ok_or_else(|| IdeError::invalid(format!("argument {name}: expected a channel")))?;
        let peer = self.peer.clone();
        Ok(Arc::new(move |data: T| {
            let Some(peer) = peer.get() else { return };
            match serde_json::to_value(&data) {
                Ok(data) => {
                    let _ = peer.notify("channel", ChannelMessage { id, data });
                }
                Err(e) => tracing::warn!("channel {id}: {e}"),
            }
        }))
    }
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type HandlerFn = Arc<dyn Fn(Call) -> BoxFuture<IdeResult<Value>> + Send + Sync>;

/// Commands the server answers, by name, each with the trust class it declares.
#[derive(Default, Clone)]
pub struct Dispatcher {
    handlers: HashMap<&'static str, (TrustClass, HandlerFn)>,
}

impl Dispatcher {
    pub fn add<F, Fut, T>(&mut self, name: &'static str, trust: TrustClass, f: F) -> &mut Self
    where
        F: Fn(Call) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = IdeResult<T>> + Send + 'static,
        T: Serialize,
    {
        let f = Arc::new(f);
        let handler: HandlerFn = Arc::new(move |call| {
            let fut = f(call);
            Box::pin(async move {
                let value = fut.await?;
                serde_json::to_value(value).map_err(|e| IdeError::internal(e.to_string()))
            })
        });
        assert!(self.handlers.insert(name, (trust, handler)).is_none(), "command {name} is registered twice");
        self
    }

    pub fn commands(&self) -> Vec<&'static str> {
        let mut out: Vec<_> = self.handlers.keys().copied().collect();
        out.sort_unstable();
        out
    }

    /// The trust class `name` was registered with.
    pub fn trust(&self, name: &str) -> Option<TrustClass> {
        self.handlers.get(name).map(|(trust, _)| *trust)
    }

    /// The commands every project host answers: those declared with `#[command]`.
    pub fn standard() -> Self {
        let mut d = Self::default();
        ops::register_domains(&mut d);
        d
    }
}

/// Serves `host` over `reader` / `writer` until the client disconnects.
/// `peer` must be the one whose events `host` sends ([`event_sink`]).
pub async fn serve<R, W>(host: Arc<Host>, dispatcher: Dispatcher, peer: Arc<OnceLock<Peer>>, reader: R, writer: W)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let handler = Arc::new(ServerHandler { host: host.clone(), dispatcher, peer: peer.clone(), auth: None });
    let p = Peer::connect(reader, writer, handler);
    let _ = peer.set(p.clone());
    p.closed().await;
    // Reports belong to the disconnected desktop, even while the host shuts down.
    for window in host.projects.read().keys() {
        host.mcp_reports.forget_window(window);
    }
}

/// [`serve`](Self::serve) for a `--listen` server: returns the created `Peer`
/// so the caller can track it for event broadcast, and sets `peer` too.
/// `secret` is the per-launch token `initialize` must carry; a connection that
/// fails it is closed, and every other request is refused before it.
pub async fn serve_listen<R, W>(
    host: Arc<Host>,
    dispatcher: Dispatcher,
    peer: Arc<OnceLock<Peer>>,
    reader: R,
    writer: W,
    secret: String,
) -> Peer
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let handler =
        Arc::new(ServerHandler { host: host.clone(), dispatcher, peer: peer.clone(), auth: Some(Auth::new(secret)) });
    let p = Peer::connect(reader, writer, handler);
    let _ = peer.set(p.clone());
    p.closed().await;
    for window in host.projects.read().keys() {
        host.mcp_reports.forget_window(window);
    }
    p
}

/// Sends a window's events to the client as `event` notifications.
pub fn event_sink(peer: Arc<OnceLock<Peer>>, window: Option<String>) -> ide_core::SharedSink {
    Arc::new(PeerSink { peer, window })
}

/// Whether a desktop shows an `event` notification of its server in the window. A server reports
/// on its project; what this machine answers or owns itself (MCP approvals, app updates, window
/// groups, its own connection to the server) never comes from it.
pub fn client_accepts(event: &IdeEvent) -> bool {
    match event {
        IdeEvent::McpRequest { .. }
        | IdeEvent::McpRequestClosed { .. }
        | IdeEvent::WindowGroupsChanged
        | IdeEvent::WindowFullscreenChanged
        | IdeEvent::RemoteConnectionLost { .. }
        | IdeEvent::UpdateStatusChanged { .. }
        | IdeEvent::UpdateAvailable { .. } => false,
        IdeEvent::DbSourcesChanged
        | IdeEvent::ProjectTrustChanged { .. }
        | IdeEvent::Direnv { .. }
        | IdeEvent::FsChanged { .. }
        | IdeEvent::ExcludedDirsChanged { .. }
        | IdeEvent::DocPatched { .. }
        | IdeEvent::DocDirty { .. }
        | IdeEvent::WorkspaceEditApplied { .. }
        | IdeEvent::DocLanguage { .. }
        | IdeEvent::Diagnostics { .. }
        | IdeEvent::Task { .. }
        | IdeEvent::IndexState { .. }
        | IdeEvent::VcsChanged { .. }
        | IdeEvent::LanguageServer { .. }
        | IdeEvent::LanguageServerWarning { .. }
        | IdeEvent::LanguageServerRemoved { .. }
        | IdeEvent::LspRefresh { .. }
        | IdeEvent::LspMessageRequest { .. }
        | IdeEvent::LspMessageRequestDone { .. }
        | IdeEvent::TerminalExited { .. }
        | IdeEvent::RunExited { .. }
        | IdeEvent::Debug { .. }
        | IdeEvent::Notify { .. }
        | IdeEvent::SettingsChanged { .. }
        | IdeEvent::ProjectRootsChanged { .. }
        | IdeEvent::Askpass { .. }
        | IdeEvent::AskpassDone { .. }
        | IdeEvent::NotebookKernel { .. } => true,
    }
}

struct PeerSink {
    peer: Arc<OnceLock<Peer>>,
    window: Option<String>,
}

impl ide_core::EventSink for PeerSink {
    fn emit(&self, event: IdeEvent) {
        if let Some(peer) = self.peer.get() {
            let _ = peer.notify("event", EventMessage { window: self.window.clone(), event });
        }
    }
}

struct ServerHandler {
    host: Arc<Host>,
    dispatcher: Dispatcher,
    peer: Arc<OnceLock<Peer>>,
    /// TCP transport authentication (`--listen`); `None` on stdio, where the
    /// parent process (SSH) already authenticated the channel.
    auth: Option<Auth>,
}

/// The per-launch secret an `initialize` must carry before any other request is
/// served. A wrong secret closes the connection; the compare is constant-time.
struct Auth {
    secret: Vec<u8>,
    done: std::sync::atomic::AtomicBool,
}

impl Auth {
    fn new(secret: String) -> Self {
        Self { secret: secret.into_bytes(), done: std::sync::atomic::AtomicBool::new(false) }
    }

    /// Byte-wise equal-length compare that doesn't early-exit on a mismatch.
    fn matches(&self, given: &[u8]) -> bool {
        if given.len() != self.secret.len() {
            return false;
        }
        given.iter().zip(&self.secret).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
    }
}

pub fn server_info() -> ServerInfo {
    ServerInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        protocol: PROTOCOL_VERSION,
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        home: dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

impl Handler for ServerHandler {
    fn on_notification(&self, _method: &str, _params: Value) {}

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let internal = |e: serde_json::Error| (codes::INTERNAL_ERROR, e.to_string());
        if let Some(auth) = &self.auth
            && !auth.done.load(std::sync::atomic::Ordering::Acquire)
        {
            if method != "initialize" {
                return Err((codes::INVALID_REQUEST, "initialize with the secret first".to_owned()));
            }
            let given = params.get("secret").and_then(Value::as_str).unwrap_or_default();
            if !auth.matches(given.as_bytes()) {
                tracing::warn!("rejected a client with a wrong secret");
                if let Some(peer) = self.peer.get() {
                    peer.kill();
                }
                return Err((codes::INVALID_PARAMS, "wrong secret".to_owned()));
            }
            auth.done.store(true, std::sync::atomic::Ordering::Release);
        }
        match method {
            "initialize" => serde_json::to_value(server_info()).map_err(internal),
            "commands" => serde_json::to_value(self.dispatcher.commands()).map_err(internal),
            "invoke" => {
                let call: Invoke =
                    serde_json::from_value(params).map_err(|e| (codes::INVALID_PARAMS, e.to_string()))?;
                let Some((trust, handler)) = self.dispatcher.handlers.get(call.cmd.as_str()).cloned() else {
                    return Err((codes::METHOD_NOT_FOUND, format!("command {} is not available remotely", call.cmd)));
                };
                self.host.authorize(&call.window, trust).map_err(error_reply)?;
                let c = Call { host: self.host.clone(), window: call.window, args: call.args, peer: self.peer.clone() };
                // Requests run on blocking-capable threads: wait for the command here.
                self.host.runtime.block_on(handler(c)).map_err(error_reply)
            }
            _ => Err((codes::METHOD_NOT_FOUND, format!("unknown method {method}"))),
        }
    }
}

/// An `IdeError` as a JSON-RPC error: the JSON of the error is the message.
fn error_reply(e: IdeError) -> (i64, String) {
    (codes::INTERNAL_ERROR, serde_json::to_string(&e).unwrap_or(e.message))
}

/// The `IdeError` of an `invoke` reply (see [`error_reply`]).
pub fn error_from_reply(e: ide_jsonrpc::RpcError) -> IdeError {
    match e {
        ide_jsonrpc::RpcError::Server { message, .. } => serde_json::from_str(&message)
            .unwrap_or_else(|_| IdeError::new(ide_core::error::ErrorKind::Protocol, message)),
        other => other.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::event::{AskpassKind, McpUiRequest, NotifyLevel};

    #[test]
    fn a_server_cannot_raise_desktop_prompts() {
        let confirm = McpUiRequest::Confirm {
            client: "agent".into(),
            tool: "run".into(),
            subject: "rm -rf".into(),
            project: "/srv/app".into(),
            detail: None,
        };
        let update = ide_core::updates::UpdateInfo {
            version: "9.9.9".into(),
            current_version: "0.1.0".into(),
            notes: None,
            date: None,
        };
        for event in [
            IdeEvent::McpRequest { id: 1, request: confirm },
            IdeEvent::McpRequestClosed { id: 1 },
            IdeEvent::UpdateAvailable { update },
            IdeEvent::UpdateStatusChanged {
                status: ide_core::updates::UpdateStatus { last_checked: None, checking: true },
            },
            IdeEvent::WindowGroupsChanged,
            IdeEvent::WindowFullscreenChanged,
        ] {
            assert!(!client_accepts(&event), "{event:?}");
        }
    }

    #[test]
    fn a_server_reports_its_project_to_the_desktop() {
        for event in [
            IdeEvent::FsChanged {
                created: vec!["/srv/app/a".into()],
                modified: vec![],
                removed: vec![],
                ignore_rules: vec![],
            },
            IdeEvent::VcsChanged { root: "/srv/app".into() },
            IdeEvent::Notify { level: NotifyLevel::Info, title: "Build".into(), body: None },
            IdeEvent::Askpass { id: 1, prompt: "Password".into(), kind: AskpassKind::Secret, remember: false },
            IdeEvent::ProjectTrustChanged { root: "/srv/app".into(), trusted: true },
        ] {
            assert!(client_accepts(&event), "{event:?}");
        }
    }
}
