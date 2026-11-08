//! The local socket the running app listens on: one JSON [`Request`] line in,
//! one [`Response`] line out. Unix domain sockets or Windows named pipes.

use crate::{Request, Response};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_MESSAGE: u64 = 1024 * 1024;

fn answer(line: &str, handle: &dyn Fn(Request) -> Response) -> Response {
    match serde_json::from_str::<Request>(line) {
        Ok(request) if request.version == crate::PROTOCOL_VERSION && (!request.diff || request.targets.len() == 2) => {
            handle(request)
        }
        Ok(_) => Response::Error { message: "unsupported or invalid CLI request".into() },
        Err(e) => Response::Error { message: format!("invalid request: {e}") },
    }
}

/// The socket of the app with bundle identifier `identifier`. The name is a hash:
/// socket paths are limited to about 100 bytes, and development identifiers are long.
pub fn socket_path(identifier: &str) -> Option<PathBuf> {
    if cfg!(windows) {
        let user = dirs::data_local_dir()?;
        return Some(PathBuf::from(format!(
            r"\\.\pipe\openidea-{:016x}",
            fnv1a(&format!("{}:{identifier}", user.display()))
        )));
    }
    let dir = if cfg!(target_os = "macos") { dirs::cache_dir() } else { dirs::runtime_dir().or_else(dirs::cache_dir) };
    Some(dir?.join(format!("openidea-{:016x}.sock", fnv1a(identifier))))
}

fn fnv1a(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3))
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};

    pub fn send(socket: &Path, request: &Request) -> io::Result<Response> {
        let stream = UnixStream::connect(socket)?;
        stream.set_read_timeout(Some(TIMEOUT))?;
        stream.set_write_timeout(Some(TIMEOUT))?;
        write_line(&stream, request)?;
        let mut reply = String::new();
        BufReader::new((&stream).take(MAX_MESSAGE)).read_line(&mut reply)?;
        Ok(serde_json::from_str(&reply)?)
    }

    pub fn serve(socket: &Path, handle: impl Fn(Request) -> Response + Send + 'static) -> io::Result<()> {
        let listener = bind(socket)?;
        std::thread::Builder::new().name("cli-socket".into()).spawn(move || {
            for stream in listener.incoming().flatten() {
                if let Err(e) = serve_one(&stream, &handle) {
                    tracing::warn!("cli request failed: {e}");
                }
            }
        })?;
        Ok(())
    }

    /// Binds `socket`, replacing a stale file no one answers on.
    fn bind(socket: &Path) -> io::Result<UnixListener> {
        if let Some(dir) = socket.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let listener = match UnixListener::bind(socket) {
            Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
                if !std::fs::symlink_metadata(socket)?.file_type().is_socket() || UnixStream::connect(socket).is_ok() {
                    return Err(e);
                }
                std::fs::remove_file(socket)?;
                UnixListener::bind(socket)?
            }
            bound => bound?,
        };
        std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
        Ok(listener)
    }

    fn serve_one(stream: &UnixStream, handle: &dyn Fn(Request) -> Response) -> io::Result<()> {
        stream.set_read_timeout(Some(TIMEOUT))?;
        stream.set_write_timeout(Some(TIMEOUT))?;
        let mut line = String::new();
        BufReader::new(stream.take(MAX_MESSAGE)).read_line(&mut line)?;
        write_line(stream, &answer(&line, handle))
    }

    fn write_line(mut stream: &UnixStream, value: &impl serde::Serialize) -> io::Result<()> {
        let mut line = serde_json::to_string(value)?;
        line.push('\n');
        stream.write_all(line.as_bytes())
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

    fn runtime() -> io::Result<tokio::runtime::Runtime> {
        tokio::runtime::Builder::new_current_thread().enable_all().build()
    }

    pub fn send(socket: &Path, request: &Request) -> io::Result<Response> {
        runtime()?.block_on(async {
            tokio::time::timeout(TIMEOUT, async {
                let mut pipe = loop {
                    match ClientOptions::new().open(socket) {
                        Ok(pipe) => break pipe,
                        // All existing instances are busy; wait instead of starting another app.
                        Err(e) if e.raw_os_error() == Some(231) => tokio::time::sleep(Duration::from_millis(10)).await,
                        Err(e) => return Err(e),
                    }
                };
                let mut line = serde_json::to_vec(request)?;
                line.push(b'\n');
                pipe.write_all(&line).await?;
                let mut reply = String::new();
                BufReader::new((&mut pipe).take(MAX_MESSAGE)).read_line(&mut reply).await?;
                pipe.write_all(b"\n").await?;
                Ok(serde_json::from_str(&reply)?)
            })
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "CLI request timed out"))?
        })
    }

    pub fn serve(socket: &Path, handle: impl Fn(Request) -> Response + Send + 'static) -> io::Result<()> {
        let socket = socket.to_owned();
        let (ready, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new().name("cli-pipe".into()).spawn(move || {
            let runtime = match runtime() {
                Ok(runtime) => runtime,
                Err(e) => {
                    let _ = ready.send(Err(e));
                    return;
                }
            };
            runtime.block_on(async move {
                let mut pipe = match ServerOptions::new().first_pipe_instance(true).create(&socket) {
                    Ok(pipe) => pipe,
                    Err(e) => {
                        let _ = ready.send(Err(e));
                        return;
                    }
                };
                let _ = ready.send(Ok(()));
                loop {
                    if let Err(e) = pipe.connect().await {
                        tracing::warn!("CLI pipe connection failed: {e}");
                        return;
                    }
                    // Keep an instance bound while answering, so another process cannot take the name.
                    let next = match ServerOptions::new().create(&socket) {
                        Ok(next) => next,
                        Err(e) => {
                            tracing::warn!("cannot create CLI pipe: {e}");
                            return;
                        }
                    };
                    let reply = tokio::time::timeout(TIMEOUT, async {
                        let mut line = String::new();
                        BufReader::new((&mut pipe).take(MAX_MESSAGE)).read_line(&mut line).await?;
                        let mut reply = serde_json::to_vec(&answer(&line, &handle))?;
                        reply.push(b'\n');
                        pipe.write_all(&reply).await?;
                        // Wait until the client has drained the reply before closing its instance.
                        pipe.read_exact(&mut [0u8; 1]).await.map(|_| ())
                    })
                    .await;
                    if !matches!(reply, Ok(Ok(()))) {
                        tracing::warn!("CLI pipe request failed: {reply:?}");
                    }
                    // Dropping after the write lets the client drain its reply before disconnecting.
                    drop(pipe);
                    pipe = next;
                }
            });
        })?;
        receiver.recv().map_err(|_| io::Error::other("CLI pipe thread stopped"))?
    }
}

/// Sends `request` to the app listening on `socket` and waits for its answer.
pub use imp::send;
/// Answers requests on `socket` with `handle`, on a thread of its own.
pub use imp::serve;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_names_separate_identifiers_and_stay_short() {
        let release = socket_path("ai.l0ng.openidea").unwrap();
        let dev = socket_path("ai.l0ng.openidea.dev.w158e9c5954b7bf64").unwrap();
        assert_ne!(release, dev);
        assert!(dev.as_os_str().len() < 100 || cfg!(unix));
    }

    #[test]
    fn answers_only_its_protocol_version() {
        let ok = |_: Request| Response::Ok;
        assert_eq!(answer(&serde_json::to_string(&Request::open(vec![])).unwrap(), &ok), Response::Ok);
        let old = r#"{"version":0,"targets":[]}"#;
        assert!(matches!(answer(old, &ok), Response::Error { .. }));
        assert!(matches!(answer("garbage", &ok), Response::Error { .. }));
    }

    #[cfg(windows)]
    #[test]
    fn named_pipe_round_trip() {
        let socket = socket_path(&format!("test-{}", std::process::id())).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        serve(&socket, move |request| {
            tx.send(request).unwrap();
            Response::Ok
        })
        .unwrap();
        for _ in 0..2 {
            let target = crate::Target { path: r"C:\项目\my file.rs".into(), line: Some(3), column: Some(2) };
            assert_eq!(send(&socket, &Request::open(vec![target.clone()])).unwrap(), Response::Ok);
            assert_eq!(rx.recv_timeout(TIMEOUT).unwrap().targets, vec![target]);
        }
        assert!(serve(&socket, |_| Response::Ok).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn request_round_trip_and_stale_socket() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("cli.sock");
        // A file left by an app that exited without removing it.
        drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        serve(&socket, move |request| {
            tx.send(request).unwrap();
            Response::Ok
        })
        .unwrap();
        let target = crate::Target { path: "/p/a.rs".into(), line: Some(3), column: None };
        assert_eq!(send(&socket, &Request::open(vec![target.clone()])).unwrap(), Response::Ok);
        assert_eq!(rx.recv().unwrap().targets, vec![target]);
        // A live server keeps its socket.
        assert_eq!(serve(&socket, |_| Response::Ok).unwrap_err().kind(), io::ErrorKind::AddrInUse);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_remove_an_unrelated_file() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("cli.sock");
        std::fs::write(&socket, "keep").unwrap();
        assert!(serve(&socket, |_| Response::Ok).is_err());
        assert_eq!(std::fs::read_to_string(&socket).unwrap(), "keep");
    }
}
