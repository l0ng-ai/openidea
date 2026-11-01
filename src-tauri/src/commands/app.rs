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

/// The directories the app currently uses, for the Configuration directory
/// settings row (Settings › System Settings).
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppHome {
    pub config_dir: ide_core::IpcPath,
    pub data_dir: ide_core::IpcPath,
    /// The custom base itself, when one is set (config/ and system/ under it).
    pub base: Option<ide_core::IpcPath>,
    pub env_override: bool,
}

#[tauri::command]
#[specta::specta]
pub fn app_home() -> AppHome {
    let resolved = crate::paths::current();
    let base = match &resolved.layout {
        crate::paths::Layout::Custom(base) => Some(base.clone().into()),
        crate::paths::Layout::Default => None,
    };
    AppHome {
        config_dir: resolved.locations.config.clone().into(),
        data_dir: resolved.locations.data.clone().into(),
        base,
        env_override: std::env::var_os("OPENIDEA_HOME").is_some(),
    }
}

/// Records a switch to `path` (Settings › Configuration directory). The new
/// directory takes effect on the next start, when the migration dialog asks
/// whether to move the existing data.
#[tauri::command]
#[specta::specta]
pub fn app_home_set(path: String) -> IdeResult<()> {
    let resolved = crate::paths::current();
    if std::env::var_os("OPENIDEA_HOME").is_some() {
        return Err(IdeError::internal("OPENIDEA_HOME is set and takes precedence"));
    }
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return Err(IdeError::internal("the configuration directory must be an absolute path"));
    }
    if let crate::paths::Layout::Custom(base) = &resolved.layout
        && base == &target
    {
        // The same directory: nothing to switch, but choosing it again
        // revives the prompt a decline may have silenced.
        crate::paths::clear_skip_marker(&resolved.defaults.0);
        return Ok(());
    }
    std::fs::create_dir_all(&target).map_err(|e| IdeError::internal(e.to_string()))?;
    let current = match &resolved.layout {
        crate::paths::Layout::Custom(base) => Some(base.as_path()),
        crate::paths::Layout::Default => None,
    };
    if crate::paths::base_conflicts(&target, &resolved.defaults, current) {
        return Err(IdeError::internal(
            "the configuration directory must not be inside or contain an existing data directory",
        ));
    }
    // The pointer records where the data currently lives, so the next start
    // can offer to migrate it; a new switch also asks again.
    crate::paths::write_pointer(&resolved.defaults.0, &crate::paths::Layout::Custom(target), Some(&resolved.layout))
        .map_err(|e| IdeError::internal(e.to_string()))?;
    crate::paths::clear_skip_marker(&resolved.defaults.0);
    Ok(())
}

/// Records a switch back to the platform defaults; mirrors `app_home_set`.
#[tauri::command]
#[specta::specta]
pub fn app_home_reset() -> IdeResult<()> {
    let resolved = crate::paths::current();
    if std::env::var_os("OPENIDEA_HOME").is_some() {
        return Err(IdeError::internal("OPENIDEA_HOME is set and takes precedence"));
    }
    // Already on the defaults: nothing to record (an idempotent no-op).
    let crate::paths::Layout::Custom(base) = &resolved.layout else {
        return Ok(());
    };
    crate::paths::write_pointer(
        &resolved.defaults.0,
        &crate::paths::Layout::Default,
        Some(&crate::paths::Layout::Custom(base.clone())),
    )
    .map_err(|e| IdeError::internal(e.to_string()))?;
    crate::paths::clear_skip_marker(&resolved.defaults.0);
    Ok(())
}

/// What a migration would do, for the startup dialog: move `entries` from
/// the previous location into the resolved one.
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    pub pending: bool,
    pub entries: usize,
    pub from: Vec<ide_core::IpcPath>,
    pub to: Vec<ide_core::IpcPath>,
}

/// The directories a layout writes (the two sides, or one when the platform
/// keeps them together).
fn side_dirs(layout: &crate::paths::Layout, defaults: &(PathBuf, PathBuf)) -> Vec<ide_core::IpcPath> {
    let (config, data) = crate::paths::side_roots(layout, defaults);
    let mut dirs = vec![config];
    if data != dirs[0] {
        dirs.push(data);
    }
    dirs.into_iter().map(Into::into).collect()
}

#[tauri::command]
#[specta::specta]
pub fn migration_status() -> MigrationStatus {
    let resolved = crate::paths::current();
    let from = crate::paths::previous_layout(resolved);
    let entries = from
        .as_ref()
        .map(|f| crate::paths::migration_pending(f, &resolved.layout, &resolved.defaults).unwrap_or(0))
        .unwrap_or(0);
    MigrationStatus {
        pending: entries > 0,
        entries,
        from: from.as_ref().map(|f| side_dirs(f, &resolved.defaults)).unwrap_or_default(),
        to: side_dirs(&resolved.layout, &resolved.defaults),
    }
}

/// Moves the previous location's data into the resolved one (after a
/// switch): migrate, rewrite stored paths, move the previous directories to
/// the trash, and drop the pointer's previous line so the dialog stays gone.
/// With any failed entry the previous location is kept and asked about again
/// on the next start.
#[tauri::command]
#[specta::specta]
pub fn migration_apply(state: State<'_, AppState>) -> crate::paths::Migration {
    let resolved = crate::paths::current();
    let Some(from) = crate::paths::previous_layout(resolved) else {
        return crate::paths::Migration::default();
    };
    let to = &resolved.layout;
    let result = crate::paths::migrate(&from, to, &resolved.defaults, state.fresh_target);
    if result.failed == 0 {
        if let Err(e) = crate::paths::rewrite(&from, to, &resolved.defaults) {
            tracing::warn!("migration: rewriting stored paths failed: {e}");
        }
        if let Err(e) = crate::paths::trash(&from, &resolved.defaults) {
            tracing::warn!("migration: moving the previous directories to the trash failed: {e}");
        }
        // The trash may have taken the pointer file with it (it sits inside
        // the default config dir): drop it when the target is the defaults,
        // else rewrite it so the new base stays authoritative.
        match to {
            crate::paths::Layout::Default => crate::paths::remove_pointer(&resolved.defaults.0),
            crate::paths::Layout::Custom(base) => {
                let _ = crate::paths::write_pointer(
                    &resolved.defaults.0,
                    &crate::paths::Layout::Custom(base.clone()),
                    None,
                );
            }
        }
    }
    tracing::info!("migration: {} entries moved into the resolved location ({} failed)", result.moved, result.failed);
    result
}

/// The dialog's "Don't migrate"; `remember` records "don't ask again" until
/// the next switch.
#[tauri::command]
#[specta::specta]
pub fn migration_decline(remember: bool) -> IdeResult<()> {
    let resolved = crate::paths::current();
    if remember {
        crate::paths::write_skip_marker(&resolved.defaults.0).map_err(|e| IdeError::internal(e.to_string()))?;
    }
    Ok(())
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
    window.state::<AppState>().sink.emit(ide_core::IdeEvent::WindowGroupsChanged);
    let grouped = window.state::<crate::windows::WindowsState>().groups.lock().group(window.label()).is_some();
    if grouped {
        crate::window_groups::persist(window.app_handle()).await?;
    }
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
        crate::window_groups::detach(&app, &label)?;
        crate::window_groups::persist(&app).await?;
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
    if let Some(workspace) = ide_workspace::workspace::Workspace::load(&project.root)? {
        return ide_host::ops::project::save_workspace(&state.host, window.label(), name, workspace.projects);
    }
    let value = if name.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(name.to_owned()) };
    project.settings.set(SettingsScope::Project, "general.projectName", value)?;
    state.recent.rename(&project.root, (!name.is_empty()).then_some(name))?;
    Ok(project_info(&project))
}

#[tauri::command]
#[specta::specta]
pub fn close_project(window: Window, state: State<'_, AppState>) {
    crate::windows::close_settings_window(window.app_handle(), window.label());
    let _ = crate::window_groups::detach(window.app_handle(), window.label());
    state.close_project(window.label());
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::window_groups::persist(&app).await;
    });
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

#[tauri::command]
#[specta::specta]
pub fn project_trust_status(state: State<'_, AppState>, path: PathBuf) -> IdeResult<ide_host::trust::TrustStatus> {
    state.trust.status(&path)
}

#[tauri::command]
#[specta::specta]
pub fn project_trust_list(state: State<'_, AppState>) -> IdeResult<ide_host::trust::TrustDecisions> {
    state.trust.decisions()
}

#[tauri::command]
#[specta::specta]
pub async fn project_trust_set(
    state: State<'_, AppState>,
    path: PathBuf,
    trusted: bool,
    folder: bool,
) -> IdeResult<()> {
    state.host.set_project_trust(&path, trusted, folder).await?;
    if !trusted {
        state.plugins.restrict_project(&dunce::canonicalize(&path).unwrap_or(path));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn project_trust_remove_location(state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    state.trust.remove_location(&path)?;
    state.host.refresh_project_trust().await?;
    for project in state.host.projects().into_iter().filter(|p| !p.is_trusted()) {
        state.plugins.restrict_project(&project.root);
    }
    Ok(())
}
