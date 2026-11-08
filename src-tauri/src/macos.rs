//! macOS window tab preferences, applied to application-drawn project tabs.
use crate::windows::{Launch, WindowsState};
use ide_core::{IdeError, IdeResult};
use ide_workspace::window_groups::{TabbingPreference, should_group_new_project};
use objc2::{
    MainThreadMarker,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Imp, ProtocolObject, Sel},
};
use objc2_app_kit::{NSWindow, NSWindowAnimationBehavior, NSWindowUserTabbingPreference};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol, NSRect};
use std::cell::Cell;
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
    // A group member other than its fullscreen host is not itself in native fullscreen.
    let fullscreen = active.as_ref().is_some_and(|w| crate::window_groups::in_fullscreen(app, w));
    let light_edit = launch.project.is_none() && launch.remote.is_none();
    Ok(should_group_new_project(tabbing_preference(app)?, fullscreen, active.is_some(), light_edit)
        .then_some(active)
        .flatten())
}

struct FullscreenObserver(Retained<ProtocolObject<dyn NSObjectProtocol>>);

impl Drop for FullscreenObserver {
    fn drop(&mut self) {
        let observer: &ProtocolObject<dyn NSObjectProtocol> = &self.0;
        unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
    }
}

thread_local! {
    /// Fullscreen hosts of window groups, watched for leaving fullscreen.
    static FULLSCREEN_HOSTS: std::cell::RefCell<std::collections::HashMap<String, FullscreenObserver>> = std::cell::RefCell::default();
}

/// Stops watching `label`; true when it hosted a fullscreen window group.
pub fn forget_fullscreen_host(label: &str) -> bool {
    FULLSCREEN_HOSTS.with_borrow_mut(|hosts| hosts.remove(label)).is_some()
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

/// The native `toggleFullScreen:`, bypassing the group handling installed on the window class.
pub fn native_toggle_fullscreen(window: &WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    on_main(window, move || {
        let (Ok(pointer), Some(native)) = (target.ns_window(), NATIVE_TOGGLE_FULLSCREEN.get()) else { return };
        unsafe { native(pointer.cast(), objc2::sel!(toggleFullScreen:), std::ptr::null_mut()) };
    })
}

/// A window group in fullscreen shares its host's Space: every other member joins it as an
/// auxiliary window over the host's frame, without a frame, window buttons or dragging, like the host.
/// Without a host the window is an ordinary one again.
pub fn set_fullscreen_auxiliary(window: &WebviewWindow, host: Option<&WebviewWindow>) -> tauri::Result<()> {
    use objc2_app_kit::{NSWindowButton, NSWindowCollectionBehavior as B};
    let target = window.clone();
    let host = host.cloned();
    on_main(window, move || {
        let Ok(pointer) = target.ns_window() else { return };
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        let frame =
            host.and_then(|host| host.ns_window().ok()).map(|host| unsafe { &*host.cast::<NSWindow>() }.frame());
        let mut behavior = native.collectionBehavior();
        if frame.is_some() {
            behavior.remove(B::FullScreenPrimary);
            behavior.insert(B::FullScreenAuxiliary | B::MoveToActiveSpace);
        } else {
            behavior.remove(B::FullScreenAuxiliary | B::MoveToActiveSpace);
            behavior.insert(B::FullScreenPrimary);
        }
        native.setCollectionBehavior(behavior);
        // Without a title bar the window has square corners and no frame, like the host.
        let mut style = native.styleMask();
        style.set(objc2_app_kit::NSWindowStyleMask::Titled, frame.is_none());
        native.setStyleMask(style);
        native.setMovable(frame.is_none());
        // Shown over the host it must appear at once, as a tab does, not zoom in like a new window.
        native.setAnimationBehavior(if frame.is_some() {
            objc2_app_kit::NSWindowAnimationBehavior::None
        } else {
            objc2_app_kit::NSWindowAnimationBehavior::Default
        });
        for kind in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
            if let Some(button) = native.standardWindowButton(kind) {
                button.setHidden(frame.is_some());
            }
        }
        if let Some(frame) = frame {
            native.setFrame_display(frame, true);
        }
        target.state::<crate::state::AppState>().sink.emit(ide_core::IdeEvent::WindowFullscreenChanged);
    })
}

/// Puts a group member shown in its host's fullscreen Space in front of the host, which AppKit
/// otherwise keeps on top of the other windows in its Space.
pub fn raise_over_host(window: &WebviewWindow, host: &WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    let host = host.clone();
    on_main(window, move || {
        let (Ok(pointer), Ok(host)) = (target.ns_window(), host.ns_window()) else { return };
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        let host = unsafe { &*host.cast::<NSWindow>() };
        native.orderWindow_relativeTo(objc2_app_kit::NSWindowOrderingMode::Above, host.windowNumber());
    })
}

/// Watches the group's fullscreen `host` and runs `left` once it is back on the desktop.
pub fn watch_fullscreen_host(host: &WebviewWindow, left: impl Fn() + Send + 'static) -> tauri::Result<()> {
    let label = host.label().to_owned();
    let target = host.clone();
    on_main(host, move || unsafe {
        let Ok(pointer) = target.ns_window() else { return };
        let native = &*pointer.cast::<NSWindow>();
        let key = label.clone();
        let block = block2::RcBlock::new(move |_| {
            forget_fullscreen_host(&key);
            left();
        });
        let observer = NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSWindowDidExitFullScreenNotification),
            Some(native),
            None,
            &block,
        );
        FULLSCREEN_HOSTS.with_borrow_mut(|hosts| hosts.insert(label, FullscreenObserver(observer)));
    })
}

thread_local! {
    /// Windows being waited on to finish entering fullscreen.
    static ENTERING_FULLSCREEN: std::cell::RefCell<std::collections::HashMap<String, FullscreenObserver>> = std::cell::RefCell::default();
}

/// Toggles `window` into native fullscreen and resolves once it is there, or after `timeout`.
pub async fn enter_fullscreen_and_wait(window: &WebviewWindow, timeout: std::time::Duration) -> tauri::Result<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let label = window.label().to_owned();
    let target = window.clone();
    on_main(window, move || unsafe {
        let Ok(pointer) = target.ns_window() else { return };
        let native = &*pointer.cast::<NSWindow>();
        let tx = std::cell::Cell::new(Some(tx));
        let block = block2::RcBlock::new(move |_| {
            if let Some(tx) = tx.take() {
                let _ = tx.send(());
            }
        });
        let observer = NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSWindowDidEnterFullScreenNotification),
            Some(native),
            None,
            &block,
        );
        ENTERING_FULLSCREEN.with_borrow_mut(|waits| waits.insert(label, FullscreenObserver(observer)));
    })?;
    let toggled = native_toggle_fullscreen(window);
    if toggled.is_ok() {
        let _ = tokio::time::timeout(timeout, rx).await;
    }
    let label = window.label().to_owned();
    on_main(window, move || {
        ENTERING_FULLSCREEN.with_borrow_mut(|waits| waits.remove(&label));
    })?;
    toggled
}

/// An observer on the workspace's notification center, removed when dropped.
struct WorkspaceObserver(Retained<NSNotificationCenter>, Retained<ProtocolObject<dyn NSObjectProtocol>>);

impl Drop for WorkspaceObserver {
    fn drop(&mut self) {
        let observer: &ProtocolObject<dyn NSObjectProtocol> = &self.1;
        unsafe { self.0.removeObserver(observer.as_ref()) };
    }
}

/// Work waiting for the active Space to change, with the observer that runs it.
struct SpaceChange {
    _observer: WorkspaceObserver,
    then: Box<dyn FnOnce()>,
}

thread_local! {
    static SPACE_CHANGE: std::cell::RefCell<Option<SpaceChange>> = const { std::cell::RefCell::new(None) };
}

/// Runs `then` on the main thread once the active Space has changed, or after `timeout` when it
/// changed before this was called. AppKit drops a fullscreen request made while a fullscreen
/// Space is being torn down.
pub fn after_space_change(app: &AppHandle, timeout: std::time::Duration, then: impl FnOnce() + Send + 'static) {
    fn run() {
        if let Some(pending) = SPACE_CHANGE.with_borrow_mut(Option::take) {
            (pending.then)();
        }
    }
    let _ = app.run_on_main_thread(move || {
        run();
        let block = block2::RcBlock::new(|_| run());
        let center = objc2_app_kit::NSWorkspace::sharedWorkspace().notificationCenter();
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(objc2_app_kit::NSWorkspaceActiveSpaceDidChangeNotification),
                None,
                None,
                &block,
            )
        };
        let observer = WorkspaceObserver(center, observer);
        SPACE_CHANGE
            .with_borrow_mut(|pending| *pending = Some(SpaceChange { _observer: observer, then: Box::new(then) }));
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(timeout).await;
        let _ = app.run_on_main_thread(run);
    });
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

type ToggleFullScreen = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

static NATIVE_TOGGLE_FULLSCREEN: std::sync::OnceLock<ToggleFullScreen> = std::sync::OnceLock::new();
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// The green window button, the Globe-F shortcut and the system's Enter Full Screen item all
/// send `toggleFullScreen:`; a grouped window answers it for the whole group.
pub fn intercept_toggle_fullscreen(window: &WebviewWindow) {
    let _ = APP.set(window.app_handle().clone());
    let _ = window.with_webview(|webview| unsafe {
        let class = objc2::ffi::object_getClass(webview.ns_window().cast()) as *mut AnyClass;
        let selector = objc2::sel!(toggleFullScreen:);
        if NATIVE_TOGGLE_FULLSCREEN.get().is_some() {
            return;
        }
        let Some(method) = (*class).instance_method(selector) else { return };
        let native: ToggleFullScreen = std::mem::transmute(method.implementation());
        let types = objc2::ffi::method_getTypeEncoding(method);
        let _ = NATIVE_TOGGLE_FULLSCREEN.set(native);
        let replacement: Imp = std::mem::transmute(toggle_fullscreen as ToggleFullScreen);
        objc2::ffi::class_replaceMethod(class, selector, replacement, types);

        let selector = objc2::sel!(constrainFrameRect:toScreen:);
        let Some(method) = (*class).instance_method(selector) else { return };
        let native: ConstrainFrameRect = std::mem::transmute(method.implementation());
        let types = objc2::ffi::method_getTypeEncoding(method);
        let _ = NATIVE_CONSTRAIN_FRAME_RECT.set(native);
        let replacement: Imp = std::mem::transmute(constrain_frame_rect as ConstrainFrameRect);
        objc2::ffi::class_replaceMethod(class, selector, replacement, types);
    });
}

type ConstrainFrameRect = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, NSRect, *mut AnyObject) -> NSRect;

static NATIVE_CONSTRAIN_FRAME_RECT: std::sync::OnceLock<ConstrainFrameRect> = std::sync::OnceLock::new();

thread_local! {
    /// Native window whose next frame assignment must keep the rectangle it was given.
    static EXACT_FRAME: Cell<usize> = const { Cell::new(0) };
}

struct ExactFrame(usize);

impl ExactFrame {
    fn begin(native: usize) -> Self {
        EXACT_FRAME.with(|slot| slot.set(native));
        Self(native)
    }
}

impl Drop for ExactFrame {
    fn drop(&mut self) {
        EXACT_FRAME.with(|slot| {
            if slot.get() == self.0 {
                slot.set(0);
            }
        });
    }
}

/// Copies `from`'s frame onto `to`. `setFrame:display:animate:` finishes before it returns;
/// tao's position and size setters only schedule the change.
pub fn copy_window_frame(from: &WebviewWindow, to: &WebviewWindow) -> tauri::Result<()> {
    apply_window_frame(from, to, false)
}

/// Copies the frame and orders `to` front before AppKit can animate or constrain it.
/// A later `show` runs `constrainFrameRect:toScreen:` and slides a titled window into place.
pub fn present_window_frame(from: &WebviewWindow, to: &WebviewWindow) -> tauri::Result<()> {
    apply_window_frame(from, to, true)
}

fn apply_window_frame(from: &WebviewWindow, to: &WebviewWindow, show: bool) -> tauri::Result<()> {
    if MainThreadMarker::new().is_some() {
        return apply_window_frame_on_main(from, to, show);
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let from = from.clone();
    let to = to.clone();
    to.clone().run_on_main_thread(move || {
        let _ = tx.send(apply_window_frame_on_main(&from, &to, show));
    })?;
    rx.recv().map_err(|error| tauri::Error::Io(std::io::Error::other(error.to_string())))?
}

fn apply_window_frame_on_main(from: &WebviewWindow, to: &WebviewWindow, show: bool) -> tauri::Result<()> {
    let source_pointer = from.ns_window()?;
    let target_pointer = to.ns_window()?;
    unsafe {
        let source = &*source_pointer.cast::<NSWindow>();
        let target = &*target_pointer.cast::<NSWindow>();
        let frame = source.frame();
        let current = target.frame();
        let differs = frame.origin.x != current.origin.x
            || frame.origin.y != current.origin.y
            || frame.size.width != current.size.width
            || frame.size.height != current.size.height;
        if !differs && !show {
            return Ok(());
        }
        // Zoom and ordering use the window's animation behavior. `animate: false` alone does not
        // stop a zoomed window from sliding to the new frame as it is shown.
        let behavior = target.animationBehavior();
        target.setAnimationBehavior(NSWindowAnimationBehavior::None);
        let result = (|| {
            let _exact = ExactFrame::begin(target_pointer as usize);
            if differs {
                target.setFrame_display_animate(frame, false, false);
            }
            if show {
                to.show()?;
                to.set_focus()?;
            }
            Ok(())
        })();
        target.setAnimationBehavior(behavior);
        result
    }
}

/// AppKit keeps a titled window's top edge below the menu bar, and on a notched display below the
/// camera housing, whenever the window is placed, shown or resized. A group-tab frame copy keeps
/// the rectangle it was given, so the window about to be shown is not shifted.
unsafe extern "C-unwind" fn constrain_frame_rect(
    this: *mut AnyObject,
    selector: Sel,
    frame: NSRect,
    screen: *mut AnyObject,
) -> NSRect {
    if EXACT_FRAME.with(|slot| slot.get() == this as usize) {
        return frame;
    }
    match NATIVE_CONSTRAIN_FRAME_RECT.get() {
        Some(native) => unsafe { native(this, selector, frame, screen) },
        None => frame,
    }
}

unsafe extern "C-unwind" fn toggle_fullscreen(this: *mut AnyObject, selector: Sel, sender: *mut AnyObject) {
    if let Some(window) = APP.get().and_then(|app| grouped_window(app, this)) {
        if let Err(error) = crate::window_groups::toggle_fullscreen(&window) {
            tracing::warn!(message = error.message, "cannot toggle fullscreen");
        }
        return;
    }
    if let Some(native) = NATIVE_TOGGLE_FULLSCREEN.get() {
        unsafe { native(this, selector, sender) };
    }
}

fn project_window(app: &AppHandle, native: *mut AnyObject) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.ns_window().is_ok_and(|pointer| pointer.cast::<AnyObject>() == native))
}

/// `native` as a project window in a window group.
fn grouped_window(app: &AppHandle, native: *mut AnyObject) -> Option<WebviewWindow> {
    let window = project_window(app, native)?;
    let grouped = app.state::<WindowsState>().groups.lock().group(window.label()).is_some();
    grouped.then_some(window)
}

/// Whether AppKit is handling a key press right now. A menu item performed at this point
/// was chosen by its key equivalent: a click, arrow keys plus Return and accessibility
/// presses all run with a non-key current event.
pub fn handling_key_press() -> bool {
    let Some(mtm) = MainThreadMarker::new() else { return false };
    objc2_app_kit::NSApplication::sharedApplication(mtm)
        .currentEvent()
        .is_some_and(|event| event.r#type() == objc2_app_kit::NSEventType::KeyDown)
}
