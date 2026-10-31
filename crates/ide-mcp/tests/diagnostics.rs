// Ported from JetBrains intellij-community plugins/mcp-server (tests/testSrc/com/intellij/mcpserver/toolsets/DiagnosticsToolsetTest.kt), Apache-2.0.
//! `get_ide_diagnostics` and the call history.

mod common;

use common::Harness;
use ide_core::mcp::{McpCallOutcome, McpSettings};
use ide_mcp::history::{CallHistory, Ended, MAX_CALLS, summarize_arguments};
use ide_mcp::tools::diagnostics::recent_log_problems;
use serde_json::{Map, Value, json};

fn object(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn is_experimental_and_off_by_default() {
    let h = Harness::new(&[]).await;
    let (_, _, body) = h
        .post(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "get_ide_diagnostics" } }))
        .await;
    assert!(body.contains("unknown tool `get_ide_diagnostics`"), "{body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_the_server_calls_language_servers_and_index() {
    let h = Harness::new(&[("a.txt", "hello\n")]).await;
    h.server.apply(&McpSettings { experimental_tools: true, ..Default::default() }).await;
    h.call("read_file", json!({ "file_path": "a.txt" })).await;
    h.call_err("read_file", json!({ "file_path": "missing.txt" })).await;

    let v = h.call_json("get_ide_diagnostics", json!({ "maxToolCalls": 2 })).await;
    assert!(v["capturedAtEpochMillis"].as_u64().unwrap() > 0);
    assert!(v["ide"]["fullApplicationName"].as_str().unwrap().starts_with("OpenIDEA "));
    assert_eq!(v["ide"]["projectBasePath"], h.root.display().to_string());
    assert_eq!(v["server"]["running"], false);
    assert_eq!(v["server"]["invocationMode"], "direct");
    assert_eq!(v["server"]["activeSessions"], 1);
    assert_eq!(v["clients"][0]["name"], "test-client");
    assert!(v["languageServers"].is_array());
    assert!(v["index"]["files"].as_u64().unwrap() >= 1);
    assert!(v.get("log").is_none(), "the test host has no log file");

    let calls = v["toolCalls"].as_array().unwrap();
    assert_eq!(calls.len(), 2, "maxToolCalls caps the calls");
    // The diagnostics call itself is still running.
    assert_eq!(
        (calls[0]["tool"].as_str(), calls[0]["outcome"].as_str()),
        (Some("get_ide_diagnostics"), Some("inProgress"))
    );
    assert_eq!((calls[1]["tool"].as_str(), calls[1]["outcome"].as_str()), (Some("read_file"), Some("error")));
    assert!(calls[1]["error"].is_string(), "{}", calls[1]);
    assert_eq!(calls[1]["arguments"], r#"{"file_path":"missing.txt"}"#);
    assert_eq!(calls[1]["project"], h.root.display().to_string());
    assert_eq!(calls[1]["changedFiles"], json!([]));

    let none = h.call_json("get_ide_diagnostics", json!({ "maxToolCalls": -5 })).await;
    assert_eq!(none["toolCalls"], json!([]), "negative counts clamp to 0");

    let history = h.server.call_history();
    assert_eq!(history.len(), 4);
    assert_eq!(history[3].outcome, McpCallOutcome::Success);
    assert_eq!(history[3].arguments, r#"{"file_path":"a.txt"}"#);
}

#[test]
fn keeps_the_last_calls_only() {
    let history = CallHistory::default();
    for _ in 0..MAX_CALLS + 5 {
        let started = history.begin("c", "t", &Map::new(), false, None);
        history.finish(started, Ended::success());
    }
    let calls = history.snapshot();
    assert_eq!(calls.len(), MAX_CALLS);
    assert_eq!(calls[0].id as usize, MAX_CALLS + 5, "most recent first");
    let cancelled = history.begin("c", "t", &Map::new(), false, Some(std::path::Path::new("/p")));
    history.finish(cancelled, Ended::error(&ide_core::IdeError::cancelled()));
    let last = &history.snapshot()[0];
    assert_eq!((last.outcome, last.project.as_deref()), (McpCallOutcome::Cancelled, Some("/p")));
    assert!(last.error.is_some());
}

#[test]
fn strips_secrets_from_arguments() {
    let summary = summarize_arguments(&object(json!({
        "command": "API_TOKEN=abc123 curl -H 'Authorization: Bearer xyz' https://example.com --password=hunter2",
        "env": { "GITHUB_TOKEN": "ghp_secret", "PATH": "/bin" },
        "apiKey": "k",
        "text": "x".repeat(300),
    })));
    for secret in ["abc123", "xyz", "hunter2", "ghp_secret", "\"k\""] {
        assert!(!summary.contains(secret), "{secret} leaked: {summary}");
    }
    assert!(summary.contains("API_TOKEN=***") && summary.contains("\"PATH\":\"/bin\""), "{summary}");
    assert!(summary.chars().count() <= 501, "{summary}");
}

#[test]
fn reads_recent_errors_and_warnings_from_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("openidea.log");
    let lines: Vec<String> = (0..10)
        .map(|i| match i % 3 {
            0 => format!("2026-10-31T10:00:0{i}Z ERROR openidea: failure {i}"),
            1 => format!("2026-10-31T10:00:0{i}Z  WARN openidea: warning {i}"),
            _ => format!("2026-10-31T10:00:0{i}Z  INFO openidea: fine {i}"),
        })
        .collect();
    std::fs::write(&log, lines.join("\n")).unwrap();
    let problems = recent_log_problems(&log, 3);
    assert_eq!(problems.len(), 3);
    assert!(problems[0].ends_with("failure 6") && problems[2].ends_with("failure 9"), "{problems:?}");
    assert!(recent_log_problems(&dir.path().join("none.log"), 3).is_empty());
}
