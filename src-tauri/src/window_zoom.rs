//! Double-click zoom: fill the current monitor's work area the way AppKit's `zoom:` cannot.
//!
//! `[NSWindow zoom:]` runs one animated resize, and WebKit hides the page for the duration of an
//! animated resize: the frame grows over an empty window and the content appears only at the end.
//! Setting the frame in one ordinary (non-animated) resize lets the webview lay the page out at
//! once, at its final size.
//!
//! The frame to go back to outlives the process in `window-zoom.json`, next to the window-state
//! plugin's file. That plugin only ever saves the frame the window has now, so a window left zoomed
//! when the app quits would come back filling the work area with nothing left to restore to.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use ide_core::{IdeError, IdeResult};
use tauri::{Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Frames this close count as one frame: a window filling the work area and the work area itself,
/// or a restored frame and the frame it was saved from, differ by the odd pixel.
const SLACK: i64 = 2;

/// A frame as (x, y, width, height) in physical pixels.
type Frame = (i32, i32, u32, u32);

/// Frames of windows zoomed by [`toggle`], keyed by window kind, so the next toggle goes back to
/// them. A destroyed window drops its entry, so a re-opened window never restores a stale frame.
static ZOOMED: LazyLock<Mutex<HashMap<String, Frame>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn zoomed() -> std::sync::MutexGuard<'static, HashMap<String, Frame>> {
    ZOOMED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn err(e: tauri::Error) -> IdeError {
    IdeError::internal(e.to_string())
}

/// Drops the remembered frame of a window that is going away.
pub fn forget(label: &str) {
    let key = crate::windows::state_key(label).to_owned();
    zoomed().remove(&key);
}

/// What a double click does from the frame the window has now.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    /// Fill the work area, remembering the current frame.
    Zoom,
    /// Go back to the frame remembered before the last zoom.
    Restore(Frame),
    /// Already filling the work area with nothing remembered: there is nowhere to go.
    Nothing,
}

fn decide(current: Frame, work: Frame, remembered: Option<Frame>) -> Step {
    if !same(current, work) {
        return Step::Zoom;
    }
    match remembered.filter(|frame| !same(*frame, current)) {
        Some(frame) => Step::Restore(frame),
        None => Step::Nothing,
    }
}

/// Whether two frames are the same frame, up to [`SLACK`] pixels on each edge.
fn same(a: Frame, b: Frame) -> bool {
    [a.0 - b.0, a.1 - b.1, a.2 as i32 - b.2 as i32, a.3 as i32 - b.3 as i32]
        .into_iter()
        .all(|d| i64::from(d).abs() <= SLACK)
}

/// Moves and resizes the window to `frame` in one step, without an animation.
fn set_frame(window: &WebviewWindow, frame: Frame) -> IdeResult<()> {
    window.set_position(PhysicalPosition::new(frame.0, frame.1)).map_err(err)?;
    window.set_size(PhysicalSize::new(frame.2, frame.3)).map_err(err)
}

/// Reads the frame a screenshot of the window would show: outer position and inner size.
fn frame_of(window: &WebviewWindow) -> IdeResult<Frame> {
    let position = window.outer_position().map_err(err)?;
    let size = window.inner_size().map_err(err)?;
    Ok((position.x, position.y, size.width, size.height))
}

/// The frame that fills the monitor's work area. The work area is a frame while sizes here are
/// client areas, so the window's decorations are kept out of it.
fn work_area_of(window: &WebviewWindow, monitor: &Monitor) -> IdeResult<Frame> {
    let area = *monitor.work_area();
    let outer = window.outer_size().map_err(err)?;
    let inner = window.inner_size().map_err(err)?;
    Ok((
        area.position.x,
        area.position.y,
        area.size.width.saturating_sub(outer.width.saturating_sub(inner.width)).max(1),
        area.size.height.saturating_sub(outer.height.saturating_sub(inner.height)).max(1),
    ))
}

fn frames_path(window: &WebviewWindow) -> Option<PathBuf> {
    window.app_handle().path().app_data_dir().ok().map(|dir| dir.join("window-zoom.json"))
}

fn load_frames(path: &Path) -> HashMap<String, Frame> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, Frame>>(&bytes).ok())
        .unwrap_or_default()
}

/// Writes the frame down for the next run. Merging what is on disk keeps the other windows' frames.
fn remember(window: &WebviewWindow, key: &str, frame: Frame) {
    let Some(path) = frames_path(window) else {
        return;
    };
    let mut frames = load_frames(&path);
    frames.insert(key.to_owned(), frame);
    // Reading is a few hundred bytes; the write goes off the main thread.
    std::mem::drop(tauri::async_runtime::spawn_blocking(move || {
        if let Ok(bytes) = serde_json::to_vec(&frames) {
            let _ = ide_vfs::write_atomic(&path, &bytes);
        }
    }));
}

fn saved_frames(window: &WebviewWindow) -> Option<HashMap<String, Frame>> {
    frames_path(window).map(|path| load_frames(&path))
}

/// Fills the work area of the window's monitor, or goes back to the frame it had before. Returns
/// whether the window is filling its work area now.
pub fn toggle(window: &WebviewWindow) -> IdeResult<bool> {
    if window.is_fullscreen().map_err(err)? {
        return Ok(false);
    }
    let label = window.label().to_owned();
    let key = crate::windows::state_key(window.label()).to_owned();
    let current = frame_of(window)?;
    let Some(monitor) = window.current_monitor().map_err(err)?.or(window.primary_monitor().map_err(err)?) else {
        return Ok(false);
    };
    let work = work_area_of(window, &monitor)?;
    // Filling the work area also makes AppKit consider the window zoomed, so the frame we
    // remembered decides before AppKit's own idea of the window's state does.
    let remembered = if same(current, work) {
        zoomed().get(&key).copied().or_else(|| saved_frames(window).and_then(|frames| frames.get(&key).copied()))
    } else {
        None
    };
    let step = decide(current, work, remembered);
    tracing::debug!(label = %label, ?current, ?work, ?remembered, ?step, "window zoom");
    match step {
        Step::Zoom => {
            zoomed().insert(key.clone(), current);
            remember(window, &key, current);
            set_frame(window, work)?;
            Ok(true)
        }
        Step::Restore(frame) => {
            zoomed().remove(&key);
            set_frame(window, frame)?;
            Ok(false)
        }
        // A window the window-state plugin restored maximized fills the work area with no frame
        // of ours to go back to; AppKit remembers the one it zoomed from.
        Step::Nothing => {
            if window.is_maximized().map_err(err)? {
                window.unmaximize().map_err(err)?;
            }
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Frame = (0, 60, 4608, 2346);

    #[test]
    fn a_window_smaller_than_the_work_area_zooms_into_it() {
        assert_eq!(decide((200, 200, 1600, 1000), WORK, None), Step::Zoom);
    }

    #[test]
    fn a_window_filling_the_work_area_goes_back_to_the_remembered_frame() {
        assert_eq!(decide(WORK, WORK, Some((200, 200, 1600, 1000))), Step::Restore((200, 200, 1600, 1000)));
    }

    #[test]
    fn a_window_filling_the_work_area_with_nothing_remembered_stays_put() {
        // What a window restored maximized by the window-state plugin looks like: AppKit handles it.
        assert_eq!(decide(WORK, WORK, None), Step::Nothing);
        // A frame remembered from a window of the same size leaves nowhere to go too.
        assert_eq!(decide(WORK, WORK, Some(WORK)), Step::Nothing);
    }

    #[test]
    fn frames_within_the_slack_are_the_same_frame() {
        assert!(same((0, 60, 4608, 2346), (2, 58, 4610, 2344)));
        assert!(!same((0, 60, 4608, 2346), (0, 60, 4600, 2346)));
        assert!(!same((0, 60, 4608, 2346), (0, 90, 4608, 2346)));
    }

    #[test]
    fn saved_frames_load_back_what_was_written() {
        let path = std::env::temp_dir().join(format!("window-zoom-{}.json", std::process::id()));
        let mut frames = HashMap::new();
        frames.insert("main".to_owned(), (1, 2, 3, 4));
        frames.insert("settings".to_owned(), (5, 6, 7, 8));
        std::fs::write(&path, serde_json::to_vec(&frames).unwrap()).unwrap();
        let loaded = load_frames(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(loaded, frames);
    }
}
