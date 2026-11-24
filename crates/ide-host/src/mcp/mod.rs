//! Built-in IDE tools. Transport and discovery live in `ide-mcp`.
mod background;
mod check;
mod edit;
mod editors;
mod requests;
pub(crate) mod run;
mod vcs;
pub use background::{BackgroundProjects, McpBackgroundHold, McpBackgroundProject};
pub use requests::Requests;
mod files;
mod http;
mod page;
pub mod reports;
mod search;
pub mod service;
mod symbols;
mod tool;

pub(crate) use tool::trusted_attachments;
mod util;

use crate::Host;
use ide_core::{CancellationToken, IdeError};
use ide_mcp::{ToolCallError, ToolRegistry};
pub use reports::{
    FileProblems, FocusedEditor, Reports, mcp_report_problems, mcp_set_focused_editor, mcp_set_open_editors,
};
pub use run::agent::{AGENT_PARAM, AgentRun, AgentRuns, NAME_PREFIX, SHELL_PARAM};
pub use service::{McpServerStatus, McpService};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct Registry(Arc<Host>);
impl Registry {
    pub fn new(host: Arc<Host>) -> Self {
        Self(host)
    }
}

fn tools() -> Vec<tool::Tool> {
    let mut tools = files::tools();
    tools.extend(search::tools());
    tools.extend(editors::tools());
    tools.push(check::check_files());
    tools.push(symbols::get_symbol_info());
    tools.push(symbols::find_references());
    tools.push(symbols::get_call_hierarchy());
    tools.extend(edit::tools());
    tools.extend(run::tools());
    tools.extend(vcs::tools());
    tools.extend(http::tools());
    tools
}

// Checked both when listing and calling, so a later trust change takes effect immediately.
fn allowed(tool: &ide_mcp::Tool, trusted: bool) -> bool {
    trusted || tool.read_only
}

impl Registry {
    /// The window that answers for `root`: one with the root open, or one it is attached in.
    fn window(&self, root: &Path) -> Result<Option<(String, Arc<crate::Project>)>, String> {
        if self.0.mcp_reports.remote_roots().iter().any(|p| p == root) {
            return Err("project is on a remote host; connect to the MCP server on that host".into());
        }
        let projects = self.0.projects.read();
        let open = || projects.iter().filter(|(w, p)| !p.light && !BackgroundProjects::is_key(w));
        let mut windows: Vec<_> = open().filter(|(_, p)| p.root == root).map(|(w, p)| (w.clone(), p.clone())).collect();
        if windows.is_empty() {
            // A project attached to an open one: the window it is attached in.
            windows = open()
                .filter(|(_, p)| tool::attached_projects(&p.root).iter().any(|a| a == root))
                .map(|(w, p)| (w.clone(), p.clone()))
                .collect();
        }
        drop(projects);
        let focused = self.0.mcp_reports.focused_window();
        windows.sort_by(|a, b| {
            (Some(&b.0) == focused.as_ref()).cmp(&(Some(&a.0) == focused.as_ref())).then(a.0.cmp(&b.0))
        });
        Ok(windows.into_iter().next())
    }

    /// The window and project a tool call for `root` runs in. Without a window the project
    /// is served in the background, under its key, and opened now if need be; the guard
    /// then keeps it loaded for as long as the caller holds it.
    fn target(&self, root: &Path) -> Result<background::Served, String> {
        match self.window(root)? {
            Some((window, project)) => Ok((window, project, None)),
            None => self.0.mcp_background.open(&self.0, root).map_err(|e| e.message),
        }
    }

    /// Whether the tools listed for `root` include those that write and run. Opens nothing:
    /// a background project that is not loaded is judged as its open will judge it.
    fn lists_as_trusted(&self, root: &Path) -> Result<bool, String> {
        if let Some((_, project)) = self.window(root)? {
            return Ok(project.is_trusted());
        }
        if let Some(project) = self.0.mcp_background.project(&self.0, root) {
            return Ok(project.is_trusted());
        }
        if background::serving_root(&self.0, root).as_deref() == Some(root) {
            return Ok(self.0.trust.window_trusted(root).unwrap_or(false));
        }
        Err("project is no longer open".into())
    }
}
impl ToolRegistry for Registry {
    fn projects(&self) -> Vec<PathBuf> {
        // Window projects only: a background project is reached through `resolve`, so a
        // request that names no folder still means the only window.
        let open: Vec<_> = {
            let projects = self.0.projects.read();
            let windows = projects.iter().filter(|(w, p)| !p.light && !BackgroundProjects::is_key(w));
            windows.map(|(_, p)| p.clone()).collect()
        };
        // Attached projects are listed too, so a `projectPath` inside one names it.
        let attached: Vec<_> = open.iter().flat_map(|p| tool::attached_projects(&p.root)).collect();
        open.into_iter().map(|p| p.root.clone()).chain(attached).chain(self.0.mcp_reports.remote_roots()).collect()
    }
    fn resolve(&self, path: &Path) -> Option<PathBuf> {
        background::serving_root(&self.0, path)
    }
    fn tools(&self, root: &Path) -> Result<Vec<ide_mcp::Tool>, String> {
        let trusted = self.lists_as_trusted(root)?;
        let mut all: Vec<_> = tools().into_iter().map(|t| t.metadata).collect();
        if let Some(plugins) = self.0.plugin_host() {
            all.extend(plugins.mcp_tools(root).into_iter().map(|(_, _, tool)| tool));
        }
        Ok(all.into_iter().filter(|t| allowed(t, trusted)).collect())
    }
    fn call(
        &self,
        root: &Path,
        name: &str,
        arguments: &str,
        cancel: CancellationToken,
    ) -> Result<String, ToolCallError> {
        self.call_with_client(root, name, arguments, cancel, "MCP client")
    }
    fn call_with_client(
        &self,
        root: &Path,
        name: &str,
        arguments: &str,
        cancel: CancellationToken,
        client: &str,
    ) -> Result<String, ToolCallError> {
        // The guard lives until the call ends, whichever way it leaves: neither the idle
        // sweep nor the limit unloads a background project a call runs in.
        let (window, project, _activity) = self.target(root).map_err(ToolCallError::Failed)?;
        if let Some(plugins) = self.0.plugin_host()
            && let Some((plugin, tool, metadata)) =
                plugins.mcp_tools(root).into_iter().find(|(_, _, t)| t.name == name && allowed(t, project.is_trusted()))
        {
            return self.call_plugin(window, project, plugins, plugin, tool, metadata, arguments, cancel, client);
        }
        let tool = tools()
            .into_iter()
            .find(|t| t.metadata.name == name && allowed(&t.metadata, project.is_trusted()))
            .ok_or_else(|| ToolCallError::UnknownTool(format!("unknown tool: {name}")))?;
        let args = serde_json::from_str(arguments).map_err(|e| ToolCallError::Failed(e.to_string()))?;
        let call = tool::Call {
            host: self.0.clone(),
            project,
            window,
            args,
            cancel: cancel.clone(),
            client: client.to_owned(),
            tool: name.to_owned(),
        };
        if cancel.is_cancelled() {
            return Err(ToolCallError::Failed(IdeError::cancelled().message));
        }
        let result = self.0.runtime.block_on((tool.handler)(call));
        if cancel.is_cancelled() {
            return Err(ToolCallError::Failed(IdeError::cancelled().message));
        }
        result.map(|out| out.0).map_err(|e| ToolCallError::Failed(e.message))
    }
}

impl Host {
    fn mcp_windows(&self, root: &Path) -> Vec<String> {
        let mut windows: Vec<_> =
            self.projects.read().iter().filter(|(_, p)| p.root == root).map(|(w, _)| w.clone()).collect();
        windows.sort();
        windows
    }
}

impl Registry {
    #[allow(clippy::too_many_arguments)]
    fn call_plugin(
        &self,
        window: String,
        project: Arc<crate::Project>,
        plugins: Arc<crate::plugins::PluginHost>,
        plugin: String,
        tool: String,
        metadata: ide_mcp::Tool,
        arguments: &str,
        cancel: CancellationToken,
        client: &str,
    ) -> Result<String, ToolCallError> {
        let run = || -> ide_core::IdeResult<String> {
            let args = serde_json::from_str(arguments).map_err(|e| IdeError::invalid(e.to_string()))?;
            let call = tool::Call {
                host: self.0.clone(),
                project: project.clone(),
                window: window.clone(),
                args,
                cancel: cancel.clone(),
                client: client.into(),
                tool: metadata.name,
            };
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if metadata.destructive {
                self.0.runtime.block_on(call.confirm(&metadata.description, None))?;
            }
            if !metadata.read_only {
                project.require_trust()?;
            }
            let invocation = ide_plugin::Invocation {
                client: Some(window),
                workspace_root: Some(project.root.clone()),
                ..Default::default()
            };
            plugins.call_mcp_tool(&plugin, &tool, arguments, invocation, &cancel)
        };
        run().map_err(|e| ToolCallError::Failed(e.message))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn restricted_mode_excludes_execution_tools() {
        let mut tool = super::tools().remove(0).metadata;
        assert!(super::allowed(&tool, false));
        tool.read_only = false;
        assert!(!super::allowed(&tool, false));
        assert!(super::allowed(&tool, true));
    }
}
