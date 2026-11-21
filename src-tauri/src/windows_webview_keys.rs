//! WebView2's browser accelerator keys. A key the IDE keymap leaves alone otherwise reaches
//! WebView2, which runs its browser feature: Ctrl+F in a view without its own find opens the
//! page's Find bar over the whole window, F3 finds the next match there, Ctrl+P prints, F12 opens
//! DevTools. Turning them off leaves every key to the page; editing keys stay with the webview.

use tauri::{Webview, Wry, plugin};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
use windows::core::Interface;

pub fn init() -> plugin::TauriPlugin<Wry> {
    plugin::Builder::new("webview-keys").on_webview_ready(disable_browser_keys).build()
}

fn disable_browser_keys(webview: Webview) {
    let label = webview.label().to_owned();
    if let Err(error) = webview.with_webview(move |platform| {
        // SAFETY: with_webview runs on the controller's owning STA thread.
        let result = unsafe {
            platform
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false))
        };
        if let Err(error) = result {
            tracing::warn!(window = %label, %error, "cannot turn off WebView2 browser keys");
        }
    }) {
        tracing::warn!(window = webview.label(), %error, "cannot access WebView2 controller");
    }
}
