//! Version control: repositories and status.

use crate::tool::{Output, Param, ParamType, Tool};
use ide_core::mcp::McpToolKind;
use ide_core::{IdeError, IdeResult};
use ide_vcs::{ChangeKind, FileStatus};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

const STATUS_DEFAULT_LIMIT: usize = 1000;
const STATUS_MAX_LIMIT: usize = 10_000;

pub fn tools() -> Vec<Tool> {
    vec![get_repositories(), git_status()]
}

fn get_repositories() -> Tool {
    Tool::new(
        "get_repositories",
        McpToolKind::Read,
        "Lists the version control repositories (VCS roots) of the project, the main one first: \
`path` relative to the project root (`.` for the root), `vcs` (git), the current `branch` (absent when HEAD is \
detached), the HEAD commit and a merge/rebase/cherry-pick in progress, if any.",
        |call| async move {
            let roots = ide_host::ops::vcs::vcs_roots(&call.host(), call.window())?;
            let list: Vec<Value> = roots
                .into_iter()
                .map(|r| {
                    let mut v = json!({ "path": call.display(&r.root), "vcs": "git" });
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
            Output::json(json!({ "repositories": list }))
        },
    )
}

/// One status column of `git status --porcelain`.
fn code(kind: Option<ChangeKind>) -> char {
    match kind {
        Some(ChangeKind::Added) => 'A',
        Some(ChangeKind::Modified) => 'M',
        Some(ChangeKind::Deleted) => 'D',
        Some(ChangeKind::Renamed) => 'R',
        Some(ChangeKind::Untracked) => '?',
        Some(ChangeKind::Ignored) => '!',
        Some(ChangeKind::Conflicted) => 'U',
        None => ' ',
    }
}

/// The porcelain two-letter code of a file (`M `, ` M`, `??`, `UU`...).
fn porcelain(f: &FileStatus) -> String {
    match f.unstaged {
        Some(ChangeKind::Untracked) => "??".into(),
        Some(ChangeKind::Ignored) => "!!".into(),
        Some(ChangeKind::Conflicted) => "UU".into(),
        _ => format!("{}{}", code(f.staged), code(f.unstaged)),
    }
}

/// Untracked ignored files and folders of `repo` (`git ls-files --others --ignored --directory`).
fn ignored_files(repo: &Path, git: &str) -> IdeResult<Vec<String>> {
    let mut cmd = std::process::Command::new(git);
    cmd.current_dir(repo).args(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
    ide_core::process::prepare(&mut cmd);
    let out = cmd.output().map_err(|e| IdeError::unavailable(format!("cannot run git: {e}")))?;
    if !out.status.success() {
        return Err(IdeError::internal(String::from_utf8_lossy(&out.stderr).trim().to_owned()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).split('\0').filter(|s| !s.is_empty()).map(str::to_owned).collect())
}

fn git_status() -> Tool {
    Tool::new(
        "git_status",
        McpToolKind::Read,
        "Shows the working tree status of the project's git repositories, like `git status --porcelain`: per \
repository, its files with the two-letter code `status` (index column, then working tree column: `M ` staged \
modification, ` M` unstaged, `A ` added, `D`, `R ` renamed (with `origPath`), `??` untracked, `!!` ignored, `UU` \
conflicted), and `summary` counters (staged, unstaged, untracked, conflicted, ignored). Paths are project-relative. \
`limit` caps the files listed per repository (default 1000); the counters always cover every file.",
        |call| async move {
            let include_untracked = call.flag("includeUntracked", true)?;
            let include_ignored = call.flag("includeIgnored", false)?;
            let limit = call.count("limit", STATUS_DEFAULT_LIMIT, STATUS_MAX_LIMIT)?;
            let host = call.host();
            let all_roots: Vec<PathBuf> = ide_host::ops::vcs::vcs_roots(&host, call.window())?
                .into_iter()
                .map(|r| r.root.into_path_buf())
                .collect();
            if all_roots.is_empty() {
                return Err(IdeError::unavailable("The project is not under git version control."));
            }
            let roots = match call.opt_str("repositoryPathRelativeToProject")?.filter(|p| !p.trim().is_empty()) {
                Some(wanted) => {
                    let wanted = call.resolve(&wanted)?;
                    let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
                    match all_roots.iter().find(|r| canon(r) == canon(&wanted)) {
                        Some(r) => vec![r.clone()],
                        None => {
                            let all: Vec<_> = all_roots.iter().map(|r| call.display(r)).collect();
                            return Err(IdeError::not_found(format!(
                                "{} is not a repository of the project. Repositories: {}",
                                call.display(&wanted),
                                all.join(", ")
                            )));
                        }
                    }
                }
                None => all_roots.clone(),
            };
            let files = ide_host::ops::vcs::status(&host, call.window()).await?;
            let git = {
                let exe = call.project().settings.effective().vcs.git.executable.trim().to_owned();
                if exe.is_empty() { "git".to_owned() } else { exe }
            };
            let ignored = if include_ignored {
                let roots = roots.clone();
                host.blocking(move || roots.iter().map(|r| ignored_files(r, &git)).collect::<IdeResult<Vec<_>>>())
                    .await?
            } else {
                vec![Vec::new(); roots.len()]
            };

            // Files belong to the innermost repository containing them.
            let owner = |path: &Path| {
                all_roots.iter().filter(|r| path.starts_with(r)).max_by_key(|r| r.components().count()).cloned()
            };
            let mut repos = Vec::new();
            for (root, ignored) in roots.iter().zip(ignored) {
                let mut counts = [0usize; 5];
                let mut entries = Vec::new();
                let mut matched = 0usize;
                let mut push = |v: Value, entries: &mut Vec<Value>| {
                    matched += 1;
                    if entries.len() < limit {
                        entries.push(v);
                    }
                };
                for f in files.iter().filter(|f| owner(&f.path).as_deref() == Some(root.as_path())) {
                    let untracked = f.unstaged == Some(ChangeKind::Untracked);
                    if untracked && !include_untracked {
                        continue;
                    }
                    match f.unstaged {
                        Some(ChangeKind::Untracked) => counts[2] += 1,
                        Some(ChangeKind::Conflicted) => counts[3] += 1,
                        Some(_) => counts[1] += 1,
                        None => {}
                    }
                    if f.staged.is_some() {
                        counts[0] += 1;
                    }
                    let mut v = json!({ "path": call.display(&f.path), "status": porcelain(f) });
                    if let Some(from) = &f.renamed_from {
                        v["origPath"] = call.display(&root.join(from)).into();
                    }
                    push(v, &mut entries);
                }
                for rel in &ignored {
                    counts[4] += 1;
                    push(json!({ "path": call.display(&root.join(rel)), "status": "!!" }), &mut entries);
                }
                let mut repo = Map::new();
                repo.insert("path".into(), call.display(root).into());
                if let Ok(info) = ide_host::ops::vcs::vcs_branch_info(&host, call.window(), Some(root.clone())).await {
                    if let Some(head) = info.head {
                        repo.insert("branch".into(), head.into());
                    }
                    if let Some(up) = info.upstream {
                        repo.insert("upstream".into(), up.into());
                        repo.insert("ahead".into(), info.ahead.into());
                        repo.insert("behind".into(), info.behind.into());
                    }
                }
                let truncated = matched > entries.len();
                repo.insert("files".into(), entries.into());
                repo.insert(
                    "summary".into(),
                    json!({
                        "staged": counts[0],
                        "unstaged": counts[1],
                        "untracked": counts[2],
                        "conflicted": counts[3],
                        "ignored": counts[4],
                        "clean": counts.iter().all(|c| *c == 0),
                    }),
                );
                if truncated {
                    repo.insert("truncated".into(), true.into());
                }
                repos.push(Value::Object(repo));
            }
            Output::json(json!({ "repositories": repos }))
        },
    )
    .param(Param::optional(
        "repositoryPathRelativeToProject",
        ParamType::String,
        "Only this repository (its path as get_repositories lists it); default: all of them",
    ))
    .param(Param::optional("includeUntracked", ParamType::Boolean, "List untracked files (default true)"))
    .param(Param::optional("includeIgnored", ParamType::Boolean, "List ignored untracked files (default false)"))
    .param(Param::optional("limit", ParamType::Integer, "Most files listed per repository (default 1000)"))
}
