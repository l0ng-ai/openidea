//! MCP tools of plugins, for the IDE's MCP server (`ide-mcp`): the
//! `[[contributes.mcpTools]]` point, and the [`ide_mcp::ToolRegistry`] that
//! lists and runs them per project.
//!
//! ```toml
//! [capabilities]
//! required = ["mcp"]
//!
//! [[contributes.mcpTools]]
//! name = "get_open_files"                      # [a-z][a-z0-9_]{0,63}, unique
//! description = "Paths of the files open in the editor"
//! input-schema = "mcp/get_open_files.json"     # a JSON Schema of an object
//! read-only = true                             # annotations.readOnlyHint (default false)
//! destructive = false                          # annotations.destructiveHint (default false)
//! ```
//!
//! A tool runs in the plugin's instance under the command budget, for the
//! project the client named: `ctx.project()` is that project, `ctx.editor()`
//! the focused editor of its window. Only trusted projects' tools are served,
//! and only of plugins granted `mcp`.

use super::{LoadedPlugin, PluginHost, PluginStatus};
use ide_core::IdeError;
use ide_extension::{Capability, Disposable, ExtensionPoint, Package, Placement, Prepared, decode};
use ide_mcp::{Tool, ToolCallError, ToolRegistry};
use ide_plugin::{EditorContext, Invocation};
use parking_lot::RwLock;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

pub const POINT_ID: &str = "mcpTools";
const MAX_NAME: usize = 64;
const MAX_DESCRIPTION: usize = 4096;
const MAX_SCHEMA: usize = 64 << 10;
/// Most tools one plugin declares.
const MAX_TOOLS: usize = 64;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Decl {
    name: String,
    description: String,
    input_schema: PathBuf,
    #[serde(default)]
    read_only: bool,
    #[serde(default)]
    destructive: bool,
}

/// (sequence, plugin, tool) of one committed declaration.
type Declared = (u64, String, Tool);

/// The tools of enabled plugins, in the order they were committed.
#[derive(Default)]
pub struct McpTools {
    items: RwLock<Vec<Declared>>,
    seq: AtomicU64,
}

impl McpTools {
    fn add(self: &Arc<Self>, plugin: String, tool: Tool) -> Disposable {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        {
            let mut items = self.items.write();
            if let Some((_, owner, _)) = items.iter().find(|(_, p, t)| t.name == tool.name && *p != plugin) {
                tracing::warn!("MCP tool {:?} of plugin {plugin:?} is hidden by plugin {owner:?}'s", tool.name);
            }
            items.push((seq, plugin, tool));
        }
        let weak = Arc::downgrade(self);
        Disposable::new(move || {
            if let Some(this) = weak.upgrade() {
                this.items.write().retain(|(s, ..)| *s != seq);
            }
        })
    }

    fn all(&self) -> Vec<(String, Tool)> {
        self.items.read().iter().map(|(_, plugin, tool)| (plugin.clone(), tool.clone())).collect()
    }
}

pub struct McpToolsPoint {
    store: Arc<McpTools>,
}

impl McpToolsPoint {
    pub fn new(store: Arc<McpTools>) -> Self {
        Self { store }
    }
}

/// `[a-z][a-z0-9_]{0,63}`: what every MCP client accepts as a tool name.
fn valid_name(name: &str) -> bool {
    name.len() <= MAX_NAME
        && name.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

impl ExtensionPoint for McpToolsPoint {
    fn id(&self) -> &'static str {
        POINT_ID
    }

    fn placement(&self) -> Placement {
        Placement::Workspace
    }

    fn prepare(&self, pkg: &Package, decl: toml::Value) -> Result<Prepared, String> {
        let d: Decl = decode(POINT_ID, decl)?;
        let err = |m: String| format!("contributes.{POINT_ID}: {m}");
        if pkg.manifest.wasm.is_none() {
            return Err(err("MCP tools need code (`wasm`)".into()));
        }
        if !valid_name(&d.name) {
            return Err(err(format!("{:?}: names are [a-z][a-z0-9_]{{0,63}}", d.name)));
        }
        let declared = pkg.manifest.declarations(POINT_ID);
        if declared.len() > MAX_TOOLS {
            return Err(err(format!("at most {MAX_TOOLS} tools")));
        }
        if declared.iter().filter(|t| t.get("name").and_then(|n| n.as_str()) == Some(d.name.as_str())).count() > 1 {
            return Err(err(format!("tool {:?} is declared twice", d.name)));
        }
        if d.description.trim().is_empty() || d.description.len() > MAX_DESCRIPTION {
            return Err(err(format!("tool {:?}: `description` is 1–{MAX_DESCRIPTION} bytes", d.name)));
        }
        let text = pkg.read_text(&d.input_schema).map_err(|e| err(format!("tool {:?}: {e}", d.name)))?;
        if text.len() > MAX_SCHEMA {
            return Err(err(format!("tool {:?}: the input schema is larger than {} KiB", d.name, MAX_SCHEMA >> 10)));
        }
        let schema: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| err(format!("tool {:?}: {}: {e}", d.name, d.input_schema.display())))?;
        if schema.get("type").and_then(|t| t.as_str()) != Some("object") {
            return Err(err(format!(
                "tool {:?}: {} must be the JSON Schema of an object (`\"type\": \"object\"`)",
                d.name,
                d.input_schema.display()
            )));
        }
        let tool = Tool {
            name: d.name.clone(),
            description: d.description.trim().to_owned(),
            input_schema: schema,
            read_only: d.read_only,
            destructive: d.destructive,
        };
        let (store, plugin) = (self.store.clone(), pkg.id().to_owned());
        Ok(Prepared::new(format!("MCP tool {}", d.name), move || Ok(store.add(plugin, tool)))
            .key(d.name)
            .file(d.input_schema)
            .capability(Capability::Mcp))
    }
}

// ---- the registry -----------------------------------------------------------

/// Where the IDE's MCP server listens, for `mcp.endpoint`.
#[derive(Clone, Debug)]
pub struct McpServerInfo {
    pub port: u16,
    pub token: String,
    /// The IDE's executable (the stdio bridge).
    pub exe: PathBuf,
}

impl McpServerInfo {
    pub fn endpoint(&self, root: &Path) -> ide_plugin::McpEndpoint {
        ide_plugin::McpEndpoint {
            url: ide_mcp::endpoint_url(self.port, root),
            token: self.token.clone(),
            stdio_command: ide_mcp::stdio_command(&self.exe, root),
        }
    }
}

impl PluginHost {
    /// The plugins' tools for the IDE's MCP server.
    pub fn mcp_registry(self: &Arc<Self>) -> Arc<dyn ToolRegistry> {
        Arc::new(PluginTools(Arc::downgrade(self)))
    }

    /// The IDE's MCP server started (`Some`) or stopped: `mcp.endpoint` answers accordingly.
    pub fn set_mcp_server(&self, server: Option<McpServerInfo>) {
        *self.shared.mcp.write() = server;
    }

    /// The UI reports `client`'s focused text editor (MCP tool calls get it).
    pub fn set_focused_editor(&self, client: &str, editor: Option<EditorContext>) {
        let mut editors = self.focused_editors.lock();
        match editor {
            Some(e) => editors.insert(client.to_owned(), e),
            None => editors.remove(client),
        };
    }

    /// A plugin whose tools may run for `root`: usable, granted `mcp`, and
    /// (a project plugin) of that project.
    fn serves_mcp(&self, plugin: &LoadedPlugin, root: &Path) -> bool {
        if plugin.dev_root.as_deref().is_some_and(|r| r != root) {
            return false;
        }
        let meta = plugin.meta.lock();
        matches!(meta.status, PluginStatus::Active | PluginStatus::Inactive)
            && meta.pending.is_empty()
            && meta.granted.iter().any(|c| c.covers(&Capability::Mcp))
    }

    /// The tools for `root`, one per name (the first plugin committed wins).
    fn mcp_tools_of(&self, root: &Path) -> Vec<(String, Tool)> {
        let mut out: Vec<(String, Tool)> = Vec::new();
        for (plugin, tool) in self.mcp_tools.all() {
            if out.iter().any(|(_, t)| t.name == tool.name) {
                continue;
            }
            if self.get(&plugin).is_ok_and(|p| self.serves_mcp(&p, root)) {
                out.push((plugin, tool));
            }
        }
        out
    }

    fn workspace_trusts(&self, root: &Path) -> Result<(), String> {
        let trusted = self.shared.workspace.read().as_ref().is_some_and(|w| w.trusted(root));
        if trusted {
            Ok(())
        } else {
            Err(format!(
                "{} is open in Restricted Mode: trust the project in OpenIDEA to use its plugins' tools",
                root.display()
            ))
        }
    }

    /// Runs MCP tool `name` for the project at `root`: in the plugin's
    /// instance, with that project's window and focused editor as invocation.
    pub fn call_mcp_tool(&self, root: &Path, name: &str, arguments: &str) -> Result<String, ToolCallError> {
        self.workspace_trusts(root).map_err(ToolCallError::Failed)?;
        let (plugin, _) = self
            .mcp_tools_of(root)
            .into_iter()
            .find(|(_, t)| t.name == name)
            .ok_or_else(|| ToolCallError::UnknownTool(format!("no tool {name:?} for {}", root.display())))?;
        let client = self.shared.workspace.read().as_ref().and_then(|w| w.window_of(root));
        let editor = client
            .as_deref()
            .and_then(|c| self.focused_editors.lock().get(c).cloned())
            .filter(|e| e.path.starts_with(root));
        let invocation = Invocation { client, workspace_root: Some(root.to_path_buf()), editor };
        tracing::info!(plugin = %plugin, tool = %name, "MCP tool call");
        let (tool, args) = (name.to_owned(), arguments.to_owned());
        self.code_call(&plugin, invocation, "running the tool", move |rt, inv| rt.call_mcp_tool(&tool, &args, inv))
            .map_err(|e: IdeError| ToolCallError::Failed(e.message))
    }
}

struct PluginTools(Weak<PluginHost>);

impl PluginTools {
    fn host(&self) -> Option<Arc<PluginHost>> {
        self.0.upgrade()
    }
}

impl ToolRegistry for PluginTools {
    fn projects(&self) -> Vec<PathBuf> {
        let Some(host) = self.host() else { return Vec::new() };
        host.shared.workspace.read().as_ref().map(|w| w.projects()).unwrap_or_default()
    }

    fn tools(&self, project: &Path) -> Result<Vec<Tool>, String> {
        let host = self.host().ok_or("OpenIDEA is shutting down")?;
        host.workspace_trusts(project)?;
        Ok(host.mcp_tools_of(project).into_iter().map(|(_, tool)| tool).collect())
    }

    fn call(&self, project: &Path, name: &str, arguments: &str) -> Result<String, ToolCallError> {
        let host = self.host().ok_or_else(|| ToolCallError::Failed("OpenIDEA is shutting down".into()))?;
        host.call_mcp_tool(project, name, arguments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names() {
        for ok in ["get_open_files", "a", "x1_2"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "Get", "1x", "_x", "get-open", "a.b", &"x".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }
}
