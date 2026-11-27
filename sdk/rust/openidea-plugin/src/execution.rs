//! Runs, keyed terminals and plugin-owned content editors (API 1.4).

use serde::{Deserialize, Serialize};

/// ContentAction data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentAction {
    pub id: String,
    pub label: String,
    pub icon: Option<String>,
    pub primary: bool,
    pub save: bool,
}

/// ContentTab data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentTab {
    pub key: String,
    pub title: String,
    pub file_name: Option<String>,
    pub language: Option<String>,
    pub content: String,
    pub read_only: bool,
    pub actions: Vec<ContentAction>,
}

/// ContentDiff data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDiff {
    pub left: String,
    pub right: String,
    pub left_label: Option<String>,
    pub right_label: Option<String>,
    pub title: Option<String>,
}

/// A file's before and after for `host::open_file_diff` (API 1.10): `None` is a side where the
/// file doesn't exist (an added file has no left side, a deleted one no right side).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub left: Option<String>,
    pub right: Option<String>,
    pub left_label: Option<String>,
    pub right_label: Option<String>,
    pub title: Option<String>,
}

impl From<ContentDiff> for FileDiff {
    fn from(v: ContentDiff) -> Self {
        Self {
            left: Some(v.left),
            right: Some(v.right),
            left_label: v.left_label,
            right_label: v.right_label,
            title: v.title,
        }
    }
}

/// ContentTabReply data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentTabReply {
    pub content: Option<String>,
    pub saved: Option<bool>,
    pub read_only: Option<bool>,
    pub status: Option<String>,
    pub error: Option<String>,
    pub diff: Option<ContentDiff>,
}

/// PluginRunConfiguration data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRunConfiguration {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub test: bool,
    pub framework: Option<String>,
}

/// RunExited data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunExited {
    pub id: String,
    pub config: String,
    pub status: Option<i32>,
    pub killed: bool,
}

/// TerminalExited data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExited {
    pub id: String,
    pub key: String,
    pub status: Option<i32>,
    pub closed: bool,
}

/// ContentTabAction data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentTabAction {
    pub request_id: String,
    pub key: String,
    pub action: String,
    pub content: String,
}

/// Incremental test tree data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestStart {
    pub id: String,
    pub parent: Option<String>,
    pub name: String,
    pub location: Option<crate::Location>,
}

/// Incremental test tree data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestPassed {
    pub id: String,
    pub duration_ms: Option<u32>,
}

/// Incremental test tree data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestFailed {
    pub id: String,
    pub duration_ms: Option<u32>,
    pub message: String,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub location: Option<crate::Location>,
}

/// Incremental test tree data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSkipped {
    pub id: String,
    pub reason: Option<String>,
}

/// Incremental test tree data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestOutput {
    pub id: String,
    pub text: String,
}

/// A test update, carried by the optional test-results export.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PluginTestEvent {
    SuiteStarted(TestStart),
    TestStarted(TestStart),
    Passed(TestPassed),
    Failed(TestFailed),
    Skipped(TestSkipped),
    Output(TestOutput),
    Other { kind: String, data: String },
}

/// Supplies complete project configurations; register with run_configurations.
pub trait RunConfigurations {
    fn configurations(&mut self, project_root: &str) -> Vec<PluginRunConfiguration>;
}
/// How Debug starts a launch configuration (API 1.10).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Debugger {
    /// Starts `program` under the debugger of this language id (its `[debugger]`), e.g. `python`.
    #[serde(rename_all = "camelCase")]
    Launch { language: String },
    /// Runs the configuration as Run does, then attaches to the first process of `kind`
    /// (`dotnet`, `node`, `python`, `go` or `native`) the run starts, optionally only one whose
    /// command line contains `command_contains`.
    #[serde(rename_all = "camelCase")]
    AttachChild { kind: String, command_contains: Option<String> },
}

/// A run configuration with an environment and a debugger (API 1.10).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLaunchConfiguration {
    pub config: PluginRunConfiguration,
    /// Variables added to the run's environment; a name the IDE's environment already has is refused.
    pub env: Vec<(String, String)>,
    /// None: Debug infers the debugger from a source file in the arguments.
    pub debugger: Option<Debugger>,
}

/// Output stream transport for a plugin-owned run configuration (API 1.18).
///
/// Ordinary pseudo-terminals combine stdout and stderr and can change
/// buffering, input handling, and terminal behavior.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputMode {
    /// Separate stdout and stderr pipes in the Run console (default).
    #[default]
    Pipes,
    /// Pseudo-terminal ("Emulate terminal in output console").
    Pty,
}

/// Per-launch options for [`host::start_run_with_options`](crate::host::start_run_with_options) (API 1.18).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStartOptions {
    pub debug: bool,
    /// Optional per-invocation override. A user-saved override wins over
    /// this value, which wins over the plugin configuration default.
    pub output_mode: Option<OutputMode>,
}

/// A run configuration with environment, debugger, and default output mode (API 1.18).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginExecutionConfiguration {
    pub launch: PluginLaunchConfiguration,
    /// Default output stream mode (`Pipes` or `Pty`).
    pub output_mode: OutputMode,
}

/// Supplies complete project configurations with environments and debuggers (API 1.10);
/// register with launch_configurations instead of run_configurations.
pub trait LaunchConfigurations {
    fn launch_configurations(&mut self, project_root: &str) -> Vec<PluginLaunchConfiguration>;
}
/// Supplies complete project configurations with environment, debugger, and output mode (API 1.18);
/// register with `execution_configurations` instead of `launch_configurations` or `run_configurations`.
pub trait ExecutionConfigurations {
    fn execution_configurations(&mut self, project_root: &str) -> Vec<PluginExecutionConfiguration>;
}
/// Parses bounded test output batches; register with test_results.
pub trait TestResults {
    fn parse(&mut self, config: &str, chunk: &str) -> Vec<PluginTestEvent>;
    /// Full replacement argv for test-tree name paths, or None when filtering is unsupported.
    fn select_tests(&mut self, _config: &str, _tests: &[Vec<String>]) -> Option<Vec<String>> {
        None
    }
}

impl crate::Event {
    /// Completion of a run started by this plugin, even after idle reclamation.
    pub fn run_exited(&self) -> Option<RunExited> {
        self.execution_event("run-exited")
    }
    /// Exactly one completion for a keyed terminal operation.
    pub fn terminal_exited(&self) -> Option<TerminalExited> {
        self.execution_event("terminal-exited")
    }
    /// A toolbar action or Save from this plugin's wasm content tab.
    pub fn content_tab_action(&self) -> Option<ContentTabAction> {
        self.execution_event("content-tab-action")
    }
    fn execution_event<T: serde::de::DeserializeOwned>(&self, expected: &str) -> Option<T> {
        let Self::Other { kind, data } = self else { return None };
        (kind == expected).then(|| serde_json::from_str(data).ok()).flatten()
    }
}

/// A plugin-owned argv wrapper for project runs (API 1.4).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRunTarget {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub workdir_args: Vec<String>,
    pub container_root: Option<String>,
    pub commands: Vec<(String, Vec<String>)>,
}

/// Per-command argv prefix and optional working-directory arguments (API 1.5).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandOverride {
    pub name: String,
    pub args: Vec<String>,
    /// None inherits the target's list; Some(Vec::new()) suppresses it.
    #[serde(default)]
    pub workdir_args: Option<Vec<String>>,
}

/// A project run target with per-command working-directory control (API 1.5).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRunTargetWithOverrides {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub workdir_args: Vec<String>,
    pub container_root: Option<String>,
    pub commands: Vec<PluginCommandOverride>,
}

impl From<PluginRunTarget> for PluginRunTargetWithOverrides {
    fn from(target: PluginRunTarget) -> Self {
        Self {
            id: target.id,
            name: target.name,
            program: target.program,
            args: target.args,
            workdir_args: target.workdir_args,
            container_root: target.container_root,
            commands: target
                .commands
                .into_iter()
                .map(|(name, args)| PluginCommandOverride { name, args, workdir_args: None })
                .collect(),
        }
    }
}

/// Operation about to launch through a plugin-owned run target (API 1.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunTargetOperation {
    Run,
    Test,
}

/// Launch metadata available to a target validator; arguments and environment are omitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunTargetLaunch {
    pub operation: RunTargetOperation,
    pub program: String,
    pub cwd: String,
}

/// A Run Anything entry (API 1.18).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunAnythingItem {
    /// What the list shows, such as `task build`.
    pub label: String,
    /// Grey text after the label.
    pub detail: Option<String>,
    /// The line Tab completes and Enter runs; `label` when `None`.
    pub line: Option<String>,
}

/// Run Anything (Ctrl Ctrl) for the prefixes declared under `[[contributes.runAnything]]`
/// (API 1.18); register with `register_plugin!(T, …, run_anything)`.
pub trait RunAnything {
    /// Entries for the field's `text`, which starts with `prefix` or is the start of it.
    /// Called while the user types: answer from what the plugin already knows (no process
    /// per keystroke). The IDE keeps the first 100 and drops answers slower than 300 ms.
    fn suggest(&mut self, project: &str, prefix: &str, text: &str) -> Vec<RunAnythingItem>;
    /// Runs `line` (its first word is `prefix`) from the invoking window, through the
    /// plugin's host calls such as [`crate::host::start_run`] or terminals. `true` claims
    /// the line; `false` leaves it to the IDE's other entries and finally the shell.
    fn run(&mut self, project: &str, prefix: &str, line: &str) -> bool;
}

/// Optional pre-launch validation; register with `run_target_validation`.
pub trait RunTargetValidation {
    /// Refuse with a user-facing explanation, or allow with `Ok(())`.
    fn validate(&mut self, project: &str, target_id: &str, launch: &RunTargetLaunch) -> Result<(), String>;
}

/// A completion for a field of one of the plugin's own run configurations (API 1.18).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunConfigurationCompletionItem {
    /// What the list shows, such as `build`.
    pub label: String,
    /// Grey text after the label, such as the file the entry comes from.
    pub detail: Option<String>,
    /// The text replacing `replace_start..replace_end`; `label` when `None`.
    pub insert: Option<String>,
    /// UTF-16 offsets into the field's text; the caret ends after the inserted text.
    pub replace_start: u32,
    pub replace_end: u32,
}

/// Completion in the fields of the plugin's own run configurations, in the Run/Debug
/// Configurations dialog (API 1.18); register with
/// `register_plugin!(T, …, run_configuration_completion)`.
pub trait RunConfigurationCompletion {
    /// Completions for `field` (`"arguments"` today; answer none for a field you don't
    /// know) of the configuration `config` (its id as the plugin reported it) in
    /// `project`. `text` is the field as typed: whitespace separates arguments and `'`
    /// or `"` quote, as in a shell. `caret` is a UTF-16 offset into it. Replace only the
    /// token being completed, so other options, quoted values and arguments after `--`
    /// stay. Called while the user types: answer from what the plugin already knows.
    /// The IDE keeps the first 200 items, drops those whose range is outside `text`, and
    /// drops answers slower than 300 ms.
    fn complete(
        &mut self,
        project: &str,
        config: &str,
        field: &str,
        text: &str,
        caret: u32,
    ) -> Vec<RunConfigurationCompletionItem>;
}
