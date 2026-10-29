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
//!   streaming argument.

use crate::Host;
use crate::ops::{self, Emit};
use ide_core::{IdeError, IdeEvent, IdeResult, RequestId, TaskId};
use ide_jsonrpc::{Handler, Peer, codes};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

pub const PROTOCOL_VERSION: u32 = 1;

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

/// Commands the server answers, by name.
#[derive(Default, Clone)]
pub struct Dispatcher {
    handlers: HashMap<&'static str, HandlerFn>,
}

impl Dispatcher {
    pub fn add<F, Fut, T>(&mut self, name: &'static str, f: F) -> &mut Self
    where
        F: Fn(Call) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = IdeResult<T>> + Send + 'static,
        T: Serialize,
    {
        let f = Arc::new(f);
        self.handlers.insert(
            name,
            Arc::new(move |call| {
                let fut = f(call);
                Box::pin(async move {
                    let value = fut.await?;
                    serde_json::to_value(value).map_err(|e| IdeError::internal(e.to_string()))
                })
            }),
        );
        self
    }

    pub fn commands(&self) -> Vec<&'static str> {
        let mut out: Vec<_> = self.handlers.keys().copied().collect();
        out.sort_unstable();
        out
    }

    /// The commands of the core remote slice: project, files, documents, search,
    /// terminals, runs and VCS status.
    pub fn standard() -> Self {
        let mut d = Self::default();
        d.add("open_project", |c| async move {
            let path: PathBuf = c.arg("path")?;
            let project = ops::project::open(&c.host, &c.window, &path).await?;
            Ok(ops::project::info(&project))
        })
        .add("project_current", |c| async move { Ok(ops::project::current(&c.host, &c.window)) })
        .add("close_project", |c| async move {
            c.host.close_project(&c.window);
            Ok(())
        })
        .add("project_roots", |c| async move { ops::project::roots(&c.host, &c.window) })
        .add("settings_get", |c| async move { Ok(ops::project::settings(&c.host, &c.window)) })
        .add("settings_set", |c| async move {
            let key: String = c.arg("key")?;
            let scope = c.arg("scope")?;
            let applied = ops::project::set_settings(&c.host, &c.window, scope, &key, &c.arg::<String>("value")?)?;
            let sink = c.host.window_sink(&c.window);
            sink.emit(IdeEvent::SettingsChanged { key });
            if let Some(root) = applied.roots_changed {
                sink.emit(IdeEvent::ProjectRootsChanged { root });
            }
            Ok(applied.settings)
        })
        .add("cancel_request", |c| async move {
            c.host.cancel_request(c.arg::<RequestId>("id")?);
            Ok(())
        })
        .add("cancel_task", |c| async move { Ok(ide_core::task::cancel(c.arg::<TaskId>("id")?)) })
        .add("fs_read_dir", |c| async move { ops::fs::read_dir(&c.host, &c.window, c.arg("path")?) })
        .add("fs_create_file", |c| async move { ops::fs::create_file(&c.host, &c.window, c.arg("path")?) })
        .add("fs_create_dir", |c| async move { ide_vfs::create_dir(&c.arg::<PathBuf>("path")?) })
        .add("fs_rename", |c| async move { ide_vfs::rename(&c.arg::<PathBuf>("from")?, &c.arg::<PathBuf>("to")?) })
        .add("fs_set_writable", |c| async move {
            ops::fs::set_writable(&c.host, &c.window, c.arg("path")?, c.arg("writable")?)
        })
        .add("fs_delete", |c| async move { ops::fs::delete(&c.host, &c.window, c.arg("path")?).await })
        .add("fs_copy", |c| async move { ops::fs::copy(&c.host, c.arg("from")?, c.arg("to")?).await })
        .add("fs_read_text", |c| async move { ops::fs::read_text(&c.host, &c.window, c.arg("path")?).await })
        .add("doc_open", |c| async move { ops::doc::open(&c.host, &c.window, c.arg("path")?).await })
        .add("doc_close", |c| async move { ops::doc::close(&c.host, &c.window, c.arg("doc")?) })
        .add("doc_edit", |c| async move {
            ops::doc::edit(&c.host, &c.window, c.arg("doc")?, c.arg("baseVersion")?, c.arg("changes")?)
        })
        .add("doc_save", |c| async move { ops::doc::save(&c.host, &c.window, c.arg("doc")?).await })
        .add("doc_save_all", |c| async move { ops::doc::save_all(&c.host, &c.window).await })
        .add("doc_snapshot", |c| async move { ops::doc::snapshot(&c.host, &c.window, c.arg("doc")?).await })
        .add("search_start", |c| async move {
            let on_event = c.channel("onEvent")?;
            ops::search::start(&c.host, &c.window, c.arg("request")?, c.arg("query")?, on_event).await
        })
        .add("term_spawn", |c| async move {
            let on_output = c.channel("onOutput")?;
            ops::term::spawn(&c.host, &c.window, c.arg("options")?, on_output)
        })
        .add("term_write", |c| async move { ops::term::write(&c.host, c.arg("id")?, &c.arg::<String>("data")?) })
        .add("term_resize", |c| async move { ops::term::resize(&c.host, c.arg("id")?, c.arg("cols")?, c.arg("rows")?) })
        .add("term_kill", |c| async move { ops::term::kill(&c.host, c.arg("id")?) })
        .add("term_is_busy", |c| async move { ops::term::is_busy(&c.host, c.arg("id")?) })
        .add("term_default_shell", |_| async move { Ok(ide_terminal::default_shell_path()) })
        .add("term_available_shells", |_| async move { Ok(ide_terminal::available_shells()) })
        .add("run_configs", |c| async move { ops::run::configs(&c.host, &c.window) })
        .add("run_save_configs", |c| async move {
            ops::run::save_configs(&c.host, &c.window, &c.arg::<Vec<ide_run::RunConfig>>("configs")?)
        })
        .add("run_system_env", |_| async move { Ok(ide_run::system_env()) })
        .add("run_start", |c| async move {
            let on_output = c.channel("onOutput")?;
            ops::run::start(&c.host, &c.window, c.arg("config")?, on_output).await
        })
        .add("run_stop", |c| async move { ops::run::stop(&c.host, &c.window, c.arg("id")?) })
        .add("run_stdin", |c| async move { ops::run::stdin(&c.host, c.arg("id")?, &c.arg::<String>("data")?) })
        .add("run_resize", |c| async move { ops::run::resize(&c.host, c.arg("id")?, c.arg("cols")?, c.arg("rows")?) })
        .add("run_close_stdin", |c| async move { ops::run::close_stdin(&c.host, c.arg("id")?) })
        .add("run_list", |c| async move { Ok(ops::run::list(&c.host)) })
        .add("vcs_status", |c| async move { ops::vcs::status(&c.host, &c.window).await });
        ops::register_all(&mut d);
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
    let handler = Arc::new(ServerHandler { host: host.clone(), dispatcher, peer: peer.clone() });
    let p = Peer::connect(reader, writer, handler);
    let _ = peer.set(p.clone());
    p.closed().await;
}

/// Sends a window's events to the client as `event` notifications.
pub fn event_sink(peer: Arc<OnceLock<Peer>>, window: Option<String>) -> ide_core::SharedSink {
    Arc::new(PeerSink { peer, window })
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
        match method {
            "initialize" => serde_json::to_value(server_info()).map_err(internal),
            "commands" => serde_json::to_value(self.dispatcher.commands()).map_err(internal),
            "invoke" => {
                let call: Invoke =
                    serde_json::from_value(params).map_err(|e| (codes::INVALID_PARAMS, e.to_string()))?;
                let Some(handler) = self.dispatcher.handlers.get(call.cmd.as_str()).cloned() else {
                    return Err((codes::METHOD_NOT_FOUND, format!("command {} is not available remotely", call.cmd)));
                };
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
