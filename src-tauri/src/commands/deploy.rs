use crate::state::AppState;
use ide_core::{CancellationToken, IdeEvent, IdeResult, IpcPath, RequestId, SharedSink, TaskId};
use ide_remote::{DeployedPath, SyncEntry, SyncStep, TransferReport};
use ide_ssh::RemoteEntry;
use std::path::PathBuf;
use tauri::{State, Window};

/// Reports a transfer as a background task (status bar progress) whose Cancel fires `token`.
fn progress(
    sink: SharedSink,
    title: &str,
    token: CancellationToken,
) -> (impl FnMut(&str, usize, usize) + Send, impl FnOnce()) {
    let id = TaskId::next();
    let cancel = token;
    let handle = ide_core::task::on_cancel(id, move || cancel.cancel());
    let title = title.to_owned();
    let (s, t) = (sink.clone(), title.clone());
    let report = move |path: &str, i: usize, n: usize| {
        let fraction = if n == 0 { None } else { Some(i as f32 / n as f32) };
        let message = Some(path.to_owned());
        s.emit(IdeEvent::Task { id, title: t.clone(), message, fraction, done: false, cancellable: true });
    };
    let done = move || {
        drop(handle);
        sink.emit(IdeEvent::Task { id, title, message: None, fraction: Some(1.0), done: true, cancellable: false })
    };
    (report, done)
}

fn local(paths: Vec<IpcPath>) -> Vec<PathBuf> {
    paths.into_iter().map(|p| p.to_path_buf()).collect()
}

/// Tools › Deployment › Upload to…: files and folders to `server` (default server when `None`).
#[tauri::command]
#[specta::specta]
pub async fn deploy_upload(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<IpcPath>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    let project = state.project(window.label())?;
    let token = state.begin_request(request);
    let (mut report, done) = progress(project.sink.clone(), "Uploading", token.clone());
    let r = state
        .remote
        .upload(&project.settings.effective(), &project.root, server.as_deref(), &local(paths), token, &mut report)
        .await;
    done();
    state.end_request(request);
    r
}

/// Download from…: the remote counterparts of files and folders.
#[tauri::command]
#[specta::specta]
pub async fn deploy_download(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<IpcPath>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    let project = state.project(window.label())?;
    let token = state.begin_request(request);
    let (mut report, done) = progress(project.sink.clone(), "Downloading", token.clone());
    let r = state
        .remote
        .download(&project.settings.effective(), &project.root, server.as_deref(), &local(paths), token, &mut report)
        .await;
    done();
    state.end_request(request);
    r
}

/// Deletes the remote counterparts of files and folders.
#[tauri::command]
#[specta::specta]
pub async fn deploy_delete_remote(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<IpcPath>,
    server: Option<String>,
) -> IdeResult<TransferReport> {
    let project = state.project(window.label())?;
    state.remote.delete_remote(&project.settings.effective(), &project.root, server.as_deref(), &local(paths)).await
}

/// Sync with Deployed: local and remote files under `path`, side by side.
#[tauri::command]
#[specta::specta]
pub async fn deploy_compare(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<Vec<SyncEntry>> {
    let project = state.project(window.label())?;
    let token = state.begin_request(request);
    let r = state.remote.compare(&project.settings.effective(), &project.root, server.as_deref(), &path, token).await;
    state.end_request(request);
    r
}

/// Applies the Sync with Deployed choices.
#[tauri::command]
#[specta::specta]
pub async fn deploy_sync(
    window: Window,
    state: State<'_, AppState>,
    steps: Vec<SyncStep>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    let project = state.project(window.label())?;
    let token = state.begin_request(request);
    let (mut report, done) = progress(project.sink.clone(), "Synchronizing", token.clone());
    let r = state
        .remote
        .sync(&project.settings.effective(), &project.root, server.as_deref(), &steps, token, &mut report)
        .await;
    done();
    state.end_request(request);
    r
}

/// Where `path` is deployed (remote path, web URL); `None` when not mapped.
#[tauri::command]
#[specta::specta]
pub async fn deploy_info(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    server: Option<String>,
) -> IdeResult<Option<DeployedPath>> {
    let project = state.project(window.label())?;
    state.remote.deployed(&project.settings.effective(), &project.root, server.as_deref(), &path).await
}

/// Remote Host tool window: the server root of `server`, resolved on the host.
#[tauri::command]
#[specta::specta]
pub async fn deploy_server_root(window: Window, state: State<'_, AppState>, server: String) -> IdeResult<String> {
    let settings = match state.project(window.label()) {
        Ok(p) => p.settings.effective(),
        Err(_) => state.global_settings.effective(),
    };
    state.remote.server_root(&settings, &server).await
}

/// Entries of a remote folder of SSH configuration `ssh` (`~`: the login directory).
#[tauri::command]
#[specta::specta]
pub async fn remote_list(state: State<'_, AppState>, ssh: String, path: String) -> IdeResult<Vec<RemoteEntry>> {
    state.remote.list(&ssh, &path).await
}

/// Opens a remote file for editing: a local copy, uploaded back on save.
#[tauri::command]
#[specta::specta]
pub async fn remote_open(state: State<'_, AppState>, ssh: String, path: String) -> IdeResult<IpcPath> {
    Ok(state.remote.open_remote(&ssh, &path).await?.into())
}

/// The remote file a local copy stands for: (SSH configuration id, remote path).
#[tauri::command]
#[specta::specta]
pub fn remote_of(state: State<'_, AppState>, path: IpcPath) -> Option<(String, String)> {
    state.remote.remote_of(&path)
}

#[tauri::command]
#[specta::specta]
pub async fn remote_delete(state: State<'_, AppState>, ssh: String, path: String) -> IdeResult<()> {
    state.remote.remote_delete(&ssh, &path).await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_mkdir(state: State<'_, AppState>, ssh: String, path: String) -> IdeResult<()> {
    state.remote.remote_mkdir(&ssh, &path).await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_rename(state: State<'_, AppState>, ssh: String, from: String, to: String) -> IdeResult<()> {
    state.remote.remote_rename(&ssh, &from, &to).await
}
