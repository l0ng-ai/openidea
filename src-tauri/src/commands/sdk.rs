//! IPC commands of `ide_host::ops::sdk` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, RequestId};
#[allow(unused_imports)]
pub use ide_host::ops::sdk::*;
use ide_sdk::python::PythonPackage;
use ide_sdk::{Sdk, SdkKind};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Installed interpreters / toolchains of `kind`; project-local ones first.
#[tauri::command]
#[specta::specta]
pub async fn sdk_detect(window: Window, state: State<'_, AppState>, kind: SdkKind) -> IdeResult<Vec<Sdk>> {
    ide_host::ops::sdk::sdk_detect(&state.host, window.label(), kind).await
}

/// The interpreter the project uses: the configured one, else its virtualenv.
#[tauri::command]
#[specta::specta]
pub fn sdk_python_effective(window: Window, state: State<'_, AppState>) -> IdeResult<Option<ide_core::IpcPath>> {
    ide_host::ops::sdk::sdk_python_effective(&state.host, window.label())
}

/// SDK / library source folders shown under "External Libraries" in the Project view,
/// with the Maven / Gradle dependency jars of the build model.
#[tauri::command]
#[specta::specta]
pub async fn sdk_project_libraries(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Vec<ide_sdk::libraries::LibraryGroup>> {
    ide_host::ops::sdk::sdk_project_libraries(&state.host, window.label()).await
}

/// Looks up `names` (bare command names): `node_modules/.bin` above `near`, then the search path.
#[tauri::command]
#[specta::specta]
pub async fn sdk_locate_tools(
    state: State<'_, AppState>,
    names: Vec<String>,
    near: Option<PathBuf>,
) -> IdeResult<LocatedTools> {
    ide_host::ops::sdk::sdk_locate_tools(&state.host, "", names, near).await
}

/// `base -m venv location`; output lines stream through `on_output`.
#[tauri::command]
#[specta::specta]
pub async fn sdk_python_create_venv(
    state: State<'_, AppState>,
    base: PathBuf,
    location: PathBuf,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<Sdk> {
    ide_host::ops::sdk::sdk_python_create_venv(
        &state.host,
        "",
        base,
        location,
        request,
        crate::commands::sender(on_output),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn sdk_python_packages(
    state: State<'_, AppState>,
    python: PathBuf,
    request: RequestId,
) -> IdeResult<Vec<PythonPackage>> {
    ide_host::ops::sdk::sdk_python_packages(&state.host, "", python, request).await
}

/// Installs (`uninstall = false`) or removes a package; output streams through `on_output`.
#[tauri::command]
#[specta::specta]
pub async fn sdk_python_pip(
    state: State<'_, AppState>,
    python: PathBuf,
    requirement: String,
    uninstall: bool,
    upgrade: bool,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<()> {
    ide_host::ops::sdk::sdk_python_pip(
        &state.host,
        "",
        python,
        requirement,
        uninstall,
        upgrade,
        request,
        crate::commands::sender(on_output),
    )
    .await
}
