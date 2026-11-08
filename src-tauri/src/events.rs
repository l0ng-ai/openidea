use ide_core::{EventSink, IdeEvent};
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};

/// Name of the single backend → UI event. Payload: [`IdeEvent`].
pub const IDE_EVENT: &str = "ide://event";

/// The other windows showing the documents of `source`'s project: its project window and the
/// auxiliary windows with documents. An edit made in one is not echoed by the backend, so they
/// get it as a patch ([`emit_document_edit`]).
pub fn document_edit_peers(app: &AppHandle, source: &str) -> Vec<String> {
    let owner = crate::state::AppState::owner_window(source);
    let mut peers = crate::windows::document_windows(app, owner);
    peers.push(owner.to_owned());
    peers.retain(|label| label != source);
    peers
}

pub fn emit_document_edit(
    app: &AppHandle,
    peers: Vec<String>,
    doc: ide_core::DocId,
    base_version: u32,
    version: u32,
    changes: Vec<ide_core::TextChange>,
) {
    let event = IdeEvent::DocPatched { doc, base_version, version, changes, workspace_edit: false };
    for label in peers {
        if let Err(e) = app.emit_to(label, IDE_EVENT, &event) {
            tracing::warn!("failed to mirror document edit: {e}");
        }
    }
}

/// Forwards events to one window (`Some(label)`, plus its auxiliary windows that show its
/// project's documents) or to all windows.
pub struct TauriSink {
    pub app: AppHandle,
    pub window: Option<String>,
}

/// A debug session stopped on a breakpoint: bounce/flash the taskbar icon
/// (IDEA) unless the user is already looking at an OpenIDEA window. The focus
/// check and the request both touch the windowing system, so they run on the
/// main thread; `emit` itself can come from any debug worker thread.
fn flash_taskbar_unless_focused(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if crate::application_focus::application_active(&handle) {
            return;
        }
        for window in handle.webview_windows().values() {
            let _ = window.request_user_attention(Some(UserAttentionType::Informational));
        }
    });
}

impl EventSink for TauriSink {
    fn emit(&self, event: IdeEvent) {
        if matches!(
            &event,
            IdeEvent::Debug { event: ide_core::event::DebugEvent::Stopped { reason, .. }, .. }
            if matches!(reason.as_str(), "breakpoint" | "function breakpoint")
        ) {
            flash_taskbar_unless_focused(&self.app);
        }
        if matches!(&event, IdeEvent::McpRequest { .. })
            && let Some(label) = self.window.clone()
        {
            let app = self.app.clone();
            let _ = self.app.run_on_main_thread(move || {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
        }
        let result = match &self.window {
            Some(label) => {
                for target in crate::windows::document_windows(&self.app, label)
                    .into_iter()
                    .filter(|_| !matches!(&event, IdeEvent::McpRequest { .. } | IdeEvent::McpRequestClosed { .. }))
                {
                    let _ = self.app.emit_to(target.as_str(), IDE_EVENT, &event);
                }
                self.app.emit_to(label.as_str(), IDE_EVENT, &event)
            }
            None => self.app.emit(IDE_EVENT, &event),
        };
        if let Err(e) = result {
            tracing::warn!("failed to emit ide event: {e}");
        }
    }
}
