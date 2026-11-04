//! Remote development (client side): a window whose project lives on another
//! machine. The backend there is `openidea-server`, started over SSH; the
//! frontend's remote-capable commands go through [`remote_invoke`] instead of
//! running locally.

use crate::events::TauriSink;
use crate::state::AppState;
use ide_core::{EventSink, IdeError, IdeResult};
use ide_host::rpc::{ChannelMessage, EventMessage, Invoke, ServerInfo};
use ide_jsonrpc::{Handler, Peer};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Window};

/// Browse before connecting, using the desktop's SSH configuration even in a remote window.
#[tauri::command]
#[specta::specta]
pub async fn remote_bootstrap_list(
    state: State<'_, AppState>,
    ssh: String,
    path: String,
) -> IdeResult<Vec<ide_ssh::RemoteEntry>> {
    state.remote.list(&ide_ssh::FsConnection::Sftp { ssh }, &path).await
}

/// Android: the commands that let SSH configuration `ssh` (Termux on this
/// device) connect, pasted once into Termux. They install openssh, authorize this
/// app's key (generated on first use) and install the IDE backend, which this app
/// cannot download itself (Android has no `curl`).
#[tauri::command]
#[specta::specta]
pub fn remote_termux_setup(state: State<'_, AppState>, ssh: String) -> IdeResult<String> {
    let config = state.ssh.config(&ssh)?;
    let key = ide_ssh::ensure_key(&ide_ssh::expand(config.key_file.trim()), "openidea")?;
    Ok(termux_setup(&key, env!("CARGO_PKG_VERSION")))
}

/// Safe to run again: done steps are skipped. `set -e` in a subshell: a failed
/// step stops the setup, not the user's Termux shell.
fn termux_setup(key: &str, version: &str) -> String {
    const SCRIPT: &str = r#"(set -e
V=@VERSION@
KEY='@KEY@'
pkg install -y openssh curl
mkdir -p ~/.ssh && chmod 700 ~/.ssh
grep -qF "$KEY" ~/.ssh/authorized_keys 2>/dev/null || echo "from=\"127.0.0.1\" $KEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
D=~/.openidea/server/$V/termux
if [ ! -x "$D/openidea-server" ]; then
  mkdir -p "$D"
  U=https://github.com/l0ng-ai/openidea/releases/download/v$V/openidea-server-linux-$(uname -m).gz
  curl -fL -o "$D/server.gz" "$U"
  echo "$(curl -fsSL "$U.sha256" | grep -oE '[0-9a-f]{64}' | head -n 1)  $D/server.gz" | sha256sum -c -
  gunzip -c "$D/server.gz" > "$D/openidea-server.part"
  chmod 755 "$D/openidea-server.part"
  mv "$D/openidea-server.part" "$D/openidea-server"
  rm -f "$D/server.gz"
fi
grep -q '# openidea-sshd' ~/.bashrc 2>/dev/null || echo 'pgrep -x sshd >/dev/null || sshd # openidea-sshd: OpenIDEA connects to it' >> ~/.bashrc
pgrep -x sshd >/dev/null || sshd
echo 'Termux is ready for OpenIDEA.')
"#;
    SCRIPT.replace("@VERSION@", version).replace("@KEY@", key)
}

/// Where the server is installed on the remote host (per version).
fn install_dir(version: &str) -> String {
    format!("~/.openidea/server/{version}")
}

/// One remote window's connection.
pub struct Connection {
    peer: Peer,
    pub ssh_config: String,
    pub root: String,
    pub host: String,
    pub commands: Vec<String>,
    /// Streaming arguments by connection-wide id: the frontend channel and the id
    /// it expects (each webview numbers its own, and a settings window shares this
    /// connection with its parent).
    channels: Channels,
    next_channel: std::sync::atomic::AtomicU64,
    session: Arc<ide_ssh::Session>,
    /// Remote ports forwarded to this machine (Ports tool window), by remote port.
    forwards: Mutex<Vec<(u16, ide_ssh::Tunnel)>>,
}

type Channels = Arc<Mutex<HashMap<u64, (Channel<ChannelFrame>, u64)>>>;

#[derive(Default)]
pub struct Connections(Mutex<HashMap<String, Arc<Connection>>>);

impl Connection {
    pub async fn authorize_command(&self, window: &str, command: &str) -> IdeResult<()> {
        if ide_host::trust::restricted_command_allowed(command) {
            return Ok(());
        }
        let project: Option<ide_host::ops::project::ProjectInfo> = self
            .peer
            .request(
                "invoke",
                Invoke { window: window.to_owned(), cmd: "project_current".into(), args: serde_json::json!({}) },
                None,
            )
            .await
            .map_err(ide_host::rpc::error_from_reply)?;
        if project.is_some_and(|p| p.trusted) {
            Ok(())
        } else {
            Err(IdeError::unavailable("Project is in Restricted Mode"))
        }
    }
}

impl Connections {
    pub fn get(&self, window: &str) -> Option<Arc<Connection>> {
        self.0.lock().get(window).cloned()
    }

    /// The window connected to folder `root` on the host of SSH configuration `ssh_config`.
    pub fn window_of(&self, ssh_config: &str, root: &str) -> Option<String> {
        let root = root.trim_end_matches('/');
        self.0
            .lock()
            .iter()
            .find(|(_, c)| c.ssh_config == ssh_config && c.root.trim_end_matches('/') == root)
            .map(|(label, _)| label.clone())
    }

    /// Every connected window.
    pub fn all(&self) -> Vec<(String, Arc<Connection>)> {
        self.0.lock().iter().map(|(w, c)| (w.clone(), c.clone())).collect()
    }

    pub fn disconnect(&self, window: &str) {
        if let Some(c) = self.0.lock().remove(window) {
            c.peer.kill();
        }
    }
}

/// Where [`remote_connect`] is (`fraction`: 0..1 of a download / upload).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RemoteStage {
    Connecting,
    Checking,
    Downloading,
    Uploading,
    Starting,
    Opening,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProgress {
    pub stage: RemoteStage,
    pub fraction: Option<f64>,
}

type Progress = dyn Fn(RemoteStage, Option<f64>) + Send + Sync;

/// A value for one streaming argument of a remote command (`data`: JSON text).
#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelFrame {
    pub id: u64,
    pub data: String,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub ssh_config: String,
    pub root: String,
    /// `user@host:port` of the SSH configuration.
    pub host: String,
    pub server_version: String,
    pub os: String,
    /// Commands the server answers (the rest run locally).
    pub commands: Vec<String>,
    pub project: ide_host::ops::project::ProjectInfo,
}

struct ClientHandler {
    app: AppHandle,
    window: String,
    channels: Channels,
}

impl Handler for ClientHandler {
    fn on_notification(&self, method: &str, params: Value) {
        match method {
            "event" => match serde_json::from_value::<EventMessage>(params) {
                Ok(m) => {
                    // The server's windows are this window.
                    let _ = m.window;
                    TauriSink { app: self.app.clone(), window: Some(self.window.clone()) }.emit(m.event);
                }
                Err(e) => tracing::warn!("remote event: {e}"),
            },
            // Plugin code of this window's project runs on the server.
            ide_host::plugins::remote_host::EVENT_NOTIFICATION => {
                match serde_json::from_value::<ide_host::plugins::remote_host::PluginEventMessage>(params) {
                    Ok(m) if ide_host::plugins::remote_host::forwarded(&m.event) => {
                        crate::commands::plugin::deliver_to(&self.window, m.event)
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("remote plugin event: {e}"),
                }
            }
            "channel" => match serde_json::from_value::<ChannelMessage>(params) {
                Ok(m) => {
                    let channel = self.channels.lock().get(&m.id).cloned();
                    if let Some((c, id)) = channel {
                        let _ = c.send(ChannelFrame { id, data: m.data.to_string() });
                    }
                }
                Err(e) => tracing::warn!("remote channel: {e}"),
            },
            _ => {}
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        use ide_host::plugins::remote_host::{SECRET_REQUEST, SecretRequest};
        match method {
            // A remote plugin's request header needs a secret from this machine's keychain.
            SECRET_REQUEST => {
                let r: SecretRequest =
                    serde_json::from_value(params).map_err(|e| (ide_jsonrpc::codes::INVALID_PARAMS, e.to_string()))?;
                let state = self.app.state::<AppState>();
                Ok(serde_json::to_value(state.plugins.declared_secret(&r.plugin, &r.name)).unwrap_or(Value::Null))
            }
            _ => Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, format!("unhandled method {method}"))),
        }
    }
}

/// The server binary for a remote `os`/`arch`: `OPENIDEA_SERVER_BINARY`, then
/// `<data dir>/server/<os>-<arch>/openidea-server`, then one next to this app
/// when the platforms match.
fn local_server_binary(state: &AppState, os: &str, arch: &str) -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("OPENIDEA_SERVER_BINARY").map(std::path::PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    let bundled = state.local_data_dir.join("server").join(format!("{os}-{arch}")).join("openidea-server");
    if bundled.is_file() {
        return Some(bundled);
    }
    if os == std::env::consts::OS && arch == std::env::consts::ARCH {
        let exe = std::env::current_exe().ok()?;
        let name = if cfg!(windows) { "openidea-server.exe" } else { "openidea-server" };
        let sibling = exe.parent()?.join(name);
        if sibling.is_file() {
            return Some(sibling);
        }
    }
    None
}

/// The release build of the server for `os`/`arch`, downloaded once into the data dir.
async fn download_server(
    state: &AppState,
    version: &str,
    os: &str,
    arch: &str,
    progress: Arc<Progress>,
) -> IdeResult<std::path::PathBuf> {
    let (data, version, os, arch) = (state.local_data_dir.clone(), version.to_owned(), os.to_owned(), arch.to_owned());
    tokio::task::spawn_blocking(move || {
        ide_tools::server::fetch(&data, &version, &os, &arch, &ide_core::CancellationToken::new(), &|e| match e {
            ide_tools::InstallEvent::Line { text } => tracing::info!("openidea-server download: {text}"),
            ide_tools::InstallEvent::Progress { fraction, .. } => progress(RemoteStage::Downloading, fraction),
        })
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// `uname -sm` → (`linux` | `macos`, `x86_64` | `aarch64`), as Rust names them.
fn platform(uname: &str) -> (String, String) {
    let mut parts = uname.split_whitespace();
    let os = match parts.next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "darwin" => "macos".to_owned(),
        other => other.to_owned(),
    };
    let arch = match parts.next().unwrap_or_default() {
        "arm64" => "aarch64".to_owned(),
        "amd64" => "x86_64".to_owned(),
        other => other.to_owned(),
    };
    (os, arch)
}

/// Makes sure this version of the server is installed on the host; returns its path.
async fn ensure_server(state: &AppState, session: &ide_ssh::Session, progress: Arc<Progress>) -> IdeResult<String> {
    progress(RemoteStage::Checking, None);
    let version = env!("CARGO_PKG_VERSION");
    let dir = install_dir(version);
    let q = ide_ssh::shell::tilde_quote;
    // Between markers: shell start-up files may print to stdout too.
    const MARK: &str = "__OPENIDEA_PROBE__";
    let probe = session
        .exec(&format!("echo {MARK}; uname -sm; ls -d {}/*/openidea-server 2>/dev/null", q(&dir)), None)
        .await?
        .stdout_str();
    let probe = probe.split_once(MARK).map_or(probe.as_str(), |(_, rest)| rest);
    let mut lines = probe.lines().map(str::trim).filter(|l| !l.is_empty());
    let (os, arch) = platform(lines.next().unwrap_or_default());
    let installed: Vec<&str> = lines.collect();
    let local = match local_server_binary(state, &os, &arch) {
        Some(local) => local,
        None => match download_server(state, version, &os, &arch, progress.clone()).await {
            Ok(local) => local,
            // Offline: any build of this version already on the host will do.
            Err(e) => {
                return installed.first().map(|b| b.to_string()).ok_or_else(|| {
                    IdeError::unavailable(format!(
                        "no openidea-server {version} for {os}-{arch} ({}). Build it with \
                         `cargo build --release -p ide-host --bin openidea-server` for that platform and put it at {} \
                         (or set OPENIDEA_SERVER_BINARY)",
                        e.message,
                        state
                            .local_data_dir
                            .join("server")
                            .join(format!("{os}-{arch}"))
                            .join("openidea-server")
                            .display()
                    ))
                });
            }
        },
    };
    // One folder per build, so a rebuilt server of the same version is installed again.
    let build = tokio::task::spawn_blocking({
        let local = local.clone();
        move || build_id(&local)
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))??;
    if let Some(bin) = installed.iter().find(|b| b.ends_with(&format!("/{build}/openidea-server"))) {
        return Ok(bin.to_string());
    }
    let fs = ide_ssh::RemoteFs::new(session.sftp().await?);
    let remote_dir = fs.resolve(&dir).await;
    fs.close().await;
    let remote_dir = remote_dir?;
    let remote_bin = ide_ssh::sftp::join(&ide_ssh::sftp::join(&remote_dir, &build), "openidea-server");
    // Per install: another window may be installing the same build right now.
    let tmp = format!(
        "{remote_bin}.{}-{}.part",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
    );
    let started = std::time::Instant::now();
    progress(RemoteStage::Uploading, Some(0.0));
    session
        .put_with_progress(&tmp, &tokio::fs::read(&local).await?, &|f| progress(RemoteStage::Uploading, Some(f)))
        .await?;
    tracing::info!("installed openidea-server on {} in {:?}", session.label(), started.elapsed());
    let q = ide_ssh::shell::quote;
    // Older builds of this version go (a running one keeps its open file).
    session
        .exec(
            &format!(
                "chmod 755 {tmp} && mv -f {tmp} {bin} && find {dir} -mindepth 1 -maxdepth 1 ! -name {build} -exec rm -rf {{}} +",
                tmp = q(&tmp),
                bin = q(&remote_bin),
                dir = q(&remote_dir),
                build = q(&build),
            ),
            None,
        )
        .await?
        .into_stdout("installing openidea-server")?;
    Ok(remote_bin)
}

/// A short content hash of the server binary (cached per path, size and time).
fn build_id(path: &std::path::Path) -> IdeResult<String> {
    static CACHE: Mutex<Option<(std::path::PathBuf, u64, std::time::SystemTime, String)>> = Mutex::new(None);
    let meta = std::fs::metadata(path)?;
    let modified = meta.modified()?;
    if let Some((p, len, time, id)) = &*CACHE.lock()
        && p == path
        && *len == meta.len()
        && *time == modified
    {
        return Ok(id.clone());
    }
    let id = blake3::hash(&std::fs::read(path)?).to_hex()[..16].to_owned();
    *CACHE.lock() = Some((path.to_path_buf(), meta.len(), modified, id.clone()));
    Ok(id)
}

/// File › Remote Development: opens `path` on the host of SSH configuration
/// `ssh_config` in this window (installs / starts the server as needed).
#[tauri::command]
#[specta::specta]
pub async fn remote_connect(
    window: Window,
    state: State<'_, AppState>,
    ssh_config: String,
    path: String,
    on_progress: Channel<RemoteProgress>,
) -> IdeResult<RemoteProject> {
    let progress: Arc<Progress> = Arc::new(move |stage, fraction| {
        let _ = on_progress.send(RemoteProgress { stage, fraction });
    });
    progress(RemoteStage::Connecting, None);
    let label = AppState::owner_window(window.label()).to_owned();
    state.remote_dev.disconnect(&label);
    state.host.close_project(&label);
    let config = state.ssh.config(&ssh_config)?;
    let session = state.ssh.session(&ssh_config).await?;
    let bin = ensure_server(&state, &session, progress.clone()).await?;
    progress(RemoteStage::Starting, None);
    let stream = session
        .exec_stream(&format!("{} --stdio", ide_ssh::shell::tilde_quote(&bin)))
        .await
        .map_err(|e| IdeError::unavailable(format!("cannot start openidea-server: {e}")))?;
    let (reader, writer) = tokio::io::split(stream);
    let channels: Channels = Arc::default();
    let handler =
        Arc::new(ClientHandler { app: window.app_handle().clone(), window: label.clone(), channels: channels.clone() });
    let peer = Peer::connect(reader, writer, handler);
    let info: ServerInfo = peer
        .request("initialize", serde_json::json!({ "version": ide_host::rpc::PROTOCOL_VERSION }), None)
        .await
        .map_err(ide_host::rpc::error_from_reply)?;
    if info.protocol != ide_host::rpc::PROTOCOL_VERSION {
        return Err(IdeError::unavailable(format!(
            "openidea-server {} speaks protocol {}, this app {}",
            info.version,
            info.protocol,
            ide_host::rpc::PROTOCOL_VERSION
        )));
    }
    let commands: Vec<String> =
        peer.request("commands", Value::Null, None).await.map_err(ide_host::rpc::error_from_reply)?;
    let root = if path.trim().is_empty() || path.trim() == "~" {
        info.home.clone()
    } else if let Some(rest) = path.trim().strip_prefix("~/") {
        format!("{}/{rest}", info.home.trim_end_matches('/'))
    } else {
        path.trim().to_owned()
    };
    progress(RemoteStage::Opening, None);
    let call = Invoke { window: label.clone(), cmd: "open_project".into(), args: serde_json::json!({ "path": root }) };
    let project: ide_host::ops::project::ProjectInfo =
        peer.request("invoke", call, None).await.map_err(ide_host::rpc::error_from_reply)?;
    // As the server resolved it (symlinks, a trailing `/`): the frontend compares it with the project's.
    let root = serde_json::to_value(&project.root).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or(root);
    let _ = window.set_title(&format!("{} [{}]", project.name, config.label()));
    let connection = Arc::new(Connection {
        peer,
        ssh_config: ssh_config.clone(),
        root: root.clone(),
        host: config.label(),
        commands: commands.clone(),
        channels,
        next_channel: std::sync::atomic::AtomicU64::new(1),
        session,
        forwards: Mutex::new(Vec::new()),
    });
    state.remote_dev.0.lock().insert(label.clone(), connection.clone());
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        sync_plugin_languages(&plugins, &connection, &label).await;
        sync_plugin_packages(&plugins, &connection, &label).await;
    });
    Ok(RemoteProject {
        ssh_config,
        root,
        host: config.label(),
        server_version: info.version,
        os: info.os,
        commands,
        project,
    })
}

/// Sends the desktop's plugin languages, with the programs granted to them, to
/// the window's server: `Workspace` contributions take effect where the project
/// is. Servers without the command are left alone.
pub async fn sync_plugin_languages(plugins: &ide_host::plugins::PluginHost, c: &Connection, window: &str) {
    use ide_host::plugins::remote::{SYNC_COMMAND, SyncReport};
    if !c.commands.iter().any(|cmd| cmd == SYNC_COMMAND) {
        return;
    }
    let call = Invoke {
        window: window.to_owned(),
        cmd: SYNC_COMMAND.into(),
        args: serde_json::json!({ "languages": plugins.remote_languages() }),
    };
    match c.peer.request::<_, SyncReport>("invoke", call, None).await {
        Ok(report) => {
            for program in &report.unresolved {
                tracing::info!("{}: plugin program {program} is not installed", c.host);
            }
            for rejected in &report.rejected {
                tracing::warn!("{}: plugin language rejected: {rejected}", c.host);
            }
        }
        Err(e) => tracing::warn!("{}: syncing plugin languages: {e}", c.host),
    }
}

/// Sends the desktop's live code plugins to the window's server, which runs
/// them next to the project: digests and grants first,
/// then the files of the packages the server lacks, one per request.
pub async fn sync_plugin_packages(plugins: &Arc<ide_host::plugins::PluginHost>, c: &Connection, window: &str) {
    use ide_host::plugins::remote_host::{PackageSyncReport, SYNC_PACKAGES};
    if !c.commands.iter().any(|cmd| cmd == SYNC_PACKAGES) {
        return;
    }
    let host = plugins.clone();
    let Ok(packages) = tauri::async_runtime::spawn_blocking(move || host.remote_packages()).await else { return };
    let sync = |files: serde_json::Value| Invoke {
        window: window.to_owned(),
        cmd: SYNC_PACKAGES.into(),
        args: serde_json::json!({ "packages": packages, "files": files }),
    };
    let report: PackageSyncReport = match c.peer.request("invoke", sync(Value::Null), None).await {
        Ok(r) => r,
        Err(e) => return tracing::warn!("{}: syncing plugins: {e}", c.host),
    };
    let mut failed = report.failed;
    for id in report.missing {
        let host = plugins.clone();
        let pid = id.clone();
        let files = match tauri::async_runtime::spawn_blocking(move || host.remote_package_files(&pid)).await {
            Ok(Ok(files)) => files,
            Ok(Err(e)) => {
                failed.push(format!("{id}: {e}"));
                continue;
            }
            Err(e) => {
                failed.push(format!("{id}: {e}"));
                continue;
            }
        };
        match c
            .peer
            .request::<_, PackageSyncReport>("invoke", sync(serde_json::json!({ (id.clone()): files })), None)
            .await
        {
            Ok(r) => failed.extend(r.failed),
            Err(e) => failed.push(format!("{id}: {e}")),
        }
    }
    for f in failed {
        tracing::warn!("{}: plugin not available remotely: {f}", c.host);
    }
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    pub ssh_config: String,
    pub root: String,
    pub host: String,
    pub commands: Vec<String>,
}

/// The remote session of this window (a settings window: its parent's), if any.
#[tauri::command]
#[specta::specta]
pub fn remote_current(window: Window, state: State<'_, AppState>) -> Option<RemoteSession> {
    let c = state.remote_dev.get(AppState::owner_window(window.label()))?;
    Some(RemoteSession {
        ssh_config: c.ssh_config.clone(),
        root: c.root.clone(),
        host: c.host.clone(),
        commands: c.commands.clone(),
    })
}

/// A port of the remote host reachable on this machine at `localhost:local_port`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedPort {
    pub remote_port: u16,
    pub local_port: u16,
}

fn forwarded(c: &Connection) -> Vec<ForwardedPort> {
    c.forwards.lock().iter().map(|(remote, t)| ForwardedPort { remote_port: *remote, local_port: t.port() }).collect()
}

fn connection(window: &Window, state: &AppState) -> IdeResult<Arc<Connection>> {
    state
        .remote_dev
        .get(AppState::owner_window(window.label()))
        .ok_or_else(|| IdeError::unavailable("This window is not connected to a remote host"))
}

/// The remote ports this window forwards to this machine.
#[tauri::command]
#[specta::specta]
pub fn remote_forwarded_ports(window: Window, state: State<'_, AppState>) -> Vec<ForwardedPort> {
    connection(&window, &state).map(|c| forwarded(&c)).unwrap_or_default()
}

/// Forwards `localhost:<remote_port>` of the remote host to the same port here when it is free,
/// else to a free one. Nothing needs to listen there yet; connections are opened per use.
#[tauri::command]
#[specta::specta]
pub async fn remote_forward_port(
    window: Window,
    state: State<'_, AppState>,
    remote_port: u16,
) -> IdeResult<ForwardedPort> {
    if remote_port == 0 {
        return Err(IdeError::invalid("Port must be between 1 and 65535"));
    }
    let c = connection(&window, &state)?;
    if let Some(p) = forwarded(&c).into_iter().find(|p| p.remote_port == remote_port) {
        return Ok(p);
    }
    let tunnel = ide_ssh::Tunnel::listen_on(c.session.clone(), Some(remote_port), "localhost", remote_port).await?;
    let port = ForwardedPort { remote_port, local_port: tunnel.port() };
    let mut forwards = c.forwards.lock();
    if let Some(existing) = forwards.iter().find(|(remote, _)| *remote == remote_port) {
        return Ok(ForwardedPort { remote_port, local_port: existing.1.port() });
    }
    forwards.push((remote_port, tunnel));
    Ok(port)
}

/// Stops forwarding `remote_port`.
#[tauri::command]
#[specta::specta]
pub fn remote_stop_forwarding(window: Window, state: State<'_, AppState>, remote_port: u16) -> IdeResult<()> {
    connection(&window, &state)?.forwards.lock().retain(|(remote, _)| *remote != remote_port);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn remote_disconnect(window: Window, state: State<'_, AppState>) {
    state.remote_dev.disconnect(AppState::owner_window(window.label()));
}

/// Runs a command on the window's remote server; `args` and the result are JSON
/// text. Streaming arguments are `{ "$channel": id }`; their values arrive on
/// `on_channel` tagged with the id.
#[tauri::command]
#[specta::specta]
pub async fn remote_invoke(
    window: Window,
    state: State<'_, AppState>,
    cmd: String,
    args: String,
    on_channel: Channel<ChannelFrame>,
) -> IdeResult<String> {
    let mut args: Value = serde_json::from_str(&args).map_err(|e| IdeError::invalid(format!("arguments: {e}")))?;
    let label = AppState::owner_window(window.label()).to_owned();
    let c = state
        .remote_dev
        .get(&label)
        .ok_or_else(|| IdeError::unavailable("this window is not connected to a remote host"))?;
    if let Value::Object(map) = &mut args {
        for v in map.values_mut() {
            if let Some(id) = v.get("$channel").and_then(Value::as_u64) {
                let own = c.next_channel.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                c.channels.lock().insert(own, (on_channel.clone(), id));
                *v = serde_json::json!({ "$channel": own });
            }
        }
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DocumentEdit {
        doc: ide_core::DocId,
        base_version: u32,
        changes: ide_core::ChangeSet,
    }
    let mirrored = if cmd == "doc_edit" {
        let peers = crate::events::document_edit_peers(window.app_handle(), window.label());
        if peers.is_empty() {
            None
        } else {
            serde_json::from_value::<DocumentEdit>(args.clone()).ok().map(|edit| (peers, edit))
        }
    } else {
        None
    };
    let call = Invoke { window: label, cmd, args };
    let result: Value = c.peer.request("invoke", call, None).await.map_err(ide_host::rpc::error_from_reply)?;
    if let (Some((peers, edit)), Some(version)) =
        (mirrored, result.as_u64().and_then(|version| u32::try_from(version).ok()))
    {
        crate::events::emit_document_edit(
            window.app_handle(),
            peers,
            edit.doc,
            edit.base_version,
            version,
            edit.changes.changes,
        );
    }
    Ok(result.to_string())
}

/// A client OS file belongs to this machine even when its destination is remote.
#[tauri::command]
#[specta::specta]
pub async fn remote_import_local(
    window: Window,
    state: State<'_, AppState>,
    from: std::path::PathBuf,
    to: String,
    request: ide_core::RequestId,
) -> IdeResult<Vec<String>> {
    let label = AppState::owner_window(window.label());
    let c = state.remote_dev.get(label).ok_or_else(|| IdeError::unavailable("Remote project is disconnected"))?;
    c.authorize_command(label, "fs_copy").await?;
    let cancel = state.host.begin_request(request);
    let result = async {
        let fs = ide_ssh::RemoteFs::new(c.session.sftp().await?);
        let result = ide_remote::import::import_local(&fs, &from, &to, &cancel).await;
        fs.close().await;
        result
    }
    .await;
    state.host.end_request(request);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn termux_setup_embeds_key_and_version() {
        let script = termux_setup("ssh-ed25519 AAAA openidea", "1.2.3");
        assert!(script.contains("V=1.2.3\nKEY='ssh-ed25519 AAAA openidea'\n"), "{script}");
        assert!(script.contains(r#"echo "from=\"127.0.0.1\" $KEY""#), "{script}");
        assert!(!script.contains('@'), "{script}");
    }

    #[test]
    fn maps_uname_to_rust_platform_names() {
        assert_eq!(platform("Linux x86_64"), ("linux".into(), "x86_64".into()));
        assert_eq!(platform("Darwin arm64"), ("macos".into(), "aarch64".into()));
        assert_eq!(platform("Linux aarch64"), ("linux".into(), "aarch64".into()));
    }
}
