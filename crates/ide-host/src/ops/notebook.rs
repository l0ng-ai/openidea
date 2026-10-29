//! Native notebook operations shared by desktop IPC and the remote dispatcher.
use crate::Host;
pub use crate::notebook::NotebookOutputEvent;
use crate::ops::Channel;
use crate::rpc::Dispatcher;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_notebook::{NotebookEdit, NotebookSnapshot};
use std::path::PathBuf;

pub async fn open(host: &Host, window: &str, path: String) -> IdeResult<NotebookSnapshot> {
    let project = host.project(window)?;
    let path = PathBuf::from(path);
    let path = if path.is_absolute() { path } else { project.root.join(path) };
    let notebooks = project.notebooks.clone();
    host.blocking(move || notebooks.open(&path)).await
}

pub fn get(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    host.project(window)?.notebooks.get(&id)
}

pub async fn edit(
    host: &Host,
    window: &str,
    id: String,
    version: u32,
    edit: NotebookEdit,
) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    host.blocking(move || notebooks.edit(&id, version, edit)).await
}

pub async fn save(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    host.blocking(move || notebooks.save(&id)).await
}

pub async fn undo(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    host.blocking(move || notebooks.undo(&id, false)).await
}

pub async fn redo(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    host.blocking(move || notebooks.undo(&id, true)).await
}

pub async fn reload(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    // An abandoned IPC future must not leave a lifecycle transition half applied.
    tokio::spawn(async move { notebooks.reload(&id, false).await })
        .await
        .map_err(|error| IdeError::internal(error.to_string()))?
}

pub async fn restart(host: &Host, window: &str, id: String) -> IdeResult<NotebookSnapshot> {
    let notebooks = host.project(window)?.notebooks.clone();
    tokio::spawn(async move { notebooks.reload(&id, true).await })
        .await
        .map_err(|error| IdeError::internal(error.to_string()))?
}

pub async fn close(host: &Host, window: &str, id: String) -> IdeResult<()> {
    let notebooks = host.project(window)?.notebooks.clone();
    tokio::spawn(async move { notebooks.close(&id).await })
        .await
        .map_err(|error| IdeError::internal(error.to_string()))?
}

pub async fn interrupt(host: &Host, window: &str, id: String) -> IdeResult<()> {
    let notebooks = host.project(window)?.notebooks.clone();
    tokio::spawn(async move { notebooks.interrupt(&id).await })
        .await
        .map_err(|error| IdeError::internal(error.to_string()))?
}

#[allow(clippy::too_many_arguments)]
pub async fn execute(
    host: &Host,
    window: &str,
    id: String,
    cells: Vec<String>,
    python: Option<String>,
    request: RequestId,
    on_output: Channel<NotebookOutputEvent>,
) -> IdeResult<NotebookSnapshot> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
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

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("notebook_open", |c| async move { open(&c.host, &c.window, c.arg("path")?).await });
    d.add("notebook_get", |c| async move { get(&c.host, &c.window, c.arg("id")?) });
    d.add("notebook_edit", |c| async move {
        edit(&c.host, &c.window, c.arg("id")?, c.arg("version")?, c.arg("edit")?).await
    });
    d.add("notebook_save", |c| async move { save(&c.host, &c.window, c.arg("id")?).await });
    d.add("notebook_reload", |c| async move { reload(&c.host, &c.window, c.arg("id")?).await });
    d.add("notebook_undo", |c| async move { undo(&c.host, &c.window, c.arg("id")?).await });
    d.add("notebook_redo", |c| async move { redo(&c.host, &c.window, c.arg("id")?).await });
    d.add("notebook_close", |c| async move { close(&c.host, &c.window, c.arg("id")?).await });
    d.add("notebook_interrupt", |c| async move { interrupt(&c.host, &c.window, c.arg("id")?).await });
    d.add("notebook_restart", |c| async move { restart(&c.host, &c.window, c.arg("id")?).await });
    d.add("notebook_execute", |c| async move {
        execute(
            &c.host,
            &c.window,
            c.arg("id")?,
            c.arg("cells")?,
            c.arg("python")?,
            c.arg("request")?,
            c.sender("onOutput")?,
        )
        .await
    });
}
