use ide_core::{EventSink, IdeEvent};
use tauri::{AppHandle, Emitter};

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

impl EventSink for TauriSink {
    fn emit(&self, event: IdeEvent) {
        let result = match &self.window {
            Some(label) => {
                for target in crate::windows::document_windows(&self.app, label) {
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
