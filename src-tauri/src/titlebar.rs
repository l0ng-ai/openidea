//! Size the native title bar around the window buttons to match the web toolbar.
//!
//! An empty unified toolbar makes AppKit lay out and vertically centre the buttons itself, so
//! nothing moves them behind its back and they stay still during live resize. A bar lower than
//! the compact toolbar (IDEA's 30px compact header) keeps the plain title bar instead.
//!
//! In native full screen the same toolbar is drawn as an opaque strip over the web title bar, so
//! it is hidden from the moment the window starts entering full screen until it has left (#1899).

use objc2::{
    MainThreadMarker,
    rc::{Retained, Weak},
    runtime::ProtocolObject,
};
use objc2_app_kit::{
    NSToolbar, NSWindow, NSWindowDidBecomeKeyNotification, NSWindowDidEnterFullScreenNotification,
    NSWindowDidExitFullScreenNotification, NSWindowStyleMask, NSWindowToolbarStyle,
    NSWindowWillEnterFullScreenNotification,
};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol};
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
#[derive(Default)]
struct Fullscreen(Cell<bool>);

impl Fullscreen {
    fn will_enter(&self) {
        self.0.set(true);
    }

    fn did_exit(&self) {
        self.0.set(false);
    }

    fn toolbar_visible(&self) -> bool {
        !self.0.get()
    }
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
    _observers: [Observer; 4],
}

thread_local! {
    static WINDOWS: RefCell<HashMap<String, Tracked>> = RefCell::default();
}

fn apply(window: &NSWindow, state: &Fullscreen) {
    if let Some(toolbar) = window.toolbar() {
        let visible = state.toolbar_visible();
        if toolbar.isVisible() != visible {
            toolbar.setVisible(visible);
        }
    }
}

fn track(window: &NSWindow, app: &tauri::AppHandle) -> Tracked {
    let state = Rc::new(Fullscreen::default());
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        state.will_enter();
    }
    let observe = |name, change: fn(&Fullscreen)| {
        let weak = Weak::new(window);
        let state = state.clone();
        let app = app.clone();
        let block = block2::RcBlock::new(move |_| {
            change(&state);
            if let Some(window) = weak.load() {
                apply(&window, &state);
                crate::macos::hide_tab_bar(&window);
            }
            // The web title bar releases the room kept for the window buttons in full screen.
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
            observe(NSWindowDidExitFullScreenNotification, Fullscreen::did_exit),
            // A tab shown in its group: AppKit's tab bar moves to it, and it may be in full screen.
            observe(NSWindowDidBecomeKeyNotification, |_| {}),
        ]
    };
    Tracked { state, _observers: observers }
}

pub fn set_height(window: &tauri::WebviewWindow, height: f64) -> tauri::Result<()> {
    let label = window.label().to_owned();
    let app = window.app_handle().clone();
    // with_webview runs on the AppKit thread.
    window.with_webview(move |webview| unsafe {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let native = &*webview.ns_window().cast::<NSWindow>();
        let state = WINDOWS
            .with_borrow_mut(|windows| windows.entry(label).or_insert_with(|| track(native, &app)).state.clone());
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
        apply(native, &state);
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
}
