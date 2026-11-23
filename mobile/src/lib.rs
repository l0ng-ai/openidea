//! OpenIDEA on a phone: the workbench UI as a client of a paired desktop's backend.
//!
//! The phone runs no language servers, terminals or agents itself. It pairs with a desktop
//! over iroh (`ide_pair`) and sends each command of its window to that desktop as an
//! `invoke` (the remote development protocol of `ide_host::rpc`), in the desktop window
//! `mobile-<device>-<label>`. Events and streamed values for that window come back as
//! notifications and go to the webview the way the desktop's own reach its windows.

use ide_jsonrpc::{Handler, Peer};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// What the frontend listens to for backend events (`src/platform/ipc.ts`).
const IDE_EVENT: &str = "ide://event";
/// Sent to the webview when the connection to the desktop drops.
const DISCONNECTED_EVENT: &str = "phone://disconnected";

/// A command's failure, shaped like the desktop's `IdeError`.
#[derive(Debug, Serialize)]
struct Failure {
    kind: &'static str,
    message: String,
}

type Reply<T> = Result<T, Failure>;

fn failure(kind: &'static str, message: impl ToString) -> Failure {
    Failure { kind, message: message.to_string() }
}

/// The desktop this phone pairs with: how to reach it and its name.
#[derive(Clone, Serialize, Deserialize)]
struct PairedDesktop {
    name: String,
    addr: iroh::EndpointAddr,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhoneStatus {
    /// The paired desktop's name, `None` before pairing.
    desktop: Option<String>,
    connected: bool,
    /// How the connection reaches the desktop: each path's address and round trip, `*` = in use.
    paths: Vec<String>,
}

/// A connection to the desktop, as the frontend sees it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhoneSession {
    desktop: String,
    /// The commands the desktop answers for the phone.
    commands: Vec<String>,
    os: String,
    home: String,
}

#[derive(Clone, Serialize)]
struct ChannelFrame {
    id: u64,
    data: String,
}

type Channels = Arc<Mutex<HashMap<u64, (Channel<ChannelFrame>, u64)>>>;

struct Connection {
    link: iroh::endpoint::Connection,
    peer: Peer,
    /// The prefix of this phone's windows on the desktop.
    scope: String,
    session: PhoneSession,
    channels: Channels,
    next_channel: AtomicU64,
}

struct Phone {
    key_file: PathBuf,
    desktop_file: PathBuf,
    endpoint: tokio::sync::OnceCell<iroh::Endpoint>,
    connection: Mutex<Option<Arc<Connection>>>,
    /// One connection attempt at a time.
    connecting: tokio::sync::Mutex<()>,
}

impl Phone {
    async fn endpoint(&self) -> Reply<&iroh::Endpoint> {
        self.endpoint
            .get_or_try_init(|| async {
                let key = ide_pair::load_or_create_key(&self.key_file).map_err(|e| failure("io", e))?;
                iroh::Endpoint::builder(iroh::endpoint::presets::N0)
                    .secret_key(key)
                    .bind()
                    .await
                    .map_err(|e| failure("unavailable", e))
            })
            .await
    }

    fn paired(&self) -> Option<PairedDesktop> {
        serde_json::from_slice(&std::fs::read(&self.desktop_file).ok()?).ok()
    }

    fn current(&self) -> Option<Arc<Connection>> {
        self.connection.lock().clone()
    }
}

fn device_name() -> String {
    if cfg!(target_os = "ios") {
        "iPhone".into()
    } else if cfg!(target_os = "android") {
        "Android phone".into()
    } else {
        "Phone".into()
    }
}

/// Window events and streamed values from the desktop.
struct FromDesktop {
    app: AppHandle,
    scope: String,
    channels: Channels,
}

#[derive(Deserialize)]
struct EventMessage {
    window: Option<String>,
    event: Value,
}

#[derive(Deserialize)]
struct ChannelMessage {
    id: u64,
    data: Value,
}

impl Handler for FromDesktop {
    fn on_notification(&self, method: &str, params: Value) {
        match method {
            "event" => {
                let Ok(m) = serde_json::from_value::<EventMessage>(params) else { return };
                let label = m.window.as_deref().and_then(|w| w.strip_prefix(&self.scope));
                let _ = match label {
                    Some(label) => self.app.emit_to(label, IDE_EVENT, m.event),
                    None => self.app.emit(IDE_EVENT, m.event),
                };
            }
            "channel" => {
                let Ok(m) = serde_json::from_value::<ChannelMessage>(params) else { return };
                if let Some((channel, id)) = self.channels.lock().get(&m.id).cloned() {
                    let _ = channel.send(ChannelFrame { id, data: m.data.to_string() });
                }
            }
            _ => {}
        }
    }

    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, format!("the phone does not handle {method}")))
    }
}

/// Connects to `desktop`, pairing with `code` the first time, and makes it the current connection.
async fn connect(app: &AppHandle, phone: &Phone, desktop: &PairedDesktop, code: Option<&str>) -> Reply<PhoneSession> {
    let _one = phone.connecting.lock().await;
    let endpoint = phone.endpoint().await?;
    let (connection, welcome, send, recv) =
        ide_pair::connect(endpoint, desktop.addr.clone(), &device_name(), code).await.map_err(|e| match e {
            ide_pair::PairError::Refused(m) => failure("permissionDenied", m),
            e => failure("unavailable", e),
        })?;
    let id = endpoint.id().to_string();
    let scope = format!("mobile-{}-", &id[..12]);
    let channels = Channels::default();
    let handler = Arc::new(FromDesktop { app: app.clone(), scope: scope.clone(), channels: channels.clone() });
    let peer = Peer::connect(recv, send, handler);
    #[derive(Deserialize)]
    struct ServerInfo {
        os: String,
        home: String,
    }
    let info: ServerInfo = peer.request("initialize", json!({}), None).await.map_err(|e| failure("unavailable", e))?;
    let commands: Vec<String> =
        peer.request("commands", json!({}), None).await.map_err(|e| failure("unavailable", e))?;
    let session = PhoneSession { desktop: welcome.desktop.clone(), commands, os: info.os, home: info.home };
    let current = Arc::new(Connection {
        link: connection,
        peer: peer.clone(),
        scope,
        session: session.clone(),
        channels,
        next_channel: AtomicU64::new(1),
    });
    if let Some(old) = phone.connection.lock().replace(current.clone()) {
        old.link.close(0u32.into(), b"replaced");
    }
    let watching = app.clone();
    tauri::async_runtime::spawn(async move {
        peer.closed().await;
        let phone = watching.state::<Phone>();
        let mut slot = phone.connection.lock();
        if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &current)) {
            *slot = None;
            drop(slot);
            let _ = watching.emit(DISCONNECTED_EVENT, ());
        }
    });
    Ok(session)
}

#[tauri::command]
fn phone_status(phone: State<'_, Phone>) -> PhoneStatus {
    let current = phone.current();
    let paths = current
        .as_ref()
        .map(|c| {
            c.link
                .paths()
                .iter()
                .map(|p| {
                    let mark = if p.is_selected() { "*" } else { " " };
                    format!("{mark} {:?} {}ms", p.remote_addr(), p.rtt().as_millis())
                })
                .collect()
        })
        .unwrap_or_default();
    PhoneStatus { desktop: phone.paired().map(|d| d.name), connected: current.is_some(), paths }
}

/// Pairs with the desktop whose pairing code (`openidea-pair:…`) the user scanned or pasted.
#[tauri::command]
async fn phone_pair(app: AppHandle, phone: State<'_, Phone>, code: String) -> Reply<PhoneSession> {
    let ticket = ide_pair::Ticket::decode(code.trim())
        .map_err(|_| failure("invalidInput", "this is not an OpenIDEA pairing code"))?;
    let desktop = PairedDesktop { name: ticket.desktop.clone(), addr: ticket.addr.clone() };
    let session = connect(&app, &phone, &desktop, Some(&ticket.code)).await?;
    if let Some(dir) = phone.desktop_file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| failure("io", e))?;
    }
    let saved = PairedDesktop { name: session.desktop.clone(), addr: desktop.addr };
    std::fs::write(&phone.desktop_file, serde_json::to_vec(&saved).unwrap_or_default())
        .map_err(|e| failure("io", e))?;
    Ok(session)
}

/// Connects to the paired desktop (again).
#[tauri::command]
async fn phone_connect(app: AppHandle, phone: State<'_, Phone>) -> Reply<PhoneSession> {
    if let Some(c) = phone.current() {
        return Ok(c.session.clone());
    }
    let desktop = phone.paired().ok_or_else(|| failure("notFound", "this phone is not paired with a desktop"))?;
    connect(&app, &phone, &desktop, None).await
}

/// Disconnects and forgets the paired desktop.
#[tauri::command]
fn phone_forget(phone: State<'_, Phone>) -> Reply<()> {
    if let Some(c) = phone.connection.lock().take() {
        c.link.close(0u32.into(), b"forgotten");
    }
    match std::fs::remove_file(&phone.desktop_file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(failure("io", e)),
        _ => Ok(()),
    }
}

/// Runs `cmd` of this window on the desktop. `args` is the arguments' JSON text; streaming
/// arguments are `{ "$channel": id }`, their values arrive on `on_channel` tagged with the id.
#[tauri::command]
async fn remote_invoke(
    window: WebviewWindow,
    phone: State<'_, Phone>,
    cmd: String,
    args: String,
    on_channel: Channel<ChannelFrame>,
) -> Result<String, Value> {
    let c =
        phone.current().ok_or_else(|| json!({ "kind": "unavailable", "message": "not connected to the desktop" }))?;
    let mut args: Value =
        serde_json::from_str(&args).map_err(|e| json!({ "kind": "invalidInput", "message": e.to_string() }))?;
    if let Value::Object(map) = &mut args {
        for v in map.values_mut() {
            if let Some(id) = v.get("$channel").and_then(Value::as_u64) {
                let own = c.next_channel.fetch_add(1, Ordering::Relaxed);
                c.channels.lock().insert(own, (on_channel.clone(), id));
                *v = json!({ "$channel": own });
            }
        }
    }
    let call = json!({ "window": format!("{}{}", c.scope, window.label()), "cmd": cmd, "args": args });
    match c.peer.request::<_, Value>("invoke", call, None).await {
        Ok(value) => Ok(value.to_string()),
        // The desktop's `IdeError` is the JSON-RPC error's message.
        Err(ide_jsonrpc::RpcError::Server { message, .. }) => {
            Err(serde_json::from_str(&message).unwrap_or_else(|_| json!({ "kind": "protocol", "message": message })))
        }
        Err(e) => Err(json!({ "kind": "unavailable", "message": e.to_string() })),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // iOS keeps no stderr: a panic's message goes to a file in the app's temporary directory.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        if let Ok(mut f) =
            std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("panic.txt"))
        {
            let _ = writeln!(f, "{info}");
        }
        default_hook(info);
    }));
    // HTTPS clients (iroh's relays) need a process-wide crypto provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            app.manage(Phone {
                key_file: data.join("phone.key"),
                desktop_file: data.join("desktop.json"),
                endpoint: tokio::sync::OnceCell::new(),
                connection: Mutex::default(),
                connecting: tokio::sync::Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![phone_status, phone_pair, phone_connect, phone_forget, remote_invoke])
        .run(tauri::generate_context!())
        .expect("error while running the OpenIDEA phone app");
}
