//! IPC commands of `ide_host::ops::build` (the shared implementation).

use crate::state::AppState;
use ide_build::compile::{BuildEvent, BuildKind, BuildResult};
use ide_build::pom_edit::ArtifactKey;
use ide_build::{BuildModel, BuildTool, SyncProgress};
use ide_core::{IdeResult, Location, RequestId};
#[allow(unused_imports)]
pub use ide_host::ops::build::*;
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Maven and Gradle projects of the window's project, from the build files plus the last sync.
#[tauri::command]
#[specta::specta]
pub async fn build_model(window: Window, state: State<'_, AppState>) -> IdeResult<BuildModel> {
    ide_host::ops::build::build_model(&state.host, window.label()).await
}

/// Runs Maven (`help:effective-pom dependency:tree`) or Gradle (`tasks --all`) in the
/// background, reporting progress on `on_progress`; cancellable with `cancel_request(request)`.
/// Returns the refreshed model; a failed build is reported in its `syncError`.
#[tauri::command]
#[specta::specta]
pub async fn build_sync(
    window: Window,
    state: State<'_, AppState>,
    tool: BuildTool,
    request: RequestId,
    offline: bool,
    profiles: Vec<String>,
    on_progress: Channel<SyncProgress>,
) -> IdeResult<BuildModel> {
    ide_host::ops::build::build_sync(
        &state.host,
        window.label(),
        tool,
        request,
        offline,
        profiles,
        crate::commands::sender(on_progress),
    )
    .await
}

/// Where the direct dependency `dependency` of the Maven module `pom` is declared.
#[tauri::command]
#[specta::specta]
pub async fn maven_dependency_declaration(
    window: Window,
    state: State<'_, AppState>,
    pom: String,
    dependency: ArtifactKey,
) -> IdeResult<Location> {
    ide_host::ops::build::maven_dependency_declaration(&state.host, window.label(), pom, dependency).await
}

/// Adds an `<exclusion>` of `exclusion` to the declaration of the direct dependency
/// `dependency` of the Maven module `pom`, through the open document when there is one
/// (saved). Returns the declaration; nothing changes when it already excludes it.
#[tauri::command]
#[specta::specta]
pub async fn maven_exclude_dependency(
    window: Window,
    state: State<'_, AppState>,
    pom: String,
    dependency: ArtifactKey,
    exclusion: ArtifactKey,
) -> IdeResult<Location> {
    ide_host::ops::build::maven_exclude_dependency(&state.host, window.label(), pom, dependency, exclusion).await
}

/// Build › Build Project / Rebuild Project / Build Module (`file`: a file or folder of the
/// module) / Build Artifacts, streaming the console and messages on `on_event`; cancellable
/// with `cancel_request(request)`. Diagnostics of `clear` (the files of the previous build)
/// are cleared first; the new messages are published as `build` diagnostics.
#[tauri::command]
#[specta::specta]
pub async fn build_run(
    window: Window,
    state: State<'_, AppState>,
    kind: BuildKind,
    file: Option<std::path::PathBuf>,
    request: RequestId,
    clear: Vec<std::path::PathBuf>,
    on_event: Channel<BuildEvent>,
) -> IdeResult<BuildResult> {
    ide_host::ops::build::build_run(
        &state.host,
        window.label(),
        kind,
        file,
        request,
        clear,
        crate::commands::sender(on_event),
    )
    .await
}
