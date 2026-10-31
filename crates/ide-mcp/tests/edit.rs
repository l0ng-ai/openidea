//! The editing tools against a real project: files, patches through the
//! document layer, language-server tools without servers, editor requests.
//! Includes the cases of JetBrains' `PatchToolsetTest` and `FileToolsetTest`.

mod common;

use common::Harness;
use ide_core::mcp::McpUiRequest;
use ide_core::{ChangeSet, TextChange as Change};
use serde_json::{Value, json};

fn read(h: &Harness, rel: &str) -> String {
    std::fs::read_to_string(h.path(rel)).unwrap()
}

/// No document stays open after a tool that opened one transiently.
fn assert_no_documents(h: &Harness) {
    let project = h.host().project("main").unwrap();
    assert!(project.documents.open_documents().is_empty(), "documents left open");
}

async fn patch(h: &Harness, lines: &[&str]) -> String {
    let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    h.call("apply_patch", json!({ "input": text })).await
}

#[tokio::test(flavor = "multi_thread")]
async fn creates_files_and_refuses_to_clobber() {
    let h = Harness::new(&[("old.txt", "keep\n")]).await;
    let out = h.call("create_new_file", json!({ "pathInProject": "src/deep/new.rs", "text": "fn main() {}\n" })).await;
    assert_eq!(out, "[success]");
    assert_eq!(read(&h, "src/deep/new.rs"), "fn main() {}\n");

    let e = h.call_err("create_new_file", json!({ "pathInProject": "old.txt", "text": "x" })).await;
    assert_eq!(e, "File already exists: old.txt. Specify 'overwrite=true' to overwrite it");
    assert_eq!(read(&h, "old.txt"), "keep\n");

    // Without text an existing file keeps its contents, as in JetBrains.
    h.call("create_new_file", json!({ "pathInProject": "old.txt", "overwrite": true })).await;
    assert_eq!(read(&h, "old.txt"), "keep\n");
    let out =
        h.call("create_new_file", json!({ "pathInProject": "old.txt", "text": "new\r\n", "overwrite": true })).await;
    assert_eq!(out, "[success]");
    assert_eq!(read(&h, "old.txt"), "new\n");

    h.call("create_new_file", json!({ "pathInProject": "src/NewFile.java" })).await;
    assert_eq!(read(&h, "src/NewFile.java"), "");
    let e = h.call_err("create_new_file", json!({ "pathInProject": "src" })).await;
    assert!(e.contains("Can't create file") && e.contains("directory"), "{e}");
    assert_no_documents(&h);
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_paths_outside_the_project_and_vcs_metadata() {
    let h = Harness::new(&[("a.txt", "a\n"), (".git/config", "[core]\n")]).await;
    let outside = h.root.parent().unwrap().join("outside.txt");
    for path in ["../outside.txt", "src/../../outside.txt", outside.to_str().unwrap()] {
        let e = h.call_err("create_new_file", json!({ "pathInProject": path, "text": "x" })).await;
        assert!(e.contains("outside the project"), "{path}: {e}");
    }
    let e = h.call_err("create_new_file", json!({ "pathInProject": ".git/hooks/pre-commit", "text": "x" })).await;
    assert!(e.contains("version control metadata"), "{e}");

    let out = patch(&h, &["*** Begin Patch", "*** Add File: ../outside.txt", "+x", "*** End Patch"]).await;
    assert!(
        out.starts_with("0 out of 1 operations applied. 1 operations failed to be applied due to errors:\n"),
        "{out}"
    );
    assert!(out.contains("../outside.txt: ") && out.contains("outside the project"), "{out}");
    let out =
        patch(&h, &["*** Begin Patch", "*** Update File: a.txt", "*** Move to: ../moved.txt", "*** End Patch"]).await;
    assert!(out.contains("outside the project"), "{out}");
    let out =
        patch(&h, &["*** Begin Patch", "*** Update File: .git/config", "@@", "-[core]", "+[x]", "*** End Patch"]).await;
    assert!(out.starts_with("0 out of 1") && out.contains("version control metadata"), "{out}");
    assert!(!outside.exists() && h.path("a.txt").exists());
    assert_eq!(read(&h, ".git/config"), "[core]\n");
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
    assert_eq!(out, "4 out of 4 operations applied.");
    assert_eq!(read(&h, "docs/new.md"), "# Title\ntext\n");
    assert!(!h.path("gone.txt").exists());
    assert_eq!(read(&h, "src/lib.rs"), "fn a() {\n    10\n}\n\nfn b() {\n    20\n}\n");
    assert!(!h.path("move/me.txt").exists());
    assert_eq!(read(&h, "moved/me.txt"), "one\nthree\n");
    assert_no_documents(&h);

    // `patch` is an alias of `input`.
    let out =
        h.call("apply_patch", json!({ "patch": "*** Begin Patch\n*** Delete File: docs/new.md\n*** End Patch" })).await;
    assert_eq!(out, "1 out of 1 operations applied.");
    assert!(!h.path("docs/new.md").exists());
}

/// JetBrains `PatchToolsetTest`.
#[tokio::test(flavor = "multi_thread")]
async fn ports_the_jetbrains_patch_tool_cases() {
    let h = Harness::new(&[("src/Test.java", "Test.java content"), ("src/old.txt", "alpha\nbeta\n")]).await;
    let one = "1 out of 1 operations applied.";
    let update = |from: &str, to: &str| {
        let (from, to) = (format!("-{from}"), format!("+{to}"));
        let h = &h;
        async move {
            patch(h, &["*** Begin Patch", "*** Update File: src/Test.java", "@@", &from, &to, "*** End Patch"]).await
        }
    };
    assert_eq!(update("Test.java content", "Test.java content").await, one);
    assert_eq!(read(&h, "src/Test.java"), "Test.java content");
    assert_eq!(update("Test.java content", "updated content").await, one);
    assert_eq!(read(&h, "src/Test.java"), "updated content");
    // An edit on the disk behind the IDE's back.
    std::fs::write(h.path("src/Test.java"), "external content\n").unwrap();
    assert_eq!(update("external content", "updated external").await, one);
    assert_eq!(read(&h, "src/Test.java"), "updated external\n");

    let out = patch(
        &h,
        &[
            "*** Begin Patch",
            "*** Update File: src/Test.java",
            "@@",
            "updated external",
            "@@",
            "updated with strict pair",
            "*** End Patch",
        ],
    )
    .await;
    assert_eq!(out, one);
    assert_eq!(read(&h, "src/Test.java"), "updated with strict pair\n");
    let out = patch(
        &h,
        &[
            "*** Begin Patch",
            "diff --git a/src/Test.java b/src/Test.java",
            "--- a/src/Test.java",
            "+++ b/src/Test.java",
            "@@ -1 +1 @@",
            "-updated with strict pair",
            "+updated from git diff",
            "*** End Patch",
        ],
    )
    .await;
    assert_eq!(out, one);
    assert_eq!(read(&h, "src/Test.java"), "updated from git diff\n");

    let out = patch(
        &h,
        &[
            "*** Begin Patch",
            "*** Update File: src/old.txt",
            "*** Move to: src/moved/new.txt",
            "@@",
            "-alpha",
            "+alpha",
            "*** End Patch",
        ],
    )
    .await;
    assert_eq!(out, one);
    assert_eq!(read(&h, "src/moved/new.txt"), "alpha\nbeta\n");
    assert!(!h.path("src/old.txt").exists());
    let out = patch(
        &h,
        &[
            "diff --git a/src/moved/new.txt b/src/rename-new.txt",
            "similarity index 100%",
            "rename from src/moved/new.txt",
            "rename to src/rename-new.txt",
        ],
    )
    .await;
    assert_eq!(out, one);
    assert_eq!(read(&h, "src/rename-new.txt"), "alpha\nbeta\n");

    let e = h.call_err("apply_patch", json!({ "input": "oops" })).await;
    assert!(e.contains("*** Begin Patch"), "{e}");
    let e = h.call_err("apply_patch", json!({})).await;
    assert_eq!(e, "input must be a non-empty string");
    assert_no_documents(&h);
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
    assert_eq!(out, "4 out of 4 operations applied.");
    assert_eq!(read(&h, "a.txt"), "1\ntwo\n3\n4\n5\n6\n7\n8\n8.5\n9\n");
    assert_eq!(read(&h, "n/new.txt"), "fresh\n");
    assert!(!h.path("del.txt").exists() && !h.path("ren.txt").exists());
    assert_eq!(read(&h, "renamed.txt"), "r\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_diffs_with_different_names_patch_the_existing_file() {
    let h = Harness::new(&[("a.txt", "a\nb\n"), ("src/b.txt", "x\n")]).await;
    let one = "1 out of 1 operations applied.";
    // `diff -u a.txt.orig a.txt`: the `+++` file exists, nothing moves.
    let diff = "--- a.txt.orig\t2024-01-01 10:00:00\n+++ a.txt\t2024-01-02 10:00:00\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n";
    assert_eq!(h.call("apply_patch", json!({ "input": diff })).await, one);
    assert_eq!(read(&h, "a.txt"), "A\nb\n");
    assert!(!h.path("a.txt.orig").exists());
    // `diff -u a.txt a.txt.new`: only the `---` file exists.
    let diff = "--- a.txt\n+++ a.txt.new\n@@ -1 +1 @@\n-A\n+AA\n";
    assert_eq!(h.call("apply_patch", json!({ "input": diff })).await, one);
    assert!(!h.path("a.txt.new").exists());
    // `diff -ru old/ new/` run outside the project: the names below the first directory.
    let diff = "diff -ru old/src/b.txt new/src/b.txt\n--- old/src/b.txt\n+++ new/src/b.txt\n@@ -1 +1 @@\n-x\n+y\n";
    assert_eq!(h.call("apply_patch", json!({ "input": diff })).await, one);
    assert_eq!(read(&h, "src/b.txt"), "y\n");
    let out = h.call("apply_patch", json!({ "input": "--- p.txt\n+++ q.txt\n@@ -1 +1 @@\n-x\n+y\n" })).await;
    assert!(out.ends_with("q.txt: File not found: q.txt (also tried p.txt)"), "{out}");
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
async fn a_failing_operation_leaves_the_others_applied() {
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
    let out = h.call("apply_patch", json!({ "input": patch })).await;
    assert!(
        out.starts_with(
            "3 out of 4 operations applied. 1 operations failed to be applied due to errors:\nb.txt: Hunk context not \
found: hunk 1 does not apply"
        ),
        "{out}"
    );
    assert!(out.contains("  three\n  five\n"), "{out}");
    assert!(out.contains("line 2 is `four`, but the patch expects `five`"), "{out}");
    assert_eq!(read(&h, "a.txt"), "ONE\ntwo\n");
    assert_eq!(read(&h, "b.txt"), "three\nfour\n");
    assert!(!h.path("c.txt").exists() && h.path("added.txt").exists());

    let out = patch_text(&h, "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch").await;
    assert!(out.ends_with("a.txt: File already exists: a.txt"), "{out}");
    let out = patch_text(&h, "*** Begin Patch\n*** Delete File: nope.txt\n*** End Patch").await;
    assert!(out.ends_with("nope.txt: File not found: nope.txt"), "{out}");
    let out = patch_text(&h, "*** Begin Patch\n*** Delete File: .\n*** End Patch").await;
    assert!(out.contains("Path is not a file"), "{out}");
    // Parse errors fail the whole call.
    let e = h.call_err("apply_patch", json!({ "input": "*** Begin Patch\n*** Update File: a.txt\n-one\n+1\n" })).await;
    assert!(e.contains("patch must include *** End Patch"), "{e}");
    assert_eq!(read(&h, "a.txt"), "ONE\ntwo\n");
    assert_no_documents(&h);
}

async fn patch_text(h: &Harness, text: &str) -> String {
    h.call("apply_patch", json!({ "input": text })).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_locked_file_fails_alone() {
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
    let out = h.call("apply_patch", json!({ "input": patch })).await;
    assert!(out.starts_with("3 out of 4 operations applied.") && out.contains("\nlocked.txt: "), "{out}");
    assert_eq!(read(&h, "added.txt"), "new\n");
    assert_eq!(read(&h, "a.txt"), "A\n");
    assert_eq!(read(&h, "moved/m.txt"), "M\n");
    assert!(!h.path("m.txt").exists());
    assert_eq!(read(&h, "locked.txt"), "l\n");
    ide_vfs::set_writable(&h.path("locked.txt"), true).unwrap();
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
    assert!(
        out.starts_with("1 out of 1 operations applied.") && out.contains("had unsaved changes in the editor"),
        "{out}"
    );
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
    let out = h.call("apply_patch", json!({ "input": patch })).await;
    assert!(out.starts_with("0 out of 1") && out.contains("unsaved changes in the editor"), "{out}");
    ide_host::ops::doc::close(&host, "main", info.id).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn formatting_tools_fail_cleanly_without_servers() {
    let h = Harness::new(&[("notes.txt", "alpha beta\nbeta gamma\n"), ("dir/x.txt", "")]).await;
    let e = h.call_err("reformat_file", json!({ "files": ["notes.txt"] })).await;
    assert!(e.starts_with("notes.txt: not formatted:"), "{e}");
    let e = h.call_err("optimize_imports", json!({ "files": ["notes.txt", "./notes.txt"] })).await;
    assert!(e.starts_with("notes.txt: imports not optimized:") && !e.contains('\n'), "{e}");
    let e = h.call_err("reformat_file", json!({ "files": ["missing.txt"] })).await;
    assert_eq!(e, "File not found: missing.txt");
    let e = h.call_err("reformat_file", json!({ "files": ["dir"] })).await;
    assert_eq!(e, "Not a file: dir");
    let e = h.call_err("reformat_file", json!({ "files": ["../x.txt"] })).await;
    assert!(e.contains("outside the project"), "{e}");
    let e = h.call_err("reformat_file", json!({ "files": [] })).await;
    assert_eq!(e, "files must contain at least one path");
    let e = h.call_err("optimize_imports", json!({ "files": ["notes.txt", " "] })).await;
    assert_eq!(e, "files must not contain blank paths");
    assert_eq!(read(&h, "notes.txt"), "alpha beta\nbeta gamma\n");
    assert_no_documents(&h);
}

#[tokio::test(flavor = "multi_thread")]
async fn add_missing_imports_skips_files_without_a_server() {
    let h = Harness::new(&[("notes.txt", "alpha beta\n")]).await;
    let v = h.call_json("add_missing_imports", json!({ "files": ["notes.txt"], "mode": "diff" })).await;
    assert_eq!(
        v,
        json!({ "items": [{
            "filePath": "notes.txt",
            "notAnalyzedReason": "No language server for this file became ready, so the tool cannot find the missing imports.",
            "applied": false, "ambiguous": [], "unresolved": [],
        }] })
    );
    let e = h.call_err("add_missing_imports", json!({ "files": ["notes.txt"], "mode": "preview" })).await;
    assert_eq!(e, "mode must be `diff` or `apply`, got `preview`");
    let e = h.call_err("add_missing_imports", json!({ "files": ["notes.txt"], "ambiguity": "all" })).await;
    assert_eq!(e, "ambiguity must be `report` or `best`, got `all`");
    assert_no_documents(&h);
}

#[tokio::test(flavor = "multi_thread")]
async fn rename_reports_why_it_cannot_rename() {
    let h = Harness::new(&[("notes.txt", "alpha beta\nbeta gamma\n")]).await;
    let rename = |extra: Value| {
        let mut args = json!({ "pathInProject": "notes.txt", "symbolName": "beta", "newName": "b" });
        args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let h = &h;
        async move { h.call_json("rename_refactoring", args).await }
    };
    let kind = |v: &Value| v["error"]["kind"].as_str().unwrap_or_default().to_owned();
    let v = rename(json!({})).await;
    assert_eq!((v["ok"].clone(), v["applied"].clone()), (json!(false), json!(false)));
    assert_eq!(kind(&v), "symbol_not_found", "{v}");
    assert_eq!(kind(&rename(json!({ "line": 1, "column": 7 })).await), "language_not_supported");
    assert_eq!(kind(&rename(json!({ "contextSnippet": "alpha beta" })).await), "language_not_supported");
    assert_eq!(kind(&rename(json!({ "line": 9, "column": 1 })).await), "position_out_of_bounds");
    assert_eq!(kind(&rename(json!({ "line": 1, "column": 12 })).await), "position_out_of_bounds");
    let v = rename(json!({ "line": 1, "column": 2 })).await;
    assert_eq!(kind(&v), "name_mismatch");
    assert!(v["error"]["hint"].as_str().unwrap().contains("'alpha'"), "{v}");
    assert_eq!(kind(&rename(json!({ "contextSnippet": "delta" })).await), "name_mismatch");
    assert_eq!(kind(&rename(json!({ "contextSnippet": "zeta beta" })).await), "snippet_not_found");
    assert_eq!(kind(&rename(json!({ "contextSnippet": "beta" })).await), "snippet_not_unique");

    let e = h
        .call_err("rename_refactoring", json!({ "pathInProject": "notes.txt", "symbolName": "beta", "newName": " " }))
        .await;
    assert_eq!(e, "newName is empty");
    let e = h
        .call_err(
            "rename_refactoring",
            json!({ "pathInProject": "notes.txt", "symbolName": "beta", "newName": "b", "line": 1 }),
        )
        .await;
    assert_eq!(e, "line and column must be given together");
    let e = h
        .call_err("rename_refactoring", json!({ "pathInProject": "nope.txt", "symbolName": "beta", "newName": "b" }))
        .await;
    assert_eq!(e, "File not found: nope.txt");
    assert_eq!(read(&h, "notes.txt"), "alpha beta\nbeta gamma\n");
    assert_no_documents(&h);
}

#[tokio::test(flavor = "multi_thread")]
async fn opens_files_and_lists_open_editors() {
    let h = Harness::new(&[("src/main.rs", "fn main() {}\n")]).await;
    *h.ui.answer.lock() = serde_json::Value::Null;
    let out = h.call("open_file_in_editor", json!({ "filePath": "src/main.rs", "line": 1, "column": 4 })).await;
    assert_eq!(out, "[success]");
    match h.ui.asked.lock().last().unwrap() {
        McpUiRequest::OpenFile { path, line, column } => {
            assert_eq!(**path, h.path("src/main.rs"));
            assert_eq!((*line, *column), (Some(1), Some(4)));
        }
        other => panic!("{other:?}"),
    }
    let e = h.call_err("open_file_in_editor", json!({ "filePath": "nope.rs" })).await;
    assert_eq!(e, "File nope.rs doesn't exist or can't be opened");
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
async fn the_call_history_lists_the_files_a_call_changed() {
    let h = Harness::new(&[("a.txt", "one\n"), ("b.txt", "two\n"), ("c.txt", "three\n")]).await;
    h.call("create_new_file", json!({ "pathInProject": "src/new.txt", "text": "x" })).await;
    assert_eq!(h.server.call_history()[0].changed_files, ["src/new.txt"]);

    patch(
        &h,
        &[
            "*** Begin Patch",
            "*** Add File: added.txt",
            "+hi",
            "*** Update File: a.txt",
            "@@",
            "-one",
            "+uno",
            "*** Update File: b.txt",
            "*** Move to: moved/b.txt",
            "*** Delete File: c.txt",
            "*** Update File: missing.txt",
            "@@",
            "-x",
            "+y",
            "*** End Patch",
        ],
    )
    .await;
    assert_eq!(
        h.server.call_history()[0].changed_files,
        ["added.txt", "a.txt", "b.txt", "moved/b.txt", "c.txt"],
        "in order, without the failed operation"
    );

    // Nothing to write: nothing changed.
    h.call("create_new_file", json!({ "pathInProject": "a.txt", "overwrite": true })).await;
    assert!(h.server.call_history()[0].changed_files.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_the_ide_configuration_asks_first() {
    let h = Harness::new(&[(".openidea/runConfigurations/app.json", "{}\n"), ("a.txt", "a\n")]).await;
    let asked = |h: &Harness| {
        h.ui.asked
            .lock()
            .iter()
            .filter_map(|r| match r {
                McpUiRequest::Confirm { subject, .. } => Some(subject.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    // Declined: nothing changes.
    *h.ui.answer.lock() = json!(false);
    let e =
        h.call_err("create_new_file", json!({ "pathInProject": ".openidea/settings.json", "text": "{\"x\":1}" })).await;
    assert!(e.contains("declined"), "{e}");
    assert!(!h.path(".openidea/settings.json").exists());
    assert_eq!(asked(&h), ["Change .openidea/settings.json"]);
    let out = patch(
        &h,
        &[
            "*** Begin Patch",
            "*** Update File: .openidea/runConfigurations/app.json",
            "@@",
            "-{}",
            "+{\"x\":1}",
            "*** End Patch",
        ],
    )
    .await;
    assert!(out.starts_with("0 out of 1") && out.contains("declined"), "{out}");
    let out =
        patch(&h, &["*** Begin Patch", "*** Delete File: .openidea/runConfigurations/app.json", "*** End Patch"]).await;
    assert!(out.starts_with("0 out of 1"), "{out}");
    // Moving a file into it asks too.
    let out =
        patch(&h, &["*** Begin Patch", "*** Update File: a.txt", "*** Move to: .openidea/a.txt", "*** End Patch"])
            .await;
    assert!(out.starts_with("0 out of 1"), "{out}");
    assert_eq!(read(&h, ".openidea/runConfigurations/app.json"), "{}\n");
    assert!(h.path("a.txt").exists());
    let e = h.call_err("reformat_file", json!({ "files": [".openidea/runConfigurations/app.json"] })).await;
    assert!(e.contains("declined"), "{e}");
    assert_eq!(asked(&h).len(), 5);
    // Other files do not ask.
    h.call("create_new_file", json!({ "pathInProject": "src/x.txt", "text": "x" })).await;
    assert_eq!(asked(&h).len(), 5);

    // Allowed.
    *h.ui.answer.lock() = json!(true);
    h.call("create_new_file", json!({ "pathInProject": ".openidea/settings.json", "text": "{}" })).await;
    assert_eq!(read(&h, ".openidea/settings.json"), "{}");
    // Brave mode does not ask.
    h.server.apply(&ide_core::mcp::McpSettings { brave_mode: true, ..Default::default() }).await;
    let before = asked(&h).len();
    h.call("create_new_file", json!({ "pathInProject": ".openidea/other.json", "text": "{}", "overwrite": true }))
        .await;
    assert_eq!(asked(&h).len(), before);
    // VCS metadata stays refused, brave or not.
    let e = h.call_err("create_new_file", json!({ "pathInProject": ".git/config", "text": "x" })).await;
    assert!(e.contains("version control metadata"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_a_file_outside_the_project_asks_first() {
    let h = Harness::new(&[("a.txt", "a\n")]).await;
    let outside = h.root.parent().unwrap().join("outside.txt");
    std::fs::write(&outside, "secret\n").unwrap();
    *h.ui.answer.lock() = json!(false);
    let e = h.call_err("open_file_in_editor", json!({ "filePath": outside.to_str().unwrap() })).await;
    assert!(e.contains("declined"), "{e}");
    let asked = h.ui.asked.lock().clone();
    assert!(matches!(&asked[..], [McpUiRequest::Confirm { subject, .. }] if subject.starts_with("Read ")), "{asked:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_read_the_disk_not_a_stale_buffer() {
    let h = Harness::new(&[("a.txt", "one\n"), ("b.txt", "x\n")]).await;
    let host = h.host().clone();
    let a = ide_host::ops::doc::open(&host, "main", h.path("a.txt")).await.unwrap();
    let b = ide_host::ops::doc::open(&host, "main", h.path("b.txt")).await.unwrap();
    // The agent wrote the files itself; the editor's (clean) buffers have not caught up.
    std::fs::write(h.path("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(h.path("b.txt"), "written by the agent\n").unwrap();
    let out =
        patch(&h, &["*** Begin Patch", "*** Update File: a.txt", "@@", " one", "-two", "+TWO", "*** End Patch"]).await;
    assert_eq!(out, "1 out of 1 operations applied.");
    assert_eq!(read(&h, "a.txt"), "one\nTWO\n");
    // Reformatting (no server here) leaves the agent's write alone, and the buffer follows the disk.
    h.call_err("reformat_file", json!({ "files": ["b.txt"] })).await;
    assert_eq!(read(&h, "b.txt"), "written by the agent\n");
    let project = host.project("main").unwrap();
    assert_eq!(project.documents.text_snapshot(b.id).unwrap().text, "written by the agent\n");
    ide_host::ops::doc::close(&host, "main", a.id).unwrap();
    ide_host::ops::doc::close(&host, "main", b.id).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn git_mode_changes_and_copies_do_not_fail_the_patch() {
    let h = Harness::new(&[("run.sh", "echo\n"), ("a.txt", "1\n"), ("src/a.rs", "a\n")]).await;
    let diff = "diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
diff --git a/src/a.rs b/src/b.rs
similarity index 90%
copy from src/a.rs
copy to src/b.rs
--- a/src/a.rs
+++ b/src/b.rs
@@ -1 +1 @@
-a
+b
diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-1
+2
";
    let out = h.call("apply_patch", json!({ "input": diff })).await;
    assert!(out.starts_with("2 out of 2 operations applied.\nNotes:"), "{out}");
    assert!(out.contains("src/b.rs: the copy of src/a.rs to src/b.rs was skipped"), "{out}");
    assert_eq!((read(&h, "run.sh"), read(&h, "a.txt")), ("echo\n".into(), "2\n".into()));
    assert!(!h.path("src/b.rs").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn moves_that_change_only_the_case() {
    let h = Harness::new(&[("readme.md", "hi\n")]).await;
    let case_insensitive = h.path("README.md").exists();
    let out =
        patch(&h, &["*** Begin Patch", "*** Update File: readme.md", "*** Move to: README.md", "*** End Patch"]).await;
    assert_eq!(out, "1 out of 1 operations applied.");
    let names: Vec<String> =
        std::fs::read_dir(&h.root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(names.contains(&"README.md".to_owned()), "{names:?}");
    assert!(!names.contains(&"readme.md".to_owned()), "{names:?}");
    // On a case-sensitive file system an existing other file still blocks the move.
    if !case_insensitive {
        std::fs::write(h.path("readme.md"), "other\n").unwrap();
        let out =
            patch(&h, &["*** Begin Patch", "*** Update File: README.md", "*** Move to: readme.md", "*** End Patch"])
                .await;
        assert!(out.contains("File already exists"), "{out}");
    }
}
