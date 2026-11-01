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
