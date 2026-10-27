//! IPC commands of `ide_host::ops::java` (the shared implementation).

use crate::state::AppState;
use ide_core::IdeResult;
#[allow(unused_imports)]
pub use ide_host::ops::java::*;
use ide_lsp::jdtls::JavaLaunchInfo;
use std::path::PathBuf;
use tauri::{State, Window};

/// Builds the workspace (when `build`), then resolves the runtime (or test)
/// classpath and the JDK of the module at `module` (absolute, or relative to the project root).
/// A module with Kotlin / Groovy / Scala sources is built by its build system, whose class directories come first.
#[tauri::command]
#[specta::specta]
pub async fn java_resolve_launch(
    window: Window,
    state: State<'_, AppState>,
    module: PathBuf,
    test: bool,
    build: bool,
) -> IdeResult<JavaLaunchInfo> {
    ide_host::ops::java::java_resolve_launch(&state.host, window.label(), module, test, build).await
}

/// Port of java-debug's DAP server inside the jdtls serving `module` (started on demand).
#[tauri::command]
#[specta::specta]
pub async fn java_debug_server(window: Window, state: State<'_, AppState>, module: PathBuf) -> IdeResult<u16> {
    ide_host::ops::java::java_debug_server(&state.host, window.label(), module).await
}

/// Incremental build of the jdtls workspace serving `module` (e.g. before HotSwap).
#[tauri::command]
#[specta::specta]
pub async fn java_build_workspace(
    window: Window,
    state: State<'_, AppState>,
    module: PathBuf,
) -> IdeResult<ide_lsp::jdtls::JavaBuildStatus> {
    ide_host::ops::java::java_build_workspace(&state.host, window.label(), module).await
}
