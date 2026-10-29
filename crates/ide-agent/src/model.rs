//! IPC types: tasks, their timeline entries and the events streamed to the UI.

use ide_core::IpcPath;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    /// Creating the worktree / starting the agent.
    Starting,
    Running,
    /// Waiting for a permission answer.
    NeedsInput,
    /// The turn ended; the result can be reviewed or the conversation continued.
    Ready,
    Failed,
    /// The account's usage limit was reached; the conversation can go on once it resets.
    Limited,
    Archived,
}

/// What a task's agent can do beyond a plain conversation, as it reported when its
/// session started.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentCapabilities {
    /// Images in messages.
    pub images: bool,
    /// The conversation can be copied into a new task (`session/fork`).
    pub fork: bool,
    /// Its latest turns can be dropped.
    pub rollback: bool,
    /// A message can join the running turn instead of waiting for it.
    pub steer: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Isolation {
    /// A new git worktree on its own branch.
    Worktree,
    /// The project's own checkout.
    Local,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub id: String,
    pub title: String,
    /// [`AgentProvider::id`].
    pub provider: String,
    /// Model the task runs on (its `model` setting), when known.
    pub model: Option<String>,
    pub status: AgentStatus,
    pub isolation: Isolation,
    /// Directory the agent works in (the worktree, or the project root).
    pub cwd: IpcPath,
    /// Branch of the task's worktree.
    pub branch: Option<String>,
    /// Branch (or revision) the worktree was created from.
    pub base: Option<String>,
    /// Commit the task's changes are compared against (worktree tasks; local ones use `HEAD`).
    pub base_commit: Option<String>,
    /// Why the task failed, when it did.
    pub error: Option<String>,
    pub created_ms: f64,
    pub updated_ms: f64,
    /// The session's settings (model, mode, thinking effort…) as last reported, with the
    /// user's choices applied.
    pub config: Vec<AgentConfigOption>,
    /// Slash commands the agent offers.
    pub commands: Vec<AgentCommand>,
    /// Context window use, when the agent reports it.
    pub usage: Option<AgentUsage>,
    /// Messages waiting for the current turn to end, oldest first.
    pub queue: Vec<AgentQueued>,
    #[serde(default)]
    pub capabilities: AgentCapabilities,
    /// When a [`AgentStatus::Limited`] task's limit resets (ms since the epoch), if the agent said.
    #[serde(default)]
    pub resets_ms: Option<f64>,
    /// The agent is retrying a failed API request (connection lost, overloaded…); cleared
    /// by its next output or any status change.
    #[serde(default)]
    pub retry: Option<AgentRetry>,
}

/// An API request the agent is about to retry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRetry {
    pub attempt: u32,
    pub max_retries: Option<u32>,
    /// When the next attempt starts (ms since the epoch).
    pub retry_at_ms: f64,
    pub error: Option<String>,
}

/// One value of a select-type session setting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigValue {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

/// How a setting is changed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentConfigVia {
    /// `session/set_config_option`.
    #[default]
    Option,
    /// `session/set_mode` (agents that report `modes` instead of a mode config option).
    Mode,
    /// `session/set_model` (agents that report `models` instead of a model config option).
    Model,
}

/// A session setting: an ACP select config option, or the older `modes` / `models`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// ACP category: `model`, `mode`, `thought_level`, or agent-specific.
    pub category: Option<String>,
    pub current: Option<String>,
    pub values: Vec<AgentConfigValue>,
    pub via: AgentConfigVia,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    /// Without the leading `/`.
    pub name: String,
    pub description: String,
    /// What to type after the command, when it takes input.
    pub hint: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    /// Tokens in the context window.
    pub used: u32,
    /// Size of the context window.
    pub size: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentImage {
    pub mime_type: String,
    /// Base64, without a `data:` prefix.
    pub data: String,
    pub name: Option<String>,
}

/// A message to the agent: text, plus files to look at and images.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPrompt {
    pub text: String,
    pub files: Vec<IpcPath>,
    pub images: Vec<AgentImage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentQueued {
    pub id: String,
    pub prompt: AgentPrompt,
}

/// A setting chosen for a new task, by [`AgentConfigOption::id`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigChoice {
    pub id: String,
    pub value: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentToolStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolDiff {
    pub path: IpcPath,
    pub added: u32,
    pub removed: u32,
}

/// What a subagent is doing, as its parent reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentSubagentStatus {
    Running,
    /// One of its requests (a permission) waits for an answer.
    NeedsInput,
    Done,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanItem {
    pub content: String,
    /// `pending`, `in_progress` or `completed`.
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionOption {
    pub id: String,
    pub name: String,
    /// `allow_once`, `allow_always`, `reject_once` or `reject_always`.
    pub kind: String,
}

/// One item of a task's conversation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEntry {
    User {
        text: String,
        /// Names of the files and images sent with it.
        attachments: Vec<String>,
        /// When it was sent (ms since the epoch); `None` in tasks saved before this was kept.
        #[serde(default)]
        sent_ms: Option<f64>,
        /// When the turn it started ended; `None` while it runs or when it was cut off.
        #[serde(default)]
        done_ms: Option<f64>,
        /// Sent into a running turn rather than starting one.
        #[serde(default)]
        steered: bool,
    },
    Agent {
        text: String,
    },
    Thought {
        text: String,
    },
    Tool {
        id: String,
        title: String,
        /// ACP tool kind: `read`, `edit`, `execute`, `search`, `fetch`, `think`…
        kind: String,
        status: AgentToolStatus,
        locations: Vec<IpcPath>,
        /// Text the tool reported (command output…), truncated.
        output: Option<String>,
        diffs: Vec<AgentToolDiff>,
    },
    Plan {
        items: Vec<AgentPlanItem>,
    },
    /// A subagent the agent started: its own session, whose entries are listed separately.
    Subagent {
        /// The subagent's session id.
        id: String,
        title: Option<String>,
        description: Option<String>,
        status: AgentSubagentStatus,
        error: Option<String>,
        /// What it was asked to do, last.
        prompt: Option<String>,
        /// Its answer.
        reply: Option<String>,
        /// Tool calls it made.
        tools: u32,
        /// Title of its latest tool call.
        activity: Option<String>,
        started_ms: f64,
        /// When it last stopped working; `None` while it works.
        ended_ms: Option<f64>,
        /// Whether it can be stopped on its own.
        cancellable: bool,
    },
    /// A message between sessions in a subagent's conversation: its task (`incoming`) or its report.
    Message {
        incoming: bool,
        text: String,
    },
    Permission {
        id: u32,
        title: String,
        options: Vec<AgentPermissionOption>,
        /// Name of the chosen option, or `None` while pending. Cancelled requests read "Cancelled".
        chosen: Option<String>,
    },
    Error {
        message: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentProvider {
    pub id: String,
    pub name: String,
    /// The command line that starts its ACP server.
    pub command: String,
    /// Whether the command was found (on `PATH`).
    pub installed: bool,
    /// Settings (models, modes…) the agent offered last time it ran; empty before its first session.
    pub config: Vec<AgentConfigOption>,
    /// Slash commands it offered last time.
    pub commands: Vec<AgentCommand>,
    pub source: AgentSource,
}

/// Where an agent comes from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentSource {
    Builtin,
    /// Defined by the user in `<config>/agents/<id>.toml`.
    Custom,
    /// Installed from the ACP Registry.
    Registry {
        version: String,
        /// A newer version the registry offers.
        update: Option<String>,
    },
}

/// What an agent says about itself when it starts (`initialize` only: no session, so no
/// MCP servers, hooks or sign-in run).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbe {
    pub provider: String,
    /// The agent's own name and version, when it reports them.
    pub name: Option<String>,
    pub version: Option<String>,
    /// How it is driven: `ACP v1`, `ACP v2` or `native`.
    pub protocol: String,
    pub capabilities: AgentCapabilities,
    /// Ways to sign in it offers.
    pub auth_methods: Vec<String>,
    /// Why it could not be started.
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentTask {
    pub prompt: AgentPrompt,
    pub provider: String,
    /// Settings for the new session (model, mode…).
    pub config: Vec<AgentConfigChoice>,
    pub isolation: Isolation,
    /// Branch to start the worktree from; the current branch when `None`.
    pub base: Option<String>,
}

/// A file the task changed, relative to [`AgentTask::base_commit`].
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentChange {
    pub path: IpcPath,
    pub rel_path: String,
    pub kind: ide_vcs::ChangeKind,
    pub added: u32,
    pub removed: u32,
}

/// Streamed to the window that subscribed (`AgentManager::subscribe`).
#[derive(Clone, Debug, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    /// A task was created or its metadata changed.
    Task {
        task: AgentTask,
    },
    Removed {
        id: String,
    },
    /// The task's conversation was cut to its first `length` entries (turns rolled back).
    Truncated {
        task: String,
        length: u32,
    },
    /// Entry `index` of `task` (of its subagent `subagent`) was added or replaced.
    Entry {
        task: String,
        subagent: Option<String>,
        index: u32,
        entry: AgentEntry,
    },
}
