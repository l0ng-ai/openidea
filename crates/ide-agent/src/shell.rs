//! `!` commands from the composer: run in the task's folder with the user's shell, outside
//! any turn, and handed to the agent with the next message as Claude Code's bash mode does.

use ide_core::CancellationToken;
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Output kept from each stream; longer output keeps its tail.
const MAX_STREAM: usize = 32 * 1024;

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Ran {
    /// The exit code; `None` when it didn't start, was stopped or ended by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// Why it didn't finish: it couldn't start, or it was stopped.
    pub error: Option<String>,
}

impl Ran {
    /// What the conversation shows: the output, then how it ended unless it succeeded.
    pub fn shown(&self) -> String {
        let mut text = [self.stdout.trim_end(), self.stderr.trim_end()]
            .into_iter()
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let end = match (&self.error, self.code) {
            (Some(error), _) => Some(error.clone()),
            (None, Some(0)) => None,
            (None, Some(code)) => Some(format!("Exit code {code}")),
            (None, None) => Some("Terminated".into()),
        };
        if let Some(end) = end {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&end);
        }
        text
    }

    /// The block that goes to the agent ahead of the next message.
    pub fn context(&self, command: &str) -> String {
        let mut stderr = self.stderr.trim_end().to_owned();
        if let Some(error) = &self.error {
            if !stderr.is_empty() {
                stderr.push('\n');
            }
            stderr.push_str(error);
        } else if let Some(code) = self.code.filter(|c| *c != 0) {
            if !stderr.is_empty() {
                stderr.push('\n');
            }
            stderr.push_str(&format!("Exit code {code}"));
        }
        format!(
            "<bash-input>{command}</bash-input>\n<bash-stdout>{}</bash-stdout><bash-stderr>{stderr}</bash-stderr>",
            self.stdout.trim_end()
        )
    }
}

/// Runs `command` with the user's shell in `cwd` until it ends or `cancel` stops it.
pub(crate) async fn run(command: &str, cwd: &Path, cancel: &CancellationToken) -> Ran {
    let mut cmd = shell(command);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return Ran { error: Some(format!("Cannot run it: {e}")), ..Ran::default() },
    };
    let (Some(mut out), Some(mut err)) = (child.stdout.take(), child.stderr.take()) else {
        return Ran { error: Some("Cannot read its output".into()), ..Ran::default() };
    };
    let finished = async move {
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let _ = tokio::join!(out.read_to_end(&mut stdout), err.read_to_end(&mut stderr));
        let code = child.wait().await.ok().and_then(|s| s.code());
        Ran { code, stdout: tail(&stdout), stderr: tail(&stderr), error: None }
    };
    tokio::select! {
        ran = finished => ran,
        // Dropping the child kills it.
        () = cancel.cancelled() => Ran { error: Some("Stopped".into()), ..Ran::default() },
    }
}

#[cfg(not(windows))]
fn shell(command: &str) -> Command {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let mut cmd = Command::new(shell);
    cmd.arg("-c").arg(command);
    cmd
}

#[cfg(windows)]
fn shell(command: &str) -> Command {
    let mut cmd = Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()));
    // `/S /C "…"` runs the line as typed: cmd strips only the outer quotes.
    cmd.raw_arg("/D /S /C \"").raw_arg(command).raw_arg("\"");
    cmd
}

fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= MAX_STREAM {
        return text.into_owned();
    }
    let mut cut = text.len() - MAX_STREAM;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…{}", &text[cut..])
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_in_the_folder_and_reports_output_and_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "").unwrap();
        let ran = run("ls; echo oops >&2; exit 3", dir.path(), &CancellationToken::new()).await;
        assert_eq!(ran.code, Some(3));
        assert_eq!(ran.stdout.trim(), "marker.txt");
        assert_eq!(ran.stderr.trim(), "oops");
        assert_eq!(ran.shown(), "marker.txt\noops\nExit code 3");
        assert_eq!(
            ran.context("ls"),
            "<bash-input>ls</bash-input>\n<bash-stdout>marker.txt</bash-stdout><bash-stderr>oops\nExit code 3</bash-stderr>"
        );
    }

    #[tokio::test]
    async fn a_stopped_command_is_killed() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            stop.cancel();
        });
        let started = std::time::Instant::now();
        let ran = run("sleep 30", dir.path(), &cancel).await;
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(ran.shown(), "Stopped");
    }

    #[test]
    fn long_output_keeps_its_tail() {
        let long = "x".repeat(MAX_STREAM + 10) + "end";
        let kept = tail(long.as_bytes());
        assert!(kept.starts_with('…') && kept.ends_with("end"));
    }
}
