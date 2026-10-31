//! Repositories and git status through the MCP tools.

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

fn status_of(files: &Value, path: &str) -> Option<String> {
    files.as_array().unwrap().iter().find(|f| f["path"] == path).map(|f| f["status"].as_str().unwrap().to_owned())
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_repositories() {
    let h = repo().await;
    let r = h.call_json("get_repositories", json!({})).await;
    let repos = r["repositories"].as_array().unwrap();
    assert_eq!(repos.len(), 1, "{r}");
    assert_eq!(repos[0]["path"], ".");
    assert_eq!(repos[0]["vcs"], "git");
    assert_eq!(repos[0]["branch"], "main");
    assert!(repos[0]["headCommit"].is_string());
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_porcelain_status_and_counters() {
    let h = repo().await;
    let r = h.call_json("git_status", json!({})).await;
    let repo = &r["repositories"][0];
    assert_eq!(repo["path"], ".");
    assert_eq!(repo["branch"], "main");
    let files = &repo["files"];
    assert_eq!(status_of(files, "a.txt").as_deref(), Some("M "), "{r}");
    assert_eq!(status_of(files, "b.txt").as_deref(), Some(" M"));
    assert_eq!(status_of(files, "new.txt").as_deref(), Some("A "));
    assert_eq!(status_of(files, "untracked.txt").as_deref(), Some("??"));
    assert_eq!(status_of(files, "debug.log"), None);
    assert_eq!(
        repo["summary"],
        json!({ "staged": 2, "unstaged": 1, "untracked": 1, "conflicted": 0, "ignored": 0, "clean": false })
    );

    let r = h.call_json("git_status", json!({ "includeUntracked": false, "includeIgnored": true })).await;
    let files = &r["repositories"][0]["files"];
    assert_eq!(status_of(files, "untracked.txt"), None);
    assert_eq!(status_of(files, "debug.log").as_deref(), Some("!!"), "{r}");
    assert_eq!(r["repositories"][0]["summary"]["ignored"], 1);

    let r = h.call_json("git_status", json!({ "limit": 2 })).await;
    assert_eq!(r["repositories"][0]["files"].as_array().unwrap().len(), 2);
    assert_eq!(r["repositories"][0]["truncated"], true);

    let r = h.call_json("git_status", json!({ "repositoryPathRelativeToProject": "." })).await;
    assert_eq!(r["repositories"].as_array().unwrap().len(), 1);
    let e = h.call_err("git_status", json!({ "repositoryPathRelativeToProject": "nope" })).await;
    assert!(e.contains("not a repository"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn status_without_git_is_an_error() {
    let h = Harness::new(&[("a.txt", "a\n")]).await;
    let e = h.call_err("git_status", json!({})).await;
    assert!(e.contains("not under git"), "{e}");
    let r = h.call_json("get_repositories", json!({})).await;
    assert_eq!(r["repositories"], json!([]));
}
