//! Loopback port forwards carried through a container's stdin/stdout relay.

use crate::devcontainer::Up;
use ide_core::{CancellationToken, IdeResult};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// How to run the installed server in a started container (forwarded connections).
pub struct Exec {
    docker: PathBuf,
    up: Up,
    bin: String,
}

impl Exec {
    pub fn new(docker: PathBuf, up: Up, bin: String) -> Self {
        Self { docker, up, bin }
    }

    /// The arguments of `docker` for one connection from the container to `<host>:<port>`.
    fn connect_args(&self, host: &str, port: u16) -> Vec<String> {
        let port = port.to_string();
        ["exec", "-i", "-u", &self.up.user, &self.up.container, &self.bin, "--connect", host, &port]
            .map(str::to_owned)
            .into()
    }
}

/// A forwarded port of the container; dropping it closes its listener and connections.
pub struct Tunnel {
    port: u16,
    cancel: CancellationToken,
    closed: CancellationToken,
}

impl Tunnel {
    /// Listens on local port `preferred` when it is free, else on any free one, and forwards
    /// each connection to `<host>:<port>` as the container reaches it: `localhost` for the
    /// container itself, or another host such as a Compose service. Nothing needs to listen
    /// there yet.
    pub async fn listen(exec: Arc<Exec>, preferred: u16, host: &str, port: u16) -> IdeResult<Tunnel> {
        let target: Arc<str> = host.into();
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", preferred)).await {
            Ok(l) => l,
            Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
        };
        let local = listener.local_addr()?.port();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let closed = CancellationToken::new();
        let done = closed.clone();
        tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break };
                        connections.spawn(forward(exec.clone(), socket, target.clone(), port, stop.clone()));
                    }
                }
            }
            stop.cancel();
            drop(listener);
            while connections.join_next().await.is_some() {}
            done.cancel();
        });
        Ok(Tunnel { port: local, cancel, closed })
    }

    /// Stops listening and waits for all Docker children to be reaped.
    pub async fn close(self) {
        self.cancel.cancel();
        self.closed.cancelled().await;
    }

    /// The local port to connect to.
    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn forward(
    exec: Arc<Exec>,
    mut socket: tokio::net::TcpStream,
    host: Arc<str>,
    port: u16,
    cancel: CancellationToken,
) {
    let mut cmd = tokio::process::Command::new(&exec.docker);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.args(exec.connect_args(&host, port))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return tracing::warn!("forwarding {host}:{port}: cannot start docker: {e}"),
    };
    let (Some(mut stdin), Some(mut stdout), Some(mut stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return;
    };
    let (mut from_client, mut to_client) = socket.split();
    let input_done = CancellationToken::new();
    let eof = input_done.clone();
    let upstream = async move {
        let _ = tokio::io::copy(&mut from_client, &mut stdin).await;
        drop(stdin);
        eof.cancel();
    };
    let downstream = async {
        let mut buf = [0; 16 * 1024];
        loop {
            let read = stdout.read(&mut buf);
            tokio::pin!(read);
            let result = tokio::select! {
                result = &mut read => result,
                _ = input_done.cancelled() => {
                    match tokio::time::timeout(Duration::from_secs(5), &mut read).await {
                        Ok(result) => result,
                        Err(_) => break,
                    }
                }
            };
            let Ok(n) = result else { break };
            if n == 0 || to_client.write_all(&buf[..n]).await.is_err() {
                break;
            }
        }
        let _ = to_client.shutdown().await;
    };
    let diagnostics = async {
        let mut text = Vec::new();
        let _ = (&mut stderr).take(4096).read_to_end(&mut text).await;
        let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        text
    };
    let transfer = async {
        tokio::pin!(downstream);
        tokio::select! {
            _ = &mut downstream => {},
            _ = upstream => {
                // The downstream inactivity timer still permits a streaming final reply.
                downstream.await;
            }
        }
    };
    let exchange = async {
        tokio::select! {
            _ = cancel.cancelled() => {},
            _ = transfer => {},
        }
        let _ = child.kill().await;
    };
    let (_, diagnostics) = tokio::join!(exchange, diagnostics);
    if !diagnostics.is_empty() {
        tracing::warn!("forwarding {host}:{port}: {}", String::from_utf8_lossy(&diagnostics).trim());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "3f1c2b9a7d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8";
    #[test]
    fn a_forwarded_connection_runs_the_server_as_a_relay() {
        let up = Up { container: ID.into(), user: "vscode".into(), folder: "/w".into() };
        let exec = Exec { docker: "docker".into(), up, bin: "/s/openidea-server".into() };
        assert_eq!(
            exec.connect_args("localhost", 8000),
            ["exec", "-i", "-u", "vscode", ID, "/s/openidea-server", "--connect", "localhost", "8000"]
        );
        assert_eq!(
            exec.connect_args("selenium", 4444),
            ["exec", "-i", "-u", "vscode", ID, "/s/openidea-server", "--connect", "selenium", "4444"]
        );
    }

    /// A stand-in for `docker` that answers with its arguments, then echoes the connection.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_tunnel_pipes_each_connection_through_docker_exec() {
        use std::os::unix::fs::PermissionsExt;
        use tokio::io::AsyncReadExt;
        let dir = tempfile::tempdir().unwrap();
        let docker = dir.path().join("docker");
        std::fs::write(&docker, "#!/bin/sh\necho \"$*\"\nexec cat\n").unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let up = Up { container: ID.into(), user: "root".into(), folder: "/w".into() };
        let exec = Arc::new(Exec { docker, up, bin: "/s/openidea-server".into() });
        let tunnel = Tunnel::listen(exec, 0, "localhost", 8000).await.unwrap();
        for _ in 0..2 {
            let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", tunnel.port())).await.unwrap();
            socket.write_all(b"ping").await.unwrap();
            socket.shutdown().await.unwrap();
            let mut reply = String::new();
            tokio::time::timeout(Duration::from_secs(10), socket.read_to_string(&mut reply)).await.unwrap().unwrap();
            assert_eq!(reply, format!("exec -i -u root {ID} /s/openidea-server --connect localhost 8000\nping"));
        }
        let port = tunnel.port();
        tunnel.close().await;
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err(), "a dropped tunnel stops listening");
    }

    #[cfg(unix)]
    fn docker_script(script: &str) -> (tempfile::TempDir, Arc<Exec>) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let docker = dir.path().join("docker");
        std::fs::write(&docker, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let up = Up { container: ID.into(), user: "root".into(), folder: "/w".into() };
        let exec = Arc::new(Exec::new(docker, up, "/s/openidea-server".into()));
        (dir, exec)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_a_tunnel_closes_active_clients_and_reaps_children() {
        let (_dir, exec) = docker_script("echo $$; exec cat");
        let tunnel = Tunnel::listen(exec, 0, "localhost", 8000).await.unwrap();
        let port = tunnel.port();
        let mut clients = Vec::new();
        let mut pids = Vec::new();
        for _ in 0..2 {
            let socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let mut socket = tokio::io::BufReader::new(socket);
            let mut pid = String::new();
            use tokio::io::AsyncBufReadExt;
            tokio::time::timeout(Duration::from_secs(5), socket.read_line(&mut pid)).await.unwrap().unwrap();
            pids.push(pid.trim().parse::<u32>().unwrap());
            clients.push(socket);
        }
        drop(tunnel);
        for mut socket in clients {
            let mut reply = Vec::new();
            tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut reply)).await.unwrap().unwrap();
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let mut alive = false;
                for pid in &pids {
                    let status = tokio::process::Command::new("ps")
                        .args(["-p", &pid.to_string(), "-o", "stat="])
                        .output()
                        .await
                        .unwrap();
                    alive |= !status.stdout.is_empty();
                }
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn target_eof_closes_a_client_that_has_not_sent_eof() {
        let (_dir, exec) = docker_script("echo $$; printf done");
        let tunnel = Tunnel::listen(exec, 0, "localhost", 8000).await.unwrap();
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", tunnel.port())).await.unwrap();
        let mut reply = String::new();
        tokio::time::timeout(Duration::from_secs(5), socket.read_to_string(&mut reply)).await.unwrap().unwrap();
        let (pid, body) = reply.split_once('\n').unwrap();
        let pid = pid.parse::<u32>().unwrap();
        assert_eq!(body, "done");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = tokio::process::Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "stat="])
                    .output()
                    .await
                    .unwrap();
                if status.stdout.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stderr_is_drained_while_the_connection_is_open() {
        let (_dir, exec) = docker_script("dd if=/dev/zero bs=65536 count=4 >&2 2>/dev/null; printf done");
        let tunnel = Tunnel::listen(exec, 0, "localhost", 8000).await.unwrap();
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", tunnel.port())).await.unwrap();
        let mut reply = String::new();
        tokio::time::timeout(Duration::from_secs(5), socket.read_to_string(&mut reply)).await.unwrap().unwrap();
        assert_eq!(reply, "done");
        tunnel.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn occupied_preferred_port_falls_back_to_a_free_loopback_port() {
        let (_dir, exec) = docker_script("exec cat");
        let busy = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let preferred = busy.local_addr().unwrap().port();
        let tunnel = Tunnel::listen(exec, preferred, "localhost", 8000).await.unwrap();
        assert_ne!(tunnel.port(), preferred);
        let socket = tokio::net::TcpStream::connect(("127.0.0.1", tunnel.port())).await.unwrap();
        assert!(socket.peer_addr().unwrap().ip().is_loopback());
        tunnel.close().await;
    }
}
