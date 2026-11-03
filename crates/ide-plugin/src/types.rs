//! UI-facing types and the event stream.

use crate::manifest::{CommandDecl, Permission};
use crate::theme::{ThemeDef, ThemeKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NotificationLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PluginSource {
    /// Installed under `<app-data>/plugins/<id>/`.
    Installed,
    /// Loaded from `<project>/.openidea/plugins/<dir>/` while that project is open.
    Dev,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PluginStatus {
    /// Code loaded and activated.
    Active,
    /// No code; static contributions only.
    Static,
    Disabled,
    /// Failed to load, or trapped and was disabled for this session (see `error`).
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginLanguage {
    pub id: String,
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginTheme {
    pub id: String,
    pub name: String,
    pub kind: ThemeKind,
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
    pub permissions: Vec<Permission>,
    /// Commands contributed while enabled (manifest + registered at runtime).
    pub commands: Vec<CommandDecl>,
    pub languages: Vec<PluginLanguage>,
    pub themes: Vec<PluginTheme>,
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
    /// Package directory; install with `install_from_path(path)`.
    pub path: ide_core::IpcPath,
    pub has_code: bool,
    pub permissions: Vec<Permission>,
    pub commands: Vec<CommandDecl>,
    pub language_count: u32,
    pub theme_count: u32,
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
}

/// Backend → UI notifications (Tauri event `ide://plugin`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PluginEvent {
    /// Plugins, their status or their commands changed: re-fetch `plugin_list`.
    CommandsChanged,
    #[serde(rename_all = "camelCase")]
    Notification { plugin_id: String, level: NotificationLevel, title: String, body: String },
    #[serde(rename_all = "camelCase")]
    InsertText { plugin_id: String, text: String },
    #[serde(rename_all = "camelCase")]
    ReplaceSelection { plugin_id: String, text: String },
    #[serde(rename_all = "camelCase")]
    ThemeChanged { theme: Option<ActiveTheme> },
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

pub type BufferText = Arc<dyn Fn(&Path) -> Option<String> + Send + Sync>;

/// Where a command runs: the invoking window and its project.
#[derive(Clone, Default)]
pub struct Invocation {
    pub client: Option<String>,
    pub workspace_root: Option<PathBuf>,
    /// Unsaved editor contents win over disk for `read-file`.
    pub buffer_text: Option<BufferText>,
}

/// Per-call resource limits for plugin code.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Wasm fuel (≈ instructions) per host → plugin call.
    pub fuel: u64,
    /// Wall-clock limit per call (epoch interruption).
    pub timeout: Duration,
    /// Linear memory cap per plugin.
    pub memory_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { fuel: 5_000_000_000, timeout: Duration::from_secs(5), memory_bytes: 256 << 20 }
    }
}
