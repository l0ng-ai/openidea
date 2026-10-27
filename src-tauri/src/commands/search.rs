//! IPC commands of `ide_host::ops::search` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, Pos, RequestId};
#[allow(unused_imports)]
pub use ide_host::ops::search::*;
use ide_search::{ReplaceEvent, ReplacePreview, ReplaceTarget, SearchQuery};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Find in Files. Results stream through `on_event`; ends with `Done`.
/// Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn search_start(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    query: SearchQuery,
    on_event: Channel<SearchEvent>,
) -> IdeResult<()> {
    let emit = std::sync::Arc::new(move |e| {
        let _ = on_event.send(e);
    });
    ide_host::ops::search::start(&state.host, window.label(), request, query, emit).await
}
/// Replace in Files. Runs off the command thread; progress streams through
/// `on_event` and ends with `Done`. Cancel with `cancel_request(request)`.
///
/// Edits go through the document layer as one patch per file, so open editors
/// update live and undo the whole file's replacements in one step. Unsaved
/// editor buffers are replaced in place and left unsaved; files that were not
/// open are opened transiently, saved and closed.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn replace_in_files(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    query: SearchQuery,
    replacement: String,
    preserve_case: bool,
    targets: Vec<ReplaceTarget>,
    on_event: Channel<ReplaceEvent>,
) -> IdeResult<()> {
    ide_host::ops::search::replace_in_files(
        &state.host,
        window.label(),
        request,
        query,
        replacement,
        preserve_case,
        targets,
        crate::commands::sender(on_event),
    )
    .await
}

/// Before / after text of `path` for Replace › Preview (unsaved buffer included).
#[tauri::command]
#[specta::specta]
pub async fn replace_preview(
    window: Window,
    state: State<'_, AppState>,
    query: SearchQuery,
    replacement: String,
    preserve_case: bool,
    path: PathBuf,
    only: Option<Vec<Pos>>,
) -> IdeResult<ReplacePreview> {
    ide_host::ops::search::replace_preview(&state.host, window.label(), query, replacement, preserve_case, path, only)
        .await
}

/// Validates a query (e.g. regex syntax) while the user types.
#[tauri::command]
#[specta::specta]
pub fn search_validate(state: State<'_, AppState>, query: SearchQuery) -> IdeResult<()> {
    ide_host::ops::search::search_validate(&state.host, "", query)
}
