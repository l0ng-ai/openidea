//! Tauri owns both views. Only the workbench webview has the application's capability.
use super::{BrowserBounds, unavailable};
use ide_core::IdeResult;
use tauri::{PhysicalPosition, PhysicalSize, Webview, Window};

pub(super) struct Surface {
    pub webview: Webview,
    #[cfg(target_os = "linux")]
    slot: gtk::Box,
}

impl Surface {
    pub fn new(window: &Window, builder: tauri::webview::WebviewBuilder<tauri::Wry>) -> IdeResult<Self> {
        let webview =
            window.add_child(builder, PhysicalPosition::new(0, 0), PhysicalSize::new(1, 1)).map_err(unavailable)?;
        let init = || -> IdeResult<Self> {
            webview.hide().map_err(unavailable)?;
            // On GTK add_child packs siblings in a vertical box: give the guest a positioned
            // overlay instead, on Wayland as well as X11. Never replace the workbench widget.
            #[cfg(target_os = "linux")]
            let slot = {
                use gtk::prelude::*;
                let win = window.gtk_window().map_err(unavailable)?;
                let root = win.child().ok_or_else(|| unavailable("missing workbench widget"))?;
                let overlay = if let Some(existing) = root.downcast_ref::<gtk::Overlay>() {
                    existing.clone()
                } else {
                    let overlay = gtk::Overlay::new();
                    win.remove(&root);
                    overlay.add(&root);
                    win.add(&overlay);
                    overlay.show();
                    overlay
                };
                let slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
                slot.set_halign(gtk::Align::Start);
                slot.set_valign(gtk::Align::Start);
                // with_webview runs immediately on the UI thread. Keep GTK objects there.
                let (tx, rx) = std::sync::mpsc::sync_channel(1);
                let weak: gtk::glib::SendWeakRef<gtk::Box> = slot.downgrade().into();
                webview
                    .with_webview(move |native| {
                        let result = (|| -> IdeResult<()> {
                            let widget = native.inner();
                            let parent = widget
                                .parent()
                                .and_then(|p| p.downcast::<gtk::Container>().ok())
                                .ok_or_else(|| unavailable("missing guest container"))?;
                            let slot = weak.upgrade().ok_or_else(|| unavailable("missing guest slot"))?;
                            parent.remove(&widget);
                            slot.add(&widget);
                            Ok(())
                        })();
                        let _ = tx.send(result);
                    })
                    .map_err(unavailable)?;
                rx.recv().map_err(unavailable)??;
                overlay.add_overlay(&slot);
                slot
            };
            Ok(Self {
                webview: webview.clone(),
                #[cfg(target_os = "linux")]
                slot,
            })
        };
        let result = init();
        if result.is_err() {
            webview.close().map_err(unavailable)?;
        }
        result
    }

    pub fn layout(&self, window: &Window, bounds: Option<BrowserBounds>) -> IdeResult<()> {
        let size = window.inner_size().map_err(unavailable)?;
        let Some(b) = bounds.filter(|b| {
            b.x >= 0
                && b.y >= 0
                && b.width > 0
                && b.height > 0
                && (b.x as u32).saturating_add(b.width) <= size.width.saturating_add(1)
                && (b.y as u32).saturating_add(b.height) <= size.height.saturating_add(1)
        }) else {
            #[cfg(target_os = "linux")]
            gtk::prelude::WidgetExt::hide(&self.slot);
            return self.webview.hide().map_err(unavailable);
        };
        #[cfg(not(target_os = "linux"))]
        self.webview
            .set_bounds(tauri::Rect {
                position: PhysicalPosition::new(b.x, b.y).into(),
                size: PhysicalSize::new(b.width, b.height).into(),
            })
            .map_err(unavailable)?;
        #[cfg(target_os = "linux")]
        {
            use gtk::prelude::*;
            let scale = window.scale_factor().map_err(unavailable)?;
            self.slot.set_margin_start((f64::from(b.x) / scale).round() as i32);
            self.slot.set_margin_top((f64::from(b.y) / scale).round() as i32);
            self.slot.set_size_request(
                (f64::from(b.width) / scale).round() as i32,
                (f64::from(b.height) / scale).round() as i32,
            );
            self.slot.show();
        }
        self.webview.show().map_err(unavailable)
    }

    pub fn history(&self) -> IdeResult<(bool, bool)> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        self.webview
            .with_webview(move |native| {
                #[cfg(target_os = "macos")]
                // SAFETY: Tauri lends the WKWebView on its UI thread for this callback.
                let result = unsafe {
                    let view = &*native.inner().cast::<objc2_web_kit::WKWebView>();
                    Ok((view.canGoBack(), view.canGoForward()))
                };
                #[cfg(windows)]
                let result = (|| unsafe {
                    let view = native.controller().CoreWebView2()?;
                    let (mut back, mut forward) = (windows::core::BOOL::default(), windows::core::BOOL::default());
                    view.CanGoBack(&mut back)?;
                    view.CanGoForward(&mut forward)?;
                    windows::core::Result::Ok((back.as_bool(), forward.as_bool()))
                })()
                .map_err(unavailable);
                #[cfg(target_os = "linux")]
                let result = {
                    use webkit2gtk::WebViewExt;
                    let view = native.inner();
                    Ok((view.can_go_back(), view.can_go_forward()))
                };
                let _ = tx.send(result);
            })
            .map_err(unavailable)?;
        rx.recv().map_err(unavailable)?
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        if let Err(error) = self.webview.close() {
            tracing::debug!(%error, "browser child already closed");
        }
        #[cfg(target_os = "linux")]
        {
            use gtk::prelude::*;
            if let Some(parent) = self.slot.parent().and_then(|w| w.downcast::<gtk::Overlay>().ok()) {
                parent.remove(&self.slot);
            }
        }
    }
}
