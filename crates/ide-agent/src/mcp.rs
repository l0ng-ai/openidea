//! Model Context Protocol (MCP) server configurations stored in OpenIDEA's own settings
//! (global `settings.toml` and project `.openidea/settings.toml`), passed to ACP agents in
//! `session/new`, `session/load`, and `session/fork`, plus discovery and one-way import from
//! external CLI and workspace MCP configuration files.

use crate::acp::Negotiated;
use crate::{
    AgentMcpServer, McpDiscoveredServer, McpExternalSource, McpImportSelection, McpKeyValue, McpProbeResult, McpScope,
    McpServer, McpServerInput, McpToolSummary, McpTransport,
};
use ide_core::IpcPath;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Reserved server name for OpenIDEA's built-in IDE MCP server in per-session overrides.
pub const BUILTIN_MCP_NAME: &str = "openidea";

const PROBE_TIMEOUT: Duration = Duration::from_secs(12);
const PROBE_PROTOCOL_VERSION: &str = "2024-11-05";

/// Stable ID for a server in a given scope (`"user::<name>"` or `"workspace::<name>"`).
pub fn server_id(scope: McpScope, name: &str) -> String {
    let prefix = match scope {
        McpScope::User => "user",
        McpScope::Workspace => "workspace",
    };
    format!("{prefix}::{name}")
}

/// Parses a server ID (`"user::<name>"` or `"workspace::<name>"`).
pub fn parse_server_id(id: &str) -> Option<(McpScope, &str)> {
    let (prefix, name) = id.split_once("::")?;
    if name.is_empty() {
        return None;
    }
    match prefix {
        "user" => Some((McpScope::User, name)),
        "workspace" => Some((McpScope::Workspace, name)),
        _ => None,
    }
}

/// Converts the User (`settings.toml`) and Workspace (`.openidea/settings.toml`) MCP server maps
/// into the ordered list displayed in Settings › Agents › MCP Servers.
pub fn servers_from_settings(
    user: &BTreeMap<String, AgentMcpServer>,
    workspace: &BTreeMap<String, AgentMcpServer>,
) -> Vec<McpServer> {
    user.iter()
        .map(|(name, cfg)| to_mcp_server(McpScope::User, name, cfg))
        .chain(workspace.iter().map(|(name, cfg)| to_mcp_server(McpScope::Workspace, name, cfg)))
        .collect()
}

fn to_mcp_server(scope: McpScope, name: &str, cfg: &AgentMcpServer) -> McpServer {
    McpServer {
        id: server_id(scope, name),
        name: name.to_owned(),
        scope,
        transport: cfg.transport,
        enabled: cfg.enabled,
        command: cfg.command.clone(),
        args: cfg.args.clone(),
        env: cfg.env.iter().map(|(k, v)| McpKeyValue { name: k.clone(), value: v.clone() }).collect(),
        url: cfg.url.clone(),
        headers: cfg.headers.iter().map(|(k, v)| McpKeyValue { name: k.clone(), value: v.clone() }).collect(),
        agents: cfg.agents.clone(),
        unapproved: false,
    }
}

fn normalize_provider(id: &str) -> &str {
    id.strip_suffix("-acp").unwrap_or(id)
}

fn matches_agent(agents: &[String], provider: &str) -> bool {
    if agents.is_empty() {
        return true;
    }
    let target = normalize_provider(provider);
    agents.iter().any(|a| {
        let trimmed = a.trim();
        trimmed == provider || normalize_provider(trimmed) == target
    })
}

/// The configured servers off for this session: off by default and not switched on for it, or
/// switched off for it. Named so an agent that also loads its own configuration can keep a
/// same-named server of it off too. Workspace entries take precedence, as in [`acp_mcp_servers`].
pub(crate) fn servers_off(all: &[McpServer], provider: &str, overrides: &BTreeMap<String, bool>) -> Vec<String> {
    let mut seen_configured = HashSet::new();
    let mut enabled_names = HashSet::new();
    let mut off = BTreeSet::new();

    let ordered = all
        .iter()
        .filter(|s| s.scope == McpScope::Workspace && !s.unapproved)
        .chain(all.iter().filter(|s| s.scope == McpScope::User));

    for srv in ordered {
        if !seen_configured.insert(srv.name.as_str()) {
            continue;
        }
        let explicit = overrides.get(&srv.name).copied();
        let matches = explicit == Some(true) || matches_agent(&srv.agents, provider);
        let active = explicit.unwrap_or(srv.enabled) && matches;
        if active {
            enabled_names.insert(srv.name.as_str());
        } else {
            off.insert(srv.name.clone());
        }
    }

    for srv in all.iter().filter(|s| s.scope == McpScope::Workspace && s.unapproved) {
        if !enabled_names.contains(srv.name.as_str()) {
            off.insert(srv.name.clone());
        }
    }

    // A server switched off that the IDE doesn't configure may still be the agent's own.
    for (name, &on) in overrides {
        if !on && name.as_str() != BUILTIN_MCP_NAME && !enabled_names.contains(name.as_str()) {
            off.insert(name.clone());
        }
    }

    off.into_iter().collect()
}

/// Names of MCP servers present in Codex's own TOML configuration files (`~/.codex/config.toml`
/// and `<workspace_root>/.codex/config.toml`).
pub(crate) fn codex_external_server_names(home_dir: Option<&Path>, workspace_root: &Path) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let mut paths = Vec::new();
    if let Some(home) = home_dir {
        paths.push(home.join(".codex").join("config.toml"));
    }
    paths.push(workspace_root.join(".codex").join("config.toml"));
    for path in paths {
        if let Ok(text) = std::fs::read_to_string(&path) {
            names.extend(parse_codex_toml_servers(&text).into_keys());
        }
    }
    names
}

/// Builds the ACP `mcpServers` array for `session/new`, `session/load`, and `session/fork`.
/// Workspace entries take precedence over User entries with the same name. Per-session
/// `overrides` (`server_name` -> `enabled`) can enable a disabled server or disable an enabled one
/// for this session only.
pub(crate) fn acp_mcp_servers(
    all: &[McpServer],
    provider: &str,
    init: &Negotiated,
    overrides: &BTreeMap<String, bool>,
) -> Vec<Value> {
    let supports_stdio = init.mcp_stdio();
    let supports_http = init.mcp("http");
    let supports_sse = init.mcp("sse");
    let mut seen = HashSet::new();
    let mut servers = Vec::new();

    let ordered =
        all.iter().filter(|s| s.scope == McpScope::Workspace).chain(all.iter().filter(|s| s.scope == McpScope::User));

    for srv in ordered {
        if srv.unapproved {
            continue;
        }
        let explicit = overrides.get(&srv.name).copied();
        let active = explicit.unwrap_or(srv.enabled);
        if !active || !seen.insert(srv.name.clone()) {
            continue;
        }
        // An explicit per-session enable (`Some(true)`) overrides the server's default agent filter.
        if explicit != Some(true) && !matches_agent(&srv.agents, provider) {
            continue;
        }
        match srv.transport {
            McpTransport::Stdio if supports_stdio => {
                let Some(cmd) = srv.command.as_deref().filter(|c| !c.trim().is_empty()) else {
                    continue;
                };
                let env: Vec<Value> = srv.env.iter().map(|kv| json!({ "name": kv.name, "value": kv.value })).collect();
                servers.push(json!({
                    "name": srv.name,
                    "command": cmd,
                    "args": srv.args,
                    "env": env,
                }));
            }
            McpTransport::Http if supports_http => {
                let Some(url) = srv.url.as_deref().filter(|u| !u.trim().is_empty()) else {
                    continue;
                };
                let headers: Vec<Value> =
                    srv.headers.iter().map(|kv| json!({ "name": kv.name, "value": kv.value })).collect();
                servers.push(json!({
                    "type": "http",
                    "name": srv.name,
                    "url": url,
                    "headers": headers,
                }));
            }
            McpTransport::Sse if supports_sse => {
                let Some(url) = srv.url.as_deref().filter(|u| !u.trim().is_empty()) else {
                    continue;
                };
                let headers: Vec<Value> =
                    srv.headers.iter().map(|kv| json!({ "name": kv.name, "value": kv.value })).collect();
                servers.push(json!({
                    "type": "sse",
                    "name": srv.name,
                    "url": url,
                    "headers": headers,
                }));
            }
            _ => {}
        }
    }

    servers
}

/// Applies a create or update operation to the User / Workspace MCP server maps.
pub fn apply_save(
    user: &mut BTreeMap<String, AgentMcpServer>,
    workspace: &mut BTreeMap<String, AgentMcpServer>,
    has_workspace: bool,
    input: McpServerInput,
) -> Result<(), String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Server name is required".into());
    }
    if input.scope == McpScope::Workspace && !has_workspace {
        return Err("Open a project to configure workspace MCP servers".into());
    }
    let cfg = match input.transport {
        McpTransport::Stdio => {
            let cmd = input.command.as_deref().map(str::trim).unwrap_or_default();
            if cmd.is_empty() {
                return Err("Command is required for stdio MCP servers".into());
            }
            let env = input
                .env
                .into_iter()
                .filter_map(|kv| {
                    let k = kv.name.trim();
                    (!k.is_empty()).then(|| (k.to_owned(), kv.value))
                })
                .collect();
            AgentMcpServer {
                transport: McpTransport::Stdio,
                enabled: input.enabled,
                command: Some(cmd.to_owned()),
                args: input.args,
                env,
                url: None,
                headers: BTreeMap::new(),
                agents: normalize_agents_list(input.agents),
            }
        }
        McpTransport::Http | McpTransport::Sse => {
            let url = input.url.as_deref().map(str::trim).unwrap_or_default();
            if url.is_empty() {
                return Err("URL is required for HTTP/SSE MCP servers".into());
            }
            let headers = input
                .headers
                .into_iter()
                .filter_map(|kv| {
                    let k = kv.name.trim();
                    (!k.is_empty()).then(|| (k.to_owned(), kv.value))
                })
                .collect();
            AgentMcpServer {
                transport: input.transport,
                enabled: input.enabled,
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                url: Some(url.to_owned()),
                headers,
                agents: normalize_agents_list(input.agents),
            }
        }
    };

    if let Some(prev_id) = input.id.as_deref()
        && let Some((prev_scope, prev_name)) = parse_server_id(prev_id)
        && (prev_scope != input.scope || prev_name != name)
    {
        match prev_scope {
            McpScope::User => {
                user.remove(prev_name);
            }
            McpScope::Workspace => {
                workspace.remove(prev_name);
            }
        }
    }

    match input.scope {
        McpScope::User => {
            user.insert(name.to_owned(), cfg);
        }
        McpScope::Workspace => {
            workspace.insert(name.to_owned(), cfg);
        }
    }
    Ok(())
}

/// Enables or disables a User or Workspace MCP server by ID.
pub fn apply_set_enabled(
    user: &mut BTreeMap<String, AgentMcpServer>,
    workspace: &mut BTreeMap<String, AgentMcpServer>,
    id: &str,
    enabled: bool,
) -> Result<McpScope, String> {
    let (scope, name) = parse_server_id(id).ok_or_else(|| format!("MCP server `{id}` not found"))?;
    let map = match scope {
        McpScope::User => user,
        McpScope::Workspace => workspace,
    };
    let srv = map.get_mut(name).ok_or_else(|| format!("MCP server `{name}` not found"))?;
    srv.enabled = enabled;
    Ok(scope)
}

/// Removes a User or Workspace MCP server by ID.
pub fn apply_remove(
    user: &mut BTreeMap<String, AgentMcpServer>,
    workspace: &mut BTreeMap<String, AgentMcpServer>,
    id: &str,
) -> Result<McpScope, String> {
    let (scope, name) = parse_server_id(id).ok_or_else(|| format!("MCP server `{id}` not found"))?;
    let map = match scope {
        McpScope::User => user,
        McpScope::Workspace => workspace,
    };
    if map.remove(name).is_none() {
        return Err(format!("MCP server `{name}` not found"));
    }
    Ok(scope)
}

/// Imports MCP servers from `<workspace_root>/.mcp.json` and `<workspace_root>/.vscode/mcp.json`
/// into `workspace` without modifying the external files. Returns the number of newly added servers.
pub fn apply_import(workspace: &mut BTreeMap<String, AgentMcpServer>, workspace_root: &Path) -> usize {
    let mut added = 0;
    for rel in [".mcp.json", ".vscode/mcp.json"] {
        let path = workspace_root.join(rel);
        for (name, srv) in read_external_file(&path) {
            if let std::collections::btree_map::Entry::Vacant(e) = workspace.entry(name) {
                e.insert(srv);
                added += 1;
            }
        }
    }
    added
}

/// Parses a raw MCP JSON snippet pasted by the user and merges its servers into `user` or
/// `workspace`. Supports `{"mcpServers": {...}}`, `{"servers": {...}}`, top-level server maps
/// (`{"my-server": {"command": ...}}`), and single-server objects when `fallback_name` is given.
pub fn apply_save_json(
    user: &mut BTreeMap<String, AgentMcpServer>,
    workspace: &mut BTreeMap<String, AgentMcpServer>,
    has_workspace: bool,
    scope: McpScope,
    raw_json: &str,
    fallback_name: Option<&str>,
    agents: Vec<String>,
) -> Result<Vec<String>, String> {
    if scope == McpScope::Workspace && !has_workspace {
        return Err("Open a project to configure workspace MCP servers".into());
    }
    let parsed = parse_mcp_json_text(raw_json, fallback_name)?;
    if parsed.is_empty() {
        return Err("No valid MCP servers found in JSON".into());
    }
    let normalized_agents = normalize_agents_list(agents);
    let target = match scope {
        McpScope::User => user,
        McpScope::Workspace => workspace,
    };
    let mut saved_names = Vec::with_capacity(parsed.len());
    for (name, mut srv) in parsed {
        if srv.agents.is_empty() && !normalized_agents.is_empty() {
            srv.agents = normalized_agents.clone();
        }
        saved_names.push(name.clone());
        target.insert(name, srv);
    }
    Ok(saved_names)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceFormat {
    Jsonc,
    CodexToml,
}

#[derive(Clone)]
struct SourceSpec {
    id: &'static str,
    label: &'static str,
    path: PathBuf,
    format: SourceFormat,
    suggested_scope: McpScope,
    native_provider: Option<&'static str>,
    claude_project_lookup: bool,
}

fn external_source_specs(home_dir: Option<&Path>, workspace_root: Option<&Path>) -> Vec<SourceSpec> {
    let mut specs = Vec::new();
    if let Some(root) = workspace_root {
        specs.push(SourceSpec {
            id: "workspace-mcp",
            label: "Project (.mcp.json)",
            path: root.join(".mcp.json"),
            format: SourceFormat::Jsonc,
            suggested_scope: McpScope::Workspace,
            native_provider: Some("claude"),
            claude_project_lookup: false,
        });
        specs.push(SourceSpec {
            id: "vscode-mcp",
            label: "VS Code (.vscode/mcp.json)",
            path: root.join(".vscode").join("mcp.json"),
            format: SourceFormat::Jsonc,
            suggested_scope: McpScope::Workspace,
            native_provider: None,
            claude_project_lookup: false,
        });
        specs.push(SourceSpec {
            id: "cursor-project",
            label: "Cursor Project (.cursor/mcp.json)",
            path: root.join(".cursor").join("mcp.json"),
            format: SourceFormat::Jsonc,
            suggested_scope: McpScope::Workspace,
            native_provider: Some("cursor"),
            claude_project_lookup: false,
        });
        specs.push(SourceSpec {
            id: "codex-project",
            label: "Codex Project (.codex/config.toml)",
            path: root.join(".codex").join("config.toml"),
            format: SourceFormat::CodexToml,
            suggested_scope: McpScope::Workspace,
            native_provider: Some("codex"),
            claude_project_lookup: false,
        });
        specs.push(SourceSpec {
            id: "gemini-project",
            label: "Gemini Project (.gemini/settings.json)",
            path: root.join(".gemini").join("settings.json"),
            format: SourceFormat::Jsonc,
            suggested_scope: McpScope::Workspace,
            native_provider: Some("gemini"),
            claude_project_lookup: false,
        });
    }
    if let Some(home) = home_dir {
        specs.push(SourceSpec {
            id: "copilot-cli",
            label: "GitHub Copilot CLI",
            path: home.join(".copilot").join("mcp-config.json"),
            format: SourceFormat::Jsonc,
            suggested_scope: McpScope::User,
            native_provider: Some("copilot"),
            claude_project_lookup: false,
        });
        specs.push(SourceSpec {
            id: "claude-code",
            label: "Claude Code",
            path: home.join(".claude.json"),
            format: SourceFormat::Jsonc,
            suggested_scope: McpScope::User,
            native_provider: Some("claude"),
            claude_project_lookup: true,
        });
        specs.push(SourceSpec {
            id: "codex",
            label: "Codex",
            path: home.join(".codex").join("config.toml"),
            format: SourceFormat::CodexToml,
            suggested_scope: McpScope::User,
            native_provider: Some("codex"),
            claude_project_lookup: false,
        });
        specs.push(SourceSpec {
            id: "cursor",
            label: "Cursor",
            path: home.join(".cursor").join("mcp.json"),
            format: SourceFormat::Jsonc,
            suggested_scope: McpScope::User,
            native_provider: Some("cursor"),
            claude_project_lookup: false,
        });
        specs.push(SourceSpec {
            id: "gemini",
            label: "Gemini CLI",
            path: home.join(".gemini").join("settings.json"),
            format: SourceFormat::Jsonc,
            suggested_scope: McpScope::User,
            native_provider: Some("gemini"),
            claude_project_lookup: false,
        });
        specs.push(SourceSpec {
            id: "jetbrains-air",
            label: "JetBrains Air",
            path: home.join(".jetbrains").join("mcp").join("mcp.json"),
            format: SourceFormat::Jsonc,
            suggested_scope: McpScope::User,
            native_provider: None,
            claude_project_lookup: false,
        });
        specs.push(SourceSpec {
            id: "copilot-intellij",
            label: "GitHub Copilot (JetBrains)",
            path: home.join(".config").join("github-copilot").join("intellij").join("mcp.json"),
            format: SourceFormat::Jsonc,
            suggested_scope: McpScope::User,
            native_provider: None,
            claude_project_lookup: false,
        });
    }
    specs
}

fn read_source_servers(spec: &SourceSpec, workspace_root: Option<&Path>) -> BTreeMap<String, AgentMcpServer> {
    let Ok(text) = std::fs::read_to_string(&spec.path) else {
        return BTreeMap::new();
    };
    if spec.format == SourceFormat::CodexToml {
        return parse_codex_toml_servers(&text);
    }
    let Ok(root) = parse_jsonc_value(&text) else {
        return BTreeMap::new();
    };
    let mut servers = extract_servers_from_root(&root, None);
    if spec.claude_project_lookup
        && let Some(ws) = workspace_root
        && let Some(projects) = root.get("projects").and_then(Value::as_object)
    {
        let ws_canon = dunce::canonicalize(ws).unwrap_or_else(|_| ws.to_path_buf());
        for (proj_key, proj_val) in projects {
            let matches = Path::new(proj_key) == ws || dunce::canonicalize(proj_key).is_ok_and(|c| c == ws_canon);
            if matches {
                for (name, srv) in extract_servers_from_root(proj_val, None) {
                    servers.insert(name, srv);
                }
            }
        }
    }
    servers
}

fn parse_codex_toml_servers(text: &str) -> BTreeMap<String, AgentMcpServer> {
    let Ok(doc) = toml::from_str::<toml::Value>(text) else {
        return BTreeMap::new();
    };
    let Ok(json_doc) = serde_json::to_value(doc) else {
        return BTreeMap::new();
    };
    let Some(table) = json_doc.get("mcp_servers").or_else(|| json_doc.get("mcpServers")).and_then(Value::as_object)
    else {
        return BTreeMap::new();
    };
    let mut out = BTreeMap::new();
    for (name, raw) in table {
        let name = name.trim();
        let Some(mut obj) = raw.as_object().cloned().filter(|_| !name.is_empty()) else {
            continue;
        };
        if !obj.contains_key("headers")
            && let Some(http_headers) = obj.remove("http_headers")
        {
            obj.insert("headers".to_owned(), http_headers);
        }
        if let Some(srv) = parse_one_server_def(&obj) {
            out.insert(name.to_owned(), srv);
        }
    }
    out
}

/// Discovers external MCP configuration files on disk (without exposing secret values).
pub fn discover_external_sources(home_dir: Option<&Path>, workspace_root: Option<&Path>) -> Vec<McpExternalSource> {
    let mut out = Vec::new();
    for spec in external_source_specs(home_dir, workspace_root) {
        let map = read_source_servers(&spec, workspace_root);
        if map.is_empty() {
            continue;
        }
        let servers = map
            .into_iter()
            .map(|(name, cfg)| McpDiscoveredServer {
                name,
                transport: cfg.transport,
                enabled: cfg.enabled,
                command: cfg.command,
                args: cfg.args,
                url: cfg.url,
                env_keys: cfg.env.into_keys().collect(),
                header_keys: cfg.headers.into_keys().collect(),
            })
            .collect();
        out.push(McpExternalSource {
            id: spec.id.to_owned(),
            label: spec.label.to_owned(),
            path: IpcPath(spec.path),
            suggested_scope: spec.suggested_scope,
            native_provider: spec.native_provider.map(str::to_owned),
            servers,
        });
    }
    out
}

/// Imports selected `(source_id, name)` entries from discovered external MCP config files into
/// `user` or `workspace` without modifying the external files. Returns imported server names.
pub fn apply_import_selected(
    user: &mut BTreeMap<String, AgentMcpServer>,
    workspace: &mut BTreeMap<String, AgentMcpServer>,
    home_dir: Option<&Path>,
    workspace_root: Option<&Path>,
    scope: McpScope,
    selections: &[McpImportSelection],
    overwrite: bool,
) -> Result<Vec<String>, String> {
    if scope == McpScope::Workspace && workspace_root.is_none() {
        return Err("Open a project to import workspace MCP servers".into());
    }
    let specs = external_source_specs(home_dir, workspace_root);
    let mut by_source: BTreeMap<&str, BTreeMap<String, AgentMcpServer>> = BTreeMap::new();
    for spec in &specs {
        if selections.iter().any(|s| s.source_id == spec.id) {
            by_source.insert(spec.id, read_source_servers(spec, workspace_root));
        }
    }
    let target = match scope {
        McpScope::User => user,
        McpScope::Workspace => workspace,
    };
    let mut imported = Vec::new();
    for sel in selections {
        let Some(source_map) = by_source.get(sel.source_id.as_str()) else {
            continue;
        };
        let Some(srv) = source_map.get(&sel.name) else {
            continue;
        };
        if overwrite || !target.contains_key(&sel.name) {
            target.insert(sel.name.clone(), srv.clone());
            imported.push(sel.name.clone());
        }
    }
    Ok(imported)
}

fn normalize_agents_list(agents: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for a in agents {
        let trimmed = a.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing: &String| existing == trimmed) {
            out.push(trimmed.to_owned());
        }
    }
    out
}

/// Strips `//` line comments, `/* ... */` block comments, and trailing commas before `}` or `]`
/// outside JSON string literals so JSONC config files parse cleanly with `serde_json`.
pub(crate) fn strip_jsonc(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut in_str = false;
    while i < bytes.len() {
        if in_str {
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            if ch == '\\' && i < bytes.len() {
                let next = input[i..].chars().next().unwrap();
                out.push(next);
                i += next.len_utf8();
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        if bytes[i] == b'"' {
            in_str = true;
            out.push('"');
            i += 1;
            continue;
        }
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                if bytes[i] == b'\n' {
                    out.push('\n');
                    i += 1;
                } else {
                    let ch = input[i..].chars().next().unwrap();
                    i += ch.len_utf8();
                }
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    remove_trailing_commas(&out)
}

fn remove_trailing_commas(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut in_str = false;
    while i < bytes.len() {
        if in_str {
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            if ch == '\\' && i < bytes.len() {
                let next = input[i..].chars().next().unwrap();
                out.push(next);
                i += next.len_utf8();
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        if bytes[i] == b'"' {
            in_str = true;
            out.push('"');
            i += 1;
            continue;
        }
        if bytes[i] == b',' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == b'}' || bytes[j] == b']') {
                i += 1;
                continue;
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn parse_jsonc_value(raw: &str) -> Result<Value, String> {
    let trimmed = raw.trim().trim_start_matches('\u{feff}');
    serde_json::from_str::<Value>(trimmed)
        .or_else(|_| serde_json::from_str::<Value>(&strip_jsonc(trimmed)))
        .map_err(|e| format!("Invalid JSON: {e}"))
}

pub fn parse_mcp_json_text(raw: &str, fallback_name: Option<&str>) -> Result<BTreeMap<String, AgentMcpServer>, String> {
    let root = parse_jsonc_value(raw)?;
    Ok(extract_servers_from_root(&root, fallback_name))
}

fn is_server_def_object(obj: &serde_json::Map<String, Value>) -> bool {
    obj.get("command").and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
        || obj.get("url").and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
        || obj.get("serverUrl").and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
}

fn parse_one_server_def(obj: &serde_json::Map<String, Value>) -> Option<AgentMcpServer> {
    let disabled = obj.get("disabled").and_then(Value::as_bool).unwrap_or(false)
        || obj.get("enabled").and_then(Value::as_bool) == Some(false);
    let type_str = obj.get("type").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    let url = obj
        .get("url")
        .or_else(|| obj.get("serverUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let command =
        obj.get("command").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);

    let transport = match type_str.as_str() {
        "sse" => McpTransport::Sse,
        "http" | "streamable-http" | "streamable_http" => McpTransport::Http,
        "stdio" | "local" => McpTransport::Stdio,
        _ if url.is_some() && command.is_none() => McpTransport::Http,
        _ => McpTransport::Stdio,
    };

    match transport {
        McpTransport::Stdio => command.as_ref()?,
        McpTransport::Http | McpTransport::Sse => url.as_ref()?,
    };

    let args = obj
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();

    let agents = obj
        .get("agents")
        .and_then(Value::as_array)
        .map(|arr| normalize_agents_list(arr.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()))
        .unwrap_or_default();

    Some(AgentMcpServer {
        transport,
        enabled: !disabled,
        command,
        args,
        env: parse_key_values_map(obj.get("env")),
        url,
        headers: parse_key_values_map(obj.get("headers")),
        agents,
    })
}

fn extract_servers_from_root(root: &Value, fallback_name: Option<&str>) -> BTreeMap<String, AgentMcpServer> {
    let mut out = BTreeMap::new();
    let Some(root_obj) = root.as_object() else {
        return out;
    };

    // Single server definition object pasted directly (`{"command": "npx", ...}`).
    if is_server_def_object(root_obj) {
        let name = root_obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| fallback_name.map(str::trim).filter(|s| !s.is_empty()));
        if let (Some(name), Some(srv)) = (name, parse_one_server_def(root_obj)) {
            out.insert(name.to_owned(), srv);
        }
        return out;
    }

    let servers_obj =
        root_obj.get("mcpServers").or_else(|| root_obj.get("servers")).and_then(Value::as_object).unwrap_or(root_obj);

    for (name, def) in servers_obj {
        let name = name.trim();
        if name.is_empty() || matches!(name, "$schema" | "inputs" | "version") {
            continue;
        }
        let Some(obj) = def.as_object() else {
            continue;
        };
        if !is_server_def_object(obj) {
            continue;
        }
        if let Some(srv) = parse_one_server_def(obj) {
            out.insert(name.to_owned(), srv);
        }
    }
    out
}

fn read_external_file(path: &Path) -> BTreeMap<String, AgentMcpServer> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(root) = parse_jsonc_value(&text) else {
        return BTreeMap::new();
    };
    extract_servers_from_root(&root, None)
}

/// Probes a stdio MCP server by launching its command, performing the MCP `initialize` handshake,
/// and requesting `tools/list`. For HTTP/SSE servers, use `ide-host`'s HTTP probe helper.
pub async fn probe_stdio_server(server: &AgentMcpServer, cwd: &Path) -> McpProbeResult {
    let started = Instant::now();
    let elapsed_ms = || u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    let Some(raw_cmd) = server.command.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return McpProbeResult {
            ok: false,
            server_name: None,
            server_version: None,
            protocol_version: None,
            tools: Vec::new(),
            duration_ms: elapsed_ms(),
            error: Some("Command is empty".into()),
        };
    };

    let mut env: Vec<(String, String)> = ide_core::process::shell_env()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        .collect();
    for (k, v) in &server.env {
        if let Some((_, existing)) = env.iter_mut().find(|(ek, _)| ek == k) {
            *existing = v.clone();
        } else {
            env.push((k.clone(), v.clone()));
        }
    }
    let search_path = env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| std::ffi::OsString::from(v))
        .or_else(|| ide_core::process::host_var_os("PATH"))
        .unwrap_or_default();
    let program = ide_core::process::find_executable(raw_cmd, &search_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw_cmd.to_owned());

    let stderr_lines = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let stderr_capture = stderr_lines.clone();
    let on_stderr: Box<dyn Fn(String) + Send + Sync> = Box::new(move |line| {
        let mut guard = stderr_capture.lock();
        if guard.len() < 12 && !line.trim().is_empty() {
            guard.push(line);
        }
    });

    let peer = match ide_jsonrpc::Peer::spawn_framed(
        &program,
        &server.args,
        cwd,
        &env,
        std::sync::Arc::new(ide_jsonrpc::NoopHandler),
        on_stderr,
        ide_jsonrpc::Framing::Lines,
    ) {
        Ok(peer) => peer,
        Err(e) => {
            return McpProbeResult {
                ok: false,
                server_name: None,
                server_version: None,
                protocol_version: None,
                tools: Vec::new(),
                duration_ms: elapsed_ms(),
                error: Some(format!("Failed to launch `{raw_cmd}`: {e}")),
            };
        }
    };

    let outcome = tokio::time::timeout(PROBE_TIMEOUT, async {
        let init: Value = peer
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROBE_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": crate::client_info(),
                }),
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
        let _ = peer.notify("notifications/initialized", json!({}));
        let tools_reply: Value = peer.request("tools/list", json!({}), None).await.unwrap_or_else(|_| json!({}));
        Ok::<(Value, Value), String>((init, tools_reply))
    })
    .await;

    peer.kill();

    match outcome {
        Ok(Ok((init, tools_reply))) => parse_probe_payloads(&init, &tools_reply, elapsed_ms()),
        Ok(Err(err)) => {
            let tail = stderr_lines.lock().join("\n");
            let error = if tail.is_empty() { err } else { format!("{err}\n{tail}") };
            McpProbeResult {
                ok: false,
                server_name: None,
                server_version: None,
                protocol_version: None,
                tools: Vec::new(),
                duration_ms: elapsed_ms(),
                error: Some(error),
            }
        }
        Err(_) => {
            let tail = stderr_lines.lock().join("\n");
            let error = if tail.is_empty() {
                format!("Timed out after {}s waiting for MCP handshake", PROBE_TIMEOUT.as_secs())
            } else {
                format!("Timed out after {}s waiting for MCP handshake:\n{tail}", PROBE_TIMEOUT.as_secs())
            };
            McpProbeResult {
                ok: false,
                server_name: None,
                server_version: None,
                protocol_version: None,
                tools: Vec::new(),
                duration_ms: elapsed_ms(),
                error: Some(error),
            }
        }
    }
}

pub fn parse_probe_payloads(init: &Value, tools_reply: &Value, duration_ms: u32) -> McpProbeResult {
    let server_name = init.pointer("/serverInfo/name").and_then(Value::as_str).map(str::to_owned);
    let server_version = init.pointer("/serverInfo/version").and_then(Value::as_str).map(str::to_owned);
    let protocol_version = init.get("protocolVersion").and_then(Value::as_str).map(str::to_owned);
    let tools = tools_reply
        .get("tools")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let name = t.get("name")?.as_str()?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    let description = t
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                    Some(McpToolSummary { name: name.to_owned(), description })
                })
                .collect()
        })
        .unwrap_or_default();
    McpProbeResult { ok: true, server_name, server_version, protocol_version, tools, duration_ms, error: None }
}

fn parse_key_values_map(val: Option<&Value>) -> BTreeMap<String, String> {
    match val {
        Some(Value::Object(map)) => map
            .iter()
            .filter_map(|(k, v)| {
                let s = match v {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    _ => return None,
                };
                Some((k.clone(), s))
            })
            .collect(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|item| {
                let obj = item.as_object()?;
                let name = obj.get("name")?.as_str()?.to_owned();
                let value = obj.get("value")?.as_str()?.to_owned();
                Some((name, value))
            })
            .collect(),
        _ => BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured(name: &str, scope: McpScope, enabled: bool) -> McpServer {
        McpServer {
            id: format!("{scope:?}:{name}"),
            name: name.into(),
            scope,
            transport: McpTransport::Stdio,
            enabled,
            command: Some("x".into()),
            args: Vec::new(),
            env: Vec::new(),
            url: None,
            headers: Vec::new(),
            agents: Vec::new(),
            unapproved: false,
        }
    }

    #[test]
    fn servers_off_follow_the_effective_state() {
        let mut claude_only = configured("claude-only", McpScope::User, true);
        claude_only.agents = vec!["claude".into()];
        let mut unapproved_ws = configured("unapproved-ws", McpScope::Workspace, false);
        unapproved_ws.unapproved = true;

        let all = [
            configured("default-off", McpScope::User, false),
            configured("switched-on", McpScope::User, false),
            configured("on", McpScope::User, true),
            configured("switched-off", McpScope::User, true),
            // The workspace entry decides for its name.
            configured("both", McpScope::User, true),
            configured("both", McpScope::Workspace, false),
            claude_only,
            unapproved_ws,
        ];
        let overrides = BTreeMap::from([
            ("switched-on".to_owned(), true),
            ("switched-off".to_owned(), false),
            ("agent-own".to_owned(), false),
            (BUILTIN_MCP_NAME.to_owned(), false),
        ]);
        assert_eq!(
            servers_off(&all, "copilot", &overrides),
            ["agent-own", "both", "claude-only", "default-off", "switched-off", "unapproved-ws"]
        );
        assert_eq!(servers_off(&all[2..4], "copilot", &BTreeMap::new()), Vec::<String>::new());
    }

    #[test]
    fn crud_and_acp_filtering_by_scope_agent_and_transport() {
        let mut user = BTreeMap::new();
        let mut workspace = BTreeMap::new();

        apply_save(
            &mut user,
            &mut workspace,
            true,
            McpServerInput {
                id: None,
                name: "shared".into(),
                scope: McpScope::User,
                transport: McpTransport::Stdio,
                enabled: true,
                command: Some("npx".into()),
                args: vec!["-y".into(), "user-pkg".into()],
                env: vec![McpKeyValue { name: "TOKEN".into(), value: "u1".into() }],
                url: None,
                headers: Vec::new(),
                agents: Vec::new(),
            },
        )
        .unwrap();

        apply_save(
            &mut user,
            &mut workspace,
            true,
            McpServerInput {
                id: None,
                name: "shared".into(),
                scope: McpScope::Workspace,
                transport: McpTransport::Stdio,
                enabled: true,
                command: Some("npx".into()),
                args: vec!["-y".into(), "workspace-pkg".into()],
                env: Vec::new(),
                url: None,
                headers: Vec::new(),
                agents: Vec::new(),
            },
        )
        .unwrap();

        apply_save(
            &mut user,
            &mut workspace,
            true,
            McpServerInput {
                id: None,
                name: "claude-http".into(),
                scope: McpScope::User,
                transport: McpTransport::Http,
                enabled: true,
                command: None,
                args: Vec::new(),
                env: Vec::new(),
                url: Some("https://example.com/mcp".into()),
                headers: vec![McpKeyValue { name: "Authorization".into(), value: "Bearer secret".into() }],
                agents: vec!["claude".into()],
            },
        )
        .unwrap();

        let list = servers_from_settings(&user, &workspace);
        assert_eq!(list.len(), 3);

        // Negotiated with HTTP support: `claude` gets workspace `shared` + `claude-http`; `codex` only gets `shared`.
        let init_http = Negotiated::from_initialize(&json!({
            "agentCapabilities": { "mcpCapabilities": { "http": true, "sse": false } }
        }));
        let empty_overrides = BTreeMap::new();
        let claude_servers = acp_mcp_servers(&list, "claude-acp", &init_http, &empty_overrides);
        assert_eq!(claude_servers.len(), 2);
        assert_eq!(claude_servers[0]["name"], "shared");
        assert_eq!(claude_servers[0]["args"], json!(["-y", "workspace-pkg"]));
        assert_eq!(claude_servers[1]["name"], "claude-http");
        assert_eq!(claude_servers[1]["type"], "http");

        let codex_servers = acp_mcp_servers(&list, "codex", &init_http, &empty_overrides);
        assert_eq!(codex_servers.len(), 1);
        assert_eq!(codex_servers[0]["name"], "shared");

        // Per-session overrides can disable an enabled server or enable an agent-scoped server.
        let overrides = BTreeMap::from([("shared".to_owned(), false), ("claude-http".to_owned(), true)]);
        let codex_overridden = acp_mcp_servers(&list, "codex", &init_http, &overrides);
        assert_eq!(codex_overridden.len(), 1);
        assert_eq!(codex_overridden[0]["name"], "claude-http");

        // Disable workspace `shared` and remove user `claude-http`.
        apply_set_enabled(&mut user, &mut workspace, "workspace::shared", false).unwrap();
        apply_remove(&mut user, &mut workspace, "user::claude-http").unwrap();
        let list = servers_from_settings(&user, &workspace);
        let after = acp_mcp_servers(&list, "claude", &init_http, &empty_overrides);
        assert_eq!(after.len(), 1);
        assert_eq!(after[0]["args"], json!(["-y", "user-pkg"]));
    }

    #[test]
    fn imports_from_mcp_json_and_vscode_mcp_json_without_modifying_them() {
        let tmp = tempfile::tempdir().unwrap();
        let mcp_json = tmp.path().join(".mcp.json");
        let vscode_dir = tmp.path().join(".vscode");
        std::fs::create_dir_all(&vscode_dir).unwrap();
        let vscode_mcp = vscode_dir.join("mcp.json");

        let raw_mcp = r#"{"mcpServers":{"sqlite":{"command":"uvx","args":["mcp-server-sqlite"]}}}"#;
        let raw_vscode = r#"{"servers":{"remote":{"type":"http","url":"https://mcp.example.com"}}}"#;
        std::fs::write(&mcp_json, raw_mcp).unwrap();
        std::fs::write(&vscode_mcp, raw_vscode).unwrap();

        let mut workspace = BTreeMap::new();
        let added = apply_import(&mut workspace, tmp.path());
        assert_eq!(added, 2);
        assert_eq!(workspace["sqlite"].command.as_deref(), Some("uvx"));
        assert_eq!(workspace["remote"].transport, McpTransport::Http);
        assert_eq!(workspace["remote"].url.as_deref(), Some("https://mcp.example.com"));

        // Re-importing does not duplicate or overwrite existing entries, and leaves files untouched.
        workspace.get_mut("sqlite").unwrap().enabled = false;
        assert_eq!(apply_import(&mut workspace, tmp.path()), 0);
        assert!(!workspace["sqlite"].enabled);
        assert_eq!(std::fs::read_to_string(&mcp_json).unwrap(), raw_mcp);
        assert_eq!(std::fs::read_to_string(&vscode_mcp).unwrap(), raw_vscode);
    }

    #[test]
    fn discovers_cli_sources_top_level_maps_and_jsonc_and_imports_selected() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let proj = tmp.path().join("project");
        std::fs::create_dir_all(home.join(".copilot")).unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(home.join(".gemini")).unwrap();
        std::fs::create_dir_all(home.join(".jetbrains").join("mcp")).unwrap();
        std::fs::create_dir_all(home.join(".config").join("github-copilot").join("intellij")).unwrap();
        std::fs::create_dir_all(&proj).unwrap();

        std::fs::write(
            home.join(".copilot").join("mcp-config.json"),
            r#"{"mcpServers":{"github":{"type":"http","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer tok"}},"slack":{"type":"local","command":"npx","args":["-y","slack-mcp"],"env":{"SLACK_TOKEN":"xoxb"}}}}"#,
        )
        .unwrap();

        // Codex `~/.codex/config.toml` `[mcp_servers]` format.
        std::fs::write(
            home.join(".codex").join("config.toml"),
            "[mcp_servers.postgres]\ncommand = \"npx\"\nargs = [\"-y\", \"@modelcontextprotocol/server-postgres\"]\n\n[mcp_servers.remote_api]\nurl = \"https://mcp.example.com/sse\"\ntype = \"sse\"\nhttp_headers = { Authorization = \"Bearer codex-tok\" }\n",
        )
        .unwrap();

        // Gemini `~/.gemini/settings.json` with unrelated top-level settings alongside `mcpServers`.
        std::fs::write(
            home.join(".gemini").join("settings.json"),
            r#"{"theme":"Default","mcpServers":{"fetch":{"command":"uvx","args":["mcp-server-fetch"]}}}"#,
        )
        .unwrap();

        // JetBrains Air top-level server map (not nested under `mcpServers`).
        std::fs::write(
            home.join(".jetbrains").join("mcp").join("mcp.json"),
            r#"{"linear":{"type":"stdio","command":"npx","args":["-y","mcp-remote","https://mcp.linear.app/mcp"]}}"#,
        )
        .unwrap();

        // JSONC comments + trailing commas.
        std::fs::write(
            home.join(".config").join("github-copilot").join("intellij").join("mcp.json"),
            "// comment with https://url/inside\n{\n  /* block comment */\n  \"servers\": {\n    \"docs\": { \"command\": \"uvx\", \"args\": [\"docs-mcp\",], },\n  },\n}\n",
        )
        .unwrap();

        let sources = discover_external_sources(Some(&home), Some(&proj));
        assert_eq!(sources.len(), 5);
        let copilot = sources.iter().find(|s| s.id == "copilot-cli").unwrap();
        assert_eq!(copilot.native_provider.as_deref(), Some("copilot"));
        assert_eq!(copilot.servers.len(), 2);
        let gh_srv = copilot.servers.iter().find(|s| s.name == "github").unwrap();
        assert_eq!(gh_srv.header_keys, vec!["Authorization".to_string()]);

        let codex = sources.iter().find(|s| s.id == "codex").unwrap();
        assert_eq!(codex.native_provider.as_deref(), Some("codex"));
        assert_eq!(codex.servers.len(), 2);

        let gemini = sources.iter().find(|s| s.id == "gemini").unwrap();
        assert_eq!(gemini.servers[0].name, "fetch");

        let air = sources.iter().find(|s| s.id == "jetbrains-air").unwrap();
        assert_eq!(air.servers[0].name, "linear");

        let ij = sources.iter().find(|s| s.id == "copilot-intellij").unwrap();
        assert_eq!(ij.servers[0].name, "docs");

        let mut user = BTreeMap::new();
        let mut workspace = BTreeMap::new();
        let imported = apply_import_selected(
            &mut user,
            &mut workspace,
            Some(&home),
            Some(&proj),
            McpScope::User,
            &[
                McpImportSelection { source_id: "copilot-cli".into(), name: "github".into() },
                McpImportSelection { source_id: "jetbrains-air".into(), name: "linear".into() },
            ],
            false,
        )
        .unwrap();
        assert_eq!(imported, vec!["github".to_string(), "linear".to_string()]);
        assert_eq!(user["github"].headers.get("Authorization").map(String::as_str), Some("Bearer tok"));
        assert_eq!(user["linear"].command.as_deref(), Some("npx"));
    }

    #[test]
    fn apply_save_json_accepts_mcp_servers_map_and_single_server_object() {
        let mut user = BTreeMap::new();
        let mut workspace = BTreeMap::new();

        let names = apply_save_json(
            &mut user,
            &mut workspace,
            true,
            McpScope::User,
            r#"{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}"#,
            None,
            vec!["copilot".into(), "claude".into()],
        )
        .unwrap();
        assert_eq!(names, vec!["playwright".to_string()]);
        assert_eq!(user["playwright"].agents, vec!["copilot".to_string(), "claude".to_string()]);

        let single = apply_save_json(
            &mut user,
            &mut workspace,
            true,
            McpScope::Workspace,
            r#"{"type":"sse","serverUrl":"https://sse.example.com/events"}"#,
            Some("events-sse"),
            Vec::new(),
        )
        .unwrap();
        assert_eq!(single, vec!["events-sse".to_string()]);
        assert_eq!(workspace["events-sse"].transport, McpTransport::Sse);
        assert_eq!(workspace["events-sse"].url.as_deref(), Some("https://sse.example.com/events"));
    }
}
