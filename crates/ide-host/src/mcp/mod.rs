//! Built-in IDE tools. Transport and discovery live in `ide-mcp`.
mod editors;
mod files;
mod reports;
mod search;
mod symbols;
mod tool;
mod util;

use crate::Host;
use ide_core::{CancellationToken, IdeError};
use ide_mcp::{ToolCallError, ToolRegistry};
pub use reports::{FileProblems, FocusedEditor, Reports};
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
    tools.push(symbols::get_symbol_info());
    tools
}

// Checked both when listing and calling, so a later trust change takes effect immediately.
fn allowed(tool: &ide_mcp::Tool, trusted: bool) -> bool {
    trusted || tool.read_only
}

impl Registry {
    fn target(&self, root: &Path) -> Result<(String, Arc<crate::Project>), String> {
        if self.0.mcp_reports.remote_roots().iter().any(|p| p == root) {
            return Err("not supported for remote projects yet".into());
        }
        let mut windows: Vec<_> = self
            .0
            .projects
            .read()
            .iter()
            .filter(|(_, p)| p.root == root && !p.light)
            .map(|(w, p)| (w.clone(), p.clone()))
            .collect();
        let focused = self.0.mcp_reports.focused_window();
        windows.sort_by(|a, b| {
            (Some(&b.0) == focused.as_ref()).cmp(&(Some(&a.0) == focused.as_ref())).then(a.0.cmp(&b.0))
        });
        windows.into_iter().next().ok_or_else(|| "project is no longer open".into())
    }
}
impl ToolRegistry for Registry {
    fn projects(&self) -> Vec<PathBuf> {
        self.0
            .projects()
            .into_iter()
            .filter(|p| !p.light)
            .map(|p| p.root.clone())
            .chain(self.0.mcp_reports.remote_roots())
            .collect()
    }
    fn tools(&self, root: &Path) -> Result<Vec<ide_mcp::Tool>, String> {
        let (_, project) = self.target(root)?;
        Ok(tools().into_iter().map(|t| t.metadata).filter(|t| allowed(t, project.is_trusted())).collect())
    }
    fn call(
        &self,
        root: &Path,
        name: &str,
        arguments: &str,
        cancel: CancellationToken,
    ) -> Result<String, ToolCallError> {
        let (window, project) = self.target(root).map_err(ToolCallError::Failed)?;
        let tool = tools()
            .into_iter()
            .find(|t| t.metadata.name == name && allowed(&t.metadata, project.is_trusted()))
            .ok_or_else(|| ToolCallError::UnknownTool(format!("unknown tool: {name}")))?;
        let args = serde_json::from_str(arguments).map_err(|e| ToolCallError::Failed(e.to_string()))?;
        let call = tool::Call { host: self.0.clone(), project, window, args, cancel: cancel.clone() };
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
