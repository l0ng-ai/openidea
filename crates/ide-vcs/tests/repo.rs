//! End-to-end tests against throwaway repositories created with the git CLI.

use ide_core::CancellationToken;
use ide_core::error::{ErrorData, ErrorKind};
use ide_vcs::*;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Instant;

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
        ("tag.gpgsign", "false"),
        ("core.autocrlf", "false"),
        ("core.hooksPath", ".git/hooks"),
        ("pull.rebase", "false"),
        ("merge.conflictstyle", "merge"),
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

/// A bare "origin" plus a clone of it with one commit on main.
fn with_remote() -> (Fixture, PathBuf) {
    let fx = Fixture::new();
    let bare = fx._tmp.path().join("origin.git");
    git_in(fx._tmp.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    git_in(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    fx.write("a.txt", "one\n");
    fx.commit_all("initial");
    fx.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
    fx.git(&["push", "-q", "-u", "origin", "main"]);
    (fx, bare)
}

fn status_of<'a>(st: &'a [FileStatus], rel: &str) -> &'a FileStatus {
    st.iter().find(|s| s.rel_path == rel).unwrap_or_else(|| panic!("{rel} missing from status: {st:#?}"))
}

#[test]
fn repo_is_send() {
    fn assert_send<T: Send>() {}
    assert_send::<Repo>();
    assert_send::<std::sync::Mutex<Repo>>();
}

#[test]
fn discover_outside_and_inside() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(Repo::discover(tmp.path()).unwrap().is_none());

    let fx = Fixture::new();
    fx.write("sub/dir/f.txt", "x\n");
    let repo = Repo::discover(&fx.path("sub/dir")).unwrap().unwrap();
    assert_eq!(std::fs::canonicalize(repo.root()).unwrap(), std::fs::canonicalize(&fx.dir).unwrap());
    let repo = Repo::discover(&fx.path("sub/dir/f.txt")).unwrap().unwrap();
    assert_eq!(std::fs::canonicalize(repo.root()).unwrap(), std::fs::canonicalize(&fx.dir).unwrap());
}

#[test]
fn discover_sha256_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("work");
    std::fs::create_dir(&dir).unwrap();
    git_in(&dir, &["init", "-q", "--object-format=sha256"]);
    let repo = Repo::discover(&dir).unwrap().unwrap();
    assert_eq!(std::fs::canonicalize(repo.root()).unwrap(), std::fs::canonicalize(&dir).unwrap());
    assert!(repo.status().unwrap().is_empty());
}

#[test]
fn repository_without_commits() {
    let fx = Fixture::new();
    fx.write("new.txt", "hello\n");
    let repo = fx.repo();
    let info = repo.branch_info().unwrap();
    assert_eq!(info.head.as_deref(), Some("main"));
    assert_eq!(info.head_commit, None);
    assert!(repo.log(&LogQuery::default()).unwrap().is_empty());
    assert!(repo.branches().unwrap().is_empty());
    assert!(repo.stashes().unwrap().is_empty());
    assert_eq!(repo.file_at(Path::new("new.txt"), None, encoding_rs::UTF_8).unwrap(), None);

    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "new.txt").unstaged, Some(ChangeKind::Untracked));
    let hunks = repo.line_hunks(&fx.path("new.txt"), "hello\n", false, encoding_rs::UTF_8).unwrap();
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].kind, HunkKind::Added);

    repo.stage(&[fx.path("new.txt")]).unwrap();
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "new.txt").staged, Some(ChangeKind::Added));
    assert_eq!(status_of(&st, "new.txt").unstaged, None);

    repo.unstage(&[fx.path("new.txt")]).unwrap();
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "new.txt").staged, None);
    assert_eq!(status_of(&st, "new.txt").unstaged, Some(ChangeKind::Untracked));

    repo.stage(&[PathBuf::from("new.txt")]).unwrap();
    let id = repo.commit("first", false, false).unwrap();
    assert_eq!(id, fx.git(&["rev-parse", "HEAD"]));
    assert!(repo.status().unwrap().is_empty());
}

#[test]
fn status_leaves_an_up_to_date_index_alone() {
    // The watcher reports `.git/index` writes as VCS changes, which refresh the
    // status: rewriting it unconditionally made that a loop.
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    // Older than the index, so it isn't racily clean (that settles after a write or two).
    let past = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
    std::fs::File::options().write(true).open(fx.path("a.txt")).unwrap().set_modified(past).unwrap();
    fx.commit_all("init");
    let repo = fx.repo();
    repo.status().unwrap(); // may persist refreshed stat info once
    let index = fx.path(".git/index");
    let before = std::fs::metadata(&index).unwrap().modified().unwrap();
    for _ in 0..3 {
        assert!(repo.status().unwrap().is_empty());
    }
    assert_eq!(std::fs::metadata(&index).unwrap().modified().unwrap(), before);
}

#[test]
fn status_matrix() {
    let fx = Fixture::new();
    fx.write(".gitignore", "*.log\nbuild/\n");
    fx.write("modified.txt", "a\n");
    fx.write("staged_mod.txt", "a\n");
    fx.write("deleted.txt", "a\n");
    fx.write("staged_del.txt", "a\n");
    fx.write("rename_me.txt", "some longer content\nthat is stable\nfor rename detection\n");
    fx.write("both.txt", "a\n");
    // A committed file the IDE ignores keeps its history but drops out of the change list.
    fx.write("tracked.pyc", "a\n");
    fx.git(&["add", "-f", "tracked.pyc"]);
    fx.commit_all("base");

    fx.write("modified.txt", "b\n");
    fx.write("staged_mod.txt", "b\n");
    fx.git(&["add", "staged_mod.txt"]);
    std::fs::remove_file(fx.path("deleted.txt")).unwrap();
    fx.git(&["rm", "-q", "staged_del.txt"]);
    fx.git(&["mv", "rename_me.txt", "renamed.txt"]);
    fx.write("added.txt", "new\n");
    fx.git(&["add", "added.txt"]);
    fx.write("both.txt", "b\n");
    fx.git(&["add", "both.txt"]);
    fx.write("both.txt", "c\n");
    fx.write("untracked.txt", "u\n");
    fx.write("dir/nested/untracked2.txt", "u\n");
    fx.write("debug.log", "ignored\n");
    fx.write("build/out.bin", "ignored\n");
    fx.write(".DS_Store", "junk");
    fx.write("dir/.DS_Store", "junk");
    fx.write("pkg/__pycache__/m.pyc", "junk");
    fx.write("tracked.pyc", "b\n");
    // Contents differ from `staged_del.txt` so rename detection cannot pair them.
    fx.write("staged_ignored.pyc", "cached\nbytecode\n");
    fx.git(&["add", "-f", "staged_ignored.pyc"]);

    let repo = fx.repo();
    repo.set_ignored_names(ide_core::settings::Settings::default().ignored_names());
    let st = repo.status().unwrap();
    let check = |rel: &str, staged: Option<ChangeKind>, unstaged: Option<ChangeKind>| {
        let s = status_of(&st, rel);
        assert_eq!((s.staged, s.unstaged), (staged, unstaged), "{rel}");
        assert_eq!(s.path, repo.root().join(rel));
    };
    use ChangeKind::*;
    check("modified.txt", None, Some(Modified));
    check("staged_mod.txt", Some(Modified), None);
    check("deleted.txt", None, Some(Deleted));
    check("staged_del.txt", Some(Deleted), None);
    check("added.txt", Some(Added), None);
    check("both.txt", Some(Modified), Some(Modified));
    check("untracked.txt", None, Some(Untracked));
    check("dir/nested/untracked2.txt", None, Some(Untracked));
    check("renamed.txt", Some(Renamed), None);
    assert_eq!(status_of(&st, "renamed.txt").renamed_from.as_deref(), Some("rename_me.txt"));
    assert!(!st.iter().any(|s| s.rel_path == "rename_me.txt"), "rename source listed: {st:#?}");
    assert!(!st.iter().any(|s| s.rel_path.contains("debug.log") || s.rel_path.contains("build")));
    assert!(
        !st.iter().any(|s| s.rel_path.contains("tracked.pyc") || s.rel_path.contains("staged_ignored.pyc")),
        "{st:#?}"
    );
    assert!(!st.iter().any(|s| s.rel_path.contains(".DS_Store") || s.rel_path.contains("pkg")), "{st:#?}");
    // Sorted by path.
    let paths: Vec<_> = st.iter().map(|s| s.rel_path.clone()).collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted);
}

#[test]
fn merge_conflict_and_versions() {
    let fx = Fixture::new();
    fx.write("c.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "other"]);
    fx.write("c.txt", "theirs\n");
    fx.commit_all("theirs");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("c.txt", "ours\n");
    fx.commit_all("ours");

    let repo = fx.repo();
    let err = repo.merge("other").unwrap_err();
    assert!(err.message.contains("CONFLICT"), "{err:?}");
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("merge"));
    let st = repo.status().unwrap();
    let s = status_of(&st, "c.txt");
    assert_eq!((s.staged, s.unstaged), (None, Some(ChangeKind::Conflicted)));
    let (base, ours, theirs) = repo.conflict_versions(&fx.path("c.txt"), encoding_rs::UTF_8).unwrap();
    assert_eq!(base.as_deref(), Some("base\n"));
    assert_eq!(ours.as_deref(), Some("ours\n"));
    assert_eq!(theirs.as_deref(), Some("theirs\n"));

    // Resolve and conclude the merge.
    fx.write("c.txt", "resolved\n");
    repo.stage(&[fx.path("c.txt")]).unwrap();
    let id = repo.commit("merge other", false, false).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    let log = repo.log(&LogQuery { limit: 1, ..LogQuery::default() }).unwrap();
    assert_eq!(log[0].id, id);
    assert_eq!(log[0].parents.len(), 2);
}

#[test]
fn ahead_behind_fetch_push_with_remote() {
    let (fx, bare) = with_remote();
    let repo = fx.repo();
    let info = repo.branch_info().unwrap();
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    assert_eq!((info.ahead, info.behind), (0, 0));

    fx.write("a.txt", "two\n");
    fx.commit_all("local 1");
    fx.write("a.txt", "three\n");
    fx.commit_all("local 2");

    // Another clone pushes a commit to origin.
    let other = fx._tmp.path().join("other");
    git_in(
        fx._tmp.path(),
        &["clone", "-q", "-c", "core.autocrlf=false", bare.to_str().unwrap(), other.to_str().unwrap()],
    );
    configure(&other);
    std::fs::write(other.join("b.txt"), "remote\n").unwrap();
    git_in(&other, &["add", "-A"]);
    git_in(&other, &["commit", "-q", "-m", "remote 1"]);
    git_in(&other, &["push", "-q", "origin", "main"]);

    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = lines.clone();
    repo.fetch(&CancellationToken::new(), &move |l| sink.lock().unwrap().push(l)).unwrap();
    assert!(!lines.lock().unwrap().is_empty(), "no progress output");
    let info = repo.branch_info().unwrap();
    assert_eq!((info.ahead, info.behind), (2, 1));

    let branches = repo.branches().unwrap();
    assert!(branches[0].current);
    assert_eq!(branches[0].name, "main");
    assert_eq!(branches[0].upstream.as_deref(), Some("origin/main"));
    assert_eq!((branches[0].ahead, branches[0].behind), (2, 1));
    assert!(branches.iter().any(|b| b.remote && b.name == "origin/main"));
    assert!(!branches.iter().any(|b| b.name.ends_with("/HEAD")));

    // Pull (merge) then push.
    repo.pull(false, &CancellationToken::new(), &|_| {}).unwrap();
    let info = repo.branch_info().unwrap();
    assert_eq!((info.ahead, info.behind), (3, 0));
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = lines.clone();
    repo.push(false, false, &CancellationToken::new(), &move |l| sink.lock().unwrap().push(l)).unwrap();
    assert!(lines.lock().unwrap().iter().any(|l| l.contains("main")), "{:?}", lines.lock().unwrap());
    let info = repo.branch_info().unwrap();
    assert_eq!((info.ahead, info.behind), (0, 0));

    // New branch pushed with --set-upstream; upstream picked up without reopening.
    repo.checkout("feature", true).unwrap();
    assert_eq!(repo.branch_info().unwrap().upstream, None);
    fx.write("f.txt", "feature\n");
    fx.commit_all("feature work");
    repo.push(false, true, &CancellationToken::new(), &|_| {}).unwrap();
    let info = repo.branch_info().unwrap();
    assert_eq!(info.head.as_deref(), Some("feature"));
    assert_eq!(info.upstream.as_deref(), Some("origin/feature"));

    // Rewrite history and force-push with lease.
    fx.git(&["commit", "-q", "--amend", "-m", "feature work (amended)"]);
    assert!(repo.push(false, false, &CancellationToken::new(), &|_| {}).is_err());
    repo.push(true, false, &CancellationToken::new(), &|_| {}).unwrap();

    // Checking out a remote branch creates a local tracking branch.
    repo.checkout("main", false).unwrap();
    repo.delete_branch("feature", true).unwrap();
    repo.checkout("origin/feature", false).unwrap();
    let info = repo.branch_info().unwrap();
    assert_eq!(info.head.as_deref(), Some("feature"));
    assert_eq!(info.upstream.as_deref(), Some("origin/feature"));
}

#[test]
fn accept_conflict_side_preserves_binary_blob_mode_and_deletion() {
    let fx = Fixture::new();
    let binary = fx.path("asset [1].bin");
    let gone = fx.path("gone.txt");
    std::fs::write(&binary, b"base\0\x80\n").unwrap();
    fx.write("gone.txt", "base\n");
    fx.write("asset 1.bin", "unchanged sibling\n");
    fx.commit_all("base");
    fx.git(&["branch", "other"]);
    std::fs::write(&binary, b"ours\0\x81\n").unwrap();
    fx.write("gone.txt", "modified\n");
    fx.commit_all("ours");
    fx.git(&["switch", "other"]);
    let incoming = b"theirs\0\x82\xff\r\n";
    std::fs::write(&binary, incoming).unwrap();
    // Keep the checkout's mode in step with the index so `core.fileMode` sees no local change.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    fx.git(&["rm", "gone.txt"]);
    fx.git(&["--literal-pathspecs", "add", "--chmod=+x", "--", "asset [1].bin"]);
    fx.git(&["commit", "-m", "theirs"]);
    let blob = fx.git(&["rev-parse", "HEAD:asset [1].bin"]);
    fx.git(&["switch", "main"]);
    let repo = fx.repo();
    assert!(repo.merge("other").is_err());

    let versions = repo.merge_versions(&binary, encoding_rs::UTF_8).unwrap();
    assert!(versions.binary && versions.merged.is_none());
    assert!(repo.accept_conflict_side(&[binary.clone(), fx.path("asset 1.bin")], ConflictSide::Theirs).is_err());
    assert_ne!(std::fs::read(&binary).unwrap(), incoming);

    let paths = [binary.clone(), gone.clone()];
    repo.accept_conflict_side(&paths, ConflictSide::Theirs).unwrap();
    assert_eq!(std::fs::read(&binary).unwrap(), incoming);
    assert_eq!(
        fx.git(&["--literal-pathspecs", "ls-files", "--stage", "--", "asset [1].bin"]),
        format!("100755 {blob} 0\tasset [1].bin")
    );
    assert!(!gone.exists());
    assert_eq!(fx.read("asset 1.bin"), "unchanged sibling\n");
    assert!(fx.git(&["ls-files", "-u"]).is_empty());
    assert_eq!(repo.resolved_conflicts().unwrap(), paths);
    repo.revert_resolved_conflicts(&paths).unwrap();
    assert_eq!(fx.git(&["diff", "--name-only", "--diff-filter=U"]), "asset [1].bin\ngone.txt");
}

#[test]
fn manual_unstash_accepts_current_branch_for_yours_and_stash_for_theirs() {
    for pop in [false, true] {
        let fx = Fixture::new();
        let files = ["local-choice.txt", "stash-choice.txt"];
        for file in files {
            fx.write(file, "base\n");
        }
        fx.commit_all("base");
        for file in files {
            fx.write(file, "stashed\n");
        }
        fx.git(&["stash", "push"]);
        for file in files {
            fx.write(file, "current\n");
        }
        fx.commit_all("current");
        let repo = fx.repo();
        let selected = repo.stashes().unwrap().remove(0);
        assert_eq!(
            repo.unstash_selected(&selected, pop, false, None).unwrap(),
            StashApplyResult { index: 0, outcome: StashApplyOutcome::Conflicts { repository: repo.root().into() } }
        );
        assert_eq!(repo.stashes().unwrap().len(), 1);
        assert!(repo.unstash_selected(&selected, pop, false, None).is_err());
        for (file, side, expected) in
            [(files[0], ConflictSide::Ours, "current"), (files[1], ConflictSide::Theirs, "stashed")]
        {
            let repo = fx.repo();
            let path = fx.path(file);
            let versions = repo.merge_versions(&path, encoding_rs::UTF_8).unwrap();
            assert_eq!(versions.sides.operation.as_deref(), Some("stash-apply"));
            assert!(!versions.sides.reversed);
            assert_eq!(versions.ours.as_deref(), Some("current\n"));
            assert_eq!(versions.theirs.as_deref(), Some("stashed\n"));
            repo.accept_conflict_side(&[path], side).unwrap();
            assert_eq!(fx.git(&["show", &format!(":{file}")]), expected);
        }
        assert!(fx.git(&["ls-files", "-u"]).is_empty());
    }
}

#[test]
fn resolved_conflict_survives_status_and_reopens_only_the_selected_file() {
    let fx = Fixture::new();
    for file in ["file [1].txt", "file 1.txt", "untouched.txt"] {
        fx.write(file, "base\n");
    }
    fx.commit_all("base");
    fx.git(&["branch", "other"]);
    for file in ["file [1].txt", "file 1.txt"] {
        fx.write(file, "ours\n");
    }
    fx.commit_all("ours");
    fx.git(&["switch", "other"]);
    for file in ["file [1].txt", "file 1.txt"] {
        fx.write(file, "theirs\n");
    }
    fx.commit_all("theirs");
    fx.git(&["switch", "main"]);
    let repo = fx.repo();
    assert!(repo.merge("other").is_err());
    let selected = fx.path("file [1].txt");
    let sibling = fx.path("file 1.txt");
    for file in ["file [1].txt", "file 1.txt"] {
        fx.write(file, "resolved\n");
    }
    repo.stage(&[selected.clone(), sibling.clone()]).unwrap();
    std::fs::File::options()
        .write(true)
        .open(fx.path("untouched.txt"))
        .unwrap()
        .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(86400))
        .unwrap();
    let _ = repo.status().unwrap();
    let paths = repo.resolved_conflicts().unwrap();
    assert_eq!(paths, [sibling.clone(), selected.clone()]);
    assert!(repo.revert_resolved_conflicts(&[selected.clone(), fx.path("untouched.txt")]).is_err());
    assert_eq!(fx.read("file [1].txt"), "resolved\n");

    repo.revert_resolved_conflicts(std::slice::from_ref(&selected)).unwrap();
    assert_eq!(fx.git(&["diff", "--name-only", "--diff-filter=U"]), "file [1].txt");
    assert!(fx.read("file [1].txt").contains("<<<<<<<"));
    assert_eq!(fx.read("file 1.txt"), "resolved\n");
    assert_eq!(repo.resolved_conflicts().unwrap(), [sibling]);
    fx.write("file [1].txt", "resolved again\n");
    repo.stage(std::slice::from_ref(&selected)).unwrap();
    fx.git(&["commit", "-m", "merge"]);
    assert!(repo.resolved_conflicts().unwrap().is_empty());
    assert!(repo.revert_resolved_conflicts(&[selected]).is_err());
}

#[test]
fn revert_resolved_modify_delete_conflicts_restores_either_surviving_side() {
    let fx = Fixture::new();
    fx.write("ours.txt", "base\n");
    fx.write("theirs.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["branch", "other"]);
    fx.write("ours.txt", "our content\n");
    fx.git(&["rm", "theirs.txt"]);
    fx.commit_all("ours");
    fx.git(&["switch", "other"]);
    fx.write("theirs.txt", "their content\n");
    fx.git(&["rm", "ours.txt"]);
    fx.commit_all("theirs");
    fx.git(&["switch", "main"]);
    let repo = fx.repo();
    assert!(repo.merge("other").is_err());
    fx.git(&["rm", "ours.txt", "theirs.txt"]);
    let paths = [fx.path("ours.txt"), fx.path("theirs.txt")];
    assert_eq!(repo.resolved_conflicts().unwrap(), paths);
    repo.revert_resolved_conflicts(&paths).unwrap();
    assert_eq!(fx.git(&["diff", "--name-only", "--diff-filter=U"]), "ours.txt\ntheirs.txt");
    assert_eq!(fx.read("ours.txt"), "our content\n");
    assert_eq!(fx.read("theirs.txt"), "their content\n");
    assert!(repo.resolved_conflicts().unwrap().is_empty());
}

#[test]
fn network_failure_maps_to_error() {
    let fx = Fixture::new();
    fx.write("a", "a\n");
    fx.commit_all("a");
    fx.git(&["remote", "add", "origin", "/nonexistent/path/to/repo.git"]);
    let err = fx.repo().fetch(&CancellationToken::new(), &|_| {}).unwrap_err();
    assert_ne!(err.kind, ErrorKind::Cancelled);
    assert!(!err.message.is_empty());
}

#[cfg(unix)]
#[test]
fn cancellation_kills_hanging_fetch() {
    let fx = Fixture::new();
    fx.write("a", "a\n");
    fx.commit_all("a");
    // An "ssh" that never answers.
    fx.git(&["config", "core.sshCommand", "sh -c 'sleep 30'"]);
    fx.git(&["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
    let repo = fx.repo();
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        trigger.cancel();
    });
    let started = Instant::now();
    let err = repo.fetch(&cancel, &|_| {}).unwrap_err();
    t.join().unwrap();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "cancel took {:?}", started.elapsed());

    let pre = CancellationToken::new();
    pre.cancel();
    assert_eq!(repo.pull(true, &pre, &|_| {}).unwrap_err().kind, ErrorKind::Cancelled);
}

#[test]
fn line_hunks_against_head_and_index() {
    let fx = Fixture::new();
    fx.write("f.txt", "1\n2\n3\n4\n5\n");
    fx.write(".gitignore", "ignored.txt\n");
    fx.commit_all("base");
    let repo = fx.repo();
    let p = fx.path("f.txt");

    assert!(repo.line_hunks(&p, "1\n2\n3\n4\n5\n", false, encoding_rs::UTF_8).unwrap().is_empty());
    assert!(repo.line_hunks(&p, "1\r\n2\r\n3\r\n4\r\n5\r\n", false, encoding_rs::UTF_8).unwrap().is_empty());

    let h = repo.line_hunks(&p, "0\n1\n2\n3\n4\n5\n", false, encoding_rs::UTF_8).unwrap();
    assert_eq!((h.len(), h[0].kind, h[0].start, h[0].lines), (1, HunkKind::Added, 0, 1));

    let h = repo.line_hunks(&p, "1\n2\n3\n4\n5\n6\n", false, encoding_rs::UTF_8).unwrap();
    assert_eq!((h[0].kind, h[0].start, h[0].lines), (HunkKind::Added, 5, 1));

    let h = repo.line_hunks(&p, "1\nX\n3\n4\n5\n", false, encoding_rs::UTF_8).unwrap();
    assert_eq!((h[0].kind, h[0].start, h[0].lines, h[0].old_text.as_str()), (HunkKind::Modified, 1, 1, "2\n"));

    let h = repo.line_hunks(&p, "1\n4\n5\n", false, encoding_rs::UTF_8).unwrap();
    assert_eq!((h[0].kind, h[0].start, h[0].lines, h[0].old_start, h[0].old_lines), (HunkKind::Deleted, 1, 0, 1, 2));
    let h = repo.line_hunks(&p, "2\n3\n4\n5\n", false, encoding_rs::UTF_8).unwrap();
    assert_eq!((h[0].kind, h[0].start), (HunkKind::Deleted, 0));
    let h = repo.line_hunks(&p, "1\n2\n3\n4\n", false, encoding_rs::UTF_8).unwrap();
    assert_eq!((h[0].kind, h[0].start, h[0].old_start), (HunkKind::Deleted, 4, 4));

    // Against the index: staged changes are not reported.
    fx.write("f.txt", "1\nX\n3\n4\n5\n");
    fx.git(&["add", "f.txt"]);
    assert!(repo.line_hunks(&p, "1\nX\n3\n4\n5\n", true, encoding_rs::UTF_8).unwrap().is_empty());
    assert_eq!(repo.line_hunks(&p, "1\nX\n3\n4\n5\n", false, encoding_rs::UTF_8).unwrap().len(), 1);

    // New and ignored files.
    let h = repo.line_hunks(&fx.path("new.txt"), "a\nb\n", false, encoding_rs::UTF_8).unwrap();
    assert_eq!((h.len(), h[0].kind, h[0].start, h[0].lines), (1, HunkKind::Added, 0, 2));
    assert!(repo.line_hunks(&fx.path("ignored.txt"), "a\n", false, encoding_rs::UTF_8).unwrap().is_empty());
    assert!(repo.line_hunks(Path::new("/definitely/outside"), "a\n", false, encoding_rs::UTF_8).unwrap().is_empty());
}

#[test]
fn blame_with_unsaved_edits() {
    let fx = Fixture::new();
    fx.write("b.txt", "one\ntwo\nthree\n");
    let first = fx.commit_all("first");
    fx.write("b.txt", "one\nTWO\nthree\n");
    let second = fx.commit_all("second");
    let repo = fx.repo();

    let lines = repo.blame(&fx.path("b.txt"), None, None, encoding_rs::UTF_8).unwrap();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0].commit, first);
    assert_eq!(lines[1].commit, second);
    assert_eq!(lines[1].summary, "second");
    assert_eq!(lines[0].author, "Test User");
    assert!(lines[0].time_ms > 1.0e12);

    let lines = repo.blame(&fx.path("b.txt"), Some("one\nedited\nthree\nfour"), None, encoding_rs::UTF_8).unwrap();
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[0].commit, first);
    assert!(lines[1].commit.bytes().all(|b| b == b'0'));
    assert_eq!(lines[1].author, "Not Committed Yet");
    assert_eq!(lines[2].commit, first);
    assert_eq!(lines[3].author, "Not Committed Yet");

    let lines = repo.blame(&fx.path("untracked.txt"), Some("x\ny\n"), None, encoding_rs::UTF_8).unwrap();
    assert_eq!(lines.len(), 2);
    assert!(lines.iter().all(|l| l.author == "Not Committed Yet"));
}

#[test]
fn blame_against_another_revision() {
    // The merge view blames each side pane on the branch it belongs to: lines that
    // only exist on the merged branch show their real history, not "Not Committed Yet".
    let fx = Fixture::new();
    fx.write("b.txt", "one\nthree\n");
    let first = fx.commit_all("first");
    fx.write("b.txt", "one\nTWO\nthree\n");
    fx.commit_all("second");
    fx.git(&["checkout", "-q", "-b", "feature", &first]);
    fx.write("b.txt", "one\nfeature\nthree\n");
    let feature = fx.commit_all("feature line");
    fx.git(&["checkout", "-q", "main"]);
    let repo = fx.repo();

    // Blaming the feature content against HEAD marks its extra line uncommitted…
    let text = "one\nfeature\nthree\n";
    let lines = repo.blame(&fx.path("b.txt"), Some(text), Some("HEAD"), encoding_rs::UTF_8).unwrap();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0].commit, first);
    assert_eq!(lines[1].author, "Not Committed Yet");
    assert_eq!(lines[2].commit, first);
    // …while blaming it against the feature commit resolves its real history.
    let lines = repo.blame(&fx.path("b.txt"), Some(text), Some(&feature), encoding_rs::UTF_8).unwrap();
    assert_eq!(lines[1].commit, feature);
    assert_eq!(lines[1].summary, "feature line");
    assert!(repo.blame(&fx.path("b.txt"), Some(text), Some("no-such-ref"), encoding_rs::UTF_8).is_err());
}

#[test]
fn log_filters_pagination_and_refs() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let c1 = fx.commit_all("add a");
    fx.write("b/b.txt", "1\n");
    let c2 = fx.commit_all("add b\n\nLonger body mentioning NEEDLE.");
    fx.git(&["tag", "v1"]);
    fx.write("a.txt", "2\n");
    fx.git(&["add", "-A"]);
    fx.git(&["-c", "user.name=Other Person", "-c", "user.email=other@corp.test", "commit", "-q", "-m", "change a"]);
    let c3 = fx.git(&["rev-parse", "HEAD"]);
    fx.git(&["checkout", "-q", "-b", "side", &c2]);
    fx.write("side.txt", "s\n");
    let c4 = fx.commit_all("side work");
    fx.git(&["checkout", "-q", "main"]);
    let repo = fx.repo();

    let all = repo.log(&LogQuery::default()).unwrap();
    let ids: Vec<_> = all.iter().map(|c| c.id.clone()).collect();
    assert_eq!(ids.len(), 4);
    assert_eq!(*ids.last().unwrap(), c1);
    let pos = |id: &str| ids.iter().position(|x| x == id).unwrap();
    assert!(pos(&c3) < pos(&c2) && pos(&c4) < pos(&c2) && pos(&c2) < pos(&c1));

    let head = all.iter().find(|c| c.id == c3).unwrap();
    assert!(head.refs.contains(&"HEAD".to_string()) && head.refs.contains(&"main".to_string()), "{:?}", head.refs);
    assert_eq!(head.author, "Other Person");
    assert_eq!(head.email, "other@corp.test");
    assert_eq!(head.parents, vec![c2.clone()]);
    assert_eq!(head.short_id, c3[..8]);
    let tagged = all.iter().find(|c| c.id == c2).unwrap();
    assert!(tagged.refs.contains(&"tag: v1".to_string()));
    assert_eq!(tagged.summary, "add b");
    assert!(tagged.message.contains("NEEDLE"));
    assert!(all.iter().find(|c| c.id == c4).unwrap().refs.contains(&"side".to_string()));

    let main_only = repo.log(&LogQuery { branch: Some("main".into()), ..Default::default() }).unwrap();
    assert_eq!(main_only.len(), 3);

    let by_path = repo.log(&LogQuery { path: Some(fx.path("a.txt").into()), ..Default::default() }).unwrap();
    assert_eq!(by_path.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec![c3.as_str(), c1.as_str()]);
    let by_dir = repo.log(&LogQuery { path: Some("b".into()), ..Default::default() }).unwrap();
    assert_eq!(by_dir.len(), 1);
    assert_eq!(by_dir[0].id, c2);

    let by_author = repo.log(&LogQuery { author: Some("other@CORP".into()), ..Default::default() }).unwrap();
    assert_eq!(by_author.len(), 1);
    let by_text = repo.log(&LogQuery { text: Some("needle".into()), ..Default::default() }).unwrap();
    assert_eq!(by_text.len(), 1);
    assert_eq!(by_text[0].id, c2);
    let text = |t: &str, regex: bool, case: bool| {
        let q = LogQuery { text: Some(t.into()), text_regex: regex, text_match_case: case, ..Default::default() };
        repo.log(&q).map(|l| l.into_iter().map(|c| c.id).collect::<Vec<_>>())
    };
    assert!(text("needle", false, true).unwrap().is_empty());
    assert_eq!(text("NEEDLE", false, true).unwrap(), vec![c2.clone()]);
    assert_eq!(text("^add b$", true, false).unwrap(), vec![c2.clone()]);
    assert!(text("(", true, false).is_err());
    assert_eq!(text(&c3[..7], false, false).unwrap(), vec![c3.clone()]);

    let page1 = repo.log(&LogQuery { branch: Some("main".into()), limit: 2, ..Default::default() }).unwrap();
    let page2 = repo.log(&LogQuery { branch: Some("main".into()), skip: 2, limit: 2, ..Default::default() }).unwrap();
    assert_eq!(page1.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), vec![c3.clone(), c2.clone()]);
    assert_eq!(page2.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), vec![c1.clone()]);

    assert_eq!(repo.log(&LogQuery { branch: Some("HEAD~1".into()), ..Default::default() }).unwrap()[0].id, c2);
    assert_eq!(
        repo.log(&LogQuery { branch: Some("nope".into()), ..Default::default() }).unwrap_err().kind,
        ErrorKind::NotFound
    );
}

#[test]
fn commit_files_kinds() {
    let fx = Fixture::new();
    fx.write("keep.txt", "k\n");
    fx.write("mod.txt", "m\n");
    fx.write("del.txt", "d\n");
    fx.write("old_name.txt", "a fairly long line of content\nanother line\nand a third\n");
    let root = fx.commit_all("root");
    fx.write("mod.txt", "m2\n");
    std::fs::remove_file(fx.path("del.txt")).unwrap();
    fx.write("dir/added.txt", "new\n");
    fx.git(&["mv", "old_name.txt", "dir/new_name.txt"]);
    let c = fx.commit_all("changes");
    let repo = fx.repo();

    let files = repo.commit_files(&c).unwrap();
    let find = |p: &str| files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p}: {files:#?}"));
    assert_eq!(find("mod.txt").kind, ChangeKind::Modified);
    assert_eq!(find("del.txt").kind, ChangeKind::Deleted);
    assert_eq!(find("dir/added.txt").kind, ChangeKind::Added);
    assert_eq!(find("dir/new_name.txt").kind, ChangeKind::Renamed);
    assert_eq!(find("dir/new_name.txt").old_path.as_deref(), Some("old_name.txt"));
    assert_eq!(files.len(), 4, "{files:#?}");

    let files = repo.commit_files(&root).unwrap();
    assert_eq!(files.len(), 4);
    assert!(files.iter().all(|f| f.kind == ChangeKind::Added));
    assert!(repo.commit_files("HEAD").unwrap().len() == 4);
}

/// Stages a symbolic link (mode 120000) to `target` without touching the working tree, so
/// the test needs no symlink support from the file system.
fn stage_link(fx: &Fixture, path: &str, target: &str) {
    let blob = fx._tmp.path().join("link-target");
    std::fs::write(&blob, target).unwrap();
    let id = fx.git(&["hash-object", "-w", blob.to_str().unwrap()]);
    fx.git(&["update-index", "--add", "--cacheinfo", &format!("120000,{id},{path}")]);
}

/// Git records only a link's target path; the changed-file lists resolve it in the commit's tree (#3777).
#[test]
fn changed_files_classify_symbolic_links_in_the_revision_tree() {
    let fx = Fixture::new();
    for dir in ["dir1", "dir2", "nested/deep"] {
        fx.write(&format!("{dir}/example.txt"), "example\n");
    }
    fx.write("plain.txt", "p\n");
    let root = fx.commit_all("directories");
    let cases = [
        ("link1", "dir1", Some(LinkTarget::Dir)),
        ("link2", "dir2/", Some(LinkTarget::Dir)),
        ("link3", "dir3", Some(LinkTarget::Unresolved)),
        ("file_link", "plain.txt", Some(LinkTarget::File)),
        ("nested/up", "../dir1/example.txt", Some(LinkTarget::File)),
        ("nested/here", ".", Some(LinkTarget::Dir)),
        ("via_link", "link1/example.txt", Some(LinkTarget::File)),
        ("chain", "link1", Some(LinkTarget::Dir)),
        ("absolute", "/etc", Some(LinkTarget::Unresolved)),
        ("escape", "../outside", Some(LinkTarget::Unresolved)),
        ("loop_a", "loop_b", Some(LinkTarget::Unresolved)),
        ("loop_b", "loop_a", Some(LinkTarget::Unresolved)),
        ("through_file", "plain.txt/x", Some(LinkTarget::Unresolved)),
    ];
    for (path, target, _) in &cases {
        stage_link(&fx, path, target);
    }
    fx.write("dir1/more.txt", "more\n");
    fx.git(&["add", "dir1/more.txt"]);
    fx.git(&["commit", "-q", "-m", "links"]);
    let links = fx.git(&["rev-parse", "HEAD"]);
    let repo = fx.repo();

    let check = |files: &[(String, Option<LinkTarget>)], label: &str| {
        for (path, _, expected) in &cases {
            let found = files.iter().find(|(p, _)| p == path).unwrap_or_else(|| panic!("{label} {path}: {files:?}"));
            assert_eq!(found.1, *expected, "{label} {path}");
        }
        let plain = files.iter().find(|(p, _)| p == "dir1/more.txt").unwrap();
        assert_eq!(plain.1, None, "{label}: a regular file is no link");
    };
    let pairs = |files: Vec<ChangedFile>| files.into_iter().map(|f| (f.path, f.link)).collect::<Vec<_>>();
    check(&pairs(repo.commit_files(&links).unwrap()), "commit_files");
    check(&pairs(repo.diff_revisions(&root, &links).unwrap()), "diff_revisions");
    let combined = repo.commits_changes(std::slice::from_ref(&links)).unwrap();
    check(&combined.into_iter().map(|f| (f.path, f.link)).collect::<Vec<_>>(), "commits_changes");

    // A deleted link is described as it was before the deletion; the working tree plays no part.
    fx.git(&["rm", "-q", "--cached", "link1", "file_link"]);
    fx.git(&["commit", "-q", "-m", "drop links"]);
    let dropped = fx.git(&["rev-parse", "HEAD"]);
    for files in [repo.commit_files(&dropped).unwrap(), repo.diff_revisions(&links, &dropped).unwrap()] {
        let files = pairs(files);
        assert!(files.contains(&("link1".into(), Some(LinkTarget::Dir))), "{files:?}");
        assert!(files.contains(&("file_link".into(), Some(LinkTarget::File))), "{files:?}");
    }
}

/// Line counts follow the same first-parent diff as the commit's file list, including renames.
#[test]
fn diff_numstat_counts_added_deleted_and_renames() {
    let fx = Fixture::new();
    fx.write("keep.txt", "a\nb\nc\n");
    fx.write("mod.txt", "m\n");
    fx.write("old.txt", "a fairly long line of content\nanother line\nand a third\n");
    let root = fx.commit_all("root");
    fx.write("mod.txt", "m\nmore\n");
    std::fs::remove_file(fx.path("keep.txt")).unwrap();
    fx.write("fresh.txt", "n1\nn2\n");
    fx.git(&["mv", "old.txt", "new.txt"]);
    fx.write("new.txt", "a fairly long line of content\nanother line\nchanged\n");
    let c = fx.commit_all("changes");
    let repo = fx.repo();

    let stats = repo.diff_numstat(&root, &c, &[]).unwrap();
    let find = |p: &str| stats.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p}: {stats:#?}"));
    assert_eq!((find("mod.txt").added, find("mod.txt").removed), (1, 0));
    assert_eq!((find("keep.txt").added, find("keep.txt").removed), (0, 3));
    assert_eq!((find("fresh.txt").added, find("fresh.txt").removed), (2, 0));
    assert_eq!(find("new.txt").old_path.as_deref(), Some("old.txt"));
    assert_eq!((find("new.txt").added, find("new.txt").removed), (1, 1));

    let only = repo.diff_numstat(&root, &c, &["mod.txt".into()]).unwrap();
    assert_eq!(only.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["mod.txt"]);
    // The log passes both names, which is what lets git still report the rename.
    let renamed = repo.diff_numstat(&root, &c, &["old.txt".into(), "new.txt".into()]).unwrap();
    assert_eq!(renamed.len(), 1, "{renamed:#?}");
    assert_eq!(renamed[0].old_path.as_deref(), Some("old.txt"));
    assert_eq!((renamed[0].added, renamed[0].removed), (1, 1));

    let created = repo.diff_numstat("4b825dc642cb6eb9a060e54bf8d69288fbee4904", &root, &["mod.txt".into()]).unwrap();
    assert_eq!((created[0].added, created[0].removed), (1, 0));
}

/// IDEA's multi-commit Git Log selection: per file, before the first commit touching it ↔
/// after the last one, contiguous or not.
#[test]
fn commits_changes_merge_selected_commits() {
    let fx = Fixture::new();
    fx.write("a.txt", "a0\n");
    fx.write("b.txt", "b0\n");
    fx.write("gone.txt", "g\n");
    fx.write("move.txt", "a fairly long line of content\nanother line\nand a third\n");
    let c0 = fx.commit_all("c0");
    fx.write("a.txt", "a1\n");
    fx.write("tmp.txt", "t\n");
    let c1 = fx.commit_all("c1");
    fx.write("b.txt", "b2\n");
    fx.git(&["mv", "move.txt", "moved.txt"]);
    let c2 = fx.commit_all("c2");
    fx.write("a.txt", "a3\n");
    std::fs::remove_file(fx.path("tmp.txt")).unwrap();
    std::fs::remove_file(fx.path("gone.txt")).unwrap();
    std::fs::create_dir(fx.path("dir")).unwrap();
    fx.git(&["mv", "moved.txt", "dir/final.txt"]);
    let c3 = fx.commit_all("c3");
    let repo = fx.repo();
    let changes = |ids: &[&String]| {
        let ids: Vec<String> = ids.iter().map(|s| (*s).clone()).collect();
        // Sorted by path.
        repo.commits_changes(&ids)
            .unwrap()
            .into_iter()
            .map(|c| (c.path, c.kind, c.old_path, c.before, c.after))
            .collect::<Vec<_>>()
    };
    let s = |x: &String| Some(x.clone());
    let selection = |ids: &[&String]| {
        let ids: Vec<String> = ids.iter().map(|s| (*s).clone()).collect();
        repo.commit_selection_changes(&ids, &ide_core::CancellationToken::new())
            .unwrap()
            .into_iter()
            .map(|c| (c.path, c.kind, c.old_path, c.before, c.after))
            .collect::<Vec<_>>()
    };

    // Contiguous c1..c3: tmp.txt added then deleted drops out; the rename chain collapses.
    assert_eq!(
        changes(&[&c1, &c2, &c3]),
        vec![
            ("a.txt".into(), ChangeKind::Modified, None, s(&c0), s(&c3)),
            ("b.txt".into(), ChangeKind::Modified, None, s(&c1), s(&c2)),
            ("dir/final.txt".into(), ChangeKind::Renamed, Some("move.txt".into()), s(&c1), s(&c3)),
            ("gone.txt".into(), ChangeKind::Deleted, None, s(&c2), None),
        ]
    );
    // Non-contiguous c1 + c3: each file from before its first selected change.
    assert_eq!(
        changes(&[&c1, &c3]),
        vec![
            ("a.txt".into(), ChangeKind::Modified, None, s(&c0), s(&c3)),
            ("dir/final.txt".into(), ChangeKind::Renamed, Some("moved.txt".into()), s(&c2), s(&c3)),
            ("gone.txt".into(), ChangeKind::Deleted, None, s(&c2), None),
        ]
    );
    // Plan edits and autosquash may present a selection out of history order.
    assert_eq!(selection(&[&c3, &c1, &c2, &c3]), changes(&[&c1, &c2, &c3]));
    assert_eq!(selection(&[&c3, &c1]), changes(&[&c1, &c3]));
    // The root commit has no parent: everything is added; a duplicate id counts once.
    let root = changes(&[&c0, &c0]);
    assert_eq!(root.len(), 4);
    assert!(root.iter().all(|c| c.1 == ChangeKind::Added && c.3.is_none() && c.4 == s(&c0)));
    // A single commit matches its own changed files.
    assert_eq!(changes(&[&c2]).len(), repo.commit_files(&c2).unwrap().len());
}

#[test]
fn file_at_revisions_and_index() {
    let fx = Fixture::new();
    fx.write("f.txt", "v1\n");
    let c1 = fx.commit_all("v1");
    fx.write("f.txt", "v2\n");
    fx.commit_all("v2");
    fx.write("f.txt", "v3\n");
    fx.git(&["add", "f.txt"]);
    let repo = fx.repo();
    let p = fx.path("f.txt");
    assert_eq!(repo.file_at(&p, None, encoding_rs::UTF_8).unwrap().as_deref(), Some("v2\n"));
    assert_eq!(repo.file_at(&p, Some(&c1), encoding_rs::UTF_8).unwrap().as_deref(), Some("v1\n"));
    assert_eq!(repo.file_at(&p, Some("HEAD~1"), encoding_rs::UTF_8).unwrap().as_deref(), Some("v1\n"));
    assert_eq!(repo.file_at(&p, Some(":0"), encoding_rs::UTF_8).unwrap().as_deref(), Some("v3\n"));
    assert_eq!(repo.file_at(Path::new("missing.txt"), None, encoding_rs::UTF_8).unwrap(), None);
    assert_eq!(repo.file_at(&p, Some("no-such-rev"), encoding_rs::UTF_8).unwrap_err().kind, ErrorKind::NotFound);
}

#[test]
fn file_at_in_a_blobless_clone() {
    let fx = Fixture::new();
    fx.write("f.txt", "v1\n");
    let c1 = fx.commit_all("v1");
    fx.write("f.txt", "v2\n");
    fx.commit_all("v2");
    fx.git(&["config", "uploadpack.allowFilter", "true"]);
    // Git refuses a clone source with a local hooks-path override.
    fx.git(&["config", "--unset", "core.hooksPath"]);
    let clone = fx.dir.parent().unwrap().join("clone");
    let url = format!("file://{}", fx.dir.display());
    git_in(fx.dir.parent().unwrap(), &["clone", "-q", "--filter=blob:none", &url, "clone"]);
    let repo = Repo::discover(&clone).unwrap().unwrap();
    repo.set_execution_allowed(true);
    // v1's blob was never fetched; reading it fetches it on demand.
    assert_eq!(repo.file_at(&clone.join("f.txt"), Some(&c1), encoding_rs::UTF_8).unwrap().as_deref(), Some("v1\n"));
}

#[test]
fn branches_sorted_current_first() {
    let fx = Fixture::new();
    fx.write("a", "a\n");
    fx.commit_all("a");
    fx.git(&["branch", "older"]);
    fx.git(&["checkout", "-q", "-b", "newer"]);
    fx.write("a", "b\n");
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "b"]);
    let env_date = "2090-01-02T00:00:00";
    let out = Command::new("git")
        .current_dir(&fx.dir)
        .args(["commit", "-q", "--allow-empty", "-m", "future"])
        .env("GIT_COMMITTER_DATE", env_date)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    fx.git(&["checkout", "-q", "main"]);
    let repo = fx.repo();
    let b = repo.branches().unwrap();
    let names: Vec<_> = b.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names[0], "main");
    assert!(b[0].current);
    assert_eq!(names[1], "newer");
    assert!(names.contains(&"older"));
    assert!(b.iter().all(|b| !b.remote && b.last_commit_ms > 0.0));
}

#[test]
fn stash_push_list_apply_pop() {
    let fx = Fixture::new();
    fx.write("s.txt", "base\n");
    fx.commit_all("base");
    let repo = fx.repo();

    fx.write("s.txt", "change 1\n");
    repo.stash_push(Some("first stash"), false, false, &[]).unwrap();
    assert_eq!(fx.read("s.txt"), "base\n");
    fx.write("s.txt", "change 2\n");
    fx.write("u.txt", "untracked\n");
    repo.stash_push(None, true, false, &[]).unwrap();
    assert!(!fx.path("u.txt").exists());

    let stashes = repo.stashes().unwrap();
    assert_eq!(stashes.len(), 2);
    assert_eq!(stashes[0].index, 0);
    assert!(stashes[0].message.contains("WIP on main"), "{stashes:?}");
    assert!(stashes[1].message.contains("first stash"), "{stashes:?}");
    assert!(stashes[0].time_ms > 0.0);
    // Each stash lists the files it changed against the commit it was made on.
    let head = repo.head().unwrap().1.unwrap();
    assert!(stashes.iter().all(|s| s.base.as_deref() == Some(head.as_str())), "{stashes:?}");
    let files = repo.commit_files(&stashes[1].id).unwrap();
    assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["s.txt"]);

    repo.stash_apply(1, false, false).unwrap();
    assert_eq!(fx.read("s.txt"), "change 1\n");
    assert_eq!(repo.stashes().unwrap().len(), 2);
    repo.discard(&[fx.path("s.txt")]).unwrap();
    repo.stash_apply(0, true, false).unwrap();
    assert_eq!(fx.read("s.txt"), "change 2\n");
    assert!(fx.path("u.txt").exists());
    assert_eq!(repo.stashes().unwrap().len(), 1);
    repo.stash_drop(0).unwrap();
    assert!(repo.stashes().unwrap().is_empty());
    assert!(repo.stash_drop(0).is_err());
}

#[test]
fn selected_stash_pop_applies_and_drops_the_entry_at_its_new_index() {
    let fx = Fixture::new();
    fx.write("s.txt", "base\n");
    fx.commit_all("base");
    let repo = fx.repo();
    fx.write("s.txt", "selected\n");
    repo.stash_push(Some("selected"), false, false, &[]).unwrap();
    let selected = repo.stashes().unwrap().remove(0);
    fx.write("s.txt", "later\n");
    fx.git(&["stash", "push", "-qm", "later"]);
    let later = repo.stashes().unwrap().remove(0);

    let result = repo.unstash_selected(&selected, true, false, None).unwrap();
    assert_eq!(result, StashApplyResult { index: 1, outcome: StashApplyOutcome::Done });
    assert_eq!(fx.read("s.txt"), "selected\n");
    assert!(matches!(repo.stashes().unwrap().as_slice(), [entry] if entry.id == later.id));
    assert!(repo.unstash_selected(&selected, true, false, None).is_err());
    assert!(repo.drop_selected_stash(&selected).is_err());
    assert!(matches!(repo.stashes().unwrap().as_slice(), [entry] if entry.id == later.id));
}

#[test]
fn selected_stash_drop_distinguishes_two_entries_for_the_same_commit() {
    let fx = Fixture::new();
    fx.write("s.txt", "base\n");
    fx.commit_all("base");
    let repo = fx.repo();
    fx.write("s.txt", "selected\n");
    repo.stash_push(Some("selected"), false, false, &[]).unwrap();
    let selected = repo.stashes().unwrap().remove(0);
    fx.write("s.txt", "later\n");
    fx.git(&["stash", "push", "-qm", "later"]);
    let seconds = (selected.time_ms / 1000.0) as i64;
    assert!(
        Command::new("git")
            .current_dir(&fx.dir)
            .args(["stash", "store", "-qm", &selected.message, &selected.id])
            .env("GIT_COMMITTER_DATE", format!("@{seconds} +0000"))
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(repo.stashes().unwrap().len(), 3);
    assert!(repo.drop_selected_stash(&selected).unwrap_err().message.contains("ambiguous"));
    assert_eq!(repo.stashes().unwrap().len(), 3);
    fx.git(&["stash", "drop", "-q", "stash@{0}"]);
    fx.git(&["stash", "store", "-m", "same commit with a different message", &selected.id]);
    assert_eq!(repo.drop_selected_stash(&selected).unwrap(), 2);
    assert!(matches!(
        repo.stashes().unwrap().as_slice(),
        [alias, later] if alias.id == selected.id && alias.message.contains("different message") && later.message.contains("later")
    ));
    assert_eq!(fx.read("s.txt"), "base\n");
}

#[test]
fn selected_stash_branch_rechecks_the_list_after_checkout() {
    let fx = Fixture::new();
    fx.write("s.txt", "base\n");
    fx.commit_all("base");
    let repo = fx.repo();
    fx.write("s.txt", "selected\n");
    fx.git(&["add", "s.txt"]);
    repo.stash_push(Some("selected"), false, false, &[]).unwrap();
    let selected = repo.stashes().unwrap().remove(0);
    fx.write("s.txt", "created during checkout\n");
    let payload = fx.git(&["stash", "create"]);
    fx.git(&["restore", "s.txt"]);
    let hook = ".git/hooks/post-checkout";
    fx.write(hook, &format!("#!/bin/sh\ngit stash store -m 'created during checkout' {payload}\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(fx.path(hook), std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let result = repo.unstash_selected(&selected, false, false, Some("from-selected")).unwrap();
    assert_eq!(result, StashApplyResult { index: 0, outcome: StashApplyOutcome::Done });
    assert_eq!(fx.git(&["branch", "--show-current"]), "from-selected");
    assert_eq!(fx.git(&["show", ":s.txt"]), "selected");
    assert!(matches!(repo.stashes().unwrap().as_slice(), [entry] if entry.id == payload));
}

#[test]
fn stash_keep_index_reinstate_index_and_branch() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.write("b.txt", "b\n");
    fx.commit_all("base");
    let repo = fx.repo();
    let staged = |fx: &Fixture| fx.git(&["diff", "--cached", "--name-only"]).trim().to_string();

    fx.write("a.txt", "a staged\n");
    fx.git(&["add", "a.txt"]);
    fx.write("b.txt", "b unstaged\n");
    repo.stash_push(Some("keep"), false, true, &[]).unwrap();
    // Keep index: the staged change stays, the unstaged one is stashed.
    assert_eq!(fx.read("a.txt"), "a staged\n");
    assert_eq!(fx.read("b.txt"), "b\n");
    assert_eq!(staged(&fx), "a.txt");

    fx.git(&["reset", "-q", "--hard"]);
    repo.stash_apply(0, false, true).unwrap();
    // Reinstate index: what was staged is staged again.
    assert_eq!(staged(&fx), "a.txt");
    assert_eq!(fx.read("b.txt"), "b unstaged\n");
    fx.git(&["reset", "-q", "--hard"]);
    repo.stash_apply(0, false, false).unwrap();
    assert_eq!(staged(&fx), "");

    fx.git(&["reset", "-q", "--hard"]);
    assert!(repo.stash_branch(0, "-bad").is_err());
    repo.stash_branch(0, "from-stash").unwrap();
    assert_eq!(fx.git(&["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "from-stash");
    assert_eq!(fx.read("b.txt"), "b unstaged\n");
    assert!(repo.stashes().unwrap().is_empty());
}

#[test]
fn log_filters_several_branches_and_authors() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let c1 = fx.commit_all("one");
    fx.git(&["checkout", "-q", "-b", "left"]);
    fx.write("l.txt", "l\n");
    let left = fx.commit_all("left");
    fx.git(&["checkout", "-q", "-b", "right", &c1]);
    fx.write("r.txt", "r\n");
    fx.git(&["add", "-A"]);
    fx.git(&["-c", "user.name=Someone Else", "-c", "user.email=else@corp.test", "commit", "-q", "-m", "right"]);
    let right = fx.git(&["rev-parse", "HEAD"]).trim().to_string();
    fx.git(&["checkout", "-q", "-b", "third", &c1]);
    fx.write("t.txt", "t\n");
    let third = fx.commit_all("third");
    let repo = fx.repo();
    let ids = |q: LogQuery| repo.log(&q).unwrap().into_iter().map(|c| c.id).collect::<Vec<_>>();

    let two = ids(LogQuery { branch: Some("left".into()), branches: vec!["right".into()], ..Default::default() });
    assert!(two.contains(&left) && two.contains(&right) && two.contains(&c1));
    assert!(!two.contains(&third));
    let only = ids(LogQuery { branches: vec!["third".into()], ..Default::default() });
    assert_eq!(only, vec![third.clone(), c1.clone()]);

    let everyone = ids(LogQuery { authors: vec!["else@corp".into(), "nobody".into()], ..Default::default() });
    assert_eq!(everyone, vec![right.clone()]);
    let both = ids(LogQuery { author: Some("ELSE".into()), authors: vec!["test@".into()], ..Default::default() });
    assert!(both.contains(&right) && both.len() > 1);
}

#[test]
fn log_range_lists_outgoing_commits() {
    let (fx, _bare) = with_remote();
    let repo = fx.repo();
    let none = repo.log(&LogQuery { range: Some("@{u}..HEAD".into()), ..Default::default() }).unwrap();
    assert!(none.is_empty(), "{none:?}");
    fx.write("b.txt", "b\n");
    let c2 = fx.commit_all("second");
    fx.write("a.txt", "two\n");
    let c3 = fx.commit_all("third");
    let out = repo.log(&LogQuery { range: Some("@{u}..HEAD".into()), ..Default::default() }).unwrap();
    assert_eq!(out.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), vec![c3.clone(), c2.clone()]);
    assert!(out[0].refs.contains(&"HEAD".to_string()));
    let by_path = repo
        .log(&LogQuery { range: Some("@{u}..HEAD".into()), path: Some(fx.path("b.txt").into()), ..Default::default() })
        .unwrap();
    assert_eq!(by_path.len(), 1);
    assert_eq!(by_path[0].id, c2);
    let limited =
        repo.log(&LogQuery { range: Some("origin/main..HEAD".into()), limit: 1, ..Default::default() }).unwrap();
    assert_eq!(limited.len(), 1);
    assert!(repo.log(&LogQuery { range: Some("--all".into()), ..Default::default() }).is_err());
}

#[test]
fn delete_remote_branch_pushes_deletion() {
    let (fx, bare) = with_remote();
    fx.git(&["push", "-q", "origin", "main:feature"]);
    fx.git(&["fetch", "-q", "origin"]);
    let repo = fx.repo();
    assert!(repo.branches().unwrap().iter().any(|b| b.remote && b.name == "origin/feature"));
    repo.delete_remote_branch("origin/feature", &CancellationToken::new(), &|_| {}).unwrap();
    assert!(git_in(&bare, &["branch", "--list", "feature"]).is_empty());
    assert!(!repo.branches().unwrap().iter().any(|b| b.name == "origin/feature"));
    assert!(repo.delete_remote_branch("feature", &CancellationToken::new(), &|_| {}).is_err());
}

#[test]
fn deleting_the_same_remote_branch_twice_refreshes_both_repositories_and_keeps_a_homonymous_tag() {
    let (first, bare) = with_remote();
    first.git(&["tag", "feature"]);
    first.git(&["push", "-q", "origin", "main:refs/heads/feature", "refs/tags/feature"]);
    let other = Fixture::new();
    other.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
    other.git(&["fetch", "-q", "origin"]);
    let a = first.repo();
    let b = other.repo();
    for repo in [&a, &b] {
        assert!(repo.branches().unwrap().iter().any(|branch| branch.name == "origin/feature"));
        repo.delete_remote_branch("origin/feature", &CancellationToken::new(), &|_| {}).unwrap();
        assert!(!repo.branches().unwrap().iter().any(|branch| branch.name == "origin/feature"));
    }
    assert!(git_in(&bare, &["branch", "--list", "feature"]).is_empty());
    assert_eq!(git_in(&bare, &["tag", "--list", "feature"]), "feature");
}

#[test]
fn deleting_a_local_tracking_branch_checks_the_confirmed_tip_and_upstream() {
    let (fx, _bare) = with_remote();
    fx.git(&["push", "-q", "origin", "main:refs/heads/feature"]);
    fx.git(&["switch", "-qc", "work", "--track", "origin/feature"]);
    let base = fx.git(&["rev-parse", "HEAD"]);
    fx.write("work.txt", "branch work\n");
    let tip = fx.commit_all("branch work");
    fx.git(&["switch", "-q", "main"]);
    let repo = fx.repo();
    repo.delete_remote_branch("origin/feature", &CancellationToken::new(), &|_| {}).unwrap();

    assert!(repo.delete_tracking_branch("work", &base, "origin/feature").is_err());
    assert!(repo.delete_tracking_branch("work", &tip, "origin/main").is_err());
    assert_eq!(fx.git(&["rev-parse", "refs/heads/work"]), tip);

    let deleted = repo.delete_tracking_branch("work", &tip, "origin/feature").unwrap();
    assert!(deleted.unmerged);
    assert!(fx.git(&["branch", "--list", "work"]).is_empty());
    repo.restore_branch(&deleted).unwrap();
    assert_eq!(fx.git(&["rev-parse", "refs/heads/work"]), tip);
    assert_eq!(fx.git(&["config", "--get", "branch.work.remote"]), "origin");
    assert_eq!(fx.git(&["config", "--get", "branch.work.merge"]), "refs/heads/feature");
}

#[test]
fn commit_amend_and_signoff() {
    let fx = Fixture::new();
    fx.write("a", "1\n");
    fx.commit_all("init");
    let repo = fx.repo();
    fx.write("a", "2\n");
    repo.stage(&[fx.path("a")]).unwrap();
    let id = repo.commit("second\n\nbody", false, true).unwrap();
    assert_eq!(id, fx.git(&["rev-parse", "HEAD"]));
    let msg = fx.git(&["log", "-1", "--format=%B"]);
    assert!(msg.starts_with("second\n\nbody"));
    assert!(msg.contains("Signed-off-by: Test User <test@example.com>"), "{msg}");

    let amended = repo.commit("second (amended)", true, false).unwrap();
    assert_ne!(amended, id);
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]), "second (amended)");
    assert_eq!(fx.git(&["rev-list", "--count", "HEAD"]), "2");

    let kept = repo.commit("", true, false).unwrap();
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]), "second (amended)");
    assert_eq!(kept, fx.git(&["rev-parse", "HEAD"]));

    assert_eq!(repo.commit("   ", false, false).unwrap_err().kind, ErrorKind::InvalidInput);
    // Nothing staged: git refuses.
    assert!(repo.commit("nothing", false, false).is_err());
}

#[test]
fn commit_with_author_and_without_hooks() {
    let fx = Fixture::new();
    fx.write("a", "1\n");
    fx.commit_all("init");
    let hook = fx.path(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let repo = fx.repo();
    fx.write("a", "2\n");
    repo.stage(&[fx.path("a")]).unwrap();
    let hooked = CommitOptions { run_hooks: true, ..Default::default() };
    assert!(
        repo.commit_with("blocked", &hooked, &|_| Ok(encoding_rs::UTF_8)).is_err(),
        "the failing pre-commit hook runs"
    );
    let date = "2009-02-13T23:31:30+05:30";
    let options = CommitOptions {
        author: Some(" Other <other@example.com> ".into()),
        author_date: Some(date.into()),
        ..Default::default()
    };
    repo.commit_with("by other", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_eq!(fx.git(&["log", "-1", "--format=%an <%ae>"]), "Other <other@example.com>");
    assert_eq!(fx.git(&["log", "-1", "--format=%aI"]), date);
    assert_ne!(fx.git(&["log", "-1", "--format=%cI"]), date);

    let keep_date = CommitOptions { amend: true, ..Default::default() };
    repo.commit_with("amend with original date", &keep_date, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_eq!(fx.git(&["log", "-1", "--format=%aI"]), date);

    let new_date = "2012-03-05T12:34:56-04:00";
    let update_date = CommitOptions { amend: true, author_date: Some(new_date.into()), ..Default::default() };
    repo.commit_with("amend with another date", &update_date, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_eq!(fx.git(&["log", "-1", "--format=%an <%ae>"]), "Other <other@example.com>");
    assert_eq!(fx.git(&["log", "-1", "--format=%aI"]), new_date);
}

#[test]
fn checkout_create_detached_delete_rebase() {
    let fx = Fixture::new();
    fx.write("a", "1\n");
    let c1 = fx.commit_all("one");
    let repo = fx.repo();

    repo.checkout("topic", true).unwrap();
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("topic"));
    assert_eq!(repo.head().unwrap(), (Some("topic".to_string()), Some(c1.clone())));
    fx.write("t", "topic\n");
    fx.commit_all("topic work");
    repo.checkout("main", false).unwrap();
    fx.write("m", "main\n");
    let main_tip = fx.commit_all("main work");

    repo.checkout("topic", false).unwrap();
    repo.rebase("main").unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD~1"]), main_tip);

    repo.checkout(&c1, false).unwrap();
    let info = repo.branch_info().unwrap();
    assert_eq!(info.head, None);
    assert_eq!(info.head_commit.as_deref(), Some(c1.as_str()));
    assert_eq!(repo.head().unwrap(), (None, Some(c1.clone())));
    assert!(
        repo.log(&LogQuery { branch: Some("HEAD".into()), ..Default::default() }).unwrap()[0]
            .refs
            .contains(&"HEAD".to_string())
    );

    repo.checkout("main", false).unwrap();
    repo.rename_branch("topic", "topic2", false).unwrap();
    assert!(repo.branches().unwrap().iter().any(|b| b.name == "topic2"));
    assert!(repo.rename_branch("topic2", "main", false).is_err(), "existing name must be refused");
    assert!(repo.rename_branch("topic2", " ", false).is_err());
    repo.rename_branch("topic2", "topic", false).unwrap();
    assert!(repo.delete_branch("topic", false).is_err(), "unmerged branch must need force");
    repo.delete_branch("topic", true).unwrap();
    assert!(!repo.branches().unwrap().iter().any(|b| b.name == "topic"));
    assert!(repo.checkout("does-not-exist", false).is_err());
}

#[test]
fn renaming_a_branch_keeps_or_drops_its_upstream() {
    let (fx, _bare) = with_remote();
    let repo = fx.repo();
    fx.git(&["branch", "--track", "topic", "origin/main"]);

    let upstream = |name: &str| {
        repo.branches().unwrap().into_iter().find(|b| b.name == name && !b.remote).and_then(|b| b.upstream)
    };
    assert_eq!(upstream("topic").as_deref(), Some("origin/main"));

    // `git branch -m` moves the tracking with the name.
    repo.rename_branch("topic", "topic2", false).unwrap();
    assert_eq!(upstream("topic2").as_deref(), Some("origin/main"));

    // Asked to drop it, the new branch tracks nothing.
    repo.rename_branch("topic2", "topic3", true).unwrap();
    assert_eq!(upstream("topic3"), None);

    // A branch that tracks nothing has no upstream to drop; that is not an error.
    fx.git(&["branch", "plain"]);
    repo.rename_branch("plain", "plain2", true).unwrap();
    assert!(repo.branches().unwrap().iter().any(|b| b.name == "plain2" && !b.remote));
}

#[test]
fn renaming_the_current_branch_keeps_or_drops_its_upstream() {
    for unset_upstream in [false, true] {
        let (fx, _bare) = with_remote();
        let repo = fx.repo();
        repo.rename_branch("main", "renamed", unset_upstream).unwrap();
        let branch = repo.branch_info().unwrap();
        assert_eq!(branch.head.as_deref(), Some("renamed"));
        assert_eq!(branch.upstream.as_deref(), if unset_upstream { None } else { Some("origin/main") });
    }
}

#[test]
fn failed_branch_rename_does_not_unset_upstream() {
    let (fx, _bare) = with_remote();
    let repo = fx.repo();
    fx.git(&["branch", "occupied"]);
    assert!(repo.rename_branch("main", "occupied", true).is_err());
    let branch = repo.branch_info().unwrap();
    assert_eq!(branch.head.as_deref(), Some("main"));
    assert_eq!(branch.upstream.as_deref(), Some("origin/main"));
}

#[test]
fn unsetting_upstream_in_place_handles_a_missing_tracking_ref_without_renaming() {
    let (fx, _bare) = with_remote();
    let repo = fx.repo();
    fx.git(&["config", "branch.main.merge", "refs/heads/gone"]);
    let reflog = fx.git(&["reflog", "show", "--format=%gs", "main"]);
    repo.rename_branch("main", "main", true).unwrap();
    let info = repo.branch_info().unwrap();
    assert_eq!(info.head.as_deref(), Some("main"));
    assert!(info.upstream_tracking.is_none());
    assert_eq!(fx.git(&["reflog", "show", "--format=%gs", "main"]), reflog);
    repo.rename_branch("main", "main", true).unwrap();
}

#[test]
fn branch_rename_reports_when_only_unsetting_upstream_fails() {
    let (fx, _bare) = with_remote();
    let repo = fx.repo();
    // The new branch activates a broken config only after the rename has succeeded.
    fx.write(".git/broken-config", "[broken\n");
    fx.git(&["config", "includeIf.onbranch:renamed.path", "broken-config"]);
    let error = repo.rename_branch("main", "renamed", true).unwrap_err();
    assert!(error.message.contains("Renamed branch 'main' to 'renamed'"), "{error}");
    assert!(error.message.contains("could not unset its upstream"), "{error}");
    assert!(error.message.contains("bad config"), "{error}");
    std::fs::remove_file(fx.path(".git/broken-config")).unwrap();
    let branch = repo.branch_info().unwrap();
    assert_eq!(branch.head.as_deref(), Some("renamed"));
    assert_eq!(branch.upstream.as_deref(), Some("origin/main"));
}

#[test]
fn smart_and_force_checkout_with_local_changes_in_the_way() {
    let fx = Fixture::new();
    fx.write("f.txt", "1\n2\n3\n4\n5\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "other"]);
    fx.write("f.txt", "1\nother\n3\n4\n5\n");
    fx.commit_all("other edit");
    fx.git(&["checkout", "-q", "main"]);
    let repo = fx.repo();
    let opts = |mode| CheckoutOptions { mode, ..Default::default() };

    // A non-conflicting local edit to a file the switch rewrites.
    fx.write("f.txt", "1\n2\n3\n4\nlocal\n");
    let outcome = repo.checkout_with("other", false, &opts(CheckoutMode::Normal)).unwrap();
    assert_eq!(outcome, CheckoutOutcome::LocalChanges { files: vec!["f.txt".into()] });
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"), "nothing changed");
    assert_eq!(fx.read("f.txt"), "1\n2\n3\n4\nlocal\n");

    let outcome = repo.checkout_with("other", false, &opts(CheckoutMode::Smart)).unwrap();
    assert_eq!(outcome, CheckoutOutcome::Done);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("other"));
    assert_eq!(fx.read("f.txt"), "1\nother\n3\n4\nlocal\n", "local change carried over");
    assert!(repo.stashes().unwrap().is_empty(), "stash restored and dropped");

    // A local edit that conflicts with the target: smart checkout leaves a conflict.
    fx.git(&["checkout", "-q", "-f", "main"]);
    fx.write("f.txt", "1\nmine\n3\n4\n5\n");
    let outcome = repo.checkout_with("other", false, &opts(CheckoutMode::Smart)).unwrap();
    assert_eq!(outcome, CheckoutOutcome::Conflicts { files: vec!["f.txt".into()] });
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("other"));
    assert_eq!(repo.stashes().unwrap().len(), 1, "git keeps the stash after a conflicting pop");
    // The stashed edit is the user's side of the merge, the checked-out branch the other.
    let v = repo.merge_versions(&fx.path("f.txt"), encoding_rs::UTF_8).unwrap();
    assert_eq!(v.sides.operation.as_deref(), Some("unstash"));
    assert!(v.sides.reversed);
    assert_eq!(v.ours.as_deref(), Some("1\nmine\n3\n4\n5\n"));

    // Force discards the change in the way.
    fx.git(&["reset", "-q", "--hard"]);
    fx.git(&["stash", "drop", "-q"]);
    fx.write("f.txt", "1\nmine\n3\n4\n5\n");
    fx.write("untouched.txt", "new\n");
    let outcome = repo.checkout_with("main", false, &opts(CheckoutMode::Force)).unwrap();
    assert_eq!(outcome, CheckoutOutcome::Done);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));
    assert_eq!(fx.read("f.txt"), "1\n2\n3\n4\n5\n");
    assert_eq!(fx.read("untouched.txt"), "new\n", "untracked files survive");
}

#[test]
fn merge_reports_staged_blockers_with_spaces_before_preserving_local_changes() {
    let fx = Fixture::new();
    for path in ["incoming.txt", "local staged file.txt", "main.txt", "unrelated.txt"] {
        fx.write(path, "base\n");
    }
    fx.commit_all("base");
    fx.git(&["switch", "-c", "topic"]);
    fx.write("incoming.txt", "incoming\n");
    fx.commit_all("topic edit");
    fx.git(&["switch", "main"]);
    fx.write("main.txt", "main\n");
    fx.commit_all("main edit");
    fx.write("local staged file.txt", "staged\n");
    fx.git(&["add", "local staged file.txt"]);
    fx.write("unrelated.txt", "local\n");
    let repo = fx.repo();
    let before = repo.head().unwrap();
    let staged = vec!["local staged file.txt".to_owned()];
    assert_eq!(repo.merge_affected_files("topic").unwrap(), staged);
    let args = ["refs/heads/topic".to_owned()];
    let options = MergeOptions::default();
    assert_eq!(repo.merge_attempt(&args, &options, false).unwrap(), MergeOutcome::LocalChanges { files: staged },);
    assert_eq!(repo.head().unwrap(), before);
    assert_eq!(fx.git(&["show", ":local staged file.txt"]), "staged");
    assert!(repo.stashes().unwrap().is_empty());
    assert_eq!(repo.merge_attempt(&args, &options, true).unwrap(), MergeOutcome::Done);
    assert_eq!(fx.read("incoming.txt"), "incoming\n");
    assert_eq!(fx.git(&["show", ":local staged file.txt"]), "staged");
    assert_eq!(fx.read("unrelated.txt"), "local\n");
    assert!(repo.stashes().unwrap().is_empty());
}

#[test]
fn ordinary_merge_carries_unrelated_edits_without_needing_a_shelf() {
    let fx = Fixture::new();
    fx.write("incoming.txt", "base\n");
    fx.write("unrelated.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["switch", "-c", "topic"]);
    fx.write("incoming.txt", "incoming\n");
    fx.commit_all("topic edit");
    fx.git(&["switch", "main"]);
    fx.write("unrelated.txt", "local\n");
    fx.write("invalid-shelf", "not a directory\n");
    let repo = fx.repo();
    repo.set_automatic_shelf(Some(fx.path("invalid-shelf")), None);
    assert!(repo.merge_affected_files("topic").unwrap().is_empty());
    assert_eq!(repo.merge_attempt(&["topic".into()], &MergeOptions::default(), false).unwrap(), MergeOutcome::Done);
    assert_eq!(fx.read("incoming.txt"), "incoming\n");
    assert_eq!(fx.read("unrelated.txt"), "local\n");
}

#[test]
fn merge_reports_commits_prepared_changes_and_up_to_date_branches() {
    let fx = Fixture::new();
    fx.write("incoming.txt", "base\n");
    let base = fx.commit_all("base");
    fx.git(&["switch", "-c", "topic"]);
    fx.write("incoming.txt", "incoming\n");
    let tip = fx.commit_all("incoming");
    fx.git(&["switch", "main"]);
    let repo = fx.repo();
    let source = ["topic".into()];
    let squash = MergeOptions { squash: true, ..Default::default() };
    let no_commit = MergeOptions { no_commit: true, ..Default::default() };

    assert_eq!(repo.merge_attempt(&source, &squash, false).unwrap(), MergeOutcome::Squashed);
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), base);
    assert_eq!(repo.operation().unwrap(), None);
    assert_eq!(fx.git(&["show", ":incoming.txt"]), "incoming");
    fx.git(&["reset", "--hard", "HEAD"]);

    let stop = MergeOptions { no_ff: true, ..no_commit.clone() };
    assert_eq!(repo.merge_attempt(&source, &stop, false).unwrap(), MergeOutcome::ReadyToCommit);
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), base);
    assert_eq!(repo.operation().unwrap().as_deref(), Some("merge"));
    fx.git(&["merge", "--abort"]);

    assert_eq!(repo.merge_attempt(&source, &no_commit, false).unwrap(), MergeOutcome::Done);
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), tip);
    assert_eq!(repo.merge_attempt(&source, &MergeOptions::default(), false).unwrap(), MergeOutcome::AlreadyUpToDate);
    assert_eq!(repo.merge_attempt(&source, &squash, false).unwrap(), MergeOutcome::AlreadyUpToDate);
}

#[test]
fn checkout_reports_staged_and_unstaged_paths_without_changing_the_repository() {
    let fx = Fixture::new();
    for file in ["staged.txt", "unstaged.txt", "unrelated.txt"] {
        fx.write(file, "base\n");
    }
    fx.commit_all("base");
    fx.git(&["switch", "-c", "other"]);
    for file in ["staged.txt", "unstaged.txt"] {
        fx.write(file, "other\n");
    }
    fx.commit_all("other branch");
    fx.git(&["switch", "main"]);
    for file in ["staged.txt", "unstaged.txt", "unrelated.txt", "untracked.txt"] {
        fx.write(file, "local\n");
    }
    fx.git(&["add", "staged.txt"]);
    let repo = fx.repo();
    let index = std::fs::read(fx.path(".git/index")).unwrap();
    let affected = vec!["staged.txt".to_owned(), "unstaged.txt".to_owned()];
    assert_eq!(repo.checkout_affected_files("other").unwrap(), affected);
    assert_eq!(std::fs::read(fx.path(".git/index")).unwrap(), index);
    assert_eq!(repo.head().unwrap().0.as_deref(), Some("main"));
    assert_eq!(fx.read("staged.txt"), "local\n");
    assert_eq!(fx.read("unstaged.txt"), "local\n");
    assert_eq!(
        repo.checkout_with("other", false, &CheckoutOptions::default()).unwrap(),
        CheckoutOutcome::LocalChanges { files: affected },
    );
    fx.git(&["restore", "--source=HEAD", "--staged", "--worktree", "staged.txt", "unstaged.txt"]);
    assert!(repo.checkout_affected_files("other").unwrap().is_empty());
    assert_eq!(fx.read("unrelated.txt"), "local\n");
    assert_eq!(fx.read("untracked.txt"), "local\n");
}

#[test]
fn checkout_of_a_branch_held_by_another_worktree_reports_it_and_changes_nothing() {
    let fx = Fixture::new();
    fx.write("f.txt", "1\n");
    fx.commit_all("base");
    let linked = fx._tmp.path().join("linked");
    fx.git(&["worktree", "add", "-q", "-b", "topic", linked.to_str().unwrap()]);
    let repo = fx.repo();
    let none = CheckoutOptions::default();
    // As git names it: no `\\?\` prefix on Windows.
    let linked_path = dunce::canonicalize(&linked).unwrap();

    // From the main worktree, the branch the linked worktree has checked out.
    let outcome = repo.checkout_with("topic", false, &none).unwrap();
    assert_eq!(outcome, CheckoutOutcome::CheckedOutInWorktree { branch: "topic".into(), path: linked_path.clone() });
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"), "nothing changed");

    // With local changes in the way too: reported before any Smart Checkout stash.
    fx.write("f.txt", "changed\n");
    let smart = CheckoutOptions { mode: CheckoutMode::Smart, ..Default::default() };
    let outcome = repo.checkout_with("topic", false, &smart).unwrap();
    assert_eq!(outcome, CheckoutOutcome::CheckedOutInWorktree { branch: "topic".into(), path: linked_path.clone() });
    assert_eq!(fx.read("f.txt"), "changed\n", "local changes untouched");
    assert!(repo.stashes().unwrap().is_empty());
    fx.git(&["reset", "-q", "--hard"]);

    // The same refusal from the linked worktree, for the main worktree's branch.
    let linked_repo = Repo::discover(&linked).unwrap().unwrap();
    linked_repo.set_execution_allowed(true);
    let outcome = linked_repo.checkout_with("main", false, &none).unwrap();
    let main_path = dunce::canonicalize(&fx.dir).unwrap();
    assert_eq!(outcome, CheckoutOutcome::CheckedOutInWorktree { branch: "main".into(), path: main_path });
    assert_eq!(linked_repo.branch_info().unwrap().head.as_deref(), Some("topic"));

    // Overwriting such a branch (New Branch with Checkout) names the worktree, not raw stderr.
    let error = repo.create_branch_with_overwrite("topic", Some("main"), true, true).unwrap_err();
    assert!(error.message.contains("branch 'topic' is already checked out in worktree"), "{error}");
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));

    // Checkout Anyway: both worktrees then have the branch.
    let anyway = CheckoutOptions { ignore_other_worktrees: true, ..Default::default() };
    assert_eq!(repo.checkout_with("topic", false, &anyway).unwrap(), CheckoutOutcome::Done);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("topic"));
}

#[test]
fn checkout_remote_branch_with_existing_local_namesake() {
    let (fx, bare) = with_remote();
    let repo = fx.repo();
    // Another clone advances origin/main.
    let other = fx._tmp.path().join("other");
    git_in(fx._tmp.path(), &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
    configure(&other);
    std::fs::write(other.join("b.txt"), "remote\n").unwrap();
    git_in(&other, &["add", "-A"]);
    git_in(&other, &["commit", "-q", "-m", "remote work"]);
    git_in(&other, &["push", "-q", "origin", "main"]);
    fx.git(&["fetch", "-q"]);
    fx.git(&["checkout", "-q", "-b", "topic"]);
    let none = CheckoutOptions::default();

    // Local main is only behind: it is fast-forwarded and checked out.
    assert_eq!(repo.checkout_with("origin/main", false, &none).unwrap(), CheckoutOutcome::Done);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));
    assert_eq!(fx.git(&["rev-parse", "main"]), fx.git(&["rev-parse", "origin/main"]));

    // Local main has its own commit: the user must choose; nothing changes meanwhile.
    fx.write("c.txt", "local\n");
    let local_tip = fx.commit_all("local work");
    fx.git(&["checkout", "-q", "topic"]);
    let outcome = repo.checkout_with("origin/main", false, &none).unwrap();
    assert_eq!(outcome, CheckoutOutcome::LocalBranchAhead { local: "main".into(), remote: "origin/main".into() });
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("topic"));

    // Rebase onto Remote keeps the local commit on top of origin/main.
    let rebase = CheckoutOptions { diverged: Some(DivergedLocal::Rebase), ..Default::default() };
    assert_eq!(repo.checkout_with("origin/main", false, &rebase).unwrap(), CheckoutOutcome::Done);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));
    assert_eq!(fx.git(&["rev-parse", "main~1"]), fx.git(&["rev-parse", "origin/main"]));
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]), "local work");

    // Drop Local Commits resets main to origin/main.
    fx.git(&["checkout", "-q", "topic"]);
    let reset = CheckoutOptions { diverged: Some(DivergedLocal::Reset), ..Default::default() };
    assert_eq!(repo.checkout_with("origin/main", false, &reset).unwrap(), CheckoutOutcome::Done);
    assert_eq!(fx.git(&["rev-parse", "main"]), fx.git(&["rev-parse", "origin/main"]));
    assert_ne!(fx.git(&["rev-parse", "main"]), local_tip);
    assert_eq!(repo.branch_info().unwrap().upstream.as_deref(), Some("origin/main"));
}

#[test]
fn checkout_uses_the_exact_ref_when_local_and_remote_names_collide() {
    let (fx, bare) = with_remote();
    let base = fx.git(&["rev-parse", "HEAD"]);
    fx.git(&["push", "-q", "origin", "main:topic"]);
    fx.git(&["remote", "add", "team/ops", bare.to_str().unwrap()]);
    fx.git(&["fetch", "-q", "team/ops"]);
    fx.write("a.txt", "local branch\n");
    let local = fx.commit_all("local");
    fx.git(&["branch", "team/ops/topic"]);
    fx.git(&["tag", "team/ops/topic", &base]);
    let repo = fx.repo();
    let normal = CheckoutOptions::default();

    assert_eq!(repo.checkout_with("refs/remotes/team/ops/topic", false, &normal).unwrap(), CheckoutOutcome::Done);
    let info = repo.branch_info().unwrap();
    assert_eq!(info.head.as_deref(), Some("topic"));
    assert_eq!(info.head_commit.as_deref(), Some(base.as_str()));
    assert_eq!(info.upstream.as_deref(), Some("team/ops/topic"));
    assert_eq!(fx.git(&["rev-parse", "refs/heads/team/ops/topic"]), local);

    assert_eq!(repo.checkout_with("refs/heads/team/ops/topic", false, &normal).unwrap(), CheckoutOutcome::Done);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("team/ops/topic"));
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), local);
    assert_eq!(repo.checkout_with("refs/tags/team/ops/topic", false, &normal).unwrap(), CheckoutOutcome::Done);
    assert_eq!(repo.branch_info().unwrap().head, None);
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), base);
    fx.git(&["branch", &base, &local]);
    let revision = format!("{base}^{{commit}}");
    assert_eq!(repo.checkout_with(&revision, false, &normal).unwrap(), CheckoutOutcome::Done);
    assert_eq!(repo.branch_info().unwrap().head, None);
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), base);
}

#[test]
fn delete_branch_without_asking_and_restore_it() {
    let (fx, _bare) = with_remote();
    let repo = fx.repo();
    fx.git(&["checkout", "-q", "-b", "merged", "--track", "origin/main"]);
    fx.git(&["checkout", "-q", "-b", "work"]);
    fx.write("w.txt", "work\n");
    let work_tip = fx.commit_all("work");
    fx.git(&["checkout", "-q", "main"]);

    let merged = repo.delete_branch_restorable("merged").unwrap();
    assert!(!merged.unmerged);
    assert_eq!(merged.upstream.as_deref(), Some("origin/main"));
    assert_eq!(
        merged.remote_upstream,
        Some(ide_vcs::UpstreamTracking { remote: "origin".into(), branch: "main".into() })
    );

    let work = repo.delete_branch_restorable("work").unwrap();
    assert!(work.unmerged, "not fully merged branches are force-deleted and reported");
    assert_eq!(work.unmerged_base.as_deref(), Some(fx.git(&["rev-parse", "main"]).as_str()));
    assert_eq!(work.tip, work_tip);
    assert!(!repo.branches().unwrap().iter().any(|b| b.name == "work"));
    assert!(repo.delete_branch_restorable("main").is_err(), "the current branch cannot be deleted");

    repo.restore_branch(&work).unwrap();
    repo.restore_branch(&merged).unwrap();
    let branches = repo.branches().unwrap();
    let find = |n: &str| branches.iter().find(|b| !b.remote && b.name == n).unwrap().clone();
    assert_eq!(find("work").commit, work_tip);
    assert_eq!(find("merged").upstream.as_deref(), Some("origin/main"));
}

#[test]
fn cleanup_uses_head_and_preserves_the_deleted_branch_for_restore() {
    let (fx, _bare) = with_remote();
    let repo = fx.repo();
    let name = "work=topic";
    fx.git(&["checkout", "-q", "-b", name, "--track", "origin/main"]);
    let original = fx.git(&["rev-parse", "HEAD"]);
    fx.write("w.txt", "work\n");
    let tip = fx.commit_all("work");
    fx.git(&["checkout", "-q", "main"]);
    fx.git(&["branch", "shared", &tip]);
    fx.git(&["branch", "--set-upstream-to=shared", name]);
    assert!(repo.delete_merged_branch(name, &tip).is_err());
    fx.git(&["branch", "--set-upstream-to=origin/main", name]);
    fx.git(&["merge", "--ff-only", name]);
    assert!(repo.delete_merged_branch(name, &original).is_err());
    assert_eq!(fx.git(&["rev-parse", name]), tip);

    let linked = tempfile::tempdir().unwrap();
    fx.git(&["worktree", "add", linked.path().to_str().unwrap(), name]);
    assert!(repo.delete_merged_branch(name, &tip).is_err());
    fx.git(&["worktree", "remove", linked.path().to_str().unwrap()]);

    let deleted = repo.delete_merged_branch(name, &tip).unwrap();
    assert!(!deleted.unmerged);
    assert_eq!(deleted.tip, tip);
    assert_eq!(deleted.upstream.as_deref(), Some("origin/main"));
    assert!(!repo.branches().unwrap().iter().any(|branch| branch.name == name));
    repo.restore_branch(&deleted).unwrap();
    assert_eq!(fx.git(&["rev-parse", name]), tip);
    assert_eq!(fx.git(&["rev-parse", &format!("{name}@{{upstream}}")]), original);
}

#[test]
fn deleting_a_tracked_branch_records_the_upstream_as_the_unmerged_base() {
    let (fx, _bare) = with_remote();
    let base = fx.git(&["rev-parse", "origin/main"]);
    fx.git(&["switch", "-qc", "work", "--track", "origin/main"]);
    fx.write("work.txt", "branch work\n");
    let tip = fx.commit_all("branch work");
    fx.git(&["switch", "-q", "main"]);
    fx.write("main.txt", "main work\n");
    let head = fx.commit_all("main work");
    assert_ne!(base, head);

    let deleted = fx.repo().delete_branch_restorable("work").unwrap();
    assert!(deleted.unmerged);
    assert_eq!(deleted.unmerged_base.as_deref(), Some(base.as_str()));
    assert_eq!(deleted.tip, tip);
}

fn range(h: &LineHunk) -> HunkRange {
    HunkRange { start: h.start, lines: h.lines, old_start: h.old_start, old_lines: h.old_lines }
}

#[test]
fn partial_commit_selects_additions_and_deletions_inside_the_same_hunk() {
    let fx = Fixture::new();
    let base = "start\nold one\nold two\nend\n";
    let edited = "start\nnew one\nnew two\nend\n";
    fx.write("f.txt", base);
    let before = fx.commit_all("base");
    let repo = fx.repo();
    fx.write("f.txt", edited);
    let hunks = diff_hunks(base, edited);
    assert_eq!(hunks.len(), 1);
    let options = CommitOptions {
        partial: vec![PartialCommitFile {
            prepared: None,
            path: fx.path("f.txt").into(),
            hunks: vec![],
            line_hunks: vec![ide_vcs::PartialCommitHunk {
                range: range(&hunks[0]),
                old_text: "old one\nold two\n".into(),
                new_text: "new one\nnew two\n".into(),
                deletions: vec![0],
                additions: vec![1],
            }],
        }],
        ..Default::default()
    };
    fx.write("f.txt", "start\nnew one\nlate edit\nend\n");
    let file = &options.partial[0];
    assert!(repo.preview_partial_commit(file, encoding_rs::UTF_8).unwrap_err().message.contains("changed on disk"));
    let stale = repo.commit_with("stale", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap_err();
    assert!(stale.message.contains("changed on disk"));
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), before);

    fx.write("f.txt", edited);
    let preview = repo.preview_partial_commit(file, encoding_rs::UTF_8).unwrap();
    assert_eq!(preview, "start\nold two\nnew two\nend\n");
    assert_eq!(fx.git(&["show", ":f.txt"]), base.trim_end());
    let mut options = options;
    let cleaned = "start\nold two\ncleaned two\nend\n".to_owned();
    options.partial[0].prepared =
        Some(ide_vcs::PreparedPartialCommit { before: "another selection".into(), text: cleaned.clone() });
    assert!(repo.commit_with("stale cleanup", &options, &|_| Ok(encoding_rs::UTF_8)).is_err());
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), before);
    assert_eq!(fx.git(&["show", ":f.txt"]), base.trim_end());

    options.partial[0].prepared.as_mut().unwrap().before = preview;
    assert_eq!(repo.preview_partial_commit(&options.partial[0], encoding_rs::UTF_8).unwrap(), cleaned);
    repo.commit_with("selected lines", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_eq!(fx.git(&["show", "HEAD:f.txt"]), cleaned.trim_end());
    assert_eq!(fx.git(&["show", ":f.txt"]), cleaned.trim_end());
    assert_eq!(std::fs::read_to_string(fx.path("f.txt")).unwrap(), edited);
}

#[test]
fn partial_commit_of_chosen_hunks_leaves_worktree_and_index_alone() {
    let fx = Fixture::new();
    let base = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    fx.write("f.txt", base);
    fx.write("other.txt", "o\n");
    fx.write("staged.txt", "s\n");
    fx.commit_all("base");
    let repo = fx.repo();

    let edited = "A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\nk\n";
    fx.write("f.txt", edited);
    fx.write("other.txt", "o2\n");
    fx.write("staged.txt", "s2\n");
    repo.stage(&[fx.path("other.txt")]).unwrap();
    let hunks = diff_hunks(base, edited);
    assert_eq!(hunks.len(), 2);

    // Commit the first hunk of f.txt plus the staged other.txt; staged.txt is not staged.
    let options = CommitOptions {
        partial: vec![PartialCommitFile {
            prepared: None,
            path: fx.path("f.txt").into(),
            line_hunks: vec![],
            hunks: vec![range(&hunks[0])],
        }],
        ..Default::default()
    };
    repo.commit_with("partial", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();

    assert_eq!(fx.git(&["show", "HEAD:f.txt"]), "A\nb\nc\nd\ne\nf\ng\nh\ni\nj");
    assert_eq!(fx.git(&["show", "HEAD:other.txt"]), "o2");
    assert_eq!(fx.git(&["show", "HEAD:staged.txt"]), "s");
    // The working tree is untouched.
    assert_eq!(fx.read("f.txt"), edited);
    assert_eq!(fx.read("staged.txt"), "s2\n");
    // The index matches the commit; the rest of f.txt is an unstaged change.
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "");
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "f.txt").unstaged, Some(ChangeKind::Modified));
    assert_eq!(status_of(&st, "f.txt").staged, None);
    assert!(!fx.dir.join(".git/openidea-partial-index").exists());

    // A stale hunk (the file changed since the UI computed it) refuses to commit anything.
    let before = fx.git(&["rev-parse", "HEAD"]);
    let stale = CommitOptions {
        partial: vec![PartialCommitFile {
            prepared: None,
            path: fx.path("f.txt").into(),
            line_hunks: vec![],
            hunks: vec![range(&hunks[0])],
        }],
        ..Default::default()
    };
    let err = repo.commit_with("stale", &stale, &|_| Ok(encoding_rs::UTF_8)).unwrap_err();
    assert!(err.message.contains("changed"), "{}", err.message);
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), before);
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "");
    assert!(!fx.dir.join(".git/openidea-partial-index").exists());

    // The remaining hunk commits on its own; then nothing is left.
    let rest = diff_hunks(&repo.file_at(&fx.path("f.txt"), None, encoding_rs::UTF_8).unwrap().unwrap(), edited);
    assert_eq!(rest.len(), 1);
    let options = CommitOptions {
        partial: vec![PartialCommitFile {
            prepared: None,
            path: fx.path("f.txt").into(),
            line_hunks: vec![],
            hunks: vec![range(&rest[0])],
        }],
        ..Default::default()
    };
    repo.commit_with("rest", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_eq!(repo.file_at(&fx.path("f.txt"), None, encoding_rs::UTF_8).unwrap().as_deref(), Some(edited));
    assert!(repo.status().unwrap().iter().all(|f| f.rel_path != "f.txt"));
    assert_eq!(fx.read("staged.txt"), "s2\n");

    // A failing pre-commit hook leaves everything as it was.
    fx.write("f.txt", "Z\nb\nc\nd\ne\nf\ng\nh\ni\nJ\nk\nl\n");
    let hook = fx.dir.join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let head = fx.git(&["rev-parse", "HEAD"]);
    let hunks = diff_hunks(edited, &fx.read("f.txt"));
    let options = CommitOptions {
        run_hooks: true,
        partial: vec![PartialCommitFile {
            prepared: None,
            path: fx.path("f.txt").into(),
            line_hunks: vec![],
            hunks: vec![range(&hunks[0])],
        }],
        ..Default::default()
    };
    assert!(repo.commit_with("hooked", &options, &|_| Ok(encoding_rs::UTF_8)).is_err());
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "");
    assert_eq!(fx.read("f.txt"), "Z\nb\nc\nd\ne\nf\ng\nh\ni\nJ\nk\nl\n");
}

#[test]
fn pending_changes_show_what_the_commit_would_hold_without_touching_the_index() {
    let fx = Fixture::new();
    let base = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    fx.write("f.txt", base);
    fx.write("staged.txt", "s\n");
    fx.write("old.txt", "moved\nfile\nwith\nlines\n");
    fx.write("bin.dat", "\0\x01");
    fx.commit_all("base");
    let repo = fx.repo();
    let utf8 = |_: &Path| -> ide_core::IdeResult<&encoding_rs::Encoding> { Ok(encoding_rs::UTF_8) };

    let edited = "A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n";
    fx.write("f.txt", edited);
    fx.write("staged.txt", "s2\n");
    fx.git(&["add", "staged.txt"]);
    fx.git(&["mv", "old.txt", "new.txt"]);
    fx.write("bin.dat", "\0\x02");
    fx.write("added.txt", "new\n");
    let index_before = std::fs::read(fx.dir.join(".git/index")).unwrap();

    // The index as it is: the staged file and the rename.
    let plain = repo.pending_changes(&CommitOptions::default(), 1 << 20, &utf8).unwrap();
    let summary: Vec<_> = plain
        .iter()
        .map(|c| (c.status, c.path.strip_prefix(&fx.dir).unwrap().to_string_lossy().into_owned()))
        .collect();
    assert_eq!(summary, [("renamed", "new.txt".to_owned()), ("modified", "staged.txt".to_owned())]);
    assert_eq!(plain[0].old_path.as_deref(), Some(fx.path("old.txt").as_path()));
    assert!(plain[1].diff.as_deref().unwrap().contains("-s\n+s2\n"), "{:?}", plain[1].diff);

    // A selection: the first hunk of f.txt, the binary and the new file, staged.txt left out.
    let hunks = diff_hunks(base, edited);
    let options = CommitOptions {
        partial: vec![PartialCommitFile {
            prepared: None,
            path: fx.path("f.txt").into(),
            line_hunks: vec![],
            hunks: vec![range(&hunks[0])],
        }],
        stage: vec![fx.path("bin.dat").into(), fx.path("added.txt").into()],
        exclude: vec![fx.path("staged.txt").into()],
        ..Default::default()
    };
    let picked = repo.pending_changes(&options, 1 << 20, &utf8).unwrap();
    let by_name = |name: &str| picked.iter().find(|c| c.path == fx.path(name)).unwrap_or_else(|| panic!("{name}"));
    assert!(picked.iter().all(|c| c.path != fx.path("staged.txt")));
    assert_eq!(by_name("added.txt").status, "added");
    assert_eq!(by_name("bin.dat").diff, None);
    let f = by_name("f.txt").diff.clone().unwrap();
    assert!(f.starts_with("diff --git a/f.txt b/f.txt\n"), "{f}");
    assert!(f.contains("-a\n+A\n") && !f.contains("+J"), "{f}");

    // Nothing changed: the index, the working tree, no temporary index left behind.
    assert_eq!(std::fs::read(fx.dir.join(".git/index")).unwrap(), index_before);
    assert_eq!(fx.read("f.txt"), edited);
    let leftovers: Vec<_> = std::fs::read_dir(fx.dir.join(".git"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("openidea-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // The size limit cuts at a line and says so.
    let cut = repo.pending_changes(&options, 40, &utf8).unwrap();
    let total: usize = cut.iter().filter_map(|c| c.diff.as_ref()).map(String::len).sum();
    assert!(total <= 40 && cut.iter().any(|c| c.truncated));
    assert!(cut.iter().filter_map(|c| c.diff.as_ref()).all(|d| d.is_empty() || d.ends_with('\n')));
}

#[test]
fn partial_staging_with_built_patch() {
    let fx = Fixture::new();
    let base = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
    fx.write("p.txt", base);
    fx.commit_all("base");
    let repo = fx.repo();
    let new = "l0\nl1\nl2\nCHANGED\nl4\nl5\nl6\nl8\nl9\nl10\n";
    fx.write("p.txt", new);

    let index_text = repo.file_at(&fx.path("p.txt"), Some(":0"), encoding_rs::UTF_8).unwrap().unwrap();
    let hunks = ide_vcs::diff_hunks(&index_text, new);
    assert_eq!(hunks.len(), 4, "{hunks:#?}");
    // Stage the modification and the trailing addition only.
    let patch = build_partial_patch("p.txt", &index_text, new, &[1, 3]);
    repo.stage_patch(&patch, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    let staged = repo.file_at(&fx.path("p.txt"), Some(":0"), encoding_rs::UTF_8).unwrap().unwrap();
    assert_eq!(staged, "l1\nl2\nCHANGED\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    let st = repo.status().unwrap();
    let s = status_of(&st, "p.txt");
    assert_eq!((s.staged, s.unstaged), (Some(ChangeKind::Modified), Some(ChangeKind::Modified)));

    // Then the rest, one hunk at a time against the updated index.
    loop {
        let index_text = repo.file_at(&fx.path("p.txt"), Some(":0"), encoding_rs::UTF_8).unwrap().unwrap();
        if ide_vcs::diff_hunks(&index_text, new).is_empty() {
            break;
        }
        repo.stage_patch(&build_partial_patch("p.txt", &index_text, new, &[0]), &|_| Ok(encoding_rs::UTF_8)).unwrap();
    }
    assert_eq!(repo.file_at(&fx.path("p.txt"), Some(":0"), encoding_rs::UTF_8).unwrap().unwrap(), new);

    // Patches also apply to files without a trailing newline and CRLF files.
    fx.write("n.txt", "a\r\nb\r\nc");
    fx.commit_all("crlf");
    let new = "a\nB\nc\nd";
    let old = repo.file_at(&fx.path("n.txt"), Some(":0"), encoding_rs::UTF_8).unwrap().unwrap();
    repo.stage_patch(&build_partial_patch("n.txt", &old, new, &[0, 1]), &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_eq!(repo.file_at(&fx.path("n.txt"), Some(":0"), encoding_rs::UTF_8).unwrap().unwrap(), "a\r\nB\r\nc\r\nd");
}

#[test]
fn discard_and_diff_text() {
    let fx = Fixture::new();
    fx.write("t.txt", "one\n");
    fx.write("both.txt", "one\n");
    fx.write("keep/k.txt", "k\n");
    fx.commit_all("base");
    let repo = fx.repo();

    fx.write("t.txt", "two\n");
    fx.write("both.txt", "staged\n");
    fx.git(&["add", "both.txt"]);
    fx.write("both.txt", "unstaged\n");
    fx.write("u.txt", "untracked\n");
    fx.write("udir/x.txt", "x\n");
    fx.write("keep/new.txt", "n\n");
    fx.write("keep/k.txt", "changed\n");

    let unstaged = repo.diff_text(&fx.path("both.txt"), false, encoding_rs::UTF_8).unwrap();
    assert!(unstaged.contains("-staged\n+unstaged"), "{unstaged}");
    let staged = repo.diff_text(&fx.path("both.txt"), true, encoding_rs::UTF_8).unwrap();
    assert!(staged.contains("-one\n+staged"), "{staged}");
    let untracked = repo.diff_text(&fx.path("u.txt"), false, encoding_rs::UTF_8).unwrap();
    assert!(untracked.contains("+untracked"), "{untracked}");
    assert!(repo.diff_text(&fx.path("t.txt"), true, encoding_rs::UTF_8).unwrap().is_empty());

    repo.discard(&[fx.path("t.txt"), fx.path("both.txt"), fx.path("u.txt"), fx.path("udir"), fx.path("keep")]).unwrap();
    assert_eq!(fx.read("t.txt"), "one\n");
    assert_eq!(fx.read("both.txt"), "staged\n", "staged change is kept");
    assert!(!fx.path("u.txt").exists());
    assert!(!fx.path("udir").exists());
    assert!(!fx.path("keep/new.txt").exists());
    assert_eq!(fx.read("keep/k.txt"), "k\n");
    let st = repo.status().unwrap();
    assert_eq!(st.len(), 1, "{st:#?}");
    assert_eq!(status_of(&st, "both.txt").staged, Some(ChangeKind::Modified));
}

#[test]
fn errors_carry_git_messages() {
    let fx = Fixture::new();
    fx.write("a", "1\n");
    fx.commit_all("a");
    let repo = fx.repo();
    let err = repo.merge("no-such-branch").unwrap_err();
    assert!(!err.message.is_empty());
    let err = repo.stage(&[PathBuf::from("../outside")]).unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidInput);
    assert!(repo.stash_apply(5, false, false).is_err());
}

#[test]
fn packed_refs_reload_without_a_newer_modification_time() {
    for keep_time in [false, true] {
        for linked in [false, true] {
            let fx = Fixture::new();
            fx.write("file.txt", "one\n");
            let first = fx.commit_all("one");
            fx.git(&["branch", "-m", "master"]);
            let root = if linked {
                let path = fx._tmp.path().join("linked");
                fx.git(&["worktree", "add", "-qb", "agent/check", path.to_str().unwrap()]);
                path
            } else {
                fx.dir.clone()
            };
            let packed = fx.path(".git/packed-refs");
            std::fs::write(
                &packed,
                format!("# pack-refs with: peeled fully-peeled sorted \n{first} refs/remotes/origin/master\n"),
            )
            .unwrap();
            let set_modified = |time| {
                std::fs::OpenOptions::new().write(true).open(&packed).unwrap().set_modified(time).unwrap();
            };
            set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(3600));
            let original_time = std::fs::metadata(&packed).unwrap().modified().unwrap();
            let original_len = std::fs::metadata(&packed).unwrap().len();
            let repo = Repo::discover(&root).unwrap().unwrap();
            let query = LogQuery { branches: vec!["HEAD".into()], limit: 1, ..Default::default() };
            assert_eq!(repo.log(&query).unwrap()[0].id, first);

            std::fs::write(root.join("file.txt"), "two\n").unwrap();
            git_in(&root, &["add", "file.txt"]);
            git_in(&root, &["commit", "-qm", "two"]);
            let second = git_in(&root, &["rev-parse", "HEAD"]);
            fx.git(&["pack-refs", "--all", "--prune"]);
            set_modified(if keep_time { original_time } else { original_time - std::time::Duration::from_secs(60) });
            assert_ne!(std::fs::metadata(&packed).unwrap().len(), original_len);
            let branch = if linked { "agent/check" } else { "master" };
            assert!(!fx.path(&format!(".git/refs/heads/{branch}")).exists());
            for revision in ["HEAD", "@", branch] {
                let q = LogQuery { branches: vec![revision.into()], ..query.clone() };
                let rows = repo.log(&q).unwrap_or_else(|error| {
                    panic!("linked={linked}, keep_time={keep_time}, revision={revision}: {error}")
                });
                assert_eq!(rows[0].id, second);
            }
            assert_eq!(repo.head().unwrap().1.as_deref(), Some(second.as_str()));
            assert_eq!(
                repo.file_at(Path::new("file.txt"), Some("HEAD"), encoding_rs::UTF_8).unwrap().as_deref(),
                Some("two\n")
            );
        }
    }
}

#[test]
fn status_reflects_external_changes_without_reopen() {
    let fx = Fixture::new();
    fx.write("a", "1\n");
    fx.commit_all("a");
    let repo = fx.repo();
    assert!(repo.status().unwrap().is_empty());
    fx.write("a", "2\n");
    assert_eq!(repo.status().unwrap().len(), 1);
    fx.commit_all("b");
    assert!(repo.status().unwrap().is_empty());
    fx.git(&["checkout", "-q", "-b", "x"]);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("x"));
}

#[test]
fn branches_in_newly_written_packs_stay_visible() {
    let fx = Fixture::new();
    fx.write("a", "1\n");
    fx.commit_all("a");
    let repo = fx.repo();
    assert_eq!(repo.branches().unwrap().len(), 1);

    // An external pull: objects move into a pack the IDE has never seen, then a
    // new branch points at a commit living only in that pack.
    fx.write("a", "2\n");
    fx.commit_all("b");
    fx.git(&["repack", "-adq"]);
    fx.git(&["checkout", "-q", "-b", "uat"]);
    let uat = fx.git(&["rev-parse", "uat"]);
    assert!(std::fs::read_dir(fx.path(".git/objects/pack")).unwrap().count() >= 2);

    let names: Vec<String> = repo.branches().unwrap().into_iter().map(|b| b.name).collect();
    assert!(names.contains(&"uat".to_string()), "branches: {names:?}, want uat at {uat}");

    // Status peels HEAD for the tree-index diff: the same failure drops it too.
    assert!(repo.status().is_ok(), "status failed: {:?}", repo.status().unwrap_err());
}

#[test]
fn linked_worktree_and_submodule() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.commit_all("a");

    let wt = fx._tmp.path().join("wt");
    fx.git(&["worktree", "add", "-q", "-b", "wt-branch", wt.to_str().unwrap()]);
    let repo = Repo::discover(&wt).unwrap().unwrap();
    assert_eq!(std::fs::canonicalize(repo.root()).unwrap(), std::fs::canonicalize(&wt).unwrap());
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("wt-branch"));
    std::fs::write(wt.join("a.txt"), "changed\n").unwrap();
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "a.txt").unstaged, Some(ChangeKind::Modified));
    repo.stage(&[wt.join("a.txt")]).unwrap();
    repo.commit("in worktree", false, false).unwrap();
    assert!(repo.status().unwrap().is_empty());
    // The main worktree is unaffected.
    assert!(fx.repo().status().unwrap().is_empty());
    assert_eq!(fx.repo().branch_info().unwrap().head.as_deref(), Some("main"));

    // Submodule: discovery from inside it finds the submodule, not the superproject.
    let sub_src = fx._tmp.path().join("subsrc");
    std::fs::create_dir(&sub_src).unwrap();
    git_in(&sub_src, &["init", "-q"]);
    configure(&sub_src);
    std::fs::write(sub_src.join("s.txt"), "s\n").unwrap();
    git_in(&sub_src, &["add", "-A"]);
    git_in(&sub_src, &["commit", "-q", "-m", "s"]);
    fx.git(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub_src.to_str().unwrap(), "sub"]);
    fx.git(&["commit", "-q", "-m", "add submodule"]);
    let inner = Repo::discover(&fx.path("sub")).unwrap().unwrap();
    assert_eq!(std::fs::canonicalize(inner.root()).unwrap(), std::fs::canonicalize(fx.path("sub")).unwrap());
    assert_eq!(inner.log(&LogQuery::default()).unwrap().len(), 1);
    let outer = fx.repo();
    assert!(outer.status().unwrap().is_empty(), "{:#?}", outer.status().unwrap());
    std::fs::write(fx.path("sub/s.txt"), "dirty\n").unwrap();
    let st = outer.status().unwrap();
    assert_eq!(status_of(&st, "sub").unstaged, Some(ChangeKind::Modified));
}

/// Manual benchmark: `OPENIDEA_VCS_BENCH_REPO=/path/to/large/repo cargo test -p ide-vcs --release -- --ignored bench`.
#[test]
#[ignore]
fn bench_status_on_large_repo() {
    let Some(path) = std::env::var_os("OPENIDEA_VCS_BENCH_REPO") else { return };
    let repo = Repo::discover(Path::new(&path)).unwrap().unwrap();
    for i in 0..3 {
        let t = Instant::now();
        let st = repo.status().unwrap();
        eprintln!("gix status #{i}: {} entries in {:?}", st.len(), t.elapsed());
    }
    let t = Instant::now();
    let out = Command::new("git").current_dir(&path).args(["status", "--porcelain=v2", "-uall"]).output().unwrap();
    eprintln!("git status: {} bytes in {:?}", out.stdout.len(), t.elapsed());
    let t = Instant::now();
    let log = repo.log(&LogQuery { limit: 500, ..Default::default() }).unwrap();
    eprintln!("log 500: {} in {:?}", log.len(), t.elapsed());
    let t = Instant::now();
    let b = repo.branches().unwrap();
    eprintln!("branches: {} in {:?}", b.len(), t.elapsed());
    let t = Instant::now();
    let log = repo.log(&LogQuery { path: Some("README.md".into()), ..Default::default() }).unwrap();
    eprintln!("log README.md (all): {} in {:?}", log.len(), t.elapsed());
    let t = Instant::now();
    let log = repo.log(&LogQuery::default()).unwrap();
    eprintln!("log (all): {} in {:?}", log.len(), t.elapsed());
}

#[test]
fn path_log_simplifies_merges() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.write("b.txt", "1\n");
    let base = fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "side"]);
    fx.write("a.txt", "side\n");
    let side = fx.commit_all("side changes a");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("b.txt", "main\n");
    fx.commit_all("main changes b");
    fx.git(&["merge", "-q", "--no-edit", "side"]);
    let repo = fx.repo();
    let ids: Vec<String> = repo
        .log(&LogQuery { branch: Some("main".into()), path: Some("a.txt".into()), ..Default::default() })
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(ids, vec![side, base.clone()]);
    let ids: Vec<String> = repo
        .log(&LogQuery {
            branch: Some("main".into()),
            path: Some("b.txt".into()),
            skip: 1,
            limit: 5,
            ..Default::default()
        })
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(ids, vec![base]);
}

#[test]
fn gbk_java_unchanged_has_no_hunks() {
    let fx = Fixture::new();
    let text = "// 中文注释\nclass Example {\n    // 保持不变\n}\n";
    std::fs::write(fx.path("Example.java"), encoding_rs::GBK.encode(text).0).unwrap();
    fx.commit_all("GBK Java");
    for against_index in [false, true] {
        assert!(
            fx.repo().line_hunks(&fx.path("Example.java"), text, against_index, encoding_rs::GBK).unwrap().is_empty()
        );
    }
}

#[test]
fn encoded_java_hunks_staging_blame_and_partial_commit_preserve_bytes() {
    for encoding in [encoding_rs::GBK, encoding_rs::SHIFT_JIS, encoding_rs::UTF_8] {
        for eol in ["\n", "\r\n"] {
            let fx = Fixture::new();
            let path = fx.path("中文.java");
            let old = "// 中文注釈\nclass Example {\n    // 保存\n    int value = 1;\n}\n".replace('\n', eol);
            let changed = old.replace("中文注釈", "中文変更").replace("value = 1", "value = 2");
            let bytes = |text: &str| {
                let (bytes, _, errors) = encoding.encode(text);
                assert!(!errors);
                bytes.into_owned()
            };
            std::fs::write(&path, bytes(&old)).unwrap();
            fx.commit_all("encoded Java");
            let repo = fx.repo();
            assert_eq!(repo.file_at(&path, None, encoding).unwrap().as_deref(), Some(old.as_str()));
            assert!(
                repo.blame(&path, Some(&old.replace("\r\n", "\n")), None, encoding)
                    .unwrap()
                    .iter()
                    .all(|line| line.author == "Test User")
            );
            let hunks = repo.line_hunks(&path, &old.replace("value = 1", "value = 2"), false, encoding).unwrap();
            assert_eq!(hunks.len(), 1);
            assert_eq!((hunks[0].start, hunks[0].lines, hunks[0].kind), (3, 1, HunkKind::Modified));
            std::fs::write(&path, bytes(&changed)).unwrap();
            let hunks = repo.line_hunks(&path, &changed, false, encoding).unwrap();
            assert_eq!(hunks.len(), 2);
            repo.stage_hunks(&path, &changed, &[0], encoding).unwrap();
            let selected = old.replace("中文注釈", "中文変更");
            assert_eq!(repo.file_bytes_at(&path, Some(":0")).unwrap().unwrap(), bytes(&selected));
            assert_eq!(std::fs::read(&path).unwrap(), bytes(&changed));
            assert!(repo.diff_text(&path, true, encoding).unwrap().contains("中文変更"));
            repo.unstage(std::slice::from_ref(&path)).unwrap();
            let options = CommitOptions {
                partial: vec![PartialCommitFile {
                    prepared: None,
                    path: path.clone().into(),
                    line_hunks: vec![],
                    hunks: vec![HunkRange {
                        start: hunks[0].start,
                        lines: hunks[0].lines,
                        old_start: hunks[0].old_start,
                        old_lines: hunks[0].old_lines,
                    }],
                }],
                ..Default::default()
            };
            repo.commit_with("selected hunk", &options, &|_| Ok(encoding)).unwrap();
            assert_eq!(repo.file_bytes_at(&path, None).unwrap().unwrap(), bytes(&selected));
            assert_eq!(repo.file_bytes_at(&path, Some(":0")).unwrap().unwrap(), bytes(&selected));
            assert_eq!(std::fs::read(&path).unwrap(), bytes(&changed));
        }
    }
}

#[test]
fn gbk_patches_round_trip_even_with_text_attributes() {
    let fx = Fixture::new();
    let path = fx.path("Example.java");
    let old = encoding_rs::GBK.encode("// 中文注释\nclass Example {}\n").0.into_owned();
    let new = encoding_rs::GBK.encode("// 修改注释\nclass Example {}\n").0.into_owned();
    fx.write(".gitattributes", "*.java diff\n");
    std::fs::write(&path, &old).unwrap();
    fx.commit_all("base");
    std::fs::write(&path, &new).unwrap();
    let repo = fx.repo();
    let patch = repo.create_patch(std::slice::from_ref(&path), false).unwrap();
    assert!(patch.contains("GIT binary patch"));
    repo.discard(std::slice::from_ref(&path)).unwrap();
    repo.apply_patch(&patch).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), new);
    let commit = fx.commit_all("change");
    let reverse = repo.create_commits_patch(&[commit], true).unwrap();
    repo.apply_patch(&reverse).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), old);
}

#[test]
fn gbk_conflict_stages_are_readable() {
    let fx = Fixture::new();
    let path = fx.path("Example.java");
    let write = |text: &str| std::fs::write(&path, encoding_rs::GBK.encode(text).0).unwrap();
    write("// 原始注释\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-b", "other"]);
    write("// 分支注释\n");
    fx.commit_all("other");
    fx.git(&["checkout", "main"]);
    write("// 当前注释\n");
    fx.commit_all("ours");
    let out = Command::new("git").current_dir(&fx.dir).args(["merge", "other"]).output().unwrap();
    assert!(!out.status.success());
    let versions = fx.repo().merge_versions(&path, encoding_rs::GBK).unwrap();
    assert_eq!(versions.base.as_deref(), Some("// 原始注释\n"));
    assert_eq!(versions.ours.as_deref(), Some("// 当前注释\n"));
    assert_eq!(versions.theirs.as_deref(), Some("// 分支注释\n"));
}

#[test]
fn utf16_and_utf8_boms_survive_partial_staging() {
    for encoding in [encoding_rs::UTF_8, encoding_rs::UTF_16LE, encoding_rs::UTF_16BE] {
        let fx = Fixture::new();
        let path = fx.path("Example.java");
        let old = "// 中文注释\r\nclass Example {}\r\n";
        let changed = old.replace("中文", "修改");
        let bytes = |text: &str| {
            if encoding == encoding_rs::UTF_8 {
                let mut bytes = vec![0xef, 0xbb, 0xbf];
                bytes.extend_from_slice(text.as_bytes());
                bytes
            } else {
                let le = encoding == encoding_rs::UTF_16LE;
                let mut bytes = if le { vec![0xff, 0xfe] } else { vec![0xfe, 0xff] };
                for unit in text.encode_utf16() {
                    bytes.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
                }
                bytes
            }
        };
        std::fs::write(&path, bytes(old)).unwrap();
        fx.commit_all("BOM");
        let repo = fx.repo();
        assert!(repo.line_hunks(&path, old, false, encoding).unwrap().is_empty());
        repo.stage_hunks(&path, &changed, &[0], encoding).unwrap();
        assert_eq!(repo.file_bytes_at(&path, Some(":0")).unwrap().unwrap(), bytes(&changed));
    }
}

#[test]
fn gbk_text_patch_keeps_utf8_paths_and_encoded_payload() {
    let fx = Fixture::new();
    let path = fx.path("中文.java");
    let old = "// 中文注释\n";
    let new = "// 修改注释\n";
    std::fs::write(&path, encoding_rs::GBK.encode(old).0).unwrap();
    fx.commit_all("GBK");
    let repo = fx.repo();
    let patch = build_partial_patch("中文.java", old, new, &[0]);
    repo.stage_patch(&patch, &|_| Ok(encoding_rs::GBK)).unwrap();
    assert_eq!(repo.file_bytes_at(&path, Some(":0")).unwrap().unwrap(), encoding_rs::GBK.encode(new).0.as_ref());
    let patch = build_partial_patch("中文.java", new, "// 😀\n", &[0]);
    assert!(repo.stage_patch(&patch, &|_| Ok(encoding_rs::GBK)).is_err());
    assert_eq!(repo.file_bytes_at(&path, Some(":0")).unwrap().unwrap(), encoding_rs::GBK.encode(new).0.as_ref());
}

#[cfg(unix)]
#[test]
fn restricted_reads_ignore_executable_repository_configuration() {
    let f = Fixture::new();
    f.write("a.txt", "one\ntwo\n");
    f.commit_all("initial");
    f.write(".gitattributes", "*.txt filter=evil diff=evil\n");
    f.write("a.txt", "one\nchanged\n");
    for key in ["filter.evil.clean", "diff.evil.textconv", "diff.external", "core.fsmonitor"] {
        f.git(&["config", key, "touch execution.marker; cat"]);
    }
    let repo = f.repo();
    repo.set_execution_allowed(false);
    assert!(!repo.status().unwrap().is_empty());
    assert!(repo.diff_text(&f.path("a.txt"), false, encoding_rs::UTF_8).unwrap().contains("changed"));
    assert_eq!(repo.blame(&f.path("a.txt"), None, None, encoding_rs::UTF_8).unwrap().len(), 2);
    assert!(!repo.diff_with_worktree("HEAD").unwrap().is_empty());
    assert!(!repo.log(&LogQuery::default()).unwrap().is_empty());
    repo.merge_versions(&f.path("a.txt"), encoding_rs::UTF_8).unwrap();
    assert!(!f.path("execution.marker").exists());
    let repos = ide_vcs::Repos::discover(&f.dir, &|_| false).unwrap();
    for r in repos.all() {
        r.set_execution_allowed(false);
    }
    let compared =
        repos.compare_paths(std::slice::from_ref(&f.dir), "HEAD", None, &ide_core::CancellationToken::new()).unwrap();
    assert!(compared.repositories.iter().all(|r| r.error.is_none()));
    assert!(!f.path("execution.marker").exists());
    // Positive control: the same filter really executes without restriction.
    f.git(&["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv"]);
    assert!(f.path("execution.marker").exists());
}

#[cfg(unix)]
#[test]
fn restricted_conflict_preview_uses_host_owned_temporary_files() {
    let f = Fixture::new();
    f.write("a.txt", "base\n");
    f.commit_all("base");
    f.git(&["checkout", "-b", "other"]);
    f.write("a.txt", "other\n");
    f.commit_all("other");
    f.git(&["checkout", "main"]);
    f.write("a.txt", "mine\n");
    f.commit_all("mine");
    let output = Command::new("git").current_dir(&f.dir).args(["merge", "other"]).output().unwrap();
    assert!(!output.status.success());
    let trap = f.path(&format!(".git/openidea-merge-{}", std::process::id()));
    std::fs::create_dir_all(&trap).unwrap();
    let marker = f._tmp.path().join("user-data");
    std::fs::write(&marker, "untouched").unwrap();
    std::os::unix::fs::symlink(&marker, trap.join("ours")).unwrap();
    let repo = f.repo();
    repo.set_execution_allowed(false);
    let versions = repo.merge_versions(&f.path("a.txt"), encoding_rs::UTF_8).unwrap();
    assert!(versions.merged.unwrap().contains("<<<<<<<"));
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "untouched");
}

#[test]
fn commit_leaves_excluded_staged_changes_staged() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.write("b.txt", "b\n");
    fx.write("old.txt", "renamed\n");
    fx.commit_all("base");
    let repo = fx.repo();

    // a.txt: staged and edited again; b.txt: staged; new.txt: staged addition; old.txt: staged rename.
    fx.write("a.txt", "a staged\n");
    fx.write("b.txt", "b staged\n");
    fx.write("new.txt", "new\n");
    fx.git(&["add", "a.txt", "b.txt", "new.txt"]);
    fx.git(&["mv", "old.txt", "moved.txt"]);
    fx.write("a.txt", "a on disk\n");

    // Commit a.txt as it is on disk; leave out b.txt, new.txt and the rename.
    let options = CommitOptions {
        stage: vec![fx.path("a.txt").into()],
        exclude: vec![
            fx.path("b.txt").into(),
            fx.path("new.txt").into(),
            fx.path("moved.txt").into(),
            fx.path("old.txt").into(),
        ],
        ..Default::default()
    };
    repo.commit_with("only a", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();

    assert_eq!(fx.git(&["show", "--name-only", "--format=", "HEAD"]), "a.txt");
    assert_eq!(fx.git(&["show", "HEAD:a.txt"]), "a on disk");
    // What was left out is still staged, exactly as before.
    let mut staged: Vec<String> =
        fx.git(&["diff", "--cached", "--name-status", "-M"]).lines().map(str::to_string).collect();
    staged.sort();
    assert_eq!(staged, ["A\tnew.txt", "M\tb.txt", "R100\told.txt\tmoved.txt"]);
    assert_eq!(fx.git(&["show", ":b.txt"]), "b staged");
    assert_eq!(fx.git(&["diff", "--name-only"]), "", "nothing unstaged is left behind");
    assert!(!fx.dir.join(".git/openidea-partial-index").exists());
}

#[test]
fn commit_of_staged_version_keeps_the_unstaged_rest() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.write("b.txt", "1\n");
    fx.commit_all("base");
    let repo = fx.repo();
    fx.write("a.txt", "2\n");
    fx.write("b.txt", "2\n");
    fx.git(&["add", "a.txt", "b.txt"]);
    fx.write("a.txt", "3\n");

    // a.txt committed as staged (its unstaged edit stays), b.txt left out.
    let options = CommitOptions { exclude: vec![fx.path("b.txt").into()], ..Default::default() };
    repo.commit_with("staged a", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();

    assert_eq!(fx.git(&["show", "HEAD:a.txt"]), "2");
    assert_eq!(fx.git(&["show", "HEAD:b.txt"]), "1");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "b.txt");
    assert_eq!(fx.git(&["diff", "--name-only"]), "a.txt");
    assert_eq!(fx.read("a.txt"), "3\n");
}

#[test]
fn commit_with_exclusions_in_a_repository_without_commits() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.write("b.txt", "b\n");
    fx.git(&["add", "-A"]);
    let repo = fx.repo();
    let options = CommitOptions { exclude: vec![fx.path("b.txt").into()], ..Default::default() };
    repo.commit_with("first", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_eq!(fx.git(&["show", "--name-only", "--format=", "HEAD"]), "a.txt");
    assert_eq!(fx.git(&["diff", "--cached", "--name-status"]), "A\tb.txt");
}

#[test]
fn smart_checkout_keeps_staged_changes_staged() {
    let fx = Fixture::new();
    fx.write("f.txt", "1\n2\n3\n4\n5\n");
    fx.write("s.txt", "s\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "other"]);
    fx.write("f.txt", "1\nother\n3\n4\n5\n");
    fx.commit_all("other edit");
    fx.git(&["checkout", "-q", "main"]);
    let repo = fx.repo();

    fx.write("f.txt", "1\n2\n3\n4\nlocal\n");
    fx.write("s.txt", "staged\n");
    fx.git(&["add", "s.txt"]);
    let opts = CheckoutOptions { mode: CheckoutMode::Smart, ..Default::default() };
    assert_eq!(repo.checkout_with("other", false, &opts).unwrap(), CheckoutOutcome::Done);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("other"));
    assert_eq!(fx.read("f.txt"), "1\nother\n3\n4\nlocal\n");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "s.txt", "staged change stays staged");
    assert_eq!(fx.git(&["diff", "--name-only"]), "f.txt");
    assert!(repo.stashes().unwrap().is_empty());
}

#[test]
fn smart_checkout_restores_its_own_stash() {
    let fx = Fixture::new();
    fx.write("f.txt", "1\n2\n3\n4\n5\n");
    fx.write("staged.txt", "base\n");
    fx.write("extra.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["switch", "-qc", "other"]);
    fx.write("f.txt", "1\nother\n3\n4\n5\n");
    fx.commit_all("other edit");
    fx.git(&["switch", "-q", "main"]);

    fx.write("extra.txt", "from the hook\n");
    let payload = fx.git(&["stash", "create"]);
    fx.git(&["restore", "extra.txt"]);
    let hook = ".git/hooks/post-checkout";
    fx.write(hook, &format!("#!/bin/sh\ngit stash store -m 'created during checkout' {payload}\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(fx.path(hook), std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fx.write("f.txt", "1\n2\n3\n4\nlocal\n");
    fx.write("staged.txt", "staged\n");
    fx.git(&["add", "staged.txt"]);
    let repo = fx.repo();
    let opts = CheckoutOptions { mode: CheckoutMode::Smart, ..Default::default() };
    assert_eq!(repo.checkout_with("other", false, &opts).unwrap(), CheckoutOutcome::Done);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("other"));
    assert_eq!(fx.read("f.txt"), "1\nother\n3\n4\nlocal\n");
    assert_eq!(fx.git(&["show", ":staged.txt"]), "staged");
    assert_eq!(fx.read("extra.txt"), "base\n");
    assert!(matches!(repo.stashes().unwrap().as_slice(), [entry] if entry.id == payload));
}

#[test]
fn smart_checkout_from_shelf_restores_edits_that_only_exist_in_the_index() {
    check_smart_checkout_from_shelf(None);
}

#[test]
fn smart_checkout_waits_for_the_shelf_batch_before_restoring_the_index() {
    check_smart_checkout_from_shelf(Some("checkout-batch"));
}

fn check_smart_checkout_from_shelf(batch: Option<&str>) {
    let fx = Fixture::new();
    fx.write("f.txt", "1\n2\n3\n4\n5\n");
    fx.write("s.txt", "base\n");
    fx.write(".openidea/.gitignore", "# Project ignores\n");
    fx.commit_all("base");
    fx.git(&["switch", "-qc", "other"]);
    fx.write("f.txt", "1\nother\n3\n4\n5\n");
    fx.commit_all("other edit");
    fx.git(&["switch", "-q", "main"]);
    fx.write("f.txt", "1\n2\n3\n4\nlocal\n");
    fx.write("s.txt", "staged\n");
    fx.git(&["add", "s.txt"]);
    fx.write("s.txt", "base\n");
    fx.write(".openidea/.gitignore", "# Local project ignores\n");

    let repo = fx.repo();
    let shelf_dir = fx.path(".openidea/shelf");
    repo.set_automatic_shelf(Some(shelf_dir.clone()), None);
    let opts = CheckoutOptions { mode: CheckoutMode::Smart, ..Default::default() };
    let checkout = || repo.checkout_with("other", false, &opts).unwrap();
    if let Some(batch) = batch {
        let scope = shelf::ShelfBatch::new(batch.to_owned(), fx.dir.clone());
        assert_eq!(scope.run(checkout), CheckoutOutcome::Done);
        assert_eq!(fx.git(&["branch", "--show-current"]), "other");
        assert_eq!(fx.read("f.txt"), "1\nother\n3\n4\n5\n");
        assert_eq!(fx.git(&["show", ":s.txt"]), "base");
        assert_eq!(shelf::list(&shelf_dir).unwrap().len(), 1);
        repo.finish_shelf_batch(batch).unwrap();
    } else {
        assert_eq!(checkout(), CheckoutOutcome::Done);
    }
    assert_eq!(fx.git(&["branch", "--show-current"]), "other");
    assert_eq!(fx.read("f.txt"), "1\nother\n3\n4\nlocal\n");
    assert_eq!(fx.read("s.txt"), "base\n");
    assert_eq!(fx.git(&["show", ":s.txt"]), "staged");
    assert_eq!(fx.read(".openidea/.gitignore"), "# Local project ignores\n");
    assert!(fx.git(&["ls-files", "--others", "--exclude-standard"]).is_empty());
    assert!(repo.stashes().unwrap().is_empty());
    assert!(shelf::list(&shelf_dir).unwrap().is_empty());
}

#[test]
fn smart_checkout_keeps_conflicting_saved_changes_on_the_shelf() {
    let fx = Fixture::new();
    fx.write("f.txt", "base\n");
    fx.write("clean.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["switch", "-qc", "other"]);
    fx.write("f.txt", "other\n");
    fx.commit_all("other edit");
    fx.git(&["switch", "-q", "main"]);
    fx.write("f.txt", "local\n");
    fx.write("clean.txt", "clean local\n");
    let mut lists = ChangelistState::initial();
    lists.lists.push(Changelist {
        id: "conflict".into(),
        name: "Conflict".into(),
        comment: String::new(),
        applied_commit: None,
    });
    lists.files.insert("f.txt".into(), "conflict".into());
    changelists::save(&fx.path(".openidea/changelists.json"), &lists).unwrap();

    let repo = fx.repo();
    let shelf_dir = fx.path(".openidea/shelf");
    repo.set_automatic_shelf(Some(shelf_dir.clone()), Some(fx.dir.clone()));
    let opts = CheckoutOptions { mode: CheckoutMode::Smart, ..Default::default() };
    assert_eq!(
        repo.checkout_with("other", false, &opts).unwrap(),
        CheckoutOutcome::Conflicts { files: vec!["f.txt".into()] }
    );
    assert_eq!(fx.git(&["show", ":2:f.txt"]), "other");
    assert_eq!(fx.git(&["show", ":3:f.txt"]), "local");
    let sides = repo.merge_sides().unwrap();
    assert_eq!(sides.operation.as_deref(), Some("unshelve"));
    assert!(sides.reversed);
    assert!(repo.stashes().unwrap().is_empty());
    let entries = shelf::list(&shelf_dir).unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].name.starts_with("[Conflict] "));
    assert!(shelf::patch_of(&shelf_dir, &entries[0].id).unwrap().contains("+local"));
    assert_eq!(fx.read("clean.txt"), "clean local\n");
}

#[test]
fn smart_checkout_puts_changes_back_if_it_cannot_create_the_shelf() {
    let fx = Fixture::new();
    fx.write("f.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["switch", "-qc", "other"]);
    fx.write("f.txt", "other\n");
    fx.commit_all("other edit");
    fx.git(&["switch", "-q", "main"]);
    fx.write("f.txt", "staged\n");
    fx.git(&["add", "f.txt"]);
    fx.write("f.txt", "local\n");
    fx.write(".openidea/shelf", "not a directory");

    let repo = fx.repo();
    repo.set_automatic_shelf(Some(fx.path(".openidea/shelf")), None);
    let opts = CheckoutOptions { mode: CheckoutMode::Smart, ..Default::default() };
    assert!(repo.checkout_with("other", false, &opts).is_err());
    assert_eq!(fx.git(&["branch", "--show-current"]), "main");
    assert_eq!(fx.git(&["show", ":f.txt"]), "staged");
    assert_eq!(fx.read("f.txt"), "local\n");
    assert!(repo.stashes().unwrap().is_empty());
    assert!(!fx.path(".git/openidea-saved-changes").exists());
}

#[test]
fn checkout_reports_untracked_files_it_would_overwrite() {
    let fx = Fixture::new();
    fx.write("f.txt", "f\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "other"]);
    fx.write("dir/new.txt", "theirs\n");
    fx.commit_all("add new");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("dir/new.txt", "mine\n");
    let repo = fx.repo();
    for mode in [CheckoutMode::Normal, CheckoutMode::Smart] {
        let opts = CheckoutOptions { mode, ..Default::default() };
        let outcome = repo.checkout_with("other", false, &opts).unwrap();
        assert_eq!(outcome, CheckoutOutcome::UntrackedFiles { files: vec!["dir/new.txt".into()], removed: false });
        assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));
        assert_eq!(fx.read("dir/new.txt"), "mine\n");
    }
}

/// Untracked on disk but tracked on the current branch and gone from the target
/// (as after `git rm --cached`): git refuses to *remove* the file, and the outcome
/// says so (#3980).
#[test]
fn checkout_reports_untracked_files_it_would_remove() {
    let fx = Fixture::new();
    fx.write("TEST.md", "hi\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "feature/x"]);
    fx.git(&["rm", "-q", "TEST.md"]);
    fx.commit_all("remove TEST.md on feature/x");
    fx.git(&["checkout", "-q", "main"]);
    fx.git(&["rm", "--cached", "TEST.md"]);
    fx.write("TEST.md", "local dirty version\n");
    let repo = fx.repo();
    for mode in [CheckoutMode::Normal, CheckoutMode::Smart] {
        // The refusal leaves the repository untouched, so both modes see the same state.
        let opts = CheckoutOptions { mode, ..Default::default() };
        let outcome = repo.checkout_with("feature/x", false, &opts).unwrap();
        assert_eq!(outcome, CheckoutOutcome::UntrackedFiles { files: vec!["TEST.md".into()], removed: true });
        assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));
        assert_eq!(fx.read("TEST.md"), "local dirty version\n");
    }
}

#[test]
fn reword_keeps_local_changes_and_can_be_undone() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    let first = fx.commit_all("first");
    fx.write("a.txt", "2\n");
    let second = fx.commit_all("second");
    fx.write("b.txt", "b\n");
    fx.commit_all("third");
    // Local changes, staged and not, must survive untouched.
    fx.write("a.txt", "local\n");
    fx.write("staged.txt", "s\n");
    fx.git(&["add", "staged.txt"]);
    let repo = fx.repo();

    let change = repo.reword(&second, "second, reworded\n\nwith a body").unwrap();
    assert_eq!(fx.git(&["log", "--format=%s", "-3"]), "third\nsecond, reworded\nfirst");
    assert_eq!(fx.git(&["log", "-1", "--format=%B", "HEAD~1"]), "second, reworded\n\nwith a body");
    assert_eq!(fx.git(&["rev-parse", "HEAD~2"]), first, "commits before it keep their ids");
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), change.after);
    assert_eq!(fx.git(&["symbolic-ref", "--short", "HEAD"]), "main", "the branch moved, not a detached HEAD");
    assert_eq!(fx.read("a.txt"), "local\n");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "staged.txt");
    assert_eq!(fx.git(&["diff", "--name-only"]), "a.txt");

    repo.restore_head(&change.before, &change.after).unwrap();
    assert_eq!(fx.git(&["log", "--format=%s", "-3"]), "third\nsecond\nfirst");
    assert_eq!(fx.read("a.txt"), "local\n");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "staged.txt");

    // Undo is refused once HEAD has moved.
    let change = repo.reword("HEAD", "third, reworded").unwrap();
    fx.git(&["commit", "-q", "--allow-empty", "-m", "later"]);
    assert!(repo.restore_head(&change.before, &change.after).is_err());
}

#[test]
fn amend_earlier_commit_replays_descendants_and_preserves_the_remaining_index() {
    let fx = Fixture::new();
    fx.write("target.txt", "original\n");
    fx.write("excluded.txt", "original\n");
    fx.git(&["add", "-A"]);
    let original_date = "2009-02-13T23:31:30+05:30";
    fx.git(&[
        "commit",
        "-m",
        "target",
        "--author=Original Author <original@example.com>",
        &format!("--date={original_date}"),
    ]);
    let target = fx.git(&["rev-parse", "HEAD"]);
    fx.write("descendant.txt", "later\n");
    let before = fx.commit_all("descendant");
    fx.write("target.txt", "included in the earlier commit\n");
    fx.write("excluded.txt", "still staged\n");
    fx.git(&["add", "-A"]);
    fx.write("target.txt", "local edit beyond the staged version\n");
    fx.write("untracked.txt", "untracked\n");
    fx.git(&["update-index", "--split-index"]);

    let options = CommitOptions {
        amend: true,
        amend_target: Some(AmendTarget {
            commit: target,
            head: HistoryTip { branch: Some("main".into()), commit: before.clone() },
            protected_branches: vec![],
        }),
        exclude: vec![fx.path("excluded.txt").into()],
        run_hooks: true,
        ..Default::default()
    };
    let head = fx.repo().commit_with("amended target\n\nmessage body", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_ne!(before, head);
    assert_eq!(fx.git(&["log", "--format=%s"]), "descendant\namended target");
    assert_eq!(fx.git(&["log", "-1", "--format=%B", "HEAD~1"]), "amended target\n\nmessage body");
    assert_eq!(fx.git(&["log", "-1", "--format=%an <%ae>", "HEAD~1"]), "Original Author <original@example.com>");
    assert_eq!(fx.git(&["log", "-1", "--format=%aI", "HEAD~1"]), original_date);
    assert_eq!(fx.git(&["show", "HEAD~1:target.txt"]), "included in the earlier commit");
    assert_eq!(fx.git(&["show", "HEAD:descendant.txt"]), "later");
    assert_eq!(fx.git(&["show", ":excluded.txt"]), "still staged");
    assert_eq!(fx.git(&["show", "HEAD:excluded.txt"]), "original");
    assert_eq!(fx.read("target.txt"), "local edit beyond the staged version\n");
    assert_eq!(fx.read("untracked.txt"), "untracked\n");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "excluded.txt");
}

#[test]
fn amend_earlier_commit_is_atomic_on_conflict_and_rejects_protected_history() {
    let fx = Fixture::new();
    fx.write("overlap.txt", "original\n");
    let target = fx.commit_all("target");
    fx.write("overlap.txt", "later\n");
    let before = fx.commit_all("descendant");
    fx.write("overlap.txt", "selected change\n");
    fx.git(&["add", "overlap.txt"]);
    fx.write("overlap.txt", "unstaged change\n");
    let index = fx.git(&["write-tree"]);

    let mut options = CommitOptions {
        amend: true,
        amend_target: Some(AmendTarget {
            commit: target.clone(),
            head: HistoryTip { branch: Some("main".into()), commit: before.clone() },
            protected_branches: vec!["origin/main".into()],
        }),
        ..Default::default()
    };
    fx.git(&["update-ref", "refs/remotes/origin/main", &target]);
    let repo = fx.repo();
    let attempt =
        |options: &CommitOptions| repo.commit_with("new message", options, &|_| Ok(encoding_rs::UTF_8)).unwrap_err();
    assert!(attempt(&options).message.contains("pushed to protected branch"));
    fx.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
    assert!(attempt(&options).message.contains("would cause a conflict"));
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), before);
    assert_eq!(fx.git(&["write-tree"]), index);
    assert_eq!(fx.read("overlap.txt"), "unstaged change\n");

    options.amend_target.as_mut().unwrap().head.commit = target;
    assert!(attempt(&options).message.contains("branch has changed"));
}

#[test]
fn amend_earlier_commit_can_change_only_the_message() {
    let fx = Fixture::new();
    fx.write("root.txt", "one\n");
    let target = fx.commit_all("target");
    fx.write("later.txt", "two\n");
    let head = fx.commit_all("descendant");
    let before = fx.git(&["rev-parse", "HEAD^{tree}"]);
    let options = CommitOptions {
        amend: true,
        amend_target: Some(AmendTarget {
            commit: target,
            head: HistoryTip { branch: Some("main".into()), commit: head },
            protected_branches: vec![],
        }),
        ..Default::default()
    };
    fx.repo().commit_with("updated", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_eq!(fx.git(&["log", "--format=%s"]), "descendant\nupdated");
    assert_eq!(fx.git(&["rev-parse", "HEAD^{tree}"]), before);
    assert_eq!(fx.git(&["status", "--porcelain"]), "");
}

#[test]
fn amend_earlier_commit_can_override_only_its_author_date() {
    let fx = Fixture::new();
    fx.write("root.txt", "one\n");
    fx.git(&["add", "root.txt"]);
    fx.git(&["commit", "-qm", "target", "--author=Original <original@example.com>"]);
    let target = fx.git(&["rev-parse", "HEAD"]);
    fx.write("later.txt", "later\n");
    let head = fx.commit_all("descendant");
    let descendant_date = fx.git(&["log", "-1", "--format=%aI", &head]);
    let date = "2012-03-05T12:34:56-04:00";
    let options = CommitOptions {
        amend: true,
        amend_target: Some(AmendTarget {
            commit: target,
            head: HistoryTip { branch: Some("main".into()), commit: head },
            protected_branches: vec![],
        }),
        author_date: Some(date.into()),
        ..Default::default()
    };
    fx.repo().commit_with("target", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_eq!(fx.git(&["log", "-1", "--format=%an <%ae>", "HEAD~1"]), "Original <original@example.com>");
    assert_eq!(fx.git(&["log", "-1", "--format=%aI", "HEAD~1"]), date);
    assert_eq!(fx.git(&["log", "-1", "--format=%aI"]), descendant_date);
}

#[test]
fn amend_earlier_commit_can_keep_the_prepared_conflict_without_overwriting_staged_edits() {
    let fx = Fixture::new();
    fx.write("overlap.txt", "original\n");
    fx.write("unrelated.txt", "original\n");
    let target = fx.commit_all("same subject");
    fx.write("overlap.txt", "later\n");
    let before = fx.commit_all("same subject");
    fx.write("overlap.txt", "selected change\n");
    fx.git(&["add", "overlap.txt"]);
    fx.write("overlap.txt", "unstaged change\n");
    fx.write("pending.txt", "prepared addition\n");
    fx.git(&["add", "-N", "pending.txt"]);
    let staged = fx.git(&["write-tree"]);
    let hook = fx.path(".git/hooks/pre-commit");
    fx.write(".git/hooks/pre-commit", "#!/bin/sh\nprintf x >> .git/hooks-ran\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(hook.is_file());
    let date = "2019-04-01T02:34:56+02:00";
    let options = CommitOptions {
        amend: true,
        amend_target: Some(AmendTarget {
            commit: target.clone(),
            head: HistoryTip { branch: Some("main".into()), commit: before.clone() },
            protected_branches: vec![],
        }),
        run_hooks: true,
        author: Some("Edited Author <edited@example.com>".into()),
        author_date: Some(date.into()),
        stage: vec![fx.path("pending.txt").into()],
        ..Default::default()
    };
    let repo = fx.repo();
    let error = repo.commit_with("new message\n\nnew body", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap_err();
    let Some(ErrorData::AmendConflict { commit }) = error.data else { panic!("{error}") };
    assert_eq!(fx.git(&["log", "-1", "--format=%aI", &commit]), date);
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), before);
    assert_eq!(fx.git(&["write-tree"]), staged);
    assert_eq!(fx.read("overlap.txt"), "unstaged change\n");

    fx.git(&["checkout", "-qb", "other"]);
    assert!(repo.keep_amend_commit(&commit).unwrap_err().message.contains("branch has changed"));
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), before);
    fx.git(&["checkout", "-q", "main"]);

    fx.write("pending.txt", "");
    fx.git(&["add", "pending.txt"]);
    assert!(repo.keep_amend_commit(&commit).unwrap_err().message.contains("Staged changes"));
    assert_eq!(fx.git(&["diff", "--cached", "--name-only", "--", "pending.txt"]), "pending.txt");
    fx.git(&["reset", "-q", "HEAD", "--", "pending.txt"]);
    fx.write("pending.txt", "prepared addition\n");
    fx.git(&["add", "-N", "pending.txt"]);

    fx.git(&["add", "overlap.txt"]);
    assert!(repo.keep_amend_commit(&commit).unwrap_err().message.contains("Staged changes"));
    assert_eq!(fx.git(&["show", ":overlap.txt"]), "unstaged change");
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), before);
    fx.write("overlap.txt", "selected change\n");
    fx.git(&["add", "overlap.txt"]);
    fx.write("overlap.txt", "latest local edit\n");
    fx.write("unrelated.txt", "new staging after the conflict\n");
    fx.git(&["add", "unrelated.txt"]);

    assert_eq!(repo.keep_amend_commit(&commit).unwrap(), commit);
    assert_eq!(fx.git(&["rev-parse", "HEAD^"]), before);
    assert_eq!(fx.git(&["log", "-1", "--format=%B"]), format!("amend! {target}\n\nnew message\n\nnew body"));
    assert_eq!(fx.git(&["log", "-1", "--format=%an <%ae>"]), "Edited Author <edited@example.com>");
    assert_eq!(fx.git(&["show", "HEAD:overlap.txt"]), "selected change");
    assert_eq!(fx.git(&["show", "HEAD:pending.txt"]), "prepared addition");
    assert_eq!(fx.read("overlap.txt"), "latest local edit\n");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "unrelated.txt");
    assert_eq!(fx.git(&["show", ":unrelated.txt"]), "new staging after the conflict");
    assert_eq!(fx.read(".git/hooks-ran"), "x");
    assert!(repo.keep_amend_commit(&commit).unwrap_err().message.contains("no longer available"));
}

#[test]
fn reword_refuses_commits_outside_the_current_branch() {
    let fx = Fixture::new();
    fx.write("a.txt", "1\n");
    fx.commit_all("first");
    fx.git(&["checkout", "-q", "-b", "side"]);
    fx.write("a.txt", "side\n");
    let side = fx.commit_all("side");
    fx.git(&["checkout", "-q", "main"]);
    assert!(fx.repo().reword(&side, "other").is_err());
}

#[test]
fn extract_renamed_and_deleted_files_from_an_older_commit() {
    let fx = Fixture::new();
    fx.write("old [1].txt", "renamed\n");
    fx.write("old 1.txt", "before\n");
    fx.write("removed.txt", "removed\n");
    let base = fx.commit_all("base");
    fx.git(&["mv", "old [1].txt", "new [1].txt"]);
    fx.git(&["rm", "removed.txt"]);
    fx.write("old 1.txt", "after\n");
    let target = fx.commit_all("original subject\n\noriginal body");
    fx.write("later.txt", "later\n");
    let head = fx.commit_all("later");
    fx.write("new [1].txt", "local work\n");
    fx.write("staged.txt", "staged\n");
    fx.git(&["add", "staged.txt"]);
    let status = fx.git(&["status", "--porcelain"]);
    let paths = ["old [1].txt", "new [1].txt", "removed.txt"].map(PathBuf::from);
    let repo = fx.repo();
    let expected = HistoryTip { commit: head.clone(), branch: Some("main".into()) };
    let result = repo.extract_commit_changes(&target, &expected, &paths, "extract rename and deletion").unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD~1"]), result.commit);
    assert_eq!(fx.git(&["rev-parse", "HEAD~3"]), base);
    assert_eq!(fx.git(&["log", "-1", "--format=%B", "HEAD~2"]), "original subject\n\noriginal body");
    assert_eq!(fx.git(&["show", "--format=", "--name-status", "HEAD~2"]), "M\told 1.txt");
    assert_eq!(
        fx.git(&["show", "--format=", "--name-status", "-M", "HEAD~1"]),
        "R100\told [1].txt\tnew [1].txt\nD\tremoved.txt"
    );
    assert_eq!(fx.git(&["rev-parse", "HEAD^{tree}"]), fx.git(&["rev-parse", &format!("{head}^{{tree}}")]));
    assert_eq!(fx.git(&["status", "--porcelain"]), status);
    assert_eq!(fx.read("new [1].txt"), "local work\n");
    repo.restore_head(&result.head.before, &result.head.after).unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(fx.git(&["status", "--porcelain"]), status);
}

#[test]
fn extract_from_root_rejects_all_changes_and_respects_detached_head() {
    let fx = Fixture::new();
    fx.write("one.txt", "one\n");
    fx.write("two.txt", "two\n");
    let root = fx.commit_all("root");
    let repo = fx.repo();
    let first = PathBuf::from("one.txt");
    let both = [first.clone(), PathBuf::from("two.txt")];
    let mut expected = HistoryTip { commit: root.clone(), branch: Some("main".into()) };
    assert!(repo.extract_commit_changes(&root, &expected, &both, "all").is_err());
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), root);
    fx.git(&["switch", "--detach", &root]);
    assert!(repo.extract_commit_changes(&root, &expected, std::slice::from_ref(&first), "stale").is_err());
    expected.branch = None;
    repo.extract_commit_changes(&root, &expected, &[first], "extract first").unwrap();
    assert_eq!(fx.git(&["ls-tree", "--name-only", "HEAD~1"]), "two.txt");
    assert_eq!(fx.git(&["rev-parse", "refs/heads/main"]), root);
    assert_eq!(fx.git(&["branch", "--show-current"]), "");
}

#[test]
fn drop_selected_changes_from_older_commit_and_undo_keeps_local_changes() {
    let fx = Fixture::new();
    fx.git(&["config", "rebase.autoSquash", "true"]);
    fx.write("old [1].txt", "renamed\n");
    fx.write("removed.txt", "removed\n");
    fx.write("local.txt", "original\n");
    let base = fx.commit_all("base");
    fx.git(&["mv", "old [1].txt", "new [1].txt"]);
    fx.git(&["rm", "removed.txt"]);
    fx.write("kept.txt", "kept\n");
    let target = fx.commit_all("original changes");
    fx.write("later.txt", "later\n");
    let head = fx.commit_all("fixup! original changes");
    fx.write("local.txt", "unstaged\n");
    fx.write("staged.txt", "staged\n");
    fx.git(&["add", "staged.txt"]);
    let status = fx.git(&["status", "--porcelain"]);

    let paths = ["old [1].txt", "new [1].txt", "removed.txt"].map(PathBuf::from);
    let expected = HistoryTip { commit: head.clone(), branch: Some("main".into()) };
    let repo = fx.repo();
    let result = repo.drop_commit_changes(&target, &expected, &paths, &CancellationToken::new(), &|_| {}).unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD~1"]), result.commit);
    assert_eq!(fx.git(&["rev-parse", "HEAD~2"]), base);
    assert_eq!(fx.git(&["log", "-2", "--format=%s"]), "fixup! original changes\noriginal changes");
    assert_eq!(fx.git(&["show", "--format=", "--name-status", "HEAD~1"]), "A\tkept.txt");
    assert_eq!(fx.read("old [1].txt"), "renamed\n");
    assert_eq!(fx.read("removed.txt"), "removed\n");
    assert!(!fx.path("new [1].txt").exists());
    assert_eq!(fx.read("later.txt"), "later\n");
    assert_eq!(fx.git(&["status", "--porcelain"]), status);

    repo.restore_head(&result.head.before, &result.head.after).unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(fx.read("new [1].txt"), "renamed\n");
    assert_eq!(fx.git(&["status", "--porcelain"]), status);
}

#[test]
fn drop_selected_changes_from_root_works_on_detached_head() {
    let fx = Fixture::new();
    fx.write("keep.txt", "kept\n");
    fx.write("drop.txt", "dropped\n");
    let root = fx.commit_all("root");
    fx.git(&["switch", "--detach", &root]);
    let expected = HistoryTip { commit: root.clone(), branch: None };
    let repo = fx.repo();
    let paths = [PathBuf::from("drop.txt")];
    let cancel = CancellationToken::new();
    let all = [PathBuf::from("drop.txt"), PathBuf::from("keep.txt")];
    assert!(repo.drop_commit_changes(&root, &expected, &all, &cancel, &|_| {}).is_err());
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), root);
    let result = repo.drop_commit_changes(&root, &expected, &paths, &cancel, &|_| {}).unwrap();
    assert_eq!(result.commit, result.head.after);
    assert_eq!(fx.git(&["rev-parse", "refs/heads/main"]), root);
    assert_eq!(fx.git(&["branch", "--show-current"]), "");
    assert_eq!(fx.git(&["ls-tree", "--name-only", "HEAD"]), "keep.txt");
    assert!(!fx.path("drop.txt").exists());
}

#[test]
fn drop_selected_changes_leaves_replay_conflicts_resolvable_or_abortable() {
    let fx = Fixture::new();
    fx.write("conflict.txt", "base\n");
    fx.commit_all("base");
    fx.write("conflict.txt", "target\n");
    fx.write("kept.txt", "kept\n");
    let target = fx.commit_all("target");
    fx.write("conflict.txt", "descendant\n");
    let head = fx.commit_all("descendant");
    fx.write("staged.txt", "staged\n");
    fx.git(&["add", "staged.txt"]);
    let expected = HistoryTip { commit: head.clone(), branch: Some("main".into()) };
    let repo = fx.repo();
    let paths = [PathBuf::from("conflict.txt")];
    let cancel = CancellationToken::new();
    let run = || repo.drop_commit_changes(&target, &expected, &paths, &cancel, &|_| {});

    assert!(run().is_err());
    assert_eq!(repo.branch_info().unwrap().operation.as_deref(), Some("rebase"));
    assert_eq!(fx.git(&["diff", "--name-only", "--diff-filter=U"]), "conflict.txt");
    repo.abort_operation(&cancel, &|_| {}).unwrap();
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "staged.txt");

    assert!(run().is_err());
    fx.write("conflict.txt", "resolved\n");
    repo.stage(&[fx.path("conflict.txt")]).unwrap();
    repo.continue_operation(&cancel, &|_| {}).unwrap();
    assert_eq!(repo.branch_info().unwrap().operation, None);
    assert_eq!(fx.git(&["show", "HEAD~1:conflict.txt"]), "base");
    assert_eq!(fx.read("conflict.txt"), "resolved\n");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "staged.txt");
}

#[cfg(unix)]
#[test]
fn status_skips_a_directory_it_cannot_read() {
    // `git status` warns "could not open directory: Permission denied" and lists the rest.
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.commit_all("init");
    fx.write("a.txt", "b\n");
    fx.write("new.txt", "n\n");
    let locked = fx.path("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("inside.txt"), "x").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let st = fx.repo().status();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    let st = st.unwrap();
    assert_eq!(status_of(&st, "a.txt").unstaged, Some(ChangeKind::Modified));
    assert_eq!(status_of(&st, "new.txt").unstaged, Some(ChangeKind::Untracked));
}

#[test]
fn a_case_only_directory_rename_keeps_status_and_head_content() {
    let fx = Fixture::new();
    fx.write("src/financial/table/index.vue", "<template/>\n");
    fx.commit_all("initial");
    std::fs::rename(fx.path("src/financial"), fx.path("src/tmp")).unwrap();
    std::fs::rename(fx.path("src/tmp"), fx.path("src/Financial")).unwrap();
    if !fx.path("src/financial/table/index.vue").exists() {
        return; // A case-sensitive file system: these are different directories.
    }
    fx.git(&["config", "core.ignorecase", "true"]);
    fx.write("src/Financial/table/index.vue", "<template>x</template>\n");
    fx.write("src/Financial/added/index.vue", "new\n");
    let repo = fx.repo();
    let st = repo.status().unwrap();
    let modified = status_of(&st, "src/financial/table/index.vue");
    assert_eq!(modified.unstaged, Some(ChangeKind::Modified));
    // Tabs and the project tree name the file as the disk does.
    assert_eq!(modified.path.0, fx.path("src/Financial/table/index.vue"));
    assert_eq!(status_of(&st, "src/Financial/added/index.vue").path.0, fx.path("src/Financial/added/index.vue"));

    let on_disk = fx.path("src/Financial/table/index.vue");
    assert_eq!(repo.file_at(&on_disk, None, encoding_rs::UTF_8).unwrap().as_deref(), Some("<template/>\n"));
    repo.stage(&[on_disk]).unwrap();
    let st = repo.status().unwrap();
    assert_eq!(status_of(&st, "src/financial/table/index.vue").staged, Some(ChangeKind::Modified));
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "src/financial/table/index.vue");
}

#[test]
fn status_paths_reads_only_the_named_paths() {
    // The dirty-scope refresh: a watcher batch names a few paths, and git's pathspec
    // filtering keeps the answer proportional to the batch instead of the whole tree.
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.write("b.txt", "a\n");
    fx.write("dir/c.txt", "a\n");
    fx.commit_all("base");
    fx.write("a.txt", "b\n");
    fx.write("b.txt", "b\n");
    fx.write("dir/c.txt", "b\n");
    fx.write("new.txt", "n\n");
    let repo = fx.repo();
    repo.set_ignored_names(ide_core::settings::Settings::default().ignored_names());

    let one = repo.status_paths(&[fx.path("a.txt")]).unwrap();
    assert_eq!(one.len(), 1, "{one:#?}");
    assert_eq!(one[0].rel_path, "a.txt");
    assert_eq!(one[0].unstaged, Some(ChangeKind::Modified));

    // A directory stands for everything below it, as the watcher reports a removed one.
    let dir = repo.status_paths(&[fx.path("dir")]).unwrap();
    assert_eq!(dir.iter().map(|s| s.rel_path.as_str()).collect::<Vec<_>>(), ["dir/c.txt"]);

    // A nested file: the path a watcher hands over is spelled by the platform, and the pathspec
    // needs `/` whatever the platform's separator is.
    let nested = repo.status_paths(&[fx.path("dir").join("c.txt")]).unwrap();
    assert_eq!(nested.iter().map(|s| s.rel_path.as_str()).collect::<Vec<_>>(), ["dir/c.txt"]);

    // The repository root itself names everything, not a path called "".
    assert_eq!(repo.status_paths(&[fx.path("")]).unwrap().len(), 4);

    // A new file the batch names is reported as untracked, not as a directory entry.
    let new = repo.status_paths(&[fx.path("new.txt")]).unwrap();
    assert_eq!((new[0].rel_path.as_str(), new[0].unstaged), ("new.txt", Some(ChangeKind::Untracked)));

    // Paths outside the repository are ignored rather than an error; nothing named is nothing read.
    let outside = if cfg!(windows) { PathBuf::from("C:/elsewhere/x.txt") } else { PathBuf::from("/elsewhere/x.txt") };
    assert!(repo.status_paths(&[outside]).unwrap().is_empty());

    // An empty list is the full status, so a caller that lost the paths stays correct.
    assert_eq!(repo.status_paths(&[]).unwrap().len(), 4);
}

#[test]
fn sets_the_commit_identity_in_the_repository() {
    let fx = Fixture::new();
    fx.git(&["config", "--unset", "user.name"]);
    fx.git(&["config", "--unset", "user.email"]);
    let repo = fx.repo();
    repo.set_user_identity(" Ada Lovelace ", "ada@example.com", false).unwrap();
    assert_eq!(fx.git(&["config", "--local", "user.name"]), "Ada Lovelace");
    assert_eq!(fx.git(&["config", "--local", "user.email"]), "ada@example.com");
    assert_eq!(repo.config_get("user.email").unwrap().as_deref(), Some("ada@example.com"));
    let blank = repo.set_user_identity("Ada", "  ", false).unwrap_err();
    assert_eq!(blank.kind, ErrorKind::InvalidInput);
}

#[test]
fn reads_boolean_config_using_gits_syntax() {
    let fx = Fixture::new();
    let repo = fx.repo();
    let key = "openidea.booleanFixture";
    assert_eq!(repo.config_get_bool(key).unwrap(), None);
    let config = fx.path(".git/config");
    let existing = std::fs::read_to_string(&config).unwrap();
    std::fs::write(&config, format!("{existing}\n[openidea]\n\tbooleanFixture\n")).unwrap();
    assert_eq!(repo.config_get_bool(key).unwrap(), Some(true));
    for value in ["", "OFF"] {
        fx.git(&["config", "--local", key, value]);
        assert_eq!(repo.config_get_bool(key).unwrap(), Some(false));
    }
    fx.git(&["config", "--local", key, "not-a-boolean"]);
    assert!(repo.config_get_bool(key).is_err());
}

#[test]
fn status_from_the_git_command_line_matches_the_in_process_one() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.write("staged.txt", "a\n");
    fx.write("gone.txt", "a\n");
    fx.commit_all("base");
    fx.write("a.txt", "b\n");
    fx.write("staged.txt", "b\n");
    fx.git(&["add", "staged.txt"]);
    std::fs::remove_file(fx.path("gone.txt")).unwrap();
    fx.write("dir/new.txt", "n\n");
    let repo = fx.repo();
    repo.set_ignored_names(ide_core::settings::Settings::default().ignored_names());
    let show = |s: Vec<FileStatus>| s.into_iter().map(|f| (f.rel_path, f.staged, f.unstaged)).collect::<Vec<_>>();
    let in_process = show(repo.status().unwrap());
    repo.set_cli_status(true);
    let from_git = show(repo.status().unwrap());
    assert_eq!(from_git, in_process);
    assert_eq!(from_git.len(), 4, "{from_git:#?}");
}

#[test]
fn a_worktree_diff_refreshing_the_index_is_not_reported_as_a_repository_change() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\n");
    fx.write("b.txt", "b\n");
    fx.git(&["add", "."]);
    fx.git(&["commit", "-qm", "init"]);
    let base = fx.git(&["rev-parse", "HEAD"]);
    let index = fx.dir.join(".git/index");
    let backdate = |rel: &str| {
        let file = std::fs::File::options().write(true).open(fx.dir.join(rel)).unwrap();
        file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(100)).unwrap();
    };
    // Same content, stale stat data: `git diff` refreshes and rewrites the index while reading.
    backdate("a.txt");
    let before = std::fs::read(&index).unwrap();
    let repo = fx.repo();
    assert!(repo.numstat_with_worktree(&base).unwrap().is_empty());
    assert_ne!(std::fs::read(&index).unwrap(), before, "git rewrote the index");
    assert!(is_own_index_write(&index));

    // A write by someone else is still a change.
    fx.write("b.txt", "changed\n");
    fx.git(&["add", "b.txt"]);
    assert!(!is_own_index_write(&index));
}
