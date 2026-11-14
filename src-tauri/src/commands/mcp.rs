//! Agents › MCP Server: runs `ide_mcp::McpServer` over built-in host tools
//! while `mcpServer.enabled` is on, and reports where it listens.

use crate::state::AppState;
use ide_core::{IdeResult, IpcPath};
use ide_host::mcp::{FileProblems, FocusedEditor};
use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{State, Window};

/// The server while it runs, or why it doesn't.
#[derive(Default)]
pub struct McpService {
    server: Mutex<Option<ide_mcp::McpServer>>,
    /// The port and token settings the running server was started with.
    running_with: Mutex<Option<Listen>>,
    error: Mutex<Option<String>>,
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

/// Starts, stops or restarts the server to match the global `mcpServer` settings: `enabled`,
/// and the address, port and token it listens with.
pub fn apply(state: &AppState) {
    let settings = state.global_settings.effective().mcp_server;
    let mut server = state.mcp.server.lock();
    if !settings.enabled {
        if let Some(running) = server.take() {
            running.stop();
        }
        *state.mcp.running_with.lock() = None;
        ide_agent::set_mcp_executable(None);
        state.host.set_mcp_executable(None);
        *state.mcp.error.lock() = None;
        return;
    }
    let Ok(address) = settings.address.trim().parse::<IpAddr>() else {
        if let Some(running) = server.take() {
            running.stop();
        }
        *state.mcp.running_with.lock() = None;
        *state.mcp.error.lock() =
            Some(format!("the listen address `{}` is not an IP address", settings.address.trim()));
        return;
    };
    let wanted = Listen {
        address,
        port: settings.fixed_port.then_some(settings.port).filter(|p| *p != 0),
        fixed_token: settings.fixed_token,
    };
    if server.is_some() && *state.mcp.running_with.lock() == Some(wanted) {
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
        match ide_mcp::kept_token(&ide_mcp::token_path(&state.data_dir)) {
            Ok(token) => Some(token),
            Err(e) => {
                tracing::warn!("MCP server: cannot keep the token ({e}); using a new one for this run");
                None
            }
        }
    } else {
        None
    };
    let discovery = ide_mcp::discovery_path(&state.data_dir);
    match ide_mcp::McpServer::start_with(
        Arc::new(ide_host::mcp::Registry::new(state.host.clone())),
        Some(discovery),
        &state.host.runtime,
        ide_mcp::ServerOptions { address: Some(address), port: wanted.port, token },
    ) {
        Ok(started) => {
            let exe = std::env::current_exe().unwrap_or_default();
            state.host.set_mcp_executable(Some(exe.clone()));
            ide_agent::set_mcp_executable(Some(exe));
            *server = Some(started);
            *state.mcp.running_with.lock() = Some(wanted);
            *state.mcp.error.lock() = None;
        }
        Err(e) => {
            tracing::warn!("MCP server: {e}");
            *state.mcp.running_with.lock() = None;
            *state.mcp.error.lock() = Some(e.to_string());
        }
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

/// Stops the server on exit (its discovery file goes with it).
pub fn stop(state: &AppState) {
    state.host.set_mcp_executable(None);
    ide_agent::set_mcp_executable(None);
    if let Some(server) = state.mcp.server.lock().take() {
        server.stop();
    }
    *state.mcp.running_with.lock() = None;
}

/// What Settings › Agents › MCP Server shows.
#[derive(Serialize, Type)]
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
    /// The window's local project, which the URL and command below are for.
    pub project: Option<IpcPath>,
    /// `http://<address>:<port>/mcp?project=<root>`, with loopback for every address.
    pub url: Option<String>,
    /// Bearer token of `url` (changes with every run unless `mcpServer.fixedToken` is on).
    pub token: Option<String>,
    /// The stdio bridge: this executable and its arguments.
    pub stdio_command: Vec<String>,
}

#[tauri::command]
#[specta::specta]
pub fn mcp_server_status(window: Window, state: State<'_, AppState>) -> IdeResult<McpServerStatus> {
    let root: Option<PathBuf> = state.project(window.label()).ok().map(|p| p.root.clone());
    let server = state.mcp.server.lock();
    let exe = std::env::current_exe().unwrap_or_default();
    Ok(McpServerStatus {
        running: server.is_some(),
        error: state.mcp.error.lock().clone(),
        address: server.as_ref().map(|s| s.address().to_string()),
        port: server.as_ref().map(|s| s.port()),
        port_unavailable: server.as_ref().and_then(|s| s.port_unavailable().map(str::to_owned)),
        url: server.as_ref().zip(root.as_ref()).map(|(s, r)| s.url(r)),
        token: server.as_ref().map(|s| s.token().to_owned()),
        stdio_command: root.as_ref().map(|r| ide_mcp::stdio_command(&exe, r)).unwrap_or_default(),
        project: root.map(IpcPath::from),
    })
}

/// Settings › Agents › MCP Server › Regenerate Token: forgets the kept token, and restarts the
/// server with a new one. Clients configured with the old token stop working.
#[tauri::command]
#[specta::specta]
pub fn mcp_regenerate_token(state: State<'_, AppState>) -> IdeResult<()> {
    match std::fs::remove_file(ide_mcp::token_path(&state.data_dir)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    *state.mcp.running_with.lock() = None;
    apply(&state);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn mcp_set_open_editors(window: Window, state: State<'_, AppState>, paths: Vec<IpcPath>) -> IdeResult<()> {
    state.project(window.label())?;
    state.host.mcp_reports.set_open_editors(window.label(), paths.into_iter().map(PathBuf::from).collect());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn mcp_set_focused_editor(
    window: Window,
    state: State<'_, AppState>,
    editor: Option<FocusedEditor>,
    focused: bool,
) -> IdeResult<()> {
    state.project(window.label())?;
    state.host.mcp_reports.set_focused_editor(window.label(), editor, focused);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn mcp_report_problems(
    window: Window,
    state: State<'_, AppState>,
    reset: bool,
    files: Vec<FileProblems>,
) -> IdeResult<()> {
    state.project(window.label())?;
    state.host.mcp_reports.report_problems(window.label(), reset, files);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn mcp_ui_ready(window: Window, state: State<'_, AppState>, ready: bool) -> IdeResult<()> {
    state.project(window.label())?;
    state.host.mcp_requests.set_ready(window.label(), ready);
    Ok(())
}

/// The user closed the Run tool window tab of an agent command (`run_command`).
#[tauri::command]
#[specta::specta]
pub fn mcp_agent_run_closed(window: Window, state: State<'_, AppState>, name: String) -> IdeResult<()> {
    let project = state.project(window.label())?;
    state.host.mcp_agent_runs.closed(&project.root, &name);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn mcp_respond(
    window: Window,
    state: State<'_, AppState>,
    id: u32,
    allow: bool,
    error: Option<String>,
) -> IdeResult<()> {
    state.host.mcp_requests.answer(window.label(), id, allow, error)
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
