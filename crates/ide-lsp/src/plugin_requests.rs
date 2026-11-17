//! Requests a plugin sends to a running server (`language-servers` in the plugin API):
//! the server's own methods only, and only to a server that already runs.

use crate::{LspManager, Target, rpc_err};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// The first segment of the methods LSP itself defines.
const LSP_NAMESPACES: [&str; 14] = [
    "textDocument",
    "workspace",
    "window",
    "notebookDocument",
    "callHierarchy",
    "typeHierarchy",
    "completionItem",
    "codeAction",
    "codeLens",
    "documentLink",
    "inlayHint",
    "workspaceSymbol",
    "client",
    "telemetry",
];
const LIFECYCLE: [&str; 4] = ["initialize", "initialized", "shutdown", "exit"];

/// Whether a plugin may send `method`: only a server's own namespace passes
/// (`phoxite/laravel/routes`), so a plugin can't interfere with document sync, the
/// features the IDE asks for itself, or the server's lifecycle.
pub fn plugin_method_allowed(method: &str) -> bool {
    let namespace = method.split('/').next().unwrap_or_default();
    !(method.is_empty()
        || method.starts_with("$/")
        || LIFECYCLE.contains(&method)
        || LSP_NAMESPACES.contains(&namespace))
}

impl LspManager {
    /// The running server named `server`, the one rooted at `root` first. Never starts one.
    fn plugin_target(&self, root: &Path, server: &str, method: &str) -> IdeResult<Target> {
        if !plugin_method_allowed(method) {
            return Err(IdeError::invalid(format!("`{method}` is not one of the server's own methods")));
        }
        let mut running: Vec<Target> = self
            .servers
            .lock()
            .iter()
            .filter(|s| s.name == server)
            .filter_map(|s| s.running().map(|run| Target { server: s.clone(), run }))
            .collect();
        let at = running.iter().position(|t| t.server.root == root).unwrap_or(0);
        if running.is_empty() {
            return Err(IdeError::not_found(format!("no language server `{server}` is running for this project")));
        }
        Ok(running.swap_remove(at))
    }

    /// Names (in the language definition) of the servers attached to `doc`, or of every
    /// server of the project when the document is not open; only `server`'s when given.
    pub fn server_names(&self, doc: ide_core::DocId, server: Option<ide_core::ServerId>) -> Vec<String> {
        let servers = match self.snapshot(doc) {
            Ok(snap) => snap.servers,
            Err(_) => self.servers.lock().clone(),
        };
        servers.iter().filter(|s| server.is_none_or(|id| s.id == id)).map(|s| s.name.clone()).collect()
    }

    /// Sends a plugin's request to the running server named `server` (its name in the
    /// language definition) and returns the result. `not_found` when it is not running,
    /// `invalid` for a method that is not the server's own.
    pub async fn server_request(
        &self,
        root: &Path,
        server: &str,
        method: &str,
        params: Option<Value>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> IdeResult<Value> {
        let t = self.plugin_target(root, server, method)?;
        self.call(&t, method, params.unwrap_or(Value::Null), Some(cancel), timeout).await
    }

    /// The same for a notification.
    pub fn server_notify(&self, root: &Path, server: &str, method: &str, params: Option<Value>) -> IdeResult<()> {
        let t = self.plugin_target(root, server, method)?;
        t.run.peer.notify(method, params.unwrap_or(Value::Null)).map_err(|e| rpc_err(server, method, e))
    }
}

#[cfg(test)]
mod tests {
    use super::plugin_method_allowed;

    #[test]
    fn only_a_servers_own_methods_pass() {
        for method in ["phoxite/laravel/routes", "phoxite/refactor/hierarchy", "rust-analyzer/expandMacro", "custom"] {
            assert!(plugin_method_allowed(method), "{method}");
        }
        for method in [
            "",
            "initialize",
            "initialized",
            "shutdown",
            "exit",
            "$/cancelRequest",
            "$/progress",
            "textDocument/hover",
            "textDocument/didChange",
            "workspace/executeCommand",
            "window/showMessage",
            "notebookDocument/didOpen",
            "callHierarchy/incomingCalls",
            "typeHierarchy/supertypes",
            "completionItem/resolve",
            "codeAction/resolve",
            "codeLens/resolve",
            "documentLink/resolve",
            "inlayHint/resolve",
            "workspaceSymbol/resolve",
            "client/registerCapability",
            "telemetry/event",
        ] {
            assert!(!plugin_method_allowed(method), "{method}");
        }
    }
}
