// Ported from JetBrains intellij-community plugins/mcp-server
// (mcpserver.vcs/src/com/intellij/mcpserver/toolsets/vcs/VcsToolset.kt), Apache-2.0.
//! Version control: repositories and git status.

use crate::mcp::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::{IdeError, IdeResult};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const STATUS_DEFAULT_LIMIT: i64 = 1000;

pub fn tools() -> Vec<Tool> {
    vec![get_repositories(), git_status(), git_diff()]
}

/// `path` with symbolic links resolved (macOS `/var` is `/private/var`), as given when it
/// does not exist.
fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// A path relative to the project root with `/`; empty for the root itself. Either may
/// name the other through a symbolic link.
fn relative_to(root: &Path, path: &Path) -> String {
    let rel = match path.strip_prefix(root) {
        Ok(rel) => Some(rel.to_path_buf()),
        Err(_) => canonical(path).strip_prefix(canonical(root)).ok().map(Path::to_path_buf),
    };
    match rel {
        Some(rel) => rel.to_string_lossy().replace('\\', "/"),
        None => path.to_string_lossy().into_owned(),
    }
}

fn relative_to_project(call: &Call, path: &Path) -> String {
    relative_to(call.root(), path)
}

/// The repository whose roots contain `path` most specifically (paths compared canonically).
fn innermost_repo<T>(repos: Vec<(PathBuf, T)>, path: &Path) -> Option<(PathBuf, T)> {
    let path = canonical(path);
    repos.into_iter().filter(|r| path.starts_with(canonical(&r.0))).max_by_key(|r| canonical(&r.0).components().count())
}

// Read tools must never invoke repository-configured executables, including in Restricted Mode.
fn read_command(git: &str, root: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(git);
    ide_vcs::restrict(&mut command);
    command
        .current_dir(root)
        .args(["-c", "color.ui=false"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    ide_core::process::prepare(&mut command);
    command
}

/// `-c` arguments that empty the clean and process filters the repository's own config names:
/// git runs them to compare a changed file with the index. Filters of the user's config stay
/// (Git LFS), as they are not the repository's choice.
fn filter_overrides(git: &str, root: &Path) -> IdeResult<Vec<String>> {
    let mut cmd = read_command(git, root);
    cmd.args(["config", "--null", "--list", "--show-scope"]);
    let out = cmd.output().map_err(|e| IdeError::unavailable(format!("cannot run git: {e}")))?;
    if !out.status.success() {
        return Err(IdeError::internal(String::from_utf8_lossy(&out.stderr).trim().to_owned()));
    }
    repository_filter_overrides(&out.stdout)
}

/// [`filter_overrides`] out of `listing`, the output of `git config --null --list --show-scope`.
fn repository_filter_overrides(listing: &[u8]) -> IdeResult<Vec<String>> {
    let mut fields = listing.split(|b| *b == 0);
    let mut own = Vec::new();
    while let (Some(scope), Some(record)) = (fields.next(), fields.next()) {
        if matches!(scope, b"local" | b"worktree") {
            own.extend_from_slice(record);
            own.push(0);
        }
    }
    ide_vcs::filter_overrides_from(&own)
}

/// The branch HEAD is on (unborn too); `None` when HEAD is detached or git fails.
fn read_branch(git: &str, root: &Path) -> Option<String> {
    let mut cmd = read_command(git, root);
    cmd.args(["symbolic-ref", "--short", "-q", "HEAD"]);
    ide_core::process::prepare(&mut cmd);
    let out = cmd.output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|b| !b.is_empty())
}

fn get_repositories() -> Tool {
    Tool::new(
        "get_repositories",
        "Retrieves the list of VCS roots in the project.
This is useful to detect all repositories in a multi-repository project.
In OpenIDEA each root also tells its current `branch` (absent when HEAD is detached), `headCommit` and a merge, \
rebase or cherry-pick in progress (`operationInProgress`).",
        |call| async move {
            let host = call.host();
            let window = call.window.clone();
            let roots = call.host.blocking(move || crate::ops::vcs::vcs_roots(&host, &window)).await?;
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
    let settings = if call.project.is_trusted() {
        call.project.settings.effective()
    } else {
        call.host.global_settings.effective()
    };
    let exe = settings.vcs.git.executable.trim().to_owned();
    if exe.is_empty() { "git".to_owned() } else { exe }
}

/// `git status` of the repository at `root`, paths relative to it.
fn read_status(git: &str, root: &Path, untracked: bool, ignored: bool) -> IdeResult<Vec<StatusEntry>> {
    let mut cmd = read_command(git, root);
    cmd.args(filter_overrides(git, root)?);
    cmd.args(["-c", "core.quotepath=false", "status", "--porcelain", "-z", "--find-renames"]);
    // git asks a submodule with changes for its own status, which runs under the submodule's config.
    cmd.arg("--ignore-submodules=dirty");
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

/// `git diff` of the repository at `root` (of `file` alone, when given): the index against HEAD
/// when `staged`, else disk against the index.
fn read_diff(
    git: &str,
    root: &Path,
    file: Option<&Path>,
    staged: bool,
    cancel: &ide_core::CancellationToken,
) -> IdeResult<String> {
    let mut cmd = read_command(git, root);
    cmd.args(filter_overrides(git, root)?);
    cmd.args(["--no-pager", "diff", "--no-ext-diff", "--no-textconv"]);
    // git asks a submodule with changes for its own status, and for its own diff when the
    // repository's `diff.submodule` says so: both run under the submodule's config.
    cmd.args(["--ignore-submodules=dirty", "--submodule=short"]);
    if staged {
        cmd.arg("--cached");
    }
    cmd.arg("--");
    if let Some(file) = file {
        cmd.arg(file.strip_prefix(root).map_err(|e| IdeError::invalid(e.to_string()))?);
    }
    ide_core::process::prepare(&mut cmd);
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let out = cmd.output()?;
    if !out.status.success() {
        return Err(IdeError::unavailable(String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// A git repository in the project, for paths outside the repositories IDEA knows: the
/// closest folder with `.git` from `start` up to the project root.
fn find_git_root(root: &Path, start: &Path) -> Option<PathBuf> {
    let (root, start) = (canonical(root), canonical(start));
    let mut current = if start.is_dir() { start.as_path() } else { start.parent().unwrap_or(&start) };
    while current.starts_with(&root) {
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
            let h = host.clone();
            let w = call.window.clone();
            let repos: Vec<(PathBuf, Option<String>)> = host
                .blocking(move || crate::ops::vcs::vcs_roots(&h, &w))
                .await?
                .into_iter()
                .map(|r| (r.root.into_path_buf(), r.head))
                .collect();
            let wanted = call.opt_str("repositoryPathRelativeToProject")?;
            let git = git_executable(&call);
            let mut roots: Vec<(PathBuf, Option<String>)> = match &wanted {
                None => repos,
                Some(wanted) => {
                    let path = call.resolve_inside(wanted)?;
                    // The innermost repository containing the path.
                    match innermost_repo(repos, &path) {
                        Some(repo) => vec![repo],
                        None => match find_git_root(call.root(), &path) {
                            Some(root) => {
                                // JetBrains reads the branch of any repository it reports.
                                let (git, dir) = (git.clone(), root.clone());
                                let branch = host.blocking(move || Ok(read_branch(&git, &dir))).await?;
                                vec![(root, branch)]
                            }
                            None => {
                                return Err(IdeError::not_found(format!("No git repository found for path: {wanted}")));
                            }
                        },
                    }
                }
            };
            roots.sort_by_key(|r| relative_to_project(&call, &r.0));
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

fn git_diff() -> Tool {
    Tool::new("git_diff", "Read a Git diff for a file or the working tree. staged=true compares the index with HEAD; otherwise compares disk with the index. Unsaved editor text is not part of this diff.", |call| async move {
        let wanted = call.opt_str("repositoryPathRelativeToProject")?;
        let path = wanted.as_deref().map(|p| call.resolve_inside(p)).transpose()?.unwrap_or_else(|| call.root().to_path_buf());
        let root = find_git_root(call.root(), &path).ok_or_else(|| IdeError::not_found("No git repository found"))?;
        let file = call.opt_str("filePath")?.map(|p| call.resolve_inside(&p)).transpose()?;
        if file.as_ref().is_some_and(|p| !p.starts_with(&root)) { return Err(IdeError::invalid("file is outside the repository")); }
        let staged = call.flag("staged", false)?;
        let git = git_executable(&call);
        let cancel = call.cancel.clone();
        let text = call.host.blocking(move || read_diff(&git, &root, file.as_deref(), staged, &cancel)).await?;
        Ok(Output::text(text))
    })
    .param(Param::optional("repositoryPathRelativeToProject", ParamType::String, "Select the containing repository"))
    .param(Param::optional("filePath", ParamType::String, "Optional project-relative file; omit for the working tree"))
    .param(Param::optional("staged", ParamType::Boolean, "Show staged changes"))
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

    /// Security audit lead 2 (variant): reading status or a diff must not run the repository's filters.
    #[test]
    fn status_and_diff_do_not_run_repository_filters() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").current_dir(&root).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@example.test"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join(".gitattributes"), "*.txt filter=marker\n").unwrap();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "init"]);
        git(&["config", "filter.marker.clean", "echo x > executed-marker; cat"]);
        git(&["config", "filter.marker.process", "echo x > executed-marker; cat"]);
        git(&["config", "filter.marker.required", "true"]);
        let marker = root.join("executed-marker");
        let mut ran = Vec::new();
        // The size it has in the index, so git has to read the file to tell whether it changed.
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        let status = read_status("git", &root, false, false);
        if marker.exists() {
            ran.push("status");
        }
        let _ = std::fs::remove_file(&marker);
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let diff = read_diff("git", &root, None, false, &ide_core::CancellationToken::new());
        if marker.exists() {
            ran.push("diff");
        }
        // Control: the fixture's filter really runs when git is used directly.
        let _ = std::fs::remove_file(&marker);
        std::fs::write(root.join("a.txt"), "six\n").unwrap();
        let _ = std::process::Command::new("git").current_dir(&root).args(["status", "--porcelain"]).output();
        assert!(marker.exists(), "control: plain `git status` did not run the filter, fixture is not live");
        assert!(ran.is_empty(), "a read tool ran the repository's filter via: {ran:?}");
        assert_eq!(status.unwrap().len(), 1);
        let diff = diff.unwrap();
        assert!(diff.contains("+three"), "{diff}");
    }

    #[test]
    fn only_filters_of_the_repository_s_own_config_are_emptied() {
        let listing = b"system\0filter.lfs.clean\ngit-lfs clean -- %f\0\
            global\0filter.lfs.process\ngit-lfs filter-process\0\
            global\0filter.lfs.required\ntrue\0\
            local\0core.bare\nfalse\0\
            local\0filter.a.clean\nx\0\
            worktree\0filter.b.process\ny\0\
            local\0filter.a.required\ntrue\0\
            command\0filter.c.clean\nz\0";
        assert_eq!(
            repository_filter_overrides(listing).unwrap(),
            ["-c", "filter.a.clean=", "-c", "filter.b.process=", "-c", "filter.a.required=false"]
        );
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A repository at `dir` with `a.txt` committed.
    fn repository(dir: &Path, attributes: &[u8]) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.email", "t@example.test"]);
        git(dir, &["config", "user.name", "t"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join(".gitattributes"), attributes).unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "init"]);
    }

    /// A shell command that leaves `marker` behind and passes its input on.
    fn leaves(marker: &Path) -> String {
        format!("echo x > '{}'; cat", marker.to_string_lossy().replace('\\', "/"))
    }

    /// Whether a program of the fixture left `marker` behind; removes it.
    fn left(marker: &Path) -> bool {
        let was = marker.exists();
        let _ = std::fs::remove_file(marker);
        was
    }

    /// Reads the status and then the diff of `root` after rewriting `file`, then has plain git
    /// read the status as a control. Each write keeps the size the file has in the index, so git
    /// has to read it to tell whether it changed.
    fn read_both(root: &Path, file: &Path, marker: &Path) -> (IdeResult<Vec<StatusEntry>>, IdeResult<String>) {
        let mut ran = Vec::new();
        std::fs::write(file, "two\n").unwrap();
        let status = read_status("git", root, false, false);
        if left(marker) {
            ran.push("status");
        }
        std::fs::write(file, "six\n").unwrap();
        let diff = read_diff("git", root, None, false, &ide_core::CancellationToken::new());
        if left(marker) {
            ran.push("diff");
        }
        std::fs::write(file, "ten\n").unwrap();
        let _ = std::process::Command::new("git").current_dir(root).args(["status", "--porcelain"]).output();
        assert!(left(marker), "control: plain `git status` ran no program of the fixture, it is not live");
        assert!(ran.is_empty(), "a read tool ran a program of the repository via: {ran:?}");
        (status, diff)
    }

    #[test]
    fn status_and_diff_do_not_run_filters_of_any_repository_config() {
        type Configure = fn(&Path, &str);
        let cases: [(&str, Configure); 4] = [
            ("clean", |root, command| git(root, &["config", "filter.marker.clean", command])),
            ("process", |root, command| git(root, &["config", "filter.marker.process", command])),
            ("included file", |root, command| {
                let included = format!("[filter \"marker\"]\n\tclean = \"{command}\"\n");
                std::fs::write(root.join("extra.gitconfig"), included).unwrap();
                git(root, &["config", "include.path", "../extra.gitconfig"]);
            }),
            ("worktree config", |root, command| {
                git(root, &["config", "extensions.worktreeConfig", "true"]);
                git(root, &["config", "--worktree", "filter.marker.clean", command]);
            }),
        ];
        for (case, configure) in cases {
            let dir = tempfile::tempdir().unwrap();
            let root = dunce::canonicalize(dir.path()).unwrap().join("repo");
            let marker = root.with_file_name("marker");
            repository(&root, b"*.txt filter=marker\n");
            configure(&root, &leaves(&marker));
            let (status, diff) = read_both(&root, &root.join("a.txt"), &marker);
            assert_eq!(status.unwrap().len(), 1, "{case}");
            let diff = diff.unwrap();
            assert!(diff.contains("+six"), "{case}: {diff}");
        }
    }

    /// git splits `-c name=value` at the first `=` and takes no name that is not UTF-8 on every
    /// platform, so such a filter cannot be emptied: the tools read nothing instead.
    #[test]
    fn status_and_diff_refuse_a_repository_filter_git_cannot_be_told_to_skip() {
        for name in [&b"x=y"[..], &[0xE9]] {
            let dir = tempfile::tempdir().unwrap();
            let root = dunce::canonicalize(dir.path()).unwrap().join("repo");
            let marker = root.with_file_name("marker");
            repository(&root, &[b"*.txt filter=", name, b"\n"].concat());
            let section =
                [b"[filter \"", name, format!("\"]\n\tclean = \"{}\"\n", leaves(&marker)).as_bytes()].concat();
            let config = root.join(".git").join("config");
            std::fs::write(&config, [std::fs::read(&config).unwrap(), section].concat()).unwrap();
            let (status, diff) = read_both(&root, &root.join("a.txt"), &marker);
            assert!(status.is_err() && diff.is_err(), "{name:?}");
        }
    }

    /// git asks a submodule for its own status to tell whether it is dirty, under the
    /// submodule's config.
    #[test]
    fn status_and_diff_do_not_run_filters_of_a_submodule() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap().join("repo");
        let (sub, marker) = (root.join("sub"), root.with_file_name("marker"));
        repository(&root, b"");
        repository(&sub, b"*.txt filter=marker\n");
        git(&root, &["add", "sub"]);
        git(&root, &["commit", "-qm", "submodule"]);
        git(&sub, &["config", "filter.marker.clean", &leaves(&marker)]);
        git(&root, &["config", "diff.ignoreSubmodules", "none"]);
        git(&root, &["config", "submodule.sub.ignore", "none"]);
        let (status, diff) = read_both(&root, &sub.join("a.txt"), &marker);
        status.unwrap();
        diff.unwrap();
    }

    /// `git diff` writes the index back when it finds a file whose stat changed and whose content
    /// did not, and git runs the hooks a config names for `post-index-change` on that write.
    #[test]
    fn status_and_diff_do_not_run_hooks_of_the_repository_s_config() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap().join("repo");
        let marker = root.with_file_name("marker");
        repository(&root, b"");
        git(&root, &["config", "hook.marker.event", "post-index-change"]);
        let command = format!("echo x > '{}'", marker.to_string_lossy().replace('\\', "/"));
        git(&root, &["config", "hook.marker.command", &command]);
        let listed = std::process::Command::new("git")
            .current_dir(&root)
            .args(["hook", "list", "post-index-change"])
            .output()
            .unwrap();
        if !String::from_utf8_lossy(&listed.stdout).contains("marker") {
            return; // This git has no hooks named by a config.
        }
        // The content it has in the index, with a time of its own that is not the index's.
        let touch = |seconds: u64| {
            let file = std::fs::File::options().write(true).open(root.join("a.txt")).unwrap();
            file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(seconds)).unwrap();
        };
        let mut ran = Vec::new();
        touch(60);
        let status = read_status("git", &root, false, false);
        if left(&marker) {
            ran.push("status");
        }
        touch(120);
        let diff = read_diff("git", &root, None, false, &ide_core::CancellationToken::new());
        if left(&marker) {
            ran.push("diff");
        }
        touch(180);
        let _ = std::process::Command::new("git").current_dir(&root).args(["--no-pager", "diff"]).output();
        assert!(left(&marker), "control: plain `git diff` did not run the hook, fixture is not live");
        assert!(ran.is_empty(), "a read tool ran a hook of the repository's config via: {ran:?}");
        assert!(status.unwrap().is_empty());
        assert_eq!(diff.unwrap(), "");
    }

    /// `diff.submodule=diff` has git run `git diff` in the submodule, under the submodule's config.
    #[test]
    fn diff_does_not_run_a_diff_driver_of_a_submodule() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap().join("repo");
        let (sub, marker) = (root.join("sub"), root.with_file_name("marker"));
        repository(&root, b"");
        repository(&sub, b"*.txt diff=marker\n");
        git(&root, &["add", "sub"]);
        git(&root, &["commit", "-qm", "submodule"]);
        std::fs::write(sub.join("a.txt"), "one\ntwo\n").unwrap();
        git(&sub, &["commit", "-qam", "second"]);
        git(&sub, &["config", "diff.marker.command", &leaves(&marker)]);
        git(&root, &["config", "diff.submodule", "diff"]);
        let diff = read_diff("git", &root, None, false, &ide_core::CancellationToken::new());
        let ran = left(&marker);
        let _ = std::process::Command::new("git").current_dir(&root).args(["--no-pager", "diff"]).output();
        assert!(left(&marker), "control: plain `git diff` did not run the diff driver, fixture is not live");
        assert!(!ran, "git_diff ran the submodule's diff driver");
        let diff = diff.unwrap();
        assert!(diff.contains("Subproject commit"), "{diff}");
        assert_eq!(read_status("git", &root, false, false).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn paths_through_a_symlinked_root_compare_canonically() {
        // As macOS `/var` → `/private/var`: the project opened through the link, git reporting real paths.
        let dir = tempfile::tempdir().unwrap();
        let real = dunce::canonicalize(dir.path()).unwrap().join("real");
        std::fs::create_dir_all(real.join("sub/.git")).unwrap();
        std::fs::write(real.join("sub/f.txt"), "x").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(relative_to(&link, &real.join("sub")), "sub");
        assert_eq!(relative_to(&real, &link.join("sub")), "sub");
        assert_eq!(relative_to(&link, &link), "");
        let repos = vec![(real.clone(), 1), (real.join("sub"), 2)];
        assert_eq!(innermost_repo(repos, &link.join("sub/f.txt")).map(|r| r.1), Some(2));
        assert_eq!(find_git_root(&link, &real.join("sub/f.txt")), Some(real.join("sub")));
    }
}
