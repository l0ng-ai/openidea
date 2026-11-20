//! Agents › IDE MCP Server: runs `ide_mcp::McpServer` over built-in host tools
//! while `mcpServer.enabled` is on, and reports where it listens.

use super::McpBackgroundProject;
use crate::Host;
use ide_command::command;
use ide_core::{IdeResult, IpcPath};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

/// The server while it runs, or why it doesn't.
#[derive(Default)]
pub struct McpService {
    server: Mutex<Option<ide_mcp::McpServer>>,
    /// The address, port and token settings the running server was started with.
    running_with: Mutex<Option<Listen>>,
    error: Mutex<Option<String>>,
    /// A link to this executable advertised for `--mcp-stdio` instead of `current_exe()`.
    stdio_link: RwLock<Option<PathBuf>>,
}

/// What the address, port and token settings ask the server for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Listen {
    /// `mcpServer.address`.
    address: IpAddr,
    /// `mcpServer.port` with `mcpServer.fixedPort`; otherwise a free port.
    port: Option<u16>,
    fixed_token: bool,
}

impl McpService {
    /// Advertises `link` in `--mcp-stdio` client configs and agent sessions, pointed at this
    /// executable whenever the server starts. Without one (or where it can't be written),
    /// `current_exe()` is advertised.
    pub fn set_stdio_link(&self, link: PathBuf) {
        *self.stdio_link.write() = Some(link);
    }

    pub(crate) fn stdio_executable(&self) -> PathBuf {
        self.stdio_link.read().clone().or_else(|| std::env::current_exe().ok()).unwrap_or_default()
    }

    fn update_stdio_link(&self) {
        let mut link = self.stdio_link.write();
        if let Some(path) = link.as_deref()
            && let Err(e) = point_at_current_exe(path)
        {
            tracing::warn!("MCP server: cannot link {} ({e}); advertising this executable", path.display());
            *link = None;
        }
    }

    /// Starts, stops or restarts the server to match the global `mcpServer` settings:
    /// `enabled`, and the address, port and token it listens with.
    pub fn apply(&self, host: &Arc<Host>) {
        // Callers include the main thread (sync commands, app set-up), which must not wait for
        // a background project that is being opened.
        let worker = {
            let host = host.clone();
            host.runtime.clone().spawn_blocking(move || host.apply_background_policy())
        };
        host.runtime.spawn(async move {
            if let Err(error) = worker.await {
                tracing::warn!(%error, "applying the background project policy failed");
            }
        });
        let settings = host.global_settings.effective().mcp_server;
        let mut server = self.server.lock();
        if !settings.enabled {
            let was_running = server.take();
            let stopped = was_running.is_some();
            if let Some(running) = was_running {
                running.stop();
            }
            *self.running_with.lock() = None;
            host.set_mcp_executable(None);
            *self.error.lock() = None;
            drop(server);
            if stopped {
                for project in host.projects() {
                    project.agents.notify_mcp_servers_changed();
                }
            }
            return;
        }
        let Ok(address) = settings.address.trim().parse::<IpAddr>() else {
            let stopped = server.take().map(|running| running.stop()).is_some();
            *self.running_with.lock() = None;
            host.set_mcp_executable(None);
            *self.error.lock() = Some(format!("the listen address `{}` is not an IP address", settings.address.trim()));
            drop(server);
            if stopped {
                for project in host.projects() {
                    project.agents.notify_mcp_servers_changed();
                }
            }
            return;
        };
        let wanted = Listen {
            address,
            port: settings.fixed_port.then_some(settings.port).filter(|p| *p != 0),
            fixed_token: settings.fixed_token,
        };
        if server.is_some() && *self.running_with.lock() == Some(wanted) {
            return;
        }
        // Another address, port or token: clients connect anew.
        if let Some(running) = server.take() {
            let held = (running.address(), running.port());
            running.stop();
            if let Some(port) = port_to_wait_for(held, wanted.port) {
                wait_until_free(address, port);
            }
        }
        let token = if wanted.fixed_token {
            match ide_mcp::kept_token(&ide_mcp::token_path(&host.data_dir)) {
                Ok(token) => Some(token),
                Err(e) => {
                    tracing::warn!("MCP server: cannot keep the token ({e}); using a new one for this run");
                    None
                }
            }
        } else {
            None
        };
        let discovery = ide_mcp::discovery_path(&host.data_dir);
        match ide_mcp::McpServer::start_with(
            Arc::new(crate::mcp::Registry::new(host.clone())),
            Some(discovery),
            &host.runtime,
            ide_mcp::ServerOptions { address: Some(address), port: wanted.port, token },
        ) {
            Ok(started) => {
                self.update_stdio_link();
                host.set_mcp_executable(Some(self.stdio_executable()));
                *server = Some(started);
                *self.running_with.lock() = Some(wanted);
                *self.error.lock() = None;
                drop(server);
                for project in host.projects() {
                    project.agents.notify_mcp_servers_changed();
                }
            }
            Err(e) => {
                tracing::warn!("MCP server: {e}");
                host.set_mcp_executable(None);
                *self.running_with.lock() = None;
                *self.error.lock() = Some(e.to_string());
            }
        }
    }

    /// Stops the server on exit (its discovery file goes with it).
    pub fn stop(&self, host: &Host) {
        host.set_mcp_executable(None);
        if let Some(server) = self.server.lock().take() {
            server.stop();
        }
        *self.running_with.lock() = None;
    }
}

/// Replaces the symlink `link` with one to this executable.
fn point_at_current_exe(link: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let exe = std::env::current_exe()?;
        let dir = link.parent().ok_or_else(|| std::io::Error::other("no parent directory"))?;
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".openidea-server.{}", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        std::os::unix::fs::symlink(&exe, &tmp)?;
        std::fs::rename(&tmp, link).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    }
    #[cfg(not(unix))]
    {
        let _ = link;
        Err(std::io::ErrorKind::Unsupported.into())
    }
}

/// The port a restart listening on `wanted` waits for after stopping the server that listened
/// on `held`: only its own, at any address (`127.0.0.1` and `0.0.0.0` overlap). A port another
/// program holds (the run fell back to a free one) stays taken, and waiting for it would block
/// the window.
fn port_to_wait_for(held: (IpAddr, u16), wanted: Option<u16>) -> Option<u16> {
    wanted.filter(|port| held.1 == *port)
}

/// Waits briefly for a stopped server's port to close, so the restart gets it again.
fn wait_until_free(address: IpAddr, port: u16) {
    for _ in 0..100 {
        if std::net::TcpListener::bind((address, port)).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// What Settings › Agents › IDE MCP Server shows.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub running: bool,
    /// Why it isn't running though turned on.
    pub error: Option<String>,
    /// The address listened on (`0.0.0.0` / `::`: every address).
    pub address: Option<String>,
    pub port: Option<u16>,
    /// Why the fixed port (`mcpServer.port`) isn't the one listened on: it was in use or
    /// reserved, so a free port was taken for this run.
    pub port_unavailable: Option<String>,
    /// The window's project, which the URL and command below are for.
    pub project: Option<IpcPath>,
    /// `http://<address>:<port>/mcp?project=<root>`, with loopback for every address.
    pub url: Option<String>,
    /// Bearer token of `url` (changes with every run unless `mcpServer.fixedToken` is on).
    pub token: Option<String>,
    /// The stdio bridge: this host's executable and its arguments.
    pub stdio_command: Vec<String>,
}

#[command(trust = outside_restricted)]
pub fn mcp_server_status(host: &Host, window: &str) -> IdeResult<McpServerStatus> {
    let root: Option<PathBuf> = host.project(window).ok().filter(|p| !p.light).map(|p| p.root.clone());
    let server = host.mcp.server.lock();
    let exe = host.mcp.stdio_executable();
    Ok(McpServerStatus {
        running: server.is_some(),
        error: host.mcp.error.lock().clone(),
        address: server.as_ref().map(|s| s.address().to_string()),
        port: server.as_ref().map(|s| s.port()),
        port_unavailable: server.as_ref().and_then(|s| s.port_unavailable().map(str::to_owned)),
        url: server.as_ref().zip(root.as_ref()).map(|(s, r)| s.url(r)),
        token: server.as_ref().map(|s| s.token().to_owned()),
        stdio_command: root.as_ref().map(|r| ide_mcp::stdio_command(&exe, r)).unwrap_or_default(),
        project: root.map(IpcPath::from),
    })
}

/// Settings › Agents › IDE MCP Server › Regenerate Token: forgets the kept token, and restarts the
/// server with a new one. Clients configured with the old token stop working.
#[command(trust = outside_restricted)]
pub fn mcp_regenerate_token(host: &Arc<Host>) -> IdeResult<()> {
    match std::fs::remove_file(ide_mcp::token_path(&host.data_dir)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    *host.mcp.running_with.lock() = None;
    host.mcp.apply(host);
    Ok(())
}

/// Settings › Agents › IDE MCP Server › Background projects: the projects this host's server
/// keeps loaded without a window.
#[command(trust = always)]
pub fn mcp_background_projects(host: &Host) -> IdeResult<Vec<McpBackgroundProject>> {
    Ok(host.mcp_background.snapshot(host, Instant::now()))
}

/// Unloads one background project; a root that is not loaded is already unloaded.
#[command(trust = always)]
pub async fn mcp_unload_background_project(host: &Arc<Host>, root: IpcPath) -> IdeResult<()> {
    let h = host.clone();
    host.blocking(move || {
        h.mcp_background.detach(&h, &root, None);
        Ok(())
    })
    .await
}

#[command(trust = trusted)]
pub fn mcp_ui_ready(host: &Host, window: &str, ready: bool) -> IdeResult<()> {
    let window = host.owner_window(window);
    host.project(window)?;
    host.mcp_requests.set_ready(window, ready);
    Ok(())
}

/// The user closed the Run tool window tab of an agent command (`run_command`).
#[command(trust = trusted)]
pub fn mcp_agent_run_closed(host: &Host, window: &str, name: String) -> IdeResult<()> {
    let project = host.project(window)?;
    host.mcp_agent_runs.closed(&project.root, &name);
    Ok(())
}

#[command(trust = trusted)]
pub fn mcp_respond(host: &Host, window: &str, id: u32, allow: bool, error: Option<String>) -> IdeResult<()> {
    host.mcp_requests.answer(host.owner_window(window), id, allow, error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn a_restart_waits_only_for_the_port_the_stopped_server_held() {
        let local = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let any = IpAddr::V4(Ipv4Addr::UNSPECIFIED);
        assert_eq!(port_to_wait_for((local, 64342), Some(64342)), Some(64342));
        // Another address on the same port overlaps the old listener: wait for it too.
        assert_eq!(port_to_wait_for((any, 64342), Some(64342)), Some(64342));
        // The fixed port was taken by another program: the server ran on a free one.
        assert_eq!(port_to_wait_for((local, 51234), Some(64342)), None);
        assert_eq!(port_to_wait_for((local, 64342), None), None);
    }
}

ide_command::domain!(
    mcp:
    mcp_agent_run_closed,
    mcp_background_projects,
    mcp_regenerate_token,
    mcp_respond,
    mcp_server_status,
    mcp_ui_ready,
    mcp_unload_background_project,
);
