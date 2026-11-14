//! Data Source › SSH/SSL › Test SSH Tunnel against an in-process SSH server: the SSH login and
//! the SSH host reaching the database host and port, with no database login.

use ide_core::error::ErrorKind;
use ide_db::{DataSource, DbDriver, DbManager, DbSsh, DbSshAuth};
use ide_ssh::{SshFiles, SshManager};
use std::sync::Arc;
use tokio::net::TcpListener;

struct Env {
    _tmp: tempfile::TempDir,
    db: DbManager,
    ssh_port: u16,
}

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let ssh_port = ide_ssh::testing::sshd(root.join("server"), Arc::new(|cmd| panic!("unexpected exec: {cmd}"))).await;
    let ssh = Arc::new(SshManager::with_files(
        root.join("ssh-secrets.json"),
        SshFiles { known_hosts: root.join("known_hosts"), config: None },
    ));
    let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
    Env { _tmp: tmp, db, ssh_port }
}

impl Env {
    /// A PostgreSQL source on `127.0.0.1:<db_port>` through the test server as `dev`.
    fn source(&self, db_port: u16) -> DataSource {
        DataSource {
            id: "pg".into(),
            name: "pg".into(),
            driver: DbDriver::Postgres,
            host: "127.0.0.1".into(),
            port: Some(db_port),
            user: "app".into(),
            ssh: Some(DbSsh {
                enabled: true,
                host: "127.0.0.1".into(),
                port: Some(self.ssh_port),
                user: "dev".into(),
                auth: DbSshAuth::Password,
                ..Default::default()
            }),
            ..Default::default()
        }
    }
}

/// A port something listens on (and never speaks a database protocol).
async fn listening() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_tunnel_is_tested_without_a_database_login() {
    let env = env().await;
    let (_db, db_port) = listening().await;
    let source = env.source(db_port);

    // First contact: the host key has to be trusted, as with Test Connection.
    let unknown = env.db.test_tunnel(&source, Some("secret".into())).await.unwrap_err();
    assert!(unknown.message.starts_with("Unknown SSH host key"), "{unknown:?}");
    env.db.trust_ssh_host("pg").await.unwrap();

    let ok = env.db.test_tunnel(&source, Some("secret".into())).await.unwrap();
    assert_eq!(ok, format!("dev@127.0.0.1:{} reaches 127.0.0.1:{db_port}", env.ssh_port));

    let wrong = env.db.test_tunnel(&source, Some("nope".into())).await.unwrap_err();
    assert!(wrong.message.contains("SSH authentication failed"), "{}", wrong.message);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_database_port_the_ssh_host_cannot_reach_is_named() {
    let env = env().await;
    let (listener, closed) = listening().await;
    drop(listener);
    let source = env.source(closed);
    let _ = env.db.test_tunnel(&source, Some("secret".into())).await;
    env.db.trust_ssh_host("pg").await.unwrap();

    let err = env.db.test_tunnel(&source, Some("secret".into())).await.unwrap_err();
    assert!(err.message.contains(&format!("cannot reach 127.0.0.1:{closed}")), "{}", err.message);
}

#[tokio::test]
async fn a_source_without_a_tunnel_has_nothing_to_test() {
    let env = env().await;
    let mut source = env.source(5432);
    source.ssh.as_mut().unwrap().enabled = false;
    let err = env.db.test_tunnel(&source, None).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidInput, "{err:?}");
}
