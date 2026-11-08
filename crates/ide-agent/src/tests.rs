//! End-to-end task flow against an in-memory ACP agent.

use super::*;
use tokio::io::duplex;

#[test]
fn permission_uses_its_own_command_payload() {
    let command = "python3 -c 'import pathlib\npathlib.Path(\"a.txt\").touch()'";
    let mut request = json!({"toolCall": {"toolCallId": "write", "kind": "execute",
        "title": "Run List .", "rawInput": {"command": command}}});
    assert_eq!(permission_title(&request), format!("Run {command}"));
    request["toolCall"]["title"] = json!("Allow network access to example.com");
    assert_eq!(permission_title(&request), "Allow network access to example.com");
    request["toolCall"].as_object_mut().unwrap().remove("title");
    request["toolCall"].as_object_mut().unwrap().remove("rawInput");
    request["toolCall"]["content"] = json!([{ "type": "content", "content": {"type": "text", "text": command}}]);
    assert_eq!(permission_title(&request), format!("Run {command}"));
}

#[test]
fn permission_shows_the_script_inside_a_shell_wrapper() {
    let wrapped = r#"/bin/zsh -lc "python3 -c 'import pathlib\np = pathlib.Path(\"a.txt\")'""#;
    let request = json!({"toolCall": {"toolCallId": "write", "kind": "execute",
        "title": "Run python3", "rawInput": {"command": wrapped}}});
    assert_eq!(permission_title(&request), "Run python3 -c 'import pathlib\\np = pathlib.Path(\"a.txt\")'");
}

/// Says "Hi", edits a file, asks to run a command and reports what it was allowed.
#[derive(Default)]
struct FakeAgent {
    /// Every connection's agent side, kept open.
    servers: Mutex<Vec<Peer>>,
    calls: Mutex<Vec<String>>,
    permission_replies: Mutex<Vec<Value>>,
    /// Without `loadSession` (a session lives only as long as its process).
    no_load: bool,
    auth_on_new: bool,
    request_error: Option<(i64, String)>,
    auth_methods: Vec<Value>,
    /// Hold the late mode reply until the prompt's permission request is already waiting.
    hold_late_mode: bool,
    empty_config: AtomicBool,
    /// Config options `session/new` reports after the model one (per-model efforts, say).
    extra_options: Mutex<Vec<Value>>,
    model_options: Mutex<HashMap<String, Vec<Value>>>,
}

impl FakeAgent {
    fn options_for(&self, model: &str) -> Vec<Value> {
        let mut options = vec![json!({"id": "model", "category": "model", "type": "select",
            "currentValue": model,
            "options": [{"value": "big", "name": "Big"}, {"value": "small", "name": "Small"},
                {"value": "plain", "name": "Plain"}, {"value": "unknown", "name": "Unknown"}]})];
        options
            .extend(self.model_options.lock().get(model).cloned().unwrap_or_else(|| self.extra_options.lock().clone()));
        options
    }

    /// The connection opened last: the agent restarted, or a fork's.
    fn latest(&self) -> Peer {
        self.servers.lock().last().cloned().expect("a connection")
    }

    fn update(&self, session: &str, update: Value) {
        let peer = self.latest();
        peer.notify("session/update", json!({ "sessionId": session, "update": update })).unwrap();
    }

    fn say(&self, session: &str, text: &str) {
        self.update(
            session,
            json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}),
        );
    }
}

impl FakeAgent {
    /// Runs a subagent in session `c1`, as an agent with ACP subagent sessions reports it.
    fn delegate(&self, root: &str) {
        let sub = |state: Value| json!({"sessionUpdate": "subagent_update", "sessionId": "c1", "state": state});
        let mut announce = sub(json!({"state": "running"}));
        announce["title"] = json!("Explore");
        self.update(root, announce);
        self.update(
            root,
            json!({"sessionUpdate": "session_message", "messageId": "m1", "senderSessionId": root,
                "recipientSessionId": "c1", "content": [{"type": "text", "text": "Find the lexer"}]}),
        );
        self.update("c1", json!({"sessionUpdate": "usage_update", "used": 900, "size": 1000}));
        self.update(
            "c1",
            json!({"sessionUpdate": "tool_call", "toolCallId": "c1-t1", "title": "Read lexer.rs",
            "kind": "read", "status": "completed"}),
        );
        let peer = self.latest();
        let _: Value = tokio::runtime::Handle::current()
            .block_on(peer.request(
                "session/request_permission",
                json!({"sessionId": "c1", "toolCall": {"toolCallId": "c1-t2", "title": "Run ls"},
                    "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"}]}),
                None,
            ))
            .unwrap();
        self.say("c1", "It is in lexer.rs");
        self.update(root, sub(json!({"state": "idle", "stopReason": "end_turn"})));
        self.update(
            root,
            json!({"sessionUpdate": "session_message", "messageId": "m2", "senderSessionId": "c1",
                "recipientSessionId": root, "content": [{"type": "text", "text": "lexer.rs"}]}),
        );
        self.say(root, "Found it");
    }
}

impl Handler for FakeAgent {
    fn on_notification(&self, method: &str, _: Value) {
        self.calls.lock().push(method.to_owned());
    }

    fn on_request_with_data(&self, method: &str, params: Value) -> Result<Value, (i64, String, Option<Value>)> {
        if method == "session/prompt" && params.pointer("/prompt/0/text") == Some(&json!("limit")) {
            let data = json!({"openidea": {"usageLimit": {"resetsAtMs": 1234.0}}});
            return Err((codes::INTERNAL_ERROR, "You've hit your usage limit".into(), Some(data)));
        }
        self.on_request(method, params).map_err(|(code, message)| (code, message, None))
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        self.calls.lock().push(method.to_owned());
        if (method == "session/new" && self.auth_on_new)
            || (method == "session/prompt" && params.pointer("/prompt/0/text") == Some(&json!("auth")))
        {
            return Err(self
                .request_error
                .clone()
                .unwrap_or((codes::INTERNAL_ERROR, "Authentication required".into())));
        }
        if self.hold_late_mode
            && method == "session/set_config_option"
            && params.get("value").and_then(Value::as_str) == Some("full-access")
        {
            // Let the prompt's permission request reach the task before the mode changes.
            std::thread::sleep(Duration::from_millis(100));
        }
        let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("s1").to_owned();
        match method {
            "initialize" => {
                if params.pointer("/clientCapabilities/subagents").is_some_and(Value::is_object) {
                    self.calls.lock().push("subagents".into());
                }
                Ok(
                    json!({"protocolVersion": 1, "authMethods": self.auth_methods, "agentCapabilities": {"loadSession": !self.no_load,
                    "sessionCapabilities": {"fork": {}}, "_meta": {"openidea": {"rollback": true, "steer": true, "backgroundTasks": true}}}}),
                )
            }
            "session/new" => {
                if self.empty_config.load(Ordering::Acquire) {
                    return Ok(json!({"sessionId": "s1"}));
                }
                let options = self.options_for("big");
                Ok(json!({"sessionId": "s1",
                "modes": {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "code", "name": "Code"}]},
                "configOptions": options}))
            }
            "session/fork" => Ok(json!({"sessionId": "s2"})),
            "_openidea/stop_task" => {
                self.calls.lock().push(format!("{method} {}", params["taskId"]));
                Ok(json!({}))
            }
            "_openidea/rollback" | "_openidea/steer" => {
                let detail = params.get("turns").cloned().unwrap_or_else(|| params["prompt"][0]["text"].clone());
                self.calls.lock().push(format!("{method} {detail}"));
                Ok(json!({}))
            }
            "session/load" => {
                self.say(&session, "replayed history");
                Ok(json!({}))
            }
            "session/set_config_option" | "session/set_mode" => {
                self.calls.lock().push(format!("{method} {}", params.get("value").or(params.get("modeId")).unwrap()));
                if params["configId"] == "model" && !self.model_options.lock().is_empty() {
                    return Ok(json!({"configOptions": self.options_for(params["value"].as_str().unwrap())}));
                }
                Ok(json!({}))
            }
            "session/prompt" => {
                let text = params.pointer("/prompt/0/text").and_then(Value::as_str).unwrap_or_default().to_owned();
                if text == "again" {
                    self.say(&session, "second turn");
                    return Ok(json!({"stopReason": "end_turn"}));
                }
                if text == "background" {
                    // A command that outlives the turn, as the agent reports it.
                    self.update(
                        &session,
                        json!({"sessionUpdate": BACKGROUND_TASKS_UPDATE,
                        "tasks": [{"task_id": "bsh1", "task_type": "local_bash", "description": "sleep 900"}]}),
                    );
                    self.say(&session, "running it in the background");
                    return Ok(json!({"stopReason": "end_turn"}));
                }
                if text == "delegate" {
                    self.delegate(&session);
                    return Ok(json!({"stopReason": "end_turn"}));
                }
                if text == "late option" {
                    // An option the session offers only once it runs.
                    self.update(
                        &session,
                        json!({"sessionUpdate": "config_option_update", "configOptions": [
                            {"id": "model", "category": "model", "type": "select", "currentValue": "big",
                             "options": [{"value": "big", "name": "Big"}, {"value": "small", "name": "Small"}]},
                            {"id": "effort", "category": "thought_level", "type": "select", "currentValue": "low",
                             "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]}]}),
                    );
                    self.say(&session, "ok");
                    return Ok(json!({"stopReason": "end_turn"}));
                }
                if text == "late full access" {
                    // The mode option appears only now; the user's choice is applied late.
                    self.update(
                        &session,
                        json!({"sessionUpdate": "config_option_update", "configOptions": [
                            {"id": "mode", "category": "mode", "type": "select", "currentValue": "ask",
                             "options": [{"value": "ask", "name": "Ask"}, {"value": "full-access", "name": "Full Access"}]}
                        ]}),
                    );
                    let peer = self.latest();
                    let answer: Value = tokio::runtime::Handle::current()
                        .block_on(peer.request(
                            "session/request_permission",
                            json!({"sessionId": session, "toolCall": {"toolCallId": "late", "title": "Run cargo test"},
                                "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"},
                                            {"optionId": "no", "name": "Reject", "kind": "reject_once"}]}),
                            None,
                        ))
                        .unwrap();
                    let chosen = answer.pointer("/outcome/optionId").and_then(Value::as_str).unwrap_or("none");
                    self.say(&session, &format!("late chose {chosen}"));
                    return Ok(json!({"stopReason": "end_turn"}));
                }
                if text == "ask" {
                    let peer = self.latest();
                    let answer: Value = tokio::runtime::Handle::current()
                        .block_on(peer.request(
                            "session/request_permission",
                            json!({"sessionId": session,
                                "toolCall": {"toolCallId": "q1", "title": "AskUserQuestion", "_meta": {"questions": [
                                    {"question": "Which layout?", "options": [{"label": "List"}, {"label": "Grid"}]},
                                    {"question": "Which checks?", "multiSelect": true,
                                     "options": [{"label": "Disk"}, {"label": "GPU temps"}]}]}},
                                "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"}]}),
                            None,
                        ))
                        .unwrap();
                    self.permission_replies.lock().push(answer.clone());
                    let chosen = answer.pointer("/outcome/optionId").and_then(Value::as_str).unwrap_or("none");
                    self.say(&session, &format!("answered {chosen}"));
                    return Ok(json!({ "stopReason": "end_turn" }));
                }
                if text == "qwen ask" {
                    // Qwen Code's ACP dialect: the questions as `qwenQuestions`, Submit and
                    // Cancel as the options, the answers keyed by question index.
                    let peer = self.latest();
                    let answer: Value = tokio::runtime::Handle::current()
                        .block_on(peer.request(
                            "session/request_permission",
                            json!({"sessionId": session,
                                "toolCall": {"toolCallId": "q2", "title": "Ask user 2 questions", "kind": "think",
                                    "_meta": {"toolName": "ask_user_question", "qwenInteractionKind": "user_question",
                                        "qwenQuestions": [
                                            {"question": "Which database?", "header": "Database", "options": [
                                                {"label": "Postgres", "description": "Relational"},
                                                {"label": "Redis", "description": "Key-value"}]},
                                            {"question": "Which caches?", "header": "Caches", "multiSelect": true,
                                             "options": [{"label": "Disk"}, {"label": "Memory"}]}]}},
                                "options": [{"optionId": "proceed_once", "name": "Submit", "kind": "allow_once"},
                                            {"optionId": "cancel", "name": "Cancel", "kind": "reject_once"}]}),
                            None,
                        ))
                        .unwrap();
                    let outcome = answer.pointer("/outcome/outcome").and_then(Value::as_str).unwrap_or("none");
                    let option = answer.pointer("/outcome/optionId").and_then(Value::as_str).unwrap_or("none");
                    let answers = answer.get("answers").cloned().unwrap_or(Value::Null);
                    self.say(&session, &format!("answered {outcome} {option} {answers}"));
                    return Ok(json!({ "stopReason": "end_turn" }));
                }
                if text == "wait" {
                    // Works until cancelled.
                    while !self.calls.lock().iter().any(|c| c == "session/cancel") {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    return Ok(json!({"stopReason": "cancelled"}));
                }
                self.update(
                    &session,
                    json!({"sessionUpdate": "available_commands_update",
                    "availableCommands": [{"name": "review", "description": "Review", "input": {"hint": "focus"}}]}),
                );
                self.update(
                    &session,
                    json!({"sessionUpdate": "usage_update", "used": 50, "size": 1000,
                    "cost": {"amount": 0.25, "currency": "USD"}}),
                );
                self.update(
                    &session,
                    json!({"sessionUpdate": LIMITS_UPDATE,
                    "limits": [{"window": "five_hour", "usedPercent": 19.0, "resetsMs": 5000.0}]}),
                );
                self.update(&session, json!({"sessionUpdate": "session_info_update", "title": "Lexer fix"}));
                self.say(&session, "Hi");
                self.update(
                    &session,
                    json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit a.rs",
                    "kind": "edit", "status": "completed",
                    "content": [{"type": "diff", "path": "/p/a.rs", "oldText": "a\n", "newText": "b\n"}]}),
                );
                let peer = self.latest();
                let answer: Value = tokio::runtime::Handle::current()
                    .block_on(peer.request(
                        "session/request_permission",
                        json!({"sessionId": session, "toolCall": {"toolCallId": "t1", "title": "Run cargo test"},
                            "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"},
                                        {"optionId": "no", "name": "Reject", "kind": "reject_once"}]}),
                        None,
                    ))
                    .unwrap();
                let chosen = answer.pointer("/outcome/optionId").and_then(Value::as_str).unwrap_or("none");
                self.say(&session, &format!("chose {chosen}"));
                Ok(json!({"stopReason": "end_turn"}))
            }
            _ => Err((codes::METHOD_NOT_FOUND, method.to_owned())),
        }
    }
}

fn manager(dir: &Path, agent: Arc<FakeAgent>) -> AgentManager {
    manager_at(dir, &dir.join("models.json"), agent)
}

fn manager_at(dir: &Path, models_file: &Path, agent: Arc<FakeAgent>) -> AgentManager {
    // These tests speak to FakeAgent, never an installed CLI, including after a provider reload.
    let agents = dir.join("agents");
    provider::set_builtin_command(&agents, "claude", Some(&dir.join("missing-claude").to_string_lossy())).unwrap();
    let connector: Connector = Arc::new(move |_spec, _cwd, client, _stderr| {
        let (a, b) = duplex(1 << 20);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        let server = Peer::connect_framed(br, bw, agent.clone(), Framing::Lines);
        agent.servers.lock().push(server);
        Ok(Peer::connect_framed(ar, aw, client, Framing::Lines))
    });
    AgentManager::with_connector(
        AgentPaths {
            project_root: dir.to_path_buf(),
            store_dir: dir.join("store"),
            worktrees_dir: dir.join("worktrees"),
            models_file: models_file.to_path_buf(),
            custom_agents_dir: Some(agents),
            // The project is the boundary of the skill walk: nothing above it (such as the
            // user's profile, when temp lives under it) leaks into the test.
            home_dir: Some(dir.to_path_buf()),
        },
        tokio::runtime::Handle::current(),
        connector,
    )
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn claude_commands_before_session_are_fetched_once_and_saved() {
    use std::os::unix::fs::PermissionsExt;

    for outcome in ["success", "error", "exit", "timeout", "missing"] {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let script = root.join("fake-claude");
        std::fs::write(
            &script,
            r#"#!/usr/bin/env python3
import json, os, pathlib, sys, time
root = pathlib.Path.cwd()
with (root / 'launches').open('a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\n')
request = json.loads(sys.stdin.readline())
with (root / 'requests').open('a') as f:
    f.write(json.dumps(request) + '\n')
outcome = os.environ['OUTCOME']
if outcome == 'exit':
    sys.exit(1)
if outcome == 'timeout':
    time.sleep(60)
response = {'subtype': outcome, 'request_id': request['request_id']}
if outcome == 'success':
    response['response'] = {'commands': [
        {'name': 'compact', 'description': 'Free up context', 'argumentHint': '[instructions]'},
        {'name': 'clear'}, {'name': 'model'}, {'name': 'context'}]}
else:
    response['error'] = 'Authentication required'
print(json.dumps({'type': 'control_response', 'response': response}), flush=True)
for line in sys.stdin:
    with (root / 'requests').open('a') as f:
        f.write(line)
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::create_dir_all(root.join(".claude/skills/triage")).unwrap();
        std::fs::write(root.join(".claude/skills/triage/SKILL.md"), "---\nname: triage\ndescription: Triage\n---\n")
            .unwrap();
        let mgr = manager(root, Arc::new(FakeAgent::default()));
        {
            let mut providers = mgr.shared.providers.write();
            let spec = providers.iter_mut().find(|p| p.id == "claude").unwrap();
            if outcome != "missing" {
                spec.command = script.to_string_lossy().into_owned();
            }
            spec.env = vec![("OUTCOME".into(), outcome.into())];
        }
        let (first, concurrent) = tokio::join!(mgr.commands("claude", None), mgr.commands("claude", None));
        let first = first.unwrap();
        assert_eq!(first, concurrent.unwrap());
        assert_eq!(first, mgr.commands("claude", None).await.unwrap());
        let names: Vec<_> = first.iter().map(|c| c.name.as_str()).collect();
        if outcome == "success" {
            assert_eq!(names, ["compact", "clear", "model", "context", "triage"]);
            assert_eq!(first[0].hint.as_deref(), Some("[instructions]"));
            let restored = manager(root, Arc::new(FakeAgent::default()));
            assert_eq!(first, restored.commands("claude", None).await.unwrap());
        } else {
            assert_eq!(names, ["triage"], "{outcome}");
            assert!(!root.join("models.json").exists());
        }
        assert!(mgr.tasks.read().is_empty());
        assert!(!root.join("store").exists());
        if outcome != "missing" {
            let launches = std::fs::read_to_string(root.join("launches")).unwrap();
            assert_eq!(launches.lines().count(), 1, "{outcome}");
            let args: Vec<String> = serde_json::from_str(launches.trim()).unwrap();
            assert!(args.windows(2).any(|a| a == ["--input-format", "stream-json"]));
            let requests = std::fs::read_to_string(root.join("requests")).unwrap();
            assert_eq!(requests.lines().count(), 1, "only initialize, no prompt or other control request");
            let request: Value = serde_json::from_str(requests.trim()).unwrap();
            assert_eq!(request["type"], "control_request");
            assert_eq!(request["request"]["subtype"], "initialize");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn authentication_failures_name_the_session_executable_at_start_and_during_prompts() {
    for auth_on_new in [true, false] {
        let tmp = tempfile::tempdir().unwrap();
        let agent = Arc::new(FakeAgent { auth_on_new, ..Default::default() });
        let mgr = manager(tmp.path(), agent);
        let program = tmp.path().join("Agent Tools").join("renamed-cursor.cmd");
        mgr.shared.providers.write().iter_mut().find(|s| s.id == "cursor").unwrap().command =
            program.to_string_lossy().into_owned();
        let task = mgr
            .create(NewAgentTask {
                project_root: None,
                prompt: text("again"),
                provider: "cursor".into(),
                config: vec![],
                isolation: Isolation::Local,
                base: None,
            })
            .await
            .unwrap();
        if !auth_on_new {
            wait_for(&mgr, &task.id, AgentStatus::Ready).await;
            // A settings change must not redirect guidance for the already running process.
            mgr.shared.providers.write().iter_mut().find(|s| s.id == "cursor").unwrap().command =
                "different-cursor".into();
            mgr.prompt(&task.id, text("auth"), false).await.unwrap();
        }
        wait_for(&mgr, &task.id, AgentStatus::Failed).await;
        let entries = mgr.entries(&task.id, None).unwrap();
        let error = entries
            .iter()
            .find_map(|e| match e {
                AgentEntry::Error { message, .. } => Some(message),
                _ => None,
            })
            .expect("authentication error");
        assert!(error.starts_with("Cursor needs you to sign in. Run `"), "{error}");
        assert!(error.contains(&*program.to_string_lossy()), "{error}");
        assert!(error.ends_with(" login` in a terminal.\n\nAuthentication required"), "{error}");
        mgr.shutdown();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sign_in_errors_preserve_details_and_leave_unrelated_errors_unchanged() {
    for auth_on_new in [true, false] {
        for (code, message, sign_in) in [
            (-32000, "This Google account is not eligible for this agent.", true),
            (codes::INTERNAL_ERROR, "Authentication failed: token expired for account alice.", true),
            (codes::INTERNAL_ERROR, "UNAUTHORIZED: account refused", true),
            (codes::INTERNAL_ERROR, "You are not logged in to this installation.", true),
            (codes::INTERNAL_ERROR, "Please sign in with your work account.", true),
            (codes::INTERNAL_ERROR, "Missing author field", false),
            (codes::INTERNAL_ERROR, "Unknown authority in configuration", false),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let agent =
                Arc::new(FakeAgent { auth_on_new, request_error: Some((code, message.into())), ..Default::default() });
            let mgr = manager(tmp.path(), agent);
            let task = mgr
                .create(NewAgentTask {
                    project_root: None,
                    prompt: text("again"),
                    provider: "cursor".into(),
                    config: vec![],
                    isolation: Isolation::Local,
                    base: None,
                })
                .await
                .unwrap();
            if !auth_on_new {
                wait_for(&mgr, &task.id, AgentStatus::Ready).await;
                mgr.prompt(&task.id, text("auth"), false).await.unwrap();
            }
            wait_for(&mgr, &task.id, AgentStatus::Failed).await;
            let entries = mgr.entries(&task.id, None).unwrap();
            let error = entries
                .iter()
                .find_map(|e| match e {
                    AgentEntry::Error { message, .. } => Some(message),
                    _ => None,
                })
                .unwrap();
            if sign_in {
                assert!(error.starts_with("Cursor needs you to sign in. Run `"), "{error}");
                assert!(error.ends_with(&format!("\n\n{message}")), "{error}");
            } else {
                assert_eq!(error, message);
            }
            mgr.shutdown();
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn registry_sign_in_errors_use_the_advertised_terminal_login() {
    for terminal in [true, false] {
        let tmp = tempfile::tempdir().unwrap();
        let agent = Arc::new(FakeAgent {
            auth_on_new: true,
            request_error: Some((-32000, "This account is not eligible.".into())),
            auth_methods: vec![json!({"type": if terminal { "terminal" } else { "agent" },
                "id": "cli", "name": "CLI", "args": ["auth", "login"]})],
            ..Default::default()
        });
        let mgr = manager(tmp.path(), agent);
        let program = tmp.path().join("Registry Tools").join("antigravity.cmd");
        let mut spec = provider::builtin_spec("cursor").unwrap();
        spec.id = "antigravity".into();
        spec.name = "Google Antigravity".into();
        spec.command = program.to_string_lossy().into_owned();
        spec.source = AgentSource::Registry { version: "1.4.5".into(), update: None };
        spec.login_hint = "Sign in with the agent's own command line first.".into();
        mgr.shared.providers.write().push(spec);
        let task = mgr
            .create(NewAgentTask {
                project_root: None,
                prompt: text("again"),
                provider: "antigravity".into(),
                config: vec![],
                isolation: Isolation::Local,
                base: None,
            })
            .await
            .unwrap();
        wait_for(&mgr, &task.id, AgentStatus::Failed).await;
        let entries = mgr.entries(&task.id, None).unwrap();
        let error = entries
            .iter()
            .find_map(|e| match e {
                AgentEntry::Error { message, .. } => Some(message),
                _ => None,
            })
            .unwrap();
        assert!(error.starts_with("Google Antigravity needs you to sign in. "), "{error}");
        if terminal {
            assert!(error.contains(&*program.to_string_lossy()), "{error}");
            assert!(error.contains(" auth login` in a terminal."), "{error}");
        } else {
            assert!(error.contains("Sign in with the agent's own command line first."), "{error}");
        }
        assert!(error.ends_with("\n\nThis account is not eligible."), "{error}");
        mgr.shutdown();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_are_remembered_per_project_and_merged_with_skills_on_disk() {
    let tmp = tempfile::tempdir().unwrap();
    let (a, b, models) = (tmp.path().join("a"), tmp.path().join("b"), tmp.path().join("models.json"));
    std::fs::create_dir_all(a.join(".claude/skills/triage")).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(a.join(".claude/skills/triage/SKILL.md"), "---\nname: triage\ndescription: Triage\n---\n").unwrap();
    let names = |c: Vec<AgentCommand>| c.into_iter().map(|c| c.name).collect::<Vec<_>>();

    let mgr_a = manager_at(&a, &models, Arc::new(FakeAgent::default()));
    // Before any session: only the skills on disk.
    assert_eq!(names(mgr_a.commands("claude", None).await.unwrap()), ["triage"]);
    let task = mgr_a
        .create(NewAgentTask {
            project_root: None,
            prompt: text("Fix the lexer"),
            provider: "claude".into(),
            config: Vec::new(),
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr_a, &task.id, AgentStatus::NeedsInput).await;
    assert_eq!(names(mgr_a.commands("claude", None).await.unwrap()), ["review", "triage"]);
    assert_eq!(names(mgr_a.commands("claude", Some(&task.id)).await.unwrap()), ["review", "triage"]);
    // Other agents get only what they offered.
    assert!(mgr_a.commands("codex", None).await.unwrap().is_empty());
    mgr_a.cancel(&task.id, None).unwrap();
    wait_for(&mgr_a, &task.id, AgentStatus::Ready).await;
    mgr_a.shutdown();

    // Another project shares the settings but not the commands.
    let mgr_b = manager_at(&b, &models, Arc::new(FakeAgent::default()));
    let claude = mgr_b.providers().into_iter().find(|p| p.id == "claude").unwrap();
    assert_eq!(claude.config.len(), 2);
    assert!(claude.commands.is_empty());
    assert!(mgr_b.commands("claude", None).await.unwrap().is_empty());
    let mgr_a = manager_at(&a, &models, Arc::new(FakeAgent::default()));
    assert_eq!(names(mgr_a.providers().into_iter().find(|p| p.id == "claude").unwrap().commands), ["review"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn builtin_commands_only_fill_verified_gaps_and_preserve_advertised_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager_at(tmp.path(), &tmp.path().join("models.json"), agent);
    for provider in ["claude", "claude-acp", "opencode2", "codex", "custom"] {
        assert!(mgr.commands(provider, None).await.unwrap().is_empty(), "{provider}");
    }
    let commands = mgr.commands("opencode", None).await.unwrap();
    assert_eq!(commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["compact"]);
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("Hello"),
            provider: "opencode".into(),
            config: Vec::new(),
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    let advertised = AgentCommand {
        name: "compact".into(),
        description: "Agent supplied description".into(),
        hint: Some("instructions".into()),
        source: AgentCommandSource::Command,
    };
    mgr.task(&task.id).unwrap().state.lock().task.commands = vec![advertised.clone()];
    // The task's provider wins over the caller's provider; metadata is not replaced.
    let commands = mgr.commands("claude", Some(&task.id)).await.unwrap();
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].name, advertised.name);
    assert_eq!(commands[0].description, advertised.description);
    assert_eq!(commands[0].hint, advertised.hint);
    // Finish the in-process agent before Tokio stops driving its permission response.
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    mgr.shutdown();
}

async fn wait_for(mgr: &AgentManager, id: &str, status: AgentStatus) {
    for _ in 0..500 {
        let task = mgr.task(id).unwrap();
        let (current, busy) = {
            let s = task.state.lock();
            (s.task.status, s.busy)
        };
        // Settled statuses only count once the run is over (a prompt just sent hasn't started).
        let settled = !matches!(status, AgentStatus::Ready | AgentStatus::Failed | AgentStatus::Limited) || !busy;
        if current == status && settled {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let s = mgr.task(id).unwrap().state.lock().task.status;
    panic!("task never reached {status:?} (is {s:?})");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_runs_asks_for_permission_and_survives_a_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let events = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
    let sink = events.clone();
    mgr.subscribe(Arc::new(move |e| sink.lock().push(e)));

    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("Fix the lexer\nmore detail"),
            provider: "claude".into(),
            config: vec![AgentConfigChoice { id: "model".into(), value: "small".into() }],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    assert_eq!(task.title, "Fix the lexer");
    assert_ne!(mgr.task(&task.id).unwrap().state.lock().task.status, AgentStatus::Ready, "a new task is not settled");
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;

    let permission = mgr
        .entries(&task.id, None)
        .unwrap()
        .iter()
        .find_map(|e| match e {
            AgentEntry::Permission { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap();
    mgr.respond(&task.id, permission, Some("yes".into())).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;

    let entries = mgr.entries(&task.id, None).unwrap();
    let kinds: Vec<String> = entries
        .iter()
        .map(|e| match e {
            AgentEntry::User { text, .. } | AgentEntry::Agent { text } => text.clone(),
            AgentEntry::Tool { title, .. } => title.clone(),
            AgentEntry::Permission { chosen, .. } => format!("permission: {}", chosen.clone().unwrap_or_default()),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(kinds, ["Fix the lexer\nmore detail", "Hi", "Edit a.rs", "permission: Allow", "chose yes"]);
    assert!(
        agent.calls.lock().contains(&"session/set_config_option \"small\"".to_owned()),
        "switched to the chosen model"
    );
    {
        let t = mgr.task(&task.id).unwrap().state.lock().task.clone();
        assert_eq!(t.model.as_deref(), Some("small"));
        let modes = t.config.iter().find(|o| o.id == "mode").unwrap();
        assert_eq!((modes.via, modes.current.as_deref()), (AgentConfigVia::Mode, Some("ask")));
        assert_eq!(t.commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["review"]);
        assert_eq!(t.usage.as_ref().map(|u| (u.used, u.size)), Some((50, 1000)));
        assert_eq!(
            t.usage.as_ref().and_then(|u| u.cost.clone()),
            Some(Box::new(AgentCost { amount: 0.25, currency: "USD".into() }))
        );
        assert_eq!(t.title, "Lexer fix", "the agent's title replaces the prompt's first line");
    }
    mgr.set_config(&task.id, "mode", "code".into()).await.unwrap();
    assert!(agent.calls.lock().contains(&"session/set_mode \"code\"".to_owned()));
    assert!(mgr.set_config(&task.id, "mode", "nope".into()).await.is_err());

    tokio::time::sleep(FLUSH_DELAY * 3).await;
    {
        let events = events.lock();
        assert!(
            events.iter().any(|e| matches!(e, AgentEvent::Task { task } if task.status == AgentStatus::NeedsInput))
        );
        let limits = events.iter().find_map(|e| match e {
            AgentEvent::Limits { provider, limits } => Some((provider.as_str(), limits.clone())),
            _ => None,
        });
        assert_eq!(
            limits,
            Some((
                task.provider.as_str(),
                vec![AgentLimit { window: "five_hour".into(), used_percent: 19.0, resets_ms: Some(5000.0) }]
            )),
            "an agent's usage limits are its provider's"
        );
        let last_entry = events.iter().rev().find_map(|e| match e {
            AgentEvent::Entry { index, entry, .. } if !matches!(entry, AgentEntry::User { .. }) => {
                Some((*index, entry.clone()))
            }
            _ => None,
        });
        assert_eq!(last_entry, Some((4, AgentEntry::Agent { text: "chose yes".into() })));
        // The turn's end is recorded on the message that started it.
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::Entry { index: 0, entry: AgentEntry::User { sent_ms: Some(_), done_ms: Some(_), .. }, .. }
        )));
    }
    let providers = mgr.providers();
    let claude = providers.iter().find(|p| p.id == "claude").unwrap();
    assert_eq!(claude.config.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["model", "mode"]);
    assert_eq!(claude.commands.len(), 1);

    // A new manager (IDE restart) finds the task and resumes its session without duplicating history.
    mgr.shutdown();
    let agent2 = Arc::new(FakeAgent::default());
    let mgr2 = manager(tmp.path(), agent2.clone());
    assert_eq!(mgr2.entries(&task.id, None).unwrap().len(), 5);
    assert_eq!(mgr2.task(&task.id).unwrap().state.lock().task.title, "Lexer fix");
    assert_eq!(mgr2.providers().iter().find(|p| p.id == "claude").unwrap().config.len(), 2);
    mgr2.prompt(&task.id, text("again"), false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    wait_for(&mgr2, &task.id, AgentStatus::Ready).await;
    let entries = mgr2.entries(&task.id, None).unwrap();
    assert_eq!(entries.len(), 7);
    assert_eq!(entries[6], AgentEntry::Agent { text: "second turn".into() });
    assert!(agent2.calls.lock().contains(&"session/load".to_owned()));
    // The chosen settings are re-applied to the reloaded session.
    let calls = agent2.calls.lock().clone();
    assert!(calls.contains(&"session/set_mode \"code\"".to_owned()), "{calls:?}");
}

fn text(t: &str) -> AgentPrompt {
    AgentPrompt { text: t.into(), ..AgentPrompt::default() }
}

#[tokio::test(flavor = "multi_thread")]
async fn messages_sent_while_busy_are_queued_and_send_now_interrupts() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("wait"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Running).await;
    mgr.prompt(&task.id, text("again"), false).await.unwrap();
    let queue = mgr.task(&task.id).unwrap().state.lock().task.queue.clone();
    assert_eq!(queue.iter().map(|q| q.prompt.text.as_str()).collect::<Vec<_>>(), ["again"]);
    assert!(mgr.prompt(&task.id, text("  "), false).await.is_err());

    mgr.send_queued_now(&task.id, &queue[0].id).unwrap();
    for _ in 0..500 {
        if mgr.entries(&task.id, None).unwrap().iter().any(|e| *e == AgentEntry::Agent { text: "second turn".into() }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let users: Vec<String> = mgr
        .entries(&task.id, None)
        .unwrap()
        .into_iter()
        .filter_map(|e| match e {
            AgentEntry::User { text, .. } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(users, ["wait", "again"]);
    assert!(mgr.task(&task.id).unwrap().state.lock().task.queue.is_empty());

    // Stopping a turn keeps the queue for later.
    mgr.prompt(&task.id, text("wait"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Running).await;
    agent.calls.lock().retain(|c| c != "session/cancel");
    mgr.prompt(&task.id, text("later"), false).await.unwrap();
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let queued = mgr.task(&task.id).unwrap().state.lock().task.queue.clone();
    assert_eq!(queued.len(), 1);
    assert_eq!(mgr.unqueue(&task.id, &queued[0].id).unwrap().prompt.text, "later");
    assert!(mgr.task(&task.id).unwrap().state.lock().task.queue.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn subagents_get_their_own_conversation() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("delegate"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    // The subagent's permission request is answered in the task's conversation.
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    let (id, title) = mgr
        .entries(&task.id, None)
        .unwrap()
        .into_iter()
        .find_map(|e| match e {
            AgentEntry::Permission { id, title, .. } => Some((id, title)),
            _ => None,
        })
        .unwrap();
    assert_eq!(title, "Explore: Run ls");
    mgr.respond(&task.id, id, Some("yes".into())).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(agent.calls.lock().iter().any(|c| c == "subagents"));

    let check = |mgr: &AgentManager| {
        let main = mgr.entries(&task.id, None).unwrap();
        let card = main.iter().find(|e| matches!(e, AgentEntry::Subagent { .. })).unwrap();
        let AgentEntry::Subagent { title, status, prompt, reply, tools, activity, .. } = card else { unreachable!() };
        assert_eq!(title.as_deref(), Some("Explore"));
        assert_eq!(*status, AgentSubagentStatus::Done);
        assert_eq!((prompt.as_deref(), reply.as_deref()), (Some("Find the lexer"), Some("lexer.rs")));
        assert_eq!((*tools, activity.as_deref()), (1, Some("Read lexer.rs")));
        assert!(main.contains(&AgentEntry::Agent { text: "Found it".into() }));
        assert!(!main.iter().any(|e| matches!(e, AgentEntry::Tool { .. })));
        let sub = mgr.entries(&task.id, Some("c1".into())).unwrap();
        assert!(matches!(&sub[0], AgentEntry::Tool { title, .. } if title == "Read lexer.rs"));
        assert_eq!(sub[1], AgentEntry::Agent { text: "It is in lexer.rs".into() });
    };
    // Updates can trail the end of the turn.
    for _ in 0..500 {
        if mgr.entries(&task.id, None).unwrap().contains(&AgentEntry::Agent { text: "Found it".into() }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    check(&mgr);
    // The subagent's context use is not the task's.
    assert_ne!(mgr.task(&task.id).unwrap().state.lock().task.usage.as_ref().map(|u| u.used), Some(900));
    assert!(mgr.entries(&task.id, Some("nope".into())).is_err());

    // Saved with the task.
    mgr.shutdown();
    check(&manager(tmp.path(), Arc::new(FakeAgent::default())));
}

#[test]
fn prompts_become_acp_content_blocks() {
    let p = AgentPrompt {
        text: "look".into(),
        files: vec![IpcPath(PathBuf::from("/p/my file.rs"))],
        images: vec![AgentImage { mime_type: "image/png".into(), data: "AAA".into(), name: None }],
    };
    assert_eq!(
        blocks(&p, &[]),
        [
            json!({"type": "text", "text": "look"}),
            json!({"type": "resource_link", "uri": "file:///p/my%20file.rs", "name": "my file.rs"}),
            json!({"type": "image", "mimeType": "image/png", "data": "AAA"}),
        ]
    );
    assert_eq!(
        blocks(&p, &[Some("fn a() {}".into())])[1],
        json!({"type": "resource", "resource": {"uri": "file:///p/my%20file.rs", "text": "fn a() {}"}})
    );
    // A slash command goes through as typed: the agent runs it.
    let skill = clean(text(" /triage dry-run\n")).unwrap();
    assert_eq!(blocks(&skill, &[]), [json!({"type": "text", "text": "/triage dry-run"})]);
    let old = upgrade(
        json!({"task": {"id": "t"}, "entries": [{"type": "user", "text": "hi"}, {"type": "agent", "text": "a"}]}),
    );
    assert_eq!(old["task"]["queue"], json!([]));
    assert_eq!(old["entries"][0]["attachments"], json!([]));
    assert!(old["entries"][1].get("attachments").is_none());
    assert_eq!(title_of(&AgentPrompt { files: p.files.clone(), ..AgentPrompt::default() }), "my file.rs");
    assert!(clean(text(" ")).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_questions_keep_the_answer_object_as_the_option_id() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("ask"),
            provider: "codex".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    let question = mgr
        .entries(&task.id, None)
        .unwrap()
        .iter()
        .find_map(|e| match e {
            AgentEntry::Permission { id, title, questions, .. } => {
                assert_eq!(title, "AskUserQuestion");
                assert_eq!(questions.len(), 2);
                assert_eq!(questions[0].question, "Which layout?");
                assert!(!questions[0].multi_select);
                assert_eq!(questions[1].question, "Which checks?");
                assert!(questions[1].multi_select);
                Some(*id)
            }
            _ => None,
        })
        .unwrap();
    let reply = json!({"Which layout?": ["List"], "Which checks?": ["Disk", "GPU temps"]}).to_string();
    mgr.respond(&task.id, question, Some(reply.clone())).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert_eq!(*agent.permission_replies.lock(), [json!({"outcome": {"outcome": "selected", "optionId": reply}})]);

    let entries = mgr.entries(&task.id, None).unwrap();
    assert!(
        entries
            .iter()
            .any(|e| matches!(e, AgentEntry::Permission { chosen: Some(c), .. } if c == "List; Disk, GPU temps")),
        "{entries:?}"
    );
}

/// Qwen Code asks its questions as `_meta.qwenQuestions` with Submit/Cancel options; the
/// card answers with `answers` keyed by question index beside the Submit option's id.
#[tokio::test(flavor = "multi_thread")]
async fn qwen_questions_answer_by_index_beside_the_submit_option() {
    let tmp = tempfile::tempdir().unwrap();
    let mgr = manager(tmp.path(), Arc::new(FakeAgent::default()));
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("qwen ask"),
            provider: "codex".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    let (id, title, questions) = mgr
        .entries(&task.id, None)
        .unwrap()
        .iter()
        .find_map(|e| match e {
            AgentEntry::Permission { id, title, questions, .. } => Some((*id, title.clone(), questions.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(title, "Which database?", "the first question, not the request's own title");
    assert_eq!(
        questions,
        vec![
            AgentQuestion {
                answer_key: None,
                header: "Database".into(),
                question: "Which database?".into(),
                multi_select: false,
                options: vec![
                    AgentQuestionOption { label: "Postgres".into(), description: "Relational".into(), preview: None },
                    AgentQuestionOption { label: "Redis".into(), description: "Key-value".into(), preview: None },
                ],
            },
            AgentQuestion {
                answer_key: None,
                header: "Caches".into(),
                question: "Which caches?".into(),
                multi_select: true,
                options: vec![
                    AgentQuestionOption { label: "Disk".into(), description: String::new(), preview: None },
                    AgentQuestionOption { label: "Memory".into(), description: String::new(), preview: None },
                ],
            },
        ]
    );
    let reply = json!({"Which database?": ["Postgres"], "Which caches?": ["Disk", "Memory"]}).to_string();
    mgr.respond(&task.id, id, Some(reply)).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;

    let entries = mgr.entries(&task.id, None).unwrap();
    let expected = format!("answered selected proceed_once {}", json!({"0": "Postgres", "1": "Disk, Memory"}));
    assert!(entries.iter().any(|e| matches!(e, AgentEntry::Agent { text } if text == &expected)), "{entries:?}");
    assert!(
        entries
            .iter()
            .any(|e| matches!(e, AgentEntry::Permission { chosen: Some(c), .. } if c == "Postgres; Disk, Memory")),
        "{entries:?}"
    );
}

/// A skipped Qwen question cancels the request: qwen-code reads the answers it expects
/// only beside a chosen option, and `reject` is none of the options it offered.
#[tokio::test(flavor = "multi_thread")]
async fn skipped_qwen_questions_cancel_the_request() {
    let tmp = tempfile::tempdir().unwrap();
    let mgr = manager(tmp.path(), Arc::new(FakeAgent::default()));
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("qwen ask"),
            provider: "codex".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    let id = mgr
        .entries(&task.id, None)
        .unwrap()
        .iter()
        .find_map(|e| match e {
            AgentEntry::Permission { id, questions, .. } if !questions.is_empty() => Some(*id),
            _ => None,
        })
        .unwrap();
    mgr.respond(&task.id, id, Some("reject".into())).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;

    let entries = mgr.entries(&task.id, None).unwrap();
    assert!(
        entries.iter().any(|e| matches!(e, AgentEntry::Agent { text } if text == "answered cancelled none null")),
        "{entries:?}"
    );
    assert!(
        entries.iter().any(|e| matches!(e, AgentEntry::Permission { chosen: Some(c), .. } if c == "Cancelled")),
        "{entries:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_resolves_the_open_permission_and_delete_forgets_the_task() {
    let tmp = tempfile::tempdir().unwrap();
    let mgr = manager(tmp.path(), Arc::new(FakeAgent::default()));
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("do it"),
            provider: "codex".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let entries = mgr.entries(&task.id, None).unwrap();
    assert!(entries.iter().any(|e| matches!(e, AgentEntry::Permission { chosen: Some(c), .. } if c == "Cancelled")));
    assert_eq!(entries.last(), Some(&AgentEntry::Agent { text: "chose none".into() }));
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.model.as_deref(), Some("big"), "the agent's default");

    mgr.delete(&task.id, false).await.unwrap();
    assert!(mgr.entries(&task.id, None).is_err());
    assert!(!tmp.path().join("store").join(format!("{}.json", task.id)).exists());
    assert!(
        mgr.create(NewAgentTask {
            project_root: None,
            prompt: text(" "),
            provider: "codex".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None
        })
        .await
        .is_err()
    );
}

/// Drives the real Claude Code adapter (needs `npx`, network and a signed-in `claude`):
/// `OPENIDEA_AGENT_E2E=1 cargo test -p ide-agent real_claude -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_claude_task_in_a_worktree() {
    if std::env::var_os("OPENIDEA_AGENT_E2E").is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["commit", "-q", "--allow-empty", "-m", "init"]] {
        let ok = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(&repo)
            .status()
            .unwrap()
            .success();
        assert!(ok);
    }
    let mgr = AgentManager::new(
        AgentPaths {
            project_root: repo.clone(),
            store_dir: tmp.path().join("store"),
            worktrees_dir: tmp.path().join("wt"),
            models_file: tmp.path().join("models.json"),
            custom_agents_dir: None,
            home_dir: None,
        },
        tokio::runtime::Handle::current(),
    );
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("Create a file named hello.txt containing the single word hi. Do nothing else."),
            provider: "claude".into(),
            config: vec![AgentConfigChoice { id: "model".into(), value: "haiku".into() }],
            isolation: Isolation::Worktree,
            base: None,
        })
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(240);
    loop {
        assert!(std::time::Instant::now() < deadline, "timed out");
        let status = mgr.task(&task.id).unwrap().state.lock().task.status;
        match status {
            AgentStatus::NeedsInput => {
                let pending = mgr.entries(&task.id, None).unwrap().into_iter().rev().find_map(|e| match e {
                    AgentEntry::Permission { id, options, chosen: None, .. } => Some((id, options)),
                    _ => None,
                });
                if let Some((id, options)) = pending {
                    let allow = options.iter().find(|o| o.kind == "allow_once").or(options.first()).unwrap();
                    eprintln!("allowing: {}", allow.name);
                    let _ = mgr.respond(&task.id, id, Some(allow.id.clone()));
                }
            }
            AgentStatus::Ready | AgentStatus::Failed => break,
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    for e in mgr.entries(&task.id, None).unwrap() {
        eprintln!("{e:?}");
    }
    let t = mgr.task(&task.id).unwrap().state.lock().task.clone();
    assert_eq!(t.status, AgentStatus::Ready, "{:?}", t.error);
    assert_eq!(t.model.as_deref(), Some("haiku"));
    let changes = mgr.changes(&task.id).await.unwrap();
    assert!(changes.iter().any(|c| c.rel_path == "hello.txt"), "{changes:?}");
    assert!(!repo.join("hello.txt").exists(), "the project checkout is untouched");
    assert!(!mgr.providers().iter().find(|p| p.id == "claude").unwrap().config.is_empty());
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn renamed_titles_survive_updates_forks_and_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("again"),
            provider: "claude".into(),
            config: Vec::new(),
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let handle = mgr.task(&task.id).unwrap();
    assert!(mgr.rename(&task.id, "  ").is_err());
    let initial = handle.state.lock().task.title.clone();
    for title in [initial, "My task".to_owned(), "名".repeat(205)] {
        mgr.rename(&task.id, &title).unwrap();
        handle.on_update(None, &json!({"sessionUpdate": "session_info_update", "title": "Agent title"}));
        assert_eq!(handle.state.lock().task.title, title.chars().take(200).collect::<String>());
    }
    mgr.rename(&task.id, "  My task  ").unwrap();
    let copy = mgr.fork(&task.id, None).await.unwrap();
    let copied = mgr.task(&copy.id).unwrap();
    copied.on_update(None, &json!({"sessionUpdate": "session_info_update", "title": "Copied agent title"}));
    assert_eq!(copied.state.lock().task.title, "My task");
    mgr.shutdown();
    let restored = manager(tmp.path(), agent);
    let handle = restored.task(&task.id).unwrap();
    handle.on_update(None, &json!({"sessionUpdate": "session_info_update", "title": "Resumed title"}));
    assert_eq!(handle.state.lock().task.title, "My task");
    restored.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn forks_rollbacks_and_steering() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let new = |prompt: &str| NewAgentTask {
        project_root: None,
        prompt: text(prompt),
        provider: "claude".into(),
        config: Vec::new(),
        isolation: Isolation::Local,
        base: None,
    };
    let task = mgr.create(new("again")).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    mgr.prompt(&task.id, text("again"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let caps = mgr.task(&task.id).unwrap().state.lock().task.capabilities;
    assert!(caps.fork && caps.rollback && caps.steer);

    // A copy from after the first turn: the new task drops the second once it loads.
    let copy = mgr.fork(&task.id, Some(1)).await.unwrap();
    assert_eq!(turn_starts(&mgr.entries(&copy.id, None).unwrap()).len(), 1);
    assert_eq!(mgr.task(&copy.id).unwrap().state.lock().pending_rollback, 1);
    mgr.prompt(&copy.id, text("again"), false).await.unwrap();
    wait_for(&mgr, &copy.id, AgentStatus::Ready).await;
    {
        let calls = agent.calls.lock();
        let load = calls.iter().rposition(|c| c == "session/load").unwrap();
        assert!(calls[load..].iter().any(|c| c == "_openidea/rollback 1"));
    }

    // Undoing the last turn hands its message back.
    let undone = mgr.rollback(&task.id, 1).await.unwrap().unwrap();
    assert_eq!(undone.text, "again");
    assert_eq!(turn_starts(&mgr.entries(&task.id, None).unwrap()).len(), 1);
    assert!(agent.calls.lock().iter().any(|c| c == "_openidea/rollback 1"));

    // A message sent now while the agent works joins the turn.
    mgr.prompt(&task.id, text("wait"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Running).await;
    mgr.prompt(&task.id, text("also this"), true).await.unwrap();
    assert!(agent.calls.lock().iter().any(|c| c == "_openidea/steer \"also this\""));
    let entries = mgr.entries(&task.id, None).unwrap();
    assert!(matches!(entries.last(), Some(AgentEntry::User { steered: true, .. })));
    assert!(mgr.task(&task.id).unwrap().state.lock().task.queue.is_empty());
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;

    // Dropping every turn starts a fresh session instead of rewinding the agent's history.
    let handle = mgr.task(&task.id).unwrap();
    for (parent, child) in [(None, "child"), (Some("child"), "grandchild")] {
        handle.on_update(
            parent,
            &json!({"sessionUpdate": "subagent_update", "sessionId": child,
            "state": {"state": "idle", "stopReason": "end_turn"}}),
        );
    }
    handle.state.lock().conversation.main.entries.insert(0, AgentEntry::Agent { text: "Welcome".into() });
    let rewinds = agent.calls.lock().iter().filter(|c| c.starts_with("_openidea/rollback")).count();
    let first = mgr.rollback(&task.id, 0).await.unwrap().unwrap();
    assert_eq!(first.text, "again");
    assert!(mgr.entries(&task.id, None).unwrap().is_empty());
    assert!(mgr.task(&task.id).unwrap().state.lock().session_id.is_none());
    assert!(handle.state.lock().conversation.saved_subagents().is_empty());
    assert!(handle.state.lock().task.usage.is_none());
    assert_eq!(agent.calls.lock().iter().filter(|c| c.starts_with("_openidea/rollback")).count(), rewinds);
    mgr.shutdown();
    let restored = manager(tmp.path(), agent.clone());
    assert!(restored.entries(&task.id, None).unwrap().is_empty());
    restored.prompt(&task.id, first, false).await.unwrap();
    wait_for(&restored, &task.id, AgentStatus::Ready).await;
    assert_eq!(turn_starts(&restored.entries(&task.id, None).unwrap()).len(), 1);
    assert_eq!(agent.calls.lock().last().unwrap(), "session/prompt");
    restored.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_limits_and_late_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("limit"),
            provider: "claude".into(),
            // `effort` isn't offered until the session runs.
            config: vec![AgentConfigChoice { id: "effort".into(), value: "high".into() }],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Limited).await;
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.resets_ms, Some(1234.0));

    mgr.prompt(&task.id, text("late option"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    for _ in 0..100 {
        if agent.calls.lock().iter().any(|c| c == "session/set_config_option \"high\"") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(agent.calls.lock().iter().any(|c| c == "session/set_config_option \"high\""));
    let config = mgr.task(&task.id).unwrap().state.lock().task.config.clone();
    assert_eq!(config.iter().find(|o| o.id == "effort").unwrap().current.as_deref(), Some("high"));
    for _ in 0..100 {
        if mgr
            .shared
            .known
            .lock()
            .get("claude")
            .and_then(|k| k.thought_levels.get("big"))
            .and_then(|levels| levels.first())
            .and_then(|o| o.current.as_deref())
            == Some("high")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(mgr.shared.known.lock()["claude"].thought_levels["big"][0].current.as_deref(), Some("high"));
}

#[tokio::test(flavor = "multi_thread")]
async fn remembered_settings_drop_per_model_choices_for_the_next_task() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    // The effort list depends on the model: what the last session ran means nothing once
    // the user picks another model, so provider-wide defaults never include it.
    *agent.extra_options.lock() = vec![json!({"id": "effort", "category": "thought_level",
        "type": "select", "currentValue": "high",
        "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]})];
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("again"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;

    let provider = mgr.providers().into_iter().find(|p| p.id == "claude").unwrap();
    assert!(provider.config.iter().all(|o| o.id != "effort"), "a per-model option isn't offered stale");
    let model = provider.config.iter().find(|o| o.id == "model").unwrap();
    assert_eq!(model.current.as_deref(), Some("big"), "the model choice survives");
}

fn effort_options(levels: &[&str], current: &str) -> Vec<Value> {
    vec![json!({"id": "effort", "category": "thought_level", "type": "select", "currentValue": current,
        "options": levels.iter().map(|v| json!({"value": v, "name": v})).collect::<Vec<_>>()})]
}

#[tokio::test(flavor = "multi_thread")]
async fn thinking_levels_are_remembered_per_provider_and_model() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    *agent.model_options.lock() = HashMap::from([
        ("big".into(), effort_options(&["low", "high"], "high")),
        ("small".into(), effort_options(&["minimal", "medium"], "minimal")),
        ("plain".into(), vec![]),
    ]);
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("again"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    mgr.set_config(&task.id, "model", "small".into()).await.unwrap();
    mgr.set_config(&task.id, "effort", "medium".into()).await.unwrap();
    mgr.set_config(&task.id, "model", "plain".into()).await.unwrap();
    let p = mgr.providers().into_iter().find(|p| p.id == "claude").unwrap();
    let big = &p.thought_levels["big"][0];
    assert_eq!(big.current.as_deref(), Some("high"));
    assert_eq!(big.values.iter().map(|v| v.value.as_str()).collect::<Vec<_>>(), ["low", "high"]);
    let small = &p.thought_levels["small"][0];
    assert_eq!(small.current.as_deref(), Some("medium"));
    assert_eq!(small.values.iter().map(|v| v.value.as_str()).collect::<Vec<_>>(), ["minimal", "medium"]);
    assert!(p.thought_levels["plain"].is_empty());
    assert!(!p.thought_levels.contains_key("unknown"));
    assert!(mgr.providers().iter().find(|p| p.id == "codex").unwrap().thought_levels.is_empty());
    let saved: HashMap<String, Known> =
        serde_json::from_slice(&std::fs::read(&mgr.shared.paths.models_file).unwrap()).unwrap();
    assert_eq!(saved["claude"].thought_levels, p.thought_levels);
    mgr.shutdown();
    let restored = manager(tmp.path(), agent);
    assert_eq!(restored.providers().into_iter().find(|p| p.id == "claude").unwrap().thought_levels, p.thought_levels);
    restored.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn upfront_effort_is_validated_after_changing_model_before_the_prompt() {
    for (effort, applied) in [("medium", true), ("high", false)] {
        let tmp = tempfile::tempdir().unwrap();
        let agent = Arc::new(FakeAgent::default());
        *agent.model_options.lock() = HashMap::from([
            ("big".into(), effort_options(&["low", "high"], "low")),
            ("small".into(), effort_options(&["minimal", "medium"], "minimal")),
        ]);
        let mgr = manager(tmp.path(), agent.clone());
        let task = mgr
            .create(NewAgentTask {
                project_root: None,
                prompt: text("again"),
                provider: "claude".into(),
                // Reversed on purpose: model must be set before validating effort.
                config: vec![
                    AgentConfigChoice { id: "effort".into(), value: effort.into() },
                    AgentConfigChoice { id: "model".into(), value: "small".into() },
                ],
                isolation: Isolation::Local,
                base: None,
            })
            .await
            .unwrap();
        wait_for(&mgr, &task.id, AgentStatus::Ready).await;
        let calls = agent.calls.lock();
        let model = calls.iter().position(|c| c == "session/set_config_option \"small\"").unwrap();
        let effort_call = calls.iter().position(|c| c == &format!("session/set_config_option \"{effort}\""));
        assert_eq!(effort_call.is_some(), applied);
        if let Some(effort_call) = effort_call {
            let prompt = calls.iter().position(|c| c == "session/prompt").unwrap();
            assert!(model < effort_call && effort_call < prompt);
        }
        drop(calls);
        mgr.shutdown();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn unreported_model_switch_does_not_cache_the_previous_models_levels() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    *agent.extra_options.lock() = effort_options(&["low", "high"], "high");
    let mgr = manager(tmp.path(), agent);
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("again"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    mgr.set_config(&task.id, "model", "small".into()).await.unwrap();
    let p = mgr.providers().into_iter().find(|p| p.id == "claude").unwrap();
    assert!(!p.thought_levels.contains_key("small"));
    assert_eq!(p.thought_levels["big"][0].current.as_deref(), Some("high"));
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn cached_effort_is_not_sent_without_real_session_options() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    *agent.extra_options.lock() = effort_options(&["low", "high"], "low");
    let mgr = manager(tmp.path(), agent.clone());
    let new = |config| NewAgentTask {
        project_root: None,
        prompt: text("again"),
        provider: "claude".into(),
        config,
        isolation: Isolation::Local,
        base: None,
    };
    let warm = mgr.create(new(vec![])).await.unwrap();
    wait_for(&mgr, &warm.id, AgentStatus::Ready).await;
    agent.calls.lock().clear();
    agent.empty_config.store(true, Ordering::Release);
    let task = mgr
        .create(new(vec![
            AgentConfigChoice { id: "model".into(), value: "big".into() },
            AgentConfigChoice { id: "effort".into(), value: "high".into() },
        ]))
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(!agent.calls.lock().iter().any(|c| c == "session/set_config_option \"high\""));
    assert!(
        mgr.task(&task.id).unwrap().state.lock().task.config.iter().any(|o| o.id == "effort"),
        "remembered session settings remain visible until the agent refreshes them"
    );
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn reported_levels_refresh_even_without_a_model_option() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    *agent.extra_options.lock() = effort_options(&["low", "high"], "high");
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("again"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    for levels in [effort_options(&["minimal", "medium"], "medium"), vec![]] {
        agent.update("s1", json!({"sessionUpdate": "config_option_update", "configOptions": levels}));
        let expected = config::parse_options(&json!(levels));
        for _ in 0..100 {
            if mgr.shared.known.lock()["claude"].thought_levels["big"] == expected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(mgr.shared.known.lock()["claude"].thought_levels["big"], expected);
    }
    mgr.shutdown();
}

#[test]
fn retry_updates_become_a_countdown() {
    let update =
        json!({"sessionUpdate": RETRY_UPDATE, "attempt": 2, "maxRetries": 10, "retryDelayMs": 1500, "error": ""});
    assert_eq!(
        retry_of(&update, 1000.0),
        Some(AgentRetry { attempt: 2, max_retries: Some(10), retry_at_ms: 2500.0, error: None })
    );
    assert_eq!(retry_of(&json!({"sessionUpdate": RETRY_UPDATE}), 0.0), None, "no attempt");
}

#[test]
fn usage_limits_and_cost_skip_what_is_malformed() {
    let limits = config::limits_of(&json!({"sessionUpdate": LIMITS_UPDATE, "limits": [
        {"window": "seven_day", "usedPercent": 140.0},
        {"window": "", "usedPercent": 10.0},
        {"window": "five_hour"},
    ]}));
    assert_eq!(limits, [AgentLimit { window: "seven_day".into(), used_percent: 100.0, resets_ms: None }]);
    let usage = config::usage_of(&json!({"used": 1, "size": 2, "cost": {"amount": -1.0, "currency": "USD"}}));
    assert_eq!(usage.map(|u| u.cost), Some(None), "a negative cost is dropped, the context use kept");
}

#[tokio::test(flavor = "multi_thread")]
async fn cursor_approval_switch_resolves_pending_and_survives_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let new = || NewAgentTask {
        project_root: None,
        prompt: text("Fix"),
        provider: "cursor".into(),
        config: Vec::new(),
        isolation: Isolation::Local,
        base: None,
    };
    let task = mgr.create(new()).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    mgr.set_config(&task.id, config::CURSOR_APPROVAL, "bypass".into()).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(
        mgr.entries(&task.id, None)
            .unwrap()
            .iter()
            .any(|e| matches!(e, AgentEntry::Permission { chosen: Some(name), .. } if name == "Allow"))
    );
    // Agent config updates must not erase the client's approval setting.
    mgr.prompt(&task.id, text("late option"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let t = mgr.task(&task.id).unwrap();
    assert!(config::bypass_approvals(&t.state.lock().task.config));
    t.kill();
    mgr.prompt(&task.id, text("Fix again"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(!agent.calls.lock().iter().any(|c| c.contains("bypass")));
    assert!(config::bypass_approvals(&mgr.shared.known_config("cursor")));
    mgr.set_config(&task.id, config::CURSOR_APPROVAL, "ask".into()).await.unwrap();
    mgr.prompt(&task.id, text("Fix once more"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    // A task created without choosing approvals still asks; the New Task page sends the default.
    let other = mgr.create(new()).await.unwrap();
    wait_for(&mgr, &other.id, AgentStatus::NeedsInput).await;
    mgr.cancel(&other.id, None).unwrap();
    wait_for(&mgr, &other.id, AgentStatus::Ready).await;
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn bypass_approvals_keeps_both_question_dialects_pending_but_allows_permissions() {
    for prompt in ["ask", "qwen ask"] {
        for bypass_at_start in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let mgr = manager(tmp.path(), Arc::new(FakeAgent::default()));
            // Cursor's client-side approval policy applies independently of the question dialect.
            let task = mgr
                .create(NewAgentTask {
                    project_root: None,
                    prompt: text(prompt),
                    provider: "cursor".into(),
                    config: if bypass_at_start {
                        vec![AgentConfigChoice { id: config::CURSOR_APPROVAL.into(), value: "bypass".into() }]
                    } else {
                        vec![]
                    },
                    isolation: Isolation::Local,
                    base: None,
                })
                .await
                .unwrap();
            wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
            let id = mgr
                .entries(&task.id, None)
                .unwrap()
                .iter()
                .find_map(|entry| match entry {
                    AgentEntry::Permission { id, questions, chosen: None, .. } if questions.len() == 2 => Some(*id),
                    _ => None,
                })
                .unwrap();
            mgr.set_config(&task.id, config::CURSOR_APPROVAL, "bypass".into()).await.unwrap();
            assert!(mgr.task(&task.id).unwrap().permissions.lock().contains_key(&id), "{prompt}, {bypass_at_start}");
            assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.status, AgentStatus::NeedsInput);
            let reply = if prompt == "ask" {
                json!({"Which layout?": ["Grid"], "Which checks?": ["Disk"]})
            } else {
                json!({"Which database?": ["Postgres"], "Which caches?": ["Memory"]})
            };
            mgr.respond(&task.id, id, Some(reply.to_string())).unwrap();
            wait_for(&mgr, &task.id, AgentStatus::Ready).await;

            mgr.prompt(&task.id, text("Fix"), false).await.unwrap();
            wait_for(&mgr, &task.id, AgentStatus::Ready).await;
            let entries = mgr.entries(&task.id, None).unwrap();
            assert!(
                entries.iter().any(|entry| matches!(entry,
                    AgentEntry::Permission { questions, chosen: Some(name), .. }
                    if questions.is_empty() && name == "Allow")),
                "{entries:?}"
            );
            assert!(entries.iter().any(|entry| matches!(entry, AgentEntry::Agent { text } if text == "chose yes")));
            mgr.shutdown();
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cursor_approval_choice_applies_before_first_prompt() {
    let tmp = tempfile::tempdir().unwrap();
    let mgr = manager(tmp.path(), Arc::new(FakeAgent::default()));
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("Fix"),
            provider: "cursor".into(),
            config: vec![AgentConfigChoice { id: config::CURSOR_APPROVAL.into(), value: "bypass".into() }],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_access_mode_approves_tool_requests() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    *agent.extra_options.lock() = vec![json!({
        "id": "mode", "category": "mode", "type": "select", "currentValue": "ask",
        "options": [{"value": "ask", "name": "Ask"}, {"value": "full-access", "name": "Full Access"}]
    })];
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("Fix"),
            provider: "claude".into(),
            config: vec![AgentConfigChoice { id: "mode".into(), value: "full-access".into() }],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(agent.calls.lock().iter().any(|c| c.ends_with("\"full-access\"")));
    assert!(
        mgr.entries(&task.id, None)
            .unwrap()
            .iter()
            .any(|entry| matches!(entry, AgentEntry::Permission { chosen: Some(name), .. } if name == "Allow"))
    );

    // Choosing Full Access while the request is already waiting also approves it.
    let waiting = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("Fix"),
            provider: "claude".into(),
            config: Vec::new(),
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &waiting.id, AgentStatus::NeedsInput).await;
    mgr.set_config(&waiting.id, "mode", "full-access".into()).await.unwrap();
    wait_for(&mgr, &waiting.id, AgentStatus::Ready).await;
    assert!(
        mgr.entries(&waiting.id, None)
            .unwrap()
            .iter()
            .any(|entry| matches!(entry, AgentEntry::Permission { chosen: Some(name), .. } if name == "Allow"))
    );
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_late_full_access_option_approves_a_pending_request() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent { hold_late_mode: true, ..Default::default() });
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("late full access"),
            provider: "claude".into(),
            config: vec![AgentConfigChoice { id: "mode".into(), value: "full-access".into() }],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let task = mgr.task(&task.id).unwrap();
        let (status, busy) = {
            let s = task.state.lock();
            (s.task.status, s.busy)
        };
        if status == AgentStatus::Ready && !busy {
            break;
        }
        if std::time::Instant::now() > deadline {
            let _ = mgr.cancel(&task.id, None);
            mgr.shutdown();
            panic!("late Full Access did not approve the pending request");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(agent.calls.lock().iter().any(|c| c.ends_with("\"full-access\"")));
    assert!(
        mgr.entries(&task.id, None)
            .unwrap()
            .iter()
            .any(|entry| matches!(entry, AgentEntry::Permission { chosen: Some(name), .. } if name == "Allow"))
    );
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_allow_all_permissions_option_approves_tool_requests() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    *agent.extra_options.lock() = vec![json!({
        "id": "allow_all", "name": "Allow All", "category": "permissions", "type": "select", "currentValue": "off",
        "options": [{"value": "off", "name": "Ask"}, {"value": "on", "name": "Full Access"}]
    })];
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("Fix"),
            provider: "claude".into(),
            config: vec![AgentConfigChoice { id: "allow_all".into(), value: "on".into() }],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(agent.calls.lock().iter().any(|c| c.ends_with("\"on\"")));
    assert!(
        mgr.entries(&task.id, None)
            .unwrap()
            .iter()
            .any(|entry| matches!(entry, AgentEntry::Permission { chosen: Some(name), .. } if name == "Allow"))
    );
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn archived_tasks_can_be_restored_and_continue_their_session() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("again"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let entries = mgr.entries(&task.id, None).unwrap();
    mgr.archive(&task.id).unwrap();
    assert!(mgr.prompt(&task.id, text("again"), false).await.is_err());
    mgr.unarchive(&task.id).unwrap();
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.status, AgentStatus::Ready);
    assert!(mgr.task(&task.id).unwrap().live.lock().is_none());
    assert_eq!(mgr.entries(&task.id, None).unwrap().len(), entries.len());
    drop(mgr);
    let mgr = manager(tmp.path(), agent.clone());
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.status, AgentStatus::Ready);
    mgr.prompt(&task.id, text("again"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(agent.calls.lock().iter().any(|call| call == "session/load"));
    assert_eq!(mgr.entries(&task.id, None).unwrap().len(), entries.len() + 2);
    mgr.unarchive(&task.id).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn task_project_root_controls_local_and_worktree_repositories() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    let member = root.join("project-b");
    std::fs::create_dir(&member).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(&member)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    };
    git(&["init", "-q", "-b", "member-main"]);
    git(&["config", "core.autocrlf", "false"]);
    std::fs::write(member.join("file.txt"), "original\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "initial"]);
    let mgr = manager(&root, Arc::new(FakeAgent::default()));
    for isolation in [Isolation::Local, Isolation::Worktree] {
        let task = mgr
            .create(NewAgentTask {
                project_root: Some(IpcPath(member.clone())),
                prompt: text("member task"),
                provider: "claude".into(),
                config: vec![],
                isolation,
                base: None,
            })
            .await
            .unwrap();
        wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
        let permission = mgr
            .entries(&task.id, None)
            .unwrap()
            .iter()
            .find_map(|e| match e {
                AgentEntry::Permission { id, .. } => Some(*id),
                _ => None,
            })
            .unwrap();
        mgr.respond(&task.id, permission, Some("yes".into())).unwrap();
        wait_for(&mgr, &task.id, AgentStatus::Ready).await;
        assert_eq!(task.project_root, Some(IpcPath(member.clone())));
        assert_eq!(task.base.as_deref(), Some("member-main"));
        if isolation == Isolation::Local {
            assert_eq!(task.cwd.0, member);
        } else {
            assert_ne!(task.cwd.0, member);
            assert_eq!(std::fs::read_to_string(task.cwd.0.join("file.txt")).unwrap(), "original\n");
        }
        std::fs::write(task.cwd.0.join("file.txt"), "changed\n").unwrap();
        let changes = mgr.changes(&task.id).await.unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path.0, task.cwd.0.join("file.txt"));
        assert_eq!(mgr.base_text(&task.id, changes[0].path.0.clone()).await.unwrap().as_deref(), Some("original\n"));
        let saved = std::fs::read(root.join("store").join(format!("{}.json", task.id))).unwrap();
        assert!(String::from_utf8(saved).unwrap().contains("projectRoot"));
        let mut old = serde_json::to_value(&task).unwrap();
        old.as_object_mut().unwrap().remove("projectRoot");
        assert!(serde_json::from_value::<AgentTask>(old).unwrap().project_root.is_none());
        mgr.delete(&task.id, true).await.unwrap();
        if isolation == Isolation::Worktree {
            assert!(!task.cwd.0.exists());
        }
        std::fs::write(member.join("file.txt"), "original\n").unwrap();
    }
    assert_eq!(git(&["worktree", "list", "--porcelain"]).matches("worktree ").count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn reload_providers_updates_registry_install_clears_stale_probes_and_notifies_subscribers() {
    let tmp = tempfile::tempdir().unwrap();
    let agents_dir = tmp.path().join("agents");
    std::fs::create_dir_all(&agents_dir).unwrap();
    let fake_bin = tmp.path().join(if cfg!(windows) { "copilot.cmd" } else { "copilot" });
    std::fs::write(&fake_bin, "").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let agent = Arc::new(FakeAgent::default());
    let connector: Connector = {
        let agent = agent.clone();
        Arc::new(move |_spec, _cwd, client, _stderr| {
            let (a, b) = duplex(1 << 20);
            let (ar, aw) = tokio::io::split(a);
            let (br, bw) = tokio::io::split(b);
            let server = Peer::connect_framed(br, bw, agent.clone(), Framing::Lines);
            agent.servers.lock().push(server);
            Ok(Peer::connect_framed(ar, aw, client, Framing::Lines))
        })
    };
    let mgr = AgentManager::with_connector(
        AgentPaths {
            project_root: tmp.path().to_path_buf(),
            store_dir: tmp.path().join("store"),
            worktrees_dir: tmp.path().join("worktrees"),
            models_file: tmp.path().join("models.json"),
            custom_agents_dir: Some(agents_dir.clone()),
            home_dir: None,
        },
        tokio::runtime::Handle::current(),
        connector,
    );

    // Seed a stale failed probe for copilot before installing its custom TOML.
    mgr.shared.probes.lock().insert(
        "copilot".into(),
        AgentProbe {
            provider: "copilot".into(),
            name: None,
            version: None,
            protocol: "ACP".into(),
            capabilities: AgentCapabilities::default(),
            auth_methods: Vec::new(),
            error: Some("copilot --acp was not found on PATH.".into()),
        },
    );

    let events = Arc::new(Mutex::new(Vec::new()));
    let events_sink = events.clone();
    mgr.subscribe(Arc::new(move |ev| events_sink.lock().push(ev)));

    let toml = format!(
        "name = \"GitHub Copilot\"\ncommand = {:?}\nargs = [\"--acp\", \"--stdio\"]\n",
        fake_bin.to_string_lossy()
    );
    std::fs::write(agents_dir.join("copilot.toml"), toml).unwrap();

    mgr.reload_providers();

    assert!(events.lock().iter().any(|ev| matches!(ev, AgentEvent::Providers)));
    assert!(!mgr.shared.probes.lock().contains_key("copilot"));

    let copilot = mgr.providers().into_iter().find(|p| p.id == "copilot").unwrap();
    assert!(copilot.installed);
    assert!(copilot.command.contains(&*fake_bin.to_string_lossy()));

    let probe = mgr.probe("copilot", false).await.unwrap();
    assert!(probe.error.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_agents_stop_and_resume_their_session_on_the_next_message() {
    let new = || NewAgentTask {
        project_root: None,
        prompt: text("again"),
        provider: "claude".into(),
        config: Vec::new(),
        isolation: Isolation::Local,
        base: None,
    };
    let live =
        |mgr: &AgentManager, id: &str| mgr.task(id).unwrap().live.lock().as_ref().is_some_and(|l| !l.peer.is_closed());

    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    mgr.set_idle_release(Duration::from_millis(200));
    let task = mgr.create(new()).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(live(&mgr, &task.id));
    // The process is stopped once the task stays idle…
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(!live(&mgr, &task.id));
    assert!(agent.servers.lock()[0].is_closed(), "its connection is closed");
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.status, AgentStatus::Ready, "not an error");
    // …and the next message starts it again on the same session.
    mgr.prompt(&task.id, text("again"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(agent.calls.lock().contains(&"session/load".to_owned()));
    assert_eq!(
        mgr.entries(&task.id, None).unwrap().iter().filter(|e| matches!(e, AgentEntry::Agent { .. })).count(),
        2
    );

    // A new turn before the delay ran out keeps the agent.
    mgr.prompt(&task.id, text("again"), false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(live(&mgr, &task.id));
    mgr.shutdown();

    // An agent that can't reload its session keeps running: stopping it would lose the conversation.
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent { no_load: true, ..FakeAgent::default() });
    let mgr = manager(tmp.path(), agent.clone());
    mgr.set_idle_release(Duration::from_millis(200));
    let task = mgr.create(new()).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(live(&mgr, &task.id));
    mgr.shutdown();
}

/// A turn's background tasks outlive it: an idle agent stops only once its last one is
/// done, and the usual delay runs from that report.
#[tokio::test(flavor = "multi_thread")]
async fn an_idle_agent_waits_for_its_background_tasks_before_it_stops() {
    let live =
        |mgr: &AgentManager, id: &str| mgr.task(id).unwrap().live.lock().as_ref().is_some_and(|l| !l.peer.is_closed());
    let new = || NewAgentTask {
        project_root: None,
        prompt: text("background"),
        provider: "claude".into(),
        config: Vec::new(),
        isolation: Isolation::Local,
        base: None,
    };

    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    mgr.set_idle_release(Duration::from_millis(200));
    let task = mgr.create(new()).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    // The task runs long past the idle delay: the agent stays up for it.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(live(&mgr, &task.id));
    // It is done: the delay starts over from this report, then the agent stops.
    agent.update("s1", json!({"sessionUpdate": BACKGROUND_TASKS_UPDATE, "tasks": []}));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(live(&mgr, &task.id), "the delay runs from when the last task is done");
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(!live(&mgr, &task.id));
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.status, AgentStatus::Ready, "not an error");
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_task_shows_what_runs_in_the_background() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("background"),
            provider: "claude".into(),
            config: Vec::new(),
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let shown = || mgr.task(&task.id).unwrap().state.lock().task.background.clone();
    let first = shown();
    assert_eq!(first.len(), 1);
    assert_eq!(
        (first[0].id.as_str(), first[0].kind.as_str(), first[0].description.as_str()),
        ("bsh1", "local_bash", "sleep 900")
    );

    agent.update(
        "s1",
        json!({"sessionUpdate": BACKGROUND_TASKS_UPDATE, "tasks": [
            {"task_id": "bsh1", "task_type": "local_bash", "description": "sleep 900"},
            {"task_id": "mon1", "task_type": "monitor", "description": "Watch the deploy"},
        ]}),
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while shown().len() < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(shown()[0].started_ms, first[0].started_ms, "a task keeps when it was first seen");

    agent.update("s1", json!({"sessionUpdate": BACKGROUND_TASKS_UPDATE, "tasks": []}));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !shown().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_background_task_is_stopped_on_its_own() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("again"),
            provider: "claude".into(),
            config: Vec::new(),
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    mgr.stop_background(&task.id, "b1").await.unwrap();
    assert!(agent.calls.lock().contains(&"_openidea/stop_task \"b1\"".to_owned()));
    mgr.shutdown();
}

/// Deleting a task whose agent still runs in the worktree removes both and leaves no
/// process behind, whether it is waiting for permission or idle without session/load.
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_task_waits_for_its_agent_to_exit_before_removing_the_worktree() {
    for no_load in [false, true] {
        delete_running_agent(no_load).await;
    }
}

async fn delete_running_agent(no_load: bool) {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "core.autocrlf", "false"]);
    std::fs::write(root.join("file.txt"), "original\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "initial"]);

    let agent = Arc::new(FakeAgent { no_load, ..FakeAgent::default() });
    let pids: Arc<Mutex<Vec<u32>>> = Arc::default();
    let (fake, started) = (agent.clone(), pids.clone());
    // The fake agent, served on behalf of a real process that exits only when killed.
    let connector: Connector = Arc::new(move |_spec, cwd, client, _stderr| {
        #[cfg(unix)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("sleep");
            cmd.arg("30");
            cmd
        };
        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.args(["/D", "/C", "echo ready>agent-ready & ping -n 30 127.0.0.1 >nul"]);
            cmd
        };
        ide_core::process::prepare(cmd.as_std_mut());
        ide_core::process::own_group(cmd.as_std_mut());
        cmd.current_dir(cwd).kill_on_drop(true);
        let child = cmd.spawn()?;
        started.lock().push(child.id().unwrap());
        let (a, b) = duplex(1 << 20);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        // `connect_with_child` frames with Content-Length.
        fake.servers.lock().push(Peer::connect(br, bw, fake.clone()));
        Ok(Peer::connect_with_child(ar, aw, client, child))
    });
    let mgr = AgentManager::with_connector(
        AgentPaths {
            project_root: root.clone(),
            store_dir: root.join("store"),
            worktrees_dir: root.join("worktrees"),
            models_file: root.join("models.json"),
            custom_agents_dir: None,
            home_dir: None,
        },
        tokio::runtime::Handle::current(),
        connector,
    );
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text(if no_load { "again" } else { "Fix the lexer" }),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Worktree,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, if no_load { AgentStatus::Ready } else { AgentStatus::NeedsInput }).await;
    let pid = *pids.lock().last().expect("the agent was started");

    #[cfg(windows)]
    {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !task.cwd.0.join("agent-ready").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            std::fs::rename(&task.cwd.0, task.cwd.0.with_extension("moved")).unwrap_err().raw_os_error(),
            Some(32),
            "the running agent really locks its worktree"
        );
    }

    mgr.delete(&task.id, true).await.unwrap();
    assert!(!task.cwd.0.exists());
    // Killed and reaped: not even a zombie is left.
    #[cfg(unix)]
    let alive = std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().unwrap().success();
    #[cfg(windows)]
    let alive = {
        let mut cmd = std::process::Command::new("tasklist");
        ide_core::process::prepare(&mut cmd).args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
        String::from_utf8_lossy(&cmd.output().unwrap().stdout).contains(&format!("\"{pid}\""))
    };
    assert!(!alive, "the agent (pid {pid}) is still running");
}

#[test]
fn mcp_servers_follow_server_state_and_agent_capabilities() {
    let root = std::path::Path::new("/project");
    let exe = std::path::Path::new("/app/openidea");
    assert!(super::stdio_mcp_servers(None, true, root).is_empty());
    assert!(super::stdio_mcp_servers(Some(exe), false, root).is_empty());
    let servers = super::stdio_mcp_servers(Some(exe), true, root);
    assert_eq!(
        servers,
        vec![json!({"name":"OpenIDEA","command":"/app/openidea",
        "args":["--mcp-stdio","--project","/project"],"env":[]})]
    );
}
