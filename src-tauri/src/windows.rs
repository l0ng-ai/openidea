//! Project windows: one project per window, labelled `main` or `project-<n>`.
//!
//! A new window is built from the `main` window config (overlay title bar,
//! traffic lights, min size, background colour). What it should open is kept
//! here as a pending [`Launch`] that its frontend takes on startup
//! (`window_take_launch`), and re-taken whenever [`LAUNCH_EVENT`] fires (a
//! second app instance asking an already-loaded window to open a path).
//!
//! Auxiliary windows ([`AuxKind`]: Settings, Compare with Local, Sync with Deployed) belong to a project window and share its project (see
//! [`AppState::project`]). Their labels name the kind and the parent
//! (`settings-main`, `comparison-project-2-3`); their [`Launch`] says what to show.

use crate::remote_dev::RemoteTarget;
use crate::state::AppState;
use crate::theme_frame::builtin_frame;
use ide_core::settings::AppearanceSettings;
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::utils::config::{Color, WindowConfig};
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewWindow, WebviewWindowBuilder};

/// Tells a window that a pending launch is waiting for it.
pub const LAUNCH_EVENT: &str = "openidea://launch";
const MAIN: &str = "main";
const PREFIX: &str = "project-";
const CASCADE: f64 = 28.0;
const SETTINGS_SIZE: (f64, f64) = (980.0, 720.0);
const SETTINGS_MIN_SIZE: (f64, f64) = (640.0, 420.0);
const COMPARISON_SIZE: (f64, f64) = (1100.0, 720.0);
const COMPARISON_MIN_SIZE: (f64, f64) = (640.0, 360.0);
const DEPLOYMENT_SIZE: (f64, f64) = (1400.0, 900.0);
const DEPLOYMENT_MIN_SIZE: (f64, f64) = (800.0, 500.0);

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
    /// Where to place the caret in some of `files` (`openidea --line 12 --column 5 <file>`).
    #[serde(default)]
    pub positions: Vec<FilePosition>,
    /// Comparison windows: the revisions to compare (boxed: most launches have none).
    #[serde(default)]
    pub comparison: Option<Box<ComparisonLaunch>>,
    /// Deployment windows: the server and local selection to compare.
    #[serde(default)]
    pub deployment: Option<DeploymentLaunch>,
}

/// Local files to compare with a deployment server (Sync with Deployed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DeploymentLaunch {
    /// Deployment server id.
    pub server: String,
    pub paths: Vec<ide_core::IpcPath>,
}

/// A Git revision and how the comparison window names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ComparisonRevision {
    pub rev: String,
    pub label: String,
}

/// Limits a comparison to some paths (Compare with Branch on a selection).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ComparisonScope {
    pub paths: Vec<ide_core::IpcPath>,
    pub repositories: Option<Vec<ide_core::IpcPath>>,
}

/// Files that differ between `from` and `to` (the working tree when `None`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ComparisonLaunch {
    pub from: ComparisonRevision,
    pub to: Option<ComparisonRevision>,
    pub scope: Option<ComparisonScope>,
    pub repo: Option<ide_core::IpcPath>,
}

/// A caret position for a file opened from the command line: 0-based line and column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FilePosition {
    pub path: ide_core::IpcPath,
    pub line: u32,
    pub column: u32,
}

/// A project folder on an SSH host or in a WSL distribution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLaunch {
    pub target: RemoteTarget,
    pub path: String,
}

/// The remote launch for a folder of the `\\wsl.localhost\<distro>` share, if it is one.
pub fn wsl_launch(path: &Path) -> Option<RemoteLaunch> {
    let w = ide_core::wsl::parse(path)?;
    Some(RemoteLaunch { target: RemoteTarget::Wsl { distro: w.distro }, path: w.path })
}

#[derive(Default)]
pub struct WindowsState {
    pub groups: Mutex<ide_workspace::window_groups::WindowGroups>,
    pub groups_restored: AtomicBool,
    /// Serialises writes of the saved session. Holds the previous run's session once read: it is
    /// read before this run first overwrites the file, so restoring still sees it.
    pub groups_persist: tokio::sync::Mutex<Option<Vec<ide_workspace::window_groups::SavedWindows>>>,
    launches: Mutex<HashMap<String, Launch>>,
    /// Caret positions asked for on the command line, by canonical file path, until a window takes the file.
    positions: Mutex<HashMap<PathBuf, (u32, u32)>>,
    /// Most recently focused window label (menu events go there).
    last_focused: Mutex<Option<String>>,
    /// Set by Quit while windows close one by one.
    quitting: AtomicBool,
    /// Project tabs closing one by one (Close Other Tabs and friends).
    pub tab_closes: Mutex<Option<crate::window_groups::TabCloses>>,
    /// Relaunch once the quit completes (after installing an update).
    restart: AtomicBool,
    /// Numbers windows of kinds that can open several times per project window.
    aux_serial: AtomicU64,
}

impl WindowsState {
    pub fn set_launch(&self, label: &str, launch: Launch) {
        self.launches.lock().insert(label.to_owned(), launch);
    }

    pub fn take_launch(&self, label: &str) -> Option<Launch> {
        let mut launch = self.launches.lock().remove(label)?;
        let mut positions = self.positions.lock();
        for file in &launch.files {
            let path = dunce::canonicalize(&file.0).unwrap_or_else(|_| file.0.clone());
            if let Some((line, column)) = positions.remove(&path) {
                launch.positions.push(FilePosition { path: file.clone(), line, column });
            }
        }
        Some(launch)
    }

    /// The caret goes to `position` (0-based line, column) when a window opens `file`.
    pub fn set_position(&self, file: &Path, position: (u32, u32)) {
        let path = dunce::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
        self.positions.lock().insert(path, position);
    }

    /// Adds `files` to `label`'s pending launch, so files sent before its frontend took the last batch aren't lost.
    pub fn add_files(&self, label: &str, files: Vec<PathBuf>) {
        let mut launches = self.launches.lock();
        let launch = launches.entry(label.to_owned()).or_default();
        launch.files.extend(files.into_iter().map(Into::into));
    }

    pub(crate) fn pending(&self, label: &str) -> Option<Launch> {
        self.launches.lock().get(label).cloned()
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
        if on {
            *self.tab_closes.lock() = None;
        } else {
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

/// A window that belongs to a project window (its parent) and shares its project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuxKind {
    Settings,
    Comparison,
    Deployment,
}

impl AuxKind {
    const ALL: [AuxKind; 3] = [AuxKind::Settings, AuxKind::Comparison, AuxKind::Deployment];

    /// Label prefix, and the key of the one remembered geometry shared by every window of the kind.
    pub fn name(self) -> &'static str {
        match self {
            AuxKind::Settings => "settings",
            AuxKind::Comparison => "comparison",
            AuxKind::Deployment => "deployment",
        }
    }

    /// Several per project window (`<kind>-<parent>-<n>`), else one (`<kind>-<parent>`).
    fn multiple(self) -> bool {
        self == AuxKind::Comparison
    }

    /// Shows the project's documents: gets its parent's events and edits made in sibling windows,
    /// and asks about its own unsaved changes before the parent closes it.
    pub fn shares_documents(self) -> bool {
        self != AuxKind::Settings
    }

    /// Modal for its parent: menu items other than app-level ones are dropped.
    pub fn modal(self) -> bool {
        self == AuxKind::Settings
    }

    /// Needs its parent to have a project open.
    fn needs_project(self) -> bool {
        self != AuxKind::Settings
    }
}

/// The kind and parent of an auxiliary window (`comparison-project-2-3` → `Comparison`, `project-2`).
pub fn auxiliary(label: &str) -> Option<(AuxKind, &str)> {
    AuxKind::ALL.into_iter().find_map(|kind| {
        let rest = label.strip_prefix(kind.name())?.strip_prefix('-')?;
        let parent = if kind.multiple() {
            let (parent, n) = rest.rsplit_once('-')?;
            n.parse::<u64>().ok()?;
            parent
        } else {
            rest
        };
        (!parent.is_empty()).then_some((kind, parent))
    })
}

/// The project window an auxiliary window belongs to (`settings-main` → `main`).
pub fn auxiliary_parent(label: &str) -> Option<&str> {
    auxiliary(label).map(|(_, parent)| parent)
}

pub fn settings_label(parent: &str) -> String {
    format!("{}-{parent}", AuxKind::Settings.name())
}

/// The window state key: one geometry per auxiliary kind, else the label itself.
pub fn state_key(label: &str) -> &str {
    auxiliary(label).map_or(label, |(kind, _)| kind.name())
}

/// Project windows being created to take a group's frame rather than the state remembered for
/// their label: one joining a fullscreen window's Space, or a group member reopened at startup.
/// The label's last window may have closed in fullscreen, which would open a Space of its own.
#[cfg(not(target_os = "linux"))]
static UNTRACKED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Whether window-state restores and remembers the window with this state key.
#[cfg(not(target_os = "linux"))]
pub fn tracks_state(key: &str) -> bool {
    !UNTRACKED.lock().iter().any(|label| label == key)
}

/// Whether a project window is new or reopened at startup, on its own or as a group member.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Opening {
    New,
    Restored,
    RestoredInGroup,
}

/// `parent`'s auxiliary windows that show its project's documents.
pub fn document_windows(app: &AppHandle, parent: &str) -> Vec<String> {
    app.webview_windows()
        .into_keys()
        .filter(|label| auxiliary(label).is_some_and(|(kind, p)| kind.shares_documents() && p == parent))
        .collect()
}

/// Closes `parent`'s auxiliary windows: they show (and would apply to) the project it is leaving.
/// Windows with documents are destroyed: the parent's leave guard has already settled their
/// unsaved changes (`closeAuxiliaryWindows` in the UI).
pub fn close_auxiliary_windows(app: &AppHandle, parent: &str) {
    for (label, window) in app.webview_windows() {
        match auxiliary(&label) {
            Some((kind, p)) if p == parent && kind.shares_documents() => drop(window.destroy()),
            Some((_, p)) if p == parent => drop(window.close()),
            _ => {}
        }
    }
}

/// Project windows, excluding auxiliary windows, for counting and cycling.
pub fn project_window_labels(app: &AppHandle) -> Vec<String> {
    sorted_labels(app.webview_windows().keys().map(String::as_str).filter(|l| auxiliary_parent(l).is_none()))
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

/// Flags followed by a value (`--line 12`).
const VALUE_FLAGS: [&str; 2] = ["--line", "--column"];

/// The project path from command-line arguments (`openidea /path/to/project`):
/// the first argument after the binary that is not a flag or a flag's value, resolved against `cwd`.
pub fn cli_path(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let mut rest = args.iter().skip(1);
    while let Some(a) = rest.next() {
        if VALUE_FLAGS.contains(&a.as_str()) {
            rest.next();
            continue;
        }
        if a.starts_with('-') || a.is_empty() || a.starts_with("psn_") {
            continue;
        }
        let p = PathBuf::from(a);
        return Some(if p.is_absolute() { p } else { cwd.join(p) });
    }
    None
}

/// `--line <n>` and `--column <n>` (1-based, also as `--line=<n>`) as a 0-based position;
/// without `--line` there is none, without `--column` it is the line's start.
pub fn cli_position(args: &[String]) -> Option<(u32, u32)> {
    let value = |flag: &str| {
        let prefix = format!("{flag}=");
        args.iter().enumerate().skip(1).find_map(|(i, a)| match a.strip_prefix(&prefix) {
            Some(v) => Some(v.to_owned()),
            None if a == flag => args.get(i + 1).cloned(),
            None => None,
        })
    };
    let number = |flag: &str| value(flag).and_then(|v| v.trim().parse::<u32>().ok());
    let line = number("--line")?;
    Some((line.saturating_sub(1), number("--column").unwrap_or(1).saturating_sub(1)))
}

/// Remembers the command line's `--line` / `--column` for `path` (a file) before it is opened.
pub fn remember_cli_position(windows: &WindowsState, args: &[String], path: &Path) {
    if let Some(position) = cli_position(args)
        && !path.is_dir()
    {
        windows.set_position(path, position);
    }
}

pub fn focus(window: &WebviewWindow) {
    if crate::window_groups::select(window.app_handle(), window.label(), window.label()).is_ok() {
        return;
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Present one project's save prompt at a time, including hidden group members.
pub fn continue_quit(app: &AppHandle, closed: Option<&str>) {
    if !app.state::<WindowsState>().quitting() {
        return;
    }
    let next = project_window_labels(app)
        .into_iter()
        .filter(|label| Some(label.as_str()) != closed)
        .find_map(|label| app.get_webview_window(&label));
    if let Some(window) = next {
        focus(&window);
        if window.close().is_err() {
            app.state::<WindowsState>().set_quitting(false);
        }
    } else {
        app.exit(0);
    }
}

/// The window whose open project is `root` (already canonical).
pub fn find_project_window(app: &AppHandle, root: &Path) -> Option<WebviewWindow> {
    let state = app.try_state::<AppState>()?;
    app.webview_windows().into_iter().filter(|(label, _)| auxiliary_parent(label).is_none()).find_map(|(label, w)| {
        let project = state.project(&label).ok()?;
        (project.root == root && !project.light).then_some(w)
    })
}

/// Hands `files` to the already loaded `window` (its frontend takes them on [`LAUNCH_EVENT`]) and focuses it.
fn send_files(app: &AppHandle, window: &WebviewWindow, files: Vec<PathBuf>) {
    app.state::<WindowsState>().add_files(window.label(), files);
    let _ = app.emit_to(window.label(), LAUNCH_EVENT, ());
    focus(window);
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
    let visible = cfg!(target_os = "macos") && config.visible;
    let focused = config.focus;
    if visible {
        config.visible = false;
    }
    let state = app.try_state::<AppState>();
    let appearance = state.as_ref().map(|s| s.global_settings.effective().appearance);
    // A plugin theme replaces the built-in one in either OS mode; the UI records its resolved frame.
    let plugin_frame = state.as_ref().and_then(|s| s.plugins.startup_frame()).and_then(|c| hex_color(&c));
    if let Some(color) = plugin_frame {
        config.background_color = Some(color);
    } else if let Some(a) = &appearance {
        config.background_color = Some(frame_color(a, false));
    }
    #[cfg(target_os = "linux")]
    let show_after_build = crate::linux_window_state::prepare(app, &mut config);
    let window = WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| dev_font_preferences(b).build())
        .map_err(|e| IdeError::internal(format!("cannot create window: {e}")))?;
    #[cfg(target_os = "linux")]
    decorate_csd(&window);
    apply_zoom(app, &window);
    #[cfg(target_os = "macos")]
    align_titlebar(app, &window);
    // "Sync with OS" needs the OS mode, known once the window exists.
    if let Some(a) = appearance.filter(|a| plugin_frame.is_none() && (a.sync_with_os || a.theme == "system"))
        && window.theme().is_ok_and(|t| t == Theme::Dark)
    {
        let _ = window.set_background_color(Some(frame_color(&a, true)));
    }
    #[cfg(target_os = "linux")]
    if show_after_build {
        window.show().map_err(|e| IdeError::internal(format!("cannot show window: {e}")))?;
    }
    if visible {
        window.show().map_err(|e| IdeError::internal(format!("cannot show window: {e}")))?;
        if focused {
            let _ = window.set_focus();
        }
    }
    Ok(window)
}

/// Wayland: tao already makes frameless windows client-side decorated (an empty GTK title bar, so
/// the compositor adds no frame), but undecorated GTK windows get no shadow or resize margin.
/// Decorating keeps that empty title bar, so GTK adds the theme's shadow and resize edges and
/// nothing else. X11 has no such title bar: decorating there would bring back the WM frame.
#[cfg(target_os = "linux")]
fn decorate_csd(window: &WebviewWindow) {
    if crate::linux_window_state::is_wayland() {
        let _ = window.set_decorations(true);
    }
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

/// Aligns the native window buttons before the page reports its title bar height,
/// so they don't visibly move once it loads.
#[cfg(target_os = "macos")]
fn align_titlebar(app: &AppHandle, window: &WebviewWindow) {
    // `--h-titlebar` in tokens.css.
    const HEIGHT: f64 = 40.0;
    const COMPACT_HEIGHT: f64 = 32.0;
    let Some(a) = app.try_state::<AppState>().map(|s| s.global_settings.effective().appearance) else {
        return;
    };
    let height = if a.compact_mode { COMPACT_HEIGHT } else { HEIGHT };
    let _ = crate::titlebar::set_height(window, height * f64::from(a.zoom.clamp(50, 300)) / 100.0);
}

/// The first window (`create: false` in tauri.conf.json so it can take the theme's colour).
pub fn create_main_window(app: &AppHandle) -> IdeResult<WebviewWindow> {
    build_project_window(app, window_config(app)?)
}

/// Creates a new project window; `project` is opened by its frontend on load.
pub fn create_window(app: &AppHandle, project: Option<PathBuf>) -> IdeResult<WebviewWindow> {
    create_window_with(app, project, Vec::new(), Opening::New)
}

/// [`create_window`] that also opens `files` (without `project`: in LightEdit).
fn create_window_with(
    app: &AppHandle,
    project: Option<PathBuf>,
    files: Vec<PathBuf>,
    opening: Opening,
) -> IdeResult<WebviewWindow> {
    let title = project.as_deref().or(files.first().map(PathBuf::as_path)).and_then(Path::file_name);
    let title = title.map(|n| n.to_string_lossy().into_owned());
    let files = files.into_iter().map(Into::into).collect();
    create_window_for(app, title, Launch { project: project.map(Into::into), files, ..Default::default() }, opening)
}

/// Restoring a saved group preserves its membership and selected tab.
pub fn create_restored_window(app: &AppHandle, project: PathBuf, in_group: bool) -> IdeResult<WebviewWindow> {
    let opening = if in_group { Opening::RestoredInGroup } else { Opening::Restored };
    create_window_with(app, Some(project), Vec::new(), opening)
}

fn create_window_for(
    app: &AppHandle,
    title: Option<String>,
    launch: Launch,
    _opening: Opening,
) -> IdeResult<WebviewWindow> {
    #[cfg(target_os = "macos")]
    let tab_target = if _opening == Opening::New { crate::macos::new_project_tab_target(app, &launch)? } else { None };
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
    // Shown now, a project joining a fullscreen window would open on the desktop; joining
    // shows it in that window's Space.
    #[cfg(target_os = "macos")]
    let joining_fullscreen = tab_target.as_ref().is_some_and(|target| {
        target.is_fullscreen().unwrap_or(false) || crate::window_groups::in_fullscreen(app, target.label())
    });
    #[cfg(target_os = "macos")]
    if joining_fullscreen {
        config.visible = false;
    }
    #[cfg(target_os = "macos")]
    let untracked = joining_fullscreen || _opening == Opening::RestoredInGroup;
    #[cfg(target_os = "macos")]
    if untracked {
        UNTRACKED.lock().push(label.clone());
    }
    let window = build_project_window(app, config);
    #[cfg(target_os = "macos")]
    if untracked {
        UNTRACKED.lock().retain(|l| l != &label);
    }
    let window = window?;
    #[cfg(target_os = "macos")]
    crate::macos::intercept_toggle_fullscreen(&window);
    #[cfg(target_os = "macos")]
    if let Some(target) = tab_target {
        crate::window_groups::join(app, target.label(), window.label())?;
        return Ok(window);
    }
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
        if let Err(e) = create_window_with(&app, project, files, Opening::New) {
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
    // Before touching the share: a stat on `\\wsl.localhost` is what makes it slow.
    if let Some(remote) = wsl_launch(path) {
        return open_remote_window(app, &remote.target, &remote.path, new_window);
    }
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
    let window = create_window_with(app, Some(root), files, Opening::New)?;
    Ok(OpenOutcome::Opened { label: window.label().to_owned() })
}

/// Opens `file` in a forced new window: `project` (None: LightEdit) plus the
/// single file, always creating a window even when the project is already open
/// in another one (unlike [`open_project_window`], which focuses it). Used to
/// detach an editor tab out of its window.
pub fn open_file_in_new_window(app: &AppHandle, project: Option<PathBuf>, file: PathBuf) -> IdeResult<OpenOutcome> {
    tracing::info!("open_file_in_new_window {} project={:?}", file.display(), project);
    let window = create_window_with(app, project, vec![file], Opening::New)?;
    Ok(OpenOutcome::Opened { label: window.label().to_owned() })
}

/// Loose local `files` asked for by window `caller` (File | Open File, a drop on the Welcome
/// screen), routed like [`open_paths`]; returns the files `caller` opens itself.
pub fn open_files_window(app: &AppHandle, caller: &str, files: Vec<PathBuf>) -> Vec<ide_core::IpcPath> {
    let files = files.into_iter().map(|f| dunce::canonicalize(&f).unwrap_or(f)).collect();
    let (steps, here) = plan_open_files(caller, files, &window_holds(app, Some(caller)));
    run_open(app, steps);
    here.into_iter().map(Into::into).collect()
}

/// [`open_project_window`] for folder `path` of `target` (Remote Development).
pub fn open_remote_window(
    app: &AppHandle,
    target: &RemoteTarget,
    path: &str,
    new_window: bool,
) -> IdeResult<OpenOutcome> {
    tracing::info!("open_remote_window {target:?}:{path} new_window={new_window}");
    let windows = app.webview_windows();
    let open = app.try_state::<AppState>().and_then(|s| s.remote_dev.window_of(target, path));
    if let Some(w) = open.and_then(|label| windows.get(&label)) {
        focus(w);
        return Ok(OpenOutcome::Focused { label: w.label().to_owned() });
    }
    if !new_window {
        return Ok(OpenOutcome::Current);
    }
    let title = path.trim_end_matches('/').rsplit('/').next().filter(|n| !n.is_empty() && *n != "~").map(str::to_owned);
    let remote = RemoteLaunch { target: target.clone(), path: path.to_owned() };
    let window = create_window_for(app, title, Launch { remote: Some(remote), ..Default::default() }, Opening::New)?;
    Ok(OpenOutcome::Opened { label: window.label().to_owned() })
}

/// What a window holds, for routing paths opened from outside (command line, Finder).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Holds {
    /// Nothing yet (Welcome screen): free to take a launch.
    Nothing,
    LightEdit,
    Project(PathBuf),
    /// A project inside a WSL distribution (`path` is the Linux path).
    Wsl {
        distro: String,
        path: String,
    },
    /// An SSH remote project.
    Other,
}

impl Holds {
    fn of_remote(remote: &RemoteLaunch) -> Self {
        match &remote.target {
            RemoteTarget::Wsl { distro } => Holds::Wsl { distro: distro.clone(), path: remote.path.clone() },
            RemoteTarget::Ssh { .. } => Holds::Other,
        }
    }

    fn is_wsl_folder(&self, remote: &RemoteLaunch) -> bool {
        match (self, &remote.target) {
            (Holds::Wsl { distro, path }, RemoteTarget::Wsl { distro: d }) => {
                distro.eq_ignore_ascii_case(d) && path.trim_end_matches('/') == remote.path.trim_end_matches('/')
            }
            _ => false,
        }
    }
}

/// What window `label` holds: its open project, else what its pending launch is about to open.
fn holds(app: &AppHandle, label: &str) -> Holds {
    let state = app.try_state::<AppState>();
    if let Some(project) = state.as_ref().and_then(|s| s.project(label).ok()) {
        return if project.light { Holds::LightEdit } else { Holds::Project(project.root.clone()) };
    }
    if let Some(c) = state.as_ref().and_then(|s| s.remote_dev.get(label)) {
        return Holds::of_remote(&RemoteLaunch { target: c.target.clone(), path: c.root.clone() });
    }
    pending_holds(app.state::<WindowsState>().pending(label).as_ref())
}

fn pending_holds(launch: Option<&Launch>) -> Holds {
    match launch {
        Some(Launch { project: Some(root), .. }) => Holds::Project(root.to_path_buf()),
        Some(Launch { remote: Some(remote), .. }) => Holds::of_remote(remote),
        Some(l) if !l.files.is_empty() => Holds::LightEdit,
        _ => Holds::Nothing,
    }
}

/// One step of opening paths from outside; see [`plan_open`].
#[derive(Debug, PartialEq, Eq)]
pub enum OpenStep {
    /// The window already has the folder open.
    Focus(String),
    /// Files open in this window: in its project, or join its LightEdit session.
    Files(String, Vec<PathBuf>),
    /// A free window opens this.
    Launch(String, Launch),
    /// A new window opens the project folder or (without one) the files in LightEdit.
    New(Option<PathBuf>, Vec<PathBuf>),
    /// A new window connects to a WSL distribution.
    NewRemote(RemoteLaunch),
}

/// Where a file inside a project goes: a window with it open, or the step opening it.
enum ProjectTarget {
    Window(String),
    Step(usize),
}

/// Routes canonical `paths` (with whether each is a folder) over `windows` (the preferred
/// free one first). A folder focuses the window that has it open, else takes a free window,
/// else a new one. A file inside a local project being opened (the deepest root if nested)
/// opens in that project's window; the others all join the LightEdit window, else a free
/// window or a new one switches to LightEdit for them.
pub fn plan_open(paths: Vec<(PathBuf, bool)>, windows: &[(String, Holds)]) -> Vec<OpenStep> {
    let mut free = windows.iter().filter(|(_, h)| *h == Holds::Nothing).map(|(l, _)| l.clone());
    let (mut dirs, mut files) = (Vec::new(), Vec::new());
    for (path, is_dir) in paths {
        let list = if is_dir { &mut dirs } else { &mut files };
        if !list.contains(&path) {
            list.push(path);
        }
    }
    let mut steps = Vec::new();
    let mut roots: Vec<(PathBuf, ProjectTarget)> = windows
        .iter()
        .filter_map(|(label, h)| match h {
            Holds::Project(root) => Some((root.clone(), ProjectTarget::Window(label.clone()))),
            _ => None,
        })
        .collect();
    for dir in dirs {
        // A folder of a WSL distro opens as a WSL project, not as a network folder.
        if let Some(remote) = wsl_launch(&dir) {
            steps.push(match windows.iter().find(|(_, h)| h.is_wsl_folder(&remote)) {
                Some((label, _)) => OpenStep::Focus(label.clone()),
                None => match free.next() {
                    Some(label) => OpenStep::Launch(label, Launch { remote: Some(remote), ..Default::default() }),
                    None => OpenStep::NewRemote(remote),
                },
            });
            continue;
        }
        if let Some((label, _)) = windows.iter().find(|(_, h)| matches!(h, Holds::Project(root) if *root == dir)) {
            steps.push(OpenStep::Focus(label.clone()));
            continue;
        }
        roots.push((dir.clone(), ProjectTarget::Step(steps.len())));
        steps.push(match free.next() {
            Some(label) => OpenStep::Launch(label, path_launch_of(Some(dir), Vec::new())),
            None => OpenStep::New(Some(dir), Vec::new()),
        });
    }
    let mut in_windows: Vec<(String, Vec<PathBuf>)> = Vec::new();
    let mut loose = Vec::new();
    for file in files {
        let deepest =
            roots.iter().filter(|(root, _)| file.starts_with(root)).max_by_key(|(root, _)| root.components().count());
        match deepest.map(|(_, target)| target) {
            Some(ProjectTarget::Window(label)) => match in_windows.iter_mut().find(|(l, _)| l == label) {
                Some((_, list)) => list.push(file),
                None => in_windows.push((label.clone(), vec![file])),
            },
            Some(ProjectTarget::Step(i)) => match &mut steps[*i] {
                OpenStep::Launch(_, launch) => launch.files.push(file.into()),
                OpenStep::New(_, list) => list.push(file),
                OpenStep::Focus(_) | OpenStep::Files(..) | OpenStep::NewRemote(_) => {
                    unreachable!("folders opened by the plan launch or open")
                }
            },
            None => loose.push(file),
        }
    }
    steps.extend(in_windows.into_iter().map(|(label, files)| OpenStep::Files(label, files)));
    if !loose.is_empty() {
        let light = windows.iter().find(|(_, h)| *h == Holds::LightEdit).map(|(l, _)| l.clone());
        steps.push(match (light, free.next()) {
            (Some(label), _) => OpenStep::Files(label, loose),
            (None, Some(label)) => OpenStep::Launch(label, path_launch_of(None, loose)),
            (None, None) => OpenStep::New(None, loose),
        });
    }
    steps
}

fn path_launch_of(project: Option<PathBuf>, files: Vec<PathBuf>) -> Launch {
    Launch {
        project: project.map(Into::into),
        files: files.into_iter().map(Into::into).collect(),
        ..Default::default()
    }
}

/// [`plan_open`] for loose `files` asked for by window `caller` (listed first in `windows`):
/// no other free window takes them. Returns the steps for other windows and the files
/// `caller` opens itself (in its LightEdit session, or turning into one).
pub fn plan_open_files(
    caller: &str,
    files: Vec<PathBuf>,
    windows: &[(String, Holds)],
) -> (Vec<OpenStep>, Vec<PathBuf>) {
    let windows: Vec<_> = windows.iter().filter(|(l, h)| l == caller || *h != Holds::Nothing).cloned().collect();
    let mut here = Vec::new();
    let mut steps = Vec::new();
    for step in plan_open(files.into_iter().map(|f| (f, false)).collect(), &windows) {
        match step {
            OpenStep::Files(label, files) if label == caller => here.extend(files),
            OpenStep::Launch(label, launch) if label == caller => here.extend(launch.files.into_iter().map(|f| f.0)),
            step => steps.push(step),
        }
    }
    (steps, here)
}

/// Canonical existing `paths` with whether each is a folder; the others are logged and dropped.
fn resolve(paths: Vec<PathBuf>) -> Vec<(PathBuf, bool)> {
    paths
        .into_iter()
        .filter_map(|path| match dunce::canonicalize(&path) {
            Ok(p) => {
                let is_dir = p.is_dir();
                Some((p, is_dir))
            }
            Err(e) => {
                tracing::warn!("cannot open {}: {e}", path.display());
                None
            }
        })
        .collect()
}

/// Opens `path` from the command line / a second instance; see [`open_paths`].
pub fn open_path(app: &AppHandle, path: &Path) {
    open_paths(app, vec![path.to_path_buf()]);
}

/// Opens paths from outside the app (a second instance, Finder's Open With, the Dock):
/// see [`plan_open`]; the focused window is the preferred free one.
pub fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    let (existing, missing): (Vec<_>, Vec<_>) = paths.into_iter().partition(|path| path.exists());
    if !missing.is_empty() {
        let paths = missing.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join("\n");
        app.state::<AppState>().sink.emit(ide_core::IdeEvent::Notify {
            level: ide_core::event::NotifyLevel::Warning,
            title: "Cannot open path".into(),
            body: Some(format!("The path does not exist:\n{paths}")),
        });
    }
    let preferred = target_window(app).map(|w| w.label().to_owned());
    run_open(app, plan_open(resolve(existing), &window_holds(app, preferred.as_deref())));
}

/// What each window holds, `preferred` first.
fn window_holds(app: &AppHandle, preferred: Option<&str>) -> Vec<(String, Holds)> {
    let mut labels = project_window_labels(app);
    if let Some(i) = preferred.and_then(|p| labels.iter().position(|l| l == p)) {
        let first = labels.remove(i);
        labels.insert(0, first);
    }
    labels.into_iter().map(|l| (l.clone(), holds(app, &l))).collect()
}

/// [`open_paths`] while the app is starting, before the `main` window exists: it takes them as its launch.
pub fn open_paths_at_launch(app: &AppHandle, paths: Vec<PathBuf>) {
    let main = pending_holds(app.state::<WindowsState>().pending(MAIN).as_ref());
    run_open(app, plan_open(resolve(paths), &[(MAIN.to_owned(), main)]));
}

fn run_open(app: &AppHandle, steps: Vec<OpenStep>) {
    let windows = app.state::<WindowsState>();
    for step in steps {
        match step {
            OpenStep::Focus(label) => {
                if let Some(w) = app.get_webview_window(&label) {
                    focus(&w);
                }
            }
            OpenStep::Files(label, files) => match app.get_webview_window(&label) {
                Some(w) => send_files(app, &w, files),
                None => windows.add_files(&label, files),
            },
            OpenStep::Launch(label, launch) => {
                windows.set_launch(&label, launch);
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = app.emit_to(&label, LAUNCH_EVENT, ());
                    focus(&w);
                }
            }
            OpenStep::New(project, files) => spawn_window_with(app, project, files),
            OpenStep::NewRemote(remote) => {
                let app = app.clone();
                // Off the event-loop thread, like `spawn_window`.
                tauri::async_runtime::spawn(async move {
                    let title = remote.path.trim_end_matches('/').rsplit('/').next().map(str::to_owned);
                    let launch = Launch { remote: Some(remote), ..Default::default() };
                    if let Err(e) = create_window_for(&app, title, launch, Opening::New) {
                        tracing::warn!("cannot open window: {}", e.message);
                    }
                });
            }
        }
    }
}

/// Local files and folders of the URLs macOS asks the app to open (Finder's Open With, the Dock).
#[cfg(target_os = "macos")]
pub fn opened_paths(urls: &[tauri::Url]) -> Vec<PathBuf> {
    urls.iter().filter_map(|u| u.to_file_path().ok()).collect()
}

/// What a window opens for a command-line path: a folder as its project, a file in LightEdit.
pub fn path_launch(path: PathBuf) -> Launch {
    let is_dir = path.is_dir();
    launch_for(path, is_dir)
}

/// [`path_launch`] once the path is known to be a folder or not: only a WSL *folder* is a
/// remote project, a file of the share stays a LightEdit file.
fn launch_for(path: PathBuf, is_dir: bool) -> Launch {
    if !is_dir {
        Launch { files: vec![path.into()], ..Default::default() }
    } else if let Some(remote) = wsl_launch(&path) {
        Launch { remote: Some(remote), ..Default::default() }
    } else {
        Launch { project: Some(path.into()), ..Default::default() }
    }
}

/// Second instance launched: focus this one and open its path argument.
pub fn on_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    if args.iter().any(|arg| arg == crate::jump_list::OPEN_RECENT_ARG)
        && let Some(path) = cli_path(&args, Path::new(&cwd)).filter(|path| path.exists())
    {
        let target = target_window(app)
            .filter(|window| auxiliary_parent(window.label()).is_none())
            .or_else(|| project_window_labels(app).into_iter().find_map(|label| app.get_webview_window(&label)));
        if let Some(window) = target {
            let _ = app.emit_to(
                window.label(),
                crate::menu::MENU_EVENT,
                crate::menu::MenuRoute {
                    action: crate::menu::OPEN_RECENT_ACTION.into(),
                    arg: Some(ide_core::ipc_path::to_ipc(&path)),
                },
            );
            focus(&window);
            return;
        }
    }
    match cli_path(&args, Path::new(&cwd)) {
        Some(path) => {
            remember_cli_position(&app.state::<WindowsState>(), &args, &path);
            open_path(app, &path)
        }
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

/// An auxiliary window to open over its parent.
pub struct AuxWindow {
    pub kind: AuxKind,
    pub title: &'static str,
    pub size: (f64, f64),
    pub min_size: (f64, f64),
    pub launch: Launch,
    /// `#rrggbb` painted until the page has loaded (the theme's frame colour).
    pub background: Option<String>,
}

/// Opens an auxiliary window of `caller`'s project window, centred over it. A kind with one window
/// per parent reuses it: the new launch is handed over ([`LAUNCH_EVENT`]) and the window focused.
pub fn open_auxiliary_window(app: &AppHandle, caller: &WebviewWindow, aux: AuxWindow) -> IdeResult<()> {
    // Asked from an auxiliary window itself: open it for that window's parent.
    let parent_label = auxiliary_parent(caller.label()).unwrap_or(caller.label()).to_owned();
    if aux.kind.needs_project() {
        let state = app.state::<AppState>();
        if state.project(&parent_label).is_err() && state.remote_dev.get(&parent_label).is_none() {
            return Err(IdeError::not_found("no project is open"));
        }
    }
    let windows = app.state::<WindowsState>();
    let label = if aux.kind.multiple() {
        format!("{}-{parent_label}-{}", aux.kind.name(), windows.aux_serial.fetch_add(1, Ordering::Relaxed))
    } else {
        format!("{}-{parent_label}", aux.kind.name())
    };
    if let Some(existing) = app.get_webview_window(&label) {
        if aux.launch != Launch::default() {
            windows.set_launch(&label, aux.launch);
            let _ = app.emit_to(label.as_str(), LAUNCH_EVENT, ());
        }
        focus(&existing);
        return Ok(());
    }
    let parent = app.get_webview_window(&parent_label).ok_or_else(|| IdeError::not_found("no parent window"))?;
    let mut config = window_config(app)?;
    config.label = label.clone();
    config.title = aux.title.into();
    // Frameless on Windows and Linux like project windows (tauri.<os>.conf.json): the page draws
    // the title bar in the app theme instead of a system caption that follows the OS theme.
    (config.width, config.height) = aux.size;
    (config.min_width, config.min_height) = (Some(aux.min_size.0), Some(aux.min_size.1));
    config.center = false;
    config.visible = false;
    config.maximized = false;
    config.fullscreen = false;
    config.drag_drop_enabled = false;
    // Paint the theme's frame colour before the page loads.
    if let Some(color) = aux.background.as_deref().and_then(hex_color) {
        config.background_color = Some(color);
    }
    windows.set_launch(&label, aux.launch);
    #[cfg(target_os = "linux")]
    crate::linux_window_state::prepare(app, &mut config);
    let builder = WebviewWindowBuilder::from_config(app, &config);
    // Windows: an owned child (WS_POPUP) of a borderless parent gets no DWM
    // shadow, leaving the frameless window flat against its parent.
    // Ownership is tracked by the `<kind>-<parent>` label instead
    // (parent-close cleanup, menu modality), so only Linux keeps the native
    // parent link. AppKit child windows can disappear when dragged to another
    // display's Space, so macOS keeps it too.
    #[cfg(target_os = "linux")]
    let builder = builder.and_then(|b| b.parent(&parent));
    let window = builder.and_then(|b| dev_font_preferences(b).build()).map_err(|e| {
        windows.forget(&label);
        IdeError::internal(format!("cannot create {} window: {e}", aux.kind.name()))
    })?;
    #[cfg(target_os = "linux")]
    decorate_csd(&window);
    apply_zoom(app, &window);
    #[cfg(target_os = "macos")]
    align_titlebar(app, &window);
    // Restore runs during build; fit its size to the parent's current display before showing.
    #[cfg(target_os = "macos")]
    if let Err(e) = fit_over_parent(&window, &parent, aux.min_size) {
        tracing::warn!("cannot fit {} window: {e}", aux.kind.name());
    }
    #[cfg(not(target_os = "macos"))]
    if let Err(e) = place_over_parent(&window, &parent) {
        tracing::warn!("cannot place {} window: {e}", aux.kind.name());
    }
    focus(&window);
    Ok(())
}

/// Opens (or focuses) the settings window of `parent` showing `page`: a
/// separate window centred over its parent, sized like IDEA's Settings.
pub fn open_settings_window(
    app: &AppHandle,
    parent: &WebviewWindow,
    page: Option<String>,
    new_projects: bool,
    background: Option<String>,
) -> IdeResult<()> {
    open_auxiliary_window(
        app,
        parent,
        AuxWindow {
            kind: AuxKind::Settings,
            title: "Settings",
            size: SETTINGS_SIZE,
            min_size: SETTINGS_MIN_SIZE,
            launch: Launch { settings_page: page, new_projects, ..Default::default() },
            background,
        },
    )
}

/// Opens a window listing the files that differ between two revisions (Compare with Local and
/// friends), next to its project window like IDEA's diff windows.
pub fn open_comparison_window(
    app: &AppHandle,
    parent: &WebviewWindow,
    comparison: ComparisonLaunch,
    background: Option<String>,
) -> IdeResult<()> {
    open_auxiliary_window(
        app,
        parent,
        AuxWindow {
            kind: AuxKind::Comparison,
            title: "Compare",
            size: COMPARISON_SIZE,
            min_size: COMPARISON_MIN_SIZE,
            launch: Launch { comparison: Some(Box::new(comparison)), ..Default::default() },
            background,
        },
    )
}

/// Opens (or focuses and hands over to) the project window's Sync with Deployed window: local
/// files next to their copies on a deployment server, like IDEA's.
pub fn open_deployment_window(
    app: &AppHandle,
    parent: &WebviewWindow,
    server: String,
    paths: Vec<PathBuf>,
    background: Option<String>,
) -> IdeResult<()> {
    let paths = paths.into_iter().map(Into::into).collect();
    open_auxiliary_window(
        app,
        parent,
        AuxWindow {
            kind: AuxKind::Deployment,
            title: "Sync with Deployed",
            size: DEPLOYMENT_SIZE,
            min_size: DEPLOYMENT_MIN_SIZE,
            launch: Launch { deployment: Some(DeploymentLaunch { server, paths }), ..Default::default() },
            background,
        },
    )
}

/// Fit outer bounds, including native decorations, using one monitor's logical coordinate space.
#[cfg(target_os = "macos")]
fn fit_over_parent(window: &WebviewWindow, parent: &WebviewWindow, min_size: (f64, f64)) -> tauri::Result<()> {
    let Some(monitor) = parent.current_monitor()?.or(parent.primary_monitor()?) else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = area.position.to_logical::<f64>(scale);
    let available = area.size.to_logical::<f64>(scale);
    // Move to the target display first so native frame metrics use its scale factor.
    window.set_position(area.position)?;
    let inner = window.inner_size()?.to_logical::<f64>(scale);
    let outer = window.outer_size()?.to_logical::<f64>(scale);
    let frame = (outer.width - inner.width, outer.height - inner.height);
    let pos = parent.outer_position()?.to_logical::<f64>(scale);
    let size = parent.outer_size()?.to_logical::<f64>(scale);
    let bounds = fit_bounds(
        (pos.x, pos.y, size.width, size.height),
        (outer.width, outer.height),
        (origin.x, origin.y, available.width, available.height),
    );
    // A small work area takes precedence over the usual minimum window size.
    window.set_min_size(Some(
        tauri::LogicalSize::new(
            min_size.0.min((available.width - frame.0).max(1.0)),
            min_size.1.min((available.height - frame.1).max(1.0)),
        )
        .to_physical::<u32>(scale),
    ))?;
    window.set_size(
        tauri::LogicalSize::new((bounds.2 - frame.0).max(1.0), (bounds.3 - frame.1).max(1.0)).to_physical::<u32>(scale),
    )?;
    window.set_position(tauri::PhysicalPosition::new(
        (bounds.0 * scale).round() as i32,
        (bounds.1 * scale).round() as i32,
    ))
}

/// Centres the settings window over its owner, inside the owner's monitor work area. The window
/// may still be on another display with a different scale, so its size is converted with its own
/// scale and its position is given in physical pixels.
#[cfg(not(target_os = "macos"))]
pub(super) fn place_over_parent(window: &WebviewWindow, parent: &WebviewWindow) -> tauri::Result<()> {
    // Placement setters leave maximized mode. Fit the restored frame, then reapply the saved state.
    // A restored fullscreen window already covers its display and must not be fitted to the work area.
    if window.is_fullscreen()? {
        return Ok(());
    }
    let Some(monitor) = parent.current_monitor()?.or(parent.primary_monitor()?) else {
        return Ok(());
    };
    let maximized = window.is_maximized()?;
    if maximized {
        window.unmaximize()?;
    }
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = area.position.to_logical::<f64>(scale);
    let available = area.size.to_logical::<f64>(scale);
    let pos = parent.outer_position()?.to_logical::<f64>(scale);
    let size = parent.outer_size()?.to_logical::<f64>(scale);
    let own_scale = window.scale_factor()?;
    let own = window.outer_size()?.to_logical::<f64>(own_scale);
    // On Wayland, the frame is GTK's CSD shadow margin, which tao's inner size includes.
    #[cfg(target_os = "linux")]
    let inner = crate::linux_window_state::content_size(&window.as_ref().window())?;
    #[cfg(not(target_os = "linux"))]
    let inner = window.inner_size()?;
    let inner = inner.to_logical::<f64>(own_scale);
    let frame = (own.width - inner.width, own.height - inner.height);
    let bounds = fit_bounds(
        (pos.x, pos.y, size.width, size.height),
        (own.width, own.height),
        (origin.x, origin.y, available.width, available.height),
    );
    window.set_position(tauri::PhysicalPosition::new(
        (bounds.0 * scale).round() as i32,
        (bounds.1 * scale).round() as i32,
    ))?;
    if (bounds.2, bounds.3) != (own.width, own.height) {
        // Sizes are set on the client area, and even an undecorated window has a resize frame.
        let (width, height) = ((bounds.2 - frame.0).max(1.0), (bounds.3 - frame.1).max(1.0));
        window.set_min_size(Some(tauri::LogicalSize::new(
            SETTINGS_MIN_SIZE.0.min(width),
            SETTINGS_MIN_SIZE.1.min(height),
        )))?;
        window.set_size(tauri::LogicalSize::new(width, height))?;
    }
    if maximized {
        window.maximize()?;
    }
    Ok(())
}

fn fit_bounds(parent: (f64, f64, f64, f64), size: (f64, f64), work: (f64, f64, f64, f64)) -> (f64, f64, f64, f64) {
    let width = size.0.min(work.2);
    let height = size.1.min(work.3);
    let at = centered(parent.0, parent.1, parent.2, parent.3, width, height);
    (
        work.0 + (at.0 - work.0).clamp(0.0, work.2 - width),
        work.1 + (at.1 - work.1).clamp(0.0, work.3 - height),
        width,
        height,
    )
}

/// Top-left corner that centres a `w`×`h` window over the parent rectangle
/// (never above the parent's top edge, so the title bar stays reachable).
fn centered(px: f64, py: f64, pw: f64, ph: f64, w: f64, h: f64) -> (f64, f64) {
    (px + (pw - w) / 2.0, py + ((ph - h) / 2.0).max(0.0))
}

/// Reproduce WKWebView's user-font restriction before WKWebView creation. The
/// private selector and environment override are absent from release builds.
#[cfg(all(debug_assertions, target_os = "macos"))]
fn dev_font_preferences(
    builder: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    if std::env::var("OPENIDEA_DEV_DISALLOW_USER_FONTS").as_deref() == Ok("1") {
        use objc2::{MainThreadMarker, msg_send, sel};
        use objc2_foundation::NSObjectProtocol;
        let config = unsafe {
            objc2_web_kit::WKWebViewConfiguration::new(MainThreadMarker::new().expect("window creation on main thread"))
        };
        let preferences = unsafe { config.preferences() };
        if preferences.respondsToSelector(sel!(_setShouldAllowUserInstalledFonts:)) {
            unsafe {
                let _: () = msg_send![&preferences, _setShouldAllowUserInstalledFonts: false];
            }
            let allowed: bool = unsafe { msg_send![&preferences, _shouldAllowUserInstalledFonts] };
            tracing::info!(allowed, "Development user-installed fonts override");
            return builder.with_webview_configuration(config);
        }
        tracing::warn!("WKPreferences user-font development selector unavailable");
    }
    builder
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
fn dev_font_preferences(
    builder: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    builder
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
        // A flag's value is not the path.
        let args = s(&["openidea", "--line", "120", "--column", "8", "src/Main.java"]);
        assert_eq!(cli_path(&args, cwd), Some(PathBuf::from("/work/src/Main.java")));
        assert_eq!(
            cli_path(&s(&["openidea", "--line=3", "a b/文件.rs"]), cwd),
            Some(PathBuf::from("/work/a b/文件.rs"))
        );
    }

    #[test]
    fn cli_position_is_one_based_on_the_command_line() {
        assert_eq!(cli_position(&s(&["openidea", "--line", "120", "--column", "8", "f"])), Some((119, 7)));
        assert_eq!(cli_position(&s(&["openidea", "--line=5", "f"])), Some((4, 0)));
        assert_eq!(cli_position(&s(&["openidea", "--line", "0", "f"])), Some((0, 0)));
        assert_eq!(cli_position(&s(&["openidea", "--column", "8", "f"])), None);
        assert_eq!(cli_position(&s(&["openidea", "--line", "x", "f"])), None);
        assert_eq!(cli_position(&s(&["openidea", "f"])), None);
    }

    #[test]
    fn a_launch_carries_the_positions_of_its_files() {
        let st = WindowsState::default();
        let file = std::env::current_exe().unwrap();
        let other = std::env::temp_dir().join("openidea-not-opened.txt");
        st.set_position(&file, (11, 4));
        st.set_position(&other, (1, 0));
        st.add_files("main", vec![file.clone()]);
        let launch = st.take_launch("main").unwrap();
        assert_eq!(launch.positions, vec![FilePosition { path: file.into(), line: 11, column: 4 }]);
        // Taken once: the next launch of that file opens it where it was.
        st.add_files("main", vec![std::env::current_exe().unwrap()]);
        assert!(st.take_launch("main").unwrap().positions.is_empty());
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
    fn first_launch_keeps_wsl_files_apart_from_wsl_folders() {
        let share = PathBuf::from(r"\\wsl.localhost\Ubuntu\home\me\app");
        let folder = launch_for(share.clone(), true);
        let remote =
            RemoteLaunch { target: RemoteTarget::Wsl { distro: "Ubuntu".into() }, path: "/home/me/app".into() };
        assert_eq!((folder.remote, folder.project, folder.files.len()), (Some(remote), None, 0));
        let file = launch_for(share.join("main.py"), false);
        assert_eq!((file.remote, file.project, file.files.len()), (None, None, 1));
    }

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    fn w(label: &str, holds: Holds) -> (String, Holds) {
        (label.to_owned(), holds)
    }

    #[test]
    fn opening_at_launch_gives_the_first_window_files_or_folder() {
        let main = [w("main", Holds::Nothing)];
        let files = plan_open(vec![(p("/x/a.txt"), false), (p("/y/b.rs"), false)], &main);
        assert_eq!(files, [OpenStep::Launch("main".into(), path_launch_of(None, vec![p("/x/a.txt"), p("/y/b.rs")]))]);
        let dir = plan_open(vec![(p("/proj"), true)], &main);
        assert_eq!(dir, [OpenStep::Launch("main".into(), path_launch_of(Some(p("/proj")), Vec::new()))]);
        // Folder and files: the folder takes the first window, the files a new LightEdit one.
        let both = plan_open(vec![(p("/x/a.txt"), false), (p("/proj"), true)], &main);
        assert_eq!(
            both,
            [
                OpenStep::Launch("main".into(), path_launch_of(Some(p("/proj")), Vec::new())),
                OpenStep::New(None, vec![p("/x/a.txt")]),
            ]
        );
    }

    #[test]
    fn files_opened_at_launch_join_files_from_the_command_line() {
        let cli = path_launch_of(None, vec![p("/x/a.txt")]);
        let main = [w("main", pending_holds(Some(&cli)))];
        assert_eq!(
            plan_open(vec![(p("/x/b.txt"), false)], &main),
            [OpenStep::Files("main".into(), vec![p("/x/b.txt")])]
        );
        let st = WindowsState::default();
        st.set_launch("main", cli);
        st.add_files("main", vec![p("/x/b.txt")]);
        assert_eq!(st.take_launch("main").unwrap().files, [p("/x/a.txt"), p("/x/b.txt")]);
    }

    #[test]
    fn files_inside_an_open_project_open_in_its_window_and_the_others_in_light_edit() {
        let windows = [
            w("main", Holds::Project(p("/proj"))),
            w("project-1", Holds::LightEdit),
            w("project-2", Holds::Project(p("/proj/sub"))),
        ];
        let steps = plan_open(
            vec![
                (p("/proj/src/a.rs"), false),
                (p("/x/b.txt"), false),
                (p("/proj/sub/c.rs"), false),
                (p("/projects/d.rs"), false),
                (p("/proj/e.rs"), false),
            ],
            &windows,
        );
        assert_eq!(
            steps,
            [
                OpenStep::Files("main".into(), vec![p("/proj/src/a.rs"), p("/proj/e.rs")]),
                // The deepest root wins.
                OpenStep::Files("project-2".into(), vec![p("/proj/sub/c.rs")]),
                // `/projects` is not inside `/proj`.
                OpenStep::Files("project-1".into(), vec![p("/x/b.txt"), p("/projects/d.rs")]),
            ]
        );
    }

    #[test]
    fn files_inside_a_folder_being_opened_open_in_its_project() {
        let opening = path_launch_of(Some(p("/a")), Vec::new());
        let windows = [w("main", pending_holds(Some(&opening))), w("project-1", Holds::Nothing)];
        let steps = plan_open(vec![(p("/a/x.rs"), false), (p("/b"), true), (p("/b/y.rs"), false)], &windows);
        assert_eq!(
            steps,
            [
                OpenStep::Launch("project-1".into(), path_launch_of(Some(p("/b")), vec![p("/b/y.rs")])),
                OpenStep::Files("main".into(), vec![p("/a/x.rs")]),
            ]
        );
        assert_eq!(
            plan_open(vec![(p("/c"), true), (p("/c/z.rs"), false)], &[]),
            [OpenStep::New(Some(p("/c")), vec![p("/c/z.rs")])]
        );
    }

    #[test]
    fn remote_projects_do_not_take_local_files() {
        let windows = [w("main", Holds::Other), w("project-1", Holds::LightEdit)];
        assert_eq!(
            plan_open(vec![(p("/home/me/a.rs"), false)], &windows),
            [OpenStep::Files("project-1".into(), vec![p("/home/me/a.rs")])]
        );
    }

    #[test]
    fn wsl_folders_open_as_wsl_projects() {
        let (distro, linux_path) = ("Debian-12", "/srv/app");
        let share = format!(r"\\wsl.localhost\{distro}{}", linux_path.replace('/', r"\"));
        let share = share.as_str();
        let remote = wsl_launch(&p(share)).unwrap();
        assert_eq!(
            remote,
            RemoteLaunch { target: RemoteTarget::Wsl { distro: distro.into() }, path: linux_path.into() }
        );
        assert!(wsl_launch(&p(linux_path)).is_none());
        let launch = Launch { remote: Some(remote.clone()), ..Default::default() };
        let folder = vec![(p(share), true)];
        // A free window connects, else a new one; the window that has it open is focused.
        assert_eq!(plan_open(folder.clone(), &[w("main", Holds::Nothing)]), [OpenStep::Launch("main".into(), launch)]);
        assert_eq!(plan_open(folder.clone(), &[w("main", Holds::LightEdit)]), [OpenStep::NewRemote(remote.clone())]);
        let open = Holds::Wsl { distro: distro.to_lowercase(), path: format!("{linux_path}/") };
        assert_eq!(
            plan_open(folder, &[w("main", Holds::Nothing), w("project-1", open)]),
            [OpenStep::Focus("project-1".into())]
        );
        // Another distro's folder is a different project.
        let other = Holds::Wsl { distro: format!("{distro}-other"), path: linux_path.into() };
        assert!(!other.is_wsl_folder(&remote));
        assert_eq!(launch_for(p(share), true).remote, Some(remote));
    }

    #[test]
    fn files_opened_from_a_window_go_to_their_project_window_else_light_edit() {
        let windows = [
            w("main", Holds::Nothing),
            w("project-1", Holds::Project(p("/proj"))),
            w("project-2", Holds::Nothing),
            w("project-3", Holds::Other),
        ];
        let files = vec![p("/proj/src/a.rs"), p("/x/b.txt")];
        // The Welcome window turns into LightEdit itself; another free window doesn't take the files.
        let (steps, here) = plan_open_files("main", files.clone(), &windows);
        assert_eq!(steps, [OpenStep::Files("project-1".into(), vec![p("/proj/src/a.rs")])]);
        assert_eq!(here, [p("/x/b.txt")]);
        // A LightEdit window keeps loose files, even with another one open.
        let light =
            [w("main", Holds::LightEdit), w("project-1", Holds::Project(p("/proj"))), w("project-2", Holds::LightEdit)];
        let (steps, here) = plan_open_files("main", files.clone(), &light);
        assert_eq!(steps, [OpenStep::Files("project-1".into(), vec![p("/proj/src/a.rs")])]);
        assert_eq!(here, [p("/x/b.txt")]);
        // An existing LightEdit window takes them from a Welcome window.
        let others = [w("main", Holds::Nothing), w("project-2", Holds::LightEdit)];
        let (steps, here) = plan_open_files("main", vec![p("/x/b.txt")], &others);
        assert_eq!((steps, here), (vec![OpenStep::Files("project-2".into(), vec![p("/x/b.txt")])], vec![]));
        // A remote project window gets a new LightEdit window, never a free one or its own.
        let (steps, here) = plan_open_files("project-3", files, &windows);
        assert_eq!(
            steps,
            [OpenStep::Files("project-1".into(), vec![p("/proj/src/a.rs")]), OpenStep::New(None, vec![p("/x/b.txt")])]
        );
        assert!(here.is_empty());
    }

    #[test]
    fn files_opened_while_running_take_a_free_window_else_a_new_one() {
        let free = [w("main", Holds::Project(p("/proj"))), w("project-1", Holds::Nothing)];
        assert_eq!(
            plan_open(vec![(p("/x/a.txt"), false)], &free),
            [OpenStep::Launch("project-1".into(), path_launch_of(None, vec![p("/x/a.txt")]))]
        );
        let busy = [w("main", Holds::Project(p("/proj"))), w("project-1", Holds::Other)];
        assert_eq!(plan_open(vec![(p("/x/a.txt"), false)], &busy), [OpenStep::New(None, vec![p("/x/a.txt")])]);
    }

    #[test]
    fn folders_opened_while_running_focus_their_window_else_open_as_projects() {
        let windows = [w("main", Holds::LightEdit), w("project-1", Holds::Project(p("/a")))];
        let steps = plan_open(vec![(p("/a"), true), (p("/b"), true), (p("/b"), true)], &windows);
        assert_eq!(steps, [OpenStep::Focus("project-1".into()), OpenStep::New(Some(p("/b")), Vec::new())]);
        // A window still opening the folder (pending launch) counts as having it.
        let opening = path_launch_of(Some(p("/a")), Vec::new());
        let windows = [w("project-2", pending_holds(Some(&opening)))];
        assert_eq!(plan_open(vec![(p("/a"), true)], &windows), [OpenStep::Focus("project-2".into())]);
    }

    #[test]
    fn launches_are_taken_once() {
        let st = WindowsState::default();
        st.set_launch("project-1", Launch { project: Some("/p".into()), ..Default::default() });
        assert_eq!(st.take_launch("project-1").and_then(|l| l.project), Some("/p".into()));
        assert_eq!(st.take_launch("project-1"), None);
    }

    #[test]
    fn auxiliary_windows_map_to_their_parent() {
        assert_eq!(settings_label("project-2"), "settings-project-2");
        assert_eq!(auxiliary("settings-main"), Some((AuxKind::Settings, "main")));
        assert_eq!(auxiliary("comparison-project-2-14"), Some((AuxKind::Comparison, "project-2")));
        assert_eq!(auxiliary("deployment-project-2"), Some((AuxKind::Deployment, "project-2")));
        for label in ["main", "project-1", "comparison-main", "comparison-main-x", "settings-", "settingsmain"] {
            assert_eq!(auxiliary(label), None, "{label}");
        }
        assert_eq!(state_key("comparison-main-3"), "comparison");
        assert_eq!(state_key("project-3"), "project-3");
        let labels = ["comparison-main-0", "project-2", "main", "settings-main", "deployment-project-2"];
        assert_eq!(sorted_labels(labels.into_iter().filter(|l| auxiliary_parent(l).is_none())), ["main", "project-2"]);
    }

    #[test]
    fn settings_bounds_fit_current_work_area() {
        for (parent, size, work, expected) in [
            // 1920×1080 at 150% scaling, with a 40-physical-pixel taskbar.
            (
                (0.0, 0.0, 1280.0, 600.0),
                (980.0, 720.0),
                (0.0, 0.0, 1280.0, 1040.0 / 1.5),
                (150.0, 0.0, 980.0, 1040.0 / 1.5),
            ),
            // 3840×2160 at 250% scaling: an owner taller than the work area must not push it off screen.
            ((100.0, 60.0, 1440.0, 900.0), (980.0, 720.0), (0.0, 0.0, 1536.0, 816.0), (330.0, 96.0, 980.0, 720.0)),
            // Restored geometry from a larger display.
            ((100.0, 50.0, 1440.0, 900.0), (2400.0, 1600.0), (0.0, 24.0, 1920.0, 1016.0), (0.0, 24.0, 1920.0, 1016.0)),
            // Secondary display with a negative origin and reserved top/left space.
            (
                (-1800.0, 100.0, 1400.0, 900.0),
                (980.0, 720.0),
                (-1870.0, 24.0, 1870.0, 1016.0),
                (-1590.0, 190.0, 980.0, 720.0),
            ),
            // Parent near the lower-right edge.
            ((1700.0, 900.0, 800.0, 600.0), (980.0, 720.0), (0.0, 0.0, 1920.0, 1040.0), (940.0, 320.0, 980.0, 720.0)),
            // Work area smaller than the normal minimum size.
            ((0.0, 0.0, 800.0, 600.0), (980.0, 720.0), (0.0, 0.0, 600.0, 360.0), (0.0, 0.0, 600.0, 360.0)),
        ] {
            assert_eq!(fit_bounds(parent, size, work), expected);
        }
    }

    #[test]
    fn settings_window_is_centred_over_parent() {
        assert_eq!(centered(100.0, 50.0, 1440.0, 900.0, 980.0, 720.0), (330.0, 140.0));
        // Taller than the parent: aligned with its top edge.
        assert_eq!(centered(0.0, 50.0, 800.0, 500.0, 600.0, 720.0), (100.0, 50.0));
    }
}
