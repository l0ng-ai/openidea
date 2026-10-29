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
    /// Where Open… puts a project while one is open: `ask` | `new` | `same`.
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
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            reopen_last_project: true,
            confirm_exit: false,
            open_project_in: "ask".into(),
            default_project_directory: String::new(),
            save_on_idle: false,
            idle_seconds: 15,
            date_format: DateFormatSettings::default(),
            power_save_mode: false,
            project_name: String::new(),
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AppearanceSettings {
    /// `dark` | `light` | `system` | `dark-hc` (high-contrast dark)
    pub theme: String,
    pub accent: String,
    pub ui_font_size: f32,
    pub locale: String,
    /// Follow the OS light/dark mode with the preferred themes below.
    pub sync_with_os: bool,
    pub preferred_light_theme: String,
    pub preferred_dark_theme: String,
    /// IDE zoom in percent (50–300).
    pub zoom: u32,
    /// Apply `ui_font_family` / `ui_font_size` (otherwise the theme's).
    pub use_custom_font: bool,
    pub ui_font_family: String,
    pub contrast_scrollbars: bool,
    /// Adjust colours for red-green vision deficiency.
    pub red_green_vision: bool,
    pub different_tool_window_background: bool,
    pub compact_mode: bool,
    pub full_path_in_title: bool,
    pub project_colors_in_toolbar: bool,
    pub dnd_with_alt_only: bool,
    pub menu_icons: bool,
    /// `subpixel` | `greyscale` | `none`
    pub ide_antialiasing: String,
    pub editor_antialiasing: String,
    pub show_tool_window_bars: bool,
    pub show_tool_window_names: bool,
    pub widescreen_tool_windows: bool,
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
            zoom: 100,
            use_custom_font: false,
            ui_font_family: "Inter".into(),
            contrast_scrollbars: false,
            red_green_vision: false,
            different_tool_window_background: false,
            compact_mode: false,
            full_path_in_title: false,
            project_colors_in_toolbar: true,
            dnd_with_alt_only: false,
            menu_icons: true,
            ide_antialiasing: "greyscale".into(),
            editor_antialiasing: "greyscale".into(),
            show_tool_window_bars: true,
            show_tool_window_names: false,
            widescreen_tool_windows: false,
            status_bar_widgets: BTreeMap::new(),
            main_toolbar: None,
        }
    }
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
    /// Color Scheme edits: scheme id → attribute id → override.
    pub color_overrides: BTreeMap<String, BTreeMap<String, TextAttributesOverride>>,
    /// Color Scheme › Language Defaults › Semantic highlighting: local variables and
    /// parameters get a colour derived from their name (IDEA's rainbow identifiers).
    pub semantic_highlighting: bool,
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
            semantic_highlighting: false,
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
            exclude: vec!["**/.git".into(), "**/node_modules".into(), "**/target".into()],
            ignored_names: crate::ignored::DEFAULT_IGNORED_NAMES.iter().map(|s| (*s).into()).collect(),
            trim_trailing_whitespace: true,
            ensure_final_newline: true,
            local_history_days: 5,
            local_history_max_mb: 512,
            file_types: BTreeMap::new(),
            file_type_overrides: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct LanguagesSettings {
    pub python: PythonSettings,
    pub node: NodeSettings,
    pub rust: RustSettings,
    pub go: GoSettings,
    pub typescript: TypeScriptSettings,
    pub java: JavaSettings,
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
pub struct NodeSettings {
    /// `node` executable; empty = the one on `PATH`.
    pub interpreter: String,
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
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct JavaSettings {
    /// Project JDK home; empty = per module, the installed JDK matching the
    /// Java version it targets.
    pub jdk: String,
    /// JDK home the Java language server (jdtls) runs on, apart from the project
    /// JDK (IDEA's "JDK for importer"); empty = the project JDK when new enough,
    /// else the first installed one that is.
    pub jdtls_jdk: String,
    /// Extra JVM options for the Java language server (jdtls), space-separated
    /// (VS Code's `java.jdt.ls.vmargs`).
    pub jdtls_vm_args: String,
    /// Build Tools › Maven.
    pub maven: MavenSettings,
}

/// Build Tools › Maven.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct MavenSettings {
    /// Maven home (or its `mvn` executable); empty = the project's `mvnw`, else `mvn` on `PATH`.
    pub home: String,
    /// User `settings.xml` (`-s`); empty = `~/.m2/settings.xml`.
    pub user_settings: String,
    /// Local repository (`-Dmaven.repo.local`); empty = from `settings.xml`.
    pub local_repository: String,
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
    /// "Exclude files": `;`-separated name patterns (`*.log;tmp*`) excluded at any depth.
    pub exclude_files: String,
}

impl ProjectStructureSettings {
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
}
