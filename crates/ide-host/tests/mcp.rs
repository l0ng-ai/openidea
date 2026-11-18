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
    assert_eq!(found["nextOffset"], 2);
    // The next page goes on where this one ended.
    let every = h.json("search_text", json!({"q":"needle","limit":20})).await["items"].as_array().unwrap().clone();
    let next = h.json("search_text", json!({"q":"needle","limit":2,"offset":2})).await;
    assert_eq!(next["items"].as_array().unwrap()[..], every[2..every.len().min(4)]);
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
    assert_eq!(h.json("get_project_problems", json!({})).await["files"], json!([]), "errors only by default");
    let all = h.json("get_project_problems", json!({"errorsOnly":false})).await;
    assert_eq!((all["files"].as_array().unwrap().len(), &all["total"]), (1, &json!(1)));
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
async fn trusted_attached_projects_are_writable_and_reach_the_window_they_are_attached_in() {
    let h = Harness::new();
    h.trust().await;
    let base = dunce::canonicalize(h.tmp.path()).unwrap();
    let (attached, untrusted, other) = (base.join("attached"), base.join("untrusted"), base.join("other"));
    for dir in [&attached, &untrusted, &other] {
        std::fs::create_dir_all(dir).unwrap();
    }
    ide_workspace::workspace::Workspace::attach(
        &h.root,
        "project",
        vec![h.root.clone(), attached.clone(), untrusted.clone()],
    )
    .unwrap();
    h.host.trust.decide(&attached, true, false).unwrap();

    // Outside the project folder, by absolute path.
    let file = attached.join("new.txt");
    h.call("create_new_file", json!({"pathInProject": file, "text": "hello"})).await;
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello");
    let shown = file.to_string_lossy().replace('\\', "/");
    let patch = format!("*** Begin Patch\n*** Update File: {shown}\n@@\n-hello\n+patched\n*** End Patch");
    let output = h.call("apply_patch", json!({ "input": patch })).await;
    assert!(output.starts_with("1 out of 1"), "{output}");
    assert!(std::fs::read_to_string(&file).unwrap().starts_with("patched"));
    for dir in [&untrusted, &other] {
        let e = h.error("create_new_file", json!({"pathInProject": dir.join("x.txt"), "text": "no"})).await;
        assert!(e.contains("outside"), "{}: {e}", dir.display());
        assert!(!dir.join("x.txt").exists());
    }

    // A `projectPath` naming the attached project reaches the window it is attached in.
    let registry = Registry::new(h.host.clone());
    assert!(registry.projects().contains(&attached));
    let read = tokio::task::spawn_blocking(move || {
        registry.call(&attached, "read_file", &json!({"file_path": "src/b.txt"}).to_string(), CancellationToken::new())
    })
    .await
    .unwrap()
    .unwrap();
    assert!(read.starts_with("L1: needle"), "{read}");
}

#[tokio::test(flavor = "multi_thread")]
async fn files_of_a_project_attached_outside_go_by_their_absolute_path_everywhere() {
    let h = Harness::new();
    h.trust().await;
    let attached = dunce::canonicalize(h.tmp.path()).unwrap().join("attached");
    std::fs::create_dir_all(attached.join("src")).unwrap();
    std::fs::write(attached.join("src/lib.rs"), "pub fn attached_marker() {}\n").unwrap();
    let git = std::process::Command::new("git").current_dir(&attached).args(["init", "-q"]).status().unwrap();
    assert!(git.success());
    h.host.trust.decide(&attached, true, false).unwrap();
    ide_host::ops::project::attach_workspace(&h.host, "main", &attached).unwrap();
    assert!(h.host.project("main").unwrap().index.wait_idle(std::time::Duration::from_secs(10)));
    let shown = |rel: &str| attached.join(rel).to_string_lossy().replace('\\', "/");

    let files = h.json("search_file", json!({"q":"**/lib.rs"})).await;
    assert_eq!(files["items"], json!([{ "filePath": shown("src/lib.rs") }]));
    let symbols = h.json("search_symbol", json!({"q":"attached_marker"})).await;
    assert_eq!(symbols["items"][0]["filePath"], shown("src/lib.rs"), "{symbols}");
    assert_eq!(symbols["items"][0]["lineText"], "pub fn attached_marker() {}");
    let status = h.json("git_status", json!({})).await;
    let repos: Vec<&str> = status["repositories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["repositoryPathRelativeToProject"].as_str().unwrap())
        .collect();
    assert!(repos.contains(&shown("").trim_end_matches('/')), "{repos:?}");

    // `paths` names such a project by its absolute path, in every tool.
    let only = json!([format!("{}/src/**", shown(""))]);
    let files = h.json("search_file", json!({"q":"*.rs","paths":only})).await;
    assert_eq!(files["items"], json!([{ "filePath": shown("src/lib.rs") }]));
    let text = h.json("search_text", json!({"q":"attached_marker","paths":only})).await;
    assert_eq!(text["items"][0]["filePath"], shown("src/lib.rs"), "{text}");
    let symbols = h.json("search_symbol", json!({"q":"attached_marker","paths":only})).await;
    assert_eq!(symbols["items"][0]["filePath"], shown("src/lib.rs"), "{symbols}");
    let status = h.json("git_status", json!({"paths":only})).await;
    assert_eq!(status["repositories"].as_array().unwrap().len(), 1, "{status}");
    assert_eq!(status["repositories"][0]["repositoryPathRelativeToProject"], shown("").trim_end_matches('/'));
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
            // Undoable like a refactoring, but marked as the agent's, so it isn't announced as one.
            IdeEvent::WorkspaceEditApplied { id, by_agent, .. } => {
                assert!(*by_agent, "an MCP edit is the agent's");
                Some(*id)
            }
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
async fn run_configurations_are_listed_a_page_at_a_time_and_filtered() {
    let h = Harness::new();
    h.trust().await;
    let saved = |name: &str, command: &str, env: &[(&str, &str)]| ide_run::RunConfig {
        id: format!("user:{name}"),
        name: name.into(),
        kind: "shell".into(),
        command: command.into(),
        args: Vec::new(),
        cwd: None,
        env: env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let configs =
        [saved("build", "tsc", &[("MODE", "ci")]), saved("lint", "oxlint .", &[]), saved("test", "vitest", &[])];
    ide_run::save_user_configs(&h.root, &configs).unwrap();
    let all = h.json("get_run_configurations", json!({})).await;
    let total = all["total"].as_u64().unwrap();
    assert!(total >= 3, "{all}");
    // A saved configuration's own environment is listed.
    let build = all["configurations"].as_array().unwrap().iter().find(|c| c["name"] == "build").unwrap();
    assert_eq!(build["environment"], json!({ "MODE": "ci" }));
    let first = h.json("get_run_configurations", json!({"limit": 1})).await;
    assert_eq!((first["configurations"].as_array().unwrap().len(), &first["nextOffset"]), (1, &json!(1)));
    let lint = h.json("get_run_configurations", json!({"query": "OXLINT"})).await;
    let found = lint["configurations"].as_array().unwrap();
    assert!(!found.is_empty() && (found.len() as u64) < total, "{lint}");
    assert!(found.iter().all(|c| c.to_string().to_lowercase().contains("oxlint")), "{lint}");
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
    // Two entries, one per page.
    std::fs::write(h.root.join("src/new.txt"), "new\n").unwrap();
    let page =
        |offset: u64| h.json("git_status", json!({"repositoryPathRelativeToProject":".","limit":1,"offset":offset}));
    let first = page(0).await["repositories"][0].clone();
    assert_eq!(
        (&first["totalEntries"], &first["hasMoreEntries"], &first["nextOffset"]),
        (&json!(2), &json!(true), &json!(1))
    );
    let second = page(1).await["repositories"][0].clone();
    assert_ne!(second["entries"][0], first["entries"][0]);
    assert!(second.get("nextOffset").is_none(), "{second}");
    assert!(h.call("git_diff", json!({"filePath":"src/a.txt"})).await.contains("+changed"));
    assert!(h.call("git_diff", json!({})).await.contains("src/a.txt"));
    assert!(h.call("git_diff", json!({"staged":true})).await.is_empty());
    assert!(!h.tmp.path().join("executed").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn paths_limit_the_query_tools_to_folders() {
    let h = Harness::new();
    std::fs::create_dir_all(h.root.join("lib")).unwrap();
    std::fs::write(h.root.join("lib/c.txt"), "needle\n").unwrap();
    let paths = |v: &Value| -> Vec<String> {
        let mut out: Vec<String> =
            v["items"].as_array().unwrap().iter().map(|i| i["filePath"].as_str().unwrap().to_owned()).collect();
        out.dedup();
        out
    };
    assert_eq!(paths(&h.json("search_text", json!({"q":"needle","paths":["lib/"]})).await), ["lib/c.txt"]);
    assert_eq!(paths(&h.json("search_regex", json!({"q":"need.e","paths":["lib/**"]})).await), ["lib/c.txt"]);
    let absolute = h.root.join("src").to_string_lossy().into_owned();
    assert_eq!(
        paths(&h.json("search_file", json!({"q":"*.txt","paths":[absolute]})).await),
        ["src/a.txt", "src/b.txt"]
    );
    // Several folders at once, and exclusions.
    assert_eq!(
        paths(&h.json("search_text", json!({"q":"needle","paths":["src/**","lib/**","!**/a.txt"]})).await),
        ["lib/c.txt", "src/b.txt"]
    );
    let outside = h.error("search_text", json!({"q":"needle","paths":["../**"]})).await;
    assert!(outside.contains("outside of the project directory"), "{outside}");

    let git = |args: &[&str]| {
        let output = std::process::Command::new("git").current_dir(&h.root).args(args).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    };
    git(&["init"]);
    git(&["add", "."]);
    git(&["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial"]);
    std::fs::write(h.root.join("src/a.txt"), "changed\n").unwrap();
    std::fs::write(h.root.join("lib/c.txt"), "changed\n").unwrap();
    let status = h.json("git_status", json!({"paths":["lib/"]})).await;
    assert_eq!(status["repositories"].as_array().unwrap().len(), 1);
    assert_eq!(
        status["repositories"][0]["entries"],
        json!([{"pathRelativeToRepository":"lib/c.txt","indexStatus":" ","workTreeStatus":"M"}])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn excluded_and_ignored_folders_are_searched_when_asked_for() {
    let h = Harness::new();
    // `ignored/` is ignored by the project's `.gitignore`; `excluded/` is excluded in its settings.
    std::fs::create_dir_all(h.root.join("excluded")).unwrap();
    std::fs::write(h.root.join("excluded/e.txt"), "needle\n").unwrap();
    std::fs::create_dir_all(h.root.join("src/ignored")).unwrap();
    std::fs::write(h.root.join("src/ignored/x.txt"), "needle\n").unwrap();
    ide_host::ops::project::set_settings(
        &h.host,
        "main",
        ide_workspace::settings::SettingsScope::Project,
        "projectStructure.excluded",
        "[\"excluded\"]",
    )
    .unwrap();
    let found = |args: Value| {
        let h = &h;
        async move {
            let v = h.json(args["tool"].as_str().unwrap(), args["args"].clone()).await;
            let mut out: Vec<String> = v["items"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|i| i["filePath"].as_str().unwrap().to_owned())
                .collect();
            out.sort();
            out.dedup();
            out
        }
    };
    let text = |args: Value| json!({ "tool": "search_text", "args": args });
    assert_eq!(found(text(json!({"q":"needle"}))).await, ["src/a.txt", "src/b.txt"]);
    let every = ["excluded/e.txt", "ignored/a.txt", "src/a.txt", "src/b.txt", "src/ignored/x.txt"];
    assert_eq!(found(text(json!({"q":"needle","includeExcluded":true}))).await, every);
    assert_eq!(found(json!({"tool":"search_regex","args":{"q":"need.e","includeExcluded":true}})).await, every);
    // `paths` only narrows: a folder the project leaves out stays out when named ...
    let nothing: Vec<String> = Vec::new();
    assert_eq!(found(text(json!({"q":"needle","paths":["ignored/"]}))).await, nothing);
    assert_eq!(found(text(json!({"q":"needle","paths":["excluded/"]}))).await, nothing);
    // ... and is searched, alone, when asked for.
    assert_eq!(
        found(text(json!({"q":"needle","paths":["ignored/","excluded/"],"includeExcluded":true}))).await,
        ["excluded/e.txt", "ignored/a.txt"]
    );
    let file = |dir: &str| json!({"tool":"search_file","args":{"q":"*.txt","paths":[dir],"includeExcluded":true}});
    assert_eq!(found(file("excluded/")).await, ["excluded/e.txt"]);
    assert_eq!(found(file("ignored/")).await, ["ignored/a.txt"]);
    assert_eq!(found(text(json!({"q":"needle","paths":["src/"]}))).await, ["src/a.txt", "src/b.txt"]);
    assert_eq!(
        found(text(json!({"q":"needle","paths":["src/"],"includeExcluded":true}))).await,
        ["src/a.txt", "src/b.txt", "src/ignored/x.txt"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_symbol_search_with_paths_finds_matches_past_the_others() {
    let h = Harness::new();
    std::fs::create_dir_all(h.root.join("many")).unwrap();
    for i in 0..60 {
        std::fs::write(h.root.join(format!("many/m{i:02}.rs")), "pub fn pool_marker() {}\n").unwrap();
    }
    std::fs::create_dir_all(h.root.join("zz")).unwrap();
    std::fs::write(h.root.join("zz/last.rs"), "pub fn pool_marker() {}\n").unwrap();
    // Files written after the project opened reach the index through the watcher.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while h.json("search_symbol", json!({"q":"pool_marker","limit":100})).await["items"].as_array().map_or(0, Vec::len)
        < 61
    {
        assert!(std::time::Instant::now() < deadline, "the files were never indexed");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let found = h.json("search_symbol", json!({"q":"pool_marker","paths":["zz/"],"limit":1})).await;
    assert_eq!(found["items"][0]["filePath"], "zz/last.rs", "{found}");
}

#[tokio::test(flavor = "multi_thread")]
async fn paths_reach_an_attached_worktree_the_repository_ignores() {
    let h = Harness::new();
    h.trust().await;
    let git = |dir: &Path, args: &[&str]| {
        let output = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    };
    git(&h.root, &["init"]);
    git(&h.root, &["add", "."]);
    git(&h.root, &["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial"]);
    std::fs::write(h.root.join(".git/info/exclude"), "/.wt/\n").unwrap();
    git(&h.root, &["worktree", "add", "-q", ".wt/feature"]);
    let worktree = h.root.join(".wt/feature");
    h.host.trust.decide(&worktree, true, false).unwrap();
    ide_host::ops::project::attach_workspace(&h.host, "main", &worktree).unwrap();
    // Hidden folders excluded by name: `.wt` is one, the worktree's own files are not.
    ide_host::ops::project::set_settings(
        &h.host,
        "main",
        ide_workspace::settings::SettingsScope::Project,
        "projectStructure.excludeFiles",
        "\".*\"",
    )
    .unwrap();
    let found = |args: Value| {
        let h = &h;
        async move {
            let v = h.json("search_text", args).await;
            let mut out: Vec<String> = v["items"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|i| i["filePath"].as_str().unwrap().to_owned())
                .collect();
            out.dedup();
            out
        }
    };
    let everywhere = found(json!({"q":"needle"})).await;
    assert!(everywhere.contains(&".wt/feature/src/b.txt".to_owned()), "{everywhere:?}");
    assert_eq!(
        found(json!({"q":"needle","paths":[".wt/feature/src/"]})).await,
        [".wt/feature/src/a.txt", ".wt/feature/src/b.txt"]
    );
    assert_eq!(found(json!({"q":"needle","paths":[".wt/feature/src/b.txt"]})).await, [".wt/feature/src/b.txt"]);
    // With `includeExcluded` the root's walk enters the ignored worktree: its files still come once.
    let all = h.json("search_text", json!({"q":"needle","includeExcluded":true})).await;
    let items = all["items"].as_array().unwrap();
    assert_eq!(items.iter().filter(|i| i["filePath"] == ".wt/feature/src/b.txt").count(), 1, "{all}");
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
    // Its callers, the callees of one of them, and the hierarchy at a call.
    let callers = h.json("get_call_hierarchy", args.clone()).await;
    assert_eq!(callers["root"]["name"], "format_price", "{callers}");
    let main = callers["items"].as_array().unwrap().iter().find(|i| i["name"] == "main").expect("main calls it");
    assert_eq!(main["filePath"], "src/main.rs");
    let call = main["callSites"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["lineText"].as_str().unwrap().contains("format_price("))
        .expect("the call in main");
    assert_eq!(call["filePath"], "src/main.rs");
    let callees = h
        .json("get_call_hierarchy", json!({"filePath":"src/main.rs", "line":main["startLine"], "column":main["startColumn"], "direction":"outgoing"}))
        .await;
    // rust-analyzer leaves out the calls inside macro arguments, such as `format_price` in `println!`.
    let parse = callees["items"].as_array().unwrap().iter().find(|i| i["name"] == "parse").expect("main calls parse");
    assert_eq!(
        (&parse["filePath"], &parse["callSites"][0]["filePath"]),
        (&json!("src/parser.rs"), &json!("src/main.rs"))
    );
    let at_call = h
        .json("get_call_hierarchy", json!({"filePath":"src/main.rs", "line":call["startLine"], "column":call["startColumn"], "direction":"outgoing"}))
        .await;
    assert_eq!(
        (&at_call["root"]["name"], &at_call["root"]["filePath"]),
        (&json!("format_price"), &json!("src/lib.rs"))
    );
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
            let result =
                ide_host::ops::run::run_start(&host, "main", config, ide_host::ops::Channel::new(|_| {}), None).await;
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
async fn run_command_returns_once_a_server_prints_its_ready_line() {
    let h = Harness::new();
    h.trust().await;
    h.host.mcp_requests.set_ready("main", true);
    h.host
        .global_settings
        .set(ide_workspace::SettingsScope::Global, "mcpServer.runWithoutConfirmation", json!(true))
        .unwrap();
    let _started = run_tool_window(&h);
    // A server started with its ready line returns once it prints it, long before the timeout.
    let started_at = std::time::Instant::now();
    let up = h
        .json(
            "run_command",
            json!({"name": "web", "command": "sleep 1; echo Listening on 8080; sleep 30", "pattern": "Listening on", "timeout": 60000}),
        )
        .await;
    assert_eq!((up["waitEnded"].as_str(), up["state"].as_str()), (Some("matched"), Some("running")), "{up}");
    assert!(up["output"].as_str().unwrap().contains("Listening on 8080"), "{up}");
    assert!(started_at.elapsed() < std::time::Duration::from_secs(20), "returned after {:?}", started_at.elapsed());
    h.json("stop_run", json!({"name": "web", "force": true, "timeout": 10000})).await;
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
    ide_host::ops::run::run_stdin(&h.host, process, "yes\n".into()).unwrap();
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
    ide_host::ops::run::run_stop(&h.host, "main", agent_process(&h, "_agent_server")).unwrap();
    let stop = h.json("wait_for_run", json!({"name": "server", "timeout": 10000})).await;
    assert!(stop["interventions"][0]["message"].as_str().unwrap().starts_with("The user stopped this command at"));
    let ended = h.json("wait_for_run", json!({"name": "server", "timeout": 10000})).await;
    assert_eq!(ended["state"], "stoppedByUser", "{ended}");

    let config = started.lock().unwrap().last().cloned().unwrap();
    ide_host::ops::run::run_start(&h.host, "main", config, ide_host::ops::Channel::new(|_| {}), None).await.unwrap();
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
    // Newest first, brief, filtered by state and paged.
    let newest = h.json("list_runs", json!({"limit": 1})).await;
    assert_eq!(
        (&newest["runs"][0]["name"], &newest["total"], &newest["nextOffset"]),
        (&json!("_agent_server"), &json!(2), &json!(1))
    );
    assert!(newest["runs"][0].get("outputLength").is_none(), "{newest}");
    assert_eq!(h.json("list_runs", json!({"state": "idle"})).await["total"], 2);
    assert_eq!(h.json("list_runs", json!({"state": "running"})).await["total"], 0);
    assert_eq!(h.json("list_runs", json!({"state": "stoppedByAgent"})).await["total"], 2);
    assert_eq!(h.json("list_runs", json!({"state": "error"})).await["total"], 0);
    let unknown = h.error("list_runs", json!({"state": "done"})).await;
    assert!(unknown.contains("unknown state `done`"), "{unknown}");
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

#[tokio::test(flavor = "multi_thread")]
async fn http_list_and_run_require_confirmation() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let h = Harness::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 1024];
        let _ = socket.read(&mut buf).await;
        let body = b"{\"ok\":true}";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            std::str::from_utf8(body).unwrap()
        );
        let _ = socket.write_all(response.as_bytes()).await;
    });

    std::fs::write(
        h.root.join("api.http"),
        format!(
            "### Health\nGET http://{addr}/health\nAccept: application/json\n\n### Echo\n# @name echo\nGET http://{addr}/echo\n"
        ),
    )
    .unwrap();
    std::fs::write(h.root.join("http-client.env.json"), r#"{"dev":{"unused":"x"}}"#).unwrap();

    let listed = h.json("http_list_requests", json!({"path": "api.http"})).await;
    assert_eq!(listed["requests"].as_array().unwrap().len(), 2, "{listed}");
    assert_eq!(listed["requests"][0]["index"], 0);
    assert_eq!(listed["requests"][0]["name"], "Health");
    assert_eq!(listed["requests"][0]["method"], "GET");
    assert_eq!(listed["requests"][1]["name"], "echo");
    assert!(listed["requests"][0]["url"].as_str().unwrap().contains("/health"));

    // Write tool is hidden until the project is trusted.
    assert!(Registry::new(h.host.clone()).tools(&h.root).unwrap().iter().all(|t| t.name != "http_run_request"));
    h.trust().await;
    assert!(
        Registry::new(h.host.clone())
            .tools(&h.root)
            .unwrap()
            .iter()
            .any(|t| t.name == "http_run_request" && !t.read_only)
    );

    h.host.mcp_requests.set_ready("main", true);
    let denied = h.error("http_run_request", json!({"path": "api.http", "index": 0, "env": "dev"}));
    let deny = async {
        let id = h.request().await;
        h.host.mcp_requests.answer("main", id, false, None).unwrap();
    };
    let (error, ()) = tokio::join!(denied, deny);
    assert!(error.contains("denied by the user"), "{error}");

    h.events.lock().unwrap().clear();
    let run = h.json("http_run_request", json!({"path": "api.http", "index": 0, "env": "dev"}));
    let allow = async {
        let id = h.request().await;
        h.host.mcp_requests.answer("main", id, true, None).unwrap();
    };
    let (result, ()) = tokio::join!(run, allow);
    assert_eq!(result["status"], 200, "{result}");
    assert_eq!(result["method"], "GET");
    assert!(result["body"].as_str().unwrap().contains("ok"), "{result}");
    assert_eq!(result["bodyTruncated"], false);
    // Secrets must not appear as request headers/body in the tool payload.
    assert!(result.get("headers").is_none(), "{result}");
    assert!(result.get("request").is_none(), "{result}");
}

#[tokio::test(flavor = "multi_thread")]
async fn call_hierarchy_is_listed_for_untrusted_projects() {
    let h = Harness::new();
    let tools = Registry::new(h.host.clone()).tools(&h.root).unwrap();
    assert!(tools.iter().any(|t| t.name == "get_call_hierarchy"));
}

#[tokio::test(flavor = "multi_thread")]
async fn call_hierarchy_without_a_language_server_says_it_is_unsupported() {
    let h = Harness::new();
    let error = h.error("get_call_hierarchy", json!({"filePath":"src/a.txt","line":1,"column":1})).await;
    assert!(error.contains("call hierarchy"), "{error}");
}

#[tokio::test(flavor = "multi_thread")]
async fn call_hierarchy_rejects_an_unknown_direction() {
    let h = Harness::new();
    let args = json!({"filePath":"src/a.txt","line":1,"column":1,"direction":"up"});
    assert_eq!(h.error("get_call_hierarchy", args).await, "direction must be incoming or outgoing");
}

/// `src/lib.rs`: `price` calls `double`; `src/main.rs`: `main` calls `price` and `show`;
/// `other/c.rs`: `helper` calls `price`; a library class calls it too.
const LIB_RS: &str = "pub fn price(cents: u64) -> u64 {\n    double(cents)\n}\nfn double(v: u64) -> u64 { v * 2 }\n";
const MAIN_RS: &str = "fn main() {\n    let a = price(1);\n    show(a);\n}\nfn show(v: u64) {}\n";
const C_RS: &str = "fn helper() {\n    price(2);\n}\n";
const LIBRARY_URI: &str = "jar:file:///lib.jar!/Caller.class";

/// A language server for `rust` that knows the call hierarchy of the files above.
struct CallServer {
    root: PathBuf,
}

impl CallServer {
    fn uri(&self, path: &str) -> String {
        ide_lsp::path_to_uri_string(&self.root.join(path))
    }
    fn item(&self, name: &str) -> Value {
        let r = |l, c, l2, c2| json!({"start":{"line":l,"character":c},"end":{"line":l2,"character":c2}});
        let (uri, range, selection) = match name {
            "price" => (self.uri("src/lib.rs"), r(0, 0, 2, 1), r(0, 7, 0, 12)),
            "double" => (self.uri("src/lib.rs"), r(3, 0, 3, 34), r(3, 3, 3, 9)),
            "main" => (self.uri("src/main.rs"), r(0, 0, 3, 1), r(0, 3, 0, 7)),
            "show" => (self.uri("src/main.rs"), r(4, 0, 4, 18), r(4, 3, 4, 7)),
            "helper" => (self.uri("other/c.rs"), r(0, 0, 2, 1), r(0, 3, 0, 9)),
            _ => (LIBRARY_URI.to_owned(), r(0, 0, 9, 1), r(2, 4, 2, 10)),
        };
        json!({"name":name,"kind":12,"uri":uri,"range":range,"selectionRange":selection})
    }
    fn call(&self, name: &str, key: &str, sites: &[(u32, u32, u32)]) -> Value {
        let sites: Vec<Value> = sites
            .iter()
            .map(|(l, c, c2)| json!({"start":{"line":l,"character":c},"end":{"line":l,"character":c2}}))
            .collect();
        json!({key: self.item(name), "fromRanges": sites})
    }
    /// The item named at `p`: on a declaration's name or on a call.
    fn prepare(&self, p: &Value) -> Value {
        let uri = p["textDocument"]["uri"].as_str().unwrap();
        let (line, col) = (p["position"]["line"].as_u64().unwrap(), p["position"]["character"].as_u64().unwrap());
        let on =
            |path: &str, l: u64, from: u64, to: u64| uri == self.uri(path) && line == l && (from..=to).contains(&col);
        let name = if on("src/lib.rs", 0, 7, 12) || on("src/main.rs", 1, 12, 17) {
            "price"
        } else if on("src/main.rs", 0, 3, 7) {
            "main"
        } else {
            return Value::Null;
        };
        json!([self.item(name)])
    }
}

impl ide_jsonrpc::Handler for CallServer {
    fn on_notification(&self, _: &str, _: Value) {}
    fn on_request(&self, method: &str, p: Value) -> Result<Value, (i64, String)> {
        let item = p["item"]["name"].as_str().unwrap_or_default();
        Ok(match method {
            "initialize" => json!({"capabilities": {
                "textDocumentSync": {"openClose": true, "change": 1},
                "callHierarchyProvider": true,
                "documentSymbolProvider": true,
            }}),
            "textDocument/prepareCallHierarchy" => self.prepare(&p),
            "callHierarchy/incomingCalls" if item == "price" => json!([
                self.call("main", "from", &[(1, 12, 17)]),
                self.call("helper", "from", &[(1, 4, 9)]),
                self.call("Caller", "from", &[(2, 8, 13)]),
            ]),
            "callHierarchy/outgoingCalls" if item == "price" => json!([self.call("double", "to", &[(1, 4, 10)])]),
            "callHierarchy/outgoingCalls" if item == "main" => {
                json!([self.call("show", "to", &[(2, 4, 8)]), self.call("price", "to", &[(1, 12, 17)])])
            }
            "textDocument/documentSymbol" if p["textDocument"]["uri"] == self.uri("src/main.rs") => {
                let symbol = |name| {
                    let item = self.item(name);
                    json!({"name":name,"kind":12,"range":item["range"],"selectionRange":item["selectionRange"]})
                };
                json!([symbol("main"), symbol("show")])
            }
            "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls" | "textDocument/documentSymbol" => json!([]),
            _ => Value::Null,
        })
    }
}

/// The harness with the files above and [`CallServer`] serving them.
async fn call_hierarchy_harness() -> (Harness, tokio::task::JoinHandle<()>) {
    let h = Harness::new();
    h.trust().await;
    for (path, text) in [("src/lib.rs", LIB_RS), ("src/main.rs", MAIN_RS), ("other/c.rs", C_RS)] {
        std::fs::create_dir_all(h.root.join(path).parent().unwrap()).unwrap();
        std::fs::write(h.root.join(path), text).unwrap();
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = Arc::new(CallServer { root: h.root.clone() });
    let accept = tokio::spawn(async move {
        let mut peers = Vec::new();
        while let Ok((stream, _)) = listener.accept().await {
            let (r, w) = stream.into_split();
            peers.push(ide_jsonrpc::Peer::connect(r, w, server.clone()));
        }
    });
    let cfg: ide_language::LanguageServerConfig =
        toml::from_str(&format!("name='calls'\ncommand='no-process-required'\nconnect='127.0.0.1:{port}'")).unwrap();
    h.host.project("main").unwrap().lsp.set_servers_hook(Box::new(move |language, _| {
        if language.as_str() == "rust" { vec![cfg.clone()] } else { Vec::new() }
    }));
    (h, accept)
}

fn names(result: &Value) -> Vec<&str> {
    result["items"].as_array().unwrap().iter().map(|i| i["name"].as_str().unwrap()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn call_hierarchy_lists_callers_with_their_call_sites() {
    let (h, _server) = call_hierarchy_harness().await;
    let callers = h.json("get_call_hierarchy", json!({"filePath":"src/lib.rs","line":1,"column":9})).await;
    assert_eq!(callers["root"]["name"], "price");
    assert_eq!(callers["root"]["filePath"], "src/lib.rs");
    assert_eq!(callers["root"]["lineText"], "pub fn price(cents: u64) -> u64 {");
    assert_eq!(callers["total"], 3);
    let main = callers["items"].as_array().unwrap().iter().find(|i| i["name"] == "main").unwrap();
    assert_eq!(
        main,
        &json!({"name":"main","kind":"function","filePath":"src/main.rs",
                "startLine":1,"startColumn":4,"endLine":1,"endColumn":8,"lineText":"fn main() {",
                "callSites":[{"filePath":"src/main.rs","startLine":2,"startColumn":13,"endLine":2,"endColumn":18,
                              "lineText":"    let a = price(1);"}]})
    );
    // An item's position is a valid input for the next level.
    let main_calls = h
        .json(
            "get_call_hierarchy",
            json!({"filePath":"src/main.rs","line":main["startLine"],"column":main["startColumn"],"direction":"outgoing"}),
        )
        .await;
    assert_eq!(names(&main_calls), ["price", "show"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn outgoing_call_sites_are_in_the_file_of_the_root() {
    let (h, _server) = call_hierarchy_harness().await;
    // On the call `price(1)` in main.rs: the hierarchy of `price`, declared in lib.rs.
    let callees = h
        .json("get_call_hierarchy", json!({"filePath":"src/main.rs","line":2,"column":14,"direction":"outgoing"}))
        .await;
    assert_eq!(callees["root"]["filePath"], "src/lib.rs");
    assert_eq!(names(&callees), ["double"]);
    assert_eq!(
        callees["items"][0]["callSites"],
        json!([{"filePath":"src/lib.rs","startLine":2,"startColumn":5,"endLine":2,"endColumn":11,"lineText":"    double(cents)"}])
    );
    let from_main = h
        .json("get_call_hierarchy", json!({"filePath":"src/main.rs","line":1,"column":4,"direction":"outgoing"}))
        .await;
    let price = &from_main["items"][0];
    assert_eq!((&price["filePath"], &price["callSites"][0]["filePath"]), (&json!("src/lib.rs"), &json!("src/main.rs")));
    assert_eq!(price["callSites"][0]["lineText"], "    let a = price(1);");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_position_in_a_function_body_means_that_function() {
    let (h, _server) = call_hierarchy_harness().await;
    let body = json!({"filePath":"src/main.rs","line":2,"column":5,"direction":"outgoing"});
    let callees = h.json("get_call_hierarchy", body).await;
    assert_eq!(callees["root"]["name"], "main");
    assert_eq!(names(&callees), ["price", "show"]);
    let outside = h.error("get_call_hierarchy", json!({"filePath":"src/main.rs","line":6,"column":1})).await;
    assert_eq!(outside, "no function or method at 6:1");
}

#[tokio::test(flavor = "multi_thread")]
async fn call_hierarchy_pages_are_sorted_and_scoped() {
    let (h, _server) = call_hierarchy_harness().await;
    let at = |extra: Value| {
        let mut args = json!({"filePath":"src/lib.rs","line":1,"column":9});
        args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        args
    };
    let first = h.json("get_call_hierarchy", at(json!({"limit":2}))).await;
    assert_eq!(names(&first), ["Caller", "helper"]);
    assert_eq!(first["items"][0]["filePath"], LIBRARY_URI);
    assert!(first["items"][0].get("lineText").is_none(), "{first}");
    assert_eq!((&first["more"], &first["nextOffset"]), (&json!(true), &json!(2)));
    let next = h.json("get_call_hierarchy", at(json!({"limit":2,"offset":2}))).await;
    assert_eq!(names(&next), ["main"]);
    let scoped = h.json("get_call_hierarchy", at(json!({"paths":["src/"]}))).await;
    assert_eq!(names(&scoped), ["main"]);
    assert_eq!(scoped["total"], 1);
    assert_eq!(scoped["root"]["name"], "price", "the root is shown whatever the paths");
}
