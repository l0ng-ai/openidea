//! End-to-end task flow against an in-memory ACP agent.

use super::*;
use std::sync::OnceLock;
use tokio::io::duplex;

/// Says "Hi", edits a file, asks to run a command and reports what it was allowed.
#[derive(Default)]
struct FakeAgent {
    peer: OnceLock<Peer>,
    calls: Mutex<Vec<String>>,
}

impl FakeAgent {
    fn update(&self, session: &str, update: Value) {
        let peer = self.peer.get().unwrap();
        peer.notify("session/update", json!({ "sessionId": session, "update": update })).unwrap();
    }

    fn say(&self, session: &str, text: &str) {
        self.update(
            session,
            json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}),
        );
    }
}

impl Handler for FakeAgent {
    fn on_notification(&self, method: &str, _: Value) {
        self.calls.lock().push(method.to_owned());
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        self.calls.lock().push(method.to_owned());
        let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("s1").to_owned();
        match method {
            "initialize" => Ok(json!({"protocolVersion": 1, "agentCapabilities": {"loadSession": true}})),
            "session/new" => Ok(json!({"sessionId": "s1",
                "modes": {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "code", "name": "Code"}]},
                "configOptions": [{"id": "model", "category": "model", "type": "select", "currentValue": "big",
                    "options": [{"value": "big", "name": "Big"}, {"value": "small", "name": "Small"}]}]})),
            "session/load" => {
                self.say(&session, "replayed history");
                Ok(json!({}))
            }
            "session/set_config_option" | "session/set_mode" => {
                self.calls.lock().push(format!("{method} {}", params.get("value").or(params.get("modeId")).unwrap()));
                Ok(json!({}))
            }
            "session/prompt" => {
                let text = params.pointer("/prompt/0/text").and_then(Value::as_str).unwrap_or_default().to_owned();
                if text == "again" {
                    self.say(&session, "second turn");
                    return Ok(json!({"stopReason": "end_turn"}));
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
                self.update(&session, json!({"sessionUpdate": "usage_update", "used": 50, "size": 1000}));
                self.say(&session, "Hi");
                self.update(
                    &session,
                    json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit a.rs",
                    "kind": "edit", "status": "completed",
                    "content": [{"type": "diff", "path": "/p/a.rs", "oldText": "a\n", "newText": "b\n"}]}),
                );
                let peer = self.peer.get().unwrap().clone();
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
    let connector: Connector = Arc::new(move |_spec, _cwd, client, _stderr| {
        let (a, b) = duplex(1 << 20);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        let server = Peer::connect_framed(br, bw, agent.clone(), Framing::Lines);
        // Keep the latest connection: a restarted manager connects again.
        let _ = agent.peer.set(server);
        Ok(Peer::connect_framed(ar, aw, client, Framing::Lines))
    });
    AgentManager::with_connector(
        AgentPaths {
            project_root: dir.to_path_buf(),
            store_dir: dir.join("store"),
            worktrees_dir: dir.join("worktrees"),
            models_file: dir.join("models.json"),
            custom_agents_dir: None,
        },
        tokio::runtime::Handle::current(),
        connector,
    )
}

async fn wait_for(mgr: &AgentManager, id: &str, status: AgentStatus) {
    for _ in 0..500 {
        if mgr.task(id).unwrap().state.lock().task.status == status {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("task never reached {status:?}");
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
        .entries(&task.id)
        .unwrap()
        .iter()
        .find_map(|e| match e {
            AgentEntry::Permission { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap();
    mgr.respond(&task.id, permission, Some("yes".into())).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;

    let entries = mgr.entries(&task.id).unwrap();
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
        let last_entry = events.iter().rev().find_map(|e| match e {
            AgentEvent::Entry { index, entry, .. } => Some((*index, entry.clone())),
            _ => None,
        });
        assert_eq!(last_entry, Some((4, AgentEntry::Agent { text: "chose yes".into() })));
    }
    let providers = mgr.providers();
    let claude = providers.iter().find(|p| p.id == "claude").unwrap();
    assert_eq!(claude.config.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["model", "mode"]);
    assert_eq!(claude.commands.len(), 1);

    // A new manager (IDE restart) finds the task and resumes its session without duplicating history.
    mgr.shutdown();
    let agent2 = Arc::new(FakeAgent::default());
    let mgr2 = manager(tmp.path(), agent2.clone());
    assert_eq!(mgr2.entries(&task.id).unwrap().len(), 5);
    assert_eq!(mgr2.providers().iter().find(|p| p.id == "claude").unwrap().config.len(), 2);
    mgr2.prompt(&task.id, text("again"), false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    wait_for(&mgr2, &task.id, AgentStatus::Ready).await;
    let entries = mgr2.entries(&task.id).unwrap();
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
        if mgr.entries(&task.id).unwrap().iter().any(|e| *e == AgentEntry::Agent { text: "second turn".into() }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let users: Vec<String> = mgr
        .entries(&task.id)
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
    mgr.cancel(&task.id).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let queued = mgr.task(&task.id).unwrap().state.lock().task.queue.clone();
    assert_eq!(queued.len(), 1);
    assert_eq!(mgr.unqueue(&task.id, &queued[0].id).unwrap().prompt.text, "later");
    assert!(mgr.task(&task.id).unwrap().state.lock().task.queue.is_empty());
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
async fn cancelling_resolves_the_open_permission_and_delete_forgets_the_task() {
    let tmp = tempfile::tempdir().unwrap();
    let mgr = manager(tmp.path(), Arc::new(FakeAgent::default()));
    let task = mgr
        .create(NewAgentTask {
            prompt: text("do it"),
            provider: "codex".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    mgr.cancel(&task.id).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let entries = mgr.entries(&task.id).unwrap();
    assert!(entries.iter().any(|e| matches!(e, AgentEntry::Permission { chosen: Some(c), .. } if c == "Cancelled")));
    assert_eq!(entries.last(), Some(&AgentEntry::Agent { text: "chose none".into() }));
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.model.as_deref(), Some("big"), "the agent's default");

    mgr.delete(&task.id, false).await.unwrap();
    assert!(mgr.entries(&task.id).is_err());
    assert!(!tmp.path().join("store").join(format!("{}.json", task.id)).exists());
    assert!(
        mgr.create(NewAgentTask {
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
        },
        tokio::runtime::Handle::current(),
    );
    let task = mgr
        .create(NewAgentTask {
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
                let pending = mgr.entries(&task.id).unwrap().into_iter().rev().find_map(|e| match e {
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
    for e in mgr.entries(&task.id).unwrap() {
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
