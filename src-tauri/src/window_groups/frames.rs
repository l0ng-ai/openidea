//! Window groups without native tabs: one member is shown at a time, and the hidden ones are kept
//! at its frame so that selecting a tab only changes which window is visible.
use super::Group;
use crate::windows::WindowsState;
use ide_core::{IdeError, IdeResult};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

/// Wait for the selection's asynchronous `hide` calls to take effect before moving the peers.
const FRAME_SETTLE_AFTER_SELECT: Duration = Duration::from_millis(50);
/// Wait for a drag/resize to stop before copying its frame to the hidden peers.
const FRAME_SETTLE_AFTER_MOVE: Duration = Duration::from_millis(100);
/// Coalesces the move/resize events a drag emits.
static FRAME_SYNC_GENERATION: AtomicU64 = AtomicU64::new(0);

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

/// Gives `to` the source window's outer frame before `to` is shown.
fn copy_frame(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    let host = frame_host(from)?;
    if host == FrameHost::Wayland {
        return Ok(());
    }
    match frame_write(host, outer_frame(from)?, outer_frame(to)?) {
        FrameWrite::Leave => Ok(()),
        FrameWrite::TransferFullscreen => transfer_native_fullscreen(from, to),
        FrameWrite::Assign(_) => assign_outer_frame(from, to),
    }
}

fn transfer_native_fullscreen(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    let err = |error: tauri::Error| IdeError::internal(error.to_string());
    to.set_fullscreen(false).map_err(err)?;
    place_on_monitor(from, to)?;
    from.set_fullscreen(false).map_err(err)?;
    to.set_fullscreen(true).map_err(err)?;
    Ok(())
}

fn assign_outer_frame(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
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

/// Shows `to` in place of `from`, at `from`'s frame.
fn show_at_frame(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    let err = |error: tauri::Error| IdeError::internal(error.to_string());
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
    if from.is_fullscreen().unwrap_or(false) || from.is_minimized().unwrap_or(false) {
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
pub(super) fn frame_changed(app: &AppHandle, label: &str) {
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

/// Shows `to` in place of the group's previously selected member and hides the others.
pub(super) fn present(app: &AppHandle, previous: &Group, target: &str, to: &WebviewWindow) -> IdeResult<()> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    if previous.selected != target
        && let Some(from) = app.get_webview_window(&previous.selected)
    {
        show_at_frame(&from, to)?;
    } else {
        to.unminimize().map_err(err)?;
        to.show().map_err(err)?;
        to.set_focus().map_err(err)?;
    }
    for member in &previous.members {
        if member != target
            && let Some(window) = app.get_webview_window(member)
        {
            window.hide().map_err(err)?;
        }
    }
    Ok(())
}

/// Shows the previously selected member again after a failed selection.
pub(super) fn restore_selection(app: &AppHandle, previous: &Group) {
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

/// Aligns the members that are now hidden while they stay invisible, so the next selection does
/// not move or resize a window on screen. Hiding is asynchronous; wait for it before moving a
/// peer that is still on screen.
pub(super) fn selected(app: &AppHandle, target: &str) {
    let app = app.clone();
    let target = target.to_owned();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FRAME_SETTLE_AFTER_SELECT).await;
        if !app.state::<WindowsState>().quitting() {
            sync_member_frames(&app, &target);
        }
    });
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
