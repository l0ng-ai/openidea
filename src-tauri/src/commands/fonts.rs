//! Font families installed on this machine, for the font pickers in Settings.

use ide_core::{IdeError, IdeResult};
use ide_fonts::FontFamily;

/// Every installed family, sorted, each flagged monospaced or not. Read once
/// per run (off the command threads) and cached.
#[tauri::command]
#[specta::specta]
pub async fn system_font_families() -> IdeResult<Vec<FontFamily>> {
    tauri::async_runtime::spawn_blocking(|| ide_fonts::families().to_vec())
        .await
        .map_err(|e| IdeError::internal(e.to_string()))
}
