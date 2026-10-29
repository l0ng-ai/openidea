//! The Codex shim against codex transcripts: frames recorded from the real
//! `codex app-server` (`record_codex_fixtures`, ignored) or written by hand where a
//! recording isn't possible, played back by a fake codex.
//!
//! A transcript is JSONL: a `{"type":"meta",…}` line, then `{"dir":"out","frame":…}` for
//! each frame the shim sent and `{"dir":"in","frame":…}` for each frame codex sent.

use super::translate::*;
use super::*;
use std::collections::VecDeque;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

// ---- Pure translations -------------------------------------------------------------

fn models() -> Vec<ModelInfo> {
    models_of(&json!({"data": [
        {"id": "big", "model": "big", "displayName": "Big", "description": "d", "hidden": false, "isDefault": true,
         "defaultReasoningEffort": "low",
         "supportedReasoningEfforts": [{"reasoningEffort": "low", "description": "fast"}, {"reasoningEffort": "xhigh", "description": ""}]},
        {"id": "plain", "model": "plain-slug", "displayName": "", "description": "", "hidden": false, "isDefault": false,
         "supportedReasoningEfforts": []},
        {"id": "secret", "model": "secret", "displayName": "S", "description": "", "hidden": true, "isDefault": false,
         "supportedReasoningEfforts": []}
    ]}))
}

#[test]
fn settings_follow_the_thread_and_the_models() {
    let models = models();
    let result = json!({"model": "big", "reasoningEffort": null, "approvalPolicy": "untrusted",
        "sandbox": {"type": "workspaceWrite"}});
    let mut s = Settings::of(&result, &models);
    assert_eq!(s, Settings { model: "big".into(), effort: Some("low".into()), mode: Mode::Ask });

    let options = config_options(&models, &s);
    let ids: Vec<&str> = options.as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [MODEL, EFFORT, MODE]);
    assert_eq!(options[0]["options"].as_array().unwrap().len(), 2, "hidden models are left out");
    assert_eq!(options[1]["category"], "thought_level");
    assert_eq!(options[1]["options"][1]["name"], "Extra high");
    assert_eq!(options[2]["currentValue"], "ask");

    // A model without efforts drops the option; its slug is what codex gets.
    s.set(&models, MODEL, "plain").unwrap();
    assert_eq!((s.effort.as_deref(), s.model_slug(&models).as_str()), (None, "plain-slug"));
    assert_eq!(config_options(&models, &s).as_array().unwrap().len(), 2);
    assert!(s.set(&models, EFFORT, "low").is_err());
    assert!(s.set(&models, MODEL, "nope").is_err());
    s.set(&models, MODE, "full-access").unwrap();
    assert_eq!((s.mode.approval_policy(), s.mode.sandbox_policy()), ("never", json!({"type": "dangerFullAccess"})));

    // A model codex runs that it doesn't list is still offered.
    let s = Settings::of(&json!({"model": "custom", "sandbox": {"type": "readOnly"}}), &models);
    assert_eq!(s.mode, Mode::ReadOnly);
    let options = config_options(&models, &s);
    assert_eq!(options[0]["options"][2], json!({"value": "custom", "name": "custom"}));
}

#[test]
fn prompts_become_user_input() {
    let input = user_input(&json!([
        {"type": "text", "text": "fix it"},
        {"type": "resource", "resource": {"uri": "file:///p/a%20b.rs", "text": "fn x() {}"}},
        {"type": "resource_link", "uri": "file:///p/big.bin", "name": "big.bin"},
        {"type": "image", "mimeType": "image/jpeg", "data": "AAA"},
        {"type": "audio", "data": "x"}
    ]));
    assert_eq!(
        input,
        vec![
            json!({"type": "text", "text": "fix it"}),
            json!({"type": "text", "text": "<file path=\"/p/a b.rs\">\nfn x() {}\n</file>"}),
            json!({"type": "text", "text": "/p/big.bin"}),
            json!({"type": "image", "url": "data:image/jpeg;base64,AAA"}),
        ]
    );
}

#[test]
fn commands_are_titled_by_what_they_do() {
    let cmd = |actions: Value| {
        json!({"id": "c", "type": "commandExecution", "command": "/bin/zsh -lc 'x'", "cwd": "/p",
            "status": "inProgress", "commandActions": actions})
    };
    let call = tool_call(
        &cmd(json!([{"type": "read", "command": "cat a.rs", "name": "a.rs", "path": "/p/a.rs"}])),
        false,
        Some("/p"),
        None,
    )
    .unwrap();
    assert_eq!((call["title"].as_str(), call["kind"].as_str()), (Some("Read a.rs"), Some("read")));
    assert_eq!(call["locations"], json!([{"path": "/p/a.rs"}]));
    let call = tool_call(
        &cmd(json!([{"type": "search", "command": "rg x src", "query": "x", "path": "/p/src"}])),
        false,
        Some("/p"),
        None,
    )
    .unwrap();
    assert_eq!(call["title"], "Search x in src");
    let call = tool_call(&cmd(json!([{"type": "unknown", "command": "cargo test"}])), false, None, Some("ok")).unwrap();
    assert_eq!(
        (call["title"].as_str(), call["kind"].as_str(), call["status"].as_str()),
        (Some("cargo test"), Some("execute"), Some("in_progress"))
    );
    assert_eq!(call["content"][0]["content"]["text"], "ok");

    let mut done = cmd(json!([]));
    done["status"] = json!("declined");
    done["exitCode"] = json!(1);
    let call = tool_call(&done, true, None, None).unwrap();
    assert_eq!((call["sessionUpdate"].as_str(), call["status"].as_str()), (Some("tool_call_update"), Some("failed")));
    assert_eq!(call["title"], "/bin/zsh -lc 'x'");
    assert_eq!(call["rawOutput"], json!({"exitCode": 1}));
}

#[test]
fn file_changes_carry_diffs() {
    let item = json!({"id": "f", "type": "fileChange", "status": "completed", "changes": [
        {"path": "/p/new.txt", "kind": {"type": "add"}, "diff": "hello\n"},
        {"path": "/p/a.rs", "kind": {"type": "update", "move_path": null},
         "diff": "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -9 +9,2 @@\n-z\n+y\n+w\n\\ No newline at end of file\n"},
        {"path": "/p/old.rs", "kind": {"type": "delete"}, "diff": "gone\n"}
    ]});
    let call = tool_call(&item, true, Some("/p"), None).unwrap();
    assert_eq!(
        (call["title"].as_str(), call["kind"].as_str(), call["status"].as_str()),
        (Some("Edit 3 files"), Some("edit"), Some("completed"))
    );
    assert_eq!(
        call["content"],
        json!([
            {"type": "diff", "path": "/p/new.txt", "oldText": "", "newText": "hello\n"},
            {"type": "diff", "path": "/p/a.rs", "oldText": "a\nb\nc\nz\n", "newText": "a\nB\nc\ny\nw\n"},
            {"type": "diff", "path": "/p/old.rs", "oldText": "gone\n", "newText": ""}
        ])
    );
    let one = json!({"id": "f", "type": "fileChange", "status": "inProgress", "changes": [
        {"path": "/p/a.rs", "kind": {"type": "update", "move_path": "/p/b.rs"}, "diff": "@@ -1 +1 @@\n-x\n+y\n"}]});
    let call = tool_call(&one, false, Some("/p"), None).unwrap();
    assert_eq!((call["title"].as_str(), call["kind"].as_str()), (Some("Move a.rs to b.rs"), Some("move")));
    assert_eq!(call["content"][0]["path"], "/p/b.rs");
    assert_eq!(file_approval_title(Some(&one), Some("/p")), "Move a.rs to b.rs");
}

#[test]
fn other_items() {
    let search = json!({"id": "w", "type": "webSearch", "query": "", "action": null});
    assert_eq!(tool_call(&search, false, None, None).unwrap()["title"], "Search the web");
    let search =
        json!({"id": "w", "type": "webSearch", "query": "rust", "action": {"type": "search", "query": "rust"}});
    let call = tool_call(&search, true, None, None).unwrap();
    assert_eq!(
        (call["title"].as_str(), call["status"].as_str(), call["kind"].as_str()),
        (Some("Search the web: rust"), Some("completed"), Some("fetch"))
    );
    let mcp = json!({"id": "m", "type": "mcpToolCall", "server": "gh", "tool": "issue", "status": "failed",
        "arguments": {"n": 1}, "result": {"content": [{"type": "text", "text": "partial"}]}, "error": {"message": "boom"}});
    let call = tool_call(&mcp, true, None, None).unwrap();
    assert_eq!(call["title"], "gh: issue");
    assert_eq!(call["content"][1]["content"]["text"], "boom");
    assert_eq!(call["rawInput"], json!({"n": 1}));
    for skipped in ["agentMessage", "reasoning", "userMessage", "subAgentActivity"] {
        assert!(tool_call(&json!({"id": "x", "type": skipped}), false, None, None).is_none());
    }
    let spawn = json!({"id": "x", "type": "collabAgentToolCall", "tool": "spawnAgent", "status": "completed"});
    assert!(tool_call(&spawn, true, None, None).is_none());

    let plan = plan(&json!({"plan": [{"step": "a", "status": "completed"}, {"step": "b", "status": "inProgress"}]}));
    assert_eq!(plan["entries"][1], json!({"content": "b", "priority": "medium", "status": "in_progress"}));
    let u = usage(
        &json!({"tokenUsage": {"last": {"totalTokens": 20}, "total": {"totalTokens": 99}, "modelContextWindow": 1000}}),
    );
    assert_eq!(u, Some(json!({"sessionUpdate": "usage_update", "used": 20, "size": 1000})));
    assert!(usage(&json!({"tokenUsage": {"last": {"totalTokens": 20}, "modelContextWindow": null}})).is_none());
    assert_eq!(reasoning_text(&json!({"summary": ["a", "b"], "content": ["raw"]})), "a\n\nb");
    assert!(tail(&"é".repeat(MAX_OUTPUT)).starts_with('…'));
}

#[test]
fn failures_are_classified() {
    let limits = json!({"primary": {"usedPercent": 100, "resetsAt": 1_800_000_000}, "secondary": {"usedPercent": 40, "resetsAt": 1_900_000_000}});
    let e = json!({"message": "You've hit your usage limit.", "codexErrorInfo": "usageLimitExceeded"});
    assert_eq!(classify(&e, Some(&limits)), Failure::UsageLimit(Some(1.8e12)));
    assert_eq!(classify(&e, None), Failure::UsageLimit(None));
    let e = json!({"message": "x", "codexErrorInfo": {"responseTooManyFailedAttempts": {"httpStatusCode": 429}}});
    assert_eq!(classify(&e, None), Failure::UsageLimit(None));
    assert_eq!(classify(&json!({"message": "x", "codexErrorInfo": "unauthorized"}), None), Failure::Auth);
    let e = json!({"message": "unexpected status 401 Unauthorized: Missing bearer", "codexErrorInfo": "other"});
    assert_eq!(classify(&e, None), Failure::Auth);
    assert_eq!(classify(&json!({"message": "no", "codexErrorInfo": "cyberPolicy"}), None), Failure::Refusal);
    assert_eq!(
        classify(&json!({"message": "too long", "codexErrorInfo": "contextWindowExceeded"}), None),
        Failure::Other
    );
    assert_eq!(error_message(&json!({"message": "Failed", "additionalDetails": "because"})), "Failed\nbecause");

    let usage_limit = stop_reason(
        &json!({"status": "failed", "error": null}),
        Some(json!({"message": "limit", "codexErrorInfo": "usageLimitExceeded"})),
        Some(&limits),
    )
    .unwrap_err();
    assert_eq!(usage_limit.data, Some(json!({"openidea": {"usageLimit": {"resetsAtMs": 1.8e12}}})));
    assert_eq!(stop_reason(&json!({"status": "interrupted"}), None, None).unwrap(), json!({"stopReason": "cancelled"}));
}

#[test]
fn approvals_offer_what_codex_offers_and_always_a_decline() {
    let params = json!({"availableDecisions": ["accept",
        {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["/bin/bash", "-lc", "make"]}},
        {"applyNetworkPolicyAmendment": {"network_policy_amendment": {"host": "crates.io", "action": "allow"}}},
        "cancel"]});
    let choices = decisions(&params, true);
    let options: Vec<(&str, &str, &str)> = choices
        .iter()
        .map(|c| {
            (
                c.option["optionId"].as_str().unwrap(),
                c.option["name"].as_str().unwrap(),
                c.option["kind"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        options,
        [
            ("accept", "Allow once", "allow_once"),
            ("acceptWithExecpolicyAmendment", "Always allow `make`", "allow_always"),
            ("applyNetworkPolicyAmendment:allow:crates.io", "Always allow crates.io", "allow_always"),
            ("decline", "Decline", "reject_once"),
            ("cancel", "Decline and stop", "reject_once"),
        ]
    );
    let selected = |id: &str| json!({"outcome": {"outcome": "selected", "optionId": id}});
    let decline = json!({"decision": "decline"});
    assert_eq!(
        answer_of(&choices, &selected("acceptWithExecpolicyAmendment"), decline.clone()),
        json!({"decision": params["availableDecisions"][1]})
    );
    assert_eq!(answer_of(&choices, &json!({"outcome": {"outcome": "cancelled"}}), decline.clone()), decline);
    assert_eq!(answer_of(&choices, &selected("zzz"), decline.clone()), decline);
    let ids: Vec<Value> = decisions(&json!({}), false).iter().map(|c| c.option["optionId"].clone()).collect();
    assert_eq!(ids, [json!("accept"), json!("acceptForSession"), json!("decline"), json!("cancel")]);
    assert_eq!(
        command_approval_title(
            &json!({"command": "/bin/zsh -lc 'ls'", "commandActions": [{"type": "unknown", "command": "touch b"}]}),
            None,
            None
        ),
        "Run touch b"
    );
}

#[test]
fn history_replays_turns() {
    let thread = json!({"turns": [{"id": "t", "status": "completed", "items": [
        {"type": "userMessage", "id": "u", "content": [{"type": "text", "text": "hi"}]},
        {"type": "reasoning", "id": "r", "summary": ["think"]},
        {"type": "agentMessage", "id": "a", "text": "hello"},
        {"type": "commandExecution", "id": "c", "command": "ls", "cwd": "/p", "status": "completed",
         "commandActions": [], "aggregatedOutput": "a.txt\n", "exitCode": 0}
    ]}]});
    let updates = history(&thread, Some("/p"));
    let kinds: Vec<&str> = updates.iter().map(|u| u["sessionUpdate"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        ["user_message_chunk", "agent_thought_chunk", "agent_message_chunk", "tool_call", "tool_call_update"]
    );
    assert_eq!(updates[4]["status"], "completed");
}

// ---- Transcripts ---------------------------------------------------------------------

/// The ACP client: records updates and answers permission requests in order.
#[derive(Default)]
struct Client {
    updates: Mutex<Vec<Value>>,
    asked: Mutex<Vec<Value>>,
    /// Option ids to choose; `None` (or none left) cancels.
    answers: Mutex<VecDeque<Option<&'static str>>>,
}

impl Handler for Client {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/update" {
            self.updates.lock().push(params);
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        assert_eq!(method, "session/request_permission");
        self.asked.lock().push(params);
        Ok(match self.answers.lock().pop_front().flatten() {
            Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        })
    }
}

impl Client {
    /// The updates of `session`, as `(sessionUpdate, update)`.
    fn of(&self, session: &str) -> Vec<Value> {
        self.updates.lock().iter().filter(|u| u["sessionId"] == session).map(|u| u["update"].clone()).collect()
    }

    /// The text of the `kind` chunks of `session`.
    fn text(&self, session: &str, kind: &str) -> String {
        self.of(session)
            .iter()
            .filter(|u| u["sessionUpdate"] == kind)
            .filter_map(|u| u.pointer("/content/text").and_then(Value::as_str).map(str::to_owned))
            .collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Scenario {
    AuthFailure,
    Interrupt,
    Resume,
    Steer,
    Simple,
    MultiTurn,
    Approvals,
    UsageLimit,
    Subagent,
}

impl Scenario {
    fn file(self) -> &'static str {
        match self {
            Scenario::AuthFailure => "auth_failure",
            Scenario::Interrupt => "interrupt",
            Scenario::Resume => "resume",
            Scenario::Steer => "steer",
            Scenario::Simple => "simple",
            Scenario::MultiTurn => "multi_turn",
            Scenario::Approvals => "approvals",
            Scenario::UsageLimit => "usage_limit",
            Scenario::Subagent => "subagent",
        }
    }
}

/// What a scenario's ACP requests returned, by label.
type Results = Vec<(&'static str, Result<Value, RpcError>)>;

fn result<'a>(results: &'a Results, label: &str) -> &'a Result<Value, RpcError> {
    &results.iter().find(|(l, _)| *l == label).unwrap_or_else(|| panic!("no {label}")).1
}

async fn request(acp: &Peer, method: &str, params: Value) -> Result<Value, RpcError> {
    acp.request(method, params, None).await
}

fn text(t: &str) -> Value {
    json!([{ "type": "text", "text": t }])
}

/// Drives the shim over ACP. `thread` is the thread a resume loads.
async fn drive(scenario: Scenario, acp: &Peer, client: &Client, cwd: &str, thread: Option<&str>) -> Results {
    let mut out: Results = Vec::new();
    out.push((
        "initialize",
        request(acp, "initialize", json!({ "protocolVersion": 1, "clientCapabilities": {} })).await,
    ));
    if scenario == Scenario::Resume {
        let thread = thread.expect("a thread to resume");
        out.push((
            "load",
            request(acp, "session/load", json!({ "sessionId": thread, "cwd": cwd, "mcpServers": [] })).await,
        ));
        out.push((
            "fork",
            request(acp, "session/fork", json!({ "sessionId": thread, "cwd": cwd, "mcpServers": [] })).await,
        ));
        out.push(("rollback", request(acp, "_openidea/rollback", json!({ "sessionId": thread, "turns": 1 })).await));
        out.push(("close", request(acp, "session/close", json!({ "sessionId": thread })).await));
        return out;
    }
    let new = request(acp, "session/new", json!({ "cwd": cwd, "mcpServers": [] })).await;
    let session = new.as_ref().ok().and_then(|v| v["sessionId"].as_str()).unwrap_or_default().to_owned();
    out.push(("new", new));
    let prompt = |t: &str| json!({ "sessionId": session, "prompt": text(t) });
    let set = |id: &str, value: &str| json!({ "sessionId": session, "configId": id, "value": value });
    match scenario {
        Scenario::AuthFailure | Scenario::Simple | Scenario::UsageLimit | Scenario::Subagent => {
            out.push(("prompt", request(acp, "session/prompt", prompt("Reply with the single word: hi")).await));
        }
        Scenario::Interrupt => {
            out.push(("mode", request(acp, "session/set_config_option", set(MODE, "read-only")).await));
            let running = {
                let (acp, p) = (acp.clone(), prompt("Count to five."));
                tokio::spawn(async move { request(&acp, "session/prompt", p).await })
            };
            acp.notify("session/cancel", json!({ "sessionId": session })).unwrap();
            out.push(("prompt", running.await.unwrap()));
        }
        Scenario::Steer => {
            let running = {
                let (acp, p) = (acp.clone(), prompt("Count to five."));
                tokio::spawn(async move { request(&acp, "session/prompt", p).await })
            };
            let mut steered = Err(RpcError::Timeout);
            for _ in 0..200 {
                steered = request(
                    acp,
                    "_openidea/steer",
                    json!({ "sessionId": session, "prompt": text("Count to three instead.") }),
                )
                .await;
                match &steered {
                    Err(RpcError::Server { message, .. }) if message.contains("no turn") => {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    _ => break,
                }
            }
            out.push(("steer", steered));
            acp.notify("session/cancel", json!({ "sessionId": session })).unwrap();
            out.push(("prompt", running.await.unwrap()));
        }
        Scenario::MultiTurn => {
            out.push(("first", request(acp, "session/prompt", prompt("Reply with: one")).await));
            out.push(("model", request(acp, "session/set_config_option", set(MODEL, "gpt-5.5")).await));
            out.push(("effort", request(acp, "session/set_config_option", set(EFFORT, "high")).await));
            out.push(("second", request(acp, "session/prompt", prompt("Reply with: two")).await));
        }
        Scenario::Approvals => {
            client.answers.lock().extend([Some("accept"), None]);
            out.push(("prompt", request(acp, "session/prompt", prompt("Run `touch b.txt`, then write a.txt.")).await));
        }
        Scenario::Resume => unreachable!(),
    }
    out
}

struct Transcript {
    meta: Value,
    /// `(sent by the shim, frame)`.
    frames: Vec<(bool, Value)>,
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex")
}

fn load(name: &str) -> Transcript {
    let text = std::fs::read_to_string(fixture_dir().join(format!("{name}.jsonl"))).unwrap();
    let mut lines = text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str::<Value>(l).unwrap());
    let meta = lines.next().unwrap();
    assert_eq!(meta["type"], "meta");
    let frames = lines.map(|l| (l["dir"] == "out", l["frame"].clone())).collect();
    Transcript { meta, frames }
}

/// Plays codex: waits for each frame the shim should send, sends what codex sent.
/// Returns the frames the shim sent.
async fn play<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    t: &Transcript,
    read: R,
    mut write: W,
) -> (Vec<Value>, R, W) {
    let mut lines = BufReader::new(read).lines();
    let mut ids: HashMap<String, Value> = HashMap::new();
    let mut sent = Vec::new();
    for (out, frame) in &t.frames {
        if *out {
            let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
                .await
                .unwrap_or_else(|_| panic!("the shim didn't send {frame}"))
                .unwrap()
                .unwrap_or_else(|| panic!("the shim closed before {frame}"));
            let actual: Value = serde_json::from_str(&line).unwrap();
            match frame.get("method") {
                Some(method) => {
                    assert_eq!(actual.get("method"), Some(method), "expected {frame}, got {actual}");
                    if let Some(id) = frame.get("id") {
                        ids.insert(id.to_string(), actual["id"].clone());
                    }
                }
                None => {
                    assert_eq!(actual.get("id"), frame.get("id"), "expected {frame}, got {actual}");
                    assert_eq!(actual.get("result"), frame.get("result"), "expected {frame}, got {actual}");
                }
            }
            sent.push(actual);
        } else {
            let mut frame = frame.clone();
            if frame.get("method").is_none()
                && let Some(id) = frame.get("id").and_then(|id| ids.get(&id.to_string()))
            {
                frame["id"] = id.clone();
            }
            let mut line = serde_json::to_vec(&frame).unwrap();
            line.push(b'\n');
            write.write_all(&line).await.unwrap();
        }
    }
    (sent, lines.into_inner().into_inner(), write)
}

/// Runs `scenario` against its transcript; returns the ACP results, the client and
/// the frames the shim sent.
async fn replay(scenario: Scenario) -> (Results, Arc<Client>, Vec<Value>, Value) {
    let t = load(scenario.file());
    let (ours, theirs) = tokio::io::duplex(1 << 20);
    let (tr, tw) = tokio::io::split(theirs);
    let client = Arc::new(Client::default());
    let acp = attach(client.clone(), |events| {
        let (or, ow) = tokio::io::split(ours);
        Ok(Peer::connect_framed(or, ow, events, Framing::Lines))
    })
    .unwrap();
    let meta = t.meta.clone();
    let player = tokio::spawn(async move { play(&t, tr, tw).await });
    let thread = meta["thread"].as_str();
    let results = tokio::time::timeout(Duration::from_secs(20), drive(scenario, &acp, &client, "/work", thread))
        .await
        .expect("the scenario finished");
    // Codex stays up until the scenario is over.
    let (sent, _read, _write) = player.await.unwrap();
    (results, client, sent, meta)
}

fn sent<'a>(frames: &'a [Value], method: &str) -> Vec<&'a Value> {
    frames.iter().filter(|f| f["method"] == method).collect()
}

fn session_of(results: &Results, label: &str) -> String {
    result(results, label).as_ref().unwrap()["sessionId"].as_str().unwrap().to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_failure_names_auth() {
    let (results, _client, frames, _) = replay(Scenario::AuthFailure).await;
    let init = result(&results, "initialize").as_ref().unwrap();
    assert_eq!(init["agentCapabilities"]["loadSession"], true);
    assert_eq!(init["agentCapabilities"]["_meta"]["openidea"], json!({"rollback": true, "steer": true}));
    assert!(init["agentCapabilities"]["sessionCapabilities"]["fork"].is_object());
    let new = result(&results, "new").as_ref().unwrap();
    let categories: Vec<&str> =
        new["configOptions"].as_array().unwrap().iter().map(|o| o["category"].as_str().unwrap()).collect();
    // The model the user's codex config names; codex doesn't list it, so its efforts are unknown.
    assert_eq!(categories, ["model", "mode"]);
    let model = new["configOptions"][0]["currentValue"].as_str().unwrap();
    assert_eq!(model, "gpt-6-luna");
    assert!(new["configOptions"][0]["options"].as_array().unwrap().iter().any(|o| o["value"] == model));

    match result(&results, "prompt") {
        Err(RpcError::Server { code, message, .. }) => {
            assert_eq!(*code, AUTH_REQUIRED);
            assert!(message.to_lowercase().contains("auth"), "{message}");
        }
        r => panic!("expected an auth failure, got {r:?}"),
    }
    let start = sent(&frames, "turn/start")[0];
    assert_eq!(start["params"]["model"], model);
    assert!(start["params"]["approvalPolicy"].is_string() && start["params"]["sandboxPolicy"].is_object());
    assert_eq!(start["params"]["input"], json!([{"type": "text", "text": "Reply with the single word: hi"}]));
    assert!(start.get("jsonrpc").is_some(), "codex accepts the jsonrpc field");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_sent_right_after_the_prompt_interrupts_the_turn() {
    let (results, _client, frames, _) = replay(Scenario::Interrupt).await;
    let options = result(&results, "mode").as_ref().unwrap()["configOptions"].as_array().unwrap().clone();
    assert_eq!(options.iter().find(|o| o["id"] == MODE).unwrap()["currentValue"], "read-only");
    assert_eq!(result(&results, "prompt").as_ref().unwrap(), &json!({"stopReason": "cancelled"}));
    let start = sent(&frames, "turn/start")[0];
    assert_eq!(
        (start["params"]["approvalPolicy"].as_str(), &start["params"]["sandboxPolicy"]),
        (Some("on-request"), &json!({"type": "readOnly"}))
    );
    let interrupt = sent(&frames, "turn/interrupt");
    assert_eq!(interrupt.len(), 1);
    assert!(interrupt[0]["params"]["turnId"].as_str().is_some_and(|t| !t.is_empty()));
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_replays_history_then_forks_and_rolls_back() {
    let (results, client, frames, meta) = replay(Scenario::Resume).await;
    let thread = meta["thread"].as_str().unwrap();
    assert!(result(&results, "load").as_ref().unwrap()["configOptions"].is_array());
    assert_eq!(client.text(thread, "user_message_chunk"), meta["prompt"].as_str().unwrap());
    let fork = session_of(&results, "fork");
    assert_ne!(fork, thread);
    assert_eq!(result(&results, "rollback").as_ref().unwrap(), &json!({}));
    assert_eq!(sent(&frames, "thread/rollback")[0]["params"], json!({"threadId": thread, "numTurns": 1}));
    assert_eq!(sent(&frames, "thread/unsubscribe")[0]["params"], json!({"threadId": thread}));
}

async fn rollback_replies(turns: u32, replies: Vec<(&str, Value)>) -> (Result<Value, RpcError>, Vec<Value>) {
    let frames = replies
        .into_iter()
        .enumerate()
        .flat_map(|(i, (method, mut reply))| {
            let id = i + 1;
            reply["id"] = json!(id);
            [(true, json!({ "id": id, "method": method })), (false, reply)]
        })
        .collect();
    let transcript = Transcript { meta: Value::Null, frames };
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    let acp = attach(Arc::new(Client::default()), |events| {
        let (read, write) = tokio::io::split(ours);
        Ok(Peer::connect_framed(read, write, events, Framing::Lines))
    })
    .unwrap();
    let (read, write) = tokio::io::split(theirs);
    let player = tokio::spawn(async move { play(&transcript, read, write).await });
    let result = request(&acp, "_openidea/rollback", json!({ "sessionId": "s", "turns": turns })).await;
    let (sent, _read, _write) = player.await.unwrap();
    acp.kill();
    (result, sent)
}

fn removed_rollback() -> Value {
    json!({ "error": { "code": -32600, "message": "Invalid request: unknown variant `thread/rollback`, expected one of `thread/revert`, `account/gatewayOAuth/read`, `getAuthStatus`" } })
}

#[tokio::test(flavor = "multi_thread")]
async fn removed_rollback_reverts_before_the_target_turn_across_pages() {
    let (result, frames) = rollback_replies(
        3,
        vec![
            ("thread/rollback", removed_rollback()),
            (
                "thread/turns/list",
                json!({ "result": { "data": [{ "id": "last" }, { "id": "middle" }], "nextCursor": "older" } }),
            ),
            (
                "thread/turns/list",
                json!({ "result": { "data": [{ "id": "edited" }, { "id": "retained" }], "nextCursor": null } }),
            ),
            ("thread/revert", json!({ "result": { "thread": { "id": "s", "turns": [] } } })),
        ],
    )
    .await;
    assert_eq!(result.unwrap(), json!({}));
    let pages = sent(&frames, "thread/turns/list");
    assert_eq!(pages[0]["params"], json!({ "threadId": "s", "sortDirection": "desc", "limit": 3, "cursor": null }));
    assert_eq!(pages[1]["params"]["cursor"], "older");
    assert_eq!(pages[1]["params"]["limit"], 1);
    assert_eq!(sent(&frames, "thread/revert")[0]["params"], json!({ "threadId": "s", "beforeTurnId": "edited" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn method_not_found_reverts_the_latest_turn() {
    let (result, frames) = rollback_replies(
        1,
        vec![
            ("thread/rollback", json!({ "error": { "code": -32601, "message": "Method not found" } })),
            ("thread/turns/list", json!({ "result": { "data": [{ "id": "last" }], "nextCursor": null } })),
            ("thread/revert", json!({ "result": {} })),
        ],
    )
    .await;
    assert_eq!(result.unwrap(), json!({}));
    assert_eq!(sent(&frames, "thread/revert")[0]["params"]["beforeTurnId"], "last");
}

#[tokio::test(flavor = "multi_thread")]
async fn rollback_refusals_are_not_retried_as_revert() {
    let (result, frames) = rollback_replies(
        1,
        vec![("thread/rollback", json!({ "error": { "code": -32600, "message": "a turn is still running" } }))],
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("a turn is still running"));
    assert_eq!(frames.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn incomplete_or_repeated_history_pages_do_not_revert_the_wrong_turn() {
    for next in [Value::Null, json!("older")] {
        let (result, frames) = rollback_replies(
            3,
            vec![
                ("thread/rollback", removed_rollback()),
                ("thread/turns/list", json!({ "result": { "data": [{ "id": "last" }], "nextCursor": "older" } })),
                ("thread/turns/list", json!({ "result": { "data": [], "nextCursor": next } })),
            ],
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("reload the task"));
        assert!(sent(&frames, "thread/revert").is_empty());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn steering_adds_to_the_running_turn() {
    let (results, _client, frames, _) = replay(Scenario::Steer).await;
    let steer = sent(&frames, "turn/steer");
    assert_eq!(steer.len(), 1);
    assert_eq!(steer[0]["params"]["input"], text("Count to three instead."));
    assert_eq!(steer[0]["params"]["expectedTurnId"], sent(&frames, "turn/interrupt")[0]["params"]["turnId"]);
    assert!(result(&results, "steer").is_ok(), "{:?}", result(&results, "steer"));
    assert_eq!(result(&results, "prompt").as_ref().unwrap(), &json!({"stopReason": "cancelled"}));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_simple_turn_streams_reasoning_text_and_usage() {
    let (results, client, _frames, _) = replay(Scenario::Simple).await;
    let session = session_of(&results, "new");
    assert_eq!(result(&results, "prompt").as_ref().unwrap(), &json!({"stopReason": "end_turn"}));
    assert_eq!(client.text(&session, "agent_thought_chunk"), "**Answering**\n\nShort reply.");
    assert_eq!(client.text(&session, "agent_message_chunk"), "hi");
    let kinds: Vec<String> =
        client.of(&session).iter().map(|u| u["sessionUpdate"].as_str().unwrap().to_owned()).collect();
    assert!(kinds.contains(&"usage_update".to_owned()));
    let info = client.of(&session).into_iter().find(|u| u["sessionUpdate"] == "session_info_update").unwrap();
    assert_eq!(info["title"], "Say hi");
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_apply_to_the_next_turn() {
    let (results, client, frames, _) = replay(Scenario::MultiTurn).await;
    let session = session_of(&results, "new");
    assert_eq!(result(&results, "first").as_ref().unwrap(), &json!({"stopReason": "end_turn"}));
    assert_eq!(result(&results, "second").as_ref().unwrap(), &json!({"stopReason": "end_turn"}));
    let options = &result(&results, "effort").as_ref().unwrap()["configOptions"];
    assert_eq!(
        (options[0]["currentValue"].as_str(), options[1]["currentValue"].as_str()),
        (Some("gpt-5.5"), Some("high"))
    );
    let starts = sent(&frames, "turn/start");
    assert_eq!(
        (starts[0]["params"]["model"].as_str(), starts[0]["params"]["effort"].as_str()),
        (Some("gpt-5.6-luna"), Some("medium"))
    );
    assert_eq!(
        (starts[1]["params"]["model"].as_str(), starts[1]["params"]["effort"].as_str()),
        (Some("gpt-5.5"), Some("high"))
    );
    // Two messages of one turn are two paragraphs.
    assert_eq!(client.text(&session, "agent_message_chunk"), "oneOn it.\n\ntwo");
}

#[tokio::test(flavor = "multi_thread")]
async fn approvals_are_asked_and_answered() {
    let (results, client, frames, _) = replay(Scenario::Approvals).await;
    let session = session_of(&results, "new");
    assert_eq!(result(&results, "prompt").as_ref().unwrap(), &json!({"stopReason": "end_turn"}));
    let asked = client.asked.lock().clone();
    assert_eq!(asked.len(), 2);
    assert_eq!(asked[0]["toolCall"]["title"], "Run touch b.txt");
    let ids: Vec<&str> =
        asked[0]["options"].as_array().unwrap().iter().map(|o| o["optionId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["accept", "acceptWithExecpolicyAmendment", "decline", "cancel"]);
    assert_eq!(asked[1]["toolCall"]["title"], "Create a.txt");
    assert_eq!(asked[1]["toolCall"]["content"][0]["newText"], "one\n");
    // Allowed once, then the cancelled one declined (the fixture checks the answers codex got).
    let answers: Vec<&Value> = frames.iter().filter(|f| f.get("method").is_none()).map(|f| &f["result"]).collect();
    assert_eq!(answers, [&json!({"decision": "accept"}), &json!({"decision": "decline"})]);

    let updates = client.of(&session);
    let tool = |id: &str| updates.iter().filter(|u| u["toolCallId"] == id).cloned().collect::<Vec<_>>();
    let cmd = tool("call_cmd");
    assert_eq!(cmd[0]["sessionUpdate"], "tool_call");
    assert!(cmd.iter().any(|u| u.pointer("/content/0/content/text") == Some(&json!("touched\n"))));
    assert_eq!(cmd.last().unwrap()["status"], "completed");
    let edit = tool("call_edit");
    assert_eq!(edit.last().unwrap()["status"], "failed");
    let plan = updates.iter().find(|u| u["sessionUpdate"] == "plan").unwrap();
    assert_eq!(plan["entries"][0]["status"], "completed");
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_limits_fail_with_their_reset_time() {
    let (results, _client, _frames, _) = replay(Scenario::UsageLimit).await;
    match result(&results, "prompt") {
        Err(RpcError::Server { message, data, .. }) => {
            assert!(message.contains("usage limit"), "{message}");
            assert_eq!(data, &Some(json!({"openidea": {"usageLimit": {"resetsAtMs": 1_793_200_000_000.0}}})));
        }
        r => panic!("expected a usage limit, got {r:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn subagents_are_sessions_of_their_own() {
    let (results, client, _frames, meta) = replay(Scenario::Subagent).await;
    let session = session_of(&results, "new");
    let child = meta["child"].as_str().unwrap();
    assert_eq!(result(&results, "prompt").as_ref().unwrap(), &json!({"stopReason": "end_turn"}));
    let parent = client.of(&session);
    let cards: Vec<&Value> = parent.iter().filter(|u| u["sessionUpdate"] == "subagent_update").collect();
    assert_eq!(cards[0]["sessionId"], child);
    assert_eq!(cards[0]["title"], "say_hello");
    assert_eq!(cards.last().unwrap()["state"], json!({"state": "idle", "stopReason": "end_turn"}));
    let messages: Vec<&Value> = parent.iter().filter(|u| u["sessionUpdate"] == "session_message").collect();
    assert_eq!(
        (messages[0]["recipientSessionId"].as_str(), messages[0]["content"][0]["text"].as_str()),
        (Some(child), Some("Reply with: Hello"))
    );
    assert_eq!(
        (messages[1]["senderSessionId"].as_str(), messages[1]["content"][0]["text"].as_str()),
        (Some(child), Some("Hello."))
    );
    assert_eq!(client.text(child, "agent_message_chunk"), "Hello.");
    assert_eq!(client.text(&session, "agent_message_chunk"), "Hello.");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_client_going_away_stops_codex_and_codex_exiting_closes_the_client() {
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    let codex_side = Arc::new(Mutex::new(None::<Peer>));
    let acp = attach(Arc::new(Client::default()), |events| {
        let (or, ow) = tokio::io::split(ours);
        let peer = Peer::connect_framed(or, ow, events, Framing::Lines);
        *codex_side.lock() = Some(peer.clone());
        Ok(peer)
    })
    .unwrap();
    let codex = codex_side.lock().clone().unwrap();
    acp.kill();
    tokio::time::timeout(Duration::from_secs(5), codex.closed()).await.expect("codex is stopped");
    drop(theirs);

    let (ours, theirs) = tokio::io::duplex(1 << 16);
    let acp = attach(Arc::new(Client::default()), |events| {
        let (or, ow) = tokio::io::split(ours);
        Ok(Peer::connect_framed(or, ow, events, Framing::Lines))
    })
    .unwrap();
    drop(theirs);
    tokio::time::timeout(Duration::from_secs(5), acp.closed()).await.expect("the client sees codex exit");
}

// ---- Recording -------------------------------------------------------------------------

/// Records the scenarios codex can run here against the real `codex app-server`:
/// `cargo test -p ide-agent record_codex_fixtures -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "runs the real codex"]
async fn record_codex_fixtures() {
    let only = std::env::var("CODEX_SCENARIO").ok();
    let version = std::process::Command::new("codex").arg("--version").output().unwrap();
    let version = String::from_utf8_lossy(&version.stdout).trim().to_owned();
    for scenario in [Scenario::AuthFailure, Scenario::Interrupt, Scenario::Steer, Scenario::Resume] {
        if only.as_deref().is_some_and(|o| o != scenario.file()) {
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let cwd_s = cwd.to_string_lossy().into_owned();
        let mut meta =
            json!({ "type": "meta", "scenario": scenario.file(), "source": format!("recorded from {version}") });
        let thread = if scenario == Scenario::Resume {
            // A thread with one (stopped) turn, made by another codex process.
            let prompt = "Count to five.";
            let (client, acp, _log) = live(&cwd);
            request(&acp, "initialize", json!({ "protocolVersion": 1 })).await.unwrap();
            let new = request(&acp, "session/new", json!({ "cwd": cwd_s, "mcpServers": [] })).await.unwrap();
            let id = new["sessionId"].as_str().unwrap().to_owned();
            let running = {
                let (acp, p) = (acp.clone(), json!({ "sessionId": id, "prompt": text(prompt) }));
                tokio::spawn(async move { request(&acp, "session/prompt", p).await })
            };
            tokio::time::sleep(Duration::from_secs(2)).await;
            acp.notify("session/cancel", json!({ "sessionId": id })).unwrap();
            let _ = running.await;
            drop(client);
            acp.kill();
            meta["thread"] = json!(id);
            meta["prompt"] = json!(prompt);
            Some(id)
        } else {
            None
        };
        let (client, acp, log) = live(&cwd);
        let results = drive(scenario, &acp, &client, &cwd_s, thread.as_deref()).await;
        println!(
            "{}: {:?}",
            scenario.file(),
            results.iter().map(|(l, r)| (l, r.as_ref().map(|_| ()))).collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
        acp.kill();
        let home = std::env::var("HOME").unwrap_or_default();
        let mut out = serde_json::to_string(&meta).unwrap() + "\n";
        for line in log.lock().iter() {
            out.push_str(&scrub(line, &[(&cwd_s, "<workspace>"), (&home, "<home>")]));
            out.push('\n');
        }
        std::fs::write(fixture_dir().join(format!("{}.jsonl", scenario.file())), out).unwrap();
        let fork = results.iter().find(|(l, _)| *l == "fork").and_then(|(_, r)| r.as_ref().ok());
        if let Some(fork) = fork.and_then(|f| f["sessionId"].as_str()) {
            // A fork is loaded by a fresh process.
            let (client, acp, _log) = live(&cwd);
            request(&acp, "initialize", json!({ "protocolVersion": 1 })).await.unwrap();
            let loaded =
                request(&acp, "session/load", json!({ "sessionId": fork, "cwd": cwd_s, "mcpServers": [] })).await;
            println!("fork {fork} loaded from a fresh process: {:?}", loaded.map(|_| client.of(fork).len()));
            acp.kill();
        }
    }
}

/// The shim over a real codex, with a tap writing each frame to the returned log.
fn live(cwd: &Path) -> (Arc<Client>, Peer, Arc<Mutex<Vec<String>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let client = Arc::new(Client::default());
    let cwd = cwd.to_path_buf();
    let tap = log.clone();
    let acp = attach(client.clone(), move |events| {
        let mut child = tokio::process::Command::new("codex")
            .arg("app-server")
            .current_dir(&cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let (mut stdin, stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (tr, mut tw) = tokio::io::split(theirs);
        let out_log = tap.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(tr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                out_log.lock().push(format!("{{\"dir\":\"out\",\"frame\":{line}}}"));
                if stdin.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
            let _ = child.kill().await;
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tap.lock().push(format!("{{\"dir\":\"in\",\"frame\":{line}}}"));
                if tw.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        let (or, ow) = tokio::io::split(ours);
        Ok(Peer::connect_framed(or, ow, events, Framing::Lines))
    })
    .unwrap();
    (client, acp, log)
}

/// A transcript line without local paths or machine identifiers.
fn scrub(line: &str, paths: &[(&str, &str)]) -> String {
    let mut v: Value = serde_json::from_str(line).unwrap();
    if let Some(p) = v.pointer_mut("/frame/params").and_then(Value::as_object_mut)
        && v_method(line) == Some("remoteControl/status/changed")
    {
        p.insert("serverName".into(), json!("<host>"));
        p.insert("installationId".into(), json!("<installation>"));
    }
    let mut s = v.to_string();
    for (from, to) in paths {
        if !from.is_empty() {
            s = s.replace(from, to);
        }
    }
    s
}

fn v_method(line: &str) -> Option<&str> {
    let at = line.find("\"method\":\"")? + 10;
    line[at..].split('"').next()
}
