//! Desktop adapter for application-drawn project tabs. Each member retains its WebView and services.
use crate::{
    state::AppState,
    windows::{self, WindowsState},
};
use ide_core::{IdeError, IdeEvent, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewWindow};

#[cfg(not(target_os = "macos"))]
mod frames;

type Group = ide_workspace::window_groups::WindowGroup;

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
                .map(|p| ide_host::ops::project::info(p).display_name)
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

/// A presented group window moved or resized. Native tabs (macOS) share one frame already.
pub fn frame_changed(app: &AppHandle, label: &str) {
    #[cfg(not(target_os = "macos"))]
    frames::frame_changed(app, label);
    #[cfg(target_os = "macos")]
    let _ = (app, label);
}

/// Fullscreen for `window`. On macOS a group is one native tab group, which AppKit takes into a
/// fullscreen Space as a whole.
pub fn toggle_fullscreen(window: &WebviewWindow) -> IdeResult<bool> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let on = !window.is_fullscreen().map_err(err)?;
    window.set_fullscreen(on).map_err(err)?;
    Ok(on)
}

pub fn select(app: &AppHandle, caller: &str, target: &str) -> IdeResult<()> {
    let to = app.get_webview_window(target).ok_or_else(|| IdeError::not_found("Window closed"))?;
    let state = app.state::<WindowsState>();
    let previous = state.groups.lock().select(caller, target)?;
    #[cfg(target_os = "macos")]
    let result = native_select(app, &previous, &to);
    #[cfg(not(target_os = "macos"))]
    let result = frames::present(app, &previous, target, &to);
    if result.is_err() {
        let _ = state.groups.lock().select(caller, &previous.selected);
        #[cfg(target_os = "macos")]
        if let Some(window) = app.get_webview_window(&previous.selected) {
            let _ = native_select(app, &previous, &window);
        }
        #[cfg(not(target_os = "macos"))]
        frames::restore_selection(app, &previous);
    } else if !state.quitting() {
        #[cfg(not(target_os = "macos"))]
        frames::selected(app, target);
    }
    changed(app);
    // A tab shown in a fullscreen group is in full screen too; its title bar asks again.
    app.state::<AppState>().sink.emit(IdeEvent::WindowFullscreenChanged);
    result
}

/// Shows `to` as the selected tab of the group's native tab group.
#[cfg(target_os = "macos")]
fn native_select(app: &AppHandle, group: &Group, to: &WebviewWindow) -> IdeResult<()> {
    let members = group.members.iter().filter_map(|m| app.get_webview_window(m)).collect();
    let anchor = app.get_webview_window(&group.selected).unwrap_or_else(|| to.clone());
    to.unminimize().map_err(|e| IdeError::internal(e.to_string()))?;
    crate::macos::sync_tab_group(members, &anchor, to).map_err(|e| IdeError::internal(e.to_string()))
}

#[cfg(target_os = "macos")]
pub fn join(app: &AppHandle, anchor: &str, new_window: &str) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    state.groups.lock().join(anchor, new_window)?;
    select(app, anchor, new_window)
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
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let state = app.state::<WindowsState>();
    let Some(next) = state.groups.lock().detach(caller) else {
        changed(app);
        return Ok(());
    };
    let window = app.get_webview_window(caller);
    // A tab moved out of a fullscreen group stays fullscreen in a Space of its own.
    #[cfg(target_os = "macos")]
    if let Some(window) = &window {
        crate::macos::move_tab_to_new_window(window).map_err(err)?;
    }
    if let Some(next) = app.get_webview_window(&next) {
        #[cfg(target_os = "macos")]
        if state.groups.lock().group(next.label()).is_some() {
            select(app, next.label(), next.label())?;
        }
        #[cfg(not(target_os = "macos"))]
        next.show().map_err(err)?;
    }
    if let Some(window) = window {
        if !window.is_fullscreen().map_err(err)?
            && let Ok(position) = window.outer_position()
        {
            let _ = window.set_position(tauri::PhysicalPosition::new(position.x + 32, position.y + 32));
        }
        windows::focus(&window);
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
    let advance = state.tab_closes.lock().as_mut().is_some_and(|batch| {
        let closing = batch.pending.front().is_some_and(|l| l == caller);
        if closing {
            batch.pending.pop_front();
        }
        closing
    });
    if advance {
        close_next(app);
    }
}

/// Tabs left to close; the first one is closing now.
pub struct TabCloses {
    keep: String,
    pending: VecDeque<String>,
}

/// Closes `labels` one at a time so each project's unsaved-changes prompt is shown in turn, then selects `keep`.
pub fn close_tabs(app: &AppHandle, caller: &str, keep: &str, labels: Vec<String>) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    let members = state
        .groups
        .lock()
        .group(caller)
        .map(|g| g.members.clone())
        .ok_or_else(|| IdeError::not_found("This window is not grouped"))?;
    if !members.iter().any(|m| m == keep) {
        return Err(IdeError::invalid("The window is not in this group"));
    }
    let pending = members.into_iter().filter(|m| m != keep && labels.contains(m)).collect();
    *state.tab_closes.lock() = Some(TabCloses { keep: keep.to_owned(), pending });
    close_next(app);
    Ok(())
}

/// The closing tab's project vetoed (its unsaved-changes prompt was cancelled): leave the rest open.
pub fn cancel_close(app: &AppHandle, caller: &str) {
    let state = app.state::<WindowsState>();
    state.close_settled(caller);
    let mut batch = state.tab_closes.lock();
    if batch.as_ref().is_some_and(|b| b.pending.front().is_some_and(|l| l == caller)) {
        *batch = None;
    }
}

fn close_next(app: &AppHandle) {
    let state = app.state::<WindowsState>();
    loop {
        let next = {
            let mut batch = state.tab_closes.lock();
            let Some(b) = batch.as_mut() else { return };
            match b.pending.front() {
                Some(label) => Ok(label.clone()),
                None => Err(batch.take().unwrap().keep),
            }
        };
        match next {
            Ok(label) => {
                if let Some(window) = app.get_webview_window(&label) {
                    windows::focus(&window);
                    if window.close().is_ok() {
                        return;
                    }
                }
                if let Some(b) = state.tab_closes.lock().as_mut() {
                    b.pending.pop_front();
                }
            }
            Err(keep) => {
                if let Some(window) = app.get_webview_window(&keep) {
                    windows::focus(&window);
                }
                return;
            }
        }
    }
}

/// Window labels in creation order: `main`, then `project-1`, `project-2`, ….
fn labels_in_order(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app.webview_windows().into_keys().collect();
    labels.sort_by_key(|l| (l != "main", l.rsplit('-').next().and_then(|n| n.parse::<u32>().ok()), l.clone()));
    labels
}

/// Saves the open project windows (groups and single windows) for "Reopen projects on startup".
/// Nothing is written while quitting, so the windows open at quit are the ones reopened.
pub async fn persist(app: &AppHandle) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    let mut previous = state.groups_persist.lock().await;
    if state.quitting() {
        return Ok(());
    }
    let host = app.state::<AppState>();
    let path = host.config_dir.join("window-groups.json");
    if previous.is_none() {
        *previous = Some(read_session(path.clone()).await);
    }
    let groups = state.groups.lock().groups().to_vec();
    let windows = labels_in_order(app);
    let project_of = |label: &str| match host.project(label) {
        Ok(p) => (!p.light).then(|| p.root.clone()),
        // A restored window may have taken its launch but not finished opening yet.
        Err(_) => state.pending(label).and_then(|l| l.project).map(Into::into),
    };
    let Some(saved) = ide_workspace::window_groups::session(&groups, &windows, project_of) else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = serde_json::to_vec(&saved).map_err(|e| IdeError::internal(e.to_string()))?;
        ide_vfs::write_atomic(&path, &bytes).map(|_| ())
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// The saved session; empty when there is none or it can't be read.
async fn read_session(path: PathBuf) -> Vec<ide_workspace::window_groups::SavedWindows> {
    let read = tauri::async_runtime::spawn_blocking(move || match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    read.unwrap_or_else(|e| {
        tracing::warn!("cannot read the saved windows: {e}");
        Vec::new()
    })
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
    let saved = {
        let mut previous = state.groups_persist.lock().await;
        if previous.is_none() {
            *previous = Some(read_session(host.config_dir.join("window-groups.json")).await);
        }
        previous.clone().unwrap_or_default()
    };
    // The caller's own group first (it already shows one of its projects), then every other
    // group and single window that was open at quit. Missing folders are skipped.
    let order = saved
        .iter()
        .filter(|g| g.projects.contains(&project.root))
        .chain(saved.iter().filter(|g| !g.projects.contains(&project.root)));
    for group in order {
        let mut labels = Vec::new();
        let mut selected = None;
        for path in &group.projects {
            let label = if path == &project.root {
                Some(caller.to_owned())
            } else if path.is_dir() {
                let window = match windows::find_project_window(app, path) {
                    Some(w) => Ok(w),
                    None => windows::create_restored_window(app, path.clone()),
                };
                match window {
                    Ok(w) => Some(w.label().to_owned()),
                    Err(e) => {
                        tracing::warn!("cannot reopen {}: {e}", path.display());
                        None
                    }
                }
            } else {
                None
            };
            if let Some(label) = label {
                if group.projects.get(group.selected) == Some(path) {
                    selected = Some(label.clone());
                }
                labels.push(label);
            }
        }
        if labels.len() > 1 {
            let selected = selected.unwrap_or_else(|| labels[0].clone());
            state.groups.lock().merge(labels, &selected)?;
            select(app, &selected, &selected)?;
        }
    }
    Ok(())
}
