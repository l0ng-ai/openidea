//! Agents driven over their own protocol rather than ACP: `codex app-server` and Claude
//! Code's stream-json mode. Each runs behind an in-process ACP endpoint (a shim), so a
//! task drives every agent the same way and reads what it can do from `initialize`.
//!
//! A shim speaks ACP v1 as the agent side, plus:
//! - `agentCapabilities.sessionCapabilities.fork` and `session/fork`
//!   (`{ sessionId, cwd, mcpServers }` → a `session/new` result for the copy);
//! - `agentCapabilities._meta.openidea.rollback` and `_openidea/rollback`
//!   (`{ sessionId, turns }`: drops the last `turns` user turns from the session);
//! - `agentCapabilities._meta.openidea.steer` and `_openidea/steer`
//!   (`{ sessionId, prompt }`: adds ACP content blocks to the running turn; fails when
//!   no turn runs).

pub(crate) mod claude;
pub(crate) mod codex;

use ide_jsonrpc::{Framing, Handler, Peer};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The newest install of `command` on the `PATH` a child sees, by its `--version`.
/// Several installs are common (npm, Homebrew, the vendor's own installer), and the first
/// on `PATH` is often an old one that the service no longer serves the current models to.
/// A path, or a name not found on `PATH`, is used as it is; a single match returns its
/// resolved path so Windows `PATHEXT` shims (`claude.cmd`, `codex.cmd`) start.
pub(crate) fn newest_install(command: &str) -> String {
    let path = ide_core::process::host_var_os("PATH")
        .or_else(|| ide_core::process::shell_env().find(|(k, _)| *k == "PATH").map(|(_, v)| v.to_owned()))
        .unwrap_or_default();
    newest_install_in(command, &path)
}

fn newest_install_in(command: &str, search: &std::ffi::OsStr) -> String {
    if Path::new(command).components().count() > 1 || Path::new(command).is_absolute() {
        return command.to_owned();
    }
    let pathext = ide_core::process::host_var_os("PATHEXT");
    let names =
        ide_core::process::executable_names(command, cfg!(windows), pathext.as_deref().and_then(|p| p.to_str()));
    let mut seen = Vec::new();
    let candidates: Vec<PathBuf> = std::env::split_paths(search)
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .filter(|p| p.is_file())
        .filter(|p| {
            let real = dunce::canonicalize(p).unwrap_or_else(|_| p.clone());
            let new = !seen.contains(&real);
            seen.push(real);
            new
        })
        .collect();
    if candidates.len() < 2 {
        return candidates.into_iter().next().map_or_else(|| command.to_owned(), |p| p.to_string_lossy().into_owned());
    }
    candidates
        .into_iter()
        .filter_map(|p| version_of(&p).map(|v| (v, p)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map_or_else(|| command.to_owned(), |(_, p)| p.to_string_lossy().into_owned())
}

/// `x.y.z` from `<program> --version` ("codex-cli 0.164.0", "2.1.312 (Claude Code)").
fn version_of(program: &Path) -> Option<Vec<u64>> {
    let mut cmd = std::process::Command::new(program);
    ide_core::process::prepare(&mut cmd);
    let out = cmd.arg("--version").envs(ide_core::process::shell_env()).output().ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

fn parse_version(text: &str) -> Option<Vec<u64>> {
    text.split_whitespace().find_map(|word| {
        let parts: Vec<u64> = word.trim_start_matches('v').split('.').map_while(|p| p.parse().ok()).collect();
        (parts.len() >= 2).then_some(parts)
    })
}

/// The agent side of an in-process ACP connection.
pub(crate) trait Shim: Handler {
    /// Called once, before any message arrives: the connection to the client, for
    /// `session/update` notifications and `session/request_permission` requests.
    fn attach(&self, client: Peer);
}

/// Connects `client` to `shim`; returns the client's side. When the client goes away the
/// shim's connection closes (`Peer::closed`); a shim closes the client's by killing its
/// own side (`Peer::kill`) when its process exits.
pub(crate) fn serve<S: Shim>(shim: Arc<S>, client: Arc<dyn Handler>) -> Peer {
    let (ours, theirs) = tokio::io::duplex(1 << 20);
    let (or, ow) = tokio::io::split(ours);
    let (tr, tw) = tokio::io::split(theirs);
    let to_client = Peer::connect_framed(tr, tw, shim.clone(), Framing::Lines);
    shim.attach(to_client);
    Peer::connect_framed(or, ow, client, Framing::Lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_from_either_side_of_the_name() {
        assert_eq!(parse_version("codex-cli 0.164.0\n"), Some(vec![0, 164, 0]));
        assert_eq!(parse_version("2.1.312 (Claude Code)"), Some(vec![2, 1, 312]));
        assert_eq!(parse_version("v1.2"), Some(vec![1, 2]));
        assert_eq!(parse_version("no version here"), None);
        assert!(parse_version("codex-cli 0.164.0") > parse_version("codex-cli 0.147.0"));
    }

    #[test]
    fn newest_install_resolves_single_candidate_and_keeps_missing_or_paths() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("claude"), "#!/bin/sh\n").unwrap();
        std::fs::write(b.join("claude.cmd"), "@echo off\n").unwrap();
        let search = std::env::join_paths([&a, &b]).unwrap();
        if cfg!(windows) {
            assert_eq!(newest_install_in("claude", &search), b.join("claude.cmd").to_string_lossy());
        } else {
            assert_eq!(newest_install_in("claude", &search), a.join("claude").to_string_lossy());
        }
        assert_eq!(newest_install_in("nope", &search), "nope");
        assert_eq!(newest_install_in("bin/claude", &search), "bin/claude");
    }
}
