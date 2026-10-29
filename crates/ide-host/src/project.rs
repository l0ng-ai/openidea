//! One open project folder: documents, index, language servers, repositories,
//! watchers and the per-project services, opened by [`crate::Host::open_project`].

use crate::Host;
use ide_core::{CancellationToken, IdeError, IdeEvent, IdeResult, SharedSink};
use ide_index::ProjectIndex;
use ide_language::{FileTypes, LanguageRegistry, SyntaxCache};
use ide_lsp::LspManager;
use ide_syntax::StructureService;
use ide_text::{AppliedChange, ByteEdit};
use ide_vcs::{Repo, Repos};
use ide_vfs::Watcher;
use ide_workspace::documents::DocumentObserver;
use ide_workspace::{DocumentInfo, Documents, FileMoves, LocalHistory, ProjectRoots, SettingsStore, SourceFolder};
use parking_lot::{Mutex, RwLock};
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
    /// Native notebooks and owned kernels, scoped to this project incarnation.
    pub notebooks: Arc<crate::notebook::NotebookService>,
    pub(crate) watcher: Watcher,
    /// Watchers of the Project Structure content roots outside the project folder.
    pub(crate) content_watchers: Mutex<Vec<(PathBuf, Watcher)>>,
    pub(crate) _scratch_watcher: Option<Watcher>,
    /// A LightEdit window's loose files ([`Host::open_light`]): global settings only,
    /// nothing indexed, no language servers, repositories or project services.
    pub light: bool,
}

impl Host {
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
            && !current.light
        {
            return Ok(current);
        }
        self.close_project(window);
        let sink: SharedSink = (self.sink_for)(window);
        // Before anything the project starts: its children get the project's environment.
        let post_start = self.environment.project_opened(&root, &sink);
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
                ide_sdk::apply::server_launch_overrides(cfg, &effective);
                ide_sdk::apply::configure_server(cfg, &root, server_root, &effective);
                ide_sdk::java::cap_java_home(cfg, &ide_sdk::java::installed_jdks());
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
                    ide_sdk::jdtls::launch_directly(cfg);
                }
                ide_sdk::apply::server_protocol_overrides(cfg, &effective);
            }));
        }
        {
            let settings = settings.clone();
            lsp.set_servers_hook(Box::new(move |language, defined| {
                ide_sdk::apply::language_servers(language.as_str(), defined, &settings.effective())
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
        documents.add_observer(Arc::new(DeployObserver {
            remote: self.remote.clone(),
            settings: settings.clone(),
            root: root.clone(),
            sink: sink.clone(),
            runtime: self.runtime.clone(),
        }));

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
            let remote = self.remote.clone();
            let runtime = self.runtime.clone();
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
                    if !batch.removed.is_empty() {
                        delete_deployed(
                            &runtime,
                            remote.clone(),
                            settings.clone(),
                            root.clone(),
                            batch.removed.clone(),
                            sink.clone(),
                        );
                    }
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
        {
            let (root, repos, settings, sink) = (root.clone(), repos.clone(), settings.clone(), sink.clone());
            std::thread::Builder::new()
                .name("openidea-vcs-roots".into())
                .spawn(move || scan_repositories(&root, &repos, &settings, &sink))?;
        }
        mark("git");
        tracing::info!("opened {} in window {window} in {} ms {laps:?}", root.display(), started.elapsed().as_millis());

        let (db, http_history, agents) = self.project_services(&root, &project_key);
        let notebooks = crate::notebook::NotebookService::new(
            self.data_dir.join("notebook-runtime").join(uuid::Uuid::new_v4().to_string()),
            sink.clone(),
        );
        ide_agent::registry::maintain(crate::ops::agent::registry_paths(self));
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
            notebooks,
            watcher,
            content_watchers: Mutex::new(content_watchers),
            _scratch_watcher: scratch_watcher,
            light: false,
        });
        {
            let weak = Arc::downgrade(&project);
            project.lsp.set_candidates_hook(Box::new(move |q, cancel| {
                weak.upgrade().map(|p| p.reference_candidates(q, cancel)).unwrap_or_default()
            }));
        }
        self.insert_project(window, project.clone());
        if let Some(cmd) = post_start {
            self.environment.spawn_post_start(cmd, project.root.clone(), project.sink.clone());
        }
        Ok(project)
    }

    /// Database connections, HTTP Client history and coding agents of the project at `root`.
    pub(crate) fn project_services(
        &self,
        root: &Path,
        project_key: &str,
    ) -> (Arc<ide_db::DbManager>, Arc<ide_http::History>, Arc<ide_agent::AgentManager>) {
        let db = Arc::new(ide_db::DbManager::new(
            root.to_path_buf(),
            self.data_dir.join("db-passwords.json"),
            self.data_dir.join("db-history.json"),
            self.ssh.clone(),
        ));
        let http_history = Arc::new(ide_http::History::new(self.data_dir.join("http-history").join(project_key)));
        let agents = Arc::new(ide_agent::AgentManager::new(
            ide_agent::AgentPaths {
                project_root: root.to_path_buf(),
                store_dir: self.data_dir.join("agents").join(project_key),
                // Outside the app data dir: its path has spaces on macOS, which trips up build scripts.
                worktrees_dir: dirs::home_dir()
                    .unwrap_or_else(|| self.data_dir.clone())
                    .join(".openidea")
                    .join("worktrees")
                    .join(project_key),
                models_file: self.data_dir.join("agents").join("models.json"),
                custom_agents_dir: Some(self.config_dir.join("agents")),
                home_dir: dirs::home_dir(),
            },
            self.runtime.clone(),
        ));
        (db, http_history, agents)
    }
}

impl Host {
    /// Opens `window` for editing loose files (LightEdit), `file` first: documents
    /// with syntax highlighting, saving and Local History over the global settings,
    /// without an index, language servers, repositories or project settings. A
    /// window already in LightEdit keeps its session; only its watchers grow.
    pub fn open_light(&self, window: &str, file: &Path) -> IdeResult<Arc<Project>> {
        let file = dunce::canonicalize(file)?;
        if file.is_dir() {
            return Err(IdeError::invalid(format!("{} is a folder", file.display())));
        }
        let dir = file.parent().map(Path::to_path_buf).ok_or_else(|| IdeError::invalid("no parent folder"))?;
        if let Ok(current) = self.project(window)
            && current.light
        {
            current.watch_light_dir(&dir);
            return Ok(current);
        }
        self.close_project(window);
        let sink: SharedSink = (self.sink_for)(window);
        let settings = Arc::new(SettingsStore::load(&self.config_dir, None));
        let effective = settings.effective();
        let languages = Arc::new(self.languages.fork());
        languages.set_file_types(FileTypes::from_settings(&effective.files, None));
        let documents = {
            let languages = languages.clone();
            Arc::new(Documents::new(
                sink.clone(),
                Box::new(move |p: &Path, first: Option<&str>| languages.detect(p, first)),
            ))
        };
        documents.set_file_defaults(ide_workspace::FileDefaults::from_settings(&effective, None));
        let history = Arc::new(LocalHistory::open(&self.data_dir.join("history"), &dir)?);
        let index = ProjectIndex::unindexed(&dir, languages.clone(), self.syntax(), sink.clone())?;
        let lsp = LspManager::new(dir.clone(), languages.clone(), sink.clone());
        lsp.set_servers_hook(Box::new(|_, _| Vec::new()));
        let syntax = Arc::new(SyntaxCache::new(self.syntax()));
        documents.add_observer(Arc::new(SyntaxObserver(syntax.clone())));
        documents.add_observer(Arc::new(HistoryObserver(history.clone())));
        let watcher = light_watcher(&dir, &sink, &documents, &history)?;
        let project_key = project_key(&dir);
        let (db, http_history, agents) = self.project_services(&dir, &project_key);
        let notebooks = crate::notebook::NotebookService::new(
            self.data_dir.join("notebook-runtime").join(uuid::Uuid::new_v4().to_string()),
            sink.clone(),
        );
        let project = Arc::new(Project {
            sink,
            languages,
            settings,
            documents,
            history,
            moves: FileMoves::new(),
            index,
            lsp,
            repos: Arc::default(),
            structure: Arc::new(StructureService::new(syntax.clone())),
            syntax,
            detected_roots: Arc::default(),
            cache_dir: self.data_dir.join("cache").join(&project_key),
            db,
            http_history,
            agents,
            notebooks,
            watcher,
            content_watchers: Mutex::new(Vec::new()),
            _scratch_watcher: None,
            light: true,
            root: dir,
        });
        tracing::info!("window {window} edits {} without a project", file.display());
        self.insert_project(window, project.clone());
        Ok(project)
    }
}

impl Project {
    /// LightEdit: follow external changes to the files of `dir` (its own entries only).
    pub fn watch_light_dir(&self, dir: &Path) {
        if !self.light {
            return;
        }
        let dir = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let mut watchers = self.content_watchers.lock();
        if dir == self.root || watchers.iter().any(|(p, _)| *p == dir) {
            return;
        }
        match light_watcher(&dir, &self.sink, &self.documents, &self.history) {
            Ok(w) => watchers.push((dir, w)),
            Err(e) => tracing::warn!("watching {}: {e}", dir.display()),
        }
    }
}

fn light_watcher(
    dir: &Path,
    sink: &SharedSink,
    documents: &Arc<Documents>,
    history: &Arc<LocalHistory>,
) -> IdeResult<Watcher> {
    let (documents, history) = (documents.clone(), history.clone());
    Watcher::start_with(
        dir,
        Vec::new(),
        sink.clone(),
        Box::new(move |batch| {
            let changed: Vec<PathBuf> = batch.created.iter().chain(&batch.modified).cloned().collect();
            documents.on_disk_changed(&changed);
            record_external_changes(&history, &changed, &batch.removed);
        }),
        ide_vfs::WatchMode::Flat,
    )
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
        apply_git_executable(&settings);
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

    /// Project files of `q.languages` under `q.root` containing `q.word` as a whole
    /// word (unsaved buffers included; excluded roots, ignored names and
    /// `.gitignore`d files skipped): the files a references search opens on its server.
    pub fn reference_candidates(
        &self,
        q: &ide_lsp::CandidateQuery,
        cancel: &CancellationToken,
    ) -> ide_lsp::CandidateFiles {
        if !q.root.starts_with(&self.root) {
            return ide_lsp::CandidateFiles::default();
        }
        let query = ide_search::WordQuery {
            word: q.word.clone(),
            dir: q.root.clone(),
            exclude: self.search_excludes(),
            limit: q.limit,
        };
        let filter = |rel: &str| q.languages.contains(&self.languages.detect(&self.root.join(rel), None));
        match ide_search::files_with_word(&self.root, &query, Some(&filter), &|p| self.documents.text_of(p), cancel) {
            Ok(found) => ide_lsp::CandidateFiles { files: found.files, limit_hit: found.limit_hit },
            Err(e) => {
                tracing::debug!("reference candidates: {}", e.message);
                ide_lsp::CandidateFiles::default()
            }
        }
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
        if self.light {
            return;
        }
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

/// Uploads saved files: remote files' local copies, and automatic upload to the default server.
struct DeployObserver {
    remote: Arc<ide_remote::RemoteService>,
    settings: Arc<SettingsStore>,
    root: PathBuf,
    sink: SharedSink,
    runtime: tokio::runtime::Handle,
}

impl DocumentObserver for DeployObserver {
    fn saved(&self, _doc: ide_core::DocId, path: &Path, _text: &str) {
        let (remote, settings, root, sink, path) =
            (self.remote.clone(), self.settings.clone(), self.root.clone(), self.sink.clone(), path.to_path_buf());
        self.runtime.spawn(async move {
            if let Some(result) = remote.on_saved(&settings.effective(), &root, &path).await {
                notify_transfer(&sink, "Upload", &path, result);
            }
        });
    }
}

fn delete_deployed(
    runtime: &tokio::runtime::Handle,
    remote: Arc<ide_remote::RemoteService>,
    settings: Arc<SettingsStore>,
    root: PathBuf,
    removed: Vec<PathBuf>,
    sink: SharedSink,
) {
    runtime.spawn(async move {
        if let Some(result) = remote.on_deleted(&settings.effective(), &root, &removed).await {
            let first = removed.first().cloned().unwrap_or_default();
            notify_transfer(&sink, "Delete on server", &first, result);
        }
    });
}

/// Reports a failed automatic transfer (successes stay quiet).
fn notify_transfer(sink: &SharedSink, what: &str, path: &Path, result: IdeResult<ide_remote::TransferReport>) {
    let body = match result {
        Ok(r) if r.errors.is_empty() => return,
        Ok(r) => r.errors.iter().map(|e| format!("{}: {}", e.path, e.message)).collect::<Vec<_>>().join("\n"),
        Err(e) => e.message,
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    sink.emit(IdeEvent::Notify {
        level: ide_core::event::NotifyLevel::Error,
        title: format!("{what} failed: {name}"),
        body: Some(body),
    });
}

/// Settings › Version Control › Git › Path to Git executable (empty = auto-detect).
pub fn apply_git_executable(settings: &ide_core::settings::Settings) {
    let exe = settings.vcs.git.executable.trim();
    ide_vcs::set_git_executable((!exe.is_empty()).then(|| Path::new(exe)));
}
