use super::*;
use openidea_plugin::mock::MockHost;
use openidea_plugin::{Position, Problem, ProcessOutput, Range, RepositoryStatus, Severity, TextMatch};

const ALL: &[&str] =
    &["mcp", "project.read", "editor.read", "vcs.read", "process:claude", "process:codex", "clipboard"];

fn host() -> MockHost {
    MockHost::install().with_capabilities(ALL)
}

fn ok(stdout: &str) -> Result<ProcessOutput, Error> {
    Ok(ProcessOutput { status: Some(0), stdout: stdout.into(), stderr: String::new() })
}

fn tool(name: &str, args: &str, host: &MockHost) -> Result<String, Error> {
    AiCliAgents.call_tool(name, args, &host.invocation())
}

#[test]
fn launches_claude_with_the_server_for_this_session_and_the_token_in_the_environment() {
    let host = host();
    host.set_setting("claudeArgs", "\"--model opus --name 'my session'\"");
    AiCliAgents.run_command("launch-claude", &host.invocation(), None).unwrap();
    let t = &host.terminals()[0];
    assert_eq!((t.title.as_str(), t.program.as_str(), t.cwd.as_deref()), ("Claude Code", "claude", None));
    assert_eq!(t.args[..5], ["--model", "opus", "--name", "my session", "--mcp-config"]);
    let config: serde_json::Value = serde_json::from_str(&t.args[5]).unwrap();
    assert_eq!(
        config,
        serde_json::json!({ "mcpServers": { "openidea": {
            "type": "http",
            "url": "http://127.0.0.1:4000/mcp?project=/project",
            "headers": { "Authorization": "Bearer ${OPENIDEA_MCP_TOKEN}" },
        } } })
    );
    assert_eq!(t.args.len(), 6, "the JSON comes last: --mcp-config takes every value after it");
    assert_eq!(t.env, [("OPENIDEA_MCP_TOKEN".to_owned(), "mock-token".to_owned())]);
    assert!(!t.args.iter().any(|a| a.contains("mock-token")), "the token is never on the command line");
}

#[test]
fn launches_codex_with_overrides_unless_a_stdio_server_is_configured() {
    let host = host();
    host.set_setting("codexArgs", "\"--model gpt-5\"");
    host.on_process("codex", |_, _| {
        Ok(ProcessOutput { status: Some(1), stdout: String::new(), stderr: "No MCP server named 'openidea'".into() })
    });
    AiCliAgents.run_command("launch-codex", &host.invocation(), None).unwrap();
    assert_eq!(host.process_runs()[0].args, ["mcp", "get", "openidea"]);
    let t = &host.terminals()[0];
    assert_eq!(t.program, "codex");
    assert_eq!(
        t.args,
        [
            "-c",
            "mcp_servers.openidea.url=\"http://127.0.0.1:4000/mcp?project=/project\"",
            "-c",
            "mcp_servers.openidea.bearer_token_env_var=\"OPENIDEA_MCP_TOKEN\"",
            "--model",
            "gpt-5",
        ]
    );
    assert_eq!(t.env, [("OPENIDEA_MCP_TOKEN".to_owned(), "mock-token".to_owned())]);
    assert!(!t.args.iter().any(|a| a.contains("mock-token")));

    // Auto-configured (stdio): Codex would refuse a URL for it, so it is used as it is.
    host.on_process("codex", |_, _| ok("openidea\n  enabled: true\n  transport: stdio\n  command: /x/openidea\n"));
    AiCliAgents.run_command("launch-codex", &host.invocation(), None).unwrap();
    assert_eq!(host.terminals()[1].args, ["--model", "gpt-5"]);
}

#[test]
fn a_missing_permission_is_explained() {
    let host = MockHost::install().with_capabilities(&["mcp", "project.read"]);
    assert_eq!(AiCliAgents.run_command("launch-claude", &host.invocation(), None), Ok(None));
    let n = &host.notifications()[0];
    assert!(n.body.contains("Allow \"process:claude\"") && n.body.contains("Settings › Plugins"), "{}", n.body);
    assert!(host.terminals().is_empty());

    let host = MockHost::install().with_capabilities(&["project.read", "process:claude"]);
    AiCliAgents.run_command("launch-claude", &host.invocation(), None).unwrap();
    assert!(host.notifications()[0].body.contains("Allow \"mcp\""));
}

#[test]
fn configures_the_agents_with_the_stdio_bridge_replacing_an_earlier_entry() {
    let host = host();
    host.on_process("claude", |args, _| match args[1].as_str() {
        "remove" => Ok(ProcessOutput { status: Some(1), stdout: String::new(), stderr: "No MCP server".into() }),
        _ => ok("Added stdio MCP server openidea to user config"),
    });
    host.on_process("codex", |_, _| ok(""));
    let ctx = host.invocation();
    AiCliAgents.run_command("configure-claude-user", &ctx, None).unwrap();
    AiCliAgents.run_command("configure-claude-project", &ctx, None).unwrap();
    AiCliAgents.run_command("configure-codex", &ctx, None).unwrap();
    let runs: Vec<(String, Vec<String>)> = host.process_runs().into_iter().map(|r| (r.program, r.args)).collect();
    let stdio = r#"{"args":["--mcp-stdio"],"command":"openidea","type":"stdio"}"#;
    let expected: Vec<(&str, Vec<&str>)> = vec![
        ("claude", vec!["mcp", "remove", "--scope", "user", "openidea"]),
        ("claude", vec!["mcp", "add-json", "--scope", "user", "openidea", stdio]),
        ("claude", vec!["mcp", "remove", "--scope", "project", "openidea"]),
        ("claude", vec!["mcp", "add-json", "--scope", "project", "openidea", stdio]),
        ("codex", vec!["mcp", "remove", "openidea"]),
        ("codex", vec!["mcp", "add", "openidea", "--", "openidea", "--mcp-stdio"]),
    ];
    let expected: Vec<(String, Vec<String>)> =
        expected.into_iter().map(|(p, a)| (p.to_owned(), a.into_iter().map(str::to_owned).collect())).collect();
    assert_eq!(runs, expected);
    assert!(runs.iter().all(|(_, args)| !args.iter().any(|a| a.contains("mock-token"))), "no token is persisted");
    let titles: Vec<String> = host.notifications().into_iter().map(|n| n.title).collect();
    assert_eq!(titles, ["Claude Code configured", "Claude Code configured", "Codex configured"]);

    host.on_process("codex", |args, _| match args[1].as_str() {
        "add" => Ok(ProcessOutput { status: Some(2), stdout: String::new(), stderr: "bad config".into() }),
        _ => ok(""),
    });
    let err = AiCliAgents.run_command("configure-codex", &ctx, None).unwrap_err();
    assert_eq!(err, Error::Failed("codex mcp: bad config".into()));
}

#[test]
fn copies_a_config_without_a_token() {
    let host = host();
    AiCliAgents.run_command("copy-config", &host.invocation(), None).unwrap();
    let copied: serde_json::Value = serde_json::from_str(&host.clipboard().unwrap()).unwrap();
    assert_eq!(
        copied,
        serde_json::json!({ "mcpServers": { "openidea": {
            "command": "openidea", "args": ["--mcp-stdio", "--project", "/project"],
        } } })
    );
    let host = MockHost::install().with_capabilities(&["mcp", "project.read"]);
    AiCliAgents.run_command("copy-config", &host.invocation(), None).unwrap();
    assert!(host.notifications()[0].body.contains("--mcp-stdio"), "shown without the clipboard");
}

#[test]
fn splits_extra_arguments_like_a_shell() {
    let split = agents::split_args;
    assert_eq!(split("  --a  b "), ["--a", "b"]);
    assert_eq!(split(r#"--x 'a b' "c \"d\"" e\ f ''"#), ["--x", "a b", "c \"d\"", "e f", ""]);
    assert!(split("").is_empty());
}

#[test]
fn open_files_and_the_selection() {
    let host = host();
    assert_eq!(tool("get_open_files", "{}", &host).unwrap(), "No files are open in the editor.");
    assert_eq!(tool("get_current_selection", "", &host).unwrap(), "No file is focused in the editor.");
    host.open_editor(
        "/project/src/b.rs",
        "rust",
        "fn main() {\n    println!(\"é\");\n}\n",
        &[(1, 4, 1, 12), (2, 0, 2, 0)],
    );
    host.set_open_editors(&["/project/src/a.rs", "/project/src/b.rs"]);
    assert_eq!(tool("get_open_files", "{}", &host).unwrap(), "src/b.rs (focused)\nsrc/a.rs");
    let selection: serde_json::Value =
        serde_json::from_str(&tool("get_current_selection", "{}", &host).unwrap()).unwrap();
    assert_eq!(selection["path"], "src/b.rs");
    assert_eq!(selection["language"], "rust");
    assert_eq!(selection["selections"][0]["start"], serde_json::json!({ "line": 2, "column": 5 }));
    assert_eq!(selection["selections"][0]["text"], "println!");
    assert_eq!(selection["selections"][1]["text"], "");
}

#[test]
fn reads_files_in_bounded_numbered_chunks() {
    let host = host();
    let text: String = (1..=2500).map(|i| format!("line {i}\n")).collect();
    host.add_file("big.txt", &text);
    host.add_file("small.txt", "a\nb\nc\n");
    assert_eq!(tool("read_file", r#"{"path":"small.txt"}"#, &host).unwrap(), "     1\ta\n     2\tb\n     3\tc\n");
    assert_eq!(
        tool("read_file", r#"{"path":"/project/small.txt","start_line":2,"end_line":2}"#, &host).unwrap(),
        "     2\tb\n"
    );
    let big = tool("read_file", r#"{"path":"big.txt"}"#, &host).unwrap();
    assert_eq!(big.lines().count(), 2001);
    assert!(big.ends_with("… (2500 lines; continue with start_line=2001)\n"), "{}", &big[big.len() - 80..]);
    assert!(matches!(tool("read_file", r#"{"path":"small.txt","start_line":9}"#, &host), Err(Error::Invalid(_))));
    assert!(matches!(tool("read_file", "{}", &host), Err(Error::Invalid(m)) if m == "path is required"));
    assert!(matches!(tool("read_file", "[", &host), Err(Error::Invalid(_))));
    assert!(matches!(tool("read_file", r#"{"path":"nope.txt"}"#, &host), Err(Error::NotFound(_))));
}

#[test]
fn finds_files_and_text() {
    let host = host();
    host.add_file("src/a/UserTest.java", "class UserTest { User u; }");
    host.add_file("src/User.java", "class User {}");
    host.add_file("README.md", "User guide");
    assert_eq!(tool("find_files", r#"{"pattern":"*.java"}"#, &host).unwrap(), "src/User.java\nsrc/a/UserTest.java");
    assert_eq!(tool("find_files", r#"{"pattern":"src/*.java","limit":5}"#, &host).unwrap(), "src/User.java");
    assert_eq!(
        tool("find_files", r#"{"pattern":"**/*.java","limit":1}"#, &host).unwrap(),
        "src/User.java\n… (more than 1: narrow the pattern or raise limit)"
    );
    assert_eq!(tool("find_files", r#"{"pattern":"*.kt"}"#, &host).unwrap(), "No files match *.kt.");

    let found =
        tool("search_text", r#"{"query":"User","case_sensitive":true,"whole_word":true,"glob":["*.java"]}"#, &host);
    assert_eq!(
        found.unwrap(),
        "src/User.java:1:7: class User {}\nsrc/a/UserTest.java:1:18: class UserTest { User u; }"
    );
    let limited = tool("search_text", r#"{"query":"user","limit":1}"#, &host).unwrap();
    assert_eq!(limited.lines().count(), 2, "{limited}");
    assert!(limited.ends_with("narrow the query or glob, or raise limit)"));
    host.on_search(|q, o| {
        assert!(o.regex && o.globs == ["src/**"]);
        Ok(vec![TextMatch { path: "/project/x.rs".into(), line: 4, start: 2, end: 5, text: format!("  {q}  ") }])
    });
    let regex = tool("search_text", r#"{"query":"a.c","regex":true,"glob":"src/**"}"#, &host).unwrap();
    assert_eq!(regex, "x.rs:5:3: a.c");
    assert!(matches!(tool("search_text", r#"{"query":"x","regex":"yes"}"#, &host), Err(Error::Invalid(_))));
}

#[test]
fn lists_problems_worst_first() {
    let host = host();
    assert_eq!(tool("get_problems", "{}", &host).unwrap(), "No problems in the project.");
    let problem = |path: &str, line: u32, severity: Severity, message: &str, code: Option<&str>| Problem {
        path: path.into(),
        range: Range::new(Position::new(line, 4), Position::new(line, 8)),
        severity,
        message: message.into(),
        source: Some("rustc".into()),
        code: code.map(str::to_owned),
    };
    host.add_problem(problem("/project/src/b.rs", 3, Severity::Warning, "unused variable", Some("unused")));
    host.add_problem(problem("/project/src/a.rs", 9, Severity::Error, "mismatched\ntypes", Some("E0308")));
    host.add_problem(problem("/project/src/a.rs", 1, Severity::Hint, "consider this", None));
    assert_eq!(
        tool("get_problems", "{}", &host).unwrap(),
        "1 errors, 1 warnings, 1 other problems in the project\n\
         src/a.rs:10:5: error [rustc E0308]: mismatched types\n\
         src/b.rs:4:5: warning [rustc unused]: unused variable\n\
         src/a.rs:2:5: hint [rustc]: consider this"
    );
    assert_eq!(
        tool("get_problems", r#"{"path":"src/a.rs","errors_only":true}"#, &host).unwrap(),
        "1 errors, 0 warnings, 0 other problems in src/a.rs\nsrc/a.rs:10:5: error [rustc E0308]: mismatched types"
    );
    let limited = tool("get_problems", r#"{"limit":1}"#, &host).unwrap();
    assert!(limited.ends_with("… (2 more: ask for one path, errors_only, or a higher limit)"), "{limited}");
}

#[test]
fn opens_files_and_reports_git_status() {
    let host = host();
    assert_eq!(
        tool("open_file", r#"{"path":"src/a.rs","line":12,"column":3}"#, &host).unwrap(),
        "Opened src/a.rs:12:3 in the editor."
    );
    tool("open_file", r#"{"path":"/project/b.rs"}"#, &host).unwrap();
    assert_eq!(host.opened_locations(), [("/project/src/a.rs".into(), 11, 2), ("/project/b.rs".into(), 0, 0)]);
    assert!(matches!(tool("open_file", r#"{"path":"a.rs","line":0}"#, &host), Err(Error::Invalid(_))));

    assert_eq!(tool("git_status", "{}", &host).unwrap(), "The project is not in a git repository.");
    host.set_vcs_status(Some(RepositoryStatus {
        root: "/project".into(),
        branch: Some("main".into()),
        commit: Some("abc1234".into()),
        upstream: Some("origin/main".into()),
        ahead: 2,
        behind: 0,
        operation: Some("rebase".into()),
        changed_files: 3,
    }));
    assert_eq!(
        tool("git_status", "{}", &host).unwrap(),
        "repository: /project\nbranch: main\ncommit: abc1234\nupstream: origin/main (ahead 2, behind 0)\n\
         in progress: rebase\nchanged files: 3"
    );
}

#[test]
fn tools_need_their_capabilities_and_a_known_name() {
    let host = MockHost::install().with_capabilities(&["mcp"]);
    assert_eq!(tool("get_open_files", "{}", &host), Err(Error::Denied("project.read".into())));
    let host = self::host();
    assert!(matches!(tool("nope", "{}", &host), Err(Error::NotFound(_))));
}
