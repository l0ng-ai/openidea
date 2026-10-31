//! Run configurations, terminal commands and builds through the MCP tools.

mod common;

use common::Harness;
use ide_core::mcp::{McpSettings, McpUiRequest};
use serde_json::{Value, json};

const RUN_TOML: &str = r#"
[[configurations]]
id = "user:greet"
name = "Greet"
kind = "shell"
command = "sh"
args = ["-c", "echo hello $GREETING; echo oops >&2; exit 3"]
env = { GREETING = "world" }
"#;

fn fixture() -> Vec<(&'static str, &'static str)> {
    vec![
        (".openidea/run.toml", RUN_TOML),
        ("package.json", r#"{ "name": "demo", "scripts": { "dev": "vite" } }"#),
        ("sub/marker.txt", "x\n"),
    ]
}

fn config<'a>(list: &'a Value, name: &str) -> &'a Value {
    list["configurations"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("{list}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_saved_and_detected_configurations() {
    let h = Harness::new(&fixture()).await;
    let list = h.call_json("get_run_configurations", json!({})).await;
    let greet = config(&list, "Greet");
    assert_eq!(greet["type"], "shell");
    assert_eq!(greet["command"], "sh");
    assert_eq!(greet["envs"]["GREETING"], "world");
    assert_eq!(greet["workingDirectory"], ".");
    assert_eq!(greet["supportsDynamicLaunchOverrides"], true);
    assert!(list["configurations"].as_array().unwrap().iter().any(|c| c["type"] == "npm"), "{list}");

    let points = h.call_json("get_run_configurations", json!({ "filePath": "package.json" })).await;
    assert_eq!(points["filePath"], "package.json");
    assert_eq!(points["runPoints"], json!([]));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn runs_a_configuration_with_overrides() {
    let h = Harness::new(&fixture()).await;
    let r = h.call_json("execute_run_configuration", json!({ "configurationName": "Greet" })).await;
    assert_eq!(r["exitCode"], 3, "{r}");
    let output = r["output"].as_str().unwrap();
    assert!(output.contains("hello world") && output.contains("oops"), "{r}");
    let full = std::fs::read_to_string(r["fullOutputPath"].as_str().unwrap()).unwrap();
    assert!(full.contains("hello world"));
    assert!(matches!(&h.ui.asked.lock()[0], McpUiRequest::Confirm { subject, .. } if subject == "Greet"));

    let r = h
        .call_json(
            "execute_run_configuration",
            json!({
                "configurationName": "greet",
                "programArguments": "-c 'echo $GREETING $EXTRA in $(basename \"$PWD\")'",
                "workingDirectory": "sub",
                "envs": { "GREETING": "hi", "EXTRA": "there" },
            }),
        )
        .await;
    assert_eq!(r["exitCode"], 0, "{r}");
    assert!(r["output"].as_str().unwrap().contains("hi there in sub"), "{r}");

    let e = h.call_err("execute_run_configuration", json!({ "configurationName": "Nope" })).await;
    assert!(e.contains("Greet"), "{e}");
    let e = h.call_err("execute_run_configuration", json!({ "filePath": "a.rs", "line": 1 })).await;
    assert!(e.contains("not available"), "{e}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn run_timeout_leaves_the_process_running() {
    let h = Harness::new(&fixture()).await;
    let r = h
        .call_json(
            "execute_run_configuration",
            json!({ "configurationName": "Greet", "programArguments": "-c 'echo started; sleep 30'", "timeout": 300 }),
        )
        .await;
    assert_eq!(r["timedOut"], true, "{r}");
    assert_eq!(r["running"], true);
    assert!(r.get("exitCode").is_none());
    let running: Vec<_> = ide_host::ops::run::list(h.host()).into_iter().filter(|r| r.running).collect();
    assert_eq!(running.len(), 1);
    ide_host::ops::run::stop(h.host(), "main", running[0].id).unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn terminal_commands_report_output_and_exit_codes() {
    let h = Harness::new(&[("a.txt", "x\n")]).await;
    let r = h.call_json("execute_terminal_command", json!({ "command": "echo out; echo err >&2; ls; exit 7" })).await;
    assert_eq!(r["exitCode"], 7, "{r}");
    let output = r["output"].as_str().unwrap();
    assert!(output.contains("out") && output.contains("err") && output.contains("a.txt"), "{r}");
    match &h.ui.asked.lock()[0] {
        McpUiRequest::Confirm { subject, detail, .. } => {
            assert_eq!(subject, "echo out; echo err >&2; ls; exit 7");
            assert!(detail.as_deref().unwrap().contains(h.root.to_str().unwrap()));
        }
        other => panic!("{other:?}"),
    }

    // Directly, without a shell: `$HOME` stays literal.
    let r = h
        .call_json("execute_terminal_command", json!({ "command": "echo '$HOME' \"a b\"", "executeInShell": false }))
        .await;
    assert_eq!(r["exitCode"], 0);
    assert_eq!(r["output"], "$HOME a b");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn terminal_commands_truncate_and_time_out() {
    let h = Harness::new(&[]).await;
    let args = |mode: &str| json!({ "command": "seq 1 10", "executeInShell": false, "maxLinesCount": 4, "truncateMode": mode });
    let r = h.call_json("execute_terminal_command", args("START")).await;
    assert_eq!(r["output"], "… 6 lines omitted …\n7\n8\n9\n10");
    assert_eq!(r["omittedLines"], 6);
    let full = std::fs::read_to_string(r["fullOutputPath"].as_str().unwrap()).unwrap();
    assert_eq!(full.lines().count(), 10);
    let r = h.call_json("execute_terminal_command", args("END")).await;
    assert_eq!(r["output"], "1\n2\n3\n4\n… 6 lines omitted …");
    let r = h.call_json("execute_terminal_command", args("MIDDLE")).await;
    assert_eq!(r["output"], "1\n2\n… 6 lines omitted …\n9\n10");
    let r = h.call_json("execute_terminal_command", args("NONE")).await;
    assert_eq!(r["output"].as_str().unwrap().lines().count(), 10);
    assert!(r.get("fullOutputPath").is_none());

    let started = std::time::Instant::now();
    let r = h
        .call_json(
            "execute_terminal_command",
            json!({ "command": "echo before; sleep 30 & sleep 30", "timeout": 3000 }),
        )
        .await;
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    assert_eq!(r["timedOut"], true, "{r}");
    assert!(r.get("exitCode").is_none());
    assert!(r["output"].as_str().unwrap().contains("before"), "{r}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn declined_commands_do_not_run_and_brave_mode_skips_the_question() {
    let h = Harness::new(&[]).await;
    *h.ui.answer.lock() = Value::Bool(false);
    let e = h.call_err("execute_terminal_command", json!({ "command": "touch created.txt" })).await;
    assert!(e.contains("declined"), "{e}");
    assert!(!h.path("created.txt").exists());

    h.server.apply(&McpSettings { brave_mode: true, ..Default::default() }).await;
    let asked = h.ui.asked.lock().len();
    let r = h.call_json("execute_terminal_command", json!({ "command": "touch created.txt" })).await;
    assert_eq!(r["exitCode"], 0);
    assert!(h.path("created.txt").exists());
    assert_eq!(h.ui.asked.lock().len(), asked);
}

#[tokio::test(flavor = "multi_thread")]
async fn build_without_a_build_system_says_so() {
    let h = Harness::new(&[("notes.txt", "x\n")]).await;
    let e = h.call_err("build_project", json!({})).await;
    assert!(e.contains("no supported build system"), "{e}");
    assert!(matches!(&h.ui.asked.lock()[0], McpUiRequest::Confirm { subject, .. } if subject == "Build project"));

    *h.ui.answer.lock() = Value::Bool(false);
    let e = h.call_err("build_project", json!({ "rebuild": true })).await;
    assert!(e.contains("declined"), "{e}");
}
