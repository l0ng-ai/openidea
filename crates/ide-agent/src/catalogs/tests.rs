use super::*;
use crate::{AgentManager, AgentPaths, Connector};
use ide_jsonrpc::{Framing, Peer};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

const PROVIDER: &str = "catalog-test";

#[derive(Debug)]
struct Pending {
    launch: usize,
    method: String,
    params: Value,
    reply: oneshot::Sender<Result<Value, String>>,
    notifications: mpsc::UnboundedSender<Value>,
}

struct Harness {
    connector: Connector,
    pending: mpsc::UnboundedReceiver<Pending>,
    launches: Arc<AtomicUsize>,
    live: Arc<AtomicUsize>,
}

struct Live(Arc<AtomicUsize>);
impl Drop for Live {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Harness {
    fn new() -> Self {
        Self::with_initialize(json!({ "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [] }))
    }

    fn with_initialize(initialize: Value) -> Self {
        let (pending_tx, pending) = mpsc::unbounded_channel();
        let launches = Arc::new(AtomicUsize::new(0));
        let live = Arc::new(AtomicUsize::new(0));
        let connector: Connector = Arc::new({
            let launches = launches.clone();
            let live = live.clone();
            move |_, _, client, _| {
                let launch = launches.fetch_add(1, Ordering::SeqCst);
                live.fetch_add(1, Ordering::SeqCst);
                let guard = Live(live.clone());
                let pending = pending_tx.clone();
                let initialize = initialize.clone();
                let (notifications_tx, mut notifications) = mpsc::unbounded_channel::<Value>();
                let (client_io, server_io) = tokio::io::duplex(1 << 16);
                let (read, mut write) = tokio::io::split(server_io);
                tokio::spawn(async move {
                    let _guard = guard;
                    let mut lines = BufReader::new(read).lines();
                    loop {
                        let line = tokio::select! {
                            line = lines.next_line() => match line.unwrap() {
                                Some(line) => line,
                                None => break,
                            },
                            Some(notification) = notifications.recv() => {
                                if write.write_all(format!("{notification}\n").as_bytes()).await.is_err() {
                                    break;
                                }
                                continue;
                            }
                        };
                        let request: Value = serde_json::from_str(&line).unwrap();
                        let id = &request["id"];
                        if id.is_null() {
                            continue;
                        }
                        let response = match request["method"].as_str().unwrap() {
                            "initialize" => json!({ "id": id, "jsonrpc": "2.0", "result": initialize }),
                            "session/new"
                            | "session/set_config_option"
                            | "session/set_model"
                            | "session/load"
                            | "session/resume"
                            | "session/prompt"
                            | "session/set_mode" => {
                                let (reply, mut result) = oneshot::channel();
                                pending
                                    .send(Pending {
                                        launch,
                                        method: request["method"].as_str().unwrap().to_owned(),
                                        params: request["params"].clone(),
                                        reply,
                                        notifications: notifications_tx.clone(),
                                    })
                                    .unwrap();
                                let result = loop {
                                    tokio::select! {
                                        result = &mut result => break result.unwrap(),
                                        _ = lines.next_line() => return,
                                        Some(notification) = notifications.recv() => {
                                            if write.write_all(format!("{notification}\n").as_bytes()).await.is_err() {
                                                return;
                                            }
                                        }
                                    }
                                };
                                match result {
                                    Ok(result) => json!({ "id": id, "jsonrpc": "2.0", "result": result }),
                                    Err(error) => {
                                        json!({ "id": id, "jsonrpc": "2.0", "error": { "code": -32000, "message": error } })
                                    }
                                }
                            }
                            method => panic!("discovery must not call {method}"),
                        };
                        if write.write_all(format!("{response}\n").as_bytes()).await.is_err() {
                            break;
                        }
                    }
                });
                let (read, write) = tokio::io::split(client_io);
                Ok(Peer::connect_framed(read, write, client, Framing::Lines))
            }
        });
        Self { connector, pending, launches, live }
    }

    async fn next(&mut self) -> Pending {
        tokio::time::timeout(Duration::from_secs(5), self.pending.recv()).await.unwrap().unwrap()
    }
}

fn configure(root: &Path, version: &str) {
    std::fs::create_dir_all(root.join("agents")).unwrap();
    let executable = root.join("catalog-test-bin");
    if !executable.exists() {
        std::fs::write(&executable, "first executable").unwrap();
    }
    std::fs::write(
        root.join("agents/catalog-test.toml"),
        format!(
            "name = \"Catalog Test\"\ncommand = {}\n[env]\nTOKEN = \"secret-{version}\"\n",
            serde_json::to_string(&executable.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
}

fn make_manager(root: &Path, catalogs: Arc<AgentCatalogs>, harness: &Harness) -> AgentManager {
    make_manager_at(root, &root.join("models.json"), catalogs, harness)
}

fn make_manager_at(root: &Path, models_file: &Path, catalogs: Arc<AgentCatalogs>, harness: &Harness) -> AgentManager {
    AgentManager::with_connector(
        AgentPaths {
            project_root: root.to_path_buf(),
            store_dir: root.join("store"),
            worktrees_dir: root.join("worktrees"),
            models_file: models_file.to_path_buf(),
            catalogs,
            custom_agents_dir: Some(root.join("agents")),
            home_dir: Some(root.to_path_buf()),
            env_secrets: None,
        },
        tokio::runtime::Handle::current(),
        harness.connector.clone(),
    )
}

fn events(manager: &AgentManager) -> mpsc::UnboundedReceiver<AgentEvent> {
    let (tx, rx) = mpsc::unbounded_channel();
    manager.subscribe(Arc::new(move |event| {
        let _ = tx.send(event);
    }));
    rx
}

async fn completed(events: &mut mpsc::UnboundedReceiver<AgentEvent>) -> AgentModelCatalog {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let AgentEvent::ModelCatalog { catalog } = events.recv().await.unwrap()
                && !catalog.refreshing
            {
                return catalog;
            }
        }
    })
    .await
    .unwrap()
}

fn response(models: &[&str], effort: &[&str]) -> Value {
    json!({ "sessionId": "discovery-only", "configOptions": [
        { "id": "model", "type": "select", "category": "model", "currentValue": models.first(),
          "options": models.iter().map(|m| json!({ "value": m, "name": m })).collect::<Vec<_>>() },
        { "id": "effort", "type": "select", "category": "thought_level", "currentValue": effort.first(),
          "options": effort.iter().map(|e| json!({ "value": e })).collect::<Vec<_>>() }
    ] })
}

fn model_values(catalog: &AgentModelCatalog) -> Vec<&str> {
    catalog
        .config
        .iter()
        .filter(|o| o.category.as_deref() == Some("model"))
        .flat_map(|o| o.values.iter().map(|v| v.value.as_str()))
        .collect()
}

async fn stopped(harness: &Harness) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while harness.live.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn advance(catalogs: &AgentCatalogs, seconds: u64) {
    catalogs.clock_ms.fetch_add(seconds * 1000, Ordering::Relaxed);
}

#[tokio::test]
async fn successful_refresh_replaces_models_and_efforts_and_old_sessions_cannot_revert_it() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), catalogs.clone(), &harness);
    let mut events = events(&manager);
    let old = config::options_of(&response(&["old", "retained"], &["low", "high"]));
    let cached = manager.refresh_models(PROVIDER, false, None).unwrap();
    assert!(cached.refreshing);
    assert!(model_values(&cached).is_empty(), "nothing is offered before the first discovery");
    let pending = harness.next().await;
    assert_eq!(pending.params["mcpServers"], json!([]));
    pending.reply.send(Ok(response(&["retained", "new"], &["medium"]))).unwrap();
    let fresh = completed(&mut events).await;
    assert_eq!(model_values(&fresh), ["retained", "new"]);
    // The session's efforts describe its own model, not "new".
    assert_eq!(fresh.thought_levels.keys().map(String::as_str).collect::<Vec<_>>(), ["retained"]);
    assert_eq!(fresh.thought_levels["retained"][0].values[0].value, "medium");
    assert!(fresh.refreshed_at_ms.is_some() && fresh.retry_at_ms.is_some());
    manager.shared.remember(PROVIDER, Some(&old), None, Some("old"));
    assert_eq!(manager.refresh_models(PROVIDER, false, None).unwrap().config, fresh.config);
    let provider = manager.providers().into_iter().find(|p| p.id == PROVIDER).unwrap();
    assert_eq!(provider.config, fresh.config);
    let persisted = std::fs::read_to_string(tmp.path().join("models.json")).unwrap();
    assert!(!persisted.contains("secret-one") && !persisted.contains("TOKEN"));
    let restored = make_manager(tmp.path(), Arc::default(), &harness);
    let restored_snapshot = restored.refresh_models(PROVIDER, false, None).unwrap();
    assert!(!restored_snapshot.refreshing, "matching persisted launch context remains fresh");
    assert_eq!(restored_snapshot.refreshed_at_ms, fresh.refreshed_at_ms);
    let provider = restored.providers().into_iter().find(|p| p.id == PROVIDER).unwrap();
    assert_eq!(provider.config, fresh.config);
    restored.shared.remember(PROVIDER, Some(&old), None, Some("old"));
    assert_eq!(restored.shared.known_config(PROVIDER), fresh.config);
    assert_eq!(
        restored.shared.paths.catalogs.cached(&restored.shared, PROVIDER).refreshed_at_ms,
        fresh.refreshed_at_ms
    );
    assert!(!tmp.path().join("store").exists(), "refresh never creates tasks");
}

#[tokio::test]
async fn a_session_adds_the_efforts_of_a_model_discovery_did_not_read() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let mut harness = Harness::new();
    let catalogs = Arc::new(AgentCatalogs::default());
    let manager = make_manager(tmp.path(), catalogs.clone(), &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, false, None).unwrap();
    harness.next().await.reply.send(Ok(response(&["first", "second"], &["low", "high"]))).unwrap();
    completed(&mut events).await;
    // A session on "second" reports its own efforts; one on a model the catalog lacks, or on
    // "first" with other efforts, changes nothing.
    let second = config::options_of(&response(&["second"], &["off", "auto"]));
    manager.shared.remember(PROVIDER, Some(&second), None, Some("second"));
    manager.shared.remember(PROVIDER, Some(&config::options_of(&response(&["gone"], &["x"]))), None, Some("gone"));
    manager.shared.remember(PROVIDER, Some(&config::options_of(&response(&["first"], &["max"]))), None, Some("first"));
    let efforts = |catalog: &AgentModelCatalog, model: &str| -> Vec<String> {
        catalog.thought_levels[model][0].values.iter().map(|v| v.value.clone()).collect()
    };
    let catalog = manager.refresh_models(PROVIDER, false, None).unwrap();
    assert_eq!(catalog.thought_levels.keys().map(String::as_str).collect::<Vec<_>>(), ["first", "second"]);
    assert_eq!(efforts(&catalog, "first"), ["low", "high"]);
    assert_eq!(efforts(&catalog, "second"), ["off", "auto"]);
    let restored = make_manager(tmp.path(), Arc::default(), &harness).refresh_models(PROVIDER, false, None).unwrap();
    assert_eq!(efforts(&restored, "second"), ["off", "auto"], "persisted with the project's catalog");
    // Discovery again reads "first" only; "second" keeps what its session reported.
    advance(&catalogs, 60);
    while events.try_recv().is_ok() {}
    manager.refresh_models(PROVIDER, true, None).unwrap();
    harness.next().await.reply.send(Ok(response(&["first", "second"], &["medium"]))).unwrap();
    let fresh = completed(&mut events).await;
    assert_eq!(efforts(&fresh, "first"), ["medium"]);
    assert_eq!(efforts(&fresh, "second"), ["off", "auto"]);
}

#[tokio::test]
async fn discovered_model_is_confirmed_by_the_live_session() {
    switch_chat_model(ChatSwitch::Live).await;
}

#[tokio::test]
async fn discovered_model_reloads_the_same_session_on_the_next_message() {
    switch_chat_model(ChatSwitch::Resume).await;
}

#[tokio::test]
async fn discovered_model_from_an_aged_catalog_can_still_be_selected() {
    switch_chat_model(ChatSwitch::Aged).await;
}

#[tokio::test]
async fn discovered_model_leaves_the_original_session_intact_after_resume_failure() {
    switch_chat_model(ChatSwitch::ResumeFails).await;
}

#[tokio::test]
async fn discovered_model_is_reverted_when_the_reloaded_session_does_not_offer_it() {
    switch_chat_model(ChatSwitch::Unavailable).await;
}

#[tokio::test]
async fn discovered_model_can_be_selected_while_the_session_is_not_running() {
    switch_chat_model(ChatSwitch::Idle).await;
}

#[tokio::test]
async fn discovered_model_effort_is_discovered_persisted_and_applied_before_the_first_reply() {
    switch_chat_model(ChatSwitch::Uncached).await;
}

#[tokio::test]
async fn discovered_model_with_no_effort_can_be_selected() {
    switch_chat_model(ChatSwitch::NoEffort).await;
}

#[tokio::test]
async fn discovered_model_settings_failure_leaves_the_chat_unchanged() {
    switch_chat_model(ChatSwitch::DiscoveryFails).await;
}

#[tokio::test]
async fn discovered_model_withdrawn_effort_prevents_sending() {
    switch_chat_model(ChatSwitch::EffortUnavailable).await;
}

#[tokio::test]
async fn discovered_model_rejected_effort_prevents_sending() {
    switch_chat_model(ChatSwitch::EffortRejected).await;
}

#[tokio::test]
async fn discovered_model_lookup_does_not_overwrite_a_newer_selection() {
    switch_chat_model(ChatSwitch::Superseded).await;
}

#[derive(Clone, Copy)]
enum ChatSwitch {
    Live,
    Aged,
    Resume,
    ResumeFails,
    Unavailable,
    Idle,
    Uncached,
    NoEffort,
    DiscoveryFails,
    EffortUnavailable,
    EffortRejected,
    Superseded,
}

async fn switch_chat_model(scenario: ChatSwitch) {
    use crate::{AgentPrompt, AgentStatus, Isolation, NewAgentTask};

    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let mut harness = Harness::with_initialize(json!({
        "protocolVersion": 1, "agentCapabilities": { "loadSession": true }
    }));
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut manager = make_manager(tmp.path(), catalogs.clone(), &harness);
    let task = manager
        .create(NewAgentTask {
            prompt: AgentPrompt { text: "first".into(), ..Default::default() },
            provider: PROVIDER.into(),
            isolation: Isolation::Local,
            ..Default::default()
        })
        .await
        .unwrap();
    let next = harness.next().await;
    assert_eq!((next.launch, next.method.as_str()), (0, "session/new"));
    let mut initial = response(&["old"], &["low", "high"]);
    initial["sessionId"] = json!("saved-chat");
    initial["modes"] = json!({
        "currentModeId": "code", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "code", "name": "Code"}]
    });
    next.reply.send(Ok(initial.clone())).unwrap();
    let next = harness.next().await;
    assert_eq!(
        (next.launch, next.method.as_str(), &next.params["sessionId"]),
        (0, "session/prompt", &json!("saved-chat"))
    );
    next.reply.send(Ok(json!({"stopReason": "end_turn"}))).unwrap();
    wait_for_chat(&manager, &task.id, AgentStatus::Ready).await;
    {
        let mode = manager.set_config(&task.id, "mode", "ask".into());
        tokio::pin!(mode);
        let set = next_chat_request(&mut harness, mode.as_mut()).await;
        assert_eq!((set.launch, set.method.as_str()), (0, "session/set_mode"));
        assert_eq!(set.params, json!({"sessionId": "saved-chat", "modeId": "ask"}));
        set.reply.send(Ok(json!({}))).unwrap();
        mode.await.unwrap();
    }
    let before_entries = serde_json::to_value(manager.entries(&task.id, None).unwrap()).unwrap();
    let before_config = manager.task(&task.id).unwrap().state.lock().task.config.clone();
    let offline = matches!(scenario, ChatSwitch::Idle | ChatSwitch::Uncached | ChatSwitch::Superseded);
    let missing_settings = matches!(
        scenario,
        ChatSwitch::Uncached | ChatSwitch::NoEffort | ChatSwitch::DiscoveryFails | ChatSwitch::Superseded
    );
    let no_effort = matches!(scenario, ChatSwitch::NoEffort);
    let effort_error = match scenario {
        ChatSwitch::EffortUnavailable => Some("no longer offers effort value thorough"),
        ChatSwitch::EffortRejected => Some("effort rejected by the agent"),
        _ => None,
    };
    let choose_effort = matches!(scenario, ChatSwitch::Uncached) || effort_error.is_some();
    let (catalog_models, catalog_effort): (&[&str], &[&str]) =
        if missing_settings { (&["old", "new"], &["low", "high"]) } else { (&["new", "old"], &["quick", "thorough"]) };
    if offline {
        manager.shutdown();
        manager = make_manager(tmp.path(), Arc::default(), &harness);
    }

    let mut events = events(&manager);
    assert!(manager.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    let next = harness.next().await;
    assert_eq!((next.launch, next.method.as_str()), (1, "session/new"));
    next.reply.send(Ok(response(catalog_models, catalog_effort))).unwrap();
    let catalog = completed(&mut events).await;
    assert_eq!(model_values(&catalog), catalog_models);
    if missing_settings {
        assert!(!catalog.thought_levels.contains_key("new"));
    }
    assert_eq!(manager.task(&task.id).unwrap().state.lock().task.config, before_config);

    let live = matches!(scenario, ChatSwitch::Live | ChatSwitch::Aged);
    if matches!(scenario, ChatSwitch::Aged) {
        // The catalog stays what the picker offers however long ago it was read.
        advance(&catalogs, 20 * 60);
    }
    let resumed_launch = if missing_settings { 3 } else { 2 };
    let load_fails = matches!(scenario, ChatSwitch::ResumeFails);
    let unavailable = matches!(scenario, ChatSwitch::Unavailable);
    {
        let switching = manager.set_config(&task.id, "model", "new".into());
        tokio::pin!(switching);
        if !offline {
            let next = next_chat_request(&mut harness, switching.as_mut()).await;
            assert_eq!((next.launch, next.method.as_str()), (0, "session/set_config_option"));
            assert_eq!(next.params, json!({"sessionId": "saved-chat", "configId": "model", "value": "new"}));
            if live {
                next.reply.send(Ok(response(&["new", "old"], &["session-only"]))).unwrap();
            } else {
                next.reply.send(Err("not in this process's model list".into())).unwrap();
            }
        }
        if missing_settings {
            let discovery = next_chat_request(&mut harness, switching.as_mut()).await;
            assert_eq!((discovery.launch, discovery.method.as_str()), (2, "session/new"));
            discovery.reply.send(Ok(response(catalog_models, catalog_effort))).unwrap();
            let set = next_chat_request(&mut harness, switching.as_mut()).await;
            assert_eq!(set.params, json!({"sessionId": "discovery-only", "configId": "model", "value": "new"}));
            assert_eq!(set.method, "session/set_config_option");
            assert!(
                manager
                    .prompt(&task.id, AgentPrompt { text: "too early".into(), ..Default::default() }, false)
                    .await
                    .is_err()
            );
            if matches!(scenario, ChatSwitch::DiscoveryFails) {
                set.reply.send(Err("Sign in required".into())).unwrap();
                let error = switching.await.unwrap_err().to_string();
                assert!(error.contains("Sign in required"), "{error}");
                assert_eq!(manager.subscribe(Arc::new(|_| {})).remove(0).config, before_config);
                assert!(harness.pending.try_recv().is_err());
                manager.shutdown();
                return;
            }
            if matches!(scenario, ChatSwitch::Superseded) {
                manager.set_config(&task.id, "model", "old".into()).await.unwrap();
                set.reply.send(Ok(response(&["new", "old"], &["quick", "thorough"]))).unwrap();
                switching.await.unwrap();
                let task = manager.subscribe(Arc::new(|_| {})).remove(0);
                assert_eq!(task.config.iter().find(|o| o.id == "model").unwrap().current.as_deref(), Some("old"));
                assert_eq!(task.config.iter().find(|o| o.id == "effort").unwrap().current.as_deref(), Some("low"));
                assert!(harness.pending.try_recv().is_err());
                manager.shutdown();
                return;
            }
            let levels: &[&str] = if no_effort { &[] } else { &["quick", "thorough"] };
            set.reply.send(Ok(response(&["new", "old"], levels))).unwrap();
        }
        tokio::select! {
            result = &mut switching => result.unwrap(),
            request = harness.next() => panic!("selection must not reopen the chat or send: {request:?}"),
        }
    }
    assert_eq!(serde_json::to_value(manager.entries(&task.id, None).unwrap()).unwrap(), before_entries);
    if matches!(scenario, ChatSwitch::Uncached) {
        let update = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let AgentEvent::Task { task: update } = events.recv().await.unwrap()
                    && update.id == task.id
                {
                    break update;
                }
            }
        })
        .await
        .unwrap();
        let effort = update.config.iter().find(|o| o.id == "effort").unwrap();
        assert_eq!(effort.values.iter().map(|v| v.value.as_str()).collect::<Vec<_>>(), ["quick", "thorough"]);
    }
    let snapshot = |manager: &AgentManager| manager.subscribe(Arc::new(|_| {})).remove(0);
    let current = snapshot(&manager);
    assert_eq!(current.config.iter().find(|o| o.id == "model").unwrap().current.as_deref(), Some("new"));
    assert_eq!(current.model.as_deref(), Some(if live { "new" } else { "old" }));
    let effort =
        |task: &crate::AgentTask| task.config.iter().find(|o| o.id == "effort").and_then(|o| o.current.clone());
    assert_eq!(
        effort(&current).as_deref(),
        if live {
            Some("session-only")
        } else if no_effort {
            None
        } else {
            Some("quick")
        },
        "the new model's effort must be available before sending"
    );
    if choose_effort {
        assert!(manager.set_config(&task.id, "effort", "high".into()).await.is_err());
        manager.set_config(&task.id, "effort", "thorough".into()).await.unwrap();
        assert_eq!(effort(&snapshot(&manager)).as_deref(), Some("thorough"));
        if matches!(scenario, ChatSwitch::Uncached) {
            manager.shutdown();
            manager = make_manager(tmp.path(), Arc::default(), &harness);
            let restored = snapshot(&manager);
            assert_eq!(restored.id, task.id);
            assert_eq!(effort(&restored).as_deref(), Some("thorough"));
        }
    }

    manager.prompt(&task.id, AgentPrompt { text: "next".into(), ..Default::default() }, false).await.unwrap();
    if !live {
        let load = harness.next().await;
        assert_eq!((load.launch, load.method.as_str()), (resumed_launch, "session/load"));
        assert_eq!(load.params["sessionId"], "saved-chat");
        load.notifications
            .send(json!({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "saved-chat",
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "replay"}}
            }}))
            .unwrap();
        if load_fails {
            load.notifications
                .send(json!({"jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": "saved-chat",
                    "update": {"sessionUpdate": "config_option_update",
                        "configOptions": response(&["other", "old"], &["low"])["configOptions"]}
                }}))
                .unwrap();
            load.reply.send(Err("cannot resume saved-chat".into())).unwrap();
        } else {
            let models: &[&str] = if unavailable { &["old"] } else { &["old", "new"] };
            let mut resumed = response(models, &["low", "high"]);
            resumed["modes"] = initial["modes"].clone();
            load.reply.send(Ok(resumed)).unwrap();
        }
        if load_fails || unavailable {
            wait_for_chat(&manager, &task.id, AgentStatus::Failed).await;
            let task = snapshot(&manager);
            assert_eq!(task.model.as_deref(), Some("old"));
            assert_eq!(task.config.iter().find(|o| o.id == "model").unwrap().current.as_deref(), Some("old"));
            assert_eq!(effort(&task).as_deref(), Some("low"));
            let expected = if load_fails { "cannot resume saved-chat" } else { "does not offer model new" };
            assert!(task.error.as_deref().unwrap().contains(expected), "{:?}", task.error);
            assert!(harness.pending.try_recv().is_err(), "must not send on the previous model or create a session");
            if load_fails {
                manager
                    .prompt(&task.id, AgentPrompt { text: "retry".into(), ..Default::default() }, false)
                    .await
                    .unwrap();
                let retry = harness.next().await;
                assert_eq!((retry.launch, retry.method.as_str()), (3, "session/load"));
                assert_eq!(retry.params["sessionId"], "saved-chat");
                retry.reply.send(Ok(initial.clone())).unwrap();
                let set = harness.next().await;
                assert_eq!(set.method, "session/set_mode");
                set.reply.send(Ok(json!({}))).unwrap();
                let prompt = harness.next().await;
                assert_eq!(prompt.method, "session/prompt");
                assert_eq!(prompt.params["sessionId"], "saved-chat");
                prompt.reply.send(Ok(json!({"stopReason": "end_turn"}))).unwrap();
                wait_for_chat(&manager, &task.id, AgentStatus::Ready).await;
            }
            manager.shutdown();
            return;
        }
        let set = harness.next().await;
        assert_eq!((set.launch, set.method.as_str()), (resumed_launch, "session/set_config_option"));
        assert_eq!(set.params, json!({"sessionId": "saved-chat", "configId": "model", "value": "new"}));
        let levels: &[&str] = match scenario {
            ChatSwitch::NoEffort => &[],
            ChatSwitch::EffortUnavailable => &["session-only", "quick"],
            _ if choose_effort => &["session-only", "thorough"],
            _ => &["session-only"],
        };
        set.reply.send(Ok(response(&["new", "old"], levels))).unwrap();
        let set = harness.next().await;
        assert_eq!((set.launch, set.method.as_str()), (resumed_launch, "session/set_mode"));
        assert_eq!(set.params, json!({"sessionId": "saved-chat", "modeId": "ask"}));
        set.reply.send(Ok(json!({}))).unwrap();
        if choose_effort && !matches!(scenario, ChatSwitch::EffortUnavailable) {
            let set = harness.next().await;
            assert_eq!((set.launch, set.method.as_str()), (resumed_launch, "session/set_config_option"));
            assert_eq!(set.params, json!({"sessionId": "saved-chat", "configId": "effort", "value": "thorough"}));
            let reply = if effort_error.is_some() {
                Err("effort rejected by the agent".into())
            } else {
                Ok(response(&["new", "old"], &["thorough", "session-only"]))
            };
            set.reply.send(reply).unwrap();
        }
        if let Some(expected) = effort_error {
            wait_for_chat(&manager, &task.id, AgentStatus::Failed).await;
            let current = snapshot(&manager);
            assert_eq!(current.model.as_deref(), Some("old"));
            assert_eq!(effort(&current).as_deref(), Some("low"));
            assert!(current.error.as_deref().unwrap().contains(expected), "{:?}", current.error);
            assert!(harness.pending.try_recv().is_err(), "must not send using a fallback effort");
            manager.shutdown();
            return;
        }
    }
    let next = harness.next().await;
    assert_eq!(
        (next.launch, next.method.as_str(), &next.params["sessionId"]),
        (if live { 0 } else { resumed_launch }, "session/prompt", &json!("saved-chat"))
    );
    next.reply.send(Ok(json!({"stopReason": "end_turn"}))).unwrap();
    wait_for_chat(&manager, &task.id, AgentStatus::Ready).await;
    let current = snapshot(&manager);
    assert_eq!(current.model.as_deref(), Some("new"));
    assert_eq!(
        effort(&current).as_deref(),
        if choose_effort {
            Some("thorough")
        } else if no_effort {
            None
        } else {
            Some("session-only")
        }
    );
    assert_eq!(current.config.iter().find(|o| o.id == "mode").unwrap().current.as_deref(), Some("ask"));
    manager.shutdown();
}

async fn wait_for_chat(manager: &AgentManager, id: &str, status: crate::AgentStatus) {
    let task = manager.task(id).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while task.state.lock().task.status != status || task.state.lock().busy {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn next_chat_request(
    harness: &mut Harness,
    switching: std::pin::Pin<&mut impl Future<Output = crate::IdeResult<()>>>,
) -> Pending {
    tokio::select! {
        result = switching => panic!("model switching ended before contacting the session: {result:?}"),
        request = harness.next() => request,
    }
}

#[tokio::test]
async fn a_cache_from_before_project_catalogs_offers_nothing_until_discovery_succeeds() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let options = config::options_of(&response(&["legacy"], &["low"]));
    std::fs::write(
        tmp.path().join("models.json"),
        serde_json::to_vec(&json!({
            (PROVIDER): { "config": options, "thoughtLevels": {}, "projectCommands": {} }
        }))
        .unwrap(),
    )
    .unwrap();
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), Arc::default(), &harness);
    let mut events = events(&manager);
    let cached = manager.refresh_models(PROVIDER, false, None).unwrap();
    assert!(model_values(&cached).is_empty());
    assert!(cached.refreshing && cached.refreshed_at_ms.is_none());
    harness.next().await.reply.send(Ok(response(&["current"], &["low"]))).unwrap();
    let found = completed(&mut events).await;
    assert_eq!(model_values(&found), ["current"]);
}

#[tokio::test]
async fn concurrent_windows_commands_and_manual_requests_share_one_flight_and_cooldown() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let first = Arc::new(make_manager(tmp.path(), catalogs.clone(), &harness));
    let second = make_manager(tmp.path(), catalogs.clone(), &harness);
    let mut first_events = events(&first);
    let mut second_events = events(&second);
    assert!(first.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    let pending = harness.next().await;
    for _ in 0..10 {
        assert!(second.refresh_models(PROVIDER, true, None).unwrap().refreshing);
        assert!(first.refresh_models(PROVIDER, true, None).unwrap().refreshing);
    }
    let commands = tokio::spawn({
        let first = first.clone();
        async move { first.commands(PROVIDER, None).await }
    });
    tokio::task::yield_now().await;
    assert_eq!(harness.launches.load(Ordering::SeqCst), 1);
    pending.reply.send(Ok(response(&["one"], &["low"]))).unwrap();
    let done = completed(&mut first_events).await;
    assert_eq!(completed(&mut second_events).await, done);
    commands.await.unwrap().unwrap();
    for force in [false, true, false, true] {
        assert!(!second.refresh_models(PROVIDER, force, None).unwrap().refreshing);
    }
    advance(&catalogs, 29);
    assert!(!first.refresh_models(PROVIDER, true, None).unwrap().refreshing);
    advance(&catalogs, 1);
    assert!(!first.refresh_models(PROVIDER, false, None).unwrap().refreshing, "automatic refresh remains fresh");
    assert!(first.refresh_models(PROVIDER, true, None).unwrap().refreshing);
    harness.next().await.reply.send(Ok(response(&["two"], &["high"]))).unwrap();
    let newer = completed(&mut first_events).await;
    assert_eq!(model_values(&newer), ["two"]);
    assert_eq!(completed(&mut second_events).await, newer);
    advance(&catalogs, 15 * 60 - 1);
    assert!(!second.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    advance(&catalogs, 1);
    assert!(second.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    harness.next().await.reply.send(Ok(response(&["three"], &["low"]))).unwrap();
    completed(&mut first_events).await;
    assert_eq!(harness.launches.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn failure_keeps_successful_choices_and_throttles_manual_and_auto_retries() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), catalogs.clone(), &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, true, None).unwrap();
    harness.next().await.reply.send(Ok(response(&["cached"], &["low"]))).unwrap();
    let success = completed(&mut events).await;
    let disk = std::fs::read(tmp.path().join("models.json")).unwrap();
    advance(&catalogs, 15 * 60);
    manager.refresh_models(PROVIDER, false, None).unwrap();
    harness.next().await.reply.send(Err("Authentication expired".into())).unwrap();
    let failed = completed(&mut events).await;
    assert_eq!(failed.config, success.config);
    assert_eq!(failed.thought_levels, success.thought_levels);
    assert_eq!(failed.refreshed_at_ms, success.refreshed_at_ms);
    assert!(failed.error.as_deref().unwrap().contains("Sign in required"));
    assert_eq!(std::fs::read(tmp.path().join("models.json")).unwrap(), disk);
    assert!(!manager.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    assert!(!manager.refresh_models(PROVIDER, true, None).unwrap().refreshing);
    advance(&catalogs, 29);
    assert!(!manager.refresh_models(PROVIDER, true, None).unwrap().refreshing);
    advance(&catalogs, 1);
    assert!(manager.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    harness.next().await.reply.send(Ok(response(&["recovered"], &["high"]))).unwrap();
    let recovered = completed(&mut events).await;
    assert_eq!(model_values(&recovered), ["recovered"]);
    assert!(recovered.error.is_none());
}

#[tokio::test]
async fn timeout_cleans_up_and_enters_the_same_failure_cooldown() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), catalogs.clone(), &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, false, None).unwrap();
    let pending = harness.next().await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(4)).await;
    let failed = completed(&mut events).await;
    assert!(failed.error.as_deref().unwrap().contains("time"));
    assert!(failed.retry_at_ms.is_some());
    assert!(!manager.refresh_models(PROVIDER, true, None).unwrap().refreshing);
    assert!(!manager.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    tokio::time::resume();
    stopped(&harness).await;
    assert_eq!(harness.live.load(Ordering::SeqCst), 0, "timed-out connection must close");
    assert!(pending.reply.is_closed());
    advance(&catalogs, 30);
    assert!(manager.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    harness.next().await.reply.send(Ok(response(&["retry"], &["low"]))).unwrap();
    completed(&mut events).await;
}

#[tokio::test]
async fn changed_effective_config_supersedes_old_completion_without_queueing() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let first = make_manager(tmp.path(), catalogs.clone(), &harness);
    let second = make_manager(tmp.path(), catalogs.clone(), &harness);
    let mut events = events(&second);
    first.refresh_models(PROVIDER, false, None).unwrap();
    let obsolete = harness.next().await;
    configure(tmp.path(), "two");
    assert!(second.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    let latest = harness.next().await;
    latest.reply.send(Ok(response(&["latest"], &["high"]))).unwrap();
    let fresh = completed(&mut events).await;
    let _ = obsolete.reply.send(Ok(response(&["obsolete"], &["low"])));
    stopped(&harness).await;
    let shown = first.refresh_models(PROVIDER, false, None).unwrap();
    assert_eq!(shown.config, fresh.config);
    assert_eq!(shown.refreshed_at_ms, fresh.refreshed_at_ms);
    assert!(!shown.refreshing);
    assert_eq!(harness.launches.load(Ordering::SeqCst), 2);
    assert!(!std::fs::read_to_string(tmp.path().join("models.json")).unwrap().contains("obsolete"));
    // A changed configuration also invalidates successful freshness/cooldown.
    configure(tmp.path(), "three");
    assert!(first.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    harness.next().await.reply.send(Ok(response(&["new-config"], &["medium"]))).unwrap();
    completed(&mut events).await;
}

#[tokio::test]
async fn invalid_provider_is_a_request_error_and_does_not_launch() {
    let tmp = tempfile::tempdir().unwrap();
    let harness = Harness::new();
    let manager = make_manager(tmp.path(), Arc::default(), &harness);
    assert!(manager.refresh_models("missing-provider", true, None).is_err());
    assert_eq!(harness.launches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn replacing_the_executable_at_the_same_path_invalidates_freshness_and_obsolete_responses() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "unchanged-environment");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), catalogs, &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, false, None).unwrap();
    let obsolete = harness.next().await;
    std::fs::write(tmp.path().join("catalog-test-bin"), "replacement executable with different size").unwrap();
    manager.refresh_models(PROVIDER, false, None).unwrap();
    let latest = harness.next().await;
    latest.reply.send(Ok(response(&["updated"], &["high"]))).unwrap();
    let fresh = completed(&mut events).await;
    let _ = obsolete.reply.send(Ok(response(&["obsolete"], &["low"])));
    stopped(&harness).await;
    assert_eq!(manager.refresh_models(PROVIDER, false, None).unwrap().config, fresh.config);
    std::fs::write(tmp.path().join("catalog-test-bin"), "another executable").unwrap();
    assert!(manager.refresh_models(PROVIDER, false, None).unwrap().refreshing);
    harness.next().await.reply.send(Ok(response(&["new-install"], &["medium"]))).unwrap();
    assert_eq!(model_values(&completed(&mut events).await), ["new-install"]);
    assert_eq!(harness.launches.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn project_catalogs_and_persisted_freshness_do_not_leak_between_contexts() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("project-a");
    let b = tmp.path().join("project-b");
    configure(&a, "account-a");
    configure(&b, "account-b");
    let models_file = tmp.path().join("shared-models.json");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let first = make_manager_at(&a, &models_file, catalogs.clone(), &harness);
    let second = make_manager_at(&b, &models_file, catalogs, &harness);
    let mut first_events = events(&first);
    let mut second_events = events(&second);
    first.refresh_models(PROVIDER, false, None).unwrap();
    harness.next().await.reply.send(Ok(response(&["account-a-model"], &["low"]))).unwrap();
    let a_catalog = completed(&mut first_events).await;
    second.refresh_models(PROVIDER, false, None).unwrap();
    harness.next().await.reply.send(Ok(response(&["account-b-model"], &["high"]))).unwrap();
    let b_catalog = completed(&mut second_events).await;
    assert_eq!(first.refresh_models(PROVIDER, false, None).unwrap().config, a_catalog.config);
    assert_eq!(second.refresh_models(PROVIDER, false, None).unwrap().config, b_catalog.config);
    assert_eq!(first.providers().into_iter().find(|p| p.id == PROVIDER).unwrap().config, a_catalog.config);
    for (root, expected) in [(&a, &a_catalog), (&b, &b_catalog)] {
        let restored = make_manager_at(root, &models_file, Arc::default(), &harness);
        let cached = restored.refresh_models(PROVIDER, false, None).unwrap();
        assert!(!cached.refreshing, "matching persisted context should retain freshness");
        assert_eq!(cached.config, expected.config);
        assert_eq!(cached.refreshed_at_ms, expected.refreshed_at_ms);
    }
    assert_eq!(harness.launches.load(Ordering::SeqCst), 2);
    configure(&a, "new-account");
    let changed = make_manager_at(&a, &models_file, Arc::default(), &harness);
    let mut events = events(&changed);
    let stale = changed.refresh_models(PROVIDER, false, None).unwrap();
    assert!(stale.refreshing, "a different launch environment cannot reuse persisted freshness");
    assert!(stale.refreshed_at_ms.is_none());
    assert_eq!(stale.config, a_catalog.config, "stale cached choices remain selectable");
    harness.next().await.reply.send(Ok(response(&["new-account-model"], &["medium"]))).unwrap();
    completed(&mut events).await;
    let persisted = std::fs::read_to_string(models_file).unwrap();
    assert!(!persisted.contains("secret-") && !persisted.contains("TOKEN"));
}

#[tokio::test]
async fn configuration_changed_without_another_request_also_discards_old_discovery() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "before");
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), Arc::default(), &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, false, None).unwrap();
    let obsolete = harness.next().await;
    configure(tmp.path(), "after");
    obsolete.reply.send(Ok(response(&["obsolete"], &["low"]))).unwrap();
    let discarded = completed(&mut events).await;
    assert!(model_values(&discarded).is_empty());
    assert!(discarded.refreshed_at_ms.is_none());
    assert!(!tmp.path().join("models.json").exists());
    manager.refresh_models(PROVIDER, false, None).unwrap();
    harness.next().await.reply.send(Ok(response(&["current"], &["high"]))).unwrap();
    assert_eq!(model_values(&completed(&mut events).await), ["current"]);
}

#[tokio::test]
async fn successful_empty_catalog_removes_all_previous_models_and_efforts() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), catalogs.clone(), &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, true, None).unwrap();
    harness.next().await.reply.send(Ok(response(&["removed"], &["low"]))).unwrap();
    completed(&mut events).await;
    advance(&catalogs, 30);
    manager.refresh_models(PROVIDER, true, None).unwrap();
    harness.next().await.reply.send(Ok(response(&[], &[]))).unwrap();
    let empty = completed(&mut events).await;
    assert!(model_values(&empty).is_empty() && empty.thought_levels.is_empty());
    assert!(empty.refreshed_at_ms.is_some() && empty.error.is_none());
}

fn selected_response(model: &str, effort: &[&str]) -> Value {
    let mut result = response(&[model], effort);
    if effort.is_empty() {
        result["configOptions"].as_array_mut().unwrap().retain(|option| option["id"] != "effort");
    }
    result
}

fn config_notification(session: &str, result: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": "session/update", "params": {
        "sessionId": session,
        "update": { "sessionUpdate": "config_option_update", "configOptions": result["configOptions"] }
    } })
}

fn efforts<'a>(catalog: &'a AgentModelCatalog, model: &str) -> Vec<&'a str> {
    catalog.thought_levels[model]
        .iter()
        .filter(|option| option.category.as_deref() == Some("thought_level"))
        .flat_map(|option| option.values.iter().map(|value| value.value.as_str()))
        .collect()
}

#[tokio::test]
async fn selected_models_report_their_own_controls_before_any_task_or_prompt() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), catalogs.clone(), &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, false, None).unwrap();
    let models = ["default", "second", "plain", "unknown"];
    harness.next().await.reply.send(Ok(response(&models, &["low", "high"]))).unwrap();
    let original = completed(&mut events).await;
    assert!(!original.thought_levels.contains_key("second"));

    // A fresh catalog and its global cooldown must not delay an unknown selection.
    assert!(manager.refresh_models(PROVIDER, false, Some("second")).unwrap().refreshing);
    harness.next().await.reply.send(Ok(response(&models, &["low", "high"]))).unwrap();
    let pending = harness.next().await;
    assert_eq!(pending.method, "session/set_config_option");
    assert_eq!(pending.params, json!({ "sessionId": "discovery-only", "configId": "model", "value": "second" }));
    let mut second = selected_response("second", &["off", "auto", "max"]);
    second["configOptions"].as_array_mut().unwrap().push(json!({
        "id": "context_tier", "type": "select", "currentValue": "large",
        "options": [{ "value": "normal" }, { "value": "large" }]
    }));
    pending.reply.send(Ok(second)).unwrap();
    let learned = completed(&mut events).await;
    assert_eq!(learned.config, original.config, "selection discovery never changes the default model");
    assert_eq!(efforts(&learned, "default"), ["low", "high"]);
    assert_eq!(efforts(&learned, "second"), ["off", "auto", "max"]);
    assert!(learned.thought_levels["second"].iter().any(|option| option.id == "context_tier"));
    assert!(!learned.thought_levels.contains_key("unknown"));

    manager.refresh_models(PROVIDER, false, Some("plain")).unwrap();
    harness.next().await.reply.send(Ok(response(&models, &["low", "high"]))).unwrap();
    harness.next().await.reply.send(Ok(selected_response("plain", &[]))).unwrap();
    let plain = completed(&mut events).await;
    assert!(plain.thought_levels["plain"].is_empty(), "an authoritative no-control result is cached");
    for model in ["default", "second", "plain"] {
        assert!(!manager.refresh_models(PROVIDER, false, Some(model)).unwrap().refreshing);
    }
    let restored = make_manager(tmp.path(), Arc::default(), &harness);
    let cached = restored.refresh_models(PROVIDER, false, Some("plain")).unwrap();
    assert!(!cached.refreshing);
    assert!(cached.thought_levels["plain"].is_empty());
    assert_eq!(efforts(&cached, "second"), ["off", "auto", "max"]);
    assert_eq!(harness.launches.load(Ordering::SeqCst), 3, "never iterate unselected models");
    assert!(!tmp.path().join("store").exists(), "no task or prompt is needed");
}

#[tokio::test]
async fn missing_or_failed_selected_settings_remain_unknown_and_have_model_scoped_retry_cooldowns() {
    for reply in [Ok(json!({})), Ok(selected_response("default", &["wrong"])), Err("token=secret-one".into())] {
        let tmp = tempfile::tempdir().unwrap();
        configure(tmp.path(), "one");
        let catalogs = Arc::new(AgentCatalogs::default());
        let mut harness = Harness::new();
        let manager = make_manager(tmp.path(), catalogs.clone(), &harness);
        let mut events = events(&manager);
        let models = ["default", "unsupported", "other"];
        manager.refresh_models(PROVIDER, false, None).unwrap();
        harness.next().await.reply.send(Ok(response(&models, &["low"]))).unwrap();
        let original = completed(&mut events).await;
        manager.refresh_models(PROVIDER, false, Some("unsupported")).unwrap();
        harness.next().await.reply.send(Ok(response(&models, &["low"]))).unwrap();
        harness.next().await.reply.send(reply).unwrap();
        let failed = completed(&mut events).await;
        assert_eq!(failed.config, original.config);
        assert!(!failed.thought_levels.contains_key("unsupported"));
        assert!(failed.error.is_some() && failed.retry_at_ms.is_some());
        assert!(!failed.error.as_deref().unwrap().contains("secret-one"));
        assert!(!manager.refresh_models(PROVIDER, true, Some("unsupported")).unwrap().refreshing);
        // The failed model cannot block another model, and its cooldown survives that success.
        assert!(manager.refresh_models(PROVIDER, false, Some("other")).unwrap().refreshing);
        harness.next().await.reply.send(Ok(response(&models, &["low"]))).unwrap();
        harness.next().await.reply.send(Ok(selected_response("other", &[]))).unwrap();
        assert!(completed(&mut events).await.error.is_none());
        assert!(!manager.refresh_models(PROVIDER, false, Some("unsupported")).unwrap().refreshing);
        advance(&catalogs, 30);
        assert!(manager.refresh_models(PROVIDER, true, Some("unsupported")).unwrap().refreshing);
        harness.next().await.reply.send(Ok(response(&models, &["low"]))).unwrap();
        harness.next().await.reply.send(Ok(selected_response("unsupported", &["high"]))).unwrap();
        let retried = completed(&mut events).await;
        assert_eq!(efforts(&retried, "unsupported"), ["high"]);
        assert!(retried.error.is_none());
    }
}

#[tokio::test]
async fn rapid_model_selections_share_the_current_flight_and_discard_superseded_results() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let first = make_manager(tmp.path(), catalogs.clone(), &harness);
    let second = make_manager(tmp.path(), catalogs.clone(), &harness);
    let mut events = events(&first);
    let models = ["default", "second", "third"];
    first.refresh_models(PROVIDER, false, None).unwrap();
    harness.next().await.reply.send(Ok(response(&models, &["low"]))).unwrap();
    completed(&mut events).await;
    first.refresh_models(PROVIDER, false, Some("second")).unwrap();
    harness.next().await.reply.send(Ok(response(&models, &["low"]))).unwrap();
    let obsolete = harness.next().await;
    for _ in 0..5 {
        assert!(second.refresh_models(PROVIDER, false, Some("second")).unwrap().refreshing);
    }
    assert_eq!(harness.launches.load(Ordering::SeqCst), 2);
    second.refresh_models(PROVIDER, false, Some("third")).unwrap();
    harness.next().await.reply.send(Ok(response(&models, &["low"]))).unwrap();
    let current = harness.next().await;
    assert_eq!(current.params["value"], "third");
    current.reply.send(Ok(selected_response("third", &["max"]))).unwrap();
    let fresh = completed(&mut events).await;
    let _ = obsolete.reply.send(Ok(selected_response("second", &["obsolete"])));
    stopped(&harness).await;
    let cached = first.refresh_models(PROVIDER, false, Some("third")).unwrap();
    assert_eq!(cached, fresh);
    assert_eq!(efforts(&cached, "third"), ["max"]);
    assert!(!cached.thought_levels.contains_key("second"));
    assert_eq!(harness.launches.load(Ordering::SeqCst), 3, "no stale requests are queued");
    assert!(!std::fs::read_to_string(tmp.path().join("models.json")).unwrap().contains("obsolete"));
}

#[tokio::test]
async fn switching_back_to_a_known_model_cancels_the_unknown_model_flight() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), Arc::default(), &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, false, None).unwrap();
    harness.next().await.reply.send(Ok(response(&["default", "second"], &["low"]))).unwrap();
    completed(&mut events).await;
    manager.refresh_models(PROVIDER, false, Some("second")).unwrap();
    let obsolete = harness.next().await;
    let known = manager.refresh_models(PROVIDER, false, Some("default")).unwrap();
    assert!(!known.refreshing);
    assert_eq!(completed(&mut events).await, known, "other subscribers also leave loading state");
    let _ = obsolete.reply.send(Err("late failure".into()));
    stopped(&harness).await;
    let cached = manager.refresh_models(PROVIDER, false, Some("default")).unwrap();
    assert!(cached.error.is_none() && !cached.thought_levels.contains_key("second"));
    assert_eq!(harness.launches.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn selected_model_uses_legacy_set_model_and_authoritative_notifications() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), Arc::default(), &harness);
    let mut events = events(&manager);
    // No cache is needed: the selected model is resolved in the same short-lived session.
    manager.refresh_models(PROVIDER, false, Some("second")).unwrap();
    harness
        .next()
        .await
        .reply
        .send(Ok(json!({
            "sessionId": "discovery-only",
            "models": { "currentModelId": "default", "availableModels": [
                { "modelId": "default", "name": "Default" }, { "modelId": "second", "name": "Second" }
            ] }
        })))
        .unwrap();
    let selected = harness.next().await;
    assert_eq!(selected.method, "session/set_model");
    assert_eq!(selected.params, json!({ "sessionId": "discovery-only", "modelId": "second" }));
    let notifications = selected.notifications;
    selected.reply.send(Ok(json!({}))).unwrap();
    notifications.send(config_notification("different-session", &selected_response("second", &["wrong"]))).unwrap();
    notifications
        .send(config_notification("discovery-only", &selected_response("second", &["medium", "high"])))
        .unwrap();
    let catalog = completed(&mut events).await;
    assert_eq!(efforts(&catalog, "second"), ["medium", "high"]);
    assert_eq!(catalog.config.iter().find(|option| option.id == "model").unwrap().current.as_deref(), Some("default"));
    assert!(!catalog.thought_levels.contains_key("default"), "legacy model lists alone do not assert no controls");
}

#[tokio::test]
async fn selected_legacy_model_without_settings_has_no_levels_instead_of_failing() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), Arc::default(), &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, false, Some("second")).unwrap();
    harness
        .next()
        .await
        .reply
        .send(Ok(json!({
            "sessionId": "discovery-only",
            "models": { "currentModelId": "default", "availableModels": [
                { "modelId": "default", "name": "Default" }, { "modelId": "second", "name": "Second" }
            ] }
        })))
        .unwrap();
    let selected = harness.next().await;
    assert_eq!(selected.method, "session/set_model");
    selected.reply.send(Ok(json!({}))).unwrap();
    let catalog = completed(&mut events).await;
    assert!(catalog.error.is_none(), "{:?}", catalog.error);
    assert_eq!(catalog.thought_levels.get("second"), Some(&Vec::new()));
}

#[tokio::test]
async fn catalog_replacement_removes_selected_metadata_for_models_no_longer_listed() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let catalogs = Arc::new(AgentCatalogs::default());
    let mut harness = Harness::new();
    let manager = make_manager(tmp.path(), catalogs.clone(), &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, false, Some("second")).unwrap();
    harness.next().await.reply.send(Ok(response(&["default", "second"], &["low"]))).unwrap();
    harness.next().await.reply.send(Ok(selected_response("second", &["max"]))).unwrap();
    completed(&mut events).await;
    advance(&catalogs, 30);
    manager.refresh_models(PROVIDER, true, None).unwrap();
    harness.next().await.reply.send(Ok(response(&["default", "new"], &["medium"]))).unwrap();
    let replaced = completed(&mut events).await;
    assert_eq!(model_values(&replaced), ["default", "new"]);
    assert_eq!(efforts(&replaced, "default"), ["medium"]);
    assert!(!replaced.thought_levels.contains_key("second") && !replaced.thought_levels.contains_key("new"));
}

#[tokio::test]
async fn selected_model_discovery_uses_the_negotiated_v2_wire_format_and_config_updates() {
    let tmp = tempfile::tempdir().unwrap();
    configure(tmp.path(), "one");
    let mut harness = Harness::with_initialize(json!({
        "protocolVersion": 2, "info": { "name": "V2 Catalog Test" }, "capabilities": { "session": {} }
    }));
    let manager = make_manager(tmp.path(), Arc::default(), &harness);
    let mut events = events(&manager);
    manager.refresh_models(PROVIDER, false, Some("second")).unwrap();
    let mut initial = response(&["default", "second"], &["low"]);
    for option in initial["configOptions"].as_array_mut().unwrap() {
        option["configId"] = option.as_object_mut().unwrap().remove("id").unwrap();
    }
    harness.next().await.reply.send(Ok(initial)).unwrap();
    let selected = harness.next().await;
    assert_eq!(selected.method, "session/set_config_option");
    assert_eq!(
        selected.params,
        json!({
            "sessionId": "discovery-only", "configId": "model", "value": "second", "type": "id"
        })
    );
    // Notifications may arrive before the request response as well as after it.
    selected.notifications.send(config_notification("discovery-only", &selected_response("second", &[]))).unwrap();
    selected.reply.send(Ok(json!({}))).unwrap();
    let catalog = completed(&mut events).await;
    assert!(catalog.thought_levels["second"].is_empty());
    assert_eq!(efforts(&catalog, "default"), ["low"]);
}
