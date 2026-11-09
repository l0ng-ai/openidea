use crate::state::AppState;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_host::ops::project::ProjectInfo;
use ide_workspace::workspace::Workspace;
use std::path::PathBuf;
use tauri::{Manager, State, WebviewWindow};

#[tauri::command]
#[specta::specta]
pub async fn workspace_discover_projects(
    state: State<'_, AppState>,
    request: RequestId,
    folders: Vec<PathBuf>,
) -> IdeResult<ide_workspace::project_discovery::ProjectDiscovery> {
    let cancel = state.begin_request(request);
    let result =
        tauri::async_runtime::spawn_blocking(move || ide_workspace::project_discovery::discover(folders, &cancel))
            .await
            .map_err(|e| IdeError::internal(e.to_string()));
    state.end_request(request);
    result?
}

#[tauri::command]
#[specta::specta]
pub async fn workspace_create(path: PathBuf, name: String, projects: Vec<PathBuf>) -> IdeResult<ide_core::IpcPath> {
    tauri::async_runtime::spawn_blocking(move || {
        Workspace::save(&path, &name, projects, true)?;
        Ok(dunce::canonicalize(path)?.into())
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

#[tauri::command]
#[specta::specta]
pub async fn workspace_update(window: WebviewWindow, name: String, projects: Vec<PathBuf>) -> IdeResult<ProjectInfo> {
    let host = window.state::<AppState>().host.clone();
    let label = window.label().to_owned();
    let info = tauri::async_runtime::spawn_blocking(move || {
        ide_host::ops::project::save_workspace(&host, &label, &name, projects)
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))??;
    let state = window.state::<AppState>();
    let project = state.project(window.label())?;
    state.record_project(&project)?;
    let _ = window.set_title(&info.display_name);
    window.state::<AppState>().sink.emit(ide_core::IdeEvent::WindowGroupsChanged);
    Ok(info)
}

#[tauri::command]
#[specta::specta]
pub async fn workspace_attach(window: WebviewWindow, path: PathBuf) -> IdeResult<ide_core::IpcPath> {
    let host = window.state::<AppState>().host.clone();
    let label = window.label().to_owned();
    let root =
        tauri::async_runtime::spawn_blocking(move || ide_host::ops::project::attach_workspace(&host, &label, &path))
            .await
            .map_err(|e| IdeError::internal(e.to_string()))??;
    let state = window.state::<AppState>();
    let project = state.project(window.label())?;
    state.record_project(&project)?;
    let _ = window.set_title(&ide_host::ops::project::info(&project).display_name);
    state.sink.emit(ide_core::IdeEvent::WindowGroupsChanged);
    Ok(root)
}
