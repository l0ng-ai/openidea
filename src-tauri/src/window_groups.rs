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
/// Longest wait for a closed host's fullscreen Space to go before the next tab takes the screen.
#[cfg(target_os = "macos")]
const SPACE_TEARDOWN: Duration = Duration::from_millis(1500);
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

/// Outer frame in physical pixels. A maximized window is represented by the rectangle it
/// occupies, not by the maximized flag: that flag can match while the rectangles do not.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OuterFrame {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Where a group member can be placed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrameHost {
    /// The client can move and resize the window.
    Desktop,
    /// Wayland does not let clients place top-level windows.
    #[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
    Wayland,
    /// Native fullscreen owns a Space. A different frame is transferred, not assigned.
    NativeFullscreen,
}

/// What to write before the target window is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrameWrite {
    /// Already the same rectangle, or this host must not be placed.
    Leave,
    TransferFullscreen,
    Assign(OuterFrame),
}

/// Two windows are aligned only when their outer rectangles match. Maximized or fullscreen
/// flags are not a substitute: `show` presents the current rectangle, and a later move is visible.
fn frame_write(host: FrameHost, from: OuterFrame, to: OuterFrame) -> FrameWrite {
    match host {
        FrameHost::Wayland => FrameWrite::Leave,
        FrameHost::NativeFullscreen if from == to => FrameWrite::Leave,
        FrameHost::NativeFullscreen => FrameWrite::TransferFullscreen,
        FrameHost::Desktop if from == to => FrameWrite::Leave,
        FrameHost::Desktop => FrameWrite::Assign(from),
    }
}

fn outer_frame(window: &WebviewWindow) -> IdeResult<OuterFrame> {
    let err = |error: tauri::Error| IdeError::internal(error.to_string());
    let position = window.outer_position().map_err(err)?;
    let size = window.outer_size().map_err(err)?;
    Ok(OuterFrame { x: position.x, y: position.y, width: size.width, height: size.height })
}

fn frame_host(from: &WebviewWindow) -> IdeResult<FrameHost> {
    #[cfg(target_os = "linux")]
    if crate::linux_window_state::is_wayland() {
        return Ok(FrameHost::Wayland);
    }
    if from.is_fullscreen().map_err(|error| IdeError::internal(error.to_string()))? {
        return Ok(FrameHost::NativeFullscreen);
    }
    Ok(FrameHost::Desktop)
}

/// Moves a hidden window onto `from`'s monitor. A restored window keeps its normal position on
/// the monitor it last occupied; maximizing or going fullscreen there would make the window
/// visibly jump across displays when its tab is selected. macOS copies the AppKit frame instead.
#[cfg(not(target_os = "macos"))]
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

/// Gives `to` the source window's outer frame before `to` is shown.
///
/// Tauri's position, size and maximize calls are queued. On macOS the AppKit calls return
/// before the frame changes, while `show` orders the window front immediately, so the old
/// rectangle appears and then jumps. The frame is written synchronously instead.
fn copy_frame(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    let host = frame_host(from)?;
    if host == FrameHost::Wayland {
        return Ok(());
    }
    // Tauri's physical rectangles round through the scale factor. On macOS the AppKit frame is
    // the one `show` will present, so compare that instead of skipping a real difference.
    #[cfg(target_os = "macos")]
    if host == FrameHost::Desktop {
        return crate::macos::copy_window_frame(from, to).map_err(|error| IdeError::internal(error.to_string()));
    }
    match frame_write(host, outer_frame(from)?, outer_frame(to)?) {
        FrameWrite::Leave => Ok(()),
        FrameWrite::TransferFullscreen => transfer_native_fullscreen(from, to),
        FrameWrite::Assign(frame) => assign_outer_frame(from, to, frame),
    }
}

fn transfer_native_fullscreen(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    let err = |error: tauri::Error| IdeError::internal(error.to_string());
    // A macOS group in fullscreen shares its host's Space, so no member copies the host's frame.
    #[cfg(target_os = "macos")]
    let _ = (from, to, err);
    #[cfg(not(target_os = "macos"))]
    {
        to.set_fullscreen(false).map_err(err)?;
        place_on_monitor(from, to)?;
        from.set_fullscreen(false).map_err(err)?;
        to.set_fullscreen(true).map_err(err)?;
    }
    Ok(())
}

fn assign_outer_frame(from: &WebviewWindow, to: &WebviewWindow, _frame: OuterFrame) -> IdeResult<()> {
    #[cfg(target_os = "macos")]
    {
        crate::macos::copy_window_frame(from, to).map_err(|error| IdeError::internal(error.to_string()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let err = |error: tauri::Error| IdeError::internal(error.to_string());
        to.set_fullscreen(false).map_err(err)?;
        if from.is_maximized().map_err(err)? {
            // Maximize on the source's monitor. The rectangles differed, so the maximized flags
            // alone are not enough; a hidden peer would otherwise appear at its old size.
            to.unmaximize().map_err(err)?;
            place_on_monitor(from, to)?;
            to.maximize().map_err(err)?;
        } else {
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
        }
        Ok(())
    }
}

/// Shows `to` in place of `from`, at `from`'s frame.
fn show_at_frame(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    let err = |error: tauri::Error| IdeError::internal(error.to_string());
    // Order the target front in the same AppKit turn as the frame write. A separate `show` runs
    // after that turn and constrains the titled window, which is the jump. Native fullscreen is
    // handed over by `copy_frame` instead.
    #[cfg(target_os = "macos")]
    if !from.is_fullscreen().map_err(err)? {
        to.unminimize().map_err(err)?;
        return crate::macos::present_window_frame(from, to).map_err(err);
    }
    copy_frame(from, to)?;
    to.unminimize().map_err(err)?;
    to.show().map_err(err)?;
    to.set_focus().map_err(err)
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
        || fullscreen_host(app, &group.members).is_some()
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

/// The member of `members` in native fullscreen. On macOS the other members of its group join
/// its Space; elsewhere each member of a fullscreen group is fullscreen itself.
fn fullscreen_host(app: &AppHandle, members: &[String]) -> Option<WebviewWindow> {
    #[cfg(target_os = "macos")]
    return members.iter().filter_map(|m| app.get_webview_window(m)).find(|w| w.is_fullscreen().unwrap_or(false));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, members);
        None
    }
}

/// The fullscreen host of `label`'s group, when that is another window.
#[cfg(target_os = "macos")]
pub fn fullscreen_host_of(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    let members = app.state::<WindowsState>().groups.lock().group(label).map(|g| g.members.clone())?;
    fullscreen_host(app, &members).filter(|host| host.label() != label)
}

/// Whether `window` is shown fullscreen: itself, or as a member of a fullscreen group.
#[cfg(target_os = "macos")]
pub fn in_fullscreen(app: &AppHandle, window: &WebviewWindow) -> bool {
    if window.is_fullscreen().unwrap_or(false) {
        return true;
    }
    let members = app.state::<WindowsState>().groups.lock().group(window.label()).map(|g| g.members.clone());
    members.is_some_and(|members| fullscreen_host(app, &members).is_some())
}

/// Fullscreen for `window`. On macOS a group shares one fullscreen Space: the selected member
/// enters native fullscreen and the others join its Space as auxiliary windows over it, so
/// switching projects only shows one window and hides the others.
pub fn toggle_fullscreen(window: &WebviewWindow) -> IdeResult<bool> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle();
        let group = app.state::<WindowsState>().groups.lock().group(window.label()).cloned();
        if let Some(group) = group {
            if let Some(host) = fullscreen_host(app, &group.members) {
                // The host's watch brings the members back with it.
                crate::macos::native_toggle_fullscreen(&host).map_err(err)?;
                return Ok(false);
            }
            let host = app.get_webview_window(&group.selected).unwrap_or_else(|| window.clone());
            host_fullscreen(app, &host)?;
            return Ok(true);
        }
    }
    let on = !window.is_fullscreen().map_err(err)?;
    window.set_fullscreen(on).map_err(err)?;
    Ok(on)
}

/// Makes `host` the fullscreen window of its group, or of its own Space when ungrouped.
#[cfg(target_os = "macos")]
fn host_fullscreen(app: &AppHandle, host: &WebviewWindow) -> IdeResult<()> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let members = app.state::<WindowsState>().groups.lock().group(host.label()).map(|g| g.members.clone());
    crate::macos::set_fullscreen_auxiliary(host, None).map_err(err)?;
    for member in members.iter().flatten().filter(|m| *m != host.label()) {
        if let Some(other) = app.get_webview_window(member) {
            crate::macos::set_fullscreen_auxiliary(&other, Some(host)).map_err(err)?;
        }
    }
    if members.is_some() {
        watch_host(app, host)?;
    }
    host.show().map_err(err)?;
    crate::macos::native_toggle_fullscreen(host).map_err(err)
}

#[cfg(target_os = "macos")]
fn watch_host(app: &AppHandle, host: &WebviewWindow) -> IdeResult<()> {
    let app = app.clone();
    let label = host.label().to_owned();
    crate::macos::watch_fullscreen_host(host, move || left_fullscreen(&app, &label))
        .map_err(|e| IdeError::internal(e.to_string()))
}

/// The group's fullscreen host is back on the desktop: the members leave its Space with it at
/// its frame, and the selected one is shown.
#[cfg(target_os = "macos")]
fn left_fullscreen(app: &AppHandle, host: &str) {
    let Some(group) = app.state::<WindowsState>().groups.lock().group(host).cloned() else { return };
    let Some(host) = app.get_webview_window(host) else { return };
    for member in group.members.iter().filter(|m| *m != host.label()) {
        if let Some(window) = app.get_webview_window(member) {
            let _ = crate::macos::set_fullscreen_auxiliary(&window, None);
            let _ = copy_frame(&host, &window);
        }
    }
    let _ = select(app, &group.selected, &group.selected);
}

pub fn select(app: &AppHandle, caller: &str, target: &str) -> IdeResult<()> {
    let to = app.get_webview_window(target).ok_or_else(|| IdeError::not_found("Window closed"))?;
    let state = app.state::<WindowsState>();
    let previous = state.groups.lock().select(caller, target)?;
    // In a fullscreen group the target joins the host's Space, covering its screen.
    let host = fullscreen_host(app, &previous.members);
    let result = (|| {
        #[cfg(target_os = "macos")]
        if let Some(host) = &host {
            // Also a window that was fullscreen alone before it was grouped.
            watch_host(app, host)?;
            if host.label() != target {
                crate::macos::set_fullscreen_auxiliary(&to, Some(host))
                    .map_err(|e| IdeError::internal(e.to_string()))?;
            }
        }
        if host.is_none()
            && previous.selected != target
            && let Some(from) = app.get_webview_window(&previous.selected)
        {
            show_at_frame(&from, &to)?;
        } else {
            to.unminimize().map_err(|e| IdeError::internal(e.to_string()))?;
            to.show().map_err(|e| IdeError::internal(e.to_string()))?;
            #[cfg(target_os = "macos")]
            if let Some(host) = host.as_ref().filter(|h| h.label() != target) {
                crate::macos::raise_over_host(&to, host).map_err(|e| IdeError::internal(e.to_string()))?;
            }
            to.set_focus().map_err(|e| IdeError::internal(e.to_string()))?;
        }
        for member in &previous.members {
            // The host stays in its Space behind the selected member; hiding it would end the Space.
            if member != target
                && host.as_ref().is_none_or(|h| h.label() != member)
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
    let state = app.state::<WindowsState>();
    #[cfg(target_os = "macos")]
    let host = {
        let members = state.groups.lock().group(caller).map(|g| g.members.clone()).unwrap_or_default();
        fullscreen_host(app, &members)
    };
    let next = state.groups.lock().detach(caller);
    #[cfg(target_os = "macos")]
    if let Some(host) = host {
        detach_fullscreen(app, caller, &host, next.as_deref())?;
        changed(app);
        return Ok(());
    }
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

/// A tab moved out of a fullscreen group stays fullscreen in a Space of its own, as a macOS
/// tab moved to a new window does; the tabs left keep theirs.
#[cfg(target_os = "macos")]
fn detach_fullscreen(app: &AppHandle, caller: &str, host: &WebviewWindow, next: Option<&str>) -> IdeResult<()> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let next = next.and_then(|label| app.get_webview_window(label));
    let grouped = |label: &str| app.state::<WindowsState>().groups.lock().group(label).is_some();
    if host.label() == caller {
        // The host keeps its Space; the tabs left need a host of their own.
        crate::macos::forget_fullscreen_host(caller);
        if let Some(next) = &next {
            host_fullscreen(app, next)?;
        }
        return Ok(());
    }
    if let Some(next) = &next {
        if grouped(next.label()) {
            select(app, next.label(), next.label())?;
        } else {
            // The group dissolved; its last window is fullscreen alone.
            crate::macos::forget_fullscreen_host(next.label());
            crate::macos::set_fullscreen_auxiliary(next, None).map_err(err)?;
        }
    }
    if let Some(window) = app.get_webview_window(caller) {
        host_fullscreen(app, &window)?;
    }
    Ok(())
}

pub fn destroyed(app: &AppHandle, caller: &str) {
    let Some(state) = app.try_state::<WindowsState>() else { return };
    #[cfg(target_os = "macos")]
    let hosted = crate::macos::forget_fullscreen_host(caller);
    let next = state.groups.lock().detach(caller);
    if !state.quitting() {
        if let Some(window) = next.and_then(|label| app.get_webview_window(&label)) {
            // The Space ended with its host; the tabs left take a new one once it is gone.
            #[cfg(target_os = "macos")]
            if hosted {
                let host_app = app.clone();
                crate::macos::after_space_change(app, SPACE_TEARDOWN, move || {
                    if let Err(error) = host_fullscreen(&host_app, &window) {
                        tracing::warn!("cannot keep window group fullscreen: {}", error.message);
                    }
                    windows::focus(&window);
                });
            } else {
                windows::focus(&window);
                if let Some(host) = fullscreen_host_of(app, window.label()) {
                    let _ = crate::macos::raise_over_host(&window, &host);
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

#[cfg(test)]
mod tests {
    use super::{FrameHost, FrameWrite, OuterFrame, frame_write};

    fn frame(x: i32, y: i32, width: u32, height: u32) -> OuterFrame {
        OuterFrame { x, y, width, height }
    }

    #[test]
    fn matching_outer_rects_are_left_alone() {
        let frame = frame(100, 80, 1200, 800);
        assert_eq!(frame_write(FrameHost::Desktop, frame, frame), FrameWrite::Leave);
    }

    #[test]
    fn a_different_outer_rect_is_assigned_before_the_window_is_shown() {
        let from = frame(100, 80, 1200, 800);
        let to = frame(40, 40, 900, 600);
        assert_eq!(frame_write(FrameHost::Desktop, from, to), FrameWrite::Assign(from));
    }

    #[test]
    fn maximized_windows_with_different_rects_still_assign() {
        let from = frame(0, 25, 1728, 1055);
        let to = frame(0, 25, 1512, 900);
        assert_eq!(frame_write(FrameHost::Desktop, from, to), FrameWrite::Assign(from));
    }

    #[test]
    fn wayland_does_not_place_a_window() {
        let from = frame(0, 0, 1200, 800);
        let to = frame(10, 10, 800, 600);
        assert_eq!(frame_write(FrameHost::Wayland, from, to), FrameWrite::Leave);
    }

    #[test]
    fn native_fullscreen_transfers_only_when_the_rects_differ() {
        let from = frame(0, 0, 1728, 1117);
        let other = frame(100, 80, 1200, 800);
        assert_eq!(frame_write(FrameHost::NativeFullscreen, from, from), FrameWrite::Leave);
        assert_eq!(frame_write(FrameHost::NativeFullscreen, from, other), FrameWrite::TransferFullscreen);
    }
}
