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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

/// Wait for the selection's asynchronous `hide` calls to take effect before moving the peers.
const FRAME_SETTLE_AFTER_SELECT: Duration = Duration::from_millis(50);
/// Wait for a drag/resize to stop before copying its frame to the hidden peers.
const FRAME_SETTLE_AFTER_MOVE: Duration = Duration::from_millis(100);
/// Coalesces the move/resize events a drag emits.
static FRAME_SYNC_GENERATION: AtomicU64 = AtomicU64::new(0);

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

/// Whether `to` already presents `from`'s frame, so moving it would only make it flicker.
fn same_frame(from: &WebviewWindow, to: &WebviewWindow) -> bool {
    let (Ok(from_max), Ok(to_max)) = (from.is_maximized(), to.is_maximized()) else { return false };
    let (Ok(from_full), Ok(to_full)) = (from.is_fullscreen(), to.is_fullscreen()) else { return false };
    if from_max != to_max || from_full != to_full {
        return false;
    }
    let same_monitor = match (from.current_monitor(), to.current_monitor()) {
        (Ok(Some(a)), Ok(Some(b))) => a.position() == b.position() && a.size() == b.size(),
        // An unmapped window may not report a monitor; treat only equal states as matching.
        (Ok(None), Ok(None)) | (Err(_), Err(_)) => true,
        _ => false,
    };
    if !same_monitor {
        return false;
    }
    from_full
        || from_max
        || (from.outer_position().ok() == to.outer_position().ok() && from.inner_size().ok() == to.inner_size().ok())
}

/// Moves a hidden window onto `from`'s monitor. A restored window keeps its normal position on
/// the monitor it last occupied; maximizing or going fullscreen there would make the window
/// visibly jump across displays when its tab is selected.
fn place_on_monitor(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    // Wayland does not let clients place top-level windows; maximizing stays on that output.
    #[cfg(target_os = "linux")]
    if crate::linux_window_state::is_wayland() {
        return Ok(());
    }
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    if let Some(monitor) = from.current_monitor().map_err(err)? {
        to.set_position(*monitor.position()).map_err(err)?;
    }
    Ok(())
}

fn copy_frame(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    if same_frame(from, to) {
        return Ok(());
    }
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let fullscreen = from.is_fullscreen().map_err(err)?;
    if fullscreen {
        #[cfg(target_os = "macos")]
        crate::macos::transfer_fullscreen(from, to).map_err(err)?;
        #[cfg(not(target_os = "macos"))]
        {
            to.set_fullscreen(false).map_err(err)?;
            place_on_monitor(from, to)?;
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
        // Maximize the target on the source's monitor, not on the monitor it happened to
        // occupy while hidden.
        to.unmaximize().map_err(err)?;
        place_on_monitor(from, to)?;
        to.maximize().map_err(err)?;
    }
    Ok(())
}

/// Keeps hidden group members at the selected window's frame. Selecting a tab then only
/// changes which window is visible instead of moving or resizing one on screen.
fn sync_member_frames(app: &AppHandle, selected: &str) {
    let Some(group) = app.state::<WindowsState>().groups.lock().group(selected).cloned() else { return };
    if group.selected != selected {
        return;
    }
    let Some(from) = app.get_webview_window(selected) else { return };
    if from.is_fullscreen().unwrap_or(false)
        || from.is_minimized().unwrap_or(false)
        || anchor_of(&group.members).is_some()
    {
        return;
    }
    for member in group.members.iter().filter(|member| member.as_str() != selected) {
        let Some(to) = app.get_webview_window(member) else { continue };
        // A visible peer is the one being presented; never move it behind the user's back.
        if to.is_visible().unwrap_or(false) {
            continue;
        }
        if let Err(error) = copy_frame(&from, &to) {
            tracing::warn!("cannot align window {member} with {selected}: {}", error.message);
        }
    }
}

/// A presented group window moved or resized. Align its hidden peers after the user stops, so
/// the next tab selection is only a visibility change.
pub fn frame_changed(app: &AppHandle, label: &str) {
    let Some(group) = app.state::<WindowsState>().groups.lock().group(label).cloned() else { return };
    if group.selected != label {
        return;
    }
    let generation = FRAME_SYNC_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    let label = label.to_owned();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FRAME_SETTLE_AFTER_MOVE).await;
        if FRAME_SYNC_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        if !app.state::<WindowsState>().quitting() {
            sync_member_frames(&app, &label);
        }
    });
}

/// The member whose native fullscreen Space a group in fullscreen shares (macOS).
fn anchor_of(members: &[String]) -> Option<String> {
    #[cfg(target_os = "macos")]
    return members.iter().find(|member| crate::macos::is_anchor(member)).cloned();
    #[cfg(not(target_os = "macos"))]
    {
        let _ = members;
        None
    }
}

/// Whether `label`'s group is in fullscreen, in its anchor's Space.
#[cfg(target_os = "macos")]
pub fn in_fullscreen(app: &AppHandle, label: &str) -> bool {
    app.state::<WindowsState>().groups.lock().group(label).is_some_and(|group| anchor_of(&group.members).is_some())
}

/// Fullscreen for `window`. On macOS a grouped window puts its whole group in one native
/// fullscreen Space: the selected member enters it as the anchor and the others are shown over
/// it there (see `select`), so switching projects never leaves the Space.
pub fn toggle_fullscreen(window: &WebviewWindow) -> IdeResult<bool> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle();
        let group = app.state::<WindowsState>().groups.lock().group(window.label()).cloned();
        if let Some(group) = group {
            if let Some(anchor) = anchor_of(&group.members) {
                leave_group_fullscreen(app, &group.members, &anchor)?;
                return Ok(false);
            }
            let selected =
                app.get_webview_window(&group.selected).ok_or_else(|| IdeError::not_found("Window closed"))?;
            if !selected.is_fullscreen().map_err(err)? {
                crate::macos::set_anchor(selected.label(), true);
                crate::macos::native_toggle_fullscreen(&selected).map_err(err)?;
                return Ok(true);
            }
        }
    }
    let on = !window.is_fullscreen().map_err(err)?;
    // `set_fullscreen` sends `toggleFullScreen:`, which would bring a grouped window back here.
    #[cfg(target_os = "macos")]
    crate::macos::native_toggle_fullscreen(window).map_err(err)?;
    #[cfg(not(target_os = "macos"))]
    window.set_fullscreen(on).map_err(err)?;
    Ok(on)
}

/// The members shown in the anchor's Space leave it, back at their own frames; once the anchor
/// has left fullscreen, the selected project is presented at the group's windowed frame.
#[cfg(target_os = "macos")]
fn leave_group_fullscreen(app: &AppHandle, members: &[String], anchor: &str) -> IdeResult<()> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let anchor_window = app.get_webview_window(anchor).ok_or_else(|| IdeError::not_found("Window closed"))?;
    for member in members.iter().filter(|member| *member != anchor) {
        if let Some(window) = app.get_webview_window(member) {
            window.hide().map_err(err)?;
            crate::macos::leave_space(&window)?;
        }
    }
    leave_native_fullscreen(app, &anchor_window)
}

/// Takes `window` out of native fullscreen. That shows it again once done, so the group's
/// selected project is presented then, at the group's windowed frame.
#[cfg(target_os = "macos")]
fn leave_native_fullscreen(app: &AppHandle, window: &WebviewWindow) -> IdeResult<()> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let (app, label) = (app.clone(), window.label().to_owned());
    crate::macos::after_fullscreen_exit(window, move || {
        crate::macos::set_anchor(&label, false);
        let selected = app.state::<WindowsState>().groups.lock().group(&label).map(|g| g.selected.clone());
        if let Some(selected) = selected {
            let _ = select(&app, &selected, &selected);
        }
    })
    .map_err(err)?;
    crate::macos::native_toggle_fullscreen(window).map_err(err)
}

pub fn select(app: &AppHandle, caller: &str, target: &str) -> IdeResult<()> {
    let to = app.get_webview_window(target).ok_or_else(|| IdeError::not_found("Window closed"))?;
    let state = app.state::<WindowsState>();
    let previous = state.groups.lock().select(caller, target)?;
    #[cfg(target_os = "macos")]
    if let Some(anchor) = anchor_of(&previous.members) {
        let result = select_in_space(app, &previous.members, target, &anchor);
        if result.is_err() {
            let _ = state.groups.lock().select(caller, &previous.selected);
        }
        changed(app);
        return result;
    }
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
    } else if !state.quitting() {
        // Align the members that are now hidden while they stay invisible, so the next
        // selection does not move or resize a window on screen. Hiding is asynchronous;
        // wait for it before moving a peer that is still on screen.
        let app = app.clone();
        let target = target.to_owned();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(FRAME_SETTLE_AFTER_SELECT).await;
            if !app.state::<WindowsState>().quitting() {
                sync_member_frames(&app, &target);
            }
        });
    }
    changed(app);
    result
}

/// In a fullscreen group, `target` is shown over the anchor inside the anchor's Space. The anchor
/// is never hidden there: its Space ends with it.
#[cfg(target_os = "macos")]
fn select_in_space(app: &AppHandle, members: &[String], target: &str, anchor: &str) -> IdeResult<()> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let anchor_window = app.get_webview_window(anchor).ok_or_else(|| IdeError::not_found("Window closed"))?;
    let to = app.get_webview_window(target).ok_or_else(|| IdeError::not_found("Window closed"))?;
    // A member joins whichever Space is active when it is shown; make that the group's.
    if !crate::macos::is_on_active_space(&anchor_window) {
        anchor_window.set_focus().map_err(err)?;
    }
    if target != anchor {
        crate::macos::join_space(&to, &anchor_window)?;
        to.show().map_err(err)?;
    }
    to.set_focus().map_err(err)?;
    for member in members.iter().filter(|member| *member != target && *member != anchor) {
        if let Some(window) = app.get_webview_window(member) {
            window.hide().map_err(err)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn join(app: &AppHandle, anchor: &str, new_window: &str) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    state.groups.lock().join(anchor, new_window)?;
    // A window already in native fullscreen keeps its Space and the new project joins it.
    if !in_fullscreen(app, anchor) && app.get_webview_window(anchor).is_some_and(|w| w.is_fullscreen().unwrap_or(false))
    {
        crate::macos::set_anchor(anchor, true);
    }
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
            {
                crate::macos::leave_space(&window)?;
                crate::macos::set_anchor(label, false);
                if window.is_fullscreen().unwrap_or(false) {
                    leave_native_fullscreen(app, &window)?;
                }
            }
            #[cfg(not(target_os = "macos"))]
            window.set_fullscreen(false).map_err(|e| IdeError::internal(e.to_string()))?;
        }
    }
    app.state::<WindowsState>().groups.lock().merge(members, caller)?;
    select(app, caller, caller)
}

pub fn detach(app: &AppHandle, caller: &str) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    #[cfg(target_os = "macos")]
    let anchor = state.groups.lock().group(caller).and_then(|group| anchor_of(&group.members));
    let next = state.groups.lock().detach(caller);
    if let Some(next) = next {
        #[cfg(target_os = "macos")]
        if let Some(anchor) = anchor {
            let result = detach_from_space(app, caller, &next, &anchor);
            changed(app);
            return result;
        }
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

/// A tab moved out of a fullscreen group gets a fullscreen Space of its own, as a window moved out
/// of an AppKit tab group does; the tabs that stay keep theirs, or open a new one when the moved
/// tab owned it. A window can't be moved to the desktop's Space.
#[cfg(target_os = "macos")]
fn detach_from_space(app: &AppHandle, caller: &str, next: &str, anchor: &str) -> IdeResult<()> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let members = app.state::<WindowsState>().groups.lock().group(next).map(|g| g.members.clone());
    let caller_window = app.get_webview_window(caller).ok_or_else(|| IdeError::not_found("Window closed"))?;
    let next_window = app.get_webview_window(next).ok_or_else(|| IdeError::not_found("Window closed"))?;
    if caller == anchor {
        crate::macos::set_anchor(anchor, false);
        crate::macos::leave_space(&next_window)?;
        crate::macos::set_anchor(next, members.is_some());
        next_window.show().map_err(err)?;
        crate::macos::enter_fullscreen(&next_window);
        return Ok(());
    }
    crate::macos::leave_space(&caller_window)?;
    match members {
        Some(members) => select_in_space(app, &members, next, anchor)?,
        None => crate::macos::set_anchor(anchor, false),
    }
    caller_window.set_focus().map_err(err)?;
    crate::macos::enter_fullscreen(&caller_window);
    Ok(())
}

pub fn destroyed(app: &AppHandle, caller: &str) {
    let Some(state) = app.try_state::<WindowsState>() else { return };
    #[cfg(target_os = "macos")]
    let was_anchor = crate::macos::forget_group_fullscreen(app, caller);
    let next = state.groups.lock().detach(caller);
    if !state.quitting() {
        if let Some(window) = next.and_then(|label| app.get_webview_window(&label)) {
            #[cfg(target_os = "macos")]
            {
                let grouped = state.groups.lock().group(window.label()).is_some();
                if !grouped {
                    crate::macos::set_anchor(window.label(), false);
                }
                if was_anchor {
                    // The closed anchor's Space went with it; the tab that stays opens its own.
                    let _ = crate::macos::leave_space(&window);
                    crate::macos::set_anchor(window.label(), grouped);
                    let _ = window.show();
                    crate::macos::enter_fullscreen(&window);
                } else {
                    windows::focus(&window);
                }
            }
            #[cfg(not(target_os = "macos"))]
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
                    None => windows::create_restored_window(app, path.clone(), group.projects.len() > 1),
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
            #[cfg(target_os = "macos")]
            let members = labels.clone();
            state.groups.lock().merge(labels, &selected)?;
            // The first window opens with the state remembered for its label. The group reopens
            // windowed, or in fullscreen in its own Space when that window is the selected one.
            #[cfg(target_os = "macos")]
            for label in &members {
                if let Some(window) = app.get_webview_window(label)
                    && window.is_fullscreen().unwrap_or(false)
                {
                    if *label == selected {
                        crate::macos::set_anchor(label, true);
                    } else {
                        leave_native_fullscreen(app, &window)?;
                    }
                }
            }
            select(app, &selected, &selected)?;
        }
    }
    Ok(())
}
