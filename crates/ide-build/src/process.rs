//! Line-oriented child processes for syncs and builds: output is fed line by
//! line to a callback, and cancellation kills the whole process group (the
//! `mvnw` / `gradlew` wrapper scripts start the JVM as a child).

use ide_core::process::kill_tree;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stream {
    Stdout,
    Stderr,
}

/// A single line longer than this without a newline is delivered as several lines: the pump
/// buffer stays bounded whatever the child prints (progress bars, minified bundles, binary
/// output), and every byte still arrives.
pub(crate) const MAX_LINE_BYTES: usize = 1024 * 1024;
/// `Output::text` stops growing past this while the pipes keep draining: a chatty build can
/// print far more than is ever parsed back out of the retained copy.
pub(crate) const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;

pub(crate) struct Output {
    pub success: bool,
    /// Every line, stdout and stderr interleaved as received, up to [`MAX_TEXT_BYTES`].
    pub text: String,
    /// More output followed the retained `text`; the lines were still fed to `on_line`.
    pub truncated: bool,
}

/// Bounded pump for callers that stream every line and only summarize errors: reads fixed
/// 64 KiB chunks, splits newline-free runs at a UTF-8 char boundary at the line cap, and
/// never grows one line buffer without bound.
fn pump_bounded(stream: Box<dyn Read + Send>, kind: Stream, tx: &mpsc::Sender<(Stream, String)>) {
    let mut reader = BufReader::new(stream);
    // `terminated`: the buffer ends in the stream's newline. A segment cut from a
    // newline-free run at the line cap must keep a trailing `\r` — it is data.
    let send = |buf: &mut Vec<u8>, terminated: bool, tx: &mpsc::Sender<(Stream, String)>| {
        let line = ide_core::output_encoding::decode_tool_output(buf);
        let line = if terminated { line.trim_end_matches(['\n', '\r']).to_owned() } else { line };
        buf.clear();
        tx.send((kind, line)).is_ok()
    };
    let mut chunk = vec![0u8; 64 * 1024];
    let mut line: Vec<u8> = Vec::with_capacity(256);
    'read: loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let mut start = 0;
        for (i, &b) in chunk[..n].iter().enumerate() {
            if b == b'\n' {
                line.extend_from_slice(&chunk[start..=i]);
                if !send(&mut line, true, tx) {
                    break 'read;
                }
                start = i + 1;
            }
        }
        line.extend_from_slice(&chunk[start..n]);
        while line.len() > MAX_LINE_BYTES {
            let mut at = MAX_LINE_BYTES;
            while at > 0 && line[at] & 0xC0 == 0x80 {
                at -= 1;
            }
            // Malformed input with no boundary at all: split raw and let decoding say so.
            if at == 0 {
                at = MAX_LINE_BYTES;
            }
            let rest = line.split_off(at);
            if !send(&mut line, false, tx) {
                break 'read;
            }
            line = rest;
        }
    }
    if !line.is_empty() {
        send(&mut line, true, tx);
    }
}

/// `program` as spawnable: a bare name (`mvn`, `mvn.cmd`) resolves on the IDE's
/// search path — the login shell's `PATH` plus version-manager shims — since the
/// app's own `PATH` can be minimal and `Command` would not see `mvn` there. The `PATH`
/// of the project holding `cwd` (its direnv `.envrc`) comes first.
pub(crate) fn program_path(program: &str, env: &BTreeMap<String, String>, cwd: &Path) -> std::path::PathBuf {
    let path = std::path::Path::new(program);
    if !path.is_relative() || path.components().count() > 1 {
        return path.to_path_buf();
    }
    let search = env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| std::ffi::OsString::from(v))
        .unwrap_or_else(|| ide_core::tool_path::search_path_in(cwd));
    ide_core::process::find_executable(program, &search).unwrap_or_else(|| path.to_path_buf())
}

/// Runs `program args` in `cwd`, feeding each output line to `on_line`; kills
/// the process group and returns `cancelled` when `cancel` fires. `Output.text`
/// keeps every line: callers that parse a complete model from it use this.
pub(crate) fn run(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    cancel: &CancellationToken,
    on_line: impl FnMut(Stream, &str),
) -> IdeResult<Output> {
    run_with_env(program, args, cwd, env, false, cancel, on_line)
}

/// Like [`run`], but bounds both the per-line buffer and the retained copy. For callers
/// that stream every line to `on_line` and use `Output.text` only for error summaries:
/// sync/model listings must be kept whole and use [`run`] instead.
pub(crate) fn run_bounded(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    cancel: &CancellationToken,
    on_line: impl FnMut(Stream, &str),
) -> IdeResult<Output> {
    run_with_env_capture(program, args, cwd, env, RunOptions { bounded: true, ..Default::default() }, cancel, on_line)
}

pub(crate) fn run_with_env(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    clear_env: bool,
    cancel: &CancellationToken,
    on_line: impl FnMut(Stream, &str),
) -> IdeResult<Output> {
    run_with_env_capture(program, args, cwd, env, RunOptions { clear_env, ..Default::default() }, cancel, on_line)
}

#[derive(Clone, Copy, Default)]
struct RunOptions {
    clear_env: bool,
    bounded: bool,
}

fn run_with_env_capture(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    options: RunOptions,
    cancel: &CancellationToken,
    mut on_line: impl FnMut(Stream, &str),
) -> IdeResult<Output> {
    let RunOptions { clear_env, bounded } = options;
    tracing::info!("build: {program} {} (in {})", args.join(" "), cwd.display());
    // Output is read as UTF-8: JVMs on Windows are told to write it (see `ide_core::output_encoding`).
    let encoding =
        ide_core::output_encoding::fix(program, args, env, |k| std::env::var(k).ok(), "UTF-8", cfg!(windows));
    let program = program_path(program, env, cwd);
    let mut command = if ide_core::process::needs_sh(&program) {
        let mut sh = Command::new("/bin/sh");
        sh.arg(&program);
        sh
    } else {
        Command::new(&program)
    };
    command.args(args).current_dir(cwd).envs(env).envs(encoding.env.iter().map(|(k, v)| (k, v))).stdin(Stdio::null());
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    // Its own group: `mvnw` / `gradlew` start the JVM as a child, and cancelling kills both.
    ide_core::process::prepare(ide_core::process::own_group(&mut command));
    if clear_env {
        command.env_clear().envs(env).envs(encoding.env);
    }
    let mut child =
        command.spawn().map_err(|e| IdeError::unavailable(format!("cannot start {}: {e}", program.display())))?;
    let (tx, rx) = mpsc::channel::<(Stream, String)>();
    let pump = |stream: Box<dyn Read + Send>, kind: Stream, tx: mpsc::Sender<(Stream, String)>| {
        std::thread::spawn(move || {
            if bounded {
                pump_bounded(stream, kind, &tx);
            } else {
                // Model listings are parsed from Output.text: keep every line whole, however long.
                let mut reader = BufReader::new(stream);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = ide_core::output_encoding::decode_tool_output(&buf);
                            let line = line.trim_end_matches(['\n', '\r']).to_owned();
                            if tx.send((kind, line)).is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        })
    };
    let readers = [
        child.stdout.take().map(|s| pump(Box::new(s), Stream::Stdout, tx.clone())),
        child.stderr.take().map(|s| pump(Box::new(s), Stream::Stderr, tx.clone())),
    ];
    drop(tx);
    // Retained copy of the output: the first half of the cap, then — once output overflows —
    // a rolling tail instead of the middle. Error summaries read the end of the output, while
    // listings parsed out of a successful run read from the start. The pipes keep draining
    // either way: `on_line` still sees every line, so the child never blocks on a full pipe.
    let cap = MAX_TEXT_BYTES / 2;
    let mut head = String::new();
    let mut tail: std::collections::VecDeque<Vec<u8>> = Default::default();
    let mut chunk: Vec<u8> = Vec::new();
    let mut tail_bytes = 0usize;
    let mut total = 0usize;
    let mut truncated = false;
    loop {
        if cancel.is_cancelled() {
            kill_tree(&mut child);
            return Err(IdeError::cancelled());
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok((_, line)) if encoding.notice.as_ref() == Some(&line) => {}
            Ok((stream, line)) => {
                on_line(stream, &line);
                if !bounded {
                    // The caller parses a complete model from `text`, so keep every line.
                    head.push_str(&line);
                    head.push('\n');
                    continue;
                }
                total += line.len() + 1;
                if !truncated {
                    if head.len() + line.len() < cap {
                        head.push_str(&line);
                        head.push('\n');
                        continue;
                    }
                    truncated = true;
                }
                // Fixed-size chunks, not per-line buffers: a chatty build pushes millions of
                // lines past the cap, and the tail must add no allocation per line.
                chunk.extend_from_slice(line.as_bytes());
                chunk.push(b'\n');
                if chunk.len() >= 64 * 1024 {
                    tail_bytes += chunk.len();
                    tail.push_back(std::mem::take(&mut chunk));
                    chunk.reserve_exact(64 * 1024);
                    while tail_bytes > cap {
                        let Some(front) = tail.pop_front() else { break };
                        tail_bytes -= front.len();
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    for r in readers.into_iter().flatten() {
        let _ = r.join();
    }
    let status = child.wait()?;
    let mut text = head;
    if truncated {
        if !chunk.is_empty() {
            tail_bytes += chunk.len();
            tail.push_back(std::mem::take(&mut chunk));
        }
        // The last partial chunk may sit past the cap; drop whole front chunks back under it.
        while tail_bytes > cap {
            let Some(front) = tail.pop_front() else { break };
            tail_bytes -= front.len();
        }
        // Tail chunks are flushed only right after a completed line, so the tail always begins
        // at a line boundary — no leading fragment to drop.
        let tail = ide_core::output_encoding::decode_tool_output(&tail.into_iter().flatten().collect::<Vec<u8>>());
        let omitted = total.saturating_sub(text.len() + tail.len());
        if omitted == 0 {
            // Everything that overflowed the head still fits in the tail: nothing was lost.
            truncated = false;
        } else {
            text.push_str(&format!("[{omitted} bytes of build output between these lines were not retained]\n"));
        }
        text.push_str(&tail);
    }
    Ok(Output { success: status.success(), text, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_model_line_over_one_mebibyte_is_kept_whole_for_the_parsers() {
        if cfg!(windows) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        // A Gradle MODEL_LINE JSON line longer than the bounded pump's 1 MiB line cap,
        // surrounded by ordinary output.
        let script = "echo start; head -c 1048576 /dev/zero | tr '\\0' a; printf '\\n{\"id\":\"big\"}\\n'; echo end";
        let mut lines = Vec::new();
        let out = run(
            "sh",
            &["-c".into(), script.into()],
            tmp.path(),
            &BTreeMap::new(),
            &CancellationToken::new(),
            |_, line| lines.push(line.to_owned()),
        )
        .unwrap();
        assert!(out.success);
        assert!(!out.truncated);
        // The long line is one line, not segments that a JSON-line parser would skip.
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[1].len(), 1_048_576);
        assert!(out.text.contains("{\"id\":\"big\"}"));
        let models: Vec<serde_json::Value> = out.text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        assert_eq!(models.len(), 1, "the model line must survive full retention");
    }

    #[test]
    fn a_successful_report_over_the_text_cap_is_retained_in_full() {
        if cfg!(windows) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let args = ["-c".into(), r"awk 'BEGIN{for(i=1;i<=6000000;i++)print i}'".into()];
        let mut fed = 0usize;
        let out = run("sh", &args, tmp.path(), &BTreeMap::new(), &CancellationToken::new(), |_, line| {
            fed += line.len() + 1;
        })
        .unwrap();
        assert!(out.success);
        assert!(!out.truncated);
        // Every line of a large successful dependency/model report is still there.
        assert_eq!(out.text.len(), fed);
        assert!(out.text.starts_with("1\n"));
        assert!(out.text.ends_with("6000000\n"));
    }

    #[test]
    fn runs_and_cancels_processes() {
        if cfg!(windows) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let mut lines = Vec::new();
        let out = run(
            "sh",
            &["-c".into(), "echo one; echo two >&2; exit 3".into()],
            tmp.path(),
            &BTreeMap::new(),
            &cancel,
            |s, l| lines.push((s, l.to_owned())),
        )
        .unwrap();
        assert!(!out.success);
        assert!(!out.truncated);
        lines.sort_by(|a, b| a.1.cmp(&b.1));
        assert_eq!(lines, [(Stream::Stdout, "one".to_owned()), (Stream::Stderr, "two".to_owned())]);
        cancel.cancel();
        let err = run_bounded("sh", &["-c".into(), "sleep 5".into()], tmp.path(), &BTreeMap::new(), &cancel, |_, _| {})
            .err()
            .unwrap();
        assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
    }

    #[test]
    fn cancel_kills_grandchildren() {
        if cfg!(windows) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let marker = tmp.path().join("survived");
        let script = format!("(sleep 1; touch '{}') & wait", marker.display());
        let c = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            c.cancel();
        });
        let err =
            run_bounded("sh", &["-c".into(), script], tmp.path(), &BTreeMap::new(), &cancel, |_, _| {}).err().unwrap();
        assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
        std::thread::sleep(Duration::from_millis(1300));
        assert!(!marker.exists(), "the background child must be killed with the group");
    }

    #[test]
    fn output_past_the_text_cap_keeps_head_and_tail_and_drains() {
        if cfg!(windows) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        // Numbered lines 1..=6,000,000 ≈ 45 MB: past the 32 MiB retained cap.
        let args = ["-c".into(), r"awk 'BEGIN{for(i=1;i<=6000000;i++)print i}'".into()];
        let mut fed = 0usize;
        let mut last_seen = String::new();
        let out = run_bounded("sh", &args, tmp.path(), &BTreeMap::new(), &CancellationToken::new(), |_, line| {
            fed += line.len() + 1;
            last_seen = line.to_owned();
        })
        .unwrap();
        assert!(out.success);
        assert!(out.truncated);
        // The pipes drained to the end: the callback saw the last line.
        assert_eq!(last_seen, "6000000");
        assert_eq!(fed, out_success_bytes());
        // The retained copy is bounded, keeps the head and the tail, and says what was dropped.
        assert!(out.text.len() <= MAX_TEXT_BYTES + 128, "{}", out.text.len());
        assert!(out.text.starts_with("1\n"));
        assert!(out.text.ends_with("6000000\n"));
        assert!(out.text.contains("were not retained]"));
        assert!(!out.text.contains("\n3000000\n"), "a middle line must be the dropped part");
    }

    /// Lines `1..=6_000_000` emit exactly this many bytes (digit count + newline each).
    fn out_success_bytes() -> usize {
        (1..=6_000_000u64).map(|n| n.checked_ilog10().unwrap() as usize + 2).sum()
    }

    #[test]
    fn a_newline_free_run_longer_than_the_line_cap_arrives_as_split_lines() {
        if cfg!(windows) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        // 2.5 MiB of `x` without a single newline.
        let args = ["-c".into(), "head -c 2621440 /dev/zero | tr '\\0' x".into()];
        let mut lines = Vec::new();
        let out = run_bounded("sh", &args, tmp.path(), &BTreeMap::new(), &CancellationToken::new(), |_, line| {
            lines.push(line.to_owned())
        })
        .unwrap();
        assert!(out.success);
        assert!(!out.truncated);
        // Split at the cap, not dropped: the segments carry every byte and none is unbounded.
        assert!(lines.len() >= 3, "{}", lines.len());
        assert_eq!(lines.iter().map(String::len).sum::<usize>(), 2_621_440);
        assert!(lines.iter().all(|l| l.len() <= MAX_LINE_BYTES));
    }

    #[test]
    fn a_line_split_never_cuts_a_multibyte_character() {
        if cfg!(windows) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        // `x` up to one byte before the 1 MiB cap, then `é` (two bytes) straddling it, then more `x`.
        let script =
            "head -c 1048575 /dev/zero | tr '\\0' x; printf '\\303\\251'; head -c 1048575 /dev/zero | tr '\\0' x";
        let mut lines = Vec::new();
        let out = run_bounded(
            "sh",
            &["-c".into(), script.into()],
            tmp.path(),
            &BTreeMap::new(),
            &CancellationToken::new(),
            |_, line| lines.push(line.to_owned()),
        )
        .unwrap();
        assert!(out.success);
        // The é straddles the 1 MiB split point: segments shift to keep it whole.
        assert!(lines.len() >= 2, "{}", lines.len());
        // The character survived the split: present whole, never as U+FFFD halves.
        assert!(lines.iter().any(|l| l.contains('é')));
        assert!(lines.iter().all(|l| !l.contains('\u{FFFD}')));
        assert_eq!(lines.iter().map(String::len).sum::<usize>(), 1_048_575 + 2 + 1_048_575);
    }

    #[test]
    fn output_just_past_the_head_cap_loses_nothing() {
        if cfg!(windows) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        // 4-byte `pad` lines up to just past the 16 MiB head cap, then the real last line:
        // the overflow fits the tail whole, so nothing is dropped and nothing is marked.
        let script = "yes pad | head -c 16777213; echo 'FATAL: the real error'";
        let out = run_bounded(
            "sh",
            &["-c".into(), script.into()],
            tmp.path(),
            &BTreeMap::new(),
            &CancellationToken::new(),
            |_, _| {},
        )
        .unwrap();
        assert!(out.success);
        assert!(!out.truncated);
        assert!(!out.text.contains("were not retained]"));
        assert!(out.text.starts_with("pad\n"));
        assert!(out.text.ends_with("FATAL: the real error\n"));
    }
}
