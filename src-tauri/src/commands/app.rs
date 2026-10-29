use crate::state::AppState;
use ide_core::settings::Settings;
use ide_core::{EventSink, IdeError, IdeResult, RequestId, TaskId};
use ide_language::LanguageInfo;
use ide_workspace::RecentProject;
use ide_workspace::settings::SettingsScope;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tauri::{Manager, State, Window};

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub config_dir: ide_core::IpcPath,
}

pub use ide_host::ops::project::ProjectInfo;

#[tauri::command]
#[specta::specta]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    state.note_ipc();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        config_dir: state.config_dir.clone().into(),
    }
}

#[tauri::command]
#[specta::specta]
pub fn recent_projects(state: State<'_, AppState>) -> Vec<RecentProject> {
    state.note_ipc();
    state.recent.list()
}

#[tauri::command]
#[specta::specta]
pub fn remove_recent_project(state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    state.recent.remove(&path)
}

#[tauri::command]
#[specta::specta]
pub async fn open_project(window: Window, path: PathBuf) -> IdeResult<ProjectInfo> {
    // Opening touches the disk (index cache, watcher, git): keep it off the async runtime threads.
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    // Replacing this window's project (the UI skips reopening the same one).
    if app.state::<AppState>().project(&label).is_ok() {
        crate::windows::close_settings_window(&app, &label);
    }
    let project = tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().open_project(&label, &path))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    let info = project_info(&project);
    let _ = window.set_title(&info.name);
    Ok(info)
}

/// Edits the loose file `path` in this window without a project (LightEdit);
/// a window already in LightEdit keeps its files. Returns the effective (global) settings.
#[tauri::command]
#[specta::specta]
pub async fn light_edit_open(window: Window, path: PathBuf) -> IdeResult<Settings> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    if app.state::<AppState>().project(&label).is_ok_and(|p| !p.light) {
        crate::windows::close_settings_window(&app, &label);
    }
    let project = tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().open_light(&label, &path))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    Ok(project.settings.effective())
}

fn project_info(project: &crate::state::Project) -> ProjectInfo {
    ide_host::ops::project::info(project)
}

/// File › Rename Project…: the project's display name (title bar, recent
/// projects); an empty `name` restores the folder name. Stored in the project's settings.
#[tauri::command]
#[specta::specta]
pub fn project_rename(window: Window, state: State<'_, AppState>, name: String) -> IdeResult<ProjectInfo> {
    let project = state.project(window.label())?;
    let name = name.trim();
    let value = if name.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(name.to_owned()) };
    project.settings.set(SettingsScope::Project, "general.projectName", value)?;
    state.recent.rename(&project.root, (!name.is_empty()).then_some(name))?;
    Ok(project_info(&project))
}

#[tauri::command]
#[specta::specta]
pub fn close_project(window: Window, state: State<'_, AppState>) {
    crate::windows::close_settings_window(window.app_handle(), window.label());
    state.close_project(window.label());
}

#[tauri::command]
#[specta::specta]
pub fn languages(state: State<'_, AppState>) -> Vec<LanguageInfo> {
    state.note_ipc();
    let mut out: Vec<LanguageInfo> = state.languages.all().iter().map(LanguageInfo::from).collect();
    // Plugin-contributed languages; built-in definitions win on id clashes.
    for lang in state.plugins.languages() {
        if !out.iter().any(|l| l.id == lang.id) {
            out.push(LanguageInfo::from(&lang));
        }
    }
    out
}

/// Effective settings for the window's project, or global settings without one.
#[tauri::command]
#[specta::specta]
pub fn settings_get(window: Window, state: State<'_, AppState>) -> Settings {
    state.note_ipc();
    ide_host::ops::project::settings(&state.host, window.label())
}

/// Defaults plus the global layer, without any project's values: what new
/// projects (and projects without their own value) get.
#[tauri::command]
#[specta::specta]
pub fn settings_get_global(state: State<'_, AppState>) -> Settings {
    state.host.with_proxy_password(state.global_settings.effective())
}

/// `value` is JSON text, e.g. `14` or `"dark"`. Every window (for a project
/// value: that project's windows) is told (`IdeEvent::SettingsChanged`) so it
/// re-reads its effective settings.
#[tauri::command]
#[specta::specta]
pub fn settings_set(
    window: Window,
    state: State<'_, AppState>,
    scope: SettingsScope,
    key: String,
    value: String,
) -> IdeResult<Settings> {
    let applied = ide_host::ops::project::set_settings(&state.host, window.label(), scope, &key, &value)?;
    // A project value concerns only that project's window (and its settings window).
    let event = ide_core::IdeEvent::SettingsChanged { key };
    if applied.project_scope {
        let owner = AppState::owner_window(window.label());
        for label in [owner.to_owned(), crate::windows::settings_label(owner)] {
            let sink = crate::events::TauriSink { app: state.app.clone(), window: Some(label) };
            sink.emit(event.clone());
            if let Some(root) = &applied.roots_changed {
                sink.emit(ide_core::IdeEvent::ProjectRootsChanged { root: root.clone() });
            }
        }
    } else {
        state.sink.emit(event);
    }
    Ok(applied.settings)
}

/// File › Manage IDE Settings › Export Settings…: the global settings plus the
/// frontend's IDE-level `storage` (live / file templates, macros) to `path`.
#[tauri::command]
#[specta::specta]
pub async fn settings_export(
    state: State<'_, AppState>,
    path: PathBuf,
    storage: std::collections::BTreeMap<String, String>,
) -> IdeResult<()> {
    state.global_settings.export_bundle(&path, storage)
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsImport {
    /// Effective settings of the calling window after the import.
    pub settings: Settings,
    /// IDE state the frontend keeps (written back to its storage).
    pub storage: std::collections::BTreeMap<String, String>,
}

/// Import Settings…: replaces the global settings with the file's; every window re-reads them.
#[tauri::command]
#[specta::specta]
pub async fn settings_import(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<SettingsImport> {
    let (_, storage) = state.global_settings.import_bundle(&path)?;
    for project in state.projects() {
        let effective = project.settings.reload();
        project
            .documents
            .set_file_defaults(ide_workspace::FileDefaults::from_settings(&effective, Some(&project.root)));
        let lsp = project.lsp.clone();
        tauri::async_runtime::spawn(async move { lsp.reconfigure().await });
    }
    crate::commands::ssh::apply_ssh_settings(&state);
    state.host.apply_proxy();
    state.sink.emit(ide_core::IdeEvent::SettingsChanged { key: String::new() });
    let settings = ide_host::ops::project::settings(&state.host, window.label());
    Ok(SettingsImport { settings, storage })
}

/// Effective source / test / resource / excluded roots of the window's project:
/// auto-detected from build files, overridden by Settings › Project Structure.
#[tauri::command]
#[specta::specta]
pub fn project_roots(window: Window, state: State<'_, AppState>) -> IdeResult<ide_workspace::ProjectRoots> {
    ide_host::ops::project::roots(&state.host, window.label())
}

/// The project open in this window (a settings window: its parent's), if any.
#[tauri::command]
#[specta::specta]
pub fn project_current(window: Window, state: State<'_, AppState>) -> Option<ProjectInfo> {
    state.project(window.label()).ok().filter(|p| !p.light).map(|p| project_info(&p))
}

#[tauri::command]
#[specta::specta]
pub fn cancel_request(state: State<'_, AppState>, id: RequestId) {
    state.cancel_request(id);
}

/// Stops a background task the backend reported with `cancellable` set; false when it
/// has ended or can't be cancelled.
#[tauri::command]
#[specta::specta]
pub fn cancel_task(id: TaskId) -> bool {
    ide_core::task::cancel(id)
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// Routes frontend logs into the backend `tracing` pipeline.
#[tauri::command]
#[specta::specta]
pub fn log_frontend(level: LogLevel, message: String) {
    match level {
        LogLevel::Debug => tracing::debug!(target: "frontend", "{message}"),
        LogLevel::Info => tracing::info!(target: "frontend", "{message}"),
        LogLevel::Warn => tracing::warn!(target: "frontend", "{message}"),
        LogLevel::Error => tracing::error!(target: "frontend", "{message}"),
    }
}
