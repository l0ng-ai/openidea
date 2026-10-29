//! Settings of IDEA's Version Control, Build, Execution, Deployment and Tools
//! groups. The fields hang off `Settings` in `settings.rs`.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

/// Version Control (main page) and its sub-pages.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct VcsSettings {
    /// Colour folders that contain changed files (project tree, tabs).
    pub show_dirty_directories: bool,
    /// Stop file history (Show History) after `history_limit` commits.
    pub limit_history: bool,
    pub history_limit: u32,
    pub git: GitSettings,
    pub commit: CommitSettings,
    pub confirmation: VcsConfirmationSettings,
    pub shelf: ShelfSettings,
    /// Issue Navigation: commit-message patterns turned into links.
    pub issue_navigation: Vec<IssueLink>,
}

impl Default for VcsSettings {
    fn default() -> Self {
        Self {
            // IDEA's VcsConfiguration.SHOW_DIRTY_RECURSIVELY is off by default.
            show_dirty_directories: false,
            limit_history: true,
            history_limit: 1000,
            git: GitSettings::default(),
            commit: CommitSettings::default(),
            confirmation: VcsConfirmationSettings::default(),
            shelf: ShelfSettings::default(),
            issue_navigation: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GitSettings {
    /// Path to the git executable; empty = auto-detect.
    pub executable: String,
    /// Default of Update Project: `merge` | `rebase`.
    pub update_method: String,
    /// Push rejected (non-fast-forward): update the branch and push again.
    pub auto_update_on_push_rejected: bool,
    pub warn_crlf: bool,
    pub warn_detached_head: bool,
    /// Background check for incoming commits: `auto` | `always` | `never`.
    pub incoming_check: String,
    /// Branch name globs, `;`/`,`-separated; force push to them is prohibited.
    pub protected_branches: String,
    /// Initial state of Commit Options › Sign-off Commit.
    pub sign_off: bool,
    /// Ask before committing files larger than `large_file_mb`.
    pub warn_large_files: bool,
    pub large_file_mb: u32,
    /// Ask before committing names that are invalid on Windows or differ only in case.
    pub warn_bad_file_names: bool,
    /// Commit and Push opens the Push dialog; otherwise it pushes right away.
    pub show_push_dialog: bool,
    /// With `show_push_dialog`: only for commits to protected branches.
    pub push_dialog_only_protected: bool,
    /// Stashes and shelves share one tab.
    pub combine_stash_and_shelf: bool,
}

impl Default for GitSettings {
    fn default() -> Self {
        Self {
            executable: String::new(),
            update_method: "merge".into(),
            auto_update_on_push_rejected: false,
            warn_crlf: true,
            warn_detached_head: true,
            incoming_check: "auto".into(),
            protected_branches: "master; main".into(),
            sign_off: false,
            warn_large_files: true,
            large_file_mb: 50,
            warn_bad_file_names: true,
            show_push_dialog: true,
            push_dialog_only_protected: false,
            combine_stash_and_shelf: false,
        }
    }
}

/// Version Control › Commit: commit checks and commit-message inspections.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct CommitSettings {
    /// Commit from the Commit tool window; off = Local Changes in the Git tool
    /// window and a Commit dialog.
    pub non_modal: bool,
    /// Start with an empty message instead of the last one / the changelist's.
    pub clear_initial_message: bool,
    pub analyze_code: bool,
    pub check_todo: bool,
    pub reformat: bool,
    pub optimize_imports: bool,
    pub cleanup: bool,
    pub blank_line_after_subject: bool,
    pub limit_subject: bool,
    pub subject_limit: u32,
    pub limit_body: bool,
    pub body_limit: u32,
    pub show_right_margin: bool,
    pub wrap_at_margin: bool,
}

impl Default for CommitSettings {
    fn default() -> Self {
        Self {
            non_modal: true,
            clear_initial_message: false,
            analyze_code: true,
            check_todo: true,
            reformat: false,
            optimize_imports: false,
            cleanup: false,
            blank_line_after_subject: true,
            limit_subject: true,
            subject_limit: 72,
            limit_body: false,
            body_limit: 72,
            show_right_margin: true,
            wrap_at_margin: false,
        }
    }
}

/// Version Control › Confirmation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct VcsConfirmationSettings {
    /// `ask` | `silently` | `never`.
    pub on_create: String,
    pub on_delete: String,
    /// Update Project opens its options dialog first.
    pub show_update_options: bool,
    pub confirm_drop_commits: bool,
    /// After a patch is saved: `ask` | `no` | `reveal` (show it in the file manager).
    pub on_patch_created: String,
}

impl Default for VcsConfirmationSettings {
    fn default() -> Self {
        Self {
            on_create: "ask".into(),
            on_delete: "ask".into(),
            show_update_options: true,
            confirm_drop_commits: true,
            on_patch_created: "ask".into(),
        }
    }
}

/// Version Control › Shelf.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ShelfSettings {
    /// Initial state of Unshelve's "Remove successfully applied files from the shelf".
    pub remove_applied: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct IssueLink {
    /// Regular expression matched in commit messages.
    pub pattern: String,
    /// Link with `$0` (whole match) / `$1`… (groups) placeholders.
    pub link: String,
}

/// Build, Execution, Deployment › Console.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ConsoleSettings {
    pub soft_wrap: bool,
    pub override_buffer: bool,
    pub buffer_kb: u32,
    /// Encoding of process output (`UTF-8`, `windows-1252`, `GBK`…).
    pub encoding: String,
    /// Consecutive lines containing any of these are folded.
    pub fold_patterns: Vec<String>,
}

impl Default for ConsoleSettings {
    fn default() -> Self {
        Self {
            soft_wrap: false,
            override_buffer: true,
            buffer_kb: 1024,
            encoding: "UTF-8".into(),
            fold_patterns: vec![
                "at java.base/jdk.internal.reflect.".into(),
                "at java.base/java.lang.reflect.Method.invoke".into(),
                "at org.junit.".into(),
                "at node:internal/".into(),
                "<frozen importlib._bootstrap".into(),
            ],
        }
    }
}

/// Build, Execution, Deployment › Debugger (+ Data Views, Stepping, Python Debugger).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct DebuggerSettings {
    pub show_on_breakpoint: bool,
    pub focus_app_on_breakpoint: bool,
    pub hide_on_termination: bool,
    pub breakpoints_any_file: bool,
    /// While suspended, hovering the start of a line shows a Run to Cursor button.
    pub run_to_cursor_inlay: bool,
    pub inline_values: bool,
    /// Data Views: list variables by name instead of the adapter's order.
    pub sort_values: bool,
    pub value_tooltip: bool,
    /// While suspended, selecting an expression shows its value.
    pub value_tooltip_on_selection: bool,
    pub value_tooltip_delay: u32,
    /// Stepping: do not step into library code (debugpy `justMyCode`, js-debug `skipFiles`).
    pub skip_library_code: bool,
    pub python: PythonDebuggerSettings,
}

impl Default for DebuggerSettings {
    fn default() -> Self {
        Self {
            show_on_breakpoint: true,
            focus_app_on_breakpoint: false,
            hide_on_termination: false,
            breakpoints_any_file: false,
            run_to_cursor_inlay: true,
            inline_values: true,
            sort_values: false,
            value_tooltip: true,
            value_tooltip_on_selection: true,
            value_tooltip_delay: 700,
            skip_library_code: true,
            python: PythonDebuggerSettings::default(),
        }
    }
}

/// Python Debugger (debugpy launch options).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct PythonDebuggerSettings {
    pub attach_subprocess: bool,
    pub gevent: bool,
}

impl Default for PythonDebuggerSettings {
    fn default() -> Self {
        Self { attach_subprocess: true, gevent: false }
    }
}

/// Run/Debug configuration behaviour.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct RunSettings {
    pub confirm_rerun: bool,
    /// Ask before closing a Run tab whose process is still running.
    pub confirm_terminate: bool,
    pub show_on_start: bool,
    /// Grace period between interrupt and kill when stopping a process.
    pub termination_timeout_ms: u32,
}

impl Default for RunSettings {
    fn default() -> Self {
        Self { confirm_rerun: true, confirm_terminate: true, show_on_start: true, termination_timeout_ms: 3000 }
    }
}

/// Tools › Terminal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalSettings {
    /// Empty = project root; relative paths resolve against it.
    pub start_directory: String,
    pub env: BTreeMap<String, String>,
    /// Shell command line; empty = the login shell.
    pub shell_path: String,
    pub tab_name: String,
    pub audible_bell: bool,
    pub close_on_exit: bool,
    pub mouse_reporting: bool,
    pub copy_on_selection: bool,
    pub paste_on_middle_click: bool,
    pub override_ide_shortcuts: bool,
    pub shell_integration: bool,
    pub highlight_hyperlinks: bool,
    pub option_as_meta: bool,
    /// Escape moves focus to the editor instead of reaching the shell.
    pub escape_to_editor: bool,
    /// `block` | `underline` | `bar`.
    pub cursor_shape: String,
    pub cursor_blink: bool,
    pub use_editor_font: bool,
    pub font_family: String,
    pub font_size: f32,
    /// Multiple of the cell height.
    pub line_height: f32,
    /// Font tried for glyphs the main font lacks; empty = none.
    pub fallback_font_family: String,
    /// Multiple of the cell width.
    pub column_width: f32,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            start_directory: String::new(),
            env: BTreeMap::new(),
            shell_path: String::new(),
            tab_name: "Local".into(),
            audible_bell: true,
            close_on_exit: true,
            mouse_reporting: true,
            copy_on_selection: false,
            paste_on_middle_click: true,
            override_ide_shortcuts: true,
            shell_integration: true,
            highlight_hyperlinks: true,
            option_as_meta: false,
            escape_to_editor: false,
            cursor_shape: "block".into(),
            cursor_blink: true,
            use_editor_font: true,
            font_family: "JetBrains Mono".into(),
            font_size: 13.0,
            line_height: 1.0,
            fallback_font_family: String::new(),
            column_width: 1.0,
        }
    }
}

/// Tools › Actions on Save (Reformat code is `editor.formatOnSave`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ActionsOnSaveSettings {
    pub optimize_imports: bool,
    /// Run code cleanup (`source.fixAll`).
    pub cleanup: bool,
}

/// Tools › External Tools entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ExternalTool {
    pub id: String,
    pub name: String,
    pub description: String,
    pub group: String,
    pub enabled: bool,
    pub program: String,
    /// Arguments with macros (`$FilePath$`, `$ProjectFileDir$`…), shell-quoted.
    pub arguments: String,
    pub working_directory: String,
    pub synchronize_after: bool,
    pub open_console: bool,
}

impl Default for ExternalTool {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            group: "External Tools".into(),
            enabled: true,
            program: String::new(),
            arguments: String::new(),
            working_directory: "$ProjectFileDir$".into(),
            synchronize_after: true,
            open_console: true,
        }
    }
}
