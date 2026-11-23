//! The gh CLI as a child process: bounded runs and cancellable line streams.

use ide_core::cli_process::{CliTool, Decoding, Input};
pub(crate) use ide_core::cli_process::{Output, Stream};
use ide_core::{CancellationToken, IdeResult};
use std::process::Command;
use std::time::Duration;

const GH: CliTool = CliTool::new("gh", Decoding::Utf8Lossy);

/// Runs `cmd` to completion. Fails when it outlives `timeout` or `cancel` fires;
/// a non-zero exit is reported in [`Output::success`], not as an error.
pub(crate) fn run(cmd: Command, timeout: Duration, cancel: Option<&CancellationToken>) -> IdeResult<Output> {
    GH.run(cmd, timeout, cancel)
}

/// [`run`] with `input` written to the child's stdin (then closed).
pub(crate) fn run_with_input(
    cmd: Command,
    input: Option<&str>,
    timeout: Duration,
    cancel: Option<&CancellationToken>,
) -> IdeResult<Output> {
    GH.run_with_input(cmd, input.map(Input::Threaded), timeout, cancel)
}

/// Runs `cmd`, handing every output line to `on_line` until it exits or `cancel`
/// fires. Returns whether it exited successfully plus the last stderr lines.
pub(crate) fn stream(
    cmd: Command,
    cancel: &CancellationToken,
    on_line: &mut dyn FnMut(Stream, String),
) -> IdeResult<(bool, Vec<String>)> {
    GH.stream(cmd, cancel, on_line)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use ide_core::error::ErrorKind;
    use ide_core::process::process_alive;
    use std::time::Instant;

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
