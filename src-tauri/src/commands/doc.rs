//! IPC commands of `ide_host::ops::doc` (the shared implementation).

use crate::state::AppState;
use ide_core::{ChangeSet, DocId, IdeResult, OutlineItem, Range};
#[allow(unused_imports)]
pub use ide_host::ops::doc::*;
use ide_language::{FoldRange, SyntaxHighlights};
use ide_text::LineEnding;
use ide_workspace::{DocumentInfo, HistoryEntry};
use std::path::PathBuf;
use tauri::{State, Window};

/// Opens a document. Async: reading and decoding a large file must not block
/// the main thread (synchronous commands run on it).
#[tauri::command]
#[specta::specta]
pub async fn doc_open(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<DocumentInfo> {
    ide_host::ops::doc::open(&state.host, window.label(), path).await
}

#[tauri::command]
#[specta::specta]
pub fn doc_close(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<()> {
    ide_host::ops::doc::close(&state.host, window.label(), doc)
}

/// Applies a CodeMirror change set; returns the new version. Rejects with
/// `outOfSync` when `base_version` is stale; the UI then calls `doc_snapshot`.
#[tauri::command]
#[specta::specta]
pub fn doc_edit(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    base_version: u32,
    changes: ChangeSet,
) -> IdeResult<u32> {
    ide_host::ops::doc::edit(&state.host, window.label(), doc, base_version, changes)
}

#[tauri::command]
#[specta::specta]
pub async fn doc_save(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<()> {
    ide_host::ops::doc::save(&state.host, window.label(), doc).await
}

#[tauri::command]
#[specta::specta]
pub async fn doc_save_all(window: Window, state: State<'_, AppState>) -> IdeResult<()> {
    ide_host::ops::doc::save_all(&state.host, window.label()).await
}

#[tauri::command]
#[specta::specta]
pub async fn doc_snapshot(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<DocumentInfo> {
    ide_host::ops::doc::snapshot(&state.host, window.label(), doc).await
}
/// Opens a read-only virtual document (see `lsp_virtual_document`) as an
/// editor buffer, so syntax features and language-server requests work in it.
#[tauri::command]
#[specta::specta]
pub async fn doc_open_virtual(window: Window, state: State<'_, AppState>, uri: String) -> IdeResult<DocumentInfo> {
    ide_host::ops::doc::doc_open_virtual(&state.host, window.label(), uri).await
}

/// The CodeMirror mode `path` gets when opened (`DocumentInfo::ui_mode`),
/// without opening it: previews of closed files.
#[tauri::command]
#[specta::specta]
pub async fn doc_ui_mode(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<Option<String>> {
    ide_host::ops::doc::doc_ui_mode(&state.host, window.label(), path).await
}

/// "Reload with Encoding" (`reload`) or "Convert to Encoding"; returns the new encoding label.
#[tauri::command]
#[specta::specta]
pub fn doc_set_encoding(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    encoding: String,
    reload: bool,
) -> IdeResult<String> {
    ide_host::ops::doc::doc_set_encoding(&state.host, window.label(), doc, encoding, reload)
}

#[tauri::command]
#[specta::specta]
pub fn doc_set_line_ending(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    line_ending: LineEnding,
) -> IdeResult<()> {
    ide_host::ops::doc::doc_set_line_ending(&state.host, window.label(), doc, line_ending)
}

/// Structure view: LSP document symbols when available (with tree-sitter
/// visibility), tree-sitter otherwise.
/// Tree-sitter answers come from the per-document tree cache (incremental
/// re-parse); large documents get no syntax structure.
#[tauri::command]
#[specta::specta]
pub async fn doc_outline(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<Vec<OutlineItem>> {
    ide_host::ops::doc::doc_outline(&state.host, window.label(), doc).await
}

#[tauri::command]
#[specta::specta]
pub async fn doc_folding(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<Vec<FoldRange>> {
    ide_host::ops::doc::doc_folding(&state.host, window.label(), doc).await
}

/// Tree-sitter highlighting for languages the UI has no CodeMirror mode for;
/// empty when the grammar has no highlights query or the document is large.
#[tauri::command]
#[specta::specta]
pub async fn doc_highlights(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<SyntaxHighlights> {
    ide_host::ops::doc::doc_highlights(&state.host, window.label(), doc).await
}

/// Extend Selection (⌥↑): syntax ranges around `offset`, innermost first.
/// Large documents fall back to word / line / document ranges.
#[tauri::command]
#[specta::specta]
pub async fn doc_selection_ranges(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    offset: u32,
) -> IdeResult<Vec<Range>> {
    ide_host::ops::doc::doc_selection_ranges(&state.host, window.label(), doc, offset).await
}

#[tauri::command]
#[specta::specta]
pub fn history_list(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<Vec<HistoryEntry>> {
    ide_host::ops::doc::history_list(&state.host, window.label(), path)
}

#[tauri::command]
#[specta::specta]
pub fn history_content(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<String> {
    ide_host::ops::doc::history_content(&state.host, window.label(), id)
}
