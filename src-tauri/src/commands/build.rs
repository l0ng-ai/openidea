//! IPC commands of `ide_host::ops::build` (the shared implementation).

use crate::state::AppState;
use ide_build::compile::{BuildEvent, BuildKind, BuildResult};
use ide_build::maven::PomGoto;
use ide_build::pom_edit::ArtifactKey;
use ide_build::{BuildModel, BuildTool, SyncProgress};
use ide_core::{DocId, IdeResult, Location, Pos, RequestId};
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

#[tauri::command]
#[specta::specta]
pub async fn gradle_link_projects(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> IdeResult<BuildModel> {
    ide_host::ops::build::gradle_link_projects(&state.host, window.label(), paths).await
}

#[tauri::command]
#[specta::specta]
pub async fn gradle_unlink_projects(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> IdeResult<BuildModel> {
    ide_host::ops::build::gradle_unlink_projects(&state.host, window.label(), paths).await
}

/// Runs Maven (`help:effective-pom dependency:tree`) or Gradle (`tasks --all`) in the
/// background, reporting progress on `on_progress`; cancellable with `cancel_request(request)`.
/// Returns the refreshed model; a failed build is reported in its `syncError`.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn build_sync(
    window: Window,
    state: State<'_, AppState>,
    tool: BuildTool,
    request: RequestId,
    offline: bool,
    profiles: Vec<String>,
    build_dir: Option<String>,
    on_progress: Channel<SyncProgress>,
) -> IdeResult<BuildModel> {
    ide_host::ops::build::build_sync(
        &state.host,
        window.label(),
        tool,
        request,
        offline,
        profiles,
        build_dir,
        crate::commands::sender(on_progress),
    )
    .await
}

/// The resolved dependency tree of a Gradle project for one configuration (Dependency Analyzer).
#[tauri::command]
#[specta::specta]
pub async fn gradle_dependencies(
    window: Window,
    state: State<'_, AppState>,
    gradle_path: String,
    configuration: String,
    offline: bool,
    request: RequestId,
    build_dir: Option<String>,
) -> IdeResult<Vec<ide_build::GradleDependency>> {
    ide_host::ops::build::gradle_dependencies(
        &state.host,
        window.label(),
        gradle_path,
        configuration,
        offline,
        request,
        build_dir,
    )
    .await
}

/// The `.toml` of a version catalog the build imports as `group:artifact:version`, once a
/// build has downloaded it.
#[tauri::command]
#[specta::specta]
pub async fn gradle_published_catalog(
    window: Window,
    state: State<'_, AppState>,
    coordinates: String,
) -> IdeResult<Option<ide_core::IpcPath>> {
    ide_host::ops::build::gradle_published_catalog(&state.host, window.label(), coordinates).await
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

/// The go-to-declaration target at `pos` of a Maven POM: the definition of the
/// `${property}` at the caret, or the `<dependencyManagement>` / `<pluginManagement>`
/// entry providing the dependency's / plugin's version, along the parent chain.
#[tauri::command]
#[specta::specta]
pub async fn maven_goto_declaration(
    window: Window,
    state: State<'_, AppState>,
    pom: String,
    pos: Pos,
) -> IdeResult<Option<PomGoto>> {
    ide_host::ops::build::maven_goto_declaration(&state.host, window.label(), pom, pos).await
}

/// Completion of the `<dependency>` coordinate the caret (`offset`, UTF-16) sits
/// in the value of in the POM `doc`, from the local repository and Maven Central.
#[tauri::command]
#[specta::specta]
pub async fn maven_dependency_completion(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    offset: u32,
    request: RequestId,
) -> IdeResult<Option<ide_build::maven::completion::PomCompletion>> {
    ide_host::ops::build::maven_dependency_completion(&state.host, window.label(), doc, offset, request).await
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
#[allow(clippy::too_many_arguments)]
pub async fn build_run(
    window: Window,
    state: State<'_, AppState>,
    kind: BuildKind,
    file: Option<std::path::PathBuf>,
    cmake: Option<String>,
    request: RequestId,
    clear: Vec<std::path::PathBuf>,
    on_event: Channel<BuildEvent>,
) -> IdeResult<BuildResult> {
    ide_host::ops::build::build_run(
        &state.host,
        window.label(),
        kind,
        file,
        cmake,
        request,
        clear,
        crate::commands::sender(on_event),
    )
    .await
}

/// Build › Compile File: compiles one Java source of a linked Maven module with
/// `javac`, streaming the console and messages on `on_event`; cancellable with
/// `cancel_request(request)`. Diagnostics of `clear` (the files of the previous
/// build) are cleared first; the new messages are published as `build`
/// diagnostics.
#[tauri::command]
#[specta::specta]
pub async fn build_compile_file(
    window: Window,
    state: State<'_, AppState>,
    file: std::path::PathBuf,
    request: RequestId,
    clear: Vec<std::path::PathBuf>,
    on_event: Channel<BuildEvent>,
) -> IdeResult<BuildResult> {
    ide_host::ops::build::build_compile_file(
        &state.host,
        window.label(),
        file,
        request,
        clear,
        crate::commands::sender(on_event),
    )
    .await
}
