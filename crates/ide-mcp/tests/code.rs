//! Code insight tools without language servers: syntax problems, index-based
//! symbol info, call hierarchy symbol lookup, modules and dependencies.

mod common;

use common::Harness;
use serde_json::json;

const BROKEN_JSON: &str = "{\n  \"größe\": 1 2\n}\n";

fn served(h: &Harness, rel: &str) -> bool {
    h.host().project("main").unwrap().lsp.serves_path(&h.path(rel))
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_syntax_errors_without_a_language_server() {
    let h = Harness::new(&[("broken.json", BROKEN_JSON), ("ok.json", "{\"a\": 1}\n")]).await;
    let r = h.call_json("get_file_problems", json!({ "filePath": "broken.json", "timeout": 5000 })).await;
    assert_eq!(r["filePath"], "broken.json");
    let problems = r["problems"].as_array().unwrap();
    assert!(!problems.is_empty(), "{r}");
    if !served(&h, "broken.json") {
        assert_eq!(r["analysis"], "syntax");
        let p = &problems[0];
        assert_eq!((p["severity"].as_str(), p["line"].as_u64()), (Some("ERROR"), Some(2)), "{r}");
        // Characters, not bytes / UTF-16: `2` is the 14th character of `  "größe": 1 2`.
        assert!(p["column"].as_u64().unwrap() <= 14, "{r}");
        assert_eq!(p["lineContent"], "\"größe\": 1 2");
    }
    let ok = h.call_json("get_file_problems", json!({ "filePath": "ok.json", "errorsOnly": false })).await;
    assert_eq!(ok["problems"], json!([]), "{ok}");
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_files_it_cannot_analyse() {
    let h = Harness::new(&[("dir/a.txt", "x")]).await;
    assert!(h.call_err("get_file_problems", json!({ "filePath": "missing.rs" })).await.contains("not found"));
    assert!(h.call_err("get_file_problems", json!({ "filePath": "dir" })).await.contains("directory"));
    let outside = h.dir.path().join("outside.json");
    std::fs::write(&outside, "{}").unwrap();
    let e = h.call_err("get_file_problems", json!({ "filePath": outside.to_str().unwrap() })).await;
    assert!(e.contains("outside the project"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn lints_files_one_entry_each() {
    let h = Harness::new(&[("broken.json", BROKEN_JSON), ("ok.json", "{}\n"), ("dir/x.txt", "")]).await;
    std::fs::write(h.path("blob.bin"), [0u8, 159, 146, 150, 0, 1, 2, 0]).unwrap();
    let r = h
        .call_json(
            "lint_files",
            json!({ "files": ["broken.json", "ok.json", "missing.json", "dir", "blob.bin"], "timeout": 10000 }),
        )
        .await;
    let files = r["files"].as_array().unwrap();
    let by = |p: &str| files.iter().find(|f| f["filePath"] == p).unwrap_or_else(|| panic!("{p} in {r}")).clone();
    assert!(!by("broken.json")["problems"].as_array().unwrap().is_empty());
    assert_eq!(by("ok.json")["problems"], json!([]));
    assert_eq!(by("missing.json")["notAnalyzedReason"], "not found");
    assert_eq!(by("dir")["notAnalyzedReason"], "directory");
    assert_eq!(by("blob.bin")["notAnalyzedReason"], "binary file");
    assert!(r.get("more").is_none(), "{r}");
    assert!(h.call_err("lint_files", json!({ "files": [] })).await.contains("at least one"));
    assert!(h.call_err("lint_files", json!({ "files": ["a"], "min_severity": "hint" })).await.contains("min_severity"));
}

#[tokio::test(flavor = "multi_thread")]
async fn symbol_info_falls_back_to_the_index() {
    let src = "function größe(a) {\n  return a;\n}\nconst v = größe(1); // 😀 größe\n";
    let h = Harness::new(&[("lib.js", src)]).await;
    // `größe` in the call on line 4 starts at character 11.
    let r = h.call_json("get_symbol_info", json!({ "filePath": "lib.js", "line": 4, "column": 12 })).await;
    assert_eq!(r["symbol"], "größe", "{r}");
    let decls = r["declarations"].as_array().unwrap();
    assert!(!decls.is_empty(), "{r}");
    assert_eq!((decls[0]["filePath"].as_str(), decls[0]["line"].as_u64()), (Some("lib.js"), Some(1)), "{r}");
    assert!(decls[0]["snippet"].as_str().unwrap().starts_with("1\tfunction größe(a) {"), "{r}");
    if !served(&h, "lib.js") {
        assert_eq!(r["source"], "index");
        // After the emoji (one character, two UTF-16 units).
        let after = h.call_json("get_symbol_info", json!({ "filePath": "lib.js", "line": 4, "column": 28 })).await;
        assert_eq!(after["symbol"], "größe", "{after}");
    }

    let e = h.call_err("get_symbol_info", json!({ "filePath": "lib.js", "line": 9, "column": 1 })).await;
    assert!(e.contains("past the end of the file"), "{e}");
    let e = h.call_err("get_symbol_info", json!({ "filePath": "lib.js", "line": 2, "column": 50 })).await;
    assert!(e.contains("past the end of line 2"), "{e}");
    let e = h.call_err("get_symbol_info", json!({ "filePath": "lib.js", "line": 0, "column": 1 })).await;
    assert!(e.contains("1-based"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn leaves_the_users_documents_open() {
    let h = Harness::new(&[("a.json", "{}\n"), ("b.json", "{\n")]).await;
    let project = h.host().project("main").unwrap();
    let doc = project.documents.open(&h.path("a.json")).unwrap().id;
    h.call_json("get_file_problems", json!({ "filePath": "a.json", "timeout": 3000 })).await;
    h.call_json("get_symbol_info", json!({ "filePath": "a.json", "line": 1, "column": 1, "timeout": 3000 })).await;
    assert_eq!(project.documents.by_path(&h.path("a.json")), Some(doc));
    h.call_json("get_file_problems", json!({ "filePath": "b.json", "timeout": 3000 })).await;
    assert_eq!(project.documents.by_path(&h.path("b.json")), None);
    project.documents.close(doc);
    assert_eq!(project.documents.by_path(&h.path("a.json")), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn analyze_calls_locates_the_symbol() {
    let h = Harness::new(&[
        ("a/one.js", "function run() {}\nclass Job { run() {} }\n"),
        ("b/two.js", "function run() {}\n"),
    ])
    .await;
    let args = |fqn: &str| json!({ "symbolFqn": fqn, "analysisKind": "INCOMING_CALLS", "timeout": 5000 });
    let text = h.call("analyze_calls", args("run")).await;
    assert!(text.contains("matches 3 symbols"), "{text}");
    assert!(text.contains("a/one.Job.run") && text.contains("b/two.run"), "{text}");
    assert!(h.call_err("analyze_calls", args("nothingLikeThis")).await.contains("No symbol matches"));
    let e = h.call_err("analyze_calls", json!({ "symbolFqn": "run", "analysisKind": "SIDEWAYS" })).await;
    assert!(e.contains("INCOMING_CALLS"), "{e}");
    if !served(&h, "b/two.js") {
        let e = h.call_err("analyze_calls", args("two.run")).await;
        assert!(e.contains("No installed language server"), "{e}");
        let e = h.call_err("analyze_calls", args("Job.run")).await;
        assert!(e.contains("a/one.js"), "{e}");
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

/// Against a real gopls; opt in with `OPENIDEA_MCP_LSP_TESTS=1` (slow, needs the server installed).
#[tokio::test(flavor = "multi_thread")]
async fn uses_the_language_server_when_installed() {
    if std::env::var_os("OPENIDEA_MCP_LSP_TESTS").is_none() {
        return;
    }
    let src = "package demo\n\n// AddOne adds one.\nfunc AddOne(x int) int {\n\treturn x + 1\n}\n\n\
func Caller() int {\n\treturn AddOne(2)\n}\n\nfunc Broken() int {\n\treturn \"no\"\n}\n";
    let h = Harness::new(&[("go.mod", "module demo\n\ngo 1.21\n"), ("demo.go", src)]).await;
    if !served(&h, "demo.go") {
        eprintln!("gopls is not installed; skipping");
        return;
    }
    let r = h.call_json("get_file_problems", json!({ "filePath": "demo.go", "timeout": 60000 })).await;
    eprintln!("problems: {r}");
    assert_eq!(r["analysis"], "languageServer", "{r}");
    assert_eq!(r["problems"][0]["line"], 13, "{r}");
    let info = h
        .call_json("get_symbol_info", json!({ "filePath": "demo.go", "line": 9, "column": 10, "timeout": 60000 }))
        .await;
    eprintln!("symbol info: {info}");
    assert_eq!(info["declarations"][0]["line"], 4, "{info}");
    let calls = h
        .call("analyze_calls", json!({ "symbolFqn": "AddOne", "analysisKind": "INCOMING_CALLS", "timeout": 60000 }))
        .await;
    eprintln!("calls:\n{calls}");
    assert!(calls.contains("Caller"), "{calls}");
    let out = h
        .call("analyze_calls", json!({ "symbolFqn": "Caller", "analysisKind": "OUTGOING_CALLS", "timeout": 60000 }))
        .await;
    eprintln!("outgoing:\n{out}");
    assert!(out.contains("AddOne"), "{out}");
    let project = h.host().project("main").unwrap();
    assert_eq!(project.documents.by_path(&h.path("demo.go")), None);
}
