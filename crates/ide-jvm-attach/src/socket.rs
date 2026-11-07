use std::path::PathBuf;
use std::time::Duration;
#[cfg(unix)]
use std::{
    io::{self, Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        net::UnixStream,
    },
    path::Path,
    time::Instant,
};

/// Upper bound on the reply read from the JVM, in bytes.
pub const MAX_OUTPUT: usize = 64 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum AttachError {
    #[error("attach is not supported on this platform")]
    Unsupported,
    #[error("the JVM has no attach listener")]
    NoListener,
    #[error("the attach socket is not private to the current user")]
    ForeignListener,
    #[error("the attach listener refused the connection")]
    Refused,
    #[error("the JVM did not answer in time")]
    Timeout,
    #[error("the JVM reply exceeds the size limit")]
    TooLarge,
    #[error("the JVM rejected the command ({code}): {message}")]
    Command { code: i32, message: String },
    #[error("unexpected reply from the JVM: {0}")]
    Protocol(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Directory holding the JVM's `.java_pid<pid>` sockets. On macOS this is the per-user
/// directory from `confstr`, which differs from `$TMPDIR` in some launch contexts.
pub fn temp_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let mut buf = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: `buf` is writable for `buf.len()` bytes; confstr NUL-terminates within it.
        let n = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, buf.as_mut_ptr().cast(), buf.len()) };
        if n > 0 && n <= buf.len() {
            let dir = String::from_utf8_lossy(&buf[..n - 1]);
            let dir = dir.trim_end_matches('/');
            if !dir.is_empty() {
                return PathBuf::from(dir);
            }
        }
    }
    #[cfg(unix)]
    {
        PathBuf::from("/tmp")
    }
    #[cfg(not(unix))]
    {
        std::env::temp_dir()
    }
}

/// True when `.java_pid<pid>` exists and passes the same ownership check `jcmd` applies.
pub fn has_listener(pid: u32) -> bool {
    #[cfg(unix)]
    {
        has_listener_at(&socket_path(pid))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Runs one diagnostic command. `command_line` is sent as a single argument, so
/// `"GC.class_histogram -all"` is one request, not a command plus an option.
pub fn jcmd(pid: u32, command_line: &str, timeout: Duration) -> Result<String, AttachError> {
    #[cfg(unix)]
    {
        jcmd_at(&socket_path(pid), command_line, timeout)
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, command_line, timeout);
        Err(AttachError::Unsupported)
    }
}

#[cfg(unix)]
fn socket_path(pid: u32) -> PathBuf {
    temp_dir().join(format!(".java_pid{pid}"))
}

/// Same trust rule as the JDK's `VirtualMachineImpl`: only talk to a socket we own and
/// nobody else can reach, otherwise another user could answer in the JVM's place.
#[cfg(unix)]
fn check_socket(path: &Path) -> Result<(), AttachError> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(AttachError::NoListener),
        Err(e) => return Err(e.into()),
    };
    // SAFETY: geteuid has no preconditions and cannot fail.
    let owned_by_us = meta.uid() == unsafe { libc::geteuid() };
    if meta.file_type().is_socket() && owned_by_us && meta.mode() & 0o077 == 0 {
        Ok(())
    } else {
        Err(AttachError::ForeignListener)
    }
}

#[cfg(unix)]
fn has_listener_at(path: &Path) -> bool {
    check_socket(path).is_ok()
}

#[cfg(unix)]
pub(crate) fn jcmd_at(path: &Path, command_line: &str, timeout: Duration) -> Result<String, AttachError> {
    let deadline = Instant::now() + timeout;
    check_socket(path)?;
    let mut stream = UnixStream::connect(path).map_err(|e| match e.kind() {
        io::ErrorKind::ConnectionRefused => AttachError::Refused,
        io::ErrorKind::NotFound => AttachError::NoListener,
        _ => AttachError::Io(e),
    })?;
    // A suspended VM may never drain the socket; bound the write by the same budget.
    stream.set_write_timeout(Some(timeout.max(Duration::from_millis(1))))?;
    let request = format!("1\0jcmd\0{command_line}\0\0\0");
    stream.write_all(request.as_bytes()).map_err(map_timeout)?;
    read_reply(&mut stream, deadline, MAX_OUTPUT)
}

#[cfg(unix)]
fn map_timeout(e: io::Error) -> AttachError {
    match e.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => AttachError::Timeout,
        _ => AttachError::Io(e),
    }
}

/// Reads until the JVM closes the connection. The first line is the result code, the rest is the body.
#[cfg(unix)]
fn read_reply(stream: &mut UnixStream, deadline: Instant, max: usize) -> Result<String, AttachError> {
    let mut reply = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(AttachError::Timeout);
        }
        // macOS rejects SO_RCVTIMEO with EINVAL once the peer has closed; the read then
        // returns buffered data or EOF immediately, so the missing timeout is harmless.
        match stream.set_read_timeout(Some(remaining)) {
            Err(e) if e.kind() != io::ErrorKind::InvalidInput => return Err(e.into()),
            _ => {}
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if reply.len() + n > max {
                    return Err(AttachError::TooLarge);
                }
                reply.extend_from_slice(&chunk[..n]);
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(map_timeout(e)),
        }
    }

    let newline = reply
        .iter()
        .position(|b| *b == b'\n')
        .ok_or_else(|| AttachError::Protocol("reply has no result code line".into()))?;
    let code_text = String::from_utf8_lossy(&reply[..newline]);
    let code: i32 =
        code_text.trim().parse().map_err(|_| AttachError::Protocol(format!("invalid result code {code_text:?}")))?;
    let body = String::from_utf8_lossy(&reply[newline + 1..]).into_owned();
    if code == 0 { Ok(body) } else { Err(AttachError::Command { code, message: body.trim().to_string() }) }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};
    use std::{fs, sync::mpsc, thread};

    fn bind_private(dir: &Path) -> (PathBuf, UnixListener) {
        let path = dir.join(".java_pid1");
        let listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        (path, listener)
    }

    /// Accepts one connection, returns the request bytes (5 NUL-terminated strings), sends `reply`.
    fn serve_once(listener: UnixListener, reply: &'static [u8]) -> thread::JoinHandle<Vec<u8>> {
        thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while request.iter().filter(|b| **b == 0).count() < 5 {
                conn.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            conn.write_all(reply).unwrap();
            request
        })
    }

    #[test]
    fn sends_v1_jcmd_request_and_returns_body() {
        let dir = tempfile::tempdir().unwrap();
        let (path, listener) = bind_private(dir.path());
        let server = serve_once(listener, b"0\nhello\n");
        let out = jcmd_at(&path, "GC.class_histogram -all", Duration::from_secs(2)).unwrap();
        assert_eq!(out, "hello\n");
        assert_eq!(server.join().unwrap(), b"1\0jcmd\0GC.class_histogram -all\0\0\0");
    }

    #[test]
    fn nonzero_code_is_command_error() {
        let dir = tempfile::tempdir().unwrap();
        let (path, listener) = bind_private(dir.path());
        let _server = serve_once(listener, b"-1\njava.lang.IllegalArgumentException: Unknown diagnostic command");
        match jcmd_at(&path, "Nope", Duration::from_secs(2)) {
            Err(AttachError::Command { code, message }) => {
                assert_eq!(code, -1);
                assert!(message.contains("Unknown diagnostic command"), "{message}");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn jcmd_times_out_when_listener_never_answers() {
        let dir = tempfile::tempdir().unwrap();
        let (path, listener) = bind_private(dir.path());
        let (release, hold) = mpsc::channel::<()>();
        let server = thread::spawn(move || {
            let (_conn, _) = listener.accept().unwrap();
            let _ = hold.recv();
        });
        let started = Instant::now();
        let result = jcmd_at(&path, "Thread.print", Duration::from_millis(200));
        assert!(matches!(result, Err(AttachError::Timeout)), "{result:?}");
        assert!(started.elapsed() < Duration::from_secs(1));
        release.send(()).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn stale_socket_maps_to_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (path, listener) = bind_private(dir.path());
        drop(listener);
        assert!(path.exists());
        let result = jcmd_at(&path, "Thread.print", Duration::from_secs(1));
        assert!(matches!(result, Err(AttachError::Refused)), "{result:?}");
    }

    #[test]
    fn rejects_socket_with_group_or_other_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let (path, _listener) = bind_private(dir.path());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(!has_listener_at(&path));
        let result = jcmd_at(&path, "Thread.print", Duration::from_secs(1));
        assert!(matches!(result, Err(AttachError::ForeignListener)), "{result:?}");
    }

    #[test]
    fn output_over_limit_is_too_large() {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(b"0\n").unwrap();
        writer.write_all(&[b'x'; 100]).unwrap();
        drop(writer);
        let deadline = Instant::now() + Duration::from_secs(1);
        let result = read_reply(&mut reader, deadline, 10);
        assert!(matches!(result, Err(AttachError::TooLarge)), "{result:?}");
    }

    #[test]
    fn temp_dir_is_an_existing_dir_without_trailing_slash() {
        let dir = temp_dir();
        assert!(dir.is_dir(), "{dir:?}");
        assert!(!dir.to_string_lossy().ends_with('/'));
    }

    #[test]
    fn missing_socket_is_no_listener() {
        let dir = tempfile::tempdir().unwrap();
        let result = jcmd_at(&dir.path().join(".java_pid9"), "x", Duration::from_secs(1));
        assert!(matches!(result, Err(AttachError::NoListener)), "{result:?}");
        assert!(!has_listener_at(&dir.path().join(".java_pid9")));
    }
}
