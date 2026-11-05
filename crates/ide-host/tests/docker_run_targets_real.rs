//! Docker and Compose run targets against a real daemon. Ignored by default:
//! `OPENIDEA_DOCKER_TEST_DIR` names an empty folder the daemon can bind-mount
//! (on this machine, or at the same path in a VM such as OrbStack's), and
//! `docker` with the Compose plugin must be on `PATH`.
#![cfg(unix)]

use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use ide_run::{OutputChunk, RunConfig};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
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

fn config(id: &str, target: &str, root: &Path, args: &[&str]) -> RunConfig {
    RunConfig {
        id: id.into(),
        name: id.into(),
        kind: "python".into(),
        command: root.join(".venv/bin/python").to_string_lossy().into_owned(),
        args: args.iter().map(|a| a.to_string()).collect(),
        cwd: None,
        env: BTreeMap::from([("GREETING".to_owned(), "hello".to_owned())]),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: ide_run::RunExtras { target: Some(target.into()), ..Default::default() },
    }
}

type Output = Arc<Mutex<String>>;

async fn start(host: &Host, config: RunConfig) -> (ide_core::RunId, Output) {
    let out: Output = Arc::default();
    let sink = out.clone();
    let info = ops::run::start(
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
    (info.id, out)
}

async fn finished(out: &Output, secs: u64) -> String {
    for _ in 0..secs * 10 {
        if out.lock().contains("Process finished") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    out.lock().clone()
}

fn containers(label: &str) -> String {
    let out = Command::new("docker").args(["ps", "--all", "--quiet", "--filter", label]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a Docker daemon and OPENIDEA_DOCKER_TEST_DIR"]
async fn runs_in_docker_and_compose_containers() {
    let root = PathBuf::from(std::env::var("OPENIDEA_DOCKER_TEST_DIR").expect("OPENIDEA_DOCKER_TEST_DIR"));
    let root = dunce::canonicalize(root).unwrap();
    let name = root.file_name().unwrap().to_string_lossy().into_owned();
    std::fs::write(
        root.join("main.py"),
        "import os\nprint('cwd=' + os.getcwd())\nprint('GREETING=' + os.environ['GREETING'])\n\
         open('out.txt', 'w').write('ok')\n",
    )
    .unwrap();
    std::fs::write(
        root.join("compose.yaml"),
        "services:\n  app:\n    image: python:3.12-alpine\n    volumes:\n      - .:/app\n",
    )
    .unwrap();
    let state = tempfile::tempdir().unwrap();
    let host = host(state.path());
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    let targets = serde_json::json!([
        { "kind": "docker", "id": "py", "name": "Python", "image": "python:3.12-alpine" },
        { "kind": "compose", "id": "app", "name": "Compose", "service": "app" },
    ]);
    ops::project::set_settings(
        &host,
        "main",
        ide_workspace::settings::SettingsScope::Project,
        "runTargets",
        &targets.to_string(),
    )
    .unwrap();

    let (_, out) = start(&host, config("docker-main", "py", &root, &[&root.join("main.py").to_string_lossy()])).await;
    let out = finished(&out, 120).await;
    assert!(out.contains(&format!("cwd=/workspaces/{name}")), "{out}");
    assert!(out.contains("GREETING=hello") && out.contains("exit code 0"), "{out}");
    let written = root.join("out.txt");
    assert_eq!(std::fs::read_to_string(&written).unwrap(), "ok");
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let (file, folder) = (std::fs::metadata(&written).unwrap(), std::fs::metadata(&root).unwrap());
        assert_eq!((file.uid(), file.gid()), (folder.uid(), folder.gid()), "written as the folder's owner");
    }
    std::fs::remove_file(&written).unwrap();
    assert_eq!(containers("label=openidea.run=docker-main"), "", "removed when the run ends");

    let (_, out) = start(&host, config("compose-main", "app", &root, &["main.py"])).await;
    let out = finished(&out, 120).await;
    assert!(out.contains("cwd=/app") && out.contains("GREETING=hello") && out.contains("exit code 0"), "{out}");
    std::fs::remove_file(&written).unwrap();

    // Stop: `docker stop` ends the container; `--rm` removes it.
    let (id, out) =
        start(&host, config("sleep", "py", &root, &["-c", "print('up', flush=True); import time; time.sleep(600)"]))
            .await;
    for _ in 0..600 {
        if out.lock().contains("up\n") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_ne!(containers("label=openidea.run=sleep"), "", "{}", out.lock());
    ops::run::stop(&host, "main", id).unwrap();
    let out = finished(&out, 30).await;
    assert!(out.contains(" stop openidea-sleep-"), "{out}");
    for _ in 0..100 {
        if containers("label=openidea.run=sleep").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(containers("label=openidea.run=sleep"), "", "{out}");
    Command::new("docker").args(["compose", "down"]).current_dir(&root).status().unwrap();
}
