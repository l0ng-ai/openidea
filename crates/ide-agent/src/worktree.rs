//! Task worktrees and the changes made in them.

use crate::model::AgentChange;
use ide_core::{IdeError, IdeResult, IpcPath};
use ide_vcs::{ChangeKind, Repo};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

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

pub(crate) fn remove(project_root: &Path, path: &Path) -> IdeResult<()> {
    repo_at(project_root)?.remove_worktree(path, true)
}

/// Files under `cwd` that differ from `base` (untracked files included), with line counts.
pub(crate) fn changes(cwd: &Path, base: &str) -> IdeResult<Vec<AgentChange>> {
    let repo = repo_at(cwd)?;
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

fn stamp(path: &Path) -> Stamp {
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

pub(crate) fn file_at(cwd: &Path, path: &Path, rev: &str) -> IdeResult<Option<String>> {
    let repo = repo_at(cwd)?;
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
    fn slugs_are_branch_safe() {
        assert_eq!(slugify("Fix lexer UTF-16 columns!"), "fix-lexer-utf-16-columns");
        assert_eq!(slugify("修复 lexer 越界"), "lexer");
        assert_eq!(slugify("修复越界"), "task");
        assert_eq!(slugify(&"a".repeat(50)).len(), 32);
        assert_eq!(unique_slug("x", |s| s == "x" || s == "x-2"), "x-3");
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
        remove(&repo, &created.path).unwrap();
        assert!(!created.path.exists());
    }
}
