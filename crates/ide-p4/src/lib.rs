//! Perforce (Helix Core / P4) integration, built on the installed `p4` CLI.
//!
//! Reads (`p4 info`, `p4 fstat`, `p4 opened`, `p4 describe`) and writes
//! (`p4 edit`, `add`, `delete`, `revert`, `sync`, `submit`, `shelve`) all shell
//! out so credentials, tickets and `P4CONFIG` behave exactly as on the command
//! line. The [`Client`] is configured like the `p4` binary itself: `P4PORT`,
//! `P4USER`, `P4CLIENT` come from the environment or a `p4 set` override.

mod cli;
mod client;
mod opened;
mod status;

pub use client::{ChangeAction, Client, Connection, OpenedFile, P4Changelist};
pub use status::{P4FileStatus, Workspace};

use ide_core::IdeResult;
use std::path::Path;

/// The detected `p4` executable, or `None` when it is not on `PATH`.
pub fn detected_p4_executable() -> Option<std::path::PathBuf> {
    which::which("p4").ok().or_else(|| {
        [
            r"C:\Program Files\Perforce\p4.exe",
            r"C:\Program Files (x86)\Perforce\p4.exe",
            "/usr/local/bin/p4",
            "/usr/bin/p4",
            "/opt/perforce/bin/p4",
        ]
        .iter()
        .map(std::path::Path::new)
        .find(|p| p.exists())
        .map(|p| p.to_path_buf())
    })
}

/// `p4 -V` of `exe` (`None` = auto-detect), for Settings › Version Control › Perforce.
pub fn p4_version(exe: Option<&Path>) -> IdeResult<String> {
    let exe = cli::p4(exe)?;
    let out = cli::run(&exe, &["-V"], None)?;
    Ok(out
        .lines()
        .find(|l| l.contains("Rev.") || l.contains("Version"))
        .map(str::trim)
        .map(str::to_string)
        .unwrap_or_else(|| out.trim().to_string()))
}

/// The workspace `path` belongs to (`p4 info` walks up for a `P4CONFIG`), or
/// `Ok(None)` when `path` is not inside a Perforce client.
pub fn discover_workspace(path: &Path) -> IdeResult<Option<Workspace>> {
    Workspace::discover(path)
}
