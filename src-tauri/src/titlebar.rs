//! Size the native title bar around the window buttons to match the web toolbar.
//!
//! An empty unified toolbar makes AppKit lay out and vertically centre the buttons itself, so
//! nothing moves them behind its back and they stay still during live resize. A bar lower than
//! the compact toolbar (IDEA's 30px compact header) keeps the plain title bar instead.
//!
//! In native full screen the same toolbar is drawn as an opaque strip over the web title bar, so
//! it is hidden from the moment the window starts entering full screen until it has left (#1899).
//!
//! Full screen also parks the window buttons in the title bar AppKit reveals with the menu bar.
//! Moving that title-bar view out of the window asserts in `_relinquishTitlebar`, so full screen
//! hosts a second set made by `standardWindowButton:forStyleMask:` (the buttons IntelliJ's runtime
//! uses) in the slot the page keeps, and hides the menu-bar strip (#4746).

use objc2::{
    MainThreadMarker, msg_send,
    rc::{Retained, Weak},
    runtime::ProtocolObject,
    sel,
};
use objc2_app_kit::{
    NSApplication, NSAutoresizingMaskOptions, NSToolbar, NSView, NSWindow, NSWindowButton,
    NSWindowDidBecomeKeyNotification, NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification,
    NSWindowOrderingMode, NSWindowStyleMask, NSWindowTitleVisibility, NSWindowToolbarStyle,
    NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol, NSPoint, NSRect, NSSize};
use std::{cell::Cell, cell::RefCell, collections::HashMap, rc::Rc};
use tauri::Manager;

/// The native chrome around the window buttons: the plain title bar (28pt), or an empty unified
/// compact (38pt) or unified (52pt) toolbar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Chrome {
    Plain,
    Toolbar(NSWindowToolbarStyle),
}

/// Midpoints between the 28, 38 and 52pt bars.
const PLAIN_MAX_HEIGHT: f64 = 33.0;
const COMPACT_MAX_HEIGHT: f64 = 45.0;

/// The chrome closest to the web bar, so the buttons sit on its centre line (IDEA's 30px compact
/// header takes the plain title bar).
fn chrome_for(height: f64) -> Chrome {
    if height < PLAIN_MAX_HEIGHT {
        Chrome::Plain
    } else if height < COMPACT_MAX_HEIGHT {
        Chrome::Toolbar(NSWindowToolbarStyle::UnifiedCompact)
    } else {
        Chrome::Toolbar(NSWindowToolbarStyle::Unified)
    }
}

/// Whether a window is in, or on its way into, native full screen. `styleMask` cannot answer
/// this: its full screen flag only turns on at `didEnterFullScreen`, after the resize.
/// `leaving` is set at `willExit` so the buttons return before the animation, while the toolbar
/// stays hidden until `didExit`.
#[derive(Default)]
struct Fullscreen {
    entered: Cell<bool>,
    leaving: Cell<bool>,
}

impl Fullscreen {
    fn will_enter(&self) {
        self.entered.set(true);
        self.leaving.set(false);
    }

    fn will_exit(&self) {
        self.leaving.set(true);
    }

    fn did_exit(&self) {
        self.entered.set(false);
        self.leaving.set(false);
    }

    fn toolbar_visible(&self) -> bool {
        !self.entered.get()
    }

    /// Buttons stay on the theme frame only while full screen is settled, not while leaving it.
    fn hosts_buttons(&self) -> bool {
        self.entered.get() && !self.leaving.get()
    }
}

/// The system buttons hosted in the page's title-bar slot for the duration of full screen.
struct ButtonHost {
    slot: Retained<NSView>,
}

struct Observer(Retained<ProtocolObject<dyn NSObjectProtocol>>);

impl Drop for Observer {
    fn drop(&mut self) {
        let observer: &ProtocolObject<dyn NSObjectProtocol> = &self.0;
        unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
    }
}

struct Tracked {
    state: Rc<Fullscreen>,
    height: Rc<Cell<f64>>,
    buttons: Rc<RefCell<Option<ButtonHost>>>,
    _observers: [Observer; 5],
}

thread_local! {
    static WINDOWS: RefCell<HashMap<String, Tracked>> = RefCell::default();
}

fn sync_chrome(window: &NSWindow, state: &Fullscreen, height: f64, buttons: &RefCell<Option<ButtonHost>>) {
    if let Some(toolbar) = window.toolbar() {
        let visible = state.toolbar_visible();
        if toolbar.isVisible() != visible {
            toolbar.setVisible(visible);
        }
    }
    if state.hosts_buttons() {
        transparent_titlebar(window);
        host_buttons(window, height, buttons);
        set_fullscreen_toolbar_hidden(true);
    } else {
        restore_buttons(buttons);
        set_fullscreen_toolbar_hidden(false);
    }
}

/// Full-screen content draws under a transparent title bar, so the reparented buttons sit in the
/// page's slot instead of a separate strip.
fn transparent_titlebar(window: &NSWindow) {
    if !window.styleMask().contains(NSWindowStyleMask::FullSizeContentView) {
        let mut mask = window.styleMask();
        mask.insert(NSWindowStyleMask::FullSizeContentView);
        window.setStyleMask(mask);
    }
    window.setTitlebarAppearsTransparent(true);
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
}

/// Left inset AppKit uses for the button container on the desktop.
const BUTTON_X: f64 = 7.0;

/// Origin of the button container in a top-left title-bar slot. AppKit's y grows upward.
fn button_origin(parent_height: f64, titlebar_height: f64, button_height: f64) -> (f64, f64) {
    let y = parent_height - titlebar_height + (titlebar_height - button_height).max(0.0) / 2.0;
    (BUTTON_X, y)
}

fn host_buttons(window: &NSWindow, height: f64, buttons: &RefCell<Option<ButtonHost>>) {
    let Some(content) = window.contentView() else { return };
    let Some(mtm) = MainThreadMarker::new() else { return };
    if buttons.borrow().is_none() {
        let Some(slot) = fullscreen_buttons(window, mtm) else { return };
        buttons.borrow_mut().replace(ButtonHost { slot });
    }
    let host = buttons.borrow();
    let Some(host) = host.as_ref() else { return };
    let slot = &host.slot;
    let (x, y) = button_origin(content.bounds().size.height, height, slot.frame().size.height);
    slot.setFrameOrigin(NSPoint::new(x, y));
    slot.setAutoresizingMask(NSAutoresizingMaskOptions::ViewMinYMargin);
    // Above the layer-backed web view. A non-layer sibling paints behind it.
    slot.setWantsLayer(true);
    content.addSubview_positioned_relativeTo(slot, NSWindowOrderingMode::Above, None);
    // AppKit fades the strip back in when the pointer hits the top. Keep putting it away.
    arm_strip_timer();
}

/// System buttons at the same size and spacing as the window's own, wired to that window.
/// Full screen disables miniaturize; the yellow button stays, greyed out.
fn fullscreen_buttons(window: &NSWindow, mtm: MainThreadMarker) -> Option<Retained<NSView>> {
    let kinds = [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton];
    let actions = [sel!(performClose:), sel!(performMiniaturize:), sel!(toggleFullScreen:)];
    let live = kinds.iter().map(|kind| window.standardWindowButton(*kind)).collect::<Option<Vec<_>>>()?;
    let close = live[0].frame();
    let mini = live[1].frame();
    let zoom = live[2].frame();
    let slot = NSView::initWithFrame(
        mtm.alloc(),
        NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(zoom.origin.x - close.origin.x + zoom.size.width, close.size.height),
        ),
    );
    let mut mask = window.styleMask();
    mask.insert(NSWindowStyleMask::FullScreen);
    for (index, kind) in kinds.into_iter().enumerate() {
        let button = NSWindow::standardWindowButton_forStyleMask(kind, mask, mtm)?;
        let x = [0.0, mini.origin.x - close.origin.x, zoom.origin.x - close.origin.x][index];
        let size = [close.size, mini.size, zoom.size][index];
        button.setFrame(NSRect::new(NSPoint::new(x, 0.0), size));
        unsafe {
            let _: () = msg_send![&*button, setTarget: window];
            let _: () = msg_send![&*button, setAction: Some(actions[index])];
        }
        if kind == NSWindowButton::MiniaturizeButton {
            button.setEnabled(false);
        }
        slot.addSubview(&button);
    }
    Some(slot)
}

/// The window AppKit slides in with the menu bar. Its content is the second set of buttons.
fn set_fullscreen_toolbar_hidden(hidden: bool) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    for window in NSApplication::sharedApplication(mtm).windows() {
        let name = window.class().name().to_string_lossy();
        // The reveal strip is a short auxiliary window. The transition overlay is the whole screen.
        let strip = name.contains("ToolbarFullScreen")
            || name.contains("MenuBarCompanion")
            || (name.contains("FullScreen") && window.frame().size.height < 80.0);
        if !strip {
            continue;
        }
        // Hiding the content view leaves the window's own black backing, which is the strip.
        window.setOpaque(!hidden);
        window.setAlphaValue(if hidden { 0.0 } else { 1.0 });
        if let Some(content) = window.contentView() {
            content.setHidden(hidden);
        }
        window.setIgnoresMouseEvents(hidden);
    }
}

// `dispatch_get_main_queue()` is a macro for this queue.
unsafe extern "C" {
    static _dispatch_main_q: u8;
    fn dispatch_time(when: u64, delta: i64) -> u64;
    fn dispatch_after_f(
        when: u64,
        queue: *mut std::ffi::c_void,
        context: *mut std::ffi::c_void,
        work: unsafe extern "C" fn(*mut std::ffi::c_void),
    );
}

fn main_queue() -> *mut std::ffi::c_void {
    (&raw const _dispatch_main_q).cast_mut().cast()
}

thread_local! {
    static STRIP_TIMER: Cell<bool> = const { Cell::new(false) };
}

fn arm_strip_timer() {
    STRIP_TIMER.with(|armed| {
        if armed.get() {
            return;
        }
        armed.set(true);
        unsafe {
            dispatch_after_f(dispatch_time(0, 8_000_000), main_queue(), std::ptr::null_mut(), hide_strip_tick);
        }
    });
}

unsafe extern "C" fn hide_strip_tick(_: *mut std::ffi::c_void) {
    let hosting = WINDOWS.with_borrow(|windows| windows.values().any(|tracked| tracked.state.hosts_buttons()));
    if !hosting {
        STRIP_TIMER.with(|armed| armed.set(false));
        return;
    }
    set_fullscreen_toolbar_hidden(true);
    unsafe { dispatch_after_f(dispatch_time(0, 8_000_000), main_queue(), std::ptr::null_mut(), hide_strip_tick) };
}

fn restore_buttons(buttons: &RefCell<Option<ButtonHost>>) {
    if let Some(host) = buttons.borrow_mut().take() {
        host.slot.removeFromSuperview();
    }
}

fn track(window: &NSWindow, app: &tauri::AppHandle) -> Tracked {
    let state = Rc::new(Fullscreen::default());
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        state.will_enter();
    }
    let height = Rc::new(Cell::new(0.0));
    let buttons = Rc::new(RefCell::new(None));
    let observe = |name, change: fn(&Fullscreen)| {
        let weak = Weak::new(window);
        let state = state.clone();
        let height = height.clone();
        let buttons = buttons.clone();
        let app = app.clone();
        let block = block2::RcBlock::new(move |_| {
            change(&state);
            if let Some(window) = weak.load() {
                sync_chrome(&window, &state, height.get(), &buttons);
                crate::macos::hide_tab_bar(&window);
            }
            // Closing a window posts this while the runtime still holds its window table, and an
            // emit from here evaluates script in that table; send it from outside the notification.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                app.state::<crate::state::AppState>().sink.emit(ide_core::IdeEvent::WindowFullscreenChanged);
            });
        });
        let observer = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(window),
                None,
                &block,
            )
        };
        Observer(observer)
    };
    let observers = unsafe {
        [
            observe(NSWindowWillEnterFullScreenNotification, Fullscreen::will_enter),
            observe(NSWindowDidEnterFullScreenNotification, Fullscreen::will_enter),
            observe(NSWindowWillExitFullScreenNotification, Fullscreen::will_exit),
            observe(NSWindowDidExitFullScreenNotification, Fullscreen::did_exit),
            // A tab shown in its group: AppKit's tab bar moves to it, and it may be in full screen.
            observe(NSWindowDidBecomeKeyNotification, |_| {}),
        ]
    };
    Tracked { state, height, buttons, _observers: observers }
}

pub fn set_height(window: &tauri::WebviewWindow, height: f64) -> tauri::Result<()> {
    let label = window.label().to_owned();
    let app = window.app_handle().clone();
    // with_webview runs on the AppKit thread.
    window.with_webview(move |webview| unsafe {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let native = &*webview.ns_window().cast::<NSWindow>();
        let (state, buttons) = WINDOWS.with_borrow_mut(|windows| {
            let tracked = windows.entry(label).or_insert_with(|| track(native, &app));
            tracked.height.set(height);
            (tracked.state.clone(), tracked.buttons.clone())
        });
        match chrome_for(height) {
            Chrome::Plain => {
                if native.toolbar().is_some() {
                    native.setToolbar(None);
                }
            }
            Chrome::Toolbar(style) => {
                if native.toolbar().is_none() {
                    let toolbar = NSToolbar::new(mtm);
                    // Hidden from the start in full screen, where it would paint an opaque strip.
                    toolbar.setVisible(state.toolbar_visible());
                    native.setToolbar(Some(&toolbar));
                }
                if native.toolbarStyle() != style {
                    native.setToolbarStyle(style);
                }
            }
        }
        sync_chrome(native, &state, height, &buttons);
    })
}

/// Stops tracking a destroyed window, which removes its notification observers.
pub fn forget(window: &tauri::Window) {
    let label = window.label().to_owned();
    let forget = move || {
        WINDOWS.with_borrow_mut(|windows| windows.remove(&label));
    };
    if MainThreadMarker::new().is_some() {
        forget();
    } else {
        let _ = window.run_on_main_thread(forget);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy, Debug)]
    enum Step {
        WillEnter,
        DidExit,
    }

    /// Visibility after each step, starting from a window on the desktop.
    #[test]
    fn toolbar_follows_native_full_screen() {
        use Step::*;
        let cases: &[(&[Step], &[bool])] = &[
            (&[], &[]),
            (&[WillEnter], &[false]),
            (&[WillEnter, DidExit], &[false, true]),
            // `set_height` between the two notifications must not bring the toolbar back.
            (&[WillEnter, WillEnter], &[false, false]),
            // A second exit, as a group member leaving after its host did, changes nothing.
            (&[WillEnter, DidExit, DidExit], &[false, true, true]),
            (&[DidExit], &[true]),
            (&[WillEnter, DidExit, WillEnter], &[false, true, false]),
        ];
        for (steps, expected) in cases {
            let state = Fullscreen::default();
            assert!(state.toolbar_visible(), "a new window is on the desktop");
            let seen: Vec<bool> = steps
                .iter()
                .map(|step| {
                    match step {
                        WillEnter => state.will_enter(),
                        DidExit => state.did_exit(),
                    }
                    state.toolbar_visible()
                })
                .collect();
            assert_eq!(&seen, expected, "{steps:?}");
        }
    }

    #[test]
    fn chrome_is_the_closest_to_the_web_bar_height() {
        use NSWindowToolbarStyle as Style;
        for (height, expected) in [
            (28.0, Chrome::Plain),
            (30.0, Chrome::Plain),
            (32.0, Chrome::Plain),
            (32.9, Chrome::Plain),
            (33.0, Chrome::Toolbar(Style::UnifiedCompact)),
            (38.0, Chrome::Toolbar(Style::UnifiedCompact)),
            (40.0, Chrome::Toolbar(Style::UnifiedCompact)),
            (44.9, Chrome::Toolbar(Style::UnifiedCompact)),
            (45.0, Chrome::Toolbar(Style::Unified)),
            (52.0, Chrome::Toolbar(Style::Unified)),
            (120.0, Chrome::Toolbar(Style::Unified)),
        ] {
            assert_eq!(chrome_for(height), expected, "{height}");
        }
    }

    #[test]
    fn leaving_full_screen_returns_the_buttons_before_the_toolbar() {
        let state = Fullscreen::default();
        state.will_enter();
        assert!(state.hosts_buttons());
        assert!(!state.toolbar_visible());
        state.will_exit();
        assert!(!state.hosts_buttons());
        assert!(!state.toolbar_visible());
        state.did_exit();
        assert!(!state.hosts_buttons());
        assert!(state.toolbar_visible());
    }

    #[test]
    fn button_container_sits_in_the_title_bar_slot() {
        let (x, y) = button_origin(900.0, 40.0, 16.0);
        assert_eq!((x, y), (7.0, 872.0));
        let (_, short) = button_origin(900.0, 30.0, 40.0);
        assert_eq!(short, 870.0);
    }
}
