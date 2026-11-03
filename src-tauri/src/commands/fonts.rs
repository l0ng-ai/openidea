//! Font families installed on this machine, for the font pickers in Settings.
//! Enumerates fonts on the local desktop, including in remote-development windows.

use ide_core::{IdeError, IdeResult};
use ide_fonts::FontFamily;

/// Every installed family, sorted, each flagged monospaced or not. Read on
/// first use (off the command threads), cached, and re-queried on `refresh`.
#[tauri::command]
#[specta::specta]
pub async fn system_font_families(refresh: bool) -> IdeResult<Vec<FontFamily>> {
    tauri::async_runtime::spawn_blocking(move || ide_fonts::families(refresh).to_vec())
        .await
        .map_err(|e| IdeError::internal(e.to_string()))
}

/// Raw font bundle, selected by family, never by a frontend-supplied path.
#[tauri::command]
pub async fn user_font_data(family: String) -> IdeResult<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || ide_fonts::user_font_data(&family))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
        .map(tauri::ipc::Response::new)
        .map_err(|e| IdeError::invalid(e.to_string()))
}
