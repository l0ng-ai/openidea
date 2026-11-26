//! IPC commands of `ide_host::ops::nav` (the shared implementation).

use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::IdeResult;
use tauri::{State, Window};

/// Spring Web mapping sources for the request-path index of Search Everywhere.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn spring_route_sources(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Vec<ide_host::ops::routes::RouteSource>> {
    ide_host::ops::routes::spring_route_sources(&state.host, window.label()).await
}

/// Cucumber feature files and step definition files, for step navigation.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn cucumber_sources(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Vec<ide_host::ops::bdd::StepSource>> {
    let host = state.host.clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || ide_host::ops::bdd::cucumber_sources(&host, &label))
        .await
        .map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

ide_command::desktop_domain!(cucumber_sources, spring_route_sources);
