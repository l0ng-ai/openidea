//! MCP tools: AI agents outside the IDE (Claude Code, Codex…) call them
//! through the IDE's MCP server. Declare each tool in `plugin.toml`,
//! implement [`McpTools`] and register with `register_plugin!(T, mcp)`:
//!
//! ```toml
//! [capabilities]
//! required = ["mcp", "project.read"]
//!
//! [[contributes.mcpTools]]
//! name = "word_count"                       # [a-z][a-z0-9_]{0,63}
//! description = "Counts the words of a project file"
//! input-schema = "mcp/word_count.json"      # {"type": "object", "properties": {"path": {"type": "string"}}}
//! read-only = true
//! ```
//!
//! ```ignore
//! impl McpTools for WordTools {
//!     fn call_tool(&mut self, name: &str, arguments: &str, ctx: &Invocation) -> Result<String, Error> {
//!         let project = ctx.project().ok_or("no project")?;
//!         let path = /* parse `arguments`, a JSON object */;
//!         Ok(project.read_file(path)?.split_whitespace().count().to_string())
//!     }
//! }
//! ```
//!
//! A tool runs in the plugin's instance under the command budget (5 s; 60 s
//! with a task open) and with the plugin's capabilities. `ctx.project()` is the
//! project the agent asked for, `ctx.editor()` the focused editor of its window.
//! Get the server's address with [`crate::host::Project::mcp_endpoint`].

use crate::{Error, Invocation};

pub trait McpTools {
    /// Runs tool `name`. `arguments` is the JSON object the agent sent, as
    /// text: check it, it is not validated against the declared schema. The
    /// returned text is the tool's result; an error is reported to the agent
    /// as a failed call.
    fn call_tool(&mut self, name: &str, arguments: &str, ctx: &Invocation) -> Result<String, Error>;
}
