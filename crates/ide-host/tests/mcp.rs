use ide_core::{CancellationToken, ChangeSet, Diagnostic, IdeEvent, Pos, Range, Severity, TextChange};
use ide_host::mcp::{FileProblems, FocusedEditor, Registry};
use ide_host::{Host, HostConfig};
use ide_mcp::ToolRegistry;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

struct Harness {
    host: Arc<Host>,
    root: PathBuf,
    tmp: tempfile::TempDir,
    events: Arc<std::sync::Mutex<Vec<IdeEvent>>>,
}
impl Harness {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "old text\nneedle needle\n").unwrap();
        std::fs::write(root.join("src/b.txt"), "needle\n").unwrap();
        std::fs::create_dir_all(root.join("ignored")).unwrap();
        std::fs::write(root.join("ignored/a.txt"), "needle\n").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let host = Arc::new(Host::new(HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(move |_| {
                let events = sink.clone();
                Arc::new(move |e| events.lock().unwrap().push(e))
            }),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        host.open_project("main", &root).unwrap();
        Self { host, root, tmp, events }
    }
    async fn trust(&self) {
        self.host.set_project_trust(&self.root, true, false).await.unwrap();
    }
    async fn error(&self, name: &str, args: Value) -> String {
        let (host, root, name) = (self.host.clone(), self.root.clone(), name.to_owned());
        let e = tokio::task::spawn_blocking(move || {
            Registry::new(host).call(&root, &name, &args.to_string(), CancellationToken::new())
        })
        .await
        .unwrap()
        .unwrap_err();
        match e {
            ide_mcp::ToolCallError::Failed(e) | ide_mcp::ToolCallError::UnknownTool(e) => e,
        }
    }
    async fn request(&self) -> u32 {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if let Some(id) = self.events.lock().unwrap().iter().rev().find_map(|e| match e {
                    IdeEvent::McpRequest { id, .. } => Some(*id),
                    _ => None,
                }) {
                    return id;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn call(&self, name: &str, args: Value) -> String {
        let (host, root, name) = (self.host.clone(), self.root.clone(), name.to_owned());
        tokio::task::spawn_blocking(move || {
            Registry::new(host).call(&root, &name, &args.to_string(), CancellationToken::new())
        })
        .await
        .unwrap()
        .unwrap()
    }
    async fn json(&self, name: &str, args: Value) -> Value {
        serde_json::from_str(&self.call(name, args).await).unwrap()
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.host.close_project("main");
        self.host.close_project("second");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_unsaved_text_and_searches_the_overlay_with_a_limit() {
    let h = Harness::new();
    let p = h.host.project("main").unwrap();
    let doc = p.documents.open(&h.root.join("src/a.txt")).unwrap();
    p.documents
        .edit(
            doc.id,
            doc.version,
            ChangeSet { changes: vec![TextChange { from: 0, to: 3, insert: "fresh needle".into() }] },
        )
        .unwrap();
    assert_eq!(
        h.call("read_file", json!({"file_path":"src/a.txt","offset":1,"limit":5})).await,
        "L1: fresh needle text\nL2: needle needle\nL3: "
    );
    let found = h.json("search_text", json!({"q":"needle","limit":2})).await;
    assert_eq!(found["items"].as_array().unwrap().len(), 2);
    assert_eq!(found["more"], true);
    let all = h.json("search_text", json!({"q":"fresh","limit":20})).await;
    assert_eq!(all["items"][0]["filePath"], "src/a.txt");
    // The matched line comes with the result (unsaved text included), and lines around it on request.
    assert_eq!(all["items"][0]["lineText"], "fresh needle text");
    assert!(all["items"][0].get("contextAfter").is_none());
    let after = h.json("search_text", json!({"q":"fresh","context":"+1"})).await;
    assert_eq!(after["items"][0]["contextAfter"], json!(["needle needle"]));
    let before = h.json("search_regex", json!({"q":"needle needle","context":"-1"})).await;
    assert_eq!(before["items"][0]["lineText"], "needle needle");
    assert_eq!(before["items"][0]["contextBefore"], json!(["fresh needle text"]));
    let bad = h.error("search_text", json!({"q":"fresh","context":"around"})).await;
    assert!(bad.contains("context must be"), "{bad}");
    let all = h.json("search_text", json!({"q":"needle","limit":20})).await;
    assert!(all["items"].as_array().unwrap().iter().all(|v| !v["filePath"].as_str().unwrap().contains("ignored")));
    let files = h.json("search_file", json!({"q":"*.txt","paths":["src/**"]})).await;
    assert_eq!(files["items"], json!([{"filePath":"src/a.txt"},{"filePath":"src/b.txt"}]));
    let regex = h.json("search_regex", json!({"q":"fresh\\s+needle"})).await;
    assert_eq!(regex["items"][0]["startColumn"], 1);
    assert_eq!(std::fs::read_to_string(h.root.join("src/a.txt")).unwrap(), "old text\nneedle needle\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn window_reports_supply_editor_selection_and_problems_then_disappear_on_close() {
    let h = Harness::new();
    let path = h.root.join("src/a.txt");
    h.host.mcp_reports.set_open_editors("main", vec![path.clone()]);
    h.host.mcp_reports.set_focused_editor(
        "main",
        Some(FocusedEditor {
            path: path.clone().into(),
            selection: Range::new(Pos::new(1, 2), Pos::new(1, 4)),
            selected_text: "ed".into(),
        }),
        true,
    );
    let d = Diagnostic {
        range: Range::point(Pos::new(1, 2)),
        severity: Severity::Warning,
        message: "reported warning".into(),
        source: Some("inspection".into()),
        code: None,
        unnecessary: false,
        deprecated: false,
        server: None,
    };
    h.host.mcp_reports.report_problems("main", true, vec![FileProblems { path: path.clone().into(), items: vec![d] }]);
    assert_eq!(h.json("get_all_open_file_paths", json!({})).await["openFiles"], json!(["src/a.txt"]));
    let focused = h.json("get_current_file", json!({})).await;
    assert_eq!(focused["selectedText"], "ed");
    assert_eq!(focused["selection"]["startColumn"], 3);
    let problems = h.json("get_file_problems", json!({"filePath":"src/a.txt","errorsOnly":false})).await;
    assert_eq!(problems["errors"][0]["description"], "reported warning");
    assert_eq!(h.json("get_project_problems", json!({})).await["files"].as_array().unwrap().len(), 1);
    h.host.close_project("main");
    h.host.open_project("main", &h.root).unwrap();
    assert_eq!(h.json("get_all_open_file_paths", json!({})).await["openFiles"], json!([]));
    assert_eq!(h.json("get_current_file", json!({})).await, json!({}));
    assert_eq!(h.json("get_project_problems", json!({})).await["files"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn restricted_projects_have_only_read_tools_and_remote_projects_explain_the_limitation() {
    let h = Harness::new();
    assert!(!h.host.project("main").unwrap().is_trusted());
    let registry = Registry::new(h.host.clone());
    assert!(registry.tools(&h.root).unwrap().iter().all(|t| t.read_only && !t.destructive));
    assert!(!h.host.global_settings.effective().mcp_server.enabled);
    h.host.mcp_reports.set_remote("remote", PathBuf::from("/remote/project"));
    assert_eq!(registry.tools(Path::new("/remote/project")).unwrap_err(), "not supported for remote projects yet");
    h.host.close_project_detached("remote");
    assert!(!registry.projects().contains(&PathBuf::from("/remote/project")));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_path_argument_routes_to_another_open_project() {
    let h = Harness::new();
    let second = h.tmp.path().join("second");
    std::fs::create_dir_all(second.join("nested")).unwrap();
    std::fs::write(second.join("unique.txt"), "second project").unwrap();
    h.host.open_project("second", &second).unwrap();
    let discovery = ide_mcp::discovery_path(h.tmp.path());
    let _server = ide_mcp::McpServer::start(
        Arc::new(Registry::new(h.host.clone())),
        Some(discovery.clone()),
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file","arguments":{
        "projectPath":second.join("nested"),"file_path":"unique.txt"}}});
    let input = format!("{request}\n");
    let mut output = Vec::new();
    ide_mcp::stdio::bridge(&discovery, &h.root, input.as_bytes(), &mut output).await.unwrap();
    let reply: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(reply["result"]["content"][0]["text"], "L1: second project");
}

#[tokio::test(flavor = "multi_thread")]
async fn mutations_preserve_unsaved_text_and_reject_metadata_and_escapes() {
    let h = Harness::new();
    h.trust().await;
    let p = h.host.project("main").unwrap();
    let path = h.root.join("src/a.txt");
    let doc = p.documents.open(&path).unwrap();
    p.documents
        .edit(doc.id, doc.version, ChangeSet { changes: vec![TextChange { from: 0, to: 3, insert: "unsaved".into() }] })
        .unwrap();
    let output = h.call("apply_patch", json!({"input":"*** Begin Patch\n*** Update File: src/a.txt\n@@\n-unsaved text\n+agent text\n*** End Patch"})).await;
    assert!(output.starts_with("1 out of 1"), "{output}");
    assert_eq!(p.documents.text_snapshot(doc.id).unwrap().text, "agent text\nneedle needle\n");
    assert!(p.documents.is_dirty(doc.id).unwrap());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "old text\nneedle needle\n");
    assert!(
        h.events.lock().unwrap().iter().any(|e| matches!(e, IdeEvent::DocPatched { doc: id, .. } if *id == doc.id))
    );
    let edit_id = h
        .events
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find_map(|event| match event {
            IdeEvent::WorkspaceEditApplied { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap();
    p.documents.undo_workspace_edit(edit_id).unwrap();
    assert_eq!(p.documents.text_snapshot(doc.id).unwrap().text, "unsaved text\nneedle needle\n");
    p.documents.redo_workspace_edit(edit_id).unwrap();
    assert_eq!(p.documents.text_snapshot(doc.id).unwrap().text, "agent text\nneedle needle\n");
    h.call("create_new_file", json!({"pathInProject":"new/deep.txt","text":"hello\r\n"})).await;
    // A new file gets the platform's default line separator.
    let expected = if cfg!(windows) { "hello\r\n" } else { "hello\n" };
    assert_eq!(std::fs::read_to_string(h.root.join("new/deep.txt")).unwrap(), expected);
    h.call("create_new_file", json!({"pathInProject":"src/a.txt","text":"buffer only","overwrite":true})).await;
    assert_eq!(p.documents.text_snapshot(doc.id).unwrap().text, "buffer only");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "old text\nneedle needle\n");
    for path in [".git/config", "nested/.git/HEAD", "../escape.txt"] {
        let e = h.error("create_new_file", json!({"pathInProject":path,"text":"no"})).await;
        assert!(e.contains("VCS metadata") || e.contains("outside"), "{path}: {e}");
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(h.tmp.path(), h.root.join("escape")).unwrap();
        assert!(h.error("create_new_file", json!({"pathInProject":"escape/outside.txt"})).await.contains("outside"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn execution_requires_a_window_and_denial_never_runs_a_build() {
    let h = Harness::new();
    h.trust().await;
    assert!(h.error("build_project", json!({})).await.contains("no project window"));
    h.host.mcp_requests.set_ready("main", true);
    let denied = h.error("build_project", json!({}));
    let answer = async {
        let id = h.request().await;
        assert!(h.host.mcp_requests.answer("other", id, true, None).is_err());
        h.host.mcp_requests.answer("main", id, false, None).unwrap();
    };
    let (error, ()) = tokio::join!(denied, answer);
    assert!(error.contains("denied by the user"), "{error}");
    assert!(h.host.processes.list().is_empty());
    assert!(h.events.lock().unwrap().iter().any(|e| matches!(e, IdeEvent::McpRequestClosed { .. })));
    h.events.lock().unwrap().clear();
    let closed = h.error("build_project", json!({}));
    let close = async {
        h.request().await;
        h.host.mcp_requests.forget_window("main");
    };
    let (error, ()) = tokio::join!(closed, close);
    assert!(error.contains("window closed"), "{error}");
}

#[tokio::test(flavor = "multi_thread")]
async fn git_status_and_diff_on_a_temporary_repository() {
    let h = Harness::new();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git").current_dir(&h.root).args(args).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    };
    git(&["init"]);
    git(&["add", "."]);
    git(&["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let helper = h.tmp.path().join("fsmonitor");
        std::fs::write(&helper, format!("#!/bin/sh\ntouch '{}'\n", h.tmp.path().join("executed").display())).unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&["config", "core.fsmonitor", helper.to_str().unwrap()]);
    }
    std::fs::write(h.root.join("src/a.txt"), "changed\n").unwrap();
    let status = h.json("git_status", json!({"repositoryPathRelativeToProject":"."})).await;
    assert_eq!(status["repositories"][0]["unstagedCount"], 1);
    assert!(h.call("git_diff", json!({"filePath":"src/a.txt"})).await.contains("+changed"));
    assert!(h.call("git_diff", json!({})).await.contains("src/a.txt"));
    assert!(h.call("git_diff", json!({"staged":true})).await.is_empty());
    assert!(!h.tmp.path().join("executed").exists());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn reformat_uses_the_formatter_chain_and_preserves_a_dirty_buffer() {
    use std::os::unix::fs::PermissionsExt;
    let h = Harness::new();
    h.trust().await;
    std::fs::create_dir_all(h.root.join("vendor/bin")).unwrap();
    std::fs::write(h.root.join("vendor/bin/php-cs-fixer"), "").unwrap();
    std::fs::write(h.root.join(".php-cs-fixer.dist.php"), "<?php").unwrap();
    let php = h.root.join("fake-php");
    std::fs::write(&php, "#!/bin/sh\nfor last; do :; done\nsed 's/  echo/    echo/' \"$last\" > \"$last.new\" && mv \"$last.new\" \"$last\"\n").unwrap();
    std::fs::set_permissions(&php, std::fs::Permissions::from_mode(0o755)).unwrap();
    let p = h.host.project("main").unwrap();
    p.settings.set(ide_workspace::SettingsScope::Project, "languages.php.interpreter", json!(php)).unwrap();
    let path = h.root.join("src/Example.php");
    std::fs::write(&path, "<?php\n  echo 1;\n").unwrap();
    let doc = p.documents.open(&path).unwrap();
    p.documents
        .edit(doc.id, doc.version, ChangeSet { changes: vec![TextChange { from: 13, to: 14, insert: "2".into() }] })
        .unwrap();
    let before = p.documents.text_snapshot(doc.id).unwrap().text;
    let diff = h.call("reformat_file", json!({"files":["src/Example.php"]})).await;
    assert!(diff.contains("+    echo"), "{diff}");
    assert_eq!(p.documents.text_snapshot(doc.id).unwrap().text, before.replace("  echo", "    echo"));
    assert_eq!(std::fs::read_to_string(path).unwrap(), "<?php\n  echo 1;\n");
    assert!(p.documents.is_dirty(doc.id).unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn execute_reports_output_exit_code_and_requires_confirmation() {
    let h = Harness::new();
    h.trust().await;
    let config = ide_run::RunConfig {
        id: "test".into(),
        name: "MCP test".into(),
        kind: "shell".into(),
        command: if cfg!(windows) { "echo captured-output& exit 7" } else { "echo captured-output; exit 7" }.into(),
        args: vec![],
        cwd: None,
        env: Default::default(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    ide_run::save_user_configs(&h.root, &[config]).unwrap();
    assert!(
        h.error("execute_run_configuration", json!({"configurationName":"MCP test"}))
            .await
            .contains("no project window")
    );
    h.host.mcp_requests.set_ready("main", true);
    let denied = h.error("execute_run_configuration", json!({"configurationName":"MCP test"}));
    let deny = async {
        let id = h.request().await;
        h.host.mcp_requests.answer("main", id, false, None).unwrap();
    };
    let (error, ()) = tokio::join!(denied, deny);
    assert!(error.contains("denied by the user"));
    assert!(h.host.processes.list().is_empty());
    h.events.lock().unwrap().clear();
    let run = h.json("execute_run_configuration", json!({"configurationName":"MCP test","timeout":10000}));
    let allow = async {
        let id = h.request().await;
        h.host.mcp_requests.answer("main", id, true, None).unwrap();
    };
    let (result, ()) = tokio::join!(run, allow);
    assert_eq!(result["exitCode"], 7);
    assert!(result["output"].as_str().unwrap().contains("captured-output"));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires rust-analyzer, like language_smoke::rust"]
async fn rust_references_and_rename_through_mcp() {
    let h = Harness::new();
    h.trust().await;
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/rust-app");
    for name in ["Cargo.toml", "Cargo.lock"] {
        std::fs::copy(fixture.join(name), h.root.join(name)).unwrap();
    }
    for name in ["lib.rs", "main.rs", "parser.rs"] {
        std::fs::copy(fixture.join("src").join(name), h.root.join("src").join(name)).unwrap();
    }
    let project = h.host.project("main").unwrap();
    let doc = project.documents.open(&h.root.join("src/lib.rs")).unwrap();
    let text = project.documents.text_snapshot(doc.id).unwrap().text;
    let (line, row) = text.lines().enumerate().find(|(_, row)| row.contains("fn format_price")).unwrap();
    let column = row[..row.find("format_price").unwrap()].encode_utf16().count() + 1;
    let args = json!({"filePath":"src/lib.rs", "line":line + 1, "column":column});
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        let result = tokio::task::spawn_blocking({
            let host = h.host.clone();
            let root = h.root.clone();
            let args = args.to_string();
            move || Registry::new(host).call(&root, "find_references", &args, CancellationToken::new())
        })
        .await
        .unwrap();
        if let Ok(result) = result {
            let refs: Value = serde_json::from_str(&result).unwrap();
            if refs["locations"].as_array().is_some_and(|locations| {
                locations.iter().any(|l| l["path"].as_str().is_some_and(|p| p.ends_with("main.rs")))
            }) {
                break;
            }
        }
        assert!(std::time::Instant::now() < deadline, "language server did not find format_price references");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    let result = h.json("rename_refactoring", json!({"pathInProject":"src/lib.rs", "symbolName":"format_price", "newName":"format_amount", "line":line + 1, "column":column})).await;
    assert_eq!(result["applied"], true, "{result}");
    assert!(project.documents.text_snapshot(doc.id).unwrap().text.contains("format_amount"));
    assert!(std::fs::read_to_string(h.root.join("src/main.rs")).unwrap().contains("format_amount"));
}

#[tokio::test(flavor = "multi_thread")]
async fn brave_mode_runs_tools_without_asking_only_from_the_global_settings() {
    let h = Harness::new();
    h.trust().await;
    h.host.mcp_requests.set_ready("main", true);
    let p = h.host.project("main").unwrap();
    // A project's own settings can't turn the confirmations off.
    let project_layer =
        p.settings.set(ide_workspace::SettingsScope::Project, "mcpServer.runWithoutConfirmation", json!(true));
    assert!(project_layer.is_err());
    let denied = h.error("build_project", json!({}));
    let answer = async {
        let id = h.request().await;
        h.host.mcp_requests.answer("main", id, false, None).unwrap();
    };
    let (error, ()) = tokio::join!(denied, answer);
    assert!(error.contains("denied by the user"), "{error}");

    h.events.lock().unwrap().clear();
    h.host
        .global_settings
        .set(ide_workspace::SettingsScope::Global, "mcpServer.runWithoutConfirmation", json!(true))
        .unwrap();
    let (host, root) = (h.host.clone(), h.root.clone());
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::task::spawn_blocking(move || {
            Registry::new(host).call(&root, "build_project", "{}", CancellationToken::new())
        }),
    )
    .await
    .expect("ran without waiting for an answer")
    .unwrap();
    assert!(!format!("{result:?}").contains("denied"), "{result:?}");
    assert!(!h.events.lock().unwrap().iter().any(|e| matches!(e, IdeEvent::McpRequest { .. })), "nothing asked");
}

#[tokio::test(flavor = "multi_thread")]
async fn check_files_says_why_a_file_could_not_be_checked() {
    let h = Harness::new();
    let untrusted = h.json("check_files", json!({"filePaths": ["src/a.txt"]})).await;
    assert_eq!(untrusted["files"][0]["status"], "untrusted", "{untrusted}");
    h.trust().await;
    let files = h.json("check_files", json!({"filePaths": ["src/a.txt", "src/gone.txt"], "timeout": 5000})).await;
    assert_eq!(files["files"][0]["filePath"], "src/a.txt");
    assert_eq!(files["files"][0]["status"], "noLanguageServer", "{files}");
    assert_eq!(files["files"][0]["problems"], json!([]));
    assert_eq!(files["files"][1]["status"], "failed", "{files}");
    assert!(files["files"][1]["error"].is_string());
    // No cap of the tool's own: a very long timeout is taken as given, without overflowing.
    let long = h.json("check_files", json!({"filePaths": ["src/a.txt"], "timeout": 9_000_000_000_000_i64})).await;
    assert_eq!(long["files"][0]["status"], "noLanguageServer", "{long}");
    let none = h.error("check_files", json!({"filePaths": []})).await;
    assert!(none.contains("at least one file"), "{none}");
}

/// Answers `run_command`'s window requests the way the Run tool window does: starts the
/// agent tab's configuration (shell from the default) and says whether it started. Returns
/// the configurations it started, for reruns.
#[cfg(unix)]
fn run_tool_window(h: &Harness) -> Arc<std::sync::Mutex<Vec<ide_run::RunConfig>>> {
    let started = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (host, events, out) = (h.host.clone(), h.events.clone(), started.clone());
    tokio::spawn(async move {
        let mut handled = std::collections::HashSet::new();
        loop {
            let request = events.lock().unwrap().iter().find_map(|e| match e {
                IdeEvent::McpRequest {
                    id,
                    request: ide_core::event::McpUiRequest::AgentRun { name, command, cwd, env },
                } if !handled.contains(id) => Some((*id, name.clone(), command.clone(), cwd.clone(), env.clone())),
                _ => None,
            });
            let Some((id, name, command, cwd, env)) = request else {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                continue;
            };
            handled.insert(id);
            let mut config = ide_run::RunConfig {
                id: format!("mcp-agent:{name}"),
                name: name.clone(),
                kind: "shell".into(),
                command,
                args: Vec::new(),
                cwd: Some(cwd),
                env,
                detected: false,
                is_test: false,
                debug_adapter: None,
                allow_parallel: true,
                extras: Default::default(),
            };
            config.extras.params.insert(ide_host::mcp::AGENT_PARAM.into(), name);
            config.extras.target = Some(String::new());
            out.lock().unwrap().push(config.clone());
            let result = ide_host::ops::run::start(&host, "main", config, Arc::new(|_| {})).await;
            let error = result.err().map(|e| e.message);
            let _ = host.mcp_requests.answer("main", id, error.is_none(), error);
        }
    });
    started
}

#[cfg(unix)]
fn agent_process(h: &Harness, name: &str) -> ide_core::RunId {
    let id = format!("mcp-agent:{name}");
    h.host.processes.list().into_iter().filter(|r| r.config_id == id && r.running).map(|r| r.id).max().unwrap()
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn agent_commands_run_in_named_tabs_and_report_what_the_user_did() {
    let h = Harness::new();
    h.trust().await;
    h.host.mcp_requests.set_ready("main", true);
    h.host
        .global_settings
        .set(ide_workspace::SettingsScope::Global, "mcpServer.runWithoutConfirmation", json!(true))
        .unwrap();
    let started = run_tool_window(&h);

    // A command that finishes within the wait, in a tab named with the prefix.
    let done = h.json("run_command", json!({"name": "check", "command": "echo hel''lo; exit 3"})).await;
    assert_eq!(done["name"], "_agent_check", "{done}");
    assert_eq!(done["state"], "failed", "{done}");
    assert_eq!(done["exitCode"], 3);
    assert_eq!(done["startedBy"], "agent");
    assert!(done["output"].as_str().unwrap().contains("hello"), "{done}");
    assert!(done.get("interventions").is_none());

    // The finished name runs the next command; a running one is refused, never stopped.
    let running =
        h.json("run_command", json!({"name": "_agent_check", "command": "echo ready; sleep 30", "timeout": 0})).await;
    assert_eq!(running["state"], "running", "{running}");
    let matched = h.json("wait_for_run", json!({"name": "check", "pattern": "(?m)^ready", "timeout": 10000})).await;
    assert_eq!(matched["waitEnded"], "matched", "{matched}");
    let refused = h.error("run_command", json!({"name": "check", "command": "true"})).await;
    assert!(refused.contains("still running `echo ready; sleep 30`"), "{refused}");
    assert!(refused.contains("Last output:\nready"), "the refusal quotes the last output: {refused}");

    // What the user types (a line from the Run console's input) ends a wait at once, with advice for the agent.
    let process = agent_process(&h, "_agent_check");
    ide_host::ops::run::stdin(&h.host, process, "yes\n").unwrap();
    let typed = h.json("wait_for_run", json!({"name": "check", "timeout": 10000})).await;
    assert_eq!(typed["waitEnded"], "userIntervened", "{typed}");
    assert_eq!(typed["interventions"][0]["message"], "User input: yes");
    assert!(typed["advice"].as_str().unwrap().contains("Do not stop the process"));
    let input = h.json("send_run_input", json!({"name": "check", "text": "abc", "keys": ["Enter"]})).await;
    assert!(input.get("interventions").is_none(), "the agent's own input is no intervention: {input}");

    let stopped = h.json("stop_run", json!({"name": "check", "force": true, "timeout": 10000})).await;
    assert_eq!(stopped["state"], "stoppedByAgent", "{stopped}");
    assert!(stopped.get("interventions").is_none());

    // The user's Stop, rerun and closing the tab are reported with their time.
    h.json("run_command", json!({"name": "server", "command": "sleep 30", "timeout": 0})).await;
    ide_host::ops::run::stop(&h.host, "main", agent_process(&h, "_agent_server")).unwrap();
    let stop = h.json("wait_for_run", json!({"name": "server", "timeout": 10000})).await;
    assert!(stop["interventions"][0]["message"].as_str().unwrap().starts_with("The user stopped this command at"));
    let ended = h.json("wait_for_run", json!({"name": "server", "timeout": 10000})).await;
    assert_eq!(ended["state"], "stoppedByUser", "{ended}");

    let config = started.lock().unwrap().last().cloned().unwrap();
    ide_host::ops::run::start(&h.host, "main", config, Arc::new(|_| {})).await.unwrap();
    let status = h.json("get_run_status", json!({"name": "server"})).await;
    assert_eq!(status["startedBy"], "user", "{status}");
    assert!(status["interventions"][0]["message"].as_str().unwrap().starts_with("The user reran this command at"));
    h.json("stop_run", json!({"name": "server", "force": true, "timeout": 10000})).await;
    h.host.mcp_agent_runs.closed(&h.root, "_agent_server");
    let closed = h.json("get_run_status", json!({"name": "server"})).await;
    assert!(closed["tabClosedAt"].is_string(), "{closed}");
    assert!(closed["interventions"][0]["message"].as_str().unwrap().starts_with("The user closed this tab at"));

    let log = h.json("read_run_output", json!({"name": "check", "maxLinesCount": 20})).await;
    assert!(log["output"].as_str().unwrap().contains("ready"), "{log}");
    let from_start = h.json("read_run_output", json!({"name": "check", "offset": 0})).await;
    assert!(from_start["output"].as_str().unwrap().contains("hello"), "one log across the tab's commands");
    let runs = h.json("list_runs", json!({})).await;
    assert_eq!(runs["runs"].as_array().unwrap().len(), 2, "{runs}");
    let missing = h.error("get_run_status", json!({"name": "nothing"})).await;
    assert!(missing.contains("no agent tab named `_agent_nothing`"), "{missing}");

    // Pipes: plain lines, cleaned of escapes and cut to maxLinesCount (the end stays by default).
    let printf = "printf '\\033[31mone\\033[0m\\ntwo\\nthree\\n'";
    let lines =
        h.json("run_command", json!({"name": "lines", "command": printf, "maxLinesCount": 2, "timeout": 10000})).await;
    assert_eq!(lines["output"], "<<<...content truncated...>>>\ntwo\nthree\n", "{lines}");
    assert_eq!(lines["truncatedLines"], 1);
    let head = h.json("read_run_output", json!({"name": "lines", "maxLinesCount": 1, "truncateMode": "END"})).await;
    assert_eq!(head["output"], "one\n<<<...content truncated...>>>\n", "{head}");

    // Ctrl+C stops the command as stop_run does; terminal keys have no meaning on pipes.
    h.json("run_command", json!({"name": "interrupt", "command": "sleep 30", "timeout": 0})).await;
    let key = h.error("send_run_input", json!({"name": "interrupt", "keys": ["Up"]})).await;
    assert!(key.contains("runs on pipes"), "{key}");
    h.json("send_run_input", json!({"name": "interrupt", "keys": ["Ctrl+C"]})).await;
    let interrupted = h.json("wait_for_run", json!({"name": "interrupt", "timeout": 10000})).await;
    assert_eq!(interrupted["state"], "stoppedByAgent", "{interrupted}");
}
