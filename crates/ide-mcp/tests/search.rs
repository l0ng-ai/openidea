//! search_text, search_regex, search_file and search_symbol against a real project
//! (cases ported from JetBrains' SearchToolsetTest where they apply).

mod common;

use common::Harness;
use ide_core::{ChangeSet, TextChange};
use serde_json::{Value, json};

fn items(v: &Value) -> Vec<Value> {
    v["items"].as_array().cloned().unwrap_or_default()
}

fn paths(v: &Value) -> Vec<String> {
    items(v).iter().map(|e| e["filePath"].as_str().unwrap().to_owned()).collect()
}

fn more(v: &Value) -> bool {
    v["more"].as_bool().unwrap_or(false)
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
    // `more` and `partialResultReason` are left out when there is nothing to say.
    assert!(r.get("more").is_none() && r.get("partialResultReason").is_none(), "{r}");
    // Sorted by file, then line; the ignored `build/` is not searched.
    assert_eq!(
        paths(&r),
        ["docs/readme.md", "src/gen/out.rs", "src/main.rs", "src/main.rs", "src/main.rs", "unicode.txt", "unicode.txt"]
    );
    let main: Vec<Value> = items(&r).into_iter().filter(|e| e["filePath"] == "src/main.rs").collect();
    // No matched line text in the default format.
    assert_eq!(
        main[0],
        json!({ "filePath": "src/main.rs", "startLine": 2, "startColumn": 9, "endLine": 2, "endColumn": 15 })
    );
    assert_eq!((main[1]["startLine"].as_u64(), main[1]["startColumn"].as_u64()), (Some(3), Some(5)));
    assert_eq!((main[2]["startLine"].as_u64(), main[2]["startColumn"].as_u64()), (Some(3), Some(14)));
}

#[tokio::test(flavor = "multi_thread")]
async fn columns_count_utf16_units() {
    let h = project().await;
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["unicode.txt"] })).await;
    let e = items(&r);
    assert_eq!(e.len(), 2);
    assert_eq!(
        (e[0]["startLine"].as_u64(), e[0]["startColumn"].as_u64(), e[0]["endColumn"].as_u64()),
        (Some(1), Some(7), Some(13))
    );
    // The emoji is two UTF-16 units.
    assert_eq!((e[1]["startLine"].as_u64(), e[1]["startColumn"].as_u64()), (Some(2), Some(4)));
    let r = h.call_json("search_text", json!({ "q": "üş" })).await;
    assert_eq!((r["items"][0]["startColumn"].as_u64(), r["items"][0]["endColumn"].as_u64()), (Some(2), Some(4)));
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
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["src/**", "!src/gen/**"] })).await;
    assert_eq!(files(r), ["src/main.rs"]);
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["*.md", ""] })).await;
    assert_eq!(files(r), ["docs/readme.md"]);
    // A path naming an existing directory covers what is below it.
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["!src/gen", "!*.txt", "!docs/"] })).await;
    assert_eq!(files(r), ["src/main.rs"]);
    // A bare name is `**/name`: it matches files of that name, not a directory's contents.
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["!gen", "src/"] })).await;
    assert_eq!(files(r), ["src/gen/out.rs", "src/main.rs"]);
    // Absolute paths inside the project are made relative.
    let abs = format!("{}/src/**", h.root.display());
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": [abs] })).await;
    assert_eq!(files(r), ["src/gen/out.rs", "src/main.rs"]);
    // Brace alternations hold commas, which Find in Files masks split: filtered afterwards.
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["**/*.{md,txt}"] })).await;
    assert_eq!(files(r), ["docs/readme.md", "unicode.txt"]);
    let err = h.call_err("search_text", json!({ "q": "needle", "paths": ["src/[a"] })).await;
    assert!(err.contains("Invalid glob pattern"), "{err}");
    let err = h.call_err("search_text", json!({ "q": "needle", "paths": ["../elsewhere/**"] })).await;
    assert!(err.contains("points to the location outside of the project directory"), "{err}");
    let err = h.call_err("search_text", json!({ "q": "needle", "paths": ["src/", "! "] })).await;
    assert!(err.contains("Exclude pattern is empty"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn brace_globs_are_not_cut_by_matches_outside_paths() {
    // Many matches outside `paths` must not use up the engine's budget.
    let many = "needle\n".repeat(50);
    let mut files: Vec<(String, String)> = (0..30).map(|i| (format!("a/f{i:02}.txt"), many.clone())).collect();
    files.push(("src/x.ts".into(), "needle\n".into()));
    files.push(("src/y/z.tsx".into(), "needle\nneedle\n".into()));
    files.push(("src/w.js".into(), "needle\n".into()));
    let files: Vec<(&str, &str)> = files.iter().map(|(p, t)| (p.as_str(), t.as_str())).collect();
    let h = Harness::new(&files).await;
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["src/**/*.{ts,tsx}"], "limit": 5 })).await;
    assert_eq!(paths(&r), ["src/x.ts", "src/y/z.tsx", "src/y/z.tsx"]);
    assert!(!more(&r));
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["src/**/*.{ts,tsx}"], "limit": 2 })).await;
    assert_eq!(paths(&r), ["src/x.ts", "src/y/z.tsx"]);
    assert!(more(&r));
    // A glob that cannot become masks (a comma in a class) is filtered afterwards, without a budget.
    let r = h.call_json("search_regex", json!({ "q": "needle", "paths": ["src/**/*.[t,]s"], "limit": 5 })).await;
    assert_eq!(paths(&r), ["src/x.ts"]);
    assert!(!more(&r));
}

#[tokio::test(flavor = "multi_thread")]
async fn limit_cuts_results_and_reports_more() {
    let h = Harness::new(&[("a.txt", "x x x\nx\nx\n")]).await;
    let r = h.call_json("search_text", json!({ "q": "x", "limit": 3 })).await;
    assert_eq!(items(&r).len(), 3);
    assert!(more(&r));
    let r = h.call_json("search_text", json!({ "q": "x", "limit": 5 })).await;
    assert_eq!(items(&r).len(), 5);
    assert!(!more(&r));
    // Limits above the upper bound are clamped, not refused.
    let r = h.call_json("search_text", json!({ "q": "x", "limit": 1_000_000 })).await;
    assert_eq!(items(&r).len(), 5);
    let err = h.call_err("search_text", json!({ "q": "x", "limit": 0 })).await;
    assert!(err.contains("limit must be > 0"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn searches_unsaved_editor_text() {
    let h = Harness::new(&[("a.txt", "old text\n")]).await;
    let doc = ide_host::ops::doc::open(h.host(), "main", h.path("a.txt")).await.unwrap();
    let change = ChangeSet { changes: vec![TextChange { from: 0, to: 3, insert: "fresh".into() }] };
    ide_host::ops::doc::edit(h.host(), "main", doc.id, doc.version, change).unwrap();
    let r = h.call_json("search_text", json!({ "q": "fresh" })).await;
    assert_eq!(paths(&r), ["a.txt"]);
    // No hits: an empty object.
    let r = h.call_json("search_text", json!({ "q": "old" })).await;
    assert_eq!(r, json!({}));
}

#[tokio::test(flavor = "multi_thread")]
async fn regex_search() {
    let h = Harness::new(&[("a.rs", "fn alpha() {}\nfn beta() {}\nlet x = 1;\n")]).await;
    let r = h.call_json("search_regex", json!({ "q": r"fn (\w+)\(" })).await;
    let e = items(&r);
    assert_eq!(e.len(), 2);
    assert_eq!(
        (e[1]["startLine"].as_u64(), e[1]["startColumn"].as_u64(), e[1]["endColumn"].as_u64()),
        (Some(2), Some(1), Some(9))
    );
    // Case-sensitive unless asked otherwise.
    assert!(items(&h.call_json("search_regex", json!({ "q": "FN" })).await).is_empty());
    assert_eq!(items(&h.call_json("search_regex", json!({ "q": "(?i)FN" })).await).len(), 2);
    // A match across lines is one item.
    let r = h.call_json("search_regex", json!({ "q": r"\{\}\nfn b" })).await;
    assert_eq!(
        r["items"],
        json!([{ "filePath": "a.rs", "startLine": 1, "startColumn": 12, "endLine": 2, "endColumn": 5 }])
    );
    // A literal search does not interpret the pattern.
    assert!(items(&h.call_json("search_text", json!({ "q": "fn (" })).await).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_input_gets_useful_errors() {
    let h = Harness::new(&[("a.txt", "x\n")]).await;
    let err = h.call_err("search_regex", json!({ "q": "foo(" })).await;
    assert!(err.starts_with("Invalid regex pattern: foo("), "{err}");
    let err = h.call_err("search_text", json!({ "q": "" })).await;
    assert_eq!(err, "Search text is empty");
    let err = h.call_err("search_regex", json!({ "q": "  " })).await;
    assert_eq!(err, "Regex pattern is empty");
    let err = h.call_err("search_symbol", json!({ "q": " " })).await;
    assert_eq!(err, "Search query is empty");
    let err = h.call_err("search_file", json!({ "q": "" })).await;
    assert_eq!(err, "Glob pattern is empty");
    let err = h.call_err("search_file", json!({})).await;
    assert!(err.contains("`q`"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn file_search_by_glob() {
    let h = project().await;
    let r = h.call_json("search_file", json!({ "q": "*.rs" })).await;
    assert_eq!(paths(&r), ["src/gen/out.rs", "src/main.rs"]);
    assert!(!more(&r));
    // Only the path: no coordinates.
    assert_eq!(r["items"][0], json!({ "filePath": "src/gen/out.rs" }));
    let r = h.call_json("search_file", json!({ "q": "**/main.rs" })).await;
    assert_eq!(paths(&r), ["src/main.rs"]);
    let r = h.call_json("search_file", json!({ "q": "src/main.rs" })).await;
    assert_eq!(paths(&r), ["src/main.rs"]);
    let r = h.call_json("search_file", json!({ "q": "src/*.rs" })).await;
    assert_eq!(paths(&r), ["src/main.rs"]);
    let r = h.call_json("search_file", json!({ "q": "*.rs", "paths": ["!gen/"] })).await;
    assert_eq!(paths(&r), ["src/gen/out.rs", "src/main.rs"], "`gen/` is anchored at the root");
    let r = h.call_json("search_file", json!({ "q": "*.rs", "paths": ["!src/gen/"] })).await;
    assert_eq!(paths(&r), ["src/main.rs"]);
    let r = h.call_json("search_file", json!({ "q": "*.rs", "paths": ["src/**", "!main.rs"] })).await;
    assert_eq!(paths(&r), ["src/gen/out.rs"]);
    // Every match excluded by `paths`: nothing, and no `more`.
    let r = h.call_json("search_file", json!({ "q": "main.rs", "paths": ["src/**", "!main.rs"] })).await;
    assert_eq!(r, json!({}));
    // Dotfiles are found; ignored files only on request.
    let r = h.call_json("search_file", json!({ "q": ".gitignore" })).await;
    assert_eq!(paths(&r), [".gitignore"]);
    let r = h.call_json("search_file", json!({ "q": "*.txt" })).await;
    assert_eq!(paths(&r), ["unicode.txt"]);
    let r = h.call_json("search_file", json!({ "q": "*.txt", "includeExcluded": true })).await;
    assert_eq!(paths(&r), ["build/skip.txt", "unicode.txt"]);
    // Ignored names (`*.pyc` by default) are left out too.
    std::fs::write(h.path("src/cache.pyc"), "").unwrap();
    assert_eq!(h.call_json("search_file", json!({ "q": "*.pyc" })).await, json!({}));
    let r = h.call_json("search_file", json!({ "q": "**/*", "limit": 2 })).await;
    assert_eq!(items(&r).len(), 2);
    assert!(more(&r));
    let err = h.call_err("search_file", json!({ "q": "src/[" })).await;
    assert!(err.contains("Invalid glob pattern"), "{err}");
    let err = h.call_err("search_file", json!({ "q": "../**/*.rs" })).await;
    assert!(err.contains("outside of the project directory"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn symbol_search() {
    let h = Harness::new(&[
        ("src/order.rs", "pub struct OrderController {\n    id: u32,\n}\n\nfn place_order() {}\n"),
        ("tests/order.rs", "struct OrderControllerTest;\n"),
    ])
    .await;
    let r = h.call_json("search_symbol", json!({ "q": "OrderController" })).await;
    assert!(r.get("partialResultReason").is_none(), "{r}");
    let e = items(&r);
    assert!(!e.is_empty(), "{r}");
    let first = &e[0];
    assert_eq!(first["name"], "OrderController");
    assert_eq!(first["filePath"], "src/order.rs");
    assert_eq!(first["startLine"], 1);
    assert!(first["startColumn"].as_u64().unwrap() >= 1);
    assert!(first["endLine"].as_u64().is_some() && first["endColumn"].as_u64().is_some());
    assert!(paths(&r).contains(&"tests/order.rs".to_owned()));

    let r = h.call_json("search_symbol", json!({ "q": "OCo", "paths": ["src/"] })).await;
    assert_eq!(paths(&r), ["src/order.rs"]);
    // Excludes apply before the limit.
    let r = h.call_json("search_symbol", json!({ "q": "OrderController", "paths": ["!src/**"], "limit": 1 })).await;
    assert_eq!(paths(&r), ["tests/order.rs"]);
    let r = h.call_json("search_symbol", json!({ "q": "OrderController", "limit": 1 })).await;
    assert_eq!((items(&r).len(), more(&r)), (1, true));
    // Without a language server, include_external still answers from the index.
    let r = h.call_json("search_symbol", json!({ "q": "place_order", "include_external": true })).await;
    assert_eq!(r["items"][0]["name"], "place_order");
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_declare_the_shared_result_schema() {
    let h = Harness::new(&[]).await;
    h.initialize("test-client").await;
    let (_, _, body) = h.post(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    let list: Value = serde_json::from_str(&body).unwrap();
    let tools = list["result"]["tools"].as_array().unwrap();
    for name in ["search_text", "search_regex", "search_file", "search_symbol"] {
        let tool = tools.iter().find(|t| t["name"] == name).unwrap();
        let schema = &tool["outputSchema"]["properties"];
        assert!(schema["items"].is_object() && schema["more"].is_object(), "{name}: {tool}");
    }
    let symbol = tools.iter().find(|t| t["name"] == "search_symbol").unwrap();
    assert!(symbol["description"].as_str().unwrap().contains("include_external=true"));
}

#[tokio::test(flavor = "multi_thread")]
async fn matches_far_into_a_long_line_keep_their_columns() {
    // Find in Files reports a 500-column window of a long line; the rest is matched again.
    let line = format!("needle{}needle{}needle\nnext needle\n", "x".repeat(1000), "é".repeat(1000));
    let h = Harness::new(&[("long.txt", line.as_str())]).await;
    let r = h.call_json("search_text", json!({ "q": "needle" })).await;
    let found: Vec<(u64, u64, u64)> = items(&r)
        .iter()
        .map(|e| {
            (e["startLine"].as_u64().unwrap(), e["startColumn"].as_u64().unwrap(), e["endColumn"].as_u64().unwrap())
        })
        .collect();
    assert_eq!(found, [(1, 1, 7), (1, 1007, 1013), (1, 2013, 2019), (2, 6, 12)], "{r}");
    let r = h.call_json("search_regex", json!({ "q": "needle\\nnext" })).await;
    assert_eq!(
        items(&r)[0],
        json!({ "filePath": "long.txt", "startLine": 1, "startColumn": 2013, "endLine": 2, "endColumn": 5 })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unmasked_paths_bound_the_engine_and_report_more() {
    let many = "needle\n".repeat(12_000);
    let h = Harness::new(&[("a/many.txt", many.as_str()), ("src/x.ts", "needle\n")]).await;
    let r = h.call_json("search_text", json!({ "q": "needle", "paths": ["**/*.ts", "**/no,mask"], "limit": 1 })).await;
    assert!(more(&r), "{r}");
}
