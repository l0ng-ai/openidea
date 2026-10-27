//! Maven / Gradle tool windows (the build model and its background sync) and
//! Build › Build Project (compiling with the project's build system).

use crate::state::AppState;
use ide_build::compile::{self, BuildEvent, BuildKind, BuildResult};
use ide_build::{BuildModel, BuildTool, SyncOptions, SyncProgress};
use ide_core::settings::Settings;
use ide_core::{IdeError, IdeEvent, IdeResult, RequestId};
use std::collections::BTreeMap;
use std::path::Path;
use tauri::ipc::Channel;
use tauri::{State, Window};

fn join_err(e: tauri::Error) -> IdeError {
    IdeError::internal(e.to_string())
}

/// `JAVA_HOME`: the project JDK, else the installed JDK matching `release` (none
/// when the project names no version).
fn java_env(project_jdk: Option<&ide_sdk::java::Jdk>, release: Option<u32>) -> BTreeMap<String, String> {
    let jdks = ide_sdk::java::installed_jdks();
    let jdk = project_jdk.or_else(|| release.and_then(|r| ide_sdk::java::pick_jdk(&jdks, Some(r))));
    jdk.map(|j| BTreeMap::from([("JAVA_HOME".to_owned(), j.home.to_string_lossy().into_owned())])).unwrap_or_default()
}

/// The build model with the launch settings applied: the JDK (`JAVA_HOME`), and
/// the Maven home and options from Settings › Maven.
pub(crate) fn load(root: &Path, cache: &Path, settings: &Settings) -> BuildModel {
    let mut model = ide_build::load(root, cache, ide_sdk::apply::maven_local_repository(root, settings));
    let jdk = ide_sdk::apply::project_jdk(root, settings);
    if let Some(m) = &mut model.maven {
        let mvn = ide_sdk::apply::maven_command(root, settings);
        let options = ide_sdk::apply::maven_options(root, settings);
        for p in &mut m.projects {
            p.env = java_env(jdk.as_ref(), p.java_version);
            if let Some(mvn) = &mvn {
                p.command = mvn.to_string_lossy().into_owned();
            }
            p.options = options.clone();
        }
    }
    if let Some(g) = &mut model.gradle {
        g.env = java_env(jdk.as_ref(), g.java_version);
    }
    // A failed sync of a project no installed JDK can build says so first (with a Download JDK action).
    let missing = |release: Option<u32>| match jdk {
        Some(_) => None,
        None => ide_sdk::java::missing_jdk_message(&ide_sdk::java::installed_jdks(), release),
    };
    let explain = |error: &mut Option<String>, hint: Option<String>| {
        if let (Some(e), Some(hint)) = (error.as_mut(), hint) {
            *e = format!("{hint}\n{e}");
        }
    };
    if let Some(m) = &mut model.maven
        && m.sync_error.is_some()
    {
        let hint = m.projects.iter().find_map(|p| missing(p.java_version));
        explain(&mut m.sync_error, hint);
    }
    if let Some(g) = &mut model.gradle
        && g.sync_error.is_some()
    {
        let hint = missing(g.java_version);
        explain(&mut g.sync_error, hint);
    }
    model
}

/// Maven and Gradle projects of the window's project, from the build files plus the last sync.
#[tauri::command]
#[specta::specta]
pub async fn build_model(window: Window, state: State<'_, AppState>) -> IdeResult<BuildModel> {
    let project = state.project(window.label())?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    tauri::async_runtime::spawn_blocking(move || load(&root, &cache, &settings)).await.map_err(join_err)
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
    let project = state.project(window.label())?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    let token = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let current = load(&root, &cache, &settings);
        let env = match tool {
            BuildTool::Maven => current
                .maven
                .as_ref()
                .and_then(|m| m.projects.iter().find(|p| !p.env.is_empty()))
                .map(|p| p.env.clone())
                .unwrap_or_default(),
            BuildTool::Gradle => current.gradle.as_ref().map(|g| g.env.clone()).unwrap_or_default(),
        };
        let options = SyncOptions {
            offline,
            profiles,
            env,
            maven_command: ide_sdk::apply::maven_command(&root, &settings).map(|p| p.to_string_lossy().into_owned()),
            maven_options: ide_sdk::apply::maven_options(&root, &settings),
        };
        let progress = |p: SyncProgress| {
            let _ = on_progress.send(p);
        };
        match tool {
            BuildTool::Maven => ide_build::sync_maven(&root, &cache, &options, &token, &progress)?,
            BuildTool::Gradle => ide_build::sync_gradle(&root, &cache, &options, &token, &progress)?,
        }
        Ok(load(&root, &cache, &settings))
    })
    .await
    .map_err(join_err);
    state.end_request(request);
    result?
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
    let project = state.project(window.label())?;
    let (root, cache, sink) = (project.root.clone(), project.build_cache_dir(), project.sink.clone());
    let settings = project.settings.effective();
    let token = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
        for path in clear {
            sink.emit(IdeEvent::Diagnostics {
                path: path.into(),
                source: compile::DIAGNOSTICS_SOURCE.into(),
                items: Vec::new(),
            });
        }
        let plan = compile::plan(&root, &load(&root, &cache, &settings), kind, file.as_deref())?;
        let result = compile::run(&root, &plan, &token, &|e| {
            let _ = on_event.send(e);
        })?;
        for (path, items) in compile::diagnostics(&result.messages) {
            sink.emit(IdeEvent::Diagnostics { path: path.into(), source: compile::DIAGNOSTICS_SOURCE.into(), items });
        }
        Ok(result)
    })
    .await
    .map_err(join_err);
    state.end_request(request);
    result?
}
