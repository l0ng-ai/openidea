//! kotlin-lsp's built-in debug adapter: `start_debug_server` once the server has imported
//! the project (breakpoints set before that are "verified" but never hit).

use crate::LspManager;
use crate::server::Server;
use ide_core::event::ServerStatus;
use ide_core::{CancellationToken, LanguageId};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The server's name in `languages/kotlin.toml`.
pub const KOTLIN_LSP: &str = "kotlin-lsp";
/// A cold start imports the Gradle model before answering `initialize`.
const READY_TIMEOUT: Duration = Duration::from_secs(240);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// The last `intellij/workspaceImportState` of the current instance.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ImportState {
    pub finished: bool,
    /// Workspace folders whose import did not succeed.
    pub failed: Vec<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct KotlinDebugServer {
    /// Local TCP port of the DAP server.
    pub port: u16,
    /// Root of the kotlin-lsp instance that serves it.
    pub root: PathBuf,
}

/// Why kotlin-lsp cannot debug the module, for the fallback notice.
#[derive(Clone, Debug, PartialEq)]
pub enum KotlinDebugUnavailable {
    /// No `kotlin-lsp` among the module's servers (disabled in settings, another server chosen).
    NotConfigured,
    NotInstalled,
    /// The status message, else the status.
    NotStarted(String),
    /// The import did not finish in time, or the wait was cancelled.
    StillImporting,
    ImportFailed,
    Failed(String),
}

/// Records `intellij/workspaceImportState` from instance `generation`. Completion is this
/// notification, not "no `$/progress` left": kotlin-lsp reports "Indexing" every few seconds.
pub(crate) fn record_import_state(server: &Server, generation: u64, params: &Value) {
    let failed = params["folders"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|folder| folder["status"] != "SUCCESS")
        .filter_map(|folder| folder["folderUri"].as_str().and_then(crate::uri::uri_to_path))
        .collect();
    server.set_import_state(generation, ImportState { finished: params["phase"] == "FINISHED", failed });
}

fn importing(server: &Server) -> bool {
    server.progress.lock().values().any(|p| p.title.contains("Importing"))
}

impl LspManager {
    /// Starts kotlin-lsp's debug server for `path` (a module directory or source file) once
    /// the project is imported, starting kotlin-lsp if needed. `import_wait` bounds the wait
    /// for the import after the server is up; cancelling `cancel` ends it as
    /// [`KotlinDebugUnavailable::StillImporting`].
    pub async fn kotlin_debug_server(
        &self,
        path: &Path,
        import_wait: Duration,
        cancel: &CancellationToken,
    ) -> Result<KotlinDebugServer, KotlinDebugUnavailable> {
        let server = self
            .servers_for(&LanguageId::new("kotlin"), path)
            .into_iter()
            .find(|s| s.name == KOTLIN_LSP)
            .ok_or(KotlinDebugUnavailable::NotConfigured)?;
        self.ensure_started(&server);
        let ready = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(KotlinDebugUnavailable::StillImporting),
            ready = server.wait_ready(READY_TIMEOUT) => ready,
        };
        if ready.is_none() {
            let status = server.status();
            return Err(match status {
                ServerStatus::Missing => KotlinDebugUnavailable::NotInstalled,
                ServerStatus::Misconfigured | ServerStatus::Crashed => {
                    KotlinDebugUnavailable::NotStarted(server.status_message().unwrap_or_else(|| format!("{status:?}")))
                }
                _ => KotlinDebugUnavailable::NotStarted(format!("{status:?}")),
            });
        }
        tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(KotlinDebugUnavailable::StillImporting),
            imported = tokio::time::timeout(import_wait, wait_for_import(&server, path)) => {
                imported.unwrap_or(Err(KotlinDebugUnavailable::StillImporting))?
            }
        }
        // The instance that finished importing, also when it replaced the one waited for.
        let Some(run) = server.running() else {
            return Err(KotlinDebugUnavailable::NotStarted(format!("{:?}", server.status())));
        };
        let params =
            json!({ "command": "start_debug_server", "arguments": [crate::uri::path_to_uri_string(&server.root)] });
        let request = run.peer.request::<Value, Value>("workspace/executeCommand", params, Some(cancel.clone()));
        let port = match tokio::time::timeout(COMMAND_TIMEOUT, request).await {
            Ok(Ok(port)) => port,
            Ok(Err(e)) => return Err(KotlinDebugUnavailable::Failed(e.to_string())),
            Err(_) => {
                return Err(KotlinDebugUnavailable::Failed(format!(
                    "start_debug_server timed out after {} s",
                    COMMAND_TIMEOUT.as_secs()
                )));
            }
        };
        match port.as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p != 0) {
            Some(port) => Ok(KotlinDebugServer { port, root: server.root.clone() }),
            None => Err(KotlinDebugUnavailable::Failed(format!("unexpected debug server port: {port}"))),
        }
    }
}

/// Waits until the current instance reports its import finished and its "Importing" task
/// ended, which arrive in either order.
async fn wait_for_import(server: &Server, path: &Path) -> Result<(), KotlinDebugUnavailable> {
    let mut state = server.import_state.subscribe();
    loop {
        // Created before the check so a progress end in between still wakes us.
        let progress_ended = server.phase_notified();
        let current = state.borrow_and_update().clone();
        if let Some(current) = current
            && current.finished
            && !importing(server)
        {
            if current.failed.iter().any(|dir| canonical(path).starts_with(canonical(dir))) {
                return Err(KotlinDebugUnavailable::ImportFailed);
            }
            return Ok(());
        }
        tokio::select! {
            _ = state.changed() => {}
            () = progress_ended => {}
        }
    }
}

/// `path` with its deepest existing ancestor resolved, so a symlinked root (or `/tmp` vs
/// `/private/tmp` on macOS) and the folder URIs kotlin-lsp reports name one directory alike.
fn canonical(path: &Path) -> PathBuf {
    for ancestor in path.ancestors() {
        if let Ok(real) = dunce::canonicalize(ancestor) {
            let rest = path.strip_prefix(ancestor).unwrap_or(Path::new(""));
            return if rest.as_os_str().is_empty() { real } else { real.join(rest) };
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{IdeEvent, SharedSink};
    use std::sync::Arc;

    #[test]
    fn an_instance_that_was_replaced_does_not_record_its_import() {
        let cfg = toml::from_str("name = \"kotlin-lsp\"\ncommand = \"kotlin-lsp\"").unwrap();
        let server = Server::new(cfg, PathBuf::from("/p"), LanguageId::new("kotlin"));
        let finished = json!({ "phase": "FINISHED", "folders": [
            { "folderUri": "file:///p/", "status": "SUCCESS" },
            { "folderUri": "file:///p/lib/", "status": "FAILED" },
        ]});
        let old = server.begin_start().unwrap();
        record_import_state(&server, old, &json!({ "phase": "IN_PROGRESS", "folders": [] }));
        assert_eq!(*server.import_state.borrow(), Some(ImportState { finished: false, failed: vec![] }));
        record_import_state(&server, old, &finished);
        let done = Some(ImportState { finished: true, failed: vec![PathBuf::from("/p/lib")] });
        assert_eq!(*server.import_state.borrow(), done);

        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        server.begin_stop(&sink, false);
        let new = server.begin_start().unwrap();
        assert_eq!(*server.import_state.borrow(), None);
        // The dying instance's FINISHED arrives after the restart.
        record_import_state(&server, old, &finished);
        assert_eq!(*server.import_state.borrow(), None);
        record_import_state(&server, new, &finished);
        assert_eq!(*server.import_state.borrow(), done);
    }
}
