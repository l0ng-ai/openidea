//! Starting `claude` in stream-json mode, one process per session.

use ide_core::CancellationToken;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};

/// The flags every session runs with: the Agent SDK's, as its process transport passes them.
pub(super) const BASE_ARGS: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
    "--include-partial-messages",
    "--thinking-display",
    "summarized",
    "--allow-dangerously-skip-permissions",
];

/// How a session's process starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Start {
    New {
        id: String,
    },
    Resume {
        id: String,
        at: Option<String>,
    },
    /// A copy of `from` (up to `at`) under the id `id`.
    Fork {
        from: String,
        id: String,
        at: Option<String>,
    },
}

impl Start {
    pub fn args(&self) -> Vec<String> {
        let mut out: Vec<String> = BASE_ARGS.iter().map(|a| (*a).to_owned()).collect();
        let mut push = |a: &str, v: &str| {
            out.push(a.to_owned());
            out.push(v.to_owned());
        };
        match self {
            Start::New { id } => push("--session-id", id),
            Start::Resume { id, at } => {
                push("--resume", id);
                if let Some(at) = at {
                    push("--resume-session-at", at);
                }
            }
            Start::Fork { from, id, at } => {
                push("--resume", from);
                if let Some(at) = at {
                    push("--resume-session-at", at);
                }
                out.push("--fork-session".into());
                out.push("--session-id".into());
                out.push(id.clone());
            }
        }
        out
    }
}

pub(super) struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

/// A running CLI: its stdio, and a token that kills it when cancelled. Its stdout ending
/// means it is gone.
pub(super) struct CliIo {
    pub stdin: Pin<Box<dyn AsyncWrite + Send>>,
    pub stdout: Pin<Box<dyn AsyncRead + Send>>,
    pub kill: CancellationToken,
}

pub(super) type OnStderr = Arc<dyn Fn(String) + Send + Sync>;

pub(super) trait Cli: Send + Sync + 'static {
    fn launch(&self, launch: &Launch, on_stderr: OnStderr) -> std::io::Result<CliIo>;
}

/// The real `claude`.
pub(super) struct Process;

impl Cli for Process {
    fn launch(&self, l: &Launch, on_stderr: OnStderr) -> std::io::Result<CliIo> {
        use std::process::Stdio;
        let mut cmd = tokio::process::Command::new(&l.program);
        ide_core::process::prepare(cmd.as_std_mut());
        // `claude` may be a wrapper (`claude.cmd` → node): stopping it stops what it started.
        ide_core::process::own_group(cmd.as_std_mut());
        cmd.args(&l.args)
            .current_dir(&l.cwd)
            .envs(ide_core::process::shell_env())
            .envs(l.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            // Started from inside Claude Code (a terminal in it), the CLI would think it is nested.
            .env_remove("CLAUDECODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no stdout"))?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(ide_jsonrpc::output::read_lines(stderr, move |line| on_stderr(line)));
        }
        let kill = CancellationToken::new();
        let token = kill.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {}
                _ = token.cancelled() => {
                    if let Some(pid) = child.id() {
                        let _ = tokio::task::spawn_blocking(move || ide_core::process::kill_tree_of(pid)).await;
                    }
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
            }
        });
        Ok(CliIo { stdin: Box::pin(stdin), stdout: Box::pin(stdout), kill })
    }
}

/// Claude Code's configuration directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`).
pub(super) fn config_dir(env: &[(String, String)]) -> Option<PathBuf> {
    let set = env
        .iter()
        .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        .map(|(_, v)| PathBuf::from(v))
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from));
    set.or_else(|| {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|h| Path::new(&h).join(".claude"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_flags() {
        let tail = |s: Start| s.args()[BASE_ARGS.len()..].join(" ");
        assert_eq!(tail(Start::New { id: "a".into() }), "--session-id a");
        assert_eq!(tail(Start::Resume { id: "a".into(), at: Some("u".into()) }), "--resume a --resume-session-at u");
        assert_eq!(
            tail(Start::Fork { from: "a".into(), id: "b".into(), at: None }),
            "--resume a --fork-session --session-id b"
        );
    }
}
