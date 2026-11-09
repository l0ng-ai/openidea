use crate::{window_groups as groups, windows::WindowsState};
use ide_core::{IdeError, IdeResult};
use tauri::{Manager, WebviewWindow};

#[tauri::command]
#[specta::specta]
pub fn window_group_current(window: WebviewWindow) -> IdeResult<Vec<groups::WindowTab>> {
    Ok(groups::current(window.app_handle(), window.label()))
}

#[tauri::command]
#[specta::specta]
pub async fn window_group_merge(window: WebviewWindow) -> IdeResult<()> {
    groups::merge(window.app_handle(), window.label())?;
    groups::persist(window.app_handle()).await
}

#[tauri::command]
#[specta::specta]
pub async fn window_group_select(window: WebviewWindow, label: String) -> IdeResult<()> {
    groups::select(window.app_handle(), window.label(), &label)?;
    groups::persist(window.app_handle()).await
}

#[tauri::command]
#[specta::specta]
pub async fn window_group_detach(window: WebviewWindow) -> IdeResult<()> {
    groups::detach(window.app_handle(), window.label())?;
    groups::persist(window.app_handle()).await
}

#[tauri::command]
#[specta::specta]
pub fn window_group_close(window: WebviewWindow, label: String) -> IdeResult<()> {
    groups::select(window.app_handle(), window.label(), &label)?;
    window
        .app_handle()
        .get_webview_window(&label)
        .ok_or_else(|| IdeError::not_found("Window closed"))?
        .close()
        .map_err(|e| IdeError::internal(e.to_string()))
}

/// Closes several project tabs one by one (each asks about its own unsaved changes), then selects `keep`.
#[tauri::command]
#[specta::specta]
pub fn window_group_close_tabs(window: WebviewWindow, keep: String, labels: Vec<String>) -> IdeResult<()> {
    groups::close_tabs(window.app_handle(), window.label(), &keep, labels)
}

/// This window kept its project open (unsaved-changes prompt cancelled); stops a batch close.
#[tauri::command]
#[specta::specta]
pub fn window_group_cancel_close(window: WebviewWindow) {
    groups::cancel_close(window.app_handle(), window.label());
}

#[tauri::command]
#[specta::specta]
pub async fn window_group_reorder(window: WebviewWindow, labels: Vec<String>) -> IdeResult<()> {
    window.state::<WindowsState>().groups.lock().reorder(window.label(), labels)?;
    groups::select(window.app_handle(), window.label(), window.label())?;
    groups::persist(window.app_handle()).await
}

#[tauri::command]
#[specta::specta]
pub async fn window_group_restore(window: WebviewWindow) -> IdeResult<()> {
    groups::restore(window.app_handle(), window.label()).await
}
