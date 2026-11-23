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
/// `on_batch` — as soon as `max` are ready, or once the oldest waiting line is `idle`
/// old, so neither a quiet nor a steady stream holds lines back. Stderr is kept as a
/// tail for the error message. Returns whether the child exited successfully.
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
    // When the first line of the waiting batch arrived.
    let mut since = Instant::now();
    while open > 0 {
        if cancel.is_cancelled() {
            terminate_tree(&mut child, KILL_GRACE);
            return Err(IdeError::cancelled());
        }
        let wait = if batch.is_empty() { idle } else { idle.saturating_sub(since.elapsed()) };
        match rx.recv_timeout(wait) {
            Ok(Event::Line(true, line)) => {
                if let Some(item) = parse(&line) {
                    if batch.is_empty() {
                        since = Instant::now();
                    }
                    batch.push(item);
                    if batch.len() >= max || since.elapsed() >= idle {
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use ide_core::error::ErrorKind;
    use ide_core::process::process_alive;

    #[test]
    fn a_steady_stream_is_handed_over_while_it_runs() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "for i in $(seq 1 20); do echo $i; sleep 0.02; done"]);
        let mut sizes = Vec::new();
        let (ok, _) = stream_batched(
            cmd,
            &CancellationToken::new(),
            Duration::from_millis(60),
            300,
            |line| Some(line.to_owned()),
            &mut |batch| sizes.push(batch.len()),
        )
        .unwrap();
        assert!(ok);
        assert_eq!(sizes.iter().sum::<usize>(), 20);
        assert!(sizes.len() >= 3, "lines arriving every 20 ms waited for the end: {sizes:?}");
    }

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
    fn stdin_is_closed() {
        assert_eq!(run(sh("cat; echo done"), LONG, None).unwrap().stdout, "done\n");
    }

    #[test]
    fn a_missing_program_is_unavailable() {
        let err = run(Command::new("/nonexistent/openidea-adb"), LONG, None).err().unwrap();
        assert_eq!(err.kind, ErrorKind::Unavailable);
        assert_eq!(err.message, "could not run adb: No such file or directory (os error 2)");
    }

    #[test]
    fn a_run_past_its_timeout_fails_and_the_child_is_killed() {
        let (cmd, file) = recording_pid("adb-timeout", "exec sleep 30");
        let err = run(cmd, Duration::from_secs(1), None).err().unwrap();
        assert_eq!(err.kind, ErrorKind::Unavailable);
        assert_eq!(err.message, "adb did not respond in time");
        assert_gone(recorded_pid(&file));
    }

    #[test]
    fn a_cancelled_run_fails_and_the_child_is_killed() {
        let (cmd, file) = recording_pid("adb-cancel", "exec sleep 30");
        let cancel = CancellationToken::new();
        cancel_when_recorded(&file, &cancel);
        let err = run(cmd, LONG, Some(&cancel)).err().unwrap();
        assert_eq!(err.kind, ErrorKind::Cancelled);
        assert_eq!(err.message, "cancelled");
        assert_gone(recorded_pid(&file));
    }

    /// Runs `script` batched by `max` lines (a long `idle`, so only `max` and the end flush),
    /// parsing stdout lines unless they are `skip`.
    fn batches(script: &str, max: usize) -> (bool, Vec<Vec<String>>, Vec<String>) {
        let mut batches = Vec::new();
        let (ok, tail) = stream_batched(
            sh(script),
            &CancellationToken::new(),
            LONG,
            max,
            |line| (line != "skip").then(|| line.to_owned()),
            &mut |batch| batches.push(batch),
        )
        .unwrap();
        (ok, batches, tail)
    }

    #[test]
    fn a_batch_is_handed_over_as_soon_as_max_lines_are_ready() {
        let (ok, batches, _) = batches("printf '1\\n2\\n3\\n4\\n5\\n'", 2);
        assert!(ok);
        assert_eq!(batches, [vec!["1", "2"], vec!["3", "4"], vec!["5"]]);
    }

    #[test]
    fn lines_the_parser_rejects_are_dropped() {
        let (_, batches, _) = batches("printf '1\\nskip\\n2\\n'", 10);
        assert_eq!(batches, [vec!["1", "2"]]);
    }

    #[test]
    fn carriage_returns_are_dropped_not_split_on_and_line_ends_are_trimmed() {
        let (_, batches, _) = batches("printf 'a\\r\\nb\\rc  \\n\\n\\nd'", 10);
        assert_eq!(batches, [vec!["a", "bc", "d"]]);
    }

    #[test]
    fn a_stream_replaces_invalid_utf8() {
        let (_, batches, _) = batches("printf 'a\\377b\\n'", 10);
        assert_eq!(batches, [vec!["a\u{FFFD}b"]]);
    }

    #[test]
    fn a_stream_reports_the_exit_status() {
        assert!(batches("exit 0", 10).0);
        assert!(!batches("exit 2", 10).0);
    }

    #[test]
    fn stderr_is_not_parsed_and_its_last_twenty_non_blank_lines_are_kept() {
        let (_, batches, tail) =
            batches("echo '   ' >&2; i=1; while [ $i -le 25 ]; do echo e$i >&2; i=$((i+1)); done; echo out", 10);
        assert_eq!(batches, [vec!["out"]]);
        let expected: Vec<String> = (6..=25).map(|i| format!("e{i}")).collect();
        assert_eq!(tail, expected);
    }

    #[test]
    fn a_stream_cancelled_before_it_starts_does_not_spawn() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = stream_batched(
            Command::new("/nonexistent/openidea-adb"),
            &cancel,
            LONG,
            10,
            |line| Some(line.to_owned()),
            &mut |_| {},
        )
        .err()
        .unwrap();
        assert_eq!(err.kind, ErrorKind::Cancelled);
        assert_eq!(err.message, "cancelled");
    }

    #[test]
    fn a_stream_cancelled_while_running_fails_and_the_child_is_killed() {
        let (cmd, file) = recording_pid("adb-stream-cancel", "echo started; exec sleep 30");
        let cancel = CancellationToken::new();
        let err = stream_batched(cmd, &cancel, LONG, 1, |line| Some(line.to_owned()), &mut |_| cancel.cancel())
            .err()
            .unwrap();
        assert_eq!(err.kind, ErrorKind::Cancelled);
        assert_eq!(err.message, "cancelled");
        assert_gone(recorded_pid(&file));
    }

    #[test]
    fn a_missing_program_cannot_be_streamed() {
        let err = stream_batched(
            Command::new("/nonexistent/openidea-adb"),
            &CancellationToken::new(),
            LONG,
            10,
            |line| Some(line.to_owned()),
            &mut |_| {},
        )
        .err()
        .unwrap();
        assert_eq!(err.kind, ErrorKind::Unavailable);
        assert_eq!(err.message, "could not run adb: No such file or directory (os error 2)");
    }
}
