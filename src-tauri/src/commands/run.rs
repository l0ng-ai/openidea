//! IPC commands of `ide_host::ops::run` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, RunId};
#[allow(unused_imports)]
pub use ide_host::ops::run::*;
use ide_run::{OutputChunk, RunConfig, RunInfo};
use tauri::ipc::Channel;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub async fn run_dotnet_resolve(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
    debug: bool,
) -> IdeResult<RunConfig> {
    ide_host::ops::run::run_dotnet_resolve(&state.host, window.label(), config, debug).await
}

#[tauri::command]
#[specta::specta]
pub async fn run_application_build(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
    module: std::path::PathBuf,
) -> IdeResult<RunConfig> {
    ide_host::ops::run::run_application_build(&state.host, window.label(), config, module).await
}

#[tauri::command]
#[specta::specta]
pub async fn run_application_publish(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
    class_paths: Vec<String>,
    main_class: String,
) -> IdeResult<()> {
    ide_host::ops::run::run_application_publish(&state.host, window.label(), config, class_paths, main_class).await
}

/// Detected configs followed by user-defined ones (user ids win on conflict).
#[tauri::command]
#[specta::specta]
pub async fn run_configs(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<RunConfig>> {
    ide_host::ops::run::run_configs(&state.host, window.label()).await
}

#[tauri::command]
#[specta::specta]
pub async fn run_save_configs(
    window: Window,
    state: State<'_, AppState>,
    configs: Vec<RunConfig>,
    removed_detected_ids: Option<Vec<String>>,
) -> IdeResult<()> {
    ide_host::ops::run::run_save_configs(&state.host, window.label(), configs, removed_detected_ids).await
}

/// Temporary configurations as they are kept between sessions: without what settings derived.
#[tauri::command]
#[specta::specta]
pub async fn run_without_derived(
    window: Window,
    state: State<'_, AppState>,
    configs: Vec<RunConfig>,
) -> IdeResult<Vec<RunConfig>> {
    ide_host::ops::run::run_without_derived(&state.host, window.label(), configs).await
}

/// Kept temporary configurations with the current settings applied.
#[tauri::command]
#[specta::specta]
pub async fn run_apply_settings(
    window: Window,
    state: State<'_, AppState>,
    configs: Vec<RunConfig>,
) -> IdeResult<Vec<RunConfig>> {
    ide_host::ops::run::run_apply_settings(&state.host, window.label(), configs).await
}

#[tauri::command]
#[specta::specta]
pub async fn run_start(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
    on_output: Channel<OutputChunk>,
    request: Option<ide_core::RequestId>,
) -> IdeResult<RunInfo> {
    ide_host::ops::run::run_start(&state.host, window.label(), config, crate::commands::sender(on_output), request)
        .await
}

#[tauri::command]
#[specta::specta]
pub fn run_stop(window: Window, state: State<'_, AppState>, id: RunId) -> IdeResult<()> {
    ide_host::ops::run::run_stop(&state.host, window.label(), id)
}

#[tauri::command]
#[specta::specta]
pub fn run_stdin(state: State<'_, AppState>, id: RunId, data: String) -> IdeResult<()> {
    ide_host::ops::run::run_stdin(&state.host, id, data)
}

/// Terminal size of a run started with "Emulate terminal in output console".
#[tauri::command]
#[specta::specta]
pub fn run_resize(state: State<'_, AppState>, id: RunId, cols: u16, rows: u16) -> IdeResult<()> {
    ide_host::ops::run::run_resize(&state.host, id, cols, rows)
}

#[tauri::command]
#[specta::specta]
pub fn run_list(state: State<'_, AppState>) -> Vec<RunInfo> {
    ide_host::ops::run::run_list(&state.host)
}

#[tauri::command]
#[specta::specta]
pub fn run_close_stdin(state: State<'_, AppState>, id: RunId) -> IdeResult<()> {
    ide_host::ops::run::run_close_stdin(&state.host, id)
}
/// Configuration templates: per-type defaults applied to new configurations.
#[tauri::command]
#[specta::specta]
pub async fn run_templates(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<RunConfig>> {
    ide_host::ops::run::run_templates(&state.host, window.label()).await
}

#[tauri::command]
#[specta::specta]
pub async fn run_save_templates(
    window: Window,
    state: State<'_, AppState>,
    templates: Vec<RunConfig>,
) -> IdeResult<()> {
    ide_host::ops::run::run_save_templates(&state.host, window.label(), templates).await
}

/// Project files run configurations can be imported from (`.vscode/launch.json`).
#[tauri::command]
#[specta::specta]
pub async fn run_import_sources(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Vec<ide_run::import::RunImportSource>> {
    ide_host::ops::run::run_import_sources(&state.host, window.label()).await
}

/// Configurations read from `source`, not saved; names already in `existing` are skipped.
#[tauri::command]
#[specta::specta]
pub async fn run_import_configs(
    window: Window,
    state: State<'_, AppState>,
    source: ide_run::import::RunImportSource,
    existing: Vec<RunConfig>,
) -> IdeResult<ide_run::import::RunImport> {
    ide_host::ops::run::run_import_configs(&state.host, window.label(), source, existing).await
}

/// The environment runs inherit when "Include system environment variables" is on.
#[tauri::command]
#[specta::specta]
pub fn run_system_env(_state: State<'_, AppState>) -> std::collections::BTreeMap<String, String> {
    ide_host::ops::run::run_system_env()
}

/// Variables of the `.env` files a debug launch names, for the debugger to start with.
#[tauri::command]
#[specta::specta]
pub async fn run_env_files(
    _window: Window,
    _state: State<'_, AppState>,
    files: Vec<std::path::PathBuf>,
) -> IdeResult<std::collections::BTreeMap<String, String>> {
    ide_host::ops::run::run_env_files(files).await
}

/// Writes the Gradle init script adding `jvm_args` to the JVMs the build forks; returns its path.
#[tauri::command]
#[specta::specta]
pub async fn run_gradle_jvm_args_script(
    _window: Window,
    _state: State<'_, AppState>,
    jvm_args: Vec<String>,
) -> IdeResult<String> {
    ide_host::ops::run::run_gradle_jvm_args_script(jvm_args).await
}

/// Writes one of the IDE's Gradle init scripts where the build runs; returns its path.
#[tauri::command]
#[specta::specta]
pub async fn run_gradle_init_script(
    _window: Window,
    _state: State<'_, AppState>,
    name: String,
    text: String,
) -> IdeResult<String> {
    ide_host::ops::run::run_gradle_init_script(name, text).await
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

#[tauri::command]
#[specta::specta]
pub async fn run_tomcat_home(
    window: Window,
    state: State<'_, AppState>,
    home: String,
) -> IdeResult<ide_run::tomcat::TomcatHome> {
    ide_host::ops::run::run_tomcat_home(&state.host, window.label(), home).await
}
#[tauri::command]
#[specta::specta]
pub async fn run_tomcat_installations(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Vec<ide_run::tomcat::TomcatInstallation>> {
    ide_host::ops::run::run_tomcat_installations(&state.host, window.label()).await
}
#[tauri::command]
#[specta::specta]
pub async fn run_tomcat_artifacts(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Vec<ide_build::web::WebArtifact>> {
    ide_host::ops::run::run_tomcat_artifacts(&state.host, window.label()).await
}
#[tauri::command]
#[specta::specta]
pub async fn run_tomcat_build(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
) -> IdeResult<Option<RunConfig>> {
    ide_host::ops::run::run_tomcat_build(&state.host, window.label(), config).await
}
#[tauri::command]
#[specta::specta]
pub async fn run_tomcat_sync(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
    module: std::path::PathBuf,
    class_paths: Vec<String>,
    resources_only: bool,
) -> IdeResult<bool> {
    ide_host::ops::run::run_tomcat_sync(&state.host, window.label(), config, module, class_paths, resources_only).await
}
#[tauri::command]
#[specta::specta]
pub async fn run_tomcat_update(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
    mode: String,
) -> IdeResult<()> {
    ide_host::ops::run::run_tomcat_update(&state.host, window.label(), config, mode).await
}
