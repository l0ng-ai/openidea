//! Annotate skips the commits listed in `blame.ignoreRevsFile`.

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
            ("core.autocrlf", "false"),
        ] {
            git_in(&dir, &["config", k, v]);
        }
        Fixture { _tmp: tmp, dir }
    }
    fn git(&self, args: &[&str]) -> String {
        git_in(&self.dir, args)
    }
    fn write(&self, rel: &str, content: &str) {
        std::fs::write(self.dir.join(rel), content).unwrap();
    }
    fn commit_all(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"])
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
    /// The repository of a trusted project.
    fn repo(&self) -> Repo {
        let repo = Repo::discover(&self.dir).unwrap().expect("repository found");
        repo.set_execution_allowed(true);
        repo
    }
    /// The repository of a project in Restricted Mode.
    fn restricted(&self) -> Repo {
        Repo::discover(&self.dir).unwrap().expect("repository found")
    }
}

/// A line added by `first` and reformatted by `second`; annotate attributes it to
/// `second` until `second` is ignored, then back to `first`.
fn reformatted_file() -> (Fixture, String, String) {
    let fx = Fixture::new();
    fx.write("file.txt", "first\nsecond\n");
    let first = fx.commit_all("add file");
    fx.write("file.txt", "first\n  second\n");
    let second = fx.commit_all("reformat");
    (fx, first, second)
}

fn commits(repo: &Repo, path: &Path) -> Vec<String> {
    repo.blame(path, None, None, encoding_rs::UTF_8).unwrap().into_iter().map(|line| line.commit).collect()
}

#[test]
fn a_listed_commit_gives_its_lines_back_to_the_earlier_one() {
    let (fx, first, second) = reformatted_file();
    let file = fx.path("file.txt");
    assert_eq!(commits(&fx.repo(), &file), vec![first.clone(), second.clone()]);

    fx.write(".git-blame-ignore-revs", &format!("{second}\n"));
    fx.git(&["config", "blame.ignoreRevsFile", ".git-blame-ignore-revs"]);
    let ignored = vec![first.clone(), first.clone()];
    assert_eq!(commits(&fx.repo(), &file), ignored);
    // Restricted Mode reads the same configuration and skips the same commit.
    assert_eq!(commits(&fx.restricted(), &file), ignored);
}

#[test]
fn a_configured_file_that_does_not_exist_is_skipped() {
    let (fx, _, second) = reformatted_file();
    fx.git(&["config", "blame.ignoreRevsFile", ".git-blame-ignore-revs"]);
    let file = fx.path("file.txt");
    // The missing list is passed to no blame, so annotate still works.
    assert_eq!(commits(&fx.repo(), &file)[1], second);
    assert_eq!(commits(&fx.restricted(), &file)[1], second);
}

#[test]
fn ignoring_a_commit_starts_the_list_and_configures_it_once() {
    let (fx, first, second) = reformatted_file();
    fx.repo().ignore_blame_revision(&second).unwrap();
    fx.repo().ignore_blame_revision(&second).unwrap();
    assert_eq!(std::fs::read_to_string(fx.path(".git-blame-ignore-revs")).unwrap(), format!("{second}\n"));
    assert_eq!(fx.git(&["config", "--local", "--get", "blame.ignoreRevsFile"]), ".git-blame-ignore-revs");
    let repo = fx.repo();
    assert_eq!(commits(&repo, &fx.path("file.txt")), vec![first.clone(), first.clone()]);
}

#[test]
fn ignoring_a_commit_adds_it_to_the_configured_list() {
    let (fx, first, second) = reformatted_file();
    fx.write("custom-revs", &format!("# formatting\r\n{first}\r\n"));
    fx.git(&["config", "--local", "blame.ignoreRevsFile", "custom-revs"]);
    fx.repo().ignore_blame_revision(&second).unwrap();
    // Lines and line endings kept; the configured file is the one annotate reads.
    assert_eq!(
        std::fs::read_to_string(fx.path("custom-revs")).unwrap(),
        format!("# formatting\r\n{first}\r\n{second}\r\n")
    );
    assert!(!fx.path(".git-blame-ignore-revs").exists());
    assert_eq!(fx.git(&["config", "--local", "--get", "blame.ignoreRevsFile"]), "custom-revs");
    let blamed = commits(&fx.repo(), &fx.path("file.txt"));
    assert_ne!(blamed[1], second);
}
