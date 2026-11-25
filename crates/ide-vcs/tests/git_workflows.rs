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
            let (bare, other_dir) = (bare.to_str().unwrap(), other.to_str().unwrap());
            git_in(self.tmp.path(), &["clone", "-q", "-c", "core.autocrlf=false", bare, other_dir]);
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
    /// The repository of a trusted project.
    fn repo(&self) -> Repo {
        let repo = Repo::discover(&self.dir).unwrap().expect("repository found");
        repo.set_execution_allowed(true);
        repo
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
}

fn quiet() -> (CancellationToken, impl Fn(String)) {
    (CancellationToken::new(), |_line: String| {})
}

#[test]
fn not_cherry_picked_matches_patch_and_manual_resolutions() {
    let fx = Fixture::new();
    fx.write("base.txt", "base\n");
    fx.commit_all("shared");
    fx.git(&["switch", "-qc", "release"]);
    fx.write("equivalent.txt", "unchanged patch\n");
    let equivalent = fx.commit_all("patch match");
    fx.write("origin.txt", "original patch\n");
    let origin = fx.commit_all("recorded pick");
    fx.write("metadata.txt", "source patch\n");
    let metadata = fx.commit_all("metadata match");
    fx.write("waiting.txt", "to pick\n");
    let waiting = fx.commit_all("still waiting");
    fx.git(&["switch", "-q", "main"]);
    fx.write("main.txt", "main only\n");
    fx.commit_all("different history");
    fx.git(&["cherry-pick", &equivalent]);
    fx.write("origin.txt", "resolved differently\n");
    fx.commit_all(&format!("Conflict resolution\n\n(cherry picked from commit {origin})"));
    fx.write("metadata.txt", "other conflict resolution\n");
    fx.git(&["add", "metadata.txt"]);
    fx.git(&["commit", "-C", &metadata]);
    fx.git(&["tag", "release", "HEAD"]);

    let repo = fx.repo();
    repo.set_execution_allowed(false);
    let cancel = CancellationToken::new();
    assert_eq!(repo.not_cherry_picked("release", "HEAD", &cancel).unwrap(), Some(vec![waiting]));
    assert_eq!(repo.not_cherry_picked("HEAD", "HEAD", &cancel).unwrap(), Some(vec![]));
    assert_eq!(repo.not_cherry_picked("missing", "HEAD", &cancel).unwrap(), None);
    cancel.cancel();
    assert!(repo.not_cherry_picked("release", "HEAD", &cancel).is_err());
}

#[test]
fn checkout_and_rebase_restores_staged_and_unstaged_changes_after_conflict() {
    let fx = Fixture::new();
    fx.write("shared.txt", "base\n");
    fx.write("staged.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["switch", "-qc", "feature"]);
    fx.write("shared.txt", "feature\n");
    let feature = fx.commit_all("feature");
    fx.git(&["switch", "-q", "main"]);
    fx.write("shared.txt", "main\n");
    let main = fx.commit_all("main");
    fx.git(&["tag", "feature", &main]);
    fx.write("shared.txt", "working edit\n");
    fx.write("staged.txt", "staged edit\n");
    fx.git(&["add", "staged.txt"]);
    fx.write("untracked.txt", "untracked edit\n");

    let plan = CheckoutRebasePlan {
        base: HistoryTip { branch: Some("main".into()), commit: main.clone() },
        branch: "feature".into(),
        branch_tip: Some(feature),
        remote: None,
    };
    let repo = fx.repo();
    let (cancel, out) = quiet();
    assert!(repo.checkout_rebase(&plan, &cancel, &out).is_err());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    assert_eq!(fx.git(&["show", ":2:shared.txt"]), "main");
    assert_eq!(fx.git(&["show", ":3:shared.txt"]), "feature");
    assert_eq!(fx.read("staged.txt"), "base\n");
    assert_eq!(fx.read("untracked.txt"), "untracked edit\n");
    assert!(fx.exists(".git/openidea-saved-changes"));
    let stash = repo.stashes().unwrap().remove(0);
    fx.write(".git/openidea-saved-changes", &stash.id);

    repo.skip_operation(&cancel, &out).unwrap();
    assert_eq!(fx.git(&["branch", "--show-current"]), "feature");
    assert_eq!(fx.head(), main);
    assert_eq!(fx.git(&["rev-parse", "refs/heads/main"]), main);
    assert_eq!(fx.git(&["show", ":staged.txt"]), "staged edit");
    assert_eq!(fx.git(&["show", ":shared.txt"]), "main");
    assert_eq!(fx.read("shared.txt"), "working edit\n");
    assert_eq!(fx.read("untracked.txt"), "untracked edit\n");
    assert!(!fx.exists(".git/openidea-saved-changes"));
    assert!(fx.git(&["stash", "list"]).is_empty());
}

#[test]
fn checkout_and_rebase_remote_checks_the_confirmed_refs_before_resetting() {
    let (fx, _) = Fixture::with_origin();
    fx.git(&["config", "branch.autoSetupMerge", "true"]);
    fx.git(&["switch", "-qc", "remote"]);
    fx.write("remote.txt", "remote\n");
    let remote = fx.commit_all("remote");
    fx.git(&["push", "-qu", "origin", "HEAD:refs/heads/topic"]);
    fx.git(&["switch", "-qc", "topic", "--no-track", "HEAD~"]);
    fx.write("topic.txt", "local\n");
    let local = fx.commit_all("local");
    fx.git(&["switch", "-q", "main"]);
    fx.write("main.txt", "main\n");
    let main = fx.commit_all("main");
    fx.write("remote.txt", "untracked\n");

    let plan = CheckoutRebasePlan {
        base: HistoryTip { branch: Some("main".into()), commit: main.clone() },
        branch: "topic".into(),
        branch_tip: Some(local.clone()),
        remote: Some(CheckoutRebaseRemote {
            name: "origin/topic".into(),
            commit: remote.clone(),
            drop_local_commits: true,
        }),
    };
    let repo = fx.repo();
    let (cancel, out) = quiet();
    fx.git(&["branch", "-f", "topic", &main]);
    let err = repo.checkout_rebase(&plan, &cancel, &out).unwrap_err();
    assert!(err.message.contains("a branch changed"));
    assert_eq!(fx.git(&["rev-parse", "refs/heads/topic"]), main);

    fx.git(&["branch", "-f", "topic", &local]);
    assert!(repo.checkout_rebase(&plan, &cancel, &out).is_err(), "untracked file prevents switching");
    assert_eq!(fx.git(&["rev-parse", "refs/heads/topic"]), local);
    assert_eq!(fx.git(&["branch", "--show-current"]), "main");
    assert_eq!(fx.read("remote.txt"), "untracked\n");

    std::fs::remove_file(fx.path("remote.txt")).unwrap();
    repo.checkout_rebase(&plan, &cancel, &out).unwrap();
    assert_eq!(fx.git(&["branch", "--show-current"]), "topic");
    assert_eq!(fx.git(&["rev-parse", "HEAD^"]), main);
    assert_eq!(fx.git(&["rev-parse", "refs/remotes/origin/topic"]), remote);
    assert_eq!(fx.git(&["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/topic");
    assert_eq!(fx.read("remote.txt"), "remote\n");
    assert!(!fx.exists("topic.txt"));
}

#[test]
fn checkout_and_rebase_keeps_a_divergent_local_branch_and_can_restore_the_checkout() {
    let (fx, _) = Fixture::with_origin();
    fx.git(&["switch", "-qc", "remote"]);
    fx.write("remote.txt", "remote\n");
    let remote = fx.commit_all("remote work");
    fx.git(&["push", "-q", "origin", "HEAD:refs/heads/topic"]);
    fx.git(&["switch", "-qc", "topic", "HEAD~"]);
    fx.write("topic.txt", "local\n");
    let local = fx.commit_all("local work");
    fx.git(&["branch", "--set-upstream-to=origin/topic"]);
    fx.git(&["switch", "-q", "main"]);
    fx.write("main.txt", "main\n");
    let main = fx.commit_all("main work");
    fx.git(&["tag", "topic", &main]);
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let plan = CheckoutRebasePlan {
        base: HistoryTip { branch: Some("main".into()), commit: main.clone() },
        branch: "topic".into(),
        branch_tip: Some(local.clone()),
        remote: Some(CheckoutRebaseRemote { name: "origin/topic".into(), commit: remote, drop_local_commits: false }),
    };

    let rebased = repo.checkout_rebase(&plan, &cancel, &out).unwrap();
    assert_eq!(rebased.branch.as_deref(), Some("topic"));
    assert_eq!(rebased.commit, fx.head());
    assert_eq!(fx.git(&["rev-parse", "HEAD^"]), main);
    assert_eq!(fx.read("topic.txt"), "local\n");
    assert!(!fx.exists("remote.txt"));
    assert_eq!(fx.git(&["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/topic");

    assert!(repo.restore_rebase_checkout(&local, &local, "topic", &plan.base).is_err());
    fx.git(&["branch", "-f", "main", &local]);
    assert!(repo.restore_rebase_checkout(&local, &rebased.commit, "topic", &plan.base).is_err());
    assert_eq!(fx.head(), rebased.commit);
    fx.git(&["branch", "-f", "main", &main]);
    fx.write("main.txt", "local after rebase\n");
    fx.git(&["add", "main.txt"]);
    repo.restore_rebase_checkout(&local, &rebased.commit, "topic", &plan.base).unwrap();
    assert_eq!(fx.git(&["branch", "--show-current"]), "main");
    assert_eq!(fx.head(), main);
    assert_eq!(fx.git(&["rev-parse", "refs/heads/topic"]), local);
    assert_eq!(fx.git(&["show", ":main.txt"]), "local after rebase");
}

#[test]
fn checkout_and_rebase_creates_a_tracking_branch_under_the_chosen_name() {
    let (fx, _) = Fixture::with_origin();
    fx.git(&["config", "branch.autoSetupMerge", "true"]);
    let main = fx.head();
    fx.git(&["switch", "--detach"]);
    let (cancel, out) = quiet();
    let repo = fx.repo();
    let plan = CheckoutRebasePlan {
        base: HistoryTip { branch: None, commit: main.clone() },
        branch: "review".into(),
        branch_tip: None,
        remote: Some(CheckoutRebaseRemote { name: "origin/main".into(), commit: main, drop_local_commits: false }),
    };
    let rebased = repo.checkout_rebase(&plan, &cancel, &out).unwrap();
    assert_eq!(fx.git(&["branch", "--show-current"]), "review");
    assert_eq!(fx.git(&["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/main");
    repo.restore_rebase_checkout(&rebased.commit, &rebased.commit, "review", &plan.base).unwrap();
    assert!(fx.git(&["branch", "--show-current"]).is_empty());
    assert_eq!(fx.head(), plan.base.commit);
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
fn interactive_rebase_reword_keeps_lines_starting_with_a_hash() {
    let (fx, ids) = linear();
    let (cancel, out) = quiet();
    let message = "Subject\n\n#body starting with a hash";
    fx.repo()
        .interactive_rebase(Some(&ids[2]), &[entry(&ids[3], RebaseAction::Reword, Some(message))], &cancel, &out)
        .unwrap();
    assert_eq!(fx.git(&["log", "-1", "--format=%B"]), message);
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
fn interactive_rebase_amends_the_message_after_the_last_fixup() {
    let (fx, ids) = linear();
    let (cancel, out) = quiet();
    let message = "Combined commits\n\n# Details";
    fx.repo()
        .interactive_rebase(
            Some(&ids[0]),
            &[
                entry(&ids[1], RebaseAction::Pick, None),
                entry(&ids[2], RebaseAction::Fixup, None),
                entry(&ids[3], RebaseAction::Fixup, Some(message)),
            ],
            &cancel,
            &out,
        )
        .unwrap();
    assert_eq!(fx.git(&["log", "-1", "--format=%B"]), message);
    assert_eq!(fx.git(&["show", "--format=", "--name-only", "HEAD"]), "f2.txt\nf3.txt\nf4.txt");
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

/// `main` and `feature` both change `c.txt`: rebasing feature onto main stops on it.
fn rebase_stopped_on_a_conflict() -> (Fixture, Repo) {
    let fx = Fixture::new();
    fx.write("c.txt", "base\n");
    fx.write("other.txt", "other\n");
    fx.commit_all("base");
    fx.git(&["switch", "-q", "-c", "feature"]);
    fx.write("c.txt", "feature\n");
    fx.commit_all("feature change");
    fx.git(&["switch", "-q", "main"]);
    fx.write("c.txt", "main\n");
    fx.commit_all("main change");
    fx.git(&["switch", "-q", "feature"]);
    let repo = fx.repo();
    assert!(repo.rebase("main").is_err());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    (fx, repo)
}

#[test]
fn edits_of_a_resolved_file_go_with_it_when_the_rebase_continues() {
    let (fx, repo) = rebase_stopped_on_a_conflict();
    fx.write("c.txt", "resolved\n");
    repo.stage(&[fx.path("c.txt")]).unwrap();
    fx.write("c.txt", "resolved\nmore\n");
    let (cancel, out) = quiet();
    repo.continue_operation(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["show", "HEAD:c.txt"]), "resolved\nmore");
}

#[test]
fn unstaged_changes_of_other_files_stop_the_rebase_until_staged() {
    let (fx, repo) = rebase_stopped_on_a_conflict();
    fx.write("c.txt", "resolved\n");
    repo.stage(&[fx.path("c.txt")]).unwrap();
    fx.write("other.txt", "changed while stopped\n");
    let (cancel, out) = quiet();
    let err = repo.continue_operation(&cancel, &out).unwrap_err();
    assert_eq!(err.message, UNSTAGED_CHANGES_PREVENT_REBASE);
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    repo.stage_and_continue(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["show", "HEAD:other.txt"]), "changed while stopped");
}

#[test]
fn stage_and_retry_after_editing_a_commit() {
    let (fx, ids) = linear();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let plan = [entry(&ids[2], RebaseAction::Edit, None), entry(&ids[3], RebaseAction::Pick, None)];
    repo.interactive_rebase(Some(&ids[1]), &plan, &cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    fx.write("f1.txt", "edited\n");
    std::fs::remove_file(fx.path("f2.txt")).unwrap();
    assert!(repo.continue_operation(&cancel, &out).is_err());
    repo.stage_and_continue(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["status", "--porcelain"]), "");
    assert!(!fx.exists("f2.txt"));
}

#[test]
fn rebase_and_merge_onto_a_branch_named_like_a_tag_use_the_branch() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.commit_all("base");
    fx.git(&["tag", "main"]);
    fx.write("m.txt", "m\n");
    let tip = fx.commit_all("main moved on");
    fx.git(&["switch", "-q", "-c", "feature", "HEAD~1"]);
    fx.write("f.txt", "f\n");
    fx.commit_all("feature");
    let repo = fx.repo();
    repo.rebase("refs/heads/main").unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD~1"]), tip);
    fx.git(&["reset", "-q", "--hard", "HEAD~1"]);
    fx.git(&["switch", "-q", "-c", "other", "refs/heads/main~1"]);
    repo.merge("refs/heads/main").unwrap();
    assert_eq!(fx.head(), tip, "fast-forwarded to the branch, not the tag");
}

#[test]
fn merge_and_rebase_record_the_branch_name_git_would_show() {
    let (fx, _bare) = Fixture::with_origin();
    fx.git(&["switch", "-q", "-c", "topic"]);
    fx.write("t.txt", "t\n");
    fx.commit_all("topic");
    fx.git(&["push", "-q", "origin", "topic"]);
    fx.git(&["switch", "-q", "main"]);
    fx.write("m.txt", "m\n");
    fx.commit_all("main");
    let repo = fx.repo();
    let subject = || fx.git(&["log", "-1", "--format=%s"]);

    repo.merge("refs/heads/topic").unwrap();
    assert_eq!(subject(), "Merge branch 'topic'");
    fx.git(&["reset", "-q", "--hard", "HEAD~1"]);
    repo.merge("refs/remotes/origin/topic").unwrap();
    assert_eq!(subject(), "Merge remote-tracking branch 'origin/topic'");
    fx.git(&["reset", "-q", "--hard", "HEAD~1"]);

    repo.rebase("refs/heads/topic").unwrap();
    let reflog = fx.git(&["reflog", "--format=%gs"]);
    assert!(reflog.contains("rebase (start): checkout topic"), "{reflog}");
    fx.git(&["reset", "-q", "--hard", "ORIG_HEAD"]);

    // A tag of the same name makes the short name ambiguous: the full ref stays.
    fx.git(&["tag", "topic", "main~1"]);
    repo.merge("refs/heads/topic").unwrap();
    assert_eq!(subject(), "Merge branch 'refs/heads/topic'");
}

#[test]
fn interactive_rebase_edit_stops_for_amend() {
    let (fx, ids) = linear();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    assert!(!repo.is_interactive_rebase());
    repo.interactive_rebase(
        Some(&ids[1]),
        &[entry(&ids[2], RebaseAction::Edit, None), entry(&ids[3], RebaseAction::Pick, None)],
        &cancel,
        &out,
    )
    .unwrap();
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    assert!(repo.is_interactive_rebase());
    fx.write("f3.txt", "edited\n");
    repo.stage(&[fx.path("f3.txt")]).unwrap();
    repo.commit("", true, false).unwrap();
    repo.continue_operation(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert!(!repo.is_interactive_rebase());
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
fn update_with_rebase_keeps_a_file_added_then_deleted_added_to_the_index() {
    let (fx, bare) = Fixture::with_origin();
    fx.push_from_other(&bare, "remote.txt", "r\n");
    fx.write("local.txt", "l\n");
    fx.commit_all("local");
    fx.write("ad.txt", "x\n");
    fx.git(&["add", "ad.txt"]);
    std::fs::remove_file(fx.path("ad.txt")).unwrap();
    let (cancel, out) = quiet();
    fx.repo().pull(true, &cancel, &out).unwrap();
    assert!(fx.exists("remote.txt"));
    assert!(fx.git(&["status", "--porcelain", "--", "ad.txt"]).starts_with('A'), "still added");
}

/// Submodules `dirty` and `moved` (each with commits "one" and "two", at "two") committed in
/// the clone of [`Fixture::with_origin`] and pushed; then `dirty` gets an uncommitted edit of a
/// tracked file plus an untracked file, and `moved` is checked out at "one". Returns the commit
/// the superproject records for `moved`.
fn with_changed_submodules(fx: &Fixture) -> String {
    for name in ["dirty", "moved"] {
        let lib = fx.tmp.path().join(format!("lib-{name}"));
        std::fs::create_dir(&lib).unwrap();
        git_in(&lib, &["init", "-q"]);
        configure(&lib);
        std::fs::write(lib.join("f.txt"), "one\n").unwrap();
        git_in(&lib, &["add", "-A"]);
        git_in(&lib, &["commit", "-q", "-m", "one"]);
        std::fs::write(lib.join("f.txt"), "two\n").unwrap();
        git_in(&lib, &["commit", "-q", "-am", "two"]);
        let url = lib.to_str().unwrap();
        fx.git(&["-c", "protocol.file.allow=always", "-c", "core.autocrlf=false", "submodule", "add", "-q", url, name]);
        configure(&fx.path(name));
    }
    fx.commit_all("submodules");
    fx.git(&["push", "-q", "origin", "main"]);
    let recorded = git_in(&fx.path("moved"), &["rev-parse", "HEAD"]);
    fx.write("dirty/f.txt", "edited\n");
    fx.write("dirty/untracked.txt", "u\n");
    git_in(&fx.path("moved"), &["checkout", "-q", "HEAD~1"]);
    recorded
}

/// git lists submodules at another commit or with changes inside among the superproject's
/// changes, but its stash leaves them in place, so Update Project has nothing to put aside (#3632).
#[test]
fn update_with_changed_submodules_and_no_other_local_changes() {
    for (rebase, earlier_stash) in [(false, false), (false, true), (true, false), (true, true)] {
        let (fx, bare) = Fixture::with_origin();
        let recorded = with_changed_submodules(&fx);
        if earlier_stash {
            fx.write("a.txt", "stashed\n");
            fx.git(&["stash", "push", "-q", "-m", "earlier"]);
        }
        fx.push_from_other(&bare, "remote.txt", "r\n");
        let repo = fx.repo();
        let (cancel, out) = quiet();
        repo.pull(rebase, &cancel, &out).unwrap_or_else(|e| panic!("rebase={rebase} stash={earlier_stash}: {e}"));
        assert!(fx.exists("remote.txt"));
        assert_eq!(fx.read("dirty/f.txt"), "edited\n");
        assert_ne!(git_in(&fx.path("moved"), &["rev-parse", "HEAD"]), recorded);
        let stashes = fx.git(&["stash", "list"]);
        assert_eq!(stashes.lines().count(), usize::from(earlier_stash), "{stashes}");
        assert!(!fx.dir.join(".git/openidea-saved-changes").exists());
    }
}

#[test]
fn rollback_changed_submodules_restores_the_recorded_commit_and_tracked_files() {
    for whole_root in [false, true] {
        let (fx, _bare) = Fixture::with_origin();
        let recorded = with_changed_submodules(&fx);
        let repo = fx.repo();
        let paths = if whole_root { vec![fx.dir.clone()] } else { vec![fx.path("dirty"), fx.path("moved")] };
        repo.discard(&paths).unwrap();
        assert_eq!(fx.read("dirty/f.txt"), "two\n", "whole_root={whole_root}");
        assert_eq!(git_in(&fx.path("moved"), &["rev-parse", "HEAD"]), recorded);
        assert_eq!(fx.read("dirty/untracked.txt"), "u\n", "untracked files of a submodule are kept");
        assert_eq!(fx.git(&["status", "--porcelain", "--ignore-submodules=untracked"]), "");
    }
}

#[test]
fn reset_to_the_remote_branch_drops_local_commits_and_keeps_local_changes() {
    let (fx, bare) = Fixture::with_origin();
    for i in 0..3 {
        fx.push_from_other(&bare, "bro.txt", &format!("bro {i}\n"));
    }
    fx.write("local1.txt", "1\n");
    fx.commit_all("local commit");
    fx.write("untracked.txt", "u\n");
    fx.write("a.txt", "edited\n");
    fx.git(&["add", "a.txt"]);
    let (cancel, out) = quiet();
    fx.repo().reset_to_upstream(&cancel, &out).unwrap();
    assert_eq!(fx.head(), fx.git(&["rev-parse", "origin/main"]));
    assert!(!fx.exists("local1.txt"), "files of local commits are gone");
    assert!(fx.exists("untracked.txt"));
    assert_eq!(fx.git(&["status", "--porcelain", "--", "a.txt"]), "M  a.txt", "staged changes stay staged");
    assert_eq!(fx.git(&["stash", "list"]), "");
}

#[test]
fn reset_to_the_remote_branch_without_new_remote_commits_drops_local_ones() {
    let (fx, _bare) = Fixture::with_origin();
    let before = fx.head();
    fx.write("local1.txt", "1\n");
    fx.commit_all("local commit");
    let (cancel, out) = quiet();
    fx.repo().reset_to_upstream(&cancel, &out).unwrap();
    assert_eq!(fx.head(), before);
}

#[test]
fn reset_to_the_remote_branch_leaves_conflicting_local_changes_to_resolve() {
    let (fx, bare) = Fixture::with_origin();
    fx.push_from_other(&bare, "bro.txt", "bro\n");
    fx.write("bro.txt", "local content\n");
    fx.git(&["add", "bro.txt"]);
    let (cancel, out) = quiet();
    assert!(fx.repo().reset_to_upstream(&cancel, &out).is_err());
    assert_eq!(fx.head(), fx.git(&["rev-parse", "origin/main"]));
    assert!(fx.read("bro.txt").contains("<<<<<<<"), "the clash is left to resolve");
    assert_eq!(fx.git(&["stash", "list"]).lines().count(), 1, "a copy stays in the stash");
}

#[test]
fn reset_to_the_remote_branch_needs_a_tracked_branch_that_exists() {
    let (fx, bare) = Fixture::with_origin();
    let (cancel, out) = quiet();
    fx.git(&["branch", "--unset-upstream"]);
    let err = fx.repo().reset_to_upstream(&cancel, &out).unwrap_err();
    assert!(err.message.contains("no tracked branch"), "{}", err.message);

    fx.git(&["push", "-q", "-u", "origin", "main:feature"]);
    fx.git(&["switch", "-q", "-c", "feature", "--track", "origin/feature"]);
    git_in(&bare, &["branch", "-D", "feature"]);
    fx.git(&["fetch", "-q", "--prune"]);
    let err = fx.repo().reset_to_upstream(&cancel, &out).unwrap_err();
    assert!(err.message.contains("no tracked branch"), "{}", err.message);
}

#[test]
fn fetching_one_remote_only_refreshes_its_tracking_branches() {
    let (fx, bare) = Fixture::with_origin();
    let head = fx.head();
    fx.git(&["remote", "add", "vendor/team", bare.to_str().unwrap()]);
    git_in(&bare, &["branch", "published-later", &head]);
    let (cancel, out) = quiet();
    let repo = fx.repo();
    repo.fetch_remote("vendor/team", &cancel, &out).unwrap();
    assert_eq!(fx.git(&["rev-parse", "vendor/team/published-later"]), head);
    assert!(!fx.git(&["branch", "-r"]).contains("origin/published-later"));
    assert_eq!(fx.head(), head);
    assert!(repo.fetch_remote("not-configured", &cancel, &out).is_err());
    // Git's remote command rejects overlapping names, but repositories can have them in config.
    fx.git(&["config", "remote.vendor.url", bare.to_str().unwrap()]);
    fx.git(&["config", "remote.vendor.fetch", "+refs/heads/*:refs/remotes/vendor/*"]);
    fx.git(&["config", "branch.main.remote", "vendor"]);
    fx.git(&["config", "branch.main.merge", "refs/heads/team/main"]);
    let info = repo.branch_info().unwrap();
    assert_eq!(info.upstream.as_deref(), Some("vendor/team/main"));
    let tracking = info.upstream_tracking.unwrap();
    assert_eq!((tracking.remote.as_str(), tracking.branch.as_str()), ("vendor", "team/main"));
}

#[test]
fn pull_from_without_a_mode_uses_the_repositorys_pull_config() {
    let (fx, bare) = Fixture::with_origin();
    fx.git(&["config", "pull.ff", "true"]);
    fx.write("local.txt", "local work");
    fx.commit_all("local");
    fx.push_from_other(&bare, "remote.txt", "remote work");
    let remote = git_in(&bare, &["rev-parse", "main"]);
    let (cancel, out) = quiet();
    fx.repo().pull_from("origin", &["main".into()], None, &MergeOptions::default(), &cancel, &out).unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD^"]), remote);
    assert_eq!(fx.subjects()[..2], ["local", "remote remote.txt"]);
}

#[test]
fn rebase_a_named_branch_from_root_updates_refs_and_preserves_changes() {
    let (fx, _) = Fixture::with_origin();
    let main = fx.head();
    fx.git(&["switch", "--orphan", "topic"]);
    fx.write("topic.txt", "root of topic");
    let old_root = fx.commit_all("Topic root");
    fx.git(&["branch", "bookmark"]);
    fx.write("next.txt", "next step");
    let old_tip = fx.commit_all("Topic tip");
    fx.git(&["switch", "main"]);
    fx.write("a.txt", "staged local changes");
    fx.git(&["add", "a.txt"]);
    fx.write("a.txt", "working copy changes");
    let repo = fx.repo();
    let options = RebaseOptions {
        onto: Some("refs/heads/main".into()),
        branch: Some("topic".into()),
        update_refs: true,
        autosquash: Some(false),
        ..Default::default()
    };
    repo.rebase_with(None, &options).unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "--short", "HEAD"]), "topic");
    assert_ne!(fx.head(), old_tip);
    assert_ne!(fx.git(&["rev-parse", "bookmark"]), old_root);
    assert_eq!(fx.git(&["rev-parse", "bookmark"]), fx.git(&["rev-parse", "HEAD^"]));
    assert_eq!(fx.git(&["rev-parse", "HEAD^^"]), main);
    assert_eq!(fx.git(&["rev-parse", "main"]), main);
    assert_eq!(fx.git(&["show", ":a.txt"]), "staged local changes");
    assert_eq!(fx.read("a.txt"), "working copy changes");
}

#[test]
fn interactive_rebase_edits_gits_merge_plan_and_commit_message() {
    let (fx, _) = Fixture::with_origin();
    fx.git(&["switch", "-c", "topic"]);
    fx.write("primary.txt", "primary");
    fx.commit_all("Primary change");
    fx.git(&["switch", "-c", "side"]);
    fx.write("side.txt", "side");
    fx.commit_all("Side change");
    fx.git(&["switch", "topic"]);
    fx.write("topic.txt", "topic");
    fx.commit_all("Topic change");
    fx.git(&["merge", "--no-ff", "-m", "Merge side", "side"]);
    fx.write("primary.txt", "fixed");
    let head = fx.commit_all("fixup! Primary change");
    fx.git(&["switch", "main"]);
    fx.write("upstream.txt", "upstream");
    let upstream = fx.commit_all("Upstream change");
    fx.git(&["switch", "topic"]);
    fx.write("local.txt", "staged");
    fx.git(&["add", "local.txt"]);
    fx.write("local.txt", "working");

    let repo = fx.repo();
    let options = RebaseOptions { rebase_merges: true, autosquash: Some(true), ..Default::default() };
    let (cancel, out) = quiet();
    let declined = repo.rebase_with_editor(Some("main"), &options, &cancel, &out, &|prompt| {
        assert!(matches!(prompt.kind, RebaseEditKind::Plan));
        None
    });
    assert!(matches!(declined, Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled));
    assert_eq!(fx.head(), head);
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["show", ":local.txt"]), "staged");
    assert_eq!(fx.read("local.txt"), "working");

    let abort_request = CancellationToken::new();
    let cancelled = repo.rebase_with_editor(Some("main"), &options, &abort_request, &out, &|_| {
        abort_request.cancel();
        None
    });
    assert!(matches!(cancelled, Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled));
    assert_eq!(fx.head(), head);
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["show", ":local.txt"]), "staged");

    let message_prompt = std::cell::Cell::new(false);
    repo.rebase_with_editor(Some("main"), &options, &cancel, &out, &|prompt| match prompt.kind {
        RebaseEditKind::Plan => {
            assert!(prompt.plan.is_none());
            for instruction in ["label ", "reset ", "merge -C ", "fixup "] {
                assert!(prompt.text.lines().any(|line| line.starts_with(instruction)), "missing {instruction}");
            }
            let primary =
                prompt.text.lines().find(|line| line.starts_with("pick ") && line.ends_with("Primary change")).unwrap();
            Some(prompt.text.replacen(primary, &primary.replacen("pick ", "reword ", 1), 1).into())
        }
        RebaseEditKind::Message => {
            assert!(prompt.text.starts_with("Primary change"));
            message_prompt.set(true);
            Some("Primary change with fixup\n\n# Markdown section\n".to_owned().into())
        }
    })
    .unwrap();
    assert!(message_prompt.get());
    assert_ne!(fx.head(), head);
    assert_eq!(fx.git(&["show", "-s", "--format=%P", "HEAD"]).split_whitespace().count(), 2);
    assert_eq!(fx.git(&["merge-base", "HEAD", "main"]), upstream);
    assert_eq!(fx.git(&["log", "--format=%s", "main..HEAD"]).lines().count(), 4);
    assert!(fx.subjects().iter().any(|subject| subject == "Primary change with fixup"));
    assert_eq!(
        fx.git(&["log", "--format=%b", "--fixed-strings", "--grep=Primary change with fixup", "-1"]),
        "# Markdown section"
    );
    assert_eq!(fx.read("primary.txt"), "fixed");
    assert_eq!(fx.git(&["show", ":local.txt"]), "staged");
    assert_eq!(fx.read("local.txt"), "working");
    assert_eq!(fx.git(&["stash", "list"]), "");
}

#[test]
fn interactive_rebase_resumes_with_git_message_editors_after_conflicts() {
    let (fx, _) = Fixture::with_origin();
    fx.git(&["switch", "-c", "topic"]);
    fx.write("a.txt", "topic\n");
    let original = fx.commit_all("Topic conflict\n\n# Markdown heading\n; Literal semicolon");
    fx.write("later.txt", "later\n");
    let later = fx.commit_all("Topic follow-up");
    fx.git(&["switch", "main"]);
    fx.write("a.txt", "upstream\n");
    fx.write("other.txt", "upstream\n");
    let upstream = fx.commit_all("Upstream conflict");
    fx.git(&["switch", "topic"]);
    fx.git(&["config", "rebase.abbreviateCommands", "true"]);
    fx.git(&["config", "core.commentChar", ";"]);
    fx.git(&["config", "commit.verbose", "true"]);

    let repo = fx.repo();
    let (cancel, out) = quiet();
    let start = || RebaseEditorOperation::Start { upstream: Some("main".into()), options: RebaseOptions::default() };
    let edit_plan = |prompt: RebaseEdit| {
        let plan = prompt.plan.unwrap();
        let [
            RebaseTodoRow::Commit { id: first_id, author, summary, .. },
            RebaseTodoRow::Commit { id: second_id, revision, message, action: RebaseAction::Pick, .. },
        ] = plan.as_slice()
        else {
            panic!("expected two commit rows");
        };
        assert_eq!(first_id, &original);
        assert_eq!(author, "Test User");
        assert_eq!(summary, "Topic conflict");
        assert_eq!(second_id, &later);
        assert_eq!(message, "Topic follow-up");
        assert!(prompt.text.lines().any(|line| line.starts_with(';')));
        assert!(!prompt.text.contains('\u{1}'));
        let entry = format!("p {revision}");
        assert!(prompt.text.contains(&entry));
        Some(prompt.text.replacen(&entry, &format!("r {revision}"), 1).into())
    };
    let stopped = repo.rebase_editor_operation(start(), &cancel, &out, &edit_plan);
    assert!(stopped.is_err());
    assert_eq!(repo.operation().unwrap().as_deref(), Some("rebase"));
    assert!(!fx.read(".git/rebase-merge/git-rebase-todo").contains('\u{1}'));
    fx.write("a.txt", "resolved\n");
    fx.git(&["add", "a.txt"]);
    let resume = RebaseEditorOperation::Continue { stage: false };
    let declined = repo.rebase_editor_operation(resume, &cancel, &out, &|prompt| {
        assert!(matches!(prompt.kind, RebaseEditKind::Message));
        assert!(prompt.text.starts_with("Topic conflict"));
        None
    });
    assert!(matches!(declined, Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled));
    assert_eq!(repo.operation().unwrap().as_deref(), Some("rebase"));
    assert_eq!(fx.git(&["show", ":a.txt"]), "resolved");

    fx.write("other.txt", "stage and retry\n");
    let resume = RebaseEditorOperation::Continue { stage: false };
    let refused = repo.rebase_editor_operation(resume, &cancel, &out, &|_| panic!("unexpected editor prompt"));
    assert!(matches!(refused, Err(e) if e.message == UNSTAGED_CHANGES_PREVENT_REBASE));

    let follow_up = std::cell::Cell::new(false);
    let resume = RebaseEditorOperation::Continue { stage: true };
    repo.rebase_editor_operation(resume, &cancel, &out, &|prompt| {
        assert!(matches!(prompt.kind, RebaseEditKind::Message));
        assert!(!prompt.text.contains('\u{1}') && !prompt.text.contains("diff --git"));
        assert!(!prompt.text.contains("Please enter the commit message"));
        if prompt.text.starts_with("Topic conflict") {
            assert!(prompt.text.contains("# Markdown heading\n; Literal semicolon"));
            Some(prompt.text.into())
        } else {
            assert!(prompt.text.starts_with("Topic follow-up"));
            follow_up.set(true);
            Some("Reworded follow-up\n".to_owned().into())
        }
    })
    .unwrap();
    assert!(follow_up.get());
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["rev-parse", "HEAD^^"]), upstream);
    assert_eq!(fx.git(&["log", "--format=%s", "main..HEAD"]), "Reworded follow-up\nTopic conflict");
    assert_eq!(fx.git(&["show", "-s", "--format=%b", "HEAD^"]), "# Markdown heading\n; Literal semicolon");
    assert_eq!(fx.read("a.txt"), "resolved\n");
    assert_eq!(fx.git(&["show", "HEAD^:other.txt"]), "stage and retry");

    fx.git(&["switch", "-c", "skip-conflict", &later]);
    assert!(repo.rebase_editor_operation(start(), &cancel, &out, &edit_plan).is_err());
    assert_eq!(repo.operation().unwrap().as_deref(), Some("rebase"));
    // An older stopped session already has todo comments written using the repository configuration.
    let pending = ".git/rebase-merge/git-rebase-todo";
    fx.write(pending, &format!("; Saved before the editor upgrade\n{}", fx.read(pending)));
    fx.write(".git/rebase-merge/openidea-editor", "{}");
    repo.rebase_editor_operation(RebaseEditorOperation::Skip, &cancel, &out, &|prompt| {
        assert!(matches!(prompt.kind, RebaseEditKind::Message));
        assert!(prompt.text.starts_with("Topic follow-up"));
        Some("Reworded after skip\n".to_owned().into())
    })
    .unwrap();
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["rev-parse", "HEAD^"]), upstream);
    assert_eq!(fx.git(&["log", "--format=%s", "main..HEAD"]), "Reworded after skip");
    assert_eq!(fx.read("a.txt"), "upstream\n");
    assert_eq!(fx.git(&["config", "--get", "core.commentChar"]), ";");
}

#[test]
fn interactive_rebase_remembers_inline_rewords_by_original_commit_across_conflicts() {
    let (fx, _) = Fixture::with_origin();
    fx.git(&["switch", "-c", "topic"]);
    fx.write("a.txt", "topic\n");
    fx.commit_all("Identical original message");
    fx.write("second.txt", "second\n");
    let second = fx.commit_all("Identical original message");
    fx.write("third.txt", "third\n");
    let third = fx.commit_all("Identical original message");
    fx.git(&["switch", "main"]);
    fx.write("a.txt", "upstream\n");
    fx.commit_all("Upstream conflict");
    fx.git(&["switch", "topic"]);
    fx.git(&["config", "core.commentString", "//"]);

    let (cancel, out) = quiet();
    let start = RebaseEditorOperation::Start { upstream: Some("main".into()), options: RebaseOptions::default() };
    let stopped = fx.repo().rebase_editor_operation(start, &cancel, &out, &|prompt| {
        let rows = prompt.plan.unwrap();
        let revisions: Vec<_> = rows
            .iter()
            .map(|row| match row {
                RebaseTodoRow::Commit { message, revision, .. } => {
                    assert_eq!(message, "Identical original message");
                    revision
                }
                _ => panic!("expected a commit row"),
            })
            .collect();
        assert_eq!(revisions.len(), 3);
        Some(RebaseEditorReply {
            text: format!("pick {}\nr {}\nreword {}\n", revisions[0], revisions[1], revisions[2]),
            rewords: [
                (second.clone(), "Second subject\n\n# Second body\n// Second literal prefix\n".into()),
                (third.clone(), "Third subject\n\n# Third body\n// Third literal prefix\n".into()),
            ]
            .into(),
        })
    });
    assert!(stopped.is_err());
    let repo = fx.repo();
    assert_eq!(repo.operation().unwrap().as_deref(), Some("rebase"));
    fx.write("a.txt", "resolved\n");
    fx.git(&["add", "a.txt"]);

    let prompts = std::cell::Cell::new(0);
    repo.rebase_editor_operation(RebaseEditorOperation::Continue { stage: false }, &cancel, &out, &|prompt| {
        prompts.set(prompts.get() + 1);
        assert_eq!(prompts.get(), 1);
        assert!(matches!(prompt.kind, RebaseEditKind::Message));
        assert!(prompt.text.starts_with("Identical original message"));
        Some("Manual conflict message\n".to_owned().into())
    })
    .unwrap();
    assert_eq!(prompts.get(), 1);
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.subjects()[..3], ["Third subject", "Second subject", "Manual conflict message"]);
    assert_eq!(
        fx.git(&["show", "-s", "--format=%B", "HEAD"]),
        "Third subject\n\n# Third body\n// Third literal prefix"
    );
    assert_eq!(
        fx.git(&["show", "-s", "--format=%B", "HEAD^"]),
        "Second subject\n\n# Second body\n// Second literal prefix"
    );
    assert!(!fx.exists(".git/rebase-merge/openidea-editor"));
}

#[test]
fn interactive_rebase_preserves_and_edits_autosquash_message_replacements() {
    let fx = Fixture::new();
    fx.git(&["config", "rebase.abbreviateCommands", "true"]);
    fx.write("base.txt", "base\n");
    let base = fx.commit_all("Base");
    fx.write("target.txt", "original\n");
    let target = fx.commit_all("Prepare review");
    fx.write("follow-up.txt", "follow-up\n");
    let follow_up = fx.commit_all("Add follow-up");
    fx.write("target.txt", "amended\n");
    let replacement = "Review ready\n\n# Replacement details";
    let amend = fx.commit_all(&format!("amend! Prepare review\n\n{replacement}"));
    fx.git(&["branch", "edit-message"]);
    let (cancel, out) = quiet();
    for edit_message in [false, true] {
        if edit_message {
            fx.git(&["switch", "edit-message"]);
        }
        let edited = "Review ready for submission\n\n# Updated details";
        let edited_message = std::cell::Cell::new(false);
        fx.repo()
            .rebase_with_editor(Some(&base), &RebaseOptions::default(), &cancel, &out, &|prompt| match prompt.kind {
                RebaseEditKind::Plan => {
                    let plan = prompt.plan.unwrap();
                    let [
                        RebaseTodoRow::Commit { id: first, .. },
                        RebaseTodoRow::Commit {
                            id: second,
                            action: RebaseAction::Fixup,
                            fixup_message: Some(RebaseFixupMessage::Replace),
                            ..
                        },
                        RebaseTodoRow::Commit { id: third, .. },
                    ] = plan.as_slice()
                    else {
                        panic!("expected Git's autosquashed plan");
                    };
                    assert_eq!([first, second, third], [&target, &amend, &follow_up]);
                    assert!(prompt.text.contains("\nf -C "));
                    let text = if edit_message { prompt.text.replace("\nf -C ", "\nf -c ") } else { prompt.text };
                    Some(text.into())
                }
                RebaseEditKind::Message => {
                    assert!(edit_message);
                    assert_eq!(prompt.text.trim(), replacement);
                    assert!(!edited_message.replace(true));
                    Some(format!("{edited}\n").into())
                }
            })
            .unwrap();
        assert_eq!(edited_message.get(), edit_message);
        assert_eq!(fx.git(&["show", "-s", "--format=%s", "HEAD"]), "Add follow-up");
        assert_eq!(fx.git(&["show", "-s", "--format=%B", "HEAD^"]), if edit_message { edited } else { replacement });
        assert_eq!(fx.git(&["show", "HEAD^:target.txt"]), "amended");
        assert_eq!(fx.repo().operation().unwrap(), None);
    }
}

#[test]
fn interactive_rebase_can_move_a_branch_update_in_the_structured_plan() {
    let (fx, _) = Fixture::with_origin();
    fx.git(&["config", "rebase.abbreviateCommands", "true"]);
    fx.git(&["switch", "-c", "topic"]);
    fx.write("first.txt", "first\n");
    let original = fx.commit_all("First change");
    fx.git(&["branch", "review"]);
    fx.write("second.txt", "second\n");
    fx.commit_all("Second change");
    fx.git(&["switch", "main"]);
    fx.write("upstream.txt", "upstream\n");
    let upstream = fx.commit_all("Advance base");
    fx.git(&["switch", "topic"]);
    let start = RebaseEditorOperation::Start {
        upstream: Some("main".into()),
        options: RebaseOptions { update_refs: true, ..RebaseOptions::default() },
    };
    let (cancel, out) = quiet();
    fx.repo()
        .rebase_editor_operation(start, &cancel, &out, &|prompt| {
            let plan = prompt.plan.unwrap();
            let [
                RebaseTodoRow::Commit { line: first, id, .. },
                RebaseTodoRow::UpdateRef { line: update, reference },
                RebaseTodoRow::Commit { line: second, .. },
            ] = plan.as_slice()
            else {
                panic!("expected two commits and one ref update");
            };
            assert_eq!(id, &original);
            assert_eq!(reference, "refs/heads/review");
            let lines: Vec<_> = prompt.text.lines().collect();
            assert_eq!(lines[*update], "u refs/heads/review");
            Some(format!("{}\n{}\n{}\n", lines[*first], lines[*second], lines[*update]).into())
        })
        .unwrap();
    assert_eq!(fx.git(&["rev-parse", "review"]), fx.git(&["rev-parse", "topic"]));
    assert_ne!(fx.git(&["rev-parse", "review"]), original);
    assert_eq!(fx.git(&["rev-parse", "topic~2"]), upstream);
    assert_eq!(fx.git(&["log", "--format=%s", "main..review"]), "Second change\nFirst change");
}

#[test]
fn merge_unrelated_histories_requires_the_explicit_option() {
    let (fx, _) = Fixture::with_origin();
    let head = fx.head();
    let tree = fx.git(&["rev-parse", "HEAD^{tree}"]);
    let unrelated = fx.git(&["commit-tree", &tree, "-m", "Independent history"]);
    fx.git(&["branch", "external", &unrelated]);
    let repo = fx.repo();
    let branches = ["refs/heads/external".into()];
    assert!(repo.merge_with(&branches, &MergeOptions::default()).is_err());
    assert_eq!(fx.head(), head);
    let options = MergeOptions {
        allow_unrelated_histories: true,
        message: Some("Join the histories".into()),
        ..Default::default()
    };
    repo.merge_with(&branches, &options).unwrap();
    assert_eq!(fx.git(&["show", "-s", "--format=%P", "HEAD"]), format!("{head} {unrelated}"));
    assert_eq!(fx.subjects()[0], "Join the histories");
}

#[cfg(unix)]
#[test]
fn push_can_skip_a_failing_pre_push_hook() {
    use std::os::unix::fs::PermissionsExt;
    let (fx, _bare) = Fixture::with_origin();
    let repo = fx.repo();
    assert!(!repo.has_hook("pre-push").unwrap());
    let hook = fx.path(".git/hooks/pre-push");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\necho refused >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(repo.has_hook("pre-push").unwrap());

    fx.write("local.txt", "l\n");
    fx.commit_all("local");
    let (cancel, out) = quiet();
    assert!(repo.push(false, false, &cancel, &out).is_err(), "the hook refuses the push");
    let options = PushOptions { no_verify: true, ..Default::default() };
    repo.push_with(options, &cancel, &out).unwrap();
    assert_eq!(fx.head(), fx.git(&["rev-parse", "origin/main"]));
}

#[test]
fn force_push_without_lease_overwrites_a_remote_that_moved() {
    let (fx, bare) = Fixture::with_origin();
    fx.write("local.txt", "l\n");
    fx.commit_all("local");
    fx.push_from_other(&bare, "remote.txt", "r\n");
    fx.git(&["fetch", "-q"]);
    fx.push_from_other(&bare, "remote2.txt", "r\n");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let lease = PushOptions { force_with_lease: true, ..Default::default() };
    let err = repo.push_with(lease, &cancel, &out).unwrap_err();
    assert!(err.message.contains("stale info"), "{}", err.message);
    let report = repo.push_with(PushOptions { force: true, ..Default::default() }, &cancel, &out).unwrap();
    assert_eq!(report.refs[0].status, PushRefStatus::Forced);
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), fx.head());
}

#[test]
fn push_reports_a_custom_destination_and_the_actual_commit_and_tag_updates() {
    let (fx, bare) = Fixture::with_origin();
    let repo = fx.repo();
    let cancel = CancellationToken::new();
    let output = Mutex::new(Vec::new());
    let out = |line: String| output.lock().unwrap().push(line);
    let selection = PushSelection {
        branch: Some("main".into()),
        revision: None,
        remote: "origin".into(),
        target: "review/saved".into(),
        special_ref: false,
    };
    let push =
        |tags| repo.push_selected(&selection, None, PushOptions { tags, ..Default::default() }, &cancel, &out).unwrap();
    let created = push(None);
    assert_eq!(created.remote.as_deref(), Some("origin"));
    assert_eq!(
        created.refs,
        [PushRefResult { reference: "refs/heads/review/saved".into(), status: PushRefStatus::Created, commits: None }]
    );
    assert_eq!(push(None).refs[0].status, PushRefStatus::UpToDate);

    fx.write("a.txt", "two\n");
    fx.commit_all("Second");
    fx.write("a.txt", "three\n");
    fx.commit_all("Third");
    fx.git(&["tag", "reviewed"]);
    output.lock().unwrap().clear();
    let report = push(Some(PushTags::All));
    assert_eq!(output.lock().unwrap().iter().filter(|line| line.starts_with("To ")).count(), 1);
    assert_eq!(
        report.refs,
        [
            PushRefResult {
                reference: "refs/heads/review/saved".into(),
                status: PushRefStatus::FastForward,
                commits: Some(2),
            },
            PushRefResult { reference: "refs/tags/reviewed".into(), status: PushRefStatus::Created, commits: None },
        ]
    );
    assert_eq!(git_in(&bare, &["rev-parse", "review/saved"]), fx.head());
    assert_eq!(push(Some(PushTags::All)).refs[1].status, PushRefStatus::UpToDate);
}

#[test]
fn push_keeps_the_applied_branch_in_the_report_when_a_tag_fails() {
    use ide_core::error::ErrorData;

    let (fx, bare) = Fixture::with_origin();
    let original = fx.head();
    git_in(&bare, &["tag", "release"]);
    fx.write("a.txt", "new work\n");
    fx.commit_all("Local work");
    fx.git(&["tag", "release"]);
    let (cancel, out) = quiet();
    let opts = PushOptions { tags: Some(PushTags::All), ..Default::default() };
    let repo = fx.repo();
    let selection = repo.default_push_target(Some("main")).unwrap().unwrap().selection;
    let error = repo.push_selected(&selection, None, opts, &cancel, &out).unwrap_err();
    assert!(error.message.contains("already exists"), "{}", error.message);
    let Some(ErrorData::PushPartiallyApplied { report }) = error.data else {
        panic!("missing partial push report");
    };
    assert_eq!(
        report.refs,
        [PushRefResult { reference: "refs/heads/main".into(), status: PushRefStatus::FastForward, commits: Some(1) }]
    );
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), fx.head());
    assert_eq!(git_in(&bare, &["rev-parse", "release"]), original);
}

#[test]
fn push_keeps_tracked_branch_recovery_when_tags_were_published() {
    use ide_core::error::ErrorData;

    let (fx, bare) = Fixture::with_origin();
    fx.write("local.txt", "Local work\n");
    fx.commit_all("Local work");
    fx.git(&["tag", "ready"]);
    fx.push_from_other(&bare, "remote.txt", "Remote work\n");
    fx.git(&["fetch"]);
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let selection = repo.default_push_target(Some("main")).unwrap().unwrap().selection;
    let opts = PushOptions { tags: Some(PushTags::All), ..Default::default() };
    let error = repo.push_selected(&selection, None, opts, &cancel, &out).unwrap_err();
    let Some(ErrorData::PushRejected { source, upstream, divergence: Some(_), report: Some(report) }) = error.data
    else {
        panic!("expected tracked branch rejection and published refs: {error:?}");
    };
    assert_eq!((source.as_str(), upstream.as_str()), ("main", "origin/main"));
    assert_eq!(
        report.refs,
        [PushRefResult { reference: "refs/tags/ready".into(), status: PushRefStatus::Created, commits: None }]
    );
    assert_eq!(git_in(&bare, &["rev-parse", "refs/tags/ready"]), fx.head());
    fx.git(&["merge", "--no-edit", "@{upstream}"]);
    let retry = repo.push_selected(&selection, None, opts, &cancel, &out).unwrap();
    assert!(retry.refs.iter().any(|r| r.reference == "refs/heads/main" && r.status == PushRefStatus::FastForward));
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), fx.head());
}

#[test]
fn push_current_branch_tags_are_limited_to_the_selected_commit() {
    let (fx, bare) = Fixture::with_origin();
    let initial = fx.head();
    fx.git(&["tag", "-a", "base", "-m", "Annotated base"]);
    fx.git(&["tag", "lightweight"]);
    fx.write("a.txt", "new work\n");
    fx.commit_all("New work");
    fx.git(&["tag", "-a", "later", "-m", "Annotated later"]);
    let (cancel, out) = quiet();
    let selection = PushSelection {
        branch: Some("main".into()),
        revision: Some(initial.clone()),
        remote: "origin".into(),
        target: "review/partial".into(),
        special_ref: false,
    };
    let opts = PushOptions { tags: Some(PushTags::CurrentBranch), ..Default::default() };
    fx.repo().push_selected(&selection, None, opts, &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "review/partial"]), initial);
    assert_eq!(git_in(&bare, &["tag", "--list"]), "base");
}

#[test]
fn force_push_of_the_selected_branch_does_not_overwrite_a_colliding_tag() {
    use ide_core::error::ErrorData;

    let (fx, bare) = Fixture::with_origin();
    let original = fx.head();
    git_in(&bare, &["tag", "release"]);
    fx.push_from_other(&bare, "remote.txt", "Remote work\n");
    fx.write("local.txt", "Local work\n");
    fx.commit_all("Local work");
    fx.git(&["tag", "release"]);
    let (cancel, out) = quiet();
    let repo = fx.repo();
    let selection = repo.default_push_target(Some("main")).unwrap().unwrap().selection;
    let opts = PushOptions { force: true, tags: Some(PushTags::All), ..Default::default() };
    let error = repo.push_selected(&selection, None, opts, &cancel, &out).unwrap_err();
    let Some(ErrorData::PushPartiallyApplied { report }) = error.data else {
        panic!("expected a branch update and tag rejection: {error:?}");
    };
    assert_eq!(report.refs[0].status, PushRefStatus::Forced);
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), fx.head());
    assert_eq!(git_in(&bare, &["rev-parse", "release"]), original);
}

#[test]
fn rejected_push_lease_keeps_the_tip_reviewed_before_a_fetch() {
    use ide_core::error::ErrorData;

    let (fx, bare) = Fixture::with_origin();
    fx.git(&["branch", "-m", "release"]);
    fx.write("local.txt", "local work");
    fx.commit_all("local work");
    let local_tip = fx.head();
    fx.push_from_other(&bare, "remote.txt", "remote work");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let rejection = || repo.push(false, false, &cancel, &out).unwrap_err();

    let error = rejection();
    assert!(error.message.contains("(fetch first)"), "{}", error.message);
    assert!(matches!(
        error.data,
        Some(ErrorData::PushRejected { source, upstream, divergence: None, .. })
            if source == "release" && upstream == "origin/main"
    ));

    fx.git(&["fetch", "-q"]);
    let Some(ErrorData::PushRejected { divergence: Some(divergence), .. }) = rejection().data else {
        panic!("missing known divergence for a tracked branch with a different name");
    };
    assert_eq!(divergence.source, "release");
    assert_eq!(divergence.remote, "origin");
    assert_eq!(divergence.target, "main");
    assert_eq!(divergence.local_tip, local_tip);
    assert_eq!(divergence.remote_tip, fx.git(&["rev-parse", "origin/main"]));
    assert_eq!(divergence.remote_commits, 1);

    fx.push_from_other(&bare, "other.txt", "new remote work");
    fx.git(&["fetch", "-q"]);
    let new_tip = fx.git(&["rev-parse", "origin/main"]);
    let error = repo.force_push_rejected(&divergence, None, false, &cancel, &out).unwrap_err();
    assert!(error.message.contains("(stale info)"), "{}", error.message);
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), new_tip);

    let Some(ErrorData::PushRejected { divergence: Some(divergence), .. }) = rejection().data else {
        panic!("missing reviewed divergence after the fetch");
    };
    assert_eq!(divergence.remote_tip, new_tip);
    assert_eq!(divergence.remote_commits, 2);
    repo.force_push_rejected(&divergence, None, false, &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), local_tip);
}

#[test]
fn rejected_push_only_offers_force_for_the_diverged_tracked_destination() {
    use ide_core::error::ErrorData;

    let (fx, bare) = Fixture::with_origin();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    fx.push_from_other(&bare, "remote.txt", "remote work");
    fx.git(&["fetch", "-q"]);
    let error = repo.push(false, false, &cancel, &out).unwrap_err();
    assert!(error.message.contains("(non-fast-forward)"), "{}", error.message);
    assert!(matches!(error.data, Some(ErrorData::PushRejected { divergence: None, .. })));

    fx.git(&["branch", "other", "origin/main"]);
    fx.git(&["push", "-q", "origin", "other"]);
    fx.write("local.txt", "local work");
    fx.commit_all("local work");
    fx.git(&["config", "remote.origin.push", "refs/heads/main:refs/heads/other"]);
    let error = repo.push(false, false, &cancel, &out).unwrap_err();
    assert!(error.message.contains("(non-fast-forward)"), "{}", error.message);
    assert_eq!(error.data, None, "the rejected ref was not the upstream");
}

#[test]
fn default_push_target_preserves_tracking_and_configured_destinations() {
    let (fx, bare) = Fixture::with_origin();
    fx.git(&["branch", "-m", "release"]);
    let repo = fx.repo();
    let default = repo.default_push_target(None).unwrap().unwrap();
    assert_eq!(
        (default.selection.branch.as_deref(), default.selection.remote.as_str(), default.selection.target.as_str()),
        (Some("release"), "origin", "main")
    );
    assert!(!default.set_upstream);

    fx.git(&["config", "--add", "remote.origin.push", "refs/heads/*:refs/heads/publish/*"]);
    assert_eq!(repo.default_push_target(None).unwrap().unwrap().selection.target, "publish/release");
    fx.git(&["config", "--add", "remote.origin.push", "+release:refs/for/main"]);
    let review = repo.default_push_target(Some("release")).unwrap().unwrap();
    assert_eq!(review.selection.target, "refs/for/main");
    assert!(review.selection.special_ref);
    assert!(!review.set_upstream);
    let (cancel, out) = quiet();
    let inspection = repo.inspect_push(&review.selection, true, &cancel).unwrap();
    assert!(inspection.remote_checked);
    repo.push_selected(&review.selection, Some(&inspection), PushOptions::default(), &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "refs/for/main"]), fx.head());

    fx.git(&["remote", "add", "mirror/team", bare.to_str().unwrap()]);
    fx.git(&["config", "branch.release.pushRemote", "mirror/team"]);
    fx.git(&["config", "remote.mirror/team.push", "HEAD:refs/heads/approved"]);
    let overridden = repo.default_push_target(None).unwrap().unwrap();
    assert_eq!(overridden.selection.remote, "mirror/team");
    assert_eq!(overridden.selection.target, "approved");
    assert!(!overridden.set_upstream);
}

#[test]
fn outgoing_commits_follow_the_push_target_and_its_fetch_refspec() {
    let (fx, _) = Fixture::with_origin();
    let fork = fx.tmp.path().join("fork.git");
    git_in(fx.tmp.path(), &["init", "-q", "--bare", fork.to_str().unwrap()]);
    fx.git(&["remote", "add", "fork", fork.to_str().unwrap()]);
    let fetch = "+refs/heads/*:refs/remotes/published/*";
    fx.git(&["config", "remote.fork.fetch", fetch]);
    fx.git(&["push", "-q", "fork", "main:refs/heads/review/main"]);
    let published = fx.head();
    fx.write("b.txt", "upstream only\n");
    fx.commit_all("Pushed only to the upstream");
    fx.git(&["push", "-q", "origin", "main"]);
    fx.write("c.txt", "local only\n");
    fx.commit_all("Still local");
    fx.git(&["config", "branch.main.pushRemote", "fork"]);
    fx.git(&["config", "remote.fork.push", "refs/heads/main:refs/heads/review/main"]);
    let repo = fx.repo();

    let info = repo.branch_info().unwrap();
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    assert_eq!(info.ahead, 1);
    let outgoing = info.outgoing.unwrap();
    assert_eq!((&*outgoing.remote, &*outgoing.branch), ("fork", "review/main"));
    assert_eq!(outgoing.reference, "refs/remotes/published/review/main");
    assert_eq!(outgoing.count, 2);
    let branches = repo.branches().unwrap();
    assert_eq!(branches.iter().find(|b| b.current).unwrap().outgoing.as_ref(), Some(&outgoing));
    let selection = repo.default_push_target(Some("main")).unwrap().unwrap().selection;
    assert_eq!((&*selection.remote, &*selection.target), ("fork", "review/main"));
    let cancel = CancellationToken::new();
    assert_eq!(repo.inspect_push(&selection, false, &cancel).unwrap().remote_tip.as_deref(), Some(&*published));

    // A stale ref excluded by the fetch refspec is no longer a basis for the push count.
    fx.git(&["config", "--add", "remote.fork.fetch", "^refs/heads/review/main"]);
    assert!(repo.branch_info().unwrap().outgoing.is_none());
    fx.git(&["config", "--replace-all", "remote.fork.fetch", fetch]);
    let alternate = fx.tmp.path().join("different-push-endpoint.git");
    fx.git(&["remote", "set-url", "--push", "fork", alternate.to_str().unwrap()]);
    assert!(repo.branch_info().unwrap().outgoing.is_none());
    assert!(repo.inspect_push(&selection, false, &cancel).unwrap().remote_tip.is_none());
}

#[test]
fn push_up_to_commit_prefers_a_containing_local_branch_and_only_publishes_the_selection() {
    let (fx, bare) = Fixture::with_origin();
    let base = fx.head();
    fx.git(&["push", "origin", "main:refs/heads/review/partial", "main:refs/heads/detached"]);
    fx.git(&["switch", "-c", "topic2"]);
    fx.git(&["branch", "--set-upstream-to=origin/review/partial"]);
    fx.write("selected.txt", "publish this");
    fx.commit_all("Selected commit");
    let selected = fx.head();
    fx.git(&["branch", "topic10"]);
    fx.write("later.txt", "keep this local");
    fx.commit_all("Later commit");
    let later = fx.head();
    fx.git(&["switch", "topic10"]);
    let repo = fx.repo();
    let (cancel, out) = quiet();
    assert_eq!(repo.commit_push_target(&selected, &cancel).unwrap().branch.as_deref(), Some("topic10"));

    fx.git(&["switch", "main"]);
    assert_eq!(repo.commit_push_target(&base, &cancel).unwrap().branch.as_deref(), Some("main"));
    let target = repo.commit_push_target(&selected, &cancel).unwrap();
    assert_eq!(target.branch.as_deref(), Some("topic2"));
    let target = target.destination.unwrap();
    assert_eq!(target.selection.target, "review/partial");
    assert_eq!(target.selection.revision.as_deref(), Some(selected.as_str()));
    assert!(!target.set_upstream);
    repo.push_selected(&target.selection, None, PushOptions::default(), &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "refs/heads/review/partial"]), selected);
    assert_eq!(fx.git(&["rev-parse", "topic2"]), later);
    assert_eq!(fx.head(), base);

    fx.git(&["tag", "selected", &selected]);
    fx.git(&["branch", "-D", "topic2", "topic10"]);
    let detached = repo.commit_push_target(&selected, &cancel).unwrap();
    assert!(detached.branch.is_none());
    let target = detached.destination.unwrap();
    assert_eq!(target.selection.target, "main");
    assert_eq!(target.selection.revision.as_deref(), Some(selected.as_str()));
    assert_eq!(fx.git(&["symbolic-ref", "--short", "HEAD"]), "main");
    fx.git(&["switch", "--detach"]);
    let detached = repo.commit_push_target(&selected, &cancel).unwrap().destination.unwrap();
    assert_eq!(detached.selection.target, "detached2");
}

#[test]
fn push_target_choices_use_the_selected_source_and_each_remotes_refspec() {
    let (fx, origin) = Fixture::with_origin();
    let fork = tempfile::tempdir().unwrap();
    git_in(fork.path(), &["init", "--bare"]);
    fx.git(&["remote", "add", "fork", fork.path().to_str().unwrap()]);
    fx.git(&["config", "remote.origin.push", "refs/heads/topic:refs/heads/publish/topic"]);
    fx.git(&["config", "remote.fork.push", "+refs/heads/topic:refs/for/topic"]);
    fx.git(&["switch", "-qc", "topic"]);
    fx.write("selected.txt", "publish only this");
    let selected = fx.commit_all("Selected commit");
    fx.write("later.txt", "keep local");
    let later = fx.commit_all("Later commit");
    fx.git(&["switch", "main"]);
    let repo = fx.repo();
    let (cancel, out) = quiet();

    let named = repo.push_target_choices(Some("topic"), None, &cancel).unwrap();
    assert_eq!(named.branch.as_deref(), Some("topic"));
    assert_eq!(named.destination.unwrap().selection.target, "publish/topic");
    let choices = repo.push_target_choices(None, Some(&selected), &cancel).unwrap();
    assert_eq!(choices.branch.as_deref(), Some("topic"));
    let chosen = choices.destinations.iter().find(|target| target.selection.remote == "fork").unwrap();
    assert_eq!(chosen.selection.target, "refs/for/topic");
    assert!(chosen.selection.special_ref);
    assert!(!chosen.set_upstream);
    assert_eq!(chosen.selection.revision.as_deref(), Some(selected.as_str()));
    repo.push_selected(&chosen.selection, None, PushOptions::default(), &cancel, &out).unwrap();
    assert_eq!(git_in(fork.path(), &["rev-parse", "refs/for/topic"]), selected);
    assert!(git_in(fork.path(), &["for-each-ref", "refs/heads"]).is_empty());
    assert!(git_in(&origin, &["for-each-ref", "refs/heads/publish"]).is_empty());
    assert_eq!(fx.git(&["rev-parse", "refs/heads/topic"]), later);
}

#[test]
fn detached_push_suggests_a_new_branch_and_pins_the_selected_commit() {
    let (fx, bare) = Fixture::with_origin();
    let main = fx.head();
    fx.git(&["push", "origin", "main:refs/heads/detached", "main:refs/heads/detached2"]);
    fx.git(&["fetch", "origin"]);
    fx.git(&["switch", "--detach"]);
    fx.write("detached.txt", "detached change");
    fx.commit_all("detached change");
    let reviewed = fx.head();
    let repo = fx.repo();
    let target = repo.default_push_target(None).unwrap().unwrap();
    let selection = target.selection;
    assert!(selection.branch.is_none());
    assert_eq!(selection.revision.as_deref(), Some(reviewed.as_str()));
    assert_eq!(selection.target, "detached3");
    assert_eq!(selection.remote, "origin");
    assert!(!target.set_upstream);
    let (cancel, out) = quiet();
    let inspection = repo.inspect_push(&selection, true, &cancel).unwrap();
    assert!(inspection.remote_checked);
    assert_eq!(inspection.remote_tip.as_deref(), Some(""));
    fx.write("another.txt", "HEAD moved after review");
    fx.commit_all("another detached commit");

    let ambiguous = PushSelection { revision: Some("HEAD".into()), ..selection.clone() };
    assert!(repo.inspect_push(&ambiguous, false, &cancel).is_err());
    let opts = PushOptions { set_upstream: true, ..Default::default() };
    fx.git(&["push", "origin", "main:refs/heads/detached3"]);
    let stale = repo.push_selected(&selection, Some(&inspection), opts, &cancel, &out).unwrap_err();
    assert!(stale.message.contains("stale info"), "{}", stale.message);
    assert_eq!(git_in(&bare, &["rev-parse", "refs/heads/detached3"]), main);
    git_in(&bare, &["update-ref", "-d", "refs/heads/detached3"]);
    repo.push_selected(&selection, Some(&inspection), opts, &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "refs/heads/detached3"]), reviewed);
    assert_eq!(git_in(&bare, &["rev-parse", "refs/heads/main"]), main);
    assert_ne!(fx.head(), reviewed);
    assert!(repo.head().unwrap().0.is_none());
    assert_eq!(fx.git(&["for-each-ref", "--format=%(refname:short)", "refs/heads"]), "main");
}

#[test]
fn inspect_push_fetches_missing_history_and_preserves_the_reviewed_lease() {
    let (fx, bare) = Fixture::with_origin();
    fx.write("local.txt", "local work");
    fx.commit_all("local work");
    fx.push_from_other(&bare, "remote.txt", "remote work");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let selection = PushSelection {
        branch: Some("main".into()),
        revision: None,
        remote: "origin".into(),
        target: "main".into(),
        special_ref: false,
    };

    assert_eq!(repo.inspect_push(&selection, false, &cancel).unwrap().state, PushTargetState::Ready);
    assert_eq!(repo.inspect_push(&selection, true, &cancel).unwrap().state, PushTargetState::FetchRequired);
    repo.fetch_push_target(&selection, &cancel, &out).unwrap();
    let reviewed = repo.inspect_push(&selection, true, &cancel).unwrap();
    assert_eq!(reviewed.state, PushTargetState::Diverged);
    assert_eq!(reviewed.remote_commits, 1);
    assert_eq!(reviewed.remote_tip, Some(fx.git(&["rev-parse", "origin/main"])));
    assert_eq!(reviewed.local_tip, fx.head());

    fx.push_from_other(&bare, "another.txt", "new remote work");
    fx.git(&["fetch"]);
    let lease = PushOptions { force_with_lease: true, ..Default::default() };
    let error = repo.push_selected(&selection, Some(&reviewed), lease, &cancel, &out).unwrap_err();
    assert!(error.message.contains("stale info"), "{}", error.message);
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), fx.git(&["rev-parse", "origin/main"]));
    let updated = repo.inspect_push(&selection, true, &cancel).unwrap();
    repo.push_selected(&selection, Some(&updated), lease, &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), reviewed.local_tip);
}

#[test]
fn inspect_push_reuses_incoming_observations_when_the_remote_is_unavailable() {
    let (fx, bare) = Fixture::with_origin();
    fx.write("local.txt", "local work");
    fx.commit_all("local work");
    fx.push_from_other(&bare, "remote.txt", "remote work");
    let tracked = fx.git(&["rev-parse", "origin/main"]);
    let advertised = git_in(&bare, &["rev-parse", "main"]);
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let selection = repo.default_push_target(None).unwrap().unwrap().selection;

    assert_eq!(repo.inspect_push(&selection, false, &cancel).unwrap().state, PushTargetState::Ready);
    let report = repo.check_incoming_refs(&cancel).unwrap();
    assert!(report.errors.is_empty());
    assert_eq!(report.branches[0].advertised_commit, advertised);
    let unavailable = fx.tmp.path().join("unavailable.git");
    std::fs::rename(&bare, &unavailable).unwrap();
    for live in [false, true] {
        let result = repo.inspect_push(&selection, live, &cancel).unwrap();
        assert_eq!(result.state, PushTargetState::FetchRequired);
        assert_eq!(result.remote_tip.as_deref(), Some(advertised.as_str()));
        assert!(!result.remote_checked);
    }
    assert_eq!(fx.git(&["rev-parse", "origin/main"]), tracked);

    fx.git(&["config", "branch.main.merge", "refs/heads/release"]);
    let changed_tracking = repo.inspect_push(&selection, false, &cancel).unwrap();
    assert_eq!(changed_tracking.remote_tip.as_deref(), Some(tracked.as_str()));
    fx.git(&["config", "branch.main.merge", "refs/heads/main"]);
    let different_endpoint = fx.tmp.path().join("different.git");
    fx.git(&["remote", "set-url", "origin", different_endpoint.to_str().unwrap()]);
    let changed_endpoint = repo.inspect_push(&selection, true, &cancel).unwrap();
    assert_eq!(changed_endpoint.remote_tip.as_deref(), Some(tracked.as_str()));
    fx.git(&["remote", "set-url", "origin", bare.to_str().unwrap()]);
    fx.git(&["remote", "set-url", "--push", "origin", different_endpoint.to_str().unwrap()]);
    assert!(repo.inspect_push(&selection, false, &cancel).unwrap().remote_tip.is_none());
    fx.git(&["config", "--unset", "remote.origin.pushurl"]);
    std::fs::rename(&unavailable, &bare).unwrap();

    git_in(&bare, &["update-ref", "-d", "refs/heads/main", &advertised]);
    let deleted = repo.inspect_push(&selection, true, &cancel).unwrap();
    assert_eq!(deleted.state, PushTargetState::Ready);
    assert!(deleted.remote_checked);
    assert_eq!(deleted.remote_tip.as_deref(), Some(""));
    git_in(&bare, &["update-ref", "refs/heads/main", &advertised]);

    fx.push_from_other(&bare, "next.txt", "another remote commit");
    let fresh = repo.inspect_push(&selection, true, &cancel).unwrap();
    let new_tip = git_in(&bare, &["rev-parse", "main"]);
    assert!(fresh.remote_checked);
    assert_eq!(fresh.remote_tip.as_deref(), Some(new_tip.as_str()));
    repo.fetch_push_target(&selection, &cancel, &out).unwrap();
    let fetched = repo.inspect_push(&selection, false, &cancel).unwrap();
    assert_eq!(fetched.remote_tip, fresh.remote_tip);
    assert_eq!(fetched.state, PushTargetState::Diverged);
    assert_eq!(fetched.remote_commits, 2);
}

#[test]
fn inspect_push_uses_the_push_url_and_keeps_the_fetch_url_tracking_ref() {
    let (fx, bare) = Fixture::with_origin();
    let other = fx.tmp.path().join("push.git");
    git_in(fx.tmp.path(), &["clone", "--bare", bare.to_str().unwrap(), other.to_str().unwrap()]);
    fx.git(&["remote", "set-url", "--push", "origin", other.to_str().unwrap()]);
    let tracking_tip = fx.git(&["rev-parse", "origin/main"]);
    fx.push_from_other(&other, "at-push-url.txt", "there is other work at the push endpoint");
    fx.write("local.txt", "local work");
    fx.commit_all("local work");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let selection = PushSelection {
        branch: Some("main".into()),
        revision: None,
        remote: "origin".into(),
        target: "main".into(),
        special_ref: false,
    };

    assert_eq!(repo.inspect_push(&selection, true, &cancel).unwrap().state, PushTargetState::FetchRequired);
    repo.fetch_push_target(&selection, &cancel, &out).unwrap();
    let reviewed = repo.inspect_push(&selection, true, &cancel).unwrap();
    assert_eq!(reviewed.state, PushTargetState::Diverged);
    assert_eq!(reviewed.remote_tip, Some(git_in(&other, &["rev-parse", "main"])));
    assert_eq!(fx.git(&["rev-parse", "origin/main"]), tracking_tip);
}

#[test]
fn push_to_another_branch_can_make_it_the_upstream() {
    let (fx, _bare) = Fixture::with_origin();
    fx.write("local.txt", "l\n");
    fx.commit_all("local");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let to = |target, set_upstream| PushBranchOptions { target: Some(target), set_upstream, ..Default::default() };
    repo.push_branch_to("main", to("feature", false), &cancel, &out).unwrap();
    assert_eq!(fx.git(&["rev-parse", "--abbrev-ref", "main@{u}"]), "origin/main", "upstream kept");
    repo.push_branch_to("main", to("feature-1", true), &cancel, &out).unwrap();
    assert_eq!(fx.git(&["rev-parse", "--abbrev-ref", "main@{u}"]), "origin/feature-1");
}

#[test]
fn tags_are_pushed_one_at_a_time_deleted_restored_and_deleted_on_the_remote() {
    let (fx, bare) = Fixture::with_origin();
    fx.git(&["tag", "-a", "v1", "-m", "release one"]);
    fx.git(&["tag", "v2"]);
    let repo = fx.repo();
    let (cancel, out) = quiet();
    repo.push_tag("v1", "origin", &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["tag"]), "v1", "only the chosen tag goes");
    repo.push_tag("v1", "origin", &cancel, &out).unwrap();

    let deleted = repo.delete_tag("v1").unwrap();
    assert_eq!(fx.git(&["tag"]), "v2");
    repo.restore_tag(&deleted).unwrap();
    assert_eq!(fx.git(&["cat-file", "-t", "v1"]), "tag", "annotated, as it was");
    assert!(fx.git(&["tag", "-n1", "v1"]).contains("release one"));

    repo.delete_tag("v1").unwrap();
    repo.delete_remote_tag("v1", "origin", &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["tag"]), "");
    assert!(repo.delete_tag("missing").is_err());
}

#[test]
fn deleting_tags_from_configured_remotes_skips_missing_tags_and_keeps_moved_tips() {
    let fx = Fixture::new();
    fx.write("base.txt", "base\n");
    fx.commit_all("initial");
    fx.git(&["tag", "-a", "release", "-m", "annotated release"]);
    let original = fx.git(&["rev-parse", "refs/tags/release"]);
    let base = fx.head();
    let stale = fx.tmp.path().join("tag moved.git");
    let empty = fx.tmp.path().join("tag absent.git");
    let matching = fx.tmp.path().join("tag matching.git");
    for path in [&stale, &empty, &matching] {
        git_in(fx.tmp.path(), &["init", "-q", "--bare", path.to_str().unwrap()]);
    }
    fx.git(&["remote", "add", "a-stale", stale.to_str().unwrap()]);
    fx.git(&["remote", "add", "b-empty", empty.to_str().unwrap()]);
    fx.git(&["remote", "add", "publish/release", empty.to_str().unwrap()]);
    fx.git(&["remote", "set-url", "--push", "publish/release", matching.to_str().unwrap()]);
    fx.git(&["push", "-q", "a-stale", "HEAD:refs/tags/release"]);

    let repo = fx.repo();
    let (cancel, out) = quiet();
    assert!(repo.push_tag("release", matching.to_str().unwrap(), &cancel, &out).is_err());
    assert!(git_in(&matching, &["tag"]).is_empty());
    repo.push_tag("release", "publish/release", &cancel, &out).unwrap();
    assert_eq!(git_in(&matching, &["rev-parse", "refs/tags/release"]), original);
    assert!(fx.git(&["branch", "-r"]).is_empty());

    fx.git(&["remote", "set-url", "--add", "--push", "publish/release", empty.to_str().unwrap()]);
    let deleted = repo.delete_tag("release").unwrap();
    let err = repo.delete_tag_on_remotes(&deleted, &cancel, &out).unwrap_err();
    assert!(err.message.contains("a-stale"));
    assert!(!err.message.contains("b-empty"));
    assert!(!err.message.contains("publish/release"));
    assert_eq!(git_in(&stale, &["rev-parse", "refs/tags/release"]), base);
    assert!(git_in(&matching, &["tag"]).is_empty());
    assert!(git_in(&empty, &["tag"]).is_empty());

    fx.git(&["remote", "remove", "a-stale"]);
    repo.delete_tag_on_remotes(&deleted, &cancel, &out).unwrap();
    repo.restore_tag(&deleted).unwrap();
    assert_eq!(fx.git(&["rev-parse", "refs/tags/release"]), original);
}

#[test]
fn fetch_prunes_deleted_remote_branches() {
    let (fx, bare) = Fixture::with_origin();
    fx.git(&["push", "-q", "origin", "main:gone"]);
    fx.git(&["fetch", "-q"]);
    fx.git(&["checkout", "-q", "-b", "feature", "--track", "origin/gone"]);
    let repo = fx.repo();
    let upstream = || repo.branches().unwrap().into_iter().find(|b| b.name == "feature").and_then(|b| b.upstream);
    assert!(repo.branches().unwrap().iter().any(|b| b.name == "origin/gone"));
    assert_eq!(upstream().as_deref(), Some("origin/gone"));
    git_in(&bare, &["branch", "-D", "gone"]);
    let (cancel, out) = quiet();
    repo.fetch(&cancel, &out).unwrap();
    assert!(!repo.branches().unwrap().iter().any(|b| b.name == "origin/gone"));
    // The branch that tracked it no longer counts as tracking, as in IDEA.
    assert_eq!(upstream(), None);
    assert_eq!(repo.branch_info().unwrap().upstream, None);
}

#[test]
fn check_incoming_refs_reads_the_remote_without_fetching_objects_or_tracking_refs() {
    let (fx, bare) = Fixture::with_origin();
    let old = fx.head();
    fx.git(&["push", "-q", "origin", "main:refs/heads/review/next"]);
    fx.git(&["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/tracking/*"]);
    fx.git(&["fetch", "-q", "origin"]);
    fx.git(&["branch", "--track", "review", "tracking/review/next"]);

    fx.git(&["remote", "add", "offline", fx.tmp.path().join("missing.git").to_str().unwrap()]);
    fx.git(&["update-ref", "refs/remotes/offline/main", &old]);
    fx.git(&["branch", "--track", "broken", "offline/main"]);
    let fetch_head = fx.read(".git/FETCH_HEAD");
    fx.push_from_other(&bare, "incoming.txt", "new changes\n");
    let new = git_in(&bare, &["rev-parse", "refs/heads/main"]);
    git_in(&bare, &["update-ref", "refs/heads/review/next", &new]);
    let repo = fx.repo();
    let (cancel, out) = quiet();

    let report = repo.check_incoming_refs(&cancel).unwrap();
    assert_eq!(report.errors.len(), 1);
    assert_eq!(report.errors[0].remote, "offline");
    assert_eq!(report.branches.len(), 2);
    for (name, remote_branch) in [("main", "main"), ("review", "review/next")] {
        let found = report.branches.iter().find(|branch| branch.branch == name).unwrap();
        assert_eq!(found.tracked_tip.tracking.remote, "origin");
        assert_eq!(found.tracked_tip.tracking.branch, remote_branch);
        assert_eq!(found.tracked_tip.commit, old);
        assert_eq!(found.advertised_commit, new);
    }
    assert!(!repo.has_commit(&new));
    assert_eq!(fx.read(".git/FETCH_HEAD"), fetch_head);
    assert_eq!(repo.branch_info().unwrap().behind, 0);

    repo.fetch_remote("origin", &cancel, &out).unwrap();
    assert!(repo.check_incoming_refs(&cancel).unwrap().branches.is_empty());
    assert_eq!(repo.branch_info().unwrap().behind, 1);
}

#[test]
fn fetch_report_keeps_prunes_from_the_remotes_that_succeeded() {
    use ide_core::workflow_settings::FetchTagsMode::{Auto, Sync};

    let (fx, bare) = Fixture::with_origin();
    let missing = fx.tmp.path().join("missing.git");
    fx.git(&["remote", "add", "a-offline", missing.to_str().unwrap()]);
    fx.git(&["remote", "add", "z-skipped", missing.to_str().unwrap()]);
    fx.git(&["config", "remote.z-skipped.skipDefaultUpdate", "true"]);
    fx.git(&["config", "remote.origin.skipDefaultUpdate", "true"]);
    fx.git(&["config", "remote.origin.skipFetchAll", "false"]);
    fx.git(&["remote", "add", "release/mirror", bare.to_str().unwrap()]);
    fx.git(&["push", "-q", "origin", "main:gone/review"]);
    fx.git(&["tag", "release/retired"]);
    git_in(&bare, &["branch", "-D", "gone/review"]);
    let repo = fx.repo();
    let (cancel, out) = quiet();

    let report = repo.fetch_report(None, Sync, &cancel, &out).unwrap();
    let [origin, offline, mirror] = report.remotes.as_slice() else { panic!("{report:?}") };
    assert_eq!(offline.remote, "a-offline");
    assert!(offline.error.as_ref().unwrap().message.contains("missing.git"));
    assert_eq!(origin.remote, "origin");
    assert!(origin.error.is_none());
    assert_eq!(origin.pruned.len(), 2);
    assert!(origin.pruned.contains(&"release/retired".into()));
    assert!(origin.pruned.contains(&"origin/gone/review".into()));
    assert_eq!(mirror.remote, "release/mirror");
    assert!(mirror.error.is_none());
    assert!(mirror.pruned.is_empty());
    assert!(!fx.git(&["branch", "-r"]).contains("gone/review"));
    assert!(fx.git(&["tag", "--list", "release/retired"]).is_empty());
    assert_eq!(fx.read(".git/FETCH_HEAD").lines().count(), 2);

    let background = repo.fetch_in_background(&["a-offline".into()], &cancel, &out).unwrap();
    assert_eq!(
        background.remotes.iter().map(|result| result.remote.as_str()).collect::<Vec<_>>(),
        ["origin", "release/mirror"]
    );
    assert!(background.remotes.iter().all(|result| result.error.is_none()));

    // Fetching a named remote intentionally bypasses the exclusion for Fetch All.
    let selected = repo.fetch_report(Some("z-skipped"), Auto, &cancel, &out).unwrap();
    assert_eq!(selected.remotes.len(), 1);
    assert_eq!(selected.remotes[0].remote, "z-skipped");
    assert!(selected.remotes[0].error.is_some());
}

#[test]
fn fetch_report_does_not_claim_a_locked_ref_was_pruned() {
    let (fx, bare) = Fixture::with_origin();
    fx.git(&["push", "-q", "origin", "main:gone"]);
    git_in(&bare, &["branch", "-D", "gone"]);
    fx.write(".git/refs/remotes/origin/gone.lock", "");
    let (cancel, out) = quiet();
    let report = fx
        .repo()
        .fetch_report(Some("origin"), ide_core::workflow_settings::FetchTagsMode::Auto, &cancel, &out)
        .unwrap();
    let remote = &report.remotes[0];
    assert!(remote.error.as_ref().unwrap().message.contains("gone.lock"));
    assert!(remote.pruned.is_empty());
    assert!(fx.git(&["branch", "-r"]).contains("origin/gone"));
}

#[test]
fn fetch_tag_modes_override_git_config_only_when_selected() {
    use ide_core::workflow_settings::FetchTagsMode::*;

    let (fx, bare) = Fixture::with_origin();
    let tree = fx.git(&["rev-parse", "HEAD^{tree}"]);
    let orphan = fx.git(&["commit-tree", &tree, "-m", "Unrelated archive"]);
    fx.git(&["tag", "archived", &orphan]);
    fx.git(&["tag", "on-main"]);
    fx.git(&["push", "origin", "--tags"]);
    fx.git(&["tag", "-d", "archived", "on-main"]);
    fx.git(&["tag", "local-only"]);
    fx.git(&["config", "remote.origin.tagOpt", "--no-tags"]);
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let tags = || fx.git(&["tag", "--list"]);

    repo.fetch_with_tags(None, Auto, &cancel, &out).unwrap();
    assert_eq!(tags(), "local-only");
    fx.git(&["config", "remote.origin.pruneTags", "true"]);
    repo.fetch_with_tags(None, Never, &cancel, &out).unwrap();
    assert_eq!(tags(), "local-only");
    repo.fetch_with_tags(Some("origin"), Always, &cancel, &out).unwrap();
    assert_eq!(tags(), "archived\nlocal-only\non-main");

    git_in(&bare, &["tag", "-d", "archived"]);
    fx.git(&["config", "remote.origin.pruneTags", "false"]);
    repo.fetch_with_tags(Some("origin"), Sync, &cancel, &out).unwrap();
    assert_eq!(tags(), "on-main");

    fx.git(&["tag", "-f", "on-main", &orphan]);
    let error = repo.fetch_with_tags(Some("origin"), Sync, &cancel, &out).unwrap_err();
    assert!(error.message.contains("would clobber existing tag"), "{}", error.message);
    assert_eq!(fx.git(&["rev-parse", "refs/tags/on-main"]), orphan);
}

#[test]
fn update_project_syncs_tags_with_the_tracked_remote() {
    use ide_core::workflow_settings::FetchTagsMode::*;

    let (fx, bare) = Fixture::with_origin();
    fx.git(&["tag", "local-only"]);
    fx.push_from_other(&bare, "new.txt", "updated");
    git_in(&bare, &["tag", "received", "main"]);
    fx.git(&["config", "remote.origin.pruneTags", "false"]);
    let (cancel, out) = quiet();
    fx.repo().pull_checked_branch_with_tags(false, Some("main"), Sync, &cancel, &out).unwrap();
    assert_eq!(fx.git(&["tag", "--list"]), "received");
    assert_eq!(fx.head(), git_in(&bare, &["rev-parse", "main"]));
    assert_eq!(fx.git(&["config", "--get", "remote.origin.pruneTags"]), "false");
}

#[test]
fn fetch_tag_mode_also_applies_when_updating_selected_branches() {
    use ide_core::workflow_settings::FetchTagsMode::*;

    let (fx, bare) = Fixture::with_origin();
    fx.git(&["tag", "local-only"]);
    fx.push_from_other(&bare, "new.txt", "updated");
    git_in(&bare, &["tag", "received", "main"]);
    let (cancel, out) = quiet();
    let updates = fx.repo().update_branches_with_tags(&["main".into()], Never, &cancel, &out).unwrap();
    assert_eq!(updates[0].status, BranchUpdateStatus::Updated);
    assert_eq!(fx.git(&["tag", "--list"]), "local-only");
    assert_eq!(fx.head(), git_in(&bare, &["rev-parse", "main"]));
}

#[test]
fn fetch_full_history_keeps_head_and_uses_the_clone_remote() {
    use ide_core::workflow_settings::FetchTagsMode;
    let (fx, bare) = Fixture::with_origin();
    fx.push_from_other(&bare, "new.txt", "remote content");
    let clone = fx.tmp.path().join("shallow");
    git_in(
        fx.tmp.path(),
        &[
            "clone",
            "-q",
            "--no-local",
            "--depth",
            "1",
            "--origin",
            "upstream",
            bare.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    let repo = Repo::discover(&clone).unwrap().unwrap();
    let head = git_in(&clone, &["rev-parse", "HEAD"]);
    assert!(repo.is_shallow().unwrap());
    assert_eq!(git_in(&clone, &["rev-list", "--count", "HEAD"]), "1");

    git_in(&bare, &["tag", "old", "main~1"]);
    repo.unshallow_with_tags(FetchTagsMode::Always, &CancellationToken::new(), &|_| {}).unwrap();
    assert!(!repo.is_shallow().unwrap());
    assert_eq!(git_in(&clone, &["rev-list", "--count", "HEAD"]), "2");
    assert_eq!(git_in(&clone, &["rev-parse", "HEAD"]), head);
    assert_eq!(git_in(&clone, &["tag", "--list"]), "old");
}

#[test]
fn clear_stashes_keeps_working_tree_and_index() {
    let fx = Fixture::new();
    fx.write("a.txt", "base\n");
    fx.commit_all("initial");
    for message in ["first stash", "second stash"] {
        fx.write("a.txt", message);
        fx.git(&["stash", "push", "-m", message]);
    }
    fx.write("a.txt", "staged\n");
    fx.git(&["add", "a.txt"]);
    fx.write("a.txt", "unstaged\n");
    let repo = fx.repo();
    assert_eq!(repo.stashes().unwrap().len(), 2);

    repo.stash_clear().unwrap();
    assert!(repo.stashes().unwrap().is_empty());
    assert_eq!(fx.read("a.txt"), "unstaged\n");
    assert_eq!(fx.git(&["show", ":a.txt"]), "staged");
}

#[test]
fn revision_patch_applies_only_the_selected_paths() {
    let fx = Fixture::new();
    let literal = "note [1].txt";
    let sibling = "note 1.txt";
    fx.write(literal, "first version\r\n");
    fx.write(sibling, "other file\r\n");
    let before = fx.commit_all("initial");
    fx.write(literal, "selected revision\r\n");
    fx.write(sibling, "unselected revision\r\n");
    let after = fx.commit_all("both files changed");
    fx.git(&["checkout", "--detach", &before]);

    let repo = fx.repo();
    let patch = repo.create_revisions_patch(&before, &after, &[PathBuf::from(literal)]).unwrap();
    let outcome = repo.apply_patch(&patch).unwrap();
    assert_eq!(outcome.applied, [literal]);
    assert_eq!(fx.read(literal), "selected revision\r\n");
    assert_eq!(fx.read(sibling), "other file\r\n");
    assert!(fx.git(&["diff", "--cached", "--name-only"]).is_empty());
}

#[test]
fn selected_patch_keeps_its_conflict_sides_as_files_are_resolved() {
    let fx = Fixture::new();
    let files = ["one.txt", "two.txt"];
    for file in files {
        fx.write(file, "base\n");
    }
    let before = fx.commit_all("Base");
    for file in files {
        fx.write(file, "patched\n");
    }
    let after = fx.commit_all("Patch");
    let repo = fx.repo();
    let patch = repo.create_commits_patch(&[after], false).unwrap();
    fx.git(&["checkout", "--detach", &before]);
    for file in files {
        fx.write(file, "local\n");
    }
    fx.commit_all("Local changes");
    let outcome = repo.apply_selected_patch(&patch, &files.map(str::to_owned)).unwrap();
    assert_eq!(outcome.conflicts, files);
    repo.accept_conflict_side(&[fx.dir.join("one.txt")], ConflictSide::Ours).unwrap();
    assert_eq!(fx.read("one.txt"), "local\n");
    let remaining = fx.dir.join("two.txt");
    let versions = repo.merge_versions(&remaining, encoding_rs::UTF_8).unwrap();
    assert_eq!(versions.sides.operation.as_deref(), Some("apply-patch"));
    assert_eq!(versions.ours.as_deref(), Some("local\n"));
    assert_eq!(versions.theirs.as_deref(), Some("patched\n"));
    repo.accept_conflict_side(&[remaining], ConflictSide::Theirs).unwrap();
    assert_eq!(fx.read("two.txt"), "patched\n");
    assert_eq!(repo.merge_sides().unwrap().operation, None);
}

#[test]
fn patch_diff_reads_the_local_and_patched_versions_without_writing_the_repository() {
    use PatchDiffContent::{Binary, Conflict, Raw, Text};
    let fx = Fixture::new();
    fx.write("clean.txt", "original\n");
    fx.write("conflict.txt", "base\n");
    fx.write("old-name.txt", "moved\n");
    fx.write("delete.txt", "removed\n");
    std::fs::write(fx.dir.join("data.bin"), [0, 1, 255]).unwrap();
    let before = fx.commit_all("before patch");
    fx.write("clean.txt", "patched\n");
    fx.write("conflict.txt", "theirs\n");
    fx.write("add.txt", "added\n");
    fx.git(&["rm", "delete.txt"]);
    fx.git(&["mv", "old-name.txt", "new-name.txt"]);
    std::fs::write(fx.dir.join("data.bin"), [0, 2, 255]).unwrap();
    let after = fx.commit_all("patch");
    let repo = fx.repo();
    let patch = repo.create_commits_patch(&[after], false).unwrap();
    fx.git(&["checkout", "--detach", &before]);
    fx.write("conflict.txt", "ours\n");
    fx.git(&["add", "conflict.txt"]);
    let original_index = std::fs::read(fx.dir.join(".git/index")).unwrap();
    let encoding = |_: &Path, _: &[u8]| TextEncoding::from(encoding_rs::UTF_8);
    let diff = |file| repo.patch_file_diff(&patch, file, &encoding).unwrap();

    assert!(matches!(
        diff("clean.txt").content,
        Text { before: Some(before), after: Some(after) } if before == "original\n" && after == "patched\n"
    ));
    assert!(matches!(
        diff("conflict.txt").content,
        Conflict { local: Some(local), base: Some(base), patched: Some(patched) }
            if local == "ours\n" && base == "base\n" && patched == "theirs\n"
    ));
    assert!(matches!(diff("add.txt").content, Text { before: None, after: Some(text) } if text == "added\n"));
    assert!(matches!(diff("delete.txt").content, Text { before: Some(text), after: None } if text == "removed\n"));
    let rename = diff("new-name.txt");
    assert!(rename.old_path.unwrap().ends_with("old-name.txt"));
    assert!(matches!(rename.content, Text { before: Some(before), after: Some(after) } if before == after));
    assert!(matches!(diff("data.bin").content, Binary));

    let raw = "--- a/conflict.txt\n+++ b/conflict.txt\n@@ -1 +1 @@\n-missing preimage\n+result\n";
    assert!(matches!(
        repo.patch_file_diff(raw, "conflict.txt", &encoding).unwrap().content,
        Raw { local: Some(local), patch, applies: false } if local == "ours\n" && patch == raw
    ));
    let outside = "--- a/../external.txt\n+++ b/../external.txt\n@@ -1 +1 @@\n-before\n+after\n";
    assert!(repo.patch_file_diff(outside, "../external.txt", &encoding).is_err());
    assert_eq!(std::fs::read(fx.dir.join(".git/index")).unwrap(), original_index);
    assert_eq!(fx.read("clean.txt"), "original\n");
    assert_eq!(fx.read("conflict.txt"), "ours\n");
    assert_eq!(fx.read("delete.txt"), "removed\n");
    assert!(fx.exists("old-name.txt"));
    assert!(!fx.exists("new-name.txt"));
    assert!(!fx.exists("add.txt"));
}

#[test]
fn applying_selected_patch_files_keeps_renames_and_binary_data() {
    let fx = Fixture::new();
    let from = "before [1].txt";
    let to = "after [1].txt";
    fx.write(from, "rename this file\n");
    fx.write("keep.txt", "original\n");
    std::fs::write(fx.dir.join("data.bin"), [0, 1, 255]).unwrap();
    let before = fx.commit_all("initial");
    fx.git(&["mv", from, to]);
    fx.write("keep.txt", "from patch\n");
    std::fs::write(fx.dir.join("data.bin"), [0, 2, 255]).unwrap();
    let after = fx.commit_all("rename, binary and text");
    let repo = fx.repo();
    let patch = repo.create_commits_patch(&[after], false).unwrap();
    fx.git(&["checkout", "--detach", &before]);
    fx.write("keep.txt", "already staged\n");
    fx.git(&["add", "keep.txt"]);
    assert!(repo.apply_selected_patch(&patch, &[]).is_err());
    assert!(repo.apply_selected_patch(&patch, &[to.to_owned(), "unknown.txt".into()]).is_err());
    assert!(fx.exists(from));
    assert!(!fx.exists(to));

    let outcome = repo.apply_selected_patch(&patch, &[to.to_owned(), "data.bin".into()]).unwrap();
    assert_eq!(outcome.applied, [to, "data.bin"]);
    assert!(outcome.conflicts.is_empty());
    assert!(!fx.exists(from));
    assert_eq!(fx.read(to), "rename this file\n");
    assert_eq!(std::fs::read(fx.dir.join("data.bin")).unwrap(), [0, 2, 255]);
    assert_eq!(fx.read("keep.txt"), "already staged\n");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "keep.txt");
    assert_eq!(fx.git(&["show", ":keep.txt"]), "already staged");
}

#[test]
fn stashed_untracked_files_have_their_own_revision() {
    let fx = Fixture::new();
    fx.write("tracked.txt", "initial\n");
    fx.commit_all("initial");
    fx.write("tracked.txt", "stash tracked change\n");
    fx.write("untracked.txt", "stash untracked content\n");
    fx.git(&["stash", "push", "--include-untracked"]);

    let repo = fx.repo();
    let stashes = repo.stashes().unwrap();
    let untracked = stashes[0].untracked.as_deref().unwrap();
    let files = repo.commit_files(untracked).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "untracked.txt");
    assert_eq!(files[0].kind, ChangeKind::Added);
    assert!(!fx.exists("untracked.txt"));

    let empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let patch = repo.create_revisions_patch(empty, untracked, &[PathBuf::from("untracked.txt")]).unwrap();
    repo.apply_patch(&patch).unwrap();
    assert_eq!(fx.read("untracked.txt"), "stash untracked content\n");
    assert_eq!(fx.read("tracked.txt"), "initial\n");
    assert_eq!(repo.stashes().unwrap().len(), 1);
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
fn stage_without_content_marks_an_untracked_file_without_adding_its_contents() {
    let fx = Fixture::new();
    fx.write("base.txt", "base\n");
    fx.commit_all("base");
    fx.write("new [1].txt", "keep this text\n");
    let repo = fx.repo();
    repo.stage_without_content(&[fx.path("new [1].txt")]).unwrap();
    assert!(fx.git(&["diff", "--cached", "--name-only"]).trim().is_empty());
    let status = repo.status().unwrap();
    let file = status_of(&status, "new [1].txt").unwrap();
    assert_eq!(file.staged, None);
    assert_eq!(file.unstaged, Some(ChangeKind::Added));
    assert_eq!(fx.read("new [1].txt"), "keep this text\n");
    assert!(repo.restore_unstaged(&[fx.path("new [1].txt")]).is_err());
    assert_eq!(fx.read("new [1].txt"), "keep this text\n");
    repo.stage(&[fx.path("new [1].txt")]).unwrap();
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]).trim(), "new [1].txt");
}

#[test]
fn restore_unstaged_keeps_the_index_and_other_worktree_changes() {
    let fx = Fixture::new();
    fx.write("selected.txt", "base\n");
    fx.write("removed.txt", "initial\n");
    fx.write("other.txt", "before\n");
    fx.commit_all("base");
    fx.write("selected.txt", "staged\n");
    fx.write("removed.txt", "staged before local deletion\n");
    fx.git(&["add", "selected.txt", "removed.txt"]);
    fx.write("selected.txt", "left in the worktree\n");
    fx.write("other.txt", "unrelated\n");
    std::fs::remove_file(fx.path("removed.txt")).unwrap();
    fx.write("untracked.txt", "keep me\n");
    let repo = fx.repo();
    let before = fx.git(&["diff", "--cached", "--binary"]);
    assert!(repo.restore_unstaged(&[fx.path("selected.txt"), fx.path("untracked.txt")]).is_err());
    assert_eq!(fx.read("selected.txt"), "left in the worktree\n");
    repo.restore_unstaged(&[fx.path("selected.txt"), fx.path("removed.txt")]).unwrap();
    assert_eq!(fx.read("selected.txt"), "staged\n");
    assert_eq!(fx.read("removed.txt"), "staged before local deletion\n");
    assert_eq!(fx.read("other.txt"), "unrelated\n");
    assert_eq!(fx.read("untracked.txt"), "keep me\n");
    assert_eq!(before, fx.git(&["diff", "--cached", "--binary"]));
}

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
fn commit_crlf_checks_only_selected_content_without_a_git_policy() {
    let fx = Fixture::new();
    fx.write(".gitattributes", "normalized.txt eol=lf\nintentional.txt -text\n");
    let original: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    fx.write("partial.txt", &original);
    fx.write("retained.txt", &original.replace('\n', "\r\n"));
    fx.write("staged.txt", "base\n");
    fx.write("unstaged.txt", "base\n");
    fx.commit_all("base");

    fx.write("staged.txt", "selected\r\n");
    fx.write("unstaged.txt", "staged LF\n");
    fx.git(&["add", "staged.txt", "unstaged.txt"]);
    std::fs::remove_file(fx.path("staged.txt")).unwrap();
    fx.write("unstaged.txt", "unselected CRLF\r\n");
    fx.write("normalized.txt", "normalized\r\n");
    fx.write("intentional.txt", "intentional\r\n");
    fx.write("new file.txt", "new\r\n");
    fx.write("binary.dat", "binary\0\r\n");
    let edited = original.replace("line 2\n", "selected LF\n").replace("line 28\n", "CRLF\r\n");
    fx.write("partial.txt", &edited);
    fx.write("retained.txt", &edited);

    let repo = fx.repo();
    let paths: Vec<_> = [
        "staged.txt",
        "unstaged.txt",
        "normalized.txt",
        "intentional.txt",
        "new file.txt",
        "binary.dat",
        "partial.txt",
        "retained.txt",
    ]
    .map(|p| fx.path(p))
    .into();
    let hunks = diff_hunks(&original, &edited);
    assert_eq!(hunks.len(), 2);
    let options = |h: &LineHunk| CommitOptions {
        partial: ["partial.txt", "retained.txt"]
            .map(|path| PartialCommitFile {
                prepared: None,
                path: fx.path(path).into(),
                line_hunks: vec![],
                hunks: vec![HunkRange {
                    start: h.start,
                    lines: h.lines,
                    old_start: h.old_start,
                    old_lines: h.old_lines,
                }],
            })
            .into(),
        stage: ["normalized.txt", "intentional.txt", "new file.txt", "binary.dat"].map(|p| fx.path(p).into()).into(),
        ..Default::default()
    };
    let check = |options: CommitOptions| {
        repo.commit_crlf_paths(&paths, &options, &|_| Ok(encoding_rs::UTF_8), &CancellationToken::new())
            .unwrap()
            .into_iter()
            .map(|p| p.0.file_name().unwrap().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
    };
    let before = fx.git(&["diff", "--cached"]);
    assert_eq!(check(options(&hunks[0])), ["new file.txt", "retained.txt", "staged.txt"]);
    assert_eq!(check(options(&hunks[1])), ["new file.txt", "retained.txt", "staged.txt"]);
    assert_eq!(fx.git(&["diff", "--cached"]), before);
    for value in ["input", "yes", "1"] {
        fx.git(&["config", "core.autocrlf", value]);
        assert!(check(options(&hunks[1])).is_empty(), "core.autocrlf={value}");
    }
}

#[test]
fn commit_large_files_checks_selected_sources_and_repository_lfs_config() {
    let fx = Fixture::new();
    let original: String = (1..=30).map(|i| format!("l{i:02}\n")).collect();
    fx.write("partial.txt", &original);
    fx.write("staged.bin", "base\n");
    fx.write("worktree.txt", "base\n");
    fx.write("disk-only.txt", "base\n");
    fx.commit_all("base");

    std::fs::write(fx.path("staged.bin"), [0_u8; 219]).unwrap();
    fx.write("disk-only.txt", "small index\n");
    fx.git(&["add", "staged.bin", "disk-only.txt"]);
    std::fs::remove_file(fx.path("staged.bin")).unwrap();
    fx.write("worktree.txt", &"a".repeat(198));
    fx.write("disk-only.txt", &"b".repeat(250));
    fx.write("outside-selection.txt", &"c".repeat(300));
    let long_line = format!("{}\n", "字".repeat(70));
    let edited = original.replace("l02\n", &long_line).replace("l29\n", "small change\n");
    fx.write("partial.txt", &edited);

    let repo = fx.repo();
    let paths = ["staged.bin", "worktree.txt", "disk-only.txt", "partial.txt"].map(|p| fx.path(p));
    let hunks = diff_hunks(&original, &edited);
    assert_eq!(hunks.len(), 2);
    let options = |h: &LineHunk| CommitOptions {
        partial: vec![PartialCommitFile {
            prepared: None,
            path: fx.path("partial.txt").into(),
            line_hunks: vec![],
            hunks: vec![HunkRange { start: h.start, lines: h.lines, old_start: h.old_start, old_lines: h.old_lines }],
        }],
        stage: vec![fx.path("worktree.txt").into()],
        ..Default::default()
    };
    let check = |options: CommitOptions, limit| {
        repo.commit_large_files(&paths, &options, limit, &|_| Ok(encoding_rs::UTF_8), &CancellationToken::new())
            .unwrap()
            .into_iter()
            .map(|file| (file.path.0.file_name().unwrap().to_string_lossy().into_owned(), file.size))
            .collect::<Vec<_>>()
    };
    let before = fx.git(&["diff", "--cached", "--raw"]);
    assert_eq!(check(options(&hunks[1]), 160), [(String::from("staged.bin"), 219), ("worktree.txt".into(), 198)]);
    assert_eq!(
        check(options(&hunks[0]), 198),
        [("staged.bin".into(), 219), ("partial.txt".into(), (original.len() - 4 + long_line.len()) as u64)]
    );
    assert_eq!(fx.git(&["diff", "--cached", "--raw"]), before);
    fx.git(&["config", "lfs.repositoryformatversion", "0"]);
    assert!(check(options(&hunks[0]), 160).is_empty());
}

#[test]
fn staging_formatter_edits_uses_the_selected_index_text() {
    let fx = Fixture::new();
    fx.write("format.ts", "const value = 1;\r\n");
    fx.commit_all("base");
    fx.write("format.ts", "const value=2;\r\n");
    fx.git(&["add", "format.ts"]);
    fx.write("format.ts", "const other = 3;\r\n");
    let repo = fx.repo();
    let path = fx.path("format.ts");
    let before = "const value=2;\n";
    let formatted = "const value = 2;\n";
    repo.stage_formatted_text(&path, before, formatted, encoding_rs::UTF_8).unwrap();
    assert_eq!(repo.file_bytes_at(&path, Some(":0")).unwrap().unwrap(), b"const value = 2;\r\n");
    assert_eq!(fx.read("format.ts"), "const other = 3;\r\n");
    assert!(repo.stage_formatted_text(&path, before, formatted, encoding_rs::UTF_8).is_err());
}

#[test]
fn staging_line_hunks_read_the_renamed_index_and_unsaved_working_text() {
    let fx = Fixture::new();
    fx.write("before.txt", "one\nhead\nkeep\n");
    fx.commit_all("base");
    fx.git(&["mv", "before.txt", "after.txt"]);
    fx.write("after.txt", "one\nindex\nkeep\n");
    fx.git(&["add", "after.txt"]);
    let repo = fx.repo();
    let path = fx.path("after.txt");
    let snapshot = repo
        .staging_line_hunks(&path, Some(&fx.path("before.txt")), "one\nunsaved\nkeep\n", 1024, |_, _| {
            encoding_rs::UTF_8.into()
        })
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.hunks.len(), 1);
    let change = &snapshot.hunks[0];
    assert!(change.staged && change.unstaged);
    assert_eq!(change.head_text, "head\n");
    assert_eq!(change.index_text, "index\n");
    assert_eq!(
        snapshot.index_version,
        repo.staged_text(&path, 1024, |_| encoding_rs::UTF_8.into()).unwrap().unwrap().version
    );
    assert_eq!(fx.read("after.txt"), "one\nindex\nkeep\n");
}

#[test]
fn editing_staged_text_keeps_worktree_encoding_mode_and_other_entries() {
    let fx = Fixture::new();
    let path = fx.path("run.txt");
    let utf16 =
        |text: &str| [0xff, 0xfe].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect::<Vec<_>>();
    std::fs::write(&path, utf16("staged\r\nkeep\n")).unwrap();
    fx.write("other.txt", "original\n");
    fx.commit_all("base");
    fx.git(&["update-index", "--chmod=+x", "run.txt"]);
    fx.write("run.txt", "working copy\n");
    let repo = fx.repo();
    let encoding = |_: &[u8]| encoding_rs::UTF_16LE.into();
    assert!(repo.staged_text(&path, 3, |_| panic!("large blobs are skipped before decoding")).unwrap().is_none());
    let opened = repo.staged_text(&path, 1024, encoding).unwrap().unwrap();
    assert_eq!(opened.text, "staged\nkeep\n");

    fx.write("other.txt", "staged separately\n");
    fx.git(&["add", "other.txt"]);
    let next = repo.save_staged_text(&path, &opened.version, "edited\nkeep\n", encoding).unwrap();
    assert_ne!(opened.version, next);
    assert_eq!(repo.file_mode_at(&path, Some(":0")).unwrap().as_deref(), Some("100755"));
    assert_eq!(repo.file_bytes_at(&path, Some(":0")).unwrap().unwrap(), utf16("edited\r\nkeep\n"));
    assert_eq!(fx.read("run.txt"), "working copy\n");
    assert_eq!(fx.git(&["show", ":other.txt"]), "staged separately");

    let error = repo.save_staged_text(&path, &opened.version, "obsolete\n", encoding).unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::OutOfSync);
    assert_eq!(repo.staged_text(&path, 1024, encoding).unwrap().unwrap().version, next);
}

#[test]
fn editing_staged_text_rejects_an_index_that_git_is_updating() {
    let fx = Fixture::new();
    fx.write("a.txt", "one\n");
    fx.commit_all("base");
    let path = fx.path("a.txt");
    let repo = fx.repo();
    let encoding = |_: &[u8]| encoding_rs::UTF_8.into();
    let opened = repo.staged_text(&path, 1024, encoding).unwrap().unwrap();
    let lock = fx.path(".git/index.lock");
    std::fs::write(&lock, "another writer").unwrap();
    assert!(repo.save_staged_text(&path, &opened.version, "two\n", encoding).is_err());
    assert_eq!(std::fs::read_to_string(lock).unwrap(), "another writer");
    assert_eq!(fx.git(&["show", ":a.txt"]), "one");
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
fn branch_overwrite_preserves_the_ref_if_checkout_fails() {
    let fx = Fixture::new();
    fx.write("a.txt", "base\n");
    let base = fx.commit_all("base");
    fx.write("a.txt", "main\n");
    let tip = fx.commit_all("main");
    let repo = fx.repo();
    repo.create_branch("topic", None, false).unwrap();

    repo.create_branch_with_overwrite("topic", Some(&base), false, true).unwrap();
    assert_eq!(fx.git(&["rev-parse", "topic"]), base);
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), tip);

    repo.create_branch_with_overwrite("topic", Some(&tip), false, true).unwrap();
    fx.write("a.txt", "dirty\n");
    assert!(repo.create_branch_with_overwrite("topic", Some(&base), true, true).is_err());
    assert_eq!(fx.git(&["rev-parse", "topic"]), tip);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));
    assert_eq!(fx.read("a.txt"), "dirty\n");

    fx.write("a.txt", "main\n");
    repo.create_branch_with_overwrite("topic", Some(&base), true, true).unwrap();
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("topic"));
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), base);

    repo.create_branch_with_overwrite("topic", Some(&tip), true, true).unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), tip);
}

#[test]
fn scoped_rebase_checks_the_target_and_the_branch_for_rollback() {
    let fx = Fixture::new();
    fx.write("base.txt", "base\n");
    let base = fx.commit_all("base");
    fx.git(&["switch", "-qc", "integration"]);
    fx.write("target.txt", "integration\n");
    let onto = fx.commit_all("integration");
    fx.git(&["tag", "integration", &base]);
    fx.git(&["switch", "-q", "main"]);
    fx.write("local.txt", "local\n");
    let original = fx.commit_all("local");
    let repo = fx.repo();
    let cancel = CancellationToken::new();
    let out = |_| {};
    let plan = BranchRebasePlan {
        head: HistoryTip { branch: Some("main".into()), commit: original.clone() },
        target: "refs/heads/integration".into(),
        onto: onto.clone(),
    };

    let stale = BranchRebasePlan { onto: base, ..plan.clone() };
    assert!(repo.rebase_branch(&stale, &cancel, &out).is_err());
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), original);

    let rebased = repo.rebase_branch(&plan, &cancel, &out).unwrap();
    assert_eq!(rebased.branch.as_deref(), Some("main"));
    assert_eq!(fx.git(&["rev-parse", "HEAD^"]), onto);
    assert!(repo.branch_info().unwrap().rebase.is_none());
    fx.git(&["switch", "-qc", "same-tip"]);
    assert!(repo.restore_head_on_branch(&original, &rebased.commit, Some("main")).is_err());
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), rebased.commit);
    fx.git(&["switch", "-q", "main"]);
    repo.restore_head_on_branch(&original, &rebased.commit, Some("main")).unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), original);
}

#[test]
fn rollback_branch_creation_restores_the_checkout_and_overwritten_branch() {
    let fx = Fixture::new();
    fx.write("a.txt", "base\n");
    let base = fx.commit_all("base");
    let repo = fx.repo();
    repo.create_branch("topic", None, false).unwrap();
    fx.git(&["branch", "--set-upstream-to=main", "topic"]);
    fx.write("a.txt", "main\n");
    let tip = fx.commit_all("main");
    let before = ide_vcs::HistoryTip { branch: Some("main".into()), commit: tip.clone() };

    assert!(repo.create_branch_recorded("topic", None, true, true, Some(&tip)).is_err());
    assert_eq!(fx.git(&["rev-parse", "topic"]), base);
    let created = repo.create_branch_recorded("topic", None, true, true, Some(&base)).unwrap();
    assert_eq!(created.tip, tip);
    repo.undo_branch_creation("topic", &created, Some(&before)).unwrap();
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));
    assert_eq!(fx.git(&["rev-parse", "topic"]), base);
    assert_eq!(fx.git(&["rev-parse", "topic@{upstream}"]), tip);

    let created = repo.create_branch_recorded("new", Some(&base), true, false, None).unwrap();
    repo.undo_branch_creation("new", &created, Some(&before)).unwrap();
    assert!(!repo.branches().unwrap().iter().any(|branch| branch.name == "new"));
    assert_eq!(fx.read("a.txt"), "main\n");

    let created = repo.create_branch_recorded("advanced", Some(&base), false, false, None).unwrap();
    fx.git(&["branch", "--force", "advanced", &tip]);
    assert!(repo.undo_branch_creation("advanced", &created, None).is_err());
    assert_eq!(fx.git(&["rev-parse", "advanced"]), tip);
}

#[test]
fn new_branch_smart_checkout_preserves_local_edits_in_both_directions() {
    let fx = Fixture::new();
    fx.write("f.txt", "1\n2\n3\n4\n5\n");
    let base = fx.commit_all("base");
    fx.git(&["switch", "-q", "-c", "source"]);
    fx.write("f.txt", "1\nsource\n3\n4\n5\n");
    let source = fx.commit_all("source");
    fx.git(&["switch", "-q", "main"]);
    fx.write("f.txt", "1\n2\n3\n4\nlocal\n");
    fx.git(&["add", "--", "f.txt"]);
    fx.write("f.txt", "1\n2\n3\n4\nlocal\nunstaged\n");
    let repo = fx.repo();
    let normal = CheckoutOptions::default();
    let blocked = repo.create_branch_with("new", Some("refs/heads/source"), Some(&normal), false, None).unwrap();
    assert_eq!(blocked.checkout, CheckoutOutcome::LocalChanges { files: vec!["f.txt".into()] });
    assert!(blocked.created.is_none());
    assert!(!repo.branches().unwrap().iter().any(|branch| branch.name == "new"));

    let smart = CheckoutOptions { mode: CheckoutMode::Smart, ..Default::default() };
    let outcome = repo.create_branch_with("new", Some("refs/heads/source"), Some(&smart), false, None).unwrap();
    assert_eq!(outcome.checkout, CheckoutOutcome::Done);
    let receipt = outcome.created.unwrap();
    assert_eq!(receipt.tip, source);
    assert_eq!(fx.read("f.txt"), "1\nsource\n3\n4\nlocal\nunstaged\n");
    assert_eq!(fx.git(&["show", ":f.txt"]), "1\nsource\n3\n4\nlocal");
    assert!(repo.stashes().unwrap().is_empty());

    repo.undo_branch_creation("new", &receipt, Some(&HistoryTip { branch: Some("main".into()), commit: base }))
        .unwrap();
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));
    assert_eq!(fx.read("f.txt"), "1\n2\n3\n4\nlocal\nunstaged\n");
    assert_eq!(fx.git(&["show", ":f.txt"]), "1\n2\n3\n4\nlocal");
    assert!(!repo.branches().unwrap().iter().any(|branch| branch.name == "new"));
    assert!(repo.stashes().unwrap().is_empty());

    fx.git(&["reset", "-q", "HEAD", "--", "f.txt"]);
    fx.write("f.txt", "1\nlocal\n3\n4\n5\n");
    let conflicted = repo.create_branch_with("conflict", Some(&source), Some(&smart), false, None).unwrap();
    assert_eq!(conflicted.checkout, CheckoutOutcome::Conflicts { files: vec!["f.txt".into()] });
    assert_eq!(conflicted.created.unwrap().tip, source);
    assert_eq!(repo.stashes().unwrap().len(), 1);
}

#[test]
fn new_branch_from_remote_branch_tracks_it_only_under_the_same_name() {
    let (fx, bare) = Fixture::with_origin();
    fx.git(&["push", "-q", "origin", "main:release"]);
    fx.git(&["fetch", "-q"]);
    let repo = fx.repo();
    let upstream = |name: &str| {
        repo.branches().unwrap().into_iter().find(|b| b.name == name && !b.remote).and_then(|b| b.upstream)
    };

    repo.create_branch("release", Some("origin/release"), false).unwrap();
    assert_eq!(upstream("release").as_deref(), Some("origin/release"));

    // Another name: no upstream, whether switched to or not, created plainly or overwritten.
    repo.create_branch("other", Some("origin/release"), false).unwrap();
    assert_eq!(upstream("other"), None);
    repo.create_branch_with_overwrite("other", Some("origin/main"), false, true).unwrap();
    assert_eq!(upstream("other"), None);
    repo.create_branch("my-release", Some("origin/release"), true).unwrap();
    let info = repo.branch_info().unwrap();
    assert_eq!(info.head.as_deref(), Some("my-release"));
    assert_eq!(info.upstream, None);

    // The first push then goes to a branch of its own name and tracks it.
    fx.write("a.txt", "mine\n");
    let tip = fx.commit_all("mine");
    let (cancel, out) = quiet();
    repo.push(false, true, &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "my-release"]), tip);
    assert_ne!(git_in(&bare, &["rev-parse", "release"]), tip);
    assert_eq!(fx.git(&["config", "branch.my-release.merge"]), "refs/heads/my-release");

    // New worktree on a new branch from a remote branch: the same rule.
    let wt = fx.tmp.path().join("wt");
    repo.add_worktree(&wt, "origin/release", Some("wt-branch")).unwrap();
    assert_eq!(upstream("wt-branch"), None);
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

    let blame = repo.blame(&fx.path("a.txt"), Some("1\nchanged\nunsaved\n"), None, encoding_rs::UTF_8).unwrap();
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

#[test]
fn interactive_rebase_restores_local_changes_staged_as_they_were() {
    let (fx, ids) = linear();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    fx.write("f1.txt", "staged\n");
    fx.git(&["add", "f1.txt"]);
    fx.write("f2.txt", "unstaged\n");
    repo.interactive_rebase(
        Some(&ids[1]),
        &[entry(&ids[2], RebaseAction::Drop, None), entry(&ids[3], RebaseAction::Pick, None)],
        &cancel,
        &out,
    )
    .unwrap();
    assert_eq!(fx.subjects(), vec!["c4", "c2", "c1"]);
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "f1.txt");
    assert_eq!(fx.git(&["diff", "--name-only"]), "f2.txt");
    assert!(fx.git(&["stash", "list"]).is_empty());
    assert!(!fx.path(".git/openidea-rebase").exists());
}

#[test]
fn local_changes_come_back_once_a_stopped_rebase_is_continued() {
    let (fx, ids) = linear();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    // c4 rewrites f3.txt so that dropping c3 conflicts.
    fx.write("f3.txt", "3\nmore\n");
    fx.commit_all("c5");
    let c5 = fx.git(&["rev-parse", "HEAD"]);
    fx.write("f1.txt", "external copy\n");
    let external = fx.git(&["stash", "create"]);
    fx.write("f1.txt", "staged\n");
    fx.git(&["add", "f1.txt"]);
    let result = repo.interactive_rebase(
        Some(&ids[1]),
        &[
            entry(&ids[2], RebaseAction::Drop, None),
            entry(&ids[3], RebaseAction::Pick, None),
            entry(&c5, RebaseAction::Pick, None),
        ],
        &cancel,
        &out,
    );
    assert!(result.is_err());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    assert_eq!(fx.read("f1.txt"), "1\n", "put aside while the rebase is stopped");
    let stash = repo.stashes().unwrap().remove(0);
    fx.git(&["stash", "store", "-m", "external", &external]);
    fx.git(&["stash", "store", "-m", "keep a copy", &stash.id]);
    assert_eq!(repo.stashes().unwrap().len(), 3);
    fx.write("f3.txt", "3\nmore\n");
    repo.stage(&[fx.path("f3.txt")]).unwrap();
    repo.continue_operation(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.read("f1.txt"), "staged\n");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "f1.txt");
    assert!(matches!(
        repo.stashes().unwrap().as_slice(),
        [entry, other] if entry.id == stash.id && entry.message == "keep a copy" && other.id == external
    ));
}

#[test]
fn rebase_restores_its_shelf_after_garbage_collection_and_a_settings_change() {
    let fx = Fixture::new();
    fx.write("shared.txt", "base\n");
    fx.write("local.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["switch", "-qc", "other"]);
    fx.write("shared.txt", "other\n");
    fx.commit_all("other edit");
    fx.git(&["switch", "-q", "main"]);
    fx.write("shared.txt", "main\n");
    fx.commit_all("main edit");
    fx.write("local.txt", "staged\n");
    fx.git(&["add", "local.txt"]);
    let repo = fx.repo();
    let shelf_dir = fx.path(".openidea/shelf");
    repo.set_automatic_shelf(Some(shelf_dir.clone()), None);
    let (cancel, out) = quiet();
    assert!(repo.rebase("other").is_err());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    assert_eq!(fx.read("local.txt"), "base\n");
    assert!(repo.stashes().unwrap().is_empty());
    let entries = shelf::list(&shelf_dir).unwrap();
    assert_eq!(entries.len(), 1);
    let marker: serde_json::Value = serde_json::from_str(&fx.read(".git/openidea-saved-changes")).unwrap();
    let snapshot = marker["snapshot"].as_str().unwrap();
    fx.git(&["gc", "--prune=now"]);
    assert!(!fx.git(&["rev-list", "--all"]).lines().any(|id| id == snapshot));
    assert!(!Command::new("git").current_dir(&fx.dir).args(["cat-file", "-e", snapshot]).status().unwrap().success());

    let reopened = fx.repo(); // The settings now select Stash.
    reopened.skip_operation(&cancel, &out).unwrap();
    assert_eq!(reopened.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["show", ":local.txt"]), "staged");
    assert!(shelf::list(&shelf_dir).unwrap().is_empty());
    assert!(!fx.exists(".git/openidea-saved-changes"));
}

fn pause_rebase_with_grouped_shelves() -> (Fixture, PathBuf) {
    let fx = Fixture::new();
    for file in ["shared.txt", "keep.txt", "discard-file.txt", "discard-list.txt", "rename-old.txt"] {
        fx.write(file, "base\n");
    }
    fx.commit_all("base");
    fx.git(&["switch", "-qc", "other"]);
    fx.write("shared.txt", "other\n");
    fx.commit_all("other");
    fx.git(&["switch", "-q", "main"]);
    fx.write("shared.txt", "main\n");
    fx.commit_all("main");
    fx.write("keep.txt", "staged\n");
    fx.git(&["add", "keep.txt"]);
    fx.write("keep.txt", "base\n");
    fx.write("discard-file.txt", "discard one file\n");
    fx.write("discard-list.txt", "discard the list\n");
    fx.git(&["mv", "rename-old.txt", "rename-new.txt"]);

    let project = fx.tmp.path();
    let shelf_dir = ide_core::project_dir::path(project, "shelf");
    let mut lists = ChangelistState::initial();
    lists.lists.push(Changelist {
        id: "discard".into(),
        name: "Discard".into(),
        comment: String::new(),
        applied_commit: None,
    });
    lists.files.insert("work/discard-list.txt".into(), "discard".into());
    lists.files.insert("work/rename-new.txt".into(), "discard".into());
    changelists::save(&ide_core::project_dir::path(project, "changelists.json"), &lists).unwrap();
    let repo = fx.repo();
    repo.set_automatic_shelf(Some(shelf_dir.clone()), Some(project.to_path_buf()));
    assert!(repo.rebase("other").is_err());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    (fx, shelf_dir)
}

#[test]
fn rebase_shelves_changelists_separately_and_restores_only_retained_files() {
    let (fx, shelf_dir) = pause_rebase_with_grouped_shelves();
    let entries = shelf::list(&shelf_dir).unwrap();
    assert_eq!(entries.len(), 2);
    let discard = entries.iter().find(|entry| entry.name.starts_with("[Discard] ")).unwrap();
    assert_eq!(
        discard.files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
        ["discard-list.txt", "rename-new.txt", "rename-old.txt"]
    );
    let changes = entries.iter().find(|entry| entry.name.starts_with("[Changes] ")).unwrap();
    assert_eq!(changes.files.len(), 2);
    shelf::delete(&shelf_dir, &discard.id).unwrap();
    shelf::delete_path(&shelf_dir, &changes.id, Some("discard-file.txt")).unwrap();
    fx.git(&["gc", "--prune=now"]);

    let (cancel, out) = quiet();
    fx.repo().skip_operation(&cancel, &out).unwrap();
    assert_eq!(fx.git(&["show", ":keep.txt"]), "staged");
    for file in ["keep.txt", "discard-file.txt", "discard-list.txt", "rename-old.txt"] {
        assert_eq!(fx.read(file), "base\n");
    }
    assert!(!fx.exists("rename-new.txt"));
    assert!(shelf::list(&shelf_dir).unwrap().is_empty());
    assert!(std::fs::read_dir(&shelf_dir).unwrap().all(|entry| entry.unwrap().file_name() == ".gitignore"));
}

#[test]
fn rebase_keeps_shelves_and_archive_if_a_group_cannot_be_read_as_a_patch() {
    let (fx, shelf_dir) = pause_rebase_with_grouped_shelves();
    let entries = shelf::list(&shelf_dir).unwrap();
    let patch = shelf_dir.join(&entries[0].id).join("shelved.patch");
    std::fs::write(&patch, "incomplete patch").unwrap();

    let (cancel, out) = quiet();
    let error = fx.repo().skip_operation(&cancel, &out).unwrap_err();
    assert!(error.message.contains("no file changes found"));
    assert_eq!(std::fs::read_to_string(patch).unwrap(), "incomplete patch");
    assert_eq!(shelf::list(&shelf_dir).unwrap().len(), 2);
    assert!(
        std::fs::read_dir(&shelf_dir).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".snapshot-"))
    );
}

#[test]
fn merge_brings_staged_changes_back_staged() {
    let (fx, _ids) = linear();
    let repo = fx.repo();
    fx.git(&["checkout", "-q", "-b", "side", "HEAD~1"]);
    fx.write("side.txt", "side\n");
    fx.git(&["add", "side.txt"]);
    fx.git(&["commit", "-q", "-m", "side"]);
    fx.git(&["checkout", "-q", "main"]);
    fx.write("f1.txt", "staged\n");
    fx.git(&["add", "f1.txt"]);
    fx.write("f2.txt", "unstaged\n");
    repo.merge_with(&["side".to_string()], &MergeOptions::default()).unwrap();
    assert!(fx.exists("side.txt"));
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "f1.txt");
    assert_eq!(fx.git(&["diff", "--name-only"]), "f2.txt");
    assert!(fx.git(&["stash", "list"]).is_empty());
}

#[test]
fn local_changes_come_back_after_a_conflicting_merge_is_committed() {
    let (fx, _ids) = linear();
    let repo = fx.repo();
    fx.git(&["checkout", "-q", "-b", "side", "HEAD~1"]);
    fx.write("f4.txt", "side\n");
    fx.git(&["add", "f4.txt"]);
    fx.git(&["commit", "-q", "-m", "side f4"]);
    fx.git(&["checkout", "-q", "main"]);
    fx.write("f1.txt", "staged\n");
    fx.git(&["add", "f1.txt"]);
    assert!(repo.merge_with(&["side".to_string()], &MergeOptions::default()).is_err());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("merge"));
    assert_eq!(fx.read("f1.txt"), "1\n", "put aside while the merge is in progress");
    fx.write("f4.txt", "both\n");
    repo.stage(&[fx.path("f4.txt")]).unwrap();
    repo.commit("Merge side", false, false).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.read("f1.txt"), "staged\n");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "f1.txt");
    assert!(fx.git(&["stash", "list"]).is_empty());
}
