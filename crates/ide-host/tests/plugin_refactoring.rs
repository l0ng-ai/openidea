//! Indexed names use the same preview/apply/undo commands as language-server refactorings.
use ide_core::{IdeEvent, Pos, RequestId, error::ErrorKind};
use ide_host::{
    Host, HostConfig, ops,
    plugins::{Consent, PluginHost, navigation::Snapshot, set_editor_providers},
};
use ide_plugin::{Invocation, Limits};
use parking_lot::Mutex;
use std::{path::Path, sync::Arc};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn indexed_usages_rename_preview_staleness_and_grouped_undo() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let first = root.join("definition.idx");
    let second = root.join("usage.idx");
    let source = "def 😀route\nref 😀route\n";
    let usage = "ref 😀route\nref other\n";
    std::fs::write(&first, source).unwrap();
    std::fs::write(&second, usage).unwrap();
    let events = Arc::new(Mutex::new(vec![]));
    let captured = events.clone();
    let host = Host::new(HostConfig {
        config_dir: root.join("config"),
        data_dir: root.join("data"),
        local_data_dir: root.join("local"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |_| {
            let events = captured.clone();
            Arc::new(move |e| events.lock().push(e))
        }),
        owner: |window| window,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    let project = host.open_light("main", &first).unwrap();
    // Editors retain ordinary Windows paths; index snapshots use canonical
    // (verbatim on Windows) paths and the host's own project-root identity.
    let doc = project.documents.open(dunce::simplified(&first)).unwrap();
    let plugins =
        Arc::new(PluginHost::new(root.join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap());
    plugins.set_project_policy(Arc::new(|_| true));
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/indexer");
    plugins.install_from_dir(&fixture, &Consent::all()).unwrap();
    // Two independently published graphs may contain exactly the same anchors.
    let duplicate = root.join("duplicate");
    std::fs::create_dir_all(duplicate.join("dist")).unwrap();
    std::fs::copy(fixture.join("dist/plugin.wasm"), duplicate.join("dist/plugin.wasm")).unwrap();
    std::fs::write(
        duplicate.join("plugin.toml"),
        std::fs::read_to_string(fixture.join("plugin.toml")).unwrap().replace("test.indexer", "test.duplicate"),
    )
    .unwrap();
    plugins.install_from_dir(&duplicate, &Consent::all()).unwrap();
    set_editor_providers(Some(&plugins));
    struct Clear;
    impl Drop for Clear {
        fn drop(&mut self) {
            set_editor_providers(None);
        }
    }
    let _clear = Clear;
    // LSP-managed library documents do not belong to Documents. Optional
    // index lookup must not replace their native result with a missing-doc error.
    let virtual_doc = ide_core::DocId(1_000_000);
    project.lsp.did_open_virtual(
        virtual_doc,
        "jdt://contents/test/Route.class",
        &ide_core::LanguageId::new("java"),
        0,
        "class Route {}",
    );
    let virtual_result = ops::lsp::lsp_references(
        &host,
        "main",
        RequestId(99),
        virtual_doc,
        Pos::new(0, 6),
        false,
        false,
        false,
        ops::Channel::new(|_| {}),
    )
    .await
    .unwrap_err();
    assert_eq!(virtual_result.kind, ErrorKind::Unavailable, "retain the LSP's native result for virtual documents");
    project.lsp.did_close(virtual_doc);
    let index = || {
        for (path, text, version) in [(&first, source, Some(doc.version)), (&second, usage, None)] {
            plugins
                .index_navigation(
                    &project.root,
                    Snapshot { path, text, version, symbols: &[], scope: "app" },
                    Invocation {
                        client: Some("main".into()),
                        workspace_root: Some(project.root.clone()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
    };
    index();
    for pos in [Pos::new(0, 4), Pos::new(1, 5)] {
        let prepared = ops::lsp::lsp_prepare_rename(&host, "main", doc.id, pos).await.unwrap().unwrap();
        assert_eq!((prepared.start.col, prepared.end.col), (4, 11));
        let partial = Arc::new(Mutex::new(vec![]));
        let captured = partial.clone();
        let refs = ops::lsp::lsp_references(
            &host,
            "main",
            RequestId(1),
            doc.id,
            pos,
            false,
            true,
            false,
            ops::Channel::new(move |r| captured.lock().push(r)),
        )
        .await
        .unwrap();
        assert_eq!(refs.locations.len(), 3, "definitions and references, deduplicated across plugins");
        assert_eq!(partial.lock()[0].locations.len(), 3);
    }
    assert!(
        ops::lsp::lsp_prepare_rename(&host, "main", doc.id, Pos::new(0, 0)).await.is_err(),
        "unowned text falls through to the unavailable LSP"
    );
    let renamed =
        ops::lsp::lsp_rename(&host, "main", RequestId(2), doc.id, Pos::new(0, 4), "new.route".into()).await.unwrap();
    assert!(renamed.preview);
    assert_eq!(renamed.edit.files.len(), 2);
    assert_eq!(renamed.edit.preconditions.len(), 2);
    assert_eq!(std::fs::read_to_string(&first).unwrap(), source, "creating/cancelling preview changes nothing");
    assert_eq!(std::fs::read_to_string(&second).unwrap(), usage);
    let opened_usage = project.documents.open(&second).unwrap();
    let changed_version = project
        .documents
        .edit(
            opened_usage.id,
            opened_usage.version,
            ide_core::ChangeSet { changes: vec![ide_core::TextChange { from: 4, to: 11, insert: "changed".into() }] },
        )
        .unwrap();
    assert_eq!(
        ops::lsp::lsp_rename(&host, "main", RequestId(20), doc.id, Pos::new(0, 4), "new.route".into())
            .await
            .unwrap_err()
            .kind,
        ErrorKind::OutOfSync,
        "a closed-file snapshot cannot hide newer unsaved contents"
    );
    project
        .documents
        .edit(
            opened_usage.id,
            changed_version,
            ide_core::ChangeSet { changes: vec![ide_core::TextChange { from: 4, to: 11, insert: "😀route".into() }] },
        )
        .unwrap();
    project.documents.close(opened_usage.id);
    // A closed file changing during preview rejects the whole operation.
    std::fs::write(&second, "ref changed\n").unwrap();
    assert_eq!(
        ops::lsp::apply_workspace_edit(&host, "main", renamed.edit.clone()).await.unwrap_err().kind,
        ErrorKind::OutOfSync
    );
    assert_eq!(std::fs::read_to_string(&first).unwrap(), source);
    assert_eq!(
        ops::lsp::lsp_rename(&host, "main", RequestId(3), doc.id, Pos::new(0, 4), "new.route".into())
            .await
            .unwrap_err()
            .kind,
        ErrorKind::OutOfSync,
        "stale closed-file anchors cannot be renamed"
    );
    std::fs::write(&second, usage).unwrap();
    let renamed =
        ops::lsp::lsp_rename(&host, "main", RequestId(4), doc.id, Pos::new(1, 4), "new.route".into()).await.unwrap();
    ops::lsp::apply_workspace_edit(&host, "main", renamed.edit).await.unwrap();
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "def new.route\nref new.route\n");
    assert_eq!(std::fs::read_to_string(&second).unwrap(), "ref new.route\nref other\n");
    let id = events
        .lock()
        .iter()
        .find_map(|e| match e {
            IdeEvent::WorkspaceEditApplied { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap();
    ops::lsp::undo_workspace_edit(&host, "main", id).await.unwrap();
    assert_eq!(std::fs::read_to_string(&first).unwrap(), source);
    assert_eq!(std::fs::read_to_string(&second).unwrap(), usage);
    ops::lsp::redo_workspace_edit(&host, "main", id).await.unwrap();
    assert_eq!(std::fs::read_to_string(&second).unwrap(), "ref new.route\nref other\n");
    // A matching native preparation owns the decision, including a null rename.
    std::fs::write(&first, source).unwrap();
    std::fs::write(&second, usage).unwrap();
    project.documents.close(doc.id);
    let doc = project.documents.open(&first).unwrap();
    for (path, text, version) in [(&first, source, Some(doc.version)), (&second, usage, None)] {
        plugins
            .index_navigation(
                &project.root,
                Snapshot { path, text, version, symbols: &[], scope: "app" },
                Invocation {
                    client: Some("main".into()),
                    workspace_root: Some(project.root.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    native_rename_refusal(&host, &project, doc.id, &first, source).await;
    plugins.set_enabled("test.indexer", false).unwrap();
    plugins.set_enabled("test.duplicate", false).unwrap();
    assert!(plugins.indexed_symbol_at(&project.root, &first, Pos::new(0, 4), Some("main")).is_none());
    plugins.set_enabled("test.indexer", true).unwrap();
    project.documents.close(doc.id);
    let invalid = "def 😀\nsymbols \n";
    std::fs::write(&first, invalid).unwrap();
    let doc = project.documents.open(&first).unwrap();
    let half_surrogate = ide_language::SymbolTag {
        name: "broken".into(),
        kind: ide_core::SymbolKind::Method,
        container: None,
        range: ide_core::Range::new(Pos::new(0, 4), Pos::new(0, 5)),
    };
    plugins
        .index_navigation(
            &project.root,
            Snapshot {
                path: &first,
                version: Some(doc.version),
                text: invalid,
                symbols: &[half_surrogate],
                scope: "app",
            },
            Invocation {
                client: Some("main".into()),
                workspace_root: Some(project.root.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        ops::lsp::lsp_prepare_rename(&host, "main", doc.id, Pos::new(0, 4)).await.unwrap_err().kind,
        ErrorKind::InvalidInput,
        "malformed UTF-16 anchors cannot split a character"
    );
    project.documents.close(doc.id);
    host.set_project_trust(&root, true, false).await.unwrap();
    let project = host.open_project("main", &root).unwrap();
    // BOM-less UTF-16 detection requires mostly ASCII pairs, even with emoji anchors.
    let padding = format!("ignored {}\n", "x".repeat(128));
    let encoded_source = format!("{source}{padding}");
    let encoded_usage = format!("{usage}{padding}");
    for (encoding, bom) in
        [("utf-8", true), ("utf-16le", true), ("utf-16be", true), ("utf-16le", false), ("utf-16be", false)]
    {
        ide_vfs::save_text(&first, &encoded_source, encoding, bom).unwrap();
        ide_vfs::save_text(&second, &encoded_usage, encoding, bom).unwrap();
        let original_second = std::fs::read(&second).unwrap();
        let doc = project.documents.open(&first).unwrap();
        assert_eq!(doc.text, encoded_source, "decoded {encoding} BOM={bom}");
        // Index open, close, then validate that decoded text retains the same hash.
        let usage_doc = project.documents.open(&second).unwrap();
        ide_host::plugins::index_ops::plugin_navigation_index(
            &host,
            plugins.clone(),
            "main",
            vec![first.clone(), second.clone()],
            RequestId(100),
        )
        .await
        .unwrap();
        project.documents.close(usage_doc.id);
        assert!(
            plugins.indexed_symbol_at(&project.root, &first, Pos::new(0, 5), Some("main")).is_some(),
            "{encoding} BOM={bom} must publish the open definition"
        );
        let refs = ops::lsp::lsp_references(
            &host,
            "main",
            RequestId(101),
            doc.id,
            Pos::new(0, 5),
            false,
            false,
            false,
            ops::Channel::new(|_| {}),
        )
        .await
        .unwrap();
        assert_eq!(refs.locations.len(), 3, "open-then-closed {encoding} BOM={bom}");
        plugins.invalidate_client_navigation(&project.root, Some("main"), Some(std::slice::from_ref(&second)));
        ide_host::plugins::index_ops::plugin_navigation_index(
            &host,
            plugins.clone(),
            "main",
            vec![second.clone()],
            RequestId(102),
        )
        .await
        .unwrap();
        let renamed =
            ops::lsp::lsp_rename(&host, "main", RequestId(103), doc.id, Pos::new(0, 5), "new😀".into()).await.unwrap();
        assert_eq!(renamed.edit.preconditions.len(), 2);
        assert_eq!(std::fs::read(&second).unwrap(), original_second, "preview preserves bytes");
        ops::lsp::apply_workspace_edit(&host, "main", renamed.edit).await.unwrap();
        assert_eq!(
            std::fs::read(&second).unwrap(),
            ide_vfs::encode(&format!("ref new😀\nref other\n{padding}"), encoding, bom).unwrap(),
            "atomic rename preserves {encoding} BOM={bom}"
        );
        assert_eq!(project.documents.load_file(&first).unwrap().text, format!("def new😀\nref new😀\n{padding}"));
        project.documents.close(doc.id);
    }
}

async fn native_rename_refusal(
    host: &Host,
    project: &ide_host::Project,
    doc: ide_core::DocId,
    path: &Path,
    text: &str,
) {
    use ide_jsonrpc::{Handler, Peer};
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicU8, Ordering};
    struct Native(Arc<AtomicU8>);
    impl Handler for Native {
        fn on_notification(&self, _: &str, _: Value) {}
        fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
            let mode = self.0.load(Ordering::SeqCst);
            Ok(match method {
                "initialize" => {
                    json!({"capabilities": {"textDocumentSync": 1, "renameProvider": {"prepareProvider": true}}})
                }
                "textDocument/prepareRename" if mode < 2 => {
                    json!({"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 11}})
                }
                "textDocument/prepareRename" if mode == 3 => {
                    json!({"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 3}})
                }
                "textDocument/rename" if mode == 1 => json!({"changes": {}}),
                _ => Value::Null,
            })
        }
    }
    let mode = Arc::new(AtomicU8::new(0));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let peers = Arc::new(Mutex::new(Vec::<Peer>::new()));
    let accepted = peers.clone();
    let state = mode.clone();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (reader, writer) = stream.into_split();
            accepted.lock().push(Peer::connect(reader, writer, Arc::new(Native(state.clone()))));
        }
    });
    let config: ide_language::LanguageServerConfig = toml::from_str(&format!(
        "name = 'rename-refusal'\ncommand = 'no-process-required'\nconnect = '127.0.0.1:{port}'"
    ))
    .unwrap();
    project.lsp.set_servers_hook(Box::new(move |_, _| vec![config.clone()]));
    project.lsp.did_open(doc, path, &ide_core::LanguageId::plain_text(), 0, text);
    for value in 0..4 {
        mode.store(value, Ordering::SeqCst);
        let renamed =
            ops::lsp::lsp_rename(host, "main", RequestId(110 + value as u32), doc, Pos::new(0, 5), "new".into()).await;
        if value < 2 {
            assert_eq!(
                renamed.unwrap_err().kind,
                ErrorKind::InvalidInput,
                "matching owner declines via null/empty edit"
            );
        } else {
            let renamed = renamed.unwrap();
            assert!(renamed.preview);
            assert_eq!(renamed.edit.files.len(), 2, "unowned native range keeps indexed fallback");
        }
    }
    project.lsp.did_close(doc);
    project.lsp.shutdown_all().await;
    project.lsp.set_servers_hook(Box::new(|_, _| vec![]));
    task.abort();
    let _ = task.await;
    for peer in peers.lock().drain(..) {
        peer.kill();
    }
}
