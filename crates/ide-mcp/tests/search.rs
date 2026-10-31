//! search_text, search_regex, search_file and search_symbol against a real project.

mod common;

use common::Harness;
use ide_core::{ChangeSet, TextChange};
use serde_json::{Value, json};

fn paths(v: &Value) -> Vec<String> {
    v["entries"].as_array().unwrap().iter().map(|e| e["filePath"].as_str().unwrap().to_owned()).collect()
}

async fn project() -> Harness {
    Harness::new(&[
        ("src/main.rs", "fn main() {\n    let needle = 1;\n    needle + needle;\n}\n"),
        ("src/gen/out.rs", "// needle\n"),
        ("docs/readme.md", "A needle in docs.\n"),
        ("unicode.txt", "ğüş = needle\n😀 needle\n"),
        ("build/skip.txt", "needle\n"),
        (".gitignore", "build/\n"),
    ])
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn text_search_finds_sorted_matches_with_coordinates() {
    let h = project().await;
    let r = h.call_json("search_text", json!({ "q": "needle" })).await;
    assert_eq!(r["more"], false);
    // Sorted by file, then line; the ignored `build/` is not searched.
    assert_eq!(
        paths(&r),
        ["docs/readme.md", "src/gen/out.rs", "src/main.rs", "src/main.rs", "src/main.rs", "unicode.txt", "unicode.txt"]
    );
    let main: Vec<&Value> =
        r["entries"].as_array().unwrap().iter().filter(|e| e["filePath"] == "src/main.rs").collect();
    assert_eq!(
        *main[0],
        json!({ "filePath": "src/main.rs", "line": 2, "column": 9, "endLine": 2, "endColumn": 15,
            "lineText": "    let needle = 1;" })
    );
    assert_eq!((main[1]["line"].as_u64(), main[1]["column"].as_u64()), (Some(3), Some(5)));
    assert_eq!((main[2]["line"].as_u64(), main[2]["column"].as_u64()), (Some(3), Some(14)));
}

#[tokio::test(flavor = "multi_thread")]
async fn columns_count_utf16_units() {
    let h = project().await;
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["unicode.txt"] })).await;
    let e = r["entries"].as_array().unwrap();
    assert_eq!(e.len(), 2);
    assert_eq!(
        (e[0]["line"].as_u64(), e[0]["column"].as_u64(), e[0]["endColumn"].as_u64()),
        (Some(1), Some(7), Some(13))
    );
    assert_eq!(e[0]["lineText"], "ğüş = needle");
    // The emoji is two UTF-16 units.
    assert_eq!((e[1]["line"].as_u64(), e[1]["column"].as_u64()), (Some(2), Some(4)));
    let r = h.call_json("search_text", json!({ "q": "üş" })).await;
    assert_eq!((r["entries"][0]["column"].as_u64(), r["entries"][0]["endColumn"].as_u64()), (Some(2), Some(4)));
}

#[tokio::test(flavor = "multi_thread")]
async fn paths_filter_with_globs_and_excludes() {
    let h = project().await;
    let files = |r: Value| {
        let mut p = paths(&r);
        p.dedup();
        p
    };
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["src/"] })).await;
    assert_eq!(files(r), ["src/gen/out.rs", "src/main.rs"]);
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["src/", "!src/gen/"] })).await;
    assert_eq!(files(r), ["src/main.rs"]);
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["*.md", ""] })).await;
    assert_eq!(files(r), ["docs/readme.md"]);
    // A bare directory name covers what is below it, at any depth.
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["!gen", "!*.txt", "!docs"] })).await;
    assert_eq!(files(r), ["src/main.rs"]);
    // Brace alternations hold commas, which Find in Files masks split: filtered afterwards.
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["**/*.{md,txt}"] })).await;
    assert_eq!(files(r), ["docs/readme.md", "unicode.txt"]);
    let err = h.call_err("search_text", json!({ "q": "needle", "paths": ["src/[a"] })).await;
    assert!(err.contains("Invalid glob"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn limit_cuts_results_and_reports_more() {
    let h = Harness::new(&[("a.txt", "x x x\nx\nx\n")]).await;
    let r = h.call_json("search_text", json!({ "q": "x", "limit": 3 })).await;
    assert_eq!(r["entries"].as_array().unwrap().len(), 3);
    assert_eq!(r["more"], true);
    let r = h.call_json("search_text", json!({ "q": "x", "limit": 5 })).await;
    assert_eq!(r["entries"].as_array().unwrap().len(), 5);
    assert_eq!(r["more"], false);
    let err = h.call_err("search_text", json!({ "q": "x", "limit": 0 })).await;
    assert!(err.contains("at least 1"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn searches_unsaved_editor_text() {
    let h = Harness::new(&[("a.txt", "old text\n")]).await;
    let doc = ide_host::ops::doc::open(h.host(), "main", h.path("a.txt")).await.unwrap();
    let change = ChangeSet { changes: vec![TextChange { from: 0, to: 3, insert: "fresh".into() }] };
    ide_host::ops::doc::edit(h.host(), "main", doc.id, doc.version, change).unwrap();
    let r = h.call_json("search_text", json!({ "q": "fresh" })).await;
    assert_eq!(r["entries"][0]["lineText"], "fresh text");
    let r = h.call_json("search_text", json!({ "q": "old" })).await;
    assert_eq!(r["entries"].as_array().unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn regex_search() {
    let h = Harness::new(&[("a.rs", "fn alpha() {}\nfn beta() {}\nlet x = 1;\n")]).await;
    let r = h.call_json("search_regex", json!({ "q": r"fn (\w+)\(" })).await;
    let e = r["entries"].as_array().unwrap();
    assert_eq!(e.len(), 2);
    assert_eq!(
        (e[1]["line"].as_u64(), e[1]["column"].as_u64(), e[1]["endColumn"].as_u64()),
        (Some(2), Some(1), Some(9))
    );
    // Case-sensitive unless asked otherwise.
    assert_eq!(h.call_json("search_regex", json!({ "q": "FN" })).await["entries"].as_array().unwrap().len(), 0);
    assert_eq!(h.call_json("search_regex", json!({ "q": "(?i)FN" })).await["entries"].as_array().unwrap().len(), 2);
    // A match across lines is one entry.
    let r = h.call_json("search_regex", json!({ "q": r"\{\}\nfn b" })).await;
    assert_eq!(
        r["entries"],
        json!([{ "filePath": "a.rs", "line": 1, "column": 12, "endLine": 2, "endColumn": 5, "lineText": "fn alpha() {}" }])
    );
    // A literal search does not interpret the pattern.
    assert_eq!(h.call_json("search_text", json!({ "q": "fn (" })).await["entries"].as_array().unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_input_gets_useful_errors() {
    let h = Harness::new(&[("a.txt", "x\n")]).await;
    let err = h.call_err("search_regex", json!({ "q": "foo(" })).await;
    assert!(err.contains("Invalid regular expression: unclosed group"), "{err}");
    let err = h.call_err("search_text", json!({ "q": "" })).await;
    assert!(err.contains("`q` is empty"), "{err}");
    let err = h.call_err("search_file", json!({})).await;
    assert!(err.contains("`q`"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn file_search_by_glob() {
    let h = project().await;
    let r = h.call_json("search_file", json!({ "q": "*.rs" })).await;
    assert_eq!(paths(&r), ["src/gen/out.rs", "src/main.rs"]);
    assert_eq!(r["more"], false);
    let r = h.call_json("search_file", json!({ "q": "src/*.rs" })).await;
    assert_eq!(paths(&r), ["src/main.rs"]);
    let r = h.call_json("search_file", json!({ "q": "*.rs", "paths": ["!gen/"] })).await;
    assert_eq!(paths(&r), ["src/gen/out.rs", "src/main.rs"], "`gen/` is anchored at the root");
    let r = h.call_json("search_file", json!({ "q": "*.rs", "paths": ["!src/gen/"] })).await;
    assert_eq!(paths(&r), ["src/main.rs"]);
    // Dotfiles are found; ignored files only on request.
    let r = h.call_json("search_file", json!({ "q": ".gitignore" })).await;
    assert_eq!(paths(&r), [".gitignore"]);
    let r = h.call_json("search_file", json!({ "q": "*.txt" })).await;
    assert_eq!(paths(&r), ["unicode.txt"]);
    let r = h.call_json("search_file", json!({ "q": "*.txt", "includeExcluded": true })).await;
    assert_eq!(paths(&r), ["build/skip.txt", "unicode.txt"]);
    let r = h.call_json("search_file", json!({ "q": "**/*", "limit": 2 })).await;
    assert_eq!(r["entries"].as_array().unwrap().len(), 2);
    assert_eq!(r["more"], true);
    let err = h.call_err("search_file", json!({ "q": "src/[" })).await;
    assert!(err.contains("Invalid glob"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn symbol_search() {
    let h = Harness::new(&[
        ("src/order.rs", "pub struct OrderController {\n    id: u32,\n}\n\nfn place_order() {}\n"),
        ("tests/order.rs", "struct OrderControllerTest;\n"),
    ])
    .await;
    let r = h.call_json("search_symbol", json!({ "q": "OrderController" })).await;
    let e = r["entries"].as_array().unwrap();
    assert!(!e.is_empty(), "{r}");
    let first = &e[0];
    assert_eq!(first["name"], "OrderController");
    assert_eq!(first["filePath"], "src/order.rs");
    assert_eq!(first["kind"], "struct");
    assert_eq!(first["line"], 1);
    assert!(first["column"].as_u64().unwrap() >= 1);
    assert!(paths(&r).contains(&"tests/order.rs".to_owned()));

    let r = h.call_json("search_symbol", json!({ "q": "OCo", "paths": ["src/"] })).await;
    assert_eq!(paths(&r), ["src/order.rs"]);
    let r = h.call_json("search_symbol", json!({ "q": "OrderController", "limit": 1 })).await;
    assert_eq!((r["entries"].as_array().unwrap().len(), &r["more"]), (1, &json!(true)));
    // Without a language server, include_external still answers from the index.
    let r = h.call_json("search_symbol", json!({ "q": "place_order", "include_external": true })).await;
    assert_eq!(r["entries"][0]["name"], "place_order");
}
