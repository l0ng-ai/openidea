//! A kernel on a Jupyter server (`jupyter server`, JupyterLab, a JupyterHub user server):
//! REST calls start, interrupt and delete it, and its messages go over the kernel's
//! channels WebSocket as JSON text frames.
use super::{Channel, Failure, Frame, MAX_MESSAGE_BYTES, SEND_TIMEOUT, protocol};
use crate::kernel::RemoteKernel;
use futures::SinkExt;
use futures::stream::{SplitSink, StreamExt};
use ide_core::{IdeError, IdeResult};
use jupyter_protocol::JupyterMessage;
use reqwest::Method;
use serde::Serialize;
use serde_json::{Value, json};
use specta::Type;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Message, http::HeaderValue};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A kernel spec a Jupyter server offers.
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KernelSpec {
    pub name: String,
    pub display_name: String,
}

/// The server's base URL (`http(s)://host[:port]/[prefix/]`) from what a user pastes, and
/// the `?token=` it carries. A trailing `lab` or `tree` (JupyterLab / Notebook pages) is
/// dropped, so a URL copied from the browser works.
pub fn normalize_server_url(text: &str) -> IdeResult<(String, Option<String>)> {
    let invalid = || IdeError::invalid("enter the Jupyter server's http:// or https:// URL");
    let mut url = reqwest::Url::parse(text.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(invalid());
    }
    let token = url.query_pairs().find(|(key, _)| key == "token").map(|(_, value)| value.into_owned());
    let mut segments: Vec<String> =
        url.path_segments().into_iter().flatten().filter(|s| !s.is_empty()).map(str::to_owned).collect();
    if segments.last().is_some_and(|last| last == "lab" || last == "tree") {
        segments.pop();
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
    let mut request = client.request(method, format!("{base}{path}")).timeout(REQUEST_TIMEOUT);
    if !token.is_empty() {
        request = request.header(reqwest::header::AUTHORIZATION, format!("token {token}"));
    }
    if let Some(body) = body {
        request = request.header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_string());
    }
    let response = request.send().await.map_err(|error| {
        IdeError::unavailable(format!("could not reach the Jupyter server: {}", ide_http::client::describe(&error)))
    })?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(IdeError::unavailable("the Jupyter server did not accept the token"));
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

pub(crate) struct Link {
    base: String,
    token: String,
    id: String,
    sink: SplitSink<Socket, Message>,
}

/// Starts a kernel of `kernel.spec` and connects to its channels; frames go to `tx` like
/// a local kernel's ZeroMQ frames.
pub(super) async fn connect(
    kernel: &RemoteKernel,
    tx: mpsc::Sender<Frame>,
    failure: Failure,
    queued: Arc<Semaphore>,
) -> IdeResult<(Link, JoinHandle<()>)> {
    let RemoteKernel { base, token, spec } = kernel;
    let started = call(base, token, Method::POST, "api/kernels", Some(json!({ "name": spec }))).await?;
    let id = started["id"].as_str().ok_or_else(|| protocol("kernel start reply has no id"))?.to_owned();
    let socket = match open_channels(base, token, &id).await {
        Ok(socket) => socket,
        Err(error) => {
            let _ = call(base, token, Method::DELETE, &format!("api/kernels/{id}"), None).await;
            return Err(error);
        }
    };
    let (sink, mut stream) = socket.split();
    let reader = tokio::spawn(async move {
        while let Some(message) = stream.next().await {
            let text = match message {
                Ok(Message::Text(text)) => text,
                Ok(Message::Close(_)) | Err(_) => break,
                // Binary frames carry messages with buffers (widgets), which notebooks do not show.
                Ok(_) => continue,
            };
            match frame(text.as_str(), &queued) {
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
        failure.fail(IdeError::unavailable("the connection to the Jupyter server closed"));
    });
    Ok((Link { base: base.clone(), token: token.clone(), id, sink }, reader))
}

async fn open_channels(base: &str, token: &str, id: &str) -> IdeResult<Socket> {
    let ws = base.replacen("http", "ws", 1);
    let session = uuid::Uuid::new_v4();
    let mut request = format!("{ws}api/kernels/{id}/channels?session_id={session}")
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
    let (socket, _) = tokio::time::timeout(
        REQUEST_TIMEOUT,
        connect_async_tls_with_config(request, Some(config), false, Some(connector)),
    )
    .await
    .map_err(|_| IdeError::unavailable("connecting to the kernel's channels on the Jupyter server timed out"))?
    .map_err(|error| IdeError::unavailable(format!("could not connect to the kernel's channels: {error}")))?;
    Ok(socket)
}

/// One JSON message from the channels socket; `None` for channels notebooks do not use.
fn frame(text: &str, queued: &Arc<Semaphore>) -> IdeResult<Option<Frame>> {
    let bytes = text.len();
    if bytes > MAX_MESSAGE_BYTES {
        return Err(IdeError::unavailable("kernel message exceeds 8 MiB limit; execution stopped"));
    }
    let mut value: Value = serde_json::from_str(text).map_err(protocol)?;
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

impl Link {
    pub(super) async fn send(&mut self, mut message: JupyterMessage) -> IdeResult<()> {
        message.channel = Some(jupyter_protocol::Channel::Shell);
        let mut value = serde_json::to_value(&message).map_err(protocol)?;
        value["buffers"] = json!([]);
        tokio::time::timeout(SEND_TIMEOUT, self.sink.send(Message::Text(value.to_string().into())))
            .await
            .map_err(|_| IdeError::unavailable("kernel request send timed out; delivery uncertain, not retried"))?
            .map_err(|error| IdeError::unavailable(format!("Jupyter server: {error}")))
    }

    pub(super) async fn interrupt(&mut self) -> IdeResult<()> {
        call(&self.base, &self.token, Method::POST, &format!("api/kernels/{}/interrupt", self.id), None)
            .await
            .map(|_| ())
    }

    pub(super) async fn shutdown(&mut self) {
        let _ = tokio::time::timeout(Duration::from_millis(500), self.sink.close()).await;
        // Best effort: a server that cannot be reached culls the kernel itself, if configured to.
        let _ = call(&self.base, &self.token, Method::DELETE, &format!("api/kernels/{}", self.id), None).await;
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
        let frame = frame(&reply.to_string(), &queued).unwrap().unwrap();
        assert!(frame.channel == Channel::Shell && frame.parent == "run-1" && frame.kind == "execute_reply");
        assert_eq!(frame.content["status"], "ok");
        let stdin = json!({"channel": "stdin", "header": {"msg_type": "input_request"}});
        assert!(super::frame(&stdin.to_string(), &queued).unwrap().is_none());
        let died = json!({"channel": "iopub", "header": {"msg_type": "status"}, "parent_header": {},
            "content": {"execution_state": "restarting"}});
        assert!(super::frame(&died.to_string(), &queued).is_err());
    }
}
