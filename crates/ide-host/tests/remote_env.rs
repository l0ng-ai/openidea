//! The remote server's environment: the login shell read afresh on every start, the
//! project's `devcontainer.json` (`remoteEnv`, `postStartCommand`) and Reload Environment.
//! One test in its own binary: it changes this process's environment.
#![cfg(unix)]

use ide_core::event::NotifyLevel;
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

/// What a child process started now sees for `name`.
fn child_var(name: &str) -> String {
    let out = ide_core::process::prepare(&mut Command::new("/bin/sh"))
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

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn server_environment_from_login_shell_and_devcontainer() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = dunce::canonicalize(tmp.path()).unwrap();
    // A stand-in login shell that sources `rc`, as an rc file would be.
    let rc = tmp.join("rc");
    let shell = tmp.join("shell");
    write(&shell, &format!("#!/bin/sh\n. {}\nshift\nexec /bin/sh -c \"$1\"\n", rc.display()));
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
    // SAFETY: no other thread runs yet.
    unsafe {
        std::env::set_var("SHELL", &shell);
        // The PATH cache goes under the temporary home.
        std::env::set_var("HOME", tmp.join("home"));
        std::env::set_var("XDG_CACHE_HOME", tmp.join("home/.cache"));
        std::env::remove_var("OPENIDEA_SKIP_SHELL_ENV");
    }

    // Two server starts: each reads the login shell again (not the cached PATH).
    write(&rc, "export OPENIDEA_RC_VAR=one\nexport PATH=/start-one/bin:/usr/bin:/bin\n");
    ide_host::shell_env::inherit_login_shell_env("openidea-server-test");
    assert_eq!(std::env::var("OPENIDEA_RC_VAR").unwrap(), "one");
    write(&rc, "export OPENIDEA_RC_VAR=two\nexport PATH=/start-two/bin:/usr/bin:/bin\n");
    ide_host::shell_env::inherit_login_shell_env("openidea-server-test");
    assert_eq!(std::env::var("OPENIDEA_RC_VAR").unwrap(), "two");
    assert!(std::env::var("PATH").unwrap().starts_with("/start-two/bin:"), "{:?}", std::env::var("PATH"));
    let base = tmp.join("server");
    ide_tools::extend_process_path(&base.join("data"));

    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let events = Arc::new(Events::default());
    let sink_events = events.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |_| sink_events.clone() as SharedSink),
        owner: |w| w,
        runtime: runtime.handle().clone(),
        project_environment: true,
    }));
    assert!(ide_host::rpc::Dispatcher::standard().commands().contains(&"env_reload"));

    let project = tmp.join("demo");
    write(
        &project.join(".devcontainer/devcontainer.json"),
        r#"{
            // remoteEnv sees the login shell's variables
            "remoteEnv": {
                "FROM_PROJECT": "${containerEnv:OPENIDEA_RC_VAR}-${localWorkspaceFolderBasename}",
                "PATH": "/project/bin:${containerEnv:PATH}",
            },
            "postStartCommand": ["/bin/sh", "-c", "echo \"$FROM_PROJECT\" >> started.txt; echo post-start-output"],
        }"#,
    );
    runtime.block_on(ide_host::ops::project::open(&host, "main", &project)).unwrap();
    assert_eq!(child_var("FROM_PROJECT"), "two-demo");
    assert!(child_var("PATH").starts_with("/project/bin:"), "{}", child_var("PATH"));
    assert_eq!(child_var("OPENIDEA_RC_VAR"), "two");
    // PTY spawners (terminals, runs in a terminal) take the same variables.
    assert!(ide_core::process::host_env_fixes().iter().any(|(k, v)| k == "FROM_PROJECT" && v.is_some()));
    let started = project.join("started.txt");
    wait_for("postStartCommand", || std::fs::read_to_string(&started).is_ok_and(|s| s.ends_with('\n')));
    assert_eq!(std::fs::read_to_string(&started).unwrap(), "two-demo\n");
    wait_for("postStartCommand to end", || {
        events
            .0
            .lock()
            .iter()
            .any(|e| matches!(e, IdeEvent::Task { title, done: true, .. } if title == "postStartCommand"))
    });
    assert!(events.0.lock().iter().any(
        |e| matches!(e, IdeEvent::Task { message: Some(m), title, .. } if m == "post-start-output" && title == "postStartCommand")
    ));

    // Reload Environment: the edited rc file and the project file apply to new children.
    write(&rc, "export OPENIDEA_RC_VAR=three\nexport OPENIDEA_RC_NEW=new\nexport PATH=/start-two/bin:/usr/bin:/bin\n");
    let reloaded = runtime.block_on(ide_host::ops::env::reload(&host, "main")).unwrap();
    assert!(reloaded.shell_read);
    for name in ["FROM_PROJECT", "OPENIDEA_RC_NEW", "OPENIDEA_RC_VAR"] {
        assert!(reloaded.changed.iter().any(|c| c == name), "{name} in {:?}", reloaded.changed);
    }
    assert!(!reloaded.changed.iter().any(|c| c == "PATH"), "{:?}", reloaded.changed);
    assert!(reloaded.devcontainer.as_deref().is_some_and(|p| p.ends_with("devcontainer.json")));
    assert_eq!(child_var("OPENIDEA_RC_VAR"), "three");
    assert_eq!(child_var("OPENIDEA_RC_NEW"), "new");
    assert_eq!(child_var("FROM_PROJECT"), "three-demo");
    // This process keeps its own environment; only children change.
    assert_eq!(std::env::var("OPENIDEA_RC_VAR").unwrap(), "two");

    // A variable the rc file stops exporting goes away for new children, whether this
    // process started with it or a reload added it.
    write(&rc, "export PATH=/start-two/bin:/usr/bin:/bin\n");
    let reloaded = runtime.block_on(ide_host::ops::env::reload(&host, "main")).unwrap();
    for name in ["FROM_PROJECT", "OPENIDEA_RC_NEW", "OPENIDEA_RC_VAR"] {
        assert!(reloaded.changed.iter().any(|c| c == name), "{name} in {:?}", reloaded.changed);
    }
    assert_eq!(child_var("OPENIDEA_RC_NEW"), "");
    assert_eq!(child_var("OPENIDEA_RC_VAR"), "");
    assert_eq!(child_var("FROM_PROJECT"), "-demo");

    // The shell starts from the environment this process started with: an rc file that
    // prepends to PATH does so once, however often it is reloaded.
    write(&rc, "export PATH=/prepended/bin:$PATH\n");
    let first = runtime.block_on(ide_host::ops::env::reload(&host, "main")).unwrap();
    assert!(first.changed.iter().any(|c| c == "PATH"), "{:?}", first.changed);
    let again = runtime.block_on(ide_host::ops::env::reload(&host, "main")).unwrap();
    assert!(again.changed.is_empty(), "{:?}", again.changed);
    assert_eq!(child_var("PATH").matches("/prepended/bin").count(), 1, "{}", child_var("PATH"));

    // Reopening the project doesn't run postStartCommand again (once per server start).
    host.close_project("main");
    assert_eq!(child_var("FROM_PROJECT"), "", "remoteEnv leaves with the project");
    runtime.block_on(ide_host::ops::project::open(&host, "main", &project)).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(std::fs::read_to_string(&started).unwrap(), "two-demo\n");

    // A failing postStartCommand is a notification; the project opens regardless.
    let failing = tmp.join("failing");
    write(&failing.join(".devcontainer.json"), r#"{ "postStartCommand": "echo oops >&2; exit 7" }"#);
    runtime.block_on(ide_host::ops::project::open(&host, "main", &failing)).unwrap();
    wait_for("the failure notification", || {
        events.0.lock().iter().any(|e| {
            matches!(e, IdeEvent::Notify { level: NotifyLevel::Error, title, body: Some(b) }
                if title == "postStartCommand failed" && b.contains("exited with code 7") && b.contains("oops"))
        })
    });

    // A broken file is a warning, not an error.
    let broken = tmp.join("broken");
    write(&broken.join(".devcontainer.json"), "{ \"remoteEnv\": ");
    runtime.block_on(ide_host::ops::project::open(&host, "main", &broken)).unwrap();
    assert!(events.0.lock().iter().any(|e| matches!(e,
        IdeEvent::Notify { level: NotifyLevel::Warning, title, .. } if title == "devcontainer.json was not applied")));

    runtime.block_on(host.shutdown());
}
