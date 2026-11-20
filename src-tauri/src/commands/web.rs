//! Web browsers: the built-in server's URLs and launching browsers.

use crate::browser_picker::{self, InspectedElement};
use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_host::ops::coverage::blocking;
use ide_web::Browser;
use std::sync::Arc;
use tauri::{State, Window};

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

/// Picks one element in an isolated guest. The owner explicitly reviews the result in its draft.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn web_inspect_element(
    window: Window,
    state: State<'_, AppState>,
    url: String,
    title: String,
    request: RequestId,
) -> IdeResult<Option<InspectedElement>> {
    let owner = window.label();
    if state.remote_dev.get(state.owner_window(owner)).is_some() {
        return Err(IdeError::unavailable("Element inspection requires a local project"));
    }
    let project = state.project(owner)?;
    project.require_trust()?;
    let cancel = state.begin_project_request(owner, request);
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(IdeError::cancelled()),
        value = browser_picker::inspect(url, title) => value,
    };
    state.end_request(request);
    if !Arc::ptr_eq(&project, &state.project(owner)?) {
        return Err(IdeError::cancelled());
    }
    project.require_trust()?;
    result
}

ide_command::desktop_domain!(web_browsers, web_inspect_element, web_open, web_serves_page);
