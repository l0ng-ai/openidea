//! Command implementations shared by the desktop shell's IPC commands and the
//! remote server ([`crate::rpc`]): each takes the [`Host`], the calling window
//! and the command's arguments, and streams through [`Emit`] callbacks.

pub mod agent;
pub mod analysis;
pub mod bdd;
pub mod build;
pub mod bytes;
pub mod coverage;
pub mod db;
pub mod debug;
pub mod dependencies;
pub mod deploy;
pub mod doc;
pub mod docker;
pub mod env;
pub mod flutter;
pub mod fs;
pub mod heap;
pub mod history;
pub mod java;
pub mod jvm_icons;
pub mod lsp;
pub mod maven_placeholder;
pub mod nav;
pub mod notebook;
pub mod project;
mod python;
pub mod refactor;
pub mod routes;
pub mod run;
pub mod scaffold;
pub mod sdk;
pub mod search;
pub mod spell;
pub mod ssh;
pub mod stream_trace;
pub mod syntax;
pub mod term;
pub mod tools;
pub mod vcs;
pub mod web;

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

// Every module that declares `#[command]`s, by domain name.
ide_command::domains!(
    agent: crate::ops::agent,
    analysis: crate::ops::analysis,
    build: crate::ops::build,
    bytes: crate::ops::bytes,
    coverage: crate::ops::coverage,
    db: crate::ops::db,
    debug: crate::ops::debug,
    dependencies: crate::ops::dependencies,
    deploy: crate::ops::deploy,
    doc: crate::ops::doc,
    doc_commands: crate::ops::doc::commands,
    docker: crate::ops::docker,
    env: crate::ops::env,
    flutter: crate::ops::flutter,
    fs: crate::ops::fs,
    heap: crate::ops::heap,
    history: crate::ops::history,
    java: crate::ops::java,
    jvm_icons: crate::ops::jvm_icons,
    lsp: crate::ops::lsp,
    mcp: crate::mcp::service,
    mcp_reports: crate::mcp::reports,
    nav: crate::ops::nav,
    notebook: crate::ops::notebook,
    plugins_commands: crate::plugins::commands,
    plugins_commit: crate::plugins::commit,
    plugins_index_ops: crate::plugins::index_ops,
    plugins_run_targets: crate::plugins::run_targets,
    plugins_search: crate::plugins::search,
    plugins_views: crate::plugins::views,
    project: crate::ops::project,
    refactor: crate::ops::refactor,
    run: crate::ops::run,
    run_commands: crate::ops::run::commands,
    scaffold: crate::ops::scaffold,
    sdk: crate::ops::sdk,
    sdk_container_python: crate::ops::sdk::container_python,
    search: crate::ops::search,
    search_commands: crate::ops::search::commands,
    spell: crate::ops::spell,
    ssh: crate::ops::ssh,
    stream_trace: crate::ops::stream_trace,
    syntax: crate::ops::syntax,
    term: crate::ops::term,
    tools: crate::ops::tools,
    vcs: crate::ops::vcs,
    vcs_commands: crate::ops::vcs::commands,
    web: crate::ops::web,
);

impl Host {
    /// Runs blocking work (disk I/O, parsing, large copies) on the blocking pool.
    pub async fn blocking<T: Send + 'static>(&self, f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
        self.runtime.spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
    }
}
