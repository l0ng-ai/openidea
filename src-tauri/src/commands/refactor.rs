//! IPC commands of `ide_host::ops::refactor` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, RequestId, WorkspaceEdit};
#[allow(unused_imports)]
pub use ide_host::ops::refactor::*;
use ide_lsp::types::FileRenameEdits;
use ide_workspace::{FileMove, UndoOutcome};
use tauri::{State, Window};

/// `workspace/willRenameFiles` on every interested server (before the move). Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn refactor_file_move_edits(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<FileRenameEdits> {
    ide_host::ops::refactor::refactor_file_move_edits(&state.host, window.label(), request, moves).await
}

/// Applies `edit` (from [`refactor_file_move_edits`], possibly empty), moves the
/// files and notifies the servers. Returns the id for [`refactor_undo_file_move`].
#[tauri::command]
#[specta::specta]
pub async fn refactor_move_files(
    window: Window,
    state: State<'_, AppState>,
    moves: Vec<FileMove>,
    edit: WorkspaceEdit,
    label: String,
) -> IdeResult<u32> {
    ide_host::ops::refactor::refactor_move_files(&state.host, window.label(), moves, edit, label).await
}

/// Undoes a file move: moves back and reverts the reference updates.
#[tauri::command]
#[specta::specta]
pub async fn refactor_undo_file_move(window: Window, state: State<'_, AppState>, id: u32) -> IdeResult<UndoOutcome> {
    ide_host::ops::refactor::refactor_undo_file_move(&state.host, window.label(), id).await
}

/// Whether the file move `id` can still be undone.
#[tauri::command]
#[specta::specta]
pub fn refactor_can_undo_file_move(window: Window, state: State<'_, AppState>, id: u32) -> IdeResult<bool> {
    ide_host::ops::refactor::refactor_can_undo_file_move(&state.host, window.label(), id)
}

/// "Search in comments and strings": textual occurrences of the moved files'
/// names, qualified names and paths (before the move). Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn refactor_file_move_text_edits(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<WorkspaceEdit> {
    ide_host::ops::refactor::refactor_file_move_text_edits(&state.host, window.label(), request, moves).await
}
