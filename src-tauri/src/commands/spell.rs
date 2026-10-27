//! IPC commands of `ide_host::ops::spell` (the shared implementation).

use crate::state::AppState;
use ide_core::{DocId, IdeResult, RequestId};
#[allow(unused_imports)]
pub use ide_host::ops::spell::*;
use ide_spell::{SpellScope, Typo};
use tauri::{State, Window};

/// Misspelt words in the comments, string literals and declared names of
/// `doc` that `scope` includes (all of its text for prose). Cancel with
/// `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn spell_check(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    scope: SpellScope,
    request: RequestId,
) -> IdeResult<Vec<Typo>> {
    ide_host::ops::spell::spell_check(&state.host, window.label(), doc, scope, request).await
}

/// Replacements for a misspelt `word`, best first (Typo › Change to…).
#[tauri::command]
#[specta::specta]
pub async fn spell_suggest(window: Window, state: State<'_, AppState>, word: String) -> IdeResult<Vec<String>> {
    ide_host::ops::spell::spell_suggest(&state.host, window.label(), word).await
}
