//! Real stdio transport through a target wrapper, without Docker or installed adapters.
#![cfg(unix)]
use ide_core::{SharedSink, path_mapping::PathMapping};
use ide_dap::{target::TargetMapping, *};
use ide_language::LanguageRegistry;
use std::{collections::BTreeMap, sync::Arc};

const ADAPTER: &str = include_str!("fixtures/target_adapter.py");

#[tokio::test]
async fn stdio_adapter_through_target_maps_launch_breakpoints_and_frames() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let adapter = root.join("adapter.py");
    std::fs::write(&adapter, ADAPTER).unwrap();
    let wrapper = root.join("wrapper");
    std::fs::write(&wrapper, "#!/bin/sh\nprintf '%s\\n' \"$@\" > wrapper-argv\nexec \"$@\"\n").unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let target = ide_core::remote_settings::PluginRunTarget {
        id: "fake".into(),
        name: "Fake".into(),
        program: "wrapper".into(),
        args: vec![],
        workdir_args: vec![],
        container_root: Some("/app".into()),
        commands: vec![],
    };
    // Keep the fixture adapter outside mapped argv; this is the container's executable.
    let run: ide_run::RunConfig = serde_json::from_value(serde_json::json!({"id":"adapter","name":"Adapter","kind":"shell","command":"/usr/bin/python3","args":["-u","-c",ADAPTER],"cwd":".","env":{},"detected":false,"isTest":false})).unwrap();
    let run = ide_remote::plugin_target::prepare(&root, &target, &wrapper, &run).unwrap();
    let manager = DebugManager::new(Arc::new(LanguageRegistry::load(None).unwrap()));
    manager
        .set_breakpoints(
            root.join("main.py"),
            vec![Breakpoint { line: 2, enabled: true, condition: None, hit_condition: None, log_message: None }],
        )
        .await
        .unwrap();
    let config = LaunchConfig {
        name: "Target".into(),
        adapter: "debugpy".into(),
        request: "launch".into(),
        program: Some(root.join("main.py").to_string_lossy().into_owned()),
        args: vec![],
        cwd: Some(root.clone().into()),
        env: BTreeMap::new(),
        extra_json: None,
    };
    let sink: SharedSink = Arc::new(|_| {});
    let mapping = TargetMapping {
        paths: PathMapping::new(&root.to_string_lossy(), "/app"),
        external_prefix: "openidea-target://fake/0/".into(),
    };
    let id = manager
        .start_prepared(
            config,
            SessionOwner::new("test", sink),
            |_| None,
            move |spec, _| {
                spec.command = run.command;
                spec.args = run.args;
                spec.cwd = root;
                spec.target = Some(mapping);
                Ok(())
            },
        )
        .await
        .unwrap();
    let frames = manager.stack_trace(id, 1).await.unwrap();
    assert_eq!(
        frames[0].path.as_ref().unwrap().to_string_lossy(),
        tmp.path().canonicalize().unwrap().join("main.py").to_string_lossy()
    );
    assert_eq!(frames[0].line, 2);
    assert!(std::fs::read_to_string(tmp.path().join("wrapper-argv")).unwrap().starts_with("python3\n-u\n-c\n"));
    manager.stop(id).await.unwrap();
}

#[tokio::test]
async fn host_adapter_accepts_connect_back_from_target_with_mapped_sources() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let port = ide_dap::adapter::free_port().unwrap();
    let manager = DebugManager::new(Arc::new(LanguageRegistry::load(None).unwrap()));
    manager
        .set_breakpoints(
            root.join("main.py"),
            vec![Breakpoint { line: 2, enabled: true, condition: None, hit_condition: None, log_message: None }],
        )
        .await
        .unwrap();
    let config = LaunchConfig {
        name: "Connect back".into(),
        adapter: "php-debug".into(),
        request: "launch".into(),
        program: None,
        args: vec![],
        cwd: Some(root.clone().into()),
        env: BTreeMap::new(),
        extra_json: Some(serde_json::json!({"port":port,"pathMappings":{"/app":"/app"}}).to_string()),
    };
    let sink: SharedSink = Arc::new(|_| {});
    let mapping = TargetMapping {
        paths: PathMapping::new(&root.to_string_lossy(), "/app"),
        external_prefix: "openidea-target://fake/0/".into(),
    };
    let id = manager
        .start_prepared(
            config,
            SessionOwner::new("test", sink),
            |_| None,
            move |spec, _| {
                spec.command = "/usr/bin/python3".into();
                spec.args = vec!["-u".into(), "-c".into(), ADAPTER.into()];
                spec.env.push(("FAKE_CONNECT_BACK".into(), "1".into()));
                spec.target = Some(mapping);
                Ok(())
            },
        )
        .await
        .unwrap();
    let code =
        format!("import socket;s=socket.create_connection(('127.0.0.1', {port}));s.sendall(b'/app/main.py');s.close()");
    let mut child = tokio::process::Command::new("/usr/bin/python3").args(["-c", &code]).spawn().unwrap();
    let frames = manager.stack_trace(id, 1).await.unwrap();
    assert_eq!(frames[0].path.as_ref().unwrap().to_path_buf(), root.join("main.py"));
    assert!(child.wait().await.unwrap().success());
    manager.stop(id).await.unwrap();
}
