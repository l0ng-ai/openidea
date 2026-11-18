//! Local port forwarding: a listener on 127.0.0.1 whose connections are
//! forwarded through `direct-tcpip` channels of a [`Session`], or each to the
//! stdin / stdout of a command run on the SSH host.

use crate::session::Session;
use ide_core::{IdeError, IdeResult, error::ErrorKind};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// An open tunnel; dropping it stops forwarding (the session stays open while
/// other users hold it).
pub struct Tunnel {
    port: u16,
    session: Arc<Session>,
    accept: JoinHandle<()>,
}

impl Tunnel {
    /// Checks that the SSH host reaches `host:port`, then listens on a free local port.
    pub async fn open(session: Arc<Session>, host: &str, port: u16) -> IdeResult<Tunnel> {
        // Fail fast with the real reason when the SSH host cannot reach the target
        // (a refused forward otherwise surfaces as the client's connect timeout).
        session.direct_tcpip(host, port).await.map_err(|e| unreachable_target(session.label(), host, port, &e))?;
        Self::listen(session, host, port).await
    }

    /// [`Tunnel::open`] without the reachability check (the target may start later).
    pub async fn listen(session: Arc<Session>, host: &str, port: u16) -> IdeResult<Tunnel> {
        Self::listen_on(session, None, host, port).await
    }

    /// [`Tunnel::listen`] on local port `preferred` when it is free, else on any free port
    /// (a forwarded remote port keeps its number locally when it can, like VS Code's Ports).
    pub async fn listen_on(session: Arc<Session>, preferred: Option<u16>, host: &str, port: u16) -> IdeResult<Tunnel> {
        let listener = match preferred {
            Some(p) => match TcpListener::bind(("127.0.0.1", p)).await {
                Ok(l) => l,
                Err(_) => TcpListener::bind(("127.0.0.1", 0)).await?,
            },
            None => TcpListener::bind(("127.0.0.1", 0)).await?,
        };
        let local = listener.local_addr()?.port();
        let target = Target::Tcp(host.to_owned(), port);
        let accept = tokio::spawn(forward(listener, session.clone(), target));
        Ok(Tunnel { port: local, session, accept })
    }

    /// Listens on a free local port; each connection runs `command` on the SSH host and talks
    /// to its stdin / stdout (`docker system dial-stdio`, as the Docker CLI's `ssh://` does).
    pub async fn command(session: Arc<Session>, command: &str) -> IdeResult<Tunnel> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let local = listener.local_addr()?.port();
        let accept = tokio::spawn(forward(listener, session.clone(), Target::Command(command.to_owned())));
        Ok(Tunnel { port: local, session, accept })
    }

    /// The local port to connect to instead of the target.
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn is_closed(&self) -> bool {
        self.session.is_closed()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

/// Where a tunnel's connections go on the SSH side.
enum Target {
    Tcp(String, u16),
    Command(String),
}

async fn forward(listener: TcpListener, session: Arc<Session>, target: Target) {
    let target = Arc::new(target);
    let mut connections = tokio::task::JoinSet::new();
    loop {
        let accepted = tokio::select! {
            Some(_) = connections.join_next(), if !connections.is_empty() => continue,
            accepted = listener.accept() => accepted,
        };
        let Ok((mut socket, _)) = accepted else { return };
        let session = session.clone();
        let target = target.clone();
        connections.spawn(async move {
            let stream = match &*target {
                Target::Tcp(host, port) => session.direct_tcpip(host, *port).await.map_err(|e| {
                    tracing::warn!("SSH tunnel: cannot open a channel to {host}:{port}: {e}");
                }),
                Target::Command(command) => session.exec_stream(command).await.map_err(|e| {
                    tracing::warn!("SSH tunnel: cannot run `{command}`: {e}");
                }),
            };
            if let Ok(mut stream) = stream {
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            }
        });
    }
}

/// Why the SSH host `via` cannot open a channel to `host:port`.
pub fn unreachable_target(via: &str, host: &str, port: u16, e: &russh::Error) -> IdeError {
    let why = match e {
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed) => {
            "connection refused or host unreachable"
        }
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited) => {
            "port forwarding is not allowed by the SSH server (AllowTcpForwarding)"
        }
        _ => "",
    };
    let why = if why.is_empty() { e.to_string() } else { why.to_owned() };
    IdeError::new(ErrorKind::Io, format!("SSH host {via} cannot reach {host}:{port}: {why}"))
}
