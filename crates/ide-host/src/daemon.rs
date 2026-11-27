//! Persistent per-project `openidea-server` daemon over a local Unix domain socket.
//!
//! * `openidea-server --attach <project_path>` connects to the daemon for `<project_path>`
//!   (spawning it detached in a new session if none is listening) and bridges its own
//!   stdin / stdout to the Unix socket. Closing the desktop window ends the SSH / WSL /
//!   `docker exec` attach relay while the daemon — and its index, language servers,
//!   terminals, runs and agent sessions — keeps running.
//! * `openidea-server --daemon <socket_path> <build>` is the process `--attach` starts.

use crate::Host;
use crate::rpc::{self, Dispatcher, PeerSlot, RemoteIdlePolicy};
use ide_core::CancellationToken;
use rustix::fs::{FlockOperation, flock};
use std::fs::{File, OpenOptions};
use std::future::{Future, pending};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::Shutdown;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::signal::unix::{SignalKind, signal};

/// Keep socket paths well below macOS (104) and Linux (108) `sun_path` limits.
const MAX_SUN_PATH: usize = 96;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
const EOF_DRAIN: Duration = Duration::from_secs(2);
const EMPTY_IDLE_EXIT: Duration = Duration::from_secs(30);
const IDLE_ENV: &str = "OPENIDEA_SERVER_IDLE_TIMEOUT_SECONDS";
pub type BuildId = [u8; 16];
const ATTACHED: u8 = b'A';
const RETIRING: u8 = b'R';
const BUSY: u8 = b'B';

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

/// Deterministic socket, lock and log paths for a project and server home, across builds.
pub fn paths_for(base: &Path, home: &Path, raw_project_path: &str) -> io::Result<DaemonPaths> {
    let project = normalize_project_path(raw_project_path, home);
    std::fs::create_dir_all(base)?;
    let base_canon = dunce::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
    let mut hasher = blake3::Hasher::new();
    hasher.update(project.as_os_str().as_encoded_bytes());
    hasher.update(&[0]);
    hasher.update(base_canon.as_os_str().as_encoded_bytes());
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
/// `input` / `output` to its Unix socket. With `replace`, a daemon of another build that
/// refuses to retire is stopped first.
pub fn attach(
    base: &Path,
    home: &Path,
    project_path: &str,
    replace: bool,
    input: impl Read + Send + 'static,
    output: impl Write,
) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate openidea-server: {e}"))?;
    let paths = paths_for(base, home, project_path).map_err(|e| format!("cannot prepare runtime dir: {e}"))?;
    let mut hasher = blake3::Hasher::new();
    hasher
        .update_reader(File::open(&exe).map_err(|e| format!("cannot open openidea-server: {e}"))?)
        .map_err(|e| format!("cannot identify openidea-server build: {e}"))?;
    let hex = hasher.finalize().to_hex();
    let build = &hex.as_str()[..16];
    let stream = connect_or_spawn(&exe, &paths, build, replace)?;
    bridge(stream, input, output).map_err(|e| format!("daemon relay failed: {e}"))
}

fn connect_or_spawn(exe: &Path, paths: &DaemonPaths, build: &str, replace: bool) -> Result<UnixStream, String> {
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

    match existing_daemon(paths, build) {
        Ok(Some(stream)) => return Ok(stream),
        Ok(None) => {}
        Err(e) if replace && e.contains(rpc::OTHER_BUILD_BUSY) => stop_daemon(&paths.socket)?,
        Err(e) => return Err(e),
    }

    match std::fs::remove_file(&paths.socket) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot remove stale socket {}: {e}", paths.socket.display())),
    }
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
    cmd.arg("--daemon")
        .arg(&paths.socket)
        .arg(build)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file));
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
    loop {
        if let Some(stream) = existing_daemon(paths, build)? {
            return Ok(stream);
        }
        if let Ok(Some(status)) = child.try_wait() {
            let tail = read_log_tail(&mut log_file, log_offset);
            let detail = if tail.is_empty() { format!("exited with {status}") } else { tail };
            return Err(format!("openidea-server daemon failed to start: {detail}"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let tail = read_log_tail(&mut log_file, log_offset);
            let detail = if tail.is_empty() { "timed out waiting for socket".to_owned() } else { tail };
            return Err(format!("openidea-server daemon did not start: {detail}"));
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

fn existing_daemon(paths: &DaemonPaths, build: &str) -> Result<Option<UnixStream>, String> {
    let exchange = |mut stream: UnixStream| -> io::Result<Option<UnixStream>> {
        stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
        stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
        stream.write_all(build.as_bytes())?;
        let mut reply = [0];
        stream.read_exact(&mut reply)?;
        match reply[0] {
            ATTACHED => {
                stream.set_read_timeout(None)?;
                stream.set_write_timeout(None)?;
                Ok(Some(stream))
            }
            RETIRING => {
                // This stream stays open until project cleanup and socket removal finish.
                stream.set_read_timeout(Some(rpc::SHUTDOWN_TIMEOUT))?;
                if stream.read(&mut reply)? == 0 {
                    Ok(None)
                } else {
                    Err(io::Error::other("unexpected response from stopping daemon"))
                }
            }
            BUSY => Err(io::Error::other(rpc::OTHER_BUILD_BUSY)),
            _ => Err(io::Error::other("unrecognized remote backend response")),
        }
    };
    let stream = match UnixStream::connect(&paths.socket) {
        Ok(stream) => stream,
        Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused) => return Ok(None),
        Err(e) => return Err(format!("cannot connect to remote backend at {}: {e}", paths.socket.display())),
    };
    exchange(stream).map_err(|e| format!("cannot attach to {}: {e}", paths.socket.display()))
}

/// Stops the daemon serving `socket` (another build's, which refused to retire): asks it to
/// shut down like the remote Stop Backend action does, and kills it if it hasn't after a while.
fn stop_daemon(socket: &Path) -> Result<(), String> {
    let pids = daemon_pids(socket)?;
    if pids.is_empty() {
        return Err(format!("cannot find the backend serving {}", socket.display()));
    }
    let signal = |sig| {
        for pid in &pids {
            if let Some(pid) = rustix::process::Pid::from_raw(*pid) {
                let _ = rustix::process::kill_process(pid, sig);
            }
        }
    };
    let alive = || pids.iter().any(|pid| process_exists(*pid));
    signal(rustix::process::Signal::TERM);
    let deadline = Instant::now() + rpc::SHUTDOWN_TIMEOUT;
    while alive() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if alive() {
        signal(rustix::process::Signal::KILL);
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

/// Whether `pid` still runs: an exited process its parent hasn't reaped yet (a zombie) doesn't.
fn process_exists(pid: i32) -> bool {
    if !rustix::process::Pid::from_raw(pid).is_some_and(|pid| rustix::process::test_kill_process(pid).is_ok()) {
        return false;
    }
    Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .map_or(true, |out| !String::from_utf8_lossy(&out.stdout).trim_start().starts_with('Z'))
}

/// Processes started as `openidea-server --daemon <socket> <build>`.
fn daemon_pids(socket: &Path) -> Result<Vec<i32>, String> {
    let out = Command::new("ps")
        .args(["-axww", "-o", "pid=", "-o", "args="])
        .output()
        .map_err(|e| format!("cannot list processes: {e}"))?;
    Ok(daemon_pids_in(&String::from_utf8_lossy(&out.stdout), &socket.to_string_lossy()))
}

fn daemon_pids_in(ps: &str, socket: &str) -> Vec<i32> {
    ps.lines()
        .filter_map(|line| {
            let (pid, args) = line.trim_start().split_once(char::is_whitespace)?;
            let mut words = args.split_whitespace().skip_while(|w| *w != "--daemon").skip(1);
            (words.next() == Some(socket)).then(|| pid.parse().ok()).flatten()
        })
        .collect()
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

/// The socket remains bound until cleanup finishes, so an attach can't start a
/// replacement while the previous backend is still stopping its processes.
pub async fn serve(
    socket_path: &Path,
    build: BuildId,
    host: Arc<Host>,
    dispatcher: Dispatcher,
    slot: Arc<PeerSlot>,
    cleanup: impl Future<Output = ()>,
) -> io::Result<()> {
    let start = || {
        if let Some(parent) = socket_path.parent() {
            ensure_private_dir(parent)?;
        }
        let terminate = signal(SignalKind::terminate())?;
        let listener = tokio::net::UnixListener::bind(socket_path)?;
        if let Err(e) = std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600)) {
            let _ = std::fs::remove_file(socket_path);
            return Err(e);
        }
        Ok((listener, terminate))
    };
    let (listener, mut terminate) = match start() {
        Ok(started) => started,
        Err(e) => {
            cleanup.await;
            return Err(e);
        }
    };

    let shutdown = CancellationToken::new();
    let idle_policy = RemoteIdlePolicy { override_seconds: idle_override() };
    let mut check = tokio::time::interval(Duration::from_secs(idle_policy.override_seconds.unwrap_or(5).min(5)));
    let mut idle = None;
    let mut retiring = None;
    let mut active: Option<ide_jsonrpc::Peer> = None;

    let result = loop {
        tokio::select! {
            _ = shutdown.cancelled() => break Ok(()),
            _ = terminate.recv() => break Ok(()),
            _ = async {
                match &active {
                    Some(peer) => { peer.closed().await; }
                    None => pending().await,
                }
            } => {
                active = None;
                slot.remove();
                host.client_disconnected();
                idle = None;
            }
            accepted = listener.accept() => {
                let mut stream = match accepted {
                    Ok((stream, _)) => stream,
                    Err(e) => break Err(e),
                };
                let mut requested_build = [0; 16];
                if !matches!(
                    tokio::time::timeout(HANDSHAKE_TIMEOUT, stream.read_exact(&mut requested_build)).await,
                    Ok(Ok(_))
                ) {
                    continue;
                }
                if active.as_ref().is_some_and(ide_jsonrpc::Peer::is_closed) {
                    active = None;
                    slot.remove();
                    host.client_disconnected();
                    idle = None;
                }
                if shutdown.is_cancelled() {
                    break Ok(());
                }
                if requested_build != build {
                    let busy = active.is_some() || has_live_work(&host);
                    if busy {
                        let _ = stream.write_u8(BUSY).await;
                    } else if stream.write_u8(RETIRING).await.is_ok() {
                        retiring = Some(stream);
                        break Ok(());
                    }
                    continue;
                }
                if stream.write_u8(ATTACHED).await.is_err() {
                    continue;
                }
                if let Some(old) = slot.remove() {
                    // Await an acknowledgement before tearing down the old transport.
                    let _ = tokio::time::timeout(
                        Duration::from_millis(750),
                        old.request::<_, ()>(rpc::SESSION_REPLACED, (), None),
                    ).await;
                    old.kill();
                    host.client_disconnected();
                }
                let (reader, writer) = stream.into_split();
                active = Some(rpc::connect_persistent(
                    host.clone(), dispatcher.clone(), slot.clone(), shutdown.clone(), idle_policy, reader, writer,
                ));
                idle = None;
            }
            _ = check.tick() => {
                if active.is_some() || has_live_work(&host) {
                    idle = None;
                } else {
                    if idle.is_none() {
                        let since = Instant::now();
                        let timeout = match disconnected_timeout(&host, idle_policy).await {
                            Ok(timeout) => timeout,
                            Err(e) => break Err(e),
                        };
                        idle = Some((since, timeout));
                    }
                    if let Some((since, Some(timeout))) = idle && since.elapsed() >= timeout {
                        tracing::info!("idle openidea-server daemon exiting");
                        break Ok(());
                    }
                }
            }
        }
    };

    shutdown.cancel();
    slot.remove();
    if let Some(peer) = &active {
        let _ = tokio::time::timeout(HANDSHAKE_TIMEOUT, peer.flush()).await;
        host.client_disconnected();
    }
    cleanup.await;
    if let Err(e) = std::fs::remove_file(socket_path) {
        tracing::warn!("cannot remove remote backend socket {}: {e}", socket_path.display());
    }
    if let Some(active) = active {
        active.kill();
    }
    drop(retiring);
    result
}

fn idle_override() -> Option<u64> {
    if let Some(value) = std::env::var_os(IDLE_ENV) {
        if let Some(seconds) = value.to_str().and_then(|s| s.parse::<u64>().ok()).filter(|&n| n > 0) {
            return Some(seconds);
        }
        tracing::warn!("{IDLE_ENV} must be a positive number of seconds; using the host setting");
    }
    None
}

async fn disconnected_timeout(host: &Arc<Host>, policy: RemoteIdlePolicy) -> io::Result<Option<Duration>> {
    let override_timeout = policy.override_seconds.map(Duration::from_secs);
    if host.projects().is_empty() {
        return Ok(Some(override_timeout.unwrap_or(EMPTY_IDLE_EXIT).min(EMPTY_IDLE_EXIT)));
    }
    if let Some(timeout) = override_timeout {
        return Ok(Some(timeout));
    }
    let minutes = crate::ops::project::remote_idle_timeout_minutes(host).await.map_err(io::Error::other)?;
    Ok((minutes != 0).then(|| Duration::from_secs(u64::from(minutes) * 60)))
}

/// Keeps a disconnected daemon alive: expiring would end this work, or lose the unsaved
/// edits a dropped connection left behind.
fn has_live_work(host: &Host) -> bool {
    !host.terminals.list().is_empty()
        || host.processes.has_live_runs()
        || !host.debugger.sessions(None).is_empty()
        || host
            .projects()
            .iter()
            .any(|project| project.agents.has_live_work() || project.documents.has_unsaved_changes())
}

#[cfg(test)]
mod tests {
    use super::daemon_pids_in;

    #[test]
    fn finds_the_daemon_of_a_socket_in_the_process_list() {
        let ps = "    1 /sbin/init\n\
                  581660 /root/.openidea/server/0.1.51/634a/openidea-server --daemon /root/.openidea/run/s-de2d.sock 634a\n\
                  141712 /root/.openidea/server/0.1.53/e116/openidea-server --daemon /root/.openidea/run/s-a67f.sock e116\n\
                  582484 /bin/bash --init-file /tmp/openidea-shell-integration-0.1.51/bash/openidea.bashrc -i\n\
                  590000 grep --daemon /root/.openidea/run/s-de2d.sock.bak\n";
        assert_eq!(daemon_pids_in(ps, "/root/.openidea/run/s-de2d.sock"), [581660]);
        assert!(daemon_pids_in(ps, "/root/.openidea/run/s-none.sock").is_empty());
    }
}
