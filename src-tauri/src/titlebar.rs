//! Keep the native window buttons aligned with the web toolbar, in AppKit points.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowDidUpdateNotification, NSWindowStyleMask};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol, NSPoint};

struct Titlebar {
    height: Rc<Cell<f64>>,
    observer: Retained<ProtocolObject<dyn NSObjectProtocol>>,
}

impl Drop for Titlebar {
    fn drop(&mut self) {
        unsafe { NSNotificationCenter::defaultCenter().removeObserver((*self.observer).as_ref()) };
    }
}

thread_local! {
    static TITLEBARS: RefCell<HashMap<String, Titlebar>> = RefCell::default();
}

pub fn set_height(window: &tauri::WebviewWindow, height: f64) -> tauri::Result<()> {
    let label = window.label().to_owned();
    // with_webview runs on the AppKit thread; the observer is also delivered there.
    window.with_webview(move |webview| unsafe {
        let native = &*webview.ns_window().cast::<NSWindow>();
        TITLEBARS.with_borrow_mut(|bars| {
            let bar = bars.entry(label).or_insert_with(|| {
                let height = Rc::new(Cell::new(height));
                let current = height.clone();
                let pointer = native as *const NSWindow;
                let block = RcBlock::new(move |_| center_buttons(&*pointer, current.get()));
                let observer = NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                    Some(NSWindowDidUpdateNotification),
                    Some(native),
                    None,
                    &block,
                );
                Titlebar { height, observer }
            });
            bar.height.set(height);
            center_buttons(native, height);
        });
    })
}

pub fn forget(window: &tauri::Window) {
    let label = window.label().to_owned();
    let _ = window.run_on_main_thread(move || {
        TITLEBARS.with_borrow_mut(|bars| bars.remove(&label));
    });
}

unsafe fn center_buttons(window: &NSWindow, height: f64) {
    // Fullscreen uses AppKit's own revealable title bar.
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else { return };
    let Some(minimize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else { return };
    let spacing = minimize.frame().origin.x - close.frame().origin.x;
    let Some(container) = (unsafe { close.superview().and_then(|view| view.superview()) }) else { return };
    let Some(content) = window.contentView() else { return };
    let mut frame = container.frame();
    let top = frame.origin.y + frame.size.height;
    if (frame.size.height - height).abs() > 0.01 {
        frame.size.height = height;
        frame.origin.y = top - height;
        container.setFrame(frame);
    }
    let bounds = content.bounds();
    let y = bounds.origin.y + if content.isFlipped() { height / 2.0 } else { bounds.size.height - height / 2.0 };
    for (index, kind) in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton]
        .into_iter()
        .enumerate()
    {
        let Some(button) = window.standardWindowButton(kind) else { continue };
        let Some(parent) = (unsafe { button.superview() }) else { continue };
        let center = parent.convertPoint_fromView(NSPoint::new(0.0, y), Some(&content));
        let frame = button.frame();
        let x = 14.0 + index as f64 * spacing;
        let target = center.y - frame.size.height / 2.0;
        if (frame.origin.x - x).abs() > 0.01 || (frame.origin.y - target).abs() > 0.01 {
            button.setFrameOrigin(NSPoint::new(x, target));
        }
    }
}
