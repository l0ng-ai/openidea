//! Perforce (Helix Core) integration on the installed `p4` CLI, so `P4CONFIG`,
//! tickets and `p4 set` values apply as they do in a terminal.
//!
//! [`Workspace`] is a client workspace found on disk. It implements
//! [`ide_vcs::Backend`] (the Changes view, diff viewer, annotate and log) and
//! adds what only Perforce has: pending changelists, sync, shelves, resolve,
//! reconcile, integrate and jobs.

mod backend;
mod changelists;
mod cli;
mod ops;
mod workspace;

pub use changelists::{Job, PendingChangelist, ShelvedFile};
pub use cli::{detect as detected_executable, is_login_required, set_executable};
pub use ops::{AffectedFile, IntegrateKind, LoginStatus, OperationResult, ResolveMode, ResolveSides, UnresolvedFile};
pub use workspace::{Connection, OpenedFile, Workspace};

use ide_core::IdeResult;

/// `p4 -V` of the configured executable: `P4/LINUX26X86_64/2025.1/2810567 (2025/08/05)`.
pub fn version() -> IdeResult<String> {
    let run = cli::Invocation { exe: cli::executable()?, cwd: std::env::temp_dir(), globals: Vec::new() };
    let out = String::from_utf8_lossy(&run.raw(&cli::args(["-V"]), None)?).into_owned();
    Ok(out.lines().find_map(|l| l.strip_prefix("Rev. ")).map(|v| v.trim_end_matches('.').to_owned()).unwrap_or(out))
}
