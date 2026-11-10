//! Host-owned background WebSocket connections for plugins.

use super::{
    PluginEvent, PluginEventSink,
    network_inbox::{Inbox, Push},
};
use futures::{SinkExt, StreamExt};
use ide_plugin::{DocumentChanged, WebSocketBatch};
use parking_lot::Mutex;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, watch};
use tokio_tungstenite::{
    Connector, connect_async_tls_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderName, HeaderValue},
        protocol::WebSocketConfig,
    },
};

const MAX_MESSAGES: usize = 256;
const MAX_BYTES: usize = 8 << 20;
const MAX_FRAME: usize = 1 << 20;
const DRAIN_BATCH: usize = 32;
const CLOSED_HANDLE_TTL: Duration = Duration::from_secs(60);
const MAX_CONNECTIONS_PER_PLUGIN: usize = 8;

pub type ConnectionId = u64;

#[derive(Debug, PartialEq, Eq)]
pub enum ConnectError {
    Invalid(String),
    Failed(String),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PublishResult {
    pub accepted: usize,
    pub rejected: usize,
}

struct Connection {
    plugin: String,
    #[allow(dead_code, reason = "read by document subscriptions (#2610)")]
    project: String,
    documents: Mutex<HashSet<String>>,
    outgoing: Arc<Inbox>,
    incoming: Arc<Inbox>,
    wake: Notify,
    stop: watch::Sender<bool>,
}

struct Inner {
    next: AtomicU64,
    connections: Mutex<HashMap<ConnectionId, Arc<Connection>>>,
    pending: Mutex<HashMap<String, usize>>,
    sink: Option<Arc<dyn PluginEventSink>>,
}

#[derive(Clone)]
pub struct WebSocketHub(Arc<Inner>);

impl Default for WebSocketHub {
    fn default() -> Self {
        Self(Arc::new(Inner {
            next: AtomicU64::new(1),
            connections: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            sink: None,
        }))
    }
}

impl WebSocketHub {
    pub fn new(sink: Arc<dyn PluginEventSink>) -> Self {
        Self(Arc::new(Inner {
            next: AtomicU64::new(1),
            connections: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            sink: Some(sink),
        }))
    }

    pub async fn connect(
        &self,
        plugin: &str,
        project: &str,
        url: &str,
        headers: &[(String, String)],
        subprotocol: &str,
        timeout: Duration,
    ) -> Result<ConnectionId, ConnectError> {
        validate_url(url).map_err(ConnectError::Invalid)?;
        if subprotocol.len() > 256 {
            return Err(ConnectError::Invalid("WebSocket subprotocol is too long".into()));
        }
        if timeout.is_zero() {
            return Err(ConnectError::Failed("WebSocket connection timed out".into()));
        }
        self.reserve(plugin)?;
        let result = async {
            let mut request =
                url.into_client_request().map_err(|_| ConnectError::Invalid("invalid WebSocket URL".into()))?;
            for (name, value) in headers {
                if protected_header(name) {
                    return Err(ConnectError::Invalid(format!(
                        "WebSocket header {name:?} is managed by the handshake"
                    )));
                }
                let name: HeaderName =
                    name.parse().map_err(|_| ConnectError::Invalid("invalid WebSocket header name".into()))?;
                let value = HeaderValue::from_str(value)
                    .map_err(|_| ConnectError::Invalid("invalid WebSocket header value".into()))?;
                request.headers_mut().append(name, value);
            }
            if !subprotocol.is_empty() {
                request.headers_mut().insert(
                    "sec-websocket-protocol",
                    subprotocol.parse().map_err(|_| ConnectError::Invalid("invalid WebSocket subprotocol".into()))?,
                );
            }
            let config = WebSocketConfig::default()
                .read_buffer_size(16 << 10)
                .write_buffer_size(16 << 10)
                .max_write_buffer_size(2 << 20)
                .max_message_size(Some(MAX_FRAME))
                .max_frame_size(Some(MAX_FRAME));
            let tls = ide_http::client::tls_config()
                .map(Arc::new)
                .map(Connector::Rustls)
                .map_err(|error| ConnectError::Failed(error.message))?;
            let (socket, response) =
                tokio::time::timeout(timeout, connect_async_tls_with_config(request, Some(config), false, Some(tls)))
                    .await
                    .map_err(|_| ConnectError::Failed("WebSocket connection timed out".into()))?
                    .map_err(|_| ConnectError::Failed("WebSocket connection failed".into()))?;
            if !subprotocol.is_empty()
                && response.headers().get("sec-websocket-protocol").and_then(|value| value.to_str().ok())
                    != Some(subprotocol)
            {
                return Err(ConnectError::Failed("WebSocket server did not accept the required subprotocol".into()));
            }

            let id = self.0.next.fetch_add(1, Ordering::Relaxed);
            let (stop, stopped) = watch::channel(false);
            let connection = Arc::new(Connection {
                plugin: plugin.to_owned(),
                project: project.to_owned(),
                documents: Mutex::new(HashSet::new()),
                outgoing: Arc::new(Inbox::new(MAX_MESSAGES, MAX_BYTES, MAX_FRAME)),
                incoming: Arc::new(Inbox::new(MAX_MESSAGES, MAX_BYTES, MAX_FRAME)),
                wake: Notify::new(),
                stop,
            });
            self.0.connections.lock().insert(id, connection.clone());
            tokio::spawn(run_socket(id, socket, connection, Arc::downgrade(&self.0), stopped));
            Ok(id)
        }
        .await;
        self.release(plugin);
        result
    }

    pub fn send(&self, plugin: &str, connection: ConnectionId, bytes: Vec<u8>) -> Result<(), String> {
        let connection = self.connection(plugin, connection)?;
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

    pub fn subscribe(&self, plugin: &str, connection: ConnectionId, document: &str) -> Result<bool, String> {
        if document.is_empty() || document.len() > 4096 {
            return Err("invalid document id".into());
        }
        let connection = self.connection(plugin, connection)?;
        let inserted = connection.documents.lock().insert(document.to_owned());
        if inserted {
            self.subscriptions_changed();
        }
        Ok(inserted)
    }

    pub fn unsubscribe(&self, plugin: &str, connection: ConnectionId, document: &str) -> Result<bool, String> {
        let connection = self.connection(plugin, connection)?;
        let removed = connection.documents.lock().remove(document);
        if removed {
            self.subscriptions_changed();
        }
        Ok(removed)
    }

    pub fn publish(&self, change: &DocumentChanged) -> PublishResult {
        let connections: Vec<_> = self
            .0
            .connections
            .lock()
            .values()
            .filter(|connection| connection.documents.lock().contains(&change.path))
            .cloned()
            .collect();
        let bytes = match serde_json::to_vec(change) {
            Ok(bytes) if bytes.len() <= MAX_FRAME => bytes,
            _ => return PublishResult { accepted: 0, rejected: connections.len() },
        };
        let mut result = PublishResult::default();
        for connection in connections {
            match connection.outgoing.push(bytes.clone()) {
                Push::Wake => {
                    result.accepted += 1;
                    connection.wake.notify_one();
                }
                Push::Queued => result.accepted += 1,
                Push::OverflowWake => {
                    result.rejected += 1;
                    connection.wake.notify_one();
                }
                Push::OverflowQueued | Push::Closed => result.rejected += 1,
            }
        }
        result
    }

    pub fn drain(&self, plugin: &str, connection: ConnectionId, limit: usize) -> Result<WebSocketBatch, String> {
        if limit == 0 || limit > DRAIN_BATCH {
            return Err("invalid drain limit".into());
        }
        let connection_state = self.connection(plugin, connection)?;
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
        let had_documents = !connection.documents.lock().is_empty();
        connection.outgoing.close();
        let _ = connection.stop.send(true);
        connection.wake.notify_one();
        self.0.connections.lock().remove(&id);
        if had_documents {
            self.subscriptions_changed();
        }
        Ok(())
    }

    pub fn disconnect_plugin(&self, plugin: &str) {
        let removed: Vec<_> = {
            let mut connections = self.0.connections.lock();
            let ids: Vec<_> =
                connections.iter().filter(|(_, connection)| connection.plugin == plugin).map(|(id, _)| *id).collect();
            ids.into_iter().filter_map(|id| connections.remove(&id)).collect()
        };
        let subscriptions_changed = removed.iter().any(|connection| !connection.documents.lock().is_empty());
        for connection in removed {
            connection.outgoing.close();
            let _ = connection.stop.send(true);
            connection.wake.notify_one();
        }
        if subscriptions_changed {
            self.subscriptions_changed();
        }
    }

    pub fn has_subscriptions(&self) -> bool {
        self.0.connections.lock().values().any(|connection| !connection.documents.lock().is_empty())
    }

    /// Returns the project captured when this plugin opened the resource.
    /// Consumers use this instead of accepting a project selected by plugin code.
    #[allow(dead_code, reason = "read by document subscriptions (#2610)")]
    pub fn project(&self, plugin: &str, id: ConnectionId) -> Result<String, String> {
        Ok(self.connection(plugin, id)?.project.clone())
    }

    fn subscriptions_changed(&self) {
        if let Some(sink) = &self.0.sink {
            sink.emit(None, PluginEvent::SubscriptionsChanged);
        }
    }

    fn connection(&self, plugin: &str, id: ConnectionId) -> Result<Arc<Connection>, String> {
        self.0
            .connections
            .lock()
            .get(&id)
            .filter(|connection| connection.plugin == plugin)
            .cloned()
            .ok_or_else(|| "unknown WebSocket connection".into())
    }

    fn reserve(&self, plugin: &str) -> Result<(), ConnectError> {
        let open = self.0.connections.lock().values().filter(|connection| connection.plugin == plugin).count();
        let mut pending = self.0.pending.lock();
        if open + pending.get(plugin).copied().unwrap_or_default() >= MAX_CONNECTIONS_PER_PLUGIN {
            return Err(ConnectError::Invalid("at most 8 WebSocket connections per plugin".into()));
        }
        *pending.entry(plugin.to_owned()).or_default() += 1;
        Ok(())
    }

    fn release(&self, plugin: &str) {
        let mut pending = self.0.pending.lock();
        if let Some(count) = pending.get_mut(plugin) {
            *count -= 1;
            if *count == 0 {
                pending.remove(plugin);
            }
        }
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
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err("WebSocket URLs may not carry credentials or a fragment".into());
    }
    Ok(())
}

fn protected_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("host")
        || name.eq_ignore_ascii_case("connection")
        || name.eq_ignore_ascii_case("upgrade")
        || name.get(.."sec-websocket-".len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case("sec-websocket-"))
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
        let connection = hub
            .connect(
                "plugin",
                "/project",
                &url,
                &[("authorization".into(), "Bearer test".into())],
                "openidea.test.v1",
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        hub.send("plugin", connection, b"message".to_vec()).unwrap();
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
        let connection = hub
            .connect(
                "plugin",
                "/project",
                &url,
                &[("authorization".into(), "Bearer test".into())],
                "openidea.test.v1",
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        server.await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            hub.drain("plugin", connection, 1).unwrap(),
            WebSocketBatch { messages: vec![vec![1, 2, 3]], closed: true }
        );
        assert!(hub.drain("plugin", connection, 1).is_err());
    }

    #[tokio::test]
    async fn document_changes_reach_only_subscribed_connections() {
        let (url, server) = server().await;
        let hub = WebSocketHub::default();
        let connection = hub.connect("plugin", "/project", &url, "Bearer test", "openidea.test.v1").await.unwrap();
        assert!(hub.subscribe("plugin", connection, "/project/a.rs").unwrap());
        assert!(!hub.subscribe("plugin", connection, "/project/a.rs").unwrap());
        let ignored = DocumentChanged { path: "/project/b.rs".into(), base_version: 1, version: 2, changes: vec![] };
        let sent = DocumentChanged { path: "/project/a.rs".into(), base_version: 1, version: 2, changes: vec![] };
        assert_eq!(hub.publish(&ignored), PublishResult::default());
        assert_eq!(hub.publish(&sent), PublishResult { accepted: 1, rejected: 0 });
        assert!(hub.unsubscribe("plugin", connection, "/project/a.rs").unwrap());
        assert_eq!(hub.publish(&sent), PublishResult::default());
        hub.disconnect("plugin", connection).unwrap();
        let messages = server.await.unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(serde_json::from_slice::<DocumentChanged>(&messages[0]).unwrap(), sent);
    }

    #[test]
    fn send_rejects_full_queues_without_reporting_success() {
        let hub = WebSocketHub::default();
        let (stop, _) = watch::channel(false);
        let connection = Arc::new(Connection {
            plugin: "plugin".into(),
            project: "/project".into(),
            documents: Mutex::new(HashSet::new()),
            outgoing: Arc::new(Inbox::new(1, MAX_BYTES, MAX_FRAME)),
            incoming: Arc::new(Inbox::new(1, MAX_BYTES, MAX_FRAME)),
            wake: Notify::new(),
            stop,
        });
        hub.0.connections.lock().insert(1, connection.clone());

        assert!(hub.send("other-plugin", 1, b"cross-plugin".to_vec()).is_err());
        assert!(hub.drain("other-plugin", 1, 1).is_err());
        assert!(hub.send("plugin", 1, b"first".to_vec()).is_ok());
        assert!(hub.send("plugin", 1, b"second".to_vec()).unwrap_err().contains("rejected"));
        assert_eq!(connection.outgoing.drain(1).messages, [b"first"]);
    }

    #[test]
    fn websocket_urls_require_tls_and_keep_credentials_out_of_the_url() {
        assert!(validate_url("wss://relay.example/socket").is_ok());
        assert!(validate_url("wss://relay.example/socket?channel=main&token=opaque").is_ok());
        assert!(validate_url("ws://127.0.0.1:9000/socket").is_ok());
        assert!(validate_url("ws://relay.example/socket").unwrap_err().contains("WSS"));
        assert!(validate_url("wss://token@relay.example/socket").is_err());
        assert!(validate_url("wss://relay.example/socket#fragment").is_err());
        assert!(protected_header("Host"));
        assert!(protected_header("Connection"));
        assert!(protected_header("Upgrade"));
        assert!(protected_header("Sec-WebSocket-Key"));
        assert!(!protected_header("Cookie"));
        assert!(!protected_header("X-API-Key"));
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)] // Required by tungstenite's callback signature.
    async fn optional_subprotocol_and_custom_headers_reach_the_handshake() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/socket?channel=main", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, |request: &Request, response: Response| {
                assert_eq!(request.headers()["cookie"], "session=test");
                assert_eq!(request.headers()["x-api-key"], "key");
                assert!(request.headers().get("sec-websocket-protocol").is_none());
                Ok(response)
            })
            .await
            .unwrap();
            socket.close(None).await.unwrap();
        });
        let hub = WebSocketHub::default();
        let connection = hub
            .connect(
                "plugin",
                "/project",
                &url,
                &[("cookie".into(), "session=test".into()), ("x-api-key".into(), "key".into())],
                "",
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        hub.disconnect("plugin", connection).unwrap();
        server.await.unwrap();
    }

    #[test]
    fn connection_limit_is_enforced_before_connecting() {
        let hub = WebSocketHub::default();
        for _ in 0..MAX_CONNECTIONS_PER_PLUGIN {
            hub.reserve("plugin").unwrap();
        }
        assert_eq!(
            hub.reserve("plugin"),
            Err(ConnectError::Invalid("at most 8 WebSocket connections per plugin".into()))
        );
        for _ in 0..MAX_CONNECTIONS_PER_PLUGIN {
            hub.release("plugin");
        }
    }
}
