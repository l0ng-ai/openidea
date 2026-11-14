//! Requests of vscode-js-debug's own, beyond the Debug Adapter Protocol: what a page in a
//! browser offers a debugger besides stepping (breakpoints on DOM events and requests).
//! Each is a typed method; a js-debug build that lacks one answers with an error, which is
//! reported as the feature being unavailable.

use crate::session::Session;
use crate::{DebugManager, DebugSessionId, REQUEST_TIMEOUT};
use ide_core::{IdeError, IdeResult};
use serde_json::{Value, json};

pub(crate) const ADAPTER: &str = "js-debug";

/// Whether `session` debugs a page: the child js-debug starts for a browser launch or attach.
/// The launch's own session only owns the browser.
pub(crate) fn is_page(session: &Session) -> bool {
    session.adapter == ADAPTER
        && session.parent.is_some()
        && matches!(session.launch_type.get().map(String::as_str), Some("pwa-chrome" | "pwa-msedge"))
}

/// Waits until the adapter answered the `launch` of `session`. js-debug sets a page's session
/// up between `configurationDone` and that answer; a request of its own that arrives then is
/// answered and has no effect.
async fn launched(session: &Session) -> bool {
    let mut launched = session.launched.subscribe();
    let answered = tokio::time::timeout(REQUEST_TIMEOUT, launched.wait_for(|answered| *answered)).await;
    matches!(answered, Ok(Ok(_)))
}

impl DebugManager {
    /// One of js-debug's requests for pages, sent to the page `s` once its session has started.
    async fn js_page_request(&self, s: DebugSessionId, command: &str, arguments: Value) -> IdeResult<Value> {
        let session = self.session(s)?;
        if !is_page(&session) {
            return Err(IdeError::unavailable("this debug session is not a page in a browser"));
        }
        if !launched(&session).await {
            return Err(IdeError::unavailable("the page's debug session did not finish starting"));
        }
        session
            .conn
            .request_timeout(command, arguments, REQUEST_TIMEOUT)
            .await
            .map_err(|e| IdeError::unavailable(format!("the JavaScript debugger refused `{command}`: {e}")))
    }

    /// Breakpoints on events (`listener:click`, `instrumentation:setTimeout`) and on requests
    /// whose URL contains one of `xhr`. The lists replace the page's previous ones.
    pub async fn js_set_custom_breakpoints(
        &self,
        s: DebugSessionId,
        ids: Vec<String>,
        xhr: Vec<String>,
    ) -> IdeResult<()> {
        self.js_page_request(s, "setCustomBreakpoints", json!({ "ids": ids, "xhr": xhr })).await?;
        Ok(())
    }
}
