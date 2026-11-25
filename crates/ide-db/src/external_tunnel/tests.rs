use super::*;
use std::io::{Read, Write};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const EXAMPLE: &[u8; 4] = b"test";
const FIXTURE: &str = "external_tunnel::tests::fixture_entry";

fn config(mode: &str) -> crate::DbExternalTunnel {
    crate::DbExternalTunnel {
        executable: std::env::current_exe().unwrap().to_str().unwrap().to_owned(),
        arguments: vec!["--exact".into(), FIXTURE.into(), "--skip".into(), format!("wire-{mode}-{{localPort}}")],
    }
}

const TARGET: (&str, u16) = ("db.example", 5432);

// The test binary doubles as a foreground helper without an external interpreter.
#[test]
fn fixture_entry() {
    let Some(fixture) = std::env::args().find(|arg| arg.starts_with("wire-")) else { return };
    #[cfg(unix)]
    // SAFETY: these calls only inspect the current process's session and group.
    assert_eq!(unsafe { libc::getsid(0) }, unsafe { libc::getpgrp() });
    let (mode, port) = fixture.strip_prefix("wire-").unwrap().split_once('-').unwrap();
    let endpoint = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port.parse().unwrap());
    match mode {
        "exit" => (),
        "idle" => std::thread::sleep(Duration::from_secs(60)),
        "waiting" => {
            let observer = std::env::args()
                .find_map(|arg| arg.strip_prefix("observer-port-").and_then(|port| port.parse::<u16>().ok()))
                .unwrap();
            let _observer = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, observer)).unwrap();
            std::thread::sleep(Duration::from_secs(60));
        }
        "tree" => {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", FIXTURE, "--skip", &format!("wire-echo-{port}")])
                .spawn()
                .unwrap();
            assert!(child.wait().unwrap().success());
        }
        "echo" | "once" => {
            let socket = std::net::TcpListener::bind(endpoint).unwrap();
            std::thread::sleep(Duration::from_millis(150));
            for stream in socket.incoming() {
                let mut stream = stream.unwrap();
                let mut bytes = [0; EXAMPLE.len()];
                if stream.read_exact(&mut bytes).is_ok() {
                    stream.write_all(&bytes).unwrap();
                    stream.write_all(&endpoint.port().to_be_bytes()).unwrap();
                    if mode == "once" {
                        let _ = stream.read(&mut [0]);
                        break;
                    }
                }
            }
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn forwards_multiple_connections_to_the_helpers_child_and_cleans_up() {
    let tunnel = ExternalTunnel::open(&config("tree"), TARGET).await.unwrap();
    let mut helper_port = 0;
    for _ in 0..2 {
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            let mut db = TcpStream::connect((Ipv4Addr::LOCALHOST, tunnel.port())).await.unwrap();
            db.write_all(EXAMPLE).await.unwrap();
            let mut bytes = [0; EXAMPLE.len()];
            db.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, EXAMPLE);
            db.read_u16().await.unwrap()
        });
        helper_port = result.await.unwrap();
    }
    assert_ne!(helper_port, tunnel.port());
    assert!(!tunnel.is_closed());
    drop(tunnel);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if TcpStream::connect((Ipv4Addr::LOCALHOST, helper_port)).await.is_err() {
                break;
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn reports_a_helper_that_exits_without_listening() {
    let result = ExternalTunnel::open(&config("exit"), TARGET).await;
    assert!(result.err().unwrap().message.contains("exited"));
}

#[tokio::test]
async fn dropping_startup_stops_the_helper_before_it_listens() {
    let observer = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let mut settings = config("waiting");
    settings.arguments.extend(["--skip".into(), format!("observer-port-{}", observer.local_addr().unwrap().port())]);
    let startup = tokio::spawn(async move { ExternalTunnel::open(&settings, TARGET).await });

    let (mut helper_socket, _) =
        tokio::time::timeout(Duration::from_secs(10), observer.accept()).await.unwrap().unwrap();
    assert!(!startup.is_finished());
    startup.abort();
    assert!(startup.await.err().unwrap().is_cancelled());
    let error = tokio::time::timeout(Duration::from_secs(5), helper_socket.read_u8()).await.unwrap().unwrap_err();
    // Terminating the helper can reset its observer socket on Windows.
    assert!(matches!(error.kind(), io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset), "{error}");
}

#[tokio::test]
async fn refuses_an_unrelated_established_loopback_socket() {
    let unrelated = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let endpoint = unrelated.local_addr().unwrap();
    let settings = config("idle");
    let arguments = helper_arguments(&settings, TARGET, endpoint.port()).unwrap();
    let helper = Arc::new(Helper::spawn(Path::new(&settings.executable), &arguments).unwrap());
    assert!(helper.is_alive());
    assert!(!verify_socket(&helper, endpoint, None).await.unwrap());

    let listener = loopback_socket().unwrap().listen(128).unwrap();
    let relay_endpoint = listener.local_addr().unwrap();
    let task = tokio::spawn(relay(Arc::new(listener), endpoint, helper));
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut db = TcpStream::connect(relay_endpoint).await.unwrap();
        db.write_all(EXAMPLE).await.unwrap();
        let (mut accepted, _) = unrelated.accept().await.unwrap();
        assert_eq!(accepted.read_u8().await.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        task.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_dead_helper_keeps_its_relay_port_reserved_until_the_route_drops() {
    let tunnel = ExternalTunnel::open(&config("once"), TARGET).await.unwrap();
    let endpoint = SocketAddrV4::new(Ipv4Addr::LOCALHOST, tunnel.port());
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut db = TcpStream::connect(endpoint).await.unwrap();
        db.write_all(EXAMPLE).await.unwrap();
        let mut bytes = [0; EXAMPLE.len()];
        db.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, EXAMPLE);
        db.read_u16().await.unwrap();
        drop(db);
        while !tunnel.is_closed() {
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    })
    .await
    .unwrap();
    assert!(std::net::TcpListener::bind(endpoint).is_err());
}

#[test]
fn only_credential_free_proxy_addresses_reach_the_helper() {
    assert!(credential_free_proxy("proxy.example:3128"));
    assert!(credential_free_proxy("socks5h://proxy.example:1080"));
    assert!(!credential_free_proxy("https://user:password@proxy.example:3128"));
    assert!(!credential_free_proxy("https://proxy.example:3128/?secret=value"));
}

#[test]
fn expands_only_literal_arguments_and_validates_the_target() {
    let settings = crate::DbExternalTunnel {
        executable: config("echo").executable,
        arguments: vec!["--port={localPort}".into(), "{host}:{port}".into(), "a b \"quotes\"".into()],
    };
    let arguments = helper_arguments(&settings, TARGET, 12345).unwrap();
    assert_eq!(arguments, ["--port=12345", "db.example:5432", "a b \"quotes\""]);
    assert!(helper_arguments(&settings, ("--some-option", 5432), 12345).is_err());
}

#[test]
fn brackets_an_ipv6_host_port_pair_but_preserves_the_raw_host_argument() {
    let settings = crate::DbExternalTunnel {
        executable: config("echo").executable,
        arguments: vec!["{localPort}".into(), "{host}:{port}".into(), "{host}".into(), "[{host}]:{port}".into()],
    };
    let arguments = helper_arguments(&settings, ("[2001:db8::a]", 6432), 12345).unwrap();
    assert_eq!(arguments, ["12345", "[2001:db8::a]:6432", "2001:db8::a", "[2001:db8::a]:6432"]);
}
