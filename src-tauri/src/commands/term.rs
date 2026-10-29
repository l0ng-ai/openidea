use crate::state::AppState;
use ide_core::{IdeResult, TerminalId};
use ide_terminal::{TerminalInfo, TerminalOptions};
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Async to stay off the main thread: forking the IDE (its whole address space)
/// to start the shell takes tens of milliseconds, a frozen UI if run there.
#[tauri::command]
#[specta::specta]
pub async fn term_spawn(
    window: Window,
    state: State<'_, AppState>,
    options: TerminalOptions,
    on_output: Channel<String>,
) -> IdeResult<TerminalInfo> {
    ide_host::ops::term::spawn(
        &state.host,
        window.label(),
        options,
        std::sync::Arc::new(move |chunk| {
            let _ = on_output.send(chunk);
        }),
    )
}

#[tauri::command]
#[specta::specta]
pub fn term_write(state: State<'_, AppState>, id: TerminalId, data: String) -> IdeResult<()> {
    state.terminals.write(id, &data)
}

#[tauri::command]
#[specta::specta]
pub fn term_resize(state: State<'_, AppState>, id: TerminalId, cols: u16, rows: u16) -> IdeResult<()> {
    state.terminals.resize(id, cols, rows)
}

#[tauri::command]
#[specta::specta]
pub fn term_kill(state: State<'_, AppState>, id: TerminalId) -> IdeResult<()> {
    state.terminals.kill(id)
}

/// Whether the session is running a command (closing its tab asks first). A
/// `tcgetpgrp` or one process snapshot: async only to stay off the main thread.
#[tauri::command]
#[specta::specta]
pub async fn term_is_busy(state: State<'_, AppState>, id: TerminalId) -> IdeResult<bool> {
    state.terminals.is_busy(id)
}

/// Shell used when Settings › Terminal › Shell path is empty.
#[tauri::command]
#[specta::specta]
pub fn term_default_shell() -> String {
    ide_terminal::default_shell_path()
}

/// Installed shells for the Terminal's "New Predefined Session" menu.
#[tauri::command]
#[specta::specta]
pub fn term_available_shells() -> Vec<String> {
    ide_terminal::available_shells()
}
