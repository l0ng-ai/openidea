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
        let Some((position, rect_size)) = bounds.and_then(|b| resolve_bounds(b, size)) else {
            #[cfg(target_os = "linux")]
            gtk::prelude::WidgetExt::hide(&self.slot);
            return self.webview.hide().map_err(unavailable);
        };
        #[cfg(not(target_os = "linux"))]
        self.webview
            .set_bounds(tauri::Rect { position: position.into(), size: rect_size.into() })
            .map_err(unavailable)?;
        #[cfg(target_os = "linux")]
        {
            use gtk::prelude::*;
            let scale = window.scale_factor().map_err(unavailable)?;
            self.slot.set_margin_start((f64::from(position.x) / scale).round() as i32);
            self.slot.set_margin_top((f64::from(position.y) / scale).round() as i32);
            self.slot.set_size_request(
                (f64::from(rect_size.width) / scale).round() as i32,
                (f64::from(rect_size.height) / scale).round() as i32,
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

/// Maps CSS viewport coordinates to window physical pixels regardless of IDE zoom or engine `devicePixelRatio` semantics.
fn resolve_bounds(
    bounds: BrowserBounds,
    size: PhysicalSize<u32>,
) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    if size.width == 0
        || size.height == 0
        || !bounds.x.is_finite()
        || !bounds.y.is_finite()
        || !bounds.width.is_finite()
        || !bounds.height.is_finite()
        || !bounds.viewport_width.is_finite()
        || !bounds.viewport_height.is_finite()
        || bounds.viewport_width <= 0.0
        || bounds.viewport_height <= 0.0
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width <= 0.0
        || bounds.height <= 0.0
    {
        return None;
    }
    let scale_x = f64::from(size.width) / bounds.viewport_width;
    let scale_y = f64::from(size.height) / bounds.viewport_height;
    let left = (bounds.x * scale_x).round();
    let top = (bounds.y * scale_y).round();
    let right = ((bounds.x + bounds.width) * scale_x).round();
    let bottom = ((bounds.y + bounds.height) * scale_y).round();
    let max_width = f64::from(size.width.saturating_add(1));
    let max_height = f64::from(size.height.saturating_add(1));
    if left < 0.0 || top < 0.0 || right <= left || bottom <= top || right > max_width || bottom > max_height {
        return None;
    }
    let right = right.min(f64::from(size.width));
    let bottom = bottom.min(f64::from(size.height));
    if right <= left || bottom <= top {
        return None;
    }
    Some((
        PhysicalPosition::new(left as i32, top as i32),
        PhysicalSize::new((right - left) as u32, (bottom - top) as u32),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_css_bounds_with_ide_zoom_and_hidpi() {
        // 1440x900 logical @ 2x Retina = 2880x1800 physical; at 125% IDE zoom CSS viewport is 1152x720.
        let (pos, size) = resolve_bounds(
            BrowserBounds {
                x: 800.0,
                y: 80.0,
                width: 320.0,
                height: 400.0,
                viewport_width: 1152.0,
                viewport_height: 720.0,
            },
            PhysicalSize::new(2880, 1800),
        )
        .unwrap();
        assert_eq!(pos, PhysicalPosition::new(2000, 200));
        assert_eq!(size, PhysicalSize::new(800, 1000));
    }

    #[test]
    fn rejects_invalid_or_out_of_bounds_rects() {
        let win = PhysicalSize::new(2000, 1200);
        assert!(
            resolve_bounds(
                BrowserBounds {
                    x: -1.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                    viewport_width: 1000.0,
                    viewport_height: 600.0,
                },
                win,
            )
            .is_none()
        );
        assert!(
            resolve_bounds(
                BrowserBounds {
                    x: 950.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                    viewport_width: 1000.0,
                    viewport_height: 600.0,
                },
                win,
            )
            .is_none()
        );
        assert!(
            resolve_bounds(
                BrowserBounds {
                    x: 10.0,
                    y: 10.0,
                    width: 100.0,
                    height: 100.0,
                    viewport_width: 0.0,
                    viewport_height: 600.0,
                },
                win,
            )
            .is_none()
        );
        assert!(
            resolve_bounds(
                BrowserBounds {
                    x: f64::NAN,
                    y: 10.0,
                    width: 100.0,
                    height: 100.0,
                    viewport_width: 1000.0,
                    viewport_height: 600.0,
                },
                win,
            )
            .is_none()
        );
    }
}
