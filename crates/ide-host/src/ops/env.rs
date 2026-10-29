//! Reload Environment: new child processes get the login shell's current environment
//! (and, on the remote server, the project's `remoteEnv`) without a restart.
use crate::Host;
use crate::environment::EnvReloaded;
use crate::rpc::Dispatcher;
use ide_core::IdeResult;
use std::sync::Arc;

/// Re-reads the login shell (and the window's project `remoteEnv` where it applies);
/// running terminals and processes keep their environment.
pub async fn reload(host: &Arc<Host>, window: &str) -> IdeResult<EnvReloaded> {
    let root = host.project(window).ok().filter(|p| !p.light).map(|p| p.root.clone());
    let sink = host.window_sink(window);
    let h = host.clone();
    host.blocking(move || h.environment.reload(root.as_deref(), &sink)).await
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("env_reload", |c| async move { reload(&c.host, &c.window).await });
}
