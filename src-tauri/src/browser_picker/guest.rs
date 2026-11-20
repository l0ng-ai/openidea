//! The unprivileged guest has no access to the workbench's Tauri commands or custom protocols.
use wry::{NewWindowResponse, PermissionResponse, WebViewBuilder};

pub(super) enum Signal {
    Picked,
    Cancel,
}

pub(super) fn builder(
    url: &str,
    allow_navigation: impl Fn(String) -> bool + 'static,
    signal: impl Fn(Signal) + 'static,
) -> WebViewBuilder<'static> {
    WebViewBuilder::new()
        .with_incognito(true)
        .with_devtools(false)
        .with_autoplay(false)
        .with_clipboard(false)
        .with_drag_drop_handler(|_| true)
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_download_started_handler(|_, _| false)
        .with_permission_handler(|_| PermissionResponse::Deny)
        .with_navigation_handler(allow_navigation)
        .with_initialization_script(include_str!("element.js"))
        // A guest signal can only wake or dismiss the picker. The native owner pulls the
        // captured data separately from the main frame, checks it and displays it for review.
        .with_ipc_handler(move |request| match request.body().as_str() {
            "picked" => signal(Signal::Picked),
            "cancel" => signal(Signal::Cancel),
            _ => {}
        })
        .with_url(url)
}
