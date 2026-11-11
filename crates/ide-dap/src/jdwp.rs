//! "Listen to remote JVM" (IDEA's Remote JVM Debug in listen mode): the IDE listens,
//! the remote JVM (`-agentlib:jdwp=…,server=n,address=<ide-host>:<port>`) connects to
//! it. java-debug can only attach, so the connection is relayed: once the JVM has
//! connected, java-debug attaches to a one-shot loopback port that forwards the JDWP
//! stream (handshake included) both ways.

use ide_core::{CancellationToken, IdeError, IdeResult};
use std::io::ErrorKind;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};

/// How long the relay waits for java-debug to attach once the JVM is connected.
const ATTACH_TIMEOUT: Duration = Duration::from_secs(60);

/// Loopback ports relaying a connected JVM, while their relay runs.
static RELAY_PORTS: std::sync::Mutex<Vec<u16>> = std::sync::Mutex::new(Vec::new());

fn relay_ports() -> std::sync::MutexGuard<'static, Vec<u16>> {
    RELAY_PORTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether `port` is a relay of [`listen_for_jvm`]: a session attaching to it debugs a JVM that
/// connected to the IDE, so the JVM has no JDWP listener the memory view could find it by.
pub(crate) fn is_listen_relay(port: u16) -> bool {
    relay_ports().contains(&port)
}

/// Registers a relay port for as long as it lives.
struct RelayPort(u16);

impl RelayPort {
    fn new(port: u16) -> Self {
        relay_ports().push(port);
        Self(port)
    }
}

impl Drop for RelayPort {
    fn drop(&mut self) {
        relay_ports().retain(|&p| p != self.0);
    }
}

/// The address to listen on for `host`: the interface it names, or every interface when
/// it is not one of this machine's (a DNS name or a NAT address the JVM connects to).
async fn bind(host: &str, port: u16) -> IdeResult<TcpListener> {
    let host = host.trim();
    let host = if host.is_empty() { "0.0.0.0" } else { host.trim_start_matches('[').trim_end_matches(']') };
    match TcpListener::bind((host, port)).await {
        Ok(l) => Ok(l),
        Err(e) if e.kind() == ErrorKind::AddrNotAvailable || e.kind() == ErrorKind::Other => {
            TcpListener::bind(("0.0.0.0", port))
                .await
                .map_err(|e| IdeError::unavailable(format!("cannot listen on port {port}: {e}")))
        }
        Err(e) => Err(IdeError::unavailable(format!("cannot listen on {host}:{port}: {e}"))),
    }
}

/// Waits for a JVM to connect to `host:port`, then returns a loopback port that relays
/// to it (accepts one connection). Cancelled through `cancel` while waiting.
pub async fn listen_for_jvm(host: &str, port: u16, cancel: CancellationToken) -> IdeResult<u16> {
    let listener = bind(host, port).await?;
    let jvm = tokio::select! {
        _ = cancel.cancelled() => return Err(IdeError::cancelled()),
        accepted = listener.accept() => accepted.map_err(IdeError::from)?.0,
    };
    drop(listener);
    let _ = jvm.set_nodelay(true);
    let relay = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local = relay.local_addr()?.port();
    tokio::spawn(relay_one(relay, jvm, RelayPort::new(local)));
    Ok(local)
}

async fn relay_one(relay: TcpListener, mut jvm: TcpStream, _registered: RelayPort) {
    let debugger = match tokio::time::timeout(ATTACH_TIMEOUT, relay.accept()).await {
        Ok(Ok((s, _))) => s,
        _ => return,
    };
    drop(relay);
    let _ = debugger.set_nodelay(true);
    let mut debugger = debugger;
    if let Err(e) = tokio::io::copy_bidirectional(&mut debugger, &mut jvm).await {
        tracing::debug!(target: "ide_dap::jdwp", "JDWP relay closed: {e}");
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A remote JVM (`server=n`) connected to [`listen_for_jvm`], and the relay port. A port
    /// picked by binding to 0 can be taken by a parallel test before `listen_for_jvm` binds it,
    /// so a failed listen is retried on a fresh one.
    pub(crate) async fn connected_jvm() -> (TcpStream, u16) {
        for _ in 0..20 {
            let port = TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port();
            if let Some(connected) = jvm_on(port).await {
                return connected;
            }
        }
        panic!("listen_for_jvm never accepted a JVM");
    }

    /// One attempt of [`connected_jvm`]; `None` when the port turned out to be taken.
    async fn jvm_on(port: u16) -> Option<(TcpStream, u16)> {
        let mut waiting = tokio::spawn(listen_for_jvm("127.0.0.1", port, CancellationToken::new()));
        let mut jvm = None;
        for _ in 0..100 {
            // A listen that failed to bind leaves nothing to connect to.
            if waiting.is_finished() {
                break;
            }
            // macOS does not refuse a connect to a port a socket holds without listening: the
            // SYN goes unanswered until the connect times out.
            let connect = TcpStream::connect(("127.0.0.1", port));
            if let Ok(Ok(s)) = tokio::time::timeout(Duration::from_secs(1), connect).await {
                jvm = Some(s);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // A connection to another test's listener never reaches `listen_for_jvm`.
        let relay = tokio::time::timeout(Duration::from_secs(2), &mut waiting).await;
        if let (Some(jvm), Ok(Ok(Ok(relay)))) = (jvm, relay) {
            return Some((jvm, relay));
        }
        waiting.abort();
        None
    }

    #[tokio::test]
    async fn a_port_another_socket_holds_is_given_up() {
        // Bound but not listening, as a parallel test's outgoing connection holds its local port.
        let held = tokio::net::TcpSocket::new_v4().unwrap();
        held.bind(([127, 0, 0, 1], 0).into()).unwrap();
        let port = held.local_addr().unwrap().port();
        let attempt = tokio::time::timeout(Duration::from_secs(5), jvm_on(port)).await;
        assert!(matches!(attempt, Ok(None)), "an attempt on a taken port gives up instead of waiting forever");
    }

    #[tokio::test]
    async fn relays_the_jdwp_handshake_both_ways() {
        // The remote JVM (`server=n`) connects to the IDE.
        let (mut jvm, local) = connected_jvm().await;
        // java-debug attaches to the relay and starts the handshake.
        let mut debugger = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
        debugger.write_all(b"JDWP-Handshake").await.unwrap();
        let mut buf = [0u8; 14];
        jvm.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"JDWP-Handshake");
        jvm.write_all(b"JDWP-Handshake").await.unwrap();
        debugger.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"JDWP-Handshake");
    }

    #[tokio::test]
    async fn relay_port_is_known_while_the_relay_runs() {
        let (jvm, local) = connected_jvm().await;
        assert!(is_listen_relay(local));

        let debugger = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
        drop((jvm, debugger));
        for _ in 0..200 {
            if !is_listen_relay(local) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("relay port {local} still registered after the relay ended");
    }

    #[tokio::test]
    async fn waiting_is_cancellable() {
        let cancel = CancellationToken::new();
        let waiting = tokio::spawn(listen_for_jvm("127.0.0.1", 0, cancel.clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
        let err = waiting.await.unwrap().unwrap_err();
        assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
    }
}
