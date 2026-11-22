//! Git integration. Reads (status, diff, blame, log) use gitoxide in-process;
//! writes (commit, checkout, push/pull, stash, merge) shell out to `git` so
//! hooks, credentials and signing behave exactly as on the command line.

use ide_core::ignored::IgnoredNames;
use ide_core::workflow_settings::{EmptyCherryPickAction, FetchTagsMode, GitAnnotateSettings};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::time::Instant;
pub use text_encoding::TextEncoding;
pub use write::PendingChange;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum StagingPatchSide {
    Staged,
    Unstaged,
    Both,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StagingPatchEntry {
    pub path: ide_core::IpcPath,
    pub renamed_from: Option<ide_core::IpcPath>,
    pub side: StagingPatchSide,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// `None` when HEAD is detached.
    pub head: Option<String>,
    pub head_commit: Option<String>,
    pub upstream: Option<String>,
    /// The upstream as configured on the current branch, even before its tracking ref is fetched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_tracking: Option<UpstreamTracking>,
    #[serde(default)]
    #[specta(optional)]
    pub tracked_tip: Option<TrackedTip>,
    pub ahead: u32,
    pub behind: u32,
    /// Outgoing commits to the default Push destination, when it has a local tracking ref.
    #[serde(default)]
    #[specta(optional)]
    pub outgoing: Option<OutgoingCommits>,
    /// Merge / rebase / cherry-pick in progress.
    pub operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rebase: Option<RebaseState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct UpstreamTracking {
    pub remote: String,
    pub branch: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TrackedTip {
    pub tracking: UpstreamTracking,
    pub commit: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct OutgoingCommits {
    pub remote: String,
    pub branch: String,
    /// Full local tracking ref, which may use a custom fetch refspec.
    pub reference: String,
    pub count: u32,
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
    /// The file blamed for this line when it had another path in the attributed commit.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub origin_path: Option<ide_core::IpcPath>,
}

/// History for Selection: the commits that changed a block of lines, newest first.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlockHistory {
    /// The selected lines in HEAD (0-based, inclusive); None when none of them is committed.
    pub head_lines: Option<(u32, u32)>,
    pub revisions: Vec<BlockRevision>,
}

/// A commit that changed the block, with the block in its first parent and in it.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlockRevision {
    pub id: String,
    pub short_id: String,
    pub author: String,
    pub email: String,
    pub time_ms: f64,
    pub summary: String,
    /// Repository-relative path of the file in this commit (before a later rename).
    pub path: String,
    /// The block before the commit; empty when the commit added it.
    pub before: String,
    pub after: String,
    /// 0-based first line of the block before and after the commit.
    pub before_line: u32,
    pub after_line: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    /// Connections in the filtered graph; never use these as revision/diff parents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_parents: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub graph_dashed: Vec<bool>,
    /// Repository-relative filename at this revision in rename-following history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_position: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_total: Option<u32>,
    /// Newest committer time at or after this row if newer than the row's commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_merge_time_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub graph_boundary_parents: Vec<String>,
    /// Reachability from HEAD, computed independently of the visible filters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_current_branch: Option<bool>,
    pub author: String,
    pub email: String,
    #[serde(default)]
    pub committer: String,
    #[serde(default)]
    pub committer_email: String,
    pub time_ms: f64,
    pub summary: String,
    pub message: String,
    #[serde(default)]
    pub message_truncated: bool,
    pub refs: Vec<String>,
    /// Committer time (Log › View Options › Commit Timestamp).
    #[serde(default)]
    pub commit_time_ms: f64,
    /// Legacy alias of `graph_dashed`, indexed by displayed parents.
    #[serde(default)]
    #[specta(optional)]
    pub dashed: Vec<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogDetails {
    pub message: String,
    pub containing_branches: Vec<String>,
    /// Git's verification code: G/U good, B bad, E error, N unsigned, X/Y expired, R revoked.
    pub signature: String,
    pub signer: String,
    pub key: String,
    pub fingerprint: String,
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
    // Topological grouping with incoming merge parents visited before the main line.
    Standard,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    #[serde(default)]
    pub speed_search: Option<String>,
    #[serde(default)]
    pub search_fields: Vec<String>,
    /// Jump directly to an indexed window containing this commit (50 rows of context).
    #[serde(default)]
    pub seek: Option<String>,
    #[serde(default)]
    pub retain_until: Option<String>,
    pub branch: Option<String>,
    pub path: Option<ide_core::IpcPath>,
    #[serde(default)]
    pub paths: Vec<ide_core::IpcPath>,
    /// File history follows renames; structure filters retain fixed paths.
    #[serde(default)]
    pub follow: bool,
    pub author: Option<String>,
    pub text: Option<String>,
    pub skip: u32,
    pub limit: u32,
    /// A revision range such as `@{u}..HEAD` (commits reachable from the right side but
    /// not the left). Takes precedence over `branch`.
    #[serde(default)]
    pub range: Option<String>,
    /// Additional ranges unioned with each other and with selected branches.
    #[serde(default)]
    pub ranges: Vec<String>,
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
    pub authors_exact: bool,
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
    #[serde(default)]
    pub request: Option<ide_core::RequestId>,
    #[serde(default)]
    pub summary_only: bool,
    /// Inclusive refresh boundary. Clients join only verified linear prefixes.
    #[serde(default)]
    pub stop_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub tracked_tip: Option<TrackedTip>,
    pub ahead: u32,
    pub behind: u32,
    #[serde(default)]
    #[specta(optional)]
    pub outgoing: Option<OutgoingCommits>,
    pub last_commit_ms: f64,
    /// Tip commit id.
    #[serde(default)]
    pub commit: String,
}

/// What Update Selected did to one local branch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BranchUpdateStatus {
    Updated,
    UpToDate,
    /// Diverged from its upstream: left as it is.
    NotFastForward,
    NoUpstream,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchUpdate {
    pub branch: String,
    pub status: BranchUpdateStatus,
    /// Why it failed.
    pub message: Option<String>,
    /// Linked worktree where the update was attempted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<ide_core::IpcPath>,
}

/// Commit Options (IDEA's commit options popup).
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    pub amend: bool,
    /// Amend this older commit instead of HEAD, with the history snapshot selected in the UI.
    #[serde(default)]
    pub amend_target: Option<AmendTarget>,
    pub sign_off: bool,
    /// `--author`, e.g. `Name <mail@example.com>`; `None` or blank uses the configured user.
    pub author: Option<String>,
    /// Explicit Git author date, e.g. an ISO 8601 timestamp with a time zone.
    #[serde(default)]
    pub author_date: Option<String>,
    /// False skips the pre-commit and commit-msg hooks (`--no-verify`).
    pub run_hooks: bool,
    /// Files committed with only some of their changes (IDEA's partial commit). They are
    /// committed through a temporary index, so neither the working tree nor the other
    /// entries of the index change; afterwards their index entries match the new commit.
    #[serde(default)]
    pub partial: Vec<PartialCommitFile>,
    /// Files committed with their working-tree content, staged or not.
    #[serde(default)]
    pub stage: Vec<ide_core::IpcPath>,
    /// Staged files left out of the commit; they stay staged afterwards.
    #[serde(default)]
    pub exclude: Vec<ide_core::IpcPath>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmendTarget {
    pub commit: String,
    pub head: HistoryTip,
    /// Remote-tracking branch names protected from history rewrites.
    #[serde(default)]
    pub protected_branches: Vec<String>,
}

/// A file of a partial commit: which of its changes against HEAD to commit.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PartialCommitFile {
    pub path: ide_core::IpcPath,
    /// The hunks to commit, as [`diff_hunks`] of the HEAD and on-disk texts reports them.
    pub hunks: Vec<HunkRange>,
    /// Hunks whose added and removed lines have individual inclusion.
    #[serde(default)]
    #[specta(optional)]
    pub line_hunks: Vec<PartialCommitHunk>,
    /// Before-commit edits against the exact text selected by these hunks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub prepared: Option<PreparedPartialCommit>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct PreparedPartialCommit {
    /// LF version of the selected text before running the language server.
    pub before: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PartialCommitHunk {
    pub range: HunkRange,
    /// The normalised texts that the user selected from, used to detect stale selections.
    pub old_text: String,
    pub new_text: String,
    /// Included deletions and additions, 0-based offsets within their respective sides.
    pub deletions: Vec<u32>,
    pub additions: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LargeCommitFile {
    pub path: ide_core::IpcPath,
    pub size: u64,
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
    /// Set when the entry is a symbolic link (git mode `120000`); only revision diffs fill it.
    #[serde(default)]
    #[specta(optional)]
    pub link: Option<LinkTarget>,
}

/// What a symbolic link in a revision points to, resolved inside that revision's tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LinkTarget {
    Dir,
    File,
    /// Dangling, outside the repository (absolute or above its root), or a link loop.
    Unresolved,
}

/// Added and deleted lines of one file between two revisions (`git diff --numstat`).
/// A rename keeps the counts of the content change; a pure rename is `0`/`0`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileLineStats {
    /// Path after the change (the only path, when the file was not renamed).
    pub path: String,
    pub old_path: Option<String>,
    pub added: u32,
    pub removed: u32,
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
    /// Set when the entry is a symbolic link, resolved at `after` (`before`, for a deletion).
    #[serde(default)]
    #[specta(optional)]
    pub link: Option<LinkTarget>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: u32,
    pub message: String,
    pub time_ms: f64,
    /// The stash commit; its changes are those against `base`.
    pub id: String,
    /// The commit the stash was made on (the stash commit's first parent).
    pub base: Option<String>,
    /// The stash's third parent, when untracked files were included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub untracked: Option<String>,
}

impl Stash {
    pub(crate) fn same_entry(&self, other: &Self) -> bool {
        self.id == other.id && self.message == other.message && self.time_ms == other.time_ms
    }
}

/// Applying or popping a stash can leave the working tree with conflicts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StashApplyOutcome {
    Done,
    Conflicts { repository: ide_core::IpcPath },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StashApplyResult {
    /// The entry's position when the operation started.
    pub index: u32,
    pub outcome: StashApplyOutcome,
}

/// Push dialog › Push tags: every tag, or only annotated tags on the pushed commits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PushTags {
    All,
    CurrentBranch,
}

/// Options of [`Repo::push_branch_to`]: which commits to push and where to.
#[derive(Clone, Copy, Debug, Default)]
pub struct PushBranchOptions<'a> {
    /// Push only up to this commit of the branch (`None`: the whole branch).
    pub revision: Option<&'a str>,
    /// Remote branch name (`None` keeps the upstream's / the local name).
    pub target: Option<&'a str>,
    /// Remote to push to (`None` keeps the upstream's / the default remote).
    pub remote: Option<&'a str>,
    /// `git push --force-with-lease`.
    pub force_with_lease: bool,
    /// `git push --force` (Force push anyway after a rejected force-with-lease push).
    pub force: bool,
    /// Record the target as the branch's upstream even when it already has one.
    pub set_upstream: bool,
    /// Skip the pre-push hook (`--no-verify`).
    pub no_verify: bool,
}

/// Options of [`Repo::push_with`]: the Push dialog's choices for the current branch.
#[derive(Clone, Copy, Debug, Default)]
pub struct PushOptions {
    /// `git push --force-with-lease`.
    pub force_with_lease: bool,
    /// `git push --force` (Force push anyway after a rejected force-with-lease push).
    pub force: bool,
    /// Push to the branch's remote under the same name and record it as upstream.
    pub set_upstream: bool,
    /// Push tags too.
    pub tags: Option<PushTags>,
    /// Skip the pre-push hook (`--no-verify`).
    pub no_verify: bool,
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
    /// Path base of the patch: the owning repository or a common directory for multiple repositories.
    #[serde(default)]
    pub repo: Option<ide_core::IpcPath>,
    /// Paths relative to the patch base.
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
    #[serde(default)]
    pub missing_base: bool,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PatchFileDiff {
    pub path: ide_core::IpcPath,
    pub old_path: Option<ide_core::IpcPath>,
    pub content: PatchDiffContent,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PatchDiffContent {
    Text { before: Option<String>, after: Option<String> },
    Conflict { local: Option<String>, base: Option<String>, patched: Option<String> },
    Raw { local: Option<String>, patch: String, applies: bool },
    Binary,
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
    /// Check the branch out even though another worktree has it checked out.
    #[serde(default)]
    pub ignore_other_worktrees: bool,
}

/// Result of [`Repo::checkout_with`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckoutOutcome {
    Done,
    /// These local changes (repository-relative paths) would be overwritten.
    LocalChanges {
        files: Vec<String>,
    },
    /// These untracked files (repository-relative paths) would be overwritten by the
    /// checkout; with `removed`, they would be removed by it (tracked here, absent
    /// from the target).
    UntrackedFiles {
        files: Vec<String>,
        removed: bool,
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
    /// Switched, but the saved changes could not be restored.
    RestoreFailed {
        message: String,
    },
    /// Git refused: `branch` is checked out in the linked worktree at `path`. Nothing
    /// changed; the branch can be worked on there.
    CheckedOutInWorktree {
        branch: String,
        path: PathBuf,
    },
}

impl CheckoutOutcome {
    fn switched(&self) -> bool {
        matches!(self, Self::Done | Self::Conflicts { .. } | Self::RestoreFailed { .. })
    }
}

/// HEAD before and after a history rewrite, for its Undo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HeadChange {
    pub before: String,
    pub after: String,
}

/// The branch tip before and after creation, used to roll back a partially successful operation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreation {
    pub tip: String,
    pub previous_tip: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct BranchCreationOutcome {
    pub checkout: CheckoutOutcome,
    /// Present once the branch was created, even if restoring local changes needs attention.
    pub created: Option<BranchCreation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RewrittenCommit {
    pub head: HeadChange,
    pub commit: String,
}

/// Branch and tip confirmed in the UI before editing history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct HistoryTip {
    pub branch: Option<String>,
    pub commit: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RebaseState {
    pub original: HistoryTip,
    pub onto: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BranchRebasePlan {
    pub head: HistoryTip,
    pub target: String,
    pub onto: String,
}

/// The refs shown before checking out and rebasing a branch onto the current branch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRebasePlan {
    pub base: HistoryTip,
    pub branch: String,
    pub branch_tip: Option<String>,
    pub remote: Option<CheckoutRebaseRemote>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRebaseRemote {
    pub name: String,
    pub commit: String,
    pub drop_local_commits: bool,
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
    /// Configured remote and source branch, if the upstream is remote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_upstream: Option<UpstreamTracking>,
    /// Tip that Git compared the deleted branch with when deciding it was unmerged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unmerged_base: Option<String>,
    /// Git required a force delete because the branch was not fully merged.
    pub unmerged: bool,
}

/// A deleted tag, enough to restore it (Restore in the tag-deleted notification).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedTag {
    pub name: String,
    /// What the tag pointed at: its tag object (annotated tags) or commit.
    pub target: String,
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

/// Which version the user accepts, relative to the merge editor's labels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

/// The versions of a conflicted file as the merge editor shows them.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeVersions {
    /// Binary versions are available for whole-file acceptance, without decoding their data.
    #[serde(default)]
    pub binary: bool,
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
    #[serde(default)]
    pub applied_commit: Option<CommitApplySource>,
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

mod backend;
mod bek;
mod blame;
mod block_history;
pub mod changelists;
mod cherry_pick_plan;
mod cli;
mod commit_message;
mod commit_rewrite;
pub use commit_message::{
    ApplyCommitOptions, ApplyCommitReview, CommitApplyKind, CommitApplySource, CommitMessageWatch, CommitMessages,
    PendingCommitApply,
};
mod compare;
mod conflict_resolution;
mod diff;
mod external_diff;
mod history;
mod ignore;
mod index_writes;
mod log_index;
mod manage;
mod ops;
mod patch;
mod preserve;
mod push_preview;
mod push_report;
mod rebase_editor;
mod worktree_config;
pub use ops::UNSTAGED_CHANGES_PREVENT_REBASE;
mod incoming;
mod refs;
mod remotes;
mod repo;
pub use repo::DiffEntry;
mod roots;
pub use compare::{CompareResult, CompareScope, RepositoryComparison, WorkingTreeChange};
pub mod shelf;
mod signing;
mod staged_text;
mod status;
mod submodules;
pub use index_writes::is_own_index_write;
pub use submodules::SubmoduleRollbackSource;
mod text_encoding;
mod write;

pub use backend::Backend;
pub use cherry_pick_plan::CherryPickOptions;
pub use cli::{
    GitCommandObserver, detected_git_executable, filter_overrides_from, git_version, restrict, set_askpass_env,
    set_default_git_executable, set_git_command_observer,
};
pub use diff::build_partial_patch;
pub use external_diff::{ExternalDiffSide, launch_external_diff};
pub use ide_core::error::{PushRefResult, PushRefStatus, PushReport};
pub use ignore::{IgnoreDestination, add_to_ignore};
pub use incoming::IncomingRefsReport;
pub use manage::{MergeOptions, MergeOutcome, RebaseOptions, RemoteEdit, Worktree};
pub use patch::{
    MappedPatch, PatchDirectoryMatches, PatchDirectoryScope, PatchPathMapping, PatchPlacement, ProjectPatch,
    discover_patch_directories, rebase_patch,
};
pub use push_preview::{
    CommitPushTarget, DefaultPushTarget, PushInspection, PushSelection, PushTargetChoices, PushTargetState,
};
pub use rebase_editor::{
    RebaseEdit, RebaseEditKind, RebaseEditorOperation, RebaseEditorReply, RebaseFixupMessage, RebaseTodoRow,
};
pub use remotes::{FetchReport, Remote};
pub use roots::{ProjectUpdateTarget, Repos};
pub use signing::{GitSigningConfig, GitSigningEdit, GpgSigningKey};
pub use staged_text::{StagedText, StagedTextEdit, StagingLineHunk, StagingLineHunks};

fn clone_args(url: &str, dest: &str, depth: Option<u32>, recurse_submodules: bool) -> IdeResult<Vec<String>> {
    if depth == Some(0) {
        return Err(IdeError::invalid("clone depth must be greater than zero"));
    }
    let mut args = vec!["-c".into(), "core.hooksPath=".into(), "clone".into(), "--progress".into()];
    if recurse_submodules {
        args.push("--recurse-submodules".into());
    }
    if let Some(depth) = depth {
        args.extend(["--depth".into(), depth.to_string()]);
    }
    args.extend(["--".into(), url.into(), dest.into()]);
    Ok(args)
}

/// Clones `url` into `dest` (which must not exist or be empty), streaming progress.
/// `depth` creates a shallow clone containing at most that many commits.
pub fn clone(
    url: &str,
    dest: &Path,
    depth: Option<u32>,
    recurse_submodules: bool,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let dest = if dest.is_absolute() { dest.to_path_buf() } else { std::env::current_dir()?.join(dest) };
    let dest = dest.to_string_lossy();
    // Cloning must not inherit an enclosing project's executable Git settings.
    let cwd = tempfile::tempdir()?;
    // No repository's config applies in that empty folder, so the user's git runs as it is.
    let _scope = ExecutionScope::enter(true);
    let args = clone_args(url, &dest, depth, recurse_submodules)?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    cli::run_streaming(cwd.path(), &args, cancel, on_output)
}

#[cfg(test)]
mod clone_tests {
    use super::clone_args;

    #[test]
    fn builds_full_and_shallow_clone_commands() {
        assert_eq!(
            clone_args("https://example.test/repo.git", "/tmp/repo", None, false).unwrap(),
            ["-c", "core.hooksPath=", "clone", "--progress", "--", "https://example.test/repo.git", "/tmp/repo"]
        );
        assert_eq!(
            clone_args("https://example.test/repo.git", "/tmp/repo", Some(3), true).unwrap(),
            [
                "-c",
                "core.hooksPath=",
                "clone",
                "--progress",
                "--recurse-submodules",
                "--depth",
                "3",
                "--",
                "https://example.test/repo.git",
                "/tmp/repo",
            ]
        );
        assert!(clone_args("https://example.test/repo.git", "/tmp/repo", Some(0), true).is_err());
    }
}

/// Creates an empty repository in `dir` (`git init`).
pub fn init(dir: &Path) -> IdeResult<()> {
    // `git init` runs nothing a repository config names, so the configured git runs as it is.
    let _scope = ExecutionScope::enter_with(true, opening_git_executable());
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
    execution_allowed: std::sync::atomic::AtomicBool,
    git_executable: std::sync::RwLock<Option<std::sync::Arc<Path>>>,
    root: PathBuf,
    git_dir: PathBuf,
    inner: std::sync::Mutex<repo::Cache>,
    ignored: std::sync::RwLock<IgnoredNames>,
    /// Working-tree status from `git status` instead of gitoxide.
    cli_status: std::sync::atomic::AtomicBool,
    automatic_shelf: std::sync::RwLock<Option<shelf::AutomaticShelf>>,
    log_index: std::sync::Mutex<log_index::LogIndex>,
    log_signatures: std::sync::Mutex<history::LogSignatureCache>,
    conflict_mutation: std::sync::Mutex<()>,
    amend_recovery: std::sync::Mutex<Option<commit_rewrite::PendingAmend>>,
    incoming_observations: std::sync::Mutex<incoming::IncomingObservations>,
}

impl Repo {
    /// Uses the project's Shelf for automatic preservation when configured by the host.
    pub fn set_automatic_shelf(&self, directory: Option<PathBuf>, changelist_root: Option<PathBuf>) {
        *self.automatic_shelf.write().unwrap_or_else(|poison| poison.into_inner()) =
            directory.map(|directory| shelf::AutomaticShelf { directory, changelist_root });
    }

    /// Restores this batch's pending Shelf after its repository commands have returned.
    pub fn finish_shelf_batch(&self, batch: &str) -> IdeResult<()> {
        let _scope = self.execution_scope();
        preserve::finish_batch(self, batch)
    }

    /// Discovers the repository containing `path`; `Ok(None)` when not under git. The
    /// repository is in Restricted Mode until [`Repo::set_execution_allowed`] says otherwise.
    pub fn discover(path: &Path) -> IdeResult<Option<Self>> {
        repo::discover(path)
    }
    /// The worktree root.
    pub fn root(&self) -> &Path {
        let _scope = self.execution_scope();
        &self.root
    }
    /// git's own folders for this worktree: its git dir and the common one (they differ for a
    /// linked worktree, whose `.git` file points into the main repository).
    pub fn metadata_dirs(&self) -> IdeResult<[PathBuf; 2]> {
        let _scope = self.execution_scope();
        Ok([self.git_dir.clone(), repo::absolute(self.gix()?.common_dir())?])
    }
    /// Untracked files with one of these names (or under such a folder) are not reported.
    pub fn set_ignored_names(&self, names: IgnoredNames) {
        let _scope = self.execution_scope();
        *self.ignored.write().unwrap_or_else(|p| p.into_inner()) = names;
    }
    /// Read the working-tree status with `git status` rather than in process: for file systems
    /// (encryption or protection layers) whose metadata only the system git reads correctly.
    pub fn set_cli_status(&self, on: bool) {
        self.cli_status.store(on, std::sync::atomic::Ordering::Release);
    }
    /// Staged (HEAD↔index) and unstaged (index↔worktree, incl. untracked) changes,
    /// sorted by path. Conflicted files report `unstaged: Conflicted` and no staged kind.
    pub fn status(&self) -> IdeResult<Vec<FileStatus>> {
        let _scope = self.execution_scope();
        status::status(self)
    }
    pub fn ignored_files(&self) -> IdeResult<Vec<FileStatus>> {
        let _scope = self.execution_scope();
        status::ignored_files(self)
    }
    /// Status of `paths` only (absolute; those outside the repository are ignored), for the
    /// dirty-scope refresh after a watcher batch. An empty list is the full status.
    pub fn status_paths(&self, paths: &[PathBuf]) -> IdeResult<Vec<FileStatus>> {
        let _scope = self.execution_scope();
        // Restricted Mode starts no program of the repository, and the scoped read is `git status`
        // with a pathspec: answer with the full gitoxide status instead.
        if !self.execution_allowed.load(std::sync::atomic::Ordering::Acquire) {
            return status::status(self);
        }
        if paths.is_empty() {
            return status::status_paths(self, &[]);
        }
        let rel: Vec<String> = paths.iter().filter_map(|p| self.given_rel_path(p).ok()).collect();
        if rel.is_empty() {
            return Ok(Vec::new());
        }
        status::status_paths(self, &rel)
    }
    pub fn branch_info(&self) -> IdeResult<BranchInfo> {
        let _scope = self.execution_scope();
        refs::branch_info(self)
    }
    /// Current branch (short name; `None` when detached) and HEAD commit, without
    /// upstream tracking (cheap enough to call for every repository on each refresh).
    pub fn head(&self) -> IdeResult<(Option<String>, Option<String>)> {
        let _scope = self.execution_scope();
        refs::head(&self.gix()?)
    }
    /// Merge / rebase / cherry-pick… in progress (cheap: no ref walking).
    pub fn operation(&self) -> IdeResult<Option<String>> {
        let _scope = self.execution_scope();
        Ok(refs::operation(&self.gix()?))
    }
    /// Whether Git is running an interactive rebase in this worktree.
    pub fn is_interactive_rebase(&self) -> bool {
        refs::rebase_dir(&self.git_dir).is_some_and(|dir| dir.join("interactive").is_file())
    }
    /// Content of `path` at `rev` (default HEAD); `None` if absent there.
    /// `rev` may be any revision git understands, or `":"` / `":0"` for the index.
    pub fn file_at(
        &self,
        path: &Path,
        rev: Option<&str>,
        encoding: impl Into<TextEncoding>,
    ) -> IdeResult<Option<String>> {
        let encoding = encoding.into();
        let _scope = self.execution_scope();
        Ok(self.blob_of(path, rev.unwrap_or("HEAD"))?.map(|b| text_encoding::decode(&b, encoding).into_owned()))
    }
    /// The file's git mode at `rev` as printed by git (`100644`, `100755`, `120000`…),
    /// `None` when absent there. `rev` follows `file_at`'s rules, `WT` reads the worktree.
    pub fn file_mode_at(&self, path: &Path, rev: Option<&str>) -> IdeResult<Option<String>> {
        let _scope = self.execution_scope();
        if rev == Some("WT") {
            return repo::worktree_mode(self.root(), &self.rel_path(path)?);
        }
        let rel = self.rel_path(path)?;
        let repo = self.gix()?;
        repo::mode_at(&repo, &rel, rev.unwrap_or("HEAD"))
    }
    /// Raw revision bytes, for encoding detection when the working file is absent.
    pub fn file_bytes_at(&self, path: &Path, rev: Option<&str>) -> IdeResult<Option<Vec<u8>>> {
        let _scope = self.execution_scope();
        self.blob_of(path, rev.unwrap_or("HEAD"))
    }
    /// Stage selected decoded hunks, retaining the index encoding, BOM and line endings.
    pub fn stage_hunks(
        &self,
        path: &Path,
        current: &str,
        selected: &[usize],
        encoding: impl Into<TextEncoding>,
    ) -> IdeResult<()> {
        let encoding = encoding.into();
        let _scope = self.execution_scope();
        write::stage_hunks(self, path, current, selected, encoding)
    }
    /// Hunks of `current_text` against HEAD (or the index when `against_index`).
    ///
    /// Deletions have `lines == 0` and `start` = the line of the current text that now
    /// follows the removed block (equal to the line count when removed at the end).
    /// Files absent from the base yield one `Added` hunk; ignored files, binary files and
    /// paths outside the worktree yield no hunks.
    pub fn line_hunks(
        &self,
        path: &Path,
        current_text: &str,
        against_index: bool,
        encoding: impl Into<TextEncoding>,
    ) -> IdeResult<Vec<LineHunk>> {
        let encoding = encoding.into();
        let _scope = self.execution_scope();
        let Ok(rel) = self.rel_path(path) else { return Ok(Vec::new()) };
        if rel.is_empty() || rel == ".git" || rel.starts_with(".git/") {
            return Ok(Vec::new());
        }
        let repo = self.gix()?;
        let base = repo::blob_at(&repo, &rel, if against_index { ":0" } else { "HEAD" })?;
        match base {
            Some(base) if text_encoding::is_binary(&base, encoding) => Ok(Vec::new()),
            Some(base) => Ok(diff::line_hunks(&text_encoding::decode(&base, encoding), current_text)),
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
    /// `revision` is the history to blame against (default `HEAD`); the merge view
    /// blames each side pane on the branch it belongs to (e.g. `MERGE_HEAD`).
    pub fn blame(
        &self,
        path: &Path,
        current_text: Option<&str>,
        revision: Option<&str>,
        encoding: impl Into<TextEncoding>,
    ) -> IdeResult<Vec<BlameLine>> {
        self.blame_with_options(
            path,
            current_text,
            revision,
            encoding.into(),
            GitAnnotateSettings { ignore_whitespace: false, ..GitAnnotateSettings::default() },
        )
    }

    pub fn blame_with_options(
        &self,
        path: &Path,
        current_text: Option<&str>,
        revision: Option<&str>,
        encoding: TextEncoding,
        options: GitAnnotateSettings,
    ) -> IdeResult<Vec<BlameLine>> {
        let _scope = self.execution_scope();
        write::blame(self, path, current_text, revision, encoding, options)
    }
    /// Adds `commit` to the list `blame.ignoreRevsFile` names, so annotate skips it; with none
    /// configured, to `.git-blame-ignore-revs` at the worktree root, which the local config then names.
    pub fn ignore_blame_revision(&self, commit: &str) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::ignore_blame_revision(self, commit)
    }
    /// History for Selection: commits that changed `lines` (0-based, inclusive, of the
    /// current text: `current_text`, or the file on disk), mapped to HEAD's lines first.
    pub fn block_history(
        &self,
        path: &Path,
        current_text: Option<&str>,
        lines: (u32, u32),
        encoding: impl Into<TextEncoding>,
        cancel: &CancellationToken,
    ) -> IdeResult<BlockHistory> {
        let encoding = encoding.into();
        let _scope = self.execution_scope();
        block_history::block_history(self, path, current_text, lines, encoding, cancel)
    }
    /// Commits newest-first in topological order (children before parents).
    ///
    /// `branch` is any revision; when absent, HEAD plus all local and remote branches are
    /// walked. `path` limits to commits touching the path (file or directory), `author`
    /// matches name or email and `text` the message (both case-insensitive substrings).
    /// `skip`/`limit` paginate over the filtered result; `limit == 0` means no limit.
    /// `refs` decorations are `HEAD`, branch names (`main`, `origin/main`) and `tag: <name>`.
    pub fn log(&self, query: &LogQuery) -> IdeResult<Vec<Commit>> {
        let _scope = self.execution_scope();
        history::log(self, query, &CancellationToken::new())
    }
    pub fn log_cancellable(&self, query: &LogQuery, cancel: &CancellationToken) -> IdeResult<Vec<Commit>> {
        let _scope = self.execution_scope();
        history::log(self, query, cancel)
    }
    /// Commits unique to `source` that have no equivalent on `target`; `None` if a ref is absent.
    pub fn not_cherry_picked(
        &self,
        source: &str,
        target: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<Option<Vec<String>>> {
        let _scope = self.execution_scope();
        history::not_cherry_picked(self, source, target, cancel)
    }
    /// Enables the disposable, content-addressed log cache outside the worktree.
    pub fn enable_log_index(&self, cache_dir: &Path) {
        let key = blake3::hash(self.git_dir.to_string_lossy().as_bytes()).to_hex().to_string();
        self.log_index.lock().unwrap_or_else(|p| p.into_inner()).open(&cache_dir.join(key));
    }
    /// Reference names and peeled commit ids, including tags and detached HEAD.
    pub fn log_refs(&self) -> IdeResult<std::collections::BTreeMap<String, String>> {
        let repo = self.gix()?;
        Ok(history::decorations(&repo)?
            .into_iter()
            .flat_map(|(id, names)| names.into_iter().map(move |name| (name, id.to_string())))
            .collect())
    }
    pub fn log_users(&self) -> IdeResult<Vec<String>> {
        let _scope = self.execution_scope();
        let out = cli::run(self.root(), &["log", "--all", "--format=%an <%ae>"], None)?;
        Ok(out
            .stdout_str()
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect())
    }
    pub fn log_details(&self, revision: &str) -> IdeResult<LogDetails> {
        self.log_details_cancellable(revision, &CancellationToken::new())
    }
    pub fn log_details_cancellable(&self, revision: &str, cancel: &CancellationToken) -> IdeResult<LogDetails> {
        self.log_details_batch_cancellable(&[revision.to_string()], cancel)?
            .into_iter()
            .next()
            .ok_or_else(|| IdeError::not_found("commit not found"))
    }

    pub fn invalidate_log_signatures(&self) {
        self.log_signatures.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    pub fn log_details_batch_cancellable(
        &self,
        revisions: &[String],
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<LogDetails>> {
        let _scope = self.execution_scope();
        let allowed = crate::execution_allowed();
        let repo = self.gix()?;
        let shallow: std::collections::HashSet<gix::ObjectId> =
            repo.shallow_commits().map_err(repo::gx)?.map(|ids| ids.iter().copied().collect()).unwrap_or_default();
        let mut out = Vec::with_capacity(revisions.len());
        let mut commit_ids = Vec::with_capacity(revisions.len());
        let mut verify = std::collections::HashSet::new();
        let mut uncached = Vec::new();
        let now = Instant::now();
        let generation = self.log_signatures.lock().unwrap_or_else(|p| p.into_inner()).generation;
        for revision in revisions {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let object = repo
                .find_object(repo::resolve(&repo, revision)?)
                .map_err(repo::gx)?
                .peel_to_commit()
                .map_err(repo::gx)?;
            let commit_id = object.id;
            commit_ids.push(commit_id);
            let end = object.data.windows(2).position(|s| s == b"\n\n").unwrap_or(object.data.len());
            let headers = &object.data[..end];
            let signed = headers.windows(8).any(|s| s == b"\ngpgsig " || s == b"\ngpgsig-");
            let message = self.log_index.lock().unwrap_or_else(|p| p.into_inner()).message(&repo, commit_id)?;
            let mut details = LogDetails {
                message,
                containing_branches: Vec::new(),
                signature: if signed { "E" } else { "N" }.into(),
                signer: String::new(),
                key: String::new(),
                fingerprint: String::new(),
            };
            if allowed && signed {
                let cache = self.log_signatures.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(signature) = cache.get(&commit_id, now) {
                    signature.apply(&mut details);
                } else {
                    verify.insert(commit_id);
                    uncached.push(out.len());
                }
            }
            out.push(details);
        }
        let checked_at = Instant::now();
        let signatures = history::log_signatures(self.root(), &verify, cancel)?;
        for i in uncached {
            if let Some(signature) = signatures.get(&commit_ids[i]) {
                signature.apply(&mut out[i]);
            }
        }
        self.log_signatures.lock().unwrap_or_else(|p| p.into_inner()).store(generation, checked_at, signatures);
        let branches_per_commit = {
            let mut index = self.log_index.lock().unwrap_or_else(|p| p.into_inner());
            let res = index.containing_branches_batch(&repo, &commit_ids, &shallow, cancel)?;
            index.flush();
            res
        };
        for (details, branches) in out.iter_mut().zip(branches_per_commit) {
            details.containing_branches = branches;
        }
        Ok(out)
    }

    /// Lists one immutable revision directory. Directory names end in `/`.
    pub fn revision_children(&self, revision: &str, directory: &str) -> IdeResult<Vec<String>> {
        let _scope = self.execution_scope();
        let repo = self.gix()?;
        let id = repo::resolve(&repo, revision)?.to_string();
        let directory = self.rel_path(std::path::Path::new(directory))?;
        let tree = if directory.is_empty() { id } else { format!("{id}:{directory}") };
        let out = cli::run(self.root(), &["ls-tree", "-z", "--", &tree], None)?;
        Ok(out
            .stdout
            .split(|b| *b == 0)
            .filter_map(|line| {
                let split = line.iter().position(|b| *b == b'\t')?;
                let name = String::from_utf8_lossy(&line[split + 1..]);
                let dir = line.starts_with(b"040000 ");
                Some(format!(
                    "{}{name}{}",
                    if directory.is_empty() { String::new() } else { format!("{directory}/") },
                    if dir { "/" } else { "" }
                ))
            })
            .collect())
    }

    pub fn revision_files(&self, revision: &str) -> IdeResult<Vec<String>> {
        let _scope = self.execution_scope();
        let repo = self.gix()?;
        let id = repo::resolve(&repo, revision)?.to_string();
        let out = cli::run(self.root(), &["ls-tree", "-r", "-z", "--name-only", "--", &id], None)?;
        Ok(out
            .stdout
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect())
    }
    /// Files changed by `commit` relative to its first parent (renames detected).
    pub fn commit_files(&self, commit: &str) -> IdeResult<Vec<ChangedFile>> {
        let _scope = self.execution_scope();
        history::commit_files(self, commit)
    }
    /// Combined changes of several commits (oldest first): per file, before the first commit
    /// that touched it ↔ after the last one (IDEA's multi-commit Git Log selection).
    pub fn commits_changes(&self, commits: &[String]) -> IdeResult<Vec<RevisionChange>> {
        let _scope = self.execution_scope();
        history::commits_changes(self, commits)
    }
    /// The combined changes of a selection whose display order can differ from history.
    pub fn commit_selection_changes(
        &self,
        commits: &[String],
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<RevisionChange>> {
        let _scope = self.execution_scope();
        history::commit_selection_changes(self, commits, cancel)
    }
    /// Local and remote branches; the current branch first, then most recent first.
    pub fn branches(&self) -> IdeResult<Vec<Branch>> {
        let _scope = self.execution_scope();
        refs::branches(self)
    }
    /// Stash entries, newest (`stash@{0}`) first.
    pub fn stashes(&self) -> IdeResult<Vec<Stash>> {
        let _scope = self.execution_scope();
        refs::stashes(self)
    }
    /// Working tree against a revision, optionally restricted to a file. Bounded and cancellable.
    pub fn working_tree_patch(
        &self,
        path: Option<&Path>,
        against: Option<&str>,
        max_bytes: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<String> {
        let _scope = self.execution_scope();
        let rev = against.unwrap_or("HEAD");
        if rev.is_empty() || rev.starts_with('-') || rev.contains('\0') {
            return Err(ide_core::IdeError::invalid("invalid revision"));
        }
        let rel = path.map(|p| self.rel_path(p)).transpose()?;
        let overrides = cli::filter_overrides(self.root(), cancel)?;
        let mut args: Vec<&str> = overrides.iter().map(String::as_str).collect();
        args.extend(["--literal-pathspecs", "--no-pager", "diff", "--no-ext-diff", "--no-textconv"]);
        args.extend_from_slice(cli::submodule_guards());
        args.extend([rev, "--"]);
        if let Some(rel) = &rel {
            args.push(rel);
        }
        let out = cli::run_bounded(self.root(), &args, cancel, max_bytes)?;
        Ok(out.stdout_str())
    }

    /// Unified diff of a file: index↔worktree (`staged == false`, untracked files diff
    /// against /dev/null) or HEAD↔index (`staged == true`). Empty when unchanged.
    pub fn diff_text(&self, path: &Path, staged: bool, encoding: impl Into<TextEncoding>) -> IdeResult<String> {
        let encoding = encoding.into();
        let _scope = self.execution_scope();
        write::diff_text(self, path, staged, encoding)
    }

    /// `git config --get <key>` (all scopes); `None` when unset.
    pub fn config_get(&self, key: &str) -> IdeResult<Option<String>> {
        let _scope = self.execution_scope();
        let out = cli::run_raw(&self.root, &["config", "--get", key], None)?;
        Ok((out.code == Some(0)).then(|| out.stdout_str().trim().to_string()))
    }

    /// Reads a boolean in Git's own config syntax, including implicit true.
    pub fn config_get_bool(&self, key: &str) -> IdeResult<Option<bool>> {
        let _scope = self.execution_scope();
        let args = ["config", "--type=bool", "--get", "--", key];
        let out = cli::run_raw(&self.root, &args, None)?;
        match (out.code, out.stdout_str().trim()) {
            (Some(0), "true") => Ok(Some(true)),
            (Some(0), "false") => Ok(Some(false)),
            (Some(1), _) if out.stderr.is_empty() => Ok(None),
            _ => Err(cli::failure(&args, &out.stderr, &out.stdout, out.code)),
        }
    }

    /// Sets `user.name` and `user.email` for commits: in this repository's config, or in the
    /// user's global one (`global`).
    pub fn set_user_identity(&self, name: &str, email: &str, global: bool) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let scope = if global { "--global" } else { "--local" };
        for (key, value) in [("user.name", name.trim()), ("user.email", email.trim())] {
            if value.is_empty() {
                return Err(IdeError::invalid(format!("{key} must not be empty")));
            }
            cli::run(&self.root, &["config", scope, key, value], None)?;
        }
        Ok(())
    }

    // ---- writes (git CLI) ----
    pub fn stage(&self, paths: &[PathBuf]) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::stage(self, paths)
    }
    pub fn stage_without_content(&self, paths: &[PathBuf]) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::stage_without_content(self, paths)
    }
    pub fn unstage(&self, paths: &[PathBuf]) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::unstage(self, paths)
    }
    /// Restores the selected worktree files from the index.
    pub fn restore_unstaged(&self, paths: &[PathBuf]) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::restore_unstaged(self, paths)
    }
    /// Applies a unified-diff patch to the index (partial staging of hunks/lines).
    /// Zero-context patches (see [`build_partial_patch`]) are accepted.
    pub fn stage_patch<E: Into<TextEncoding>>(
        &self,
        patch: &str,
        encoding: &dyn Fn(&Path) -> IdeResult<E>,
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::stage_patch(self, patch, &|path| encoding(path).map(Into::into))
    }
    /// Stages a formatter's edits against the index text it started from.
    pub fn stage_formatted_text(
        &self,
        path: &Path,
        before: &str,
        after: &str,
        encoding: impl Into<TextEncoding>,
    ) -> IdeResult<()> {
        let encoding = encoding.into();
        let _scope = self.execution_scope();
        let rel = self.rel_path(path)?;
        let staged = self
            .blob_of(path, ":0")?
            .filter(|bytes| !text_encoding::is_binary(bytes, encoding))
            .ok_or_else(|| IdeError::invalid("The selected index text changed"))?;
        let staged = text_encoding::decode(&staged, encoding);
        if diff::normalize_eol(&staged) != before {
            return Err(IdeError::invalid("The selected index text changed"));
        }
        let hunks = diff::line_hunks(&staged, after);
        let selected: Vec<_> = (0..hunks.len()).collect();
        let patch = diff::build_partial_patch(&rel, &staged, after, &selected);
        write::stage_patch(self, &patch, &|_| Ok(encoding))
    }
    /// Discards unstaged changes: tracked paths are restored from the index (staged
    /// changes are kept), untracked files and directories are deleted. A submodule goes back
    /// to the commit the index records, with its tracked files restored.
    pub fn discard(&self, paths: &[PathBuf]) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::discard(self, paths)
    }
    /// Commits the index; returns the new HEAD commit id. An empty message with
    /// `amend` keeps the previous message.
    pub fn commit(&self, message: &str, amend: bool, sign_off: bool) -> IdeResult<String> {
        let _scope = self.execution_scope();
        let options = CommitOptions { amend, sign_off, author: None, run_hooks: true, ..Default::default() };
        write::commit(self, message, &options, &|_| Ok(encoding_rs::UTF_8.into()))
    }
    /// Commits with the Commit Options popup's choices.
    pub fn commit_with<E: Into<TextEncoding>>(
        &self,
        message: &str,
        options: &CommitOptions,
        encoding: &dyn Fn(&Path) -> IdeResult<E>,
    ) -> IdeResult<String> {
        let _scope = self.execution_scope();
        write::commit(self, message, options, &|path| encoding(path).map(Into::into))
    }
    /// Appends the commit prepared during a failed earlier Amend.
    pub fn keep_amend_commit(&self, commit: &str) -> IdeResult<String> {
        let _scope = self.execution_scope();
        commit_rewrite::keep_amend(self, commit)
    }
    /// The text a partial commit would put in the index, without changing it.
    pub fn preview_partial_commit<E: Into<TextEncoding>>(
        &self,
        file: &PartialCommitFile,
        encoding: E,
    ) -> IdeResult<String> {
        let relative = self.rel_path(&file.path.0)?;
        write::partial_commit_text(self, &relative, file, encoding.into()).map(|(text, _)| text)
    }

    /// Included paths whose selected content contains CRLF without a Git line-ending policy.
    pub fn commit_crlf_paths<E: Into<TextEncoding>>(
        &self,
        paths: &[PathBuf],
        options: &CommitOptions,
        encoding: &dyn Fn(&Path) -> IdeResult<E>,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<ide_core::IpcPath>> {
        let _scope = self.execution_scope();
        write::commit_crlf_paths(self, paths, options, &|path| encoding(path).map(Into::into), cancel)
    }
    /// Check the selected sources for large files, respecting this repo's Git LFS configuration.
    pub fn commit_large_files<E: Into<TextEncoding>>(
        &self,
        paths: &[PathBuf],
        options: &CommitOptions,
        limit: u64,
        encoding: &dyn Fn(&Path) -> IdeResult<E>,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<LargeCommitFile>> {
        let _scope = self.execution_scope();
        write::commit_large_files(self, paths, options, limit, &|path| encoding(path).map(Into::into), cancel)
    }
    /// What [`Repo::commit_with`] would commit with `options`, file by file, without
    /// committing or touching the index: patches against HEAD, `max_bytes` in all.
    pub fn pending_changes<E: Into<TextEncoding>>(
        &self,
        options: &CommitOptions,
        max_bytes: usize,
        encoding: &dyn Fn(&Path) -> IdeResult<E>,
    ) -> IdeResult<Vec<PendingChange>> {
        let _scope = self.execution_scope();
        write::pending_changes(self, options, max_bytes, &|path| encoding(path).map(Into::into))
    }
    /// Switches to `branch`. With `create`, creates it at HEAD. Without, a remote branch
    /// (`origin/x`) gets a local tracking branch and any other revision is checked out
    /// detached.
    pub fn checkout(&self, branch: &str, create: bool) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::checkout(self, branch, create)
    }
    /// [`Repo::checkout`] as IDEA does it: local changes in the way are reported (or
    /// stashed / discarded per `options.mode`), and a remote branch whose local namesake
    /// is behind fast-forwards that branch, while one that is ahead is reported (or
    /// rebased / reset per `options.diverged`).
    pub fn checkout_with(&self, branch: &str, create: bool, options: &CheckoutOptions) -> IdeResult<CheckoutOutcome> {
        let _scope = self.execution_scope();
        write::checkout_with(self, branch, create, options)
    }
    /// Finds tracked local changes that may block a switch to `branch` without changing HEAD,
    /// the index, or the worktree.
    pub fn checkout_affected_files(&self, branch: &str) -> IdeResult<Vec<String>> {
        let _scope = self.execution_scope();
        write::checkout_affected_files(self, branch)
    }
    /// Creates branch `name` at `start` (default HEAD), optionally switching to it. A
    /// remote-tracking start point (`origin/x`) becomes the new branch's upstream.
    pub fn create_branch(&self, name: &str, start: Option<&str>, checkout: bool) -> IdeResult<()> {
        self.create_branch_with_overwrite(name, start, checkout, false)
    }

    /// Creates a branch or moves its tip when overwrite is explicitly enabled.
    pub fn create_branch_with_overwrite(
        &self,
        name: &str,
        start: Option<&str>,
        checkout: bool,
        overwrite: bool,
    ) -> IdeResult<()> {
        self.create_branch_recorded(name, start, checkout, overwrite, None).map(|_| ())
    }

    pub fn create_branch_recorded(
        &self,
        name: &str,
        start: Option<&str>,
        checkout: bool,
        overwrite: bool,
        expected_tip: Option<&str>,
    ) -> IdeResult<BranchCreation> {
        let options = checkout.then(CheckoutOptions::default);
        let outcome = self.create_branch_with(name, start, options.as_ref(), overwrite, expected_tip)?;
        outcome.created.ok_or_else(|| match outcome.checkout {
            CheckoutOutcome::CheckedOutInWorktree { branch, path } => IdeError::invalid(format!(
                "branch '{branch}' is already checked out in worktree at '{}'",
                path.display()
            )),
            _ => IdeError::invalid("Could not check out the new branch"),
        })
    }

    pub fn create_branch_with(
        &self,
        name: &str,
        start: Option<&str>,
        checkout: Option<&CheckoutOptions>,
        overwrite: bool,
        expected_tip: Option<&str>,
    ) -> IdeResult<BranchCreationOutcome> {
        let _scope = self.execution_scope();
        write::create_branch(self, name, start, checkout, overwrite, expected_tip)
    }

    pub fn undo_branch_creation(
        &self,
        name: &str,
        created: &BranchCreation,
        previous_head: Option<&HistoryTip>,
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::undo_branch_creation(self, name, created, previous_head)
    }
    /// Undo Commit: resets the current branch to the parent of `commit` (which must be
    /// HEAD and not a merge) keeping its changes staged; undoing the initial commit
    /// leaves an unborn branch. Returns the undone commit's message.
    pub fn undo_commit(&self, commit: &str) -> IdeResult<String> {
        let _scope = self.execution_scope();
        write::undo_commit(self, commit)
    }
    /// Edit Commit Message without touching the index or the working tree; returns HEAD
    /// before and after.
    pub fn reword(&self, commit: &str, message: &str) -> IdeResult<HeadChange> {
        let _scope = self.execution_scope();
        commit_rewrite::reword(self, commit, message)
    }

    /// Move selected file changes into a new commit immediately after the original.
    pub fn extract_commit_changes(
        &self,
        commit: &str,
        expected_head: &HistoryTip,
        paths: &[PathBuf],
        message: &str,
    ) -> IdeResult<RewrittenCommit> {
        let _scope = self.execution_scope();
        commit_rewrite::extract(self, commit, expected_head, paths, message)
    }

    /// Removes selected file changes from a commit, replaying later commits on the replacement.
    pub fn drop_commit_changes(
        &self,
        commit: &str,
        expected_head: &HistoryTip,
        paths: &[PathBuf],
        cancel: &CancellationToken,
        out: &dyn Fn(String),
    ) -> IdeResult<RewrittenCommit> {
        let _scope = self.execution_scope();
        commit_rewrite::drop_changes(self, commit, expected_head, paths, cancel, out)
    }

    /// Undoes a history rewrite: HEAD goes from `after` back to `before`, local changes kept.
    pub fn restore_head(&self, before: &str, after: &str) -> IdeResult<()> {
        self.restore_head_on_branch(before, after, None)
    }

    pub fn restore_head_on_branch(&self, before: &str, after: &str, branch: Option<&str>) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::restore_head(self, before, after, branch)
    }

    pub fn restore_rebase_checkout(
        &self,
        before: &str,
        after: &str,
        branch: &str,
        checkout: &HistoryTip,
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::restore_rebase_checkout(self, before, after, branch, checkout)
    }

    /// Deletes a local branch (`git branch -d`, `-D` when `force`).
    pub fn delete_branch(&self, branch: &str, force: bool) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::delete_branch(self, branch, force)
    }
    /// Deletes a local branch as IDEA does: without asking, force-deleting one that is not
    /// fully merged (reported as `unmerged`), and returning what [`Repo::restore_branch`]
    /// needs to undo it.
    pub fn delete_branch_restorable(&self, branch: &str) -> IdeResult<DeletedBranch> {
        let _scope = self.execution_scope();
        write::delete_branch_restorable(self, branch, None)
    }
    /// Deletes a local branch selected for cleanup with its remote branch.
    pub fn delete_tracking_branch(&self, branch: &str, tip: &str, upstream: &str) -> IdeResult<DeletedBranch> {
        let _scope = self.execution_scope();
        write::delete_branch_restorable(self, branch, Some((tip, upstream)))
    }
    /// Deletes a branch offered for cleanup after a merge, with a tip and HEAD ancestry check.
    pub fn delete_merged_branch(&self, branch: &str, expected_tip: &str) -> IdeResult<DeletedBranch> {
        let _scope = self.execution_scope();
        write::delete_merged_branch(self, branch, expected_tip)
    }
    /// Recreates a deleted branch at its old tip, with its upstream.
    pub fn restore_branch(&self, deleted: &DeletedBranch) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::restore_branch(self, deleted)
    }
    /// Renames a local branch (`git branch -m`); its upstream configuration moves with it,
    /// unless `unset_upstream` drops the tracking instead.
    pub fn rename_branch(&self, from: &str, to: &str, unset_upstream: bool) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::rename_branch(self, from, to, unset_upstream)
    }
    /// Merges `branch` into HEAD; local changes are stashed and restored around it. On
    /// conflicts an error is returned and the repository is left mid-merge
    /// (`branch_info().operation == Some("merge")`).
    pub fn merge(&self, branch: &str) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::merge(self, branch)
    }
    /// Rebases the current branch onto `onto`; local changes are stashed and restored.
    pub fn rebase(&self, onto: &str) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::rebase(self, onto)
    }

    pub fn rebase_branch(
        &self,
        plan: &BranchRebasePlan,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<HistoryTip> {
        let _scope = self.execution_scope();
        write::rebase_branch(self, plan, cancel, on_output)
    }
    /// Rebases the selected branch onto the original HEAD and leaves it checked out.
    pub fn checkout_rebase(
        &self,
        plan: &CheckoutRebasePlan,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<HistoryTip> {
        let _scope = self.execution_scope();
        write::checkout_rebase(self, plan, cancel, on_output)
    }
    /// `paths` (absolute) stashes only those files; empty stashes the whole working tree.
    /// `keep_index`: changes already staged stay in the index (and the working tree).
    pub fn stash_push(
        &self,
        message: Option<&str>,
        include_untracked: bool,
        keep_index: bool,
        paths: &[PathBuf],
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let _stash_lock = write::lock_stashes(self)?;
        write::stash_push(self, message, include_untracked, keep_index, paths)
    }
    /// `reinstate_index`: also restore what was staged when the stash was made.
    pub fn stash_apply(&self, index: u32, pop: bool, reinstate_index: bool) -> IdeResult<StashApplyOutcome> {
        let _scope = self.execution_scope();
        let _stash_lock = write::lock_stashes(self)?;
        write::stash_apply(self, &format!("stash@{{{index}}}"), pop, reinstate_index)
    }
    /// Creates and checks out `branch` at the commit the stash was made on, applies the
    /// stash there (index included) and drops it.
    pub fn stash_branch(&self, index: u32, branch: &str) -> IdeResult<StashApplyOutcome> {
        let _scope = self.execution_scope();
        let _stash_lock = write::lock_stashes(self)?;
        write::stash_branch(self, &format!("stash@{{{index}}}"), branch)
    }
    /// Restores the selected entry. Pop and branch creation remove it only after a successful restore.
    pub fn unstash_selected(
        &self,
        stash: &Stash,
        pop: bool,
        reinstate_index: bool,
        branch: Option<&str>,
    ) -> IdeResult<StashApplyResult> {
        let _scope = self.execution_scope();
        write::unstash_selected(self, stash, pop, reinstate_index, branch)
    }
    /// Removes `stash@{index}` without applying it.
    pub fn stash_drop(&self, index: u32) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let _stash_lock = write::lock_stashes(self)?;
        write::stash_drop(self, index)
    }
    /// Removes the selected stash, returning the position from which it was removed.
    pub fn drop_selected_stash(&self, stash: &Stash) -> IdeResult<u32> {
        let _scope = self.execution_scope();
        write::drop_selected_stash(self, stash)
    }
    /// Removes the repository's stash reflog without changing the index or working files.
    pub fn stash_clear(&self) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let _stash_lock = write::lock_stashes(self)?;
        cli::run(self.root(), &["stash", "clear"], None).map(|_| ())
    }
    /// Deletes a branch on a remote (`git push <remote> --delete <branch>`); `branch` is the
    /// remote-tracking name, e.g. `origin/feature`.
    pub fn delete_remote_branch(
        &self,
        branch: &str,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::delete_remote_branch(self, branch, cancel, on_output)
    }
    /// Network operations stream progress lines through `on_output`.
    /// Fetches all remotes (pruning deleted branches).
    pub fn fetch(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        self.fetch_with_tags(None, FetchTagsMode::Auto, cancel, on_output)
    }
    pub fn is_shallow(&self) -> IdeResult<bool> {
        self.gix()?.is_shallow().map_err(repo::gx)
    }
    /// Fetches the ancestors missing from a shallow checkout using Git's default fetch remote.
    pub fn unshallow(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        self.unshallow_with_tags(FetchTagsMode::Auto, cancel, on_output)
    }

    pub fn unshallow_with_tags(
        &self,
        tags: FetchTagsMode,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        if !self.is_shallow()? {
            return Ok(());
        }
        let mut args = vec!["fetch", "--progress", "--unshallow"];
        args.extend(remotes::fetch_tag_args(tags, false));
        cli::run_streaming(&self.root, &args, cancel, on_output)?;
        if self.is_shallow()? {
            return Err(IdeError::invalid("The remote did not provide the full history"));
        }
        Ok(())
    }
    /// Update Project: pulls the upstream by merge or rebase. Local changes are stashed
    /// and restored; the merge mode fast-forwards when possible whatever `pull.ff` says.
    pub fn pull(&self, rebase: bool, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        self.pull_checked_branch(rebase, None, cancel, on_output)
    }

    pub fn pull_checked_branch(
        &self,
        rebase: bool,
        expected_branch: Option<&str>,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        self.pull_checked_branch_with_tags(rebase, expected_branch, FetchTagsMode::Auto, cancel, on_output)
    }

    pub fn pull_checked_branch_with_tags(
        &self,
        rebase: bool,
        expected_branch: Option<&str>,
        tags: FetchTagsMode,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        self.pull_with_options(rebase, expected_branch, tags, false, cancel, on_output)
    }

    pub fn pull_for_project_update(
        &self,
        rebase: bool,
        tags: FetchTagsMode,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        self.pull_with_options(rebase, None, tags, true, cancel, on_output)
    }

    fn pull_with_options(
        &self,
        rebase: bool,
        expected_branch: Option<&str>,
        tags: FetchTagsMode,
        update_project: bool,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let tag_config = remotes::pull_tag_config(self, tags)?;
        let mut args: Vec<&str> = tag_config.iter().flat_map(|entry| ["-c", entry.as_str()]).collect();
        let mode: &[&str] = if rebase { &["--rebase"] } else { &["--no-rebase", "--ff"] };
        if update_project {
            args.extend(["-c", "submodule.recurse=false"]);
        }
        args.extend(["pull", "--progress"]);
        if update_project {
            args.push("--no-recurse-submodules");
        }
        args.extend_from_slice(mode);
        match tags {
            FetchTagsMode::Auto => {}
            FetchTagsMode::Sync => args.push("--prune"),
            FetchTagsMode::Always => args.push("--tags"),
            FetchTagsMode::Never => args.push("--no-tags"),
        }
        if let Some(branch) = expected_branch {
            write::require_checked_out_branch(self.root(), branch, cancel)?;
        }
        preserve::around(self, "Local changes saved before update", || {
            if let Some(branch) = expected_branch {
                write::require_checked_out_branch(self.root(), branch, cancel)?;
            }
            cli::run_streaming(&self.root, &args, cancel, on_output)
        })
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
        self.push_with(PushOptions { force_with_lease, set_upstream, ..Default::default() }, cancel, on_output)
            .map(drop)
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
        self.push_with(PushOptions { force_with_lease, set_upstream, tags, ..Default::default() }, cancel, on_output)
            .map(drop)
    }
    /// Pushes the current branch with the Push dialog's options.
    pub fn push_with(
        &self,
        options: PushOptions,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<PushReport> {
        let _scope = self.execution_scope();
        write::push(self, options, cancel, on_output)
    }
    /// Pushes the exact source and destination chosen in the Push dialog.
    pub fn push_selected(
        &self,
        selection: &PushSelection,
        inspected: Option<&PushInspection>,
        options: PushOptions,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<PushReport> {
        let _scope = self.execution_scope();
        write::push_selected(self, selection, inspected, options, cancel, on_output)
    }
    /// Repeats a rejected push with the exact lease reviewed in the dialog.
    pub fn force_push_rejected(
        &self,
        divergence: &ide_core::error::PushDivergence,
        tags: Option<PushTags>,
        no_verify: bool,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<PushReport> {
        let _scope = self.execution_scope();
        write::force_push_rejected(self, divergence, tags, no_verify, cancel, on_output)
    }
    /// Whether the repository has an executable hook `name` (e.g. `pre-push`), wherever
    /// `core.hooksPath` puts it: the Push dialog then offers to skip it.
    pub fn has_hook(&self, name: &str) -> IdeResult<bool> {
        let _scope = self.execution_scope();
        write::has_hook(self, name)
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
        let _scope = self.execution_scope();
        write::push_branch(
            self,
            branch,
            PushBranchOptions { revision, force_with_lease, ..Default::default() },
            cancel,
            on_output,
        )
        .map(drop)
    }
    /// [`Repo::push_branch`] to remote branch `target` (None keeps the upstream's name)
    /// and/or remote `remote` (None keeps the upstream's remote). The Push dialog's
    /// editable target and remote picker.
    pub fn push_branch_to(
        &self,
        branch: &str,
        options: PushBranchOptions<'_>,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<PushReport> {
        let _scope = self.execution_scope();
        write::push_branch(self, branch, options, cancel, on_output)
    }
    /// Update Project › Reset to the Remote Branch: the current branch is moved to its
    /// freshly fetched tracked branch; local commits are dropped, local changes kept.
    pub fn reset_to_upstream(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        self.reset_to_upstream_with_tags(FetchTagsMode::Auto, cancel, on_output)
    }

    pub fn reset_to_upstream_with_tags(
        &self,
        tags: FetchTagsMode,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        write::reset_to_upstream(self, tags, cancel, on_output)
    }
    /// Fast-forwards the requested branches to their upstreams, including branches
    /// checked out in a linked worktree. Fetches each remote once.
    pub fn update_branches(
        &self,
        branches: &[String],
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<Vec<BranchUpdate>> {
        self.update_branches_with_tags(branches, FetchTagsMode::Auto, cancel, on_output)
    }

    pub fn update_branches_with_tags(
        &self,
        branches: &[String],
        tags: FetchTagsMode,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<Vec<BranchUpdate>> {
        let _scope = self.execution_scope();
        write::update_branches(self, branches, tags, cancel, on_output)
    }
    // ---- in-progress operations, history rewriting, tags ----

    /// Continues the merge / rebase / cherry-pick / revert in progress; fails while
    /// conflicts are unresolved.
    pub fn continue_operation(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        self.continue_operation_with(false, EmptyCherryPickAction::default(), cancel, on_output).map(|_| ())
    }
    /// Stage and Retry: stages the changes of tracked files, then continues.
    pub fn stage_and_continue(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        self.continue_operation_with(true, EmptyCherryPickAction::default(), cancel, on_output).map(|_| ())
    }
    /// Continues the operation and reports the number of empty picks handled during it.
    pub fn continue_operation_with(
        &self,
        stage: bool,
        empty_action: EmptyCherryPickAction,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<u32> {
        let _scope = self.execution_scope();
        ops::continue_op(self, stage, |args| {
            cherry_pick_plan::resume(self, args, None, empty_action, cancel, on_output)
        })
    }
    /// Finishes the merge reviewed in the conflict resolver, using its prepared message.
    pub fn finish_merge(
        &self,
        branch: Option<&str>,
        head: &str,
        target: &str,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        ops::finish_merge(self, branch, head, target, cancel, on_output)
    }
    pub fn abort_operation(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        self.abort_expected_operation(None, cancel, on_output)
    }
    /// Aborts the operation in progress if it matches the operation the caller confirmed.
    pub fn abort_expected_operation(
        &self,
        expected: Option<&str>,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        ops::abort_op(self, expected, cancel, on_output)
    }
    /// Skips the current commit of a rebase / cherry-pick / revert.
    pub fn skip_operation(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        self.skip_operation_with(EmptyCherryPickAction::default(), cancel, on_output).map(|_| ())
    }
    /// Skips the current step and handles empty picks later in the sequence.
    pub fn skip_operation_with(
        &self,
        empty_action: EmptyCherryPickAction,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<u32> {
        let _scope = self.execution_scope();
        ops::skip_op(self, |args| cherry_pick_plan::resume(self, args, None, empty_action, cancel, on_output))
    }
    /// Cherry-picks `commits` in order (oldest first). Stops mid-way on conflicts.
    pub fn cherry_pick(
        &self,
        commits: &[String],
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        self.cherry_pick_with(commits, false, cancel, on_output)
    }
    /// [`Repo::cherry_pick`]; `record_origin` adds "(cherry picked from commit …)" (`-x`).
    pub fn cherry_pick_with(
        &self,
        commits: &[String],
        record_origin: bool,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let options = CherryPickOptions { record_origin, ..Default::default() };
        self.cherry_pick_with_options(commits, options, cancel, on_output).map(|_| ())
    }
    /// Cherry-picks oldest first, adding Git's origin line to the specified commits.
    pub fn cherry_pick_with_origins(
        &self,
        commits: &[String],
        origins: &[String],
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let options = CherryPickOptions { record_origin_for: origins, ..Default::default() };
        self.cherry_pick_with_options(commits, options, cancel, on_output).map(|_| ())
    }
    /// Cherry-picks oldest first and reports the number of empty picks handled.
    pub fn cherry_pick_with_options(
        &self,
        commits: &[String],
        options: CherryPickOptions<'_>,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<u32> {
        let _scope = self.execution_scope();
        cherry_pick_plan::start(self, commits, options, cancel, on_output)
    }
    /// Reverts `commits` in order (newest first) with git's default messages.
    pub fn revert(&self, commits: &[String], cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        let _scope = self.execution_scope();
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
        let _scope = self.execution_scope();
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
        let _scope = self.execution_scope();
        ops::reset(self, commit, mode, cancel, on_output)
    }
    /// Creates tag `name` on `commit` (annotated when `message` is given).
    pub fn create_tag(&self, name: &str, commit: &str, message: Option<&str>, force: bool) -> IdeResult<()> {
        let _scope = self.execution_scope();
        ops::create_tag(self, name, commit, message, force)
    }
    /// Deletes a local tag, returning what [`Repo::restore_tag`] needs to undo it.
    pub fn delete_tag(&self, name: &str) -> IdeResult<DeletedTag> {
        let _scope = self.execution_scope();
        ops::delete_tag(self, name)
    }
    /// Recreates a deleted tag (annotated ones with their message).
    pub fn restore_tag(&self, deleted: &DeletedTag) -> IdeResult<()> {
        let _scope = self.execution_scope();
        ops::restore_tag(self, deleted)
    }
    /// Pushes one tag to `remote` (Push Tag › Push to …).
    pub fn push_tag(
        &self,
        tag: &str,
        remote: &str,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<PushReport> {
        let _scope = self.execution_scope();
        ops::push_tag(self, tag, remote, false, cancel, on_output)
    }
    /// Deletes a tag on `remote` (Delete on Remote, after deleting it locally).
    pub fn delete_remote_tag(
        &self,
        tag: &str,
        remote: &str,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        ops::push_tag(self, tag, remote, true, cancel, on_output).map(drop)
    }
    /// Deletes a locally removed tag on the configured remotes only at its original tip.
    pub fn delete_tag_on_remotes(
        &self,
        deleted: &DeletedTag,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        ops::delete_tag_on_remotes(self, deleted, cancel, on_output)
    }
    pub fn tags(&self) -> IdeResult<Vec<String>> {
        let _scope = self.execution_scope();
        ops::tags(self)
    }
    /// Files that differ between revisions `from` and `to`.
    pub fn diff_revisions(&self, from: &str, to: &str) -> IdeResult<Vec<ChangedFile>> {
        let _scope = self.execution_scope();
        ops::diff_revisions(self, from, to)
    }
    /// Added and deleted lines between `from` and `to`. `paths` limits the diff to those
    /// repository-relative paths (both names of a rename); empty diffs every file.
    pub fn diff_numstat(&self, from: &str, to: &str, paths: &[String]) -> IdeResult<Vec<FileLineStats>> {
        let _scope = self.execution_scope();
        ops::diff_numstat(self, from, to, paths)
    }
    /// Tracked files whose working-tree content differs from `rev`.
    pub fn diff_with_worktree(&self, rev: &str) -> IdeResult<Vec<ChangedFile>> {
        let _scope = self.execution_scope();
        ops::diff_with_worktree(self, rev)
    }
    /// `(repo-relative path, added lines, deleted lines)` of the tracked files whose
    /// working-tree content differs from `rev`.
    pub fn numstat_with_worktree(&self, rev: &str) -> IdeResult<Vec<(String, u32, u32)>> {
        let _scope = self.execution_scope();
        ops::numstat_with_worktree(self, rev)
    }

    // ---- patches and shelf ----

    /// Patch of the local changes of `paths` against HEAD (untracked files included).
    pub fn create_patch(&self, paths: &[PathBuf], reverse: bool) -> IdeResult<String> {
        let _scope = self.execution_scope();
        let rel = self.rel_paths(paths)?;
        Ok(patch::working_patch(self, &rel, reverse, true)?.0)
    }
    /// Patch of the selected sides of the index, with paths relative to the export base.
    pub fn create_staging_patch(
        &self,
        entries: &[StagingPatchEntry],
        reverse: bool,
        prefix: &str,
    ) -> IdeResult<String> {
        let _scope = self.execution_scope();
        patch::staging_patch(self, entries, reverse, prefix)
    }
    /// Patch of the changes made by `commits` (oldest first).
    pub fn create_commits_patch(&self, commits: &[String], reverse: bool) -> IdeResult<String> {
        let _scope = self.execution_scope();
        patch::commits_patch(self, commits, reverse)
    }
    /// A binary-safe patch of the selected files between two revisions.
    pub fn create_revisions_patch(&self, before: &str, after: &str, paths: &[PathBuf]) -> IdeResult<String> {
        let _scope = self.execution_scope();
        patch::revisions_patch(self, before, after, paths)
    }
    pub fn patch_preview(&self, patch: &str) -> IdeResult<Vec<PatchFile>> {
        let _scope = self.execution_scope();
        patch::preview(self, patch)
    }
    pub fn patch_file_diff(
        &self,
        patch: &str,
        path: &str,
        encoding: &dyn Fn(&Path, &[u8]) -> TextEncoding,
    ) -> IdeResult<PatchFileDiff> {
        let _scope = self.execution_scope();
        patch::file_diff::generate(self, patch, path, "", encoding)
    }
    /// Applies a patch to the working tree, 3-way merging when it does not apply cleanly.
    pub fn apply_patch(&self, patch: &str) -> IdeResult<ApplyOutcome> {
        let _scope = self.execution_scope();
        patch::apply_for_review(self, patch, "")
    }
    /// Applies the file sections with the selected destination paths.
    pub fn apply_selected_patch(&self, patch: &str, paths: &[String]) -> IdeResult<ApplyOutcome> {
        let _scope = self.execution_scope();
        patch::apply_selected(self, patch, paths)
    }
    /// Saves the changes of `paths` under `shelf_dir` and reverts them.
    pub fn shelve(&self, shelf_dir: &Path, name: &str, paths: &[PathBuf]) -> IdeResult<ShelvedChangeList> {
        let _scope = self.execution_scope();
        let rel = self.rel_paths(paths)?;
        shelf::shelve(self, shelf_dir, name, &rel)
    }
    pub fn unshelve(&self, shelf_dir: &Path, id: &str, remove: bool) -> IdeResult<ApplyOutcome> {
        let _scope = self.execution_scope();
        shelf::unshelve(self, shelf_dir, id, remove)
    }

    /// Who is on each side of the conflicts of the operation in progress.
    pub fn merge_sides(&self) -> IdeResult<MergeSides> {
        let _scope = self.execution_scope();
        ops::merge_sides(self)
    }

    /// Files with saved resolutions from an ongoing Git operation.
    pub fn resolved_conflicts(&self) -> IdeResult<Vec<PathBuf>> {
        let _scope = self.execution_scope();
        conflict_resolution::resolved_paths(self)
    }

    /// Restores the original conflict stages and worktree contents for resolved files.
    pub fn revert_resolved_conflicts(&self, paths: &[PathBuf]) -> IdeResult<()> {
        let _scope = self.execution_scope();
        conflict_resolution::revert_resolved(self, paths)
    }
    /// Resolves each selected path using the chosen index stage, including its mode or deletion.
    pub fn accept_conflict_side(&self, paths: &[PathBuf], side: ConflictSide) -> IdeResult<()> {
        let _scope = self.execution_scope();
        conflict_resolution::accept_side(self, paths, side)
    }
    /// The versions of a conflicted file with the user's work as `ours`, as IDEA's merge
    /// dialog shows them (sides swapped during a rebase).
    pub fn merge_versions(&self, path: &Path, encoding: impl Into<TextEncoding>) -> IdeResult<MergeVersions> {
        let encoding = encoding.into();
        let _scope = self.execution_scope();
        let sides = self.merge_sides()?;
        let blobs = self.conflict_blobs(path)?;
        if blobs.iter().flatten().any(|bytes| text_encoding::is_binary(bytes, encoding)) {
            return Ok(MergeVersions { binary: true, base: None, ours: None, theirs: None, sides, merged: None });
        }
        let [base, ours, theirs] = decode_conflict_blobs(blobs, encoding);
        let (ours, theirs) = if sides.reversed { (theirs, ours) } else { (ours, theirs) };
        let merged = match (&ours, &theirs) {
            (Some(o), Some(t)) => Some(ops::merge_file(self, o, base.as_deref().unwrap_or(""), t)?),
            _ => None,
        };
        Ok(MergeVersions { binary: false, base, ours, theirs, sides, merged })
    }
    /// For conflict resolution: (base, ours, theirs) versions of a conflicted file.
    pub fn conflict_versions(
        &self,
        path: &Path,
        encoding: impl Into<TextEncoding>,
    ) -> IdeResult<(Option<String>, Option<String>, Option<String>)> {
        let _scope = self.execution_scope();
        let [base, ours, theirs] = decode_conflict_blobs(self.conflict_blobs(path)?, encoding.into());
        Ok((base, ours, theirs))
    }

    fn conflict_blobs(&self, path: &Path) -> IdeResult<[Option<Vec<u8>>; 3]> {
        let rel = self.rel_path(path)?;
        let repo = self.gix()?;
        let stage = |revision| repo::blob_at(&repo, &rel, revision);
        Ok([stage(":1")?, stage(":2")?, stage(":3")?])
    }
}

fn decode_conflict_blobs(blobs: [Option<Vec<u8>>; 3], encoding: TextEncoding) -> [Option<String>; 3] {
    blobs.map(|blob| blob.map(|bytes| text_encoding::decode(&bytes, encoding).into_owned()))
}

/// What git started on this thread may do, and which executable it is.
#[derive(Clone)]
struct Grant {
    allowed: bool,
    git: Option<std::sync::Arc<Path>>,
}

// `None`: nobody has decided yet. Git started now is restricted, and the first scope entered
// decides. The grant governs the git CLI only: gitoxide follows the repository's own flag.
thread_local! { static EXECUTION: std::cell::RefCell<Option<Grant>> = const { std::cell::RefCell::new(None) }; }
struct ExecutionScope(Option<Grant>);
impl ExecutionScope {
    fn enter(allowed: bool) -> Self {
        Self::enter_with(allowed, None)
    }
    /// The outermost scope decides; a scope inside it can only restrict.
    fn enter_with(allowed: bool, git: Option<std::sync::Arc<Path>>) -> Self {
        EXECUTION.with(|current| {
            let mut current = current.borrow_mut();
            let grant = match current.as_ref() {
                Some(outer) => Grant { allowed: outer.allowed && allowed, git: outer.git.clone() },
                None => Grant { allowed, git },
            };
            Self(current.replace(grant))
        })
    }
}
impl Drop for ExecutionScope {
    fn drop(&mut self) {
        EXECUTION.with(|current| *current.borrow_mut() = self.0.take());
    }
}
pub(crate) fn execution_allowed() -> bool {
    EXECUTION.with(|current| current.borrow().as_ref().is_some_and(|grant| grant.allowed))
}
/// The git executable of the repository whose scope this thread is in, when it may execute.
pub(crate) fn scoped_git_executable() -> Option<std::sync::Arc<Path>> {
    EXECUTION
        .with(|current| current.borrow().as_ref().filter(|grant| grant.allowed).and_then(|grant| grant.git.clone()))
}

thread_local! { static OPENING_GIT: std::cell::RefCell<Option<std::sync::Arc<Path>>> = const { std::cell::RefCell::new(None) }; }

/// Runs `f` with `git` (a project's Path to Git executable; `None` for the default) as the git
/// executable of every [`Repo`] opened in it on this thread, and of [`init`]: for work on behalf
/// of a project that opens its own repositories. It grants no execution.
pub fn with_git_executable<T>(git: Option<&Path>, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<std::sync::Arc<Path>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            OPENING_GIT.with(|opening| *opening.borrow_mut() = self.0.take());
        }
    }
    let git = git.filter(|p| !p.as_os_str().is_empty()).map(std::sync::Arc::from);
    let _restore = Restore(OPENING_GIT.with(|opening| opening.replace(git)));
    f()
}
pub(crate) fn opening_git_executable() -> Option<std::sync::Arc<Path>> {
    OPENING_GIT.with(|opening| opening.borrow().clone())
}
impl Repo {
    /// Whether git may run what the repository's config names (hooks, filters, the fsmonitor,
    /// signature verifiers, a promisor) and use the configured git executable. A repository
    /// starts without it: only a caller that knows the project is trusted grants it.
    pub fn set_execution_allowed(&self, allowed: bool) {
        let _scope = self.execution_scope();
        self.execution_allowed.store(allowed, std::sync::atomic::Ordering::Release);
    }
    /// The git executable from this repository's project settings (`None` or empty: the default,
    /// see [`set_default_git_executable`]). A relative path resolves against the worktree root.
    /// Used only while execution is allowed.
    pub fn set_git_executable(&self, path: Option<&Path>) {
        let path = path.filter(|p| !p.as_os_str().is_empty()).map(std::sync::Arc::from);
        *self.git_executable.write().unwrap_or_else(|p| p.into_inner()) = path;
    }
    fn execution_scope(&self) -> ExecutionScope {
        let git = self.git_executable.read().unwrap_or_else(|p| p.into_inner()).clone();
        ExecutionScope::enter_with(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire), git)
    }
}
