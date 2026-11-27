//! IPC commands of `ide_host::ops::vcs` (the shared implementation).

use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::IdeResult;
use ide_vcs::*;
use tauri::State;

/// Show Diff in External Tool: starts the tool set in the global settings (never a
/// project's, which a cloned repository could carry) on the two sides, on this machine
/// (a remote window passes the sides as text).
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn diff_external_tool(
    state: State<'_, AppState>,
    left: ExternalDiffSide,
    right: ExternalDiffSide,
    title: String,
) -> IdeResult<()> {
    let settings = state.global_settings.effective().external_diff;
    state.host.blocking(move || launch_external_diff(&settings, &left, &right, &title)).await
}

ide_command::desktop_domain!(diff_external_tool);
