//! Native maximize bounds for every Windows frameless window, including state restoration.

#[cfg(windows)]
pub use native::init;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

/// All coordinates are physical pixels in the selected monitor's coordinate space.
/// Auto-hide needs one exposed pixel, but an already reserved edge needs no extra inset.
fn bounds(monitor: Rect, work: Rect, auto_hide: [bool; 4], fullscreen: bool) -> Rect {
    if fullscreen {
        return monitor;
    }
    let [left, top, right, bottom] = auto_hide;
    Rect {
        left: work.left + i32::from(left && work.left == monitor.left),
        top: work.top + i32::from(top && work.top == monitor.top),
        right: work.right - i32::from(right && work.right == monitor.right),
        bottom: work.bottom - i32::from(bottom && work.bottom == monitor.bottom),
    }
}

fn maximize_geometry(monitor: Rect, area: Rect) -> (i32, i32, i32, i32) {
    (area.left - monitor.left, area.top - monitor.top, area.right - area.left, area.bottom - area.top)
}

#[cfg(windows)]
mod native {
    use super::{Rect, bounds, maximize_geometry};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{
            GetMonitorInfoW, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect, MonitorFromWindow,
        },
        UI::{
            Shell::{
                ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_GETAUTOHIDEBAREX, APPBARDATA, DefSubclassProc,
                RemoveWindowSubclass, SHAppBarMessage, SetWindowSubclass,
            },
            WindowsAndMessaging::{
                GWL_STYLE, GetWindowLongPtrW, IsZoomed, MINMAXINFO, NCCALCSIZE_PARAMS, WM_GETMINMAXINFO, WM_NCCALCSIZE,
                WM_NCDESTROY, WS_CAPTION,
            },
        },
    };

    const SUBCLASS: usize = 0x410;

    pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
        tauri::plugin::Builder::new("window-work-area")
            .on_window_ready(|window| {
                if window.is_decorated().unwrap_or(true) {
                    return;
                }
                let install = || -> tauri::Result<()> {
                    let hwnd = window.hwnd()?.0 as usize;
                    window.run_on_main_thread(move || {
                        // Subclasses must be installed and removed on the owning GUI thread.
                        if unsafe { SetWindowSubclass(hwnd as HWND, Some(window_proc), SUBCLASS, 0) } == 0 {
                            tracing::warn!(
                                "cannot install window work area handler: {}",
                                std::io::Error::last_os_error()
                            );
                        }
                    })
                };
                if let Err(error) = install() {
                    tracing::warn!("cannot install window work area handler: {error}");
                }
            })
            .build()
    }

    fn rect(rect: RECT) -> Rect {
        Rect { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }

    fn native_rect(rect: Rect) -> RECT {
        RECT { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }

    unsafe fn monitor_bounds(monitor: HMONITOR, fullscreen: bool) -> Option<(Rect, Rect)> {
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
            return None;
        }
        let mut auto_hide = [false; 4];
        if !fullscreen {
            for (index, edge) in [ABE_LEFT, ABE_TOP, ABE_RIGHT, ABE_BOTTOM].into_iter().enumerate() {
                let mut data = APPBARDATA {
                    cbSize: size_of::<APPBARDATA>() as u32,
                    uEdge: edge,
                    rc: info.rcMonitor,
                    ..Default::default()
                };
                auto_hide[index] = unsafe { SHAppBarMessage(ABM_GETAUTOHIDEBAREX, &mut data) } != 0;
            }
        }
        let monitor = rect(info.rcMonitor);
        Some((monitor, bounds(monitor, rect(info.rcWork), auto_hide, fullscreen)))
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        // Tao keeps WS_CAPTION on frameless windows and removes it for native fullscreen.
        // Read native styles here: a Tauri state query from its window procedure can deadlock.
        let fullscreen = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32 & WS_CAPTION == 0;
        match message {
            WM_GETMINMAXINFO if !fullscreen => {
                // Keep Tao's min/max tracking constraints, then set the outer maximize bounds.
                let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
                let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
                if let Some((monitor, area)) = unsafe { monitor_bounds(monitor, false) } {
                    let (x, y, width, height) = maximize_geometry(monitor, area);
                    let info = unsafe { &mut *(lparam as *mut MINMAXINFO) };
                    info.ptMaxPosition.x = x;
                    info.ptMaxPosition.y = y;
                    info.ptMaxSize.x = width;
                    info.ptMaxSize.y = height;
                }
                result
            }
            WM_NCCALCSIZE if wparam != 0 && (fullscreen || unsafe { IsZoomed(hwnd) } != 0) => {
                let params = unsafe { &mut *(lparam as *mut NCCALCSIZE_PARAMS) };
                // Use the proposed rectangle: a move/snap/DPI change can target another monitor.
                let monitor = unsafe { MonitorFromRect(&params.rgrc[0], MONITOR_DEFAULTTONEAREST) };
                if let Some((_, area)) = unsafe { monitor_bounds(monitor, fullscreen) } {
                    // Replace Tao's client-only clamp and global auto-hide query. Fullscreen
                    // must retain the entire display, even when entered from a maximized window.
                    params.rgrc[0] = native_rect(area);
                    0
                } else {
                    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
                }
            }
            WM_NCDESTROY => {
                unsafe { RemoveWindowSubclass(hwnd, Some(window_proc), SUBCLASS) };
                unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
            }
            _ => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect { left, top, right, bottom }
    }

    #[test]
    fn taskbars_on_every_edge_and_secondary_displays() {
        for (monitor, work, expected) in [
            // Reported case: maximized window must leave the bottom taskbar visible.
            (r(0, 0, 1920, 1080), r(0, 0, 1920, 1040), (0, 0, 1920, 1040)),
            (r(0, 0, 1920, 1080), r(48, 0, 1920, 1080), (48, 0, 1872, 1080)),
            (r(0, 0, 1920, 1080), r(0, 40, 1920, 1080), (0, 40, 1920, 1040)),
            (r(0, 0, 1920, 1080), r(0, 0, 1872, 1080), (0, 0, 1872, 1080)),
            // Negative origin, top taskbar, 150% display beside a 100% display.
            (r(-2560, -1440, 0, 0), r(-2560, -1380, 0, 0), (0, 60, 2560, 1380)),
            // 250% display: physical bounds must not be scaled with the previous monitor's DPI.
            (r(1920, 0, 5760, 2160), r(1920, 0, 5760, 2060), (0, 0, 3840, 2060)),
        ] {
            let area = bounds(monitor, work, [false; 4], false);
            assert_eq!(area, work);
            assert_eq!(maximize_geometry(monitor, area), expected);
        }
    }

    #[test]
    fn auto_hide_leaves_a_physical_pixel_only_on_its_own_monitor_edge() {
        let monitor = r(-1920, 0, 0, 1080);
        for (edges, expected) in [
            ([true, false, false, false], r(-1919, 0, 0, 1080)),
            ([false, true, false, false], r(-1920, 1, 0, 1080)),
            ([false, false, true, false], r(-1920, 0, -1, 1080)),
            ([false, false, false, true], r(-1920, 0, 0, 1079)),
            ([false; 4], monitor),
            ([true; 4], r(-1919, 1, -1, 1079)),
        ] {
            assert_eq!(bounds(monitor, monitor, edges, false), expected);
        }
        let reserved = r(-1920, 0, 0, 1040);
        assert_eq!(bounds(monitor, reserved, [false, false, false, true], false), reserved);
    }

    #[test]
    fn fullscreen_covers_taskbars_including_when_entered_from_maximized() {
        let monitor = r(1920, -100, 5760, 2060);
        let work = r(1980, -100, 5760, 1960);
        assert_eq!(bounds(monitor, work, [true; 4], true), monitor);
        assert_eq!(bounds(monitor, work, [false; 4], false), work);
    }
}
