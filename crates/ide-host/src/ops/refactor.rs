//! File move / rename refactoring: reference updates from the language
//! servers, the move itself (one undoable step) and its undo.
use crate::Host;
use crate::apply_workspace_edit;
use crate::rpc::Dispatcher;

use ide_core::{IdeResult, RequestId, WorkspaceEdit};
use ide_lsp::types::FileRenameEdits;
use ide_workspace::{FileMove, UndoOutcome};
use std::path::PathBuf;

use super::doc::blocking;

fn pairs(moves: &[FileMove]) -> Vec<(PathBuf, PathBuf)> {
    moves.iter().map(|m| (m.from.to_path_buf(), m.to.to_path_buf())).collect()
}

/// `workspace/willRenameFiles` on every interested server (before the move). Cancellable.
pub async fn refactor_file_move_edits(
    host: &Host,
    window: &str,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<FileRenameEdits> {
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let result = project.lsp.will_rename_files(&pairs(&moves), token).await;
    host.end_request(request);
    result
}

/// Applies `edit` (from [`refactor_file_move_edits`], possibly empty), moves the
/// files and notifies the servers. Returns the id for [`refactor_undo_file_move`].
pub async fn refactor_move_files(
    host: &Host,
    window: &str,
    moves: Vec<FileMove>,
    edit: WorkspaceEdit,
    label: String,
) -> IdeResult<u32> {
    let project = host.project(window)?;
    let p = project.clone();
    let moved = moves.clone();
    let id = blocking(move || {
        let apply = |e: &WorkspaceEdit| apply_workspace_edit(&p.documents, e);
        p.moves.perform(&p.documents, Some(&p.history), &moved, &edit, &label, &apply)
    })
    .await?;
    project.lsp.did_rename_files(&pairs(&moves));
    Ok(id)
}

/// Undoes a file move: moves back and reverts the reference updates.
pub async fn refactor_undo_file_move(host: &Host, window: &str, id: u32) -> IdeResult<UndoOutcome> {
    let project = host.project(window)?;
    let p = project.clone();
    let outcome = blocking(move || p.moves.undo(&p.documents, id)).await?;
    project.lsp.did_rename_files(&pairs(&outcome.moves));
    Ok(outcome)
}

/// Whether the file move `id` can still be undone.
pub fn refactor_can_undo_file_move(host: &Host, window: &str, id: u32) -> IdeResult<bool> {
    Ok(host.project(window)?.moves.can_undo(id))
}

/// "Search in comments and strings": textual occurrences of the moved files'
/// names, qualified names and paths (before the move). Cancellable.
pub async fn refactor_file_move_text_edits(
    host: &Host,
    window: &str,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<WorkspaceEdit> {
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let cancel = token.clone();
    let result = blocking(move || {
        let replacements = ide_workspace::text_refs::move_replacements(&project.root, &project.roots(), &moves);
        let edit = ide_workspace::text_refs::find_text_occurrences(
            &project.root,
            &project.exclude_globs(),
            &replacements,
            &|| cancel.is_cancelled(),
        );
        if cancel.is_cancelled() { Err(ide_core::IdeError::cancelled()) } else { Ok(edit) }
    })
    .await;
    host.end_request(request);
    result
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("refactor_file_move_edits", |c| async move {
        refactor_file_move_edits(&c.host, &c.window, c.arg("request")?, c.arg("moves")?).await
    });
    d.add("refactor_move_files", |c| async move {
        refactor_move_files(&c.host, &c.window, c.arg("moves")?, c.arg("edit")?, c.arg("label")?).await
    });
    d.add(
        "refactor_undo_file_move",
        |c| async move { refactor_undo_file_move(&c.host, &c.window, c.arg("id")?).await },
    );
    d.add(
        "refactor_can_undo_file_move",
        |c| async move { refactor_can_undo_file_move(&c.host, &c.window, c.arg("id")?) },
    );
    d.add("refactor_file_move_text_edits", |c| async move {
        refactor_file_move_text_edits(&c.host, &c.window, c.arg("request")?, c.arg("moves")?).await
    });
}
