use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::IdeResult;
use ide_host::ops::fs;
use std::path::PathBuf;
use tauri::{State, Window};

/// Opens a project file with its default application (Office, PDF readers). The checks run here,
/// in the backend, instead of widening the webview's opener permissions: the window must be a
/// trusted local project and the file must lie inside it.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn fs_open_with_system(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    if state.remote_dev.get(window.label()).is_some() {
        return Err(ide_core::IdeError::unavailable("files of a remote window open on their own machine"));
    }
    let target = fs::system_open_target(&state.host, window.label(), path)?;
    state
        .host
        .blocking(move || {
            tauri_plugin_opener::open_path(&target, None::<&str>)
                .map_err(|e| ide_core::IdeError::internal(format!("cannot open with the system application: {e}")))
        })
        .await
}

ide_command::desktop_domain!(fs_open_with_system);
