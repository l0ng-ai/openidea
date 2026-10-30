//! Text coordinates used across the IPC boundary.
//!
//! Convention: **all offsets and columns crossing IPC are UTF-16 code units**,
//! matching JavaScript strings, CodeMirror and the LSP default encoding.
//! Lines are 0-based. Conversion to/from byte offsets lives in `ide-text`.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

/// A 0-based line / UTF-16 column position.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type)]
pub struct Pos {
    pub line: u32,
    pub col: u32,
}

impl Pos {
    pub const fn new(line: u32, col: u32) -> Self {
        Self { line, col }
    }
}

/// Half-open range `[start, end)`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type)]
pub struct Range {
    pub start: Pos,
    pub end: Pos,
}

impl Range {
    pub const fn new(start: Pos, end: Pos) -> Self {
        Self { start, end }
    }
    pub const fn point(p: Pos) -> Self {
        Self { start: p, end: p }
    }
    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }
}

/// A range inside a specific file, or inside a virtual document (library
/// class contents, decompiled code…) that only a language server can provide.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct Location {
    /// File path; for virtual targets the URI itself (equal to `uri`), which
    /// the UI opens as a read-only virtual document.
    pub path: crate::IpcPath,
    pub range: Range,
    /// Set for non-`file:` targets, e.g. `jdt://contents/…`.
    #[specta(optional)]
    pub uri: Option<String>,
}

/// Whether `s` is a non-`file:` URI (`scheme:` with a scheme of 2+ chars, so
/// Windows drive letters don't count).
pub fn is_virtual_uri(s: &str) -> bool {
    let Some(colon) = s.find(':') else { return false };
    let scheme = &s[..colon];
    scheme.len() >= 2
        && !scheme.eq_ignore_ascii_case("file")
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

impl Location {
    pub fn file(path: PathBuf, range: Range) -> Self {
        Self { path: path.into(), range, uri: None }
    }
}

/// Replace the text in `[from, to)` (UTF-16 offsets into the document *before*
/// the change set is applied) with `insert`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TextChange {
    pub from: u32,
    pub to: u32,
    pub insert: String,
}

/// Ordered, non-overlapping changes, all expressed in the coordinates of the
/// original document (CodeMirror `ChangeSet` semantics).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ChangeSet {
    pub changes: Vec<TextChange>,
}

/// An edit expressed in line/column coordinates (LSP `TextEdit`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TextEdit {
    pub range: Range,
    pub new_text: String,
}

/// Edits to many files, applied atomically from the user's point of view.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WorkspaceEdit {
    pub files: Vec<FileEdit>,
    /// Content fingerprints captured before presenting an edit for confirmation.
    #[serde(default)]
    #[specta(optional)]
    pub preconditions: Vec<WorkspaceEditPrecondition>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WorkspaceEditPrecondition {
    pub path: crate::IpcPath,
    pub hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileEdit {
    Edit {
        path: crate::IpcPath,
        edits: Vec<TextEdit>,
        /// LSP TextDocumentEdit version; null/unversioned edits use content preconditions.
        #[serde(default)]
        #[specta(optional)]
        version: Option<i32>,
    },
    Create {
        path: crate::IpcPath,
        overwrite: bool,
    },
    Rename {
        from: crate::IpcPath,
        to: crate::IpcPath,
    },
    Delete {
        path: crate::IpcPath,
        recursive: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
    Info,
    Hint,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Diagnostic {
    pub range: Range,
    pub severity: Severity,
    pub message: String,
    /// Producer, e.g. `rust-analyzer`, `eslint`.
    pub source: Option<String>,
    pub code: Option<String>,
    #[serde(default)]
    pub unnecessary: bool,
    #[serde(default)]
    pub deprecated: bool,
    /// Language server (or tool) that reported it, e.g. `basedpyright`; `source`
    /// is what the producer calls itself. Inspection profiles key on this.
    #[serde(default)]
    #[specta(optional)]
    pub server: Option<String>,
}

/// Symbol kinds, a stable subset of LSP `SymbolKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKind {
    File,
    Module,
    Namespace,
    Package,
    Class,
    Interface,
    Struct,
    Enum,
    EnumMember,
    Trait,
    Function,
    Method,
    Constructor,
    Field,
    Property,
    Variable,
    Constant,
    TypeParameter,
    TypeAlias,
    Macro,
    Event,
    Operator,
    Key,
    Unknown,
}

impl SymbolKind {
    /// "Class-like" symbols are what IDEA's *Go to Class* (⌘O) searches.
    pub fn is_type_like(self) -> bool {
        matches!(self, Self::Class | Self::Interface | Self::Struct | Self::Enum | Self::Trait | Self::TypeAlias)
    }
}

/// Declared (or conventional) visibility of an outline symbol.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Public,
    Protected,
    /// Package / module / assembly scope (Java default, `internal`, `pub(crate)`, Go unexported).
    Package,
    Private,
}

/// A node of a document outline (Structure tool window, breadcrumbs).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct OutlineItem {
    pub name: String,
    pub detail: Option<String>,
    pub kind: SymbolKind,
    /// Whole extent of the symbol.
    pub range: Range,
    /// The identifier itself; where navigation lands.
    pub selection_range: Range,
    pub children: Vec<OutlineItem>,
    /// Unknown (`None`) for language-server symbols and languages without the notion.
    #[serde(default)]
    #[specta(optional)]
    pub visibility: Option<Visibility>,
}

/// Fuzzy-match highlight: indices (in chars of the displayed string) that matched.
pub type MatchIndices = Vec<u32>;
