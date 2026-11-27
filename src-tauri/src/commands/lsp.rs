//! IPC commands of `ide_host::ops::lsp` (the shared implementation).

use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::IdeResult;
use tauri::State;

/// Restarts the language servers named `name` in every open project (after a tool update).
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn lsp_restart_named(state: State<'_, AppState>, name: String) -> IdeResult<()> {
    ide_host::ops::lsp::lsp_restart_named(&state.host, &name).await
}

ide_command::desktop_domain!(lsp_restart_named);
