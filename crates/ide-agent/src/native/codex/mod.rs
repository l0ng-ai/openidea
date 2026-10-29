//! Codex over `codex app-server`: JSON-RPC (v2 threads and turns) on the child's stdio,
//! translated to and from ACP. A codex thread is an ACP session; a subagent's thread is
//! a subagent session of the thread that spawned it.

mod translate;

#[cfg(test)]
mod tests;

use super::Shim;
use crate::provider::ProviderSpec;
use ide_jsonrpc::{Framing, Handler, Peer, RpcError, codes};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use translate::{Choice, Failure, ModelInfo, Settings};

/// Notifications codex need not send: the client builds diffs from the items.
const OPT_OUT: [&str; 1] = ["turn/diff/updated"];
/// A running command's output is sent at most this often.
const OUTPUT_EVERY: Duration = Duration::from_millis(200);
/// How long a `session/cancel` with no turn running still stops the prompt that follows.
const EARLY_CANCEL: Duration = Duration::from_secs(1);
/// How long the client's connection outlives codex.
const EXIT_GRACE: Duration = Duration::from_millis(100);
/// ACP's error code for a request that needs the user to sign in.
const AUTH_REQUIRED: i64 = -32000;

pub(crate) fn connect(
    spec: &ProviderSpec,
    cwd: &Path,
    client: Arc<dyn Handler>,
    on_stderr: Box<dyn Fn(String) + Send + Sync>,
) -> std::io::Result<Peer> {
    attach(client, |events| {
        let command = super::newest_install(&spec.command);
        Peer::spawn_framed(&command, &spec.args, cwd, &spec.env, events, on_stderr, Framing::Lines)
    })
}

/// Connects `client` to a shim driving the codex connection `connect_codex` opens (it
/// gets the handler for what codex sends). Each side's end closes the other.
fn attach(
    client: Arc<dyn Handler>,
    connect_codex: impl FnOnce(Arc<dyn Handler>) -> std::io::Result<Peer>,
) -> std::io::Result<Peer> {
    let shim = Arc::new(CodexShim {
        runtime: tokio::runtime::Handle::current(),
        codex: OnceLock::new(),
        client: OnceLock::new(),
        state: Mutex::new(State::default()),
        models: tokio::sync::Mutex::new(None),
    });
    let codex = connect_codex(Arc::new(CodexEvents(Arc::downgrade(&shim))))?;
    let _ = shim.codex.set(codex.clone());
    let ours = super::serve(shim.clone(), client);
    let to_client = shim.client.get().cloned().expect("serve attaches the client");
    {
        let (shim, codex, to_client) = (shim.clone(), codex.clone(), to_client.clone());
        tokio::spawn(async move {
            codex.closed().await;
            shim.codex_gone();
            // Answers already on their way (the turn that just ended) go out first.
            tokio::time::sleep(EXIT_GRACE).await;
            to_client.kill();
        });
    }
    tokio::spawn(async move {
        to_client.closed().await;
        codex.kill();
    });
    Ok(ours)
}

struct CodexShim {
    runtime: tokio::runtime::Handle,
    codex: OnceLock<Peer>,
    client: OnceLock<Peer>,
    state: Mutex<State>,
    /// `model/list`, fetched once.
    models: tokio::sync::Mutex<Option<Arc<Vec<ModelInfo>>>>,
}

#[derive(Default)]
struct State {
    initialized: bool,
    /// By codex thread id, which is also the ACP session id.
    threads: HashMap<String, Thread>,
    /// The last `account/rateLimits/updated` snapshot.
    rate_limits: Option<Value>,
    /// Codex exited.
    gone: bool,
}

#[derive(Default)]
struct Thread {
    /// The session whose agent spawned this one (a subagent's thread).
    parent: Option<String>,
    /// What turns run with (sessions of their own only).
    settings: Option<Settings>,
    cwd: Option<String>,
    /// The turn running now.
    turn: Option<String>,
    /// The last turn that completed.
    completed: Option<String>,
    /// The `session/prompt` waiting for its turn to end.
    prompt: Option<PendingPrompt>,
    /// The current turn's tool items, for approval titles.
    items: HashMap<String, Value>,
    /// Output of running commands, by item id.
    outputs: HashMap<String, Output>,
    /// Items whose text was streamed (their completion doesn't repeat it).
    streamed: HashSet<String>,
    /// Kind and item of the text chunk sent last, while nothing else followed it.
    last_chunk: Option<(&'static str, String)>,
    /// The last error reported for the running turn.
    error: Option<Value>,
    /// A `session/cancel` that came with no turn running: it can overtake the
    /// `session/prompt` sent just before it.
    early_cancel: Option<Instant>,
    /// The latest agent message (a subagent's answer).
    answer: String,
}

struct PendingPrompt {
    done: oneshot::Sender<(Value, Option<Value>)>,
    /// Known once `turn/start` answers or `turn/started` arrives.
    turn: Option<String>,
    /// Cancelled before the turn was known: interrupt it as soon as it is.
    cancel: bool,
}

struct Output {
    text: String,
    sent: Instant,
}

/// Receives what codex sends.
struct CodexEvents(Weak<CodexShim>);

impl Handler for CodexEvents {
    fn on_notification(&self, method: &str, params: Value) {
        if let Some(shim) = self.0.upgrade() {
            shim.on_codex_notification(method, &params);
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let shim = self.0.upgrade().ok_or((codes::INTERNAL_ERROR, "closed".to_owned()))?;
        shim.on_codex_request(method, &params)
    }
}

impl Shim for CodexShim {
    fn attach(&self, client: Peer) {
        let _ = self.client.set(client);
    }
}

impl Handler for CodexShim {
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
        self.runtime.block_on(self.handle(method, params)).map_err(|e| (e.code, e.message, e.data))
    }
}

/// The `error` of an ACP response.
#[derive(Debug)]
struct ResponseError {
    code: i64,
    message: String,
    data: Option<Value>,
}

fn error(code: i64, message: impl Into<String>) -> ResponseError {
    ResponseError { code, message: message.into(), data: None }
}

fn invalid(message: impl Into<String>) -> ResponseError {
    error(codes::INVALID_PARAMS, message)
}

/// A failed codex request, for the ACP client.
fn from_codex(e: RpcError) -> ResponseError {
    match e {
        RpcError::Server { code, message, data } => {
            // Protocol errors can list method names containing "auth"; they are not sign-in failures.
            let protocol = matches!(
                code,
                codes::PARSE_ERROR | codes::INVALID_REQUEST | codes::METHOD_NOT_FOUND | codes::INVALID_PARAMS
            );
            let code = if !protocol && message.to_lowercase().contains("auth") { AUTH_REQUIRED } else { code };
            ResponseError { code, message, data }
        }
        RpcError::Closed => error(codes::INTERNAL_ERROR, "Codex exited"),
        e => error(codes::INTERNAL_ERROR, e.to_string()),
    }
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, ResponseError> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| invalid(format!("missing {key}")))
}

impl CodexShim {
    fn codex(&self) -> &Peer {
        self.codex.get().expect("attached before any message")
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, ResponseError> {
        self.codex().request(method, params, None).await.map_err(from_codex)
    }

    async fn handle(&self, method: &str, params: Value) -> Result<Value, ResponseError> {
        match method {
            "initialize" => self.initialize().await,
            "session/new" => self.new_session(&params).await,
            "session/load" => self.load_session(&params).await,
            "session/fork" => self.fork_session(&params).await,
            "session/set_config_option" => self.set_config(&params).await,
            "session/prompt" => self.prompt(&params).await,
            "_openidea/steer" => self.steer(&params).await,
            "_openidea/rollback" => self.rollback(&params).await,
            "session/close" => self.close(&params).await,
            _ => Err(error(codes::METHOD_NOT_FOUND, format!("unsupported method {method}"))),
        }
    }

    async fn initialize(&self) -> Result<Value, ResponseError> {
        let info = self
            .call(
                "initialize",
                json!({
                    "clientInfo": { "name": "openidea", "title": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true, "optOutNotificationMethods": OPT_OUT },
                }),
            )
            .await?;
        self.codex().notify("initialized", Value::Null).map_err(from_codex)?;
        self.state.lock().initialized = true;
        // `<client>/<codex version> (<platform>) …`
        let version = info
            .get("userAgent")
            .and_then(Value::as_str)
            .and_then(|ua| ua.split_whitespace().next())
            .and_then(|first| first.split_once('/'))
            .map(|(_, v)| v.to_owned());
        Ok(json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
                "mcpCapabilities": { "http": false, "sse": false },
                "sessionCapabilities": { "fork": {}, "close": {} },
                "_meta": { "openidea": { "rollback": true, "steer": true } },
            },
            "agentInfo": { "name": "codex", "title": "Codex", "version": version },
            "authMethods": [],
        }))
    }

    /// The models codex offers; empty when it can't list them.
    async fn models(&self) -> Arc<Vec<ModelInfo>> {
        let mut cached = self.models.lock().await;
        if let Some(m) = cached.as_ref() {
            return m.clone();
        }
        let mut all = Vec::new();
        let mut cursor = Value::Null;
        loop {
            match self.call("model/list", json!({ "cursor": cursor })).await {
                Ok(page) => {
                    all.extend(translate::models_of(&page));
                    match page.get("nextCursor").filter(|c| c.is_string()) {
                        Some(next) if *next != cursor => cursor = next.clone(),
                        _ => break,
                    }
                }
                Err(e) => {
                    tracing::warn!("codex: listing models failed: {}", e.message);
                    return Arc::new(all);
                }
            }
        }
        let models = Arc::new(all);
        *cached = Some(models.clone());
        models
    }

    /// Registers a thread codex opened for a session of its own; returns its `configOptions`.
    fn open_thread(&self, result: &Value, models: &[ModelInfo], settings: Option<Settings>) -> (String, Value) {
        let thread = result.get("thread").unwrap_or(&Value::Null);
        let id = thread.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let settings = settings.unwrap_or_else(|| Settings::of(result, models));
        let options = translate::config_options(models, &settings);
        let cwd = result.get("cwd").or(thread.get("cwd")).and_then(Value::as_str).map(str::to_owned);
        let mut state = self.state.lock();
        let t = state.threads.entry(id.clone()).or_default();
        t.parent = None;
        t.settings = Some(settings);
        t.cwd = cwd;
        (id, options)
    }

    async fn new_session(&self, params: &Value) -> Result<Value, ResponseError> {
        let models = self.models().await;
        let result = self.call("thread/start", json!({ "cwd": params.get("cwd") })).await?;
        let (id, options) = self.open_thread(&result, &models, None);
        if id.is_empty() {
            return Err(error(codes::INTERNAL_ERROR, "codex started no thread"));
        }
        Ok(json!({ "sessionId": id, "configOptions": options }))
    }

    /// Resumes the thread and replays its history before answering.
    async fn load_session(&self, params: &Value) -> Result<Value, ResponseError> {
        let id = str_param(params, "sessionId")?;
        let models = self.models().await;
        let result = self.call("thread/resume", json!({ "threadId": id, "cwd": params.get("cwd") })).await?;
        let (_, options) = self.open_thread(&result, &models, None);
        let cwd = self.state.lock().threads.get(id).and_then(|t| t.cwd.clone());
        let thread = result.get("thread").unwrap_or(&Value::Null);
        for update in translate::history(thread, cwd.as_deref()) {
            self.emit(id, update);
        }
        Ok(json!({ "configOptions": options }))
    }

    async fn fork_session(&self, params: &Value) -> Result<Value, ResponseError> {
        let source = str_param(params, "sessionId")?;
        let models = self.models().await;
        let settings = self.state.lock().threads.get(source).and_then(|t| t.settings.clone());
        let mut request = json!({ "threadId": source, "cwd": params.get("cwd") });
        if let Some(s) = &settings {
            request["model"] = json!(s.model_slug(&models));
            request["approvalPolicy"] = json!(s.mode.approval_policy());
            request["sandbox"] = json!(s.mode.sandbox_mode());
        }
        let result = self.call("thread/fork", request).await?;
        let (id, options) = self.open_thread(&result, &models, settings);
        Ok(json!({ "sessionId": id, "configOptions": options }))
    }

    async fn set_config(&self, params: &Value) -> Result<Value, ResponseError> {
        let session = str_param(params, "sessionId")?;
        let option = str_param(params, "configId")?;
        let value = str_param(params, "value")?;
        let models = self.models().await;
        let mut state = self.state.lock();
        let settings = state
            .threads
            .get_mut(session)
            .and_then(|t| t.settings.as_mut())
            .ok_or_else(|| invalid(format!("no session {session}")))?;
        settings.set(&models, option, value).map_err(invalid)?;
        Ok(json!({ "configOptions": translate::config_options(&models, settings) }))
    }

    async fn prompt(&self, params: &Value) -> Result<Value, ResponseError> {
        let session = str_param(params, "sessionId")?.to_owned();
        let input = translate::user_input(params.get("prompt").unwrap_or(&Value::Null));
        if input.is_empty() {
            return Err(invalid("empty prompt"));
        }
        let models = self.models().await;
        let (done, ended) = oneshot::channel();
        let settings = {
            let mut state = self.state.lock();
            if state.gone {
                return Err(error(codes::INTERNAL_ERROR, "Codex exited"));
            }
            let t = state.threads.get_mut(&session).ok_or_else(|| invalid(format!("no session {session}")))?;
            if t.prompt.is_some() {
                return Err(invalid("a turn is already running"));
            }
            let cancel = t.early_cancel.take().is_some_and(|at| at.elapsed() < EARLY_CANCEL);
            t.prompt = Some(PendingPrompt { done, turn: None, cancel });
            t.error = None;
            t.settings.clone()
        };
        let mut request = json!({ "threadId": session, "input": input, "summary": "auto" });
        if let Some(s) = settings {
            request["model"] = json!(s.model_slug(&models));
            request["approvalPolicy"] = json!(s.mode.approval_policy());
            request["sandboxPolicy"] = s.mode.sandbox_policy();
            if let Some(effort) = &s.effort {
                request["effort"] = json!(effort);
            }
        }
        match self.call("turn/start", request).await {
            Ok(started) => {
                if let Some(turn) = started.pointer("/turn/id").and_then(Value::as_str) {
                    self.turn_known(&session, turn, false);
                }
            }
            Err(e) => {
                if let Some(t) = self.state.lock().threads.get_mut(&session) {
                    t.prompt = None;
                }
                return Err(e);
            }
        }
        let (turn, last_error) = ended.await.map_err(|_| error(codes::INTERNAL_ERROR, "Codex exited"))?;
        let rate_limits = self.state.lock().rate_limits.clone();
        stop_reason(&turn, last_error, rate_limits.as_ref())
    }

    async fn steer(&self, params: &Value) -> Result<Value, ResponseError> {
        let session = str_param(params, "sessionId")?;
        let turn = self.state.lock().threads.get(session).and_then(|t| t.turn.clone());
        let turn = turn.ok_or_else(|| invalid("no turn is running"))?;
        let input = translate::user_input(params.get("prompt").unwrap_or(&Value::Null));
        self.call("turn/steer", json!({ "threadId": session, "expectedTurnId": turn, "input": input })).await?;
        Ok(json!({}))
    }

    async fn rollback(&self, params: &Value) -> Result<Value, ResponseError> {
        let session = str_param(params, "sessionId")?;
        let turns = params.get("turns").and_then(Value::as_u64).filter(|n| *n > 0).ok_or_else(|| invalid("turns"))?;
        match self.call("thread/rollback", json!({ "threadId": session, "numTurns": turns })).await {
            Ok(_) => {}
            Err(e)
                if e.code == codes::METHOD_NOT_FOUND
                    || (e.code == codes::INVALID_REQUEST
                        && e.message.contains("unknown variant `thread/rollback`")) =>
            {
                self.revert(session, turns).await?;
            }
            Err(e) => return Err(e),
        }
        Ok(json!({}))
    }

    /// New Codex versions replace rollback counts with an exclusive turn id.
    async fn revert(&self, session: &str, mut remaining: u64) -> Result<(), ResponseError> {
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        loop {
            let page = self
                .call(
                    "thread/turns/list",
                    json!({ "threadId": session, "sortDirection": "desc", "limit": remaining.min(100), "cursor": cursor }),
                )
                .await?;
            let turns = page.get("data").and_then(Value::as_array).ok_or_else(|| invalid("Codex returned no turns"))?;
            if remaining <= turns.len() as u64 {
                let before = str_param(&turns[remaining as usize - 1], "id")?;
                self.call("thread/revert", json!({ "threadId": session, "beforeTurnId": before })).await?;
                return Ok(());
            }
            remaining -= turns.len() as u64;
            let next = page.get("nextCursor").and_then(Value::as_str);
            let Some(next) = next.filter(|next| seen.insert((*next).to_owned())) else {
                return Err(invalid(
                    "Codex history has fewer turns than the conversation; reload the task before editing",
                ));
            };
            cursor = json!(next);
        }
    }

    /// Stops following the session's thread (codex unloads it once nothing follows it).
    async fn close(&self, params: &Value) -> Result<Value, ResponseError> {
        let session = str_param(params, "sessionId")?;
        let known = self.state.lock().threads.remove(session).is_some();
        if known && let Err(e) = self.call("thread/unsubscribe", json!({ "threadId": session })).await {
            tracing::debug!("codex: unsubscribing from {session}: {}", e.message);
        }
        Ok(json!({}))
    }

    /// `session/cancel`: interrupts the session's turn, or the one about to start.
    fn cancel(&self, session: &str) {
        let mut state = self.state.lock();
        let Some(t) = state.threads.get_mut(session) else { return };
        match t.turn.clone() {
            Some(turn) => self.interrupt(session, &turn),
            None => match t.prompt.as_mut() {
                Some(p) => p.cancel = true,
                None => t.early_cancel = Some(Instant::now()),
            },
        }
    }

    fn interrupt(&self, session: &str, turn: &str) {
        let codex = self.codex().clone();
        let params = json!({ "threadId": session, "turnId": turn });
        self.runtime.spawn(async move {
            if let Err(e) = codex.request::<_, Value>("turn/interrupt", params, None).await {
                tracing::warn!("codex: interrupting the turn failed: {e}");
            }
        });
    }

    /// Turn `turn` of `session` is known: from `turn/start`'s answer, or `started` with
    /// `turn/started`. Codex rejects an interrupt until it has started the turn, so a
    /// stop that came earlier waits for that.
    fn turn_known(&self, session: &str, turn: &str, started: bool) {
        let mut state = self.state.lock();
        let Some(t) = state.threads.get_mut(session) else { return };
        if t.completed.as_deref() == Some(turn) {
            return;
        }
        if started {
            t.turn = Some(turn.to_owned());
        }
        let Some(p) = t.prompt.as_mut() else { return };
        if p.turn.is_none() {
            p.turn = Some(turn.to_owned());
        }
        if started && p.turn.as_deref() == Some(turn) && std::mem::take(&mut p.cancel) {
            self.interrupt(session, turn);
        }
    }

    fn codex_gone(&self) {
        let mut state = self.state.lock();
        state.gone = true;
        for t in state.threads.values_mut() {
            t.prompt = None;
        }
    }

    fn emit(&self, session: &str, update: Value) {
        if let Some(client) = self.client.get() {
            let _ = client.notify("session/update", json!({ "sessionId": session, "update": update }));
        }
    }

    fn on_codex_notification(&self, method: &str, params: &Value) {
        let thread = params.get("threadId").and_then(Value::as_str).unwrap_or_default();
        match method {
            "turn/started" => {
                if let Some(turn) = params.pointer("/turn/id").and_then(Value::as_str) {
                    self.turn_known(thread, turn, true);
                }
                self.subagent_state(thread, json!({ "state": "running" }));
            }
            "turn/completed" => self.turn_completed(thread, params.get("turn").unwrap_or(&Value::Null)),
            "item/started" => self.item(thread, params.get("item").unwrap_or(&Value::Null), false),
            "item/completed" => self.item(thread, params.get("item").unwrap_or(&Value::Null), true),
            "item/agentMessage/delta" | "item/plan/delta" => self.text(thread, params, "agent_message_chunk", false),
            "item/reasoning/summaryTextDelta" => self.text(thread, params, "agent_thought_chunk", false),
            "item/reasoning/textDelta" => self.text(thread, params, "agent_thought_chunk", true),
            "item/reasoning/summaryPartAdded" => {
                if params.get("summaryIndex").and_then(Value::as_u64).unwrap_or(0) > 0 {
                    let mut p = params.clone();
                    p["delta"] = json!("\n\n");
                    self.text(thread, &p, "agent_thought_chunk", false);
                }
            }
            "item/commandExecution/outputDelta" => self.command_output(thread, params),
            "item/fileChange/patchUpdated" => {
                let id = params.get("itemId").and_then(Value::as_str).unwrap_or_default();
                let item = json!({ "id": id, "type": "fileChange", "changes": params.get("changes") });
                self.with_thread(thread, |t, cwd| {
                    let mut update = translate::tool_call(&item, true, cwd, None)?;
                    update.as_object_mut()?.remove("status");
                    t.last_chunk = None;
                    Some(update)
                });
            }
            "turn/plan/updated" => self.with_thread(thread, |t, _| {
                t.last_chunk = None;
                Some(translate::plan(params))
            }),
            "thread/tokenUsage/updated" => self.with_thread(thread, |_, _| translate::usage(params)),
            "thread/name/updated" => self.with_thread(thread, |_, _| {
                let title = params.get("threadName").and_then(Value::as_str)?;
                Some(json!({ "sessionUpdate": "session_info_update", "title": title }))
            }),
            "thread/started" => self.thread_started(params.get("thread").unwrap_or(&Value::Null)),
            "error" => {
                if params.get("willRetry").and_then(Value::as_bool) != Some(true)
                    && let Some(t) = self.state.lock().threads.get_mut(thread)
                {
                    t.error = params.get("error").cloned();
                }
            }
            "account/rateLimits/updated" => self.state.lock().rate_limits = params.get("rateLimits").cloned(),
            _ => {}
        }
    }

    /// Sends what `f` makes of the known thread `thread` (given its cwd), under the lock so
    /// updates keep their order.
    fn with_thread(&self, thread: &str, f: impl FnOnce(&mut Thread, Option<&str>) -> Option<Value>) {
        let mut state = self.state.lock();
        let Some(t) = state.threads.get_mut(thread) else { return };
        let cwd = t.cwd.clone();
        if let Some(update) = f(t, cwd.as_deref()) {
            self.emit(thread, update);
        }
    }

    /// A streamed piece of a message or reasoning item. `raw` reasoning text is used only
    /// for items without a summary.
    fn text(&self, thread: &str, params: &Value, kind: &'static str, raw: bool) {
        let item = params.get("itemId").and_then(Value::as_str).unwrap_or_default();
        let Some(delta) = params.get("delta").and_then(Value::as_str).filter(|d| !d.is_empty()) else { return };
        self.with_thread(thread, |t, _| {
            let summarized = t.streamed.contains(&format!("summary:{item}"));
            if raw && summarized {
                return None;
            }
            if !raw && kind == "agent_thought_chunk" {
                t.streamed.insert(format!("summary:{item}"));
            }
            t.streamed.insert(item.to_owned());
            Some(t.chunk(kind, item, delta))
        });
    }

    fn command_output(&self, thread: &str, params: &Value) {
        let item = params.get("itemId").and_then(Value::as_str).unwrap_or_default();
        let delta = params.get("delta").and_then(Value::as_str).unwrap_or_default();
        self.with_thread(thread, |t, _| {
            let out = t
                .outputs
                .entry(item.to_owned())
                .or_insert_with(|| Output { text: String::new(), sent: Instant::now() - OUTPUT_EVERY });
            out.text.push_str(delta);
            if out.text.len() > 2 * translate::MAX_OUTPUT {
                out.text = translate::tail(&out.text);
            }
            if out.sent.elapsed() < OUTPUT_EVERY {
                return None;
            }
            out.sent = Instant::now();
            t.last_chunk = None;
            Some(translate::command_output(item, &out.text))
        });
    }

    fn item(&self, thread: &str, item: &Value, done: bool) {
        let id = item.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        match item.get("type").and_then(Value::as_str).unwrap_or_default() {
            "userMessage" | "hookPrompt" => {}
            ty @ ("agentMessage" | "plan" | "reasoning") => {
                if !done {
                    return;
                }
                let (kind, text) = if ty == "reasoning" {
                    ("agent_thought_chunk", translate::reasoning_text(item))
                } else {
                    ("agent_message_chunk", item.get("text").and_then(Value::as_str).unwrap_or_default().to_owned())
                };
                self.with_thread(thread, |t, _| {
                    if ty == "agentMessage" {
                        t.answer = text.clone();
                    }
                    t.streamed.remove(&format!("summary:{id}"));
                    if t.streamed.remove(&id) || text.is_empty() {
                        return None;
                    }
                    Some(t.chunk(kind, &id, &text))
                });
            }
            "subAgentActivity" => {
                let child = item.get("agentThreadId").and_then(Value::as_str).unwrap_or_default();
                let name = item.get("agentPath").and_then(Value::as_str).and_then(|p| p.rsplit('/').next());
                if !done && item.get("kind").and_then(Value::as_str) == Some("started") {
                    self.spawned(thread, child, name, None, &id);
                }
            }
            "collabAgentToolCall" if item.get("tool").and_then(Value::as_str) == Some("spawnAgent") => {
                if !done {
                    return;
                }
                let prompt = item.get("prompt").and_then(Value::as_str);
                for child in item.get("receiverThreadIds").and_then(Value::as_array).into_iter().flatten() {
                    if let Some(child) = child.as_str() {
                        self.spawned(thread, child, None, prompt, &id);
                    }
                }
            }
            _ => self.with_thread(thread, |t, cwd| {
                let output = if done { t.outputs.remove(&id).map(|o| o.text) } else { None };
                let update = translate::tool_call(item, done, cwd, output.as_deref())?;
                if done {
                    t.items.remove(&id);
                } else {
                    t.items.insert(id.clone(), item.clone());
                }
                t.last_chunk = None;
                Some(update)
            }),
        }
    }

    /// A subagent thread `child` started by session `parent`: announced on the parent, with
    /// what it was asked.
    fn spawned(&self, parent: &str, child: &str, name: Option<&str>, prompt: Option<&str>, call: &str) {
        if child.is_empty() {
            return;
        }
        let mut state = self.state.lock();
        if !state.threads.contains_key(parent) {
            return;
        }
        let cwd = state.threads.get(parent).and_then(|t| t.cwd.clone());
        let known = state.threads.contains_key(child);
        let t = state.threads.entry(child.to_owned()).or_default();
        t.parent = Some(parent.to_owned());
        t.cwd = t.cwd.take().or(cwd);
        if !known {
            let mut announce = json!({ "sessionUpdate": "subagent_update", "sessionId": child,
                "state": { "state": "running" }, "capabilities": { "cancel": {} } });
            if let Some(name) = name {
                announce["title"] = json!(name);
            }
            self.emit(parent, announce);
        }
        if let Some(prompt) = prompt.filter(|p| !p.is_empty()) {
            if known {
                self.emit(
                    parent,
                    json!({ "sessionUpdate": "subagent_update", "sessionId": child, "description": prompt }),
                );
            }
            self.emit(
                parent,
                json!({ "sessionUpdate": "session_message", "messageId": call, "senderSessionId": parent,
                    "recipientSessionId": child, "content": [{ "type": "text", "text": prompt }] }),
            );
        }
    }

    /// A thread codex started on its own: a subagent when its parent is a session here.
    fn thread_started(&self, thread: &Value) {
        let (Some(id), Some(parent)) =
            (thread.get("id").and_then(Value::as_str), thread.get("parentThreadId").and_then(Value::as_str))
        else {
            return;
        };
        let name = thread.get("agentNickname").or(thread.get("agentRole")).and_then(Value::as_str);
        let known = self.state.lock().threads.contains_key(id);
        self.spawned(parent, id, name, None, "");
        if known && let Some(name) = name {
            self.emit(parent, json!({ "sessionUpdate": "subagent_update", "sessionId": id, "title": name }));
        }
    }

    /// Reports a subagent thread's state on its parent.
    fn subagent_state(&self, thread: &str, state_of: Value) {
        let parent = self.state.lock().threads.get(thread).and_then(|t| t.parent.clone());
        if let Some(parent) = parent {
            self.emit(
                parent.as_str(),
                json!({ "sessionUpdate": "subagent_update", "sessionId": thread, "state": state_of }),
            );
        }
    }

    fn turn_completed(&self, thread: &str, turn: &Value) {
        let id = turn.get("id").and_then(Value::as_str).unwrap_or_default();
        let (parent, answer) = {
            let mut state = self.state.lock();
            let Some(t) = state.threads.get_mut(thread) else { return };
            if t.turn.as_deref().is_none_or(|r| r == id) {
                t.turn = None;
            }
            t.completed = Some(id.to_owned());
            t.items.clear();
            t.last_chunk = None;
            let error = t.error.take();
            if t.prompt.as_ref().is_some_and(|p| p.turn.as_deref().is_none_or(|p| p == id))
                && let Some(p) = t.prompt.take()
            {
                let _ = p.done.send((turn.clone(), error.clone()));
            }
            let answer = std::mem::take(&mut t.answer);
            (t.parent.clone(), (answer, error))
        };
        let Some(parent) = parent else { return };
        let (answer, error) = answer;
        let mut state_of = match turn.get("status").and_then(Value::as_str) {
            Some("interrupted") => json!({ "state": "idle", "stopReason": "cancelled" }),
            Some("failed") => json!({ "state": "idle", "stopReason": "error" }),
            _ => json!({ "state": "idle", "stopReason": "end_turn" }),
        };
        if let Some(e) = turn.get("error").filter(|e| !e.is_null()).or(error.as_ref()) {
            state_of["error"] = json!({ "code": codes::INTERNAL_ERROR, "message": translate::error_message(e) });
        }
        self.emit(&parent, json!({ "sessionUpdate": "subagent_update", "sessionId": thread, "state": state_of }));
        if !answer.is_empty() {
            self.emit(
                &parent,
                json!({ "sessionUpdate": "session_message", "messageId": format!("{thread}:{id}"),
                    "senderSessionId": thread, "recipientSessionId": parent,
                    "content": [{ "type": "text", "text": answer }] }),
            );
        }
    }

    /// Requests from codex: approvals and questions, asked as ACP permission requests.
    fn on_codex_request(&self, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        let thread = params.get("threadId").and_then(Value::as_str).unwrap_or_default().to_owned();
        let item_id = params.get("itemId").and_then(Value::as_str).unwrap_or_default().to_owned();
        let (item, cwd) = {
            let state = self.state.lock();
            let t = state.threads.get(&thread);
            (t.and_then(|t| t.items.get(&item_id).cloned()), t.and_then(|t| t.cwd.clone()))
        };
        let cwd = cwd.as_deref();
        let reason = params.get("reason").and_then(Value::as_str).filter(|r| !r.is_empty());
        let decline = json!({ "decision": "decline" });
        match method {
            "item/commandExecution/requestApproval" => {
                let choices = translate::decisions(params, true);
                let title = translate::command_approval_title(params, item.as_ref(), cwd);
                let call = tool_call_of(
                    &item_id,
                    &title,
                    "execute",
                    reason,
                    Some(json!({ "command": params.get("command"), "cwd": params.get("cwd") })),
                );
                Ok(self.ask(&thread, call, &choices, decline))
            }
            "item/fileChange/requestApproval" => {
                let choices = translate::decisions(params, false);
                let title = translate::file_approval_title(item.as_ref(), cwd);
                let mut call = tool_call_of(&item_id, &title, "edit", reason, None);
                if let Some(content) = item
                    .as_ref()
                    .and_then(|i| translate::tool_call(i, false, cwd, None))
                    .and_then(|c| c.get("content").cloned())
                {
                    call["content"] = content;
                }
                Ok(self.ask(&thread, call, &choices, decline))
            }
            "item/permissions/requestApproval" => {
                let requested = params.get("permissions").cloned().unwrap_or(json!({}));
                let choice = |id: &str, name: &str, kind: &str, answer: Value| Choice {
                    option: json!({ "optionId": id, "name": name, "kind": kind }),
                    answer,
                };
                let choices = [
                    choice(
                        "turn",
                        "Allow for this turn",
                        "allow_once",
                        json!({ "permissions": requested, "scope": "turn" }),
                    ),
                    choice(
                        "session",
                        "Allow for this session",
                        "allow_always",
                        json!({ "permissions": requested, "scope": "session" }),
                    ),
                    choice("decline", "Decline", "reject_once", json!({ "permissions": {}, "scope": "turn" })),
                ];
                let title = reason.map_or_else(|| "Allow more access".to_owned(), str::to_owned);
                let call = tool_call_of(&item_id, &title, "other", None, Some(requested.clone()));
                Ok(self.ask(&thread, call, &choices, json!({ "permissions": {}, "scope": "turn" })))
            }
            "item/tool/requestUserInput" => {
                let mut answers = serde_json::Map::new();
                for q in params.get("questions").and_then(Value::as_array).into_iter().flatten() {
                    let Some(qid) = q.get("id").and_then(Value::as_str) else { continue };
                    let choices: Vec<Choice> = q
                        .get("options")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .enumerate()
                        .filter_map(|(i, o)| {
                            let label = o.get("label")?.as_str()?;
                            Some(Choice {
                                option: json!({ "optionId": i.to_string(), "name": label, "kind": "allow_once" }),
                                answer: json!({ "answers": [label] }),
                            })
                        })
                        .collect();
                    if choices.is_empty() {
                        continue;
                    }
                    let title = q.get("question").and_then(Value::as_str).unwrap_or("Codex has a question");
                    let call = tool_call_of(&item_id, title, "other", None, None);
                    let answer = self.ask(&thread, call, &choices, Value::Null);
                    if !answer.is_null() {
                        answers.insert(qid.to_owned(), answer);
                    }
                }
                Ok(json!({ "answers": answers }))
            }
            "mcpServer/elicitation/request" => {
                let server = params.get("serverName").and_then(Value::as_str).unwrap_or("An MCP server");
                let message = params.get("message").and_then(Value::as_str).unwrap_or_default();
                let accept = match params.get("mode").and_then(Value::as_str) {
                    Some("url") => json!({ "action": "accept" }),
                    _ => json!({ "action": "accept", "content": {} }),
                };
                let choices = [
                    Choice {
                        option: json!({ "optionId": "accept", "name": "Accept", "kind": "allow_once" }),
                        answer: accept,
                    },
                    Choice {
                        option: json!({ "optionId": "decline", "name": "Decline", "kind": "reject_once" }),
                        answer: json!({ "action": "decline" }),
                    },
                ];
                let mut title = format!("{server}: {message}");
                if let Some(url) = params.get("url").and_then(Value::as_str) {
                    title.push_str(&format!(" ({url})"));
                }
                let call = tool_call_of(&format!("elicitation:{server}"), &title, "other", None, None);
                Ok(self.ask(&thread, call, &choices, json!({ "action": "decline" })))
            }
            _ => Err((codes::METHOD_NOT_FOUND, format!("unsupported request {method}"))),
        }
    }

    /// Asks the client; returns the answer for codex (`otherwise` when cancelled).
    fn ask(&self, session: &str, tool_call: Value, choices: &[Choice], otherwise: Value) -> Value {
        let Some(client) = self.client.get().cloned() else { return otherwise };
        let options: Vec<Value> = choices.iter().map(|c| c.option.clone()).collect();
        let params = json!({ "sessionId": session, "toolCall": tool_call, "options": options });
        let outcome: Result<Value, RpcError> =
            self.runtime.block_on(client.request("session/request_permission", params, None));
        match outcome {
            Ok(outcome) => translate::answer_of(choices, &outcome, otherwise),
            Err(e) => {
                tracing::debug!("codex: permission request failed: {e}");
                otherwise
            }
        }
    }
}

impl Thread {
    /// A text chunk of `item`; a new item of the same kind right after another starts a
    /// new paragraph.
    fn chunk(&mut self, kind: &'static str, item: &str, text: &str) -> Value {
        let text = match &self.last_chunk {
            Some((k, i)) if *k == kind && i != item => format!("\n\n{text}"),
            _ => text.to_owned(),
        };
        self.last_chunk = Some((kind, item.to_owned()));
        translate::chunk(kind, &text)
    }
}

/// The ACP `toolCall` of a permission request.
fn tool_call_of(id: &str, title: &str, kind: &str, reason: Option<&str>, raw: Option<Value>) -> Value {
    let mut call = json!({ "toolCallId": id, "title": title, "kind": kind, "status": "pending" });
    if let Some(reason) = reason {
        call["content"] = json!([{ "type": "content", "content": { "type": "text", "text": reason } }]);
    }
    if let Some(raw) = raw {
        call["rawInput"] = raw;
    }
    call
}

/// The `session/prompt` answer for a turn that ended.
fn stop_reason(turn: &Value, last_error: Option<Value>, rate_limits: Option<&Value>) -> Result<Value, ResponseError> {
    let stop = match turn.get("status").and_then(Value::as_str) {
        Some("interrupted") => "cancelled",
        Some("failed") => {
            let e = turn.get("error").filter(|e| !e.is_null()).cloned().or(last_error).unwrap_or(json!({}));
            let message = translate::error_message(&e);
            return match translate::classify(&e, rate_limits) {
                Failure::Refusal => Ok(json!({ "stopReason": "refusal" })),
                Failure::UsageLimit(resets) => Err(ResponseError {
                    code: codes::INTERNAL_ERROR,
                    message,
                    data: Some(json!({ "openidea": { "usageLimit": { "resetsAtMs": resets } } })),
                }),
                Failure::Auth => Err(error(AUTH_REQUIRED, format!("Codex authentication failed: {message}"))),
                Failure::Other => Err(error(codes::INTERNAL_ERROR, message)),
            };
        }
        _ => "end_turn",
    };
    Ok(json!({ "stopReason": stop }))
}
