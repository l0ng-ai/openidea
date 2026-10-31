//! Run configurations, terminal commands and builds through the MCP tools (after JetBrains'
//! `ExecutionToolsetTest`, `TerminalToolsetTest` and `ExecutionUtilTest`).

mod common;

use common::Harness;
use ide_core::mcp::McpUiRequest;
use serde_json::{Value, json};

const RUN_TOML: &str = r#"
[[configurations]]
id = "user:greet"
name = "Greet"
kind = "shell"
command = "sh"
args = ["-c", "echo hello $GREETING; echo oops >&2; exit 3"]
env = { GREETING = "world" }

[[configurations]]
id = "user:long"
name = "Long"
kind = "shell"
command = "sh"
args = ["-c", "head -c 10050 /dev/zero | tr '\\0' a; printf '\\nfinished\\n'"]

[[configurations]]
id = "user:guarded"
name = "Guarded"
kind = "shell"
command = "sh"
args = ["-c", "echo ran"]
beforeLaunch = [{ kind = "command", target = "echo cannot resolve example:library:1.0; exit 1" }]

[[configurations]]
id = "user:detailed"
name = "Detailed"
kind = "shell"
command = "sh"
args = ["-c", "echo ran"]
env = { STORED = "1" }
env-files = [".env"]
stop-command = "echo stopping"
beforeLaunch = [
  { kind = "build" },
  { kind = "run", target = "user:greet" },
  { kind = "command", target = "rm -rf cache" },
  { kind = "toolWindow", target = "run" },
]

[[configurations]]
id = "user:nocommand"
name = "NoCommandXyz"
kind = "shell"
command = ""

[[configurations]]
id = "user:both"
name = "Both"
kind = "compound"
command = ""
compound = ["user:greet", "user:long"]
"#;

fn fixture() -> Vec<(&'static str, &'static str)> {
    vec![
        (".openidea/run.toml", RUN_TOML),
        ("package.json", r#"{ "name": "demo", "scripts": { "dev": "vite" } }"#),
        ("sub/marker.txt", "x\n"),
        ("script.sh", "echo from script\n"),
        ("tests/test_calc.py", "class TestCalc:\n    def test_add(self):\n        pass\n\ndef helper():\n    pass\n"),
    ]
}

fn config<'a>(list: &'a Value, name: &str) -> &'a Value {
    list["configurations"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("{list}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_configurations_and_run_points() {
    let h = Harness::new(&fixture()).await;
    let list = h.call_json("get_run_configurations", json!({})).await;
    let greet = config(&list, "Greet");
    assert_eq!(greet["description"], "shell");
    assert_eq!(greet["supportsDynamicLaunchOverrides"], true);
    assert!(greet["commandLine"].as_str().unwrap().starts_with("sh -c "), "{greet}");
    assert_eq!(greet["environment"]["GREETING"], "world");
    let both = config(&list, "Both");
    assert_eq!(both["supportsDynamicLaunchOverrides"], false);
    assert!(both.get("commandLine").is_none() && both.get("environment").is_none());
    assert!(list["configurations"].as_array().unwrap().iter().any(|c| c["description"] == "npm"), "{list}");

    let points = h.call_json("get_run_configurations", json!({ "filePath": "tests/test_calc.py" })).await;
    assert_eq!(points["filePath"], "tests/test_calc.py");
    let lines: Vec<_> = points["runPoints"].as_array().unwrap().iter().map(|p| p["line"].as_u64().unwrap()).collect();
    assert_eq!(lines, [1, 2], "{points}");
    assert_eq!(points["runPoints"][1]["elementText"], "TestCalc.test_add");
    assert_eq!(points["runPoints"][1]["description"], "Run 'TestCalc.test_add'");

    let points = h.call_json("get_run_configurations", json!({ "filePath": "package.json" })).await;
    assert_eq!(points["runPoints"], json!([]));
    let e = h.call_err("get_run_configurations", json!({ "filePath": "missing.py" })).await;
    assert_eq!(e, "File not found: missing.py");
    let e = h.call_err("get_run_configurations", json!({ "filePath": "sub" })).await;
    assert_eq!(e, "Not a file: sub");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn runs_a_configuration_with_overrides() {
    let h = Harness::new(&fixture()).await;
    let r = h.call_json("execute_run_configuration", json!({ "configurationName": "Greet", "timeout": 5000 })).await;
    assert_eq!(r["exitCode"], 3, "{r}");
    let output = r["output"].as_str().unwrap();
    assert!(output.contains("hello world") && output.contains("oops"), "{r}");
    assert!(!output.contains("Process finished"), "system lines are left out: {r}");
    assert!(r.get("fullOutputPath").is_none(), "the whole output is inline: {r}");
    assert!(r.get("timedOut").is_none() && r.get("sessionId").is_none());
    assert!(matches!(&h.ui.asked.lock()[0], McpUiRequest::Confirm { subject, .. } if subject == "Greet"));

    let r = h
        .call_json(
            "execute_run_configuration",
            json!({
                "configurationName": "Greet",
                "programArguments": "-c 'echo $GREETING $EXTRA in $(basename \"$PWD\")'",
                "workingDirectory": "sub",
                "envs": { "GREETING": "hi", "EXTRA": "there" },
                "timeout": 5000,
            }),
        )
        .await;
    assert_eq!(r["exitCode"], 0, "{r}");
    assert!(r["output"].as_str().unwrap().contains("hi there in sub"), "{r}");

    let e = h.call_err("execute_run_configuration", json!({ "configurationName": "Nope" })).await;
    assert_eq!(e, "Run configuration with name 'Nope' not found.");
    let e =
        h.call_err("execute_run_configuration", json!({ "configurationName": "Both", "programArguments": "x" })).await;
    assert_eq!(
        e,
        "Run configuration 'Both' of type 'Compound' doesn't support dynamic launch overrides (programArguments, \
workingDirectory, envs)."
    );
    let e = h
        .call_err(
            "execute_run_configuration",
            json!({ "configurationName": "Greet", "filePath": "script.sh", "line": 1 }),
        )
        .await;
    assert_eq!(e, "Pass either configurationName or filePath + line, but not both.");
    let e = h.call_err("execute_run_configuration", json!({ "filePath": "script.sh" })).await;
    assert_eq!(e, "Pass both filePath and line together, or use configurationName.");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn runs_a_code_location() {
    let h = Harness::new(&fixture()).await;
    let r =
        h.call_json("execute_run_configuration", json!({ "filePath": "script.sh", "line": 1, "timeout": 5000 })).await;
    assert_eq!(r["exitCode"], 0, "{r}");
    assert!(r["output"].as_str().unwrap().contains("from script"), "{r}");

    let e = h.call_err("execute_run_configuration", json!({ "filePath": "script.sh", "line": 9 })).await;
    assert_eq!(e, "Line 9 is out of range (file has 2 lines)");
    let e = h.call_err("execute_run_configuration", json!({ "filePath": "sub/marker.txt", "line": 1 })).await;
    assert_eq!(
        e,
        "No run configuration could be created from sub/marker.txt:1. Use get_run_configurations with filePath to \
find valid run locations."
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_output_file_when_running_or_truncated() {
    let h = Harness::new(&fixture()).await;
    let r = h
        .call_json(
            "execute_run_configuration",
            json!({ "configurationName": "Greet", "programArguments": "-c 'echo started; sleep 30'", "timeout": 300 }),
        )
        .await;
    assert!(r.get("exitCode").is_none(), "{r}");
    assert!(r.get("timedOut").is_none());
    let path = r["fullOutputPath"].as_str().unwrap();
    assert!(std::fs::read_to_string(path).unwrap().contains("started"));
    let running: Vec<_> = ide_host::ops::run::list(h.host()).into_iter().filter(|r| r.running).collect();
    assert_eq!(running.len(), 1);
    ide_host::ops::run::stop(h.host(), "main", running[0].id).unwrap();

    let r = h.call_json("execute_run_configuration", json!({ "configurationName": "Long", "timeout": 5000 })).await;
    assert_eq!(r["exitCode"], 0, "{r}");
    assert_eq!(r["output"], format!("{}<truncated>", "a".repeat(10_000)));
    let full = std::fs::read_to_string(r["fullOutputPath"].as_str().unwrap()).unwrap();
    assert_eq!(full, format!("{}\nfinished\n", "a".repeat(10_050)));

    let r =
        h.call_json("execute_run_configuration", json!({ "configurationName": "Greet", "waitForExit": false })).await;
    assert!(r.get("exitCode").is_none(), "{r}");
    assert!(r["fullOutputPath"].is_string());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_confirmation_shows_everything_that_runs() {
    let h = Harness::new(&fixture()).await;
    *h.ui.answer.lock() = Value::Bool(false);
    let e = h
        .call_err("execute_run_configuration", json!({ "configurationName": "Detailed", "envs": { "EXTRA": "x" } }))
        .await;
    assert!(e.contains("declined"), "{e}");
    let detail = match &h.ui.asked.lock()[0] {
        McpUiRequest::Confirm { detail, .. } => detail.clone().unwrap(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        detail,
        "sh -c 'echo ran'\nin .\nbefore launch:\n  Build Project\n  Run 'Greet': sh -c 'echo hello $GREETING; echo \
oops >&2; exit 3'\n  Run command: rm -rf cache\nenv files: .env\nenvironment:\n  STORED=1\nenvironment overrides:\n  \
EXTRA=x\non stop: echo stopping"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_line_inside_a_test_runs_that_test() {
    let h = Harness::new(&fixture()).await;
    *h.ui.answer.lock() = Value::Bool(false);
    // Line 3 is in the body of `test_add`: that test, not the whole file.
    let _ = h.call_err("execute_run_configuration", json!({ "filePath": "tests/test_calc.py", "line": 3 })).await;
    let _ = h.call_err("execute_run_configuration", json!({ "filePath": "tests/test_calc.py", "line": 6 })).await;
    let asked = h.ui.asked.lock();
    let subjects: Vec<&str> = asked
        .iter()
        .map(|r| match r {
            McpUiRequest::Confirm { subject, .. } => subject.as_str(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(subjects, ["TestCalc.test_add", "test_calc.py"]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_zero_timeout_returns_at_once() {
    let h = Harness::new(&fixture()).await;
    let r = h
        .call_json(
            "execute_run_configuration",
            json!({ "configurationName": "Greet", "programArguments": "-c 'sleep 2; echo done'", "timeout": 0 }),
        )
        .await;
    assert!(r.get("exitCode").is_none(), "{r}");
    assert!(r["fullOutputPath"].is_string(), "{r}");
    // Without waiting, `timeout` is ignored.
    let r = h
        .call_json(
            "execute_run_configuration",
            json!({ "configurationName": "Greet", "waitForExit": false, "timeout": -1 }),
        )
        .await;
    assert!(r.get("exitCode").is_none(), "{r}");
    for run in ide_host::ops::run::list(h.host()).into_iter().filter(|r| r.running) {
        let _ = ide_host::ops::run::stop(h.host(), "main", run.id);
    }

    let asked = h.ui.asked.lock().len();
    let r = h.call_json("execute_terminal_command", json!({ "command": "touch created.txt", "timeout": 0 })).await;
    assert_eq!(r, json!({ "is_timed_out": true, "command_output": "" }));
    assert!(!h.path("created.txt").exists());
    let r = h.call_json("build_project", json!({ "timeout": -5 })).await;
    assert_eq!(r, json!({ "isSuccess": false, "problems": [], "timedOut": true }));
    assert_eq!(h.ui.asked.lock().len(), asked, "nothing ran, nothing was asked");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn terminal_confirmation_shows_the_configured_shell_and_variables() {
    let settings = "[terminal]\nshellPath = \"/bin/sh -e\"\nenv = { MY_VAR = \"$PROJECT_DIR$/x\" }\n";
    let h = Harness::new(&[(".openidea/settings.toml", settings)]).await;
    let r = h.call_json("execute_terminal_command", json!({ "command": "echo $MY_VAR", "executeInShell": true })).await;
    assert_eq!(r["command_output"], format!("{}/x\n", h.root.display()), "{r}");
    match &h.ui.asked.lock()[0] {
        McpUiRequest::Confirm { detail, .. } => assert_eq!(
            detail.as_deref().unwrap(),
            format!("in {root}\nshell: /bin/sh -e\nMY_VAR={root}/x", root = h.root.display())
        ),
        other => panic!("{other:?}"),
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn terminal_output_beyond_memory_truncates_from_either_end() {
    let h = Harness::new(&[]).await;
    // About 21 MB, more than is kept in memory.
    let args = |mode: &str| json!({ "command": "seq -f %.0f 1 3000000", "maxLinesCount": 4, "truncateMode": mode });
    let marker = "<<<...content truncated...>>>";
    let r = h.call_json("execute_terminal_command", args("END")).await;
    assert_eq!(r["command_output"], format!("{marker}\n2999999\n3000000\n"));
    let path = r["fullOutputPath"].as_str().unwrap().to_owned();
    let full = std::fs::read_to_string(&path).unwrap();
    assert_eq!(full.lines().count(), 3_000_000);
    assert!(full.ends_with("2999999\n3000000\n"));
    let _ = std::fs::remove_file(path);
    let r = h.call_json("execute_terminal_command", args("START")).await;
    assert_eq!(r["command_output"], format!("1\n2\n3\n{marker}"));
    let _ = std::fs::remove_file(r["fullOutputPath"].as_str().unwrap());
    let r = h.call_json("execute_terminal_command", args("MIDDLE")).await;
    assert_eq!(r["command_output"], format!("1\n2\n{marker}\n"));
    let _ = std::fs::remove_file(r["fullOutputPath"].as_str().unwrap());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_launch_leaves_no_output_file() {
    let h = Harness::new(&fixture()).await;
    // SAFETY: getuid has no preconditions.
    let dir = std::env::temp_dir().join(format!("openidea-mcp-{}", unsafe { libc::getuid() }));
    let leftovers = || {
        std::fs::read_dir(&dir)
            .map(|d| d.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("run-NoCommandXyz")).count())
            .unwrap_or(0)
    };
    let e = h.call_err("execute_run_configuration", json!({ "configurationName": "NoCommandXyz" })).await;
    assert!(e.starts_with("Execution failed: "), "{e}");
    assert_eq!(leftovers(), 0);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn reports_before_launch_failures() {
    let h = Harness::new(&fixture()).await;
    let e = h.call_err("execute_run_configuration", json!({ "configurationName": "Guarded" })).await;
    assert_eq!(
        e,
        "Execution failed: cannot resolve example:library:1.0\nBefore launch: Run 'echo cannot resolve \
example:library:1.0; exit 1': 'echo cannot resolve example:library:1.0; exit 1' failed"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn terminal_commands_report_output_and_exit_codes() {
    let h = Harness::new(&[("a.txt", "x\n")]).await;
    let r = h.call_json("execute_terminal_command", json!({ "command": "cat missingfile" })).await;
    assert_eq!(r, json!({ "command_exit_code": 1, "command_output": "cat: missingfile: No such file or directory\n" }));
    match &h.ui.asked.lock()[0] {
        McpUiRequest::Confirm { subject, detail, .. } => {
            assert_eq!(subject, "cat missingfile");
            assert!(detail.as_deref().unwrap().contains(h.root.to_str().unwrap()));
        }
        other => panic!("{other:?}"),
    }

    let r = h
        .call_json(
            "execute_terminal_command",
            json!({ "command": "echo out; echo err >&2; ls; exit 7", "executeInShell": true }),
        )
        .await;
    assert_eq!(r["command_exit_code"], 7, "{r}");
    let output = r["command_output"].as_str().unwrap();
    assert!(output.contains("out") && output.contains("err") && output.contains("a.txt"), "{r}");

    // Directly, without a shell: `$HOME` stays literal.
    let r = h.call_json("execute_terminal_command", json!({ "command": "echo '$HOME' \"a b\"" })).await;
    assert_eq!(r["command_output"], "$HOME a b\n");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn terminal_commands_truncate_and_time_out() {
    let h = Harness::new(&[]).await;
    let args = |mode: &str| json!({ "command": "seq 1 10", "maxLinesCount": 4, "truncateMode": mode });
    let marker = "<<<...content truncated...>>>";
    let r = h.call_json("execute_terminal_command", args("START")).await;
    assert_eq!(r["command_output"], format!("1\n2\n3\n{marker}"));
    let full = std::fs::read_to_string(r["fullOutputPath"].as_str().unwrap()).unwrap();
    assert_eq!(full.lines().count(), 10);
    let r = h.call_json("execute_terminal_command", args("END")).await;
    assert_eq!(r["command_output"], format!("{marker}\n9\n10\n"));
    let r = h.call_json("execute_terminal_command", args("MIDDLE")).await;
    assert_eq!(r["command_output"], format!("1\n2\n{marker}\n"));
    let r = h.call_json("execute_terminal_command", args("NONE")).await;
    assert_eq!(r["command_output"].as_str().unwrap().lines().count(), 10);
    assert!(r.get("fullOutputPath").is_none());
    let e = h.call_err("execute_terminal_command", json!({ "command": "true", "maxLinesCount": 2 })).await;
    assert!(e.contains("greater than 2"), "{e}");

    let started = std::time::Instant::now();
    let r = h
        .call_json(
            "execute_terminal_command",
            json!({ "command": "echo before; sleep 30 & sleep 30", "executeInShell": true, "timeout": 3000 }),
        )
        .await;
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    assert_eq!(r["is_timed_out"], true, "{r}");
    assert!(r.get("command_exit_code").is_none());
    assert!(r["command_output"].as_str().unwrap().contains("before"), "{r}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn declined_commands_do_not_run_and_brave_mode_skips_the_question() {
    let h = Harness::new(&[]).await;
    *h.ui.answer.lock() = Value::Bool(false);
    let e = h.call_err("execute_terminal_command", json!({ "command": "touch created.txt" })).await;
    assert!(e.contains("declined"), "{e}");
    assert!(!h.path("created.txt").exists());

    h.server.apply(&ide_core::mcp::McpSettings { brave_mode: true, ..Default::default() }).await;
    let asked = h.ui.asked.lock().len();
    let r = h.call_json("execute_terminal_command", json!({ "command": "touch created.txt" })).await;
    assert_eq!(r["command_exit_code"], 0);
    assert!(h.path("created.txt").exists());
    assert_eq!(h.ui.asked.lock().len(), asked);
}

#[tokio::test(flavor = "multi_thread")]
async fn build_without_a_build_system_says_so() {
    let h = Harness::new(&[("notes.txt", "x\n")]).await;
    let e = h.call_err("build_project", json!({})).await;
    assert!(e.contains("no supported build system"), "{e}");
    assert!(matches!(&h.ui.asked.lock()[0], McpUiRequest::Confirm { subject, .. } if subject == "Build project"));

    let e = h.call_err("build_project", json!({ "filesToRebuild": ["missing.rs"] })).await;
    assert_eq!(e, "File not found: missing.rs");

    *h.ui.answer.lock() = Value::Bool(false);
    let e = h.call_err("build_project", json!({ "rebuild": true })).await;
    assert!(e.contains("declined"), "{e}");
}
