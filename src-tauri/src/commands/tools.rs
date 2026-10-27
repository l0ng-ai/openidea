//! IPC commands of `ide_host::ops::tools` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, RequestId};
#[allow(unused_imports)]
pub use ide_host::ops::tools::*;
use ide_sdk::Sdk;
use ide_tools::jdk::{JdkReleases, JdkVendor};
use ide_tools::{InstallEvent, ToolInfo};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Status of every known language server / debug adapter and the languages using it.
#[tauri::command]
#[specta::specta]
pub async fn tools_list(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ToolInfo>> {
    ide_host::ops::tools::tools_list(&state.host, window.label()).await
}

/// Installs (or reinstalls) a tool into `<app-data>/tools`, streaming output through
/// `on_event`. Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn tools_install(
    window: Window,
    state: State<'_, AppState>,
    name: String,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<ToolInfo> {
    ide_host::ops::tools::tools_install(&state.host, window.label(), name, request, crate::commands::sender(on_event))
        .await
}

/// Removes a tool the IDE installed.
#[tauri::command]
#[specta::specta]
pub async fn tools_uninstall(window: Window, state: State<'_, AppState>, name: String) -> IdeResult<ToolInfo> {
    ide_host::ops::tools::tools_uninstall(&state.host, window.label(), name).await
}

/// JDK distributions Download JDK offers.
#[tauri::command]
#[specta::specta]
pub fn jdk_download_vendors(state: State<'_, AppState>) -> Vec<JdkVendor> {
    ide_host::ops::tools::jdk_download_vendors(&state.host, "")
}

/// Java versions `vendor` publishes; cancellable with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn jdk_download_releases(
    window: Window,
    state: State<'_, AppState>,
    vendor: String,
    request: RequestId,
) -> IdeResult<JdkReleases> {
    ide_host::ops::tools::jdk_download_releases(&state.host, window.label(), vendor, request).await
}

/// Where Download JDK puts JDKs unless told otherwise.
#[tauri::command]
#[specta::specta]
pub fn jdk_download_location(state: State<'_, AppState>) -> IdeResult<ide_core::IpcPath> {
    ide_host::ops::tools::jdk_download_location(&state.host, "")
}

/// Downloads the latest `vendor` JDK of Java `version` into `location` (default:
/// [`jdk_download_location`]), streaming progress through `on_event`; cancellable
/// with `cancel_request(request)`. The JDK is then detected like an installed one,
/// and language servers waiting for a JDK (jdtls) start on it.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn jdk_download(
    window: Window,
    state: State<'_, AppState>,
    vendor: String,
    version: u32,
    location: Option<PathBuf>,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<Sdk> {
    ide_host::ops::tools::jdk_download(
        &state.host,
        window.label(),
        vendor,
        version,
        location,
        request,
        crate::commands::sender(on_event),
    )
    .await
}
