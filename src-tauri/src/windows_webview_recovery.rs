//! Native recovery for a WebView2 browser crash. The webview can no longer show its own UI.

use parking_lot::Mutex;
use std::collections::HashSet;
use tauri::{AppHandle, Manager, Webview, Wry, plugin};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED, ICoreWebView2,
        ICoreWebView2ProcessFailedEventArgs2,
    },
    ProcessFailedEventHandler,
};
use windows::core::Interface;

#[derive(Default)]
struct Recovery {
    announced_browsers: Mutex<HashSet<u32>>,
}

impl Recovery {
    fn announce(&self, browser_pid: u32) -> bool {
        self.announced_browsers.lock().insert(browser_pid)
    }
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
        let exit_code = args.cast::<ICoreWebView2ProcessFailedEventArgs2>().ok().and_then(|args| {
            let mut code = 0;
            // SAFETY: queried from the live callback arguments on this thread.
            unsafe { args.ExitCode(&mut code) }.ok().map(|()| code)
        });
        tracing::error!(window = %label, browser_pid, ?exit_code, "WebView2 browser process exited unexpectedly");
        // Dispatch from a worker so Wry queues the prompt instead of running it
        // inline inside WebView2's STA callback.
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let handle = app.clone();
            if let Err(error) = app.run_on_main_thread(move || show_recovery(handle)) {
                tracing::error!(%error, "cannot show WebView2 recovery prompt");
            }
        });
        Ok(())
    }));
    let mut token = 0;
    // SAFETY: the controller is live on this thread. WebView2 owns the handler until it closes.
    unsafe { core.add_ProcessFailed(&handler, &mut token) }
}

fn show_recovery(app: AppHandle) {
    let mut dialog = app
        .dialog()
        .message(
            "The Windows web engine stopped unexpectedly. Restart OpenIDEA to recover the interface. \
             This restarts all OpenIDEA windows. Unsaved edits may be lost.",
        )
        .title("OpenIDEA")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom("Restart OpenIDEA".into(), "Cancel".into()));
    if let Some(window) = crate::windows::target_window(&app).filter(|w| w.is_visible().unwrap_or(false)) {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |restart| {
        if restart {
            // The normal quit waits for a response from each webview. The failed browser
            // cannot answer, so restart through Tauri's native exit path.
            app.request_restart();
        }
    });
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
