//! macOS project tabs: native window tab groups behind the page's own tab bar.
use crate::windows::{Launch, WindowsState};
use ide_core::{IdeError, IdeResult};
use ide_workspace::window_groups::{TabbingPreference, should_group_new_project};
use objc2::{
    MainThreadMarker,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Imp, Sel},
};
use objc2_app_kit::{NSWindow, NSWindowUserTabbingPreference};
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
    let active = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.state::<WindowsState>().last_focused().and_then(|label| windows.get(&label).cloned()));
    let active = active.and_then(|w| {
        let label = crate::windows::auxiliary_parent(w.label()).unwrap_or(w.label());
        windows.get(label).cloned()
    });
    let active = active.filter(|w| {
        let host = app.state::<crate::state::AppState>();
        host.project(w.label()).is_ok_and(|p| !p.light) || host.remote_dev.get(w.label()).is_some()
    });
    let fullscreen = active.as_ref().is_some_and(|w| w.is_fullscreen().unwrap_or(false));
    let light_edit = launch.project.is_none() && launch.remote.is_none();
    Ok(should_group_new_project(tabbing_preference(app)?, fullscreen, active.is_some(), light_edit)
        .then_some(active)
        .flatten())
}

/// Runs `f` on the main thread before returning, so it takes effect before what the caller does next.
fn on_main<R: Send + 'static>(window: &WebviewWindow, f: impl FnOnce() -> R + Send + 'static) -> tauri::Result<R> {
    if MainThreadMarker::new().is_some() {
        return Ok(f());
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window.run_on_main_thread(move || {
        let _ = tx.send(f());
    })?;
    rx.recv().map_err(|_| tauri::Error::FailedToReceiveMessage)
}

/// Project tabs are native window tabs, so a group shares one frame and enters full screen as one
/// window, with the system's window buttons on whichever tab is shown. The tab bar is the page's
/// own; AppKit's is hidden, and windows never join a tab group on their own.
pub fn prepare_window_tabbing(mtm: MainThreadMarker) {
    NSWindow::setAllowsAutomaticWindowTabbing(false, mtm);
}

fn native(window: &WebviewWindow) -> Option<&'static NSWindow> {
    let pointer = window.ns_window().ok()?;
    Some(unsafe { &*pointer.cast::<NSWindow>() })
}

fn same_group(a: &NSWindow, b: &NSWindow) -> bool {
    match (a.tabGroup(), b.tabGroup()) {
        (Some(a), Some(b)) => Retained::as_ptr(&a) == Retained::as_ptr(&b),
        _ => false,
    }
}

/// Puts `members` in one native tab group and shows `selected`.
pub fn sync_tab_group(members: Vec<WebviewWindow>, selected: &WebviewWindow) -> tauri::Result<()> {
    let target = selected.clone();
    on_main(selected, move || {
        let Some(shown) = native(&target) else { return };
        for member in members.iter().filter(|m| m.label() != target.label()) {
            if let Some(window) = native(member)
                && !same_group(shown, window)
            {
                shown.addTabbedWindow_ordered(window, objc2_app_kit::NSWindowOrderingMode::Above);
            }
        }
        if let Some(group) = shown.tabGroup() {
            group.setSelectedWindow(Some(shown));
        }
        shown.makeKeyAndOrderFront(None);
        for member in &members {
            if let Some(window) = native(member) {
                hide_tab_bar(window);
            }
        }
    })
}

/// Takes `window` out of its tab group into a window of its own; in full screen, a Space of its own.
pub fn move_tab_to_new_window(window: &WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    on_main(window, move || {
        let Some(native) = native(&target) else { return };
        if native.tabbedWindows().is_some_and(|tabs| tabs.count() > 1) {
            native.moveTabToNewWindow(None);
        }
        hide_tab_bar(native);
    })
}

fn has_tab_bar(view: &objc2_app_kit::NSView) -> bool {
    let class = view.class().name().to_string_lossy();
    class.contains("TabBar") || view.subviews().iter().any(|v| has_tab_bar(&v))
}

/// Hides AppKit's tab bar, which a window shows while its group has more than one tab. It moves to
/// whichever tab is shown and comes back when the group changes, so this runs after each change.
pub fn hide_tab_bar(window: &NSWindow) {
    for accessory in window.titlebarAccessoryViewControllers().iter() {
        if !accessory.isHidden() && has_tab_bar(&accessory.view()) {
            accessory.setHidden(true);
        }
    }
}

type ShouldTerminate = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;

/// `NSApplicationTerminateReply`.
const TERMINATE_CANCEL: usize = 0;
const TERMINATE_NOW: usize = 1;

/// The Dock's Quit, the system's app menu and a logout ask the application delegate whether it
/// may terminate; tao's delegate doesn't answer, so AppKit terminated at once, past the exit,
/// running-process and unsaved-changes prompts. Answer it: cancel, and quit like Cmd+Q does.
pub fn intercept_system_quit(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else { return };
    let application = objc2_app_kit::NSApplication::sharedApplication(mtm);
    unsafe {
        let delegate: *mut AnyObject = objc2::msg_send![&*application, delegate];
        if delegate.is_null() {
            return;
        }
        let class = objc2::ffi::object_getClass(delegate.cast()) as *mut AnyClass;
        let imp: Imp = std::mem::transmute(should_terminate as ShouldTerminate);
        let added = objc2::ffi::class_addMethod(class, objc2::sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
        if !added.as_bool() {
            tracing::warn!("could not handle applicationShouldTerminate:");
        }
    }
}

unsafe extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _selector: Sel, _sender: *mut AnyObject) -> usize {
    let Some(app) = APP.get() else { return TERMINATE_NOW };
    // Our own quit exits through the event loop; a system quit during it goes ahead.
    if app.try_state::<WindowsState>().is_none_or(|w| w.quitting()) {
        return TERMINATE_NOW;
    }
    crate::dispatch_menu_action(app, "app.quit");
    TERMINATE_CANCEL
}

static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
