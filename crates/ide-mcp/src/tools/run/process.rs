//! Child processes of the terminal tool: word splitting, quoting and a capture with a
//! timeout that kills the whole process tree.

use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// A command's output kept in memory; more is dropped.
const MAX_CAPTURE_BYTES: usize = 16 << 20;
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
    pub text: String,
    /// The exit code (`128 + signal` when a signal ended it, as the JVM reports it); `None` on timeout.
    pub code: Option<i32>,
    pub timed_out: bool,
}

async fn read_into(mut pipe: impl tokio::io::AsyncRead + Unpin, buf: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0u8; 8192];
    while let Ok(n) = pipe.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        let mut b = buf.lock();
        let take = n.min(MAX_CAPTURE_BYTES.saturating_sub(b.len()));
        b.extend_from_slice(&chunk[..take]);
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
            cmd.as_std_mut().raw_arg(a);
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
    let buf = Arc::new(Mutex::new(Vec::new()));
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
    if cancelled {
        return Err(IdeError::cancelled());
    }
    let bytes = std::mem::take(&mut *buf.lock());
    let code = if timed_out { None } else { status.and_then(exit_code) };
    Ok(CommandOutput { text: String::from_utf8_lossy(&bytes).into_owned(), code, timed_out })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_words_like_a_shell() {
        assert_eq!(split_words(r#"a  'b c' "d \"e\"" f\ g"#).unwrap(), ["a", "b c", "d \"e\"", "f g"]);
        assert_eq!(split_words("x ''").unwrap(), ["x", ""]);
        assert!(split_words("'open").is_err());
    }
}
