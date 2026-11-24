//! Services tool window › Docker (`ide-docker`).

use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_docker::{
    ComposeOp, ContainerOp, DockerContainerStats, DockerEndpoint, DockerEvent, DockerImageLayer, DockerLogLine,
    DockerObject, DockerProcessList, DockerRegistry, DockerSettings, DockerSnapshot, PruneTarget, RegistryAuth,
};
use tauri::State;
use tauri::ipc::Channel;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// `endpoint` with an SSH configuration's tunnel opened (see [`ide_host::ops::docker::resolve`]).
async fn resolve(state: &AppState, endpoint: DockerEndpoint) -> IdeResult<DockerEndpoint> {
    ide_host::ops::docker::resolve(&state.host, endpoint).await
}

/// Runs a cancellable docker command (`request` → `cancel_request`) off the command threads.
async fn cancellable<T: Send + 'static>(
    state: &AppState,
    request: RequestId,
    f: impl FnOnce(&ide_core::CancellationToken) -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    let cancel = state.begin_request(request);
    let result = blocking(move || f(&cancel)).await;
    state.end_request(request);
    result
}

/// Closes the connection's SSH tunnel and, when nothing else uses it, its SSH connection
/// (Services › Disconnect); other endpoints keep nothing open.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn docker_disconnect(state: State<'_, AppState>, endpoint: DockerEndpoint) -> IdeResult<()> {
    ide_host::ops::docker::disconnect(&state.host, &endpoint).await;
    Ok(())
}

/// Availability plus containers, images, volumes and networks.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_snapshot(state: State<'_, AppState>, endpoint: DockerEndpoint) -> IdeResult<DockerSnapshot> {
    let endpoint = resolve(&state, endpoint).await?;
    blocking(move || Ok(ide_docker::snapshot(&endpoint))).await
}

#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_container_op(
    state: State<'_, AppState>,
    endpoint: DockerEndpoint,
    ids: Vec<String>,
    op: ContainerOp,
) -> IdeResult<()> {
    let endpoint = resolve(&state, endpoint).await?;
    blocking(move || ide_docker::container_op(&endpoint, &ids, op)).await
}

#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_remove(
    state: State<'_, AppState>,
    endpoint: DockerEndpoint,
    object: DockerObject,
    ids: Vec<String>,
    force: bool,
) -> IdeResult<()> {
    let endpoint = resolve(&state, endpoint).await?;
    blocking(move || ide_docker::remove(&endpoint, object, &ids, force)).await
}

/// Pretty-printed `docker inspect` JSON.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_inspect(
    state: State<'_, AppState>,
    endpoint: DockerEndpoint,
    object: DockerObject,
    id: String,
) -> IdeResult<String> {
    let endpoint = resolve(&state, endpoint).await?;
    blocking(move || ide_docker::inspect(&endpoint, object, &id)).await
}

/// Layers of an image (`docker image history`).
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_image_history(
    state: State<'_, AppState>,
    endpoint: DockerEndpoint,
    id: String,
) -> IdeResult<Vec<DockerImageLayer>> {
    let endpoint = resolve(&state, endpoint).await?;
    blocking(move || ide_docker::image_history(&endpoint, &id)).await
}

/// Processes running inside a container (`docker top`).
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_container_top(
    state: State<'_, AppState>,
    endpoint: DockerEndpoint,
    id: String,
) -> IdeResult<DockerProcessList> {
    let endpoint = resolve(&state, endpoint).await?;
    blocking(move || ide_docker::container_top(&endpoint, &id)).await
}

/// One-shot resource usage snapshot of a running container (`docker stats --no-stream`).
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_container_stats(
    state: State<'_, AppState>,
    endpoint: DockerEndpoint,
    id: String,
) -> IdeResult<DockerContainerStats> {
    let endpoint = resolve(&state, endpoint).await?;
    blocking(move || ide_docker::container_stats(&endpoint, &id)).await
}

/// Streams a container's log lines, in batches, until it stops or the request is cancelled.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn docker_logs(
    state: State<'_, AppState>,
    request: RequestId,
    endpoint: DockerEndpoint,
    id: String,
    tail: u32,
    follow: bool,
    timestamps: bool,
    on_lines: Channel<Vec<DockerLogLine>>,
) -> IdeResult<()> {
    let endpoint = resolve(&state, endpoint).await?;
    cancellable(&state, request, move |cancel| {
        ide_docker::logs(&endpoint, &id, tail, follow, timestamps, cancel, &|lines| {
            let _ = on_lines.send(lines);
        })
    })
    .await
}

/// Follows `docker events` until the daemon goes away or the request is cancelled.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_events(
    state: State<'_, AppState>,
    request: RequestId,
    endpoint: DockerEndpoint,
    on_event: Channel<DockerEvent>,
) -> IdeResult<()> {
    let endpoint = resolve(&state, endpoint).await?;
    cancellable(&state, request, move |cancel| {
        ide_docker::watch_events(&endpoint, cancel, &|e| {
            let _ = on_event.send(e);
        })
    })
    .await
}

/// `docker pull`, logging in first when a saved registry with a password serves the image.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_pull(
    state: State<'_, AppState>,
    request: RequestId,
    endpoint: DockerEndpoint,
    reference: String,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let endpoint = resolve(&state, endpoint).await?;
    let data_dir = state.data_dir.clone();
    cancellable(&state, request, move |cancel| {
        let auth = ide_docker::auth_for(&data_dir, &reference);
        ide_docker::pull(&endpoint, &reference, auth.as_ref(), cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_prune(
    state: State<'_, AppState>,
    request: RequestId,
    endpoint: DockerEndpoint,
    target: PruneTarget,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let endpoint = resolve(&state, endpoint).await?;
    cancellable(&state, request, move |cancel| {
        ide_docker::prune(&endpoint, target, cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

/// `docker compose` start / stop / restart / down of a project found through labels.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn docker_compose_op(
    state: State<'_, AppState>,
    request: RequestId,
    endpoint: DockerEndpoint,
    project: String,
    files: Vec<String>,
    working_dir: Option<String>,
    op: ComposeOp,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let endpoint = resolve(&state, endpoint).await?;
    cancellable(&state, request, move |cancel| {
        ide_docker::compose_op(&endpoint, &project, &files, working_dir.as_deref(), op, cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

/// Docker connections and registries (app-wide).
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn docker_settings(state: State<'_, AppState>) -> IdeResult<DockerSettings> {
    let data_dir = state.data_dir.clone();
    blocking(move || Ok(ide_docker::load_settings(&data_dir))).await
}

#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn docker_save_settings(state: State<'_, AppState>, settings: DockerSettings) -> IdeResult<()> {
    let data_dir = state.data_dir.clone();
    blocking(move || ide_docker::save_settings(&data_dir, &settings)).await
}

/// Saves (`None`: forgets) a registry's password.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn docker_set_registry_password(
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> IdeResult<()> {
    let data_dir = state.data_dir.clone();
    blocking(move || ide_docker::set_registry_password(&data_dir, &id, password.as_deref())).await
}

/// Test login to `registry` (`password`, else the saved one) through `endpoint`'s daemon.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn docker_registry_login(
    state: State<'_, AppState>,
    endpoint: DockerEndpoint,
    registry: DockerRegistry,
    password: Option<String>,
) -> IdeResult<String> {
    let endpoint = resolve(&state, endpoint).await?;
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let password = password
            .or_else(|| ide_docker::registry_password(&data_dir, &registry.id))
            .ok_or_else(|| IdeError::invalid("enter the registry password"))?;
        let auth = RegistryAuth { address: registry.address, username: registry.username, password };
        ide_docker::login(&endpoint, &auth)
    })
    .await
}

ide_command::desktop_domain!(
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
    docker_save_settings,
    docker_set_registry_password,
    docker_settings,
    docker_snapshot,
);
