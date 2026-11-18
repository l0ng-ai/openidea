use crate::Host;
use ide_command::command;
use ide_core::{CancellationToken, IdeEvent, IdeResult, IpcPath, RequestId, SharedSink, TaskId};
use ide_remote::{DeployedPath, DeploymentCoverage, DeploymentRoot, SyncEntry, SyncStep, TransferReport};
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

#[command(trust = always)]
pub async fn deploy_coverage(window: &str, host: &Host, paths: Vec<IpcPath>) -> IdeResult<Vec<DeploymentCoverage>> {
    // Eligible paths per server, without contacting any deployment host.
    let project = host.project(window)?;
    Ok(ide_remote::coverage(&project.settings.effective(), &project.root, &local(paths)))
}

#[command(trust = trusted)]
pub async fn deploy_upload(
    window: &str,
    host: &Host,
    paths: Vec<IpcPath>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    // Tools › Deployment › Upload to…: files and folders to `server` (default server when `None`).
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let (mut report, done) = progress(project.sink.clone(), "Uploading", token.clone());
    let r = host
        .remote
        .upload(&project.settings.effective(), &project.root, server.as_deref(), &local(paths), token, &mut report)
        .await;
    done();
    host.end_request(request);
    r
}

#[command(trust = trusted)]
pub async fn deploy_download(
    window: &str,
    host: &Host,
    paths: Vec<IpcPath>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    // Download from…: the remote counterparts of files and folders.
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let (mut report, done) = progress(project.sink.clone(), "Downloading", token.clone());
    let r = host
        .remote
        .download(&project.settings.effective(), &project.root, server.as_deref(), &local(paths), token, &mut report)
        .await;
    done();
    host.end_request(request);
    r
}

#[command(trust = trusted)]
pub async fn deploy_delete_remote(
    window: &str,
    host: &Host,
    paths: Vec<IpcPath>,
    server: Option<String>,
) -> IdeResult<TransferReport> {
    // Deletes the remote counterparts of files and folders.
    let project = host.project(window)?;
    host.remote.delete_remote(&project.settings.effective(), &project.root, server.as_deref(), &local(paths)).await
}

#[command(trust = trusted)]
pub async fn deploy_compare(
    window: &str,
    host: &Host,
    path: IpcPath,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<Vec<SyncEntry>> {
    // Sync with Deployed: local and remote files under `path`, side by side.
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let r = host.remote.compare(&project.settings.effective(), &project.root, server.as_deref(), &path, token).await;
    host.end_request(request);
    r
}

#[command(trust = trusted)]
pub async fn deploy_sync(
    window: &str,
    host: &Host,
    steps: Vec<SyncStep>,
    server: Option<String>,
    request: RequestId,
) -> IdeResult<TransferReport> {
    // Applies the Sync with Deployed choices.
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let (mut report, done) = progress(project.sink.clone(), "Synchronizing", token.clone());
    let r = host
        .remote
        .sync(&project.settings.effective(), &project.root, server.as_deref(), &steps, token, &mut report)
        .await;
    done();
    host.end_request(request);
    r
}

#[command(trust = trusted)]
pub async fn deploy_info(
    window: &str,
    host: &Host,
    path: IpcPath,
    server: Option<String>,
) -> IdeResult<Option<DeployedPath>> {
    // Where `path` is deployed (remote path, web URL); `None` when not mapped.
    let project = host.project(window)?;
    host.remote.deployed(&project.settings.effective(), &project.root, server.as_deref(), &path).await
}

#[command(trust = trusted)]
pub async fn deploy_server_root(window: &str, host: &Host, server: String) -> IdeResult<DeploymentRoot> {
    // Remote Host tool window: the resolved server root and project mappings.
    let project = host.project(window).ok();
    let settings = project.as_ref().map(|p| p.settings.effective()).unwrap_or_else(|| host.global_settings.effective());
    host.remote.server_info(&settings, project.as_ref().map(|p| p.root.as_path()), &server).await
}

#[command(trust = always)]
pub async fn remote_list(host: &Host, connection: FsConnection, path: String) -> IdeResult<Vec<RemoteEntry>> {
    // Entries of a folder on the selected filesystem (`~`: its home directory).
    host.remote.list(&connection, &path).await
}

#[command(trust = always)]
pub async fn remote_open(host: &Host, connection: FsConnection, path: String) -> IdeResult<IpcPath> {
    // Opens a remote file for editing: a local copy, uploaded back on save.
    Ok(host.remote.open_remote(&connection, &path).await?.into())
}

#[command(trust = always)]
pub fn remote_of(host: &Host, path: IpcPath) -> Option<(FsConnection, String)> {
    // The filesystem connection and path a cached editing copy stands for.
    host.remote.remote_of(&path)
}

#[command(trust = trusted)]
pub async fn remote_delete(host: &Host, connection: FsConnection, path: String) -> IdeResult<()> {
    host.remote.remote_delete(&connection, &path).await
}

#[command(trust = trusted)]
pub async fn remote_mkdir(host: &Host, connection: FsConnection, path: String) -> IdeResult<()> {
    host.remote.remote_mkdir(&connection, &path).await
}

#[command(trust = trusted)]
pub async fn remote_rename(host: &Host, connection: FsConnection, from: String, to: String) -> IdeResult<()> {
    host.remote.remote_rename(&connection, &from, &to).await
}

#[command(trust = trusted)]
pub async fn remote_download_into(
    window: &str,
    host: &Host,
    connection: FsConnection,
    paths: Vec<String>,
    target: IpcPath,
    request: RequestId,
) -> IdeResult<TransferReport> {
    // Remote Host › Download to…: remote files and folders into a local folder, each under its
    // own name.
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let (mut report, done) = progress(project.sink.clone(), "Downloading", token.clone());
    let r = host.remote.download_into(&connection, &paths, &target, &token, &mut report).await;
    done();
    host.end_request(request);
    r
}

#[command(trust = always)]
pub async fn deploy_test_connection(
    host: &Host,
    connection: FsConnection,
    path: String,
    password: Option<String>,
) -> IdeResult<()> {
    // `password`: an FTP password typed in the settings but not applied yet.
    host.remote.test_connection_with(&connection, &path, password).await
}

ide_command::domain!(
    deploy:
    deploy_compare,
    deploy_coverage,
    deploy_delete_remote,
    deploy_download,
    deploy_info,
    deploy_server_root,
    deploy_sync,
    deploy_test_connection,
    deploy_upload,
    remote_delete,
    remote_download_into,
    remote_list,
    remote_mkdir,
    remote_of,
    remote_open,
    remote_rename,
);
