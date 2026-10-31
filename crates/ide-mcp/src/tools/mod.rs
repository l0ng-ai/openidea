//! The tools, by area. Names and parameters follow the MCP server of the
//! JetBrains IDEs (2026.2), so prompts and client setups written for it work here.

pub mod code;
pub mod edit;
pub mod files;
pub mod run;
pub mod search;
pub mod vcs;

use crate::tool::Tool;

/// Every tool the server offers (before Settings › Tools › MCP Server disables some).
pub fn all() -> Vec<Tool> {
    let mut tools = Vec::new();
    tools.extend(files::tools());
    tools.extend(search::tools());
    tools.extend(code::tools());
    tools.extend(edit::tools());
    tools.extend(run::tools());
    tools.extend(vcs::tools());
    tools
}
