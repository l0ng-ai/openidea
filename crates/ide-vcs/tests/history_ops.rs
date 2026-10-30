//! Rebase / cherry-pick / revert / reset / tags, the shelf and patches, against
//! throwaway repositories created with the git CLI.

use ide_core::CancellationToken;
use ide_vcs::*;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Fixture {
    _tmp: tempfile::TempDir,
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

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("work");
        std::fs::create_dir(&dir).unwrap();
        git_in(&dir, &["init", "-q"]);
        for (k, v) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.hooksPath", ".git/hooks"),
            ("merge.conflictstyle", "merge"),
        ] {
            git_in(&dir, &["config", k, v]);
        }
        Fixture { _tmp: tmp, dir }
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
    fn commit_all(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"])
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

/// main: base → "main" edit of f.txt; topic: base → "topic" edit of f.txt.
fn diverged() -> Fixture {
    let fx = Fixture::new();
    fx.write("f.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "topic"]);
    fx.write("f.txt", "topic\n");
    fx.write("t.txt", "t\n");
    fx.commit_all("topic edit");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("f.txt", "main\n");
    fx.commit_all("main edit");
    fx.git(&["checkout", "-q", "topic"]);
    fx
}

#[test]
fn rebase_conflict_then_continue() {
    let fx = diverged();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    assert!(repo.rebase("main").is_err());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    // Unresolved conflicts block Continue.
    let err = repo.continue_operation(&cancel, &out).unwrap_err();
    assert!(err.message.contains("f.txt"), "{}", err.message);

    fx.write("f.txt", "resolved\n");
    repo.stage(&[fx.path("f.txt")]).unwrap();
    repo.continue_operation(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.read("f.txt"), "resolved\n");
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]), "topic edit");
    assert_eq!(fx.git(&["rev-parse", "HEAD~1"]), fx.git(&["rev-parse", "main"]));
}

#[test]
fn merge_versions_put_the_users_work_on_the_left() {
    // Rebase: git's "ours" is main; the user's commit (topic) must be `ours` here.
    let fx = diverged();
    let repo = fx.repo();
    let topic = fx.git(&["rev-parse", "topic"]);
    assert!(repo.rebase("main").is_err());
    let v = repo.merge_versions(&fx.path("f.txt"), encoding_rs::UTF_8).unwrap();
    assert_eq!(v.ours.as_deref(), Some("topic\n"));
    assert_eq!(v.theirs.as_deref(), Some("main\n"));
    assert_eq!(v.base.as_deref(), Some("base\n"));
    assert!(v.sides.reversed);
    assert_eq!(v.sides.operation.as_deref(), Some("rebase"));
    assert_eq!(v.sides.branch.as_deref(), Some("topic"));
    assert_eq!(v.sides.other_branch.as_deref(), Some("main"));
    assert_eq!(v.sides.commit.as_deref(), Some(&topic[..8]));
    // The merged text puts the user's side first, whatever git's stage order.
    assert_eq!(v.merged.as_deref(), Some("<<<<<<< yours\ntopic\n||||||| base\nbase\n=======\nmain\n>>>>>>> theirs\n"));
    let (cancel, out) = quiet();
    repo.abort_operation(&cancel, &out).unwrap();

    // Merge: not swapped; the merged branch is named.
    assert!(repo.merge("main").is_err());
    let v = repo.merge_versions(&fx.path("f.txt"), encoding_rs::UTF_8).unwrap();
    assert_eq!(v.ours.as_deref(), Some("topic\n"));
    assert_eq!(v.theirs.as_deref(), Some("main\n"));
    assert!(!v.sides.reversed);
    assert_eq!(v.sides.branch.as_deref(), Some("topic"));
    assert_eq!(v.sides.other_branch.as_deref(), Some("main"));
    repo.abort_operation(&cancel, &out).unwrap();

    // Cherry-pick: not swapped; the picked commit is named.
    let main = fx.git(&["rev-parse", "main"]);
    assert!(repo.cherry_pick(std::slice::from_ref(&main), &cancel, &out).is_err());
    let v = repo.merge_versions(&fx.path("f.txt"), encoding_rs::UTF_8).unwrap();
    assert_eq!(v.ours.as_deref(), Some("topic\n"));
    assert!(!v.sides.reversed);
    assert_eq!(v.sides.operation.as_deref(), Some("cherry-pick"));
    assert_eq!(v.sides.commit.as_deref(), Some(&main[..8]));
    repo.abort_operation(&cancel, &out).unwrap();
    assert_eq!(repo.merge_sides().unwrap(), MergeSides { branch: Some("topic".into()), ..Default::default() });
}

#[test]
fn rebase_conflict_then_abort_and_skip() {
    let fx = diverged();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let before = fx.git(&["rev-parse", "HEAD"]);
    assert!(repo.rebase("main").is_err());
    repo.abort_operation(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), before);
    assert_eq!(fx.read("f.txt"), "topic\n");

    assert!(repo.rebase("main").is_err());
    repo.skip_operation(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), fx.git(&["rev-parse", "main"]));

    // Nothing in progress.
    assert!(repo.abort_operation(&cancel, &out).is_err());
}

#[test]
fn merge_conflict_continue_commits() {
    let fx = diverged();
    fx.git(&["checkout", "-q", "main"]);
    let repo = fx.repo();
    let (cancel, out) = quiet();
    assert!(repo.merge("topic").is_err());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("merge"));
    assert!(repo.skip_operation(&cancel, &out).is_err(), "merges cannot be skipped");
    fx.write("f.txt", "both\n");
    repo.stage(&[fx.path("f.txt")]).unwrap();
    repo.continue_operation(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["rev-list", "--count", "--merges", "HEAD"]), "1");
}

#[test]
fn cherry_pick_and_conflicting_cherry_pick() {
    let fx = diverged();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    fx.git(&["checkout", "-q", "-b", "side", "main~1"]);
    fx.write("s.txt", "side\n");
    let side = fx.commit_all("side work");
    fx.git(&["checkout", "-q", "main"]);

    repo.cherry_pick(&[side], &cancel, &out).unwrap();
    assert_eq!(fx.read("s.txt"), "side\n");
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]), "side work");

    let topic = fx.git(&["rev-parse", "topic"]);
    assert!(repo.cherry_pick(std::slice::from_ref(&topic), &cancel, &out).is_err());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("cherry-pick"));
    fx.write("f.txt", "picked\n");
    repo.stage(&[fx.path("f.txt")]).unwrap();
    repo.continue_operation(&cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]), "topic edit");
    assert!(repo.cherry_pick(&[], &cancel, &out).is_err());
}

#[test]
fn revert_creates_inverse_commit() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.commit_all("one");
    fx.write("a.txt", "2\n");
    let two = fx.commit_all("two");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    repo.revert(&[two], &cancel, &out).unwrap();
    assert_eq!(fx.read("a.txt"), "1\n");
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]), "Revert \"two\"");
    assert_eq!(fx.git(&["rev-list", "--count", "HEAD"]), "3");
}

#[test]
fn reset_modes() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let one = fx.commit_all("one");
    fx.write("a.txt", "2\n");
    let two = fx.commit_all("two");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let status = |repo: &Repo| {
        let st = repo.status().unwrap();
        st.iter().find(|s| s.rel_path == "a.txt").map(|s| (s.staged, s.unstaged))
    };

    repo.reset(&one, ResetMode::Soft, &cancel, &out).unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), one);
    assert_eq!(status(&repo), Some((Some(ChangeKind::Modified), None)));

    fx.git(&["reset", "-q", "--hard", &two]);
    repo.reset(&one, ResetMode::Mixed, &cancel, &out).unwrap();
    assert_eq!(status(&repo), Some((None, Some(ChangeKind::Modified))));
    assert_eq!(fx.read("a.txt"), "2\n");

    fx.git(&["reset", "-q", "--hard", &two]);
    fx.write("other.txt", "keep me\n");
    fx.git(&["add", "other.txt"]);
    fx.git(&["commit", "-q", "-m", "three"]);
    fx.write("other.txt", "local edit\n");
    repo.reset(&two, ResetMode::Keep, &cancel, &out).unwrap_err();
    fx.git(&["checkout", "--", "other.txt"]);
    fx.write("a.txt", "local\n");
    // `--keep` keeps local changes of files the reset does not touch.
    repo.reset(&two, ResetMode::Keep, &cancel, &out).unwrap();
    assert_eq!(fx.read("a.txt"), "local\n");
    assert!(!fx.path("other.txt").exists());

    repo.reset(&one, ResetMode::Hard, &cancel, &out).unwrap();
    assert_eq!(fx.read("a.txt"), "1\n");
    assert!(repo.status().unwrap().is_empty());
}

#[test]
fn tags_lightweight_and_annotated() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let one = fx.commit_all("one");
    fx.write("a.txt", "2\n");
    fx.commit_all("two");
    let repo = fx.repo();
    repo.create_tag("v1.0", &one, None, false).unwrap();
    repo.create_tag("v2.0", "HEAD", Some("Release 2"), false).unwrap();
    assert_eq!(repo.tags().unwrap(), vec!["v1.0".to_string(), "v2.0".to_string()]);
    assert_eq!(fx.git(&["rev-parse", "v1.0^{commit}"]), one);
    assert_eq!(fx.git(&["cat-file", "-t", "v2.0"]), "tag");
    assert!(repo.create_tag("v1.0", "HEAD", None, false).is_err(), "existing tag needs force");
    repo.create_tag("v1.0", "HEAD", None, true).unwrap();
    assert!(repo.create_tag("bad..name", "HEAD", None, false).is_err());
    assert!(repo.create_tag("-x", "HEAD", None, false).is_err());
    assert!(repo.create_tag("ok", "no-such-rev", None, false).is_err());
    let log = repo.log(&LogQuery { branch: Some("HEAD".into()), ..Default::default() }).unwrap();
    assert!(log[0].refs.contains(&"tag: v2.0".to_string()), "{:?}", log[0].refs);
}

#[test]
fn compare_with_local_lists_differences() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.write("b.txt", "b\n");
    let one = fx.commit_all("one");
    fx.write("a.txt", "2\n");
    fx.write("c.txt", "c\n");
    fx.commit_all("two");
    fx.write("b.txt", "local\n");
    let files = fx.repo().diff_with_worktree(&one).unwrap();
    let got: Vec<(&str, ChangeKind)> = files.iter().map(|f| (f.path.as_str(), f.kind)).collect();
    assert_eq!(
        got,
        vec![("a.txt", ChangeKind::Modified), ("b.txt", ChangeKind::Modified), ("c.txt", ChangeKind::Added)]
    );
    // Between two revisions the working tree does not count.
    let files = fx.repo().diff_revisions(&one, "HEAD").unwrap();
    let got: Vec<(&str, ChangeKind)> = files.iter().map(|f| (f.path.as_str(), f.kind)).collect();
    assert_eq!(got, vec![("a.txt", ChangeKind::Modified), ("c.txt", ChangeKind::Added)]);
    assert!(fx.repo().diff_revisions("-x", "HEAD").is_err());
}

#[test]
fn shelve_unshelve_round_trip() {
    let fx = Fixture::new();
    fx.write("mod.txt", "one\ntwo\n");
    fx.write("del.txt", "doomed\n");
    fx.write("keep.txt", "keep\n");
    fx.commit_all("base");
    fx.write("mod.txt", "one\nTWO\n");
    std::fs::remove_file(fx.path("del.txt")).unwrap();
    fx.write("new/untracked.txt", "fresh\n");
    fx.write("keep.txt", "not shelved\n");
    fx.git(&["add", "mod.txt"]);
    let repo = fx.repo();
    let shelf = fx._tmp.path().join("shelf");

    let paths = [fx.path("mod.txt"), fx.path("del.txt"), fx.path("new/untracked.txt")];
    let entry = repo.shelve(&shelf, "My work", &paths).unwrap();
    assert_eq!(entry.name, "My work");
    assert_eq!(entry.branch.as_deref(), Some("main"));
    assert_eq!(entry.files.len(), 3);
    // Shelved changes are gone; the rest stays.
    assert_eq!(fx.read("mod.txt"), "one\ntwo\n");
    assert_eq!(fx.read("del.txt"), "doomed\n");
    assert!(!fx.path("new/untracked.txt").exists());
    assert_eq!(fx.read("keep.txt"), "not shelved\n");
    let st = repo.status().unwrap();
    assert_eq!(st.len(), 1, "{st:#?}");

    let listed = shelf::list(&shelf).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, entry.id);
    shelf::rename(&shelf, &entry.id, "Renamed").unwrap();
    assert_eq!(shelf::list(&shelf).unwrap()[0].name, "Renamed");
    assert!(shelf::patch_of(&shelf, &entry.id).unwrap().contains("TWO"));

    let outcome = repo.unshelve(&shelf, &entry.id, true).unwrap();
    assert!(outcome.conflicts.is_empty());
    assert_eq!(fx.read("mod.txt"), "one\nTWO\n");
    assert!(!fx.path("del.txt").exists());
    assert_eq!(fx.read("new/untracked.txt"), "fresh\n");
    assert!(shelf::list(&shelf).unwrap().is_empty());

    assert!(repo.shelve(&shelf, "nothing", &[fx.path("del-none.txt")]).is_err());
    assert!(shelf::delete(&shelf, "../work").is_err());
}

#[test]
fn unshelve_with_conflict_leaves_merge_state() {
    let fx = Fixture::new();
    fx.write("f.txt", "a\nb\nc\n");
    fx.commit_all("base");
    fx.write("f.txt", "a\nSHELVED\nc\n");
    let repo = fx.repo();
    let shelf = fx._tmp.path().join("shelf");
    let entry = repo.shelve(&shelf, "conflicting", &[fx.path("f.txt")]).unwrap();
    fx.write("f.txt", "a\nCOMMITTED\nc\n");
    fx.commit_all("diverge");

    let outcome = repo.unshelve(&shelf, &entry.id, false).unwrap();
    assert_eq!(outcome.conflicts, vec!["f.txt".to_string()]);
    let text = fx.read("f.txt");
    assert!(text.contains("<<<<<<<") && text.contains("SHELVED") && text.contains("COMMITTED"), "{text}");
    let (base, ours, theirs) = repo.conflict_versions(&fx.path("f.txt"), encoding_rs::UTF_8).unwrap();
    assert!(base.is_some() && ours.unwrap().contains("COMMITTED") && theirs.unwrap().contains("SHELVED"));
    // Kept on the shelf when not removing.
    assert_eq!(shelf::list(&shelf).unwrap().len(), 1);
    shelf::delete(&shelf, &entry.id).unwrap();
    assert!(shelf::list(&shelf).unwrap().is_empty());
}

#[test]
fn create_and_apply_patches() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n2\n3\n");
    fx.commit_all("base");
    fx.write("a.txt", "1\nTWO\n3\n");
    fx.write("n.txt", "new\n");
    let repo = fx.repo();
    let patch = repo.create_patch(&[fx.path("a.txt"), fx.path("n.txt")], false).unwrap();
    assert!(patch.contains("+TWO") && patch.contains("new file mode"), "{patch}");
    // The real index is untouched.
    assert!(repo.status().unwrap().iter().all(|s| s.staged.is_none()));

    let reverse = repo.create_patch(&[fx.path("a.txt")], true).unwrap();
    assert!(reverse.contains("-TWO") && reverse.contains("+2"));

    fx.git(&["checkout", "--", "a.txt"]);
    std::fs::remove_file(fx.path("n.txt")).unwrap();
    let preview = repo.patch_preview(&patch).unwrap();
    let got: Vec<(&str, ChangeKind, u32, u32, bool)> =
        preview.iter().map(|f| (f.path.as_str(), f.kind, f.added, f.removed, f.applies)).collect();
    assert_eq!(got, vec![("a.txt", ChangeKind::Modified, 1, 1, true), ("n.txt", ChangeKind::Added, 1, 0, true)]);

    let outcome = repo.apply_patch(&patch).unwrap();
    assert!(outcome.conflicts.is_empty());
    assert_eq!(fx.read("a.txt"), "1\nTWO\n3\n");
    assert_eq!(fx.read("n.txt"), "new\n");

    // Applying again: n.txt exists, a.txt no longer matches.
    let preview = repo.patch_preview(&patch).unwrap();
    assert!(preview.iter().all(|f| !f.applies), "{preview:#?}");
    assert!(repo.apply_patch("").is_err());
    assert!(repo.patch_preview("not a patch\n").is_err());
}

#[test]
fn patch_from_commits_applies_elsewhere() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let root = fx.commit_all("root");
    fx.write("a.txt", "1\n2\n");
    let c2 = fx.commit_all("two");
    fx.write("b.txt", "b\n");
    let c3 = fx.commit_all("three");
    let repo = fx.repo();
    let patch = repo.create_commits_patch(&[c2, c3], false).unwrap();
    assert!(patch.contains("+2") && patch.contains("b.txt"));
    let root_patch = repo.create_commits_patch(std::slice::from_ref(&root), false).unwrap();
    assert!(root_patch.contains("new file mode"));

    fx.git(&["checkout", "-q", "--detach", &root]);
    let outcome = repo.apply_patch(&patch).unwrap();
    assert!(outcome.conflicts.is_empty());
    assert_eq!(fx.read("a.txt"), "1\n2\n");
    assert_eq!(fx.read("b.txt"), "b\n");
}

#[test]
fn push_with_tags() {
    let fx = Fixture::new();
    let bare = fx._tmp.path().join("origin.git");
    git_in(fx._tmp.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    fx.write("a.txt", "1\n");
    fx.commit_all("one");
    fx.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
    fx.git(&["push", "-q", "-u", "origin", "main"]);
    let repo = fx.repo();
    let (cancel, out) = quiet();
    repo.create_tag("light", "HEAD", None, false).unwrap();
    fx.write("a.txt", "2\n");
    fx.commit_all("two");
    repo.create_tag("v2", "HEAD", Some("annotated"), false).unwrap();

    repo.push_with_tags(false, false, Some(PushTags::CurrentBranch), &cancel, &out).unwrap();
    let remote_tags = || git_in(&bare, &["tag", "--list"]);
    assert_eq!(remote_tags(), "v2");
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), fx.git(&["rev-parse", "HEAD"]));

    fx.write("a.txt", "3\n");
    fx.commit_all("three");
    repo.push_with_tags(false, false, Some(PushTags::All), &cancel, &out).unwrap();
    assert_eq!(remote_tags(), "light\nv2");
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), fx.git(&["rev-parse", "HEAD"]));
}

#[test]
fn push_branch_and_up_to_revision() {
    let fx = Fixture::new();
    let bare = fx._tmp.path().join("origin.git");
    git_in(fx._tmp.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    fx.write("a.txt", "1\n");
    fx.commit_all("one");
    fx.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
    fx.git(&["push", "-q", "-u", "origin", "main"]);
    let c2 = {
        fx.write("a.txt", "2\n");
        fx.commit_all("two")
    };
    fx.write("a.txt", "3\n");
    let c3 = fx.commit_all("three");
    let repo = fx.repo();
    let (cancel, out) = quiet();

    repo.push_branch("main", Some(&c2), false, &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), c2);
    repo.push_branch("main", None, false, &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "main"]), c3);

    // A branch other than HEAD, without upstream: pushed under its name and tracked.
    fx.git(&["branch", "side", &c2]);
    repo.push_branch("side", None, false, &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "side"]), c2);
    assert_eq!(fx.git(&["rev-parse", "--abbrev-ref", "side@{upstream}"]), "origin/side");
    assert!(repo.push_branch("nope", None, false, &cancel, &out).is_err());

    // An edited target: same remote, another branch name; the upstream stays as it was.
    fn opts<'a>(target: Option<&'a str>, remote: Option<&'a str>) -> PushBranchOptions<'a> {
        PushBranchOptions { target, remote, ..Default::default() }
    }
    repo.push_branch_to("main", opts(Some("review/main"), None), &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "review/main"]), c3);
    assert_eq!(fx.git(&["rev-parse", "--abbrev-ref", "main@{upstream}"]), "origin/main");
    assert!(repo.push_branch_to("main", opts(Some("bad..name"), None), &cancel, &out).is_err());

    // A chosen remote: same branch name, pushed to the other remote.
    let bare2 = fx._tmp.path().join("backup.git");
    git_in(fx._tmp.path(), &["init", "-q", "--bare", bare2.to_str().unwrap()]);
    fx.git(&["remote", "add", "backup", bare2.to_str().unwrap()]);
    repo.push_branch_to("main", opts(None, Some("backup")), &cancel, &out).unwrap();
    assert_eq!(git_in(&bare2, &["rev-parse", "main"]), c3);
    assert_eq!(fx.git(&["rev-parse", "--abbrev-ref", "main@{upstream}"]), "origin/main");
}

#[test]
fn update_branch_fast_forwards_a_branch_not_checked_out() {
    let fx = Fixture::new();
    let bare = fx._tmp.path().join("origin.git");
    git_in(fx._tmp.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    fx.write("a.txt", "1\n");
    fx.commit_all("one");
    fx.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
    fx.git(&["push", "-q", "-u", "origin", "main"]);
    fx.git(&["checkout", "-q", "-b", "work"]);
    // Someone else advances origin/main.
    let other = fx._tmp.path().join("other");
    git_in(fx._tmp.path(), &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
    std::fs::write(other.join("a.txt"), "2\n").unwrap();
    git_in(&other, &["-c", "user.name=O", "-c", "user.email=o@x", "commit", "-q", "-am", "two"]);
    git_in(&other, &["push", "-q", "origin", "main"]);
    let tip = git_in(&other, &["rev-parse", "HEAD"]);

    let repo = fx.repo();
    let (cancel, out) = quiet();
    repo.update_branch("main", &cancel, &out).unwrap();
    assert_eq!(fx.git(&["rev-parse", "main"]), tip);
    assert_eq!(fx.git(&["rev-parse", "origin/main"]), tip);
    // The checked-out branch and branches without upstream are refused.
    assert!(repo.update_branch("work", &cancel, &out).is_err());
}
