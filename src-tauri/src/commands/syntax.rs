//! IPC commands of `ide_host::ops::syntax` (the shared implementation).

use crate::state::AppState;
use ide_core::{DocId, IdeResult, LanguageId, Pos, Range, RequestId};
#[allow(unused_imports)]
pub use ide_host::ops::syntax::*;
use ide_syntax::{
    ExpressionAt, FileIdentifiers, IdentifierOccurrence, Locals, NodeAt, StructuralRanges, StructureSupport,
    SyntaxErrors,
};
use std::path::PathBuf;
use tauri::{State, Window};

/// What the structure service supports for a language (`tree`: every query,
/// `locals`: scope analysis).
#[tauri::command]
#[specta::specta]
pub fn syntax_support(window: Window, state: State<'_, AppState>, language: LanguageId) -> IdeResult<StructureSupport> {
    ide_host::ops::syntax::syntax_support(&state.host, window.label(), language)
}

/// The smallest named node covering `range`, with its ancestors (parent first).
#[tauri::command]
#[specta::specta]
pub async fn syntax_node_at(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    range: Range,
    request: Option<RequestId>,
) -> IdeResult<Option<NodeAt>> {
    ide_host::ops::syntax::syntax_node_at(&state.host, window.label(), doc, range, request).await
}

/// The expression a selection denotes (exact or minimally enclosing), with its
/// statement, block and caret candidates.
#[tauri::command]
#[specta::specta]
pub async fn syntax_expression_at(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    range: Range,
    request: Option<RequestId>,
) -> IdeResult<ExpressionAt> {
    ide_host::ops::syntax::syntax_expression_at(&state.host, window.label(), doc, range, request).await
}

/// `ERROR` / `MISSING` nodes (e.g. a missing `;`) in document order.
#[tauri::command]
#[specta::specta]
pub async fn syntax_errors(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    request: Option<RequestId>,
) -> IdeResult<SyntaxErrors> {
    ide_host::ops::syntax::syntax_errors(&state.host, window.label(), doc, request).await
}

/// Scope analysis of the identifier at `pos`: its local definition and
/// references, or why it is not a local.
#[tauri::command]
#[specta::specta]
pub async fn syntax_locals(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    request: Option<RequestId>,
) -> IdeResult<Locals> {
    ide_host::ops::syntax::syntax_locals(&state.host, window.label(), doc, pos, request).await
}

/// Identifier tokens spelled `name` in a document, excluding comments and strings.
#[tauri::command]
#[specta::specta]
pub async fn syntax_identifiers(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    name: String,
    request: Option<RequestId>,
) -> IdeResult<Vec<IdentifierOccurrence>> {
    ide_host::ops::syntax::syntax_identifiers(&state.host, window.label(), doc, name, request).await
}

/// [`syntax_identifiers`] over files (open buffers win over disk); files
/// without occurrences or without a grammar are left out. Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn syntax_identifiers_in_files(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    name: String,
    request: RequestId,
) -> IdeResult<Vec<FileIdentifiers>> {
    ide_host::ops::syntax::syntax_identifiers_in_files(&state.host, window.label(), paths, name, request).await
}

/// Extend Selection chain plus statement / declaration ranges at `pos`
/// (Move Statement, Complete Statement for languages without a Lezer grammar).
#[tauri::command]
#[specta::specta]
pub async fn syntax_structural_ranges(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    request: Option<RequestId>,
) -> IdeResult<StructuralRanges> {
    ide_host::ops::syntax::syntax_structural_ranges(&state.host, window.label(), doc, pos, request).await
}
