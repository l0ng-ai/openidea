use crate::events::TauriSink;
use ide_core::{EventSink, IdeEvent, IdeResult, SharedSink};
use ide_language::{LanguageRegistry, Syntax};
use ide_workspace::RecentProjects;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

pub use ide_host::{Host, Project};

/// Process-wide state shared by all windows: the backend [`Host`] (reachable
/// through `Deref`) plus what only the desktop shell has.
pub struct AppState {
    pub app: AppHandle,
    pub host: Arc<Host>,
    pub startup: Startup,
    pub updates: crate::updates::Updates,
    pub recent: RecentProjects,
    /// Plugins (`ide_host::plugins`), shared by all windows.
    pub plugins: Arc<ide_host::plugins::PluginHost>,
    /// Agents › MCP Server: built-in IDE tools for agents.
    pub mcp: crate::commands::mcp::McpService,
    /// Credential prompts of `ssh` / `git` child processes (`None` if it failed to start).
    pub askpass: Option<ide_ssh::askpass::AskpassServer>,
    /// Remote development connections, by window label.
    pub remote_dev: crate::remote_dev::Connections,
    /// Broadcasts to every window.
    pub sink: SharedSink,
}

impl std::ops::Deref for AppState {
    type Target = Host;
    fn deref(&self) -> &Host {
        &self.host
    }
}

/// Start-up timings (`app_metrics`).
#[derive(Debug)]
pub struct Startup {
    /// Process start → `main` (exec, code-signature scan, dynamic loading).
    pub process_to_main: Option<Duration>,
    /// Process start → `AppState::new` (Tauri / WebView boot before our code).
    pub process_to_setup: Option<Duration>,
    /// Time spent in `AppState::new`.
    pub setup: Duration,
    /// Process start → first IPC call that reached [`AppState::note_ipc`].
    pub first_ipc: OnceLock<Duration>,
}

impl AppState {
    pub fn new(app: AppHandle, local_data_dir: std::path::PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        ide_workspace::process::mark_start();
        let process_to_main = ide_workspace::process::before_main();
        let process_to_setup = ide_workspace::process::process_age();
        let started = std::time::Instant::now();
        // Grammar set-up is not needed for the first paint: build it off the main thread.
        let syntax: Arc<OnceLock<Arc<Syntax>>> = Arc::default();
        {
            let syntax = syntax.clone();
            std::thread::Builder::new().name("openidea-syntax-init".into()).spawn(move || {
                syntax.get_or_init(|| Arc::new(Syntax::new()));
            })?;
        }
        // `OPENIDEA_CONFIG_DIR` / `OPENIDEA_DATA_DIR` move these; an unusable value fails the start.
        let config_dir = ide_host::data_dirs::config_dir(&app.config().identifier)?;
        let data_dir = ide_host::data_dirs::data_dir(&app.config().identifier)?;
        std::fs::create_dir_all(&config_dir)?;
        std::fs::create_dir_all(&data_dir)?;
        if let Err(error) = std::fs::create_dir_all(&local_data_dir) {
            tracing::warn!(?local_data_dir, %error, "cannot create local data directory");
        }
        tracing::info!(?data_dir, ?local_data_dir, "application data directories");
        // Saved git HTTPS credentials (askpass answers them silently).
        ide_ssh::git_creds::init(data_dir.join("git-credentials.json"));
        // A newly chosen local-data directory from Settings › System Settings ›
        // Caches: the previous tree moves first, so a pending invalidation still
        // wipes what was just moved.
        let identifier = app.config().identifier.clone();
        ide_host::data_dirs::apply_custom_migration(&identifier, &local_data_dir);
        // File › Invalidate Caches… requested at the last run.
        let removed = ide_workspace::caches::apply_pending(&data_dir, &local_data_dir);
        if !removed.is_empty() {
            tracing::info!("invalidated caches: {removed:?}");
        }
        ide_host::data_dirs::migrate(&data_dir, &local_data_dir);
        let global_sink: SharedSink = Arc::new(TauriSink { app: app.clone(), window: None });
        let languages = Arc::new(LanguageRegistry::load(Some(&config_dir.join("languages")))?);
        let sink_app = app.clone();
        let host = Arc::new(Host::new(ide_host::HostConfig {
            config_dir: config_dir.clone(),
            data_dir: data_dir.clone(),
            local_data_dir,
            languages: languages.clone(),
            syntax,
            sink_for: Box::new(move |window| {
                Arc::new(TauriSink { app: sink_app.clone(), window: Some(window.to_owned()) })
            }),
            owner: Self::owner_window,
            runtime: tauri::async_runtime::handle().inner().clone(),
            project_environment: false,
        }));
        Ok(Self {
            recent: RecentProjects::load(&config_dir),
            updates: Default::default(),
            askpass: start_askpass(&app),
            sink: global_sink,
            plugins: crate::commands::plugin::create_host(&app, &data_dir, &host)?,
            mcp: Default::default(),
            remote_dev: crate::remote_dev::Connections::default(),
            host,
            startup: Startup {
                process_to_main,
                process_to_setup,
                setup: started.elapsed(),
                first_ipc: OnceLock::new(),
            },
            app,
        })
    }

    /// Records the first IPC call for the start-up metric.
    pub fn note_ipc(&self) {
        self.startup.first_ipc.get_or_init(|| {
            let age = ide_workspace::process::process_age().unwrap_or_else(ide_workspace::process::uptime);
            let ms = |d: Option<Duration>| d.map_or(f64::NAN, |d| d.as_secs_f64() * 1000.0);
            tracing::info!(
                "startup: first IPC {:.0} ms after process start (main {:.0} ms, setup at {:.0} ms, took {:.1} ms)",
                age.as_secs_f64() * 1000.0,
                ms(self.startup.process_to_main),
                ms(self.startup.process_to_setup),
                self.startup.setup.as_secs_f64() * 1000.0
            );
            age
        });
    }

    /// The window that owns what `window` starts: a settings window's parent, else `window`.
    pub fn owner_window(window: &str) -> &str {
        crate::windows::auxiliary_parent(window).unwrap_or(window)
    }

    /// Opens `root` in `window` and records it in the recent projects.
    pub fn open_project(&self, window: &str, root: &Path) -> IdeResult<Arc<Project>> {
        // A local project replaces a remote one in this window.
        self.remote_dev.disconnect(window);
        let project = self.host.open_project(window, root)?;
        self.record_project(&project)?;
        Ok(project)
    }

    pub fn record_project(&self, project: &Project) -> IdeResult<()> {
        let info = ide_host::ops::project::info(project);
        let attached = info.workspace.as_ref().is_some_and(|w| !w.is_container(&project.root));
        let branch = if attached {
            None
        } else {
            project.repos.read().primary().and_then(|r| r.branch_info().ok()).and_then(|b| b.head)
        };
        self.recent.touch(&project.root, branch)?;
        self.recent.rename(&project.root, Some(&info.display_name))?;
        crate::jump_list::refresh(&self.app, self.recent.list());
        Ok(())
    }

    /// Opens `window` for editing the loose file `file` (LightEdit); not a recent project.
    pub fn open_light(&self, window: &str, file: &Path) -> IdeResult<Arc<Project>> {
        self.remote_dev.disconnect(window);
        self.host.open_light(window, file)
    }

    /// Called on the event-loop thread (window destruction, the `close_project`
    /// command), so it must not wait for the project's workers to shut down.
    pub fn close_project(&self, window: &str) {
        self.remote_dev.disconnect(window);
        self.host.close_project_detached(window);
    }
}

/// Serves askpass prompts to the focused window and routes `git`'s prompts there.
fn start_askpass(app: &AppHandle) -> Option<ide_ssh::askpass::AskpassServer> {
    let exe = std::env::current_exe().ok()?;
    let handle = app.clone();
    let on_prompt = Arc::new(move |p: ide_ssh::askpass::AskpassPrompt| {
        // A focused Settings window hands the prompt to its project window.
        let window = crate::windows::target_window(&handle).map(|w| AppState::owner_window(w.label()).to_owned());
        let remember = ide_ssh::askpass::remembers(&p.prompt);
        TauriSink { app: handle.clone(), window }.emit(IdeEvent::Askpass {
            id: p.id,
            prompt: p.prompt,
            kind: p.kind,
            remember,
        });
    });
    match ide_ssh::askpass::AskpassServer::start(exe, on_prompt) {
        Ok(server) => {
            ide_vcs::set_git_command_observer(
                ide_ssh::askpass::COMMAND_ENV,
                Arc::new(|id, success, stderr| {
                    if let Some(store) = ide_ssh::git_creds::get() {
                        store.command_finished(id, success, stderr);
                    }
                }),
            );
            ide_vcs::set_askpass_env(server.env());
            Some(server)
        }
        Err(e) => {
            tracing::warn!("askpass unavailable: {}", e.message);
            None
        }
    }
}
