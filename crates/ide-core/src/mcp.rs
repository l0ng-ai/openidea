//! The built-in MCP server (`ide-mcp`): its settings, its status, and what it asks
//! the UI (confirmations, editor state). Shared with the UI through `bindings.ts`.

use crate::IpcPath;
use serde::{Deserialize, Serialize};
use specta::Type;

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
    /// Tool names that are not offered to clients.
    pub disabled_tools: Vec<String>,
    /// Give the IDE's own agents (Agents tool window) these tools too.
    pub agents: bool,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_MCP_PORT, brave_mode: false, disabled_tools: Vec::new(), agents: true }
    }
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
    pub enabled: bool,
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
    /// The `openidea` entry has this server's URL and token.
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
    /// The snippet to paste there (JSON or TOML), or a command line to run.
    pub snippet: String,
    /// `json`, `toml` or `shell`.
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
