//! [`ExceptionClassBreakpoints`] over `openidea.jvm.exceptions.set` of the JVM inspector bundle that
//! runs inside jdtls (`java/jvm-inspect`).

use super::jvm_inspect::{command_error, decode, target_json};
use crate::LspManager;
use ide_jvm_inspect::{
    ExceptionArmState, ExceptionClassBreakpoints, ExceptionClassSpec, InspectError, InspectFuture, VmTarget,
};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;

/// The bundle waits for the inspect commands' turn, which a `classes` on a large heap can hold.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

pub struct JdtExceptionBreakpoints {
    lsp: Arc<LspManager>,
    /// A path inside the module whose jdtls runs the debug session.
    server: PathBuf,
}

impl JdtExceptionBreakpoints {
    pub fn new(lsp: Arc<LspManager>, server: PathBuf) -> Self {
        Self { lsp, server }
    }
}

#[derive(Deserialize)]
struct WireState {
    id: String,
    state: ExceptionArmState,
}

impl ExceptionClassBreakpoints for JdtExceptionBreakpoints {
    fn set<'a>(
        &'a self,
        target: &'a VmTarget,
        breakpoints: &'a [ExceptionClassSpec],
    ) -> InspectFuture<'a, Vec<(String, ExceptionArmState)>> {
        Box::pin(async move {
            let arguments = vec![target_json(target), json!({ "breakpoints": breakpoints })];
            let reply = timeout(
                COMMAND_TIMEOUT,
                self.lsp.jdtls_command(&self.server, "openidea.jvm.exceptions.set", arguments),
            )
            .await
            .map_err(|_| InspectError::TimedOut)?
            .map_err(command_error)?;
            let states: Vec<WireState> = decode(reply)?;
            Ok(states.into_iter().map(|s| (s.id, s.state)).collect())
        })
    }
}
