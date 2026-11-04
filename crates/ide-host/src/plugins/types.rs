//! UI-facing plugin types and the event stream.

use super::theme::ThemeDef;
use ide_extension::{CapabilityInfo, ContributionInfo, UiContribution};
pub use ide_plugin::{ActionPerformed, ActionSource, EventKind, NotificationLevel, StatusItem, WorkbenchEvent};
use serde::{Deserialize, Serialize};
use specta::Type;

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
    pub source: PluginSource,
    /// Package directory.
    pub path: ide_core::IpcPath,
    pub enabled: bool,
    pub status: PluginStatus,
    pub error: Option<String>,
    pub has_code: bool,
    /// Declared capabilities with risk and grant state.
    pub capabilities: Vec<CapabilityInfo>,
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

/// Backend → UI notifications (Tauri event `ide://plugin`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PluginEvent {
    /// Plugins, their status or their contributions changed: re-fetch `plugin_list`.
    CommandsChanged,
    #[serde(rename_all = "camelCase")]
    Notification { plugin_id: String, level: NotificationLevel, title: String, body: String },
    /// A plugin's status bar item was set (`item`) or removed.
    #[serde(rename_all = "camelCase")]
    StatusItemChanged { plugin_id: String, id: String, item: Option<StatusItem> },
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
    /// Plugin languages, or the servers they may start, changed: re-fetch
    /// `languages` (the host re-detects open documents: [`crate::Host::plugin_languages_changed`]).
    LanguagesChanged,
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

/// A plugin's status bar item.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatusItem {
    pub plugin_id: String,
    pub id: String,
    pub item: StatusItem,
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
