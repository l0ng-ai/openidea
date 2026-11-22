//! The exception class at a caret, for the exception breakpoint intention, through the
//! app-owned JDT extension (`java/java-usages`).
use super::COMMAND_TIMEOUT;
use crate::LspManager;
use crate::types::ExceptionClassRef;
use ide_core::{CancellationToken, DocId, IdeError, IdeResult, Pos};
use serde_json::json;

const EXCEPTION_TYPE: &str = "openidea.java.exceptionType";

impl LspManager {
    /// The Throwable class the caret at `pos` names; `None` when there is none, or when no
    /// server of the document has the command.
    pub async fn exception_class_at(
        &self,
        doc: DocId,
        pos: Pos,
        cancel: CancellationToken,
    ) -> IdeResult<Option<ExceptionClassRef>> {
        let snap = self.snapshot(doc)?;
        let mut targets = self.ready_targets(&snap.servers, |c| c.commands().iter().any(|c| c == EXCEPTION_TYPE)).await;
        if targets.is_empty() {
            return Ok(None);
        }
        let t = targets.swap_remove(0);
        let at = snap.position(&t, pos);
        let params = json!({
            "command": EXCEPTION_TYPE,
            "arguments": [snap.uri, at.line, at.character],
        });
        let found: Option<ExceptionClassRef> =
            self.call(&t, "workspace/executeCommand", params, Some(&cancel), COMMAND_TIMEOUT).await?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        Ok(found)
    }
}
