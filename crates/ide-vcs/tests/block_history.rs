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
    // Without a merge on top, HEAD's block is the newest row's.
    assert_eq!(h.head.as_deref(), Some(h.revisions[0].after.as_str()));
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
fn newest_row_a_merge_without_a_diff() {
    let fx = Fixture::new();
    fx.write("a.txt", "a\nb\nc\nd\n");
    fx.commit("Add a");
    fx.git(&["switch", "-q", "-c", "side"]);
    fx.write("a.txt", "A\nb\nc\nd\n");
    fx.commit("Side edit");
    fx.git(&["switch", "-q", "main"]);
    fx.write("a.txt", "a\nb\nc\nD\n");
    fx.commit("Main edit");
    fx.git(&["merge", "-q", "--no-edit", "side"]);
    let h = history(&fx.repo(), &fx.path("a.txt"), None, (0, 3));
    let newest = &h.revisions[0];
    assert!(newest.summary.starts_with("Merge"), "{newest:?}");
    // Git prints no patch for the merge, so its block says nothing about HEAD.
    assert_eq!((newest.before.as_str(), newest.after.as_str()), ("", ""));
    assert_eq!(h.head.as_deref(), Some("A\nb\nc\nD\n"));
}

#[test]
fn lazy_revisions_match_the_full_history_even_after_head_moves() {
    let fx = renamed_history();
    let repo = fx.repo();
    let path = fx.path("b.txt");
    let cancel = CancellationToken::new();
    let full = history(&repo, &path, None, (1, 2));
    let summary = repo.block_history_summary(&path, None, (1, 2), encoding_rs::UTF_8, &cancel).unwrap();
    let anchor = summary.anchor.unwrap();
    assert_eq!(Some(anchor.lines), full.head_lines);
    assert_eq!(summary.head, full.head);
    assert_eq!(
        summary
            .diffs
            .iter()
            .map(|row| row.id.as_str())
            .chain(summary.rest.iter().map(|row| row.id.as_str()))
            .collect::<Vec<_>>(),
        full.revisions.iter().map(|row| row.id.as_str()).collect::<Vec<_>>()
    );
    assert_eq!(summary.diffs[0].after, full.revisions[0].after);
    fx.write("b.txt", "one\nTWO\nnew head\nfour\nFIVE\n");
    fx.commit("Another edit");
    for (index, expected) in full.revisions.iter().enumerate() {
        let actual = repo
            .block_history_revisions(
                &path,
                &anchor,
                index as u32,
                std::slice::from_ref(&expected.id),
                encoding_rs::UTF_8,
                &cancel,
            )
            .unwrap();
        assert_eq!(serde_json::to_value(&actual[0]).unwrap(), serde_json::to_value(expected).unwrap());
    }
    let mismatch = repo
        .block_history_revisions(
            &path,
            &anchor,
            1,
            std::slice::from_ref(&full.revisions[0].id),
            encoding_rs::UTF_8,
            &cancel,
        )
        .unwrap_err();
    assert_eq!(mismatch.kind, ErrorKind::NotFound);
}

#[test]
fn large_history_summary_fetches_only_initial_batch() {
    let fx = Fixture::new();
    // Large enough (> 512 KiB of inline diff text after the first 4 diffs) that summary
    // switches to header+spot mode for the remaining commits.
    let mut lines: Vec<String> =
        (0..1500).map(|i| format!("let value_{i:04} = compute_block_line_value({i}, \"padding\");")).collect();
    fx.write("large.txt", &(lines.join("\n") + "\n"));
    fx.commit("Add large");
    for n in 1..10 {
        let idx = n * 100;
        lines[idx] = format!("let value_{idx:04} = compute_block_line_value({n} + 100, \"updated\");");
        fx.write("large.txt", &(lines.join("\n") + "\n"));
        fx.commit(&format!("Edit {n}"));
    }
    let repo = fx.repo();
    let path = fx.path("large.txt");
    let cancel = CancellationToken::new();
    let full = history(&repo, &path, None, (0, 1499));
    let summary = repo.block_history_summary(&path, None, (0, 1499), encoding_rs::UTF_8, &cancel).unwrap();
    assert_eq!(summary.head, full.head);
    assert_eq!(summary.diffs.len(), 4);
    assert_eq!(summary.rest.len(), 6);
    assert_eq!(serde_json::to_value(&summary.diffs).unwrap(), serde_json::to_value(&full.revisions[..4]).unwrap());
    let spots: Vec<_> =
        summary.rest.iter().map(|row| BlockRevisionSpot { id: row.id.clone(), ranges: row.ranges.clone() }).collect();
    let deep = repo.block_history_revisions_at(&spots[2..6], encoding_rs::UTF_8, &cancel).unwrap();
    assert_eq!(serde_json::to_value(&deep).unwrap(), serde_json::to_value(&full.revisions[6..10]).unwrap());
}

/// renamed_history padded so summary exceeds the inline budget, then renamed to a non-ASCII
/// name with a space, edited on two branches (one also moves the block down) and merged, then
/// edited once more.
fn merged_history() -> Fixture {
    let fx = Fixture::new();
    let pad = |body: &str| {
        let mut s = body.to_owned();
        for i in 0..1600 {
            s.push_str(&format!("let filler_{i:04} = \"constant_padding_line_for_spot_test\";\n"));
        }
        s
    };
    fx.write("a.txt", &pad("one\ntwo\nthree\nfour\nfive\n"));
    fx.commit("Add a");
    fx.write("a.txt", &pad("one\nTWO\nthree\nfour\nfive\n"));
    fx.commit("Shout two");
    fx.write("a.txt", &pad("one\nTWO\nthree\nfour\nFIVE\n"));
    fx.commit("Shout five");
    fx.git(&["mv", "a.txt", "b.txt"]);
    fx.commit("Rename a to b");
    fx.write("b.txt", &pad("one\nTWO\nTHREE\nfour\nFIVE\n"));
    fx.commit("Shout three");
    fx.git(&["mv", "b.txt", "ü c.txt"]);
    fx.commit("Rename b to ü c");
    fx.git(&["checkout", "-q", "-b", "side"]);
    fx.write("ü c.txt", &pad("zero\nzero again\none\nTWO side\nTHREE\nfour\nFIVE\n"));
    fx.commit("Side: lines above, two");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("ü c.txt", &pad("one\nTWO\nTHREE\nfour main\nFIVE\n"));
    fx.commit("Main: four");
    fx.git(&["merge", "-q", "--no-edit", "side"]);
    fx.write("ü c.txt", &pad("zero\nzero again\none\nTWO side\nTHREE merged\nfour main\nFIVE\n"));
    fx.commit("Three after the merge");
    fx
}

#[test]
fn spots_read_the_same_diffs_as_the_full_walk() {
    let fx = merged_history();
    let repo = fx.repo();
    let path = fx.path("ü c.txt");
    let cancel = CancellationToken::new();
    // Selecting the whole padded file forces summary past the inline budget after 4 commits so
    // `rest` exercises spot extraction across a merge, a space+non-ASCII name, and both renames.
    for lines in [(0, 1606), (3, 1606)] {
        let full = history(&repo, &path, None, lines);
        let summary = repo.block_history_summary(&path, None, lines, encoding_rs::UTF_8, &cancel).unwrap();
        assert_eq!(summary.diffs.len() + summary.rest.len(), full.revisions.len(), "{lines:?}");
        assert!(!summary.rest.is_empty(), "expected lazy rest rows for {lines:?}");
        assert_eq!(
            serde_json::to_value(&summary.diffs).unwrap(),
            serde_json::to_value(&full.revisions[..summary.diffs.len()]).unwrap()
        );
        let spots: Vec<_> = summary
            .rest
            .iter()
            .map(|row| BlockRevisionSpot { id: row.id.clone(), ranges: row.ranges.clone() })
            .collect();
        let expected_rest = &full.revisions[summary.diffs.len()..];
        for (spot, expected) in spots.iter().zip(expected_rest) {
            let actual =
                repo.block_history_revisions_at(std::slice::from_ref(spot), encoding_rs::UTF_8, &cancel).unwrap();
            assert_eq!(serde_json::to_value(&actual).unwrap(), serde_json::to_value([expected]).unwrap(), "{spot:?}");
        }
        for batch in spots.chunks(4) {
            let actual = repo.block_history_revisions_at(batch, encoding_rs::UTF_8, &cancel).unwrap();
            assert_eq!(
                actual.iter().map(|d| &d.id).collect::<Vec<_>>(),
                batch.iter().map(|s| &s.id).collect::<Vec<_>>()
            );
        }
        let paths: std::collections::BTreeSet<_> =
            spots.iter().flat_map(|spot| spot.ranges.iter().flatten().map(|range| range.path.as_str())).collect();
        assert!(paths.contains("a.txt") && paths.contains("b.txt"), "{paths:?}");
    }
    // Also check a merge row landing in `rest` (empty spot ranges -> `--no-patch` read).
    let mut padded = "zero\nzero again\none\nTWO side\nTHREE merged\nfour main\nFIVE\n".to_owned();
    for i in 0..1600 {
        padded.push_str(&format!("let filler_{i:04} = \"constant_padding_line_for_spot_test\";\n"));
    }
    for n in 1..=4 {
        fx.write("ü c.txt", &format!("extra_{n}\n{padded}"));
        fx.commit(&format!("Post-merge edit {n}"));
    }
    let full = history(&repo, &path, None, (0, 1606));
    let summary = repo.block_history_summary(&path, None, (0, 1606), encoding_rs::UTF_8, &cancel).unwrap();
    let merge_row =
        summary.rest.iter().find(|row| row.summary.starts_with("Merge")).expect("merge commit should land in rest");
    assert_eq!(merge_row.ranges.as_deref(), Some(&[][..]));
    let merge_spot = BlockRevisionSpot { id: merge_row.id.clone(), ranges: merge_row.ranges.clone() };
    let actual = repo.block_history_revisions_at(&[merge_spot], encoding_rs::UTF_8, &cancel).unwrap();
    let expected = full.revisions.iter().find(|r| r.id == merge_row.id).unwrap();
    assert_eq!(serde_json::to_value(&actual[0]).unwrap(), serde_json::to_value(expected).unwrap());
}

#[test]
fn spots_are_checked() {
    let fx = renamed_history();
    let repo = fx.repo();
    let cancel = CancellationToken::new();
    let id = fx.git(&["rev-parse", "HEAD"]);
    let spot = |ranges| BlockRevisionSpot { id: id.clone(), ranges };
    let range = |path: &str, start, end| BlockSpotRange { path: path.into(), start, end };
    for bad in [
        vec![spot(None)],
        vec![spot(Some(vec![range("b.txt", 0, 1)]))],
        vec![spot(Some(vec![range("b.txt", 3, 2)]))],
        vec![spot(Some(vec![range("", 1, 2)]))],
        vec![BlockRevisionSpot { id: "HEAD".into(), ranges: Some(Vec::new()) }],
        vec![spot(Some(Vec::new())); 5],
        Vec::new(),
    ] {
        let err = repo.block_history_revisions_at(&bad, encoding_rs::UTF_8, &cancel).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidInput, "{bad:?}");
    }
    // A spot whose commit does not change those lines.
    let err = repo
        .block_history_revisions_at(&[spot(Some(vec![range("b.txt", 1, 1)]))], encoding_rs::UTF_8, &cancel)
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::NotFound);
}

#[test]
fn maps_an_edited_selection_to_head_lines() {
    let fx = renamed_history();
    let repo = fx.repo();
    // Two unsaved lines inserted at the top: lines 3..=4 are HEAD's 1..=2.
    let edited = "new\nnew\none\nTWO\nTHREE\nfour\nFIVE\n";
    let h = history(&repo, &fx.path("b.txt"), Some(edited), (3, 4));
    assert_eq!((h.head_lines, h.head.as_deref()), (Some((1, 2)), Some("TWO\nTHREE\n")));
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
    let repo = fx.repo();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let err = repo.block_history(&fx.path("b.txt"), None, (1, 2), encoding_rs::UTF_8, &cancel).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    let err = repo.block_history_summary(&fx.path("b.txt"), None, (1, 2), encoding_rs::UTF_8, &cancel).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    let anchor = BlockHistoryAnchor { commit: fx.git(&["rev-parse", "HEAD"]), lines: (1, 2) };
    let err = repo
        .block_history_revisions(
            &fx.path("b.txt"),
            &anchor,
            0,
            std::slice::from_ref(&anchor.commit),
            encoding_rs::UTF_8,
            &cancel,
        )
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    let spot = BlockRevisionSpot {
        id: anchor.commit,
        ranges: Some(vec![BlockSpotRange { path: "b.txt".into(), start: 2, end: 3 }]),
    };
    let err = repo.block_history_revisions_at(&[spot], encoding_rs::UTF_8, &cancel).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
}

#[cfg(unix)]
#[test]
fn in_flight_cancellation_stops_line_runner_and_parallel_reads() {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    let fx = renamed_history();
    let head = fx.git(&["rev-parse", "HEAD"]);
    let prev = fx.git(&["rev-parse", "HEAD~2"]);
    let marker = fx.path("spawned.log");
    let script = fx.path("slow-git.sh");
    std::fs::write(&script, format!("#!/bin/sh\necho $$ >> '{}'\nexec sleep 60\n", marker.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let repo = fx.repo();
    repo.set_git_executable(Some(&script));

    let wait_and_cancel = |marker: PathBuf, expected: usize, cancel: CancellationToken| {
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if let Ok(text) = std::fs::read_to_string(&marker)
                    && text.lines().count() >= expected
                {
                    cancel.cancel();
                    return true;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            cancel.cancel();
            false
        })
    };

    // 1. Streaming line runner (`block_history_summary`).
    let cancel = CancellationToken::new();
    let canceller = wait_and_cancel(marker.clone(), 1, cancel.clone());
    let start = Instant::now();
    let err = repo.block_history_summary(&fx.path("b.txt"), None, (1, 2), encoding_rs::UTF_8, &cancel).unwrap_err();
    let saw_spawn = canceller.join().unwrap();
    assert!(saw_spawn, "slow git did not start for summary");
    assert_eq!(err.kind, ErrorKind::Cancelled);
    assert!(start.elapsed() < Duration::from_secs(5), "summary cancel took {:?}", start.elapsed());

    // 2. Parallel per-commit reads (`block_history_revisions_at`): also verifies that the
    //    scoped worker thread inherits `Repo::execution_scope` (the configured git executable).
    let _ = std::fs::remove_file(&marker);
    let cancel = CancellationToken::new();
    let canceller = wait_and_cancel(marker.clone(), 2, cancel.clone());
    let spots = [
        BlockRevisionSpot { id: head, ranges: Some(vec![BlockSpotRange { path: "b.txt".into(), start: 2, end: 3 }]) },
        BlockRevisionSpot { id: prev, ranges: Some(vec![BlockSpotRange { path: "a.txt".into(), start: 2, end: 3 }]) },
    ];
    let start = Instant::now();
    let err = repo.block_history_revisions_at(&spots, encoding_rs::UTF_8, &cancel).unwrap_err();
    let saw_both = canceller.join().unwrap();
    assert!(saw_both, "parallel worker did not run the repository's configured git");
    assert_eq!(err.kind, ErrorKind::Cancelled);
    assert!(start.elapsed() < Duration::from_secs(5), "revisions_at cancel took {:?}", start.elapsed());
}
