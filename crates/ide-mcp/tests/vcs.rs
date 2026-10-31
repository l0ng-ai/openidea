//! Repositories and git status through the MCP tools (after JetBrains' `VcsToolsetTest`).

mod common;

use common::Harness;
use serde_json::{Value, json};
use std::path::Path;

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// A repository with a commit, then: a staged change, an unstaged change, a new staged
/// file, an untracked file and an ignored one.
async fn repo() -> Harness {
    let h = Harness::new(&[("a.txt", "a\n"), ("b.txt", "b\n"), (".gitignore", "*.log\n")]).await;
    let root = &h.root;
    git(root, &["init", "-q", "-b", "main"]);
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "init"]);
    std::fs::write(root.join("a.txt"), "a2\n").unwrap();
    git(root, &["add", "a.txt"]);
    std::fs::write(root.join("b.txt"), "b2\n").unwrap();
    std::fs::write(root.join("new.txt"), "n\n").unwrap();
    git(root, &["add", "new.txt"]);
    std::fs::write(root.join("untracked.txt"), "u\n").unwrap();
    std::fs::write(root.join("debug.log"), "l\n").unwrap();
    // Repositories are discovered when the project opens (and by the watcher); look again now.
    h.host().project("main").unwrap().refresh_repositories();
    h
}

fn entry<'a>(repo: &'a Value, path: &str) -> Option<&'a Value> {
    repo["entries"].as_array().unwrap().iter().find(|f| f["pathRelativeToRepository"] == path)
}

fn codes(repo: &Value, path: &str) -> Option<String> {
    entry(repo, path)
        .map(|e| format!("{}{}", e["indexStatus"].as_str().unwrap(), e["workTreeStatus"].as_str().unwrap()))
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_repositories() {
    let h = repo().await;
    let r = h.call_json("get_repositories", json!({})).await;
    let roots = r["roots"].as_array().unwrap();
    assert_eq!(roots.len(), 1, "{r}");
    assert_eq!(roots[0]["pathRelativeToProject"], "");
    assert_eq!(roots[0]["vcsName"], "Git");
    assert_eq!(roots[0]["branch"], "main");
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_porcelain_status_and_counters() {
    let h = repo().await;
    let r = h.call_json("git_status", json!({})).await;
    let repo = &r["repositories"][0];
    assert_eq!(repo["repositoryPathRelativeToProject"], "");
    assert_eq!(repo["currentBranch"], "main");
    assert_eq!(codes(repo, "a.txt").as_deref(), Some("M "), "{r}");
    assert_eq!(codes(repo, "b.txt").as_deref(), Some(" M"));
    assert_eq!(codes(repo, "new.txt").as_deref(), Some("A "));
    assert_eq!(codes(repo, "untracked.txt").as_deref(), Some("??"));
    assert_eq!(codes(repo, "debug.log"), None);
    assert_eq!(repo["isClean"], false);
    assert_eq!(repo["totalEntries"], 4);
    assert_eq!(repo["hasMoreEntries"], false);
    assert_eq!(
        [&repo["stagedCount"], &repo["unstagedCount"], &repo["untrackedCount"], &repo["ignoredCount"]],
        [2, 1, 1, 0]
    );
    assert_eq!(repo["conflictedCount"], 0);

    let r = h.call_json("git_status", json!({ "includeUntracked": false, "includeIgnored": true })).await;
    let repo = &r["repositories"][0];
    assert_eq!(codes(repo, "untracked.txt"), None);
    assert_eq!(codes(repo, "debug.log").as_deref(), Some("!!"), "{r}");
    assert_eq!(repo["ignoredCount"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn respects_limit_and_reports_renames() {
    let h = repo().await;
    git(&h.root, &["mv", "b.txt", "c.txt"]);
    let r = h.call_json("git_status", json!({ "limit": 2 })).await;
    let repo = &r["repositories"][0];
    assert_eq!(repo["entries"].as_array().unwrap().len(), 2);
    assert_eq!(repo["hasMoreEntries"], true);
    assert_eq!(repo["totalEntries"], 4);

    let r = h.call_json("git_status", json!({})).await;
    let renamed = entry(&r["repositories"][0], "c.txt").unwrap();
    assert_eq!(renamed["indexStatus"], "R", "{r}");
    assert_eq!(renamed["originalPathRelativeToRepository"], "b.txt");

    let e = h.call_err("git_status", json!({ "limit": 0 })).await;
    assert!(e.contains("limit must be > 0"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn filters_by_repository_path() {
    let h = repo().await;
    std::fs::create_dir_all(h.path("nested")).unwrap();
    std::fs::write(h.path("nested/n.txt"), "n\n").unwrap();
    git(&h.path("nested"), &["init", "-q", "-b", "dev"]);
    h.host().project("main").unwrap().refresh_repositories();

    let r = h.call_json("git_status", json!({ "repositoryPathRelativeToProject": "a.txt" })).await;
    let repos = r["repositories"].as_array().unwrap();
    assert_eq!(repos.len(), 1, "{r}");
    assert_eq!(repos[0]["repositoryPathRelativeToProject"], "");

    let r = h.call_json("git_status", json!({ "repositoryPathRelativeToProject": "nested/n.txt" })).await;
    let repo = &r["repositories"][0];
    assert_eq!(repo["repositoryPathRelativeToProject"], "nested", "{r}");
    assert_eq!(codes(repo, "n.txt").as_deref(), Some("??"));

    let r = h.call_json("git_status", json!({})).await;
    let paths: Vec<_> =
        r["repositories"].as_array().unwrap().iter().map(|r| r["repositoryPathRelativeToProject"].clone()).collect();
    assert_eq!(paths, ["", "nested"], "sorted by path: {r}");
}

#[tokio::test(flavor = "multi_thread")]
async fn status_without_git_is_empty() {
    let h = Harness::new(&[("a.txt", "a\n")]).await;
    let r = h.call_json("git_status", json!({})).await;
    assert_eq!(r["repositories"], json!([]));
    let e = h.call_err("git_status", json!({ "repositoryPathRelativeToProject": "a.txt" })).await;
    assert_eq!(e, "No git repository found for path: a.txt");
    let r = h.call_json("get_repositories", json!({})).await;
    assert_eq!(r["roots"], json!([]));
}
