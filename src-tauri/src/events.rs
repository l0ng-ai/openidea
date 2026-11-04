use ide_core::{EventSink, IdeEvent};
use tauri::{AppHandle, Emitter, Manager};

/// Name of the single backend → UI event. Payload: [`IdeEvent`].
pub const IDE_EVENT: &str = "ide://event";

pub fn document_edit_peers(app: &AppHandle, source: &str) -> Vec<String> {
    let owner = crate::state::AppState::owner_window(source);
    app.webview_windows()
        .into_keys()
        .filter(|label| label != source && (label == owner || crate::windows::comparison_parent(label) == Some(owner)))
        .collect()
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

/// Forwards events to one window (`Some(label)`) or to all windows.
pub struct TauriSink {
    pub app: AppHandle,
    pub window: Option<String>,
}

impl EventSink for TauriSink {
    fn emit(&self, event: IdeEvent) {
        let result = match &self.window {
            Some(label) => {
                for target in self.app.webview_windows().keys() {
                    if crate::windows::comparison_parent(target) == Some(label.as_str()) {
                        let _ = self.app.emit_to(target.as_str(), IDE_EVENT, &event);
                    }
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
