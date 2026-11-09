use ide_core::{IdeEvent, SharedSink, WorkspaceEdit, error::ErrorKind};
use ide_host::{Host, HostConfig, ops};
use parking_lot::Mutex;
use serde_json::json;
use std::sync::Arc;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preview_apply_and_grouped_undo_use_the_shared_host_commands() {
    let tmp = tempfile::tempdir().unwrap();
    let first = tmp.path().join("first.txt");
    let second = tmp.path().join("second.txt");
    for path in [&first, &second] {
        std::fs::write(path, "old\n").unwrap();
    }
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink: SharedSink = {
        let events = events.clone();
        Arc::new(move |event| events.lock().push(event))
    };
    let host = Host::new(HostConfig {
        config_dir: tmp.path().join("config"),
        data_dir: tmp.path().join("data"),
        local_data_dir: tmp.path().join("local-data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |_| sink.clone()),
        owner: |window| window,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.open_light("main", &first).unwrap();
    let info = ops::doc::open(&host, "main", first.clone()).await.unwrap();
    let edit: WorkspaceEdit = serde_json::from_value(json!({ "files": [
        { "kind": "edit", "path": first, "version": info.version, "edits": [{ "range": { "start": { "line": 0, "col": 0 }, "end": { "line": 0, "col": 3 } }, "new_text": "new" }] },
        { "kind": "edit", "path": second, "edits": [{ "range": { "start": { "line": 0, "col": 0 }, "end": { "line": 0, "col": 3 } }, "new_text": "new" }] }
    ] })).unwrap();
    let preview = ops::lsp::prepare_workspace_edit(&host, "main", edit.clone()).await.unwrap();
    assert_eq!(preview.preconditions.len(), 2);
    std::fs::write(&second, "own\n").unwrap();
    let error = ops::lsp::apply_workspace_edit(&host, "main", preview).await.unwrap_err();
    assert_eq!(error.kind, ErrorKind::OutOfSync);
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "old\n");

    let preview = ops::lsp::prepare_workspace_edit(&host, "main", edit).await.unwrap();
    ops::lsp::apply_workspace_edit(&host, "main", preview).await.unwrap();
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "new\n");
    assert_eq!(std::fs::read_to_string(&second).unwrap(), "new\n");
    let id = events
        .lock()
        .iter()
        .find_map(|event| match event {
            IdeEvent::WorkspaceEditApplied { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap();
    ops::lsp::undo_workspace_edit(&host, "main", id).await.unwrap();
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "old\n");
    assert_eq!(std::fs::read_to_string(&second).unwrap(), "own\n");
    assert_eq!(ops::doc::snapshot(&host, "main", info.id).await.unwrap().text, "old\n");
    ops::lsp::redo_workspace_edit(&host, "main", id).await.unwrap();
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "new\n");
    assert_eq!(std::fs::read_to_string(&second).unwrap(), "new\n");
    host.clear_workspace_edit_history_on_exit();
    assert_eq!(ops::lsp::undo_workspace_edit(&host, "main", id).await.unwrap_err().kind, ErrorKind::NotFound);
}

#[tokio::test(flavor = "current_thread")]
async fn contended_version_reads_do_not_block_the_async_worker() {
    use ide_core::{LanguageId, Pos, Range, RequestId};
    use ide_workspace::documents::DocumentObserver;
    use std::sync::mpsc;
    use std::time::Duration;

    struct PausedWrite {
        entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl DocumentObserver for PausedWrite {
        fn changed(
            &self,
            _: ide_core::DocId,
            _: &std::path::Path,
            _: u32,
            _: &[ide_text::AppliedChange],
            _: &dyn Fn() -> String,
        ) {
            if let Some(entered) = self.entered.lock().take() {
                let _ = entered.send(());
                self.release.lock().recv_timeout(Duration::from_secs(10)).unwrap();
            }
        }
    }

    for request_kind in 0..5 {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("main.txt");
        std::fs::write(&file, "old").unwrap();
        let host = Arc::new(Host::new(HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("local-data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
            owner: |window| window,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        let project = host.open_light("main", &file).unwrap();
        let doc = project.documents.open(&file).unwrap().id;
        assert_eq!(project.documents.snapshot(doc).unwrap().language, LanguageId::plain_text());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        project.documents.add_observer(Arc::new(PausedWrite {
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
        }));
        let documents = project.documents.clone();
        let writer = std::thread::spawn(move || {
            documents
                .apply_workspace_edit(
                    &serde_json::from_value(json!({ "files": [{
                "kind": "edit", "path": file, "edits": [{ "range": {
                    "start": { "line": 0, "col": 0 }, "end": { "line": 0, "col": 3 }
                }, "new_text": "new" }]
            }] }))
                    .unwrap(),
                )
                .unwrap();
        });
        entered_rx.await.unwrap();
        let (heartbeat_tx, heartbeat_rx) = mpsc::channel();
        // Always release the writer, even on the old blocking implementation.
        let watchdog = std::thread::spawn(move || {
            let responsive = heartbeat_rx.recv_timeout(Duration::from_secs(2)).is_ok();
            release_tx.send(()).unwrap();
            responsive
        });
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = started_tx.send(());
            let action =
                || serde_json::from_value(json!({ "title": "test", "isPreferred": false, "server": 1 })).unwrap();
            match request_kind {
                0 => {
                    let _ = ops::lsp::lsp_code_actions(&host, "main", doc, Range::point(Pos::new(0, 0)), vec![]).await;
                }
                1 => {
                    let _ = ops::lsp::lsp_code_action_query(
                        &host,
                        "main",
                        RequestId(1),
                        doc,
                        Range::point(Pos::new(0, 0)),
                        vec![],
                    )
                    .await;
                }
                2 => {
                    let _ = ops::lsp::lsp_resolve_code_action(&host, "main", doc, action()).await;
                }
                3 => {
                    let _ = ops::lsp::lsp_apply_code_action(&host, "main", doc, action()).await;
                }
                _ => {
                    let _ =
                        ops::lsp::lsp_rename(&host, "main", RequestId(1), doc, Pos::new(0, 0), "other".into()).await;
                }
            }
        });
        started_rx.await.unwrap();
        let _ = heartbeat_tx.send(());
        task.await.unwrap();
        writer.join().unwrap();
        assert!(watchdog.join().unwrap(), "request {request_kind} blocked the only async worker");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_actions_skip_a_command_no_server_provides_after_their_edit() {
    use ide_lsp::types::{CodeAction, Command};
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("imports.txt");
    std::fs::write(&file, "unused\nused\n").unwrap();
    let host = Host::new(HostConfig {
        config_dir: tmp.path().join("config"),
        data_dir: tmp.path().join("data"),
        local_data_dir: tmp.path().join("local-data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(|_| {})),
        owner: |window| window,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.open_light("main", &file).unwrap();
    let info = ops::doc::open(&host, "main", file.clone()).await.unwrap();
    // Optimize Imports as vtsls offers it: the edit, then a command its client runs itself.
    let action = |edit: bool| CodeAction {
        diagnostics: Vec::new(),
        original_diagnostics: None,
        title: "Organize Imports".into(),
        kind: Some("source.organizeImports".into()),
        is_preferred: false,
        disabled_reason: None,
        edit: edit.then(|| {
            serde_json::from_value(json!({ "files": [{ "kind": "edit", "path": file, "edits": [
                { "range": { "start": { "line": 0, "col": 0 }, "end": { "line": 1, "col": 0 } }, "new_text": "" }
            ] }] }))
            .unwrap()
        }),
        command: Some(Command {
            title: String::new(),
            command: "_typescript.didOrganizeImports".into(),
            arguments: vec![],
        }),
        data: None,
        server: ide_core::ServerId(1),
    };
    let follow_up = action(true).command.unwrap();
    let asked = ops::lsp::lsp_resolve_command(
        &host,
        "main",
        ide_core::RequestId(1),
        info.id,
        ide_core::ServerId(1),
        follow_up,
        vec![],
    )
    .await;
    assert!(matches!(asked, Ok(None)), "{asked:?}");
    ops::lsp::lsp_execute_code_action(&host, "main", ide_core::RequestId(2), info.id, action(true), vec![])
        .await
        .unwrap();
    assert_eq!(ops::doc::snapshot(&host, "main", info.id).await.unwrap().text, "used\n");
    ops::lsp::lsp_apply_code_action(&host, "main", info.id, action(true)).await.unwrap();
    assert_eq!(ops::doc::snapshot(&host, "main", info.id).await.unwrap().text, "");
    // Without an edit the command is the action: it still can't run.
    let ran =
        ops::lsp::lsp_execute_code_action(&host, "main", ide_core::RequestId(3), info.id, action(false), vec![]).await;
    assert!(ran.is_err(), "{ran:?}");
}
