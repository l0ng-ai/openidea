use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::settings::Settings;
use ide_core::{EventSink, IdeError, IdeResult};
use ide_language::LanguageInfo;
use ide_workspace::settings::SettingsScope;
use ide_workspace::{RecentProject, RecentProjectGroup};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tauri::{Manager, State, Window};

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub windows_build_number: Option<u32>,
    pub config_dir: ide_core::IpcPath,
    /// User data (plugins, scratches, Local History); follows `OPENIDEA_DATA_DIR`.
    pub data_dir: ide_core::IpcPath,
    /// Linux on a Wayland display: GTK draws the frameless windows' shadow and resize edges.
    pub wayland: bool,
    /// Caption buttons of the frameless title bar: the desktop's layout on Linux.
    pub window_buttons: ide_core::platform::WindowButtonLayout,
}

pub use ide_host::ops::project::ProjectInfo;

#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    state.note_ipc();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        windows_build_number: ide_core::platform::windows_build_number(),
        config_dir: state.config_dir.clone().into(),
        data_dir: state.data_dir.clone().into(),
        #[cfg(target_os = "linux")]
        wayland: crate::linux_window_state::is_wayland(),
        #[cfg(not(target_os = "linux"))]
        wayland: false,
        #[cfg(target_os = "linux")]
        window_buttons: ide_core::platform::WindowButtonLayout::for_linux(
            crate::linux_window_state::decoration_layout().as_deref(),
            |key| std::env::var(key).ok(),
        ),
        #[cfg(not(target_os = "linux"))]
        window_buttons: Default::default(),
    }
}

#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn recent_projects(app: tauri::AppHandle) -> Vec<RecentProject> {
    let state = app.state::<AppState>();
    state.note_ipc();
    let items = state.recent.list();
    // Reading every project's `.git/HEAD` may touch slow disks: off the async runtime.
    match tauri::async_runtime::spawn_blocking(move || ide_workspace::recent::with_live_branches(items)).await {
        Ok(items) => items,
        Err(_) => state.recent.list(),
    }
}

#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub fn remove_recent_project(state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    state.recent.remove(&path)?;
    crate::jump_list::refresh(&state.app, state.recent.list());
    Ok(())
}

/// The welcome screen's project groups.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub fn recent_project_groups(state: State<'_, AppState>) -> Vec<RecentProjectGroup> {
    state.recent.groups()
}

/// Replaces the project groups; returns them as saved (names trimmed and unique, each
/// project in one group, only recent projects).
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub fn set_recent_project_groups(
    state: State<'_, AppState>,
    groups: Vec<RecentProjectGroup>,
) -> IdeResult<Vec<RecentProjectGroup>> {
    state.recent.set_groups(groups)
}

pub(crate) async fn open_project(window: Window, path: PathBuf) -> IdeResult<ProjectInfo> {
    // Opening touches the disk (index cache, watcher, git): keep it off the async runtime threads.
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    // Replacing this window's project (the UI skips reopening the same one).
    if app.state::<AppState>().project(&label).is_ok() {
        crate::windows::close_auxiliary_windows(&app, &label);
    }
    let project = tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().open_project(&label, &path))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    let info = project_info(&project);
    let _ = window.set_title(&info.display_name);
    window.state::<AppState>().sink.emit(ide_core::IdeEvent::WindowGroupsChanged);
    // Every project window is part of the session reopened at the next start.
    crate::window_groups::persist(window.app_handle()).await?;
    Ok(info)
}

/// Edits the loose file `path` in this window without a project (LightEdit);
/// a window already in LightEdit keeps its files. Returns the effective (global) settings.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn light_edit_open(window: Window, path: PathBuf) -> IdeResult<Settings> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    if app.state::<AppState>().project(&label).is_ok_and(|p| !p.light) {
        crate::windows::close_auxiliary_windows(&app, &label);
        crate::window_groups::detach(&app, &label)?;
        crate::window_groups::persist(&app).await?;
    }
    let project = tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().open_light(&label, &path))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    Ok(project.settings.effective())
}

/// LightEdit without a file (File › New File from a welcome window); returns
/// the effective (global) settings.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn light_edit_open_untitled(window: Window) -> IdeResult<Settings> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let log_label = label.clone();
    let result = async {
        if app.state::<AppState>().project(&label).is_ok_and(|p| !p.light) {
            crate::windows::close_auxiliary_windows(&app, &label);
            crate::window_groups::detach(&app, &label)?;
            crate::window_groups::persist(&app).await?;
        }
        tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().open_light_empty(&label))
            .await
            .map_err(|e| IdeError::internal(e.to_string()))?
    };
    match result.await {
        Ok(project) => Ok(project.settings.effective()),
        Err(e) => {
            tracing::warn!("light_edit_open_untitled ({log_label}): {e}");
            Err(e)
        }
    }
}

fn project_info(project: &crate::state::Project) -> ProjectInfo {
    ide_host::ops::project::info(project)
}

/// File › Rename Project…: the project's display name (title bar, recent
/// projects); an empty `name` restores the folder name. Stored in the project's settings.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub fn project_rename(window: Window, state: State<'_, AppState>, name: String) -> IdeResult<ProjectInfo> {
    let project = state.project(window.label())?;
    let name = name.trim();
    if let Some(workspace) = ide_workspace::workspace::Workspace::load(&project.root)?
        && workspace.is_container(&project.root)
    {
        ide_host::ops::project::save_workspace(&state.host, window.label(), name, workspace.projects)?;
    } else {
        let value = if name.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(name.to_owned()) };
        project.settings.set(SettingsScope::Project, "general.projectName", value)?;
    }
    let info = project_info(&project);
    state.record_project(&project)?;
    let _ = window.set_title(&info.display_name);
    state.sink.emit(ide_core::IdeEvent::WindowGroupsChanged);
    Ok(info)
}

// Not on the main thread: closing stops the project's language servers, runs and file watcher.
pub(crate) fn close_project(window: Window) {
    let state = window.state::<AppState>();
    crate::windows::close_auxiliary_windows(window.app_handle(), window.label());
    let _ = crate::window_groups::detach(window.app_handle(), window.label());
    state.close_project(window.label());
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::window_groups::persist(&app).await;
    });
}

#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub fn languages(state: State<'_, AppState>) -> Vec<LanguageInfo> {
    state.note_ipc();
    // Includes plugin languages (built-in definitions win on id clashes).
    state.languages.all().iter().map(LanguageInfo::from).collect()
}

pub(crate) fn settings_get(window: Window) -> Settings {
    let state = window.state::<AppState>();
    state.note_ipc();
    ide_host::ops::project::settings_get(&state.host, window.label())
}

pub(crate) fn settings_removed_theme(window: Window) -> Option<String> {
    let state = window.state::<AppState>();
    state.note_ipc();
    ide_host::ops::project::settings_removed_theme(&state.host, window.label())
}

/// `value` is JSON text, e.g. `14` or `"dark"`. Every window (for a project
/// value: that project's windows) is told (`IdeEvent::SettingsChanged`) so it
/// re-reads its effective settings.
pub(crate) fn settings_set(window: Window, scope: SettingsScope, key: String, value: String) -> IdeResult<Settings> {
    let app = window.app_handle().clone();
    let window = window.label().to_owned();
    // The merge validates its result by deserializing the whole `Settings`, which needs
    // ~250 KiB of stack in a debug build (measured by bisecting a thread's stack size; the
    // same with and without a settings file, so it is the type, not the data). A WebView2
    // IPC callback reaches this command with ~750 KiB of the main thread's 1 MiB already
    // used, so the merge — and anything else called from that callback — can overflow it.
    // A worker thread starts from a clean stack, where the default 2 MiB is ample.
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        settings_set_now(&state, &window, scope, &key, &value)
    })
    .join()
    .map_err(|_| IdeError::internal("settings worker panicked"))?
}

fn settings_set_now(
    state: &AppState,
    window: &str,
    scope: SettingsScope,
    key: &str,
    value: &str,
) -> IdeResult<Settings> {
    let applied = ide_host::ops::project::set_settings(&state.host, window, scope, key, value)?;
    if key == "mcpServer" || key.starts_with("mcpServer.") {
        state.host.mcp.apply(&state.host);
    }
    if !applied.project_scope {
        state.updates.wake.notify_one();
    }
    // A project value concerns only that project's window (and its settings window).
    let event = ide_core::IdeEvent::SettingsChanged { key: key.to_owned() };
    if applied.project_scope {
        let owner = AppState::owner_window(window);
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
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn settings_export(
    state: State<'_, AppState>,
    path: PathBuf,
    storage: std::collections::BTreeMap<String, String>,
) -> IdeResult<()> {
    ide_host::ops::agent::move_user_mcp_values(&state.host);
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
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn settings_import(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<SettingsImport> {
    let (_, storage) = state.global_settings.import_bundle(&path)?;
    ide_host::ops::agent::move_user_mcp_values(&state.host);
    for project in state.projects() {
        let effective = project.settings.reload();
        project
            .documents
            .set_file_defaults(ide_workspace::FileDefaults::from_settings(&effective, Some(&project.root)));
        let lsp = project.lsp.clone();
        tauri::async_runtime::spawn(async move { lsp.reconfigure().await });
    }
    crate::commands::ssh::apply_ssh_settings(&state);
    state.host.mcp.apply(&state.host);
    state.host.apply_proxy();
    state.host.apply_git_executable();
    state.updates.wake.notify_one();
    state.sink.emit(ide_core::IdeEvent::SettingsChanged { key: String::new() });
    let settings = ide_host::ops::project::settings_get(&state.host, window.label());
    Ok(SettingsImport { settings, storage })
}

/// Import Settings… with a JetBrains `settings.zip` or an IDE's settings folder: reads it; the
/// frontend maps and applies it.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn settings_read_jetbrains(path: PathBuf) -> IdeResult<ide_workspace::settings::JetBrainsSettings> {
    tauri::async_runtime::spawn_blocking(move || ide_workspace::settings::read_jetbrains_settings(&path))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

/// The settings folders of the JetBrains IDEs installed for this user, to import from.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn settings_list_jetbrains_ides() -> IdeResult<Vec<ide_host::plugins::intellij::InstalledIdeSettings>> {
    tauri::async_runtime::spawn_blocking(|| Ok(ide_host::plugins::intellij::installed_ide_settings()))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

pub(crate) fn project_current(window: Window) -> Option<ProjectInfo> {
    let state = window.state::<AppState>();
    state.project(window.label()).ok().filter(|p| !p.light).map(|p| project_info(&p))
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
#[desktop_command(trust = always)]
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

pub(crate) async fn project_trust_set(window: Window, path: PathBuf, trusted: bool, folder: bool) -> IdeResult<()> {
    let state = window.state::<AppState>();
    state.host.set_project_trust(&path, trusted, folder).await?;
    if !trusted {
        state.plugins.restrict_project(&dunce::canonicalize(&path).unwrap_or(path));
    }
    Ok(())
}

#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn project_trust_add_location(state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    state.trust.add_location(&path)?;
    state.host.refresh_project_trust().await
}

pub(crate) async fn project_trust_remove_location(window: Window, path: PathBuf) -> IdeResult<()> {
    let state = window.state::<AppState>();
    state.trust.remove_location(&path)?;
    state.host.refresh_project_trust().await?;
    for project in state.host.projects().into_iter().filter(|p| !p.is_trusted()) {
        state.plugins.restrict_project(&project.root);
    }
    Ok(())
}

ide_command::desktop_domain!(
    app_info,
    languages,
    light_edit_open,
    light_edit_open_untitled,
    log_frontend,
    project_rename,
    project_trust_add_location,
    recent_project_groups,
    recent_projects,
    remove_recent_project,
    set_recent_project_groups,
    settings_export,
    settings_import,
    settings_list_jetbrains_ides,
    settings_read_jetbrains,
);
