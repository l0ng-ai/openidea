//! Host-owned background WebSocket connections for plugins.

use super::{
    PluginEvent, PluginEventSink,
    network_inbox::{Inbox, Push},
};
use futures::{SinkExt, StreamExt};
use ide_plugin::WebSocketBatch;
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

const MAX_MESSAGES: usize = 256;
const MAX_BYTES: usize = 8 << 20;
const MAX_FRAME: usize = 1 << 20;
const DRAIN_BATCH: usize = 32;
const CLOSED_HANDLE_TTL: Duration = Duration::from_secs(60);

pub type ConnectionId = u64;

struct Connection {
    plugin: String,
    project: String,
    outgoing: Arc<Inbox>,
    incoming: Arc<Inbox>,
    wake: Notify,
    stop: watch::Sender<bool>,
}

struct Inner {
    next: AtomicU64,
    connections: Mutex<HashMap<ConnectionId, Arc<Connection>>>,
    sink: Option<Arc<dyn PluginEventSink>>,
}

#[derive(Clone)]
pub struct WebSocketHub(Arc<Inner>);

impl Default for WebSocketHub {
    fn default() -> Self {
        Self(Arc::new(Inner { next: AtomicU64::new(1), connections: Mutex::new(HashMap::new()), sink: None }))
    }
}

impl WebSocketHub {
    pub fn new(sink: Arc<dyn PluginEventSink>) -> Self {
        Self(Arc::new(Inner { next: AtomicU64::new(1), connections: Mutex::new(HashMap::new()), sink: Some(sink) }))
    }

    pub async fn connect(
        &self,
        plugin: &str,
        project: &str,
        url: &str,
        authorization: &str,
        subprotocol: &str,
    ) -> Result<ConnectionId, String> {
        validate_url(url)?;
        if authorization.is_empty() || authorization.len() > 4096 || subprotocol.is_empty() || subprotocol.len() > 256 {
            return Err("invalid WebSocket credentials or subprotocol".into());
        }
        let mut request = url.into_client_request().map_err(|_| "invalid WebSocket URL")?;
        request
            .headers_mut()
            .insert("authorization", authorization.parse().map_err(|_| "invalid authorization header")?);
        request
            .headers_mut()
            .insert("sec-websocket-protocol", subprotocol.parse().map_err(|_| "invalid WebSocket subprotocol")?);
        let config = WebSocketConfig::default()
            .read_buffer_size(16 << 10)
            .write_buffer_size(16 << 10)
            .max_write_buffer_size(2 << 20)
            .max_message_size(Some(MAX_FRAME))
            .max_frame_size(Some(MAX_FRAME));
        let (socket, response) =
            tokio::time::timeout(Duration::from_secs(10), connect_async_with_config(request, Some(config), false))
                .await
                .map_err(|_| "WebSocket connection timed out")?
                .map_err(|_| "WebSocket connection failed")?;
        if response.headers().get("sec-websocket-protocol").and_then(|value| value.to_str().ok()) != Some(subprotocol) {
            return Err("WebSocket server did not accept the required subprotocol".into());
        }

        let id = self.0.next.fetch_add(1, Ordering::Relaxed);
        let (stop, stopped) = watch::channel(false);
        let connection = Arc::new(Connection {
            plugin: plugin.to_owned(),
            project: project.to_owned(),
            outgoing: Arc::new(Inbox::new(MAX_MESSAGES, MAX_BYTES, MAX_FRAME)),
            incoming: Arc::new(Inbox::new(MAX_MESSAGES, MAX_BYTES, MAX_FRAME)),
            wake: Notify::new(),
            stop,
        });
        self.0.connections.lock().insert(id, connection.clone());
        tokio::spawn(run_socket(id, socket, connection, Arc::downgrade(&self.0), stopped));
        Ok(id)
    }

    pub fn send(&self, plugin: &str, project: &str, connection: ConnectionId, bytes: Vec<u8>) -> Result<(), String> {
        let connection = self.connection(plugin, project, connection)?;
        match connection.outgoing.push(bytes) {
            Push::Wake => {
                connection.wake.notify_one();
                Ok(())
            }
            Push::Queued => Ok(()),
            Push::OverflowWake => {
                connection.wake.notify_one();
                Err("WebSocket send queue is full; message was rejected".into())
            }
            Push::OverflowQueued => Err("WebSocket send queue is full; message was rejected".into()),
            Push::Closed => Err("WebSocket connection is closed; message was rejected".into()),
        }
    }

    pub fn drain(
        &self,
        plugin: &str,
        project: &str,
        connection: ConnectionId,
        limit: usize,
    ) -> Result<WebSocketBatch, String> {
        if limit == 0 || limit > DRAIN_BATCH {
            return Err("invalid drain limit".into());
        }
        let connection_state = self.connection(plugin, project, connection)?;
        let batch = connection_state.incoming.drain(limit);
        if batch.more {
            self.emit_ready(connection, plugin);
        }
        if batch.closed && !batch.more {
            self.0.connections.lock().remove(&connection);
        }
        Ok(WebSocketBatch { messages: batch.messages, closed: batch.closed })
    }

    pub fn disconnect(&self, plugin: &str, id: ConnectionId) -> Result<(), String> {
        let connection = self
            .0
            .connections
            .lock()
            .get(&id)
            .filter(|connection| connection.plugin == plugin)
            .cloned()
            .ok_or_else(|| "unknown WebSocket connection".to_owned())?;
        connection.outgoing.close();
        let _ = connection.stop.send(true);
        connection.wake.notify_one();
        self.0.connections.lock().remove(&id);
        Ok(())
    }

    pub fn disconnect_plugin(&self, plugin: &str) {
        let removed: Vec<_> = {
            let mut connections = self.0.connections.lock();
            let ids: Vec<_> =
                connections.iter().filter(|(_, connection)| connection.plugin == plugin).map(|(id, _)| *id).collect();
            ids.into_iter().filter_map(|id| connections.remove(&id)).collect()
        };
        for connection in removed {
            connection.outgoing.close();
            let _ = connection.stop.send(true);
            connection.wake.notify_one();
        }
    }

    fn connection(&self, plugin: &str, project: &str, id: ConnectionId) -> Result<Arc<Connection>, String> {
        self.0
            .connections
            .lock()
            .get(&id)
            .filter(|connection| connection.plugin == plugin && connection.project == project)
            .cloned()
            .ok_or_else(|| "unknown WebSocket connection".into())
    }

    fn emit_ready(&self, connection: ConnectionId, plugin: &str) {
        if let Some(sink) = &self.0.sink {
            sink.emit(None, PluginEvent::WebsocketReady { plugin_id: plugin.to_owned(), connection });
        }
    }
}

fn validate_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "invalid WebSocket URL")?;
    let loopback = parsed.host_str().is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1"));
    if parsed.scheme() != "wss" && !(parsed.scheme() == "ws" && loopback) {
        return Err("WebSocket requires WSS outside loopback".into());
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("WebSocket credentials and query strings are forbidden".into());
    }
    Ok(())
}

async fn run_socket<S>(
    id: ConnectionId,
    socket: tokio_tungstenite::WebSocketStream<S>,
    connection: Arc<Connection>,
    inner: Weak<Inner>,
    mut stopped: watch::Receiver<bool>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut writer, mut reader) = socket.split();
    loop {
        tokio::select! {
            _ = connection.wake.notified() => {
                let batch = connection.outgoing.drain(DRAIN_BATCH);
                let mut failed = false;
                for bytes in batch.messages {
                    if writer.send(Message::Binary(bytes.into())).await.is_err() {
                        failed = true;
                        break;
                    }
                }
                if failed || batch.closed { break; }
                if batch.more { connection.wake.notify_one(); }
            }
            changed = stopped.changed() => {
                if changed.is_err() || *stopped.borrow() {
                    let mut failed = false;
                    loop {
                        let batch = connection.outgoing.drain(DRAIN_BATCH);
                        for bytes in batch.messages {
                            if writer.send(Message::Binary(bytes.into())).await.is_err() {
                                failed = true;
                                break;
                            }
                        }
                        if failed || !batch.more { break; }
                    }
                    break;
                }
            }
            message = reader.next() => match message {
                Some(Ok(Message::Binary(bytes))) => {
                    let pushed = connection.incoming.push(bytes.to_vec());
                    if matches!(pushed, Push::Wake | Push::OverflowWake)
                        && let Some(inner) = inner.upgrade()
                        && let Some(sink) = &inner.sink
                    {
                        sink.emit(None, PluginEvent::WebsocketReady { plugin_id: connection.plugin.clone(), connection: id });
                    }
                    if matches!(pushed, Push::OverflowWake | Push::OverflowQueued | Push::Closed) { break; }
                }
                Some(Ok(Message::Ping(bytes))) => if writer.send(Message::Pong(bytes)).await.is_err() { break; },
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            }
        }
    }
    let _ = writer.close().await;
    connection.outgoing.close();
    let wake = connection.incoming.close();
    if let Some(inner) = inner.upgrade() {
        if wake && let Some(sink) = &inner.sink {
            sink.emit(None, PluginEvent::WebsocketReady { plugin_id: connection.plugin.clone(), connection: id });
        }
        let retained = connection.clone();
        tokio::spawn(async move {
            tokio::time::sleep(CLOSED_HANDLE_TTL).await;
            let mut connections = inner.connections.lock();
            if connections.get(&id).is_some_and(|current| Arc::ptr_eq(current, &retained)) {
                connections.remove(&id);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{ErrorResponse, Request, Response},
    };

    #[allow(clippy::result_large_err)] // Required by tungstenite's callback signature.
    fn accept_test_protocol(request: &Request, mut response: Response) -> Result<Response, ErrorResponse> {
        assert_eq!(request.headers()["authorization"], "Bearer test");
        assert_eq!(request.headers()["sec-websocket-protocol"], "openidea.test.v1");
        response.headers_mut().insert("sec-websocket-protocol", "openidea.test.v1".parse().unwrap());
        Ok(response)
    }

    async fn server() -> (String, tokio::task::JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/socket", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let socket = accept_hdr_async(stream, accept_test_protocol).await.unwrap();
            let (_, mut reader) = socket.split();
            let mut messages = Vec::new();
            while let Ok(Some(message)) = tokio::time::timeout(Duration::from_secs(2), reader.next()).await {
                match message.unwrap() {
                    Message::Binary(bytes) => messages.push(bytes.to_vec()),
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            messages
        });
        (url, task)
    }

    #[tokio::test]
    async fn outbound_message_reaches_the_websocket_server() {
        let (url, server) = server().await;
        let hub = WebSocketHub::default();
        let connection = hub.connect("plugin", "/project", &url, "Bearer test", "openidea.test.v1").await.unwrap();
        hub.send("plugin", "/project", connection, b"message".to_vec()).unwrap();
        hub.disconnect("plugin", connection).unwrap();
        assert_eq!(server.await.unwrap(), [b"message"]);
    }

    #[tokio::test]
    async fn inbound_messages_can_be_drained_and_disconnect_cleans_the_handle() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/socket", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, accept_test_protocol).await.unwrap();
            socket.send(Message::Binary(vec![1, 2, 3].into())).await.unwrap();
            socket.close(None).await.unwrap();
        });
        let hub = WebSocketHub::default();
        let connection = hub.connect("plugin", "/project", &url, "Bearer test", "openidea.test.v1").await.unwrap();
        server.await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            hub.drain("plugin", "/project", connection, 1).unwrap(),
            WebSocketBatch { messages: vec![vec![1, 2, 3]], closed: true }
        );
        assert!(hub.drain("plugin", "/project", connection, 1).is_err());
    }

    #[test]
    fn send_rejects_full_queues_without_reporting_success() {
        let hub = WebSocketHub::default();
        let (stop, _) = watch::channel(false);
        let connection = Arc::new(Connection {
            plugin: "plugin".into(),
            project: "/project".into(),
            outgoing: Arc::new(Inbox::new(1, MAX_BYTES, MAX_FRAME)),
            incoming: Arc::new(Inbox::new(1, MAX_BYTES, MAX_FRAME)),
            wake: Notify::new(),
            stop,
        });
        hub.0.connections.lock().insert(1, connection.clone());

        assert!(hub.send("plugin", "/other-project", 1, b"cross-project".to_vec()).is_err());
        assert!(hub.drain("plugin", "/other-project", 1, 1).is_err());
        assert!(hub.send("plugin", "/project", 1, b"first".to_vec()).is_ok());
        assert!(hub.send("plugin", "/project", 1, b"second".to_vec()).unwrap_err().contains("rejected"));
        assert_eq!(connection.outgoing.drain(1).messages, [b"first"]);
    }

    #[test]
    fn websocket_urls_require_tls_and_keep_credentials_out_of_the_url() {
        assert!(validate_url("wss://relay.example/socket").is_ok());
        assert!(validate_url("ws://127.0.0.1:9000/socket").is_ok());
        assert!(validate_url("ws://relay.example/socket").unwrap_err().contains("WSS"));
        assert!(validate_url("wss://token@relay.example/socket").is_err());
        assert!(validate_url("wss://relay.example/socket?token=x").is_err());
    }
}
