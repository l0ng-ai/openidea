//! Persistent per-project `openidea-server` daemon over a local Unix domain socket.
//!
//! * `openidea-server --attach <project_path>` connects to the daemon for `<project_path>`
//!   (spawning it detached in a new session if none is listening) and bridges its own
//!   stdin / stdout to the Unix socket. Closing the desktop window ends the SSH / WSL /
//!   `docker exec` attach relay while the daemon — and its index, language servers,
//!   terminals, runs and agent sessions — keeps running.
//! * `openidea-server --daemon <socket_path>` is the background process `--attach` starts.

use crate::Host;
use crate::rpc::{self, Dispatcher, PeerSlot};
use ide_core::CancellationToken;
use rustix::fs::{FlockOperation, flock};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::Shutdown;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

/// Keep socket paths well below macOS (104) and Linux (108) `sun_path` limits.
const MAX_SUN_PATH: usize = 96;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const EOF_DRAIN: Duration = Duration::from_secs(2);
/// Empty daemons (for example when `open_project` failed on a missing path) exit
/// once disconnected for this long; daemons with an open project stay alive.
const EMPTY_IDLE_EXIT: Duration = Duration::from_secs(30);

pub struct DaemonPaths {
    pub key: String,
    pub socket: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
}

/// Resolves `raw_path` (`~`, `~/…`, symlinks) the same way `open_project` does so
/// `~/repo` and `/home/user/repo` attach to the same daemon.
pub fn normalize_project_path(raw_path: &str, home: &Path) -> PathBuf {
    let trimmed = raw_path.trim();
    let expanded = if trimmed.is_empty() || trimmed == "~" {
        home.to_path_buf()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    let canonical = dunce::canonicalize(&expanded).unwrap_or(expanded);
    let text = canonical.to_string_lossy();
    if text.len() > 1 && text.ends_with('/') { PathBuf::from(text.trim_end_matches('/')) } else { canonical }
}

/// Deterministic socket, lock and log paths for `(project_path, exe_path, base)`.
pub fn paths_for(base: &Path, home: &Path, exe: &Path, raw_project_path: &str) -> io::Result<DaemonPaths> {
    let project = normalize_project_path(raw_project_path, home);
    let exe_canon = dunce::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
    let base_canon = dunce::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
    let mut hasher = blake3::Hasher::new();
    hasher.update(project.to_string_lossy().as_bytes());
    hasher.update(&[0]);
    hasher.update(exe_canon.to_string_lossy().as_bytes());
    hasher.update(&[0]);
    hasher.update(base_canon.to_string_lossy().as_bytes());
    let key = hasher.finalize().to_hex()[..16].to_owned();

    let sock_name = format!("s-{key}.sock");
    let lock_name = format!("s-{key}.lock");
    let preferred_dir = base.join("run");
    let run_dir = if preferred_dir.join(&sock_name).as_os_str().len() <= MAX_SUN_PATH {
        ensure_private_dir(&preferred_dir)?;
        preferred_dir
    } else {
        let uid = rustix::process::geteuid().as_raw();
        let fallback = PathBuf::from(format!("/tmp/openidea-{uid}"));
        ensure_private_dir(&fallback)?;
        fallback
    };

    let log_dir = base.join("logs");
    std::fs::create_dir_all(&log_dir)?;
    Ok(DaemonPaths {
        socket: run_dir.join(sock_name),
        lock: run_dir.join(lock_name),
        log: log_dir.join(format!("server-{key}.log")),
        key,
    })
}

fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    if !dir.exists() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(dir)?;
    }
    let meta = std::fs::symlink_metadata(dir)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is not a private directory", dir.display()),
        ));
    }
    let uid = rustix::process::geteuid().as_raw();
    if meta.uid() != uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is owned by uid {}, expected {uid}", dir.display(), meta.uid()),
        ));
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Connects to the daemon for `project_path` (spawning it if needed) and bridges
/// `input` / `output` to its Unix socket.
pub fn attach(
    base: &Path,
    home: &Path,
    project_path: &str,
    input: impl Read + Send + 'static,
    output: impl Write,
) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate openidea-server: {e}"))?;
    let paths = paths_for(base, home, &exe, project_path).map_err(|e| format!("cannot prepare runtime dir: {e}"))?;
    let stream = connect_or_spawn(&exe, &paths)?;
    bridge(stream, input, output).map_err(|e| format!("daemon relay failed: {e}"))
}

fn connect_or_spawn(exe: &Path, paths: &DaemonPaths) -> Result<UnixStream, String> {
    let lock_file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&paths.lock)
        .map_err(|e| format!("cannot open {}: {e}", paths.lock.display()))?;
    flock(&lock_file, FlockOperation::LockExclusive)
        .map_err(|e| format!("cannot lock {}: {e}", paths.lock.display()))?;

    if let Ok(stream) = UnixStream::connect(&paths.socket) {
        let _ = flock(&lock_file, FlockOperation::Unlock);
        return Ok(stream);
    }

    let _ = std::fs::remove_file(&paths.socket);
    let mut log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .mode(0o600)
        .open(&paths.log)
        .map_err(|e| format!("cannot open {}: {e}", paths.log.display()))?;
    let log_offset = log_file.metadata().map(|m| m.len()).unwrap_or(0);
    let stderr_file = log_file.try_clone().map_err(|e| format!("cannot clone log handle: {e}"))?;

    let mut cmd = Command::new(exe);
    cmd.arg("--daemon").arg(&paths.socket).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::from(stderr_file));
    // SAFETY: `setsid` is an async-signal-safe POSIX call that detaches the daemon into
    // a new session without a controlling terminal, outliving the SSH / WSL / docker exec call.
    unsafe {
        cmd.pre_exec(|| {
            let _ = rustix::process::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| format!("cannot spawn openidea-server daemon: {e}"))?;

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let result = loop {
        if let Ok(stream) = UnixStream::connect(&paths.socket) {
            break Ok(stream);
        }
        if let Ok(Some(status)) = child.try_wait() {
            let tail = read_log_tail(&mut log_file, log_offset);
            let detail = if tail.is_empty() { format!("exited with {status}") } else { tail };
            break Err(format!("openidea-server daemon failed to start: {detail}"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let tail = read_log_tail(&mut log_file, log_offset);
            let detail = if tail.is_empty() { "timed out waiting for socket".to_owned() } else { tail };
            break Err(format!("openidea-server daemon did not start: {detail}"));
        }
        std::thread::sleep(Duration::from_millis(15));
    };

    let _ = flock(&lock_file, FlockOperation::Unlock);
    result
}

fn read_log_tail(file: &mut File, offset: u64) -> String {
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return String::new();
    }
    let mut text = String::new();
    let _ = file.read_to_string(&mut text);
    text.trim().to_owned()
}

/// Copies `input` to `stream` and `stream` to `output`, returning promptly when either
/// side closes.
pub fn bridge(
    mut from_daemon: UnixStream,
    mut input: impl Read + Send + 'static,
    mut output: impl Write,
) -> io::Result<()> {
    from_daemon.set_read_timeout(Some(Duration::from_millis(100)))?;
    let mut to_daemon = from_daemon.try_clone()?;
    let (eof_tx, eof_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match input.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if to_daemon.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = to_daemon.shutdown(Shutdown::Write);
        let _ = eof_tx.send(Instant::now());
    });

    let mut buf = [0u8; 16 * 1024];
    let mut input_closed: Option<Instant> = None;
    loop {
        if let Ok(at) = eof_rx.try_recv() {
            input_closed = Some(at);
        }
        if input_closed.is_some_and(|at| at.elapsed() >= EOF_DRAIN) {
            break;
        }
        match from_daemon.read(&mut buf) {
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => continue,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if output.write_all(&buf[..n]).and_then(|()| output.flush()).is_err() {
                    break;
                }
            }
        }
    }
    let _ = from_daemon.shutdown(Shutdown::Both);
    Ok(())
}

/// Runs the persistent daemon accept loop on `socket_path` until `"shutdown"` is requested
/// (or an empty daemon with no open project stays disconnected past [`EMPTY_IDLE_EXIT`]).
pub async fn serve(socket_path: &Path, host: Arc<Host>, dispatcher: Dispatcher, peer: Arc<PeerSlot>) -> io::Result<()> {
    if let Some(parent) = socket_path.parent() {
        ensure_private_dir(parent)?;
    }
    let _ = std::fs::remove_file(socket_path);
    let listener = tokio::net::UnixListener::bind(socket_path)?;
    let _ = std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600));

    let shutdown = CancellationToken::new();
    let mut active = tokio::task::JoinSet::new();
    let mut empty_check = tokio::time::interval(EMPTY_IDLE_EXIT);
    // Skip the immediate first tick so a newly spawned daemon waits for its starter.
    empty_check.tick().await;

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let (reader, writer) = stream.into_split();
                        let h = host.clone();
                        let d = dispatcher.clone();
                        let p = peer.clone();
                        let s = shutdown.clone();
                        active.spawn(async move {
                            rpc::serve_persistent(h, d, p, s, reader, writer).await;
                        });
                    }
                    Err(e) => {
                        tracing::warn!("daemon accept failed: {e}");
                        break;
                    }
                }
            }
            Some(_) = active.join_next(), if !active.is_empty() => {}
            _ = empty_check.tick() => {
                if !peer.has_client()
                    && host.projects().is_empty()
                    && host.terminals.list().is_empty()
                {
                    tracing::info!("idle empty openidea-server daemon exiting");
                    break;
                }
            }
        }
    }

    let _ = std::fs::remove_file(socket_path);
    active.abort_all();
    while active.join_next().await.is_some() {}
    Ok(())
}
