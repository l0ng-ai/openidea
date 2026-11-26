//! User-facing task operations through the native shim, with a local app-server stand-in.
use super::*;
use crate::{AgentManager, AgentPrompt, AgentStatus, Isolation, NewAgentTask};

#[derive(Default)]
struct Runtime {
    models: Mutex<HashMap<String, String>>,
    hide_a: std::sync::atomic::AtomicBool,
    turns: Mutex<Vec<Value>>,
    tiers: Mutex<HashMap<String, Value>>,
    servers: Mutex<Vec<Peer>>,
}
struct Connection {
    runtime: Arc<Runtime>,
    peer: OnceLock<Peer>,
}
impl Handler for Connection {
    fn on_notification(&self, _: &str, _: Value) {}
    fn on_request(&self, method: &str, p: Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => Ok(json!({})),
            "model/list" => {
                let mut data = vec![json!({"id":"b", "model":"b", "serviceTiers":[]})];
                if !self.runtime.hide_a.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    data.insert(0, json!({"id":"a", "model":"a", "isDefault":true, "serviceTiers":[{"id":"fast"}]}));
                }
                Ok(json!({"data":data}))
            }
            "config/read" => Ok(json!({"layers":[]})),
            "skills/list" => Ok(json!({"data":[]})),
            "thread/start" | "thread/resume" => {
                let mut models = self.runtime.models.lock();
                let id = p["threadId"].as_str().map(str::to_owned).unwrap_or_else(|| format!("s{}", models.len()));
                let model = models.entry(id.clone()).or_insert_with(|| "a".into()).clone();
                Ok(json!({"thread":{"id":id,"name":"fixture","turns":[]}, "model":model,
                    "serviceTier":self.runtime.tiers.lock().get(&id).cloned().unwrap_or(json!("fast"))}))
            }
            "turn/start" => {
                let id = p["threadId"].as_str().unwrap();
                self.runtime.models.lock().insert(id.into(), p["model"].as_str().unwrap().into());
                if let Some(tier) = p.get("serviceTier") {
                    self.runtime.tiers.lock().insert(id.into(), tier.clone());
                }
                self.runtime.turns.lock().push(p.clone());
                self.peer
                    .get()
                    .unwrap()
                    .notify(
                        "turn/completed",
                        json!({"threadId":id,
                    "turn":{"id":"t","status":"completed"}}),
                    )
                    .unwrap();
                Ok(json!({"turn":{"id":"t"}}))
            }
            _ => Err((codes::METHOD_NOT_FOUND, method.into())),
        }
    }
}
fn manager(dir: &Path, runtime: Arc<Runtime>) -> AgentManager {
    let agents = dir.join("agents");
    crate::provider::set_builtin_command(&agents, None, "codex", Some("/missing/fixture-codex")).unwrap();
    AgentManager::with_connector(
        crate::AgentPaths {
            project_root: dir.into(),
            store_dir: dir.join("store"),
            worktrees_dir: dir.join("worktrees"),
            models_file: dir.join("models.json"),
            custom_agents_dir: Some(agents),
            home_dir: Some(dir.into()),
            env_secrets: None,
            catalogs: Arc::default(),
        },
        tokio::runtime::Handle::current(),
        Arc::new(move |spec, _, client, _| {
            assert_eq!(spec.driver, crate::provider::Driver::Codex);
            let handler = Arc::new(Connection { runtime: runtime.clone(), peer: OnceLock::new() });
            let (a, b) = tokio::io::duplex(1 << 20);
            let (r, w) = tokio::io::split(b);
            let server = Peer::connect_framed(r, w, handler.clone(), Framing::Lines);
            handler.peer.set(server.clone()).ok().unwrap();
            runtime.servers.lock().push(server);
            attach(client, |events| {
                let (r, w) = tokio::io::split(a);
                Ok(Peer::connect_framed(r, w, events, Framing::Lines))
            })
        }),
    )
}
fn prompt() -> AgentPrompt {
    AgentPrompt { text: "fixture".into(), ..Default::default() }
}
async fn ready(mgr: &AgentManager, id: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let task = mgr.task(id).unwrap();
            let (status, busy) = {
                let s = task.state.lock();
                (s.task.status, s.busy)
            };
            assert_ne!(status, AgentStatus::Failed);
            if status == AgentStatus::Ready && !busy {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
async fn send(mgr: &AgentManager, id: &str) {
    mgr.prompt(id, prompt(), false).await.unwrap();
    ready(mgr, id).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn explicit_tier_survives_standard_only_reconnect_before_immediate_prompt() {
    for late_model in [0, 1, 2, 3] {
        for choice in [Some("true"), Some("false"), None] {
            let tmp = tempfile::tempdir().unwrap();
            let runtime = Arc::new(Runtime::default());
            let mgr = manager(tmp.path(), runtime.clone());
            let task = mgr
                .create(NewAgentTask {
                    provider: "codex".into(),
                    prompt: prompt(),
                    isolation: Isolation::Local,
                    ..Default::default()
                })
                .await
                .unwrap();
            ready(&mgr, &task.id).await;
            let catalog_config = mgr.task(&task.id).unwrap().state.lock().task.config.clone();
            if let Some(value) = choice {
                mgr.set_config(&task.id, "service_tier", value.into()).await.unwrap();
            }
            send(&mgr, &task.id).await;
            assert_eq!(
                runtime.turns.lock().last().unwrap().get("serviceTier"),
                choice.map(|v| json!(if v == "true" { "fast" } else { "default" })).as_ref()
            );
            mgr.set_config(&task.id, "model", "b".into()).await.unwrap();
            assert!(!mgr.task(&task.id).unwrap().state.lock().task.config.iter().any(|o| o.id == "service_tier"));
            send(&mgr, &task.id).await;
            assert_eq!(
                runtime.turns.lock().last().unwrap().get("serviceTier"),
                choice.map(|_| json!("default")).as_ref()
            );
            mgr.shutdown();
            drop(mgr);
            runtime.hide_a.store(late_model >= 2, std::sync::atomic::Ordering::SeqCst);
            let mut mgr = manager(tmp.path(), runtime.clone());
            send(&mgr, &task.id).await; // Reconnect while still on Standard-only B.
            assert!(!mgr.task(&task.id).unwrap().state.lock().task.config.iter().any(|o| o.id == "service_tier"));
            assert_eq!(
                runtime.turns.lock().last().unwrap().get("serviceTier"),
                choice.map(|_| json!("default")).as_ref()
            );
            if late_model != 0 {
                // Catalog knows A, but the session's picker has not received it yet.
                let current = mgr.task(&task.id).unwrap();
                let mut s = current.state.lock();
                let catalog = serde_json::from_value(
                    json!({"fingerprint":"fixture", "schema":2, "config":catalog_config, "thoughtLevels":{"a":catalog_config.iter().filter(|o|crate::config::is_per_model_option(o)).collect::<Vec<_>>() }}),
                )
                .unwrap();
                mgr.shared
                    .known
                    .lock()
                    .entry("codex".into())
                    .or_default()
                    .catalogs
                    .insert(mgr.shared.root_key(), catalog);
                s.task.config.iter_mut().find(|o| o.id == "model").unwrap().values.retain(|v| v.value != "a");
            }
            mgr.set_config(&task.id, "model", "a".into()).await.unwrap();
            if late_model == 3 {
                // An older saved pending switch has no retained intent field.
                mgr.task(&task.id).unwrap().state.lock().pending_model.as_mut().unwrap().retained_service_tier = None;
                mgr.shutdown();
                mgr = manager(tmp.path(), runtime.clone());
            }
            let displayed = mgr
                .task(&task.id)
                .unwrap()
                .state
                .lock()
                .snapshot()
                .config
                .iter()
                .find(|o| o.id == "service_tier")
                .unwrap()
                .current
                .clone();
            assert_eq!(displayed.as_deref(), Some(choice.unwrap_or("true")));
            send(&mgr, &task.id).await; // No sleeps/retries between selecting A and submitting.
            assert_eq!(
                runtime.turns.lock().last().unwrap().get("serviceTier"),
                choice.map(|v| json!(if v == "true" { "fast" } else { "default" })).as_ref()
            );
            let other = mgr
                .create(NewAgentTask {
                    provider: "codex".into(),
                    prompt: prompt(),
                    isolation: Isolation::Local,
                    ..Default::default()
                })
                .await
                .unwrap();
            ready(&mgr, &other.id).await;
            assert!(
                runtime.turns.lock().last().unwrap().get("serviceTier").is_none(),
                "choices must not leak to another task"
            );
            mgr.shutdown();
        }
    }
}
