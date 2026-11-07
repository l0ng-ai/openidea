//! The IDE backend without a UI toolkit: open projects per window, terminals,
//! processes, settings and the remote services. The desktop shell (`src-tauri`)
//! wraps one [`Host`] and adds windows and menus; `openidea-server`
//! runs one on a remote machine and serves it over JSON-RPC ([`rpc`]).

pub mod data_dirs;
pub mod environment;
mod formatter;
mod java_runtime;
mod kotlin_bridge;
pub mod notebook;
pub mod ops;
mod phpstan;
pub mod plugins;
mod project;
mod proxy;
mod requests;
pub mod rpc;
pub mod shell_env;
pub mod trust;

pub use project::{Project, apply_git_executable, apply_workspace_edit, history_retention};

use ide_core::{CancellationToken, IdeError, IdeResult, RequestId, SharedSink};
use ide_language::{LanguageRegistry, Syntax};
use ide_run::ProcessManager;
use ide_terminal::TerminalManager;
use ide_workspace::SettingsStore;
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::PathBuf;
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

pub struct Host {
    pub trust: trust::TrustStore,
    pub config_dir: PathBuf,
    /// Persistent user state, including credentials and recovery history.
    pub data_dir: PathBuf,
    /// Machine-local tools and rebuildable caches.
    pub local_data_dir: PathBuf,
    pub languages: Arc<LanguageRegistry>,
    syntax: Arc<OnceLock<Arc<Syntax>>>,
    pub global_settings: SettingsStore,
    pub dependency_versions: Arc<ide_workspace::dependencies::VersionCache>,
    pub terminals: TerminalManager,
    pub processes: ProcessManager,
    /// Debug sessions (adapters run on this machine, next to the project).
    pub debugger: Arc<ide_dap::DebugManager>,
    /// SSH connections of Settings › SSH Configurations.
    pub ssh: Arc<ide_ssh::SshManager>,
    /// SFTP deployment, remote file editing and runs on run targets.
    pub remote: Arc<ide_remote::RemoteService>,
    /// What child processes get beyond this process's environment (Reload Environment, `remoteEnv`).
    pub environment: environment::Environment,
    /// The HTTP proxy's saved password (see `proxy.rs`).
    proxy_password: ide_ssh::secrets::SecretFile,
    /// The proxy password when it could not be saved (no credential store).
    proxy_session_password: Mutex<Option<String>>,
    pub(crate) sink_for: SinkFactory,
    owner: fn(&str) -> &str,
    pub runtime: tokio::runtime::Handle,
    /// One project per window, keyed by window label.
    projects: RwLock<HashMap<String, Arc<Project>>>,
    pub(crate) external_logs: RwLock<HashMap<String, Vec<Arc<ide_vcs::Repo>>>>,
    requests: requests::Requests,
    project_requests: RwLock<HashMap<String, Vec<RequestId>>>,
    /// Shutdowns of projects closed with [`Host::close_project_detached`].
    closing: parking_lot::Mutex<Vec<std::thread::JoinHandle<()>>>,
    /// One open at a time per window (see [`Host::opening`]).
    open_locks: parking_lot::Mutex<HashMap<String, Arc<parking_lot::Mutex<()>>>>,
}

/// How long exit waits for project shutdown before giving up.
const EXIT_SHUTDOWN_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

impl Host {
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
        let global_settings = SettingsStore::load(&config_dir, None);
        let ssh = Arc::new(ide_ssh::SshManager::new(data_dir.join("ssh-passwords.json")));
        ssh.set_configs(global_settings.effective().ssh.configs);
        let host = Self {
            trust: trust::TrustStore::load(&config_dir, &data_dir),
            proxy_password: ide_ssh::secrets::SecretFile::new(data_dir.join("proxy-password.json")),
            proxy_session_password: Mutex::default(),
            remote: Arc::new(ide_remote::RemoteService::new(ssh.clone(), data_dir.join("remote"))),
            ssh,
            environment: environment::Environment::new(project_environment, local_data_dir.clone()),
            global_settings,
            dependency_versions: Arc::new(ide_workspace::dependencies::VersionCache::new(
                data_dir.join("cache/dependency-versions"),
            )),
            // Sessions, runs and terminals report to the window that started them (`window_sink`).
            terminals: TerminalManager::new(),
            processes: ProcessManager::new(),
            debugger: ide_dap::DebugManager::new(languages.clone()),
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
            self.wait_blocking(shutdown);
        }
    }

    /// Like [`Self::close_project`], but returns once the project is detached from
    /// the window; its workers finish shutting down in the background, and
    /// [`Self::shutdown_notebooks_on_exit`] waits for them before the process exits.
    pub fn close_project_detached(&self, window: &str) {
        if let Some(shutdown) = self.begin_close(window) {
            let mut closing = self.closing.lock();
            closing.retain(|handle| !handle.is_finished());
            closing.push(shutdown);
        }
    }

    /// Detaches the project from `window` and stops what it started, synchronously,
    /// so the window can open another project at once. Returns the thread that
    /// finishes shutting down its workers.
    fn begin_close(&self, window: &str) -> Option<std::thread::JoinHandle<()>> {
        self.external_logs.write().remove(self.owner_window(window));
        for request in self.project_requests.write().remove(self.owner_window(window)).unwrap_or_default() {
            self.cancel_request(request);
        }
        let project = self.projects.write().remove(window)?;
        project.files_events_active.store(false, std::sync::atomic::Ordering::Release);
        project.plugin_diagnostics.close();
        if let Some(plugins) = plugins::editor_plugin_host() {
            plugins.invalidate_client_navigation(&project.root, Some(window), None);
            plugins.set_active_file(window, None);
        }
        if !project.light {
            self.environment.project_closed();
        }
        if let Some(bridge) = &project.kotlin_bridge {
            bridge.stop();
        }
        if let Some(phpstan) = &project.phpstan {
            phpstan.stop();
        }
        project.documents.clear_workspace_edit_history();
        project.agents.shutdown();
        project.notebooks.stop_admission();
        // What the closing window started goes with it — the builds and searches it
        // asked for, its runs, its shells and its debug sessions — and its language
        // servers shut down.
        self.processes.kill_project(&project.root);
        self.terminals.kill_key(self.owner_window(window));
        Some(self.spawn_project_shutdown(
            vec![project.notebooks.clone()],
            project.kotlin_bridge.iter().cloned().collect(),
            Some(project.lsp.clone()),
            Some((self.debugger.clone(), window.to_owned(), project.root.clone())),
            Some(project),
        ))
    }

    /// Project/window destruction must finish owned kernel cleanup, not enqueue
    /// work which can be lost as the desktop runtime exits: the returned thread is
    /// joined by the closer or, for a detached close, before exit.
    fn spawn_project_shutdown(
        &self,
        notebooks: Vec<Arc<notebook::NotebookService>>,
        bridges: Vec<Arc<kotlin_bridge::KotlinBridge>>,
        lsp: Option<Arc<ide_lsp::LspManager>>,
        debug: Option<(Arc<ide_dap::DebugManager>, String, std::path::PathBuf)>,
        retired: Option<Arc<Project>>,
    ) -> std::thread::JoinHandle<()> {
        for bridge in &bridges {
            bridge.stop();
        }
        for service in &notebooks {
            service.stop_admission();
        }
        let runtime = self.runtime.clone();
        std::thread::spawn(move || {
            // Dropping the project stops its file watcher and index worker, which first finish the
            // batch they are applying (many file events while a build writes its output), so it
            // isn't done on the closing caller's thread (the UI thread for a window close).
            let retired = retired.map(|project| std::thread::spawn(move || drop(project)));
            runtime.block_on(async move {
                for bridge in bridges {
                    bridge.shutdown().await;
                }
                for service in notebooks {
                    service.shutdown().await;
                }
                if let Some(lsp) = lsp {
                    lsp.shutdown_all().await;
                }
                if let Some((debug, key, root)) = debug {
                    debug.stop_key(&key).await;
                    debug.stop_under(&root).await;
                }
            });
            if let Some(retired) = retired {
                let _ = retired.join();
            }
        })
    }

    /// Waits for detached closes, so a project opened next never races the
    /// language servers of one still shutting down (e.g. over a shared workspace).
    pub(crate) fn wait_detached_closes(&self) {
        let pending: Vec<_> = self.closing.lock().drain(..).collect();
        for shutdown in pending {
            self.wait_blocking(shutdown);
        }
    }

    fn wait_blocking(&self, shutdown: std::thread::JoinHandle<()>) {
        let wait = move || {
            if let Err(error) = shutdown.join() {
                tracing::error!("project shutdown thread failed: {error:?}");
            }
        };
        if tokio::runtime::Handle::try_current()
            .is_ok_and(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
        {
            tokio::task::block_in_place(wait);
        } else {
            wait();
        }
    }

    /// Called before the desktop runtime exits, including update/restart exits, on
    /// the event-loop thread: waits for detached closes and the open projects'
    /// kernels, but no longer than [`EXIT_SHUTDOWN_WAIT`], so a runtime worker
    /// stuck on the event loop cannot keep the process from exiting.
    pub fn shutdown_notebooks_on_exit(&self) {
        let projects = self.projects();
        let mut pending: Vec<_> = self.closing.lock().drain(..).collect();
        pending.push(self.spawn_project_shutdown(
            projects.iter().map(|project| project.notebooks.clone()).collect(),
            projects.iter().filter_map(|project| project.kotlin_bridge.clone()).collect(),
            None,
            None,
            None,
        ));
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
    }

    /// Called before desktop exit, which may bypass document destructors.
    pub fn clear_workspace_edit_history_on_exit(&self) {
        for project in self.projects() {
            project.documents.clear_workspace_edit_history();
        }
    }

    /// Stops what this host started: notebook kernels, language servers, agents, runs and terminals.
    /// For a process that exits without dropping the host (the remote server).
    pub async fn shutdown(&self) {
        self.environment.shutdown();
        self.processes.kill_all();
        self.terminals.kill_all();
        let projects: Vec<_> = self.projects.write().drain().map(|(_, p)| p).collect();
        for project in &projects {
            project.files_events_active.store(false, std::sync::atomic::Ordering::Release);
        }
        for project in &projects {
            project.plugin_diagnostics.close();
            if let Some(bridge) = &project.kotlin_bridge {
                bridge.stop();
            }
            if let Some(phpstan) = &project.phpstan {
                phpstan.stop();
            }
            project.documents.clear_workspace_edit_history();
            project.notebooks.stop_admission();
            project.agents.shutdown();
        }
        // Kernel cleanup owns its interrupt/termination/reaping deadlines. An
        // outer LSP timeout must never abort it before owned children are reaped.
        for project in &projects {
            if let Some(bridge) = &project.kotlin_bridge {
                bridge.shutdown().await;
            }
            project.notebooks.shutdown().await;
        }
        let stop_language_servers = async {
            for project in &projects {
                project.lsp.shutdown_all().await;
            }
        };
        if tokio::time::timeout(std::time::Duration::from_secs(10), stop_language_servers).await.is_err() {
            tracing::warn!("language servers did not shut down in time");
        }
    }

    // ---- cancellable requests: the UI allocates ids, `cancel_request` cancels ----

    pub fn begin_request(&self, id: RequestId) -> CancellationToken {
        self.requests.begin(id)
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
        let host = Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
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
