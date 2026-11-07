//! Child processes for installers: streamed output, cancellation, timeouts,
//! and `curl`-based downloads with progress.

use crate::InstallEvent;
use ide_core::error::ErrorKind;
use ide_core::output_encoding::decode_tool_output;
use ide_core::process::{kill_tree, own_group};
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub type Emit<'a> = &'a dyn Fn(InstallEvent);

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
    own_group(ide_core::process::prepare(&mut cmd)).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("cannot run {}: {e}", describe(&cmd))))?;
    let (tx, rx) = mpsc::channel::<String>();
    let pipes: [Option<Box<dyn Read + Send>>; 2] = [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
    ];
    for pipe in pipes.into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).split(b'\n') {
                let Ok(line) = line else { break };
                let line = decode_tool_output(&line).trim_end_matches('\r').to_owned();
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
            kill_tree(&mut child);
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
        let mut s = Vec::new();
        let _ = stdout.read_to_end(&mut s);
        decode_tool_output(&s)
    });
    let err_t = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = stderr.read_to_end(&mut s);
        decode_tool_output(&s)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                kill_tree(&mut child);
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

const MAX_GITHUB_TOKEN: usize = 4096;

fn valid_github_token(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= MAX_GITHUB_TOKEN && value.bytes().all(|b| b.is_ascii_graphic()))
        .then(|| value.to_owned())
}

fn environment_github_token(read: impl Fn(&str) -> Option<String>) -> Option<String> {
    ["GITHUB_TOKEN", "GH_TOKEN"].into_iter().find_map(|key| read(key).and_then(valid_github_token))
}

/// Ask gh for the active github.com account on each request, so switching or
/// logging out takes effect without persisting a second copy of the credential.
fn read_gh_token(gh: &Path, cancel: &CancellationToken, timeout: Duration) -> IdeResult<Option<String>> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let mut cmd = Command::new(gh);
    own_group(ide_core::process::prepare(&mut cmd));
    cmd.args(["auth", "token", "--hostname", "github.com"])
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return Ok(None) };
    let stdout = child.stdout.take().expect("piped");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take((MAX_GITHUB_TOKEN + 2) as u64).read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let started = Instant::now();
    let mut status = None;
    let mut output = None;
    let bytes = loop {
        if cancel.is_cancelled() || started.elapsed() >= timeout {
            kill_tree(&mut child);
            return if cancel.is_cancelled() { Err(IdeError::cancelled()) } else { Ok(None) };
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(_) => {
                    kill_tree(&mut child);
                    return Ok(None);
                }
            }
        }
        if let Some(status) = status {
            if !status.success() {
                kill_tree(&mut child);
                return Ok(None);
            }
            if let Some(bytes) = output.take() {
                break bytes;
            }
        }
        match rx.recv_timeout(Duration::from_millis(15)) {
            Ok(bytes) => output = Some(bytes),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => std::thread::sleep(Duration::from_millis(15)),
        }
    };
    if bytes.len() > MAX_GITHUB_TOKEN + 1 {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok().and_then(valid_github_token))
}

fn send_auth(child: &mut Child, token: Option<&str>) -> IdeResult<()> {
    if let Some(token) = token {
        let result = child
            .stdin
            .take()
            .expect("authenticated request has piped stdin")
            .write_all(format!("Authorization: Bearer {token}\n").as_bytes());
        if let Err(error) = result {
            kill_tree(child);
            return Err(IdeError::unavailable(format!("cannot pass download credentials to curl: {error}")));
        }
    }
    Ok(())
}

fn redact_auth(message: &str, token: Option<&str>) -> String {
    match token {
        Some(token) => message.replace(token, "[redacted]"),
        None => message.to_owned(),
    }
}

/// Whether `curl` checks certificate revocation with Schannel and takes
/// `--ssl-revoke-best-effort` (7.70+). Schannel fails the whole download with
/// CRYPT_E_REVOCATION_OFFLINE when the CRL/OCSP servers are unreachable (corporate
/// proxies, firewalls); best effort skips only that check, and still rejects
/// certificates that are actually revoked.
fn revoke_best_effort(curl: &Path) -> bool {
    static CHECKED: parking_lot::Mutex<Vec<(std::path::PathBuf, bool)>> = parking_lot::Mutex::new(Vec::new());
    if let Some((_, ok)) = CHECKED.lock().iter().find(|(path, _)| path == curl) {
        return *ok;
    }
    let mut cmd = Command::new(curl);
    cmd.arg("--version");
    let ok = run_quiet(cmd, Duration::from_secs(5))
        .is_some_and(|(success, out)| success && curl_takes_revoke_best_effort(&out));
    CHECKED.lock().push((curl.to_path_buf(), ok));
    ok
}

/// Reads `curl --version`: `curl 8.9.1 (Windows) libcurl/8.9.1 Schannel …`.
fn curl_takes_revoke_best_effort(version: &str) -> bool {
    let Some(first) = version.lines().find(|l| l.starts_with("curl ")) else { return false };
    let mut parts = first.split_whitespace().nth(1).unwrap_or("").split('.').map(|n| n.parse::<u32>().ok());
    let (Some(Some(major)), Some(Some(minor))) = (parts.next(), parts.next()) else { return false };
    (major, minor) >= (7, 70) && first.split_whitespace().any(|w| w.eq_ignore_ascii_case("schannel"))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Request {
    Get,
    /// Adoptium uses 404 as well as an empty array for absent platform builds.
    GetOrEmptyOn404,
    /// Headers, then the URL redirects ended at.
    Head,
}

/// HTTP via the system `curl` (shipped with macOS, Windows 10+ and every
/// mainstream Linux), so the IDE carries no TLS stack of its own.
pub struct Http {
    curl: std::path::PathBuf,
    gh: Option<std::path::PathBuf>,
    explicit_github_token: Option<String>,
    https_only: bool,
    revoke_best_effort: bool,
}

impl Http {
    pub fn new(search_path: &std::ffi::OsStr) -> IdeResult<Self> {
        let curl = which::which_in("curl", Some(search_path), ".")
            .map_err(|_| IdeError::unavailable("`curl` is required to download tools"))?;
        let gh = which::which_in("gh", Some(search_path), ".").ok();
        let explicit_github_token = environment_github_token(|key| std::env::var(key).ok());
        let revoke_best_effort = cfg!(windows) && revoke_best_effort(&curl);
        Ok(Self { curl, gh, explicit_github_token, https_only: false, revoke_best_effort })
    }

    /// Refuses every protocol but HTTPS, redirects included.
    pub fn https_only(mut self) -> Self {
        self.https_only = true;
        self
    }

    fn base(&self, url: &str, cancel: &CancellationToken) -> IdeResult<(Command, Option<String>)> {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let github = url.starts_with("https://api.github.com/");
        let token = if github {
            match &self.explicit_github_token {
                Some(token) => Some(token.clone()),
                None => match &self.gh {
                    Some(gh) => read_gh_token(gh, cancel, Duration::from_secs(5))?,
                    None => None,
                },
            }
        } else {
            None
        };
        let mut cmd = Command::new(&self.curl);
        // A user curlrc must not enable verbose token logging or forwarding
        // Authorization across origins on authenticated API requests.
        if token.is_some() {
            cmd.arg("-q");
        }
        own_group(ide_core::process::prepare(&mut cmd));
        cmd.args(["-fsSL", "--retry", "2", "--connect-timeout", "20", "-A", "openidea"]);
        // System Settings › HTTP Proxy (a manual proxy comes in through `prepare`'s environment).
        cmd.args(ide_core::proxy_settings::proxy().curl_args(url));
        if self.https_only {
            cmd.args(["--proto", "=https", "--proto-redir", "=https"]);
        }
        if self.revoke_best_effort {
            cmd.arg("--ssl-revoke-best-effort");
        }
        cmd.stdin(Stdio::null());
        if token.is_some() {
            // Keep credentials out of process arguments, inherited environment,
            // and files. curl strips Authorization on cross-origin redirects.
            cmd.args(["--header", "@-", "--proto-redir", "=https"]);
            cmd.env_remove("GH_TOKEN").env_remove("GITHUB_TOKEN").stdin(Stdio::piped());
        }
        Ok((cmd, token))
    }

    /// GETs `url` as text.
    pub fn get_text(&self, url: &str, cancel: &CancellationToken) -> IdeResult<String> {
        self.get_text_limited(url, None, cancel)
    }

    /// Where `url` ends up after redirects (a HEAD request).
    pub fn effective_url(&self, url: &str, cancel: &CancellationToken) -> IdeResult<String> {
        let out = self.get_text_response(url, None, Request::Head, cancel)?;
        Ok(out.trim_end().rsplit('\n').next().unwrap_or_default().trim().to_owned())
    }

    /// GETs `url` as text, failing when the response is larger than `max_bytes`.
    pub fn get_text_limited(&self, url: &str, max_bytes: Option<u64>, cancel: &CancellationToken) -> IdeResult<String> {
        self.get_text_response(url, max_bytes, Request::Get, cancel)
    }

    /// Adoptium uses 404 as well as an empty array for absent platform builds.
    pub fn get_text_or_empty_on_404(&self, url: &str, cancel: &CancellationToken) -> IdeResult<String> {
        self.get_text_response(url, None, Request::GetOrEmptyOn404, cancel)
    }

    fn get_text_response(
        &self,
        url: &str,
        max_bytes: Option<u64>,
        request: Request,
        cancel: &CancellationToken,
    ) -> IdeResult<String> {
        let (mut cmd, token) = self.base(url, cancel)?;
        let empty_on_404 = request == Request::GetOrEmptyOn404;
        match request {
            Request::Get => {}
            Request::GetOrEmptyOn404 => {
                cmd.args(["--write-out", "\n%{http_code}"]);
            }
            Request::Head => {
                cmd.args(["--head", "--write-out", "\n%{url_effective}"]);
            }
        }
        if let Some(max) = max_bytes {
            cmd.arg("--max-filesize").arg(max.to_string());
        }
        cmd.arg(url).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("cannot run curl: {e}")))?;
        send_auth(&mut child, token.as_deref())?;
        let stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        // Past the limit the pipe closes, which stops curl.
        let limit = max_bytes.map_or(u64::MAX, |m| m + 1);
        let out_t = std::thread::spawn(move || {
            let mut s = Vec::new();
            let _ = stdout.take(limit).read_to_end(&mut s);
            s
        });
        let status = loop {
            if cancel.is_cancelled() {
                kill_tree(&mut child);
                return Err(IdeError::cancelled());
            }
            match child.try_wait()? {
                Some(s) => break s,
                None => std::thread::sleep(Duration::from_millis(30)),
            }
        };
        let mut body = out_t.join().unwrap_or_default();
        if empty_on_404 && let Some(split) = body.iter().rposition(|b| *b == b'\n') {
            let code = &body[split + 1..];
            if code == b"404" {
                return Ok("[]".into());
            }
            body.truncate(split);
        }
        if let Some(max) = max_bytes
            && body.len() as u64 > max
        {
            return Err(IdeError::new(ErrorKind::Io, format!("{url}: response is larger than {max} bytes")));
        }
        if !status.success() {
            let mut err = Vec::new();
            let _ = stderr.read_to_end(&mut err);
            let err = decode_tool_output(&err);
            return Err(IdeError::new(
                ErrorKind::Io,
                format!("GET {url} failed: {}", redact_auth(err.trim(), token.as_deref())),
            ));
        }
        String::from_utf8(body).map_err(|_| IdeError::new(ErrorKind::Protocol, format!("{url}: response is not UTF-8")))
    }

    /// Downloads `url` to `dest`, reporting progress against `size` when known.
    /// `-C -` resumes from the bytes `dest` already holds: a `--retry` inside
    /// curl — and a fresh `download` call after a timed-out attempt — keeps the
    /// part it has instead of starting over. A `dest` already the remote's size
    /// is reported "fully downloaded" and left alone. When the server answers
    /// no byte ranges (curl exit 33) the partial is dropped and the download
    /// starts over, the pre-resume behavior.
    pub fn download(
        &self,
        url: &str,
        dest: &Path,
        size: Option<u64>,
        cancel: &CancellationToken,
        emit: Emit,
    ) -> IdeResult<()> {
        let had_partial = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0) > 0;
        let mut resume = true;
        loop {
            let (status, stderr, token) = self.fetch(url, dest, size, cancel, emit, resume)?;
            if status.success() {
                break;
            }
            if resume && had_partial && status.code() == Some(33) {
                resume = false;
                let _ = std::fs::remove_file(dest);
                continue;
            }
            return Err(IdeError::new(
                ErrorKind::Io,
                format!("download of {url} failed: {}", redact_auth(stderr.trim(), token.as_deref())),
            ));
        }
        let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        emit(progress_event(bytes, size.or(Some(bytes))));
        Ok(())
    }

    /// One curl download attempt: with `resume` it continues `dest`'s bytes,
    /// without it starts over. Returns curl's exit status, its stderr, and the
    /// auth token for redacting the failure message; spawn and cancellation
    /// failures are errors.
    fn fetch(
        &self,
        url: &str,
        dest: &Path,
        size: Option<u64>,
        cancel: &CancellationToken,
        emit: Emit,
        resume: bool,
    ) -> IdeResult<(std::process::ExitStatus, String, Option<String>)> {
        let (mut cmd, token) = self.base(url, cancel)?;
        if resume {
            cmd.args(["-C", "-"]);
        }
        cmd.arg("-o").arg(dest).arg(url).stdout(Stdio::null()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("cannot run curl: {e}")))?;
        send_auth(&mut child, token.as_deref())?;
        let mut stderr = child.stderr.take().expect("piped");
        let err_t = std::thread::spawn(move || {
            let mut s = Vec::new();
            let _ = stderr.read_to_end(&mut s);
            decode_tool_output(&s)
        });
        let mut last = Instant::now();
        let mut last_bytes = 0;
        let status = loop {
            if cancel.is_cancelled() {
                kill_tree(&mut child);
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
        Ok((status, err_t.join().unwrap_or_default(), token))
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

/// Runs a formatter with separate pipes so diagnostics can never become document text.
pub(crate) fn run_input(
    cmd: &mut Command,
    input: &str,
    timeout: Duration,
    cancel: &CancellationToken,
) -> IdeResult<String> {
    use std::io::Write;
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let mut child = own_group(cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_owned();
    // All pipes drain concurrently, including stdin: large documents cannot deadlock or bypass the timeout.
    enum Pipe {
        Written(std::io::Result<()>),
        Read(bool, std::io::Result<Vec<u8>>),
    }
    let (tx, rx) = mpsc::channel();
    let writer = tx.clone();
    std::thread::spawn(move || {
        let _ = writer.send(Pipe::Written(stdin.write_all(input.as_bytes())));
    });
    for (is_stderr, mut pipe) in [
        (false, Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>),
        (true, Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>),
    ] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = tx.send(Pipe::Read(is_stderr, pipe.read_to_end(&mut bytes).map(|_| bytes)));
        });
    }
    drop(tx);
    let started = Instant::now();
    let (mut status, mut output, mut errors, mut written) = (None, None, None, None);
    let result = loop {
        if cancel.is_cancelled() {
            break Err(IdeError::cancelled());
        }
        if started.elapsed() >= timeout {
            break Err(IdeError::new(ErrorKind::TimedOut, "Formatting timed out"));
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(s) => status = s,
                Err(e) => break Err(e.into()),
            }
        }
        if status.is_some() && output.is_some() && errors.is_some() && written.is_some() {
            break Ok(());
        }
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Pipe::Written(result)) => written = Some(result),
            Ok(Pipe::Read(true, result)) => errors = Some(result),
            Ok(Pipe::Read(false, result)) => output = Some(result),
            Err(mpsc::RecvTimeoutError::Disconnected) if output.is_some() && errors.is_some() && written.is_some() => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break Err(IdeError::internal("formatter pipe reader failed")),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    };
    if result.is_err() {
        kill_tree(&mut child);
    }
    result?;
    let output = output.unwrap()?;
    let errors = errors.unwrap()?;
    let status = status.unwrap();
    if !status.success() {
        let diagnostics: String = String::from_utf8_lossy(&errors).into_owned();
        return Err(IdeError::invalid(if diagnostics.trim().is_empty() {
            format!("Formatter exited with {status}")
        } else {
            diagnostics
        }));
    }
    written.unwrap()?;
    String::from_utf8(output).map_err(|e| IdeError::invalid(e.to_string()))
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

    #[test]
    fn revoke_best_effort_needs_schannel_curl_7_70() {
        let schannel = "curl 8.9.1 (Windows) libcurl/8.9.1 Schannel zlib/1.3 WinIDN\nRelease-Date: 2024-07-31\n";
        assert!(curl_takes_revoke_best_effort(schannel));
        assert!(curl_takes_revoke_best_effort("curl 7.70.0 (x86_64-pc-win32) libcurl/7.70.0 Schannel\n"));
        // Windows 10 1803 shipped 7.55, which rejects the unknown option.
        assert!(!curl_takes_revoke_best_effort("curl 7.55.1 (Windows) libcurl/7.55.1 WinSSL\n"));
        // OpenSSL never checks revocation this way; Schannel in parentheses is not the active backend.
        assert!(!curl_takes_revoke_best_effort(
            "curl 8.10.1 (x86_64-w64-mingw32) libcurl/8.10.1 OpenSSL/3.2.3 (Schannel)\n"
        ));
        assert!(!curl_takes_revoke_best_effort("WARNING: this libcurl is Debug-enabled\n"));
        assert!(curl_takes_revoke_best_effort(&format!("WARNING: this libcurl is Debug-enabled\n\n{schannel}")));
    }

    #[cfg(unix)]
    #[test]
    fn absent_build_is_empty_but_http_failures_are_not() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let curl = tmp.path().join("curl");
        let http = Http {
            curl: curl.clone(),
            gh: None,
            explicit_github_token: None,
            https_only: false,
            revoke_best_effort: false,
        };
        for (code, exit, expected) in [(404, 22, Some("[]")), (200, 0, Some("payload")), (403, 22, None), (0, 7, None)]
        {
            std::fs::write(&curl, format!("#!/bin/sh\nprintf 'payload\\n{code:03}'\nexit {exit}\n")).unwrap();
            std::fs::set_permissions(&curl, std::fs::Permissions::from_mode(0o755)).unwrap();
            let result = http.get_text_or_empty_on_404("https://example.test/build", &CancellationToken::new());
            match expected {
                Some(body) => assert_eq!(result.unwrap(), body),
                None => assert!(result.is_err()),
            }
        }
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

    /// `npm` / `go` / `pip` run the real work in children of their own: cancelling
    /// kills those too, not only the process the installer started.
    #[cfg(unix)]
    #[test]
    fn cancellation_kills_what_the_child_started() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        let watch = pid_file.clone();
        std::thread::spawn(move || {
            while !watch.exists() {
                std::thread::sleep(Duration::from_millis(10));
            }
            std::thread::sleep(Duration::from_millis(50));
            c2.cancel();
        });
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(format!("sleep 30 & echo $! > '{}'; wait", pid_file.display()));
        let err = run_streamed(cmd, &cancel, &|_| {}).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Cancelled);
        let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only checks that the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < deadline, "the grandchild {pid} survived the cancel");
            std::thread::sleep(Duration::from_millis(20));
        }
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

#[cfg(all(test, unix))]
mod input_tests {
    use super::*;

    #[test]
    fn separate_diagnostics_and_never_return_failed_output() {
        let mut command = Command::new("sh");
        command.args(["-c", "cat; printf warning >&2"]);
        assert_eq!(run_input(&mut command, "a😀\n", Duration::from_secs(2), &Default::default()).unwrap(), "a😀\n");
        let mut command = Command::new("sh");
        command.args(["-c", "printf broken; printf 'invalid syntax' >&2; exit 1"]);
        let e = run_input(&mut command, "", Duration::from_secs(2), &Default::default()).unwrap_err();
        assert_eq!(e.message, "invalid syntax");
    }

    #[test]
    fn timeout_kills_formatter_and_cancellation_prevents_start() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 10 &"]);
        let start = Instant::now();
        assert_eq!(
            run_input(&mut command, "", Duration::from_millis(50), &Default::default()).unwrap_err().kind,
            ErrorKind::TimedOut
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            run_input(&mut Command::new("does-not-exist"), "", Duration::from_secs(2), &cancel).unwrap_err().kind,
            ErrorKind::Cancelled
        );
    }
}

#[cfg(test)]
mod github_auth_tests {
    use super::*;

    #[test]
    fn explicit_tokens_keep_precedence_and_reject_header_injection() {
        let read = |key: &str| Some(if key == "GITHUB_TOKEN" { "first" } else { "second" }.to_owned());
        assert_eq!(environment_github_token(read).as_deref(), Some("first"));
        assert_eq!(
            environment_github_token(|key| Some(if key == "GITHUB_TOKEN" { "" } else { "second" }.into())).as_deref(),
            Some("second")
        );
        for bad in ["", "two words", "token\r\nX-Injected: yes", "token\0"] {
            assert!(valid_github_token(bad.into()).is_none());
        }
        assert!(valid_github_token("a".repeat(MAX_GITHUB_TOKEN + 1)).is_none());
        assert_eq!(valid_github_token("gho_example\n".into()).as_deref(), Some("gho_example"));
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::path::PathBuf;

        fn quote(path: &Path) -> String {
            format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
        }
        struct Fixture {
            dir: tempfile::TempDir,
            http: Http,
        }
        impl Fixture {
            fn new() -> Self {
                let dir = tempfile::tempdir().unwrap();
                let curl = dir.path().join("curl");
                let gh = dir.path().join("gh");
                let fixture = Self {
                    dir,
                    http: Http {
                        curl,
                        gh: Some(gh),
                        explicit_github_token: None,
                        https_only: false,
                        revoke_best_effort: false,
                    },
                };
                fixture.script(
                    "gh",
                    &format!(
                        "printf '%s\\n' \"$@\" >> {}\n/bin/cat {}",
                        quote(&fixture.path("gh-args")),
                        quote(&fixture.path("token"))
                    ),
                );
                fs::write(fixture.path("token"), "gho_fake_first\n").unwrap();
                fixture.curl("printf '{\"ok\":true}'");
                fixture
            }
            fn path(&self, name: &str) -> PathBuf {
                self.dir.path().join(name)
            }
            fn script(&self, name: &str, body: &str) {
                let path = self.path(name);
                fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
                fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
            }
            fn curl(&self, body: &str) {
                self.script(
                    "curl",
                    &format!(
                        "printf '%s\\n' \"$@\" > {}\n/bin/cat > {}\n{body}",
                        quote(&self.path("curl-args")),
                        quote(&self.path("headers"))
                    ),
                );
            }
            fn get(&self, url: &str) -> IdeResult<String> {
                self.http.get_text(url, &CancellationToken::new())
            }
        }
        const API: &str = "https://api.github.com/repos/example/project/releases/latest";

        #[test]
        fn active_gh_account_is_read_per_request_and_token_is_not_an_argument() {
            let f = Fixture::new();
            assert_eq!(f.get(API).unwrap(), "{\"ok\":true}");
            assert_eq!(fs::read_to_string(f.path("headers")).unwrap(), "Authorization: Bearer gho_fake_first\n");
            let args = fs::read_to_string(f.path("curl-args")).unwrap();
            assert!(!args.contains("gho_fake"));
            assert!(args.starts_with("-q\n"));
            assert!(args.contains("--header\n@-\n--proto-redir\n=https\n"));
            assert!(!args.contains("--location-trusted"));
            assert_eq!(fs::read_to_string(f.path("gh-args")).unwrap(), "auth\ntoken\n--hostname\ngithub.com\n");
            fs::write(f.path("token"), "gho_fake_second\n").unwrap();
            f.get(API).unwrap();
            assert_eq!(fs::read_to_string(f.path("headers")).unwrap(), "Authorization: Bearer gho_fake_second\n");
        }

        #[test]
        fn explicit_token_avoids_gh_and_non_github_urls_receive_no_credentials() {
            let mut f = Fixture::new();
            f.http.explicit_github_token = Some("explicit_fake".into());
            f.get(API).unwrap();
            assert!(!f.path("gh-args").exists());
            assert_eq!(fs::read_to_string(f.path("headers")).unwrap(), "Authorization: Bearer explicit_fake\n");
            f.http.explicit_github_token = None;
            for url in [
                "https://example.com/file",
                "http://api.github.com/repos/x",
                "https://api.github.com.evil.example/file",
                "https://api.github.com@evil.example/file",
                "https://github.com/example/project/releases/download/v1/file",
            ] {
                f.get(url).unwrap();
                assert_eq!(fs::read_to_string(f.path("headers")).unwrap(), "");
                assert!(!f.path("gh-args").exists());
            }
        }

        #[test]
        fn missing_logged_out_or_malformed_gh_falls_back_to_anonymous() {
            let mut f = Fixture::new();
            for body in ["exit 1", "printf 'fake\\nX-Injected: yes\\n'", "printf ''", "printf 'fake'; exit 1"] {
                f.script("gh", body);
                f.get(API).unwrap();
                assert_eq!(fs::read_to_string(f.path("headers")).unwrap(), "");
            }
            f.http.gh = None;
            f.get(API).unwrap();
            assert_eq!(fs::read_to_string(f.path("headers")).unwrap(), "");
        }

        #[test]
        fn download_auth_and_errors_do_not_expose_the_token() {
            let f = Fixture::new();
            let dest = f.path("download");
            f.curl(&format!("printf downloaded > {}", quote(&dest)));
            f.http.download(API, &dest, None, &CancellationToken::new(), &|_| {}).unwrap();
            assert_eq!(fs::read_to_string(&dest).unwrap(), "downloaded");
            assert!(fs::read_to_string(f.path("headers")).unwrap().contains("gho_fake_first"));
            f.curl(&format!("/bin/cat {} >&2; exit 22", quote(&f.path("headers"))));
            let error = f.get(API).unwrap_err().to_string();
            assert!(error.contains("[redacted]"));
            assert!(!error.contains("gho_fake_first"));
            let error = f.http.download(API, &dest, None, &CancellationToken::new(), &|_| {}).unwrap_err().to_string();
            assert!(!error.contains("gho_fake_first"));
        }

        #[test]
        fn download_resumes_the_partial_file() {
            let f = Fixture::new();
            let dest = f.path("download");
            f.curl(&format!("printf done > {}", quote(&dest)));
            f.http.download("https://example.test/file", &dest, None, &CancellationToken::new(), &|_| {}).unwrap();
            assert!(
                fs::read_to_string(f.path("curl-args")).unwrap().contains("-C\n-\n"),
                "curl resumes the partial file with `-C -`"
            );
        }

        #[test]
        fn download_restarts_when_the_server_has_no_byte_ranges() {
            let f = Fixture::new();
            let dest = f.path("download");
            let count = f.path("attempts");
            fs::write(&dest, "partial").unwrap();
            // First attempt: curl reports it cannot resume (exit 33). Second:
            // a plain download from zero, which succeeds.
            f.curl(&format!(
                "n=$(cat {} 2>/dev/null || echo 0); echo $((n + 1)) > {}; \
                 if [ \"$n\" = 0 ]; then echo 'curl: (33) no byte ranges' >&2; exit 33; fi; \
                 printf done > {}",
                quote(&count),
                quote(&count),
                quote(&dest)
            ));
            f.http.download("https://example.test/file", &dest, None, &CancellationToken::new(), &|_| {}).unwrap();
            assert_eq!(fs::read_to_string(&dest).unwrap(), "done");
            assert_eq!(fs::read_to_string(&count).unwrap().trim(), "2");
            assert!(
                !fs::read_to_string(f.path("curl-args")).unwrap().contains("-C\n-\n"),
                "the restart downloads from zero, without `-C -`"
            );
        }

        #[test]
        fn credential_lookup_is_bounded_and_cancellable_even_with_inherited_stdout() {
            let f = Fixture::new();
            // The parent exits but a child keeps stdout open: joining a reader
            // without checking the deadline would hang here.
            f.script("gh", "/bin/sleep 5 &\nexit 0");
            let started = Instant::now();
            assert!(
                read_gh_token(f.http.gh.as_ref().unwrap(), &CancellationToken::new(), Duration::from_millis(60))
                    .unwrap()
                    .is_none()
            );
            assert!(started.elapsed() < Duration::from_secs(3));
            f.script("gh", "/bin/sleep 5");
            let cancel = CancellationToken::new();
            let trigger = cancel.clone();
            let thread = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                trigger.cancel();
            });
            assert_eq!(f.http.get_text(API, &cancel).unwrap_err().kind, ErrorKind::Cancelled);
            thread.join().unwrap();
            assert!(!f.path("curl-args").exists());
        }

        #[test]
        #[ignore = "requires an active gh github.com login and network access"]
        fn live_github_release_uses_authenticated_quota() {
            let http = Http::new(&std::env::var_os("PATH").unwrap()).unwrap();
            assert!(http.gh.is_some());
            let cancel = CancellationToken::new();
            let body = http.get_text_limited("https://api.github.com/rate_limit", Some(64 * 1024), &cancel).unwrap();
            let response: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert!(response["resources"]["core"]["limit"].as_u64().unwrap() > 60);
            let body = http
                .get_text_limited(
                    "https://api.github.com/repos/redhat-developer/vscode-xml/releases/latest",
                    Some(1024 * 1024),
                    &cancel,
                )
                .unwrap();
            let response: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert!(response["tag_name"].is_string());
        }
    }
}
