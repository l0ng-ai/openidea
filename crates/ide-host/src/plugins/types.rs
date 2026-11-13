//! UI-facing plugin types and the event stream.

use super::theme::ThemeDef;
use ide_extension::package::PluginIcon;
use ide_extension::{CapabilityInfo, ContributionInfo, UiContribution};
pub use ide_plugin::{
    ActionPerformed, ActionSource, EventKind, NotificationLevel, PickItem, Prompt, StatusItem, WorkbenchEvent,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

/// A line a view's `process` body printed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginOutputLine {
    pub stderr: bool,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PluginSource {
    /// Installed under `<app-data>/plugins/<id>/`.
    Installed,
    /// Loaded from `<project>/.openidea/plugins/<dir>/` while that project is open.
    Dev,
    /// A development plugin linked from any folder (`openidea-plugin link`).
    Linked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PluginStatus {
    /// Code instantiated and activated.
    Active,
    /// Has code that has not been needed yet: contributions are live, no Wasm instance.
    Inactive,
    /// No code; contributions only.
    Static,
    Disabled,
    /// Waiting for the user to confirm its permissions (project and new plugins).
    NeedsConsent,
    /// Failed to load, or failed repeatedly and was stopped for this session (see `error`).
    Failed,
    /// A plugin it requires is missing, disabled, the wrong version or cannot run
    /// (`error` says which); it starts when that is resolved.
    Blocked,
}

impl PluginStatus {
    /// Contributions are in effect.
    pub fn is_live(self) -> bool {
        matches!(self, Self::Active | Self::Inactive | Self::Static)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub homepage: Option<String>,
    pub change_notes: Option<String>,
    pub icon: Option<PluginIcon>,
    pub source: PluginSource,
    /// Package directory.
    pub path: ide_core::IpcPath,
    pub enabled: bool,
    pub status: PluginStatus,
    pub error: Option<String>,
    pub has_code: bool,
    /// Declared capabilities with risk and grant state.
    pub capabilities: Vec<CapabilityInfo>,
    /// HTTPS hosts the user allowed through `net:ask` ("always allow"),
    /// none of them declared by the manifest; each can be revoked.
    pub net_hosts: Vec<String>,
    /// What it contributes while live (point + label).
    pub contributions: Vec<ContributionInfo>,
    /// `activation` events of the manifest.
    pub activation: Vec<String>,
    /// Non-fatal problems (unsupported contribution points).
    pub warnings: Vec<String>,
    /// Statistics of this session.
    pub stats: PluginStats,
    /// The marketplace publisher whose signature the package carries (none: unsigned or untrusted).
    pub publisher: Option<String>,
    /// The version an update replaced, to roll back to.
    pub previous_version: Option<String>,
    /// `[[depends]]`, each with how it stands now.
    pub depends: Vec<DependencyInfo>,
    /// Plugins that need this one, directly or through others.
    pub dependents: Vec<DependentInfo>,
    /// `[[extension-points]]` this plugin declares while it is live.
    pub extension_points: Vec<ExtensionPointInfo>,
}

/// A plugin another one requires.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInfo {
    pub id: String,
    /// The installed plugin's name, when it is installed.
    pub name: Option<String>,
    /// The requirement as written (`^0.2`).
    pub version: Option<String>,
    pub optional: bool,
    pub state: ide_extension::DependencyState,
}

/// A plugin that needs another one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DependentInfo {
    pub id: String,
    pub name: String,
    /// Switched off by the user: disabling the plugin it needs changes nothing for it.
    pub enabled: bool,
}

/// An extension point a plugin declared.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPointInfo {
    pub id: String,
    pub description: String,
    /// Plugin ids contributing to it now.
    pub contributors: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginStats {
    pub activations: u32,
    /// Last activation (instantiate + `activate`), ms.
    pub activation_ms: f64,
    pub calls: u32,
    pub errors: u32,
    /// Slowest call, ms.
    pub max_call_ms: f64,
    /// 95th percentile of the recent calls, ms.
    pub p95_call_ms: f64,
    /// Edit-path calls whose result came too late and was dropped.
    pub slow_calls: u32,
    /// Traps (panics, budgets, permission violations); each drops the instance.
    pub crashes: u32,
    /// Instances reclaimed after being idle.
    pub reclaims: u32,
}

/// Number of declarations of one extension point.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContributionCount {
    pub point: String,
    pub count: u32,
}

/// A plugin package available for installation from a local catalog
/// directory (the samples shipped with the IDE). Not installed by listing it.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub homepage: Option<String>,
    pub change_notes: Option<String>,
    pub icon: Option<PluginIcon>,
    /// Package directory; install with `install_from_dir(path)`.
    pub path: ide_core::IpcPath,
    pub has_code: bool,
    pub capabilities: Vec<CapabilityInfo>,
    pub contributions: Vec<ContributionCount>,
    /// Why the package cannot be installed as is (e.g. its WASM is not built).
    pub problem: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTheme {
    pub plugin_id: String,
    pub theme: ThemeDef,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginsSnapshot {
    pub plugins: Vec<PluginInfo>,
    pub active_theme: Option<ActiveTheme>,
    /// UI contributions of live plugins, projected by the client.
    pub ui: Vec<UiContribution>,
}

/// A newer version of an installed plugin in the marketplace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdate {
    pub id: String,
    pub name: String,
    pub version: String,
}

/// Backend → UI notifications (Tauri event `ide://plugin`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PluginEvent {
    /// Project target registrations or remembered prompt answers changed.
    RunTargetsChanged,
    /// A window-owned operation; an empty request id queues an asynchronous run.
    #[serde(rename_all = "camelCase")]
    WindowRequest { plugin_id: String, request_id: String, request: WindowRequest },
    /// Reply to a content action in this window.
    #[serde(rename_all = "camelCase")]
    ContentTabReply { plugin_id: String, request_id: String, reply: ide_plugin::ContentTabReply },
    /// Open two texts in this window's diff viewer.
    #[serde(rename_all = "camelCase")]
    OpenDiff { plugin_id: String, diff: ide_plugin::ContentDiff, file_name: Option<String> },

    /// Plugins, their status or their contributions changed: re-fetch `plugin_list`.
    CommandsChanged,
    /// Complete replacement of one plugin's project-scoped decorations.
    #[serde(rename_all = "camelCase")]
    DecorationsChanged { plugin_id: String, sets: Vec<DecorationSet> },
    /// Open a file in the invoking window.
    EditorOpen { path: ide_core::IpcPath, selection: Option<ide_core::Range> },
    /// Change selection or scrolling only in this window's already open editor.
    EditorRanges { path: ide_core::IpcPath, ranges: Vec<ide_core::Range>, reveal: bool },
    /// A bounded output channel snapshot, or withdrawal when the plugin stops.
    #[serde(rename_all = "camelCase")]
    OutputChanged { plugin_id: String, channel: String, text: Option<String> },
    /// Reveal a read-only Output tab in the receiving window.
    #[serde(rename_all = "camelCase")]
    RevealOutput { plugin_id: String, channel: String, text: String },
    /// Execute an action through the receiving window and answer over IPC.
    #[serde(rename_all = "camelCase")]
    ExecuteCommand { request_id: String, id: String, arg: Option<String>, chain: Vec<String> },
    /// Cached document associations were disposed (reload, disable or failure).
    DocumentIndexesChanged,
    /// The routes `plugin_id` reports for the project `root` may have changed:
    /// ask `plugin_endpoints` again.
    #[serde(rename_all = "camelCase")]
    EndpointsChanged { plugin_id: String, root: ide_core::IpcPath },
    /// The marketplace offers newer versions of installed plugins (announced
    /// once per set of versions).
    UpdatesAvailable { updates: Vec<PluginUpdate> },
    #[serde(rename_all = "camelCase")]
    Notification {
        plugin_id: String,
        level: NotificationLevel,
        title: String,
        body: String,
        /// Buttons running the plugin's own commands (`ui.notify`).
        actions: Vec<ide_plugin::NotificationAction>,
    },
    /// A plugin's status bar item was set (`item`) or removed.
    #[serde(rename_all = "camelCase")]
    StatusItemChanged { plugin_id: String, id: String, item: Option<StatusItem> },
    /// An override in the receiving window; removal exposes the global item.
    #[serde(rename_all = "camelCase")]
    WindowStatusItemChanged { plugin_id: String, id: String, item: Option<StatusItem> },
    /// A plugin's context key was set (`value`: JSON text) or removed, in the
    /// emitted window (every window when the client is `None`).
    #[serde(rename_all = "camelCase")]
    ContextChanged { plugin_id: String, key: String, value: Option<String> },
    /// A plugin began a task: show it with the background tasks.
    #[serde(rename_all = "camelCase")]
    TaskStarted { plugin_id: String, task_id: String, title: String, cancellable: bool },
    #[serde(rename_all = "camelCase")]
    TaskProgress { plugin_id: String, task_id: String, done: u32, total: Option<u32>, message: Option<String> },
    #[serde(rename_all = "camelCase")]
    TaskEnded { plugin_id: String, task_id: String },
    /// The kinds of workbench events plugins want changed: re-fetch
    /// `plugin_event_kinds` (the UI reports only those).
    SubscriptionsChanged,
    /// A background WebSocket has messages ready for its owning plugin.
    #[serde(rename_all = "camelCase")]
    WebsocketReady { plugin_id: String, connection: u64 },
    #[serde(rename_all = "camelCase")]
    ThemeChanged { theme: Option<ActiveTheme> },
    /// A plugin needs capabilities the user has not granted yet (first use
    /// after migrating from 0.1): show its consent dialog.
    #[serde(rename_all = "camelCase")]
    ConsentRequested { plugin_id: String, capabilities: Vec<CapabilityInfo> },
    /// A view (or the custom editors) of a plugin must be rendered again.
    #[serde(rename_all = "camelCase")]
    ViewChanged { plugin_id: String, view: String },
    /// For the script of a view's `html` body.
    #[serde(rename_all = "camelCase")]
    ViewMessage { plugin_id: String, view: String, message: String },
    /// Open a terminal running `program` (already approved and verified).
    #[serde(rename_all = "camelCase")]
    OpenTerminal {
        plugin_id: String,
        title: String,
        program: ide_core::IpcPath,
        args: Vec<String>,
        cwd: ide_core::IpcPath,
    },
    #[serde(rename_all = "camelCase")]
    OpenLocation { plugin_id: String, path: ide_core::IpcPath, line: u32, column: u32 },
    /// Open (or focus) the log tab `key` following `log` (`views.open-log-tab`);
    /// it starts the program with `plugin_log_tab_spawn`.
    #[serde(rename_all = "camelCase")]
    OpenLogTab { plugin_id: String, key: String, title: String, log: ide_plugin::ServiceLog },
    /// Plugin languages, or the servers they may start, changed: re-fetch
    /// `languages` (the host re-detects open documents: [`crate::Host::plugin_languages_changed`]).
    LanguagesChanged,
    /// Copy `text` to the system clipboard.
    #[serde(rename_all = "camelCase")]
    CopyToClipboard { plugin_id: String, text: String },
    /// Open `url` (`http(s)://`) in the system browser.
    #[serde(rename_all = "camelCase")]
    OpenUrl { plugin_id: String, url: String },
    /// A window command/event requests the normal File > Open flow.
    #[serde(rename_all = "camelCase")]
    OpenProject { plugin_id: String, path: String, new_window: bool },
    /// A command waits for the user's answer: show `prompt`, then report it with
    /// `plugin_answer_prompt(prompt_id, …)`.
    #[serde(rename_all = "camelCase")]
    PromptRequested { plugin_id: String, prompt_id: String, prompt: Prompt },
    /// The call that asked gave up (cancelled, or its plugin stopped): close the prompt.
    #[serde(rename_all = "camelCase")]
    PromptClosed { prompt_id: String },
    /// A command of this window's prompting plugin was run from another window and refused
    /// while the plugin waits for the answer here: bring this window to the front.
    #[serde(rename_all = "camelCase")]
    PromptWaiting { plugin_id: String },
    /// Bring the tool window of the plugin's view `view` to the front.
    #[serde(rename_all = "camelCase")]
    RevealView { plugin_id: String, view: String },
    /// A command needs the window's Commit view: answer with
    /// `plugin_answer_commit(request_id, …)`. Closed like a prompt (`PromptClosed`).
    #[serde(rename_all = "camelCase")]
    CommitRequested { plugin_id: String, request_id: String, request: CommitRequest },
}

/// What a plugin asks of a window's Commit view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommitRequest {
    /// What Commit would commit now ([`CommitAnswer::Selection`]); unsaved
    /// editors of the included files are saved first.
    Selection,
    /// Replace the message if the draft is still at `revision`.
    SetMessage { revision: u64, message: String },
}

/// A window's answer to a [`CommitRequest`].
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommitAnswer {
    /// The window's project has no repository.
    NoRepository,
    Selection {
        selection: CommitSelection,
    },
    /// The message was replaced.
    Done,
    /// The draft is no longer at the revision.
    Stale,
}

/// What a window's Commit view would commit: per repository, the options
/// `vcs_commit` would get.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitSelection {
    /// Changes whenever the message, the included changes or Amend do.
    pub revision: u64,
    pub message: String,
    pub amend: bool,
    pub repositories: Vec<CommitSelectionRepo>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitSelectionRepo {
    pub root: ide_core::IpcPath,
    pub options: ide_vcs::CommitOptions,
}

/// Delivers events to the UI. `client` is the window that invoked the plugin
/// (`None` = broadcast, e.g. during activation).
pub trait PluginEventSink: Send + Sync {
    fn emit(&self, client: Option<&str>, event: PluginEvent);
}

impl<F: Fn(Option<&str>, PluginEvent) + Send + Sync> PluginEventSink for F {
    fn emit(&self, client: Option<&str>, event: PluginEvent) {
        self(client, event)
    }
}

/// The focused editor when a plugin command is invoked.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEditor {
    pub path: String,
    pub language: String,
    pub selections: Vec<ide_core::Range>,
}

impl PluginEditor {
    pub fn context(self) -> ide_plugin::EditorContext {
        ide_plugin::EditorContext { path: self.path.into(), language: self.language, selections: self.selections }
    }
}

/// A text file of a package the UI generated, at its `/`-separated path in the package.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PackageFile {
    pub path: String,
    pub text: String,
}

/// A plugin's status bar item.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatusItem {
    /// Whether this item overrides the global item in the requesting window.
    pub window: bool,
    pub plugin_id: String,
    pub id: String,
    pub item: StatusItem,
}

/// A plugin's context key for `when` clauses (`value` is JSON text).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginContextKey {
    pub plugin_id: String,
    pub key: String,
    pub value: String,
}

/// A gutter marker from a plugin's `line-markers` provider.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineMarkerInfo {
    pub plugin_id: String,
    /// 0-based.
    pub line: u32,
    /// `navigate` (default), `implemented`, `implementing`, `run`.
    pub icon: Option<String>,
    pub tooltip: String,
    /// Opened on click.
    pub target: Option<ide_core::Location>,
}

/// A plugin's before-commit check to run (`[[contributes.commitChecks]]`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommitCheckRef {
    pub plugin_id: String,
    pub check: String,
}

/// What a plugin's before-commit check found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommitCheckResult {
    pub plugin_id: String,
    pub check: String,
    /// The check's declared title.
    pub title: String,
    pub problems: Vec<ide_plugin::CommitProblem>,
    /// The check could not run (the plugin failed, timed out or lacks `vcs.read`).
    pub error: Option<String>,
}

/// The invoking window's response to a command request.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum CommandAnswer {
    Value(Option<String>),
    NotFound,
    Failed(String),
}

/// A plugin-owned editor or project-tree decoration set for one file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DecorationSet {
    pub root: ide_core::IpcPath,
    pub path: ide_core::IpcPath,
    pub set_id: String,
    pub tree: bool,
    pub items: Vec<ide_plugin::Decoration>,
    pub file: Option<ide_plugin::FileDecoration>,
}

/// A request that the invoking window acknowledges through plugin_answer_command.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WindowRequest {
    /// Connect and introspect using the normal Database action in this window.
    DatabaseConnect { id: String },
    /// Open and acknowledge validation by the shared content editor.
    ContentTab { tab: ide_plugin::ContentTab },
    #[serde(rename_all = "camelCase")]
    Run { operation: String, config: Box<ide_run::RunConfig>, debug: bool },
    #[serde(rename_all = "camelCase")]
    Terminal {
        operation: String,
        key: String,
        title: String,
        program: ide_core::IpcPath,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        cwd: ide_core::IpcPath,
    },
}
