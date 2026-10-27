//! Transport shared by the LSP and DAP clients.
//!
//! * [`framing`]: `Content-Length` header framing over any async byte stream
//!   (used by both protocols), and newline-delimited JSON ([`Framing::Lines`],
//!   the Agent Client Protocol).
//! * [`Peer`]: a JSON-RPC 2.0 endpoint with request/response correlation,
//!   cancellation (`$/cancelRequest`) and handlers for server→client traffic.

pub mod framing {
    use std::io::{Error, ErrorKind};
    use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    /// Upper bound for one message body; anything larger is treated as a corrupt stream.
    pub const MAX_MESSAGE_LEN: usize = 256 * 1024 * 1024;
    /// Upper bound for one header line.
    const MAX_HEADER_LINE: u64 = 8 * 1024;

    /// Reads one framed message body.
    ///
    /// Returns `Ok(None)` on a clean EOF between messages. Header names are
    /// matched case-insensitively, unknown headers (e.g. `Content-Type`) are
    /// ignored, and both `\r\n` and bare `\n` line endings are accepted.
    pub async fn read_message<R: AsyncBufRead + Unpin>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
        let mut content_length: Option<usize> = None;
        let mut saw_any = false;
        let mut line = Vec::with_capacity(64);
        loop {
            line.clear();
            let n = (&mut *reader).take(MAX_HEADER_LINE).read_until(b'\n', &mut line).await?;
            if n == 0 {
                if saw_any {
                    return Err(Error::new(ErrorKind::UnexpectedEof, "EOF inside message header"));
                }
                return Ok(None);
            }
            if line.last() != Some(&b'\n') {
                if n as u64 >= MAX_HEADER_LINE {
                    return Err(Error::new(ErrorKind::InvalidData, "header line too long"));
                }
                return Err(Error::new(ErrorKind::UnexpectedEof, "EOF inside message header"));
            }
            let text = trim_line(&line);
            if text.is_empty() {
                if content_length.is_some() {
                    break;
                }
                if saw_any {
                    return Err(Error::new(ErrorKind::InvalidData, "message header without Content-Length"));
                }
                // Tolerate stray blank lines between messages.
                continue;
            }
            saw_any = true;
            let text = std::str::from_utf8(text).map_err(|_| Error::new(ErrorKind::InvalidData, "non-UTF-8 header"))?;
            let Some((name, value)) = text.split_once(':') else {
                return Err(Error::new(ErrorKind::InvalidData, format!("malformed header line: {text:?}")));
            };
            if name.trim().eq_ignore_ascii_case("content-length") {
                let len: usize = value
                    .trim()
                    .parse()
                    .map_err(|_| Error::new(ErrorKind::InvalidData, format!("invalid Content-Length: {value:?}")))?;
                if len > MAX_MESSAGE_LEN {
                    return Err(Error::new(ErrorKind::InvalidData, format!("message too large: {len} bytes")));
                }
                content_length = Some(len);
            }
        }
        let len = content_length.unwrap_or_default();
        let mut body = vec![0u8; len];
        reader.read_exact(&mut body).await?;
        Ok(Some(body))
    }

    fn trim_line(line: &[u8]) -> &[u8] {
        let mut end = line.len();
        while end > 0 && matches!(line[end - 1], b'\n' | b'\r') {
            end -= 1;
        }
        &line[..end]
    }

    /// Writes one framed message and flushes once.
    pub async fn write_message<W: AsyncWrite + Unpin>(writer: &mut W, body: &[u8]) -> std::io::Result<()> {
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut buf = Vec::with_capacity(header.len() + body.len());
        buf.extend_from_slice(header.as_bytes());
        buf.extend_from_slice(body);
        writer.write_all(&buf).await?;
        writer.flush().await
    }

    /// Reads one newline-terminated message, skipping blank lines.
    pub async fn read_line_message<R: AsyncBufRead + Unpin>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = (&mut *reader).take(MAX_MESSAGE_LEN as u64 + 1).read_until(b'\n', &mut line).await?;
            if n == 0 {
                return Ok(None);
            }
            if line.len() > MAX_MESSAGE_LEN {
                return Err(Error::new(ErrorKind::InvalidData, "message too large"));
            }
            let text = trim_line(&line);
            if !text.iter().all(u8::is_ascii_whitespace) {
                return Ok(Some(text.to_vec()));
            }
        }
    }

    /// Writes one message followed by `\n` and flushes once.
    pub async fn write_line_message<W: AsyncWrite + Unpin>(writer: &mut W, body: &[u8]) -> std::io::Result<()> {
        let mut buf = Vec::with_capacity(body.len() + 1);
        buf.extend_from_slice(body);
        buf.push(b'\n');
        writer.write_all(&buf).await?;
        writer.flush().await
    }
}

use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("server error {code}: {message}")]
    Server { code: i64, message: String, data: Option<Value> },
    #[error("request cancelled")]
    Cancelled,
    #[error("connection closed")]
    Closed,
    #[error("timed out")]
    Timeout,
    #[error("invalid message: {0}")]
    Protocol(String),
}

impl From<RpcError> for ide_core::IdeError {
    fn from(e: RpcError) -> Self {
        use ide_core::error::ErrorKind;
        let kind = match e {
            RpcError::Cancelled => ErrorKind::Cancelled,
            RpcError::Closed => ErrorKind::Unavailable,
            _ => ErrorKind::Protocol,
        };
        ide_core::IdeError::new(kind, e.to_string())
    }
}

/// Standard JSON-RPC / LSP error codes.
pub mod codes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// LSP `ServerCancelled`.
    pub const SERVER_CANCELLED: i64 = -32802;
    /// LSP `ContentModified`.
    pub const CONTENT_MODIFIED: i64 = -32801;
    /// LSP `RequestCancelled`.
    pub const REQUEST_CANCELLED: i64 = -32800;
}

/// Handles messages initiated by the remote side.
///
/// Calls run on blocking-capable threads, never on the reader task, so a slow
/// handler cannot stall response delivery. Notifications are delivered one at
/// a time in arrival order; requests run concurrently.
pub trait Handler: Send + Sync + 'static {
    fn on_notification(&self, method: &str, params: Value);
    /// Respond to a server→client request (e.g. `workspace/configuration`).
    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)>;
}

/// A [`Handler`] that ignores notifications and rejects requests.
pub struct NoopHandler;

impl Handler for NoopHandler {
    fn on_notification(&self, _: &str, _: Value) {}
    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((codes::METHOD_NOT_FOUND, format!("unhandled method {method}")))
    }
}

type Pending = HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>;

struct Inner {
    out: mpsc::UnboundedSender<Vec<u8>>,
    pending: Mutex<Pending>,
    next_id: AtomicI64,
    /// Set once the transport is gone; new requests fail fast.
    transport_closed: AtomicBool,
    /// `None` while open; `Some(exit code)` once fully closed.
    closed: watch::Sender<Option<Option<i32>>>,
    /// Fired by [`Peer::kill`]; stops tasks and kills the child.
    kill: CancellationToken,
    pid: Option<u32>,
}

impl Inner {
    fn send_value(&self, value: &Value) -> Result<(), RpcError> {
        if self.transport_closed.load(Ordering::Acquire) {
            return Err(RpcError::Closed);
        }
        let body = serde_json::to_vec(value).map_err(|e| RpcError::Protocol(e.to_string()))?;
        tracing::trace!(target: "ide_jsonrpc::wire", "--> {}", String::from_utf8_lossy(&body));
        self.out.send(body).map_err(|_| RpcError::Closed)
    }

    /// Fails every in-flight request and refuses new ones.
    fn close_transport(&self) {
        self.transport_closed.store(true, Ordering::Release);
        let pending = std::mem::take(&mut *self.pending.lock());
        for (_, tx) in pending {
            let _ = tx.send(Err(RpcError::Closed));
        }
    }

    fn mark_closed(&self, code: Option<i32>) {
        self.close_transport();
        self.closed.send_if_modified(|state| {
            if state.is_none() {
                *state = Some(code);
                true
            } else {
                false
            }
        });
    }
}

/// How messages are delimited on the wire.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Framing {
    /// `Content-Length` headers (LSP, DAP).
    #[default]
    ContentLength,
    /// One JSON message per line (Agent Client Protocol).
    Lines,
}

impl Framing {
    async fn read<R: tokio::io::AsyncBufRead + Unpin>(self, reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
        match self {
            Framing::ContentLength => framing::read_message(reader).await,
            Framing::Lines => framing::read_line_message(reader).await,
        }
    }

    async fn write<W: AsyncWrite + Unpin>(self, writer: &mut W, body: &[u8]) -> std::io::Result<()> {
        match self {
            Framing::ContentLength => framing::write_message(writer, body).await,
            Framing::Lines => framing::write_line_message(writer, body).await,
        }
    }
}

/// A connected JSON-RPC peer. Cloning shares the connection.
#[derive(Clone)]
pub struct Peer {
    inner: Arc<Inner>,
    _owner: Arc<KillOnDrop>,
}

/// Tears the connection down once the last [`Peer`] clone is dropped.
struct KillOnDrop(CancellationToken);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl Peer {
    /// Spawns `command` and speaks JSON-RPC over its stdio. Stderr lines are
    /// forwarded to `tracing` and to `on_stderr`.
    ///
    /// Must be called from within a Tokio runtime.
    pub fn spawn(
        command: &str,
        args: &[String],
        cwd: &std::path::Path,
        env: &[(String, String)],
        handler: Arc<dyn Handler>,
        on_stderr: Box<dyn Fn(String) + Send + Sync>,
    ) -> std::io::Result<Self> {
        Self::spawn_framed(command, args, cwd, env, handler, on_stderr, Framing::ContentLength)
    }

    /// [`spawn`](Self::spawn) with the given wire framing.
    pub fn spawn_framed(
        command: &str,
        args: &[String],
        cwd: &std::path::Path,
        env: &[(String, String)],
        handler: Arc<dyn Handler>,
        on_stderr: Box<dyn Fn(String) + Send + Sync>,
        framing: Framing,
    ) -> std::io::Result<Self> {
        use std::process::Stdio;
        let mut cmd = tokio::process::Command::new(command);
        ide_core::process::no_window(cmd.as_std_mut());
        cmd.args(args)
            .current_dir(cwd)
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("child stdin unavailable"))?;
        let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("child stdout unavailable"))?;
        let stderr = child.stderr.take();
        let pid = child.id();

        let peer = Self::start(stdout, stdin, handler, false, pid, framing);

        if let Some(stderr) = stderr {
            let name = command.to_owned();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = Vec::new();
                loop {
                    line.clear();
                    match reader.read_until(b'\n', &mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let text = String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']).to_owned();
                            tracing::debug!(target: "ide_jsonrpc::stderr", "[{name}] {text}");
                            on_stderr(text);
                        }
                    }
                }
            });
        }

        peer.supervise(child);
        Ok(peer)
    }

    /// Kills `child` when the connection is torn down; closes the connection when it exits.
    fn supervise(&self, mut child: tokio::process::Child) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let status = tokio::select! {
                status = child.wait() => status.ok(),
                _ = inner.kill.cancelled() => {
                    let _ = child.start_kill();
                    child.wait().await.ok()
                }
            };
            inner.mark_closed(status.and_then(|s| s.code()));
        });
    }

    /// Speaks JSON-RPC over arbitrary byte streams (in-memory pipes in tests, TCP sockets).
    /// The connection is considered closed when `reader` reaches EOF.
    ///
    /// Must be called from within a Tokio runtime.
    pub fn connect<R, W>(reader: R, writer: W, handler: Arc<dyn Handler>) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::start(reader, writer, handler, true, None, Framing::ContentLength)
    }

    /// [`connect`](Self::connect) with the given wire framing.
    pub fn connect_framed<R, W>(reader: R, writer: W, handler: Arc<dyn Handler>, framing: Framing) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::start(reader, writer, handler, true, None, framing)
    }

    /// [`Peer::connect`] over streams served by `child` (a server reached over a socket
    /// it listens on): the child is killed with the connection, and its exit closes it.
    ///
    /// Must be called from within a Tokio runtime.
    pub fn connect_with_child<R, W>(
        reader: R,
        writer: W,
        handler: Arc<dyn Handler>,
        child: tokio::process::Child,
    ) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let peer = Self::start(reader, writer, handler, true, child.id(), Framing::ContentLength);
        peer.supervise(child);
        peer
    }

    fn start<R, W>(
        reader: R,
        mut writer: W,
        handler: Arc<dyn Handler>,
        close_on_eof: bool,
        pid: Option<u32>,
        framing: Framing,
    ) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (closed, _) = watch::channel(None);
        let inner = Arc::new(Inner {
            out: out_tx,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            transport_closed: AtomicBool::new(false),
            closed,
            kill: CancellationToken::new(),
            pid,
        });

        // Writer: a single task drains the queue so messages never interleave.
        {
            let kill = inner.kill.clone();
            let weak = Arc::downgrade(&inner);
            tokio::spawn(async move {
                loop {
                    let body = tokio::select! {
                        body = out_rx.recv() => body,
                        _ = kill.cancelled() => None,
                    };
                    let Some(body) = body else { break };
                    if let Err(e) = framing.write(&mut writer, &body).await {
                        tracing::debug!("jsonrpc write failed: {e}");
                        if let Some(inner) = weak.upgrade() {
                            inner.close_transport();
                        }
                        break;
                    }
                }
                let _ = tokio::io::AsyncWriteExt::shutdown(&mut writer).await;
            });
        }

        // Notifications are delivered in order on a dedicated thread.
        let (notif_tx, notif_rx) = std::sync::mpsc::channel::<(String, Value)>();
        {
            let handler = handler.clone();
            std::thread::Builder::new()
                .name("jsonrpc-notify".into())
                .spawn(move || {
                    while let Ok((method, params)) = notif_rx.recv() {
                        let h = handler.clone();
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            h.on_notification(&method, params)
                        }));
                        if result.is_err() {
                            tracing::error!("jsonrpc notification handler panicked on {method}");
                        }
                    }
                })
                .expect("spawn jsonrpc notification thread");
        }

        // Reader: parses and dispatches; never runs handler code itself.
        {
            let inner = inner.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(reader);
                loop {
                    let msg = tokio::select! {
                        msg = framing.read(&mut reader) => msg,
                        _ = inner.kill.cancelled() => break,
                    };
                    match msg {
                        Ok(Some(body)) => dispatch(&inner, &handler, &notif_tx, &body),
                        Ok(None) => break,
                        Err(e) => {
                            tracing::warn!("jsonrpc read failed: {e}");
                            break;
                        }
                    }
                }
                inner.close_transport();
                if close_on_eof || inner.kill.is_cancelled() {
                    inner.mark_closed(None);
                    inner.kill.cancel();
                } else {
                    // The process closed stdout; give it a moment to exit on its own.
                    let kill = inner.kill.clone();
                    let mut rx = inner.closed.subscribe();
                    tokio::spawn(async move {
                        let exited =
                            tokio::time::timeout(std::time::Duration::from_secs(5), rx.wait_for(|s| s.is_some()));
                        if exited.await.is_err() {
                            kill.cancel();
                        }
                    });
                }
            });
        }

        let owner = Arc::new(KillOnDrop(inner.kill.clone()));
        Self { inner, _owner: owner }
    }

    /// Sends a request; dropping the future or cancelling `cancel` sends `$/cancelRequest`.
    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
        cancel: Option<ide_core::CancellationToken>,
    ) -> Result<R, RpcError> {
        if cancel.as_ref().is_some_and(|t| t.is_cancelled()) {
            return Err(RpcError::Cancelled);
        }
        let params = serde_json::to_value(params).map_err(|e| RpcError::Protocol(e.to_string()))?;
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().insert(id, tx);
        let mut guard = PendingGuard { inner: &self.inner, id, armed: true };

        let mut msg = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if !params.is_null() {
            msg["params"] = params;
        }
        if let Err(e) = self.inner.send_value(&msg) {
            guard.armed = false;
            self.inner.pending.lock().remove(&id);
            return Err(e);
        }

        let response = match cancel {
            // Cancellation wins over a response arriving at the same time.
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => return Err(RpcError::Cancelled), // guard sends $/cancelRequest
                r = rx => r,
            },
            None => rx.await,
        };
        guard.armed = false;
        let value = response.map_err(|_| RpcError::Closed)??;
        serde_json::from_value(value).map_err(|e| RpcError::Protocol(format!("{method}: {e}")))
    }

    pub fn notify<P: Serialize>(&self, method: &str, params: P) -> Result<(), RpcError> {
        let params = serde_json::to_value(params).map_err(|e| RpcError::Protocol(e.to_string()))?;
        let mut msg = json!({ "jsonrpc": "2.0", "method": method });
        if !params.is_null() {
            msg["params"] = params;
        }
        self.inner.send_value(&msg)
    }

    /// Resolves when the connection closes (process exit or EOF), with the exit code if known.
    pub async fn closed(&self) -> Option<i32> {
        let mut rx = self.inner.closed.subscribe();
        match rx.wait_for(|s| s.is_some()).await {
            Ok(state) => state.flatten(),
            Err(_) => None,
        }
    }

    /// Whether the transport is gone (requests fail with [`RpcError::Closed`]).
    pub fn is_closed(&self) -> bool {
        self.inner.transport_closed.load(Ordering::Acquire)
    }

    /// OS process id when this peer owns a child process.
    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    /// Kills the child process (if any) and tears down the connection.
    pub fn kill(&self) {
        self.inner.close_transport();
        self.inner.kill.cancel();
    }
}

/// Removes the pending entry and tells the remote side to stop when a request
/// future is dropped or cancelled before its response arrives.
struct PendingGuard<'a> {
    inner: &'a Arc<Inner>,
    id: i64,
    armed: bool,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if self.armed && self.inner.pending.lock().remove(&self.id).is_some() {
            let _ = self
                .inner
                .send_value(&json!({ "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": self.id } }));
        }
    }
}

fn parse_id(id: &Value) -> Option<i64> {
    match id {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn dispatch(
    inner: &Arc<Inner>,
    handler: &Arc<dyn Handler>,
    notif_tx: &std::sync::mpsc::Sender<(String, Value)>,
    body: &[u8],
) {
    tracing::trace!(target: "ide_jsonrpc::wire", "<-- {}", String::from_utf8_lossy(body));
    let msg: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("jsonrpc: unparsable message: {e}");
            return;
        }
    };
    let Value::Object(mut obj) = msg else {
        tracing::warn!("jsonrpc: ignoring non-object message");
        return;
    };
    let id = obj.remove("id");
    match obj.remove("method") {
        Some(Value::String(method)) => {
            let params = obj.remove("params").unwrap_or(Value::Null);
            match id {
                Some(id) if !id.is_null() => {
                    let handler = handler.clone();
                    let inner = inner.clone();
                    tokio::spawn(async move {
                        let m = method.clone();
                        let result = tokio::task::spawn_blocking(move || handler.on_request(&m, params)).await;
                        let reply = match result {
                            Ok(Ok(result)) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                            Ok(Err((code, message))) => {
                                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
                            }
                            Err(_) => json!({
                                "jsonrpc": "2.0", "id": id,
                                "error": { "code": codes::INTERNAL_ERROR, "message": format!("handler for {method} panicked") }
                            }),
                        };
                        let _ = inner.send_value(&reply);
                    });
                }
                _ => {
                    let _ = notif_tx.send((method, params));
                }
            }
        }
        Some(_) => tracing::warn!("jsonrpc: non-string method"),
        None => {
            let Some(id) = id.as_ref().and_then(parse_id) else {
                if let Some(err) = obj.get("error") {
                    tracing::warn!("jsonrpc: error response without id: {err}");
                }
                return;
            };
            let Some(tx) = inner.pending.lock().remove(&id) else {
                tracing::debug!("jsonrpc: response for unknown request {id}");
                return;
            };
            let result = match obj.remove("error") {
                Some(err) if !err.is_null() => {
                    let code = err.get("code").and_then(Value::as_i64).unwrap_or(codes::INTERNAL_ERROR);
                    if code == codes::REQUEST_CANCELLED || code == codes::SERVER_CANCELLED {
                        Err(RpcError::Cancelled)
                    } else {
                        Err(RpcError::Server {
                            code,
                            message: err.get("message").and_then(Value::as_str).unwrap_or_default().to_owned(),
                            data: err.get("data").cloned(),
                        })
                    }
                }
                _ => Ok(obj.remove("result").unwrap_or(Value::Null)),
            };
            let _ = tx.send(result);
        }
    }
}

#[cfg(test)]
mod tests;
