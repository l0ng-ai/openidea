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

const DISCOVER_TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(3) } else { Duration::from_secs(120) };

/// Opens `session/new`, reads `configOptions`, and records the `thought_level` choices of the
/// session's model: they describe that model only, and other models may offer different ones.
pub(crate) async fn run(shared: &Arc<Shared>, spec: &ProviderSpec) -> Result<Discovered, String> {
    let prefer_stored = crate::provider::prefer_stored_copilot_auth();
    match run_once(shared, spec, prefer_stored).await {
        Err(err)
            if !prefer_stored
                && crate::provider::is_copilot_provider(&spec.id)
                && crate::provider::has_unconfigured_copilot_ambient_token(&spec.env)
                && super::auth_required(0, &err) =>
        {
            let retry = run_once(shared, spec, true).await;
            if retry.is_ok() {
                crate::provider::mark_prefer_stored_copilot_auth();
            }
            retry
        }
        other => other,
    }
}

async fn run_once(shared: &Arc<Shared>, spec: &ProviderSpec, strip_ambient: bool) -> Result<Discovered, String> {
    let root = shared.paths.project_root.clone();
    let launch = spec.clone();
    let launch = tokio::task::spawn_blocking({
        let root = root.clone();
        move || launch.resolve_for_launch_with_copilot_env(&root, strip_ambient)
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
        let model = options.iter().find(|o| o.category.as_deref() == Some("model")).and_then(|o| o.current.clone());
        let levels = match (model, levels_for_model_from_slice(&options)) {
            (Some(model), Some(effort)) => BTreeMap::from([(model, effort)]),
            _ => BTreeMap::new(),
        };
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

fn levels_for_model_from_slice(options: &[AgentConfigOption]) -> Option<Vec<AgentConfigOption>> {
    let levels: Vec<_> = options
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
        .collect();
    (!levels.is_empty()).then_some(levels)
}
