//! A kernel on a Jupyter server (`jupyter server`, JupyterLab, a JupyterHub user server):
//! REST calls start, interrupt and delete it, and its messages go over the kernel's
//! channels WebSocket as JSON text frames.
use super::{Channel, DebugPort, Failure, Frame, MAX_MESSAGE_BYTES, SEND_TIMEOUT, protocol};
use crate::kernel::RemoteKernel;
use futures::SinkExt;
use futures::stream::StreamExt;
use ide_core::{IdeError, IdeResult};
use jupyter_protocol::JupyterMessage;
use reqwest::Method;
use serde::Serialize;
use serde_json::{Value, json};
use specta::Type;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Message, http::HeaderValue};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream, client_async_tls_with_config};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Waits between attempts to reopen a dropped channels socket, about 15 s in all.
const RECONNECT_DELAYS: [Duration; 5] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
];

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A kernel spec a Jupyter server offers.
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KernelSpec {
    pub name: String,
    pub display_name: String,
}

/// Where a page's path starts on a Jupyter server (JupyterLab, Notebook, their editors).
const PAGES: [&str; 6] = ["lab", "tree", "notebooks", "edit", "doc", "voila"];

/// The server's base URL (`http(s)://host[:port]/[prefix/]`) from what a user pastes, and
/// the `?token=` it carries. A page's path (`/lab/tree/x.ipynb`, `/notebooks/x.ipynb`) is
/// dropped, so a URL copied from the browser works. A JupyterHub user server's
/// `/user/<name>/` is kept whatever the name.
pub fn normalize_server_url(text: &str) -> IdeResult<(String, Option<String>)> {
    let invalid = || IdeError::invalid("enter the Jupyter server's http:// or https:// URL");
    let mut url = reqwest::Url::parse(text.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(invalid());
    }
    let token = url.query_pairs().find(|(key, _)| key == "token").map(|(_, value)| value.into_owned());
    let mut segments: Vec<String> =
        url.path_segments().into_iter().flatten().filter(|s| !s.is_empty()).map(str::to_owned).collect();
    let prefix = if segments.first().is_some_and(|first| first == "user") { 2 } else { 0 };
    if let Some(page) = segments.iter().skip(prefix).position(|s| PAGES.contains(&s.as_str())) {
        segments.truncate(prefix + page);
    }
    let path = segments.iter().map(|segment| format!("{segment}/")).collect::<String>();
    url.set_path(&format!("/{path}"));
    url.set_query(None);
    url.set_fragment(None);
    let _ = url.set_username("");
    let _ = url.set_password(None);
    Ok((url.to_string(), token))
}

async fn call(base: &str, token: &str, method: Method, path: &str, body: Option<Value>) -> IdeResult<Value> {
    // Redirects are not followed: the token must not travel to another host.
    let client = ide_http::client::shared_without_redirects()?;
    let write = method != Method::GET;
    let mut request = client.request(method, format!("{base}{path}")).timeout(REQUEST_TIMEOUT);
    if !token.is_empty() {
        request = request.header(reqwest::header::AUTHORIZATION, format!("token {token}"));
    } else if write && let Some(xsrf) = xsrf(&client, base).await {
        // A server without a token checks XSRF on every request that changes something.
        request = request.header(reqwest::header::COOKIE, format!("_xsrf={xsrf}")).header("X-XSRFToken", xsrf);
    }
    if let Some(body) = body {
        request = request.header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_string());
    }
    let response = request.send().await.map_err(|error| {
        IdeError::unavailable(format!("could not reach the Jupyter server: {}", ide_http::client::describe(&error)))
    })?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(IdeError::unavailable(if token.is_empty() {
            "the Jupyter server needs a token"
        } else {
            "the Jupyter server did not accept the token"
        }));
    }
    if !status.is_success() {
        return Err(IdeError::unavailable(format!("the Jupyter server answered {status} to {path}")));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| IdeError::unavailable(format!("Jupyter server: {}", ide_http::client::describe(&error))))?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|_| IdeError::unavailable("the URL did not answer like a Jupyter server"))
}

/// The `_xsrf` cookie the server sets on any page (an API reply sets none).
async fn xsrf(client: &reqwest::Client, base: &str) -> Option<String> {
    let response = client.get(base).timeout(REQUEST_TIMEOUT).send().await.ok()?;
    response.headers().get_all(reqwest::header::SET_COOKIE).iter().find_map(|cookie| {
        let value = cookie.to_str().ok()?.split(';').next()?.trim().strip_prefix("_xsrf=")?;
        Some(value.trim_matches('"').to_owned())
    })
}

/// The server's kernel specs, its default first. Also checks the URL and the token.
pub async fn kernel_specs(base: &str, token: &str) -> IdeResult<Vec<KernelSpec>> {
    parse_specs(&call(base, token, Method::GET, "api/kernelspecs", None).await?)
}

fn parse_specs(reply: &Value) -> IdeResult<Vec<KernelSpec>> {
    let specs = reply["kernelspecs"]
        .as_object()
        .ok_or_else(|| IdeError::unavailable("the URL did not answer like a Jupyter server"))?;
    let default = reply["default"].as_str().unwrap_or_default();
    let mut specs: Vec<KernelSpec> = specs
        .iter()
        .map(|(name, spec)| KernelSpec {
            name: name.clone(),
            display_name: spec["spec"]["display_name"].as_str().unwrap_or(name).to_owned(),
        })
        .collect();
    specs.sort_by(|a, b| (a.name != default, &a.display_name).cmp(&(b.name != default, &b.display_name)));
    Ok(specs)
}

/// A kernel the IDE started on a server. Deleted there when the last handle goes, so a
/// startup that fails, times out or is cancelled leaves nothing running.
struct Kernel {
    base: String,
    token: String,
    id: String,
    deleted: AtomicBool,
}

async fn delete(base: &str, token: &str, id: &str) {
    let _ = call(base, token, Method::DELETE, &format!("api/kernels/{id}"), None).await;
}

impl Kernel {
    async fn delete(&self) {
        if !self.deleted.swap(true, Ordering::AcqRel) {
            delete(&self.base, &self.token, &self.id).await;
        }
    }
}

impl Drop for Kernel {
    fn drop(&mut self) {
        if !*self.deleted.get_mut()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let (base, token, id) = (self.base.clone(), self.token.clone(), self.id.clone());
            runtime.spawn(async move { delete(&base, &token, &id).await });
        }
    }
}

pub(crate) struct Link {
    kernel: Arc<Kernel>,
    outgoing: mpsc::Sender<String>,
}

/// Starts a kernel of `kernel.spec` and connects to its channels; frames go to `tx` like
/// a local kernel's ZeroMQ frames. The returned task owns the socket and reopens it, for
/// the same kernel, when it drops.
pub(super) async fn connect(
    kernel: &RemoteKernel,
    tx: mpsc::Sender<Frame>,
    failure: Failure,
    queued: Arc<Semaphore>,
    debug: DebugPort,
) -> IdeResult<(Link, JoinHandle<()>)> {
    let RemoteKernel { base, token, spec } = kernel.clone();
    // Not cancelled with the caller: a kernel the server starts after that is deleted.
    let (sent, started) = oneshot::channel();
    tokio::spawn(async move {
        let reply = call(&base, &token, Method::POST, "api/kernels", Some(json!({ "name": spec }))).await;
        let kernel = reply.and_then(|reply| {
            let id = reply["id"].as_str().ok_or_else(|| protocol("kernel start reply has no id"))?.to_owned();
            Ok(Arc::new(Kernel { base, token, id, deleted: AtomicBool::new(false) }))
        });
        let _ = sent.send(kernel);
    });
    let kernel = started.await.map_err(|_| IdeError::unavailable("kernel start task ended"))??;
    let session = uuid::Uuid::new_v4().to_string();
    let socket = open_channels(&kernel, &session).await?;
    let (outgoing, messages) = mpsc::channel(16);
    let pump = tokio::spawn(pump(kernel.clone(), session, socket, messages, tx, failure, queued, debug));
    Ok((Link { kernel, outgoing }, pump))
}

/// Moves messages between the socket and the session until the link goes. A socket that
/// drops is reopened with the same session id, so the server replays what it buffered.
#[allow(clippy::too_many_arguments)]
async fn pump(
    kernel: Arc<Kernel>,
    session: String,
    mut socket: Socket,
    mut messages: mpsc::Receiver<String>,
    tx: mpsc::Sender<Frame>,
    failure: Failure,
    queued: Arc<Semaphore>,
    debug: DebugPort,
) {
    loop {
        tokio::select! {
            message = messages.recv() => {
                let Some(message) = message else { return };
                match tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Text(message.into()))).await {
                    Ok(Ok(())) => {}
                    _ => return failure.fail(IdeError::unavailable(
                        "sending to the Jupyter server failed; delivery uncertain, not retried",
                    )),
                }
            }
            incoming = socket.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text,
                    // Binary frames carry messages with buffers (widgets), which notebooks do not show.
                    Some(Ok(Message::Close(_)) | Err(_)) | None => match reopen(&kernel, &session).await {
                        Ok(reopened) => { socket = reopened; continue; }
                        Err(error) => return failure.fail(error),
                    },
                    Some(Ok(_)) => continue,
                };
                match frame(text.as_str(), &queued, &debug) {
                    Ok(Some(frame)) => {
                        if tx.try_send(frame).is_err() {
                            return failure.fail(IdeError::unavailable(
                                "kernel output queue overflow; execution stopped to bound memory",
                            ));
                        }
                    }
                    Ok(None) => {}
                    Err(error) => return failure.fail(error),
                }
            }
        }
    }
}

async fn reopen(kernel: &Kernel, session: &str) -> IdeResult<Socket> {
    let mut last = None;
    for delay in RECONNECT_DELAYS {
        tokio::time::sleep(delay).await;
        match open_channels(kernel, session).await {
            Ok(socket) => return Ok(socket),
            Err(error) => last = Some(error),
        }
    }
    let reason = last.map(|error| error.message).unwrap_or_default();
    Err(IdeError::unavailable(format!(
        "lost the connection to the Jupyter server ({reason}); the kernel may still be running there"
    )))
}

async fn open_channels(kernel: &Kernel, session: &str) -> IdeResult<Socket> {
    let Kernel { base, token, id, .. } = kernel;
    let ws = base.replacen("http", "ws", 1);
    let url = format!("{ws}api/kernels/{id}/channels?session_id={session}");
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| IdeError::invalid(format!("Jupyter server URL: {error}")))?;
    if !token.is_empty() {
        let value = HeaderValue::from_str(&format!("token {token}"))
            .map_err(|_| IdeError::invalid("the token contains characters a header cannot carry"))?;
        request.headers_mut().insert("authorization", value);
    }
    let config =
        WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES)).max_frame_size(Some(MAX_MESSAGE_BYTES));
    let connector = if ws.starts_with("wss:") {
        Connector::Rustls(Arc::new(ide_http::client::tls_config()?))
    } else {
        Connector::Plain
    };
    let opening = async {
        // Through the HTTP proxy the REST calls use, if any.
        let stream =
            ide_http::tunnel::connect(&reqwest::Url::parse(&url).map_err(|_| IdeError::invalid("Jupyter server URL"))?)
                .await?;
        client_async_tls_with_config(request, stream, Some(config), Some(connector))
            .await
            .map_err(|error| IdeError::unavailable(format!("could not connect to the kernel's channels: {error}")))
    };
    let (socket, _) = tokio::time::timeout(REQUEST_TIMEOUT, opening)
        .await
        .map_err(|_| IdeError::unavailable("connecting to the kernel's channels on the Jupyter server timed out"))??;
    Ok(socket)
}

/// One JSON message from the channels socket; `None` for channels notebooks do not use.
fn frame(text: &str, queued: &Arc<Semaphore>, debug: &DebugPort) -> IdeResult<Option<Frame>> {
    let bytes = text.len();
    if bytes > MAX_MESSAGE_BYTES {
        return Err(IdeError::unavailable("kernel message exceeds 8 MiB limit; execution stopped"));
    }
    let mut value: Value = serde_json::from_str(text).map_err(protocol)?;
    if debug.route(value["header"]["msg_type"].as_str().unwrap_or_default(), &value["content"]) {
        return Ok(None);
    }
    let channel = match value["channel"].as_str() {
        Some("shell") => Channel::Shell,
        Some("iopub") => Channel::Iopub,
        _ => return Ok(None),
    };
    let kind = value["header"]["msg_type"].as_str().ok_or_else(|| protocol("missing Jupyter message type"))?.to_owned();
    // The server restarts a kernel that died; its state, and any run, is gone.
    if kind == "status" && matches!(value["content"]["execution_state"].as_str(), Some("restarting" | "dead")) {
        return Err(IdeError::unavailable("the kernel on the Jupyter server died"));
    }
    let parent = value["parent_header"]["msg_id"].as_str().unwrap_or_default().to_owned();
    let permit = queued
        .clone()
        .try_acquire_many_owned(bytes as u32)
        .map_err(|_| IdeError::unavailable("kernel output queue exceeds 16 MiB; execution stopped"))?;
    Ok(Some(Frame { channel, parent, kind, content: value["content"].take(), bytes, _permit: Some(permit) }))
}

/// A message as the channels socket carries it: JSON text naming its channel.
fn encode(mut message: JupyterMessage, channel: jupyter_protocol::Channel) -> IdeResult<String> {
    message.channel = Some(channel);
    let mut value = serde_json::to_value(&message).map_err(protocol)?;
    value["buffers"] = json!([]);
    Ok(value.to_string())
}

impl Link {
    /// A sender for the kernel's control channel, over the same socket.
    pub(super) fn control(&self) -> (mpsc::Sender<JupyterMessage>, JoinHandle<()>) {
        let (tx, mut messages) = mpsc::channel::<JupyterMessage>(16);
        let outgoing = self.outgoing.clone();
        let task = tokio::spawn(async move {
            while let Some(message) = messages.recv().await {
                let Ok(text) = encode(message, jupyter_protocol::Channel::Control) else { continue };
                if outgoing.send(text).await.is_err() {
                    break;
                }
            }
        });
        (tx, task)
    }

    pub(super) async fn send(&mut self, message: JupyterMessage) -> IdeResult<()> {
        let text = encode(message, jupyter_protocol::Channel::Shell)?;
        tokio::time::timeout(SEND_TIMEOUT, self.outgoing.send(text))
            .await
            .map_err(|_| IdeError::unavailable("kernel request send timed out; delivery uncertain, not retried"))?
            .map_err(|_| IdeError::unavailable("the connection to the Jupyter server closed"))
    }

    /// Asks the server to interrupt the kernel, without waiting: the run keeps reading
    /// output meanwhile, and its interrupt deadline covers a server that does not answer.
    pub(super) async fn interrupt(&mut self) -> IdeResult<()> {
        let kernel = self.kernel.clone();
        tokio::spawn(async move {
            let _ =
                call(&kernel.base, &kernel.token, Method::POST, &format!("api/kernels/{}/interrupt", kernel.id), None)
                    .await;
        });
        Ok(())
    }

    /// Deletes the kernel and waits for the server's answer. A server that cannot be
    /// reached keeps it until it culls idle kernels, if it is configured to.
    pub(super) async fn shutdown(&mut self) {
        self.kernel.delete().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls_are_reduced_to_their_base() {
        let base = |text| normalize_server_url(text).unwrap();
        assert_eq!(base("http://localhost:8888"), ("http://localhost:8888/".into(), None));
        assert_eq!(
            base(" http://127.0.0.1:8888/lab?token=abc "),
            ("http://127.0.0.1:8888/".into(), Some("abc".into()))
        );
        assert_eq!(
            base("https://hub.example.com/user/alice/lab"),
            ("https://hub.example.com/user/alice/".into(), None)
        );
        assert_eq!(
            base("https://hub.example.com/user/alice/tree?x=1#y"),
            ("https://hub.example.com/user/alice/".into(), None)
        );
        // A page's path, wherever it ends.
        assert_eq!(base("http://localhost:8888/lab/tree/work/x.ipynb"), ("http://localhost:8888/".into(), None));
        assert_eq!(
            base("http://localhost:8888/notebooks/x.ipynb?token=t"),
            ("http://localhost:8888/".into(), Some("t".into()))
        );
        assert_eq!(base("https://host/jupyter/doc/tree/x.ipynb"), ("https://host/jupyter/".into(), None));
        // A Hub user named like a page keeps the name.
        assert_eq!(base("https://hub.example.com/user/lab/"), ("https://hub.example.com/user/lab/".into(), None));
        assert_eq!(
            base("https://hub.example.com/user/lab/lab/tree/a"),
            ("https://hub.example.com/user/lab/".into(), None)
        );
        assert!(normalize_server_url("file:///tmp").is_err());
        assert!(normalize_server_url("localhost:8888").is_err());
    }

    #[test]
    fn kernel_specs_list_the_default_first() {
        let reply = json!({"default": "python3", "kernelspecs": {
            "ir": {"name": "ir", "spec": {"display_name": "R"}},
            "python3": {"name": "python3", "spec": {"display_name": "Python 3 (ipykernel)"}},
            "julia": {"name": "julia", "spec": {}},
        }});
        let names: Vec<_> = parse_specs(&reply).unwrap().into_iter().map(|s| s.display_name).collect();
        assert_eq!(names, ["Python 3 (ipykernel)", "R", "julia"]);
        assert!(parse_specs(&json!({"message": "not found"})).is_err());
    }

    #[test]
    fn channel_messages_become_frames() {
        let queued = Arc::new(Semaphore::new(1 << 20));
        let reply = json!({"channel": "shell", "header": {"msg_type": "execute_reply"},
            "parent_header": {"msg_id": "run-1"}, "content": {"status": "ok"}});
        let frame = frame(&reply.to_string(), &queued, &DebugPort::default()).unwrap().unwrap();
        assert!(frame.channel == Channel::Shell && frame.parent == "run-1" && frame.kind == "execute_reply");
        assert_eq!(frame.content["status"], "ok");
        let stdin = json!({"channel": "stdin", "header": {"msg_type": "input_request"}});
        assert!(super::frame(&stdin.to_string(), &queued, &DebugPort::default()).unwrap().is_none());
        let died = json!({"channel": "iopub", "header": {"msg_type": "status"}, "parent_header": {},
            "content": {"execution_state": "restarting"}});
        assert!(super::frame(&died.to_string(), &queued, &DebugPort::default()).is_err());
    }
}
