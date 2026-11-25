//! Native recovery for a WebView2 browser crash. The webview can no longer show its own UI:
//! not the prompt, not the title bar's close button (the window draws its own), and it never
//! answers a close request. So the prompt is a native message box on its own thread, and the
//! windows close without asking the page.

use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview, Wry, plugin};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_REASON, ICoreWebView2, ICoreWebView2ProcessFailedEventArgs2,
    },
    ProcessFailedEventHandler,
};
use windows::core::Interface;

/// How long Restart waits for the event loop to restart the app before restarting the process
/// itself (a main thread stuck in a call to the dead browser never handles the request).
const RESTART_GRACE: Duration = Duration::from_secs(10);

#[derive(Default)]
struct Recovery {
    announced_browsers: Mutex<HashSet<u32>>,
    /// A browser process exited: the pages can't answer close requests any more.
    failed: AtomicBool,
}

impl Recovery {
    fn announce(&self, browser_pid: u32) -> bool {
        self.failed.store(true, Ordering::SeqCst);
        self.announced_browsers.lock().insert(browser_pid)
    }
}

/// Whether the web engine has failed, so a window must close without asking its page.
pub fn browser_failed(app: &AppHandle) -> bool {
    app.try_state::<Recovery>().is_some_and(|r| r.failed.load(Ordering::SeqCst))
}

pub fn init() -> plugin::TauriPlugin<Wry> {
    plugin::Builder::new("webview-recovery")
        .setup(|app, _| {
            app.manage(Recovery::default());
            Ok(())
        })
        .on_webview_ready(install)
        .build()
}

fn install(webview: Webview) {
    let app = webview.app_handle().clone();
    let label = webview.label().to_owned();
    if let Err(error) = webview.with_webview(move |platform| {
        // SAFETY: with_webview runs on the controller's owning STA thread.
        let result = unsafe { platform.controller().CoreWebView2() }.and_then(|core| listen(&core, app, label.clone()));
        if let Err(error) = result {
            tracing::warn!(window = %label, %error, "cannot monitor WebView2 browser failures");
        }
    }) {
        tracing::warn!(window = webview.label(), %error, "cannot access WebView2 controller");
    }
}

fn listen(core: &ICoreWebView2, app: AppHandle, label: String) -> windows::core::Result<()> {
    let mut browser_pid = 0;
    // SAFETY: the controller is live and this runs on its owning thread.
    unsafe { core.BrowserProcessId(&mut browser_pid)? };
    let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        // SAFETY: callback arguments are live and used on the controller's thread.
        unsafe { args.ProcessFailedKind(&mut kind)? };
        if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
            || !app.state::<Recovery>().announce(browser_pid)
        {
            return Ok(());
        }
        let details = args.cast::<ICoreWebView2ProcessFailedEventArgs2>().ok();
        // SAFETY (all three): queried from the live callback arguments on this thread.
        let exit_code = details.as_ref().and_then(|args| {
            let mut code = 0;
            unsafe { args.ExitCode(&mut code) }.ok().map(|()| code)
        });
        let reason = details.as_ref().and_then(|args| {
            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
            unsafe { args.Reason(&mut reason) }.ok().map(|()| reason.0)
        });
        let description = details.as_ref().and_then(|args| {
            let mut description = Default::default();
            unsafe { args.ProcessDescription(&mut description) }.ok().map(|()| webview2_com::take_pwstr(description))
        });
        tracing::error!(
            window = %label,
            browser_pid,
            ?exit_code,
            ?reason,
            ?description,
            "WebView2 browser process exited unexpectedly"
        );
        // Not through the main thread: it may be stuck in a call to the dead browser, and the
        // prompt must not run inline inside WebView2's STA callback either.
        let app = app.clone();
        if let Err(error) = std::thread::Builder::new().name("webview-recovery".into()).spawn(move || {
            if ask_restart() {
                restart(&app);
            }
        }) {
            tracing::error!(%error, "cannot show WebView2 recovery prompt");
        }
        Ok(())
    }));
    let mut token = 0;
    // SAFETY: the controller is live on this thread. WebView2 owns the handler until it closes.
    unsafe { core.add_ProcessFailed(&handler, &mut token) }
}

/// A native message box, on top of every window: true for Restart (OK).
fn ask_restart() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IDOK, MB_ICONERROR, MB_OKCANCEL, MB_SETFOREGROUND, MB_TOPMOST, MessageBoxW,
    };
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let text = wide(
        "The Windows web engine stopped unexpectedly, so OpenIDEA's windows can no longer respond.\n\n\
         Choose OK to restart OpenIDEA and recover the interface. This restarts all OpenIDEA windows; \
         unsaved edits may be lost.",
    );
    let title = wide("OpenIDEA");
    // SAFETY: both strings are NUL-terminated and outlive the call; no owner window.
    let answer = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OKCANCEL | MB_ICONERROR | MB_TOPMOST | MB_SETFOREGROUND,
        )
    };
    answer == IDOK
}

fn restart(app: &AppHandle) {
    // The normal quit waits for a response from each webview. The failed browser cannot
    // answer, so restart through Tauri's native exit path.
    app.request_restart();
    std::thread::sleep(RESTART_GRACE);
    tracing::error!("the event loop did not restart OpenIDEA; restarting the process");
    tauri::process::restart(&app.env());
}

#[cfg(test)]
mod tests {
    use super::Recovery;

    #[test]
    fn only_one_prompt_for_windows_sharing_a_failed_browser() {
        let recovery = Recovery::default();
        assert!(recovery.announce(100));
        assert!(!recovery.announce(100));
        assert!(recovery.announce(200));
        assert!(!recovery.announce(100));
        assert!(!recovery.announce(200));
    }
}
