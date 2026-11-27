//! Pull Members Up / Push Members Down through Phoxite's own requests
//! (`phoxite/refactor/hierarchyMembers` and `phoxite/refactor/hierarchy`). A server says it
//! answers them with `experimental.phoxite.refactor` in its capabilities, so the server is
//! found by what it advertises, not by its name. As with the JDT extension, the server
//! checks the move and computes the edit; the UI shows its problems and applies the edit.
use crate::caps::ServerCaps;
use crate::types::{HierarchyChoice, HierarchyMembers, HierarchyRefactored, HierarchyRefactoring, RefactoringProblem};
use crate::{DocSnap, LspManager, Target, convert, rpc_err};
use ide_core::{CancellationToken, DocId, IdeError, IdeResult, Pos};
use ide_jsonrpc::RpcError;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::time::Duration;

const MEMBERS: &str = "phoxite/refactor/hierarchyMembers";
const REFACTOR: &str = "phoxite/refactor/hierarchy";
/// The move is computed over the whole project.
const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Deserialize)]
struct Refactored {
    problems: Vec<RefactoringProblem>,
    edit: Option<lsp_types::WorkspaceEdit>,
}

/// Whether the server answers the `phoxite/refactor/*` requests.
fn refactors(caps: &ServerCaps) -> bool {
    caps.raw.pointer("/experimental/phoxite/refactor").and_then(Value::as_bool) == Some(true)
}

impl LspManager {
    /// The server of `doc` that answers `phoxite/refactor/*`, when one is attached.
    pub(crate) async fn phoxite_refactor_target(&self, doc: DocId) -> Option<(DocSnap, Target)> {
        let (snap, mut targets) = self.doc_targets(doc, "refactorings", refactors).await.ok()?;
        Some((snap, targets.swap_remove(0)))
    }

    /// Sends one of the hierarchy requests. The server refuses a position it can't
    /// refactor with LSP's `RequestFailed` and a message for the user: that is invalid
    /// input, as the JDT extension's `refused` is. Any other error is the server failing.
    async fn phoxite_hierarchy<R: DeserializeOwned>(
        &self,
        (snap, t): &(DocSnap, Target),
        method: &str,
        pos: Pos,
        kind: HierarchyRefactoring,
        extra: Value,
        cancel: &CancellationToken,
    ) -> IdeResult<R> {
        let mut params = json!({ "uri": snap.uri, "position": snap.position(t, pos), "kind": kind });
        if let (Some(params), Value::Object(extra)) = (params.as_object_mut(), extra) {
            params.extend(extra);
        }
        let request = t.run.peer.request::<Value, Value>(method, params, Some(cancel.clone()));
        let answer = match tokio::time::timeout(TIMEOUT, request).await {
            Ok(Ok(value)) => value,
            Ok(Err(RpcError::Server { code, message, .. })) if code == ide_jsonrpc::codes::REQUEST_FAILED => {
                return Err(IdeError::invalid(message));
            }
            Ok(Err(e)) => return Err(rpc_err(&t.server.name, method, e)),
            Err(_) => return Err(rpc_err(&t.server.name, method, RpcError::Timeout)),
        };
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        serde_json::from_value(answer).map_err(|e| rpc_err(&t.server.name, method, RpcError::Protocol(e.to_string())))
    }

    pub(crate) async fn phoxite_hierarchy_members(
        &self,
        target: &(DocSnap, Target),
        pos: Pos,
        kind: HierarchyRefactoring,
        cancel: &CancellationToken,
    ) -> IdeResult<HierarchyMembers> {
        self.phoxite_hierarchy(target, MEMBERS, pos, kind, Value::Null, cancel).await
    }

    pub(crate) async fn phoxite_hierarchy_refactor(
        &self,
        target: &(DocSnap, Target),
        pos: Pos,
        kind: HierarchyRefactoring,
        destination: Option<String>,
        choices: &[HierarchyChoice],
        cancel: &CancellationToken,
    ) -> IdeResult<HierarchyRefactored> {
        let extra = json!({ "target": destination, "choices": choices });
        let refactored: Refactored = self.phoxite_hierarchy(target, REFACTOR, pos, kind, extra, cancel).await?;
        let conv = self.conv(target.1.enc());
        Ok(HierarchyRefactored {
            problems: refactored.problems,
            edit: refactored.edit.map(|e| convert::workspace_edit(&conv, e)),
        })
    }
}
