//! Runs a tool's CLI (`docker`, `gh`, `adb`) as a child process: bounded runs that collect
//! its output, and cancellable streams that hand over its output line by line.
//!
//! Every child leads its own process group ([`own_group`]), so cancelling or timing out
//! reaches what it started in turn (`gh` → `git`, `docker` → CLI plugins such as compose).
//! They get [`KILL_GRACE`] to exit on `SIGTERM` and clean up (git removes its lock files)
//! before `SIGKILL`.

use crate::process::{own_group, prepare, terminate_tree};
use crate::{CancellationToken, IdeError, IdeResult};
use std::borrow::Cow;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long a cancelled or timed-out child's process group gets to exit on `SIGTERM`
/// before `SIGKILL`.
const KILL_GRACE: Duration = Duration::from_millis(20);

/// How many of a streamed child's last non-blank stderr lines are kept for its error message.
const STDERR_TAIL: usize = 20;

/// How a tool's output bytes become text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decoding {
    /// [`decode_tool_output`](crate::output_encoding::decode_tool_output): UTF-8, and on
    /// Windows the system code page for what is not.
    ToolOutput,
    /// UTF-8, invalid bytes replaced by U+FFFD.
    Utf8Lossy,
}

impl Decoding {
    fn decode(self, bytes: &[u8]) -> Cow<'_, str> {
        match self {
            Decoding::ToolOutput => Cow::Owned(crate::output_encoding::decode_tool_output(bytes)),
            Decoding::Utf8Lossy => String::from_utf8_lossy(bytes),
        }
    }
}

/// What a child's stdin is fed with, and how.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input<'a> {
    /// Written before the output is read, then closed: only for input small enough
    /// (a password) to fit the pipe, as a full pipe blocks the caller.
    Inline(&'a str),
    /// Written by a thread of its own, then closed: a large body must not block on a full
    /// pipe while the child is not reading yet.
    Threaded(&'a str),
}

/// How a streamed child's `\r` is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CarriageReturn {
    /// Ends a line like `\n`: progress output rewrites its line in place.
    EndsLine,
    /// Is dropped; only `\n` ends a line.
    Dropped,
}

/// What a bounded run collected.
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// Which pipe a streamed line came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// One tool's CLI: its name for error messages and how its output is decoded.
#[derive(Clone, Copy, Debug)]
pub struct CliTool {
    name: &'static str,
    decoding: Decoding,
}

impl CliTool {
    pub const fn new(name: &'static str, decoding: Decoding) -> Self {
        Self { name, decoding }
    }

    fn spawn(self, cmd: &mut Command) -> IdeResult<Child> {
        cmd.spawn().map_err(|e| IdeError::unavailable(format!("could not run {}: {e}", self.name)))
    }

    /// Pipes stdout and stderr, closes stdin and starts the child in its own process group.
    fn configure(cmd: &mut Command) {
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        prepare(own_group(cmd));
    }

    /// Runs `cmd` to completion. Fails when it outlives `timeout` or `cancel` fires;
    /// a non-zero exit is reported in [`Output::success`], not as an error.
    pub fn run(self, cmd: Command, timeout: Duration, cancel: Option<&CancellationToken>) -> IdeResult<Output> {
        self.run_with_input(cmd, None, timeout, cancel)
    }

    /// [`run`](Self::run) with `input` written to the child's stdin and then closed.
    pub fn run_with_input(
        self,
        mut cmd: Command,
        input: Option<Input>,
        timeout: Duration,
        cancel: Option<&CancellationToken>,
    ) -> IdeResult<Output> {
        Self::configure(&mut cmd);
        if input.is_some() {
            cmd.stdin(Stdio::piped());
        }
        let mut child = self.spawn(&mut cmd)?;
        match (input, child.stdin.take()) {
            (Some(Input::Inline(text)), Some(mut stdin)) => {
                // Dropping `stdin` afterwards closes it, so the CLI sees EOF.
                let _ = stdin.write_all(text.as_bytes());
            }
            (Some(Input::Threaded(text)), Some(mut stdin)) => {
                let text = text.to_owned();
                std::thread::spawn(move || {
                    let _ = stdin.write_all(text.as_bytes());
                });
            }
            _ => {}
        }
        let decoding = self.decoding;
        let out = child.stdout.take().map(|pipe| read_all(pipe, decoding));
        let err = child.stderr.take().map(|pipe| read_all(pipe, decoding));
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
                return Err(IdeError::unavailable(format!("{} did not respond in time", self.name)));
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        Ok(Output {
            stdout: out.map(|t| t.join().unwrap_or_default()).unwrap_or_default(),
            stderr: err.map(|t| t.join().unwrap_or_default()).unwrap_or_default(),
            success: status.success(),
        })
    }

    /// Runs `cmd`, handing every output line to `on_line` until it exits or `cancel`
    /// fires. Returns whether it exited successfully plus the last stderr lines.
    pub fn stream(
        self,
        cmd: Command,
        cancel: &CancellationToken,
        on_line: &mut dyn FnMut(Stream, String),
    ) -> IdeResult<(bool, Vec<String>)> {
        let mut lines = self.lines(cmd, cancel, CarriageReturn::EndsLine)?;
        let mut stderr_tail: Vec<String> = Vec::new();
        loop {
            match lines.poll(cancel, Duration::from_millis(50))? {
                Poll::Line(stream, line) => {
                    if stream == Stream::Stderr && !line.trim().is_empty() {
                        keep_stderr_line(&mut stderr_tail, line.clone());
                    }
                    on_line(stream, line);
                }
                Poll::Closed | Poll::Timeout => {}
                Poll::Finished => break,
            }
        }
        Ok((lines.finish(cancel)?, stderr_tail))
    }

    /// Starts `cmd` with a reader thread per pipe, for a caller that drives the loop itself
    /// (see [`Lines::poll`]). Fails when `cancel` has already fired, without starting it.
    pub fn lines(self, mut cmd: Command, cancel: &CancellationToken, cr: CarriageReturn) -> IdeResult<Lines> {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        Self::configure(&mut cmd);
        let mut child = self.spawn(&mut cmd)?;
        let (tx, rx) = mpsc::channel::<Event>();
        let mut open = 0;
        if let Some(out) = child.stdout.take() {
            spawn_reader(out, tx.clone(), Stream::Stdout, self.decoding, cr);
            open += 1;
        }
        if let Some(err) = child.stderr.take() {
            spawn_reader(err, tx.clone(), Stream::Stderr, self.decoding, cr);
            open += 1;
        }
        drop(tx);
        Ok(Lines { child, rx, open })
    }
}

/// Appends a stderr line to `tail`, which keeps only the last [`STDERR_TAIL`].
pub fn keep_stderr_line(tail: &mut Vec<String>, line: String) {
    tail.push(line);
    if tail.len() > STDERR_TAIL {
        tail.remove(0);
    }
}

fn read_all(mut pipe: impl Read + Send + 'static, decoding: Decoding) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        decoding.decode(&buf).into_owned()
    })
}

enum Event {
    Line(Stream, String),
    Closed,
}

fn spawn_reader(
    mut pipe: impl Read + Send + 'static,
    tx: mpsc::Sender<Event>,
    stream: Stream,
    decoding: Decoding,
    cr: CarriageReturn,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let flush = |pending: &mut Vec<u8>| {
            if !pending.is_empty() {
                let line = decoding.decode(pending).trim_end().to_string();
                pending.clear();
                let _ = tx.send(Event::Line(stream, line));
            }
        };
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &b in &buf[..n] {
                        if b == b'\n' || (b == b'\r' && cr == CarriageReturn::EndsLine) {
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

/// A running child whose output lines are read by threads: see [`CliTool::lines`].
pub struct Lines {
    child: Child,
    rx: mpsc::Receiver<Event>,
    /// Pipes whose reader has not reported its end yet.
    open: usize,
}

/// What [`Lines::poll`] saw.
pub enum Poll {
    Line(Stream, String),
    /// A pipe reached its end.
    Closed,
    /// Nothing arrived within the wait.
    Timeout,
    /// Every pipe is at its end.
    Finished,
}

impl Lines {
    /// Waits up to `wait` for the next line. Fails, after killing the child, when `cancel` has fired.
    pub fn poll(&mut self, cancel: &CancellationToken, wait: Duration) -> IdeResult<Poll> {
        if self.open == 0 {
            return Ok(Poll::Finished);
        }
        if cancel.is_cancelled() {
            terminate_tree(&mut self.child, KILL_GRACE);
            return Err(IdeError::cancelled());
        }
        match self.rx.recv_timeout(wait) {
            Ok(Event::Line(stream, line)) => Ok(Poll::Line(stream, line)),
            Ok(Event::Closed) => {
                self.open -= 1;
                Ok(Poll::Closed)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(Poll::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.open = 0;
                Ok(Poll::Finished)
            }
        }
    }

    /// Waits for the child to exit and returns whether it did so successfully. Fails, after
    /// killing it, when `cancel` fires first.
    pub fn finish(mut self, cancel: &CancellationToken) -> IdeResult<bool> {
        let status = loop {
            if let Some(status) = self.child.try_wait()? {
                break status;
            }
            if cancel.is_cancelled() {
                terminate_tree(&mut self.child, KILL_GRACE);
                return Err(IdeError::cancelled());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        Ok(status.success())
    }
}
