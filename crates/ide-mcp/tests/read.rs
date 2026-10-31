//! read_file and list_directory_tree against a real project (cases ported from
//! JetBrains' ReadToolsetTest and FileToolsetTest where they apply).

mod common;

use common::Harness;
use ide_core::mcp::McpUiRequest;
use ide_core::{ChangeSet, TextChange};
use serde_json::{Value, json};
use std::path::Path;

const SAMPLE: &str = "// Header A
// Header B
fun foo() {
  val x = 1
  if (x > 0) {
    println(x)
  }
}
fun bar() {
  println(\"bar\")
}";

async fn project() -> Harness {
    Harness::new(&[("src/read_file_sample.txt", SAMPLE), ("src/empty_read_file.txt", "")]).await
}

async fn read(h: &Harness, args: Value) -> String {
    h.call("read_file", args).await
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_numbered_lines() {
    let h = project().await;
    let text = read(&h, json!({ "file_path": "src/read_file_sample.txt" })).await;
    assert!(text.starts_with("L1: // Header A\nL2: // Header B\nL3: fun foo() {"), "{text}");
    assert!(text.ends_with("L11: }"), "{text}");
    assert!(!text.contains("truncated"));
    // An empty file is one empty line.
    assert_eq!(read(&h, json!({ "file_path": "src/empty_read_file.txt" })).await, "L1: ");
    // A trailing line break starts an empty last line, as in the editor.
    let h = Harness::new(&[("a.txt", "one\r\ntwo\n")]).await;
    assert_eq!(read(&h, json!({ "file_path": "a.txt" })).await, "L1: one\nL2: two\nL3: ");
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_head_and_tail_when_the_limit_is_exceeded() {
    let h = project().await;
    let path = "src/read_file_sample.txt";
    let text = read(&h, json!({ "file_path": path, "offset": 1, "limit": 4 })).await;
    assert_eq!(text, "L1: // Header A\nL2: // Header B\n…7 lines truncated…\nL10:   println(\"bar\")\nL11: }");
    let text = read(&h, json!({ "file_path": path, "offset": 3, "limit": 4 })).await;
    assert!(text.starts_with("L3: fun foo() {\nL4:   val x = 1\n…5 lines truncated…"), "{text}");
    assert!(text.ends_with("L11: }"), "{text}");
    let text = read(&h, json!({ "file_path": path, "offset": 9, "limit": 20 })).await;
    assert_eq!(text, "L9: fun bar() {\nL10:   println(\"bar\")\nL11: }");
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_bad_offsets_and_limits() {
    let h = project().await;
    let path = "src/read_file_sample.txt";
    let err = h.call_err("read_file", json!({ "file_path": path, "offset": i32::MAX, "limit": 1 })).await;
    assert_eq!(err, "offset exceeds file length");
    let err = h.call_err("read_file", json!({ "file_path": "src/empty_read_file.txt", "offset": 2 })).await;
    assert_eq!(err, "offset exceeds file length");
    let err = h.call_err("read_file", json!({ "file_path": path, "offset": 0, "limit": 1 })).await;
    assert_eq!(err, "offset must be > 0");
    let err = h.call_err("read_file", json!({ "file_path": path, "offset": 1, "limit": 0 })).await;
    assert_eq!(err, "limit must be > 0");
    // Checked before the file is looked up.
    let err = h.call_err("read_file", json!({ "file_path": "missing-file.txt", "limit": 5001 })).await;
    assert_eq!(err, "limit must be <= 5000");
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_missing_files_and_directories() {
    let h = project().await;
    let err = h.call_err("read_file", json!({ "file_path": "missing.txt" })).await;
    assert_eq!(err, "File missing.txt doesn't exist or can't be opened");
    let err = h.call_err("read_file", json!({ "file_path": "src" })).await;
    assert_eq!(err, "File src is a directory");
    let err = h.call_err("read_file", json!({ "file_path": "  " })).await;
    assert_eq!(err, "file_path is empty");
    let err = h.call_err("read_file", json!({ "file_path": "foo://x/y" })).await;
    assert_eq!(err, "File foo://x/y doesn't exist or can't be opened");
    let err = h.call_err("read_file", json!({ "file_path": "jrt://jdk!/java.base/java/lang/String.class" })).await;
    assert!(err.contains("jrt://"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_paths_in_every_form() {
    let h = project().await;
    let abs = h.path("src/read_file_sample.txt");
    for path in [
        abs.to_string_lossy().into_owned(),
        format!("file://{}", abs.display()),
        "src/../src/read_file_sample.txt".to_owned(),
        "src\\read_file_sample.txt".to_owned(),
    ] {
        let text = read(&h, json!({ "file_path": path })).await;
        assert!(text.starts_with("L1: // Header A"), "{path}: {text}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_unsaved_editor_text_and_excluded_files() {
    let h = Harness::new(&[
        ("a.txt", "old text\n"),
        ("build/out.txt", "excluded project file\n"),
        (".gitignore", "build/\n"),
    ])
    .await;
    let doc = ide_host::ops::doc::open(h.host(), "main", h.path("a.txt")).await.unwrap();
    let change = ChangeSet { changes: vec![TextChange { from: 0, to: 3, insert: "fresh".into() }] };
    ide_host::ops::doc::edit(h.host(), "main", doc.id, doc.version, change).unwrap();
    assert_eq!(read(&h, json!({ "file_path": "a.txt" })).await, "L1: fresh text\nL2: ");
    let text = read(&h, json!({ "file_path": "build/out.txt" })).await;
    assert!(text.contains("excluded project file"), "{text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_entries_of_archives() {
    let h = project().await;
    write_stored_zip(
        &h.path("libs/commons.jar"),
        &[
            ("org/example/Foo.java", b"package org.example;\nclass Foo {}\n"),
            ("org/example/Foo.class", b"\xCA\xFE\xBA\xBE\x00\x00\x00\x41\x00\x0F\x0A\x00\x02\x00\x03\x07\x00\x04"),
        ],
    );
    let jar = h.path("libs/commons.jar");
    for path in [
        "libs/commons.jar!/org/example/Foo.java".to_owned(),
        format!("{}!/org/example/Foo.java", jar.display()),
        format!("jar://{}!/org/example/Foo.java", jar.display()),
    ] {
        let text = read(&h, json!({ "file_path": path })).await;
        assert_eq!(text, "L1: package org.example;\nL2: class Foo {}\nL3: ", "{path}");
    }
    let err = h.call_err("read_file", json!({ "file_path": "libs/commons.jar!/org/example/Bar.java" })).await;
    assert!(err.contains("doesn't exist or can't be opened"), "{err}");
    let err = h.call_err("read_file", json!({ "file_path": "libs/commons.jar!/org/example" })).await;
    assert!(err.contains("is a directory"), "{err}");
    // Class files are not decompiled.
    let err = h.call_err("read_file", json!({ "file_path": "libs/commons.jar!/org/example/Foo.class" })).await;
    assert!(err.contains("binary file"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_before_reading_outside_the_project() {
    let h = project().await;
    let outside = h.dir.path().join("external.txt");
    std::fs::write(&outside, "external file content").unwrap();
    let text = read(&h, json!({ "file_path": outside.to_string_lossy() })).await;
    assert_eq!(text, "L1: external file content");
    assert!(matches!(h.ui.asked.lock().last(), Some(McpUiRequest::Confirm { .. })));
    *h.ui.answer.lock() = Value::Bool(false);
    let err = h.call_err("read_file", json!({ "file_path": outside.to_string_lossy() })).await;
    assert!(err.contains("declined"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_binary_files() {
    let h = project().await;
    std::fs::write(h.path("blob.bin"), [0u8, 1, 2, 0, 255]).unwrap();
    let err = h.call_err("read_file", json!({ "file_path": "blob.bin" })).await;
    assert!(err.contains("binary file"), "{err}");
}

// --- list_directory_tree -------------------------------------------------------

async fn tree(h: &Harness, args: Value) -> Value {
    h.call_json("list_directory_tree", args).await
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_a_tree_like_the_tree_utility() {
    let h = Harness::new(&[
        ("dir/.hidden", ""),
        ("dir/B.txt", ""),
        ("dir/a.txt", ""),
        ("dir/src/main.rs", ""),
        ("dir/src/lib/x.rs", ""),
        ("dir/build/out.txt", ""),
        (".gitignore", "build/\n"),
    ])
    .await;
    let r = tree(&h, json!({ "directoryPath": "dir" })).await;
    let root = h.path("dir");
    // Every entry (hidden and ignored ones too) by lower-cased name, the root by absolute path.
    let expected = format!(
        "{}/
    ├── .hidden
    ├── a.txt
    ├── B.txt
    ├── build/
    │   └── out.txt
    └── src/
        ├── lib/
        │   └── x.rs
        └── main.rs
",
        root.display()
    );
    assert_eq!(r, json!({ "traversedDirectory": "dir", "tree": expected, "errors": [] }));

    // The root counts as the first level.
    let r = tree(&h, json!({ "directoryPath": "dir/src", "maxDepth": 2 })).await;
    let src = h.path("dir/src");
    assert_eq!(r["tree"], format!("{}/\n    ├── lib/\n    └── main.rs\n", src.display()));
    let r = tree(&h, json!({ "directoryPath": "dir/src", "maxDepth": 1 })).await;
    assert_eq!(r["tree"], format!("{}/\n", src.display()));
    let r = tree(&h, json!({ "directoryPath": "dir", "maxDepth": 0 })).await;
    assert_eq!(r["tree"], "");
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_reports_timeouts_and_bad_directories() {
    let h = Harness::new(&[("dir/a.txt", "")]).await;
    let r = tree(&h, json!({ "directoryPath": "dir", "timeout": 0 })).await;
    assert_eq!(r, json!({ "traversedDirectory": "dir", "tree": "", "errors": [], "listingTimedOut": true }));
    let err = h.call_err("list_directory_tree", json!({ "directoryPath": "nope" })).await;
    assert_eq!(err, format!("No such directory: {}", h.path("nope").display()));
    let err = h.call_err("list_directory_tree", json!({ "directoryPath": "dir/a.txt" })).await;
    assert_eq!(err, format!("Not a directory: {}", h.path("dir/a.txt").display()));
    let err = h.call_err("list_directory_tree", json!({})).await;
    assert!(err.contains("directoryPath"), "{err}");
}

/// Writes a zip with `files` stored uncompressed.
fn write_stored_zip(path: &Path, files: &[(&str, &[u8])]) {
    fn crc32(data: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &b in data {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, data) in files {
        let (name, data) = (name.as_bytes(), *data);
        let (crc, size, offset) = (crc32(data), data.len() as u32, out.len() as u32);
        let common = |v: &mut Vec<u8>| {
            for x in [20u16, 0, 0, 0, 0] {
                v.extend(x.to_le_bytes());
            }
            for x in [crc, size, size] {
                v.extend(x.to_le_bytes());
            }
            v.extend((name.len() as u16).to_le_bytes());
            v.extend(0u16.to_le_bytes());
        };
        out.extend(0x0403_4b50u32.to_le_bytes());
        common(&mut out);
        out.extend(name);
        out.extend(data);
        central.extend(0x0201_4b50u32.to_le_bytes());
        central.extend(20u16.to_le_bytes());
        common(&mut central);
        for x in [0u16, 0, 0] {
            central.extend(x.to_le_bytes());
        }
        central.extend(0u32.to_le_bytes());
        central.extend(offset.to_le_bytes());
        central.extend(name);
    }
    let (cd_offset, cd_size) = (out.len() as u32, central.len() as u32);
    out.extend(central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    for x in [0u16, 0, files.len() as u16, files.len() as u16] {
        out.extend(x.to_le_bytes());
    }
    out.extend(cd_size.to_le_bytes());
    out.extend(cd_offset.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, out).unwrap();
}
