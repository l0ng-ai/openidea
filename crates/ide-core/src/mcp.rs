//! The built-in MCP server (`ide-mcp`): its settings, its status, and what it asks
//! the UI (confirmations, editor state). Shared with the UI through `bindings.ts`.

use crate::IpcPath;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

/// The port the server listens on unless Tools › MCP Server picks another.
pub const DEFAULT_MCP_PORT: u16 = 64352;

/// Tools › MCP Server (global only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct McpSettings {
    /// Serve the MCP endpoint on `127.0.0.1:<port>`.
    pub enabled: bool,
    pub port: u16,
    /// Run shell commands and run configurations without asking first.
    pub brave_mode: bool,
    /// Ask confirmations in the MCP client (`elicitation/create`) when it supports that,
    /// instead of in the IDE. Off by default: a client could answer its own elicitations.
    pub client_confirmations: bool,
    /// Tool names that are not offered to clients (the first disallow list; `tool_states` supersedes it).
    pub disabled_tools: Vec<String>,
    /// Give the IDE's own agents (Agents tool window) these tools too.
    pub agents: bool,
    /// Comma-separated masks over fully qualified tool names (`-*,+general.SearchToolset.*,-*.read_file`):
    /// `+` (or nothing) allows, `-` hides, `*` / `?` are wildcards, the last matching mask wins.
    /// Empty means no filter.
    pub tools_filter: String,
    /// Per-tool state by fully qualified name (or plain name), as Exposed Tools stores it.
    pub tool_states: BTreeMap<String, McpToolState>,
    /// How clients reach the tools: each directly, or through the `execute_tool` router.
    pub invocation_mode: McpInvocationMode,
    /// Offer experimental tools (`get_ide_diagnostics`, ...) too.
    pub experimental_tools: bool,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_MCP_PORT,
            brave_mode: false,
            client_confirmations: false,
            disabled_tools: Vec::new(),
            agents: true,
            tools_filter: String::new(),
            tool_states: BTreeMap::new(),
            invocation_mode: McpInvocationMode::Direct,
            experimental_tools: false,
        }
    }
}

/// One tool's entry in [`McpSettings::tool_states`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct McpToolState {
    /// Offered at all.
    pub enabled: bool,
    /// In router mode, reachable only through `execute_tool` instead of listed directly.
    pub router_only: bool,
}

impl Default for McpToolState {
    fn default() -> Self {
        Self { enabled: true, router_only: true }
    }
}

/// How a session's client reaches the tools.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpInvocationMode {
    /// Every tool is listed and called directly.
    #[default]
    Direct,
    /// Only `execute_tool` (and tools whose state is not router-only) is listed; it calls the others by name.
    ViaRouter,
}

/// Whether the server runs, and where.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    /// The endpoint (`http://127.0.0.1:64352/mcp`) while running.
    pub url: Option<String>,
    pub port: Option<u16>,
    /// Why it is not running although enabled (port in use, ...).
    pub error: Option<String>,
    /// Clients that initialized a session since the server started, most recent first.
    pub clients: Vec<McpClient>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpClient {
    pub name: String,
    pub version: String,
    /// Tool calls this client made.
    pub calls: u32,
}

/// One tool, for the settings page's tool list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    /// `read`, `edit` or `execute` (asks first unless brave mode is on).
    pub kind: McpToolKind,
    /// Offered to clients under the current settings (filter, tool states, experimental tools).
    pub enabled: bool,
    /// The toolset (`general.SearchToolset`), as the JetBrains IDEs group their tools.
    pub group: String,
    /// The toolset's display name (`Search`).
    pub group_name: String,
    /// `<group>.<name>`: what `toolsFilter` masks and `toolStates` keys match.
    pub fully_qualified_name: String,
    /// Hidden unless experimental tools are on.
    pub experimental: bool,
    /// In router mode, reachable only through `execute_tool`.
    pub router_only: bool,
}

/// How a recorded tool call ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpCallOutcome {
    InProgress,
    Success,
    /// The tool returned an error.
    Error,
    /// The client or the user cancelled it.
    Cancelled,
    /// The tool failed unexpectedly (it panicked).
    Failed,
}

/// One tool call, for the server's call history (`mcp_call_history`, `get_ide_diagnostics`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpCallRecord {
    /// Counts up from 1 since the application started.
    pub id: u32,
    pub client: String,
    pub tool: String,
    /// The arguments, shortened and with secret-looking values replaced by `***`.
    pub arguments: String,
    /// Milliseconds since the Unix epoch.
    pub started_at_ms: f64,
    /// Set when the call ended.
    pub duration_ms: Option<u32>,
    pub outcome: McpCallOutcome,
    /// Why the call did not succeed (an error, a cancellation, a failure).
    pub error: Option<String>,
    /// Called through `execute_tool`.
    pub via_router: bool,
    /// The root of the project the call ran against, once it was known.
    pub project: Option<String>,
    /// Files the call created, changed, moved or deleted (project-relative inside the project).
    pub changed_files: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpToolKind {
    /// Reads the project; no side effects.
    Read,
    /// Changes files of the project or the editor state.
    Edit,
    /// Runs processes (terminal commands, run configurations, builds).
    Execute,
}

/// What the server needs from a project window's UI; answered with `mcp_respond`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum McpUiRequest {
    /// Ask before running something: answered with `true` (allow) or `false`.
    Confirm {
        /// The MCP client's name (`claude-code`).
        client: String,
        tool: String,
        /// What will run (a command line, a configuration's name).
        subject: String,
        /// Extra detail (working directory, ...).
        detail: Option<String>,
    },
    /// Open `path` in an editor at the 1-based `line` / `column`: answered with `null`.
    OpenFile { path: IpcPath, line: Option<u32>, column: Option<u32> },
    /// The open editors: answered with an [`McpOpenEditors`].
    OpenEditors,
}

/// The answer to [`McpUiRequest::OpenEditors`].
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpOpenEditors {
    pub active: Option<IpcPath>,
    pub open: Vec<IpcPath>,
}

/// An MCP client whose configuration Tools › MCP Server can show or write.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpClientKind {
    ClaudeCode,
    Codex,
    Cursor,
    VsCode,
    Windsurf,
    Gemini,
    /// The Claude desktop app: it starts servers as commands (`openidea mcp-stdio`).
    ClaudeDesktop,
    Junie,
    /// JetBrains Air.
    Air,
    GitHubCopilotCli,
    /// The GitHub Copilot plugin for JetBrains IDEs.
    GitHubCopilotIdePlugin,
}

/// How a configured server entry talks to its server.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    /// The client starts a command and talks over its stdin / stdout.
    Stdio,
    Sse,
    /// Streamable HTTP.
    Http,
}

/// An MCP client found on this machine (`mcp_detect_clients`), and whether its
/// configuration reaches this server.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpDetectedClient {
    pub client: McpClientKind,
    /// The project whose configuration this is; `None` for the user-level one.
    pub project: Option<IpcPath>,
    pub file: IpcPath,
    /// Some entry points at OpenIDEA (any port); `None` when the file lists no servers.
    pub configured: Option<bool>,
    /// The entries that look like OpenIDEA's use this server's port (`false`: a stale port).
    pub port_correct: bool,
    /// The `openidea` entry has this server's URL and token (a project's: the stdio bridge
    /// with this port, token file and project).
    pub current: bool,
    /// The transports of all the file's server entries.
    pub transports: Vec<McpTransport>,
}

/// An agent a bundled skill can be installed for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpSkillTarget {
    /// Claude Code (`~/.claude/skills`).
    Claude,
    /// Codex (`~/.codex/skills`).
    Codex,
    /// Junie (`~/.junie/skills`).
    Junie,
    /// Agents reading the shared `~/.agents/skills`.
    Other,
}

/// A skill OpenIDEA bundles for agents that use its MCP tools.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpSkillInfo {
    pub id: String,
    pub description: String,
    pub targets: Vec<McpSkillTarget>,
    /// The MCP tools the skill uses.
    pub tools: Vec<String>,
    /// Settings disable none of the tools the skill needs.
    pub available: bool,
    /// Where it is installed now.
    pub installed: Vec<McpSkillTarget>,
}

/// A client's configuration for this server.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpClientConfig {
    pub client: McpClientKind,
    /// The file the configuration goes into (`~/.cursor/mcp.json`), if it has one.
    pub file: Option<IpcPath>,
    /// The snippet to paste there (JSON or TOML); it never is a command line, which would
    /// leave the token in the shell history.
    pub snippet: String,
    /// `json` or `toml`.
    pub format: String,
    /// The file already has an `openidea` entry.
    pub configured: bool,
    /// Auto-Configure can write the file.
    pub can_write: bool,
}

/// A window's answer to an [`McpUiRequest`] (`mcp_respond`).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum McpAnswer {
    /// To `Confirm`.
    Confirm { allow: bool },
    /// To `OpenFile`.
    Done,
    /// To `OpenEditors`.
    OpenEditors { editors: McpOpenEditors },
    /// The UI could not do it.
    Failed { message: String },
}
