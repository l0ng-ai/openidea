// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/DiagnosticsToolset.kt), Apache-2.0.
//! `get_ide_diagnostics`: a cheap snapshot of the IDE for when it or its MCP server behaves
//! oddly. The JetBrains tool samples JVM threads; OpenIDEA has no JVM, so this reports what it
//! has: the server and its sessions, the recent tool calls, the language servers, the project
//! index and recent errors from the log. Experimental, like the JetBrains toolset (which is off
//! unless the IDE starts with `-Didea.diagnostics.mcp.enabled=true`).

use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::IdeResult;
use ide_core::mcp::{McpCallRecord, McpClient, McpToolKind};
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub const GROUP: &str = "general.DiagnosticsToolset";

const DEFAULT_TOOL_CALLS: usize = 50;
const MAX_TOOL_CALLS: usize = crate::history::MAX_CALLS;
const DEFAULT_LOG_LINES: usize = 50;
const MAX_LOG_LINES: usize = 1000;
/// Bytes read from the end of the log file.
const LOG_TAIL_BYTES: u64 = 1 << 20;

pub fn tools() -> Vec<Tool> {
    vec![
        Tool::new(
            "get_ide_diagnostics",
            McpToolKind::Read,
            "Captures cheap diagnostics from the running IDE process.
Use this when the IDE or its MCP server feels slow, stuck or misbehaving and you need the server's state, its sessions and \
clients, the recent MCP tool calls with their outcome, duration, project and changed files, the status of the language servers and of the project \
index, and recent errors and warnings from the IDE log.
The tool is experimental: it is offered only when Settings | Tools | MCP Server turns on experimental tools.",
            get_ide_diagnostics,
        )
        .group(GROUP)
        .experimental()
        .param(Param::optional(
            "maxToolCalls",
            ParamType::Integer,
            "Maximum number of recent tool calls to return, most recent first. Values are clamped to 0..200.",
        ))
        .param(Param::optional(
            "includeLog",
            ParamType::Boolean,
            "Whether to include recent errors and warnings from the IDE log. Defaults to true.",
        ))
        .param(Param::optional(
            "maxLogLines",
            ParamType::Integer,
            "Maximum number of log lines to return. Values are clamped to 0..1000.",
        )),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdeDiagnosticsResult {
    captured_at_epoch_millis: u128,
    ide: IdeInfo,
    server: ServerInfo,
    clients: Vec<McpClient>,
    tool_calls: Vec<McpCallRecord>,
    language_servers: Vec<ide_lsp::types::ServerInfo>,
    index: ide_index::IndexStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    log: Option<LogInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdeInfo {
    full_application_name: String,
    os: &'static str,
    arch: &'static str,
    pid: u32,
    available_processors: usize,
    project_name: String,
    project_base_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    invocation_mode: ide_core::mcp::McpInvocationMode,
    brave_mode: bool,
    active_sessions: usize,
    /// Tools `tools/list` offers.
    listed_tools: usize,
    /// Tools `execute_tool` can call.
    routable_tools: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogInfo {
    file: String,
    /// The last `ERROR` / `WARN` lines, oldest first.
    recent_problems: Vec<String>,
}

async fn get_ide_diagnostics(call: Call) -> IdeResult<Output> {
    let max_calls =
        call.opt_i64("maxToolCalls")?.map_or(DEFAULT_TOOL_CALLS, |n| n.clamp(0, MAX_TOOL_CALLS as i64) as usize);
    let include_log = call.flag("includeLog", true)?;
    let max_lines =
        call.opt_i64("maxLogLines")?.map_or(DEFAULT_LOG_LINES, |n| n.clamp(0, MAX_LOG_LINES as i64) as usize);

    let shared = &call.shared;
    let status = shared.status_snapshot();
    let (invocation_mode, brave_mode) = {
        let config = shared.config.read();
        (config.filter.invocation_mode, config.brave_mode)
    };
    let server = ServerInfo {
        running: status.running,
        url: status.url,
        error: status.error,
        invocation_mode,
        brave_mode,
        active_sessions: shared.sessions.lock().len(),
        listed_tools: shared.enabled_tools().len(),
        routable_tools: shared.routable_tools().len(),
    };
    let host = call.host();
    let mut tool_calls = shared.history.snapshot();
    tool_calls.truncate(max_calls);
    let log = match (include_log, call.ui().log_file()) {
        (true, Some(file)) => {
            Some(LogInfo { recent_problems: recent_log_problems(&file, max_lines), file: file.display().to_string() })
        }
        _ => None,
    };
    let project = call.project();
    Output::json(IdeDiagnosticsResult {
        captured_at_epoch_millis: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        ide: IdeInfo {
            full_application_name: format!("OpenIDEA {}", env!("CARGO_PKG_VERSION")),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            pid: std::process::id(),
            available_processors: std::thread::available_parallelism().map_or(1, |n| n.get()),
            project_name: project.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            project_base_path: project.root.display().to_string(),
        },
        server,
        clients: status.clients,
        tool_calls,
        language_servers: ide_host::ops::lsp::lsp_servers(&host, call.window())?,
        index: ide_host::ops::nav::index_status(&host, call.window())?,
        log,
    })
}

/// The last `max` lines of the log `file` that report an error or a warning (from its last MiB).
pub fn recent_log_problems(file: &Path, max: usize) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(file) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(LOG_TAIL_BYTES);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    if start > 0 {
        lines.next(); // Cut in the middle.
    }
    let problems: Vec<&str> = lines.filter(|l| l.contains(" ERROR ") || l.contains(" WARN ")).collect();
    problems[problems.len().saturating_sub(max)..].iter().map(|l| (*l).to_owned()).collect()
}
