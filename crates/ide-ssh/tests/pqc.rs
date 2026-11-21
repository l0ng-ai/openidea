//! The post-quantum hybrid `ssh-mldsa44-ed25519` (ML-DSA-44 + Ed25519): offered by the
//! client, negotiated against a PQC-only server, and used for both the host key and
//! user authentication, end to end against an in-process server.

use getrandom::{SysRng, rand_core::UnwrapErr};
use ide_core::error::ErrorKind;
use ide_core::remote_settings::SshAuth;
use ide_ssh::{ConnectError, Session, SshFiles, SshTarget, preferred_key_algorithms};
use russh::Channel;
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{self, Auth, ChannelOpenHandle, Msg, Server as _};
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;

fn pqc_only_key_algorithms() -> Cow<'static, [Algorithm]> {
    Cow::Borrowed(&[Algorithm::MlDsa44Ed25519])
}

/// The composite algorithm is offered in addition to the defaults, never instead of
/// them: servers with a classical host key keep using it.
#[test]
fn composite_algorithm_is_appended_to_the_offered_list() {
    let offered = preferred_key_algorithms();
    assert_eq!(offered.last(), Some(&Algorithm::MlDsa44Ed25519));
    assert_eq!(offered.len(), 8);
    assert!(offered[..offered.len() - 1].contains(&Algorithm::Ed25519));
}

#[tokio::test]
async fn connects_to_a_pqc_only_server_with_a_composite_user_key() {
    let tmp = tempfile::tempdir().unwrap();
    let host_key = PrivateKey::random(&mut UnwrapErr(SysRng), Algorithm::MlDsa44Ed25519).unwrap();
    let user_key = PrivateKey::random(&mut UnwrapErr(SysRng), Algorithm::MlDsa44Ed25519).unwrap();
    let user_key_file = write_user_key(&tmp, &user_key);

    let port = sshd_pqc_only(host_key, user_key.public_key().clone()).await;
    let files = SshFiles { known_hosts: tmp.path().join("known_hosts"), config: None };
    let target = SshTarget {
        host: "127.0.0.1".into(),
        port: Some(port),
        user: "dev".into(),
        auth: SshAuth::KeyPair,
        key_file: user_key_file.to_string_lossy().into(),
    };

    let Err(ConnectError::UnknownHostKey(k)) = Session::connect(&target, None, &files).await else {
        panic!("expected an unknown host key on the first connection");
    };
    assert!(k.fingerprint().starts_with("ssh-mldsa44-ed25519 SHA256:"), "{}", k.fingerprint());
    k.trust(&files.known_hosts).unwrap();

    let session = Session::connect(&target, None, &files).await.unwrap();
    let output = session.exec("pqc", None).await.unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout), "pqc\n");
}

#[tokio::test]
async fn a_composite_user_key_is_rejected_for_another_user() {
    let tmp = tempfile::tempdir().unwrap();
    let host_key = PrivateKey::random(&mut UnwrapErr(SysRng), Algorithm::MlDsa44Ed25519).unwrap();
    let user_key = PrivateKey::random(&mut UnwrapErr(SysRng), Algorithm::MlDsa44Ed25519).unwrap();
    let user_key_file = write_user_key(&tmp, &user_key);

    let port = sshd_pqc_only(host_key, user_key.public_key().clone()).await;
    let files = SshFiles { known_hosts: tmp.path().join("known_hosts"), config: None };
    let target = SshTarget {
        host: "127.0.0.1".into(),
        port: Some(port),
        user: "intruder".into(),
        auth: SshAuth::KeyPair,
        key_file: user_key_file.to_string_lossy().into(),
    };

    trust_on_first_connect(&files.known_hosts, &target).await;
    let Err(ConnectError::Other(e)) = Session::connect(&target, None, &files).await else {
        panic!("expected authentication failure");
    };
    assert_eq!(e.kind, ErrorKind::PermissionDenied, "{e:?}");
}

async fn trust_on_first_connect(known_hosts: &Path, target: &SshTarget) {
    let files = SshFiles { known_hosts: known_hosts.to_path_buf(), config: None };
    if let Err(ConnectError::UnknownHostKey(k)) = Session::connect(target, None, &files).await {
        k.trust(known_hosts).unwrap();
    }
}

fn write_user_key(tmp: &TempDir, key: &PrivateKey) -> PathBuf {
    let path = tmp.path().join("id_mldsa44_ed25519");
    std::fs::write(&path, key.to_openssh(ssh_key::LineEnding::LF).unwrap().as_bytes()).unwrap();
    path
}

async fn sshd_pqc_only(host_key: PrivateKey, client_key: russh::keys::PublicKey) -> u16 {
    #[derive(Clone)]
    struct Sshd {
        client_key: russh::keys::PublicKey,
    }

    impl server::Server for Sshd {
        type Handler = Sshd;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Sshd {
            self.clone()
        }
    }

    impl server::Handler for Sshd {
        type Error = russh::Error;

        async fn auth_none(&mut self, _: &str) -> Result<Auth, Self::Error> {
            Ok(Auth::reject())
        }

        async fn auth_publickey(
            &mut self,
            user: &str,
            key: server::VerifiedPublicKey<'_>,
        ) -> Result<Auth, Self::Error> {
            let accept = user == "dev" && key.public_key.key_data() == self.client_key.key_data();
            Ok(if accept { Auth::Accept } else { Auth::reject() })
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            reply: ChannelOpenHandle,
            _session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn exec_request(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            session.data(channel, format!("{}\n", String::from_utf8_lossy(data)).into_bytes())?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }

    let config = Arc::new(server::Config {
        keys: vec![host_key],
        preferred: russh::Preferred { key: pqc_only_key_algorithms(), ..Default::default() },
        auth_rejection_time: std::time::Duration::from_millis(10),
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut server = Sshd { client_key };
    tokio::spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
    });
    port
}
