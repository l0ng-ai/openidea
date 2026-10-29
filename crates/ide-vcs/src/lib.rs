//! Git integration. Reads (status, diff, blame, log) use gitoxide in-process;
//! writes (commit, checkout, push/pull, stash, merge) shell out to `git` so
//! hooks, credentials and signing behave exactly as on the command line.

use ide_core::ignored::IgnoredNames;
use ide_core::{CancellationToken, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    Conflicted,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: ide_core::IpcPath,
    pub rel_path: String,
    /// Staged change, if any.
    pub staged: Option<ChangeKind>,
    /// Unstaged (working tree) change, if any.
    pub unstaged: Option<ChangeKind>,
    pub renamed_from: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// `None` when HEAD is detached.
    pub head: Option<String>,
    pub head_commit: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Merge / rebase / cherry-pick in progress.
    pub operation: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HunkKind {
    Added,
    Modified,
    Deleted,
}

/// Line-level change against HEAD for editor gutter markers (0-based lines).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineHunk {
    pub kind: HunkKind,
    pub start: u32,
    /// Lines in the current text (0 for pure deletions).
    pub lines: u32,
    pub old_start: u32,
    pub old_lines: u32,
    /// Original text of the hunk, for the inline diff popup / rollback.
    pub old_text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub commit: String,
    pub author: String,
    pub time_ms: f64,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time_ms: f64,
    pub summary: String,
    pub message: String,
    pub refs: Vec<String>,
    /// Committer time (Log › View Options › Commit Timestamp).
    #[serde(default)]
    pub commit_time_ms: f64,
}

/// Order of the Git Log (Graph Options › Sort).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogOrder {
    /// `--topo-order`: lines of history are not intermixed.
    #[default]
    Topo,
    /// `--date-order`: commit time, but never a parent before its children.
    Date,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub branch: Option<String>,
    pub path: Option<ide_core::IpcPath>,
    pub author: Option<String>,
    pub text: Option<String>,
    pub skip: u32,
    pub limit: u32,
    /// A revision range such as `@{u}..HEAD` (commits reachable from the right side but
    /// not the left). Takes precedence over `branch`.
    #[serde(default)]
    pub range: Option<String>,
    /// `text` is a regular expression (Log filter `.*`).
    #[serde(default)]
    pub text_regex: bool,
    /// `text` matches case-sensitively (Log filter `Cc`).
    #[serde(default)]
    pub text_match_case: bool,
    /// More starting revisions next to `branch` (Log Branch filter with several branches).
    #[serde(default)]
    pub branches: Vec<String>,
    /// More author needles next to `author`; a commit matches any of them (Log User filter).
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub order: LogOrder,
    /// Follow only the first parent of merges (`--first-parent`).
    #[serde(default)]
    pub first_parent: bool,
    /// Leave out merge commits (`--no-merges`); their children link to their parents.
    #[serde(default)]
    pub no_merges: bool,
    /// Committer time bounds (epoch ms; `since` inclusive, `until` exclusive). Parents
    /// outside the range are rewritten to their nearest shown ancestors (or dropped when
    /// older), so the graph stays connected.
    #[serde(default)]
    pub since_ms: Option<f64>,
    #[serde(default)]
    pub until_ms: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub last_commit_ms: f64,
    /// Tip commit id.
    #[serde(default)]
    pub commit: String,
}

/// Commit Options (IDEA's commit options popup).
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    pub amend: bool,
    pub sign_off: bool,
    /// `--author`, e.g. `Name <mail@example.com>`; `None` or blank uses the configured user.
    pub author: Option<String>,
    /// False skips the pre-commit and commit-msg hooks (`--no-verify`).
    pub run_hooks: bool,
    /// Files committed with only some of their changes (IDEA's partial commit). They are
    /// committed through a temporary index, so neither the working tree nor the other
    /// entries of the index change; afterwards their index entries match the new commit.
    #[serde(default)]
    pub partial: Vec<PartialCommitFile>,
}

/// A file of a partial commit: which of its changes against HEAD to commit.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PartialCommitFile {
    pub path: ide_core::IpcPath,
    /// The hunks to commit, as [`diff_hunks`] of the HEAD and on-disk texts reports them.
    pub hunks: Vec<HunkRange>,
}

/// A hunk identified by its line ranges (0-based), see [`LineHunk`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HunkRange {
    pub start: u32,
    pub lines: u32,
    pub old_start: u32,
    pub old_lines: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub kind: ChangeKind,
    pub old_path: Option<String>,
}

/// A file changed across several commits: its content at `before` ↔ at `after`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RevisionChange {
    /// Repository-relative path after the change (before it, for a deletion).
    pub path: String,
    pub kind: ChangeKind,
    /// Path at `before`, for a rename.
    pub old_path: Option<String>,
    /// Commit holding the old content; `None` when the file was added.
    pub before: Option<String>,
    /// Commit holding the new content; `None` when the file was deleted.
    pub after: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: u32,
    pub message: String,
    pub time_ms: f64,
}

/// Push dialog › Push tags: every tag, or only annotated tags on the pushed commits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PushTags {
    All,
    CurrentBranch,
}

/// What an interactive rebase does with one commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RebaseAction {
    Pick,
    /// Pick with a new message ([`RebaseEntry::message`]).
    Reword,
    /// Stop after applying, to amend it (Stop to Edit).
    Edit,
    /// Meld into the previous commit, combining the messages.
    Squash,
    /// Meld into the previous commit, keeping the previous message.
    Fixup,
    Drop,
}

/// One line of an interactive rebase plan.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseEntry {
    pub commit: String,
    pub action: RebaseAction,
    /// New message for a reword, or for the result of a squash group (set on its last line).
    #[serde(default)]
    pub message: Option<String>,
}

/// `git reset` modes offered by Reset Current Branch to Here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
    Keep,
}

/// A change list on the shelf.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShelvedChangeList {
    /// Folder name under the shelf directory.
    pub id: String,
    pub name: String,
    pub time_ms: f64,
    /// Branch checked out when the changes were shelved.
    pub branch: Option<String>,
    /// Repository-relative paths.
    pub files: Vec<ChangedFile>,
}

/// One file of a patch (Apply Patch preview).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PatchFile {
    /// Path relative to the repository root (after the change).
    pub path: String,
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub added: u32,
    pub removed: u32,
    pub binary: bool,
    /// Applies cleanly to the working tree (otherwise a 3-way merge is attempted).
    pub applies: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    /// Repository-relative paths changed without conflicts.
    pub applied: Vec<String>,
    /// Repository-relative paths left with conflicts (index stages for the merge UI).
    pub conflicts: Vec<String>,
}

/// How Checkout treats local changes that the switch would overwrite (IDEA's Smart
/// Checkout dialog).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckoutMode {
    /// Fail with [`CheckoutOutcome::LocalChanges`] and change nothing.
    #[default]
    Normal,
    /// Stash local changes, switch, and restore them (conflicts are left to resolve).
    Smart,
    /// Discard the local changes in the way (`git switch --discard-changes`).
    Force,
}

/// Checking out remote `origin/x` while local `x` has commits `origin/x` lacks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DivergedLocal {
    /// Rebase local `x` onto `origin/x` (IDEA "Rebase onto Remote").
    Rebase,
    /// Reset local `x` to `origin/x` (IDEA "Drop Local Commits").
    Reset,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutOptions {
    #[serde(default)]
    pub mode: CheckoutMode,
    /// Required when checking out a remote branch whose local namesake is ahead of it.
    #[serde(default)]
    pub diverged: Option<DivergedLocal>,
}

/// Result of [`Repo::checkout_with`]; the non-`Done` variants other than `Conflicts`
/// left the repository untouched.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckoutOutcome {
    Done,
    /// These local changes (repository-relative paths) would be overwritten.
    LocalChanges {
        files: Vec<String>,
    },
    /// Local branch `local` has commits that remote branch `remote` does not.
    LocalBranchAhead {
        local: String,
        remote: String,
    },
    /// Switched, but restoring the local changes (Smart Checkout) or the rebase stopped
    /// on conflicts in these files.
    Conflicts {
        files: Vec<String>,
    },
}

/// A deleted local branch, enough to restore it (IDEA's "Restore" notification action).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedBranch {
    pub name: String,
    /// The commit the branch pointed at.
    pub tip: String,
    /// Its upstream (`origin/x`), restored with it.
    pub upstream: Option<String>,
    /// It was not fully merged: its own commits are now unreachable from any branch.
    pub unmerged: bool,
}

/// Who stands on each side of the conflicts of the operation in progress (merge editor
/// titles, as IDEA labels them).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeSides {
    /// `merge`, `rebase`, `cherry-pick`, `revert`…; `None` outside an operation.
    pub operation: Option<String>,
    /// Git's "ours" is not the user's work: during a rebase stage 2 holds the commits
    /// rebased onto and stage 3 the user's commit being replayed. [`MergeVersions`] is
    /// already swapped; conflict markers in the file are not.
    pub reversed: bool,
    /// The current branch (for a rebase: the branch being rebased).
    pub branch: Option<String>,
    /// Short id of the commit being applied (REBASE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD)
    /// or merged (MERGE_HEAD).
    pub commit: Option<String>,
    /// The other branch: the one being merged, or the one rebased onto.
    pub other_branch: Option<String>,
}

/// The versions of a conflicted file as the merge editor shows them.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeVersions {
    pub base: Option<String>,
    /// The user's side ("Accept Yours"): git's stage 2, or stage 3 when `sides.reversed`.
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub sides: MergeSides,
    /// Three-way merge of the versions above: non-conflicting changes merged, each
    /// conflict left as a diff3 block (yours / base / theirs). `None` when a side is
    /// missing (deleted on one side).
    pub merged: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Changelist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub comment: String,
}

/// User change lists of a project and which list each changed file belongs to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelistState {
    pub lists: Vec<Changelist>,
    /// Id of the active list (receives new changes).
    pub active: String,
    /// Project-relative path → list id. Files not listed belong to the active list.
    #[serde(default)]
    pub files: std::collections::BTreeMap<String, String>,
}

mod blame;
pub mod changelists;
mod cli;
mod diff;
mod history;
mod ignore;
mod manage;
mod ops;
mod patch;
mod refs;
mod remotes;
mod repo;
mod roots;
pub mod shelf;
mod status;
mod write;

pub use cli::{detected_git_executable, git_version, set_askpass_env, set_git_executable};
pub use diff::build_partial_patch;
pub use ignore::{IgnoreDestination, add_to_ignore};
pub use manage::{MergeOptions, RebaseOptions, RemoteEdit, Worktree};
pub use remotes::Remote;
pub use roots::Repos;

/// Clones `url` into `dest` (which must not exist or be empty), streaming progress.
pub fn clone(url: &str, dest: &Path, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
    let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let dest = dest.to_string_lossy();
    cli::run_streaming(parent, &["clone", "--progress", "--", url, &dest], cancel, on_output)
}

/// Creates an empty repository in `dir` (`git init`).
pub fn init(dir: &Path) -> IdeResult<()> {
    cli::run(dir, &["init", "-q"], None).map(|_| ())
}

/// Line hunks of `new_text` against `old_text` (CRLF-normalised, Histogram diff), in the
/// order [`build_partial_patch`] indexes them.
pub fn diff_hunks(old_text: &str, new_text: &str) -> Vec<LineHunk> {
    diff::line_hunks(old_text, new_text)
}

/// An open git repository (worktree). Cheap to keep around; all reads re-check the
/// on-disk state, so it never needs to be reopened after external changes.
pub struct Repo {
    root: PathBuf,
    git_dir: PathBuf,
    inner: std::sync::Mutex<repo::Cache>,
    ignored: std::sync::RwLock<IgnoredNames>,
}

impl Repo {
    /// Discovers the repository containing `path`; `Ok(None)` when not under git.
    pub fn discover(path: &Path) -> IdeResult<Option<Self>> {
        repo::discover(path)
    }
    /// The worktree root.
    pub fn root(&self) -> &Path {
        &self.root
    }
    /// Untracked files with one of these names (or under such a folder) are not reported.
    pub fn set_ignored_names(&self, names: IgnoredNames) {
        *self.ignored.write().unwrap_or_else(|p| p.into_inner()) = names;
    }
    /// Staged (HEAD↔index) and unstaged (index↔worktree, incl. untracked) changes,
    /// sorted by path. Conflicted files report `unstaged: Conflicted` and no staged kind.
    pub fn status(&self) -> IdeResult<Vec<FileStatus>> {
        status::status(self)
    }
    pub fn branch_info(&self) -> IdeResult<BranchInfo> {
        refs::branch_info(self)
    }
    /// Current branch (short name; `None` when detached) and HEAD commit, without
    /// upstream tracking (cheap enough to call for every repository on each refresh).
    pub fn head(&self) -> IdeResult<(Option<String>, Option<String>)> {
        refs::head(&self.gix()?)
    }
    /// Merge / rebase / cherry-pick… in progress (cheap: no ref walking).
    pub fn operation(&self) -> IdeResult<Option<String>> {
        Ok(refs::operation(&self.gix()?))
    }
    /// Content of `path` at `rev` (default HEAD); `None` if absent there.
    /// `rev` may be any revision git understands, or `":"` / `":0"` for the index.
    pub fn file_at(&self, path: &Path, rev: Option<&str>) -> IdeResult<Option<String>> {
        let rel = self.rel_path(path)?;
        let repo = self.gix()?;
        Ok(repo::blob_at(&repo, &rel, rev.unwrap_or("HEAD"))?.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }
    /// Hunks of `current_text` against HEAD (or the index when `against_index`).
    ///
    /// Deletions have `lines == 0` and `start` = the line of the current text that now
    /// follows the removed block (equal to the line count when removed at the end).
    /// Files absent from the base yield one `Added` hunk; ignored files, binary files and
    /// paths outside the worktree yield no hunks.
    pub fn line_hunks(&self, path: &Path, current_text: &str, against_index: bool) -> IdeResult<Vec<LineHunk>> {
        let Ok(rel) = self.rel_path(path) else { return Ok(Vec::new()) };
        if rel.is_empty() || rel == ".git" || rel.starts_with(".git/") {
            return Ok(Vec::new());
        }
        let repo = self.gix()?;
        let base = repo::blob_at(&repo, &rel, if against_index { ":0" } else { "HEAD" })?;
        match base {
            Some(base) if base.contains(&0) => Ok(Vec::new()),
            Some(base) => Ok(diff::line_hunks(&String::from_utf8_lossy(&base), current_text)),
            None => {
                if repo::is_ignored(&repo, &rel)? {
                    return Ok(Vec::new());
                }
                Ok(diff::all_added(current_text))
            }
        }
    }
    /// One entry per line of the current text (`current_text`, or the file on disk).
    /// Lines not yet committed carry an all-zero commit id and author "Not Committed Yet".
    pub fn blame(&self, path: &Path, current_text: Option<&str>) -> IdeResult<Vec<BlameLine>> {
        write::blame(self, path, current_text)
    }
    /// Commits newest-first in topological order (children before parents).
    ///
    /// `branch` is any revision; when absent, HEAD plus all local and remote branches are
    /// walked. `path` limits to commits touching the path (file or directory), `author`
    /// matches name or email and `text` the message (both case-insensitive substrings).
    /// `skip`/`limit` paginate over the filtered result; `limit == 0` means no limit.
    /// `refs` decorations are `HEAD`, branch names (`main`, `origin/main`) and `tag: <name>`.
    pub fn log(&self, query: &LogQuery) -> IdeResult<Vec<Commit>> {
        history::log(self, query)
    }
    /// Files changed by `commit` relative to its first parent (renames detected).
    pub fn commit_files(&self, commit: &str) -> IdeResult<Vec<ChangedFile>> {
        history::commit_files(self, commit)
    }
    /// Combined changes of several commits (oldest first): per file, before the first commit
    /// that touched it ↔ after the last one (IDEA's multi-commit Git Log selection).
    pub fn commits_changes(&self, commits: &[String]) -> IdeResult<Vec<RevisionChange>> {
        history::commits_changes(self, commits)
    }
    /// Local and remote branches; the current branch first, then most recent first.
    pub fn branches(&self) -> IdeResult<Vec<Branch>> {
        refs::branches(self)
    }
    /// Stash entries, newest (`stash@{0}`) first.
    pub fn stashes(&self) -> IdeResult<Vec<Stash>> {
        refs::stashes(self)
    }
    /// Unified diff of a file: index↔worktree (`staged == false`, untracked files diff
    /// against /dev/null) or HEAD↔index (`staged == true`). Empty when unchanged.
    pub fn diff_text(&self, path: &Path, staged: bool) -> IdeResult<String> {
        write::diff_text(self, path, staged)
    }

    /// `git config --get <key>` (all scopes); `None` when unset.
    pub fn config_get(&self, key: &str) -> IdeResult<Option<String>> {
        let out = cli::run_raw(&self.root, &["config", "--get", key], None)?;
        Ok((out.code == Some(0)).then(|| out.stdout_str().trim().to_string()))
    }

    // ---- writes (git CLI) ----
    pub fn stage(&self, paths: &[PathBuf]) -> IdeResult<()> {
        write::stage(self, paths)
    }
    pub fn unstage(&self, paths: &[PathBuf]) -> IdeResult<()> {
        write::unstage(self, paths)
    }
    /// Applies a unified-diff patch to the index (partial staging of hunks/lines).
    /// Zero-context patches (see [`build_partial_patch`]) are accepted.
    pub fn stage_patch(&self, patch: &str) -> IdeResult<()> {
        write::stage_patch(self, patch)
    }
    /// Discards unstaged changes: tracked paths are restored from the index (staged
    /// changes are kept), untracked files and directories are deleted.
    pub fn discard(&self, paths: &[PathBuf]) -> IdeResult<()> {
        write::discard(self, paths)
    }
    /// Commits the index; returns the new HEAD commit id. An empty message with
    /// `amend` keeps the previous message.
    pub fn commit(&self, message: &str, amend: bool, sign_off: bool) -> IdeResult<String> {
        let options = CommitOptions { amend, sign_off, author: None, run_hooks: true, partial: Vec::new() };
        write::commit(self, message, &options)
    }
    /// Commits with the Commit Options popup's choices.
    pub fn commit_with(&self, message: &str, options: &CommitOptions) -> IdeResult<String> {
        write::commit(self, message, options)
    }
    /// Switches to `branch`. With `create`, creates it at HEAD. Without, a remote branch
    /// (`origin/x`) gets a local tracking branch and any other revision is checked out
    /// detached.
    pub fn checkout(&self, branch: &str, create: bool) -> IdeResult<()> {
        write::checkout(self, branch, create)
    }
    /// [`Repo::checkout`] as IDEA does it: local changes in the way are reported (or
    /// stashed / discarded per `options.mode`), and a remote branch whose local namesake
    /// is behind fast-forwards that branch, while one that is ahead is reported (or
    /// rebased / reset per `options.diverged`).
    pub fn checkout_with(&self, branch: &str, create: bool, options: &CheckoutOptions) -> IdeResult<CheckoutOutcome> {
        write::checkout_with(self, branch, create, options)
    }
    /// Creates branch `name` at `start` (default HEAD), optionally switching to it. A
    /// remote-tracking start point (`origin/x`) becomes the new branch's upstream.
    pub fn create_branch(&self, name: &str, start: Option<&str>, checkout: bool) -> IdeResult<()> {
        write::create_branch(self, name, start, checkout)
    }
    /// Undo Commit: resets the current branch to the parent of `commit` (which must be
    /// HEAD and not a merge) keeping its changes staged; undoing the initial commit
    /// leaves an unborn branch. Returns the undone commit's message.
    pub fn undo_commit(&self, commit: &str) -> IdeResult<String> {
        write::undo_commit(self, commit)
    }
    /// Deletes a local branch (`git branch -d`, `-D` when `force`).
    pub fn delete_branch(&self, branch: &str, force: bool) -> IdeResult<()> {
        write::delete_branch(self, branch, force)
    }
    /// Deletes a local branch as IDEA does: without asking, force-deleting one that is not
    /// fully merged (reported as `unmerged`), and returning what [`Repo::restore_branch`]
    /// needs to undo it.
    pub fn delete_branch_restorable(&self, branch: &str) -> IdeResult<DeletedBranch> {
        write::delete_branch_restorable(self, branch)
    }
    /// Recreates a deleted branch at its old tip, with its upstream.
    pub fn restore_branch(&self, deleted: &DeletedBranch) -> IdeResult<()> {
        write::restore_branch(self, deleted)
    }
    /// Renames a local branch (`git branch -m`); its upstream configuration moves with it.
    pub fn rename_branch(&self, from: &str, to: &str) -> IdeResult<()> {
        write::rename_branch(self, from, to)
    }
    /// Merges `branch` into HEAD; local changes are stashed and restored around it. On
    /// conflicts an error is returned and the repository is left mid-merge
    /// (`branch_info().operation == Some("merge")`).
    pub fn merge(&self, branch: &str) -> IdeResult<()> {
        write::merge(self, branch)
    }
    /// Rebases the current branch onto `onto`; local changes are stashed and restored.
    pub fn rebase(&self, onto: &str) -> IdeResult<()> {
        write::rebase(self, onto)
    }
    /// `keep_index`: changes already staged stay in the index (and the working tree).
    pub fn stash_push(&self, message: Option<&str>, include_untracked: bool, keep_index: bool) -> IdeResult<()> {
        write::stash_push(self, message, include_untracked, keep_index)
    }
    /// `reinstate_index`: also restore what was staged when the stash was made.
    pub fn stash_apply(&self, index: u32, pop: bool, reinstate_index: bool) -> IdeResult<()> {
        write::stash_apply(self, index, pop, reinstate_index)
    }
    /// Creates and checks out `branch` at the commit the stash was made on, applies the
    /// stash there (index included) and drops it.
    pub fn stash_branch(&self, index: u32, branch: &str) -> IdeResult<()> {
        write::stash_branch(self, index, branch)
    }
    /// Removes `stash@{index}` without applying it.
    pub fn stash_drop(&self, index: u32) -> IdeResult<()> {
        write::stash_drop(self, index)
    }
    /// Deletes a branch on a remote (`git push <remote> --delete <branch>`); `branch` is the
    /// remote-tracking name, e.g. `origin/feature`.
    pub fn delete_remote_branch(
        &self,
        branch: &str,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        write::delete_remote_branch(self, branch, cancel, on_output)
    }
    /// Network operations stream progress lines through `on_output`.
    /// Fetches all remotes (pruning deleted branches).
    pub fn fetch(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        cli::run_streaming(&self.root, &["fetch", "--progress", "--all", "--prune"], cancel, on_output)
    }
    /// Update Project: pulls the upstream by merge or rebase. Local changes are stashed
    /// and restored; the merge mode fast-forwards when possible whatever `pull.ff` says.
    pub fn pull(&self, rebase: bool, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        let mode: &[&str] = if rebase { &["--rebase"] } else { &["--no-rebase", "--ff"] };
        let mut args = vec!["pull", "--progress", "--autostash"];
        args.extend_from_slice(mode);
        cli::run_streaming(&self.root, &args, cancel, on_output)
    }
    /// Pushes the current branch. `set_upstream` pushes to the branch's remote (or
    /// `origin`) under the same name and records it as upstream.
    pub fn push(
        &self,
        force_with_lease: bool,
        set_upstream: bool,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        write::push(self, force_with_lease, set_upstream, None, cancel, on_output)
    }
    /// [`Repo::push`] that also pushes tags (Push dialog › Push tags).
    pub fn push_with_tags(
        &self,
        force_with_lease: bool,
        set_upstream: bool,
        tags: Option<PushTags>,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        write::push(self, force_with_lease, set_upstream, tags, cancel, on_output)
    }
    /// Pushes a local branch, or its history up to `revision`, to its upstream (Git Log
    /// › Push…, Push All up to Here).
    pub fn push_branch(
        &self,
        branch: &str,
        revision: Option<&str>,
        force_with_lease: bool,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        write::push_branch(self, branch, revision, None, force_with_lease, cancel, on_output)
    }
    /// [`Repo::push_branch`] to remote branch `target` instead of the upstream's name (the
    /// Push dialog's editable target).
    pub fn push_branch_to(
        &self,
        branch: &str,
        revision: Option<&str>,
        target: &str,
        force_with_lease: bool,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        write::push_branch(self, branch, revision, Some(target), force_with_lease, cancel, on_output)
    }
    /// Fast-forwards a local branch that is not checked out to its upstream (Branches ›
    /// Update). Fails when the branch has diverged.
    pub fn update_branch(&self, branch: &str, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        write::update_branch(self, branch, cancel, on_output)
    }
    // ---- in-progress operations, history rewriting, tags ----

    /// Continues the merge / rebase / cherry-pick / revert in progress; fails while
    /// conflicts are unresolved.
    pub fn continue_operation(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        ops::continue_op(self, cancel, on_output)
    }
    pub fn abort_operation(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        ops::abort_op(self, cancel, on_output)
    }
    /// Skips the current commit of a rebase / cherry-pick / revert.
    pub fn skip_operation(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        ops::skip_op(self, cancel, on_output)
    }
    /// Cherry-picks `commits` in order (oldest first). Stops mid-way on conflicts.
    pub fn cherry_pick(
        &self,
        commits: &[String],
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        ops::cherry_pick(self, commits, cancel, on_output)
    }
    /// Reverts `commits` in order (newest first) with git's default messages.
    pub fn revert(&self, commits: &[String], cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        ops::revert(self, commits, cancel, on_output)
    }
    /// Interactive rebase of `base..HEAD` (`None`: from the root) following `entries`,
    /// oldest first. Local changes are stashed and restored. Stops (leaving the rebase in
    /// progress) on conflicts and at `Edit` entries.
    pub fn interactive_rebase(
        &self,
        base: Option<&str>,
        entries: &[RebaseEntry],
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        ops::interactive_rebase(self, base, entries, cancel, on_output)
    }
    /// Moves the current branch to `commit` (`git reset --<mode>`).
    pub fn reset(
        &self,
        commit: &str,
        mode: ResetMode,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        ops::reset(self, commit, mode, cancel, on_output)
    }
    /// Creates tag `name` on `commit` (annotated when `message` is given).
    pub fn create_tag(&self, name: &str, commit: &str, message: Option<&str>, force: bool) -> IdeResult<()> {
        ops::create_tag(self, name, commit, message, force)
    }
    pub fn tags(&self) -> IdeResult<Vec<String>> {
        ops::tags(self)
    }
    /// Files that differ between revisions `from` and `to`.
    pub fn diff_revisions(&self, from: &str, to: &str) -> IdeResult<Vec<ChangedFile>> {
        ops::diff_revisions(self, from, to)
    }
    /// Tracked files whose working-tree content differs from `rev`.
    pub fn diff_with_worktree(&self, rev: &str) -> IdeResult<Vec<ChangedFile>> {
        ops::diff_with_worktree(self, rev)
    }
    /// `(repo-relative path, added lines, deleted lines)` of the tracked files whose
    /// working-tree content differs from `rev`.
    pub fn numstat_with_worktree(&self, rev: &str) -> IdeResult<Vec<(String, u32, u32)>> {
        ops::numstat_with_worktree(self, rev)
    }

    // ---- patches and shelf ----

    /// Patch of the local changes of `paths` against HEAD (untracked files included).
    pub fn create_patch(&self, paths: &[PathBuf], reverse: bool) -> IdeResult<String> {
        let rel = self.rel_paths(paths)?;
        Ok(patch::working_patch(self, &rel, reverse)?.0)
    }
    /// Patch of the changes made by `commits` (oldest first).
    pub fn create_commits_patch(&self, commits: &[String], reverse: bool) -> IdeResult<String> {
        patch::commits_patch(self, commits, reverse)
    }
    pub fn patch_preview(&self, patch: &str) -> IdeResult<Vec<PatchFile>> {
        patch::preview(self, patch)
    }
    /// Applies a patch to the working tree, 3-way merging when it does not apply cleanly.
    pub fn apply_patch(&self, patch: &str) -> IdeResult<ApplyOutcome> {
        patch::apply(self, patch)
    }
    /// Saves the changes of `paths` under `shelf_dir` and reverts them.
    pub fn shelve(&self, shelf_dir: &Path, name: &str, paths: &[PathBuf]) -> IdeResult<ShelvedChangeList> {
        let rel = self.rel_paths(paths)?;
        shelf::shelve(self, shelf_dir, name, &rel)
    }
    pub fn unshelve(&self, shelf_dir: &Path, id: &str, remove: bool) -> IdeResult<ApplyOutcome> {
        shelf::unshelve(self, shelf_dir, id, remove)
    }

    /// Who is on each side of the conflicts of the operation in progress.
    pub fn merge_sides(&self) -> IdeResult<MergeSides> {
        ops::merge_sides(self)
    }
    /// The versions of a conflicted file with the user's work as `ours`, as IDEA's merge
    /// dialog shows them (sides swapped during a rebase).
    pub fn merge_versions(&self, path: &Path) -> IdeResult<MergeVersions> {
        let (base, ours, theirs) = self.conflict_versions(path)?;
        let sides = self.merge_sides()?;
        let (ours, theirs) = if sides.reversed { (theirs, ours) } else { (ours, theirs) };
        let merged = match (&ours, &theirs) {
            (Some(o), Some(t)) => Some(ops::merge_file(self, o, base.as_deref().unwrap_or(""), t)?),
            _ => None,
        };
        Ok(MergeVersions { base, ours, theirs, sides, merged })
    }
    /// For conflict resolution: (base, ours, theirs) versions of a conflicted file.
    pub fn conflict_versions(&self, path: &Path) -> IdeResult<(Option<String>, Option<String>, Option<String>)> {
        let rel = self.rel_path(path)?;
        let repo = self.gix()?;
        let stage = |n: u8| -> IdeResult<Option<String>> {
            Ok(repo::blob_at(&repo, &rel, &format!(":{n}"))?.map(|b| String::from_utf8_lossy(&b).into_owned()))
        };
        Ok((stage(1)?, stage(2)?, stage(3)?))
    }
}
