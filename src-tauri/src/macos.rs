//! macOS window tab preferences, applied to application-drawn project tabs.
use crate::windows::{Launch, WindowsState};
use ide_core::{IdeError, IdeResult};
use ide_workspace::window_groups::{TabbingPreference, should_group_new_project};
use objc2::{
    MainThreadMarker,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Imp, ProtocolObject, Sel},
};
use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowUserTabbingPreference};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol, NSRect};
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
    // A member shown in its group's fullscreen Space is not in native fullscreen itself.
    let fullscreen = active
        .as_ref()
        .is_some_and(|w| w.is_fullscreen().unwrap_or(false) || crate::window_groups::in_fullscreen(app, w.label()));
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
    static FULLSCREEN_TRANSFERS: std::cell::RefCell<std::collections::HashMap<String, FullscreenObserver>> = std::cell::RefCell::default();
}

pub fn forget_fullscreen(label: &str) {
    FULLSCREEN_TRANSFERS.with_borrow_mut(|observers| observers.remove(label));
}

/// AppKit cannot enter another window's fullscreen Space until the old one has exited.
pub fn transfer_fullscreen(from: &WebviewWindow, to: &WebviewWindow) -> tauri::Result<()> {
    let source = from.label().to_owned();
    let to = to.clone();
    from.with_webview(move |webview| unsafe {
        let native = &*webview.ns_window().cast::<NSWindow>();
        forget_fullscreen(&source);
        let label = source.clone();
        let block = block2::RcBlock::new(move |_| {
            forget_fullscreen(&label);
            let app = to.app_handle();
            let selected = app.state::<WindowsState>().groups.lock().group(to.label()).map(|g| g.selected.clone());
            if let Some(selected) = selected {
                // Exiting fullscreen can show the old window again; reapply group visibility.
                let _ = crate::window_groups::select(app, &selected, &selected);
                if selected == to.label() {
                    let _ = to.set_fullscreen(true);
                }
            }
        });
        let observer = NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSWindowDidExitFullScreenNotification),
            Some(native),
            None,
            &block,
        );
        FULLSCREEN_TRANSFERS.with_borrow_mut(|observers| observers.insert(source, FullscreenObserver(observer)));
        native.toggleFullScreen(None);
    })
}

/// Runs `then` on the main thread once `window` has left native fullscreen.
pub fn after_fullscreen_exit(window: &WebviewWindow, then: impl FnOnce() + Send + 'static) -> tauri::Result<()> {
    let label = window.label().to_owned();
    window.with_webview(move |webview| unsafe {
        let native = &*webview.ns_window().cast::<NSWindow>();
        forget_fullscreen(&label);
        let then = std::cell::Cell::new(Some(then));
        let key = label.clone();
        let block = block2::RcBlock::new(move |_| {
            forget_fullscreen(&key);
            if let Some(then) = then.take() {
                then();
            }
        });
        let observer = NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSWindowDidExitFullScreenNotification),
            Some(native),
            None,
            &block,
        );
        FULLSCREEN_TRANSFERS.with_borrow_mut(|observers| observers.insert(label, FullscreenObserver(observer)));
    })
}

/// Enters native fullscreen and makes it stick: while another window's fullscreen Space is
/// closing (just after that window closed), AppKit ignores the request or abandons the transition.
pub fn enter_fullscreen(window: &WebviewWindow) {
    const SETTLE: std::time::Duration = std::time::Duration::from_millis(700);
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let mut held = false;
        for _ in 0..8 {
            if is_native_fullscreen(&window) {
                if held {
                    return;
                }
                held = true;
            } else {
                held = false;
                let _ = native_toggle_fullscreen(&window);
            }
            tokio::time::sleep(SETTLE).await;
        }
    });
}

fn is_native_fullscreen(window: &WebviewWindow) -> bool {
    let window = window.clone();
    on_main(&window.clone(), move || {
        window.ns_window().is_ok_and(|pointer| {
            unsafe { &*pointer.cast::<NSWindow>() }.styleMask().contains(objc2_app_kit::NSWindowStyleMask::FullScreen)
        })
    })
    .unwrap_or(false)
}

/// Enters or leaves native fullscreen without the group routing of `toggle_fullscreen` below.
pub fn native_toggle_fullscreen(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| unsafe {
        let this = webview.ns_window().cast::<AnyObject>();
        match NATIVE_TOGGLE_FULLSCREEN.get() {
            Some(native) => native(this, objc2::sel!(toggleFullScreen:), std::ptr::null_mut()),
            None => (*this.cast::<NSWindow>()).toggleFullScreen(None),
        }
    })
}

/// Group windows in native fullscreen whose Space their group shares. The group's other members
/// are shown over the anchor inside that Space, so switching projects is a plain show/hide that
/// never leaves the Space, and there is no `NSWindowTabGroup` with a second tab bar.
static ANCHORS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn is_anchor(label: &str) -> bool {
    ANCHORS.lock().unwrap().iter().any(|l| l == label)
}

pub fn set_anchor(label: &str, on: bool) {
    let mut anchors = ANCHORS.lock().unwrap();
    anchors.retain(|l| l != label);
    if on {
        anchors.push(label.to_owned());
    }
}

/// A group member shown in its anchor's fullscreen Space: its `NSWindow`, and what it had before.
struct Covering {
    native: usize,
    frame: NSRect,
    min_size: objc2_foundation::NSSize,
    behavior: NSWindowCollectionBehavior,
}

thread_local! {
    static COVERING: std::cell::RefCell<std::collections::HashMap<String, Covering>> = std::cell::RefCell::default();
}

fn on_main<T: Send + 'static>(window: &WebviewWindow, f: impl FnOnce() -> T + Send + 'static) -> IdeResult<T> {
    if MainThreadMarker::new().is_some() {
        return Ok(f());
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| IdeError::internal(e.to_string()))?;
    rx.recv().map_err(|e| IdeError::internal(e.to_string()))
}

/// Lets `window` be shown in `anchor`'s fullscreen Space, at the anchor's frame. Its window
/// buttons are hidden like the anchor's; the anchor's title bar is revealed at the top edge.
pub fn join_space(window: &WebviewWindow, anchor: &WebviewWindow) -> IdeResult<()> {
    let (window, anchor) = (window.clone(), anchor.clone());
    on_main(&window.clone(), move || {
        let (Ok(pointer), Ok(anchor)) = (window.ns_window(), anchor.ns_window()) else { return };
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        let frame = unsafe { &*anchor.cast::<NSWindow>() }.frame();
        COVERING.with_borrow_mut(|windows| {
            windows.entry(window.label().to_owned()).or_insert_with(|| Covering {
                native: pointer as usize,
                frame: native.frame(),
                min_size: native.minSize(),
                behavior: native.collectionBehavior(),
            });
        });
        native.setCollectionBehavior(
            native.collectionBehavior()
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::MoveToActiveSpace,
        );
        native.setMinSize(frame.size);
        set_buttons_hidden(native, true);
        native.setFrame_display(frame, true);
    })
}

/// Takes `window` out of its anchor's Space, back to the frame it had before joining.
pub fn leave_space(window: &WebviewWindow) -> IdeResult<()> {
    let window = window.clone();
    on_main(&window.clone(), move || {
        let Some(covering) = COVERING.with_borrow_mut(|windows| windows.remove(window.label())) else { return };
        let Ok(pointer) = window.ns_window() else { return };
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        native.setCollectionBehavior(covering.behavior);
        native.setMinSize(covering.min_size);
        set_buttons_hidden(native, false);
        native.setFrame_display(covering.frame, true);
    })
}

pub fn is_on_active_space(window: &WebviewWindow) -> bool {
    let window = window.clone();
    on_main(&window.clone(), move || {
        window.ns_window().is_ok_and(|pointer| unsafe { &*pointer.cast::<NSWindow>() }.isOnActiveSpace())
    })
    .unwrap_or(true)
}

/// Forgets a closed window's part in a fullscreen group; true when it was the anchor.
pub fn forget_group_fullscreen(app: &AppHandle, label: &str) -> bool {
    let was = is_anchor(label);
    set_anchor(label, false);
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
        COVERING.with_borrow_mut(|windows| windows.remove(&label));
    });
    was
}

fn set_buttons_hidden(native: &NSWindow, hidden: bool) {
    use objc2_app_kit::NSWindowButton;
    for kind in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
        if let Some(button) = native.standardWindowButton(kind) {
            button.setHidden(hidden);
        }
    }
}

type ToggleFullScreen = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

static NATIVE_TOGGLE_FULLSCREEN: std::sync::OnceLock<ToggleFullScreen> = std::sync::OnceLock::new();
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// The green window button, the Globe-F shortcut and the system's Enter Full Screen item all
/// send `toggleFullScreen:`; a grouped window answers it for its whole group.
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

/// AppKit fits a titled window into the desktop's visible area (below the menu bar and camera
/// housing, above the Dock) whenever it is placed, shown or resized; a member shown in its
/// anchor's fullscreen Space must keep the anchor's frame instead.
unsafe extern "C-unwind" fn constrain_frame_rect(
    this: *mut AnyObject,
    selector: Sel,
    frame: NSRect,
    screen: *mut AnyObject,
) -> NSRect {
    if COVERING.with_borrow(|windows| windows.values().any(|covering| covering.native == this as usize)) {
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

/// `native` as a grouped project window whose fullscreen is its group's: not in native
/// fullscreen, or the group's anchor. Another member in native fullscreen (restored that way)
/// leaves it the usual way.
fn grouped_window(app: &AppHandle, native: *mut AnyObject) -> Option<WebviewWindow> {
    let mask: objc2_app_kit::NSWindowStyleMask = unsafe { objc2::msg_send![native, styleMask] };
    let window = app
        .webview_windows()
        .into_values()
        .find(|w| w.ns_window().is_ok_and(|pointer| pointer.cast::<AnyObject>() == native))?;
    let grouped = app.state::<WindowsState>().groups.lock().group(window.label()).is_some();
    let own_fullscreen = mask.contains(objc2_app_kit::NSWindowStyleMask::FullScreen) && !is_anchor(window.label());
    (grouped && !own_fullscreen).then_some(window)
}
