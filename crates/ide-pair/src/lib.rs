//! Pairing phones with the desktop over iroh.
//!
//! The desktop runs an iroh [`Endpoint`] under a persistent key, so its endpoint id
//! stays the same across restarts. Pairing shows a [`Ticket`] (a QR code): the
//! endpoint's address plus a one-time code that expires. A phone that connects
//! with a valid code is remembered by its own endpoint id ([`DeviceStore`]) and
//! reconnects later without one. iroh authenticates both ends by their keys and
//! encrypts the connection, through a relay when no direct path exists.
//!
//! A connection opens one bidirectional stream. The phone sends a [`Hello`] line
//! (JSON, newline-terminated), the desktop answers a [`Welcome`] line, and then
//! the stream carries the remote development protocol (`ide_host::rpc`) like an
//! SSH channel to `openidea-server` does. [`Listener`] hands accepted streams to
//! the desktop as [`Session`]s; [`connect`] is the phone's side.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The protocol both ends announce in the QUIC handshake.
pub const ALPN: &[u8] = b"openidea/mobile/1";
/// What a pairing QR code holds before the encoded ticket.
pub const TICKET_PREFIX: &str = "openidea-pair:";
const PROTOCOL: u32 = 1;
/// Longest handshake line either side accepts.
const LINE_MAX: usize = 4096;
/// How long a phone has to send its hello after connecting.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a ticket waits for the relay before giving direct addresses only.
const ONLINE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum PairError {
    #[error("not an OpenIDEA pairing code")]
    Ticket,
    #[error("cannot reach the desktop: {0}")]
    Connect(String),
    #[error("the desktop refused the connection: {0}")]
    Refused(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// What a pairing QR code carries: where the desktop is and a one-time code.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ticket {
    pub v: u32,
    /// The desktop's name, shown on the phone while it connects.
    pub desktop: String,
    pub addr: EndpointAddr,
    pub code: String,
}

impl Ticket {
    pub fn encode(&self) -> String {
        let json = serde_json::to_vec(self).expect("a ticket serializes");
        format!("{TICKET_PREFIX}{}", URL_SAFE_NO_PAD.encode(json))
    }

    pub fn decode(text: &str) -> Result<Self, PairError> {
        let body = text.trim().strip_prefix(TICKET_PREFIX).ok_or(PairError::Ticket)?;
        let json = URL_SAFE_NO_PAD.decode(body).map_err(|_| PairError::Ticket)?;
        let ticket: Self = serde_json::from_slice(&json).map_err(|_| PairError::Ticket)?;
        if ticket.v != PROTOCOL {
            return Err(PairError::Ticket);
        }
        Ok(ticket)
    }
}

/// A paired phone, known by its endpoint id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    /// Seconds since the Unix epoch.
    pub paired_at: u64,
}

/// The paired phones, kept in a JSON file.
pub struct DeviceStore {
    file: PathBuf,
    devices: Mutex<Vec<Device>>,
}

impl DeviceStore {
    /// Reads `file`; a missing or unreadable one is an empty list.
    pub fn load(file: impl Into<PathBuf>) -> Self {
        let file = file.into();
        let devices = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { file, devices: Mutex::new(devices) }
    }

    pub fn list(&self) -> Vec<Device> {
        self.devices.lock().clone()
    }

    pub fn get(&self, id: &str) -> Option<Device> {
        self.devices.lock().iter().find(|d| d.id == id).cloned()
    }

    pub fn is_empty(&self) -> bool {
        self.devices.lock().is_empty()
    }

    /// Adds `device`, replacing one with the same id.
    pub fn add(&self, device: Device) -> std::io::Result<()> {
        let mut devices = self.devices.lock();
        devices.retain(|d| d.id != device.id);
        devices.push(device);
        self.save(&devices)
    }

    pub fn remove(&self, id: &str) -> std::io::Result<bool> {
        let mut devices = self.devices.lock();
        let before = devices.len();
        devices.retain(|d| d.id != id);
        if devices.len() == before {
            return Ok(false);
        }
        self.save(&devices)?;
        Ok(true)
    }

    fn save(&self, devices: &[Device]) -> std::io::Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(devices).map_err(std::io::Error::other)?)?;
        std::fs::rename(&tmp, &self.file)
    }
}

/// The endpoint key in `file`, created there (readable by the user only) the first time.
pub fn load_or_create_key(file: &Path) -> std::io::Result<SecretKey> {
    if let Ok(bytes) = std::fs::read(file)
        && let Ok(bytes) = <[u8; 32]>::try_from(bytes.as_slice())
    {
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let key = SecretKey::generate();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    write_private(file, &key.to_bytes())?;
    Ok(key)
}

/// The desktop's endpoint: its key from `key_file`, n0's relays and address lookup, accepting phones.
pub async fn bind_desktop(key_file: &Path) -> Result<Endpoint, PairError> {
    let key = load_or_create_key(key_file)?;
    Endpoint::builder(iroh::endpoint::presets::N0)
        .secret_key(key)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| PairError::Connect(e.to_string()))
}

/// An endpoint on the loopback interface without relays or address lookup; `accept` makes it
/// accept phones. For tests on one machine.
#[cfg(any(test, feature = "testing"))]
pub async fn bind_local(accept: bool) -> Endpoint {
    Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(iroh::RelayMode::Disabled)
        .alpns(if accept { vec![ALPN.to_vec()] } else { vec![] })
        .bind_addr("127.0.0.1:0")
        .expect("a loopback address")
        .bind()
        .await
        .expect("a loopback endpoint")
}

#[cfg(unix)]
fn write_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(file)?;
    f.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(file, bytes)
}

/// The phone's first line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub v: u32,
    /// The phone's name, shown in the desktop's device list.
    pub name: String,
    /// The ticket's code, when pairing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// The desktop's answer to a [`Hello`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Welcome {
    pub ok: bool,
    pub desktop: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

async fn read_line(recv: &mut RecvStream) -> std::io::Result<Vec<u8>> {
    let mut line = Vec::new();
    loop {
        let byte = recv.read_u8().await?;
        if byte == b'\n' {
            return Ok(line);
        }
        if line.len() == LINE_MAX {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "handshake line too long"));
        }
        line.push(byte);
    }
}

async fn write_line<T: Serialize>(send: &mut SendStream, value: &T) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    line.push(b'\n');
    send.write_all(&line).await?;
    send.flush().await
}

/// A phone's accepted connection, its stream ready for the remote development protocol.
pub struct Session {
    pub device: Device,
    pub connection: Connection,
    pub send: SendStream,
    pub recv: RecvStream,
}

pub type SessionHandler = Arc<dyn Fn(Session) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

struct Pending {
    code: [u8; 16],
    expires: Instant,
}

struct Shared {
    store: DeviceStore,
    desktop: String,
    pending: Mutex<Option<Pending>>,
    /// Connected phones by device id.
    online: Mutex<HashMap<String, Connection>>,
    handler: SessionHandler,
    on_change: Arc<dyn Fn() + Send + Sync>,
}

impl Shared {
    /// Uses up the pairing code when `code` matches it in time.
    fn redeem(&self, code: &str) -> bool {
        let Ok(given) = URL_SAFE_NO_PAD.decode(code) else { return false };
        let mut pending = self.pending.lock();
        let valid = pending.as_ref().is_some_and(|p| p.expires > Instant::now() && constant_time_eq(&p.code, &given));
        if valid {
            *pending = None;
        }
        valid
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Accepts phones on `endpoint`: paired ones, and new ones holding the current ticket's code.
pub struct Listener {
    endpoint: Endpoint,
    shared: Arc<Shared>,
}

impl Listener {
    /// Starts accepting on the current tokio runtime. `endpoint` must accept [`ALPN`].
    /// `handler` serves each session; `on_change` runs when a device pairs, connects,
    /// disconnects or is removed.
    pub fn start(
        endpoint: Endpoint,
        store: DeviceStore,
        desktop: String,
        handler: SessionHandler,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        let shared = Arc::new(Shared {
            store,
            desktop,
            pending: Mutex::new(None),
            online: Mutex::new(HashMap::new()),
            handler,
            on_change,
        });
        let accepting = endpoint.clone();
        let accept_shared = shared.clone();
        tokio::spawn(async move {
            while let Some(incoming) = accepting.accept().await {
                let shared = accept_shared.clone();
                tokio::spawn(async move {
                    match incoming.await {
                        Ok(connection) => accept(shared, connection).await,
                        Err(e) => tracing::debug!("mobile connection failed: {e}"),
                    }
                });
            }
        });
        Self { endpoint, shared }
    }

    /// A new ticket valid for `ttl`; any earlier one stops working.
    pub async fn ticket(&self, ttl: Duration) -> (Ticket, Duration) {
        // Without the relay (offline, or a firewall) the address still has the direct ones.
        let _ = tokio::time::timeout(ONLINE_TIMEOUT, self.endpoint.online()).await;
        let (code, expires) = {
            let mut pending = self.shared.pending.lock();
            match pending.as_ref() {
                // Asked again while the shown code still works (a second dialog, a re-render): the same code.
                Some(p) if p.expires > Instant::now() => (p.code, p.expires),
                _ => {
                    let mut code = [0u8; 16];
                    getrandom::fill(&mut code).expect("system randomness");
                    let expires = Instant::now() + ttl;
                    *pending = Some(Pending { code, expires });
                    (code, expires)
                }
            }
        };
        let ticket = Ticket {
            v: PROTOCOL,
            desktop: self.shared.desktop.clone(),
            addr: self.endpoint.addr(),
            code: URL_SAFE_NO_PAD.encode(code),
        };
        (ticket, expires.saturating_duration_since(Instant::now()))
    }

    /// Stops the current ticket from pairing anything.
    pub fn cancel_pairing(&self) {
        *self.shared.pending.lock() = None;
    }

    /// The paired devices, each with whether it is connected now.
    pub fn devices(&self) -> Vec<(Device, bool)> {
        let online = self.shared.online.lock();
        self.shared
            .store
            .list()
            .into_iter()
            .map(|d| {
                let connected = online.contains_key(&d.id);
                (d, connected)
            })
            .collect()
    }

    /// Forgets a device and drops its connection.
    pub fn remove(&self, id: &str) -> std::io::Result<bool> {
        let removed = self.shared.store.remove(id)?;
        if let Some(connection) = self.shared.online.lock().remove(id) {
            connection.close(0u32.into(), b"unpaired");
        }
        if removed {
            (self.shared.on_change)();
        }
        Ok(removed)
    }

    pub fn has_devices(&self) -> bool {
        !self.shared.store.is_empty()
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

async fn accept(shared: Arc<Shared>, connection: Connection) {
    let id = connection.remote_id().to_string();
    let Ok((mut send, mut recv)) = connection.accept_bi().await else { return };
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, read_line(&mut recv)).await {
        Ok(Ok(line)) => serde_json::from_slice::<Hello>(&line).ok(),
        _ => None,
    };
    let refuse = |error: &str| Welcome { ok: false, desktop: shared.desktop.clone(), error: Some(error.into()) };
    let Some(hello) = hello.filter(|h| h.v == PROTOCOL) else {
        let _ = write_line(&mut send, &refuse("unsupported client")).await;
        let _ = send.finish();
        return;
    };
    let device = if let Some(known) = shared.store.get(&id) {
        known
    } else if hello.code.as_deref().is_some_and(|code| shared.redeem(code)) {
        let device = Device { id: id.clone(), name: hello.name.clone(), paired_at: now_secs() };
        if let Err(e) = shared.store.add(device.clone()) {
            tracing::warn!("cannot save the paired device: {e}");
        }
        device
    } else {
        let reason =
            if hello.code.is_some() { "the pairing code is invalid or expired" } else { "this device is not paired" };
        let _ = write_line(&mut send, &refuse(reason)).await;
        let _ = send.finish();
        connection.closed().await;
        return;
    };
    let welcome = Welcome { ok: true, desktop: shared.desktop.clone(), error: None };
    if write_line(&mut send, &welcome).await.is_err() {
        return;
    }
    // One connection per device: a reconnect replaces the one it left behind.
    if let Some(old) = shared.online.lock().insert(id.clone(), connection.clone()) {
        old.close(0u32.into(), b"replaced");
    }
    (shared.on_change)();
    (shared.handler)(Session { device, connection: connection.clone(), send, recv }).await;
    {
        let mut online = shared.online.lock();
        if online.get(&id).is_some_and(|c| c.stable_id() == connection.stable_id()) {
            online.remove(&id);
        }
    }
    (shared.on_change)();
}

/// The phone's side: connects to `addr`, pairing with `code` or as a paired device.
pub async fn connect(
    endpoint: &Endpoint,
    addr: EndpointAddr,
    name: &str,
    code: Option<&str>,
) -> Result<(Connection, Welcome, SendStream, RecvStream), PairError> {
    let connection = endpoint.connect(addr, ALPN).await.map_err(|e| PairError::Connect(e.to_string()))?;
    let (mut send, mut recv) = connection.open_bi().await.map_err(|e| PairError::Connect(e.to_string()))?;
    let hello = Hello { v: PROTOCOL, name: name.into(), code: code.map(str::to_owned) };
    write_line(&mut send, &hello).await?;
    let line = read_line(&mut recv).await?;
    let welcome: Welcome =
        serde_json::from_slice(&line).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if !welcome.ok {
        return Err(PairError::Refused(welcome.error.unwrap_or_default()));
    }
    Ok((connection, welcome, send, recv))
}

#[cfg(test)]
mod tests;
