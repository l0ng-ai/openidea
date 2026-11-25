//! Rebase / cherry-pick / revert / reset / tags, the shelf and patches, against
//! throwaway repositories created with the git CLI.

use ide_core::{CancellationToken, workflow_settings::EmptyCherryPickAction};
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
    repo.accept_conflict_side(&[fx.path("f.txt")], ConflictSide::Ours).unwrap();
    assert_eq!(fx.read("f.txt"), "topic\n");
    assert_eq!(fx.git(&["show", ":f.txt"]), "topic");
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
fn rebase_conflict_names_the_remote_branch_without_its_symbolic_aliases() {
    let fx = diverged();
    let main = fx.git(&["rev-parse", "main"]);
    fx.git(&["update-ref", "refs/remotes/origin/main", &main]);
    fx.git(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    fx.git(&["symbolic-ref", "refs/remotes/origin/alias", "refs/remotes/origin/main"]);
    fx.git(&["branch", "-D", "main"]);
    let repo = fx.repo();
    assert!(repo.rebase("origin/main").is_err());
    assert_eq!(repo.merge_sides().unwrap().other_branch.as_deref(), Some("origin/main"));
    let (cancel, out) = quiet();
    repo.abort_operation(&cancel, &out).unwrap();
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
fn rebase_abort_does_not_abort_a_different_operation() {
    let fx = diverged();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    assert!(repo.merge("main").is_err());
    let error = repo.abort_expected_operation(Some("rebase"), &cancel, &out).unwrap_err();
    assert_eq!(error.message, "Git operation changed before it could be aborted");
    assert_eq!(repo.operation().unwrap().as_deref(), Some("merge"));
    repo.abort_expected_operation(Some("merge"), &cancel, &out).unwrap();
    assert_eq!(repo.operation().unwrap(), None);
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
fn finish_merge_checks_the_reviewed_heads_and_uses_the_prepared_message() {
    let fx = diverged();
    fx.git(&["checkout", "-q", "main"]);
    let repo = fx.repo();
    let (cancel, out) = quiet();
    let head = fx.git(&["rev-parse", "HEAD"]);
    let target = fx.git(&["rev-parse", "topic"]);
    assert!(repo.merge("topic").is_err());
    assert!(
        repo.finish_merge(Some("main"), &head, &target, &cancel, &out).is_err(),
        "unresolved files block finishing"
    );
    fx.write("f.txt", "resolved\n");
    repo.stage(&[fx.path("f.txt")]).unwrap();

    for (branch, before, incoming) in
        [(Some("topic"), &head, &target), (Some("main"), &target, &target), (Some("main"), &head, &head)]
    {
        let error = repo.finish_merge(branch, before, incoming, &cancel, &out).unwrap_err();
        assert_eq!(error.message, "The merge changed before it could be finished");
    }
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(fx.git(&["rev-parse", "MERGE_HEAD"]), target);

    repo.finish_merge(Some("main"), &head, &target, &cancel, &out).unwrap();
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["log", "-1", "--format=%s%n%P"]), format!("Merge branch 'topic'\n{head} {target}"));
    assert_eq!(fx.git(&["show", "HEAD:f.txt"]), "resolved");
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

fn mixed_cherry_pick_fixture() -> (Fixture, [String; 3]) {
    let fx = Fixture::new();
    fx.write("f.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "topic"]);
    fx.write("setup.txt", "setup\n");
    let setup = fx.commit_all("published setup");
    fx.write("f.txt", "topic\n");
    let edit = fx.commit_all("published edit");
    fx.write("followup.txt", "local\n");
    let local = fx.commit_all("local follow-up");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("f.txt", "main\n");
    fx.commit_all("main edit");
    (fx, [setup, edit, local])
}

#[test]
fn mixed_cherry_pick_keeps_per_commit_origins_when_resumed() {
    let (fx, picks) = mixed_cherry_pick_fixture();
    let (cancel, out) = quiet();
    let repo = fx.repo();
    assert!(repo.cherry_pick_with_origins(&picks, &picks[..2], &cancel, &out).is_err());
    assert_eq!(repo.operation().unwrap().as_deref(), Some("cherry-pick"));
    assert_eq!(fx.git(&["rev-parse", "CHERRY_PICK_HEAD"]), picks[1]);
    assert!(!fx.path("followup.txt").exists());
    drop(repo);

    let repo = fx.repo();
    fx.write("f.txt", "resolved\n");
    repo.stage(&[fx.path("f.txt")]).unwrap();
    repo.continue_operation(&cancel, &out).unwrap();
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["log", "-3", "--format=%s"]), "local follow-up\npublished edit\npublished setup");
    assert_eq!(fx.git(&["show", "-s", "--format=%b", "HEAD"]), "");
    assert_eq!(fx.git(&["show", "-s", "--format=%b", "HEAD~1"]), format!("(cherry picked from commit {})", picks[1]));
    assert_eq!(fx.git(&["show", "-s", "--format=%b", "HEAD~2"]), format!("(cherry picked from commit {})", picks[0]));
    assert!(!fx.path(".git/openidea-cherry-pick.json").exists());
}

#[test]
fn reviewed_formatting_keeps_the_index_transaction_scoped_and_preserves_worktree_edits() {
    let (fx, picks) = mixed_cherry_pick_fixture();
    let (cancel, out) = quiet();
    let repo = fx.repo();
    assert!(repo.cherry_pick_with(&picks, true, &cancel, &out).is_err());
    fx.write("f.txt", "resolved   \n");
    repo.stage(&[fx.path("f.txt")]).unwrap();
    fx.write("f.txt", "other unstaged edit\n");
    fx.write("local.txt", "unrelated work\n");
    let encoding = |_: &Path, _: &[u8]| encoding_rs::UTF_8.into();
    let edit = |file, formatted: &str| {
        let path = fx.path(file);
        let staged = repo.staged_text(&path, 1024, |_| encoding_rs::UTF_8.into()).unwrap().unwrap();
        StagedTextEdit { path: path.into(), version: staged.version, text: formatted.to_string() }
    };

    let review = repo.review_apply_commit(&cancel).unwrap().unwrap();
    let retained =
        repo.format_reviewed_apply(&review.checkpoint, &[edit("f.txt", "main\n")], &cancel, encoding).unwrap();
    assert_eq!(retained, review);
    assert_eq!(repo.review_apply_commit(&cancel).unwrap().unwrap(), review);

    fx.write("extra.txt", "staged   \n");
    repo.stage(&[fx.path("extra.txt")]).unwrap();
    let review = repo.review_apply_commit(&cancel).unwrap().unwrap();
    let unrelated = edit("setup.txt", "not part of the review\n");
    assert!(
        repo.format_reviewed_apply(&review.checkpoint, &[edit("f.txt", "resolved\n"), unrelated], &cancel, encoding)
            .is_err()
    );
    assert_eq!(repo.review_apply_commit(&cancel).unwrap().unwrap(), review);

    let mut stale = edit("extra.txt", "staged\n");
    stale.version.clear();
    assert!(
        repo.format_reviewed_apply(&review.checkpoint, &[edit("f.txt", "resolved\n"), stale], &cancel, encoding)
            .is_err()
    );
    assert_eq!(repo.review_apply_commit(&cancel).unwrap().unwrap(), review);

    fx.write("extra.txt", "external staged edit\n");
    repo.stage(&[fx.path("extra.txt")]).unwrap();
    assert!(repo.format_reviewed_apply(&review.checkpoint, &[edit("f.txt", "resolved\n")], &cancel, encoding).is_err());
    let review = repo.review_apply_commit(&cancel).unwrap().unwrap();
    let formatted =
        repo.format_reviewed_apply(&review.checkpoint, &[edit("f.txt", "resolved\n")], &cancel, encoding).unwrap();
    assert_ne!(review.checkpoint, formatted.checkpoint);
    assert_eq!(review.paths, formatted.paths);
    assert_eq!(repo.review_apply_commit(&cancel).unwrap().unwrap(), formatted);
    assert_eq!(fx.git(&["show", ":extra.txt"]), "external staged edit");
    assert_eq!(fx.read("f.txt"), "other unstaged edit\n");
    assert_eq!(fx.read("local.txt"), "unrelated work\n");

    assert!(
        repo.continue_reviewed_apply(
            &review.checkpoint,
            &review.message,
            &Default::default(),
            Default::default(),
            &cancel,
            &out
        )
        .is_err()
    );
    repo.continue_reviewed_apply(
        &formatted.checkpoint,
        &formatted.message,
        &Default::default(),
        Default::default(),
        &cancel,
        &out,
    )
    .unwrap();
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["show", "HEAD:f.txt"]), "resolved");
    assert_eq!(fx.read("f.txt"), "other unstaged edit\n");
}

#[test]
fn reviewed_cherry_pick_keeps_the_edited_message_and_resumes_both_kinds_of_queue() {
    for mixed in [false, true] {
        let (fx, picks) = mixed_cherry_pick_fixture();
        let (cancel, out) = quiet();
        let repo = fx.repo();
        let result = if mixed {
            repo.cherry_pick_with_origins(&picks, &picks[..2], &cancel, &out)
        } else {
            repo.cherry_pick_with(&picks, true, &cancel, &out)
        };
        assert!(result.is_err());
        fx.write("f.txt", "resolved\n");
        repo.stage(&[fx.path("f.txt")]).unwrap();
        let review = repo.review_apply_commit(&cancel).unwrap().unwrap();
        assert_eq!(review.kind, ide_vcs::CommitApplyKind::CherryPick);
        assert_eq!(review.paths, [ide_core::IpcPath(fx.path("f.txt"))]);
        let message = format!("Reviewed pick\n\n# Context\n{}", review.message);
        let head = fx.git(&["rev-parse", "HEAD"]);
        fx.write("local.txt", "unrelated work\n");
        let options =
            ide_vcs::CommitOptions { stage: vec![ide_core::IpcPath(fx.path("local.txt"))], ..Default::default() };
        assert!(repo.commit_with("Ordinary commit", &options, &|_| Ok(encoding_rs::UTF_8)).is_err());
        assert_eq!(fx.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "f.txt");
        assert_eq!(fx.git(&["rev-parse", "CHERRY_PICK_HEAD"]), picks[1]);

        fx.write("f.txt", "staged after opening the review\n");
        repo.stage(&[fx.path("f.txt")]).unwrap();
        assert!(
            repo.continue_reviewed_apply(
                &review.checkpoint,
                &message,
                &Default::default(),
                Default::default(),
                &cancel,
                &out
            )
            .is_err()
        );
        assert_eq!(fx.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(fx.git(&["rev-parse", "CHERRY_PICK_HEAD"]), picks[1]);

        let review = repo.review_apply_commit(&cancel).unwrap().unwrap();
        repo.continue_reviewed_apply(
            &review.checkpoint,
            &message,
            &Default::default(),
            Default::default(),
            &cancel,
            &out,
        )
        .unwrap();
        assert_eq!(repo.operation().unwrap(), None);
        assert_eq!(fx.git(&["log", "-3", "--format=%s"]), "local follow-up\nReviewed pick\npublished setup");
        assert!(fx.git(&["show", "-s", "--format=%B", "HEAD~1"]).contains("# Context\npublished edit"));
        assert!(fx.git(&["show", "-s", "--format=%B", "HEAD~1"]).contains(&picks[1]));
        assert_eq!(fx.git(&["show", "-s", "--format=%b", "HEAD"]).contains(&picks[2]), !mixed);
        assert!(!fx.path(".git/openidea-cherry-pick.json").exists());
    }
}

#[test]
fn reviewed_revert_uses_the_current_author_and_continues_the_sequence() {
    let fx = Fixture::new();
    fx.write("a.txt", "base\n");
    fx.write("local.txt", "clean\n");
    fx.commit_all("base");
    fx.write("other.txt", "delete this too\n");
    let other = fx.commit_all("other change");
    fx.write("a.txt", "incoming\n");
    fx.git(&["add", "a.txt"]);
    fx.git(&[
        "commit",
        "-qm",
        "incoming change",
        "--author=Author <author@example.invalid>",
        "--date=2022-06-04T13:20:21+05:30",
    ]);
    let incoming = fx.git(&["rev-parse", "HEAD"]);
    fx.write("a.txt", "local head\n");
    fx.commit_all("local head");
    fx.write("local.txt", "unrelated edit\n");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    assert!(repo.revert(&[incoming.clone(), other], &cancel, &out).is_err());
    fx.write("a.txt", "reviewed resolution\n");
    repo.stage(&[fx.path("a.txt")]).unwrap();
    let review = repo.review_apply_commit(&cancel).unwrap().unwrap();
    assert_eq!(review.kind, ide_vcs::CommitApplyKind::Revert);
    assert_eq!(review.paths, [ide_core::IpcPath(fx.path("a.txt"))]);
    assert!(review.message.contains(&incoming));
    let head = fx.git(&["rev-parse", "HEAD"]);
    assert!(repo.commit("Ordinary commit", false, false).is_err());
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(fx.git(&["rev-parse", "REVERT_HEAD"]), incoming);
    repo.continue_reviewed_apply(
        &review.checkpoint,
        "Reviewed revert\n\n# Why",
        &Default::default(),
        Default::default(),
        &cancel,
        &out,
    )
    .unwrap();
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["log", "-2", "--format=%s"]), "Revert \"other change\"\nReviewed revert");
    assert_eq!(fx.git(&["show", "-s", "--format=%B", "HEAD~1"]), "Reviewed revert\n\n# Why");
    assert_eq!(
        fx.git(&["show", "-s", "--format=%an <%ae>", "HEAD~1"]),
        fx.git(&["var", "GIT_AUTHOR_IDENT"]).split('>').next().unwrap().to_owned() + ">"
    );
    assert_eq!(fx.git(&["status", "--short"]), "M local.txt");
}

#[test]
fn reviewed_commit_options_apply_only_to_the_paused_step() {
    let (fx, picks) = mixed_cherry_pick_fixture();
    let repo = fx.repo();
    let (cancel, out) = quiet();
    assert!(repo.cherry_pick_with_origins(&picks[1..], &picks[1..2], &cancel, &out).is_err());
    fx.write("f.txt", "resolved\n");
    repo.stage(&[fx.path("f.txt")]).unwrap();
    fx.git(&["config", "core.hooksPath", ".git/hooks"]);
    fx.write(
        ".git/hooks/pre-commit",
        "#!/bin/sh\nif git diff --cached --name-only -- f.txt | grep -qx f.txt; then\n  echo ran >> .git/reviewed-hook-log\n  exit 1\nfi\n",
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(fx.path(".git/hooks/pre-commit"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let review = repo.review_apply_commit(&cancel).unwrap().unwrap();
    assert!(review.author.is_some());
    assert!(review.author_date.is_some());
    assert!(
        repo.continue_reviewed_apply(
            &review.checkpoint,
            &review.message,
            &Default::default(),
            Default::default(),
            &cancel,
            &out,
        )
        .is_err()
    );
    assert_eq!(fx.git(&["rev-parse", "CHERRY_PICK_HEAD"]), picks[1]);
    assert_eq!(fx.read(".git/reviewed-hook-log"), "ran\n");
    let options = ide_vcs::ApplyCommitOptions {
        author: Some("Reviewed Author <reviewed@example.invalid>".into()),
        author_date: Some("2024-06-04T13:20:21+05:30".into()),
        sign_off: true,
        run_hooks: false,
    };
    repo.continue_reviewed_apply(&review.checkpoint, &review.message, &options, Default::default(), &cancel, &out)
        .unwrap();
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["log", "-2", "--format=%s"]), "local follow-up\npublished edit");
    assert_eq!(
        fx.git(&["show", "-s", "--format=%an <%ae>%n%aI", "HEAD^"]),
        "Reviewed Author <reviewed@example.invalid>\n2024-06-04T13:20:21+05:30"
    );
    let committer = fx.git(&["show", "-s", "--format=%cn <%ce>", "HEAD^"]);
    assert!(fx.git(&["show", "-s", "--format=%B", "HEAD^"]).contains(&format!("Signed-off-by: {committer}")));
    assert!(!fx.git(&["show", "-s", "--format=%B", "HEAD"]).contains("Signed-off-by:"));
    assert_eq!(fx.read(".git/reviewed-hook-log"), "ran\n");
}

#[test]
fn cherry_pick_continues_when_conflict_resolution_leaves_an_empty_commit() {
    for action in [EmptyCherryPickAction::Skip, EmptyCherryPickAction::CreateEmpty] {
        let (fx, picks) = mixed_cherry_pick_fixture();
        let (cancel, out) = quiet();
        let repo = fx.repo();
        let before = fx.git(&["rev-parse", "HEAD"]);
        let options = CherryPickOptions { record_origin: true, empty_action: action, ..Default::default() };
        assert!(repo.cherry_pick_with_options(&picks[1..], options, &cancel, &out).is_err());
        assert_eq!(repo.operation().unwrap().as_deref(), Some("cherry-pick"));
        fx.write("f.txt", "main\n");
        repo.stage(&[fx.path("f.txt")]).unwrap();

        assert_eq!(repo.continue_operation_with(true, action, &cancel, &out).unwrap(), 1);
        assert_eq!(repo.operation().unwrap(), None);
        assert_eq!(fx.read("f.txt"), "main\n");
        assert_eq!(fx.read("followup.txt"), "local\n");
        if action == EmptyCherryPickAction::CreateEmpty {
            assert_eq!(fx.git(&["rev-parse", "HEAD~2"]), before);
            assert_eq!(fx.git(&["rev-parse", "HEAD~1^{tree}"]), fx.git(&["rev-parse", "HEAD~2^{tree}"]));
            assert_eq!(
                fx.git(&["show", "-s", "--format=%B", "HEAD~1"]),
                format!("published edit\n\n(cherry picked from commit {})", picks[1]),
            );
        } else {
            assert_eq!(fx.git(&["rev-parse", "HEAD~1"]), before);
        }
    }
}

#[test]
fn a_native_cherry_pick_sequence_can_resume_after_its_empty_commit_was_saved() {
    let (fx, picks) = mixed_cherry_pick_fixture();
    let (cancel, out) = quiet();
    let repo = fx.repo();
    assert!(repo.cherry_pick(&picks[1..], &cancel, &out).is_err());
    fx.write("f.txt", "main\n");
    repo.stage(&[fx.path("f.txt")]).unwrap();
    fx.git(&["commit", "--allow-empty", "--no-edit"]);
    assert!(!fx.path(".git/CHERRY_PICK_HEAD").exists());
    assert!(fx.path(".git/sequencer/todo").exists());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("cherry-pick"));

    repo.continue_operation(&cancel, &out).unwrap();
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.read("followup.txt"), "local\n");
}

#[test]
fn creating_an_empty_cherry_pick_after_resolution_continues_a_mixed_batch() {
    let (fx, picks) = mixed_cherry_pick_fixture();
    let (cancel, out) = quiet();
    let action = EmptyCherryPickAction::CreateEmpty;
    let options = CherryPickOptions { record_origin_for: &picks[..2], empty_action: action, ..Default::default() };
    assert!(fx.repo().cherry_pick_with_options(&picks, options, &cancel, &out).is_err());
    assert!(fx.path(".git/openidea-cherry-pick.json").exists());
    fx.write("f.txt", "main\n");
    let repo = fx.repo();
    repo.stage(&[fx.path("f.txt")]).unwrap();

    assert_eq!(repo.continue_operation_with(false, action, &cancel, &out).unwrap(), 1);
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["log", "-3", "--format=%s"]), "local follow-up\npublished edit\npublished setup");
    assert_eq!(fx.git(&["show", "-s", "--format=%b", "HEAD"]), "");
    assert_eq!(fx.git(&["show", "-s", "--format=%b", "HEAD~1"]), format!("(cherry picked from commit {})", picks[1]));
    assert_eq!(fx.git(&["rev-parse", "HEAD~1^{tree}"]), fx.git(&["rev-parse", "HEAD~2^{tree}"]));
    assert!(!fx.path(".git/openidea-cherry-pick.json").exists());
}

#[test]
fn aborting_a_mixed_cherry_pick_keeps_already_applied_commits() {
    let (fx, picks) = mixed_cherry_pick_fixture();
    let (cancel, out) = quiet();
    let repo = fx.repo();
    assert!(repo.cherry_pick_with_origins(&picks, &picks[..2], &cancel, &out).is_err());
    assert!(fx.path(".git/openidea-cherry-pick.json").exists());
    repo.abort_expected_operation(Some("cherry-pick"), &cancel, &out).unwrap();
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["log", "-2", "--format=%s"]), "published setup\nmain edit");
    assert_eq!(fx.read("f.txt"), "main\n");
    assert!(!fx.path("followup.txt").exists());
    assert!(!fx.path(".git/openidea-cherry-pick.json").exists());
}

#[test]
fn skipping_a_mixed_cherry_pick_conflict_still_applies_the_remaining_commits() {
    let (fx, picks) = mixed_cherry_pick_fixture();
    let (cancel, out) = quiet();
    let repo = fx.repo();
    assert!(repo.cherry_pick_with_origins(&picks, &picks[1..2], &cancel, &out).is_err());
    repo.skip_operation(&cancel, &out).unwrap();
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["log", "-3", "--format=%s"]), "local follow-up\npublished setup\nmain edit");
    assert_eq!(fx.read("f.txt"), "main\n");
    assert_eq!(fx.read("followup.txt"), "local\n");
}

#[test]
fn a_cherry_pick_started_externally_does_not_resume_an_abandoned_batch() {
    let (fx, picks) = mixed_cherry_pick_fixture();
    let (cancel, out) = quiet();
    let repo = fx.repo();
    assert!(repo.cherry_pick_with_origins(&picks, &picks[..2], &cancel, &out).is_err());
    fx.git(&["cherry-pick", "--abort"]);
    fx.git(&["commit", "-q", "--allow-empty", "-m", "new HEAD"]);
    let external = Command::new("git").current_dir(&fx.dir).args(["cherry-pick", &picks[1]]).output().unwrap();
    assert!(!external.status.success());
    assert_eq!(fx.git(&["rev-parse", "CHERRY_PICK_HEAD"]), picks[1]);

    fx.write("f.txt", "resolved externally\n");
    repo.stage(&[fx.path("f.txt")]).unwrap();
    repo.continue_operation(&cancel, &out).unwrap();
    assert_eq!(fx.git(&["log", "-2", "--format=%s"]), "published edit\nnew HEAD");
    assert!(!fx.path("followup.txt").exists());
    assert!(!fx.path(".git/openidea-cherry-pick.json").exists());
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
fn staging_patch_exports_only_the_chosen_sides() {
    let fx = Fixture::new();
    for file in ["staged.txt", "local.txt", "both.txt", "outside.txt", "rename me.txt"] {
        fx.write(file, "HEAD line\n");
    }
    fx.commit_all("base");
    for file in ["staged.txt", "local.txt", "both.txt", "outside.txt"] {
        fx.write(file, "index line\n");
    }
    fx.git(&["add", "."]);
    fx.git(&["mv", "rename me.txt", "renamed.txt"]);
    for file in ["staged.txt", "local.txt", "both.txt", "outside.txt", "renamed.txt"] {
        fx.write(file, "working line\n");
    }
    fx.write("new.txt", "untracked text\n");
    fx.write("binary.bin", "\0binary bytes\n");
    let repo = fx.repo();
    let entry = |path, side, renamed_from: Option<&str>| StagingPatchEntry {
        path: fx.path(path).into(),
        renamed_from: renamed_from.map(|old| fx.path(old).into()),
        side,
    };
    use StagingPatchSide::{Staged, Unstaged};
    let entries = [
        entry("staged.txt", Staged, None),
        entry("local.txt", Unstaged, None),
        entry("both.txt", Staged, None),
        entry("both.txt", Unstaged, None),
        entry("renamed.txt", Staged, Some("rename me.txt")),
        entry("new.txt", Unstaged, None),
        entry("binary.bin", Unstaged, None),
    ];
    let old_index = std::fs::read(fx.path(".git/index")).unwrap();
    let patch = repo.create_staging_patch(&entries, false, "repo/").unwrap();
    let block = |path| patch.split("diff --git ").find(|section| section.starts_with(path)).unwrap_or("");
    assert!(block("a/repo/staged.txt ").contains("-HEAD line\n+index line"), "{patch}");
    assert!(block("a/repo/local.txt ").contains("-index line\n+working line"), "{patch}");
    assert!(block("a/repo/both.txt ").contains("-HEAD line\n+working line"), "{patch}");
    assert_eq!(patch.matches("diff --git a/repo/both.txt ").count(), 1, "{patch}");
    assert!(patch.contains("rename from \"repo/rename me.txt\"\nrename to repo/renamed.txt"), "{patch}");
    assert!(block("a/repo/new.txt ").contains("+untracked text"), "{patch}");
    assert!(block("a/repo/binary.bin ").contains("GIT binary patch"), "{patch}");
    assert!(!patch.contains("outside.txt"), "{patch}");
    let reverse = repo.create_staging_patch(&entries, true, "repo/").unwrap();
    assert!(reverse.contains("diff --git a/repo/local.txt b/repo/local.txt"), "{reverse}");
    assert!(reverse.contains("-working line\n+index line"), "{reverse}");
    assert_eq!(std::fs::read(fx.path(".git/index")).unwrap(), old_index);
    assert_eq!(fx.read("staged.txt"), "working line\n");
    assert_eq!(fx.read("new.txt"), "untracked text\n");

    let target = Fixture::new();
    for (path, text) in [
        ("repo/staged.txt", "HEAD line\n"),
        ("repo/local.txt", "index line\n"),
        ("repo/both.txt", "HEAD line\n"),
        ("repo/rename me.txt", "HEAD line\n"),
    ] {
        target.write(path, text);
    }
    target.commit_all("patch base");
    assert!(target.repo().apply_patch(&patch).unwrap().conflicts.is_empty());
    assert!(!target.path("repo/rename me.txt").exists());
    assert_eq!(target.read("repo/renamed.txt"), "HEAD line\n");
    assert_eq!(target.read("repo/both.txt"), "working line\n");
    assert_eq!(target.read("repo/binary.bin"), "\0binary bytes\n");
    assert!(target.repo().apply_patch(&reverse).unwrap().conflicts.is_empty());
    assert!(!target.path("repo/renamed.txt").exists());
    assert_eq!(target.read("repo/rename me.txt"), "HEAD line\n");
    assert_eq!(target.read("repo/local.txt"), "index line\n");
    assert!(!target.path("repo/binary.bin").exists());
}

#[test]
fn staging_patch_handles_unborn_head_and_an_index_with_intent_to_add() {
    let fx = Fixture::new();
    fx.write("a.txt", "index\n");
    fx.git(&["add", "a.txt"]);
    fx.write("a.txt", "working\n");
    fx.write("intent.txt", "intent to add\n");
    fx.git(&["add", "--intent-to-add", "intent.txt"]);
    let entries = [
        StagingPatchEntry { path: fx.path("a.txt").into(), renamed_from: None, side: StagingPatchSide::Both },
        StagingPatchEntry { path: fx.path("intent.txt").into(), renamed_from: None, side: StagingPatchSide::Unstaged },
    ];
    let patch = fx.repo().create_staging_patch(&entries, false, "").unwrap();
    assert!(patch.contains("+working\n") && patch.contains("+intent to add\n"), "{patch}");
    assert!(!patch.contains("index\n"), "{patch}");
    assert_eq!(patch.matches("new file mode").count(), 2, "{patch}");
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
fn push_goes_to_an_upstream_with_another_name() {
    let fx = Fixture::new();
    let bare = fx._tmp.path().join("origin.git");
    git_in(fx._tmp.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    fx.write("a.txt", "1\n");
    fx.commit_all("one");
    fx.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
    fx.git(&["push", "-q", "origin", "main:release/one"]);
    fx.git(&["fetch", "-q", "origin"]);
    fx.git(&["checkout", "-q", "-b", "local-name", "--track", "origin/release/one"]);
    fx.write("a.txt", "2\n");
    let c2 = fx.commit_all("two");
    let repo = fx.repo();
    let (cancel, out) = quiet();

    repo.push(false, false, &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "release/one"]), c2);
    assert_eq!(git_in(&bare, &["branch", "--list", "local-name"]), "");

    fx.write("a.txt", "3\n");
    let c3 = fx.commit_all("three");
    repo.push_with_tags(false, false, Some(ide_vcs::PushTags::CurrentBranch), &cancel, &out).unwrap();
    assert_eq!(git_in(&bare, &["rev-parse", "release/one"]), c3);
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
fn update_branches_fast_forwards_each_selected_branch() {
    let fx = Fixture::new();
    let bare = fx._tmp.path().join("origin.git");
    git_in(fx._tmp.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    fx.write("a.txt", "1\n");
    fx.commit_all("one");
    fx.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
    fx.git(&["push", "-q", "-u", "origin", "main"]);
    for b in ["behind", "diverged", "ahead", "same", "elsewhere", "blocked"] {
        fx.git(&["push", "-q", "origin", &format!("main:{b}")]);
        fx.git(&["branch", "-q", "--track", b, &format!("origin/{b}")]);
    }
    fx.git(&["branch", "-q", "local-only"]);
    // Someone else advances the remote branches.
    let other = fx._tmp.path().join("other");
    git_in(fx._tmp.path(), &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
    let mut tips = std::collections::HashMap::new();
    for b in ["main", "behind", "diverged", "elsewhere", "blocked"] {
        git_in(&other, &["checkout", "-q", b]);
        std::fs::write(other.join("a.txt"), format!("{b}\n")).unwrap();
        git_in(&other, &["-c", "user.name=O", "-c", "user.email=o@x", "commit", "-q", "-am", b]);
        git_in(&other, &["push", "-q", "origin", b]);
        tips.insert(b, git_in(&other, &["rev-parse", "HEAD"]));
    }
    // Local commits: `diverged` can't be fast-forwarded, `ahead` has nothing to take.
    for b in ["diverged", "ahead"] {
        fx.git(&["checkout", "-q", b]);
        fx.write("b.txt", b);
        fx.commit_all(b);
    }
    fx.git(&["checkout", "-q", "main"]);
    // Linked worktrees fast-forward their files along with the ref.
    let wt = fx._tmp.path().join("wt");
    fx.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "elsewhere"]);
    let dirty = fx._tmp.path().join("dirty");
    fx.git(&["worktree", "add", "-q", dirty.to_str().unwrap(), "blocked"]);
    std::fs::write(dirty.join("a.txt"), "local working changes\n").unwrap();
    let blocked = fx.git(&["rev-parse", "blocked"]);
    let ahead = fx.git(&["rev-parse", "ahead"]);

    let repo = fx.repo();
    let (cancel, out) = quiet();
    let names = ["main", "behind", "diverged", "ahead", "same", "local-only", "elsewhere", "blocked"].map(String::from);
    let result = repo.update_branches(&names, &cancel, &out).unwrap();
    let status: Vec<_> = result.iter().map(|u| (u.branch.as_str(), u.status)).collect();
    use BranchUpdateStatus::*;
    assert_eq!(
        status,
        [
            ("main", Updated),
            ("behind", Updated),
            ("diverged", NotFastForward),
            ("ahead", UpToDate),
            ("same", UpToDate),
            ("local-only", NoUpstream),
            ("elsewhere", Updated),
            ("blocked", Failed),
        ]
    );
    let failed_worktree = result[7].worktree.as_ref().unwrap();
    assert_eq!(dunce::canonicalize(&failed_worktree.0).unwrap(), dunce::canonicalize(&dirty).unwrap());
    // The checked-out branch is fast-forwarded with its working tree.
    assert_eq!(fx.git(&["rev-parse", "main"]), tips["main"]);
    assert_eq!(fx.read("a.txt"), "main\n");
    assert_eq!(fx.git(&["rev-parse", "behind"]), tips["behind"]);
    assert_eq!(fx.git(&["rev-parse", "origin/diverged"]), tips["diverged"]);
    assert_ne!(fx.git(&["rev-parse", "diverged"]), tips["diverged"]);
    assert_eq!(fx.git(&["rev-parse", "ahead"]), ahead);
    assert_eq!(fx.git(&["rev-parse", "elsewhere"]), tips["elsewhere"]);
    assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "elsewhere\n");
    assert_eq!(fx.git(&["rev-parse", "blocked"]), blocked);
    assert_eq!(std::fs::read_to_string(dirty.join("a.txt")).unwrap(), "local working changes\n");
    assert!(repo.update_branches(&["origin/main".into()], &cancel, &out).is_err());
}

#[test]
fn pull_refuses_to_update_a_different_checked_out_branch() {
    let fx = Fixture::new();
    fx.write("a.txt", "before\n");
    fx.commit_all("initial");
    fx.write("a.txt", "uncommitted\n");
    let (cancel, out) = quiet();
    let error = fx.repo().pull_checked_branch(false, Some("topic"), &cancel, &out).unwrap_err();
    assert_eq!(error.message, "Branch 'topic' is no longer checked out");
    assert_eq!(fx.read("a.txt"), "uncommitted\n");
    assert!(fx.git(&["stash", "list"]).is_empty());
}

#[test]
fn update_branches_fetches_each_remote_once_and_reports_its_failure() {
    let fx = Fixture::new();
    let bare = fx._tmp.path().join("origin.git");
    git_in(fx._tmp.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    fx.write("a.txt", "1\n");
    fx.commit_all("one");
    fx.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
    fx.git(&["remote", "add", "gone", fx._tmp.path().join("missing.git").to_str().unwrap()]);
    fx.git(&["push", "-q", "-u", "origin", "main", "main:a", "main:b"]);
    for b in ["a", "b"] {
        fx.git(&["branch", "-q", "--track", b, &format!("origin/{b}")]);
    }
    fx.git(&["branch", "-q", "c"]);
    fx.git(&["config", "branch.c.remote", "gone"]);
    fx.git(&["config", "branch.c.merge", "refs/heads/c"]);

    // Counts the fetches from origin.
    #[cfg(unix)]
    let counter = {
        use std::os::unix::fs::PermissionsExt;
        let counter = fx._tmp.path().join("fetches");
        let script = fx._tmp.path().join("upload-pack.sh");
        std::fs::write(&script, format!("#!/bin/sh\necho >> '{}'\nexec git-upload-pack \"$@\"\n", counter.display()))
            .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        fx.git(&["config", "remote.origin.uploadpack", script.to_str().unwrap()]);
        counter
    };

    let repo = fx.repo();
    let (cancel, out) = quiet();
    let names = ["a", "b", "c"].map(String::from);
    let result = repo.update_branches(&names, &cancel, &out).unwrap();
    let status: Vec<_> = result.iter().map(|u| u.status).collect();
    use BranchUpdateStatus::*;
    assert_eq!(status, [UpToDate, UpToDate, Failed]);
    assert!(result[2].message.is_some());
    #[cfg(unix)]
    assert_eq!(std::fs::read_to_string(counter).unwrap().lines().count(), 1);
}

/// `"` and tabs are illegal in Windows file names, and only they make Git quote a path.
const QUOTED: &str = if cfg!(windows) { "quote '.txt" } else { "quote\"\t.txt" };

#[test]
fn shelf_capture_does_not_revert_edits_made_after_capture() {
    let fx = Fixture::new();
    fx.write("a.txt", "base\n");
    fx.commit_all("base");
    fx.write("a.txt", "captured\n");
    let repo = fx.repo();
    let root = fx._tmp.path();
    let directory = root.join("shelf");
    let part = shelf::ShelfCapture::capture(&repo, root, &[fx.path("a.txt")]).unwrap();
    let entry = shelf::save_combined(&directory, root, "Shared", std::slice::from_ref(&part)).unwrap();
    fx.write("a.txt", "updated after capture\n");
    assert!(part.revert(&repo).unwrap_err().message.contains("Files changed while shelving"));
    assert_eq!(fx.read("a.txt"), "updated after capture\n");
    assert!(shelf::patch_of(&directory, &entry.id).unwrap().contains("+captured"));
    let selections = shelf::selections(&directory, &entry.id, None).unwrap();
    let diff = selections[0].diff_files(&repo).unwrap().remove(0);
    assert_eq!(diff.before.as_deref(), Some("base\n"));
    assert_eq!(diff.after.as_deref(), Some("captured\n"));
    fx.write("a.txt", "captured\n");
    part.revert(&repo).unwrap();
    assert_eq!(fx.read("a.txt"), "base\n");
    assert_eq!(selections[0].apply(&repo).unwrap().applied, [diff.path]);
    assert_eq!(fx.read("a.txt"), "captured\n");
}

#[test]
fn shelf_diff_and_scoped_operations_preserve_siblings() {
    let fx = Fixture::new();
    for path in ["a.txt", "b.txt", QUOTED, "gone.txt"] {
        fx.write(path, "base\n");
    }
    fx.commit_all("base");
    for path in ["a.txt", "b.txt", QUOTED] {
        fx.write(path, "shelved\n");
    }
    std::fs::remove_file(fx.path("gone.txt")).unwrap();
    fx.write("new.txt", "new\n");
    std::fs::write(fx.path("binary.dat"), [0, 1, 255]).unwrap();
    let repo = fx.repo();
    let shelf = fx._tmp.path().join("shelf");
    let paths = ["a.txt", "b.txt", QUOTED, "gone.txt", "new.txt", "binary.dat"].map(|p| fx.path(p));
    let entry = repo.shelve(&shelf, "work", &paths).unwrap();
    fx.write("a.txt", "new head\n");
    fx.commit_all("advance head");
    fx.write("a.txt", "local edits\n");
    let status = fx.git(&["status", "--porcelain"]);
    let index = fx.git(&["ls-files", "--stage"]);
    let diffs = shelf::diff_files(&repo, &shelf, &entry.id).unwrap();
    for path in ["a.txt", "b.txt", QUOTED] {
        let f = diffs.iter().find(|f| f.path == path).unwrap();
        assert_eq!(f.before.as_deref(), Some("base\n"), "{path}");
        assert_eq!(f.after.as_deref(), Some("shelved\n"), "{path}");
    }
    assert_eq!(diffs.iter().find(|f| f.path == "new.txt").unwrap().before.as_deref(), Some(""));
    assert_eq!(diffs.iter().find(|f| f.path == "gone.txt").unwrap().after.as_deref(), Some(""));
    assert!(diffs.iter().find(|f| f.path == "binary.dat").unwrap().before.is_none());
    assert_eq!(fx.git(&["status", "--porcelain"]), status);
    assert_eq!(fx.git(&["ls-files", "--stage"]), index);
    assert_eq!(fx.read("a.txt"), "local edits\n");
    let patch = shelf::selected_patch(&shelf, &entry.id, Some("b.txt")).unwrap();
    assert!(patch.contains("b/b.txt"));
    assert!(!patch.contains("b/a.txt"));
    assert!(shelf::selected_patch(&shelf, &entry.id, Some("missing")).is_err());
    shelf::unshelve_path(&repo, &shelf, &entry.id, true, Some("b.txt")).unwrap();
    assert_eq!(fx.read("b.txt"), "shelved\n");
    assert!(!shelf::list(&shelf).unwrap()[0].files.iter().any(|f| f.path == "b.txt"));
    shelf::delete_path(&shelf, &entry.id, Some(QUOTED)).unwrap();
    assert!(shelf::selected_patch(&shelf, &entry.id, Some("a.txt")).is_ok());
    shelf::import_patch(&shelf, "imported", &patch, None).unwrap();
    assert_eq!(shelf::list(&shelf).unwrap().len(), 2);
    assert_eq!(fx.read("a.txt"), "local edits\n");
}

#[test]
fn shelf_imported_rename_diff_and_last_file_delete() {
    let fx = Fixture::new();
    fx.write("old.txt", "same\n");
    fx.commit_all("base");
    fx.git(&["mv", "old.txt", "new.txt"]);
    let patch = fx.git(&["diff", "--cached", "--binary", "--full-index", "-M"]) + "\n";
    fx.git(&["reset", "--hard", "HEAD"]);
    let repo = fx.repo();
    let shelf = fx._tmp.path().join("shelf");
    shelf::import_patch(&shelf, "rename", &patch, None).unwrap();
    let id = &shelf::list(&shelf).unwrap()[0].id;
    let diffs = shelf::diff_files(&repo, &shelf, id).unwrap();
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].path, "new.txt");
    // A rename-only imported patch has no embedded blob ids: do not guess from HEAD.
    assert!(diffs[0].before.is_none());
    assert!(diffs[0].patch.contains("rename from old.txt"));
    shelf::delete_path(&shelf, id, Some("new.txt")).unwrap();
    assert!(shelf::list(&shelf).unwrap().is_empty());
}

#[test]
fn shelf_new_renames_keep_self_contained_sides_and_plain_imports_keep_scope() {
    let fx = Fixture::new();
    fx.write("old.txt", "renamed content\n");
    fx.commit_all("base");
    fx.git(&["mv", "old.txt", "new.txt"]);
    let repo = fx.repo();
    let shelf = fx._tmp.path().join("shelf");
    let entry = repo.shelve(&shelf, "rename", &[fx.path("old.txt"), fx.path("new.txt")]).unwrap();
    let diffs = shelf::diff_files(&repo, &shelf, &entry.id).unwrap();
    assert_eq!(diffs.len(), 2);
    assert_eq!(diffs.iter().find(|f| f.path == "old.txt").unwrap().before.as_deref(), Some("renamed content\n"));
    assert_eq!(diffs.iter().find(|f| f.path == "new.txt").unwrap().after.as_deref(), Some("renamed content\n"));
    let plain = "--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n--- removed\n+++ added\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-old\n+new\n";
    shelf::import_patch(&shelf, "plain", plain, None).unwrap();
    let selected = shelf::selected_patch(&shelf, "plain", Some("one.txt")).unwrap();
    assert!(selected.contains("--- removed\n+++ added"));
    assert!(!selected.contains("two.txt"));
    shelf::delete_path(&shelf, "plain", Some("one.txt")).unwrap();
    assert_eq!(shelf::list(&shelf).unwrap().iter().find(|s| s.id == "plain").unwrap().files[0].path, "two.txt");
}

#[test]
fn cherry_pick_skips_commits_already_applied() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "side"]);
    fx.write("a.txt", "2\n");
    let same = fx.commit_all("same change");
    fx.write("b.txt", "b\n");
    let other = fx.commit_all("other change");
    fx.git(&["checkout", "-q", "main"]);
    // main already has the first change.
    fx.write("a.txt", "2\n");
    fx.commit_all("same change, made on main");
    let repo = fx.repo();
    let cancel = CancellationToken::new();
    let lines = std::sync::Mutex::new(Vec::new());
    let out = |l: String| lines.lock().unwrap().push(l);

    let options = CherryPickOptions { record_origin: true, ..Default::default() };
    assert_eq!(repo.cherry_pick_with_options(&[same.clone(), other], options, &cancel, &out).unwrap(), 1);
    assert_eq!(repo.branch_info().unwrap().operation, None, "nothing left in progress");
    assert_eq!(fx.git(&["log", "--format=%s", "-2"]), "other change\nsame change, made on main");
    assert!(fx.git(&["log", "-1", "--format=%B"]).contains("(cherry picked from commit"));
    assert!(lines.lock().unwrap().iter().any(|l| l.starts_with(&same[..8]) && l.contains("skipped")));
}

#[test]
fn cherry_pick_can_keep_redundant_and_originally_empty_commits() {
    let fx = Fixture::new();
    fx.write("a.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "topic"]);
    fx.write("a.txt", "change\n");
    let redundant = fx.commit_all("original change");
    fx.git(&[
        "commit",
        "-q",
        "--allow-empty",
        "--author=Original Author <original@example.test>",
        "-m",
        "originally empty",
    ]);
    let empty = fx.git(&["rev-parse", "HEAD"]);
    fx.git(&["checkout", "-q", "main"]);
    fx.write("a.txt", "change\n");
    let before = fx.commit_all("same change on main");
    fx.write("untracked.txt", "leave me alone\n");
    let (cancel, out) = quiet();
    let repo = fx.repo();
    let options = CherryPickOptions {
        record_origin: true,
        empty_action: EmptyCherryPickAction::CreateEmpty,
        ..Default::default()
    };

    assert_eq!(repo.cherry_pick_with_options(&[redundant.clone(), empty.clone()], options, &cancel, &out).unwrap(), 2);
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["rev-parse", "HEAD~2"]), before);
    assert_eq!(fx.git(&["rev-parse", "HEAD^{tree}"]), fx.git(&["rev-parse", "HEAD~2^{tree}"]));
    assert_eq!(fx.git(&["show", "-s", "--format=%an", "HEAD"]), "Original Author");
    assert_eq!(fx.git(&["show", "-s", "--format=%b", "HEAD"]), format!("(cherry picked from commit {empty})"));
    assert_eq!(fx.git(&["show", "-s", "--format=%b", "HEAD~1"]), format!("(cherry picked from commit {redundant})"));
    assert_eq!(fx.git(&["status", "--short"]), "?? untracked.txt");
}

#[test]
fn revert_of_a_commit_already_reverted_is_skipped() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.commit_all("one");
    fx.write("a.txt", "2\n");
    let two = fx.commit_all("two");
    fx.write("a.txt", "1\n");
    fx.commit_all("undo two by hand");
    let repo = fx.repo();
    let (cancel, out) = quiet();
    repo.revert(&[two], &cancel, &out).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["rev-list", "--count", "HEAD"]), "3", "no empty revert commit");
}
