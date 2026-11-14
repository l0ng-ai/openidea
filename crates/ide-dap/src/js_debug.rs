//! Requests of vscode-js-debug's own, beyond the Debug Adapter Protocol: what a page in a
//! browser offers a debugger besides stepping (breakpoints on DOM events and requests).
//! Each is a typed method; a js-debug build that lacks one answers with an error, which is
//! reported as the feature being unavailable.

use crate::session::Session;
use crate::{DebugManager, DebugSessionId, REQUEST_TIMEOUT};
use ide_core::event::{JsInitiator, JsNetworkEvent, JsNetworkKind};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

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

    /// Starts recording the page's CPU profile; [`Self::js_stop_profile`] ends it.
    pub async fn js_start_profile(&self, s: DebugSessionId) -> IdeResult<()> {
        self.js_page_request(s, "startProfile", json!({ "type": "cpu" })).await?;
        Ok(())
    }

    /// Ends the recording and returns a new directory holding it as `page.cpuprofile`
    /// (what `ide-profiler` reads a directory of).
    pub async fn js_stop_profile(&self, s: DebugSessionId) -> IdeResult<PathBuf> {
        let session = self.session(s)?;
        // js-debug names the file it records into when the recording starts.
        let Some(recorded) = session.js_profile.lock().take() else {
            return Err(IdeError::invalid("no CPU profile is being recorded"));
        };
        self.js_page_request(s, "stopProfile", json!({})).await?;
        static HANDED_OVER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "openidea-js-profile-{}-{}-{}",
            std::process::id(),
            s.0,
            HANDED_OVER.fetch_add(1, Ordering::Relaxed)
        ));
        let copied = tokio::task::spawn_blocking({
            let dir = dir.clone();
            move || {
                std::fs::create_dir_all(&dir)?;
                std::fs::copy(&recorded, dir.join("page.cpuprofile"))?;
                // The adapter's own copy is in the system's temporary directory: no use keeping two.
                let _ = std::fs::remove_file(&recorded);
                Ok::<_, std::io::Error>(())
            }
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?;
        copied.map_err(|e| IdeError::unavailable(format!("the recorded CPU profile cannot be read: {e}")))?;
        Ok(dir)
    }
}

/// The browser events js-debug is asked to pass on (`enableNetworking`'s `mirrorEvents`).
pub(crate) const NETWORK_EVENTS: [&str; 4] =
    ["requestWillBeSent", "responseReceived", "loadingFinished", "loadingFailed"];

/// Response bodies shown are cut at this many bytes.
pub const RESPONSE_BODY_LIMIT: usize = 1_048_576;

/// The body of a response, as text or as the browser's base64 for binary content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsResponseBody {
    pub body: String,
    pub base64_encoded: bool,
    /// The body was longer than [`RESPONSE_BODY_LIMIT`] and is cut there.
    pub truncated: bool,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn headers(v: &Value) -> BTreeMap<String, String> {
    v.get("headers")
        .and_then(Value::as_object)
        .map(|h| h.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect())
        .unwrap_or_default()
}

/// The frame a request is attributed to: the innermost one outside `node_modules`, looked
/// for through the stacks that scheduled this one (an `await`, a timer), since a request sent
/// through a library has the library innermost. A stack of library frames only gives its first.
fn initiator(data: &Value) -> Option<JsInitiator> {
    let stack = data.pointer("/initiator/stack")?;
    let frames = |stack: &Value| stack.get("callFrames").and_then(Value::as_array).cloned().unwrap_or_default();
    let stacks = std::iter::successors(Some(stack), |stack| stack.get("parent")).take(32);
    let all: Vec<Value> = stacks.flat_map(frames).collect();
    let own = |frame: &&Value| {
        frame.get("url").and_then(Value::as_str).is_some_and(|url| !url.is_empty() && !url.contains("/node_modules/"))
    };
    let frame = all.iter().find(own).or(all.first())?;
    let number = |key: &str| frame.get(key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
    Some(JsInitiator {
        function: text(frame, "functionName").unwrap_or_default(),
        url: text(frame, "url")?,
        line: number("lineNumber"),
        column: number("columnNumber"),
    })
}

/// js-debug's `networkEvent` (`{event, data}`, `data` being the browser's own parameters of
/// that event) as a [`JsNetworkEvent`]; `None` for events the Network view has no use for.
pub(crate) fn network_event(body: &Value) -> Option<JsNetworkEvent> {
    let data = body.get("data")?;
    let kind = match body.get("event").and_then(Value::as_str)? {
        "requestWillBeSent" => JsNetworkKind::Request,
        "responseReceived" => JsNetworkKind::Response,
        "loadingFinished" => JsNetworkKind::Finished,
        "loadingFailed" => JsNetworkKind::Failed,
        _ => return None,
    };
    let part = match kind {
        JsNetworkKind::Request => data.get("request"),
        JsNetworkKind::Response => data.get("response"),
        _ => None,
    };
    let part = part.unwrap_or(&Value::Null);
    Some(JsNetworkEvent {
        kind,
        request_id: text(data, "requestId")?,
        // Seconds with a fraction.
        timestamp_ms: (data.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0).max(0.0) * 1000.0).round() as u64,
        url: text(part, "url"),
        method: text(part, "method"),
        resource_type: text(data, "type"),
        status: part.get("status").and_then(Value::as_u64).and_then(|s| u16::try_from(s).ok()),
        mime_type: text(part, "mimeType"),
        headers: headers(part),
        encoded_length: data.get("encodedDataLength").and_then(Value::as_f64).map(|n| n.max(0.0) as u64),
        error_text: text(data, "errorText"),
        initiator: if kind == JsNetworkKind::Request { initiator(data) } else { None },
    })
}

/// `networkCall getResponseBody`'s answer, cut at `limit` bytes on a character boundary.
fn response_body(answer: &Value, limit: usize) -> JsResponseBody {
    let mut body = text(answer, "body").unwrap_or_default();
    let truncated = body.len() > limit;
    if truncated {
        let mut end = limit;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        body.truncate(end);
    }
    JsResponseBody {
        body,
        base64_encoded: answer.get("base64Encoded").and_then(Value::as_bool).unwrap_or(false),
        truncated,
    }
}

/// The arguments of `enableNetworking`, which has a page report its requests
/// ([`ide_core::event::DebugEvent::JsNetwork`]). A page session sends it as it starts.
pub(crate) fn networking_arguments() -> Value {
    json!({ "mirrorEvents": NETWORK_EVENTS })
}

impl DebugManager {
    /// The body of the response to `request_id`, while the browser still has it.
    pub async fn js_response_body(&self, s: DebugSessionId, request_id: String) -> IdeResult<JsResponseBody> {
        let call = json!({ "method": "getResponseBody", "params": { "requestId": request_id } });
        let answer = self.js_page_request(s, "networkCall", call).await?;
        Ok(response_body(&answer, RESPONSE_BODY_LIMIT))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, data: Value) -> Option<ide_core::event::JsNetworkEvent> {
        network_event(&json!({ "event": kind, "data": data }))
    }

    #[test]
    fn a_request_carries_what_was_asked_and_who_asked() {
        let e = event(
            "requestWillBeSent",
            json!({
                "requestId": "76695.31", "timestamp": 611807.5, "type": "Fetch",
                "request": { "method": "GET", "url": "http://127.0.0.1:5195/src/main.ts", "headers": { "Accept": "*/*", "X-N": 1 } },
                "initiator": { "type": "script", "stack": { "callFrames": [
                    { "functionName": "load", "url": "http://127.0.0.1:5195/src/App.vue", "lineNumber": 9, "columnNumber": 2 }
                ] } }
            }),
        )
        .unwrap();
        assert_eq!(e.kind, JsNetworkKind::Request);
        assert_eq!((e.request_id.as_str(), e.timestamp_ms), ("76695.31", 611_807_500));
        assert_eq!(e.url.as_deref(), Some("http://127.0.0.1:5195/src/main.ts"));
        assert_eq!((e.method.as_deref(), e.resource_type.as_deref()), (Some("GET"), Some("Fetch")));
        // Only text headers are kept.
        assert_eq!(e.headers.len(), 1);
        assert_eq!(e.headers["Accept"], "*/*");
        let from = e.initiator.unwrap();
        assert_eq!((from.function.as_str(), from.line, from.column), ("load", 9, 2));
        assert_eq!(from.url, "http://127.0.0.1:5195/src/App.vue");
    }

    #[test]
    fn a_request_made_through_a_library_is_asked_by_the_code_that_called_the_library() {
        let frame = |function: &str, url: &str| json!({ "functionName": function, "url": url, "lineNumber": 1, "columnNumber": 0 });
        let lib = "http://localhost:5173/node_modules/.vite/deps/http-client.js";
        let asked_by = |stack: Value| {
            let data = json!({ "requestId": "1", "timestamp": 1.0, "request": { "method": "GET", "url": "http://localhost/api" },
                               "initiator": { "type": "script", "stack": stack } });
            event("requestWillBeSent", data).unwrap().initiator.unwrap().function
        };
        // The innermost frame is the library's; the project's caller is further out.
        let direct = json!({ "callFrames": [frame("dispatch", lib), frame("request", lib), frame("loadItems", "http://localhost:5173/src/api.ts")] });
        assert_eq!(asked_by(direct), "loadItems");
        // Across an `await`, the caller is in the stack that scheduled this one.
        let scheduled = json!({ "callFrames": [frame("dispatch", lib)],
            "parent": { "callFrames": [frame("then", lib)], "parent": { "callFrames": [frame("onMounted", "http://localhost:5173/src/App.vue")] } } });
        assert_eq!(asked_by(scheduled), "onMounted");
        // A library on its own: the frame that sent the request.
        assert_eq!(asked_by(json!({ "callFrames": [frame("dispatch", lib), frame("poll", lib)] })), "dispatch");
    }

    #[test]
    fn a_response_a_finish_and_a_failure_carry_their_outcome() {
        let response = event(
            "responseReceived",
            json!({ "requestId": "7", "timestamp": 2.0, "type": "Script", "response": {
                "url": "http://localhost/a.js", "status": 200, "mimeType": "text/javascript",
                "headers": { "Content-Type": "text/javascript" }
            } }),
        )
        .unwrap();
        assert_eq!(response.kind, JsNetworkKind::Response);
        assert_eq!((response.status, response.mime_type.as_deref()), (Some(200), Some("text/javascript")));
        assert_eq!(response.headers["Content-Type"], "text/javascript");

        let finished =
            event("loadingFinished", json!({ "requestId": "7", "timestamp": 2.5, "encodedDataLength": 1234 })).unwrap();
        assert_eq!((finished.kind, finished.encoded_length), (JsNetworkKind::Finished, Some(1234)));

        let failed =
            event("loadingFailed", json!({ "requestId": "8", "timestamp": 3.0, "errorText": "net::ERR_FAILED" }))
                .unwrap();
        assert_eq!((failed.kind, failed.error_text.as_deref()), (JsNetworkKind::Failed, Some("net::ERR_FAILED")));
    }

    #[test]
    fn events_that_name_no_request_or_are_not_mirrored_are_dropped() {
        assert!(event("requestWillBeSent", json!({ "timestamp": 1.0 })).is_none());
        assert!(event("dataReceived", json!({ "requestId": "7", "timestamp": 1.0 })).is_none());
        assert!(network_event(&json!({ "data": { "requestId": "7" } })).is_none());
        // A request made by the page's parser has no script behind it.
        let parser = event(
            "requestWillBeSent",
            json!({ "requestId": "9", "timestamp": 1.0, "request": { "method": "GET", "url": "http://localhost/" },
                    "initiator": { "type": "parser" } }),
        )
        .unwrap();
        assert!(parser.initiator.is_none());
    }

    #[test]
    fn a_response_body_is_cut_at_the_limit_on_a_character() {
        let whole = response_body(&json!({ "body": "héllo", "base64Encoded": false }), 100);
        assert_eq!((whole.body.as_str(), whole.base64_encoded, whole.truncated), ("héllo", false, false));
        // `é` is two bytes: a cut inside it backs off to the character before.
        let cut = response_body(&json!({ "body": "héllo" }), 2);
        assert_eq!((cut.body.as_str(), cut.truncated), ("h", true));
        let binary = response_body(&json!({ "body": "AAEC", "base64Encoded": true }), 100);
        assert!(binary.base64_encoded && !binary.truncated);
        assert_eq!(response_body(&json!({}), 100).body, "");
    }
}
