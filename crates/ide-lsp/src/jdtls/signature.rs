//! Change Signature through jdtls' own requests: `java/getChangeSignatureInfo` reads the method at
//! a position, `java/getRefactorEdit` (`changeSignature`) checks the new signature and computes the
//! edit. The UI edits the signature and applies the edit itself.
use super::{COMMAND_TIMEOUT, SERVER};
use crate::types::{MethodSignature, ProblemSeverity, RefactoringProblem, ServerRefactored};
use crate::{DocSnap, LspManager, Target, convert};
use ide_core::{CancellationToken, DocId, IdeError, IdeResult, Pos};
use serde::Deserialize;
use serde_json::{Value, json};

const FEATURE: &str = "Change Signature";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    #[serde(flatten)]
    signature: Option<MethodSignature>,
    error_message: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RefactorEdit {
    edit: Option<lsp_types::WorkspaceEdit>,
    error_message: Option<String>,
    confirmation_token: Option<String>,
}

/// A `java/getRefactorEdit` or `java/move` answer as the result: an error message alone is fatal;
/// with a confirmation token it lists warnings to accept before the edit is computed.
pub(super) fn changed(
    answer: RefactorEdit,
    convert_edit: impl FnOnce(lsp_types::WorkspaceEdit) -> ide_core::WorkspaceEdit,
) -> ServerRefactored {
    let problem = |severity| {
        answer
            .error_message
            .as_deref()
            .filter(|m| !m.trim().is_empty())
            .map(|message| RefactoringProblem { severity, message: message.trim().to_owned() })
    };
    if let Some(token) = answer.confirmation_token {
        return ServerRefactored {
            problems: problem(ProblemSeverity::Warning).into_iter().collect(),
            edit: None,
            confirmation: Some(token),
        };
    }
    match answer.edit {
        Some(edit) if answer.error_message.is_none() => {
            ServerRefactored { problems: Vec::new(), edit: Some(convert_edit(edit)), confirmation: None }
        }
        _ => ServerRefactored {
            problems: problem(ProblemSeverity::Fatal).into_iter().collect(),
            edit: None,
            confirmation: None,
        },
    }
}

impl LspManager {
    pub(super) async fn jdtls_target(&self, doc: DocId, feature: &str) -> IdeResult<(DocSnap, Target)> {
        let (snap, targets) = self.doc_targets(doc, feature, |_| true).await?;
        let t = targets
            .into_iter()
            .find(|t| t.server.name == SERVER)
            .ok_or_else(|| IdeError::unavailable(format!("{feature} needs the Java language server (jdtls)")))?;
        Ok((snap, t))
    }

    pub(super) fn signature_context(snap: &DocSnap, t: &Target, pos: Pos) -> Value {
        let at = snap.position(t, pos);
        json!({
            "textDocument": { "uri": snap.uri },
            "range": { "start": at, "end": at },
            "context": { "diagnostics": [] },
        })
    }

    /// The signature of the method at `pos`; an invalid-input error says why it can't be changed.
    pub async fn change_signature_info(
        &self,
        doc: DocId,
        pos: Pos,
        cancel: CancellationToken,
    ) -> IdeResult<MethodSignature> {
        let (snap, t) = self.jdtls_target(doc, FEATURE).await?;
        let params = Self::signature_context(&snap, &t, pos);
        let info: Option<Info> =
            self.call(&t, "java/getChangeSignatureInfo", params, Some(&cancel), COMMAND_TIMEOUT).await?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        match info {
            Some(Info { error_message: Some(message), .. }) => Err(IdeError::invalid(message)),
            Some(Info { signature: Some(signature), .. }) => Ok(signature),
            _ => Err(IdeError::invalid("Caret should be on a method declaration")),
        }
    }

    /// Checks changing the method at `pos` to `signature` and computes the edit without applying it.
    /// `confirmation` accepts the warnings an earlier check returned with it.
    pub async fn change_signature(
        &self,
        doc: DocId,
        pos: Pos,
        signature: MethodSignature,
        delegate: bool,
        confirmation: Option<String>,
        cancel: CancellationToken,
    ) -> IdeResult<ServerRefactored> {
        let (snap, t) = self.jdtls_target(doc, FEATURE).await?;
        let MethodSignature { method_identifier, modifier, return_type, method_name, parameters, exceptions } =
            signature;
        let mut params = json!({
            "command": "changeSignature",
            "context": Self::signature_context(&snap, &t, pos),
            "options": { "tabSize": 4, "insertSpaces": true },
            "commandArguments": [
                method_identifier, delegate, method_name, modifier, return_type, parameters, exceptions, false
            ],
        });
        if let Some(token) = confirmation {
            params["confirmationToken"] = json!(token);
        }
        let answer: Option<RefactorEdit> =
            self.call(&t, "java/getRefactorEdit", params, Some(&cancel), COMMAND_TIMEOUT).await?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let answer = answer.unwrap_or_default();
        let conv = self.conv(t.enc());
        Ok(changed(answer, |e| convert::workspace_edit(&conv, e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(v: Value) -> RefactorEdit {
        serde_json::from_value(v).unwrap()
    }
    fn no_edit(_: lsp_types::WorkspaceEdit) -> ide_core::WorkspaceEdit {
        ide_core::WorkspaceEdit::default()
    }

    #[test]
    fn reads_the_signature_or_why_there_is_none() {
        let info: Info = serde_json::from_value(json!({
            "methodIdentifier": "=p/src<p{A.java[A~m~I",
            "modifier": "public",
            "returnType": "void",
            "methodName": "m",
            "parameters": [{ "type": "int", "name": "a", "defaultValue": "null", "originalIndex": 0 }],
            "exceptions": [{ "type": "java.io.IOException", "typeHandleIdentifier": "=x" }],
            "errorMessage": null,
        }))
        .unwrap();
        let s = info.signature.unwrap();
        assert_eq!((s.method_name.as_str(), s.parameters[0].type_name.as_str()), ("m", "int"));
        assert_eq!(s.exceptions[0].type_name, "java.io.IOException");
        let refused: Info = serde_json::from_value(json!({ "errorMessage": "Cannot change signature." })).unwrap();
        assert!(refused.signature.is_none());
        assert_eq!(refused.error_message.as_deref(), Some("Cannot change signature."));
    }

    #[test]
    fn errors_are_fatal_and_tokens_ask_for_confirmation() {
        let fatal = changed(answer(json!({ "errorMessage": "Duplicate parameter name" })), no_edit);
        assert_eq!(fatal.problems[0].severity, ProblemSeverity::Fatal);
        assert!(fatal.edit.is_none() && fatal.confirmation.is_none());

        let warn = changed(answer(json!({ "errorMessage": "Overrides a method", "confirmationToken": "t1" })), no_edit);
        assert_eq!(warn.problems[0].severity, ProblemSeverity::Warning);
        assert_eq!(warn.confirmation.as_deref(), Some("t1"));

        let ok = changed(answer(json!({ "edit": { "changes": {} } })), no_edit);
        assert!(ok.problems.is_empty() && ok.edit.is_some());
    }
}
