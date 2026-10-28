//! Child processes for installers: streamed output, cancellation, timeouts,
//! and `curl`-based downloads with progress.

use crate::InstallEvent;
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub type Emit<'a> = &'a dyn Fn(InstallEvent);

fn kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn describe(cmd: &Command) -> String {
    let mut s = Path::new(cmd.get_program()).file_name().unwrap_or_default().to_string_lossy().into_owned();
    for a in cmd.get_args() {
        s.push(' ');
        s.push_str(&a.to_string_lossy());
    }
    s
}

/// Runs `cmd`, forwarding each stdout/stderr line as [`InstallEvent::Line`].
/// Returns the collected output; fails on non-zero exit or cancellation.
pub fn run_streamed(cmd: Command, cancel: &CancellationToken, emit: Emit) -> IdeResult<String> {
    let label = describe(&cmd);
    let (ok, output, status) = run_collect(cmd, cancel, emit)?;
    if !ok {
        let tail: Vec<&str> = output.lines().rev().filter(|l| !l.trim().is_empty()).take(3).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        return Err(IdeError::new(
            ErrorKind::Io,
            format!(
                "`{label}` failed ({status}){}",
                if tail.is_empty() { String::new() } else { format!(": {}", tail.join(" / ")) }
            ),
        ));
    }
    Ok(output)
}

/// Like [`run_streamed`] but returns `(success, output, status text)` instead of failing on a non-zero exit.
pub fn run_collect(mut cmd: Command, cancel: &CancellationToken, emit: Emit) -> IdeResult<(bool, String, String)> {
    emit(InstallEvent::Line { text: format!("$ {}", describe(&cmd)) });
    ide_core::process::prepare(&mut cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("cannot run {}: {e}", describe(&cmd))))?;
    let (tx, rx) = mpsc::channel::<String>();
    let pipes: [Option<Box<dyn Read + Send>>; 2] = [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
    ];
    for pipe in pipes.into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    let mut output = String::new();
    let status = loop {
        if cancel.is_cancelled() {
            kill(&mut child);
            return Err(IdeError::cancelled());
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                let line = strip_ansi(&line);
                if !line.trim().is_empty() {
                    emit(InstallEvent::Line { text: line.clone() });
                }
                output.push_str(&line);
                output.push('\n');
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => match child.try_wait()? {
                Some(s) => break s,
                None => std::thread::sleep(Duration::from_millis(50)),
            },
        }
    };
    Ok((status.success(), output, status.to_string()))
}

/// Runs `cmd` to completion within `timeout`; returns (success, stdout + stderr).
pub fn run_quiet(mut cmd: Command, timeout: Duration) -> Option<(bool, String)> {
    ide_core::process::prepare(&mut cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                kill(&mut child);
                return None;
            }
        }
    };
    let mut text = out_t.join().unwrap_or_default();
    text.push_str(&err_t.join().unwrap_or_default());
    Some((status.success(), text))
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else if c == '\r' {
            out.clear();
        } else {
            out.push(c);
        }
    }
    out
}

/// HTTP via the system `curl` (shipped with macOS, Windows 10+ and every
/// mainstream Linux), so the IDE carries no TLS stack of its own.
pub struct Http {
    curl: std::path::PathBuf,
}

impl Http {
    pub fn new(search_path: &std::ffi::OsStr) -> IdeResult<Self> {
        let curl = which::which_in("curl", Some(search_path), ".")
            .map_err(|_| IdeError::unavailable("`curl` is required to download tools"))?;
        Ok(Self { curl })
    }

    fn base(&self, url: &str) -> Command {
        let mut cmd = Command::new(&self.curl);
        ide_core::process::prepare(&mut cmd);
        cmd.args(["-fsSL", "--retry", "2", "--connect-timeout", "20", "-A", "openidea"]);
        if url.starts_with("https://api.github.com/")
            && let Ok(token) = std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GH_TOKEN"))
            && !token.is_empty()
        {
            cmd.arg("-H").arg(format!("Authorization: Bearer {token}"));
        }
        cmd
    }

    /// GETs `url` as text.
    pub fn get_text(&self, url: &str, cancel: &CancellationToken) -> IdeResult<String> {
        let mut cmd = self.base(url);
        cmd.arg(url).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("cannot run curl: {e}")))?;
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let out_t = std::thread::spawn(move || {
            let mut s = Vec::new();
            let _ = stdout.read_to_end(&mut s);
            s
        });
        let status = loop {
            if cancel.is_cancelled() {
                kill(&mut child);
                return Err(IdeError::cancelled());
            }
            match child.try_wait()? {
                Some(s) => break s,
                None => std::thread::sleep(Duration::from_millis(30)),
            }
        };
        let body = out_t.join().unwrap_or_default();
        if !status.success() {
            let mut err = String::new();
            let _ = stderr.read_to_string(&mut err);
            return Err(IdeError::new(ErrorKind::Io, format!("GET {url} failed: {}", err.trim())));
        }
        String::from_utf8(body).map_err(|_| IdeError::new(ErrorKind::Protocol, format!("{url}: response is not UTF-8")))
    }

    /// Downloads `url` to `dest`, reporting progress against `size` when known.
    pub fn download(
        &self,
        url: &str,
        dest: &Path,
        size: Option<u64>,
        cancel: &CancellationToken,
        emit: Emit,
    ) -> IdeResult<()> {
        let mut cmd = self.base(url);
        cmd.arg("-o").arg(dest).arg(url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("cannot run curl: {e}")))?;
        let mut stderr = child.stderr.take().expect("piped");
        let err_t = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });
        let mut last = Instant::now();
        let mut last_bytes = 0;
        let status = loop {
            if cancel.is_cancelled() {
                kill(&mut child);
                let _ = std::fs::remove_file(dest);
                return Err(IdeError::cancelled());
            }
            if let Some(s) = child.try_wait()? {
                break s;
            }
            std::thread::sleep(Duration::from_millis(50));
            if last.elapsed() >= Duration::from_millis(250) {
                last = Instant::now();
                let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
                if bytes != last_bytes {
                    last_bytes = bytes;
                    emit(progress_event(bytes, size));
                }
            }
        };
        if !status.success() {
            return Err(IdeError::new(
                ErrorKind::Io,
                format!("download of {url} failed: {}", err_t.join().unwrap_or_default().trim()),
            ));
        }
        let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        emit(progress_event(bytes, size.or(Some(bytes))));
        Ok(())
    }
}

pub fn progress_event(bytes: u64, size: Option<u64>) -> InstallEvent {
    let mb = |b: u64| b as f64 / 1_048_576.0;
    match size.filter(|s| *s > 0) {
        Some(total) => InstallEvent::Progress {
            fraction: Some((bytes as f64 / total as f64).min(1.0)),
            message: format!("Downloaded {:.1} of {:.1} MB", mb(bytes), mb(total)),
        },
        None => InstallEvent::Progress { fraction: None, message: format!("Downloaded {:.1} MB", mb(bytes)) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi_and_carriage_returns_are_cleaned() {
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m"), "ok");
        assert_eq!(strip_ansi("10%\r50%\r100%"), "100%");
    }

    #[test]
    fn progress_fraction() {
        match progress_event(512 * 1024, Some(1024 * 1024)) {
            InstallEvent::Progress { fraction: Some(f), message } => {
                assert!((f - 0.5).abs() < 1e-9);
                assert_eq!(message, "Downloaded 0.5 of 1.0 MB");
            }
            e => panic!("unexpected {e:?}"),
        }
        assert!(matches!(progress_event(10, None), InstallEvent::Progress { fraction: None, .. }));
    }

    #[cfg(unix)]
    #[test]
    fn streams_lines_and_reports_failure() {
        let lines = std::sync::Mutex::new(Vec::new());
        let emit = |e: InstallEvent| {
            if let InstallEvent::Line { text } = e {
                lines.lock().unwrap().push(text);
            }
        };
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo one; echo two >&2; exit 3"]);
        let err = run_streamed(cmd, &CancellationToken::new(), &emit).unwrap_err();
        assert!(err.message.contains("failed"), "{}", err.message);
        let lines = lines.into_inner().unwrap();
        assert!(lines.contains(&"one".to_string()) && lines.contains(&"two".to_string()), "{lines:?}");
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_kills_the_child() {
        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            c2.cancel();
        });
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 10"]);
        let started = Instant::now();
        let err = run_streamed(cmd, &cancel, &|_| {}).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn quiet_run_times_out() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 5"]);
        assert!(run_quiet(cmd, Duration::from_millis(100)).is_none());
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo v1.2.3"]);
        assert_eq!(run_quiet(cmd, Duration::from_secs(5)), Some((true, "v1.2.3\n".into())));
    }
}
