//! Shared scenarios, replayed from transcripts recorded with real agents.
//!
//! Record (spends a few cheap turns; the agent must be installed and signed in):
//! `OPENIDEA_RECORD=claude-acp@v2 cargo test -p ide-agent replay_tests::record -- --ignored`
//! writes `tests/fixtures/acp/<agent>[@<variant>]/<scenario>.jsonl`; the variant only
//! names the setup (`claude-acp@v1` ran with `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=0`). Every fixture found is replayed
//! by `recorded_scenarios`.

use super::*;
use crate::replay::{Report, recorder, replayer};

const SCENARIOS: [&str; 7] =
    ["simple", "multi_turn", "queued_turn", "turn_interrupt", "permission_allow", "permission_decline", "resume"];

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp")
}

fn paths(dir: &Path) -> AgentPaths {
    AgentPaths {
        project_root: dir.to_path_buf(),
        store_dir: dir.join("store"),
        worktrees_dir: dir.join("worktrees"),
        models_file: dir.join("models.json"),
        custom_agents_dir: None,
        home_dir: None,
    }
}

fn text(t: &str) -> AgentPrompt {
    AgentPrompt { text: t.into(), ..Default::default() }
}

/// Waits until the task settles (or asks for permission), up to `secs`.
async fn settle(mgr: &AgentManager, id: &str, secs: u64) -> AgentStatus {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let task = mgr.task(id).unwrap();
        let (s, busy) = {
            let st = task.state.lock();
            (st.task.status, st.busy)
        };
        if s == AgentStatus::NeedsInput || (!busy && s != AgentStatus::Starting && s != AgentStatus::Running) {
            return s;
        }
        assert!(std::time::Instant::now() < deadline, "task stuck in {s:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Settings every scenario of `provider` starts with (`<agent>/config.json`): a cheap model.
fn config(provider: &str) -> Vec<AgentConfigChoice> {
    let path = fixtures().join(provider.split('@').next().unwrap_or_default()).join("config.json");
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

async fn create(mgr: &AgentManager, provider: &str, prompt: &str) -> String {
    let req = NewAgentTask {
        project_root: None,
        prompt: text(prompt),
        provider: provider.into(),
        config: config(provider),
        isolation: Isolation::Local,
        base: None,
    };
    mgr.create(req).await.unwrap().id
}

fn permission(mgr: &AgentManager, id: &str) -> Option<(u32, Vec<AgentPermissionOption>)> {
    mgr.entries(id, None).unwrap().into_iter().rev().find_map(|e| match e {
        AgentEntry::Permission { id, options, chosen: None, .. } => Some((id, options)),
        _ => None,
    })
}

/// Answers permission requests with the first option of `kind` (`allow` / `reject`) until the task settles.
async fn answer_all(mgr: &AgentManager, id: &str, kind: &str, secs: u64) -> AgentStatus {
    loop {
        let s = settle(mgr, id, secs).await;
        if s != AgentStatus::NeedsInput {
            return s;
        }
        let (request, options) = permission(mgr, id).expect("a pending permission");
        let option = options.iter().find(|o| o.kind.starts_with(kind)).map(|o| o.id.clone());
        mgr.respond(id, request, option).unwrap();
    }
}

fn agent_text(mgr: &AgentManager, id: &str) -> String {
    mgr.entries(id, None)
        .unwrap()
        .into_iter()
        .filter_map(|e| match e {
            AgentEntry::Agent { text } => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn errors(mgr: &AgentManager, id: &str) -> Vec<String> {
    mgr.entries(id, None)
        .unwrap()
        .into_iter()
        .filter_map(|e| match e {
            AgentEntry::Error { message } => Some(message),
            _ => None,
        })
        .collect()
}

fn turns(mgr: &AgentManager, id: &str) -> usize {
    turn_starts(&mgr.entries(id, None).unwrap()).len()
}

/// Runs `scenario` on a fresh manager per agent connection, asserting what holds for any agent.
async fn run(scenario: &str, provider: &str, dir: &Path, connector: Connector, secs: u64) {
    let mgr = AgentManager::with_connector(paths(dir), tokio::runtime::Handle::current(), connector.clone());
    match scenario {
        "simple" => {
            let id = create(&mgr, provider, "Reply with just the word: pong").await;
            assert_eq!(answer_all(&mgr, &id, "reject", secs).await, AgentStatus::Ready);
            assert!(agent_text(&mgr, &id).to_lowercase().contains("pong"));
            assert!(errors(&mgr, &id).is_empty());
        }
        "multi_turn" => {
            let id = create(&mgr, provider, "Remember the number 7. Reply with just: OK").await;
            assert_eq!(answer_all(&mgr, &id, "reject", secs).await, AgentStatus::Ready);
            mgr.prompt(&id, text("Which number did I ask you to remember? Reply with just the number."), false)
                .await
                .unwrap();
            assert_eq!(answer_all(&mgr, &id, "reject", secs).await, AgentStatus::Ready);
            assert_eq!(turns(&mgr, &id), 2);
            assert!(agent_text(&mgr, &id).contains('7'));
        }
        "queued_turn" => {
            let id = create(&mgr, provider, "Reply with just the word: one").await;
            mgr.prompt(&id, text("Reply with just the word: two"), false).await.unwrap();
            assert_eq!(answer_all(&mgr, &id, "reject", secs).await, AgentStatus::Ready);
            assert_eq!(turns(&mgr, &id), 2);
            assert!(mgr.task(&id).unwrap().state.lock().task.queue.is_empty());
        }
        "turn_interrupt" => {
            let id = create(&mgr, provider, "Count from 1 to 300, one number per line, nothing else.").await;
            // Stopped before the agent has even started: the turn must still end, cleanly.
            mgr.cancel(&id, None).unwrap();
            assert_eq!(answer_all(&mgr, &id, "reject", secs).await, AgentStatus::Ready);
            assert!(errors(&mgr, &id).is_empty(), "{:?}", errors(&mgr, &id));
            assert!(!agent_text(&mgr, &id).contains("300"));
        }
        "permission_allow" | "permission_decline" => {
            let id =
                create(&mgr, provider, "Use your shell tool to run exactly this command: echo openidea-replay").await;
            let kind = if scenario == "permission_allow" { "allow" } else { "reject" };
            assert_eq!(answer_all(&mgr, &id, kind, secs).await, AgentStatus::Ready);
            let entries = mgr.entries(&id, None).unwrap();
            assert!(entries.iter().all(|e| !matches!(e, AgentEntry::Permission { chosen: None, .. })));
            assert!(entries.iter().any(|e| matches!(e, AgentEntry::Tool { .. })));
        }
        "resume" => {
            let id = create(&mgr, provider, "Remember the word: walnut. Reply with just: OK").await;
            assert_eq!(answer_all(&mgr, &id, "reject", secs).await, AgentStatus::Ready);
            mgr.shutdown();
            drop(mgr);
            // A restart: the session is loaded again, its history not duplicated.
            let mgr = AgentManager::with_connector(paths(dir), tokio::runtime::Handle::current(), connector);
            mgr.prompt(&id, text("Which word did I ask you to remember? Reply with just the word."), false)
                .await
                .unwrap();
            assert_eq!(answer_all(&mgr, &id, "reject", secs).await, AgentStatus::Ready);
            assert_eq!(turns(&mgr, &id), 2);
            assert!(agent_text(&mgr, &id).to_lowercase().contains("walnut"));
            mgr.shutdown();
            return;
        }
        other => panic!("unknown scenario {other}"),
    }
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_scenarios() {
    let mut ran = 0;
    for agent in std::fs::read_dir(fixtures()).into_iter().flatten().flatten() {
        // `<provider>[@<variant>]`: one agent recorded in several setups (ACP v1 and v2).
        let name = agent.file_name().to_string_lossy().into_owned();
        let provider = name.split('@').next().unwrap_or_default().to_owned();
        for scenario in SCENARIOS {
            let fixture = agent.path().join(format!("{scenario}.jsonl"));
            if !fixture.exists() {
                continue;
            }
            let tmp = tempfile::tempdir().unwrap();
            let (connector, report) = replayer(&fixture);
            run(scenario, &provider, tmp.path(), connector, 20).await;
            let provider = &name;
            let Report { problems, calls } = std::mem::take(&mut *report.lock());
            assert!(problems.is_empty(), "{provider}/{scenario}: {problems:?} (calls {calls:?})");
            if scenario == "resume" {
                assert!(
                    calls.iter().any(|c| c == "session/load" || c == "session/resume"),
                    "{provider}: resume didn't load the session"
                );
            }
            ran += 1;
        }
    }
    assert!(ran > 0, "no recorded fixtures under {}", fixtures().display());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "runs a real agent: OPENIDEA_RECORD=<provider id> [OPENIDEA_SCENARIO=<name>]"]
async fn record() {
    let name = std::env::var("OPENIDEA_RECORD").expect("OPENIDEA_RECORD=<provider id>[@<variant>]");
    let provider = name.split('@').next().unwrap_or_default().to_owned();
    let only = std::env::var("OPENIDEA_SCENARIO").ok();
    for scenario in SCENARIOS.iter().filter(|s| only.as_deref().is_none_or(|o| o == **s)) {
        let tmp = tempfile::tempdir().unwrap();
        let out = fixtures().join(&name).join(format!("{scenario}.jsonl"));
        let _ = std::fs::remove_file(&out);
        run(scenario, &provider, tmp.path(), recorder(out), 180).await;
    }
}
