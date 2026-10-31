//! The tools, by area. Names and parameters follow the MCP server of the
//! JetBrains IDEs (2026.2), so prompts and client setups written for it work here.

pub mod changelists;
pub mod code;
pub mod database;
pub mod diagnostics;
pub mod edit;
pub mod files;
pub mod run;
pub mod search;
pub mod universal;
pub mod util;
pub mod vcs;

use crate::tool::Tool;
use ide_core::{IdeError, IdeResult};
use ide_host::Project;

/// Tools that only read files, search, or change files the way the editor does: they
/// work in a project in Restricted Mode. The others start language servers, git or
/// processes, which an untrusted project could turn into running its code.
const RESTRICTED_MODE_TOOLS: &[&str] = &[
    "read_file",
    "list_directory_tree",
    "search_text",
    "search_regex",
    "search_file",
    "create_new_file",
    "apply_patch",
    "open_file_in_editor",
    "get_all_open_file_paths",
    "get_project_modules",
    "get_ide_diagnostics",
    "execute_tool",
];

/// Errors when `tool` needs a trusted project and `project` is in Restricted Mode.
pub fn check_trust(tool: &str, project: &Project) -> IdeResult<()> {
    if project.is_trusted() || RESTRICTED_MODE_TOOLS.contains(&tool) {
        return Ok(());
    }
    Err(IdeError::unavailable(format!(
        "The project is in Restricted Mode, so `{tool}` is not available. Ask the user to trust the project in OpenIDEA."
    )))
}

/// Every tool the server offers (before Settings › Tools › MCP Server disables some).
pub fn all() -> Vec<Tool> {
    let mut tools = Vec::new();
    tools.extend(files::tools());
    tools.extend(search::tools());
    tools.extend(code::tools());
    tools.extend(edit::tools());
    tools.extend(run::tools());
    tools.extend(vcs::tools());
    tools.extend(changelists::tools());
    tools.extend(diagnostics::tools());
    tools.extend(database::tools());
    tools.extend(universal::tools());
    tools
        .into_iter()
        .map(|t| match jetbrains_group(t.name) {
            Some(group) if t.group == crate::filter::DEFAULT_GROUP => t.group(group),
            _ => t,
        })
        .collect()
}

/// The JetBrains toolset class (package below `com.intellij.mcpserver.toolsets`) declaring `tool`.
fn jetbrains_group(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "read_file" => "general.ReadToolset",
        "list_directory_tree" | "open_file_in_editor" | "get_all_open_file_paths" | "create_new_file" => {
            "general.FileToolset"
        }
        "get_file_problems"
        | "lint_files"
        | "analyze_calls"
        | "build_project"
        | "get_project_modules"
        | "get_project_dependencies" => "general.AnalysisToolset",
        "get_symbol_info" => "general.CodeInsightToolset",
        "get_run_configurations" | "execute_run_configuration" => "general.ExecutionToolset",
        "apply_patch" => "general.PatchToolset",
        "reformat_file" | "optimize_imports" => "general.FormattingToolset",
        "add_missing_imports" => "general.ImportsToolset",
        "rename_refactoring" => "general.RefactoringToolset",
        "search_text" | "search_regex" | "search_file" | "search_symbol" => "general.SearchToolset",
        "get_repositories" | "git_status" => "vcs.VcsToolset",
        "get_changelists"
        | "create_changelist"
        | "delete_changelist"
        | "set_active_changelist"
        | "move_changes_to_changelist" => "vcs.ChangeListToolset",
        "execute_terminal_command" => "terminal.TerminalToolset",
        _ => return None,
    })
}
