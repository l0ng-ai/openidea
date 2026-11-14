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
use std::sync::Arc;
use std::time::Duration;

const DISCOVER_TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(3) } else { Duration::from_secs(120) };

/// Opens `session/new`, reads `configOptions`, and records per-model `thought_level` choices.
pub(crate) async fn run(shared: &Arc<Shared>, spec: &ProviderSpec) -> Result<Discovered, String> {
    let root = shared.paths.project_root.clone();
    let launch = spec.clone();
    let launch = tokio::task::spawn_blocking({
        let root = root.clone();
        move || launch.resolve_for_launch(&root)
    })
    .await
    .map_err(|e| e.to_string())?;
    let cwd = dunce::canonicalize(&root).unwrap_or(root);
    let updates = Arc::new(DiscoveryUpdates { provider: spec.id.clone(), commands: Mutex::new(None) });
    let client = Dialect::wrap(updates.clone());
    let on_stderr: Box<dyn Fn(String) + Send + Sync> = Box::new(|_| {});
    let peer = (shared.connector)(&launch, &cwd, client.clone(), on_stderr)
        .map_err(|e| format!("Couldn't start {} (`{}`): {e}", launch.name, launch.command))?;
    let _stop = crate::catalogs::KillPeer(peer.clone());
    let conn = Conn::new(peer.clone(), client);
    let work = async {
        conn.initialize(&client_info()).await.map_err(|e| e.to_string())?;
        let cwd_s = cwd.to_string_lossy().into_owned();
        // No project MCP during discovery: Cursor can spend a long time spawning servers.
        let new: Value = conn
            .request("session/new", json!({ "cwd": cwd_s, "mcpServers": [] }), None)
            .await
            .map_err(|e| e.to_string())?;
        let mut options = config::options_of(&new);
        config::add_client_options(&launch.id, &mut options);
        let model_option = options.iter().find(|o| o.category.as_deref() == Some("model"));
        let effort = levels_for_model_from_slice(&options);
        let levels: Vec<(String, Vec<AgentConfigOption>)> = match (model_option, effort) {
            (Some(model), Some(effort)) if !model.values.is_empty() => {
                model.values.iter().map(|v| (v.value.clone(), effort.clone())).collect()
            }
            (Some(model), Some(effort)) => model.current.clone().map(|m| vec![(m, effort)]).unwrap_or_default(),
            _ => Vec::new(),
        };
        let commands = updates
            .commands
            .lock()
            .clone()
            .or_else(|| new.get("availableCommands").map(|_| config::commands_of(&new, &launch.id)));
        Ok::<_, String>(Discovered { config: options, commands, levels: levels.into_iter().collect() })
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
}

impl ide_jsonrpc::Handler for DiscoveryUpdates {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/update"
            && let Some(update) = params.get("update")
            && update["sessionUpdate"] == "available_commands_update"
        {
            // Commands are protocol data, not stderr (which may contain credentials).
            *self.commands.lock() = Some(config::commands_of(update, &self.provider));
        }
    }

    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, format!("unsupported discovery request {method}")))
    }
}

fn is_thought_level(o: &AgentConfigOption) -> bool {
    o.category.as_deref() == Some("thought_level")
        || matches!(o.id.as_str(), "effort" | "reasoning_effort" | "thinking" | "reasoning")
}

fn levels_for_model_from_slice(options: &[AgentConfigOption]) -> Option<Vec<AgentConfigOption>> {
    let levels: Vec<_> = options
        .iter()
        .filter(|o| is_thought_level(o))
        .cloned()
        .map(|mut o| {
            if o.category.as_deref() != Some("thought_level") {
                o.category = Some("thought_level".into());
            }
            o
        })
        .collect();
    (!levels.is_empty()).then_some(levels)
}
