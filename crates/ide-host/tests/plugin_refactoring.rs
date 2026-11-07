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
}
