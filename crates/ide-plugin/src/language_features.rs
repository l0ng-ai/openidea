//! Optional API 1.4 language features and embedded language ranges.
use ide_core::Range;
use serde::{Deserialize, Serialize};
use specta::Type;
/// A parameter label, as text or UTF-16 offsets within the signature.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub enum ParameterLabel {
    Text(String),
    Offsets((u32, u32)),
}
/// FormatOptions data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatOptions {
    pub tab_size: u32,
    pub insert_spaces: bool,
}
/// Parameter data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Parameter {
    pub label: ParameterLabel,
    pub documentation: Option<String>,
}
/// Signature data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<Parameter>,
}
/// SignatureHelp data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SignatureHelp {
    pub signatures: Vec<Signature>,
    pub active_signature: u32,
    pub active_parameter: u32,
}
/// Highlight data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub range: Range,
    pub kind: String,
}
/// DocumentLink data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentLink {
    pub range: Range,
    pub target: String,
}
/// CodeLens data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeLens {
    pub range: Range,
    pub title: String,
    pub command: String,
    pub argument: Option<String>,
}
/// FoldRange data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldRange {
    pub start_line: u32,
    pub end_line: u32,
    pub kind: String,
}
/// ColorInfo data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColorInfo {
    pub range: Range,
    pub red: f32,
    pub green: f32,
    pub blue: f32,
    pub alpha: f32,
}
/// DocumentSymbol data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSymbol {
    pub name: String,
    pub detail: String,
    pub kind: String,
    pub range: Range,
    pub selection_range: Range,
    pub parent: Option<u32>,
}
/// GutterAction data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GutterAction {
    pub line: u32,
    pub icon: Option<String>,
    pub tooltip: String,
    pub command: String,
    pub argument: Option<String>,
}
/// Injection data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Injection {
    pub range: Range,
    pub language: String,
}
