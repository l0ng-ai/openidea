//! Docker and Compose run targets: the configuration becomes a local run of the
//! docker CLI (see `ide_remote::docker`).

use crate::Host;
use ide_core::remote_settings::{RunTarget, RunTargetKind};
use ide_core::{IdeError, IdeResult};
use ide_docker::DockerEndpoint;
use ide_remote::docker::{
    ContainerDebug, ContainerRun, DEBUG_BOOTSTRAP, DEBUG_BOOTSTRAP_NAME, compose_container_root, container_config,
    container_name, default_container_root,
};
use ide_run::RunConfig;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Set by the Debug action on a configuration that runs on a container target: the
/// program starts under debugpy and waits for the debugger.
const DEBUG_PARAM: &str = "containerDebug";

/// `config` rewritten to run in a new container of `target`'s image or service.
pub(super) async fn prepare(host: &Host, root: &Path, target: RunTarget, config: RunConfig) -> IdeResult<RunConfig> {
    if config.kind == "dotnet" || config.kind == "dotnet-test" {
        return Err(IdeError::invalid(".NET Project requires the local machine"));
    }
    let debug = config.extras.params.get(DEBUG_PARAM).is_some_and(|v| v == "true");
    if debug && config.debug_adapter.as_deref() != Some("debugpy") {
        return Err(IdeError::invalid(format!(
            "'{}' can't be debugged in a container: only Python run configurations can",
            config.name
        )));
    }
    let endpoint = endpoint(&host.data_dir, &target)?;
    let root = root.to_path_buf();
    let data_dir = host.data_dir.clone();
    host.blocking(move || {
        if !ide_docker::endpoint_is_local(&endpoint)? {
            return Err(IdeError::invalid(format!(
                "Run target '{}' uses a Docker daemon on another machine: the project can only be mounted from a local one",
                target.name
            )));
        }
        let docker = ide_docker::docker_executable().ok_or_else(|| {
            IdeError::unavailable("docker executable not found; install Docker and make sure it is on PATH")
        })?;
        let container_root = match target.container_root.trim() {
            "" if target.kind == RunTargetKind::Compose => {
                let json = ide_docker::compose_config(&endpoint, &root, &target.compose_files)?;
                compose_container_root(&json, target.service.trim(), &root)?
            }
            "" => default_container_root(&root),
            folder => folder.to_owned(),
        };
        let file_env = env_files(&root, &config)?;
        let name = container_name(&config.id, &unique());
        let debugging = if debug { Some(Debugging::prepare(&data_dir)?) } else { None };
        container_config(
            &config,
            &ContainerRun {
                target: &target,
                root: &root,
                container_root: &container_root,
                docker: &docker.to_string_lossy(),
                endpoint_env: &ide_docker::run_env(&endpoint),
                file_env: &file_env,
                name: &name,
                user: user(&root, &target),
                debug: debugging.as_ref().map(|d| ContainerDebug {
                    port: d.port,
                    bootstrap_dir: &d.bootstrap_dir,
                    debugpy: d.debugpy.as_deref(),
                }),
            },
        )
    })
    .await
}

/// What a debug run mounts and publishes.
struct Debugging {
    port: u16,
    bootstrap_dir: PathBuf,
    debugpy: Option<PathBuf>,
}

impl Debugging {
    fn prepare(data_dir: &Path) -> IdeResult<Self> {
        // The bootstrap is (re)written on each run, so it matches this version of the IDE.
        let bootstrap_dir = data_dir.join("container-debug");
        std::fs::create_dir_all(&bootstrap_dir)?;
        std::fs::write(bootstrap_dir.join(DEBUG_BOOTSTRAP_NAME), DEBUG_BOOTSTRAP)?;
        // The managed install the local debugger falls back to (`ide_dap::adapter::prepare_debugpy`).
        let tools = ide_dap::adapter::tools_root().unwrap_or_else(|| ide_tools::tools_dir(data_dir));
        let lib = ide_tools::python_lib_dir(&tools, ide_dap::adapter::DEBUGPY_TOOL);
        let debugpy = lib.join("debugpy").join("__init__.py").is_file().then_some(lib);
        Ok(Self { port: free_port()?, bootstrap_dir, debugpy })
    }
}

/// A port nobody listens on here: debugpy listens on the same port in the container,
/// published on the loopback interface.
fn free_port() -> IdeResult<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// The target's Docker connection (Services tool window), by id; none = the CLI's daemon.
fn endpoint(data_dir: &Path, target: &RunTarget) -> IdeResult<DockerEndpoint> {
    let id = target.docker_connection.trim();
    if id.is_empty() {
        return Ok(DockerEndpoint::Default);
    }
    ide_docker::load_settings(data_dir).connections.into_iter().find(|c| c.id == id).map(|c| c.endpoint).ok_or_else(
        || {
            IdeError::not_found(format!(
                "Run target '{}' uses a Docker connection that no longer exists; choose one in Settings › Run Targets",
                target.name
            ))
        },
    )
}

/// The configuration's `.env` files, read here: the container gets their variables.
fn env_files(root: &Path, config: &RunConfig) -> IdeResult<BTreeMap<String, String>> {
    let extras = &config.extras;
    if extras.env_files.is_empty() {
        return Ok(BTreeMap::new());
    }
    let paths: Vec<PathBuf> = extras
        .env_files
        .iter()
        .map(|f| if Path::new(f).is_absolute() { PathBuf::from(f) } else { root.join(f) })
        .collect();
    let base = if extras.include_system_env { ide_run::system_env() } else { BTreeMap::new() };
    ide_run::envfile::load(&paths, &base).map_err(|e| IdeError::not_found(format!("cannot read .env file: {e}")))
}

/// On Linux the container writes files as the project folder's owner, unless the
/// target keeps the image's user. Docker Desktop and OrbStack map ownership themselves.
fn user(root: &Path, target: &RunTarget) -> Option<(u32, u32)> {
    #[cfg(target_os = "linux")]
    if !target.image_user {
        use std::os::unix::fs::MetadataExt;
        return std::fs::metadata(root).ok().map(|m| (m.uid(), m.gid()));
    }
    let _ = (root, target);
    None
}

/// Distinguishes runs of the same configuration.
fn unique() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNT: AtomicU32 = AtomicU32::new(0);
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    format!("{:x}-{}", secs & 0xff_ffff, COUNT.fetch_add(1, Ordering::Relaxed))
}
