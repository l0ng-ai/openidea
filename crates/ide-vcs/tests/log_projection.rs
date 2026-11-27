use ide_vcs::{LogOrder, LogQuery, Repo};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "init.defaultBranch=main",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, message: &str) -> String {
    std::fs::write(dir.join(file), message).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", message]);
    git(dir, &["rev-parse", "HEAD"])
}

#[test]
fn branch_and_independent_ranges_form_a_union() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let root = commit(dir, "a", "root");
    let first = commit(dir, "a", "first");
    let second = commit(dir, "a", "second");
    let third = commit(dir, "a", "third");
    git(dir, &["checkout", "-qb", "side", &root]);
    let side = commit(dir, "b", "side");
    let repo = Repo::discover(dir).unwrap().unwrap();
    for order in [LogOrder::Topo, LogOrder::Date, LogOrder::Standard] {
        let log = repo
            .log(&LogQuery {
                branches: vec!["side".into()],
                ranges: vec![format!("{root}..{first}"), format!("{second}..{third}")],
                order,
                ..Default::default()
            })
            .unwrap();
        let got: std::collections::HashSet<_> = log.iter().map(|c| c.id.clone()).collect();
        assert_eq!(got, [root.clone(), first.clone(), third.clone(), side.clone()].into());
        let ranges = repo
            .log(&LogQuery {
                ranges: vec![format!("{root}..{first}"), format!("{second}..{third}")],
                order,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            ranges.iter().map(|c| c.id.clone()).collect::<std::collections::HashSet<_>>(),
            [first.clone(), third.clone()].into()
        );
        let positions: std::collections::HashMap<_, _> =
            log.iter().enumerate().map(|(i, c)| (c.id.as_str(), i)).collect();
        for (i, c) in log.iter().enumerate() {
            for p in c.graph_parents.as_ref().unwrap() {
                assert!(positions.get(p.as_str()).is_none_or(|p| *p > i));
            }
        }
    }
}

#[test]
fn lazy_summaries_seek_and_index_survive_refresh_and_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let mut ids = Vec::new();
    for i in 0..70 {
        ids.push(commit(dir, "a", &format!("summary {i}\n\nneedle body {i}")));
    }
    let cache = tempfile::tempdir().unwrap();
    let repo = Repo::discover(dir).unwrap().unwrap();
    repo.enable_log_index(cache.path());
    let query = LogQuery { summary_only: true, limit: 5, ..Default::default() };
    let page = repo.log(&query).unwrap();
    assert_eq!(page[0].message, "summary 69");
    assert!(page[0].message_truncated);
    assert_eq!(page[0].log_position, Some(0));
    assert_eq!(page[0].log_total, Some(70));
    let window = repo.log(&LogQuery { seek: Some(ids[5].clone()), limit: 20, ..query.clone() }).unwrap();
    assert!(window.iter().any(|c| c.id == ids[5]));
    assert!(window[0].log_position.unwrap() > 0);
    let prefix_window =
        repo.log(&LogQuery { seek: Some(ids[5][..8].to_string()), limit: 20, ..query.clone() }).unwrap();
    assert!(prefix_window.iter().any(|c| c.id == ids[5]));
    let single = repo.log(&LogQuery { branch: Some(ids[5].clone()), skip: 0, limit: 1, ..Default::default() }).unwrap();
    assert_eq!(single.len(), 1);
    assert_eq!(single[0].id, ids[5]);
    assert_eq!(single[0].message, "summary 5\n\nneedle body 5");
    assert!(!single[0].message_truncated);
    assert_eq!(single[0].on_current_branch, Some(true));
    assert!(repo.log(&LogQuery { request: Some(ide_core::RequestId(1)), ..query.clone() }).is_ok());
    let cancel = ide_core::CancellationToken::new();
    cancel.cancel();
    assert!(repo.log_cancellable(&query, &cancel).is_err());
    assert_eq!(repo.log(&LogQuery { text: Some("needle body 5".into()), ..query.clone() }).unwrap().len(), 5);
    let new = commit(dir, "b", "new head");
    let refreshed = repo.log(&LogQuery { retain_until: Some(ids[0].clone()), ..query.clone() }).unwrap();
    assert_eq!(refreshed[0].id, new);
    assert_eq!(refreshed.len(), 71);
    drop(repo);
    let repo = Repo::discover(dir).unwrap().unwrap();
    repo.enable_log_index(cache.path());
    let hit = repo.log(&LogQuery { text: Some("needle body 69".into()), ..query }).unwrap();
    assert_eq!(hit[0].id, ids[69]);
    assert_eq!(repo.log_details(&ids[69]).unwrap().message, "summary 69\n\nneedle body 69");
    assert_eq!(repo.log_details(&ids[69]).unwrap().signature, "N");
    git(dir, &["checkout", "-qb", "side", &ids[0]]);
    let side = commit(dir, "side.txt", "side commit");
    git(dir, &["checkout", "-q", "main"]);
    let fresh_repo = Repo::discover(dir).unwrap().unwrap();
    let off_branch = fresh_repo.log(&LogQuery { branch: Some(side), skip: 0, limit: 1, ..Default::default() }).unwrap();
    assert_eq!(off_branch[0].on_current_branch, Some(false));
    let on_branch =
        fresh_repo.log(&LogQuery { branch: Some(ids[5].clone()), skip: 0, limit: 1, ..Default::default() }).unwrap();
    assert_eq!(on_branch[0].on_current_branch, Some(true));
}

#[test]
fn containing_branches_exclude_symbolic_aliases_but_keep_direct_head_names() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let tip = commit(dir, "a", "tip");
    git(dir, &["branch", "topic/HEAD"]);
    for remote in ["origin", "contributor-742", "issue-739", "issue-765"] {
        let main = format!("refs/remotes/{remote}/main");
        git(dir, &["update-ref", &main, &tip]);
        git(dir, &["symbolic-ref", &format!("refs/remotes/{remote}/HEAD"), &main]);
        git(dir, &["symbolic-ref", &format!("refs/remotes/{remote}/alias"), &main]);
    }
    git(dir, &["update-ref", "refs/remotes/origin/topic/HEAD", &tip]);
    git(dir, &["symbolic-ref", "refs/heads/local-alias", "refs/heads/main"]);
    let repo = Repo::discover(dir).unwrap().unwrap();
    let expected = [
        "contributor-742/main",
        "issue-739/main",
        "issue-765/main",
        "main",
        "origin/main",
        "origin/topic/HEAD",
        "topic/HEAD",
    ];
    let mut branches = repo.log_details(&tip).unwrap().containing_branches;
    branches.sort();
    assert_eq!(branches, expected);
    let mut listed: Vec<_> = repo.branches().unwrap().into_iter().map(|b| b.name).collect();
    listed.sort();
    assert_eq!(listed, expected);
    let log = repo.log(&LogQuery::default()).unwrap();
    let mut labels: Vec<_> = log[0].refs.iter().filter(|r| *r != "HEAD").cloned().collect();
    labels.sort();
    assert_eq!(labels, expected);
}

#[test]
fn followed_history_carries_the_filename_at_each_revision() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let first = commit(dir, "old.txt", "original");
    git(dir, &["mv", "old.txt", "new.txt"]);
    git(dir, &["commit", "-qm", "rename"]);
    let renamed = git(dir, &["rev-parse", "HEAD"]);
    let tip = commit(dir, "new.txt", "latest");
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo.log(&LogQuery { path: Some("new.txt".into()), follow: true, ..Default::default() }).unwrap();
    assert_eq!(
        log.iter().map(|c| (c.id.as_str(), c.history_path.as_deref())).collect::<Vec<_>>(),
        vec![(tip.as_str(), Some("new.txt")), (renamed.as_str(), Some("new.txt")), (first.as_str(), Some("old.txt"))]
    );
    assert_eq!(repo.revision_children(&first, "").unwrap(), vec!["old.txt"]);
}

#[test]
fn detail_filters_connect_visible_ancestors_without_changing_revision_parents() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let a = commit(dir, "a", "keep root");
    commit(dir, "b", "hidden middle");
    git(dir, &["commit", "--amend", "--no-edit", "--author=Other <other@example.com>"]);
    let b = git(dir, &["rev-parse", "HEAD"]);
    let c = commit(dir, "a", "keep tip");
    let repo = Repo::discover(dir).unwrap().unwrap();
    for q in [
        LogQuery { text: Some("keep".into()), ..Default::default() },
        LogQuery { path: Some("a".into()), ..Default::default() },
        LogQuery { authors: vec!["Test".into()], authors_exact: true, ..Default::default() },
    ] {
        let page = repo.log(&LogQuery { limit: 1, ..q.clone() }).unwrap();
        assert_eq!(page[0].id, c);
        assert_eq!(page[0].parents, vec![b.clone()]);
        assert_eq!(page[0].graph_parents, Some(vec![a.clone()]));
        assert_eq!(page[0].graph_dashed, vec![true]);
        assert_eq!(page[0].on_current_branch, Some(true));
        let next = repo.log(&LogQuery { skip: 1, limit: 1, ..q }).unwrap();
        assert_eq!(next[0].id, a);
        assert_eq!(next[0].graph_parents, Some(vec![]));
    }
}

#[test]
fn all_history_includes_commits_reachable_only_from_tags() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let root = commit(dir, "a", "root");
    let tip = commit(dir, "a", "tagged tip");
    git(dir, &["tag", "v1"]);
    git(dir, &["reset", "--hard", &root]);
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo.log(&LogQuery::default()).unwrap();
    let tagged = log.iter().find(|c| c.id == tip).unwrap();
    assert!(tagged.refs.contains(&"tag: v1".into()));
    assert_eq!(tagged.on_current_branch, Some(false));
}

#[test]
fn projection_does_not_truncate_long_hidden_chains() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let mut stream = String::new();
    for i in 0..4100 {
        let message = if i == 0 || i == 4099 { "keep" } else { "hide" };
        stream.push_str(&format!(
            "commit refs/heads/main\ncommitter Test <test@example.com> {} +0000\ndata {}\n{}\n\n",
            1000 + i,
            message.len(),
            message
        ));
    }
    let mut child = Command::new("git")
        .current_dir(dir)
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stream.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo.log(&LogQuery { text: Some("keep".into()), ..Default::default() }).unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].graph_parents, Some(vec![log[1].id.clone()]));
}

#[test]
fn path_and_shallow_history_remain_topological_with_clock_skew() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source");
    std::fs::create_dir(&source).unwrap();
    git(&source, &["init", "-q"]);
    let make = |message: &str, parent: Option<&str>, time: &str| {
        std::fs::write(source.join("a.txt"), message).unwrap();
        git(&source, &["add", "a.txt"]);
        let tree = git(&source, &["write-tree"]);
        let mut cmd = Command::new("git");
        cmd.current_dir(&source).args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=t@example.com",
            "commit-tree",
            &tree,
            "-m",
            message,
        ]);
        if let Some(p) = parent {
            cmd.args(["-p", p]);
        }
        let out = cmd.env("GIT_AUTHOR_DATE", time).env("GIT_COMMITTER_DATE", time).output().unwrap();
        assert!(out.status.success());
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    };
    let root = make("root", None, "@5000 +0000");
    let left = make("left", Some(&root), "@1000 +0000");
    let right = make("right", Some(&root), "@2000 +0000");
    git(&source, &["update-ref", "refs/heads/main", &left]);
    git(&source, &["update-ref", "refs/heads/side", &right]);
    let shallow = tmp.path().join("shallow");
    git(
        tmp.path(),
        &[
            "clone",
            "-q",
            "--depth=2",
            "--no-single-branch",
            &format!("file://{}", source.display()),
            shallow.to_str().unwrap(),
        ],
    );
    for dir in [&source, &shallow] {
        let repo = Repo::discover(dir).unwrap().unwrap();
        for order in [LogOrder::Date, LogOrder::Topo, LogOrder::Standard] {
            let log = repo.log(&LogQuery { order, path: Some("a.txt".into()), ..Default::default() }).unwrap();
            assert_eq!(log.len(), 3);
            let positions: std::collections::HashMap<_, _> =
                log.iter().enumerate().map(|(i, c)| (c.id.as_str(), i)).collect();
            for (i, c) in log.iter().enumerate() {
                for parent in c.graph_parents.as_ref().unwrap() {
                    assert!(positions.get(parent.as_str()).is_none_or(|p| *p > i));
                }
            }
        }
    }
}

#[test]
fn multiple_paths_exact_authors_patterns_and_rename_history() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let root = commit(dir, "old.txt", "root");
    git(dir, &["mv", "old.txt", "new.txt"]);
    git(dir, &["commit", "-qm", "rename"]);
    let rename = git(dir, &["rev-parse", "HEAD"]);
    let tip = commit(dir, "other.txt", "another file");
    git(dir, &["branch", "feature/log"]);
    git(dir, &["branch", "feature/skip", &root]);
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo.log(&LogQuery { paths: vec!["new.txt".into(), "other.txt".into()], ..Default::default() }).unwrap();
    assert_eq!(log.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), vec![tip.clone(), rename.clone()]);
    let log = repo.log(&LogQuery { path: Some("new.txt".into()), follow: true, ..Default::default() }).unwrap();
    assert_eq!(log.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), vec![rename, root.clone()]);
    let log = repo
        .log(&LogQuery { branches: vec!["feature/.*".into(), "-feature/skip".into()], ..Default::default() })
        .unwrap();
    assert_eq!(log[0].id, tip);
    std::fs::write(dir.join("other.txt"), "different author").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["-c", "user.name=Test User", "-c", "user.email=other@example.com", "commit", "-qm", "different author"]);
    let log = repo.log(&LogQuery { authors: vec!["Test".into()], authors_exact: true, ..Default::default() }).unwrap();
    assert_eq!(log.len(), 3);
    assert!(log.iter().all(|c| c.author == "Test"));
    assert!(repo.log_users().unwrap().contains(&"Test User <other@example.com>".to_string()));
}

#[test]
fn metadata_and_path_cache_survive_restart_without_caching_refs_or_filters() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    std::fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    let first = commit(&dir, "a", "first\n\nComplete commit body");
    git(&dir, &["tag", "v1"]);
    git(&dir, &["tag", "-a", "annotated", "-m", "release"]);
    let cache = tmp.path().join("cache");
    {
        let repo = Repo::discover(&dir).unwrap().unwrap();
        repo.enable_log_index(&cache);
        let log = repo.log(&LogQuery { path: Some("a".into()), summary_only: true, ..Default::default() }).unwrap();
        assert!(log[0].message_truncated);
        assert_eq!(log[0].message, "first");
        assert_eq!(repo.log_details(&first).unwrap().message, "first\n\nComplete commit body");
        let details = repo.log_details("annotated").unwrap();
        assert_eq!(details.message, "first\n\nComplete commit body");
        assert_eq!(details.signature, "N");
        assert!(details.containing_branches.contains(&"main".to_string()));
        assert_eq!(repo.revision_files(&first).unwrap(), vec!["a"]);
    }
    let second = commit(&dir, "a", "second");
    git(&dir, &["tag", "-f", "v1"]);
    let repo = Repo::discover(&dir).unwrap().unwrap();
    repo.enable_log_index(&cache);
    let log = repo.log(&LogQuery { path: Some("a".into()), ..Default::default() }).unwrap();
    assert_eq!(log[0].id, second);
    assert!(log[0].refs.contains(&"tag: v1".into()));
    assert!(!log[1].refs.contains(&"tag: v1".into()));
    assert!(log[1].message.contains("Complete commit body"));
    assert!(!log[1].message_truncated);
}

#[test]
fn cancelled_query_does_not_publish_a_partial_page() {
    let tmp = tempfile::tempdir().unwrap();
    git(tmp.path(), &["init", "-q"]);
    commit(tmp.path(), "a", "root");
    let repo = Repo::discover(tmp.path()).unwrap().unwrap();
    let cancel = ide_core::CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        repo.log_cancellable(&LogQuery::default(), &cancel).unwrap_err().kind,
        ide_core::error::ErrorKind::Cancelled
    );
}

#[test]
fn shallow_boundaries_do_not_reconnect_to_locally_present_ancestors() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let root = commit(dir, "a", "keep root");
    let boundary = commit(dir, "a", "hidden boundary");
    let tip = commit(dir, "a", "keep tip");
    git(dir, &["tag", "root", &root]);
    std::fs::write(dir.join(".git/shallow"), format!("{boundary}\n")).unwrap();
    let repo = Repo::discover(dir).unwrap().unwrap();
    for order in [LogOrder::Date, LogOrder::Topo, LogOrder::Standard] {
        for text in [None, Some("keep".to_string())] {
            let log = repo.log(&LogQuery { order, text, path: Some("a".into()), ..Default::default() }).unwrap();
            let boundary_row = log.iter().find(|c| c.id == boundary);
            if let Some(row) = boundary_row {
                assert_eq!(row.parents, vec![root.clone()]);
                assert_eq!(row.graph_parents, Some(vec![]));
            } else {
                assert_eq!(log.iter().find(|c| c.id == tip).unwrap().graph_parents, Some(vec![]));
            }
        }
    }
}

#[test]
fn exact_branch_exclusions_treat_punctuation_literally() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let root = commit(dir, "a", "root");
    git(dir, &["branch", "release/1.0"]);
    let tip = commit(dir, "a", "tip");
    git(dir, &["branch", "release/1x0"]);
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo
        .log(&LogQuery { branches: vec!["release/.*".into(), "-release/1.0".into()], ..Default::default() })
        .unwrap();
    assert_eq!(log.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec![tip.as_str(), root.as_str()]);
}

#[test]
fn mode_only_changes_appear_in_path_history() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let root = commit(dir, "script", "root");
    git(dir, &["update-index", "--chmod=+x", "script"]);
    git(dir, &["commit", "-qm", "make executable"]);
    let tip = git(dir, &["rev-parse", "HEAD"]);
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo.log(&LogQuery { path: Some("script".into()), ..Default::default() }).unwrap();
    assert_eq!(log.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec![tip.as_str(), root.as_str()]);
}

#[test]
fn multiple_paths_are_simplified_together_at_merges() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    commit(dir, "a", "a0");
    commit(dir, "b", "b0");
    git(dir, &["branch", "side"]);
    commit(dir, "a", "left");
    git(dir, &["checkout", "side"]);
    commit(dir, "b", "right");
    git(dir, &["checkout", "main"]);
    git(dir, &["merge", "--no-ff", "side", "-m", "merge both paths"]);
    let repo = Repo::discover(dir).unwrap().unwrap();
    let expected = git(dir, &["log", "--topo-order", "--format=%H", "--", "a", "b"]);
    for order in [LogOrder::Topo, LogOrder::Date, LogOrder::Standard] {
        let log = repo
            .log(&LogQuery {
                branch: Some("HEAD".into()),
                paths: vec!["a".into(), "b".into()],
                order,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(log[0].summary, "merge both paths");
        assert_eq!(
            log.iter().map(|c| c.id.as_str()).collect::<std::collections::HashSet<_>>(),
            expected.lines().collect()
        );
        assert_eq!(log[0].parents.len(), 2);
        assert_eq!(log[0].graph_parents.as_ref().unwrap().len(), 2);
    }
}

#[test]
fn paths_are_literal_and_text_matches_bodies_or_hash_prefixes() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let star = commit(dir, "[a]", "star\n\nBody Needle");
    let plain = commit(dir, "a", "plain");
    let repo = Repo::discover(dir).unwrap().unwrap();
    let ids = |q: LogQuery| repo.log(&q).unwrap().into_iter().map(|c| c.id).collect::<Vec<_>>();
    assert_eq!(ids(LogQuery { path: Some("[a]".into()), ..Default::default() }), vec![star.clone()]);
    assert_eq!(ids(LogQuery { text: Some("body needle".into()), ..Default::default() }), vec![star.clone()]);
    assert!(ids(LogQuery { text: Some("body needle".into()), text_match_case: true, ..Default::default() }).is_empty());
    assert_eq!(ids(LogQuery { text: Some(plain[..7].to_uppercase()), ..Default::default() }), vec![plain]);
}

#[test]
fn case_insensitive_text_folds_non_ascii() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let hit = commit(dir, "a", "Ärger ПРИВЕТ");
    commit(dir, "a", "other");
    let repo = Repo::discover(dir).unwrap().unwrap();
    let ids = |q: LogQuery| repo.log(&q).unwrap().into_iter().map(|c| c.id).collect::<Vec<_>>();
    assert_eq!(ids(LogQuery { text: Some("ärger привет".into()), ..Default::default() }), vec![hit.clone()]);
    assert!(ids(LogQuery { text: Some("ärger".into()), text_match_case: true, ..Default::default() }).is_empty());
}

/// File history (Show History of a file) as (subject, path at that revision), newest first.
fn file_history(dir: &Path, path: &str) -> Vec<(String, String)> {
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo.log(&LogQuery { path: Some(path.into()), follow: true, ..Default::default() }).unwrap();
    log.into_iter().map(|c| (c.summary, c.history_path.unwrap_or_default())).collect()
}

fn history_repo() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    git(&dir, &["init", "-q"]);
    (tmp, dir)
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

#[test]
fn file_history_goes_through_a_rename_on_a_merged_branch() {
    let (_tmp, dir) = history_repo();
    commit(&dir, "file.txt", "Created");
    git(&dir, &["switch", "-qc", "feature"]);
    git(&dir, &["mv", "file.txt", "renamed.txt"]);
    git(&dir, &["commit", "-qm", "Renamed"]);
    git(&dir, &["switch", "-q", "main"]);
    commit(&dir, "other.txt", "Unrelated");
    git(&dir, &["merge", "-q", "--no-ff", "-m", "Merged", "feature"]);
    commit(&dir, "renamed.txt", "Modified");
    let history = file_history(&dir, "renamed.txt");
    assert_eq!(history, pairs(&[("Modified", "renamed.txt"), ("Renamed", "renamed.txt"), ("Created", "file.txt")]));
}

#[test]
fn file_history_goes_through_a_rename_done_in_a_merge_commit() {
    let (_tmp, dir) = history_repo();
    commit(&dir, "file.txt", "Created");
    git(&dir, &["switch", "-qc", "feature"]);
    commit(&dir, "side.txt", "Side");
    git(&dir, &["switch", "-q", "main"]);
    git(&dir, &["merge", "-q", "--no-ff", "--no-commit", "feature"]);
    git(&dir, &["mv", "file.txt", "renamed.txt"]);
    git(&dir, &["commit", "-qm", "Merge with rename"]);
    let history = file_history(&dir, "renamed.txt");
    assert_eq!(history, pairs(&[("Merge with rename", "renamed.txt"), ("Created", "file.txt")]));
}

#[test]
fn file_history_shows_merges_that_change_the_file_but_not_trivial_ones() {
    let (_tmp, dir) = history_repo();
    std::fs::write(dir.join("file.txt"), "one\ntwo\nthree\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "Created"]);
    git(&dir, &["switch", "-qc", "feature"]);
    std::fs::write(dir.join("file.txt"), "one\ntwo\nthree\nfeature\n").unwrap();
    git(&dir, &["commit", "-qam", "Feature"]);
    git(&dir, &["switch", "-q", "main"]);
    commit(&dir, "other.txt", "Other");
    git(&dir, &["merge", "-q", "--no-ff", "-m", "Trivial merge", "feature"]);
    assert_eq!(
        file_history(&dir, "file.txt").into_iter().map(|(s, _)| s).collect::<Vec<_>>(),
        vec!["Feature", "Created"]
    );

    git(&dir, &["switch", "-qc", "second", "HEAD~1"]);
    std::fs::write(dir.join("file.txt"), "zero\none\ntwo\nthree\n").unwrap();
    git(&dir, &["commit", "-qam", "Second"]);
    git(&dir, &["switch", "-q", "main"]);
    git(&dir, &["merge", "-q", "--no-ff", "--no-commit", "second"]);
    std::fs::write(dir.join("file.txt"), "zero\none\ntwo\nthree\nfeature\nresolved\n").unwrap();
    git(&dir, &["commit", "-qam", "Non-trivial merge"]);
    let subjects: Vec<String> = file_history(&dir, "file.txt").into_iter().map(|(s, _)| s).collect();
    assert_eq!(subjects[0], "Non-trivial merge");
    assert!(subjects.contains(&"Second".to_string()) && subjects.contains(&"Feature".to_string()));
}

#[test]
fn file_history_through_a_monorepo_merge_keeps_each_side() {
    let (_tmp, dir) = history_repo();
    commit(&dir, "file1.txt", "Created file1");
    git(&dir, &["switch", "-q", "--orphan", "repo2"]);
    commit(&dir, "file2.txt", "Created file2");
    git(&dir, &["switch", "-q", "main"]);
    git(&dir, &["merge", "-q", "--no-commit", "--allow-unrelated-histories", "repo2"]);
    std::fs::create_dir_all(dir.join("repo1")).unwrap();
    std::fs::create_dir_all(dir.join("repo2")).unwrap();
    git(&dir, &["mv", "file1.txt", "repo1/file1.txt"]);
    git(&dir, &["mv", "file2.txt", "repo2/file2.txt"]);
    git(&dir, &["commit", "-qm", "monorepo merge"]);
    assert_eq!(
        file_history(&dir, "repo1/file1.txt"),
        pairs(&[("monorepo merge", "repo1/file1.txt"), ("Created file1", "file1.txt")])
    );
    assert_eq!(
        file_history(&dir, "repo2/file2.txt"),
        pairs(&[("monorepo merge", "repo2/file2.txt"), ("Created file2", "file2.txt")])
    );
}

#[test]
fn file_history_through_parallel_renames_names_the_path_of_each_revision() {
    let (_tmp, dir) = history_repo();
    std::fs::write(dir.join("file.txt"), "base\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "Created"]);
    git(&dir, &["switch", "-qc", "other"]);
    std::fs::write(dir.join("file.txt"), "base\nother\n").unwrap();
    git(&dir, &["commit", "-qam", "Modified on other"]);
    git(&dir, &["mv", "file.txt", "renamed.txt"]);
    git(&dir, &["commit", "-qm", "Renamed on other"]);
    git(&dir, &["switch", "-q", "main"]);
    std::fs::write(dir.join("file.txt"), "main\nbase\n").unwrap();
    git(&dir, &["commit", "-qam", "Modified on main"]);
    git(&dir, &["mv", "file.txt", "renamed.txt"]);
    git(&dir, &["commit", "-qm", "Renamed on main"]);
    // Both sides changed the file: the merge stops for the resolution.
    let _ = Command::new("git").current_dir(&dir).args(["merge", "-q", "--no-ff", "--no-commit", "other"]).output();
    std::fs::write(dir.join("renamed.txt"), "main\nbase\nother\nmerged\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "Merged other"]);
    let mut history = file_history(&dir, "renamed.txt");
    history.sort();
    assert_eq!(
        history,
        pairs(&[
            ("Created", "file.txt"),
            ("Merged other", "renamed.txt"),
            ("Modified on main", "file.txt"),
            ("Modified on other", "file.txt"),
            ("Renamed on main", "renamed.txt"),
            ("Renamed on other", "renamed.txt"),
        ])
    );
}

#[test]
fn file_history_through_a_cyclic_rename() {
    let (_tmp, dir) = history_repo();
    commit(&dir, "a.txt", "Created a");
    git(&dir, &["mv", "a.txt", "b.txt"]);
    git(&dir, &["commit", "-qm", "a to b"]);
    commit(&dir, "b.txt", "Modified b");
    git(&dir, &["mv", "b.txt", "a.txt"]);
    git(&dir, &["commit", "-qm", "b to a"]);
    assert_eq!(
        file_history(&dir, "a.txt"),
        pairs(&[("b to a", "a.txt"), ("Modified b", "b.txt"), ("a to b", "b.txt"), ("Created a", "a.txt")])
    );
}

/// One commit per file under `dir/`, made with fast-import so hundreds stay quick.
fn commit_files(repo_dir: &Path, count: usize, name: impl Fn(usize) -> String) {
    let mut stream = String::new();
    for i in 0..count {
        let path = name(i);
        stream.push_str(&format!(
            "commit refs/heads/main\ncommitter T <t@example.com> {} +0000\ndata 3\nc{}\n",
            1_700_000_000 + i,
            i % 10
        ));
        stream.push_str(&format!("M 100644 inline {path}\ndata 1\nx\n\n"));
    }
    let mut child = Command::new("git")
        .current_dir(repo_dir)
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stream.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
    git(repo_dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(repo_dir, &["reset", "-q", "--hard"]);
}

#[test]
fn followed_directory_history_survives_hundreds_of_created_files() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    // Every created file adds a `^<sha>^@` exclusion: ~800 of them passed as arguments exceed
    // Windows' command-line limit (os error 206).
    commit_files(dir, 800, |i| format!("module/src/main/java/com/example/generated/Class{i:04}.java"));
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo.log(&LogQuery { path: Some("module".into()), follow: true, ..Default::default() }).unwrap();
    assert_eq!(log.len(), 800);
}

#[test]
fn many_selected_paths_filter_history_without_a_huge_command_line() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    commit_files(dir, 600, |i| format!("module/src/main/java/com/example/generated/Class{i:04}.java"));
    let repo = Repo::discover(dir).unwrap().unwrap();
    let paths: Vec<String> =
        (0..500).map(|i| format!("module/src/main/java/com/example/generated/Class{i:04}.java")).collect();
    let paths = paths.into_iter().map(Into::into).collect();
    let log = repo.log(&LogQuery { paths, text: Some("c3".into()), ..Default::default() }).unwrap();
    assert_eq!(log.len(), 50);
}

/// One commit per revision of a single file, plus one lightweight tag per commit, made
/// with fast-import and `update-ref --stdin` so hundreds stay quick.
fn commit_one_file_with_a_tag_per_commit(repo_dir: &Path, count: usize, file: &str) {
    let mut stream = String::new();
    for i in 0..count {
        stream.push_str(&format!(
            "commit refs/heads/main\ncommitter T <t@example.com> {} +0000\ndata 3\nc{}\n",
            1_700_000_000 + i,
            i % 10
        ));
        let content = format!("x{i}");
        stream.push_str(&format!("M 100644 inline {file}\ndata {}\n{content}\n\n", content.len()));
    }
    let mut child = Command::new("git")
        .current_dir(repo_dir)
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stream.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
    git(repo_dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(repo_dir, &["reset", "-q", "--hard"]);
    let log = git(repo_dir, &["log", "--reverse", "--format=%H"]);
    let mut input = String::new();
    for (i, sha) in log.lines().take(count).enumerate() {
        input.push_str(&format!("update refs/tags/t{i:04} {sha}\n"));
    }
    let mut child = Command::new("git")
        .current_dir(repo_dir)
        .args(["update-ref", "--stdin"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
}

#[test]
fn many_branch_tips_with_a_path_filter_stay_off_the_command_line() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let file = "module/src/main/java/com/example/Big.java";
    commit_one_file_with_a_tag_per_commit(dir, 800, file);
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo.log(&LogQuery { path: Some(file.into()), ..Default::default() }).unwrap();
    assert_eq!(log.len(), 800);
}

#[test]
fn followed_file_history_with_many_branch_tips_stays_off_the_command_line() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    let file = "module/src/main/java/com/example/Big.java";
    commit_one_file_with_a_tag_per_commit(dir, 800, file);
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo.log(&LogQuery { path: Some(file.into()), follow: true, ..Default::default() }).unwrap();
    assert_eq!(log.len(), 800);
    assert!(log.iter().all(|c| c.history_path.as_deref() == Some(file)));
}

#[test]
fn followed_file_history_survives_a_long_path() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    git(dir, &["config", "core.longpaths", "true"]);
    let mut path = String::from("src");
    while path.len() < 260 {
        path.push_str("/deep-history-directory-segment");
    }
    let file = format!("{path}/DeepHistory.java");
    std::fs::create_dir_all(dir.join(&path)).unwrap();
    let first = commit(dir, &file, "first");
    let second = commit(dir, &file, "second");
    let repo = Repo::discover(dir).unwrap().unwrap();
    let log = repo.log(&LogQuery { path: Some(file.clone().into()), follow: true, ..Default::default() }).unwrap();
    let ids: std::collections::HashSet<_> = log.iter().map(|c| c.id.clone()).collect();
    assert_eq!(ids, [first, second].into());
    assert!(log.iter().all(|c| c.history_path.as_deref() == Some(file.as_str())));
}

#[test]
fn many_tips_preserve_cancellable_shallow_and_range_walks() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    commit_one_file_with_a_tag_per_commit(dir, 200, "file.txt");
    let expected = git(dir, &["rev-list", "--topo-order", "HEAD"]);
    let expected: Vec<_> = expected.lines().map(str::to_string).collect();
    let range = format!("{} ^{}", expected[0], expected[50]);
    for shallow in [false, true] {
        if shallow {
            std::fs::write(dir.join(".git/shallow"), format!("{}\n", expected[100])).unwrap();
        }
        let repo = Repo::discover(dir).unwrap().unwrap();
        for order in [LogOrder::Topo, LogOrder::Date, LogOrder::Standard] {
            for first_parent in [false, true] {
                let query = LogQuery { order, first_parent, ..Default::default() };
                let log = repo.log(&LogQuery { request: Some(ide_core::RequestId(1)), ..query.clone() }).unwrap();
                assert_eq!(log.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), expected);
                if shallow {
                    let boundary = log.iter().find(|c| c.id == expected[100]).unwrap();
                    assert_eq!(boundary.graph_parents, Some(vec![]));
                }
                let mixed = repo
                    .log(&LogQuery { branches: expected.clone(), ranges: vec![range.clone()], ..query.clone() })
                    .unwrap();
                assert_eq!(mixed.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), expected);
                let long_range = format!("{} ^{}", vec![expected[0].as_str(); 200].join(" "), expected[50]);
                let ranged = repo.log(&LogQuery { range: Some(long_range), ..query }).unwrap();
                assert_eq!(ranged.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), expected[..50]);
            }
        }
    }
}

#[test]
fn many_tips_preserve_followed_renames_and_recreation_exclusions() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    commit_one_file_with_a_tag_per_commit(dir, 200, "old [literal] file.txt");
    git(dir, &["mv", "old [literal] file.txt", "renamed file.txt"]);
    git(dir, &["commit", "-qm", "renamed"]);
    let renamed = git(dir, &["rev-parse", "HEAD"]);
    git(dir, &["rm", "renamed file.txt"]);
    git(dir, &["commit", "-qm", "deleted"]);
    let recreated = commit(dir, "renamed file.txt", "recreated");
    let repo = Repo::discover(dir).unwrap().unwrap();
    for order in [LogOrder::Topo, LogOrder::Date, LogOrder::Standard] {
        for first_parent in [false, true] {
            let query = LogQuery {
                path: Some("renamed file.txt".into()),
                follow: true,
                order,
                first_parent,
                ..Default::default()
            };
            let log = repo.log(&query).unwrap();
            assert_eq!(log.len(), 1);
            assert_eq!(log[0].id, recreated);
            let query = LogQuery { range: Some(renamed.clone()), ..query };
            let small = repo.log(&query).unwrap();
            let large = repo.log(&LogQuery { range: Some(vec![renamed.as_str(); 200].join(" ")), ..query }).unwrap();
            assert_eq!(small.len(), 201);
            assert_eq!(
                large.iter().map(|c| (&c.id, &c.history_path, &c.graph_parents)).collect::<Vec<_>>(),
                small.iter().map(|c| (&c.id, &c.history_path, &c.graph_parents)).collect::<Vec<_>>()
            );
            assert_eq!(large[0].history_path.as_deref(), Some("renamed file.txt"));
            assert!(large[1..].iter().all(|c| c.history_path.as_deref() == Some("old [literal] file.txt")));
        }
    }
}
