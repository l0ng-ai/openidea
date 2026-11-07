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
pub fn sdk_python_effective(
    window: Window,
    state: State<'_, AppState>,
    near: Option<PathBuf>,
) -> IdeResult<Option<ide_core::IpcPath>> {
    ide_host::ops::sdk::sdk_python_effective(&state.host, window.label(), near)
}

/// The PHP interpreter chosen in Settings › Languages & Frameworks › PHP; `None`: the `php` on `PATH`.
#[tauri::command]
#[specta::specta]
pub fn sdk_php_effective(window: Window, state: State<'_, AppState>) -> IdeResult<Option<ide_core::IpcPath>> {
    ide_host::ops::sdk::sdk_php_effective(&state.host, window.label())
}

/// The version of the PHP interpreter `php` and of the Xdebug it loads, run in `cwd` (default: the
/// project root).
#[tauri::command]
#[specta::specta]
pub async fn sdk_php_xdebug(
    window: Window,
    state: State<'_, AppState>,
    php: PathBuf,
    cwd: Option<PathBuf>,
) -> IdeResult<ide_sdk::php::PhpXdebug> {
    ide_host::ops::sdk::sdk_php_xdebug(&state.host, window.label(), php, cwd).await
}

/// The PHP language level of the project `path` belongs to: the effective one and Auto's.
#[tauri::command]
#[specta::specta]
pub async fn sdk_php_language_level(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
) -> IdeResult<ide_host::ops::sdk::PhpLanguageLevels> {
    ide_host::ops::sdk::sdk_php_language_level(&state.host, window.label(), path).await
}

/// The Composer project `path` belongs to, when its dependencies need `composer install`.
#[tauri::command]
#[specta::specta]
pub async fn sdk_php_composer_install(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
) -> IdeResult<Option<ide_host::ops::sdk::ComposerInstallState>> {
    ide_host::ops::sdk::sdk_php_composer_install(&state.host, window.label(), path).await
}

/// SDK / library source folders shown under "External Libraries" in the Project view,
/// with the Maven / Gradle dependency jars of the build model.
#[tauri::command]
#[specta::specta]
pub async fn sdk_project_libraries(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    on_groups: Channel<Vec<ide_sdk::libraries::LibraryGroup>>,
) -> IdeResult<Vec<ide_sdk::libraries::LibraryGroup>> {
    ide_host::ops::sdk::sdk_project_libraries(&state.host, window.label(), request, crate::commands::sender(on_groups))
        .await
}

/// Looks up `names` (bare command names): `node_modules/.bin` above `near`, then the search path.
#[tauri::command]
#[specta::specta]
pub async fn sdk_locate_tools(
    window: Window,
    state: State<'_, AppState>,
    names: Vec<String>,
    near: Option<PathBuf>,
) -> IdeResult<LocatedTools> {
    ide_host::ops::sdk::sdk_locate_tools(&state.host, window.label(), names, near).await
}

/// Creates a Python environment with `tool` (`venv` / `uv` / `poetry`); output streams through `on_output`.
#[tauri::command]
#[specta::specta]
pub async fn sdk_python_create_venv(
    window: Window,
    state: State<'_, AppState>,
    tool: ide_sdk::python::VenvTool,
    base: PathBuf,
    location: PathBuf,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<Sdk> {
    ide_host::ops::sdk::sdk_python_create_venv(
        &state.host,
        window.label(),
        tool,
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
    window: Window,
    state: State<'_, AppState>,
    python: PathBuf,
    request: RequestId,
) -> IdeResult<Vec<PythonPackage>> {
    ide_host::ops::sdk::sdk_python_packages(&state.host, window.label(), python, request).await
}

/// Installs (`uninstall = false`) or removes a package; output streams through `on_output`.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn sdk_python_pip(
    window: Window,
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
        window.label(),
        python,
        requirement,
        uninstall,
        upgrade,
        request,
        crate::commands::sender(on_output),
    )
    .await
}
