//! Database and MCP calls through a real sandboxed API 1.4 component.
use ide_core::{CancellationToken, IdeEvent, event::McpUiRequest};
use ide_host::{
    Host, HostConfig,
    mcp::Registry,
    ops,
    plugins::{Consent, HostWorkspace, PluginEvent, PluginHost, WindowRequest},
};
use ide_mcp::{ToolCallError, ToolRegistry};
use ide_plugin::{Invocation, Limits};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
const ID: &str = "test.data-tools";
fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/data-tools")
}
struct Harness {
    host: Arc<Host>,
    plugins: Arc<PluginHost>,
    root: PathBuf,
    events: Arc<Mutex<Vec<(String, IdeEvent)>>>,
    requests: Arc<Mutex<Vec<(String, PluginEvent)>>>,
    _tmp: tempfile::TempDir,
}
impl Harness {
    fn new() -> Self {
        ide_ssh::secrets::testing::use_memory_store();
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
        std::fs::create_dir(&root).unwrap();
        let events = Arc::new(Mutex::new(vec![]));
        let out = events.clone();
        let host = Arc::new(Host::new(HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(move |w| {
                let (w, out) = (w.to_owned(), out.clone());
                Arc::new(move |e| out.lock().unwrap().push((w.clone(), e)))
            }),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        std::fs::write(root.join("db.sqlite"), "").unwrap();
        host.open_project("main", &root).unwrap();
        host.open_project("second", &root).unwrap();
        let requests = Arc::new(Mutex::new(vec![]));
        let out = requests.clone();
        let plugins = Arc::new(
            PluginHost::new(
                tmp.path().join("plugins"),
                Arc::new(move |w: Option<&str>, e| out.lock().unwrap().push((w.unwrap_or_default().to_owned(), e))),
                Limits { timeout: Duration::from_millis(250), ..Default::default() },
            )
            .unwrap(),
        );
        plugins.set_workspace(Some(Arc::new(HostWorkspace(Arc::downgrade(&host)))));
        host.set_plugin_host(&plugins);
        plugins.install_from_dir(&fixture(), &Consent::all()).unwrap();
        Self { host, plugins, root, events, requests, _tmp: tmp }
    }
    fn invocation(&self) -> Invocation {
        Invocation { client: Some("main".into()), workspace_root: Some(self.root.clone()), ..Default::default() }
    }
    fn run(&self, id: &str, arg: Option<&str>) -> ide_core::IdeResult<Option<String>> {
        self.plugins.run_command(ID, id, arg, self.invocation())
    }
    fn source(&self) -> String {
        serde_json::json!({"id":"local","name":"Example","driver":"sqlite","database":self.root.join("db.sqlite").to_string_lossy(),"options":[]}).to_string()
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn database_calls_enforce_grants_trust_ownership_and_uninstall_lifetime() {
    let f = Harness::new();
    assert!(f.run("sources", None).is_err());
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    let source = f.source();
    f.run("upsert", Some(&source)).unwrap();
    assert_eq!(f.run("sources", None).unwrap().as_deref(), Some("[\"local\"]"));
    f.run("credential", Some("never-on-disk")).unwrap();
    let source = f.host.project("main").unwrap().db.plugin_source(ID, "local").unwrap();
    let store = ide_db::secrets::SecretStore::new(f._tmp.path().join("data/db-passwords.json"), &f.root);
    assert_eq!(store.get(&source.id).as_deref(), Some("never-on-disk"));
    let file = f.root.join(".openidea/data-sources.toml");
    assert!(!std::fs::read_to_string(&file).unwrap().contains("never-on-disk"));
    for command in ["remove", "connect"] {
        assert!(f.run(command, Some("foreign")).is_err());
    }
    assert!(f.events.lock().unwrap().iter().any(|(w, e)| w == "second" && matches!(e, IdeEvent::DbSourcesChanged)));
    f.plugins.set_enabled(ID, false).unwrap();
    assert!(file.exists());
    f.plugins.set_enabled(ID, true).unwrap();
    assert!(f.host.project("main").unwrap().db.plugin_source(ID, "local").is_ok());
    f.host.set_mcp_executable(Some(PathBuf::from("/app/openidea")));
    let command: serde_json::Value = serde_json::from_str(&f.run("stdio", None).unwrap().unwrap()).unwrap();
    assert_eq!(command[1], "--mcp-stdio");
    f.host.set_mcp_executable(None);
    assert_eq!(f.run("stdio", None).unwrap().as_deref(), Some("null"));
    // Closed project cleanup uses the host-owned journal, not only current windows.
    f.host.close_project("main");
    f.host.close_project("second");
    f.plugins.uninstall(ID).unwrap();
    assert!(ide_db::source::load(&f.root).unwrap().is_empty());
    assert!(store.get(&source.id).is_none());
}
#[tokio::test(flavor = "multi_thread")]
async fn database_connect_asks_only_the_invoking_window_and_uses_normal_connection_flow() {
    let f = Harness::new();
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    f.run("upsert", Some(&f.source())).unwrap();
    let (plugins, invocation) = (f.plugins.clone(), f.invocation());
    let run = tokio::task::spawn_blocking(move || plugins.run_command(ID, "connect", None, invocation));
    let (window, request, source) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let found = f.requests.lock().unwrap().iter().find_map(|(w, e)| match e {
                PluginEvent::WindowRequest { request_id, request: WindowRequest::DatabaseConnect { id }, .. } => {
                    Some((w.clone(), request_id.clone(), id.clone()))
                }
                _ => None,
            });
            if let Some(v) = found {
                break v;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(window, "main");
    assert!(!f.plugins.answer_command("second", &request, ide_host::plugins::CommandAnswer::Value(None)));
    tokio::time::sleep(Duration::from_millis(350)).await; // Password entry can outlive the 250 ms command budget.
    ops::db::connect(&f.host, "main", &source).await.unwrap();
    f.plugins.answer_command("main", &request, ide_host::plugins::CommandAnswer::Value(None));
    run.await.unwrap().unwrap();
    assert!(!f.host.project("main").unwrap().db.connected().is_empty());
}
#[tokio::test(flavor = "multi_thread")]
async fn mcp_listing_dispatch_confirmation_and_lifecycle_use_plugin_authority() {
    let f = Harness::new();
    let registry = Arc::new(Registry::new(f.host.clone()));
    assert!(!registry.tools(&f.root).unwrap().iter().any(|t| t.name == "test_data_tools__write"));
    assert!(registry.call(&f.root, "test_data_tools__write", "{}", CancellationToken::new()).is_err());
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    let tools = registry.tools(&f.root).unwrap();
    let name = "test_data_tools__echo";
    assert!(tools.iter().any(|t| t.name == name && t.description.contains(ID)));
    assert!(matches!(
        registry.call(&f.root, name, r#"{"text":12}"#, CancellationToken::new()),
        Err(ToolCallError::Failed(_))
    ));
    let result = registry.call(&f.root, name, r#"{"text":"hello"}"#, CancellationToken::new()).unwrap();
    assert!(result.contains("hello"));
    let denied = registry.call(&f.root, "test_data_tools__denied", "{}", CancellationToken::new()).unwrap_err();
    assert!(format!("{denied:?}").contains("process:sh"));
    f.host.mcp_requests.set_ready("main", true);
    let (r, root) = (registry.clone(), f.root.clone());
    let call =
        tokio::task::spawn_blocking(move || r.call(&root, "test_data_tools__erase", "{}", CancellationToken::new()));
    let request = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(id) = f.events.lock().unwrap().iter().find_map(|(_, e)| match e {
                IdeEvent::McpRequest { id, request: McpUiRequest::Confirm { .. } } => Some(*id),
                _ => None,
            }) {
                break id;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(f.host.mcp_requests.answer("second", request, true, None).is_err());
    f.host.mcp_requests.answer("main", request, false, None).unwrap();
    assert!(call.await.unwrap().is_err());
    f.plugins.set_enabled(ID, false).unwrap();
    assert!(!registry.tools(&f.root).unwrap().iter().any(|t| t.name == name));
    assert!(registry.call(&f.root, name, "{}", CancellationToken::new()).is_err());
    f.plugins.set_enabled(ID, true).unwrap();
    assert!(registry.tools(&f.root).unwrap().iter().any(|t| t.name == name));
    let (r, root) = (registry.clone(), f.root.clone());
    let spin =
        tokio::task::spawn_blocking(move || r.call(&root, "test_data_tools__spin", "{}", CancellationToken::new()));
    assert!(spin.await.unwrap().is_err(), "command budget interrupts wasm");
}

#[tokio::test(flavor = "multi_thread")]
async fn database_imports_are_denied_without_the_optional_grant() {
    let f = Harness::new();
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    f.plugins.set_capability(ID, "database.sources", false).unwrap();
    for command in ["upsert", "remove", "sources", "credential", "connect"] {
        let err = f.run(command, Some(&f.source())).unwrap_err();
        assert!(err.message.contains("database.sources"), "{command}: {err}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn official_api_examples_install_and_render_real_component_contributions() {
    let f = Harness::new();
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    let official = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/official");
    for name in ["blame-annotations", "todo-finder"] {
        f.plugins.install_from_dir(&official.join(name), &Consent::all()).unwrap();
    }
    std::fs::write(f.root.join("notes.txt"), "TODO example\n").unwrap();
    let doc = ide_plugin::ProviderDocument {
        path: f.root.join("notes.txt"),
        language: "text".into(),
        version: 1,
        text: "TODO example\n".into(),
    };
    assert!(eventually(|| {
        f.plugins
            .language_code_lenses(&doc)
            .iter()
            .any(|(owner, lens)| owner == "openidea.blame-annotations" && lens.command == "annotate")
    }));
    f.plugins.run_command("openidea.todo-finder", "find", None, f.invocation()).unwrap();
    let view = f.plugins.render_view("openidea.todo-finder", "todos", None, f.invocation()).unwrap();
    let ide_plugin::ViewBody::List(items) = view.body else { panic!("expected TODO list") };
    assert_eq!(items.len(), 1);
    assert!(items[0].label.contains("TODO example"));
    #[cfg(unix)]
    {
        let path = std::env::join_paths([official.join("container-runner"), official.join("test-runner")]).unwrap();
        f.plugins.set_program_path(Arc::new(move || Some(path.clone())));
        for name in ["container-runner", "test-runner"] {
            f.plugins.install_from_dir(&official.join(name), &Consent::all()).unwrap();
        }
        std::fs::write(f.root.join("example.tests"), "test adds\n").unwrap();
        let doc =
            ide_plugin::ProviderDocument { path: f.root.join("example.tests"), text: "test adds\n".into(), ..doc };
        assert!(eventually(|| {
            f.plugins
                .language_gutter_actions(&doc)
                .iter()
                .any(|(owner, action)| owner == "openidea.test-runner" && action.argument.as_deref() == Some("adds"))
        }));
        f.plugins.refresh_run_configurations(&f.root);
        let configs = f.plugins.run_detection().detect(&f.root);
        assert!(configs.iter().any(|c| c.id == "plugin:openidea.test-runner:tests"));
    }
}

/// Editor-path calls drop a result that misses their budget, as the first call into a cold
/// component can on a slow machine: ask again until it arrives.
fn eventually(mut ready: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        if ready() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}
