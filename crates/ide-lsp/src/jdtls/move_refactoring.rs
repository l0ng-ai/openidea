//! Move (F6) through jdtls' own requests. jdtls offers Move as code actions whose command the
//! client runs (`java.action.applyRefactoringCommand` with `moveFile`, `moveType`,
//! `moveStaticMember` or `moveInstanceMethod`); the UI picks the destination from
//! `java/getMoveDestinations` or `java/searchSymbols` and `java/move` checks the move and
//! computes the edit, which the UI applies itself. Requests carry the code action's own
//! arguments back unchanged.
use super::COMMAND_TIMEOUT;
use super::signature::{RefactorEdit, changed};
use crate::types::ServerRefactored;
use crate::{LspManager, convert};
use ide_core::{CancellationToken, DocId, IdeError, IdeResult};
use serde_json::{Value, json};

const FEATURE: &str = "Move";
/// What `java/getMoveDestinations` and `java/move` accept as `moveKind`.
const KINDS: [&str; 6] =
    ["moveResource", "moveInstanceMethod", "moveStaticMember", "moveTypeToNewFile", "moveTypeToClass", "moveType"];

fn move_params(kind: &str, request: &Value) -> IdeResult<Value> {
    if !KINDS.contains(&kind) {
        return Err(IdeError::invalid(format!("unknown move kind `{kind}`")));
    }
    let mut params = json!({
        "moveKind": kind,
        "sourceUris": request.get("sourceUris").cloned().unwrap_or(json!([])),
        "params": request.get("params").cloned().unwrap_or(Value::Null),
    });
    if let Some(destination) = request.get("destination").filter(|d| !d.is_null()) {
        params["destination"] = destination.clone();
    }
    Ok(params)
}

impl LspManager {
    /// Where the move of `kind` can go (packages, or the fields and parameters an instance
    /// method can move to); an invalid-input error carries jdtls' reason when there is none.
    pub async fn java_move_destinations(
        &self,
        doc: DocId,
        kind: String,
        request: Value,
        cancel: CancellationToken,
    ) -> IdeResult<Vec<Value>> {
        let (_, t) = self.jdtls_target(doc, FEATURE).await?;
        let params = move_params(&kind, &request)?;
        let answer: Value = self.call(&t, "java/getMoveDestinations", params, Some(&cancel), COMMAND_TIMEOUT).await?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if let Some(message) = answer.get("errorMessage").and_then(Value::as_str).filter(|m| !m.is_empty()) {
            return Err(IdeError::invalid(message.to_owned()));
        }
        Ok(answer.get("destinations").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    /// The project's source types (`java/searchSymbols`), for moving a member or type into a class.
    pub async fn java_source_types(
        &self,
        doc: DocId,
        project: Option<String>,
        cancel: CancellationToken,
    ) -> IdeResult<Vec<Value>> {
        let (_, t) = self.jdtls_target(doc, FEATURE).await?;
        let params = json!({ "query": "*", "projectName": project, "sourceOnly": true });
        let answer: Option<Vec<Value>> =
            self.call(&t, "java/searchSymbols", params, Some(&cancel), COMMAND_TIMEOUT).await?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        Ok(answer.unwrap_or_default())
    }

    /// Checks the move and computes the edit without applying it; `confirmation` accepts the
    /// warnings an earlier check returned with it.
    pub async fn java_move(
        &self,
        doc: DocId,
        kind: String,
        request: Value,
        confirmation: Option<String>,
        cancel: CancellationToken,
    ) -> IdeResult<ServerRefactored> {
        let (_, t) = self.jdtls_target(doc, FEATURE).await?;
        let mut params = move_params(&kind, &request)?;
        params["updateReferences"] = json!(true);
        if let Some(token) = confirmation {
            params["confirmationToken"] = json!(token);
        }
        let answer: Option<RefactorEdit> = self.call(&t, "java/move", params, Some(&cancel), COMMAND_TIMEOUT).await?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let conv = self.conv(t.enc());
        Ok(changed(answer.unwrap_or_default(), |e| convert::workspace_edit(&conv, e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_the_code_action_arguments_back_for_known_kinds_only() {
        let request = json!({
            "sourceUris": ["file:///p/A.java"],
            "params": { "textDocument": { "uri": "file:///p/A.java" } },
            "destination": { "displayName": "com.example" },
        });
        let params = move_params("moveResource", &request).unwrap();
        assert_eq!(params["moveKind"], "moveResource");
        assert_eq!(params["sourceUris"][0], "file:///p/A.java");
        assert_eq!(params["destination"]["displayName"], "com.example");
        assert!(move_params("moveResource", &json!({})).unwrap().get("destination").is_none());
        assert!(move_params("deleteEverything", &request).is_err());
    }
}
