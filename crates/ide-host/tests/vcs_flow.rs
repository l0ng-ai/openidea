//! A day with Git on a `fixtures/` project, through the `ops` the app's commands call: an edit
//! marked in the gutter, Local Changes and its diff, a commit in the log, a branch, a stash, and
//! a merge that conflicts, resolved and committed. Open documents follow every step.

use ide_core::DocId;
use ide_host::{Host, HostConfig, ops};
use ide_vcs::{ChangeKind, CommitOptions, FileStatus, HunkKind, LogQuery};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

const WINDOW: &str = "main";
/// The line every branch changes, in `src/lib.rs`.
const LINE: &str = "pub fn format_price(cents: u64) -> String {";

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}

struct Flow {
    host: Arc<Host>,
    root: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Flow {
    async fn new(fixture: &str) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join(fixture);
        copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(fixture), &root);
        git(&root, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&root, &["config", key, value]);
        }
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "Initial commit"]);
        let host = Arc::new(Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        host.trust.decide(&root, true, false).unwrap();
        let project = ops::project::open(&host, WINDOW, &root).await.unwrap();
        for _ in 0..500 {
            if !project.repos().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Flow { host, root, _tmp: tmp }
    }

    async fn open(&self, file: &str) -> DocId {
        ops::doc::open(&self.host, WINDOW, self.root.join(file)).await.unwrap().id
    }

    async fn text(&self, doc: DocId) -> String {
        ops::doc::snapshot(&self.host, WINDOW, doc).await.unwrap().text
    }

    /// Types `with` over `LINE` in the editor (unsaved).
    async fn edit_line(&self, doc: DocId, with: &str) {
        let text = self.text(doc).await;
        let current = text.lines().find(|l| l.starts_with("pub fn format_price")).unwrap().to_owned();
        let project = self.host.project(WINDOW).unwrap();
        project.documents.replace_all(doc, &text.replacen(&current, with, 1)).unwrap();
    }

    async fn save(&self, doc: DocId) {
        ops::doc::save(&self.host, WINDOW, doc).await.unwrap();
    }

    async fn status(&self) -> Vec<FileStatus> {
        ops::vcs::status(&self.host, WINDOW).await.unwrap()
    }

    async fn commit(&self, files: &[&str], message: &str) -> String {
        let paths = files.iter().map(|f| self.root.join(f)).collect();
        ops::vcs::vcs_stage(&self.host, WINDOW, paths).await.unwrap();
        let options = CommitOptions { run_hooks: true, ..Default::default() };
        ops::vcs::vcs_commit(&self.host, WINDOW, None, message.into(), options).await.unwrap()
    }

    async fn head(&self) -> ide_vcs::Commit {
        let log = ops::vcs::vcs_log(&self.host, WINDOW, None, LogQuery::default()).await.unwrap();
        log.into_iter().next().expect("a commit")
    }
}

fn changed<'a>(status: &'a [FileStatus], file: &str) -> Option<&'a FileStatus> {
    status.iter().find(|s| s.rel_path == file)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn change_commit_branch_stash_and_merge_a_conflict() {
    let f = Flow::new("rust-app").await;
    let lib_path = f.root.join("src/lib.rs");
    let lib = f.open("src/lib.rs").await;
    let original = f.text(lib).await;
    let line = original.lines().position(|l| l == LINE).expect("the fixture's line") as u32;

    // An edit in the editor: a modified line in the gutter, against HEAD, before saving.
    let base = "pub fn format_price(cents: u64) -> String { // base";
    f.edit_line(lib, base).await;
    let hunks = ops::vcs::vcs_line_hunks(&f.host, WINDOW, lib_path.clone()).await.unwrap();
    assert!(
        matches!(&hunks[..], [h] if h.kind == HunkKind::Modified && h.start == line && h.old_text.contains(LINE)),
        "{hunks:?}"
    );
    assert!(f.status().await.is_empty(), "nothing saved yet");

    // Saved: Local Changes lists it, and its diff shows the edit.
    f.save(lib).await;
    let status = f.status().await;
    assert_eq!(changed(&status, "src/lib.rs").and_then(|s| s.unstaged), Some(ChangeKind::Modified), "{status:?}");
    let diff = ops::vcs::vcs_diff_text(&f.host, WINDOW, lib_path.clone(), false).await.unwrap();
    assert!(diff.contains(&format!("-{LINE}")) && diff.contains(&format!("+{base}")), "{diff}");

    // Commit: the log's head; nothing left to commit; no gutter marks.
    let id = f.commit(&["src/lib.rs"], "Mark the base").await;
    let head = f.head().await;
    assert_eq!((head.id.as_str(), head.summary.as_str()), (id.as_str(), "Mark the base"));
    assert!(f.status().await.is_empty());
    assert!(ops::vcs::vcs_line_hunks(&f.host, WINDOW, lib_path.clone()).await.unwrap().is_empty());

    // A branch changes the line its way.
    ops::vcs::vcs_create_branch(&f.host, WINDOW, None, "feature".into(), None, true).await.unwrap();
    let theirs = "pub fn format_price(cents: u64) -> String { // feature";
    f.edit_line(lib, theirs).await;
    f.save(lib).await;
    f.commit(&["src/lib.rs"], "Feature's change").await;
    let branches = ops::vcs::vcs_branches(&f.host, WINDOW, None).await.unwrap();
    assert!(branches.iter().any(|b| b.name == "feature" && b.current), "{branches:?}");

    // Back on main, the open file shows main's text.
    ops::vcs::vcs_checkout(&f.host, WINDOW, None, "main".into(), false, None).await.unwrap();
    assert!(f.text(lib).await.contains(base));

    // Stash: work in progress put aside and brought back.
    let main_rs = f.open("src/main.rs").await;
    let wip = format!("{}// work in progress\n", f.text(main_rs).await);
    f.host.project(WINDOW).unwrap().documents.replace_all(main_rs, &wip).unwrap();
    f.save(main_rs).await;
    ops::vcs::vcs_stash_push(&f.host, WINDOW, None, Some("wip".into()), false, false).await.unwrap();
    assert!(f.status().await.is_empty());
    assert!(!f.text(main_rs).await.contains("work in progress"));
    let stashes = ops::vcs::vcs_stashes(&f.host, WINDOW, None).await.unwrap();
    assert!(matches!(&stashes[..], [s] if s.message.contains("wip")), "{stashes:?}");
    ops::vcs::vcs_stash_apply(&f.host, WINDOW, None, 0, true, false, None).await.unwrap();
    assert_eq!(f.text(main_rs).await, wip);
    assert!(ops::vcs::vcs_stashes(&f.host, WINDOW, None).await.unwrap().is_empty());
    ops::vcs::vcs_discard(&f.host, WINDOW, vec![f.root.join("src/main.rs")]).await.unwrap();
    assert!(f.status().await.is_empty());

    // Main changes the same line: merging the branch conflicts.
    let ours = "pub fn format_price(cents: u64) -> String { // main";
    f.edit_line(lib, ours).await;
    f.save(lib).await;
    f.commit(&["src/lib.rs"], "Main's change").await;
    let merged = ops::vcs::vcs_merge(&f.host, WINDOW, None, "feature".into()).await;
    let status = f.status().await;
    let conflicted = changed(&status, "src/lib.rs").map(|s| (s.staged, s.unstaged));
    assert!(
        matches!(conflicted, Some((Some(ChangeKind::Conflicted), _) | (_, Some(ChangeKind::Conflicted)))),
        "merge: {merged:?}; status: {status:?}"
    );
    // The open file shows the conflict as Git left it.
    assert!(f.text(lib).await.contains("<<<<<<<"), "{}", f.text(lib).await);
    let versions = ops::vcs::vcs_conflict_versions(&f.host, WINDOW, lib_path.clone()).await.unwrap();
    let has = |side: &Option<String>, line: &str| side.as_deref().is_some_and(|t| t.contains(line));
    assert!(has(&versions.base, base) && has(&versions.ours, ours) && has(&versions.theirs, theirs), "{versions:?}");

    // Resolved (Accept Theirs) and committed: a merge commit, nothing left.
    let resolved = versions.theirs.clone().unwrap();
    f.host.project(WINDOW).unwrap().documents.replace_all(lib, &resolved).unwrap();
    f.save(lib).await;
    f.commit(&["src/lib.rs"], "Merge feature").await;
    let head = f.head().await;
    assert_eq!(head.parents.len(), 2, "{head:?}");
    assert!(f.status().await.is_empty());
    assert_eq!(std::fs::read_to_string(&lib_path).unwrap(), resolved);
}
