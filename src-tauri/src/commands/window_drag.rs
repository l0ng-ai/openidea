//! Native drags started from the web UI: the window from its title bar, files out to other apps.

use ide_command::desktop_command;
use ide_core::{IdeError, IdeResult};
use std::path::PathBuf;
use tauri::WebviewWindow;

/// Starts dragging `window` while the primary mouse button is still down; returns whether a drag began.
///
/// macOS WebKit can deliver a tap's `mousedown` after the button is already up. AppKit would then run
/// its drag loop with no release left to end it, and the window follows the pointer until the next click.
#[desktop_command(trust = always)]
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

/// Drags `paths` (local files and folders) out of `window` while the primary mouse button is
/// still down, so the app they are dropped on copies them (#2867). Resolves when the drag ends,
/// with whether a target took the files.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn window_drag_files(window: WebviewWindow, paths: Vec<PathBuf>) -> IdeResult<bool> {
    let paths = ide_drag_out::local_paths(paths)?;
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let source = window.clone();
    window
        .run_on_main_thread(move || {
            let done = move |outcome| {
                let _ = done_tx.send(outcome);
            };
            // A tap WebKit delivered late: nothing is held, so the drag would never end.
            #[cfg(target_os = "macos")]
            if objc2_app_kit::NSEvent::pressedMouseButtons() & 1 == 0 {
                let _ = started_tx.send(Ok(()));
                return;
            }
            #[cfg(target_os = "linux")]
            let started = source
                .gtk_window()
                .map_err(|error| std::io::Error::other(error.to_string()))
                .and_then(|gtk_window| ide_drag_out::start(&gtk_window, paths, done));
            #[cfg(any(windows, target_os = "macos"))]
            let started = ide_drag_out::start(&source, paths, done);
            let _ = started_tx.send(started);
        })
        .map_err(|error| IdeError::internal(format!("Cannot start a drag on the main thread: {error}")))?;
    started_rx.await.map_err(|error| IdeError::internal(error.to_string()))??;
    // Dropped without an outcome when the drag never began or its backend lost it.
    Ok(matches!(done_rx.await, Ok(ide_drag_out::Outcome::Dropped)))
}

ide_command::desktop_domain!(window_start_drag, window_drag_files);
