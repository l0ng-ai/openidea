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
mod external;
pub mod mcp;
mod model;
mod native;
mod provider;
pub mod registry;
mod skills;
mod timeline;
mod worktree;

pub use external::ExternalSession;
pub use model::*;

use conversation::{Conversation, SavedSubagent, Session};
use ide_core::{IdeError, IdeResult, IpcPath};
use ide_jsonrpc::{Framing, Handler, Peer, RpcError, codes};
use ide_vcs::Repo;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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
/// An agent idle this long after its turn is stopped when it can reload its session
/// (`session/load`): the next message starts it again where it left off.
const IDLE_RELEASE: Duration = Duration::from_secs(5 * 60);
/// Updates of a session's state rather than its conversation.
const SESSION_STATE: [&str; 5] =
    ["session_info_update", "config_option_update", "current_mode_update", "available_commands_update", "usage_update"];
/// A native agent's own update: it is about to retry a failed API request (see [`AgentRetry`]).
pub(crate) const RETRY_UPDATE: &str = "openidea_retry";
/// A native agent's own update: the usage limits of its account (see [`AgentLimit`]).
pub(crate) const LIMITS_UPDATE: &str = "openidea_limits";
/// A native agent's own update: the background tasks its session runs
/// (see [`TaskState::background_tasks`]).
pub(crate) const BACKGROUND_TASKS_UPDATE: &str = "openidea_background_tasks";
/// Referenced files up to this size are embedded in the prompt (when the agent takes it).
const MAX_EMBED: u64 = 256 * 1024;
/// How long a probe waits for the agent to answer `initialize`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long deleting a task waits for its agent to exit before removing the worktree.
const EXIT_WAIT: Duration = Duration::from_secs(5);

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

/// Returns the configured MCP servers (User and Workspace) for this project.
pub type McpServersFn = dyn Fn() -> Vec<McpServer> + Send + Sync;

struct Shared {
    paths: AgentPaths,
    runtime: tokio::runtime::Handle,
    connector: Connector,
    sink: RwLock<Option<AgentSink>>,
    known: Mutex<HashMap<String, Known>>,
    providers: RwLock<Vec<provider::ProviderSpec>>,
    /// Last probe of each provider.
    probes: Mutex<HashMap<String, AgentProbe>>,
    /// One pre-session lookup of commands and settings per provider, including failed attempts.
    command_fetches: Mutex<HashMap<String, tokio::sync::watch::Receiver<bool>>>,
    /// [`IDLE_RELEASE`], in milliseconds (shorter in tests).
    idle_release_ms: AtomicU64,
    mcp_servers_hook: RwLock<Option<Arc<McpServersFn>>>,
}

/// What an agent offered in its last session, for the New Task page.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Known {
    #[serde(default)]
    config: Vec<AgentConfigOption>,
    /// Thinking levels reported for each model value, including its last choice.
    #[serde(default, rename = "thoughtLevels")]
    thought_levels: BTreeMap<String, Vec<AgentConfigOption>>,
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

    fn mcp_servers_for_session(&self, provider: &str, init: &acp::Negotiated) -> Vec<Value> {
        let mut servers = mcp_servers_for(init.mcp_stdio(), &self.paths.project_root);
        let configured = self.mcp_servers_hook.read().as_ref().map(|hook| hook()).unwrap_or_default();
        servers.extend(mcp::acp_mcp_servers(&configured, provider, init));
        servers
    }

    fn known_config(&self, provider: &str) -> Vec<AgentConfigOption> {
        let mut config = self.known.lock().get(provider).map(|k| k.config.clone()).unwrap_or_default();
        // Model-specific options are offered separately, never as provider-wide defaults.
        config.retain(|o| o.category.as_deref() != Some("thought_level"));
        config::add_client_options(provider, &mut config);
        if let Some((o, v)) = config::bypass_mode(&config).map(|(o, v)| (o.id.clone(), v.value.clone()))
            && let Some(o) = config.iter_mut().find(|c| c.id == o)
        {
            o.current = Some(v);
        }
        if let Some(o) = config.iter_mut().find(|o| o.id == config::CURSOR_APPROVAL) {
            o.current = Some("bypass".into());
        }
        config
    }

    /// The commands the agent offered last time in this project.
    fn known_commands(&self, provider: &str) -> Vec<AgentCommand> {
        let cache = self.known.lock();
        cache.get(provider).and_then(|k| k.commands.get(&self.root_key())).cloned().unwrap_or_default()
    }

    async fn fetch_settings(self: &Arc<Self>, spec: provider::ProviderSpec) {
        let mut ready = {
            let mut fetches = self.command_fetches.lock();
            fetches
                .entry(spec.id.clone())
                .or_insert_with(|| {
                    let (done, ready) = tokio::sync::watch::channel(false);
                    let shared = self.clone();
                    // Keep the lookup alive if a composer unmounts while it is waiting.
                    self.runtime.spawn(async move {
                        if let Ok(found) =
                            native::claude::discover(spec.clone(), shared.paths.project_root.clone()).await
                        {
                            let commands =
                                config::commands_of(&json!({ "availableCommands": found.commands }), &spec.id);
                            let options = config::options_of(&json!({ "configOptions": found.options }));
                            let levels: Vec<_> = found
                                .efforts
                                .into_iter()
                                .map(|(model, o)| {
                                    let options = o.map(|o| config::options_of(&json!({ "configOptions": [o] })));
                                    (model, options.unwrap_or_default())
                                })
                                .collect();
                            let _ = tokio::task::spawn_blocking(move || {
                                // Notifies subscribers itself when the discovery
                                // changed the cached config; unchanged results
                                // stay silent.
                                shared.remember_discovered(&spec.id, &options, &commands, &levels);
                            })
                            .await;
                        }
                        let _ = done.send(true);
                    });
                    ready
                })
                .clone()
        };
        while !*ready.borrow_and_update() {
            if ready.changed().await.is_err() {
                break;
            }
        }
    }

    fn has_config(&self, provider: &str) -> bool {
        self.known.lock().get(provider).is_some_and(|k| !k.config.is_empty())
    }

    /// Whether the thinking levels of every model the agent offers are known (#1686).
    fn knows_all_levels(&self, provider: &str) -> bool {
        let cache = self.known.lock();
        let Some(known) = cache.get(provider) else { return false };
        known
            .config
            .iter()
            .filter(|o| o.category.as_deref() == Some("model"))
            .flat_map(|o| &o.values)
            .all(|v| known.thought_levels.contains_key(&v.value))
    }

    fn root_key(&self) -> String {
        self.paths.project_root.to_string_lossy().into_owned()
    }

    /// Cache levels only when `model` confirms which model the session reported them for.
    fn remember(
        &self,
        provider: &str,
        config: Option<&[AgentConfigOption]>,
        commands: Option<&[AgentCommand]>,
        model: Option<&str>,
    ) {
        self.remember_inner(provider, config, commands, model, &[], false);
    }

    /// `levels`: each model's thinking-level options, so a new task offers them for any model
    /// it picks (#1686). A session's report for a model wins over these.
    fn remember_discovered(
        &self,
        provider: &str,
        config: &[AgentConfigOption],
        commands: &[AgentCommand],
        levels: &[(String, Vec<AgentConfigOption>)],
    ) {
        self.remember_inner(provider, Some(config), Some(commands), model_of(config).as_deref(), levels, true);
    }

    fn remember_inner(
        &self,
        provider: &str,
        config: Option<&[AgentConfigOption]>,
        commands: Option<&[AgentCommand]>,
        model: Option<&str>,
        discovered_levels: &[(String, Vec<AgentConfigOption>)],
        discovered: bool,
    ) {
        // Keep the update and its disk write ordered; a session report wins over discovery.
        let mut cache = self.known.lock();
        let known = cache.entry(provider.to_owned()).or_default();
        let mut changed = false;
        for (model, levels) in discovered_levels {
            if !known.thought_levels.contains_key(model) {
                known.thought_levels.insert(model.clone(), levels.clone());
                changed = true;
            }
        }
        if let Some(c) = config.filter(|_| !discovered || known.config.is_empty()) {
            if let Some(model) = model {
                let levels: Vec<_> =
                    c.iter().filter(|o| o.category.as_deref() == Some("thought_level")).cloned().collect();
                if known.thought_levels.get(model) != Some(&levels) {
                    known.thought_levels.insert(model.to_owned(), levels);
                    changed = true;
                }
            }
            if !c.is_empty() && known.config != c {
                known.config = c.to_vec();
                changed = true;
            }
        }
        let root = self.root_key();
        if let Some(c) = commands.filter(|c| {
            !c.is_empty()
                && (!discovered || known.commands.get(&root).is_none_or(Vec::is_empty))
                && known.commands.get(&root).map(Vec::as_slice) != Some(c)
        }) {
            known.commands.insert(root, c.to_vec());
            changed = true;
        }
        if !changed {
            return;
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(&*cache)
            && let Err(e) = write_file(&self.paths.models_file, &bytes)
        {
            tracing::warn!("saving agent settings: {e}");
        }
        // The cached provider config actually changed (a session report, discovery,
        // or a turn update): tell subscribers to re-list, so a changed model list
        // reaches the composer without waiting for the next task (#1490). Unchanged
        // reports stay silent, so routine session traffic emits nothing. The cache
        // lock is released first; the sink never runs under it.
        drop(cache);
        self.emit(AgentEvent::Providers);
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
    /// The folder (in the task store) with copies of the `before` files, for rolling back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    saved: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    subagents: Vec<SavedSubagent>,
    /// Turns to drop from the session once it is loaded (a fork of an earlier point).
    #[serde(default, skip_serializing_if = "is_zero")]
    pending_rollback: u32,
    /// The user named the task: its agent's own title updates no longer replace it.
    #[serde(default, skip_serializing_if = "is_false")]
    title_renamed: bool,
}

struct TaskState {
    task: AgentTask,
    session_id: Option<String>,
    conversation: Conversation,
    wanted: Vec<AgentConfigChoice>,
    before: Arc<BTreeMap<String, worktree::Stamp>>,
    saved: Option<String>,
    pending_rollback: u32,
    /// The user named the task; see `TaskFile::title_renamed`.
    title_renamed: bool,
    /// A turn is running or about to (prompts arriving now are queued).
    busy: bool,
    /// Background tasks the agent reported as running (`run_in_background` commands and
    /// the like), as it sent them: unlike a turn they outlive it, so an idle release
    /// waits for the last one. A (re)started process runs nothing yet.
    background_tasks: Vec<Value>,
}

/// A running agent and its session.
#[derive(Clone)]
struct Live {
    sign_in_message: String,
    peer: acp::Conn,
    session: String,
    capabilities: AgentCapabilities,
    /// `promptCapabilities.embeddedContext`: referenced files are sent with their text.
    embedded: bool,
    /// `session/load`: the process can be stopped between turns and the session reloaded.
    resumable: bool,
    init: acp::Negotiated,
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
    /// Turns sent so far: an idle release scheduled before the latest one is void.
    turns: AtomicU64,
    /// Bumped when the agent's last background task finishes: an idle release scheduled
    /// before that is void, the usual delay starts over from the report.
    idle_epoch: AtomicU64,
    /// Settings already sent this session (`(option, value)`), so a refusal is not retried.
    config_sent: Mutex<HashSet<(String, String)>>,
    dirty: Mutex<BTreeSet<(Session, usize)>>,
    /// How much of each session's streaming message was last sent, so the next flush sends the rest.
    streamed: Mutex<HashMap<Session, Sent>>,
    flush_scheduled: AtomicBool,
    stderr: Mutex<VecDeque<String>>,
    /// Set by `delete`; held while saving.
    deleted: Mutex<bool>,
}

impl AgentManager {
    #[cfg(test)]
    fn set_idle_release(&self, delay: Duration) {
        self.shared.idle_release_ms.store(delay.as_millis() as u64, Ordering::Relaxed);
    }

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
            command_fetches: Mutex::new(HashMap::new()),
            idle_release_ms: AtomicU64::new(IDLE_RELEASE.as_millis() as u64),
            mcp_servers_hook: RwLock::new(None),
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
                    f.task.background.clear();
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
        let in_use: std::collections::HashSet<String> =
            self.tasks.read().values().map(|t| t.state.lock().task.provider.clone()).collect();
        let list = specs
            .iter()
            .filter(|p| !provider::is_unlisted(p) || in_use.contains(&p.id))
            .map(|p| {
                let mut info = provider::describe(p);
                info.config = self.shared.known_config(&p.id);
                info.thought_levels =
                    self.shared.known.lock().get(&p.id).map(|k| k.thought_levels.clone()).unwrap_or_default();
                info.commands = self.shared.known_commands(&p.id);
                info
            })
            .collect();
        let mut prev = self.shared.providers.write();
        let mut probes = self.shared.probes.lock();
        probes.retain(|id, _| {
            let old = prev.iter().find(|p| &p.id == id);
            let new = specs.iter().find(|p| &p.id == id);
            matches!((old, new), (Some(a), Some(b)) if a.command == b.command && a.args == b.args && a.env == b.env)
        });
        *prev = specs;
        list
    }

    /// Overrides built-in `id`'s command with `command` (the driver and arguments stay
    /// the built-in's) through its agent file, or returns it to auto-detection with `None`.
    pub fn set_builtin_command(&self, id: &str, command: Option<String>) -> IdeResult<()> {
        let Some(dir) = self.shared.paths.custom_agents_dir.clone() else {
            return Err(IdeError::unavailable("there is no custom agents directory"));
        };
        provider::set_builtin_command(&dir, id, command.as_deref())
    }

    /// Sets the environment variables built-in `id` starts with; empty clears them.
    pub fn set_builtin_env(&self, id: &str, env: std::collections::BTreeMap<String, String>) -> IdeResult<()> {
        let Some(dir) = self.shared.paths.custom_agents_dir.clone() else {
            return Err(IdeError::unavailable("there is no custom agents directory"));
        };
        provider::set_builtin_env(&dir, id, env)
    }

    /// Re-reads configured/installed agents, drops cached probes, and notifies subscribers.
    pub fn reload_providers(&self) {
        let specs = provider::load(self.shared.paths.custom_agents_dir.as_deref());
        *self.shared.providers.write() = specs;
        self.shared.probes.lock().clear();
        self.shared.emit(AgentEvent::Providers);
    }

    /// Provides the user and workspace MCP servers configured in settings.
    pub fn set_mcp_servers_hook(&self, hook: Box<McpServersFn>) {
        *self.shared.mcp_servers_hook.write() = Some(Arc::from(hook));
    }

    /// The slash commands to complete for `provider`, in `task`'s directory or (without one)
    /// in the project: what the agent offered last time there, unadvertised builtins,
    /// and, for Claude Code, skills and custom commands on disk it has not listed.
    pub async fn commands(&self, provider: &str, task: Option<&str>) -> IdeResult<Vec<AgentCommand>> {
        let (provider, offered, cwd) = match task {
            Some(id) => {
                let task = self.task(id)?;
                let s = task.state.lock();
                (s.task.provider.clone(), s.task.commands.clone(), s.task.cwd.0.clone())
            }
            None => (provider.to_owned(), self.shared.known_commands(provider), self.shared.paths.project_root.clone()),
        };
        // Commands the agent implements itself and never lists (its CLI builtins):
        // merged without duplicating what `availableCommands` or the disk offer.
        let mut offered = offered;
        if task.is_none()
            && (offered.is_empty() || !self.shared.has_config(&provider) || !self.shared.knows_all_levels(&provider))
            && let Some(spec) = self.shared.spec(&provider).filter(|s| s.driver == provider::Driver::Claude)
        {
            self.shared.fetch_settings(spec).await;
            offered = self.shared.known_commands(&provider);
        }
        for &(name, description) in builtin_commands(&provider) {
            if !offered.iter().any(|c| c.name == name) {
                offered.push(AgentCommand {
                    name: name.to_owned(),
                    description: description.to_owned(),
                    hint: None,
                    source: AgentCommandSource::Command,
                });
            }
        }
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

    /// Session ids the tasks already hold (native drivers reuse the CLI's own id).
    fn imported_session_ids(&self) -> HashSet<String> {
        self.tasks.read().values().filter_map(|t| t.state.lock().session_id.clone()).collect()
    }

    /// Sessions on this machine that no task holds yet, newest first (#312).
    pub fn external_sessions(&self) -> Vec<ExternalSession> {
        let mut out = Vec::new();
        if let Some(spec) = self.shared.spec("claude")
            && let Some(dir) = native::claude::cli::config_dir(&spec.env)
        {
            out.extend(external::claude_sessions(&dir));
        }
        let home = self.shared.paths.home_dir.clone().or_else(home_dir);
        if let Some(home) = home {
            out.extend(external::codex_sessions(&home.join(".codex")));
        }
        let known = self.imported_session_ids();
        out.retain(|s| !known.contains(&s.session_id));
        out.sort_by(|a, b| b.updated_ms.total_cmp(&a.updated_ms));
        out.truncate(50);
        out
    }

    /// Imports an external session as a task: its first turn loads and replays it (#312).
    pub fn import_session(&self, provider: &str, session_id: &str) -> IdeResult<AgentTask> {
        if !matches!(provider, "claude" | "codex") {
            return Err(IdeError::invalid(format!("cannot import {provider} sessions")));
        }
        let spec = self.shared.spec(provider).ok_or_else(|| IdeError::invalid(format!("unknown agent {provider}")))?;
        if self.imported_session_ids().contains(session_id) {
            return Err(IdeError::invalid("that session is already a task"));
        }
        let found = self
            .external_sessions()
            .into_iter()
            .find(|s| s.provider == provider && s.session_id == session_id)
            .ok_or_else(|| IdeError::not_found(format!("unknown {provider} session {session_id}")))?;
        let root = self.shared.paths.project_root.clone();
        let cwd = found.cwd.map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| root.clone());
        let config = self.shared.known_config(&spec.id);
        let now = now_ms();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let task = AgentTask {
            project_root: Some(IpcPath(root)),
            id,
            title: found.title,
            provider: spec.id.clone(),
            model: model_of(&config),
            status: AgentStatus::Ready,
            isolation: Isolation::Local,
            cwd: IpcPath(cwd),
            branch: None,
            base: None,
            base_commit: None,
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
            background: Box::default(),
        };
        let file = TaskFile {
            task: task.clone(),
            session_id: Some(session_id.to_owned()),
            entries: Vec::new(),
            wanted: Vec::new(),
            before: BTreeMap::new(),
            saved: None,
            subagents: Vec::new(),
            pending_rollback: 0,
            title_renamed: true,
        };
        let handle = Task::restore(file, self.shared.clone());
        self.tasks.write().insert(task.id.clone(), handle.clone());
        handle.emit_task();
        handle.persist();
        Ok(task)
    }

    /// Creates the task (and its worktree) and sends `req.prompt` as its first message.
    pub async fn create(&self, req: NewAgentTask) -> IdeResult<AgentTask> {
        let spec = self
            .shared
            .spec(&req.provider)
            .ok_or_else(|| IdeError::invalid(format!("unknown agent {}", req.provider)))?;
        let prompt = clean(req.prompt).ok_or_else(|| IdeError::invalid("describe the task first"))?;
        let title = title_of(&prompt);
        let root = req.project_root.clone().map(|p| p.0).unwrap_or_else(|| self.shared.paths.project_root.clone());
        let project_root = Some(IpcPath(root.clone()));
        let (cwd, branch, base, base_commit, before) = match req.isolation {
            Isolation::Worktree => {
                // The UI offers worktrees for git projects only; state it when it isn't one.
                if Repo::discover(&root)?.is_none() {
                    return Err(IdeError::invalid(
                        "worktrees need a git repository: run the task in the local checkout",
                    ));
                }
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
        if let Some(model) = model_of(&config)
            && let Some(levels) = self.shared.known.lock().get(&spec.id).and_then(|k| k.thought_levels.get(&model))
        {
            config.extend(levels.iter().cloned().map(|mut o| {
                if let Some(choice) =
                    req.config.iter().find(|c| c.id == o.id && o.values.iter().any(|v| v.value == c.value))
                {
                    o.current = Some(choice.value.clone());
                }
                o
            }));
        }
        let now = now_ms();
        let id = uuid::Uuid::new_v4().simple().to_string();
        // Copies of the files the user had changed already, for rolling back the task's changes to them.
        let saved = if before.is_empty() {
            None
        } else {
            let name = format!("{id}.before");
            let (dir, at, files) = (self.shared.paths.store_dir.join(&name), cwd.clone(), before.clone());
            match blocking(move || worktree::save_before(&at, &files, &dir)).await {
                Ok(saved) => saved.then_some(name),
                Err(e) => {
                    tracing::warn!("saving the changed files of agent task {id}: {e}");
                    None
                }
            }
        };
        let task = AgentTask {
            project_root,
            id,
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
            background: Box::default(),
        };
        let file = TaskFile {
            task: task.clone(),
            session_id: None,
            entries: Vec::new(),
            wanted: req.config,
            before,
            saved,
            subagents: Vec::new(),
            pending_rollback: 0,
            title_renamed: false,
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
        let mut model_options =
            target.category.as_deref() != Some("model") || target.current.as_deref() == Some(value.as_str());
        if let Some(live) = live.filter(|_| option != config::CURSOR_APPROVAL) {
            let (method, mut params) = config::set_request(&target, &value);
            params["sessionId"] = json!(live.session);
            let reply: Value =
                live.peer.request(method, params, None).await.map_err(|e| IdeError::internal(task.describe(e)))?;
            if let Some(options) = reply.get("configOptions") {
                config::merge_update(&mut task.state.lock().task.config, options);
                model_options = true;
            }
        }
        {
            let mut s = task.state.lock();
            if !model_options {
                s.task.config.retain(|o| o.category.as_deref() != Some("thought_level"));
            }
            s.wanted.retain(|c| c.id != option);
            s.wanted.push(AgentConfigChoice { id: option.to_owned(), value: value.clone() });
            if let Some(o) = s.task.config.iter_mut().find(|o| o.id == option) {
                o.current = Some(value);
            }
            s.task.model = model_of(&s.task.config).or(s.task.model.take());
            let provider = s.task.provider.clone();
            let config = s.task.config.clone();
            let model = s.task.model.clone().filter(|_| model_options);
            drop(s);
            task.shared.remember(&provider, Some(&config), None, model.as_deref());
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
        let provider_id = source.state.lock().task.provider.clone();
        let mcp_servers = source.shared.mcp_servers_for_session(&provider_id, &live.init);
        let cwd_s = dunce::canonicalize(&cwd).unwrap_or(cwd).to_string_lossy().into_owned();
        let reply: Value = live
            .peer
            .request(
                "session/fork",
                json!({ "sessionId": live.session, "cwd": cwd_s, "mcpServers": mcp_servers }),
                None,
            )
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
                background: Box::default(),
                ..s.task.clone()
            };
            TaskFile {
                task,
                session_id: Some(session),
                entries,
                wanted: s.wanted.clone(),
                before: (*s.before).clone(),
                saved: s.saved.clone(),
                subagents: s.conversation.saved_subagents(),
                pending_rollback: total - keep,
                title_renamed: s.title_renamed,
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
        let starts = turn_starts(&task.state.lock().conversation.main.entries);
        let Some(&cut) = starts.get(turns as usize) else { return Ok(None) };
        // Dropping every turn starts the conversation over, which needs no agent-side
        // rewind — and some agents cannot rewind past their first turn (a resumed
        // Claude Code session). A fresh session avoids both.
        if turns == 0 {
            task.kill();
            let first = {
                let mut s = task.state.lock();
                let first = match s.conversation.main.entries.get(cut) {
                    Some(AgentEntry::User { text, .. }) => {
                        Some(AgentPrompt { text: text.clone(), ..Default::default() })
                    }
                    _ => None,
                };
                s.session_id = None;
                s.conversation = Conversation::default();
                // The fresh session reports its own usage; nothing carries over.
                s.task.usage = None;
                s.pending_rollback = 0;
                s.task.updated_ms = now_ms();
                first
            };
            task.streamed.lock().clear();
            task.persist();
            self.shared.emit(AgentEvent::Truncated { task: id.to_owned(), length: 0 });
            task.emit_task();
            return Ok(first);
        }
        let live = task.ensure_session().await.map_err(IdeError::internal)?;
        if !live.capabilities.rollback {
            return Err(IdeError::invalid("this agent can't undo turns"));
        }
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
        task.streamed.lock().clear();
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

    /// Stops background task `background` of task `id`.
    pub async fn stop_background(&self, id: &str, background: &str) -> IdeResult<()> {
        let task = self.task(id)?;
        let live = task.live.lock().clone().ok_or_else(|| IdeError::invalid("the agent is not running"))?;
        if !live.capabilities.background_tasks {
            return Err(IdeError::invalid("this agent can't stop a background task"));
        }
        let _: Value = live
            .peer
            .request("_openidea/stop_task", json!({ "sessionId": live.session, "taskId": background }), None)
            .await
            .map_err(|error| IdeError::internal(task.describe(error)))?;
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

    /// Returns an archived task to the active list without starting the agent.
    pub fn unarchive(&self, id: &str) -> IdeResult<()> {
        let task = self.task(id)?;
        {
            let mut s = task.state.lock();
            if s.task.status != AgentStatus::Archived {
                return Ok(());
            }
            if s.busy {
                return Err(IdeError::invalid("the task is still stopping"));
            }
            s.task.status = AgentStatus::Ready;
            s.task.error = None;
            s.task.updated_ms = now_ms();
        }
        task.persist();
        task.emit_task();
        Ok(())
    }

    /// Renames the task; the agent's own later title updates keep the user's choice.
    pub fn rename(&self, id: &str, title: &str) -> IdeResult<()> {
        let title = title.trim();
        if title.is_empty() {
            return Err(IdeError::invalid("the title is empty"));
        }
        let title: String = title.chars().take(200).collect();
        let task = self.task(id)?;
        {
            let mut s = task.state.lock();
            if s.task.title == title && s.title_renamed {
                return Ok(());
            }
            s.task.title = title;
            s.title_renamed = true;
            s.task.updated_ms = now_ms();
        }
        task.persist();
        task.emit_task();
        Ok(())
    }

    /// Forgets the task; with `remove_worktree` also deletes its worktree (the branch stays).
    pub async fn delete(&self, id: &str, remove_worktree: bool) -> IdeResult<()> {
        let task = self.task(id)?;
        let live = task.kill();
        let (isolation, cwd, root) = {
            let s = task.state.lock();
            (
                s.task.isolation,
                s.task.cwd.0.clone(),
                s.task.project_root.clone().map(|p| p.0).unwrap_or_else(|| self.shared.paths.project_root.clone()),
            )
        };
        // A copy of the task (a fork) may work in the same worktree.
        let shared = self.tasks.read().values().any(|t| t.id != id && t.state.lock().task.cwd.0 == cwd);
        if remove_worktree && !shared && isolation == Isolation::Worktree && cwd.exists() {
            // On Windows the agent's processes lock the folder (their working directory,
            // open files) until they have exited.
            if let Some(peer) = live {
                let _ = tokio::time::timeout(EXIT_WAIT, peer.exited()).await;
            }
            let worktrees = self.shared.paths.worktrees_dir.clone();
            blocking(move || worktree::remove(&root, &worktrees, &cwd)).await?;
        }
        self.tasks.write().remove(id);
        *task.deleted.lock() = true;
        let _ = std::fs::remove_file(self.shared.paths.store_dir.join(format!("{id}.json")));
        let saved = task.state.lock().saved.clone();
        if let Some(saved) = saved
            && !self.tasks.read().values().any(|t| t.state.lock().saved.as_ref() == Some(&saved))
        {
            let _ = std::fs::remove_dir_all(self.shared.paths.store_dir.join(saved));
        }
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

    /// Rollback: puts the task's changed files among `rel_paths` (all with `None`) back as they
    /// were when it started (files the user had changed then, as the user left them).
    pub async fn rollback_changes(&self, id: &str, rel_paths: Option<Vec<String>>) -> IdeResult<()> {
        let task = self.task(id)?;
        if task.state.lock().busy {
            return Err(IdeError::invalid("the agent is working: stop it before rolling back its changes"));
        }
        let (cwd, base) = task.cwd_and_base();
        let (before, saved) = {
            let s = task.state.lock();
            (s.before.clone(), s.saved.as_ref().map(|name| self.shared.paths.store_dir.join(name)))
        };
        let restamped = blocking(move || {
            let changes = worktree::without_untouched(worktree::changes(&cwd, &base)?, &before);
            let mut restamped = Vec::new();
            for change in changes.iter().filter(|c| rel_paths.as_ref().is_none_or(|p| p.contains(&c.rel_path))) {
                worktree::restore(&cwd, &base, change, &before, saved.as_deref())?;
                // Back to the user's own edits: not a change of the task any more.
                if before.contains_key(&change.rel_path) {
                    restamped.push((change.rel_path.clone(), worktree::stamp(&change.path.0)));
                }
            }
            Ok(restamped)
        })
        .await?;
        if !restamped.is_empty() {
            let mut s = task.state.lock();
            let mut before = (*s.before).clone();
            before.extend(restamped);
            s.before = Arc::new(before);
        }
        task.persist();
        Ok(())
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
                saved: file.saved,
                pending_rollback: file.pending_rollback,
                title_renamed: file.title_renamed,
                busy: false,
                background_tasks: Vec::new(),
            }),
            live: Mutex::new(None),
            connecting: tokio::sync::Mutex::new(()),
            permissions: Mutex::new(HashMap::new()),
            next_permission: AtomicU32::new(1),
            replaying: AtomicBool::new(false),
            send_now: AtomicBool::new(false),
            cancel_pending: AtomicBool::new(false),
            turn_started: AtomicBool::new(false),
            turns: AtomicU64::new(0),
            idle_epoch: AtomicU64::new(0),
            config_sent: Mutex::new(HashSet::new()),
            dirty: Mutex::new(BTreeSet::new()),
            streamed: Mutex::new(HashMap::new()),
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

    /// Keeps the agent's background tasks that outlive its turn. Returns whether the last
    /// one just finished, so the idle release starts over from this report.
    fn set_background_tasks(&self, tasks: Vec<Value>) -> bool {
        let (emptied, shown) = {
            let mut state = self.state.lock();
            if state.background_tasks == tasks {
                return false;
            }
            let emptied = !state.background_tasks.is_empty() && tasks.is_empty();
            let background = shown_background(&tasks, &state.task.background);
            let shown = background != *state.task.background;
            *state.task.background = background;
            state.background_tasks = tasks;
            if emptied {
                // Void a release scheduled while the tasks still ran: it would stop the
                // agent sooner than the usual delay after this one.
                self.idle_epoch.fetch_add(1, Ordering::AcqRel);
            }
            (emptied, shown)
        };
        if shown {
            self.emit_task();
        }
        emptied
    }

    fn clear_shown_background(&self) {
        let cleared = !std::mem::take(&mut self.state.lock().task.background).is_empty();
        if cleared {
            self.emit_task();
        }
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
                saved: s.saved.clone(),
                subagents: s.conversation.saved_subagents(),
                pending_rollback: s.pending_rollback,
                title_renamed: s.title_renamed,
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
            let mut streamed = self.streamed.lock();
            indices
                .into_iter()
                .filter_map(|(subagent, i)| {
                    let entry = s.conversation.timeline(&subagent)?.entries.get(i)?;
                    Some(entry_event(&self.id, &mut streamed, subagent, i, entry))
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
                (None, Ok(_)) => {
                    self.set_status(AgentStatus::Ready, None);
                    return self.release_when_idle();
                }
                (None, Err(failure)) => return self.fail(failure),
            }
        }
    }

    /// Stops the agent's process once the task has stayed idle for [`IDLE_RELEASE`], so
    /// finished tasks don't keep an agent (and what it started) running. Only an agent that
    /// reloads its session: the next message starts it again with the conversation intact.
    /// A turn's background tasks outlive it: the release waits for the last one, and the
    /// delay runs again once the agent reports it done.
    fn release_when_idle(self: &Arc<Self>) {
        let turn = self.turns.load(Ordering::Acquire);
        let epoch = self.idle_epoch.load(Ordering::Acquire);
        let delay = Duration::from_millis(self.shared.idle_release_ms.load(Ordering::Relaxed));
        let task = Arc::downgrade(self);
        self.shared.runtime.spawn(async move {
            tokio::time::sleep(delay).await;
            let Some(task) = task.upgrade() else { return };
            if task.turns.load(Ordering::Acquire) != turn
                || task.idle_epoch.load(Ordering::Acquire) != epoch
                || task.state.lock().busy
                || !task.permissions.lock().is_empty()
            {
                return;
            }
            // Stopping now would orphan what the agent still runs in the background: its
            // result would never reach the conversation. Wait for the last task; when it
            // is done, its report voids this schedule and starts the delay over.
            let waiting = !task.state.lock().background_tasks.is_empty();
            if waiting && task.live.lock().as_ref().is_some_and(|l| l.resumable && !l.peer.is_closed()) {
                tracing::debug!("agent task {}: idle, waiting for its background tasks", task.id);
                task.release_when_idle();
                return;
            }
            let live = {
                let mut live = task.live.lock();
                if live.as_ref().is_some_and(|l| l.resumable && !l.peer.is_closed()) { live.take() } else { None }
            };
            if let Some(live) = live {
                tracing::debug!("agent task {}: idle, stopping the agent until the next message", task.id);
                live.peer.kill();
                task.clear_shown_background();
            }
        });
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
        self.clear_shown_background();
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
            images: prompt.images,
            sent_ms: Some(now_ms()),
            done_ms: None,
            steered: true,
        });
        Ok(())
    }

    /// Sends one prompt, starting the agent first if needed; returns the stop reason.
    async fn turn(self: &Arc<Self>, prompt: &AgentPrompt) -> Result<String, Failure> {
        self.turns.fetch_add(1, Ordering::AcqRel);
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
            images: prompt.images.clone(),
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
        let guidance = self.live.lock().as_ref().map(|live| live.sign_in_message.clone());
        Failure::from(self.sign_in_error(&e, guidance.as_deref()).unwrap_or_else(|| self.describe(e)))
    }

    fn sign_in_error(&self, e: &RpcError, guidance: Option<&str>) -> Option<String> {
        let RpcError::Server { code, message, .. } = e else { return None };
        if !acp::auth_required(*code, message) {
            return None;
        }
        tracing::warn!(task = %self.id, code, %message, "agent sign-in failed");
        let Some(guidance) = guidance else { return Some(message.clone()) };
        Some(if message.trim().is_empty() || guidance.contains(message) {
            guidance.to_owned()
        } else {
            format!("{guidance}\n\n{message}")
        })
    }

    /// Runs `method` and, on an auth error, tries the agent's own ACP `authenticate` once before retrying.
    async fn request_with_auth(
        &self,
        peer: &acp::Conn,
        init: &acp::Negotiated,
        tried_auth: &mut bool,
        method: &str,
        params: Value,
    ) -> Result<Value, RpcError> {
        let first = peer.request(method, params.clone(), None).await;
        if !*tried_auth
            && let Err(RpcError::Server { code, ref message, .. }) = first
            && acp::auth_required(code, message)
            && let Some(method_id) = init.agent_auth_method()
        {
            *tried_auth = true;
            match peer.request::<_, Value>("authenticate", json!({ "methodId": method_id }), None).await {
                Ok(_) => return peer.request(method, params, None).await,
                Err(e) => tracing::debug!(task = %self.id, method_id, error = %e, "agent authenticate failed"),
            }
        }
        first
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
        let launch_cwd = cwd.clone();
        let spec = tokio::task::spawn_blocking(move || spec.resolve_for_launch(&launch_cwd))
            .await
            .map_err(|e| e.to_string())?;
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
        let sign_in_message = spec.sign_in_message(&init.auth_methods);
        let can_load = init.load_session();
        let (capabilities, embedded) = capabilities_of(&init);
        let mcp_servers = self.shared.mcp_servers_for_session(&provider_id, &init);
        // Agents that compare canonical paths fail in a symlinked directory (macOS `/tmp`).
        let cwd_s = dunce::canonicalize(&cwd).unwrap_or(cwd).to_string_lossy().into_owned();

        let mut tried_auth = false;
        let mut session = None;
        if let (Some(id), true) = (saved, can_load) {
            self.replaying.store(true, Ordering::Release);
            let params = json!({ "sessionId": &id, "cwd": &cwd_s, "mcpServers": &mcp_servers });
            let loaded = self.request_with_auth(&peer, &init, &mut tried_auth, "session/load", params).await;
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
                let params = json!({ "cwd": &cwd_s, "mcpServers": &mcp_servers });
                let v = self
                    .request_with_auth(&peer, &init, &mut tried_auth, "session/new", params)
                    .await
                    .map_err(|e| self.sign_in_error(&e, Some(&sign_in_message)).unwrap_or_else(|| self.describe(e)))?;
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
        if known {
            self.shared.remember(&provider_id, Some(&reported), None, model_of(&reported).as_deref());
        }
        let (mut options, mut wanted) = {
            let s = self.state.lock();
            (if known { reported } else { s.task.config.clone() }, s.wanted.clone())
        };
        config::add_client_options(&provider_id, &mut options);
        // Changing model can replace the effort choices; validate those only afterwards.
        wanted.sort_by_key(|c| match options.iter().find(|o| o.id == c.id).and_then(|o| o.category.as_deref()) {
            Some("model") => 0,
            Some("thought_level") => 2,
            _ => 1,
        });
        let mut model_options = known;
        for choice in &wanted {
            // An option the session doesn't offer yet is set once it does (`apply_late_choices`).
            let Some(o) = options.iter().find(|o| o.id == choice.id).cloned() else { continue };
            if o.id == config::CURSOR_APPROVAL {
                if o.values.iter().any(|v| v.value == choice.value) {
                    options.iter_mut().find(|o| o.id == choice.id).unwrap().current = Some(choice.value.clone());
                }
                continue;
            }
            if o.category.as_deref() == Some("thought_level") && !model_options {
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
                        model_options = true;
                    } else if o.category.as_deref() == Some("model") {
                        if o.current.as_deref() != Some(choice.value.as_str()) {
                            options.retain(|o| o.category.as_deref() != Some("thought_level"));
                        }
                        model_options = false;
                    }
                    if let Some(o) = options.iter_mut().find(|o| o.id == choice.id) {
                        o.current = Some(choice.value.clone());
                    }
                }
                Err(e) => tracing::warn!("agent task {}: setting {} to {} failed: {e}", self.id, o.id, choice.value),
            }
        }
        let model = model_of(&options).filter(|_| model_options);
        self.shared.remember(&provider_id, Some(&options), None, model.as_deref());
        {
            let mut s = self.state.lock();
            s.task.model = model_of(&options).or(s.task.model.take());
            s.task.config = options;
            s.task.capabilities = capabilities;
            s.session_id = Some(session_id.clone());
            // The (re)started process runs nothing yet: whatever it reports next is all of it.
            s.background_tasks = Vec::new();
            s.task.background.clear();
        }
        self.persist();
        self.emit_task();
        let live =
            Live { sign_in_message, peer, session: session_id, capabilities, embedded, resumable: can_load, init };
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
            self.approve_pending();
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
                        } else if option.category.as_deref() == Some("model") {
                            s.task.config.retain(|o| o.category.as_deref() != Some("thought_level"));
                        }
                        if let Some(o) = s.task.config.iter_mut().find(|o| o.id == option.id) {
                            o.current = Some(value);
                        }
                        s.task.model = model_of(&s.task.config).or(s.task.model.take());
                        let model = s.task.model.clone().filter(|_| {
                            reply.get("configOptions").is_some() || option.category.as_deref() != Some("model")
                        });
                        let (provider, options) = (s.task.provider.clone(), s.task.config.clone());
                        drop(s);
                        task.shared.remember(&provider, Some(&options), None, model.as_deref());
                    }
                    Err(e) => tracing::warn!("agent task {}: setting {} to {value} failed: {e}", task.id, option.id),
                }
            }
            task.approve_pending();
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
            RpcError::Server { message, data, .. } => with_details(message, data.as_ref()),
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
        if kind == LIMITS_UPDATE {
            if !self.replaying.load(Ordering::Acquire) {
                let provider = self.state.lock().task.provider.clone();
                self.shared.emit(AgentEvent::Limits { provider, limits: config::limits_of(update) });
            }
            return;
        }
        if kind == BACKGROUND_TASKS_UPDATE {
            if !self.replaying.load(Ordering::Acquire) {
                let tasks = update.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
                // The last one finished while the agent is up: the usual delay starts over.
                if self.set_background_tasks(tasks) {
                    self.release_when_idle();
                }
            }
            return;
        }
        if kind == "session_info_update" {
            // The agent's own title for the session replaces the first line of the prompt,
            // unless the user named the task.
            let title = update.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
            if let Some(title) = title {
                // Check and write under one lock: a rename landing between them would be lost.
                let mut s = self.state.lock();
                if !s.title_renamed && s.task.title != title {
                    s.task.title = title.to_owned();
                    drop(s);
                    self.persist();
                    self.emit_task();
                }
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
                    s.task.commands = config::commands_of(update, &provider);
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
            let (config, commands, model) = {
                let s = self.state.lock();
                (
                    s.task.config.clone(),
                    s.task.commands.clone(),
                    s.task.model.clone().filter(|_| kind == "config_option_update"),
                )
            };
            self.shared.remember(&provider, Some(&config), Some(&commands), model.as_deref());
            if kind != "usage_update" {
                self.persist();
            }
            self.emit_task();
            if kind == "config_option_update" && !self.replaying.load(Ordering::Acquire) {
                self.apply_late_choices();
            }
            if !self.replaying.load(Ordering::Acquire) && kind == "current_mode_update" {
                self.approve_pending();
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
        let (questions, by_index) = asked_questions(params);
        let title = permission_title(params);
        // An agent that answers by index titles its request "Ask user N question(s)"; its
        // first question says what it wants, as the Claude Code adapter titles its own.
        let title =
            if by_index { questions.first().map(|question| question.question.clone()).unwrap_or(title) } else { title };
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
        let asked: Vec<String> = questions
            .iter()
            .map(|question| question.answer_key.clone().unwrap_or_else(|| question.question.clone()))
            .collect();
        let (tx, rx) = std::sync::mpsc::channel();
        let entry =
            self.push_entry(AgentEntry::Permission { id, title, options: options.clone(), questions, chosen: None });
        self.permissions.lock().insert(id, tx);
        self.set_status(AgentStatus::NeedsInput, None);
        self.approve_pending();

        let answer = rx.recv().ok().flatten();
        let answers = answer
            .as_deref()
            .filter(|_| !asked.is_empty())
            .and_then(|reply| serde_json::from_str::<serde_json::Map<String, Value>>(reply).ok());
        let name = match &answers {
            Some(answers) => asked
                .iter()
                .filter_map(|question| answers.get(question))
                .map(|items| match items {
                    Value::Array(items) => items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
                    item => item.as_str().unwrap_or_default().to_owned(),
                })
                .collect::<Vec<_>>()
                .join("; "),
            None => answer
                .as_ref()
                .and_then(|reply| options.iter().find(|option| &option.id == reply))
                .map_or_else(|| "Cancelled".to_owned(), |option| option.name.clone()),
        };
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
        // An agent that answers by index reads the answers beside the outcome, keyed by
        // question index, with its Submit option chosen; anything less cancels the request.
        if by_index {
            let submit = options.iter().find(|option| option.kind == "allow_once").or_else(|| options.first());
            return match (answers.as_ref(), submit) {
                (Some(answers), Some(submit)) => {
                    let picked: serde_json::Map<String, Value> = asked
                        .iter()
                        .enumerate()
                        .filter_map(|(index, question)| {
                            let items = answers.get(question)?;
                            let answer = match items {
                                Value::Array(items) => {
                                    items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")
                                }
                                item => item.as_str().unwrap_or_default().to_owned(),
                            };
                            Some((index.to_string(), json!(answer)))
                        })
                        .collect();
                    json!({ "outcome": { "outcome": "selected", "optionId": submit.id }, "answers": picked })
                }
                _ => json!({ "outcome": { "outcome": "cancelled" } }),
            };
        }
        match answer {
            Some(option) => json!({ "outcome": { "outcome": "selected", "optionId": option } }),
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        }
    }

    fn approve_pending(&self) {
        let s = self.state.lock();
        if self.cancel_pending.load(Ordering::Acquire) || !config::bypass_approvals(&s.task.config) {
            return;
        }
        let mut pending = self.permissions.lock();
        for entry in s.conversation.main.entries.iter().rev() {
            // A request with questions is never satisfied by a bypass: its Submit option
            // would answer with no answers.
            if let AgentEntry::Permission { id, options, questions, chosen: None, .. } = entry
                && questions.is_empty()
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

    /// Stops the agent; returns its connection, to wait for its process to exit.
    fn kill(&self) -> Option<acp::Conn> {
        self.cancel_permissions();
        let live = self.live.lock().take()?;
        live.peer.kill();
        self.clear_shown_background();
        Some(live.peer)
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

fn permission_title(params: &Value) -> String {
    let call = &params["toolCall"];
    let title = call.get("title").and_then(Value::as_str).filter(|t| !t.is_empty());
    if call.get("kind").and_then(Value::as_str) == Some("execute") {
        if let Some(command) = call.pointer("/rawInput/command").and_then(Value::as_str).filter(|c| !c.is_empty()) {
            // Network approvals describe the host rather than approving command execution.
            if !title.is_some_and(|t| t.starts_with("Allow network access to ")) {
                return format!("Run {}", shell_script(command).unwrap_or_else(|| command.to_owned()));
            }
        }
        if title.is_none()
            && let Some(content) = call.get("content").and_then(Value::as_array)
            && let Some(text) = content.iter().find_map(|c| c.pointer("/content/text").and_then(Value::as_str))
        {
            return format!("Run {text}");
        }
    }
    title.unwrap_or("The agent asks for permission").to_owned()
}

/// The script of a `<shell> -c <quoted script>` command line, when the whole line is exactly that.
pub(crate) fn shell_script(command: &str) -> Option<String> {
    let (shell, rest) = command.split_once(' ')?;
    if !matches!(shell.rsplit('/').next(), Some("sh" | "bash" | "zsh")) {
        return None;
    }
    let quoted = rest.strip_prefix("-lc ").or_else(|| rest.strip_prefix("-c "))?;
    let mut out = String::new();
    let mut chars = quoted.chars();
    // Adjacent quoted words, e.g. 'a'\''b' or "a \"b\"".
    while let Some(c) = chars.next() {
        match c {
            '\'' => loop {
                match chars.next()? {
                    '\'' => break,
                    c => out.push(c),
                }
            },
            '"' => loop {
                match chars.next()? {
                    '"' => break,
                    '\\' => match chars.next()? {
                        c @ ('"' | '\\' | '$' | '`') => out.push(c),
                        '\n' => {}
                        c => {
                            out.push('\\');
                            out.push(c);
                        }
                    },
                    c => out.push(c),
                }
            },
            '\\' => out.push(chars.next()?),
            _ => return None,
        }
    }
    Some(out)
}

/// The questions a permission request asks, and whether they answer by question index.
/// The Claude Code adapter carries them as `_meta.questions`, answered as the option id;
/// Qwen Code (ACP) as `_meta.qwenQuestions`, answered with `answers` keyed by index beside
/// the id of its Submit option.
fn asked_questions(params: &Value) -> (Vec<AgentQuestion>, bool) {
    for (pointer, by_index) in [("/toolCall/_meta/questions", false), ("/toolCall/_meta/qwenQuestions", true)] {
        if let Some(questions) = params
            .pointer(pointer)
            .and_then(|questions| serde_json::from_value::<Vec<AgentQuestion>>(questions.clone()).ok())
            .filter(|questions| !questions.is_empty())
        {
            return (questions, by_index);
        }
    }
    (Vec::new(), false)
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

/// An error's message with the detail ACP agents put in `data` (`{"details": …}` or a string):
/// generic codes such as "Internal error" say nothing without it.
fn with_details(message: String, data: Option<&Value>) -> String {
    let details = match data {
        Some(Value::String(text)) => text.as_str(),
        Some(data) => data.get("details").and_then(Value::as_str).unwrap_or_default(),
        None => "",
    }
    .trim();
    if details.is_empty() || message.contains(details) {
        message
    } else if message.trim().is_empty() {
        details.to_owned()
    } else {
        format!("{message}: {details}")
    }
}

fn client_info() -> Value {
    json!({ "name": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") })
}

/// What the agent said it can do, and whether it takes embedded files.
fn shown_background(tasks: &[Value], known: &[AgentBackgroundTask]) -> Vec<AgentBackgroundTask> {
    let now = now_ms();
    tasks
        .iter()
        .filter_map(|task| {
            let id = task.get("task_id")?.as_str()?.to_owned();
            let started_ms = known.iter().find(|seen| seen.id == id).map_or(now, |seen| seen.started_ms);
            let text = |key: &str| task.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
            Some(AgentBackgroundTask { id, kind: text("task_type"), description: text("description"), started_ms })
        })
        .collect()
}

fn capabilities_of(init: &acp::Negotiated) -> (AgentCapabilities, bool) {
    let meta = |p: &str| init.meta(p).and_then(Value::as_bool) == Some(true);
    let capabilities = AgentCapabilities {
        images: init.prompt("image"),
        fork: init.session("fork"),
        rollback: meta("/openidea/rollback"),
        steer: meta("/openidea/steer"),
        background_tasks: meta("/openidea/backgroundTasks"),
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

fn is_false(b: &bool) -> bool {
    !*b
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

/// Commands the agent implements on its own and never lists in `availableCommands` —
/// its CLI builtins, passed through as prompt text (e.g. `/compact`). `(name, description)`.
fn builtin_commands(provider: &str) -> &'static [(&'static str, &'static str)] {
    match provider {
        // OpenCode ACP handles `/compact` via session.summarize but omits it from its command list.
        "opencode" => &[("compact", "compact the conversation")],
        _ => &[],
    }
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

/// The user's home, for tools that keep state there (Codex sessions).
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
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

// The desktop advertises its relay only while the built-in server is listening.
static MCP_EXECUTABLE: parking_lot::RwLock<Option<std::path::PathBuf>> = parking_lot::RwLock::new(None);

pub fn set_mcp_executable(executable: Option<std::path::PathBuf>) {
    *MCP_EXECUTABLE.write() = executable;
}

fn mcp_servers_for(supported: bool, root: &std::path::Path) -> Vec<Value> {
    stdio_mcp_servers(MCP_EXECUTABLE.read().as_deref(), supported, root)
}

fn stdio_mcp_servers(executable: Option<&std::path::Path>, supported: bool, root: &std::path::Path) -> Vec<Value> {
    let Some(executable) = executable.filter(|_| supported) else { return Vec::new() };
    let command = ide_mcp::stdio_command(executable, root);
    vec![json!({ "name": "OpenIDEA", "command": command[0], "args": command[1..], "env": [] })]
}

/// What was sent of a streaming message: its first `bytes` (`utf16` UTF-16 units), which
/// ended with `tail`. A message only grows while it streams, so its tail tells a message
/// that went on from one that was replaced without comparing (or keeping) all of it.
struct Sent {
    index: usize,
    bytes: usize,
    utf16: usize,
    tail: String,
}

const SENT_TAIL: usize = 64;

impl Sent {
    fn new(index: usize, text: &str) -> Self {
        Self::after(index, text, 0, 0)
    }

    /// `text` as sent, of which the first `bytes` (`utf16` units) were sent before.
    fn after(index: usize, text: &str, bytes: usize, utf16: usize) -> Self {
        let mut start = text.len().saturating_sub(SENT_TAIL);
        while !text.is_char_boundary(start) {
            start -= 1;
        }
        let utf16 = utf16 + text[bytes..].encode_utf16().count();
        Self { index, bytes: text.len(), utf16, tail: text[start..].to_owned() }
    }

    /// Whether `text` at `index` is this message, gone on.
    fn extended_by(&self, index: usize, text: &str) -> bool {
        self.index == index
            && text.len() > self.bytes
            && text.is_char_boundary(self.bytes)
            && text[..self.bytes].ends_with(&self.tail)
    }
}

/// The event that brings the UI's copy of entry `i` up to date: only the new text when
/// it extends the message last sent for the session, else the whole entry.
fn entry_event(
    task: &str,
    streamed: &mut HashMap<Session, Sent>,
    subagent: Session,
    i: usize,
    entry: &AgentEntry,
) -> AgentEvent {
    let text = match entry {
        AgentEntry::Agent { text } | AgentEntry::Thought { text } => Some(text),
        _ => None,
    };
    let Some(text) = text else {
        if streamed.get(&subagent).is_some_and(|sent| sent.index == i) {
            streamed.remove(&subagent);
        }
        return AgentEvent::Entry { task: task.to_owned(), subagent, index: i as u32, entry: entry.clone() };
    };
    match streamed.get(&subagent).filter(|sent| sent.extended_by(i, text)) {
        Some(sent) => {
            let (bytes, from) = (sent.bytes, sent.utf16);
            streamed.insert(subagent.clone(), Sent::after(i, text, bytes, from));
            AgentEvent::Append {
                task: task.to_owned(),
                subagent,
                index: i as u32,
                from: from as u32,
                text: text[bytes..].to_owned(),
            }
        }
        None => {
            streamed.insert(subagent.clone(), Sent::new(i, text));
            AgentEvent::Entry { task: task.to_owned(), subagent, index: i as u32, entry: entry.clone() }
        }
    }
}
