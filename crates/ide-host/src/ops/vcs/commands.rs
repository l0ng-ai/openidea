#[allow(unused_imports)]
use super::*;
use crate::Host;
use crate::Project;
use crate::ops::Channel;
use crate::rpc::Dispatcher;
use ide_core::{IdeResult, RequestId};
use ide_vcs::*;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

use crate::apply_git_executable;

/// A repository of the project (IDEA's VCS root).
#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VcsRoot {
    /// Worktree root.
    pub root: ide_core::IpcPath,
    /// Merge / rebase / cherry-pick / revert in progress.
    pub operation: Option<String>,
    /// Current branch; `None` when HEAD is detached (or unreadable).
    pub head: Option<String>,
    /// HEAD commit; `None` before the first commit.
    pub head_commit: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum RemoteOp {
    Fetch,
    Pull {
        rebase: bool,
    },
    Push {
        force_with_lease: bool,
        set_upstream: bool,
        /// Push dialog › Push tags.
        #[serde(default)]
        tags: Option<PushTags>,
    },
    /// Deletes a remote branch; `branch` is the remote-tracking name (`origin/feature`).
    DeleteBranch {
        branch: String,
    },
    /// Pushes local `branch` (only up to `revision` when set) to its upstream, or to
    /// remote branch `target` of the same remote.
    PushBranch {
        branch: String,
        revision: Option<String>,
        force_with_lease: bool,
        #[serde(default)]
        target: Option<String>,
    },
    /// Fast-forwards local `branch` (not checked out) to its upstream.
    UpdateBranch {
        branch: String,
    },
    /// Pull dialog: `branches` of `remote` (none = the configured merge branch).
    PullFrom {
        remote: String,
        branches: Vec<String>,
        rebase: bool,
        options: MergeOptions,
    },
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitExecutableInfo {
    /// `git version …` output.
    pub version: String,
    /// The executable that was run.
    pub path: String,
}

// ---- in-progress operations, history rewriting (Git Log actions) ----

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum GitOperation {
    /// Continue the merge / rebase / cherry-pick / revert in progress.
    Continue,
    Abort,
    Skip,
    /// Commits oldest first.
    CherryPick {
        commits: Vec<String>,
    },
    /// Commits newest first.
    Revert {
        commits: Vec<String>,
    },
    Reset {
        commit: String,
        mode: ResetMode,
    },
    /// Rebases `base..HEAD` (`base: None` = from the root) following `entries`, oldest first.
    InteractiveRebase {
        base: Option<String>,
        entries: Vec<RebaseEntry>,
    },
}

/// Runs `f` once per repository with the `paths` that belong to it.
fn per_repo(
    project: &Project,
    paths: &[PathBuf],
    recorded: Option<&str>,
    f: impl Fn(&Repo, &[PathBuf]) -> IdeResult<()>,
) -> IdeResult<()> {
    let groups = project.repos().group(paths);
    if groups.is_empty() {
        return project.with_repo_recorded(None, recorded, |r| f(r, paths));
    }
    for (repo, paths) in groups {
        project.with_repo_recorded(Some(repo.root()), recorded, |r| f(r, &paths))?;
    }
    Ok(())
}

/// Shelf and patches work in the primary repository only: changes of a nested one
/// fail instead of being left out silently.
fn in_primary_repo(project: &Project, paths: &[PathBuf]) -> IdeResult<()> {
    let repos = project.repos();
    let primary = repos.primary().map(|r| r.root());
    match paths.iter().find(|p| repos.for_path(p).map(|r| r.root()) != primary) {
        Some(p) => Err(ide_core::IdeError::invalid(format!(
            "{} is in another git repository; shelving and patches support the project's main repository only",
            p.display()
        ))),
        None => Ok(()),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

// ---- patches ----

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "from", rename_all = "camelCase")]
pub enum PatchSource {
    /// Local changes of these files (absolute paths).
    Changes { paths: Vec<ide_core::IpcPath>, reverse: bool },
    /// Changes made by these commits (oldest first).
    Commits { commits: Vec<String>, reverse: bool },
}

// ---- shelf (`.openidea/shelf`) and change lists (`.openidea/changelists.json`) ----

const PRIVATE_ENTRIES: [&str; 2] = ["/shelf/", "/changelists.json"];

fn shelf_dir(root: &Path) -> PathBuf {
    ide_core::project_dir::path(root, "shelf")
}

fn keep_private(root: &Path) {
    if let Err(e) = ide_vcs::changelists::ensure_ignored(&ide_core::project_dir::path(root, ""), &PRIVATE_ENTRIES) {
        tracing::warn!("could not update .openidea/.gitignore: {e}");
    }
}

/// The project's repositories, the primary one first.
pub fn vcs_roots(host: &Host, window: &str) -> IdeResult<Vec<VcsRoot>> {
    let repos = host.project(window)?.repos();
    let primary = repos.primary().map(|r| r.root().to_path_buf());
    let mut all: Vec<&std::sync::Arc<Repo>> = repos.all().iter().collect();
    all.sort_by_key(|r| Some(r.root()) != primary.as_deref());
    Ok(all
        .into_iter()
        .map(|r| {
            let (head, head_commit) = r.head().unwrap_or_default();
            VcsRoot { root: r.root().to_path_buf().into(), operation: r.operation().ok().flatten(), head, head_commit }
        })
        .collect())
}

pub async fn vcs_branch_info(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<BranchInfo> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.branch_info())).await
}

/// Gutter change markers for a file, computed against its current (unsaved) text.
pub fn vcs_line_hunks(host: &Host, window: &str, path: PathBuf) -> IdeResult<Vec<LineHunk>> {
    let project = host.project(window)?;
    let text = project.text_of(&path)?;
    project.with_repo_of(&path, |r| r.line_hunks(&path, &text, false, project.vcs_encoding(&path, None)?))
}

pub async fn vcs_file_at(host: &Host, window: &str, path: PathBuf, rev: Option<String>) -> IdeResult<Option<String>> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_of(&path, |r| r.file_at(&path, rev.as_deref(), project.vcs_encoding(&path, rev.as_deref())?))
    })
    .await
}

pub async fn vcs_blame(host: &Host, window: &str, path: PathBuf) -> IdeResult<Vec<BlameLine>> {
    let project = host.project(window)?;
    let text = project.documents.text_of(&path);
    blocking(move || {
        project.with_repo_of(&path, |r| r.blame(&path, text.as_deref(), project.vcs_encoding(&path, None)?))
    })
    .await
}

pub async fn vcs_log(host: &Host, window: &str, repo: Option<PathBuf>, query: LogQuery) -> IdeResult<Vec<Commit>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.log(&query))).await
}

pub async fn vcs_commit_files(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    commit: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.commit_files(&commit))).await
}

/// Combined changes of several commits, `commits` oldest first.
pub async fn vcs_commits_changes(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    commits: Vec<String>,
) -> IdeResult<Vec<RevisionChange>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.commits_changes(&commits))).await
}

pub async fn vcs_branches(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Branch>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.branches())).await
}

pub async fn vcs_stashes(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Stash>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.stashes())).await
}

pub async fn vcs_stage(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || per_repo(&project, &paths, None, |r, paths| r.stage(paths))).await
}

/// Project-host operation (also registered with the remote dispatcher).
/// Returns the ignore files that were updated, so the UI can show them.
pub async fn vcs_add_to_ignore(
    host: &Host,
    window: &str,
    paths: Vec<PathBuf>,
    destination: IgnoreDestination,
) -> IdeResult<Vec<String>> {
    let project = host.project(window)?;
    blocking(move || {
        for path in &paths {
            if path == &project.root || !path.starts_with(&project.root) {
                return Err(ide_core::IdeError::invalid("Ignore selection is outside the project"));
            }
        }
        apply_git_executable(&project.settings.effective());
        let result = ide_vcs::add_to_ignore(&paths, destination);
        // Exclude may live outside a worktree's watched directory. Refresh filters and UI explicitly.
        project.watcher.reload_ignore_rules();
        for (_, watcher) in project.content_watchers.lock().iter() {
            watcher.reload_ignore_rules();
        }
        project.sink.emit(ide_core::IdeEvent::VcsChanged { root: project.root.clone().into() });
        result.map(|files| files.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
    })
    .await
}

pub async fn vcs_unstage(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || per_repo(&project, &paths, None, |r, paths| r.unstage(paths))).await
}

pub async fn vcs_stage_patch(host: &Host, window: &str, patch: String) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.with_repo(|r| r.stage_patch(&patch, &|path| project.vcs_encoding(path, Some(":0"))))).await
}

pub async fn vcs_discard(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || per_repo(&project, &paths, Some("Rollback"), |r, paths| r.discard(paths))).await
}

pub async fn vcs_commit(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    message: String,
    options: CommitOptions,
) -> IdeResult<String> {
    // Commit hooks may run for a long time.
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| {
            r.commit_with(&message, &options, &|path| project.vcs_encoding(path, None))
        })
    })
    .await
}

pub async fn vcs_checkout(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branch: String,
    create: bool,
    options: Option<ide_vcs::CheckoutOptions>,
) -> IdeResult<ide_vcs::CheckoutOutcome> {
    let project = host.project(window)?;
    let options = options.unwrap_or_default();
    blocking(move || {
        project
            .with_repo_recorded(repo.as_deref(), Some("Git checkout"), |r| r.checkout_with(&branch, create, &options))
    })
    .await
}

/// New Branch: creates `name` at `start` (HEAD when absent), optionally checking it out.
pub async fn vcs_create_branch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    name: String,
    start: Option<String>,
    checkout: bool,
) -> IdeResult<()> {
    let project = host.project(window)?;
    let recorded = checkout.then_some("Git checkout");
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), recorded, |r| r.create_branch(&name, start.as_deref(), checkout))
    })
    .await
}

/// Undo Commit: moves HEAD back to the commit's parent, keeping its changes staged.
/// Returns the undone commit's message.
pub async fn vcs_undo_commit(host: &Host, window: &str, repo: Option<PathBuf>, commit: String) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.undo_commit(&commit))).await
}

pub async fn vcs_delete_branch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branch: String,
) -> IdeResult<ide_vcs::DeletedBranch> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.delete_branch_restorable(&branch))).await
}

/// "Restore" of the branch-deleted notification.
pub async fn vcs_restore_branch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    deleted: ide_vcs::DeletedBranch,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.restore_branch(&deleted))).await
}

pub async fn vcs_rename_branch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    from: String,
    to: String,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.rename_branch(&from, &to))).await
}

pub async fn vcs_merge(host: &Host, window: &str, repo: Option<PathBuf>, branch: String) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_recorded(repo.as_deref(), Some("Git merge"), |r| r.merge(&branch))).await
}

pub async fn vcs_rebase(host: &Host, window: &str, repo: Option<PathBuf>, onto: String) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_recorded(repo.as_deref(), Some("Git rebase"), |r| r.rebase(&onto))).await
}

pub async fn vcs_stash_push(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git stash"), |r| {
            r.stash_push(message.as_deref(), include_untracked, keep_index)
        })
    })
    .await
}

pub async fn vcs_stash_apply(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    index: u32,
    pop: bool,
    reinstate_index: bool,
    branch: Option<String>,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git unstash"), |r| match branch.as_deref() {
            Some(name) => r.stash_branch(index, name),
            None => r.stash_apply(index, pop, reinstate_index),
        })
    })
    .await
}

pub async fn vcs_stash_drop(host: &Host, window: &str, repo: Option<PathBuf>, index: u32) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.stash_drop(index))).await
}

/// Network operation; progress lines stream through `on_output`. Cancellable.
pub async fn vcs_remote(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    op: RemoteOp,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let out = |line: String| {
            let _ = on_output.send(line);
        };
        let recorded = matches!(op, RemoteOp::Pull { .. } | RemoteOp::PullFrom { .. }).then_some("Git pull");
        project.with_repo_recorded(repo.as_deref(), recorded, |r| match op {
            RemoteOp::Fetch => r.fetch(&cancel, &out),
            RemoteOp::Pull { rebase } => r.pull(rebase, &cancel, &out),
            RemoteOp::Push { force_with_lease, set_upstream, tags } => {
                r.push_with_tags(force_with_lease, set_upstream, tags, &cancel, &out)
            }
            RemoteOp::DeleteBranch { branch } => r.delete_remote_branch(&branch, &cancel, &out),
            RemoteOp::PushBranch { branch, revision, force_with_lease, target } => match target {
                Some(target) => {
                    r.push_branch_to(&branch, revision.as_deref(), &target, force_with_lease, &cancel, &out)
                }
                None => r.push_branch(&branch, revision.as_deref(), force_with_lease, &cancel, &out),
            },
            RemoteOp::UpdateBranch { branch } => r.update_branch(&branch, &cancel, &out),
            RemoteOp::PullFrom { remote, branches, rebase, options } => {
                r.pull_from(&remote, &branches, rebase, &options, &cancel, &out)
            }
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    host.end_request(request);
    result
}

/// The user's side is `ours` (sides swapped during a rebase, as in IDEA).
pub async fn vcs_conflict_versions(host: &Host, window: &str, path: PathBuf) -> IdeResult<ide_vcs::MergeVersions> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_of(&path, |r| r.merge_versions(&path, project.vcs_encoding(&path, Some(":2"))?)))
        .await
}

pub async fn vcs_diff_text(host: &Host, window: &str, path: PathBuf, staged: bool) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_of(&path, |r| r.diff_text(&path, staged, project.vcs_encoding(&path, None)?)))
        .await
}

/// Line hunks between two arbitrary texts (diff viewer, commit dialog).
pub fn vcs_diff_hunks(_host: &Host, _window: &str, old_text: String, new_text: String) -> Vec<LineHunk> {
    ide_vcs::diff_hunks(&old_text, &new_text)
}

/// Stages only the selected hunks of a file's working-tree changes.
/// Indices refer to `vcs_diff_hunks(index_text, worktree_text)`.
pub fn vcs_stage_hunks(host: &Host, window: &str, path: PathBuf, hunks: Vec<u32>) -> IdeResult<()> {
    let project = host.project(window)?;
    let encoding = project.vcs_encoding(&path, Some(":0"))?;
    let current = ide_vfs::load_text_as(&path, encoding.name())?.text;
    project.with_repo_of(&path, |r| {
        let selected: Vec<usize> = hunks.iter().map(|&h| h as usize).collect();
        r.stage_hunks(&path, &current, &selected, encoding)
    })
}

/// Clones a repository (Get from VCS). Works without an open project.
pub async fn vcs_clone(
    host: &Host,
    _window: &str,
    request: RequestId,
    url: String,
    dest: PathBuf,
    on_output: Channel<String>,
) -> IdeResult<()> {
    apply_git_executable(&host.global_settings.effective());
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        ide_vcs::clone(&url, &dest, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    host.end_request(request);
    result
}

/// `git init` in `dir` (File › New Project… "Create Git repository").
pub async fn vcs_init(host: &Host, _window: &str, dir: PathBuf) -> IdeResult<()> {
    apply_git_executable(&host.global_settings.effective());
    blocking(move || ide_vcs::init(&dir)).await
}

/// Settings › Git › Test: runs `git --version` on `path`, or on the auto-detected
/// executable when `path` is empty.
pub async fn vcs_git_version(_host: &Host, _window: &str, path: String) -> IdeResult<GitExecutableInfo> {
    tokio::task::spawn_blocking(move || {
        let explicit = path.trim();
        let exe = if explicit.is_empty() {
            ide_vcs::detected_git_executable()
                .ok_or_else(|| ide_core::IdeError::unavailable("git executable not found on PATH"))?
        } else {
            PathBuf::from(explicit)
        };
        let version = ide_vcs::git_version(Some(&exe))?;
        Ok(GitExecutableInfo { version, path: exe.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

/// The auto-detected git executable (shown as the field's placeholder).
pub fn vcs_detected_git(_host: &Host, _window: &str) -> Option<String> {
    ide_vcs::detected_git_executable().map(|p| p.to_string_lossy().into_owned())
}

/// `git config --get <key>` in the project repository; `None` when unset.
pub async fn vcs_config_get(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    key: String,
) -> IdeResult<Option<String>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.config_get(&key))).await
}

/// Local history operation that may take a while (hooks, large checkouts); git's
/// output streams through `on_output`. Cancellable.
pub async fn vcs_operation(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    op: GitOperation,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let out = |line: String| {
            let _ = on_output.send(line);
        };
        let recorded = match &op {
            GitOperation::CherryPick { .. } => Some("Git cherry-pick"),
            GitOperation::Revert { .. } => Some("Git revert"),
            GitOperation::Reset { .. } => Some("Git reset"),
            GitOperation::InteractiveRebase { .. } => Some("Git rebase"),
            _ => None,
        };
        project.with_repo_recorded(repo.as_deref(), recorded, |r| match op {
            GitOperation::Continue => r.continue_operation(&cancel, &out),
            GitOperation::Abort => r.abort_operation(&cancel, &out),
            GitOperation::Skip => r.skip_operation(&cancel, &out),
            GitOperation::CherryPick { commits } => r.cherry_pick(&commits, &cancel, &out),
            GitOperation::Revert { commits } => r.revert(&commits, &cancel, &out),
            GitOperation::Reset { commit, mode } => r.reset(&commit, mode, &cancel, &out),
            GitOperation::InteractiveRebase { base, entries } => {
                r.interactive_rebase(base.as_deref(), &entries, &cancel, &out)
            }
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    host.end_request(request);
    result
}

pub async fn vcs_create_tag(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    name: String,
    commit: String,
    message: Option<String>,
    force: bool,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.create_tag(&name, &commit, message.as_deref(), force)))
        .await
}

pub async fn vcs_tags(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<String>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.tags())).await
}

/// Merge dialog: merges `branches` into the current branch.
pub async fn vcs_merge_with(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branches: Vec<String>,
    options: MergeOptions,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git merge"), |r| r.merge_with(&branches, &options))
    })
    .await
}

/// Rebase dialog: rebases the current branch onto `upstream` (or `--onto`).
pub async fn vcs_rebase_with(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    upstream: String,
    options: RebaseOptions,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git rebase"), |r| r.rebase_with(&upstream, &options))
    })
    .await
}

pub async fn vcs_remotes(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Remote>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.remotes())).await
}

pub async fn vcs_edit_remote(host: &Host, window: &str, repo: Option<PathBuf>, edit: RemoteEdit) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.edit_remote(&edit))).await
}

pub async fn vcs_worktrees(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Worktree>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.worktrees())).await
}

pub async fn vcs_add_worktree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    path: PathBuf,
    commitish: String,
    new_branch: Option<String>,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| r.add_worktree(&path, &commitish, new_branch.as_deref()))
    })
    .await
}

pub async fn vcs_remove_worktree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    path: PathBuf,
    force: bool,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.remove_worktree(&path, force))).await
}

/// Compare with Local: tracked files that differ between `rev` and the working tree.
pub async fn vcs_diff_with_worktree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    rev: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.diff_with_worktree(&rev))).await
}

/// Files that differ between two revisions (the "N files updated" of Update Project).
pub async fn vcs_diff_revisions(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    from: String,
    to: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.diff_revisions(&from, &to))).await
}

pub async fn vcs_create_patch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    source: PatchSource,
) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| match source {
            PatchSource::Changes { paths, reverse } => {
                let paths: Vec<PathBuf> = paths.into_iter().map(Into::into).collect();
                r.create_patch(&paths, reverse)
            }
            PatchSource::Commits { commits, reverse } => r.create_commits_patch(&commits, reverse),
        })
    })
    .await
}

pub async fn vcs_patch_preview(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    patch: String,
) -> IdeResult<Vec<PatchFile>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.patch_preview(&patch))).await
}

pub async fn vcs_apply_patch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    patch: String,
) -> IdeResult<ApplyOutcome> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.apply_patch(&patch))).await
}

/// Shelve Changes: saves the changes of `paths` as a patch on the shelf and reverts them.
pub async fn vcs_shelve(host: &Host, window: &str, name: String, paths: Vec<PathBuf>) -> IdeResult<ShelvedChangeList> {
    let project = host.project(window)?;
    blocking(move || {
        in_primary_repo(&project, &paths)?;
        keep_private(&project.root);
        project.with_repo_recorded(None, Some("Shelve"), |r| r.shelve(&shelf_dir(&project.root), &name, &paths))
    })
    .await
}

pub fn vcs_shelves(host: &Host, window: &str) -> IdeResult<Vec<ShelvedChangeList>> {
    let project = host.project(window)?;
    ide_vcs::shelf::list(&shelf_dir(&project.root))
}

/// Unshelve: applies the shelved patch (3-way merging; conflicts are left for the
/// merge UI); with `remove`, deletes it from the shelf.
pub async fn vcs_unshelve(host: &Host, window: &str, id: String, remove: bool) -> IdeResult<ApplyOutcome> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(None, Some("Unshelve"), |r| r.unshelve(&shelf_dir(&project.root), &id, remove))
    })
    .await
}

pub fn vcs_shelf_delete(host: &Host, window: &str, id: String) -> IdeResult<()> {
    let project = host.project(window)?;
    ide_vcs::shelf::delete(&shelf_dir(&project.root), &id)
}

pub fn vcs_shelf_rename(host: &Host, window: &str, id: String, name: String) -> IdeResult<()> {
    let project = host.project(window)?;
    ide_vcs::shelf::rename(&shelf_dir(&project.root), &id, &name)
}

pub fn vcs_shelf_patch(host: &Host, window: &str, id: String) -> IdeResult<String> {
    let project = host.project(window)?;
    ide_vcs::shelf::patch_of(&shelf_dir(&project.root), &id)
}

pub fn vcs_changelists_load(host: &Host, window: &str) -> IdeResult<ChangelistState> {
    let project = host.project(window)?;
    Ok(ide_vcs::changelists::load(&ide_core::project_dir::path(&project.root, "changelists.json")))
}

pub fn vcs_changelists_save(host: &Host, window: &str, changelists: ChangelistState) -> IdeResult<()> {
    let project = host.project(window)?;
    keep_private(&project.root);
    ide_vcs::changelists::save(&ide_core::project_dir::path(&project.root, "changelists.json"), &changelists)
}

/// Create Patch › Save to file.
pub async fn vcs_write_patch(_host: &Host, _window: &str, path: PathBuf, patch: String) -> IdeResult<()> {
    blocking(move || {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, patch)?;
        Ok(())
    })
    .await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("vcs_roots", |c| async move { vcs_roots(&c.host, &c.window) });
    d.add("vcs_branch_info", |c| async move { vcs_branch_info(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_line_hunks", |c| async move { vcs_line_hunks(&c.host, &c.window, c.arg("path")?) });
    d.add("vcs_file_at", |c| async move { vcs_file_at(&c.host, &c.window, c.arg("path")?, c.arg("rev")?).await });
    d.add("vcs_blame", |c| async move { vcs_blame(&c.host, &c.window, c.arg("path")?).await });
    d.add("vcs_log", |c| async move { vcs_log(&c.host, &c.window, c.arg("repo")?, c.arg("query")?).await });
    d.add("vcs_commit_files", |c| async move {
        vcs_commit_files(&c.host, &c.window, c.arg("repo")?, c.arg("commit")?).await
    });
    d.add("vcs_commits_changes", |c| async move {
        vcs_commits_changes(&c.host, &c.window, c.arg("repo")?, c.arg("commits")?).await
    });
    d.add("vcs_branches", |c| async move { vcs_branches(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_stashes", |c| async move { vcs_stashes(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_stage", |c| async move { vcs_stage(&c.host, &c.window, c.arg("paths")?).await });
    d.add("vcs_add_to_ignore", |c| async move {
        vcs_add_to_ignore(&c.host, &c.window, c.arg("paths")?, c.arg("destination")?).await
    });
    d.add("vcs_unstage", |c| async move { vcs_unstage(&c.host, &c.window, c.arg("paths")?).await });
    d.add("vcs_stage_patch", |c| async move { vcs_stage_patch(&c.host, &c.window, c.arg("patch")?).await });
    d.add("vcs_discard", |c| async move { vcs_discard(&c.host, &c.window, c.arg("paths")?).await });
    d.add("vcs_commit", |c| async move {
        vcs_commit(&c.host, &c.window, c.arg("repo")?, c.arg("message")?, c.arg("options")?).await
    });
    d.add("vcs_checkout", |c| async move {
        vcs_checkout(&c.host, &c.window, c.arg("repo")?, c.arg("branch")?, c.arg("create")?, c.arg("options")?).await
    });
    d.add("vcs_create_branch", |c| async move {
        vcs_create_branch(&c.host, &c.window, c.arg("repo")?, c.arg("name")?, c.arg("start")?, c.arg("checkout")?).await
    });
    d.add(
        "vcs_undo_commit",
        |c| async move { vcs_undo_commit(&c.host, &c.window, c.arg("repo")?, c.arg("commit")?).await },
    );
    d.add("vcs_delete_branch", |c| async move {
        vcs_delete_branch(&c.host, &c.window, c.arg("repo")?, c.arg("branch")?).await
    });
    d.add("vcs_restore_branch", |c| async move {
        vcs_restore_branch(&c.host, &c.window, c.arg("repo")?, c.arg("deleted")?).await
    });
    d.add("vcs_rename_branch", |c| async move {
        vcs_rename_branch(&c.host, &c.window, c.arg("repo")?, c.arg("from")?, c.arg("to")?).await
    });
    d.add("vcs_merge", |c| async move { vcs_merge(&c.host, &c.window, c.arg("repo")?, c.arg("branch")?).await });
    d.add("vcs_rebase", |c| async move { vcs_rebase(&c.host, &c.window, c.arg("repo")?, c.arg("onto")?).await });
    d.add("vcs_stash_push", |c| async move {
        vcs_stash_push(
            &c.host,
            &c.window,
            c.arg("repo")?,
            c.arg("message")?,
            c.arg("includeUntracked")?,
            c.arg("keepIndex")?,
        )
        .await
    });
    d.add("vcs_stash_apply", |c| async move {
        vcs_stash_apply(
            &c.host,
            &c.window,
            c.arg("repo")?,
            c.arg("index")?,
            c.arg("pop")?,
            c.arg("reinstateIndex")?,
            c.arg("branch")?,
        )
        .await
    });
    d.add(
        "vcs_stash_drop",
        |c| async move { vcs_stash_drop(&c.host, &c.window, c.arg("repo")?, c.arg("index")?).await },
    );
    d.add("vcs_remote", |c| async move {
        vcs_remote(&c.host, &c.window, c.arg("repo")?, c.arg("request")?, c.arg("op")?, c.sender("onOutput")?).await
    });
    d.add("vcs_conflict_versions", |c| async move { vcs_conflict_versions(&c.host, &c.window, c.arg("path")?).await });
    d.add(
        "vcs_diff_text",
        |c| async move { vcs_diff_text(&c.host, &c.window, c.arg("path")?, c.arg("staged")?).await },
    );
    d.add(
        "vcs_diff_hunks",
        |c| async move { Ok(vcs_diff_hunks(&c.host, &c.window, c.arg("oldText")?, c.arg("newText")?)) },
    );
    d.add("vcs_stage_hunks", |c| async move { vcs_stage_hunks(&c.host, &c.window, c.arg("path")?, c.arg("hunks")?) });
    d.add("vcs_clone", |c| async move {
        vcs_clone(&c.host, &c.window, c.arg("request")?, c.arg("url")?, c.arg("dest")?, c.sender("onOutput")?).await
    });
    d.add("vcs_init", |c| async move { vcs_init(&c.host, &c.window, c.arg("dir")?).await });
    d.add("vcs_git_version", |c| async move { vcs_git_version(&c.host, &c.window, c.arg("path")?).await });
    d.add("vcs_detected_git", |c| async move { Ok(vcs_detected_git(&c.host, &c.window)) });
    d.add("vcs_config_get", |c| async move { vcs_config_get(&c.host, &c.window, c.arg("repo")?, c.arg("key")?).await });
    d.add("vcs_operation", |c| async move {
        vcs_operation(&c.host, &c.window, c.arg("repo")?, c.arg("request")?, c.arg("op")?, c.sender("onOutput")?).await
    });
    d.add("vcs_create_tag", |c| async move {
        vcs_create_tag(
            &c.host,
            &c.window,
            c.arg("repo")?,
            c.arg("name")?,
            c.arg("commit")?,
            c.arg("message")?,
            c.arg("force")?,
        )
        .await
    });
    d.add("vcs_tags", |c| async move { vcs_tags(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_merge_with", |c| async move {
        vcs_merge_with(&c.host, &c.window, c.arg("repo")?, c.arg("branches")?, c.arg("options")?).await
    });
    d.add("vcs_rebase_with", |c| async move {
        vcs_rebase_with(&c.host, &c.window, c.arg("repo")?, c.arg("upstream")?, c.arg("options")?).await
    });
    d.add("vcs_remotes", |c| async move { vcs_remotes(&c.host, &c.window, c.arg("repo")?).await });
    d.add(
        "vcs_edit_remote",
        |c| async move { vcs_edit_remote(&c.host, &c.window, c.arg("repo")?, c.arg("edit")?).await },
    );
    d.add("vcs_worktrees", |c| async move { vcs_worktrees(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_add_worktree", |c| async move {
        vcs_add_worktree(&c.host, &c.window, c.arg("repo")?, c.arg("path")?, c.arg("commitish")?, c.arg("newBranch")?)
            .await
    });
    d.add("vcs_remove_worktree", |c| async move {
        vcs_remove_worktree(&c.host, &c.window, c.arg("repo")?, c.arg("path")?, c.arg("force")?).await
    });
    d.add("vcs_diff_with_worktree", |c| async move {
        vcs_diff_with_worktree(&c.host, &c.window, c.arg("repo")?, c.arg("rev")?).await
    });
    d.add("vcs_diff_revisions", |c| async move {
        vcs_diff_revisions(&c.host, &c.window, c.arg("repo")?, c.arg("from")?, c.arg("to")?).await
    });
    d.add("vcs_create_patch", |c| async move {
        vcs_create_patch(&c.host, &c.window, c.arg("repo")?, c.arg("source")?).await
    });
    d.add("vcs_patch_preview", |c| async move {
        vcs_patch_preview(&c.host, &c.window, c.arg("repo")?, c.arg("patch")?).await
    });
    d.add(
        "vcs_apply_patch",
        |c| async move { vcs_apply_patch(&c.host, &c.window, c.arg("repo")?, c.arg("patch")?).await },
    );
    d.add("vcs_shelve", |c| async move { vcs_shelve(&c.host, &c.window, c.arg("name")?, c.arg("paths")?).await });
    d.add("vcs_shelves", |c| async move { vcs_shelves(&c.host, &c.window) });
    d.add("vcs_unshelve", |c| async move { vcs_unshelve(&c.host, &c.window, c.arg("id")?, c.arg("remove")?).await });
    d.add("vcs_shelf_delete", |c| async move { vcs_shelf_delete(&c.host, &c.window, c.arg("id")?) });
    d.add("vcs_shelf_rename", |c| async move { vcs_shelf_rename(&c.host, &c.window, c.arg("id")?, c.arg("name")?) });
    d.add("vcs_shelf_patch", |c| async move { vcs_shelf_patch(&c.host, &c.window, c.arg("id")?) });
    d.add("vcs_changelists_load", |c| async move { vcs_changelists_load(&c.host, &c.window) });
    d.add("vcs_changelists_save", |c| async move { vcs_changelists_save(&c.host, &c.window, c.arg("changelists")?) });
    d.add(
        "vcs_write_patch",
        |c| async move { vcs_write_patch(&c.host, &c.window, c.arg("path")?, c.arg("patch")?).await },
    );
}
