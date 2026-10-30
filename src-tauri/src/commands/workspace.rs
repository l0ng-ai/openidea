use crate::state::AppState;
use ide_core::{IdeError, IdeResult};
use ide_host::ops::project::ProjectInfo;
use ide_workspace::workspace::Workspace;
use std::path::PathBuf;
use tauri::{Manager, WebviewWindow};

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
    let _ = window.set_title(&info.name);
    window.state::<AppState>().sink.emit(ide_core::IdeEvent::WindowGroupsChanged);
    Ok(info)
}

#[tauri::command]
#[specta::specta]
pub async fn workspace_attach(window: WebviewWindow, path: PathBuf) -> IdeResult<ide_core::IpcPath> {
    let host = window.state::<AppState>().host.clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || ide_host::ops::project::attach_workspace(&host, &label, &path))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}
