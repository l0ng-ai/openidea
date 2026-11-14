//! A Compose run target as the Python interpreter, against a real daemon and the real
//! basedpyright. Ignored by default: `OPENIDEA_DOCKER_TEST_DIR` names an empty folder the
//! daemon can bind-mount (on this machine, or at the same path in a VM such as OrbStack's),
//! `docker` with the Compose plugin and `basedpyright-langserver` must be on `PATH`, and
//! this machine's Python must not have Django installed.
#![cfg(unix)]

use ide_core::IdeEvent;
use ide_host::{Host, HostConfig, ops};
use ide_run::{OutputChunk, RunConfig};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const WINDOW: &str = "main";
type Events = Arc<Mutex<Vec<IdeEvent>>>;

fn host(base: &Path, events: &Events) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new({
            let events = events.clone();
            move |_| {
                let events = events.clone();
                Arc::new(move |e: IdeEvent| events.lock().unwrap().push(e))
            }
        }),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

/// basedpyright's latest diagnostics of `path` once `done` accepts them.
async fn diagnostics(events: &Events, path: &Path, timeout: Duration, done: impl Fn(&[String]) -> bool) -> Vec<String> {
    let deadline = Instant::now() + timeout;
    loop {
        let latest = events.lock().unwrap().iter().rev().find_map(|e| match e {
            IdeEvent::Diagnostics { path: p, items, source } if **p == *path && source.contains("basedpyright") => {
                Some(items.iter().map(|d| d.message.clone()).collect::<Vec<_>>())
            }
            _ => None,
        });
        if let Some(messages) = &latest
            && done(messages)
        {
            return messages.clone();
        }
        assert!(Instant::now() < deadline, "timed out; last diagnostics: {latest:?}");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn unresolved(messages: &[String]) -> bool {
    messages.iter().any(|m| m.contains("\"django") && m.contains("could not be resolved"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a Docker daemon, basedpyright and OPENIDEA_DOCKER_TEST_DIR"]
async fn compose_target_is_the_python_interpreter() {
    let root = PathBuf::from(std::env::var("OPENIDEA_DOCKER_TEST_DIR").expect("OPENIDEA_DOCKER_TEST_DIR"));
    let root = dunce::canonicalize(root).unwrap();
    let files = [
        ("compose.yaml", "services:\n  web:\n    build: .\n    volumes:\n      - .:/app\n    working_dir: /app\n"),
        (
            "Dockerfile",
            "FROM python:3.12-slim\nCOPY requirements.txt /tmp/requirements.txt\n\
             RUN pip install --no-cache-dir -r /tmp/requirements.txt\n",
        ),
        ("requirements.txt", "Django==5.1.3\n"),
        (
            "app/main.py",
            "import django\nfrom django.http import HttpResponse\n\nprint(django.get_version(), HttpResponse)\n",
        ),
    ];
    for (path, text) in files {
        std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
        std::fs::write(root.join(path), text).unwrap();
    }
    let main = root.join("app/main.py");
    let state = tempfile::tempdir().unwrap();
    let events: Events = Arc::default();
    let host = host(state.path(), &events);
    host.trust.decide(&root, true, false).unwrap();
    host.open_project(WINDOW, &root).unwrap();
    let set = |key: &str, value: serde_json::Value| {
        ops::project::set_settings(
            &host,
            WINDOW,
            ide_workspace::settings::SettingsScope::Project,
            key,
            &value.to_string(),
        )
        .unwrap();
    };
    set("runTargets", serde_json::json!([{ "kind": "compose", "id": "web", "name": "Compose web", "service": "web" }]));

    // A local interpreter: Django is only in the image.
    ops::doc::open(&host, WINDOW, main.clone()).await.unwrap();
    let before = diagnostics(&events, &main, Duration::from_secs(120), unresolved).await;
    eprintln!("local interpreter: {before:?}");

    // The run target as the interpreter: a snapshot is taken in the background, then the
    // server restarts with the copied site-packages as `extraPaths`.
    set("languages.python.interpreter", serde_json::json!("target:web"));
    let after = diagnostics(&events, &main, Duration::from_secs(900), |m| !unresolved(m)).await;
    eprintln!("run target interpreter: {after:?}");
    assert!(after.iter().all(|m| !m.contains("could not be resolved")), "{after:?}");

    let info = ops::sdk::sdk_container_python(&host, WINDOW).unwrap().expect("a run target interpreter");
    eprintln!("snapshot: version {:?}, image {:?}, folders {:?}", info.version, info.image, info.folders);
    assert_eq!(info.name, "Compose web");
    assert!(info.version.as_deref().is_some_and(|v| v.starts_with("3.12.")), "{info:?}");
    assert!(info.packages.iter().any(|p| p.name == "Django" && p.version == "5.1.3"), "{:?}", info.packages);
    let site = info.folders.iter().find(|f| f.0.ends_with("site-packages")).expect("site-packages copied");
    assert!(site.0.join("django/__init__.py").is_file());
    assert!(site.0.starts_with(state.path().join("data/container-python")), "{site:?}");
    let servers = ops::lsp::lsp_servers(&host, WINDOW).unwrap();
    eprintln!("servers: {:?}", servers.iter().map(|s| (&s.name, s.status)).collect::<Vec<_>>());

    // Run: a Python configuration without its own target runs in the container.
    let out = Arc::new(Mutex::new(String::new()));
    let sink = out.clone();
    let config = RunConfig {
        id: "main".into(),
        name: "main".into(),
        kind: "python".into(),
        command: "python3".into(),
        args: vec!["app/main.py".into()],
        cwd: None,
        env: Default::default(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    ops::run::start(
        &host,
        WINDOW,
        config,
        Arc::new(move |chunk| match chunk {
            OutputChunk::Stdout { text } | OutputChunk::Stderr { text } | OutputChunk::System { text } => {
                sink.lock().unwrap().push_str(&text)
            }
        }),
    )
    .await
    .unwrap();
    for _ in 0..1200 {
        if out.lock().unwrap().contains("Process finished") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let out = out.lock().unwrap().clone();
    eprintln!("run output: {out}");
    assert!(out.contains("5.1.3") && out.contains("exit code 0"), "{out}");

    // Refresh takes a new snapshot of the same image; nothing is left running.
    let refreshed = ops::sdk::sdk_container_python_refresh(&host, WINDOW).await.unwrap().unwrap();
    assert_eq!(refreshed.image, info.image);
    let probes = Command::new("docker")
        .args(["ps", "--all", "--quiet", "--filter", "label=openidea.python-probe=true"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&probes.stdout).trim(), "", "probe containers are removed");
    Command::new("docker").args(["compose", "down", "--rmi", "local"]).current_dir(&root).status().unwrap();
}
