// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/impl/McpSessionHandler.kt), Apache-2.0.
//! One client session: what it declared at `initialize`, its roots, the stream the
//! server writes notifications and its own requests to, and those requests' answers.
//!
//! A message for the client goes out on the SSE stream of the POST it belongs to when
//! that POST is answered with one, else on the session's stream (a streamable HTTP GET,
//! or the legacy `/sse` stream). Without either, notifications are dropped and requests
//! fail with [`RequestError::NoChannel`] so the caller can fall back.

use ide_core::CancellationToken;
use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

/// Where JSON-RPC messages for the client go: an SSE stream's writer.
pub(crate) type Outbound = mpsc::UnboundedSender<Value>;

/// How long the client gets to list its roots.
pub(crate) const ROOTS_TIMEOUT: Duration = Duration::from_secs(30);

/// What the client told about itself at `initialize`.
#[derive(Clone, Debug, Default)]
pub(crate) struct ClientInfo {
    pub name: String,
    pub version: String,
    /// The negotiated protocol revision.
    pub protocol: String,
    /// It answers `roots/list`.
    pub roots: bool,
    /// It answers `elicitation/create`.
    pub elicitation: bool,
}

#[derive(Default)]
struct Roots {
    /// The URIs of the last `roots/list` answer.
    known: Option<Vec<String>>,
    /// The client said they changed (or never listed them yet).
    stale: bool,
    fetching: bool,
}

/// Why a request to the client got no result.
#[derive(Debug)]
pub(crate) enum RequestError {
    /// No stream reaches the client.
    NoChannel,
    /// The client answered with a JSON-RPC error.
    Rejected(Value),
    Timeout,
    Cancelled,
    /// The session ended first.
    Closed,
}

pub(crate) struct Session {
    pub id: String,
    pub created: Instant,
    /// Opened by `GET /sse`: every message for the client goes out on that stream.
    pub legacy: bool,
    /// The project path header of the request that opened the session.
    pub project_header: Option<String>,
    pub client: RwLock<ClientInfo>,
    roots: Mutex<Roots>,
    /// The open notification stream and its generation (a newer one replaces it).
    stream: Mutex<Option<(u64, Outbound)>>,
    generation: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, Value>>>>,
    next_request: AtomicU64,
    /// Whether the last `tools/list` left `projectPath` out of the schemas.
    pub advertised_stripped: Mutex<Option<bool>>,
    /// Cancelled when the session ends; its streams end with it.
    pub closed: CancellationToken,
}

impl Session {
    pub fn new(id: String, legacy: bool, project_header: Option<String>) -> Self {
        Self {
            id,
            created: Instant::now(),
            legacy,
            project_header,
            client: RwLock::default(),
            roots: Mutex::default(),
            stream: Mutex::default(),
            generation: AtomicU64::new(0),
            pending: Mutex::default(),
            next_request: AtomicU64::new(1),
            advertised_stripped: Mutex::default(),
            closed: CancellationToken::new(),
        }
    }

    pub fn client_name(&self) -> String {
        self.client.read().name.clone()
    }

    pub fn close(&self) {
        self.closed.cancel();
        *self.stream.lock() = None;
        // Dropping the senders fails the waiting requests.
        self.pending.lock().clear();
    }

    /// Opens the notification stream; `None` while another one is open.
    pub fn open_stream(&self) -> Option<(u64, mpsc::UnboundedReceiver<Value>)> {
        let mut stream = self.stream.lock();
        if stream.as_ref().is_some_and(|(_, tx)| !tx.is_closed()) {
            return None;
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::unbounded_channel();
        *stream = Some((generation, tx));
        Some((generation, rx))
    }

    /// The stream of `generation` ended.
    pub fn stream_closed(&self, generation: u64) {
        let mut stream = self.stream.lock();
        if stream.as_ref().is_some_and(|(g, _)| *g == generation) {
            *stream = None;
        }
    }

    pub fn has_stream(&self) -> bool {
        self.stream.lock().as_ref().is_some_and(|(_, tx)| !tx.is_closed())
    }

    /// Sends `message` on `via`, else on the notification stream; false when neither takes it.
    pub fn send(&self, via: Option<&Outbound>, message: Value) -> bool {
        let message = match via {
            Some(v) => match v.send(message) {
                Ok(()) => return true,
                Err(mpsc::error::SendError(m)) => m,
            },
            None => message,
        };
        self.send_on_stream(message)
    }

    fn send_on_stream(&self, message: Value) -> bool {
        let stream = self.stream.lock();
        stream.as_ref().is_some_and(|(_, tx)| tx.send(message).is_ok())
    }

    /// A notification for the client; dropped when no stream reaches it.
    pub fn notify(&self, via: Option<&Outbound>, method: &str, params: Value) -> bool {
        self.send(via, json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    /// Sends a request to the client and waits for its answer.
    pub async fn request(
        &self,
        via: Option<&Outbound>,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Value, RequestError> {
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let key = Value::from(id).to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(key.clone(), tx);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if !self.send(via, message) {
            self.pending.lock().remove(&key);
            return Err(RequestError::NoChannel);
        }
        let outcome = tokio::select! {
            r = rx => match r {
                Ok(Ok(result)) => Ok(result),
                Ok(Err(error)) => Err(RequestError::Rejected(error)),
                Err(_) => Err(RequestError::Closed),
            },
            _ = tokio::time::sleep(timeout) => Err(RequestError::Timeout),
            _ = cancel.cancelled() => Err(RequestError::Cancelled),
            _ = self.closed.cancelled() => Err(RequestError::Closed),
        };
        self.pending.lock().remove(&key);
        outcome
    }

    /// The client's answer to one of our requests.
    pub fn answer(&self, id: &Value, outcome: Result<Value, Value>) {
        if let Some(tx) = self.pending.lock().remove(&id.to_string()) {
            let _ = tx.send(outcome);
        }
    }

    // --- roots ---------------------------------------------------------------

    /// The last roots the client listed.
    pub fn roots(&self) -> Vec<String> {
        self.roots.lock().known.clone().unwrap_or_default()
    }

    /// The client has roots and their current list is not known.
    pub fn roots_wanted(&self) -> bool {
        self.client.read().roots && {
            let roots = self.roots.lock();
            roots.stale || roots.known.is_none()
        }
    }

    pub fn roots_changed(&self) {
        self.roots.lock().stale = true;
    }

    /// Starts a background fetch unless one runs; false if one already does.
    pub fn begin_fetch(&self) -> bool {
        let mut roots = self.roots.lock();
        !std::mem::replace(&mut roots.fetching, true)
    }

    pub fn end_fetch(&self) {
        self.roots.lock().fetching = false;
    }

    /// Asks the client for its roots; true when they were stored.
    pub async fn fetch_roots(&self, via: Option<&Outbound>, timeout: Duration) -> bool {
        let never = CancellationToken::new();
        // Cleared first: a change notified while the request runs makes it stale again.
        self.roots.lock().stale = false;
        match self.request(via, "roots/list", json!({}), timeout, &never).await {
            Ok(result) => {
                let uris = result
                    .get("roots")
                    .and_then(Value::as_array)
                    .map(|roots| roots.iter().filter_map(|r| r.get("uri")?.as_str().map(str::to_owned)).collect())
                    .unwrap_or_default();
                tracing::trace!("MCP session {}: roots {uris:?}", self.id);
                self.roots.lock().known = Some(uris);
                true
            }
            Err(e) => {
                tracing::debug!("MCP session {}: no roots ({e:?})", self.id);
                self.roots.lock().stale = true;
                false
            }
        }
    }
}

/// Keeps a session id → session map bounded and closes what leaves it.
pub(crate) fn insert(sessions: &mut HashMap<String, Arc<Session>>, session: Arc<Session>, max: usize) {
    while sessions.len() >= max {
        let Some(oldest) = sessions.iter().min_by_key(|(_, s)| s.created).map(|(k, _)| k.clone()) else { break };
        if let Some(s) = sessions.remove(&oldest) {
            s.close();
        }
    }
    sessions.insert(session.id.clone(), session);
}
