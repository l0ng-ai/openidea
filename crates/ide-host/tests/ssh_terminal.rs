use ide_core::remote_settings::{SshAuth, SshConfiguration};
use ide_core::{IdeEvent, SharedSink};
use ide_host::{Host, HostConfig};
use ide_ssh::{SshFiles, SshManager};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

fn read_until(rx: &mpsc::Receiver<String>, needle: &str) -> String {
    let mut all = String::new();
    while !all.contains(needle) {
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(s) => all.push_str(&s),
            Err(_) => panic!("timed out waiting for {needle:?}; got {all:?}"),
        }
    }
    all
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_opens_a_shell_with_the_saved_password() {
    let tmp = tempfile::tempdir().unwrap();
    let port =
        ide_ssh::testing::sshd(tmp.path().join("server"), Arc::new(|cmd| panic!("unexpected exec: {cmd}"))).await;
    let ssh = Arc::new(SshManager::with_files(
        tmp.path().join("secrets.json"),
        SshFiles { known_hosts: tmp.path().join("known_hosts"), config: None },
    ));
    ssh.set_configs(vec![SshConfiguration {
        id: "box".into(),
        name: "Build box".into(),
        host: "127.0.0.1".into(),
        port: Some(port),
        user: "dev".into(),
        auth: SshAuth::Password,
        save_secret: true,
        ..Default::default()
    }]);
    ssh.set_secret("box", Some("secret".into()), true);
    assert!(ssh.session("box").await.is_err(), "unknown host key first");
    ssh.trust_host("box").await.unwrap();

    let (events_tx, events) = mpsc::channel();
    let events_tx = Mutex::new(events_tx);
    let sink: SharedSink = Arc::new(move |e: IdeEvent| {
        let _ = events_tx.lock().unwrap().send(e);
    });
    let base = tmp.path().join("app");
    let mut host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |_| sink.clone()),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    Arc::get_mut(&mut host).unwrap().ssh = ssh;

    let (tx, output) = mpsc::channel();
    let tx = Mutex::new(tx);
    let info = ide_host::ops::term::spawn_ssh(
        &host,
        "main",
        "box",
        100,
        30,
        Arc::new(move |s| {
            let _ = tx.lock().unwrap().send(s);
        }),
    )
    .await
    .unwrap();
    assert_eq!((info.title.as_str(), info.pid), ("Build box", None));
    assert!(read_until(&output, "$ ").contains("pty 100x30"));
    host.terminals.write(info.id, "hello ").unwrap();
    read_until(&output, "hello ");
    host.terminals.resize(info.id, 120, 40).unwrap();
    read_until(&output, "resized 120x40");
    host.terminals.write(info.id, "exit\r").unwrap();
    let code = loop {
        match events.recv_timeout(Duration::from_secs(10)).expect("exit event") {
            IdeEvent::TerminalExited { terminal, code } if terminal == info.id => break code,
            _ => {}
        }
    };
    assert_eq!(code, Some(0));
    assert!(!host.terminals.contains(info.id));

    // Closing the tab hangs up a running shell.
    let info = ide_host::ops::term::spawn_ssh(&host, "main", "box", 80, 24, Arc::new(|_| {})).await.unwrap();
    host.terminals.kill(info.id).unwrap();
    let code = loop {
        match events.recv_timeout(Duration::from_secs(10)).expect("exit event") {
            IdeEvent::TerminalExited { terminal, code } if terminal == info.id => break code,
            _ => {}
        }
    };
    assert_eq!(code, None);
    host.shutdown().await;
}
