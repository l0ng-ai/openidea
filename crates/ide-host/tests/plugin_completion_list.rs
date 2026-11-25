//! API 1.16 `completion-list-provider`: a plugin marks its completion incomplete, and typing on
//! in the same word asks that plugin again while the language server's list is kept.
mod common;

use ide_core::{ChangeSet, Pos, RequestId, TextChange};
use ide_host::plugins::{Consent, HostWorkspace, PluginHost, set_editor_providers};
use ide_host::{Host, HostConfig, ops};
use ide_jsonrpc::{Handler, Peer};
use ide_plugin::{Limits, ProviderDocument};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};

fn fixture() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/completion-list")
}

fn plugins(base: &Path) -> Arc<PluginHost> {
    let p = Arc::new(
        PluginHost::new(
            base.join("plugins"),
            Arc::new(|_: Option<&str>, _| {}),
            Limits { edit_soft: Duration::from_secs(3), edit_hard: Duration::from_secs(5), ..Default::default() },
        )
        .unwrap(),
    );
    p.install_from_dir(&fixture(), &Consent::all()).unwrap();
    p
}

#[test]
fn the_export_replaces_providers_completion_and_carries_the_flag() {
    let tmp = tempfile::tempdir().unwrap();
    let p = plugins(tmp.path());
    let doc = |text: &str| ProviderDocument {
        path: tmp.path().join("a.txt"),
        language: "text".into(),
        version: 1,
        text: text.into(),
    };
    // `completion` ("legacy") is not called once `completion-list-provider` is exported.
    let items = p.provide_completion(&doc("Book.findByTitleAnd"), Pos::new(0, 19), None);
    let labels: Vec<_> = items.iter().map(|(_, i)| i.label.as_str()).collect();
    assert_eq!(labels, ["findByTitleAndTitle", "findByTitleAndAuthor"]);
}

/// A language server for plain text that counts its completion requests.
#[derive(Default)]
struct Server {
    completions: Mutex<usize>,
}

impl Handler for Server {
    fn on_notification(&self, _: &str, _: Value) {}
    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Ok(match method {
            "initialize" => {
                json!({"capabilities": {"textDocumentSync": {"openClose": true, "change": 1}, "completionProvider": {}}})
            }
            "textDocument/completion" => {
                *self.completions.lock() += 1;
                json!({"isIncomplete": false, "items": [{"label": "server-item"}]})
            }
            _ => Value::Null,
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn typing_on_asks_only_the_plugins_that_marked_their_list_incomplete() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir(&root).unwrap();
    let host =
        Arc::new(Host::new(HostConfig { local_data_dir: tmp.path().join("local"), ..common::host_config(tmp.path()) }));
    host.open_project("main", &root).unwrap();
    // Language servers start only in trusted projects.
    ops::project::project_trust_set(&host, root.clone(), true, false).await.unwrap();
    let p = plugins(tmp.path());
    p.set_workspace(Some(Arc::new(HostWorkspace(Arc::downgrade(&host)))));
    set_editor_providers(Some(&p));

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = Arc::new(Server::default());
    let peers = Arc::new(Mutex::new(Vec::<Peer>::new()));
    let (accepted, state) = (peers.clone(), server.clone());
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (r, w) = stream.into_split();
            accepted.lock().push(Peer::connect(r, w, state.clone()));
        }
    });
    let cfg: ide_language::LanguageServerConfig =
        toml::from_str(&format!("name='text-server'\ncommand='no-process-required'\nconnect='127.0.0.1:{port}'"))
            .unwrap();
    let project = host.project("main").unwrap();
    project.lsp.set_servers_hook(Box::new(move |_, _| vec![cfg.clone()]));

    let path = root.join("finders.txt");
    std::fs::write(&path, "Book.findByTitleAnd").unwrap();
    let doc = ops::doc::doc_open(&host, "main", path).await.unwrap();
    let labels = |list: &ide_lsp::types::CompletionList| list.items.iter().map(|i| i.label.clone()).collect::<Vec<_>>();

    let first = ops::lsp::lsp_completion(&host, "main", RequestId(1), doc.id, Pos::new(0, 19), None).await.unwrap();
    assert!(first.is_incomplete);
    assert_eq!(labels(&first), ["server-item", "findByTitleAndTitle", "findByTitleAndAuthor"]);
    assert_eq!(*server.completions.lock(), 1);

    // Typing on in the same word: the plugin answers for the new text, the server isn't asked again.
    let insert = |from, text: &str| ChangeSet { changes: vec![TextChange { from, to: from, insert: text.into() }] };
    let version = ops::doc::doc_edit(&host, "main", doc.id, doc.version, insert(19, "A")).await.unwrap();
    let next = ops::lsp::lsp_completion(&host, "main", RequestId(2), doc.id, Pos::new(0, 20), None).await.unwrap();
    assert!(next.is_incomplete);
    assert_eq!(labels(&next), ["server-item", "findByTitleAndATitle", "findByTitleAndAAuthor"]);
    assert_eq!(*server.completions.lock(), 1);

    // Another word starts another completion: everyone is asked.
    ops::doc::doc_edit(&host, "main", doc.id, version, insert(20, " x.y")).await.unwrap();
    let other = ops::lsp::lsp_completion(&host, "main", RequestId(3), doc.id, Pos::new(0, 24), None).await.unwrap();
    assert_eq!(labels(&other), ["server-item", "yTitle", "yAuthor"]);
    assert_eq!(*server.completions.lock(), 2);

    set_editor_providers(None);
}
