//! Services tool window › Docker (`ide-docker`) and Docker run configurations: run on the
//! project host (`Host` locally, `openidea-server` in a remote window), with SSH connections
//! tunnelled through the host's own SSH client.
use super::Channel;
use crate::Host;
use ide_command::command;
use ide_core::{CancellationToken, IdeError, IdeResult, RequestId};
use ide_docker::{
    ComposeOp, ContainerOp, DockerContainerStats, DockerEndpoint, DockerEvent, DockerImageLayer, DockerLogLine,
    DockerObject, DockerProcessList, DockerRegistry, DockerSettings, DockerSnapshot, PruneTarget, RegistryAuth,
};
use ide_ssh::Tunnel;
use std::collections::{BTreeMap, HashMap};

/// What each tunnelled connection runs on the SSH host, as the Docker CLI's `ssh://` does.
const DIAL: &str = "docker system dial-stdio";

/// Open tunnels of [`DockerEndpoint::Ssh`] connections, by SSH configuration id.
#[derive(Default)]
pub struct DockerTunnels(tokio::sync::Mutex<HashMap<String, Tunnel>>);

/// `endpoint` as docker can use it: an SSH configuration becomes the local end of a tunnel to its
/// host's daemon (opened on first use, reopened when the SSH connection dropped).
pub async fn resolve(host: &Host, endpoint: DockerEndpoint) -> IdeResult<DockerEndpoint> {
    let DockerEndpoint::Ssh { config } = endpoint else { return Ok(endpoint) };
    let id = config.trim().to_owned();
    let mut tunnels = host.docker_tunnels.0.lock().await;
    let port = match tunnels.get(&id).filter(|t| !t.is_closed()) {
        Some(t) => t.port(),
        None => {
            let session = host.ssh.session(&id).await?;
            // Fail with the reason here: a missing docker only shows as a dropped connection later.
            let probe = session.exec("docker version --format {{.Client.Version}}", None).await?;
            if !probe.success() {
                let why = String::from_utf8_lossy(&probe.stderr).trim().to_owned();
                return Err(IdeError::unavailable(format!(
                    "docker could not be run on {} over SSH{}",
                    session.label(),
                    if why.is_empty() { String::new() } else { format!(": {why}") }
                )));
            }
            let t = Tunnel::command(session, DIAL).await?;
            let port = t.port();
            tunnels.insert(id, t);
            port
        }
    };
    Ok(DockerEndpoint::Tcp { host: format!("tcp://127.0.0.1:{port}"), tls_cert_dir: None })
}

/// Closes what [`resolve`] opened for `endpoint`: an SSH configuration's tunnel, and then its SSH
/// connection unless something else (a terminal, a transfer) holds it. The next [`resolve`] opens
/// them again; other endpoints keep nothing open.
pub async fn disconnect(host: &Host, endpoint: &DockerEndpoint) {
    let DockerEndpoint::Ssh { config } = endpoint else { return };
    let id = config.trim();
    let Some(tunnel) = host.docker_tunnels.0.lock().await.remove(id) else { return };
    tunnel.close().await;
    host.ssh.release(id);
}

/// Runs a cancellable docker command (`request` → `cancel_request`) off the async workers.
async fn cancellable<T: Send + 'static>(
    host: &Host,
    request: RequestId,
    f: impl FnOnce(&CancellationToken) -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    let cancel = host.begin_request(request);
    let result = host.blocking(move || f(&cancel)).await;
    host.end_request(request);
    result
}

/// Closes the connection's SSH tunnel and, when nothing else uses it, its SSH connection
/// (Services › Disconnect); other endpoints keep nothing open.
#[command(trust = always)]
pub async fn docker_disconnect(host: &Host, endpoint: DockerEndpoint) -> IdeResult<()> {
    disconnect(host, &endpoint).await;
    Ok(())
}

/// Availability plus containers, images, volumes and networks.
#[command(trust = trusted)]
pub async fn docker_snapshot(host: &Host, endpoint: DockerEndpoint) -> IdeResult<DockerSnapshot> {
    let endpoint = resolve(host, endpoint).await?;
    host.blocking(move || Ok(ide_docker::snapshot(&endpoint))).await
}

#[command(trust = trusted)]
pub async fn docker_container_op(
    host: &Host,
    endpoint: DockerEndpoint,
    ids: Vec<String>,
    op: ContainerOp,
) -> IdeResult<()> {
    let endpoint = resolve(host, endpoint).await?;
    host.blocking(move || ide_docker::container_op(&endpoint, &ids, op)).await
}

#[command(trust = trusted)]
pub async fn docker_remove(
    host: &Host,
    endpoint: DockerEndpoint,
    object: DockerObject,
    ids: Vec<String>,
    force: bool,
) -> IdeResult<()> {
    let endpoint = resolve(host, endpoint).await?;
    host.blocking(move || ide_docker::remove(&endpoint, object, &ids, force)).await
}

/// Pretty-printed `docker inspect` JSON.
#[command(trust = trusted)]
pub async fn docker_inspect(
    host: &Host,
    endpoint: DockerEndpoint,
    object: DockerObject,
    id: String,
) -> IdeResult<String> {
    let endpoint = resolve(host, endpoint).await?;
    host.blocking(move || ide_docker::inspect(&endpoint, object, &id)).await
}

/// Layers of an image (`docker image history`).
#[command(trust = trusted)]
pub async fn docker_image_history(
    host: &Host,
    endpoint: DockerEndpoint,
    id: String,
) -> IdeResult<Vec<DockerImageLayer>> {
    let endpoint = resolve(host, endpoint).await?;
    host.blocking(move || ide_docker::image_history(&endpoint, &id)).await
}

/// Processes running inside a container (`docker top`).
#[command(trust = trusted)]
pub async fn docker_container_top(host: &Host, endpoint: DockerEndpoint, id: String) -> IdeResult<DockerProcessList> {
    let endpoint = resolve(host, endpoint).await?;
    host.blocking(move || ide_docker::container_top(&endpoint, &id)).await
}

/// One-shot resource usage snapshot of a running container (`docker stats --no-stream`).
#[command(trust = trusted)]
pub async fn docker_container_stats(
    host: &Host,
    endpoint: DockerEndpoint,
    id: String,
) -> IdeResult<DockerContainerStats> {
    let endpoint = resolve(host, endpoint).await?;
    host.blocking(move || ide_docker::container_stats(&endpoint, &id)).await
}

/// Disk usage per volume name (`docker system df -v`).
#[command(trust = trusted)]
pub async fn docker_volume_sizes(host: &Host, endpoint: DockerEndpoint) -> IdeResult<BTreeMap<String, String>> {
    let endpoint = resolve(host, endpoint).await?;
    host.blocking(move || ide_docker::volume_sizes(&endpoint)).await
}

/// Streams a container's log lines, in batches, until it stops or the request is cancelled.
#[command(trust = trusted)]
#[allow(clippy::too_many_arguments)]
pub async fn docker_logs(
    host: &Host,
    request: RequestId,
    endpoint: DockerEndpoint,
    id: String,
    tail: u32,
    follow: bool,
    timestamps: bool,
    on_lines: Channel<Vec<DockerLogLine>>,
) -> IdeResult<()> {
    let endpoint = resolve(host, endpoint).await?;
    cancellable(host, request, move |cancel| {
        ide_docker::logs(&endpoint, &id, tail, follow, timestamps, cancel, &|lines| {
            let _ = on_lines.send(lines);
        })
    })
    .await
}

/// Follows `docker events` until the daemon goes away or the request is cancelled.
#[command(trust = trusted)]
pub async fn docker_events(
    host: &Host,
    request: RequestId,
    endpoint: DockerEndpoint,
    on_event: Channel<DockerEvent>,
) -> IdeResult<()> {
    let endpoint = resolve(host, endpoint).await?;
    cancellable(host, request, move |cancel| {
        ide_docker::watch_events(&endpoint, cancel, &|e| {
            let _ = on_event.send(e);
        })
    })
    .await
}

/// `docker pull`, logging in first when a saved registry with a password serves the image.
#[command(trust = trusted)]
pub async fn docker_pull(
    host: &Host,
    request: RequestId,
    endpoint: DockerEndpoint,
    reference: String,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let endpoint = resolve(host, endpoint).await?;
    let data_dir = host.data_dir.clone();
    cancellable(host, request, move |cancel| {
        let auth = ide_docker::auth_for(&data_dir, &reference);
        ide_docker::pull(&endpoint, &reference, auth.as_ref(), cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

#[command(trust = trusted)]
pub async fn docker_prune(
    host: &Host,
    request: RequestId,
    endpoint: DockerEndpoint,
    target: PruneTarget,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let endpoint = resolve(host, endpoint).await?;
    cancellable(host, request, move |cancel| {
        ide_docker::prune(&endpoint, target, cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

/// `docker compose` start / stop / restart / down of a project found through labels.
#[command(trust = trusted)]
#[allow(clippy::too_many_arguments)]
pub async fn docker_compose_op(
    host: &Host,
    request: RequestId,
    endpoint: DockerEndpoint,
    project: String,
    files: Vec<String>,
    working_dir: Option<String>,
    op: ComposeOp,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let endpoint = resolve(host, endpoint).await?;
    cancellable(host, request, move |cancel| {
        ide_docker::compose_op(&endpoint, &project, &files, working_dir.as_deref(), op, cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

/// Docker connections and registries of the project host.
#[command(trust = always)]
pub async fn docker_settings(host: &Host) -> IdeResult<DockerSettings> {
    let data_dir = host.data_dir.clone();
    host.blocking(move || Ok(ide_docker::load_settings(&data_dir))).await
}

#[command(trust = always)]
pub async fn docker_save_settings(host: &Host, settings: DockerSettings) -> IdeResult<()> {
    let data_dir = host.data_dir.clone();
    host.blocking(move || ide_docker::save_settings(&data_dir, &settings)).await
}

/// Saves (`None`: forgets) a registry's password.
#[command(trust = always)]
pub async fn docker_set_registry_password(host: &Host, id: String, password: Option<String>) -> IdeResult<()> {
    let data_dir = host.data_dir.clone();
    host.blocking(move || ide_docker::set_registry_password(&data_dir, &id, password.as_deref())).await
}

/// Test login to `registry` (`password`, else the saved one) through `endpoint`'s daemon.
#[command(trust = trusted)]
pub async fn docker_registry_login(
    host: &Host,
    endpoint: DockerEndpoint,
    registry: DockerRegistry,
    password: Option<String>,
) -> IdeResult<String> {
    let endpoint = resolve(host, endpoint).await?;
    let data_dir = host.data_dir.clone();
    host.blocking(move || {
        let password = password
            .or_else(|| ide_docker::registry_password(&data_dir, &registry.id))
            .ok_or_else(|| IdeError::invalid("enter the registry password"))?;
        let auth = RegistryAuth { address: registry.address, username: registry.username, password };
        ide_docker::login(&endpoint, &auth)
    })
    .await
}

/// Environment for a Docker run configuration's command line: selects `endpoint`'s
/// daemon and puts the docker executable on `PATH`.
#[command(trust = always)]
pub async fn docker_run_env(host: &Host, endpoint: DockerEndpoint) -> IdeResult<BTreeMap<String, String>> {
    // A remote project gets them from the server, since its run configurations start on the remote host.
    endpoint.validate()?;
    let endpoint = resolve(host, endpoint).await?;
    host.blocking(move || Ok(ide_docker::run_env(&endpoint))).await
}

ide_command::domain!(
    docker:
    docker_compose_op,
    docker_container_op,
    docker_container_stats,
    docker_container_top,
    docker_disconnect,
    docker_events,
    docker_image_history,
    docker_inspect,
    docker_logs,
    docker_prune,
    docker_pull,
    docker_registry_login,
    docker_remove,
    docker_run_env,
    docker_save_settings,
    docker_set_registry_password,
    docker_settings,
    docker_snapshot,
    docker_volume_sizes,
);
