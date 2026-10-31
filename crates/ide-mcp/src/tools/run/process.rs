//! Child processes of the terminal tool: word splitting, quoting and a capture with a
//! timeout that kills the whole process tree.

use super::output::{TRUNCATED_MARKER, temp_output_file};
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// A command's output kept whole in memory; past it, all of it goes to a file and only its
/// first [`HEAD_BYTES`] and last [`TAIL_BYTES`] stay in memory.
const MAX_CAPTURE_BYTES: usize = 16 << 20;
const HEAD_BYTES: usize = 4 << 20;
const TAIL_BYTES: usize = 4 << 20;
/// After a command exits, how long to wait for pipes still held by its background children.
const PIPE_DRAIN: Duration = Duration::from_millis(500);

/// POSIX-like word splitting: whitespace separates, quotes group, `\` escapes (not inside `'…'`).
pub fn split_words(line: &str) -> IdeResult<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => word.push(c),
                        None => return Err(IdeError::invalid("unterminated ' quote")),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(c @ ('"' | '\\' | '$' | '`')) => word.push(c),
                            Some(c) => {
                                word.push('\\');
                                word.push(c);
                            }
                            None => return Err(IdeError::invalid("unterminated \" quote")),
                        },
                        Some(c) => word.push(c),
                        None => return Err(IdeError::invalid("unterminated \" quote")),
                    }
                }
            }
            '\\' if !cfg!(windows) => {
                in_word = true;
                if let Some(c) = chars.next() {
                    word.push(c);
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    if in_word {
        words.push(word);
    }
    Ok(words)
}

pub fn quote(arg: &str) -> String {
    let plain = !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c));
    if plain { arg.to_owned() } else { format!("'{}'", arg.replace('\'', "'\\''")) }
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    let pid = pid as libc::pid_t;
    if pid <= 0 {
        return;
    }
    // SAFETY: plain signal delivery; the process was started as its own group leader.
    unsafe {
        if libc::kill(-pid, libc::SIGKILL) != 0 {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null());
    ide_core::process::prepare(&mut cmd);
    let _ = cmd.status();
}

pub struct CommandOutput {
    /// The whole output; when it was too long, its start and end around [`TRUNCATED_MARKER`].
    pub text: String,
    /// The exit code (`128 + signal` when a signal ended it, as the JVM reports it); `None` on timeout.
    pub code: Option<i32>,
    pub timed_out: bool,
    /// The file holding all of the output, when it was too long for memory.
    pub full_output: Option<PathBuf>,
}

/// Output bytes of a command: whole up to `max`, then streamed to a temporary file with the
/// first `head` and the last `tail` bytes kept, so every truncation mode stays exact.
pub(crate) struct Capture {
    max: usize,
    head_max: usize,
    tail_max: usize,
    head: Vec<u8>,
    tail: VecDeque<u8>,
    spill: Option<(PathBuf, Option<std::fs::File>)>,
}

impl Capture {
    pub(crate) fn new(max: usize, head_max: usize, tail_max: usize) -> Self {
        Self { max, head_max, tail_max, head: Vec::new(), tail: VecDeque::new(), spill: None }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) {
        let mut rest = chunk;
        if self.spill.is_none() {
            if self.head.len() + chunk.len() <= self.max {
                self.head.extend_from_slice(chunk);
                return;
            }
            // A file that cannot be created keeps the head and tail only.
            let file = temp_output_file("terminal").ok().map(|(path, mut file)| {
                let ok = file.write_all(&self.head).is_ok();
                (path, ok.then_some(file))
            });
            self.spill = Some(file.unwrap_or_default());
            let beyond = self.head.split_off(self.head_max.min(self.head.len()));
            self.tail.extend(beyond);
            // A head still short of its size takes the start of this chunk.
            let room = self.head_max.saturating_sub(self.head.len()).min(chunk.len());
            self.head.extend_from_slice(&chunk[..room]);
            rest = &chunk[room..];
        }
        if let Some((_, slot)) = &mut self.spill
            && let Some(file) = slot
            && file.write_all(chunk).is_err()
        {
            *slot = None;
        }
        self.tail.extend(rest);
        let excess = self.tail.len().saturating_sub(self.tail_max);
        self.tail.drain(..excess);
    }

    /// The text and, when it did not fit, the file with all of it.
    pub(crate) fn finish(self) -> (String, Option<PathBuf>) {
        let head = String::from_utf8_lossy(&self.head).into_owned();
        let Some((path, _)) = self.spill else { return (head, None) };
        let tail: Vec<u8> = self.tail.into_iter().collect();
        // The tail may start inside a character.
        let start = tail.iter().take(3).take_while(|b| *b & 0xC0 == 0x80).count();
        let tail = String::from_utf8_lossy(&tail[start..]);
        let text = format!("{head}\n{TRUNCATED_MARKER}\n{tail}");
        (text, (!path.as_os_str().is_empty()).then_some(path))
    }
}

async fn read_into(mut pipe: impl tokio::io::AsyncRead + Unpin, buf: Arc<Mutex<Capture>>) {
    let mut chunk = [0u8; 8192];
    while let Ok(n) = pipe.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        buf.lock().push(&chunk[..n]);
    }
}

fn exit_code(status: std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    if let Some(signal) = std::os::unix::process::ExitStatusExt::signal(&status) {
        return Some(128 + signal);
    }
    status.code()
}

/// Runs `program` in `cwd` with the IDE's child-process environment plus `env`, stdout and
/// stderr combined; kills the process tree on timeout or cancellation.
pub async fn run_process(
    program: &str,
    args: &[String],
    raw_args: bool,
    cwd: &Path,
    env: &[(String, String)],
    limit: Duration,
    cancel: &ide_core::CancellationToken,
) -> IdeResult<CommandOutput> {
    let mut cmd = tokio::process::Command::new(program);
    if raw_args {
        #[cfg(windows)]
        for a in args {
            cmd.raw_arg(a);
        }
        #[cfg(not(windows))]
        cmd.args(args);
    } else {
        cmd.args(args);
    }
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // What terminals and runs get: the login shell's variables this process lacks, the reloaded environment.
    cmd.envs(ide_core::process::shell_env());
    cmd.envs(env.iter().map(|(k, v)| (k, v)));
    ide_core::process::prepare(cmd.as_std_mut());
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | ide_core::process::CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| {
        IdeError::invalid(format!("Can't execute command line '{program} {}': {e}", args.join(" ")).trim().to_owned())
    })?;
    let pid = child.id();
    let buf = Arc::new(Mutex::new(Capture::new(MAX_CAPTURE_BYTES, HEAD_BYTES, TAIL_BYTES)));
    let mut out = tokio::spawn(read_into(child.stdout.take().expect("piped stdout"), buf.clone()));
    let mut err = tokio::spawn(read_into(child.stderr.take().expect("piped stderr"), buf.clone()));
    let mut timed_out = false;
    let mut cancelled = false;
    let status = tokio::select! {
        s = child.wait() => Some(s?),
        _ = tokio::time::sleep(limit) => { timed_out = true; None }
        _ = cancel.cancelled() => { cancelled = true; None }
    };
    let status = match status {
        Some(s) => Some(s),
        None => {
            if let Some(pid) = pid {
                kill_tree(pid);
            }
            let _ = child.kill().await;
            child.wait().await.ok()
        }
    };
    let _ = tokio::time::timeout(PIPE_DRAIN, futures::future::join(&mut out, &mut err)).await;
    out.abort();
    err.abort();
    let capture = std::mem::replace(&mut *buf.lock(), Capture::new(0, 0, 0));
    let (text, full_output) = capture.finish();
    if cancelled {
        if let Some(path) = full_output {
            let _ = std::fs::remove_file(path);
        }
        return Err(IdeError::cancelled());
    }
    let code = if timed_out { None } else { status.and_then(exit_code) };
    Ok(CommandOutput { text, code, timed_out, full_output })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_words_like_a_shell() {
        // Outside quotes a backslash escapes on Unix; on Windows it is a path separator.
        let escaped: &[&str] = if cfg!(windows) { &["f\\", "g"] } else { &["f g"] };
        let words = split_words(r#"a  'b c' "d \"e\"" f\ g"#).unwrap();
        assert_eq!(words[..3], ["a", "b c", "d \"e\""]);
        assert_eq!(words[3..], *escaped);
        assert_eq!(split_words("x ''").unwrap(), ["x", ""]);
        assert!(split_words("'open").is_err());
    }

    #[test]
    fn long_output_spills_to_a_file_keeping_head_and_tail() {
        let mut c = Capture::new(10, 4, 4);
        c.push(b"0123456");
        c.push(b"789abcdef");
        c.push(b"ghij");
        let (text, path) = c.finish();
        assert_eq!(text, format!("0123\n{TRUNCATED_MARKER}\nghij"));
        let path = path.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "0123456789abcdefghij");
        let _ = std::fs::remove_file(path);

        let mut c = Capture::new(10, 4, 4);
        c.push(b"short");
        assert_eq!(c.finish(), ("short".to_owned(), None));
        // A tail cut inside a character drops its continuation bytes.
        let mut c = Capture::new(4, 2, 5);
        c.push("ab_é_xé".as_bytes());
        let (text, path) = c.finish();
        assert_eq!(text, format!("ab\n{TRUNCATED_MARKER}\n_xé"));
        let _ = std::fs::remove_file(path.unwrap());
    }
}
