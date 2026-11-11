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

fn repo_at(path: &Path) -> IdeResult<Repo> {
    Repo::discover(path)?.ok_or_else(|| IdeError::unavailable(format!("{} is not in a git repository", path.display())))
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
    let Some(repo) = Repo::discover(cwd)? else { return Ok(Vec::new()) };
    let root = repo.root().to_path_buf();
    let stats = repo.numstat_with_worktree(base)?;
    let stat = |rel: &str| stats.iter().find(|(p, ..)| p == rel).map_or((0, 0), |&(_, a, r)| (a, r));
    let mut out: Vec<AgentChange> = repo
        .diff_with_worktree(base)?
        .into_iter()
        .map(|f| {
            let (added, removed) = stat(&f.path);
            AgentChange { path: IpcPath(root.join(&f.path)), rel_path: f.path, kind: f.kind, added, removed }
        })
        .collect();
    for s in repo.status()? {
        if s.unstaged == Some(ChangeKind::Untracked) && !out.iter().any(|c| c.rel_path == s.rel_path) {
            let added = std::fs::read_to_string(&*s.path).map_or(0, |t| t.lines().count() as u32);
            out.push(AgentChange { path: s.path, rel_path: s.rel_path, kind: ChangeKind::Added, added, removed: 0 });
        }
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
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
    Ok(changes(cwd, "HEAD")?.into_iter().map(|c| (c.rel_path, stamp(&c.path))).collect())
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
/// then (`before`, `saved` holding the copies), otherwise to `base` (removed when `base`
/// lacks it).
pub(crate) fn restore(
    cwd: &Path,
    base: &str,
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
        None => {
            let repo = Repo::discover(cwd)?.ok_or_else(|| IdeError::invalid("not in a git repository"))?;
            repo.file_bytes_at(path, Some(base))?
        }
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
    let Some(repo) = Repo::discover(cwd)? else { return Ok(None) };
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
}
