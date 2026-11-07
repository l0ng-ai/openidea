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

/// A debug adapter connection: just enough DAP to drive debugpy.
struct Dap {
    reader: std::io::BufReader<std::net::TcpStream>,
    writer: std::net::TcpStream,
    seq: i64,
}

impl Dap {
    fn connect(address: &str) -> Self {
        let stream = std::net::TcpStream::connect(address).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
        Self { reader: std::io::BufReader::new(stream.try_clone().unwrap()), writer: stream, seq: 0 }
    }

    fn send(&mut self, command: &str, arguments: serde_json::Value) {
        use std::io::Write;
        self.seq += 1;
        let body = serde_json::json!({"seq": self.seq, "type": "request", "command": command, "arguments": arguments})
            .to_string();
        write!(self.writer, "Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    }

    fn read(&mut self) -> serde_json::Value {
        use std::io::{BufRead, Read};
        let mut length = 0;
        loop {
            let mut line = String::new();
            assert!(self.reader.read_line(&mut line).unwrap() > 0, "the adapter closed the connection");
            let line = line.trim();
            if line.is_empty() {
                break;
            }
            if let Some(n) = line.strip_prefix("Content-Length:") {
                length = n.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        self.reader.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    /// Reads until a message of `kind` (`"response"` / `"event"`) named `name`.
    fn wait(&mut self, kind: &str, name: &str) -> serde_json::Value {
        loop {
            let m = self.read();
            let key = if kind == "event" { "event" } else { "command" };
            if m["type"] == kind && m[key] == name {
                return m;
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a Docker daemon, OPENIDEA_DOCKER_TEST_DIR, and pip to fetch debugpy"]
async fn debugs_python_in_a_container() {
    let root = PathBuf::from(std::env::var("OPENIDEA_DOCKER_TEST_DIR").expect("OPENIDEA_DOCKER_TEST_DIR"));
    // A project of its own: the other test may run at the same time.
    let root = dunce::canonicalize(root).unwrap().join("debug");
    std::fs::create_dir_all(&root).unwrap();
    let name = "debug";
    let main = root.join("main.py");
    std::fs::write(&main, "import os\nvalue = os.environ['GREETING']\nprint('value=' + value)\n").unwrap();
    // The IDE's state must be where the daemon can mount it (the bootstrap, the debugpy copy).
    let state = root.join(".state");
    let host = host(&state);
    // The IDE's copy, installed like the Tools page does (`ide_tools` `PipTarget`): the image has no debugpy.
    let lib = host.data_dir.join("tools/debugpy/lib");
    let pip = Command::new("python3")
        .args(["-m", "pip", "install", "--quiet", "--no-deps", "--target"])
        .arg(&lib)
        .args(["--only-binary=:all:", "--platform", "any", "--implementation", "py", "debugpy"])
        .status()
        .unwrap();
    assert!(pip.success());
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    let targets =
        serde_json::json!([{ "kind": "docker", "id": "py", "name": "Python", "image": "python:3.12-alpine" }]);
    ops::project::set_settings(
        &host,
        "main",
        ide_workspace::settings::SettingsScope::Project,
        "runTargets",
        &targets.to_string(),
    )
    .unwrap();

    let mut debug = config("debug-main", "py", &root, &[&main.to_string_lossy()]);
    debug.debug_adapter = Some("debugpy".into());
    debug.extras.params.insert("containerDebug".into(), "true".into());
    let (_, out) = start(&host, debug).await;
    let mut ready = None;
    for _ in 0..1200 {
        ready = out
            .lock()
            .lines()
            .find_map(|l| l.trim().strip_prefix(ide_remote::docker::DEBUG_READY).map(|rest| rest.to_owned()));
        if ready.is_some() || out.lock().contains("Process finished") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let ready = ready.unwrap_or_else(|| panic!("{}", out.lock()));
    let (port, folder) = ready.split_once(", project folder ").unwrap();
    assert_eq!(folder, format!("/workspaces/{name}"));
    let address = format!("{}:{port}", std::env::var("OPENIDEA_DOCKER_TEST_HOST").unwrap_or("127.0.0.1".into()));

    // Attach with the project mapped, stop at a breakpoint set on the local file, continue.
    let local = main.to_string_lossy().into_owned();
    let root_str = root.to_string_lossy().into_owned();
    let folder = folder.to_owned();
    let stopped_at = tokio::task::spawn_blocking(move || {
        let mut dap = Dap::connect(&address);
        dap.send(
            "initialize",
            serde_json::json!({"adapterID": "debugpy", "pathFormat": "path", "linesStartAt1": true}),
        );
        dap.wait("response", "initialize");
        dap.send(
            "attach",
            serde_json::json!({"justMyCode": true, "pathMappings": [{"localRoot": root_str, "remoteRoot": folder}]}),
        );
        dap.wait("event", "initialized");
        dap.send("setBreakpoints", serde_json::json!({"source": {"path": local}, "breakpoints": [{"line": 3}]}));
        let set = dap.wait("response", "setBreakpoints");
        assert_eq!(set["body"]["breakpoints"][0]["verified"], true, "{set}");
        dap.send("configurationDone", serde_json::json!({}));
        let stopped = dap.wait("event", "stopped");
        let thread = stopped["body"]["threadId"].clone();
        dap.send("stackTrace", serde_json::json!({"threadId": thread}));
        let frame = dap.wait("response", "stackTrace")["body"]["stackFrames"][0].clone();
        dap.send("continue", serde_json::json!({"threadId": thread}));
        dap.wait("response", "continue");
        (stopped["body"]["reason"].clone(), frame["source"]["path"].clone(), frame["line"].clone())
    })
    .await
    .unwrap();
    assert_eq!(stopped_at.0, "breakpoint");
    assert_eq!(stopped_at.1, main.to_string_lossy().as_ref(), "the container's path maps back to the project");
    assert_eq!(stopped_at.2, 3);
    let out = finished(&out, 60).await;
    assert!(out.contains("value=hello") && out.contains("exit code 0"), "{out}");
    assert_eq!(containers("label=openidea.run=debug-main"), "", "removed when the run ends");
    std::fs::remove_dir_all(&root).unwrap();
}
