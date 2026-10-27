use crate::state::{AppState, Project};
use ide_core::{IdeResult, RequestId};
use ide_vcs::*;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Settings › Version Control › Git › Path to Git executable (empty = auto-detect).
pub(crate) fn apply_git_executable(settings: &ide_core::settings::Settings) {
    let exe = settings.vcs.git.executable.trim();
    ide_vcs::set_git_executable((!exe.is_empty()).then(|| Path::new(exe)));
}

/// Changes of every repository of the project.
#[tauri::command]
#[specta::specta]
pub async fn vcs_status(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<FileStatus>> {
    let project = state.project(window.label())?;
    blocking(move || {
        let settings = project.settings.effective();
        apply_git_executable(&settings);
        let repos = project.repos();
        if repos.is_empty() {
            return Err(ide_core::IdeError::unavailable("project is not a git repository"));
        }
        for r in repos.all() {
            r.set_ignored_names(settings.ignored_names());
        }
        repos.status()
    })
    .await
}

/// A repository of the project (IDEA's VCS root).
#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VcsRoot {
    /// Worktree root.
    pub root: ide_core::IpcPath,
    /// Merge / rebase / cherry-pick / revert in progress.
    pub operation: Option<String>,
}

/// The project's repositories, the primary one first.
#[tauri::command]
#[specta::specta]
pub fn vcs_roots(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<VcsRoot>> {
    let repos = state.project(window.label())?.repos();
    let primary = repos.primary().map(|r| r.root().to_path_buf());
    let mut all: Vec<&std::sync::Arc<Repo>> = repos.all().iter().collect();
    all.sort_by_key(|r| Some(r.root()) != primary.as_deref());
    Ok(all
        .into_iter()
        .map(|r| VcsRoot { root: r.root().to_path_buf().into(), operation: r.operation().ok().flatten() })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_branch_info(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
) -> IdeResult<BranchInfo> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.branch_info())).await
}

/// Gutter change markers for a file, computed against its current (unsaved) text.
#[tauri::command]
#[specta::specta]
pub fn vcs_line_hunks(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<Vec<LineHunk>> {
    let project = state.project(window.label())?;
    let text = project.text_of(&path)?;
    project.with_repo_of(&path, |r| r.line_hunks(&path, &text, false))
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_file_at(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
    rev: Option<String>,
) -> IdeResult<Option<String>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_of(&path, |r| r.file_at(&path, rev.as_deref()))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_blame(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<Vec<BlameLine>> {
    let project = state.project(window.label())?;
    let text = project.documents.text_of(&path);
    blocking(move || project.with_repo_of(&path, |r| r.blame(&path, text.as_deref()))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_log(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    query: LogQuery,
) -> IdeResult<Vec<Commit>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.log(&query))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_commit_files(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    commit: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.commit_files(&commit))).await
}

/// Combined changes of several commits, `commits` oldest first.
#[tauri::command]
#[specta::specta]
pub async fn vcs_commits_changes(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    commits: Vec<String>,
) -> IdeResult<Vec<RevisionChange>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.commits_changes(&commits))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_branches(window: Window, state: State<'_, AppState>, repo: Option<PathBuf>) -> IdeResult<Vec<Branch>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.branches())).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_stashes(window: Window, state: State<'_, AppState>, repo: Option<PathBuf>) -> IdeResult<Vec<Stash>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.stashes())).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_stage(window: Window, state: State<'_, AppState>, paths: Vec<PathBuf>) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || per_repo(&project, &paths, None, |r, paths| r.stage(paths))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_unstage(window: Window, state: State<'_, AppState>, paths: Vec<PathBuf>) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || per_repo(&project, &paths, None, |r, paths| r.unstage(paths))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_stage_patch(window: Window, state: State<'_, AppState>, patch: String) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo(|r| r.stage_patch(&patch))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_discard(window: Window, state: State<'_, AppState>, paths: Vec<PathBuf>) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || per_repo(&project, &paths, Some("Rollback"), |r, paths| r.discard(paths))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_commit(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    message: String,
    options: CommitOptions,
) -> IdeResult<String> {
    // Commit hooks may run for a long time.
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.commit_with(&message, &options))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_checkout(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    branch: String,
    create: bool,
    options: Option<ide_vcs::CheckoutOptions>,
) -> IdeResult<ide_vcs::CheckoutOutcome> {
    let project = state.project(window.label())?;
    let options = options.unwrap_or_default();
    blocking(move || {
        project
            .with_repo_recorded(repo.as_deref(), Some("Git checkout"), |r| r.checkout_with(&branch, create, &options))
    })
    .await
}

/// New Branch: creates `name` at `start` (HEAD when absent), optionally checking it out.
#[tauri::command]
#[specta::specta]
pub async fn vcs_create_branch(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    name: String,
    start: Option<String>,
    checkout: bool,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    let recorded = checkout.then_some("Git checkout");
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), recorded, |r| r.create_branch(&name, start.as_deref(), checkout))
    })
    .await
}

/// Undo Commit: moves HEAD back to the commit's parent, keeping its changes staged.
/// Returns the undone commit's message.
#[tauri::command]
#[specta::specta]
pub async fn vcs_undo_commit(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    commit: String,
) -> IdeResult<String> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.undo_commit(&commit))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_delete_branch(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    branch: String,
) -> IdeResult<ide_vcs::DeletedBranch> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.delete_branch_restorable(&branch))).await
}

/// "Restore" of the branch-deleted notification.
#[tauri::command]
#[specta::specta]
pub async fn vcs_restore_branch(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    deleted: ide_vcs::DeletedBranch,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.restore_branch(&deleted))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_rename_branch(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    from: String,
    to: String,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.rename_branch(&from, &to))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_merge(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    branch: String,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_recorded(repo.as_deref(), Some("Git merge"), |r| r.merge(&branch))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_rebase(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    onto: String,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_recorded(repo.as_deref(), Some("Git rebase"), |r| r.rebase(&onto))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_stash_push(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git stash"), |r| {
            r.stash_push(message.as_deref(), include_untracked, keep_index)
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_stash_apply(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    index: u32,
    pop: bool,
    reinstate_index: bool,
    branch: Option<String>,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git unstash"), |r| match branch.as_deref() {
            Some(name) => r.stash_branch(index, name),
            None => r.stash_apply(index, pop, reinstate_index),
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_stash_drop(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    index: u32,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.stash_drop(index))).await
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

/// Network operation; progress lines stream through `on_output`. Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn vcs_remote(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    request: RequestId,
    op: RemoteOp,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    let cancel = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
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
    state.end_request(request);
    result
}

/// The user's side is `ours` (sides swapped during a rebase, as in IDEA).
#[tauri::command]
#[specta::specta]
pub async fn vcs_conflict_versions(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
) -> IdeResult<ide_vcs::MergeVersions> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_of(&path, |r| r.merge_versions(&path))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_diff_text(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
    staged: bool,
) -> IdeResult<String> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_of(&path, |r| r.diff_text(&path, staged))).await
}

/// Line hunks between two arbitrary texts (diff viewer, commit dialog).
#[tauri::command]
#[specta::specta]
pub fn vcs_diff_hunks(old_text: String, new_text: String) -> Vec<LineHunk> {
    ide_vcs::diff_hunks(&old_text, &new_text)
}

/// Stages only the selected hunks of a file's working-tree changes.
/// Indices refer to `vcs_diff_hunks(index_text, worktree_text)`.
#[tauri::command]
#[specta::specta]
pub fn vcs_stage_hunks(window: Window, state: State<'_, AppState>, path: PathBuf, hunks: Vec<u32>) -> IdeResult<()> {
    let project = state.project(window.label())?;
    let current = ide_vfs::load_text(&path)?.text;
    project.with_repo_of(&path, |r| {
        let index_text = r.file_at(&path, Some(":0"))?.unwrap_or_default();
        let rel = path.strip_prefix(r.root()).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        let selected: Vec<usize> = hunks.iter().map(|&h| h as usize).collect();
        let patch = ide_vcs::build_partial_patch(&rel, &index_text, &current, &selected);
        if patch.is_empty() { Ok(()) } else { r.stage_patch(&patch) }
    })
}

/// Clones a repository (Get from VCS). Works without an open project.
#[tauri::command]
#[specta::specta]
pub async fn vcs_clone(
    state: State<'_, AppState>,
    request: RequestId,
    url: String,
    dest: PathBuf,
    on_output: Channel<String>,
) -> IdeResult<()> {
    apply_git_executable(&state.global_settings.effective());
    let cancel = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
        ide_vcs::clone(&url, &dest, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    state.end_request(request);
    result
}

/// `git init` in `dir` (File › New Project… "Create Git repository").
#[tauri::command]
#[specta::specta]
pub async fn vcs_init(state: State<'_, AppState>, dir: PathBuf) -> IdeResult<()> {
    apply_git_executable(&state.global_settings.effective());
    blocking(move || ide_vcs::init(&dir)).await
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitExecutableInfo {
    /// `git version …` output.
    pub version: String,
    /// The executable that was run.
    pub path: String,
}

/// Settings › Git › Test: runs `git --version` on `path`, or on the auto-detected
/// executable when `path` is empty.
#[tauri::command]
#[specta::specta]
pub async fn vcs_git_version(path: String) -> IdeResult<GitExecutableInfo> {
    tauri::async_runtime::spawn_blocking(move || {
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
#[tauri::command]
#[specta::specta]
pub fn vcs_detected_git() -> Option<String> {
    ide_vcs::detected_git_executable().map(|p| p.to_string_lossy().into_owned())
}

/// `git config --get <key>` in the project repository; `None` when unset.
#[tauri::command]
#[specta::specta]
pub async fn vcs_config_get(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    key: String,
) -> IdeResult<Option<String>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.config_get(&key))).await
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

/// Local history operation that may take a while (hooks, large checkouts); git's
/// output streams through `on_output`. Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn vcs_operation(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    request: RequestId,
    op: GitOperation,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    let cancel = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
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
    state.end_request(request);
    result
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_create_tag(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    name: String,
    commit: String,
    message: Option<String>,
    force: bool,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.create_tag(&name, &commit, message.as_deref(), force)))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_tags(window: Window, state: State<'_, AppState>, repo: Option<PathBuf>) -> IdeResult<Vec<String>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.tags())).await
}

/// Merge dialog: merges `branches` into the current branch.
#[tauri::command]
#[specta::specta]
pub async fn vcs_merge_with(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    branches: Vec<String>,
    options: MergeOptions,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git merge"), |r| r.merge_with(&branches, &options))
    })
    .await
}

/// Rebase dialog: rebases the current branch onto `upstream` (or `--onto`).
#[tauri::command]
#[specta::specta]
pub async fn vcs_rebase_with(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    upstream: String,
    options: RebaseOptions,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git rebase"), |r| r.rebase_with(&upstream, &options))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_remotes(window: Window, state: State<'_, AppState>, repo: Option<PathBuf>) -> IdeResult<Vec<Remote>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.remotes())).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_edit_remote(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    edit: RemoteEdit,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.edit_remote(&edit))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_worktrees(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
) -> IdeResult<Vec<Worktree>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.worktrees())).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_add_worktree(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    path: PathBuf,
    commitish: String,
    new_branch: Option<String>,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| r.add_worktree(&path, &commitish, new_branch.as_deref()))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_remove_worktree(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    path: PathBuf,
    force: bool,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.remove_worktree(&path, force))).await
}

/// Compare with Local: tracked files that differ between `rev` and the working tree.
#[tauri::command]
#[specta::specta]
pub async fn vcs_diff_with_worktree(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    rev: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.diff_with_worktree(&rev))).await
}

/// Files that differ between two revisions (the "N files updated" of Update Project).
#[tauri::command]
#[specta::specta]
pub async fn vcs_diff_revisions(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    from: String,
    to: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.diff_revisions(&from, &to))).await
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
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| ide_core::IdeError::internal(e.to_string()))?
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

#[tauri::command]
#[specta::specta]
pub async fn vcs_create_patch(window: Window, state: State<'_, AppState>, source: PatchSource) -> IdeResult<String> {
    let project = state.project(window.label())?;
    blocking(move || {
        project.with_repo(|r| match source {
            PatchSource::Changes { paths, reverse } => {
                let paths: Vec<PathBuf> = paths.into_iter().map(Into::into).collect();
                in_primary_repo(&project, &paths)?;
                r.create_patch(&paths, reverse)
            }
            PatchSource::Commits { commits, reverse } => r.create_commits_patch(&commits, reverse),
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_patch_preview(window: Window, state: State<'_, AppState>, patch: String) -> IdeResult<Vec<PatchFile>> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo(|r| r.patch_preview(&patch))).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_apply_patch(window: Window, state: State<'_, AppState>, patch: String) -> IdeResult<ApplyOutcome> {
    let project = state.project(window.label())?;
    blocking(move || project.with_repo(|r| r.apply_patch(&patch))).await
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

/// Shelve Changes: saves the changes of `paths` as a patch on the shelf and reverts them.
#[tauri::command]
#[specta::specta]
pub async fn vcs_shelve(
    window: Window,
    state: State<'_, AppState>,
    name: String,
    paths: Vec<PathBuf>,
) -> IdeResult<ShelvedChangeList> {
    let project = state.project(window.label())?;
    blocking(move || {
        in_primary_repo(&project, &paths)?;
        keep_private(&project.root);
        project.with_repo_recorded(None, Some("Shelve"), |r| r.shelve(&shelf_dir(&project.root), &name, &paths))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub fn vcs_shelves(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ShelvedChangeList>> {
    let project = state.project(window.label())?;
    ide_vcs::shelf::list(&shelf_dir(&project.root))
}

/// Unshelve: applies the shelved patch (3-way merging; conflicts are left for the
/// merge UI); with `remove`, deletes it from the shelf.
#[tauri::command]
#[specta::specta]
pub async fn vcs_unshelve(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    remove: bool,
) -> IdeResult<ApplyOutcome> {
    let project = state.project(window.label())?;
    blocking(move || {
        project.with_repo_recorded(None, Some("Unshelve"), |r| r.unshelve(&shelf_dir(&project.root), &id, remove))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub fn vcs_shelf_delete(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    let project = state.project(window.label())?;
    ide_vcs::shelf::delete(&shelf_dir(&project.root), &id)
}

#[tauri::command]
#[specta::specta]
pub fn vcs_shelf_rename(window: Window, state: State<'_, AppState>, id: String, name: String) -> IdeResult<()> {
    let project = state.project(window.label())?;
    ide_vcs::shelf::rename(&shelf_dir(&project.root), &id, &name)
}

#[tauri::command]
#[specta::specta]
pub fn vcs_shelf_patch(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<String> {
    let project = state.project(window.label())?;
    ide_vcs::shelf::patch_of(&shelf_dir(&project.root), &id)
}

#[tauri::command]
#[specta::specta]
pub fn vcs_changelists_load(window: Window, state: State<'_, AppState>) -> IdeResult<ChangelistState> {
    let project = state.project(window.label())?;
    Ok(ide_vcs::changelists::load(&ide_core::project_dir::path(&project.root, "changelists.json")))
}

#[tauri::command]
#[specta::specta]
pub fn vcs_changelists_save(window: Window, state: State<'_, AppState>, changelists: ChangelistState) -> IdeResult<()> {
    let project = state.project(window.label())?;
    keep_private(&project.root);
    ide_vcs::changelists::save(&ide_core::project_dir::path(&project.root, "changelists.json"), &changelists)
}

/// Create Patch › Save to file.
#[tauri::command]
#[specta::specta]
pub async fn vcs_write_patch(path: PathBuf, patch: String) -> IdeResult<()> {
    blocking(move || {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, patch)?;
        Ok(())
    })
    .await
}
