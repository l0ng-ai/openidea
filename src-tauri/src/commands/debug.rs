//! IPC commands of `ide_host::ops::debug` (the shared implementation).

use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::{DebugSessionId, IdeResult};
use tauri::State;

#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn debug_hot_reload(state: State<'_, AppState>, session: DebugSessionId) -> IdeResult<()> {
    ide_host::ops::debug::debug_hot_reload(&state.host, session).await
}

#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn debug_hot_restart(state: State<'_, AppState>, session: DebugSessionId) -> IdeResult<()> {
    ide_host::ops::debug::debug_hot_restart(&state.host, session).await
}

ide_command::desktop_domain!(debug_hot_reload, debug_hot_restart);
