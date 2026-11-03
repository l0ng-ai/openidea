//! Discovery and editing of Model Context Protocol (MCP) server configurations across
//! User (`~/.copilot/mcp-config.json`, `~/.cursor/mcp.json`, `~/.claude.json`, `<config>/mcp.json`),
//! Workspace (`.mcp.json`, `.vscode/mcp.json`, `.cursor/mcp.json`), Plugins
//! (`~/.copilot/installed-plugins`), and Built-In scopes.

use crate::acp::Negotiated;
use crate::{AgentPaths, McpKeyValue, McpScope, McpServer, McpServerInput, McpTransport};
use ide_core::IpcPath;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

const BUILTIN_GITHUB_MCP: &str = "github-mcp-server";

#[derive(Clone, Debug)]
struct ConfigSource {
    scope: McpScope,
    path: PathBuf,
    label: String,
    /// Top-level JSON key holding the server map (`"mcpServers"` or `"servers"`).
    root_key: &'static str,
    plugin_name: Option<String>,
}

/// Lists all configured and discovered MCP servers across User, Workspace, Plugin, and Built-In scopes.
pub fn list_servers(paths: &AgentPaths, cwd: Option<&Path>) -> Vec<McpServer> {
    let disabled_overrides = load_disabled_overrides(paths);
    let mut out = Vec::new();
    let workspace_root = cwd.unwrap_or(&paths.project_root);

    for src in user_sources(paths)
        .into_iter()
        .chain(workspace_sources(workspace_root))
        .chain(plugin_sources(paths.home_dir.as_deref()))
    {
        out.extend(read_source(&src, &disabled_overrides));
    }

    let builtin_id = format!("builtin::{BUILTIN_GITHUB_MCP}");
    let builtin_enabled = !disabled_overrides.contains(&builtin_id);
    out.push(McpServer {
        id: builtin_id,
        name: BUILTIN_GITHUB_MCP.to_owned(),
        scope: McpScope::Builtin,
        transport: McpTransport::Http,
        enabled: builtin_enabled,
        source_label: String::new(),
        config_path: None,
        plugin_name: None,
        command: None,
        args: Vec::new(),
        env: Vec::new(),
        url: None,
        headers: Vec::new(),
    });

    out
}

/// Builds the ACP `mcpServers` array for `session/new`, `session/load`, and `session/fork`.
pub(crate) fn acp_mcp_servers(paths: &AgentPaths, cwd: &Path, provider: &str, init: &Negotiated) -> Vec<Value> {
    let supports_http = init.mcp("http");
    let supports_sse = init.mcp("sse");
    let mut seen = HashSet::new();
    let mut servers = Vec::new();
    let copilot_cfg = paths.home_dir.as_ref().map(|h| h.join(".copilot/mcp-config.json"));

    // Workspace takes precedence over User, which takes precedence over Plugins.
    let all = list_servers(paths, Some(cwd));
    let ordered = all
        .iter()
        .filter(|s| s.scope == McpScope::Workspace)
        .chain(all.iter().filter(|s| s.scope == McpScope::User))
        .chain(all.iter().filter(|s| s.scope == McpScope::Plugin));

    for srv in ordered {
        if provider == "copilot" {
            // Copilot CLI natively loads ~/.copilot/mcp-config.json and ~/.copilot/installed-plugins.
            if srv.scope == McpScope::Plugin {
                continue;
            }
            if let (Some(cfg), Some(src)) = (&copilot_cfg, &srv.config_path)
                && &src.0 == cfg
            {
                continue;
            }
        }
        if !srv.enabled || !seen.insert(srv.name.clone()) {
            continue;
        }
        match srv.transport {
            McpTransport::Stdio => {
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

/// Enables or disables an MCP server by ID and returns the updated server list.
pub fn set_server_enabled(
    paths: &AgentPaths,
    cwd: Option<&Path>,
    id: &str,
    enabled: bool,
) -> Result<Vec<McpServer>, String> {
    let servers = list_servers(paths, cwd);
    let srv = servers.iter().find(|s| s.id == id).ok_or_else(|| format!("MCP server `{id}` not found"))?;

    if let Some(config_path) = &srv.config_path
        && matches!(srv.scope, McpScope::User | McpScope::Workspace)
        && set_disabled_in_file(&config_path.0, &srv.name, !enabled).is_ok()
    {
        set_disabled_override(paths, id, !enabled)?;
        return Ok(list_servers(paths, cwd));
    }

    set_disabled_override(paths, id, !enabled)?;
    Ok(list_servers(paths, cwd))
}

/// Creates or updates a User or Workspace MCP server and returns the updated server list.
pub fn save_server(paths: &AgentPaths, cwd: Option<&Path>, input: McpServerInput) -> Result<Vec<McpServer>, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Server name is required".into());
    }
    match input.transport {
        McpTransport::Stdio => {
            if input.command.as_deref().map(str::trim).unwrap_or_default().is_empty() {
                return Err("Command is required for stdio MCP servers".into());
            }
        }
        McpTransport::Http | McpTransport::Sse => {
            if input.url.as_deref().map(str::trim).unwrap_or_default().is_empty() {
                return Err("URL is required for HTTP/SSE MCP servers".into());
            }
        }
    }

    let workspace_root = cwd.unwrap_or(&paths.project_root);
    let existing = input.id.as_deref().and_then(|id| list_servers(paths, cwd).into_iter().find(|s| s.id == id));

    let target_scope = match input.scope {
        McpScope::User | McpScope::Workspace => input.scope,
        _ => return Err("Only User and Workspace MCP servers can be saved".into()),
    };

    let (target_path, root_key) = if let Some(prev) = &existing
        && prev.scope == target_scope
        && let Some(p) = &prev.config_path
    {
        let rk = detect_root_key(&p.0);
        (p.0.clone(), rk)
    } else {
        default_config_target(paths, workspace_root, target_scope)?
    };

    // If the server was moved from another file or renamed, remove the old entry first.
    if let Some(prev) = &existing
        && let Some(prev_path) = &prev.config_path
        && (prev_path.0 != target_path || prev.name != name)
    {
        let _ = remove_from_file(&prev_path.0, &prev.name);
        let _ = set_disabled_override(paths, &prev.id, false);
    }

    write_server_to_file(&target_path, root_key, name, &input)?;
    let new_id = server_id(target_scope, &target_path, name);
    set_disabled_override(paths, &new_id, !input.enabled)?;

    Ok(list_servers(paths, cwd))
}

/// Removes a User or Workspace MCP server by ID and returns the updated server list.
pub fn remove_server(paths: &AgentPaths, cwd: Option<&Path>, id: &str) -> Result<Vec<McpServer>, String> {
    let servers = list_servers(paths, cwd);
    let srv = servers.iter().find(|s| s.id == id).ok_or_else(|| format!("MCP server `{id}` not found"))?;
    if !matches!(srv.scope, McpScope::User | McpScope::Workspace) {
        return Err("Only User and Workspace MCP servers can be removed".into());
    }
    let path = srv.config_path.as_ref().ok_or("MCP server has no backing config file")?;
    remove_from_file(&path.0, &srv.name)?;
    let _ = set_disabled_override(paths, id, false);
    Ok(list_servers(paths, cwd))
}

fn user_sources(paths: &AgentPaths) -> Vec<ConfigSource> {
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    let home = paths.home_dir.as_deref();

    if let Some(h) = home {
        for (rel, root_key) in [
            (".copilot/mcp-config.json", "mcpServers"),
            (".cursor/mcp.json", "mcpServers"),
            (".claude.json", "mcpServers"),
        ] {
            let path = h.join(rel);
            if seen.insert(path.clone()) {
                sources.push(ConfigSource {
                    scope: McpScope::User,
                    label: format!("~/{rel}"),
                    path,
                    root_key,
                    plugin_name: None,
                });
            }
        }
    }

    if let Some(agents_dir) = &paths.custom_agents_dir
        && let Some(config_dir) = agents_dir.parent()
    {
        let path = config_dir.join("mcp.json");
        if seen.insert(path.clone()) {
            let label = display_path(&path, home, None);
            sources.push(ConfigSource {
                scope: McpScope::User,
                label,
                path,
                root_key: "mcpServers",
                plugin_name: None,
            });
        }
    }

    sources
}

fn workspace_sources(workspace_root: &Path) -> Vec<ConfigSource> {
    let mut sources = Vec::new();
    for (rel, root_key) in
        [(".mcp.json", "mcpServers"), (".vscode/mcp.json", "servers"), (".cursor/mcp.json", "mcpServers")]
    {
        sources.push(ConfigSource {
            scope: McpScope::Workspace,
            path: workspace_root.join(rel),
            label: rel.to_owned(),
            root_key,
            plugin_name: None,
        });
    }
    sources
}

fn plugin_sources(home: Option<&Path>) -> Vec<ConfigSource> {
    let Some(home) = home else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    collect_plugin_dirs(&home.join(".copilot/installed-plugins"), 0, 3, &mut dirs);
    dirs.sort();

    let mut out = Vec::new();
    for dir in dirs {
        let mcp_path = dir.join(".mcp.json");
        if !mcp_path.is_file() {
            continue;
        }
        let plugin_name = read_plugin_name(&dir)
            .unwrap_or_else(|| dir.file_name().and_then(|n| n.to_str()).unwrap_or("plugin").to_owned());
        out.push(ConfigSource {
            scope: McpScope::Plugin,
            path: mcp_path,
            label: format!("Plugin: {plugin_name}"),
            root_key: "mcpServers",
            plugin_name: Some(plugin_name),
        });
    }
    out
}

fn collect_plugin_dirs(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<PathBuf>) {
    if depth > max_depth || !dir.is_dir() {
        return;
    }
    if dir.join(".mcp.json").is_file() {
        out.push(dir.to_path_buf());
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_plugin_dirs(&path, depth + 1, max_depth, out);
        }
    }
}

fn read_plugin_name(plugin_dir: &Path) -> Option<String> {
    for rel in [".plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", "plugin.json"] {
        let p = plugin_dir.join(rel);
        if let Ok(bytes) = std::fs::read(&p)
            && let Ok(val) = serde_json::from_slice::<Value>(&bytes)
            && let Some(name) = val.get("name").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
        {
            return Some(name.to_owned());
        }
    }
    None
}

fn read_source(src: &ConfigSource, disabled_overrides: &HashSet<String>) -> Vec<McpServer> {
    let Ok(bytes) = std::fs::read(&src.path) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    let Some(servers_obj) = root
        .get(src.root_key)
        .or_else(|| root.get("mcpServers"))
        .or_else(|| root.get("servers"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (name, def) in servers_obj {
        let Some(obj) = def.as_object() else {
            continue;
        };
        let id = server_id(src.scope, &src.path, name);
        let file_disabled = obj.get("disabled").and_then(Value::as_bool).unwrap_or(false)
            || obj.get("enabled").and_then(Value::as_bool) == Some(false);
        let enabled = !file_disabled && !disabled_overrides.contains(&id);

        let type_str = obj.get("type").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
        let url = obj.get("url").or_else(|| obj.get("serverUrl")).and_then(Value::as_str).map(str::to_owned);
        let command = obj.get("command").and_then(Value::as_str).map(str::to_owned);

        let transport = match type_str.as_str() {
            "sse" => McpTransport::Sse,
            "http" | "streamable-http" | "streamable_http" => McpTransport::Http,
            "stdio" | "local" => McpTransport::Stdio,
            _ if url.is_some() && command.is_none() => McpTransport::Http,
            _ => McpTransport::Stdio,
        };

        let args = obj
            .get("args")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();

        let env = parse_key_values(obj.get("env"));
        let headers = parse_key_values(obj.get("headers"));

        out.push(McpServer {
            id,
            name: name.clone(),
            scope: src.scope,
            transport,
            enabled,
            source_label: src.label.clone(),
            config_path: Some(IpcPath::from(src.path.clone())),
            plugin_name: src.plugin_name.clone(),
            command,
            args,
            env,
            url,
            headers,
        });
    }
    out
}

fn parse_key_values(val: Option<&Value>) -> Vec<McpKeyValue> {
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
                Some(McpKeyValue { name: k.clone(), value: s })
            })
            .collect(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|item| {
                let obj = item.as_object()?;
                let name = obj.get("name")?.as_str()?.to_owned();
                let value = obj.get("value")?.as_str()?.to_owned();
                Some(McpKeyValue { name, value })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn server_id(scope: McpScope, path: &Path, name: &str) -> String {
    let scope_tag = match scope {
        McpScope::User => "user",
        McpScope::Workspace => "workspace",
        McpScope::Plugin => "plugin",
        McpScope::Builtin => "builtin",
    };
    format!("{scope_tag}:{}:{name}", path.to_string_lossy())
}

fn display_path(path: &Path, home: Option<&Path>, workspace: Option<&Path>) -> String {
    if let Some(ws) = workspace
        && let Ok(rel) = path.strip_prefix(ws)
    {
        return rel.to_string_lossy().replace('\\', "/");
    }
    if let Some(h) = home
        && let Ok(rel) = path.strip_prefix(h)
    {
        return format!("~/{}", rel.to_string_lossy().replace('\\', "/"));
    }
    path.to_string_lossy().into_owned()
}

fn default_config_target(
    paths: &AgentPaths,
    workspace_root: &Path,
    scope: McpScope,
) -> Result<(PathBuf, &'static str), String> {
    match scope {
        McpScope::User => {
            if let Some(home) = &paths.home_dir {
                Ok((home.join(".copilot/mcp-config.json"), "mcpServers"))
            } else if let Some(agents_dir) = &paths.custom_agents_dir
                && let Some(config_dir) = agents_dir.parent()
            {
                Ok((config_dir.join("mcp.json"), "mcpServers"))
            } else {
                Ok((paths.store_dir.join("mcp-config.json"), "mcpServers"))
            }
        }
        McpScope::Workspace => Ok((workspace_root.join(".mcp.json"), "mcpServers")),
        _ => Err("Unsupported scope".into()),
    }
}

fn detect_root_key(path: &Path) -> &'static str {
    if let Ok(bytes) = std::fs::read(path)
        && let Ok(Value::Object(root)) = serde_json::from_slice::<Value>(&bytes)
        && root.contains_key("servers")
        && !root.contains_key("mcpServers")
    {
        return "servers";
    }
    "mcpServers"
}

fn read_or_init_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(&bytes).map_err(|e| format!("Failed to parse {}: {e}", path.display()))? {
        Value::Object(map) => Ok(map),
        _ => Err(format!("Expected JSON object in {}", path.display())),
    }
}

fn write_json_object(path: &Path, root: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }
    let mut text = serde_json::to_string_pretty(&Value::Object(root.clone()))
        .map_err(|e| format!("Failed to serialize JSON: {e}"))?;
    text.push('\n');
    std::fs::write(path, text).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

fn write_server_to_file(
    path: &Path,
    default_root_key: &'static str,
    name: &str,
    input: &McpServerInput,
) -> Result<(), String> {
    let mut root = read_or_init_json_object(path)?;
    let root_key =
        if root.contains_key("servers") && !root.contains_key("mcpServers") { "servers" } else { default_root_key };
    let is_copilot_config = path.file_name().and_then(|n| n.to_str()) == Some("mcp-config.json");

    let servers_val = root.entry(root_key.to_owned()).or_insert_with(|| Value::Object(Map::new()));
    let servers = servers_val
        .as_object_mut()
        .ok_or_else(|| format!("`{root_key}` in {} is not a JSON object", path.display()))?;

    let mut entry = servers.get(name).and_then(Value::as_object).cloned().unwrap_or_default();

    match input.transport {
        McpTransport::Stdio => {
            entry.remove("url");
            entry.remove("serverUrl");
            entry.remove("headers");
            if is_copilot_config {
                entry.entry("type".to_owned()).or_insert_with(|| Value::String("local".to_owned()));
                entry.entry("tools".to_owned()).or_insert_with(|| json!(["*"]));
            } else if entry.get("type").and_then(Value::as_str).is_some_and(|t| t == "http" || t == "sse") {
                entry.remove("type");
            }
            if let Some(cmd) = &input.command {
                entry.insert("command".to_owned(), Value::String(cmd.trim().to_owned()));
            }
            let args: Vec<Value> = input.args.iter().map(|a| Value::String(a.clone())).collect();
            entry.insert("args".to_owned(), Value::Array(args));
            if input.env.is_empty() {
                entry.remove("env");
            } else {
                let mut env_map = Map::new();
                for kv in &input.env {
                    if !kv.name.trim().is_empty() {
                        env_map.insert(kv.name.trim().to_owned(), Value::String(kv.value.clone()));
                    }
                }
                entry.insert("env".to_owned(), Value::Object(env_map));
            }
        }
        McpTransport::Http | McpTransport::Sse => {
            entry.remove("command");
            entry.remove("args");
            entry.remove("env");
            let t = if input.transport == McpTransport::Sse { "sse" } else { "http" };
            entry.insert("type".to_owned(), Value::String(t.to_owned()));
            if is_copilot_config {
                entry.entry("tools".to_owned()).or_insert_with(|| json!(["*"]));
            }
            if let Some(url) = &input.url {
                entry.insert("url".to_owned(), Value::String(url.trim().to_owned()));
            }
            if input.headers.is_empty() {
                entry.remove("headers");
            } else {
                let mut hdr_map = Map::new();
                for kv in &input.headers {
                    if !kv.name.trim().is_empty() {
                        hdr_map.insert(kv.name.trim().to_owned(), Value::String(kv.value.clone()));
                    }
                }
                entry.insert("headers".to_owned(), Value::Object(hdr_map));
            }
        }
    }

    if input.enabled {
        entry.remove("disabled");
    } else {
        entry.insert("disabled".to_owned(), Value::Bool(true));
    }

    servers.insert(name.to_owned(), Value::Object(entry));
    write_json_object(path, &root)
}

fn set_disabled_in_file(path: &Path, name: &str, disabled: bool) -> Result<(), String> {
    let mut root = read_or_init_json_object(path)?;
    let root_key =
        if root.contains_key("servers") && !root.contains_key("mcpServers") { "servers" } else { "mcpServers" };
    let servers = root
        .get_mut(root_key)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("No `{root_key}` object in {}", path.display()))?;
    let entry = servers
        .get_mut(name)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("Server `{name}` not found in {}", path.display()))?;
    if disabled {
        entry.insert("disabled".to_owned(), Value::Bool(true));
    } else {
        entry.remove("disabled");
        if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
            entry.remove("enabled");
        }
    }
    write_json_object(path, &root)
}

fn remove_from_file(path: &Path, name: &str) -> Result<(), String> {
    let mut root = read_or_init_json_object(path)?;
    let root_key =
        if root.contains_key("servers") && !root.contains_key("mcpServers") { "servers" } else { "mcpServers" };
    if let Some(servers) = root.get_mut(root_key).and_then(Value::as_object_mut) {
        servers.remove(name);
    }
    write_json_object(path, &root)
}

fn overrides_file(paths: &AgentPaths) -> PathBuf {
    paths.models_file.parent().unwrap_or(&paths.store_dir).join(".mcp-disabled")
}

fn load_disabled_overrides(paths: &AgentPaths) -> HashSet<String> {
    let path = overrides_file(paths);
    let Ok(bytes) = std::fs::read(path) else {
        return HashSet::new();
    };
    serde_json::from_slice::<BTreeMap<String, bool>>(&bytes)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, disabled)| disabled.then_some(k))
        .collect()
}

fn set_disabled_override(paths: &AgentPaths, id: &str, disabled: bool) -> Result<(), String> {
    let path = overrides_file(paths);
    let mut map: BTreeMap<String, bool> =
        std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if disabled {
        map.insert(id.to_owned(), true);
    } else {
        map.remove(id);
    }
    if map.is_empty() && !path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&map).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}
