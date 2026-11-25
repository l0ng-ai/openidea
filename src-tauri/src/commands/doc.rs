//! IPC commands of `ide_host::ops::doc` (the shared implementation).

use crate::state::AppState;
use ide_core::{ChangeSet, DocId, IdeResult};
use tauri::{Manager, Window};

/// Also mirrors the edit into the other windows showing the document.
pub(crate) async fn doc_edit(window: Window, doc: DocId, base_version: u32, changes: ChangeSet) -> IdeResult<u32> {
    let host = window.state::<AppState>().host.clone();
    let label = window.label().to_owned();
    let peers = crate::events::document_edit_peers(window.app_handle(), &label);
    let mirrored = (!peers.is_empty()).then(|| changes.changes.clone());
    let version = ide_host::ops::doc::doc_edit(&host, &label, doc, base_version, changes).await?;
    if let Some(changes) = mirrored {
        crate::events::emit_document_edit(window.app_handle(), peers, doc, base_version, version, changes);
    }
    Ok(version)
}
