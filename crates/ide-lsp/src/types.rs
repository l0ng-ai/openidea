//! IDE-side, IPC-stable equivalents of the LSP types we surface.

use ide_core::event::ServerStatus;
use ide_core::{Location, Range, ServerId, SymbolKind, TextEdit, WorkspaceEdit};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompletionList {
    pub is_incomplete: bool,
    pub items: Vec<CompletionItem>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
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

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompletionItem {
    pub label: String,
    /// e.g. `(req: CreateOrderRequest)` shown right after the label.
    pub label_detail: Option<String>,
    /// e.g. return type, shown right-aligned.
    pub detail: Option<String>,
    pub kind: Option<CompletionKind>,
    pub documentation: Option<Markup>,
    pub sort_text: Option<String>,
    pub filter_text: Option<String>,
    pub preselect: bool,
    pub deprecated: bool,
    /// Text to insert; snippet syntax when `is_snippet`.
    pub insert_text: String,
    pub is_snippet: bool,
    /// Range replaced on accept; `None` = word at cursor.
    pub replace_range: Option<Range>,
    /// IDEA "Replace" (⇥) range when it differs from insert range.
    pub replace_range_tab: Option<Range>,
    pub additional_edits: Vec<TextEdit>,
    pub commit_characters: Vec<String>,
    pub command: Option<Command>,
    /// Opaque server data for `completionItem/resolve`.
    #[specta(type = Option<String>)]
    pub data: Option<serde_json::Value>,
    pub server: ServerId,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Markup {
    /// `markdown` or `plaintext`.
    pub kind: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Hover {
    pub contents: Markup,
    pub range: Option<Range>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SignatureHelp {
    pub signatures: Vec<Signature>,
    pub active_signature: u32,
    pub active_parameter: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub label: String,
    pub documentation: Option<Markup>,
    /// UTF-16 ranges of each parameter within `label`.
    pub parameters: Vec<(u32, u32)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GotoKind {
    Definition,
    Declaration,
    TypeDefinition,
    Implementation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HighlightKind {
    Text,
    Read,
    Write,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct Highlight {
    pub range: Range,
    pub kind: HighlightKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub container: Option<String>,
    pub location: Location,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub title: String,
    pub command: String,
    #[specta(type = Vec<String>)]
    pub arguments: Vec<serde_json::Value>,
}

/// One `textDocument/inlineCompletion` suggestion (ghost text at the caret).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InlineCompletionItem {
    /// Text that replaces `range`; snippets arrive as their plain text.
    pub insert_text: String,
    /// Replaced range; `None` inserts at the caret.
    pub range: Option<Range>,
    /// What the typed text is matched against while the suggestion stays shown (default: `insert_text`).
    pub filter_text: Option<String>,
    /// Run after the suggestion is accepted.
    pub command: Option<Command>,
    pub server: ServerId,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeAction {
    pub title: String,
    /// LSP kind, e.g. `quickfix`, `refactor.extract`, `source.organizeImports`.
    pub kind: Option<String>,
    pub is_preferred: bool,
    pub disabled_reason: Option<String>,
    pub edit: Option<WorkspaceEdit>,
    pub command: Option<Command>,
    #[specta(type = Option<String>)]
    pub data: Option<serde_json::Value>,
    pub server: ServerId,
}

/// Code actions at a range plus the kinds the servers advertise
/// (`codeActionProvider.codeActionKinds`), so the UI can tell "not available
/// here" from "not supported by the server".
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeActionQuery {
    pub actions: Vec<CodeAction>,
    /// Union of the advertised kinds; `None` when a server does not list them.
    pub advertised_kinds: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatOptions {
    pub tab_size: u32,
    pub insert_spaces: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InlayKind {
    Type,
    Parameter,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InlayHint {
    pub position: ide_core::Pos,
    pub label: String,
    pub kind: InlayKind,
    pub padding_left: bool,
    pub padding_right: bool,
    pub tooltip: Option<String>,
    /// The label's parts when the server split it (empty for a plain label);
    /// their values concatenate to `label`.
    pub parts: Vec<InlayLabelPart>,
}

/// One part of an inlay hint label, e.g. a type name that navigates to its declaration.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InlayLabelPart {
    pub value: String,
    pub tooltip: Option<String>,
    /// Declaration the part stands for (⌘-click navigates there).
    pub location: Option<Location>,
}

/// Decoded semantic tokens (absolute positions) with the server legend applied.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTokens {
    /// Flattened `[line, col, len, typeIdx, modifierBits]` quintuples (absolute).
    pub data: Vec<u32>,
    pub token_types: Vec<String>,
    pub token_modifiers: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeLens {
    pub range: Range,
    pub command: Option<Command>,
}

/// A link in a document (`textDocument/documentLink`): an HTML `href`, a
/// Markdown link, an `#include`, a JSON `$schema`…
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentLink {
    pub range: Range,
    /// A `file:` target.
    pub path: Option<ide_core::IpcPath>,
    /// The `#fragment` of a `file:` target (`L12`, `L12,5`, a heading or element id).
    pub fragment: Option<String>,
    /// Any other target (`https:`, …).
    pub url: Option<String>,
    pub tooltip: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HierarchyDirection {
    /// Callers / supertypes.
    Incoming,
    /// Callees / subtypes.
    Outgoing,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyItem {
    pub name: String,
    pub kind: SymbolKind,
    pub detail: Option<String>,
    /// File path, or the URI of a virtual document (see `uri`).
    pub path: ide_core::IpcPath,
    /// Set for non-`file:` items (library classes).
    #[specta(optional)]
    pub uri: Option<String>,
    pub range: Range,
    pub selection_range: Range,
    /// Call sites, for call hierarchy.
    pub from_ranges: Vec<Range>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub id: ServerId,
    pub name: String,
    pub root: ide_core::IpcPath,
    pub languages: Vec<ide_core::LanguageId>,
    pub status: ServerStatus,
    /// OS process of the running instance (for memory attribution).
    pub pid: Option<u32>,
}

/// Read-only contents a language server provides for a non-`file:` URI
/// (library class source or decompiled code from `jdt://`, …).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VirtualDocument {
    pub uri: String,
    pub text: String,
    pub language_id: ide_core::LanguageId,
    /// Tab title, e.g. `SpringApplication.class` (decompiled) or `SpringApplication.java`.
    pub title: String,
    /// Origin shown in the tooltip / banner, e.g. the jar path.
    pub description: Option<String>,
    /// Generated by a decompiler / disassembler rather than real sources.
    pub decompiled: bool,
}

/// Reference updates for a file / folder move (`workspace/willRenameFiles`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileRenameEdits {
    /// Edits of every server that took part, in terms of the paths before the move.
    pub edit: WorkspaceEdit,
    /// Servers asked (their filters matched one of the moved paths).
    pub servers: Vec<String>,
    /// Servers that failed; their references are not updated.
    pub errors: Vec<String>,
}

/// Why a references search may have missed usages.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReferencesIncomplete {
    /// A language server was still indexing.
    Indexing,
    /// More project files mention the name than were checked.
    TooManyFiles,
    /// Files that mention the name were too large or unreadable to check.
    FilesSkipped,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct References {
    /// Semantic classifications supplied by a language extension. Missing entries are unknown.
    #[serde(default)]
    #[specta(optional)]
    pub classified: Vec<ClassifiedReference>,
    pub locations: Vec<Location>,
    pub incomplete: Option<ReferencesIncomplete>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
    pub edit: WorkspaceEdit,
    pub incomplete: Option<ReferencesIncomplete>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallHierarchy {
    pub items: Vec<HierarchyItem>,
    pub incomplete: Option<ReferencesIncomplete>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceKind {
    Getter,
    Setter,
    Field,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceAccess {
    Read,
    Write,
    ReadWrite,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct ClassifiedReference {
    /// Optional for older Java extensions; missing means unclassified.
    #[serde(default)]
    #[specta(optional)]
    pub access: Option<ReferenceAccess>,
    pub location: Location,
    pub kind: ReferenceKind,
}
