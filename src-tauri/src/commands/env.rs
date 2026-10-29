//! IPC commands of `ide_host::ops::env` (the shared implementation).

use crate::state::AppState;
use ide_core::IdeResult;
use ide_host::environment::EnvReloaded;
use tauri::{State, Window};

/// Reload Environment: new child processes get the login shell's current environment
/// (and the project's `remoteEnv` on a remote host); running ones keep theirs.
#[tauri::command]
#[specta::specta]
pub async fn env_reload(window: Window, state: State<'_, AppState>) -> IdeResult<EnvReloaded> {
    ide_host::ops::env::reload(&state.host, window.label()).await
}
