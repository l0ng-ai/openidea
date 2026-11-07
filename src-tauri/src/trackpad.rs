//! macOS trackpad page swipes, sent to the window under the fingers.
//!
//! WKWebView never reports the system "swipe between pages" gesture to the page, so an `NSEvent`
//! monitor hears it and the window's keymap decides what it does (`SwipeLeft` / `SwipeRight`,
//! src/platform/trackpadSwipe.ts). It is not an `IdeEvent`: those fan out to every window of a project.

use serde::Serialize;

pub const SWIPE_EVENT: &str = "openidea://swipe";

/// Where the fingers moved. A right swipe is "back", as in Safari and IDEA.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Left,
    Right,
}

/// The wire shape src/platform/trackpadSwipe.ts accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Swipe {
    pub direction: Direction,
    pub meta_key: bool,
    pub ctrl_key: bool,
    pub alt_key: bool,
    pub shift_key: bool,
}

/// `deltaX` of an `NSEventTypeSwipe`. AppKit sends a stream of them per gesture, all `0` but the
/// one that completes the swipe, and it is `-1` when the fingers moved left to right (measured on
/// macOS 27 with Natural scrolling on and off; `deltaY` was always `0`).
pub fn direction(delta_x: f64) -> Option<Direction> {
    if delta_x < 0.0 {
        Some(Direction::Right)
    } else if delta_x > 0.0 {
        Some(Direction::Left)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
pub use platform::observe;

#[cfg(target_os = "macos")]
mod platform {
    use super::{SWIPE_EVENT, Swipe, direction};
    use objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use std::{cell::RefCell, ptr::NonNull};
    use tauri::{AppHandle, Emitter, EventTarget, Manager};

    thread_local! {
        /// Keeps the monitor registered for the life of the app.
        static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    fn label_of(app: &AppHandle, native: *mut AnyObject) -> Option<String> {
        app.webview_windows()
            .into_iter()
            .find(|(_, w)| w.ns_window().is_ok_and(|pointer| pointer.cast::<AnyObject>() == native))
            .map(|(label, _)| label)
    }

    /// Sends a completed swipe to the app window it happened on; anything else is ignored.
    fn deliver(app: &AppHandle, mtm: MainThreadMarker, ev: &NSEvent) -> Option<()> {
        // `deltaX` is only valid on the event types that carry one.
        if ev.r#type() != NSEventType::Swipe {
            return None;
        }
        let direction = direction(ev.deltaX())?;
        let window = ev.window(mtm)?;
        let label = label_of(app, Retained::as_ptr(&window).cast::<AnyObject>().cast_mut())?;
        let flags = ev.modifierFlags();
        let swipe = Swipe {
            direction,
            meta_key: flags.contains(NSEventModifierFlags::Command),
            ctrl_key: flags.contains(NSEventModifierFlags::Control),
            alt_key: flags.contains(NSEventModifierFlags::Option),
            shift_key: flags.contains(NSEventModifierFlags::Shift),
        };
        app.emit_to(EventTarget::webview_window(label), SWIPE_EVENT, swipe)
            .inspect_err(|error| tracing::debug!(%error, "cannot deliver a trackpad swipe"))
            .ok()
    }

    /// Hears page swipes on any window of the app. Must run on the main thread.
    pub fn observe(app: &AppHandle) {
        let Some(mtm) = MainThreadMarker::new() else {
            tracing::warn!("trackpad swipes are not observed: not on the main thread");
            return;
        };
        let app = app.clone();
        let block = block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit passes a live event for the duration of the call.
            deliver(&app, mtm, unsafe { event.as_ref() });
            // Passed on untouched: the monitor only listens.
            event.as_ptr()
        });
        // SAFETY: the block returns the event it was given.
        let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::Swipe, &block) };
        MONITOR.with_borrow_mut(|slot| *slot = monitor);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_completing_event_of_a_swipe_has_a_direction() {
        // Measured: ~10-20 events with 0 per swipe, then one with ±1.
        for (delta_x, expected) in
            [(-1.0, Some(Direction::Right)), (1.0, Some(Direction::Left)), (0.0, None), (-0.0, None), (f64::NAN, None)]
        {
            assert_eq!(direction(delta_x), expected, "{delta_x}");
        }
    }

    #[test]
    fn serializes_to_the_shape_the_window_accepts() {
        let swipe =
            Swipe { direction: Direction::Right, meta_key: false, ctrl_key: false, alt_key: true, shift_key: false };
        assert_eq!(
            serde_json::to_value(swipe).unwrap(),
            serde_json::json!({
                "direction": "right",
                "metaKey": false,
                "ctrlKey": false,
                "altKey": true,
                "shiftKey": false,
            })
        );
        let left = serde_json::to_value(Swipe { direction: Direction::Left, ..swipe }).unwrap();
        assert_eq!(left["direction"], "left");
    }
}
