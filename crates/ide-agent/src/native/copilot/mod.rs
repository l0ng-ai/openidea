//! GitHub Copilot CLI driven natively over `copilot --headless --no-auto-update --stdio`
//! (`Content-Length`-framed JSON-RPC 2.0, the protocol `@github/copilot-sdk` speaks),
//! behind an in-process ACP endpoint (`Shim`), with automatic fallback to `copilot --acp`
//! whenever the headless protocol is unavailable or incompatible.
//!
//! Driving the headless SDK server unlocks:
//! - Full model catalog discovery (`models.list` + `models.listTokenPriceUnits`), exposing
//!   each model's supported reasoning efforts, tiered context windows (`200K` vs `1M`),
//!   and per-tier token pricing (`Input`, `Output`, `Cache Read`, `Cache Write`);
//! - Per-session `contextTier` (`"default"` | `"long_context"`) on `session.create`,
//!   `session.resume`, and live mid-session `session.model.switchTo`, using Copilot's own
//!   configured defaults (`user.settings.get` / CLI flags, or `"medium"` + `"default"`);
//! - Mid-turn steering (`session.send` with `mode: "immediate"`).

mod models;
mod translate;

#[cfg(test)]
mod tests;

use super::Shim;
use crate::BACKGROUND_TASKS_UPDATE;
use crate::acp::AUTH_REQUIRED;
use crate::provider::ProviderSpec;
use ide_jsonrpc::{Framing, Handler, Peer, RpcError, codes};
use models::{ALLOW_ALL, CONTEXT_TIER, EFFORT, MODE, MODEL, Mode, ModelEntry, Settings, UserDefaults};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use translate::{EventTranslator, TurnTerminal};

const DISCOVER_TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(5) } else { Duration::from_secs(30) };
const EARLY_CANCEL: Duration = Duration::from_secs(2);
const EXIT_GRACE: Duration = Duration::from_millis(100);

/// Pre-session discovery result for `Shared::fetch_settings`.
pub(crate) struct Discovered {
    pub commands: Vec<Value>,
    pub options: Value,
    /// `(model_id, vec_of_per_model_config_options)` for every model in the catalog.
    pub per_model: Vec<(String, Vec<Value>)>,
}

#[derive(Clone, Debug)]
pub(crate) struct DiscoverError {
    pub message: String,
    pub allow_acp_fallback: bool,
}

pub(crate) fn connect(
    spec: &ProviderSpec,
    cwd: &Path,
    client: Arc<dyn Handler>,
    on_stderr: Box<dyn Fn(String) + Send + Sync>,
) -> std::io::Result<Peer> {
    let launch_args = spec.args.clone();
    attach_with_args(client, launch_args, |events| {
        let command = super::newest_install(&spec.command);
        let args = headless_args(&spec.args);
        Peer::spawn_framed(&command, &args, cwd, &spec.env, events, on_stderr, Framing::ContentLength)
    })
}

/// Ensures `--headless --no-auto-update --stdio` are passed even if an older agent file
/// listed `--acp` or omitted flags.
pub(crate) fn headless_args(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = raw.iter().filter(|a| a.as_str() != "--acp").cloned().collect();
    if !out.iter().any(|a| a == "--headless" || a == "--server") {
        out.push("--headless".into());
    }
    if !out.iter().any(|a| a == "--no-auto-update") {
        out.push("--no-auto-update".into());
    }
    if !out.iter().any(|a| a == "--stdio") {
        out.push("--stdio".into());
    }
    out
}

/// Builds `copilot --acp` arguments from `raw`, stripping headless-only flags while
/// preserving any user-configured flags (such as `--context` or `--allow-all`).
pub(crate) fn acp_args(raw: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(raw.len() + 1);
    out.push("--acp".into());
    for arg in raw {
        if matches!(arg.as_str(), "--acp" | "--headless" | "--server" | "--no-auto-update" | "--stdio") {
            continue;
        }
        out.push(arg.clone());
    }
    out
}

/// Converts a `Driver::Copilot` provider spec into its `Driver::Acp` (`--acp`) fallback.
pub(crate) fn acp_fallback_spec(spec: &ProviderSpec) -> ProviderSpec {
    let mut fallback = spec.clone();
    fallback.driver = crate::provider::Driver::Acp;
    fallback.args = acp_args(&spec.args);
    fallback
}

/// True when `err` indicates the executable itself is missing or non-executable (so
/// spawning `--acp` with the same command cannot succeed either).
pub(crate) fn is_missing_binary_error(err: &std::io::Error) -> bool {
    matches!(err.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied)
}

/// Discovers Copilot's full model catalog (with per-model effort levels, `200K`/`1M`
/// context tiers, and token pricing) plus slash commands and skills without opening a chat session.
pub(crate) async fn discover(spec: ProviderSpec, cwd: PathBuf) -> Result<Discovered, DiscoverError> {
    tokio::time::timeout(DISCOVER_TIMEOUT, async move {
        let prefer_stored = crate::provider::prefer_stored_copilot_auth();
        let has_ambient = crate::provider::has_unconfigured_copilot_ambient_token(&spec.env);
        match discover_once(spec.clone(), cwd.clone(), prefer_stored).await {
            Err(err)
                if !prefer_stored
                    && has_ambient
                    && !err.allow_acp_fallback
                    && crate::acp::auth_required(0, &err.message) =>
            {
                let retry = discover_once(spec, cwd, true).await;
                if retry.is_ok() {
                    crate::provider::mark_prefer_stored_copilot_auth();
                }
                retry
            }
            other => other,
        }
    })
    .await
    .map_err(|_| DiscoverError {
        message: "Copilot settings discovery timed out".to_owned(),
        allow_acp_fallback: true,
    })?
}

async fn discover_once(spec: ProviderSpec, cwd: PathBuf, strip_ambient: bool) -> Result<Discovered, DiscoverError> {
    let launch = tokio::task::spawn_blocking({
        let cwd = cwd.clone();
        move || spec.resolve_for_launch_with_copilot_env(&cwd, strip_ambient)
    })
    .await
    .map_err(|e| DiscoverError { message: e.to_string(), allow_acp_fallback: false })?
    .map_err(|e| DiscoverError { message: e, allow_acp_fallback: false })?;
    let cwd = dunce::canonicalize(&cwd).unwrap_or(cwd);
    let args = headless_args(&launch.args);
    let peer = Peer::spawn_framed(
        &launch.command,
        &args,
        &cwd,
        &launch.env,
        Arc::new(ide_jsonrpc::NoopHandler),
        Box::new(|_| {}),
        Framing::ContentLength,
    )
    .map_err(|e| DiscoverError {
        message: format!("Couldn't start {} (`{}`): {e}", launch.name, launch.command),
        allow_acp_fallback: !is_missing_binary_error(&e),
    })?;
    let user_args = launch.args.clone();
    let work = async {
        handshake(&peer).await?;
        let catalog = fetch_catalog(&peer).await?;
        let defaults = fetch_user_defaults(&peer, &user_args).await;
        let cwd_s = cwd.to_string_lossy().into_owned();
        let cmds_res: Option<Value> = peer.request("commands.list", json!({}), None).await.ok();
        let skills_res: Option<Value> =
            peer.request("skills.discover", json!({ "projectPaths": [cwd_s] }), None).await.ok();
        let settings = Settings::new(&catalog, &defaults);
        Ok::<Discovered, ResponseError>(Discovered {
            commands: translate::available_commands(cmds_res.as_ref(), skills_res.as_ref()),
            options: models::config_options(&catalog, &settings),
            per_model: models::per_model_options(&catalog, &defaults),
        })
    };
    let res = work.await.map_err(|e| DiscoverError {
        allow_acp_fallback: e.code != AUTH_REQUIRED && !crate::acp::auth_required(e.code, &e.message),
        message: e.message,
    });
    peer.kill();
    res
}

#[cfg(test)]
pub(super) fn attach(
    client: Arc<dyn Handler>,
    connect_copilot: impl FnOnce(Arc<dyn Handler>) -> std::io::Result<Peer>,
) -> std::io::Result<Peer> {
    attach_with_args(client, Vec::new(), connect_copilot)
}

pub(super) fn attach_with_args(
    client: Arc<dyn Handler>,
    args: Vec<String>,
    connect_copilot: impl FnOnce(Arc<dyn Handler>) -> std::io::Result<Peer>,
) -> std::io::Result<Peer> {
    let runtime = tokio::runtime::Handle::current();
    let shim = Arc::new_cyclic(|me| CopilotShim {
        me: me.clone(),
        runtime,
        args,
        copilot: OnceLock::new(),
        client: OnceLock::new(),
        state: Mutex::new(State::default()),
        catalog: tokio::sync::Mutex::new(None),
    });
    let copilot = connect_copilot(Arc::new(CopilotEvents(Arc::downgrade(&shim))))?;
    let _ = shim.copilot.set(copilot.clone());
    let ours = super::serve(shim.clone(), client);
    let to_client = shim.client.get().cloned().expect("serve attaches the client");
    {
        let (shim, copilot, to_client) = (shim.clone(), copilot.clone(), to_client.clone());
        tokio::spawn(async move {
            copilot.closed().await;
            shim.copilot_gone();
            tokio::time::sleep(EXIT_GRACE).await;
            to_client.kill();
        });
    }
    tokio::spawn(async move {
        to_client.closed().await;
        copilot.kill();
    });
    Ok(ours)
}

async fn handshake(peer: &Peer) -> Result<Option<String>, ResponseError> {
    let params = json!({
        "supportedTaskKinds": ["agent", "client", "shell"],
        "clientInfo": {
            "editorName": "OpenIDEA",
            "editorVersion": env!("CARGO_PKG_VERSION"),
        },
    });
    match peer.request::<_, Value>("connect", params, None).await {
        Ok(res) => Ok(res.get("version").and_then(Value::as_str).map(str::to_owned)),
        Err(RpcError::Server { code, .. }) if code == codes::METHOD_NOT_FOUND => {
            let res: Value = peer.request("ping", json!({}), None).await.map_err(from_copilot)?;
            Ok(res.get("version").and_then(Value::as_str).map(str::to_owned))
        }
        Err(e) => Err(from_copilot(e)),
    }
}

async fn fetch_catalog(peer: &Peer) -> Result<Vec<ModelEntry>, ResponseError> {
    let list: Value = peer.request("models.list", json!({}), None).await.map_err(from_copilot)?;
    let units: Option<Value> = peer.request("models.listTokenPriceUnits", json!({}), None).await.ok();
    let entries = models::parse_catalog(&list, units.as_ref());
    if entries.is_empty() {
        // Unauthenticated check via `auth.getStatus` so sign-in prompts trigger cleanly;
        // otherwise treat an empty/unparseable catalog as a protocol mismatch so `--acp`
        // fallback can take over.
        match peer.request::<_, Value>("auth.getStatus", json!({}), None).await {
            Ok(auth) if auth.get("isAuthenticated").and_then(Value::as_bool) == Some(false) => {
                return Err(error(AUTH_REQUIRED, "Authentication required"));
            }
            Err(e) => {
                let err = from_copilot(e);
                if err.code == AUTH_REQUIRED {
                    return Err(err);
                }
            }
            _ => {}
        }
        return Err(error(codes::INTERNAL_ERROR, "Copilot returned an empty model catalog"));
    }
    Ok(entries)
}

async fn fetch_user_defaults(peer: &Peer, args: &[String]) -> UserDefaults {
    let res: Option<Value> = peer.request("user.settings.get", json!({}), None).await.ok();
    UserDefaults::from_rpc_and_args(res.as_ref(), args)
}

struct CopilotShim {
    me: Weak<CopilotShim>,
    runtime: tokio::runtime::Handle,
    args: Vec<String>,
    copilot: OnceLock<Peer>,
    client: OnceLock<Peer>,
    state: Mutex<State>,
    catalog: tokio::sync::Mutex<Option<Arc<Vec<ModelEntry>>>>,
}

#[derive(Default)]
struct State {
    sessions: HashMap<String, SessionEntry>,
    gone: bool,
}

struct SessionEntry {
    settings: Settings,
    translator: EventTranslator,
    prompt: Option<oneshot::Sender<TurnTerminal>>,
    early_cancel: Option<Instant>,
    temp_files: Vec<PathBuf>,
    /// Copilot's main agent loop is processing. It goes idle (`assistant.idle`) before the
    /// turn ends (`session.idle`) while background shells or agents it started still run.
    main_busy: bool,
    /// Counts `session.tasks.list` requests, so only the latest answer is reported.
    tasks_seq: u64,
}

impl SessionEntry {
    fn new(settings: Settings) -> Self {
        Self {
            settings,
            translator: EventTranslator::default(),
            prompt: None,
            early_cancel: None,
            temp_files: Vec::new(),
            main_busy: false,
            tasks_seq: 0,
        }
    }
}

struct CopilotEvents(Weak<CopilotShim>);

impl Handler for CopilotEvents {
    fn on_notification(&self, method: &str, params: Value) {
        if let Some(shim) = self.0.upgrade() {
            shim.on_copilot_notification(method, &params);
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let shim = self.0.upgrade().ok_or((codes::INTERNAL_ERROR, "closed".to_owned()))?;
        shim.on_copilot_request(method, &params)
    }
}

impl Shim for CopilotShim {
    fn attach(&self, client: Peer) {
        let _ = self.client.set(client);
    }
}

impl Handler for CopilotShim {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/cancel"
            && let Some(session) = params.get("sessionId").and_then(Value::as_str)
        {
            self.cancel(session);
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        self.on_request_with_data(method, params).map_err(|(code, message, _)| (code, message))
    }

    fn on_request_with_data(&self, method: &str, params: Value) -> Result<Value, (i64, String, Option<Value>)> {
        let Some(me) = self.me.upgrade() else {
            return Err((codes::INTERNAL_ERROR, "closed".to_owned(), None));
        };
        self.runtime.block_on(me.handle(method, params)).map_err(|e| (e.code, e.message, e.data))
    }
}

#[derive(Debug)]
struct ResponseError {
    code: i64,
    message: String,
    data: Option<Value>,
}

fn error(code: i64, message: impl Into<String>) -> ResponseError {
    ResponseError { code, message: message.into(), data: None }
}

/// Adds the session's staged skills to a `session.create`/`session.resume` request:
/// `skillDirectories` (the farm's `copilot` tree) and `disabledSkills` (the off and
/// slash-only ones; Copilot invokes skills with the model only, so a slash-only skill has
/// no other switch here).
fn apply_skills(params: &Value, req: &mut Value) {
    let skills = params.pointer("/_meta/openidea/skills");
    if let Some(dirs) = skills.and_then(|s| s.get("copilotSkillDirectories")).and_then(Value::as_array)
        && !dirs.is_empty()
    {
        req["skillDirectories"] = json!(dirs.iter().filter_map(Value::as_str).collect::<Vec<_>>());
    }
    if let Some(disabled) = skills.and_then(|s| s.get("copilotDisabledSkills")).and_then(Value::as_array)
        && !disabled.is_empty()
    {
        req["disabledSkills"] = json!(disabled.iter().filter_map(Value::as_str).collect::<Vec<_>>());
    }
}

fn invalid(message: impl Into<String>) -> ResponseError {
    error(codes::INVALID_PARAMS, message)
}

fn from_copilot(e: RpcError) -> ResponseError {
    match e {
        RpcError::Server { code, message, data } => {
            let protocol = matches!(
                code,
                codes::PARSE_ERROR | codes::INVALID_REQUEST | codes::METHOD_NOT_FOUND | codes::INVALID_PARAMS
            );
            let code = if !protocol && crate::acp::auth_required(code, &message) { AUTH_REQUIRED } else { code };
            ResponseError { code, message, data }
        }
        RpcError::Closed => error(codes::INTERNAL_ERROR, "GitHub Copilot exited"),
        e => error(codes::INTERNAL_ERROR, e.to_string()),
    }
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, ResponseError> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| invalid(format!("missing {key}")))
}

impl CopilotShim {
    fn copilot(&self) -> &Peer {
        self.copilot.get().expect("attached before any message")
    }

    fn to_client(&self) -> &Peer {
        self.client.get().expect("attached before any message")
    }

    fn send_update(&self, session_id: &str, update: Value) {
        let _ = self.to_client().notify("session/update", json!({ "sessionId": session_id, "update": update }));
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, ResponseError> {
        self.copilot().request(method, params, None).await.map_err(from_copilot)
    }

    async fn models(&self) -> Result<Arc<Vec<ModelEntry>>, ResponseError> {
        let mut guard = self.catalog.lock().await;
        if let Some(cached) = guard.as_ref() {
            return Ok(cached.clone());
        }
        let fetched = Arc::new(fetch_catalog(self.copilot()).await?);
        if !fetched.is_empty() {
            *guard = Some(fetched.clone());
        }
        Ok(fetched)
    }

    async fn handle(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, ResponseError> {
        match method {
            "initialize" => self.initialize().await,
            "session/new" => self.new_session(&params).await,
            "session/load" => self.load_session(&params).await,
            "session/set_config_option" => self.set_config(&params).await,
            "session/prompt" => self.prompt(&params, false).await,
            "_openidea/steer" => self.prompt(&params, true).await,
            "_openidea/stop_task" => self.stop_task(&params).await,
            "session/close" => self.close_session(&params).await,
            _ => Err(error(codes::METHOD_NOT_FOUND, format!("unsupported method {method}"))),
        }
    }

    async fn initialize(&self) -> Result<Value, ResponseError> {
        let version = handshake(self.copilot()).await?;
        Ok(json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
                "mcpCapabilities": { "http": true, "sse": true, "stdio": true },
                "sessionCapabilities": { "close": {}, "list": {} },
                "_meta": { "openidea": { "steer": true, "backgroundTasks": true } },
            },
            "agentInfo": {
                "name": "copilot",
                "title": "GitHub Copilot",
                "version": version,
            },
            "authMethods": [{
                "id": "copilot-login",
                "name": "Log in with Copilot CLI",
                "description": "Run `copilot login` in the terminal",
                "type": "terminal",
                "args": ["login"],
            }],
        }))
    }

    async fn new_session(self: &Arc<Self>, params: &Value) -> Result<Value, ResponseError> {
        let cwd = str_param(params, "cwd")?;
        let catalog = self.models().await?;
        let defaults = fetch_user_defaults(self.copilot(), &self.args).await;
        let settings = Settings::new(&catalog, &defaults);

        let mut req = json!({
            "workingDirectory": cwd,
            "trustWorkingDirectory": "session",
            "clientName": "openidea",
            "streaming": true,
            "includeSubAgentStreamingEvents": true,
            "requestPermission": true,
            "requestUserInput": true,
            "requestExitPlanMode": true,
            "envValueMode": "direct",
        });
        if !settings.model.is_empty() {
            req["model"] = json!(settings.model);
        }
        if let Some(effort) = &settings.effort {
            req["reasoningEffort"] = json!(effort);
        }
        if let Some(tier) = &settings.context_tier {
            req["contextTier"] = json!(tier);
        }
        if let Some(mcp) = translate::wire_mcp_servers(params.get("mcpServers")) {
            req["mcpServers"] = mcp;
        }
        if let Some(disabled) = translate::wire_disabled_mcp_servers(params) {
            req["disabledMcpServers"] = disabled;
        }
        apply_skills(params, &mut req);

        let created = self.call("session.create", req).await?;
        let session_id = created
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| error(codes::INTERNAL_ERROR, "Copilot returned no sessionId"))?
            .to_owned();
        if settings.mode != Mode::Agent {
            let _ =
                self.call("session.mode.set", json!({ "sessionId": session_id, "mode": settings.mode.wire() })).await;
        }
        if settings.allow_all {
            let _ = self
                .call("session.permissions.setApproveAll", json!({ "sessionId": session_id, "enabled": true }))
                .await;
        }

        let options = models::config_options(&catalog, &settings);
        self.state.lock().sessions.insert(session_id.clone(), SessionEntry::new(settings));
        self.publish_commands(&session_id, cwd);
        Ok(json!({
            "sessionId": session_id,
            "configOptions": options,
        }))
    }

    async fn load_session(self: &Arc<Self>, params: &Value) -> Result<Value, ResponseError> {
        let session_id = str_param(params, "sessionId")?.to_owned();
        let cwd = str_param(params, "cwd")?;
        let catalog = self.models().await?;
        let defaults = fetch_user_defaults(self.copilot(), &self.args).await;
        let mut settings = Settings::new(&catalog, &defaults);

        let mut req = json!({
            "sessionId": session_id,
            "workingDirectory": cwd,
            "clientName": "openidea",
            "streaming": true,
            "includeSubAgentStreamingEvents": true,
            "requestPermission": true,
            "requestUserInput": true,
            "requestExitPlanMode": true,
            "envValueMode": "direct",
        });
        if let Some(mcp) = translate::wire_mcp_servers(params.get("mcpServers")) {
            req["mcpServers"] = mcp;
        }
        if let Some(disabled) = translate::wire_disabled_mcp_servers(params) {
            req["disabledMcpServers"] = disabled;
        }
        apply_skills(params, &mut req);

        let resumed = self.call("session.resume", req).await?;
        if let Ok(current) = self.call("session.model.getCurrent", json!({ "sessionId": session_id })).await {
            if let Some(model_id) = current.get("modelId").or_else(|| current.get("model")).and_then(Value::as_str) {
                let _ = settings.set(&catalog, MODEL, model_id);
            }
            if let Some(effort) = current.get("reasoningEffort").and_then(Value::as_str) {
                let _ = settings.set(&catalog, EFFORT, effort);
            }
            if let Some(tier) = current.get("contextTier").and_then(Value::as_str) {
                let _ = settings.set(&catalog, CONTEXT_TIER, tier);
            }
        }
        let actual_id = resumed.get("sessionId").and_then(Value::as_str).unwrap_or(&session_id).to_owned();
        let options = models::config_options(&catalog, &settings);
        self.state.lock().sessions.insert(actual_id.clone(), SessionEntry::new(settings));
        self.publish_commands(&actual_id, cwd);
        Ok(json!({
            "sessionId": actual_id,
            "configOptions": options,
        }))
    }

    fn publish_commands(self: &Arc<Self>, session_id: &str, cwd: &str) {
        let shim = self.clone();
        let sid = session_id.to_owned();
        let cwd = cwd.to_owned();
        self.runtime.spawn(async move {
            let cmds: Option<Value> = shim.copilot().request("commands.list", json!({}), None).await.ok();
            let skills: Option<Value> =
                shim.copilot().request("skills.discover", json!({ "projectPaths": [cwd] }), None).await.ok();
            let list = translate::available_commands(cmds.as_ref(), skills.as_ref());
            if !list.is_empty() {
                shim.send_update(
                    &sid,
                    json!({ "sessionUpdate": "available_commands_update", "availableCommands": list }),
                );
            }
        });
    }

    async fn set_config(&self, params: &Value) -> Result<Value, ResponseError> {
        let session_id = str_param(params, "sessionId")?;
        let option = params
            .get("configId")
            .or_else(|| params.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("missing configId"))?;
        let value = str_param(params, "value")?;
        let catalog = self.models().await?;

        let (next_settings, last_used) = {
            let mut st = self.state.lock();
            let entry =
                st.sessions.get_mut(session_id).ok_or_else(|| invalid(format!("unknown session {session_id}")))?;
            let mut next = entry.settings.clone();
            next.set(&catalog, option, value).map_err(invalid)?;
            (next, entry.translator.last_used_tokens)
        };

        match option {
            MODEL | EFFORT | CONTEXT_TIER => {
                let mut switch = json!({
                    "sessionId": session_id,
                    "modelId": next_settings.model,
                });
                if let Some(effort) = &next_settings.effort {
                    switch["reasoningEffort"] = json!(effort);
                }
                if let Some(tier) = &next_settings.context_tier {
                    switch["contextTier"] = json!(tier);
                }
                self.call("session.model.switchTo", switch).await?;
            }
            MODE => {
                let _ = self
                    .call("session.mode.set", json!({ "sessionId": session_id, "mode": next_settings.mode.wire() }))
                    .await;
                if next_settings.mode == Mode::Autopilot {
                    let _ = self
                        .call("session.permissions.setApproveAll", json!({ "sessionId": session_id, "enabled": true }))
                        .await;
                }
            }
            ALLOW_ALL => {
                let _ = self
                    .call(
                        "session.permissions.setApproveAll",
                        json!({ "sessionId": session_id, "enabled": next_settings.allow_all }),
                    )
                    .await;
            }
            _ => {}
        }

        let new_limit = next_settings.active_context_tokens(&catalog);
        let options = models::config_options(&catalog, &next_settings);
        {
            let mut st = self.state.lock();
            if let Some(entry) = st.sessions.get_mut(session_id) {
                entry.settings = next_settings;
            }
        }
        if matches!(option, MODEL | CONTEXT_TIER)
            && let (Some(used), Some(size)) = (last_used, new_limit.filter(|&s| s > 0))
        {
            self.send_update(session_id, json!({ "sessionUpdate": "usage_update", "used": used, "size": size }));
        }
        Ok(json!({ "configOptions": options }))
    }

    async fn prompt(&self, params: &Value, steer: bool) -> Result<Value, ResponseError> {
        let session_id = str_param(params, "sessionId")?.to_owned();
        let blocks = params.get("prompt").and_then(Value::as_array).ok_or_else(|| invalid("missing prompt"))?;
        let (text, attachments, temp_files) = build_prompt_payload(&session_id, blocks);

        if steer {
            let (is_running, main_busy) = {
                let st = self.state.lock();
                let entry = st.sessions.get(&session_id);
                (entry.is_some_and(|e| e.prompt.is_some()), entry.is_some_and(|e| e.main_busy))
            };
            if !is_running {
                cleanup_files(&temp_files);
                return Err(error(codes::INVALID_PARAMS, "no turn running to steer"));
            }
            let mut send_req = json!({
                "sessionId": session_id,
                "prompt": text,
            });
            // Joins the running loop; once it went idle (only background work is left), a plain
            // send starts the loop again with this message.
            if main_busy {
                send_req["mode"] = json!("immediate");
            }
            if !attachments.is_empty() {
                send_req["attachments"] = Value::Array(attachments);
            }
            if !main_busy && let Some(entry) = self.state.lock().sessions.get_mut(&session_id) {
                // Stop must abort the run this send starts, even before `assistant.turn_start`.
                entry.main_busy = true;
            }
            let res = self.call("session.send", send_req).await;
            if let Some(entry) = self.state.lock().sessions.get_mut(&session_id) {
                entry.temp_files.extend(temp_files);
                if res.is_err() && !main_busy {
                    entry.main_busy = false;
                }
            }
            res?;
            return Ok(json!({}));
        }

        let (done_tx, done_rx) = oneshot::channel();
        let (agent_mode, cancelled_early) = {
            let mut st = self.state.lock();
            let entry =
                st.sessions.get_mut(&session_id).ok_or_else(|| invalid(format!("unknown session {session_id}")))?;
            let early = entry.early_cancel.take().is_some_and(|t| t.elapsed() < EARLY_CANCEL);
            entry.translator.reset_turn();
            entry.temp_files.extend(temp_files);
            let mode = entry.settings.mode.wire();
            if !early {
                entry.prompt = Some(done_tx);
                entry.main_busy = true;
            }
            (mode, early)
        };
        if cancelled_early {
            return Ok(json!({ "stopReason": "cancelled" }));
        }

        let mut send_req = json!({
            "sessionId": session_id,
            "prompt": text,
            "agentMode": agent_mode,
        });
        if !attachments.is_empty() {
            send_req["attachments"] = Value::Array(attachments);
        }

        if let Err(e) = self.call("session.send", send_req).await {
            self.finish_turn_files(&session_id);
            self.state.lock().sessions.get_mut(&session_id).map(|s| s.prompt.take());
            return Err(e);
        }

        let outcome = done_rx
            .await
            .unwrap_or_else(|_| TurnTerminal::Error { message: "GitHub Copilot exited".into(), data: None });
        self.finish_turn_files(&session_id);
        match outcome {
            TurnTerminal::Idle { aborted: true } => Ok(json!({ "stopReason": "cancelled" })),
            TurnTerminal::Idle { aborted: false } => Ok(json!({ "stopReason": "end_turn" })),
            TurnTerminal::Error { message, data } => {
                let code = if crate::acp::auth_required(codes::INTERNAL_ERROR, &message) {
                    AUTH_REQUIRED
                } else {
                    codes::INTERNAL_ERROR
                };
                Err(ResponseError { code, message, data })
            }
        }
    }

    async fn close_session(&self, params: &Value) -> Result<Value, ResponseError> {
        let session_id = str_param(params, "sessionId")?;
        self.finish_turn_files(session_id);
        self.state.lock().sessions.remove(session_id);
        let _ = self.call("session.detach", json!({ "sessionId": session_id })).await;
        Ok(json!({}))
    }

    fn cancel(&self, session_id: &str) {
        let (has_turn, ended) = {
            let mut st = self.state.lock();
            match st.sessions.get_mut(session_id) {
                Some(entry) if entry.prompt.is_none() => {
                    entry.early_cancel = Some(Instant::now());
                    (false, None)
                }
                // The agent is done with the turn and only its background work runs, which
                // `session.idle` waits for: the turn ends now and that work keeps running
                // (it shows as background tasks, stoppable one by one).
                Some(entry) if !entry.main_busy => (false, entry.prompt.take()),
                Some(_) => (true, None),
                None => (false, None),
            }
        };
        if let Some(tx) = ended {
            let _ = tx.send(TurnTerminal::Idle { aborted: true });
        }
        if has_turn {
            let peer = self.copilot().clone();
            let sid = session_id.to_owned();
            self.runtime.spawn(async move {
                let _ = peer.request::<_, Value>("session.abort", json!({ "sessionId": sid }), None).await;
            });
        }
    }

    fn finish_turn_files(&self, session_id: &str) {
        let files = self
            .state
            .lock()
            .sessions
            .get_mut(session_id)
            .map(|e| std::mem::take(&mut e.temp_files))
            .unwrap_or_default();
        cleanup_files(&files);
    }

    fn copilot_gone(&self) {
        let mut st = self.state.lock();
        st.gone = true;
        for (_, mut entry) in st.sessions.drain() {
            cleanup_files(&entry.temp_files);
            if let Some(tx) = entry.prompt.take() {
                let _ = tx.send(TurnTerminal::Error { message: "GitHub Copilot exited".into(), data: None });
            }
        }
    }

    fn on_copilot_notification(self: &Arc<Self>, method: &str, params: &Value) {
        if method != "session.event" {
            return;
        }
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else { return };
        let Some(event) = params.get("event") else { return };

        if event.get("type").and_then(Value::as_str) == Some("permission.requested") {
            self.handle_permission_event(session_id, event);
            return;
        }

        let main_agent = event.get("agentId").and_then(Value::as_str).is_none_or(str::is_empty);
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or_default();
        if main_agent && event_type == "session.background_tasks_changed" {
            self.refresh_background_tasks(session_id);
        }

        let catalog_snapshot = self.catalog.try_lock().ok().and_then(|g| g.clone());
        let (updates, done) = {
            let mut st = self.state.lock();
            let Some(entry) = st.sessions.get_mut(session_id) else { return };
            if main_agent {
                match event_type {
                    "assistant.turn_start" => entry.main_busy = true,
                    "assistant.idle" | "session.idle" | "session.error" => entry.main_busy = false,
                    _ => {}
                }
            }
            let fallback_limit =
                catalog_snapshot.as_deref().and_then(|models| entry.settings.active_context_tokens(models));
            let translated = entry.translator.translate(session_id, event, fallback_limit);
            let done = translated.terminal.and_then(|t| entry.prompt.take().map(|tx| (tx, t)));
            (translated.updates, done)
        };
        for (target_session, update) in updates {
            self.send_update(&target_session, update);
        }
        if main_agent && event_type == "session.idle" {
            // Nothing runs in the background any more.
            self.send_update(session_id, json!({ "sessionUpdate": BACKGROUND_TASKS_UPDATE, "tasks": [] }));
        }
        if let Some((tx, outcome)) = done {
            let _ = tx.send(outcome);
        }
    }

    /// Reports the session's running background shells and agents (`session.tasks.list`).
    fn refresh_background_tasks(self: &Arc<Self>, session_id: &str) {
        let seq = {
            let mut st = self.state.lock();
            let Some(entry) = st.sessions.get_mut(session_id) else { return };
            entry.tasks_seq += 1;
            entry.tasks_seq
        };
        let shim = self.clone();
        let sid = session_id.to_owned();
        self.runtime.spawn(async move {
            let Ok(list) = shim.call("session.tasks.list", json!({ "sessionId": sid })).await else { return };
            let latest = shim.state.lock().sessions.get(&sid).is_some_and(|e| e.tasks_seq == seq);
            if latest {
                let tasks = translate::background_tasks(&list);
                shim.send_update(&sid, json!({ "sessionUpdate": BACKGROUND_TASKS_UPDATE, "tasks": tasks }));
            }
        });
    }

    /// Stops one background shell or agent (`session.tasks.cancel`).
    async fn stop_task(self: &Arc<Self>, params: &Value) -> Result<Value, ResponseError> {
        let session_id = str_param(params, "sessionId")?;
        let task_id = str_param(params, "taskId")?;
        self.call("session.tasks.cancel", json!({ "sessionId": session_id, "id": task_id })).await?;
        self.refresh_background_tasks(session_id);
        Ok(json!({}))
    }

    fn handle_permission_event(self: &Arc<Self>, session_id: &str, event: &Value) {
        let data = &event["data"];
        if data.get("resolvedByHook").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let Some(request_id) = data.get("requestId").and_then(Value::as_str).map(str::to_owned) else { return };
        let perm = data.get("permissionRequest").cloned().unwrap_or(Value::Null);
        let bypass_sandbox = perm.get("kind").and_then(Value::as_str) == Some("shell")
            && perm.get("requestSandboxBypass").and_then(Value::as_bool) == Some(true);
        let auto_approve = !bypass_sandbox
            && self
                .state
                .lock()
                .sessions
                .get(session_id)
                .is_some_and(|s| s.settings.allow_all || s.settings.mode == Mode::Autopilot);

        let shim = self.clone();
        let sid = session_id.to_owned();
        self.runtime.spawn(async move {
            let kind = if auto_approve {
                "approve-once"
            } else {
                let ask = translate::permission_request(&sid, &perm);
                match shim.to_client().request::<_, Value>("session/request_permission", ask, None).await {
                    Ok(reply) => match reply.pointer("/outcome/optionId").and_then(Value::as_str) {
                        Some("approved") => "approved",
                        Some("approve-once") => "approve-once",
                        _ => "denied-interactively-by-user",
                    },
                    Err(_) => "denied-interactively-by-user",
                }
            };
            let _ = shim
                .copilot()
                .request::<_, Value>(
                    "session.permissions.handlePendingPermissionRequest",
                    json!({
                        "sessionId": sid,
                        "requestId": request_id,
                        "result": { "kind": kind },
                    }),
                    None,
                )
                .await;
        });
    }

    fn on_copilot_request(&self, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        match method {
            "exitPlanMode.request" => Ok(json!({ "approved": true })),
            "autoModeSwitch.request" => Ok(json!("no")),
            "systemMessage.transform" => Ok(json!({ "sections": {} })),
            "shellAuthentication.request" => Ok(json!({ "action": "cancel" })),
            "shellAuthentication.cancel" => Ok(json!({})),
            "userInput.request" => {
                let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
                    return Ok(json!({ "answer": "", "wasFreeform": false }));
                };
                let ask = translate::user_input_permission_request(session_id, params);
                let reply = self.runtime.block_on(self.to_client().request::<_, Value>(
                    "session/request_permission",
                    ask,
                    None,
                ));
                let Ok(reply) = reply else {
                    return Ok(json!({ "answer": "", "wasFreeform": false }));
                };
                let Some(raw) = reply.pointer("/outcome/optionId").and_then(Value::as_str) else {
                    return Ok(json!({ "answer": "", "wasFreeform": false }));
                };
                if raw == "cancel" {
                    return Ok(json!({ "answer": "", "wasFreeform": false }));
                }
                let answer = serde_json::from_str::<serde_json::Map<String, Value>>(raw)
                    .ok()
                    .and_then(|map| map.into_iter().next().and_then(|(_, v)| v.as_str().map(str::to_owned)))
                    .unwrap_or_else(|| raw.to_owned());
                let choices: Vec<&str> = params
                    .get("choices")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                let was_freeform = !choices.contains(&answer.as_str());
                Ok(json!({ "answer": answer, "wasFreeform": was_freeform }))
            }
            _ => Err((codes::METHOD_NOT_FOUND, format!("unsupported request {method}"))),
        }
    }
}

fn build_prompt_payload(session_id: &str, blocks: &[Value]) -> (String, Vec<Value>, Vec<PathBuf>) {
    let mut text_parts = Vec::new();
    let mut attachments = Vec::new();
    let mut temp_files = Vec::new();

    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    text_parts.push(t.to_owned());
                }
            }
            Some("resource") => {
                if let Some(uri) = block.pointer("/resource/uri").and_then(Value::as_str)
                    && let Some(path) = file_path_from_uri(uri)
                {
                    let kind = if Path::new(&path).is_dir() { "directory" } else { "file" };
                    attachments.push(json!({ "type": kind, "path": path }));
                } else if let Some(t) =
                    block.pointer("/resource/text").and_then(Value::as_str).filter(|t| !t.is_empty())
                {
                    text_parts.push(t.to_owned());
                }
            }
            Some("resource_link") => {
                if let Some(uri) = block.get("uri").and_then(Value::as_str)
                    && let Some(path) = file_path_from_uri(uri)
                {
                    let kind = if Path::new(&path).is_dir() { "directory" } else { "file" };
                    attachments.push(json!({ "type": kind, "path": path }));
                }
            }
            Some("image") => {
                if let (Some(mime), Some(data)) =
                    (block.get("mimeType").and_then(Value::as_str), block.get("data").and_then(Value::as_str))
                    && let Some(saved) = write_temp_image(session_id, mime, data)
                {
                    let path_str = saved.to_string_lossy().into_owned();
                    let name = saved.file_name().and_then(|n| n.to_str()).unwrap_or("image").to_owned();
                    attachments.push(json!({ "type": "file", "path": path_str, "displayName": name }));
                    temp_files.push(saved);
                }
            }
            _ => {}
        }
    }
    (text_parts.join("\n\n"), attachments, temp_files)
}

fn file_path_from_uri(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let decoded = percent_decode(rest);
    if cfg!(windows)
        && let Some(stripped) = decoded.strip_prefix('/')
        && stripped.as_bytes().get(1) == Some(&b':')
    {
        return Some(stripped.to_owned());
    }
    Some(decoded)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn write_temp_image(session_id: &str, mime: &str, base64_data: &str) -> Option<PathBuf> {
    let ext = match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };
    let bytes = crate::acp::normalize_base64(base64_data);
    if bytes.is_empty() {
        return None;
    }
    let dir = std::env::temp_dir().join("openidea-copilot");
    std::fs::create_dir_all(&dir).ok()?;
    let safe_sid: String = session_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let file = dir.join(format!("{safe_sid}-{}.{ext}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&file, &bytes).ok()?;
    Some(file)
}

fn cleanup_files(files: &[PathBuf]) {
    for f in files {
        let _ = std::fs::remove_file(f);
    }
}
