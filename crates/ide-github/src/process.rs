//! Child processes of the gh CLI: bounded runs and cancellable line streams.

use ide_core::process::terminate_tree;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long a cancelled or timed-out child's process group (gh spawns git and helpers)
/// gets to exit on `SIGTERM` before `SIGKILL`: git removes its lock files on `SIGTERM`.
const KILL_GRACE: Duration = Duration::from_millis(20);

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
    ide_core::process::prepare(ide_core::process::own_group(cmd));
}

fn spawn(cmd: &mut Command) -> IdeResult<Child> {
    cmd.spawn().map_err(|e| IdeError::unavailable(format!("could not run gh: {e}")))
}

fn read_all(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    })
}

/// Runs `cmd` to completion. Fails when it outlives `timeout` or `cancel` fires;
/// a non-zero exit is reported in [`Output::success`], not as an error.
pub(crate) fn run(cmd: Command, timeout: Duration, cancel: Option<&CancellationToken>) -> IdeResult<Output> {
    run_with_input(cmd, None, timeout, cancel)
}

/// [`run`] with `input` written to the child's stdin (then closed).
pub(crate) fn run_with_input(
    mut cmd: Command,
    input: Option<&str>,
    timeout: Duration,
    cancel: Option<&CancellationToken>,
) -> IdeResult<Output> {
    prepare(&mut cmd);
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = spawn(&mut cmd)?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        let input = input.to_owned();
        // A writer thread: a large body must not block on a full pipe while gh is not reading yet.
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = stdin.write_all(input.as_bytes());
        });
    }
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
            return Err(IdeError::unavailable("gh did not respond in time"));
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
                let line = String::from_utf8_lossy(pending).trim_end().to_string();
                pending.clear();
                let _ = tx.send(Event::Line(stream, line));
            }
        };
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &b in &buf[..n] {
                        // `\r` too: git progress rewrites its line in place.
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
            terminate_tree(&mut child, KILL_GRACE);
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
            terminate_tree(&mut child, KILL_GRACE);
            return Err(IdeError::cancelled());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    Ok((status.success(), stderr_tail))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use ide_core::error::ErrorKind;
    use ide_core::process::process_alive;

    const LONG: Duration = Duration::from_secs(30);

    fn sh(script: &str) -> Command {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", script]);
        cmd
    }

    /// A script that records its pid in `name`'s file, then runs `rest`.
    fn recording_pid(name: &str, rest: &str) -> (Command, std::path::PathBuf) {
        let file = std::env::temp_dir().join(format!("openidea-process-{}-{name}", std::process::id()));
        let _ = std::fs::remove_file(&file);
        (sh(&format!("echo $$ > '{0}.tmp' && mv '{0}.tmp' '{0}'; {rest}", file.display())), file)
    }

    fn recorded_pid(file: &std::path::Path) -> u32 {
        let pid = std::fs::read_to_string(file).unwrap().trim().parse().unwrap();
        let _ = std::fs::remove_file(file);
        pid
    }

    /// Cancels `cancel` once the script has recorded its pid.
    fn cancel_when_recorded(file: &std::path::Path, cancel: &CancellationToken) {
        let (file, cancel) = (file.to_owned(), cancel.clone());
        std::thread::spawn(move || {
            while !file.exists() {
                std::thread::sleep(Duration::from_millis(5));
            }
            cancel.cancel();
        });
    }

    fn assert_gone(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_alive(pid) {
            assert!(Instant::now() < deadline, "process {pid} survived");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn the_exit_status_is_reported_not_raised() {
        assert!(run(sh("exit 0"), LONG, None).unwrap().success);
        assert!(!run(sh("exit 3"), LONG, None).unwrap().success);
    }

    #[test]
    fn both_streams_are_captured_separately_and_in_order() {
        let out = run(sh("printf 'a\\nb\\nc\\n'; printf 'x\\ny\\n' >&2"), LONG, None).unwrap();
        assert_eq!(out.stdout, "a\nb\nc\n");
        assert_eq!(out.stderr, "x\ny\n");
        assert!(out.success);
    }

    #[test]
    fn invalid_utf8_is_replaced_in_collected_output() {
        let out = run(sh("printf 'ok\\n\\377\\n'; printf 'a\\377b' >&2"), LONG, None).unwrap();
        assert_eq!(out.stdout, "ok\n\u{FFFD}\n");
        assert_eq!(out.stderr, "a\u{FFFD}b");
    }

    #[test]
    fn without_input_stdin_is_closed() {
        assert_eq!(run(sh("cat; echo done"), LONG, None).unwrap().stdout, "done\n");
    }

    #[test]
    fn input_reaches_the_child_stdin_and_is_then_closed() {
        let out = run_with_input(sh("cat"), Some("secret\nmore"), LONG, None).unwrap();
        assert_eq!(out.stdout, "secret\nmore");
        assert!(out.success);
    }

    #[test]
    fn a_body_larger_than_the_pipe_does_not_block_the_child_output() {
        let body = "0123456789abcdef".repeat(64 * 1024);
        let out = run_with_input(sh("cat"), Some(&body), LONG, None).unwrap();
        assert_eq!(out.stdout.len(), body.len());
    }

    #[test]
    fn a_missing_program_is_unavailable() {
        let err = run(Command::new("/nonexistent/openidea-gh"), LONG, None).err().unwrap();
        assert_eq!(err.kind, ErrorKind::Unavailable);
        assert_eq!(err.message, "could not run gh: No such file or directory (os error 2)");
    }

    #[test]
    fn a_run_past_its_timeout_fails_and_the_child_is_killed() {
        let (cmd, file) = recording_pid("gh-timeout", "exec sleep 30");
        let err = run(cmd, Duration::from_secs(1), None).err().unwrap();
        assert_eq!(err.kind, ErrorKind::Unavailable);
        assert_eq!(err.message, "gh did not respond in time");
        assert_gone(recorded_pid(&file));
    }

    #[test]
    fn a_cancelled_run_fails_and_the_child_is_killed() {
        let (cmd, file) = recording_pid("gh-cancel", "exec sleep 30");
        let cancel = CancellationToken::new();
        cancel_when_recorded(&file, &cancel);
        let err = run(cmd, LONG, Some(&cancel)).err().unwrap();
        assert_eq!(err.kind, ErrorKind::Cancelled);
        assert_eq!(err.message, "cancelled");
        assert_gone(recorded_pid(&file));
    }

    fn collect(script: &str) -> (bool, Vec<(Stream, String)>, Vec<String>) {
        let mut lines = Vec::new();
        let (ok, tail) = stream(sh(script), &CancellationToken::new(), &mut |s, l| lines.push((s, l))).unwrap();
        (ok, lines, tail)
    }

    fn of(lines: &[(Stream, String)], which: Stream) -> Vec<&str> {
        lines.iter().filter(|(s, _)| *s == which).map(|(_, l)| l.as_str()).collect()
    }

    #[test]
    fn a_stream_splits_lines_at_lf_cr_and_crlf_and_trims_their_ends() {
        let (ok, lines, _) = collect("printf 'a\\nb\\r\\nc\\rd  \\n\\n\\ne'");
        assert!(ok);
        assert_eq!(of(&lines, Stream::Stdout), ["a", "b", "c", "d", "e"]);
        assert!(of(&lines, Stream::Stderr).is_empty());
    }

    #[test]
    fn a_stream_labels_each_line_with_its_pipe() {
        let (_, lines, _) = collect("echo out1; echo err1 >&2; echo out2");
        assert_eq!(of(&lines, Stream::Stdout), ["out1", "out2"]);
        assert_eq!(of(&lines, Stream::Stderr), ["err1"]);
    }

    #[test]
    fn a_stream_reports_the_exit_status() {
        assert!(collect("exit 0").0);
        assert!(!collect("exit 2").0);
    }

    #[test]
    fn a_stream_replaces_invalid_utf8() {
        let (_, lines, _) = collect("printf 'a\\377b\\n'");
        assert_eq!(of(&lines, Stream::Stdout), ["a\u{FFFD}b"]);
    }

    #[test]
    fn a_stream_keeps_the_last_twenty_non_blank_stderr_lines() {
        let (_, lines, tail) = collect("echo '   ' >&2; i=1; while [ $i -le 25 ]; do echo e$i >&2; i=$((i+1)); done");
        let expected: Vec<String> = (6..=25).map(|i| format!("e{i}")).collect();
        assert_eq!(tail, expected);
        assert_eq!(of(&lines, Stream::Stderr).len(), 26, "blank lines are still handed over");
    }

    #[test]
    fn a_stream_cancelled_before_it_starts_does_not_spawn() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = stream(Command::new("/nonexistent/openidea-gh"), &cancel, &mut |_, _| {}).err().unwrap();
        assert_eq!(err.kind, ErrorKind::Cancelled);
        assert_eq!(err.message, "cancelled");
    }

    #[test]
    fn a_stream_cancelled_while_running_fails_and_the_child_is_killed() {
        let (cmd, file) = recording_pid("gh-stream-cancel", "echo started; exec sleep 30");
        let cancel = CancellationToken::new();
        let err = stream(cmd, &cancel, &mut |_, _| cancel.cancel()).err().unwrap();
        assert_eq!(err.kind, ErrorKind::Cancelled);
        assert_eq!(err.message, "cancelled");
        assert_gone(recorded_pid(&file));
    }

    #[test]
    fn a_missing_program_cannot_be_streamed() {
        let err =
            stream(Command::new("/nonexistent/openidea-gh"), &CancellationToken::new(), &mut |_, _| {}).err().unwrap();
        assert_eq!(err.kind, ErrorKind::Unavailable);
        assert_eq!(err.message, "could not run gh: No such file or directory (os error 2)");
    }
}
