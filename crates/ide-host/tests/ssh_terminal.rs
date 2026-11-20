use ide_core::remote_settings::{SshAuth, SshConfiguration};
use ide_core::{IdeEvent, SharedSink};
use ide_docker::DockerEndpoint;
use ide_host::ops::docker;
use ide_host::{Host, HostConfig};
use ide_ssh::{SshFiles, SshManager};
use std::path::Path;
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

/// A host whose SSH configuration `box` reaches an in-process server answering `exec`.
async fn host_with_ssh_box(tmp: &Path, exec: ide_ssh::testing::ExecFn) -> (Arc<Host>, mpsc::Receiver<IdeEvent>) {
    let port = ide_ssh::testing::sshd(tmp.join("server"), exec).await;
    let ssh = Arc::new(SshManager::with_files(
        tmp.join("secrets.json"),
        SshFiles { known_hosts: tmp.join("known_hosts"), config: None },
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
    let base = tmp.join("app");
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

    (host, events)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_opens_a_shell_with_the_saved_password() {
    let tmp = tempfile::tempdir().unwrap();
    let (host, events) = host_with_ssh_box(tmp.path(), Arc::new(|cmd| panic!("unexpected exec: {cmd}"))).await;

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

/// Reads what a connection to the local end of a Docker tunnel gets back.
async fn dial(port: u16) -> std::io::Result<String> {
    use tokio::io::AsyncReadExt;
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    let mut out = String::new();
    socket.read_to_string(&mut out).await?;
    Ok(out)
}

fn tunnel_port(endpoint: &DockerEndpoint) -> u16 {
    let DockerEndpoint::Tcp { host, .. } = endpoint else { panic!("not a tunnel: {endpoint:?}") };
    host.rsplit(':').next().unwrap().parse().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnecting_a_docker_connection_closes_its_tunnel_and_unused_ssh_session() {
    let tmp = tempfile::tempdir().unwrap();
    let (host, _events) = host_with_ssh_box(
        tmp.path(),
        Arc::new(|cmd| match cmd {
            "docker version --format {{.Client.Version}}" => ("27.0.3\n".into(), 0),
            "docker system dial-stdio" => ("daemon".into(), 0),
            other => panic!("unexpected exec: {other}"),
        }),
    )
    .await;
    let ssh = DockerEndpoint::Ssh { config: "box".into() };

    let port = tunnel_port(&docker::resolve(&host, ssh.clone()).await.unwrap());
    assert_eq!(dial(port).await.unwrap(), "daemon");
    assert_eq!(host.ssh.connected(), ["box"]);

    docker::disconnect(&host, &ssh).await;
    assert!(dial(port).await.is_err(), "the tunnel stopped listening");
    assert!(host.ssh.connected().is_empty(), "nothing else used the SSH connection");

    // Connecting again opens a new tunnel; a terminal on the same host keeps the session open.
    let port = tunnel_port(&docker::resolve(&host, ssh.clone()).await.unwrap());
    assert_eq!(dial(port).await.unwrap(), "daemon");
    let terminal = host.ssh.session("box").await.unwrap();
    docker::disconnect(&host, &ssh).await;
    assert!(dial(port).await.is_err());
    assert_eq!(host.ssh.connected(), ["box"]);
    assert!(!terminal.is_closed());

    // Nothing to close: a second disconnect and other endpoints are no-ops.
    docker::disconnect(&host, &ssh).await;
    docker::disconnect(&host, &DockerEndpoint::Default).await;
    assert_eq!(host.ssh.connected(), ["box"]);
    host.shutdown().await;
}
