//! Typed IPC adapters for manifest dependency versions.
use crate::state::AppState;
use ide_core::{DocId, IdeResult, RequestId};
use ide_workspace::dependencies::DependencyVersions;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub async fn dependency_versions(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    offset: Option<u32>,
    request: RequestId,
) -> IdeResult<Vec<DependencyVersions>> {
    ide_host::ops::dependencies::dependency_versions(&state.host, window.label(), doc, offset, request).await
}
