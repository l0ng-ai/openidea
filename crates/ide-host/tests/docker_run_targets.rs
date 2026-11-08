//! Docker run targets through `ops::run::start`, with a stand-in `docker`
//! (`OPENIDEA_DOCKER`) that prints what it was given.
#![cfg(unix)]

use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use ide_run::{OutputChunk, RunConfig};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

fn host(base: &Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

fn config(target: &str, root: &Path) -> RunConfig {
    RunConfig {
        id: "app".into(),
        name: "app".into(),
        kind: "python".into(),
        command: root.join(".venv/bin/python").to_string_lossy().into_owned(),
        args: vec![root.join("main.py").to_string_lossy().into_owned()],
        cwd: None,
        env: BTreeMap::from([("DATA".to_owned(), root.join("data").to_string_lossy().into_owned())]),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: ide_run::RunExtras { target: Some(target.into()), ..Default::default() },
    }
}

async fn output_of(host: &Host, config: RunConfig) -> String {
    let out = Arc::new(Mutex::new(String::new()));
    let sink = out.clone();
    ops::run::start(
        host,
        "main",
        config,
        Arc::new(move |chunk| match chunk {
            OutputChunk::Stdout { text } | OutputChunk::Stderr { text } | OutputChunk::System { text } => {
                sink.lock().push_str(&text)
            }
        }),
    )
    .await
    .unwrap();
    for _ in 0..200 {
        if out.lock().contains("Process finished") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    out.lock().clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn docker_targets_run_through_the_docker_cli() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let docker = base.join("docker");
    std::fs::write(
        &docker,
        "#!/bin/sh\nif [ \"$1\" = context ]; then echo unix:///var/run/docker.sock; exit 0; fi\n\
         for a in \"$@\"; do echo \"arg:$a\"; done\necho \"DATA=$DATA\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
    // SAFETY: the only test of this binary, before any thread looks docker up.
    unsafe {
        std::env::set_var("OPENIDEA_DOCKER", &docker);
        std::env::remove_var("DOCKER_HOST");
    }

    let root = base.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    let host = host(&base.join("app"));
    std::fs::create_dir_all(&host.data_dir).unwrap();
    std::fs::write(
        host.data_dir.join("docker.json"),
        r#"{"connections": [{"id": "far", "name": "Build box", "endpoint": {"kind": "tcp", "host": "build:2376"}}]}"#,
    )
    .unwrap();
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    let targets = serde_json::json!([
        { "kind": "docker", "id": "py", "name": "Python", "image": "python:3.12" },
        { "kind": "docker", "id": "far", "name": "Far", "image": "python:3.12", "dockerConnection": "far" },
    ]);
    ops::project::set_settings(
        &host,
        "main",
        ide_workspace::settings::SettingsScope::Project,
        "runTargets",
        &targets.to_string(),
    )
    .unwrap();

    let out = output_of(&host, config("py", &root)).await;
    let args: Vec<&str> = out.lines().filter_map(|l| l.strip_prefix("arg:")).collect();
    assert_eq!(&args[..4], ["run", "--rm", "--interactive", "--init"], "{out}");
    assert!(args.contains(&format!("{}:/workspaces/proj", root.display()).as_str()), "{out}");
    assert!(args.ends_with(&["python:3.12", "python3", "/workspaces/proj/main.py"]), "{out}");
    assert!(out.contains("DATA=/workspaces/proj/data"), "{out}");
    assert!(!args.iter().any(|a| a.contains("/workspaces/proj/data")), "values stay out of the command line");

    // Debug: the program starts under the bootstrap, which waits for the debugger on a
    // port published on the loopback interface, with the IDE's debugpy mounted.
    let lib = host.data_dir.join("tools/debugpy/lib");
    std::fs::create_dir_all(lib.join("debugpy")).unwrap();
    std::fs::write(lib.join("debugpy/__init__.py"), "").unwrap();
    let mut debug = config("py", &root);
    debug.debug_adapter = Some("debugpy".into());
    debug.extras.params.insert("containerDebug".into(), "true".into());
    let out = output_of(&host, debug.clone()).await;
    let args: Vec<&str> = out.lines().filter_map(|l| l.strip_prefix("arg:")).collect();
    let publish = args[args.iter().position(|a| *a == "--publish").unwrap() + 1];
    let port = publish.strip_prefix("127.0.0.1:").and_then(|p| p.split_once(':')).unwrap();
    assert_eq!(port.0, port.1, "{out}");
    let bootstrap = host.data_dir.join("container-debug");
    assert!(args.contains(&format!("{}:/opt/openidea/debug:ro", bootstrap.display()).as_str()), "{out}");
    assert!(args.contains(&format!("{}:/opt/openidea/debugpy-lib:ro", lib.display()).as_str()), "{out}");
    assert_eq!(
        std::fs::read_to_string(bootstrap.join("openidea_debug.py")).unwrap(),
        ide_remote::docker::DEBUG_BOOTSTRAP
    );
    assert!(
        args.ends_with(&[
            "python:3.12",
            "python3",
            "/opt/openidea/debug/openidea_debug.py",
            port.0,
            "/workspaces/proj",
            "/workspaces/proj/main.py"
        ]),
        "{out}"
    );
    debug.debug_adapter = Some("delve".into());
    let err = ops::run::start(&host, "main", debug, Arc::new(|_| {})).await.unwrap_err();
    assert!(err.message.contains("only Python"), "{}", err.message);

    let err = ops::run::start(&host, "main", config("far", &root), Arc::new(|_| {})).await.unwrap_err();
    assert!(err.message.contains("another machine"), "{}", err.message);
}
