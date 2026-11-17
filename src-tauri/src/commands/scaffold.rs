//! IPC commands of `ide_host::ops::scaffold` (File › New Project).

use crate::state::AppState;
use ide_core::{IdeResult, IpcPath, RequestId};
use ide_scaffold::{CreateRequest, Field, GeneratorInfo, Requirement, ScaffoldEvent, Values};
use tauri::ipc::Channel;
use tauri::{State, Window};

/// The project generators File › New Project offers, in list order.
#[tauri::command]
#[specta::specta]
pub fn scaffold_catalog(window: Window, state: State<'_, AppState>) -> Vec<GeneratorInfo> {
    ide_host::ops::scaffold::scaffold_catalog(&state.host, window.label())
}

/// The fields a generator's project service adds for `values`; cancellable with
/// `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn scaffold_options(
    window: Window,
    state: State<'_, AppState>,
    generator: String,
    values: Values,
    request: RequestId,
) -> IdeResult<Vec<Field>> {
    ide_host::ops::scaffold::scaffold_options(&state.host, window.label(), generator, values, request).await
}

/// The programs a generator needs for `values`, and whether they are installed.
#[tauri::command]
#[specta::specta]
pub async fn scaffold_requirements(
    window: Window,
    state: State<'_, AppState>,
    generator: String,
    values: Values,
) -> IdeResult<Vec<Requirement>> {
    ide_host::ops::scaffold::scaffold_requirements(&state.host, window.label(), generator, values).await
}

/// Creates a project, streaming progress through `on_event`, and returns its directory,
/// trusted. Cancellable with `cancel_request(request)`; a failed or cancelled run leaves nothing.
#[tauri::command]
#[specta::specta]
pub async fn scaffold_create(
    window: Window,
    state: State<'_, AppState>,
    req: CreateRequest,
    request: RequestId,
    on_event: Channel<ScaffoldEvent>,
) -> IdeResult<IpcPath> {
    ide_host::ops::scaffold::scaffold_create(
        &state.host,
        window.label(),
        req,
        request,
        crate::commands::sender(on_event),
    )
    .await
}
