//! Settings › Tools › MCP Server and the server's requests to the UI (`ide-mcp`).

use crate::state::AppState;
use ide_core::mcp::{
    McpAnswer, McpCallRecord, McpClientConfig, McpClientKind, McpDetectedClient, McpSkillInfo, McpSkillTarget,
    McpStatus, McpToolInfo,
};
use ide_core::{IdeError, IdeEvent, IdeResult, IpcPath};
use ide_mcp::clients::{Paths, Server};
use ide_mcp::skills::SkillRoot;
use std::collections::HashSet;
use tauri::State;

fn paths() -> IdeResult<Paths> {
    let home = dirs::home_dir().ok_or_else(|| IdeError::not_found("no home directory"))?;
    Ok(Paths::system(home))
}

/// The configured endpoint (whether or not the server runs now), as clients reach it.
fn server(state: &AppState) -> IdeResult<Server> {
    Ok(Server {
        port: state.global_settings.effective().mcp.port,
        token: state.mcp.token(),
        // A development build has its own token: it must not replace the installed app's entry.
        name: if cfg!(debug_assertions) { ide_mcp::clients::DEV_SERVER_NAME } else { ide_mcp::clients::SERVER_NAME }
            .into(),
        command: std::env::current_exe()?,
        token_file: crate::mcp::token_file(&state.host.data_dir),
    })
}

fn disabled_tools(state: &AppState) -> HashSet<String> {
    state.global_settings.effective().mcp.disabled_tools.into_iter().collect()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
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

/// The recent tool calls, most recent first.
#[tauri::command]
#[specta::specta]
pub fn mcp_call_history(state: State<'_, AppState>) -> Vec<McpCallRecord> {
    state.mcp.call_history()
}

/// The tools offered under the current settings as Markdown (Exposed Tools › Export).
#[tauri::command]
#[specta::specta]
pub fn mcp_export_tools_markdown(state: State<'_, AppState>) -> String {
    state.mcp.tools_markdown(&state.global_settings.effective().mcp)
}

/// What each supported client needs, and whether its configuration is current.
#[tauri::command]
#[specta::specta]
pub fn mcp_clients(state: State<'_, AppState>) -> IdeResult<Vec<McpClientConfig>> {
    let (server, paths) = (server(&state)?, paths()?);
    Ok(ide_mcp::clients::ALL.iter().map(|k| ide_mcp::clients::config(*k, &server, &paths)).collect())
}

/// Auto-Configure: writes the `openidea` entry into `client`'s user configuration.
#[tauri::command]
#[specta::specta]
pub async fn mcp_configure_client(state: State<'_, AppState>, client: McpClientKind) -> IdeResult<McpClientConfig> {
    let (server, paths) = (server(&state)?, paths()?);
    blocking(move || {
        ide_mcp::clients::configure(client, &server, &paths)?;
        Ok(ide_mcp::clients::config(client, &server, &paths))
    })
    .await
}

/// Writes the `openidea` entry into `client`'s configuration inside `project`
/// (`.mcp.json`, `.cursor/mcp.json`, ...); returns the file.
#[tauri::command]
#[specta::specta]
pub async fn mcp_configure_project_client(
    state: State<'_, AppState>,
    client: McpClientKind,
    project: IpcPath,
) -> IdeResult<IpcPath> {
    let server = server(&state)?;
    blocking(move || Ok(ide_mcp::clients::configure_project(client, &server, &project.0)?.into())).await
}

/// The MCP clients installed for this user (and configured in `project`), with whether
/// their configuration reaches this server or points at a stale port.
#[tauri::command]
#[specta::specta]
pub async fn mcp_detect_clients(
    state: State<'_, AppState>,
    project: Option<IpcPath>,
) -> IdeResult<Vec<McpDetectedClient>> {
    let (server, paths) = (server(&state)?, paths()?);
    blocking(move || Ok(ide_mcp::clients::detect(&server, &paths, project.as_ref().map(|p| p.0.as_path())))).await
}

/// The bundled agent skills, with where they are installed (the user's agent
/// directories, or `project`'s).
#[tauri::command]
#[specta::specta]
pub fn mcp_skills(state: State<'_, AppState>, project: Option<IpcPath>) -> IdeResult<Vec<McpSkillInfo>> {
    let paths = paths()?;
    let root = skill_root(&paths, project.as_ref());
    Ok(ide_mcp::skills::list(root, &disabled_tools(&state)))
}

fn skill_root<'a>(paths: &'a Paths, project: Option<&'a IpcPath>) -> SkillRoot<'a> {
    match project {
        Some(p) => SkillRoot::Project(&p.0),
        None => SkillRoot::User(paths),
    }
}

/// Installs (or updates) bundled skill `id` for `target`; returns the skills afterwards.
#[tauri::command]
#[specta::specta]
pub fn mcp_install_skill(
    state: State<'_, AppState>,
    id: String,
    target: McpSkillTarget,
    project: Option<IpcPath>,
) -> IdeResult<Vec<McpSkillInfo>> {
    let (paths, disabled) = (paths()?, disabled_tools(&state));
    let root = skill_root(&paths, project.as_ref());
    ide_mcp::skills::install(&id, target, root, &disabled)?;
    Ok(ide_mcp::skills::list(root, &disabled))
}

/// Removes bundled skill `id` for `target` (only a copy OpenIDEA installed); returns the skills afterwards.
#[tauri::command]
#[specta::specta]
pub fn mcp_remove_skill(
    state: State<'_, AppState>,
    id: String,
    target: McpSkillTarget,
    project: Option<IpcPath>,
) -> IdeResult<Vec<McpSkillInfo>> {
    let paths = paths()?;
    let root = skill_root(&paths, project.as_ref());
    ide_mcp::skills::remove(&id, target, root)?;
    Ok(ide_mcp::skills::list(root, &disabled_tools(&state)))
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
