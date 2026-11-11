//! User-facing settings. Layered: defaults → global `settings.toml` →
//! project `.openidea/settings.toml`. Loading/merging lives in `ide-workspace`.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

pub use crate::editor_settings::*;
pub use crate::inspection_settings::*;
pub use crate::proxy_settings::{ProxyKind, ProxyMode, ProxySettings};
pub use crate::remote_settings::*;
pub use crate::workflow_settings::*;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub general: GeneralSettings,
    pub appearance: AppearanceSettings,
    pub editor: EditorSettings,
    pub keymap: String,
    pub files: FileSettings,
    /// Per-action keybinding overrides on top of the `keymap` preset: action id →
    /// bindings (`Meta+Shift+O`, chords space-separated). An empty list unbinds.
    pub keymap_overrides: BTreeMap<String, Vec<String>>,
    /// User keymaps (Keymap › Duplicate…): id → name, parent preset and the
    /// keymap's own overrides. `keymap` may name one of these ids.
    pub custom_keymaps: BTreeMap<String, CustomKeymap>,
    pub notifications: NotificationSettings,
    /// System Settings › HTTP Proxy (global only).
    pub proxy: ProxySettings,
    /// Interpreters / toolchains per language (Python, Node.js, Rust, Go, TypeScript).
    pub languages: LanguagesSettings,
    /// Project Structure: source / test / resource / excluded folders (project-relative).
    pub project_structure: ProjectStructureSettings,
    /// Version Control (Git, Commit, Confirmation, Issue Navigation).
    pub vcs: VcsSettings,
    /// Build, Execution, Deployment › Console.
    pub console: ConsoleSettings,
    pub debugger: DebuggerSettings,
    pub run: RunSettings,
    /// Tools › Terminal.
    pub terminal: TerminalSettings,
    pub actions_on_save: ActionsOnSaveSettings,
    pub external_tools: Vec<ExternalTool>,
    /// Language servers / debug adapters at a user-chosen location, by the
    /// command the language definition launches (`elixir-ls`, `codelldb`).
    pub tools: BTreeMap<String, ToolSettings>,
    /// Per language server, by name (`rust-analyzer`): launch and protocol
    /// options on top of the language definition, or a server defined here.
    pub language_servers: BTreeMap<String, LanguageServerSettings>,
    /// Editor › Inspections profiles.
    pub inspections: InspectionSettings,
    /// Editor › Natural Languages › Spelling.
    pub spelling: SpellingSettings,
    /// Tools › SSH Configurations.
    pub ssh: SshSettings,
    /// Build, Execution, Deployment › Deployment.
    pub deployment: DeploymentSettings,
    /// Build, Execution, Deployment › Run Targets.
    pub run_targets: Vec<RunTarget>,
    pub cmake: CMakeSettings,
    /// Settings › Agents.
    pub agents: AgentSettings,
    /// Agents › MCP Server (global only).
    pub mcp_server: McpServerSettings,
    /// Plugin settings (`[contributes.settings]`): plugin id → its values by key.
    #[specta(type = BTreeMap<String, BTreeMap<String, specta_typescript::Unknown>>)]
    pub plugins: BTreeMap<String, serde_json::Map<String, serde_json::Value>>,
}

/// Settings › Agents: what the conversation shows and how messages are sent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentSettings {
    /// Context window use.
    pub show_context_usage: bool,
    /// Time the agent spent on the task.
    pub show_work_time: bool,
    /// The account's usage-limit windows (Claude's 5-hour and weekly limits).
    pub show_usage_limits: bool,
    /// What the session has cost so far, as the agent reports it.
    pub show_cost: bool,
    /// A finished turn's work folds into one line under its message, leaving the reply.
    pub fold_turns: bool,
    /// Streaming text is revealed at a steady pace rather than chunk by chunk.
    pub smooth_text: bool,
    #[serde(deserialize_with = "or_default")]
    #[specta(type = ThinkingDisplay)]
    pub thinking: ThinkingDisplay,
    #[serde(deserialize_with = "or_default")]
    #[specta(type = ToolCallDisplay)]
    pub tool_calls: ToolCallDisplay,
    /// A tool call's output (a command's, a diff) is shown without opening it.
    pub expand_tool_output: bool,
    #[serde(deserialize_with = "or_default")]
    #[specta(type = SendKey)]
    pub send_with: SendKey,
    /// What sending does while the agent works: queue the message for after the turn, or
    /// send it into the turn.
    #[serde(deserialize_with = "or_default")]
    #[specta(type = WhileRunning)]
    pub while_running: WhileRunning,
    /// Settings new tasks of an agent start with: agent id → option id → value.
    #[serde(deserialize_with = "agent_defaults")]
    #[specta(type = BTreeMap<String, BTreeMap<String, String>>)]
    pub defaults: BTreeMap<String, BTreeMap<String, String>>,
    /// MCP servers passed to coding agents in `session/new`, `session/load` and `session/fork`,
    /// keyed by server name (`[agents.mcpServers.<name>]`).
    #[serde(deserialize_with = "or_default")]
    #[specta(type = BTreeMap<String, AgentMcpServer>)]
    pub mcp_servers: BTreeMap<String, AgentMcpServer>,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            show_context_usage: true,
            show_work_time: true,
            show_usage_limits: true,
            show_cost: false,
            fold_turns: true,
            smooth_text: true,
            thinking: ThinkingDisplay::Auto,
            tool_calls: ToolCallDisplay::Grouped,
            expand_tool_output: false,
            send_with: SendKey::Enter,
            while_running: WhileRunning::Queue,
            defaults: BTreeMap::new(),
            mcp_servers: BTreeMap::new(),
        }
    }
}

/// Transport of an MCP server configured in Settings › Agents › MCP Servers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    #[default]
    Stdio,
    Http,
    Sse,
}

/// An MCP server passed to coding agents in `session/new`, `session/load` and `session/fork`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentMcpServer {
    #[serde(deserialize_with = "or_default")]
    #[specta(type = McpTransport)]
    pub transport: McpTransport,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// Agent provider ids this server is enabled for (e.g. `["claude", "codex"]`);
    /// empty means enabled for all agents.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
}

impl Default for AgentMcpServer {
    fn default() -> Self {
        Self {
            transport: McpTransport::Stdio,
            enabled: true,
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            agents: Vec::new(),
        }
    }
}

/// A hand-edited value these settings don't know reads as the default, rather than
/// failing the whole settings file.
fn or_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).unwrap_or_default())
}

/// [`AgentSettings::defaults`], keeping only the text values of each agent's table.
fn agent_defaults<'de, D>(d: D) -> Result<BTreeMap<String, BTreeMap<String, String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let serde_json::Value::Object(agents) = serde_json::Value::deserialize(d)? else { return Ok(BTreeMap::new()) };
    Ok(agents
        .into_iter()
        .filter_map(|(agent, options)| match options {
            serde_json::Value::Object(options) => Some((
                agent,
                options
                    .into_iter()
                    .filter_map(|(k, v)| match v {
                        serde_json::Value::String(v) => Some((k, v)),
                        _ => None,
                    })
                    .collect(),
            )),
            _ => None,
        })
        .collect())
}

/// How the agent's reasoning shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingDisplay {
    /// Open while it streams, folded once it ends.
    #[default]
    Auto,
    Expanded,
    Collapsed,
}

/// How tool calls between messages show.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolCallDisplay {
    /// A run of calls is one line saying what they did ("Read 4 files · Edited 2 files").
    #[default]
    Grouped,
    /// Each call on its own line.
    Each,
}

/// The key that sends a message; the other one starts a new line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SendKey {
    #[default]
    Enter,
    ModEnter,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WhileRunning {
    #[default]
    Queue,
    Steer,
}

/// Agents › MCP Server: agents use the IDE's built-in tools.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct McpServerSettings {
    /// Serve the tools on 127.0.0.1 while the IDE runs.
    pub enabled: bool,
}

/// Absent profiles retain automatic discovery for existing projects.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct CMakeSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub profiles: Option<Vec<CMakeProfile>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct CMakeProfile {
    pub name: String,
    pub build_type: String,
    pub generator: String,
    pub cmake_args: Vec<String>,
    /// Empty uses cmake-build-<lowercase build type>.
    pub build_dir: String,
    pub build_args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl Default for CMakeProfile {
    fn default() -> Self {
        Self {
            name: "Debug".into(),
            build_type: "Debug".into(),
            generator: String::new(),
            cmake_args: Vec::new(),
            build_dir: String::new(),
            build_args: Vec::new(),
            env: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ToolSettings {
    /// Executable to launch instead of the managed / `PATH` one; empty = auto-detect.
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct LanguageServerSettings {
    /// `false` keeps the server from starting for any language.
    pub enabled: bool,
    /// Executable to launch instead of the definition's; required for a server
    /// defined here (one with `languages`).
    pub command: String,
    /// Replaces the definition's arguments.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub args: Option<Vec<String>>,
    /// Added to the server's environment.
    pub env: BTreeMap<String, String>,
    /// Merged over the definition's `initializationOptions` (sent once at startup).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = Option<specta_typescript::Unknown>)]
    pub initialization_options: Option<serde_json::Value>,
    /// Answers the server's `workspace/configuration` requests; changes are pushed
    /// with `workspace/didChangeConfiguration` without a restart.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = Option<specta_typescript::Unknown>)]
    pub settings: Option<serde_json::Value>,
    /// Language ids a server defined here serves (`python`); empty for the servers
    /// of the language definitions.
    pub languages: Vec<String>,
    /// Files marking a workspace root for a server defined here (`pyproject.toml`).
    pub root_markers: Vec<String>,
    /// Replaces the definition's `features`: what the server is used for
    /// (`code-action`, `hover`, …); an empty list means everything.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub features: Option<Vec<String>>,
    /// Replaces the definition's `code-action-kinds` (`refactor`); an empty
    /// list keeps every kind.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub code_action_kinds: Option<Vec<String>>,
}

impl Default for LanguageServerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            command: String::new(),
            args: None,
            env: BTreeMap::new(),
            initialization_options: None,
            settings: None,
            languages: Vec::new(),
            root_markers: Vec::new(),
            features: None,
            code_action_kinds: None,
        }
    }
}

impl LanguageServerSettings {
    /// A server defined in settings rather than by a language definition.
    pub fn is_custom(&self) -> bool {
        !self.languages.is_empty()
    }
}

impl Settings {
    /// The configured executable for `command`, if any (`~/` not yet expanded).
    pub fn tool_path(&self, command: &str) -> Option<&str> {
        self.tools.get(command).map(|t| t.path.trim()).filter(|p| !p.is_empty())
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            general: GeneralSettings::default(),
            appearance: AppearanceSettings::default(),
            editor: EditorSettings::default(),
            keymap: default_keymap().into(),
            files: FileSettings::default(),
            keymap_overrides: BTreeMap::new(),
            custom_keymaps: BTreeMap::new(),
            notifications: NotificationSettings::default(),
            proxy: ProxySettings::default(),
            languages: LanguagesSettings::default(),
            project_structure: ProjectStructureSettings::default(),
            vcs: VcsSettings::default(),
            console: ConsoleSettings::default(),
            debugger: DebuggerSettings::default(),
            run: RunSettings::default(),
            terminal: TerminalSettings::default(),
            actions_on_save: ActionsOnSaveSettings::default(),
            external_tools: Vec::new(),
            tools: BTreeMap::new(),
            language_servers: BTreeMap::new(),
            inspections: InspectionSettings::default(),
            spelling: SpellingSettings::default(),
            ssh: SshSettings::default(),
            deployment: DeploymentSettings::default(),
            run_targets: Vec::new(),
            cmake: CMakeSettings::default(),
            agents: AgentSettings::default(),
            mcp_server: McpServerSettings::default(),
            plugins: BTreeMap::new(),
        }
    }
}

/// IDEA's keymap for the OS (`src/platform/keymaps/`).
fn default_keymap() -> &'static str {
    if cfg!(target_os = "macos") { "intellij-macos" } else { "intellij-windows" }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomKeymap {
    pub name: String,
    /// Bundled preset the keymap derives from, e.g. `intellij-macos`.
    pub parent: String,
    /// Action id → bindings on top of `parent`; an empty list unbinds.
    pub overrides: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GeneralSettings {
    pub reopen_last_project: bool,
    pub confirm_exit: bool,
    /// When on, the last window closes instead of showing the Welcome screen.
    pub close_without_welcome: bool,
    /// When on, closing a window drops its saved editor tabs, so they are not restored next time.
    pub close_tabs_with_window: bool,
    /// Where Open… puts a project while one is open: `ask` | `new` | `same` | `attach`.
    pub open_project_in: String,
    /// Initial folder of the Open / Clone dialogs; empty = the OS default.
    pub default_project_directory: String,
    /// Save all files after `idle_seconds` without input.
    pub save_on_idle: bool,
    pub idle_seconds: u32,
    pub date_format: DateFormatSettings,
    /// File › Power Save Mode: no automatic popups (completion, parameter info,
    /// quick documentation) or background highlighting (usages, code vision).
    pub power_save_mode: bool,
    /// File › Rename Project… (project layer): the name shown for the project; empty = its folder name.
    pub project_name: String,
    /// Where updates come from: `auto` (the CNB mirror for the Chinese UI, else GitHub) | `github` | `cnb`.
    pub update_source: String,
    pub auto_check_updates: bool,
    /// System Settings › Updates: open the What's New page after the app starts a new version.
    pub show_whats_new_after_update: bool,
    /// The version the app last started with, so the first start after an update is recognisable.
    pub last_run_version: String,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            reopen_last_project: true,
            confirm_exit: true,
            close_without_welcome: false,
            close_tabs_with_window: false,
            open_project_in: "ask".into(),
            default_project_directory: String::new(),
            save_on_idle: false,
            idle_seconds: 15,
            date_format: DateFormatSettings::default(),
            power_save_mode: false,
            project_name: String::new(),
            update_source: "auto".into(),
            auto_check_updates: true,
            show_whats_new_after_update: true,
            last_run_version: String::new(),
        }
    }
}

/// System Settings › Date Formats (Git log, Local History, blame).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct DateFormatSettings {
    /// Use `pattern` / `use24_hour` instead of the system locale's format.
    pub override_system: bool,
    /// `dd`, `MM`, `MMM`, `yy`, `yyyy` placeholders.
    pub pattern: String,
    pub use24_hour: bool,
    /// "Today", "Yesterday", "5 min ago".
    pub pretty: bool,
}

impl Default for DateFormatSettings {
    fn default() -> Self {
        Self { override_system: false, pattern: "dd.MM.yyyy".into(), use24_hour: true, pretty: true }
    }
}

/// Notifications page: global switches and the per-group display type.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct NotificationSettings {
    pub balloons: bool,
    pub sound: bool,
    /// Group id → display; groups not listed use their default.
    pub groups: BTreeMap<String, NotificationGroupSettings>,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self { balloons: true, sound: false, groups: BTreeMap::new() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct NotificationGroupSettings {
    /// `balloon` | `sticky` | `none`
    pub display: String,
    /// Also list it in the Notifications tool window.
    pub log: bool,
}

impl Default for NotificationGroupSettings {
    fn default() -> Self {
        Self { display: "balloon".into(), log: true }
    }
}

/// Where the Navigation Bar (the file path breadcrumbs) is shown. Mirrors
/// IDEA's `View | Appearance | Navigation Bar` (Top / Status Bar / Don't show).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NavigationBarPosition {
    /// Above the editor, below the main menu / toolbar.
    Top,
    /// In the footer, next to the status bar widgets — the default, matching
    /// where the bar lived before the three-state choice existed.
    #[default]
    StatusBar,
    /// Not shown at all.
    Hidden,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AppearanceSettings {
    /// A built-in theme id (`light`, `dark`, `dark-hc`, …), `system` (legacy
    /// "Sync with OS"), or a plugin's theme: `plugin:<plugin-id>/<theme-id>`.
    pub theme: String,
    pub accent: String,
    pub ui_font_size: f32,
    pub locale: String,
    /// Follow the OS light/dark mode with the preferred themes below.
    pub sync_with_os: bool,
    pub preferred_light_theme: String,
    pub preferred_dark_theme: String,
    /// A plugin's file icon theme (`<plugin-id>/<theme-id>`); empty = the built-in icons.
    pub file_icon_theme: String,
    pub file_icon_theme_options: BTreeMap<String, FileIconThemeOptions>,
    /// IDE zoom in percent (50–300).
    pub zoom: u32,
    /// Apply `ui_font_family` / `ui_font_size` (otherwise the theme's).
    pub use_custom_font: bool,
    pub ui_font_family: String,
    /// Font tried when `ui_font_family` lacks a glyph; empty = none.
    pub ui_font_fallback: String,
    pub contrast_scrollbars: bool,
    /// Adjust colours for red-green vision deficiency.
    pub red_green_vision: bool,
    pub different_tool_window_background: bool,
    pub compact_mode: bool,
    /// IDEA "Use smaller indents in trees": tool window trees indent less per level.
    pub small_tree_indents: bool,
    pub full_path_in_title: bool,
    pub project_colors_in_toolbar: bool,
    pub dnd_with_alt_only: bool,
    pub menu_icons: bool,
    /// `hamburger` | `merged` | `toolbar` (a separate row): main menu presentation in the frameless title bar.
    pub main_menu_style: String,
    /// A lone Alt press focuses or opens the main menu (IDEA `ide.windows.main.menu.focus.on.alt`).
    pub main_menu_alt: bool,
    /// `subpixel` | `greyscale` | `none`
    pub ide_antialiasing: String,
    pub editor_antialiasing: String,
    pub show_tool_window_bars: bool,
    pub show_tool_window_names: bool,
    pub show_tool_window_badges: bool,
    pub widescreen_tool_windows: bool,
    /// View › Appearance › Toolbar; hidden leaves IDEA's compact window header.
    pub show_main_toolbar: bool,
    pub show_status_bar: bool,
    /// View › Appearance › Navigation Bar: the file path breadcrumbs, shown in
    /// the status bar by default, above the editor, or not at all.
    pub navigation_bar: NavigationBarPosition,
    /// Status bar widgets shown (`true`) or hidden (`false`) by the user
    /// (status bar context menu); widgets not listed use their default.
    pub status_bar_widgets: BTreeMap<String, bool>,
    /// Customize Main Toolbar; `None` = the default toolbar.
    pub main_toolbar: Option<MainToolbarSettings>,
}

/// Main toolbar entries per side, in order: title widget ids (`project`,
/// `vcs.branch`…) or `action:<id>`. Widgets in neither list nor `hidden`
/// (registered later) keep their default place.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct FileIconThemeOptions {
    pub groups: BTreeMap<String, bool>,
    pub choices: BTreeMap<String, String>,
    pub hide_files: bool,
    pub hide_folders: bool,
    pub hollow_folders: bool,
    pub hide_ui_icons: bool,
    pub hide_psi_icons: bool,
    pub monochrome: Option<String>,
    pub saturation: Option<u8>,
    pub opacity: Option<u8>,
    pub icon_size: Option<u8>,
    pub row_height: Option<u8>,
    pub accent: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct MainToolbarSettings {
    pub left: Vec<String>,
    pub right: Vec<String>,
    /// Widgets the user removed.
    pub hidden: Vec<String>,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            accent: "#3871e1".into(),
            ui_font_size: 13.0,
            locale: "en".into(),
            sync_with_os: false,
            preferred_light_theme: "light".into(),
            preferred_dark_theme: "dark".into(),
            file_icon_theme: String::new(),
            file_icon_theme_options: BTreeMap::new(),
            zoom: 100,
            use_custom_font: false,
            ui_font_family: "Inter".into(),
            ui_font_fallback: String::new(),
            contrast_scrollbars: false,
            red_green_vision: false,
            different_tool_window_background: false,
            compact_mode: false,
            small_tree_indents: false,
            full_path_in_title: false,
            project_colors_in_toolbar: true,
            dnd_with_alt_only: false,
            menu_icons: true,
            main_menu_style: "hamburger".into(),
            main_menu_alt: true,
            ide_antialiasing: "greyscale".into(),
            editor_antialiasing: "greyscale".into(),
            show_tool_window_bars: true,
            show_tool_window_names: false,
            show_tool_window_badges: true,
            widescreen_tool_windows: false,
            show_main_toolbar: true,
            show_status_bar: true,
            navigation_bar: NavigationBarPosition::StatusBar,
            status_bar_widgets: BTreeMap::new(),
            main_toolbar: None,
        }
    }
}

/// Imported editor colour scheme on top of a built-in base.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomColorScheme {
    pub name: String,
    pub parent: String,
    pub attributes: BTreeMap<String, TextAttributesOverride>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorSettings {
    pub font_family: String,
    pub font_size: f32,
    pub line_height: f32,
    pub tab_size: u32,
    pub insert_spaces: bool,
    pub soft_wrap: bool,
    pub show_whitespace: bool,
    pub inlay_hints: bool,
    pub sticky_scroll: bool,
    pub format_on_save: bool,
    /// Editor colour scheme id; `theme-default` follows the IDE theme.
    pub color_scheme: String,
    /// Imported editor schemes, stored in user settings.
    pub custom_schemes: BTreeMap<String, CustomColorScheme>,
    /// Color Scheme edits: scheme id → attribute id → override.
    pub color_overrides: BTreeMap<String, BTreeMap<String, TextAttributesOverride>>,
    /// Color Scheme › Language Defaults › Semantic highlighting: local variables and
    /// parameters get a colour derived from their name (IDEA's rainbow identifiers).
    pub semantic_highlighting: bool,
    /// Docstring markup format whose tags and keywords the Python editor highlights
    /// (`plain`, `rest`, `epytext`, `google`, `numpy`).
    pub docstring_format: String,
    /// Color Scheme › Language Defaults › Rainbow brackets: `()`, `[]`, `{}` coloured by depth.
    pub rainbow_brackets: bool,
    pub ligatures: bool,
    /// Fallback font for glyphs the main font lacks; empty = none.
    pub fallback_font: String,
    /// Typography Settings › Main font weight (CSS 100–900), as IDEA.
    pub font_weight: u16,
    /// Typography Settings › Bold font weight: wherever the editor renders bold.
    pub bold_font_weight: u16,
    pub general: EditorGeneralSettings,
    pub appearance: EditorAppearanceSettings,
    pub breadcrumbs: BreadcrumbsSettings,
    pub completion: CompletionSettings,
    pub auto_import: AutoImportSettings,
    pub folding: FoldingSettings,
    pub tabs: EditorTabsSettings,
    pub smart_keys: SmartKeysSettings,
    pub code_editing: CodeEditingSettings,
    pub inlay: InlayHintsSettings,
    pub inline_completion: InlineCompletionSettings,
    /// Gutter icon groups turned off (`run`, `breakpoints`, `bookmarks`, `vcs`, `blame`).
    pub gutter_icons_disabled: Vec<String>,
    pub show_gutter_icons: bool,
    pub code_style: CodeStyleSettings,
    pub encodings: EncodingSettings,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_family: "JetBrains Mono".into(),
            font_size: 13.0,
            line_height: 22.0,
            tab_size: 4,
            insert_spaces: true,
            soft_wrap: true,
            show_whitespace: false,
            inlay_hints: true,
            sticky_scroll: true,
            format_on_save: false,
            color_scheme: "theme-default".into(),
            color_overrides: BTreeMap::new(),
            custom_schemes: BTreeMap::new(),
            semantic_highlighting: false,
            docstring_format: "rest".into(),
            rainbow_brackets: false,
            ligatures: false,
            fallback_font: String::new(),
            font_weight: 400,
            bold_font_weight: 700,
            general: EditorGeneralSettings::default(),
            appearance: EditorAppearanceSettings::default(),
            breadcrumbs: BreadcrumbsSettings::default(),
            completion: CompletionSettings::default(),
            auto_import: AutoImportSettings::default(),
            folding: FoldingSettings::default(),
            tabs: EditorTabsSettings::default(),
            smart_keys: SmartKeysSettings::default(),
            code_editing: CodeEditingSettings::default(),
            inlay: InlayHintsSettings::default(),
            inline_completion: InlineCompletionSettings::default(),
            gutter_icons_disabled: Vec::new(),
            show_gutter_icons: true,
            code_style: CodeStyleSettings::default(),
            encodings: EncodingSettings::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct FileSettings {
    /// Save on focus loss / tab switch, like IDEA.
    pub auto_save: bool,
    /// Re-check open files against disk when the IDE window gains focus.
    pub sync_on_focus: bool,
    pub exclude: Vec<String>,
    /// Ignored Files and Folders: name patterns hidden everywhere; see [`crate::ignored`].
    pub ignored_names: Vec<String>,
    pub trim_trailing_whitespace: bool,
    pub ensure_final_newline: bool,
    /// Local History keeps changes from this many working days (days with changes), like IDEA.
    pub local_history_days: u32,
    /// Upper bound for a project's Local History in MB; the oldest revisions go first.
    pub local_history_max_mb: u32,
    /// File Types › Recognized File Types: the user's changes, by language id.
    pub file_types: BTreeMap<String, FileTypeAssociation>,
    /// Override File Type: file (project-relative and `/`-separated, or absolute) → language id.
    pub file_type_overrides: BTreeMap<String, String>,
    /// Compose detection choices, keyed by project-relative file path.
    pub compose_file_overrides: BTreeMap<String, ComposeFileOverride>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ComposeFileOverride {
    Kept,
    Excluded,
}

/// One language's file name and hashbang patterns on top of its definition.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct FileTypeAssociation {
    /// Added file name patterns: `*.foo`, `Jenkinsfile`, `Dockerfile.*` (`*` and `?` wildcards).
    pub patterns: Vec<String>,
    /// Patterns of the definition (`*.ext`, file names) the user removed.
    pub removed_patterns: Vec<String>,
    /// Interpreters run by a `#!` first line, e.g. `node` for `#!/usr/bin/env node`.
    pub hashbangs: Vec<String>,
}

impl Default for FileSettings {
    fn default() -> Self {
        Self {
            auto_save: true,
            sync_on_focus: true,
            exclude: vec!["**/.git".into(), "**/node_modules".into(), "**/target".into()],
            ignored_names: crate::ignored::DEFAULT_IGNORED_NAMES.iter().map(|s| (*s).into()).collect(),
            trim_trailing_whitespace: true,
            ensure_final_newline: true,
            local_history_days: 5,
            local_history_max_mb: 512,
            file_types: BTreeMap::new(),
            file_type_overrides: BTreeMap::new(),
            compose_file_overrides: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct LanguagesSettings {
    /// Explicit plugin formatter, by language id. Empty entries use the normal formatter policy.
    pub plugin_formatters: BTreeMap<String, String>,
    pub python: PythonSettings,
    pub node: NodeSettings,
    pub php: PhpSettings,
    pub rust: RustSettings,
    pub go: GoSettings,
    pub typescript: TypeScriptSettings,
    pub prettier: ExternalFormatterSettings,
    pub oxfmt: ExternalFormatterSettings,
    pub ruff: ExternalFormatterSettings,
    pub java: JavaSettings,
    pub ruby: RubySettings,
    pub markdown: MarkdownSettings,
    pub arduino: ArduinoSettings,
}

impl Default for LanguagesSettings {
    fn default() -> Self {
        Self {
            plugin_formatters: BTreeMap::new(),
            python: PythonSettings::default(),
            node: NodeSettings::default(),
            php: PhpSettings::default(),
            rust: RustSettings::default(),
            go: GoSettings::default(),
            typescript: TypeScriptSettings::default(),
            prettier: ExternalFormatterSettings::default(),
            oxfmt: ExternalFormatterSettings::default(),
            ruff: ExternalFormatterSettings {
                languages: vec!["python".into()],
                ..ExternalFormatterSettings::default()
            },
            java: JavaSettings::default(),
            ruby: RubySettings::default(),
            markdown: MarkdownSettings::default(),
            arduino: ArduinoSettings::default(),
        }
    }
}

/// Arduino tool discovery paths and default board FQBN, configured in `settings.toml`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ArduinoSettings {
    pub cli: String,
    pub clangd: String,
    pub language_server: String,
    pub cli_config: String,
    pub fqbn: String,
}

/// Languages & Frameworks › Markdown. Like IDEA's, it is application-level only.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct MarkdownSettings {
    /// Preview (and notebook Markdown cell) font size in px; unset follows the editor font size.
    pub preview_font_size: Option<u32>,
}

impl LanguagesSettings {
    pub fn formatter(&self, tool: ExternalFormatter) -> &ExternalFormatterSettings {
        match tool {
            ExternalFormatter::Prettier => &self.prettier,
            ExternalFormatter::Oxfmt => &self.oxfmt,
            ExternalFormatter::Ruff => &self.ruff,
        }
    }
}

/// A formatter that runs outside the language servers, with its own settings group.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ExternalFormatter {
    Prettier,
    Oxfmt,
    Ruff,
}

impl ExternalFormatter {
    /// The name of the tool in the tool registry.
    pub fn name(self) -> &'static str {
        match self {
            Self::Prettier => "prettier",
            Self::Oxfmt => "oxfmt",
            Self::Ruff => "ruff",
        }
    }
}

/// An external formatter (Prettier, oxfmt, Ruff) and the languages it formats.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ExternalFormatterSettings {
    /// Empty path: project node_modules (Prettier/oxfmt), managed installation, then PATH.
    pub path: String,
    /// Ruff only: directory containing its configuration, or a configuration file.
    pub configuration_directory: String,
    pub languages: Vec<String>,
    /// Prefer this formatter even when a language server offers formatting.
    pub prefer: bool,
    pub run_on_save: bool,
}

impl Default for ExternalFormatterSettings {
    fn default() -> Self {
        Self {
            path: String::new(),
            configuration_directory: String::new(),
            languages: [
                "markdown",
                "yaml",
                "css",
                "scss",
                "less",
                "html",
                "graphql",
                "javascript",
                "javascriptreact",
                "typescript",
                "typescriptreact",
                "json",
                "jsonc",
                "vue",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            prefer: false,
            run_on_save: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct PythonSettings {
    /// Project interpreter executable; empty = auto-detect (project venv, else `python3`).
    pub interpreter: String,
    /// Activate the interpreter's virtualenv in new terminal sessions.
    pub activate_virtualenv: bool,
}

impl Default for PythonSettings {
    fn default() -> Self {
        Self { interpreter: String::new(), activate_virtualenv: true }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct PhpSettings {
    /// `php` CLI executable; empty = the one on `PATH`.
    pub interpreter: String,
    /// Run PHP/Composer or Node/package-manager commands in this target; empty = project default, `local` = local.
    pub run_target: String,
    /// PHP version the language server checks the code against (`7.4`); empty = from
    /// `composer.json` (`config.platform.php`, else the lowest version `require.php` allows).
    pub language_level: String,
    /// Folders outside the project whose code the language server indexes too (a platform a
    /// module extends); absolute, `~/`, or relative to the project.
    pub include_paths: Vec<String>,
    /// Intelephense stub sets loaded on top of its defaults and the `ext-*` entries of
    /// `composer.json` (`wordpress`).
    pub stubs: Vec<String>,
    /// PHPStan configuration file for checking saved files; empty = the `phpstan.neon`,
    /// `phpstan.neon.dist` or `phpstan.dist.neon` PHPStan finds in the project root. Absolute,
    /// `~/`, or relative to the project.
    pub phpstan_config: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct RubySettings {
    /// Project interpreter executable; empty = auto-detect (`.ruby-version`, mise / asdf, else `ruby` on PATH).
    pub interpreter: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct NodeSettings {
    /// `node` executable; empty = the one on `PATH`.
    pub interpreter: String,
    /// Run PHP/Composer or Node/package-manager commands in this target; empty = project default, `local` = local.
    pub run_target: String,
    /// `npm` | `pnpm` | `yarn`; empty = detect from the lock file / `packageManager`.
    pub package_manager: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct RustSettings {
    /// Directory holding `cargo` / `rustc`; empty = `PATH` / rustup default.
    pub toolchain: String,
    /// Standard library sources (`RUST_SRC_PATH`); empty = from the toolchain.
    pub stdlib: String,
    /// Run the external linter on save (rust-analyzer `checkOnSave`).
    pub check_on_save: bool,
    /// `check` | `clippy` (rust-analyzer `check.command`).
    pub check_command: String,
    /// Extra arguments for rustfmt (rust-analyzer `rustfmt.extraArgs`), space-separated.
    pub rustfmt_args: String,
}

impl Default for RustSettings {
    fn default() -> Self {
        Self {
            toolchain: String::new(),
            stdlib: String::new(),
            check_on_save: true,
            check_command: "check".into(),
            rustfmt_args: String::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GoSettings {
    /// Empty = the `go` on `PATH`.
    pub goroot: String,
    /// Empty = `go env GOPATH`.
    pub gopath: String,
    pub build_tags: GoBuildTags,
    pub modules: GoModules,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GoModules {
    pub env: BTreeMap<String, String>,
    pub auto_vendor: bool,
}

impl Default for GoModules {
    fn default() -> Self {
        Self { env: BTreeMap::new(), auto_vendor: true }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GoBuildTags {
    /// Empty values inherit the selected toolchain's defaults.
    pub os: String,
    pub arch: String,
    pub version: String,
    pub compiler: String,
    /// Empty = automatic, "1" = enabled, "0" = disabled.
    pub cgo: String,
    pub custom: String,
    pub experiments: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct JavaSettings {
    /// Project JDK home; empty = per module, the installed JDK matching the
    /// Java version it targets.
    pub jdk: String,
    /// Project Java language level (`8`, `11`, `17`, `21`, `25`); empty = SDK default.
    pub language_level: String,
    /// JDK home the Java language server (jdtls) runs on, apart from the project
    /// JDK (IDEA's "JDK for importer"); empty = the project JDK when new enough,
    /// else the first installed one that is.
    pub jdtls_jdk: String,
    /// Extra JVM options for the Java language server (jdtls), space-separated
    /// (VS Code's `java.jdt.ls.vmargs`).
    pub jdtls_vm_args: String,
    /// Share one JDT LS across builds in an ordinary project window; other windows remain separate.
    pub jdtls_shared: bool,
    /// Build Tools › Maven.
    pub maven: MavenSettings,
    /// Build Tools › Gradle.
    pub gradle: GradleSettings,
}

/// Build Tools › Gradle.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GradleSettings {
    /// Linked build directories; absent preserves automatic discovery, empty unlinks all builds.
    pub linked_projects: Option<Vec<String>>,
    /// Empty = Project JDK; otherwise a JDK home.
    pub jvm: String,
    pub distribution: GradleDistribution,
    /// Used only for the local distribution.
    pub home: String,
    /// Empty = Gradle's default user home.
    pub user_home: String,
    /// IDEA's "Build and run using": who builds and launches an Application main.
    pub run_using: GradleRunUsing,
}

/// IDEA's "Build and run using" for Gradle builds; IDEA defaults to Gradle.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GradleRunUsing {
    /// A `JavaExec` task on the source set's runtime classpath (`gradleRun.gradle`).
    #[default]
    Gradle,
    /// The Java language server's classpath, launched by OpenIDEA.
    Ide,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GradleDistribution {
    #[default]
    Wrapper,
    Local,
}

/// Build Tools › Maven.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct MavenSettings {
    /// JDK home used to run Maven; empty = Project JDK, else the POM's Java version.
    pub runner_jre: String,
    /// Project-relative root POMs removed from the Maven project model.
    pub unlinked_projects: Vec<String>,
    /// Project-relative POMs outside the root reactor added as independent top-level projects.
    pub linked_projects: Vec<String>,
    /// Maven home (or its `mvn` executable); empty = the project's `mvnw`, else `mvn` on `PATH`.
    pub home: String,
    /// User `settings.xml` (`-s`); empty = `~/.m2/settings.xml`.
    pub user_settings: String,
    /// Toolchains file (`-t`); empty = `~/.m2/toolchains.xml`.
    pub toolchains: String,
    /// Local repository (`-Dmaven.repo.local`); empty = from `settings.xml`.
    pub local_repository: String,
    /// Run Maven through the Maven Daemon (`mvnd`) for faster builds. mvnd embeds
    /// its own Maven, so `home` and the project's `mvnw` are bypassed when it is on.
    pub daemon: bool,
    /// Maven Daemon home (or its `mvnd` executable); empty = `$MVND_HOME`, else
    /// `mvnd` on `PATH` / common install dirs. Only used when `daemon` is on.
    pub mvnd_home: String,
    /// Thread count of Maven builds (`-T`): a number of threads (`4`) or a core
    /// multiplier (`2C`, `2.5C`); empty = Maven's default (one thread per module).
    pub threads: String,
    /// Active Maven profiles (`-P`), comma-separated; empty leaves profiles to the POM/settings.
    pub active_profiles: String,
}

impl MavenSettings {
    /// Settings profiles followed by the Maven tool window's choices.
    pub fn profiles(&self, choices: &[String]) -> Vec<String> {
        let mut profiles = Vec::new();
        for profile in self.active_profiles.split(',').chain(choices.iter().map(String::as_str)).map(str::trim) {
            if !profile.is_empty() && !profiles.iter().any(|p| p == profile) {
                profiles.push(profile.to_owned());
            }
        }
        let excluded: Vec<String> =
            profiles.iter().filter_map(|p| p.strip_prefix(['!', '-']).map(str::to_owned)).collect();
        profiles.retain(|p| !excluded.contains(p));
        profiles
    }

    /// The `-T` value when it is one Maven accepts: a thread count (`4`) or a
    /// core multiplier with an optional decimal fraction (`1C`, `2.5C`).
    /// Anything else is dropped: a bad `-T` would make every Maven run fail.
    pub fn thread_count(&self) -> Option<&str> {
        let value = self.threads.trim();
        let number = value.strip_suffix('C').unwrap_or(value);
        let mut decimal = number.split('.');
        let well_formed = number.parse::<f64>().is_ok_and(|n| n > 0.0)
            && decimal.clone().count() <= 2
            && decimal.all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
        well_formed.then_some(value)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct TypeScriptSettings {
    /// `bundled` (the server's own TypeScript), `workspace` (`node_modules/typescript`),
    /// or a path to a TypeScript `lib` directory.
    pub version: String,
}

impl Default for TypeScriptSettings {
    fn default() -> Self {
        Self { version: "bundled".into() }
    }
}

/// Dependency scope for a module dependency or project library (IDEA's Modules › Dependencies).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DependencyScope {
    #[default]
    Compile,
    Test,
    Runtime,
    Provided,
}

/// A project-level library (Project Structure › Libraries).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectLibrary {
    pub name: String,
    /// Class archives (`.jar`) or class directories.
    pub classes: Vec<String>,
    /// Source archives (`-sources.jar`, `.zip`) or source directories.
    pub sources: Vec<String>,
    /// Documentation archives (`-javadoc.jar`) or directories.
    pub javadocs: Vec<String>,
    pub scope: DependencyScope,
}

/// Dependency entry of a module (Project Structure › Modules › Dependencies).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ModuleDependency {
    /// `"library"` (references a `ProjectLibrary` by name or path) or `"module"` (references another module).
    pub kind: String,
    pub target: String,
    pub scope: DependencyScope,
    pub exported: bool,
}

/// Per-module Project Structure overrides (SDK, language level, output paths, dependencies).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ModuleStructureSettings {
    /// Module SDK home override; empty = inherit Project SDK.
    pub jdk: String,
    /// Module language level override; empty = inherit Project language level.
    pub language_level: String,
    /// Module compiler output directory override; empty = inherit Project compiler output.
    pub compiler_output: String,
    /// Module test compiler output directory override; empty = default.
    pub test_compiler_output: String,
    /// Additional module dependencies.
    pub dependencies: Vec<ModuleDependency>,
}

/// Framework facet attached to a module (Project Structure › Facets).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct FacetConfig {
    /// `"web"` | `"spring"` | `"jpa"`.
    pub kind: String,
    /// Module relative path (`"."` for root module).
    pub module: String,
    /// Deployment descriptor path (e.g. `src/main/webapp/WEB-INF/web.xml`, `src/main/resources/META-INF/persistence.xml`).
    pub descriptor: String,
    /// Web resource root directory for Web facets (e.g. `src/main/webapp`).
    pub web_root: String,
}

/// Packaging type of a Project Structure artifact.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactKind {
    #[default]
    Jar,
    War,
    WarExploded,
}

/// Packaging artifact definition (Project Structure › Artifacts).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ArtifactConfig {
    pub name: String,
    pub kind: ArtifactKind,
    /// Module relative path (`"."` for root module).
    pub module: String,
    /// Output directory (relative to project root or absolute).
    pub output_directory: String,
    /// Main class for executable JAR artifacts.
    pub main_class: String,
    /// Project library names included in the packaged artifact (`WEB-INF/lib` or JAR manifest).
    pub include_libraries: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectStructureSettings {
    /// Project-relative folders, `/`-separated.
    pub source_roots: Vec<String>,
    pub test_roots: Vec<String>,
    pub resource_roots: Vec<String>,
    pub test_resource_roots: Vec<String>,
    /// Excluded from the project tree, search and indexing.
    pub excluded: Vec<String>,
    /// Auto-detected roots (from `pom.xml`, `build.gradle`, `Cargo.toml`, …) the user unmarked.
    pub unmarked: Vec<String>,
    /// Content roots besides the project folder (absolute paths), shown and searched with it.
    pub content_roots: Vec<String>,
    /// Other projects (absolute paths) this project depends on; indexed and navigable like content roots.
    pub dependencies: Vec<String>,
    /// Per-workspace-member dependencies: member root (IPC path) → the roots it depends on.
    /// A member not listed here (or with an empty list) navigates only into itself.
    pub member_dependencies: BTreeMap<String, Vec<String>>,
    /// "Exclude files": `;`-separated name patterns (`*.log;tmp*`) excluded at any depth.
    pub exclude_files: String,
    /// Project compiler output directory (relative to project root or absolute; empty = default).
    pub compiler_output: String,
    /// Per-module SDK, language level, output paths and dependency overrides, keyed by module relative path (`"."` for root).
    pub modules: BTreeMap<String, ModuleStructureSettings>,
    /// Project-level libraries (`JAR`s / class folders / source archives).
    pub libraries: Vec<ProjectLibrary>,
    /// Module framework facets (`web`, `spring`, `jpa`).
    pub facets: Vec<FacetConfig>,
    /// Packaging artifacts (`jar`, `war`, `warExploded`).
    pub artifacts: Vec<ArtifactConfig>,
}

impl ProjectStructureSettings {
    /// Overrides belong to the module's full path, never just its directory name.
    pub fn module_settings(
        &self,
        root: &std::path::Path,
        module: &std::path::Path,
    ) -> Option<&ModuleStructureSettings> {
        self.modules.iter().find_map(|(key, settings)| (root.join(key) == module).then_some(settings))
    }

    /// The "Exclude files" name patterns.
    pub fn exclude_file_patterns(&self) -> Vec<String> {
        self.exclude_files.split(';').map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned).collect()
    }
}

impl Settings {
    /// `files.exclude`, the ignored names and the Project Structure excluded folders as globs.
    pub fn exclude_globs(&self) -> Vec<String> {
        let mut out = self.file_excludes();
        for dir in &self.project_structure.excluded {
            let dir = dir.trim().trim_matches('/');
            if !dir.is_empty() {
                out.push(format!("/{dir}"));
            }
        }
        out
    }

    /// `files.exclude`, `files.ignoredNames` and the Project Structure "Exclude files"
    /// patterns (a bare name matches at any depth).
    pub fn file_excludes(&self) -> Vec<String> {
        let mut out = self.files.exclude.clone();
        out.extend(self.files.ignored_names.iter().filter(|n| !n.trim().is_empty()).cloned());
        out.extend(self.project_structure.exclude_file_patterns().into_iter().filter(|p| !p.contains('/')));
        out
    }

    pub fn ignored_names(&self) -> crate::ignored::IgnoredNames {
        crate::ignored::IgnoredNames::new(&self.files.ignored_names)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_close_settings_default_off_and_round_trip() {
        for old in [r#"{}"#, r#"{"general":{"confirmExit":false}}"#] {
            let settings: Settings = serde_json::from_str(old).unwrap();
            assert!(!settings.general.close_without_welcome);
            assert!(!settings.general.close_tabs_with_window);
        }
        for close_window in [false, true] {
            for close_tabs in [false, true] {
                let mut settings = Settings::default();
                settings.general.close_without_welcome = close_window;
                settings.general.close_tabs_with_window = close_tabs;
                let json = serde_json::to_value(&settings).unwrap();
                assert_eq!(json["general"]["closeWithoutWelcome"], close_window);
                assert_eq!(json["general"]["closeTabsWithWindow"], close_tabs);
                assert_eq!(serde_json::from_value::<Settings>(json).unwrap().general, settings.general);
            }
        }
    }

    #[test]
    fn cmake_profile_argument_arrays_round_trip() {
        let mut settings = Settings::default();
        assert!(settings.cmake.profiles.is_none());
        assert!(CMakeProfile::default().cmake_args.is_empty());
        assert!(CMakeProfile::default().build_args.is_empty());
        let profile = CMakeProfile {
            cmake_args: ["-DMESSAGE=two words", "-DQUOTE=\"hello\"", ""].map(String::from).into(),
            build_args: ["-j", "8", "--", "LABEL=it's a build"].map(String::from).into(),
            ..Default::default()
        };
        settings.cmake.profiles = Some(vec![profile.clone()]);
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["cmake"]["profiles"][0]["cmakeArgs"], serde_json::json!(profile.cmake_args));
        assert_eq!(value["cmake"]["profiles"][0]["buildArgs"], serde_json::json!(profile.build_args));
        assert_eq!(serde_json::from_value::<Settings>(value).unwrap(), settings);
    }

    #[test]
    fn file_icon_theme_options_default_empty_and_round_trip() {
        let old: Settings = serde_json::from_str(r#"{"appearance":{"fileIconTheme":"p/t"}}"#).unwrap();
        assert!(old.appearance.file_icon_theme_options.is_empty());
        let json = serde_json::json!({"appearance":{"fileIconThemeOptions":{"p/t":{
            "groups":{"tests":true},"choices":{"arrows":"plusminus"},"hideFiles":true,"hideFolders":false,"hollowFolders":true,"hideUiIcons":true,"hidePsiIcons":false,
            "monochrome":"#546e7a","saturation":5,"opacity":80,"iconSize":20,"rowHeight":30,"accent":"#009688"}}}});
        let settings: Settings = serde_json::from_value(json.clone()).unwrap();
        let options = &settings.appearance.file_icon_theme_options["p/t"];
        assert!(options.hide_files && options.hollow_folders && !options.hide_folders);
        assert!(options.hide_ui_icons && !options.hide_psi_icons);
        assert!(options.groups["tests"]);
        assert_eq!(options.choices["arrows"], "plusminus");
        assert_eq!(
            (options.saturation, options.opacity, options.icon_size, options.row_height),
            (Some(5), Some(80), Some(20), Some(30))
        );
        assert_eq!(options.monochrome.as_deref(), Some("#546e7a"));
        assert_eq!(options.accent.as_deref(), Some("#009688"));
        let value = serde_json::to_value(&settings).unwrap();
        let restored: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(restored, settings);
        let plain = serde_json::to_value(FileIconThemeOptions::default()).unwrap();
        assert_eq!(plain["hideFiles"], false);
        assert_eq!(plain["hideUiIcons"], false);
        assert_eq!(plain["hidePsiIcons"], false);
        assert_eq!(plain["monochrome"], serde_json::Value::Null);
        assert_eq!(plain["groups"], serde_json::json!({}));
    }

    #[test]
    fn ui_font_fallback_defaults_empty_and_round_trips() {
        let old: Settings = serde_json::from_str(r#"{"appearance":{"useCustomFont":true}}"#).unwrap();
        assert!(old.appearance.ui_font_fallback.is_empty());
        for family in ["", "Songti SC", "Maple Mono NF CN"] {
            let mut settings = Settings::default();
            settings.appearance.ui_font_fallback = family.into();
            let json = serde_json::to_value(&settings).unwrap();
            assert_eq!(json["appearance"]["uiFontFallback"], family);
            let restored: Settings = serde_json::from_value(json).unwrap();
            assert_eq!(restored.appearance.ui_font_fallback, family);
        }
    }

    #[test]
    fn docstring_format_defaults_and_round_trips() {
        let old: Settings = serde_json::from_str(r#"{"editor":{"semanticHighlighting":true}}"#).unwrap();
        assert_eq!(old.editor.docstring_format, "rest");
        assert_eq!(Settings::default().editor.docstring_format, "rest");
        for format in ["plain", "rest", "epytext", "google", "numpy"] {
            let mut settings = Settings::default();
            settings.editor.docstring_format = format.into();
            let json = serde_json::to_value(&settings).unwrap();
            assert_eq!(json["editor"]["docstringFormat"], format);
            let restored: Settings = serde_json::from_value(json).unwrap();
            assert_eq!(restored.editor.docstring_format, format);
        }
    }

    #[test]
    fn tool_window_badges_default_on_and_round_trip() {
        let old: Settings = serde_json::from_str(r#"{"appearance":{"showToolWindowNames":true}}"#).unwrap();
        assert!(old.appearance.show_tool_window_badges);
        assert!(Settings::default().appearance.show_tool_window_badges);
        for enabled in [false, true] {
            let mut settings = Settings::default();
            settings.appearance.show_tool_window_badges = enabled;
            let json = serde_json::to_value(&settings).unwrap();
            assert_eq!(json["appearance"]["showToolWindowBadges"], enabled);
            let restored: Settings = serde_json::from_value(json).unwrap();
            assert_eq!(restored.appearance.show_tool_window_badges, enabled);
        }
    }

    #[test]
    fn double_click_opens_diff_is_unset_by_default_and_round_trips() {
        let old: Settings = serde_json::from_str(r#"{"vcs":{"commit":{"nonModal":true}}}"#).unwrap();
        assert_eq!(old.vcs.commit.double_click_opens_diff, None);
        // The unset value shows up as `null` in the defaults: `SettingsStore::set` only
        // accepts a key path it finds there.
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(json["vcs"]["commit"]["doubleClickOpensDiff"], serde_json::Value::Null);
        for on in [true, false] {
            let mut settings = Settings::default();
            settings.vcs.commit.double_click_opens_diff = Some(on);
            let json = serde_json::to_value(&settings).unwrap();
            assert_eq!(json["vcs"]["commit"]["doubleClickOpensDiff"], on);
            let restored: Settings = serde_json::from_value(json).unwrap();
            assert_eq!(restored.vcs.commit.double_click_opens_diff, Some(on));
        }
        // Explicit `null` reads back as unset.
        let cleared: Settings = serde_json::from_str(r#"{"vcs":{"commit":{"doubleClickOpensDiff":null}}}"#).unwrap();
        assert_eq!(cleared.vcs.commit.double_click_opens_diff, None);
    }

    #[test]
    fn agent_meters_default_and_round_trip() {
        let old: Settings = serde_json::from_str(r#"{"agents":{"showCost":true}}"#).unwrap();
        assert!(old.agents.show_cost);
        assert!(old.agents.show_context_usage && old.agents.show_work_time && old.agents.show_usage_limits);
        assert!(!Settings::default().agents.show_cost);
        let mut settings = Settings::default();
        settings.agents.show_usage_limits = false;
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["agents"]["showUsageLimits"], false);
        let restored: Settings = serde_json::from_value(json).unwrap();
        assert_eq!(restored.agents, settings.agents);
    }

    #[test]
    fn hand_edited_agent_values_it_does_not_know_keep_the_rest() {
        let settings: Settings = serde_json::from_str(
            r#"{"editor":{"fontSize":17},"agents":{"thinking":"open","sendWith":"modEnter",
                "defaults":{"claude":{"model":"opus","effort":3},"codex":"x"}}}"#,
        )
        .unwrap();
        assert_eq!(settings.editor.font_size, 17.0);
        assert_eq!(settings.agents.thinking, ThinkingDisplay::Auto);
        assert_eq!(settings.agents.send_with, SendKey::ModEnter);
        assert_eq!(
            settings.agents.defaults,
            BTreeMap::from([("claude".into(), BTreeMap::from([("model".into(), "opus".into())]))])
        );
    }

    #[test]
    fn main_menu_style_defaults_and_round_trips() {
        let old: Settings = serde_json::from_str(r#"{"appearance":{"compactMode":true}}"#).unwrap();
        assert_eq!(old.appearance.main_menu_style, "hamburger");
        assert!(old.appearance.main_menu_alt);
        let merged: Settings = serde_json::from_str(r#"{"appearance":{"mainMenuStyle":"merged"}}"#).unwrap();
        assert_eq!(merged.appearance.main_menu_style, "merged");
        assert_eq!(serde_json::to_value(merged).unwrap()["appearance"]["mainMenuStyle"], "merged");
        let off: Settings = serde_json::from_str(r#"{"appearance":{"mainMenuAlt":false}}"#).unwrap();
        assert!(!off.appearance.main_menu_alt);
        assert_eq!(serde_json::to_value(off).unwrap()["appearance"]["mainMenuAlt"], false);
    }

    #[test]
    fn editor_font_weights_default_to_regular_and_bold() {
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(json["editor"]["fontWeight"], 400);
        assert_eq!(json["editor"]["boldFontWeight"], 700);
        let s: Settings = serde_json::from_str(r#"{"editor":{"fontWeight":300,"boldFontWeight":600}}"#).unwrap();
        assert_eq!((s.editor.font_weight, s.editor.bold_font_weight), (300, 600));
        assert_eq!(s.editor.font_size, 13.0);
    }

    #[test]
    fn keymap_overrides_are_camel_case_and_default_empty() {
        let s: Settings =
            serde_json::from_str(r#"{"keymapOverrides":{"file.save":["Meta+S","Ctrl+S"],"vcs.commit":[]}}"#).unwrap();
        assert_eq!(s.keymap_overrides["file.save"], vec!["Meta+S", "Ctrl+S"]);
        assert!(s.keymap_overrides["vcs.commit"].is_empty());
        assert_eq!(s.keymap, default_keymap());
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(json["keymapOverrides"], serde_json::json!({}));
    }

    #[test]
    fn custom_keymaps_round_trip() {
        let s: Settings = serde_json::from_str(
            r#"{"keymap":"custom.mine","customKeymaps":{"custom.mine":{"name":"Mine","parent":"vscode-macos","overrides":{"file.save":[]}}}}"#,
        )
        .unwrap();
        let k = &s.custom_keymaps["custom.mine"];
        assert_eq!((k.name.as_str(), k.parent.as_str()), ("Mine", "vscode-macos"));
        assert!(k.overrides["file.save"].is_empty());
        assert_eq!(serde_json::to_value(Settings::default()).unwrap()["customKeymaps"], serde_json::json!({}));
    }

    #[test]
    fn exclude_files_patterns_join_the_file_excludes() {
        let s: Settings = serde_json::from_str(
            r#"{"files":{"exclude":[],"ignoredNames":[]},"projectStructure":{"excludeFiles":" *.log ; tmp*;;"}}"#,
        )
        .unwrap();
        assert_eq!(s.project_structure.exclude_file_patterns(), vec!["*.log", "tmp*"]);
        assert_eq!(s.file_excludes(), vec!["*.log", "tmp*"]);
        assert!(Settings::default().files.file_types.is_empty());
    }

    #[test]
    fn project_structure_modules_libraries_facets_and_artifacts_round_trip() {
        let old: Settings = serde_json::from_str(r#"{"projectStructure":{"sourceRoots":["src"]}}"#).unwrap();
        assert!(old.project_structure.compiler_output.is_empty());
        assert!(old.project_structure.modules.is_empty());
        assert!(old.project_structure.libraries.is_empty());
        assert!(old.project_structure.facets.is_empty());
        assert!(old.project_structure.artifacts.is_empty());
        assert!(old.languages.java.language_level.is_empty());

        let mut settings = Settings::default();
        settings.languages.java.language_level = "21".into();
        settings.project_structure.compiler_output = "out/production".into();
        settings.project_structure.modules.insert(
            "backend".into(),
            ModuleStructureSettings {
                jdk: "/opt/jdk-21".into(),
                language_level: "21".into(),
                compiler_output: "backend/target/classes".into(),
                test_compiler_output: "backend/target/test-classes".into(),
                dependencies: vec![ModuleDependency {
                    kind: "library".into(),
                    target: "custom-lib".into(),
                    scope: DependencyScope::Compile,
                    exported: true,
                }],
            },
        );
        settings.project_structure.libraries.push(ProjectLibrary {
            name: "custom-lib".into(),
            classes: vec!["lib/custom.jar".into()],
            sources: vec!["lib/custom-sources.jar".into()],
            javadocs: Vec::new(),
            scope: DependencyScope::Compile,
        });
        settings.project_structure.facets.push(FacetConfig {
            kind: "web".into(),
            module: "backend".into(),
            descriptor: "src/main/webapp/WEB-INF/web.xml".into(),
            web_root: "src/main/webapp".into(),
        });
        settings.project_structure.artifacts.push(ArtifactConfig {
            name: "backend:war exploded".into(),
            kind: ArtifactKind::WarExploded,
            module: "backend".into(),
            output_directory: "out/artifacts/backend_war_exploded".into(),
            main_class: String::new(),
            include_libraries: vec!["custom-lib".into()],
        });

        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["languages"]["java"]["languageLevel"], "21");
        assert_eq!(value["projectStructure"]["compilerOutput"], "out/production");
        assert_eq!(value["projectStructure"]["artifacts"][0]["kind"], "warExploded");
        let restored: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(restored, settings);
    }
}

#[cfg(test)]
mod maven_linkage_tests {
    use super::*;

    #[test]
    fn maven_runner_jre_defaults_and_round_trips() {
        let old: MavenSettings = serde_json::from_str(r#"{"home":"/opt/maven"}"#).unwrap();
        assert!(old.runner_jre.is_empty());
        assert!(MavenSettings::default().runner_jre.is_empty());
        let settings = MavenSettings { runner_jre: "/opt/jdk-21".into(), ..old };
        let encoded = serde_json::to_string(&settings).unwrap();
        assert!(encoded.contains(r#""runnerJre":"/opt/jdk-21""#));
        assert_eq!(serde_json::from_str::<MavenSettings>(&encoded).unwrap(), settings);
    }

    #[test]
    fn maven_linkage_defaults_and_round_trips() {
        let old: MavenSettings = serde_json::from_str(r#"{"home":"/opt/maven"}"#).unwrap();
        assert!(old.unlinked_projects.is_empty());
        let settings =
            MavenSettings { unlinked_projects: vec!["pom.xml".into(), "services/api/pom.xml".into()], ..old };
        let encoded = serde_json::to_string(&settings).unwrap();
        assert!(encoded.contains("unlinkedProjects"));
        assert_eq!(serde_json::from_str::<MavenSettings>(&encoded).unwrap(), settings);
    }

    #[test]
    fn daemon_settings_round_trip() {
        // Old settings files predate the daemon fields; `serde(default)` keeps them loadable.
        let old: MavenSettings = serde_json::from_str(r#"{"home":"/opt/maven"}"#).unwrap();
        assert!(!old.daemon && old.mvnd_home.is_empty());
        let settings = MavenSettings { daemon: true, mvnd_home: "/opt/mvnd".into(), ..old };
        let encoded = serde_json::to_string(&settings).unwrap();
        assert!(encoded.contains("\"daemon\":true") && encoded.contains("mvndHome"));
        assert_eq!(serde_json::from_str::<MavenSettings>(&encoded).unwrap(), settings);
    }

    #[test]
    fn thread_count_takes_counts_and_core_multipliers_only() {
        let threads = |t: &str| {
            let m = MavenSettings { threads: t.into(), ..Default::default() };
            m.thread_count().map(str::to_owned)
        };
        // Empty = Maven's default (one thread per module).
        assert_eq!(threads("").as_deref(), None);
        assert_eq!(threads("   ").as_deref(), None);
        // A thread count, and a core multiplier whose fraction may be decimal.
        assert_eq!(threads("4").as_deref(), Some("4"));
        assert_eq!(threads(" 2 ").as_deref(), Some("2"));
        assert_eq!(threads("1C").as_deref(), Some("1C"));
        assert_eq!(threads("2.0C").as_deref(), Some("2.0C"));
        assert_eq!(threads("0.5C").as_deref(), Some("0.5C"));
        // Everything else a `-T` would make every Maven run reject is dropped.
        assert_eq!(threads("abc").as_deref(), None);
        assert_eq!(threads("4x").as_deref(), None);
        assert_eq!(threads("0").as_deref(), None);
        assert_eq!(threads("-4").as_deref(), None);
        assert_eq!(threads("1e3").as_deref(), None);
        assert_eq!(threads("2..5C").as_deref(), None);
    }

    #[test]
    fn maven_profiles_combine_settings_and_tool_window_choices() {
        let settings = MavenSettings { active_profiles: " a, b, ,a ".into(), ..Default::default() };
        assert_eq!(settings.profiles(&["!b".into(), "c".into(), "a".into()]), ["a", "!b", "c"]);
        let settings = MavenSettings { active_profiles: "!a".into(), ..Default::default() };
        assert_eq!(settings.profiles(&["a".into()]), ["!a"]);
    }

    #[test]
    fn maven_profiles_and_toolchains_round_trip_and_default_to_empty() {
        let old: MavenSettings = serde_json::from_str(r#"{"home":"/opt/maven"}"#).unwrap();
        assert!(old.toolchains.is_empty() && old.active_profiles.is_empty());
        let settings =
            MavenSettings { toolchains: "config files/toolchains.xml".into(), active_profiles: "a,b,!c".into(), ..old };
        let encoded = serde_json::to_string(&settings).unwrap();
        assert_eq!(serde_json::from_str::<MavenSettings>(&encoded).unwrap(), settings);
    }

    #[test]
    fn thread_count_round_trips_and_defaults_to_empty() {
        // Old settings files predate the thread count; `serde(default)` keeps them loadable.
        let old: MavenSettings = serde_json::from_str(r#"{"home":"/opt/maven"}"#).unwrap();
        assert!(old.threads.is_empty() && old.thread_count().is_none());
        let settings = MavenSettings { threads: "2C".into(), ..old };
        let encoded = serde_json::to_string(&settings).unwrap();
        assert!(encoded.contains("\"threads\":\"2C\""));
        assert_eq!(serde_json::from_str::<MavenSettings>(&encoded).unwrap(), settings);
    }
}

#[cfg(test)]
mod java_settings_tests {
    use super::*;

    #[test]
    fn shared_jdtls_defaults_off_and_round_trips() {
        for old in [r#"{}"#, r#"{"jdk":"/jdk"}"#] {
            let java: JavaSettings = serde_json::from_str(old).unwrap();
            assert!(!java.jdtls_shared);
        }
        for shared in [false, true] {
            let java = JavaSettings { jdtls_shared: shared, ..JavaSettings::default() };
            let json = serde_json::to_value(&java).unwrap();
            assert_eq!(json["jdtlsShared"], serde_json::json!(shared));
            assert_eq!(serde_json::from_value::<JavaSettings>(json).unwrap(), java);
        }
        assert!(serde_json::from_str::<JavaSettings>(r#"{"jdtlsShared":"true"}"#).is_err());
    }
}

#[cfg(test)]
mod gradle_settings_tests {
    use super::*;

    #[test]
    fn absent_and_explicitly_empty_gradle_links_remain_distinct() {
        let automatic: GradleSettings = serde_json::from_str("{}").unwrap();
        let unlinked: GradleSettings = serde_json::from_str(r#"{"linkedProjects":[]}"#).unwrap();
        assert_eq!(automatic.linked_projects, None);
        assert_eq!(unlinked.linked_projects, Some(vec![]));
        let restored: GradleSettings = serde_json::from_str(&serde_json::to_string(&unlinked).unwrap()).unwrap();
        assert_eq!(restored.linked_projects, Some(vec![]));
    }

    #[test]
    fn defaults_and_round_trip() {
        let old: JavaSettings = serde_json::from_str(r#"{"jdk":"/jdk"}"#).unwrap();
        assert_eq!(old.gradle, GradleSettings::default());
        for distribution in [GradleDistribution::Wrapper, GradleDistribution::Local] {
            let mut settings = Settings::default();
            settings.languages.java.gradle = GradleSettings {
                jvm: "/jdk21".into(),
                distribution,
                home: "/gradle".into(),
                user_home: "/cache/gradle".into(),
                run_using: GradleRunUsing::Ide,
                linked_projects: Some(vec!["backend".into(), "../shared".into()]),
            };
            let restored: Settings = serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
            assert_eq!(restored.languages.java.gradle, settings.languages.java.gradle);
        }
    }
}

#[cfg(test)]
mod go_module_tests {
    use super::*;
    #[test]
    fn old_go_settings_inherit_module_defaults() {
        let old: GoSettings = serde_json::from_str(r#"{"goroot":"/go"}"#).unwrap();
        assert!(old.modules.auto_vendor);
        assert!(old.modules.env.is_empty());
        let configured: GoSettings =
            serde_json::from_str(r#"{"modules":{"autoVendor":false,"env":{"GOPRIVATE":"example.com/private"}}}"#)
                .unwrap();
        assert!(!configured.modules.auto_vendor);
        assert_eq!(configured.modules.env["GOPRIVATE"], "example.com/private");
    }
}
