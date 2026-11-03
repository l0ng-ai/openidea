//! Editor providers: implement [`Providers`] and register with
//! `register_plugin!(T, providers)`, then declare the kinds and languages in
//! `plugin.toml`:
//!
//! ```toml
//! [[contributes.providers]]
//! kinds = ["completion", "definition"]   # also inline-completion, code-actions, line-markers
//! languages = ["xml"]
//! ```
//!
//! They run on the editing path: answer within ~50 ms (later results are
//! dropped; at 500 ms the call is interrupted). Inline completion may take
//! longer (it may use the network) but is cancelled when the user types on.

use crate::types::{Location, Position, Range, TextEdit};

/// The document a request is about.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Document {
    pub path: String,
    pub language: String,
    pub version: u64,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionKind {
    Text,
    Method,
    Function,
    Constructor,
    Field,
    Variable,
    Class,
    Interface,
    Module,
    Property,
    Keyword,
    Snippet,
    Value,
    Constant,
    File,
    Reference,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompletionItem {
    pub label: String,
    pub detail: Option<String>,
    pub kind: Option<CompletionKind>,
    pub insert_text: String,
    /// Replaced on accept; `None`: the word at the caret.
    pub replace: Option<Range>,
    pub sort_text: Option<String>,
    /// Markdown.
    pub documentation: Option<String>,
}

impl CompletionItem {
    pub fn new(label: &str, kind: CompletionKind) -> Self {
        Self {
            label: label.into(),
            detail: None,
            kind: Some(kind),
            insert_text: label.into(),
            replace: None,
            sort_text: None,
            documentation: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineSuggestion {
    pub insert_text: String,
    /// Replaced range; `None` inserts at the caret.
    pub replace: Option<Range>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeAction {
    pub title: String,
    /// `quickfix`, `refactor`, …
    pub kind: Option<String>,
    pub preferred: bool,
    /// (absolute path, edits) per file.
    pub edits: Vec<(String, Vec<TextEdit>)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineMarker {
    /// 0-based.
    pub line: u32,
    /// `navigate` (default), `implemented`, `implementing`, `run`.
    pub icon: Option<String>,
    pub tooltip: String,
    /// Opened on click.
    pub target: Option<Location>,
}

/// What a plugin provides in the editor. Only the kinds declared in
/// `plugin.toml` are ever called; the defaults return nothing.
pub trait Providers {
    fn completion(&mut self, _doc: &Document, _at: Position, _trigger: Option<&str>) -> Vec<CompletionItem> {
        Vec::new()
    }

    fn inline_completion(&mut self, _doc: &Document, _at: Position) -> Option<InlineSuggestion> {
        None
    }

    fn code_actions(&mut self, _doc: &Document, _selection: Range) -> Vec<CodeAction> {
        Vec::new()
    }

    fn definition(&mut self, _doc: &Document, _at: Position) -> Vec<Location> {
        Vec::new()
    }

    fn line_markers(&mut self, _doc: &Document) -> Vec<LineMarker> {
        Vec::new()
    }
}
