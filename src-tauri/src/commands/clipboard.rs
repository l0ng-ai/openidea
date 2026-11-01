//! The OS clipboard's file list, so the project view and Explorer exchange files.

#[cfg(not(target_os = "macos"))]
use crate::commands::doc::blocking;
#[cfg(target_os = "macos")]
use ide_core::IdeError;
use ide_core::IdeResult;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Absolute paths on the clipboard, empty when it holds no file list.
#[tauri::command]
#[specta::specta]
pub async fn clipboard_file_list(app: AppHandle) -> IdeResult<Vec<String>> {
    with_clipboard(app, || Ok(ide_clipboard::files()?.iter().map(|p| slash(p)).collect())).await
}

/// Whether the clipboard holds files: cheap, for the Paste item's enabled state.
#[tauri::command]
#[specta::specta]
pub fn clipboard_has_files() -> bool {
    // Synchronous Tauri commands run on the main thread, as macOS requires.
    ide_clipboard::has_files()
}

/// Replaces the clipboard with `paths`, so Explorer can paste them. Best-effort:
/// false when the clipboard stayed busy; the caller keeps working either way.
#[tauri::command]
#[specta::specta]
pub async fn clipboard_set_file_list(app: AppHandle, paths: Vec<PathBuf>) -> IdeResult<bool> {
    with_clipboard(app, move || Ok(ide_clipboard::set_files(&paths))).await
}

/// AppKit and WebKit share the general pasteboard, so a worker-side mutex cannot
/// protect its type cache. Await the main thread without blocking a command thread.
async fn with_clipboard<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce() -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|error| IdeError::internal(format!("Cannot dispatch clipboard access to the main thread: {error}")))?;
        rx.await.map_err(|error| IdeError::internal(format!("Clipboard main-thread task was dropped: {error}")))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        blocking(f).await
    }
}

/// Paths cross the IPC boundary `/`-separated, as every other backend path does.
fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
