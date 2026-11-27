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
pub mod host_metrics;
pub mod http;
pub mod java;
pub mod jvm_icons;
pub mod lsp;
pub mod maven_placeholder;
pub mod nav;
pub mod notebook;
mod plots;
pub mod project;
pub mod pytest_fixtures;
mod python;
pub mod python_stubs;
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
pub mod thread_dump;
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
    host_metrics: crate::ops::host_metrics,
    http: crate::ops::http,
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
    thread_dump: crate::ops::thread_dump,
    tools: crate::ops::tools,
    vcs: crate::ops::vcs,
    vcs_commands: crate::ops::vcs::commands,
    web: crate::ops::web,
);

/// A blocking task that panicked or was cancelled, as the error a command returns.
pub(crate) fn join_error(e: tokio::task::JoinError) -> IdeError {
    IdeError::internal(e.to_string())
}

/// Runs blocking work (disk I/O, parsing, large copies) on the ambient runtime's blocking
/// pool, keeping it off the main thread and the async runtime's workers.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(join_error)?
}

/// [`blocking`] for work that cannot fail: only a panic or cancellation is an error.
pub(crate) async fn blocking_value<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(join_error)
}

impl Host {
    /// [`blocking`] on this host's runtime instead of the ambient one.
    pub async fn blocking<T: Send + 'static>(&self, f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
        self.runtime.spawn_blocking(f).await.map_err(join_error)?
    }
}

#[cfg(test)]
mod blocking_tests {
    use super::{blocking, blocking_value};
    use crate::{Host, HostConfig};
    use ide_core::error::ErrorKind;
    use ide_core::{IdeError, IdeResult};
    use std::sync::Arc;

    fn runtime(name: &str) -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().worker_threads(1).thread_name(name).enable_all().build().unwrap()
    }

    fn thread_name() -> String {
        std::thread::current().name().unwrap_or_default().to_owned()
    }

    fn assert_panic(error: &IdeError) {
        assert_eq!(error.kind, ErrorKind::Internal);
        assert!(error.data.is_none());
        // tokio's JoinError text: `task <id> panicked with message "boom"` (the id varies).
        assert!(error.message.starts_with("task "), "{}", error.message);
        assert!(error.message.ends_with(" panicked with message \"boom\""), "{}", error.message);
    }

    fn host_on(handle: tokio::runtime::Handle, base: &std::path::Path) -> Host {
        Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: handle,
            project_environment: false,
        })
    }

    #[test]
    fn blocking_returns_the_value_and_passes_the_closure_error_through() {
        runtime("ambient").block_on(async {
            assert_eq!(blocking(|| Ok(7)).await.unwrap(), 7);
            let error = blocking::<()>(|| Err(IdeError::invalid("nope"))).await.unwrap_err();
            assert_eq!((error.kind, error.message.as_str()), (ErrorKind::InvalidInput, "nope"));
        });
    }

    #[test]
    fn blocking_maps_a_panic_to_an_internal_error() {
        runtime("ambient").block_on(async {
            assert_panic(&blocking::<()>(|| panic!("boom")).await.unwrap_err());
        });
    }

    #[test]
    fn blocking_runs_on_the_ambient_runtime() {
        let name = runtime("ambient").block_on(async { blocking(|| Ok(thread_name())).await.unwrap() });
        assert_eq!(name, "ambient");
    }

    #[test]
    fn blocking_value_returns_the_value_and_maps_a_panic() {
        runtime("ambient").block_on(async {
            assert_eq!(blocking_value(thread_name).await.unwrap(), "ambient");
            assert_panic(&blocking_value::<()>(|| panic!("boom")).await.unwrap_err());
        });
    }

    #[test]
    fn host_blocking_runs_on_the_hosts_runtime_not_the_ambient_one() {
        let (ambient, hosts) = (runtime("ambient"), runtime("hosts"));
        let temp = tempfile::tempdir().unwrap();
        let host = host_on(hosts.handle().clone(), temp.path());
        ambient.block_on(async {
            assert_eq!(host.blocking(|| Ok(thread_name())).await.unwrap(), "hosts");
            assert_eq!(host.blocking(|| IdeResult::Ok(7)).await.unwrap(), 7);
            let error = host.blocking::<()>(|| Err(IdeError::invalid("nope"))).await.unwrap_err();
            assert_eq!((error.kind, error.message.as_str()), (ErrorKind::InvalidInput, "nope"));
            assert_panic(&host.blocking::<()>(|| panic!("boom")).await.unwrap_err());
        });
    }
}
