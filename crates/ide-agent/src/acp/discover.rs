//! A short-lived ACP session to learn models, effort levels and other config options
//! before the user's first task (Cursor and other ACP agents do not expose these in
//! `initialize` alone).

use super::{Conn, Dialect};
use crate::catalogs::Discovered;
use crate::config;
use crate::model::AgentConfigOption;
use crate::provider::ProviderSpec;
use crate::{Shared, client_info};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

const CONFIG_UPDATE_TIMEOUT: Duration = if cfg!(test) { Duration::from_millis(100) } else { Duration::from_secs(5) };
const DISCOVER_TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(3) } else { Duration::from_secs(120) };

/// Opens `session/new`, reads `configOptions`, and records the `thought_level` choices of the
/// session's model: they describe that model only, and other models may offer different ones.
pub(crate) async fn run(shared: &Arc<Shared>, spec: &ProviderSpec, model: Option<&str>) -> Result<Discovered, String> {
    let prefer_stored = crate::provider::prefer_stored_copilot_auth();
    match run_once(shared, spec, prefer_stored, model).await {
        Err(err)
            if !prefer_stored
                && crate::provider::is_copilot_provider(&spec.id)
                && crate::provider::has_unconfigured_copilot_ambient_token(&spec.env)
                && super::auth_required(0, &err) =>
        {
            let retry = run_once(shared, spec, true, model).await;
            if retry.is_ok() {
                crate::provider::mark_prefer_stored_copilot_auth();
            }
            retry
        }
        other => other,
    }
}

async fn run_once(
    shared: &Arc<Shared>,
    spec: &ProviderSpec,
    strip_ambient: bool,
    selected_model: Option<&str>,
) -> Result<Discovered, String> {
    let root = shared.paths.project_root.clone();
    let launch = spec.clone();
    let launch = tokio::task::spawn_blocking({
        let root = root.clone();
        move || launch.resolve_for_launch_with_copilot_env(&root, strip_ambient)
    })
    .await
    .map_err(|e| e.to_string())?;
    let cwd = dunce::canonicalize(&root).unwrap_or(root);
    let updates = Arc::new(DiscoveryUpdates { provider: spec.id.clone(), ..Default::default() });
    let client = Dialect::wrap(updates.clone());
    let on_stderr: Box<dyn Fn(String) + Send + Sync> = Box::new(|_| {});
    let peer = (shared.connector)(&launch, &cwd, client.clone(), on_stderr)
        .map_err(|e| format!("Couldn't start {} for model discovery: {e}", launch.name))?;
    let _stop = crate::catalogs::KillPeer(peer.clone());
    let conn = Conn::new(peer.clone(), client);
    let work = async {
        conn.initialize(&client_info()).await.map_err(discovery_error)?;
        let cwd_s = cwd.to_string_lossy().into_owned();
        // No project MCP during discovery: Cursor can spend a long time spawning servers.
        let new: Value = conn
            .request("session/new", json!({ "cwd": cwd_s, "mcpServers": [] }), None)
            .await
            .map_err(discovery_error)?;
        let mut options = config::options_of(&new);
        config::add_client_options(&launch.id, &mut options);
        let model_option = options.iter().find(|o| o.category.as_deref() == Some("model"));
        let mut levels = BTreeMap::new();
        let has_config = new.get("configOptions").is_some_and(Value::is_array);
        if has_config && let Some(model) = model_option.and_then(|o| o.current.as_ref()) {
            levels.insert(model.clone(), levels_for_model_from_slice(&options));
        }
        if let Some(selected) = selected_model
            && let Some(option) = model_option.filter(|o| o.values.iter().any(|v| v.value == selected))
            && !levels.contains_key(selected)
        {
            let session =
                new.get("sessionId").and_then(Value::as_str).ok_or("The agent did not return a session ID")?;
            let (method, mut params) = config::set_request(option, selected);
            params["sessionId"] = json!(session);
            updates.config.lock().session = Some(session.to_owned());
            let response: Value = conn.request(method, params, None).await.map_err(discovery_error)?;
            let settings = if let Some(settings) = selected_settings(&response, selected) {
                Some(settings)
            } else {
                tokio::time::timeout(CONFIG_UPDATE_TIMEOUT, async {
                    loop {
                        let notified = updates.changed.notified();
                        if let Some(settings) = updates
                            .config
                            .lock()
                            .options
                            .as_ref()
                            .and_then(|options| selected_settings(options, selected))
                        {
                            return settings;
                        }
                        notified.await;
                    }
                })
                .await
                .ok()
            };
            match settings {
                Some(settings) => levels.insert(selected.to_owned(), levels_for_model_from_slice(&settings)),
                // An agent on the legacy `models` field that says nothing more: the model has
                // no settings of its own, and switching to it must not fail.
                None if !has_config => levels.insert(selected.to_owned(), Vec::new()),
                None => return Err("The agent did not report settings for the selected model".to_owned()),
            };
        }
        let commands = updates
            .commands
            .lock()
            .clone()
            .or_else(|| new.get("availableCommands").map(|_| config::commands_of(&new, &launch.id)));
        Ok::<_, String>(Discovered { config: options, commands, levels })
    };
    let result = tokio::time::timeout(DISCOVER_TIMEOUT, work).await;
    peer.kill();
    match result {
        Ok(result) => result,
        Err(_) => Err("the agent did not answer in time".into()),
    }
}

#[derive(Default)]
struct DiscoveryUpdates {
    provider: String,
    commands: Mutex<Option<Vec<crate::AgentCommand>>>,
    config: Mutex<DiscoveryConfig>,
    changed: tokio::sync::Notify,
}

#[derive(Default)]
struct DiscoveryConfig {
    session: Option<String>,
    options: Option<Value>,
}

impl ide_jsonrpc::Handler for DiscoveryUpdates {
    fn on_notification(&self, method: &str, params: Value) {
        if method != "session/update" {
            return;
        }
        let Some(update) = params.get("update") else { return };
        match update["sessionUpdate"].as_str() {
            Some("available_commands_update") => {
                // Commands are protocol data, not stderr (which may contain credentials).
                *self.commands.lock() = Some(config::commands_of(update, &self.provider));
            }
            Some("config_option_update") => {
                let mut config = self.config.lock();
                if config.session.as_deref() == params.get("sessionId").and_then(Value::as_str)
                    && config.session.is_some()
                    && update.get("configOptions").is_some_and(Value::is_array)
                {
                    config.options = Some(update.clone());
                    self.changed.notify_one();
                }
            }
            _ => {}
        }
    }

    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, format!("unsupported discovery request {method}")))
    }
}

fn discovery_error(error: ide_jsonrpc::RpcError) -> String {
    match error {
        ide_jsonrpc::RpcError::Server { code, message, .. } if super::auth_required(code, &message) => {
            "Sign in required: the agent could not authenticate model discovery".into()
        }
        other => format!("The agent could not complete model discovery: {other}"),
    }
}

fn selected_settings(response: &Value, model: &str) -> Option<Vec<AgentConfigOption>> {
    response.get("configOptions")?.as_array()?;
    let options = config::options_of(response);
    let current = options.iter().find(|o| o.category.as_deref() == Some("model")).and_then(|o| o.current.as_deref());
    current.is_none_or(|current| current == model).then_some(options)
}

fn levels_for_model_from_slice(options: &[AgentConfigOption]) -> Vec<AgentConfigOption> {
    options
        .iter()
        .filter(|o| config::is_per_model_option(o))
        .cloned()
        .map(|mut o| {
            if config::is_context_option(&o.id) {
                if o.category.is_none() {
                    o.category = Some("model_config".into());
                }
            } else if o.category.as_deref() != Some("thought_level") {
                o.category = Some("thought_level".into());
            }
            o
        })
        .collect()
}
