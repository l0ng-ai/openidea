//! Coding agents (Claude Code, Codex, Gemini CLI…) driven over the Agent Client Protocol.
//!
//! A task is one agent conversation, working in its own git worktree or in the project
//! checkout. Each task runs its agent's ACP server as a child process (newline-delimited
//! JSON-RPC over stdio), folds `session/update` notifications into a timeline, and streams
//! timeline and status changes to the subscribed window. Tasks are saved under the
//! project's store directory and survive restarts; the agent session is reloaded on the
//! next prompt when the agent supports `session/load`.

mod acp;
mod async_questions;
mod catalogs;
mod cli_update;
mod config;
mod conversation;
mod elicitation;
mod external;
pub mod hermes;
mod images;
pub mod mcp;
mod model;
mod native;
mod provider;
pub mod registry;
pub mod security;
mod shell;
pub mod skill_installer;
pub mod skills;
mod timeline;
mod worktree;

pub use catalogs::AgentCatalogs;
pub use cli_update::{AgentCliOffer, AgentCliUpdateResult};
pub use external::ExternalSession;
pub use model::*;
pub use provider::{LoginLaunch, gh_authenticated_accounts, gh_login_launch};
pub use skill_installer::{
    InstallRemoteSkillRequest, RemoteSkillBrowseResult, RemoteSkillCandidate, RemoteSkillFile, RemoteSkillPreview,
    SkillScanWarning, SkillScanWarningKind,
};

use conversation::{Conversation, SavedSubagent, Session};
use ide_core::{IdeError, IdeResult, IpcPath, error::ErrorKind};
use ide_jsonrpc::{Framing, Handler, Peer, RpcError, codes};
use ide_vcs::Repo;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::hash::Hasher;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

/// Resolves agent `id`'s interactive sign-in command without an open project.
pub fn login_launch_without_project(
    custom_agents_dir: Option<&Path>,
    secrets: Option<&dyn EnvSecrets>,
    cwd: &Path,
    id: &str,
) -> IdeResult<LoginLaunch> {
    let spec = provider::load(custom_agents_dir, secrets)
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| IdeError::not_found(format!("unknown agent '{id}'")))?;
    spec.login_launch(cwd, None)
        .ok_or_else(|| IdeError::unavailable(format!("{} cannot be signed in directly from OpenIDEA", spec.name)))
}

/// Queries Copilot's default CLI sign-in status alongside authenticated `gh` accounts.
pub async fn copilot_auth_status_with(
    custom_agents_dir: Option<&Path>,
    secrets: Option<&dyn EnvSecrets>,
    cwd: &Path,
) -> CopilotAuthStatus {
    let copilot_spec = provider::load(custom_agents_dir, secrets).into_iter().find(|p| p.id == "copilot");
    let cwd_buf = cwd.to_path_buf();
    let cli_fut = async move {
        let spec = copilot_spec?;
        native::copilot::probe_auth_status(spec, cwd_buf).await
    };
    let gh_fut = tokio::task::spawn_blocking(provider::gh_authenticated_accounts);
    let (cli, gh) = tokio::join!(cli_fut, gh_fut);
    let (gh_installed, gh_accounts) = gh.unwrap_or((false, Vec::new()));
    match cli {
        Some(cli) => CopilotAuthStatus {
            authenticated: cli.authenticated,
            login: cli.login,
            auth_type: cli.auth_type,
            status_message: cli.status_message,
            gh_installed,
            gh_accounts,
        },
        None => CopilotAuthStatus { gh_installed, gh_accounts, ..CopilotAuthStatus::default() },
    }
}

/// Receives the events of one project's tasks.
pub type AgentSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Returns the active command execution security policy for the project.
pub type SecurityHook = Arc<dyn Fn() -> ide_core::settings::AgentSecuritySettings + Send + Sync>;

/// Returns the user's choice of the approvals new tasks start with.
pub type NewTaskApprovalsHook = Arc<dyn Fn() -> ide_core::settings::NewTaskApprovals + Send + Sync>;

/// Returns the roots of the project's workspace an agent may work in: the project and the
/// attached projects the user trusts.
pub type WorkspaceRootsHook = Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync>;

/// Returns the project's git executable (`None`: the default), which the tasks' git runs.
pub type GitExecutableHook = Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>;

/// Entry changes are batched for this long before they are sent.
const FLUSH_DELAY: Duration = Duration::from_millis(40);
/// A save asked for with `persist_soon` waits this long for others to join it.
const SAVE_DELAY: Duration = Duration::from_millis(250);
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
/// A native agent's diagnostic, including warnings emitted before a session exists.
pub(crate) const WARNING_NOTIFICATION: &str = "_openidea/warning";
/// Referenced files up to this size are embedded in the prompt (when the agent takes it).
const MAX_EMBED: u64 = 256 * 1024;
/// How long a probe waits for the agent to answer `initialize`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long deleting a task waits for its agent to exit before removing the worktree.
const EXIT_WAIT: Duration = Duration::from_secs(5);
/// Change lists can each open several Git pipes; leave room for interactive VCS operations.
const MAX_CHANGE_READS: usize = 4;

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
    /// Shared by every project/window on this backend.
    pub catalogs: Arc<AgentCatalogs>,
    /// User-defined agents, one `<id>.toml` each (`name`, `command`, `args`, `env`).
    pub custom_agents_dir: Option<PathBuf>,
    /// The user's home: its `.claude` holds their own skills and commands.
    pub home_dir: Option<PathBuf>,
    /// Where the values of the agent files' environment variables are kept; without it they stay in the files.
    pub env_secrets: Option<Arc<dyn EnvSecrets>>,
}

/// Keeps the values of agent files' environment variables (`agent/<id>/env/<name>`) out of
/// the files, which keep only the names; the app keeps them in the OS credential store.
pub trait EnvSecrets: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> IdeResult<()>;
    fn delete(&self, key: &str);
    /// The keys that start with `prefix`.
    fn keys(&self, prefix: &str) -> Vec<String>;
}

/// Starts the ACP server of a provider in a directory, speaking to `client`.
type Connector = Arc<
    dyn Fn(&provider::ProviderSpec, &Path, Arc<dyn Handler>, Box<dyn Fn(String) + Send + Sync>) -> std::io::Result<Peer>
        + Send
        + Sync,
>;

/// Returns the configured MCP servers (User and Workspace) for this project.
pub type McpServersFn = dyn Fn() -> Vec<McpServer> + Send + Sync;

/// Returns the executable of the running built-in MCP server, if any.
pub type McpExecutableFn = dyn Fn() -> Option<PathBuf> + Send + Sync;

/// The `[agents.skills.<name>]` policies a session resolves against: the user's (global
/// `settings.toml`), the workspace's (`.openidea/settings.toml`), and whether the workspace
/// is trusted (an untrusted one can only turn skills off).
#[derive(Clone, Debug)]
pub struct SkillsPolicy {
    pub user: BTreeMap<String, AgentSkillPolicy>,
    pub workspace: BTreeMap<String, AgentSkillPolicy>,
    pub workspace_trusted: bool,
    /// All workspace folders (the project root plus any multi-repo workspace members).
    pub workspace_roots: Vec<PathBuf>,
    /// Validated `<dir>` folders contributed by live OpenIDEA plugins (`[[contributes.skills]]`).
    pub plugin_dirs: Vec<PathBuf>,
}

impl Default for SkillsPolicy {
    fn default() -> Self {
        Self {
            user: BTreeMap::new(),
            workspace: BTreeMap::new(),
            workspace_trusted: true,
            workspace_roots: Vec::new(),
            plugin_dirs: Vec::new(),
        }
    }
}

/// Returns the skill policies for this project.
pub type SkillsPolicyFn = dyn Fn() -> SkillsPolicy + Send + Sync;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CopilotBinaryKey {
    command: String,
    github_account: Option<String>,
    modified: Option<std::time::SystemTime>,
    len: Option<u64>,
}

struct Shared {
    paths: AgentPaths,
    runtime: tokio::runtime::Handle,
    connector: Connector,
    sinks: RwLock<HashMap<String, AgentSink>>,
    security: RwLock<Option<SecurityHook>>,
    new_task_approvals: RwLock<Option<NewTaskApprovalsHook>>,
    workspace_roots: RwLock<Option<WorkspaceRootsHook>>,
    git_executable: RwLock<Option<GitExecutableHook>>,
    change_reads: Arc<tokio::sync::Semaphore>,
    known: Arc<Mutex<HashMap<String, Known>>>,
    providers: RwLock<Vec<provider::ProviderSpec>>,
    /// Last probe of each provider.
    probes: Mutex<HashMap<String, AgentProbe>>,
    /// `type: "terminal"` login arguments reported during `initialize`, by provider id.
    terminal_auth_args: RwLock<HashMap<String, Vec<String>>>,
    /// Copilot CLI installs where `--headless` failed and fell back to `--acp`.
    copilot_acp_fallback: Mutex<HashSet<CopilotBinaryKey>>,
    /// [`IDLE_RELEASE`], in milliseconds (shorter in tests).
    idle_release_ms: AtomicU64,
    mcp_servers_hook: RwLock<Option<Arc<McpServersFn>>>,
    mcp_executable_hook: RwLock<Option<Arc<McpExecutableFn>>>,
    skills_policy_hook: RwLock<Option<Arc<SkillsPolicyFn>>>,
    /// Monotonic id for [`AgentEvent::Attention`] episodes.
    attention_seq: AtomicU64,
}

/// What an agent offered, for the New Task page.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Known {
    /// By project root: skills and custom commands differ per project.
    #[serde(default, rename = "projectCommands")]
    commands: HashMap<String, Vec<AgentCommand>>,
    /// Model catalogs by project root, valid for the launch context they were read with.
    #[serde(default, rename = "projectCatalogs")]
    catalogs: HashMap<String, catalogs::SavedCatalog>,
}

impl Shared {
    /// The workspace roots offered to a session besides its own directory and project, for an
    /// agent that takes them (`sessionCapabilities.additionalDirectories`).
    fn additional_directories(&self, init: &acp::Negotiated, cwd: &Path, project_root: Option<&Path>) -> Vec<String> {
        let Some(hook) = self.workspace_roots.read().clone().filter(|_| init.session("additionalDirectories")) else {
            return Vec::new();
        };
        let canonical = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let own: Vec<PathBuf> = std::iter::once(cwd).chain(project_root).map(canonical).collect();
        let mut roots = Vec::new();
        for root in hook().iter().map(|r| canonical(r)) {
            let root = root.to_string_lossy().into_owned();
            if !own.iter().any(|o| o.to_string_lossy() == root) && !roots.contains(&root) {
                roots.push(root);
            }
        }
        roots
    }

    fn spec(&self, id: &str) -> Option<provider::ProviderSpec> {
        self.providers.read().iter().find(|p| p.id == id).cloned()
    }

    fn env_secrets(&self) -> Option<&dyn EnvSecrets> {
        self.paths.env_secrets.as_deref()
    }

    fn copilot_binary_key(&self, spec: &provider::ProviderSpec) -> CopilotBinaryKey {
        let resolved = spec.clone().resolve_for_launch(&self.paths.project_root);
        let executable = dunce::canonicalize(&resolved.command).unwrap_or_else(|_| PathBuf::from(&resolved.command));
        let metadata = std::fs::metadata(&executable).ok();
        CopilotBinaryKey {
            command: executable.to_string_lossy().into_owned(),
            github_account: provider::copilot_github_account(&spec.env),
            modified: metadata.as_ref().and_then(|m| m.modified().ok()),
            len: metadata.as_ref().map(std::fs::Metadata::len),
        }
    }

    pub(crate) fn uses_copilot_acp_fallback(&self, spec: &provider::ProviderSpec) -> bool {
        let key = self.copilot_binary_key(spec);
        self.copilot_acp_fallback.lock().contains(&key)
    }

    pub(crate) fn mark_copilot_acp_fallback(&self, spec: &provider::ProviderSpec) {
        let key = self.copilot_binary_key(spec);
        if self.copilot_acp_fallback.lock().insert(key) {
            self.paths.catalogs.evict_if_idle(self, &spec.id);
        }
    }

    fn emit(&self, event: AgentEvent) {
        let mut sinks: Vec<_> = self.sinks.read().values().cloned().collect();
        let Some(last) = sinks.pop() else { return };
        for sink in sinks {
            sink(event.clone());
        }
        last(event);
    }

    /// The MCP servers passed to a session, and the names of the ones off for it.
    fn mcp_servers_for_session(
        &self,
        provider: &str,
        init: &acp::Negotiated,
        overrides: &BTreeMap<String, bool>,
    ) -> McpForSession {
        let builtin_off = overrides.get(mcp::BUILTIN_MCP_NAME) == Some(&false);
        let mut servers = if builtin_off {
            Vec::new()
        } else {
            let exe = self.mcp_executable_hook.read().as_ref().and_then(|hook| hook());
            stdio_mcp_servers(exe.as_deref(), init.mcp_stdio(), &self.paths.project_root)
        };
        let configured = self.mcp_servers_hook.read().as_ref().map(|hook| hook()).unwrap_or_default();
        servers.extend(mcp::acp_mcp_servers(&configured, provider, init, overrides));
        let off = Self::mcp_off(&configured, provider, overrides);
        McpForSession { servers, off }
    }

    fn mcp_servers_off_for_session(&self, provider: &str, overrides: &BTreeMap<String, bool>) -> Vec<String> {
        let configured = self.mcp_servers_hook.read().as_ref().map(|hook| hook()).unwrap_or_default();
        Self::mcp_off(&configured, provider, overrides)
    }

    fn mcp_off(configured: &[McpServer], provider: &str, overrides: &BTreeMap<String, bool>) -> Vec<String> {
        let mut off = mcp::servers_off(configured, provider, overrides);
        if overrides.get(mcp::BUILTIN_MCP_NAME) == Some(&false) {
            off.push(BUILTIN_SERVER.to_owned());
            off.push(mcp::BUILTIN_MCP_NAME.to_owned());
            off.sort();
            off.dedup();
        }
        off
    }

    fn known_config(&self, provider: &str) -> Vec<AgentConfigOption> {
        let config = self.paths.catalogs.cached(self, provider).config;
        self.config_for_new_task(config, provider)
    }

    fn config_for_new_task(&self, mut config: Vec<AgentConfigOption>, provider: &str) -> Vec<AgentConfigOption> {
        // Model-specific options are offered separately, never as provider-wide defaults.
        config.retain(|o| !config::is_per_model_option(o));
        config::add_client_options(provider, &mut config);
        let hook = self.new_task_approvals.read().clone();
        if hook.is_some_and(|ask| ask() == ide_core::settings::NewTaskApprovals::Ask) {
            config::ask_for_approvals(&mut config);
        } else {
            config::apply_bypass_approvals(&mut config);
        }
        config
    }

    pub(crate) fn thought_levels_for_new_task(
        &self,
        mut levels: BTreeMap<String, Vec<AgentConfigOption>>,
        provider: &str,
    ) -> BTreeMap<String, Vec<AgentConfigOption>> {
        for options in levels.values_mut() {
            config::apply_model_defaults(provider, options);
        }
        levels
    }

    /// The commands the agent offered last time in this project.
    fn known_commands(&self, provider: &str) -> Vec<AgentCommand> {
        let cache = self.known.lock();
        cache.get(provider).and_then(|k| k.commands.get(&self.root_key())).cloned().unwrap_or_default()
    }

    fn root_key(&self) -> String {
        self.paths.project_root.to_string_lossy().into_owned()
    }

    /// Keeps the commands a session offered and the effort levels it reported for `model`, the
    /// only model whose levels it describes.
    fn remember(
        &self,
        provider: &str,
        config: Option<&[AgentConfigOption]>,
        commands: Option<&[AgentCommand]>,
        model: Option<&str>,
    ) {
        let acp = self.spec(provider).is_some_and(|spec| spec.driver == provider::Driver::Acp);
        let mut changed = false;
        if let Some(commands) = commands.filter(|c| !c.is_empty()) {
            let mut cache = self.known.lock();
            let known = cache.entry(provider.to_owned()).or_default();
            if known.commands.get(&self.root_key()).map(Vec::as_slice) != Some(commands) {
                known.commands.insert(self.root_key(), commands.to_vec());
                self.persist_known(&cache);
                changed = true;
            }
        }
        // Discovery reads one model's options; a session on another model reports that model's.
        // Restore each option's agent default so a session's manual overrides never pollute the catalog.
        if acp && let Some((model, config)) = model.zip(config) {
            let levels: Vec<_> = config
                .iter()
                .filter(|o| config::is_per_model_option(o))
                .cloned()
                .map(|mut o| {
                    if let Some(def) = o.default_value.clone().filter(|d| o.values.iter().any(|v| v.value == *d)) {
                        o.current = Some(def);
                    }
                    o
                })
                .collect();
            if !levels.is_empty() {
                self.paths.catalogs.learn_levels(self, provider, model, levels);
            }
        }
        if changed {
            self.emit(AgentEvent::Providers);
        }
    }

    fn persist_known(&self, cache: &HashMap<String, Known>) {
        if let Ok(bytes) = serde_json::to_vec_pretty(cache)
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
    /// Pending model option id in task files saved before pending settings were stored separately.
    #[serde(default, skip_serializing)]
    pending_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_switch: Option<PendingModel>,
    /// In the project's own checkout: files already changed when the task started.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    before: BTreeMap<String, worktree::Stamp>,
    /// The folder (in the task store) with copies of the `before` files, for rolling back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    saved: Option<String>,
    /// In the project's own checkout, where the user and other tasks change files too: the
    /// files that changed while one of this task's turns ran, the only ones its changes list.
    /// `None` for a worktree task, and a task saved before these were recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    touched: Option<BTreeSet<String>>,
    /// The checkout as the last turn started, in task files saved before every turn's was kept.
    #[serde(default, skip_serializing)]
    turn: Option<worktree::TurnStart>,
    /// The checkout as each turn of the conversation started (by turn, `None` where it wasn't
    /// recorded), the copies in the store's `<id>.turn` folder.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    turns: Vec<Option<worktree::TurnStart>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    subagents: Vec<SavedSubagent>,
    /// Turns to drop from the session once it is loaded (a fork of an earlier point).
    #[serde(default, skip_serializing_if = "is_zero")]
    pending_rollback: u32,
    /// The user named the task: its agent's own title updates no longer replace it.
    #[serde(default, skip_serializing_if = "is_false")]
    title_renamed: bool,
    /// [`NewAgentTask::ephemeral`]: the task file is never written, and new sessions ask the
    /// agent not to save their history.
    #[serde(default, skip_serializing_if = "is_false")]
    ephemeral: bool,
    /// Start the first session as a fork of a recorded native one (once).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_native_fork: Option<ForkStart>,
}

/// A task file with its history left unread: what is decoded for every task at startup.
#[derive(Deserialize)]
struct SavedHead {
    entries: Counted,
    #[serde(default, rename = "subagents")]
    _subagents: serde::de::IgnoredAny,
    #[serde(default, rename = "turn")]
    _turn: serde::de::IgnoredAny,
    #[serde(default, rename = "turns")]
    _turns: serde::de::IgnoredAny,
    #[serde(flatten)]
    rest: serde_json::Map<String, Value>,
}

/// The history in a task file, the rest left unread.
#[derive(Deserialize)]
struct SavedBody {
    entries: Vec<Value>,
    #[serde(default)]
    subagents: Vec<SavedSubagent>,
    #[serde(default)]
    turn: Option<worktree::TurnStart>,
    #[serde(default)]
    turns: Vec<Option<worktree::TurnStart>>,
}

/// The length of a JSON array, its items skipped.
struct Counted(usize);

impl<'de> Deserialize<'de> for Counted {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Counted;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an array")
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Counted, A::Error> {
                let mut n = 0;
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {
                    n += 1;
                }
                Ok(Counted(n))
            }
        }
        deserializer.deserialize_seq(Visitor)
    }
}

/// A task file without its history (empty in the result), and how many entries its
/// conversation has.
fn read_head(bytes: &[u8]) -> Result<(TaskFile, usize), String> {
    let head: SavedHead = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let mut rest = head.rest;
    rest.insert("entries".into(), json!([]));
    let file = serde_json::from_value::<TaskFile>(upgrade(Value::Object(rest))).map_err(|e| e.to_string())?;
    Ok((file, head.entries.0))
}

/// The history saved in the task file at `path`.
fn read_body(path: &Path) -> Result<History, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let body: SavedBody = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    drop(bytes);
    let entries = body
        .entries
        .into_iter()
        .map(|mut entry| {
            upgrade_entry(&mut entry);
            serde_json::from_value::<AgentEntry>(entry)
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(History::new(entries, body.subagents, body.turn, body.turns))
}

/// A session to start as a fork of the recorded one: its source, and the id the host
/// chooses for the fork (claude); codex assigns its own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkStart {
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

/// A canonical lowercase UUID, the only session id shape either native agent writes.
fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct PendingModel {
    /// Native Codex intent, including when this model cannot expose a Fast control.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retained_service_tier: Option<AgentConfigChoice>,
    model: AgentConfigChoice,
    candidate: Option<AgentConfigValue>,
    options: Vec<AgentConfigOption>,
    choices: Vec<AgentConfigChoice>,
}

impl PendingModel {
    fn apply(&self, wanted: &mut Vec<AgentConfigChoice>, confirmed: &[AgentConfigOption]) {
        wanted.retain(|choice| {
            choice.id != self.model.id
                && !self.options.iter().any(|o| o.id == choice.id)
                && !confirmed.iter().any(|o| o.id == choice.id && config::is_per_model_option(o))
        });
        wanted.push(self.model.clone());
        wanted.extend(self.choices.iter().cloned());
        if let Some(choice) = &self.retained_service_tier
            && !wanted.iter().any(|c| c.id == choice.id)
        {
            wanted.push(choice.clone());
        }
    }
}

/// The changed files of a checkout, stamped.
type Snapshot = BTreeMap<String, worktree::Stamp>;

/// Holds `TaskState::busy` for the duration of an operation so concurrent prompts or rollbacks
/// wait until it finishes.
struct BusyGuard(Arc<Task>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.state.lock().busy = false;
    }
}

/// A task's conversation and the checkout as each of its turns started.
#[derive(Default)]
struct History {
    conversation: Conversation,
    /// See `TaskFile::turns`.
    turns: Vec<Option<Arc<worktree::TurnStart>>>,
    /// The task file's conversation couldn't be read: the task shows an empty one, and saving
    /// it is refused so the file keeps what it has.
    unreadable: bool,
}

impl History {
    fn new(
        entries: Vec<AgentEntry>,
        subagents: Vec<SavedSubagent>,
        turn: Option<worktree::TurnStart>,
        turns: Vec<Option<worktree::TurnStart>>,
    ) -> Self {
        let conversation = Conversation::restore(entries, subagents);
        let mut turns: Vec<_> = turns.into_iter().map(|t| t.map(Arc::new)).collect();
        // Saved with the last turn's only: the turns before it have none.
        if turns.is_empty()
            && let Some(last) = turn
        {
            turns.resize(turn_starts(&conversation.main.entries).len().saturating_sub(1), None);
            turns.push(Some(Arc::new(last)));
        }
        Self { conversation, turns, unreadable: false }
    }

    /// The history saved in the task file at `path`, settled: the agent that was running
    /// when it was saved did not survive the restart.
    fn read(path: &Path) -> Self {
        match read_body(path) {
            Ok(mut history) => {
                history.conversation.settle(now_ms());
                history
            }
            Err(e) => {
                tracing::warn!("reading the conversation of agent task {}: {e}", path.display());
                Self { unreadable: true, ..Self::default() }
            }
        }
    }
}

/// A task's [`History`], read from its file the first time anything needs it: most tasks of
/// a project aren't opened between two starts, and their conversations are most of what the
/// task store holds.
struct StoredHistory {
    /// The task file, for a history not read yet.
    file: Option<PathBuf>,
    history: std::cell::OnceCell<History>,
}

impl StoredHistory {
    fn loaded(history: History) -> Self {
        Self { file: None, history: std::cell::OnceCell::from(history) }
    }

    fn on_disk(file: PathBuf) -> Self {
        Self { file: Some(file), history: std::cell::OnceCell::new() }
    }

    /// Whether the history is in memory (tests).
    #[cfg(test)]
    fn is_loaded(&self) -> bool {
        self.history.get().is_some()
    }
}

impl std::ops::Deref for StoredHistory {
    type Target = History;

    fn deref(&self) -> &History {
        self.history.get_or_init(|| self.file.as_deref().map(History::read).unwrap_or_default())
    }
}

impl std::ops::DerefMut for StoredHistory {
    fn deref_mut(&mut self) -> &mut History {
        let _ = &**self;
        self.history.get_mut().expect("the history was just read")
    }
}

struct TaskState {
    task: AgentTask,
    session_id: Option<String>,
    /// The conversation and its turns' checkouts, read from the task file on first use.
    history: StoredHistory,
    wanted: Vec<AgentConfigChoice>,
    pending_model: Option<PendingModel>,
    model_choice: u64,
    discovering_model: Option<u64>,
    before: Arc<BTreeMap<String, worktree::Stamp>>,
    saved: Option<String>,
    /// See `TaskFile::touched`.
    touched: Option<Arc<BTreeSet<String>>>,
    pending_rollback: u32,
    /// The user named the task; see `TaskFile::title_renamed`.
    title_renamed: bool,
    /// [`NewAgentTask::ephemeral`].
    ephemeral: bool,
    /// See `TaskFile::pending_native_fork`: cleared once a session is established.
    pending_native_fork: Option<ForkStart>,
    /// A turn is running or about to (prompts arriving now are queued).
    busy: bool,
    /// Background tasks the agent reported as running (`run_in_background` commands and
    /// the like), as it sent them: unlike a turn they outlive it, so an idle release
    /// waits for the last one. A (re)started process runs nothing yet.
    background_tasks: Vec<Value>,
    /// Shell commands the user ran with `!` since the last prompt, as the text block that
    /// goes ahead of the next one.
    shell_context: Vec<String>,
}

impl TaskState {
    fn snapshot(&self) -> AgentTask {
        let mut task = self.task.clone();
        if let Some(pending) = &self.pending_model
            && let Some(model) = task.config.iter_mut().find(|o| o.id == pending.model.id)
        {
            model.current = Some(pending.model.value.clone());
            if let Some(candidate) = &pending.candidate
                && !model.values.iter().any(|v| v.value == candidate.value)
            {
                model.values.push(candidate.clone());
            }
            task.config.retain(|o| !config::is_per_model_option(o));
            task.config.extend(pending.options.iter().cloned().map(|mut option| {
                if let Some(choice) = pending
                    .choices
                    .iter()
                    .chain(pending.retained_service_tier.iter())
                    .find(|choice| choice.id == option.id)
                {
                    option.current = Some(choice.value.clone());
                }
                option
            }));
        }
        task
    }
}

struct DiscoveringModel<'a> {
    state: &'a Mutex<TaskState>,
    generation: u64,
}

impl Drop for DiscoveringModel<'_> {
    fn drop(&mut self) {
        let mut s = self.state.lock();
        if s.discovering_model == Some(self.generation) {
            s.discovering_model = None;
        }
    }
}

/// A running agent and its session.
#[derive(Clone)]
struct Live {
    provider: String,
    driver: provider::Driver,
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
    /// Serializes replies from multiple windows to the same async question.
    answering_questions: tokio::sync::Mutex<()>,
    /// Unanswered permission requests: where to send the chosen option id.
    permissions: Mutex<HashMap<u32, std::sync::mpsc::Sender<Option<String>>>>,
    next_permission: AtomicU32,
    /// Set while `session/load` replays the session's history.
    replaying: AtomicBool,
    /// The task has a session but none of its history (an imported session): the next load's
    /// replay becomes the task's history instead of being dropped.
    adopting_replay: AtomicBool,
    /// The saved session failed to load and the user was told: the next start opens a new one.
    start_fresh: AtomicBool,
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
    /// Turned on when per-session MCP overrides changed while a turn was busy; dropped once idle.
    mcp_reload_pending: AtomicBool,
    /// Turned on when per-session skill overrides changed while a turn was busy; dropped once idle.
    skills_reload_pending: AtomicBool,
    /// Settings already sent this session (`(option, value)`), so a refusal is not retried.
    config_sent: Mutex<HashSet<(String, String)>>,
    dirty: Mutex<BTreeSet<(Session, usize)>>,
    /// What was last sent of the entries that stream, so the next flush sends the rest.
    streamed: Mutex<Streamed>,
    flush_scheduled: AtomicBool,
    stderr: Mutex<VecDeque<String>>,
    /// Saves asked for (see `persist`); the file holds those up to `file.saved`.
    saves_asked: AtomicU64,
    save_scheduled: AtomicBool,
    /// Held while the file is written, so saves land in order and none follows a delete.
    file: Mutex<SavedFile>,
}

/// What the task's file on disk holds.
#[derive(Default)]
struct SavedFile {
    /// Set by `delete`: nothing is written any more.
    deleted: bool,
    /// The saves asked for that the file holds.
    saved: u64,
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
            provider::Driver::Copilot => native::copilot::connect(spec, cwd, client, on_stderr),
        });
        Self::with_connector(paths, runtime, connector)
    }

    fn with_connector(paths: AgentPaths, runtime: tokio::runtime::Handle, connector: Connector) -> Self {
        let known = paths.catalogs.store(&paths.models_file);
        let providers = RwLock::new(provider::load(paths.custom_agents_dir.as_deref(), paths.env_secrets.as_deref()));
        let shared = Arc::new(Shared {
            paths,
            runtime,
            connector,
            sinks: RwLock::new(HashMap::new()),
            security: RwLock::new(None),
            new_task_approvals: RwLock::new(None),
            workspace_roots: RwLock::new(None),
            git_executable: RwLock::new(None),
            change_reads: Arc::new(tokio::sync::Semaphore::new(MAX_CHANGE_READS)),
            known,
            providers,
            probes: Mutex::new(HashMap::new()),
            terminal_auth_args: RwLock::new(HashMap::new()),
            copilot_acp_fallback: Mutex::new(HashSet::new()),
            idle_release_ms: AtomicU64::new(IDLE_RELEASE.as_millis() as u64),
            mcp_servers_hook: RwLock::new(None),
            mcp_executable_hook: RwLock::new(None),
            skills_policy_hook: RwLock::new(None),
            attention_seq: AtomicU64::new(0),
        });
        shared.paths.catalogs.subscribe(&shared);
        let mut tasks = HashMap::new();
        for file in std::fs::read_dir(&shared.paths.store_dir).into_iter().flatten().flatten() {
            let path = file.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            // Only the task's own fields: its conversation is read when something needs it.
            match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| read_head(&b)) {
                Ok((mut f, entries)) => {
                    // The agent process did not survive the restart: whatever was in flight is over.
                    if matches!(f.task.status, AgentStatus::Running | AgentStatus::NeedsInput | AgentStatus::Starting) {
                        f.task.status = AgentStatus::Ready;
                    }
                    f.task.retry = None;
                    f.task.background.clear();
                    // What an archived task's agent offered is only a cache, and a long list
                    // repeated in every archived task: its next session reports its own.
                    if f.task.status == AgentStatus::Archived {
                        f.task.commands = Vec::new();
                    }
                    let task = Task::restore_saved(f, entries, path, shared.clone());
                    tasks.insert(task.id.clone(), task);
                }
                Err(e) => tracing::warn!("skipping agent task {}: {e}", path.display()),
            }
        }
        Self { shared, tasks: RwLock::new(tasks) }
    }

    /// Routes events to `sink`, replacing only the sink `subscriber` (a view of the project) had;
    /// returns every task.
    pub fn subscribe_as(&self, subscriber: &str, sink: AgentSink) -> Vec<AgentTask> {
        self.shared.sinks.write().insert(subscriber.to_owned(), sink);
        let mut tasks: Vec<AgentTask> = self.tasks.read().values().map(|t| t.state.lock().snapshot()).collect();
        tasks.sort_by(|a, b| b.updated_ms.total_cmp(&a.updated_ms));
        tasks
    }

    /// A closed view releases its sink, never the task or its agent process.
    pub fn unsubscribe(&self, subscriber: &str) {
        self.shared.sinks.write().remove(subscriber);
    }

    pub fn has_live_work(&self) -> bool {
        self.tasks.read().values().any(|task| {
            let state = task.state.lock();
            state.busy
                || !state.background_tasks.is_empty()
                || matches!(state.task.status, AgentStatus::Starting | AgentStatus::Running | AgentStatus::NeedsInput)
        })
    }

    /// Sets the callback used to read the active command execution security policy.
    pub fn set_security_hook(&self, hook: SecurityHook) {
        *self.shared.security.write() = Some(hook);
    }

    /// Sets the callback that reads which approvals new tasks start with.
    pub fn set_new_task_approvals_hook(&self, hook: NewTaskApprovalsHook) {
        *self.shared.new_task_approvals.write() = Some(hook);
    }

    /// Sets the callback that lists the workspace roots offered to agents besides a task's own.
    pub fn set_workspace_roots_hook(&self, hook: WorkspaceRootsHook) {
        *self.shared.workspace_roots.write() = Some(hook);
    }

    /// Sets the callback that reads the project's git executable.
    pub fn set_git_executable_hook(&self, hook: GitExecutableHook) {
        *self.shared.git_executable.write() = Some(hook);
    }

    /// Directory holding linked Git worktrees created for agent tasks of this project.
    pub fn worktrees_dir(&self) -> &Path {
        &self.shared.paths.worktrees_dir
    }

    /// The agents (custom ones re-read), whether each is installed, and what they offered last time.
    pub fn providers(&self) -> Vec<AgentProvider> {
        let specs = provider::load(self.shared.paths.custom_agents_dir.as_deref(), self.shared.env_secrets());
        let in_use: std::collections::HashSet<String> =
            self.tasks.read().values().map(|t| t.state.lock().task.provider.clone()).collect();
        let terminal_auth = self.shared.terminal_auth_args.read();
        let list = specs
            .iter()
            .filter(|p| !provider::is_unlisted(p) || in_use.contains(&p.id))
            .map(|p| {
                let mut info = provider::describe(p);
                info.can_sign_in =
                    p.can_sign_in(&self.shared.paths.project_root, terminal_auth.get(&p.id).map(Vec::as_slice));
                let catalog = self.shared.paths.catalogs.cached(&self.shared, &p.id);
                info.config = self.shared.config_for_new_task(catalog.config, &p.id);
                info.thought_levels = self.shared.thought_levels_for_new_task(catalog.thought_levels, &p.id);
                info.commands = self.shared.known_commands(&p.id);
                info
            })
            .collect();
        drop(terminal_auth);
        let mut prev = self.shared.providers.write();
        let mut probes = self.shared.probes.lock();
        probes.retain(|id, _| {
            let old = prev.iter().find(|p| &p.id == id);
            let new = specs.iter().find(|p| &p.id == id);
            matches!((old, new), (Some(a), Some(b)) if a.command == b.command && a.args == b.args && a.env == b.env)
        });
        *prev = specs.clone();
        drop(probes);
        drop(prev);
        list
    }

    /// Resolves the interactive sign-in command for agent `id`.
    pub fn login_launch(&self, id: &str) -> IdeResult<LoginLaunch> {
        let specs = provider::load(self.shared.paths.custom_agents_dir.as_deref(), self.shared.env_secrets());
        let spec = specs
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| IdeError::not_found(format!("unknown agent '{id}'")))?;
        let terminal_args = self.shared.terminal_auth_args.read().get(id).cloned();
        let launch = spec.login_launch(&self.shared.paths.project_root, terminal_args.as_deref()).ok_or_else(|| {
            IdeError::unavailable(format!("{} cannot be signed in directly from OpenIDEA", spec.name))
        })?;
        self.shared.paths.catalogs.clear_failed_cooldown(&self.shared, id);
        Ok(launch)
    }

    /// Queries Copilot's default CLI sign-in status alongside authenticated `gh` accounts.
    pub async fn copilot_auth_status(&self) -> CopilotAuthStatus {
        let status = copilot_auth_status_with(
            self.shared.paths.custom_agents_dir.as_deref(),
            self.shared.env_secrets(),
            &self.shared.paths.project_root,
        )
        .await;
        if status.authenticated || !status.gh_accounts.is_empty() {
            self.shared.paths.catalogs.clear_failed_cooldown(&self.shared, "copilot");
        }
        status
    }

    /// Overrides built-in `id`'s command with `command` (the driver and arguments stay
    /// the built-in's) through its agent file, or returns it to auto-detection with `None`.
    pub fn set_builtin_command(&self, id: &str, command: Option<String>) -> IdeResult<()> {
        let Some(dir) = self.shared.paths.custom_agents_dir.clone() else {
            return Err(IdeError::unavailable("there is no custom agents directory"));
        };
        provider::set_builtin_command(&dir, self.shared.env_secrets(), id, command.as_deref())
    }

    /// Sets the extra arguments of a directly launched built-in ACP agent; empty resets them.
    pub fn set_builtin_additional_args(&self, id: &str, args: Vec<String>) -> IdeResult<()> {
        let Some(dir) = self.shared.paths.custom_agents_dir.as_deref() else {
            return Err(IdeError::unavailable("there is no custom agents directory"));
        };
        provider::set_builtin_additional_args(dir, self.shared.env_secrets(), id, args)
    }

    /// Sets the environment variables built-in `id` starts with; empty clears them.
    pub fn set_builtin_env(&self, id: &str, env: std::collections::BTreeMap<String, String>) -> IdeResult<()> {
        let Some(dir) = self.shared.paths.custom_agents_dir.clone() else {
            return Err(IdeError::unavailable("there is no custom agents directory"));
        };
        provider::set_builtin_env(&dir, self.shared.env_secrets(), id, env)?;
        self.shared.paths.catalogs.evict_if_idle(&self.shared, id);
        Ok(())
    }

    /// Saves a new custom ACP agent through its agent file.
    pub fn save_custom_agent(&self, input: CustomAgentInput) -> IdeResult<()> {
        let Some(dir) = self.shared.paths.custom_agents_dir.clone() else {
            return Err(IdeError::unavailable("there is no custom agents directory"));
        };
        provider::save_custom(&dir, self.shared.env_secrets(), &input)
    }

    /// Removes a custom agent's file (registry installs go through `registry_remove`).
    pub fn remove_custom_agent(&self, id: &str) -> IdeResult<()> {
        let Some(dir) = self.shared.paths.custom_agents_dir.clone() else {
            return Err(IdeError::unavailable("there is no custom agents directory"));
        };
        provider::remove_custom(&dir, self.shared.env_secrets(), id)
    }

    /// Imports a JetBrains `acp.json` file's `agent_servers` entries as custom agents.
    pub fn import_acp_agents(&self, text: &str) -> IdeResult<Vec<AcpImportOutcome>> {
        let Some(dir) = self.shared.paths.custom_agents_dir.clone() else {
            return Err(IdeError::unavailable("there is no custom agents directory"));
        };
        provider::import_acp(&dir, self.shared.env_secrets(), text)
    }

    /// Re-reads configured/installed agents, drops cached probes, and notifies subscribers.
    pub fn reload_providers(&self) {
        let specs = provider::load(self.shared.paths.custom_agents_dir.as_deref(), self.shared.env_secrets());
        *self.shared.providers.write() = specs;
        self.shared.probes.lock().clear();
        self.shared.copilot_acp_fallback.lock().clear();
        self.shared.emit(AgentEvent::Providers);
    }

    /// Provides the user and workspace MCP servers configured in settings.
    pub fn set_mcp_servers_hook(&self, hook: Box<McpServersFn>) {
        *self.shared.mcp_servers_hook.write() = Some(Arc::from(hook));
    }

    /// Provides the executable of the running built-in MCP server for this host.
    pub fn set_mcp_executable_hook(&self, hook: Box<McpExecutableFn>) {
        *self.shared.mcp_executable_hook.write() = Some(Arc::from(hook));
    }

    /// Provides the user and workspace skill policies and the workspace's trust.
    pub fn set_skills_policy_hook(&self, hook: Box<SkillsPolicyFn>) {
        *self.shared.skills_policy_hook.write() = Some(Arc::from(hook));
    }

    /// The slash commands to complete for `provider`, in `task`'s directory or (without one)
    /// in the project: what the agent offered last time there, unadvertised builtins,
    /// for Claude Code the skills and custom commands on disk it has not listed (for
    /// Hermes, its profile's skills), and the skills hub's active skills for every agent.
    pub async fn commands(&self, provider: &str, task: Option<&str>) -> IdeResult<Vec<AgentCommand>> {
        let (provider, offered, cwd) = match task {
            Some(id) => {
                let task = self.task(id)?;
                let s = task.state.lock();
                // A task without a session's list yet (archived, or just unarchived) offers
                // what its agent offered last time in the project.
                let offered = if s.task.commands.is_empty() {
                    self.shared.known_commands(&s.task.provider)
                } else {
                    s.task.commands.clone()
                };
                (s.task.provider.clone(), offered, s.task.cwd.0.clone())
            }
            None => (provider.to_owned(), self.shared.known_commands(provider), self.shared.paths.project_root.clone()),
        };
        // Commands the agent implements itself and never lists (its CLI builtins):
        // merged without duplicating what `availableCommands` or the disk offer.
        let mut offered = offered;
        if task.is_none()
            && let Some(spec) =
                provider::load(self.shared.paths.custom_agents_dir.as_deref(), self.shared.env_secrets())
                    .into_iter()
                    .find(|spec| spec.id == provider)
        {
            let (_, flight) = self.shared.paths.catalogs.request(&self.shared, spec, false, None);
            if let Some(mut ready) = flight {
                while !*ready.borrow_and_update() {
                    if ready.changed().await.is_err() {
                        break;
                    }
                }
            }
            offered = self.shared.known_commands(&provider);
        }
        for command in builtin_commands(&provider) {
            if !offered.iter().any(|c| c.name == command.name) {
                offered.push(command);
            }
        }
        let home = self.shared.paths.home_dir.clone();
        if provider == "hermes" || provider.starts_with("hermes-") {
            let hermes_home = home.clone();
            let hermes_provider = provider.clone();
            let found = blocking(move || {
                let profile =
                    hermes::root(hermes_home.as_deref()).and_then(|root| hermes::profile_home(&root, &hermes_provider));
                Ok(profile.map(|p| skills::hermes(&p)).unwrap_or_default())
            })
            .await?;
            offered = skills::merge(offered, found);
        } else if provider == "claude" || provider == "claude-acp" {
            let claude_cwd = cwd.clone();
            let found = blocking(move || Ok(skills::discover(&claude_cwd, home.as_deref()))).await?;
            offered = skills::merge(offered, found);
        }
        // The hub's active skills complete on every agent; its `off` ones drop out here
        // (including entries `offered` already held), which is all the enforcement an ACP agent gets.
        let holder = self.task_for_commands(&provider, task);
        let states = match holder {
            Some(holder) => holder.skill_states().await,
            None => {
                let (policy, root) = {
                    let shared = &self.shared;
                    let policy = shared.skills_policy_hook.read().as_ref().map(|hook| hook()).unwrap_or_default();
                    (policy, shared.paths.project_root.clone())
                };
                let roots = if policy.workspace_roots.is_empty() { vec![root] } else { policy.workspace_roots };
                let plugin_dirs = policy.plugin_dirs;
                let home = self.shared.paths.home_dir.clone();
                blocking(move || {
                    Ok(skills::resolve(
                        skills::discover_skills_with_plugins(&roots, home.as_deref(), &plugin_dirs),
                        None,
                        &policy.workspace,
                        &policy.user,
                        policy.workspace_trusted,
                    ))
                })
                .await
                .unwrap_or_default()
            }
        };
        Ok(skills::menu_commands(offered, &states))
    }

    /// The task to resolve skills for, when the commands are for one and its provider matches.
    fn task_for_commands(&self, provider: &str, task: Option<&str>) -> Option<Arc<Task>> {
        let task = self.task(task?).ok()?;
        let matches = task.state.lock().task.provider == provider;
        matches.then_some(task)
    }

    fn task(&self, id: &str) -> IdeResult<Arc<Task>> {
        self.tasks.read().get(id).cloned().ok_or_else(|| IdeError::not_found(format!("no agent task {id}")))
    }

    /// The entries of the task's conversation, or of its subagent `subagent`'s.
    pub fn entries(&self, id: &str, subagent: Option<String>) -> IdeResult<Vec<AgentEntry>> {
        let task = self.task(id)?;
        let s = task.state.lock();
        let timeline =
            s.history.conversation.timeline(&subagent).ok_or_else(|| IdeError::not_found("no such subagent"))?;
        Ok(timeline.entries.clone())
    }

    /// Session ids the tasks already hold (native drivers reuse the CLI's own id).
    fn imported_session_ids(&self) -> HashSet<String> {
        self.tasks.read().values().filter_map(|t| t.state.lock().session_id.clone()).collect()
    }

    /// Sessions of this project on this machine that no task holds yet, newest first. Reads
    /// transcripts from disk: call it off the UI and command threads.
    pub fn external_sessions(&self) -> Vec<ExternalSession> {
        let mut out = Vec::new();
        let root = self.shared.paths.project_root.clone();
        if let Some(spec) = self.shared.spec("claude")
            && let Some(dir) = native::claude::cli::config_dir(&spec.env)
        {
            out.extend(external::claude_sessions(&dir, &root));
        }
        let home = self.shared.paths.home_dir.clone().or_else(home_dir);
        if let Some(home) = home {
            out.extend(external::codex_sessions(&home.join(".codex"), &root));
        }
        let known = self.imported_session_ids();
        out.retain(|s| !known.contains(&s.session_id));
        out.sort_by(|a, b| b.updated_ms.total_cmp(&a.updated_ms));
        out.truncate(50);
        out
    }

    /// Imports an external session as a task, loading it in the background to show its history (#312).
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
            mcp_overrides: BTreeMap::new(),
            skill_overrides: BTreeMap::new(),
            stats: Box::default(),
        };
        let file = TaskFile {
            task: task.clone(),
            session_id: Some(session_id.to_owned()),
            entries: Vec::new(),
            wanted: Vec::new(),
            pending_model: None,
            pending_switch: None,
            before: BTreeMap::new(),
            saved: None,
            touched: Some(BTreeSet::new()),
            turn: None,
            turns: Vec::new(),
            subagents: Vec::new(),
            pending_rollback: 0,
            title_renamed: true,
            ephemeral: false,
            pending_native_fork: None,
        };
        let handle = Task::restore(file, self.shared.clone());
        self.tasks.write().insert(task.id.clone(), handle.clone());
        handle.emit_task();
        handle.persist();
        Ok(task)
    }

    /// Forks a recorded external session into a new task: its first turn continues the
    /// recording as the agent's own fork, under an id the host chooses. The session must
    /// belong to this project and have been recorded in `cwd`.
    pub fn fork_session(&self, provider: &str, session_id: &str, cwd: &Path) -> IdeResult<AgentTask> {
        if !matches!(provider, "claude" | "codex") {
            return Err(IdeError::invalid(format!("cannot fork {provider} sessions")));
        }
        if !canonical_uuid(session_id) {
            return Err(IdeError::invalid("the recorded session has no canonical id"));
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
        let recorded = found
            .cwd
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .ok_or_else(|| IdeError::invalid("the recorded session has no working directory"))?;
        let canonical = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        if canonical(cwd) != canonical(&recorded) {
            return Err(IdeError::invalid("the session was recorded in another directory"));
        }
        let root = self.shared.paths.project_root.clone();
        let config = self.shared.known_config(&spec.id);
        let now = now_ms();
        let id = uuid::Uuid::new_v4().simple().to_string();
        // The host names the fork's session id for claude; codex assigns its own.
        let target = (provider == "claude").then(|| uuid::Uuid::new_v4().to_string());
        let task = AgentTask {
            project_root: Some(IpcPath(root)),
            id,
            title: found.title,
            provider: spec.id.clone(),
            model: model_of(&config),
            status: AgentStatus::Ready,
            isolation: Isolation::Local,
            cwd: IpcPath(recorded),
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
            mcp_overrides: BTreeMap::new(),
            skill_overrides: BTreeMap::new(),
            stats: Box::default(),
        };
        let file = TaskFile {
            task: task.clone(),
            session_id: target.clone(),
            entries: Vec::new(),
            wanted: Vec::new(),
            pending_model: None,
            pending_switch: None,
            before: BTreeMap::new(),
            saved: None,
            touched: Some(BTreeSet::new()),
            turn: None,
            turns: Vec::new(),
            subagents: Vec::new(),
            pending_rollback: 0,
            title_renamed: true,
            ephemeral: false,
            pending_native_fork: Some(ForkStart { source: session_id.to_owned(), target }),
        };
        let handle = Task::restore(file, self.shared.clone());
        self.tasks.write().insert(task.id.clone(), handle.clone());
        handle.emit_task();
        handle.persist();
        // Loading the session replays its history into the task, so it shows before a first message.
        self.shared.runtime.spawn(async move {
            match handle.ensure_session().await {
                Ok(_) => handle.release_when_idle(),
                Err(e) => tracing::info!("agent task {}: loading the imported session failed: {e}", handle.id),
            }
        });
        Ok(task)
    }

    /// Creates the task (and its worktree) and sends `req.prompt` as its first message, unless
    /// `req.idle`.
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
                let c = vcs(&self.shared, move || worktree::create(&root, &dir, &t, b.as_deref())).await?;
                (c.path, Some(c.branch), Some(c.base), Some(c.base_commit), BTreeMap::new())
            }
            Isolation::Local => {
                let r = root.clone();
                let (head, before) = vcs(&self.shared, move || {
                    Ok((worktree::head_of(&r).ok(), worktree::snapshot(&r).unwrap_or_default()))
                })
                .await?;
                let (base, commit) = head.unzip();
                (root, None, base, commit, before)
            }
        };
        // Until the session reports its own, show what the agent offered last time with the choices applied.
        let catalog = self.shared.paths.catalogs.cached(&self.shared, &spec.id);
        let mut levels = self.shared.thought_levels_for_new_task(catalog.thought_levels, &spec.id);
        let mut config = self.shared.config_for_new_task(catalog.config, &spec.id);
        for choice in &req.config {
            if let Some(o) = config.iter_mut().find(|o| o.id == choice.id) {
                o.current = Some(choice.value.clone());
            }
        }
        if let Some(model) = model_of(&config)
            && let Some(levels) = levels.remove(&model)
        {
            config.extend(levels.into_iter().map(|mut o| {
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
            match vcs(&self.shared, move || worktree::save_before(&at, &files, &dir)).await {
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
            status: if req.idle { AgentStatus::Ready } else { AgentStatus::Starting },
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
            mcp_overrides: req.mcp_overrides,
            skill_overrides: req.skill_overrides,
            stats: Box::default(),
        };
        let file = TaskFile {
            task: task.clone(),
            session_id: None,
            entries: Vec::new(),
            wanted: req.config,
            pending_model: None,
            pending_switch: None,
            before,
            saved,
            touched: (req.isolation == Isolation::Local).then(BTreeSet::new),
            turn: None,
            turns: Vec::new(),
            subagents: Vec::new(),
            pending_rollback: 0,
            title_renamed: false,
            ephemeral: req.ephemeral,
            pending_native_fork: None,
        };
        let handle = Task::restore(file, self.shared.clone());
        handle.state.lock().busy = !req.idle;
        self.tasks.write().insert(task.id.clone(), handle.clone());
        handle.emit_task();
        handle.persist();
        if !req.idle {
            self.shared.runtime.spawn(async move { handle.run(prompt).await });
        }
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
            if s.discovering_model.is_some() {
                return Err(IdeError::unavailable("Model settings are still loading"));
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

    /// Runs `command` (a composer line starting with `!`) in the task's folder with the user's
    /// shell, without starting a turn: it shows as one entry with its output and exit code,
    /// and goes to the agent with the next message.
    pub async fn run_shell(&self, id: &str, command: &str, cancel: ide_core::CancellationToken) -> IdeResult<()> {
        let task = self.task(id)?;
        let command = command.trim();
        if command.is_empty() {
            return Err(IdeError::invalid("empty command"));
        }
        let cwd = {
            let s = task.state.lock();
            if s.task.status == AgentStatus::Archived {
                return Err(IdeError::invalid("the task is archived"));
            }
            s.task.cwd.0.clone()
        };
        task.shell(command, &cwd, &cancel).await;
        Ok(())
    }

    /// Drops a queued message.
    pub fn unqueue(&self, id: &str, queued: &str) -> IdeResult<AgentQueued> {
        self.task(id)?.take_queued(queued, false).map(|(item, _)| item)
    }

    /// Sends queued message `queued` now: into the running turn when the agent takes
    /// messages mid-turn, else next, cancelling the current turn if there is one.
    pub async fn send_queued_now(&self, id: &str, queued: &str) -> IdeResult<()> {
        let task = self.task(id)?;
        let (item, busy) = task.take_queued(queued, true)?;
        if !busy {
            self.shared.runtime.spawn(async move { task.run(item.prompt).await });
            return Ok(());
        }
        // Out of the queue while it is steered, so the turn ending meanwhile doesn't send it twice.
        let prompt = match task.steer(item.prompt).await {
            Ok(()) => return Ok(()),
            Err(prompt) => prompt,
        };
        let start = {
            let mut s = task.state.lock();
            if s.busy {
                s.task.queue.insert(0, AgentQueued { id: item.id, prompt });
                None
            } else {
                // The turn ended while steering was tried: nothing is left to interrupt.
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
                task.send_now.store(true, Ordering::Release);
                task.cancel();
            }
        }
        Ok(())
    }

    /// Changes a session setting (model, mode…): right away when the agent runs, else when it next starts.
    pub async fn set_config(&self, id: &str, option: &str, value: String) -> IdeResult<()> {
        let task = self.task(id)?;
        let provider = task.state.lock().task.provider.clone();
        let discovered = self
            .shared
            .paths
            .catalogs
            .cached(&self.shared, &provider)
            .config
            .iter()
            .find(|o| o.id == option && o.category.as_deref() == Some("model"))
            .cloned();
        let (target, change) = {
            let mut s = task.state.lock();
            let busy = s.busy;
            let archived = s.task.status == AgentStatus::Archived;
            if let Some(pending) = &mut s.pending_model
                && let Some(target) = pending.options.iter().find(|o| o.id == option)
            {
                if archived || busy {
                    return Err(IdeError::invalid("The pending model settings cannot be changed now"));
                }
                if !target.values.iter().any(|v| v.value == value) {
                    return Err(IdeError::invalid(format!("{} has no value {value}", target.name)));
                }
                pending.choices.retain(|c| c.id != option);
                pending.choices.push(AgentConfigChoice { id: option.to_owned(), value });
                drop(s);
                task.persist();
                task.emit_task();
                return Ok(());
            }
            let session_target = s.task.config.iter().find(|o| o.id == option).cloned();
            let recovered_model = session_target.is_none();
            let target = match session_target {
                Some(target) => target,
                None if discovered.is_some() => discovered.unwrap(),
                None => return Err(IdeError::not_found("no such setting")),
            };
            if s.pending_model.is_some() && config::is_per_model_option(&target) {
                return Err(IdeError::invalid("This setting is not available on the selected model"));
            }
            if recovered_model {
                (target, None)
            } else if !target.values.iter().any(|v| v.value == value) {
                if target.category.as_deref() != Some("model") {
                    return Err(IdeError::invalid(format!("{} has no value {value}", target.name)));
                }
                (target, None)
            } else {
                let switching_model = target.category.as_deref() == Some("model");
                if switching_model {
                    if s.pending_model.is_some() && s.busy {
                        return Err(IdeError::invalid("The pending model settings cannot be changed now"));
                    }
                    s.model_choice += 1;
                    s.pending_model = None;
                    s.discovering_model = None;
                }
                let previous_levels = (switching_model && target.current.as_deref() != Some(value.as_str()))
                    .then(|| s.task.config.extract_if(.., |o| config::is_per_model_option(o)).collect::<Vec<_>>());
                s.wanted.retain(|c| c.id != option);
                s.wanted.push(AgentConfigChoice { id: option.to_owned(), value: value.clone() });
                s.task.config.iter_mut().find(|o| o.id == option).expect("selected setting").current =
                    Some(value.clone());
                s.task.model = model_of(&s.task.config).or(s.task.model.take());
                (target, Some((s.model_choice, previous_levels)))
            }
        };
        let Some((model_choice, previous_levels)) = change else {
            return task.switch_discovered_model(target, value).await;
        };
        let previous = target.current.clone();
        // Cursor's `session/set_config_option` (Fast, effort) can take seconds. Show the
        // choice first so the switch and slider move immediately.
        task.persist();
        task.emit_task();

        let live = task.live.lock().clone().filter(|l| !l.peer.is_closed());
        // The task's copy holds its model's per-model options unless a model switch the agent
        // never reported dropped them: caching that copy would erase the model's known levels.
        let mut model_options = (target.category.as_deref() != Some("model")
            || previous.as_deref() == Some(value.as_str()))
            && task.state.lock().task.config.iter().any(config::is_per_model_option);
        if live.is_none()
            && target.category.as_deref() == Some("model")
            && (previous.as_deref() != Some(value.as_str()) || !model_options)
        {
            let provider = task.state.lock().task.provider.clone();
            let levels = self.shared.paths.catalogs.load_levels(&self.shared, &provider, &value).await;
            // Another selection may have superseded this discovery while it was waiting.
            if task.state.lock().model_choice != model_choice {
                return Ok(());
            }
            let levels = match levels {
                Ok(levels) => levels,
                Err(error) => {
                    restore_config_choice(&task, &target, &value, previous.as_deref(), model_choice, previous_levels);
                    task.persist();
                    task.emit_task();
                    return Err(IdeError::unavailable(error));
                }
            };
            let mut s = task.state.lock();
            if s.model_choice != model_choice {
                return Ok(());
            }
            s.task.config.retain(|o| !config::is_per_model_option(o));
            s.task.config.extend(levels);
            model_options = true;
        }
        if let Some(live) = live.filter(|_| option != config::CURSOR_APPROVAL) {
            let (method, mut params) = config::set_request(&target, &value);
            params["sessionId"] = json!(live.session);
            let reply: Value = match live.peer.request(method, params, None).await {
                Ok(reply) => reply,
                Err(e) => {
                    restore_config_choice(&task, &target, &value, previous.as_deref(), model_choice, previous_levels);
                    task.persist();
                    task.emit_task();
                    return Err(IdeError::internal(task.describe(e)));
                }
            };
            if target.category.as_deref() == Some("model") && task.state.lock().model_choice != model_choice {
                return Ok(());
            }
            if let Some(options) = reply.get("configOptions") {
                config::merge_update(&mut task.state.lock().task.config, options);
                model_options = true;
            } else if target.category.as_deref() == Some("model") {
                // Old model controls were removed above, so these came from an update
                // that preceded the response.
                model_options = task.state.lock().task.config.iter().any(config::is_per_model_option);
            }
        }
        {
            let mut s = task.state.lock();
            if target.category.as_deref() == Some("model") && s.model_choice != model_choice {
                return Ok(());
            }
            if !model_options && target.category.as_deref() == Some("model") {
                s.task.config.retain(|o| !config::is_per_model_option(o));
            }
            if let Some(o) = s.task.config.iter_mut().find(|o| o.id == option) {
                o.current = Some(value);
            }
            s.task.model = model_of(&s.task.config).or(s.task.model.take());
            sync_usage_context_size(&mut s.task);
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
        let total = turn_starts(&source.state.lock().history.conversation.main.entries).len() as u32;
        let keep = turns.unwrap_or(total).min(total);
        if !live.capabilities.fork || (keep < total && !live.capabilities.rollback) {
            return Err(IdeError::invalid("this agent can't copy a conversation from there"));
        }
        let (cwd, provider_id, mcp_overrides, project_root) = {
            let s = source.state.lock();
            let t = &s.task;
            (t.cwd.0.clone(), t.provider.clone(), t.mcp_overrides.clone(), t.project_root.clone().map(|p| p.0))
        };
        let mcp_servers = source.shared.mcp_servers_for_session(&provider_id, &live.init, &mcp_overrides);
        let roots = source.shared.additional_directories(&live.init, &cwd, project_root.as_deref());
        let skills_delivery = source.stage_skills(stage_key(live.driver), &cwd).await;
        let cwd_s = dunce::canonicalize(&cwd).unwrap_or(cwd).to_string_lossy().into_owned();
        let reply: Value = live
            .peer
            .request(
                "session/fork",
                {
                    let mut params = session_params(&cwd_s, &mcp_servers, skills_delivery.as_ref(), &roots);
                    params["sessionId"] = json!(live.session);
                    params
                },
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
            let mut entries = s.history.conversation.main.entries.clone();
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
                stats: Box::default(),
                ..s.task.clone()
            };
            TaskFile {
                task,
                session_id: Some(session),
                entries,
                wanted: s.wanted.clone(),
                pending_model: None,
                pending_switch: None,
                before: (*s.before).clone(),
                saved: s.saved.clone(),
                touched: s.touched.as_deref().cloned(),
                // The copies are the source's: the fork's turns are recorded as it runs them.
                turn: None,
                turns: Vec::new(),
                subagents: s.history.conversation.saved_subagents(),
                pending_rollback: total - keep,
                title_renamed: s.title_renamed,
                ephemeral: s.ephemeral,
                pending_native_fork: None,
            }
        };
        // Copying may have started the source's agent: it stops again once idle.
        source.release_when_idle();
        let task = Task::restore(file, self.shared.clone());
        self.tasks.write().insert(task.id.clone(), task.clone());
        task.persist();
        task.emit_task();
        let copy = task.state.lock().task.clone();
        Ok(copy)
    }

    /// Drops the task's turns after its first `turns`, in the agent's session and in the
    /// conversation; returns the message that started the first dropped turn. With `files`,
    /// the files the dropped turns changed go back as they were when the first of them
    /// started; otherwise they stay as they are.
    pub async fn rollback(&self, id: &str, turns: u32, files: bool) -> IdeResult<Option<AgentPrompt>> {
        let task = self.task(id)?;
        let (starts, cut) = {
            let mut s = task.state.lock();
            if s.busy {
                return Err(IdeError::invalid("wait until the agent is done"));
            }
            let starts = turn_starts(&s.history.conversation.main.entries);
            let Some(&cut) = starts.get(turns as usize) else { return Ok(None) };
            s.busy = true;
            (starts, cut)
        };
        let guard = BusyGuard(task.clone());
        // Read and checked before anything changes: a file that can't go back stops it all.
        let planned = if files { self.plan_rewind(&task, turns as usize, starts.len()).await? } else { Vec::new() };
        // Dropping every turn starts the conversation over, which needs no agent-side
        // rewind — and some agents cannot rewind past their first turn (a resumed
        // Claude Code session). A fresh session avoids both.
        if turns == 0 {
            task.kill();
            let restamped = self.write_rewind(&task, planned).await?;
            let (first, dir, kept) = {
                let mut s = task.state.lock();
                let first = match s.history.conversation.main.entries.get(cut) {
                    Some(AgentEntry::User { text, .. }) => {
                        Some(AgentPrompt { text: text.clone(), ..Default::default() })
                    }
                    _ => None,
                };
                s.session_id = None;
                s.pending_model = None;
                s.model_choice += 1;
                s.discovering_model = None;
                s.history.conversation = Conversation::default();
                // The fresh session reports its own usage; nothing carries over.
                s.task.usage = None;
                s.pending_rollback = 0;
                s.task.updated_ms = now_ms();
                Self::finish_rewind(&mut s, 0, restamped);
                (first, task.turn_dir(), s.history.turns.clone())
            };
            drop(guard);
            task.streamed.lock().clear();
            task.persist();
            self.shared.emit(AgentEvent::Truncated { task: id.to_owned(), length: 0 });
            task.emit_task();
            self.prune_turn_copies(dir, kept).await;
            return Ok(first);
        }
        let live = task.ensure_session().await.map_err(IdeError::internal)?;
        if !live.capabilities.rollback {
            return Err(IdeError::invalid("this agent can't undo turns"));
        }
        let drop_turns = (starts.len() - turns as usize) as u32;
        let _: Value = live
            .peer
            .request("_openidea/rollback", json!({ "sessionId": live.session, "turns": drop_turns }), None)
            .await
            .map_err(|e| IdeError::internal(task.describe(e)))?;
        let restamped = self.write_rewind(&task, planned).await?;
        let (first, dir, kept) = {
            let mut s = task.state.lock();
            let first = match s.history.conversation.main.entries.get(cut) {
                Some(AgentEntry::User { text, .. }) => Some(AgentPrompt { text: text.clone(), ..Default::default() }),
                _ => None,
            };
            s.history.conversation.truncate(cut);
            s.task.updated_ms = now_ms();
            Self::finish_rewind(&mut s, turns as usize, restamped);
            (first, task.turn_dir(), s.history.turns.clone())
        };
        drop(guard);
        task.streamed.lock().clear();
        task.persist();
        self.shared.emit(AgentEvent::Truncated { task: id.to_owned(), length: cut as u32 });
        task.emit_task();
        self.prune_turn_copies(dir, kept).await;
        // Undoing may have started the agent: it stops again once idle.
        task.release_when_idle();
        Ok(first)
    }

    /// What `provider` reports about itself, from `initialize` alone: no session is opened,
    /// so no MCP server, hook or sign-in runs. A successful answer is remembered until
    /// `refresh`; a failed one is not, so a transient startup failure (a CLI updating itself,
    /// a busy machine) is retried on the next call instead of being shown for the rest of
    /// the session.
    pub async fn probe(&self, provider: &str, refresh: bool) -> IdeResult<AgentProbe> {
        if !refresh && let Some(p) = self.shared.probes.lock().get(provider) {
            return Ok(p.clone());
        }
        let raw_spec =
            self.shared.spec(provider).ok_or_else(|| IdeError::invalid(format!("unknown agent {provider}")))?;
        let can_fallback =
            raw_spec.driver == provider::Driver::Copilot && !self.shared.uses_copilot_acp_fallback(&raw_spec);
        let mut active_spec = if raw_spec.driver == provider::Driver::Copilot && !can_fallback {
            native::copilot::acp_fallback_spec(&raw_spec)
        } else {
            raw_spec.clone()
        };
        let reply = match self.probe_once(&active_spec).await {
            Ok(reply) => Ok(reply),
            Err((err, allow_fallback)) if can_fallback && allow_fallback => {
                tracing::warn!("Copilot headless probe failed ({err}); falling back to `copilot --acp`");
                self.shared.mark_copilot_acp_fallback(&raw_spec);
                active_spec = native::copilot::acp_fallback_spec(&raw_spec);
                self.probe_once(&active_spec).await.map_err(|(e, _)| e)
            }
            Err((err, _)) => Err(err),
        };
        let mut probe = AgentProbe {
            provider: active_spec.id.clone(),
            name: None,
            version: None,
            protocol: match active_spec.driver {
                provider::Driver::Acp => "ACP".into(),
                _ => "native".into(),
            },
            capabilities: AgentCapabilities::default(),
            auth_methods: Vec::new(),
            error: None,
        };
        match reply {
            Ok(reply) => {
                let init = acp::Negotiated::from_initialize(&reply);
                let info = init.agent_info.clone().unwrap_or_default();
                let text = |k: &str| info.get(k).and_then(Value::as_str).map(str::to_owned);
                probe.name = text("title").or_else(|| text("name"));
                probe.version = text("version");
                if active_spec.driver == provider::Driver::Acp {
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
        if probe.error.is_none() {
            self.shared.probes.lock().insert(active_spec.id, probe.clone());
        }
        Ok(probe)
    }

    async fn probe_once(&self, spec: &provider::ProviderSpec) -> Result<Value, (String, bool)> {
        let stderr: Arc<Mutex<Vec<String>>> = Arc::default();
        let lines = stderr.clone();
        let on_stderr: Box<dyn Fn(String) + Send + Sync> = Box::new(move |l| lines.lock().push(l));
        let started = (self.shared.connector)(
            spec,
            &self.shared.paths.project_root,
            Arc::new(ide_jsonrpc::NoopHandler),
            on_stderr,
        );
        match started {
            Err(e) => Err((
                format!("Couldn't start {} (`{}`): {e}", spec.name, spec.command),
                !native::copilot::is_missing_binary_error(&e),
            )),
            Ok(peer) => {
                let params = acp::initialize_params(&client_info());
                let r = tokio::time::timeout(PROBE_TIMEOUT, peer.request::<_, Value>("initialize", params, None)).await;
                peer.kill();
                match r {
                    Ok(Ok(v)) => Ok(v),
                    Ok(Err(e)) => {
                        let is_auth =
                            matches!(&e, RpcError::Server { code, message, .. } if acp::auth_required(*code, message));
                        let msg = match stderr.lock().last() {
                            Some(line) => format!("{e}: {line}"),
                            None => e.to_string(),
                        };
                        Err((msg, !is_auth))
                    }
                    Err(_) => Err(("the agent did not answer".into(), true)),
                }
            }
        }
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

    pub async fn context_usage(&self, id: &str) -> IdeResult<AgentContextUsage> {
        let task = self.task(id)?;
        let live = task.live.lock().clone().ok_or_else(|| IdeError::unavailable("the agent session is offline"))?;
        if !live.capabilities.context_usage {
            return Err(IdeError::unavailable("this agent does not report context details"));
        }
        live.peer
            .request("_openidea/context_usage", json!({ "sessionId": live.session }), None)
            .await
            .map_err(|error| IdeError::internal(task.describe(error)))
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

    /// Replies to a non-blocking question without interrupting the agent's current turn.
    pub async fn answer_question(&self, id: &str, question: &str, answer: Option<String>) -> IdeResult<()> {
        let task = self.task(id)?;
        let _answering = task.answering_questions.lock().await;
        let questions = {
            let s = task.state.lock();
            s.history
                .conversation
                .main
                .entries
                .iter()
                .find_map(|entry| match entry {
                    AgentEntry::Question { id, questions, chosen: None, .. } if id == question => {
                        Some(questions.clone())
                    }
                    _ => None,
                })
                .ok_or_else(|| IdeError::not_found("the question was already answered"))?
        };
        let chosen = match answer {
            None => "Skipped".to_owned(),
            Some(answer) => {
                let (text, record) = async_questions::reply(&questions, &answer)?;
                let prompt = AgentPrompt { text, files: Vec::new(), images: Vec::new() };
                if let Err(prompt) = task.steer(prompt).await {
                    if task.state.lock().busy {
                        return Err(IdeError::unavailable("the reply could not join the running turn; try again"));
                    }
                    self.prompt(id, prompt, false).await?;
                }
                record
            }
        };
        let changed = {
            let mut s = task.state.lock();
            s.history.conversation.main.entries.iter_mut().enumerate().find_map(|(index, entry)| match entry {
                AgentEntry::Question { id, chosen: current, .. } if id == question => {
                    *current = Some(chosen.clone());
                    Some((None, index))
                }
                _ => None,
            })
        };
        task.mark_dirty(changed);
        task.persist();
        Ok(())
    }

    /// Stops the agent and moves the task to Archived; its worktree stays.
    pub fn archive(&self, id: &str) -> IdeResult<()> {
        let task = self.task(id)?;
        task.kill();
        // Not kept while archived; see `AgentManager::new`.
        task.state.lock().task.commands = Vec::new();
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
        self.tasks.write().remove(id);
        task.file.lock().deleted = true;
        let _ = std::fs::remove_file(self.shared.paths.store_dir.join(format!("{id}.json")));
        let _ = std::fs::remove_dir_all(task.turn_dir());
        skills::remove_farm(&self.shared.paths.store_dir, id);
        let saved = task.state.lock().saved.clone();
        if let Some(saved) = saved
            && !self.tasks.read().values().any(|t| t.state.lock().saved.as_ref() == Some(&saved))
        {
            let _ = std::fs::remove_dir_all(self.shared.paths.store_dir.join(saved));
        }
        // The list drops the task now; removing a large worktree's folder can take a while.
        self.shared.emit(AgentEvent::Removed { id: id.to_owned() });
        if remove_worktree && !shared && isolation == Isolation::Worktree && cwd.exists() {
            // On Windows the agent's processes lock the folder (their working directory,
            // open files) until they have exited.
            if let Some(peer) = live {
                let _ = tokio::time::timeout(EXIT_WAIT, peer.exited()).await;
            }
            let worktrees = self.shared.paths.worktrees_dir.clone();
            vcs(&self.shared, move || worktree::remove(&root, &worktrees, &cwd)).await?;
        }
        Ok(())
    }

    /// Files the task changed since it started.
    pub async fn changes(&self, id: &str) -> IdeResult<Vec<AgentChange>> {
        let task = self.task(id)?;
        let at = task.base();
        let (before, touched) = task.attribution();
        read_changes(&self.shared, move || at.changes(&before, touched.as_deref())).await
    }

    /// The task's uncommitted changes and, for a worktree task, the commits made since it
    /// started (newest first). Both are read against the same `HEAD`.
    pub async fn grouped_changes(&self, id: &str) -> IdeResult<AgentChanges> {
        let task = self.task(id)?;
        let at = task.base();
        let (before, touched) = task.attribution();
        read_changes(&self.shared, move || {
            let mut grouped = at.grouped_changes(&before)?;
            grouped.uncommitted = worktree::made_by_task(grouped.uncommitted, touched.as_deref());
            Ok(grouped)
        })
        .await
    }

    /// The files the task's last turn changed, against the checkout as it started (while a
    /// turn runs: that turn's so far). None before the task's first turn.
    pub async fn turn_changes(&self, id: &str) -> IdeResult<Vec<AgentChange>> {
        let (cwd, turn, dir) = self.task(id)?.last_turn();
        let Some(turn) = turn else { return Ok(Vec::new()) };
        read_changes(&self.shared, move || {
            let changed = match &turn.changed {
                Some(changed) => changed.clone(),
                None => worktree::changed_in_turn(&cwd, &turn)?.1,
            };
            worktree::turn_changes(&cwd, &turn, &dir, &changed)
        })
        .await
    }

    /// Content of `path` (in the task's directory) as `view` compares it: when the task
    /// started, in `HEAD`, or when the last turn started.
    pub async fn base_text(&self, id: &str, path: PathBuf, view: AgentChangesView) -> IdeResult<Option<String>> {
        let task = self.task(id)?;
        if view == AgentChangesView::LastTurn {
            let (cwd, turn, dir) = task.last_turn();
            let Some(turn) = turn else { return Ok(None) };
            return vcs(&self.shared, move || worktree::turn_text(&cwd, &path, &turn, &dir)).await;
        }
        let at = task.base();
        vcs(&self.shared, move || {
            let rev = match view {
                AgentChangesView::Group => worktree::head_commit(at.cwd())?,
                _ => at.rev()?,
            };
            match rev {
                Some(rev) => worktree::file_at(at.cwd(), &path, &rev),
                None => Ok(None),
            }
        })
        .await
    }

    /// What rolling the task's files back to the start of its turn `turn` writes.
    async fn plan_rewind(
        &self,
        task: &Arc<Task>,
        turn: usize,
        total_turns: usize,
    ) -> IdeResult<Vec<worktree::PutBack>> {
        let (cwd, start, before, saved, touched, dropped_changed) = {
            let s = task.state.lock();
            let start = s.history.turns.get(turn).cloned().flatten();
            let dropped = s.history.turns.get(turn..).unwrap_or(&[]);
            let dropped_changed = (dropped.len() == total_turns - turn
                && dropped.iter().all(|t| t.as_ref().is_some_and(|t| t.changed.is_some())))
            .then(|| {
                dropped
                    .iter()
                    .flatten()
                    .filter_map(|t| t.changed.as_ref())
                    .flatten()
                    .cloned()
                    .collect::<BTreeSet<String>>()
            });
            (
                s.task.cwd.0.clone(),
                start,
                s.before.clone(),
                s.saved.as_ref().map(|name| self.shared.paths.store_dir.join(name)),
                s.touched.clone(),
                dropped_changed,
            )
        };
        let Some(start) = start else {
            // The task's own start is the first turn's.
            if turn == 0 {
                let at = task.base();
                return vcs(&self.shared, move || {
                    worktree::plan_restore(&at, &before, saved.as_deref(), touched.as_deref())
                })
                .await;
            }
            return Err(IdeError::invalid(
                "the files weren't recorded as this message was sent: roll them back in the Changes view instead",
            ));
        };
        let dir = task.turn_dir();
        vcs(&self.shared, move || {
            let mut changed = worktree::changed_in_turn(&cwd, &start)?.1;
            // In the project's own checkout, only files the rolled-back turns changed are put back.
            if let Some(touched) = &touched {
                let scope = dropped_changed.as_ref().unwrap_or(touched);
                changed.retain(|rel| scope.contains(rel));
            }
            worktree::rewind(&cwd, &start, &dir, &changed)
        })
        .await
    }

    /// Writes what `plan_rewind` planned on the blocking VCS pool and computes any `before`
    /// restamps off-lock.
    async fn write_rewind(
        &self,
        task: &Arc<Task>,
        planned: Vec<worktree::PutBack>,
    ) -> IdeResult<Vec<(String, worktree::Stamp)>> {
        if planned.is_empty() {
            return Ok(Vec::new());
        }
        let (before, saved) = {
            let s = task.state.lock();
            (s.before.clone(), s.saved.as_ref().map(|name| self.shared.paths.store_dir.join(name)))
        };
        vcs(&self.shared, move || worktree::put_back(planned, &before, saved.as_deref())).await
    }

    /// Drops the records of the turns from `turn` on and applies any restamps to `before`.
    fn finish_rewind(s: &mut TaskState, turn: usize, restamped: Vec<(String, worktree::Stamp)>) {
        s.history.turns.truncate(turn);
        if !restamped.is_empty() {
            let mut before = (*s.before).clone();
            before.extend(restamped);
            s.before = Arc::new(before);
        }
    }

    async fn prune_turn_copies(&self, dir: PathBuf, kept: Vec<Option<Arc<worktree::TurnStart>>>) {
        let _ = vcs(&self.shared, move || {
            worktree::prune_turn_copies(&dir, kept.iter().flatten().map(|t| &**t));
            Ok(())
        })
        .await;
    }

    /// Rollback: puts the task's changed files among `rel_paths` (all with `None`) back as
    /// `view` compares them: as they were when it started, as they are in `HEAD`, or as they
    /// were when its last turn started.
    pub async fn rollback_changes(
        &self,
        id: &str,
        rel_paths: Option<Vec<String>>,
        view: AgentChangesView,
    ) -> IdeResult<()> {
        let task = self.task(id)?;
        if task.state.lock().busy {
            return Err(IdeError::invalid("the agent is working: stop it before rolling back its changes"));
        }
        if view == AgentChangesView::LastTurn {
            return self.rollback_turn(&task, rel_paths).await;
        }
        let at = task.base();
        let (before, saved, touched) = {
            let s = task.state.lock();
            (s.before.clone(), s.saved.as_ref().map(|name| self.shared.paths.store_dir.join(name)), s.touched.clone())
        };
        let (restamped, restored) = vcs(&self.shared, move || {
            let (changes, rev) = match view {
                AgentChangesView::Group => (at.grouped_changes(&before)?.uncommitted, worktree::head_commit(at.cwd())?),
                AgentChangesView::SinceStart | AgentChangesView::LastTurn => (at.changes(&before, None)?, at.rev()?),
            };
            let changes = worktree::made_by_task(changes, touched.as_deref());
            let sources = match rev.as_deref() {
                Some(rev) => worktree::rename_sources(at.cwd(), rev)?,
                None => Default::default(),
            };
            let mut restamped = Vec::new();
            let mut restored = Vec::new();
            for change in changes.iter().filter(|c| rel_paths.as_ref().is_none_or(|p| p.contains(&c.rel_path))) {
                // A rename goes back to its old path too; the new one is taken away first, so a
                // case-only rename on a case-insensitive disk ends as the old file.
                for change in std::iter::once(change).chain(sources.get(&change.rel_path)) {
                    worktree::restore(at.cwd(), rev.as_deref(), change, &before, saved.as_deref())?;
                    // Back to the user's own edits: not a change of the task any more.
                    if before.contains_key(&change.rel_path) {
                        restamped.push((change.rel_path.clone(), worktree::stamp(&change.path.0)));
                    }
                    restored.push(change.rel_path.clone());
                }
            }
            Ok((restamped, restored))
        })
        .await?;
        {
            let mut s = task.state.lock();
            if !restamped.is_empty() {
                let mut before = (*s.before).clone();
                before.extend(restamped);
                s.before = Arc::new(before);
            }
            // Rolled back further than the last turn: what it changed there is gone, not the turn's to list.
            if let Some(Some(turn)) = s.history.turns.last_mut()
                && let Some(changed) = &turn.changed
                && restored.iter().any(|rel| changed.contains(rel))
            {
                let changed = changed.iter().filter(|rel| !restored.contains(rel)).cloned().collect();
                *turn = Arc::new(worktree::TurnStart { changed: Some(changed), ..(**turn).clone() });
            }
        }
        task.persist();
        Ok(())
    }

    /// Puts the last turn's changed files among `rel_paths` (all with `None`) back as they
    /// were when it started.
    async fn rollback_turn(&self, task: &Task, rel_paths: Option<Vec<String>>) -> IdeResult<()> {
        let (cwd, turn, dir) = task.last_turn();
        let Some(turn) = turn else { return Ok(()) };
        let (before, saved) = {
            let s = task.state.lock();
            (s.before.clone(), s.saved.as_ref().map(|name| self.shared.paths.store_dir.join(name)))
        };
        let restamped = vcs(&self.shared, move || {
            let changed = match &turn.changed {
                Some(changed) => changed.clone(),
                None => worktree::changed_in_turn(&cwd, &turn)?.1,
            };
            let mut restamped = Vec::new();
            for change in worktree::turn_changes(&cwd, &turn, &dir, &changed)?
                .iter()
                .filter(|c| rel_paths.as_ref().is_none_or(|p| p.contains(&c.rel_path)))
            {
                worktree::restore_turn(&cwd, &turn, &dir, change)?;
                // Back to the user's own edits from before the task: not a change of the task.
                if let Some(Some(_)) = before.get(&change.rel_path)
                    && let Some(copy) = saved.as_deref().and_then(|d| worktree::saved_copy(d, &change.rel_path))
                    && std::fs::read(&change.path.0).is_ok_and(|now| now == copy)
                {
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

    /// Accept: copies the task's changed files among `rel_paths` (all with `None`) from its
    /// worktree into the local checkout, uncommitted, for the user to review and commit.
    /// Files the checkout changed itself are left alone and reported. Only worktree tasks
    /// have anything to accept.
    pub async fn accept_changes(&self, id: &str, rel_paths: Option<Vec<String>>) -> IdeResult<AgentAcceptOutcome> {
        let task = self.task(id)?;
        if task.state.lock().busy {
            return Err(IdeError::invalid("the agent is working: stop it before accepting its changes"));
        }
        let (isolation, cwd, base, root, before) = {
            let s = task.state.lock();
            (
                s.task.isolation,
                s.task.cwd.0.clone(),
                s.task.base_commit.clone(),
                s.task.project_root.clone().map(|p| p.0).unwrap_or_else(|| self.shared.paths.project_root.clone()),
                (*s.before).clone(),
            )
        };
        if isolation != Isolation::Worktree {
            return Err(IdeError::invalid("the task works in the local checkout: there is nothing to accept"));
        }
        let Some(base) = base else {
            return Err(IdeError::invalid("the task has no base revision to accept from"));
        };
        vcs(&self.shared, move || {
            let wanted: Vec<AgentChange> = worktree::without_untouched(worktree::changes(&cwd, &base)?, &before)
                .into_iter()
                .filter(|c| rel_paths.as_ref().is_none_or(|p| p.contains(&c.rel_path)))
                .collect();
            worktree::accept(&root, &cwd, &base, &wanted)
        })
        .await
    }

    /// Updates per-session MCP server enable/disable overrides (`server_name` -> `enabled`).
    /// When the task is idle and holds a resumable live session without running background tasks,
    /// stops the idle process so the next turn reloads the session with the updated MCP servers;
    /// when busy, schedules the reload for as soon as the turn finishes.
    pub fn set_mcp_overrides(&self, id: &str, overrides: BTreeMap<String, bool>) -> IdeResult<AgentTask> {
        let task = self.task(id)?;
        let cleaned: BTreeMap<String, bool> = overrides
            .into_iter()
            .filter_map(|(k, v)| {
                let k = k.trim();
                (!k.is_empty()).then(|| (k.to_owned(), v))
            })
            .collect();
        let (changed, busy, has_bg, out) = {
            let mut s = task.state.lock();
            if s.task.status == AgentStatus::Archived {
                return Err(IdeError::invalid("the task is archived"));
            }
            let changed = s.task.mcp_overrides != cleaned;
            if changed {
                s.task.mcp_overrides = cleaned;
                s.task.updated_ms = now_ms();
            }
            (changed, s.busy, !s.background_tasks.is_empty(), s.snapshot())
        };
        if changed {
            task.persist();
            task.emit_task();
            if busy || has_bg || !task.permissions.lock().is_empty() {
                task.mcp_reload_pending.store(true, Ordering::Release);
            } else {
                task.recycle_resumable_session();
            }
        }
        Ok(out)
    }

    /// Sets the session's skill modes; like MCP overrides, a change reaches the agent when
    /// its idle session is recycled and the next turn starts fresh.
    pub fn set_skill_overrides(&self, id: &str, overrides: BTreeMap<String, AgentSkillMode>) -> IdeResult<AgentTask> {
        let task = self.task(id)?;
        let cleaned: BTreeMap<String, AgentSkillMode> = overrides
            .into_iter()
            .filter_map(|(k, v)| (!k.trim().is_empty()).then(|| (k.trim().to_owned(), v)))
            .collect();
        let (changed, busy, has_bg, out) = {
            let mut s = task.state.lock();
            if s.task.status == AgentStatus::Archived {
                return Err(IdeError::invalid("the task is archived"));
            }
            let changed = s.task.skill_overrides != cleaned;
            if changed {
                s.task.skill_overrides = cleaned;
                s.task.updated_ms = now_ms();
            }
            (changed, s.busy, !s.background_tasks.is_empty(), s.task.clone())
        };
        if changed {
            task.persist();
            task.emit_task();
            if busy || has_bg || !task.permissions.lock().is_empty() {
                task.skills_reload_pending.store(true, Ordering::Release);
            } else {
                task.recycle_resumable_session();
            }
        }
        Ok(out)
    }

    /// Recycles idle resumable live sessions (or schedules reload after the running turn) when
    /// global, workspace, or built-in IDE MCP server settings change.
    pub fn notify_mcp_servers_changed(&self) {
        let tasks: Vec<Arc<Task>> = self.tasks.read().values().cloned().collect();
        for task in tasks {
            let (archived, busy, has_bg) = {
                let s = task.state.lock();
                (s.task.status == AgentStatus::Archived, s.busy, !s.background_tasks.is_empty())
            };
            if archived {
                continue;
            }
            if busy || has_bg || !task.permissions.lock().is_empty() {
                task.mcp_reload_pending.store(true, Ordering::Release);
            } else {
                task.recycle_resumable_session();
            }
        }
    }

    /// Stops sending events to UI sinks (project closing).
    pub fn detach_sinks(&self) {
        self.shared.sinks.write().clear();
    }

    /// Stops every agent (project closed).
    pub fn shutdown(&self) {
        self.detach_sinks();
        let tasks: Vec<_> = self.tasks.read().values().cloned().collect();
        for task in tasks {
            let was_live = task.kill().is_some();
            if was_live {
                // Persist late subagent updates and cleared live background state.
                task.persist();
            } else {
                // Flush pending delayed saves without rewriting untouched or archived tasks.
                task.save();
            }
        }
    }
}

impl Task {
    /// The skills offered in this project: every discovery resolved against the policies
    /// and the task's overrides.
    async fn skill_states(&self) -> Vec<AgentSkillState> {
        let (policy, overrides, home, roots) = {
            let shared = &self.shared;
            let policy = shared.skills_policy_hook.read().as_ref().map(|hook| hook()).unwrap_or_default();
            let (overrides, task_root) = {
                let s = self.state.lock();
                (s.task.skill_overrides.clone(), s.task.project_root.as_ref().map(|p| p.0.clone()))
            };
            let mut roots = Vec::new();
            if let Some(tr) = task_root {
                roots.push(tr);
            }
            roots.extend(policy.workspace_roots.iter().cloned());
            roots.push(shared.paths.project_root.clone());
            (policy, overrides, shared.paths.home_dir.clone(), roots)
        };
        blocking(move || {
            Ok(skills::resolve(
                skills::discover_skills_with_plugins(&roots, home.as_deref(), &policy.plugin_dirs),
                Some(&overrides),
                &policy.workspace,
                &policy.user,
                policy.workspace_trusted,
            ))
        })
        .await
        .unwrap_or_default()
    }

    /// Stages the session's skills into the task's farm and reports what its CLI takes.
    /// Nothing staged for an ACP agent (its `/` menu is filtered instead), and a failed
    /// stage (locked files, full disk) runs the session without the farm.
    async fn stage_skills(&self, provider: &str, cwd: &Path) -> Option<skills::Delivery> {
        let states = self.skill_states().await;
        let (farm, home, out_cwd) = {
            (
                skills::farm_dir(&self.shared.paths.store_dir, &self.id),
                self.shared.paths.home_dir.clone(),
                cwd.to_path_buf(),
            )
        };
        let provider = provider.to_owned();
        match blocking(move || {
            skills::stage(&farm, &provider, &states, &out_cwd, home.as_deref())
                .map_err(|e| IdeError::internal(e.to_string()))
        })
        .await
        {
            Ok(delivery) => Some(delivery),
            Err(e) => {
                tracing::warn!("agent task {}: staging its skills failed: {e}", self.id);
                None
            }
        }
    }

    /// A task whose conversation is at hand (a new task, a copy).
    fn restore(mut file: TaskFile, shared: Arc<Shared>) -> Arc<Self> {
        let adopt = file.entries.is_empty() && file.session_id.is_some();
        let history = History::new(
            std::mem::take(&mut file.entries),
            std::mem::take(&mut file.subagents),
            file.turn.take(),
            std::mem::take(&mut file.turns),
        );
        Self::assemble(file, StoredHistory::loaded(history), adopt, shared)
    }

    /// A task read from the store without its conversation (`head`, see [`read_head`]): the
    /// conversation is read from `path` once something needs it.
    fn restore_saved(head: TaskFile, entries: usize, path: PathBuf, shared: Arc<Shared>) -> Arc<Self> {
        let adopt = entries == 0 && head.session_id.is_some();
        Self::assemble(head, StoredHistory::on_disk(path), adopt, shared)
    }

    /// The task from the parts of `file` other than its history, which `history` holds.
    fn assemble(file: TaskFile, history: StoredHistory, adopt: bool, shared: Arc<Shared>) -> Arc<Self> {
        let mut task = file.task;
        config::add_client_options(&task.provider, &mut task.config);
        let mut wanted = file.wanted;
        let mut pending_model = file.pending_switch.or_else(|| {
            let id = file.pending_model?;
            let index = wanted.iter().position(|choice| choice.id == id)?;
            let model = wanted.remove(index);
            if let Some(value) = task.model.clone() {
                wanted.push(AgentConfigChoice { id, value });
            }
            let catalog = shared.paths.catalogs.cached(&shared, &task.provider);
            let candidate = catalog
                .config
                .iter()
                .find(|o| o.category.as_deref() == Some("model"))
                .and_then(|o| o.values.iter().find(|v| v.value == model.value))
                .cloned();
            let options = catalog.thought_levels.get(&model.value).cloned().unwrap_or_default();
            Some(PendingModel { model, candidate, options, choices: Vec::new(), retained_service_tier: None })
        });
        if let Some(pending) = &mut pending_model
            && pending.retained_service_tier.is_none()
            && shared.spec(&task.provider).is_some_and(|spec| spec.driver == provider::Driver::Codex)
        {
            pending.retained_service_tier = wanted.iter().find(|c| c.id == "service_tier").cloned();
        }
        Arc::new(Self {
            id: task.id.clone(),
            shared,
            state: Mutex::new(TaskState {
                task,
                session_id: file.session_id,
                history,
                wanted,
                pending_model,
                model_choice: 0,
                discovering_model: None,
                before: Arc::new(file.before),
                saved: file.saved,
                touched: file.touched.map(Arc::new),
                pending_rollback: file.pending_rollback,
                title_renamed: file.title_renamed,
                ephemeral: file.ephemeral,
                pending_native_fork: file.pending_native_fork,
                busy: false,
                background_tasks: Vec::new(),
                shell_context: Vec::new(),
            }),
            live: Mutex::new(None),
            connecting: tokio::sync::Mutex::new(()),
            answering_questions: tokio::sync::Mutex::new(()),
            permissions: Mutex::new(HashMap::new()),
            next_permission: AtomicU32::new(1),
            replaying: AtomicBool::new(false),
            adopting_replay: AtomicBool::new(adopt),
            start_fresh: AtomicBool::new(false),
            send_now: AtomicBool::new(false),
            cancel_pending: AtomicBool::new(false),
            turn_started: AtomicBool::new(false),
            turns: AtomicU64::new(0),
            idle_epoch: AtomicU64::new(0),
            mcp_reload_pending: AtomicBool::new(false),
            skills_reload_pending: AtomicBool::new(false),
            config_sent: Mutex::new(HashSet::new()),
            dirty: Mutex::new(BTreeSet::new()),
            streamed: Mutex::new(Streamed::default()),
            flush_scheduled: AtomicBool::new(false),
            stderr: Mutex::new(VecDeque::new()),
            saves_asked: AtomicU64::new(0),
            save_scheduled: AtomicBool::new(false),
            file: Mutex::new(SavedFile::default()),
        })
    }

    /// The files already changed when the task started, and the files its turns changed.
    fn attribution(&self) -> (Arc<Snapshot>, Option<Arc<BTreeSet<String>>>) {
        let s = self.state.lock();
        (s.before.clone(), s.touched.clone())
    }

    /// Where the copies of the files already changed as the turns started are kept.
    fn turn_dir(&self) -> PathBuf {
        self.shared.paths.store_dir.join(format!("{}.turn", self.id))
    }

    /// The checkout as the last turn started, with the folder of its copies.
    fn last_turn(&self) -> (PathBuf, Option<Arc<worktree::TurnStart>>, PathBuf) {
        let s = self.state.lock();
        (s.task.cwd.0.clone(), s.history.turns.last().cloned().flatten(), self.turn_dir())
    }

    /// Records the checkout as a turn starts (its message shown): what the turn's changes are
    /// compared with, and what rolling back to its message puts back.
    async fn checkout_before_turn(self: &Arc<Self>) {
        let (cwd, dir, index, earlier) = {
            let s = self.state.lock();
            let index = turn_starts(&s.history.conversation.main.entries).len().saturating_sub(1);
            let earlier: Vec<_> = s.history.turns.iter().take(index).cloned().collect();
            (s.task.cwd.0.clone(), self.turn_dir(), index, earlier)
        };
        let kept = earlier.clone();
        let turn = match vcs(&self.shared, move || {
            let turn = worktree::start_turn(&cwd, &dir)?;
            worktree::prune_turn_copies(&dir, kept.iter().flatten().map(|t| &**t).chain([&turn]));
            Ok(turn)
        })
        .await
        {
            Ok(turn) => Some(Arc::new(turn)),
            Err(e) => {
                tracing::warn!("recording the checkout as a turn of agent task {} starts: {e}", self.id);
                None
            }
        };
        {
            let mut s = self.state.lock();
            s.history.turns = earlier;
            s.history.turns.resize(index, None);
            s.history.turns.push(turn);
        }
        self.persist_soon();
    }

    /// Records the files that changed in the checkout while the turn ran: the turn's, and in
    /// the project's own checkout also the task's.
    async fn record_turn_changes(self: &Arc<Self>) {
        let (cwd, turn, _) = self.last_turn();
        let Some(turn) = turn else { return };
        let start = turn.clone();
        let Ok((in_worktree, all)) = vcs(&self.shared, move || worktree::changed_in_turn(&cwd, &start)).await else {
            return;
        };
        {
            let mut s = self.state.lock();
            if !in_worktree.is_empty()
                && let Some(touched) = &s.touched
            {
                let mut touched = (**touched).clone();
                touched.extend(in_worktree);
                s.touched = Some(Arc::new(touched));
            }
            if let Some(last) = s.history.turns.last_mut() {
                *last = Some(Arc::new(worktree::TurnStart { changed: Some(all), ..(*turn).clone() }));
            }
        }
        self.persist_soon();
    }

    fn base(&self) -> worktree::TaskBase {
        let s = self.state.lock();
        let cwd = s.task.cwd.0.clone();
        match s.task.isolation {
            Isolation::Local => worktree::TaskBase::Local { cwd, start: s.task.base_commit.clone() },
            Isolation::Worktree => {
                worktree::TaskBase::Worktree { cwd, base: s.task.base_commit.clone().unwrap_or_else(|| "HEAD".into()) }
            }
        }
    }

    fn emit_task(&self) {
        let task = self.state.lock().snapshot();
        self.shared.emit(AgentEvent::Task { task: Box::new(task) });
    }

    /// Takes the item and, for Send now, claims an idle turn under the same lock.
    fn take_queued(&self, id: &str, for_send: bool) -> IdeResult<(AgentQueued, bool)> {
        let mut s = self.state.lock();
        let Some(index) = s.task.queue.iter().position(|item| item.id == id) else {
            drop(s);
            self.emit_task();
            return Err(IdeError::new(ErrorKind::OutOfSync, "Message is no longer queued"));
        };
        let item = s.task.queue.remove(index);
        let was_busy = s.busy;
        s.busy |= for_send;
        drop(s);
        self.persist();
        self.emit_task();
        Ok((item, was_busy))
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

    fn change_status(&self, status: AgentStatus, error: Option<String>) {
        let mut s = self.state.lock();
        s.task.retry = None;
        s.task.status = status;
        s.task.error = error;
        s.task.updated_ms = now_ms();
    }

    fn set_status(&self, status: AgentStatus, error: Option<String>) {
        self.change_status(status, error);
        // Saved first: whoever reacts to the status change finds it on disk.
        self.persist();
        self.emit_task();
    }

    /// `Running` again after the agent started or a request was answered: the turn's next stop
    /// saves what changed, and the turn start saved the message that began it.
    fn resume_running(self: &Arc<Self>) {
        self.change_status(AgentStatus::Running, None);
        self.persist_soon();
        self.emit_task();
    }

    fn emit_attention(&self, reason: AgentAttentionReason) {
        let n = self.shared.attention_seq.fetch_add(1, Ordering::Relaxed);
        let tag = match reason {
            AgentAttentionReason::Finished => "finished",
            AgentAttentionReason::Input => "input",
            AgentAttentionReason::Failed => "failed",
        };
        self.shared.emit(AgentEvent::Attention {
            task: self.id.clone(),
            event_id: format!("{}:{tag}:{n}", self.id),
            reason,
        });
    }

    /// After NeedsInput + optional auto-approve: notify only when the user must still answer.
    fn emit_attention_if_input_pending(&self) {
        let waiting = !self.permissions.lock().is_empty() && self.state.lock().task.status == AgentStatus::NeedsInput;
        if waiting {
            self.emit_attention(AgentAttentionReason::Input);
        }
    }

    /// Writes the task file, with everything changed so far, before it returns.
    fn persist(&self) {
        self.saves_asked.fetch_add(1, Ordering::AcqRel);
        self.save();
    }

    /// Has the task file written within `SAVE_DELAY`, once for every change asked for by then:
    /// for what the next `persist` (the turn's next stop, shutdown) saves anyway, and a crash
    /// before it costs at most what changed in this window.
    fn persist_soon(self: &Arc<Self>) {
        self.saves_asked.fetch_add(1, Ordering::AcqRel);
        if !self.save_scheduled.swap(true, Ordering::AcqRel) {
            let task = self.clone();
            self.shared.runtime.spawn(async move {
                tokio::time::sleep(SAVE_DELAY).await;
                task.save_scheduled.store(false, Ordering::Release);
                let _ = tokio::task::spawn_blocking(move || task.save()).await;
            });
        }
    }

    /// Writes the file unless it holds every save asked for. The state is locked only to copy
    /// it: turning a long transcript into JSON and writing it is no reader's wait.
    fn save(&self) {
        // Held from the copy to the rename, so saves land in order and none follows a delete.
        let mut file = self.file.lock();
        // Read before the copy: whatever was asked for up to now is in it.
        let asked = self.saves_asked.load(Ordering::Acquire);
        // A throwaway task is never written: one its caller couldn't delete (a window closed
        // while it ran) is gone after a restart.
        if file.deleted || file.saved >= asked || self.state.lock().ephemeral {
            return;
        }
        let copy = {
            let s = self.state.lock();
            if s.history.unreadable {
                tracing::warn!("not saving agent task {}: its conversation couldn't be read", self.id);
                return;
            }
            TaskFile {
                task: s.task.clone(),
                session_id: s.session_id.clone(),
                entries: s.history.conversation.main.entries.clone(),
                wanted: s.wanted.clone(),
                pending_model: None,
                pending_switch: s.pending_model.clone(),
                before: (*s.before).clone(),
                saved: s.saved.clone(),
                touched: s.touched.as_deref().cloned(),
                turn: None,
                turns: s.history.turns.iter().map(|t| t.as_deref().cloned()).collect(),
                subagents: s.history.conversation.saved_subagents(),
                pending_rollback: s.pending_rollback,
                title_renamed: s.title_renamed,
                ephemeral: s.ephemeral,
                pending_native_fork: s.pending_native_fork.clone(),
            }
        };
        let bytes = serde_json::to_vec(&copy);
        drop(copy);
        let path = self.shared.paths.store_dir.join(format!("{}.json", self.id));
        match bytes.map_err(|e| e.to_string()).and_then(|b| write_file(&path, &b)) {
            Ok(()) => file.saved = asked,
            Err(e) => tracing::warn!("saving agent task {}: {e}", self.id),
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
                    let entry = s.history.conversation.timeline(&subagent)?.entries.get(i)?;
                    entry_event(&self.id, &mut streamed, subagent, i, entry)
                })
                .collect()
        };
        for e in events {
            self.shared.emit(e);
        }
    }

    /// Folds an update made here (not by the agent) into the main conversation.
    fn apply_local(self: &Arc<Self>, update: &Value) {
        let changed = self.state.lock().history.conversation.apply(None, update, now_ms());
        self.mark_dirty(changed);
    }

    async fn shell(self: &Arc<Self>, command: &str, cwd: &Path, cancel: &ide_core::CancellationToken) {
        let call = format!("shell-{}", uuid::Uuid::new_v4().simple());
        self.apply_local(&json!({
            "sessionUpdate": "tool_call",
            "toolCallId": call,
            "title": format!("! {command}"),
            "kind": "execute",
            "status": "in_progress",
        }));
        let ran = shell::run(command, cwd, cancel).await;
        let status = if ran.code == Some(0) { "completed" } else { "failed" };
        self.apply_local(&json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": call,
            "status": status,
            "content": [{ "type": "content", "content": { "type": "text", "text": ran.shown() } }],
        }));
        self.state.lock().shell_context.push(ran.context(command));
        self.persist();
    }

    /// Removes the task's own entries and returns them.
    fn take_entries(self: &Arc<Self>) -> Vec<AgentEntry> {
        let entries = {
            let mut s = self.state.lock();
            let entries = s.history.conversation.main.entries.clone();
            s.history.conversation.truncate(0);
            entries
        };
        self.streamed.lock().clear();
        self.shared.emit(AgentEvent::Truncated { task: self.id.clone(), length: 0 });
        entries
    }

    fn push_entry(self: &Arc<Self>, entry: AgentEntry) -> usize {
        let i = self.state.lock().history.conversation.main.push(entry);
        self.mark_dirty([(None, i)]);
        i
    }

    /// Runs `prompt`, then the queued messages, until the queue is empty, a turn fails, or
    /// the user stops one. The caller set `busy`.
    async fn run(self: Arc<Self>, mut prompt: AgentPrompt) {
        loop {
            // The message shows before the checkout is recorded, which can take a while in a large repository.
            self.show_prompt(&prompt);
            self.checkout_before_turn().await;
            let result = self.turn(&prompt).await;
            self.cancel_pending.store(false, Ordering::Release);
            tokio::time::sleep(TURN_GRACE).await;
            self.record_turn_changes().await;
            let changed = self.state.lock().history.conversation.end_turn(Some(now_ms()));
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
                (Some(queued), _) => {
                    self.emit_task();
                    prompt = queued.prompt;
                }
                (None, Ok(stop)) => {
                    self.set_status(AgentStatus::Ready, None);
                    if stop != "cancelled" {
                        self.emit_attention(AgentAttentionReason::Finished);
                    }
                    if (self.mcp_reload_pending.swap(false, Ordering::AcqRel)
                        || self.skills_reload_pending.swap(false, Ordering::AcqRel))
                        && self.state.lock().background_tasks.is_empty()
                    {
                        self.recycle_resumable_session();
                        return;
                    }
                    return self.release_when_idle();
                }
                (None, Err(failure)) => return self.fail(failure),
            }
        }
    }

    /// Drops an idle resumable live session so the next turn reloads it.
    fn recycle_resumable_session(&self) {
        self.mcp_reload_pending.store(false, Ordering::Release);
        let live = {
            let mut live = self.live.lock();
            if live.as_ref().is_some_and(|l| l.resumable && !l.peer.is_closed()) { live.take() } else { None }
        };
        if let Some(live) = live {
            tracing::debug!("agent task {}: recycling idle resumable session", self.id);
            live.peer.kill();
            self.clear_shown_background();
        }
    }

    async fn switch_discovered_model(&self, target: AgentConfigOption, value: String) -> IdeResult<()> {
        let provider = self.state.lock().task.provider.clone();
        let candidate = self.shared.paths.catalogs.listed_model(&self.shared, &provider, &value).ok_or_else(|| {
            IdeError::invalid(format!("{} has no value {value} in the current model catalog", target.name))
        })?;
        let selection = {
            let mut s = self.state.lock();
            if s.task.status == AgentStatus::Archived {
                return Err(IdeError::invalid("the task is archived"));
            }
            s.model_choice += 1;
            s.discovering_model = Some(s.model_choice);
            DiscoveringModel { state: &self.state, generation: s.model_choice }
        };
        let model_choice = selection.generation;
        // A prompt starting during the switch must not grab the peer we're about to recycle.
        let connecting = self.connecting.lock().await;
        {
            let s = self.state.lock();
            if s.model_choice != model_choice {
                return Ok(());
            }
            if s.task.status == AgentStatus::Archived {
                return Err(IdeError::invalid("the task is archived"));
            }
        }
        let live = self.live.lock().clone();
        let result = if let Some(live) = live.as_ref().filter(|l| !l.peer.is_closed()) {
            let (method, mut params) = config::set_request(&target, &value);
            params["sessionId"] = json!(live.session);
            match live.peer.request::<_, Value>(method, params, None).await {
                Ok(reply) if config::accepts_model(&reply, &target.id, &value) => Ok(Some(reply)),
                Ok(_) => Err(format!("The agent did not switch to model {value}.")),
                Err(e) => Err(self.describe(e)),
            }
        } else {
            Ok(None)
        };

        let refused = match result {
            Ok(Some(reply)) => {
                let (config, model) = {
                    let mut s = self.state.lock();
                    if s.model_choice != model_choice {
                        return Ok(());
                    }
                    if s.task.status == AgentStatus::Archived {
                        return Err(IdeError::invalid("the task is archived"));
                    }
                    if let Some(options) = reply.get("configOptions") {
                        config::merge_update(&mut s.task.config, options);
                    } else if s.task.model.as_deref() != Some(value.as_str()) {
                        s.task.config.retain(|o| !config::is_per_model_option(o));
                    }
                    let model =
                        if let Some(i) = s.task.config.iter().position(|o| o.category.as_deref() == Some("model")) {
                            &mut s.task.config[i]
                        } else {
                            s.task.config.push(target.clone());
                            s.task.config.last_mut().unwrap()
                        };
                    if !model.values.iter().any(|v| v.value == value) {
                        model.values.push(candidate);
                    }
                    model.current = Some(value.clone());
                    s.task.model = Some(value.clone());
                    sync_usage_context_size(&mut s.task);
                    s.pending_model = None;
                    s.wanted.retain(|c| c.id != target.id);
                    s.wanted.push(AgentConfigChoice { id: target.id, value });
                    let model = s.task.model.clone().filter(|_| s.task.config.iter().any(config::is_per_model_option));
                    (s.task.config.clone(), model)
                };
                self.shared.remember(&provider, Some(&config), None, model.as_deref());
                self.persist();
                self.emit_task();
                return Ok(());
            }
            refused => refused,
        };
        {
            let s = self.state.lock();
            if s.model_choice != model_choice {
                return Ok(());
            }
            if s.session_id.is_none()
                || live.as_ref().is_some_and(|l| !l.resumable)
                || self.start_fresh.load(Ordering::Acquire)
            {
                return Err(IdeError::unavailable(
                    refused.err().unwrap_or_else(|| "The agent does not support resuming this session.".into()),
                ));
            }
            if s.busy || !s.background_tasks.is_empty() || !self.permissions.lock().is_empty() {
                return Err(IdeError::invalid("wait until the agent is done"));
            }
        }
        // Catalog discovery never owns the chat session. Let a newer model choice supersede it.
        drop(connecting);
        let options = self.shared.paths.catalogs.load_levels(&self.shared, &provider, &value).await;
        let _connecting = self.connecting.lock().await;
        {
            let mut s = self.state.lock();
            if s.model_choice != model_choice {
                return Ok(());
            }
            if s.task.status == AgentStatus::Archived {
                return Err(IdeError::invalid("the task is archived"));
            }
            if s.busy || !s.background_tasks.is_empty() || !self.permissions.lock().is_empty() {
                return Err(IdeError::invalid("wait until the agent is done"));
            }
            let options = options.map_err(IdeError::unavailable)?;
            let choices = s
                .pending_model
                .take()
                .filter(|pending| pending.model.value == value)
                .map(|pending| pending.choices)
                .unwrap_or_default();
            let retained_service_tier = self
                .shared
                .spec(&provider)
                .filter(|spec| spec.driver == provider::Driver::Codex)
                .and_then(|_| s.wanted.iter().find(|c| c.id == "service_tier").cloned());
            s.pending_model = Some(PendingModel {
                retained_service_tier,
                model: AgentConfigChoice { id: target.id, value },
                candidate: Some(candidate),
                options,
                choices,
            });
        }
        self.recycle_resumable_session();
        self.persist();
        self.emit_task();
        Ok(())
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
            let changed = self.state.lock().history.conversation.settle(now_ms());
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
        self.emit_attention(AgentAttentionReason::Failed);
    }

    /// Adds `prompt` to the running turn when the agent takes that; gives it back otherwise.
    async fn steer(self: &Arc<Self>, prompt: AgentPrompt) -> Result<(), AgentPrompt> {
        let live = self.live.lock().clone().filter(|l| l.capabilities.steer && !l.peer.is_closed());
        let running = {
            let s = self.state.lock();
            s.busy && s.task.status == AgentStatus::Running
        };
        let Some((live, method)) = live
            .filter(|l| running && (prompt.images.is_empty() || l.capabilities.images))
            .and_then(|l| steer_method(&l.init).map(|m| (l, m)))
        else {
            return Err(prompt);
        };
        let content = self.content(&live, &prompt).await;
        let sent: Result<Value, RpcError> =
            live.peer.request(method, json!({ "sessionId": live.session, "prompt": content }), None).await;
        // `_session/steering` answers with an outcome: only `injected` joined the turn
        // (`promptRequired`: no turn is running any more).
        let sent = match sent {
            Ok(reply) => match reply.get("outcome").and_then(Value::as_str) {
                None | Some("injected") => Ok(()),
                Some(outcome) => Err(reply.get("reason").and_then(Value::as_str).unwrap_or(outcome).to_owned()),
            },
            Err(e) => Err(e.to_string()),
        };
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

    /// Adds the user's message to the conversation and shows the task starting.
    fn show_prompt(self: &Arc<Self>, prompt: &AgentPrompt) {
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
    }

    /// Sends one prompt, starting the agent first if needed; returns the stop reason.
    async fn turn(self: &Arc<Self>, prompt: &AgentPrompt) -> Result<String, Failure> {
        self.turns.fetch_add(1, Ordering::AcqRel);
        self.turn_started.store(false, Ordering::Release);
        self.state.lock().task.resets_ms = None;
        let mut live = self.ensure_session().await.map_err(Failure::from)?;
        // Stopped while the agent started: the prompt is never sent.
        if self.cancel_pending.load(Ordering::Acquire) {
            return Ok("cancelled".into());
        }
        self.resume_running();
        if !prompt.images.is_empty() && !live.capabilities.images {
            return Err(Failure::from("This agent can't read images.".to_owned()));
        }
        let shell = std::mem::take(&mut self.state.lock().shell_context);
        let with_shell = |mut content: Vec<Value>| {
            if !shell.is_empty() {
                content.insert(0, json!({ "type": "text", "text": shell.join("\n") }));
            }
            content
        };
        let mut content = with_shell(self.content(&live, prompt).await);
        let mut result: Result<Value, RpcError> =
            live.peer.request("session/prompt", json!({ "sessionId": live.session, "prompt": content }), None).await;
        if live.driver == provider::Driver::Copilot
            && !self.turn_started.load(Ordering::Acquire)
            && let Err(RpcError::Server { code, ref message, .. }) = result
            && is_headless_protocol_error(code)
            && !acp::auth_required(code, message)
        {
            tracing::warn!(
                "agent task {}: Copilot headless prompt failed ({message}); falling back to `copilot --acp`",
                self.id
            );
            if let Some(raw_spec) = self.shared.spec(&live.provider) {
                self.shared.mark_copilot_acp_fallback(&raw_spec);
            }
            live.peer.kill();
            *self.live.lock() = None;
            live = self.ensure_session().await.map_err(Failure::from)?;
            if !prompt.images.is_empty() && !live.capabilities.images {
                return Err(Failure::from("This agent can't read images.".to_owned()));
            }
            content = with_shell(self.content(&live, prompt).await);
            result = live
                .peer
                .request("session/prompt", json!({ "sessionId": live.session, "prompt": content }), None)
                .await;
        }
        match result {
            Ok(v) => {
                if let Some(tokens) = config::tokens_of(&v) {
                    self.state.lock().task.stats.tokens = Some(tokens);
                    self.emit_task();
                }
                Ok(v.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn").to_owned())
            }
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
        let (provider_id, cwd, saved, pending) = {
            let s = self.state.lock();
            (s.task.provider.clone(), s.task.cwd.0.clone(), s.session_id.clone(), s.pending_model.clone())
        };
        let pending_model = pending.as_ref();
        let raw_spec = self.shared.spec(&provider_id).ok_or_else(|| format!("unknown agent {provider_id}"))?;
        let can_fallback =
            raw_spec.driver == provider::Driver::Copilot && !self.shared.uses_copilot_acp_fallback(&raw_spec);
        let primary_spec = if raw_spec.driver == provider::Driver::Copilot && !can_fallback {
            native::copilot::acp_fallback_spec(&raw_spec)
        } else {
            raw_spec.clone()
        };
        let opened = match self.open_session(&provider_id, primary_spec, &cwd, saved.clone(), pending_model).await {
            Ok(live) => Ok(live),
            Err(err) if can_fallback && err.allow_acp_fallback => {
                tracing::warn!(
                    "agent task {}: Copilot headless session setup failed ({}); falling back to `copilot --acp`",
                    self.id,
                    err.message
                );
                self.shared.mark_copilot_acp_fallback(&raw_spec);
                let acp_spec = native::copilot::acp_fallback_spec(&raw_spec);
                self.open_session(&provider_id, acp_spec, &cwd, saved, pending_model).await
            }
            Err(err) => Err(err),
        };
        let live = match opened {
            Ok(live) => live,
            Err(err) => {
                let mut s = self.state.lock();
                if pending.is_some() && s.pending_model == pending {
                    s.pending_model = None;
                    drop(s);
                    self.persist();
                    self.emit_task();
                }
                return Err(err.message);
            }
        };
        *self.live.lock() = Some(live.clone());
        Ok(live)
    }

    async fn open_session(
        self: &Arc<Self>,
        provider_id: &str,
        spec: provider::ProviderSpec,
        cwd: &Path,
        saved: Option<String>,
        pending_model: Option<&PendingModel>,
    ) -> Result<Live, SessionOpenError> {
        let launch_cwd = cwd.to_path_buf();
        let mut spec = tokio::task::spawn_blocking(move || {
            spec.resolve_for_launch_with_copilot_env(&launch_cwd, provider::prefer_stored_copilot_auth())
        })
        .await
        .map_err(|e| SessionOpenError { message: e.to_string(), allow_acp_fallback: false })?
        .map_err(|e| SessionOpenError { message: e, allow_acp_fallback: false })?;
        if spec.driver == provider::Driver::Acp && provider::is_copilot_provider(provider_id) {
            let mcp_overrides = self.state.lock().task.mcp_overrides.clone();
            for name in self.shared.mcp_servers_off_for_session(provider_id, &mcp_overrides) {
                spec.args.push("--disable-mcp-server".into());
                spec.args.push(name);
            }
        }
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
        let client = Client::new(self, saved.as_deref().filter(|_| pending_model.is_some()));
        let handler = acp::Dialect::wrap(client.clone());
        let raw_peer =
            (self.shared.connector)(&spec, cwd, handler.clone(), on_stderr).map_err(|e| SessionOpenError {
                message: format!("Couldn't start {} (`{}`): {e}", spec.name, spec.command),
                allow_acp_fallback: !native::copilot::is_missing_binary_error(&e),
            })?;
        let mut stop_on_err = KillOnDrop(Some(raw_peer.clone()));
        let peer = acp::Conn::new(raw_peer, handler);

        let init = peer.initialize(&client_info()).await.map_err(|e| {
            let is_auth = matches!(&e, RpcError::Server { code, message, .. } if acp::auth_required(*code, message));
            SessionOpenError { message: self.describe(e), allow_acp_fallback: !is_auth }
        })?;
        if let Some(args) = init.auth_methods.iter().find_map(|method| {
            if method.get("type").and_then(Value::as_str) != Some("terminal") {
                return None;
            }
            method.get("args")?.as_array()?.iter().map(|v| v.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()
        }) {
            self.shared.terminal_auth_args.write().insert(provider_id.to_owned(), args);
        }
        let sign_in_message = spec.sign_in_message(&init.auth_methods);
        let can_load = init.load_session();
        let (capabilities, embedded) = capabilities_of(&init);
        let (mcp_overrides, project_root) = {
            let s = self.state.lock();
            (s.task.mcp_overrides.clone(), s.task.project_root.clone().map(|p| p.0))
        };
        let mcp_servers = self.shared.mcp_servers_for_session(provider_id, &init, &mcp_overrides);
        let roots = self.shared.additional_directories(&init, cwd, project_root.as_deref());
        let skills_delivery = self.stage_skills(stage_key(spec.driver), cwd).await;
        // Agents that compare canonical paths fail in a symlinked directory (macOS `/tmp`).
        let cwd_s = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf()).to_string_lossy().into_owned();
        let pending_native_fork = self.state.lock().pending_native_fork.clone();

        let mut opening_params = session_params(&cwd_s, &mcp_servers, skills_delivery.as_ref(), &roots);
        if spec.driver == provider::Driver::Codex {
            let s = self.state.lock();
            let mut wanted = s.wanted.clone();
            if let Some(pending) = pending_model {
                pending.apply(&mut wanted, &s.task.config);
            }
            // Restore intent even when the resumed model cannot expose the Fast control.
            if let Some(fast) =
                wanted.iter().find(|c| c.id == "service_tier").and_then(|c| c.value.parse::<bool>().ok())
            {
                opening_params["_meta"]["openidea"]["codexFast"] = json!(fast);
            }
        }

        let mut tried_auth = false;
        let mut session = None;
        if let Some(fork) = pending_native_fork {
            if !capabilities.fork {
                return Err(SessionOpenError {
                    message: "the agent can't continue a recorded session".into(),
                    allow_acp_fallback: false,
                });
            }
            let mut params = opening_params.clone();
            params["sessionId"] = json!(&fork.source);
            if let Some(target) = &fork.target {
                match params["_meta"].as_object_mut() {
                    Some(meta) => {
                        if let Some(openidea) = meta.entry("openidea").or_insert_with(|| json!({})).as_object_mut() {
                            openidea.insert("forkSessionId".into(), json!(target));
                        }
                    }
                    None => params["_meta"] = json!({ "openidea": { "forkSessionId": target } }),
                }
            }
            let reply = self
                .request_with_auth(&peer, &init, &mut tried_auth, "session/fork", params)
                .await
                .map_err(|e| SessionOpenError { message: self.describe(e), allow_acp_fallback: false })?;
            let id = reply
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| SessionOpenError {
                    message: "the agent returned no session".into(),
                    allow_acp_fallback: false,
                })?
                .to_owned();
            session = Some((id, reply));
        } else {
            let start_fresh = self.start_fresh.load(Ordering::Acquire);
            if pending_model.is_some() && (saved.is_none() || !can_load || start_fresh) {
                return Err(SessionOpenError {
                    message: "The agent does not support resuming this session.".into(),
                    allow_acp_fallback: false,
                });
            }
            if let (Some(id), true, false) = (saved, can_load, start_fresh) {
                // The replay goes before what this turn already showed (the user's message).
                let shown = self.adopts_replay().then(|| self.take_entries());
                self.replaying.store(true, Ordering::Release);
                let mut params = opening_params.clone();
                params["sessionId"] = json!(&id);
                let loaded = self.request_with_auth(&peer, &init, &mut tried_auth, "session/load", params).await;
                tokio::time::sleep(REPLAY_GRACE).await;
                self.replaying.store(false, Ordering::Release);
                if let Some(shown) = shown {
                    if loaded.is_ok() {
                        self.adopting_replay.store(false, Ordering::Release);
                        let changed = self.state.lock().history.conversation.end_turn(None);
                        self.mark_dirty(changed);
                    } else {
                        // A failed load may still have replayed part of it.
                        self.take_entries();
                    }
                    for entry in shown {
                        self.push_entry(entry);
                    }
                }
                match loaded {
                    Ok(v) => session = Some((id, v)),
                    // Not silently: a new session would lose the conversation and replace the saved id.
                    Err(e) => {
                        tracing::info!("agent task {}: session/load failed: {e}", self.id);
                        if let Some(message) = self.sign_in_error(&e, Some(&sign_in_message)) {
                            return Err(SessionOpenError { message, allow_acp_fallback: false });
                        }
                        if pending_model.is_some() {
                            return Err(SessionOpenError {
                                message: format!(
                                    "Couldn't reopen this conversation's {} session: {}",
                                    spec.name,
                                    self.describe(e)
                                ),
                                allow_acp_fallback: false,
                            });
                        }
                        self.start_fresh.store(true, Ordering::Release);
                        return Err(SessionOpenError {
                            message: format!(
                                "Couldn't reopen this conversation's {} session: {}\n\nSend the message again to \
                                 continue in a new session. The agent won't see the earlier conversation.",
                                spec.name,
                                self.describe(e)
                            ),
                            allow_acp_fallback: false,
                        });
                    }
                }
            }
        }
        let resumed = session.is_some();
        let (session_id, result) = match session {
            Some(s) => s,
            None => {
                let mut params = opening_params;
                if self.state.lock().ephemeral {
                    mark_ephemeral(&mut params);
                }
                let v = self.request_with_auth(&peer, &init, &mut tried_auth, "session/new", params).await.map_err(
                    |e| match self.sign_in_error(&e, Some(&sign_in_message)) {
                        Some(msg) => SessionOpenError { message: msg, allow_acp_fallback: false },
                        None => SessionOpenError { message: self.describe(e), allow_acp_fallback: true },
                    },
                )?;
                let id = v
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| SessionOpenError {
                        message: "the agent returned no session".into(),
                        allow_acp_fallback: true,
                    })?
                    .to_owned();
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
        let mut reported = config::options_of(&result);
        if let Some(update) = client.take_opening_config()
            && let Some(config) = update.get("configOptions")
            && reported.iter().all(|o| o.category.as_deref() != Some("model"))
        {
            config::merge_update(&mut reported, config);
        }
        let known = !reported.is_empty();
        if known {
            self.shared.remember(provider_id, Some(&reported), None, model_of(&reported).as_deref());
        }
        let (mut options, mut wanted) = {
            let s = self.state.lock();
            let options = if known { reported } else { s.task.config.clone() };
            let mut wanted = s.wanted.clone();
            if let Some(pending) = pending_model {
                pending.apply(&mut wanted, &s.task.config);
            }
            (options, wanted)
        };
        config::add_client_options(provider_id, &mut options);
        // Changing model can replace the effort / context-tier choices; validate those only afterwards.
        wanted.sort_by_key(|c| {
            if let Some(pending) = pending_model {
                if c == &pending.model {
                    return 0;
                }
                if pending.choices.contains(c) {
                    return 2;
                }
            }
            match options.iter().find(|o| o.id == c.id) {
                Some(o) if o.category.as_deref() == Some("model") => 0,
                Some(o) if config::is_per_model_option(o) => 2,
                _ => 1,
            }
        });
        let mut model_options = known;
        for choice in &wanted {
            let pending = pending_model.is_some_and(|p| &p.model == choice);
            let explicit = pending_model.is_some_and(|p| p.choices.contains(choice));
            if pending
                && !options.iter().any(|o| {
                    o.id == choice.id
                        && (o.values.iter().any(|v| v.value == choice.value)
                            || (known && o.current.as_deref() == Some(choice.value.as_str())))
                })
            {
                return Err(SessionOpenError {
                    message: format!("The reloaded session does not offer model {}.", choice.value),
                    allow_acp_fallback: false,
                });
            }
            if explicit
                && (!model_options
                    || !options.iter().any(|o| {
                        o.id == choice.id
                            && config::is_per_model_option(o)
                            && o.values.iter().any(|v| v.value == choice.value)
                    }))
            {
                return Err(SessionOpenError {
                    message: format!("The selected model no longer offers {} value {}.", choice.id, choice.value),
                    allow_acp_fallback: false,
                });
            }
            // An option the session doesn't offer yet is set once it does (`apply_late_choices`).
            let Some(o) = options.iter().find(|o| o.id == choice.id).cloned() else { continue };
            if o.id == config::CURSOR_APPROVAL {
                if o.values.iter().any(|v| v.value == choice.value) {
                    options.iter_mut().find(|o| o.id == choice.id).unwrap().current = Some(choice.value.clone());
                }
                continue;
            }
            if config::is_per_model_option(&o) && !model_options {
                continue;
            }
            // A displayed tier can be inherited. Preserve an explicit Fast/Standard choice
            // even when it currently looks the same, so subsequent turns receive the override.
            let already =
                o.id != "service_tier" && (known || explicit) && o.current.as_deref() == Some(choice.value.as_str());
            if already || !o.values.iter().any(|v| v.value == choice.value) {
                continue;
            }
            self.config_sent.lock().insert((choice.id.clone(), choice.value.clone()));
            let (method, mut params) = config::set_request(&o, &choice.value);
            params["sessionId"] = json!(session_id);
            match peer.request::<_, Value>(method, params, None).await {
                Ok(reply) => {
                    let observed = client.take_opening_config();
                    let report =
                        if reply.get("configOptions").is_some() { &reply } else { observed.as_ref().unwrap_or(&reply) };
                    if pending && !config::accepts_model(report, &o.id, &choice.value) {
                        return Err(SessionOpenError {
                            message: format!("The reloaded session did not switch to model {}.", choice.value),
                            allow_acp_fallback: false,
                        });
                    }
                    if let Some(fresh) = report.get("configOptions") {
                        config::merge_update(&mut options, fresh);
                        if explicit
                            && !options.iter().any(|option| {
                                option.id == choice.id && option.current.as_deref() == Some(choice.value.as_str())
                            })
                        {
                            return Err(SessionOpenError {
                                message: format!(
                                    "The selected model did not accept {} value {}.",
                                    choice.id, choice.value
                                ),
                                allow_acp_fallback: false,
                            });
                        }
                        model_options = true;
                    } else if o.category.as_deref() == Some("model") {
                        if o.current.as_deref() != Some(choice.value.as_str()) {
                            options.retain(|o| !config::is_per_model_option(o));
                        }
                        model_options = false;
                    }
                    if let Some(o) = options.iter_mut().find(|o| o.id == choice.id) {
                        o.current = Some(choice.value.clone());
                    }
                }
                Err(e) if pending || explicit => {
                    return Err(SessionOpenError { message: self.describe(e), allow_acp_fallback: false });
                }
                Err(e) => tracing::warn!("agent task {}: setting {} to {} failed: {e}", self.id, o.id, choice.value),
            }
        }
        let model = model_of(&options).filter(|_| model_options);
        self.shared.remember(provider_id, Some(&options), None, model.as_deref());
        {
            let mut s = self.state.lock();
            if let Some(pending) = pending_model {
                if s.pending_model.as_ref() != Some(pending) {
                    return Err(SessionOpenError {
                        message: "The pending model settings changed while reopening the session.".into(),
                        allow_acp_fallback: false,
                    });
                }
                let TaskState { task, wanted, .. } = &mut *s;
                pending.apply(wanted, &task.config);
            }
            s.task.model = model_of(&options).or(s.task.model.take());
            s.task.config = options;
            s.pending_model = None;
            s.task.capabilities = capabilities;
            s.session_id = Some(session_id.clone());
            // The recorded session is forked (or the fork resumed): the one-shot intent is spent.
            s.pending_native_fork = None;
            self.start_fresh.store(false, Ordering::Release);
            // The (re)started process runs nothing yet: whatever it reports next is all of it.
            s.background_tasks = Vec::new();
            s.task.background.clear();
            *client.opening_config.lock() = None;
        }
        self.persist_soon();
        self.emit_task();
        stop_on_err.0 = None;
        Ok(Live {
            provider: provider_id.to_owned(),
            driver: spec.driver,
            sign_in_message,
            peer,
            session: session_id,
            capabilities,
            embedded,
            resumable: can_load,
            init,
        })
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
                            s.task.config.retain(|o| !config::is_per_model_option(o));
                        }
                        if let Some(o) = s.task.config.iter_mut().find(|o| o.id == option.id) {
                            o.current = Some(value);
                        }
                        s.task.model = model_of(&s.task.config).or(s.task.model.take());
                        sync_usage_context_size(&mut s.task);
                        // As in `set_config`: a copy without per-model options can't vouch for them.
                        let model = s.task.model.clone().filter(|_| {
                            reply.get("configOptions").is_some()
                                || (option.category.as_deref() != Some("model")
                                    && s.task.config.iter().any(config::is_per_model_option))
                        });
                        let (provider, options) = (s.task.provider.clone(), s.task.config.clone());
                        drop(s);
                        task.shared.remember(&provider, Some(&options), None, model.as_deref());
                    }
                    Err(e) => tracing::warn!("agent task {}: setting {} to {value} failed: {e}", task.id, option.id),
                }
            }
            task.approve_pending();
            task.persist_soon();
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
        if self.state.lock().history.conversation.owner(session).is_some() {
            if !SESSION_STATE.contains(&kind) && (!self.replaying.load(Ordering::Acquire) || self.adopts_replay()) {
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
            let depth = update.pointer("/_meta/hermes/sessionProvenance/compressionDepth").and_then(Value::as_u64);
            if let Some(depth) = depth.and_then(|d| u32::try_from(d).ok()) {
                let changed = {
                    let mut s = self.state.lock();
                    std::mem::replace(&mut s.task.stats.compressions, depth) != depth
                };
                if changed {
                    self.persist_soon();
                    self.emit_task();
                }
            }
            // The agent's own title for the session replaces the first line of the prompt,
            // unless the user named the task.
            let title = update.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
            if let Some(title) = title {
                // Check and write under one lock: a rename landing between them would be lost.
                let mut s = self.state.lock();
                let user_named = update.get("userNamed").and_then(Value::as_bool) == Some(true);
                let flag_changed = user_named && !s.title_renamed;
                if user_named {
                    s.title_renamed = true;
                }
                if (user_named || !s.title_renamed) && s.task.title != title {
                    s.task.title = title.to_owned();
                    drop(s);
                    self.persist_soon();
                    self.emit_task();
                } else if flag_changed {
                    drop(s);
                    self.persist_soon();
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
                self.persist_soon();
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
            if self.adopts_replay() {
                if kind == "user_message_chunk" {
                    self.adopt_user_chunk(update);
                } else {
                    self.apply(session, kind, update);
                }
            }
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

    fn adopts_replay(&self) -> bool {
        self.adopting_replay.load(Ordering::Acquire)
    }

    /// A user message of the adopted history: live turns show the user's own, so only a replay's count.
    fn adopt_user_chunk(self: &Arc<Self>, update: &Value) {
        let content = update.get("content");
        let image = content.and_then(images::from_content);
        let text = if image.is_some() { String::new() } else { timeline::content_text(content).unwrap_or_default() };
        if text.is_empty() && image.is_none() {
            return;
        }
        let changed = {
            let mut s = self.state.lock();
            let entries = &mut s.history.conversation.main.entries;
            // The chunks of one message arrive in a row.
            if let Some(AgentEntry::User { text: shown, images, .. }) = entries.last_mut() {
                shown.push_str(&text);
                images.extend(image);
                entries.len() - 1
            } else {
                s.history.conversation.main.push(AgentEntry::User {
                    text,
                    attachments: Vec::new(),
                    images: image.into_iter().collect(),
                    sent_ms: None,
                    done_ms: None,
                    steered: false,
                })
            }
        };
        self.mark_dirty([(None, changed)]);
    }

    fn apply(self: &Arc<Self>, session: Option<&str>, kind: &str, update: &Value) {
        // Output again: the retried request went through.
        self.set_retry(None);
        let applied = self.state.lock().history.conversation.apply(session, update, now_ms());
        self.mark_dirty(applied);
        // A subagent can start or finish after the turn that started it: nothing else saves it then.
        if matches!(kind, "subagent_update" | "user_question") {
            self.persist_soon();
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
        let title = self.labelled(params, title);
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
        let command = security::extract_command(params);
        // What the card names as the command: not for a request that grants more than running it.
        let shown = command.as_deref().filter(|_| !security::widens_access(params)).map(shown_command);
        if let Some(hook) = self.shared.security.read().clone()
            && let Some(command) = command.as_deref()
        {
            match security::evaluate_command(command, &hook()) {
                security::PolicyDecision::Blocked(pattern) => {
                    let reject = options.iter().find(|o| o.kind.starts_with("reject")).cloned();
                    let _ = self.push_entry(AgentEntry::Permission {
                        id,
                        title,
                        command: shown.clone(),
                        options,
                        questions: Vec::new(),
                        form: None,
                        chosen: Some(format!("Blocked by policy ({pattern})")),
                    });
                    return match reject {
                        Some(option) => json!({ "outcome": { "outcome": "selected", "optionId": option.id } }),
                        None => json!({ "outcome": { "outcome": "cancelled" } }),
                    };
                }
                security::PolicyDecision::Allowed if !security::widens_access(params) => {
                    if let Some(allow) = options
                        .iter()
                        .find(|o| o.kind == "allow_once")
                        .or_else(|| options.iter().find(|o| o.kind.starts_with("allow")))
                        .cloned()
                    {
                        let _ = self.push_entry(AgentEntry::Permission {
                            id,
                            title,
                            command: shown.clone(),
                            options,
                            questions: Vec::new(),
                            form: None,
                            chosen: Some(format!("{} (whitelisted)", allow.name)),
                        });
                        return json!({ "outcome": { "outcome": "selected", "optionId": allow.id } });
                    }
                }
                security::PolicyDecision::Allowed | security::PolicyDecision::AskUser => {}
            }
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let entry = self.push_entry(AgentEntry::Permission {
            id,
            title,
            command: shown,
            options: options.clone(),
            questions,
            form: None,
            chosen: None,
        });
        self.permissions.lock().insert(id, tx);
        self.set_status(AgentStatus::NeedsInput, None);
        self.approve_pending();
        self.emit_attention_if_input_pending();

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
        self.settle(entry, name);
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

    /// A request from a subagent is answered in the task's conversation, named after the subagent.
    fn labelled(&self, params: &Value, title: String) -> String {
        let session = params.get("sessionId").and_then(Value::as_str);
        match session.and_then(|s| self.state.lock().history.conversation.label(s)) {
            Some(label) => format!("{label}: {title}"),
            None => title,
        }
    }

    /// An agent's form (`elicitation/create`): asked in the conversation like a permission
    /// request, and answered with its values, declined or cancelled. Blocks like `ask_permission`.
    fn elicit(self: &Arc<Self>, params: &Value, raw: Option<&[u8]>) -> Result<Value, String> {
        let mut form = elicitation::form_of(params)?;
        if let Some(raw) = raw {
            elicitation::in_schema_order(&mut form, raw);
        }
        let id = self.next_permission.fetch_add(1, Ordering::Relaxed);
        let message = params.get("message").and_then(Value::as_str).unwrap_or_default().trim().to_owned();
        let (tx, rx) = std::sync::mpsc::channel();
        let entry = self.push_entry(AgentEntry::Permission {
            id,
            title: self.labelled(params, message),
            command: None,
            options: elicitation::options(),
            questions: Vec::new(),
            form: Some(form.clone()),
            chosen: None,
        });
        self.permissions.lock().insert(id, tx);
        self.set_status(AgentStatus::NeedsInput, None);
        self.emit_attention_if_input_pending();
        let reply = rx.recv().ok().flatten();
        let (response, chosen) = elicitation::answer(&form, reply.as_deref());
        self.settle(entry, chosen);
        Ok(response)
    }

    /// Records the answer to the request at `entry`; the turn runs on once nothing else waits.
    /// Saved before it returns, which is before the agent is told: a restart after that keeps the answer.
    fn settle(self: &Arc<Self>, entry: usize, chosen: String) {
        {
            let mut s = self.state.lock();
            if let Some(AgentEntry::Permission { chosen: answer, .. }) =
                s.history.conversation.main.entries.get_mut(entry)
            {
                *answer = Some(chosen);
            }
        }
        self.mark_dirty([(None, entry)]);
        let still_asking = !self.permissions.lock().is_empty();
        let resumed = !still_asking && self.state.lock().task.status == AgentStatus::NeedsInput;
        if resumed {
            self.change_status(AgentStatus::Running, None);
        }
        self.persist();
        if resumed {
            self.emit_task();
        }
    }

    fn approve_pending(&self) {
        let s = self.state.lock();
        if self.cancel_pending.load(Ordering::Acquire) || !config::bypass_approvals(&s.task.config) {
            return;
        }
        let mut pending = self.permissions.lock();
        for entry in s.history.conversation.main.entries.iter().rev() {
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
    opening_config: Mutex<Option<OpeningConfig>>,
}

/// Config replays belong to the candidate connection until its model and settings are confirmed.
struct OpeningConfig {
    session: String,
    options: Option<Value>,
}

impl Client {
    fn new(task: &Arc<Task>, opening_session: Option<&str>) -> Arc<Self> {
        Arc::new(Self {
            task: Arc::downgrade(task),
            opening_config: Mutex::new(
                opening_session.map(|id| OpeningConfig { session: id.to_owned(), options: None }),
            ),
        })
    }

    fn take_opening_config(&self) -> Option<Value> {
        self.opening_config.lock().as_mut()?.options.take()
    }
}

impl Handler for Client {
    fn on_notification(&self, method: &str, params: Value) {
        if method == WARNING_NOTIFICATION {
            if let Some(task) = self.task.upgrade()
                && let Some(message) = params.get("message").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
            {
                task.push_entry(AgentEntry::Error { message: message.to_owned() });
                task.persist_soon();
            }
            return;
        }
        if method == "session/update"
            && let (Some(task), Some(update)) = (self.task.upgrade(), params.get("update"))
        {
            if update.get("sessionUpdate").and_then(Value::as_str) == Some("config_option_update")
                && let Some(opening) = self.opening_config.lock().as_mut()
            {
                if params.get("sessionId").and_then(Value::as_str) == Some(opening.session.as_str()) {
                    opening.options = Some(update.clone());
                }
                return;
            }
            task.on_update(params.get("sessionId").and_then(Value::as_str), update);
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let task = self.task.upgrade().ok_or((codes::INTERNAL_ERROR, "task closed".to_owned()))?;
        match method {
            "session/request_permission" => Ok(task.ask_permission(&params)),
            "elicitation/create" => task.elicit(&params, None).map_err(|e| (codes::INVALID_PARAMS, e)),
            _ => Err((codes::METHOD_NOT_FOUND, format!("unsupported method {method}"))),
        }
    }

    fn on_request_raw(&self, method: &str, params: Value, raw: &[u8]) -> Result<Value, (i64, String, Option<Value>)> {
        if method != "elicitation/create" {
            return self.on_request_with_data(method, params);
        }
        let task = self.task.upgrade().ok_or((codes::INTERNAL_ERROR, "task closed".to_owned(), None))?;
        task.elicit(&params, Some(raw)).map_err(|e| (codes::INVALID_PARAMS, e, None))
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

/// A command as a permission card shows it: the script of a `<shell> -c <script>` line.
fn shown_command(command: &str) -> String {
    shell_script(command).unwrap_or_else(|| command.to_owned())
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
        out.push(json!({ "type": "image", "mimeType": i.media_type(), "data": i.data }));
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
        for (key, empty) in [
            ("config", json!([])),
            ("commands", json!([])),
            ("usage", Value::Null),
            ("queue", json!([])),
            ("mcpOverrides", json!({})),
        ] {
            task.entry(key).or_insert(empty);
        }
    }
    for entry in file.get_mut("entries").and_then(Value::as_array_mut).into_iter().flatten() {
        upgrade_entry(entry);
    }
    file
}

/// Fills in what an entry saved by an earlier version leaves out.
fn upgrade_entry(entry: &mut Value) {
    if entry.get("type").and_then(Value::as_str) == Some("user")
        && let Some(e) = entry.as_object_mut()
    {
        e.entry("attachments").or_insert(json!([]));
    }
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

pub(crate) fn client_info() -> Value {
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

/// The method that adds a message to the running turn: OpenIDEA's own, or the
/// `_session/steering` extension an agent advertises in the response's top-level `_meta`
/// (OMP).
fn steer_method(init: &acp::Negotiated) -> Option<&'static str> {
    let supported = |v: Option<&Value>| v.and_then(Value::as_bool) == Some(true);
    if supported(init.meta("/openidea/steer")) {
        Some("_openidea/steer")
    } else if supported(init.meta.as_ref().and_then(|m| m.pointer("/steering/supported"))) {
        Some("_session/steering")
    } else {
        None
    }
}

fn capabilities_of(init: &acp::Negotiated) -> (AgentCapabilities, bool) {
    let meta = |p: &str| init.meta(p).and_then(Value::as_bool) == Some(true);
    let capabilities = AgentCapabilities {
        images: init.prompt("image"),
        fork: init.session("fork"),
        rollback: meta("/openidea/rollback"),
        steer: steer_method(init).is_some(),
        background_tasks: meta("/openidea/backgroundTasks"),
        context_usage: meta("/openidea/contextUsage"),
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

/// The MCP servers of a session, and the names of the ones off for it.
struct McpForSession {
    servers: Vec<Value>,
    off: Vec<String>,
}

/// The driver a session's staged skills are staged for (`skills::stage` matches on it):
/// the native CLIs take the farm, everything else (an ACP agent) gets the `/` menu filter.
fn stage_key(driver: provider::Driver) -> &'static str {
    match driver {
        provider::Driver::Claude => "claude",
        provider::Driver::Codex => "codex",
        provider::Driver::Copilot => "copilot",
        provider::Driver::Acp => "acp",
    }
}

/// The session parameters `session/new`, `session/load` and `session/fork` share: the MCP
/// servers, and the ones off for this session, so an agent that also loads its own
/// configuration (Claude Code) can keep a same-named server of it off too — plus the
/// session's staged skills for the drivers that take them, and the workspace's other roots.
fn session_params(cwd: &str, mcp: &McpForSession, skills: Option<&skills::Delivery>, roots: &[String]) -> Value {
    let mut params = json!({ "cwd": cwd, "mcpServers": mcp.servers });
    if !roots.is_empty() {
        params["additionalDirectories"] = json!(roots);
    }
    let mut meta = json!({});
    if !mcp.off.is_empty() {
        meta["mcpServersOff"] = json!(mcp.off);
    }
    if let Some(skills) = skills
        && let Ok(v) = serde_json::to_value(skills)
    {
        meta["skills"] = v;
    }
    if !meta.is_null() && meta.as_object().is_some_and(|m| !m.is_empty()) {
        params["_meta"] = json!({ "openidea": meta });
    }
    params
}

/// `_meta.openidea.ephemeral` of `session/new`: the native drivers start the session without
/// saving it (Claude Code `--no-session-persistence`, Codex `ephemeral` threads).
fn mark_ephemeral(params: &mut Value) {
    if !params["_meta"]["openidea"].is_object() {
        params["_meta"]["openidea"] = json!({});
    }
    params["_meta"]["openidea"]["ephemeral"] = json!(true);
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

fn restore_config_choice(
    task: &Task,
    target: &AgentConfigOption,
    value: &str,
    previous: Option<&str>,
    model_choice: u64,
    previous_levels: Option<Vec<AgentConfigOption>>,
) {
    let option = target.id.as_str();
    let is_model = target.category.as_deref() == Some("model");
    let mut s = task.state.lock();
    if (is_model && s.model_choice != model_choice)
        || !s.task.config.iter().any(|o| o.id == option && o.current.as_deref() == Some(value))
    {
        return;
    }
    s.wanted.retain(|c| c.id != option);
    if let Some(previous) = previous {
        s.wanted.push(AgentConfigChoice { id: option.to_owned(), value: previous.to_owned() });
    }
    if let Some(o) = s.task.config.iter_mut().find(|o| o.id == option) {
        o.current = previous.map(str::to_owned);
    }
    if let Some(levels) = previous_levels {
        s.task.config.retain(|o| !config::is_per_model_option(o));
        s.task.config.extend(levels);
    }
    s.task.model = model_of(&s.task.config).or(s.task.model.take());
}

fn model_of(config: &[AgentConfigOption]) -> Option<String> {
    config.iter().find(|o| o.category.as_deref() == Some("model")).and_then(|o| o.current.clone())
}

/// Commands the agent implements on its own and never lists in `availableCommands`.
fn builtin_commands(provider: &str) -> Vec<AgentCommand> {
    match provider {
        // Codex app-server has no command-list API, so the native adapter supplies its
        // stable builtins and merges the session's dynamic skills separately.
        "codex" => native::codex::builtin_commands(),
        // OpenCode ACP handles `/compact` via session.summarize but omits it from its command list.
        "opencode" => vec![AgentCommand {
            name: "compact".into(),
            description: "compact the conversation".into(),
            hint: None,
            source: AgentCommandSource::Command,
        }],
        _ => Vec::new(),
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

/// The title of a task: the first line of the prompt that says something. Text inside a code
/// fence (```` ```text ````) is pasted material, so a line outside the fences wins; a prompt
/// that is all one pasted block still names its task from inside it.
fn title_of(prompt: &AgentPrompt) -> String {
    let is_fence = |l: &str| l.starts_with("```") || l.starts_with("~~~");
    let (mut outside, mut inside, mut fenced) = (None, None, false);
    for l in prompt.text.lines().map(str::trim) {
        if is_fence(l) {
            fenced = !fenced;
        } else if !l.is_empty() {
            let slot = if fenced { &mut inside } else { &mut outside };
            slot.get_or_insert(l);
            if outside.is_some() {
                break;
            }
        }
    }
    let line = outside.or(inside);
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

/// How many times each file was written, in test builds: lets a test count a task's saves.
#[cfg(test)]
static FILE_WRITES: std::sync::LazyLock<Mutex<HashMap<PathBuf, u32>>> = std::sync::LazyLock::new(Mutex::default);

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path)).map_err(|e| e.to_string())?;
    #[cfg(test)]
    {
        *FILE_WRITES.lock().entry(path.to_owned()).or_default() += 1;
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// [`blocking`] for work that runs git: the repositories it opens run the project's git.
async fn vcs<T: Send + 'static>(shared: &Shared, f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    let git = shared.git_executable.read().as_ref().and_then(|hook| hook());
    blocking(move || ide_vcs::with_git_executable(git.as_deref(), f)).await
}

async fn read_changes<T: Send + 'static>(
    shared: &Shared,
    f: impl FnOnce() -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    let permit = shared.change_reads.clone().acquire_owned().await.map_err(|e| IdeError::internal(e.to_string()))?;
    vcs(shared, move || {
        // Dropping the caller doesn't cancel a blocking job. Keep the slot with the work.
        let _permit = permit;
        f()
    })
    .await
}

#[cfg(test)]
mod replay;
#[cfg(test)]
mod replay_tests;
#[cfg(test)]
mod tests;

/// The name agents know the built-in server by (its tools are `mcp__OpenIDEA__…` in Claude Code).
const BUILTIN_SERVER: &str = "OpenIDEA";

fn stdio_mcp_servers(executable: Option<&std::path::Path>, supported: bool, root: &std::path::Path) -> Vec<Value> {
    let Some(executable) = executable.filter(|_| supported) else { return Vec::new() };
    let command = ide_mcp::stdio_command(executable, root);
    let env: Vec<Value> = ["OPENIDEA_SERVER_HOME", "OPENIDEA_DATA_DIR"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| json!({ "name": name, "value": value })))
        .collect();
    vec![json!({ "name": BUILTIN_SERVER, "command": command[0], "args": command[1..], "env": env })]
}

/// What was sent of a streaming text: its first `bytes` (`utf16` UTF-16 units), hashed. The
/// text only grows while it streams; the hash tells one that went on from one that was replaced
/// (at its end or anywhere before) without keeping a copy of it.
struct Sent {
    index: usize,
    bytes: usize,
    utf16: usize,
    hash: u64,
}

impl Sent {
    fn new(index: usize, text: &str) -> Self {
        Self { index, bytes: text.len(), utf16: text.encode_utf16().count(), hash: Self::digest(text) }
    }

    fn digest(text: &str) -> u64 {
        let mut hasher = DefaultHasher::new();
        hasher.write(text.as_bytes());
        hasher.finish()
    }

    /// `text` at `index` as sent after this, when it is this text with more at the end.
    fn extended(&self, index: usize, text: &str) -> Option<Self> {
        if self.index != index || text.len() <= self.bytes || !text.is_char_boundary(self.bytes) {
            return None;
        }
        let mut hasher = DefaultHasher::new();
        hasher.write(&text.as_bytes()[..self.bytes]);
        if hasher.finish() != self.hash {
            return None;
        }
        let more = &text[self.bytes..];
        hasher.write(more.as_bytes());
        Some(Self { index, bytes: text.len(), utf16: self.utf16 + more.encode_utf16().count(), hash: hasher.finish() })
    }

    /// Whether `text` is exactly what was sent.
    fn is(&self, text: &str) -> bool {
        text.len() == self.bytes && Self::digest(text) == self.hash
    }
}

/// A running tool call as last sent: the entry without its output, and what was sent of that.
struct SentTool {
    call: AgentEntry,
    output: Sent,
}

/// What each window was last sent of the entries that stream, so the next flush sends the rest.
#[derive(Default)]
struct Streamed {
    /// The message each session streams now.
    messages: HashMap<Session, Sent>,
    /// The tool calls still running, by session and entry index.
    tools: HashMap<(Session, usize), SentTool>,
}

impl Streamed {
    fn clear(&mut self) {
        self.messages.clear();
        self.tools.clear();
    }
}

/// The event that brings the UI's copy of entry `i` up to date: only the new text when
/// it extends the message (or the tool output) last sent, else the whole entry; `None`
/// when the UI's copy of a tool already is the entry.
fn entry_event(
    task: &str,
    streamed: &mut Streamed,
    subagent: Session,
    i: usize,
    entry: &AgentEntry,
) -> Option<AgentEvent> {
    let whole = |subagent| AgentEvent::Entry { task: task.to_owned(), subagent, index: i as u32, entry: entry.clone() };
    let text = match entry {
        AgentEntry::Agent { text } | AgentEntry::Thought { text, .. } => Some(text),
        AgentEntry::Tool { .. } => return tool_event(task, streamed, subagent, i, entry),
        _ => None,
    };
    let Some(text) = text else {
        if streamed.messages.get(&subagent).is_some_and(|sent| sent.index == i) {
            streamed.messages.remove(&subagent);
        }
        return Some(whole(subagent));
    };
    match streamed.messages.get(&subagent).and_then(|sent| Some((sent.bytes, sent.utf16, sent.extended(i, text)?))) {
        Some((bytes, from, sent)) => {
            streamed.messages.insert(subagent.clone(), sent);
            Some(AgentEvent::Append {
                task: task.to_owned(),
                subagent,
                index: i as u32,
                from: from as u32,
                text: text[bytes..].to_owned(),
            })
        }
        None => {
            streamed.messages.insert(subagent.clone(), Sent::new(i, text));
            Some(whole(subagent))
        }
    }
}

/// [`entry_event`] for a tool call: the output it grew by while the rest of it is unchanged.
fn tool_event(
    task: &str,
    streamed: &mut Streamed,
    subagent: Session,
    i: usize,
    entry: &AgentEntry,
) -> Option<AgentEvent> {
    let AgentEntry::Tool { id, title, kind, status, locations, images, output, diffs, started_ms, ended_ms, command } =
        entry
    else {
        return None;
    };
    let call = AgentEntry::Tool {
        id: id.clone(),
        title: title.clone(),
        kind: kind.clone(),
        status: *status,
        locations: locations.clone(),
        images: images.clone(),
        output: None,
        diffs: diffs.clone(),
        started_ms: *started_ms,
        ended_ms: *ended_ms,
        command: command.clone(),
    };
    let text = output.as_deref().unwrap_or_default();
    let key = (subagent, i);
    if let Some(sent) = streamed.tools.get_mut(&key).filter(|sent| sent.call == call) {
        if let Some(output) = sent.output.extended(i, text) {
            let (bytes, from) = (sent.output.bytes, sent.output.utf16);
            sent.output = output;
            return Some(AgentEvent::ToolOutput {
                task: task.to_owned(),
                subagent: key.0,
                index: i as u32,
                from: from as u32,
                text: text[bytes..].to_owned(),
            });
        }
        if sent.output.is(text) {
            return None;
        }
    }
    if matches!(status, AgentToolStatus::Pending | AgentToolStatus::Running) {
        streamed.tools.insert(key.clone(), SentTool { call, output: Sent::new(i, text) });
    } else {
        streamed.tools.remove(&key);
    }
    Some(AgentEvent::Entry { task: task.to_owned(), subagent: key.0, index: i as u32, entry: entry.clone() })
}

struct SessionOpenError {
    message: String,
    allow_acp_fallback: bool,
}

struct KillOnDrop(Option<Peer>);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if let Some(peer) = self.0.take() {
            peer.kill();
        }
    }
}

fn is_headless_protocol_error(code: i64) -> bool {
    matches!(
        code,
        ide_jsonrpc::codes::PARSE_ERROR
            | ide_jsonrpc::codes::INVALID_REQUEST
            | ide_jsonrpc::codes::METHOD_NOT_FOUND
            | ide_jsonrpc::codes::INVALID_PARAMS
    )
}

/// Keeps `task.usage.size` aligned with the active model and `context_tier` when pricing
/// metadata reports the selected tier's token limit.
fn sync_usage_context_size(task: &mut AgentTask) {
    let Some(usage) = task.usage.as_mut() else { return };
    let Some(model_opt) = task.config.iter().find(|o| o.category.as_deref() == Some("model")) else { return };
    let Some(model_id) = model_opt.current.as_deref() else { return };
    let Some(pricing) = model_opt.values.iter().find(|v| v.value == model_id).and_then(|v| v.pricing.as_deref()) else {
        return;
    };
    let tier = task
        .config
        .iter()
        .find(|o| config::is_context_option(&o.id))
        .and_then(|o| o.current.as_deref())
        .unwrap_or("default");
    if let Some(tokens) = pricing
        .tiers
        .get(tier)
        .or_else(|| pricing.tiers.get("default"))
        .or_else(|| pricing.tiers.get("long_context"))
        .and_then(|t| t.context_tokens)
        .filter(|&n| n > 0)
    {
        usage.size = tokens;
    }
}
