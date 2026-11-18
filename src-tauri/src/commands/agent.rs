//! IPC commands of `ide_host::ops::agent` (the shared implementation).

use crate::state::AppState;
use ide_agent::{AcpImportOutcome, CustomAgentInput};
use ide_command::desktop_command;
use ide_core::IdeResult;
use ide_host::ops::agent;
use tauri::{State, Window};

/// Saves a new custom ACP agent through its agent file; refuses built-in and
/// ACP Registry ids and taken ids.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub fn agent_custom_save(window: Window, state: State<'_, AppState>, input: CustomAgentInput) -> IdeResult<()> {
    agent::save_custom_agent(&state.host, window.label(), input)
}

/// Removes a custom agent's file (registry installs go through `agent_registry_remove`).
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub fn agent_custom_remove(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    agent::remove_custom_agent(&state.host, window.label(), id)
}

/// Imports a JetBrains `acp.json` file's `agent_servers` entries as custom agents.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub fn agent_custom_import(
    window: Window,
    state: State<'_, AppState>,
    text: String,
) -> IdeResult<Vec<AcpImportOutcome>> {
    agent::import_acp_agents(&state.host, window.label(), text)
}

ide_command::desktop_domain!(agent_custom_import, agent_custom_remove, agent_custom_save);
