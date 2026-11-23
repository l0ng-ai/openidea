//! Project windows: one project per window, labelled `main` or `project-<n>`.
//!
//! A new window is built from the `main` window config (overlay title bar,
//! traffic lights, min size, background colour). What it should open is kept
//! here as a pending [`Launch`] that its frontend takes on startup
//! (`window_take_launch`), and re-taken whenever [`LAUNCH_EVENT`] fires (a
//! second app instance asking an already-loaded window to open a path).
//!
//! Auxiliary windows ([`AuxKind`]: Settings, Compare with Local, Diff, Sync with Deployed) belong to a project window and share its project (see
//! [`AppState::project`]). Their labels name the kind and the parent
//! (`settings-main`, `comparison-project-2-3`, `diff-main-0`); their [`Launch`] says what to show.

mod cli;
#[cfg(windows)]
mod single_instance;
#[cfg(windows)]
pub use single_instance::allow_external_launches;

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
const SETTINGS_MIN_SIZE: (f64, f64) = (900.0, 700.0);
const COMPARISON_SIZE: (f64, f64) = (1100.0, 720.0);
const COMPARISON_MIN_SIZE: (f64, f64) = (640.0, 360.0);
const DIFF_SIZE: (f64, f64) = (1100.0, 720.0);
const DIFF_MIN_SIZE: (f64, f64) = (640.0, 360.0);
const EDITOR_SIZE: (f64, f64) = (1100.0, 720.0);
const EDITOR_MIN_SIZE: (f64, f64) = (640.0, 360.0);
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
    /// Diff windows: the diff to show (boxed: most launches have none).
    #[serde(default)]
    pub diff_window: Option<Box<DiffLaunch>>,
    /// `openidea diff a.txt b.txt`: the two files to open in the diff viewer (boxed: most launches have none).
    #[serde(default)]
    pub diff: Option<Box<DiffFilesLaunch>>,
    /// Files requested after the pending diff take focus after it opens.
    #[serde(default)]
    pub diff_before_files: bool,
    /// Deployment windows: the server and local selection to compare.
    #[serde(default)]
    pub deployment: Option<DeploymentLaunch>,
    /// Editor windows: the file to show (Open in New Window → lightweight aux editor).
    #[serde(default)]
    pub editor: Option<Box<EditorLaunch>>,
}

/// What a lightweight editor window shows: a file, with optional caret / selection (0-based), or
/// the tab of another editor kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorLaunch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<ide_core::IpcPath>,
    /// The tab's editor input, as JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
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

/// One side of a diff window's comparison (the UI's `DiffSide`, `diffInput.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DiffSide {
    /// File content at a Git revision (`HEAD`, `:0` = index, a commit id).
    Rev {
        rev: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// The working file (unsaved editor buffer included).
    Worktree {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label_detail: Option<String>,
    },
    /// Another file (Compare With…, Compare Files).
    File {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// Literal text, such as clipboard contents or an editor selection.
    Text {
        text: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label_detail: Option<String>,
    },
    /// A Local History revision.
    History { id: String, label: String },
}

/// The diff a diff window shows (IDEA's "Show Diff in New Window"), from the UI's `DiffData`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLaunch {
    /// Absolute path of the file (the right side's path).
    pub path: String,
    pub left: DiffSide,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub middle: Option<DiffSide>,
    pub right: DiffSide,
    /// 0-based line to reveal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_side: Option<DiffLineSide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<Vec<DiffLaunch>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineSide {
    Left,
    Middle,
    Right,
}

/// The two files of a command-line diff (`openidea diff a.txt b.txt`), both sides editable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DiffFilesLaunch {
    pub left: ide_core::IpcPath,
    pub right: ide_core::IpcPath,
}

/// A caret position for a file opened from the command line: 0-based line and column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FilePosition {
    pub path: ide_core::IpcPath,
    pub line: u32,
    pub column: u32,
}

impl Launch {
    fn add_positions(&mut self, positions: &[FilePosition]) {
        for position in positions.iter().filter(|p| self.files.contains(&p.path)) {
            self.positions.retain(|p| p.path != position.path);
            self.positions.push(position.clone());
        }
    }
}

/// A project folder on an SSH host, in a WSL distribution or in a dev container.
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

/// A saved project path that is a remote location: `ssh://`, `wsl://`, `devcontainer://`,
/// or a `\\wsl.localhost` share remembered before those locations existed.
pub(crate) fn saved_remote(path: &Path) -> Option<RemoteLaunch> {
    if let Some(text) = path.to_str()
        && let Some((target, root)) = crate::remote_dev::parse_remote_location(text)
    {
        return Some(RemoteLaunch { target, path: root });
    }
    wsl_launch(path)
}

/// What reopening `path` should launch. A remote location is recognised before any stat,
/// so a WSL share that is down still comes back as a remote project.
pub(crate) fn saved_project_launch(path: &Path) -> Option<Launch> {
    if let Some(remote) = saved_remote(path) {
        return Some(Launch { remote: Some(remote), ..Default::default() });
    }
    path.is_dir().then(|| Launch { project: Some(path.to_path_buf().into()), ..Default::default() })
}

/// The same project, including a WSL share and the `wsl://` location of that folder.
pub(crate) fn same_saved_project(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (saved_remote(a), saved_remote(b)) {
        (Some(left), Some(right)) => {
            left.target == right.target && left.path.trim_end_matches('/') == right.path.trim_end_matches('/')
        }
        _ => false,
    }
}

/// The project `label` has open: a remote location (`wsl://` and the rest), else its local root.
pub(crate) fn window_project_path(app: &AppHandle, label: &str) -> Option<PathBuf> {
    let state = app.try_state::<AppState>()?;
    if let Some(c) = state.remote_dev.get(label) {
        return Some(PathBuf::from(crate::remote_dev::remote_location(&c.target, &c.root)));
    }
    state.project(label).ok().filter(|p| !p.light).map(|p| p.root.clone())
}

/// Reopens a project saved at quit. Remote locations become a remote launch; a missing
/// local folder is skipped. An already connected window is focused instead of duplicated.
pub(crate) fn reopen_saved_window(app: &AppHandle, path: &Path) -> IdeResult<Option<WebviewWindow>> {
    let Some(launch) = saved_project_launch(path) else {
        return Ok(None);
    };
    if let Some(remote) = launch.remote.clone() {
        let open = app.try_state::<AppState>().and_then(|s| s.remote_dev.window_of(&remote.target, &remote.path));
        if let Some(w) = open.and_then(|label| app.get_webview_window(&label)) {
            return Ok(Some(w));
        }
        let title = remote
            .path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty() && *n != "~")
            .map(str::to_owned);
        return Ok(Some(create_window_for(app, title, launch, true)?));
    }
    if let Some(w) = find_project_window(app, path) {
        return Ok(Some(w));
    }
    Ok(Some(create_restored_window(app, path.to_path_buf())?))
}

#[derive(Default)]
pub struct WindowsState {
    pub groups: Mutex<ide_workspace::window_groups::WindowGroups>,
    pub groups_restored: AtomicBool,
    /// Serialises writes of the saved session. Holds the previous run's session once read: it is
    /// read before this run first overwrites the file, so restoring still sees it.
    pub groups_persist: tokio::sync::Mutex<Option<Vec<ide_workspace::window_groups::SavedWindows>>>,
    launches: Mutex<HashMap<String, Launch>>,
    /// A taken launch still owns its window until the frontend finishes opening it.
    opening: Mutex<HashMap<String, Launch>>,
    cli: Mutex<cli::Queue>,
    /// Most recently focused window label (menu events go there).
    last_focused: Mutex<Option<String>>,
    /// Set by Quit while windows close one by one.
    quitting: AtomicBool,
    /// The last closed project opted out of Welcome; macOS keeps its app in the Dock.
    #[cfg(target_os = "macos")]
    pub keep_alive: AtomicBool,
    /// Windows asked to close whose guards have not finished. AppKit closes a whole tab group at
    /// once, so its members ask together.
    close_requests: Mutex<Vec<String>>,
    /// Project tabs closing one by one (Close Other Tabs and friends).
    pub tab_closes: Mutex<Option<crate::window_groups::TabCloses>>,
    /// Relaunch once the quit completes (after installing an update).
    restart: AtomicBool,
    /// Numbers windows of kinds that can open several times per project window.
    aux_serial: AtomicU64,
    /// Logical sizes remembered per [`AuxKind`] on macOS (`auxiliary-windows.json`), avoiding
    /// `tauri-plugin-window-state`'s physical-pixel scale-factor drift across mixed-DPI displays.
    #[cfg(target_os = "macos")]
    aux_geometry: Mutex<Option<HashMap<String, AuxGeometry>>>,
}

#[cfg(target_os = "macos")]
const AUX_STATE_FILE: &str = "auxiliary-windows.json";
/// How long an auxiliary window waits for the main thread to fit it over its parent.
#[cfg(target_os = "macos")]
const FIT_ON_MAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct AuxGeometry {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

impl WindowsState {
    pub fn close_requested(&self, label: &str) {
        let mut requests = self.close_requests.lock();
        if !requests.iter().any(|l| l == label) {
            requests.push(label.to_owned());
        }
    }

    pub fn close_settled(&self, label: &str) {
        self.close_requests.lock().retain(|l| l != label);
    }

    pub fn pending_closes(&self) -> Vec<String> {
        self.close_requests.lock().clone()
    }

    pub fn set_launch(&self, label: &str, launch: Launch) {
        self.launches.lock().insert(label.to_owned(), launch);
    }

    /// Whether the window `label` is created to open a project (local or remote).
    #[cfg(target_os = "macos")]
    pub fn opens_project(&self, label: &str) -> bool {
        self.pending(label).is_some_and(|l| l.project.is_some() || l.remote.is_some())
    }

    pub fn take_launch(&self, label: &str) -> Option<Launch> {
        let mut launches = self.launches.lock();
        // Lightweight windows need their launch again when their webview reloads.
        if let Some(launch) = launches.get(label)
            && launch.editor.is_some()
        {
            return Some(launch.clone());
        }
        let launch = launches.remove(label)?;
        if launch.project.is_some() || launch.remote.is_some() || !launch.files.is_empty() || launch.diff.is_some() {
            self.opening.lock().insert(label.to_owned(), launch.clone());
        }
        Some(launch)
    }

    pub fn complete_launch(&self, label: &str) {
        self.opening.lock().remove(label);
    }

    /// Adds `files` to `label`'s pending launch, so files sent before its frontend took the last batch aren't lost.
    fn add_files_at(&self, label: &str, files: Vec<PathBuf>, positions: &[FilePosition]) {
        let mut launches = self.launches.lock();
        let launch = launches.entry(label.to_owned()).or_default();
        if !files.is_empty() && launch.diff.is_some() {
            launch.diff_before_files = true;
        }
        launch.files.extend(files.into_iter().map(Into::into));
        launch.add_positions(positions);
    }

    fn add_diff(&self, label: &str, diff: DiffFilesLaunch) {
        let mut launches = self.launches.lock();
        let launch = launches.entry(label.to_owned()).or_default();
        launch.diff = Some(Box::new(diff));
        launch.diff_before_files = false;
    }

    pub(crate) fn pending(&self, label: &str) -> Option<Launch> {
        let launches = self.launches.lock();
        let opening = self.opening.lock();
        opening.get(label).or_else(|| launches.get(label)).cloned()
    }

    pub fn focused(&self, label: &str) {
        *self.last_focused.lock() = Some(label.to_owned());
    }

    pub fn forget(&self, label: &str) {
        self.close_settled(label);
        {
            let mut launches = self.launches.lock();
            let mut opening = self.opening.lock();
            launches.remove(label);
            opening.remove(label);
        }
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
    Diff,
    Editor,
    Deployment,
}

impl AuxKind {
    const ALL: [AuxKind; 5] =
        [AuxKind::Settings, AuxKind::Comparison, AuxKind::Diff, AuxKind::Editor, AuxKind::Deployment];

    /// Label prefix, and the key of the one remembered geometry shared by every window of the kind.
    pub fn name(self) -> &'static str {
        match self {
            AuxKind::Settings => "settings",
            AuxKind::Comparison => "comparison",
            AuxKind::Diff => "diff",
            AuxKind::Editor => "editor",
            AuxKind::Deployment => "deployment",
        }
    }

    /// Several per project window (`<kind>-<parent>-<n>`), else one (`<kind>-<parent>`).
    fn multiple(self) -> bool {
        matches!(self, AuxKind::Comparison | AuxKind::Diff | AuxKind::Editor)
    }

    /// Shows the project's documents: gets its parent's events and edits made in sibling windows,
    /// and asks about its own unsaved changes before the parent closes it.
    pub fn shares_documents(self) -> bool {
        self != AuxKind::Settings
    }

    /// Has no actions of its own: menu items run in its project window.
    fn runs_menu_in_parent(self) -> bool {
        self == AuxKind::Settings
    }

    /// Needs its parent to have a project open.
    fn needs_project(self) -> bool {
        self != AuxKind::Settings
    }

    pub fn min_size(self) -> (f64, f64) {
        match self {
            AuxKind::Settings => SETTINGS_MIN_SIZE,
            AuxKind::Comparison => COMPARISON_MIN_SIZE,
            AuxKind::Diff => DIFF_MIN_SIZE,
            AuxKind::Editor => EDITOR_MIN_SIZE,
            AuxKind::Deployment => DEPLOYMENT_MIN_SIZE,
        }
    }

    pub fn default_size(self) -> (f64, f64) {
        match self {
            AuxKind::Settings => SETTINGS_SIZE,
            AuxKind::Comparison => COMPARISON_SIZE,
            AuxKind::Diff => DIFF_SIZE,
            AuxKind::Editor => EDITOR_SIZE,
            AuxKind::Deployment => DEPLOYMENT_SIZE,
        }
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

/// Where a menu item chosen while window `label` is focused runs.
#[derive(Debug, PartialEq, Eq)]
pub enum MenuDestination<'a> {
    /// The window's own frontend.
    Own,
    /// The project window `label`; `raise` brings it to the front so what the action shows is seen.
    Parent { label: &'a str, raise: bool },
    /// The window itself is the tab: Close Tab closes it.
    Close,
}

/// Actions an auxiliary window always leaves to its project window.
const PARENT_ACTIONS: [&str; 4] = ["app.quit", "file.settings", "file.projectStructure", "file.newProjectsSettings"];

/// Where menu item `action` runs while window `label` is focused. As in IDEA, the menu stays usable
/// with Settings open: it runs in the project window, whose enablement (no focused editor) the menu shows.
pub fn menu_destination<'a>(label: &'a str, action: &str) -> MenuDestination<'a> {
    match auxiliary(label) {
        None => MenuDestination::Own,
        Some((_, parent)) if PARENT_ACTIONS.contains(&action) => {
            MenuDestination::Parent { label: parent, raise: false }
        }
        Some((kind, parent)) if kind.runs_menu_in_parent() => MenuDestination::Parent { label: parent, raise: true },
        Some(_) if action == "editor.closeTab" => MenuDestination::Close,
        Some(_) => MenuDestination::Own,
    }
}

/// The project window an auxiliary window belongs to (`settings-main` → `main`).
pub fn auxiliary_parent(label: &str) -> Option<&str> {
    auxiliary(label).map(|(_, parent)| parent)
}

pub fn settings_label(parent: &str) -> String {
    format!("{}-{parent}", AuxKind::Settings.name())
}

/// Held from choosing a project window's label until the window exists.
static CREATING: Mutex<()> = Mutex::new(());

/// Windows being built to join a window group, which takes their frame from the group.
#[cfg(target_os = "macos")]
static JOINING_GROUP: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Whether the window-state plugin restores and tracks `label`'s geometry. A window joining a
/// group takes the group's frame instead; auxiliary windows store logical sizes in
/// `auxiliary-windows.json` and place themselves over their parent, avoiding physical-pixel
/// scale drift and async restore races across mixed-DPI displays.
#[cfg(any(target_os = "macos", test))]
pub fn keeps_window_state(label: &str) -> bool {
    #[cfg(target_os = "macos")]
    if JOINING_GROUP.lock().iter().any(|l| l == label) {
        return false;
    }
    auxiliary_parent(label).is_none() && !AuxKind::ALL.iter().any(|k| k.name() == label)
}

/// The window state key: one geometry per auxiliary kind, else the label itself.
pub fn state_key(label: &str) -> &str {
    auxiliary(label).map_or(label, |(kind, _)| kind.name())
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

/// The first path, for ordinary opening and the Windows recent-project shortcut.
pub fn cli_path(args: &[String], cwd: &Path) -> Option<PathBuf> {
    cli::parse(args, cwd).ok().and_then(|r| r.path.or(r.file))
}

/// A positional folder plus `--file` opens that file in its project. Without a folder,
/// ordinary files retain LightEdit behavior; an existing project window can claim them.
pub fn cli_launch(args: &[String], cwd: &Path) -> IdeResult<Option<Launch>> {
    if let Some(paths) = cli::diff_paths(args, cwd) {
        return Ok(match paths.as_slice() {
            [left, right, ..] => Some(Launch {
                diff: Some(Box::new(DiffFilesLaunch { left: left.clone().into(), right: right.clone().into() })),
                ..Default::default()
            }),
            [one] => {
                let mut file_args = args.to_vec();
                file_args.remove(1);
                let position = cli::parse(&file_args, cwd).map_err(IdeError::invalid)?.position;
                Some(position_launch(path_launch(one.clone()), position))
            }
            [] => None,
        });
    }
    let request = cli::parse(args, cwd).map_err(IdeError::invalid)?;
    let canonical = |path: &Path| {
        dunce::canonicalize(path).map_err(|e| IdeError::invalid(format!("Cannot open {}: {e}", path.display())))
    };
    let launch = if let Some(file) = request.file {
        let file = canonical(&file)?;
        if !file.is_file() {
            return Err(IdeError::invalid("--file must name an existing file"));
        }
        let project = request.path.map(|p| canonical(&p)).transpose()?;
        if project.as_ref().is_some_and(|p| !p.is_dir()) {
            return Err(IdeError::invalid("The positional path before --file must be a project folder"));
        }
        if project.as_ref().is_some_and(|p| wsl_launch(p).is_some()) {
            return Err(IdeError::invalid("External file locations require a local project folder"));
        }
        path_launch_of(project, vec![file])
    } else if let Some(path) = request.path {
        path_launch(canonical(&path)?)
    } else {
        return Ok(None);
    };
    Ok(Some(position_launch(launch, request.position)))
}

fn position_launch(mut launch: Launch, position: Option<(u32, u32)>) -> Launch {
    if let (Some((line, column)), Some(file)) = (position, launch.files.first()) {
        launch.positions.push(FilePosition { path: file.clone(), line, column });
    }
    launch
}

/// CLI failures also need to be visible before the webview has subscribed to notifications.
pub fn report_cli_error(app: &AppHandle, error: IdeError) {
    use tauri_plugin_dialog::DialogExt;
    tracing::warn!("external open failed: {}", error.message);
    app.dialog()
        .message(error.message)
        .title("OpenIDEA")
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .show(|_| {});
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
    send_files_at(app, window, files, &[]);
}

fn send_files_at(app: &AppHandle, window: &WebviewWindow, files: Vec<PathBuf>, positions: &[FilePosition]) {
    app.state::<WindowsState>().add_files_at(window.label(), files, positions);
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
    if let Some(state) = &state {
        state.plugins.reopen_client(&config.label);
    }
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
        .and_then(|b| dev_font_preferences(b).on_new_window(open_popup_in_browser).build())
        .map_err(|e| IdeError::internal(format!("cannot create window: {e}")))?;
    #[cfg(target_os = "linux")]
    decorate_csd(&window);
    #[cfg(target_os = "macos")]
    crate::page_swipe::install(&window);
    apply_zoom(app, &window);
    #[cfg(target_os = "macos")]
    align_titlebar(app, &window, app.try_state::<WindowsState>().is_some_and(|w| w.opens_project(window.label())));
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
fn align_titlebar(app: &AppHandle, window: &WebviewWindow, opens_project: bool) {
    let Some(a) = app.try_state::<AppState>().map(|s| s.global_settings.effective().appearance) else {
        return;
    };
    let _ = crate::titlebar::set_height(window, initial_titlebar_height(&a, opens_project));
}

/// The title bar height (AppKit points) the page will draw. Only a project window hides its
/// toolbar for View › Appearance › Toolbar, and it is known to be one when it opens a project.
#[cfg(any(target_os = "macos", test))]
fn initial_titlebar_height(a: &AppearanceSettings, opens_project: bool) -> f64 {
    // `--h-titlebar` and `--h-compact-header` in tokens.css.
    const HEIGHT: f64 = 40.0;
    const COMPACT_HEIGHT: f64 = 32.0;
    const COMPACT_HEADER_HEIGHT: f64 = 30.0;
    let height = if opens_project && !a.show_main_toolbar {
        COMPACT_HEADER_HEIGHT
    } else if a.compact_mode {
        COMPACT_HEIGHT
    } else {
        HEIGHT
    };
    height * f64::from(a.zoom.clamp(50, 300)) / 100.0
}

/// The first window (`create: false` in tauri.conf.json so it can take the theme's colour).
pub fn create_main_window(app: &AppHandle) -> IdeResult<WebviewWindow> {
    build_project_window(app, window_config(app)?)
}

/// Creates a new project window; `project` is opened by its frontend on load.
pub fn create_window(app: &AppHandle, project: Option<PathBuf>) -> IdeResult<WebviewWindow> {
    create_window_with(app, project, Vec::new(), false)
}

/// [`create_window`] that also opens `files` (without `project`: in LightEdit).
fn create_window_with(
    app: &AppHandle,
    project: Option<PathBuf>,
    files: Vec<PathBuf>,
    restoring: bool,
) -> IdeResult<WebviewWindow> {
    let title = project.as_deref().or(files.first().map(PathBuf::as_path)).and_then(Path::file_name);
    let title = title.map(|n| n.to_string_lossy().into_owned());
    let files = files.into_iter().map(Into::into).collect();
    create_window_for(app, title, Launch { project: project.map(Into::into), files, ..Default::default() }, restoring)
}

/// Restoring a saved group preserves its membership and selected tab.
pub fn create_restored_window(app: &AppHandle, project: PathBuf) -> IdeResult<WebviewWindow> {
    create_window_with(app, Some(project), Vec::new(), true)
}

fn create_window_for(
    app: &AppHandle,
    title: Option<String>,
    launch: Launch,
    _restoring: bool,
) -> IdeResult<WebviewWindow> {
    #[cfg(target_os = "macos")]
    let tab_target = if _restoring { None } else { crate::macos::new_project_tab_target(app, &launch)? };
    // The label is free only until the window exists, so concurrent opens take turns.
    let creating = CREATING.lock();
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
    #[cfg(target_os = "macos")]
    if tab_target.is_some() {
        JOINING_GROUP.lock().push(label.clone());
        // Selecting it in the group shows it; shown before, a window opened over a fullscreen
        // group lands on the desktop and takes the screen there.
        config.visible = false;
    }
    let window = build_project_window(app, config);
    drop(creating);
    // Plugins hear of the window from the main thread's queue; forget it after them.
    #[cfg(target_os = "macos")]
    if tab_target.is_some() {
        let joined = label.clone();
        let _ = app.run_on_main_thread(move || JOINING_GROUP.lock().retain(|l| *l != joined));
    }
    let window = window?;
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
    let title = project.as_deref().or(files.first().map(PathBuf::as_path)).and_then(Path::file_name);
    let title = title.map(|n| n.to_string_lossy().into_owned());
    let _ = open_launch_window(app, title, path_launch_of(project, files), false);
}

fn open_launch_window(app: &AppHandle, title: Option<String>, launch: Launch, wait: bool) -> IdeResult<()> {
    if wait {
        return create_window_for(app, title, launch, false).map(|_| ());
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = create_window_for(&app, title, launch, false) {
            tracing::warn!("cannot open window: {}", e.message);
        }
    });
    Ok(())
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
    let window = create_window_with(app, Some(root), files, false)?;
    Ok(OpenOutcome::Opened { label: window.label().to_owned() })
}

/// Opens `file` in a forced new window: `project` (None: LightEdit) plus the
/// single file, always creating a window even when the project is already open
/// in another one (unlike [`open_project_window`], which focuses it). Used to
/// detach an editor tab out of its window.
pub fn open_file_in_new_window(app: &AppHandle, project: Option<PathBuf>, file: PathBuf) -> IdeResult<OpenOutcome> {
    tracing::info!("open_file_in_new_window {} project={:?}", file.display(), project);
    let window = create_window_with(app, project, vec![file], false)?;
    Ok(OpenOutcome::Opened { label: window.label().to_owned() })
}

/// Loose local `files` asked for by window `caller` (File | Open File, a drop on the Welcome
/// screen), routed by [`plan_open`]; returns the files `caller` opens itself.
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
    let window = create_window_for(app, title, Launch { remote: Some(remote), ..Default::default() }, false)?;
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
    /// An SSH or dev container remote project.
    Other,
}

impl Holds {
    fn of_remote(remote: &RemoteLaunch) -> Self {
        match &remote.target {
            RemoteTarget::Wsl { distro } => Holds::Wsl { distro: distro.clone(), path: remote.path.clone() },
            RemoteTarget::Ssh { .. } | RemoteTarget::DevContainer { .. } => Holds::Other,
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
        Some(l) if !l.files.is_empty() || l.diff.is_some() => Holds::LightEdit,
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
    /// A free window opens this (boxed: the enum stays small).
    Launch(String, Box<Launch>),
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
/// one first). A folder focuses the window that has it open, else takes a free window,
/// else a new one. A file inside a local project being opened (the deepest root if nested)
/// opens in that project's window; the others join the preferred window when it holds a local
/// project or LightEdit, else the LightEdit window, else a free window or a new one switches to
/// LightEdit for them.
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
                    Some(label) => {
                        OpenStep::Launch(label, Box::new(Launch { remote: Some(remote), ..Default::default() }))
                    }
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
            Some(label) => OpenStep::Launch(label, Box::new(path_launch_of(Some(dir), Vec::new()))),
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
    let preferred = windows.first().filter(|(_, h)| matches!(h, Holds::Project(_) | Holds::LightEdit));
    let light = windows.iter().find(|(_, h)| *h == Holds::LightEdit);
    match preferred.or(light) {
        Some((label, _)) if !loose.is_empty() => {
            let files = std::mem::take(&mut loose);
            match in_windows.iter_mut().find(|(l, _)| l == label) {
                Some((_, list)) => list.extend(files),
                None => in_windows.push((label.clone(), files)),
            }
        }
        _ => {}
    }
    steps.extend(in_windows.into_iter().map(|(label, files)| OpenStep::Files(label, files)));
    if !loose.is_empty() {
        steps.push(match free.next() {
            Some(label) => OpenStep::Launch(label, Box::new(path_launch_of(None, loose))),
            None => OpenStep::New(None, loose),
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

/// Opens paths from Finder's Open With or the Dock:
/// see [`plan_open`]; the focused window is the preferred free one.
#[cfg(target_os = "macos")]
pub fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    open_paths_at(app, paths, &[]);
}

fn open_paths_at(app: &AppHandle, paths: Vec<PathBuf>, positions: &[FilePosition]) {
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
    if let Err(error) =
        run_open_at(app, plan_open(resolve(existing), &window_holds(app, preferred.as_deref())), positions, false)
    {
        tracing::warn!("cannot open window: {}", error.message);
    }
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

/// Opens external paths while the app is starting, before `main` exists: it takes them as its launch.
pub fn open_paths_at_launch(app: &AppHandle, paths: Vec<PathBuf>) {
    let main = pending_holds(app.state::<WindowsState>().pending(MAIN).as_ref());
    run_open(app, plan_open(resolve(paths), &[(MAIN.to_owned(), main)]));
}

fn run_open(app: &AppHandle, steps: Vec<OpenStep>) {
    if let Err(error) = run_open_at(app, steps, &[], false) {
        tracing::warn!("cannot open window: {}", error.message);
    }
}

/// CLI workers wait for new windows so the next request can route to them.
pub(crate) fn run_open_at(
    app: &AppHandle,
    steps: Vec<OpenStep>,
    positions: &[FilePosition],
    wait_for_window: bool,
) -> IdeResult<()> {
    let windows = app.state::<WindowsState>();
    for step in steps {
        match step {
            OpenStep::Focus(label) => {
                if let Some(w) = app.get_webview_window(&label) {
                    focus(&w);
                }
            }
            OpenStep::Files(label, files) => match app.get_webview_window(&label) {
                Some(w) => send_files_at(app, &w, files, positions),
                None => windows.add_files_at(&label, files, positions),
            },
            OpenStep::Launch(label, mut launch) => {
                launch.add_positions(positions);
                windows.set_launch(&label, *launch);
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = app.emit_to(&label, LAUNCH_EVENT, ());
                    focus(&w);
                }
            }
            OpenStep::New(project, files) => {
                let title = project.as_deref().or(files.first().map(PathBuf::as_path)).and_then(Path::file_name);
                let title = title.map(|n| n.to_string_lossy().into_owned());
                let mut launch = path_launch_of(project, files);
                launch.add_positions(positions);
                open_launch_window(app, title, launch, wait_for_window)?;
            }
            OpenStep::NewRemote(remote) => {
                let title = remote.path.trim_end_matches('/').rsplit('/').next().map(str::to_owned);
                let launch = Launch { remote: Some(remote), ..Default::default() };
                open_launch_window(app, title, launch, wait_for_window)?;
            }
        }
    }
    Ok(())
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
    if app.state::<WindowsState>().cli.lock().push(args, cwd) {
        drain_cli(app);
    }
}

fn dispatch_cli(app: &AppHandle, args: Vec<String>, cwd: String) {
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
    match cli_launch(&args, Path::new(&cwd)) {
        Ok(Some(Launch { diff: Some(diff), .. })) => {
            if let Err(error) = open_diff_files_at(app, *diff, true) {
                report_cli_error(app, error);
            }
        }
        Ok(Some(launch)) => {
            let preferred = target_window(app).map(|w| w.label().to_owned());
            let positions = launch.positions.clone();
            let plan = plan_cli_launch(launch, &window_holds(app, preferred.as_deref()));
            if let Err(error) = run_open_at(app, plan, &positions, true) {
                report_cli_error(app, error);
            }
        }
        Ok(None) => focus_any(app),
        Err(error) => report_cli_error(app, error),
    }
}

/// Focuses the window the user last looked at, else opens a new one.
fn focus_any(app: &AppHandle) {
    if let Some(w) = target_window(app) {
        focus(&w);
    } else {
        spawn_window(app, None);
    }
}

/// Opens the installed command's targets, carrying each file's position with its launch.
pub fn open_targets(app: &AppHandle, targets: Vec<ide_cli::Target>) {
    if targets.is_empty() {
        return focus_any(app);
    }
    let positions = target_positions(&targets);
    open_paths_at(app, targets.into_iter().map(|t| t.path).collect(), &positions);
}

fn target_positions(targets: &[ide_cli::Target]) -> Vec<FilePosition> {
    targets
        .iter()
        .filter_map(|t| {
            let line = t.line?;
            if t.path.is_dir() {
                return None;
            }
            let path = dunce::canonicalize(&t.path).unwrap_or_else(|_| t.path.clone());
            Some(FilePosition {
                path: path.into(),
                line: line.saturating_sub(1),
                column: t.column.map_or(0, |c| c.saturating_sub(1)),
            })
        })
        .collect()
}

/// Opens the command's local diff pair in a local project window, never an auxiliary or remote window.
pub(crate) fn open_diff_files(app: &AppHandle, diff: DiffFilesLaunch) {
    if let Err(error) = open_diff_files_at(app, diff, false) {
        tracing::warn!("cannot open window: {}", error.message);
    }
}

fn open_diff_files_at(app: &AppHandle, diff: DiffFilesLaunch, wait_for_window: bool) -> IdeResult<()> {
    let local = |window: &WebviewWindow| {
        auxiliary_parent(window.label()).is_none()
            && matches!(holds(app, window.label()), Holds::Nothing | Holds::Project(_) | Holds::LightEdit)
    };
    let target = target_window(app).filter(local).or_else(|| {
        project_window_labels(app).into_iter().filter_map(|label| app.get_webview_window(&label)).find(local)
    });
    if let Some(window) = target {
        app.state::<WindowsState>().add_diff(window.label(), diff);
        let _ = app.emit_to(window.label(), LAUNCH_EVENT, ());
        focus(&window);
        Ok(())
    } else {
        let launch = Launch { diff: Some(Box::new(diff)), ..Default::default() };
        open_launch_window(app, None, launch, wait_for_window)
    }
}

/// An explicit project owns the requested files, including sources outside its root.
fn plan_cli_launch(launch: Launch, windows: &[(String, Holds)]) -> Vec<OpenStep> {
    let files: Vec<_> = launch.files.into_iter().map(|f| f.0).collect();
    let Some(project) = launch.project else {
        if let Some(remote) = launch.remote {
            return vec![match windows.iter().find(|(_, h)| h.is_wsl_folder(&remote)) {
                Some((label, _)) => OpenStep::Focus(label.clone()),
                None => match windows.iter().find(|(_, h)| *h == Holds::Nothing) {
                    Some((label, _)) => {
                        OpenStep::Launch(label.clone(), Box::new(Launch { remote: Some(remote), ..Default::default() }))
                    }
                    None => OpenStep::NewRemote(remote),
                },
            }];
        }
        return plan_open(files.into_iter().map(|f| (f, false)).collect(), windows);
    };
    plan_open(vec![(project.0, true)], windows)
        .into_iter()
        .map(|step| match step {
            OpenStep::Focus(label) if !files.is_empty() => OpenStep::Files(label, files.clone()),
            OpenStep::Launch(label, mut pending) => {
                pending.files.extend(files.iter().cloned().map(Into::into));
                OpenStep::Launch(label, pending)
            }
            OpenStep::New(root, _) => OpenStep::New(root, files.clone()),
            step => step,
        })
        .collect()
}

/// Drain requests received while plugins and the first window were being initialized.
pub fn ready_for_cli(app: &AppHandle) {
    if app.state::<WindowsState>().cli.lock().ready() {
        drain_cli(app);
    }
}

fn drain_cli(app: &AppHandle) {
    let app = app.clone();
    // Creating a webview must not block the event-loop thread. Finish each creation
    // before routing the next request so a not-yet-visible window can be reused.
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            let request = app.state::<WindowsState>().cli.lock().next();
            let Some((args, cwd)) = request else { break };
            dispatch_cli(&app, args, cwd);
        }
    });
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
    let label = if let Some(diff) = aux.launch.diff_window.as_deref() {
        format!("diff-{parent_label}-{}", diff_window_id(diff))
    } else if aux.kind.multiple() {
        format!("{}-{parent_label}-{}", aux.kind.name(), windows.aux_serial.fetch_add(1, Ordering::Relaxed))
    } else {
        format!("{}-{parent_label}", aux.kind.name())
    };
    if let Some(existing) = app.get_webview_window(&label) {
        if aux.kind != AuxKind::Diff && aux.launch != Launch::default() {
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
    #[cfg(target_os = "macos")]
    let macos_geom = aux_geometry_for(app, &windows, aux.kind, aux.size, aux.min_size);
    #[cfg(target_os = "macos")]
    {
        (config.width, config.height) = (macos_geom.width, macos_geom.height);
    }
    #[cfg(not(target_os = "macos"))]
    {
        (config.width, config.height) = aux.size;
    }
    (config.min_width, config.min_height) = (Some(aux.min_size.0), Some(aux.min_size.1));
    config.center = false;
    config.visible = false;
    config.maximized = false;
    config.fullscreen = false;
    config.drag_drop_enabled = false;
    // Paint the theme's frame colour before the page loads.
    if let Some(color) =
        aux.background.as_deref().and_then(hex_color).or_else(|| default_aux_frame_color(app, &parent, &parent_label))
    {
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
    #[cfg(target_os = "macos")]
    crate::page_swipe::install(&window);
    apply_zoom(app, &window);
    #[cfg(target_os = "macos")]
    align_titlebar(app, &window, false);
    // Fit size and position to the parent's current display before showing.
    #[cfg(target_os = "macos")]
    {
        if let Err(e) =
            fit_over_parent(&window, &parent, (macos_geom.width, macos_geom.height), aux.min_size, macos_geom.maximized)
        {
            tracing::warn!("cannot fit {} window: {e}", aux.kind.name());
        }
        track_auxiliary_geometry(&window, aux.kind, aux.size, aux.min_size);
    }
    #[cfg(not(target_os = "macos"))]
    if let Err(e) = place_over_parent(&window, &parent) {
        tracing::warn!("cannot place {} window: {e}", aux.kind.name());
    }
    focus(&window);
    Ok(())
}

/// Effective appearance settings of project window `parent_label` (client layer on remote windows).
fn effective_appearance(app: &AppHandle, parent_label: &str) -> Option<AppearanceSettings> {
    let state = app.try_state::<AppState>()?;
    if state.remote_dev.get(parent_label).is_some() {
        return Some(state.global_settings.effective().appearance);
    }
    Some(match state.host.project(parent_label) {
        Ok(p) => p.settings.effective().appearance,
        Err(_) => state.global_settings.effective().appearance,
    })
}

fn default_aux_frame_color(app: &AppHandle, parent: &WebviewWindow, parent_label: &str) -> Option<Color> {
    let state = app.try_state::<AppState>()?;
    if let Some(color) = state.plugins.startup_frame().and_then(|c| hex_color(&c)) {
        return Some(color);
    }
    let appearance = effective_appearance(app, parent_label)?;
    let os_dark =
        (appearance.sync_with_os || appearance.theme == "system") && parent.theme().is_ok_and(|t| t == Theme::Dark);
    Some(frame_color(&appearance, os_dark))
}

/// Whether `parent_label` opens Settings in its own native window.
pub fn settings_in_separate_window(app: &AppHandle, parent_label: &str) -> bool {
    effective_appearance(app, parent_label).is_none_or(|a| a.settings_in_separate_window)
}

fn menu_settings_launch<'a>(
    target_label: &'a str,
    has_pending_launch: bool,
    separate_window: bool,
    action: &str,
    arg: Option<String>,
) -> Option<(&'a str, Option<String>, bool)> {
    let parent_label = auxiliary_parent(target_label).unwrap_or(target_label);
    if has_pending_launch || !separate_window {
        return None;
    }
    let (page, new_projects) = match action {
        "file.settings" => (arg, false),
        "file.newProjectsSettings" => (Some(arg.unwrap_or_else(|| "languages.java".into())), true),
        _ => return None,
    };
    Some((parent_label, page, new_projects))
}

/// Opens Settings directly from a native menu click when separate-window mode is enabled,
/// avoiding a round-trip through the parent window's JS thread.
pub fn open_settings_from_menu(app: &AppHandle, target: &WebviewWindow, action: &str, arg: Option<String>) -> bool {
    let parent_label = auxiliary_parent(target.label()).unwrap_or(target.label());
    let has_pending = app.state::<WindowsState>().pending(parent_label).is_some();
    let separate = settings_in_separate_window(app, parent_label);
    let Some((parent_label, page, new_projects)) =
        menu_settings_launch(target.label(), has_pending, separate, action, arg)
    else {
        return false;
    };
    let Some(parent) = app.get_webview_window(parent_label) else {
        return false;
    };
    match open_settings_window(app, &parent, page, new_projects, None) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("settings window unavailable from menu, falling back to frontend: {e}");
            false
        }
    }
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
            size: AuxKind::Settings.default_size(),
            min_size: AuxKind::Settings.min_size(),
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
            size: AuxKind::Comparison.default_size(),
            min_size: AuxKind::Comparison.min_size(),
            launch: Launch { comparison: Some(Box::new(comparison)), ..Default::default() },
            background,
        },
    )
}

fn diff_window_id(diff: &DiffLaunch) -> u64 {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    (&diff.path, &diff.left, &diff.middle, &diff.right).hash(&mut hasher);
    hasher.finish()
}

/// Opens a window showing one diff of the project ("Show Diff in New Window"), like IDEA's
/// diff window next to the Commit tool window.
pub fn open_diff_window(
    app: &AppHandle,
    parent: &WebviewWindow,
    diff: DiffLaunch,
    background: Option<String>,
) -> IdeResult<()> {
    open_auxiliary_window(
        app,
        parent,
        AuxWindow {
            kind: AuxKind::Diff,
            title: "Diff",
            size: AuxKind::Diff.default_size(),
            min_size: AuxKind::Diff.min_size(),
            launch: Launch { diff_window: Some(Box::new(diff)), ..Default::default() },
            background,
        },
    )
}

/// Opens a lightweight editor window for `editor.path` ("Open in New Window"), sharing the
/// parent's project documents and language servers.
pub fn open_editor_window(
    app: &AppHandle,
    parent: &WebviewWindow,
    editor: EditorLaunch,
    background: Option<String>,
) -> IdeResult<()> {
    open_auxiliary_window(
        app,
        parent,
        AuxWindow {
            kind: AuxKind::Editor,
            title: "Editor",
            size: AuxKind::Editor.default_size(),
            min_size: AuxKind::Editor.min_size(),
            launch: Launch { editor: Some(Box::new(editor)), ..Default::default() },
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
            size: AuxKind::Deployment.default_size(),
            min_size: AuxKind::Deployment.min_size(),
            launch: Launch { deployment: Some(DeploymentLaunch { server, paths }), ..Default::default() },
            background,
        },
    )
}

#[cfg(any(target_os = "macos", test))]
fn resolve_aux_geometry(saved: Option<AuxGeometry>, default_size: (f64, f64), min_size: (f64, f64)) -> AuxGeometry {
    match saved.filter(|g| g.width.is_finite() && g.height.is_finite() && g.width > 0.0 && g.height > 0.0) {
        Some(g) => {
            AuxGeometry { width: g.width.max(min_size.0), height: g.height.max(min_size.1), maximized: g.maximized }
        }
        None => AuxGeometry {
            width: default_size.0.max(min_size.0),
            height: default_size.1.max(min_size.1),
            maximized: false,
        },
    }
}

#[cfg(target_os = "macos")]
fn aux_state_path(app: &AppHandle) -> Option<PathBuf> {
    ide_host::data_dirs::config_dir(&app.config().identifier).ok().map(|dir| dir.join(AUX_STATE_FILE))
}

#[cfg(target_os = "macos")]
fn load_aux_geometry_map(path: &Path) -> HashMap<String, AuxGeometry> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, AuxGeometry>>(&bytes).ok())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn aux_geometry_for(
    app: &AppHandle,
    windows: &WindowsState,
    kind: AuxKind,
    default_size: (f64, f64),
    min_size: (f64, f64),
) -> AuxGeometry {
    let mut guard = windows.aux_geometry.lock();
    let map = guard.get_or_insert_with(|| aux_state_path(app).map_or_else(HashMap::new, |p| load_aux_geometry_map(&p)));
    resolve_aux_geometry(map.get(kind.name()).copied(), default_size, min_size)
}

#[cfg(target_os = "macos")]
pub fn flush_auxiliary_geometry(app: &AppHandle) {
    let Some(path) = aux_state_path(app) else { return };
    let Some(snapshot) = app.try_state::<WindowsState>().and_then(|w| w.aux_geometry.lock().clone()) else {
        return;
    };
    if let Ok(bytes) = serde_json::to_vec_pretty(&snapshot) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = ide_vfs::write_atomic(&path, &bytes);
    }
}

#[cfg(target_os = "macos")]
fn same_cocoa_frame(a: objc2_foundation::NSRect, b: objc2_foundation::NSRect) -> bool {
    (a.origin.x - b.origin.x).abs() <= 2.0
        && (a.origin.y - b.origin.y).abs() <= 2.0
        && (a.size.width - b.size.width).abs() <= 2.0
        && (a.size.height - b.size.height).abs() <= 2.0
}

#[cfg(target_os = "macos")]
fn track_auxiliary_geometry(window: &WebviewWindow, kind: AuxKind, default_size: (f64, f64), min_size: (f64, f64)) {
    let tracked = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(_) => {
            if objc2::MainThreadMarker::new().is_none() {
                return;
            }
            let Ok(ptr) = tracked.ns_window() else { return };
            let ns_win = unsafe { &*ptr.cast::<objc2_app_kit::NSWindow>() };
            if !ns_win.isVisible()
                || ns_win.isMiniaturized()
                || ns_win.styleMask().contains(objc2_app_kit::NSWindowStyleMask::FullScreen)
            {
                return;
            }
            let frame = ns_win.frame();
            let content = ns_win.contentRectForFrameRect(frame);
            let maximized = ns_win.screen().is_some_and(|s| same_cocoa_frame(frame, s.visibleFrame()));
            let Some(state) = tracked.try_state::<WindowsState>() else { return };
            let mut guard = state.aux_geometry.lock();
            let map = guard.get_or_insert_with(|| {
                aux_state_path(tracked.app_handle()).map_or_else(HashMap::new, |p| load_aux_geometry_map(&p))
            });
            let entry = map.entry(kind.name().to_owned()).or_insert(AuxGeometry {
                width: default_size.0.max(min_size.0),
                height: default_size.1.max(min_size.1),
                maximized: false,
            });
            entry.maximized = maximized;
            if !maximized && content.size.width >= min_size.0 && content.size.height >= min_size.1 {
                entry.width = content.size.width;
                entry.height = content.size.height;
            }
        }
        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
            let app = tracked.app_handle().clone();
            let Some(path) = aux_state_path(&app) else { return };
            let Some(snapshot) = app.try_state::<WindowsState>().and_then(|w| w.aux_geometry.lock().clone()) else {
                return;
            };
            std::mem::drop(tauri::async_runtime::spawn_blocking(move || {
                if let Ok(bytes) = serde_json::to_vec_pretty(&snapshot) {
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = ide_vfs::write_atomic(&path, &bytes);
                }
            }));
        }
        _ => {}
    });
}

/// Fit outer bounds in AppKit's global bottom-left point space, centred over `parent` inside
/// `visible` (`NSScreen::visibleFrame`) and clamped to `[min_size, visible]`.
#[cfg(any(target_os = "macos", test))]
fn cocoa_fit_bounds(
    parent: (f64, f64, f64, f64),
    size: (f64, f64),
    min_size: (f64, f64),
    visible: (f64, f64, f64, f64),
) -> (f64, f64, f64, f64) {
    let parent_td = (parent.0, -(parent.1 + parent.3), parent.2, parent.3);
    let work_td = (visible.0, -(visible.1 + visible.3), visible.2, visible.3);
    let fitted = fit_bounds(parent_td, size, min_size, work_td);
    (fitted.0, -(fitted.1 + fitted.3), fitted.2, fitted.3)
}

/// Synchronously fits and centres `window` over `parent` on `parent`'s `NSScreen` in AppKit
/// logical points, avoiding `tao`'s async main-queue position/size race across mixed-DPI displays.
#[cfg(target_os = "macos")]
fn fit_over_parent(
    window: &WebviewWindow,
    parent: &WebviewWindow,
    desired_size: (f64, f64),
    min_size: (f64, f64),
    maximized: bool,
) -> tauri::Result<()> {
    let target = window.clone();
    let owner = parent.clone();
    let apply = move || {
        let mtm = objc2::MainThreadMarker::new().expect("AppKit main thread");
        let (Ok(win_ptr), Ok(parent_ptr)) = (target.ns_window(), owner.ns_window()) else {
            return;
        };
        let win_ns = unsafe { &*win_ptr.cast::<objc2_app_kit::NSWindow>() };
        let parent_ns = unsafe { &*parent_ptr.cast::<objc2_app_kit::NSWindow>() };
        let Some(screen) = parent_ns.screen().or_else(|| objc2_app_kit::NSScreen::mainScreen(mtm)) else {
            return;
        };
        let visible = screen.visibleFrame();
        let parent_frame = parent_ns.frame();
        let win_frame = win_ns.frame();
        let content = win_ns.contentRectForFrameRect(win_frame);
        let frame = (
            (win_frame.size.width - content.size.width).max(0.0),
            (win_frame.size.height - content.size.height).max(0.0),
        );
        let bounds = if maximized {
            (visible.origin.x, visible.origin.y, visible.size.width, visible.size.height)
        } else {
            cocoa_fit_bounds(
                (parent_frame.origin.x, parent_frame.origin.y, parent_frame.size.width, parent_frame.size.height),
                (desired_size.0 + frame.0, desired_size.1 + frame.1),
                (min_size.0 + frame.0, min_size.1 + frame.1),
                (visible.origin.x, visible.origin.y, visible.size.width, visible.size.height),
            )
        };
        win_ns.setContentMinSize(objc2_foundation::NSSize::new(
            min_size.0.min((visible.size.width - frame.0).max(1.0)),
            min_size.1.min((visible.size.height - frame.1).max(1.0)),
        ));
        win_ns.setFrame_display(
            objc2_foundation::NSRect::new(
                objc2_foundation::NSPoint::new(bounds.0, bounds.1),
                objc2_foundation::NSSize::new(bounds.2.max(1.0), bounds.3.max(1.0)),
            ),
            false,
        );
    };
    if objc2::MainThreadMarker::new().is_some() {
        apply();
        return Ok(());
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window.run_on_main_thread(move || {
        apply();
        let _ = tx.send(());
    })?;
    // A stopped event loop never runs the closure: don't block this thread forever.
    rx.recv_timeout(FIT_ON_MAIN_TIMEOUT).map_err(|_| tauri::Error::FailedToReceiveMessage)
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
    let minimum = auxiliary(window.label()).map_or(SETTINGS_MIN_SIZE, |(kind, _)| kind.min_size());
    let bounds = fit_bounds(
        (pos.x, pos.y, size.width, size.height),
        (own.width, own.height),
        (minimum.0 + frame.0, minimum.1 + frame.1),
        (origin.x, origin.y, available.width, available.height),
    );
    window.set_position(tauri::PhysicalPosition::new(
        (bounds.0 * scale).round() as i32,
        (bounds.1 * scale).round() as i32,
    ))?;
    if (bounds.2, bounds.3) != (own.width, own.height) {
        // Sizes are set on the client area, and even an undecorated window has a resize frame.
        let (width, height) = ((bounds.2 - frame.0).max(1.0), (bounds.3 - frame.1).max(1.0));
        window.set_min_size(Some(tauri::LogicalSize::new(minimum.0.min(width), minimum.1.min(height))))?;
        window.set_size(tauri::LogicalSize::new(width, height))?;
    }
    if maximized {
        window.maximize()?;
    }
    Ok(())
}

fn fit_bounds(
    parent: (f64, f64, f64, f64),
    size: (f64, f64),
    min_size: (f64, f64),
    work: (f64, f64, f64, f64),
) -> (f64, f64, f64, f64) {
    let width = size.0.max(min_size.0).min(work.2);
    let height = size.1.max(min_size.1).min(work.3);
    let at = centered(parent.0, parent.1, parent.2, parent.3, width, height);
    (
        work.0 + (at.0 - work.0).clamp(0.0, (work.2 - width).max(0.0)),
        work.1 + (at.1 - work.1).clamp(0.0, (work.3 - height).max(0.0)),
        width,
        height,
    )
}

/// Top-left corner that centres a `w`×`h` window over the parent rectangle
/// (never above the parent's top edge, so the title bar stays reachable).
fn centered(px: f64, py: f64, pw: f64, ph: f64, w: f64, h: f64) -> (f64, f64) {
    (px + (pw - w) / 2.0, py + ((ph - h) / 2.0).max(0.0))
}

/// A link in an embedded page that asks for a new window (Flutter DevTools' documentation links)
/// opens in the system browser; the IDE itself never needs such a window.
fn open_popup_in_browser<R: tauri::Runtime>(
    url: tauri::Url,
    _features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<R> {
    if matches!(url.scheme(), "http" | "https")
        && let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
    {
        tracing::warn!("cannot open {url}: {e}");
    }
    tauri::webview::NewWindowResponse::Deny
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

    #[test]
    fn diff_window_identity_keeps_revisions_distinct_and_ignores_reveal_line() {
        let mut diff = DiffLaunch {
            path: "/p/a.txt".into(),
            left: DiffSide::Rev { rev: "HEAD".into(), path: None, label: None },
            middle: None,
            right: DiffSide::Worktree { label: None, label_detail: None },
            line: None,
            line_side: None,
            col: None,
            chain: None,
        };
        let id = diff_window_id(&diff);
        diff.line = Some(12);
        assert_eq!(diff_window_id(&diff), id);
        diff.middle = Some(DiffSide::Rev { rev: ":0".into(), path: None, label: None });
        assert_ne!(diff_window_id(&diff), id);
        diff.middle = None;
        diff.right = DiffSide::Rev { rev: ":0".into(), path: None, label: None };
        assert_ne!(diff_window_id(&diff), id);
        diff.path = "/p/b.txt".into();
        assert_ne!(diff_window_id(&diff), id);
    }

    #[test]
    fn diff_window_keeps_file_and_selection_label_details() {
        for side in [
            serde_json::json!({"type": "worktree", "label": "file.rs", "labelDetail": "src"}),
            serde_json::json!({"type": "text", "text": "let x = 1;", "label": "Selection from file.rs", "labelDetail": ""}),
            serde_json::json!({"type": "text", "text": "let x = 2;", "label": "From Clipboard"}),
        ] {
            let parsed = serde_json::from_value::<DiffSide>(side.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), side);
        }
    }

    #[test]
    fn a_project_window_starts_with_the_header_its_page_draws() {
        let mut a = AppearanceSettings::default();
        assert_eq!(initial_titlebar_height(&a, true), 40.0);
        a.compact_mode = true;
        assert_eq!(initial_titlebar_height(&a, true), 32.0);
        a.show_main_toolbar = false;
        assert_eq!(initial_titlebar_height(&a, true), 30.0);
        // Welcome, Settings and a window whose project comes later keep the full bar.
        assert_eq!(initial_titlebar_height(&a, false), 32.0);
        a.zoom = 150;
        assert_eq!(initial_titlebar_height(&a, true), 45.0);
    }

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
        for (id, color) in
            [("solarized-light", Color(0xee, 0xe8, 0xd5, 0xff)), ("solarized-dark", Color(0x07, 0x36, 0x42, 0xff))]
        {
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
    fn cli_launch_keeps_diff_pairs_and_single_file_fallback() {
        let cwd = Path::new("/work");
        for args in
            [vec!["openidea", "diff", "a.txt", "b.txt"], vec!["openidea", "diff", "--line", "3", "a.txt", "b.txt"]]
        {
            let launch = cli_launch(&s(&args), cwd).unwrap().unwrap();
            assert_eq!(
                launch.diff,
                Some(Box::new(DiffFilesLaunch { left: "/work/a.txt".into(), right: "/work/b.txt".into() }))
            );
            assert!(launch.files.is_empty());
        }
        let launch = cli_launch(&s(&["openidea", "diff", "/abs/my a.txt", "my b.txt"]), cwd).unwrap().unwrap();
        assert_eq!(
            launch.diff,
            Some(Box::new(DiffFilesLaunch { left: "/abs/my a.txt".into(), right: "/work/my b.txt".into() }))
        );
        let launch = cli_launch(&s(&["openidea", "diff", "a.txt", "--line=3"]), cwd).unwrap().unwrap();
        assert_eq!(launch.files, [ide_core::IpcPath::from("/work/a.txt")]);
        assert_eq!(launch.positions, [FilePosition { path: "/work/a.txt".into(), line: 2, column: 0 }]);
        assert!(launch.diff.is_none());
        assert_eq!(cli_launch(&s(&["openidea", "diff"]), cwd).unwrap(), None);
        assert_eq!(cli_path(&s(&["openidea", "proj", "diff", "a.txt"]), cwd), Some(PathBuf::from("/work/proj")));
    }

    #[test]
    fn installed_command_positions_follow_canonical_file_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let first = root.join("first.cs");
        let second = root.join("second.cs");
        std::fs::write(&first, "").unwrap();
        std::fs::write(&second, "").unwrap();
        let targets = vec![
            ide_cli::Target { path: root.join("./first.cs"), line: Some(12), column: Some(5) },
            ide_cli::Target { path: second.clone(), line: Some(3), column: None },
            ide_cli::Target { path: root, line: Some(9), column: Some(2) },
            ide_cli::Target { path: first.clone(), line: None, column: None },
        ];
        let positions = target_positions(&targets);
        assert_eq!(
            positions,
            [
                FilePosition { path: first.clone().into(), line: 11, column: 4 },
                FilePosition { path: second.clone().into(), line: 2, column: 0 },
            ]
        );
        let state = WindowsState::default();
        state.add_files_at("main", vec![first], &positions);
        state.add_files_at("project-1", vec![second], &positions);
        assert_eq!(state.take_launch("main").unwrap().positions, positions[..1]);
        assert_eq!(state.take_launch("project-1").unwrap().positions, positions[1..]);
    }

    #[test]
    fn diff_and_file_requests_keep_each_others_pending_data() {
        let state = WindowsState::default();
        let diff = DiffFilesLaunch { left: "/a.txt".into(), right: "/b.txt".into() };
        let position = FilePosition { path: "/project/a.cs".into(), line: 8, column: 2 };
        for diff_first in [true, false] {
            state.set_launch("main", path_launch_of(Some(p("/project")), vec![]));
            if diff_first {
                state.add_diff("main", diff.clone());
            }
            state.add_files_at("main", vec![p("/project/a.cs")], std::slice::from_ref(&position));
            if !diff_first {
                state.add_diff("main", diff.clone());
            }
            let launch = state.take_launch("main").unwrap();
            assert_eq!(launch.project, Some("/project".into()));
            assert_eq!(launch.files, [ide_core::IpcPath::from("/project/a.cs")]);
            assert_eq!(launch.positions, std::slice::from_ref(&position));
            assert_eq!(launch.diff, Some(Box::new(diff.clone())));
            assert_eq!(launch.diff_before_files, diff_first);
            state.complete_launch("main");
        }
        state.add_diff("main", diff.clone());
        state.add_files_at("main", vec![], &[]);
        assert!(!state.pending("main").unwrap().diff_before_files);
        state.add_files_at("main", vec![p("/project/a.cs")], &[]);
        assert!(state.pending("main").unwrap().diff_before_files);
        state.add_diff("main", diff);
        assert!(!state.take_launch("main").unwrap().diff_before_files);
    }

    #[test]
    fn a_launch_carries_the_positions_of_its_files() {
        let st = WindowsState::default();
        let file = std::env::current_exe().unwrap();
        let other = std::env::temp_dir().join("openidea-not-opened.txt");
        st.add_files_at(
            "main",
            vec![file.clone()],
            &[
                FilePosition { path: file.clone().into(), line: 11, column: 4 },
                FilePosition { path: other.into(), line: 1, column: 0 },
            ],
        );
        let launch = st.take_launch("main").unwrap();
        assert_eq!(launch.positions, vec![FilePosition { path: file.into(), line: 11, column: 4 }]);
        // Taken once: the next launch of that file opens it where it was.
        st.add_files_at("main", vec![std::env::current_exe().unwrap()], &[]);
        assert!(st.take_launch("main").unwrap().positions.is_empty());
    }

    #[test]
    fn later_positions_replace_an_unconsumed_cold_launch_position() {
        let st = WindowsState::default();
        let file = std::env::current_exe().unwrap();
        st.set_launch(
            "main",
            Launch {
                files: vec![file.clone().into()],
                positions: vec![FilePosition { path: file.clone().into(), line: 1, column: 0 }],
                ..Default::default()
            },
        );
        st.add_files_at("main", vec![file.clone()], &[FilePosition { path: file.clone().into(), line: 9, column: 3 }]);
        let launch = st.take_launch("main").unwrap();
        assert_eq!(launch.positions, vec![FilePosition { path: file.into(), line: 9, column: 3 }]);
    }

    #[test]
    fn windows_keep_independent_positions_for_the_same_external_file() {
        let st = WindowsState::default();
        let file = std::env::temp_dir().join("shared-package/Type.cs");
        let first = FilePosition { path: file.clone().into(), line: 11, column: 4 };
        let second = FilePosition { path: file.clone().into(), line: 33, column: 8 };
        st.set_launch(
            "main",
            Launch {
                project: Some("/project-a".into()),
                files: vec![file.clone().into()],
                positions: vec![first.clone()],
                ..Default::default()
            },
        );
        st.set_launch("project-1", Launch { project: Some("/project-b".into()), ..Default::default() });
        st.add_files_at("project-1", vec![file.clone()], std::slice::from_ref(&second));
        let launch = st.take_launch("main").unwrap();
        assert_eq!(launch.project, Some("/project-a".into()));
        assert_eq!(launch.positions, vec![first]);
        let launch = st.take_launch("project-1").unwrap();
        assert_eq!(launch.project, Some("/project-b".into()));
        assert_eq!(launch.positions, vec![second]);
        st.add_files_at("main", vec![file], &[]);
        assert!(st.take_launch("main").unwrap().positions.is_empty());
    }

    #[test]
    fn external_open_has_an_explicit_project_and_validates_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let project = root.join("Game with spaces");
        std::fs::create_dir_all(project.join("Assets")).unwrap();
        let file = project.join("Assets/角色.cs");
        std::fs::write(&file, "class Player {}\n").unwrap();
        let args = s(&["openidea", project.to_str().unwrap(), "--file", "Assets/角色.cs", "--line=12", "--column=5"]);
        let launch = cli_launch(&args, &root).unwrap().unwrap();
        assert_eq!(launch.project, Some(project.clone().into()));
        assert_eq!(launch.files, [ide_core::IpcPath::from(file.clone())]);
        assert_eq!(launch.positions, [FilePosition { path: file.into(), line: 11, column: 4 }]);
        assert!(cli_launch(&s(&["openidea", "--file", project.to_str().unwrap()]), &root).is_err());
        assert!(cli_launch(&s(&["openidea", "--file", "missing.cs"]), &root).is_err());
        assert!(cli_launch(&s(&["openidea", "--file", "--line", "2"]), &root).is_err());
    }

    #[test]
    fn explicit_project_routes_external_files_to_the_requested_window() {
        let project = PathBuf::from("/game");
        let file = PathBuf::from("/package-cache/Package.cs");
        let launch = || path_launch_of(Some(project.clone()), vec![file.clone()]);
        let windows = vec![
            ("main".into(), Holds::Project(PathBuf::from("/package-cache"))),
            ("project-1".into(), Holds::Project(project.clone())),
        ];
        assert_eq!(plan_cli_launch(launch(), &windows), vec![OpenStep::Files("project-1".into(), vec![file.clone()])]);
        assert_eq!(plan_cli_launch(launch(), &[]), vec![OpenStep::New(Some(project.clone()), vec![file.clone()])]);
        assert_eq!(
            plan_cli_launch(launch(), &[("main".into(), Holds::Nothing)]),
            vec![OpenStep::Launch("main".into(), Box::new(launch()))]
        );
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
        assert_eq!((folder.remote, folder.project, folder.files.len()), (Some(remote.clone()), None, 0));
        let file = launch_for(share.join("main.py"), false);
        assert_eq!((file.remote, file.project, file.files.len()), (None, None, 1));
    }

    #[test]
    fn a_saved_wsl_project_reopens_as_a_remote_launch_without_the_share() {
        let remote =
            RemoteLaunch { target: RemoteTarget::Wsl { distro: "Ubuntu".into() }, path: "/home/me/app".into() };
        for saved in [r"\\wsl.localhost\Ubuntu\home\me\app", "wsl://Ubuntu/home/me/app", "//wsl$/Ubuntu/home/me/app"] {
            let launch = saved_project_launch(Path::new(saved)).expect(saved);
            assert_eq!(launch.remote, Some(remote.clone()));
            assert!(launch.project.is_none(), "{saved}");
        }
        assert!(same_saved_project(
            Path::new(r"\\wsl.localhost\Ubuntu\home\me\app"),
            Path::new("wsl://Ubuntu/home/me/app/")
        ));
        let ssh = saved_project_launch(Path::new("ssh://box/srv/app")).unwrap();
        assert_eq!(
            ssh.remote,
            Some(RemoteLaunch { target: RemoteTarget::Ssh { config: "box".into() }, path: "/srv/app".into() })
        );
        let container =
            saved_project_launch(Path::new("devcontainer://%2Fwork%2Fapp:devcontainer.json/workspaces/app")).unwrap();
        assert_eq!(
            container.remote,
            Some(RemoteLaunch {
                target: RemoteTarget::DevContainer { folder: "/work/app".into(), config: "devcontainer.json".into() },
                path: "/workspaces/app".into(),
            })
        );
        assert!(saved_project_launch(Path::new("/no/such/local/project-openidea")).is_none());
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
        assert_eq!(
            files,
            [OpenStep::Launch("main".into(), Box::new(path_launch_of(None, vec![p("/x/a.txt"), p("/y/b.rs")])))]
        );
        let dir = plan_open(vec![(p("/proj"), true)], &main);
        assert_eq!(dir, [OpenStep::Launch("main".into(), Box::new(path_launch_of(Some(p("/proj")), Vec::new())))]);
        // Folder and files: the folder takes the first window, the files a new LightEdit one.
        let both = plan_open(vec![(p("/x/a.txt"), false), (p("/proj"), true)], &main);
        assert_eq!(
            both,
            [
                OpenStep::Launch("main".into(), Box::new(path_launch_of(Some(p("/proj")), Vec::new()))),
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
        st.add_files_at("main", vec![p("/x/b.txt")], &[]);
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
                // `/projects` is not inside `/proj`; loose files join the focused project window.
                OpenStep::Files(
                    "main".into(),
                    vec![p("/proj/src/a.rs"), p("/proj/e.rs"), p("/x/b.txt"), p("/projects/d.rs")],
                ),
                // The deepest root wins.
                OpenStep::Files("project-2".into(), vec![p("/proj/sub/c.rs")]),
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
                OpenStep::Launch("project-1".into(), Box::new(path_launch_of(Some(p("/b")), vec![p("/b/y.rs")]))),
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
        let launch = Box::new(Launch { remote: Some(remote.clone()), ..Default::default() });
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
        let welcome_only = [w("main", Holds::Nothing), w("project-2", Holds::Nothing), w("project-3", Holds::Other)];
        // With no local project or LightEdit window, the Welcome window turns into LightEdit itself.
        let (steps, here) = plan_open_files("main", vec![p("/x/b.txt")], &welcome_only);
        assert!(steps.is_empty());
        assert_eq!(here, [p("/x/b.txt")]);
        // A LightEdit window keeps loose files, even with another one open.
        let files = vec![p("/proj/src/a.rs"), p("/x/b.txt")];
        let light =
            [w("main", Holds::LightEdit), w("project-1", Holds::Project(p("/proj"))), w("project-2", Holds::LightEdit)];
        let (steps, here) = plan_open_files("main", files.clone(), &light);
        assert_eq!(steps, [OpenStep::Files("project-1".into(), vec![p("/proj/src/a.rs")])]);
        assert_eq!(here, [p("/x/b.txt")]);
        // An existing LightEdit window takes them from a Welcome window.
        let others = [w("main", Holds::Nothing), w("project-2", Holds::LightEdit)];
        let (steps, here) = plan_open_files("main", vec![p("/x/b.txt")], &others);
        assert_eq!((steps, here), (vec![OpenStep::Files("project-2".into(), vec![p("/x/b.txt")])], vec![]));
        // A project window in the background doesn't take them from a Welcome window.
        let with_proj = [
            w("main", Holds::Nothing),
            w("project-1", Holds::Project(p("/proj"))),
            w("project-2", Holds::Nothing),
            w("project-3", Holds::Other),
        ];
        let (steps, here) = plan_open_files("main", files.clone(), &with_proj);
        assert_eq!(steps, [OpenStep::Files("project-1".into(), vec![p("/proj/src/a.rs")])]);
        assert_eq!(here, [p("/x/b.txt")]);
        // A remote project window gets a new LightEdit window, never a free one or its own.
        let remote =
            [w("project-3", Holds::Other), w("main", Holds::Nothing), w("project-1", Holds::Project(p("/proj")))];
        let (steps, here) = plan_open_files("project-3", files, &remote);
        assert_eq!(
            steps,
            [OpenStep::Files("project-1".into(), vec![p("/proj/src/a.rs")]), OpenStep::New(None, vec![p("/x/b.txt")])]
        );
        assert!(here.is_empty());
    }

    #[test]
    fn files_opened_while_running_join_the_focused_window_else_a_free_one_else_a_new_one() {
        // The focused local project window takes them, even with a LightEdit window open.
        let project =
            [w("main", Holds::Project(p("/proj"))), w("project-1", Holds::Nothing), w("project-2", Holds::LightEdit)];
        assert_eq!(
            plan_open(vec![(p("/x/a.txt"), false)], &project),
            [OpenStep::Files("main".into(), vec![p("/x/a.txt")])]
        );
        // A project window in the background doesn't.
        let free =
            [w("main", Holds::Other), w("project-2", Holds::Project(p("/proj"))), w("project-1", Holds::Nothing)];
        assert_eq!(
            plan_open(vec![(p("/x/a.txt"), false)], &free),
            [OpenStep::Launch("project-1".into(), Box::new(path_launch_of(None, vec![p("/x/a.txt")])))]
        );
        let busy = [w("main", Holds::Other)];
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
    fn editor_launch_survives_webview_reload_until_window_closes() {
        let st = WindowsState::default();
        let launch = Launch {
            editor: Some(Box::new(EditorLaunch {
                path: None,
                input: Some(r#"{"kind":"agent-session","key":"agent:running-task"}"#.into()),
                line: None,
                column: None,
                end_line: None,
                end_column: None,
            })),
            ..Default::default()
        };
        st.set_launch("editor-main-3", launch.clone());
        assert_eq!(st.take_launch("editor-main-3"), Some(launch.clone()));
        assert_eq!(st.take_launch("editor-main-3"), Some(launch));
        st.forget("editor-main-3");
        assert!(st.take_launch("editor-main-3").is_none());
    }

    #[test]
    fn a_taken_launch_owns_its_window_until_completion() {
        for launch in [
            path_launch_of(Some(p("/project")), vec![p("/project/a.cs")]),
            path_launch_of(None, vec![p("/loose/a.cs")]),
            Launch {
                diff: Some(Box::new(DiffFilesLaunch { left: "/a.txt".into(), right: "/b.txt".into() })),
                ..Default::default()
            },
            Launch {
                remote: Some(RemoteLaunch {
                    target: RemoteTarget::Wsl { distro: "Ubuntu".into() },
                    path: "/project".into(),
                }),
                ..Default::default()
            },
        ] {
            let st = WindowsState::default();
            let expected = pending_holds(Some(&launch));
            st.set_launch("main", launch.clone());
            assert_eq!(st.take_launch("main"), Some(launch));
            assert!(st.take_launch("main").is_none());
            assert_eq!(pending_holds(st.pending("main").as_ref()), expected);
            let windows = vec![("main".into(), pending_holds(st.pending("main").as_ref()))];
            assert_eq!(
                plan_open(vec![(p("/other-project"), true)], &windows),
                vec![OpenStep::New(Some(p("/other-project")), vec![])]
            );
            st.complete_launch("main");
            assert_eq!(pending_holds(st.pending("main").as_ref()), Holds::Nothing);
        }
    }

    #[test]
    fn completing_a_launch_keeps_later_requests_and_forgetting_clears_both() {
        let st = WindowsState::default();
        st.set_launch("main", path_launch_of(Some(p("/project")), vec![]));
        st.take_launch("main").unwrap();
        st.add_files_at("main", vec![p("/project/late.cs")], &[]);
        assert_eq!(pending_holds(st.pending("main").as_ref()), Holds::Project(p("/project")));
        st.complete_launch("main");
        let late = st.take_launch("main").unwrap();
        assert_eq!(late.files, [ide_core::IpcPath::from(p("/project/late.cs"))]);
        st.add_files_at("main", vec![p("/project/later.cs")], &[]);
        st.forget("main");
        assert!(st.pending("main").is_none());
        assert!(st.take_launch("main").is_none());
    }

    #[test]
    fn auxiliary_windows_map_to_their_parent() {
        assert_eq!(settings_label("project-2"), "settings-project-2");
        assert_eq!(auxiliary("settings-main"), Some((AuxKind::Settings, "main")));
        assert_eq!(auxiliary("comparison-project-2-14"), Some((AuxKind::Comparison, "project-2")));
        assert_eq!(auxiliary("diff-project-2-3"), Some((AuxKind::Diff, "project-2")));
        assert_eq!(auxiliary("editor-project-2-3"), Some((AuxKind::Editor, "project-2")));
        assert_eq!(auxiliary("deployment-project-2"), Some((AuxKind::Deployment, "project-2")));
        for label in ["main", "project-1", "comparison-main", "comparison-main-x", "settings-", "settingsmain"] {
            assert_eq!(auxiliary(label), None, "{label}");
        }
        assert_eq!(state_key("comparison-main-3"), "comparison");
        assert_eq!(state_key("diff-main-3"), "diff");
        assert_eq!(state_key("editor-main-3"), "editor");
        assert_eq!(state_key("project-3"), "project-3");
        let labels = [
            "comparison-main-0",
            "diff-main-1",
            "editor-main-2",
            "project-2",
            "main",
            "settings-main",
            "deployment-project-2",
        ];
        assert_eq!(sorted_labels(labels.into_iter().filter(|l| auxiliary_parent(l).is_none())), ["main", "project-2"]);
    }

    #[test]
    fn menu_items_chosen_in_settings_run_in_its_project_window() {
        use MenuDestination::*;
        for (label, action, expected) in [
            ("main", "app.about", Own),
            ("main", "editor.closeTab", Own),
            // #3625: Settings has no actions of its own; the rest of the menu runs in the project window.
            ("settings-main", "app.checkForUpdates", Parent { label: "main", raise: true }),
            ("settings-project-2", "file.newFile", Parent { label: "project-2", raise: true }),
            ("settings-main", "editor.closeTab", Parent { label: "main", raise: true }),
            ("settings-main", "file.settings", Parent { label: "main", raise: false }),
            ("settings-main", "app.quit", Parent { label: "main", raise: false }),
            ("comparison-main-0", "app.quit", Parent { label: "main", raise: false }),
            ("comparison-main-0", "editor.closeTab", Close),
            ("diff-main-1", "vcs.diff.next", Own),
            ("deployment-main", "app.about", Own),
        ] {
            assert_eq!(menu_destination(label, action), expected, "{label} {action}");
        }
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
            // Restored geometry shrunk below minimum size (e.g. from a lower-DPI monitor) clamps up to min_size.
            ((100.0, 60.0, 1440.0, 900.0), (350.0, 177.0), (0.0, 0.0, 1728.0, 1080.0), (370.0, 160.0, 900.0, 700.0)),
        ] {
            assert_eq!(fit_bounds(parent, size, SETTINGS_MIN_SIZE, work), expected);
        }
    }

    #[test]
    fn macos_auxiliary_windows_bypass_physical_window_state_and_clamp_cocoa_bounds() {
        assert!(keeps_window_state("main"));
        assert!(keeps_window_state("project-2"));
        for label in [
            "settings",
            "comparison",
            "diff",
            "deployment",
            "settings-main",
            "comparison-project-2-0",
            "diff-main-9",
            "deployment-main",
        ] {
            assert!(!keeps_window_state(label), "{label} must not use physical window-state");
        }

        // Undersized or invalid saved auxiliary geometry clamps up to min_size.
        assert_eq!(
            resolve_aux_geometry(
                Some(AuxGeometry { width: 350.0, height: 177.0, maximized: false }),
                SETTINGS_SIZE,
                SETTINGS_MIN_SIZE,
            ),
            AuxGeometry { width: 900.0, height: 700.0, maximized: false },
        );
        assert_eq!(
            resolve_aux_geometry(None, SETTINGS_SIZE, SETTINGS_MIN_SIZE),
            AuxGeometry { width: 980.0, height: 720.0, maximized: false },
        );
        assert_eq!(
            resolve_aux_geometry(
                Some(AuxGeometry { width: 1180.0, height: 820.0, maximized: true }),
                SETTINGS_SIZE,
                SETTINGS_MIN_SIZE,
            ),
            AuxGeometry { width: 1180.0, height: 820.0, maximized: true },
        );

        // Cocoa bottom-left visibleFrame: y=50..1090 (Dock=50, menu=37 on 1127pt display),
        // parent=(100, 140, 1440, 900) -> top=1040, centre=(820, 590).
        // Settings (980×720) centres at x=330, y=590 - 360 = 230.
        assert_eq!(
            cocoa_fit_bounds(
                (100.0, 140.0, 1440.0, 900.0),
                (980.0, 720.0),
                SETTINGS_MIN_SIZE,
                (0.0, 50.0, 1728.0, 1040.0)
            ),
            (330.0, 230.0, 980.0, 720.0),
        );
        // Secondary QHD display at negative x=(-2560, 0, 2560, 1415), undersized 350×177 clamps to 900×700.
        assert_eq!(
            cocoa_fit_bounds(
                (-2200.0, 200.0, 1600.0, 1000.0),
                (350.0, 177.0),
                SETTINGS_MIN_SIZE,
                (-2560.0, 0.0, 2560.0, 1415.0),
            ),
            (-1850.0, 350.0, 900.0, 700.0),
        );
        // Taller than parent: top edge aligns with parent's top edge (y + h == 200 + 500 = 700 -> y = 0).
        assert_eq!(
            cocoa_fit_bounds(
                (0.0, 200.0, 1000.0, 500.0),
                (900.0, 700.0),
                SETTINGS_MIN_SIZE,
                (0.0, 0.0, 1728.0, 1040.0)
            ),
            (50.0, 0.0, 900.0, 700.0),
        );
    }

    #[test]
    fn settings_window_is_centred_over_parent() {
        assert_eq!(centered(100.0, 50.0, 1440.0, 900.0, 980.0, 720.0), (330.0, 140.0));
        // Taller than the parent: aligned with its top edge.
        assert_eq!(centered(0.0, 50.0, 800.0, 500.0, 600.0, 720.0), (100.0, 50.0));
    }

    #[test]
    fn menu_settings_launch_routes_to_parent_and_respects_separate_window_and_pending_launch() {
        assert_eq!(menu_settings_launch("main", false, true, "file.settings", None), Some(("main", None, false)),);
        assert_eq!(
            menu_settings_launch("diff-project-2-42", false, true, "file.settings", Some("keymap".into())),
            Some(("project-2", Some("keymap".into()), false)),
        );
        assert_eq!(
            menu_settings_launch("settings-main", false, true, "file.newProjectsSettings", None),
            Some(("main", Some("languages.java".into()), true)),
        );
        // Separate-window off, pending cold launch, or unrelated menu actions fall back to frontend dispatch.
        assert_eq!(menu_settings_launch("main", false, false, "file.settings", None), None);
        assert_eq!(menu_settings_launch("main", true, true, "file.settings", None), None);
        assert_eq!(menu_settings_launch("main", false, true, "file.openProject", None), None);
    }
}
