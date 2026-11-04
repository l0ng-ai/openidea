//! The local socket the running app listens on: one JSON [`Request`] line in,
//! one [`Response`] line out. Unix domain sockets; not available on Windows yet.

use crate::{PROTOCOL_VERSION, Request, Response};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

/// The socket of the app with bundle identifier `identifier`. The name is a hash:
/// socket paths are limited to about 100 bytes, and development identifiers are long.
pub fn socket_path(identifier: &str) -> Option<PathBuf> {
    let dir = if cfg!(target_os = "macos") { dirs::cache_dir() } else { dirs::runtime_dir().or_else(dirs::cache_dir) };
    Some(dir?.join(format!("openidea-{:016x}.sock", fnv1a(identifier))))
}

fn fnv1a(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3))
}

fn answer(line: &str, handle: &dyn Fn(Request) -> Response) -> Response {
    match serde_json::from_str::<Request>(line) {
        Ok(request) if request.version == PROTOCOL_VERSION => handle(request),
        Ok(request) => Response::Error { message: format!("unsupported request version {}", request.version) },
        Err(e) => Response::Error { message: format!("invalid request: {e}") },
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};

    pub fn send(socket: &Path, request: &Request) -> io::Result<Response> {
        let stream = UnixStream::connect(socket)?;
        stream.set_read_timeout(Some(TIMEOUT))?;
        write_line(&stream, request)?;
        let mut reply = String::new();
        BufReader::new(&stream).read_line(&mut reply)?;
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
                if UnixStream::connect(socket).is_ok() {
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
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line)?;
        write_line(stream, &answer(&line, handle))
    }

    fn write_line(mut stream: &UnixStream, value: &impl serde::Serialize) -> io::Result<()> {
        let mut line = serde_json::to_string(value)?;
        line.push('\n');
        stream.write_all(line.as_bytes())
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;

    fn unsupported() -> io::Error {
        io::Error::new(io::ErrorKind::Unsupported, "the openidea command is not available on this platform yet")
    }

    pub fn send(_socket: &Path, _request: &Request) -> io::Result<Response> {
        Err(unsupported())
    }

    pub fn serve(_socket: &Path, _handle: impl Fn(Request) -> Response + Send + 'static) -> io::Result<()> {
        Err(unsupported())
    }
}

/// Sends `request` to the app listening on `socket` and waits for its answer.
pub use imp::send;
/// Answers requests on `socket` with `handle`, on a thread of its own.
pub use imp::serve;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Target;

    #[test]
    fn socket_names_separate_identifiers_and_stay_short() {
        let release = socket_path("ai.l0ng.openidea").unwrap();
        let dev = socket_path("ai.l0ng.openidea.dev.w158e9c5954b7bf64").unwrap();
        assert_ne!(release, dev);
        assert_eq!(dev.file_name().unwrap().len(), "openidea-0123456789abcdef.sock".len());
    }

    #[test]
    fn answers_only_its_protocol_version() {
        let ok = |_: Request| Response::Ok;
        assert_eq!(answer(&serde_json::to_string(&Request::open(vec![])).unwrap(), &ok), Response::Ok);
        let old = r#"{"version":0,"targets":[]}"#;
        assert!(matches!(answer(old, &ok), Response::Error { .. }));
        assert!(matches!(answer("garbage", &ok), Response::Error { .. }));
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
        let target = Target { path: "/p/a.rs".into(), line: Some(3), column: None };
        assert_eq!(send(&socket, &Request::open(vec![target.clone()])).unwrap(), Response::Ok);
        assert_eq!(rx.recv().unwrap().targets, vec![target]);
        // A live server keeps its socket.
        assert_eq!(serve(&socket, |_| Response::Ok).unwrap_err().kind(), io::ErrorKind::AddrInUse);
    }
}
