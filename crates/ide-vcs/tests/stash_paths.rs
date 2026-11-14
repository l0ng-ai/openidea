//! Stashing only the selected files.

use ide_core::error::ErrorKind;
use ide_vcs::Repo;
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

fn configure(dir: &Path) {
    for (k, v) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
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
        Fixture { _tmp: tmp, dir }
    }
    fn git(&self, args: &[&str]) -> String {
        git_in(&self.dir, args)
    }
    fn write(&self, rel: &str, content: &str) {
        std::fs::write(self.dir.join(rel), content).unwrap();
    }
    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.dir.join(rel)).unwrap()
    }
    fn commit_all(&self, msg: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
    }
    fn repo(&self) -> Repo {
        let repo = Repo::discover(&self.dir).unwrap().expect("repository found");
        repo.set_execution_allowed(true);
        repo
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
}

#[test]
fn stash_push_stashes_only_the_given_paths() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.write("b.txt", "b\n");
    fx.commit_all("base");
    let repo = fx.repo();

    fx.write("a.txt", "a changed\n");
    fx.write("b.txt", "b changed\n");
    repo.stash_push(Some("only a"), false, false, &[fx.path("a.txt")]).unwrap();
    assert_eq!(fx.read("a.txt"), "a\n");
    assert_eq!(fx.read("b.txt"), "b changed\n");
    assert_eq!(repo.stashes().unwrap().len(), 1);

    repo.stash_apply(0, true, false).unwrap();
    assert_eq!(fx.read("a.txt"), "a changed\n");
    assert_eq!(fx.read("b.txt"), "b changed\n");
    assert!(repo.stashes().unwrap().is_empty());
}

#[test]
fn stash_push_stashes_only_the_given_untracked_paths() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.commit_all("base");
    let repo = fx.repo();

    fx.write("new.txt", "new\n");
    fx.write("other.txt", "other\n");
    repo.stash_push(None, true, false, &[fx.path("new.txt")]).unwrap();
    assert!(!fx.path("new.txt").exists());
    assert!(fx.path("other.txt").exists());
    assert_eq!(repo.stashes().unwrap().len(), 1);

    repo.stash_apply(0, true, false).unwrap();
    assert_eq!(fx.read("new.txt"), "new\n");
}

#[test]
fn stash_push_rejects_paths_outside_the_repository() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.commit_all("base");
    let repo = fx.repo();
    fx.write("a.txt", "a changed\n");

    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("outside.txt"), "outside\n").unwrap();
    let error = repo.stash_push(None, false, false, &[outside.path().join("outside.txt")]).unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    assert!(error.message.contains("outside the repository"), "{error:?}");

    // Nothing was stashed and the change is still in the working tree.
    assert!(repo.stashes().unwrap().is_empty());
    assert_eq!(fx.read("a.txt"), "a changed\n");
}
