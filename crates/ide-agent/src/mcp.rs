//! Model Context Protocol (MCP) server configurations stored in OpenIDEA's own settings
//! (global `settings.toml` and project `.openidea/settings.toml`), passed to ACP agents in
//! `session/new`, `session/load`, and `session/fork`, plus one-way import from `.mcp.json` /
//! `.vscode/mcp.json`.

use crate::acp::Negotiated;
use crate::{AgentMcpServer, McpKeyValue, McpScope, McpServer, McpServerInput, McpTransport};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

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

/// Builds the ACP `mcpServers` array for `session/new`, `session/load`, and `session/fork`.
/// Workspace entries take precedence over User entries with the same name.
pub(crate) fn acp_mcp_servers(all: &[McpServer], provider: &str, init: &Negotiated) -> Vec<Value> {
    let supports_stdio = init.mcp_stdio();
    let supports_http = init.mcp("http");
    let supports_sse = init.mcp("sse");
    let mut seen = HashSet::new();
    let mut servers = Vec::new();

    let ordered =
        all.iter().filter(|s| s.scope == McpScope::Workspace).chain(all.iter().filter(|s| s.scope == McpScope::User));

    for srv in ordered {
        if !srv.enabled || !matches_agent(&srv.agents, provider) || !seen.insert(srv.name.clone()) {
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

fn read_external_file(path: &Path) -> BTreeMap<String, AgentMcpServer> {
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    let Ok(root) = serde_json::from_slice::<Value>(&bytes) else {
        return BTreeMap::new();
    };
    let Some(servers_obj) = root.get("mcpServers").or_else(|| root.get("servers")).and_then(Value::as_object) else {
        return BTreeMap::new();
    };

    let mut out = BTreeMap::new();
    for (name, def) in servers_obj {
        let name = name.trim();
        let Some(obj) = def.as_object().filter(|_| !name.is_empty()) else {
            continue;
        };
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
            McpTransport::Stdio if command.is_none() => continue,
            McpTransport::Http | McpTransport::Sse if url.is_none() => continue,
            _ => {}
        }

        let args = obj
            .get("args")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();

        out.insert(
            name.to_owned(),
            AgentMcpServer {
                transport,
                enabled: !disabled,
                command,
                args,
                env: parse_key_values_map(obj.get("env")),
                url,
                headers: parse_key_values_map(obj.get("headers")),
                agents: Vec::new(),
            },
        );
    }
    out
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
        let claude_servers = acp_mcp_servers(&list, "claude-acp", &init_http);
        assert_eq!(claude_servers.len(), 2);
        assert_eq!(claude_servers[0]["name"], "shared");
        assert_eq!(claude_servers[0]["args"], json!(["-y", "workspace-pkg"]));
        assert_eq!(claude_servers[1]["name"], "claude-http");
        assert_eq!(claude_servers[1]["type"], "http");

        let codex_servers = acp_mcp_servers(&list, "codex", &init_http);
        assert_eq!(codex_servers.len(), 1);
        assert_eq!(codex_servers[0]["name"], "shared");

        // Disable workspace `shared` and remove user `claude-http`.
        apply_set_enabled(&mut user, &mut workspace, "workspace::shared", false).unwrap();
        apply_remove(&mut user, &mut workspace, "user::claude-http").unwrap();
        let list = servers_from_settings(&user, &workspace);
        let after = acp_mcp_servers(&list, "claude", &init_http);
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
}
