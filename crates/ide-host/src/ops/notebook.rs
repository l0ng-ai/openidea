//! Native notebook operations shared by desktop IPC and the remote dispatcher.
use crate::Host;
pub use crate::notebook::NotebookOutputEvent;
use crate::ops::Channel;
use ide_command::command;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_notebook::kernel::{KernelSpec, KernelTarget, RemoteKernel, kernel_specs, normalize_server_url};
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

#[command(trust = trusted)]
pub async fn notebook_variables(
    host: &Host,
    window: &str,
    id: String,
) -> IdeResult<Option<Vec<crate::notebook::NotebookVariable>>> {
    let notebooks = host.project(window)?.notebooks.clone();
    tokio::spawn(async move { notebooks.variables(&id).await })
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
    let target = kernel_target(host, &project, python, &cancel).await?;
    project.notebooks.execute(admission, target, on_output).await
}

/// The kernel the notebook's drop-down chose: an interpreter (the project's when `None`) or
/// `<server>#<kernel spec>` of a saved Jupyter server.
async fn kernel_target(
    host: &Host,
    project: &crate::Project,
    python: Option<String>,
    cancel: &ide_core::CancellationToken,
) -> IdeResult<KernelTarget> {
    let selected = match python {
        Some(path) if path.trim().is_empty() => return Err(IdeError::invalid("select a Python interpreter")),
        Some(kernel) if kernel.starts_with("http://") || kernel.starts_with("https://") => {
            return Ok(KernelTarget::Remote(remote_kernel(host, &kernel)?));
        }
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
    Ok(KernelTarget::Local(if selected.is_absolute() { selected } else { project.root.join(selected) }))
}

/// Debug Cell: a debug session named `name` on the notebook's kernel, starting the kernel
/// when none runs. The caller then runs the cell; ending the session leaves the kernel and
/// its state running.
#[command(trust = trusted)]
pub async fn notebook_debug_start(
    host: &Host,
    window: &str,
    id: String,
    python: Option<String>,
    name: String,
    just_my_code: bool,
) -> IdeResult<ide_core::DebugSessionId> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let cancel = project.closed.child_token();
    let target = kernel_target(host, &project, python, &cancel).await?;
    let (debugger, cells, notebook_cells) = project.notebooks.debugger(&id, target, cancel).await?;
    let (reader, writer) = tokio::io::split(ide_notebook::kernel::debug::dap_stream(debugger, cells));
    let io = ide_dap::adapter::AdapterIo {
        launch_after_configuration: false,
        reader: Box::new(reader),
        writer: Box::new(writer),
        child: None,
        port: None,
        stderr: Default::default(),
        program_output: None,
    };
    let owner = ide_dap::SessionOwner::new(host.owner_window(window), host.window_sink(window));
    let arguments = serde_json::json!({ "justMyCode": just_my_code });
    host.debugger.start_over(io, name, ide_dap::NOTEBOOK_ADAPTER.into(), arguments, owner, Some(notebook_cells)).await
}

/// A kernel choice on a Jupyter server, `<server base URL>#<kernel spec>`, with its saved token.
fn remote_kernel(host: &Host, choice: &str) -> IdeResult<RemoteKernel> {
    let (base, spec) = choice
        .split_once('#')
        .filter(|(_, spec)| !spec.is_empty())
        .ok_or_else(|| IdeError::invalid("select a kernel of the Jupyter server"))?;
    let token = host.jupyter_tokens.get(base).ok_or_else(|| {
        IdeError::unavailable(format!("connect to the Jupyter server {base} again: its token is not saved"))
    })?;
    Ok(RemoteKernel { base: base.to_owned(), token, spec: spec.to_owned() })
}

/// A Jupyter server notebooks can run on.
#[derive(serde::Serialize, specta::Type)]
pub struct JupyterServer {
    /// Base URL, ending in `/`.
    pub url: String,
    pub kernels: Vec<KernelSpec>,
}

/// Checks `url` and `token` against the server and saves them. A `?token=` in the URL
/// (as JupyterLab prints it) is used when `token` is empty.
#[command(trust = trusted)]
pub async fn jupyter_server_add(host: &Host, window: &str, url: String, token: String) -> IdeResult<JupyterServer> {
    host.require_trust(window)?;
    let (url, in_url) = normalize_server_url(&url)?;
    let token = if token.trim().is_empty() { in_url.unwrap_or_default() } else { token.trim().to_owned() };
    let kernels = kernel_specs(&url, &token).await?;
    host.jupyter_tokens.set(&url, &token)?;
    Ok(JupyterServer { url, kernels })
}

/// The saved servers and their kernel specs; a server that cannot be reached has none.
#[command(trust = trusted)]
pub async fn jupyter_servers(host: &Host, window: &str) -> IdeResult<Vec<JupyterServer>> {
    host.require_trust(window)?;
    let servers = host.jupyter_tokens.keys().into_iter().map(|url| async move {
        let kernels = match host.jupyter_tokens.get(&url) {
            Some(token) => kernel_specs(&url, &token).await.unwrap_or_default(),
            None => Vec::new(),
        };
        JupyterServer { url, kernels }
    });
    Ok(futures::future::join_all(servers).await)
}

#[command(trust = always)]
pub fn jupyter_server_remove(host: &Host, window: &str, url: String) -> IdeResult<()> {
    let _ = window;
    host.jupyter_tokens.delete(&url);
    Ok(())
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
    jupyter_server_add,
    jupyter_server_remove,
    jupyter_servers,
    notebook_cell_docs,
    notebook_close,
    notebook_debug_start,
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
    notebook_variables,
);
