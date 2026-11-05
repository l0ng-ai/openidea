//! The IDE's MCP server: AI agents outside the IDE (Claude Code, Codex…) call
//! the tools plugins declare (`[[contributes.mcpTools]]`).
//!
//! - **Transport:** MCP Streamable HTTP (2025-06-18; 2025-03-26 and 2024-11-05
//!   clients too) on `127.0.0.1:<random port>`, endpoint `/mcp`. Responses are
//!   plain JSON (no SSE streams: `GET` is 405). Every request carries
//!   `Authorization: Bearer <token>` (random, per run); requests from another
//!   `Origin` or `Host` are refused (DNS rebinding).
//! - **Projects:** the `X-OpenIDEA-Project` header or the `?project=` query
//!   names a folder; the server picks the open project containing it.
//! - **Discovery:** `<app-data>/mcp/server.json` (`port`, `token`, `pid`,
//!   `version`; readable only by the user) while the server runs.
//! - **Stdio:** `<app exe> --mcp-stdio [--project <path>]` reads the discovery
//!   file and relays newline-delimited JSON-RPC to the server ([`stdio`]), so
//!   persisted client configurations hold no token.
//!
//! The tools themselves come from a [`ToolRegistry`] (the plugin host); this
//! crate knows nothing about plugins.

mod discovery;
mod protocol;
mod server;
pub mod stdio;

pub use discovery::{DISCOVERY_FILE, Discovery, discovery_path};
pub use server::McpServer;

use std::path::{Path, PathBuf};

/// The header naming the project a request is about (an absolute path).
pub const PROJECT_HEADER: &str = "x-openidea-project";
/// The command-line flag that runs the executable as the stdio bridge.
pub const STDIO_FLAG: &str = "--mcp-stdio";

/// A tool as `tools/list` shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// A JSON Schema of the `arguments` object.
    pub input_schema: serde_json::Value,
    /// Only reads (`annotations.readOnlyHint`).
    pub read_only: bool,
    /// May destroy data (`annotations.destructiveHint`).
    pub destructive: bool,
}

/// A failed `tools/call`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolCallError {
    /// No such tool for the project: a protocol error.
    UnknownTool(String),
    /// The tool ran and failed, or couldn't run: a result with `isError`.
    Failed(String),
}

/// Where the tools come from (the plugin host). Calls block; the server runs
/// them off its async threads.
pub trait ToolRegistry: Send + Sync + 'static {
    /// Roots of the projects open in the IDE that the server serves.
    fn projects(&self) -> Vec<PathBuf>;
    /// The tools callable for `project` (one of [`Self::projects`]). `Err`
    /// says why there are none (a project in Restricted Mode).
    fn tools(&self, project: &Path) -> Result<Vec<Tool>, String>;
    /// Runs tool `name` with `arguments` (a JSON object, as text) for `project`.
    fn call(&self, project: &Path, name: &str, arguments: &str) -> Result<String, ToolCallError>;
}

/// The URL of the server at `port` for `project`.
pub fn endpoint_url(port: u16, project: &Path) -> String {
    format!("http://127.0.0.1:{port}/mcp?project={}", encode_query(&project.to_string_lossy()))
}

/// The stdio bridge's command line for `project`: `exe --mcp-stdio --project <project>`.
pub fn stdio_command(exe: &Path, project: &Path) -> Vec<String> {
    vec![
        exe.to_string_lossy().into_owned(),
        STDIO_FLAG.to_owned(),
        "--project".to_owned(),
        project.to_string_lossy().into_owned(),
    ]
}

/// Whether `args` (the process's, program name first) ask for the stdio
/// bridge; then the project it is for (`--project <path>`, `None`: the
/// current directory).
pub fn stdio_request(args: &[String]) -> Option<Option<PathBuf>> {
    let rest = args.get(1..).unwrap_or_default();
    if !rest.iter().any(|a| a == STDIO_FLAG) {
        return None;
    }
    let project = rest
        .iter()
        .position(|a| a == "--project")
        .and_then(|i| rest.get(i + 1))
        .map(PathBuf::from)
        .or_else(|| rest.iter().find_map(|a| a.strip_prefix("--project=").map(PathBuf::from)));
    Some(project)
}

/// Characters escaped in a query value: everything but unreserved characters and `/`.
const QUERY: &percent_encoding::AsciiSet =
    &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~').remove(b'/');

pub(crate) fn encode_query(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, QUERY).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_commands_name_the_project() {
        let url = endpoint_url(4321, Path::new("/home/me/my app/项目"));
        assert_eq!(url, "http://127.0.0.1:4321/mcp?project=/home/me/my%20app/%E9%A1%B9%E7%9B%AE");
        assert_eq!(
            stdio_command(Path::new("/Applications/OpenIDEA.app/Contents/MacOS/openidea"), Path::new("/p")),
            ["/Applications/OpenIDEA.app/Contents/MacOS/openidea", "--mcp-stdio", "--project", "/p"]
        );
    }

    #[test]
    fn stdio_requests_are_recognized() {
        let args = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(stdio_request(&args(&["openidea"])), None);
        assert_eq!(stdio_request(&args(&["openidea", "/some/project"])), None);
        assert_eq!(stdio_request(&args(&["openidea", "--mcp-stdio"])), Some(None));
        assert_eq!(
            stdio_request(&args(&["openidea", "--mcp-stdio", "--project", "/p"])),
            Some(Some(PathBuf::from("/p")))
        );
        assert_eq!(stdio_request(&args(&["openidea", "--project=/q", "--mcp-stdio"])), Some(Some(PathBuf::from("/q"))));
    }
}
