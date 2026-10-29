use crate::events::TauriSink;
use ide_core::{EventSink, IdeEvent, IdeResult, SharedSink};
use ide_language::{LanguageRegistry, Syntax};
use ide_workspace::RecentProjects;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub use ide_host::{Host, Project};

/// Process-wide state shared by all windows: the backend [`Host`] (reachable
/// through `Deref`) plus what only the desktop shell has.
pub struct AppState {
    pub app: AppHandle,
    pub host: Arc<Host>,
    pub startup: Startup,
    pub recent: RecentProjects,
    /// WASM plugins (`ide-plugin`), shared by all windows.
    pub plugins: Arc<ide_plugin::PluginHost>,
    /// The built-in web server (Open In › Browser, the editor's browser bar).
    pub web: ide_web::WebServer,
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
    pub fn new(app: AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
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
        let config_dir = app.path().app_config_dir()?;
        let data_dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&config_dir)?;
        std::fs::create_dir_all(&data_dir)?;
        // File › Invalidate Caches… requested at the last run.
        let removed = ide_workspace::caches::apply_pending(&data_dir);
        if !removed.is_empty() {
            tracing::info!("invalidated caches: {removed:?}");
        }
        let global_sink: SharedSink = Arc::new(TauriSink { app: app.clone(), window: None });
        let languages = Arc::new(LanguageRegistry::load(Some(&config_dir.join("languages")))?);
        let sink_app = app.clone();
        let host = Arc::new(Host::new(ide_host::HostConfig {
            config_dir: config_dir.clone(),
            data_dir: data_dir.clone(),
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
            askpass: start_askpass(&app),
            sink: global_sink,
            plugins: crate::commands::plugin::create_host(&app, &data_dir)?,
            web: ide_web::WebServer::new(),
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
        crate::windows::settings_parent(window).unwrap_or(window)
    }

    /// Opens `root` in `window` and records it in the recent projects.
    pub fn open_project(&self, window: &str, root: &Path) -> IdeResult<Arc<Project>> {
        // A local project replaces a remote one in this window.
        self.remote_dev.disconnect(window);
        let project = self.host.open_project(window, root)?;
        let branch = project.repos.read().primary().and_then(|r| r.branch_info().ok()).and_then(|b| b.head);
        self.recent.touch(&project.root, branch)?;
        let display_name = project.settings.effective().general.project_name;
        if !display_name.trim().is_empty() {
            self.recent.rename(&project.root, Some(display_name.trim()))?;
        }
        Ok(project)
    }

    /// Opens `window` for editing the loose file `file` (LightEdit); not a recent project.
    pub fn open_light(&self, window: &str, file: &Path) -> IdeResult<Arc<Project>> {
        self.remote_dev.disconnect(window);
        self.host.open_light(window, file)
    }

    pub fn close_project(&self, window: &str) {
        self.remote_dev.disconnect(window);
        self.host.close_project(window);
    }
}

/// Serves askpass prompts to the focused window and routes `git`'s prompts there.
fn start_askpass(app: &AppHandle) -> Option<ide_ssh::askpass::AskpassServer> {
    let exe = std::env::current_exe().ok()?;
    let handle = app.clone();
    let on_prompt = Arc::new(move |p: ide_ssh::askpass::AskpassPrompt| {
        // A focused Settings window hands the prompt to its project window.
        let window = crate::windows::target_window(&handle).map(|w| AppState::owner_window(w.label()).to_owned());
        TauriSink { app: handle.clone(), window }.emit(IdeEvent::Askpass { id: p.id, prompt: p.prompt, kind: p.kind });
    });
    match ide_ssh::askpass::AskpassServer::start(exe, on_prompt) {
        Ok(server) => {
            ide_vcs::set_askpass_env(server.env());
            Some(server)
        }
        Err(e) => {
            tracing::warn!("askpass unavailable: {}", e.message);
            None
        }
    }
}
