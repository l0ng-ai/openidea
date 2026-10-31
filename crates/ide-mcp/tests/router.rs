// Ported from JetBrains intellij-community plugins/mcp-server (tests/testSrc/com/intellij/mcpserver/toolsets/UniversalToolsetTest.kt), Apache-2.0.
//! `execute_tool`: command parsing, argument conversion, dispatch, denials and history.

mod common;

use common::Harness;
use ide_core::mcp::{McpCallOutcome, McpInvocationMode, McpSettings};
use ide_mcp::tools::universal::{parse_args_to_json, parse_command_line, resolve_flag_name};
use serde_json::{Map, Value, json};

const FILES: &[(&str, &str)] = &[
    ("src/Main.java", "class Main {}\n"),
    ("src/Test.java", "class Test {}\n"),
    ("src/Class.java", "class Class {}\n"),
    ("notes.txt", "one\ntwo\nthree\nfour\nfive\n"),
];

fn schema(props: Value) -> Map<String, Value> {
    props.as_object().unwrap().clone()
}

fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

async fn routed() -> Harness {
    let h = Harness::new(FILES).await;
    h.server.apply(&McpSettings { invocation_mode: McpInvocationMode::ViaRouter, ..Default::default() }).await;
    h
}

async fn route(h: &Harness, command: &str) -> String {
    h.call("execute_tool", json!({ "command": command })).await
}

async fn route_err(h: &Harness, command: &str) -> String {
    h.call_err("execute_tool", json!({ "command": command })).await
}

fn file_paths(text: &str) -> Vec<String> {
    let v: Value = serde_json::from_str(text).unwrap();
    v["entries"].as_array().unwrap().iter().map(|e| e["filePath"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn searches_files_by_name_and_glob() {
    let h = routed().await;
    assert!(file_paths(&route(&h, "search_file --q Test.java").await).contains(&"src/Test.java".to_owned()));
    let all = file_paths(&route(&h, "search_file --q **/*.java").await);
    for f in ["src/Main.java", "src/Test.java", "src/Class.java"] {
        assert!(all.contains(&f.to_owned()), "{all:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn converts_integers_and_arrays() {
    let h = routed().await;
    let text = route(&h, "search_file --q **/*.java --limit 1").await;
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["entries"].as_array().unwrap().len(), 1);
    assert_eq!(v["more"], true);
    let text = route(&h, r#"search_file --q **/*.java --paths '["src/Test.java"]'"#).await;
    assert_eq!(file_paths(&text), ["src/Test.java"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn creates_files_with_boolean_parameters() {
    let h = routed().await;
    route(&h, "create_new_file --pathInProject src/NewFile.java").await;
    assert!(h.path("src/NewFile.java").is_file());
    route(&h, r#"create_new_file --pathInProject src/NewFile.java --text "class X {}" --overwrite true"#).await;
    assert_eq!(std::fs::read_to_string(h.path("src/NewFile.java")).unwrap(), "class X {}");
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_a_window_given_a_last_line() {
    let h = routed().await;
    let text = route(&h, "read_file --file_path notes.txt --offset 2 --end_line 3").await;
    assert!(text.contains("two") && text.contains("three"), "{text}");
    assert!(!text.contains("four") && !text.contains("one"), "{text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_unknown_tools_and_bad_commands() {
    let h = routed().await;
    let e = route_err(&h, "nonexistent_tool --param value").await;
    assert!(e.contains("Tool 'nonexistent_tool' not found"), "{e}");
    let e = route_err(&h, "search_files --q x").await;
    assert!(e.contains("not found. Did you mean: ") && e.contains("search_file"), "{e}");
    assert_eq!(route_err(&h, "").await, "Command is empty");
    let e = route_err(&h, "search_file --q Test.java --line_end 240").await;
    assert!(e.contains("Unknown parameter '--line_end'"), "{e}");
    let e = route_err(&h, "read_file").await;
    assert!(e.starts_with("Missing required parameters: file_path. Accepted: "), "{e}");
    let e = route_err(&h, "read_file invalidarg").await;
    assert!(e.contains("Invalid argument format: 'invalidarg'"), "{e}");
    let e = route_err(&h, "execute_tool --command x").await;
    assert!(e.contains("Tool 'execute_tool' not found"), "the router does not route to itself: {e}");
    let e = route_err(&h, "read_file --file_path missing.txt").await;
    assert!(e.starts_with("Tool execution failed: [error]: "), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn does_not_route_to_disabled_tools() {
    let h = Harness::new(FILES).await;
    h.server.apply(&McpSettings { disabled_tools: vec!["search_file".into()], ..Default::default() }).await;
    let e = route_err(&h, "search_file --q *.java").await;
    assert!(e.contains("Tool 'search_file' not found"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn routed_tools_still_ask_before_running() {
    let h = routed().await;
    *h.ui.answer.lock() = Value::Bool(false);
    let e = route_err(&h, "execute_terminal_command --command \"echo hi\"").await;
    assert!(e.contains("The user declined this"), "{e}");
    assert_eq!(h.ui.asked.lock().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn records_the_router_and_the_routed_call() {
    let h = routed().await;
    route(&h, "search_file --q Main.java").await;
    route_err(&h, "nonexistent_tool").await;
    let history = h.server.call_history();
    let summary: Vec<_> = history.iter().map(|c| (c.tool.as_str(), c.via_router, c.outcome)).collect();
    assert_eq!(
        summary,
        [
            ("execute_tool", false, McpCallOutcome::Error),
            ("search_file", true, McpCallOutcome::Success),
            ("execute_tool", false, McpCallOutcome::Success),
        ]
    );
    assert_eq!(history[1].arguments, r#"{"q":"Main.java"}"#);
    assert!(history.iter().all(|c| c.client == "test-client" && c.duration_ms.is_some()));
}

// --- parsing -------------------------------------------------------------------------

#[test]
fn splits_command_lines_like_a_shell() {
    assert_eq!(parse_command_line(r#"a --b 'c d' --e "f \"g\"" "#), ["a", "--b", "c d", "--e", "f \"g\""]);
    assert_eq!(
        parse_command_line(r"read_file --file_path C:\src\a.txt"),
        ["read_file", "--file_path", r"C:\src\a.txt"]
    );
    assert!(parse_command_line("   ").is_empty());
}

#[test]
fn parses_array_and_object_parameters() {
    let s = schema(json!({ "items": { "type": "array" }, "payload": { "type": "object" } }));
    let v = parse_args_to_json(&args(&["--items", r#"["first","second"]"#, "--payload", r#"{"enabled":true}"#]), &s)
        .unwrap();
    assert_eq!(v["items"], json!(["first", "second"]));
    assert_eq!(v["payload"], json!({ "enabled": true }));
    let v = parse_args_to_json(&args(&["--payload", "[]"]), &s).unwrap();
    assert_eq!(v["payload"], json!([]), "an array passes for an object schema");
}

#[test]
fn rejects_malformed_or_misshaped_structured_parameters() {
    let s = schema(json!({ "items": { "type": "array" } }));
    let e = parse_args_to_json(&args(&["--items", "not-json"]), &s).unwrap_err();
    assert!(e.message.contains("Parameter 'items' expects a JSON array"), "{}", e.message);
    let e = parse_args_to_json(&args(&["--items", r#"{"enabled":true}"#]), &s).unwrap_err();
    assert!(e.message.contains("Parameter 'items' expects a JSON array, got JsonObject"), "{}", e.message);
}

#[test]
fn resolves_flag_names_by_folding_case_and_separators() {
    let s = schema(json!({ "file_path": { "type": "string" }, "offset": { "type": "integer" } }));
    assert_eq!(resolve_flag_name("file_path", &s).as_deref(), Some("file_path"));
    assert_eq!(resolve_flag_name("filePath", &s).as_deref(), Some("file_path"));
    assert_eq!(resolve_flag_name("filepath", &s).as_deref(), Some("file_path"));
    assert_eq!(resolve_flag_name("line_end", &s), None);
    assert_eq!(resolve_flag_name("nonsense", &s), None);
    let camel = schema(json!({ "filePath": { "type": "string" }, "errorsOnly": { "type": "boolean" } }));
    assert_eq!(resolve_flag_name("file_path", &camel).as_deref(), Some("filePath"));
    assert_eq!(resolve_flag_name("errors_only", &camel).as_deref(), Some("errorsOnly"));

    let v = parse_args_to_json(&args(&["--filePath", "src/Main.java", "--Offset", "10"]), &s).unwrap();
    assert_eq!(v["file_path"], "src/Main.java");
    assert_eq!(v["offset"], 10);
}

#[test]
fn converts_a_last_line_into_a_limit() {
    let s = schema(
        json!({ "file_path": { "type": "string" }, "offset": { "type": "integer" }, "limit": { "type": "integer" } }),
    );
    let v =
        parse_args_to_json(&args(&["--file_path", "src/Main.java", "--offset", "10", "--end_line", "29"]), &s).unwrap();
    assert_eq!((v["offset"].clone(), v["limit"].clone()), (json!(10), json!(20)));
    let v = parse_args_to_json(&args(&["--file_path", "src/Main.java", "--end-line", "90"]), &s).unwrap();
    assert_eq!(v["limit"], 90);
    assert!(v.get("offset").is_none());

    let e = parse_args_to_json(&args(&["--file_path", "a", "--limit", "5", "--line_end", "999"]), &s).unwrap_err();
    assert!(e.message.contains("--limit") && e.message.contains("--line_end"), "{}", e.message);
    let e = parse_args_to_json(&args(&["--file_path", "a", "--offset", "100", "--end_line", "20"]), &s).unwrap_err();
    assert!(e.message.contains("--end_line") && e.message.contains("100"), "{}", e.message);

    // `search_file`'s limit counts hits, not lines.
    let search = schema(json!({ "q": { "type": "string" }, "limit": { "type": "integer" } }));
    let e = parse_args_to_json(&args(&["--q", "Test.java", "--end_line", "240"]), &search).unwrap_err();
    assert!(e.message.contains("Unknown parameter '--end_line'"), "{}", e.message);
}

#[test]
fn rejects_unknown_parameters_unless_the_schema_is_empty() {
    let s = schema(json!({ "file_path": { "type": "string" }, "limit": { "type": "integer" } }));
    let e = parse_args_to_json(&args(&["--recursive", "true"]), &s).unwrap_err();
    assert!(
        e.message.contains("Unknown parameter '--recursive'") && e.message.contains("--file_path"),
        "{}",
        e.message
    );
    let v = parse_args_to_json(&args(&["--anything", "value"]), &Map::new()).unwrap();
    assert_eq!(v["anything"], "value");
    let e = parse_args_to_json(&args(&["--file_path"]), &s).unwrap_err();
    assert_eq!(e.message, "Parameter 'file_path' requires a value");
}
