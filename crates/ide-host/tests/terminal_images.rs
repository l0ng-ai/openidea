#![cfg(unix)]

use ide_core::{NullSink, TerminalId};
use ide_host::{Host, HostConfig, ops};
use ide_terminal::TerminalOptions;
use std::sync::Arc;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn storage_requires_a_registered_terminal() {
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("data");
    std::fs::create_dir(&data_dir).unwrap();
    let host = Host::new(HostConfig {
        config_dir: root.path().join("config"),
        data_dir: data_dir.clone(),
        local_data_dir: data_dir.clone(),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |window| window,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    assert!(ops::term::store_image(&host, TerminalId::next(), vec![1], "image/png".into()).await.is_err());
    assert!(!data_dir.join("terminal-images").exists());
    let terminal = host
        .terminals
        .spawn(
            TerminalOptions {
                cwd: root.path().into(),
                shell: Some("/bin/sh".into()),
                args: vec![],
                env: Default::default(),
                cols: 80,
                rows: 24,
                shell_integration: false,
            },
            Arc::new(NullSink),
            Box::new(|_| {}),
        )
        .unwrap();
    let path = ops::term::store_image(&host, terminal.id, vec![1, 2, 3], "image/png".into()).await.unwrap();
    assert_eq!(std::fs::read(path).unwrap(), [1, 2, 3]);
    host.terminals.kill(terminal.id).unwrap();
    assert!(ops::term::store_image(&host, terminal.id, vec![4], "image/png".into()).await.is_err());
    assert_eq!(std::fs::read_dir(data_dir.join("terminal-images")).unwrap().count(), 1);
}
