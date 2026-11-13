//! Web browsers: the built-in server's URLs and launching browsers.

use super::coverage::blocking;
use crate::state::AppState;
use ide_core::{IdeResult, IpcPath};
use ide_web::Browser;
use tauri::{State, Window};

/// The browsers installed on this machine.
#[tauri::command]
#[specta::specta]
pub async fn web_browsers() -> IdeResult<Vec<Browser>> {
    blocking(|| Ok(ide_web::installed())).await
}

/// The built-in server's URL for `path` (started on first use).
#[tauri::command]
#[specta::specta]
pub async fn web_url(window: Window, state: State<'_, AppState>, path: IpcPath) -> IdeResult<String> {
    ide_host::ops::web::url(&state.host, window.label(), &path).await
}

/// Opens `url` in `browser` (an id from `web_browsers`), or the default browser.
#[tauri::command]
#[specta::specta]
pub async fn web_open(url: String, browser: Option<String>) -> IdeResult<()> {
    blocking(move || ide_web::open(&url, browser.as_deref())).await
}
