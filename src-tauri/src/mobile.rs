//! Phones paired with this desktop over iroh (`ide_pair`).
//!
//! A connected phone is a remote development client of this desktop's backend: its
//! windows (`mobile-<device>-…`) open projects on the shared [`ide_host::Host`], their
//! events go back over the phone's connection, and it can name no other window
//! (`rpc::serve_scoped`). Agent tasks, database connections and repositories are the
//! desktop's own, so the phone sees what the desktop has. When the phone disconnects its
//! projects close.
//!
//! The listener starts when the user pairs a phone, and at start-up once one is paired.

use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::{IdeError, IdeEvent, IdeResult, SharedSink};
use ide_host::catalogue::TrustClass;
use ide_host::rpc::{self, Dispatcher};
use ide_jsonrpc::Peer;
use ide_pair::{DeviceStore, Listener, Session, SessionHandler};
use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// Every phone window's label starts with this, then the device's scope.
const WINDOW_PREFIX: &str = "mobile-";
/// How long a pairing code stays valid.
const TICKET_TTL: Duration = Duration::from_secs(300);
/// The desktop's recent projects, which the phone lists as its own.
const PROJECTS_COMMAND: &str = "recent_projects";
/// Commands after which a phone's project is recorded in the recent projects.
const RECORDED_COMMANDS: [&str; 1] = ["open_project"];

/// The prefix of a device's windows: `mobile-<first 12 characters of its id>-`.
pub fn scope_for(device_id: &str) -> String {
    let short: String = device_id.chars().take(12).collect();
    format!("{WINDOW_PREFIX}{short}-")
}

/// The device scope of a phone's window, `None` for the desktop's own windows.
pub fn scope_of(window: &str) -> Option<&str> {
    let rest = window.strip_prefix(WINDOW_PREFIX)?;
    let end = rest.find('-')?;
    Some(&window[..WINDOW_PREFIX.len() + end + 1])
}

pub struct Mobile {
    key_file: PathBuf,
    devices_file: PathBuf,
    /// The connection of each connected device, by scope.
    peers: Mutex<HashMap<String, Arc<OnceLock<Peer>>>>,
    listener: tokio::sync::OnceCell<Listener>,
}

impl Mobile {
    pub fn new(config_dir: &std::path::Path, data_dir: &std::path::Path) -> Self {
        Self {
            key_file: data_dir.join("mobile").join("endpoint.key"),
            devices_file: config_dir.join("mobile-devices.json"),
            peers: Mutex::default(),
            listener: tokio::sync::OnceCell::new(),
        }
    }

    /// The event sink of a phone's window (its device's connection); `None` for a desktop window.
    pub fn sink(&self, window: &str) -> Option<SharedSink> {
        let scope = scope_of(window)?;
        let peer = self.peers.lock().entry(scope.to_owned()).or_default().clone();
        Some(rpc::event_sink(peer, Some(window.to_owned())))
    }

    /// Whether a phone has been paired, so the listener should run from start-up.
    pub fn has_devices(&self) -> bool {
        !DeviceStore::load(&self.devices_file).is_empty()
    }

    async fn listener(&self, app: &AppHandle) -> IdeResult<&Listener> {
        self.listener
            .get_or_try_init(|| async {
                let endpoint =
                    ide_pair::bind_desktop(&self.key_file).await.map_err(|e| IdeError::internal(e.to_string()))?;
                let store = DeviceStore::load(&self.devices_file);
                let serving = app.clone();
                let handler: SessionHandler = Arc::new(move |session| Box::pin(serve(serving.clone(), session)));
                let notifying = app.clone();
                let on_change = Arc::new(move || {
                    notifying.state::<AppState>().sink.emit(IdeEvent::MobileDevicesChanged);
                });
                tracing::info!(id = %endpoint.id(), "accepting paired phones");
                Ok(Listener::start(endpoint, store, desktop_name(), handler, on_change))
            })
            .await
    }
}

/// Starts accepting paired phones in the background, when there are any.
pub fn start_if_paired(app: &AppHandle) {
    if !app.state::<AppState>().mobile.has_devices() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = app.state::<AppState>().mobile.listener(&app).await {
            tracing::warn!("cannot accept paired phones: {}", e.message);
        }
    });
}

fn desktop_name() -> String {
    whoami::devicename().ok().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "OpenIDEA".into())
}

/// Serves one connected phone until it disconnects, then closes its projects.
async fn serve(app: AppHandle, session: Session) {
    let state = app.state::<AppState>();
    let scope = scope_for(&session.device.id);
    let peer = Arc::new(OnceLock::new());
    state.mobile.peers.lock().insert(scope.clone(), peer.clone());
    let mut dispatcher = Dispatcher::standard();
    let listing = app.clone();
    dispatcher.add(PROJECTS_COMMAND, TrustClass::Always, move |_| {
        let app = listing.clone();
        async move {
            let projects = tokio::task::spawn_blocking(move || app.state::<AppState>().recent.list_live())
                .await
                .map_err(|e| IdeError::internal(e.to_string()))?;
            Ok(projects)
        }
    });
    // Projects a phone opens are recent projects of this desktop too, as the desktop's own windows record them.
    for command in RECORDED_COMMANDS {
        let recording = app.clone();
        dispatcher.after(command, move |host, window| {
            if let Ok(project) = host.project(window)
                && !project.light
                && let Err(e) = recording.state::<AppState>().record_project(&project)
            {
                tracing::warn!("cannot record {}: {}", project.root.display(), e.message);
            }
        });
    }
    tracing::info!(device = %session.device.name, "phone connected");
    rpc::serve_scoped(state.host.clone(), dispatcher, peer.clone(), session.recv, session.send, Some(scope.clone()))
        .await;
    tracing::info!(device = %session.device.name, "phone disconnected");
    {
        let mut peers = state.mobile.peers.lock();
        if peers.get(&scope).is_some_and(|p| Arc::ptr_eq(p, &peer)) {
            peers.remove(&scope);
        }
    }
    for window in state.host.windows() {
        if window.starts_with(&scope) {
            state.host.close_project_detached(&window);
        }
    }
}

/// A pairing code to show as a QR code.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairing {
    /// What the QR code holds (`openidea-pair:…`).
    pub ticket: String,
    /// The QR code as an SVG document.
    pub qr_svg: String,
    pub expires_in_secs: u32,
    /// This desktop's name, as the phone shows it.
    pub desktop: String,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MobileDevice {
    pub id: String,
    pub name: String,
    /// Milliseconds since the Unix epoch.
    pub paired_at_ms: f64,
    pub online: bool,
}

/// Starts accepting phones and gives the pairing code: the current one while it works, else a new one.
#[desktop_command(trust = outside_restricted)]
#[tauri::command]
#[specta::specta]
pub async fn mobile_pair(app: AppHandle, state: State<'_, AppState>) -> IdeResult<MobilePairing> {
    let listener = state.mobile.listener(&app).await?;
    let (ticket, left) = listener.ticket(TICKET_TTL).await;
    let text = ticket.encode();
    let qr = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::L)
        .map_err(|e| IdeError::internal(e.to_string()))?;
    let qr_svg = qr.render::<qrcode::render::svg::Color>().quiet_zone(true).min_dimensions(240, 240).build();
    Ok(MobilePairing { ticket: text, qr_svg, expires_in_secs: left.as_secs() as u32, desktop: ticket.desktop })
}

/// Stops the current pairing code from pairing anything.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn mobile_cancel_pairing(state: State<'_, AppState>) -> IdeResult<()> {
    if let Some(listener) = state.mobile.listener.get() {
        listener.cancel_pairing();
    }
    Ok(())
}

/// The paired phones, each with whether it is connected now.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn mobile_devices(state: State<'_, AppState>) -> IdeResult<Vec<MobileDevice>> {
    let devices = match state.mobile.listener.get() {
        Some(listener) => listener.devices(),
        None => DeviceStore::load(&state.mobile.devices_file).list().into_iter().map(|d| (d, false)).collect(),
    };
    Ok(devices
        .into_iter()
        .map(|(d, online)| MobileDevice { id: d.id, name: d.name, paired_at_ms: d.paired_at as f64 * 1000.0, online })
        .collect())
}

/// Forgets a paired phone and drops its connection; it has to pair again.
#[desktop_command(trust = outside_restricted)]
#[tauri::command]
#[specta::specta]
pub async fn mobile_device_remove(app: AppHandle, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    let removed = match state.mobile.listener.get() {
        Some(listener) => listener.remove(&id)?,
        None => DeviceStore::load(&state.mobile.devices_file).remove(&id)?,
    };
    if removed && state.mobile.listener.get().is_none() {
        app.state::<AppState>().sink.emit(IdeEvent::MobileDevicesChanged);
    }
    Ok(())
}

ide_command::desktop_domain!(mobile_cancel_pairing, mobile_device_remove, mobile_devices, mobile_pair);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phone_window_belongs_to_its_device_scope() {
        let scope = scope_for("4f6c2a9b81d3e5f7a0b2c4d6e8f0");
        assert_eq!(scope, "mobile-4f6c2a9b81d3-");
        assert_eq!(scope_of(&format!("{scope}1")), Some(scope.as_str()));
        assert_eq!(scope_of("main"), None);
        assert_eq!(scope_of("settings-main"), None);
        assert_eq!(scope_of("mobile-"), None);
    }
}
