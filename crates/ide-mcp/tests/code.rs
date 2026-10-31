//! Code insight tools without language servers (syntax problems, index-based symbol
//! info, call hierarchy symbol lookup, modules and dependencies), plus an opt-in run
//! against gopls. Ported in part from JetBrains' `AnalysisToolsetTest` and
//! `CodeInsightToolsetTest`.

mod common;

use common::Harness;
use serde_json::{Value, json};

const BROKEN_JSON: &str = "{\n  \"größe\": 1 2\n}\n";

fn served(h: &Harness, rel: &str) -> bool {
    h.host().project("main").unwrap().lsp.serves_path(&h.path(rel))
}

fn file_paths(items: &Value) -> Vec<&str> {
    items.as_array().unwrap().iter().map(|i| i["filePath"].as_str().unwrap()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn get_file_problems_reports_syntax_errors_without_a_language_server() {
    let h = Harness::new(&[("broken.json", BROKEN_JSON), ("ok.json", "{\"a\": 1}\n")]).await;
    let r = h.call_json("get_file_problems", json!({ "filePath": "broken.json", "timeout": 5000 })).await;
    assert_eq!(r["filePath"], "broken.json");
    let errors = r["errors"].as_array().unwrap();
    assert!(!errors.is_empty(), "{r}");
    if !served(&h, "broken.json") {
        let p = &errors[0];
        assert_eq!((p["severity"].as_str(), p["line"].as_u64()), (Some("ERROR"), Some(2)), "{r}");
        // UTF-16 columns: `2` is the 14th unit of `  "größe": 1 2`.
        assert!(p["column"].as_u64().unwrap() <= 14, "{r}");
        assert_eq!(p["lineContent"], "  \"größe\": 1 2");
        assert!(r["note"].as_str().unwrap().contains("only syntax errors"), "{r}");
    }
    // JetBrains' `get_file_problems_returns_empty_errors_when_file_is_clean`.
    let ok = h.call_json("get_file_problems", json!({ "filePath": "ok.json", "errorsOnly": false })).await;
    assert_eq!(ok["errors"], json!([]), "{ok}");
    assert!(ok.get("timedOut").is_none(), "{ok}");
    // JetBrains' `get_file_problems_timeout`.
    let r = h.call_json("get_file_problems", json!({ "filePath": "broken.json", "timeout": 0 })).await;
    assert_eq!((&r["errors"], &r["timedOut"]), (&json!([]), &json!(true)), "{r}");
}

#[tokio::test(flavor = "multi_thread")]
async fn get_file_problems_rejects_files_it_cannot_analyse() {
    let h =
        Harness::new(&[("dir/a.txt", "x"), ("Cargo.toml", "[package]\nname = \"p\"\n"), ("target/gen.json", "{\n")])
            .await;
    std::fs::write(h.path("blob.bin"), [0u8, 159, 146, 150, 0, 1, 2, 0]).unwrap();
    assert_eq!(
        h.call_err("get_file_problems", json!({ "filePath": "missing.rs" })).await,
        "File not found: missing.rs"
    );
    assert_eq!(h.call_err("get_file_problems", json!({ "filePath": "dir" })).await, "Not a file: dir");
    let outside = h.dir.path().join("outside.json");
    std::fs::write(&outside, "{}").unwrap();
    let e = h.call_err("get_file_problems", json!({ "filePath": outside.to_str().unwrap() })).await;
    assert!(e.contains("points to the location outside of the project directory"), "{e}");
    let e = h.call_err("get_file_problems", json!({ "filePath": "blob.bin" })).await;
    assert_eq!(e, "File cannot be analyzed: File type is not recognized or not supported for analysis");
    // JetBrains' `get_file_problems_fails_for_not_analyzed_file`.
    let e = h.call_err("get_file_problems", json!({ "filePath": "target/gen.json" })).await;
    assert_eq!(e, "File cannot be analyzed: File is outside project content roots or in an excluded directory");
}

#[tokio::test(flavor = "multi_thread")]
async fn lint_files_lists_files_with_problems_in_request_order() {
    let h = Harness::new(&[
        ("broken.json", BROKEN_JSON),
        ("also/broken.json", "[1,,]\n"),
        ("ok.json", "{}\n"),
        ("dir/x.txt", ""),
    ])
    .await;
    std::fs::write(h.path("blob.bin"), [0u8, 159, 146, 150, 0, 1, 2, 0]).unwrap();
    let r = h
        .call_json(
            "lint_files",
            json!({ "files": ["also/broken.json", "ok.json", "blob.bin", "./also/../broken.json", "broken.json"], "timeout": 20000 }),
        )
        .await;
    // Clean files are left out; duplicates count once.
    assert_eq!(file_paths(&r["items"]), ["also/broken.json", "blob.bin", "broken.json"], "{r}");
    assert!(r.get("more").is_none(), "{r}");
    let items = r["items"].as_array().unwrap();
    assert_eq!(
        items[1],
        json!({ "filePath": "blob.bin", "notAnalyzedReason": "File type is not recognized or not supported for analysis", "problems": [] })
    );
    if !served(&h, "broken.json") {
        let p = &items[2]["problems"][0];
        assert_eq!((p["severity"].as_str(), p["line"].as_u64()), (Some("ERROR"), Some(2)), "{r}");
        assert_eq!(p["lineText"], "  \"größe\": 1 2");
        assert!(p.get("inspectionId").is_none(), "{r}");
    }

    // JetBrains' `lint_files_returns_empty_items_when_all_files_are_clean` and `lint_files_timeout`.
    let clean = h.call_json("lint_files", json!({ "files": ["ok.json"], "min_severity": "error" })).await;
    assert_eq!(clean, json!({ "items": [] }));
    let r = h.call_json("lint_files", json!({ "files": ["broken.json"], "timeout": 0 })).await;
    assert_eq!(r, json!({ "items": [], "more": true }));

    let e = h.call_err("lint_files", json!({ "files": ["broken.json", "missing.json"] })).await;
    assert_eq!(e, "File not found: missing.json");
    assert_eq!(h.call_err("lint_files", json!({ "files": ["dir"] })).await, "Not a file: dir");
    assert_eq!(h.call_err("lint_files", json!({ "files": [] })).await, "files must contain at least one path");
    assert_eq!(h.call_err("lint_files", json!({ "files": [" "] })).await, "files must not contain blank paths");
    // JetBrains' `lint_files_rejects_unknown_min_severity`.
    let e = h.call_err("lint_files", json!({ "files": ["ok.json"], "min_severity": "unknown" })).await;
    assert_eq!(e, "min_severity must be one of: warning, strong_warning, error");
    let r = h.call_json("lint_files", json!({ "files": ["ok.json"], "min_severity": "STRONG_WARNING" })).await;
    assert_eq!(r["items"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn lint_files_reports_excluded_files() {
    let h = Harness::new(&[("Cargo.toml", "[package]\nname = \"p\"\n"), ("target/gen.json", "{\n"), ("a.json", "{\n")])
        .await;
    let r = h.call_json("lint_files", json!({ "files": ["a.json", "target/gen.json"] })).await;
    assert_eq!(file_paths(&r["items"]), ["a.json", "target/gen.json"], "{r}");
    assert_eq!(r["items"][1]["notAnalyzedReason"], "File is outside project content roots or in an excluded directory");
}

#[tokio::test(flavor = "multi_thread")]
async fn symbol_info_falls_back_to_the_index() {
    let src = "// Doubles nothing.\nfunction größe(a) {\n  return a;\n}\nconst v = größe(1); // 😀 größe\n";
    let h = Harness::new(&[("lib.js", src)]).await;
    // `größe` in the call on line 5 starts at character 11.
    let r = h.call_json("get_symbol_info", json!({ "filePath": "lib.js", "line": 5, "column": 12 })).await;
    let info = &r["symbolInfo"];
    assert_eq!(info["name"], "größe", "{r}");
    assert_eq!((info["declarationFile"].as_str(), info["declarationLine"].as_u64()), (Some("lib.js"), Some(2)), "{r}");
    assert_eq!(info["declarationText"], "<…>\n// Doubles nothing.\nfunction größe(a) {\n  return a;\n<…>", "{r}");
    assert_eq!(info["language"], "JavaScript", "{r}");
    assert!(r["documentation"].is_string(), "{r}");
    if !served(&h, "lib.js") {
        assert_eq!(r["documentation"], "");
        assert!(r["partialResultReason"].as_str().unwrap().contains("No language server"), "{r}");
        // After the emoji (one character, two UTF-16 units).
        let after = h.call_json("get_symbol_info", json!({ "filePath": "lib.js", "line": 5, "column": 28 })).await;
        assert_eq!(after["symbolInfo"]["name"], "größe", "{after}");
    }

    let e = h.call_err("get_symbol_info", json!({ "filePath": "lib.js", "line": 9, "column": 1 })).await;
    assert_eq!(e, "Line number is out of bounds of the document");
    let e = h.call_err("get_symbol_info", json!({ "filePath": "lib.js", "line": 0, "column": 1 })).await;
    assert_eq!(e, "Line number is out of bounds of the document");
    let e = h.call_err("get_symbol_info", json!({ "filePath": "lib.js", "line": 3, "column": 50 })).await;
    assert_eq!(e, "Line and column 3:50 is out of bounds (line 3 has 11 characters)");
    let e = h.call_err("get_symbol_info", json!({ "filePath": "nope.js", "line": 1, "column": 1 })).await;
    assert_eq!(e, "File not found: nope.js");
}

#[tokio::test(flavor = "multi_thread")]
async fn leaves_the_users_documents_open() {
    let h = Harness::new(&[("a.json", "{}\n"), ("b.json", "{\n")]).await;
    let project = h.host().project("main").unwrap();
    let doc = project.documents.open(&h.path("a.json")).unwrap().id;
    h.call_json("get_file_problems", json!({ "filePath": "a.json", "timeout": 3000 })).await;
    h.call_json("get_symbol_info", json!({ "filePath": "a.json", "line": 1, "column": 1 })).await;
    assert_eq!(project.documents.by_path(&h.path("a.json")), Some(doc));
    h.call_json("get_file_problems", json!({ "filePath": "b.json", "timeout": 3000 })).await;
    assert_eq!(project.documents.by_path(&h.path("b.json")), None);
    project.documents.close(doc);
    assert_eq!(project.documents.by_path(&h.path("a.json")), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn analyze_calls_resolves_symbols_like_jetbrains() {
    let h = Harness::new(&[
        ("a/one.js", "function run() {}\nclass Job { run(n) {} }\n"),
        ("b/two.js", "function run() {}\n"),
        ("calls/CallGraph.java", "class CallGraph {\n  void overloaded() {}\n  void overloaded(String s) {}\n}\n"),
    ])
    .await;
    let args = |fqn: &str| json!({ "symbolFqn": fqn, "analysisKind": "INCOMING_CALLS", "timeout": 5000 });
    // JetBrains' `analyze_calls_keeps_short_kotlin_name_ambiguous`.
    let e = h.call_err("analyze_calls", args("run")).await;
    assert!(e.starts_with("Ambiguous symbolFqn `run`. Pass one exact signature as `symbolFqn`:\n- "), "{e}");
    for sig in ["a.one.run()", "a.one.Job.run(n)", "b.two.run()"] {
        assert!(e.contains(&format!("\n  symbolFqn: {sig}")), "{sig} in {e}");
    }
    // JetBrains' `analyze_calls_reports_ambiguity_with_exact_signatures`.
    let e = h.call_err("analyze_calls", args("CallGraph.overloaded")).await;
    assert!(e.contains("symbolFqn: calls.CallGraph.overloaded()"), "{e}");
    assert!(e.contains("symbolFqn: calls.CallGraph.overloaded(String s)"), "{e}");
    // JetBrains' `analyze_calls_treats_legacy_persisted_signature_as_plain_symbol_input`.
    let e = h.call_err("analyze_calls", args("ij-call:v1:invalid")).await;
    assert!(e.starts_with("No callable symbol found for symbolFqn `ij-call:v1:invalid`."), "{e}");
    assert!(h.call_err("analyze_calls", args("nothingLikeThis")).await.contains("No callable symbol found"));

    let bad = |extra: Value| {
        let mut a = args("run");
        a.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        a
    };
    assert_eq!(h.call_err("analyze_calls", bad(json!({ "depth": -1 }))).await, "depth must not be negative");
    assert_eq!(h.call_err("analyze_calls", bad(json!({ "maxChildren": 0 }))).await, "maxChildren must be positive");
    assert_eq!(h.call_err("analyze_calls", bad(json!({ "maxNodes": 0 }))).await, "maxNodes must be positive");
    assert_eq!(
        h.call_err("analyze_calls", bad(json!({ "childOffset": -2 }))).await,
        "childOffset must not be negative"
    );
    assert_eq!(h.call_err("analyze_calls", bad(json!({ "symbolFqn": "  " }))).await, "symbolFqn must not be blank");
    let e = h.call_err("analyze_calls", json!({ "symbolFqn": "run", "analysisKind": "SIDEWAYS" })).await;
    assert!(e.contains("INCOMING_CALLS"), "{e}");

    // Exact signatures, short qualified names and parameter types pick one symbol; without a
    // language server the call then stops at the call hierarchy itself.
    for (fqn, file) in [
        ("b.two.run()", "b/two.js"),
        ("Job.run", "a/one.js"),
        ("a.one.run()", "a/one.js"),
        ("CallGraph.overloaded(String)", "calls/CallGraph.java"),
        ("calls.CallGraph.overloaded()", "calls/CallGraph.java"),
    ] {
        if !served(&h, file) {
            let e = h.call_err("analyze_calls", args(fqn)).await;
            assert_eq!(e, format!("No installed language server serves {file}; call hierarchy needs one."), "{fqn}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_modules_and_dependencies() {
    let h = Harness::new(&[
        (
            "package.json",
            r#"{ "name": "web", "dependencies": { "react": "^18.0.0" }, "devDependencies": { "vitest": "1" } }"#,
        ),
        ("crates/core/Cargo.toml", "[package]\nname = \"core\"\n[dependencies]\nserde = \"1\"\n"),
        ("crates/core/src/lib.rs", ""),
        ("svc/go.mod", "module example.com/svc\n\nrequire github.com/x/y v1.0.0\n"),
        ("node_modules/left-pad/package.json", r#"{ "name": "left-pad" }"#),
    ])
    .await;
    let r = h.call_json("get_project_modules", json!({})).await;
    let modules = r["modules"].as_array().unwrap();
    let find = |kind: &str| modules.iter().find(|m| m["type"] == kind).unwrap_or_else(|| panic!("{kind} in {r}"));
    assert_eq!((find("npm")["name"].as_str(), find("npm")["path"].as_str()), (Some("web"), Some(".")));
    assert_eq!((find("cargo")["name"].as_str(), find("cargo")["path"].as_str()), (Some("core"), Some("crates/core")));
    assert_eq!(find("go")["name"], "example.com/svc");
    assert!(!modules.iter().any(|m| m["name"] == "left-pad"), "{r}");

    let r = h.call_json("get_project_dependencies", json!({})).await;
    let deps = r["dependencies"].as_array().unwrap();
    let dep = |name: &str| deps.iter().find(|d| d["name"] == name).unwrap_or_else(|| panic!("{name} in {r}")).clone();
    assert_eq!(
        dep("react"),
        json!({ "name": "react", "version": "^18.0.0", "dependencyType": "dependencies", "source": "package.json" })
    );
    assert_eq!(dep("vitest")["dependencyType"], "devDependencies");
    assert_eq!(dep("serde")["source"], "crates/core/Cargo.toml");
    assert_eq!(dep("github.com/x/y")["version"], "v1.0.0");
    assert!(r.get("libraries").is_some() || r.get("librariesTimedOut").is_some() || r.get("librariesError").is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn declares_output_schemas() {
    let h = Harness::new(&[]).await;
    h.initialize("test-client").await;
    let (_, _, body) = h.post(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    let list: Value = serde_json::from_str(&body).unwrap();
    let tools = list["result"]["tools"].as_array().unwrap();
    let schema = |name: &str| {
        tools.iter().find(|t| t["name"] == name).unwrap_or_else(|| panic!("{name}"))["outputSchema"].clone()
    };
    assert_eq!(schema("lint_files")["required"], json!(["items"]));
    assert_eq!(schema("get_file_problems")["required"], json!(["filePath", "errors"]));
    assert_eq!(schema("get_symbol_info")["required"], json!(["documentation"]));
    assert_eq!(schema("get_project_modules")["required"], json!(["modules"]));
    assert_eq!(schema("get_project_dependencies")["required"], json!(["dependencies"]));
    assert!(schema("analyze_calls").is_null());
}

/// Against a real gopls; opt in with `OPENIDEA_MCP_LSP_TESTS=1` (slow, needs the server installed).
#[tokio::test(flavor = "multi_thread")]
async fn uses_the_language_server_when_installed() {
    if std::env::var_os("OPENIDEA_MCP_LSP_TESTS").is_none() {
        return;
    }
    let src = "package demo\n\n// AddOne adds one.\nfunc AddOne(x int) int {\n\treturn x + 1\n}\n\n\
func Caller() int {\n\treturn AddOne(2) + AddOne(3)\n}\n\nfunc Other() int {\n\treturn AddOne(4)\n}\n\n\
func Broken() int {\n\treturn \"no\"\n}\n";
    let h = Harness::new(&[("go.mod", "module demo\n\ngo 1.21\n"), ("demo.go", src)]).await;
    if !served(&h, "demo.go") {
        eprintln!("gopls is not installed; skipping");
        return;
    }
    let r = h.call_json("get_file_problems", json!({ "filePath": "demo.go", "timeout": 60000 })).await;
    eprintln!("problems: {r}");
    assert_eq!(r["errors"][0]["line"], 17, "{r}");
    assert_eq!(r["errors"][0]["lineContent"], "\treturn \"no\"", "{r}");
    let lint = h.call_json("lint_files", json!({ "files": ["demo.go", "go.mod"], "timeout": 60000 })).await;
    eprintln!("lint: {lint}");
    assert_eq!(file_paths(&lint["items"]), ["demo.go"], "{lint}");
    let info = h.call_json("get_symbol_info", json!({ "filePath": "demo.go", "line": 9, "column": 10 })).await;
    eprintln!("symbol info: {info}");
    assert_eq!(info["symbolInfo"]["declarationLine"], 4, "{info}");
    assert!(info["symbolInfo"]["declarationText"].as_str().unwrap().contains("// AddOne adds one."), "{info}");
    assert!(info["documentation"].as_str().unwrap().contains("AddOne"), "{info}");

    let incoming = |extra: Value| {
        let mut a = json!({ "symbolFqn": "AddOne", "analysisKind": "INCOMING_CALLS", "timeout": 60000 });
        a.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        a
    };
    let calls = h.call("analyze_calls", incoming(json!({}))).await;
    eprintln!("calls:\n{calls}");
    assert!(calls.starts_with("└─ + AddOne(x int) [filePath=\"demo.go\", treePath=[]]\n"), "{calls}");
    assert!(calls.contains("   ├─ Caller() [2 usages, filePath=\"demo.go\", treePath=[\"demo.Caller()\"]]"), "{calls}");
    assert!(calls.contains("   └─ Other() [filePath=\"demo.go\", treePath=[\"demo.Other()\"]]"), "{calls}");
    // JetBrains' `analyze_calls_renders_child_limit_with_more_line` and `…_past_last_child`.
    let paged = h.call("analyze_calls", incoming(json!({ "depth": 1, "maxChildren": 1 }))).await;
    assert!(paged.ends_with("   └─ … and 1 more [treePath=[], childOffset=1]"), "{paged}");
    let past = h.call("analyze_calls", incoming(json!({ "depth": 1, "childOffset": 999 }))).await;
    assert!(past.ends_with("└─ … no more children [treePath=[], childOffset=999, totalChildren=2]"), "{past}");
    let capped = h.call("analyze_calls", incoming(json!({ "depth": 1, "maxNodes": 1 }))).await;
    assert!(capped.contains("… and 2 more [treePath=[], childOffset=0]"), "{capped}");
    let root_only = h.call("analyze_calls", incoming(json!({ "depth": 0 }))).await;
    assert_eq!(root_only, "└─ + AddOne(x int) [filePath=\"demo.go\", treePath=[]]");
    let sub = h.call("analyze_calls", incoming(json!({ "treePath": ["demo.Caller()"] }))).await;
    assert!(sub.starts_with("└─ Caller() [2 usages, filePath=\"demo.go\", treePath=[\"demo.Caller()\"]]"), "{sub}");
    let e = h.call_err("analyze_calls", incoming(json!({ "treePath": ["demo.Nope()"] }))).await;
    assert!(e.starts_with("treePath component not found under []."), "{e}");

    let out = h
        .call(
            "analyze_calls",
            json!({ "symbolFqn": "demo.Caller()", "analysisKind": "OUTGOING_CALLS", "timeout": 60000 }),
        )
        .await;
    eprintln!("outgoing:\n{out}");
    assert!(out.contains("AddOne(x int) [2 usages"), "{out}");
    let project = h.host().project("main").unwrap();
    assert_eq!(project.documents.by_path(&h.path("demo.go")), None);
}
