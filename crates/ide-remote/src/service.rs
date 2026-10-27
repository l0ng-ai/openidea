//! The deployment and run-target operations of one app, over the shared SSH
//! connections: what the IPC commands and the save hook call.

use crate::deploy::{Deployment, SyncEntry, SyncStep, TransferReport};
use crate::mapping::{Excludes, Mappings};
use crate::target::{RemoteRuns, RemoteStart, SyncFn};
use ide_core::remote_settings::{AutoUpload, DeploymentServer, RunTarget};
use ide_core::settings::Settings;
use ide_core::{CancellationToken, IdeError, IdeResult, SharedSink};
use ide_run::{OutputChunk, RunConfig, RunInfo};
use ide_ssh::{RemoteEntry, RemoteFs, SshManager};
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
    ssh_config: String,
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

pub struct RemoteService {
    ssh: Arc<SshManager>,
    /// Local copies of remote files: `<cache>/<ssh config>/<remote path>`.
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

    async fn fs(&self, ssh_config: &str) -> IdeResult<RemoteFs> {
        if ssh_config.is_empty() {
            return Err(IdeError::invalid("the deployment server has no SSH configuration"));
        }
        let session = self.ssh.session(ssh_config).await?;
        Ok(RemoteFs::new(session.sftp().await?))
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
        let fs = self.fs(&server.ssh_config).await?;
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
        let fs = self.fs(&server.ssh_config).await?;
        let r = fs.resolve(&server.root_path).await;
        fs.close().await;
        r
    }

    pub async fn list(&self, ssh_config: &str, path: &str) -> IdeResult<Vec<RemoteEntry>> {
        let fs = self.fs(ssh_config).await?;
        let r = async { fs.list(&fs.resolve(path).await?).await }.await;
        fs.close().await;
        r
    }

    /// Downloads a remote file for editing; saving the copy uploads it back.
    pub async fn open_remote(&self, ssh_config: &str, remote: &str) -> IdeResult<PathBuf> {
        let rel = remote.split('/').filter(|s| !s.is_empty() && *s != "..").fold(PathBuf::new(), |p, s| p.join(s));
        let local = self.cache.join(sanitize(ssh_config)).join(rel);
        let fs = self.fs(ssh_config).await?;
        let r = fs.download(remote, &local).await;
        fs.close().await;
        r?;
        self.edits
            .lock()
            .insert(local.clone(), RemoteEdit { ssh_config: ssh_config.to_owned(), remote: remote.to_owned() });
        Ok(local)
    }

    /// The remote file a local copy stands for.
    pub fn remote_of(&self, local: &Path) -> Option<(String, String)> {
        self.edits.lock().get(local).map(|e| (e.ssh_config.clone(), e.remote.clone()))
    }

    pub async fn remote_delete(&self, ssh_config: &str, remote: &str) -> IdeResult<()> {
        let fs = self.fs(ssh_config).await?;
        let r = fs.remove(remote).await;
        fs.close().await;
        r
    }

    pub async fn remote_mkdir(&self, ssh_config: &str, remote: &str) -> IdeResult<()> {
        let fs = self.fs(ssh_config).await?;
        let r = fs.mkdir_all(remote).await;
        fs.close().await;
        r
    }

    pub async fn remote_rename(&self, ssh_config: &str, from: &str, to: &str) -> IdeResult<()> {
        let fs = self.fs(ssh_config).await?;
        let r = fs.rename(from, to).await;
        fs.close().await;
        r
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
        let sync: Option<SyncFn> = if target.sync_before_run {
            let deployment = settings.deployment.clone();
            let root = root.to_path_buf();
            let remote_root = remote_root.clone();
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
                        None => Ok(()),
                    }
                })
            }))
        } else {
            fs.close().await;
            None
        };
        let start = RemoteStart { session, target, root: root.to_path_buf(), remote_root, sync };
        Ok(self.runs.start(start, config, sink, on_output))
    }
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}
