//! No-op stand-ins for desktop-only `WebviewWindow` calls (Android has one fixed full-screen window).

use tauri::{Runtime, WebviewWindow};

pub trait WindowCompat {
    fn set_fullscreen(&self, fullscreen: bool) -> tauri::Result<()>;
    fn maximize(&self) -> tauri::Result<()>;
    fn unmaximize(&self) -> tauri::Result<()>;
    fn unminimize(&self) -> tauri::Result<()>;
    fn request_user_attention(&self, request_type: Option<tauri::UserAttentionType>) -> tauri::Result<()>;
    fn start_dragging(&self) -> tauri::Result<()>;
}

impl<R: Runtime> WindowCompat for WebviewWindow<R> {
    fn set_fullscreen(&self, _: bool) -> tauri::Result<()> {
        Ok(())
    }
    fn maximize(&self) -> tauri::Result<()> {
        Ok(())
    }
    fn unmaximize(&self) -> tauri::Result<()> {
        Ok(())
    }
    fn unminimize(&self) -> tauri::Result<()> {
        Ok(())
    }
    fn request_user_attention(&self, _: Option<tauri::UserAttentionType>) -> tauri::Result<()> {
        Ok(())
    }
    fn start_dragging(&self) -> tauri::Result<()> {
        Ok(())
    }
}
