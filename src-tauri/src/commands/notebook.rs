//! Thin desktop adapters for the shared native notebook service.
use crate::state::AppState;
use ide_core::{IdeResult, RequestId};
use ide_host::ops::notebook::{self, NotebookOutputEvent};
use ide_notebook::{NotebookEdit, NotebookSnapshot};
use tauri::ipc::Channel;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub async fn notebook_open(window: Window, state: State<'_, AppState>, path: String) -> IdeResult<NotebookSnapshot> {
    notebook::notebook_open(&state.host, window.label(), path).await
}

#[tauri::command]
#[specta::specta]
pub fn notebook_get(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<NotebookSnapshot> {
    notebook::notebook_get(&state.host, window.label(), id)
}

#[tauri::command]
#[specta::specta]
pub fn notebook_cell_docs(
    window: Window,
    state: State<'_, AppState>,
    id: String,
) -> IdeResult<Vec<ide_lsp::NotebookCellDoc>> {
    notebook::notebook_cell_docs(&state.host, window.label(), id)
}

#[tauri::command]
#[specta::specta]
pub async fn notebook_edit(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    version: u32,
    edit: NotebookEdit,
) -> IdeResult<NotebookSnapshot> {
    notebook::notebook_edit(&state.host, window.label(), id, version, edit).await
}

#[tauri::command]
#[specta::specta]
pub async fn notebook_save(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<NotebookSnapshot> {
    notebook::notebook_save(&state.host, window.label(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn notebook_reload(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<NotebookSnapshot> {
    notebook::notebook_reload(&state.host, window.label(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn notebook_undo(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<NotebookSnapshot> {
    notebook::notebook_undo(&state.host, window.label(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn notebook_redo(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<NotebookSnapshot> {
    notebook::notebook_redo(&state.host, window.label(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn notebook_close(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    notebook::notebook_close(&state.host, window.label(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn notebook_interrupt(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    notebook::notebook_interrupt(&state.host, window.label(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn notebook_restart(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<NotebookSnapshot> {
    notebook::notebook_restart(&state.host, window.label(), id).await
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn notebook_execute(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    cells: Vec<String>,
    python: Option<String>,
    request: RequestId,
    on_output: Channel<NotebookOutputEvent>,
) -> IdeResult<NotebookSnapshot> {
    notebook::notebook_execute(&state.host, window.label(), id, cells, python, request, super::sender(on_output)).await
}
