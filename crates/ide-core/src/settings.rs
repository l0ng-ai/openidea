//! User-facing settings. Layered: defaults → global `settings.toml` →
//! project `.openidea/settings.toml`. Loading/merging lives in `ide-workspace`.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

pub use crate::editor_settings::*;
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
            languages: LanguagesSettings::default(),
            project_structure: ProjectStructureSettings::default(),
            vcs: VcsSettings::default(),
            console: ConsoleSettings::default(),
            debugger: DebuggerSettings::default(),
            run: RunSettings::default(),
            terminal: TerminalSettings::default(),
            actions_on_save: ActionsOnSaveSettings::default(),
            external_tools: Vec::new(),
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
            show_tool_window_names: true,
            widescreen_tool_windows: false,
            status_bar_widgets: BTreeMap::new(),
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
    pub ligatures: bool,
    /// Fallback font for glyphs the main font lacks; empty = none.
    pub fallback_font: String,
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
            ligatures: false,
            fallback_font: String::new(),
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
    /// Extra JVM options for the Java language server (jdtls), space-separated
    /// (VS Code's `java.jdt.ls.vmargs`).
    pub jdtls_vm_args: String,
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

    /// `files.exclude` plus `files.ignoredNames` (a bare name matches at any depth).
    pub fn file_excludes(&self) -> Vec<String> {
        let mut out = self.files.exclude.clone();
        out.extend(self.files.ignored_names.iter().filter(|n| !n.trim().is_empty()).cloned());
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
}
