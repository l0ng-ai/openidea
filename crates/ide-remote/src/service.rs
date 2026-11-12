//! Deployment over SFTP, FTP or local folders, and SSH run targets.
//! Shared by IPC commands and project save/delete hooks.

use crate::deploy::{Deployment, FileStamp, SyncEntry, SyncStatus, SyncStep, TransferReport, status};
use crate::mapping::{Excludes, Mappings, ResolvedMapping, posix};
use crate::target::{RemoteRuns, RemoteStart, SyncFn, rewrite_external_classpath};
use ide_core::remote_settings::{AutoUpload, DeploymentServer, DeploymentType, RunTarget};
use ide_core::settings::Settings;
use ide_core::{CancellationToken, IdeError, IdeResult, SharedSink};
use ide_run::{OutputChunk, RunConfig, RunInfo};
use ide_ssh::sftp::{join, mtime_of};
use ide_ssh::{FsConnection, RemoteEntry, RemoteFs, SshManager};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Progress of a transfer: (project-relative path, index, total).
pub type Progress<'a> = &'a mut (dyn FnMut(&str, usize, usize) + Send);

/// A remote file opened for editing (a local copy uploaded back on save).
#[derive(Debug, Clone)]
struct RemoteEdit {
    connection: FsConnection,
    remote: String,
}

/// Where a local file is deployed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeployedPath {
    pub server: String,
    pub remote_path: String,
    pub web_url: Option<String>,
}

/// Resolved root and project mappings of the Remote Host browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DeploymentRoot {
    pub root: String,
    pub mappings: Vec<ResolvedMapping>,
}

pub struct RemoteService {
    ssh: Arc<SshManager>,
    /// Local copies of remote files, separated by filesystem connection.
    cache: PathBuf,
    edits: Mutex<HashMap<PathBuf, RemoteEdit>>,
    pub runs: RemoteRuns,
}

/// The deployment server `id`, or the default one.
pub fn server(settings: &Settings, id: Option<&str>) -> IdeResult<DeploymentServer> {
    let d = &settings.deployment;
    let id = id.filter(|s| !s.is_empty()).unwrap_or(&d.default_server);
    if id.is_empty() {
        return Err(IdeError::invalid("no default deployment server (Settings › Deployment)"));
    }
    d.servers
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or_else(|| IdeError::not_found(format!("no deployment server {id}")))
}

pub fn run_target(settings: &Settings, id: &str) -> IdeResult<RunTarget> {
    settings
        .run_targets
        .iter()
        .find(|t| t.id == id)
        .cloned()
        .ok_or_else(|| IdeError::not_found(format!("no run target {id} (Settings › Run Targets)")))
}

impl RemoteService {
    pub fn new(ssh: Arc<SshManager>, cache: PathBuf) -> Self {
        Self { ssh, cache, edits: Mutex::default(), runs: RemoteRuns::new() }
    }

    async fn fs(&self, connection: &FsConnection) -> IdeResult<RemoteFs> {
        match connection {
            FsConnection::Local => Ok(RemoteFs::Local),
            FsConnection::Sftp { ssh } => {
                if ssh.is_empty() {
                    return Err(IdeError::invalid("the deployment server has no SSH configuration"));
                }
                let session = self.ssh.session(ssh).await?;
                Ok(RemoteFs::new(session.sftp().await?))
            }
            FsConnection::Ftp { server, secure, ftp } => {
                let password = self.ssh.password(&ide_ssh::ftp::secret_key(server));
                Ok(RemoteFs::Ftp(ide_ssh::ftp::FtpFs::connect(ftp, *secure, password).await?))
            }
        }
    }

    pub async fn test_connection(&self, connection: &FsConnection, path: &str) -> IdeResult<()> {
        let fs = self.fs(connection).await?;
        let result = fs.test(path).await;
        fs.close().await;
        result
    }

    /// Runs `f` with a [`Deployment`] on `server`.
    async fn with_deployment<T>(
        &self,
        settings: &Settings,
        root: &Path,
        server: &DeploymentServer,
        cancel: CancellationToken,
        f: impl AsyncFnOnce(&Deployment<'_>) -> T,
    ) -> IdeResult<T> {
        let fs = self.fs(&connection(server)).await?;
        let remote_root = match fs.resolve(&server.root_path).await {
            Ok(r) => r,
            Err(e) => {
                fs.close().await;
                return Err(e);
            }
        };
        let map = Mappings::new(server, root, &remote_root);
        let exclude = Excludes::new(&settings.deployment, server, &remote_root);
        let d = Deployment {
            fs: &fs,
            map: &map,
            exclude: &exclude,
            preserve_time: settings.deployment.preserve_timestamps,
            cancel,
        };
        let out = f(&d).await;
        fs.close().await;
        Ok(out)
    }

    pub async fn upload(
        &self,
        settings: &Settings,
        root: &Path,
        server_id: Option<&str>,
        paths: &[PathBuf],
        cancel: CancellationToken,
        progress: Progress<'_>,
    ) -> IdeResult<TransferReport> {
        let server = server(settings, server_id)?;
        self.with_deployment(settings, root, &server, cancel, async |d| d.upload(paths, progress).await).await
    }

    pub async fn download(
        &self,
        settings: &Settings,
        root: &Path,
        server_id: Option<&str>,
        paths: &[PathBuf],
        cancel: CancellationToken,
        progress: Progress<'_>,
    ) -> IdeResult<TransferReport> {
        let server = server(settings, server_id)?;
        self.with_deployment(settings, root, &server, cancel, async |d| d.download(paths, progress).await).await
    }

    pub async fn delete_remote(
        &self,
        settings: &Settings,
        root: &Path,
        server_id: Option<&str>,
        paths: &[PathBuf],
    ) -> IdeResult<TransferReport> {
        let server = server(settings, server_id)?;
        self.with_deployment(settings, root, &server, CancellationToken::new(), async |d| d.delete_remote(paths).await)
            .await
    }

    pub async fn compare(
        &self,
        settings: &Settings,
        root: &Path,
        server_id: Option<&str>,
        path: &Path,
        cancel: CancellationToken,
    ) -> IdeResult<Vec<SyncEntry>> {
        let server = server(settings, server_id)?;
        self.with_deployment(settings, root, &server, cancel, async |d| d.compare(path).await).await?
    }

    pub async fn sync(
        &self,
        settings: &Settings,
        root: &Path,
        server_id: Option<&str>,
        steps: &[SyncStep],
        cancel: CancellationToken,
        progress: Progress<'_>,
    ) -> IdeResult<TransferReport> {
        let server = server(settings, server_id)?;
        self.with_deployment(settings, root, &server, cancel, async |d| d.apply(steps, progress).await).await
    }

    /// Where `path` is deployed on `server_id` (or the default server).
    pub async fn deployed(
        &self,
        settings: &Settings,
        root: &Path,
        server_id: Option<&str>,
        path: &Path,
    ) -> IdeResult<Option<DeployedPath>> {
        let server = server(settings, server_id)?;
        let name = server.name.clone();
        self.with_deployment(settings, root, &server, CancellationToken::new(), async |d| {
            d.map.remote(path).map(|remote_path| DeployedPath {
                server: name,
                remote_path,
                web_url: d.map.web_url(path),
            })
        })
        .await
    }

    // --- Remote Host browser -------------------------------------------------------

    /// The server root of `server_id`, resolved on the host.
    pub async fn server_root(&self, settings: &Settings, server_id: &str) -> IdeResult<String> {
        let server = server(settings, Some(server_id))?;
        let fs = self.fs(&connection(&server)).await?;
        let r = fs.resolve(&server.root_path).await;
        fs.close().await;
        r
    }

    pub async fn server_info(
        &self,
        settings: &Settings,
        project_root: Option<&Path>,
        server_id: &str,
    ) -> IdeResult<DeploymentRoot> {
        let root = self.server_root(settings, server_id).await?;
        let server = server(settings, Some(server_id))?;
        let mappings = project_root.map(|p| Mappings::new(&server, p, &root).resolved()).unwrap_or_default();
        Ok(DeploymentRoot { root, mappings })
    }

    pub async fn list(&self, connection: &FsConnection, path: &str) -> IdeResult<Vec<RemoteEntry>> {
        let fs = self.fs(connection).await?;
        let r = async { fs.list(&fs.resolve(path).await?).await }.await;
        fs.close().await;
        r
    }

    /// Downloads a remote file for editing; saving the copy uploads it back.
    pub async fn open_remote(&self, connection: &FsConnection, remote: &str) -> IdeResult<PathBuf> {
        let rel = remote
            .split('/')
            .filter(|s| !s.is_empty() && *s != ".." && *s != ".")
            .fold(PathBuf::new(), |p, s| p.join(s.replace('%', "%25").replace(':', "%3A").replace('\\', "%5C")));
        let local = self.cache.join(sanitize(&cache_key(connection))).join(rel);
        let fs = self.fs(connection).await?;
        let r = fs.download(remote, &local).await;
        fs.close().await;
        r?;
        self.edits
            .lock()
            .insert(local.clone(), RemoteEdit { connection: connection.clone(), remote: remote.to_owned() });
        Ok(local)
    }

    /// The remote file a local copy stands for.
    pub fn remote_of(&self, local: &Path) -> Option<(FsConnection, String)> {
        self.edits.lock().get(local).map(|e| (e.connection.clone(), e.remote.clone()))
    }

    pub async fn remote_delete(&self, connection: &FsConnection, remote: &str) -> IdeResult<()> {
        let fs = self.fs(connection).await?;
        let r = fs.remove(remote).await;
        fs.close().await;
        r
    }

    pub async fn remote_mkdir(&self, connection: &FsConnection, remote: &str) -> IdeResult<()> {
        let fs = self.fs(connection).await?;
        let r = fs.mkdir_all(remote).await;
        fs.close().await;
        r
    }

    pub async fn remote_rename(&self, connection: &FsConnection, from: &str, to: &str) -> IdeResult<()> {
        let fs = self.fs(connection).await?;
        let r = fs.rename(from, to).await;
        fs.close().await;
        r
    }

    /// Remote Host › Download to…: `remotes` (folders recursively) into the local folder `dir`,
    /// each under its own name, without the server path above it. Existing files are replaced.
    pub async fn download_into(
        &self,
        connection: &FsConnection,
        remotes: &[String],
        dir: &Path,
        cancel: &CancellationToken,
        progress: &mut (dyn FnMut(&str, usize, usize) + Send),
    ) -> IdeResult<TransferReport> {
        let fs = self.fs(connection).await?;
        let mut report = TransferReport::default();
        let mut folders = Vec::new();
        let mut jobs = Vec::new();
        for remote in remotes {
            let Some(top) = download_target(dir, remote, remote) else {
                report.skipped += 1;
                continue;
            };
            match fs.stat(remote).await {
                Ok(Some(e)) if e.is_dir => {
                    folders.push(top);
                    let mut entries = Vec::new();
                    if let Err(e) = remote_tree(&fs, remote, cancel, &mut entries).await {
                        report.fail(remote.clone(), e);
                    }
                    for entry in entries {
                        match download_target(dir, remote, &entry.path) {
                            Some(local) if entry.is_dir => folders.push(local),
                            Some(local) => jobs.push((entry.path, local)),
                            None => report.skipped += 1,
                        }
                    }
                }
                Ok(Some(_)) => jobs.push((remote.clone(), top)),
                Ok(None) => report.fail(remote.clone(), IdeError::not_found(format!("{remote} does not exist"))),
                Err(e) => report.fail(remote.clone(), e),
            }
        }
        for folder in &folders {
            if let Err(e) = tokio::fs::create_dir_all(folder).await {
                report.fail(folder.display().to_string(), e.into());
            }
        }
        for (i, (remote, local)) in jobs.iter().enumerate() {
            if cancel.is_cancelled() {
                break;
            }
            progress(remote, i, jobs.len());
            if let Some(parent) = local.parent()
                && let Err(e) = tokio::fs::create_dir_all(parent).await
            {
                report.fail(remote.clone(), e.into());
                continue;
            }
            match fs.download(remote, local).await {
                Ok(()) => report.files += 1,
                Err(e) => report.fail(remote.clone(), e),
            }
        }
        fs.close().await;
        Ok(report)
    }

    // --- save hook -----------------------------------------------------------------

    /// After a document save: uploads a remote file's copy, or (automatic upload)
    /// the file to the default server. `None` when nothing applies.
    pub async fn on_saved(&self, settings: &Settings, root: &Path, path: &Path) -> Option<IdeResult<TransferReport>> {
        if let Some((config, remote)) = self.remote_of(path) {
            let r = async {
                let fs = self.fs(&config).await?;
                let r = fs.upload(path, &remote, false).await;
                fs.close().await;
                r.map(|()| TransferReport { files: 1, ..Default::default() })
            }
            .await;
            return Some(r);
        }
        if settings.deployment.auto_upload == AutoUpload::Never
            || settings.deployment.default_server.is_empty()
            || !path.starts_with(root)
        {
            return None;
        }
        Some(
            self.upload(settings, root, None, &[path.to_path_buf()], CancellationToken::new(), &mut |_, _, _| {}).await,
        )
    }

    /// After files were deleted locally: their remote copies too (automatic upload + Delete remote files).
    pub async fn on_deleted(
        &self,
        settings: &Settings,
        root: &Path,
        paths: &[PathBuf],
    ) -> Option<IdeResult<TransferReport>> {
        let d = &settings.deployment;
        if d.auto_upload == AutoUpload::Never || !d.delete_remote || d.default_server.is_empty() {
            return None;
        }
        Some(self.delete_remote(settings, root, None, paths).await)
    }

    // --- run targets ---------------------------------------------------------------

    /// Starts `config` on its run target.
    pub async fn run(
        &self,
        settings: &Settings,
        root: &Path,
        config: &RunConfig,
        sink: SharedSink,
        on_output: Box<dyn Fn(OutputChunk) + Send + Sync>,
    ) -> IdeResult<RunInfo> {
        let target_id = config.extras.target.as_deref().unwrap_or_default();
        let target = run_target(settings, target_id)?;
        if target.kind != ide_core::remote_settings::RunTargetKind::Ssh {
            return Err(IdeError::internal("container run targets start as local runs of the docker CLI"));
        }
        let session = self.ssh.session(&target.ssh_config).await?;
        let fs = RemoteFs::new(session.sftp().await?);
        let folder = if target.project_root.trim().is_empty() {
            format!(
                "~/{}",
                root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into())
            )
        } else {
            target.project_root.clone()
        };
        let remote_root = fs.resolve(&folder).await;
        let remote_root = match remote_root {
            Ok(r) => r,
            Err(e) => {
                fs.close().await;
                return Err(e);
            }
        };
        // #2641: the resolved `-cp` may reference jars outside the project root
        // (`~/.m2`), which deployment sync never uploads. Mirror them under the
        // deployment and rewrite the command onto the remote copies. Entries inside
        // the project root are untouched: `target_command` maps those already.
        let (args, libraries) = rewrite_external_classpath(&config.args, root, &remote_root);
        let mut config = config.clone();
        config.args = args;
        for (local, _) in &libraries {
            if !local.exists() {
                fs.close().await;
                return Err(IdeError::invalid(format!(
                    "cannot run on '{}': classpath entry {} does not exist on this machine; \
                     package the application (for example `mvn package`) or fix the launch classpath",
                    target.name,
                    local.display()
                )));
            }
        }
        let sync: Option<SyncFn> = if target.sync_before_run {
            let deployment = settings.deployment.clone();
            let root = root.to_path_buf();
            let remote_root = remote_root.clone();
            let preserve_time = settings.deployment.preserve_timestamps;
            Some(Box::new(move |out| {
                Box::pin(async move {
                    let server = DeploymentServer { root_path: remote_root.clone(), ..Default::default() };
                    let map = Mappings::new(&server, &root, &remote_root);
                    let exclude = Excludes::new(&deployment, &server, &remote_root);
                    let d = Deployment {
                        fs: &fs,
                        map: &map,
                        exclude: &exclude,
                        preserve_time: true,
                        cancel: CancellationToken::new(),
                    };
                    let mut progress = |_: &str, _: usize, _: usize| {};
                    let report = d.push_changes(&root, &mut progress).await;
                    let synced = sync_external_libraries(&fs, &libraries, preserve_time).await;
                    fs.close().await;
                    let report = report?;
                    out(OutputChunk::System {
                        text: format!("Uploaded {} changed file(s) to {remote_root}\n", report.files),
                    });
                    match report.errors.first() {
                        Some(e) => Err(IdeError::new(
                            ide_core::error::ErrorKind::Io,
                            format!("upload of {} failed: {}", e.path, e.message),
                        )),
                        None => {
                            let synced = synced?;
                            if synced > 0 {
                                out(OutputChunk::System {
                                    text: format!(
                                        "Synced {synced} external classpath file(s) to {remote_root}/.remote-libs\n"
                                    ),
                                });
                            }
                            Ok(())
                        }
                    }
                })
            }))
        } else {
            fs.close().await;
            None
        };
        let start = RemoteStart { session, target, root: root.to_path_buf(), remote_root, sync };
        Ok(self.runs.start(start, &config, sink, on_output))
    }
}

/// Uploads outside-root classpath entries to their mirrored remote copies,
/// skipping files the remote already has (same size and time). Returns the
/// uploaded count. Missing locals are rejected in `run` before the sync starts.
async fn sync_external_libraries(
    fs: &RemoteFs,
    libraries: &[(PathBuf, String)],
    preserve_time: bool,
) -> IdeResult<usize> {
    fn fail(path: &str, e: IdeError) -> IdeError {
        IdeError::new(ide_core::error::ErrorKind::Io, format!("sync of {path} failed: {}", e.message))
    }
    let mut synced = 0;
    for (local, remote_base) in libraries {
        let mut files = Vec::new();
        if local.is_dir() {
            let walk = ignore::WalkBuilder::new(local).standard_filters(false).follow_links(false).build();
            for entry in walk.flatten() {
                let path = entry.path();
                // `is_file` (not the entry type): symlinked jars count.
                if !path.is_file() {
                    continue;
                }
                let Ok(rel) = path.strip_prefix(local) else { continue };
                files.push((path.to_path_buf(), join(remote_base, &posix(rel))));
            }
        } else {
            files.push((local.clone(), remote_base.clone()));
        }
        for (file, remote) in files {
            let size = std::fs::metadata(&file).map_err(|e| fail(&remote, e.into()))?.len();
            let local_stamp = FileStamp { size, mtime: mtime_of(&file) };
            let remote_stamp = match fs.stat(&remote).await.map_err(|e| fail(&remote, e))? {
                Some(e) if e.is_dir => {
                    return Err(IdeError::invalid(format!("cannot sync onto the folder {remote}")));
                }
                Some(e) => Some(FileStamp { size: e.size, mtime: e.mtime }),
                None => None,
            };
            if matches!(status(Some(local_stamp), remote_stamp), SyncStatus::Same) {
                continue;
            }
            fs.upload(&file, &remote, preserve_time).await.map_err(|e| fail(&remote, e))?;
            synced += 1;
        }
    }
    Ok(synced)
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// A server's transport, also used by the browser and remote editor save hook.
pub fn connection(server: &DeploymentServer) -> FsConnection {
    match server.kind {
        DeploymentType::Local => FsConnection::Local,
        DeploymentType::Sftp => FsConnection::Sftp { ssh: server.ssh_config.clone() },
        DeploymentType::Ftp | DeploymentType::Ftps => FsConnection::Ftp {
            server: server.id.clone(),
            secure: server.kind == DeploymentType::Ftps,
            ftp: server.ftp.clone(),
        },
    }
}

fn cache_key(connection: &FsConnection) -> String {
    match connection {
        FsConnection::Local => "local".to_owned(),
        FsConnection::Sftp { ssh } => format!("sftp-{ssh}"),
        FsConnection::Ftp { server, .. } => format!("ftp-{server}"),
    }
}

/// Files and folders under remote folder `dir` (symlinked folders are not followed).
async fn remote_tree(
    fs: &RemoteFs,
    dir: &str,
    cancel: &CancellationToken,
    out: &mut Vec<RemoteEntry>,
) -> IdeResult<()> {
    for e in fs.list(dir).await? {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let descend = e.is_dir && !e.is_symlink;
        let path = e.path.clone();
        out.push(e);
        if descend {
            Box::pin(remote_tree(fs, &path, cancel, out)).await?;
        }
    }
    Ok(())
}

/// Where remote `path`, inside the downloaded `selected` file or folder, lands under local `dir`:
/// `dir/<name of selected>/<rest>`. `None` for a name that would leave `dir`.
fn download_target(dir: &Path, selected: &str, path: &str) -> Option<PathBuf> {
    let selected = selected.trim_end_matches('/');
    let name = selected.rsplit('/').next()?;
    let rest = path.trim_end_matches('/').strip_prefix(selected)?;
    if !rest.is_empty() && !rest.starts_with('/') {
        return None;
    }
    let mut local = dir.to_path_buf();
    for part in std::iter::once(name).chain(rest.split('/').filter(|p| !p.is_empty())) {
        if matches!(part, "" | "." | "..") || part.contains('\\') || (cfg!(windows) && part.contains(':')) {
            return None;
        }
        local.push(part);
    }
    Some(local)
}

#[cfg(test)]
mod download_into_tests {
    use super::*;

    #[test]
    fn downloads_keep_only_the_selected_name() {
        let dir = Path::new("/p/project");
        let selected = "/home/u/www/site/current/drush";
        assert_eq!(download_target(dir, selected, selected), Some(dir.join("drush")));
        assert_eq!(download_target(dir, "/home/u/www/site/current/drush/", selected), Some(dir.join("drush")));
        assert_eq!(
            download_target(dir, selected, "/home/u/www/site/current/drush/src/a.php"),
            Some(dir.join("drush").join("src").join("a.php"))
        );
        assert_eq!(download_target(dir, "/srv/app.log", "/srv/app.log"), Some(dir.join("app.log")));
    }

    #[test]
    fn names_that_would_leave_the_folder_are_refused() {
        let dir = Path::new("/p/project");
        assert_eq!(download_target(dir, "/srv/a", "/srv/a/../../etc/passwd"), None);
        assert_eq!(download_target(dir, "/srv/a", "/srv/ab/x"), None, "a sibling with the same prefix");
        assert_eq!(download_target(dir, "/", "/etc"), None, "the root has no name");
        assert_eq!(download_target(dir, "/srv/..", "/srv/.."), None);
    }
}
