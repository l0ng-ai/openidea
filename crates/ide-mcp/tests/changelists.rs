//! Change lists through the MCP tools (after JetBrains' `ChangeListToolsetTest`).

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

/// A committed repository; `src/Main.java` then modified, `new.txt` untracked.
async fn repo() -> Harness {
    let h = Harness::new(&[("src/Main.java", "class Main {}\n"), ("other.txt", "o\n")]).await;
    git(&h.root, &["init", "-q", "-b", "main"]);
    git(&h.root, &["add", "."]);
    git(&h.root, &["commit", "-q", "-m", "init"]);
    std::fs::write(h.path("src/Main.java"), "public class Main { }\n").unwrap();
    std::fs::write(h.path("new.txt"), "n\n").unwrap();
    h.host().project("main").unwrap().refresh_repositories();
    h
}

fn list<'a>(r: &'a Value, name: &str) -> &'a Value {
    r["changeLists"].as_array().unwrap().iter().find(|l| l["name"] == name).unwrap_or_else(|| panic!("{r}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn creates_and_activates_a_changelist() {
    let h = Harness::new(&[]).await;
    let r = h
        .call_json(
            "create_changelist",
            json!({ "name": "MCP Chat 1", "comment": "Changes made in chat 1", "activate": true }),
        )
        .await;
    assert_eq!(r["name"], "MCP Chat 1");
    assert!(r["id"].as_str().unwrap().starts_with("cl-"));
    assert_eq!(r["created"], true);
    assert_eq!(r["isActive"], true);
    assert_eq!(r["previousActiveChangeList"], "Changes");

    let r = h.call_json("get_changelists", json!({})).await;
    let created = list(&r, "MCP Chat 1");
    assert_eq!(created["isActive"], true);
    assert_eq!(created["comment"], "Changes made in chat 1");
    assert_eq!(created["changesCount"], 0);
    assert_eq!(list(&r, "Changes")["isActive"], false, "the former default changelist is still there");
    // The UI reads the same file.
    let state = ide_host::ops::vcs::vcs_changelists_load(h.host(), "main").unwrap();
    assert_eq!(state.lists.len(), 2);
    assert_eq!(state.active, created["id"].as_str().unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn returns_an_existing_changelist() {
    let h = Harness::new(&[]).await;
    let first = h.call_json("create_changelist", json!({ "name": "Shared list" })).await;
    assert_eq!(first["created"], true);
    assert_eq!(first["isActive"], false);
    let again = h.call_json("create_changelist", json!({ "name": "shared LIST" })).await;
    assert_eq!(again["created"], false);
    assert_eq!(again["id"], first["id"]);
    assert_eq!(again["name"], "Shared list");

    let e = h.call_err("create_changelist", json!({ "name": "   " })).await;
    assert!(e.contains("must not be blank"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn deletes_changelists_but_not_the_active_one() {
    let h = Harness::new(&[]).await;
    h.call_json("create_changelist", json!({ "name": "To delete" })).await;
    let r = h.call_json("delete_changelist", json!({ "name": "To delete" })).await;
    assert_eq!(r, json!({ "name": "To delete", "movedChangesCount": 0 }));
    let r = h.call_json("get_changelists", json!({})).await;
    assert_eq!(r["changeLists"].as_array().unwrap().len(), 1);
    let e = h.call_err("delete_changelist", json!({ "name": "To delete" })).await;
    assert!(e.contains("not found"), "{e}");

    h.call_json("create_changelist", json!({ "name": "Active list", "activate": true })).await;
    let e = h.call_err("delete_changelist", json!({ "name": "Active list" })).await;
    assert!(e.contains("Cannot delete the active changelist"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn switches_the_active_changelist() {
    let h = repo().await;
    let r = h.call_json("create_changelist", json!({ "name": "List A" })).await;
    assert_eq!(r["isActive"], false);

    let r = h.call_json("set_active_changelist", json!({ "name": "List A" })).await;
    assert_eq!(r["name"], "List A");
    assert_eq!(r["previousActiveChangeList"], "Changes");
    // The change made before the switch stays in the list that was active then.
    let r = h.call_json("get_changelists", json!({ "includeFiles": true })).await;
    assert_eq!(list(&r, "Changes")["files"], json!(["src/Main.java"]), "{r}");
    assert_eq!(list(&r, "List A")["changesCount"], 0);

    let r = h.call_json("set_active_changelist", json!({ "name": "List A" })).await;
    assert!(r.get("previousActiveChangeList").is_none(), "{r}");
    let r = h.call_json("set_active_changelist", json!({ "name": "Changes" })).await;
    assert_eq!(r["previousActiveChangeList"], "List A");
    let e = h.call_err("set_active_changelist", json!({ "name": "No such list" })).await;
    assert!(e.contains("not found"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn moves_pending_changes() {
    let h = repo().await;
    let e = h
        .call_err("move_changes_to_changelist", json!({ "files": ["other.txt", "new.txt"], "changeListName": "Task" }))
        .await;
    assert_eq!(e, "No pending changes found for: other.txt, new.txt");
    let e = h
        .call_err(
            "move_changes_to_changelist",
            json!({ "files": ["src/Main.java"], "changeListName": "Task", "createIfMissing": false }),
        )
        .await;
    assert!(e.contains("Pass createIfMissing=true"), "{e}");

    let r = h
        .call_json(
            "move_changes_to_changelist",
            json!({
                "files": ["src/Main.java", "other.txt"],
                "changeListName": "Task changes",
                "comment": "Changes of the current task",
            }),
        )
        .await;
    assert_eq!(r["changeListName"], "Task changes");
    assert_eq!(r["createdChangeList"], true);
    assert_eq!(r["movedFiles"], json!(["src/Main.java"]));
    assert_eq!(r["filesWithoutPendingChanges"], json!(["other.txt"]));

    let r = h.call_json("get_changelists", json!({ "includeFiles": true })).await;
    let target = list(&r, "Task changes");
    assert_eq!(target["isActive"], false, "moving does not change the active changelist");
    assert_eq!(target["changesCount"], 1);
    assert_eq!(target["files"], json!(["src/Main.java"]));
    assert_eq!(target["comment"], "Changes of the current task");

    let r = h.call_json("delete_changelist", json!({ "name": "Task changes" })).await;
    assert_eq!(r["movedChangesCount"], 1);
    assert_eq!(r["movedTo"], "Changes");
    let r = h.call_json("get_changelists", json!({ "includeFiles": true, "maxFilesPerChangelist": 1 })).await;
    assert_eq!(list(&r, "Changes")["files"], json!(["src/Main.java"]));
    let e = h.call_err("get_changelists", json!({ "maxFilesPerChangelist": 0 })).await;
    assert!(e.contains("must be > 0"), "{e}");
}
