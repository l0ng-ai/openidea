//! Coding agents (Claude Code, Codex, Gemini CLI…) driven over the Agent Client Protocol.
//!
//! A task is one agent conversation, working in its own git worktree or in the project
//! checkout. Each task runs its agent's ACP server as a child process (newline-delimited
//! JSON-RPC over stdio), folds `session/update` notifications into a timeline, and streams
//! timeline and status changes to the subscribed window. Tasks are saved under the
//! project's store directory and survive restarts; the agent session is reloaded on the
//! next prompt when the agent supports `session/load`.

mod acp;
mod config;
mod conversation;
mod model;
mod native;
mod provider;
pub mod registry;
mod skills;
mod timeline;
mod worktree;

pub use model::*;

use conversation::{Conversation, SavedSubagent, Session};
use ide_core::{IdeError, IdeResult, IpcPath};
use ide_jsonrpc::{Framing, Handler, Peer, RpcError, codes};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

/// Receives the events of one project's tasks.
pub type AgentSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Entry changes are batched for this long before they are sent.
const FLUSH_DELAY: Duration = Duration::from_millis(40);
/// Updates that arrive this late after `session/load` returns are still replayed history.
const REPLAY_GRACE: Duration = Duration::from_millis(300);
/// Notifications are delivered on their own thread: the last `session/update`s of a turn
/// can trail its `session/prompt` response by this much.
const TURN_GRACE: Duration = Duration::from_millis(100);
const STDERR_LINES: usize = 20;
/// Updates of a session's state rather than its conversation.
const SESSION_STATE: [&str; 5] =
    ["session_info_update", "config_option_update", "current_mode_update", "available_commands_update", "usage_update"];
/// A native agent's own update: it is about to retry a failed API request (see [`AgentRetry`]).
pub(crate) const RETRY_UPDATE: &str = "openidea_retry";
/// Referenced files up to this size are embedded in the prompt (when the agent takes it).
const MAX_EMBED: u64 = 256 * 1024;
/// How long a probe waits for the agent to answer `initialize`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// The agent tasks of one project.
pub struct AgentManager {
    shared: Arc<Shared>,
    tasks: RwLock<HashMap<String, Arc<Task>>>,
}

pub struct AgentPaths {
    pub project_root: PathBuf,
    /// One `<task id>.json` per task.
    pub store_dir: PathBuf,
    /// Parent of the tasks' worktrees.
    pub worktrees_dir: PathBuf,
    /// Settings each agent offered last time (shared by all projects), and its commands per project.
    pub models_file: PathBuf,
    /// User-defined agents, one `<id>.toml` each (`name`, `command`, `args`, `env`).
    pub custom_agents_dir: Option<PathBuf>,
    /// The user's home: its `.claude` holds their own skills and commands.
    pub home_dir: Option<PathBuf>,
}

/// Starts the ACP server of a provider in a directory, speaking to `client`.
type Connector = Arc<
    dyn Fn(&provider::ProviderSpec, &Path, Arc<dyn Handler>, Box<dyn Fn(String) + Send + Sync>) -> std::io::Result<Peer>
        + Send
        + Sync,
>;

struct Shared {
    paths: AgentPaths,
    runtime: tokio::runtime::Handle,
    connector: Connector,
    sink: RwLock<Option<AgentSink>>,
    known: Mutex<HashMap<String, Known>>,
    providers: RwLock<Vec<provider::ProviderSpec>>,
    /// Last probe of each provider.
    probes: Mutex<HashMap<String, AgentProbe>>,
}

/// What an agent offered in its last session, for the New Task page.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Known {
    #[serde(default)]
    config: Vec<AgentConfigOption>,
    /// By project root: skills and custom commands differ per project.
    #[serde(default, rename = "projectCommands")]
    commands: HashMap<String, Vec<AgentCommand>>,
}

impl Shared {
    fn spec(&self, id: &str) -> Option<provider::ProviderSpec> {
        self.providers.read().iter().find(|p| p.id == id).cloned()
    }

    fn emit(&self, event: AgentEvent) {
        let sink = self.sink.read().clone();
        if let Some(sink) = sink {
            sink(event);
        }
    }

    fn known_config(&self, provider: &str) -> Vec<AgentConfigOption> {
        let mut config = self.known.lock().get(provider).map(|k| k.config.clone()).unwrap_or_default();
        config::add_client_options(provider, &mut config);
        // Approval bypass belongs to the conversation, never to another new task.
        if let Some(o) = config.iter_mut().find(|o| o.id == config::CURSOR_APPROVAL) {
            o.current = Some("ask".into());
        }
        config
    }

    /// The commands the agent offered last time in this project.
    fn known_commands(&self, provider: &str) -> Vec<AgentCommand> {
        let cache = self.known.lock();
        cache.get(provider).and_then(|k| k.commands.get(&self.root_key())).cloned().unwrap_or_default()
    }

    fn root_key(&self) -> String {
        self.paths.project_root.to_string_lossy().into_owned()
    }

    fn remember(&self, provider: &str, config: Option<&[AgentConfigOption]>, commands: Option<&[AgentCommand]>) {
        let snapshot = {
            let mut cache = self.known.lock();
            let known = cache.entry(provider.to_owned()).or_default();
            let mut changed = false;
            if let Some(c) = config.filter(|c| !c.is_empty() && known.config != *c) {
                known.config = c.to_vec();
                changed = true;
            }
            let root = self.root_key();
            if let Some(c) =
                commands.filter(|c| !c.is_empty() && known.commands.get(&root).map(Vec::as_slice) != Some(c))
            {
                known.commands.insert(root, c.to_vec());
                changed = true;
            }
            if !changed {
                return;
            }
            serde_json::to_vec_pretty(&*cache)
        };
        if let Ok(bytes) = snapshot
            && let Err(e) = write_file(&self.paths.models_file, &bytes)
        {
            tracing::warn!("saving agent settings: {e}");
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskFile {
    task: AgentTask,
    session_id: Option<String>,
    entries: Vec<AgentEntry>,
    /// Settings the user chose, re-applied to every new or reloaded session.
    #[serde(default)]
    wanted: Vec<AgentConfigChoice>,
    /// In the project's own checkout: files already changed when the task started.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    before: BTreeMap<String, worktree::Stamp>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    subagents: Vec<SavedSubagent>,
    /// Turns to drop from the session once it is loaded (a fork of an earlier point).
    #[serde(default, skip_serializing_if = "is_zero")]
    pending_rollback: u32,
}

struct TaskState {
    task: AgentTask,
    session_id: Option<String>,
    conversation: Conversation,
    wanted: Vec<AgentConfigChoice>,
    before: Arc<BTreeMap<String, worktree::Stamp>>,
    pending_rollback: u32,
    /// A turn is running or about to (prompts arriving now are queued).
    busy: bool,
}

/// A running agent and its session.
#[derive(Clone)]
struct Live {
    peer: acp::Conn,
    session: String,
    capabilities: AgentCapabilities,
    /// `promptCapabilities.embeddedContext`: referenced files are sent with their text.
    embedded: bool,
}

struct Task {
    id: String,
    shared: Arc<Shared>,
    state: Mutex<TaskState>,
    live: Mutex<Option<Live>>,
    /// Serializes starting the agent.
    connecting: tokio::sync::Mutex<()>,
    /// Unanswered permission requests: where to send the chosen option id.
    permissions: Mutex<HashMap<u32, std::sync::mpsc::Sender<Option<String>>>>,
    next_permission: AtomicU32,
    /// Set while `session/load` replays history we already have.
    replaying: AtomicBool,
    /// The current turn is being cancelled to send the first queued message right away.
    send_now: AtomicBool,
    /// The user stopped the current turn. A stop that reaches the agent before it took the
    /// prompt can be ignored, so it is sent again once the turn shows signs of life.
    cancel_pending: AtomicBool,
    /// The agent reported something for the current turn.
    turn_started: AtomicBool,
    /// Settings already sent this session (`(option, value)`), so a refusal is not retried.
    config_sent: Mutex<HashSet<(String, String)>>,
    dirty: Mutex<BTreeSet<(Session, usize)>>,
    flush_scheduled: AtomicBool,
    stderr: Mutex<VecDeque<String>>,
    /// Set by `delete`; held while saving.
    deleted: Mutex<bool>,
}

impl AgentManager {
    /// Loads the project's saved tasks. Spawned work runs on `runtime`.
    pub fn new(paths: AgentPaths, runtime: tokio::runtime::Handle) -> Self {
        let connector: Connector = Arc::new(|spec, cwd, client, on_stderr| match spec.driver {
            provider::Driver::Acp => {
                Peer::spawn_framed(&spec.command, &spec.args, cwd, &spec.env, client, on_stderr, Framing::Lines)
            }
            provider::Driver::Codex => native::codex::connect(spec, cwd, client, on_stderr),
            provider::Driver::Claude => native::claude::connect(spec, cwd, client, on_stderr),
        });
        Self::with_connector(paths, runtime, connector)
    }

    fn with_connector(paths: AgentPaths, runtime: tokio::runtime::Handle, connector: Connector) -> Self {
        let known =
            std::fs::read(&paths.models_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let providers = RwLock::new(provider::load(paths.custom_agents_dir.as_deref()));
        let shared = Arc::new(Shared {
            paths,
            runtime,
            connector,
            sink: RwLock::new(None),
            known: Mutex::new(known),
            providers,
            probes: Mutex::new(HashMap::new()),
        });
        let mut tasks = HashMap::new();
        for file in std::fs::read_dir(&shared.paths.store_dir).into_iter().flatten().flatten() {
            let path = file.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            match std::fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()))
                .and_then(|v| serde_json::from_value::<TaskFile>(upgrade(v)).map_err(|e| e.to_string()))
            {
                Ok(mut f) => {
                    // The agent process did not survive the restart: whatever was in flight is over.
                    if matches!(f.task.status, AgentStatus::Running | AgentStatus::NeedsInput | AgentStatus::Starting) {
                        f.task.status = AgentStatus::Ready;
                    }
                    f.task.retry = None;
                    let task = Task::restore(f, shared.clone());
                    task.state.lock().conversation.settle(now_ms());
                    tasks.insert(task.id.clone(), task);
                }
                Err(e) => tracing::warn!("skipping agent task {}: {e}", path.display()),
            }
        }
        Self { shared, tasks: RwLock::new(tasks) }
    }

    /// Routes events to `sink` (replacing the previous subscriber); returns every task.
    pub fn subscribe(&self, sink: AgentSink) -> Vec<AgentTask> {
        *self.shared.sink.write() = Some(sink);
        let mut tasks: Vec<AgentTask> = self.tasks.read().values().map(|t| t.state.lock().task.clone()).collect();
        tasks.sort_by(|a, b| b.updated_ms.total_cmp(&a.updated_ms));
        tasks
    }

    /// The agents (custom ones re-read), whether each is installed, and what they offered last time.
    pub fn providers(&self) -> Vec<AgentProvider> {
        let specs = provider::load(self.shared.paths.custom_agents_dir.as_deref());
        let list = specs
            .iter()
            .map(|p| AgentProvider {
                id: p.id.clone(),
                name: p.name.clone(),
                command: std::iter::once(p.command.as_str())
                    .chain(p.args.iter().map(String::as_str))
                    .collect::<Vec<_>>()
                    .join(" "),
                installed: provider::installed(&p.command),
                config: self.shared.known_config(&p.id),
                commands: self.shared.known_commands(&p.id),
                source: p.source.clone(),
            })
            .collect();
        *self.shared.providers.write() = specs;
        list
    }

    /// The slash commands to complete for `provider`, in `task`'s directory or (without one)
    /// in the project: what the agent offered last time there, plus, for Claude Code, the
    /// skills and custom commands on disk it has not listed.
    pub async fn commands(&self, provider: &str, task: Option<&str>) -> IdeResult<Vec<AgentCommand>> {
        let (provider, offered, cwd) = match task {
            Some(id) => {
                let task = self.task(id)?;
                let s = task.state.lock();
                (s.task.provider.clone(), s.task.commands.clone(), s.task.cwd.0.clone())
            }
            None => (provider.to_owned(), self.shared.known_commands(provider), self.shared.paths.project_root.clone()),
        };
        if provider != "claude" && provider != "claude-acp" {
            return Ok(offered);
        }
        let home = self.shared.paths.home_dir.clone();
        let found = blocking(move || Ok(skills::discover(&cwd, home.as_deref()))).await?;
        Ok(skills::merge(offered, found))
    }

    fn task(&self, id: &str) -> IdeResult<Arc<Task>> {
        self.tasks.read().get(id).cloned().ok_or_else(|| IdeError::not_found(format!("no agent task {id}")))
    }

    /// The entries of the task's conversation, or of its subagent `subagent`'s.
    pub fn entries(&self, id: &str, subagent: Option<String>) -> IdeResult<Vec<AgentEntry>> {
        let task = self.task(id)?;
        let s = task.state.lock();
        let timeline = s.conversation.timeline(&subagent).ok_or_else(|| IdeError::not_found("no such subagent"))?;
        Ok(timeline.entries.clone())
    }

    /// Creates the task (and its worktree) and sends `req.prompt` as its first message.
    pub async fn create(&self, req: NewAgentTask) -> IdeResult<AgentTask> {
        let spec = self
            .shared
            .spec(&req.provider)
            .ok_or_else(|| IdeError::invalid(format!("unknown agent {}", req.provider)))?;
        let prompt = clean(req.prompt).ok_or_else(|| IdeError::invalid("describe the task first"))?;
        let title = title_of(&prompt);
        let root = self.shared.paths.project_root.clone();
        let (cwd, branch, base, base_commit, before) = match req.isolation {
            Isolation::Worktree => {
                let dir = self.shared.paths.worktrees_dir.clone();
                let (t, b) = (title.clone(), req.base.clone());
                let c = blocking(move || worktree::create(&root, &dir, &t, b.as_deref())).await?;
                (c.path, Some(c.branch), Some(c.base), Some(c.base_commit), BTreeMap::new())
            }
            Isolation::Local => {
                let r = root.clone();
                let (head, before) =
                    blocking(move || Ok((worktree::head_of(&r).ok(), worktree::snapshot(&r).unwrap_or_default())))
                        .await?;
                let (base, commit) = head.unzip();
                (root, None, base, commit, before)
            }
        };
        // Until the session reports its own, show what the agent offered last time with the choices applied.
        let mut config = self.shared.known_config(&spec.id);
        for choice in &req.config {
            if let Some(o) = config.iter_mut().find(|o| o.id == choice.id) {
                o.current = Some(choice.value.clone());
            }
        }
        let now = now_ms();
        let task = AgentTask {
            id: uuid::Uuid::new_v4().simple().to_string(),
            title,
            provider: spec.id.clone(),
            model: model_of(&config),
            status: AgentStatus::Starting,
            isolation: req.isolation,
            cwd: IpcPath(cwd),
            branch,
            base,
            base_commit,
            error: None,
            created_ms: now,
            updated_ms: now,
            config,
            commands: self.shared.known_commands(&spec.id),
            usage: None,
            queue: Vec::new(),
            capabilities: self.shared.probes.lock().get(&spec.id).map(|p| p.capabilities).unwrap_or_default(),
            resets_ms: None,
            retry: None,
        };
        let file = TaskFile {
            task: task.clone(),
            session_id: None,
            entries: Vec::new(),
            wanted: req.config,
            before,
            subagents: Vec::new(),
            pending_rollback: 0,
        };
        let handle = Task::restore(file, self.shared.clone());
        handle.state.lock().busy = true;
        self.tasks.write().insert(task.id.clone(), handle.clone());
        handle.emit_task();
        handle.persist();
        self.shared.runtime.spawn(async move { handle.run(prompt).await });
        Ok(task)
    }

    /// Sends a message. While the agent works it is queued, or with `now` the current turn
    /// is cancelled and the message goes next.
    pub async fn prompt(&self, id: &str, prompt: AgentPrompt, now: bool) -> IdeResult<()> {
        let task = self.task(id)?;
        let prompt = clean(prompt).ok_or_else(|| IdeError::invalid("empty message"))?;
        // An agent that takes messages mid-turn gets it right away.
        let prompt = match now {
            true => match task.steer(prompt).await {
                Ok(()) => return Ok(()),
                Err(prompt) => prompt,
            },
            false => prompt,
        };
        let start = {
            let mut s = task.state.lock();
            if s.task.status == AgentStatus::Archived {
                return Err(IdeError::invalid("the task is archived"));
            }
            if s.busy {
                let item = AgentQueued { id: uuid::Uuid::new_v4().simple().to_string(), prompt };
                if now {
                    s.task.queue.insert(0, item);
                } else {
                    s.task.queue.push(item);
                }
                None
            } else {
                s.busy = true;
                Some(prompt)
            }
        };
        match start {
            Some(prompt) => {
                self.shared.runtime.spawn(async move { task.run(prompt).await });
            }
            None => {
                task.persist();
                task.emit_task();
                if now {
                    task.send_now.store(true, Ordering::Release);
                    task.cancel();
                }
            }
        }
        Ok(())
    }

    /// Drops a queued message.
    pub fn unqueue(&self, id: &str, queued: &str) -> IdeResult<AgentQueued> {
        let task = self.task(id)?;
        let item = {
            let mut s = task.state.lock();
            let i =
                s.task.queue.iter().position(|q| q.id == queued).ok_or_else(|| IdeError::not_found("already sent"))?;
            s.task.queue.remove(i)
        };
        task.persist();
        task.emit_task();
        Ok(item)
    }

    /// Sends queued message `queued` next, cancelling the current turn if there is one.
    pub fn send_queued_now(&self, id: &str, queued: &str) -> IdeResult<()> {
        let task = self.task(id)?;
        let idle = {
            let mut s = task.state.lock();
            let i =
                s.task.queue.iter().position(|q| q.id == queued).ok_or_else(|| IdeError::not_found("already sent"))?;
            let item = s.task.queue.remove(i);
            if s.busy {
                s.task.queue.insert(0, item);
                None
            } else {
                s.busy = true;
                Some(item)
            }
        };
        task.persist();
        task.emit_task();
        match idle {
            Some(item) => {
                self.shared.runtime.spawn(async move { task.run(item.prompt).await });
            }
            None => {
                task.send_now.store(true, Ordering::Release);
                task.cancel();
            }
        }
        Ok(())
    }

    /// Changes a session setting (model, mode…): right away when the agent runs, else when it next starts.
    pub async fn set_config(&self, id: &str, option: &str, value: String) -> IdeResult<()> {
        let task = self.task(id)?;
        let target = {
            let s = task.state.lock();
            let o =
                s.task.config.iter().find(|o| o.id == option).ok_or_else(|| IdeError::not_found("no such setting"))?;
            if !o.values.iter().any(|v| v.value == value) {
                return Err(IdeError::invalid(format!("{} has no value {value}", o.name)));
            }
            o.clone()
        };
        let live = task.live.lock().clone().filter(|l| !l.peer.is_closed());
        if let Some(live) = live.filter(|_| option != config::CURSOR_APPROVAL) {
            let (method, mut params) = config::set_request(&target, &value);
            params["sessionId"] = json!(live.session);
            let reply: Value =
                live.peer.request(method, params, None).await.map_err(|e| IdeError::internal(task.describe(e)))?;
            if let Some(options) = reply.get("configOptions") {
                config::merge_update(&mut task.state.lock().task.config, options);
            }
        }
        {
            let mut s = task.state.lock();
            s.wanted.retain(|c| c.id != option);
            s.wanted.push(AgentConfigChoice { id: option.to_owned(), value: value.clone() });
            if let Some(o) = s.task.config.iter_mut().find(|o| o.id == option) {
                o.current = Some(value);
            }
            s.task.model = model_of(&s.task.config).or(s.task.model.take());
        }
        task.approve_pending();
        task.persist();
        task.emit_task();
        Ok(())
    }

    /// Copies the task's conversation into a new task in the same directory, up to its
    /// first `turns` turns (all of them when `None`). The copy loads its own session on
    /// its first message.
    pub async fn fork(&self, id: &str, turns: Option<u32>) -> IdeResult<AgentTask> {
        let source = self.task(id)?;
        if source.state.lock().busy {
            return Err(IdeError::invalid("wait until the agent is done"));
        }
        let live = source.ensure_session().await.map_err(IdeError::internal)?;
        let total = turn_starts(&source.state.lock().conversation.main.entries).len() as u32;
        let keep = turns.unwrap_or(total).min(total);
        if !live.capabilities.fork || (keep < total && !live.capabilities.rollback) {
            return Err(IdeError::invalid("this agent can't copy a conversation from there"));
        }
        let cwd = source.state.lock().task.cwd.0.clone();
        let cwd_s = dunce::canonicalize(&cwd).unwrap_or(cwd).to_string_lossy().into_owned();
        let reply: Value = live
            .peer
            .request("session/fork", json!({ "sessionId": live.session, "cwd": cwd_s, "mcpServers": [] }), None)
            .await
            .map_err(|e| IdeError::internal(source.describe(e)))?;
        let session = reply
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| IdeError::internal("the agent returned no session"))?
            .to_owned();
        let file = {
            let s = source.state.lock();
            let mut entries = s.conversation.main.entries.clone();
            if let Some(&cut) = turn_starts(&entries).get(keep as usize) {
                entries.truncate(cut);
            }
            let now = now_ms();
            let task = AgentTask {
                id: uuid::Uuid::new_v4().simple().to_string(),
                status: AgentStatus::Ready,
                error: None,
                created_ms: now,
                updated_ms: now,
                usage: None,
                queue: Vec::new(),
                resets_ms: None,
                retry: None,
                ..s.task.clone()
            };
            TaskFile {
                task,
                session_id: Some(session),
                entries,
                wanted: s.wanted.clone(),
                before: (*s.before).clone(),
                subagents: s.conversation.saved_subagents(),
                pending_rollback: total - keep,
            }
        };
        let task = Task::restore(file, self.shared.clone());
        self.tasks.write().insert(task.id.clone(), task.clone());
        task.persist();
        task.emit_task();
        let copy = task.state.lock().task.clone();
        Ok(copy)
    }

    /// Drops the task's turns after its first `turns`, in the agent's session and in the
    /// conversation; returns the message that started the first dropped turn. Files the
    /// agent changed stay as they are.
    pub async fn rollback(&self, id: &str, turns: u32) -> IdeResult<Option<AgentPrompt>> {
        let task = self.task(id)?;
        if task.state.lock().busy {
            return Err(IdeError::invalid("wait until the agent is done"));
        }
        let live = task.ensure_session().await.map_err(IdeError::internal)?;
        if !live.capabilities.rollback {
            return Err(IdeError::invalid("this agent can't undo turns"));
        }
        let starts = turn_starts(&task.state.lock().conversation.main.entries);
        let Some(&cut) = starts.get(turns as usize) else { return Ok(None) };
        let drop = (starts.len() - turns as usize) as u32;
        let _: Value = live
            .peer
            .request("_openidea/rollback", json!({ "sessionId": live.session, "turns": drop }), None)
            .await
            .map_err(|e| IdeError::internal(task.describe(e)))?;
        let first = {
            let mut s = task.state.lock();
            let first = match s.conversation.main.entries.get(cut) {
                Some(AgentEntry::User { text, .. }) => Some(AgentPrompt { text: text.clone(), ..Default::default() }),
                _ => None,
            };
            s.conversation.truncate(cut);
            s.task.updated_ms = now_ms();
            first
        };
        task.persist();
        self.shared.emit(AgentEvent::Truncated { task: id.to_owned(), length: cut as u32 });
        task.emit_task();
        Ok(first)
    }

    /// What `provider` reports about itself, from `initialize` alone: no session is opened,
    /// so no MCP server, hook or sign-in runs. Remembered until `refresh`.
    pub async fn probe(&self, provider: &str, refresh: bool) -> IdeResult<AgentProbe> {
        if !refresh && let Some(p) = self.shared.probes.lock().get(provider) {
            return Ok(p.clone());
        }
        let spec = self.shared.spec(provider).ok_or_else(|| IdeError::invalid(format!("unknown agent {provider}")))?;
        let mut probe = AgentProbe {
            provider: spec.id.clone(),
            name: None,
            version: None,
            protocol: match spec.driver {
                provider::Driver::Acp => "ACP".into(),
                _ => "native".into(),
            },
            capabilities: AgentCapabilities::default(),
            auth_methods: Vec::new(),
            error: None,
        };
        let stderr: Arc<Mutex<Vec<String>>> = Arc::default();
        let lines = stderr.clone();
        let on_stderr: Box<dyn Fn(String) + Send + Sync> = Box::new(move |l| lines.lock().push(l));
        let started = (self.shared.connector)(
            &spec,
            &self.shared.paths.project_root,
            Arc::new(ide_jsonrpc::NoopHandler),
            on_stderr,
        );
        let reply = match started {
            Err(e) => Err(format!("Couldn't start {} (`{}`): {e}", spec.name, spec.command)),
            Ok(peer) => {
                let params = acp::initialize_params(&client_info());
                let r = tokio::time::timeout(PROBE_TIMEOUT, peer.request::<_, Value>("initialize", params, None)).await;
                peer.kill();
                match r {
                    Ok(Ok(v)) => Ok(v),
                    Ok(Err(e)) => Err(match stderr.lock().last() {
                        Some(line) => format!("{e}: {line}"),
                        None => e.to_string(),
                    }),
                    Err(_) => Err("the agent did not answer".into()),
                }
            }
        };
        match reply {
            Ok(reply) => {
                let init = acp::Negotiated::from_initialize(&reply);
                let info = init.agent_info.clone().unwrap_or_default();
                let text = |k: &str| info.get(k).and_then(Value::as_str).map(str::to_owned);
                probe.name = text("title").or_else(|| text("name"));
                probe.version = text("version");
                if spec.driver == provider::Driver::Acp {
                    probe.protocol = format!("ACP v{}", init.generation);
                }
                probe.capabilities = capabilities_of(&init).0;
                probe.auth_methods = init
                    .auth_methods
                    .iter()
                    .filter_map(|m| m.get("name").or_else(|| m.get("id")).and_then(Value::as_str).map(str::to_owned))
                    .collect();
            }
            Err(e) => probe.error = Some(e),
        }
        self.shared.probes.lock().insert(spec.id, probe.clone());
        Ok(probe)
    }

    /// Stops the current turn (`session/cancel`); pending permission requests are cancelled.
    /// Queued messages stay queued. With `subagent`, stops only that subagent's work.
    pub fn cancel(&self, id: &str, subagent: Option<String>) -> IdeResult<()> {
        let task = self.task(id)?;
        match subagent {
            None => task.cancel(),
            Some(sub) => {
                if let Some(live) = task.live.lock().clone() {
                    let _ = live.peer.notify("session/cancel", json!({ "sessionId": sub }));
                }
            }
        }
        Ok(())
    }

    /// Answers permission request `permission` with option `option` (`None` cancels it).
    pub fn respond(&self, id: &str, permission: u32, option: Option<String>) -> IdeResult<()> {
        let task = self.task(id)?;
        let pending = task.permissions.lock().remove(&permission);
        match pending {
            Some(reply) => {
                let _ = reply.send(option);
                Ok(())
            }
            None => Err(IdeError::not_found("the request was already answered")),
        }
    }

    /// Stops the agent and moves the task to Archived; its worktree stays.
    pub fn archive(&self, id: &str) -> IdeResult<()> {
        let task = self.task(id)?;
        task.kill();
        task.set_status(AgentStatus::Archived, None);
        Ok(())
    }

    /// Forgets the task; with `remove_worktree` also deletes its worktree (the branch stays).
    pub async fn delete(&self, id: &str, remove_worktree: bool) -> IdeResult<()> {
        let task = self.task(id)?;
        task.kill();
        let (isolation, cwd) = {
            let s = task.state.lock();
            (s.task.isolation, s.task.cwd.0.clone())
        };
        // A copy of the task (a fork) may work in the same worktree.
        let shared = self.tasks.read().values().any(|t| t.id != id && t.state.lock().task.cwd.0 == cwd);
        if remove_worktree && !shared && isolation == Isolation::Worktree && cwd.exists() {
            let root = self.shared.paths.project_root.clone();
            blocking(move || worktree::remove(&root, &cwd)).await?;
        }
        self.tasks.write().remove(id);
        *task.deleted.lock() = true;
        let _ = std::fs::remove_file(self.shared.paths.store_dir.join(format!("{id}.json")));
        self.shared.emit(AgentEvent::Removed { id: id.to_owned() });
        Ok(())
    }

    /// Files the task changed since it started.
    pub async fn changes(&self, id: &str) -> IdeResult<Vec<AgentChange>> {
        let task = self.task(id)?;
        let (cwd, base) = task.cwd_and_base();
        let before = task.state.lock().before.clone();
        blocking(move || Ok(worktree::without_untouched(worktree::changes(&cwd, &base)?, &before))).await
    }

    /// Content of `path` (in the task's directory) when the task started.
    pub async fn base_text(&self, id: &str, path: PathBuf) -> IdeResult<Option<String>> {
        let (cwd, base) = self.task(id)?.cwd_and_base();
        blocking(move || worktree::file_at(&cwd, &path, &base)).await
    }

    /// Stops every agent (project closed).
    pub fn shutdown(&self) {
        for task in self.tasks.read().values() {
            task.kill();
            // What arrived after the last save (a subagent's late updates).
            task.persist();
        }
        *self.shared.sink.write() = None;
    }
}

impl Task {
    fn restore(file: TaskFile, shared: Arc<Shared>) -> Arc<Self> {
        let mut task = file.task;
        config::add_client_options(&task.provider, &mut task.config);
        let conversation = Conversation::restore(file.entries, file.subagents);
        Arc::new(Self {
            id: task.id.clone(),
            shared,
            state: Mutex::new(TaskState {
                task,
                session_id: file.session_id,
                conversation,
                wanted: file.wanted,
                before: Arc::new(file.before),
                pending_rollback: file.pending_rollback,
                busy: false,
            }),
            live: Mutex::new(None),
            connecting: tokio::sync::Mutex::new(()),
            permissions: Mutex::new(HashMap::new()),
            next_permission: AtomicU32::new(1),
            replaying: AtomicBool::new(false),
            send_now: AtomicBool::new(false),
            cancel_pending: AtomicBool::new(false),
            turn_started: AtomicBool::new(false),
            config_sent: Mutex::new(HashSet::new()),
            dirty: Mutex::new(BTreeSet::new()),
            flush_scheduled: AtomicBool::new(false),
            stderr: Mutex::new(VecDeque::new()),
            deleted: Mutex::new(false),
        })
    }

    fn cwd_and_base(&self) -> (PathBuf, String) {
        let s = self.state.lock();
        // In the project's own checkout the user commits too: compare against the current HEAD,
        // as the Commit tool window does, so commits made since the task started drop out.
        let base = match s.task.isolation {
            Isolation::Local => None,
            Isolation::Worktree => s.task.base_commit.clone(),
        };
        (s.task.cwd.0.clone(), base.unwrap_or_else(|| "HEAD".into()))
    }

    fn emit_task(&self) {
        let task = self.state.lock().task.clone();
        self.shared.emit(AgentEvent::Task { task });
    }

    /// Shows (or clears) the agent's pending retry; emitted only when it changes.
    fn set_retry(&self, retry: Option<AgentRetry>) {
        {
            let mut s = self.state.lock();
            if s.task.retry == retry {
                return;
            }
            s.task.retry = retry;
        }
        self.emit_task();
    }

    fn set_status(&self, status: AgentStatus, error: Option<String>) {
        {
            let mut s = self.state.lock();
            s.task.retry = None;
            s.task.status = status;
            s.task.error = error;
            s.task.updated_ms = now_ms();
        }
        // Saved first: whoever reacts to the status change finds it on disk.
        self.persist();
        self.emit_task();
    }

    fn persist(&self) {
        // Held from snapshot to rename, so saves land in order and none follows a delete.
        let deleted = self.deleted.lock();
        if *deleted {
            return;
        }
        let bytes = {
            let s = self.state.lock();
            serde_json::to_vec(&TaskFile {
                task: s.task.clone(),
                session_id: s.session_id.clone(),
                entries: s.conversation.main.entries.clone(),
                wanted: s.wanted.clone(),
                before: (*s.before).clone(),
                subagents: s.conversation.saved_subagents(),
                pending_rollback: s.pending_rollback,
            })
        };
        let path = self.shared.paths.store_dir.join(format!("{}.json", self.id));
        if let Err(e) = bytes.map_err(|e| e.to_string()).and_then(|b| write_file(&path, &b)) {
            tracing::warn!("saving agent task {}: {e}", self.id);
        }
    }

    fn mark_dirty(self: &Arc<Self>, indices: impl IntoIterator<Item = (Session, usize)>) {
        self.dirty.lock().extend(indices);
        if !self.flush_scheduled.swap(true, Ordering::AcqRel) {
            let task = self.clone();
            self.shared.runtime.spawn(async move {
                tokio::time::sleep(FLUSH_DELAY).await;
                task.flush_scheduled.store(false, Ordering::Release);
                task.flush();
            });
        }
    }

    fn flush(&self) {
        let indices = std::mem::take(&mut *self.dirty.lock());
        let events: Vec<AgentEvent> = {
            let s = self.state.lock();
            indices
                .into_iter()
                .filter_map(|(subagent, i)| {
                    let entry = s.conversation.timeline(&subagent)?.entries.get(i)?.clone();
                    Some(AgentEvent::Entry { task: self.id.clone(), subagent, index: i as u32, entry })
                })
                .collect()
        };
        for e in events {
            self.shared.emit(e);
        }
    }

    fn push_entry(self: &Arc<Self>, entry: AgentEntry) -> usize {
        let i = self.state.lock().conversation.main.push(entry);
        self.mark_dirty([(None, i)]);
        i
    }

    /// Runs `prompt`, then the queued messages, until the queue is empty, a turn fails, or
    /// the user stops one. The caller set `busy`.
    async fn run(self: Arc<Self>, mut prompt: AgentPrompt) {
        loop {
            let result = self.turn(&prompt).await;
            self.cancel_pending.store(false, Ordering::Release);
            tokio::time::sleep(TURN_GRACE).await;
            let changed = self.state.lock().conversation.end_turn(Some(now_ms()));
            self.mark_dirty(changed);
            let send_now = self.send_now.swap(false, Ordering::AcqRel);
            let next = {
                let mut s = self.state.lock();
                let go_on = s.task.status != AgentStatus::Archived
                    && match &result {
                        Ok(stop) => stop != "cancelled" || send_now,
                        Err(_) => false,
                    };
                let next = (go_on && !s.task.queue.is_empty()).then(|| s.task.queue.remove(0));
                if next.is_none() {
                    s.busy = false;
                }
                next
            };
            if self.state.lock().task.status == AgentStatus::Archived {
                self.persist();
                return;
            }
            if let Ok(stop) = &result
                && stop == "refusal"
            {
                self.push_entry(AgentEntry::Error { message: "The agent declined to continue.".into() });
            }
            match (next, result) {
                (Some(queued), _) => prompt = queued.prompt,
                (None, Ok(_)) => return self.set_status(AgentStatus::Ready, None),
                (None, Err(failure)) => return self.fail(failure),
            }
        }
    }

    /// Ends a turn that failed: nothing it started stays open.
    fn fail(self: &Arc<Self>, failure: Failure) {
        self.cancel_permissions();
        let gone = self.live.lock().as_ref().is_none_or(|l| l.peer.is_closed());
        if gone {
            let changed = self.state.lock().conversation.settle(now_ms());
            self.mark_dirty(changed);
        }
        self.push_entry(AgentEntry::Error { message: failure.message.clone() });
        // The next message starts the agent again (loading the session): what failed may
        // be fixed outside it meanwhile (signed in, updated, another model chosen).
        if !gone && let Some(live) = self.live.lock().take() {
            live.peer.kill();
        }
        match failure.limit {
            Some(resets) => {
                self.state.lock().task.resets_ms = resets;
                self.set_status(AgentStatus::Limited, Some(failure.message));
            }
            None => self.set_status(AgentStatus::Failed, Some(failure.message)),
        }
    }

    /// Adds `prompt` to the running turn when the agent takes that; gives it back otherwise.
    async fn steer(self: &Arc<Self>, prompt: AgentPrompt) -> Result<(), AgentPrompt> {
        let live = self.live.lock().clone().filter(|l| l.capabilities.steer && !l.peer.is_closed());
        let running = {
            let s = self.state.lock();
            s.busy && s.task.status == AgentStatus::Running
        };
        let Some(live) = live.filter(|l| running && (prompt.images.is_empty() || l.capabilities.images)) else {
            return Err(prompt);
        };
        let content = self.content(&live, &prompt).await;
        let sent: Result<Value, RpcError> =
            live.peer.request("_openidea/steer", json!({ "sessionId": live.session, "prompt": content }), None).await;
        if let Err(e) = sent {
            // The turn ended meanwhile: the message waits for the next one instead.
            tracing::debug!("agent task {}: steering failed: {e}", self.id);
            return Err(prompt);
        }
        let attachments = prompt
            .files
            .iter()
            .map(|f| file_name(&f.0))
            .chain(prompt.images.iter().map(|i| i.name.clone().unwrap_or_else(|| "image".into())))
            .collect();
        self.push_entry(AgentEntry::User {
            text: prompt.text,
            attachments,
            sent_ms: Some(now_ms()),
            done_ms: None,
            steered: true,
        });
        Ok(())
    }

    /// Sends one prompt, starting the agent first if needed; returns the stop reason.
    async fn turn(self: &Arc<Self>, prompt: &AgentPrompt) -> Result<String, Failure> {
        self.turn_started.store(false, Ordering::Release);
        self.state.lock().task.resets_ms = None;
        let attachments = prompt
            .files
            .iter()
            .map(|f| file_name(&f.0))
            .chain(prompt.images.iter().map(|i| i.name.clone().unwrap_or_else(|| "image".into())))
            .collect();
        self.push_entry(AgentEntry::User {
            text: prompt.text.clone(),
            attachments,
            sent_ms: Some(now_ms()),
            done_ms: None,
            steered: false,
        });
        // Launching the agent can take a while (`npx` fetches its adapter on first use).
        let starting = self.live.lock().as_ref().is_none_or(|l| l.peer.is_closed());
        self.set_status(if starting { AgentStatus::Starting } else { AgentStatus::Running }, None);
        let live = self.ensure_session().await.map_err(Failure::from)?;
        // Stopped while the agent started: the prompt is never sent.
        if self.cancel_pending.load(Ordering::Acquire) {
            return Ok("cancelled".into());
        }
        self.set_status(AgentStatus::Running, None);
        if !prompt.images.is_empty() && !live.capabilities.images {
            return Err(Failure::from("This agent can't read images.".to_owned()));
        }
        let content = self.content(&live, prompt).await;
        let result: Result<Value, RpcError> =
            live.peer.request("session/prompt", json!({ "sessionId": live.session, "prompt": content }), None).await;
        match result {
            Ok(v) => Ok(v.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn").to_owned()),
            Err(e) => Err(self.failure(e)),
        }
    }

    /// The prompt as ACP content blocks for `live`'s agent.
    async fn content(&self, live: &Live, prompt: &AgentPrompt) -> Vec<Value> {
        let contents = if live.embedded && !prompt.files.is_empty() {
            let files: Vec<PathBuf> = prompt.files.iter().map(|f| f.0.clone()).collect();
            tokio::task::spawn_blocking(move || files.iter().map(|f| embeddable(f)).collect()).await.unwrap_or_default()
        } else {
            Vec::new()
        };
        blocks(prompt, &contents)
    }

    /// What a failed request means for the user: signed out, out of quota, or the agent's message.
    fn failure(&self, e: RpcError) -> Failure {
        if let Some(resets) = usage_limit(&e) {
            let message = match &e {
                RpcError::Server { message, .. } if !message.is_empty() => message.clone(),
                _ => "The usage limit was reached.".into(),
            };
            return Failure { message, limit: Some(resets) };
        }
        match e {
            // Signed out, or the account was refused (Claude Code: "API Error: 403").
            RpcError::Server { message, .. } if message.to_lowercase().contains("auth") => {
                let provider = self.state.lock().task.provider.clone();
                Failure::from(match self.shared.spec(&provider) {
                    Some(spec) => format!("{} needs you to sign in. {}", spec.name, spec.login_hint),
                    None => message,
                })
            }
            e => Failure::from(self.describe(e)),
        }
    }

    async fn ensure_session(self: &Arc<Self>) -> Result<Live, String> {
        let _guard = self.connecting.lock().await;
        if let Some(live) = self.live.lock().clone()
            && !live.peer.is_closed()
        {
            return Ok(live);
        }
        let (provider_id, cwd, saved) = {
            let s = self.state.lock();
            (s.task.provider.clone(), s.task.cwd.0.clone(), s.session_id.clone())
        };
        let spec = self.shared.spec(&provider_id).ok_or_else(|| format!("unknown agent {provider_id}"))?;
        self.stderr.lock().clear();
        self.config_sent.lock().clear();
        let weak = Arc::downgrade(self);
        let on_stderr: Box<dyn Fn(String) + Send + Sync> = Box::new(move |line| {
            if let Some(t) = weak.upgrade() {
                let mut buf = t.stderr.lock();
                if buf.len() == STDERR_LINES {
                    buf.pop_front();
                }
                buf.push_back(line);
            }
        });
        // Speaks ACP v1 or v2, whichever the agent chooses; the task sees v1 either way.
        let client = acp::Dialect::wrap(Arc::new(Client { task: Arc::downgrade(self) }));
        let peer = (self.shared.connector)(&spec, &cwd, client.clone(), on_stderr)
            .map(|peer| acp::Conn::new(peer, client))
            .map_err(|e| format!("Couldn't start {} (`{}`): {e}", spec.name, spec.command))?;

        let init = peer.initialize(&client_info()).await.map_err(|e| self.describe(e))?;
        let can_load = init.load_session();
        let (capabilities, embedded) = capabilities_of(&init);
        // Agents that compare canonical paths fail in a symlinked directory (macOS `/tmp`).
        let cwd_s = dunce::canonicalize(&cwd).unwrap_or(cwd).to_string_lossy().into_owned();

        let mut session = None;
        if let (Some(id), true) = (saved, can_load) {
            self.replaying.store(true, Ordering::Release);
            let loaded: Result<Value, RpcError> =
                peer.request("session/load", json!({ "sessionId": id, "cwd": cwd_s, "mcpServers": [] }), None).await;
            tokio::time::sleep(REPLAY_GRACE).await;
            self.replaying.store(false, Ordering::Release);
            match loaded {
                Ok(v) => session = Some((id, v)),
                Err(e) => tracing::info!("agent task {}: session/load failed, starting a new session: {e}", self.id),
            }
        }
        let resumed = session.is_some();
        let (session_id, result) = match session {
            Some(s) => s,
            None => {
                let v: Value = peer
                    .request("session/new", json!({ "cwd": cwd_s, "mcpServers": [] }), None)
                    .await
                    .map_err(|e| match e {
                        RpcError::Server { ref message, .. } if message.to_lowercase().contains("auth") => {
                            format!("{} needs you to sign in. {}", spec.name, spec.login_hint)
                        }
                        e => self.describe(e),
                    })?;
                let id = v.get("sessionId").and_then(Value::as_str).ok_or("the agent returned no session")?.to_owned();
                (id, v)
            }
        };

        // A fork of an earlier point: the copied session still has the later turns.
        let pending = std::mem::take(&mut self.state.lock().pending_rollback);
        if pending > 0 {
            if resumed && capabilities.rollback {
                let params = json!({ "sessionId": session_id, "turns": pending });
                if let Err(e) = peer.request::<_, Value>("_openidea/rollback", params, None).await {
                    tracing::warn!("agent task {}: dropping {pending} forked turns failed: {e}", self.id);
                }
            } else {
                tracing::warn!("agent task {}: can't drop {pending} forked turns", self.id);
            }
        }

        // The session's settings, then the user's choices on top.
        // A session that reports none keeps the last known ones, but what is set is unknown.
        let reported = config::options_of(&result);
        let known = !reported.is_empty();
        let (mut options, wanted) = {
            let s = self.state.lock();
            (if known { reported } else { s.task.config.clone() }, s.wanted.clone())
        };
        config::add_client_options(&provider_id, &mut options);
        self.shared.remember(&provider_id, Some(&options), None);
        for choice in &wanted {
            // An option the session doesn't offer yet is set once it does (`apply_late_choices`).
            let Some(o) = options.iter().find(|o| o.id == choice.id).cloned() else { continue };
            if o.id == config::CURSOR_APPROVAL {
                if o.values.iter().any(|v| v.value == choice.value) {
                    options.iter_mut().find(|o| o.id == choice.id).unwrap().current = Some(choice.value.clone());
                }
                continue;
            }
            let already = known && o.current.as_deref() == Some(choice.value.as_str());
            if already || !o.values.iter().any(|v| v.value == choice.value) {
                continue;
            }
            self.config_sent.lock().insert((choice.id.clone(), choice.value.clone()));
            let (method, mut params) = config::set_request(&o, &choice.value);
            params["sessionId"] = json!(session_id);
            match peer.request::<_, Value>(method, params, None).await {
                Ok(reply) => {
                    if let Some(fresh) = reply.get("configOptions") {
                        config::merge_update(&mut options, fresh);
                    }
                    if let Some(o) = options.iter_mut().find(|o| o.id == choice.id) {
                        o.current = Some(choice.value.clone());
                    }
                }
                Err(e) => tracing::warn!("agent task {}: setting {} to {} failed: {e}", self.id, o.id, choice.value),
            }
        }
        {
            let mut s = self.state.lock();
            s.task.model = model_of(&options).or(s.task.model.take());
            s.task.config = options;
            s.task.capabilities = capabilities;
            s.session_id = Some(session_id.clone());
        }
        self.persist();
        self.emit_task();
        let live = Live { peer, session: session_id, capabilities, embedded };
        *self.live.lock() = Some(live.clone());
        Ok(live)
    }

    /// Sends the user's choices that the session offers only now: an option advertised
    /// after the session started, or a value that appears once a model that has it runs.
    fn apply_late_choices(self: &Arc<Self>) {
        let Some(live) = self.live.lock().clone().filter(|l| !l.peer.is_closed()) else { return };
        let due: Vec<(AgentConfigOption, String)> = {
            let s = self.state.lock();
            let mut sent = self.config_sent.lock();
            s.wanted
                .iter()
                .filter_map(|c| {
                    let o = s.task.config.iter().find(|o| o.id == c.id && o.id != config::CURSOR_APPROVAL)?;
                    let due = o.current.as_deref() != Some(c.value.as_str())
                        && o.values.iter().any(|v| v.value == c.value)
                        && sent.insert((c.id.clone(), c.value.clone()));
                    due.then(|| (o.clone(), c.value.clone()))
                })
                .collect()
        };
        if due.is_empty() {
            return;
        }
        let task = self.clone();
        self.shared.runtime.spawn(async move {
            for (option, value) in due {
                let (method, mut params) = config::set_request(&option, &value);
                params["sessionId"] = json!(live.session);
                match live.peer.request::<_, Value>(method, params, None).await {
                    Ok(reply) => {
                        let mut s = task.state.lock();
                        if let Some(fresh) = reply.get("configOptions") {
                            config::merge_update(&mut s.task.config, fresh);
                        }
                        if let Some(o) = s.task.config.iter_mut().find(|o| o.id == option.id) {
                            o.current = Some(value);
                        }
                        s.task.model = model_of(&s.task.config).or(s.task.model.take());
                    }
                    Err(e) => tracing::warn!("agent task {}: setting {} to {value} failed: {e}", task.id, option.id),
                }
            }
            task.persist();
            task.emit_task();
        });
    }

    /// A user-facing message for a failed request, with the agent's last stderr lines when it died.
    fn describe(&self, e: RpcError) -> String {
        match e {
            RpcError::Closed => {
                let tail: Vec<String> = self.stderr.lock().iter().cloned().collect();
                if tail.is_empty() {
                    "The agent process exited.".into()
                } else {
                    format!("The agent process exited:\n{}", tail.join("\n"))
                }
            }
            RpcError::Server { message, .. } => message,
            e => e.to_string(),
        }
    }

    /// Applies a `session/update` of session `session` (the task's, or one of its subagents').
    fn on_update(self: &Arc<Self>, session: Option<&str>, update: &Value) {
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default();
        // A subagent's title, settings and usage are its own, not the task's.
        if self.state.lock().conversation.owner(session).is_some() {
            if !SESSION_STATE.contains(&kind) && !self.replaying.load(Ordering::Acquire) {
                self.apply(session, kind, update);
            }
            return;
        }
        if kind == RETRY_UPDATE {
            if !self.replaying.load(Ordering::Acquire) {
                self.set_retry(retry_of(update, now_ms()));
            }
            return;
        }
        if kind == "session_info_update" {
            // The agent's own title for the session replaces the first line of the prompt.
            let title = update.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
            if let Some(title) = title {
                self.state.lock().task.title = title.to_owned();
                self.persist();
                self.emit_task();
            }
            return;
        }
        // Session state (also while `session/load` replays history).
        let provider = self.state.lock().task.provider.clone();
        let task_changed = {
            let mut s = self.state.lock();
            match kind {
                "config_option_update" => {
                    if let Some(options) = update.get("configOptions") {
                        config::merge_update(&mut s.task.config, options);
                        s.task.model = model_of(&s.task.config).or(s.task.model.take());
                    }
                    true
                }
                "current_mode_update" => {
                    if let Some(mode) = update.get("currentModeId").and_then(Value::as_str) {
                        config::set_mode(&mut s.task.config, mode);
                    }
                    true
                }
                "available_commands_update" => {
                    s.task.commands = config::commands_of(update);
                    true
                }
                "usage_update" => {
                    s.task.usage = config::usage_of(update).or(s.task.usage.take());
                    true
                }
                _ => false,
            }
        };
        if task_changed {
            let (config, commands) = {
                let s = self.state.lock();
                (s.task.config.clone(), s.task.commands.clone())
            };
            self.shared.remember(&provider, Some(&config), Some(&commands));
            if kind != "usage_update" {
                self.persist();
            }
            self.emit_task();
            if kind == "config_option_update" && !self.replaying.load(Ordering::Acquire) {
                self.apply_late_choices();
            }
            return;
        }
        if self.replaying.load(Ordering::Acquire) {
            return;
        }
        // The first sign that the agent took the prompt: a stop sent before it is repeated.
        if !self.turn_started.swap(true, Ordering::AcqRel)
            && self.cancel_pending.load(Ordering::Acquire)
            && let Some(live) = self.live.lock().clone()
        {
            let _ = live.peer.notify("session/cancel", json!({ "sessionId": live.session }));
        }
        self.apply(session, kind, update);
    }

    fn apply(self: &Arc<Self>, session: Option<&str>, kind: &str, update: &Value) {
        // Output again: the retried request went through.
        self.set_retry(None);
        let applied = self.state.lock().conversation.apply(session, update, now_ms());
        self.mark_dirty(applied);
        // A subagent can start or finish after the turn that started it: saved right away.
        if kind == "subagent_update" {
            self.persist();
        }
    }

    /// Blocks the calling (blocking-pool) thread until the user answers.
    fn ask_permission(self: &Arc<Self>, params: &Value) -> Value {
        let id = self.next_permission.fetch_add(1, Ordering::Relaxed);
        let title = params
            .pointer("/toolCall/title")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .unwrap_or("The agent asks for permission")
            .to_owned();
        // A subagent's request is answered in the task's conversation, named after the subagent.
        let session = params.get("sessionId").and_then(Value::as_str);
        let title = match session.and_then(|s| self.state.lock().conversation.label(s)) {
            Some(label) => format!("{label}: {title}"),
            None => title,
        };
        let options: Vec<AgentPermissionOption> = params
            .get("options")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|o| {
                        Some(AgentPermissionOption {
                            id: o.get("optionId")?.as_str()?.to_owned(),
                            name: o.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                            kind: o.get("kind").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let (tx, rx) = std::sync::mpsc::channel();
        let entry = self.push_entry(AgentEntry::Permission { id, title, options: options.clone(), chosen: None });
        self.permissions.lock().insert(id, tx);
        self.set_status(AgentStatus::NeedsInput, None);
        self.approve_pending();

        let answer = rx.recv().ok().flatten();
        let name = answer
            .as_ref()
            .and_then(|a| options.iter().find(|o| &o.id == a))
            .map_or_else(|| "Cancelled".to_owned(), |o| o.name.clone());
        {
            let mut s = self.state.lock();
            if let Some(AgentEntry::Permission { chosen, .. }) = s.conversation.main.entries.get_mut(entry) {
                *chosen = Some(name);
            }
        }
        self.mark_dirty([(None, entry)]);
        let still_asking = !self.permissions.lock().is_empty();
        if !still_asking && self.state.lock().task.status == AgentStatus::NeedsInput {
            self.set_status(AgentStatus::Running, None);
        }
        match answer {
            Some(option) => json!({ "outcome": { "outcome": "selected", "optionId": option } }),
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        }
    }

    fn approve_pending(&self) {
        let s = self.state.lock();
        if self.cancel_pending.load(Ordering::Acquire) || !config::bypass_approvals(&s.task.provider, &s.task.config) {
            return;
        }
        let mut pending = self.permissions.lock();
        for entry in s.conversation.main.entries.iter().rev() {
            if let AgentEntry::Permission { id, options, chosen: None, .. } = entry
                && let Some(option) = options.iter().find(|o| o.kind == "allow_once")
                && let Some(reply) = pending.remove(id)
            {
                let _ = reply.send(Some(option.id.clone()));
            }
        }
    }

    fn cancel_permissions(&self) {
        for (_, reply) in self.permissions.lock().drain() {
            let _ = reply.send(None);
        }
    }

    fn cancel(&self) {
        // Also before the turn has started; nothing to stop when idle.
        if self.state.lock().busy {
            self.cancel_pending.store(true, Ordering::Release);
        }
        self.cancel_permissions();
        if let Some(live) = self.live.lock().clone() {
            let _ = live.peer.notify("session/cancel", json!({ "sessionId": live.session }));
        }
    }

    fn kill(&self) {
        self.cancel_permissions();
        if let Some(live) = self.live.lock().take() {
            live.peer.kill();
        }
    }
}

/// Answers the agent's requests on behalf of one task.
struct Client {
    task: Weak<Task>,
}

impl Handler for Client {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/update"
            && let (Some(task), Some(update)) = (self.task.upgrade(), params.get("update"))
        {
            task.on_update(params.get("sessionId").and_then(Value::as_str), update);
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let task = self.task.upgrade().ok_or((codes::INTERNAL_ERROR, "task closed".to_owned()))?;
        match method {
            "session/request_permission" => Ok(task.ask_permission(&params)),
            _ => Err((codes::METHOD_NOT_FOUND, format!("unsupported method {method}"))),
        }
    }
}

/// The prompt trimmed, or `None` when there is nothing to send.
fn clean(mut prompt: AgentPrompt) -> Option<AgentPrompt> {
    prompt.text = prompt.text.trim().to_owned();
    (!prompt.text.is_empty() || !prompt.images.is_empty() || !prompt.files.is_empty()).then_some(prompt)
}

/// ACP content blocks: the text, each file (embedded when its text is in `contents`, else
/// a `resource_link`), then the images.
fn blocks(prompt: &AgentPrompt, contents: &[Option<String>]) -> Vec<Value> {
    let mut out = Vec::new();
    if !prompt.text.is_empty() {
        out.push(json!({ "type": "text", "text": prompt.text }));
    }
    for (i, f) in prompt.files.iter().enumerate() {
        let uri = file_uri(&f.0);
        out.push(match contents.get(i).cloned().flatten() {
            Some(text) => json!({ "type": "resource", "resource": { "uri": uri, "text": text } }),
            None => json!({ "type": "resource_link", "uri": uri, "name": file_name(&f.0) }),
        });
    }
    for i in &prompt.images {
        out.push(json!({ "type": "image", "mimeType": i.mime_type, "data": i.data }));
    }
    out
}

/// The text of a referenced file, when it is a small UTF-8 file.
fn embeddable(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_EMBED {
        return None;
    }
    String::from_utf8(std::fs::read(path).ok()?).ok()
}

/// A task file from before a field existed, with that field's empty value.
fn upgrade(mut file: Value) -> Value {
    if let Some(task) = file.get_mut("task").and_then(Value::as_object_mut) {
        for (key, empty) in
            [("config", json!([])), ("commands", json!([])), ("usage", Value::Null), ("queue", json!([]))]
        {
            task.entry(key).or_insert(empty);
        }
    }
    for entry in file.get_mut("entries").and_then(Value::as_array_mut).into_iter().flatten() {
        if entry.get("type").and_then(Value::as_str) == Some("user")
            && let Some(e) = entry.as_object_mut()
        {
            e.entry("attachments").or_insert(json!([]));
        }
    }
    file
}

/// Why a turn failed.
struct Failure {
    message: String,
    /// The usage limit was reached: `Some(when it resets, if known)`.
    limit: Option<Option<f64>>,
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self { message, limit: None }
    }
}

/// Whether `e` reports a usage or rate limit, and when it resets: as native agents report
/// it (`data.openidea.usageLimit.resetsAtMs`), or as ACP agents word it.
fn usage_limit(e: &RpcError) -> Option<Option<f64>> {
    let RpcError::Server { message, data, .. } = e else { return None };
    if let Some(limit) = data.as_ref().and_then(|d| d.pointer("/openidea/usageLimit")) {
        return Some(limit.get("resetsAtMs").and_then(Value::as_f64));
    }
    let m = message.to_lowercase();
    ["usage limit", "rate limit", "rate_limit", "quota", "too many requests", "429"]
        .iter()
        .any(|k| m.contains(k))
        .then_some(None)
}

fn client_info() -> Value {
    json!({ "name": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") })
}

/// What the agent said it can do, and whether it takes embedded files.
fn capabilities_of(init: &acp::Negotiated) -> (AgentCapabilities, bool) {
    let meta = |p: &str| init.meta(p).and_then(Value::as_bool) == Some(true);
    let capabilities = AgentCapabilities {
        images: init.prompt("image"),
        fork: init.session("fork"),
        rollback: meta("/openidea/rollback"),
        steer: meta("/openidea/steer"),
    };
    (capabilities, init.prompt("embeddedContext"))
}

/// The turns of a conversation: the user's messages that started one.
fn turn_starts(entries: &[AgentEntry]) -> Vec<usize> {
    entries
        .iter()
        .enumerate()
        .filter(|(_, e)| matches!(e, AgentEntry::User { steered: false, .. }))
        .map(|(i, _)| i)
        .collect()
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// The retry a [`RETRY_UPDATE`] announces, timed from `now`.
fn retry_of(update: &Value, now: f64) -> Option<AgentRetry> {
    let n = |k: &str| update.get(k).and_then(Value::as_u64);
    Some(AgentRetry {
        attempt: u32::try_from(n("attempt")?).unwrap_or(u32::MAX),
        max_retries: n("maxRetries").and_then(|m| u32::try_from(m).ok()),
        retry_at_ms: now + n("retryDelayMs").unwrap_or(0) as f64,
        error: update.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()).map(str::to_owned),
    })
}

fn model_of(config: &[AgentConfigOption]) -> Option<String> {
    config.iter().find(|o| o.category.as_deref() == Some("model")).and_then(|o| o.current.clone())
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(|| path.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned())
}

/// `file://` URI of an absolute path, percent-encoded.
fn file_uri(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from(if s.starts_with('/') { "file://" } else { "file:///" });
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn title_of(prompt: &AgentPrompt) -> String {
    let line = prompt.text.lines().map(str::trim).find(|l| !l.is_empty());
    let line = match line {
        Some(l) => l.to_owned(),
        None => prompt.files.first().map(|f| file_name(&f.0)).unwrap_or_else(|| "Image".into()),
    };
    match line.char_indices().nth(60) {
        Some((cut, _)) => format!("{}…", &line[..cut]),
        None => line,
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path)).map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

#[cfg(test)]
mod replay;
#[cfg(test)]
mod replay_tests;
#[cfg(test)]
mod tests;
