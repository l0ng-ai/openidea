//! Coding agents (Claude Code, Codex, Gemini CLI…) driven over the Agent Client Protocol.
//!
//! A task is one agent conversation, working in its own git worktree or in the project
//! checkout. Each task runs its agent's ACP server as a child process (newline-delimited
//! JSON-RPC over stdio), folds `session/update` notifications into a timeline, and streams
//! timeline and status changes to the subscribed window. Tasks are saved under the
//! project's store directory and survive restarts; the agent session is reloaded on the
//! next prompt when the agent supports `session/load`.

mod config;
mod conversation;
mod model;
mod provider;
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
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
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
/// Referenced files up to this size are embedded in the prompt (when the agent takes it).
const MAX_EMBED: u64 = 256 * 1024;

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
        self.known.lock().get(provider).map(|k| k.config.clone()).unwrap_or_default()
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
}

struct TaskState {
    task: AgentTask,
    session_id: Option<String>,
    conversation: Conversation,
    wanted: Vec<AgentConfigChoice>,
    before: Arc<BTreeMap<String, worktree::Stamp>>,
    /// A turn is running or about to (prompts arriving now are queued).
    busy: bool,
}

/// A running agent and its session.
#[derive(Clone)]
struct Live {
    peer: Peer,
    session: String,
    /// `promptCapabilities.image`.
    images: bool,
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
    dirty: Mutex<BTreeSet<(Session, usize)>>,
    flush_scheduled: AtomicBool,
    stderr: Mutex<VecDeque<String>>,
    /// Set by `delete`; held while saving.
    deleted: Mutex<bool>,
}

impl AgentManager {
    /// Loads the project's saved tasks. Spawned work runs on `runtime`.
    pub fn new(paths: AgentPaths, runtime: tokio::runtime::Handle) -> Self {
        let connector: Connector = Arc::new(|spec, cwd, client, on_stderr| {
            Peer::spawn_framed(&spec.command, &spec.args, cwd, &spec.env, client, on_stderr, Framing::Lines)
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
        if provider != "claude" {
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
        };
        let file = TaskFile {
            task: task.clone(),
            session_id: None,
            entries: Vec::new(),
            wanted: req.config,
            before,
            subagents: Vec::new(),
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
        if let Some(live) = live {
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
        task.persist();
        task.emit_task();
        Ok(())
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
        if remove_worktree && isolation == Isolation::Worktree && cwd.exists() {
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
        let task = file.task;
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
                busy: false,
            }),
            live: Mutex::new(None),
            connecting: tokio::sync::Mutex::new(()),
            permissions: Mutex::new(HashMap::new()),
            next_permission: AtomicU32::new(1),
            replaying: AtomicBool::new(false),
            send_now: AtomicBool::new(false),
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

    fn set_status(&self, status: AgentStatus, error: Option<String>) {
        {
            let mut s = self.state.lock();
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
                (None, Err(message)) => {
                    self.push_entry(AgentEntry::Error { message: message.clone() });
                    return self.set_status(AgentStatus::Failed, Some(message));
                }
            }
        }
    }

    /// Sends one prompt, starting the agent first if needed; returns the stop reason.
    async fn turn(self: &Arc<Self>, prompt: &AgentPrompt) -> Result<String, String> {
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
        });
        // Launching the agent can take a while (`npx` fetches its adapter on first use).
        let starting = self.live.lock().as_ref().is_none_or(|l| l.peer.is_closed());
        self.set_status(if starting { AgentStatus::Starting } else { AgentStatus::Running }, None);
        let live = self.ensure_session().await?;
        self.set_status(AgentStatus::Running, None);
        if !prompt.images.is_empty() && !live.images {
            return Err("This agent can't read images.".into());
        }
        let contents = if live.embedded && !prompt.files.is_empty() {
            let files: Vec<PathBuf> = prompt.files.iter().map(|f| f.0.clone()).collect();
            tokio::task::spawn_blocking(move || files.iter().map(|f| embeddable(f)).collect()).await.unwrap_or_default()
        } else {
            Vec::new()
        };
        let result: Result<Value, RpcError> = live
            .peer
            .request("session/prompt", json!({ "sessionId": live.session, "prompt": blocks(prompt, &contents) }), None)
            .await;
        match result {
            Ok(v) => Ok(v.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn").to_owned()),
            // Signed out, or the account was refused (Claude Code: "API Error: 403").
            Err(RpcError::Server { message, .. }) if message.to_lowercase().contains("auth") => {
                let provider = self.state.lock().task.provider.clone();
                Err(match self.shared.spec(&provider) {
                    Some(spec) => format!("{} needs you to sign in. {}", spec.name, spec.login_hint),
                    None => message,
                })
            }
            Err(e) => Err(self.describe(e)),
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
        let client = Arc::new(Client { task: Arc::downgrade(self) });
        let peer = (self.shared.connector)(&spec, &cwd, client, on_stderr)
            .map_err(|e| format!("Couldn't start {} (`{}`): {e}", spec.name, spec.command))?;

        let init: Value = peer
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false,
                        // Subagents as sessions of their own (ACP subagents RFD).
                        "subagents": {},
                    },
                    "clientInfo": { "name": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") },
                }),
                None,
            )
            .await
            .map_err(|e| self.describe(e))?;
        let can_load = init.pointer("/agentCapabilities/loadSession").and_then(Value::as_bool) == Some(true);
        let capable = |c: &str| {
            init.pointer(&format!("/agentCapabilities/promptCapabilities/{c}")).and_then(Value::as_bool) == Some(true)
        };
        let (images, embedded) = (capable("image"), capable("embeddedContext"));
        let cwd_s = cwd.to_string_lossy().into_owned();

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

        // The session's settings, then the user's choices on top.
        // A session that reports none keeps the last known ones, but what is set is unknown.
        let reported = config::options_of(&result);
        let known = !reported.is_empty();
        let (mut options, wanted) = {
            let s = self.state.lock();
            (if known { reported } else { s.task.config.clone() }, s.wanted.clone())
        };
        self.shared.remember(&provider_id, Some(&options), None);
        for choice in &wanted {
            let Some(o) = options.iter().find(|o| o.id == choice.id).cloned() else { continue };
            let already = known && o.current.as_deref() == Some(choice.value.as_str());
            if already || !o.values.iter().any(|v| v.value == choice.value) {
                continue;
            }
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
            s.session_id = Some(session_id.clone());
        }
        self.persist();
        self.emit_task();
        let live = Live { peer, session: session_id, images, embedded };
        *self.live.lock() = Some(live.clone());
        Ok(live)
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
            return;
        }
        if self.replaying.load(Ordering::Acquire) {
            return;
        }
        self.apply(session, kind, update);
    }

    fn apply(self: &Arc<Self>, session: Option<&str>, kind: &str, update: &Value) {
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

    fn cancel_permissions(&self) {
        for (_, reply) in self.permissions.lock().drain() {
            let _ = reply.send(None);
        }
    }

    fn cancel(&self) {
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
mod tests;
