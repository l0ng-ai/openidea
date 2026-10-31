// Ported from JetBrains intellij-community plugins/mcp-server
// (mcpserver.vcs/src/com/intellij/mcpserver/toolsets/vcs/VcsToolset.kt), Apache-2.0.
//! Version control: repositories and git status.

use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::mcp::McpToolKind;
use ide_core::{IdeError, IdeResult};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const STATUS_DEFAULT_LIMIT: i64 = 1000;

pub fn tools() -> Vec<Tool> {
    vec![get_repositories(), git_status()]
}

/// A path relative to the project root with `/`; empty for the root itself.
fn relative_to_project(call: &Call, path: &Path) -> String {
    match path.strip_prefix(call.root()) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

fn get_repositories() -> Tool {
    Tool::new(
        "get_repositories",
        McpToolKind::Read,
        "Retrieves the list of VCS roots in the project.
This is useful to detect all repositories in a multi-repository project.
In OpenIDEA each root also tells its current `branch` (absent when HEAD is detached), `headCommit` and a merge, \
rebase or cherry-pick in progress (`operationInProgress`).",
        |call| async move {
            let roots = ide_host::ops::vcs::vcs_roots(&call.host(), call.window())?;
            let list: Vec<Value> = roots
                .into_iter()
                .map(|r| {
                    let mut v =
                        json!({ "pathRelativeToProject": relative_to_project(&call, &r.root), "vcsName": "Git" });
                    if let Some(head) = r.head {
                        v["branch"] = head.into();
                    }
                    if let Some(commit) = r.head_commit {
                        v["headCommit"] = commit.into();
                    }
                    if let Some(op) = r.operation {
                        v["operationInProgress"] = op.into();
                    }
                    v
                })
                .collect();
            Output::json(json!({ "roots": list }))
        },
    )
}

/// One entry of `git status --porcelain -z`.
#[derive(Debug, PartialEq)]
struct StatusEntry {
    index: char,
    work_tree: char,
    path: String,
    orig_path: Option<String>,
}

impl StatusEntry {
    fn untracked(&self) -> bool {
        self.index == '?'
    }
    fn ignored(&self) -> bool {
        self.index == '!'
    }
    fn conflicted(&self) -> bool {
        matches!((self.index, self.work_tree), ('D', 'D') | ('A', 'U') | ('U', _) | ('A', 'A') | ('D', 'U'))
    }
    fn staged(&self) -> bool {
        !self.conflicted() && !matches!(self.index, ' ' | '?' | '!')
    }
    fn unstaged(&self) -> bool {
        !self.conflicted() && !matches!(self.work_tree, ' ' | '?' | '!')
    }
}

fn parse_status(out: &str) -> Vec<StatusEntry> {
    let mut fields = out.split('\0').filter(|f| !f.is_empty());
    let mut entries = Vec::new();
    while let Some(field) = fields.next() {
        let mut chars = field.chars();
        let (Some(index), Some(work_tree)) = (chars.next(), chars.next()) else { continue };
        let path = field.get(3..).unwrap_or_default().to_owned();
        let orig_path = matches!(index, 'R' | 'C').then(|| fields.next().map(str::to_owned)).flatten();
        entries.push(StatusEntry { index, work_tree, path, orig_path });
    }
    entries
}

fn git_executable(call: &Call) -> String {
    let exe = call.project().settings.effective().vcs.git.executable.trim().to_owned();
    if exe.is_empty() { "git".to_owned() } else { exe }
}

/// `git status` of the repository at `root`, paths relative to it.
fn read_status(git: &str, root: &Path, untracked: bool, ignored: bool) -> IdeResult<Vec<StatusEntry>> {
    let mut cmd = std::process::Command::new(git);
    cmd.current_dir(root).args(["-c", "core.quotepath=false", "status", "--porcelain", "-z", "--find-renames"]);
    // git refuses `--ignored=matching` with `--untracked-files=no`: untracked files are dropped below.
    cmd.arg(if untracked || ignored { "--untracked-files=all" } else { "--untracked-files=no" });
    if ignored {
        cmd.arg("--ignored=matching");
    }
    ide_core::process::prepare(&mut cmd);
    let out = cmd.output().map_err(|e| IdeError::unavailable(format!("cannot run git: {e}")))?;
    if !out.status.success() {
        return Err(IdeError::internal(String::from_utf8_lossy(&out.stderr).trim().to_owned()));
    }
    let mut entries = parse_status(&String::from_utf8_lossy(&out.stdout));
    entries.retain(|e| untracked || !e.untracked());
    Ok(entries)
}

/// A git repository in the project, for paths outside the repositories IDEA knows: the
/// closest folder with `.git` from `start` up to the project root.
fn find_git_root(root: &Path, start: &Path) -> Option<PathBuf> {
    let mut current = if start.is_dir() { start } else { start.parent().unwrap_or(start) };
    while current.starts_with(root) {
        if current.join(".git").exists() {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
    None
}

fn git_status() -> Tool {
    Tool::new(
        "git_status",
        McpToolKind::Read,
        "Retrieves Git status for one or more repositories in the current project.
Returns porcelain-style index/worktree status codes and summary counters.
By default all Git repositories are returned.",
        |call| async move {
            let include_untracked = call.flag("includeUntracked", true)?;
            let include_ignored = call.flag("includeIgnored", false)?;
            let limit = call.opt_i64("limit")?.unwrap_or(STATUS_DEFAULT_LIMIT);
            if limit <= 0 {
                return Err(IdeError::invalid("limit must be > 0"));
            }
            let limit = limit as usize;
            let host = call.host();
            let repos: Vec<(PathBuf, Option<String>)> = ide_host::ops::vcs::vcs_roots(&host, call.window())?
                .into_iter()
                .map(|r| (r.root.into_path_buf(), r.head))
                .collect();
            let wanted = call.opt_str("repositoryPathRelativeToProject")?;
            let mut roots: Vec<(PathBuf, Option<String>)> = match &wanted {
                None => repos,
                Some(wanted) => {
                    let path = call.resolve_inside(wanted)?;
                    // The innermost repository containing the path.
                    match repos.into_iter().filter(|r| path.starts_with(&r.0)).max_by_key(|r| r.0.components().count())
                    {
                        Some(repo) => vec![repo],
                        None => match find_git_root(call.root(), &path) {
                            Some(root) => vec![(root, None)],
                            None => {
                                return Err(IdeError::not_found(format!("No git repository found for path: {wanted}")));
                            }
                        },
                    }
                }
            };
            roots.sort_by_key(|r| relative_to_project(&call, &r.0));
            let git = git_executable(&call);
            let mut repositories = Vec::new();
            for (root, branch) in roots {
                let rel = relative_to_project(&call, &root);
                let (git, dir) = (git.clone(), root.clone());
                let entries = host
                    .blocking(move || read_status(&git, &dir, include_untracked, include_ignored))
                    .await
                    .map_err(|e| {
                        IdeError::internal(format!("Failed to get git status for repository '{rel}': {}", e.message))
                    })?;
                let count = |f: fn(&StatusEntry) -> bool| entries.iter().filter(|e| f(e)).count();
                let listed: Vec<Value> = entries
                    .iter()
                    .take(limit)
                    .map(|e| {
                        let mut v = json!({
                            "pathRelativeToRepository": e.path.trim_end_matches('/'),
                            "indexStatus": e.index.to_string(),
                            "workTreeStatus": e.work_tree.to_string(),
                        });
                        if let Some(orig) = &e.orig_path {
                            v["originalPathRelativeToRepository"] = orig.clone().into();
                        }
                        v
                    })
                    .collect();
                repositories.push(json!({
                    "repositoryPathRelativeToProject": rel,
                    "currentBranch": branch,
                    "isClean": entries.is_empty(),
                    "totalEntries": entries.len(),
                    "hasMoreEntries": entries.len() > listed.len(),
                    "stagedCount": count(StatusEntry::staged),
                    "unstagedCount": count(StatusEntry::unstaged),
                    "untrackedCount": count(StatusEntry::untracked),
                    "ignoredCount": count(StatusEntry::ignored),
                    "conflictedCount": count(StatusEntry::conflicted),
                    "entries": listed,
                }));
            }
            Output::json(json!({ "repositories": repositories }))
        },
    )
    .param(Param::optional(
        "repositoryPathRelativeToProject",
        ParamType::String,
        "Optional path relative to project root used to select a single containing repository",
    ))
    .param(Param::optional("includeUntracked", ParamType::Boolean, "Whether to include untracked files"))
    .param(Param::optional("includeIgnored", ParamType::Boolean, "Whether to include ignored files"))
    .param(Param::optional("limit", ParamType::Integer, "Maximum number of entries returned per repository"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_z_with_renames() {
        let out = "M  a.txt\0R  new.txt\0old.txt\0?? u.txt\0UU c.txt\0";
        let e = parse_status(out);
        assert_eq!(e.len(), 4);
        assert_eq!(e[1].path, "new.txt");
        assert_eq!(e[1].orig_path.as_deref(), Some("old.txt"));
        assert!(e[0].staged() && !e[0].unstaged());
        assert!(e[2].untracked() && !e[2].staged());
        assert!(e[3].conflicted() && !e[3].staged() && !e[3].unstaged());
    }
}
