//! The PHP engine of one open project: its layout, its indexes and the open
//! documents that override the files on disk.
//!
//! [`PhpEngine::open`] starts a worker thread (modelled on
//! `crates/ide-index/src/worker.rs`) that:
//!
//! 1. works out the project's files ([`ProjectLayout`]),
//! 2. stays [`EngineState::Inactive`] when there is no PHP in the project (no
//!    PHP file and no `composer.json`); a PHP file appearing later starts it,
//! 3. otherwise opens the persistent [`PhpIndex`] in the cache directory and
//!    brings it up to date with [`PhpIndex::sync`], then applies watcher
//!    batches ([`PhpEngine::files_changed`]) with [`PhpIndex::update`]. A
//!    changed `composer.json` / `installed.json`, a new folder or new layout
//!    settings load the layout again and rescan.
//!
//! While a scan runs the engine is in dumb mode: it emits
//! `IdeEvent::IndexState { indexing: true }` and `false` when done. It also
//! reports itself as a language server (`IdeEvent::LanguageServer` with its
//! own [`ServerId`], `starting` → `busy` → `ready`) so the frontend's
//! availability logic (`src/editor/lsp/availability.ts`) treats it like one:
//! back-offs are cleared and stale answers re-requested once it is ready.
//!
//! Open documents ([`PhpEngine::document_opened`] and friends) are kept as
//! overlays: [`PhpEngine::summary`] answers from the buffer of an open file
//! and from the index otherwise. Every document edit and watcher batch bumps
//! the [modification counter](PhpEngine::modification_count) that the type
//! cache of [`PhpEngine::resolver`] is dropped on.
//!
//! A Symfony project's YAML configuration ([`SymfonyConfig`]) is read from
//! `config/` on first use and kept until a rescan or a watcher batch that
//! touches a YAML file.
//!
//! The Laravel project model ([`LaravelProject`], [`PhpEngine::laravel`])
//! is read the same way: its files that aren't PHP (`composer.json`,
//! `composer.lock`, modules) on first use until a rescan or a batch touching
//! one of them or a folder, and its route files from the summaries in the
//! index for each modification count. Its configuration keys
//! ([`PhpEngine::laravel_config`]) are read from `config/`, and its routes
//! ([`PhpEngine::laravel_routes`]) from its route files, for each
//! modification count.

#[cfg(test)]
mod tests;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ide_core::event::ServerStatus;
use ide_core::settings::LaravelSettings;
use ide_core::{CancellationToken, DocId, IdeError, IdeEvent, IdeResult, Pos, ServerId, SharedSink};
use parking_lot::{Condvar, Mutex, RwLock};

use crate::frameworks::laravel::{ConfigKeys, LaravelProject, RouteTable};
use crate::index::{IndexStats, PhpIndex};
use crate::inspect::runner::Runner;
use crate::inspect::{InspectionConfig, Inspections};
use crate::meta::PhpStormMeta;
use crate::names::{NameKind, fqn_eq};
use crate::project::{LayoutConfig, ProjectLayout, is_php_path, normalize};
use crate::stubs::{BundledStubs, StubFilter, StubSet};
use crate::summary::{ClassLike, ConstantDecl, FileSummary, FunctionDecl, LaravelFacts};
use crate::symfony::{SymfonyConfig, SymfonyProject};
use crate::syntax::{ParseCache, ParsedFile};
use crate::types::{ClassModel, Declarations, Resolver, Type, TypeCache};

/// The name the engine reports itself under in `IdeEvent::LanguageServer`.
pub const SERVER_NAME: &str = "PHP (native)";

/// The cache subdirectory, inside the project cache directory, that holds the
/// index database.
pub const CACHE_SUBDIR: &str = "php";

/// What [`PhpEngine::open`] needs.
#[derive(Clone, Debug, Default)]
pub struct EngineConfig {
    /// Where the index database lives (created when needed).
    pub cache_dir: PathBuf,
    /// The project folder, include paths and excluded folders.
    pub layout: LayoutConfig,
    /// The PHP version and stub sets the built-in declarations are filtered by.
    pub stubs: StubFilter,
}

/// What the engine is doing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineState {
    /// The first scan hasn't finished.
    Starting,
    /// A scan is building or updating the indexes (dumb mode).
    Indexing,
    /// The indexes are up to date; watcher batches are applied as they come.
    Ready,
    /// The project has no PHP: nothing is indexed until a PHP file appears.
    Inactive,
    /// Indexing failed; the message says why. The next batch or rescan retries.
    Failed(String),
    /// [`PhpEngine::shutdown`] was called.
    Stopped,
}

/// A snapshot of the engine for status displays and tests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineStatus {
    pub state: EngineState,
    /// Indexed files.
    pub files: u64,
    /// Indexed declarations (class-likes, functions, constants).
    pub declarations: u64,
    /// Whether the index is stored on disk (false: in memory).
    pub persistent: bool,
}

/// An open document, which overrides the file on disk.
#[derive(Clone, Debug)]
pub struct OpenDocument {
    pub doc: DocId,
    /// Normalized.
    pub path: PathBuf,
    pub version: u32,
    pub text: Arc<str>,
    /// The PHP compiled from a template (a Blade view,
    /// [`crate::blade`]): analysed like any open document, but never
    /// inspected (its positions aren't the editor's) and updated only
    /// through [`PhpEngine::embedded_document`].
    pub embedded: bool,
}

/// The native PHP engine of one project. Dropping it shuts it down.
pub struct PhpEngine {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
    /// The background inspection thread ([`crate::inspect`]).
    inspection_thread: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
struct Queue {
    rescan: bool,
    changed: BTreeSet<PathBuf>,
    removed: BTreeSet<PathBuf>,
    /// The worker is running a job (or hasn't looked at the queue yet).
    busy: bool,
    shutdown: bool,
}

impl Queue {
    fn has_work(&self) -> bool {
        self.rescan || !self.changed.is_empty() || !self.removed.is_empty()
    }
}

struct Shared {
    sink: SharedSink,
    server: ServerId,
    cache_dir: PathBuf,
    layout_config: Mutex<LayoutConfig>,
    layout: RwLock<Option<ProjectLayout>>,
    index: RwLock<Option<Arc<PhpIndex>>>,
    queue: Mutex<Queue>,
    wake: Condvar,
    idle: Condvar,
    status: Mutex<EngineStatus>,
    cancel: CancellationToken,
    modification: AtomicU64,
    /// A `LanguageServer` event has been sent (the engine became active).
    announced: AtomicBool,
    /// The last `IndexState` sent said `indexing: true`.
    indexing: AtomicBool,
    documents: Mutex<HashMap<DocId, OpenDocument>>,
    parses: ParseCache,
    /// The summary of each open document's latest version: declarations
    /// are looked up in open buffers for every name an inspection resolves.
    open_summaries: Mutex<HashMap<DocId, (u32, Arc<FileSummary>)>>,
    /// Resolved declaration types, dropped when `modification` moves.
    types: TypeCache,
    /// The stub filter and the stub set built for it (on first use).
    stubs: Mutex<(StubFilter, Option<Arc<StubSet>>)>,
    /// The inspections run over open documents, and their background run.
    inspection_set: RwLock<Inspections>,
    inspections: Arc<Runner>,
    /// The settings `inspection_set` was built from.
    inspection_config: Mutex<InspectionConfig>,
    /// The project's Symfony configuration, read on first use; dropped
    /// when a YAML file changes.
    symfony_config: Mutex<Option<Arc<SymfonyConfig>>>,
    laravel: Mutex<LaravelCache>,
    /// The Laravel configuration keys for a modification count.
    laravel_config: Mutex<Option<(u64, Arc<ConfigKeys>)>>,
    /// The Laravel routes, for a modification count.
    laravel_routes: Mutex<Option<(u64, Arc<RouteTable>)>>,
    /// What Laravel support shows (Settings › PHP › Laravel).
    laravel_settings: Mutex<LaravelSettings>,
}

/// The Laravel project model: what [`LaravelProject::load`] read (`None`:
/// not read yet), and the model with its route files for a modification
/// count.
#[derive(Default)]
struct LaravelCache {
    loaded: Option<Option<Arc<LaravelProject>>>,
    project: Option<(u64, Option<Arc<LaravelProject>>)>,
}

impl PhpEngine {
    /// Starts the engine: the worker thread scans the project in the
    /// background, so this returns at once.
    pub fn open(config: EngineConfig, sink: SharedSink) -> IdeResult<Arc<Self>> {
        let shared = Arc::new(Shared {
            sink,
            server: ServerId::next(),
            cache_dir: config.cache_dir,
            layout_config: Mutex::new(config.layout),
            layout: RwLock::new(None),
            index: RwLock::new(None),
            queue: Mutex::new(Queue { rescan: true, busy: true, ..Queue::default() }),
            wake: Condvar::new(),
            idle: Condvar::new(),
            status: Mutex::new(EngineStatus {
                state: EngineState::Starting,
                files: 0,
                declarations: 0,
                persistent: false,
            }),
            cancel: CancellationToken::new(),
            modification: AtomicU64::new(0),
            announced: AtomicBool::new(false),
            indexing: AtomicBool::new(false),
            documents: Mutex::new(HashMap::new()),
            parses: ParseCache::new(),
            open_summaries: Mutex::new(HashMap::new()),
            types: TypeCache::new(),
            stubs: Mutex::new((config.stubs, None)),
            inspection_set: RwLock::new(Inspections::builtin()),
            inspections: Arc::default(),
            inspection_config: Mutex::new(InspectionConfig::default()),
            symfony_config: Mutex::new(None),
            laravel: Mutex::new(LaravelCache::default()),
            laravel_config: Mutex::new(None),
            laravel_routes: Mutex::new(None),
            laravel_settings: Mutex::new(LaravelSettings::default()),
        });
        let worker = shared.clone();
        let thread = std::thread::Builder::new()
            .name("openidea-php-engine".into())
            .spawn(move || worker.run())
            .map_err(|e| IdeError::internal(format!("php engine: {e}")))?;
        let runner = shared.inspections.clone();
        let sink = shared.sink.clone();
        Ok(Arc::new_cyclic(|engine| {
            let inspection_thread = runner.start(engine.clone(), sink);
            Self { shared, thread: Mutex::new(Some(thread)), inspection_thread: Mutex::new(inspection_thread) }
        }))
    }

    /// Stops the worker (cancelling a running scan) and waits for it. The
    /// engine reports itself gone. Calling it again does nothing.
    pub fn shutdown(&self) {
        {
            let mut q = self.shared.queue.lock();
            q.shutdown = true;
        }
        self.shared.cancel.cancel();
        self.shared.wake.notify_all();
        self.shared.idle.notify_all();
        let inspection_thread = self.inspection_thread.lock().take();
        self.shared.inspections.stop(inspection_thread, &self.shared.sink);
        let thread = self.thread.lock().take();
        let Some(thread) = thread else { return };
        if thread.join().is_err() {
            tracing::warn!("php engine worker panicked");
        }
        self.shared.status.lock().state = EngineState::Stopped;
        self.shared.end_indexing();
        if self.shared.announced.swap(false, Ordering::SeqCst) {
            self.shared.sink.emit(IdeEvent::LanguageServerRemoved { server: self.shared.server });
        }
    }

    pub fn status(&self) -> EngineStatus {
        self.shared.status.lock().clone()
    }

    /// The id the engine reports itself under as a language server.
    pub fn server_id(&self) -> ServerId {
        self.shared.server
    }

    /// Goes up with every document edit and watcher batch.
    pub fn modification_count(&self) -> u64 {
        self.shared.modification.load(Ordering::SeqCst)
    }

    /// The indexes, once the engine is active.
    pub fn index(&self) -> Option<Arc<PhpIndex>> {
        self.shared.index.read().clone()
    }

    /// The project layout, once the first scan has read it.
    pub fn layout(&self) -> Option<ProjectLayout> {
        self.shared.layout.read().clone()
    }

    /// Blocks until the queued work is done (or the engine stopped). False on
    /// timeout.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut q = self.shared.queue.lock();
        while !q.shutdown && (q.busy || q.has_work()) {
            if self.shared.idle.wait_until(&mut q, deadline).timed_out() {
                return q.shutdown || !(q.busy || q.has_work());
            }
        }
        true
    }

    // ------------------------------------------------------------ changes

    /// Applies new include paths or excluded folders: the layout is loaded
    /// again and the project rescanned.
    pub fn set_layout_config(&self, config: LayoutConfig) {
        let changed = {
            let mut current = self.shared.layout_config.lock();
            let changed = current.root != config.root
                || current.include_paths != config.include_paths
                || current.excludes != config.excludes;
            *current = config;
            changed
        };
        if changed {
            self.rescan();
        }
    }

    /// Applies a new PHP version or set of enabled extensions to the
    /// built-in declarations.
    pub fn set_stub_filter(&self, filter: StubFilter) {
        let mut stubs = self.shared.stubs.lock();
        if stubs.0 != filter {
            *stubs = (filter, None);
            drop(stubs);
            self.shared.modification.fetch_add(1, Ordering::SeqCst);
            // The language level and the built-ins changed: inspect again.
            let (_, runner) = self.shared_inspections();
            runner.forget_results();
            for document in self.open_documents() {
                runner.schedule(document.doc);
            }
        }
    }

    /// The project's PHP language level (the stub filter's version).
    pub fn language_level(&self) -> crate::stubs::PhpVersion {
        self.shared.stubs.lock().0.version
    }

    /// The built-in declarations the project sees (built on first use, which
    /// unpacks and parses the bundled stubs once per process).
    pub fn stubs(&self) -> Arc<StubSet> {
        let filter = {
            let stubs = self.shared.stubs.lock();
            if let Some(set) = &stubs.1 {
                return set.clone();
            }
            stubs.0.clone()
        };
        let set = Arc::new(BundledStubs::get().summaries(&filter));
        let mut stubs = self.shared.stubs.lock();
        if stubs.0 == filter {
            stubs.1 = Some(set.clone());
        }
        set
    }

    /// The directory built-in stub files are written to for navigation.
    pub fn stub_dir(&self) -> PathBuf {
        self.shared.cache_dir.join("stubs")
    }

    /// Loads the layout again and brings the indexes up to date.
    pub fn rescan(&self) {
        *self.shared.symfony_config.lock() = None;
        *self.shared.laravel.lock() = LaravelCache::default();
        self.shared.modification.fetch_add(1, Ordering::SeqCst);
        let mut q = self.shared.queue.lock();
        q.rescan = true;
        q.changed.clear();
        q.removed.clear();
        drop(q);
        self.shared.wake.notify_all();
    }

    /// A watcher batch: files created or modified, and files or folders
    /// removed. Paths that can't matter (other languages) are dropped here.
    pub fn files_changed(&self, changed: &[PathBuf], removed: &[PathBuf]) {
        if changed.iter().chain(removed).any(|p| is_yaml_path(p) || p.ends_with("config")) {
            // The Symfony configuration is read again on next use.
            *self.shared.symfony_config.lock() = None;
            self.shared.modification.fetch_add(1, Ordering::SeqCst);
            self.shared.inspect_open_documents();
        }
        if changed.iter().any(|p| is_laravel_input(p) || p.is_dir()) || removed.iter().any(|p| !is_php_path(p)) {
            // Detection, paths and modules are read again on next use.
            *self.shared.laravel.lock() = LaravelCache::default();
            self.shared.modification.fetch_add(1, Ordering::SeqCst);
        }
        let changed: Vec<PathBuf> = changed
            .iter()
            .filter(|p| is_php_path(p) || is_manifest_name(p) || p.is_dir())
            .map(|p| normalize(p))
            .collect();
        // A removed folder can't be told from a removed file without an
        // extension; the worker checks it against the indexed files.
        let removed: Vec<PathBuf> = removed.iter().map(|p| normalize(p)).collect();
        if changed.is_empty() && removed.is_empty() {
            return;
        }
        self.shared.modification.fetch_add(1, Ordering::SeqCst);
        let mut q = self.shared.queue.lock();
        if !q.rescan {
            for p in removed {
                q.changed.remove(&p);
                q.removed.insert(p);
            }
            for p in changed {
                q.removed.remove(&p);
                q.changed.insert(p);
            }
        }
        drop(q);
        self.shared.wake.notify_all();
    }

    // ---------------------------------------------------------- documents

    /// An editor opened `path`: its buffer overrides the file on disk.
    pub fn document_opened(&self, doc: DocId, path: &Path, version: u32, text: &str) {
        self.shared.modification.fetch_add(1, Ordering::SeqCst);
        let document = OpenDocument { doc, path: normalize(path), version, text: Arc::from(text), embedded: false };
        self.shared.documents.lock().insert(doc, document);
        self.shared.inspections.schedule(doc);
    }

    /// Holds `text`, the PHP compiled from the template `doc` at `path`
    /// (a Blade view), as an embedded open document: the engine's requests
    /// answer on it, and it overrides the file on disk, but it is never
    /// inspected. Nothing happens when it already holds that version.
    /// [`document_closed`](Self::document_closed) drops it.
    pub fn embedded_document(&self, doc: DocId, path: &Path, version: u32, text: &str) {
        let mut documents = self.shared.documents.lock();
        if documents.get(&doc).is_some_and(|d| d.embedded && d.version == version && *d.text == *text) {
            return;
        }
        let document = OpenDocument { doc, path: normalize(path), version, text: Arc::from(text), embedded: true };
        documents.insert(doc, document);
        drop(documents);
        // The same version can come back with other text (another template
        // engine's compilation): parse it again.
        self.shared.parses.remove(doc);
        self.shared.open_summaries.lock().remove(&doc);
        self.shared.modification.fetch_add(1, Ordering::SeqCst);
    }

    /// The buffer of an open document changed; `text` is its full new text.
    /// Embedded documents ignore it (their template changed, not the PHP).
    pub fn document_changed(&self, doc: DocId, version: u32, text: &str) {
        let mut documents = self.shared.documents.lock();
        let Some(document) = documents.get_mut(&doc) else { return };
        if version < document.version || document.embedded {
            return;
        }
        document.version = version;
        document.text = Arc::from(text);
        drop(documents);
        self.shared.modification.fetch_add(1, Ordering::SeqCst);
        self.shared.inspections.schedule(doc);
    }

    /// The editor closed the document: the file on disk counts again.
    pub fn document_closed(&self, doc: DocId) {
        if self.shared.documents.lock().remove(&doc).is_some() {
            self.shared.inspections.closed(doc, &self.shared.sink);
            self.shared.parses.remove(doc);
            self.shared.open_summaries.lock().remove(&doc);
            self.shared.modification.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// The inspection set and the background run.
    pub(crate) fn shared_inspections(&self) -> (&RwLock<Inspections>, &Arc<Runner>) {
        (&self.shared.inspection_set, &self.shared.inspections)
    }

    /// The settings the inspections were last configured with.
    pub(crate) fn shared_inspection_config(&self) -> &Mutex<InspectionConfig> {
        &self.shared.inspection_config
    }

    /// Whether the engine holds `doc` as an open document.
    pub fn is_open(&self, doc: DocId) -> bool {
        self.shared.documents.lock().contains_key(&doc)
    }

    /// The open document of `path`, if any.
    pub fn open_document(&self, path: &Path) -> Option<OpenDocument> {
        let path = normalize(path);
        self.shared.documents.lock().values().find(|d| d.path == path).cloned()
    }

    /// The project folder.
    pub fn root(&self) -> PathBuf {
        self.shared.layout_config.lock().root.clone()
    }

    /// The project's Symfony configuration (`config/*.yaml`), read once
    /// until a YAML file changes.
    pub fn symfony_config(&self) -> Arc<SymfonyConfig> {
        if let Some(config) = self.shared.symfony_config.lock().clone() {
            return config;
        }
        let root = self.shared.layout_config.lock().root.clone();
        let config = Arc::new(SymfonyConfig::load(&root));
        *self.shared.symfony_config.lock() = Some(config.clone());
        config
    }

    /// The Laravel project model, or `None` when the project isn't a
    /// Laravel project. Its files that aren't PHP are read once until one
    /// of them changes; its route files come from the summaries of the
    /// index and the open buffers, for the current modification count.
    pub fn laravel(&self) -> Option<Arc<LaravelProject>> {
        let modification = self.modification_count();
        let loaded = {
            let cache = self.shared.laravel.lock();
            if let Some((at, project)) = &cache.project
                && *at == modification
            {
                return project.clone();
            }
            cache.loaded.clone()
        };
        let loaded = match loaded {
            Some(loaded) => loaded,
            None => {
                let loaded = LaravelProject::load(&self.root()).map(Arc::new);
                self.shared.laravel.lock().loaded = Some(loaded.clone());
                loaded
            }
        };
        let project = loaded.map(|loaded| Arc::new(loaded.with_routes(&Declarations::laravel(self))));
        let mut cache = self.shared.laravel.lock();
        if cache.loaded.is_some() {
            cache.project = Some((modification, project.clone()));
        }
        project
    }

    /// The configuration keys of the Laravel project (`config/*.php`, open
    /// buffers first), or `None` when the project isn't a Laravel project.
    /// Read again when the modification count moves.
    pub fn laravel_config(&self) -> Option<Arc<ConfigKeys>> {
        let modification = self.modification_count();
        if let Some((at, keys)) = &*self.shared.laravel_config.lock()
            && *at == modification
        {
            return Some(keys.clone());
        }
        let project = self.laravel()?;
        let keys = Arc::new(ConfigKeys::read(&project.paths.config, |path| match self.open_document(path) {
            Some(document) => Some(document.text.to_string()),
            None => std::fs::read_to_string(path).ok(),
        }));
        *self.shared.laravel_config.lock() = Some((modification, keys.clone()));
        Some(keys)
    }

    /// The routes and middleware of the Laravel project (its route files,
    /// open buffers first), or `None` when the project isn't a Laravel
    /// project. Read again when the modification count moves.
    pub fn laravel_routes(&self) -> Option<Arc<RouteTable>> {
        let modification = self.modification_count();
        if let Some((at, routes)) = &*self.shared.laravel_routes.lock()
            && *at == modification
        {
            return Some(routes.clone());
        }
        let project = self.laravel()?;
        let routes = Arc::new(RouteTable::read(&project, |path| match self.open_document(path) {
            Some(document) => Some(document.text.to_string()),
            None => std::fs::read_to_string(path).ok(),
        }));
        *self.shared.laravel_routes.lock() = Some((modification, routes.clone()));
        Some(routes)
    }

    /// What Laravel support shows.
    pub fn laravel_settings(&self) -> LaravelSettings {
        self.shared.laravel_settings.lock().clone()
    }

    /// Changes what Laravel support shows (the front end's settings).
    pub fn set_laravel_settings(&self, settings: LaravelSettings) {
        *self.shared.laravel_settings.lock() = settings;
    }

    /// Every open document.
    pub fn open_documents(&self) -> Vec<OpenDocument> {
        self.shared.documents.lock().values().cloned().collect()
    }

    /// The parse of an open document's current version.
    pub(crate) fn parse_open(&self, document: &OpenDocument) -> Arc<ParsedFile> {
        self.shared.parses.get_or_parse(document.doc, document.version, || document.text.clone())
    }

    /// The path of an open document (normalized).
    pub fn document_path(&self, doc: DocId) -> Option<PathBuf> {
        self.shared.documents.lock().get(&doc).map(|d| d.path.clone())
    }

    /// The parse of the current version of an open document.
    pub fn parsed_document(&self, doc: DocId) -> Option<Arc<ParsedFile>> {
        let document = self.shared.documents.lock().get(&doc).cloned()?;
        Some(self.shared.parses.get_or_parse(doc, document.version, || document.text.clone()))
    }

    /// The summary of `path`: from its open buffer when it is open, from the
    /// index otherwise.
    pub fn summary(&self, path: &Path) -> IdeResult<Option<FileSummary>> {
        if let Some(document) = self.open_document(path) {
            return Ok(Some(FileSummary::clone(&self.open_summary(&document))));
        }
        match self.index() {
            Some(index) => index.summary(path),
            None => Ok(None),
        }
    }

    /// [`summary`](Self::summary), shared: an open document's comes from
    /// the cache without a copy.
    pub(crate) fn shared_summary(&self, path: &Path) -> IdeResult<Option<Arc<FileSummary>>> {
        if let Some(document) = self.open_document(path) {
            return Ok(Some(self.open_summary(&document)));
        }
        match self.index() {
            Some(index) => Ok(index.summary(path)?.map(Arc::new)),
            None => Ok(None),
        }
    }

    /// The summary of an open document's current version, extracted once.
    pub(crate) fn open_summary(&self, document: &OpenDocument) -> Arc<FileSummary> {
        if let Some((version, summary)) = self.shared.open_summaries.lock().get(&document.doc)
            && *version == document.version
        {
            return summary.clone();
        }
        let parsed = self.parse_open(document);
        let summary = Arc::new(FileSummary::extract(&parsed));
        let mut cache = self.shared.open_summaries.lock();
        // A document closed meanwhile isn't cached again.
        if self.shared.documents.lock().get(&document.doc).is_some_and(|d| d.version == document.version) {
            cache.insert(document.doc, (document.version, summary.clone()));
        }
        summary
    }

    // -------------------------------------------------------------- types

    /// A resolver for lazy types against the project, caching in the
    /// engine's type cache for the current modification count.
    pub fn resolver(&self) -> Resolver<'_> {
        Resolver::new(self, &self.shared.types, self.modification_count())
    }

    /// The model of class-like `fqn` (all its members, inherited ones
    /// included), cached for the current modification count.
    pub fn class_model(&self, fqn: &str) -> Option<std::sync::Arc<ClassModel>> {
        self.resolver().class_model(fqn)
    }

    /// The project's `.phpstorm.meta.php` directives (expected argument and
    /// return values for completion, overrides, exit points), cached for the
    /// current modification count.
    pub fn meta(&self) -> Arc<PhpStormMeta> {
        self.resolver().meta()
    }

    /// The type of the innermost expression at `pos` in an open document
    /// (see [`crate::types::expr`]). `None` when the engine doesn't hold the
    /// document or there is no expression there.
    pub fn type_at(&self, doc: DocId, pos: Pos) -> Option<Type> {
        let parsed = self.parsed_document(doc)?;
        let offset = parsed.line_index().byte(pos);
        crate::types::type_at(&parsed, &self.resolver(), offset)
    }

    /// How many declaration types are cached for the current modification
    /// count.
    pub fn cached_types(&self) -> usize {
        self.shared.types.len(self.modification_count())
    }

    /// The first project declaration of `fqn` that `pick` finds in its
    /// declaring file's summary (open buffers first).
    fn project_declaration<T>(&self, kind: NameKind, fqn: &str, pick: impl Fn(&FileSummary) -> Option<T>) -> Option<T> {
        let indexed = self.index().and_then(|index| {
            let decls = index.declarations(kind, fqn).ok()?;
            decls.into_iter().find_map(|decl| pick(&*self.shared_summary(&decl.path()).ok()??))
        });
        indexed.or_else(|| self.open_declaration(fqn, &pick))
    }

    /// Whether the project (the index or an open buffer) or the bundled
    /// stubs declare `fqn`.
    pub(crate) fn declares(&self, kind: NameKind, fqn: &str) -> bool {
        let stubs = self.stubs();
        let in_stubs = match kind {
            NameKind::ClassLike => stubs.class_like(fqn).is_some(),
            NameKind::Function => stubs.function(fqn).is_some(),
            NameKind::Constant => stubs.constant(fqn).is_some(),
            NameKind::Namespace => false,
        };
        in_stubs
            || self
                .project_declaration(kind, fqn, |summary| {
                    crate::navigate::find_declaration(summary, kind, fqn).map(|_| ())
                })
                .is_some()
    }

    /// Whether the bundled stubs declare `fqn` and the project doesn't.
    pub(crate) fn only_stubs_declare(&self, kind: NameKind, fqn: &str) -> bool {
        let stubs = self.stubs();
        let in_stubs = match kind {
            NameKind::ClassLike => stubs.class_like(fqn).is_some(),
            NameKind::Function => stubs.function(fqn).is_some(),
            NameKind::Constant => stubs.constant(fqn).is_some(),
            NameKind::Namespace => false,
        };
        in_stubs
            && self
                .project_declaration(kind, fqn, |summary| {
                    crate::navigate::find_declaration(summary, kind, fqn).map(|_| ())
                })
                .is_none()
    }

    /// A declaration only an open buffer has (a new file, or one outside
    /// the indexed folders), from the buffers' cached summaries.
    fn open_declaration<T>(&self, fqn: &str, pick: &impl Fn(&FileSummary) -> Option<T>) -> Option<T> {
        if fqn.rsplit('\\').next().unwrap_or(fqn).is_empty() {
            return None;
        }
        let documents: Vec<OpenDocument> = self.shared.documents.lock().values().cloned().collect();
        documents.into_iter().find_map(|document| pick(&self.open_summary(&document)))
    }
}

/// Project declarations from the open buffers and the indexes, then the
/// bundled stubs.
impl Declarations for PhpEngine {
    fn class_like(&self, fqn: &str) -> Option<ClassLike> {
        self.project_declaration(NameKind::ClassLike, fqn, |summary| summary.class_like(fqn).cloned())
            .or_else(|| self.stubs().class_like(fqn).map(|(_, class)| class.clone()))
    }

    /// When the project declares a function more than once (conditionally,
    /// or WordPress's `@ignore`d no-op `__()` and `get_option()` in
    /// `wp-admin/includes/noop.php`), the one that says most about its
    /// signature: a declared or documented return type first, then
    /// parameters, else the first.
    fn function(&self, fqn: &str) -> Option<FunctionDecl> {
        let indexed: Vec<FunctionDecl> = self
            .index()
            .and_then(|index| index.declarations(NameKind::Function, fqn).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|decl| self.shared_summary(&decl.path()).ok()??.function(fqn).cloned())
            .collect();
        let rank = |f: &FunctionDecl| {
            let returns = f.return_type.is_some() || f.doc.as_ref().is_some_and(|doc| doc.return_type.is_some());
            (returns, !f.params.is_empty())
        };
        let mut best: Option<FunctionDecl> = None;
        for function in indexed {
            if best.as_ref().is_none_or(|best| rank(&function) > rank(best)) {
                best = Some(function);
            }
        }
        best.or_else(|| self.open_declaration(fqn, &|summary: &FileSummary| summary.function(fqn).cloned()))
            .or_else(|| self.stubs().function(fqn).map(|(_, function)| function.clone()))
    }

    fn constant(&self, fqn: &str) -> Option<ConstantDecl> {
        let wanted = fqn.trim_start_matches('\\');
        self.project_declaration(NameKind::Constant, fqn, |summary| {
            summary.constants.iter().find(|constant| fqn_eq(NameKind::Constant, &constant.fqn, wanted)).cloned()
        })
        .or_else(|| self.stubs().constant(fqn).map(|(_, constant)| constant.clone()))
    }

    /// The directives of the indexed files that have some (their open
    /// buffers first), and of open `.phpstorm.meta.php` buffers not indexed
    /// yet.
    fn meta(&self) -> PhpStormMeta {
        let mut paths = self.index().and_then(|index| index.meta_files().ok()).unwrap_or_default();
        let open: Vec<PathBuf> = self.shared.documents.lock().values().map(|d| d.path.clone()).collect();
        for path in open {
            if is_meta_path(&path) && !paths.contains(&path) {
                paths.push(path);
            }
        }
        let summaries: Vec<Arc<FileSummary>> =
            paths.iter().filter_map(|path| self.shared_summary(path).ok().flatten()).collect();
        PhpStormMeta::merge(summaries.iter().map(|summary| &summary.meta))
    }

    /// The facts of the indexed files that have some (their open buffers
    /// first), then of open buffers not indexed yet, in path order (the
    /// order migrations run in).
    fn laravel(&self) -> LaravelFacts {
        let indexed = self.index().and_then(|index| index.laravel_files().ok()).unwrap_or_default();
        let mut summaries: Vec<(PathBuf, Arc<FileSummary>)> =
            indexed.iter().filter_map(|path| Some((path.clone(), self.shared_summary(path).ok()??))).collect();
        let open: Vec<OpenDocument> = self.shared.documents.lock().values().cloned().collect();
        for document in open {
            if !indexed.contains(&document.path) {
                let summary = self.open_summary(&document);
                if !summary.laravel.is_empty() {
                    summaries.push((document.path.clone(), summary));
                }
            }
        }
        summaries.sort_by(|a, b| a.0.cmp(&b.0));
        LaravelFacts::merge_located(summaries.iter().map(|(path, summary)| (Some(path.as_path()), &summary.laravel)))
    }

    /// The configuration, then the facts of the indexed files that have
    /// some (their open buffers first) and of open buffers not indexed
    /// yet, in path order.
    fn symfony(&self) -> SymfonyProject {
        let indexed = self.index().and_then(|index| index.symfony_files().ok()).unwrap_or_default();
        let mut summaries: Vec<(PathBuf, Arc<FileSummary>)> =
            indexed.iter().filter_map(|path| Some((path.clone(), self.shared_summary(path).ok()??))).collect();
        let open: Vec<OpenDocument> = self.shared.documents.lock().values().cloned().collect();
        for document in open {
            if !indexed.contains(&document.path) {
                let summary = self.open_summary(&document);
                if !summary.symfony.is_empty() {
                    summaries.push((document.path.clone(), summary));
                }
            }
        }
        summaries.sort_by(|a, b| a.0.cmp(&b.0));
        let config = SymfonyConfig::clone(&self.symfony_config());
        SymfonyProject::new(config, summaries.iter().map(|(path, summary)| (Some(path.as_path()), &summary.symfony)))
    }
}

/// `.phpstorm.meta.php`, or a file inside a `.phpstorm.meta.php` directory.
pub(crate) fn is_meta_path(path: &Path) -> bool {
    path.components().any(|part| part.as_os_str().eq_ignore_ascii_case(".phpstorm.meta.php"))
}

impl Drop for PhpEngine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn is_yaml_path(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()), Some("yaml" | "yml"))
}

/// A file the Laravel project model reads that isn't PHP (or `artisan`,
/// which has no extension).
fn is_laravel_input(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some(
            "composer.json" | "composer.lock" | "installed.json" | "module.json" | "modules_statuses.json" | "artisan"
        )
    ) || path.ends_with("config/modules.php")
}

fn is_manifest_name(path: &Path) -> bool {
    matches!(path.file_name().and_then(|n| n.to_str()), Some("composer.json" | "installed.json"))
}

// ------------------------------------------------------------------ worker

struct Job {
    rescan: bool,
    changed: Vec<PathBuf>,
    removed: Vec<PathBuf>,
}

impl Shared {
    fn run(self: Arc<Self>) {
        while let Some(job) = self.next_job() {
            let result = if job.rescan { self.scan() } else { self.apply(job.changed, job.removed) };
            match result {
                Ok(()) => {}
                Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => {
                    // Shutdown: the loop ends at the next look at the queue.
                    self.end_indexing();
                }
                Err(e) => self.fail(&e),
            }
        }
    }

    /// Waits for work; `None` once the engine shuts down.
    fn next_job(&self) -> Option<Job> {
        let mut q = self.queue.lock();
        loop {
            if q.shutdown {
                q.busy = false;
                self.idle.notify_all();
                return None;
            }
            if q.has_work() {
                break;
            }
            q.busy = false;
            self.idle.notify_all();
            self.wake.wait(&mut q);
        }
        q.busy = true;
        let job = Job {
            rescan: std::mem::take(&mut q.rescan),
            changed: std::mem::take(&mut q.changed).into_iter().collect(),
            removed: std::mem::take(&mut q.removed).into_iter().collect(),
        };
        Some(job)
    }

    /// Loads the layout and makes the index match its files.
    fn scan(&self) -> IdeResult<()> {
        let config = self.layout_config.lock().clone();
        let layout = ProjectLayout::load(&config);
        let files = layout.files(&self.cancel)?;
        let has_php = layout.has_composer() || !files.is_empty();
        *self.layout.write() = Some(layout);
        if !has_php && self.index.read().is_none() {
            self.set_state(EngineState::Inactive);
            return Ok(());
        }
        self.announce(if self.announced.load(Ordering::SeqCst) { ServerStatus::Busy } else { ServerStatus::Starting });
        self.set_state(EngineState::Indexing);
        let (_, declarations) = self.status_counts();
        self.begin_indexing(files.len() as u64, declarations);
        let index = self.open_index()?;
        let paths: Vec<PathBuf> = files.into_iter().map(|(path, _)| path).collect();
        let started = Instant::now();
        let stats = index.sync(&paths, &self.cancel)?;
        log_stats("scan", &stats, started);
        self.modification.fetch_add(1, Ordering::SeqCst);
        self.finish(&index)
    }

    /// Applies one watcher batch.
    fn apply(&self, changed: Vec<PathBuf>, removed: Vec<PathBuf>) -> IdeResult<()> {
        let layout = self.layout.read().clone();
        let Some(layout) = layout else { return self.scan() };
        if changed.iter().chain(&removed).any(|p| layout.is_manifest(p)) {
            return self.scan();
        }
        // A folder moved or copied in: its PHP files.
        let changed: Vec<PathBuf> =
            changed.into_iter().flat_map(|p| if p.is_dir() { php_files_in(&p) } else { vec![p] }).collect();
        let index = self.index.read().clone();
        let Some(index) = index else {
            // Inactive (or failed before the index opened): a PHP file of the
            // project appearing starts the engine.
            if changed.iter().any(|p| layout.origin_of(p).is_some()) {
                return self.scan();
            }
            return Ok(());
        };
        let mut update = Vec::new();
        let mut drop = Vec::new();
        for path in changed {
            if layout.origin_of(&path).is_some() {
                update.push(path);
            } else if is_php_path(&path) {
                // Excluded, or outside every autoload root: not indexed.
                drop.push(path);
            }
        }
        let folders: Vec<&PathBuf> = removed.iter().filter(|p| !is_php_path(p)).collect();
        if !folders.is_empty() {
            for file in index.files()? {
                if folders.iter().any(|folder| file.starts_with(folder)) {
                    drop.push(file);
                }
            }
        }
        drop.extend(removed.iter().filter(|p| is_php_path(p)).cloned());
        let started = Instant::now();
        let stats = index.update(&update, &drop, &self.cancel)?;
        log_stats("update", &stats, started);
        // Caches filled between the batch arriving and now saw the old index.
        self.modification.fetch_add(1, Ordering::SeqCst);
        let (files, declarations) = index.counts()?;
        let mut status = self.status.lock();
        status.files = files;
        status.declarations = declarations;
        if matches!(status.state, EngineState::Failed(_)) {
            status.state = EngineState::Ready;
        }
        std::mem::drop(status);
        self.inspect_open_documents();
        Ok(())
    }

    /// Other files' declarations changed: the open documents are inspected
    /// again.
    fn inspect_open_documents(&self) {
        let open: Vec<DocId> = self.documents.lock().values().filter(|d| !d.embedded).map(|d| d.doc).collect();
        for doc in open {
            self.inspections.schedule(doc);
        }
    }

    fn open_index(&self) -> IdeResult<Arc<PhpIndex>> {
        if let Some(index) = self.index.read().clone() {
            return Ok(index);
        }
        let index = Arc::new(PhpIndex::open(&self.cache_dir)?);
        self.status.lock().persistent = index.is_persistent();
        *self.index.write() = Some(index.clone());
        Ok(index)
    }

    fn finish(&self, index: &PhpIndex) -> IdeResult<()> {
        let (files, declarations) = index.counts()?;
        {
            let mut status = self.status.lock();
            status.files = files;
            status.declarations = declarations;
            status.state = EngineState::Ready;
        }
        self.indexing.store(false, Ordering::SeqCst);
        self.emit_index_state(false, files, declarations);
        self.announce(ServerStatus::Ready);
        self.inspect_open_documents();
        Ok(())
    }

    fn fail(&self, error: &IdeError) {
        tracing::warn!("php engine: {error}");
        self.set_state(EngineState::Failed(error.message.clone()));
        self.end_indexing();
        if self.announced.load(Ordering::SeqCst) {
            self.sink.emit(IdeEvent::LanguageServer {
                server: self.server,
                name: SERVER_NAME.into(),
                status: ServerStatus::Crashed,
                message: Some(error.message.clone()),
            });
        }
    }

    fn set_state(&self, state: EngineState) {
        self.status.lock().state = state;
    }

    fn status_counts(&self) -> (u64, u64) {
        let status = self.status.lock();
        (status.files, status.declarations)
    }

    fn announce(&self, status: ServerStatus) {
        self.announced.store(true, Ordering::SeqCst);
        self.sink.emit(IdeEvent::LanguageServer {
            server: self.server,
            name: SERVER_NAME.into(),
            status,
            message: None,
        });
    }

    fn begin_indexing(&self, files: u64, declarations: u64) {
        self.indexing.store(true, Ordering::SeqCst);
        self.emit_index_state(true, files, declarations);
    }

    /// Leaves dumb mode if a scan stopped half-way.
    fn end_indexing(&self) {
        if self.indexing.swap(false, Ordering::SeqCst) {
            let (files, declarations) = self.status_counts();
            self.emit_index_state(false, files, declarations);
        }
    }

    fn emit_index_state(&self, indexing: bool, files: u64, declarations: u64) {
        self.sink.emit(IdeEvent::IndexState {
            indexing,
            files: u32::try_from(files).unwrap_or(u32::MAX),
            symbols: u32::try_from(declarations).unwrap_or(u32::MAX),
        });
    }
}

/// The PHP files below `dir`; the layout decides which of them count.
fn php_files_in(dir: &Path) -> Vec<PathBuf> {
    let found = Mutex::new(Vec::new());
    ide_vfs::walk_files(dir, &[], |path| {
        if is_php_path(path) {
            found.lock().push(normalize(path));
        }
    });
    found.into_inner()
}

fn log_stats(what: &str, stats: &IndexStats, started: Instant) {
    tracing::info!(
        "php engine {what}: {} parsed, {} reused, {} rehashed, {} unchanged, {} removed in {} ms",
        stats.parsed,
        stats.reused,
        stats.rehashed,
        stats.unchanged,
        stats.removed,
        started.elapsed().as_millis()
    );
}
