use crate::state::AppState;
use ide_core::IdeResult;
use ide_host::ops::fs;
use ide_vfs::FileEntry;
use std::path::PathBuf;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub fn fs_read_dir(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<Vec<FileEntry>> {
    fs::read_dir(&state.host, window.label(), path)
}

/// Creates an empty file; inside a project, honours the EditorConfig
/// `charset` (writes the BOM for `utf-8-bom` / UTF-16).
#[tauri::command]
#[specta::specta]
pub fn fs_create_file(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    fs::create_file(&state.host, window.label(), path)
}

#[tauri::command]
#[specta::specta]
pub fn fs_create_dir(path: PathBuf) -> IdeResult<()> {
    ide_vfs::create_dir(&path)
}

#[tauri::command]
#[specta::specta]
pub fn fs_rename(from: PathBuf, to: PathBuf) -> IdeResult<()> {
    ide_vfs::rename(&from, &to)
}

/// Toggle Read-only Attribute: sets the writable bit (and the open document's
/// state). Returns whether the file is read-only now.
#[tauri::command]
#[specta::specta]
pub fn fs_set_writable(window: Window, state: State<'_, AppState>, path: PathBuf, writable: bool) -> IdeResult<bool> {
    fs::set_writable(&state.host, window.label(), path, writable)
}

/// Moving to the trash can take a while (large trees): kept off the main thread.
#[tauri::command]
#[specta::specta]
pub async fn fs_delete(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    fs::delete(&state.host, window.label(), path).await
}

#[tauri::command]
#[specta::specta]
pub async fn fs_copy(state: State<'_, AppState>, from: PathBuf, to: PathBuf) -> IdeResult<()> {
    fs::copy(&state.host, from, to).await
}

/// Reads a text file without opening it as a document (previews, quick
/// definition). Prefers the unsaved buffer when the file is open.
#[tauri::command]
#[specta::specta]
pub async fn fs_read_text(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<String> {
    fs::read_text(&state.host, window.label(), path).await
}
