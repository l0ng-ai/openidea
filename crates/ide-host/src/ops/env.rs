//! Reload Environment: new child processes get the login shell's current environment
//! (and, on the remote server, the project's `remoteEnv`) without a restart.
use crate::Host;
use crate::environment::EnvReloaded;
use ide_command::command;
use ide_core::IdeResult;
use std::sync::Arc;

/// Reload Environment: new child processes get the login shell's current environment
/// (and the project's `remoteEnv` on a remote host); running ones keep theirs.
#[command(trust = always)]
pub async fn env_reload(host: &Arc<Host>, window: &str) -> IdeResult<EnvReloaded> {
    // Re-reads the login shell (and the window's project `remoteEnv` where it applies);
    // running terminals and processes keep their environment.
    let root = host.project(window).ok().filter(|p| !p.light && p.is_trusted()).map(|p| p.root.clone());
    let sink = host.window_sink(window);
    let h = host.clone();
    host.blocking(move || h.environment.reload(root.as_deref(), &sink)).await
}

ide_command::domain!(env: env_reload);
