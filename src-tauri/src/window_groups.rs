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
        #[cfg(target_os = "macos")]
        crate::macos::transfer_fullscreen(from, to).map_err(err)?;
        #[cfg(not(target_os = "macos"))]
        {
            from.set_fullscreen(false).map_err(err)?;
            to.set_fullscreen(true).map_err(err)?;
        }
        return Ok(());
    }
    to.set_fullscreen(false).map_err(err)?;
    let maximized = from.is_maximized().map_err(err)?;
    if !maximized {
        to.unmaximize().map_err(err)?;
        to.set_position(from.outer_position().map_err(err)?).map_err(err)?;
        // `set_size` excludes GTK's CSD shadow, which tao's inner size includes on Wayland.
        #[cfg(target_os = "linux")]
        let size = crate::linux_window_state::content_size(&from.as_ref().window()).map_err(err)?;
        #[cfg(not(target_os = "linux"))]
        let size = from.inner_size().map_err(err)?;
        #[cfg(target_os = "linux")]
        crate::linux_window_state::normal_size_requested(to.app_handle(), to.label(), size);
        to.set_size(size).map_err(err)?;
    } else {
        to.maximize().map_err(err)?;
    }
    Ok(())
}

fn simple_fullscreen(label: &str) -> bool {
    #[cfg(target_os = "macos")]
    return crate::macos::is_simple_fullscreen(label);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = label;
        false
    }
}

#[cfg(target_os = "macos")]
fn set_simple_fullscreen(window: &WebviewWindow, on: bool) -> IdeResult<()> {
    crate::macos::set_simple_fullscreen(window, on).map_err(|e| IdeError::internal(e.to_string()))
}

/// Fullscreen for `window`. On macOS a grouped window uses simple fullscreen, for every member
/// at once: the group stays in one Space and each member keeps the screen's size, so switching
/// projects is only showing one window and hiding the others.
pub fn toggle_fullscreen(window: &WebviewWindow) -> IdeResult<bool> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    #[cfg(target_os = "macos")]
    {
        let simple = simple_fullscreen(window.label());
        let app = window.app_handle();
        let members = app.state::<WindowsState>().groups.lock().group(window.label()).map(|g| g.members.clone());
        if simple || (members.is_some() && !window.is_fullscreen().map_err(err)?) {
            set_simple_fullscreen(window, !simple)?;
            for member in members.iter().flatten().filter(|m| *m != window.label()) {
                if let Some(other) = app.get_webview_window(member)
                    && simple_fullscreen(member) == simple
                {
                    set_simple_fullscreen(&other, !simple)?;
                }
            }
            return Ok(!simple);
        }
    }
    let on = !window.is_fullscreen().map_err(err)?;
    window.set_fullscreen(on).map_err(err)?;
    Ok(on)
}

pub fn select(app: &AppHandle, caller: &str, target: &str) -> IdeResult<()> {
    let to = app.get_webview_window(target).ok_or_else(|| IdeError::not_found("Window closed"))?;
    let state = app.state::<WindowsState>();
    let previous = state.groups.lock().select(caller, target)?;
    // In a fullscreen group the target already covers the screen, or does so before it is shown.
    let simple = previous.selected != target && simple_fullscreen(&previous.selected);
    let result = (|| {
        #[cfg(target_os = "macos")]
        if simple && !simple_fullscreen(target) {
            set_simple_fullscreen(&to, true)?;
        }
        if !simple
            && previous.selected != target
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
            #[cfg(target_os = "macos")]
            if label != caller && simple_fullscreen(label) {
                set_simple_fullscreen(&window, false)?;
            }
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
        // The tab that stays keeps the fullscreen; the detached window opens beside it.
        #[cfg(target_os = "macos")]
        let simple = simple_fullscreen(caller);
        if let Some(window) = app.get_webview_window(&next) {
            #[cfg(target_os = "macos")]
            if simple && !simple_fullscreen(&next) {
                set_simple_fullscreen(&window, true)?;
            }
            window.show().map_err(|e| IdeError::internal(e.to_string()))?;
        }
        if let Some(window) = app.get_webview_window(caller) {
            #[cfg(target_os = "macos")]
            if simple {
                set_simple_fullscreen(&window, false)?;
            }
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
    #[cfg(target_os = "macos")]
    let simple = crate::macos::forget_simple_fullscreen(app, caller);
    let next = state.groups.lock().detach(caller);
    if !state.quitting() {
        if let Some(window) = next.and_then(|label| app.get_webview_window(&label)) {
            #[cfg(target_os = "macos")]
            if simple && !simple_fullscreen(window.label()) {
                let _ = set_simple_fullscreen(&window, true);
            }
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
                    None => windows::create_restored_window(app, path.clone())?,
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
