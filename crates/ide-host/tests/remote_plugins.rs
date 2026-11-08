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

    // Disabled on the desktop: gone from the server.
    desktop.set_enabled("openidea.checkstyle", false).unwrap();
    let removed = sync(&peer, &desktop, &[]).await;
    assert_eq!(removed.removed, ["openidea.checkstyle"]);
    assert!(plugins.host().info_of("openidea.checkstyle").is_err());
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
