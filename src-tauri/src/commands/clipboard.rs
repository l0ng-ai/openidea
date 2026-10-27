//! The OS clipboard's file list, so the project view and Explorer exchange files.

use crate::commands::doc::blocking;
use ide_core::IdeResult;
use std::path::{Path, PathBuf};

/// Absolute paths on the clipboard, empty when it holds no file list.
#[tauri::command]
#[specta::specta]
pub async fn clipboard_file_list() -> IdeResult<Vec<String>> {
    blocking(|| Ok(ide_clipboard::files().iter().map(|p| slash(p)).collect())).await
}

/// Whether the clipboard holds files: cheap, for the Paste item's enabled state.
#[tauri::command]
#[specta::specta]
pub fn clipboard_has_files() -> bool {
    ide_clipboard::has_files()
}

/// Replaces the clipboard with `paths`, so Explorer can paste them. Best-effort:
/// false when the clipboard stayed busy; the caller keeps working either way.
#[tauri::command]
#[specta::specta]
pub async fn clipboard_set_file_list(paths: Vec<PathBuf>) -> IdeResult<bool> {
    blocking(move || Ok(ide_clipboard::set_files(&paths))).await
}

/// Paths cross the IPC boundary `/`-separated, as every other backend path does.
fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
