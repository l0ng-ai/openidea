//! Local History beyond single files: folders, labels, restoring deleted files.
use crate::Host;
use ide_command::command;

use ide_core::IdeResult;
use ide_workspace::DirectoryHistory;
use std::path::PathBuf;

use super::doc::blocking;

/// Show History on a folder: snapshots of the files under it (deleted ones included) and labels.
#[command(trust = always)]
pub async fn history_list_dir(host: &Host, window: &str, path: PathBuf) -> IdeResult<DirectoryHistory> {
    let project = host.project(window)?;
    blocking(move || project.history.list_dir(&path)).await
}

/// Local History › Put Label…: a named point in the history of every file.
#[command(trust = always)]
pub fn history_put_label(host: &Host, window: &str, label: String) -> IdeResult<()> {
    let project = host.project(window)?;
    project.history.put_label(&project.root, &label)
}

/// Revert to a snapshot: writes its content to `path` (re-creating a deleted
/// file and its folders); an open editor updates in place.
#[command(trust = always)]
pub async fn history_restore(host: &Host, window: &str, path: PathBuf, id: String) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || {
        let text = project.history.content(&id)?;
        if let Some(doc) = project.documents.by_path(&path) {
            project.documents.replace_all(doc, &text)?;
            return project.documents.save(doc);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if !path.exists() {
            ide_vfs::create_file(&path)?;
        }
        let doc = project.documents.open(&path)?.id;
        let result = project.documents.replace_all(doc, &text).and_then(|_| project.documents.save(doc));
        project.documents.close(doc);
        result
    })
    .await
}

ide_command::domain!(history: history_list_dir, history_put_label, history_restore);
