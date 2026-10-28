//! Project windows: one project per window, labelled `main` or `project-<n>`.
//!
//! A new window is built from the `main` window config (overlay title bar,
//! traffic lights, min size, background colour). What it should open is kept
//! here as a pending [`Launch`] that its frontend takes on startup
//! (`window_take_launch`), and re-taken whenever [`LAUNCH_EVENT`] fires (a
//! second app instance asking an already-loaded window to open a path).
//!
//! Settings open in a native child window `settings-<parent>` (one per project
//! window) that shares its parent's project (see [`AppState::project`]); its
//! [`Launch::settings_page`] tells it which page to show.

use crate::state::AppState;
use crate::theme_frame::builtin_frame;
use ide_core::settings::AppearanceSettings;
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::utils::config::{Color, WindowConfig};
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewWindow, WebviewWindowBuilder};

/// Tells a window that a pending launch is waiting for it.
pub const LAUNCH_EVENT: &str = "openidea://launch";
const MAIN: &str = "main";
const PREFIX: &str = "project-";
const SETTINGS_PREFIX: &str = "settings-";
const CASCADE: f64 = 28.0;
const SETTINGS_SIZE: (f64, f64) = (980.0, 720.0);
const SETTINGS_MIN_SIZE: (f64, f64) = (640.0, 420.0);

/// What a freshly opened window should do once its frontend is up.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    /// Project folder to open.
    pub project: Option<ide_core::IpcPath>,
    /// Files to open in the editor: in `project` once it is open, else in this
    /// window's project or (without one) in LightEdit.
    pub files: Vec<ide_core::IpcPath>,
    /// Remote project to open (Remote Development).
    pub remote: Option<RemoteLaunch>,
    /// Settings windows: the page to show.
    pub settings_page: Option<String>,
    /// Settings windows: edit the global layer only ("Settings for New Projects").
    pub new_projects: bool,
}

/// A project folder on the host of an SSH configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLaunch {
    pub ssh_config: String,
    pub path: String,
}

#[derive(Default)]
pub struct WindowsState {
    launches: Mutex<HashMap<String, Launch>>,
    /// Most recently focused window label (menu events go there).
    last_focused: Mutex<Option<String>>,
    /// Set by Quit while windows close one by one.
    quitting: AtomicBool,
    /// Relaunch once the quit completes (after installing an update).
    restart: AtomicBool,
}

impl WindowsState {
    pub fn set_launch(&self, label: &str, launch: Launch) {
        self.launches.lock().insert(label.to_owned(), launch);
    }

    pub fn take_launch(&self, label: &str) -> Option<Launch> {
        self.launches.lock().remove(label)
    }

    pub fn focused(&self, label: &str) {
        *self.last_focused.lock() = Some(label.to_owned());
    }

    pub fn forget(&self, label: &str) {
        self.launches.lock().remove(label);
        let mut last = self.last_focused.lock();
        if last.as_deref() == Some(label) {
            *last = None;
        }
    }

    pub fn last_focused(&self) -> Option<String> {
        self.last_focused.lock().clone()
    }

    pub fn set_quitting(&self, on: bool) {
        self.quitting.store(on, Ordering::SeqCst);
        if !on {
            self.restart.store(false, Ordering::SeqCst);
        }
    }

    pub fn set_restart(&self) {
        self.restart.store(true, Ordering::SeqCst);
    }

    pub fn restart_requested(&self) -> bool {
        self.restart.load(Ordering::SeqCst)
    }

    pub fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
}

/// The project window a settings window belongs to (`settings-main` → `main`).
pub fn settings_parent(label: &str) -> Option<&str> {
    label.strip_prefix(SETTINGS_PREFIX)
}

pub fn is_settings_window(label: &str) -> bool {
    settings_parent(label).is_some()
}

pub fn settings_label(parent: &str) -> String {
    format!("{SETTINGS_PREFIX}{parent}")
}

/// Closes `parent`'s settings window: it shows (and would apply to) the project the parent is leaving.
pub fn close_settings_window(app: &AppHandle, parent: &str) {
    if let Some(w) = app.get_webview_window(&settings_label(parent)) {
        let _ = w.close();
    }
}

/// Project windows (everything but settings windows), for counting and cycling.
pub fn project_window_labels(app: &AppHandle) -> Vec<String> {
    sorted_labels(app.webview_windows().keys().map(String::as_str).filter(|l| !is_settings_window(l)))
}

/// Sort key: `main` first, then `project-<n>` by n, then anything else.
fn order_key(label: &str) -> (u8, u64, String) {
    if label == MAIN {
        (0, 0, String::new())
    } else if let Some(n) = label.strip_prefix(PREFIX).and_then(|n| n.parse().ok()) {
        (1, n, String::new())
    } else {
        (2, 0, label.to_owned())
    }
}

pub fn sorted_labels<'a>(labels: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut v: Vec<String> = labels.into_iter().map(str::to_owned).collect();
    v.sort_by_key(|l| order_key(l));
    v
}

/// Lowest free `project-<n>` label.
pub fn next_label<'a>(existing: impl IntoIterator<Item = &'a str>) -> String {
    let used: std::collections::HashSet<&str> = existing.into_iter().collect();
    (1..).map(|n| format!("{PREFIX}{n}")).find(|l| !used.contains(l.as_str())).expect("unbounded")
}

/// The window after (or before) `current` in label order, wrapping around.
pub fn cycle_target(sorted: &[String], current: &str, forward: bool) -> Option<String> {
    if sorted.len() < 2 {
        return None;
    }
    let i = sorted.iter().position(|l| l == current).unwrap_or(0);
    let n = sorted.len();
    let j = if forward { (i + 1) % n } else { (i + n - 1) % n };
    Some(sorted[j].clone())
}

/// The project path from command-line arguments (`openidea /path/to/project`):
/// the first argument after the binary that is not a flag, resolved against `cwd`.
pub fn cli_path(args: &[String], cwd: &Path) -> Option<PathBuf> {
    args.iter().skip(1).find(|a| !a.starts_with('-') && !a.is_empty() && !a.starts_with("psn_")).map(|a| {
        let p = PathBuf::from(a);
        if p.is_absolute() { p } else { cwd.join(p) }
    })
}

pub fn focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// The window whose open project is `root` (already canonical).
pub fn find_project_window(app: &AppHandle, root: &Path) -> Option<WebviewWindow> {
    let state = app.try_state::<AppState>()?;
    app.webview_windows().into_iter().filter(|(label, _)| !is_settings_window(label)).find_map(|(label, w)| {
        let project = state.project(&label).ok()?;
        (project.root == root && !project.light).then_some(w)
    })
}

/// The window editing loose files (LightEdit), if any: more files open there.
pub fn find_light_window(app: &AppHandle) -> Option<WebviewWindow> {
    let state = app.try_state::<AppState>()?;
    let windows = app.webview_windows();
    let labels = sorted_labels(windows.keys().map(String::as_str).filter(|l| !is_settings_window(l)));
    labels.into_iter().find(|l| state.project(l).is_ok_and(|p| p.light)).and_then(|l| windows.get(&l).cloned())
}

/// Hands `files` to the already loaded `window` (its frontend takes them on [`LAUNCH_EVENT`]) and focuses it.
fn send_files(app: &AppHandle, window: &WebviewWindow, files: Vec<PathBuf>) {
    let launch = Launch { files: files.into_iter().map(Into::into).collect(), ..Default::default() };
    app.state::<WindowsState>().set_launch(window.label(), launch);
    let _ = app.emit_to(window.label(), LAUNCH_EVENT, ());
    focus(window);
}

fn has_project(app: &AppHandle, label: &str) -> bool {
    app.try_state::<AppState>().is_some_and(|s| s.project(label).is_ok() || s.remote_dev.get(label).is_some())
}

/// The focused window, else the last focused, else any.
pub fn target_window(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    if let Some(w) = windows.values().find(|w| w.is_focused().unwrap_or(false)) {
        return Some(w.clone());
    }
    let last = app.state::<WindowsState>().last_focused();
    if let Some(w) = last.and_then(|l| windows.get(&l)) {
        return Some(w.clone());
    }
    sorted_labels(windows.keys().map(String::as_str)).first().and_then(|l| windows.get(l)).cloned()
}

fn window_config(app: &AppHandle) -> IdeResult<WindowConfig> {
    app.config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN)
        .or_else(|| app.config().app.windows.first())
        .cloned()
        .ok_or_else(|| IdeError::internal("no window configuration"))
}

/// The theme's `--bg-frame` (tokens.css), mirroring `resolveThemeId` in theme.ts.
pub fn frame_color(appearance: &AppearanceSettings, os_dark: bool) -> Color {
    let sync = appearance.sync_with_os || appearance.theme == "system";
    let theme = match (sync, os_dark) {
        (false, _) => &appearance.theme,
        (true, true) => &appearance.preferred_dark_theme,
        (true, false) => &appearance.preferred_light_theme,
    };
    builtin_frame(theme)
        .or_else(|| builtin_frame(if sync && os_dark { "dark" } else { "light" }))
        .unwrap_or(Color(0xe9, 0xea, 0xee, 0xff))
}

/// A `#rgb` / `#rrggbb` / `#rrggbbaa` colour sent by the UI (Tauri's own parser).
fn hex_color(hex: &str) -> Option<Color> {
    serde_json::from_value(serde_json::Value::String(hex.to_owned())).ok()
}

/// Builds a project window painted in the saved theme's frame colour, so it
/// doesn't flash the light default before its page (and splash) loads.
fn build_project_window(app: &AppHandle, mut config: WindowConfig) -> IdeResult<WebviewWindow> {
    let state = app.try_state::<AppState>();
    let appearance = state.as_ref().map(|s| s.global_settings.effective().appearance);
    // A plugin theme replaces the built-in one in either OS mode; the UI records its resolved frame.
    let plugin_frame = state.as_ref().and_then(|s| s.plugins.startup_frame()).and_then(|c| hex_color(&c));
    if let Some(color) = plugin_frame {
        config.background_color = Some(color);
    } else if let Some(a) = &appearance {
        config.background_color = Some(frame_color(a, false));
    }
    let window = WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| b.build())
        .map_err(|e| IdeError::internal(format!("cannot create window: {e}")))?;
    apply_zoom(app, &window);
    // "Sync with OS" needs the OS mode, known once the window exists.
    if let Some(a) = appearance.filter(|a| plugin_frame.is_none() && (a.sync_with_os || a.theme == "system"))
        && window.theme().is_ok_and(|t| t == Theme::Dark)
    {
        let _ = window.set_background_color(Some(frame_color(&a, true)));
    }
    Ok(window)
}

/// Sets the saved IDE zoom before the page loads; applied later by the frontend,
/// it would visibly scale up the splash.
fn apply_zoom(app: &AppHandle, window: &WebviewWindow) {
    let Some(zoom) = app.try_state::<AppState>().map(|s| s.global_settings.effective().appearance.zoom) else {
        return;
    };
    if zoom != 100 {
        let _ = window.set_zoom(f64::from(zoom) / 100.0);
    }
}

/// The first window (`create: false` in tauri.conf.json so it can take the theme's colour).
pub fn create_main_window(app: &AppHandle) -> IdeResult<WebviewWindow> {
    build_project_window(app, window_config(app)?)
}

/// Creates a new project window; `project` is opened by its frontend on load.
pub fn create_window(app: &AppHandle, project: Option<PathBuf>) -> IdeResult<WebviewWindow> {
    create_window_with(app, project, Vec::new())
}

/// [`create_window`] that also opens `files` (without `project`: in LightEdit).
fn create_window_with(app: &AppHandle, project: Option<PathBuf>, files: Vec<PathBuf>) -> IdeResult<WebviewWindow> {
    let title = project.as_deref().or(files.first().map(PathBuf::as_path)).and_then(Path::file_name);
    let title = title.map(|n| n.to_string_lossy().into_owned());
    let files = files.into_iter().map(Into::into).collect();
    create_window_for(app, title, Launch { project: project.map(Into::into), files, ..Default::default() })
}

fn create_window_for(app: &AppHandle, title: Option<String>, launch: Launch) -> IdeResult<WebviewWindow> {
    let windows = app.webview_windows();
    let label = next_label(windows.keys().map(String::as_str));
    let mut config = window_config(app)?;
    config.label = label.clone();
    if let Some(title) = title {
        config.title = title;
    }
    // Cascade from the window the user is looking at; window-state overrides
    // this with the remembered geometry when it has one for the label.
    if let Some(anchor) = target_window(app)
        && let (Ok(pos), Ok(scale)) = (anchor.outer_position(), anchor.scale_factor())
    {
        let pos = pos.to_logical::<f64>(scale);
        config.x = Some(pos.x + CASCADE);
        config.y = Some(pos.y + CASCADE);
        config.center = false;
    }
    app.state::<WindowsState>().set_launch(&label, launch);
    let window = build_project_window(app, config)?;
    focus(&window);
    Ok(window)
}

/// `create_window` off the event-loop thread (building a window from a
/// main-thread callback can deadlock on Windows).
pub fn spawn_window(app: &AppHandle, project: Option<PathBuf>) {
    spawn_window_with(app, project, Vec::new());
}

fn spawn_window_with(app: &AppHandle, project: Option<PathBuf>, files: Vec<PathBuf>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = create_window_with(&app, project, files) {
            tracing::warn!("cannot open window: {}", e.message);
        }
    });
}

/// How `open_project_window` satisfied the request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OpenOutcome {
    /// Already open in `label`; that window was focused.
    Focused { label: String },
    /// A new window `label` was created and opens the project itself.
    Opened { label: String },
    /// The caller should open the project in its own window.
    Current,
}

/// Opens folder `path` as a project and then `files` in its editor; see [`OpenOutcome`]
/// (`Current`: the caller opens both itself).
pub fn open_project_window(
    app: &AppHandle,
    path: &Path,
    new_window: bool,
    files: Vec<PathBuf>,
) -> IdeResult<OpenOutcome> {
    let root = dunce::canonicalize(path).map_err(|e| IdeError::not_found(format!("{}: {e}", path.display())))?;
    tracing::info!("open_project_window {} new_window={new_window}", root.display());
    if let Some(w) = find_project_window(app, &root) {
        if files.is_empty() {
            focus(&w);
        } else {
            send_files(app, &w, files);
        }
        return Ok(OpenOutcome::Focused { label: w.label().to_owned() });
    }
    if !new_window {
        return Ok(OpenOutcome::Current);
    }
    let window = create_window_with(app, Some(root), files)?;
    Ok(OpenOutcome::Opened { label: window.label().to_owned() })
}

/// Loose local `files` asked for by a window without a local project: they join
/// the LightEdit window when another one has it open; a window busy with a (remote)
/// project gets a new LightEdit window; else the caller opens them itself (`Current`).
pub fn open_files_window(app: &AppHandle, caller: &str, files: Vec<PathBuf>) -> IdeResult<OpenOutcome> {
    if let Some(w) = find_light_window(app).filter(|w| w.label() != caller) {
        send_files(app, &w, files);
        return Ok(OpenOutcome::Focused { label: w.label().to_owned() });
    }
    if !has_project(app, caller) {
        return Ok(OpenOutcome::Current);
    }
    let window = create_window_with(app, None, files)?;
    Ok(OpenOutcome::Opened { label: window.label().to_owned() })
}

/// [`open_project_window`] for folder `path` on the host of SSH configuration
/// `ssh_config` (Remote Development).
pub fn open_remote_window(app: &AppHandle, ssh_config: &str, path: &str, new_window: bool) -> IdeResult<OpenOutcome> {
    tracing::info!("open_remote_window {ssh_config}:{path} new_window={new_window}");
    let windows = app.webview_windows();
    let open = app.try_state::<AppState>().and_then(|s| s.remote_dev.window_of(ssh_config, path));
    if let Some(w) = open.and_then(|label| windows.get(&label)) {
        focus(w);
        return Ok(OpenOutcome::Focused { label: w.label().to_owned() });
    }
    if !new_window {
        return Ok(OpenOutcome::Current);
    }
    let title = path.trim_end_matches('/').rsplit('/').next().filter(|n| !n.is_empty() && *n != "~").map(str::to_owned);
    let remote = RemoteLaunch { ssh_config: ssh_config.to_owned(), path: path.to_owned() };
    let window = create_window_for(app, title, Launch { remote: Some(remote), ..Default::default() })?;
    Ok(OpenOutcome::Opened { label: window.label().to_owned() })
}

/// Opens `path` from the command line / a second instance: a folder focuses the
/// window that has it, a file joins the LightEdit window; else a window without
/// a project is reused, else a new one is made.
pub fn open_path(app: &AppHandle, path: &Path) {
    let path = match dunce::canonicalize(path) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("cannot open {}: {e}", path.display());
            return;
        }
    };
    let is_dir = path.is_dir();
    if is_dir && let Some(w) = find_project_window(app, &path) {
        focus(&w);
        return;
    }
    if !is_dir && let Some(w) = find_light_window(app) {
        send_files(app, &w, vec![path]);
        return;
    }
    let free = target_window(app)
        .filter(|w| !has_project(app, w.label()))
        .filter(|w| !is_settings_window(w.label()))
        .or_else(|| {
            app.webview_windows().into_values().find(|w| !is_settings_window(w.label()) && !has_project(app, w.label()))
        });
    let launch = path_launch(path);
    match free {
        Some(w) => {
            app.state::<WindowsState>().set_launch(w.label(), launch);
            let _ = app.emit_to(w.label(), LAUNCH_EVENT, ());
            focus(&w);
        }
        None => {
            let files = launch.files.into_iter().map(ide_core::IpcPath::into_path_buf).collect();
            spawn_window_with(app, launch.project.map(ide_core::IpcPath::into_path_buf), files)
        }
    }
}

/// What a window opens for a command-line path: a folder as its project, a file in LightEdit.
pub fn path_launch(path: PathBuf) -> Launch {
    if path.is_dir() {
        Launch { project: Some(path.into()), ..Default::default() }
    } else {
        Launch { files: vec![path.into()], ..Default::default() }
    }
}

/// Second instance launched: focus this one and open its path argument.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn on_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    match cli_path(&args, Path::new(&cwd)) {
        Some(path) => open_path(app, &path),
        None => {
            if let Some(w) = target_window(app) {
                focus(&w);
            } else {
                spawn_window(app, None);
            }
        }
    }
}

pub fn cycle(app: &AppHandle, current: &str, forward: bool) {
    let windows = app.webview_windows();
    let sorted = project_window_labels(app);
    if let Some(w) = cycle_target(&sorted, current, forward).and_then(|l| windows.get(&l)) {
        focus(w);
    }
}

/// Opens (or focuses) the settings window of `parent` showing `page`: a
/// native child window centred over its parent, sized like IDEA's Settings.
pub fn open_settings_window(
    app: &AppHandle,
    parent: &WebviewWindow,
    page: Option<String>,
    new_projects: bool,
    background: Option<String>,
) -> IdeResult<()> {
    // Asked from a settings window itself: navigate it.
    let parent_label = settings_parent(parent.label()).unwrap_or(parent.label()).to_owned();
    let label = settings_label(&parent_label);
    let windows = app.state::<WindowsState>();
    if let Some(existing) = app.get_webview_window(&label) {
        if page.is_some() || new_projects {
            windows.set_launch(&label, Launch { settings_page: page, new_projects, ..Default::default() });
            let _ = app.emit_to(label.as_str(), LAUNCH_EVENT, ());
        }
        focus(&existing);
        return Ok(());
    }
    let parent = app.get_webview_window(&parent_label).ok_or_else(|| IdeError::not_found("no parent window"))?;
    let mut config = window_config(app)?;
    config.label = label.clone();
    config.title = "Settings".into();
    // Frameless on Windows like project windows (tauri.windows.conf.json): the page draws
    // the title bar in the app theme instead of a system caption that follows the OS theme.
    (config.width, config.height) = SETTINGS_SIZE;
    (config.min_width, config.min_height) = (Some(SETTINGS_MIN_SIZE.0), Some(SETTINGS_MIN_SIZE.1));
    config.center = false;
    config.visible = false;
    config.maximized = false;
    config.fullscreen = false;
    config.drag_drop_enabled = false;
    // macOS shows a child window as soon as it is attached, before the page loads: paint the theme's frame colour.
    if let Some(color) = background.as_deref().and_then(hex_color) {
        config.background_color = Some(color);
    }
    windows.set_launch(&label, Launch { settings_page: page, new_projects, ..Default::default() });
    let window = WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| b.parent(&parent))
        .and_then(|b| b.build())
        .map_err(|e| IdeError::internal(format!("cannot create settings window: {e}")))?;
    apply_zoom(app, &window);
    // window-state restores the remembered size; the position always follows the parent.
    if let (Ok(pos), Ok(size), Ok(own), Ok(scale)) =
        (parent.outer_position(), parent.outer_size(), window.outer_size(), parent.scale_factor())
    {
        let (pos, size, own) =
            (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale), own.to_logical::<f64>(scale));
        let at = centered(pos.x, pos.y, size.width, size.height, own.width, own.height);
        let _ = window.set_position(tauri::LogicalPosition::new(at.0, at.1));
    }
    focus(&window);
    Ok(())
}

/// Top-left corner that centres a `w`×`h` window over the parent rectangle
/// (never above the parent's top edge, so the title bar stays reachable).
fn centered(px: f64, py: f64, pw: f64, ph: f64, w: f64, h: f64) -> (f64, f64) {
    (px + (pw - w) / 2.0, py + ((ph - h) / 2.0).max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn frame_color_follows_theme_and_os_mode() {
        let mut a = AppearanceSettings::default();
        assert_eq!(frame_color(&a, true), Color(0xe9, 0xea, 0xee, 0xff));
        a.theme = "dark-hc".into();
        assert_eq!(frame_color(&a, false), Color(0x1a, 0x1b, 0x1e, 0xff));
        a.sync_with_os = true;
        assert_eq!(frame_color(&a, false), Color(0xe9, 0xea, 0xee, 0xff));
        assert_eq!(frame_color(&a, true), Color(0x26, 0x28, 0x2c, 0xff));
    }

    #[test]
    fn additional_palettes_keep_native_startup_and_os_preferences_in_sync() {
        for (id, color) in [
            ("solarized-light", Color(0xee, 0xe8, 0xd5, 0xff)),
            ("solarized-dark", Color(0x07, 0x36, 0x42, 0xff)),
            ("one-light", Color(0xea, 0xea, 0xeb, 0xff)),
            ("one-dark", Color(0x21, 0x25, 0x2b, 0xff)),
        ] {
            let mut a = AppearanceSettings { theme: id.into(), ..Default::default() };
            assert_eq!(frame_color(&a, false), color);
            assert_eq!(frame_color(&a, true), color);
            a.sync_with_os = true;
            a.preferred_light_theme = id.into();
            a.preferred_dark_theme = id.into();
            assert_eq!(frame_color(&a, false), color);
            assert_eq!(frame_color(&a, true), color);
        }
    }

    #[test]
    fn frame_colours_from_the_ui_parse_as_hex() {
        for (hex, expected) in [
            ("#eaeaeb", Color(0xea, 0xea, 0xeb, 0xff)),
            ("#21252b", Color(0x21, 0x25, 0x2b, 0xff)),
            ("#8040bfcc", Color(0x80, 0x40, 0xbf, 0xcc)),
            ("#fff", Color(0xff, 0xff, 0xff, 0xff)),
        ] {
            assert_eq!(hex_color(hex), Some(expected), "{hex}");
        }
        assert_eq!(hex_color("hsl(220, 13%, 15%)"), None);
    }

    #[test]
    fn labels_sort_main_first_then_numerically() {
        assert_eq!(
            sorted_labels(["project-10", "project-2", "main", "x"]),
            s(&["main", "project-2", "project-10", "x"])
        );
    }

    #[test]
    fn next_label_fills_gaps() {
        assert_eq!(next_label(["main"]), "project-1");
        assert_eq!(next_label(["main", "project-1", "project-3"]), "project-2");
    }

    #[test]
    fn cycling_wraps_both_ways() {
        let w = s(&["main", "project-1", "project-2"]);
        assert_eq!(cycle_target(&w, "main", true).as_deref(), Some("project-1"));
        assert_eq!(cycle_target(&w, "project-2", true).as_deref(), Some("main"));
        assert_eq!(cycle_target(&w, "main", false).as_deref(), Some("project-2"));
        assert_eq!(cycle_target(&s(&["main"]), "main", true), None);
    }

    #[test]
    fn cli_path_skips_flags_and_resolves_relative() {
        let cwd = Path::new("/work");
        let args = s(&["openidea", "--verbose", "proj"]);
        assert_eq!(cli_path(&args, cwd), Some(PathBuf::from("/work/proj")));
        assert_eq!(cli_path(&s(&["openidea", "/abs/p"]), cwd), Some(PathBuf::from("/abs/p")));
        assert_eq!(cli_path(&s(&["openidea"]), cwd), None);
        assert_eq!(cli_path(&s(&["openidea", "-psn_0_123"]), cwd), None);
    }

    #[test]
    fn command_line_folders_open_as_projects_and_files_in_light_edit() {
        let dir = std::env::temp_dir();
        assert_eq!(path_launch(dir.clone()).project, Some(dir.into()));
        let file = std::env::current_exe().unwrap();
        let launch = path_launch(file.clone());
        assert_eq!((launch.project, launch.files), (None, vec![file.into()]));
    }

    #[test]
    fn launches_are_taken_once() {
        let st = WindowsState::default();
        st.set_launch("project-1", Launch { project: Some("/p".into()), ..Default::default() });
        assert_eq!(st.take_launch("project-1").and_then(|l| l.project), Some("/p".into()));
        assert_eq!(st.take_launch("project-1"), None);
    }

    #[test]
    fn settings_windows_map_to_their_parent() {
        assert_eq!(settings_label("project-2"), "settings-project-2");
        assert_eq!(settings_parent("settings-main"), Some("main"));
        assert_eq!(settings_parent("main"), None);
        assert!(is_settings_window("settings-project-1"));
        assert!(!is_settings_window("project-1"));
    }

    #[test]
    fn settings_window_is_centred_over_parent() {
        assert_eq!(centered(100.0, 50.0, 1440.0, 900.0, 980.0, 720.0), (330.0, 140.0));
        // Taller than the parent: aligned with its top edge.
        assert_eq!(centered(0.0, 50.0, 800.0, 500.0, 600.0, 720.0), (100.0, 50.0));
    }
}
