use crate::state::AppState;
use ide_core::{IdeResult, IpcPath, RequestId};
use ide_remote::{DeployedPath, DeploymentCoverage, SyncEntry, SyncStep, TransferReport};
use ide_ssh::{FsConnection, RemoteEntry};
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub async fn deploy_coverage(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<IpcPath>,
) -> IdeResult<Vec<DeploymentCoverage>> {
    ide_host::ops::deploy::deploy_coverage(window.label(), &state.host, paths).await
}

#[tauri::command]
#[specta::specta]
pub async fn deploy_upload(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<IpcPath>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    ide_host::ops::deploy::deploy_upload(window.label(), &state.host, paths, server, request).await
}

#[tauri::command]
#[specta::specta]
pub async fn deploy_download(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<IpcPath>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    ide_host::ops::deploy::deploy_download(window.label(), &state.host, paths, server, request).await
}

#[tauri::command]
#[specta::specta]
pub async fn deploy_delete_remote(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<IpcPath>,
    server: Option<String>,
) -> IdeResult<TransferReport> {
    ide_host::ops::deploy::deploy_delete_remote(window.label(), &state.host, paths, server).await
}

#[tauri::command]
#[specta::specta]
pub async fn deploy_compare(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<Vec<SyncEntry>> {
    ide_host::ops::deploy::deploy_compare(window.label(), &state.host, path, server, request).await
}

#[tauri::command]
#[specta::specta]
pub async fn deploy_sync(
    window: Window,
    state: State<'_, AppState>,
    steps: Vec<SyncStep>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    ide_host::ops::deploy::deploy_sync(window.label(), &state.host, steps, server, request).await
}

#[tauri::command]
#[specta::specta]
pub async fn deploy_info(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    server: Option<String>,
) -> IdeResult<Option<DeployedPath>> {
    ide_host::ops::deploy::deploy_info(window.label(), &state.host, path, server).await
}

#[tauri::command]
#[specta::specta]
pub async fn deploy_server_root(window: Window, state: State<'_, AppState>, server: String) -> IdeResult<String> {
    ide_host::ops::deploy::deploy_server_root(window.label(), &state.host, server).await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_list(
    state: State<'_, AppState>,
    connection: FsConnection,
    path: String,
) -> IdeResult<Vec<RemoteEntry>> {
    ide_host::ops::deploy::remote_list(&state.host, connection, path).await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_open(state: State<'_, AppState>, connection: FsConnection, path: String) -> IdeResult<IpcPath> {
    ide_host::ops::deploy::remote_open(&state.host, connection, path).await
}

#[tauri::command]
#[specta::specta]
pub fn remote_of(state: State<'_, AppState>, path: IpcPath) -> Option<(FsConnection, String)> {
    ide_host::ops::deploy::remote_of(&state.host, path)
}

#[tauri::command]
#[specta::specta]
pub async fn remote_delete(state: State<'_, AppState>, connection: FsConnection, path: String) -> IdeResult<()> {
    ide_host::ops::deploy::remote_delete(&state.host, connection, path).await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_mkdir(state: State<'_, AppState>, connection: FsConnection, path: String) -> IdeResult<()> {
    ide_host::ops::deploy::remote_mkdir(&state.host, connection, path).await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_rename(
    state: State<'_, AppState>,
    connection: FsConnection,
    from: String,
    to: String,
) -> IdeResult<()> {
    ide_host::ops::deploy::remote_rename(&state.host, connection, from, to).await
}

#[tauri::command]
#[specta::specta]
pub async fn deploy_test_connection(
    state: State<'_, AppState>,
    connection: FsConnection,
    path: String,
) -> IdeResult<()> {
    ide_host::ops::deploy::deploy_test_connection(&state.host, connection, path).await
}
