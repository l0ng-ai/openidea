//! Git Annotate handles ignored commits and attribution options.

use ide_core::workflow_settings::{GitAnnotateMovement, GitAnnotateSettings};
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

#[test]
fn annotate_tracks_whitespace_and_line_movement() {
    let fx = Fixture::new();
    let source = "original café.txt";
    let within = "Move this existing line below a larger block of unchanged lines";
    let across = "Move this line into a different file within the same repository";
    let anchors = "retain line 1\nretain line 2\nretain line 3\nretain line 4\nretain line 5\nretain line 6\n";
    fx.write("spaces.txt", "this line is only indented later\n");
    fx.write("target.txt", &format!("{within}\n{anchors}"));
    fx.write(source, &format!("{across}\nretain source line\n"));
    let first = fx.commit_all("original files");
    fx.write("spaces.txt", "    this line is only indented later\n");
    fx.write("target.txt", &format!("{anchors}{within}\n{across}\n"));
    fx.write(source, "retain source line\n");
    let second = fx.commit_all("move and indent lines");

    for repo in [fx.repo(), fx.restricted()] {
        let blame = |path: &str, text: Option<&str>, ignore_whitespace, movement| {
            repo.blame_with_options(
                &fx.path(path),
                text,
                None,
                encoding_rs::UTF_8.into(),
                GitAnnotateSettings { ignore_whitespace, movement },
            )
            .unwrap()
        };
        use GitAnnotateMovement::{AcrossFiles, WithinFile};
        assert_eq!(blame("spaces.txt", None, true, GitAnnotateMovement::None)[0].commit, first);
        assert_eq!(blame("spaces.txt", None, false, GitAnnotateMovement::None)[0].commit, second);
        assert_eq!(
            blame("spaces.txt", Some("\tthis line is only indented later\n"), true, GitAnnotateMovement::None)[0]
                .commit,
            first
        );
        let unchanged = blame("target.txt", None, true, GitAnnotateMovement::None);
        let moved = blame("target.txt", None, true, WithinFile);
        let copied = blame("target.txt", None, true, AcrossFiles);
        let commits = |lines: &[ide_vcs::BlameLine]| [lines[6].commit.clone(), lines[7].commit.clone()];
        assert_eq!(commits(&unchanged), [second.clone(), second.clone()]);
        assert_eq!(commits(&moved), [first.clone(), second.clone()]);
        assert_eq!(commits(&copied), [first.clone(), first.clone()]);
        assert!(copied[6].origin_path.is_none());
        assert!(copied[7].origin_path.as_ref().unwrap().0.ends_with(source));
    }
}
