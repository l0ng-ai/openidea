//! An unprivileged Tauri child webview. The workbench, not the guest, owns its controls.
mod guest;
mod snapshot;
use crate::state::AppState;
use ide_core::{CancellationToken, IdeError, IdeResult, RequestId};
use serde::{Deserialize, Serialize};
pub use snapshot::InspectedElement;
use snapshot::Selection;
use specta::Type;
use std::{
    cell::Cell,
    cell::RefCell,
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tauri::{Manager, Url, Window};
use tokio::sync::oneshot;

#[derive(Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BrowserAction {
    Navigate { url: String },
    Back,
    Forward,
    Reload,
    Inspect,
    Cancel,
    Layout { bounds: Option<BrowserBounds> },
    Status,
}

/// Physical pixels measured from the top left of the workbench webview.
#[derive(Clone, Copy, Deserialize, Type)]
pub struct BrowserBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    url: String,
    can_back: bool,
    can_forward: bool,
    inspecting: bool,
    element: Option<InspectedElement>,
}

fn local_url(value: &str) -> IdeResult<Url> {
    Url::parse(value)
        .ok()
        .filter(|u| {
            value.len() <= 4096
                && matches!(u.scheme(), "http" | "https")
                && u.username().is_empty()
                && u.password().is_none()
                && ide_host::ops::web::is_loopback(u)
        })
        .ok_or_else(|| IdeError::invalid("Enter a loopback HTTP or HTTPS URL without credentials"))
}

fn same_origin(origin: &Url, value: &str) -> bool {
    local_url(value).is_ok_and(|next| next.origin() == origin.origin())
}

const GUEST_PREFIX: &str = "browser-guest-";

pub(crate) fn is_guest(label: &str) -> bool {
    label.starts_with(GUEST_PREFIX)
}

#[derive(Default)]
struct Document {
    generation: AtomicU64,
    loaded: AtomicBool,
    armed: AtomicBool,
}

fn unavailable(e: impl std::fmt::Display) -> IdeError {
    IdeError::unavailable(format!("Browser: {e}"))
}

struct Panel {
    session: RequestId,
    cancel: CancellationToken,
    origin: Url,
    project: Arc<ide_host::Project>,
    view: guest::Surface,
    document: Arc<Document>,
}

thread_local! {
    // GTK, AppKit and WebView2 require these objects to be used and destroyed on the UI thread.
    static PANELS: RefCell<HashMap<String, Panel>> = RefCell::new(HashMap::new());
}

async fn on_ui<T: Send + 'static>(
    window: Window,
    f: impl FnOnce(&Window) -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    let (tx, rx) = oneshot::channel();
    let owner = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(f(&owner));
        })
        .map_err(unavailable)?;
    rx.await.map_err(unavailable)?
}

fn local_project(window: &Window) -> IdeResult<Arc<ide_host::Project>> {
    let state = window.state::<AppState>();
    if state.remote_dev.get(AppState::owner_window(window.label())).is_some() {
        return Err(IdeError::unavailable("The browser requires a trusted local project"));
    }
    let project = state.project(window.label())?;
    project.require_trust()?;
    Ok(project)
}

pub async fn open(window: Window, url: String, session: RequestId) -> IdeResult<()> {
    let origin = local_url(&url)?;
    let project = local_project(&window)?;
    let state = window.state::<AppState>();
    let cancel = state.begin_project_request(window.label(), session);
    let token = cancel.clone();
    let opened = on_ui(window.clone(), move |w| {
        if token.is_cancelled() || !Arc::ptr_eq(&project, &local_project(w)?) {
            return Err(IdeError::cancelled());
        }
        let document = Arc::new(Document::default());
        let builder = tauri::webview::WebviewBuilder::new(
            format!("{GUEST_PREFIX}{}-{}", w.label(), session.0),
            tauri::WebviewUrl::External(origin.clone()),
        )
        .incognito(true)
        .general_autofill_enabled(false)
        .devtools(false)
        .disable_drag_drop_handler()
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
        .initialization_script(include_str!("element.js"))
        .on_navigation({
            let origin = origin.clone();
            let token = token.clone();
            move |target| !token.is_cancelled() && same_origin(&origin, target.as_str())
        })
        .on_page_load({
            let doc = document.clone();
            let origin = origin.clone();
            let token = token.clone();
            move |_, payload| {
                let url = payload.url().as_str();
                if !same_origin(&origin, url) && !url.is_empty() && url != "about:blank" {
                    token.cancel();
                    return;
                }
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    doc.generation.fetch_add(1, Ordering::SeqCst);
                    doc.armed.store(false, Ordering::SeqCst);
                    doc.loaded.store(false, Ordering::SeqCst);
                } else if same_origin(&origin, url) {
                    doc.loaded.store(true, Ordering::SeqCst);
                }
            }
        });
        #[cfg(target_os = "macos")]
        let builder = builder.allow_link_preview(false);
        let view = guest::Surface::new(w, builder)?;
        let panel = Panel { session, cancel: token, origin, project, view, document };
        if let Some(old) = PANELS.with_borrow_mut(|panels| panels.insert(w.label().to_owned(), panel)) {
            old.cancel.cancel();
        }
        Ok(())
    })
    .await;
    if opened.is_err() {
        state.end_request(session);
        return opened;
    }
    let owner = window.clone();
    tauri::async_runtime::spawn(async move {
        cancel.cancelled().await;
        let result = on_ui(owner.clone(), move |w| {
            PANELS.with_borrow_mut(|p| {
                if p.get(w.label()).is_some_and(|v| v.session == session) {
                    p.remove(w.label());
                }
            });
            Ok(())
        })
        .await;
        if let Err(error) = result {
            tracing::debug!(?error, "browser owner closed");
        }
        owner.state::<AppState>().end_request(session);
    });
    Ok(())
}

pub fn forget(label: &str) {
    if let Some(panel) = PANELS.with_borrow_mut(|panels| panels.remove(label)) {
        panel.cancel.cancel();
    }
}

pub async fn control(window: Window, session: RequestId, action: BrowserAction) -> IdeResult<BrowserStatus> {
    let (mut status, selection, token, project, document, generation) = on_ui(window.clone(), move |w| {
        PANELS.with_borrow(|p| {
            let p = p
                .get(w.label())
                .filter(|p| p.session == session && !p.cancel.is_cancelled())
                .ok_or_else(IdeError::cancelled)?;
            if !Arc::ptr_eq(&p.project, &local_project(w)?) {
                return Err(IdeError::cancelled());
            }
            let view = &p.view.webview;
            let mut selection = None;
            // WKWebView has no URL before its first commit; don't ask Wry to unwrap it.
            let generation = p.document.generation.load(Ordering::SeqCst);
            let url = if p.document.loaded.load(Ordering::SeqCst) {
                view.url().map_err(unavailable)?.to_string()
            } else {
                String::new()
            };
            let local = same_origin(&p.origin, &url);
            if !local && !url.is_empty() && url != "about:blank" {
                p.cancel.cancel();
                return Err(IdeError::unavailable("Browser left the allowed local origin"));
            }
            match action {
                BrowserAction::Navigate { url } => {
                    if !same_origin(&p.origin, &url) {
                        return Err(IdeError::invalid("Close this page before opening another origin"));
                    }
                    view.navigate(local_url(&url)?).map_err(unavailable)?;
                }
                BrowserAction::Back => view.eval("history.back()").map_err(unavailable)?,
                BrowserAction::Forward => view.eval("history.forward()").map_err(unavailable)?,
                BrowserAction::Reload => view.reload().map_err(unavailable)?,
                BrowserAction::Layout { bounds } => p.view.layout(w, bounds)?,
                BrowserAction::Inspect | BrowserAction::Cancel => {
                    let arm = matches!(action, BrowserAction::Inspect);
                    if arm && !local {
                        return Err(IdeError::unavailable("The local page has not loaded"));
                    }
                    view.eval(if arm {
                        "window.__openideaInspect?.(true)"
                    } else {
                        "window.__openideaInspect?.(false)"
                    })
                    .map_err(unavailable)?;
                    p.document.armed.store(arm, Ordering::SeqCst);
                }
                BrowserAction::Status if local && p.document.armed.load(Ordering::SeqCst) => {
                    let (tx, rx) = oneshot::channel();
                    let reply = Cell::new(Some(tx));
                    // Read only the gesture-gated main-frame slot through this webview's callback.
                    // The page cannot invoke an IDE command or emit an IDE event.
                    view.eval_with_callback("window.__openideaPickedElement ?? null", move |value| {
                        if let Some(tx) = reply.take() {
                            let _ = tx.send(value);
                        }
                    })
                    .map_err(unavailable)?;
                    selection = Some(rx);
                }
                BrowserAction::Status => {}
            }
            let (can_back, can_forward) = p.view.history()?;
            let status = BrowserStatus {
                url: if local { url } else { p.origin.to_string() },
                can_back,
                can_forward,
                inspecting: p.document.armed.load(Ordering::SeqCst),
                element: None,
            };
            Ok((status, selection, p.cancel.clone(), p.project.clone(), p.document.clone(), generation))
        })
    })
    .await?;
    if let Some(rx) = selection {
        let value = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(IdeError::cancelled()),
            value = tokio::time::timeout(std::time::Duration::from_secs(3), rx) => value.map_err(unavailable)?.map_err(unavailable)?,
        };
        if token.is_cancelled() || !Arc::ptr_eq(&project, &local_project(&window)?) {
            return Err(IdeError::cancelled());
        }
        if document.generation.load(Ordering::SeqCst) != generation {
            status.inspecting = false;
            return Ok(status);
        }
        let json: Option<String> = serde_json::from_str(&value).map_err(unavailable)?;
        if let Some(json) = json {
            status.inspecting = false;
            document.armed.store(false, Ordering::SeqCst);
            if json == "cancel" {
                return Ok(status);
            }
            if json.len() > 8192 {
                return Err(IdeError::invalid("Element selection too large"));
            }
            status.element = Some(serde_json::from_str::<Selection>(&json).map_err(unavailable)?.preview()?);
        }
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pins_scheme_host_and_port_and_rejects_credentials() {
        let origin = local_url("http://127.0.0.1:3000/a?key=private").unwrap();
        assert!(same_origin(&origin, "http://127.0.0.1:3000/b#x"));
        assert!(local_url("http://localhost/").is_ok());
        assert!(local_url("https://[::1]/").is_ok());
        for remote in [
            "http://localhost.example.org",
            "http://0.0.0.0",
            "file:///tmp/test",
            "tauri://localhost",
            "http://user@localhost",
            "https://example.org",
        ] {
            assert!(local_url(remote).is_err(), "{remote}");
        }
        for target in
            ["http://127.0.0.1:3001", "http://localhost:3000", "https://127.0.0.1:3000", "http://u:p@127.0.0.1:3000"]
        {
            assert!(!same_origin(&origin, target), "{target}");
        }
    }
}
