//! End-to-end checks against a throwaway Perforce server: `p4d` run per
//! command through `rsh:`, so no port or daemon is involved. Skipped when
//! `p4` or `p4d` (`$P4D`, else on `PATH`) is not installed.

use ide_core::CancellationToken;
use ide_p4::{IntegrateKind, ResolveMode, Workspace};
use ide_vcs::{Backend, ChangeKind, CommitOptions, LogQuery, TextEncoding};
use std::path::{Path, PathBuf};
use std::process::Command;

struct Server {
    _dir: tempfile::TempDir,
    base: PathBuf,
    port: String,
}

fn p4d() -> Option<PathBuf> {
    std::env::var_os("P4D").map(PathBuf::from).filter(|p| p.is_file()).or_else(|| which("p4d"))
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|p| p.is_file())
}

fn server() -> Option<Server> {
    let (p4d, _p4) = (p4d()?, which("p4")?);
    static ENV: std::sync::Once = std::sync::Once::new();
    // SAFETY: set once, to the same value, before any test of this binary runs `p4`.
    ENV.call_once(|| unsafe { std::env::set_var("P4CONFIG", ".p4config") });
    let dir = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(dir.path()).unwrap();
    std::fs::create_dir_all(base.join("root")).unwrap();
    let port = format!("rsh:{} -r {} -L {} -i", p4d.display(), base.join("root").display(), base.join("log").display());
    Some(Server { _dir: dir, base, port })
}

impl Server {
    /// A client workspace `name` of user `user`, rooted in its own folder.
    fn client(&self, name: &str, user: &str) -> Workspace {
        let root = self.base.join(name);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".p4config"),
            format!("P4PORT={}\nP4USER={user}\nP4CLIENT={name}\nP4CHARSET=none\n", self.port),
        )
        .unwrap();
        // Every setup command names the throwaway server itself: nothing here may
        // fall back to the connection `p4 set` or the environment configure.
        let p4 = |args: &[&str]| {
            let mut cmd = Command::new("p4");
            cmd.args(["-p", &self.port, "-u", user, "-c", name, "-C", "none"]).args(args);
            cmd.current_dir(&root).env("PWD", &root).env("P4CONFIG", ".p4config");
            cmd
        };
        let spec = p4(&["client", "-o"]).output().unwrap();
        assert!(spec.status.success() && !spec.stdout.is_empty(), "{}", String::from_utf8_lossy(&spec.stderr));
        let mut save = p4(&["client", "-i"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::io::Write::write_all(save.stdin.as_mut().unwrap(), &spec.stdout).unwrap();
        assert!(save.wait().unwrap().success());
        let ws = Workspace::discover(&root).unwrap().expect("a workspace");
        assert!(ws.root().starts_with(&self.base), "the workspace of the throwaway server");
        ws
    }
}

fn utf8() -> TextEncoding {
    TextEncoding::from(encoding_rs::UTF_8)
}

fn write(ws: &Workspace, rel: &str, text: &str) -> PathBuf {
    let path = ws.root().join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, text).unwrap();
    path
}

fn submit(ws: &Workspace, paths: &[PathBuf], message: &str) -> String {
    let options = CommitOptions { stage: paths.iter().cloned().map(Into::into).collect(), ..Default::default() };
    ws.commit(message, &options, &|_: &Path| Ok(utf8())).unwrap()
}

fn kinds(ws: &Workspace) -> Vec<(String, ChangeKind)> {
    ws.status().unwrap().into_iter().map(|f| (f.rel_path, f.unstaged.unwrap())).collect()
}

#[test]
fn changes_view_diff_annotate_and_log() {
    let Some(server) = server() else { return };
    let ws = server.client("ws", "ann");
    assert_eq!(ws.connection().client, "ws");
    assert!(Workspace::discover(&server.base).unwrap().is_none(), "above the client root is no workspace");
    assert!(ws.status().unwrap().is_empty());

    let a = write(&ws, "src/a.txt", "one\ntwo\nthree\n");
    let odd = write(&ws, "src/we@ird#1.txt", "x\n");
    ws.files_added(&[ws.root().join("src")]).unwrap();
    assert_eq!(
        kinds(&ws),
        [("src/a.txt".to_owned(), ChangeKind::Added), ("src/we@ird#1.txt".to_owned(), ChangeKind::Added)]
    );
    assert!(ws.line_hunks(&a, "one\n", false, utf8()).unwrap().is_empty(), "a new file has no base");
    let first = submit(&ws, &[a.clone(), odd.clone()], "add files\n\nwith a body");
    assert!(ws.status().unwrap().is_empty());

    // Synced files are read-only until opened.
    assert!(std::fs::metadata(&a).unwrap().permissions().readonly());
    ws.stage(std::slice::from_ref(&a)).unwrap();
    assert!(!std::fs::metadata(&a).unwrap().permissions().readonly());
    std::fs::write(&a, "one\nTWO\nthree\nfour\n").unwrap();
    assert_eq!(kinds(&ws), [("src/a.txt".to_owned(), ChangeKind::Modified)]);
    assert_eq!(ws.status_paths(std::slice::from_ref(&odd)).unwrap().len(), 0);
    assert_eq!(ws.file_at(&a, None, utf8()).unwrap().as_deref(), Some("one\ntwo\nthree\n"));
    assert_eq!(ws.file_at(&odd, Some(&first), utf8()).unwrap().as_deref(), Some("x\n"));
    assert_eq!(ws.file_at(&a, Some(&format!("{first}^")), utf8()).unwrap(), None);
    assert_eq!(ws.file_mode_at(&a, None).unwrap().as_deref(), Some("text"));

    let hunks = ws.line_hunks(&a, "one\nTWO\nthree\nfour\n", false, utf8()).unwrap();
    assert_eq!(hunks.len(), 2);
    let diff = ws.diff_text(&a, false, utf8()).unwrap();
    assert!(diff.starts_with("diff --git a/src/a.txt b/src/a.txt\n"), "{diff}");
    assert!(diff.contains("-two\n+TWO\n") && diff.contains("+four\n"), "{diff}");
    let options = CommitOptions::default();
    let pending = ws.pending_changes(&options, 1 << 20, &|_: &Path| Ok(utf8())).unwrap();
    assert_eq!((pending.len(), pending[0].status), (1, "modified"));
    assert_eq!(pending[0].diff.as_deref(), Some(diff.as_str()));

    let second = submit(&ws, std::slice::from_ref(&a), "edit a");
    let blame = ws.blame(&a, None, None, utf8()).unwrap();
    let who: Vec<(&str, &str)> = blame.iter().map(|l| (l.commit.as_str(), l.summary.as_str())).collect();
    assert_eq!(
        who,
        [
            (first.as_str(), "add files"),
            (second.as_str(), "edit a"),
            (first.as_str(), "add files"),
            (second.as_str(), "edit a")
        ]
    );
    assert_eq!(blame[0].author, "ann");
    let buffer = ws.blame(&a, Some("zero\none\nTWO\nthree\nfour\n"), None, utf8()).unwrap();
    assert_eq!(buffer.len(), 5);
    assert_eq!(buffer[0].author, "Not Committed Yet");
    assert_eq!(buffer[1].commit, first);

    let cancel = CancellationToken::new();
    let log = ws.log(&LogQuery { limit: 10, ..Default::default() }, &cancel).unwrap();
    let ids: Vec<&str> = log.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, [second.as_str(), first.as_str()]);
    assert_eq!((log[1].summary.as_str(), log[1].message.as_str()), ("add files", "add files\n\nwith a body"));
    assert_eq!(log[0].graph_parents.as_deref(), Some(&[first.clone()][..]));
    let of_odd =
        ws.log(&LogQuery { limit: 10, path: Some(odd.clone().into()), ..Default::default() }, &cancel).unwrap();
    assert_eq!(of_odd.len(), 1);
    let found = ws.log(&LogQuery { limit: 10, text: Some("EDIT".into()), ..Default::default() }, &cancel).unwrap();
    assert_eq!(found.len(), 1);

    let files = ws.commit_files(&first).unwrap();
    assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["src/a.txt", "src/we@ird#1.txt"]);
    assert!(files.iter().all(|f| f.kind == ChangeKind::Added));
    let span = ws.commits_changes(&[first.clone(), second.clone()]).unwrap();
    let a_span = span.iter().find(|c| c.path == "src/a.txt").unwrap();
    assert_eq!(
        (a_span.kind, a_span.before.clone(), a_span.after.clone()),
        (ChangeKind::Added, None, Some(second.clone()))
    );
    let between = ws.diff_revisions(&first, &second).unwrap();
    assert_eq!(
        between.iter().map(|f| (f.path.as_str(), f.kind)).collect::<Vec<_>>(),
        [("src/a.txt", ChangeKind::Modified)]
    );
}

#[test]
fn renames_deletes_reverts_and_offline_work() {
    let Some(server) = server() else { return };
    let ws = server.client("ws", "ann");
    let a = write(&ws, "a.txt", "a\n");
    let b = write(&ws, "dir/b.txt", "b\n");
    let c = write(&ws, "c.txt", "c\n");
    ws.files_added(&[a.clone(), b.clone(), c.clone()]).unwrap();
    submit(&ws, &[a.clone(), b.clone(), c.clone()], "base");

    let renamed = ws.root().join("renamed.txt");
    std::fs::rename(&a, &renamed).unwrap();
    ws.file_moved(&a, &renamed).unwrap();
    let status = ws.status().unwrap();
    assert_eq!(status.len(), 1, "{status:?}");
    assert_eq!((status[0].rel_path.as_str(), status[0].unstaged), ("renamed.txt", Some(ChangeKind::Renamed)));
    assert_eq!(status[0].renamed_from.as_deref(), Some("a.txt"));

    std::fs::rename(ws.root().join("dir"), ws.root().join("moved")).unwrap();
    ws.file_moved(&ws.root().join("dir"), &ws.root().join("moved")).unwrap();
    std::fs::remove_file(&c).unwrap();
    ws.files_deleted(std::slice::from_ref(&c)).unwrap();
    assert_eq!(
        kinds(&ws),
        [
            ("c.txt".to_owned(), ChangeKind::Deleted),
            ("moved/b.txt".to_owned(), ChangeKind::Renamed),
            ("renamed.txt".to_owned(), ChangeKind::Renamed)
        ]
    );

    // Submitting the new name takes the old one along.
    submit(&ws, std::slice::from_ref(&renamed), "rename a");
    assert_eq!(kinds(&ws).len(), 2);
    assert_eq!(ws.file_at(&renamed, None, utf8()).unwrap().as_deref(), Some("a\n"));

    ws.discard(&[c.clone(), ws.root().join("moved")]).unwrap();
    assert!(ws.status().unwrap().is_empty());
    assert!(c.is_file() && b.is_file(), "revert restores the files");

    // Work done behind Perforce's back.
    let mut perms = std::fs::metadata(&b).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    std::fs::set_permissions(&b, perms).unwrap();
    std::fs::write(&b, "b changed\n").unwrap();
    write(&ws, "new.txt", "n\n");
    std::fs::remove_file(&c).unwrap();
    let preview = ws.reconcile(&[], None, true).unwrap();
    let mut found: Vec<(String, String)> =
        preview.files.iter().map(|f| (ws.rel(&f.path.clone().unwrap().0), f.action.clone())).collect();
    found.sort();
    assert_eq!(
        found,
        [
            ("c.txt".to_owned(), "delete".to_owned()),
            ("dir/b.txt".to_owned(), "edit".to_owned()),
            ("new.txt".to_owned(), "add".to_owned())
        ]
    );
    assert!(ws.status().unwrap().is_empty(), "a preview opens nothing");
    ws.reconcile(&[], None, false).unwrap();
    assert_eq!(kinds(&ws).len(), 3);
    assert_eq!(ws.revert_unchanged(None).unwrap().files.len(), 0);
}

#[test]
fn changelists_shelves_and_partial_submit() {
    let Some(server) = server() else { return };
    let ws = server.client("ws", "ann");
    let a = write(&ws, "a.txt", "a\n");
    let b = write(&ws, "b.txt", "b\n");
    ws.files_added(&[a.clone(), b.clone()]).unwrap();
    submit(&ws, &[a.clone(), b.clone()], "base");

    ws.open_for_edit(&[a.clone(), b.clone()], None).unwrap();
    std::fs::write(&a, "a2\n").unwrap();
    std::fs::write(&b, "b2\n").unwrap();
    let feature = ws.create_changelist("feature work\nsecond line", std::slice::from_ref(&a)).unwrap();
    let lists = ws.changelists().unwrap();
    assert_eq!(lists.iter().map(|l| (l.number, l.files.len())).collect::<Vec<_>>(), [(0, 1), (feature, 1)]);
    assert_eq!(lists[1].description, "feature work\nsecond line");
    ws.update_changelist(feature, "renamed work").unwrap();
    ws.reopen(std::slice::from_ref(&b), feature).unwrap();
    let lists = ws.changelists().unwrap();
    assert_eq!((lists[1].description.as_str(), lists[1].files.len(), lists[1].shelved), ("renamed work", 2, false));

    ws.shelve(feature, &[]).unwrap();
    assert!(ws.changelists().unwrap()[1].shelved);
    let shelved = ws.shelved_files(feature).unwrap();
    assert_eq!(shelved.iter().map(|f| f.rel_path.as_deref()).collect::<Vec<_>>(), [Some("a.txt"), Some("b.txt")]);
    assert_eq!(ws.file_at(&a, Some(&format!("shelved:{feature}")), utf8()).unwrap().as_deref(), Some("a2\n"));
    ws.discard(&[a.clone(), b.clone()]).unwrap();
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "a\n");
    ws.unshelve(feature, None, &[], false).unwrap();
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "a2\n");
    assert!(ws.delete_changelist(feature).is_err(), "a changelist with files stays");
    ws.delete_shelf(feature, &[]).unwrap();

    // One file of two: it leaves in a changelist of its own, the other stays where it was.
    let submitted = submit(&ws, std::slice::from_ref(&a), "only a");
    let lists = ws.changelists().unwrap();
    assert_eq!(lists.iter().map(|l| (l.number, l.files.len())).collect::<Vec<_>>(), [(0, 0), (feature, 1)]);
    assert_eq!(ws.commit_files(&submitted).unwrap().len(), 1);
    // The rest is the whole changelist, so that one is submitted under the new description.
    let rest = submit(&ws, std::slice::from_ref(&b), "then b");
    assert_eq!(ws.changelists().unwrap().len(), 1);
    let log = ws.log(&LogQuery { limit: 1, ..Default::default() }, &CancellationToken::new()).unwrap();
    assert_eq!((log[0].id.as_str(), log[0].summary.as_str()), (rest.as_str(), "then b"));
}

#[test]
fn sync_conflicts_and_resolve() {
    let Some(server) = server() else { return };
    let ann = server.client("ann-ws", "ann");
    let bob = server.client("bob-ws", "bob");
    let a = write(&ann, "a.txt", "one\ntwo\nthree\n");
    let other = write(&ann, "other.txt", "o\n");
    ann.files_added(&[a.clone(), other.clone()]).unwrap();
    let base = submit(&ann, &[a.clone(), other.clone()], "base");

    let synced = bob.sync(&[], None, false, false).unwrap();
    assert_eq!(synced.files.len(), 2);
    let bob_a = bob.root().join("a.txt");
    bob.open_for_edit(std::slice::from_ref(&bob_a), None).unwrap();
    std::fs::write(&bob_a, "one\nBOB\nthree\n").unwrap();
    submit(&bob, std::slice::from_ref(&bob_a), "bob edits");

    ann.open_for_edit(&[a.clone(), other.clone()], None).unwrap();
    std::fs::write(&a, "one\nANN\nthree\n").unwrap();
    std::fs::write(&other, "o2\n").unwrap();
    // An out-of-date file fails the submit; the files go back to the default changelist.
    let options = CommitOptions { stage: vec![a.clone().into(), other.clone().into()], ..Default::default() };
    assert!(ann.commit("too early", &options, &|_: &Path| Ok(utf8())).is_err());
    let lists = ann.changelists().unwrap();
    assert_eq!(lists.iter().map(|l| (l.number, l.files.len())).collect::<Vec<_>>(), [(0, 2)]);

    let preview = ann.sync(&[], None, false, true).unwrap();
    assert!(preview.messages.iter().any(|m| m.contains("//depot/a.txt#2")), "{preview:?}");
    ann.sync(&[], None, false, false).unwrap();
    assert_eq!(kinds(&ann)[0], ("a.txt".to_owned(), ChangeKind::Conflicted));
    let unresolved = ann.unresolved(&[]).unwrap();
    assert_eq!(unresolved.len(), 1);
    assert_eq!((unresolved[0].rel_path.as_str(), unresolved[0].from_rev), ("a.txt", Some(2)));
    let sides = ann.resolve_sides(&a, utf8()).unwrap();
    assert_eq!(
        (sides.base.as_str(), sides.theirs.as_str(), sides.yours.as_str()),
        ("one\ntwo\nthree\n", "one\nBOB\nthree\n", "one\nANN\nthree\n")
    );
    ann.resolve(&[], ResolveMode::Merge).unwrap();
    assert_eq!(ann.unresolved(&[]).unwrap().len(), 1, "both sides changed the line: not merged automatically");
    ann.resolve_with(&a, b"one\nANN+BOB\nthree\n").unwrap();
    assert!(ann.unresolved(&[]).unwrap().is_empty());
    assert_eq!(kinds(&ann)[0].1, ChangeKind::Modified);
    let merged = submit(&ann, &[a.clone(), other.clone()], "merged");
    assert_eq!(ann.file_at(&a, Some(&merged), utf8()).unwrap().as_deref(), Some("one\nANN+BOB\nthree\n"));

    // Back to the first change, then forward again.
    ann.sync(std::slice::from_ref(&a), Some(&base), false, false).unwrap();
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "one\ntwo\nthree\n");
    ann.sync(&[], None, false, false).unwrap();
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "one\nANN+BOB\nthree\n");

    let branched =
        ann.integrate(IntegrateKind::Integrate, "//depot/a.txt", "//depot/branch/a.txt", None, false).unwrap();
    assert_eq!(branched.files.len(), 1);
    assert_eq!(kinds(&ann), [("branch/a.txt".to_owned(), ChangeKind::Added)]);
    assert!(ann.login_status().unwrap().logged_in);
}

#[test]
fn annotate_names_who_wrote_a_line_of_a_branched_file() {
    let Some(server) = server() else { return };
    let ann = server.client("ann-ws", "ann");
    let bob = server.client("bob-ws", "bob");
    let admin = server.client("admin-ws", "admin");
    let a = write(&ann, "main/a.txt", "one\ntwo\n");
    ann.files_added(std::slice::from_ref(&a)).unwrap();
    let first = submit(&ann, std::slice::from_ref(&a), "add a");
    bob.sync(&[], None, false, false).unwrap();
    let bob_a = bob.root().join("main/a.txt");
    bob.open_for_edit(std::slice::from_ref(&bob_a), None).unwrap();
    std::fs::write(&bob_a, "one\nTWO\n").unwrap();
    let second = submit(&bob, std::slice::from_ref(&bob_a), "bob edits");

    admin.integrate(IntegrateKind::Integrate, "//depot/main/...", "//depot/rel/...", None, false).unwrap();
    let branched = admin.root().join("rel/a.txt");
    submit(&admin, std::slice::from_ref(&branched), "branch rel");

    let blame = admin.blame(&branched, None, None, utf8()).unwrap();
    let who: Vec<(&str, &str, &str)> =
        blame.iter().map(|l| (l.author.as_str(), l.commit.as_str(), l.summary.as_str())).collect();
    assert_eq!(who, [("ann", first.as_str(), "add a"), ("bob", second.as_str(), "bob edits")]);
}
