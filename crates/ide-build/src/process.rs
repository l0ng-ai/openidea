//! Line-oriented child processes for syncs and builds: output is fed line by
//! line to a callback, and cancellation kills the whole process group (the
//! `mvnw` / `gradlew` wrapper scripts start the JVM as a child).

use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stream {
    Stdout,
    Stderr,
}

pub(crate) struct Output {
    pub success: bool,
    /// Every line, stdout and stderr interleaved as received.
    pub text: String,
}

fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: plain syscall; the group was created by `process_group(0)` at spawn.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs `program args` in `cwd`, feeding each output line to `on_line`; kills
/// the process group and returns `cancelled` when `cancel` fires.
pub(crate) fn run(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    cancel: &CancellationToken,
    mut on_line: impl FnMut(Stream, &str),
) -> IdeResult<Output> {
    tracing::info!("build: {program} {} (in {})", args.join(" "), cwd.display());
    // Output is read as UTF-8: JVMs on Windows are told to write it (see `ide_core::output_encoding`).
    let encoding =
        ide_core::output_encoding::fix(program, args, env, |k| std::env::var(k).ok(), "UTF-8", cfg!(windows));
    let mut command = Command::new(program);
    command.args(args).current_dir(cwd).envs(env).envs(encoding.env).stdin(Stdio::null());
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    ide_core::process::prepare(&mut command);
    let mut child = command.spawn().map_err(|e| IdeError::unavailable(format!("cannot start {program}: {e}")))?;
    let (tx, rx) = mpsc::channel::<(Stream, String)>();
    let pump = |stream: Box<dyn Read + Send>, kind: Stream, tx: mpsc::Sender<(Stream, String)>| {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf);
                        let line = line.trim_end_matches(['\n', '\r']).to_owned();
                        if tx.send((kind, line)).is_err() {
                            break;
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
    let mut text = String::new();
    loop {
        if cancel.is_cancelled() {
            kill_tree(&mut child);
            return Err(IdeError::cancelled());
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok((_, line)) if encoding.notice.as_ref() == Some(&line) => {}
            Ok((stream, line)) => {
                on_line(stream, &line);
                text.push_str(&line);
                text.push('\n');
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    for r in readers.into_iter().flatten() {
        let _ = r.join();
    }
    let status = child.wait()?;
    Ok(Output { success: status.success(), text })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        lines.sort_by(|a, b| a.1.cmp(&b.1));
        assert_eq!(lines, [(Stream::Stdout, "one".to_owned()), (Stream::Stderr, "two".to_owned())]);
        cancel.cancel();
        let err = run("sh", &["-c".into(), "sleep 5".into()], tmp.path(), &BTreeMap::new(), &cancel, |_, _| {})
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
        let err = run("sh", &["-c".into(), script], tmp.path(), &BTreeMap::new(), &cancel, |_, _| {}).err().unwrap();
        assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
        std::thread::sleep(Duration::from_millis(1300));
        assert!(!marker.exists(), "the background child must be killed with the group");
    }
}
