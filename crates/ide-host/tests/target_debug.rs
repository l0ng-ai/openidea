//! Target debugging uses the same trusted plugin wrapper on desktop and the SSH server.
#![cfg(unix)]
use ide_core::IdeEvent;
use ide_host::{
    Host, HostConfig,
    plugins::{Consent, HostWorkspace, PluginEvent, PluginHost},
};
use ide_language::LanguageRegistry;
use ide_plugin::{Invocation, Limits};
use parking_lot::Mutex;
use serde_json::json;
use std::{os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc};
#[tokio::test(flavor = "multi_thread")]
async fn registered_target_debugs_over_stdio_and_rechecks_program_grant() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir(&root).unwrap();
    let adapter = base.join("adapter.py");
    std::fs::write(&adapter, include_str!("../../ide-dap/tests/fixtures/target_adapter.py")).unwrap();
    let wrapper = base.join("wrapper");
    std::fs::write(
        &wrapper,
        format!(
            r#"#!/bin/sh
[ "$1" = wrapped ] && [ "$2" = --cwd=/container ] || exit 91
shift 2
if [ "$1" = cat ]; then exec cat "$2" "$3"; fi
export FAKE_ROOT=/container
exec /usr/bin/python3 -u '{}'
"#,
            adapter.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = events.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("local"),
        languages: Arc::new(LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |_| {
            let e = sink_events.clone();
            Arc::new(move |event: IdeEvent| e.lock().push(event))
        }),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    host.open_project("main", &root).unwrap();
    host.set_project_trust(&root, true, false).await.unwrap();
    let plugins = Arc::new(
        PluginHost::new(base.join("plugins"), Arc::new(|_: Option<&str>, _: PluginEvent| {}), Limits::default())
            .unwrap(),
    );
    plugins.set_workspace(Some(Arc::new(HostWorkspace(Arc::downgrade(&host)))));
    host.set_plugin_host(&plugins);
    let package = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/execution");
    plugins.install_from_dir(&package, &Consent::all()).unwrap();
    plugins.choose_program("execution", "process:execution-tool", Some(&root), Some(&wrapper)).unwrap();
    let invocation =
        || Invocation { client: Some("main".into()), workspace_root: Some(root.clone()), ..Default::default() };
    plugins.run_command("execution", "target", None, invocation()).unwrap();
    let id = plugins.run_targets(&root)[0].id.clone();
    let launch: ide_dap::LaunchConfig=serde_json::from_value(json!({"name":"Fake target","adapter":"debugpy","request":"launch","program":root.join("main.py"),"args":[],"cwd":root,"env":{},"extraJson":json!({"__runTarget":id}).to_string()})).unwrap();
    host.debugger
        .set_breakpoints(
            root.join("main.py"),
            vec![ide_dap::Breakpoint {
                line: 2,
                enabled: true,
                condition: None,
                hit_condition: None,
                log_message: None,
            }],
        )
        .await
        .unwrap();
    let session = ide_host::ops::debug::debug_start(&host, "main", launch.clone()).await.unwrap();
    let frames = host.debugger.stack_trace(session, 1).await.unwrap();
    assert_eq!(frames[0].path.as_ref().unwrap().to_path_buf(), root.join("main.py"));
    host.debugger.stop(session).await.unwrap();
    // External debug sources use the container reader even with no LSP running.
    let library = base.join("library.py");
    std::fs::write(&library, "container library").unwrap();
    let uri = format!(
        "openidea-target://{}/0/{}",
        percent_encoding::utf8_percent_encode(&id, percent_encoding::NON_ALPHANUMERIC),
        library.to_string_lossy().trim_start_matches('/')
    );
    let doc = ide_host::ops::doc::doc_open_virtual(&host, "main", uri).await.unwrap();
    assert!(doc.read_only);
    assert_eq!(doc.text, "container library");

    std::fs::write(&wrapper, "#!/bin/sh\nexit 99\n").unwrap();
    let error = ide_host::ops::debug::debug_start(&host, "main", launch).await.unwrap_err();
    assert!(error.message.contains("changed") || error.message.contains("approved"), "{error:?}");
    host.close_project("main");
}
