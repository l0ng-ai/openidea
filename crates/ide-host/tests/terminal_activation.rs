//! Own test process: the inherited shell deliberately differs from the login shell.
#![cfg(unix)]

use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn terminal_activation_uses_the_resolved_default_shell() {
    // SAFETY: no runtime or worker threads have been started.
    unsafe { std::env::set_var("SHELL", "/not-the-terminal/docker") };
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    let bin = root.join(".venv/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(root.join(".venv/pyvenv.cfg"), "home = /usr/bin\n").unwrap();
    std::fs::write(bin.join("python"), "").unwrap();
    for script in ["activate", "activate.fish", "activate.csh", "activate.nu", "Activate.ps1"] {
        std::fs::write(bin.join(script), "echo activated > activation.marker\n").unwrap();
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    runtime.block_on(async {
        let host = Arc::new(Host::new(HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        host.trust.decide(&root, true, false).unwrap();
        host.open_project("main", &root).unwrap();
        for shell in [None, Some("".to_owned()), Some(" \t ".to_owned())] {
            let terminal = ops::term::spawn(
                &host,
                "main",
                ide_terminal::TerminalOptions {
                    cwd: root.clone().into(),
                    shell,
                    args: vec![],
                    env: Default::default(),
                    cols: 80,
                    rows: 24,
                    shell_integration: false,
                },
                Arc::new(|_| {}),
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !std::fs::read_to_string(root.join("activation.marker")).is_ok_and(|s| s.trim() == "activated") {
                assert!(Instant::now() < deadline, "default terminal shell must run the activation script");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            host.terminals.kill(terminal.id).unwrap();
            std::fs::remove_file(root.join("activation.marker")).unwrap();
        }
        host.shutdown().await;
    });
}
