//! Desktop shell: project windows, native menu, quit flow, logs, updates.

use crate::menu::{self, MenuConfig, MenuState};
use crate::state::AppState;
use crate::windows::{self, Launch, OpenOutcome, WindowsState};
use ide_core::{IdeError, IdeResult, RequestId};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// Opens `path` in a new window (`new_window`) or tells the caller to open it
/// itself (`current`). A project already open in some window is focused instead.
/// `files` then open in that project's editor.
#[tauri::command]
#[specta::specta]
pub async fn window_open_project(
    app: AppHandle,
    path: PathBuf,
    new_window: bool,
    files: Vec<PathBuf>,
) -> IdeResult<OpenOutcome> {
    windows::open_project_window(&app, &path, new_window, files)
}

/// Loose `files` opened from a window without a local project: a file inside a local project
/// open in some window goes to that window, the others to the LightEdit window (this one,
/// another, or a new one from a remote project window). Returns the files this window opens
/// itself, in LightEdit.
#[tauri::command]
#[specta::specta]
pub async fn window_open_files(
    app: AppHandle,
    window: WebviewWindow,
    files: Vec<PathBuf>,
) -> IdeResult<Vec<ide_core::IpcPath>> {
    Ok(windows::open_files_window(&app, window.label(), files))
}

/// [`window_open_project`] for folder `path` on the host of SSH configuration
/// `ssh_config` (Remote Development); a new window connects itself.
#[tauri::command]
#[specta::specta]
pub async fn window_open_remote(
    app: AppHandle,
    ssh_config: String,
    path: String,
    new_window: bool,
) -> IdeResult<OpenOutcome> {
    windows::open_remote_window(&app, &ssh_config, &path, new_window)
}

/// Opens an empty (welcome) window; returns its label.
#[tauri::command]
#[specta::specta]
pub async fn window_new(app: AppHandle) -> IdeResult<String> {
    windows::create_window(&app, None).map(|w| w.label().to_owned())
}

/// Opens this window's Settings window on `page` (or focuses it and navigates);
/// `new_projects` edits the global layer only ("Settings for New Projects").
/// `background` (`#rrggbb`) paints a new window until its page has loaded.
#[tauri::command]
#[specta::specta]
pub async fn window_open_settings(
    app: AppHandle,
    window: WebviewWindow,
    page: Option<String>,
    new_projects: bool,
    background: Option<String>,
) -> IdeResult<()> {
    windows::open_settings_window(&app, &window, page, new_projects, background)
}

/// Focuses the next / previous window (⌘` / ⇧⌘`).
#[tauri::command]
#[specta::specta]
pub fn window_cycle(app: AppHandle, window: WebviewWindow, forward: bool) {
    windows::cycle(&app, window.label(), forward);
}

#[tauri::command]
#[specta::specta]
pub fn window_toggle_fullscreen(window: WebviewWindow) -> IdeResult<bool> {
    let on = !window.is_fullscreen().map_err(|e| IdeError::internal(e.to_string()))?;
    window.set_fullscreen(on).map_err(|e| IdeError::internal(e.to_string()))?;
    Ok(on)
}

/// What this window was opened for (taken once).
#[tauri::command]
#[specta::specta]
pub fn window_take_launch(window: WebviewWindow, windows: State<'_, WindowsState>) -> Option<Launch> {
    windows.take_launch(window.label())
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenProject {
    pub name: String,
    pub root: PathBuf,
    /// Open in the calling window.
    pub current: bool,
}

/// Projects open in project windows, in window order (title bar project widget).
#[tauri::command]
#[specta::specta]
pub fn window_open_projects(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> IdeResult<Vec<OpenProject>> {
    Ok(windows::project_window_labels(&app)
        .into_iter()
        .filter_map(|label| {
            let project = state.project(&label).ok().filter(|p| !p.light)?;
            Some(OpenProject {
                name: project.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                root: project.root.clone(),
                current: label == window.label(),
            })
        })
        .collect())
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloseContext {
    /// Quit is in progress (exit was already confirmed).
    pub quitting: bool,
    /// Number of open project windows (settings windows excluded), including the caller.
    pub windows: u32,
}

#[tauri::command]
#[specta::specta]
pub fn window_close_context(app: AppHandle, windows: State<'_, WindowsState>) -> CloseContext {
    CloseContext { quitting: windows.quitting(), windows: windows::project_window_labels(&app).len() as u32 }
}

/// Quits: closes every window, each of which runs its own unsaved-changes check.
#[tauri::command]
#[specta::specta]
pub fn app_quit(app: AppHandle, windows: State<'_, WindowsState>) {
    windows.set_quitting(true);
    let all = app.webview_windows();
    if all.is_empty() {
        app.exit(0);
    }
    for w in all.values() {
        let _ = w.close();
    }
}

/// A window vetoed the quit (user cancelled its unsaved-changes prompt).
#[tauri::command]
#[specta::specta]
pub fn app_cancel_quit(windows: State<'_, WindowsState>) {
    windows.set_quitting(false);
}

/// Sets the menu's labels / shortcut text (on locale or keymap change) and rebuilds it.
#[tauri::command]
#[specta::specta]
pub fn menu_configure(
    app: AppHandle,
    menu_state: State<'_, MenuState>,
    state: State<'_, AppState>,
    config: MenuConfig,
) {
    *menu_state.config.lock() = config;
    menu::install(&app, &menu_state, &state.recent.list());
}

/// Rebuilds the menu (e.g. after the recent-projects list changed).
#[tauri::command]
#[specta::specta]
pub fn menu_refresh(app: AppHandle, menu_state: State<'_, MenuState>, state: State<'_, AppState>) {
    menu::install(&app, &menu_state, &state.recent.list());
}

/// The menu bar for a title bar drawn by the frontend (Windows).
#[tauri::command]
#[specta::specta]
pub fn menu_model(app: AppHandle, state: State<'_, AppState>, menu_state: State<'_, MenuState>) -> Vec<menu::MenuNode> {
    let mut spec = menu::spec(menu::Os::current());
    if !updates_configured(&app) {
        spec = menu::without_action(spec, "app.checkForUpdates");
    }
    let home = dirs::home_dir();
    let config = menu_state.config.lock().clone();
    menu::model(&spec, &menu::recent_items(&state.recent.list(), home.as_deref()), &config)
}

/// Action ids the focused window cannot run now: their native menu items are
/// disabled in place (no rebuild).
#[tauri::command]
#[specta::specta]
pub fn menu_set_disabled(app: AppHandle, menu_state: State<'_, MenuState>, ids: Vec<String>) {
    let disabled: std::collections::HashSet<String> = ids.into_iter().collect();
    if *menu_state.disabled.lock() == disabled {
        return;
    }
    *menu_state.disabled.lock() = disabled.clone();
    if menu::native_menu_bar() {
        menu::apply_disabled(&app, &disabled);
    }
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogLocation {
    pub dir: ide_core::IpcPath,
    /// Current log file, if one was written yet.
    pub file: Option<ide_core::IpcPath>,
}

#[tauri::command]
#[specta::specta]
pub fn app_log_location() -> IdeResult<LogLocation> {
    let dir = crate::logging::log_dir().ok_or_else(|| IdeError::unavailable("file logging is not active"))?;
    Ok(LogLocation { dir: dir.into(), file: crate::logging::latest_log(dir).map(Into::into) })
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: String,
    /// Build id from CI (`OPENIDEA_BUILD` at compile time), else `dev`.
    pub build: String,
    pub profile: String,
    pub os: String,
    pub arch: String,
    pub tauri: String,
    /// An update endpoint is configured ("Check for Updates…" is offered).
    pub updates: bool,
}

#[tauri::command]
#[specta::specta]
pub fn app_build_info(app: AppHandle) -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        build: option_env!("OPENIDEA_BUILD").unwrap_or("dev").into(),
        profile: if cfg!(debug_assertions) { "debug" } else { "release" }.into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        tauri: tauri::VERSION.into(),
        updates: updates_configured(&app),
    }
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// False when no update endpoint is configured (no request was made).
    pub enabled: bool,
    pub update: Option<UpdateInfo>,
}

fn update_endpoint_env() -> Option<String> {
    std::env::var("OPENIDEA_UPDATE_ENDPOINT").ok().filter(|s| !s.trim().is_empty())
}

/// Whether an update endpoint is configured: `plugins.updater.endpoints` in
/// tauri.conf.json, or the `OPENIDEA_UPDATE_ENDPOINT` environment variable. Empty by
/// default, and "Check for Updates…" is hidden then.
pub fn updates_configured<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    let in_config = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("endpoints"))
        .and_then(|e| e.as_array())
        .is_some_and(|e| !e.is_empty());
    in_config || update_endpoint_env().is_some()
}

fn updater(app: &AppHandle) -> IdeResult<Option<tauri_plugin_updater::Updater>> {
    use tauri_plugin_updater::UpdaterExt;
    if !updates_configured(app) {
        return Ok(None);
    }
    let env = update_endpoint_env();
    let proxy = ide_core::proxy_settings::proxy();
    let mut builder = app.updater_builder().configure_client(move |b| ide_http::client::with_proxy(b, &proxy));
    if let Some(url) = env {
        let url = url.parse().map_err(|e| IdeError::invalid(format!("OPENIDEA_UPDATE_ENDPOINT: {e}")))?;
        builder = builder.endpoints(vec![url]).map_err(|e| IdeError::invalid(e.to_string()))?;
    }
    builder.build().map(Some).map_err(|e| IdeError::unavailable(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn app_check_update(app: AppHandle) -> IdeResult<UpdateCheck> {
    let Some(updater) = updater(&app)? else {
        return Ok(UpdateCheck { enabled: false, update: None });
    };
    let update = updater.check().await.map_err(|e| IdeError::unavailable(e.to_string()))?;
    Ok(UpdateCheck {
        enabled: true,
        update: update.map(|u| UpdateInfo {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            notes: u.body.clone(),
            date: u.date.map(|d| d.to_string()),
        }),
    })
}

/// The background check made once per process when the first window starts;
/// later calls (other windows) and debug builds get `None`. Failures are logged,
/// not reported: the user didn't ask for this check.
#[tauri::command]
#[specta::specta]
pub async fn app_startup_update_check(app: AppHandle) -> Option<UpdateInfo> {
    static DONE: AtomicBool = AtomicBool::new(false);
    if cfg!(debug_assertions) || DONE.swap(true, Ordering::SeqCst) {
        return None;
    }
    match app_check_update(app).await {
        Ok(check) => check.update,
        Err(e) => {
            tracing::warn!("startup update check failed: {e}");
            None
        }
    }
}

/// Progress of [`app_install_update`], streamed to the UI's background task.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UpdateProgress {
    /// Bytes received so far; `total` when the server sends a length.
    Downloading { downloaded: f64, total: Option<f64> },
    /// Download done; the new version is being written over this one.
    Installing,
}

/// Limits download events to one per whole percent (or per 256 KiB without a length).
#[derive(Default)]
struct ProgressThrottle {
    downloaded: u64,
    last_step: Option<u64>,
}

impl ProgressThrottle {
    const UNKNOWN_STEP: u64 = 256 * 1024;

    fn chunk(&mut self, len: usize, total: Option<u64>) -> Option<UpdateProgress> {
        self.downloaded += len as u64;
        let step = match total {
            Some(t) if t > 0 => self.downloaded.min(t) * 100 / t,
            _ => self.downloaded / Self::UNKNOWN_STEP,
        };
        if self.last_step == Some(step) {
            return None;
        }
        self.last_step = Some(step);
        Some(UpdateProgress::Downloading { downloaded: self.downloaded as f64, total: total.map(|t| t as f64) })
    }
}

/// Set while an update is being downloaded or installed (by any window).
static INSTALLING: AtomicBool = AtomicBool::new(false);

struct InstallingGuard;

impl InstallingGuard {
    fn acquire() -> Option<Self> {
        (!INSTALLING.swap(true, Ordering::SeqCst)).then_some(Self)
    }
}

impl Drop for InstallingGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
    }
}

/// Downloads and installs the available update, streaming progress to `on_progress`.
/// Cancellable through `request` until the download completes; the UI then restarts
/// with `app_restart`. One install runs at a time.
#[tauri::command]
#[specta::specta]
pub async fn app_install_update(
    app: AppHandle,
    state: State<'_, AppState>,
    request: RequestId,
    on_progress: Channel<UpdateProgress>,
) -> IdeResult<()> {
    let _guard =
        InstallingGuard::acquire().ok_or_else(|| IdeError::unavailable("an update is already being installed"))?;
    let token = state.host.begin_request(request);
    let result = async {
        let updater = updater(&app)?.ok_or_else(|| IdeError::unavailable("updates are not configured"))?;
        let update = tokio::select! {
            r = updater.check() => r.map_err(|e| IdeError::unavailable(e.to_string()))?,
            _ = token.cancelled() => return Err(IdeError::cancelled()),
        }
        .ok_or_else(|| IdeError::not_found("no update available"))?;
        let mut throttle = ProgressThrottle::default();
        let progress = on_progress.clone();
        let download = update.download(
            move |len, total| {
                if let Some(p) = throttle.chunk(len, total) {
                    let _ = progress.send(p);
                }
            },
            || {},
        );
        let bytes = tokio::select! {
            r = download => r.map_err(|e| IdeError::unavailable(e.to_string()))?,
            _ = token.cancelled() => return Err(IdeError::cancelled()),
        };
        let _ = on_progress.send(UpdateProgress::Installing);
        tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| IdeError::internal(e.to_string()))?
            .map_err(|e| IdeError::internal(e.to_string()))
    }
    .await;
    state.host.end_request(request);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn downloading(p: Option<UpdateProgress>) -> Option<(f64, Option<f64>)> {
        match p? {
            UpdateProgress::Downloading { downloaded, total } => Some((downloaded, total)),
            UpdateProgress::Installing => None,
        }
    }

    #[test]
    fn throttle_reports_each_whole_percent_once() {
        let mut t = ProgressThrottle::default();
        assert_eq!(downloading(t.chunk(1, Some(1000))), Some((1.0, Some(1000.0))));
        assert_eq!(downloading(t.chunk(5, Some(1000))), None);
        assert_eq!(downloading(t.chunk(4, Some(1000))), Some((10.0, Some(1000.0))));
        let reported = (0..99).filter(|_| t.chunk(10, Some(1000)).is_some()).count();
        assert_eq!(reported, 99);
        assert_eq!(t.downloaded, 1000);
    }

    #[test]
    fn throttle_without_length_reports_per_step() {
        let mut t = ProgressThrottle::default();
        assert!(t.chunk(10, None).is_some());
        assert!(t.chunk(1024, None).is_none());
        assert_eq!(downloading(t.chunk(256 * 1024, None)), Some(((256 * 1024 + 1034) as f64, None)));
        // A zero length is treated as unknown, not divided by.
        assert!(ProgressThrottle::default().chunk(1, Some(0)).is_some());
    }

    #[test]
    fn only_one_install_at_a_time() {
        let first = InstallingGuard::acquire().expect("first install starts");
        assert!(InstallingGuard::acquire().is_none());
        drop(first);
        assert!(InstallingGuard::acquire().is_some());
    }
}
