//! The editing tools against a real project: files, patches through the
//! document layer, language-server tools without servers, editor requests.

mod common;

use common::Harness;
use ide_core::mcp::McpUiRequest;
use ide_core::{ChangeSet, TextChange as Change};
use serde_json::json;

fn read(h: &Harness, rel: &str) -> String {
    std::fs::read_to_string(h.path(rel)).unwrap()
}

/// No document stays open after a tool that opened one transiently.
fn assert_no_documents(h: &Harness) {
    let project = h.host().project("main").unwrap();
    assert!(project.documents.open_documents().is_empty(), "documents left open");
}

#[tokio::test(flavor = "multi_thread")]
async fn creates_files_and_refuses_to_clobber() {
    let h = Harness::new(&[("old.txt", "keep\n")]).await;
    let out = h.call("create_new_file", json!({ "pathInProject": "src/deep/new.rs", "text": "fn main() {}\n" })).await;
    assert_eq!(out, "Created src/deep/new.rs");
    assert_eq!(read(&h, "src/deep/new.rs"), "fn main() {}\n");

    let e = h.call_err("create_new_file", json!({ "pathInProject": "old.txt", "text": "x" })).await;
    assert!(e.contains("already exists") && e.contains("overwrite"), "{e}");
    assert_eq!(read(&h, "old.txt"), "keep\n");

    let out =
        h.call("create_new_file", json!({ "pathInProject": "old.txt", "text": "new\n", "overwrite": true })).await;
    assert_eq!(out, "Overwrote old.txt");
    assert_eq!(read(&h, "old.txt"), "new\n");

    h.call("create_new_file", json!({ "pathInProject": "empty.txt" })).await;
    assert_eq!(read(&h, "empty.txt"), "");
    assert_no_documents(&h);
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_paths_outside_the_project() {
    let h = Harness::new(&[("a.txt", "a\n")]).await;
    let outside = h.root.parent().unwrap().join("outside.txt");
    for path in ["../outside.txt", "src/../../outside.txt", outside.to_str().unwrap()] {
        let e = h.call_err("create_new_file", json!({ "pathInProject": path, "text": "x" })).await;
        assert!(e.contains("outside the project"), "{path}: {e}");
    }
    let e = h
        .call_err("apply_patch", json!({ "input": "*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch" }))
        .await;
    assert!(e.contains("outside the project"), "{e}");
    let e = h
        .call_err(
            "apply_patch",
            json!({ "input": "*** Begin Patch\n*** Update File: a.txt\n*** Move to: ../moved.txt\n*** End Patch" }),
        )
        .await;
    assert!(e.contains("outside the project"), "{e}");
    assert!(!outside.exists() && h.path("a.txt").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn applies_codex_patches() {
    let h = Harness::new(&[
        ("src/lib.rs", "fn a() {\n    1\n}\n\nfn b() {\n    2\n}\n"),
        ("gone.txt", "bye\n"),
        ("move/me.txt", "one\ntwo\n"),
    ])
    .await;
    let patch = "*** Begin Patch
*** Add File: docs/new.md
+# Title
+text
*** Delete File: gone.txt
*** Update File: src/lib.rs
@@ fn a() {
-    1
+    10
@@ fn b() {
-    2
+    20
*** Update File: move/me.txt
*** Move to: moved/me.txt
@@
 one
-two
+three
*** End Patch";
    let out = h.call("apply_patch", json!({ "input": patch })).await;
    assert_eq!(out, "Applied the patch:\nA docs/new.md\nD gone.txt\nM src/lib.rs\nR move/me.txt -> moved/me.txt");
    assert_eq!(read(&h, "docs/new.md"), "# Title\ntext\n");
    assert!(!h.path("gone.txt").exists());
    assert_eq!(read(&h, "src/lib.rs"), "fn a() {\n    10\n}\n\nfn b() {\n    20\n}\n");
    assert!(!h.path("move/me.txt").exists());
    assert_eq!(read(&h, "moved/me.txt"), "one\nthree\n");
    assert_no_documents(&h);

    // `patch` is an alias of `input`.
    h.call("apply_patch", json!({ "patch": "*** Begin Patch\n*** Delete File: docs/new.md\n*** End Patch" })).await;
    assert!(!h.path("docs/new.md").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn applies_git_diffs() {
    let h = Harness::new(&[("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n"), ("del.txt", "x\n"), ("ren.txt", "r\n")]).await;
    let diff = "diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 1
-2
+two
 3
@@ -7,3 +7,4 @@
 7
 8
+8.5
 9
diff --git a/n/new.txt b/n/new.txt
new file mode 100644
--- /dev/null
+++ b/n/new.txt
@@ -0,0 +1 @@
+fresh
diff --git a/del.txt b/del.txt
deleted file mode 100644
--- a/del.txt
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git a/ren.txt b/renamed.txt
similarity index 100%
rename from ren.txt
rename to renamed.txt
";
    let out = h.call("apply_patch", json!({ "input": diff })).await;
    assert_eq!(out, "Applied the patch:\nM a.txt\nA n/new.txt\nD del.txt\nR ren.txt -> renamed.txt");
    assert_eq!(read(&h, "a.txt"), "1\ntwo\n3\n4\n5\n6\n7\n8\n8.5\n9\n");
    assert_eq!(read(&h, "n/new.txt"), "fresh\n");
    assert!(!h.path("del.txt").exists() && !h.path("ren.txt").exists());
    assert_eq!(read(&h, "renamed.txt"), "r\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_diffs_with_different_names_patch_the_existing_file() {
    let h = Harness::new(&[("a.txt", "a\nb\n"), ("src/b.txt", "x\n")]).await;
    // `diff -u a.txt.orig a.txt`: the `+++` file exists, nothing moves.
    let diff = "--- a.txt.orig\t2024-01-01 10:00:00\n+++ a.txt\t2024-01-02 10:00:00\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n";
    let out = h.call("apply_patch", json!({ "input": diff })).await;
    assert_eq!(out, "Applied the patch:\nM a.txt");
    assert_eq!(read(&h, "a.txt"), "A\nb\n");
    assert!(!h.path("a.txt.orig").exists());
    // `diff -u a.txt a.txt.new`: only the `---` file exists.
    let diff = "--- a.txt\n+++ a.txt.new\n@@ -1 +1 @@\n-A\n+AA\n";
    let out = h.call("apply_patch", json!({ "input": diff })).await;
    assert_eq!(out, "Applied the patch:\nM a.txt");
    assert!(!h.path("a.txt.new").exists());
    // `diff -ru old/ new/` run outside the project: the names below the first directory.
    let diff = "diff -ru old/src/b.txt new/src/b.txt\n--- old/src/b.txt\n+++ new/src/b.txt\n@@ -1 +1 @@\n-x\n+y\n";
    let out = h.call("apply_patch", json!({ "input": diff })).await;
    assert_eq!(out, "Applied the patch:\nM src/b.txt");
    assert_eq!(read(&h, "src/b.txt"), "y\n");
    let e = h.call_err("apply_patch", json!({ "input": "--- p.txt\n+++ q.txt\n@@ -1 +1 @@\n-x\n+y\n" })).await;
    assert!(e.contains("cannot update q.txt (nor p.txt): no such file"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_crlf_line_endings() {
    let h = Harness::new(&[("win.txt", "alpha\r\nbeta\r\ngamma\r\n")]).await;
    let patch =
        "*** Begin Patch\r\n*** Update File: win.txt\r\n@@\r\n alpha\r\n-beta\r\n+BETA\r\n+delta\r\n*** End Patch\r\n";
    h.call("apply_patch", json!({ "input": patch })).await;
    assert_eq!(read(&h, "win.txt"), "alpha\r\nBETA\r\ndelta\r\ngamma\r\n");
    let diff = "--- a/win.txt\n+++ b/win.txt\n@@ -3,2 +3,2 @@\n delta\n-gamma\n+GAMMA\n";
    h.call("apply_patch", json!({ "input": diff })).await;
    assert_eq!(read(&h, "win.txt"), "alpha\r\nBETA\r\ndelta\r\nGAMMA\r\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_patch_changes_nothing() {
    let h = Harness::new(&[("a.txt", "one\ntwo\n"), ("b.txt", "three\nfour\n"), ("c.txt", "c\n")]).await;
    let patch = "*** Begin Patch
*** Add File: added.txt
+new
*** Delete File: c.txt
*** Update File: a.txt
-one
+ONE
*** Update File: b.txt
@@
 three
-five
+FIVE
*** End Patch";
    let e = h.call_err("apply_patch", json!({ "input": patch })).await;
    assert!(e.starts_with("b.txt: hunk 1 does not apply"), "{e}");
    assert!(e.contains("  three\n  five\n"), "{e}");
    assert!(e.contains("line 2 is `four`, but the patch expects `five`"), "{e}");
    assert_eq!(read(&h, "a.txt"), "one\ntwo\n");
    assert_eq!(read(&h, "b.txt"), "three\nfour\n");
    assert!(h.path("c.txt").exists() && !h.path("added.txt").exists());

    let e =
        h.call_err("apply_patch", json!({ "input": "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch" })).await;
    assert!(e.contains("already exists"), "{e}");
    let e = h
        .call_err("apply_patch", json!({ "input": "*** Begin Patch\n*** Delete File: nope.txt\n*** End Patch" }))
        .await;
    assert!(e.contains("no such file"), "{e}");
    let e = h.call_err("apply_patch", json!({ "input": "*** Begin Patch\n*** Update File: a.txt\n-one\n+1\n" })).await;
    assert!(e.contains("truncated"), "{e}");
    let e = h.call_err("apply_patch", json!({ "input": "hello" })).await;
    assert!(e.contains("not a patch"), "{e}");
    assert_eq!(read(&h, "a.txt"), "one\ntwo\n");
    assert_no_documents(&h);
}

#[tokio::test(flavor = "multi_thread")]
async fn patches_an_open_document_with_unsaved_changes() {
    let h = Harness::new(&[("open.txt", "first\nsecond\nthird\n")]).await;
    let host = h.host().clone();
    let info = ide_host::ops::doc::open(&host, "main", h.path("open.txt")).await.unwrap();
    // The user typed "!" after "first" without saving.
    let changes = ChangeSet { changes: vec![Change { from: 5, to: 5, insert: "!".into() }] };
    ide_host::ops::doc::edit(&host, "main", info.id, info.version, changes).unwrap();
    assert_eq!(read(&h, "open.txt"), "first\nsecond\nthird\n");

    let patch = "*** Begin Patch\n*** Update File: open.txt\n@@\n first!\n-second\n+SECOND\n*** End Patch";
    let out = h.call("apply_patch", json!({ "input": patch })).await;
    assert!(out.contains("M open.txt") && out.contains("had unsaved changes in the editor"), "{out}");
    assert_eq!(read(&h, "open.txt"), "first!\nSECOND\nthird\n");

    let project = host.project("main").unwrap();
    // Still open (the user's editor), with the patched text, saved.
    assert_eq!(project.documents.by_path(&h.path("open.txt")), Some(info.id));
    assert_eq!(project.documents.text_snapshot(info.id).unwrap().text, "first!\nSECOND\nthird\n");
    assert!(!project.documents.is_dirty(info.id).unwrap());

    // A patch written against the disk text mentions the editor's buffer when it does not match.
    let changes = ChangeSet { changes: vec![Change { from: 0, to: 0, insert: "0\n".into() }] };
    let v = project.documents.text_snapshot(info.id).unwrap().version;
    ide_host::ops::doc::edit(&host, "main", info.id, v, changes).unwrap();
    let patch = "*** Begin Patch\n*** Update File: open.txt\n@@\n-zero\n+0\n*** End Patch";
    let e = h.call_err("apply_patch", json!({ "input": patch })).await;
    assert!(e.contains("unsaved changes in the editor"), "{e}");
    ide_host::ops::doc::close(&host, "main", info.id).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn language_server_tools_fail_cleanly_without_servers() {
    let h = Harness::new(&[("notes.txt", "alpha beta\nbeta gamma\n")]).await;
    let e = h.call_err("reformat_file", json!({ "files": ["notes.txt"] })).await;
    assert!(e.starts_with("notes.txt: not formatted:"), "{e}");
    let e = h.call_err("reformat_file", json!({ "files": ["missing.txt", "../x.txt"] })).await;
    assert!(e.contains("missing.txt: not formatted: no such file") && e.contains("outside the project"), "{e}");
    let e = h.call_err("reformat_file", json!({ "files": [] })).await;
    assert!(e.contains("files"), "{e}");

    let e = h
        .call_err("rename_refactoring", json!({ "pathInProject": "notes.txt", "symbolName": "beta", "newName": "b" }))
        .await;
    assert!(e.contains("cannot rename `beta`") && e.contains("language server"), "{e}");
    let e = h
        .call_err("rename_refactoring", json!({ "pathInProject": "notes.txt", "symbolName": "delta", "newName": "d" }))
        .await;
    assert!(e.contains("does not occur"), "{e}");
    let e = h
        .call_err(
            "rename_refactoring",
            json!({ "pathInProject": "notes.txt", "symbolName": "beta", "newName": "beta" }),
        )
        .await;
    assert!(e.contains("current name"), "{e}");
    assert_eq!(read(&h, "notes.txt"), "alpha beta\nbeta gamma\n");
    assert_no_documents(&h);
}

#[tokio::test(flavor = "multi_thread")]
async fn opens_files_and_lists_open_editors() {
    let h = Harness::new(&[("src/main.rs", "fn main() {}\n")]).await;
    *h.ui.answer.lock() = serde_json::Value::Null;
    let out = h.call("open_file_in_editor", json!({ "filePath": "src/main.rs", "line": 1, "column": 4 })).await;
    assert_eq!(out, "Opened src/main.rs at line 1, column 4");
    match h.ui.asked.lock().last().unwrap() {
        McpUiRequest::OpenFile { path, line, column } => {
            assert_eq!(**path, h.path("src/main.rs"));
            assert_eq!((*line, *column), (Some(1), Some(4)));
        }
        other => panic!("{other:?}"),
    }
    let e = h.call_err("open_file_in_editor", json!({ "filePath": "nope.rs" })).await;
    assert!(e.contains("not a file"), "{e}");
    let e = h.call_err("open_file_in_editor", json!({ "filePath": "src/main.rs", "line": 0 })).await;
    assert!(e.contains("1-based"), "{e}");

    *h.ui.answer.lock() = json!({
        "active": h.path("src/main.rs"),
        "open": [h.path("src/main.rs"), "/elsewhere/lib.rs"],
    });
    let v = h.call_json("get_all_open_file_paths", json!({})).await;
    assert_eq!(v, json!({ "activeFilePath": "src/main.rs", "openFiles": ["src/main.rs", "/elsewhere/lib.rs"] }));
    assert!(matches!(h.ui.asked.lock().last().unwrap(), McpUiRequest::OpenEditors));

    *h.ui.answer.lock() = json!({ "active": null, "open": [] });
    let v = h.call_json("get_all_open_file_paths", json!({})).await;
    assert_eq!(v, json!({ "activeFilePath": null, "openFiles": [] }));
}

#[tokio::test(flavor = "multi_thread")]
async fn rolls_back_when_a_step_fails_while_applying() {
    let h = Harness::new(&[("a.txt", "a\n"), ("m.txt", "m\n"), ("locked.txt", "l\n")]).await;
    ide_vfs::set_writable(&h.path("locked.txt"), false).unwrap();
    let patch = "*** Begin Patch
*** Add File: added.txt
+new
*** Update File: a.txt
-a
+A
*** Update File: m.txt
*** Move to: moved/m.txt
-m
+M
*** Update File: locked.txt
-l
+L
*** End Patch";
    let e = h.call_err("apply_patch", json!({ "input": patch })).await;
    assert!(e.contains("applying the patch failed") && e.contains("were restored"), "{e}");
    assert!(!h.path("added.txt").exists());
    assert_eq!(read(&h, "a.txt"), "a\n");
    // The move is undone through the IDE's move layer, then the text restored.
    assert_eq!(read(&h, "m.txt"), "m\n");
    assert!(!h.path("moved/m.txt").exists());
    assert_eq!(read(&h, "locked.txt"), "l\n");
    ide_vfs::set_writable(&h.path("locked.txt"), true).unwrap();
    assert_no_documents(&h);
}
