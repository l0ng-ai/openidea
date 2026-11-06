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

/// Icon and sort group of a completion item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
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
    Unit,
    Value,
    Enum,
    Keyword,
    Snippet,
    Color,
    File,
    Reference,
    Folder,
    EnumMember,
    Constant,
    Struct,
    Event,
    Operator,
    TypeParameter,
}

impl CompletionKind {
    /// The name the plugin API uses (`completion-item.kind`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Method => "method",
            Self::Function => "function",
            Self::Constructor => "constructor",
            Self::Field => "field",
            Self::Variable => "variable",
            Self::Class => "class",
            Self::Interface => "interface",
            Self::Module => "module",
            Self::Property => "property",
            Self::Unit => "unit",
            Self::Value => "value",
            Self::Enum => "enum",
            Self::Keyword => "keyword",
            Self::Snippet => "snippet",
            Self::Color => "color",
            Self::File => "file",
            Self::Reference => "reference",
            Self::Folder => "folder",
            Self::EnumMember => "enum-member",
            Self::Constant => "constant",
            Self::Struct => "struct",
            Self::Event => "event",
            Self::Operator => "operator",
            Self::TypeParameter => "type-parameter",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompletionItem {
    pub label: String,
    pub detail: Option<String>,
    pub kind: Option<CompletionKind>,
    /// With `snippet`, tab stops and placeholders (`$1`, `${1:name}`, `$0`).
    pub insert_text: String,
    pub snippet: bool,
    /// Replaced on accept; `None`: the word at the caret.
    pub replace: Option<Range>,
    pub sort_text: Option<String>,
    /// Matched against what was typed instead of `label`.
    pub filter_text: Option<String>,
    /// Markdown.
    pub documentation: Option<String>,
    /// Applied with the item elsewhere in the document (an import).
    pub additional_edits: Vec<TextEdit>,
}

impl CompletionItem {
    pub fn new(label: &str, kind: CompletionKind) -> Self {
        Self {
            label: label.into(),
            detail: None,
            kind: Some(kind),
            insert_text: label.into(),
            snippet: false,
            replace: None,
            sort_text: None,
            filter_text: None,
            documentation: None,
            additional_edits: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineSuggestion {
    pub insert_text: String,
    /// Replaced range; `None` inserts at the caret.
    pub replace: Option<Range>,
}

/// A file change a [`CodeAction`] makes next to its text edits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileOperation {
    /// Fails when the file exists, unless `overwrite`.
    Create {
        path: String,
        text: String,
        overwrite: bool,
    },
    Rename {
        from: String,
        to: String,
    },
    /// Deletes the file; undoing the action restores it.
    Delete {
        path: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodeAction {
    pub title: String,
    /// `quickfix`, `refactor`, …
    pub kind: Option<String>,
    pub preferred: bool,
    /// (absolute path, edits) per file.
    pub edits: Vec<(String, Vec<TextEdit>)>,
    /// Applied before `edits`, as one workspace edit with them: if any
    /// operation or edit fails, nothing is applied. Paths stay inside the
    /// project root.
    pub operations: Vec<FileOperation>,
    /// Opened once the action is applied.
    pub open: Option<String>,
    /// The plugin's own reference: with it and no `edits`, the edits come
    /// from [`Providers::resolve_code_action`] once the user picks the action.
    pub data: Option<String>,
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

    /// The edits of an action [`Providers::code_actions`] returned with
    /// `data`, when the user picks it (the command budget applies, not 50 ms).
    fn resolve_code_action(&mut self, _doc: &Document, action: CodeAction) -> Result<CodeAction, crate::Error> {
        Ok(action)
    }

    fn definition(&mut self, _doc: &Document, _at: Position) -> Vec<Location> {
        Vec::new()
    }

    fn line_markers(&mut self, _doc: &Document) -> Vec<LineMarker> {
        Vec::new()
    }
}
