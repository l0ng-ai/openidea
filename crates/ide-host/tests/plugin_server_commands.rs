//! `[[contributes.serverCommands]]` (plugin API 1.9): a command a language server hands to the
//! client runs the plugin command that claims it. The fixture's command sends its argument
//! back to the server (`mock/ran`), through the real component runtime and `language-servers`.
use ide_host::plugins::{Consent, HostWorkspace, PluginHost, set_editor_providers};
use ide_host::{Host, HostConfig, ops};
use ide_jsonrpc::{Handler, Peer};
use ide_lsp::types::Command;
use ide_plugin::Limits;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};

const ID: &str = "test.lsp-requests";
const SECOND: &str = "test.lsp-second";

fn fixture() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/lsp-requests")
}

/// The fixture under `dir` with `edit` applied to its manifest.
fn variant(dir: &Path, edit: impl Fn(&str) -> String) -> std::path::PathBuf {
    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            match entry.file_type().unwrap().is_dir() {
                true if entry.file_name() != "target" => copy(&entry.path(), &to.join(entry.file_name())),
                true => {}
                false => drop(std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap()),
            }
        }
    }
    copy(&fixture(), dir);
    let manifest = dir.join("plugin.toml");
    std::fs::write(&manifest, edit(&std::fs::read_to_string(&manifest).unwrap())).unwrap();
    dir.to_path_buf()
}

/// A language server named `mock`: it executes `mock.own` itself and records what it gets.
#[derive(Default)]
struct Mock {
    requests: Mutex<Vec<(String, Value)>>,
    notifications: Mutex<Vec<(String, Value)>>,
}

impl Mock {
    fn ran(&self) -> Vec<Value> {
        self.notifications.lock().iter().filter(|(m, _)| m == "mock/ran").map(|(_, p)| p.clone()).collect()
    }
    fn executed(&self) -> Vec<Value> {
        let requests = self.requests.lock();
        requests.iter().filter(|(m, _)| m == "workspace/executeCommand").map(|(_, p)| p["command"].clone()).collect()
    }
}

impl Handler for Mock {
    fn on_notification(&self, method: &str, p: Value) {
        self.notifications.lock().push((method.to_owned(), p));
    }
    fn on_request(&self, method: &str, p: Value) -> Result<Value, (i64, String)> {
        self.requests.lock().push((method.to_owned(), p));
        Ok(match method {
            "initialize" => json!({ "capabilities": {
                "textDocumentSync": { "openClose": true, "change": 1 },
                "executeCommandProvider": { "commands": ["mock.own"] },
            } }),
            _ => Value::Null,
        })
    }
}

async fn eventually(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..500 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

fn command(name: &str, arguments: Vec<Value>) -> Command {
    Command { title: "Lens".into(), command: name.into(), arguments }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_the_server_leaves_to_the_client_runs_the_plugin_that_claims_it() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir(&root).unwrap();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: tmp.path().join("config"),
        data_dir: tmp.path().join("data"),
        local_data_dir: tmp.path().join("local"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    // Language servers start only in a trusted project.
    host.set_project_trust(&root, true, false).await.unwrap();
    host.open_project("main", &root).unwrap();
    let plugins = Arc::new(
        PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap(),
    );
    plugins.set_workspace(Some(Arc::new(HostWorkspace(Arc::downgrade(&host)))));
    set_editor_providers(Some(&plugins));

    // The manifest must hold the grant of the server whose commands it claims.
    let ungranted = variant(&tmp.path().join("ungranted"), |m| m.replace("optional = [\"lsp:mock\"]", "optional = []"));
    let err = plugins.install_from_dir(&ungranted, &Consent::all()).unwrap_err();
    assert!(err.message.contains("needs the `lsp:mock` capability"), "{err:?}");
    plugins.install_from_dir(&fixture(), &Consent::all()).unwrap();

    // The server `mock` serves the project's text files.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mock = Arc::new(Mock::default());
    let peers = Arc::new(Mutex::new(Vec::<Peer>::new()));
    let (accepted, state) = (peers.clone(), mock.clone());
    let server = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (r, w) = stream.into_split();
            accepted.lock().push(Peer::connect(r, w, state.clone()));
        }
    });
    let cfg: ide_language::LanguageServerConfig =
        toml::from_str(&format!("name='mock'\ncommand='no-process-required'\nconnect='127.0.0.1:{port}'")).unwrap();
    let project = host.project("main").unwrap();
    project.lsp.set_servers_hook(Box::new(move |_, _| vec![cfg.clone()]));
    let path = root.join("a.txt");
    std::fs::write(&path, "class Post {}\n").unwrap();
    let doc = ops::doc::doc_open(&host, "main", path.clone()).await.unwrap().id;
    project.lsp.did_open(
        doc,
        &path,
        &ide_core::LanguageId::plain_text(),
        0,
        "class Post {}
",
    );
    eventually("the server to be ready", || {
        project.lsp.servers().iter().any(|s| s.name == "mock" && s.status == ide_core::event::ServerStatus::Ready)
    })
    .await;

    // A lens command the server does not execute: the plugin's command gets the arguments as JSON.
    let lens = command("mock.modelView", vec![json!("App\\Models\\Post"), json!({ "line": 3 })]);
    ops::lsp::lsp_execute_command(&host, "main", doc, lens.clone()).await.unwrap();
    eventually("the plugin's command", || !mock.ran().is_empty()).await;
    assert_eq!(mock.ran(), [json!(["App\\Models\\Post", { "line": 3 }])]);
    assert!(mock.executed().is_empty(), "the server was not asked to execute it");

    // A command in the server's `executeCommandProvider` still goes to the server.
    ops::lsp::lsp_execute_command(&host, "main", doc, command("mock.own", vec![])).await.unwrap();
    assert_eq!(mock.executed(), [json!("mock.own")]);
    assert_eq!(mock.ran().len(), 1);

    // A command nobody claims fails as before.
    let err = ops::lsp::lsp_execute_command(&host, "main", doc, command("mock.unclaimed", vec![])).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable, "{err:?}");

    // Two plugins claim the same server and command: the first one loaded keeps it.
    let second = variant(&tmp.path().join("second"), |m| m.replace(ID, SECOND));
    plugins.install_from_dir(&second, &Consent::all()).unwrap();
    ops::lsp::lsp_execute_command(&host, "main", doc, lens.clone()).await.unwrap();
    eventually("the first plugin's command again", || mock.ran().len() == 2).await;
    assert_eq!(plugins.info_of(SECOND).unwrap().stats.activations, 0, "the second plugin never ran");

    // A claim counts only while the plugin holds the server's grant.
    plugins.set_capability(ID, "lsp:mock", false).unwrap();
    ops::lsp::lsp_execute_command(&host, "main", doc, lens.clone()).await.unwrap();
    eventually("the second plugin's command", || mock.ran().len() == 3).await;
    assert_eq!(plugins.info_of(SECOND).unwrap().stats.activations, 1);
    plugins.set_capability(SECOND, "lsp:mock", false).unwrap();
    let err = ops::lsp::lsp_execute_command(&host, "main", doc, lens).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable, "{err:?}");
    assert_eq!(mock.ran().len(), 3);

    set_editor_providers(None);
    server.abort();
}
