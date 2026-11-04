//! Child processes of the `adb` CLI: bounded runs, and cancellable line streams
//! that are handed over in batches (logcat is far too chatty for one message a line).

use ide_core::process::terminate_tree;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long a cancelled child gets to exit on `SIGTERM` (and flush) before `SIGKILL`.
const KILL_GRACE: Duration = Duration::from_millis(20);

pub(crate) struct Output {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

fn prepare(cmd: &mut Command) {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    ide_core::process::prepare(ide_core::process::own_group(cmd));
}

fn spawn(cmd: &mut Command) -> IdeResult<Child> {
    cmd.spawn().map_err(|e| IdeError::unavailable(format!("could not run adb: {e}")))
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
pub(crate) fn run(mut cmd: Command, timeout: Duration, cancel: Option<&CancellationToken>) -> IdeResult<Output> {
    prepare(&mut cmd);
    let mut child = spawn(&mut cmd)?;
    let out = child.stdout.take().map(read_all);
    let err = child.stderr.take().map(read_all);
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            terminate_tree(&mut child, KILL_GRACE);
            return Err(IdeError::cancelled());
        }
        if Instant::now() >= deadline {
            terminate_tree(&mut child, KILL_GRACE);
            return Err(IdeError::unavailable("adb did not respond in time"));
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
    Line(bool, String),
    Closed,
}

fn spawn_reader(mut pipe: impl Read + Send + 'static, tx: mpsc::Sender<Event>, stdout: bool) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let flush = |pending: &mut Vec<u8>| {
            if !pending.is_empty() {
                let line = ide_core::output_encoding::decode_tool_output(pending);
                pending.clear();
                let _ = tx.send(Event::Line(stdout, line.trim_end().to_string()));
            }
        };
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &b in &buf[..n] {
                        if b == b'\n' {
                            flush(&mut pending);
                        } else if b != b'\r' {
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

fn flush<T>(batch: &mut Vec<T>, on_batch: &mut dyn FnMut(Vec<T>)) {
    if !batch.is_empty() {
        on_batch(std::mem::take(batch));
    }
}

/// Runs `cmd`, parsing every stdout line with `parse` and handing the results to
/// `on_batch` — as soon as `max` are ready, or once `idle` passes without new
/// output, so a quiet stream still shows its last line. Stderr is kept as a tail
/// for the error message. Returns whether the child exited successfully.
pub(crate) fn stream_batched<T>(
    mut cmd: Command,
    cancel: &CancellationToken,
    idle: Duration,
    max: usize,
    mut parse: impl FnMut(&str) -> Option<T>,
    on_batch: &mut dyn FnMut(Vec<T>),
) -> IdeResult<(bool, Vec<String>)> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    prepare(&mut cmd);
    let mut child = spawn(&mut cmd)?;
    let (tx, rx) = mpsc::channel::<Event>();
    let mut open = 0;
    if let Some(out) = child.stdout.take() {
        spawn_reader(out, tx.clone(), true);
        open += 1;
    }
    if let Some(err) = child.stderr.take() {
        spawn_reader(err, tx.clone(), false);
        open += 1;
    }
    drop(tx);
    let mut stderr_tail: Vec<String> = Vec::new();
    let mut batch: Vec<T> = Vec::with_capacity(max);
    while open > 0 {
        if cancel.is_cancelled() {
            terminate_tree(&mut child, KILL_GRACE);
            return Err(IdeError::cancelled());
        }
        match rx.recv_timeout(idle) {
            Ok(Event::Line(true, line)) => {
                if let Some(item) = parse(&line) {
                    batch.push(item);
                    if batch.len() >= max {
                        flush(&mut batch, on_batch);
                    }
                }
            }
            Ok(Event::Line(false, line)) => {
                if !line.trim().is_empty() {
                    stderr_tail.push(line);
                    if stderr_tail.len() > 20 {
                        stderr_tail.remove(0);
                    }
                }
            }
            Ok(Event::Closed) => open -= 1,
            Err(mpsc::RecvTimeoutError::Timeout) => flush(&mut batch, on_batch),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    flush(&mut batch, on_batch);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancel.is_cancelled() {
            terminate_tree(&mut child, KILL_GRACE);
            return Err(IdeError::cancelled());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    Ok((status.success(), stderr_tail))
}
