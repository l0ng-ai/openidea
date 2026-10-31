use crate::Host;
use ide_core::{CancellationToken, IdeEvent, IdeResult, IpcPath, RequestId, SharedSink, TaskId};
use ide_remote::{DeployedPath, SyncEntry, SyncStep, TransferReport};
use ide_ssh::{FsConnection, RemoteEntry};
use std::path::PathBuf;

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
pub async fn deploy_upload(
    window: &str,
    state: &Host,
    paths: Vec<IpcPath>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    let project = state.project(window)?;
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
pub async fn deploy_download(
    window: &str,
    state: &Host,
    paths: Vec<IpcPath>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    let project = state.project(window)?;
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
pub async fn deploy_delete_remote(
    window: &str,
    state: &Host,
    paths: Vec<IpcPath>,
    server: Option<String>,
) -> IdeResult<TransferReport> {
    let project = state.project(window)?;
    state.remote.delete_remote(&project.settings.effective(), &project.root, server.as_deref(), &local(paths)).await
}

/// Sync with Deployed: local and remote files under `path`, side by side.
pub async fn deploy_compare(
    window: &str,
    state: &Host,
    path: IpcPath,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<Vec<SyncEntry>> {
    let project = state.project(window)?;
    let token = state.begin_request(request);
    let r = state.remote.compare(&project.settings.effective(), &project.root, server.as_deref(), &path, token).await;
    state.end_request(request);
    r
}

/// Applies the Sync with Deployed choices.
pub async fn deploy_sync(
    window: &str,
    state: &Host,
    steps: Vec<SyncStep>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    let project = state.project(window)?;
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
pub async fn deploy_info(
    window: &str,
    state: &Host,
    path: IpcPath,
    server: Option<String>,
) -> IdeResult<Option<DeployedPath>> {
    let project = state.project(window)?;
    state.remote.deployed(&project.settings.effective(), &project.root, server.as_deref(), &path).await
}

/// Remote Host tool window: the server root of `server`, resolved on the host.
pub async fn deploy_server_root(window: &str, state: &Host, server: String) -> IdeResult<String> {
    let settings = match state.project(window) {
        Ok(p) => p.settings.effective(),
        Err(_) => state.global_settings.effective(),
    };
    state.remote.server_root(&settings, &server).await
}

/// Entries of a folder on the selected filesystem (`~`: its home directory).
pub async fn remote_list(state: &Host, connection: FsConnection, path: String) -> IdeResult<Vec<RemoteEntry>> {
    state.remote.list(&connection, &path).await
}

/// Opens a remote file for editing: a local copy, uploaded back on save.
pub async fn remote_open(state: &Host, connection: FsConnection, path: String) -> IdeResult<IpcPath> {
    Ok(state.remote.open_remote(&connection, &path).await?.into())
}

/// The filesystem connection and path a cached editing copy stands for.
pub fn remote_of(state: &Host, path: IpcPath) -> Option<(FsConnection, String)> {
    state.remote.remote_of(&path)
}

pub async fn remote_delete(state: &Host, connection: FsConnection, path: String) -> IdeResult<()> {
    state.remote.remote_delete(&connection, &path).await
}

pub async fn remote_mkdir(state: &Host, connection: FsConnection, path: String) -> IdeResult<()> {
    state.remote.remote_mkdir(&connection, &path).await
}

pub async fn remote_rename(state: &Host, connection: FsConnection, from: String, to: String) -> IdeResult<()> {
    state.remote.remote_rename(&connection, &from, &to).await
}

pub async fn deploy_test_connection(state: &Host, connection: FsConnection, path: String) -> IdeResult<()> {
    state.remote.test_connection(&connection, &path).await
}

pub(crate) fn register(d: &mut crate::rpc::Dispatcher) {
    d.add("deploy_upload", |c| async move {
        deploy_upload(&c.window, &c.host, c.arg("paths")?, c.arg("server")?, c.arg("request")?).await
    });
    d.add("deploy_download", |c| async move {
        deploy_download(&c.window, &c.host, c.arg("paths")?, c.arg("server")?, c.arg("request")?).await
    });
    d.add("deploy_delete_remote", |c| async move {
        deploy_delete_remote(&c.window, &c.host, c.arg("paths")?, c.arg("server")?).await
    });
    d.add("deploy_compare", |c| async move {
        deploy_compare(&c.window, &c.host, c.arg("path")?, c.arg("server")?, c.arg("request")?).await
    });
    d.add("deploy_sync", |c| async move {
        deploy_sync(&c.window, &c.host, c.arg("steps")?, c.arg("server")?, c.arg("request")?).await
    });
    d.add("deploy_info", |c| async move { deploy_info(&c.window, &c.host, c.arg("path")?, c.arg("server")?).await });
    d.add("deploy_server_root", |c| async move { deploy_server_root(&c.window, &c.host, c.arg("server")?).await });
    d.add("remote_list", |c| async move { remote_list(&c.host, c.arg("connection")?, c.arg("path")?).await });
    d.add("remote_open", |c| async move { remote_open(&c.host, c.arg("connection")?, c.arg("path")?).await });
    d.add("remote_of", |c| async move { Ok(remote_of(&c.host, c.arg("path")?)) });
    d.add("remote_delete", |c| async move { remote_delete(&c.host, c.arg("connection")?, c.arg("path")?).await });
    d.add("remote_mkdir", |c| async move { remote_mkdir(&c.host, c.arg("connection")?, c.arg("path")?).await });
    d.add("remote_rename", |c| async move {
        remote_rename(&c.host, c.arg("connection")?, c.arg("from")?, c.arg("to")?).await
    });
    d.add("deploy_test_connection", |c| async move {
        deploy_test_connection(&c.host, c.arg("connection")?, c.arg("path")?).await
    });
}
