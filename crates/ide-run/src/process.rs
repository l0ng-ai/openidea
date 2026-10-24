//! Process lifecycle for run configurations: spawn, stream output, stdin, stop.

use crate::utf8::OutputDecoder;
use crate::{OutputChunk, RunConfig, RunInfo};
use ide_core::{IdeError, IdeEvent, IdeResult, RunId, SharedSink};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

const BATCH_INTERVAL: Duration = Duration::from_millis(8);
const BATCH_BYTES: usize = 64 * 1024;
/// After the main process exits, how long to wait for pipes still held by
/// orphaned descendants before reporting the exit.
const EXIT_DRAIN: Duration = Duration::from_millis(500);
/// Delay between SIGINT and SIGKILL on [`ProcessManager::stop`].
const STOP_GRACE: Duration = Duration::from_secs(3);
/// Finished runs kept for [`ProcessManager::list`].
const MAX_FINISHED: usize = 20;

struct Entry {
    id: RunId,
    config_id: String,
    name: String,
    pid: Option<u32>,
    stdin: Mutex<Option<ChildStdin>>,
    exited: AtomicBool,
    stopping: AtomicBool,
}

impl Entry {
    fn info(&self) -> RunInfo {
        RunInfo {
            id: self.id,
            config_id: self.config_id.clone(),
            name: self.name.clone(),
            pid: self.pid,
            running: !self.exited.load(Ordering::Acquire),
        }
    }
}

/// Per-start options taken from settings.
#[derive(Clone, Debug, Default)]
pub struct StartOptions {
    /// Output encoding label (`UTF-8`, `GBK`, `windows-1252`…); `None` = UTF-8.
    pub encoding: Option<String>,
}

#[derive(Default)]
pub struct ProcessManager {
    runs: Arc<Mutex<BTreeMap<RunId, Arc<Entry>>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stream {
    Stdout,
    Stderr,
}

enum Msg {
    Data(Stream, Vec<u8>),
    Exited(std::io::Result<ExitStatus>),
}

/// The program and arguments actually executed, plus the echoed command line.
pub(crate) struct Invocation {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Passed verbatim (Windows `cmd /S /C "…"`: cmd does not parse C runtime quoting).
    pub raw_args: bool,
    pub display: String,
}

const SHELL_CHARS: &[char] = &[
    '|', '&', ';', '<', '>', '(', ')', '$', '`', '\\', '"', '\'', '*', '?', '[', ']', '#', '~', '=', '%', '{', '}',
    '\n',
];

fn needs_quoting(s: &str) -> bool {
    s.is_empty() || s.contains(char::is_whitespace) || s.contains(SHELL_CHARS)
}

fn quote(s: &str) -> String {
    if !needs_quoting(s) {
        s.to_owned()
    } else if cfg!(windows) {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

pub(crate) fn invocation(config: &RunConfig, cwd: &Path) -> Invocation {
    let windows = cfg!(windows);
    let command = config.command.trim();
    let looks_like_shell = command.contains(char::is_whitespace) || command.contains(SHELL_CHARS);
    if config.args.is_empty() && looks_like_shell && !cwd.join(command).is_file() {
        return shell_invocation(command, windows, std::env::var("COMSPEC").ok());
    }
    let program = resolve_program(command, cwd, &config.env, windows);
    let mut display = quote(command);
    for a in &config.args {
        display.push(' ');
        display.push_str(&quote(a));
    }
    Invocation { program, args: config.args.clone(), raw_args: false, display }
}

/// `command` as one line for the platform shell: `/bin/sh -c`, or `cmd /D /S /C "…"`
/// (`/S` strips exactly the outer quotes, so the line's own quoting survives).
fn shell_invocation(command: &str, windows: bool, comspec: Option<String>) -> Invocation {
    if windows {
        return Invocation {
            program: comspec.filter(|c| !c.is_empty()).unwrap_or_else(|| "cmd.exe".into()).into(),
            args: vec!["/D".into(), "/S".into(), "/C".into(), format!("\"{command}\"")],
            raw_args: true,
            display: command.into(),
        };
    }
    Invocation {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), command.into()],
        raw_args: false,
        display: command.into(),
    }
}

/// The program to spawn: relative paths like `./gradlew` or `.venv/bin/python`
/// against the run directory; on Windows a bare name through `PATH` × `PATHEXT`
/// (`kotlinc` → `kotlinc.bat`), which `Command` would only try as `.exe`.
fn resolve_program(command: &str, cwd: &Path, env: &BTreeMap<String, String>, windows: bool) -> PathBuf {
    let path = Path::new(command);
    if path.is_relative() && path.components().count() > 1 {
        return cwd.join(path);
    }
    if windows && path.components().count() == 1 && path.is_relative() {
        let search = env
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
            .map(|(_, v)| std::ffi::OsString::from(v))
            .or_else(|| std::env::var_os("PATH"))
            .unwrap_or_default();
        let pathext = std::env::var("PATHEXT").ok();
        if let Some(found) = crate::which::find_executable_in(command, &search, true, pathext.as_deref()) {
            return found;
        }
    }
    path.to_path_buf()
}

fn resolve_cwd(root: &Path, cwd: Option<&Path>) -> PathBuf {
    match cwd {
        Some(c) if c.is_absolute() => c.to_path_buf(),
        Some(c) if !c.as_os_str().is_empty() => root.join(c),
        _ => root.to_path_buf(),
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a run; its `IdeEvent::RunExited` goes to `sink` (the starter's) only.
    pub fn start(
        &self,
        root: &Path,
        config: &RunConfig,
        options: &StartOptions,
        sink: SharedSink,
        on_output: Box<dyn Fn(OutputChunk) + Send + Sync>,
    ) -> IdeResult<RunInfo> {
        if config.command.trim().is_empty() {
            return Err(IdeError::invalid("run configuration has no command"));
        }
        let cwd = resolve_cwd(root, config.cwd.as_deref());
        if !cwd.is_dir() {
            return Err(IdeError::not_found(format!("working directory does not exist: {}", cwd.display())));
        }
        let inv = invocation(config, &cwd);

        let mut cmd = Command::new(&inv.program);
        if inv.raw_args {
            add_raw_args(&mut cmd, &inv.args);
        } else {
            cmd.args(&inv.args);
        }
        cmd.current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if matches!(config.kind.as_str(), "python" | "pytest") && !config.env.contains_key("PYTHONUNBUFFERED") {
            cmd.env("PYTHONUNBUFFERED", "1");
        }
        cmd.envs(&config.env);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | ide_core::process::CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => IdeError::unavailable(format!("command not found: {}", config.command)),
            _ => IdeError::from(e),
        })?;

        let id = RunId::next();
        let entry = Arc::new(Entry {
            id,
            config_id: config.id.clone(),
            name: config.name.clone(),
            pid: Some(child.id()),
            stdin: Mutex::new(child.stdin.take()),
            exited: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
        });
        self.register(entry.clone());

        on_output(OutputChunk::System { text: format!("{}\n", inv.display) });

        let (tx, rx) = mpsc::channel();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let result = (|| -> std::io::Result<()> {
            if let Some(out) = stdout {
                spawn_reader(id, Stream::Stdout, out, tx.clone())?;
            }
            if let Some(err) = stderr {
                spawn_reader(id, Stream::Stderr, err, tx.clone())?;
            }
            spawn_pump(rx, on_output, entry.clone(), sink, options.encoding.clone())?;
            Ok(())
        })();
        if let Err(e) = result {
            let _ = child.kill();
            let _ = child.wait();
            entry.exited.store(true, Ordering::Release);
            return Err(IdeError::internal(format!("failed to start output threads: {e}")));
        }
        // The waiter owns the child; it must exist for the pump to ever finish.
        let waiter_tx = tx;
        std::thread::Builder::new()
            .name(format!("openidea-run-wait-{}", id.0))
            .spawn(move || {
                let status = child.wait();
                let _ = waiter_tx.send(Msg::Exited(status));
            })
            .map_err(|e| IdeError::internal(format!("failed to start waiter thread: {e}")))?;

        tracing::debug!(%id, config = %config.id, pid = ?entry.pid, "run started");
        Ok(entry.info())
    }

    fn register(&self, entry: Arc<Entry>) {
        let mut runs = self.runs.lock();
        runs.retain(|_, e| !(e.config_id == entry.config_id && e.exited.load(Ordering::Acquire)));
        let finished: Vec<RunId> = runs.values().filter(|e| e.exited.load(Ordering::Acquire)).map(|e| e.id).collect();
        if finished.len() >= MAX_FINISHED {
            for id in &finished[..=finished.len() - MAX_FINISHED] {
                runs.remove(id);
            }
        }
        runs.insert(entry.id, entry);
    }

    fn entry(&self, id: RunId) -> IdeResult<Arc<Entry>> {
        self.runs.lock().get(&id).cloned().ok_or_else(|| IdeError::not_found(format!("no such run: {id}")))
    }

    pub fn write_stdin(&self, id: RunId, data: &str) -> IdeResult<()> {
        let entry = self.entry(id)?;
        if entry.exited.load(Ordering::Acquire) {
            return Err(IdeError::invalid("process has exited"));
        }
        let mut stdin = entry.stdin.lock();
        let pipe = stdin.as_mut().ok_or_else(|| IdeError::invalid("stdin is closed"))?;
        let res = pipe.write_all(data.as_bytes()).and_then(|_| pipe.flush());
        if let Err(e) = res {
            if e.kind() == std::io::ErrorKind::BrokenPipe {
                *stdin = None;
            }
            return Err(e.into());
        }
        Ok(())
    }

    /// Closes the process's stdin (sends EOF).
    pub fn close_stdin(&self, id: RunId) -> IdeResult<()> {
        self.entry(id)?.stdin.lock().take();
        Ok(())
    }

    /// Graceful stop (SIGINT, then SIGKILL after a timeout), whole process group.
    pub fn stop(&self, id: RunId) -> IdeResult<()> {
        self.stop_with_grace(id, STOP_GRACE)
    }

    /// [`Self::stop`] with an explicit grace period before the kill.
    pub fn stop_with_grace(&self, id: RunId, grace: Duration) -> IdeResult<()> {
        let entry = self.entry(id)?;
        if entry.exited.load(Ordering::Acquire) {
            return Ok(());
        }
        let Some(pid) = entry.pid else { return Ok(()) };
        if entry.stopping.swap(true, Ordering::AcqRel) {
            // Second stop request: don't wait out the grace period.
            kill_tree(pid, true);
            return Ok(());
        }
        kill_tree(pid, false);
        let entry = entry.clone();
        std::thread::Builder::new()
            .name(format!("openidea-run-stop-{}", id.0))
            .spawn(move || {
                let deadline = Instant::now() + grace;
                while Instant::now() < deadline {
                    if !group_alive(pid, &entry) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                if group_alive(pid, &entry) {
                    tracing::debug!(id = %entry.id, pid, "process ignored interrupt; killing");
                    kill_tree(pid, true);
                }
            })
            .map_err(|e| IdeError::internal(format!("failed to start stop thread: {e}")))?;
        Ok(())
    }

    pub fn list(&self) -> Vec<RunInfo> {
        self.runs.lock().values().map(|e| e.info()).collect()
    }
}

impl Drop for ProcessManager {
    fn drop(&mut self) {
        for entry in self.runs.lock().values() {
            if !entry.exited.load(Ordering::Acquire)
                && let Some(pid) = entry.pid
            {
                kill_tree(pid, true);
            }
        }
    }
}

#[cfg(unix)]
fn group_alive(pid: u32, _entry: &Entry) -> bool {
    // Signal 0 probes the group; it fails with ESRCH once every member is gone.
    unsafe { libc::kill(-(pid as libc::pid_t), 0) == 0 }
}

#[cfg(not(unix))]
fn group_alive(_pid: u32, entry: &Entry) -> bool {
    !entry.exited.load(Ordering::Acquire)
}

#[cfg(unix)]
fn kill_tree(pid: u32, force: bool) {
    let sig = if force { libc::SIGKILL } else { libc::SIGINT };
    let pid = pid as libc::pid_t;
    if pid <= 0 {
        return;
    }
    unsafe {
        if libc::kill(-pid, sig) != 0 {
            // Not a group leader after all (e.g. setpgid raced); signal the process itself.
            libc::kill(pid, sig);
        }
    }
}

#[cfg(windows)]
fn add_raw_args(cmd: &mut Command, args: &[String]) {
    use std::os::windows::process::CommandExt;
    for a in args {
        cmd.raw_arg(a);
    }
}

#[cfg(not(windows))]
fn add_raw_args(cmd: &mut Command, args: &[String]) {
    cmd.args(args);
}

#[cfg(windows)]
fn kill_tree(pid: u32, _force: bool) {
    use std::os::windows::process::CommandExt;
    // Console children have no reliable graceful signal from outside their console.
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(ide_core::process::CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn spawn_reader(
    id: RunId,
    stream: Stream,
    mut pipe: impl Read + Send + 'static,
    tx: Sender<Msg>,
) -> std::io::Result<()> {
    let label = if stream == Stream::Stdout { "out" } else { "err" };
    std::thread::Builder::new().name(format!("openidea-run-{label}-{}", id.0)).spawn(move || {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Msg::Data(stream, buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    })?;
    Ok(())
}

fn chunk(stream: Stream, text: String) -> OutputChunk {
    match stream {
        Stream::Stdout => OutputChunk::Stdout { text },
        Stream::Stderr => OutputChunk::Stderr { text },
    }
}

/// Merges both streams in arrival order, batching consecutive output of the same stream.
fn spawn_pump(
    rx: mpsc::Receiver<Msg>,
    on_output: Box<dyn Fn(OutputChunk) + Send + Sync>,
    entry: Arc<Entry>,
    sink: SharedSink,
    encoding: Option<String>,
) -> std::io::Result<()> {
    std::thread::Builder::new().name(format!("openidea-run-pump-{}", entry.id.0)).spawn(move || {
        let mut out_dec = OutputDecoder::for_label(encoding.as_deref());
        let mut err_dec = OutputDecoder::for_label(encoding.as_deref());
        let mut pending = String::new();
        let mut pending_stream = Stream::Stdout;
        let mut batch_started: Option<Instant> = None;
        let mut status: Option<std::io::Result<ExitStatus>> = None;
        let mut drain_deadline: Option<Instant> = None;

        let flush = |pending: &mut String, stream: Stream, started: &mut Option<Instant>| {
            if !pending.is_empty() {
                on_output(chunk(stream, std::mem::take(pending)));
            }
            *started = None;
        };

        loop {
            let now = Instant::now();
            let wait = [
                batch_started.map(|t| (t + BATCH_INTERVAL).saturating_duration_since(now)),
                drain_deadline.map(|t| t.saturating_duration_since(now)),
            ]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(Duration::from_secs(3600));
            match rx.recv_timeout(wait) {
                Ok(Msg::Data(stream, bytes)) => {
                    if stream != pending_stream {
                        flush(&mut pending, pending_stream, &mut batch_started);
                        pending_stream = stream;
                    }
                    let dec = if stream == Stream::Stdout { &mut out_dec } else { &mut err_dec };
                    dec.decode_into(&bytes, &mut pending);
                    if !pending.is_empty() && batch_started.is_none() {
                        batch_started = Some(Instant::now());
                    }
                    if pending.len() >= BATCH_BYTES {
                        flush(&mut pending, pending_stream, &mut batch_started);
                    }
                }
                Ok(Msg::Exited(s)) => {
                    status = Some(s);
                    drain_deadline = Some(Instant::now() + EXIT_DRAIN);
                }
                Err(RecvTimeoutError::Timeout) => {
                    if drain_deadline.is_some_and(|d| Instant::now() >= d) {
                        break;
                    }
                    if batch_started.is_some_and(|t| t.elapsed() >= BATCH_INTERVAL) {
                        flush(&mut pending, pending_stream, &mut batch_started);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        flush(&mut pending, pending_stream, &mut batch_started);
        for (stream, dec) in [(Stream::Stdout, &mut out_dec), (Stream::Stderr, &mut err_dec)] {
            let rest = dec.finish();
            if !rest.is_empty() {
                on_output(chunk(stream, rest));
            }
        }

        let (code, message) = describe_exit(status);
        on_output(OutputChunk::System { text: format!("\n{message}\n") });
        entry.stdin.lock().take();
        entry.exited.store(true, Ordering::Release);
        tracing::debug!(id = %entry.id, ?code, "run exited");
        sink.emit(IdeEvent::RunExited { run: entry.id, code });
    })?;
    Ok(())
}

#[cfg(unix)]
fn signal_name(sig: i32) -> &'static str {
    match sig {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        _ => "signal",
    }
}

/// IDEA wording: `Process finished with exit code 130 (interrupted by signal 2:SIGINT)`.
fn describe_exit(status: Option<std::io::Result<ExitStatus>>) -> (Option<i32>, String) {
    match status {
        Some(Ok(s)) => {
            if let Some(code) = s.code() {
                return (Some(code), format!("Process finished with exit code {code}"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if let Some(sig) = s.signal() {
                    let code = 128 + sig;
                    return (
                        Some(code),
                        format!(
                            "Process finished with exit code {code} (interrupted by signal {sig}:{})",
                            signal_name(sig)
                        ),
                    );
                }
            }
            (None, "Process finished".to_owned())
        }
        Some(Err(e)) => (None, format!("Process finished with unknown exit status: {e}")),
        None => (None, "Process finished".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_lines_use_cmd_verbatim_on_windows() {
        let line = r#"(if not exist "C:\T\openidea-run" mkdir "C:\T\openidea-run") && "C:\Program Files\rustc.exe" -o "C:\T\openidea-run\hi.exe" hi.rs"#;
        let inv = shell_invocation(line, true, Some(r"C:\Windows\system32\cmd.exe".into()));
        assert_eq!(inv.program, PathBuf::from(r"C:\Windows\system32\cmd.exe"));
        assert_eq!(inv.args, ["/D", "/S", "/C", &format!("\"{line}\"")]);
        assert!(inv.raw_args);
        assert_eq!(inv.display, line);
        assert_eq!(shell_invocation("dir", true, None).program, PathBuf::from("cmd.exe"));
        assert_eq!(shell_invocation("dir", true, Some(String::new())).program, PathBuf::from("cmd.exe"));

        let unix = shell_invocation("mkdir -p /tmp/x && cc -o /tmp/x/a a.c", false, None);
        assert_eq!(unix.program, PathBuf::from("/bin/sh"));
        assert_eq!(unix.args, ["-c", "mkdir -p /tmp/x && cc -o /tmp/x/a a.c"]);
        assert!(!unix.raw_args);
    }

    #[test]
    fn resolves_bare_names_through_pathext_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("kotlinc.bat"), "@echo off\n").unwrap();
        let cwd = dir.path();
        let path = std::env::join_paths([&bin]).unwrap().to_string_lossy().into_owned();
        // Windows environment keys are case-insensitive (`Path`).
        let env = BTreeMap::from([("Path".to_owned(), path)]);
        assert_eq!(resolve_program("kotlinc", cwd, &env, true), bin.join("kotlinc.bat"));
        // Not found: left to the OS (`command not found` at spawn).
        assert_eq!(resolve_program("nope", cwd, &env, true), PathBuf::from("nope"));
        // Unix: bare names are left to `execvp`.
        assert_eq!(resolve_program("kotlinc", cwd, &env, false), PathBuf::from("kotlinc"));
        // Relative paths resolve against the run directory on every platform.
        assert_eq!(resolve_program("./gradlew", cwd, &env, true), cwd.join("./gradlew"));
        assert_eq!(resolve_program(".venv/bin/python", cwd, &env, false), cwd.join(".venv/bin/python"));
    }
}
