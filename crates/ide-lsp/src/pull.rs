//! Pull diagnostics (`textDocument/diagnostic`). Servers that provide them may stop pushing
//! their own analysis to a client that can pull (rust-analyzer pushes only `cargo check`
//! then): the editor pulls an open file's diagnostics when it opens, after edits and saves,
//! and when the server asks for a refresh. Pulled diagnostics are kept apart from pushed ones
//! and shown together.

use crate::server::{Running, Server};
use crate::{LspManager, virtual_doc};
use ide_core::{DocId, IdeEvent};
use ide_jsonrpc::RpcError;
use lsp_types as lsp;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// How long typing must pause before a changed file is pulled again.
pub(crate) const AFTER_EDIT: Duration = Duration::from_millis(300);
const TIMEOUT: Duration = Duration::from_secs(30);
/// Retries of a pull the server cancelled (`ServerCancelled`, e.g. while indexing).
const RETRIES: u32 = 20;

struct PullTarget {
    server: Arc<Server>,
    run: Running,
    path: PathBuf,
    uri: lsp::Uri,
}

fn provides_pull(run: &Running) -> bool {
    let caps = run.caps.read();
    caps.restriction.diagnostics() && caps.has("diagnosticProvider")
}

fn inter_file(run: &Running) -> bool {
    run.caps.read().raw.pointer("/diagnosticProvider/interFileDependencies").and_then(Value::as_bool) == Some(true)
}

impl LspManager {
    /// Pulls `doc`'s diagnostics from its servers that provide them (`only`: from that one)
    /// after `delay`; a later pull of the same file supersedes it.
    pub(crate) fn schedule_pull(&self, doc: DocId, only: Option<&Server>, delay: Duration) {
        let targets: Vec<PullTarget> = {
            let docs = self.docs.lock();
            let Some(d) = docs.get(&doc) else { return };
            // Decompiled C# is a source view, not compilable project code (e.g. Unity's older language version).
            if virtual_doc::is_csharp_decompiled(d.uri.as_str()) {
                return;
            }
            d.servers
                .iter()
                .filter(|a| only.is_none_or(|s| s.id == a.server.id))
                .filter_map(|a| {
                    let run = a.server.running()?;
                    (a.opened_gen == Some(run.generation) && provides_pull(&run)).then(|| PullTarget {
                        server: a.server.clone(),
                        run,
                        path: d.path.clone(),
                        uri: d.uri.clone(),
                    })
                })
                .collect()
        };
        for t in targets {
            if t.server.suppresses_diagnostics(&t.path) {
                continue;
            }
            let pull = t.server.next_pull(&t.path);
            let me = self.me.clone();
            self.runtime.spawn(async move {
                tokio::time::sleep(delay).await;
                if let Some(me) = me.upgrade() {
                    me.pull(t, pull).await;
                }
            });
        }
    }

    /// Pulls every open file of `server` again (`workspace/diagnostic/refresh`).
    pub(crate) fn refresh_pulled_diagnostics(&self, server: &Server) {
        let docs: Vec<DocId> = self
            .docs
            .lock()
            .iter()
            .filter(|(_, d)| d.servers.iter().any(|a| a.server.id == server.id))
            .map(|(id, _)| *id)
            .collect();
        for doc in docs {
            self.schedule_pull(doc, Some(server), Duration::ZERO);
        }
    }

    /// After `doc` was saved: servers whose diagnostics depend on other files pull those
    /// open files too.
    pub(crate) fn pull_dependents(&self, doc: DocId) {
        let docs = self.docs.lock();
        let Some(d) = docs.get(&doc) else { return };
        let servers: Vec<Arc<Server>> = d
            .servers
            .iter()
            .filter(|a| a.server.running().is_some_and(|run| provides_pull(&run) && inter_file(&run)))
            .map(|a| a.server.clone())
            .collect();
        let others: Vec<(DocId, Vec<Arc<Server>>)> = docs
            .iter()
            .filter(|(id, _)| **id != doc)
            .map(|(id, o)| {
                (*id, servers.iter().filter(|s| o.servers.iter().any(|a| a.server.id == s.id)).cloned().collect())
            })
            .collect();
        drop(docs);
        for (other, servers) in others {
            for server in servers {
                self.schedule_pull(other, Some(&server), Duration::ZERO);
            }
        }
    }

    /// Drops what was pulled for a closed file and shows what remains.
    pub(crate) fn forget_pulled(&self, server: &Server, path: &std::path::Path, run: Option<&Running>) {
        if let Some(shown) = server.clear_pulled(path) {
            let enc = run.map(|r| r.caps.read().encoding).unwrap_or_default();
            self.emit_diagnostics(server, path.to_owned(), shown, enc);
        }
    }

    async fn pull(&self, t: PullTarget, pull: u64) {
        let mut attempt = 0;
        loop {
            if !t.server.is_latest_pull(&t.path, pull) {
                return;
            }
            let mut params = json!({ "textDocument": { "uri": t.uri } });
            if let Some(id) = t.server.pulled_result_id(&t.path) {
                params["previousResultId"] = json!(id);
            }
            if let Some(identifier) = t.run.caps.read().raw.pointer("/diagnosticProvider/identifier") {
                params["identifier"] = identifier.clone();
            }
            let request = t.run.peer.request::<Value, Value>("textDocument/diagnostic", params, None);
            let report = match tokio::time::timeout(TIMEOUT, request).await {
                Ok(Ok(report)) => report,
                // This request has no cancellation of its own: the server cancelled it
                // (`ServerCancelled` while busy, which asks to be asked again).
                Ok(Err(RpcError::Cancelled)) if attempt < RETRIES => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt.min(8)))).await;
                    continue;
                }
                Ok(Err(e)) => {
                    tracing::debug!("{}: textDocument/diagnostic: {e}", t.server.name);
                    return;
                }
                Err(_) => {
                    tracing::debug!("{}: textDocument/diagnostic timed out", t.server.name);
                    return;
                }
            };
            // A newer pull, a closed file or a restarted server makes this report stale.
            if !t.server.is_latest_pull(&t.path, pull)
                || t.server.running().is_none_or(|r| r.generation != t.run.generation)
                || !self.docs.lock().values().any(|d| d.path == t.path)
            {
                return;
            }
            let result_id = report.get("resultId").and_then(Value::as_str).map(str::to_owned);
            let items = match report.get("kind").and_then(Value::as_str) {
                Some("unchanged") => None,
                _ => match serde_json::from_value(report.get("items").cloned().unwrap_or(json!([]))) {
                    Ok(items) => Some(items),
                    Err(e) => {
                        tracing::debug!("{}: bad textDocument/diagnostic report: {e}", t.server.name);
                        return;
                    }
                },
            };
            let shown = t.server.set_pulled(t.path.clone(), result_id, items);
            let enc = t.run.caps.read().encoding;
            self.emit_diagnostics(&t.server, t.path, shown, enc);
            return;
        }
    }

    /// Shows `items` as `server`'s diagnostics for `path`.
    pub(crate) fn emit_diagnostics(
        &self,
        server: &Server,
        path: PathBuf,
        items: Vec<lsp::Diagnostic>,
        enc: crate::text::Encoding,
    ) {
        if let Some((path, items)) = self.injected_diagnostics(server, &path, enc, items) {
            server.emit(&self.sink, IdeEvent::Diagnostics { path: path.into(), source: server.name.clone(), items });
        }
    }
}
