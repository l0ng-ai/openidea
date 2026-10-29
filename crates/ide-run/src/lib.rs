//! Run configurations and process management.

mod config;
mod detect;
pub mod envfile;
pub mod gradle_jvm;
pub mod java_cmdline;
pub mod junit;
mod process;
pub mod python_path;
mod utf8;
pub mod which;
pub mod wrap;

pub use process::{ProcessManager, StartOptions};

use ide_core::{IdeResult, RunId};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunConfig {
    /// Stable id, e.g. `npm:dev`, `cargo:run:app`, or a uuid for user-defined.
    pub id: String,
    pub name: String,
    /// `npm` | `cargo` | `gradle` | `maven` | `go` | `python` | `pytest` | `make` | `shell` …
    pub kind: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<ide_core::IpcPath>,
    pub env: BTreeMap<String, String>,
    /// Detected configs are regenerated; user configs persist in `.openidea/run.toml`.
    pub detected: bool,
    /// Test runner configs render results in the test tree.
    pub is_test: bool,
    /// DAP adapter that can debug this config, if any.
    pub debug_adapter: Option<String>,
    /// "Allow multiple instances": Run on a running config starts another one instead of restarting it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[specta(optional)]
    pub allow_parallel: bool,
    /// Options of user-defined configurations (all optional; old `run.toml` files load unchanged).
    #[serde(flatten)]
    pub extras: RunExtras,
}

/// A step run before a configuration launches; a failing step aborts the launch.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BeforeLaunchTask {
    /// `run` (another configuration, `target` = its id) | `build` | `tool` (external tool id) |
    /// `command` (a shell command line) | `toolWindow` (tool window id).
    pub kind: String,
    #[serde(default)]
    pub target: String,
}

fn yes() -> bool {
    true
}

fn is_true(b: &bool) -> bool {
    *b
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunExtras {
    /// Values of the configuration type's own form fields (the command line derives from them).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(optional)]
    pub params: BTreeMap<String, String>,
    /// Folder in the Run/Debug Configurations tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub folder: Option<String>,
    /// Stored in the workspace (`.openidea/run.local.toml`, not shared) instead of `run.toml`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[specta(optional)]
    pub local: bool,
    /// Off: the process gets only the configured variables.
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    #[specta(optional)]
    pub include_system_env: bool,
    /// `.env` files (relative to the project root) loaded before `env`, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[specta(optional)]
    pub env_files: Vec<String>,
    /// "Redirect input from": the process reads this file as stdin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub stdin_file: Option<String>,
    /// "Save console output to file" (overwritten on each run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub output_file: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[specta(optional)]
    pub before_launch: Vec<BeforeLaunchTask>,
    /// Compound configurations: ids of the configurations started together.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[specta(optional)]
    pub compound: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[specta(optional)]
    pub show_on_stdout: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[specta(optional)]
    pub show_on_stderr: bool,
    /// Overrides Settings › Run › "Show the Run tool window when a process starts".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub open_tool_window: Option<bool>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[specta(optional)]
    pub focus_tool_window: bool,
    /// "Emulate terminal in output console": the process runs on a pseudo-terminal
    /// (colours, line editing, full-screen programs); the console renders it as a terminal.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[specta(optional)]
    pub emulate_terminal: bool,
    /// Shell command line run on Stop before the process is signalled (e.g. `docker stop <name>`),
    /// with the run's working directory and environment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub stop_command: Option<String>,
    /// Settings › Run Targets id the process runs on (over SSH); `None` = this machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub target: Option<String>,
}

impl Default for RunExtras {
    fn default() -> Self {
        Self {
            params: BTreeMap::new(),
            folder: None,
            local: false,
            include_system_env: true,
            env_files: Vec::new(),
            stdin_file: None,
            output_file: None,
            before_launch: Vec::new(),
            compound: Vec::new(),
            show_on_stdout: false,
            show_on_stderr: false,
            open_tool_window: None,
            focus_tool_window: false,
            emulate_terminal: false,
            stop_command: None,
            target: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutputChunk {
    Stdout {
        text: String,
    },
    Stderr {
        text: String,
    },
    /// System message from the IDE (command line echo, exit code).
    System {
        text: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub id: RunId,
    pub config_id: String,
    pub name: String,
    pub pid: Option<u32>,
    pub running: bool,
    /// Runs on a pseudo-terminal: output is raw terminal data, input goes in keystroke by keystroke.
    pub pty: bool,
}

/// Detects configs from package.json scripts, Cargo.toml targets, build.gradle(.kts),
/// pom.xml, go.mod, pyproject/pytest, Makefile.
pub fn detect(root: &Path) -> Vec<RunConfig> {
    detect::detect(root)
}

/// Reads `<root>/.openidea/run.toml`; a missing file yields no configs.
pub fn load_user_configs(root: &Path) -> IdeResult<Vec<RunConfig>> {
    config::load(root)
}

/// Writes `<root>/.openidea/run.toml` (and the workspace-local `run.local.toml` for
/// configurations not stored as project files), preserving unrelated content.
pub fn save_user_configs(root: &Path, configs: &[RunConfig]) -> IdeResult<()> {
    config::save(root, configs)
}

/// Configuration templates (per-type defaults for new configurations) from `run.toml`.
pub fn load_templates(root: &Path) -> IdeResult<Vec<RunConfig>> {
    config::load_templates(root)
}

pub fn save_templates(root: &Path, templates: &[RunConfig]) -> IdeResult<()> {
    config::save_templates(root, templates)
}

/// The environment runs inherit (unless "Include system environment variables" is off).
pub fn system_env() -> BTreeMap<String, String> {
    ide_core::process::host_vars().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect()
}

/// Path of the user run configuration file for `root`.
pub fn user_configs_path(root: &Path) -> PathBuf {
    config::config_path(root)
}
