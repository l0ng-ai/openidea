use crate::events::TauriSink;
use ide_core::{CancellationToken, IdeError, IdeEvent, IdeResult, RequestId, SharedSink};
use ide_dap::DebugManager;
use ide_index::ProjectIndex;
use ide_language::{FileTypes, LanguageRegistry, Syntax, SyntaxCache};
use ide_lsp::LspManager;
use ide_run::ProcessManager;
use ide_syntax::StructureService;
use ide_terminal::TerminalManager;
use ide_text::{AppliedChange, ByteEdit};
use ide_vcs::{Repo, Repos};
use ide_vfs::Watcher;
use ide_workspace::documents::DocumentObserver;
use ide_workspace::{
    DocumentInfo, Documents, FileMoves, LocalHistory, ProjectRoots, RecentProjects, SettingsStore, SourceFolder,
};
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Process-wide state shared by all windows.
pub struct AppState {
    pub app: AppHandle,
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub languages: Arc<LanguageRegistry>,
    /// Built on a background thread at start-up; see [`AppState::syntax`].
    syntax: Arc<OnceLock<Arc<Syntax>>>,
    pub startup: Startup,
    pub recent: RecentProjects,
    pub global_settings: SettingsStore,
    pub terminals: TerminalManager,
    pub processes: ProcessManager,
    pub debugger: Arc<DebugManager>,
    /// WASM plugins (`ide-plugin`), shared by all windows.
    pub plugins: Arc<ide_plugin::PluginHost>,
    /// The built-in web server (Open In › Browser, the editor's browser bar).
    pub web: ide_web::WebServer,
    /// Broadcasts to every window.
    pub sink: SharedSink,
    /// One project per window, keyed by window label.
    projects: RwLock<HashMap<String, Arc<Project>>>,
    requests: Mutex<HashMap<RequestId, CancellationToken>>,
}

/// Everything bound to one open project folder.
pub struct Project {
    pub root: PathBuf,
    /// Window-scoped event sink, for commands that emit project events.
    pub sink: SharedSink,
    /// The app's language definitions with this project's File Types applied.
    pub languages: Arc<LanguageRegistry>,
    pub settings: Arc<SettingsStore>,
    pub documents: Arc<Documents>,
    pub history: Arc<LocalHistory>,
    /// Undo stack of file move / rename refactorings.
    pub moves: FileMoves,
    pub index: Arc<ProjectIndex>,
    pub lsp: Arc<LspManager>,
    /// Git repositories: the one containing the project root and those nested below it.
    pub repos: Arc<RwLock<Repos>>,
    /// Incrementally maintained syntax trees of the open documents.
    pub syntax: Arc<SyntaxCache>,
    /// Tree-sitter structure queries (LSP fallback) over `syntax`.
    pub structure: Arc<StructureService>,
    /// Roots auto-detected from build files; see [`Project::roots`].
    pub detected_roots: Arc<RwLock<Vec<SourceFolder>>>,
    /// Per-project cache directory (build tool sync results…).
    pub cache_dir: PathBuf,
    /// Database tool window: data sources and their connections.
    pub db: Arc<ide_db::DbManager>,
    /// HTTP Client responses (IDEA's `.idea/httpRequests`), in the app data dir.
    pub http_history: Arc<ide_http::History>,
    /// Coding agent tasks (Agents tool window).
    pub agents: Arc<ide_agent::AgentManager>,
    watcher: Watcher,
    /// Watchers of the Project Structure content roots outside the project folder.
    content_watchers: Mutex<Vec<(PathBuf, Watcher)>>,
    _scratch_watcher: Option<Watcher>,
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
        Ok(Self {
            recent: RecentProjects::load(&config_dir),
            global_settings: SettingsStore::load(&config_dir, None),
            // Sessions, runs and terminals report to the window that started them (`window_sink`).
            terminals: TerminalManager::new(),
            processes: ProcessManager::new(),
            debugger: DebugManager::new(languages.clone()),
            sink: global_sink,
            plugins: crate::commands::plugin::create_host(&app, &data_dir)?,
            web: ide_web::WebServer::new(),
            syntax,
            startup: Startup {
                process_to_main,
                process_to_setup,
                setup: started.elapsed(),
                first_ipc: OnceLock::new(),
            },
            languages,
            config_dir,
            data_dir,
            app,
            projects: RwLock::default(),
            requests: Mutex::default(),
        })
    }

    /// The tree-sitter grammars (blocks only if start-up warm-up is still running).
    pub fn syntax(&self) -> Arc<Syntax> {
        self.syntax.get_or_init(|| Arc::new(Syntax::new())).clone()
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

    /// Every open project (all windows).
    pub fn projects(&self) -> Vec<Arc<Project>> {
        self.projects.read().values().cloned().collect()
    }

    /// The project of `window`. A settings window (`settings-<parent>`) shares
    /// its parent window's project.
    pub fn project(&self, window: &str) -> IdeResult<Arc<Project>> {
        let window = Self::owner_window(window);
        self.projects
            .read()
            .get(window)
            .cloned()
            .ok_or_else(|| IdeError::not_found("no project is open in this window"))
    }

    /// The window that owns what `window` starts: a settings window's parent, else `window`.
    pub fn owner_window(window: &str) -> &str {
        crate::windows::settings_parent(window).unwrap_or(window)
    }

    /// Event sink for things `window` starts (debug sessions, runs, terminals): its
    /// project's window-scoped sink, or a sink for that window when no project is open.
    pub fn window_sink(&self, window: &str) -> SharedSink {
        match self.project(window) {
            Ok(p) => p.sink.clone(),
            Err(_) => {
                Arc::new(TauriSink { app: self.app.clone(), window: Some(Self::owner_window(window).to_owned()) })
            }
        }
    }

    pub fn open_project(&self, window: &str, root: &Path) -> IdeResult<Arc<Project>> {
        let started = std::time::Instant::now();
        let mut lap = started;
        let mut laps: Vec<(&str, u128)> = Vec::new();
        let mut mark = |name: &'static str| {
            laps.push((name, lap.elapsed().as_millis()));
            lap = std::time::Instant::now();
        };
        let root = dunce::canonicalize(root)?;
        // The window reloaded (or asked again) for the project it already has: keep
        // it, with its warm index, language servers and unsaved documents.
        if let Ok(current) = self.project(window)
            && current.root == root
        {
            return Ok(current);
        }
        self.close_project(window);
        let sink: SharedSink = Arc::new(TauriSink { app: self.app.clone(), window: Some(window.to_owned()) });
        let settings = SettingsStore::load(&self.config_dir, Some(&root));
        let detected_roots = Arc::new(RwLock::new(ide_workspace::roots::detect(&root)));
        let excludes = exclude_globs(&settings.effective(), &detected_roots.read());
        let extra_roots = content_roots(&settings.effective(), &root);
        mark("roots");

        // The project's own registry: File Types associations may be project-scoped.
        let languages = Arc::new(self.languages.fork());
        languages.set_file_types(FileTypes::from_settings(&settings.effective().files, Some(&root)));
        let documents = {
            let languages = languages.clone();
            Arc::new(Documents::new(
                sink.clone(),
                Box::new(move |p: &Path, first: Option<&str>| languages.detect(p, first)),
            ))
        };
        documents.set_file_defaults(ide_workspace::FileDefaults::from_settings(&settings.effective(), Some(&root)));
        let history = Arc::new(LocalHistory::open(&self.data_dir.join("history"), &root)?);
        {
            let history = history.clone();
            let retention = history_retention(&settings.effective());
            std::thread::Builder::new().name("openidea-history-prune".into()).spawn(move || {
                if let Err(e) = history.apply_retention(retention) {
                    tracing::warn!("local history: {e}");
                }
            })?;
        }
        let project_key = project_key(&root);
        let index = ProjectIndex::open(
            &root,
            &self.data_dir.join("index").join(&project_key),
            extra_roots.clone(),
            excludes.clone(),
            languages.clone(),
            self.syntax(),
            sink.clone(),
        )?;
        mark("index");
        let lsp = LspManager::new(root.clone(), languages.clone(), sink.clone());
        let settings = Arc::new(settings);
        {
            let settings = settings.clone();
            let root = root.clone();
            let data_dir = self.data_dir.clone();
            lsp.set_config_hook(Box::new(move |cfg, server_root| {
                let effective = settings.effective();
                ide_sdk::apply::configure_server(cfg, &root, server_root, &effective);
                if cfg.name == "jdtls" {
                    let bundles: Vec<PathBuf> =
                        ide_tools::managed_bundle(&data_dir, "java-debug").into_iter().collect();
                    let min_java = ide_sdk::java::jdtls_min_java(cfg);
                    let jdks = ide_sdk::java::jdtls_jdks(min_java);
                    let lombok = ide_sdk::lombok::lombok_agent(
                        server_root,
                        ide_sdk::lombok::agent_in_args(cfg.args.iter().map(String::as_str)),
                        ide_tools::managed_bundle(&data_dir, "lombok"),
                        ide_sdk::apply::maven_local_repository(&root, &effective),
                    );
                    if let Some(problem) = lombok.problem() {
                        tracing::warn!("{problem}");
                    }
                    let server_jdk = ide_sdk::apply::jdtls_jdk(&root, &effective).unwrap_or_else(|e| {
                        cfg.launch_error = Some(e);
                        None
                    });
                    ide_sdk::java::configure_jdtls(
                        cfg,
                        server_root,
                        &data_dir,
                        &jdks,
                        ide_sdk::apply::project_jdk(&root, &effective).as_ref(),
                        server_jdk.as_ref(),
                        min_java,
                        &bundles,
                        lombok.jar(),
                    );
                }
            }));
        }
        {
            let documents = documents.clone();
            lsp.set_apply_edit_hook(Box::new(move |edit| apply_workspace_edit(&documents, &edit).is_ok()));
        }
        let syntax = Arc::new(SyntaxCache::new(self.syntax()));
        documents.add_observer(Arc::new(SyntaxObserver(syntax.clone())));
        documents.add_observer(Arc::new(LspObserver(lsp.clone())));
        documents.add_observer(Arc::new(HistoryObserver(history.clone())));

        let repos = Arc::new(RwLock::new(Repos::enclosing(&root)?));
        let watcher = {
            let repos = repos.clone();
            let settings = settings.clone();
            let index = index.clone();
            let documents = documents.clone();
            let sink = sink.clone();
            let root = root.clone();
            let detected_roots = detected_roots.clone();
            let history = history.clone();
            Watcher::start(
                &root.clone(),
                excludes.clone(),
                sink.clone(),
                Box::new(move |batch| {
                    let changed: Vec<PathBuf> = batch.created.iter().chain(&batch.modified).cloned().collect();
                    index.update(&changed, &batch.removed);
                    // Atomic saves by external tools surface as `created`.
                    documents.on_disk_changed(&changed);
                    record_external_changes(&history, &changed, &batch.removed);
                    // Build files / conventional folders changed: re-detect roots.
                    let touched = changed.iter().chain(&batch.removed).filter_map(|p| p.strip_prefix(&root).ok());
                    if touched.into_iter().any(ide_workspace::roots::affects_roots) {
                        let fresh = ide_workspace::roots::detect(&root);
                        if *detected_roots.read() != fresh {
                            // Detected excluded folders (`target`, `build`) leave the index too.
                            let effective = settings.effective();
                            index.set_scope(content_roots(&effective, &root), exclude_globs(&effective, &fresh));
                            *detected_roots.write() = fresh;
                            sink.emit(IdeEvent::ProjectRootsChanged { root: root.clone().into() });
                        }
                    }
                    // A repository was cloned / initialised / removed below the project: its
                    // `.git/HEAD` (the watcher reports nothing else of `.git`) appeared or went.
                    let known = repos.read().roots();
                    let git_dirs = changed.iter().chain(&batch.removed).any(|p| {
                        let Some(dir) = p.ends_with(".git/HEAD").then(|| p.parent().and_then(Path::parent)).flatten()
                        else {
                            return false;
                        };
                        known.iter().any(|r| r == dir) != p.is_file()
                    });
                    if git_dirs {
                        scan_repositories(&root, &repos, &settings, &sink);
                    }
                    sink.emit(IdeEvent::VcsChanged { root: root.clone().into() });
                }),
            )?
        };

        // Scratch files live outside the project; watch them too so the
        // Project view and open editors follow changes made there.
        let scratch_watcher = {
            let dir = self.data_dir.join("scratches");
            let documents = documents.clone();
            std::fs::create_dir_all(&dir).ok().and_then(|()| {
                Watcher::start(
                    &dir,
                    Vec::new(),
                    sink.clone(),
                    Box::new(move |batch| {
                        let changed: Vec<PathBuf> = batch.created.iter().chain(&batch.modified).cloned().collect();
                        documents.on_disk_changed(&changed);
                    }),
                )
                .map_err(|e| tracing::warn!("scratches watcher: {e}"))
                .ok()
            })
        };

        let content_watchers = extra_roots
            .iter()
            .filter_map(|r| {
                let w = content_root_watcher(r, &excludes, &sink, &index, &documents, &history)?;
                Some((r.clone(), w))
            })
            .collect();
        mark("watcher");
        let branch = repos.read().primary().and_then(|r| r.branch_info().ok()).and_then(|b| b.head);
        {
            let (root, repos, settings, sink) = (root.clone(), repos.clone(), settings.clone(), sink.clone());
            std::thread::Builder::new()
                .name("openidea-vcs-roots".into())
                .spawn(move || scan_repositories(&root, &repos, &settings, &sink))?;
        }
        mark("git");
        self.recent.touch(&root, branch)?;
        let display_name = settings.effective().general.project_name;
        if !display_name.trim().is_empty() {
            self.recent.rename(&root, Some(display_name.trim()))?;
        }
        mark("recent");
        tracing::info!("opened {} in window {window} in {} ms {laps:?}", root.display(), started.elapsed().as_millis());

        let db = Arc::new(ide_db::DbManager::new(
            root.clone(),
            self.data_dir.join("db-passwords.json"),
            self.data_dir.join("db-history.json"),
        ));
        let http_history = Arc::new(ide_http::History::new(self.data_dir.join("http-history").join(&project_key)));
        let agents = Arc::new(ide_agent::AgentManager::new(
            ide_agent::AgentPaths {
                project_root: root.clone(),
                store_dir: self.data_dir.join("agents").join(&project_key),
                // Outside the app data dir: its path has spaces on macOS, which trips up build scripts.
                worktrees_dir: dirs::home_dir()
                    .unwrap_or_else(|| self.data_dir.clone())
                    .join(".openidea")
                    .join("worktrees")
                    .join(&project_key),
                models_file: self.data_dir.join("agents").join("models.json"),
                custom_agents_dir: Some(self.config_dir.join("agents")),
            },
            tauri::async_runtime::handle().inner().clone(),
        ));
        let project = Arc::new(Project {
            root,
            sink,
            languages,
            settings,
            documents,
            history,
            moves: FileMoves::new(),
            index,
            lsp,
            repos,
            structure: Arc::new(StructureService::new(syntax.clone())),
            syntax,
            detected_roots,
            cache_dir: self.data_dir.join("cache").join(&project_key),
            db,
            http_history,
            agents,
            watcher,
            content_watchers: Mutex::new(content_watchers),
            _scratch_watcher: scratch_watcher,
        });
        self.projects.write().insert(window.to_owned(), project.clone());
        Ok(project)
    }

    pub fn close_project(&self, window: &str) {
        if let Some(project) = self.projects.write().remove(window) {
            project.agents.shutdown();
            let lsp = project.lsp.clone();
            tauri::async_runtime::spawn(async move { lsp.shutdown_all().await });
        }
    }

    // ---- cancellable requests: the UI allocates ids, `cancel_request` cancels ----

    pub fn begin_request(&self, id: RequestId) -> CancellationToken {
        let token = CancellationToken::new();
        if let Some(old) = self.requests.lock().insert(id, token.clone()) {
            old.cancel();
        }
        token
    }

    pub fn end_request(&self, id: RequestId) {
        self.requests.lock().remove(&id);
    }

    pub fn cancel_request(&self, id: RequestId) {
        if let Some(token) = self.requests.lock().remove(&id) {
            token.cancel();
        }
    }
}

/// Looks for repositories nested below the project (and the one containing it);
/// emits `VcsChanged` when the set of roots changed.
fn scan_repositories(root: &Path, repos: &RwLock<Repos>, settings: &SettingsStore, sink: &SharedSink) {
    let ignored = settings.effective().ignored_names();
    let skip = |p: &Path| p.file_name().is_some_and(|n| ignored.is_ignored_name(&n.to_string_lossy()));
    match Repos::discover(root, &skip) {
        Ok(found) => {
            if found.roots() != repos.read().roots() {
                *repos.write() = found;
                sink.emit(IdeEvent::VcsChanged { root: root.to_path_buf().into() });
            }
        }
        Err(e) => tracing::warn!("looking for git repositories: {e}"),
    }
}

impl Project {
    /// The project's git repositories.
    pub fn repos(&self) -> Repos {
        self.repos.read().clone()
    }

    /// Runs `f` with the repository whose root is `at`, the project's primary repository
    /// when `None`; fails when there is none (a repository-scoped command never falls back
    /// to another repository).
    pub fn with_repo_at<T>(&self, at: Option<&Path>, f: impl FnOnce(&Repo) -> IdeResult<T>) -> IdeResult<T> {
        let repos = self.repos();
        match at {
            Some(root) => match repos.at_root(root) {
                Some(repo) => self.run_in(repo, f),
                None => {
                    Err(IdeError::unavailable(format!("{} is not a git repository of the project", root.display())))
                }
            },
            None => match repos.primary() {
                Some(repo) => self.run_in(repo, f),
                None => Err(IdeError::unavailable("project is not a git repository")),
            },
        }
    }

    /// Runs `f` with the repository `path` (a file or folder) belongs to.
    pub fn with_repo_of<T>(&self, path: &Path, f: impl FnOnce(&Repo) -> IdeResult<T>) -> IdeResult<T> {
        match self.repos().for_path(path) {
            Some(repo) => self.run_in(repo, f),
            None => Err(IdeError::unavailable(format!("{} is not in a git repository", path.display()))),
        }
    }

    fn run_in<T>(&self, repo: &Repo, f: impl FnOnce(&Repo) -> IdeResult<T>) -> IdeResult<T> {
        let settings = self.settings.effective();
        crate::commands::vcs::apply_git_executable(&settings);
        repo.set_ignored_names(settings.ignored_names());
        f(repo)
    }

    /// Runs `f` with the project's primary git repository, or fails when the project is not under git.
    pub fn with_repo<T>(&self, f: impl FnOnce(&Repo) -> IdeResult<T>) -> IdeResult<T> {
        self.with_repo_at(None, f)
    }

    /// Runs a VCS operation that rewrites the working tree (checkout, merge,
    /// rebase, pull, reset, stash, rollback): Local History gets a label and a
    /// snapshot of every locally changed file before, and a label after.
    /// `None` runs `f` like [`with_repo`](Self::with_repo) (operations that keep the working tree).
    pub fn with_repo_recorded<T>(
        &self,
        at: Option<&Path>,
        operation: Option<&str>,
        f: impl FnOnce(&Repo) -> IdeResult<T>,
    ) -> IdeResult<T> {
        let Some(name) = operation else { return self.with_repo_at(at, f) };
        self.history_label(&format!("Before {name}"));
        if let Ok(changed) = self.with_repo_at(at, |r| r.status()) {
            for file in changed.iter().take(HISTORY_BATCH_LIMIT) {
                if let Err(e) = self.history.record_file(&file.path, &format!("Before {name}"), false) {
                    tracing::debug!("local history: {e}");
                }
            }
        }
        let result = self.with_repo_at(at, f);
        self.history_label(&format!("After {name}"));
        result
    }

    fn history_label(&self, label: &str) {
        if let Err(e) = self.history.put_label(&self.root, label) {
            tracing::warn!("local history: {e}");
        }
    }

    /// Local History snapshots of `paths` before a refactoring changes them.
    pub fn record_before_refactoring(&self, paths: &[&Path], name: &str) {
        let label = format!("Before refactoring: {name}");
        for path in paths {
            let result = match self.documents.text_of(path) {
                Some(text) => self.history.record_event(path, &text, &label),
                None => self.history.record_file(path, &label, true).map(|_| ()),
            };
            if let Err(e) = result {
                tracing::debug!("local history: {e}");
            }
        }
    }

    /// Effective source / test / resource / excluded roots (detected + Project Structure marks).
    pub fn roots(&self) -> ProjectRoots {
        ProjectRoots::compute(self.detected_roots.read().clone(), &self.settings.effective().project_structure)
    }

    /// Where the Maven / Gradle tool windows cache what the build tools reported.
    pub fn build_cache_dir(&self) -> PathBuf {
        self.cache_dir.join("build")
    }

    /// File masks (`ide_search::FileMask`) for Find in Files and inspections: the
    /// excluded roots, the ignored names and the "Exclude files" patterns (files,
    /// and everything under such folders).
    pub fn search_excludes(&self) -> Vec<String> {
        let mut out: Vec<String> =
            self.roots().excluded_globs().iter().map(|d| format!("{}/**", d.trim_start_matches('/'))).collect();
        let settings = self.settings.effective();
        let names =
            settings.files.ignored_names.iter().cloned().chain(settings.project_structure.exclude_file_patterns());
        for name in names {
            let name = name.trim();
            if !name.is_empty() && !name.contains(['/', ',']) {
                out.push(name.to_owned());
                out.push(format!("**/{name}/**"));
            }
        }
        out
    }

    /// `files.exclude`, the ignored names and the effective excluded roots (user-marked and detected).
    pub fn exclude_globs(&self) -> Vec<String> {
        exclude_globs(&self.settings.effective(), &self.detected_roots.read())
    }

    /// Project Structure content roots besides the project folder (existing directories).
    pub fn content_roots(&self) -> Vec<PathBuf> {
        content_roots(&self.settings.effective(), &self.root)
    }

    /// Applies Settings › File Types; open documents whose language changed are
    /// re-detected (language servers and syntax trees follow) and the index
    /// re-parses the files whose language changed.
    pub fn apply_file_types(&self, settings: &ide_core::settings::Settings) {
        let before = Arc::new(self.languages.snapshot());
        if self.languages.set_file_types(FileTypes::from_settings(&settings.files, Some(&self.root))) {
            self.documents.redetect_languages();
            self.index.languages_changed(before);
        }
    }

    /// Applies changed content roots and exclude settings to the index (which
    /// rescans in the background) and the file watchers, without reopening the project.
    pub fn refresh_index_scope(&self) {
        let (roots, excludes) = (self.content_roots(), self.exclude_globs());
        self.index.set_scope(roots.clone(), excludes.clone());
        self.watcher.set_excludes(&excludes);
        let mut watchers = self.content_watchers.lock();
        watchers.retain(|(p, _)| roots.contains(p));
        for (_, w) in watchers.iter() {
            w.set_excludes(&excludes);
        }
        for r in roots {
            if watchers.iter().any(|(p, _)| *p == r) {
                continue;
            }
            if let Some(w) =
                content_root_watcher(&r, &excludes, &self.sink, &self.index, &self.documents, &self.history)
            {
                watchers.push((r, w));
            }
        }
    }

    /// Current text of `path`: the open buffer when available, else the file on disk.
    pub fn text_of(&self, path: &Path) -> IdeResult<String> {
        match self.documents.text_of(path) {
            Some(text) => Ok(text),
            None => Ok(ide_vfs::load_text(path)?.text),
        }
    }
}

/// Applies a multi-file edit through the document layer so open editors update live.
pub fn apply_workspace_edit(documents: &Documents, edit: &ide_core::WorkspaceEdit) -> IdeResult<()> {
    use ide_core::FileEdit;
    for file in &edit.files {
        match file {
            FileEdit::Edit { path, edits } => {
                // Files not open in an editor are opened transiently and closed again.
                let (doc, transient) = match documents.by_path(path) {
                    Some(doc) => (doc, false),
                    None => (documents.open(path)?.id, true),
                };
                let result = documents.apply_edits(doc, edits).and_then(|_| documents.save(doc));
                if transient {
                    documents.close(doc);
                }
                result?;
            }
            FileEdit::Create { path, overwrite } => {
                if path.exists() {
                    if *overwrite {
                        ide_vfs::save_text(path, "", "utf-8", false)?;
                    }
                } else {
                    ide_vfs::create_file(path)?;
                }
            }
            FileEdit::Rename { from, to } => ide_vfs::rename(from, to)?,
            FileEdit::Delete { path, .. } => ide_vfs::delete(path)?,
        }
    }
    Ok(())
}

/// Files the watcher reports per batch that Local History snapshots.
const HISTORY_BATCH_LIMIT: usize = 500;

/// Local History for changes made outside the IDE (other tools, VCS, deletions).
/// Contents equal to the last snapshot (e.g. the IDE's own saves) are skipped.
fn record_external_changes(history: &LocalHistory, changed: &[PathBuf], removed: &[PathBuf]) {
    for path in changed.iter().take(HISTORY_BATCH_LIMIT) {
        if let Err(e) = history.record_file(path, "External change", false) {
            tracing::debug!("local history: {e}");
        }
    }
    if !removed.is_empty()
        && let Err(e) = history.note_removed(removed)
    {
        tracing::debug!("local history: {e}");
    }
}

pub fn history_retention(settings: &ide_core::settings::Settings) -> ide_workspace::Retention {
    ide_workspace::Retention {
        working_days: settings.files.local_history_days,
        max_bytes: u64::from(settings.files.local_history_max_mb.max(1)) * 1024 * 1024,
    }
}

/// Project Structure content roots outside `root` (existing absolute directories).
fn content_roots(settings: &ide_core::settings::Settings, root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for r in &settings.project_structure.content_roots {
        let p = PathBuf::from(r.trim());
        if p.is_absolute() && p.is_dir() && !p.starts_with(root) && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// Watches a content root outside the project: the index, open documents and
/// Local History follow its changes like the project folder's.
fn content_root_watcher(
    dir: &Path,
    excludes: &[String],
    sink: &SharedSink,
    index: &Arc<ProjectIndex>,
    documents: &Arc<Documents>,
    history: &Arc<LocalHistory>,
) -> Option<Watcher> {
    let (index, documents, history) = (index.clone(), documents.clone(), history.clone());
    Watcher::start(
        dir,
        excludes.to_vec(),
        sink.clone(),
        Box::new(move |batch| {
            let changed: Vec<PathBuf> = batch.created.iter().chain(&batch.modified).cloned().collect();
            index.update(&changed, &batch.removed);
            documents.on_disk_changed(&changed);
            record_external_changes(&history, &changed, &batch.removed);
        }),
    )
    .map_err(|e| tracing::warn!("content root watcher {}: {e}", dir.display()))
    .ok()
}

fn exclude_globs(settings: &ide_core::settings::Settings, detected: &[SourceFolder]) -> Vec<String> {
    let mut globs = settings.file_excludes();
    globs.extend(ProjectRoots::compute(detected.to_vec(), &settings.project_structure).excluded_globs());
    globs
}

fn project_key(root: &Path) -> String {
    // Stable FNV-1a directory name per project for caches.
    let s = root.to_string_lossy();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

struct LspObserver(Arc<LspManager>);

impl DocumentObserver for LspObserver {
    fn opened(&self, info: &DocumentInfo) {
        // Language servers choke on huge files (IDEA disables code insight too);
        // changes to documents never opened on a server are ignored.
        if info.large {
            return;
        }
        match &info.uri {
            Some(uri) => self.0.did_open_virtual(info.id, uri, &info.language, info.version, &info.text),
            None => self.0.did_open(info.id, &info.path, &info.language, info.version, &info.text),
        }
    }
    fn changed(
        &self,
        doc: ide_core::DocId,
        _path: &Path,
        version: u32,
        changes: &[AppliedChange],
        full_text: &dyn Fn() -> String,
    ) {
        self.0.did_change(doc, version, changes, full_text);
    }
    fn saved(&self, doc: ide_core::DocId, _path: &Path, text: &str) {
        self.0.did_save(doc, text);
    }
    fn closed(&self, doc: ide_core::DocId, _path: &Path) {
        self.0.did_close(doc);
    }
}

/// Feeds document edits into the per-project syntax tree cache.
struct SyntaxObserver(Arc<SyntaxCache>);

impl DocumentObserver for SyntaxObserver {
    fn opened(&self, info: &DocumentInfo) {
        if !info.large {
            self.0.open(info.id, &info.language, info.version);
        }
    }
    fn edited(&self, doc: ide_core::DocId, version: u32, edits: &[ByteEdit]) {
        self.0.edit(doc, version, edits);
    }
    fn closed(&self, doc: ide_core::DocId, _path: &Path) {
        self.0.close(doc);
    }
}

struct HistoryObserver(Arc<LocalHistory>);

impl DocumentObserver for HistoryObserver {
    fn saved(&self, _doc: ide_core::DocId, path: &Path, text: &str) {
        if let Err(e) = self.0.record(path, text, "Saved") {
            tracing::warn!("local history: {e}");
        }
    }
}
