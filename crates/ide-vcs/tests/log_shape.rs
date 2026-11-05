//! Git Log graph options (order, first parent, no merges, date range) and the Git menu
//! dialogs' operations (merge / rebase with options, remotes, worktrees).

use ide_vcs::*;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str], time: Option<i64>) -> String {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .args(["-c", "init.defaultBranch=main", "-c", "user.name=Test", "-c", "user.email=t@example.com"])
        .args(["-c", "commit.gpgsign=false", "-c", "core.hooksPath=.git/hooks"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(t) = time {
        let date = format!("@{t} +0000");
        cmd.env("GIT_AUTHOR_DATE", &date).env("GIT_COMMITTER_DATE", &date);
    }
    let out = cmd.output().expect("git runs");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, msg: &str, time: i64) -> String {
    std::fs::write(dir.join(file), msg).unwrap();
    git(dir, &["add", "-A"], None);
    git(dir, &["commit", "-q", "-m", msg], Some(time));
    git(dir, &["rev-parse", "HEAD"], None)
}

struct History {
    _tmp: tempfile::TempDir,
    repo: Repo,
    c1: String,
    s1: String,
    c2: String,
    m: String,
    c3: String,
}

/// c1 ← s1 (side) ; c1 ← c2 ← m (merges s1) ← c3, committed at 1000…5000 s.
fn history() -> History {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    git(&dir, &["init", "-q"], None);
    let c1 = commit(&dir, "a.txt", "c1", 1000);
    git(&dir, &["checkout", "-q", "-b", "side"], None);
    let s1 = commit(&dir, "s.txt", "s1", 2000);
    git(&dir, &["checkout", "-q", "main"], None);
    let c2 = commit(&dir, "b.txt", "c2", 3000);
    git(&dir, &["merge", "-q", "--no-ff", "-m", "merge side", "side"], Some(4000));
    let m = git(&dir, &["rev-parse", "HEAD"], None);
    let c3 = commit(&dir, "c.txt", "c3", 5000);
    let repo = Repo::discover(&dir).unwrap().expect("repository");
    History { _tmp: tmp, repo, c1, s1, c2, m, c3 }
}

fn log(h: &History, q: LogQuery) -> Vec<Commit> {
    h.repo.log(&LogQuery { branches: vec!["main".into()], ..q }).unwrap()
}

fn ids(commits: &[Commit]) -> Vec<String> {
    commits.iter().map(|c| c.id.clone()).collect()
}

fn parents_of(commits: &[Commit], id: &str) -> Vec<String> {
    commits.iter().find(|c| c.id == id).unwrap().graph_parents.clone().unwrap()
}

#[test]
fn date_order_follows_commit_time_and_reports_it() {
    let h = history();
    let out = log(&h, LogQuery { order: LogOrder::Date, ..Default::default() });
    assert_eq!(ids(&out), vec![h.c3.clone(), h.m.clone(), h.c2.clone(), h.s1.clone(), h.c1.clone()]);
    assert_eq!(out[0].commit_time_ms, 5_000_000.0);
}

#[test]
fn incoming_order_groups_the_merged_branch_before_the_main_parent() {
    let h = history();
    let out = log(&h, LogQuery { order: LogOrder::Standard, ..Default::default() });
    assert_eq!(ids(&out), vec![h.c3.clone(), h.m.clone(), h.s1.clone(), h.c2.clone(), h.c1.clone()]);
    assert_eq!(out[1].parents, vec![h.c2.clone(), h.s1.clone()]);
}

#[test]
fn no_merges_links_children_to_the_merge_parents() {
    let h = history();
    let out = log(&h, LogQuery { no_merges: true, ..Default::default() });
    assert!(!ids(&out).contains(&h.m));
    assert_eq!(out.len(), 4);
    assert_eq!(parents_of(&out, &h.c3), vec![h.c2.clone(), h.s1.clone()]);
}

#[test]
fn first_parent_skips_merged_branches() {
    let h = history();
    let out = log(&h, LogQuery { first_parent: true, ..Default::default() });
    assert_eq!(ids(&out), vec![h.c3.clone(), h.m.clone(), h.c2.clone(), h.c1.clone()]);
    assert_eq!(parents_of(&out, &h.m), vec![h.c2.clone()]);
    assert_eq!(out.iter().find(|c| c.id == h.m).unwrap().parents, vec![h.c2.clone(), h.s1.clone()]);
}

#[test]
fn date_range_keeps_the_graph_connected() {
    let h = history();
    let since = log(&h, LogQuery { since_ms: Some(2_500_000.0), ..Default::default() });
    assert_eq!(ids(&since), vec![h.c3.clone(), h.m.clone(), h.c2.clone()]);
    // Older parents are not shown, so they are dropped.
    assert_eq!(parents_of(&since, &h.m), vec![h.c2.clone()]);
    assert!(parents_of(&since, &h.c2).is_empty());

    let window = log(&h, LogQuery { since_ms: Some(1_500_000.0), until_ms: Some(4_500_000.0), ..Default::default() });
    let mut got = ids(&window);
    got.sort();
    let mut want = vec![h.m.clone(), h.c2.clone(), h.s1.clone()];
    want.sort();
    assert_eq!(got, want);

    // A commit newer than `until` is skipped and its child links past it.
    let until = log(&h, LogQuery { until_ms: Some(3_500_000.0), order: LogOrder::Date, ..Default::default() });
    assert_eq!(ids(&until), vec![h.c2.clone(), h.s1.clone(), h.c1.clone()]);
    let combined = log(&h, LogQuery { until_ms: Some(4_500_000.0), no_merges: true, ..Default::default() });
    assert!(!ids(&combined).contains(&h.m) && !ids(&combined).contains(&h.c3));
}

#[test]
fn merge_with_options_and_rebase_onto() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"], None);
    // Repo operations spawn their own Git commands, so command-local `-c`
    // options in the helper do not supply their committer identity.
    git(dir, &["config", "user.name", "Test"], None);
    git(dir, &["config", "user.email", "t@example.com"], None);
    git(dir, &["config", "commit.gpgsign", "false"], None);
    let base = commit(dir, "a.txt", "base", 1000);
    git(dir, &["checkout", "-q", "-b", "feature"], None);
    let f1 = commit(dir, "f.txt", "f1", 2000);
    git(dir, &["checkout", "-q", "main"], None);
    let repo = Repo::discover(dir).unwrap().unwrap();

    let ff_only = MergeOptions { ff_only: true, squash: true, ..Default::default() };
    assert!(repo.merge_with(&["feature".into()], &ff_only).is_err());
    let no_ff = MergeOptions { no_ff: true, message: Some("Merge feature now".into()), ..Default::default() };
    repo.merge_with(&["feature".into()], &no_ff).unwrap();
    assert_eq!(git(dir, &["log", "-1", "--format=%P %s"], None), format!("{base} {f1} Merge feature now"));

    git(dir, &["checkout", "-q", "-b", "topic", &base], None);
    commit(dir, "t.txt", "topic", 3000);
    repo.rebase_with("main", &RebaseOptions::default()).unwrap();
    assert_eq!(git(dir, &["rev-list", "--count", "main..topic"], None), "1");
    assert_eq!(git(dir, &["merge-base", "main", "topic"], None), git(dir, &["rev-parse", "main"], None));
}

#[test]
fn remotes_and_worktrees_are_managed() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("work");
    std::fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"], None);
    commit(&dir, "a.txt", "base", 1000);
    let repo = Repo::discover(&dir).unwrap().unwrap();

    repo.edit_remote(&RemoteEdit::Add { name: "origin".into(), url: "https://example.com/a.git".into() }).unwrap();
    repo.edit_remote(&RemoteEdit::Edit {
        name: "origin".into(),
        new_name: "upstream".into(),
        url: "https://example.com/b.git".into(),
    })
    .unwrap();
    assert_eq!(
        repo.remotes().unwrap(),
        vec![Remote { name: "upstream".into(), url: "https://example.com/b.git".into() }]
    );
    assert!(repo.edit_remote(&RemoteEdit::Add { name: "--bad".into(), url: "x".into() }).is_err());
    repo.edit_remote(&RemoteEdit::Remove { name: "upstream".into() }).unwrap();
    assert!(repo.remotes().unwrap().is_empty());

    let wt = tmp.path().join("work-fix");
    repo.add_worktree(&wt, "main", Some("fix")).unwrap();
    let list = repo.worktrees().unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].main && list[0].branch.as_deref() == Some("main"));
    assert_eq!(list[1].branch.as_deref(), Some("fix"));
    assert!(wt.join("a.txt").exists());
    repo.remove_worktree(&wt, false).unwrap();
    assert_eq!(repo.worktrees().unwrap().len(), 1);
}

#[test]
fn a_user_filter_links_shown_commits_past_hidden_ones() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"], None);
    let by = |who: &str, file: &str, msg: &str, time: i64| {
        std::fs::write(dir.join(file), msg).unwrap();
        git(dir, &["add", "-A"], None);
        let email = format!("user.email={who}@example.com");
        git(dir, &["-c", &email, "commit", "-q", "-m", msg], Some(time));
        git(dir, &["rev-parse", "HEAD"], None)
    };
    let m1 = by("me", "a", "m1", 1_000);
    let o1 = by("other", "b", "o1", 2_000);
    let m2 = by("me", "c", "m2", 3_000);
    let m3 = by("me", "d", "m3", 4_000);
    let _o2 = by("other", "e", "o2", 5_000);
    let repo = Repo::discover(dir).unwrap().unwrap();

    let log = repo.log(&LogQuery { author: Some("me@".into()), ..Default::default() }).unwrap();
    let links: Vec<(&str, Vec<&str>, Vec<bool>)> = log
        .iter()
        .map(|c| {
            (
                c.summary.as_str(),
                c.graph_parents.as_ref().unwrap().iter().map(String::as_str).collect(),
                if c.graph_dashed.iter().any(|d| *d) { c.graph_dashed.clone() } else { Vec::new() },
            )
        })
        .collect();
    assert_eq!(
        links,
        [("m3", vec![m2.as_str()], vec![]), ("m2", vec![m1.as_str()], vec![true]), ("m1", vec![], vec![]),],
        "m2's parent o1 is hidden: m2 links to m1, dashed"
    );
    assert!(!log.iter().any(|c| c.graph_parents.as_ref().unwrap().contains(&o1)));
    assert_eq!(log[1].parents, vec![o1]);

    // A page ends at m2: walking on still links it to m1.
    let page = repo.log(&LogQuery { author: Some("me@".into()), limit: 2, ..Default::default() }).unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[1].graph_parents.as_deref().unwrap(), std::slice::from_ref(&m1));
    let next = repo.log(&LogQuery { author: Some("me@".into()), skip: 2, limit: 2, ..Default::default() }).unwrap();
    assert_eq!(next.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), std::slice::from_ref(&m1));
    let _ = m3;
}
