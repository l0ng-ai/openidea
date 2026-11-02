//! The IDE backend without a UI toolkit: open projects per window, terminals,
//! processes, settings and the remote services. The desktop shell (`src-tauri`)
//! wraps one [`Host`] and adds windows, menus and plugins; `openidea-server`
//! runs one on a remote machine and serves it over JSON-RPC ([`rpc`]).

pub mod data_dirs;
pub mod environment;
mod formatter;
mod java_runtime;
mod kotlin_bridge;
pub mod notebook;
pub mod ops;
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
use parking_lot::RwLock;
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
    pub(crate) sink_for: SinkFactory,
    owner: fn(&str) -> &str,
    pub runtime: tokio::runtime::Handle,
    /// One project per window, keyed by window label.
    projects: RwLock<HashMap<String, Arc<Project>>>,
    requests: requests::Requests,
    project_requests: RwLock<HashMap<String, Vec<RequestId>>>,
}

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
            requests: Default::default(),
            project_requests: RwLock::default(),
        };
        host.apply_proxy();
        host
    }

    /// The tree-sitter grammars (blocks only if start-up warm-up is still running).
    pub fn syntax(&self) -> Arc<Syntax> {
        self.syntax.get_or_init(|| Arc::new(Syntax::new())).clone()
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

    pub fn close_project(&self, window: &str) {
        let project = self.projects.write().remove(window);
        if let Some(project) = project {
            if !project.light {
                self.environment.project_closed();
            }
            if let Some(bridge) = &project.kotlin_bridge {
                bridge.stop();
            }
            project.agents.shutdown();
            project.notebooks.stop_admission();
            self.shutdown_project_workers_blocking(
                vec![project.notebooks.clone()],
                project.kotlin_bridge.iter().cloned().collect(),
            );
            let lsp = project.lsp.clone();
            self.runtime.spawn(async move { lsp.shutdown_all().await });
        }
    }

    /// Synchronous project/window destruction must finish owned kernel cleanup,
    /// not enqueue work which can be lost as the desktop runtime exits.
    fn shutdown_project_workers_blocking(
        &self,
        notebooks: Vec<Arc<notebook::NotebookService>>,
        bridges: Vec<Arc<kotlin_bridge::KotlinBridge>>,
    ) {
        for bridge in &bridges {
            bridge.stop();
        }
        for service in &notebooks {
            service.stop_admission();
        }
        let runtime = self.runtime.clone();
        let wait = move || {
            let worker = std::thread::spawn(move || {
                runtime.block_on(async move {
                    for bridge in bridges {
                        bridge.shutdown().await;
                    }
                    for service in notebooks {
                        service.shutdown().await;
                    }
                });
            });
            if let Err(error) = worker.join() {
                tracing::error!("notebook shutdown thread failed: {error:?}");
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

    /// Called before the desktop runtime exits, including update/restart exits.
    pub fn shutdown_notebooks_on_exit(&self) {
        let projects = self.projects();
        self.shutdown_project_workers_blocking(
            projects.iter().map(|project| project.notebooks.clone()).collect(),
            projects.iter().filter_map(|project| project.kotlin_bridge.clone()).collect(),
        );
    }

    /// Stops what this host started: notebook kernels, language servers, agents, runs and terminals.
    /// For a process that exits without dropping the host (the remote server).
    pub async fn shutdown(&self) {
        self.environment.shutdown();
        self.processes.kill_all();
        self.terminals.kill_all();
        let projects: Vec<_> = self.projects.write().drain().map(|(_, p)| p).collect();
        for project in &projects {
            if let Some(bridge) = &project.kotlin_bridge {
                bridge.stop();
            }
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
        let token = self.begin_request(id);
        self.project_requests.write().entry(self.owner_window(window).to_owned()).or_default().push(id);
        if self.project(window).is_ok_and(|p| !p.is_trusted()) {
            token.cancel();
        }
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

    pub(crate) fn insert_project(&self, window: &str, project: Arc<Project>) {
        self.projects.write().insert(window.to_owned(), project);
    }
}
