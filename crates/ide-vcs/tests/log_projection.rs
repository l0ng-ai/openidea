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
