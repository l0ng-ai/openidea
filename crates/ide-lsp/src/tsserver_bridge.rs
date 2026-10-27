//! Vue Language Server (Volar 3) runs in "hybrid mode": TypeScript work goes to
//! tsserver with `@vue/typescript-plugin`, through the client. It sends
//! `tsserver/request` `[id, command, args]` and waits for `tsserver/response`
//! `[id, body]`; the client forwards the command to vtsls, whose tsserver has the
//! plugin loaded (`typescript.tsserverRequest`). Without an answer the server
//! waits forever, so every request is answered — `null` when vtsls can't.

use crate::LspManager;
use crate::server::Server;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

/// The server that hosts tsserver for the bridge.
pub(crate) const TSSERVER_HOST: &str = "vtsls";
const HOST_START_WAIT: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// `[id, command, args]` items of a `tsserver/request` notification
/// (vscode-jsonrpc wraps the single array argument: `[[id, command, args]]`).
pub(crate) fn parse_requests(params: &Value) -> Vec<(Value, String, Value)> {
    let one = |v: &Value| {
        let a = v.as_array()?;
        let command = a.get(1)?.as_str()?.to_owned();
        Some((a.first()?.clone(), command, a.get(2).cloned().unwrap_or(Value::Null)))
    };
    match params.as_array() {
        Some(items) if items.first().is_some_and(Value::is_array) => items.iter().filter_map(one).collect(),
        Some(_) => one(params).into_iter().collect(),
        None => Vec::new(),
    }
}

impl LspManager {
    /// Answers `tsserver/request`s of `from` (instance `generation`) via [`TSSERVER_HOST`].
    pub(crate) fn forward_tsserver_requests(&self, from: Arc<Server>, generation: u64, params: Value) {
        let Some(me) = self.me.upgrade() else { return };
        for (id, command, args) in parse_requests(&params) {
            let me = me.clone();
            let from = from.clone();
            self.runtime.spawn(async move {
                let body = me.tsserver_request(&from, &command, args).await.unwrap_or(Value::Null);
                if let Some(run) = from.running_gen(generation)
                    && let Err(e) = run.peer.notify("tsserver/response", json!([[id, body]]))
                {
                    tracing::debug!("{}: tsserver/response: {e}", from.name);
                }
            });
        }
    }

    async fn tsserver_request(&self, from: &Server, command: &str, args: Value) -> Option<Value> {
        let host = self
            .servers
            .lock()
            .iter()
            .filter(|s| s.name == TSSERVER_HOST)
            .min_by_key(|s| s.root != from.root)
            .cloned()?;
        let run = host.wait_ready(HOST_START_WAIT).await?;
        let params = json!({
            "command": "typescript.tsserverRequest",
            "arguments": [command, args, { "isAsync": true, "lowPriority": true }],
        });
        let request = run.peer.request::<_, Value>("workspace/executeCommand", params, None);
        match tokio::time::timeout(REQUEST_TIMEOUT, request).await {
            Ok(Ok(result)) => result.get("body").cloned(),
            Ok(Err(e)) => {
                tracing::debug!("{TSSERVER_HOST}: {command}: {e}");
                None
            }
            Err(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wrapped_and_bare_requests() {
        let wrapped = json!([[1, "_vue:projectInfo", { "file": "/p/App.vue" }]]);
        assert_eq!(
            parse_requests(&wrapped),
            vec![(json!(1), "_vue:projectInfo".to_owned(), json!({ "file": "/p/App.vue" }))]
        );
        let bare = json!([2, "_vue:getComponentNames", ["/p/App.vue"]]);
        assert_eq!(parse_requests(&bare), vec![(json!(2), "_vue:getComponentNames".to_owned(), json!(["/p/App.vue"]))]);
        assert!(parse_requests(&json!({ "id": 1 })).is_empty());
        assert!(parse_requests(&json!([[3]])).is_empty());
    }
}
