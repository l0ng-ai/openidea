//! macOS project tabs: native window tab groups behind the page's own tab bar.
use crate::windows::WorkbenchWindows;

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
    let windows = app.workbench_windows();
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

/// Adds `members` to the existing anchor's native tab group and shows `selected`.
pub fn sync_tab_group(
    members: Vec<WebviewWindow>,
    anchor: &WebviewWindow,
    selected: &WebviewWindow,
) -> tauri::Result<()> {
    let anchor = anchor.clone();
    let target = selected.clone();
    on_main(selected, move || {
        let Some(shown) = native(&target) else { return };
        let Some(anchor_window) = native(&anchor) else { return };
        // Joining into a new tab's desktop window would take the existing group out of full screen.
        for member in members.iter().filter(|m| m.label() != anchor.label()) {
            if let Some(window) = native(member)
                && !same_group(anchor_window, window)
            {
                anchor_window.addTabbedWindow_ordered(window, objc2_app_kit::NSWindowOrderingMode::Above);
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

/// Hides `windows` together in a single main-thread turn so a closing window or tab group
/// disappears at once instead of flipping through remaining tabs while webviews tear down.
/// Native fullscreen windows are left for AppKit's own Space close transition.
pub fn hide_windows(windows: Vec<WebviewWindow>) {
    if windows.is_empty() {
        return;
    }
    let first = windows[0].clone();
    let _ = on_main(&first, move || {
        for window in &windows {
            if window.is_fullscreen().unwrap_or(false) {
                continue;
            }
            if let Some(native) = native(window) {
                native.orderOut(None);
            }
        }
    });
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

type PerformKeyEquivalentFn =
    unsafe extern "C-unwind" fn(*const AnyObject, Sel, *const objc2_app_kit::NSEvent) -> objc2::runtime::Bool;

std::thread_local! {
    static WORKBENCH_WEBVIEWS: std::cell::RefCell<std::collections::HashMap<String, usize>> = Default::default();
    static PATCHED_WEBVIEW_CLASSES: std::cell::RefCell<std::collections::HashMap<usize, Option<Imp>>> = Default::default();
    static ORIGINAL_MENU_KEY_EQUIVALENT: std::cell::Cell<Option<Imp>> = const { std::cell::Cell::new(None) };
    static PERFORMING_KEY_EQUIVALENT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Restores `WKWebView` key-equivalent routing for a window's primary workbench webview.
///
/// Enabling Tauri's `unstable` multiwebview feature makes `tauri-runtime-wry` create even the
/// primary workbench webview as `is_child = true`. Wry 0.57 then skips `makeFirstResponder` and
/// returns `NO` from `WryWebView::performKeyEquivalent:`, letting `NSMenu` consume shortcuts
/// before the JS keymap ever sees them (#5954).
pub fn install_webview_keys(window: &WebviewWindow) {
    let label = window.label().to_owned();
    let _ = window.with_webview(move |webview| unsafe {
        let view = &*webview.inner().cast::<objc2_app_kit::NSView>();
        let ns_window = &*webview.ns_window().cast::<NSWindow>();
        install_for_views(&label, ns_window, view);
    });
}

pub fn forget_webview_keys(window: &tauri::Window) {
    let label = window.label().to_owned();
    let forget = move || forget_webview_label(&label);
    if MainThreadMarker::new().is_some() {
        forget();
    } else {
        let _ = window.run_on_main_thread(forget);
    }
}

fn forget_webview_label(label: &str) {
    WORKBENCH_WEBVIEWS.with_borrow_mut(|views| {
        views.remove(label);
    });
}

unsafe fn install_for_views(label: &str, ns_window: &NSWindow, view: &objc2_app_kit::NSView) {
    let view_ptr = (view as *const objc2_app_kit::NSView) as usize;
    WORKBENCH_WEBVIEWS.with_borrow_mut(|views| {
        views.insert(label.to_owned(), view_ptr);
    });

    let sel = objc2::sel!(performKeyEquivalent:);
    let view_cls =
        unsafe { objc2::ffi::object_getClass((view as *const objc2_app_kit::NSView).cast()) } as *mut AnyClass;
    if !view_cls.is_null() {
        PATCHED_WEBVIEW_CLASSES.with_borrow_mut(|patched| {
            let key = view_cls as usize;
            if let std::collections::hash_map::Entry::Vacant(entry) = patched.entry(key) {
                let types = unsafe {
                    let m = objc2::ffi::class_getInstanceMethod(objc2::class!(WKWebView), sel);
                    if m.is_null() { c"B@:@".as_ptr() } else { objc2::ffi::method_getTypeEncoding(m) }
                };
                let imp: Imp =
                    unsafe { std::mem::transmute(workbench_perform_key_equivalent as PerformKeyEquivalentFn) };
                let prev = unsafe { objc2::ffi::class_replaceMethod(view_cls, sel, imp, types) };
                entry.insert(prev);
            }
        });
    }

    ORIGINAL_MENU_KEY_EQUIVALENT.with(|slot| {
        if slot.get().is_none() {
            let menu_cls = objc2::class!(NSMenu) as *const AnyClass as *mut AnyClass;
            let types = unsafe {
                let m = objc2::ffi::class_getInstanceMethod(menu_cls, sel);
                if m.is_null() { c"B@:@".as_ptr() } else { objc2::ffi::method_getTypeEncoding(m) }
            };
            let imp: Imp = unsafe { std::mem::transmute(menu_perform_key_equivalent as PerformKeyEquivalentFn) };
            slot.set(unsafe { objc2::ffi::class_replaceMethod(menu_cls, sel, imp, types) });
        }
    });

    if owns_key_focus(ns_window, view) {
        ensure_workbench_responder(ns_window, view);
    }
}

/// True unless an attached sheet or another sibling view (such as a focused Browser guest webview)
/// owns `firstResponder`.
fn owns_key_focus(window: &NSWindow, view: &objc2_app_kit::NSView) -> bool {
    if window.attachedSheet().is_some() {
        return false;
    }
    let Some(responder) = window.firstResponder() else { return true };
    if std::ptr::eq(Retained::as_ptr(&responder).cast::<NSWindow>(), window) {
        return true;
    }
    responder
        .downcast::<objc2_app_kit::NSView>()
        .is_ok_and(|responder_view| responder_view.isDescendantOf(view) || view.isDescendantOf(&responder_view))
}

/// Keeps `view` on the responder chain when `firstResponder` fell back to the window or its
/// container view, so native responder-chain menu items (`copy:`, `paste:`, `undo:`) reach WebKit.
fn ensure_workbench_responder(window: &NSWindow, view: &objc2_app_kit::NSView) {
    let already_inside = window
        .firstResponder()
        .and_then(|r| r.downcast::<objc2_app_kit::NSView>().ok())
        .is_some_and(|r| r.isDescendantOf(view));
    if !already_inside {
        window.makeFirstResponder(Some(view));
    }
}

unsafe extern "C-unwind" fn workbench_perform_key_equivalent(
    this: *const AnyObject,
    sel: Sel,
    event: *const objc2_app_kit::NSEvent,
) -> objc2::runtime::Bool {
    let view = unsafe { &*this.cast::<objc2_app_kit::NSView>() };
    let is_workbench = WORKBENCH_WEBVIEWS.with_borrow(|views| views.values().any(|&p| p == this as usize));
    if is_workbench
        && let Some(window) = view.window()
        && owns_key_focus(&window, view)
    {
        ensure_workbench_responder(&window, view);
        return unsafe { objc2::msg_send![super(view, objc2::class!(WKWebView)), performKeyEquivalent: event] };
    }
    let cls = unsafe { objc2::ffi::object_getClass(this) } as usize;
    let prev = PATCHED_WEBVIEW_CLASSES.with_borrow(|patched| patched.get(&cls).copied().flatten());
    if let Some(prev) = prev {
        let f: PerformKeyEquivalentFn = unsafe { std::mem::transmute(prev) };
        unsafe { f(this, sel, event) }
    } else {
        objc2::runtime::Bool::NO
    }
}

/// Marks menu activations triggered through `-[NSMenu performKeyEquivalent:]` (including WebKit's
/// async callback after JS declines a shortcut, when `NSApp.currentEvent` may have moved on).
unsafe extern "C-unwind" fn menu_perform_key_equivalent(
    this: *const AnyObject,
    sel: Sel,
    event: *const objc2_app_kit::NSEvent,
) -> objc2::runtime::Bool {
    let Some(prev) = ORIGINAL_MENU_KEY_EQUIVALENT.with(|slot| slot.get()) else {
        return objc2::runtime::Bool::NO;
    };
    let f: PerformKeyEquivalentFn = unsafe { std::mem::transmute(prev) };
    with_performing_key_equivalent(|| unsafe { f(this, sel, event) })
}

fn with_performing_key_equivalent<R>(f: impl FnOnce() -> R) -> R {
    struct Reset(bool);
    impl Drop for Reset {
        fn drop(&mut self) {
            PERFORMING_KEY_EQUIVALENT.with(|c| c.set(self.0));
        }
    }
    let _reset = Reset(PERFORMING_KEY_EQUIVALENT.with(|c| c.replace(true)));
    f()
}

/// Whether AppKit is handling a key press right now. A menu item performed at this point
/// was chosen by its key equivalent: a click, arrow keys plus Return and accessibility
/// presses all run with a non-key current event.
pub fn handling_key_press() -> bool {
    if PERFORMING_KEY_EQUIVALENT.with(|c| c.get()) {
        return true;
    }
    let Some(mtm) = MainThreadMarker::new() else { return false };
    objc2_app_kit::NSApplication::sharedApplication(mtm)
        .currentEvent()
        .is_some_and(|event| event.r#type() == objc2_app_kit::NSEventType::KeyDown)
}

/// Native dialogs block the workbench even when their menu event no longer carries a key press.
pub fn native_modal_open() -> bool {
    let Some(mtm) = MainThreadMarker::new() else { return false };
    let application = objc2_app_kit::NSApplication::sharedApplication(mtm);
    application.modalWindow().is_some() || application.windows().iter().any(|window| window.attachedSheet().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::{AnyThread, ClassType, define_class, msg_send, runtime::Bool};

    define_class!(
        #[unsafe(super(objc2::runtime::NSObject))]
        struct MockSuperWebView;

        impl MockSuperWebView {
            #[unsafe(method(performKeyEquivalent:))]
            fn perform_key_equivalent(&self, _event: *const AnyObject) -> Bool {
                Bool::YES
            }
        }
    );

    define_class!(
        #[unsafe(super(MockSuperWebView))]
        struct MockChildWebView;

        impl MockChildWebView {
            #[unsafe(method(performKeyEquivalent:))]
            fn perform_key_equivalent(&self, _event: *const AnyObject) -> Bool {
                // Mirrors WryWebView when `is_child == true` under Tauri's `unstable` feature.
                Bool::NO
            }
        }
    );

    unsafe extern "C-unwind" fn test_perform_key_equivalent(
        this: *const AnyObject,
        sel: Sel,
        event: *const objc2_app_kit::NSEvent,
    ) -> Bool {
        let is_workbench = WORKBENCH_WEBVIEWS.with_borrow(|views| views.values().any(|&p| p == this as usize));
        if is_workbench {
            let obj = unsafe { &*this };
            return unsafe { msg_send![super(obj, MockSuperWebView::class()), performKeyEquivalent: event] };
        }
        let cls = unsafe { objc2::ffi::object_getClass(this) } as usize;
        let prev = PATCHED_WEBVIEW_CLASSES.with_borrow(|patched| patched.get(&cls).copied().flatten());
        if let Some(prev) = prev {
            let f: PerformKeyEquivalentFn = unsafe { std::mem::transmute(prev) };
            unsafe { f(this, sel, event) }
        } else {
            Bool::NO
        }
    }

    #[test]
    fn patched_webview_dispatches_to_super_only_for_registered_workbench_views() {
        let workbench: Retained<MockChildWebView> = unsafe { msg_send![MockChildWebView::alloc(), init] };
        let guest: Retained<MockChildWebView> = unsafe { msg_send![MockChildWebView::alloc(), init] };
        let null_event = std::ptr::null::<AnyObject>();

        // Before patching: child webviews decline key equivalents (#5954).
        let before: Bool = unsafe { msg_send![&*workbench, performKeyEquivalent: null_event] };
        assert!(!before.as_bool());

        let cls = MockChildWebView::class() as *const AnyClass as *mut AnyClass;
        PATCHED_WEBVIEW_CLASSES.with_borrow_mut(|patched| {
            patched.entry(cls as usize).or_insert_with(|| unsafe {
                let imp: Imp = std::mem::transmute(test_perform_key_equivalent as PerformKeyEquivalentFn);
                objc2::ffi::class_replaceMethod(cls, objc2::sel!(performKeyEquivalent:), imp, c"B@:@".as_ptr())
            });
        });

        WORKBENCH_WEBVIEWS.with_borrow_mut(|views| {
            views.insert("main".into(), Retained::as_ptr(&workbench) as usize);
        });

        // Registered workbench view routes to superclass; unregistered guest view still declines.
        let wb_after: Bool = unsafe { msg_send![&*workbench, performKeyEquivalent: null_event] };
        let guest_after: Bool = unsafe { msg_send![&*guest, performKeyEquivalent: null_event] };
        assert!(wb_after.as_bool());
        assert!(!guest_after.as_bool());

        // Forgetting the window unregisters the view.
        forget_webview_label("main");
        let wb_forgotten: Bool = unsafe { msg_send![&*workbench, performKeyEquivalent: null_event] };
        assert!(!wb_forgotten.as_bool());
    }

    #[test]
    fn performing_key_equivalent_marks_handling_key_press_and_resets_on_unwind() {
        assert!(!PERFORMING_KEY_EQUIVALENT.with(|c| c.get()));
        let inside = with_performing_key_equivalent(|| {
            assert!(handling_key_press());
            with_performing_key_equivalent(handling_key_press)
        });
        assert!(inside);
        assert!(!PERFORMING_KEY_EQUIVALENT.with(|c| c.get()));

        let panicked = std::panic::catch_unwind(|| {
            with_performing_key_equivalent(|| panic!("boom"));
        });
        assert!(panicked.is_err());
        assert!(!PERFORMING_KEY_EQUIVALENT.with(|c| c.get()));
    }
}
