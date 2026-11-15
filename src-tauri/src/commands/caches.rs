//! File › Invalidate Caches… and restarting the IDE.

use crate::state::AppState;
use crate::windows::WindowsState;
use ide_core::IdeResult;
use ide_host::data_dirs;
use ide_workspace::caches::{self, InvalidateCachesOptions};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

/// Schedules the invalidation for the next start (`None` cancels a pending one).
#[tauri::command]
#[specta::specta]
pub fn caches_schedule_invalidation(app: AppHandle, options: Option<InvalidateCachesOptions>) -> IdeResult<()> {
    let data_dir = ide_host::data_dirs::data_dir(&app.config().identifier).map_err(ide_core::IdeError::internal)?;
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

/// Settings › System Settings › Caches: where the local data lives.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalDataInfo {
    /// The directory in use by this run.
    pub current: String,
    /// The OS default (what clearing the custom directory returns to).
    pub default_dir: String,
    /// The custom root stored by Settings, if any (`current` is `<root>/<identifier>`).
    pub custom_root: Option<String>,
    /// `OPENIDEA_LOCAL_DATA_DIR` is set and wins over everything Settings stores.
    pub env_override: bool,
}

#[tauri::command]
#[specta::specta]
pub fn caches_local_data_info(app: AppHandle, state: State<'_, AppState>) -> IdeResult<LocalDataInfo> {
    let identifier = app.config().identifier.clone();
    let stringify = |path: PathBuf| path.display().to_string();
    Ok(LocalDataInfo {
        current: stringify(state.host.local_data_dir.clone()),
        default_dir: stringify(data_dirs::default_local_data_dir(&identifier).map_err(ide_core::IdeError::internal)?),
        custom_root: data_dirs::stored_override(&identifier).map(stringify),
        env_override: std::env::var_os(data_dirs::LOCAL_DATA_ENV).is_some_and(|v| !v.is_empty()),
    })
}

/// Stores (`Some`) or clears (`None`, an empty string counts) the custom
/// local-data root; with `migrate`, the current tree moves at the next start.
/// Returns the directory that takes effect after a restart. The caller
/// restarts the IDE (see `app_restart`).
#[tauri::command]
#[specta::specta]
pub fn caches_set_local_data_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
    migrate: bool,
) -> IdeResult<String> {
    let identifier = app.config().identifier.clone();
    let current = state.host.local_data_dir.clone();
    let root = path.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    let next = data_dirs::set_override(&identifier, root.as_deref()).map_err(ide_core::IdeError::internal)?;
    if migrate {
        data_dirs::schedule_custom_migration(&identifier, &current, &next).map_err(ide_core::IdeError::internal)?;
    }
    Ok(next.display().to_string())
}
