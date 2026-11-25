//! AppKit input routed to the workbench webview: Command shortcuts and page gestures.
use objc2::{ClassType, MainThreadMarker, Message, msg_send, rc::Retained, runtime::AnyObject};
use objc2_app_kit::{
    NSEvent, NSEventMask, NSEventModifierFlags, NSEventPhase, NSEventSwipeTrackingOptions, NSEventType, NSWindow,
};
use objc2_web_kit::WKWebView;
use std::{cell::RefCell, collections::HashMap, ptr::NonNull};
use tauri::{Listener, Manager, WebviewWindow};

struct Gestures {
    monitor: Retained<AnyObject>,
    view: Retained<WKWebView>,
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
        let view = unsafe { Retained::retain(webview.inner().cast::<WKWebView>()).unwrap() };
        let primary_view = view.clone();
        let native = webview.ns_window() as usize;
        let window = target.clone();
        let block = block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            let event = unsafe { event.as_ref() };
            let pass = std::ptr::from_ref(event).cast_mut();
            let key_down = event.r#type() == NSEventType::KeyDown;
            if key_down && !event.modifierFlags().contains(NSEventModifierFlags::Command) {
                return pass;
            }
            let Some(owner) = event.window(MainThreadMarker::new().expect("event monitor on main thread")) else {
                return pass;
            };
            if Retained::as_ptr(&owner) as usize != native {
                return pass;
            }
            if key_down {
                return if window.state::<crate::menu::MenuState>().routes_key(event)
                    && workbench_key_equivalent(&view, &owner, event)
                {
                    std::ptr::null_mut()
                } else {
                    pass
                };
            }
            if event.r#type() == NSEventType::Swipe {
                if event.deltaX() != 0.0 && event.deltaY() == 0.0 {
                    // Cocoa swipeWithEvent: uses positive deltaX for Back; verified with a physical trackpad.
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
            pass
        });
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::KeyDown | NSEventMask::Swipe | NSEventMask::ScrollWheel,
                &block,
            )
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
                Gestures {
                    monitor,
                    view: primary_view,
                    listener,
                    window: target,
                    generation: 0,
                    pending: None,
                    decided: false,
                },
            )
        });
    });
}

/// Printable Command equivalents displayed by the native menu. Named keys such as arrows use AppKit.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct CommandKey {
    modifiers: NSEventModifierFlags,
    key: u8,
}

impl CommandKey {
    pub(crate) fn from_binding(binding: &str) -> Option<Self> {
        let (mods, name) = binding.rsplit_once('+')?;
        let [key] = *name.as_bytes() else { return None };
        let mut modifiers = NSEventModifierFlags::empty();
        for modifier in mods.split('+') {
            modifiers |= match modifier {
                "Meta" | "Cmd" | "CmdOrCtrl" => NSEventModifierFlags::Command,
                "Alt" => NSEventModifierFlags::Option,
                "Ctrl" => NSEventModifierFlags::Control,
                "Shift" => NSEventModifierFlags::Shift,
                _ => return None,
            };
        }
        (key.is_ascii_graphic() && modifiers.contains(NSEventModifierFlags::Command))
            .then_some(Self { modifiers, key: key.to_ascii_uppercase() })
    }

    pub(crate) fn from_event(event: &NSEvent) -> Option<Self> {
        let modifiers = event.modifierFlags()
            & (NSEventModifierFlags::Command
                | NSEventModifierFlags::Shift
                | NSEventModifierFlags::Control
                | NSEventModifierFlags::Option
                | NSEventModifierFlags::Function
                | NSEventModifierFlags::NumericPad);
        // Use the active layout's Command layer, including layouts that switch to QWERTY under Command.
        let chars = if modifiers == NSEventModifierFlags::Command {
            event.characters()?
        } else {
            event.charactersByApplyingModifiers(NSEventModifierFlags::Command)?
        };
        if chars.length() != 1 {
            return None;
        }
        let key = u8::try_from(chars.characterAtIndex(0)).ok()?.to_ascii_uppercase();
        Some(Self { modifiers, key })
    }
}

/// A sheet or guest view can take focus before the renderer has updated the Edit menu.
pub(crate) fn perform_native_history_if_needed(id: &str) -> bool {
    let selector = match id {
        crate::menu::EDITOR_UNDO => objc2::sel!(undo:),
        crate::menu::EDITOR_REDO => objc2::sel!(redo:),
        _ => return false,
    };
    let Some(mtm) = MainThreadMarker::new() else { return false };
    let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
    if app.modalWindow().is_none()
        && let Some(window) = app.keyWindow()
        && window.attachedSheet().is_none()
        && let Some(responder) = window.firstResponder()
        && WINDOWS.with_borrow(|windows| {
            windows.values().any(|w| {
                std::ptr::eq(Retained::as_ptr(&w.view), Retained::as_ptr(&responder).cast())
                    && !matches!(
                        crate::windows::auxiliary(w.window.label()),
                        Some((crate::windows::AuxKind::Settings, _))
                    )
            })
        })
    {
        return false;
    }
    // SAFETY: these standard NSResponder actions take one object argument. AppKit locates the target.
    unsafe { app.sendAction_to_from(selector, None, None) };
    true
}

fn workbench_key_equivalent(view: &WKWebView, owner: &NSWindow, event: &NSEvent) -> bool {
    if !owner.isKeyWindow() || owner.attachedSheet().is_some() {
        return false;
    }
    let Some(responder) = owner.firstResponder() else { return false };
    if !std::ptr::eq(Retained::as_ptr(&responder).cast::<WKWebView>(), view) {
        return false;
    }
    // Wry's child view declines every key equivalent. Restore WebKit's page-first dispatch
    // for the focused workbench; WebKit declines a resent event so AppKit can try its menu.
    // SAFETY: Tauri supplied a WKWebView subclass and the monitor runs on the AppKit thread.
    unsafe { msg_send![super(view, WKWebView::class()), performKeyEquivalent: event] }
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
