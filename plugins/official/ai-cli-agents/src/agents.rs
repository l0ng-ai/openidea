//! The agents' command lines: how each one is started connected to the IDE's
//! MCP server for this session, and how it is configured to reach it later.
//!
//! The token of this run of the IDE goes only into the terminal's environment
//! ([`TOKEN_ENV`]): command lines are visible to every process of the user
//! (`ps`) and end up in shell history, environment variables are not.
//! Persisted configurations use the IDE's stdio bridge, which needs no token.

use openidea_plugin::{McpEndpoint, TerminalOptions};
use serde_json::json;

/// The MCP server's name in the agents' configurations.
pub const SERVER: &str = "openidea";
/// Environment variable holding the token of the IDE's MCP server.
pub const TOKEN_ENV: &str = "OPENIDEA_MCP_TOKEN";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    /// The program, as its `process:` capability names it.
    pub fn program(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// The setting with the user's extra arguments.
    pub fn args_setting(self) -> &'static str {
        match self {
            Self::Claude => "claudeArgs",
            Self::Codex => "codexArgs",
        }
    }
}

/// Claude Code with the server as an HTTP server of this session only
/// (`--mcp-config`, not saved anywhere). Claude expands `${VAR}` in the
/// headers, so the token stays in the environment. The JSON is the last
/// argument: `--mcp-config` takes every value after it.
pub fn claude(endpoint: &McpEndpoint, extra: &[String]) -> TerminalOptions {
    let config = json!({
        "mcpServers": {
            SERVER: {
                "type": "http",
                "url": endpoint.url,
                "headers": { "Authorization": format!("Bearer ${{{TOKEN_ENV}}}") },
            }
        }
    });
    TerminalOptions::new("Claude Code", "claude")
        .args(extra.iter().cloned())
        .arg("--mcp-config")
        .arg(config.to_string())
        .env(TOKEN_ENV, &endpoint.token)
}

/// Codex with the server as a streamable HTTP server of this session only
/// (`-c` overrides, not saved), reading the token from [`TOKEN_ENV`]. Without
/// `inject` (the user configured a stdio `openidea` server, which Codex refuses
/// to give a URL), the configured server is used as it is.
pub fn codex(endpoint: &McpEndpoint, extra: &[String], inject: bool) -> TerminalOptions {
    let mut options = TerminalOptions::new("Codex", "codex");
    if inject {
        options = options
            .arg("-c")
            .arg(format!("mcp_servers.{SERVER}.url={}", toml_string(&endpoint.url)))
            .arg("-c")
            .arg(format!("mcp_servers.{SERVER}.bearer_token_env_var={}", toml_string(TOKEN_ENV)));
    }
    options.args(extra.iter().cloned()).env(TOKEN_ENV, &endpoint.token)
}

/// The stdio bridge for a configuration outside the project: without
/// `--project`, it serves the project the agent runs in (its working directory).
pub fn bridge_for_any_project(endpoint: &McpEndpoint) -> (String, Vec<String>) {
    let mut command = endpoint.stdio_command.clone();
    if let Some(i) = command.iter().position(|a| a == "--project") {
        command.truncate(i);
    }
    let exe = if command.is_empty() { String::new() } else { command.remove(0) };
    (exe, command)
}

/// `claude mcp add-json` arguments for the stdio bridge in `scope` (`user`, `project`).
pub fn claude_add(endpoint: &McpEndpoint, scope: &str) -> Vec<String> {
    let (command, args) = bridge_for_any_project(endpoint);
    let server = json!({ "type": "stdio", "command": command, "args": args });
    ["mcp", "add-json", "--scope", scope, SERVER].iter().map(|s| (*s).to_owned()).chain([server.to_string()]).collect()
}

pub fn claude_remove(scope: &str) -> Vec<String> {
    ["mcp", "remove", "--scope", scope, SERVER].map(str::to_owned).to_vec()
}

/// `codex mcp add` arguments for the stdio bridge (Codex's global configuration).
pub fn codex_add(endpoint: &McpEndpoint) -> Vec<String> {
    let (command, args) = bridge_for_any_project(endpoint);
    ["mcp", "add", SERVER, "--"].iter().map(|s| (*s).to_owned()).chain([command]).chain(args).collect()
}

pub fn codex_remove() -> Vec<String> {
    ["mcp", "remove", SERVER].map(str::to_owned).to_vec()
}

/// A configuration for any MCP client (`mcpServers`, as Claude Desktop, Cursor
/// and others read it): the stdio bridge for this project, no token.
pub fn client_config(endpoint: &McpEndpoint) -> String {
    let mut command = endpoint.stdio_command.clone();
    let exe = if command.is_empty() { String::new() } else { command.remove(0) };
    let config = json!({ "mcpServers": { SERVER: { "command": exe, "args": command } } });
    serde_json::to_string_pretty(&config).unwrap_or_default()
}

/// A TOML basic string (`-c` values are parsed as TOML).
fn toml_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Splits the extra-arguments setting like a shell would, without expanding
/// anything: whitespace separates, `'…'` and `"…"` quote, `\` escapes.
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"') | None, '\\') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
                started = true;
            }
            (Some(_), c) => current.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started {
                    out.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            (None, c) => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        out.push(current);
    }
    out
}

/// Whether `codex mcp get openidea` describes a stdio server.
pub fn codex_has_stdio_server(output: &str) -> bool {
    output.lines().any(|l| l.trim().strip_prefix("transport:").is_some_and(|t| t.trim() == "stdio"))
}
