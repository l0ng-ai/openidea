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
    params: Value,
    reply: oneshot::Sender<Result<Value, String>>,
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
        let (pending_tx, pending) = mpsc::unbounded_channel();
        let launches = Arc::new(AtomicUsize::new(0));
        let live = Arc::new(AtomicUsize::new(0));
        let connector: Connector = Arc::new({
            let launches = launches.clone();
            let live = live.clone();
            move |_, _, client, _| {
                launches.fetch_add(1, Ordering::SeqCst);
                live.fetch_add(1, Ordering::SeqCst);
                let guard = Live(live.clone());
                let pending = pending_tx.clone();
                let (client_io, server_io) = tokio::io::duplex(1 << 16);
                let (read, mut write) = tokio::io::split(server_io);
                tokio::spawn(async move {
                    let _guard = guard;
                    let mut lines = BufReader::new(read).lines();
                    while let Some(line) = lines.next_line().await.unwrap() {
                        let request: Value = serde_json::from_str(&line).unwrap();
                        let id = &request["id"];
                        if id.is_null() {
                            continue;
                        }
                        let response = match request["method"].as_str().unwrap() {
                            "initialize" => json!({ "id": id, "jsonrpc": "2.0", "result": {
                                "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [] } }),
                            "session/new" => {
                                let (reply, result) = oneshot::channel();
                                pending.send(Pending { params: request["params"].clone(), reply }).unwrap();
                                let result = tokio::select! {
                                    result = result => result.unwrap(),
                                    _ = lines.next_line() => break,
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
    manager.shared.remember(PROVIDER, Some(&old), None, Some("old"));
    let cached = manager.refresh_models(PROVIDER, false).unwrap();
    assert!(cached.refreshing);
    assert_eq!(model_values(&cached), ["old", "retained"]);
    assert!(cached.refreshed_at_ms.is_none(), "session reports are not fresh discovery");
    let pending = harness.next().await;
    assert_eq!(pending.params["mcpServers"], json!([]));
    pending.reply.send(Ok(response(&["retained", "new"], &["medium"]))).unwrap();
    let fresh = completed(&mut events).await;
    assert_eq!(model_values(&fresh), ["retained", "new"]);
    assert_eq!(fresh.thought_levels.keys().map(String::as_str).collect::<Vec<_>>(), ["new", "retained"]);
    assert_eq!(fresh.thought_levels["retained"][0].values[0].value, "medium");
    assert!(fresh.refreshed_at_ms.is_some() && fresh.retry_at_ms.is_some());
    manager.shared.remember(PROVIDER, Some(&old), None, Some("old"));
    assert_eq!(manager.refresh_models(PROVIDER, false).unwrap().config, fresh.config);
    let provider = manager.providers().into_iter().find(|p| p.id == PROVIDER).unwrap();
    assert_eq!(provider.config, fresh.config);
    let persisted = std::fs::read_to_string(tmp.path().join("models.json")).unwrap();
    assert!(!persisted.contains("secret-one") && !persisted.contains("TOKEN"));
    let restored = make_manager(tmp.path(), Arc::default(), &harness);
    let restored_snapshot = restored.refresh_models(PROVIDER, false).unwrap();
    assert!(!restored_snapshot.refreshing, "matching persisted launch context remains fresh");
    assert_eq!(restored_snapshot.refreshed_at_ms, fresh.refreshed_at_ms);
    let provider = restored.providers().into_iter().find(|p| p.id == PROVIDER).unwrap();
    assert_eq!(provider.config, fresh.config);
    restored.shared.remember(PROVIDER, Some(&old), None, Some("old"));
    assert_eq!(restored.shared.known_config(PROVIDER), fresh.config);
    assert_eq!(restored.shared.known.lock()[PROVIDER].refreshed_at_ms, fresh.refreshed_at_ms);
    assert!(!tmp.path().join("store").exists(), "refresh never creates tasks");
}

#[tokio::test]
async fn legacy_cache_loads_without_claiming_authoritative_freshness() {
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
    let cached = manager.refresh_models(PROVIDER, false).unwrap();
    assert_eq!(model_values(&cached), ["legacy"]);
    assert!(cached.refreshing && cached.refreshed_at_ms.is_none());
    harness.next().await.reply.send(Err("Sign in required".into())).unwrap();
    let failed = completed(&mut events).await;
    assert_eq!(failed.config, cached.config);
    assert!(failed.error.as_deref().unwrap().contains("Sign in required"));
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
    assert!(first.refresh_models(PROVIDER, false).unwrap().refreshing);
    let pending = harness.next().await;
    for _ in 0..10 {
        assert!(second.refresh_models(PROVIDER, true).unwrap().refreshing);
        assert!(first.refresh_models(PROVIDER, true).unwrap().refreshing);
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
        assert!(!second.refresh_models(PROVIDER, force).unwrap().refreshing);
    }
    advance(&catalogs, 29);
    assert!(!first.refresh_models(PROVIDER, true).unwrap().refreshing);
    advance(&catalogs, 1);
    assert!(!first.refresh_models(PROVIDER, false).unwrap().refreshing, "automatic refresh remains fresh");
    assert!(first.refresh_models(PROVIDER, true).unwrap().refreshing);
    harness.next().await.reply.send(Ok(response(&["two"], &["high"]))).unwrap();
    let newer = completed(&mut first_events).await;
    assert_eq!(model_values(&newer), ["two"]);
    assert_eq!(completed(&mut second_events).await, newer);
    advance(&catalogs, 15 * 60 - 1);
    assert!(!second.refresh_models(PROVIDER, false).unwrap().refreshing);
    advance(&catalogs, 1);
    assert!(second.refresh_models(PROVIDER, false).unwrap().refreshing);
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
    manager.refresh_models(PROVIDER, true).unwrap();
    harness.next().await.reply.send(Ok(response(&["cached"], &["low"]))).unwrap();
    let success = completed(&mut events).await;
    let disk = std::fs::read(tmp.path().join("models.json")).unwrap();
    advance(&catalogs, 15 * 60);
    manager.refresh_models(PROVIDER, false).unwrap();
    harness.next().await.reply.send(Err("Authentication expired".into())).unwrap();
    let failed = completed(&mut events).await;
    assert_eq!(failed.config, success.config);
    assert_eq!(failed.thought_levels, success.thought_levels);
    assert_eq!(failed.refreshed_at_ms, success.refreshed_at_ms);
    assert!(failed.error.as_deref().unwrap().contains("Authentication expired"));
    assert_eq!(std::fs::read(tmp.path().join("models.json")).unwrap(), disk);
    assert!(!manager.refresh_models(PROVIDER, false).unwrap().refreshing);
    assert!(!manager.refresh_models(PROVIDER, true).unwrap().refreshing);
    advance(&catalogs, 29);
    assert!(!manager.refresh_models(PROVIDER, true).unwrap().refreshing);
    advance(&catalogs, 1);
    assert!(manager.refresh_models(PROVIDER, false).unwrap().refreshing);
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
    manager.refresh_models(PROVIDER, false).unwrap();
    let pending = harness.next().await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(4)).await;
    let failed = completed(&mut events).await;
    assert!(failed.error.as_deref().unwrap().contains("time"));
    assert!(failed.retry_at_ms.is_some());
    assert!(!manager.refresh_models(PROVIDER, true).unwrap().refreshing);
    assert!(!manager.refresh_models(PROVIDER, false).unwrap().refreshing);
    tokio::time::resume();
    stopped(&harness).await;
    assert_eq!(harness.live.load(Ordering::SeqCst), 0, "timed-out connection must close");
    assert!(pending.reply.is_closed());
    advance(&catalogs, 30);
    assert!(manager.refresh_models(PROVIDER, false).unwrap().refreshing);
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
    first.refresh_models(PROVIDER, false).unwrap();
    let obsolete = harness.next().await;
    configure(tmp.path(), "two");
    assert!(second.refresh_models(PROVIDER, false).unwrap().refreshing);
    let latest = harness.next().await;
    latest.reply.send(Ok(response(&["latest"], &["high"]))).unwrap();
    let fresh = completed(&mut events).await;
    let _ = obsolete.reply.send(Ok(response(&["obsolete"], &["low"])));
    stopped(&harness).await;
    let shown = first.refresh_models(PROVIDER, false).unwrap();
    assert_eq!(shown.config, fresh.config);
    assert_eq!(shown.refreshed_at_ms, fresh.refreshed_at_ms);
    assert!(!shown.refreshing);
    assert_eq!(harness.launches.load(Ordering::SeqCst), 2);
    assert!(!std::fs::read_to_string(tmp.path().join("models.json")).unwrap().contains("obsolete"));
    // A changed configuration also invalidates successful freshness/cooldown.
    configure(tmp.path(), "three");
    assert!(first.refresh_models(PROVIDER, false).unwrap().refreshing);
    harness.next().await.reply.send(Ok(response(&["new-config"], &["medium"]))).unwrap();
    completed(&mut events).await;
}

#[tokio::test]
async fn invalid_provider_is_a_request_error_and_does_not_launch() {
    let tmp = tempfile::tempdir().unwrap();
    let harness = Harness::new();
    let manager = make_manager(tmp.path(), Arc::default(), &harness);
    assert!(manager.refresh_models("missing-provider", true).is_err());
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
    manager.refresh_models(PROVIDER, false).unwrap();
    let obsolete = harness.next().await;
    std::fs::write(tmp.path().join("catalog-test-bin"), "replacement executable with different size").unwrap();
    manager.refresh_models(PROVIDER, false).unwrap();
    let latest = harness.next().await;
    latest.reply.send(Ok(response(&["updated"], &["high"]))).unwrap();
    let fresh = completed(&mut events).await;
    let _ = obsolete.reply.send(Ok(response(&["obsolete"], &["low"])));
    stopped(&harness).await;
    assert_eq!(manager.refresh_models(PROVIDER, false).unwrap().config, fresh.config);
    std::fs::write(tmp.path().join("catalog-test-bin"), "another executable").unwrap();
    assert!(manager.refresh_models(PROVIDER, false).unwrap().refreshing);
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
    first.refresh_models(PROVIDER, false).unwrap();
    harness.next().await.reply.send(Ok(response(&["account-a-model"], &["low"]))).unwrap();
    let a_catalog = completed(&mut first_events).await;
    second.refresh_models(PROVIDER, false).unwrap();
    harness.next().await.reply.send(Ok(response(&["account-b-model"], &["high"]))).unwrap();
    let b_catalog = completed(&mut second_events).await;
    assert_eq!(first.refresh_models(PROVIDER, false).unwrap().config, a_catalog.config);
    assert_eq!(second.refresh_models(PROVIDER, false).unwrap().config, b_catalog.config);
    assert_eq!(first.providers().into_iter().find(|p| p.id == PROVIDER).unwrap().config, a_catalog.config);
    for (root, expected) in [(&a, &a_catalog), (&b, &b_catalog)] {
        let restored = make_manager_at(root, &models_file, Arc::default(), &harness);
        let cached = restored.refresh_models(PROVIDER, false).unwrap();
        assert!(!cached.refreshing, "matching persisted context should retain freshness");
        assert_eq!(cached.config, expected.config);
        assert_eq!(cached.refreshed_at_ms, expected.refreshed_at_ms);
    }
    assert_eq!(harness.launches.load(Ordering::SeqCst), 2);
    configure(&a, "new-account");
    let changed = make_manager_at(&a, &models_file, Arc::default(), &harness);
    let mut events = events(&changed);
    let stale = changed.refresh_models(PROVIDER, false).unwrap();
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
    manager.refresh_models(PROVIDER, false).unwrap();
    let obsolete = harness.next().await;
    configure(tmp.path(), "after");
    obsolete.reply.send(Ok(response(&["obsolete"], &["low"]))).unwrap();
    let discarded = completed(&mut events).await;
    assert!(model_values(&discarded).is_empty());
    assert!(discarded.refreshed_at_ms.is_none());
    assert!(!tmp.path().join("models.json").exists());
    manager.refresh_models(PROVIDER, false).unwrap();
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
    manager.refresh_models(PROVIDER, true).unwrap();
    harness.next().await.reply.send(Ok(response(&["removed"], &["low"]))).unwrap();
    completed(&mut events).await;
    advance(&catalogs, 30);
    manager.refresh_models(PROVIDER, true).unwrap();
    harness.next().await.reply.send(Ok(response(&[], &[]))).unwrap();
    let empty = completed(&mut events).await;
    assert!(model_values(&empty).is_empty() && empty.thought_levels.is_empty());
    assert!(empty.refreshed_at_ms.is_some() && empty.error.is_none());
}
