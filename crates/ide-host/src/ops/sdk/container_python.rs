//! A Docker or Compose run target's Python as the project interpreter: snapshots of the
//! container's library folders for the language server (see `ide_sdk::container_python`).
//!
//! A snapshot runs the target's Python once in a new container (the image's entrypoint
//! and the service's dependencies skipped), then copies its `sys.path` folders out of
//! the stopped container with `docker cp`. Nothing is installed in the container.

use crate::Host;
use crate::project::Project;
use ide_core::event::NotifyLevel;
use ide_core::remote_settings::{RunTarget, RunTargetKind};
use ide_core::settings::Settings;
use ide_core::{IdeError, IdeEvent, IdeResult, IpcPath, TaskId};
use ide_sdk::container_python::{self as snapshots, Snapshot};
use ide_sdk::python::PythonPackage;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// Building or pulling the image may come first.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const COPY_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const QUICK: Duration = Duration::from_secs(30);

/// The project interpreter when it is a run target's.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContainerPython {
    /// The run target's id.
    pub target: String,
    /// Its name; empty when no run target has the id.
    pub name: String,
    /// The Python version of the snapshot in use; `None`: no snapshot yet.
    pub version: Option<String>,
    /// The image the snapshot was copied from.
    pub image: Option<String>,
    /// The copied library folders on this machine.
    pub folders: Vec<IpcPath>,
    /// Packages of the snapshot (read-only).
    pub packages: Vec<PythonPackage>,
    /// A snapshot is being taken.
    pub updating: bool,
}

/// Where snapshots are kept, and the Docker connections the targets refer to.
#[derive(Clone)]
struct Dirs {
    data: PathBuf,
    /// `<local data>/container-python/`: `<project>/<target>/<image>/` and `neutral/`.
    cache: PathBuf,
}

impl Dirs {
    fn of(host: &Host) -> Self {
        Self::new(&host.data_dir, &host.local_data_dir)
    }

    fn new(data_dir: &Path, local_data_dir: &Path) -> Self {
        Self { data: data_dir.to_path_buf(), cache: local_data_dir.join("container-python") }
    }

    fn target(&self, root: &Path, target: &str) -> PathBuf {
        snapshots::target_dir(&self.cache.join(crate::project::project_key(root)), target)
    }
}

/// Target folders with a snapshot being taken.
static UPDATING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);

fn updating(dir: &Path) -> bool {
    UPDATING.lock().unwrap_or_else(|e| e.into_inner()).contains(dir)
}

/// The snapshot in use for the project's interpreter, if it is a run target's.
fn current(dirs: &Dirs, root: &Path, settings: &Settings) -> Option<(PathBuf, Snapshot)> {
    let target = settings.languages.python.run_target()?;
    snapshots::current(&dirs.target(root, target))
}

/// Language server configuration: basedpyright / pyright see the container's libraries.
pub(crate) fn configure_server(
    cfg: &mut ide_language::LanguageServerConfig,
    local_data_dir: &Path,
    root: &Path,
    settings: &Settings,
) {
    if settings.languages.python.run_target().is_none() {
        return;
    }
    let current = current(&Dirs::new(local_data_dir, local_data_dir), root, settings);
    snapshots::configure_server(cfg, current.as_ref().map(|(d, s)| (d.as_path(), s)));
}

/// External Libraries: the snapshot's folders, named after the run target.
pub(crate) fn library_group(host: &Host, root: &Path, settings: &Settings) -> Option<ide_sdk::libraries::LibraryGroup> {
    let target = settings.languages.python.run_target()?;
    let (dir, snapshot) = current(&Dirs::of(host), root, settings)?;
    let name = settings.run_targets.iter().find(|t| t.id == target).map_or(target, |t| t.name.as_str());
    snapshots::library_group(name, &dir, &snapshot)
}

/// The project interpreter when it is a run target's, with its snapshot.
pub fn sdk_container_python(host: &Host, window: &str) -> IdeResult<Option<ContainerPython>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    Ok(describe(host, &project.root, &project.settings.effective()))
}

fn describe(host: &Host, root: &Path, settings: &Settings) -> Option<ContainerPython> {
    let target = settings.languages.python.run_target()?;
    let name = settings.run_targets.iter().find(|t| t.id == target).map(|t| t.name.clone()).unwrap_or_default();
    let dir = Dirs::of(host).target(root, target);
    let mut out = ContainerPython {
        target: target.to_owned(),
        name,
        version: None,
        image: None,
        folders: Vec::new(),
        packages: Vec::new(),
        updating: updating(&dir),
    };
    if let Some((dir, snapshot)) = snapshots::current(&dir) {
        out.folders = snapshots::local_folders(&dir, &snapshot).into_iter().map(Into::into).collect();
        out.packages = snapshots::packages(&dir, &snapshot);
        out.version = Some(snapshot.probe.version);
        out.image = Some(snapshot.image);
    }
    Some(out)
}

/// Takes a new snapshot of the project interpreter's container (also of an image that
/// has one already), then the language servers pick it up.
pub async fn sdk_container_python_refresh(host: &Host, window: &str) -> IdeResult<Option<ContainerPython>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    update(Dirs::of(host), &project, true).await?;
    Ok(describe(host, &project.root, &project.settings.effective()))
}

/// Takes a snapshot when the project interpreter is a run target's and the current image
/// has none yet (a new choice, a rebuilt image), in the background. Errors are notified.
pub(crate) fn ensure(host: &Host, project: &Arc<Project>) {
    if !project.is_trusted() || project.settings.effective().languages.python.run_target().is_none() {
        return;
    }
    let (dirs, project) = (Dirs::of(host), project.clone());
    host.runtime.spawn(async move {
        if let Err(e) = update(dirs, &project, false).await
            && e.kind != ide_core::error::ErrorKind::Cancelled
        {
            project.sink.emit(IdeEvent::Notify {
                level: NotifyLevel::Warning,
                title: "Cannot copy the container's Python libraries".into(),
                body: Some(e.message),
            });
        }
    });
}

async fn update(dirs: Dirs, project: &Arc<Project>, force: bool) -> IdeResult<()> {
    let settings = project.settings.effective();
    let Some(id) = settings.languages.python.run_target() else { return Ok(()) };
    let target = ide_remote::service::run_target(&settings, id)?;
    if target.kind == RunTargetKind::Ssh {
        return Err(IdeError::invalid(format!(
            "Run target '{}' runs over SSH: only a Docker or Compose run target can be the project interpreter",
            target.name
        )));
    }
    let dir = dirs.target(&project.root, id);
    if !UPDATING.lock().unwrap_or_else(|e| e.into_inner()).insert(dir.clone()) {
        return Ok(());
    }
    let _done = Updating(dir.clone());
    let endpoint = crate::ops::run::container::endpoint(&dirs.data, &target)?;
    let task = TaskId::next();
    let title = format!("Python libraries of {}", target.name);
    let (root, sink) = (project.root.clone(), project.sink.clone());
    let progress = move |message: &str, done: bool| {
        sink.emit(IdeEvent::Task {
            id: task,
            title: title.clone(),
            message: Some(message.to_owned()),
            fraction: None,
            done,
            cancellable: false,
        })
    };
    let report = progress.clone();
    let result = tokio::task::spawn_blocking(move || {
        take(&endpoint, &root, &target, &dir, &dirs.cache, force, &|message| report(message, false))
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))
    .and_then(|r| r);
    progress(if result.is_ok() { "Done" } else { "Failed" }, true);
    if result? {
        project.lsp.reconfigure().await;
    }
    Ok(())
}

struct Updating(PathBuf);

impl Drop for Updating {
    fn drop(&mut self) {
        UPDATING.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

/// Removes the probe container, also when copying failed.
struct Container<'a> {
    endpoint: &'a ide_docker::DockerEndpoint,
    name: String,
}

impl Drop for Container<'_> {
    fn drop(&mut self) {
        let args = ["rm", "--force", "--volumes", &self.name].map(String::from);
        if let Err(e) = ide_docker::cli(self.endpoint, None, &args, QUICK, None) {
            tracing::warn!("cannot remove container {}: {}", self.name, e.message);
        }
    }
}

/// Takes the snapshot in `target_dir` and makes it the one in use; `false` when the image
/// had one already and it is in use (unless `force`).
fn take(
    endpoint: &ide_docker::DockerEndpoint,
    root: &Path,
    target: &RunTarget,
    target_dir: &Path,
    cache: &Path,
    force: bool,
    progress: &dyn Fn(&str),
) -> IdeResult<bool> {
    crate::ops::run::container::require_local(endpoint, target)?;
    let container_root = crate::ops::run::container::container_root(endpoint, root, target)?;
    let name = format!("openidea-python-{}", unique());
    let args = ide_remote::docker::python_probe_args(target, root, &name, snapshots::PROBE)?;
    progress("Starting the container's Python");
    let container = Container { endpoint, name };
    let out = ide_docker::cli(endpoint, Some(root), &args, PROBE_TIMEOUT, None);
    let probe = snapshots::parse_probe(&out?)?;
    let inspect = ["inspect".into(), "--format".into(), "{{.Image}}".into(), container.name.clone()];
    let image = ide_docker::cli(endpoint, None, &inspect, QUICK, None)?.trim().to_owned();
    if image.is_empty() {
        return Err(IdeError::internal(format!("docker inspect printed no image for {}", container.name)));
    }
    let dir = target_dir.join(snapshots::dir_name(&image));
    let before = snapshots::current(target_dir).map(|(_, s)| s.image);
    if !force && snapshots::read(&dir).is_some() {
        snapshots::make_current(target_dir, &image)?;
        return Ok(before.as_deref() != Some(image.as_str()));
    }
    let partial = target_dir.join(format!("{}.partial", snapshots::dir_name(&image)));
    if partial.exists() {
        std::fs::remove_dir_all(&partial)?;
    }
    std::fs::create_dir_all(&partial)?;
    let mut folders = Vec::new();
    for folder in snapshots::folders_to_copy(&probe, &container_root) {
        progress(&format!("Copying {folder}"));
        let local = snapshots::local_folder(&partial, &folder);
        let Some(parent) = local.parent() else { continue };
        std::fs::create_dir_all(parent)?;
        // Into an existing folder: `docker cp` puts the source folder in it under its own name.
        let args = ["cp".into(), format!("{}:{folder}", container.name), format!("{}/", parent.to_string_lossy())];
        match ide_docker::cli(endpoint, None, &args, COPY_TIMEOUT, None) {
            Ok(_) => folders.push(folder),
            Err(e) => tracing::warn!("cannot copy {folder} from {}: {}", container.name, e.message),
        }
    }
    drop(container);
    progress("Preparing the language server's interpreter");
    let snapshot = Snapshot {
        neutral_python: snapshots::neutral_python(cache, &probe.version),
        image: image.clone(),
        probe,
        folders,
    };
    snapshots::write(&partial, &snapshot)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::rename(&partial, &dir)?;
    snapshots::make_current(target_dir, &image)?;
    Ok(true)
}

/// Distinguishes probe containers.
fn unique() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNT: AtomicU32 = AtomicU32::new(0);
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    format!("{:x}-{}-{}", secs & 0xff_ffff, std::process::id(), COUNT.fetch_add(1, Ordering::Relaxed))
}
