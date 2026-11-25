//! Web browsers: the built-in server's URLs and launching browsers.

use crate::browser_picker::{self, BrowserAction, BrowserStatus};
use ide_command::desktop_command;
use ide_core::{IdeResult, RequestId};
use ide_host::ops::blocking;
use ide_web::Browser;
use tauri::Window;

/// The browsers installed on this machine.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn web_browsers() -> IdeResult<Vec<Browser>> {
    blocking(|| Ok(ide_web::installed())).await
}

/// Whether `url` (a server on this machine) answers with an HTML document, i.e. has a page to open.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn web_serves_page(url: String) -> IdeResult<bool> {
    Ok(ide_host::ops::web::serves_page(&url).await)
}

/// Opens `url` in `browser` (an id from `web_browsers`), or the default browser.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn web_open(url: String, browser: Option<String>) -> IdeResult<()> {
    blocking(move || ide_web::open(&url, browser.as_deref())).await
}

/// Creates a private localhost browser session owned by this window and project.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn web_browser_open(window: Window, url: String, session: RequestId) -> IdeResult<()> {
    browser_picker::open(window, url, session).await
}

#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn web_browser_control(
    window: Window,
    session: RequestId,
    action: BrowserAction,
) -> IdeResult<BrowserStatus> {
    browser_picker::control(window, session, action).await
}

ide_command::desktop_domain!(web_browser_control, web_browser_open, web_browsers, web_open, web_serves_page);
