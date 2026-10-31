//! Debounced application activation, shared by every project window.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{Emitter, Manager};

pub const DEACTIVATED: &str = "ide://application-deactivated";

#[derive(Default)]
pub struct ApplicationFocus {
    generation: AtomicU64,
    active: AtomicBool,
}

impl ApplicationFocus {
    fn changed(&self, focused: bool) -> u64 {
        if focused {
            self.active.store(true, Ordering::Relaxed);
        }
        self.generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn deactivate(&self, generation: u64, active: bool) -> bool {
        self.generation.load(Ordering::Relaxed) == generation && !active && self.active.swap(false, Ordering::Relaxed)
    }
}

pub fn changed(app: &tauri::AppHandle, focused: bool) {
    let generation = app.state::<ApplicationFocus>().changed(focused);
    if focused {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if handle.state::<ApplicationFocus>().deactivate(generation, application_active(&handle)) {
                let _ = handle.emit(DEACTIVATED, ());
            }
        });
    });
}

#[cfg(target_os = "macos")]
pub fn observe(app: &tauri::AppHandle) {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSApplicationDidBecomeActiveNotification, NSApplicationDidResignActiveNotification};
    use objc2_foundation::{NSNotificationCenter, NSObjectProtocol};
    thread_local! {
        static OBSERVERS: std::cell::RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    for (name, focused) in
        unsafe { [(NSApplicationDidBecomeActiveNotification, true), (NSApplicationDidResignActiveNotification, false)] }
    {
        let handle = app.clone();
        let block = block2::RcBlock::new(move |_| changed(&handle, focused));
        let observer = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(name),
                None,
                None,
                &block,
            )
        };
        OBSERVERS.with_borrow_mut(|observers| observers.push(observer));
    }
}

fn application_active(app: &tauri::AppHandle) -> bool {
    // A settings window, utility window or native dialog is still this application.
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let main = objc2::MainThreadMarker::new().expect("activation is checked on the main thread");
        objc2_app_kit::NSApplication::sharedApplication(main).isActive()
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        #[link(name = "user32")]
        unsafe extern "system" {
            fn GetForegroundWindow() -> *mut std::ffi::c_void;
            fn GetWindowThreadProcessId(window: *mut std::ffi::c_void, process: *mut u32) -> u32;
        }
        let mut process = 0;
        unsafe { GetWindowThreadProcessId(GetForegroundWindow(), &mut process) };
        process == std::process::id()
    }
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let _ = app;
        gtk::Window::list_toplevels().iter().any(|w| w.is_active())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    app.webview_windows().values().any(|w| w.is_focused().unwrap_or(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_and_dialog_focus_transfers_do_not_deactivate_the_application() {
        let state = ApplicationFocus::default();
        state.changed(true);
        let blur = state.changed(false);
        assert!(!state.deactivate(blur, true));
        state.changed(true);
        assert!(!state.deactivate(blur, false));
    }

    #[test]
    fn debounce_emits_once_for_an_external_application_and_skips_stale_checks() {
        let state = ApplicationFocus::default();
        state.changed(true);
        let stale = state.changed(false);
        let latest = state.changed(false);
        assert!(!state.deactivate(stale, false));
        assert!(state.deactivate(latest, false));
        assert!(!state.deactivate(latest, false));
        state.changed(true);
        let latest = state.changed(false);
        assert!(state.deactivate(latest, false));
    }
}
