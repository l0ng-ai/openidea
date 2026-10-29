//! Command implementations shared by the desktop shell's IPC commands and the
//! remote server ([`crate::rpc`]): each takes the [`Host`], the calling window
//! and the command's arguments, and streams through [`Emit`] callbacks.

pub mod agent;
pub mod analysis;
pub mod build;
pub mod bytes;
pub mod coverage;
pub mod debug;
pub mod doc;
pub mod env;
pub mod fs;
pub mod history;
pub mod java;
pub mod lsp;
pub mod nav;
pub mod notebook;
pub mod project;
mod python;
pub mod refactor;
pub mod run;
pub mod sdk;
pub mod search;
pub mod spell;
pub mod syntax;
pub mod term;
pub mod tools;
pub mod vcs;

use crate::Host;
use ide_core::{IdeError, IdeResult};
use std::sync::Arc;

/// A stream of values to the caller (a Tauri channel, or channel notifications).
pub type Emit<T> = Arc<dyn Fn(T) + Send + Sync>;

/// A streaming argument: what the desktop shell passes as a Tauri channel and
/// the server as `channel` notifications.
pub struct Channel<T>(Emit<T>);

impl<T> Channel<T> {
    pub fn new(send: impl Fn(T) + Send + Sync + 'static) -> Self {
        Self(Arc::new(send))
    }

    /// Sends one value; never fails (a closed receiver drops it).
    pub fn send(&self, value: T) -> IdeResult<()> {
        (self.0)(value);
        Ok(())
    }
}

impl<T> Clone for Channel<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

/// Registers the commands of every module with the remote server.
pub fn register_all(d: &mut crate::rpc::Dispatcher) {
    agent::register(d);
    lsp::register(d);
    notebook::register(d);
    nav::register(d);
    refactor::register(d);
    analysis::register(d);
    syntax::register(d);
    spell::register(d);
    history::register(d);
    coverage::register(d);
    build::register(d);
    tools::register(d);
    sdk::register(d);
    java::register(d);
    debug::register(d);
    bytes::register(d);
    vcs::register(d);
    doc::register(d);
    search::register(d);
    run::register(d);
    env::register(d);
}

impl Host {
    /// Runs blocking work (disk I/O, parsing, large copies) on the blocking pool.
    pub async fn blocking<T: Send + 'static>(&self, f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
        self.runtime.spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
    }
}
