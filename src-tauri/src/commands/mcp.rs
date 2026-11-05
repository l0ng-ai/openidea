//! Tools › MCP Server: runs `ide_mcp::McpServer` over the plugins' MCP tools
//! while `mcpServer.enabled` is on, and reports where it listens.

use crate::state::AppState;
use ide_core::IpcPath;
use ide_host::plugins::McpServerInfo;
use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use std::path::PathBuf;
use tauri::{State, Window};

/// The server while it runs, or why it doesn't.
#[derive(Default)]
pub struct McpService {
    server: Mutex<Option<ide_mcp::McpServer>>,
    error: Mutex<Option<String>>,
}

/// Starts or stops the server to match the global `mcpServer.enabled`.
pub fn apply(state: &AppState) {
    let enabled = state.global_settings.effective().mcp_server.enabled;
    let mut server = state.mcp.server.lock();
    if enabled == server.is_some() {
        return;
    }
    if let Some(running) = server.take() {
        running.stop();
        state.plugins.set_mcp_server(None);
        return;
    }
    let discovery = ide_mcp::discovery_path(&state.data_dir);
    match ide_mcp::McpServer::start(state.plugins.mcp_registry(), Some(discovery), &state.host.runtime) {
        Ok(started) => {
            let exe = std::env::current_exe().unwrap_or_default();
            state.plugins.set_mcp_server(Some(McpServerInfo {
                port: started.port(),
                token: started.token().to_owned(),
                exe,
            }));
            *server = Some(started);
            *state.mcp.error.lock() = None;
        }
        Err(e) => {
            tracing::warn!("MCP server: {e}");
            *state.mcp.error.lock() = Some(e.to_string());
        }
    }
}

/// Stops the server on exit (its discovery file goes with it).
pub fn stop(state: &AppState) {
    if let Some(server) = state.mcp.server.lock().take() {
        server.stop();
    }
}

/// What Settings › Tools › MCP Server shows.
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub running: bool,
    /// Why it isn't running though turned on.
    pub error: Option<String>,
    pub port: Option<u16>,
    /// The window's local project, which the URL and command below are for.
    pub project: Option<IpcPath>,
    /// `http://127.0.0.1:<port>/mcp?project=<root>`.
    pub url: Option<String>,
    /// Bearer token of `url` (changes with every run).
    pub token: Option<String>,
    /// The stdio bridge: this executable and its arguments.
    pub stdio_command: Vec<String>,
}

#[tauri::command]
#[specta::specta]
pub fn mcp_server_status(window: Window, state: State<'_, AppState>) -> McpServerStatus {
    let root: Option<PathBuf> = state.project(window.label()).ok().map(|p| p.root.clone());
    let server = state.mcp.server.lock();
    let exe = std::env::current_exe().unwrap_or_default();
    McpServerStatus {
        running: server.is_some(),
        error: state.mcp.error.lock().clone(),
        port: server.as_ref().map(|s| s.port()),
        url: server.as_ref().zip(root.as_ref()).map(|(s, r)| s.url(r)),
        token: server.as_ref().map(|s| s.token().to_owned()),
        stdio_command: root.as_ref().map(|r| ide_mcp::stdio_command(&exe, r)).unwrap_or_default(),
        project: root.map(IpcPath::from),
    }
}
