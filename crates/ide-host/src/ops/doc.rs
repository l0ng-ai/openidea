use crate::Host;
use ide_command::command;
use ide_core::{ChangeSet, DocId, IdeResult};
use ide_workspace::DocumentInfo;
use std::path::PathBuf;

/// Opens a document. Async: reading and decoding a large file must not block
/// the main thread (synchronous commands run on it).
#[command(trust = always)]
pub async fn doc_open(host: &Host, window: &str, path: PathBuf) -> IdeResult<DocumentInfo> {
    let project = host.project(window)?;
    host.blocking(move || {
        let info = project.documents.open(&path)?;
        project.index.mark_recent(&path);
        if let Some(dir) = path.parent().filter(|_| project.light) {
            project.watch_light_dir(dir);
        }
        Ok(info)
    })
    .await
}

#[command(trust = always)]
pub async fn doc_close(host: &Host, window: &str, doc: DocId) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || {
        project.documents.close(doc);
        Ok(())
    })
    .await
}

/// Opens an editable untitled buffer (a new-file tab); it reaches the disk
/// through `doc_save_as`, which turns it into a regular file document.
#[command(trust = always)]
pub async fn doc_open_untitled(host: &Host, window: &str, name: Option<String>) -> IdeResult<DocumentInfo> {
    // `name` re-references an already minted buffer instead of creating one.
    let project = host.project(window)?;
    host.blocking(move || project.documents.open_untitled(name.as_deref())).await
}

/// Save As for an untitled buffer: writes it to `path` and re-keys the buffer
/// (undo history and version are kept; the language is re-detected).
#[command(trust = always)]
pub async fn doc_save_as(host: &Host, window: &str, doc: DocId, path: PathBuf) -> IdeResult<DocumentInfo> {
    // LightEdit windows start watching the saved file's folder.
    let project = host.project(window)?;
    host.blocking(move || {
        let info = project.documents.save_as(doc, &path)?;
        if let Some(dir) = path.parent().filter(|_| project.light) {
            project.watch_light_dir(dir);
        }
        Ok(info)
    })
    .await
}

/// Applies a CodeMirror change set; returns the new version. Rejects with
/// `outOfSync` when `base_version` is stale; the UI then calls `doc_snapshot`.
#[command(trust = always, desktop_body = async)]
pub async fn doc_edit(host: &Host, window: &str, doc: DocId, base_version: u32, changes: ChangeSet) -> IdeResult<u32> {
    let project = host.project(window)?;
    blocking(move || project.documents.edit(doc, base_version, changes)).await
}

#[command(trust = always)]
pub async fn doc_save(host: &Host, window: &str, doc: DocId) -> IdeResult<()> {
    let project = host.project(window)?;
    host.blocking(move || project.documents.save(doc)).await?;
    host.debugger.refresh_source_mirrors(host.owner_window(window)).await
}

/// Load Changes from Disk: discards the buffer's unsaved changes and reads its file again.
#[command(trust = always)]
pub async fn doc_reload_from_disk(host: &Host, window: &str, doc: DocId) -> IdeResult<()> {
    let project = host.project(window)?;
    host.blocking(move || project.documents.discard_and_reload(doc)).await
}

/// An automatic save: `false` (nothing written) when the file changed on disk after the
/// buffer was edited, which only an explicit save overwrites.
#[command(trust = always)]
pub async fn doc_autosave(host: &Host, window: &str, doc: DocId) -> IdeResult<bool> {
    let project = host.project(window)?;
    let saved = host.blocking(move || project.documents.autosave(doc)).await?;
    if saved {
        host.debugger.refresh_source_mirrors(host.owner_window(window)).await?;
    }
    Ok(saved)
}

#[command(trust = always)]
pub async fn doc_save_all(host: &Host, window: &str) -> IdeResult<()> {
    let project = host.project(window)?;
    host.blocking(move || project.documents.save_all()).await?;
    host.debugger.refresh_source_mirrors(host.owner_window(window)).await
}

#[command(trust = always)]
pub async fn doc_sync_from_disk(host: &Host, window: &str) -> IdeResult<()> {
    // Recovers external changes missed by the project's file watchers.
    let project = host.project(window)?;
    host.blocking(move || {
        if project.settings.effective().files.sync_on_focus {
            project.documents.sync_from_disk();
        }
        Ok(())
    })
    .await
}

#[command(trust = always)]
pub async fn doc_snapshot(host: &Host, window: &str, doc: DocId) -> IdeResult<DocumentInfo> {
    let project = host.project(window)?;
    host.blocking(move || project.documents.snapshot(doc)).await
}

pub mod commands;
pub use commands::*;

#[cfg(test)]
mod tests;

ide_command::domain!(
    doc:
    doc_close,
    doc_edit,
    doc_open,
    doc_open_untitled,
    doc_reload_from_disk,
    doc_save,
    doc_autosave,
    doc_save_all,
    doc_save_as,
    doc_snapshot,
    doc_sync_from_disk,
);
