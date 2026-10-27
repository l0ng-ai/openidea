//! IPC commands of `ide_host::ops::analysis` (the shared implementation).

use crate::state::AppState;
use ide_analysis::{DuplicateOptions, DuplicatesReport, StructuralQuery};
use ide_core::{IdeResult, RequestId};
#[allow(unused_imports)]
pub use ide_host::ops::analysis::*;
use ide_search::SearchScope;
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Inspect Code: diagnostics of every file in `scope` that a language server
/// serves. Files stream through `on_event` as they finish; ends with `Done`.
#[tauri::command]
#[specta::specta]
pub async fn inspect_code(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    scope: SearchScope,
    on_event: Channel<InspectEvent>,
) -> IdeResult<()> {
    ide_host::ops::analysis::inspect_code(
        &state.host,
        window.label(),
        request,
        scope,
        crate::commands::sender(on_event),
    )
    .await
}

/// Locate Duplicates over the files of `scope`.
#[tauri::command]
#[specta::specta]
pub async fn analysis_locate_duplicates(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    scope: SearchScope,
    options: DuplicateOptions,
) -> IdeResult<DuplicatesReport> {
    ide_host::ops::analysis::analysis_locate_duplicates(&state.host, window.label(), request, scope, options).await
}

/// Languages Search Structurally supports (those with a bundled grammar).
#[tauri::command]
#[specta::specta]
pub async fn structural_languages(state: State<'_, AppState>) -> IdeResult<Vec<StructuralLanguage>> {
    ide_host::ops::analysis::structural_languages(&state.host, "").await
}

/// Checks a structural search template (and language) while the user types.
#[tauri::command]
#[specta::specta]
pub async fn structural_validate(state: State<'_, AppState>, query: StructuralQuery) -> IdeResult<()> {
    ide_host::ops::analysis::structural_validate(&state.host, "", query).await
}

/// Search Structurally over `scope`; files with matches stream through
/// `on_event`, ending with `Done`. With a replacement, matches carry their
/// replacement text (applied by the UI as a workspace edit).
#[tauri::command]
#[specta::specta]
pub async fn structural_search(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    scope: SearchScope,
    query: StructuralQuery,
    on_event: Channel<StructuralEvent>,
) -> IdeResult<()> {
    ide_host::ops::analysis::structural_search(
        &state.host,
        window.label(),
        request,
        scope,
        query,
        crate::commands::sender(on_event),
    )
    .await
}
