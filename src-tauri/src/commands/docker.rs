//! Services tool window › Docker (`ide-docker`).

use crate::state::AppState;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_docker::{
    ComposeOp, ContainerOp, DockerEndpoint, DockerEvent, DockerLogLine, DockerObject, DockerRegistry, DockerSettings,
    DockerSnapshot, PruneTarget, RegistryAuth,
};
use tauri::State;
use tauri::ipc::Channel;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
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

/// Availability plus containers, images, volumes and networks.
#[tauri::command]
#[specta::specta]
pub async fn docker_snapshot(endpoint: DockerEndpoint) -> IdeResult<DockerSnapshot> {
    blocking(move || Ok(ide_docker::snapshot(&endpoint))).await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_container_op(endpoint: DockerEndpoint, ids: Vec<String>, op: ContainerOp) -> IdeResult<()> {
    blocking(move || ide_docker::container_op(&endpoint, &ids, op)).await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_remove(
    endpoint: DockerEndpoint,
    object: DockerObject,
    ids: Vec<String>,
    force: bool,
) -> IdeResult<()> {
    blocking(move || ide_docker::remove(&endpoint, object, &ids, force)).await
}

/// Pretty-printed `docker inspect` JSON.
#[tauri::command]
#[specta::specta]
pub async fn docker_inspect(endpoint: DockerEndpoint, object: DockerObject, id: String) -> IdeResult<String> {
    blocking(move || ide_docker::inspect(&endpoint, object, &id)).await
}

/// Streams a container's log lines until it stops or the request is cancelled.
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
    on_line: Channel<DockerLogLine>,
) -> IdeResult<()> {
    cancellable(&state, request, move |cancel| {
        ide_docker::logs(&endpoint, &id, tail, follow, timestamps, cancel, &|line| {
            let _ = on_line.send(line);
        })
    })
    .await
}

/// Follows `docker events` until the daemon goes away or the request is cancelled.
#[tauri::command]
#[specta::specta]
pub async fn docker_events(
    state: State<'_, AppState>,
    request: RequestId,
    endpoint: DockerEndpoint,
    on_event: Channel<DockerEvent>,
) -> IdeResult<()> {
    cancellable(&state, request, move |cancel| {
        ide_docker::watch_events(&endpoint, cancel, &|e| {
            let _ = on_event.send(e);
        })
    })
    .await
}

/// `docker pull`, logging in first when a saved registry with a password serves the image.
#[tauri::command]
#[specta::specta]
pub async fn docker_pull(
    state: State<'_, AppState>,
    request: RequestId,
    endpoint: DockerEndpoint,
    reference: String,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let data_dir = state.data_dir.clone();
    cancellable(&state, request, move |cancel| {
        let auth = ide_docker::auth_for(&data_dir, &reference);
        ide_docker::pull(&endpoint, &reference, auth.as_ref(), cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_prune(
    state: State<'_, AppState>,
    request: RequestId,
    endpoint: DockerEndpoint,
    target: PruneTarget,
    on_output: Channel<String>,
) -> IdeResult<()> {
    cancellable(&state, request, move |cancel| {
        ide_docker::prune(&endpoint, target, cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

/// `docker compose` start / stop / restart / down of a project found through labels.
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
    cancellable(&state, request, move |cancel| {
        ide_docker::compose_op(&endpoint, &project, &files, working_dir.as_deref(), op, cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

/// Docker connections and registries (app-wide).
#[tauri::command]
#[specta::specta]
pub async fn docker_settings(state: State<'_, AppState>) -> IdeResult<DockerSettings> {
    let data_dir = state.data_dir.clone();
    blocking(move || Ok(ide_docker::load_settings(&data_dir))).await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_save_settings(state: State<'_, AppState>, settings: DockerSettings) -> IdeResult<()> {
    let data_dir = state.data_dir.clone();
    blocking(move || ide_docker::save_settings(&data_dir, &settings)).await
}

/// Saves (`None`: forgets) a registry's password.
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
#[tauri::command]
#[specta::specta]
pub async fn docker_registry_login(
    state: State<'_, AppState>,
    endpoint: DockerEndpoint,
    registry: DockerRegistry,
    password: Option<String>,
) -> IdeResult<String> {
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

/// Environment for a Docker run configuration's command line: selects `endpoint`'s
/// daemon and puts the docker executable on `PATH`.
#[tauri::command]
#[specta::specta]
pub async fn docker_run_env(
    state: State<'_, AppState>,
    endpoint: DockerEndpoint,
) -> IdeResult<std::collections::BTreeMap<String, String>> {
    ide_host::ops::docker::run_env(&state.host, endpoint).await
}
