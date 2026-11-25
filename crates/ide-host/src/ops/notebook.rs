//! Native notebook operations shared by desktop IPC and the remote dispatcher.
use crate::Host;
pub use crate::notebook::NotebookOutputEvent;
use crate::ops::Channel;
use ide_command::command;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_notebook::{NotebookEdit, NotebookSnapshot};
use std::path::PathBuf;

#[command(trust = always)]
pub async fn notebook_open(host: &Host, window: &str, path: String) -> IdeResult<NotebookSnapshot> {
    let project = host.project(window)?;
    let path = PathBuf::from(path);
    let path = if path.is_absolute() { path } else { project.root.join(path) };
    let notebooks = project.notebooks.clone();
    host.blocking(move || notebooks.open(&path)).await
}

#[command(trust = always)]
pub fn notebook_get(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    host.project(window)?.notebooks.get(&id)
}

#[command(trust = trusted)]
pub fn notebook_cell_docs(host: &Host, window: &str, id: String) -> IdeResult<Vec<ide_lsp::NotebookCellDoc>> {
    // The language-server documents of the notebook's code cells (empty when no server syncs notebooks).
    let project = host.project(window)?;
    let path = project.notebooks.path_of(&id)?;
    Ok(project.lsp.notebook_cells(&path))
}

#[command(trust = always)]
pub async fn notebook_edit(
    host: &Host,
    window: &str,
    id: String,
    version: u32,
    edit: NotebookEdit,
) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    host.blocking(move || notebooks.edit(&id, version, edit)).await
}

#[command(trust = always)]
pub async fn notebook_save(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    host.blocking(move || notebooks.save(&id)).await
}

#[command(trust = always)]
pub async fn notebook_undo(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    host.blocking(move || notebooks.undo(&id, false)).await
}

#[command(trust = always)]
pub async fn notebook_redo(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    host.blocking(move || notebooks.undo(&id, true)).await
}

#[command(trust = always)]
pub async fn notebook_reload(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    // An abandoned IPC future must not leave a lifecycle transition half applied.
    tokio::spawn(async move { notebooks.reload(&id, false).await })
        .await
        .map_err(|error| IdeError::internal(error.to_string()))?
}

#[command(trust = trusted)]
pub async fn notebook_restart(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    host.require_trust(window)?;
    let notebooks = host.project(window)?.notebooks.clone();
    tokio::spawn(async move { notebooks.reload(&id, true).await })
        .await
        .map_err(|error| IdeError::internal(error.to_string()))?
}

#[command(trust = always)]
pub async fn notebook_close(host: &Host, window: &str, id: String) -> IdeResult<()> {
    let notebooks = host.project(window)?.notebooks.clone();
    tokio::spawn(async move { notebooks.close(&id).await })
        .await
        .map_err(|error| IdeError::internal(error.to_string()))?
}

#[command(trust = always)]
pub async fn notebook_interrupt(host: &Host, window: &str, id: String) -> IdeResult<()> {
    let notebooks = host.project(window)?.notebooks.clone();
    tokio::spawn(async move { notebooks.interrupt(&id).await })
        .await
        .map_err(|error| IdeError::internal(error.to_string()))?
}

#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn notebook_execute(
    host: &Host,
    window: &str,
    id: String,
    cells: Vec<String>,
    python: Option<String>,
    request: RequestId,
    on_output: Channel<NotebookOutputEvent>,
) -> IdeResult<NotebookSnapshot> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let cancel = host.begin_project_request(window, request);
    let _request = RequestGuard { host, request, cancel: cancel.clone() };
    // Reserve the WHOLE batch and capture source before asynchronous discovery.
    let admission = project.notebooks.admit(&id, cells, cancel.clone())?;
    let selected = match python {
        Some(path) if path.trim().is_empty() => return Err(IdeError::invalid("select a Python interpreter")),
        Some(path) => PathBuf::from(path),
        None => {
            let root = project.root.clone();
            let settings = project.settings.effective();
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(IdeError::cancelled()),
                result = host.blocking(move || {
                    ide_sdk::apply::python_interpreter(&root, &settings)
                        .or_else(|| ide_sdk::detect(ide_sdk::SdkKind::Python, Some(&root))
                            .into_iter().next().map(|sdk| sdk.path.into_path_buf()))
                        .ok_or_else(|| IdeError::unavailable("select a Python environment with ipykernel installed"))
                }) => result?,
            }
        }
    };
    // Do not canonicalize this path: resolving a venv symlink to base Python
    // changes sys.prefix and executes in the wrong environment.
    let python = if selected.is_absolute() { selected } else { project.root.join(selected) };
    project.notebooks.execute(admission, python, on_output).await
}

struct RequestGuard<'a> {
    host: &'a Host,
    request: RequestId,
    cancel: ide_core::CancellationToken,
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        // If the invocation is dropped, the owned batch still receives cancellation.
        self.cancel.cancel();
        self.host.end_request(self.request);
    }
}

ide_command::domain!(
    notebook:
    notebook_cell_docs,
    notebook_close,
    notebook_edit,
    notebook_execute,
    notebook_get,
    notebook_interrupt,
    notebook_open,
    notebook_redo,
    notebook_reload,
    notebook_restart,
    notebook_save,
    notebook_undo,
);
