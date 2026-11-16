//! Replacing the responses a debugged page receives. js-debug hands out a WebSocket that
//! speaks the browser's own protocol (`requestCDPProxy`); over it the browser is told to hold
//! the requests whose URL matches a rule (`Fetch.enable`) and each held request is answered
//! here, with the rule's response or by letting it through.
//!
//! A held request stays held until it is answered, so interception is always switched off
//! (`Fetch.disable`) before the connection is given up: a page whose requests nobody answers hangs.

use crate::{DebugManager, DebugSessionId, REQUEST_TIMEOUT, js_debug};
use base64::Engine;
use futures::{SinkExt, StreamExt};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use std::collections::HashMap;
use tokio::sync::{oneshot, watch};
use tokio_tungstenite::tungstenite::{Message, http::StatusCode};

/// A response given in place of the server's to every request whose URL contains `url_contains`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsResponseRule {
    pub url_contains: String,
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

/// The browser's URL pattern (`*` any text, `?` one character, `\` escapes) for "contains `part`".
pub(crate) fn url_pattern(part: &str) -> String {
    let mut pattern = String::with_capacity(part.len() + 2);
    pattern.push('*');
    for c in part.chars() {
        if matches!(c, '*' | '?' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('*');
    pattern
}

pub(crate) fn rule_for<'a>(rules: &'a [JsResponseRule], url: &str) -> Option<&'a JsResponseRule> {
    rules.iter().find(|rule| url.contains(&rule.url_contains))
}

/// What to tell the browser about a request it holds: the first matching rule's response, or
/// to send the request on. Every held request gets one of the two.
pub(crate) fn answer(held: &Value, rules: &[JsResponseRule]) -> (&'static str, Value) {
    let request_id = held.get("requestId").and_then(Value::as_str).unwrap_or_default();
    let url = held.pointer("/request/url").and_then(Value::as_str).unwrap_or_default();
    let Some(rule) = rule_for(rules, url) else {
        return ("Fetch.continueRequest", json!({ "requestId": request_id }));
    };
    let header = |name: &str, value: &str| json!({ "name": name, "value": value });
    // A page on another origin only reads a response that names its origin. The server would
    // say so; the response given in its place has to.
    let mut cross_origin = Vec::new();
    if let Some(origin) = request_header(held, "Origin") {
        cross_origin.push(header("Access-Control-Allow-Origin", origin));
        cross_origin.push(header("Access-Control-Allow-Credentials", "true"));
    }
    let method = held.pointer("/request/method").and_then(Value::as_str).unwrap_or_default();
    // The browser's question before such a request: allowed here, the server may not exist.
    if method == "OPTIONS"
        && let Some(asked) = request_header(held, "Access-Control-Request-Method")
    {
        cross_origin.push(header("Access-Control-Allow-Methods", asked));
        if let Some(asked) = request_header(held, "Access-Control-Request-Headers") {
            cross_origin.push(header("Access-Control-Allow-Headers", asked));
        }
        let allowed = json!({
            "requestId": request_id,
            "responseCode": 204,
            "responsePhrase": phrase(204),
            "responseHeaders": cross_origin,
        });
        return ("Fetch.fulfillRequest", allowed);
    }
    let mut headers = vec![header("Content-Type", &rule.content_type)];
    headers.extend(cross_origin);
    let replaced = json!({
        "requestId": request_id,
        "responseCode": rule.status,
        "responsePhrase": phrase(rule.status),
        "responseHeaders": headers,
        "body": base64::engine::general_purpose::STANDARD.encode(rule.body.as_bytes()),
    });
    ("Fetch.fulfillRequest", replaced)
}

/// A header of the held request; the browser reports names as the page wrote them.
fn request_header<'a>(held: &'a Value, name: &str) -> Option<&'a str> {
    held.pointer("/request/headers")?.as_object()?.iter().find(|(key, _)| key.eq_ignore_ascii_case(name))?.1.as_str()
}

/// The browser refuses a response without a phrase when it has none of its own for the status.
fn phrase(status: u16) -> &'static str {
    StatusCode::from_u16(status).ok().and_then(|status| status.canonical_reason()).unwrap_or("Unknown")
}

fn interception(rules: &[JsResponseRule]) -> Value {
    let patterns: Vec<Value> = rules
        .iter()
        .map(|rule| json!({ "urlPattern": url_pattern(&rule.url_contains), "requestStage": "Request" }))
        .collect();
    json!({ "patterns": patterns })
}

/// Applies `rules` to the page behind js-debug's CDP proxy at `ws_url` until their sender is
/// dropped (the session is gone) or the proxy closes the connection. The browser holds
/// requests only while there are rules. `ready` hears whether the proxy reports held
/// requests at all; nothing is held before it has agreed to.
pub(crate) async fn serve(
    ws_url: String,
    mut rules: watch::Receiver<Vec<JsResponseRule>>,
    ready: oneshot::Sender<Result<(), String>>,
) {
    let socket = match tokio_tungstenite::connect_async(ws_url.as_str()).await {
        Ok((socket, _)) => socket,
        Err(e) => {
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };
    let (mut write, mut read) = socket.split();
    let mut last_id = 0u64;
    let mut call = |method: &str, params: Value| {
        last_id += 1;
        (last_id, Message::text(json!({ "id": last_id, "method": method, "params": params }).to_string()))
    };

    let (subscription, subscribe) = call("JsDebug.subscribe", json!({ "events": ["Fetch.requestPaused"] }));
    let subscribed = tokio::time::timeout(REQUEST_TIMEOUT, async {
        write.send(subscribe).await.map_err(|e| e.to_string())?;
        loop {
            let reply = read.next().await.ok_or("the connection closed")?.map_err(|e| e.to_string())?;
            let Some(reply) = reply.to_text().ok().and_then(|text| serde_json::from_str::<Value>(text).ok()) else {
                continue;
            };
            if reply.get("id").and_then(Value::as_u64) != Some(subscription) {
                continue;
            }
            break match reply.get("error") {
                Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("refused").to_owned()),
                None => Ok(()),
            };
        }
    })
    .await
    .unwrap_or_else(|_| Err("no answer".to_owned()));
    if let Err(why) = subscribed {
        let _ = ready.send(Err(why));
        let _ = write.close().await;
        return;
    }
    let _ = ready.send(Ok(()));

    let mut current = rules.borrow_and_update().clone();
    let mut holding = !current.is_empty();
    if holding && write.send(call("Fetch.enable", interception(&current)).1).await.is_err() {
        return;
    }
    // The request each sent replacement is for, by command id, until the browser has taken it.
    let mut replacing: HashMap<u64, String> = HashMap::new();
    loop {
        tokio::select! {
            changed = rules.changed() => {
                if changed.is_err() {
                    break;
                }
                current = rules.borrow_and_update().clone();
                let (_, command) = match (current.is_empty(), holding) {
                    (true, false) => continue,
                    (true, true) => call("Fetch.disable", json!({})),
                    (false, _) => call("Fetch.enable", interception(&current)),
                };
                holding = !current.is_empty();
                if write.send(command).await.is_err() {
                    return;
                }
            }
            message = read.next() => {
                // The proxy closed (the page or the session ended): nothing is held any more.
                let Some(Ok(message)) = message else { return };
                let Ok(text) = message.to_text() else { continue };
                let Ok(message) = serde_json::from_str::<Value>(text) else { continue };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    // The browser did not take the replacement: let the request through, or
                    // it stays held and the page waits for it.
                    if let Some(request_id) = replacing.remove(&id)
                        && message.get("error").is_some()
                    {
                        let (_, go_on) = call("Fetch.continueRequest", json!({ "requestId": request_id }));
                        if write.send(go_on).await.is_err() {
                            return;
                        }
                    }
                    continue;
                }
                if message.get("method").and_then(Value::as_str) != Some("Fetch.requestPaused") {
                    continue;
                }
                let Some(held) = message.get("params") else { continue };
                let Some(request_id) = held.get("requestId").and_then(Value::as_str) else { continue };
                let (method, params) = answer(held, &current);
                let (id, command) = call(method, params);
                if method == "Fetch.fulfillRequest" {
                    replacing.insert(id, request_id.to_owned());
                }
                if write.send(command).await.is_err() {
                    return;
                }
            }
        }
    }
    if holding {
        let _ = write.send(call("Fetch.disable", json!({})).1).await;
    }
    let _ = write.close().await;
}

impl DebugManager {
    /// Makes `rules` the page's response rules; none switches the replacing off. The first
    /// rules of a session open the connection to js-debug's CDP proxy, later ones go over it.
    /// An error means the rules are not applied.
    pub async fn js_set_response_overrides(&self, s: DebugSessionId, rules: Vec<JsResponseRule>) -> IdeResult<()> {
        let session = self.session(s)?;
        if !js_debug::is_page(&session) {
            return Err(IdeError::unavailable("this debug session is not a page in a browser"));
        }
        // Held to the end: two callers at once would each open a connection.
        let mut applied = session.js_overrides.lock().await;
        if applied.as_ref().is_some_and(|sender| sender.send(rules.clone()).is_ok()) {
            return Ok(());
        }
        // No connection yet, or the proxy closed it.
        applied.take();
        if rules.is_empty() {
            return Ok(());
        }
        let refused =
            |why: String| IdeError::unavailable(format!("the JavaScript debugger has no browser connection: {why}"));
        if !js_debug::launched(&session).await {
            return Err(refused("the page's debug session did not finish starting".into()));
        }
        let proxy = session
            .conn
            .request_timeout("requestCDPProxy", json!({}), REQUEST_TIMEOUT)
            .await
            .map_err(|e| refused(e.to_string()))?;
        let (Some(host), Some(port)) =
            (proxy.get("host").and_then(Value::as_str), proxy.get("port").and_then(Value::as_u64))
        else {
            return Err(refused("no address".into()));
        };
        let path = proxy.get("path").and_then(Value::as_str).unwrap_or_default();
        let (sender, receiver) = watch::channel(rules);
        let (ready, is_ready) = oneshot::channel();
        tokio::spawn(serve(format!("ws://{host}:{port}{path}"), receiver, ready));
        match is_ready.await {
            Ok(Ok(())) => {
                *applied = Some(sender);
                Ok(())
            }
            Ok(Err(why)) => Err(refused(why)),
            Err(_) => Err(refused("no answer".into())),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use futures::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;

    pub(crate) fn rule(url_contains: &str, status: u16, body: &str) -> JsResponseRule {
        JsResponseRule {
            url_contains: url_contains.into(),
            status,
            content_type: "application/json".into(),
            body: body.into(),
        }
    }

    #[test]
    fn a_part_of_a_url_becomes_a_pattern_that_matches_it_anywhere() {
        assert_eq!(url_pattern("api/items"), "*api/items*");
        // The pattern's own wildcards and escape character are taken literally.
        assert_eq!(url_pattern(r"a*b?c\d"), r"*a\*b\?c\\d*");
    }

    #[test]
    fn the_first_rule_whose_text_is_in_the_url_answers() {
        let rules = [rule("api/items", 201, "{\"a\":\"é\"}"), rule("api", 500, "later")];
        assert_eq!(rule_for(&rules, "http://h/api/items?x=1").map(|r| r.status), Some(201));
        assert_eq!(rule_for(&rules, "http://h/api/users").map(|r| r.status), Some(500));
        assert!(rule_for(&rules, "http://h/logo.png").is_none());

        let (command, params) = answer(&held("7", "http://h/api/items")["params"], &rules);
        assert_eq!(command, "Fetch.fulfillRequest");
        assert_eq!(
            params,
            json!({
                "requestId": "7",
                "responseCode": 201,
                "responsePhrase": "Created",
                "responseHeaders": [{ "name": "Content-Type", "value": "application/json" }],
                // base64 of the UTF-8 text `{"a":"é"}`
                "body": "eyJhIjoiw6kifQ==",
            })
        );
        // A request the browser held that no rule is for goes on to the network.
        assert_eq!(
            answer(&held("8", "http://h/logo.png")["params"], &rules),
            ("Fetch.continueRequest", json!({ "requestId": "8" }))
        );
    }

    #[test]
    fn a_status_the_browser_has_no_phrase_for_is_given_one() {
        // The browser refuses a response whose status it cannot name.
        let (_, params) = answer(&held("1", "http://h/api")["params"], &[rule("api", 419, "")]);
        assert_eq!((&params["responseCode"], &params["responsePhrase"]), (&json!(419), &json!("Unknown")));
    }

    fn header<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
        params["responseHeaders"].as_array()?.iter().find(|h| h["name"] == name)?["value"].as_str()
    }

    #[test]
    fn a_replaced_response_passes_the_pages_cross_origin_check() {
        let rules = [rule("api/items", 200, "[]")];
        let from_page = |method: &str, headers: Value| json!({ "requestId": "3", "request": { "url": "http://localhost:8080/api/items", "method": method, "headers": headers } });
        // A page on another origin: the response names that origin, as the real server would.
        let (_, params) = answer(&from_page("GET", json!({ "origin": "http://localhost:5173" })), &rules);
        assert_eq!(header(&params, "Access-Control-Allow-Origin"), Some("http://localhost:5173"));
        assert_eq!(header(&params, "Access-Control-Allow-Credentials"), Some("true"));
        assert_eq!(params["body"], "W10=");

        // The browser's question before such a request is answered too: the server may not exist.
        let preflight = from_page(
            "OPTIONS",
            json!({
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "PUT",
                "Access-Control-Request-Headers": "content-type,x-token",
            }),
        );
        let (command, params) = answer(&preflight, &rules);
        assert_eq!((command, &params["responseCode"]), ("Fetch.fulfillRequest", &json!(204)));
        assert_eq!(header(&params, "Access-Control-Allow-Origin"), Some("http://localhost:5173"));
        assert_eq!(header(&params, "Access-Control-Allow-Methods"), Some("PUT"));
        assert_eq!(header(&params, "Access-Control-Allow-Headers"), Some("content-type,x-token"));
        assert_eq!(params.get("body"), None);

        // Same origin: nothing but the rule's own header.
        let (_, params) = answer(&from_page("GET", json!({})), &rules);
        assert_eq!(params["responseHeaders"], json!([{ "name": "Content-Type", "value": "application/json" }]));
    }

    /// A stand-in for js-debug's CDP proxy: what it receives, and a way to send it events.
    pub(crate) async fn proxy() -> (String, mpsc::UnboundedReceiver<Value>, mpsc::UnboundedSender<Value>) {
        proxy_refusing(|_| false).await
    }

    /// A proxy that answers the commands `refused` picks with an error, like the real one does
    /// for what it or the browser does not accept.
    pub(crate) async fn proxy_refusing(
        refused: fn(&Value) -> bool,
    ) -> (String, mpsc::UnboundedReceiver<Value>, mpsc::UnboundedSender<Value>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://127.0.0.1:{}/session", listener.local_addr().unwrap().port());
        let (received_tx, received) = mpsc::unbounded_channel();
        let (events, mut events_rx) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut write, mut read) = tokio_tungstenite::accept_async(stream).await.unwrap().split();
            loop {
                tokio::select! {
                    message = read.next() => {
                        let Some(Ok(message)) = message else { break };
                        let Ok(text) = message.to_text() else { continue };
                        let Ok(request) = serde_json::from_str::<Value>(text) else { continue };
                        let reply = if refused(&request) {
                            json!({ "id": request["id"], "error": { "code": -32602, "message": "refused" } })
                        } else {
                            json!({ "id": request["id"], "result": {} })
                        };
                        let _ = write.send(Message::text(reply.to_string())).await;
                        let _ = received_tx.send(request);
                    }
                    Some(event) = events_rx.recv() => {
                        let _ = write.send(Message::text(event.to_string())).await;
                    }
                }
            }
        });
        (url, received, events)
    }

    pub(crate) async fn next(received: &mut mpsc::UnboundedReceiver<Value>) -> (String, Value) {
        let request = tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
            .await
            .expect("the proxy got a request in time")
            .expect("the connection is open");
        (request["method"].as_str().unwrap().to_owned(), request["params"].clone())
    }

    /// The browser's event for a request it holds.
    fn held(request_id: &str, url: &str) -> Value {
        json!({ "method": "Fetch.requestPaused", "params": { "requestId": request_id, "request": { "url": url } } })
    }

    type Serving = (tokio::task::JoinHandle<()>, oneshot::Receiver<Result<(), String>>);

    fn serving(url: String, rules: watch::Receiver<Vec<JsResponseRule>>) -> Serving {
        let (ready, is_ready) = oneshot::channel();
        (tokio::spawn(serve(url, rules, ready)), is_ready)
    }

    async fn ended(task: tokio::task::JoinHandle<()>) {
        tokio::time::timeout(std::time::Duration::from_secs(5), task).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn held_requests_are_answered_and_interception_ends_before_the_connection() {
        let (url, mut received, events) = proxy().await;
        let (rules, watched) = tokio::sync::watch::channel(vec![rule("api/items", 200, "[]")]);
        let (serving, ready) = serving(url, watched);
        assert_eq!(ready.await.unwrap(), Ok(()));

        assert_eq!(
            next(&mut received).await,
            ("JsDebug.subscribe".into(), json!({ "events": ["Fetch.requestPaused"] }))
        );
        assert_eq!(
            next(&mut received).await,
            (
                "Fetch.enable".into(),
                json!({ "patterns": [{ "urlPattern": "*api/items*", "requestStage": "Request" }] })
            )
        );

        events.send(held("1", "http://h/api/items")).unwrap();
        let (command, params) = next(&mut received).await;
        assert_eq!(
            (command.as_str(), &params["requestId"], &params["responseCode"]),
            ("Fetch.fulfillRequest", &json!("1"), &json!(200))
        );
        events.send(held("2", "http://h/other")).unwrap();
        assert_eq!(next(&mut received).await, ("Fetch.continueRequest".into(), json!({ "requestId": "2" })));

        // New rules replace the browser's patterns.
        rules.send(vec![rule("api/users", 404, "{}")]).unwrap();
        assert_eq!(
            next(&mut received).await,
            (
                "Fetch.enable".into(),
                json!({ "patterns": [{ "urlPattern": "*api/users*", "requestStage": "Request" }] })
            )
        );

        // No rules left: the browser stops holding requests. The connection stays for the
        // rules that come next, and goes with the session.
        rules.send(Vec::new()).unwrap();
        assert_eq!(next(&mut received).await.0, "Fetch.disable");
        rules.send(vec![rule("api/items", 200, "[]")]).unwrap();
        assert_eq!(next(&mut received).await.0, "Fetch.enable");
        rules.send(Vec::new()).unwrap();
        assert_eq!(next(&mut received).await.0, "Fetch.disable");
        drop(rules);
        ended(serving).await;
        // Already off: not switched off a second time.
        assert!(received.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_session_that_goes_away_switches_interception_off() {
        let (url, mut received, _events) = proxy().await;
        let (rules, watched) = tokio::sync::watch::channel(vec![rule("api", 200, "[]")]);
        let (serving, _ready) = serving(url, watched);
        assert_eq!(next(&mut received).await.0, "JsDebug.subscribe");
        assert_eq!(next(&mut received).await.0, "Fetch.enable");
        drop(rules);
        assert_eq!(next(&mut received).await.0, "Fetch.disable");
        ended(serving).await;
    }

    #[tokio::test]
    async fn a_response_the_browser_refuses_lets_the_request_through() {
        let (url, mut received, events) = proxy_refusing(|request| request["method"] == "Fetch.fulfillRequest").await;
        let (_rules, watched) = tokio::sync::watch::channel(vec![rule("api", 200, "[]")]);
        let (_serving, _ready) = serving(url, watched);
        assert_eq!(next(&mut received).await.0, "JsDebug.subscribe");
        assert_eq!(next(&mut received).await.0, "Fetch.enable");
        events.send(held("9", "http://h/api")).unwrap();
        assert_eq!(next(&mut received).await.0, "Fetch.fulfillRequest");
        // Unanswered, the request would hang the page.
        assert_eq!(next(&mut received).await, ("Fetch.continueRequest".into(), json!({ "requestId": "9" })));
    }

    #[tokio::test]
    async fn a_proxy_that_does_not_report_held_requests_is_not_asked_to_hold_any() {
        let (url, mut received, _events) = proxy_refusing(|request| request["method"] == "JsDebug.subscribe").await;
        let (_rules, watched) = tokio::sync::watch::channel(vec![rule("api", 200, "[]")]);
        let (serving, ready) = serving(url, watched);
        assert_eq!(next(&mut received).await.0, "JsDebug.subscribe");
        assert_eq!(ready.await.unwrap(), Err("refused".to_owned()));
        ended(serving).await;
        assert!(received.try_recv().is_err());
    }

    #[tokio::test]
    async fn no_connection_to_the_proxy_is_reported() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://127.0.0.1:{}/session", listener.local_addr().unwrap().port());
        drop(listener);
        let (_rules, watched) = tokio::sync::watch::channel(vec![rule("api", 200, "[]")]);
        let (serving, ready) = serving(url, watched);
        assert!(ready.await.unwrap().is_err());
        ended(serving).await;
    }
}
