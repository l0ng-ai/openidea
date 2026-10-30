//! A task against an ACP v2 agent that plays back a turn captured from `claude-agent-acp`.

use super::tests::{TURN, frames};
use crate::*;
use ide_jsonrpc::{Framing, Handler, Peer, codes};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const SESSION: &str = "28846a4c-c3e8-4a45-a3d0-c19f10d19d1a";

#[derive(Default)]
struct FakeV2Agent {
    peer: OnceLock<Peer>,
    calls: Mutex<Vec<(String, Value)>>,
}

impl FakeV2Agent {
    fn methods(&self) -> Vec<String> {
        self.calls.lock().iter().map(|(m, _)| m.clone()).collect()
    }

    fn result(id: i64) -> Value {
        frames(TURN, "in").into_iter().find(|m| m["id"] == id && m.get("result").is_some()).unwrap()["result"].clone()
    }

    fn update(&self, update: Value) {
        let peer = self.peer.get().unwrap();
        peer.notify("session/update", json!({ "sessionId": SESSION, "update": update })).unwrap();
    }
}

impl Handler for FakeV2Agent {
    fn on_notification(&self, method: &str, params: Value) {
        self.calls.lock().push((method.to_owned(), params));
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        self.calls.lock().push((method.to_owned(), params.clone()));
        let peer = self.peer.get().unwrap().clone();
        match method {
            "initialize" => Ok(Self::result(1)),
            "session/new" => Ok(Self::result(2)),
            "session/set_config_option" => Ok(Self::result(3)),
            "session/resume" => {
                // The state snapshot v2 sends before answering.
                self.update(json!({ "sessionUpdate": "state_update", "state": "idle" }));
                Ok(json!({ "configOptions": Self::result(2)["configOptions"] }))
            }
            "session/prompt" if params.pointer("/prompt/0/text") == Some(&json!("again")) => {
                self.update(json!({ "sessionUpdate": "user_message", "messageId": "u2", "content": params["prompt"] }));
                std::thread::spawn(move || {
                    let update = |u: Value| peer.notify("session/update", json!({ "sessionId": SESSION, "update": u }));
                    update(json!({ "sessionUpdate": "state_update", "state": "running" })).unwrap();
                    update(json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m2",
                        "content": { "type": "text", "text": "second turn" } }))
                    .unwrap();
                    update(json!({ "sessionUpdate": "state_update", "state": "idle", "stopReason": "end_turn" }))
                        .unwrap();
                });
                Ok(json!({ "messageId": "u2" }))
            }
            "session/prompt" => {
                // The captured turn: its echo, the answer, then the rest on its own.
                let script = frames(TURN, "in");
                let answer = script.iter().position(|m| m["id"] == 4).unwrap();
                peer.notify("session/update", &script[answer - 1]["params"]).unwrap();
                let rest = script[answer + 1..].to_vec();
                std::thread::spawn(move || {
                    for m in rest {
                        match m["method"].as_str() {
                            Some("session/update") => peer.notify("session/update", &m["params"]).unwrap(),
                            Some(method) => {
                                let _: Value = tokio_block(peer.request(method, &m["params"], None)).unwrap();
                            }
                            None => {}
                        }
                    }
                });
                Ok(Self::result(4))
            }
            _ => Err((codes::METHOD_NOT_FOUND, method.to_owned())),
        }
    }
}

fn tokio_block<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

fn manager(dir: &Path, agent: Arc<FakeV2Agent>) -> AgentManager {
    let connector: Connector = Arc::new(move |_spec, _cwd, client, _stderr| {
        let (a, b) = tokio::io::duplex(1 << 20);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        let server = Peer::connect_framed(br, bw, agent.clone(), Framing::Lines);
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
            home_dir: None,
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

fn text(t: &str) -> AgentPrompt {
    AgentPrompt { text: t.into(), ..AgentPrompt::default() }
}

fn summary(entries: &[AgentEntry]) -> Vec<String> {
    entries
        .iter()
        .map(|e| match e {
            AgentEntry::User { text, .. } => format!("user: {}", text.lines().next().unwrap_or_default()),
            AgentEntry::Agent { text } => format!("agent: {text}"),
            AgentEntry::Tool { title, status, diffs, .. } => format!("{title} {status:?} {}", diffs.len()),
            AgentEntry::Permission { title, chosen, .. } => format!("{title}? {}", chosen.clone().unwrap_or_default()),
            other => format!("{other:?}"),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_runs_on_a_v2_agent_and_resumes_its_session() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeV2Agent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("Use the TodoWrite tool"),
            provider: "claude-acp".into(),
            config: vec![AgentConfigChoice { id: "model".into(), value: "haiku".into() }],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    // The turn is not over while the agent waits for an answer.
    assert!(mgr.task(&task.id).unwrap().state.lock().busy);
    let permission = mgr
        .entries(&task.id, None)
        .unwrap()
        .iter()
        .find_map(|e| match e {
            AgentEntry::Permission { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap();
    mgr.respond(&task.id, permission, Some("allow-once".into())).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;

    let entries = mgr.entries(&task.id, None).unwrap();
    assert_eq!(
        summary(&entries),
        [
            "user: Use the TodoWrite tool",
            "ToolSearch Completed 0",
            "echo hello; ls -la /work/proj/note.txt 2>&1 Failed 0",
            "Write /work/proj/note.txt Completed 1",
            "Write /work/proj/note.txt? Yes",
            "agent: done",
        ]
    );
    {
        let t = mgr.task(&task.id).unwrap().state.lock().task.clone();
        assert_eq!(t.model.as_deref(), Some("haiku"));
        assert_eq!(t.title, "Todo list and file creation test");
        assert!(t.usage.is_some());
        assert_eq!(t.commands.len(), 2, "{:?}", t.commands);
        let mode = t.config.iter().find(|o| o.id == "mode").unwrap();
        assert_eq!(mode.via, AgentConfigVia::Option, "v2 has no modes: the mode is a config option");
    }
    let set = agent.calls.lock().iter().find(|(m, _)| m == "session/set_config_option").unwrap().1.clone();
    assert_eq!((set["configId"].clone(), set["type"].clone()), (json!("model"), json!("id")));

    // Restarted: the session resumes without a replay, and a stale `idle` doesn't end the next turn.
    mgr.shutdown();
    let agent2 = Arc::new(FakeV2Agent::default());
    let mgr2 = manager(tmp.path(), agent2.clone());
    mgr2.prompt(&task.id, text("again"), false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    wait_for(&mgr2, &task.id, AgentStatus::Ready).await;
    let entries = mgr2.entries(&task.id, None).unwrap();
    assert_eq!(summary(&entries[6..]), ["user: again", "agent: second turn"]);
    let methods = agent2.methods();
    assert!(
        methods.contains(&"session/resume".to_owned()) && !methods.contains(&"session/load".to_owned()),
        "{methods:?}"
    );
    let resume = agent2.calls.lock().iter().find(|(m, _)| m == "session/resume").unwrap().1.clone();
    assert_eq!(resume["sessionId"], SESSION);
    assert!(resume.get("replayFrom").is_none());
}
