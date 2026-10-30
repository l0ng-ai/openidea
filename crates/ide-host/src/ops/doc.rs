use crate::Host;
use ide_core::{ChangeSet, DocId, IdeResult};
use ide_workspace::DocumentInfo;
use std::path::PathBuf;

pub async fn open(host: &Host, window: &str, path: PathBuf) -> IdeResult<DocumentInfo> {
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

pub fn close(host: &Host, window: &str, doc: DocId) -> IdeResult<()> {
    host.project(window)?.documents.close(doc);
    Ok(())
}

/// Applies a CodeMirror change set; returns the new version (`outOfSync` when `base_version` is stale).
pub fn edit(host: &Host, window: &str, doc: DocId, base_version: u32, changes: ChangeSet) -> IdeResult<u32> {
    host.project(window)?.documents.edit(doc, base_version, changes)
}

pub async fn save(host: &Host, window: &str, doc: DocId) -> IdeResult<()> {
    let project = host.project(window)?;
    host.blocking(move || project.documents.save(doc)).await?;
    host.debugger.refresh_source_mirrors(host.owner_window(window)).await
}

pub async fn save_all(host: &Host, window: &str) -> IdeResult<()> {
    let project = host.project(window)?;
    host.blocking(move || project.documents.save_all()).await?;
    host.debugger.refresh_source_mirrors(host.owner_window(window)).await
}

pub async fn snapshot(host: &Host, window: &str, doc: DocId) -> IdeResult<DocumentInfo> {
    let project = host.project(window)?;
    host.blocking(move || project.documents.snapshot(doc)).await
}

mod commands;
pub use commands::*;
