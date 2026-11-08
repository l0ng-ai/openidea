use ide_core::{CancellationToken, ChangeSet, Diagnostic, NullSink, Pos, Range, Severity, TextChange};
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
        let host = Arc::new(Host::new(HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        host.open_project("main", &root).unwrap();
        Self { host, root, tmp }
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
