use crate::state::AppState;
use ide_core::{IdeError, IdeResult, RunId};
use ide_run::{OutputChunk, RunConfig, RunInfo, StartOptions};
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Detected configs followed by user-defined ones (user ids win on conflict).
#[tauri::command]
#[specta::specta]
pub fn run_configs(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<RunConfig>> {
    let project = state.project(window.label())?;
    let root = project.root.clone();
    let user = ide_run::load_user_configs(&root)?;
    let mut all: Vec<RunConfig> =
        ide_run::detect(&root).into_iter().filter(|d| !user.iter().any(|u| u.id == d.id)).collect();
    all.extend(user);
    // Project interpreter / package manager / toolchains from Languages & Frameworks.
    ide_sdk::apply::apply_to_run_configs(&mut all, &root, &project.settings.effective());
    Ok(all)
}

#[tauri::command]
#[specta::specta]
pub fn run_save_configs(window: Window, state: State<'_, AppState>, configs: Vec<RunConfig>) -> IdeResult<()> {
    let root = state.project(window.label())?.root.clone();
    ide_run::save_user_configs(&root, &configs)
}

/// Configuration templates: per-type defaults applied to new configurations.
#[tauri::command]
#[specta::specta]
pub fn run_templates(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<RunConfig>> {
    let root = state.project(window.label())?.root.clone();
    ide_run::load_templates(&root)
}

#[tauri::command]
#[specta::specta]
pub fn run_save_templates(window: Window, state: State<'_, AppState>, templates: Vec<RunConfig>) -> IdeResult<()> {
    let root = state.project(window.label())?.root.clone();
    ide_run::save_templates(&root, &templates)
}

/// The environment runs inherit when "Include system environment variables" is on.
#[tauri::command]
#[specta::specta]
pub fn run_system_env() -> std::collections::BTreeMap<String, String> {
    ide_run::system_env()
}

#[tauri::command]
#[specta::specta]
pub fn run_start(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
    on_output: Channel<OutputChunk>,
) -> IdeResult<RunInfo> {
    let project = state.project(window.label())?;
    let root = project.root.clone();
    if config.command.is_empty() {
        return Err(IdeError::invalid("run configuration has no command"));
    }
    let settings = project.settings.effective();
    // Configurations made in the UI name bare tools (`godot`) that may live outside PATH.
    let mut config = config;
    ide_sdk::apply::resolve_run_command(&mut config, &root, &settings);
    if config.command == ide_sdk::godot::COMMAND {
        return Err(IdeError::unavailable(ide_sdk::godot::NOT_FOUND));
    }
    let encoding = settings.console.encoding;
    let options = StartOptions { encoding: Some(encoding).filter(|e| !e.trim().is_empty()) };
    state.processes.start(
        &root,
        &config,
        &options,
        project.sink.clone(),
        Box::new(move |chunk| {
            let _ = on_output.send(chunk);
        }),
    )
}

#[tauri::command]
#[specta::specta]
pub fn run_stop(window: Window, state: State<'_, AppState>, id: RunId) -> IdeResult<()> {
    let settings = match state.project(window.label()) {
        Ok(p) => p.settings.effective(),
        Err(_) => state.global_settings.effective(),
    };
    let grace = std::time::Duration::from_millis(u64::from(settings.run.termination_timeout_ms));
    state.processes.stop_with_grace(id, grace)
}

#[tauri::command]
#[specta::specta]
pub fn run_stdin(state: State<'_, AppState>, id: RunId, data: String) -> IdeResult<()> {
    state.processes.write_stdin(id, &data)
}

/// Terminal size of a run started with "Emulate terminal in output console".
#[tauri::command]
#[specta::specta]
pub fn run_resize(state: State<'_, AppState>, id: RunId, cols: u16, rows: u16) -> IdeResult<()> {
    state.processes.resize(id, cols, rows)
}

#[tauri::command]
#[specta::specta]
pub fn run_list(state: State<'_, AppState>) -> Vec<RunInfo> {
    state.processes.list()
}

#[tauri::command]
#[specta::specta]
pub fn run_close_stdin(state: State<'_, AppState>, id: RunId) -> IdeResult<()> {
    state.processes.close_stdin(id)
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
    let root = state.project(window.label())?.root.clone();
    let dir = module.map(|m| root.join(m)).unwrap_or(root);
    let since = std::time::UNIX_EPOCH + std::time::Duration::from_millis(since_ms.max(0.0) as u64);
    tauri::async_runtime::spawn_blocking(move || {
        ide_run::junit::read_reports(&ide_run::junit::report_dirs(&dir), since)
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))
}
