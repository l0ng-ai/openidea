//! macOS window tab preferences, applied to application-drawn project tabs.
use crate::windows::{Launch, WindowsState};
use ide_core::{IdeError, IdeResult};
use ide_workspace::window_groups::{TabbingPreference, should_group_new_project};
use objc2::{MainThreadMarker, rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{NSWindow, NSWindowUserTabbingPreference};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol};
use tauri::{AppHandle, Manager, WebviewWindow};

fn tabbing_preference(app: &AppHandle) -> IdeResult<TabbingPreference> {
    fn read(mtm: MainThreadMarker) -> TabbingPreference {
        match NSWindow::userTabbingPreference(mtm) {
            NSWindowUserTabbingPreference::Always => TabbingPreference::Always,
            NSWindowUserTabbingPreference::InFullScreen => TabbingPreference::InFullScreen,
            _ => TabbingPreference::Manually,
        }
    }
    if let Some(mtm) = MainThreadMarker::new() {
        return Ok(read(mtm));
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(read(MainThreadMarker::new().expect("AppKit main thread")));
    })
    .map_err(|e| IdeError::internal(e.to_string()))?;
    rx.recv().map_err(|e| IdeError::internal(e.to_string()))
}

/// Capture before building the new window, which takes focus itself.
pub fn new_project_tab_target(app: &AppHandle, launch: &Launch) -> IdeResult<Option<WebviewWindow>> {
    let windows = app.webview_windows();
    let active = project_anchor(app, &windows);
    let fullscreen = active.as_ref().is_some_and(|w| w.is_fullscreen().unwrap_or(false));
    let light_edit = launch.project.is_none() && launch.remote.is_none();
    Ok(should_group_new_project(tabbing_preference(app)?, fullscreen, active.is_some(), light_edit)
        .then_some(active)
        .flatten())
}

/// The project window a new project joins: the focused one, else the last focused
/// one, else the newest one. The open dialog can hold the focus, and the Welcome
/// window is not a project window, but any open project can still host the tab.
fn project_anchor(
    app: &AppHandle,
    windows: &std::collections::HashMap<String, WebviewWindow>,
) -> Option<WebviewWindow> {
    let host = app.state::<crate::state::AppState>();
    let state = app.state::<WindowsState>();
    let candidate = |label: &str| -> Option<WebviewWindow> {
        // A settings window counts as its parent project window.
        let label = crate::windows::settings_parent(label).unwrap_or(label);
        windows
            .get(label)
            .filter(|w| host.project(w.label()).is_ok_and(|p| !p.light) || host.remote_dev.get(w.label()).is_some())
            .cloned()
    };
    let focused = windows.values().find(|w| w.is_focused().unwrap_or(false)).map(|w| w.label().to_owned());
    let newest_first = {
        let mut labels = crate::windows::sorted_labels(
            windows.keys().filter(|l| !crate::windows::is_settings_window(l.as_str())).map(String::as_str),
        );
        labels.reverse();
        labels
    };
    ide_workspace::window_groups::anchor_label(
        focused.as_deref(),
        state.last_focused().as_deref(),
        &newest_first,
        |label| candidate(label).is_some(),
    )
    .and_then(|label| candidate(&label))
}

struct FullscreenObserver(Retained<ProtocolObject<dyn NSObjectProtocol>>);

impl Drop for FullscreenObserver {
    fn drop(&mut self) {
        let observer: &ProtocolObject<dyn NSObjectProtocol> = &self.0;
        unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
    }
}

thread_local! {
    static FULLSCREEN_TRANSFERS: std::cell::RefCell<std::collections::HashMap<String, FullscreenObserver>> = std::cell::RefCell::default();
}

pub fn forget_fullscreen(label: &str) {
    FULLSCREEN_TRANSFERS.with_borrow_mut(|observers| observers.remove(label));
}

/// Whether one of `members`' fullscreen transfers is in flight.
pub fn is_transferring(state: &WindowsState, members: &[String]) -> bool {
    let transfers = state.fullscreen_transfers.lock();
    members.iter().any(|m| transfers.contains(m))
}

/// Drops a pending transfer, e.g. the window merged into a group, detached from one, or destroyed.
pub fn forget_transfer(state: &WindowsState, label: &str) {
    state.fullscreen_transfers.lock().remove(label);
}

/// AppKit cannot enter another window's fullscreen Space until the old one has exited.
/// Marks the transfer in flight: selects defer their visual part to [`finish_transfer`].
pub fn transfer_fullscreen(from: &WebviewWindow) -> tauri::Result<()> {
    let source = from.label().to_owned();
    let app = from.app_handle();
    app.state::<WindowsState>().fullscreen_transfers.lock().insert(source.clone());
    let block_app = app.clone();
    let pending = source.clone();
    let result = from.with_webview(move |webview| unsafe {
        let native = &*webview.ns_window().cast::<NSWindow>();
        forget_fullscreen(&source);
        let label = source.clone();
        let block = block2::RcBlock::new(move |_| {
            forget_fullscreen(&label);
            finish_transfer(&block_app, &label);
        });
        let observer = NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSWindowDidExitFullScreenNotification),
            Some(native),
            None,
            &block,
        );
        FULLSCREEN_TRANSFERS.with_borrow_mut(|observers| observers.insert(source, FullscreenObserver(observer)));
        native.toggleFullScreen(None);
    });
    if result.is_err() {
        app.state::<WindowsState>().fullscreen_transfers.lock().remove(&pending);
    }
    // Safety net: if the exit notification never arrives (e.g. a cancelled
    // transition), the group must not stay deferred forever.
    let timeout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let state = timeout_app.state::<WindowsState>();
        let stuck = state.fullscreen_transfers.lock().remove(&pending);
        if stuck {
            let selected = state.groups.lock().group(&pending).map(|g| g.selected.clone());
            if let Some(selected) = selected {
                let _ = crate::window_groups::select(&timeout_app, &selected, &selected);
            }
        }
    });
    result
}

/// The old window finished exiting fullscreen: present its group's current tab, in fullscreen.
/// A cleared flag means the transfer was superseded (merged, detached or destroyed).
fn finish_transfer(app: &AppHandle, source: &str) {
    let state = app.state::<WindowsState>();
    if !state.fullscreen_transfers.lock().remove(source) {
        return;
    }
    let selected = state.groups.lock().group(source).map(|g| g.selected.clone());
    let Some(selected) = selected else { return };
    // Exiting fullscreen can show the old window again; reapply group visibility.
    let _ = crate::window_groups::select(app, &selected, &selected);
    if let Some(window) = app.get_webview_window(&selected) {
        let _ = window.set_fullscreen(true);
    }
}
