//! Thin wrapper around the `git` executable used for every mutating operation.

use ide_core::{CancellationToken, IdeError, IdeResult};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::Duration;

/// Explicit git executable from Settings › Version Control › Git (`None` = auto-detect).
static CONFIGURED: std::sync::RwLock<Option<PathBuf>> = std::sync::RwLock::new(None);

/// Sets (or clears, with `None` / an empty path) the git executable to use.
pub fn set_git_executable(path: Option<&Path>) {
    let path = path.filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf);
    if *CONFIGURED.read().unwrap_or_else(|e| e.into_inner()) != path {
        *CONFIGURED.write().unwrap_or_else(|e| e.into_inner()) = path;
    }
}

/// Environment that routes credential prompts (`ssh` passphrases and host keys,
/// HTTPS user names and passwords) to the UI; empty = prompts fail.
static ASKPASS: std::sync::RwLock<Vec<(String, String)>> = std::sync::RwLock::new(Vec::new());

pub fn set_askpass_env(env: Vec<(String, String)>) {
    *ASKPASS.write().unwrap_or_else(|e| e.into_inner()) = env;
}

/// Called once per git child with its id, success flag, and stderr.
pub type GitCommandObserver = std::sync::Arc<dyn Fn(u64, bool, &str) + Send + Sync>;

static COMMAND_OBSERVER: std::sync::RwLock<Option<(&'static str, GitCommandObserver)>> = std::sync::RwLock::new(None);

/// Installs the completion observer and the environment variable carrying each
/// child's unique id to its credential helper.
pub fn set_git_command_observer(env_name: &'static str, observer: GitCommandObserver) {
    *COMMAND_OBSERVER.write().unwrap_or_else(|e| e.into_inner()) = Some((env_name, observer));
}

struct CommandSession {
    id: u64,
    observer: Option<GitCommandObserver>,
}

impl CommandSession {
    fn start(cmd: &mut Command) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let hook = COMMAND_OBSERVER.read().unwrap_or_else(|e| e.into_inner()).clone();
        let observer = hook.map(|(env_name, observer)| {
            cmd.env(env_name, id.to_string());
            observer
        });
        Self { id, observer }
    }

    fn finish(&mut self, success: bool, stderr: &str) {
        if let Some(observer) = self.observer.take() {
            observer(self.id, success, stderr);
        }
    }
}

impl Drop for CommandSession {
    fn drop(&mut self) {
        // Cancellation or an I/O error discards only this child's pending answers.
        self.finish(false, "");
    }
}

/// Locates the auto-detected git executable once per process.
///
/// GUI apps on macOS start with a minimal `PATH`, so a few well-known install
/// locations are probed after the `PATH` lookup.
fn detected_git() -> Option<&'static Path> {
    static GIT: OnceLock<Option<PathBuf>> = OnceLock::new();
    GIT.get_or_init(|| {
        if let Some(explicit) = std::env::var_os("OPENIDEA_GIT").map(PathBuf::from).filter(|p| p.is_file()) {
            return Some(explicit);
        }
        if let Ok(found) = which::which("git") {
            return Some(found);
        }
        let candidates: &[&str] = if cfg!(windows) {
            &[r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files (x86)\Git\cmd\git.exe"]
        } else {
            &["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git", "/bin/git"]
        };
        candidates.iter().map(PathBuf::from).find(|p| p.is_file())
    })
    .as_deref()
}

/// The auto-detected git executable, if any.
pub fn detected_git_executable() -> Option<PathBuf> {
    detected_git().map(Path::to_path_buf)
}

pub(crate) fn git_binary() -> IdeResult<PathBuf> {
    if let Some(configured) = CONFIGURED.read().unwrap_or_else(|e| e.into_inner()).clone() {
        return Ok(configured);
    }
    detected_git()
        .map(Path::to_path_buf)
        .ok_or_else(|| IdeError::unavailable("git executable not found; install git and make sure it is on PATH"))
}

/// `git --version` of `executable` (or the configured / detected one), e.g. `git version 2.44.0`.
pub fn git_version(executable: Option<&Path>) -> IdeResult<String> {
    let exe = match executable.filter(|p| !p.as_os_str().is_empty()) {
        Some(p) => p.to_path_buf(),
        None => git_binary()?,
    };
    let mut cmd = Command::new(&exe);
    cmd.arg("--version").stdin(Stdio::null()).env("LC_ALL", "C");
    ide_core::process::prepare(&mut cmd);
    let out = cmd.output().map_err(|e| IdeError::unavailable(format!("cannot run {}: {e}", exe.display())))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || !text.starts_with("git version") {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(IdeError::invalid(format!(
            "{} is not a git executable{}",
            exe.display(),
            if err.is_empty() { String::new() } else { format!(": {err}") }
        )));
    }
    Ok(text)
}

/// Builds a `git` command with the environment every invocation needs.
pub(crate) fn command(root: &Path) -> IdeResult<Command> {
    let mut cmd = Command::new(git_binary()?);
    cmd.current_dir(root)
        .arg("-c")
        .arg("core.quotepath=off")
        .arg("-c")
        .arg("color.ui=false")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("GIT_PAGER", "cat")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    for (k, v) in ASKPASS.read().unwrap_or_else(|e| e.into_inner()).iter() {
        cmd.env(k, v);
    }
    ide_core::process::prepare(&mut cmd);
    Ok(cmd)
}

pub(crate) struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: Option<i32>,
}

impl Output {
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// Runs git to completion, optionally feeding `stdin`. Never fails on a non-zero exit.
pub(crate) fn run_raw(root: &Path, args: &[&str], stdin: Option<&[u8]>) -> IdeResult<Output> {
    run_raw_env(root, args, stdin, &[])
}

/// [`run_raw`] with extra environment variables (e.g. a temporary `GIT_INDEX_FILE`).
pub(crate) fn run_raw_env(
    root: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    env: &[(&str, &std::ffi::OsStr)],
) -> IdeResult<Output> {
    let mut cmd = command(root)?;
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.args(args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    tracing::debug!(?args, "git");
    let mut session = CommandSession::start(&mut cmd);
    let mut child = cmd.spawn().map_err(spawn_error)?;
    let writer = match (stdin, child.stdin.take()) {
        (Some(data), Some(mut pipe)) => {
            let data = data.to_vec();
            Some(std::thread::spawn(move || {
                // A broken pipe just means git stopped reading early; its exit status tells the story.
                let _ = pipe.write_all(&data);
            }))
        }
        _ => None,
    };
    let out = child.wait_with_output()?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    session.finish(out.status.success(), &String::from_utf8_lossy(&out.stderr));
    Ok(Output { stdout: out.stdout, stderr: out.stderr, code: out.status.code() })
}

/// Runs git and maps a non-zero exit status to an error carrying git's message.
pub(crate) fn run(root: &Path, args: &[&str], stdin: Option<&[u8]>) -> IdeResult<Output> {
    let out = run_raw(root, args, stdin)?;
    if out.code == Some(0) { Ok(out) } else { Err(failure(args, &out.stderr, &out.stdout, out.code)) }
}

/// [`run`] with extra environment variables.
pub(crate) fn run_env(
    root: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    env: &[(&str, &std::ffi::OsStr)],
) -> IdeResult<Output> {
    let out = run_raw_env(root, args, stdin, env)?;
    if out.code == Some(0) { Ok(out) } else { Err(failure(args, &out.stderr, &out.stdout, out.code)) }
}

fn spawn_error(e: std::io::Error) -> IdeError {
    if e.kind() == std::io::ErrorKind::NotFound {
        IdeError::unavailable(format!("could not run git: {e}"))
    } else {
        e.into()
    }
}

pub(crate) fn failure(args: &[&str], stderr: &[u8], stdout: &[u8], code: Option<i32>) -> IdeError {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let mut msg = if stderr.is_empty() {
        stdout.clone()
    } else {
        // Merge/rebase/stash report conflicts on stdout; keep them next to the error.
        let conflicts: Vec<&str> = stdout.lines().filter(|l| l.starts_with("CONFLICT")).collect();
        if conflicts.is_empty() { stderr } else { format!("{}\n{stderr}", conflicts.join("\n")) }
    };
    if msg.is_empty() {
        let sub = subcommand(args);
        msg = match code {
            Some(c) => format!("git {sub} failed with exit code {c}"),
            None => format!("git {sub} was terminated"),
        };
    }
    IdeError::new(classify(&msg), msg)
}

fn subcommand<'a>(args: &[&'a str]) -> &'a str {
    let mut skip_next = false;
    for a in args {
        if skip_next {
            skip_next = false;
        } else if *a == "-c" {
            skip_next = true;
        } else if !a.starts_with('-') {
            return a;
        }
    }
    "git"
}

fn classify(msg: &str) -> ide_core::error::ErrorKind {
    use ide_core::error::ErrorKind;
    let lower = msg.to_ascii_lowercase();
    if lower.contains("did not match any file")
        || lower.contains("unknown revision")
        || lower.contains("not found")
        || lower.contains("does not exist")
    {
        ErrorKind::NotFound
    } else if lower.contains("already exists") {
        ErrorKind::AlreadyExists
    } else if lower.contains("permission denied") {
        ErrorKind::PermissionDenied
    } else {
        ErrorKind::Internal
    }
}

/// Runs a (network) command, streaming every progress line to `on_output`.
///
/// Lines are split on both `\r` and `\n` so git's in-place progress counters arrive
/// as separate updates. The child (and, on Unix, its whole process group — ssh,
/// remote helpers) is killed promptly once `cancel` fires.
pub(crate) fn run_streaming(
    root: &Path,
    args: &[&str],
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    run_streaming_env(root, args, &[], cancel, on_output)
}

/// [`run_streaming`] with extra environment variables (e.g. a sequence editor).
pub(crate) fn run_streaming_env(
    root: &Path,
    args: &[&str],
    env: &[(&str, &std::ffi::OsStr)],
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let mut cmd = command(root)?;
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    tracing::debug!(?args, "git (streaming)");
    let mut session = CommandSession::start(&mut cmd);
    let mut child = cmd.spawn().map_err(spawn_error)?;

    let (tx, rx) = mpsc::channel::<Event>();
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        readers.push(spawn_reader(out, tx.clone(), Stream::Stdout));
    }
    if let Some(err) = child.stderr.take() {
        readers.push(spawn_reader(err, tx.clone(), Stream::Stderr));
    }
    drop(tx);

    // Keep the tail of stderr (and stdout conflict reports) for the error message.
    let mut stderr_tail: Vec<String> = Vec::new();
    let mut conflicts: Vec<String> = Vec::new();
    let mut open = readers.len();
    while open > 0 {
        if cancel.is_cancelled() {
            kill(&mut child);
            let _ = child.wait();
            for r in readers {
                let _ = r.join();
            }
            return Err(IdeError::cancelled());
        }
        match rx.recv_timeout(Duration::from_millis(40)) {
            Ok(Event::Line(stream, line)) => {
                if stream == Stream::Stderr {
                    stderr_tail.push(line.clone());
                    if stderr_tail.len() > 40 {
                        stderr_tail.remove(0);
                    }
                } else if line.starts_with("CONFLICT") && conflicts.len() < 40 {
                    conflicts.push(line.clone());
                }
                on_output(line);
            }
            Ok(Event::Closed) => open -= 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // Pipes are closed; the process is exiting. Still honour cancellation while waiting.
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancel.is_cancelled() {
            kill(&mut child);
            let _ = child.wait();
            return Err(IdeError::cancelled());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    for r in readers {
        let _ = r.join();
    }
    if status.success() {
        session.finish(true, &stderr_tail.join("\n"));
        return Ok(());
    }
    let relevant: Vec<&str> =
        conflicts.iter().chain(stderr_tail.iter()).map(String::as_str).filter(|l| !is_progress_line(l)).collect();
    let msg = relevant.join("\n");
    session.finish(false, &stderr_tail.join("\n"));
    Err(failure(args, msg.as_bytes(), b"", status.code()))
}

fn is_progress_line(line: &str) -> bool {
    let progress_prefixes = [
        "remote: Counting",
        "remote: Compressing",
        "remote: Enumerating",
        "remote: Total",
        "Counting objects",
        "Compressing objects",
        "Enumerating objects",
        "Receiving objects",
        "Resolving deltas",
        "Writing objects",
        "Delta compression",
        "Unpacking objects",
    ];
    progress_prefixes.iter().any(|p| line.starts_with(p))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stream {
    Stdout,
    Stderr,
}

enum Event {
    Line(Stream, String),
    Closed,
}

fn spawn_reader(
    mut pipe: impl Read + Send + 'static,
    tx: mpsc::Sender<Event>,
    stream: Stream,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let flush = |pending: &mut Vec<u8>| {
            if !pending.is_empty() {
                let line = String::from_utf8_lossy(pending).trim_end().to_string();
                pending.clear();
                if !line.is_empty() {
                    let _ = tx.send(Event::Line(stream, line));
                }
            }
        };
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &b in &buf[..n] {
                        if b == b'\n' || b == b'\r' {
                            flush(&mut pending);
                        } else {
                            pending.push(b);
                        }
                    }
                }
            }
        }
        flush(&mut pending);
        let _ = tx.send(Event::Closed);
    })
}

fn kill(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        // SAFETY: plain syscall; the child was spawned as leader of its own process group.
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(20));
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

#[cfg(test)]
mod command_session_tests {
    use super::*;

    #[test]
    fn command_ids_reach_children_and_completion_is_once_per_session() {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = events.clone();
        set_git_command_observer(
            "OPENIDEA_TEST_COMMAND_ID",
            std::sync::Arc::new(move |id, success, stderr| {
                seen.lock().unwrap().push((id, success, stderr.to_owned()));
            }),
        );
        let mut first_cmd = Command::new("git");
        let mut second_cmd = Command::new("git");
        let mut first = CommandSession::start(&mut first_cmd);
        let second = CommandSession::start(&mut second_cmd);
        let (first_id, second_id) = (first.id, second.id);
        assert_ne!(first_id, second_id);
        for (cmd, id) in [(&first_cmd, first_id), (&second_cmd, second_id)] {
            let value = cmd.get_envs().find(|(key, _)| *key == "OPENIDEA_TEST_COMMAND_ID").unwrap().1.unwrap();
            assert_eq!(value, std::ffi::OsStr::new(&id.to_string()));
        }
        drop(second); // cancellation discards this command's state
        first.finish(true, "done");
        drop(first);
        let events = events.lock().unwrap();
        let ours: Vec<_> = events.iter().filter(|(id, _, _)| *id == first_id || *id == second_id).cloned().collect();
        assert_eq!(ours, vec![(second_id, false, String::new()), (first_id, true, "done".into())]);
    }
}
