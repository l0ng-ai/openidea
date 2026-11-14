//! Thin wrapper around the `p4` executable used for every operation.
//!
//! Like the Git backend, every Perforce call goes through the installed CLI so
//! `P4CONFIG`, ticket authentication and connection settings behave exactly as
//! on the command line. `-ztag` keeps output machine-readable for the parsers
//! in [`crate::opened`] and [`crate::status`].

use ide_core::{IdeError, IdeResult};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::RwLock;

static P4_EXECUTABLE: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Explicit `p4` executable from Settings › Version Control › Perforce
/// (`None` = auto-detect). Set once when settings load.
#[allow(dead_code)]
pub fn set_p4_executable(path: Option<&Path>) {
    *P4_EXECUTABLE.write().unwrap_or_else(|p| p.into_inner()) = path.map(|p| p.to_path_buf());
}

/// The configured or detected `p4` executable.
pub fn p4(exe: Option<&Path>) -> IdeResult<PathBuf> {
    if let Some(p) = exe {
        return Ok(p.to_path_buf());
    }
    if let Some(p) = P4_EXECUTABLE.read().unwrap_or_else(|p| p.into_inner()).clone() {
        return Ok(p);
    }
    crate::detected_p4_executable().ok_or_else(|| IdeError::missing_tool("p4"))
}

/// Runs `p4 args` in `cwd`, returning stdout. Stderr is folded into the error
/// message; `p4` prints diagnostics there for a nonzero exit. Connection and
/// authentication failures surface as `Unavailable` so the UI can offer to
/// configure the server.
pub fn run(exe: &Path, args: &[&str], cwd: Option<&Path>) -> IdeResult<String> {
    let mut cmd = Command::new(exe);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { IdeError::missing_tool("p4") } else { IdeError::from(e) }
    })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        let msg = stderr.trim().to_string();
        let msg = if msg.is_empty() { stdout.trim().to_string() } else { msg };
        return Err(classify(&msg));
    }
    // `p4` can still report a recoverable error on stdout with a zero exit
    // (e.g. "… - file(s) not on client").
    if stderr.trim().is_empty() {
        return Ok(stdout.into_owned());
    }
    let warn = stderr.trim();
    if warn.starts_with("warning:") {
        tracing::warn!(target: "p4", "{warn}");
        return Ok(stdout.into_owned());
    }
    Err(classify(warn))
}

fn classify(msg: &str) -> IdeError {
    let m = msg.to_lowercase();
    if m.contains("connect to server failed")
        || m.contains("can't connect")
        || m.contains("operation timed out")
        || m.contains("host unknown")
    {
        return IdeError::unavailable(msg);
    }
    if m.contains("please login")
        || m.contains("ticket") && m.contains("expired")
        || m.contains("password") && m.contains("required")
    {
        return IdeError::unavailable(format!("Perforce login required: {msg}"));
    }
    if m.contains("not on client") || m.contains("no such file") || m.contains("not in client view") {
        return IdeError::not_found(msg);
    }
    if m.contains("can't edit") && m.contains("opened") || m.contains("also opened by") {
        return IdeError::new(ide_core::error::ErrorKind::AlreadyExists, msg);
    }
    IdeError::internal(msg)
}
