//! The tools, by area. Names and parameters follow the MCP server of the
//! JetBrains IDEs (2026.2), so prompts and client setups written for it work here.

pub mod code;
pub mod diagnostics;
pub mod edit;
pub mod files;
pub mod run;
pub mod search;
pub mod universal;
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
    tools.extend(diagnostics::tools());
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
        "reformat_file" => "general.FormattingToolset",
        "rename_refactoring" => "general.RefactoringToolset",
        "search_text" | "search_regex" | "search_file" | "search_symbol" => "general.SearchToolset",
        "get_repositories" | "git_status" => "vcs.VcsToolset",
        "execute_terminal_command" => "terminal.TerminalToolset",
        _ => return None,
    })
}
