//! Native window drag started from the web title bar.

use ide_core::{IdeError, IdeResult};
use tauri::WebviewWindow;

/// Starts dragging `window` while the primary mouse button is still down; returns whether a drag began.
///
/// macOS WebKit can deliver a tap's `mousedown` after the button is already up. AppKit would then run
/// its drag loop with no release left to end it, and the window follows the pointer until the next click.
#[tauri::command]
#[specta::specta]
pub fn window_start_drag(window: WebviewWindow) -> IdeResult<bool> {
    #[cfg(target_os = "macos")]
    if objc2_app_kit::NSEvent::pressedMouseButtons() & 1 == 0 {
        return Ok(false);
    }
    window.start_dragging().map_err(|e| IdeError::internal(e.to_string()))?;
    Ok(true)
}
