//! Agents › MCP Server: runs `ide_mcp::McpServer` over built-in host tools
//! while `mcpServer.enabled` is on, and reports where it listens.

use crate::state::AppState;
use ide_core::{IdeResult, IpcPath};
use ide_host::mcp::{FileProblems, FocusedEditor};
use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use std::path::PathBuf;
use std::sync::Arc;
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
    if !enabled {
        if let Some(running) = server.take() {
            running.stop();
        }
        ide_agent::set_mcp_executable(None);
        state.host.set_mcp_executable(None);
        *state.mcp.error.lock() = None;
        return;
    }
    if server.is_some() {
        return;
    }
    let discovery = ide_mcp::discovery_path(&state.data_dir);
    match ide_mcp::McpServer::start(
        Arc::new(ide_host::mcp::Registry::new(state.host.clone())),
        Some(discovery),
        &state.host.runtime,
    ) {
        Ok(started) => {
            let exe = std::env::current_exe().unwrap_or_default();
            state.host.set_mcp_executable(Some(exe.clone()));
            ide_agent::set_mcp_executable(Some(exe));
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
    state.host.set_mcp_executable(None);
    ide_agent::set_mcp_executable(None);
    if let Some(server) = state.mcp.server.lock().take() {
        server.stop();
    }
}

/// What Settings › Agents › MCP Server shows.
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
pub fn mcp_server_status(window: Window, state: State<'_, AppState>) -> IdeResult<McpServerStatus> {
    let root: Option<PathBuf> = state.project(window.label()).ok().map(|p| p.root.clone());
    let server = state.mcp.server.lock();
    let exe = std::env::current_exe().unwrap_or_default();
    Ok(McpServerStatus {
        running: server.is_some(),
        error: state.mcp.error.lock().clone(),
        port: server.as_ref().map(|s| s.port()),
        url: server.as_ref().zip(root.as_ref()).map(|(s, r)| s.url(r)),
        token: server.as_ref().map(|s| s.token().to_owned()),
        stdio_command: root.as_ref().map(|r| ide_mcp::stdio_command(&exe, r)).unwrap_or_default(),
        project: root.map(IpcPath::from),
    })
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
