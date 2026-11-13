//! The version-control backend abstraction (#743).
//!
//! `ide-vcs` grew up Git-only: [`Repo`] talks to git through gitoxide and the
//! `git` CLI. A second backend (Perforce first, maybe SVN later) must serve the
//! same UI — the Commit / Local Changes tool window, the diff viewer, the log
//! and Annotate — without that UI learning backend specifics.
//!
//! [`Backend`] is that surface: status of the working area, the text and mode
//! of a file at a revision, unified diffs, line hunks and annotate, the change
//! log, and the writes a user makes from the Changes view — stage ("open for
//! edit/add" in Perforce), discard ("revert") and commit ("submit").
//!
//! Deliberately Git-only concepts stay on [`Repo`]: branches and remotes,
//! stash, rebase/merge/cherry-pick, tags, worktrees, the index's staged /
//! unstaged split beyond what [`FileStatus`] already carries, and Restricted
//! Mode. A caller that needs them downcasts through [`Backend::as_git`]; a
//! caller that must work for every backend uses only the trait. As Perforce
//! support lands, methods that turn out to be needed generically move here.

use crate::{
    BlameLine, BlockHistory, ChangedFile, Commit, CommitOptions, FileStatus, LineHunk, LogQuery, PendingChange, Repo,
    RevisionChange, TextEncoding,
};
use ide_core::{CancellationToken, IdeResult};
use std::path::{Path, PathBuf};

/// The version-control surface the Changes view, diff viewer, annotate and log
/// need from a repository. Implemented by every supported backend; today that
/// is Git via [`Repo`].
///
/// Revision strings follow the backend's own syntax: git revisions (`HEAD`,
/// `:0` for the index, ids, `<id>^`…) for the Git backend; a Perforce backend
/// takes `#have`, `@label` or a change number, and its "index" side is the
/// opened-file state.
pub trait Backend: Send + Sync {
    /// The repository's working root.
    fn root(&self) -> &Path;

    /// Working-area changes, in the same shape `git status` gives: staged and
    /// unstaged kinds per path. A backend without an index reports everything
    /// as `unstaged`.
    fn status(&self) -> IdeResult<Vec<FileStatus>>;

    /// Text of `path` at `rev`; `None` when absent there.
    fn file_at(&self, path: &Path, rev: Option<&str>, encoding: TextEncoding) -> IdeResult<Option<String>>;

    /// The file's mode at `rev` in the backend's own notation (git's `100644`,
    /// `100755`, `120000`…; a Perforce backend reports the filetype, where
    /// `+x` is the executable case). `None` when absent there. The diff viewer
    /// shows "File mode changed" when the texts compare equal but the modes
    /// differ. `rev` follows [`file_at`](Self::file_at)'s rules, `WT` reads the
    /// worktree.
    fn file_mode_at(&self, path: &Path, rev: Option<&str>) -> IdeResult<Option<String>>;

    /// Unified diff text of `path`'s working change (against the depot/HEAD
    /// side), empty when unchanged.
    fn diff_text(&self, path: &Path, staged: bool, encoding: TextEncoding) -> IdeResult<String>;

    /// Working tree against `against` (or the base revision) as a patch,
    /// optionally restricted to a file.
    fn working_tree_patch(
        &self,
        path: Option<&Path>,
        against: Option<&str>,
        max_bytes: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<String>;

    /// Gutter markers: `current_text`'s hunks against the base.
    fn line_hunks(
        &self,
        path: &Path,
        current_text: &str,
        against_index: bool,
        encoding: TextEncoding,
    ) -> IdeResult<Vec<LineHunk>>;

    /// Annotate: who last changed each line of `path` (`text` when given is the
    /// buffer, not the disk file).
    fn blame(
        &self,
        path: &Path,
        text: Option<&str>,
        revision: Option<&str>,
        encoding: TextEncoding,
    ) -> IdeResult<Vec<BlameLine>>;

    /// History for Selection: the changes that touched `lines` (0-based) of
    /// `text` (the buffer, or the disk file when `None`).
    fn block_history(
        &self,
        path: &Path,
        text: Option<&str>,
        lines: (u32, u32),
        encoding: TextEncoding,
        cancel: &CancellationToken,
    ) -> IdeResult<BlockHistory>;

    /// The change log, newest first.
    fn log(&self, query: &LogQuery, cancel: &CancellationToken) -> IdeResult<Vec<Commit>>;

    /// Files `commit` changed.
    fn commit_files(&self, commit: &str) -> IdeResult<Vec<ChangedFile>>;

    /// The per-file changes a set of commits made, for a combined diff.
    fn commits_changes(&self, commits: &[String]) -> IdeResult<Vec<RevisionChange>>;

    /// Changes between two revisions.
    fn diff_revisions(&self, from: &str, to: &str) -> IdeResult<Vec<ChangedFile>>;

    /// Files differing between `rev` and the worktree.
    fn diff_with_worktree(&self, rev: &str) -> IdeResult<Vec<ChangedFile>>;

    /// Per-file line counts of `diff_with_worktree`.
    fn numstat_with_worktree(&self, rev: &str) -> IdeResult<Vec<(String, u32, u32)>>;

    // ---- working-area writes ----

    /// Marks `paths` for commit: `git add`, `p4 edit`/`p4 add`. For a file a
    /// backend stores read-only until opened, this is checkout-on-edit too.
    fn stage(&self, paths: &[PathBuf]) -> IdeResult<()>;

    /// Reverses [`stage`](Self::stage) without touching the worktree
    /// (`git restore --staged`, `p4 revert -k` equivalent).
    fn unstage(&self, paths: &[PathBuf]) -> IdeResult<()>;

    /// Discards working-area changes: tracked paths return to the base,
    /// untracked ones are deleted (`git restore`/`clean`, `p4 revert`).
    fn discard(&self, paths: &[PathBuf]) -> IdeResult<()>;

    /// Records the staged/opened changes as a new change (`git commit`,
    /// `p4 submit`); returns its id. `encoding` resolves each file's text
    /// encoding (the caller knows the open documents' settings).
    fn commit(
        &self,
        message: &str,
        options: &CommitOptions,
        encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
    ) -> IdeResult<String>;

    /// What [`commit`](Self::commit) would record, without committing.
    fn pending_changes(
        &self,
        options: &CommitOptions,
        max_bytes: usize,
        encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
    ) -> IdeResult<Vec<PendingChange>>;

    // ---- IDE file operations ----

    /// Files or folders the IDE created (project tree New File, refactorings).
    /// A checkout backend opens them for add (`p4 add`); Git tracks new files
    /// by content, so this is a no-op. Called after the files exist on disk;
    /// a failure leaves them as ordinary untracked files.
    fn files_added(&self, _paths: &[PathBuf]) -> IdeResult<()> {
        Ok(())
    }

    /// Files or folders the IDE deleted (project tree Delete, refactorings).
    /// A checkout backend opens them for delete (`p4 delete`); Git records the
    /// deletion at commit time, so this is a no-op. Called after they are gone
    /// from disk.
    fn files_deleted(&self, _paths: &[PathBuf]) -> IdeResult<()> {
        Ok(())
    }

    /// A file or folder the IDE moved or renamed (project tree Rename/Move,
    /// refactorings). A checkout backend records the rename (`p4 move`) so
    /// history follows the file; Git detects renames from content, so this is
    /// a no-op. Called after `from` is at `to` on disk.
    fn file_moved(&self, _from: &Path, _to: &Path) -> IdeResult<()> {
        Ok(())
    }

    /// The concrete Git repository, when this backend is one — for the
    /// Git-only surface (branches, remotes, stash, rebase…). `None` for other
    /// backends; callers should degrade to hiding Git-only UI.
    fn as_git(&self) -> Option<&Repo> {
        None
    }
}

impl Backend for Repo {
    fn root(&self) -> &Path {
        Repo::root(self)
    }

    fn status(&self) -> IdeResult<Vec<FileStatus>> {
        Repo::status(self)
    }

    fn file_at(&self, path: &Path, rev: Option<&str>, encoding: TextEncoding) -> IdeResult<Option<String>> {
        Repo::file_at(self, path, rev, encoding)
    }

    fn file_mode_at(&self, path: &Path, rev: Option<&str>) -> IdeResult<Option<String>> {
        Repo::file_mode_at(self, path, rev)
    }

    fn diff_text(&self, path: &Path, staged: bool, encoding: TextEncoding) -> IdeResult<String> {
        Repo::diff_text(self, path, staged, encoding)
    }

    fn working_tree_patch(
        &self,
        path: Option<&Path>,
        against: Option<&str>,
        max_bytes: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<String> {
        Repo::working_tree_patch(self, path, against, max_bytes, cancel)
    }

    fn line_hunks(
        &self,
        path: &Path,
        current_text: &str,
        against_index: bool,
        encoding: TextEncoding,
    ) -> IdeResult<Vec<LineHunk>> {
        Repo::line_hunks(self, path, current_text, against_index, encoding)
    }

    fn blame(
        &self,
        path: &Path,
        text: Option<&str>,
        revision: Option<&str>,
        encoding: TextEncoding,
    ) -> IdeResult<Vec<BlameLine>> {
        Repo::blame(self, path, text, revision, encoding)
    }

    fn block_history(
        &self,
        path: &Path,
        text: Option<&str>,
        lines: (u32, u32),
        encoding: TextEncoding,
        cancel: &CancellationToken,
    ) -> IdeResult<BlockHistory> {
        Repo::block_history(self, path, text, lines, encoding, cancel)
    }

    fn log(&self, query: &LogQuery, cancel: &CancellationToken) -> IdeResult<Vec<Commit>> {
        Repo::log_cancellable(self, query, cancel)
    }

    fn commit_files(&self, commit: &str) -> IdeResult<Vec<ChangedFile>> {
        Repo::commit_files(self, commit)
    }

    fn commits_changes(&self, commits: &[String]) -> IdeResult<Vec<RevisionChange>> {
        Repo::commits_changes(self, commits)
    }

    fn diff_revisions(&self, from: &str, to: &str) -> IdeResult<Vec<ChangedFile>> {
        Repo::diff_revisions(self, from, to)
    }

    fn diff_with_worktree(&self, rev: &str) -> IdeResult<Vec<ChangedFile>> {
        Repo::diff_with_worktree(self, rev)
    }

    fn numstat_with_worktree(&self, rev: &str) -> IdeResult<Vec<(String, u32, u32)>> {
        Repo::numstat_with_worktree(self, rev)
    }

    fn stage(&self, paths: &[PathBuf]) -> IdeResult<()> {
        Repo::stage(self, paths)
    }

    fn unstage(&self, paths: &[PathBuf]) -> IdeResult<()> {
        Repo::unstage(self, paths)
    }

    fn discard(&self, paths: &[PathBuf]) -> IdeResult<()> {
        Repo::discard(self, paths)
    }

    fn commit(
        &self,
        message: &str,
        options: &CommitOptions,
        encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
    ) -> IdeResult<String> {
        Repo::commit_with(self, message, options, encoding)
    }

    fn pending_changes(
        &self,
        options: &CommitOptions,
        max_bytes: usize,
        encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
    ) -> IdeResult<Vec<PendingChange>> {
        Repo::pending_changes(self, options, max_bytes, encoding)
    }

    fn as_git(&self) -> Option<&Repo> {
        Some(self)
    }
}
