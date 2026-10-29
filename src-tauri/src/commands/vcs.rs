//! IPC commands of `ide_host::ops::vcs` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, RequestId};
#[allow(unused_imports)]
pub use ide_host::ops::vcs::*;
use ide_vcs::*;
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Changes of every repository of the project.
#[tauri::command]
#[specta::specta]
pub async fn vcs_status(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<FileStatus>> {
    ide_host::ops::vcs::status(&state.host, window.label()).await
}
/// The project's repositories, the primary one first.
#[tauri::command]
#[specta::specta]
pub fn vcs_roots(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<VcsRoot>> {
    ide_host::ops::vcs::vcs_roots(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_branch_info(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
) -> IdeResult<BranchInfo> {
    ide_host::ops::vcs::vcs_branch_info(&state.host, window.label(), repo).await
}

/// Gutter change markers for a file, computed against its current (unsaved) text.
#[tauri::command]
#[specta::specta]
pub fn vcs_line_hunks(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<Vec<LineHunk>> {
    ide_host::ops::vcs::vcs_line_hunks(&state.host, window.label(), path)
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_file_at(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
    rev: Option<String>,
) -> IdeResult<Option<String>> {
    ide_host::ops::vcs::vcs_file_at(&state.host, window.label(), path, rev).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_blame(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<Vec<BlameLine>> {
    ide_host::ops::vcs::vcs_blame(&state.host, window.label(), path).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_log(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    query: LogQuery,
) -> IdeResult<Vec<Commit>> {
    ide_host::ops::vcs::vcs_log(&state.host, window.label(), repo, query).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_commit_files(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    commit: String,
) -> IdeResult<Vec<ChangedFile>> {
    ide_host::ops::vcs::vcs_commit_files(&state.host, window.label(), repo, commit).await
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
    ide_host::ops::vcs::vcs_commits_changes(&state.host, window.label(), repo, commits).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_branches(window: Window, state: State<'_, AppState>, repo: Option<PathBuf>) -> IdeResult<Vec<Branch>> {
    ide_host::ops::vcs::vcs_branches(&state.host, window.label(), repo).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_stashes(window: Window, state: State<'_, AppState>, repo: Option<PathBuf>) -> IdeResult<Vec<Stash>> {
    ide_host::ops::vcs::vcs_stashes(&state.host, window.label(), repo).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_stage(window: Window, state: State<'_, AppState>, paths: Vec<PathBuf>) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_stage(&state.host, window.label(), paths).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_unstage(window: Window, state: State<'_, AppState>, paths: Vec<PathBuf>) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_unstage(&state.host, window.label(), paths).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_stage_patch(window: Window, state: State<'_, AppState>, patch: String) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_stage_patch(&state.host, window.label(), patch).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_discard(window: Window, state: State<'_, AppState>, paths: Vec<PathBuf>) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_discard(&state.host, window.label(), paths).await
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
    ide_host::ops::vcs::vcs_commit(&state.host, window.label(), repo, message, options).await
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
    ide_host::ops::vcs::vcs_checkout(&state.host, window.label(), repo, branch, create, options).await
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
    ide_host::ops::vcs::vcs_create_branch(&state.host, window.label(), repo, name, start, checkout).await
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
    ide_host::ops::vcs::vcs_undo_commit(&state.host, window.label(), repo, commit).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_delete_branch(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    branch: String,
) -> IdeResult<ide_vcs::DeletedBranch> {
    ide_host::ops::vcs::vcs_delete_branch(&state.host, window.label(), repo, branch).await
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
    ide_host::ops::vcs::vcs_restore_branch(&state.host, window.label(), repo, deleted).await
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
    ide_host::ops::vcs::vcs_rename_branch(&state.host, window.label(), repo, from, to).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_merge(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    branch: String,
) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_merge(&state.host, window.label(), repo, branch).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_rebase(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    onto: String,
) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_rebase(&state.host, window.label(), repo, onto).await
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
    ide_host::ops::vcs::vcs_stash_push(&state.host, window.label(), repo, message, include_untracked, keep_index).await
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
    ide_host::ops::vcs::vcs_stash_apply(&state.host, window.label(), repo, index, pop, reinstate_index, branch).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_stash_drop(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    index: u32,
) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_stash_drop(&state.host, window.label(), repo, index).await
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
    ide_host::ops::vcs::vcs_remote(&state.host, window.label(), repo, request, op, crate::commands::sender(on_output))
        .await
}

/// The user's side is `ours` (sides swapped during a rebase, as in IDEA).
#[tauri::command]
#[specta::specta]
pub async fn vcs_conflict_versions(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
) -> IdeResult<ide_vcs::MergeVersions> {
    ide_host::ops::vcs::vcs_conflict_versions(&state.host, window.label(), path).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_diff_text(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
    staged: bool,
) -> IdeResult<String> {
    ide_host::ops::vcs::vcs_diff_text(&state.host, window.label(), path, staged).await
}

/// Line hunks between two arbitrary texts (diff viewer, commit dialog).
#[tauri::command]
#[specta::specta]
pub fn vcs_diff_hunks(state: State<'_, AppState>, old_text: String, new_text: String) -> Vec<LineHunk> {
    ide_host::ops::vcs::vcs_diff_hunks(&state.host, "", old_text, new_text)
}

/// Stages only the selected hunks of a file's working-tree changes.
/// Indices refer to `vcs_diff_hunks(index_text, worktree_text)`.
#[tauri::command]
#[specta::specta]
pub fn vcs_stage_hunks(window: Window, state: State<'_, AppState>, path: PathBuf, hunks: Vec<u32>) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_stage_hunks(&state.host, window.label(), path, hunks)
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
    ide_host::ops::vcs::vcs_clone(&state.host, "", request, url, dest, crate::commands::sender(on_output)).await
}

/// `git init` in `dir` (File › New Project… "Create Git repository").
#[tauri::command]
#[specta::specta]
pub async fn vcs_init(state: State<'_, AppState>, dir: PathBuf) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_init(&state.host, "", dir).await
}

/// Settings › Git › Test: runs `git --version` on `path`, or on the auto-detected
/// executable when `path` is empty.
#[tauri::command]
#[specta::specta]
pub async fn vcs_git_version(state: State<'_, AppState>, path: String) -> IdeResult<GitExecutableInfo> {
    ide_host::ops::vcs::vcs_git_version(&state.host, "", path).await
}

/// The auto-detected git executable (shown as the field's placeholder).
#[tauri::command]
#[specta::specta]
pub fn vcs_detected_git(state: State<'_, AppState>) -> Option<String> {
    ide_host::ops::vcs::vcs_detected_git(&state.host, "")
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
    ide_host::ops::vcs::vcs_config_get(&state.host, window.label(), repo, key).await
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
    ide_host::ops::vcs::vcs_operation(
        &state.host,
        window.label(),
        repo,
        request,
        op,
        crate::commands::sender(on_output),
    )
    .await
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
    ide_host::ops::vcs::vcs_create_tag(&state.host, window.label(), repo, name, commit, message, force).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_tags(window: Window, state: State<'_, AppState>, repo: Option<PathBuf>) -> IdeResult<Vec<String>> {
    ide_host::ops::vcs::vcs_tags(&state.host, window.label(), repo).await
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
    ide_host::ops::vcs::vcs_merge_with(&state.host, window.label(), repo, branches, options).await
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
    ide_host::ops::vcs::vcs_rebase_with(&state.host, window.label(), repo, upstream, options).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_remotes(window: Window, state: State<'_, AppState>, repo: Option<PathBuf>) -> IdeResult<Vec<Remote>> {
    ide_host::ops::vcs::vcs_remotes(&state.host, window.label(), repo).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_edit_remote(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    edit: RemoteEdit,
) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_edit_remote(&state.host, window.label(), repo, edit).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_worktrees(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
) -> IdeResult<Vec<Worktree>> {
    ide_host::ops::vcs::vcs_worktrees(&state.host, window.label(), repo).await
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
    ide_host::ops::vcs::vcs_add_worktree(&state.host, window.label(), repo, path, commitish, new_branch).await
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
    ide_host::ops::vcs::vcs_remove_worktree(&state.host, window.label(), repo, path, force).await
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
    ide_host::ops::vcs::vcs_diff_with_worktree(&state.host, window.label(), repo, rev).await
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
    ide_host::ops::vcs::vcs_diff_revisions(&state.host, window.label(), repo, from, to).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_create_patch(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    source: PatchSource,
) -> IdeResult<String> {
    ide_host::ops::vcs::vcs_create_patch(&state.host, window.label(), repo, source).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_patch_preview(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    patch: String,
) -> IdeResult<Vec<PatchFile>> {
    ide_host::ops::vcs::vcs_patch_preview(&state.host, window.label(), repo, patch).await
}

#[tauri::command]
#[specta::specta]
pub async fn vcs_apply_patch(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    patch: String,
) -> IdeResult<ApplyOutcome> {
    ide_host::ops::vcs::vcs_apply_patch(&state.host, window.label(), repo, patch).await
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
    ide_host::ops::vcs::vcs_shelve(&state.host, window.label(), name, paths).await
}

#[tauri::command]
#[specta::specta]
pub fn vcs_shelves(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ShelvedChangeList>> {
    ide_host::ops::vcs::vcs_shelves(&state.host, window.label())
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
    ide_host::ops::vcs::vcs_unshelve(&state.host, window.label(), id, remove).await
}

#[tauri::command]
#[specta::specta]
pub fn vcs_shelf_delete(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_shelf_delete(&state.host, window.label(), id)
}

#[tauri::command]
#[specta::specta]
pub fn vcs_shelf_rename(window: Window, state: State<'_, AppState>, id: String, name: String) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_shelf_rename(&state.host, window.label(), id, name)
}

#[tauri::command]
#[specta::specta]
pub fn vcs_shelf_patch(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<String> {
    ide_host::ops::vcs::vcs_shelf_patch(&state.host, window.label(), id)
}

#[tauri::command]
#[specta::specta]
pub fn vcs_changelists_load(window: Window, state: State<'_, AppState>) -> IdeResult<ChangelistState> {
    ide_host::ops::vcs::vcs_changelists_load(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn vcs_changelists_save(window: Window, state: State<'_, AppState>, changelists: ChangelistState) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_changelists_save(&state.host, window.label(), changelists)
}

/// Create Patch › Save to file.
#[tauri::command]
#[specta::specta]
pub async fn vcs_write_patch(state: State<'_, AppState>, path: PathBuf, patch: String) -> IdeResult<()> {
    ide_host::ops::vcs::vcs_write_patch(&state.host, "", path, patch).await
}
