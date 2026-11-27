//! The remote protocol end to end: a server on one side of an in-memory pipe,
//! a JSON-RPC client on the other.

mod common;

use ide_host::rpc::{self, ChannelMessage, Dispatcher, EventMessage, Invoke, ServerInfo};
use ide_host::{Host, HostConfig};
use ide_jsonrpc::{Handler, Peer};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

#[derive(Default)]
struct Client {
    channels: Mutex<Vec<ChannelMessage>>,
    events: Mutex<Vec<EventMessage>>,
}

impl Handler for Client {
    fn on_notification(&self, method: &str, params: Value) {
        match method {
            "channel" => self.channels.lock().push(serde_json::from_value(params).unwrap()),
            "event" => self.events.lock().push(serde_json::from_value(params).unwrap()),
            _ => {}
        }
    }
    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
    }
}

async fn invoke(peer: &Peer, cmd: &str, args: Value) -> Result<Value, ide_core::IdeError> {
    let call = Invoke { window: "main".into(), cmd: cmd.into(), args };
    peer.request::<_, Value>("invoke", call, None).await.map_err(rpc::error_from_reply)
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..500 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn serves_projects_files_documents_search_and_runs() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("demo");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("src/main.py"), "print('needle')\n").unwrap();
    let base = tmp.path().join("server");

    let peer_slot = Arc::new(OnceLock::new());
    let sink_peer = peer_slot.clone();
    let host = Arc::new(Host::new(HostConfig {
        sink_for: Box::new(move |w| rpc::event_sink(sink_peer.clone(), Some(w.to_owned()))),
        ..common::host_config(&base)
    }));
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host, Dispatcher::standard(), peer_slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let client = Arc::new(Client::default());
    let peer = Peer::connect(cr, cw, client.clone());

    let info: ServerInfo = peer.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None).await.unwrap();
    assert_eq!(info.protocol, rpc::PROTOCOL_VERSION);

    let scratch_path = base.join("data/scratches");
    assert!(!scratch_path.exists());
    let expected = serde_json::to_value(ide_core::IpcPath::from(scratch_path.clone())).unwrap();
    assert_eq!(invoke(&peer, "fs_scratches_dir", json!({})).await.unwrap(), expected);
    assert!(scratch_path.is_dir());
    assert_eq!(invoke(&peer, "fs_scratches_dir", json!({})).await.unwrap(), expected);

    let opened = invoke(&peer, "open_project", json!({ "path": project })).await.unwrap();
    assert_eq!(opened["name"], "demo");
    assert_eq!(opened["trusted"], false);
    invoke(&peer, "index_status", json!({})).await.unwrap();
    let metrics = invoke(&peer, "host_metrics", json!({ "includeProcesses": true })).await.unwrap();
    assert!(metrics["cpuCores"].as_u64().unwrap() >= 1);
    assert_eq!(metrics["processes"][0]["label"], "Backend");
    assert_eq!(invoke(&peer, "lsp_servers", json!({})).await.unwrap(), json!([]));
    invoke(&peer, "lsp_resend_diagnostics", json!({})).await.unwrap();
    let files = invoke(&peer, "find_files", json!({"query": "main", "limit": 10})).await.unwrap();
    assert!(files.is_array());
    for (command, args) in [
        ("build_sync", json!({})),
        ("run_start", json!({})),
        ("sdk_locate_tools", json!({})),
        ("notebook_execute", json!({})),
        ("debug_start", json!({})),
        ("agent_refresh_models", json!({})),
        ("host_end_process", json!({ "pid": 1 })),
    ] {
        let error = invoke(&peer, command, args).await.unwrap_err();
        assert!(error.message.contains("Restricted Mode"), "{command}: {error:?}");
    }
    let call = Invoke { window: "unknown".into(), cmd: "coverage_collect".into(), args: json!({}) };
    assert!(peer.request::<_, Value>("invoke", call, None).await.is_err());
    // Manual workspace edits remain available in Restricted Mode, like doc/fs
    // editing. They do not ask a language server to execute project commands.
    let manual = project.join("src/manual.txt");
    std::fs::write(&manual, "old").unwrap();
    let edit = json!({ "files": [{ "kind": "edit", "path": manual, "edits": [{
        "range": { "start": { "line": 0, "col": 0 }, "end": { "line": 0, "col": 3 } },
        "new_text": "new"
    }] }] });
    let edit = invoke(&peer, "prepare_workspace_edit", json!({ "edit": edit })).await.unwrap();
    assert_eq!(edit["preconditions"].as_array().unwrap().len(), 1);
    invoke(&peer, "apply_workspace_edit", json!({ "edit": edit })).await.unwrap();
    until("workspace edit history", || {
        client.events.lock().iter().any(|event| matches!(event.event, ide_core::IdeEvent::WorkspaceEditApplied { .. }))
    })
    .await;
    let undo_id = client
        .events
        .lock()
        .iter()
        .find_map(|event| match &event.event {
            ide_core::IdeEvent::WorkspaceEditApplied { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap();
    assert_eq!(std::fs::read_to_string(&manual).unwrap(), "new");
    invoke(&peer, "undo_workspace_edit", json!({ "id": undo_id })).await.unwrap();
    assert_eq!(std::fs::read_to_string(&manual).unwrap(), "old");
    invoke(&peer, "redo_workspace_edit", json!({ "id": undo_id })).await.unwrap();
    assert_eq!(std::fs::read_to_string(&manual).unwrap(), "new");
    assert_eq!(invoke(&peer, "project_current", json!({})).await.unwrap()["trusted"], false);
    for command in ["lsp_execute_command", "lsp_apply_code_action"] {
        let error = invoke(&peer, command, json!({})).await.unwrap_err();
        assert!(error.message.contains("Restricted Mode"), "{command}: {error:?}");
    }
    invoke(&peer, "project_trust_set", json!({"path": project, "trusted": true, "folder": false})).await.unwrap();
    let current = invoke(&peer, "project_current", json!({})).await.unwrap();
    assert_eq!(current["name"], "demo");

    // A SQL batch sends each outcome precisely once before the request reply.
    let file = project.join("test.sqlite");
    std::fs::File::create(&file).unwrap();
    let source = ide_db::DataSource {
        id: "test-db".into(),
        name: "Test database".into(),
        file: Some(file.into()),
        ..Default::default()
    };
    invoke(&peer, "db_save_sources", json!({ "sources": [source] })).await.unwrap();
    let sql = "SELECT 1 AS n; SELECT 'second' AS n";
    let statements =
        invoke(&peer, "db_statements", json!({ "id": "test-db", "text": sql, "from": 0, "to": sql.len() }))
            .await
            .unwrap();
    let done = invoke(
        &peer,
        "db_execute_stream",
        json!({ "request": 21, "id": "test-db", "statements": statements, "maxRows": 10,
            "schema": null, "onProgress": { "$channel": 521 } }),
    )
    .await
    .unwrap();
    assert!(done.is_null());
    let events = client
        .channels
        .lock()
        .iter()
        .filter(|frame| frame.id == 521)
        .map(|frame| frame.data.clone())
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 5);
    assert_eq!(events[0], json!({ "type": "started", "index": 0 }));
    assert_eq!(events[1]["outcome"]["result"]["rows"], json!([["1"]]));
    assert_eq!(events[2], json!({ "type": "started", "index": 1 }));
    assert_eq!(events[3]["outcome"]["result"]["rows"], json!([["second"]]));
    assert_eq!(events[4], json!({ "type": "done", "error": null }));

    // The built-in web server runs where the project is; the client forwards its port.
    let root = std::path::PathBuf::from(opened["root"].as_str().unwrap());
    let url = invoke(&peer, "web_url", json!({ "path": root.join("src/main.py") })).await.unwrap();
    let url = url.as_str().unwrap();
    assert!(url.starts_with("http://127.0.0.1:") && url.ends_with("/demo/src/main.py"), "{url}");

    let entries = invoke(&peer, "fs_read_dir", json!({ "path": project })).await.unwrap();
    assert!(entries.as_array().unwrap().iter().any(|e| e["name"] == "src"), "{entries}");

    // Directory comparisons, streamed progress and confirmed copies share the remote filesystem.
    let left = project.join("compare-left");
    let right = project.join("compare-right");
    std::fs::create_dir_all(&left).unwrap();
    std::fs::create_dir_all(&right).unwrap();
    std::fs::write(left.join("中文.bin"), [0, 255, 1]).unwrap();
    std::fs::write(right.join("中文.bin"), [0, 254, 1]).unwrap();
    assert_eq!(invoke(&peer, "fs_entry_kind", json!({"path": left})).await.unwrap(), "dir");
    assert_eq!(invoke(&peer, "fs_entry_kind", json!({"path": left.join("中文.bin")})).await.unwrap(), "file");
    let compare_args = |request| json!({"left": left, "right": right, "mode": "content", "request": request, "onProgress": {"$channel": 520}});
    let rows = invoke(&peer, "fs_compare_directories", compare_args(520)).await.unwrap();
    assert_eq!(rows[0]["status"], "different");
    assert!(client.channels.lock().iter().any(|c| c.id == 520 && c.data["compared"] == 1));
    let copy_args =
        |overwrite| json!({"sourceRoot": left, "destinationRoot": right, "path": "中文.bin", "overwrite": overwrite});
    let error = invoke(&peer, "fs_copy_merge", copy_args(false)).await.unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::AlreadyExists);
    invoke(&peer, "fs_copy_merge", copy_args(true)).await.unwrap();
    let rows = invoke(&peer, "fs_compare_directories", compare_args(521)).await.unwrap();
    assert_eq!(rows[0]["status"], "equal");
    invoke(&peer, "cancel_request", json!({"id": 522})).await.unwrap();
    let error = invoke(&peer, "fs_compare_directories", compare_args(522)).await.unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::Cancelled);
    let error = invoke(
        &peer,
        "fs_copy_merge",
        json!({"sourceRoot": left, "destinationRoot": right, "path": "../escape", "overwrite": true}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::InvalidInput);

    // JVM icons use the same read-only protocol as local windows.
    let java = project.join("src/Foo.java");
    let kotlin = project.join("src/Singleton.kt");
    std::fs::write(&java, "abstract class Foo {}").unwrap();
    std::fs::write(&kotlin, "object Singleton {}").unwrap();
    let icons = invoke(&peer, "jvm_file_presentations", json!({ "paths": [java, kotlin] })).await.unwrap();
    assert_eq!(icons[0]["presentation"]["kind"], "abstractClass");
    assert_eq!(icons[1]["presentation"]["kind"], "object");
    // Replacing a file invalidates its cached metadata, including same-size writes.
    std::fs::write(&java, "interface Foo {}     ").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&java)
        .unwrap()
        .set_modified(std::time::SystemTime::UNIX_EPOCH)
        .unwrap();
    let icons = invoke(&peer, "jvm_file_presentations", json!({ "paths": [java] })).await.unwrap();
    assert_eq!(icons[0]["presentation"]["kind"], "interface");
    let oversized = invoke(&peer, "jvm_file_presentations", json!({ "paths": vec![java.clone(); 65] })).await;
    assert!(oversized.is_err());

    // Edit and save a document.
    let file = project.join("src/main.py");
    let doc = invoke(&peer, "doc_open", json!({ "path": file })).await.unwrap();
    let id = doc["id"].clone();
    let version = doc["version"].as_u64().unwrap();
    let changes = json!({ "changes": [{ "from": 16, "to": 16, "insert": "print('more')\n" }] });
    invoke(&peer, "doc_edit", json!({ "doc": id, "baseVersion": version, "changes": changes })).await.unwrap();
    invoke(&peer, "doc_save", json!({ "doc": id })).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "print('needle')\nprint('more')\n");

    let outside = tmp.path().join("outside.txt");
    std::fs::write(&outside, "original\n").unwrap();
    let external = invoke(&peer, "doc_open", json!({ "path": outside })).await.unwrap();
    std::fs::write(&outside, "external change\n").unwrap();
    invoke(&peer, "doc_sync_from_disk", json!({})).await.unwrap();
    let snapshot = invoke(&peer, "doc_snapshot", json!({ "doc": external["id"] })).await.unwrap();
    assert_eq!(snapshot["text"], "external change\n");

    // Commands shared with the desktop shell (camelCase argument names, as Tauri takes them).
    invoke(&peer, "doc_set_line_ending", json!({ "doc": id, "lineEnding": "crLf" })).await.unwrap();
    invoke(&peer, "doc_save", json!({ "doc": id })).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "print('needle')\r\nprint('more')\r\n");
    let settings = invoke(
        &peer,
        "settings_set",
        json!({ "scope": "project", "key": "deployment.autoUpload",
        "value": "\"always\"" }),
    )
    .await
    .unwrap();
    assert_eq!(settings["deployment"]["autoUpload"], "always");
    assert!(std::fs::read_to_string(project.join(".openidea/settings.toml")).unwrap().contains("autoUpload"));
    invoke(&peer, "vcs_init", json!({ "dir": project })).await.unwrap();
    until("git repository", || project.join(".git").is_dir()).await;

    // A Docker run configuration's environment comes from the host its command runs on.
    let env =
        invoke(&peer, "docker_run_env", json!({ "endpoint": { "kind": "socket", "path": "/run/user/1/docker.sock" } }))
            .await
            .unwrap();
    assert_eq!(env["DOCKER_HOST"], "unix:///run/user/1/docker.sock");
    // Services › Docker commands are served by the project host too.
    assert!(Dispatcher::standard().commands().contains(&"docker_snapshot"));
    assert_eq!(invoke(&peer, "docker_settings", json!({})).await.unwrap()["connections"], json!([]));

    // Real project-host ignore writes travel through the remote command dispatcher.
    assert!(Dispatcher::standard().commands().contains(&"vcs_add_to_ignore"));
    let ignore_root = dunce::canonicalize(&project).unwrap();
    // Not `.tmp`: a machine's global excludes file (often `*.tmp`) already
    // ignores those, so the backend never writes the entry anywhere.
    for (name, destination) in [("shared.ignore-me", "gitignore"), ("private.ignore-me", "localExclude")] {
        let path = ignore_root.join(name);
        std::fs::write(&path, "temporary").unwrap();
        invoke(&peer, "vcs_add_to_ignore", json!({ "paths": [path], "destination": destination })).await.unwrap();
        let entries = invoke(&peer, "fs_read_dir", json!({ "path": ignore_root })).await.unwrap();
        let entry = entries.as_array().unwrap().iter().find(|e| e["name"] == name).unwrap();
        assert_eq!(entry["ignored"], true);
        assert_eq!(entry["excluded"], false);
    }
    assert!(std::fs::read_to_string(project.join(".gitignore")).unwrap().contains("/shared.ignore-me"));
    assert!(std::fs::read_to_string(project.join(".git/info/exclude")).unwrap().contains("/private.ignore-me"));
    let outside = tmp.path().join("outside.ignore-me");
    std::fs::write(&outside, "keep").unwrap();
    assert!(
        invoke(&peer, "vcs_add_to_ignore", json!({ "paths": [outside], "destination": "gitignore" })).await.is_err()
    );

    // Unknown commands and bad arguments come back as IdeErrors.
    let e = invoke(&peer, "window_minimize", json!({})).await.unwrap_err();
    assert!(e.message.contains("not available remotely"), "{e:?}");
    let e = invoke(&peer, "doc_save", json!({ "doc": "nope" })).await.unwrap_err();
    assert_eq!(e.kind, ide_core::error::ErrorKind::InvalidInput, "{e:?}");

    // Find in Files streams through a channel.
    let query = json!({ "pattern": "needle", "isRegex": false, "caseSensitive": false, "wholeWord": false,
        "include": [], "exclude": [], "scope": { "kind": "project" }, "maxMatches": 0 });
    invoke(&peer, "search_start", json!({ "request": 7, "query": query, "onEvent": { "$channel": 1 } })).await.unwrap();
    let found = client.channels.lock().iter().filter(|c| c.id == 1).map(|c| c.data.clone()).collect::<Vec<_>>();
    assert!(found.iter().any(|d| d["type"] == "file"), "{found:?}");
    assert_eq!(found.last().unwrap()["type"], "done");

    // HTTP Client requests and their history are served by the project host.
    let history = invoke(&peer, "http_history", json!({})).await.unwrap();
    assert_eq!(history, json!([]));
    let curl = invoke(
        &peer,
        "http_curl",
        json!({ "path": null, "text": "GET http://localhost/x\n", "index": 0, "env": null }),
    )
    .await
    .unwrap();
    assert!(curl.as_str().unwrap().contains("http://localhost/x"), "{curl}");

    // A run's output streams through a channel and its exit is an event.
    let config = json!({ "id": "echo", "name": "echo", "kind": "shell", "command": "echo", "args": ["remote-hi"],
        "cwd": null, "env": {}, "detected": false, "isTest": false, "debugAdapter": null });
    invoke(&peer, "run_start", json!({ "config": config, "onOutput": { "$channel": 2 } })).await.unwrap();
    until("run exit", || client.events.lock().iter().any(|e| e.event_type() == "runExited")).await;
    let out: String = client
        .channels
        .lock()
        .iter()
        .filter(|c| c.id == 2)
        .filter_map(|c| c.data["text"].as_str().map(str::to_owned))
        .collect();
    assert!(out.contains("remote-hi"), "{out}");
    assert_eq!(
        client.events.lock().iter().find(|e| e.event_type() == "runExited").unwrap().window.as_deref(),
        Some("main")
    );
}

trait EventType {
    fn event_type(&self) -> String;
}

impl EventType for EventMessage {
    fn event_type(&self) -> String {
        serde_json::to_value(&self.event).unwrap()["type"].as_str().unwrap_or_default().to_owned()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_deployment_runs_on_the_project_host() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    let target = tmp.path().join("mounted");
    std::fs::create_dir(&project).unwrap();
    std::fs::create_dir(&target).unwrap();
    let project = dunce::canonicalize(project).unwrap();
    let file = project.join("local.txt");
    std::fs::write(&file, "host file").unwrap();
    let slot = Arc::new(OnceLock::new());
    let sink_slot = slot.clone();
    let host = Arc::new(Host::new(HostConfig {
        sink_for: Box::new(move |w| rpc::event_sink(sink_slot.clone(), Some(w.to_owned()))),
        ..common::host_config(tmp.path())
    }));
    let dispatcher = Dispatcher::standard();
    for cmd in [
        "deploy_coverage",
        "deploy_upload",
        "deploy_download",
        "deploy_delete_remote",
        "deploy_compare",
        "deploy_sync",
        "deploy_info",
        "deploy_server_root",
        "deploy_test_connection",
        "remote_list",
        "remote_open",
        "remote_of",
        "remote_delete",
        "remote_mkdir",
        "remote_rename",
        "remote_download_into",
        "http_environments",
        "http_execute",
        "http_history",
        "http_history_get",
        "http_history_clear",
        "http_curl",
        "http_environment_file",
        "http_variable_definitions",
        "db_source_folders",
        "db_save_source_folders",
        "db_sources",
        "db_save_sources",
        "db_set_password",
        "db_test",
        "db_test_tunnel",
        "db_set_ssh_secret",
        "db_trust_ssh_host",
        "db_connected",
        "db_connect",
        "db_set_manual_commit",
        "db_finish_transaction",
        "db_disconnect",
        "db_databases",
        "db_schemas",
        "db_tables",
        "db_table_details",
        "db_table_grants",
        "db_ddl",
        "db_schema_objects",
        "db_object_ddl",
        "db_explain",
        "db_history",
        "db_remove_history",
        "db_completion",
        "db_statements",
        "db_execute",
        "db_table_page",
        "db_apply_edits",
        "db_console_path",
        "db_consoles_dir",
        "db_consoles",
        "ssh_test",
        "ssh_set_secret",
        "ssh_password_saved",
        "ssh_needs_secret",
        "ssh_trust_host",
        "ssh_connected",
        "ssh_disconnect",
    ] {
        assert!(dispatcher.commands().contains(&cmd), "missing host command {cmd}");
    }
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host, dispatcher, slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let peer = Peer::connect(cr, cw, Arc::new(Client::default()));
    // A remote window's host-key and password remedies reach the server's SSH manager,
    // the one its deployment / database connections failed in.
    let trust = invoke(&peer, "ssh_trust_host", json!({"id": "nothing-pending"})).await.unwrap_err();
    assert!(trust.message.contains("no host key to trust"), "{trust:?}");
    invoke(&peer, "ssh_set_secret", json!({"id": "deploy", "secret": "pw", "save": false})).await.unwrap();
    assert_eq!(invoke(&peer, "ssh_connected", json!({})).await.unwrap(), json!([]));
    invoke(&peer, "project_trust_set", json!({"path": project, "trusted": true, "folder": false})).await.unwrap();
    invoke(&peer, "open_project", json!({"path": project})).await.unwrap();
    let deployment = json!({"servers": [{"id":"local", "kind":"local", "rootPath":target}], "defaultServer":"local"});
    invoke(&peer, "settings_set", json!({"scope":"project", "key":"deployment", "value":deployment.to_string()}))
        .await
        .unwrap();
    let coverage = invoke(&peer, "deploy_coverage", json!({"paths":[file]})).await.unwrap();
    assert_eq!(coverage[0]["server"], "local");
    assert_eq!(coverage[0]["paths"], json!([ide_core::IpcPath::from(&file)]));
    invoke(&peer, "deploy_test_connection", json!({"connection":{"kind":"local"}, "path":target})).await.unwrap();
    let report = invoke(&peer, "deploy_upload", json!({"paths":[file], "request":1001})).await.unwrap();
    assert_eq!(report["files"], 1, "{report}");
    assert_eq!(std::fs::read_to_string(target.join("local.txt")).unwrap(), "host file");
    let entries = invoke(&peer, "remote_list", json!({"connection":{"kind":"local"}, "path":target})).await.unwrap();
    assert_eq!(entries[0]["name"], "local.txt");
    std::fs::write(target.join("local.txt"), "host download").unwrap();
    let report = invoke(&peer, "deploy_download", json!({"paths":[file], "request":1002})).await.unwrap();
    assert_eq!(report["files"], 1);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "host download");
    invoke(&peer, "deploy_delete_remote", json!({"paths":[file]})).await.unwrap();
    assert!(!target.join("local.txt").exists());
    invoke(&peer, "close_project", json!({})).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn properties_conversion_through_remote_dispatch_without_a_remote_host() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("properties-project");
    std::fs::create_dir(&root).unwrap();
    let path = root.join("messages.properties");
    std::fs::write(&path, r"value=\u4F60\u597D\uD83D\uDE00!").unwrap();
    let peer_slot = Arc::new(OnceLock::new());
    let host = Arc::new(Host::new(common::host_config(tmp.path())));
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host, Dispatcher::standard(), peer_slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let peer = Peer::connect(cr, cw, Arc::new(Client::default()));
    invoke(&peer, "open_project", json!({"path":root})).await.unwrap();
    let settings = invoke(&peer, "settings_get", json!({})).await.unwrap();
    assert_eq!(settings["editor"]["encodings"]["nativeToAscii"], false);
    let opened = invoke(&peer, "doc_open", json!({"path":path})).await.unwrap();
    let doc = opened["id"].clone();
    invoke(&peer, "settings_set", json!({"scope":"project", "key":"editor.encodings.nativeToAscii", "value":"true"}))
        .await
        .unwrap();
    let mut snap = Value::Null;
    for _ in 0..500 {
        snap = invoke(&peer, "doc_snapshot", json!({"doc":doc})).await.unwrap();
        if snap["text"] == "value=你好😀!" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(snap["text"], "value=你好😀!");
    assert_eq!(snap["dirty"], false);
    invoke(
        &peer,
        "doc_edit",
        json!({"doc":doc, "baseVersion":snap["version"],
        "changes":{"changes":[{"from":10,"to":11,"insert":"界"}]}}),
    )
    .await
    .unwrap();
    invoke(&peer, "doc_save", json!({"doc":doc})).await.unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), r"value=\u4F60\u597D\uD83D\uDE00\u754C");
    invoke(&peer, "doc_set_encoding", json!({"doc":doc,"encoding":"utf-8","reload":true})).await.unwrap();
    let reloaded = invoke(&peer, "doc_snapshot", json!({"doc":doc})).await.unwrap();
    assert_eq!(reloaded["text"], "value=你好😀界");
    assert_eq!(reloaded["dirty"], false);
    invoke(&peer, "close_project", json!({})).await.unwrap();
    peer.kill();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renames_a_branch_with_the_clients_argument_names() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").args(args).current_dir(&root).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(root.join("a.txt"), "a\n").unwrap();
    git(&["add", "."]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    git(&["branch", "feature"]);
    let peer_slot = Arc::new(OnceLock::new());
    let host = Arc::new(Host::new(common::host_config(tmp.path())));
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host, Dispatcher::standard(), peer_slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let peer = Peer::connect(cr, cw, Arc::new(Client::default()));
    invoke(&peer, "open_project", json!({"path": root})).await.unwrap();
    invoke(&peer, "project_trust_set", json!({"path": root, "trusted": true, "folder": false})).await.unwrap();
    // The argument names the desktop client sends (`vcsRenameBranch` in src/bindings.ts).
    invoke(
        &peer,
        "vcs_rename_branch",
        json!({"repo": null, "from": "feature", "to": "renamed", "unsetUpstream": false}),
    )
    .await
    .unwrap();
    assert_eq!(
        git(&["branch", "--format=%(refname:short)", "--list"]).lines().collect::<Vec<_>>(),
        ["main", "renamed"]
    );
    invoke(&peer, "close_project", json!({})).await.unwrap();
    peer.kill();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn serves_builtin_mcp_over_remote_dispatch_and_routes_ui_requests() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("remote-mcp");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/hello.txt"), "from remote mcp\n").unwrap();
    let root = dunce::canonicalize(root).unwrap();
    let base = tmp.path().join("server");
    let data_dir = base.join("data");

    let peer_slot = Arc::new(OnceLock::new());
    let sink_peer = peer_slot.clone();
    let host = Arc::new(Host::new(HostConfig {
        sink_for: Box::new(move |w| rpc::event_sink(sink_peer.clone(), Some(w.to_owned()))),
        ..common::host_config(&base)
    }));
    let server_exe = base.join("bin/openidea-server");
    host.mcp.set_stdio_link(server_exe.clone());
    host.mcp.apply(&host);

    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    let serve_host = host.clone();
    tokio::spawn(rpc::serve(serve_host, Dispatcher::standard(), peer_slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let client = Arc::new(Client::default());
    let peer = Peer::connect(cr, cw, client.clone());

    invoke(&peer, "open_project", json!({ "path": root })).await.unwrap();
    for cmd in ["mcp_server_status", "mcp_regenerate_token", "mcp_ui_ready", "mcp_respond", "mcp_agent_run_closed"] {
        let err = invoke(&peer, cmd, json!({})).await.unwrap_err();
        assert!(err.message.contains("Restricted Mode"), "{cmd}: {err:?}");
    }

    invoke(&peer, "project_trust_set", json!({ "path": root, "trusted": true, "folder": false })).await.unwrap();
    let initial = invoke(&peer, "mcp_server_status", json!({})).await.unwrap();
    assert_eq!(initial["running"], false);
    assert!(!server_exe.exists(), "the stdio link is written only once the server runs");

    invoke(&peer, "settings_set", json!({ "scope": "global", "key": "mcpServer.fixedPort", "value": "false" }))
        .await
        .unwrap();
    invoke(&peer, "settings_set", json!({ "scope": "global", "key": "mcpServer.fixedToken", "value": "true" }))
        .await
        .unwrap();
    invoke(&peer, "settings_set", json!({ "scope": "global", "key": "mcpServer.enabled", "value": "true" }))
        .await
        .unwrap();

    let global = invoke(&peer, "settings_get_global", json!({})).await.unwrap();
    assert_eq!(global["mcpServer"]["enabled"], true);

    let status = invoke(&peer, "mcp_server_status", json!({})).await.unwrap();
    assert_eq!(status["running"], true);
    assert_eq!(status["project"], json!(ide_core::IpcPath::from(&root)));
    #[cfg(unix)]
    {
        assert_eq!(status["stdioCommand"][0], server_exe.to_string_lossy().as_ref());
        assert_eq!(std::fs::read_link(&server_exe).unwrap(), std::env::current_exe().unwrap());
    }
    let first_token = status["token"].as_str().unwrap().to_owned();
    assert!(status["url"].as_str().unwrap().starts_with("http://127.0.0.1:"));

    invoke(&peer, "mcp_ui_ready", json!({ "ready": true })).await.unwrap();
    let discovery = ide_mcp::discovery_path(&data_dir);

    let read_call = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "read_file", "arguments": { "file_path": "src/hello.txt" } }
    });
    let mut out = Vec::new();
    ide_mcp::stdio::bridge(&discovery, &root, format!("{read_call}\n").as_bytes(), &mut out).await.unwrap();
    let reply: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(reply["result"]["content"][0]["text"], "L1: from remote mcp\nL2: ");

    // UI-bound MCP requests stream over RPC events and are answered via routed `mcp_respond`.
    let open_call = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": "open_file_in_editor", "arguments": { "filePath": "src/hello.txt", "line": 1, "column": 1 } }
    });
    let (disc2, root2) = (discovery.clone(), root.clone());
    let call_task = tokio::spawn(async move {
        let mut out = Vec::new();
        ide_mcp::stdio::bridge(&disc2, &root2, format!("{open_call}\n").as_bytes(), &mut out).await.unwrap();
        serde_json::from_slice::<Value>(&out).unwrap()
    });
    until("remote MCP UI request", || {
        client.events.lock().iter().any(|m| matches!(m.event, ide_core::IdeEvent::McpRequest { .. }))
    })
    .await;
    let req_id = client
        .events
        .lock()
        .iter()
        .find_map(|m| match &m.event {
            event @ ide_core::IdeEvent::McpRequest { id, .. } => {
                assert!(!rpc::client_accepts(event, false));
                assert!(rpc::client_accepts(event, true));
                Some(*id)
            }
            _ => None,
        })
        .unwrap();
    invoke(&peer, "mcp_respond", json!({ "id": req_id, "allow": true, "error": null })).await.unwrap();
    let opened = call_task.await.unwrap();
    assert_eq!(opened["result"]["isError"], false, "{opened}");

    invoke(&peer, "mcp_regenerate_token", json!({})).await.unwrap();
    let rotated = invoke(&peer, "mcp_server_status", json!({})).await.unwrap();
    assert_eq!(rotated["running"], true);
    assert_ne!(rotated["token"].as_str().unwrap(), first_token);

    host.mcp.stop(&host);
    invoke(&peer, "close_project", json!({})).await.unwrap();
    peer.kill();
}
