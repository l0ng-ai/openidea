//! IPC commands of `ide_host::ops::nav` (the shared implementation).

use crate::state::AppState;
use ide_core::{DocId, IdeResult, IpcPath, Location, Pos};
#[allow(unused_imports)]
pub use ide_host::ops::nav::*;
use ide_index::{ExtensionCount, FileMatch, IndexStatus, SymbolFilter, SymbolMatch};
use ide_language::FileReference;
use ide_workspace::file_refs::PathCompletion;
use std::path::PathBuf;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub fn index_status(window: Window, state: State<'_, AppState>) -> IdeResult<IndexStatus> {
    ide_host::ops::nav::index_status(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn index_file_extensions(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ExtensionCount>> {
    ide_host::ops::nav::index_file_extensions(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn find_files(window: Window, state: State<'_, AppState>, query: String, limit: u32) -> IdeResult<Vec<FileMatch>> {
    ide_host::ops::nav::find_files(&state.host, window.label(), query, limit)
}

/// Folders holding indexed files, for `@` references.
#[tauri::command]
#[specta::specta]
pub fn find_dirs(window: Window, state: State<'_, AppState>, query: String, limit: u32) -> IdeResult<Vec<FileMatch>> {
    ide_host::ops::nav::find_dirs(&state.host, window.label(), query, limit)
}

/// Spring Web mapping sources for the request-path index of Search Everywhere.
#[tauri::command]
#[specta::specta]
pub fn spring_route_sources(
    window: Window,
    state: State<'_, AppState>,
) -> IdeResult<Vec<ide_host::ops::routes::RouteSource>> {
    ide_host::ops::routes::spring_route_sources(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn find_symbols(
    window: Window,
    state: State<'_, AppState>,
    query: String,
    filter: SymbolFilter,
    limit: u32,
) -> IdeResult<Vec<SymbolMatch>> {
    ide_host::ops::nav::find_symbols(&state.host, window.label(), query, filter, limit)
}

#[tauri::command]
#[specta::specta]
pub fn mark_recent(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    ide_host::ops::nav::mark_recent(&state.host, window.label(), path)
}

#[tauri::command]
#[specta::specta]
pub fn remove_recent(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    ide_host::ops::nav::remove_recent(&state.host, window.label(), path)
}

/// Recently opened files, most recent first (⌘E).
#[tauri::command]
#[specta::specta]
pub fn recent_files(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ide_core::IpcPath>> {
    ide_host::ops::nav::recent_files(&state.host, window.label())
}

/// The web reference at `pos` of `doc` and its targets; `None` when there is no reference.
#[tauri::command]
#[specta::specta]
pub async fn web_goto(window: Window, state: State<'_, AppState>, doc: DocId, pos: Pos) -> IdeResult<Option<WebGoto>> {
    ide_host::ops::nav::web_goto(&state.host, window.label(), doc, pos).await
}

#[tauri::command]
#[specta::specta]
pub async fn index_usages(
    window: Window,
    state: State<'_, AppState>,
    name: String,
    css: bool,
) -> IdeResult<Vec<Location>> {
    ide_host::ops::nav::index_usages(&state.host, window.label(), name, css).await
}

#[tauri::command]
#[specta::specta]
pub async fn index_goto(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    word: String,
) -> IdeResult<Option<IndexGoto>> {
    ide_host::ops::nav::index_goto(&state.host, window.label(), doc, pos, word).await
}

/// The existing file or directory a path written in `from` names (`href`, `url()`, a string literal).
#[tauri::command]
#[specta::specta]
pub async fn fs_resolve_reference(
    window: Window,
    state: State<'_, AppState>,
    from: IpcPath,
    value: String,
) -> IdeResult<Option<IpcPath>> {
    ide_host::ops::nav::fs_resolve_reference(&state.host, window.label(), from, value).await
}

/// Files and folders that continue `prefix`, a path being typed in `from`.
#[tauri::command]
#[specta::specta]
pub async fn path_completions(
    window: Window,
    state: State<'_, AppState>,
    from: IpcPath,
    prefix: String,
) -> IdeResult<Vec<PathCompletion>> {
    ide_host::ops::nav::path_completions(&state.host, window.label(), from, prefix).await
}

/// Paths in an HTML document or stylesheet that name no existing file.
#[tauri::command]
#[specta::specta]
pub async fn web_unresolved_references(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
) -> IdeResult<Vec<FileReference>> {
    ide_host::ops::nav::web_unresolved_references(&state.host, window.label(), doc).await
}
