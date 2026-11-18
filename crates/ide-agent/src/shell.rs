//! Composer `! <command>`: run in the task cwd without starting an agent turn (#4339).
//!
//! Claude Code's interactive CLI handles this as bash mode; OpenIDEA drives `claude -p`
//! (and other providers) over ACP, so the IDE owns the intercept for every agent.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Tool output kept for the conversation and the next prompt; longer output keeps its tail.
pub(crate) const MAX_OUTPUT: usize = 64 * 1024;

/// A finished `!` command waiting to ride along with the next real prompt.
#[derive(Clone, Debug)]
pub(crate) struct PendingShell {
    pub command: String,
    pub output: String,
    pub exit: Option<i32>,
}

/// The shell command in a bang message, or `None` when the text is an ordinary prompt.
///
/// Leading `!` with a non-empty rest after trim → shell. Bare `!` / `!   ` stay prompts.
/// `Fix this!` does not match (no leading `!`).
pub(crate) fn bang_command(text: &str) -> Option<&str> {
    let rest = text.strip_prefix('!')?;
    let cmd = rest.trim();
    (!cmd.is_empty()).then_some(cmd)
}

/// ACP / Claude-style context block so the next turn can see the command and its output.
pub(crate) fn context_block(pending: &PendingShell) -> String {
    let status = match pending.exit {
        Some(0) => "exit 0".to_owned(),
        Some(code) => format!("exit {code}"),
        None => "cancelled".to_owned(),
    };
    format!(
        "<context ref=\"shell:!{}\">\n$ {}\n{}\n({status})\n</context>",
        pending.command, pending.command, pending.output
    )
}

pub(crate) fn trim_output(mut text: String) -> String {
    if text.len() <= MAX_OUTPUT {
        return text;
    }
    text = text.split_off(text.len() - MAX_OUTPUT);
    format!("…\n{text}")
}

/// Program + args to run `command` through the user's shell (or `cmd` on Windows).
pub(crate) fn shell_invocation(command: &str) -> (PathBuf, Vec<String>) {
    if cfg!(windows) {
        let comspec = std::env::var("COMSPEC").ok().filter(|c| !c.is_empty()).unwrap_or_else(|| "cmd.exe".into());
        (comspec.into(), vec!["/D".into(), "/S".into(), "/C".into(), format!("\"{command}\"")])
    } else {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        (shell.into(), vec!["-c".into(), command.to_owned()])
    }
}

/// Runs `command` in `cwd`; returns combined stdout+stderr and the exit code (`None` if killed).
pub(crate) async fn run_command(command: &str, cwd: &Path, cancelled: impl Fn() -> bool) -> (String, Option<i32>) {
    let (program, args) = shell_invocation(command);
    let mut child = match Command::new(&program)
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (format!("failed to start shell: {e}"), Some(1)),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut r) = stdout {
            let _ = r.read_to_end(&mut buf).await;
        }
        buf
    });
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut r) = stderr {
            let _ = r.read_to_end(&mut buf).await;
        }
        buf
    });

    let status = loop {
        tokio::select! {
            status = child.wait() => break status.ok().and_then(|s| s.code()),
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                if cancelled() {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    break None;
                }
            }
        }
    };

    let out = out_task.await.unwrap_or_default();
    let err = err_task.await.unwrap_or_default();
    let mut text = String::new();
    text.push_str(&String::from_utf8_lossy(&out));
    if !err.is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&err));
    }
    (trim_output(text), status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bang_detects_leading_exclamation_only() {
        assert_eq!(bang_command("! git status"), Some("git status"));
        assert_eq!(bang_command("!git status"), Some("git status"));
        assert_eq!(bang_command("!  echo hi"), Some("echo hi"));
        assert_eq!(bang_command("!"), None);
        assert_eq!(bang_command("!   "), None);
        assert_eq!(bang_command("Fix this!"), None);
        assert_eq!(bang_command("say ! hi"), None);
        assert_eq!(bang_command(""), None);
    }

    #[test]
    fn context_block_includes_command_and_status() {
        let block =
            context_block(&PendingShell { command: "git status".into(), output: "clean".into(), exit: Some(0) });
        assert!(block.contains("<context ref=\"shell:!git status\">"));
        assert!(block.contains("$ git status"));
        assert!(block.contains("clean"));
        assert!(block.contains("(exit 0)"));
    }

    #[tokio::test]
    async fn run_command_captures_stdout_in_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "ok").unwrap();
        let (out, code) = if cfg!(windows) {
            run_command("type marker.txt", dir.path(), || false).await
        } else {
            run_command("cat marker.txt", dir.path(), || false).await
        };
        assert_eq!(code, Some(0));
        assert!(out.contains("ok"), "{out}");
    }
}
