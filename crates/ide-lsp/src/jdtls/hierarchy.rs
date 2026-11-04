//! Pull Members Up / Push Members Down through the app-owned JDT extension
//! (`plugins/java-usages`). The server checks the move and computes the edit; the UI
//! shows its problems and applies the edit itself.
use super::COMMAND_TIMEOUT;
use crate::types::{HierarchyChoice, HierarchyMembers, HierarchyRefactored, HierarchyRefactoring, RefactoringProblem};
use crate::{DocSnap, LspManager, Target, convert};
use ide_core::{CancellationToken, DocId, IdeError, IdeResult, Pos};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const MEMBERS: &str = "openidea.java.hierarchy.members";
const REFACTOR: &str = "openidea.java.hierarchy.refactor";

/// The extension's answer: a result, or why the position can't be refactored.
#[derive(Deserialize)]
#[serde(untagged)]
enum Answer<T> {
    Refused { refused: String },
    Ok(T),
}

impl<T> Answer<T> {
    fn into_result(self) -> IdeResult<T> {
        match self {
            Answer::Refused { refused } => Err(IdeError::invalid(refused)),
            Answer::Ok(value) => Ok(value),
        }
    }
}

#[derive(Deserialize)]
struct Refactored {
    problems: Vec<RefactoringProblem>,
    edit: Option<lsp_types::WorkspaceEdit>,
}

fn feature(kind: HierarchyRefactoring) -> &'static str {
    match kind {
        HierarchyRefactoring::PullUp => "Pull Members Up",
        HierarchyRefactoring::PushDown => "Push Members Down",
    }
}

impl LspManager {
    async fn hierarchy_command<R: DeserializeOwned>(
        &self,
        doc: DocId,
        pos: Pos,
        kind: HierarchyRefactoring,
        command: &str,
        extra: &[Value],
        cancel: &CancellationToken,
    ) -> IdeResult<(R, DocSnap, Target)> {
        let (snap, mut targets) =
            self.doc_targets(doc, feature(kind), |c| c.commands().iter().any(|c| c == command)).await?;
        let t = targets.swap_remove(0);
        let at = snap.position(&t, pos);
        let mut arguments = vec![json!(snap.uri), json!(at.line), json!(at.character), json!(kind)];
        arguments.extend_from_slice(extra);
        let params = json!({ "command": command, "arguments": arguments });
        let answer: Answer<R> =
            self.call(&t, "workspace/executeCommand", params, Some(cancel), COMMAND_TIMEOUT).await?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        Ok((answer.into_result()?, snap, t))
    }

    /// The class at `pos` and its movable members; an invalid-input error says why there are none.
    pub async fn hierarchy_members(
        &self,
        doc: DocId,
        pos: Pos,
        kind: HierarchyRefactoring,
        cancel: CancellationToken,
    ) -> IdeResult<HierarchyMembers> {
        let (members, _, _) = self.hierarchy_command(doc, pos, kind, MEMBERS, &[], &cancel).await?;
        Ok(members)
    }

    /// Checks moving `choices` (to `target`, for pull up) and computes the edit without applying it.
    pub async fn hierarchy_refactor(
        &self,
        doc: DocId,
        pos: Pos,
        kind: HierarchyRefactoring,
        target: Option<String>,
        choices: Vec<HierarchyChoice>,
        cancel: CancellationToken,
    ) -> IdeResult<HierarchyRefactored> {
        let choices: Vec<Value> = choices.iter().map(|c| json!({ "id": c.id, "abstract": c.make_abstract })).collect();
        let (refactored, _, t): (Refactored, _, _) =
            self.hierarchy_command(doc, pos, kind, REFACTOR, &[json!(target), json!(choices)], &cancel).await?;
        let conv = self.conv(t.enc());
        Ok(HierarchyRefactored {
            problems: refactored.problems,
            edit: refactored.edit.map(|e| convert::workspace_edit(&conv, e)),
        })
    }
}
