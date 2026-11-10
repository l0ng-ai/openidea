//! Code plugins of a remote project run on the
//! server. The desktop's plugin host syncs its live
//! code plugins over the remote protocol; Checkstyle then checks the file on
//! the server's disk when it is saved, and secrets come from the desktop.

#![cfg(unix)]

use ide_core::IdeEvent;
use ide_host::plugins::remote_host::{
    EVENT_NOTIFICATION, PackageSyncReport, PluginEventMessage, RemotePlugins, SECRET_REQUEST, SYNC_PACKAGES,
    SecretRequest,
};
use ide_host::plugins::{Consent, PluginEvent, PluginHost, PluginStatus, WorkbenchEvent};
use ide_host::rpc::{self, Dispatcher, EventMessage, Invoke};
use ide_host::{Host, HostConfig};
use ide_jsonrpc::{Handler, Peer};
use ide_plugin::Limits;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

#[derive(Default)]
struct Client {
    events: Mutex<Vec<EventMessage>>,
    plugin_events: Mutex<Vec<PluginEventMessage>>,
    secret_requests: Mutex<Vec<SecretRequest>>,
    desktop: Option<Arc<PluginHost>>,
}

impl Handler for Client {
    fn on_notification(&self, method: &str, params: Value) {
        match method {
            "event" => self.events.lock().push(serde_json::from_value(params).unwrap()),
            EVENT_NOTIFICATION => self.plugin_events.lock().push(serde_json::from_value(params).unwrap()),
            _ => {}
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        if method == SECRET_REQUEST {
            let r: SecretRequest = serde_json::from_value(params).unwrap();
            let value = (r.name == "api-key").then(|| "sk-desktop".to_owned());
            self.secret_requests.lock().push(r);
            return Ok(serde_json::to_value(value).unwrap());
        }
        if let Some(desktop) = &self.desktop {
            use ide_host::plugins::remote_host::{AUTH_REQUEST, SECRET_WRITE};
            if method == AUTH_REQUEST {
                return Ok(
                    serde_json::to_value(desktop.remote_auth("main", serde_json::from_value(params).unwrap())).unwrap()
                );
            }
            if method == SECRET_WRITE {
                return Ok(
                    serde_json::to_value(desktop.remote_secret_write(serde_json::from_value(params).unwrap())).unwrap()
                );
            }
        }
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
    }
}

async fn invoke(peer: &Peer, cmd: &str, args: Value) -> Result<Value, ide_core::IdeError> {
    let call = Invoke { window: "main".into(), cmd: cmd.into(), args };
    peer.request::<_, Value>("invoke", call, None).await.map_err(rpc::error_from_reply)
}

async fn sync(peer: &Peer, desktop: &PluginHost, files: &[&str]) -> PackageSyncReport {
    let files: serde_json::Map<String, Value> = files
        .iter()
        .map(|id| ((*id).to_owned(), serde_json::to_value(desktop.remote_package_files(id).unwrap()).unwrap()))
        .collect();
    let args = json!({ "packages": desktop.remote_packages(), "files": files });
    serde_json::from_value(invoke(peer, SYNC_PACKAGES, args).await.unwrap()).unwrap()
}

fn official(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/official").join(name)
}

/// A test fixture plugin (`crates/ide-plugin/tests/fixtures/<name>`).
fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures").join(name)
}

/// A `checkstyle` that reports a tab on line 2 of the file it is given.
fn fake_checkstyle(bin: &Path) {
    std::fs::create_dir_all(bin).unwrap();
    std::fs::write(
        bin.join("checkstyle"),
        "#!/bin/sh\nfor a; do file=\"$a\"; done\ngrep -q '\t' \"$file\" || { echo '<checkstyle/>'; exit 0; }\n\
         echo '<?xml version=\"1.0\"?><checkstyle><file name=\"'\"$file\"'\">'\n\
         echo '<error line=\"2\" column=\"1\" severity=\"warning\" message=\"Line contains a tab character.\" source=\"com.puppycrawl.tools.checkstyle.checks.whitespace.FileTabCharacterCheck\"/>'\n\
         echo '</file></checkstyle>'\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(bin.join("checkstyle"), std::fs::Permissions::from_mode(0o755)).unwrap();
}

async fn until(what: &str, secs: u64, mut done: impl FnMut() -> bool) {
    for _ in 0..secs * 50 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remote_projects_run_the_desktops_code_plugins_on_the_server() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    fake_checkstyle(&bin);
    let path_var = {
        let bin = bin.clone();
        Arc::new(move || Some(bin.clone().into_os_string()))
    };

    // The desktop: Checkstyle and AI Completion installed and granted.
    let desktop =
        PluginHost::new(tmp.path().join("desktop/plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default())
            .unwrap();
    desktop.set_program_path(path_var.clone());
    for name in ["checkstyle", "ai-completion"] {
        let info = desktop.install_from_dir(&official(name), &Consent::all()).unwrap();
        assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    }

    // The server, with the project on "its" disk.
    // Canonical, as the UI reports paths (macOS: /var → /private/var).
    let project = tmp.path().join("remote/demo");
    std::fs::create_dir_all(project.join("src")).unwrap();
    let project = std::fs::canonicalize(project).unwrap();
    let base = tmp.path().join("server");
    let peer_slot = Arc::new(OnceLock::new());
    let sink_peer = peer_slot.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |w| rpc::event_sink(sink_peer.clone(), Some(w.to_owned()))),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let plugins = RemotePlugins::start(&base.join("data"), &host, peer_slot.clone()).unwrap();
    plugins.host().set_program_path(path_var);
    let mut dispatcher = Dispatcher::standard();
    plugins.register(&mut dispatcher);
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host.clone(), dispatcher, peer_slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let client = Arc::new(Client::default());
    let peer = Peer::connect(cr, cw, client.clone());
    let _: Value = peer.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None).await.unwrap();
    invoke(&peer, "open_project", json!({ "path": project })).await.unwrap();
    invoke(&peer, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();

    // Digests first; then the files of what the server lacks; then nothing to do.
    let first = sync(&peer, &desktop, &[]).await;
    assert_eq!(first.missing, ["openidea.ai-completion", "openidea.checkstyle"], "{first:?}");
    let second = sync(&peer, &desktop, &["openidea.ai-completion", "openidea.checkstyle"]).await;
    assert_eq!(second.installed.len(), 2, "{second:?}");
    assert!(second.failed.is_empty(), "{second:?}");
    assert_eq!(sync(&peer, &desktop, &[]).await, PackageSyncReport::default());
    let remote = plugins.host().info_of("openidea.checkstyle").unwrap();
    assert_eq!(remote.status, PluginStatus::Inactive, "{:?}", remote.error);
    assert!(remote.capabilities.iter().any(|c| c.id == "process:checkstyle" && c.granted));

    // The remote window's UI routes the run-time commands to the server.
    let kinds = invoke(&peer, "plugin_event_kinds", json!({})).await.unwrap();
    assert!(kinds.as_array().unwrap().contains(&json!("file-saved")), "{kinds}");

    invoke(&peer, "plugin_set_ui_locale", json!({ "tag": "fr" })).await.unwrap();
    assert_eq!(plugins.host().ui_locale(), "fr");

    // Saving a file that exists only on the server: Checkstyle reads that file.
    let java = project.join("src/A.java");
    std::fs::write(&java, "class A {\n\tint x;\n}\n").unwrap();
    let saved = WorkbenchEvent::FileSaved(java.to_string_lossy().into_owned());
    invoke(&peer, "plugin_post_events", json!({ "events": [saved] })).await.unwrap();
    let published = || {
        client.events.lock().iter().find_map(|m| match &m.event {
            IdeEvent::Diagnostics { path, source, items } if source == "plugin:openidea.checkstyle" => {
                Some((path.0.clone(), items.clone()))
            }
            _ => None,
        })
    };
    until("remote checkstyle diagnostics", 20, || published().is_some()).await;
    let (path, items) = published().unwrap();
    assert_eq!(path, java);
    assert_eq!((items.len(), items[0].range.start.line), (1, 1));

    // Secrets stay on the desktop: the server asks for them when used.
    let secrets = plugins.host().secrets("openidea.ai-completion").unwrap();
    assert_eq!(secrets, [("api-key".to_owned(), true)]);
    assert_eq!(client.secret_requests.lock()[0].plugin, "openidea.ai-completion");

    // A command of a remote plugin, with this window as its client.
    invoke(
        &peer,
        "plugin_run_command",
        json!({ "pluginId": "openidea.ai-completion", "commandId": "toggle", "arg": null, "editor": null }),
    )
    .await
    .unwrap();
    until("the command's notification", 5, || {
        client
            .plugin_events
            .lock()
            .iter()
            .any(|m| m.window.as_deref() == Some("main") && matches!(m.event, PluginEvent::Notification { .. }))
    })
    .await;

    // Disabled on the desktop: retained but stopped on the server.
    desktop.set_enabled("openidea.checkstyle", false).unwrap();
    let removed = sync(&peer, &desktop, &[]).await;
    assert!(removed.removed.is_empty());
    assert_eq!(plugins.host().info_of("openidea.checkstyle").unwrap().status, PluginStatus::Disabled);
    plugins.host().shutdown();
}

/// CSV Editor and a tool window with a terminal (the `jobs` fixture) in a
/// remote project. The table edits the document on the server; the jobs are
/// the server's `jobs` program's, and the terminal opens in the remote window.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remote_projects_get_plugin_views_and_custom_editors() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("jobs"), "#!/bin/sh\n[ \"$1\" = list ] && echo remote-job\n").unwrap();
    std::fs::set_permissions(bin.join("jobs"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let path_var = {
        let bin = bin.clone();
        Arc::new(move || Some(bin.clone().into_os_string()))
    };
    let desktop =
        PluginHost::new(tmp.path().join("desktop/plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default())
            .unwrap();
    desktop.set_program_path(path_var.clone());
    for dir in [official("csv-editor"), fixture("jobs"), fixture("settings-pages")] {
        let info = desktop.install_from_dir(&dir, &Consent::all()).unwrap();
        assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    }

    let project = tmp.path().join("remote/demo");
    std::fs::create_dir_all(&project).unwrap();
    let project = std::fs::canonicalize(project).unwrap();
    std::fs::write(project.join("people.csv"), "name,city\nAda,London\n").unwrap();
    let base = tmp.path().join("server");
    let peer_slot = Arc::new(OnceLock::new());
    let sink_peer = peer_slot.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |w| rpc::event_sink(sink_peer.clone(), Some(w.to_owned()))),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let plugins = RemotePlugins::start(&base.join("data"), &host, peer_slot.clone()).unwrap();
    plugins.host().set_program_path(path_var);
    let mut dispatcher = Dispatcher::standard();
    plugins.register(&mut dispatcher);
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host.clone(), dispatcher, peer_slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let client = Arc::new(Client::default());
    let peer = Peer::connect(cr, cw, client.clone());
    let _: Value = peer.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None).await.unwrap();
    invoke(&peer, "open_project", json!({ "path": project })).await.unwrap();
    invoke(&peer, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();
    let report = sync(&peer, &desktop, &["openidea.csv-editor", "jobs", "settings-pages"]).await;
    assert_eq!(report.installed.len(), 3, "{report:?}");

    // CSV Editor: the document is the server's.
    let opened = invoke(&peer, "doc_open", json!({ "path": project.join("people.csv") })).await.unwrap();
    let doc = opened["id"].as_u64().expect("doc id");
    let args = |extra: Value| {
        let mut a = json!({ "pluginId": "openidea.csv-editor", "view": "table", "doc": doc });
        a.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        a
    };
    let view =
        invoke(&peer, "plugin_view_render", args(json!({ "viewport": { "firstRow": 0, "rows": 50 } }))).await.unwrap();
    assert_eq!(view["body"]["kind"], "table");
    assert_eq!(view["body"]["value"]["rows"], json!([["Ada", "London"]]));
    let cell = json!({ "event": { "kind": "cell", "row": 0, "column": 1, "value": "Oslo" } });
    invoke(&peer, "plugin_view_event", args(cell)).await.unwrap();
    let snap = invoke(&peer, "doc_snapshot", json!({ "doc": doc })).await.unwrap();
    assert_eq!(snap["text"], "name,city\nAda,Oslo\n");

    // Jobs: the server's program; the terminal opens in this window.
    let jobs = |event: Value| json!({ "pluginId": "jobs", "view": "jobs", "doc": null, "event": event });
    let view =
        invoke(&peer, "plugin_view_render", json!({ "pluginId": "jobs", "view": "jobs", "doc": null })).await.unwrap();
    assert_eq!(view["body"]["value"][0]["label"], "remote-job", "{view}");
    invoke(&peer, "plugin_view_event", jobs(json!({ "kind": "select", "key": "remote-job" }))).await.unwrap();
    invoke(&peer, "plugin_view_event", jobs(json!({ "kind": "button", "id": "follow" }))).await.unwrap();
    until("the job's terminal", 5, || {
        client.plugin_events.lock().iter().any(|m| {
            m.window.as_deref() == Some("main")
                && matches!(&m.event, PluginEvent::OpenTerminal { program, .. } if program.0.starts_with(bin.canonicalize().unwrap()))
        })
    })
    .await;

    invoke(
        &peer,
        "plugin_run_command",
        json!({ "pluginId": "jobs", "commandId": "context", "arg": "mode=true", "editor": null }),
    )
    .await
    .unwrap();
    until("the context key's event", 5, || {
        client.plugin_events.lock().iter().any(|m| {
            m.window.as_deref() == Some("main")
                && matches!(&m.event, PluginEvent::ContextChanged { key, value, .. } if key == "mode" && value.as_deref() == Some("true"))
        })
    })
    .await;
    let keys = invoke(&peer, "plugin_context_keys", json!({})).await.unwrap();
    assert_eq!(keys, json!([{ "pluginId": "jobs", "key": "mode", "value": "true" }]), "{keys}");

    let selected = invoke(
        &peer,
        "plugin_run_command",
        json!({ "pluginId": "jobs", "commandId": "selection", "arg": null, "editor": null, "paths": ["/srv/src/a.txt"] }),
    )
    .await
    .unwrap();
    assert_eq!(selected, "/srv/src/a.txt");
    for (scope, name) in [("global", "Global"), ("project", "Project")] {
        let values = json!({ "settings-pages": { "profiles": [{ "name": name, "provider": "local", "baseUrl": "http://localhost", "model": "test", "enabled": true, "temperature": 0.7, "limit": 100 }] } });
        invoke(&peer, "settings_set", json!({ "scope": scope, "key": "plugins", "value": values.to_string() }))
            .await
            .unwrap();
    }
    for (scope, name) in
        [(None, "Project"), (Some("global"), "Global"), (Some("project"), "Project"), (None, "Project")]
    {
        let mut args = json!({ "pluginId": "settings-pages", "commandId": "test", "arg": null, "editor": null });
        if let Some(scope) = scope {
            args["settingsScope"] = json!(scope);
        }
        let result = invoke(&peer, "plugin_run_command", args).await.unwrap();
        let result: Value = serde_json::from_str(result.as_str().unwrap()).unwrap();
        assert_eq!(result["profiles"][0]["name"], name);
        assert_eq!(result["hasProject"], true);
    }

    plugins.host().shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn api14_remote_calls_keep_browser_listeners_and_secrets_on_the_desktop() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let tmp = tempfile::tempdir().unwrap();
    let desktop = Arc::new(
        PluginHost::new(tmp.path().join("desktop/plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default())
            .unwrap(),
    );
    desktop.install_from_dir(&fixture("api14"), &Consent::all()).unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let project = project.canonicalize().unwrap();
    let base = tmp.path().join("server");
    let peer_slot = Arc::new(OnceLock::new());
    let sink_peer = peer_slot.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |w| rpc::event_sink(sink_peer.clone(), Some(w.into()))),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let plugins = RemotePlugins::start(&base.join("data"), &host, peer_slot.clone()).unwrap();
    let mut dispatcher = Dispatcher::standard();
    plugins.register(&mut dispatcher);
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    let server = tokio::spawn(rpc::serve(host.clone(), dispatcher, peer_slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let client = Arc::new(Client { desktop: Some(desktop.clone()), ..Client::default() });
    let peer = Peer::connect(cr, cw, client.clone());
    let _: Value = peer.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None).await.unwrap();
    invoke(&peer, "open_project", json!({ "path": project })).await.unwrap();
    invoke(&peer, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();
    sync(&peer, &desktop, &[]).await;
    let report = sync(&peer, &desktop, &["api14"]).await;
    assert!(report.failed.is_empty(), "{report:?}");
    let run = |command: &str, arg: Option<&str>| json!({ "pluginId": "api14", "commandId": command, "arg": arg, "editor": null });
    let remote_file = project.join("remote.txt");
    std::fs::write(&remote_file, "remote text").unwrap();
    invoke(&peer, "mcp_set_open_editors", json!({"paths": [remote_file]})).await.unwrap();
    invoke(&peer, "mcp_set_focused_editor", json!({"editor": {"path": remote_file, "selection": {"start": {"line": 0, "col": 0}, "end": {"line": 0, "col": 0}}, "selectedText": ""}, "focused": true})).await.unwrap();
    let editors = invoke(&peer, "plugin_run_command", run("open-editors", None)).await.unwrap();
    assert!(editors.as_str().unwrap().contains("remote.txt"));
    assert!(editors.as_str().unwrap().contains("active: true"));
    let problems = invoke(&peer, "plugin_run_command", run("problems", None)).await.unwrap();
    assert_eq!(problems.as_str(), Some("[]"));
    let other_file = project.join("other.txt");
    std::fs::write(&other_file, "other text").unwrap();
    let outside_file = tmp.path().join("outside.txt");
    std::fs::write(&outside_file, "outside").unwrap();
    let problem = |path: &Path, message: &str| {
        json!({"path": path, "items": [{
            "range": {"start": {"line": 0, "col": 1}, "end": {"line": 0, "col": 3}},
            "severity": "warning", "message": message, "source": "remote-check", "code": null
        }]})
    };
    let files = json!([
        problem(&remote_file, "remote warning"),
        problem(&other_file, "other warning"),
        problem(&outside_file, "outside warning")
    ]);
    invoke(&peer, "mcp_report_problems", json!({"reset": true, "files": files})).await.unwrap();
    let problems = invoke(&peer, "plugin_run_command", run("problems", None)).await.unwrap();
    let problems = problems.as_str().unwrap();
    assert!(problems.contains("remote warning"), "{problems}");
    assert!(problems.contains("other warning"), "{problems}");
    assert!(!problems.contains("outside warning"), "{problems}");
    for path in ["remote.txt", remote_file.to_str().unwrap()] {
        let problems = invoke(&peer, "plugin_run_command", run("problems", Some(path))).await.unwrap();
        let problems = problems.as_str().unwrap();
        assert!(problems.contains("remote warning"), "{problems}");
        assert!(!problems.contains("other warning"), "{problems}");
        assert!(problems.contains(remote_file.to_str().unwrap()), "{problems}");
    }
    assert_eq!(invoke(&peer, "plugin_run_command", run("problems", Some("missing.txt"))).await.unwrap(), json!("[]"));
    invoke(&peer, "mcp_report_problems", json!({"reset": false, "files": [{"path": remote_file, "items": []}]}))
        .await
        .unwrap();
    let problems = invoke(&peer, "plugin_run_command", run("problems", None)).await.unwrap();
    assert!(!problems.as_str().unwrap().contains("remote warning"));
    assert!(problems.as_str().unwrap().contains("other warning"));
    invoke(
        &peer,
        "mcp_report_problems",
        json!({"reset": true, "files": [problem(&remote_file, "replacement warning")]}),
    )
    .await
    .unwrap();
    let problems = invoke(&peer, "plugin_run_command", run("problems", None)).await.unwrap();
    assert!(problems.as_str().unwrap().contains("replacement warning"));
    assert!(!problems.as_str().unwrap().contains("other warning"));
    invoke(&peer, "mcp_report_problems", json!({"reset": true, "files": []})).await.unwrap();
    assert_eq!(invoke(&peer, "plugin_run_command", run("problems", None)).await.unwrap(), json!("[]"));
    invoke(&peer, "plugin_run_command", run("open-editor", Some("remote.txt"))).await.unwrap();
    invoke(&peer, "plugin_run_command", run("decorations", remote_file.to_str())).await.unwrap();
    let sets = invoke(&peer, "plugin_decoration_sets", json!({})).await.unwrap();
    assert_eq!(sets["api14"][0]["root"], project.to_str().unwrap());
    until("forwarded editor and decoration events", 5, || {
        let events = client.plugin_events.lock();
        events.iter().any(|m| m.window.as_deref() == Some("main") && matches!(m.event, PluginEvent::EditorOpen { .. }))
            && events.iter().any(|m| matches!(m.event, PluginEvent::DecorationsChanged { .. }))
    })
    .await;
    invoke(&peer, "plugin_run_command", run("secret", Some("remote-token"))).await.unwrap();
    assert_eq!(desktop.declared_secret("api14", "token").as_deref(), Some("remote-token"));
    invoke(&peer, "plugin_run_command", run("delete-secret", None)).await.unwrap();
    assert_eq!(desktop.declared_secret("api14", "token"), None);
    invoke(&peer, "plugin_run_command", run("window-status", Some("remote"))).await.unwrap();
    let status = invoke(&peer, "plugin_status_items", json!({})).await.unwrap();
    assert!(status.as_array().unwrap().iter().any(|s| s["window"] == true && s["item"]["text"] == "remote"));
    let oauth_peer = peer.clone();
    let oauth = tokio::spawn(async move {
        invoke(
            &oauth_peer,
            "plugin_run_command",
            json!({ "pluginId": "api14", "commandId": "oauth", "arg": null, "editor": null }),
        )
        .await
    });
    until("remote OAuth URI", 5, || {
        client
            .plugin_events
            .lock()
            .iter()
            .any(|m| matches!(&m.event, PluginEvent::OutputChanged { channel, .. } if channel == "oauth"))
    })
    .await;
    let uri = client
        .plugin_events
        .lock()
        .iter()
        .find_map(|m| match &m.event {
            PluginEvent::OutputChanged { channel, text: Some(text), .. } if channel == "oauth" => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    let authority = uri.strip_prefix("http://").unwrap().split('/').next().unwrap();
    let mut stream = tokio::net::TcpStream::connect(authority).await.unwrap();
    stream.write_all(b"GET /oauth/callback?code=desktop%2Bcode HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    assert!(response.contains("You can close this tab"));
    assert_eq!(oauth.await.unwrap().unwrap(), json!("code=desktop%2Bcode"));
    invoke(&peer, "mcp_report_problems", json!({"reset": true, "files": files})).await.unwrap();
    invoke(&peer, "close_project", json!({})).await.unwrap();
    invoke(&peer, "open_project", json!({"path": project})).await.unwrap();
    assert_eq!(invoke(&peer, "plugin_run_command", run("problems", None)).await.unwrap(), json!("[]"));
    invoke(&peer, "mcp_report_problems", json!({"reset": true, "files": files})).await.unwrap();
    peer.kill();
    tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap();
    let plugin_host = plugins.host().clone();
    let result = tokio::task::spawn_blocking(move || {
        plugin_host
            .run_command(
                "api14",
                "problems",
                None,
                ide_plugin::Invocation {
                    client: Some("main".into()),
                    workspace_root: Some(project),
                    ..Default::default()
                },
            )
            .unwrap()
    })
    .await
    .unwrap();
    assert_eq!(result.as_deref(), Some("[]"));
    plugins.host().shutdown();
    desktop.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn api14_stage3_remote_terminal_pins_and_exit_events_stay_on_the_execution_host() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let executable = bin.join("execution-tool");
    std::fs::write(&executable, "#!/bin/sh\nif [ \"$1\" = wrapped ]; then printf '<%s>\\n' \"$@\" > \"$PWD/wrapped.txt\"; exit; fi\nif [ \"$1\" = composer ]; then printf '<%s>\\n' \"$@\" > \"$PWD/composer.txt\"; exit; fi\nread line\nprintf '%s\\n' \"$line\"\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path_var = {
        let bin = bin.clone();
        Arc::new(move || Some(bin.clone().into_os_string()))
    };
    let desktop =
        PluginHost::new(tmp.path().join("desktop/plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default())
            .unwrap();
    desktop.set_program_path(path_var.clone());
    desktop.install_from_dir(&fixture("execution"), &Consent::all()).unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let project = project.canonicalize().unwrap();
    std::fs::write(project.join("execution.marker"), "").unwrap();
    let base = tmp.path().join("server");
    let peer_slot = Arc::new(OnceLock::new());
    let sink_peer = peer_slot.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |w| rpc::event_sink(sink_peer.clone(), Some(w.into()))),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let plugins = RemotePlugins::start(&base.join("data"), &host, peer_slot.clone()).unwrap();
    plugins.host().set_program_path(path_var);
    let mut dispatcher = Dispatcher::standard();
    plugins.register(&mut dispatcher);
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host, dispatcher, peer_slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let client = Arc::new(Client::default());
    let peer = Peer::connect(cr, cw, client.clone());
    let _: Value = peer.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None).await.unwrap();
    invoke(&peer, "open_project", json!({ "path": project })).await.unwrap();
    invoke(&peer, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();
    sync(&peer, &desktop, &[]).await;
    assert!(sync(&peer, &desktop, &["execution"]).await.failed.is_empty());
    invoke(
        &peer,
        "plugin_run_command",
        json!({"pluginId":"execution", "commandId":"target", "arg":null, "editor":null}),
    )
    .await
    .unwrap();
    invoke(
        &peer,
        "plugin_run_command",
        json!({"pluginId":"execution", "commandId":"target-overrides", "arg":"empty", "editor":null}),
    )
    .await
    .unwrap();
    let targets = invoke(&peer, "plugin_run_targets", json!({})).await.unwrap();
    assert_eq!(targets.as_array().unwrap().len(), 1);
    assert_eq!(targets[0]["pluginId"], "execution");
    assert_eq!(targets[0]["target"]["commands"][0]["workdirArgs"], json!([]));
    assert!(desktop.run_targets(&project).is_empty());
    let id = targets[0]["id"].as_str().unwrap();
    let settings = invoke(&peer, "plugin_answer_run_target", json!({"id":id, "useTarget":false})).await.unwrap();
    assert_eq!(settings["run"]["defaultTarget"], "");
    let config = json!({"id":"wrapped-php", "name":"Wrapped PHP", "kind":"php", "command":"php", "args":["x.php", "literal ; $(touch bad)"], "env":{}, "detected":false, "isTest":false, "target":id});
    invoke(&peer, "run_start", json!({"config":config, "onOutput":{"$channel":38}})).await.unwrap();
    let wrapped = "<wrapped>\n<--cwd=/container>\n<php>\n<x.php>\n<literal ; $(touch bad)>\n";
    until("remote wrapped run", 5, || std::fs::read_to_string(project.join("wrapped.txt")).is_ok_and(|s| s == wrapped))
        .await;
    assert!(!project.join("bad").exists());
    let composer = json!({"id":"composer", "name":"Composer", "kind":"shell", "command":"composer", "args":["install"], "env":{}, "detected":false, "isTest":false, "target":id});
    invoke(&peer, "run_start", json!({"config":composer, "onOutput":{"$channel":39}})).await.unwrap();
    until("remote composer override", 5, || {
        std::fs::read_to_string(project.join("composer.txt")).is_ok_and(|s| s == "<composer>\n<install>\n")
    })
    .await;
    invoke(
        &peer,
        "plugin_run_command",
        json!({"pluginId":"execution", "commandId":"untarget", "arg":null, "editor":null}),
    )
    .await
    .unwrap();
    assert_eq!(invoke(&peer, "plugin_run_targets", json!({})).await.unwrap(), json!([]));
    invoke(
        &peer,
        "plugin_run_command",
        json!({"pluginId":"execution", "commandId":"target", "arg":"refuse", "editor":null}),
    )
    .await
    .unwrap();
    let targets = invoke(&peer, "plugin_run_targets", json!({})).await.unwrap();
    let refused = targets[0]["id"].as_str().unwrap();
    std::fs::remove_file(project.join("wrapped.txt")).unwrap();
    let config = json!({"id":"refused", "name":"Refused", "kind":"shell", "command":"php", "args":[], "env":{}, "detected":false, "isTest":false, "target":refused});
    let error = invoke(&peer, "run_start", json!({"config":config, "onOutput":{"$channel":40}})).await.unwrap_err();
    assert!(error.to_string().contains("Project runtime is stopped"), "{error}");
    assert!(!project.join("wrapped.txt").exists());
    assert!(desktop.run_targets(&project).is_empty());
    invoke(
        &peer,
        "plugin_run_command",
        json!({"pluginId":"execution", "commandId":"untarget", "arg":"refuse", "editor":null}),
    )
    .await
    .unwrap();
    client.plugin_events.lock().clear();
    client.events.lock().clear();
    let runner = peer.clone();
    let run = tokio::spawn(async move {
        invoke(
            &runner,
            "plugin_run_command",
            json!({"pluginId": "execution", "commandId": "terminal", "arg": null, "editor": null}),
        )
        .await
        .unwrap()
    });
    until("terminal request", 5, || {
        client.plugin_events.lock().iter().any(|m| matches!(m.event, PluginEvent::WindowRequest { .. }))
    })
    .await;
    let (request_id, operation) = client
        .plugin_events
        .lock()
        .iter()
        .find_map(|m| match &m.event {
            PluginEvent::WindowRequest {
                request_id,
                request: ide_host::plugins::WindowRequest::Terminal { operation, .. },
                ..
            } => {
                assert_eq!(m.window.as_deref(), Some("main"));
                Some((request_id.clone(), operation.clone()))
            }
            _ => None,
        })
        .unwrap();
    let terminal = invoke(
        &peer,
        "plugin_terminal_session_spawn",
        json!({"operation": operation, "cols": 80, "rows": 24, "onOutput": {"$channel": 35}}),
    )
    .await
    .unwrap();
    assert!(terminal["id"].as_u64().is_some());
    assert!(
        invoke(
            &peer,
            "plugin_terminal_session_spawn",
            json!({"operation": operation, "cols": 80, "rows": 24, "onOutput": {"$channel": 36}})
        )
        .await
        .is_err()
    );
    invoke(
        &peer,
        "plugin_answer_command",
        json!({"requestId": request_id, "answer": {"kind": "value", "value": null}}),
    )
    .await
    .unwrap();
    assert_eq!(run.await.unwrap(), operation);
    invoke(
        &peer,
        "plugin_run_command",
        json!({"pluginId": "execution", "commandId": "write", "arg": "finished\n", "editor": null}),
    )
    .await
    .unwrap();
    until("PTY exit", 5, || client.events.lock().iter().any(|m| matches!(m.event, IdeEvent::TerminalExited { .. })))
        .await;
    plugins.host().flush_events_at(std::time::Instant::now() + Duration::from_secs(3));
    plugins.host().wait_events(Duration::from_secs(5));
    let received = invoke(
        &peer,
        "plugin_run_command",
        json!({"pluginId": "execution", "commandId": "events", "arg": null, "editor": null}),
    )
    .await
    .unwrap();
    let received: Value = serde_json::from_str(received.as_str().unwrap()).unwrap();
    assert_eq!(received.as_array().unwrap().len(), 1);
    assert_eq!(received[0]["kind"], "terminal-exited");
    let data: Value = serde_json::from_str(received[0]["data"].as_str().unwrap()).unwrap();
    assert_eq!(data["id"], operation);
    assert_eq!(data["status"], 0);
    assert_eq!(data["closed"], false);

    client.plugin_events.lock().clear();
    client.events.lock().clear();
    let runner = peer.clone();
    let run = tokio::spawn(async move {
        invoke(
            &runner,
            "plugin_run_command",
            json!({"pluginId": "execution", "commandId": "run", "arg": null, "editor": null}),
        )
        .await
        .unwrap()
    });
    until("run request", 5, || {
        client.plugin_events.lock().iter().any(|m| {
            matches!(&m.event, PluginEvent::WindowRequest { request: ide_host::plugins::WindowRequest::Run { .. }, .. })
        })
    })
    .await;
    let (request_id, operation, config) = client
        .plugin_events
        .lock()
        .iter()
        .find_map(|m| match &m.event {
            PluginEvent::WindowRequest {
                request_id,
                request: ide_host::plugins::WindowRequest::Run { operation, config, .. },
                ..
            } => Some((request_id.clone(), operation.clone(), config.clone())),
            _ => None,
        })
        .unwrap();
    let info = invoke(&peer, "run_start", json!({"config": config, "onOutput": {"$channel": 37}})).await.unwrap();
    invoke(
        &peer,
        "plugin_answer_command",
        json!({"requestId": request_id, "answer": {"kind": "value", "value": null}}),
    )
    .await
    .unwrap();
    assert_eq!(run.await.unwrap(), operation);
    invoke(&peer, "run_stdin", json!({"id": info["id"], "data": "finished\n"})).await.unwrap();
    until("run exit", 5, || client.events.lock().iter().any(|m| matches!(&m.event, IdeEvent::RunExited { .. }))).await;
    plugins.host().flush_events_at(std::time::Instant::now() + Duration::from_secs(3));
    plugins.host().wait_events(Duration::from_secs(5));
    let received = invoke(
        &peer,
        "plugin_run_command",
        json!({"pluginId": "execution", "commandId": "events", "arg": null, "editor": null}),
    )
    .await
    .unwrap();
    let received: Value = serde_json::from_str(received.as_str().unwrap()).unwrap();
    assert_eq!(received.as_array().unwrap().len(), 2);
    assert_eq!(received[1]["kind"], "run-exited");
    let data: Value = serde_json::from_str(received[1]["data"].as_str().unwrap()).unwrap();
    assert_eq!(data["id"], operation);
    assert_eq!(data["status"], 0);
    assert_eq!(data["killed"], false);
    plugins.host().shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn api14_database_sources_credentials_and_disable_lifetime_run_on_the_server() {
    ide_ssh::secrets::testing::use_memory_store();
    let tmp = tempfile::tempdir().unwrap();
    let id = "test.data-tools";
    let desktop =
        PluginHost::new(tmp.path().join("desktop/plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default())
            .unwrap();
    desktop.install_from_dir(&fixture("data-tools"), &Consent::all()).unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let project = project.canonicalize().unwrap();
    std::fs::write(project.join("data.sqlite"), "").unwrap();
    let base = tmp.path().join("server");
    let slot = Arc::new(OnceLock::new());
    let sink = slot.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("local"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |w| rpc::event_sink(sink.clone(), Some(w.into()))),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let plugins = RemotePlugins::start(&base.join("data"), &host, slot.clone()).unwrap();
    let mut dispatcher = Dispatcher::standard();
    plugins.register(&mut dispatcher);
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host.clone(), dispatcher, slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let client = Arc::new(Client::default());
    let peer = Peer::connect(cr, cw, client.clone());
    let _: Value = peer.request("initialize", json!({"version":rpc::PROTOCOL_VERSION}), None).await.unwrap();
    invoke(&peer, "open_project", json!({"path":project})).await.unwrap();
    invoke(&peer, "project_trust_set", json!({"path":project,"trusted":true,"folder":false})).await.unwrap();
    assert!(sync(&peer, &desktop, &[id]).await.failed.is_empty());
    let source =
        json!({"id":"local","name":"Remote local","driver":"sqlite","database":"data.sqlite","options":[]}).to_string();
    invoke(&peer, "plugin_run_command", json!({"pluginId":id,"commandId":"upsert","arg":source,"editor":null}))
        .await
        .unwrap();
    invoke(
        &peer,
        "plugin_run_command",
        json!({"pluginId":id,"commandId":"credential","arg":"server-only-secret","editor":null}),
    )
    .await
    .unwrap();
    let sources = invoke(&peer, "db_sources", json!({})).await.unwrap();
    assert_eq!(sources[0]["pluginOwner"], id);
    let internal = sources[0]["id"].as_str().unwrap();
    let store = ide_db::secrets::SecretStore::new(base.join("data/db-passwords.json"), &project);
    assert_eq!(store.get(internal).as_deref(), Some("server-only-secret"));
    until("database source change", 5, || {
        client.events.lock().iter().any(|m| matches!(m.event, IdeEvent::DbSourcesChanged))
    })
    .await;
    desktop.set_enabled(id, false).unwrap();
    let report = sync(&peer, &desktop, &[]).await;
    assert!(report.removed.is_empty());
    assert!(!invoke(&peer, "db_sources", json!({})).await.unwrap().as_array().unwrap().is_empty());
    desktop.set_enabled(id, true).unwrap();
    assert!(sync(&peer, &desktop, &[]).await.failed.is_empty());
    let runner = peer.clone();
    let connection = tokio::spawn(async move {
        invoke(
            &runner,
            "plugin_run_command",
            json!({"pluginId":"test.data-tools","commandId":"connect","arg":null,"editor":null}),
        )
        .await
    });
    until("database connect request", 5, || {
        client.plugin_events.lock().iter().any(|m| {
            matches!(
                m.event,
                PluginEvent::WindowRequest { request: ide_host::plugins::WindowRequest::DatabaseConnect { .. }, .. }
            )
        })
    })
    .await;
    let request = client
        .plugin_events
        .lock()
        .iter()
        .find_map(|m| match &m.event {
            PluginEvent::WindowRequest {
                request_id,
                request: ide_host::plugins::WindowRequest::DatabaseConnect { .. },
                ..
            } => Some(request_id.clone()),
            _ => None,
        })
        .unwrap();
    invoke(&peer, "db_connect", json!({"id":internal})).await.unwrap();
    invoke(&peer, "plugin_answer_command", json!({"requestId":request,"answer":{"kind":"value","value":null}}))
        .await
        .unwrap();
    connection.await.unwrap().unwrap();
    assert!(project.join("data.sqlite").exists());
    desktop.uninstall(id).unwrap();
    assert_eq!(sync(&peer, &desktop, &[]).await.removed, [id]);
    assert!(invoke(&peer, "db_sources", json!({})).await.unwrap().as_array().unwrap().is_empty());
    assert!(store.get(internal).is_none());
    plugins.host().shutdown();
}

async fn command_rpc_fixture() -> (tempfile::TempDir, Arc<RemotePlugins>, Peer, Arc<Client>) {
    let tmp = tempfile::tempdir().unwrap();
    let peer_slot = Arc::new(OnceLock::new());
    let host = Arc::new(Host::new(HostConfig {
        config_dir: tmp.path().join("config"),
        data_dir: tmp.path().join("data"),
        local_data_dir: tmp.path().join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(|_: IdeEvent| {})),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let plugins = RemotePlugins::start(&tmp.path().join("data"), &host, peer_slot.clone()).unwrap();
    plugins.host().install_from_dir(&fixture("misbehave"), &Consent::all()).unwrap();
    plugins.host().install_from_dir(&fixture("jobs"), &Consent::all()).unwrap();
    let mut dispatcher = Dispatcher::standard();
    plugins.register(&mut dispatcher);
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host, dispatcher, peer_slot, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let client = Arc::new(Client::default());
    let peer = Peer::connect(cr, cw, client.clone());
    let _: Value = peer.request("initialize", json!({ "version": rpc::PROTOCOL_VERSION }), None).await.unwrap();

    let project = tmp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    invoke(&peer, "open_project", json!({ "path": project })).await.unwrap();
    invoke(&peer, "project_trust_set", json!({ "path": project, "trusted": true, "folder": false })).await.unwrap();

    (tmp, plugins, peer, client)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_command_requests_do_not_activate_the_remote_plugin() {
    let (_tmp, plugins, peer, _client) = command_rpc_fixture().await;
    invoke(&peer, "cancel_request", json!({ "id": 91 })).await.unwrap();
    let error = invoke(
        &peer,
        "plugin_run_command",
        json!({ "pluginId": "misbehave", "commandId": "echo", "arg": "not delivered", "request": 91 }),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::Cancelled, "{error:?}");
    assert_eq!(plugins.host().info_of("misbehave").unwrap().status, PluginStatus::Inactive);
    let reply = invoke(
        &peer,
        "plugin_run_command",
        json!({ "pluginId": "misbehave", "commandId": "echo", "arg": "next request", "request": 92 }),
    )
    .await
    .unwrap();
    assert_eq!(reply, "next request");
    plugins.host().shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_a_running_remote_command_releases_its_prompt_and_command_lane() {
    let (_tmp, plugins, peer, client) = command_rpc_fixture().await;
    let pending = tokio::spawn({
        let peer = peer.clone();
        async move {
            invoke(&peer, "plugin_run_command", json!({ "pluginId": "jobs", "commandId": "input", "request": 93 }))
                .await
        }
    });
    until("the command's input prompt", 5, || {
        client.plugin_events.lock().iter().any(|event| matches!(event.event, PluginEvent::PromptRequested { .. }))
    })
    .await;
    invoke(&peer, "cancel_request", json!({ "id": 93 })).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), pending).await;
    if result.is_err() {
        plugins.host().cancel("jobs");
    }
    let error = result.expect("request cancellation must stop the running command").unwrap().unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::Cancelled, "{error:?}");
    assert_eq!(plugins.host().info_of("jobs").unwrap().stats.crashes, 0);
    assert_eq!(
        invoke(
            &peer,
            "plugin_run_command",
            json!({ "pluginId": "jobs", "commandId": "selection", "paths": ["/next/file"], "request": 94 }),
        )
        .await
        .unwrap(),
        "/next/file"
    );
    plugins.host().shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_one_request_does_not_interrupt_another_running_command() {
    let (_tmp, plugins, peer, client) = command_rpc_fixture().await;
    let active = tokio::spawn({
        let peer = peer.clone();
        async move {
            invoke(&peer, "plugin_run_command", json!({ "pluginId": "jobs", "commandId": "input", "request": 95 }))
                .await
        }
    });
    until("the active command's input prompt", 5, || {
        client.plugin_events.lock().iter().any(|event| matches!(event.event, PluginEvent::PromptRequested { .. }))
    })
    .await;
    let prompt = client
        .plugin_events
        .lock()
        .iter()
        .find_map(|message| match &message.event {
            PluginEvent::PromptRequested { prompt_id, .. } => Some(prompt_id.clone()),
            _ => None,
        })
        .unwrap();
    let cancelled = tokio::spawn({
        let peer = peer.clone();
        async move {
            invoke(&peer, "plugin_run_command", json!({ "pluginId": "jobs", "commandId": "selection", "request": 96 }))
                .await
        }
    });
    invoke(&peer, "cancel_request", json!({ "id": 96 })).await.unwrap();
    let error = tokio::time::timeout(Duration::from_secs(1), cancelled).await.unwrap().unwrap().unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::Cancelled);
    assert!(!active.is_finished(), "request cancellation must not cancel another invocation");
    assert_eq!(
        invoke(&peer, "plugin_answer_prompt", json!({ "promptId": prompt, "answer": ["kept running"] })).await.unwrap(),
        true
    );
    assert_eq!(tokio::time::timeout(Duration::from_secs(1), active).await.unwrap().unwrap().unwrap(), "kept running");
    assert_eq!(plugins.host().info_of("jobs").unwrap().stats.crashes, 0);
    plugins.host().shutdown();
}
