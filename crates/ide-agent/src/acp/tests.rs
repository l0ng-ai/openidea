//! The dialect layer against frames captured from `claude-agent-acp` 0.97.0
//! (`tests/fixtures/acp-v2/*.jsonl`: `{ dir, msg }` per line, `in` = agent → client).

use super::normalize::{Normalizer, base64};
use super::*;
use crate::conversation::Conversation;
use crate::model::{AgentEntry, AgentSubagentStatus, AgentToolDiff, AgentToolStatus};
use crate::timeline::Timeline;
use ide_core::IpcPath;
use ide_jsonrpc::Framing;
use std::time::Duration;

pub(crate) const TURN: &str = include_str!("../../tests/fixtures/acp-v2/turn.jsonl");
const SUBAGENT: &str = include_str!("../../tests/fixtures/acp-v2/subagent.jsonl");
const CANCEL: &str = include_str!("../../tests/fixtures/acp-v2/cancel.jsonl");
const RESUME: &str = include_str!("../../tests/fixtures/acp-v2/resume.jsonl");
const INITIALIZE_V1: &str = include_str!("../../tests/fixtures/acp-v2/initialize-v1.jsonl");

#[test]
fn auth_required_matches_authentication_words_and_sign_in_phrases() {
    for (code, message, expected) in [
        (AUTH_REQUIRED, "This account is not eligible.", true),
        (codes::INTERNAL_ERROR, "Auth required", true),
        (codes::INTERNAL_ERROR, "Authentication failed", true),
        (codes::INTERNAL_ERROR, "Failed to authenticate. API Error: 401", true),
        (codes::INTERNAL_ERROR, "Failed to authenticate. API Error: 403", true),
        (codes::INTERNAL_ERROR, "Not authenticated", true),
        (codes::INTERNAL_ERROR, "Authorization failed", true),
        (codes::INTERNAL_ERROR, "Authorize your account", true),
        (codes::INTERNAL_ERROR, "Unauthenticated", true),
        (codes::INTERNAL_ERROR, "Unauthentication error", true),
        (codes::INTERNAL_ERROR, "Unauthorized", true),
        (codes::INTERNAL_ERROR, "Unauthorization error", true),
        (codes::INTERNAL_ERROR, "OAuth token has expired", true),
        (codes::INTERNAL_ERROR, "OAuth2 token has expired", true),
        (codes::INTERNAL_ERROR, "You are not logged in", true),
        (codes::INTERNAL_ERROR, "You are logged out", true),
        (codes::INTERNAL_ERROR, "Please sign in", true),
        (codes::INTERNAL_ERROR, "Please log in", true),
        (codes::INTERNAL_ERROR, "Login required", true),
        (codes::INTERNAL_ERROR, "author", false),
        (codes::INTERNAL_ERROR, "authors", false),
        (codes::INTERNAL_ERROR, "authority", false),
        (codes::INTERNAL_ERROR, "authored", false),
        (codes::INTERNAL_ERROR, "reauthenticate", false),
        (codes::INTERNAL_ERROR, "preauthorized", false),
        (codes::INTERNAL_ERROR, "signal input failed", false),
        (codes::INTERNAL_ERROR, "catalog index failed", false),
        (codes::INTERNAL_ERROR, "login succeeded", false),
    ] {
        assert_eq!(auth_required(code, message), expected, "code={code}, message={message:?}");
    }
}

/// The messages of a fixture going `dir` (`in` or `out`).
pub(crate) fn frames(fixture: &str, dir: &str) -> Vec<Value> {
    fixture
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|f| f["dir"] == dir)
        .map(|f| f["msg"].clone())
        .collect()
}

/// The result of request `id` in a fixture.
fn result(fixture: &str, id: i64) -> Value {
    frames(fixture, "in").into_iter().find(|m| m["id"] == id && m.get("result").is_some()).unwrap()["result"].clone()
}

/// The `(session id, update)` of each `session/update` the agent sent.
fn updates(fixture: &str) -> Vec<(String, Value)> {
    frames(fixture, "in")
        .into_iter()
        .filter(|m| m["method"] == "session/update")
        .map(|m| (m["params"]["sessionId"].as_str().unwrap().to_owned(), m["params"]["update"].clone()))
        .collect()
}

fn tool(entry: &AgentEntry) -> (&str, AgentToolStatus, Option<&str>) {
    match entry {
        AgentEntry::Tool { title, status, output, .. } => (title.as_str(), *status, output.as_deref()),
        other => panic!("not a tool call: {other:?}"),
    }
}

#[test]
fn the_negotiating_request_carries_both_versions() {
    let p = initialize_params(&json!({ "name": "OpenIDEA", "version": "1.0" }));
    assert_eq!(p["protocolVersion"], 2);
    assert_eq!(p["info"]["name"], "OpenIDEA");
    assert_eq!(p["clientInfo"]["name"], "OpenIDEA");
    assert!(p["capabilities"].is_object());
    assert_eq!(p["clientCapabilities"]["subagents"], json!({}));
    assert_eq!(p["clientCapabilities"]["terminal"], false);
    // What we sent in the capture is what claude-agent-acp negotiated v2 and v1 from.
    let sent = &frames(TURN, "out")[0]["params"];
    assert_eq!(sent["clientCapabilities"], p["clientCapabilities"]);
}

#[test]
fn a_v2_initialize_response_reads_as_v1_capabilities() {
    let n = Negotiated::from_initialize(&result(TURN, 1));
    assert_eq!(n.generation, 2);
    assert!(n.load_session());
    assert!(n.prompt("image") && n.prompt("embeddedContext") && !n.prompt("audio"));
    assert!(n.session("fork") && n.session("resume") && n.session("close") && n.session("delete"));
    assert_eq!(n.meta("/claudeCode/promptQueueing"), Some(&json!(true)));
    assert_eq!(n.agent_info.as_ref().unwrap()["name"], "@agentclientprotocol/claude-agent-acp");
    assert_eq!(n.capabilities["mcpCapabilities"]["http"], true);
}

#[test]
fn a_v1_agent_answers_the_same_request_in_v1() {
    let response = result(INITIALIZE_V1, 1);
    let n = Negotiated::from_initialize(&response);
    assert_eq!(n.generation, 1);
    assert_eq!(n.capabilities, response["agentCapabilities"]);
    assert!(n.load_session() && n.prompt("image") && n.session("fork"));
    assert_eq!(n.meta.as_ref().unwrap()["steering"]["supported"], true);
}

#[test]
fn the_shape_decides_the_version_not_the_number() {
    // Reports version 2 in v1 shape (as Antigravity does).
    let n = Negotiated::from_initialize(&json!({ "protocolVersion": 2, "agentInfo": { "name": "x" },
        "agentCapabilities": { "loadSession": true, "promptCapabilities": { "image": true } } }));
    assert_eq!(n.generation, 1);
    assert!(n.load_session() && n.prompt("image"));
    // A bare v1 response.
    let n = Negotiated::from_initialize(&json!({ "protocolVersion": 1 }));
    assert_eq!((n.generation, n.load_session(), n.prompt("image")), (1, false, false));
    // v2 without session capabilities: no resume.
    let n = Negotiated::from_initialize(&json!({ "protocolVersion": 2, "info": { "name": "x", "version": "1" } }));
    assert_eq!((n.generation, n.load_session(), n.session("fork")), (2, false, false));
}

#[test]
fn meta_and_auth_methods_pass_through() {
    // The native shims advertise their extensions in `agentCapabilities._meta`.
    let shim = Negotiated::from_initialize(&json!({ "protocolVersion": 1, "agentCapabilities": {
        "loadSession": true, "sessionCapabilities": { "fork": {} },
        "_meta": { "openidea": { "rollback": true, "steer": true } } } }));
    assert!(shim.meta("/openidea/rollback").is_some() && shim.meta("/openidea/steer").is_some());
    assert!(shim.session("fork"));

    let v2 = Negotiated::from_initialize(&json!({ "protocolVersion": 2, "info": { "name": "x", "version": "1" },
        "capabilities": { "session": { "fork": null, "prompt": { "image": null } }, "_meta": { "openidea": { "steer": true } } },
        "authMethods": [{ "type": "agent", "methodId": "login", "name": "Log in" },
                        { "type": "terminal", "methodId": "cli", "name": "CLI", "args": ["login"] }] }));
    assert!(v2.meta("/openidea/steer").is_some());
    // `null` is "not supported".
    assert!(!v2.session("fork") && !v2.prompt("image"));
    assert_eq!(v2.auth_methods[0], json!({ "type": "agent", "id": "login", "name": "Log in" }));
    assert_eq!(v2.auth_methods[1]["id"], "cli");
    assert_eq!(v2.auth_methods[1]["args"], json!(["login"]));
}

/// The captured turn (a Bash command on a display terminal, a Write with a git patch, a
/// permission request) folds into the same entries a v1 agent's turn does.
#[test]
fn a_captured_v2_turn_folds_into_the_timeline() {
    let mut n = Normalizer::default();
    let mut t = Timeline::default();
    for (session, update) in updates(TURN) {
        for u in n.normalize(&session, &update) {
            assert_ne!(u["sessionUpdate"], "state_update");
            assert_ne!(u["sessionUpdate"], "terminal_update");
            t.apply(&u);
        }
    }
    let e = &t.entries;
    assert_eq!(e.len(), 4, "{e:#?}");
    assert_eq!(tool(&e[0]), ("ToolSearch", AgentToolStatus::Completed, Some("No matching deferred tools found")));
    let (title, status, output) = tool(&e[1]);
    assert_eq!((title, status), ("echo hello; ls -la /work/proj/note.txt 2>&1", AgentToolStatus::Failed));
    assert!(output.unwrap().starts_with("Exit code 1\nhello\nls: /private/tmp/"), "{output:?}");
    let AgentEntry::Tool { title, status, diffs, kind, .. } = &e[2] else { panic!() };
    assert_eq!(
        (title.as_str(), *status, kind.as_str()),
        ("Write /work/proj/note.txt", AgentToolStatus::Completed, "edit")
    );
    assert_eq!(diffs, &[AgentToolDiff { path: IpcPath("/work/proj/note.txt".into()), added: 1, removed: 0 }]);
    assert_eq!(e[3], AgentEntry::Agent { text: "done".into() });
}

#[test]
fn a_captured_subagent_gets_its_card_and_timeline() {
    let mut n = Normalizer::default();
    let mut c = Conversation::default();
    let root = updates(SUBAGENT)[0].0.clone();
    for (session, update) in updates(SUBAGENT) {
        for u in n.normalize(&session, &update) {
            c.apply(Some(&session), &u, 1.0);
        }
    }
    let AgentEntry::Subagent { id, title, status, prompt, reply, tools, .. } = &c.main.entries[2] else {
        panic!("{:#?}", c.main.entries)
    };
    assert_eq!((title.as_deref(), *status, *tools), (Some("general-purpose"), AgentSubagentStatus::Done, 1));
    assert!(prompt.as_deref().unwrap().starts_with("List the files"));
    assert!(reply.as_deref().unwrap().contains("note.txt"));
    let child = c.timeline(&Some(id.clone())).unwrap();
    assert_eq!(tool(&child.entries[1]), ("ls", AgentToolStatus::Completed, Some("note.txt")));
    // The answer's chunks make one message.
    let AgentEntry::Agent { text } = c.main.entries.last().unwrap() else { panic!() };
    assert!(text.starts_with("当前目录里只有一个文件") && text.ends_with("核。"), "{text}");
    assert_eq!(c.owner(Some(&root)), None);
}

#[test]
fn a_replayed_history_clears_each_message_before_its_chunks() {
    let mut n = Normalizer::default();
    let mut t = Timeline::default();
    let replay = updates(RESUME);
    for (session, update) in &replay {
        for u in n.normalize(session, update) {
            t.apply(&u);
        }
    }
    // The resume without a replay sent only its state snapshot; the replay, the history.
    assert_eq!(replay[0].1, json!({ "sessionUpdate": "state_update", "state": "idle" }));
    assert_eq!(t.entries.len(), 4);
    assert_eq!(t.entries[3], AgentEntry::Agent { text: "done".into() });
}

#[test]
fn whole_messages_add_only_what_their_chunks_did_not_say() {
    let mut n = Normalizer::default();
    let chunk = |id: &str, text: &str| json!({ "sessionUpdate": "agent_message_chunk", "messageId": id, "content": { "type": "text", "text": text } });
    let message = |kind: &str, id: &str, text: &str| json!({ "sessionUpdate": kind, "messageId": id, "content": [{ "type": "text", "text": text }] });
    assert_eq!(n.normalize("s", &chunk("m1", "Hel")).len(), 1);
    let out = n.normalize("s", &message("agent_message", "m1", "Hello"));
    assert_eq!(out, [json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "lo" } })]);
    // Repeated: nothing new.
    assert!(n.normalize("s", &message("agent_message", "m1", "Hello")).is_empty());
    // A message never streamed, and a thought.
    assert_eq!(n.normalize("s", &message("agent_message", "m2", "Hi"))[0]["content"]["text"], "Hi");
    let thought = n.normalize("s", &message("agent_thought", "m3", "hmm"));
    assert_eq!(thought[0]["sessionUpdate"], "agent_thought_chunk");
    // Cleared (replay), then streamed again: the chunks pass.
    assert!(
        n.normalize("s", &json!({ "sessionUpdate": "agent_message", "messageId": "m1", "content": [] })).is_empty()
    );
    assert_eq!(n.normalize("s", &chunk("m1", "Hello"))[0]["content"]["text"], "Hello");
    // The prompt's echo is the client's own entry.
    assert!(n.normalize("s", &message("user_message", "u1", "Fix it")).is_empty());
}

#[test]
fn tool_calls_are_announced_once_and_content_chunks_append() {
    let mut n = Normalizer::default();
    let out = n.normalize(
        "s",
        &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t", "name": "Read", "status": "pending" }),
    );
    assert_eq!(out[0]["sessionUpdate"], "tool_call");
    assert_eq!(out[0]["title"], "Read", "the name stands in for a missing title");
    let text = |t: &str| json!({ "type": "content", "content": { "type": "text", "text": t } });
    let out = n.normalize(
        "s",
        &json!({ "sessionUpdate": "tool_call_content_chunk", "toolCallId": "t", "content": text("a") }),
    );
    assert_eq!(out[0]["sessionUpdate"], "tool_call_update");
    n.normalize("s", &json!({ "sessionUpdate": "tool_call_content_chunk", "toolCallId": "t", "content": text("b") }));
    let out = n.normalize(
        "s",
        &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t", "title": null, "status": "completed" }),
    );
    assert_eq!(out[0], json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t", "status": "completed" }));
    let mut t = Timeline::default();
    for u in [
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": "u", "title": "Grep" }),
        json!({ "sessionUpdate": "tool_call_content_chunk", "toolCallId": "u", "content": text("one") }),
        json!({ "sessionUpdate": "tool_call_content_chunk", "toolCallId": "u", "content": text("two") }),
    ] {
        for v in n.normalize("s", &u) {
            t.apply(&v);
        }
    }
    assert_eq!(tool(&t.entries[0]).2, Some("one\ntwo"));
    // Tool calls are per session: a subagent's `t` is another call.
    assert_eq!(
        n.normalize("c", &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t" }))[0]["sessionUpdate"],
        "tool_call"
    );
}

#[test]
fn terminal_output_reaches_the_tool_calls_that_show_it() {
    let mut n = Normalizer::default();
    let mut t = Timeline::default();
    let data = |s: &str| {
        // `base64` of `s`, by hand: these are short.
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for c in s.as_bytes().chunks(3) {
            let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
            let v = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                out.push(if i <= c.len() { A[(v >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
            }
        }
        out
    };
    for u in [
        json!({ "sessionUpdate": "terminal_update", "terminalId": "x" }),
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t", "title": "make", "kind": "execute",
            "content": [{ "type": "terminal", "terminalId": "x" }] }),
        json!({ "sessionUpdate": "terminal_output_chunk", "terminalId": "x", "data": data("build") }),
        json!({ "sessionUpdate": "terminal_output_chunk", "terminalId": "x", "data": data("ing…\nok") }),
        json!({ "sessionUpdate": "terminal_update", "terminalId": "x", "exitStatus": { "exitCode": 0 } }),
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t", "status": "completed" }),
    ] {
        for v in n.normalize("s", &u) {
            t.apply(&v);
        }
    }
    assert_eq!(tool(&t.entries[0]), ("make", AgentToolStatus::Completed, Some("building…\nok")));
    assert_eq!(base64("aGk="), b"hi");
    assert_eq!(base64("aGk"), b"hi");
}

#[test]
fn item_plans_become_the_plan_and_others_are_left_to_their_tool_call() {
    let mut n = Normalizer::default();
    let items = json!({ "sessionUpdate": "plan_update", "plan": { "type": "items", "planId": "plan",
        "entries": [{ "content": "look", "priority": "medium", "status": "completed" },
                    { "content": "answer", "priority": "medium", "status": "in_progress" }] } });
    let out = n.normalize("s", &items);
    assert_eq!(out, [json!({ "sessionUpdate": "plan", "entries": items["plan"]["entries"] })]);
    let md =
        json!({ "sessionUpdate": "plan_update", "plan": { "type": "markdown", "planId": "p2", "content": "# Plan" } });
    assert!(n.normalize("s", &md).is_empty());
    assert!(n.normalize("s", &json!({ "sessionUpdate": "plan_removed", "planId": "p2" })).is_empty());
    let out = n.normalize("s", &json!({ "sessionUpdate": "plan_removed", "planId": "plan" }));
    assert_eq!(out, [json!({ "sessionUpdate": "plan", "entries": [] })]);
}

#[test]
fn a_compaction_shows_as_a_tool_call() {
    let mut n = Normalizer::default();
    let mut t = Timeline::default();
    for u in [
        json!({ "sessionUpdate": "compaction_update", "compactionId": "c1", "status": "in_progress" }),
        json!({ "sessionUpdate": "compaction_summary_chunk", "compactionId": "c1", "content": { "type": "text", "text": "Fixed " } }),
        json!({ "sessionUpdate": "compaction_summary_chunk", "compactionId": "c1", "content": { "type": "text", "text": "the lexer" } }),
        json!({ "sessionUpdate": "compaction_update", "compactionId": "c1", "status": "completed" }),
    ] {
        for v in n.normalize("s", &u) {
            t.apply(&v);
        }
    }
    assert_eq!(tool(&t.entries[0]), ("Compact conversation", AgentToolStatus::Completed, Some("Fixed the lexer")));
}

#[test]
fn git_patches_count_their_lines_per_file() {
    let patch = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,3 +1,3 @@\n fn a() {\n-    1\n+    2\n }\n@@ -10,2 +10,3 @@\n x\n+y\n z\ndiff --git a/old.rs b/old.rs\ndeleted file mode 100644\n--- a/old.rs\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
    let update = json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t", "title": "Edit", "content": [{ "type": "diff",
        "changes": [{ "operation": "modify", "path": "/repo/src/a.rs" }, { "operation": "delete", "path": "/repo/old.rs" },
                    { "operation": "add", "path": "/repo/bin.png", "fileType": "binary" }],
        "patch": { "format": "git_patch", "text": patch } }] });
    let mut t = Timeline::default();
    for v in Normalizer::default().normalize("s", &update) {
        t.apply(&v);
    }
    let AgentEntry::Tool { diffs, .. } = &t.entries[0] else { panic!() };
    let stats: Vec<(&str, u32, u32)> = diffs.iter().map(|d| (d.path.0.to_str().unwrap(), d.added, d.removed)).collect();
    assert_eq!(stats, [("/repo/src/a.rs", 2, 1), ("/repo/old.rs", 0, 2), ("/repo/bin.png", 0, 0)]);
}

/// Records what reaches the task's handler.
#[derive(Default)]
struct Recorder {
    seen: parking_lot::Mutex<Vec<(String, Value)>>,
}

impl Handler for Recorder {
    fn on_notification(&self, method: &str, params: Value) {
        self.seen.lock().push((method.to_owned(), params));
    }
    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        self.seen.lock().push((method.to_owned(), params));
        Ok(json!({ "outcome": { "outcome": "selected", "optionId": "allow-once" } }))
    }
}

#[test]
fn v2_permission_requests_reach_the_task_with_their_tool_call() {
    let recorder = Arc::new(Recorder::default());
    let dialect = Dialect::wrap(recorder.clone());
    dialect.generation.store(2, Ordering::Release);
    let request = frames(TURN, "in").into_iter().find(|m| m["method"] == "session/request_permission").unwrap();
    let answer = dialect.on_request("session/request_permission", request["params"].clone()).unwrap();
    assert_eq!(answer["outcome"]["optionId"], "allow-once");
    let seen = recorder.seen.lock();
    let params = &seen[0].1;
    assert_eq!(params["toolCall"]["title"], "Write /work/proj/note.txt");
    assert_eq!(params["toolCall"]["toolCallId"], "toolu_01QuF3wSLUeeMp5QTuiNoTBn");
    assert_eq!(params["toolCall"]["content"][0]["path"], "/work/proj/note.txt");
    assert_eq!(params["options"].as_array().unwrap().len(), request["params"]["options"].as_array().unwrap().len());

    // A v1 dialect leaves both directions alone.
    let recorder = Arc::new(Recorder::default());
    let dialect = Dialect::wrap(recorder.clone());
    dialect.generation.store(1, Ordering::Release);
    let update =
        json!({ "sessionId": "s", "update": { "sessionUpdate": "tool_call", "toolCallId": "t", "title": "x" } });
    dialect.on_notification("session/update", update.clone());
    assert_eq!(recorder.seen.lock()[0].1, update);
}

/// A scripted v2 agent: answers each request from `answers`, and on `session/prompt`
/// answers at once, then (on its own thread) sends `then`.
struct ScriptedAgent {
    peer: std::sync::OnceLock<Peer>,
    then: parking_lot::Mutex<Vec<Value>>,
    prompt: Result<Value, (i64, String)>,
    requests: parking_lot::Mutex<Vec<(String, Value)>>,
}

impl Handler for ScriptedAgent {
    fn on_notification(&self, method: &str, params: Value) {
        self.requests.lock().push((method.to_owned(), params));
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        self.requests.lock().push((method.to_owned(), params.clone()));
        match method {
            "initialize" => Ok(result(TURN, 1)),
            "session/new" => Ok(result(TURN, 2)),
            "session/resume" => Ok(result(RESUME, 2)),
            "session/prompt" => {
                let peer = self.peer.get().unwrap().clone();
                let then = std::mem::take(&mut *self.then.lock());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(20));
                    for m in then {
                        peer.notify("session/update", &m).unwrap();
                    }
                });
                self.prompt.clone()
            }
            _ => Ok(json!({})),
        }
    }
}

async fn connect(agent: Arc<ScriptedAgent>) -> (Conn, Arc<Recorder>) {
    let (a, b) = tokio::io::duplex(1 << 20);
    let (ar, aw) = tokio::io::split(a);
    let (br, bw) = tokio::io::split(b);
    let _ = agent.peer.set(Peer::connect_framed(br, bw, agent.clone(), Framing::Lines));
    let recorder = Arc::new(Recorder::default());
    let dialect = Dialect::wrap(recorder.clone());
    let conn = Conn::new(Peer::connect_framed(ar, aw, dialect.clone(), Framing::Lines), dialect);
    let n = conn.initialize(&json!({ "name": "OpenIDEA", "version": "0" })).await.unwrap();
    assert_eq!((n.generation, conn.generation()), (2, 2));
    (conn, recorder)
}

fn scripted(prompt: Result<Value, (i64, String)>, then: Vec<Value>) -> Arc<ScriptedAgent> {
    Arc::new(ScriptedAgent {
        peer: Default::default(),
        then: parking_lot::Mutex::new(then),
        prompt,
        requests: Default::default(),
    })
}

fn state(session: &str, state: Value) -> Value {
    let mut update = json!({ "sessionUpdate": "state_update" });
    update.as_object_mut().unwrap().extend(state.as_object().unwrap().clone());
    json!({ "sessionId": session, "update": update })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_v2_prompt_resolves_when_its_session_goes_idle() {
    // The captured cancelled turn: running, a cancel, then `idle` with `cancelled`.
    let session = "caf5db42-df04-40e3-bb8b-e270510e17ca";
    let tail: Vec<Value> = frames(CANCEL, "in")
        .into_iter()
        .skip_while(|m| m["id"] != 4)
        .filter(|m| m["method"] == "session/update")
        .map(|m| m["params"].clone())
        .collect();
    // A stale snapshot and a subagent's own `idle` come first: neither ends the turn.
    let mut then = vec![
        state(session, json!({ "state": "idle" })),
        state("child", json!({ "state": "idle", "stopReason": "end_turn" })),
    ];
    then.extend(tail);
    let agent = scripted(Ok(result(CANCEL, 4)), then);
    let (conn, recorder) = connect(agent.clone()).await;
    let reply: Value =
        conn.request("session/prompt", json!({ "sessionId": session, "prompt": [] }), None).await.unwrap();
    assert_eq!(reply["stopReason"], "cancelled");
    assert!(reply["usage"].is_object());
    // Everything before the `idle` reached the task first; no state updates did.
    let seen = recorder.seen.lock();
    assert!(seen.iter().any(|(_, p)| p["update"]["sessionUpdate"] == "session_info_update"));
    assert!(seen.iter().all(|(_, p)| p["update"]["sessionUpdate"] != "state_update"));
    assert!(conn.dialect.turns.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_v2_turn_is_an_error_and_a_queued_cancel_is_a_cancelled_turn() {
    let failed = state(
        "s",
        json!({ "state": "idle", "stopReason": "error",
        "error": { "code": -32000, "message": "Authentication required" } }),
    );
    let agent = scripted(Ok(json!({ "messageId": "m" })), vec![failed]);
    let (conn, _) = connect(agent).await;
    let err =
        conn.request::<_, Value>("session/prompt", json!({ "sessionId": "s", "prompt": [] }), None).await.unwrap_err();
    assert!(
        matches!(err, RpcError::Server { code: -32000, ref message, .. } if message == "Authentication required"),
        "{err:?}"
    );

    let agent = scripted(Err((codes::REQUEST_CANCELLED, "cancelled".into())), Vec::new());
    let (conn, _) = connect(agent).await;
    let reply: Value = conn.request("session/prompt", json!({ "sessionId": "s", "prompt": [] }), None).await.unwrap();
    assert_eq!(reply["stopReason"], "cancelled");

    // The agent going away fails the turn.
    let agent = scripted(Ok(json!({ "messageId": "m" })), Vec::new());
    let (conn, _) = connect(agent.clone()).await;
    let prompt = conn.request::<_, Value>("session/prompt", json!({ "sessionId": "s", "prompt": [] }), None);
    let killer = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        agent.peer.get().unwrap().kill();
    };
    let (r, ()) = tokio::join!(prompt, killer);
    assert!(matches!(r, Err(RpcError::Closed)), "{r:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn v1_requests_are_sent_in_v2() {
    let agent = scripted(Ok(json!({})), Vec::new());
    let (conn, recorder) = connect(agent.clone()).await;
    let _: Value = conn.request("session/new", json!({ "cwd": "/p", "mcpServers": [] }), None).await.unwrap();
    let _: Value =
        conn.request("session/load", json!({ "sessionId": "s1", "cwd": "/p", "mcpServers": [] }), None).await.unwrap();
    let _: Value = conn
        .request("session/set_config_option", json!({ "sessionId": "s1", "configId": "model", "value": "haiku" }), None)
        .await
        .unwrap();
    let _: Value = conn.request("authenticate", json!({ "methodId": "x" }), None).await.unwrap();
    let requests = agent.requests.lock().clone();
    let methods: Vec<&str> = requests.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(methods, ["initialize", "session/new", "session/resume", "session/set_config_option", "auth/login"]);
    assert!(requests[2].1.get("replayFrom").is_none(), "resumed without a replay");
    assert_eq!(requests[3].1["type"], "id");
    // The commands of both setup responses, as v1 updates.
    let seen = recorder.seen.lock();
    let commands: Vec<&Value> = seen
        .iter()
        .filter(|(_, p)| p["update"]["sessionUpdate"] == "available_commands_update")
        .map(|(_, p)| &p["sessionId"])
        .collect();
    assert_eq!(commands, [&json!("28846a4c-c3e8-4a45-a3d0-c19f10d19d1a"), &json!("s1")]);
}

#[test]
fn stdio_mcp_is_v1_baseline_and_negotiated_in_v2() {
    assert!(super::Negotiated::from_initialize(&json!({"protocolVersion":1,"agentCapabilities":{}})).mcp_stdio());
    assert!(!super::Negotiated::from_initialize(&json!({"info":{},"capabilities":{"session":{}}})).mcp_stdio());
    assert!(
        super::Negotiated::from_initialize(&json!({"info":{},"capabilities":{"session":{"mcp":{"stdio":{}}}}}))
            .mcp_stdio()
    );
}
