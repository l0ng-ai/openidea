//! A project's direnv environment through the host, with a stand-in `direnv` on `PATH`: it
//! runs in trusted projects only, reaches the children started in the project, loads again
//! on Reload Environment and goes with trust or the project.
//! One test in its own binary: it changes this process's `PATH`.
#![cfg(unix)]

use ide_core::event::DirenvStatus;
use ide_core::{EventSink, IdeEvent, SharedSink};
use ide_host::{Host, HostConfig};
use parking_lot::Mutex;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Default)]
struct Events(Mutex<Vec<IdeEvent>>);

impl EventSink for Events {
    fn emit(&self, e: IdeEvent) {
        self.0.lock().push(e);
    }
}

/// What a child started in `dir` now sees for `name`.
fn child_var(dir: &Path, name: &str) -> String {
    let out = ide_core::process::prepare(Command::new("/bin/sh").current_dir(dir))
        .args(["-c", &format!("printf %s \"${name}\"")])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap()
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn direnv_runs_in_trusted_projects_and_reaches_their_children() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = dunce::canonicalize(tmp.path()).unwrap();
    let bin = tmp.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // Logs each run to `runs` and prints `out.json`, or blocks like direnv on `.envrc` not allowed.
    let direnv = bin.join("direnv");
    std::fs::write(
        &direnv,
        "#!/bin/sh\necho run >> runs\n[ -f blocked ] && { echo \"direnv: error $PWD/.envrc is blocked. Run \\`direnv allow\\` to approve its content\" >&2; exit 1; }\ncat out.json\n",
    )
    .unwrap();
    std::fs::set_permissions(&direnv, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path =
        std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())))
            .unwrap();
    // SAFETY: no other thread runs yet.
    unsafe {
        std::env::set_var("PATH", path);
        // Reload Environment must not read this machine's login shell.
        std::env::set_var("OPENIDEA_SKIP_SHELL_ENV", "1");
    }

    let project = tmp.join("flake-project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join(".envrc"), "use flake\n").unwrap();
    std::fs::write(project.join("out.json"), r#"{"OPENIDEA_DEVSHELL":"one"}"#).unwrap();
    let runs = || std::fs::read_to_string(project.join("runs")).unwrap_or_default().lines().count();

    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let events = Arc::new(Events::default());
    let sink_events = events.clone();
    let base = tmp.join("host");
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |_| sink_events.clone() as SharedSink),
        owner: |w| w,
        runtime: runtime.handle().clone(),
        // The desktop: several projects in one process.
        project_environment: false,
    }));

    // Restricted Mode: `.envrc` is project code and doesn't run.
    host.trust.decide(&project, false, false).unwrap();
    runtime.block_on(ide_host::ops::project::open(&host, "main", &project)).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(runs(), 0);
    assert_eq!(child_var(&project, "OPENIDEA_DEVSHELL"), "");

    // Trusted: it loads, for children started in the project only.
    runtime.block_on(host.set_project_trust(&project, true, false)).unwrap();
    wait_for("the direnv environment", || child_var(&project.join("src"), "OPENIDEA_DEVSHELL") == "one");
    assert_eq!(runs(), 1);
    assert_eq!(child_var(&tmp, "OPENIDEA_DEVSHELL"), "", "outside the project");

    // Reload Environment loads it again.
    std::fs::write(project.join("out.json"), r#"{"OPENIDEA_DEVSHELL":"two"}"#).unwrap();
    let reloaded = runtime.block_on(ide_host::ops::env::env_reload(&host, "main")).unwrap();
    assert!(reloaded.changed.iter().any(|c| c == "OPENIDEA_DEVSHELL"), "{:?}", reloaded.changed);
    assert_eq!(child_var(&project, "OPENIDEA_DEVSHELL"), "two");

    // Blocked after an edit: said so, never allowed by the IDE, and the environment goes.
    std::fs::write(project.join("blocked"), "").unwrap();
    runtime.block_on(ide_host::ops::env::env_reload(&host, "main")).unwrap();
    assert!(
        events.0.lock().iter().any(|e| matches!(e, IdeEvent::Direnv { status: DirenvStatus::Blocked, .. })),
        "a blocked notice"
    );
    assert_eq!(child_var(&project, "OPENIDEA_DEVSHELL"), "");
    std::fs::remove_file(project.join("blocked")).unwrap();
    runtime.block_on(ide_host::ops::env::env_reload(&host, "main")).unwrap();
    assert_eq!(child_var(&project, "OPENIDEA_DEVSHELL"), "two");

    // Revoking trust drops it; so does closing the project.
    runtime.block_on(host.set_project_trust(&project, false, false)).unwrap();
    assert_eq!(child_var(&project, "OPENIDEA_DEVSHELL"), "");
    runtime.block_on(host.set_project_trust(&project, true, false)).unwrap();
    wait_for("the reloaded environment", || child_var(&project, "OPENIDEA_DEVSHELL") == "two");
    host.close_project("main");
    assert_eq!(child_var(&project, "OPENIDEA_DEVSHELL"), "");

    runtime.block_on(host.shutdown());
}
