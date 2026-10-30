//! Claude Code driven natively: `claude -p` in stream-json mode, the protocol the Claude
//! Agent SDK speaks to it, behind an in-process ACP endpoint.
//!
//! Each ACP session runs its own `claude` process, whose session id is the ACP one.
//! The CLI writes a session's transcript only once it has a message, so a fork or an
//! undo that has not been prompted yet is kept as a pending start (`<temp>/openidea-claude/
//! <id>.json`): loading that session, from this connection or a fresh one, starts it that
//! way.

mod cli;
mod history;
mod settings;
mod tools;
mod translate;

#[cfg(test)]
mod tests;

use cli::{Cli, Launch, OnStderr, Start};
use ide_core::CancellationToken;
use ide_jsonrpc::{Handler, Peer, RpcError, codes};
use parking_lot::Mutex;
use serde_json::{Value, json};
use settings::Settings;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use translate::{Translator, Update};

use crate::provider::ProviderSpec;

/// How long the CLI gets to answer a control request.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(60);
/// A stop that arrives this long before its prompt (the two race) still stops it.
const EARLY_CANCEL: Duration = Duration::from_secs(2);

/// Texts with which Claude Code reports a spent usage limit (the Agent SDK's
/// `USAGE_LIMIT_ERROR_PREFIXES`).
const USAGE_LIMIT_PREFIXES: &[&str] = &[
    "You've hit your",
    "You've reached your",
    "You're out of usage credits",
    "Your org is out of usage",
    "Your seat type doesn't include",
    "Your usage allocation has been disabled",
    "Your group's usage limit is set to $0",
    "You're out of extra usage",
];

pub(crate) fn connect(
    spec: &ProviderSpec,
    cwd: &Path,
    client: Arc<dyn Handler>,
    on_stderr: Box<dyn Fn(String) + Send + Sync>,
) -> std::io::Result<Peer> {
    let config = Config {
        program: super::newest_install(&spec.command),
        args: spec.args.clone(),
        env: spec.env.clone(),
        config_dir: cli::config_dir(&spec.env),
        pending_dir: std::env::temp_dir().join("openidea-claude"),
        cwd: cwd.to_path_buf(),
    };
    let shim = Shim::new(config, Arc::new(cli::Process), Arc::from(on_stderr));
    Ok(super::serve(shim, client))
}

struct Config {
    pub program: String,
    /// Extra arguments (a custom agent's), before the session's own.
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Claude Code's configuration directory, where transcripts live.
    pub config_dir: Option<PathBuf>,
    /// Pending starts of sessions not written yet.
    pub pending_dir: PathBuf,
    pub cwd: PathBuf,
}

pub(super) struct Shim {
    me: Weak<Shim>,
    /// Notifications arrive on a thread of their own, outside the runtime.
    rt: tokio::runtime::Handle,
    config: Config,
    cli: Arc<dyn Cli>,
    on_stderr: OnStderr,
    client: OnceLock<Peer>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// The client shows subagents as sessions (`clientCapabilities.subagents`).
    subagents: AtomicBool,
    closed: AtomicBool,
}

struct Session {
    id: String,
    cwd: PathBuf,
    shim: Weak<Shim>,
    st: Mutex<State>,
    /// Serializes (re)starting the process.
    starting: tokio::sync::Mutex<()>,
}

struct State {
    proc: Option<Arc<Proc>>,
    /// How the process starts next time.
    start: Start,
    /// `start` is saved as a pending start.
    pending: bool,
    settings: Settings,
    /// The user's choices, re-applied when the process restarts.
    chosen: Vec<(String, String)>,
    tr: Translator,
    turn: Option<Turn>,
    /// A stop that came while no turn ran.
    cancel_at: Option<Instant>,
    /// When the usage limit the CLI last reported as reached resets.
    limit_resets_ms: Option<f64>,
    terminal_only: Vec<String>,
    titled: bool,
}

struct Turn {
    /// The uuids of its messages: the prompt, then steers.
    uuids: Vec<String>,
    done: Option<oneshot::Sender<TurnEnd>>,
    cancelled: bool,
    failure: Option<TurnEnd>,
}

#[derive(Debug, Clone, PartialEq)]
enum TurnEnd {
    Stop(&'static str),
    Fail { message: String, data: Option<Value> },
}

struct Proc {
    tx: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    /// Client permission requests in flight, by the CLI's request id.
    asks: Mutex<HashMap<String, CancellationToken>>,
    kill: CancellationToken,
    next: AtomicU64,
    gone: AtomicBool,
}

type RpcResult = Result<Value, (i64, String, Option<Value>)>;

fn invalid(message: impl Into<String>) -> (i64, String, Option<Value>) {
    (codes::INVALID_PARAMS, message.into(), None)
}

fn internal(message: impl Into<String>) -> (i64, String, Option<Value>) {
    (codes::INTERNAL_ERROR, message.into(), None)
}

impl Proc {
    fn send(&self, msg: &Value) -> bool {
        !self.gone.load(Ordering::Acquire) && self.tx.send(msg.to_string()).is_ok()
    }

    async fn control(&self, request: Value) -> Result<Value, String> {
        let id = format!("req_{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id.clone(), tx);
        if !self.send(&json!({ "type": "control_request", "request_id": id, "request": request })) {
            self.pending.lock().remove(&id);
            return Err("Claude Code is not running".into());
        }
        match tokio::time::timeout(CONTROL_TIMEOUT, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("Claude Code exited".into()),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err("Claude Code did not answer".into())
            }
        }
    }

    fn end(&self) {
        self.gone.store(true, Ordering::Release);
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(Err("Claude Code exited".into()));
        }
        for (_, t) in self.asks.lock().drain() {
            t.cancel();
        }
    }
}

impl Shim {
    fn new(config: Config, cli: Arc<dyn Cli>, on_stderr: OnStderr) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            rt: tokio::runtime::Handle::current(),
            config,
            cli,
            on_stderr,
            client: OnceLock::new(),
            sessions: Mutex::new(HashMap::new()),
            subagents: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        })
    }

    fn notify(&self, updates: Vec<Update>) {
        let Some(client) = self.client.get() else { return };
        for u in updates {
            let _ = client.notify("session/update", json!({ "sessionId": u.session, "update": u.update }));
        }
    }

    fn session(&self, params: &Value) -> Result<Arc<Session>, (i64, String, Option<Value>)> {
        let id = params.get("sessionId").and_then(Value::as_str).unwrap_or_default();
        self.sessions.lock().get(id).cloned().ok_or_else(|| invalid(format!("unknown session {id}")))
    }

    fn cwd_of(&self, params: &Value) -> PathBuf {
        let cwd = params.get("cwd").and_then(Value::as_str).map_or_else(|| self.config.cwd.clone(), PathBuf::from);
        // The CLI works in the real directory (macOS /tmp is /private/tmp): its transcripts too.
        std::fs::canonicalize(&cwd).unwrap_or(cwd)
    }

    fn pending_path(&self, id: &str) -> PathBuf {
        self.config.pending_dir.join(format!("{id}.json"))
    }

    fn save_pending(&self, id: &str, start: Option<&Start>) {
        let path = self.pending_path(id);
        let result = match start {
            Some(s) => std::fs::create_dir_all(&self.config.pending_dir)
                .and_then(|()| std::fs::write(&path, serde_json::to_vec(&start_json(s)).unwrap_or_default())),
            None => std::fs::remove_file(&path).or_else(|e| match e.kind() {
                std::io::ErrorKind::NotFound => Ok(()),
                _ => Err(e),
            }),
        };
        if let Err(e) = result {
            tracing::warn!("claude session {id}: saving its pending start: {e}");
        }
    }

    fn load_pending(&self, id: &str) -> Option<Start> {
        let bytes = std::fs::read(self.pending_path(id)).ok()?;
        start_from_json(&serde_json::from_slice(&bytes).ok()?)
    }

    fn transcript(&self, cwd: &Path, id: &str) -> Option<PathBuf> {
        Some(history::transcript(self.config.config_dir.as_deref()?, cwd, id))
    }

    /// The conversation a session started with `start` begins with.
    fn base_chain(&self, cwd: &Path, start: &Start) -> Result<Vec<Value>, String> {
        let (id, at) = match start {
            Start::New { .. } => return Ok(Vec::new()),
            Start::Resume { id, at } => (id, at),
            Start::Fork { from, at, .. } => (from, at),
        };
        let path = self.transcript(cwd, id).ok_or("no Claude Code configuration directory")?;
        let entries = history::read(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
        Ok(history::chain(&entries, at.as_deref()).into_iter().cloned().collect())
    }

    fn add_session(self: &Arc<Self>, id: &str, cwd: PathBuf, start: Start, pending: bool) -> Arc<Session> {
        let session = Arc::new(Session {
            id: id.to_owned(),
            shim: Arc::downgrade(self),
            st: Mutex::new(State {
                proc: None,
                start,
                pending,
                settings: Settings::default(),
                chosen: Vec::new(),
                tr: Translator::new(id, cwd.clone(), self.subagents.load(Ordering::Acquire)),
                turn: None,
                cancel_at: None,
                limit_resets_ms: None,
                terminal_only: Vec::new(),
                titled: false,
            }),
            cwd,
            starting: tokio::sync::Mutex::new(()),
        });
        if let Some(old) = self.sessions.lock().insert(id.to_owned(), session.clone()) {
            old.stop();
        }
        session
    }

    /// `claude --version`: "2.1.312 (Claude Code)" → "2.1.312". Sessions start their own
    /// processes later, so `initialize` asks the CLI directly.
    fn version(&self) -> Option<String> {
        let mut cmd = std::process::Command::new(&self.config.program);
        ide_core::process::prepare(&mut cmd);
        let out = cmd.arg("--version").envs(ide_core::process::shell_env()).output().ok()?;
        let text = ide_core::output_encoding::decode_tool_output(&out.stdout);
        text.split_whitespace().next().filter(|v| out.status.success() && !v.is_empty()).map(str::to_owned)
    }

    fn handle(self: &Arc<Self>, method: &str, params: Value) -> RpcResult {
        let rt = &self.rt;
        match method {
            "initialize" => {
                let subagents = params.pointer("/clientCapabilities/subagents").is_some_and(Value::is_object);
                self.subagents.store(subagents, Ordering::Release);
                Ok(json!({
                    "protocolVersion": 1,
                    "agentCapabilities": {
                        "loadSession": true,
                        "promptCapabilities": { "image": true, "embeddedContext": true },
                        "sessionCapabilities": { "fork": {} },
                        "_meta": { "openidea": { "rollback": true, "steer": true } },
                    },
                    "agentInfo": { "name": "claude", "title": "Claude Code", "version": self.version() },
                    "authMethods": [],
                }))
            }
            "session/new" => {
                let id = new_uuid(false);
                let session = self.add_session(&id, self.cwd_of(&params), Start::New { id: id.clone() }, false);
                rt.block_on(session.ensure()).map_err(|e| self.start_error(&session, e))?;
                session.announce_commands();
                Ok(json!({ "sessionId": id, "configOptions": session.st.lock().settings.options() }))
            }
            "session/load" | "session/resume" => {
                let id = params.get("sessionId").and_then(Value::as_str).ok_or_else(|| invalid("no sessionId"))?;
                let cwd = self.cwd_of(&params);
                let (start, pending) = match self.load_pending(id) {
                    Some(s) => (s, true),
                    None if self.transcript(&cwd, id).is_some_and(|p| p.exists()) => {
                        (Start::Resume { id: id.to_owned(), at: None }, false)
                    }
                    None => return Err(invalid(format!("no Claude Code session {id} in {}", cwd.display()))),
                };
                let chain = self.base_chain(&cwd, &start).map_err(internal)?;
                let session = self.add_session(id, cwd, start, pending);
                rt.block_on(session.ensure()).map_err(|e| self.start_error(&session, e))?;
                if method == "session/load" {
                    session.replay(&chain);
                }
                session.announce_commands();
                Ok(json!({ "configOptions": session.st.lock().settings.options() }))
            }
            "session/fork" => {
                let source = self.session(&params)?;
                let id = new_uuid(false);
                let (start, settings) = {
                    let st = source.st.lock();
                    let start = match &st.start {
                        Start::New { .. } if !st.pending && st.titled_or_prompted() => {
                            Start::Fork { from: source.id.clone(), id: id.clone(), at: None }
                        }
                        Start::New { .. } => Start::New { id: id.clone() },
                        Start::Resume { id: from, at } | Start::Fork { from, at, .. } if st.pending => {
                            Start::Fork { from: from.clone(), id: id.clone(), at: at.clone() }
                        }
                        _ => Start::Fork { from: source.id.clone(), id: id.clone(), at: None },
                    };
                    (start, st.settings.clone())
                };
                self.save_pending(&id, Some(&start));
                let session = self.add_session(&id, source.cwd.clone(), start, true);
                session.st.lock().settings = settings;
                let options = session.st.lock().settings.options();
                Ok(json!({ "sessionId": id, "configOptions": options }))
            }
            "session/set_config_option" | "session/set_mode" => {
                let session = self.session(&params)?;
                let (option, value) = match method {
                    "session/set_mode" => (settings::MODE.to_owned(), params.get("modeId")),
                    _ => (
                        params.get("configId").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        params.get("value"),
                    ),
                };
                let value = value.and_then(Value::as_str).ok_or_else(|| invalid("no value"))?.to_owned();
                rt.block_on(session.set(&option, &value)).map_err(internal)?;
                Ok(match method {
                    "session/set_mode" => json!({}),
                    _ => json!({ "configOptions": session.st.lock().settings.options() }),
                })
            }
            "session/prompt" => {
                let session = self.session(&params)?;
                let prompt = params.get("prompt").cloned().unwrap_or_default();
                match rt.block_on(session.prompt(&prompt))? {
                    TurnEnd::Stop(reason) => Ok(json!({ "stopReason": reason })),
                    TurnEnd::Fail { message, data } => Err((codes::INTERNAL_ERROR, message, data)),
                }
            }
            "_openidea/steer" => {
                let session = self.session(&params)?;
                session.steer(params.get("prompt").cloned().unwrap_or_default()).map_err(invalid)?;
                Ok(json!({}))
            }
            "_openidea/rollback" => {
                let session = self.session(&params)?;
                let turns = params.get("turns").and_then(Value::as_u64).unwrap_or(0) as usize;
                rt.block_on(session.rollback(turns)).map_err(internal)?;
                Ok(json!({}))
            }
            "session/close" => {
                if let Ok(s) = self.session(&params) {
                    self.sessions.lock().remove(&s.id);
                    s.stop();
                }
                Ok(json!({}))
            }
            _ => Err((codes::METHOD_NOT_FOUND, format!("unsupported method {method}"), None)),
        }
    }

    /// Why a session could not start; it is dropped.
    fn start_error(&self, session: &Session, e: String) -> (i64, String, Option<Value>) {
        self.sessions.lock().remove(&session.id);
        let message = if e.to_lowercase().contains("login") || e.contains("401") {
            format!("Claude Code authentication failed: {e}")
        } else {
            e
        };
        internal(message)
    }

    fn cancel(self: &Arc<Self>, params: &Value) {
        let id = params.get("sessionId").and_then(Value::as_str).unwrap_or_default();
        let sessions = self.sessions.lock().clone();
        if let Some(s) = sessions.get(id) {
            s.cancel();
            return;
        }
        // A subagent: stop its task.
        for s in sessions.values() {
            let (agent, proc) = {
                let st = s.st.lock();
                (st.tr.agent_of(id), st.proc.clone())
            };
            if let (Some(task), Some(proc)) = (agent, proc) {
                self.rt.spawn(async move {
                    if let Err(e) = proc.control(json!({ "subtype": "stop_task", "task_id": task })).await {
                        tracing::debug!("stopping subagent {task}: {e}");
                    }
                });
                return;
            }
        }
    }
}

impl State {
    /// Whether the process ever ran a turn (its transcript exists).
    fn titled_or_prompted(&self) -> bool {
        self.titled || self.tr.used.is_some()
    }
}

impl Handler for Shim {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/cancel"
            && let Some(me) = self.self_arc()
        {
            me.cancel(&params);
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        self.on_request_with_data(method, params).map_err(|(c, m, _)| (c, m))
    }

    fn on_request_with_data(&self, method: &str, params: Value) -> RpcResult {
        let me = self.self_arc().ok_or_else(|| internal("closed"))?;
        me.handle(method, params)
    }
}

impl Shim {
    fn self_arc(&self) -> Option<Arc<Self>> {
        self.me.upgrade()
    }
}

impl super::Shim for Shim {
    fn attach(&self, client: Peer) {
        let _ = self.client.set(client.clone());
        // The client went away: so do the processes.
        let weak = self.me.clone();
        tokio::spawn(async move {
            client.closed().await;
            if let Some(me) = weak.upgrade() {
                me.closed.store(true, Ordering::Release);
                let sessions: Vec<Arc<Session>> = me.sessions.lock().drain().map(|(_, s)| s).collect();
                for s in sessions {
                    s.stop();
                }
            }
        });
    }
}

impl Session {
    fn shim(&self) -> Option<Arc<Shim>> {
        self.shim.upgrade()
    }

    fn proc(&self) -> Option<Arc<Proc>> {
        self.st.lock().proc.clone().filter(|p| !p.gone.load(Ordering::Acquire))
    }

    /// Kills the process (on purpose: the client stays).
    fn stop(&self) {
        let proc = self.st.lock().proc.take();
        if let Some(p) = proc {
            p.kill.cancel();
            p.end();
        }
        self.fail_turn("Claude Code was stopped.");
    }

    fn fail_turn(&self, message: &str) {
        let turn = self.st.lock().turn.take();
        if let Some(mut t) = turn
            && let Some(done) = t.done.take()
        {
            let end = if t.cancelled {
                TurnEnd::Stop("cancelled")
            } else {
                TurnEnd::Fail { message: message.into(), data: None }
            };
            let _ = done.send(end);
        }
    }

    /// Starts the process when it is not running.
    async fn ensure(self: &Arc<Self>) -> Result<Arc<Proc>, String> {
        let _guard = self.starting.lock().await;
        if let Some(p) = self.proc() {
            return Ok(p);
        }
        let start = self.st.lock().start.clone();
        self.launch(start).await
    }

    async fn launch(self: &Arc<Self>, start: Start) -> Result<Arc<Proc>, String> {
        let shim = self.shim().ok_or("closed")?;
        if let Some(old) = self.st.lock().proc.take() {
            old.kill.cancel();
            old.end();
        }
        let mut args = shim.config.args.clone();
        args.extend(start.args());
        let launch =
            Launch { program: shim.config.program.clone(), args, cwd: self.cwd.clone(), env: shim.config.env.clone() };
        let io = shim
            .cli
            .launch(&launch, shim.on_stderr.clone())
            .map_err(|e| format!("Couldn't start Claude Code (`{}`): {e}", shim.config.program))?;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let proc = Arc::new(Proc {
            tx,
            pending: Mutex::new(HashMap::new()),
            asks: Mutex::new(HashMap::new()),
            kill: io.kill.clone(),
            next: AtomicU64::new(1),
            gone: AtomicBool::new(false),
        });
        let mut stdin = io.stdin;
        let kill = io.kill.clone();
        tokio::spawn(async move {
            loop {
                let line = tokio::select! {
                    l = rx.recv() => l,
                    _ = kill.cancelled() => None,
                };
                let Some(line) = line else { break };
                let ok = stdin.write_all(line.as_bytes()).await.is_ok()
                    && stdin.write_all(b"\n").await.is_ok()
                    && stdin.flush().await.is_ok();
                if !ok {
                    break;
                }
            }
            let _ = stdin.shutdown().await;
        });
        let weak = Arc::downgrade(self);
        let reader_proc = proc.clone();
        let stdout = io.stdout;
        let kill = io.kill.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                let line = tokio::select! {
                    l = lines.next_line() => l.ok().flatten(),
                    _ = kill.cancelled() => None,
                };
                let Some(line) = line else { break };
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    if !line.trim().is_empty()
                        && let Some(s) = weak.upgrade().and_then(|s| s.shim())
                    {
                        (s.on_stderr)(line);
                    }
                    continue;
                };
                let Some(session) = weak.upgrade() else { break };
                session.on_cli(&reader_proc, msg);
            }
            reader_proc.end();
            if let Some(session) = weak.upgrade() {
                session.on_exit(&reader_proc);
            }
        });
        let init = proc.control(json!({ "subtype": "initialize" })).await?;
        let applied = proc.control(json!({ "subtype": "get_settings" })).await.unwrap_or_default();
        let chosen = {
            let mut st = self.st.lock();
            st.settings = Settings::from_cli(&init, &applied);
            st.proc = Some(proc.clone());
            st.start = start;
            st.chosen.clone()
        };
        for (option, value) in chosen {
            if let Err(e) = self.apply(&proc, &option, &value).await {
                tracing::warn!("claude session {}: setting {option} to {value}: {e}", self.id);
            }
        }
        Ok(proc)
    }

    async fn apply(&self, proc: &Proc, option: &str, value: &str) -> Result<(), String> {
        let request = match option {
            settings::MODE => json!({ "subtype": "set_permission_mode", "mode": value }),
            settings::MODEL => json!({ "subtype": "set_model", "model": value }),
            settings::EFFORT => {
                let level = if value == "default" { Value::Null } else { json!(value) };
                json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": level } })
            }
            _ => return Err(format!("no setting {option}")),
        };
        proc.control(request).await?;
        let mut st = self.st.lock();
        match option {
            settings::MODE => st.settings.mode = value.to_owned(),
            settings::MODEL => st.settings.set_model(value),
            _ => st.settings.effort = value.to_owned(),
        }
        Ok(())
    }

    async fn set(self: &Arc<Self>, option: &str, value: &str) -> Result<(), String> {
        let proc = self.ensure().await?;
        if !self.st.lock().settings.valid(option, value) {
            return Err(format!("{option} has no value {value}"));
        }
        self.apply(&proc, option, value).await?;
        let mut st = self.st.lock();
        st.chosen.retain(|(o, _)| o != option);
        st.chosen.push((option.to_owned(), value.to_owned()));
        Ok(())
    }

    fn announce_commands(self: &Arc<Self>) {
        let me = self.clone();
        // After the response that makes the session known.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let commands = me.st.lock().settings.commands.clone();
            if let Some(shim) = me.shim() {
                shim.notify(vec![Update {
                    session: me.id.clone(),
                    update: json!({ "sessionUpdate": "available_commands_update", "availableCommands": commands }),
                }]);
            }
        });
    }

    /// Sends the history of a loaded session.
    fn replay(&self, chain: &[Value]) {
        let mut updates = Vec::new();
        {
            let mut st = self.st.lock();
            for e in chain {
                match e.get("type").and_then(Value::as_str) {
                    Some("user") if history::is_turn_start(e) || e.pointer("/message/content").is_some() => {
                        let is_prompt = history::is_turn_start(e);
                        let msg = json!({ "type": "user", "message": e.get("message"),
                            "parent_tool_use_id": Value::Null, "tool_use_result": e.get("toolUseResult") });
                        updates.extend(if is_prompt { st.tr.on_history_user(&msg) } else { st.tr.on_message(&msg) });
                    }
                    Some("assistant") => {
                        let msg = json!({ "type": "assistant", "message": e.get("message"), "parent_tool_use_id": Value::Null });
                        updates.extend(st.tr.on_message(&msg));
                    }
                    _ => {}
                }
            }
            // Background subagents of the old process are gone.
            updates.extend(st.tr.stop_children());
            if let Some(title) = chain_title(self) {
                st.titled = true;
                updates.push(Update {
                    session: self.id.clone(),
                    update: json!({ "sessionUpdate": "session_info_update", "title": title }),
                });
            }
        }
        if let Some(shim) = self.shim() {
            shim.notify(updates);
        }
    }

    async fn prompt(self: &Arc<Self>, prompt: &Value) -> Result<TurnEnd, (i64, String, Option<Value>)> {
        let proc = self.ensure().await.map_err(internal)?;
        let uuid = new_uuid(false);
        let message = user_message(prompt, &uuid, false);
        let rx = {
            let mut st = self.st.lock();
            if st.turn.is_some() {
                return Err(invalid("a turn is already running"));
            }
            // Stopped before it got here.
            if st.cancel_at.take().is_some_and(|t| t.elapsed() < EARLY_CANCEL) {
                return Ok(TurnEnd::Stop("cancelled"));
            }
            let (tx, rx) = oneshot::channel();
            st.turn = Some(Turn { uuids: vec![uuid], done: Some(tx), cancelled: false, failure: None });
            if !proc.send(&message) {
                st.turn = None;
                return Err(internal("Claude Code is not running"));
            }
            rx
        };
        Ok(rx.await.unwrap_or_else(|_| TurnEnd::Fail { message: "Claude Code exited.".into(), data: None }))
    }

    fn steer(&self, prompt: Value) -> Result<(), String> {
        let uuid = new_uuid(true);
        let mut message = user_message(&prompt, &uuid, true);
        message["priority"] = json!("now");
        let mut st = self.st.lock();
        let proc = st.proc.clone().ok_or("Claude Code is not running")?;
        let turn = st.turn.as_mut().filter(|t| !t.cancelled).ok_or("no turn is running")?;
        turn.uuids.push(uuid);
        if !proc.send(&message) {
            return Err("Claude Code is not running".into());
        }
        Ok(())
    }

    fn cancel(&self) {
        let proc = {
            let mut st = self.st.lock();
            match st.turn.as_mut() {
                Some(t) => {
                    t.cancelled = true;
                    st.proc.clone()
                }
                None => {
                    st.cancel_at = Some(Instant::now());
                    None
                }
            }
        };
        if let (Some(proc), Some(shim)) = (proc, self.shim()) {
            shim.rt.spawn(async move {
                if let Err(e) = proc.control(json!({ "subtype": "interrupt", "cancel_queued": true })).await {
                    tracing::debug!("interrupting claude: {e}");
                }
            });
        }
    }

    async fn rollback(self: &Arc<Self>, turns: usize) -> Result<(), String> {
        let shim = self.shim().ok_or("closed")?;
        let _guard = self.starting.lock().await;
        let (start, pending) = {
            let st = self.st.lock();
            if st.turn.is_some() {
                return Err("stop the agent first".into());
            }
            (st.start.clone(), st.pending)
        };
        let base = if pending || !matches!(start, Start::New { .. }) {
            start.clone()
        } else {
            Start::Resume { id: self.id.clone(), at: None }
        };
        let chain = shim.base_chain(&self.cwd, &base)?;
        let refs: Vec<&Value> = chain.iter().collect();
        let cut = history::cut(&refs, turns)?;
        let next = match (&base, cut) {
            (Start::Fork { from, .. }, Some(at)) => {
                Start::Fork { from: from.clone(), id: self.id.clone(), at: Some(at) }
            }
            (Start::Fork { .. } | Start::New { .. }, None) => Start::New { id: self.id.clone() },
            (Start::Resume { .. }, Some(at)) => Start::Resume { id: self.id.clone(), at: Some(at) },
            (Start::Resume { .. }, None) => return Err("Claude Code can't drop every turn of a saved session".into()),
            (Start::New { .. }, Some(_)) => return Ok(()),
        };
        if turns == 0 && next == start {
            return Ok(());
        }
        shim.save_pending(&self.id, Some(&next));
        {
            let mut st = self.st.lock();
            st.pending = true;
            st.tr = Translator::new(&self.id, self.cwd.clone(), shim.subagents.load(Ordering::Acquire));
        }
        self.launch(next).await.map(|_| ())
    }

    /// The process ended. Unless it was stopped on purpose the client's connection goes
    /// too: its next turn starts over and loads the session.
    fn on_exit(&self, proc: &Arc<Proc>) {
        let current = self.st.lock().proc.as_ref().is_some_and(|p| Arc::ptr_eq(p, proc));
        if proc.kill.is_cancelled() || !current {
            return;
        }
        let updates = self.st.lock().tr.stop_children();
        let Some(shim) = self.shim() else { return };
        shim.notify(updates);
        self.fail_turn("Claude Code exited.");
        if !shim.closed.load(Ordering::Acquire)
            && let Some(client) = shim.client.get()
        {
            client.kill();
        }
    }

    fn on_cli(self: &Arc<Self>, proc: &Arc<Proc>, msg: Value) {
        let kind = msg.get("type").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "control_response" => {
                let r = msg.get("response").cloned().unwrap_or_default();
                let id = r.get("request_id").and_then(Value::as_str).unwrap_or_default();
                if let Some(tx) = proc.pending.lock().remove(id) {
                    let _ = tx.send(match r.get("subtype").and_then(Value::as_str) {
                        Some("success") => Ok(r.get("response").cloned().unwrap_or(Value::Null)),
                        _ => Err(r.get("error").and_then(Value::as_str).unwrap_or("failed").to_owned()),
                    });
                }
                return;
            }
            "control_request" => {
                let me = self.clone();
                let proc = proc.clone();
                tokio::spawn(async move { me.on_cli_request(&proc, msg).await });
                return;
            }
            "control_cancel_request" => {
                if let Some(t) =
                    msg.get("request_id").and_then(Value::as_str).and_then(|id| proc.asks.lock().remove(id))
                {
                    t.cancel();
                }
                return;
            }
            _ => {}
        }
        let mut updates = Vec::new();
        let mut finished = None;
        let mut read_title = false;
        {
            let mut st = self.st.lock();
            let st = &mut *st;
            match kind {
                "system" => match msg.get("subtype").and_then(Value::as_str) {
                    Some("init") => {
                        st.terminal_only = strings(msg.get("terminal_slash_commands"));
                    }
                    Some("status") => {
                        if let Some(mode) = msg.get("permissionMode").and_then(Value::as_str)
                            && mode != st.settings.mode
                        {
                            st.settings.mode = mode.to_owned();
                            updates.push(Update {
                                session: self.id.clone(),
                                update: json!({ "sessionUpdate": "current_mode_update", "currentModeId": mode }),
                            });
                            updates.push(Update {
                                session: self.id.clone(),
                                update: json!({ "sessionUpdate": "config_option_update", "configOptions": st.settings.options() }),
                            });
                        }
                    }
                    Some("commands_changed") => {
                        st.settings.commands = settings::commands(msg.get("commands"), &st.terminal_only);
                        updates.push(Update {
                            session: self.id.clone(),
                            update: json!({ "sessionUpdate": "available_commands_update", "availableCommands": st.settings.commands }),
                        });
                    }
                    Some("session_state_changed") if msg.get("state").and_then(Value::as_str) == Some("idle") => {
                        // A stopped turn whose result never came (stopped before it started).
                        if st.turn.as_ref().is_some_and(|t| t.cancelled) {
                            finished = st.turn.take().map(|t| (t, TurnEnd::Stop("cancelled")));
                        }
                    }
                    _ => updates.extend(st.tr.on_message(&msg)),
                },
                "rate_limit_event" => {
                    let info = msg.get("rate_limit_info").cloned().unwrap_or_default();
                    if info.get("status").and_then(Value::as_str) == Some("rejected") {
                        st.limit_resets_ms = info.get("resetsAt").and_then(Value::as_f64).map(|s| s * 1000.0);
                    }
                }
                "command_lifecycle" => {
                    let uuid = msg.get("command_uuid").and_then(Value::as_str);
                    let state = msg.get("state").and_then(Value::as_str);
                    let last = st.turn.as_ref().and_then(|t| t.uuids.last()).map(String::as_str);
                    if uuid.is_some() && uuid == last && matches!(state, Some("completed" | "cancelled")) {
                        let stop = if state == Some("cancelled") || st.turn.as_ref().is_some_and(|t| t.cancelled) {
                            "cancelled"
                        } else {
                            "end_turn"
                        };
                        finished = st.turn.take().map(|t| (t, TurnEnd::Stop(stop)));
                    }
                }
                "assistant" if msg.get("parent_tool_use_id").is_none_or(Value::is_null) => {
                    match failure_of(&msg, st.limit_resets_ms) {
                        Some(f) if st.turn.is_some() => {
                            if let Some(t) = st.turn.as_mut() {
                                t.failure = Some(f);
                            }
                        }
                        _ => updates.extend(st.tr.on_message(&msg)),
                    }
                }
                "result" => {
                    updates.extend(st.tr.on_result(&msg));
                    if st.pending {
                        // The CLI wrote the session: it resumes as it is from now on.
                        st.pending = false;
                        st.start = Start::Resume { id: self.id.clone(), at: None };
                        if let Some(shim) = self.shim() {
                            shim.save_pending(&self.id, None);
                        }
                    } else if matches!(st.start, Start::New { .. }) {
                        st.start = Start::Resume { id: self.id.clone(), at: None };
                    }
                    read_title = !st.titled;
                    if let Some(turn) = st.turn.as_ref()
                        && belongs(turn, &msg)
                    {
                        let turn = st.turn.take().unwrap_or_else(|| unreachable!());
                        let end = turn_end(&turn, &msg, st.limit_resets_ms);
                        finished = Some((turn, end));
                    }
                }
                _ => updates.extend(st.tr.on_message(&msg)),
            }
        }
        if let Some(shim) = self.shim() {
            shim.notify(updates);
        }
        if let Some((mut turn, end)) = finished
            && let Some(done) = turn.done.take()
        {
            let _ = done.send(end);
        }
        if read_title {
            self.read_title();
        }
    }

    /// Sends the title Claude Code gave the session, once it has one.
    fn read_title(self: &Arc<Self>) {
        let me = self.clone();
        tokio::task::spawn_blocking(move || {
            let Some(title) = chain_title(&me) else { return };
            me.st.lock().titled = true;
            if let Some(shim) = me.shim() {
                shim.notify(vec![Update {
                    session: me.id.clone(),
                    update: json!({ "sessionUpdate": "session_info_update", "title": title }),
                }]);
            }
        });
    }

    async fn on_cli_request(self: &Arc<Self>, proc: &Arc<Proc>, msg: Value) {
        let id = msg.get("request_id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let request = msg.get("request").cloned().unwrap_or_default();
        let result = match request.get("subtype").and_then(Value::as_str) {
            Some("can_use_tool") => Ok(self.can_use_tool(proc, &id, &request).await),
            Some(other) => Err(format!("unsupported request {other}")),
            None => Err("no subtype".to_owned()),
        };
        let response = match result {
            Ok(r) => json!({ "subtype": "success", "request_id": id, "response": r }),
            Err(e) => json!({ "subtype": "error", "request_id": id, "error": e }),
        };
        proc.send(&json!({ "type": "control_response", "response": response }));
    }

    /// Asks the client whether a tool may run; answers as a `PermissionResult`.
    async fn can_use_tool(self: &Arc<Self>, proc: &Arc<Proc>, request_id: &str, req: &Value) -> Value {
        let name = req.get("tool_name").and_then(Value::as_str).unwrap_or_default().to_owned();
        let input = req.get("input").cloned().unwrap_or_else(|| json!({}));
        let tool_use = req.get("tool_use_id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let deny = |message: &str| json!({ "behavior": "deny", "message": message, "toolUseID": tool_use });
        let Some(shim) = self.shim() else { return deny("The session closed.") };
        let Some(client) = shim.client.get().cloned() else { return deny("The session closed.") };
        let (session, mut updates) = {
            let mut st = self.st.lock();
            let session = st.tr.session_of_agent(req.get("agent_id").and_then(Value::as_str));
            let mut updates = st.tr.ensure_call(&tool_use, &name, &input, &session);
            updates.extend(st.tr.child_state(&session, true));
            (session, updates)
        };
        let call = self.st.lock().tr.tool_call(&tool_use, &name, &input);
        shim.notify(std::mem::take(&mut updates));
        let token = CancellationToken::new();
        proc.asks.lock().insert(request_id.to_owned(), token.clone());
        let ask = |call: Value, options: Value| {
            let client = client.clone();
            let token = token.clone();
            let session = session.clone();
            async move {
                let r: Result<Value, RpcError> = client
                    .request(
                        "session/request_permission",
                        json!({ "sessionId": session, "toolCall": call, "options": options }),
                        Some(token),
                    )
                    .await;
                r.ok()
                    .filter(|v| v.pointer("/outcome/outcome").and_then(Value::as_str) == Some("selected"))
                    .and_then(|v| v.pointer("/outcome/optionId").and_then(Value::as_str).map(str::to_owned))
            }
        };
        let answer = if name == "AskUserQuestion" {
            ask_questions(&input, &call, ask).await.map_or_else(
                || deny("The user didn't answer."),
                |answers| {
                    let mut updated = input.clone();
                    updated["answers"] = answers;
                    json!({ "behavior": "allow", "updatedInput": updated, "toolUseID": tool_use })
                },
            )
        } else {
            let options = permission_options(&name);
            let chosen = ask(call, options).await;
            permission_result(&name, &input, &tool_use, req.get("permission_suggestions"), chosen.as_deref())
        };
        proc.asks.lock().remove(request_id);
        let back = self.st.lock().tr.child_state(&session, false);
        shim.notify(back.into_iter().collect());
        answer
    }
}

/// The options of a permission request for tool `name`.
fn permission_options(name: &str) -> Value {
    if name == "ExitPlanMode" {
        return json!([
            { "optionId": "plan-accept-edits", "name": "Yes, and accept edits", "kind": "allow_always" },
            { "optionId": "plan-default", "name": "Yes, and ask before edits", "kind": "allow_once" },
            { "optionId": "reject", "name": "No, keep planning", "kind": "reject_once" },
        ]);
    }
    json!([
        { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
        { "optionId": "allow-always", "name": "Allow for this session", "kind": "allow_always" },
        { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
    ])
}

/// The CLI's `PermissionResult` for the option the user chose (`None`: cancelled).
fn permission_result(
    name: &str,
    input: &Value,
    tool_use: &str,
    suggestions: Option<&Value>,
    chosen: Option<&str>,
) -> Value {
    let allow = |updates: Option<Value>| {
        let mut r = json!({ "behavior": "allow", "updatedInput": input, "toolUseID": tool_use });
        if let Some(u) = updates {
            r["updatedPermissions"] = u;
        }
        r
    };
    let set_mode = |mode: &str| json!([{ "type": "setMode", "mode": mode, "destination": "session" }]);
    match chosen {
        Some("allow") => allow(None),
        Some("allow-always") => {
            // What Claude Code suggests remembering, for this session only.
            let mut rules: Vec<Value> = suggestions.and_then(Value::as_array).cloned().unwrap_or_default();
            for r in &mut rules {
                r["destination"] = json!("session");
            }
            if rules.is_empty() {
                rules.push(json!({ "type": "addRules", "rules": [{ "toolName": name }], "behavior": "allow", "destination": "session" }));
            }
            allow(Some(Value::Array(rules)))
        }
        Some("plan-accept-edits") => allow(Some(set_mode("acceptEdits"))),
        Some("plan-default") => allow(Some(set_mode("default"))),
        Some(_) => json!({ "behavior": "deny", "message": "The user declined this.", "toolUseID": tool_use }),
        None => json!({ "behavior": "deny", "message": "The user cancelled this request.", "toolUseID": tool_use }),
    }
}

/// `AskUserQuestion`: each question as a permission request whose options are its
/// answers; `None` when one is not answered.
async fn ask_questions<F, Fut>(input: &Value, call: &Value, ask: F) -> Option<Value>
where
    F: Fn(Value, Value) -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    let mut answers = serde_json::Map::new();
    for q in input.get("questions").and_then(Value::as_array).into_iter().flatten() {
        let question = q.get("question").and_then(Value::as_str).unwrap_or_default();
        let labels: Vec<&str> = q
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|o| o.get("label")?.as_str())
            .collect();
        let mut options: Vec<Value> = labels
            .iter()
            .enumerate()
            .map(|(i, l)| json!({ "optionId": format!("answer-{i}"), "name": l, "kind": "allow_once" }))
            .collect();
        options.push(json!({ "optionId": "reject", "name": "Skip", "kind": "reject_once" }));
        let mut call = call.clone();
        call["title"] = json!(question);
        let chosen = ask(call, Value::Array(options)).await?;
        let i: usize = chosen.strip_prefix("answer-")?.parse().ok()?;
        answers.insert(question.to_owned(), json!(labels.get(i)?));
    }
    Some(Value::Object(answers))
}

/// Whether `result` ends `turn`: it answers the turn's last message, or (stopped) any of
/// its messages, or names none (the CLI's own error before the turn began).
fn belongs(turn: &Turn, result: &Value) -> bool {
    if result.get("origin").is_some_and(|o| !o.is_null()) {
        return false;
    }
    let mut uuids = strings(result.get("user_message_uuids"));
    uuids.extend(result.get("user_message_uuid").and_then(Value::as_str).map(str::to_owned));
    if uuids.is_empty() {
        return true;
    }
    let last = turn.uuids.last();
    uuids.iter().any(|u| Some(u) == last) || turn.cancelled && uuids.iter().any(|u| turn.uuids.contains(u))
}

/// How `result` ends `turn`.
fn turn_end(turn: &Turn, result: &Value, limit_resets_ms: Option<f64>) -> TurnEnd {
    let s = |k: &str| result.get(k).and_then(Value::as_str);
    let aborted = s("terminal_reason").is_some_and(|r| r.starts_with("aborted"));
    if turn.cancelled || aborted {
        return TurnEnd::Stop("cancelled");
    }
    if let Some(f) = &turn.failure {
        return f.clone();
    }
    let status = result.get("api_error_status").and_then(Value::as_i64);
    let text = s("result").unwrap_or_default().trim().to_owned();
    if status == Some(429) || USAGE_LIMIT_PREFIXES.iter().any(|p| text.starts_with(p)) {
        return usage_limit(if text.is_empty() { "You've hit your usage limit." } else { &text }, limit_resets_ms);
    }
    if matches!(status, Some(401 | 403)) {
        return TurnEnd::Fail { message: format!("Claude Code authentication failed: {text}"), data: None };
    }
    let failed =
        result.get("is_error").and_then(Value::as_bool) == Some(true) || s("subtype").is_some_and(|t| t != "success");
    if failed {
        let errors: Vec<String> =
            strings(result.get("errors")).into_iter().filter(|e| !e.starts_with("[ede_diagnostic]")).collect();
        let message = if !text.is_empty() {
            text
        } else if !errors.is_empty() {
            errors.join("\n")
        } else {
            format!("Claude Code failed ({}).", s("subtype").unwrap_or("error"))
        };
        return TurnEnd::Fail { message, data: None };
    }
    TurnEnd::Stop(match s("stop_reason") {
        Some("max_tokens") => "max_tokens",
        Some("refusal") => "refusal",
        _ => "end_turn",
    })
}

/// A main-conversation assistant message that reports a failure instead of answering.
fn failure_of(msg: &Value, limit_resets_ms: Option<f64>) -> Option<TurnEnd> {
    let message = msg.get("message")?;
    let text: String = message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let synthetic = message.get("model").and_then(Value::as_str) == Some("<synthetic>");
    let error = msg.get("error").and_then(Value::as_str);
    if error == Some("rate_limit") || synthetic && USAGE_LIMIT_PREFIXES.iter().any(|p| text.starts_with(p)) {
        let resets = msg
            .pointer("/api_error_params/rate_limit_info/resetsAt")
            .and_then(Value::as_f64)
            .map(|s| s * 1000.0)
            .or(limit_resets_ms);
        return Some(usage_limit(if text.is_empty() { "You've hit your usage limit." } else { &text }, resets));
    }
    if matches!(error, Some("authentication_failed" | "oauth_org_not_allowed"))
        || synthetic && text.contains("Please run /login")
    {
        return Some(TurnEnd::Fail { message: format!("Claude Code authentication failed: {text}"), data: None });
    }
    if let Some(e) = error.filter(|_| synthetic) {
        return Some(TurnEnd::Fail {
            message: if text.is_empty() { format!("Claude Code failed: {e}") } else { text },
            data: None,
        });
    }
    None
}

fn usage_limit(text: &str, resets_ms: Option<f64>) -> TurnEnd {
    TurnEnd::Fail {
        message: text.to_owned(),
        data: Some(json!({ "openidea": { "usageLimit": { "resetsAtMs": resets_ms } } })),
    }
}

/// The CLI's user message for ACP content blocks, as the Agent SDK sends a prompt.
fn user_message(prompt: &Value, uuid: &str, steer: bool) -> Value {
    let mut content = Vec::new();
    let mut context = Vec::new();
    for block in prompt.as_array().into_iter().flatten() {
        let s = |k: &str| block.get(k).and_then(Value::as_str).unwrap_or_default();
        match s("type") {
            "text" => content.push(json!({ "type": "text", "text": s("text") })),
            "resource_link" => content.push(json!({ "type": "text", "text": link(s("uri")) })),
            "resource" => {
                let r = block.get("resource").cloned().unwrap_or_default();
                let uri = r.get("uri").and_then(Value::as_str).unwrap_or_default();
                if let Some(text) = r.get("text").and_then(Value::as_str) {
                    content.push(json!({ "type": "text", "text": link(uri) }));
                    context.push(
                        json!({ "type": "text", "text": format!("\n<context ref=\"{uri}\">\n{text}\n</context>") }),
                    );
                }
            }
            "image" if !s("data").is_empty() => content.push(json!({
                "type": "image", "source": { "type": "base64", "data": s("data"), "media_type": s("mimeType") },
            })),
            "image" if s("uri").starts_with("http") => {
                content.push(json!({ "type": "image", "source": { "type": "url", "url": s("uri") } }))
            }
            _ => {}
        }
    }
    content.extend(context);
    let _ = steer;
    json!({
        "type": "user",
        "uuid": uuid,
        "session_id": "",
        "parent_tool_use_id": Value::Null,
        "origin": { "kind": "human" },
        "message": { "role": "user", "content": content },
    })
}

/// A file reference as Claude Code's `@` mention.
fn link(uri: &str) -> String {
    match uri.strip_prefix("file://") {
        Some(path) => format!("[@{}]({uri})", path.rsplit('/').next().unwrap_or(path)),
        None => uri.to_owned(),
    }
}

/// A fresh message or session uuid; steers end with [`history::STEER_MARK`], others never.
fn new_uuid(steer: bool) -> String {
    loop {
        let mut id = uuid::Uuid::new_v4().to_string();
        if steer {
            id.replace_range(id.len() - history::STEER_MARK.len().., history::STEER_MARK);
            return id;
        }
        if !id.ends_with(history::STEER_MARK) {
            return id;
        }
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(|s| s.as_str().map(str::to_owned)).collect()
}

/// The title in a session's transcript (or that of the session it continues).
fn chain_title(session: &Session) -> Option<String> {
    let shim = session.shim()?;
    let path = shim.transcript(&session.cwd, &session.id).filter(|p| p.exists())?;
    history::title(&history::read(&path).ok()?)
}

fn start_json(start: &Start) -> Value {
    match start {
        Start::New { id } => json!({ "new": id }),
        Start::Resume { id, at } => json!({ "resume": id, "at": at }),
        Start::Fork { from, id, at } => json!({ "fork": from, "id": id, "at": at }),
    }
}

fn start_from_json(v: &Value) -> Option<Start> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    if let Some(id) = s("new") {
        return Some(Start::New { id });
    }
    if let Some(id) = s("resume") {
        return Some(Start::Resume { id, at: s("at") });
    }
    Some(Start::Fork { from: s("fork")?, id: s("id")?, at: s("at") })
}
