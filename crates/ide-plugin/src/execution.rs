//! Runs, keyed terminals and plugin-owned content editors (API 1.4).

use serde::{Deserialize, Serialize};
use specta::Type;

/// ContentAction data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContentAction {
    pub id: String,
    pub label: String,
    pub icon: Option<String>,
    pub primary: bool,
    pub save: bool,
}

/// ContentTab data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
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
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContentDiff {
    pub left: String,
    pub right: String,
    pub left_label: Option<String>,
    pub right_label: Option<String>,
    pub title: Option<String>,
}

/// ContentTabReply data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
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
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
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
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunExited {
    pub id: String,
    pub config: String,
    pub status: Option<i32>,
    pub killed: bool,
}

/// TerminalExited data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExited {
    pub id: String,
    pub key: String,
    pub status: Option<i32>,
    pub closed: bool,
}

/// ContentTabAction data exchanged with the IDE.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContentTabAction {
    pub request_id: String,
    pub key: String,
    pub action: String,
    pub content: String,
}

/// Incremental test tree data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TestStart {
    pub id: String,
    pub parent: Option<String>,
    pub name: String,
    pub location: Option<crate::Location>,
}

/// Incremental test tree data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TestPassed {
    pub id: String,
    pub duration_ms: Option<u32>,
}

/// Incremental test tree data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TestSkipped {
    pub id: String,
    pub reason: Option<String>,
}

/// Incremental test tree data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TestOutput {
    pub id: String,
    pub text: String,
}

/// A test update, carried by the optional test-results export.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
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
