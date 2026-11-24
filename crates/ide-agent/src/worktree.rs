//! Task worktrees and the changes made in them.

use crate::model::{AgentChange, AgentChanges, AgentCommit};
use ide_core::{IdeError, IdeResult, IpcPath};
use ide_vcs::{ChangeKind, LogQuery, Repo};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

pub(crate) struct Created {
    pub path: PathBuf,
    pub branch: String,
    pub base: String,
    pub base_commit: String,
}

/// The repository of `path`, free to execute: the host runs every agent command that
/// reaches a repository only in a trusted project.
fn discover(path: &Path) -> IdeResult<Option<Repo>> {
    let repo = Repo::discover(path)?;
    if let Some(repo) = &repo {
        repo.set_execution_allowed(true);
    }
    Ok(repo)
}

/// The repositories of a project with nested ones (an own `.git` under the project root, not a
/// submodule), with the folder their files are named from: the root of the repository holding
/// `cwd`, else `cwd`. `None` when only the repository holding `cwd` (if any) is there.
fn nested_repos(cwd: &Path) -> IdeResult<Option<(PathBuf, Vec<Repo>)>> {
    let Ok(cwd) = dunce::canonicalize(cwd) else { return Ok(None) };
    let found = ide_vcs::Repos::discover(&cwd, &|_| false)?;
    if found.all().iter().all(|r| cwd.starts_with(r.root())) {
        return Ok(None);
    }
    let base = found.all().iter().map(|r| r.root()).filter(|r| cwd.starts_with(r)).max().unwrap_or(&cwd).to_path_buf();
    let mut repos = Vec::new();
    for r in found.all() {
        repos.extend(discover(r.root())?);
    }
    Ok(Some((base, repos)))
}

/// Whether the project at `cwd` holds repositories nested in it: its changes are each one's.
pub(crate) fn spans_repos(cwd: &Path) -> bool {
    nested_repos(cwd).is_ok_and(|r| r.is_some())
}

/// The repositories a turn's files are in, and the folder those files are named from.
struct TurnRepos {
    base: PathBuf,
    repos: Vec<Repo>,
    /// The project holds nested repositories: each one's `HEAD` is recorded on its own.
    nested: bool,
}

impl TurnRepos {
    fn of(cwd: &Path) -> IdeResult<Option<Self>> {
        if let Some((base, repos)) = nested_repos(cwd)? {
            return Ok(Some(Self { base, repos, nested: true }));
        }
        Ok(discover(cwd)?.map(|repo| Self { base: repo.root().to_path_buf(), repos: vec![repo], nested: false }))
    }

    /// The innermost repository holding `path`.
    fn owner(&self, path: &Path) -> Option<&Repo> {
        owning_repo(&self.repos, path)
    }

    /// `repo`'s `HEAD` as the turn `start` began.
    fn head_then<'a>(&self, start: &'a TurnStart, repo: &Repo) -> Option<&'a str> {
        if self.nested { start.heads.get(&root_key(repo.root())) } else { start.head.as_ref() }.map(String::as_str)
    }
}

fn root_key(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

fn owning_repo<'a>(repos: &'a [Repo], path: &Path) -> Option<&'a Repo> {
    repos.iter().filter(|r| path.starts_with(r.root())).max_by_key(|r| r.root().as_os_str().len())
}

/// `path` as a task in `base` names it, if it is not in a repository nested below `repo` (that
/// one lists it itself; to `repo` its folder is untracked).
fn nested_rel(base: &Path, repo: &Repo, roots: &[PathBuf], path: &Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    if path.is_dir()
        || roots.iter().any(|n| n.as_path() != repo.root() && n.starts_with(repo.root()) && path.starts_with(n))
    {
        return None;
    }
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// The uncommitted changes in every repository of the project, against each one's `HEAD`.
fn nested_changes(base: &Path, repos: &[Repo], touched: Option<&BTreeSet<String>>) -> IdeResult<Vec<AgentChange>> {
    let roots: Vec<PathBuf> = repos.iter().map(|r| r.root().to_path_buf()).collect();
    // Match deletions too: find the owner by path components, not by opening the file.
    // Display paths use slash separators and lossy Unicode (see nested_rel). If a checkout's
    // name cannot round-trip from that representation, keep the full-read fallback.
    let owners = touched
        .filter(|_| {
            roots.iter().all(|root| {
                root.strip_prefix(base).is_ok_and(|rel| base.join(rel.to_string_lossy().replace('\\', "/")) == *root)
            })
        })
        .map(|paths| {
            paths.iter().filter_map(|rel| owning_repo(repos, &base.join(rel)).map(Repo::root)).collect::<BTreeSet<_>>()
        });
    let mut out: Vec<AgentChange> = Vec::new();
    for repo in repos {
        if owners.as_ref().is_some_and(|owners| !owners.contains(repo.root())) {
            continue;
        }
        let listed = match repo.head()?.1 {
            Some(head) => changes(repo.root(), &head)?,
            None => {
                repo.status()?.into_iter().filter(|s| s.path.is_file()).map(|s| added(s.path, s.rel_path)).collect()
            }
        };
        for mut c in listed {
            let Some(rel) = nested_rel(base, repo, &roots, &c.path.0) else { continue };
            if out.iter().any(|o| o.path == c.path) {
                continue;
            }
            c.rel_path = rel;
            c.old_path = None;
            c.repo = Some(IpcPath(repo.root().to_path_buf()));
            out.push(c);
        }
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

fn repo_at(path: &Path) -> IdeResult<Repo> {
    discover(path)?.ok_or_else(|| IdeError::unavailable(format!("{} is not in a git repository", path.display())))
}

/// The current branch (or commit when detached) and its commit.
pub(crate) fn head_of(path: &Path) -> IdeResult<(String, String)> {
    let info = repo_at(path)?.branch_info()?;
    let commit = info.head_commit.ok_or_else(|| IdeError::unavailable("the repository has no commits yet"))?;
    Ok((info.head.unwrap_or_else(|| commit.clone()), commit))
}

/// `HEAD`'s commit in `cwd`, `None` outside a repository or before its first commit.
pub(crate) fn head_commit(cwd: &Path) -> IdeResult<Option<String>> {
    if spans_repos(cwd) {
        return Ok(Some("HEAD".to_owned()));
    }
    match discover(cwd)? {
        Some(repo) => Ok(repo.head()?.1),
        None => Ok(None),
    }
}

/// `git worktree add -b agent/<slug> <dir>/<slug> <base>`.
pub(crate) fn create(project_root: &Path, worktrees_dir: &Path, title: &str, base: Option<&str>) -> IdeResult<Created> {
    let repo = repo_at(project_root)?;
    let (base, base_commit) = match base.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => {
            let commit =
                repo.merge_base(b, b)?.ok_or_else(|| IdeError::not_found(format!("no branch or revision {b}")))?;
            (b.to_owned(), commit)
        }
        None => head_of(project_root)?,
    };
    std::fs::create_dir_all(worktrees_dir).map_err(|e| IdeError::internal(e.to_string()))?;
    let branch_exists = |s: &str| {
        let r = format!("refs/heads/agent/{s}");
        repo.merge_base(&r, &r).ok().flatten().is_some()
    };
    let slug = unique_slug(&slugify(title), |s| worktrees_dir.join(s).exists() || branch_exists(s));
    let path = worktrees_dir.join(&slug);
    let branch = format!("agent/{slug}");
    repo.add_worktree(&path, &base_commit, Some(&branch))?;
    Ok(Created { path, branch, base, base_commit })
}

/// `git worktree remove --force -- <path>`. When git no longer recognizes the
/// worktree (a pruned registration, a moved repository, a deleted `.git` file)
/// it fails with "is not a working tree". A folder under `worktrees_dir` is still
/// ours, so it is removed directly to keep the task deletable (a stale
/// registration prunes later); anything else keeps git's error.
pub(crate) fn remove(project_root: &Path, worktrees_dir: &Path, path: &Path) -> IdeResult<()> {
    let repo = repo_at(project_root)?;
    let err = match repo.remove_worktree(path, true) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    if !path.exists() {
        return Ok(());
    }
    if !path.starts_with(worktrees_dir) || path == worktrees_dir {
        return Err(err);
    }
    retrying(REMOVE_ATTEMPTS, REMOVE_PAUSE, || std::fs::remove_dir_all(path))
        .map_err(|e| IdeError::internal(format!("{}: {e}", path.display())))
}

/// On Windows a folder can't be deleted while a process still has a file in it open
/// (os error 32): an agent's helper that outlived it, an antivirus scan, the search indexer.
/// Those let go within moments, so removing is retried for a few seconds.
const REMOVE_ATTEMPTS: u32 = 10;
const REMOVE_PAUSE: Duration = Duration::from_millis(300);

fn retrying(attempts: u32, pause: Duration, mut op: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    for _ in 1..attempts {
        match op() {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => std::thread::sleep(pause),
            _ => return Ok(()),
        }
    }
    match op() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

/// Files under `cwd` that differ from `base` (untracked files included), with line counts.
/// Outside a repository there is nothing to compare against: no changes.
pub(crate) fn changes(cwd: &Path, base: &str) -> IdeResult<Vec<AgentChange>> {
    let Some(repo) = discover(cwd)? else { return Ok(Vec::new()) };
    let root = repo.root().to_path_buf();
    let stats: std::collections::HashMap<String, (u32, u32)> =
        repo.numstat_with_worktree(base)?.into_iter().map(|(p, a, r)| (p, (a, r))).collect();
    let stat = |rel: &str| stats.get(rel).copied().unwrap_or((0, 0));
    let mut out: Vec<AgentChange> = repo
        .diff_with_worktree(base)?
        .into_iter()
        .map(|f| {
            let (added, removed) = stat(&f.path);
            AgentChange {
                path: IpcPath(root.join(&f.path)),
                rel_path: f.path,
                kind: f.kind,
                added,
                removed,
                old_path: f.old_path,
                repo: None,
            }
        })
        .collect();
    let tracked: std::collections::HashSet<String> = out.iter().map(|c| c.rel_path.clone()).collect();
    for s in repo.status()? {
        if s.unstaged == Some(ChangeKind::Untracked) && !tracked.contains(&s.rel_path) {
            out.push(added(s.path, s.rel_path));
        }
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

/// Files renamed since `rev`, by their new repository-relative path: the old path, as a deletion
/// to roll back along with the rename.
pub(crate) fn rename_sources(cwd: &Path, rev: &str) -> IdeResult<BTreeMap<String, AgentChange>> {
    if spans_repos(cwd) {
        return Ok(BTreeMap::new());
    }
    let Some(repo) = discover(cwd)? else { return Ok(BTreeMap::new()) };
    let root = repo.root().to_path_buf();
    Ok(repo
        .diff_with_worktree(rev)?
        .into_iter()
        .filter_map(|f| {
            let old = f.old_path.filter(|old| *old != f.path)?;
            let source = AgentChange {
                path: IpcPath(root.join(&old)),
                rel_path: old,
                kind: ChangeKind::Deleted,
                added: 0,
                removed: 0,
                old_path: None,
                repo: None,
            };
            Some((f.path, source))
        })
        .collect())
}

fn added(path: IpcPath, rel_path: String) -> AgentChange {
    let added = std::fs::read_to_string(&*path).map_or(0, |t| t.lines().count() as u32);
    AgentChange { path, rel_path, kind: ChangeKind::Added, added, removed: 0, old_path: None, repo: None }
}

/// The commits from `base` (exclusive) to `head` (inclusive) in `cwd`, newest first, each
/// with the files it changed against its first parent and their line counts.
pub(crate) fn commits(cwd: &Path, base: &str, head: &str) -> IdeResult<Vec<AgentCommit>> {
    if base == head {
        return Ok(Vec::new());
    }
    let Some(repo) = discover(cwd)? else { return Ok(Vec::new()) };
    let root = repo.root().to_path_buf();
    let query = LogQuery { range: Some(format!("{base}..{head}")), ..LogQuery::default() };
    let mut out = Vec::new();
    for commit in repo.log(&query)? {
        let parent = commit.parents.first().cloned();
        // A root commit has no parent to count lines against; its files still show.
        let stats: std::collections::HashMap<String, (u32, u32)> = match &parent {
            Some(parent) => repo
                .diff_numstat(parent, &commit.id, &[])?
                .into_iter()
                .map(|s| (s.path, (s.added, s.removed)))
                .collect(),
            None => std::collections::HashMap::new(),
        };
        let mut files: Vec<AgentChange> = repo
            .commit_files(&commit.id)?
            .into_iter()
            .map(|f| {
                let (added, removed) = stats.get(&f.path).copied().unwrap_or((0, 0));
                AgentChange {
                    path: IpcPath(root.join(&f.path)),
                    rel_path: f.path,
                    kind: f.kind,
                    added,
                    removed,
                    old_path: f.old_path,
                    repo: None,
                }
            })
            .collect();
        files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        out.push(AgentCommit {
            id: commit.id,
            short_id: commit.short_id,
            summary: commit.summary,
            message: commit.message,
            time_ms: commit.time_ms,
            parent,
            files,
        });
    }
    Ok(out)
}

/// Whether two paths name one file (a case-insensitive disk resolving both spellings).
fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The bytes of `path` (`Some(None)`: no file there), or `None` when it is there but can't be read.
fn existing(path: &Path) -> Option<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Some(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(None),
        Err(_) => None,
    }
}

fn crlf_to_lf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for (i, &b) in bytes.iter().enumerate() {
        if !(b == b'\r' && bytes.get(i + 1) == Some(&b'\n')) {
            out.push(b);
        }
    }
    out
}

/// Where a task works and what its changes are measured against.
pub(crate) enum TaskBase {
    /// A worktree of its own: everything since the commit it was created from, the agent's
    /// own commits included.
    Worktree { cwd: PathBuf, base: String },
    /// The project's checkout, where the user works and commits too. `start` is the commit it
    /// started from (`None` in a repository without commits, or an imported session).
    Local { cwd: PathBuf, start: Option<String> },
}

impl TaskBase {
    pub(crate) fn cwd(&self) -> &Path {
        match self {
            Self::Worktree { cwd, .. } | Self::Local { cwd, .. } => cwd,
        }
    }

    /// The files the task changed, less those changed before it started and untouched since.
    pub(crate) fn changes(
        &self,
        before: &BTreeMap<String, Stamp>,
        touched: Option<&BTreeSet<String>>,
    ) -> IdeResult<Vec<AgentChange>> {
        if touched.is_some_and(BTreeSet::is_empty) {
            return Ok(Vec::new());
        }
        Ok(made_by_task(self.read_changes(before, touched)?, touched))
    }

    fn read_changes(
        &self,
        before: &BTreeMap<String, Stamp>,
        touched: Option<&BTreeSet<String>>,
    ) -> IdeResult<Vec<AgentChange>> {
        let (cwd, start) = match self {
            Self::Worktree { cwd, base } => return Ok(without_untouched(changes(cwd, base)?, before)),
            Self::Local { cwd, start } => {
                if let Some((base, repos)) = nested_repos(cwd)? {
                    return Ok(without_untouched(nested_changes(&base, &repos, touched)?, before));
                }
                (cwd, start.as_deref())
            }
        };
        let Some(repo) = discover(cwd)? else { return Ok(Vec::new()) };
        // What is uncommitted, as the Commit tool window lists it: commits made since the task
        // started drop out.
        let head = repo.branch_info()?.head_commit;
        let listed = match &head {
            Some(head) => changes(cwd, head)?,
            None => {
                let mut all: Vec<AgentChange> = repo
                    .status()?
                    .into_iter()
                    .filter(|s| s.path.is_file())
                    .map(|s| added(s.path, s.rel_path))
                    .collect();
                all.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
                all
            }
        };
        let listed = without_untouched(listed, before);
        let Some(start) = start.filter(|s| head.as_deref() != Some(*s)) else { return Ok(listed) };
        // HEAD moved (a reset, a checkout, a pull): a file that is as it was when the task
        // started is the user's doing, not the task's. Git compares tracked files, with its
        // line-ending and other filters: the bytes on disk and in the commit differ under
        // `core.autocrlf`.
        let since_start: std::collections::HashSet<String> = repo
            .diff_with_worktree(start)?
            .into_iter()
            .flat_map(|f| [Some(f.path), f.old_path].into_iter().flatten())
            .collect();
        let untracked: std::collections::HashSet<String> = repo
            .status()?
            .into_iter()
            .filter(|s| s.unstaged == Some(ChangeKind::Untracked))
            .map(|s| s.rel_path)
            .collect();
        Ok(listed
            .into_iter()
            .filter(|c| {
                if before.contains_key(&c.rel_path) {
                    return true;
                }
                let Ok(Some(at_start)) = repo.file_bytes_at(&c.path.0, Some(start)) else { return true };
                if !untracked.contains(&c.rel_path) {
                    return since_start.contains(&c.rel_path);
                }
                // Untracked since (a mixed reset): git doesn't diff it, so compare the bytes,
                // CRLF on disk matching LF committed.
                !std::fs::read(&c.path.0).is_ok_and(|now| now == at_start || crlf_to_lf(&now) == at_start)
            })
            .collect())
    }

    /// The task's uncommitted changes and, for a worktree task, the commits made since it
    /// started (newest first). Both read the same `HEAD`, so a commit landing between the two
    /// reads cannot put a file in both lists.
    pub(crate) fn grouped_changes(&self, before: &BTreeMap<String, Stamp>) -> IdeResult<AgentChanges> {
        let cwd = self.cwd();
        if spans_repos(cwd) {
            return Ok(AgentChanges { uncommitted: self.changes(before, None)?, commits: Vec::new() });
        }
        let Some(repo) = discover(cwd)? else { return Ok(AgentChanges::default()) };
        let head = repo.head()?.1;
        let uncommitted = match &head {
            Some(head) => without_untouched(changes(cwd, head)?, before),
            None => {
                // No commits yet: every file is new, as in `changes` for a local task.
                let mut all: Vec<AgentChange> = repo
                    .status()?
                    .into_iter()
                    .filter(|s| s.path.is_file())
                    .map(|s| added(s.path, s.rel_path))
                    .collect();
                all.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
                without_untouched(all, before)
            }
        };
        let commits = match (self, &head) {
            (Self::Worktree { cwd, base }, Some(head)) => commits(cwd, base, head)?,
            _ => Vec::new(),
        };
        Ok(AgentChanges { uncommitted, commits })
    }

    /// The revision the task's changed files go back to on rollback, and are compared with:
    /// the commit the task started from, or the current `HEAD` once the user committed on top
    /// of it, so those commits stay. `None` while the repository has no commits.
    pub(crate) fn rev(&self) -> IdeResult<Option<String>> {
        let (cwd, start) = match self {
            Self::Worktree { base, .. } => return Ok(Some(base.clone())),
            // Each repository goes back to its own `HEAD`.
            Self::Local { cwd, .. } if spans_repos(cwd) => return Ok(Some("HEAD".to_owned())),
            Self::Local { cwd, start } => (cwd, start.as_deref()),
        };
        let Some(repo) = discover(cwd)? else { return Ok(None) };
        let head = repo.branch_info()?.head_commit;
        // A start commit git no longer knows (garbage-collected) can't be gone back to.
        let start = start.filter(|s| repo.merge_base(s, s).ok().flatten().is_some());
        Ok(match (start, head) {
            (Some(start), Some(head)) if start != head && repo.merge_base(start, &head)?.as_deref() != Some(start) => {
                Some(start.to_owned())
            }
            (start, head) => head.or_else(|| start.map(str::to_owned)),
        })
    }
}

/// One side of an Accept (the task's worktree or the checkout): where its files really are, and
/// git's own folders for it.
struct Confined {
    root: PathBuf,
    metadata: Vec<PathBuf>,
}

impl Confined {
    fn new(root: &Path, repo: Option<&Repo>) -> IdeResult<Self> {
        let metadata = match repo {
            Some(repo) => repo.metadata_dirs()?.iter().map(|d| ide_core::real_path::resolve_real(d)).collect(),
            None => Vec::new(),
        };
        Ok(Self { root: dunce::canonicalize(root)?, metadata })
    }

    /// Whether `rel` may be read or written here: it doesn't name git's metadata under any
    /// spelling (case, trailing dots or spaces, stream suffixes, short names), stays in the tree
    /// once links are followed, and isn't a link itself.
    fn allows(&self, rel: &str) -> bool {
        use ide_core::real_path::{names_git_dir, reaches_git_dir, resolve_real};
        let path = self.root.join(rel);
        if names_git_dir(Path::new(rel)) || path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
        let real = resolve_real(&path);
        real.starts_with(&self.root)
            && !reaches_git_dir(&self.root, &real)
            && !self.metadata.iter().any(|dir| real.starts_with(dir))
    }
}

/// Copies the task's `changes` (against `base`) from the worktree `cwd` into the
/// local checkout `root`, uncommitted: the user reviews and commits them with the
/// VCS tools. Files the checkout changed itself are left alone and reported, so
/// accepting never destroys the user's own edits. Returns accepted and skipped paths.
pub(crate) fn accept(
    root: &Path,
    cwd: &Path,
    base: &str,
    changes: &[AgentChange],
) -> IdeResult<crate::AgentAcceptOutcome> {
    let repo = repo_at(cwd)?;
    // Change paths are repository-relative, and the task's project may be a folder inside it.
    let local = discover(root)?;
    let local_root = local.as_ref().map_or_else(|| root.to_path_buf(), |r| r.root().to_path_buf());
    // Paths come from what the agent left in its worktree: neither side may lead into git's own
    // files or out through a link.
    let task_side = Confined::new(repo.root(), Some(&repo))?;
    let checkout_side = Confined::new(&local_root, local.as_ref())?;
    let copyable = |rel: &str| task_side.allows(rel) && checkout_side.allows(rel);
    let renamed_from: BTreeMap<String, String> =
        repo.diff_with_worktree(base)?.into_iter().filter_map(|f| Some((f.path, f.old_path?))).collect();
    // The task's version of one path of the checkout (`Some(None)`: absent there), or `None` when
    // the checkout changed it itself.
    let target = |rel: &str| -> IdeResult<Option<Option<Vec<u8>>>> {
        let in_task = repo.root().join(rel);
        let current = std::fs::read(&in_task).ok();
        // A file there that can't be read is the checkout's own: never written over.
        let Some(local_bytes) = existing(&local_root.join(rel)) else { return Ok(None) };
        if local_bytes == current {
            return Ok(Some(current));
        }
        let base_bytes = repo.file_bytes_at(&in_task, Some(base))?;
        // The checkout may hold the committed LF text with CRLF line ends (`core.autocrlf`).
        let unchanged = match (&local_bytes, &base_bytes) {
            (Some(now), Some(at_base)) => now == at_base || crlf_to_lf(now) == *at_base,
            (now, at_base) => now == at_base,
        };
        Ok(unchanged.then_some(current))
    };
    // Puts `bytes` (`None`: nothing) at `rel` of the checkout.
    let write = |rel: &str, bytes: Option<Vec<u8>>| -> IdeResult<()> {
        let local = local_root.join(rel);
        if std::fs::read(&local).ok() == bytes {
            return Ok(());
        }
        match bytes {
            Some(bytes) => {
                if let Some(parent) = local.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&local, bytes)?;
            }
            None => match std::fs::remove_file(&local) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            },
        }
        Ok(())
    };
    // Brings one path of the checkout to the task's version, unless the checkout changed it itself.
    let apply = |rel: &str| -> IdeResult<bool> {
        let Some(bytes) = target(rel)? else { return Ok(false) };
        write(rel, bytes)?;
        Ok(true)
    };
    let mut accepted = Vec::with_capacity(changes.len());
    let mut skipped = Vec::new();
    let skip = |path: &str| crate::AgentAcceptSkipped {
        path: path.to_owned(),
        reason: "the checkout has changes of its own to it; accept it by hand".to_owned(),
    };
    let refuse = |path: &str| crate::AgentAcceptSkipped {
        path: path.to_owned(),
        reason: "it leads into git's own files or through a link, so it is not copied".to_owned(),
    };
    for change in changes {
        let old = renamed_from.get(&change.rel_path);
        if !copyable(&change.rel_path) {
            skipped.push(refuse(&change.rel_path));
            continue;
        }
        if let Some(old) = old.filter(|old| !copyable(old)) {
            skipped.push(refuse(old));
            continue;
        }
        // A case-only rename (`a.txt` → `A.txt`). Where the disk resolves both
        // spellings to one file it is renamed in place and `apply` then refreshes
        // the content. On a case-sensitive disk the two names are different files:
        // both are checked before either changes — the old one must be the file the
        // checkout had, the new one absent or already the task's — then the task's
        // version lands at the new name before the old one goes.
        let case_only =
            old.is_some_and(|o| o != &change.rel_path && o.to_lowercase() == change.rel_path.to_lowercase());
        if case_only {
            let old = old.expect("case_only implies a rename source");
            let (old_path, new_path) = (local_root.join(old), local_root.join(&change.rel_path));
            if same_file(&old_path, &new_path) {
                std::fs::rename(&old_path, &new_path)?;
            } else {
                let Some(old_target) = target(old)? else {
                    skipped.push(skip(old));
                    continue;
                };
                let task_bytes = std::fs::read(repo.root().join(&change.rel_path)).ok();
                let at_new = existing(&new_path);
                if at_new.as_ref().is_none_or(|at_new| at_new.is_some() && *at_new != task_bytes) {
                    skipped.push(skip(&change.rel_path));
                    continue;
                }
                write(&change.rel_path, task_bytes)?;
                write(old, old_target)?;
                accepted.push(change.rel_path.clone());
                continue;
            }
        }
        if !apply(&change.rel_path)? {
            skipped.push(skip(&change.rel_path));
            continue;
        }
        accepted.push(change.rel_path.clone());
        // A rename also takes the file away from its old path (a case-only rename
        // is handled above).
        if !case_only
            && let Some(old) = old
            && !apply(old)?
        {
            skipped.push(skip(old));
        }
    }
    Ok(crate::AgentAcceptOutcome { accepted, skipped })
}

/// Size and modification time of a file, `None` once it is gone.
pub(crate) type Stamp = Option<(u64, u128)>;

pub(crate) fn stamp(path: &Path) -> Stamp {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some((meta.len(), modified))
}

/// The files already changed in `cwd` against `HEAD`, stamped so later edits to them show.
pub(crate) fn snapshot(cwd: &Path) -> IdeResult<BTreeMap<String, Stamp>> {
    // Paths and stamps only: no diff and no line counts, which read every untracked file
    // and held up starting a task in a checkout with many of them.
    if let Some((base, repos)) = nested_repos(cwd)? {
        let roots: Vec<PathBuf> = repos.iter().map(|r| r.root().to_path_buf()).collect();
        let mut out = BTreeMap::new();
        for repo in &repos {
            for s in repo.status()? {
                if let Some(rel) = nested_rel(&base, repo, &roots, &s.path) {
                    out.insert(rel, stamp(&s.path));
                }
            }
        }
        return Ok(out);
    }
    let Some(repo) = Repo::discover(cwd)? else { return Ok(BTreeMap::new()) };
    Ok(repo.status()?.into_iter().map(|s| (s.rel_path, stamp(&s.path))).collect())
}

/// The files whose state changed between two snapshots of a checkout: edited, new, deleted,
/// or back to as committed.
pub(crate) fn changed_between(start: &BTreeMap<String, Stamp>, end: &BTreeMap<String, Stamp>) -> Vec<String> {
    let mut changed: Vec<String> =
        end.iter().filter(|(path, stamp)| start.get(*path) != Some(*stamp)).map(|(path, _)| path.clone()).collect();
    changed.extend(start.keys().filter(|path| !end.contains_key(*path)).cloned());
    changed
}

/// The changes among `changes` that the task made, when it records the files its turns
/// changed (`None`: every change counts).
pub(crate) fn made_by_task(changes: Vec<AgentChange>, touched: Option<&BTreeSet<String>>) -> Vec<AgentChange> {
    let Some(touched) = touched else { return changes };
    changes
        .into_iter()
        .filter(|c| touched.contains(&c.rel_path) || c.old_path.as_ref().is_some_and(|old| touched.contains(old)))
        .collect()
}

/// Drops the changes that were there before the task and haven't been touched since.
pub(crate) fn without_untouched(changes: Vec<AgentChange>, before: &BTreeMap<String, Stamp>) -> Vec<AgentChange> {
    changes.into_iter().filter(|c| before.get(&c.rel_path).is_none_or(|s| *s != stamp(&c.path))).collect()
}

/// Files larger than this that were changed before the task keep no copy: they can't be rolled back.
const SAVED_MAX: u64 = 8 * 1024 * 1024;

fn saved_name(rel: &str) -> String {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hash = DefaultHasher::new();
    rel.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

/// Copies the files in `before` (already changed in the checkout at `cwd` when the task started)
/// into `dir`, so rolling back the task's changes to them restores the user's own edits.
/// Whether anything was saved.
pub(crate) fn save_before(cwd: &Path, before: &BTreeMap<String, Stamp>, dir: &Path) -> IdeResult<bool> {
    let root = match nested_repos(cwd)? {
        Some((base, _)) => base,
        None => match Repo::discover(cwd)? {
            Some(repo) => repo.root().to_path_buf(),
            None => return Ok(false),
        },
    };
    let mut saved = false;
    for (rel, stamp) in before {
        let path = root.join(rel);
        if stamp.is_none() || !std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= SAVED_MAX) {
            continue;
        }
        std::fs::create_dir_all(dir)?;
        std::fs::copy(&path, dir.join(saved_name(rel)))?;
        saved = true;
    }
    Ok(saved)
}

/// Rolls `change` back: to the copy saved when the task started when the file had changes
/// then (`before`, `saved` holding the copies), otherwise to `rev` (removed when `rev` lacks
/// it, or when there is no `rev`: the repository had no commits).
pub(crate) fn restore(
    cwd: &Path,
    rev: Option<&str>,
    change: &AgentChange,
    before: &BTreeMap<String, Stamp>,
    saved: Option<&Path>,
) -> IdeResult<()> {
    let content = match before.get(&change.rel_path) {
        Some(None) => None,
        Some(Some(_)) => {
            let copy =
                saved.map(|d| d.join(saved_name(&change.rel_path))).filter(|p| p.is_file()).ok_or_else(|| {
                    IdeError::invalid(format!(
                        "{} had changes of yours when the task started that weren't saved; roll it back in Git instead",
                        change.rel_path
                    ))
                })?;
            Some(std::fs::read(copy)?)
        }
        None => match rev {
            Some(rev) => {
                let at = change.repo.as_ref().map_or(cwd, |r| r.0.as_path());
                let repo = Repo::discover(at)?.ok_or_else(|| IdeError::invalid("not in a git repository"))?;
                repo.file_bytes_at(&change.path.0, Some(rev))?
            }
            None => None,
        },
    };
    put(&change.path.0, content)
}

/// Writes `content` to `path`, or removes the file when there is none.
fn put(path: &Path, content: Option<Vec<u8>>) -> IdeResult<()> {
    match content {
        Some(bytes) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, bytes)?;
        }
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        },
    }
    Ok(())
}

/// The bytes of the copy of `rel` saved in `dir`, if there is one.
pub(crate) fn saved_copy(dir: &Path, rel: &str) -> Option<Vec<u8>> {
    std::fs::read(dir.join(saved_name(rel))).ok()
}

/// The checkout as the task's last turn started: what that turn's changes are compared with
/// and rolled back to. Recorded like the task's own start: `HEAD`, the files already changed,
/// and copies of those.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnStart {
    /// `HEAD` then (`None` outside a repository or before its first commit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// With nested repositories, each one's `HEAD` then, by its root.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub heads: BTreeMap<String, String>,
    /// The files already changed then, stamped.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub before: BTreeMap<String, Stamp>,
    /// The files among `before` with a copy in the task's turn folder.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub saved: BTreeSet<String>,
    /// The files that changed while the turn ran, recorded as it ended (`None` while it runs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed: Option<BTreeSet<String>>,
}

/// Records the checkout at `cwd` as a turn starts, with copies of its changed files in `dir`.
/// The copies `previous` saved of files unchanged since are kept rather than made again, so
/// starting a turn copies little more than what the turn before it changed.
pub(crate) fn start_turn(cwd: &Path, dir: &Path, previous: Option<&TurnStart>) -> IdeResult<TurnStart> {
    let Some(at) = TurnRepos::of(cwd)? else { return Ok(TurnStart::default()) };
    let mut heads = BTreeMap::new();
    let head = if at.nested {
        for repo in &at.repos {
            heads.extend(repo.head()?.1.map(|h| (root_key(repo.root()), h)));
        }
        None
    } else {
        at.repos[0].head()?.1
    };
    // As the turn's end is read, so the two compare.
    let before = snapshot(cwd)?;
    let mut saved = BTreeSet::new();
    match previous {
        Some(previous) => {
            for rel in &previous.saved {
                let unchanged =
                    before.get(rel).is_some_and(|now| now.is_some() && previous.before.get(rel) == Some(now));
                if unchanged {
                    saved.insert(rel.clone());
                } else {
                    let _ = std::fs::remove_file(dir.join(saved_name(rel)));
                }
            }
        }
        None => {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    for (rel, stamp) in &before {
        let path = at.base.join(rel);
        if stamp.is_none()
            || saved.contains(rel)
            || !std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= SAVED_MAX)
        {
            continue;
        }
        std::fs::create_dir_all(dir)?;
        // One that can't be copied is listed but can't be rolled back, as a large one.
        if std::fs::copy(&path, dir.join(saved_name(rel))).is_ok() {
            saved.insert(rel.clone());
        }
    }
    Ok(TurnStart { head, heads, before, saved, changed: None })
}

/// The files that changed in `cwd` since the turn `start` began: in the working tree (as
/// `changed_between` sees them), and in the commits made since.
pub(crate) fn changed_in_turn(cwd: &Path, start: &TurnStart) -> IdeResult<(Vec<String>, BTreeSet<String>)> {
    let end = snapshot(cwd)?;
    let worktree = changed_between(&start.before, &end);
    let mut all: BTreeSet<String> = worktree.iter().cloned().collect();
    let Some(at) = TurnRepos::of(cwd)? else { return Ok((worktree, all)) };
    for repo in &at.repos {
        let (Some(from), Some(to)) = (at.head_then(start, repo), repo.head()?.1) else { continue };
        if from == to {
            continue;
        }
        // Named from the base, as the working tree's files are.
        let prefix = rel_in(&at.base, repo.root())?;
        let named = |rel: String| if prefix.is_empty() { rel } else { format!("{prefix}/{rel}") };
        for f in repo.diff_revisions(from, &to)? {
            all.extend(f.old_path.map(named));
            all.insert(named(f.path));
        }
    }
    Ok((worktree, all))
}

/// The content of `rel` as the turn `start` began (`None`: no file), its copies in `dir`.
fn at_turn_start(at: &TurnRepos, rel: &str, start: &TurnStart, dir: &Path) -> IdeResult<Option<Vec<u8>>> {
    match start.before.get(rel) {
        Some(None) => Ok(None),
        Some(Some(_)) => match start.saved.contains(rel).then(|| saved_copy(dir, rel)).flatten() {
            Some(bytes) => Ok(Some(bytes)),
            None => Err(IdeError::invalid(format!(
                "{rel} had changes when the turn started that weren't saved; roll it back in Git instead"
            ))),
        },
        None => {
            let path = at.base.join(rel);
            match at.owner(&path).and_then(|repo| Some((repo, at.head_then(start, repo)?))) {
                Some((repo, head)) => repo.file_bytes_at(&path, Some(head)),
                None => Ok(None),
            }
        }
    }
}

/// Added and removed lines from `old` to `new`; none for binary content.
fn line_stats(old: Option<&[u8]>, new: Option<&[u8]>) -> (u32, u32) {
    if [old, new].iter().flatten().any(|b| b.contains(&0)) {
        return (0, 0);
    }
    let text = |b: Option<&[u8]>| b.map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
    ide_vcs::diff_hunks(&text(old), &text(new))
        .iter()
        .fold((0, 0), |(added, removed), h| (added + h.lines, removed + h.old_lines))
}

/// The files among `changed` that differ from how they were as the turn `start` began.
pub(crate) fn turn_changes(
    cwd: &Path,
    start: &TurnStart,
    dir: &Path,
    changed: &BTreeSet<String>,
) -> IdeResult<Vec<AgentChange>> {
    let Some(at) = TurnRepos::of(cwd)? else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for rel in changed {
        let path = at.base.join(rel);
        // A folder (a submodule, say) or a file that can't be read has nothing to compare.
        let Some(now) = existing(&path) else { continue };
        let (kind, (added, removed)) = match at_turn_start(&at, rel, start, dir) {
            Ok(then) if then == now => continue,
            Ok(then) => {
                let kind = match (&then, &now) {
                    (None, _) => ChangeKind::Added,
                    (_, None) => ChangeKind::Deleted,
                    _ => ChangeKind::Modified,
                };
                (kind, line_stats(then.as_deref(), now.as_deref()))
            }
            // Its start wasn't saved: listed, without counts.
            Err(_) => (ChangeKind::Modified, (0, 0)),
        };
        out.push(AgentChange {
            rel_path: rel.clone(),
            kind,
            added,
            removed,
            old_path: None,
            repo: at.nested.then(|| at.owner(&path).map(|r| IpcPath(r.root().to_path_buf()))).flatten(),
            path: IpcPath(path),
        });
    }
    Ok(out)
}

/// The text of `path` as the turn `start` began, `None` when there was no file.
pub(crate) fn turn_text(cwd: &Path, path: &Path, start: &TurnStart, dir: &Path) -> IdeResult<Option<String>> {
    let Some(at) = TurnRepos::of(cwd)? else { return Ok(None) };
    let rel = rel_in(&at.base, path)?;
    if !start.before.contains_key(&rel)
        && let Some(head) = at.owner(&at.base.join(&rel)).and_then(|repo| at.head_then(start, repo))
    {
        return file_at(cwd, path, head);
    }
    let Some(bytes) = at_turn_start(&at, &rel, start, dir)? else { return Ok(None) };
    let encoding = match ide_vfs::load_text(path) {
        Ok(loaded) => encoding_rs::Encoding::for_label(loaded.encoding.as_bytes()).unwrap_or(encoding_rs::UTF_8),
        Err(_) => ide_vfs::detect_encoding(&bytes, None),
    };
    Ok(Some(encoding.decode(&bytes).0.into_owned()))
}

/// `path` relative to the repository at `root`, with `/` separators.
fn rel_in(root: &Path, path: &Path) -> IdeResult<String> {
    let rel = path
        .strip_prefix(root)
        .map(Path::to_path_buf)
        .ok()
        .or_else(|| {
            // Another spelling of the same place (a link, `/var` and `/private/var`); the file may be gone.
            let root = dunce::canonicalize(root).ok()?;
            let parent = dunce::canonicalize(path.parent()?).ok()?;
            Some(parent.strip_prefix(&root).ok()?.join(path.file_name()?))
        })
        .ok_or_else(|| IdeError::invalid(format!("{} is outside the repository", path.display())))?;
    Ok(rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
}

/// Puts `change` back as it was when the turn `start` began.
pub(crate) fn restore_turn(cwd: &Path, start: &TurnStart, dir: &Path, change: &AgentChange) -> IdeResult<()> {
    let at = TurnRepos::of(cwd)?
        .ok_or_else(|| IdeError::unavailable(format!("{} is not in a git repository", cwd.display())))?;
    put(&change.path.0, at_turn_start(&at, &change.rel_path, start, dir)?)
}

pub(crate) fn file_at(cwd: &Path, path: &Path, rev: &str) -> IdeResult<Option<String>> {
    // With nested repositories, the file's own one.
    let at = if spans_repos(cwd) { path.parent().unwrap_or(cwd) } else { cwd };
    let Some(repo) = discover(at)? else { return Ok(None) };
    let encoding = match ide_vfs::load_text(path) {
        Ok(loaded) => encoding_rs::Encoding::for_label(loaded.encoding.as_bytes()).unwrap_or(encoding_rs::UTF_8),
        Err(_) => ide_vfs::detect_encoding(&repo.file_bytes_at(path, Some(rev))?.unwrap_or_default(), None),
    };
    repo.file_at(path, Some(rev), encoding)
}

/// A short ASCII branch-safe name from the task title.
pub(crate) fn slugify(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 32 {
            break;
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() { "task".to_owned() } else { out.to_owned() }
}

fn unique_slug(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_owned();
    }
    (2..).map(|n| format!("{base}-{n}")).find(|s| !taken(s)).expect("unbounded")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removing_is_retried_while_a_file_is_still_in_use() {
        use std::io::{Error, ErrorKind};
        // A sharing violation as Windows reports it (os error 32), a vanished folder, other errors.
        let in_use = || Error::from_raw_os_error(32);
        for (fails, outcome) in [(0, true), (3, true), (REMOVE_ATTEMPTS - 1, true), (REMOVE_ATTEMPTS, false)] {
            let mut calls = 0;
            let r = retrying(REMOVE_ATTEMPTS, Duration::ZERO, || {
                calls += 1;
                if calls <= fails { Err(in_use()) } else { Ok(()) }
            });
            assert_eq!(r.is_ok(), outcome, "{fails} failures");
            assert_eq!(calls, (fails + 1).min(REMOVE_ATTEMPTS));
        }
        let mut calls = 0;
        let gone = retrying(REMOVE_ATTEMPTS, Duration::ZERO, || {
            calls += 1;
            if calls == 1 { Err(in_use()) } else { Err(Error::from(ErrorKind::NotFound)) }
        });
        assert!(gone.is_ok(), "deleted meanwhile: done");
        assert_eq!(calls, 2);
    }

    #[cfg(windows)]
    #[test]
    fn removing_waits_for_a_windows_file_lock_to_be_released() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let worktrees = tmp.path().join("wt");
        let created = create(&repo, &worktrees, "Locked file", None).unwrap();
        let file = std::fs::OpenOptions::new().read(true).share_mode(0).open(created.path.join("a.txt")).unwrap();
        assert_eq!(std::fs::remove_file(created.path.join("a.txt")).unwrap_err().raw_os_error(), Some(32));
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(800));
            drop(file);
        });
        let result = remove(&repo, &worktrees, &created.path);
        release.join().unwrap();
        result.unwrap();
        assert!(!created.path.exists());
    }

    #[test]
    fn slugs_are_branch_safe() {
        assert_eq!(slugify("Fix lexer UTF-16 columns!"), "fix-lexer-utf-16-columns");
        assert_eq!(slugify("修复 lexer 越界"), "lexer");
        assert_eq!(slugify("修复越界"), "task");
        assert_eq!(slugify(&"a".repeat(50)).len(), 32);
        assert_eq!(unique_slug("x", |s| s == "x" || s == "x-2"), "x-3");
    }

    #[test]
    fn outside_a_repository_there_is_nothing_to_compare() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("plain");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();

        assert!(changes(&dir, "HEAD").unwrap().is_empty());
        assert!(snapshot(&dir).unwrap().is_empty());
        assert_eq!(file_at(&dir, &dir.join("a.txt"), "HEAD").unwrap(), None);
        assert!(create(&dir, &tmp.path().join("wt"), "Edit A", None).is_err());
        assert!(remove(&dir, tmp.path(), &dir).is_err());
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
                // Hermetic line endings: a developer or CI runner with
                // `core.autocrlf=true` would otherwise check the fixtures out as CRLF.
                "-c",
                "core.autocrlf=false",
            ])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    #[cfg(unix)]
    #[test]
    fn attributed_changes_only_diff_the_owning_checkout() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
        for n in 0..15 {
            let repo = root.join(format!("repo{n:02}"));
            std::fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init", "-q", "-b", "main"]);
            std::fs::write(repo.join("a.txt"), "one\n").unwrap();
            git(&repo, &["add", "a.txt"]);
            git(&repo, &["commit", "-q", "-m", "initial"]);
            std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        }
        // Count real Git diff processes, not walks to discover the topology.
        let git = tmp.path().join("count-git");
        let log = tmp.path().join("count-git.log");
        std::fs::write(
            &git,
            "#!/bin/sh\nfor arg do\nif [ \"$arg\" = diff ]; then pwd >> \"$0.log\"; break; fi\ndone\nexec git \"$@\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o700)).unwrap();
        let at = TaskBase::Local { cwd: root, start: None };
        let before = BTreeMap::new();
        let one = BTreeSet::from(["repo07/a.txt".to_owned()]);
        let read = |touched: Option<&BTreeSet<String>>| {
            std::fs::write(&log, "").unwrap();
            let start = std::time::Instant::now();
            let changes = ide_vcs::with_git_executable(Some(&git), || at.changes(&before, touched).unwrap());
            let elapsed = start.elapsed();
            let calls = std::fs::read_to_string(&log).unwrap();
            eprintln!("change read: touched={:?} elapsed={elapsed:?}", touched.map(BTreeSet::len));
            (changes, calls.lines().count())
        };
        let (all, full_calls) = read(None);
        let (selected, selected_calls) = read(Some(&one));
        let (empty, empty_calls) = read(Some(&BTreeSet::new()));
        assert_eq!(all.len(), 15);
        assert_eq!(
            serde_json::to_value(selected).unwrap(),
            serde_json::to_value(made_by_task(all, Some(&one))).unwrap()
        );
        assert!(empty.is_empty());
        eprintln!("git diff children: full {full_calls}, one touched {selected_calls}, none touched {empty_calls}");
        assert!(selected_calls > 0);
        assert_eq!(selected_calls * 15, full_calls);
        assert_eq!(empty_calls, 0);
    }

    #[test]
    fn a_project_with_nested_repositories_sees_changes_in_each_one() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let (nested, deeper) = (root.join("libs/validation"), root.join("libs/validation/pkg/sdk"));
        for repo in [&root, &nested, &deeper] {
            std::fs::create_dir_all(repo).unwrap();
            git(repo, &["init", "-q", "-b", "main"]);
            std::fs::write(repo.join("a.txt"), "one\n").unwrap();
            git(repo, &["add", "a.txt"]);
            git(repo, &["commit", "-q", "-m", "init"]);
        }
        assert!(spans_repos(&root));
        std::fs::write(root.join("mine.txt"), "the user's\n").unwrap();
        let before = snapshot(&root).unwrap();
        assert_eq!(before.keys().collect::<Vec<_>>(), ["mine.txt"]);

        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        std::fs::write(nested.join("a.txt"), "two\n").unwrap();
        std::fs::write(nested.join("b.txt"), "new\n").unwrap();
        std::fs::write(deeper.join("a.txt"), "two\n").unwrap();
        let at = TaskBase::Local { cwd: root.clone(), start: None };
        let changed = at.changes(&before, None).unwrap();
        let listed: Vec<(&str, &Path)> =
            changed.iter().map(|c| (c.rel_path.as_str(), c.repo.as_ref().unwrap().0.as_path())).collect();
        assert_eq!(
            listed,
            [
                ("a.txt", root.as_path()),
                ("libs/validation/a.txt", nested.as_path()),
                ("libs/validation/b.txt", nested.as_path()),
                ("libs/validation/pkg/sdk/a.txt", deeper.as_path()),
            ]
        );
        assert_eq!(at.grouped_changes(&before).unwrap().uncommitted.len(), 4);
        assert_eq!(file_at(&root, &nested.join("a.txt"), "HEAD").unwrap().as_deref(), Some("one\n"));

        let rev = at.rev().unwrap();
        for change in &changed {
            restore(&root, rev.as_deref(), change, &before, None).unwrap();
        }
        for repo in [&root, &nested, &deeper] {
            assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\n");
        }
        assert!(!nested.join("b.txt").exists());
        assert!(root.join("mine.txt").exists(), "the user's own change stays");
        // A deleted file cannot be canonicalized, but still belongs to its innermost repo.
        std::fs::remove_file(deeper.join("a.txt")).unwrap();
        let removed = at.changes(&before, Some(&BTreeSet::from(["libs/validation/pkg/sdk/a.txt".into()]))).unwrap();
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].repo.as_ref().unwrap().0, deeper);
        assert_eq!(removed[0].kind, ChangeKind::Deleted);
    }

    #[test]
    fn worktree_changes_are_listed_against_the_base() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);

        let created = create(&repo, &tmp.path().join("wt"), "Edit A", None).unwrap();
        assert_eq!(created.branch, "agent/edit-a");
        assert_eq!(created.base, "main");
        std::fs::write(created.path.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::write(created.path.join("new.txt"), "x\ny\n").unwrap();

        let got = changes(&created.path, &created.base_commit).unwrap();
        let summary: Vec<_> = got.iter().map(|c| (c.rel_path.as_str(), c.kind, c.added, c.removed)).collect();
        assert_eq!(summary, [("a.txt", ChangeKind::Modified, 2, 1), ("new.txt", ChangeKind::Added, 2, 0)]);
        let base_text = file_at(&created.path, &created.path.join("a.txt"), &created.base_commit).unwrap();
        assert_eq!(base_text.as_deref(), Some("one\ntwo\n"));

        // Changes already in the checkout drop out until they are edited again.
        let before = snapshot(&created.path).unwrap();
        std::fs::write(created.path.join("b.txt"), "b\n").unwrap();
        let rels = |c: Vec<AgentChange>| c.into_iter().map(|c| c.rel_path).collect::<Vec<_>>();
        let after = changes(&created.path, "HEAD").unwrap();
        assert_eq!(rels(without_untouched(after, &before)), ["b.txt"]);
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(created.path.join("new.txt"), "x\ny\nz\n").unwrap();
        let after = changes(&created.path, "HEAD").unwrap();
        assert_eq!(rels(without_untouched(after, &before)), ["b.txt", "new.txt"]);

        // A second task with the same title gets its own worktree.
        assert_eq!(create(&repo, &tmp.path().join("wt"), "Edit A", None).unwrap().branch, "agent/edit-a-2");
        remove(&repo, &tmp.path().join("wt"), &created.path).unwrap();
        assert!(!created.path.exists());
    }

    #[test]
    fn a_turn_copies_only_what_changed_since_the_last_one() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "base\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let dir = tmp.path().join("turn");
        let set = |names: &[&str]| names.iter().map(|n| (*n).to_owned()).collect::<BTreeSet<_>>();

        std::fs::write(repo.join("a.txt"), "turn 1\n").unwrap();
        std::fs::write(repo.join("b.txt"), "b\n").unwrap();
        let first = start_turn(&repo, &dir, None).unwrap();
        assert_eq!(first.saved, set(&["a.txt", "b.txt"]));
        // A copy made again would replace this mark.
        std::fs::write(dir.join(saved_name("b.txt")), "kept\n").unwrap();

        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(repo.join("a.txt"), "turn two\n").unwrap();
        let second = start_turn(&repo, &dir, Some(&first)).unwrap();
        assert_eq!(second.saved, set(&["a.txt", "b.txt"]));
        assert_eq!(saved_copy(&dir, "a.txt").as_deref(), Some(&b"turn two\n"[..]));
        assert_eq!(saved_copy(&dir, "b.txt").as_deref(), Some(&b"kept\n"[..]));

        // Back as committed: nothing to keep a copy of.
        git(&repo, &["checkout", "--", "a.txt"]);
        let third = start_turn(&repo, &dir, Some(&second)).unwrap();
        assert_eq!(third.saved, set(&["b.txt"]));
        assert_eq!(saved_copy(&dir, "a.txt"), None);
        // Without a record of the last turn (a task from before), every copy is made afresh.
        let fresh = start_turn(&repo, &dir, None).unwrap();
        assert_eq!(fresh.saved, set(&["b.txt"]));
        assert_eq!(saved_copy(&dir, "b.txt").as_deref(), Some(&b"b\n"[..]));
    }

    #[cfg(unix)]
    #[test]
    fn a_turns_start_is_found_through_another_spelling_of_the_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = dunce::canonicalize(tmp.path()).unwrap().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "base\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("a.txt"), "turn 1\n").unwrap();
        let dir = tmp.path().join("turn");
        let start = start_turn(&repo, &dir, None).unwrap();
        std::fs::write(repo.join("a.txt"), "turn 2\n").unwrap();
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&repo, &link).unwrap();
        for at in [&repo, &link] {
            assert_eq!(turn_text(&repo, &at.join("a.txt"), &start, &dir).unwrap().as_deref(), Some("turn 1\n"));
            assert_eq!(turn_text(&repo, &at.join("new.txt"), &start, &dir).unwrap(), None);
        }
        assert!(turn_text(&repo, &tmp.path().join("elsewhere.txt"), &start, &dir).is_err());
    }

    #[test]
    fn commits_since_the_base_are_listed_with_their_files() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);

        let created = create(&repo, &tmp.path().join("wt"), "Edit A", None).unwrap();
        assert!(commits(&created.path, &created.base_commit, &created.base_commit).unwrap().is_empty());

        std::fs::write(created.path.join("a.txt"), "one\ntwo\n").unwrap();
        git(&created.path, &["add", "."]);
        git(&created.path, &["commit", "-q", "-m", "change a"]);
        std::fs::write(created.path.join("b.txt"), "b\n").unwrap();
        git(&created.path, &["add", "."]);
        git(&created.path, &["commit", "-q", "-m", "add b"]);

        let head = head_of(&created.path).unwrap().1;
        let log = commits(&created.path, &created.base_commit, &head).unwrap();
        assert_eq!(log.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(), ["add b", "change a"]);
        assert_eq!(log[0].files.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(), ["b.txt"]);
        assert_eq!((log[0].files[0].added, log[0].files[0].removed), (1, 0));
        assert_eq!(log[1].files.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(), ["a.txt"]);
        assert_eq!((log[1].files[0].added, log[1].files[0].removed), (1, 0));
        assert!(log.iter().all(|c| c.parent.is_some() && !c.message.is_empty()));

        // Nothing is uncommitted after the commits; editing a committed file brings it back.
        let at = TaskBase::Worktree { cwd: created.path.clone(), base: created.base_commit.clone() };
        let grouped = at.grouped_changes(&BTreeMap::new()).unwrap();
        assert!(grouped.uncommitted.is_empty());
        assert_eq!(grouped.commits.len(), 2);
        std::fs::write(created.path.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let grouped = at.grouped_changes(&BTreeMap::new()).unwrap();
        assert_eq!(grouped.uncommitted.iter().map(|c| c.rel_path.as_str()).collect::<Vec<_>>(), ["a.txt"]);
        assert_eq!(grouped.commits.len(), 2);
    }

    #[test]
    fn a_rename_in_a_commit_keeps_its_old_path() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let base = head_of(&repo).unwrap().1;

        std::fs::rename(repo.join("a.txt"), repo.join("b.txt")).unwrap();
        std::fs::write(repo.join("b.txt"), "one\ntwo\nthree\nfour\nFIVE\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "rename a"]);

        let head = head_of(&repo).unwrap().1;
        let log = commits(&repo, &base, &head).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].files.len(), 1);
        assert_eq!(log[0].files[0].rel_path, "b.txt");
        assert_eq!(log[0].files[0].old_path.as_deref(), Some("a.txt"));
        assert_eq!(log[0].files[0].kind, ChangeKind::Renamed);
    }

    #[test]
    fn a_local_task_has_no_commits() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();

        let at = TaskBase::Local { cwd: repo.clone(), start: None };
        let grouped = at.grouped_changes(&BTreeMap::new()).unwrap();
        assert!(grouped.commits.is_empty());
        assert_eq!(grouped.uncommitted.iter().map(|c| c.rel_path.as_str()).collect::<Vec<_>>(), ["a.txt"]);
    }

    #[test]
    fn a_broken_worktree_registration_still_leaves_a_deletable_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);

        // A pruned registration (the repository moved, `git worktree prune` ran).
        let created = create(&repo, &tmp.path().join("wt"), "Edit A", None).unwrap();
        let registration = repo.join(".git/worktrees").join(created.path.file_name().unwrap());
        std::fs::remove_dir_all(registration).unwrap();
        remove(&repo, &tmp.path().join("wt"), &created.path).unwrap();
        assert!(!created.path.exists());

        // A deleted `.git` file in the worktree itself.
        let created = create(&repo, &tmp.path().join("wt"), "Edit B", None).unwrap();
        std::fs::remove_file(created.path.join(".git")).unwrap();
        remove(&repo, &tmp.path().join("wt"), &created.path).unwrap();
        assert!(!created.path.exists());

        // A folder outside the worktrees directory is never deleted by hand.
        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("keep.txt"), "x\n").unwrap();
        assert!(remove(&repo, &tmp.path().join("wt"), &elsewhere).is_err());
        assert!(elsewhere.join("keep.txt").exists());
    }

    fn accept_repo() -> (tempfile::TempDir, PathBuf, Created) {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        // Hermetic line endings: a machine with `core.autocrlf=true` would check
        // the fixtures and the worktree out as CRLF.
        git(&repo, &["config", "core.autocrlf", "false"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.join("gone.txt"), "bye\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let created = create(&repo, &tmp.path().join("wt"), "Edit A", None).unwrap();
        (tmp, repo, created)
    }

    fn listed(cwd: &Path, base: &str) -> Vec<AgentChange> {
        without_untouched(changes(cwd, base).unwrap(), &BTreeMap::new())
    }

    #[test]
    fn accept_moves_a_renamed_file_and_maps_paths_from_a_project_folder() {
        let (_tmp, repo, created) = accept_repo();
        std::fs::create_dir(created.path.join("app")).unwrap();
        git(&created.path, &["mv", "a.txt", "app/moved.txt"]);
        std::fs::write(created.path.join("app/new.txt"), "n\n").unwrap();
        git(&created.path, &["add", "."]);
        git(&created.path, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "move"]);

        // The task's project is the repository's `app` folder.
        let project = repo.join("app");
        std::fs::create_dir(&project).unwrap();
        let changes = listed(&created.path, &created.base_commit);
        let outcome = accept(&project, &created.path, &created.base_commit, &changes).unwrap();
        assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
        assert_eq!(std::fs::read_to_string(repo.join("app/moved.txt")).unwrap(), "one\ntwo\n");
        assert_eq!(std::fs::read_to_string(repo.join("app/new.txt")).unwrap(), "n\n");
        assert!(!repo.join("a.txt").exists(), "the rename's old path is gone");
        assert!(!repo.join("app/app").exists());
    }

    #[test]
    fn accept_treats_a_crlf_checkout_of_the_base_as_unchanged() {
        let (_tmp, repo, created) = accept_repo();
        // The checkout holds the committed text with CRLF line ends, as core.autocrlf leaves it.
        std::fs::write(repo.join("a.txt"), "one\r\ntwo\r\n").unwrap();
        std::fs::write(created.path.join("a.txt"), "one\nTWO\n").unwrap();
        git(&created.path, &["mv", "gone.txt", "kept.txt"]);
        std::fs::write(repo.join("gone.txt"), "bye\r\n").unwrap();
        let changes = listed(&created.path, &created.base_commit);
        let outcome = accept(&repo, &created.path, &created.base_commit, &changes).unwrap();
        assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\nTWO\n");
        assert!(repo.join("kept.txt").exists() && !repo.join("gone.txt").exists());
    }

    #[test]
    fn accept_applies_a_case_only_rename() {
        let (_tmp, repo, created) = accept_repo();
        git(&created.path, &["mv", "a.txt", "A.txt"]);
        let changes = listed(&created.path, &created.base_commit);
        let outcome = accept(&repo, &created.path, &created.base_commit, &changes).unwrap();
        assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
        let names: Vec<_> = std::fs::read_dir(&repo)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.eq_ignore_ascii_case("a.txt"))
            .collect();
        assert_eq!(names, ["A.txt"]);
    }

    #[test]
    fn a_case_only_rename_keeps_a_file_the_checkout_has_at_the_new_name() {
        let (_tmp, repo, created) = accept_repo();
        std::fs::write(repo.join("A.txt"), "mine\n").unwrap();
        if std::fs::read_to_string(repo.join("a.txt")).unwrap() == "mine\n" {
            eprintln!("this disk doesn't tell a.txt from A.txt; nothing to check");
            return;
        }
        git(&created.path, &["mv", "a.txt", "A.txt"]);
        let changes = listed(&created.path, &created.base_commit);
        let outcome = accept(&repo, &created.path, &created.base_commit, &changes).unwrap();
        assert_eq!(outcome.skipped.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(), ["A.txt"]);
        assert_eq!(std::fs::read_to_string(repo.join("A.txt")).unwrap(), "mine\n");
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\ntwo\n");
    }

    #[cfg(unix)]
    #[test]
    fn accept_leaves_a_checkout_file_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, repo, created) = accept_repo();
        std::fs::write(created.path.join("new.txt"), "task\n").unwrap();
        std::fs::write(repo.join("new.txt"), "mine\n").unwrap();
        std::fs::set_permissions(repo.join("new.txt"), std::fs::Permissions::from_mode(0o200)).unwrap();
        if std::fs::read(repo.join("new.txt")).is_ok() {
            eprintln!("running as a user that reads any file; nothing to check");
            return;
        }
        let changes = listed(&created.path, &created.base_commit);
        let outcome = accept(&repo, &created.path, &created.base_commit, &changes).unwrap();
        std::fs::set_permissions(repo.join("new.txt"), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(outcome.skipped.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(), ["new.txt"]);
        assert_eq!(std::fs::read_to_string(repo.join("new.txt")).unwrap(), "mine\n");
    }

    #[cfg(windows)]
    #[test]
    fn accept_does_not_write_into_the_checkouts_git_folder_through_its_short_name() {
        let (_tmp, repo, created) = accept_repo();
        if !repo.join("GIT~1").join("HEAD").is_file() {
            eprintln!("8.3 short names are disabled on this volume; nothing to check");
            return;
        }
        // Written in the worktree under the name the checkout's `.git` folder also has.
        let wt = &created.path;
        std::fs::rename(wt.join(".git"), wt.join("gitfile")).unwrap();
        std::fs::create_dir_all(wt.join("GIT~1").join("hooks")).unwrap();
        std::fs::write(wt.join("GIT~1").join("hooks").join("pre-commit"), "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::rename(wt.join("gitfile"), wt.join(".git")).unwrap();
        std::fs::write(wt.join("a.txt"), "one\nTWO\n").unwrap();

        let changes = listed(wt, &created.base_commit);
        assert!(changes.iter().any(|c| c.rel_path == "GIT~1/hooks/pre-commit"), "control: git lists it");
        let outcome = accept(&repo, wt, &created.base_commit, &changes).unwrap();
        assert!(!repo.join(".git").join("hooks").join("pre-commit").exists(), "{outcome:?}");
        assert_eq!(outcome.accepted, ["a.txt"]);
        assert_eq!(outcome.skipped.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(), ["GIT~1/hooks/pre-commit"]);
    }

    #[test]
    fn accept_refuses_paths_that_lead_into_git_metadata_under_any_spelling() {
        let (tmp, repo, _created) = accept_repo();
        let checkout = Confined::new(&repo, Repo::discover(&repo).unwrap().as_ref()).unwrap();
        for rel in [
            ".git/hooks/pre-commit",
            ".GIT/hooks/pre-commit",
            ".git./hooks/pre-commit",
            ".git /hooks/pre-commit",
            ".git::$INDEX_ALLOCATION/hooks/pre-commit",
            "sub/.git/config",
            "../outside.txt",
        ] {
            assert!(!checkout.allows(rel), "{rel}");
        }
        assert!(checkout.allows("src/new.txt"));
        assert!(checkout.allows(".github/workflows/ci.yml"));

        // git's folder under another name inside the tree (`--separate-git-dir`).
        let separate = tmp.path().join("separate");
        std::fs::create_dir(&separate).unwrap();
        git(&separate, &["init", "-q", "--separate-git-dir", "meta", "-b", "main"]);
        let side = Confined::new(&separate, Repo::discover(&separate).unwrap().as_ref()).unwrap();
        assert!(!side.allows("meta/hooks/pre-commit"));
        assert!(side.allows("metadata.txt"));
    }

    /// A link the task left in its worktree, or a linked folder in the checkout: neither is followed.
    #[test]
    fn accept_does_not_follow_links_on_either_side() {
        let (tmp, repo, created) = accept_repo();
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret\n").unwrap();
        // A folder link in the checkout (a junction on Windows, which needs no privilege).
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, repo.join("linked")).unwrap();
        #[cfg(windows)]
        assert!(
            std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(repo.join("linked"))
                .arg(&outside)
                .output()
                .unwrap()
                .status
                .success()
        );
        std::fs::create_dir(created.path.join("linked")).unwrap();
        std::fs::write(created.path.join("linked/new.txt"), "x\n").unwrap();
        std::fs::write(created.path.join("a.txt"), "one\nTWO\n").unwrap();
        // A file link in the worktree, where the platform lets this user create one.
        #[cfg(unix)]
        let file_link = std::os::unix::fs::symlink(outside.join("secret.txt"), created.path.join("copied.txt"));
        #[cfg(windows)]
        let file_link = std::os::windows::fs::symlink_file(outside.join("secret.txt"), created.path.join("copied.txt"));
        if let Err(e) = &file_link {
            eprintln!("no file link ({e}); checking the folder link only");
        }

        let changes: Vec<_> = listed(&created.path, &created.base_commit);
        let outcome = accept(&repo, &created.path, &created.base_commit, &changes).unwrap();
        assert!(!outside.join("new.txt").exists(), "{outcome:?}");
        assert!(!repo.join("copied.txt").exists(), "{outcome:?}");
        assert!(outcome.accepted.contains(&"a.txt".to_owned()));
        let refused: Vec<_> = outcome.skipped.iter().map(|s| s.path.as_str()).collect();
        if file_link.is_ok() {
            assert_eq!(refused, ["copied.txt", "linked/new.txt"]);
        } else {
            assert_eq!(refused, ["linked/new.txt"]);
        }
    }

    #[test]
    fn accept_copies_new_modified_and_deleted_files_into_the_checkout() {
        let (_tmp, repo, created) = accept_repo();
        std::fs::write(created.path.join("a.txt"), "one\nTWO\n").unwrap();
        std::fs::write(created.path.join("new.txt"), "x\n").unwrap();
        std::fs::remove_file(created.path.join("gone.txt")).unwrap();

        let outcome =
            accept(&repo, &created.path, &created.base_commit, &listed(&created.path, &created.base_commit)).unwrap();
        assert!(outcome.skipped.is_empty());
        assert_eq!(outcome.accepted, ["a.txt", "gone.txt", "new.txt"]);
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\nTWO\n");
        assert_eq!(std::fs::read_to_string(repo.join("new.txt")).unwrap(), "x\n");
        assert!(!repo.join("gone.txt").exists());

        // Accepting again changes nothing: the checkout already matches.
        let again =
            accept(&repo, &created.path, &created.base_commit, &listed(&created.path, &created.base_commit)).unwrap();
        assert!(again.skipped.is_empty());
        assert_eq!(again.accepted, ["a.txt", "gone.txt", "new.txt"]);
    }

    #[test]
    fn a_local_task_goes_back_to_its_start_unless_the_user_committed_on_top_of_it() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        let local = |start: Option<&str>| TaskBase::Local { cwd: repo.clone(), start: start.map(str::to_owned) };
        let head = || head_of(&repo).unwrap().1;
        let commit = |name: &str| {
            std::fs::write(repo.join(name), "x\n").unwrap();
            git(&repo, &["add", "."]);
            git(&repo, &["commit", "-q", "-m", name]);
            head_of(&repo).unwrap().1
        };

        assert_eq!(local(None).rev().unwrap(), None, "no commits yet");
        let first = commit("a.txt");
        assert_eq!(local(None).rev().unwrap(), Some(first.clone()), "an imported session: HEAD");
        let start = commit("b.txt");
        assert_eq!(local(Some(&start)).rev().unwrap(), Some(start.clone()), "HEAD where it started");
        let ahead = commit("c.txt");
        assert_eq!(local(Some(&start)).rev().unwrap(), Some(ahead), "committed on top: HEAD");
        git(&repo, &["reset", "-q", "--soft", &first]);
        assert_eq!(local(Some(&start)).rev().unwrap(), Some(start.clone()), "moved back: the start");
        git(&repo, &["checkout", "-q", "-b", "side"]);
        commit("d.txt");
        assert_eq!(local(Some(&start)).rev().unwrap(), Some(start.clone()), "another branch: the start");
        let gone = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(local(Some(gone)).rev().unwrap(), Some(head()), "an unknown start: HEAD");
        let worktree = TaskBase::Worktree { cwd: repo.clone(), base: start.clone() };
        assert_eq!(worktree.rev().unwrap(), Some(start));
    }

    #[test]
    fn accept_leaves_files_the_checkout_changed_itself() {
        let (_tmp, repo, created) = accept_repo();
        std::fs::write(created.path.join("a.txt"), "one\nTWO\n").unwrap();
        std::fs::write(created.path.join("gone.txt"), "bye\nbye\n").unwrap();
        std::fs::write(repo.join("a.txt"), "one\nMINE\n").unwrap();

        let outcome =
            accept(&repo, &created.path, &created.base_commit, &listed(&created.path, &created.base_commit)).unwrap();
        assert_eq!(outcome.accepted, ["gone.txt"]);
        assert_eq!(outcome.skipped.len(), 1);
        assert_eq!(outcome.skipped[0].path, "a.txt");
        assert!(!outcome.skipped[0].reason.is_empty());
        // The user's own edit survives; the other file comes over.
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\nMINE\n");
        assert_eq!(std::fs::read_to_string(repo.join("gone.txt")).unwrap(), "bye\nbye\n");
    }

    #[test]
    fn a_turn_changed_the_files_whose_state_moved() {
        let start: BTreeMap<String, Stamp> =
            [("edited", Some((1, 1))), ("same", Some((2, 2))), ("reverted", Some((3, 3)))]
                .into_iter()
                .map(|(p, s)| (p.to_owned(), s))
                .collect();
        let end: BTreeMap<String, Stamp> = [("edited", Some((1, 9))), ("same", Some((2, 2))), ("new", Some((4, 4)))]
            .into_iter()
            .map(|(p, s)| (p.to_owned(), s))
            .collect();
        let mut changed = changed_between(&start, &end);
        changed.sort();
        assert_eq!(changed, ["edited", "new", "reverted"]);
    }
}
