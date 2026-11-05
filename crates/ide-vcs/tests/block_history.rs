//! History for Selection (`git log -L`) against throwaway repositories built with the git CLI.

use ide_core::CancellationToken;
use ide_core::error::ErrorKind;
use ide_vcs::*;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Fixture {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("work");
        std::fs::create_dir(&dir).unwrap();
        let fx = Fixture { _tmp: tmp, dir };
        fx.git(&["init", "-q"]);
        for (k, v) in [("user.name", "Test User"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")] {
            fx.git(&["config", k, v]);
        }
        fx
    }
    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(&self.dir)
            .args(["-c", "init.defaultBranch=main", "-c", "core.autocrlf=false"])
            .args(args)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
    fn write(&self, rel: &str, content: &str) {
        std::fs::write(self.dir.join(rel), content).unwrap();
    }
    fn commit(&self, msg: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
    }
    fn repo(&self) -> Repo {
        Repo::discover(&self.dir).unwrap().expect("repository found")
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
}

fn history(repo: &Repo, path: &Path, text: Option<&str>, lines: (u32, u32)) -> BlockHistory {
    repo.block_history(path, text, lines, encoding_rs::UTF_8, &CancellationToken::new()).unwrap()
}

/// a.txt: added, line 2 edited, line 5 edited, renamed to b.txt, line 3 edited.
fn renamed_history() -> Fixture {
    let fx = Fixture::new();
    fx.write("a.txt", "one\ntwo\nthree\nfour\nfive\n");
    fx.commit("Add a");
    fx.write("a.txt", "one\nTWO\nthree\nfour\nfive\n");
    fx.commit("Shout two");
    fx.write("a.txt", "one\nTWO\nthree\nfour\nFIVE\n");
    fx.commit("Shout five");
    fx.git(&["mv", "a.txt", "b.txt"]);
    fx.commit("Rename a to b");
    fx.write("b.txt", "one\nTWO\nTHREE\nfour\nFIVE\n");
    fx.commit("Shout three");
    fx
}

#[test]
fn follows_the_block_through_edits_and_a_rename() {
    let fx = renamed_history();
    let h = history(&fx.repo(), &fx.path("b.txt"), None, (1, 2));
    assert_eq!(h.head_lines, Some((1, 2)));
    let shown: Vec<_> = h.revisions.iter().map(|r| (r.summary.as_str(), r.path.as_str())).collect();
    // Edits outside the block and the pure rename are left out.
    assert_eq!(shown, [("Shout three", "b.txt"), ("Shout two", "a.txt"), ("Add a", "a.txt")]);
    let blocks: Vec<_> = h.revisions.iter().map(|r| (r.before.as_str(), r.after.as_str())).collect();
    assert_eq!(blocks, [("TWO\nthree\n", "TWO\nTHREE\n"), ("two\nthree\n", "TWO\nthree\n"), ("", "two\nthree\n")]);
    let newest = &h.revisions[0];
    assert_eq!((newest.before_line, newest.after_line, newest.author.as_str()), (1, 1, "Test User"));
    assert!(newest.id.starts_with(&newest.short_id) && newest.time_ms > 0.0);
}

#[test]
fn maps_an_edited_selection_to_head_lines() {
    let fx = renamed_history();
    let repo = fx.repo();
    // Two unsaved lines inserted at the top: lines 3..=4 are HEAD's 1..=2.
    let edited = "new\nnew\none\nTWO\nTHREE\nfour\nFIVE\n";
    let h = history(&repo, &fx.path("b.txt"), Some(edited), (3, 4));
    assert_eq!(h.head_lines, Some((1, 2)));
    assert_eq!(h.revisions.len(), 3);
    // Only new lines selected, or a file Git does not know: nothing committed to show.
    let h = history(&repo, &fx.path("b.txt"), Some(edited), (0, 1));
    assert_eq!((h.head_lines, h.revisions.len()), (None, 0));
    fx.write("untracked.txt", "x\n");
    let h = history(&repo, &fx.path("untracked.txt"), None, (0, 0));
    assert_eq!((h.head_lines, h.revisions.len()), (None, 0));
}

#[test]
fn restricted_mode_runs_no_diff_driver_of_the_repository() {
    let fx = renamed_history();
    let marker = fx.path("textconv-ran");
    fx.write(".gitattributes", "*.txt diff=probe\n");
    fx.commit("Attributes");
    fx.git(&["config", "diff.probe.textconv", &format!("sh -c 'touch {}; cat \"$0\"'", marker.display())]);
    let repo = fx.repo();
    repo.set_execution_allowed(false);
    let h = history(&repo, &fx.path("b.txt"), None, (1, 2));
    assert_eq!(h.revisions.len(), 3);
    assert!(!marker.exists(), "a textconv driver ran in restricted mode");
}

#[test]
fn cancelled_requests_stop() {
    let fx = renamed_history();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let err = fx.repo().block_history(&fx.path("b.txt"), None, (1, 2), encoding_rs::UTF_8, &cancel).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
}
