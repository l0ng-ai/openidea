//! Settings › Tools › MCP Server and the server's requests to the UI (`ide-mcp`).

use crate::state::AppState;
use ide_core::mcp::{McpAnswer, McpClientConfig, McpClientKind, McpStatus, McpToolInfo};
use ide_core::{IdeError, IdeEvent, IdeResult};
use tauri::State;

fn home() -> IdeResult<std::path::PathBuf> {
    dirs::home_dir().ok_or_else(|| IdeError::not_found("no home directory"))
}

/// The configured endpoint (whether or not the server runs now) and the token.
fn endpoint(state: &AppState) -> (String, String) {
    let port = state.global_settings.effective().mcp.port;
    (ide_mcp::endpoint_url(port), state.mcp.token())
}

#[tauri::command]
#[specta::specta]
pub fn mcp_status(state: State<'_, AppState>) -> McpStatus {
    state.mcp.status()
}

/// Every tool, with whether Settings disabled it.
#[tauri::command]
#[specta::specta]
pub fn mcp_tools(state: State<'_, AppState>) -> Vec<McpToolInfo> {
    state.mcp.tools(&state.global_settings.effective().mcp)
}

/// What each supported client needs, and whether its configuration is current.
#[tauri::command]
#[specta::specta]
pub fn mcp_clients(state: State<'_, AppState>) -> IdeResult<Vec<McpClientConfig>> {
    let (url, token) = endpoint(&state);
    let home = home()?;
    Ok(ide_mcp::clients::ALL.iter().map(|k| ide_mcp::clients::config(*k, &url, &token, &home)).collect())
}

/// Auto-Configure: writes the `openidea` entry into `client`'s user configuration.
#[tauri::command]
#[specta::specta]
pub async fn mcp_configure_client(state: State<'_, AppState>, client: McpClientKind) -> IdeResult<McpClientConfig> {
    let (url, token) = endpoint(&state);
    let home = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        ide_mcp::clients::configure(client, &url, &token, &home)?;
        Ok(ide_mcp::clients::config(client, &url, &token, &home))
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Replaces the token; configured clients need the new one.
#[tauri::command]
#[specta::specta]
pub fn mcp_regenerate_token(state: State<'_, AppState>) -> IdeResult<()> {
    let data_dir = state.host.data_dir.clone();
    let token = ide_mcp::write_new_token(&crate::mcp::token_file(&data_dir))?;
    state.mcp.set_token(token);
    state.sink.emit(IdeEvent::McpStatusChanged { status: state.mcp.status() });
    Ok(())
}

/// A window's answer to `IdeEvent::McpRequest { id }`.
#[tauri::command]
#[specta::specta]
pub fn mcp_respond(state: State<'_, AppState>, id: u64, answer: McpAnswer) {
    state.mcp_pending.answer(id, answer);
    state.sink.emit(IdeEvent::McpRequestDone { id });
}
