//! IPC for OS notification centre toasts.

use ide_core::IdeResult;
use tauri::{AppHandle, Window};

/// When a balloon is shown and OpenIDEA is unfocused, mirror it to the OS.
#[tauri::command]
#[specta::specta]
pub fn show_system_notification(app: AppHandle, window: Window, title: String, body: String) -> IdeResult<()> {
    crate::system_notifications::show(&app, window.label(), title, body);
    Ok(())
}
