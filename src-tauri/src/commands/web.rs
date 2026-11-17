//! Web browsers: the built-in server's URLs and launching browsers.

use ide_command::desktop_command;
use ide_core::IdeResult;
use ide_host::ops::coverage::blocking;
use ide_web::Browser;

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

ide_command::desktop_domain!(web_browsers, web_open, web_serves_page);
