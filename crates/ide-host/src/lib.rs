//! The IDE backend without a UI toolkit: open projects per window, terminals,
//! processes, settings and the remote services. The desktop shell (`src-tauri`)
//! wraps one [`Host`] and adds windows and menus; `openidea-server`
//! runs one on a remote machine and serves it over JSON-RPC ([`rpc`]).

pub mod agent_secrets;
pub mod catalogue;
#[cfg(unix)]
pub mod daemon;
pub mod data_dirs;
pub mod diagnostics_store;
mod direnv;
pub mod environment;
mod formatter;
pub mod github_auth;
mod java_runtime;
mod kotlin_bridge;
pub mod mcp;
pub mod menu;
pub mod notebook;
pub mod ops;
mod phpstan;
pub mod plugins;
mod project;
mod proxy;
pub mod relay;
mod requests;
pub mod rpc;
pub mod shell_env;
pub mod trust;
mod ts_code_style;
mod tsc_watch;
pub mod web_server;

pub use project::{Project, history_retention};

use ide_core::{CancellationToken, IdeError, IdeResult, RequestId, SharedSink};
use ide_language::{LanguageRegistry, Syntax};
use ide_run::ProcessManager;
use ide_terminal::TerminalManager;
use ide_workspace::SettingsStore;
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

/// Event sink for one window (by label).
pub type SinkFactory = Box<dyn Fn(&str) -> SharedSink + Send + Sync>;

pub struct HostConfig {
    pub config_dir: PathBuf,
    /// Persistent user state, including credentials and recovery history.
    pub data_dir: PathBuf,
    /// Machine-local tools and rebuildable caches.
    pub local_data_dir: PathBuf,
    pub languages: Arc<LanguageRegistry>,
    /// Grammars, possibly still being built on another thread.
    pub syntax: Arc<OnceLock<Arc<Syntax>>>,
    pub sink_for: SinkFactory,
    /// The window that owns what `window` starts (e.g. a settings window's parent).
    pub owner: fn(&str) -> &str,
    pub runtime: tokio::runtime::Handle,
    /// Apply the open project's `devcontainer.json` (`remoteEnv`, `postStartCommand`) to
    /// this process's children: the remote server, which has one project.
    pub project_environment: bool,
}

#[cfg(test)]
impl HostConfig {
    /// A host under `base` for unit tests: `config`, `data` and `data` again for the machine-local
    /// directory, built-in languages, no grammars, a sink that drops events, the window as its own
    /// owner, the current tokio runtime and no project environment. Override fields with
    /// `HostConfig { sink_for: .., ..HostConfig::for_test(base) }`. Call it inside a runtime.
    pub(crate) fn for_test(base: &Path) -> Self {
        Self {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("data"),
            languages: Arc::new(LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }
    }
}

pub struct Host {
    local_database_tunnels: bool,
    pub(crate) mcp_executable: Arc<RwLock<Option<PathBuf>>>,
    pub mcp: mcp::McpService,
    plugin_host: RwLock<std::sync::Weak<plugins::PluginHost>>,
    /// Every `Diagnostics` event the host ever emitted, per file and producer:
    /// the snapshot plugins read (`problems`), independent of windows and reports.
    pub diagnostics: Arc<diagnostics_store::DiagnosticsStore>,
    pub mcp_reports: mcp::Reports,
    pub mcp_requests: mcp::Requests,
    /// Commands agents run in the Run tool window (`run_command`).
    pub mcp_agent_runs: mcp::AgentRuns,
    /// Projects the MCP server serves without a window.
    pub mcp_background: mcp::BackgroundProjects,
    pub(crate) agent_catalogs: Arc<ide_agent::AgentCatalogs>,
    pub trust: std::sync::Arc<trust::TrustStore>,
    pub(crate) mcp_approvals: Arc<trust::McpServerApprovals>,
    pub config_dir: PathBuf,
    /// Persistent user state, including credentials and recovery history.
    pub data_dir: PathBuf,
    /// Machine-local tools and rebuildable caches.
    pub local_data_dir: PathBuf,
    pub languages: Arc<LanguageRegistry>,
    syntax: Arc<OnceLock<Arc<Syntax>>>,
    pub global_settings: SettingsStore,
    pub dependency_versions: Arc<ide_workspace::dependencies::VersionCache>,
    pub pypi_names: Arc<ide_workspace::dependencies::pypi::NameCache>,
    pub terminals: TerminalManager,
    pub processes: ProcessManager,
    /// Debug sessions (adapters run on this machine, next to the project).
    pub debugger: Arc<ide_dap::DebugManager>,
    /// Heap snapshots open in any window, captured from a debug session or opened from a file.
    pub heap: Arc<ide_heap::HeapRegistry>,
    /// The window that owns each open heap snapshot; its project's close closes them.
    pub(crate) heap_windows: Mutex<HashMap<ide_heap::HeapSnapshotId, String>>,
    pub(crate) heap_requests: ops::heap::HeapRequests,
    pub(crate) rebase_editors: Arc<ops::vcs::RebaseEditors>,
    /// The IDE's Java build: resident javac processes shared by every window's launches.
    pub(crate) java_build: Arc<ide_build::jbuild::JavaBuildService>,
    pub(crate) metrics_sampler: Mutex<ops::host_metrics::HostMetricsSampler>,
    /// SSH connections of Settings › SSH Configurations.
    pub ssh: Arc<ide_ssh::SshManager>,
    /// SFTP deployment, remote file editing and runs on run targets.
    pub remote: Arc<ide_remote::RemoteService>,
    /// Tunnels of Docker connections made through an SSH configuration.
    pub docker_tunnels: ops::docker::DockerTunnels,
    /// What child processes get beyond this process's environment (Reload Environment, `remoteEnv`).
    pub environment: environment::Environment,
    /// The built-in web server (Open In › Browser, the editor's browser bar). On a remote host the
    /// client forwards its ports.
    pub web: ide_web::WebServer,
    /// The HTTP proxy's saved password (see `proxy.rs`).
    proxy_password: ide_ssh::secrets::SecretFile,
    /// The proxy password when it could not be saved (no credential store).
    proxy_session_password: Mutex<Option<String>>,
    /// Values of agents' and MCP servers' environment variables and headers (see `agent_secrets.rs`).
    pub agent_secrets: Arc<agent_secrets::AgentSecrets>,
    pub(crate) sink_for: SinkFactory,
    owner: fn(&str) -> &str,
    pub runtime: tokio::runtime::Handle,
    /// One project per window, keyed by window label.
    projects: RwLock<HashMap<String, Arc<Project>>>,
    pub(crate) external_logs: RwLock<HashMap<String, Vec<Arc<ide_vcs::Repo>>>>,
    requests: requests::Requests,
    project_requests: RwLock<HashMap<String, Vec<RequestId>>>,
    /// Shutdowns of projects closed with [`Host::close_project_detached`].
    closing: parking_lot::Mutex<Vec<DetachedClose>>,
    /// One open at a time per window (see [`Host::opening`]).
    open_locks: parking_lot::Mutex<HashMap<String, Arc<parking_lot::Mutex<()>>>>,
}

struct DetachedClose {
    root: Option<std::path::PathBuf>,
    handle: std::thread::JoinHandle<()>,
}

struct ShutdownWork {
    notebooks: Vec<Arc<notebook::NotebookService>>,
    bridges: Vec<Arc<kotlin_bridge::KotlinBridge>>,
    lsp: Option<Arc<ide_lsp::LspManager>>,
    debug: Option<(Arc<ide_dap::DebugManager>, String, Option<std::path::PathBuf>)>,
    agents: Vec<Arc<ide_agent::AgentManager>>,
    terminals: Option<ide_terminal::DetachedTerminals>,
    processes: Option<ide_run::DetachedProcessKills>,
    retired: Option<Arc<Project>>,
}

fn roots_overlap(a: &std::path::Path, b: &std::path::Path) -> bool {
    a == b || a.starts_with(b) || b.starts_with(a)
}

/// How long exit waits for project shutdown before giving up.
const EXIT_SHUTDOWN_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

impl Host {
    /// Windows whose current project has this root. A project served without a window
    /// has none.
    pub(crate) fn windows_for_root(&self, root: &std::path::Path) -> Vec<String> {
        let mut windows: Vec<_> = self
            .projects
            .read()
            .iter()
            .filter(|(w, p)| p.root == root && !mcp::BackgroundProjects::is_key(w))
            .map(|(w, _)| w.clone())
            .collect();
        windows.sort();
        windows
    }

    /// Enables user-approved database helper processes on the local desktop.
    pub fn with_local_database_tunnels(mut self) -> Self {
        self.local_database_tunnels = true;
        self
    }

    pub fn new(config: HostConfig) -> Self {
        let HostConfig {
            config_dir,
            data_dir,
            local_data_dir,
            languages,
            syntax,
            sink_for,
            owner,
            runtime,
            project_environment,
        } = config;
        // Every sink the host hands out records diagnostics into the shared store first.
        let diagnostics: Arc<diagnostics_store::DiagnosticsStore> = Arc::default();
        let sink_for: SinkFactory = diagnostics_store::recording_sink_factory(diagnostics.clone(), sink_for);
        let global_settings = SettingsStore::load(&config_dir, None);
        let ssh = Arc::new(ide_ssh::SshManager::new(data_dir.join("ssh-passwords.json")));
        let migration = ssh.clone();
        runtime.spawn_blocking(move || migration.start_password_migration());
        ssh.set_configs(global_settings.effective().ssh.configs);
        let host = Self {
            plugin_host: RwLock::default(),
            local_database_tunnels: false,
            mcp_executable: Arc::default(),
            mcp: Default::default(),
            diagnostics,
            mcp_reports: Default::default(),
            mcp_requests: Default::default(),
            mcp_agent_runs: Default::default(),
            mcp_background: Default::default(),
            agent_catalogs: Arc::default(),
            trust: std::sync::Arc::new(trust::TrustStore::load(&config_dir, &data_dir)),
            mcp_approvals: Arc::new(trust::McpServerApprovals::load(&data_dir)),
            proxy_password: ide_ssh::secrets::SecretFile::new(data_dir.join("proxy-password.json")),
            proxy_session_password: Mutex::default(),
            agent_secrets: Arc::new(agent_secrets::AgentSecrets::new(&data_dir)),
            remote: Arc::new(ide_remote::RemoteService::new(ssh.clone(), data_dir.join("remote"))),
            ssh,
            docker_tunnels: Default::default(),
            environment: environment::Environment::new(project_environment, local_data_dir.clone()),
            web: ide_web::WebServer::new(),
            global_settings,
            dependency_versions: Arc::new(ide_workspace::dependencies::VersionCache::new(
                data_dir.join("cache/dependency-versions"),
            )),
            pypi_names: Arc::new(ide_workspace::dependencies::pypi::NameCache::new(data_dir.join("cache"))),
            // Sessions, runs and terminals report to the window that started them (`window_sink`).
            terminals: TerminalManager::new(),
            processes: ProcessManager::new(),
            debugger: ide_dap::DebugManager::new(languages.clone()),
            heap: Arc::new(ide_heap::HeapRegistry::new(ide_heap::snapshots_root(&local_data_dir))),
            heap_windows: Mutex::default(),
            heap_requests: Default::default(),
            rebase_editors: Default::default(),
            java_build: Default::default(),
            metrics_sampler: Default::default(),
            languages,
            syntax,
            config_dir,
            data_dir,
            local_data_dir,
            sink_for,
            owner,
            runtime,
            projects: RwLock::default(),
            external_logs: RwLock::default(),
            requests: Default::default(),
            project_requests: RwLock::default(),
            closing: Default::default(),
            open_locks: Default::default(),
        };
        host.apply_proxy();
        host.apply_added_jdks();
        host.apply_git_executable();
        // Before any project starts jdtls; the deleting itself can take a while.
        let unused =
            ide_sdk::jdtls_workspaces::take_unused(&host.local_data_dir, ide_sdk::jdtls_workspaces::UNUSED_FOR);
        if !unused.is_empty() {
            std::thread::spawn(move || ide_sdk::jdtls_workspaces::remove(unused));
        }
        ops::agent::move_user_mcp_values(&host);
        host
    }

    /// The tree-sitter grammars (blocks only if start-up warm-up is still running).
    pub fn syntax(&self) -> Arc<Syntax> {
        self.syntax.get_or_init(|| Arc::new(Syntax::new())).clone()
    }

    /// Plugin languages or the servers they may start changed (they are part
    /// of [`Self::languages`] and every project's fork): open documents are
    /// detected again and language servers follow their new configuration.
    pub fn plugin_languages_changed(&self) {
        for project in self.projects() {
            project.documents.redetect_languages();
            let lsp = project.lsp.clone();
            self.runtime.spawn(async move { lsp.reconfigure().await });
        }
    }

    /// Publishes the executable of the running built-in MCP service (`None` while it is off).
    pub fn set_mcp_executable(&self, executable: Option<PathBuf>) {
        *self.mcp_executable.write() = executable;
    }

    /// Associates the plugin runtime that executes this host's project operations.
    pub fn set_plugin_host(&self, plugins: &Arc<plugins::PluginHost>) {
        *self.plugin_host.write() = Arc::downgrade(plugins);
    }
    pub(crate) fn plugin_host(&self) -> Option<Arc<plugins::PluginHost>> {
        self.plugin_host.read().upgrade()
    }

    /// Every open project (all windows).
    pub fn projects(&self) -> Vec<Arc<Project>> {
        self.projects.read().values().cloned().collect()
    }

    /// The project of `window` (or of the window owning it).
    pub fn project(&self, window: &str) -> IdeResult<Arc<Project>> {
        self.projects
            .read()
            .get((self.owner)(window))
            .cloned()
            .ok_or_else(|| IdeError::not_found("no project is open in this window"))
    }

    pub fn require_trust(&self, window: &str) -> IdeResult<()> {
        self.project(window)?.require_trust()
    }

    /// [`Self::require_trust`] for IDE-wide toolchain work (SDK detection, tool installs) that
    /// also runs from a window without a project, such as Settings opened from the Welcome
    /// screen: there is no project there to trust.
    pub fn require_trust_if_project(&self, window: &str) -> IdeResult<()> {
        match self.project(window) {
            Ok(project) => project.require_trust(),
            Err(_) => Ok(()),
        }
    }

    /// The window that owns what `window` starts.
    pub fn owner_window<'a>(&self, window: &'a str) -> &'a str {
        (self.owner)(window)
    }

    /// Event sink for things `window` starts (debug sessions, runs, terminals): its
    /// project's window-scoped sink, or a sink for that window when no project is open.
    pub fn window_sink(&self, window: &str) -> SharedSink {
        match self.project(window) {
            Ok(p) => p.sink.clone(),
            Err(_) => (self.sink_for)((self.owner)(window)),
        }
    }

    /// Closes `window`'s project and waits until its language servers, kernels and
    /// debug sessions have shut down. Never call this on the UI event-loop thread:
    /// the shutdown runs on the async runtime, whose workers may themselves be
    /// waiting for the event loop (IPC responses, window queries). Use
    /// [`Self::close_project_detached`] there.
    pub fn close_project(&self, window: &str) {
        if let Some(shutdown) = self.begin_close(window) {
            self.wait_blocking(shutdown.handle);
        }
    }

    /// Like [`Self::close_project`], but returns once the project is detached from
    /// the window; its workers finish shutting down in the background, and
    /// [`Self::shutdown_notebooks_on_exit`] waits for them before the process exits.
    pub fn close_project_detached(&self, window: &str) {
        if let Some(shutdown) = self.begin_close(window) {
            let mut closing = self.closing.lock();
            closing.retain(|entry| !entry.handle.is_finished());
            closing.push(shutdown);
        }
    }

    /// Detaches the project from `window` synchronously so the caller (including the UI
    /// event-loop thread) never blocks on disk I/O or process shutdown, and returns the
    /// background handle that stops its workers, agents, terminals and processes.
    fn begin_close(&self, window: &str) -> Option<DetachedClose> {
        self.mcp_reports.forget_window(window);
        self.mcp_requests.forget_window(window);
        self.mcp_agent_runs.forget_window(window);
        self.debugger.forget_breakpoints(self.owner_window(window));
        self.external_logs.write().remove(self.owner_window(window));
        for request in self.project_requests.write().remove(self.owner_window(window)).unwrap_or_default() {
            self.cancel_request(request);
        }
        // After the cancels: a capture or open still running then discards what it registers.
        ops::heap::close_window_snapshots(self, window);
        let project = self.projects.write().remove(window)?;
        if let Some(plugins) = self.plugin_host() {
            if self.windows_for_root(&project.root).is_empty() {
                plugins.project_closed(&project.root, window);
            } else {
                plugins.forget_client(window);
            }
        }
        project.files_events_active.store(false, std::sync::atomic::Ordering::Release);
        project.plugin_diagnostics.close();
        // A project served without a window shares its files with a window whose root lies
        // around or below its own: their diagnostics stay.
        let background = mcp::BackgroundProjects::is_key(window);
        let shared = background
            && self.projects.read().values().any(|other| {
                !other.light && (other.root.starts_with(&project.root) || project.root.starts_with(&other.root))
            });
        // The producers will re-report when a project reopens; until then the snapshot
        // must not answer for files whose project is gone.
        if !shared {
            self.diagnostics.forget_root(&project.root);
        }
        if let Some(plugins) = plugins::editor_plugin_host() {
            plugins.invalidate_client_navigation(&project.root, Some(window), None);
            plugins.set_active_file(window, None, None);
        }
        if !project.light {
            self.environment.project_closed();
            if self.windows_for_root(&project.root).is_empty() {
                self.environment.direnv_closed(&project.root);
                crate::github_auth::clear_project_env(&project);
            }
        }
        if let Some(bridge) = &project.kotlin_bridge {
            bridge.stop();
        }
        if let Some(phpstan) = &project.phpstan {
            phpstan.stop();
        }
        if let Some(watch) = &project.tsc_watch {
            watch.stop();
        }
        project.documents.clear_workspace_edit_history();
        project.agents.detach_sinks();
        project.flutter.stop();
        project.devtools.stop();
        project.widget_preview.stop();
        project.notebooks.stop_admission();
        // Detach runs and terminals synchronously so a new project opened in the same window
        // never collides with them, then terminate them and shut down agents on the background thread.
        let processes = self.processes.detach_project_kills(&project.root);
        let terminals = self.terminals.detach_key(self.owner_window(window));
        let root = (!project.light).then(|| project.root.clone());
        let handle = self.spawn_project_shutdown(ShutdownWork {
            notebooks: vec![project.notebooks.clone()],
            bridges: project.kotlin_bridge.iter().cloned().collect(),
            lsp: Some(project.lsp.clone()),
            // Debug sessions under the root belong to windows: a project served without one starts none.
            debug: Some((self.debugger.clone(), window.to_owned(), (!background).then(|| project.root.clone()))),
            agents: vec![project.agents.clone()],
            terminals: Some(terminals),
            processes: Some(processes),
            retired: Some(project),
        });
        Some(DetachedClose { root, handle })
    }

    /// Project/window destruction must finish owned kernel and agent cleanup, not enqueue
    /// work which can be lost as the desktop runtime exits: the returned thread is
    /// joined by the closer or, for a detached close, before exit.
    fn spawn_project_shutdown(&self, work: ShutdownWork) -> std::thread::JoinHandle<()> {
        for bridge in &work.bridges {
            bridge.stop();
        }
        for service in &work.notebooks {
            service.stop_admission();
        }
        let runtime = self.runtime.clone();
        std::thread::spawn(move || {
            if let Some(processes) = work.processes {
                processes.kill();
            }
            if let Some(terminals) = work.terminals {
                terminals.terminate();
            }
            let agents = (!work.agents.is_empty()).then(|| {
                let agents = work.agents;
                std::thread::spawn(move || {
                    for manager in agents {
                        manager.shutdown();
                    }
                })
            });
            // Dropping the project stops its file watcher and index worker, which first finish the
            // batch they are applying (many file events while a build writes its output), so it
            // isn't done on the closing caller's thread (the UI thread for a window close).
            let retired = work.retired.map(|project| std::thread::spawn(move || drop(project)));
            runtime.block_on(async move {
                for bridge in work.bridges {
                    bridge.shutdown().await;
                }
                for service in work.notebooks {
                    service.shutdown().await;
                }
                if let Some(lsp) = work.lsp {
                    lsp.shutdown_all().await;
                }
                if let Some((debug, key, root)) = work.debug {
                    debug.stop_key(&key).await;
                    if let Some(root) = root {
                        debug.stop_under(&root).await;
                    }
                }
            });
            if let Some(agents) = agents {
                let _ = agents.join();
            }
            if let Some(retired) = retired {
                let _ = retired.join();
            }
        })
    }

    /// Waits for every detached close to finish.
    #[cfg(test)]
    pub(crate) fn wait_detached_closes(&self) {
        let pending: Vec<_> = self.closing.lock().drain(..).collect();
        for shutdown in pending {
            self.wait_blocking(shutdown.handle);
        }
    }

    /// Waits only for detached closes whose root overlaps `root`, so opening an unrelated project
    /// never blocks on another project's background shutdown.
    pub(crate) fn wait_detached_closes_for(&self, root: &std::path::Path) {
        let matching = {
            let mut closing = self.closing.lock();
            closing.retain(|entry| !entry.handle.is_finished());
            let mut wait = Vec::new();
            let mut keep = Vec::new();
            for entry in closing.drain(..) {
                if entry.root.as_deref().is_some_and(|other| roots_overlap(other, root)) {
                    wait.push(entry.handle);
                } else {
                    keep.push(entry);
                }
            }
            *closing = keep;
            wait
        };
        for handle in matching {
            self.wait_blocking(handle);
        }
    }

    fn wait_blocking(&self, shutdown: std::thread::JoinHandle<()>) {
        Self::in_place(move || {
            if let Err(error) = shutdown.join() {
                tracing::error!("project shutdown thread failed: {error:?}");
            }
        });
    }

    /// Runs blocking work on this thread. On a worker of a multi-thread runtime the
    /// runtime is told first, so the worker's other tasks move to another thread.
    pub(crate) fn in_place<T>(work: impl FnOnce() -> T) -> T {
        if tokio::runtime::Handle::try_current()
            .is_ok_and(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
        {
            tokio::task::block_in_place(work)
        } else {
            work()
        }
    }

    /// Called before the desktop runtime exits, including update/restart exits, on
    /// the event-loop thread: waits for detached closes and the open projects'
    /// kernels and agents, but no longer than [`EXIT_SHUTDOWN_WAIT`], so a runtime worker
    /// stuck on the event loop cannot keep the process from exiting.
    pub fn shutdown_notebooks_on_exit(&self) {
        let projects = self.projects();
        let mut pending: Vec<_> = self.closing.lock().drain(..).map(|entry| entry.handle).collect();
        if !projects.is_empty() {
            pending.push(self.spawn_project_shutdown(ShutdownWork {
                notebooks: projects.iter().map(|project| project.notebooks.clone()).collect(),
                bridges: projects.iter().filter_map(|project| project.kotlin_bridge.clone()).collect(),
                lsp: None,
                debug: None,
                agents: projects.iter().map(|project| project.agents.clone()).collect(),
                terminals: None,
                processes: None,
                retired: None,
            }));
        }
        let deadline = std::time::Instant::now() + EXIT_SHUTDOWN_WAIT;
        while pending.iter().any(|handle| !handle.is_finished()) {
            if std::time::Instant::now() >= deadline {
                tracing::warn!("project shutdown did not finish within {EXIT_SHUTDOWN_WAIT:?}; exiting anyway");
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        for handle in pending {
            if let Err(error) = handle.join() {
                tracing::error!("project shutdown thread failed: {error:?}");
            }
        }
    }

    /// Called on desktop exit: kills the runs and terminal shells still alive. Closing a
    /// window stops what it started, but a quit from the Dock, the app menu or a logout
    /// exits without closing the windows, and the process trees would outlive the app.
    pub fn stop_processes_on_exit(&self) {
        self.processes.kill_all();
        self.terminals.kill_all();
        for project in self.projects() {
            project.flutter.kill();
            project.devtools.kill();
            project.widget_preview.kill();
        }
    }

    /// Called before desktop exit, which may bypass document destructors.
    pub fn clear_workspace_edit_history_on_exit(&self) {
        for project in self.projects() {
            project.documents.clear_workspace_edit_history();
        }
    }

    /// Cleans up per-connection client state when a remote window disconnects from a
    /// persistent daemon, leaving the project, index, language servers, terminals,
    /// runs and agent sessions running.
    pub fn client_disconnected(&self) {
        let windows: Vec<String> = self.projects.read().keys().cloned().collect();
        for window in &windows {
            self.mcp_reports.forget_window(window);
            self.mcp_requests.forget_window(window);
            for request in self.project_requests.write().remove(self.owner_window(window)).unwrap_or_default() {
                self.cancel_request(request);
            }
        }
        self.terminals.detach_output();
        self.processes.detach_output();
        for project in self.projects() {
            project.documents.release_client_refs();
        }
    }

    /// Stops what this host started: heap snapshots, notebook kernels, language servers, agents,
    /// runs and terminals.
    /// For a process that exits without dropping the host (the remote server).
    pub async fn shutdown(&self) {
        // A capture's dump may hold secrets from the debuggee's memory: delete it before exiting.
        ops::heap::shutdown(self).await;
        self.environment.shutdown();
        self.terminals.kill_all();
        let projects: Vec<_> = self.projects.write().drain().map(|(_, p)| p).collect();
        for project in &projects {
            project.files_events_active.store(false, std::sync::atomic::Ordering::Release);
            project.flutter.kill();
            project.devtools.kill();
            project.widget_preview.kill();
        }
        for project in &projects {
            project.plugin_diagnostics.close();
            if let Some(bridge) = &project.kotlin_bridge {
                bridge.stop();
            }
            if let Some(phpstan) = &project.phpstan {
                phpstan.stop();
            }
            if let Some(watch) = &project.tsc_watch {
                watch.stop();
            }
            project.documents.clear_workspace_edit_history();
            project.notebooks.stop_admission();
            project.agents.shutdown();
        }
        let stop_processes = async {
            for project in &projects {
                self.debugger.stop_under(&project.root).await;
            }
            self.processes.shutdown().await;
        };
        // Kernel cleanup owns its interrupt/termination/reaping deadlines. An
        // outer LSP timeout must never abort it before owned children are reaped.
        let stop_kernels = async {
            for project in &projects {
                if let Some(bridge) = &project.kotlin_bridge {
                    bridge.shutdown().await;
                }
                project.notebooks.shutdown().await;
            }
        };
        let stop_language_servers = async {
            for project in &projects {
                project.lsp.shutdown_all().await;
            }
        };
        let stop_lsp = async {
            if tokio::time::timeout(std::time::Duration::from_secs(10), stop_language_servers).await.is_err() {
                tracing::warn!("language servers did not shut down in time");
            }
        };
        tokio::join!(stop_processes, stop_kernels, stop_lsp);
    }

    // ---- cancellable requests: the UI allocates ids, `cancel_request` cancels ----

    pub fn begin_request(&self, id: RequestId) -> CancellationToken {
        self.requests.begin(id)
    }

    /// Settings › Tools › Download Mirrors › Use only the configured package registries: nothing
    /// is fetched from public package registries the user's tools weren't pointed at.
    pub fn configured_registries_only(&self) -> bool {
        self.global_settings.effective().tool_downloads.configured_registries_only
    }

    pub fn begin_project_request(&self, window: &str, id: RequestId) -> CancellationToken {
        let token = self.begin_project_read_request(window, id);
        if self.project(window).is_ok_and(|p| !p.is_trusted()) {
            token.cancel();
        }
        token
    }

    /// Read-only work remains cancellable/disposed with its window in restricted projects.
    pub fn begin_project_read_request(&self, window: &str, id: RequestId) -> CancellationToken {
        let token = self.begin_request(id);
        self.project_requests.write().entry(self.owner_window(window).to_owned()).or_default().push(id);
        token
    }

    pub fn end_request(&self, id: RequestId) {
        for ids in self.project_requests.write().values_mut() {
            ids.retain(|entry| *entry != id);
        }
        self.requests.end(id);
    }

    /// Cancels request `id`, also when it has not begun yet (it then starts out cancelled).
    pub fn cancel_request(&self, id: RequestId) {
        self.requests.cancel(id);
    }

    /// The lock an open of `window` holds from its check for the current project to its
    /// insert: two opens racing (a double click, a launch path and a restore) would each start
    /// an index, language servers and watchers, and the second would replace the first unclosed.
    pub(crate) fn opening(&self, window: &str) -> Arc<parking_lot::Mutex<()>> {
        self.open_locks.lock().entry(window.to_owned()).or_default().clone()
    }

    pub(crate) fn insert_project(&self, window: &str, project: Arc<Project>) {
        self.projects.write().insert(window.to_owned(), project);
    }
}

impl Host {
    /// Lists the JDKs added by hand (global Settings › SDKs) with the detected ones.
    pub fn apply_added_jdks(&self) {
        let homes = self.global_settings.effective().languages.java.added_jdks;
        ide_sdk::java::set_added_jdks(homes.into_iter().map(PathBuf::from));
    }

    /// Global Settings › Version Control › Git › Path to Git executable, for git started outside
    /// a project's repositories (clone, init, agents, gh, plugins). A project's own value stays
    /// with its repositories ([`Project::repos`]).
    pub fn apply_git_executable(&self) {
        let exe = self.global_settings.read_effective(|s| s.vcs.git.executable.trim().to_owned());
        ide_vcs::set_default_git_executable((!exe.is_empty()).then(|| Path::new(&exe)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detached_close_releases_the_project_before_a_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
        let host = Host::new(HostConfig { local_data_dir: base.join("local"), ..HostConfig::for_test(&base) });
        let project = Arc::downgrade(&host.open_project("main", &root).unwrap());
        host.close_project_detached("main");
        assert!(host.project("main").is_err());
        // The project (its file watcher and index database) is dropped off the closing thread, but
        // before opening a project waits out the close.
        host.wait_detached_closes();
        assert!(project.upgrade().is_none(), "the closed project is dropped");
        host.open_project("main", &root).unwrap();
        host.close_project("main");
    }
}
