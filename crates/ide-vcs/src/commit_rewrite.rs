//! Editing a commit and replaying its descendants.

use crate::cli::{TempIndex, failure, run, run_env, run_raw};
use crate::repo::{absolute, gx, resolve};
use crate::{AmendTarget, CommitOptions, HeadChange, HistoryTip, Repo, RewrittenCommit, TextEncoding};
use gix::bstr::ByteSlice;
use ide_core::error::ErrorData;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone)]
struct History {
    head: gix::ObjectId,
    branch: Option<String>,
    commits: Vec<String>,
}

impl History {
    fn load(repo: &Repo, target: &str, expected_head: Option<&HistoryTip>) -> IdeResult<Self> {
        if repo.branch_info()?.operation.is_some() {
            return Err(IdeError::invalid("cannot rewrite history while a Git operation is in progress"));
        }
        let objects = repo.gix()?;
        let head = objects.head().map_err(gx)?;
        let branch = head.referent_name().map(|name| name.as_bstr().to_string());
        let head = head.id().ok_or_else(|| IdeError::invalid("there is no commit to edit"))?.detach();
        if expected_head.is_some_and(|expected| {
            let current_branch = branch.as_deref().and_then(|name| name.strip_prefix("refs/heads/"));
            gix::ObjectId::from_hex(expected.commit.as_bytes()).ok() != Some(head)
                || expected.branch.as_deref() != current_branch
        }) {
            return Err(IdeError::invalid("the branch has changed since the selection was made"));
        }
        let commit = objects.find_object(resolve(&objects, target)?).map_err(gx)?.peel_to_commit().map_err(gx)?;
        if commit.parent_ids().count() > 1 {
            return Err(IdeError::invalid("cannot rewrite a merge commit"));
        }
        let target = commit.id.to_string();
        if run_raw(repo.root(), &["merge-base", "--is-ancestor", &target, &head.to_string()], None)?.code != Some(0) {
            return Err(IdeError::invalid("the commit is not in the current branch"));
        }
        let range = format!("{target}..{head}");
        let listed = run(repo.root(), &["rev-list", "--reverse", "--topo-order", "--parents", &range], None)?;
        let mut commits = vec![target];
        for line in listed.stdout_str().lines() {
            let ids: Vec<&str> = line.split_whitespace().collect();
            if ids.len() != 2 || ids[1] != commits.last().unwrap() {
                return Err(IdeError::invalid("the commits after this one are not a linear history"));
            }
            commits.push(ids[0].to_string());
        }
        Ok(Self { head, branch, commits })
    }

    fn ensure_current(&self, repo: &Repo) -> IdeResult<()> {
        let objects = repo.gix()?;
        let head = objects.head().map_err(gx)?;
        if head.referent_name().map(|name| name.as_bstr().to_str_lossy()).as_deref() != self.branch.as_deref()
            || head.id().is_none_or(|id| id.detach() != self.head)
            || repo.branch_info()?.operation.is_some()
        {
            return Err(IdeError::invalid("the branch has changed since the selection was made"));
        }
        Ok(())
    }

    fn rewrite_descendants(self, repo: &Repo, mut parent: String, reason: &str) -> IdeResult<HeadChange> {
        for id in &self.commits[1..] {
            let commit = Commit::read(repo, id)?;
            parent = commit.write(repo, &commit.tree, Some(&parent), None)?;
        }
        self.ensure_current(repo)?;
        let before = self.head.to_string();
        self.move_tip(repo, &before, &parent, reason)?;
        Ok(HeadChange { before, after: parent })
    }

    fn move_tip(&self, repo: &Repo, from: &str, to: &str, reason: &str) -> IdeResult<()> {
        run(
            repo.root(),
            &["update-ref", "--no-deref", "-m", reason, self.branch.as_deref().unwrap_or("HEAD"), to, from],
            None,
        )?;
        Ok(())
    }

    fn publish_amend(
        &self,
        repo: &Repo,
        index: Option<&[u8]>,
        paths: &[u8],
        commit: &str,
        reason: &str,
    ) -> IdeResult<()> {
        let index_path = repo.gix()?.index_path();
        let updated = index_after_amend(repo, index, paths, commit)?;
        let mut lock =
            gix::lock::File::acquire_to_update_resource(&index_path, gix::lock::acquire::Fail::Immediately, None, 0)
                .map_err(gx)?;
        if read_index(&index_path)?.as_deref() != index {
            return Err(IdeError::invalid("the index changed while the commit was being amended"));
        }
        if let Some(updated) = &updated {
            lock.with_mut(|out| {
                out.write_all(updated)?;
                if let Ok(metadata) = fs::metadata(&index_path) {
                    out.set_permissions(metadata.permissions())?;
                }
                out.sync_all()
            })?;
        }
        self.ensure_current(repo)?;
        let before = self.head.to_string();
        self.move_tip(repo, &before, commit, reason)?;
        if updated.is_some()
            && let Err(error) = lock.commit()
        {
            self.move_tip(repo, commit, &before, "restore tip after amend index write failed")?;
            return Err(gx(error));
        }
        Ok(())
    }
}

struct Commit {
    tree: String,
    parent: Option<String>,
    author: String,
    encoding: Option<String>,
    data: Vec<u8>,
    message_start: usize,
}

impl Commit {
    fn read(repo: &Repo, id: &str) -> IdeResult<Self> {
        let data = run(repo.root(), &["cat-file", "commit", id], None)?.stdout;
        let header_end = data.find(b"\n\n").ok_or_else(|| IdeError::invalid("invalid commit data"))?;
        let headers = data[..header_end].to_str_lossy();
        let header = |prefix| headers.lines().find_map(|line| line.strip_prefix(prefix)).map(str::to_owned);
        let tree = header("tree ").ok_or_else(|| IdeError::invalid("commit has no tree"))?;
        let author = header("author ").ok_or_else(|| IdeError::invalid("commit has no author"))?;
        Ok(Self {
            tree,
            parent: header("parent "),
            author,
            encoding: header("encoding "),
            data,
            message_start: header_end + 2,
        })
    }

    fn write(&self, repo: &Repo, tree: &str, parent: Option<&str>, new_message: Option<&str>) -> IdeResult<String> {
        let (message, encoding) =
            new_message.map_or_else(|| (self.message(), self.encoding()), |message| (message.as_bytes(), "UTF-8"));
        Self::write_commit(repo, tree, parent, message, encoding, self.identity())
    }

    fn identity(&self) -> (&str, &str, &str) {
        let (name, rest) = self.author.split_once(" <").unwrap_or((&self.author, ""));
        let (email, date) = rest.split_once("> ").unwrap_or((rest, ""));
        (name, email, date)
    }

    fn write_commit(
        repo: &Repo,
        tree: &str,
        parent: Option<&str>,
        message: &[u8],
        encoding: &str,
        author: (&str, &str, &str),
    ) -> IdeResult<String> {
        let (name, email, date) = author;
        let env = [
            ("GIT_AUTHOR_NAME", OsStr::new(name)),
            ("GIT_AUTHOR_EMAIL", OsStr::new(email)),
            ("GIT_AUTHOR_DATE", OsStr::new(date)),
        ];
        let encoding = format!("i18n.commitEncoding={encoding}");
        let mut args = vec!["-c", &encoding, "commit-tree", tree];
        if let Some(parent) = parent {
            args.extend(["-p", parent]);
        }
        Ok(run_env(repo.root(), &args, Some(message), &env)?.stdout_str().trim().to_string())
    }

    fn message(&self) -> &[u8] {
        &self.data[self.message_start..]
    }

    fn encoding(&self) -> &str {
        self.encoding.as_deref().unwrap_or("UTF-8")
    }
}

fn new_message(message: &str) -> IdeResult<String> {
    let message = message.trim();
    if message.is_empty() {
        return Err(IdeError::invalid("commit message is empty"));
    }
    Ok(format!("{message}\n"))
}

pub(crate) fn reword(repo: &Repo, id: &str, message: &str) -> IdeResult<HeadChange> {
    let message = new_message(message)?;
    let history = History::load(repo, id, None)?;
    let commit = Commit::read(repo, &history.commits[0])?;
    let rewritten = commit.write(repo, &commit.tree, commit.parent.as_deref(), Some(&message))?;
    let reason = format!("reword: {}", message.lines().next().unwrap_or_default());
    history.rewrite_descendants(repo, rewritten, &reason)
}

/// Builds the selected commit in a detached Git directory, using the real
/// repository's config, hooks and objects. Only a successful replay changes HEAD.
pub(crate) fn amend(
    repo: &Repo,
    target: &AmendTarget,
    message: &str,
    commit_args: &[&str],
    options: &CommitOptions,
    encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
) -> IdeResult<String> {
    let history = History::load(repo, &target.commit, Some(&target.head))?;
    if history.commits.len() < 2 {
        return Err(IdeError::invalid("the commit to amend must be older than HEAD"));
    }
    let original = &history.commits[0];
    ensure_unpublished(repo, original, &target.protected_branches)?;
    let commit = Commit::read(repo, original)?;
    let before = history.head.to_string();
    let head = Commit::read(repo, &before)?;
    let git = repo.gix()?;
    let index_path = git.index_path();
    let index = read_index(&index_path)?;
    let scratch = tempfile::tempdir_in(&repo.git_dir)?;
    let chosen = TempIndex::new(repo);
    if let Some(index) = &index {
        fs::write(chosen.path(), index)?;
        // Split indexes refer to objects in the original per-worktree Git directory.
        run_env(repo.root(), &["update-index", "--no-split-index"], None, &chosen.env())?;
    }
    fs::write(scratch.path().join("HEAD"), format!("{before}\n"))?;
    let worktree_config = repo.git_dir.join("config.worktree");
    if worktree_config.is_file() {
        fs::copy(worktree_config, scratch.path().join("config.worktree"))?;
    }
    let common_dir = absolute(git.common_dir())?;
    let env = [
        ("GIT_DIR", scratch.path().as_os_str()),
        ("GIT_COMMON_DIR", common_dir.as_os_str()),
        ("GIT_WORK_TREE", repo.root().as_os_str()),
        ("GIT_INDEX_FILE", chosen.path().as_os_str()),
    ];
    crate::write::fill_commit_index(repo, &env, options, encoding)?;
    let message = if message.trim().is_empty() { commit.message() } else { message.as_bytes() };
    run_env(repo.root(), commit_args, Some(message), &env)?;
    let selected = fs::read_to_string(scratch.path().join("HEAD"))?;
    let selected = selected.trim();
    let addition = Commit::read(repo, selected)?;

    let (original_name, original_email, original_date) = commit.identity();
    let (new_name, new_email, new_date) = addition.identity();
    let (name, email) = if options.author.as_deref().is_some_and(|a| !a.trim().is_empty()) {
        (new_name, new_email)
    } else {
        (original_name, original_email)
    };
    let date = if options.author_date.as_deref().is_some_and(|date| !date.trim().is_empty()) {
        new_date
    } else {
        original_date
    };
    let author = (name, email, date);
    let paths = changed_paths(repo, &before, selected)?;
    let Some(rewritten) =
        replay_amend(repo, &history, &commit, &addition, author, selected, head.tree != addition.tree)?
    else {
        history.ensure_current(repo)?;
        let mut message = format!("amend! {original}\n\n").into_bytes();
        message.extend_from_slice(addition.message());
        let commit = Commit::write_commit(repo, &addition.tree, Some(&before), &message, addition.encoding(), author)?;
        let entries = affected_index_entries(repo, &before, index.as_deref(), &paths)?;
        *repo.amend_recovery.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(PendingAmend { commit: commit.clone(), history, paths, entries });
        let mut error = IdeError::invalid("Amending this commit would cause a conflict.");
        error.data = Some(ErrorData::AmendConflict { commit });
        return Err(error);
    };
    ensure_unpublished(repo, original, &target.protected_branches)?;
    history.publish_amend(repo, index.as_deref(), &paths, &rewritten, "amend earlier commit")?;
    Ok(rewritten)
}

fn replay_amend(
    repo: &Repo,
    history: &History,
    commit: &Commit,
    addition: &Commit,
    author: (&str, &str, &str),
    selected: &str,
    changed: bool,
) -> IdeResult<Option<String>> {
    let tree = if changed {
        let Some(tree) = merge_onto(repo, &history.head.to_string(), &history.commits[0], selected)? else {
            return Ok(None);
        };
        tree
    } else {
        commit.tree.clone()
    };
    let mut rewritten =
        Commit::write_commit(repo, &tree, commit.parent.as_deref(), addition.message(), addition.encoding(), author)?;
    let mut final_tree = tree;
    for pair in history.commits.windows(2) {
        let next = Commit::read(repo, &pair[1])?;
        final_tree = if changed && next.tree != final_tree {
            let Some(tree) = merge_onto(repo, &pair[0], &rewritten, &pair[1])? else { return Ok(None) };
            tree
        } else {
            next.tree.clone()
        };
        rewritten = next.write(repo, &final_tree, Some(&rewritten), None)?;
    }
    // The replay must consume exactly the selected changes. The worktree can then
    // stay as it is, including local edits and untracked files on the same paths.
    Ok((final_tree == addition.tree).then_some(rewritten))
}

#[derive(Clone)]
pub(crate) struct PendingAmend {
    commit: String,
    history: History,
    paths: Vec<u8>,
    entries: blake3::Hash,
}

pub(crate) fn keep_amend(repo: &Repo, commit: &str) -> IdeResult<String> {
    let pending = repo.amend_recovery.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let pending = pending
        .filter(|pending| pending.commit == commit)
        .ok_or_else(|| IdeError::invalid("The prepared amend commit is no longer available."))?;
    pending.history.ensure_current(repo)?;
    let index = read_index(&repo.gix()?.index_path())?;
    if affected_index_entries(repo, &pending.history.head.to_string(), index.as_deref(), &pending.paths)?
        != pending.entries
    {
        return Err(IdeError::invalid("Staged changes for the prepared amend commit have changed."));
    }
    pending.history.publish_amend(repo, index.as_deref(), &pending.paths, commit, "keep prepared amend commit")?;
    let mut recovery = repo.amend_recovery.lock().unwrap_or_else(|e| e.into_inner());
    if recovery.as_ref().is_some_and(|pending| pending.commit == commit) {
        *recovery = None;
    }
    Ok(pending.commit)
}

fn read_index(path: &Path) -> IdeResult<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn ensure_unpublished(repo: &Repo, commit: &str, protected: &[String]) -> IdeResult<()> {
    if protected.is_empty() {
        return Ok(());
    }
    let refs =
        run(repo.root(), &["for-each-ref", "--contains", commit, "--format=%(refname:strip=2)", "refs/remotes"], None)?
            .stdout_str();
    if let Some(branch) = refs.lines().find(|branch| protected.iter().any(|name| name == branch)) {
        return Err(IdeError::invalid(format!("The commit has already been pushed to protected branch '{branch}'.")));
    }
    Ok(())
}

fn merge_onto(repo: &Repo, base: &str, ours: &str, theirs: &str) -> IdeResult<Option<String>> {
    let base = format!("--merge-base={base}");
    let args = ["merge-tree", "--write-tree", "--no-messages", &base, ours, theirs];
    let output = run_raw(repo.root(), &args, None)?;
    match output.code {
        Some(0) => Ok(Some(output.stdout_str().trim().to_string())),
        Some(1) => Ok(None),
        _ => Err(failure(&args, &output.stderr, &output.stdout, output.code)),
    }
}

fn changed_paths(repo: &Repo, before: &str, selected: &str) -> IdeResult<Vec<u8>> {
    Ok(run(
        repo.root(),
        &["diff-tree", "-r", "--no-commit-id", "--no-renames", "--name-only", "-z", before, selected],
        None,
    )?
    .stdout)
}

fn path_parents(path: &[u8]) -> impl Iterator<Item = &[u8]> {
    path.iter().enumerate().filter_map(|(i, byte)| (*byte == b'/').then_some(&path[..i]))
}

/// Ignore index stat refreshes and unrelated staged edits. Ancestors and descendants
/// matter too, since Git can replace a file with a directory at an affected path.
fn affected_index_entries(repo: &Repo, head: &str, index: Option<&[u8]>, paths: &[u8]) -> IdeResult<blake3::Hash> {
    let mut hash = blake3::Hasher::new();
    if let Some(index) = index {
        let temp = TempIndex::new(repo);
        fs::write(temp.path(), index)?;
        let output = run_env(repo.root(), &["ls-files", "-v", "--stage", "-z"], None, &temp.env())?;
        let paths: HashSet<_> = paths.split(|&byte| byte == 0).filter(|path| !path.is_empty()).collect();
        let parents: HashSet<_> = paths.iter().flat_map(|path| path_parents(path)).collect();
        let related = |path: &[u8]| {
            paths.contains(path) || parents.contains(path) || path_parents(path).any(|p| paths.contains(p))
        };
        for entry in output.stdout.split(|&byte| byte == 0) {
            let Some(tab) = entry.find_byte(b'\t') else { continue };
            if related(&entry[tab + 1..]) {
                hash.update(entry);
                hash.update(b"\0");
            }
        }
        // ls-files gives both intent-to-add and a staged empty file the empty blob ID.
        let additions = run_env(
            repo.root(),
            &[
                "diff-index",
                "--cached",
                "--ita-invisible-in-index",
                "--diff-filter=A",
                "--name-only",
                "-z",
                "--no-renames",
                head,
                "--",
            ],
            None,
            &temp.env(),
        )?;
        hash.update(b"\0");
        for path in additions.stdout.split(|&byte| byte == 0).filter(|path| related(path)) {
            hash.update(path);
            hash.update(b"\0");
        }
    }
    Ok(hash.finalize())
}

fn index_after_amend(repo: &Repo, original: Option<&[u8]>, paths: &[u8], selected: &str) -> IdeResult<Option<Vec<u8>>> {
    if paths.is_empty() {
        return Ok(None);
    }
    let next = TempIndex::new(repo);
    if let Some(original) = original {
        fs::write(next.path(), original)?;
    } else {
        run_env(repo.root(), &["read-tree", "--empty"], None, &next.env())?;
    }
    run_env(
        repo.root(),
        &["--literal-pathspecs", "reset", "-q", selected, "--pathspec-from-file=-", "--pathspec-file-nul"],
        Some(paths),
        &next.env(),
    )?;
    Ok(Some(fs::read(next.path())?))
}

pub(crate) fn extract(
    repo: &Repo,
    id: &str,
    expected_head: &HistoryTip,
    paths: &[PathBuf],
    message: &str,
) -> IdeResult<RewrittenCommit> {
    let message = new_message(message)?;
    let history = History::load(repo, id, Some(expected_head))?;
    let target = &history.commits[0];
    let commit = Commit::read(repo, target)?;
    let remaining = remaining_tree(repo, target, &commit, paths)?;
    let rewritten = commit.write(repo, &remaining, commit.parent.as_deref(), None)?;
    let extracted = commit.write(repo, &commit.tree, Some(&rewritten), Some(&message))?;
    let head = history.rewrite_descendants(repo, extracted.clone(), "extract selected changes")?;
    Ok(RewrittenCommit { head, commit: extracted })
}

pub(crate) fn drop_changes(
    repo: &Repo,
    id: &str,
    expected_head: &HistoryTip,
    paths: &[PathBuf],
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<RewrittenCommit> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let history = History::load(repo, id, Some(expected_head))?;
    let target = &history.commits[0];
    let commit = Commit::read(repo, target)?;
    let remaining = remaining_tree(repo, target, &commit, paths)?;
    let replacement = commit.write(repo, &remaining, commit.parent.as_deref(), None)?;
    let mut todo = format!("drop {target}\npick {replacement}\n");
    for descendant in &history.commits[1..] {
        todo.push_str(&format!("pick {descendant}\n"));
    }
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    history.ensure_current(repo)?;
    let work = tempfile::tempdir_in(&repo.git_dir)?;
    let args = [
        "-c",
        "rebase.missingCommitsCheck=error",
        "rebase",
        "--interactive",
        "--no-autosquash",
        "--empty=keep",
        commit.parent.as_deref().unwrap_or("--root"),
    ];
    crate::ops::run_rebase_todo(repo, work.path(), &todo, &args, cancel, out)?;
    let after = run(repo.root(), &["rev-parse", "--verify", "HEAD"], None)?.stdout_str().trim().to_string();
    let rewritten = format!("{after}~{}", history.commits.len() - 1);
    let commit = run(repo.root(), &["rev-parse", "--verify", &rewritten], None)?.stdout_str().trim().to_string();
    Ok(RewrittenCommit { head: HeadChange { before: history.head.to_string(), after }, commit })
}

fn remaining_tree(repo: &Repo, id: &str, commit: &Commit, paths: &[PathBuf]) -> IdeResult<String> {
    let paths = paths.iter().map(|path| repo.given_rel_path(path)).collect::<IdeResult<HashSet<_>>>()?;
    if paths.is_empty() || paths.contains("") {
        return Err(IdeError::invalid("select files from the commit"));
    }
    let source_tree = if let Some(parent) = &commit.parent {
        run(repo.root(), &["rev-parse", &format!("{parent}^{{tree}}")], None)?
    } else {
        run(repo.root(), &["hash-object", "-t", "tree", "-w", "--stdin"], Some(b""))?
    }
    .stdout_str();
    let source = format!("--source={}", source_tree.trim());
    let index = TempIndex::new(repo);
    let env = index.env();
    let config = ["-c", "core.sparseCheckout=false", "-c", "index.sparse=false"];
    run_env(repo.root(), &[&config[..], &["read-tree", id]].concat(), None, &env)?;
    let mut pathspec = Vec::new();
    for path in &paths {
        pathspec.extend_from_slice(path.as_bytes());
        pathspec.push(0);
    }
    let restore =
        ["--literal-pathspecs", "restore", "--staged", &source, "--pathspec-from-file=-", "--pathspec-file-nul"];
    run_env(repo.root(), &[&config[..], &restore].concat(), Some(&pathspec), &env)?;
    let changed = run_env(
        repo.root(),
        &[&config[..], &["diff", "--cached", "--name-only", "--no-renames", "-z", id, "--"]].concat(),
        None,
        &env,
    )?;
    let restored: HashSet<&[u8]> = changed.stdout.split(|&b| b == 0).filter(|path| !path.is_empty()).collect();
    // A file/directory replacement can make a pathspec touch unselected paths.
    if restored.len() != paths.len() || paths.iter().any(|path| !restored.contains(path.as_bytes())) {
        return Err(IdeError::invalid("the selected paths cannot be split from the other changes in this commit"));
    }
    let tree = run_env(repo.root(), &[&config[..], &["write-tree"]].concat(), None, &env)?.stdout_str();
    if tree.trim() == source_tree.trim() {
        return Err(IdeError::invalid("select fewer than all changes in the commit"));
    }
    Ok(tree.trim().to_string())
}
