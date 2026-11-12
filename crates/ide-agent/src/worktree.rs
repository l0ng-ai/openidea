//! Task worktrees and the changes made in them.

use crate::model::AgentChange;
use ide_core::{IdeError, IdeResult, IpcPath};
use ide_vcs::{ChangeKind, Repo};
use std::collections::BTreeMap;
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

fn repo_at(path: &Path) -> IdeResult<Repo> {
    discover(path)?.ok_or_else(|| IdeError::unavailable(format!("{} is not in a git repository", path.display())))
}

/// The current branch (or commit when detached) and its commit.
pub(crate) fn head_of(path: &Path) -> IdeResult<(String, String)> {
    let info = repo_at(path)?.branch_info()?;
    let commit = info.head_commit.ok_or_else(|| IdeError::unavailable("the repository has no commits yet"))?;
    Ok((info.head.unwrap_or_else(|| commit.clone()), commit))
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
            AgentChange { path: IpcPath(root.join(&f.path)), rel_path: f.path, kind: f.kind, added, removed }
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

fn added(path: IpcPath, rel_path: String) -> AgentChange {
    let added = std::fs::read_to_string(&*path).map_or(0, |t| t.lines().count() as u32);
    AgentChange { path, rel_path, kind: ChangeKind::Added, added, removed: 0 }
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
    pub(crate) fn changes(&self, before: &BTreeMap<String, Stamp>) -> IdeResult<Vec<AgentChange>> {
        let (cwd, start) = match self {
            Self::Worktree { cwd, base } => return Ok(without_untouched(changes(cwd, base)?, before)),
            Self::Local { cwd, start } => (cwd, start.as_deref()),
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

    /// The revision the task's changed files go back to on rollback, and are compared with:
    /// the commit the task started from, or the current `HEAD` once the user committed on top
    /// of it, so those commits stay. `None` while the repository has no commits.
    pub(crate) fn rev(&self) -> IdeResult<Option<String>> {
        let (cwd, start) = match self {
            Self::Worktree { base, .. } => return Ok(Some(base.clone())),
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
    let mut accepted = Vec::with_capacity(changes.len());
    let mut skipped = Vec::new();
    for change in changes {
        let local = root.join(&change.rel_path);
        let base_bytes = repo.file_bytes_at(&change.path.0, Some(base))?;
        let current = std::fs::read(&change.path.0).ok();
        let local_bytes = std::fs::read(&local).ok();
        if local_bytes == current {
            accepted.push(change.rel_path.clone());
        } else if local_bytes == base_bytes {
            match current {
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
            accepted.push(change.rel_path.clone());
        } else {
            skipped.push(crate::AgentAcceptSkipped {
                path: change.rel_path.clone(),
                reason: "the checkout has changes of its own to it; accept it by hand".to_owned(),
            });
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
    let Some(repo) = Repo::discover(cwd)? else { return Ok(BTreeMap::new()) };
    Ok(repo.status()?.into_iter().map(|s| (s.rel_path, stamp(&s.path))).collect())
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
    let Some(repo) = Repo::discover(cwd)? else { return Ok(false) };
    let mut saved = false;
    for (rel, stamp) in before {
        let path = repo.root().join(rel);
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
    let path = &change.path.0;
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
                let repo = Repo::discover(cwd)?.ok_or_else(|| IdeError::invalid("not in a git repository"))?;
                repo.file_bytes_at(path, Some(rev))?
            }
            None => None,
        },
    };
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

pub(crate) fn file_at(cwd: &Path, path: &Path, rev: &str) -> IdeResult<Option<String>> {
    let Some(repo) = discover(cwd)? else { return Ok(None) };
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
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
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
}
