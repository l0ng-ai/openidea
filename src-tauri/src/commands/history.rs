//! IPC commands of `ide_host::ops::history` (the shared implementation).

use crate::state::AppState;
use ide_core::IdeResult;
#[allow(unused_imports)]
pub use ide_host::ops::history::*;
use ide_workspace::DirectoryHistory;
use std::path::PathBuf;
use tauri::{State, Window};

/// Show History on a folder: snapshots of the files under it (deleted ones included) and labels.
#[tauri::command]
#[specta::specta]
pub async fn history_list_dir(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
) -> IdeResult<DirectoryHistory> {
    ide_host::ops::history::history_list_dir(&state.host, window.label(), path).await
}

/// Local History › Put Label…: a named point in the history of every file.
#[tauri::command]
#[specta::specta]
pub fn history_put_label(window: Window, state: State<'_, AppState>, label: String) -> IdeResult<()> {
    ide_host::ops::history::history_put_label(&state.host, window.label(), label)
}

/// Revert to a snapshot: writes its content to `path` (re-creating a deleted
/// file and its folders); an open editor updates in place.
#[tauri::command]
#[specta::specta]
pub async fn history_restore(window: Window, state: State<'_, AppState>, path: PathBuf, id: String) -> IdeResult<()> {
    ide_host::ops::history::history_restore(&state.host, window.label(), path, id).await
}
