//! Desktop adapter for application-drawn project tabs. Each member retains its WebView and services.
use crate::{
    state::AppState,
    windows::{self, WindowsState},
};
use ide_core::{IdeError, IdeEvent, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowTab {
    pub label: String,
    pub name: String,
    pub root: Option<ide_core::IpcPath>,
    pub current: bool,
}

pub fn current(app: &AppHandle, caller: &str) -> Vec<WindowTab> {
    let state = app.state::<WindowsState>();
    let Some(group) = state.groups.lock().group(caller).cloned() else { return Vec::new() };
    let host = app.state::<AppState>();
    group
        .members
        .iter()
        .filter_map(|label| {
            let window = app.get_webview_window(label)?;
            let project = host.project(label).ok();
            let name = project
                .as_ref()
                .map(|p| ide_host::ops::project::info(p).name)
                .unwrap_or_else(|| window.title().unwrap_or_default());
            Some(WindowTab {
                label: label.clone(),
                name,
                root: project.map(|p| p.root.clone().into()),
                current: label == caller,
            })
        })
        .collect()
}

fn changed(app: &AppHandle) {
    app.state::<AppState>().sink.emit(IdeEvent::WindowGroupsChanged);
}

fn copy_frame(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let fullscreen = from.is_fullscreen().map_err(err)?;
    if fullscreen {
        from.set_fullscreen(false).map_err(err)?;
        to.set_fullscreen(true).map_err(err)?;
        return Ok(());
    }
    to.set_fullscreen(false).map_err(err)?;
    let maximized = from.is_maximized().map_err(err)?;
    if !maximized {
        to.unmaximize().map_err(err)?;
        to.set_position(from.outer_position().map_err(err)?).map_err(err)?;
        to.set_size(from.inner_size().map_err(err)?).map_err(err)?;
    } else {
        to.maximize().map_err(err)?;
    }
    Ok(())
}

pub fn select(app: &AppHandle, caller: &str, target: &str) -> IdeResult<()> {
    let to = app.get_webview_window(target).ok_or_else(|| IdeError::not_found("Window closed"))?;
    let state = app.state::<WindowsState>();
    let previous = state.groups.lock().select(caller, target)?;
    let result = (|| {
        if previous.selected != target
            && let Some(from) = app.get_webview_window(&previous.selected)
        {
            copy_frame(&from, &to)?;
        }
        to.unminimize().map_err(|e| IdeError::internal(e.to_string()))?;
        to.show().map_err(|e| IdeError::internal(e.to_string()))?;
        to.set_focus().map_err(|e| IdeError::internal(e.to_string()))?;
        for member in &previous.members {
            if member != target
                && let Some(window) = app.get_webview_window(member)
            {
                window.hide().map_err(|e| IdeError::internal(e.to_string()))?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = state.groups.lock().select(caller, &previous.selected);
        for member in &previous.members {
            if let Some(window) = app.get_webview_window(member) {
                if member == &previous.selected {
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
                    let _ = window.hide();
                }
            }
        }
    }
    changed(app);
    result
}

pub fn merge(app: &AppHandle, caller: &str) -> IdeResult<()> {
    let members = windows::project_window_labels(app)
        .into_iter()
        .filter(|label| app.state::<AppState>().project(label).is_ok_and(|p| !p.light))
        .collect::<Vec<_>>();
    if members.len() < 2 || !members.iter().any(|label| label == caller) {
        return Err(IdeError::invalid("Open at least two project windows to create a window group"));
    }
    // Native fullscreen puts each window in a separate Space; leave it before grouping.
    for label in &members {
        if let Some(window) = app.get_webview_window(label) {
            window.set_fullscreen(false).map_err(|e| IdeError::internal(e.to_string()))?;
        }
    }
    app.state::<WindowsState>().groups.lock().merge(members, caller)?;
    select(app, caller, caller)
}

pub fn detach(app: &AppHandle, caller: &str) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    let next = state.groups.lock().detach(caller);
    if let Some(next) = next {
        if let Some(window) = app.get_webview_window(&next) {
            window.show().map_err(|e| IdeError::internal(e.to_string()))?;
        }
        if let Some(window) = app.get_webview_window(caller) {
            if let Ok(position) = window.outer_position() {
                let _ = window.set_position(tauri::PhysicalPosition::new(position.x + 32, position.y + 32));
            }
            windows::focus(&window);
        }
    }
    changed(app);
    Ok(())
}

pub fn destroyed(app: &AppHandle, caller: &str) {
    let Some(state) = app.try_state::<WindowsState>() else { return };
    let next = state.groups.lock().detach(caller);
    if !state.quitting() {
        if let Some(window) = next.and_then(|label| app.get_webview_window(&label)) {
            windows::focus(&window);
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = persist(&app).await;
        });
    }
    changed(app);
}

#[derive(Serialize, Deserialize)]
struct SavedGroup {
    projects: Vec<PathBuf>,
    selected: usize,
}

pub async fn persist(app: &AppHandle) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    let _write = state.groups_persist.lock().await;
    if state.quitting() {
        return Ok(());
    }
    let groups = state.groups.lock().groups().to_vec();
    let host = app.state::<AppState>();
    let saved: Vec<_> = groups
        .iter()
        .filter_map(|group| {
            let projects: Vec<_> = group
                .members
                .iter()
                .filter_map(|label| {
                    host.project(label)
                        .ok()
                        .map(|p| p.root.clone())
                        .or_else(|| state.pending(label).and_then(|l| l.project).map(Into::into))
                })
                .collect();
            (projects.len() == group.members.len()).then(|| SavedGroup {
                projects,
                selected: group.members.iter().position(|l| l == &group.selected).unwrap_or(0),
            })
        })
        .collect();
    // A restored member may have taken its launch but not finished opening yet.
    if saved.len() != groups.len() {
        return Ok(());
    }
    let path = host.config_dir.join("window-groups.json");
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = serde_json::to_vec(&saved).map_err(|e| IdeError::internal(e.to_string()))?;
        ide_vfs::write_atomic(&path, &bytes).map(|_| ())
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

pub async fn restore(app: &AppHandle, caller: &str) -> IdeResult<()> {
    if caller != "main" {
        return Ok(());
    }
    let state = app.state::<WindowsState>();
    let host = app.state::<AppState>();
    let project = host.project(caller)?;
    if !project.settings.effective().general.reopen_last_project || state.groups_restored.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let path = host.config_dir.join("window-groups.json");
    let saved: Vec<SavedGroup> = tauri::async_runtime::spawn_blocking(move || -> IdeResult<_> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))??;
    if let Some(group) = saved.iter().find(|g| g.projects.contains(&project.root)) {
        let mut labels = Vec::new();
        let mut selected = caller.to_owned();
        for path in &group.projects {
            let label = if path == &project.root {
                Some(caller.to_owned())
            } else if path.is_dir() {
                let window = match windows::find_project_window(app, path) {
                    Some(w) => w,
                    None => windows::create_window(app, Some(path.clone()))?,
                };
                Some(window.label().to_owned())
            } else {
                None
            };
            if let Some(label) = label {
                if group.projects.get(group.selected) == Some(path) {
                    selected = label.clone();
                }
                labels.push(label);
            }
        }
        if labels.len() > 1 {
            state.groups.lock().merge(labels, caller)?;
            select(app, caller, &selected)?;
        }
    }
    Ok(())
}
