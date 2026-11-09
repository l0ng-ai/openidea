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
