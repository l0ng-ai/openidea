//! Local History beyond single files: folders, labels, restoring deleted files.
use crate::Host;
use crate::rpc::Dispatcher;

use ide_core::IdeResult;
use ide_workspace::DirectoryHistory;
use std::path::PathBuf;

use super::doc::blocking;

/// Show History on a folder: snapshots of the files under it (deleted ones included) and labels.
pub async fn history_list_dir(host: &Host, window: &str, path: PathBuf) -> IdeResult<DirectoryHistory> {
    let project = host.project(window)?;
    blocking(move || project.history.list_dir(&path)).await
}

/// Local History › Put Label…: a named point in the history of every file.
pub fn history_put_label(host: &Host, window: &str, label: String) -> IdeResult<()> {
    let project = host.project(window)?;
    project.history.put_label(&project.root, &label)
}

/// Revert to a snapshot: writes its content to `path` (re-creating a deleted
/// file and its folders); an open editor updates in place.
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

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("history_list_dir", |c| async move { history_list_dir(&c.host, &c.window, c.arg("path")?).await });
    d.add("history_put_label", |c| async move { history_put_label(&c.host, &c.window, c.arg("label")?) });
    d.add(
        "history_restore",
        |c| async move { history_restore(&c.host, &c.window, c.arg("path")?, c.arg("id")?).await },
    );
}
