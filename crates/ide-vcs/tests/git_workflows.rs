//! End-to-end Git workflows as the IDE drives them (commit / amend, Undo Commit,
//! interactive rebase, push / fetch / update against a local bare `origin`, rollback,
//! branches, Add to VCS, shelve, cherry-pick / revert), including the edge cases
//! IDEA handles. Every repository is a throwaway temp dir built with the git CLI.

use ide_core::CancellationToken;
use ide_vcs::*;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

struct Fixture {
    tmp: tempfile::TempDir,
    dir: PathBuf,
}

fn git_in(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["-c", "init.defaultBranch=main", "-c", "core.quotepath=off"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn configure(dir: &Path) {
    for (k, v) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("tag.gpgsign", "false"),
        ("core.autocrlf", "false"),
        ("core.hooksPath", ".git/hooks"),
        ("merge.conflictstyle", "merge"),
        // Settings a user may have that must not change what the IDE does.
        ("pull.ff", "only"),
        ("pull.rebase", "true"),
        ("rebase.autoSquash", "true"),
    ] {
        git_in(dir, &["config", k, v]);
    }
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("work");
        std::fs::create_dir(&dir).unwrap();
        git_in(&dir, &["init", "-q"]);
        configure(&dir);
        Fixture { tmp, dir }
    }
    /// A bare `origin` plus this clone with `a.txt` committed and pushed on main.
    fn with_origin() -> (Self, PathBuf) {
        let fx = Fixture::new();
        let bare = fx.tmp.path().join("origin.git");
        git_in(fx.tmp.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
        git_in(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        fx.write("a.txt", "one\n");
        fx.commit_all("initial");
        fx.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        fx.git(&["push", "-q", "-u", "origin", "main"]);
        (fx, bare)
    }
    /// Another clone of `bare` that commits `rel` and pushes main.
    fn push_from_other(&self, bare: &Path, rel: &str, content: &str) {
        let other = self.tmp.path().join(format!("other-{}", rel.replace('/', "_")));
        if !other.exists() {
            git_in(self.tmp.path(), &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
            configure(&other);
        }
        git_in(&other, &["pull", "-q", "--rebase"]);
        std::fs::write(other.join(rel), content).unwrap();
        git_in(&other, &["add", "-A"]);
        git_in(&other, &["commit", "-q", "-m", &format!("remote {rel}")]);
        git_in(&other, &["push", "-q", "origin", "main"]);
    }
    fn git(&self, args: &[&str]) -> String {
        git_in(&self.dir, args)
    }
    fn write(&self, rel: &str, content: &str) {
        let p = self.dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.dir.join(rel)).unwrap()
    }
    fn exists(&self, rel: &str) -> bool {
        self.dir.join(rel).exists()
    }
    fn commit_all(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.head()
    }
    fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"])
    }
    fn subjects(&self) -> Vec<String> {
        self.git(&["log", "--format=%s"]).lines().map(str::to_string).collect()
    }
    fn repo(&self) -> Repo {
        Repo::discover(&self.dir).unwrap().expect("repository found")
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
}

fn quiet() -> (CancellationToken, impl Fn(String)) {
    (CancellationToken::new(), |_line: String| {})
}

fn status_of<'a>(st: &'a [FileStatus], rel: &str) -> Option<&'a FileStatus> {
    st.iter().find(|s| s.rel_path == rel)
}

fn entry(commit: &str, action: RebaseAction, message: Option<&str>) -> RebaseEntry {
    RebaseEntry { commit: commit.to_string(), action, message: message.map(str::to_string) }
}

// ---------------------------------------------------------------------------
// Commit / amend / Undo Commit

#[test]
fn commit_then_amend_keeps_or_replaces_message() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let repo = fx.repo();
    repo.stage(&[fx.path("a.txt")]).unwrap();
    let first = repo.commit("first\n\nbody", false, false).unwrap();
    assert_eq!(first, fx.head());

    fx.write("b.txt", "2\n");
    repo.stage(&[fx.path("b.txt")]).unwrap();
    // Empty message + amend keeps the previous message.
    let amended = repo.commit("", true, false).unwrap();
    assert_ne!(amended, first);
    assert_eq!(fx.git(&["log", "-1", "--format=%B"]), "first\n\nbody");
    assert_eq!(fx.git(&["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(fx.git(&["show", "--format=", "--name-only", "HEAD"]), "a.txt\nb.txt");

    repo.commit("reworded", true, false).unwrap();
    assert_eq!(fx.subjects(), vec!["reworded"]);
    assert!(repo.commit("   ", false, false).is_err(), "empty message must be rejected");
}

#[test]
fn undo_commit_keeps_changes_staged() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let base = fx.commit_all("base");
    fx.write("a.txt", "2\n");
    fx.write("new.txt", "n\n");
    let top = fx.commit_all("top message\n\nwith body");
    fx.write("a.txt", "3\n"); // unstaged edit on top survives

    let repo = fx.repo();
    let message = repo.undo_commit(&top).unwrap();
    assert_eq!(message, "top message\n\nwith body");
    assert_eq!(fx.head(), base);
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "new.txt").unwrap().staged, Some(ChangeKind::Added));
    assert_eq!(status_of(&st, "a.txt").unwrap().staged, Some(ChangeKind::Modified));
    assert_eq!(status_of(&st, "a.txt").unwrap().unstaged, Some(ChangeKind::Modified));
    assert_eq!(fx.read("a.txt"), "3\n");
}

#[test]
fn undo_commit_only_for_head() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let base = fx.commit_all("base");
    fx.write("a.txt", "2\n");
    let top = fx.commit_all("top");
    let err = fx.repo().undo_commit(&base).unwrap_err();
    assert!(err.message.contains("latest commit"), "{}", err.message);
    assert_eq!(fx.head(), top);
}

#[test]
fn undo_initial_commit_leaves_unborn_branch_with_files_staged() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.write("dir/b.txt", "2\n");
    let root = fx.commit_all("root");
    let repo = fx.repo();
    assert_eq!(repo.undo_commit(&root).unwrap(), "root");
    let info = repo.branch_info().unwrap();
    assert_eq!(info.head.as_deref(), Some("main"));
    assert_eq!(info.head_commit, None);
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "a.txt").unwrap().staged, Some(ChangeKind::Added));
    assert_eq!(status_of(&st, "dir/b.txt").unwrap().staged, Some(ChangeKind::Added));
    // Committing again works from the unborn branch.
    repo.commit("root again", false, false).unwrap();
    assert_eq!(fx.subjects(), vec!["root again"]);
}

#[test]
fn undo_initial_commit_on_detached_head_is_refused() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let root = fx.commit_all("root");
    fx.git(&["checkout", "-q", "--detach"]);
    let err = fx.repo().undo_commit(&root).unwrap_err();
    assert!(err.message.contains("detached"), "{}", err.message);
    assert_eq!(fx.head(), root, "HEAD must survive");
}

#[test]
fn undo_merge_commit_is_refused() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "topic"]);
    fx.write("t.txt", "t\n");
    fx.commit_all("topic");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("m.txt", "m\n");
    fx.commit_all("main");
    fx.git(&["merge", "-q", "--no-edit", "topic"]);
    let merge = fx.head();
    let err = fx.repo().undo_commit(&merge).unwrap_err();
    assert!(err.message.contains("merge commit"), "{}", err.message);
    assert_eq!(fx.head(), merge);
}

#[test]
fn undo_commit_on_detached_head() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let base = fx.commit_all("base");
    fx.git(&["checkout", "-q", "--detach"]);
    fx.write("a.txt", "2\n");
    let top = fx.commit_all("detached work");
    let repo = fx.repo();
    assert_eq!(repo.branch_info().unwrap().head, None);
    repo.undo_commit(&top).unwrap();
    assert_eq!(fx.head(), base);
    assert_eq!(repo.branch_info().unwrap().head, None, "still detached");
    assert_eq!(fx.git(&["rev-parse", "main"]), base, "branch untouched");
}

// ---------------------------------------------------------------------------
// Interactive rebase

/// main: c1..c4, each touching its own file.
fn linear() -> (Fixture, Vec<String>) {
    let fx = Fixture::new();
    let mut ids = Vec::new();
    for i in 1..=4 {
        fx.write(&format!("f{i}.txt"), &format!("{i}\n"));
        ids.push(fx.commit_all(&format!("c{i}")));
    }
    (fx, ids)
}

#[test]
fn interactive_rebase_reorder_squash_fixup_reword_drop() {
    let (fx, ids) = linear();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    // Rebase c2..c4 onto c1: c4 first (reworded), then c2 with c3 squashed into it.
    repo.interactive_rebase(
        Some(&ids[0]),
        &[
            entry(&ids[3], RebaseAction::Reword, Some("c4 reworded\n\nnew body")),
            entry(&ids[1], RebaseAction::Pick, None),
            entry(&ids[2], RebaseAction::Squash, Some("c2+c3")),
        ],
        &cancel,
        &out,
    )
    .unwrap();
    assert_eq!(fx.subjects(), vec!["c2+c3", "c4 reworded", "c1"]);
    assert_eq!(fx.git(&["log", "-1", "--format=%B", "HEAD~1"]), "c4 reworded\n\nnew body");
    assert_eq!(fx.git(&["show", "--format=", "--name-only", "HEAD"]), "f2.txt\nf3.txt");
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert!(!fx.path(".git/openidea-rebase").exists(), "plan files are removed once the rebase finished");

    // Fixup keeps the first message; drop removes the commit and its file.
    let ids: Vec<String> = fx.git(&["rev-list", "--reverse", "HEAD"]).lines().map(str::to_string).collect();
    repo.interactive_rebase(
        Some(&ids[0]),
        &[entry(&ids[1], RebaseAction::Drop, None), entry(&ids[2], RebaseAction::Pick, None)],
        &cancel,
        &out,
    )
    .unwrap();
    assert_eq!(fx.subjects(), vec!["c2+c3", "c1"]);
    assert!(!fx.exists("f4.txt"));
    let ids: Vec<String> = fx.git(&["rev-list", "--reverse", "HEAD"]).lines().map(str::to_string).collect();
    repo.interactive_rebase(
        None,
        &[entry(&ids[0], RebaseAction::Pick, None), entry(&ids[1], RebaseAction::Fixup, None)],
        &cancel,
        &out,
    )
    .unwrap();
    assert_eq!(fx.subjects(), vec!["c1"]);
    assert_eq!(fx.git(&["show", "--format=", "--name-only", "HEAD"]), "f1.txt\nf2.txt\nf3.txt");
}

#[test]
fn interactive_rebase_squash_without_message_combines_messages() {
    let (fx, ids) = linear();
    let (cancel, out) = quiet();
    fx.repo()
        .interactive_rebase(
            Some(&ids[1]),
            &[entry(&ids[2], RebaseAction::Pick, None), entry(&ids[3], RebaseAction::Squash, None)],
            &cancel,
            &out,
        )
        .unwrap();
    let msg = fx.git(&["log", "-1", "--format=%B"]);
    assert!(msg.contains("c3") && msg.contains("c4"), "{msg}");
    assert!(!msg.contains('#'), "comment lines must be stripped: {msg}");
}

#[test]
fn interactive_rebase_keeps_local_changes() {
    let (fx, ids) = linear();
    fx.write("f1.txt", "dirty\n");
    fx.write("staged.txt", "s\n");
    fx.git(&["add", "staged.txt"]);
    let (cancel, out) = quiet();
    fx.repo()
        .interactive_rebase(
            Some(&ids[1]),
            &[entry(&ids[3], RebaseAction::Pick, None), entry(&ids[2], RebaseAction::Reword, Some("c3!"))],
            &cancel,
            &out,
        )
        .unwrap();
    assert_eq!(fx.subjects(), vec!["c3!", "c4", "c2", "c1"]);
    assert_eq!(fx.read("f1.txt"), "dirty\n");
    assert!(fx.exists("staged.txt"));
    assert_eq!(fx.git(&["show", "--format=", "--name-only", "HEAD"]), "f3.txt", "staged change not committed");
}

#[test]
fn interactive_rebase_validates_the_plan() {
    let (fx, ids) = linear();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let before = fx.head();
    // Missing commit.
    let err =
        repo.interactive_rebase(Some(&ids[1]), &[entry(&ids[2], RebaseAction::Pick, None)], &cancel, &out).unwrap_err();
    assert!(err.message.contains("does not match"), "{}", err.message);
    // Squash as first line.
    let err = repo
        .interactive_rebase(
            Some(&ids[1]),
            &[entry(&ids[2], RebaseAction::Squash, None), entry(&ids[3], RebaseAction::Pick, None)],
            &cancel,
            &out,
        )
        .unwrap_err();
    assert!(err.message.contains("first commit"), "{}", err.message);
    assert_eq!(fx.head(), before);
    assert_eq!(repo.branch_info().unwrap().operation, None);
}

#[test]
fn interactive_rebase_conflict_stops_then_continues_with_reword() {
    let fx = Fixture::new();
    fx.write("f.txt", "0\n");
    let base = fx.commit_all("base");
    fx.write("f.txt", "1\n");
    let one = fx.commit_all("one");
    fx.write("f.txt", "2\n");
    let two = fx.commit_all("two");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    // Swapping two commits that edit the same line conflicts.
    let err = repo
        .interactive_rebase(
            Some(&base),
            &[entry(&two, RebaseAction::Reword, Some("two first")), entry(&one, RebaseAction::Pick, None)],
            &cancel,
            &out,
        )
        .unwrap_err();
    assert!(!err.message.is_empty());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "f.txt").unwrap().unstaged, Some(ChangeKind::Conflicted));

    // Resolve and continue: the reword exec runs after the resolved pick.
    fx.write("f.txt", "2\n");
    repo.stage(&[fx.path("f.txt")]).unwrap();
    let result = repo.continue_operation(&cancel, &out);
    // The second pick conflicts as well.
    if result.is_err() {
        fx.write("f.txt", "1\n");
        repo.stage(&[fx.path("f.txt")]).unwrap();
        repo.continue_operation(&cancel, &out).unwrap();
    }
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.subjects(), vec!["one", "two first", "base"]);
}

#[test]
fn interactive_rebase_edit_stops_for_amend() {
    let (fx, ids) = linear();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    repo.interactive_rebase(
        Some(&ids[1]),
        &[entry(&ids[2], RebaseAction::Edit, None), entry(&ids[3], RebaseAction::Pick, None)],
        &cancel,
        &out,
    )
    .unwrap();
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    fx.write("f3.txt", "edited\n");
    repo.stage(&[fx.path("f3.txt")]).unwrap();
    repo.commit("", true, false).unwrap();
    repo.continue_operation(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["show", "HEAD~1:f3.txt"]), "edited");
}

#[test]
fn interactive_rebase_refuses_merges_in_range() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let base = fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "topic"]);
    fx.write("t.txt", "t\n");
    let t = fx.commit_all("topic");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("m.txt", "m\n");
    let m = fx.commit_all("main");
    fx.git(&["merge", "-q", "--no-edit", "topic"]);
    let merge = fx.head();
    let (cancel, out) = quiet();
    let err = fx
        .repo()
        .interactive_rebase(
            Some(&base),
            &[
                entry(&m, RebaseAction::Pick, None),
                entry(&t, RebaseAction::Pick, None),
                entry(&merge, RebaseAction::Pick, None),
            ],
            &cancel,
            &out,
        )
        .unwrap_err();
    assert!(err.message.contains("merge"), "{}", err.message);
}

// ---------------------------------------------------------------------------
// Push / fetch / update

#[test]
fn push_rejected_non_fast_forward_then_update_and_push() {
    let (fx, bare) = Fixture::with_origin();
    fx.push_from_other(&bare, "remote.txt", "r\n");
    fx.write("local.txt", "l\n");
    fx.commit_all("local");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let err = repo.push(false, false, &cancel, &out).unwrap_err();
    assert!(
        err.message.contains("rejected") || err.message.contains("fetch first"),
        "push error must explain the rejection: {}",
        err.message
    );
    assert!(!err.message.contains("Writing objects"), "progress noise in error: {}", err.message);

    // Update (merge) with a user config of pull.ff=only still merges.
    repo.pull(false, &cancel, &out).unwrap();
    assert!(fx.exists("remote.txt"));
    assert_eq!(fx.git(&["rev-list", "--count", "--merges", "HEAD"]), "1");
    repo.push(false, false, &cancel, &out).unwrap();
    let info = repo.branch_info().unwrap();
    assert_eq!((info.ahead, info.behind), (0, 0));
}

#[test]
fn update_with_rebase_and_local_changes() {
    let (fx, bare) = Fixture::with_origin();
    fx.push_from_other(&bare, "a.txt", "remote\n");
    fx.write("local.txt", "l\n");
    fx.commit_all("local");
    // Uncommitted edits: a staged new file and an unstaged edit of a file the update does not touch.
    fx.write("wip.txt", "w\n");
    fx.git(&["add", "wip.txt"]);
    fx.write("local.txt", "l2\n");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    repo.pull(true, &cancel, &out).unwrap();
    assert_eq!(fx.read("a.txt"), "remote\n");
    assert_eq!(fx.read("local.txt"), "l2\n");
    assert!(fx.exists("wip.txt"));
    assert_eq!(fx.git(&["rev-list", "--count", "--merges", "HEAD"]), "0", "rebased, not merged");
    let info = repo.branch_info().unwrap();
    assert_eq!((info.ahead, info.behind), (1, 0));
    assert_eq!(info.operation, None);
}

#[test]
fn update_merge_with_local_changes_to_the_same_file() {
    let (fx, bare) = Fixture::with_origin();
    fx.push_from_other(&bare, "a.txt", "one\nremote tail\n");
    fx.write("local.txt", "l\n");
    fx.commit_all("local");
    // An uncommitted edit of a file the update changes too (non-overlapping lines).
    fx.write("a.txt", "uncommitted\none\n");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    repo.pull(false, &cancel, &out).unwrap();
    assert_eq!(fx.read("a.txt"), "uncommitted\none\nremote tail\n");
    assert_eq!(repo.branch_info().unwrap().behind, 0);
    assert_eq!(fx.git(&["rev-list", "--count", "--merges", "HEAD"]), "1");
}

#[test]
fn fetch_prunes_deleted_remote_branches() {
    let (fx, bare) = Fixture::with_origin();
    fx.git(&["push", "-q", "origin", "main:gone"]);
    fx.git(&["fetch", "-q"]);
    let repo = fx.repo();
    assert!(repo.branches().unwrap().iter().any(|b| b.name == "origin/gone"));
    git_in(&bare, &["branch", "-D", "gone"]);
    let (cancel, out) = quiet();
    repo.fetch(&cancel, &out).unwrap();
    assert!(!repo.branches().unwrap().iter().any(|b| b.name == "origin/gone"));
}

#[test]
fn push_new_branch_sets_upstream_and_detached_head_cannot() {
    let (fx, _bare) = Fixture::with_origin();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    repo.create_branch("feature", None, true).unwrap();
    fx.write("f.txt", "f\n");
    fx.commit_all("feature");
    repo.push(false, true, &cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().upstream.as_deref(), Some("origin/feature"));

    fx.git(&["checkout", "-q", "--detach"]);
    let err = repo.push(false, true, &cancel, &out).unwrap_err();
    assert!(err.message.contains("detached"), "{}", err.message);
}

#[test]
fn branch_tips_are_reported() {
    let (fx, _bare) = Fixture::with_origin();
    let head = fx.head();
    let branches = fx.repo().branches().unwrap();
    assert!(branches.iter().all(|b| b.commit == head), "{branches:?}");
}

// ---------------------------------------------------------------------------
// Rollback

#[test]
fn rollback_newly_added_file() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.commit_all("base");
    fx.write("added.txt", "new\n");
    fx.git(&["add", "added.txt"]);
    let repo = fx.repo();
    // Rollback without "delete local copies": unstage only, the file stays (unversioned).
    repo.unstage(&[fx.path("added.txt")]).unwrap();
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "added.txt").unwrap().unstaged, Some(ChangeKind::Untracked));
    assert!(fx.exists("added.txt"));
    // With deletion.
    fx.git(&["add", "added.txt"]);
    repo.unstage(&[fx.path("added.txt")]).unwrap();
    repo.discard(&[fx.path("added.txt")]).unwrap();
    assert!(!fx.exists("added.txt"));
    assert!(repo.status().unwrap().is_empty());
}

#[test]
fn rollback_added_file_in_repository_without_commits() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.git(&["add", "a.txt"]);
    let repo = fx.repo();
    repo.unstage(&[fx.path("a.txt")]).unwrap();
    assert_eq!(status_of(&repo.status().unwrap(), "a.txt").unwrap().unstaged, Some(ChangeKind::Untracked));
}

#[test]
fn rollback_staged_rename_restores_the_old_file() {
    let fx = Fixture::new();
    fx.write("old.txt", "content\nline 2\nline 3\n");
    fx.commit_all("base");
    fx.git(&["mv", "old.txt", "new.txt"]);
    let repo = fx.repo();
    let st = repo.status().unwrap();
    let renamed = status_of(&st, "new.txt").unwrap();
    assert_eq!(renamed.staged, Some(ChangeKind::Renamed));
    assert_eq!(renamed.renamed_from.as_deref(), Some("old.txt"));
    // The UI rolls back both sides of a rename.
    repo.unstage(&[fx.path("new.txt"), fx.path("old.txt")]).unwrap();
    repo.discard(&[fx.path("new.txt"), fx.path("old.txt")]).unwrap();
    assert_eq!(fx.read("old.txt"), "content\nline 2\nline 3\n");
    assert!(!fx.exists("new.txt"));
    assert!(repo.status().unwrap().is_empty(), "{:?}", repo.status().unwrap());
}

#[test]
fn rollback_conflicted_file_restores_head() {
    let fx = Fixture::new();
    fx.write("f.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "topic"]);
    fx.write("f.txt", "topic\n");
    fx.write("theirs-only.txt", "t\n");
    fx.commit_all("topic");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("f.txt", "main\n");
    fx.commit_all("main");
    let repo = fx.repo();
    assert!(repo.merge("topic").is_err());
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "f.txt").unwrap().unstaged, Some(ChangeKind::Conflicted));
    repo.discard(&[fx.path("f.txt")]).unwrap();
    assert_eq!(fx.read("f.txt"), "main\n");
    let st = repo.status().unwrap();
    assert!(status_of(&st, "f.txt").is_none(), "{st:?}");
    // Still merging (theirs-only.txt staged); the merge can be aborted.
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("merge"));
}

#[test]
fn rollback_hunk_via_partial_patch_leaves_other_hunks() {
    let fx = Fixture::new();
    let original: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    fx.write("f.txt", &original);
    fx.commit_all("base");
    let edited = original.replace("line 2\n", "line two\n").replace("line 28\n", "line twenty-eight\n");
    fx.write("f.txt", &edited);
    // Stage only the first hunk, then discard the unstaged rest: the first hunk survives.
    let hunks = diff_hunks(&original, &edited);
    assert_eq!(hunks.len(), 2);
    let patch = build_partial_patch("f.txt", &original, &edited, &[0]);
    let repo = fx.repo();
    repo.stage_patch(&patch, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    repo.discard(&[fx.path("f.txt")]).unwrap();
    assert_eq!(fx.read("f.txt"), original.replace("line 2\n", "line two\n"));
}

// ---------------------------------------------------------------------------
// Branches

#[test]
fn branch_create_checkout_merge_rebase_delete() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let base = fx.commit_all("base");
    let repo = fx.repo();

    // Create without checkout, from an explicit start point.
    repo.create_branch("topic", Some(&base), false).unwrap();
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));
    assert!(repo.create_branch("bad name", None, false).is_err());
    assert!(repo.create_branch("topic", None, false).is_err(), "duplicate");
    assert!(repo.create_branch("-x", None, false).is_err());

    repo.checkout("topic", false).unwrap();
    fx.write("t.txt", "t\n");
    fx.commit_all("topic work");
    repo.checkout("main", false).unwrap();
    fx.write("m.txt", "m\n");
    fx.commit_all("main work");

    // Merge with a dirty working tree: local changes are kept.
    fx.write("a.txt", "dirty\n");
    repo.merge("topic").unwrap();
    assert!(fx.exists("t.txt"));
    assert_eq!(fx.read("a.txt"), "dirty\n");

    // Rebase onto with a dirty working tree.
    repo.checkout("topic", false).unwrap();
    repo.rebase("main~1").unwrap();
    assert_eq!(fx.read("a.txt"), "dirty\n");
    assert!(repo.rebase("--exec=true").is_err(), "options must not be injected");

    // -d refuses an unmerged branch, -D forces.
    repo.checkout("main", false).unwrap();
    repo.create_branch("unmerged", None, true).unwrap();
    fx.git(&["stash", "-q"]);
    fx.write("u.txt", "u\n");
    fx.commit_all("unmerged work");
    repo.checkout("main", false).unwrap();
    let err = repo.delete_branch("unmerged", false).unwrap_err();
    assert!(err.message.contains("not fully merged"), "{}", err.message);
    repo.delete_branch("unmerged", true).unwrap();
    assert!(!repo.branches().unwrap().iter().any(|b| b.name == "unmerged"));
}

#[test]
fn new_branch_from_remote_branch_tracks_it() {
    let (fx, _bare) = Fixture::with_origin();
    fx.git(&["push", "-q", "origin", "main:release"]);
    fx.git(&["fetch", "-q"]);
    let repo = fx.repo();
    repo.create_branch("my-release", Some("origin/release"), true).unwrap();
    let info = repo.branch_info().unwrap();
    assert_eq!(info.head.as_deref(), Some("my-release"));
    assert_eq!(info.upstream.as_deref(), Some("origin/release"));
}

#[test]
fn rebase_onto_conflict_leaves_rebase_in_progress() {
    let fx = Fixture::new();
    fx.write("f.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "topic"]);
    fx.write("f.txt", "topic\n");
    fx.commit_all("topic");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("f.txt", "main\n");
    fx.commit_all("main");
    fx.git(&["checkout", "-q", "topic"]);
    let repo = fx.repo();
    let err = repo.rebase("main").unwrap_err();
    assert!(err.message.contains("CONFLICT") || err.message.contains("conflict"), "{}", err.message);
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    let (cancel, out) = quiet();
    repo.abort_operation(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.read("f.txt"), "topic\n");
}

#[test]
fn detached_head_checkout_and_commit() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let base = fx.commit_all("base");
    fx.write("a.txt", "2\n");
    fx.commit_all("second");
    let repo = fx.repo();
    repo.checkout(&base, false).unwrap();
    let info = repo.branch_info().unwrap();
    assert_eq!(info.head, None);
    assert_eq!(info.head_commit.as_deref(), Some(base.as_str()));
    fx.write("a.txt", "detached\n");
    repo.stage(&[fx.path("a.txt")]).unwrap();
    let id = repo.commit("on detached head", false, false).unwrap();
    assert_eq!(fx.head(), id);
    // A branch can be created from the detached commit.
    repo.create_branch("rescue", None, true).unwrap();
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("rescue"));
}

// ---------------------------------------------------------------------------
// Add to VCS, annotate, diffs, history

#[test]
fn add_to_vcs_annotate_and_history() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n2\n");
    let first = fx.commit_all("first");
    fx.write("a.txt", "1\nchanged\n");
    let second = fx.commit_all("second");
    fx.write("new/b.txt", "b\n");
    let repo = fx.repo();
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "new/b.txt").unwrap().unstaged, Some(ChangeKind::Untracked));
    repo.stage(&[fx.path("new/b.txt")]).unwrap();
    assert_eq!(status_of(&repo.status().unwrap(), "new/b.txt").unwrap().staged, Some(ChangeKind::Added));

    let blame = repo.blame(&fx.path("a.txt"), Some("1\nchanged\nunsaved\n"), encoding_rs::UTF_8).unwrap();
    assert_eq!(blame.len(), 3);
    assert_eq!(blame[0].commit, first);
    assert_eq!(blame[1].commit, second);
    assert_eq!(blame[2].author, "Not Committed Yet");

    let history = repo.log(&LogQuery { path: Some(fx.path("a.txt").into()), ..Default::default() }).unwrap();
    assert_eq!(history.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec![second.as_str(), first.as_str()]);
    assert_eq!(repo.file_at(&fx.path("a.txt"), Some(&first), encoding_rs::UTF_8).unwrap().as_deref(), Some("1\n2\n"));
    let diff = repo.diff_text(&fx.path("new/b.txt"), true, encoding_rs::UTF_8).unwrap();
    assert!(diff.contains("+b"), "{diff}");
}

#[test]
fn compare_with_branch_lists_files() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "other"]);
    fx.write("a.txt", "other\n");
    fx.write("o.txt", "o\n");
    fx.commit_all("other");
    fx.git(&["checkout", "-q", "main"]);
    let files = fx.repo().diff_with_worktree("other").unwrap();
    let names: Vec<(&str, ChangeKind)> = files.iter().map(|f| (f.path.as_str(), f.kind)).collect();
    // Relative to `other`, the working tree lacks o.txt and has a different a.txt.
    assert_eq!(names, vec![("a.txt", ChangeKind::Modified), ("o.txt", ChangeKind::Deleted)]);
}

// ---------------------------------------------------------------------------
// Shelve, cherry-pick, revert

#[test]
fn shelve_and_unshelve_new_and_modified_files() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.commit_all("base");
    fx.write("a.txt", "changed\n");
    fx.write("n.txt", "new\n");
    fx.git(&["add", "n.txt"]);
    let shelf = fx.tmp.path().join("shelf");
    let repo = fx.repo();
    let list = repo.shelve(&shelf, "wip", &[fx.path("a.txt"), fx.path("n.txt")]).unwrap();
    assert_eq!(list.files.len(), 2);
    assert_eq!(fx.read("a.txt"), "1\n");
    assert!(!fx.exists("n.txt"));
    assert!(repo.status().unwrap().is_empty());
    let outcome = repo.unshelve(&shelf, &list.id, true).unwrap();
    assert!(outcome.conflicts.is_empty());
    assert_eq!(fx.read("a.txt"), "changed\n");
    assert_eq!(fx.read("n.txt"), "new\n");
    assert!(shelf::list(&shelf).unwrap().is_empty());
}

#[test]
fn cherry_pick_and_revert_refuse_merge_commits() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "topic"]);
    fx.write("t.txt", "t\n");
    fx.commit_all("topic");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("m.txt", "m\n");
    fx.commit_all("main");
    fx.git(&["merge", "-q", "--no-edit", "topic"]);
    let merge = fx.head();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let err = repo.revert(std::slice::from_ref(&merge), &cancel, &out).unwrap_err();
    assert!(err.message.contains("merge commit"), "{}", err.message);
    let err = repo.cherry_pick(std::slice::from_ref(&merge), &cancel, &out).unwrap_err();
    assert!(err.message.contains("merge commit"), "{}", err.message);
    assert_eq!(repo.branch_info().unwrap().operation, None);
}

#[test]
fn remote_progress_is_streamed() {
    let (fx, _bare) = Fixture::with_origin();
    fx.write("x.txt", "x\n");
    fx.commit_all("x");
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = lines.clone();
    fx.repo().push(false, false, &CancellationToken::new(), &move |l| sink.lock().unwrap().push(l)).unwrap();
    assert!(!lines.lock().unwrap().is_empty());
}
