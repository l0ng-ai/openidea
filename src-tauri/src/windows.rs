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
    /// Settings windows: the page to show.
    pub settings_page: Option<String>,
    /// Settings windows: edit the global layer only ("Settings for New Projects").
    pub new_projects: bool,
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
        (project.root == root).then_some(w)
    })
}

fn has_project(app: &AppHandle, label: &str) -> bool {
    app.try_state::<AppState>().is_some_and(|s| s.project(label).is_ok())
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
    const LIGHT: Color = Color(0xe9, 0xea, 0xee, 0xff);
    const DARK: Color = Color(0x26, 0x28, 0x2c, 0xff);
    const DARK_HC: Color = Color(0x1a, 0x1b, 0x1e, 0xff);
    let sync = appearance.sync_with_os || appearance.theme == "system";
    let theme = match (sync, os_dark) {
        (false, _) => &appearance.theme,
        (true, true) => &appearance.preferred_dark_theme,
        (true, false) => &appearance.preferred_light_theme,
    };
    match theme.as_str() {
        "dark-hc" => DARK_HC,
        "dark" => DARK,
        "light" => LIGHT,
        _ if sync && os_dark => DARK,
        _ => LIGHT,
    }
}

/// Builds a project window painted in the saved theme's frame colour, so it
/// doesn't flash the light default before its page (and splash) loads.
fn build_project_window(app: &AppHandle, mut config: WindowConfig) -> IdeResult<WebviewWindow> {
    let appearance = app.try_state::<AppState>().map(|s| s.global_settings.effective().appearance);
    if let Some(a) = &appearance {
        config.background_color = Some(frame_color(a, false));
    }
    let window = WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| b.build())
        .map_err(|e| IdeError::internal(format!("cannot create window: {e}")))?;
    apply_zoom(app, &window);
    // "Sync with OS" needs the OS mode, known once the window exists.
    if let Some(a) = appearance.filter(|a| a.sync_with_os || a.theme == "system")
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
    let windows = app.webview_windows();
    let label = next_label(windows.keys().map(String::as_str));
    let mut config = window_config(app)?;
    config.label = label.clone();
    if let Some(name) = project.as_deref().and_then(Path::file_name) {
        config.title = name.to_string_lossy().into_owned();
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
    app.state::<WindowsState>().set_launch(&label, Launch { project: project.map(Into::into), ..Default::default() });
    let window = build_project_window(app, config)?;
    focus(&window);
    Ok(window)
}

/// `create_window` off the event-loop thread (building a window from a
/// main-thread callback can deadlock on Windows).
pub fn spawn_window(app: &AppHandle, project: Option<PathBuf>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = create_window(&app, project) {
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

pub fn open_project_window(app: &AppHandle, path: &Path, new_window: bool) -> IdeResult<OpenOutcome> {
    let root = dunce::canonicalize(path).map_err(|e| IdeError::not_found(format!("{}: {e}", path.display())))?;
    tracing::info!("open_project_window {} new_window={new_window}", root.display());
    if let Some(w) = find_project_window(app, &root) {
        focus(&w);
        return Ok(OpenOutcome::Focused { label: w.label().to_owned() });
    }
    if !new_window {
        return Ok(OpenOutcome::Current);
    }
    let window = create_window(app, Some(root))?;
    Ok(OpenOutcome::Opened { label: window.label().to_owned() })
}

/// Opens `path` from the command line / a second instance: focuses the window
/// that has it, else reuses a window without a project, else makes a new one.
pub fn open_path(app: &AppHandle, path: &Path) {
    let root = match dunce::canonicalize(path) {
        Ok(r) if r.is_dir() => r,
        Ok(r) => r.parent().map(Path::to_path_buf).unwrap_or(r),
        Err(e) => {
            tracing::warn!("cannot open {}: {e}", path.display());
            return;
        }
    };
    if let Some(w) = find_project_window(app, &root) {
        focus(&w);
        return;
    }
    let free = target_window(app)
        .filter(|w| !has_project(app, w.label()))
        .filter(|w| !is_settings_window(w.label()))
        .or_else(|| {
            app.webview_windows().into_values().find(|w| !is_settings_window(w.label()) && !has_project(app, w.label()))
        });
    match free {
        Some(w) => {
            app.state::<WindowsState>()
                .set_launch(w.label(), Launch { project: Some(root.into()), ..Default::default() });
            let _ = app.emit_to(w.label(), LAUNCH_EVENT, ());
            focus(&w);
        }
        None => spawn_window(app, Some(root)),
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
            windows.set_launch(&label, Launch { project: None, settings_page: page, new_projects });
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
    if let Some(color) = background.and_then(|c| serde_json::from_value(serde_json::Value::String(c)).ok()) {
        config.background_color = Some(color);
    }
    windows.set_launch(&label, Launch { project: None, settings_page: page, new_projects });
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
