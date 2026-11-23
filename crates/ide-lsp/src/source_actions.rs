use crate::convert::Conv;
use crate::text::DocText;
use crate::{DEFAULT_TIMEOUT, LspManager, Outcome, Target, scope};
use ide_core::{CancellationToken, IdeError, IdeResult, LanguageId, Pos, TextEdit};
use lsp_types as lsp;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;

impl LspManager {
    /// Reads a source action for an isolated text snapshot. The caller owns the text and applies the edits.
    pub async fn source_action_text(
        &self,
        path: &Path,
        language: &LanguageId,
        text: &str,
        kind: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<TextEdit>> {
        if !kind.starts_with("source.") {
            return Err(IdeError::invalid("a text snapshot requires a source action"));
        }
        let targets =
            self.snapshot_targets(path, language, "snapshot source actions", |c| c.has("codeActionProvider")).await?;
        let path = scope::snapshot_path(path, "source")?;
        let mut out = Outcome::new();
        for target in &targets {
            match self.snapshot_action(target, &path, language, text, kind, cancel).await {
                Ok(edits) if !edits.is_empty() => return Ok(edits),
                Ok(edits) => out.value = Some(edits),
                Err(error) if cancel.is_cancelled() => return Err(error),
                Err(error) => out.fail(error),
            }
        }
        out.finish(Vec::new())
    }

    async fn snapshot_action(
        &self,
        target: &Target,
        path: &Path,
        language: &LanguageId,
        text: &str,
        kind: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<TextEdit>> {
        let mut opened = scope::TransientFiles::empty(self, target);
        opened.hold(path, language, text);
        let uri = &opened.files[0].1;
        let doc = Arc::new(DocText::new(text));
        let last = doc.line_count() - 1;
        let end = doc.ide_to_lsp(target.enc(), Pos::new(last as u32, doc.line(last).encode_utf16().count() as u32));
        let params = json!({
            "textDocument": { "uri": uri },
            "range": lsp::Range::new(lsp::Position::new(0, 0), end),
            "context": { "diagnostics": [], "only": [kind], "triggerKind": 1 },
        });
        let actions: Option<Vec<lsp::CodeActionOrCommand>> =
            self.call(target, "textDocument/codeAction", params, Some(cancel), DEFAULT_TIMEOUT).await?;
        let (restriction, resolve) = {
            let caps = target.caps();
            (caps.restriction.clone(), caps.has_sub("codeActionProvider", "resolveProvider"))
        };
        let mut actions: Vec<_> = actions
            .unwrap_or_default()
            .into_iter()
            .filter_map(|action| match action {
                lsp::CodeActionOrCommand::CodeAction(action)
                    if action.disabled.is_none()
                        && action.command.is_none()
                        && action.kind.as_ref().is_some_and(|k| {
                            let value = k.as_str();
                            restriction.keeps_action(Some(value))
                                && (value == kind || value.strip_prefix(kind).is_some_and(|rest| rest.starts_with('.')))
                        }) =>
                {
                    Some(action)
                }
                _ => None,
            })
            .collect();
        actions.sort_by_key(|action| action.is_preferred != Some(true));
        for mut action in actions {
            if action.edit.is_none() && action.data.is_some() && resolve {
                action = self.call(target, "codeAction/resolve", action, Some(cancel), DEFAULT_TIMEOUT).await?;
            }
            if action.disabled.is_none()
                && action.command.is_none()
                && let Some(edits) = action.edit.and_then(|edit| snapshot_edits(edit, uri))
                && !edits.is_empty()
            {
                return Ok(Conv::new(target.enc(), |_| Some(doc.clone())).text_edits(path, edits));
            }
        }
        Ok(Vec::new())
    }
}

fn snapshot_edits(edit: lsp::WorkspaceEdit, uri: &lsp::Uri) -> Option<Vec<lsp::TextEdit>> {
    match (edit.changes, edit.document_changes) {
        (Some(mut changes), None) if changes.len() == 1 => changes.remove(uri),
        (None, Some(lsp::DocumentChanges::Edits(mut edits))) if edits.len() == 1 => {
            let edit = edits.pop()?;
            if edit.text_document.uri != *uri || edit.text_document.version.is_some_and(|version| version != 0) {
                return None;
            }
            Some(
                edit.edits
                    .into_iter()
                    .map(|edit| match edit {
                        lsp::OneOf::Left(edit) => edit,
                        lsp::OneOf::Right(edit) => edit.text_edit,
                    })
                    .collect(),
            )
        }
        _ => None,
    }
}
