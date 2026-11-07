//! System page gestures belong to the IDE keymap, not the webview's history.
use objc2::{MainThreadMarker, Message, rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase, NSEventSwipeTrackingOptions, NSEventType, NSView};
use std::{cell::RefCell, collections::HashMap, ptr::NonNull};
use tauri::{Listener, WebviewWindow};

struct Gestures {
    monitor: Retained<AnyObject>,
    listener: tauri::EventId,
    window: WebviewWindow,
    generation: u64,
    pending: Option<Retained<NSEvent>>,
    decided: bool,
}
thread_local! {
    static WINDOWS: RefCell<HashMap<String, Gestures>> = RefCell::default();
}

pub fn forget(label: &str) {
    if let Some(state) = WINDOWS.with_borrow_mut(|windows| windows.remove(label)) {
        unsafe { NSEvent::removeMonitor(&state.monitor) };
        state.window.unlisten(state.listener);
    }
}

fn notify(window: &WebviewWindow, name: &str, detail: serde_json::Value) {
    let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('{name}',{{detail:{detail}}}))"));
}

fn stroke(window: &WebviewWindow, right: bool) {
    notify(window, "ide:page-swipe", serde_json::json!(if right { "SwipeRight" } else { "SwipeLeft" }));
}

pub fn install(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.with_webview(move |webview| {
        let view = unsafe { Retained::retain(webview.inner().cast::<NSView>()).unwrap() };
        let native = webview.ns_window() as usize;
        let window = target.clone();
        let block = block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            let event = unsafe { event.as_ref() };
            if event
                .window(MainThreadMarker::new().expect("event monitor on main thread"))
                .is_none_or(|w| Retained::as_ptr(&w) as usize != native)
            {
                return event as *const NSEvent as *mut NSEvent;
            }
            if event.r#type() == NSEventType::Swipe {
                if event.deltaX() != 0.0 && event.deltaY() == 0.0 {
                    stroke(&window, event.deltaX() > 0.0);
                    return std::ptr::null_mut();
                }
            } else {
                let candidate = WINDOWS.with_borrow_mut(|windows| {
                    let state = windows.get_mut(window.label())?;
                    if event.phase().intersects(NSEventPhase::Ended | NSEventPhase::Cancelled) {
                        state.pending = None;
                    }
                    if event.phase().contains(NSEventPhase::Began) {
                        state.generation += 1;
                        state.decided = false;
                        state.pending = Some(event.retain());
                    }
                    if state.decided
                        || state.pending.is_none()
                        || !event.hasPreciseScrollingDeltas()
                        || !event.momentumPhase().is_empty()
                        || !NSEvent::isSwipeTrackingFromScrollEventsEnabled()
                    {
                        return None;
                    }
                    let x = event.scrollingDeltaX();
                    let y = event.scrollingDeltaY();
                    if x == 0.0 && y == 0.0 {
                        return None;
                    }
                    state.decided = true;
                    if x.abs() <= y.abs() {
                        state.pending = None;
                        return None;
                    }
                    state.pending = Some(event.retain());
                    // Ask the DOM before consuming a two-finger scroll. Native coordinates are points;
                    // browser zoom is applied by the frontend when hit-testing.
                    let point = view.convertPoint_fromView(event.locationInWindow(), None);
                    let y = if view.isFlipped() { point.y } else { view.bounds().size.height - point.y };
                    Some(serde_json::json!({"id": state.generation, "x": point.x, "y": y}))
                });
                if let Some(candidate) = candidate {
                    notify(&window, "ide:page-swipe-candidate", candidate);
                }
            }
            event as *const NSEvent as *mut NSEvent
        });
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::Swipe | NSEventMask::ScrollWheel, &block)
        };
        let Some(monitor) = monitor else {
            return;
        };
        let window = target.clone();
        let listener = target.listen("ide://page-swipe-track", move |request| {
            let Ok(id) = serde_json::from_str::<u64>(request.payload()) else {
                return;
            };
            let target = window.clone();
            let _ = window.run_on_main_thread(move || track(&target, id));
        });
        WINDOWS.with_borrow_mut(|windows| {
            windows.insert(
                target.label().into(),
                Gestures { monitor, listener, window: target, generation: 0, pending: None, decided: false },
            )
        });
    });
}

fn track(window: &WebviewWindow, id: u64) {
    let event = WINDOWS.with_borrow_mut(|windows| {
        let state = windows.get_mut(window.label())?;
        if state.generation != id {
            return None;
        }
        state.pending.take()
    });
    let Some(event) = event else {
        return;
    };
    if !NSEvent::isSwipeTrackingFromScrollEventsEnabled() || !window.is_focused().unwrap_or(false) {
        return;
    }
    let window = window.clone();
    let right = physical_right(event.scrollingDeltaX(), event.isDirectionInvertedFromDevice());
    let fired = std::cell::Cell::new(false);
    let block = block2::RcBlock::new(
        move |amount: f64,
              phase: NSEventPhase,
              _complete: objc2::runtime::Bool,
              _stop: NonNull<objc2::runtime::Bool>| {
            if phase.contains(NSEventPhase::Ended) && amount != 0.0 && !fired.replace(true) {
                stroke(&window, right);
            }
        },
    );
    event.trackSwipeEventWithOptions_dampenAmountThresholdMin_max_usingHandler(
        NSEventSwipeTrackingOptions::LockDirection,
        -1.0,
        1.0,
        &block,
    );
}

fn physical_right(delta_x: f64, inverted: bool) -> bool {
    (delta_x > 0.0) == inverted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_direction_respects_natural_scrolling() {
        for (delta, inverted, right) in
            [(1.0, true, true), (-1.0, true, false), (1.0, false, false), (-1.0, false, true)]
        {
            assert_eq!(physical_right(delta, inverted), right);
        }
    }
}
