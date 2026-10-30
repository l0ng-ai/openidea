//! Child processes of the docker CLI: bounded runs and cancellable line streams.

use ide_core::{CancellationToken, IdeError, IdeResult};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub(crate) struct Output {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stream {
    Stdout,
    Stderr,
}

fn prepare(cmd: &mut Command) {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    ide_core::process::prepare(cmd);
}

fn spawn(cmd: &mut Command) -> IdeResult<Child> {
    cmd.spawn().map_err(|e| IdeError::unavailable(format!("could not run docker: {e}")))
}

/// Kills the child and, on Unix, its whole process group (CLI plugins such as compose).
pub(crate) fn kill(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        // SAFETY: plain syscall; the child leads its own process group (`prepare`).
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(20));
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn read_all(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        ide_core::output_encoding::decode_tool_output(&buf)
    })
}

/// Runs `cmd` to completion. Fails when it outlives `timeout` or `cancel` fires;
/// a non-zero exit is reported in [`Output::success`], not as an error.
pub(crate) fn run(cmd: Command, timeout: Duration, cancel: Option<&CancellationToken>) -> IdeResult<Output> {
    run_with_input(cmd, timeout, cancel, None)
}

/// [`run`] with `input` written to the child's stdin (e.g. `--password-stdin`).
pub(crate) fn run_with_input(
    mut cmd: Command,
    timeout: Duration,
    cancel: Option<&CancellationToken>,
    input: Option<&str>,
) -> IdeResult<Output> {
    prepare(&mut cmd);
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = spawn(&mut cmd)?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        // Dropping `stdin` afterwards closes it, so the CLI sees EOF.
        let _ = std::io::Write::write_all(&mut stdin, text.as_bytes());
    }
    let out = child.stdout.take().map(read_all);
    let err = child.stderr.take().map(read_all);
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            kill(&mut child);
            return Err(IdeError::cancelled());
        }
        if Instant::now() >= deadline {
            kill(&mut child);
            return Err(IdeError::unavailable("docker did not respond in time"));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    Ok(Output {
        stdout: out.map(|t| t.join().unwrap_or_default()).unwrap_or_default(),
        stderr: err.map(|t| t.join().unwrap_or_default()).unwrap_or_default(),
        success: status.success(),
    })
}

enum Event {
    Line(Stream, String),
    Closed,
}

fn spawn_reader(mut pipe: impl Read + Send + 'static, tx: mpsc::Sender<Event>, stream: Stream) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let flush = |pending: &mut Vec<u8>| {
            if !pending.is_empty() {
                let line = ide_core::output_encoding::decode_tool_output(pending).trim_end().to_string();
                pending.clear();
                let _ = tx.send(Event::Line(stream, line));
            }
        };
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &b in &buf[..n] {
                        // `\r` too: pull / build progress rewrites its line in place.
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
    });
}

/// Runs `cmd`, handing every output line to `on_line` until it exits or `cancel`
/// fires. Returns whether it exited successfully plus the last stderr lines.
pub(crate) fn stream(
    mut cmd: Command,
    cancel: &CancellationToken,
    on_line: &mut dyn FnMut(Stream, String),
) -> IdeResult<(bool, Vec<String>)> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    prepare(&mut cmd);
    let mut child = spawn(&mut cmd)?;
    let (tx, rx) = mpsc::channel::<Event>();
    let mut open = 0;
    if let Some(out) = child.stdout.take() {
        spawn_reader(out, tx.clone(), Stream::Stdout);
        open += 1;
    }
    if let Some(err) = child.stderr.take() {
        spawn_reader(err, tx.clone(), Stream::Stderr);
        open += 1;
    }
    drop(tx);
    let mut stderr_tail: Vec<String> = Vec::new();
    while open > 0 {
        if cancel.is_cancelled() {
            kill(&mut child);
            return Err(IdeError::cancelled());
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Event::Line(stream, line)) => {
                if stream == Stream::Stderr && !line.trim().is_empty() {
                    stderr_tail.push(line.clone());
                    if stderr_tail.len() > 20 {
                        stderr_tail.remove(0);
                    }
                }
                on_line(stream, line);
            }
            Ok(Event::Closed) => open -= 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancel.is_cancelled() {
            kill(&mut child);
            return Err(IdeError::cancelled());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    Ok((status.success(), stderr_tail))
}
