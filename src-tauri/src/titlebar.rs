//! Size the native title bar around the window buttons to match the web toolbar.
//!
//! An empty unified toolbar makes AppKit lay out and vertically centre the buttons itself, so
//! nothing moves them behind its back and they stay still during live resize.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSToolbar, NSWindow, NSWindowToolbarStyle};

/// Unified compact (38pt) and unified (52pt) toolbars; pick the one closer to the web bar.
const COMPACT_MAX_HEIGHT: f64 = 45.0;

pub fn set_height(window: &tauri::WebviewWindow, height: f64) -> tauri::Result<()> {
    // with_webview runs on the AppKit thread.
    window.with_webview(move |webview| unsafe {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let native = &*webview.ns_window().cast::<NSWindow>();
        if native.toolbar().is_none() {
            let toolbar = NSToolbar::new(mtm);
            native.setToolbar(Some(&toolbar));
        }
        let style = if height < COMPACT_MAX_HEIGHT {
            NSWindowToolbarStyle::UnifiedCompact
        } else {
            NSWindowToolbarStyle::Unified
        };
        if native.toolbarStyle() != style {
            native.setToolbarStyle(style);
        }
    })
}
