//! The API 1.4 fixture exercises every kind through the real component runtime and editor ops.
use ide_core::{CancellationToken, Pos, Range, RequestId};
use ide_host::plugins::{Consent, HostWorkspace, PluginHost, set_editor_providers};
use ide_host::{Host, HostConfig, ops};
use ide_plugin::{Invocation, Limits, ProviderDocument};
use std::{path::Path, sync::Arc, time::Duration};
const ID: &str = "test.language-features";
fn fixture() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/language-features")
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
fn injections_route_only_declared_embedded_providers_and_filter_diagnostics() {
    let tmp = tempfile::tempdir().unwrap();
    let p = plugins(tmp.path());
    let doc = ProviderDocument {
        path: tmp.path().join("a.txt"),
        language: "text".into(),
        version: 9,
        text: "xx[[sql]]zz".into(),
    };
    assert_eq!(p.provide_injections(&doc).len(), 1);
    let items = p.provide_completion(&doc, Pos::new(0, 5), None);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].1.label, "sql:    sql    ");
    assert!(p.provide_completion(&doc, Pos::new(0, 1), None).is_empty());
    assert_eq!(p.provide_hover(&doc, Pos::new(0, 5))[0].markdown, "sql:    sql    ");
    let diagnostics = p.provide_diagnostics(&doc, &CancellationToken::new());
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].1.len(), 1);
    assert_eq!(diagnostics[0].1[0].range, Range::new(Pos::new(0, 4), Pos::new(0, 7)));
    assert!(p.language_signature_help(&ProviderDocument { language: "rust".into(), ..doc }, Pos::default()).is_none());
}
#[test]
fn every_new_kind_requires_api4_at_install() {
    let tmp = tempfile::tempdir().unwrap();
    let p = plugins(tmp.path());
    let package = tmp.path().join("old");
    std::fs::create_dir_all(package.join("dist")).unwrap();
    std::fs::copy(fixture().join("dist/plugin.wasm"), package.join("dist/plugin.wasm")).unwrap();
    let header = "id='old'\nname='Old'\nversion='1.0.0'\nengines.openidea='^1.3'\nwasm='dist/plugin.wasm'\n";
    for kind in [
        "formatting",
        "signature-help",
        "document-highlights",
        "document-links",
        "code-lenses",
        "selection-ranges",
        "folding",
        "colors",
        "document-symbols",
        "implementation",
        "type-definition",
        "gutter-actions",
        "injections",
    ] {
        std::fs::write(
            package.join("plugin.toml"),
            format!("{header}\n[[contributes.providers]]\nkinds=['{kind}']\nlanguages=['text']"),
        )
        .unwrap();
        assert!(p.install_from_dir(&package, &Consent::all()).is_err(), "{kind}");
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn editor_ops_merge_the_fixture_format_selection_and_execute_owned_commands() {
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
    host.open_project("main", &root).unwrap();
    let p = plugins(tmp.path());
    p.set_workspace(Some(Arc::new(HostWorkspace(Arc::downgrade(&host)))));
    set_editor_providers(Some(&p));
    let generation = host.project("main").unwrap().lsp.injection_generation();
    drop(plugins(&tmp.path().join("unrelated")));
    assert_eq!(host.project("main").unwrap().lsp.injection_generation(), generation);
    let path = root.join("a.txt");
    std::fs::write(&path, "value\nnext\nend").unwrap();
    let doc = ops::doc::open(&host, "main", path.clone()).await.unwrap();
    assert_eq!(
        ops::lsp::lsp_signature_help(&host, "main", doc.id, Pos::default()).await.unwrap().unwrap().signatures[0]
            .parameters,
        vec![(6, 11)]
    );
    assert_eq!(ops::lsp::lsp_document_highlights(&host, "main", doc.id, Pos::default()).await.unwrap().len(), 1);
    let links = ops::lsp::lsp_document_links(&host, "main", doc.id).await.unwrap();
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].path.as_ref().unwrap().0, root.join("next.txt"));
    let lenses = ops::lsp::lsp_code_lens(&host, "main", doc.id).await.unwrap();
    assert_eq!(lenses.len(), 1, "undeclared command was dropped");
    ops::lsp::lsp_execute_command(&host, "main", doc.id, lenses[0].command.clone().unwrap()).await.unwrap();
    assert_eq!(p.run_command(ID, "state", None, Invocation::default()).unwrap().as_deref(), Some("lens"));
    let outline = ops::doc::doc_outline(&host, "main", doc.id).await.unwrap();
    assert_eq!(outline[0].name, "Outer");
    assert_eq!(outline[0].children[0].name, "Inner");
    assert_eq!(ops::doc::doc_folding(&host, "main", doc.id).await.unwrap()[0].end_line, 2);
    assert_eq!(ops::doc::doc_selection_ranges(&host, "main", doc.id, 0).await.unwrap().len(), 2);
    for kind in [ide_lsp::types::GotoKind::Implementation, ide_lsp::types::GotoKind::TypeDefinition] {
        assert_eq!(ops::lsp::lsp_goto(&host, "main", doc.id, Pos::default(), kind).await.unwrap().len(), 1);
    }
    assert_eq!(
        ops::lsp::lsp_goto_implementation(
            &host,
            "main",
            RequestId(1),
            doc.id,
            Pos::default(),
            ide_host::ops::Channel::new(|_| {})
        )
        .await
        .unwrap()
        .len(),
        1
    );
    let visuals = ops::lsp::plugin_language_visuals(&host, "main", doc.id).await.unwrap();
    assert_eq!(visuals.colors.len(), 1);
    assert_eq!(visuals.gutter_actions.len(), 1);
    assert_eq!(
        ops::lsp::plugin_color_presentations(&host, "main", doc.id, ID.into(), visuals.colors[0].1.clone())
            .await
            .unwrap(),
        ["red-plaintext", "#ff0000"]
    );
    let project = host.project("main").unwrap();
    project
        .settings
        .set(
            ide_workspace::settings::SettingsScope::Project,
            "languages.pluginFormatters",
            serde_json::json!({doc.language.as_str():ID}),
        )
        .unwrap();
    let options = ide_lsp::types::FormatOptions { tab_size: 2, insert_spaces: true, on_save: false, tool: None };
    let formatted =
        ops::lsp::lsp_format(&host, "main", doc.id, Some(Range::new(Pos::default(), Pos::new(0, 5))), options)
            .await
            .unwrap();
    assert_eq!(formatted[0].new_text, "formatted");
    // The same editor ops are exposed by the server dispatcher, with no desktop provider call.
    let dispatcher = ide_host::rpc::Dispatcher::standard();
    assert!(dispatcher.commands().contains(&"plugin_language_visuals"));

    let base = tmp.path().join("server");
    let peer_slot = Arc::new(std::sync::OnceLock::new());
    let remote = ide_host::plugins::remote_host::RemotePlugins::start(&base, &host, peer_slot.clone()).unwrap();
    let mut dispatcher = ide_host::rpc::Dispatcher::standard();
    remote.register(&mut dispatcher);
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(ide_host::rpc::serve(host.clone(), dispatcher, peer_slot, sr, sw));
    struct Client;
    impl ide_jsonrpc::Handler for Client {
        fn on_notification(&self, _: &str, _: serde_json::Value) {}
        fn on_request(&self, method: &str, _: serde_json::Value) -> Result<serde_json::Value, (i64, String)> {
            Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
        }
    }
    let (cr, cw) = tokio::io::split(client_io);
    let peer = ide_jsonrpc::Peer::connect(cr, cw, Arc::new(Client));
    let _: serde_json::Value =
        peer.request("initialize", serde_json::json!({"version":ide_host::rpc::PROTOCOL_VERSION}), None).await.unwrap();
    async fn invoke(peer: &ide_jsonrpc::Peer, cmd: &str, args: serde_json::Value) -> serde_json::Value {
        peer.request(
            "invoke",
            serde_json::to_value(ide_host::rpc::Invoke { window: "main".into(), cmd: cmd.into(), args }).unwrap(),
            None,
        )
        .await
        .unwrap()
    }
    invoke(&peer, "project_trust_set", serde_json::json!({"path":root,"trusted":true,"folder":false})).await;
    let files = serde_json::json!({ID:p.remote_package_files(ID).unwrap()});
    let synced = invoke(
        &peer,
        ide_host::plugins::remote_host::SYNC_PACKAGES,
        serde_json::json!({"packages":p.remote_packages(),"files":files}),
    )
    .await;
    assert_eq!(synced["failed"], serde_json::json!([]), "{synced}");
    let listed = invoke(&peer, "plugin_formatters", serde_json::json!({})).await;
    assert_eq!(listed[0]["id"], ID);
    let visual = invoke(&peer, "plugin_language_visuals", serde_json::json!({"doc":doc.id})).await;
    assert_eq!(visual["gutterActions"].as_array().unwrap().len(), 1);
    set_editor_providers(Some(&p));
    injected_lsp(&host, &p, &root, &peer).await;
    p.set_enabled(ID, false).unwrap();
    assert!(ops::lsp::plugin_formatters().is_empty());
    set_editor_providers(None);
}

#[test]
fn formatting_uses_the_command_budget_while_editor_calls_can_expire() {
    let tmp = tempfile::tempdir().unwrap();
    let p = PluginHost::new(
        tmp.path().join("plugins"),
        Arc::new(|_: Option<&str>, _| {}),
        Limits { edit_soft: Duration::ZERO, ..Default::default() },
    )
    .unwrap();
    p.install_from_dir(&fixture(), &Consent::all()).unwrap();
    let doc =
        ProviderDocument { path: tmp.path().join("a.txt"), language: "text".into(), version: 1, text: "value".into() };
    assert_eq!(
        p.language_format(
            ID,
            &doc,
            None,
            ide_plugin::language_features::FormatOptions { tab_size: 4, insert_spaces: true }
        )
        .unwrap()[0]
            .new_text,
        "formatted"
    );
    assert!(p.language_signature_help(&doc, Pos::default()).is_none());
    assert!(p.info_of(ID).unwrap().stats.slow_calls > 0);
}

// Same TCP fake-server pattern as plugin_refactoring; the real Wasm export supplies the range.
async fn injected_lsp(host: &Host, plugins: &PluginHost, root: &Path, remote: &ide_jsonrpc::Peer) {
    use ide_jsonrpc::{Handler, Peer};
    use parking_lot::Mutex;
    use serde_json::{Value, json};
    #[derive(Default)]
    struct Fake {
        docs: Mutex<std::collections::HashMap<String, String>>,
        requests: Mutex<Vec<(String, Value)>>,
    }
    impl Handler for Fake {
        fn on_notification(&self, method: &str, p: Value) {
            let uri = p["textDocument"]["uri"].as_str().unwrap_or_default().to_owned();
            match method {
                "textDocument/didOpen" => {
                    self.docs.lock().insert(uri, p["textDocument"]["text"].as_str().unwrap().into());
                }
                "textDocument/didChange" => {
                    self.docs.lock().insert(uri, p["contentChanges"][0]["text"].as_str().unwrap().into());
                }
                "textDocument/didClose" => {
                    self.docs.lock().remove(&uri);
                }
                _ => {}
            }
        }
        fn on_request(&self, method: &str, p: Value) -> Result<Value, (i64, String)> {
            self.requests.lock().push((method.to_owned(), p.clone()));
            Ok(match method {
                "initialize" => {
                    json!({"capabilities": {"textDocumentSync": {"openClose":true,"change":1}, "completionProvider":{"resolveProvider":true}, "hoverProvider":true, "definitionProvider":true}})
                }
                "textDocument/completion" => json!([{"label":"embedded-server", "data":{"identity":7}}]),
                "completionItem/resolve" => {
                    assert_eq!(p["data"], json!({"identity":7}));
                    json!({"label":"embedded-server", "detail":"resolved"})
                }
                "textDocument/hover" => {
                    json!({"contents":"embedded hover", "range":{"start":{"line":0,"character":0},"end":{"line":0,"character":99}}})
                }
                "textDocument/definition" => {
                    json!({"uri":p["textDocument"]["uri"], "range":{"start":{"line":0,"character":0},"end":{"line":0,"character":99}}})
                }
                _ => Value::Null,
            })
        }
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fake = Arc::new(Fake::default());
    let peers = Arc::new(Mutex::new(Vec::<Peer>::new()));
    let (accepted, state) = (peers.clone(), fake.clone());
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (r, w) = stream.into_split();
            accepted.lock().push(Peer::connect(r, w, state.clone()));
        }
    });
    let cfg: ide_language::LanguageServerConfig =
        toml::from_str(&format!("name='injected-sql'\ncommand='no-process-required'\nconnect='127.0.0.1:{port}'"))
            .unwrap();
    let project = host.project("main").unwrap();
    project.lsp.set_servers_hook(Box::new(
        move |language, _| if language.as_str() == "sql" { vec![cfg.clone()] } else { Vec::new() },
    ));
    let path = root.join("injection.txt");
    std::fs::write(&path, "😀[[sql]] tail").unwrap();
    let doc = ops::doc::open(host, "main", path.clone()).await.unwrap();
    let items = ops::lsp::lsp_completion(host, "main", RequestId(91), doc.id, Pos::new(0, 5), None).await.unwrap();
    let item = items.items.into_iter().find(|i| i.label == "embedded-server").unwrap();
    assert_eq!(
        ops::lsp::lsp_resolve_completion(host, "main", doc.id, item).await.unwrap().detail.as_deref(),
        Some("resolved")
    );
    let opened = fake.docs.lock().clone();
    assert_eq!(opened.len(), 1);
    assert_eq!(opened.values().next().unwrap(), "    sql       ");
    let virtual_uri = opened.keys().next().unwrap().clone();
    assert!(!ide_lsp::uri_to_path(&virtual_uri).unwrap().exists());
    let before = fake.requests.lock().iter().filter(|(m, _)| m == "textDocument/completion").count();
    ops::lsp::lsp_completion(host, "main", RequestId(92), doc.id, Pos::new(0, 2), None).await.unwrap();
    assert_eq!(fake.requests.lock().iter().filter(|(m, _)| m == "textDocument/completion").count(), before);
    let defs = ops::lsp::lsp_goto(host, "main", doc.id, Pos::new(0, 5), ide_lsp::types::GotoKind::Declaration).await;
    // Declaration isn't advertised; definition exercises mapping without a plugin definition provider.
    assert!(defs.is_err());
    let defs =
        ops::lsp::lsp_goto(host, "main", doc.id, Pos::new(0, 5), ide_lsp::types::GotoKind::Definition).await.unwrap();
    assert_eq!(defs[0].path.0, path);
    assert_eq!(defs[0].range, Range::new(Pos::new(0, 4), Pos::new(0, 7)));
    let hover: Value = remote
        .request(
            "invoke",
            json!({"window":"main","cmd":"lsp_hover","args":{"request":93,"doc":doc.id,"pos":{"line":0,"col":5}}}),
            None,
        )
        .await
        .unwrap();
    assert!(hover.to_string().contains("embedded hover"), "{hover}");
    ops::doc::edit(
        host,
        "main",
        doc.id,
        doc.version,
        ide_core::ChangeSet { changes: vec![ide_core::TextChange { from: 4, to: 7, insert: "SQL".into() }] },
    )
    .unwrap();
    ops::lsp::lsp_completion(host, "main", RequestId(94), doc.id, Pos::new(0, 5), None).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while fake.docs.lock().get(&virtual_uri).is_none_or(|s| s != "    SQL       ") {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    plugins.set_enabled(ID, false).unwrap();
    while !fake.docs.lock().is_empty() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.lsp.injected_document(doc.id, Pos::new(0, 5)), doc.id);
    ops::doc::close(host, "main", doc.id).unwrap();
    project.lsp.shutdown_all().await;
    project.lsp.set_servers_hook(Box::new(|_, _| Vec::new()));
    task.abort();
    let _ = task.await;
    for peer in peers.lock().drain(..) {
        peer.kill();
    }
}
