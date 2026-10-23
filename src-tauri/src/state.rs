use crate::events::TauriSink;
use ide_core::{CancellationToken, IdeError, IdeEvent, IdeResult, RequestId, SharedSink};
use ide_dap::DebugManager;
use ide_index::ProjectIndex;
use ide_language::{LanguageRegistry, Syntax, SyntaxCache};
use ide_lsp::LspManager;
use ide_run::ProcessManager;
use ide_syntax::StructureService;
use ide_terminal::TerminalManager;
use ide_text::{AppliedChange, ByteEdit};
use ide_vcs::Repo;
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
    pub settings: Arc<SettingsStore>,
    pub documents: Arc<Documents>,
    pub history: Arc<LocalHistory>,
    /// Undo stack of file move / rename refactorings.
    pub moves: FileMoves,
    pub index: Arc<ProjectIndex>,
    pub lsp: Arc<LspManager>,
    pub repo: Mutex<Option<Repo>>,
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
    _watcher: Watcher,
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
        mark("roots");

        let languages = self.languages.clone();
        let documents = Arc::new(Documents::new(sink.clone(), Box::new(move |p: &Path| languages.detect(p, None))));
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
            excludes.clone(),
            self.languages.clone(),
            self.syntax(),
            sink.clone(),
        )?;
        mark("index");
        let lsp = LspManager::new(root.clone(), self.languages.clone(), sink.clone());
        let settings = Arc::new(settings);
        {
            let settings = settings.clone();
            let root = root.clone();
            let data_dir = self.data_dir.clone();
            lsp.set_config_hook(Box::new(move |cfg, server_root| {
                ide_sdk::apply::configure_server(cfg, &root, server_root, &settings.effective());
                if cfg.name == "jdtls" {
                    let bundles: Vec<PathBuf> =
                        ide_tools::managed_bundle(&data_dir, "java-debug").into_iter().collect();
                    let jdks = ide_sdk::java::jdtls_jdks();
                    ide_sdk::java::configure_jdtls(cfg, server_root, &data_dir, &jdks, &bundles);
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

        let watcher = {
            let index = index.clone();
            let documents = documents.clone();
            let sink = sink.clone();
            let root = root.clone();
            let detected_roots = detected_roots.clone();
            let history = history.clone();
            Watcher::start(
                &root.clone(),
                excludes,
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
                            *detected_roots.write() = fresh;
                            sink.emit(IdeEvent::ProjectRootsChanged { root: root.clone().into() });
                        }
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

        mark("watcher");
        let repo = Repo::discover(&root)?;
        let branch = repo.as_ref().and_then(|r| r.branch_info().ok()).and_then(|b| b.head);
        mark("git");
        self.recent.touch(&root, branch)?;
        mark("recent");
        tracing::info!("opened {} in window {window} in {} ms {laps:?}", root.display(), started.elapsed().as_millis());

        let db = Arc::new(ide_db::DbManager::new(root.clone(), self.data_dir.join("db-passwords.json")));
        let http_history = Arc::new(ide_http::History::new(self.data_dir.join("http-history").join(&project_key)));
        let project = Arc::new(Project {
            root,
            sink,
            settings,
            documents,
            history,
            moves: FileMoves::new(),
            index,
            lsp,
            repo: Mutex::new(repo),
            structure: Arc::new(StructureService::new(syntax.clone())),
            syntax,
            detected_roots,
            cache_dir: self.data_dir.join("cache").join(&project_key),
            db,
            http_history,
            _watcher: watcher,
            _scratch_watcher: scratch_watcher,
        });
        self.projects.write().insert(window.to_owned(), project.clone());
        Ok(project)
    }

    pub fn close_project(&self, window: &str) {
        if let Some(project) = self.projects.write().remove(window) {
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

impl Project {
    /// Runs `f` with the git repository, or fails when the project is not under git.
    pub fn with_repo<T>(&self, f: impl FnOnce(&Repo) -> IdeResult<T>) -> IdeResult<T> {
        crate::commands::vcs::apply_git_executable(&self.settings.effective());
        match self.repo.lock().as_ref() {
            Some(repo) => f(repo),
            None => Err(IdeError::unavailable("project is not a git repository")),
        }
    }

    /// Runs a VCS operation that rewrites the working tree (checkout, merge,
    /// rebase, pull, reset, stash, rollback): Local History gets a label and a
    /// snapshot of every locally changed file before, and a label after.
    /// `None` runs `f` like [`with_repo`](Self::with_repo) (operations that keep the working tree).
    pub fn with_repo_recorded<T>(
        &self,
        operation: Option<&str>,
        f: impl FnOnce(&Repo) -> IdeResult<T>,
    ) -> IdeResult<T> {
        let Some(name) = operation else { return self.with_repo(f) };
        self.history_label(&format!("Before {name}"));
        if let Ok(changed) = self.with_repo(|r| r.status()) {
            for file in changed.iter().take(HISTORY_BATCH_LIMIT) {
                if let Err(e) = self.history.record_file(&file.path, &format!("Before {name}"), false) {
                    tracing::debug!("local history: {e}");
                }
            }
        }
        let result = self.with_repo(f);
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

    /// `files.exclude` plus the effective excluded roots (user-marked and detected).
    pub fn exclude_globs(&self) -> Vec<String> {
        exclude_globs(&self.settings.effective(), &self.detected_roots.read())
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

fn exclude_globs(settings: &ide_core::settings::Settings, detected: &[SourceFolder]) -> Vec<String> {
    let mut globs = settings.files.exclude.clone();
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
