//! File › Invalidate Caches… and restarting the IDE.

use crate::state::AppState;
use crate::windows::WindowsState;
use ide_core::IdeResult;
use ide_workspace::caches::{self, InvalidateCachesOptions};
use tauri::{AppHandle, State};

/// Schedules the invalidation for the next start (`None` cancels a pending one).
#[tauri::command]
#[specta::specta]
pub fn caches_schedule_invalidation(
    state: State<'_, AppState>,
    options: Option<InvalidateCachesOptions>,
) -> IdeResult<()> {
    let data_dir = state.data_dir.clone();
    match options {
        Some(o) => caches::schedule(&data_dir, &o),
        None => {
            caches::cancel(&data_dir);
            Ok(())
        }
    }
}

/// Quits through every window's unsaved-changes check, then starts again.
#[tauri::command]
#[specta::specta]
pub fn app_restart(app: AppHandle, windows: State<'_, WindowsState>) {
    windows.set_restart();
    super::window::app_quit(app, windows);
}
