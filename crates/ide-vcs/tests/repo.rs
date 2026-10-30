//! End-to-end tests against throwaway repositories created with the git CLI.

use ide_core::CancellationToken;
use ide_core::error::ErrorKind;
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
    fn repo(&self) -> Repo {
        Repo::discover(&self.dir).unwrap().expect("repository found")
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
    git_in(fx._tmp.path(), &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
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
    let clone = fx.dir.parent().unwrap().join("clone");
    let url = format!("file://{}", fx.dir.display());
    git_in(fx.dir.parent().unwrap(), &["clone", "-q", "--filter=blob:none", &url, "clone"]);
    let repo = Repo::discover(&clone).unwrap().unwrap();
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
    repo.stash_push(Some("first stash"), false, false).unwrap();
    assert_eq!(fx.read("s.txt"), "base\n");
    fx.write("s.txt", "change 2\n");
    fx.write("u.txt", "untracked\n");
    repo.stash_push(None, true, false).unwrap();
    assert!(!fx.path("u.txt").exists());

    let stashes = repo.stashes().unwrap();
    assert_eq!(stashes.len(), 2);
    assert_eq!(stashes[0].index, 0);
    assert!(stashes[0].message.contains("WIP on main"), "{stashes:?}");
    assert!(stashes[1].message.contains("first stash"), "{stashes:?}");
    assert!(stashes[0].time_ms > 0.0);

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
    repo.stash_push(Some("keep"), false, true).unwrap();
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
    let options = CommitOptions { author: Some(" Other <other@example.com> ".into()), ..Default::default() };
    repo.commit_with("by other", &options, &|_| Ok(encoding_rs::UTF_8)).unwrap();
    assert_eq!(fx.git(&["log", "-1", "--format=%an <%ae>"]), "Other <other@example.com>");
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
    repo.rename_branch("topic", "topic2").unwrap();
    assert!(repo.branches().unwrap().iter().any(|b| b.name == "topic2"));
    assert!(repo.rename_branch("topic2", "main").is_err(), "existing name must be refused");
    assert!(repo.rename_branch("topic2", " ").is_err());
    repo.rename_branch("topic2", "topic").unwrap();
    assert!(repo.delete_branch("topic", false).is_err(), "unmerged branch must need force");
    repo.delete_branch("topic", true).unwrap();
    assert!(!repo.branches().unwrap().iter().any(|b| b.name == "topic"));
    assert!(repo.checkout("does-not-exist", false).is_err());
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
    let opts = |mode| CheckoutOptions { mode, diverged: None };

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

    let work = repo.delete_branch_restorable("work").unwrap();
    assert!(work.unmerged, "not fully merged branches are force-deleted and reported");
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

fn range(h: &LineHunk) -> HunkRange {
    HunkRange { start: h.start, lines: h.lines, old_start: h.old_start, old_lines: h.old_lines }
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
        partial: vec![PartialCommitFile { path: fx.path("f.txt").into(), hunks: vec![range(&hunks[0])] }],
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
        partial: vec![PartialCommitFile { path: fx.path("f.txt").into(), hunks: vec![range(&hunks[0])] }],
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
        partial: vec![PartialCommitFile { path: fx.path("f.txt").into(), hunks: vec![range(&rest[0])] }],
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
        partial: vec![PartialCommitFile { path: fx.path("f.txt").into(), hunks: vec![range(&hunks[0])] }],
        ..Default::default()
    };
    assert!(repo.commit_with("hooked", &options, &|_| Ok(encoding_rs::UTF_8)).is_err());
    assert_eq!(fx.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "");
    assert_eq!(fx.read("f.txt"), "Z\nb\nc\nd\ne\nf\ng\nh\ni\nJ\nk\nl\n");
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
                    path: path.clone().into(),
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
