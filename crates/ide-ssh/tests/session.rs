//! Sessions against an in-process russh server that runs commands (a canned
//! reply) and forwards `direct-tcpip` channels to a local echo server.

use ide_core::error::ErrorKind;
use ide_core::remote_settings::SshAuth;
use ide_ssh::{ConnectError, Output, Session, SshFiles, SshTarget, Tunnel};
use parking_lot::Mutex;
use russh::keys::{PrivateKey, PublicKey, decode_secret_key};
use russh::server::{self, Auth, ChannelOpenHandle, Msg, Server as _, Session as ServerSession};
use russh::{Channel, ChannelId};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ssh").join(name)
}

fn key(name: &str, passphrase: Option<&str>) -> PrivateKey {
    decode_secret_key(&std::fs::read_to_string(fixture(name)).unwrap(), passphrase).unwrap()
}

#[derive(Clone)]
struct Sshd {
    client_key: PublicKey,
}

impl server::Server for Sshd {
    type Handler = Sshd;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Sshd {
        self.clone()
    }
}

impl server::Handler for Sshd {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == "dev" && password == "secret" { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        Ok(if user == "dev" && key.key_data() == self.client_key.key_data() { Auth::Accept } else { Auth::reject() })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    /// `ran: <command>` on stdout, `oops` on stderr, exit status 3.
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, format!("ran: {}", String::from_utf8_lossy(data)).into_bytes())?;
        session.extended_data(channel, 1, b"oops".to_vec())?;
        session.exit_status_request(channel, 3)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        let Ok(mut upstream) = TcpStream::connect((host, port as u16)).await else {
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
        });
        Ok(())
    }
}

/// Echo server standing in for a remote service.
async fn echo() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    port
}

async fn sshd() -> u16 {
    let config = Arc::new(server::Config {
        keys: vec![key("host", None)],
        auth_rejection_time: std::time::Duration::from_millis(10),
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut server = Sshd { client_key: key("client", None).public_key().clone() };
    tokio::spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
    });
    port
}

struct Env {
    _tmp: tempfile::TempDir,
    files: SshFiles,
    ssh_port: u16,
    echo_port: u16,
}

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let files = SshFiles { known_hosts: tmp.path().join("known_hosts"), config: None };
    Env { files, _tmp: tmp, ssh_port: sshd().await, echo_port: echo().await }
}

impl Env {
    fn target(&self, auth: SshAuth) -> SshTarget {
        SshTarget {
            host: "127.0.0.1".into(),
            port: Some(self.ssh_port),
            user: "dev".into(),
            auth,
            ..Default::default()
        }
    }

    async fn connect(&self, target: &SshTarget, secret: Option<&str>) -> Result<Session, ConnectError> {
        Session::connect(target, secret, &self.files).await
    }

    /// Trusts the server's key on the first connection, as the UI does.
    async fn connect_trusted(&self, target: &SshTarget, secret: Option<&str>) -> Result<Session, ConnectError> {
        match self.connect(target, secret).await {
            Err(ConnectError::UnknownHostKey(k)) => {
                k.trust(&self.files.known_hosts).unwrap();
                self.connect(target, secret).await
            }
            other => other,
        }
    }
}

async fn round_trip(t: &Tunnel) {
    let mut s = TcpStream::connect(("127.0.0.1", t.port())).await.unwrap();
    s.write_all(b"SELECT 1").await.unwrap();
    let mut buf = [0u8; 8];
    s.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"SELECT 1");
}

fn denied(r: Result<Session, ConnectError>) -> String {
    match r {
        Err(ConnectError::Other(e)) if e.kind == ErrorKind::PermissionDenied => e.message,
        Err(ConnectError::Other(e)) => panic!("expected permission denied, got {e:?}"),
        Err(ConnectError::UnknownHostKey(k)) => panic!("unexpected unknown host key {}", k.fingerprint()),
        Ok(_) => panic!("expected permission denied, connected"),
    }
}

#[tokio::test]
async fn unknown_host_key_must_be_trusted_and_changed_key_is_refused() {
    let env = env().await;
    let target = env.target(SshAuth::Password);
    let Err(ConnectError::UnknownHostKey(k)) = env.connect(&target, Some("secret")).await else {
        panic!("expected an unknown host key");
    };
    assert!(k.fingerprint().starts_with("ssh-ed25519 SHA256:"), "{}", k.fingerprint());
    assert!(k.error().message.starts_with("Unknown SSH host key for 127.0.0.1:"));
    k.trust(&env.files.known_hosts).unwrap();
    assert!(env.connect(&target, Some("secret")).await.is_ok());

    // Another key recorded for the same host: refused, never offered for trust.
    let other = key("client", None).public_key().to_openssh().unwrap();
    std::fs::write(&env.files.known_hosts, format!("[127.0.0.1]:{} {other}\n", env.ssh_port)).unwrap();
    let msg = denied(env.connect(&target, Some("secret")).await);
    assert!(msg.contains("has changed"), "{msg}");
}

#[tokio::test]
async fn password_authentication_and_forwarding() {
    let env = env().await;
    let target = env.target(SshAuth::Password);
    let session = Arc::new(env.connect_trusted(&target, Some("secret")).await.ok().unwrap());
    let tunnel = Tunnel::open(session.clone(), "127.0.0.1", env.echo_port).await.unwrap();
    round_trip(&tunnel).await;
    round_trip(&tunnel).await;
    assert!(!tunnel.is_closed());

    assert!(denied(env.connect(&target, None).await).starts_with("SSH password required"));
    assert!(denied(env.connect(&target, Some("wrong")).await).starts_with("SSH authentication failed"));

    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let Err(e) = Tunnel::open(session, "127.0.0.1", closed).await else { panic!("expected an error") };
    assert!(e.message.contains(&format!("cannot reach 127.0.0.1:{closed}")), "{}", e.message);
}

#[tokio::test]
async fn key_pair_authentication_with_and_without_passphrase() {
    let env = env().await;
    let target = SshTarget { key_file: fixture("client").to_string_lossy().into(), ..env.target(SshAuth::KeyPair) };
    assert!(env.connect_trusted(&target, None).await.is_ok());

    // An encrypted key the server does not accept: passphrase first, then the key is refused.
    let locked = SshTarget { key_file: fixture("locked").to_string_lossy().into(), ..target.clone() };
    assert!(denied(env.connect(&locked, None).await).starts_with("SSH key passphrase required"));
    assert!(denied(env.connect(&locked, Some("nope")).await).contains("wrong passphrase"));
    assert!(denied(env.connect(&locked, Some("pw")).await).starts_with("SSH authentication failed"));
}

#[tokio::test]
async fn runs_commands_and_streams_processes() {
    let env = env().await;
    let session = env.connect_trusted(&env.target(SshAuth::Password), Some("secret")).await.ok().unwrap();
    let out = session.exec("uname -a", None).await.unwrap();
    assert_eq!((out.code, out.stdout_str().as_str(), out.stderr.as_slice()), (Some(3), "ran: uname -a", &b"oops"[..]));
    assert!(out.into_stdout("uname").unwrap_err().message.contains("oops"));

    let seen: Arc<Mutex<(String, String)>> = Arc::default();
    let s = seen.clone();
    let process = session
        .spawn(
            "python3 main.py",
            None,
            Box::new(move |o| match o {
                Output::Stdout(b) => s.lock().0.push_str(&String::from_utf8_lossy(b)),
                Output::Stderr(b) => s.lock().1.push_str(&String::from_utf8_lossy(b)),
            }),
        )
        .await
        .unwrap();
    assert_eq!(process.wait().await, Some(3));
    assert_eq!(*seen.lock(), ("ran: python3 main.py".to_owned(), "oops".to_owned()));
}
