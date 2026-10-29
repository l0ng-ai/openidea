//! IPC commands of `ide_host::ops::run` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, RunId};
#[allow(unused_imports)]
pub use ide_host::ops::run::*;
use ide_run::{OutputChunk, RunConfig, RunInfo};
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Detected configs followed by user-defined ones (user ids win on conflict).
#[tauri::command]
#[specta::specta]
pub async fn run_configs(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<RunConfig>> {
    // Detection reads build files (and Spring Boot sources): off the command thread.
    let (host, label) = (state.host.clone(), window.label().to_owned());
    tauri::async_runtime::spawn_blocking(move || ide_host::ops::run::configs(&host, &label))
        .await
        .map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

#[tauri::command]
#[specta::specta]
pub fn run_save_configs(window: Window, state: State<'_, AppState>, configs: Vec<RunConfig>) -> IdeResult<()> {
    ide_host::ops::run::save_configs(&state.host, window.label(), &configs)
}

#[tauri::command]
#[specta::specta]
pub async fn run_start(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
    on_output: Channel<OutputChunk>,
) -> IdeResult<RunInfo> {
    let emit = std::sync::Arc::new(move |chunk| {
        let _ = on_output.send(chunk);
    });
    ide_host::ops::run::start(&state.host, window.label(), config, emit).await
}

#[tauri::command]
#[specta::specta]
pub fn run_stop(window: Window, state: State<'_, AppState>, id: RunId) -> IdeResult<()> {
    ide_host::ops::run::stop(&state.host, window.label(), id)
}

#[tauri::command]
#[specta::specta]
pub fn run_stdin(state: State<'_, AppState>, id: RunId, data: String) -> IdeResult<()> {
    ide_host::ops::run::stdin(&state.host, id, &data)
}

/// Terminal size of a run started with "Emulate terminal in output console".
#[tauri::command]
#[specta::specta]
pub fn run_resize(state: State<'_, AppState>, id: RunId, cols: u16, rows: u16) -> IdeResult<()> {
    ide_host::ops::run::resize(&state.host, id, cols, rows)
}

#[tauri::command]
#[specta::specta]
pub fn run_list(state: State<'_, AppState>) -> Vec<RunInfo> {
    ide_host::ops::run::list(&state.host)
}

#[tauri::command]
#[specta::specta]
pub fn run_close_stdin(state: State<'_, AppState>, id: RunId) -> IdeResult<()> {
    ide_host::ops::run::close_stdin(&state.host, id)
}
/// Configuration templates: per-type defaults applied to new configurations.
#[tauri::command]
#[specta::specta]
pub fn run_templates(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<RunConfig>> {
    ide_host::ops::run::run_templates(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn run_save_templates(window: Window, state: State<'_, AppState>, templates: Vec<RunConfig>) -> IdeResult<()> {
    ide_host::ops::run::run_save_templates(&state.host, window.label(), templates)
}

/// The environment runs inherit when "Include system environment variables" is on.
#[tauri::command]
#[specta::specta]
pub fn run_system_env(state: State<'_, AppState>) -> std::collections::BTreeMap<String, String> {
    ide_host::ops::run::run_system_env(&state.host, "")
}

/// Writes the Gradle init script adding `jvm_args` to the JVMs the build forks; returns its path.
#[tauri::command]
#[specta::specta]
pub async fn run_gradle_jvm_args_script(
    window: Window,
    state: State<'_, AppState>,
    jvm_args: Vec<String>,
) -> IdeResult<String> {
    ide_host::ops::run::run_gradle_jvm_args_script(&state.host, window.label(), jvm_args).await
}

/// Results from the JUnit XML reports (Surefire, Failsafe, Gradle) of the module at
/// `module` (relative to the project root) written since `since_ms` (Unix epoch, ms).
#[tauri::command]
#[specta::specta]
pub async fn run_test_reports(
    window: Window,
    state: State<'_, AppState>,
    module: Option<std::path::PathBuf>,
    since_ms: f64,
) -> IdeResult<Vec<ide_run::junit::TestCaseReport>> {
    ide_host::ops::run::run_test_reports(&state.host, window.label(), module, since_ms).await
}
