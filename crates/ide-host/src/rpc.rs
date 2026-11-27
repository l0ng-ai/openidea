//! Remote development protocol: JSON-RPC 2.0 (`Content-Length` framing) between
//! the desktop app and `openidea-server`, over the server's stdio (an SSH exec
//! channel).
//!
//! * client → server request `initialize` `{ version }` → [`ServerInfo`];
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

/// 3: binary arguments (`IpcBytes`) are base64 strings, not arrays of numbers.
/// 4: a running tool's output arrives as `AgentEvent::ToolOutput` appends; a client that
/// doesn't know the event would show stale output.
pub const PROTOCOL_VERSION: u32 = 4;
pub const SESSION_REPLACED: &str = "session_replaced";
/// What `openidea-server --attach` reports when another build's backend keeps the project
/// (clients match it to offer stopping that backend).
pub const OTHER_BUILD_BUSY: &str = "Another build of OpenIDEA still has this project open, is running tasks, or has \
     unsaved changes. Reconnect with that build, or stop its backend and open the project again.";
pub const SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// Advertised only by a persistent backend with an editable idle timeout.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIdlePolicy {
    pub override_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub version: String,
    pub protocol: u32,
    pub os: String,
    pub arch: String,
    pub home: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_policy: Option<RemoteIdlePolicy>,
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

/// Streaming lifecycle signal delivered through a [`ChannelSink`].
#[derive(Debug, Clone)]
pub enum ChannelSignal {
    /// Emitted when a command claims a `{ "$channel": id }` argument.
    Opened(u64),
    /// One serialized streaming payload.
    Data(ChannelMessage),
    /// Emitted automatically when the last clone of the command's channel emitter is dropped.
    End(u64),
}

/// Delivers streaming values and lifecycle signals from a command back to its caller.
pub type ChannelSink = Arc<dyn Fn(ChannelSignal) + Send + Sync>;

struct ChannelDropGuard {
    id: u64,
    sink: ChannelSink,
}

impl Drop for ChannelDropGuard {
    fn drop(&mut self) {
        (self.sink)(ChannelSignal::End(self.id));
    }
}

/// Holds the active client [`Peer`]: once for `--stdio` ([`OnceLock<Peer>`]) or
/// rebound across client reconnects for a persistent daemon ([`PeerSlot`]).
pub trait PeerHandle: Send + Sync + 'static {
    fn current(&self) -> Option<Peer>;
    fn install(&self, peer: Peer) -> (u64, Option<Peer>);
    fn clear(&self, generation: u64) -> bool;
}

impl PeerHandle for OnceLock<Peer> {
    fn current(&self) -> Option<Peer> {
        self.get().cloned()
    }

    fn install(&self, peer: Peer) -> (u64, Option<Peer>) {
        let _ = self.set(peer);
        (1, None)
    }

    fn clear(&self, _: u64) -> bool {
        true
    }
}

/// Rebindable client connection slot for a persistent `openidea-server` daemon.
#[derive(Default)]
pub struct PeerSlot {
    inner: parking_lot::RwLock<Option<(u64, Peer)>>,
    seq: std::sync::atomic::AtomicU64,
}

impl PeerSlot {
    #[cfg(unix)]
    pub(crate) fn remove(&self) -> Option<Peer> {
        self.inner.write().take().map(|(_, p)| p)
    }
}

impl PeerHandle for PeerSlot {
    fn current(&self) -> Option<Peer> {
        self.inner.read().as_ref().map(|(_, p)| p.clone())
    }

    fn install(&self, peer: Peer) -> (u64, Option<Peer>) {
        let id = self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let previous = self.inner.write().replace((id, peer)).map(|(_, p)| p);
        (id, previous)
    }

    fn clear(&self, generation: u64) -> bool {
        let mut guard = self.inner.write();
        if guard.as_ref().is_some_and(|(id, _)| *id == generation) {
            *guard = None;
            true
        } else {
            false
        }
    }
}

/// One `invoke`: its arguments and a way to stream values back.
pub struct Call {
    pub host: Arc<Host>,
    pub window: String,
    pub args: Value,
    channel_sink: ChannelSink,
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
        let sink = self.channel_sink.clone();
        sink(ChannelSignal::Opened(id));
        let guard = ChannelDropGuard { id, sink };
        Ok(Arc::new(move |data: T| match serde_json::to_value(&data) {
            Ok(data) => (guard.sink)(ChannelSignal::Data(ChannelMessage { id: guard.id, data })),
            Err(e) => tracing::warn!("channel {}: {e}", guard.id),
        }))
    }
}

fn peer_channel_sink(peer: Arc<dyn PeerHandle>) -> ChannelSink {
    Arc::new(move |signal: ChannelSignal| {
        if let ChannelSignal::Data(msg) = signal
            && let Some(peer) = peer.current()
        {
            let _ = peer.notify("channel", msg);
        }
    })
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type HandlerFn = Arc<dyn Fn(Call) -> BoxFuture<IdeResult<Value>> + Send + Sync>;

/// Commands the server answers, by name, each with the trust class it declares.
#[derive(Default, Clone)]
pub struct Dispatcher {
    handlers: HashMap<&'static str, (TrustClass, HandlerFn)>,
}

impl Dispatcher {
    fn wrap_handler<F, Fut, T>(f: F) -> HandlerFn
    where
        F: Fn(Call) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = IdeResult<T>> + Send + 'static,
        T: Serialize,
    {
        let f = Arc::new(f);
        Arc::new(move |call| {
            let fut = f(call);
            Box::pin(async move {
                let value = fut.await?;
                serde_json::to_value(value).map_err(|e| IdeError::internal(e.to_string()))
            })
        })
    }

    pub fn add<F, Fut, T>(&mut self, name: &'static str, trust: TrustClass, f: F) -> &mut Self
    where
        F: Fn(Call) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = IdeResult<T>> + Send + 'static,
        T: Serialize,
    {
        let handler = Self::wrap_handler(f);
        assert!(self.handlers.insert(name, (trust, handler)).is_none(), "command {name} is registered twice");
        self
    }

    /// Registers or replaces `name` (used by the web server to add shell-level hooks such as recent-project tracking).
    pub fn replace<F, Fut, T>(&mut self, name: &'static str, trust: TrustClass, f: F) -> &mut Self
    where
        F: Fn(Call) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = IdeResult<T>> + Send + 'static,
        T: Serialize,
    {
        let handler = Self::wrap_handler(f);
        self.handlers.insert(name, (trust, handler));
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

    /// Invokes a command asynchronously with trust enforcement and a caller-supplied channel sink.
    pub async fn invoke(
        &self,
        host: Arc<Host>,
        window: String,
        cmd: &str,
        args: Value,
        channel_sink: ChannelSink,
    ) -> IdeResult<Value> {
        let Some((trust, handler)) = self.handlers.get(cmd).cloned() else {
            return Err(IdeError::unavailable(format!("command {cmd} is not available")));
        };
        host.authorize(&window, trust)?;
        let call = Call { host, window, args, channel_sink };
        handler(call).await
    }
}

/// Serves `host` over `reader` / `writer` until the client disconnects.
/// `peer` must be the one whose events `host` sends ([`event_sink`]).
pub async fn serve<R, W, P>(host: Arc<Host>, dispatcher: Dispatcher, peer: Arc<P>, reader: R, writer: W)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
    P: PeerHandle,
{
    let slot: Arc<dyn PeerHandle> = peer;
    let handler = Arc::new(ServerHandler { host: host.clone(), dispatcher, peer: slot.clone(), daemon: None });
    let p = Peer::connect(reader, writer, handler);
    let (generation, previous) = slot.install(p.clone());
    if let Some(old) = previous {
        old.kill();
    }
    p.closed().await;
    if slot.clear(generation) {
        // Reports belong to the disconnected desktop, even while the host shuts down.
        for window in host.projects.read().keys() {
            host.mcp_reports.forget_window(window);
        }
    }
}

/// The daemon owns the peer and handles replacement and disconnect serially.
#[cfg(unix)]
pub(crate) fn connect_persistent<R, W>(
    host: Arc<Host>,
    dispatcher: Dispatcher,
    peer: Arc<PeerSlot>,
    shutdown: ide_core::CancellationToken,
    idle_policy: RemoteIdlePolicy,
    reader: R,
    writer: W,
) -> Peer
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    // Streaming ids belong to the calling connection, not the next window to attach.
    let connection = Arc::new(OnceLock::new());
    let handler =
        Arc::new(ServerHandler { host, dispatcher, peer: connection.clone(), daemon: Some((shutdown, idle_policy)) });
    let p = Peer::connect(reader, writer, handler);
    let _ = connection.set(p.clone());
    let (_, previous) = peer.install(p.clone());
    debug_assert!(previous.is_none());
    p
}

/// Sends a window's events to the client as `event` notifications.
pub fn event_sink<P: PeerHandle>(peer: Arc<P>, window: Option<String>) -> ide_core::SharedSink {
    Arc::new(PeerSink { peer, window })
}

/// Whether a desktop shows an `event` notification of its server in the window. A server reports
/// on its project; what this machine owns itself (app updates, window groups, its own connection
/// to the server) never comes from it, and MCP UI requests are accepted only when this machine
/// trusts the remote project (their answers route back to the server, never locally).
pub fn client_accepts(event: &IdeEvent, trusted: bool) -> bool {
    match event {
        IdeEvent::WindowGroupsChanged
        | IdeEvent::McpBackgroundProjectsChanged
        | IdeEvent::WindowFullscreenChanged
        | IdeEvent::RemoteConnectionLost { .. }
        | IdeEvent::UpdateStatusChanged { .. }
        | IdeEvent::UpdateAvailable { .. } => false,
        IdeEvent::McpRequest { .. } | IdeEvent::McpRequestClosed { .. } => trusted,
        IdeEvent::DbSourcesChanged
        | IdeEvent::PlotAdded { .. }
        | IdeEvent::ProjectTrustChanged { .. }
        | IdeEvent::Direnv { .. }
        | IdeEvent::FlutterDevices { .. }
        | IdeEvent::FsChanged { .. }
        | IdeEvent::ExcludedDirsChanged { .. }
        | IdeEvent::DocPatched { .. }
        | IdeEvent::DocDirty { .. }
        | IdeEvent::DocDiskConflict { .. }
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
    peer: Arc<dyn PeerHandle>,
    window: Option<String>,
}

impl ide_core::EventSink for PeerSink {
    fn emit(&self, event: IdeEvent) {
        if let Some(peer) = self.peer.current() {
            let _ = peer.notify("event", EventMessage { window: self.window.clone(), event });
        }
    }
}

struct ServerHandler {
    host: Arc<Host>,
    dispatcher: Dispatcher,
    peer: Arc<dyn PeerHandle>,
    daemon: Option<(ide_core::CancellationToken, RemoteIdlePolicy)>,
}

pub(crate) fn server_info(idle_policy: Option<RemoteIdlePolicy>) -> ServerInfo {
    ServerInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        protocol: PROTOCOL_VERSION,
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        home: dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default(),
        idle_policy,
    }
}

impl Handler for ServerHandler {
    fn on_notification(&self, _method: &str, _params: Value) {}

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        if self.daemon.as_ref().is_some_and(|(shutdown, _)| shutdown.is_cancelled()) {
            return Err((codes::INTERNAL_ERROR, "remote backend is stopping".into()));
        }
        let internal = |e: serde_json::Error| (codes::INTERNAL_ERROR, e.to_string());
        match method {
            "initialize" => {
                serde_json::to_value(server_info(self.daemon.as_ref().map(|(_, policy)| *policy))).map_err(internal)
            }
            "commands" => serde_json::to_value(self.dispatcher.commands()).map_err(internal),
            "shutdown" => Ok(Value::Null),
            "invoke" => {
                let call: Invoke =
                    serde_json::from_value(params).map_err(|e| (codes::INVALID_PARAMS, e.to_string()))?;
                let Some((trust, handler)) = self.dispatcher.handlers.get(call.cmd.as_str()).cloned() else {
                    return Err((codes::METHOD_NOT_FOUND, format!("command {} is not available remotely", call.cmd)));
                };
                self.host.authorize(&call.window, trust).map_err(error_reply)?;
                let c = Call {
                    host: self.host.clone(),
                    window: call.window,
                    args: call.args,
                    channel_sink: peer_channel_sink(self.peer.clone()),
                };
                // Requests run on blocking-capable threads: wait for the command here.
                self.host.runtime.block_on(handler(c)).map_err(error_reply)
            }
            _ => Err((codes::METHOD_NOT_FOUND, format!("unknown method {method}"))),
        }
    }

    fn after_response(&self, method: &str) {
        if method == "shutdown"
            && let Some((shutdown, _)) = &self.daemon
        {
            shutdown.cancel();
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
            IdeEvent::McpRequest { id: 1, request: confirm.clone() },
            IdeEvent::McpRequestClosed { id: 1 },
            IdeEvent::UpdateAvailable { update: update.clone() },
            IdeEvent::UpdateStatusChanged {
                status: ide_core::updates::UpdateStatus { last_checked: None, checking: true },
            },
            IdeEvent::WindowGroupsChanged,
            IdeEvent::WindowFullscreenChanged,
        ] {
            assert!(!client_accepts(&event, false), "{event:?}");
        }
        // Even for a trusted remote project, desktop-owned events stay blocked while remote MCP prompts pass.
        assert!(client_accepts(&IdeEvent::McpRequest { id: 1, request: confirm }, true));
        assert!(client_accepts(&IdeEvent::McpRequestClosed { id: 1 }, true));
        for event in [
            IdeEvent::UpdateAvailable { update },
            IdeEvent::UpdateStatusChanged {
                status: ide_core::updates::UpdateStatus { last_checked: None, checking: true },
            },
            IdeEvent::WindowGroupsChanged,
            IdeEvent::WindowFullscreenChanged,
            IdeEvent::McpBackgroundProjectsChanged,
        ] {
            assert!(!client_accepts(&event, true), "{event:?}");
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
            assert!(client_accepts(&event, false), "{event:?}");
            assert!(client_accepts(&event, true), "{event:?}");
        }
    }
}
