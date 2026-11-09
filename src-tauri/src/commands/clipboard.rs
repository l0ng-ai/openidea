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

/// The clipboard's image as a PNG data URL, for a paste whose event carried no
/// files: WebKitGTK leaves `clipboardData` empty for a raw image (a screenshot).
/// None when the clipboard holds no image, and always on other platforms.
#[tauri::command]
#[specta::specta]
pub async fn clipboard_image(app: AppHandle) -> IdeResult<Option<String>> {
    #[cfg(target_os = "linux")]
    {
        use base64::Engine;
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let sender = std::cell::Cell::new(Some(tx));
            gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_image(move |_, pixbuf| {
                let png = pixbuf.and_then(|image| image.save_to_bufferv("png", &[]).ok());
                if let Some(sender) = sender.take() {
                    let _ = sender.send(png);
                }
            });
        })
        .map_err(|error| {
            ide_core::IdeError::internal(format!("Cannot dispatch clipboard access to the main thread: {error}"))
        })?;
        let png = rx.await.ok().flatten();
        Ok(png
            .map(|bytes| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(None)
    }
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
