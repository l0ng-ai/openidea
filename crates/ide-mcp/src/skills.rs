// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.skills/), Apache-2.0.
//! Skills OpenIDEA bundles for agents that use its MCP tools, and installing them
//! into an agent's skill directory (`~/.claude/skills/<id>/SKILL.md`, or the
//! project's `.claude/skills`).
//!
//! A skill reaches an agent only when the tools it requires are enabled. An installed
//! skill carries a marker file, so a user's own skill of the same name is never
//! replaced or removed.

use crate::clients::Paths;
use ide_core::mcp::{McpSettings, McpSkillInfo, McpSkillTarget};
use ide_core::{IdeError, IdeResult};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Marks a skill directory OpenIDEA installed.
const MARKER: &str = ".openidea-skill";

/// One bundled skill (JetBrains' `BundledSkill`).
pub struct BundledSkill {
    /// The directory name and the `name` of its SKILL.md.
    pub id: &'static str,
    pub description: &'static str,
    /// The MCP tools the skill tells the agent to use.
    pub tools: &'static [&'static str],
    /// The subset of `tools` without which the skill is useless.
    pub required_tools: &'static [&'static str],
    pub targets: &'static [McpSkillTarget],
    /// Relative path and contents of each file of the skill directory.
    pub files: &'static [(&'static str, &'static str)],
}

const ALL_TARGETS: &[McpSkillTarget] =
    &[McpSkillTarget::Claude, McpSkillTarget::Codex, McpSkillTarget::Junie, McpSkillTarget::Other];

pub const BUNDLED: &[BundledSkill] = &[BundledSkill {
    id: "openidea-ide",
    description: "Read, search, navigate, refactor, check, build and run the project open in OpenIDEA through its MCP tools.",
    tools: &[
        "read_file",
        "list_directory_tree",
        "search_file",
        "search_text",
        "search_regex",
        "search_symbol",
        "get_symbol_info",
        "analyze_calls",
        "get_project_modules",
        "get_project_dependencies",
        "get_repositories",
        "git_status",
        "apply_patch",
        "create_new_file",
        "rename_refactoring",
        "reformat_file",
        "optimize_imports",
        "add_missing_imports",
        "get_file_problems",
        "lint_files",
        "build_project",
        "get_run_configurations",
        "execute_run_configuration",
        "execute_terminal_command",
        "open_file_in_editor",
        "get_all_open_file_paths",
    ],
    required_tools: &["read_file", "search_text"],
    targets: ALL_TARGETS,
    files: &[("SKILL.md", include_str!("../skills/openidea-ide/SKILL.md"))],
}];

/// Where skills go: the user's agent directories or a project's.
#[derive(Clone, Copy)]
pub enum SkillRoot<'a> {
    User(&'a Paths),
    Project(&'a Path),
}

/// The directory `target` reads skills from.
pub fn skills_dir(target: McpSkillTarget, root: SkillRoot<'_>) -> PathBuf {
    match root {
        SkillRoot::User(paths) => match target {
            McpSkillTarget::Claude => paths.home.join(".claude").join("skills"),
            McpSkillTarget::Codex => {
                paths.codex_home.clone().unwrap_or_else(|| paths.home.join(".codex")).join("skills")
            }
            McpSkillTarget::Junie => paths.home.join(".junie").join("skills"),
            McpSkillTarget::Other => paths.home.join(".agents").join("skills"),
        },
        SkillRoot::Project(root) => match target {
            McpSkillTarget::Claude => root.join(".claude").join("skills"),
            McpSkillTarget::Codex => root.join(".codex").join("skills"),
            McpSkillTarget::Junie => root.join(".junie").join("skills"),
            McpSkillTarget::Other => root.join(".agents").join("skills"),
        },
    }
}

fn find(id: &str) -> IdeResult<&'static BundledSkill> {
    BUNDLED.iter().find(|s| s.id == id).ok_or_else(|| IdeError::not_found(format!("No bundled skill `{id}`")))
}

/// The tools the settings keep from clients: everything the effective filter (`toolStates`,
/// `toolsFilter`, `disabledTools`, experimental tools) leaves unreachable, directly or
/// through the router.
pub fn disabled_tools(settings: &McpSettings) -> HashSet<String> {
    let tools = crate::tools::all();
    let reachable: HashSet<&str> =
        crate::filter::FilterSettings::from(settings).routable_tools(&tools).iter().map(|t| t.name).collect();
    tools.iter().map(|t| t.name).filter(|n| !reachable.contains(n)).map(str::to_owned).collect()
}

/// None of the tools the skill requires is disabled ([`disabled_tools`]).
pub fn available(skill: &BundledSkill, disabled: &HashSet<String>) -> bool {
    skill.required_tools.iter().all(|t| !disabled.contains(*t))
}

fn installed_at(dir: &Path) -> bool {
    dir.join(MARKER).is_file()
}

/// Every bundled skill, with where it is installed under `root`.
pub fn list(root: SkillRoot<'_>, disabled: &HashSet<String>) -> Vec<McpSkillInfo> {
    BUNDLED
        .iter()
        .map(|s| McpSkillInfo {
            id: s.id.into(),
            description: s.description.into(),
            targets: s.targets.to_vec(),
            tools: s.tools.iter().map(|t| (*t).into()).collect(),
            available: available(s, disabled),
            installed: s.targets.iter().copied().filter(|t| installed_at(&skills_dir(*t, root).join(s.id))).collect(),
        })
        .collect()
}

/// A user's own skill of that name is left alone.
fn check_ours(dir: &Path) -> IdeResult<()> {
    if dir.exists() && !installed_at(dir) {
        return Err(IdeError::invalid(format!(
            "{} exists and was not installed by OpenIDEA; remove or rename it first",
            dir.display()
        )));
    }
    Ok(())
}

/// Installs (or updates) skill `id` for `target`; returns its directory.
pub fn install(
    id: &str,
    target: McpSkillTarget,
    root: SkillRoot<'_>,
    disabled: &HashSet<String>,
) -> IdeResult<PathBuf> {
    let skill = find(id)?;
    if !skill.targets.contains(&target) {
        return Err(IdeError::invalid(format!("Skill `{id}` is not meant for {target:?}")));
    }
    if !available(skill, disabled) {
        return Err(IdeError::invalid(format!(
            "Skill `{id}` needs the MCP tools {}; enable them in Settings › Tools › MCP Server",
            skill.required_tools.join(", ")
        )));
    }
    let parent = skills_dir(target, root);
    let dir = parent.join(skill.id);
    check_ours(&dir)?;
    std::fs::create_dir_all(&parent)?;
    // Written next to it and swapped in: an agent never reads a half-written skill.
    let staging = parent.join(format!(".{}.openidea-{}.tmp", skill.id, std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    let written = (|| -> std::io::Result<()> {
        for (path, text) in skill.files {
            let file = staging.join(path);
            if let Some(d) = file.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::write(file, text)?;
        }
        std::fs::write(staging.join(MARKER), "Installed by OpenIDEA; replaced on update.\n")?;
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        std::fs::rename(&staging, &dir)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e.into());
    }
    Ok(dir)
}

/// Removes skill `id` for `target` if OpenIDEA installed it.
pub fn remove(id: &str, target: McpSkillTarget, root: SkillRoot<'_>) -> IdeResult<()> {
    let skill = find(id)?;
    let dir = skills_dir(target, root).join(skill.id);
    if !dir.exists() {
        return Ok(());
    }
    check_ours(&dir)?;
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
