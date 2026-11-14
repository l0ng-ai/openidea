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
//! modification count. What it reads from single files (configuration
//! keys, translations, routes, view folders) is kept per file ([`parts`]),
//! so a build after an edit reads only the files the edit touched.

pub(crate) mod parts;
#[cfg(test)]
mod tests;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ide_core::event::ServerStatus;
use ide_core::settings::{LaravelDetection, LaravelSettings};
use ide_core::{CancellationToken, DocId, IdeError, IdeEvent, IdeResult, Pos, ServerId, SharedSink};
use parking_lot::{Condvar, Mutex, RwLock};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::frameworks::laravel::{
    ArtisanCommands, AuthFacts, BladeCatalog, ConfigKeys, EnvKeys, InertiaPages, LaravelProject, LiveSchema,
    LivewireComponents, PartReader, RouteTable, Translations, ViewEntry, ViewTable, ViteAssets,
};
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

/// An open document's version before its first edit since its declarations
/// were last compared, and that version's summary when it was extracted.
type Unsettled = (OpenDocument, Option<Arc<FileSummary>>);

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
    /// Parts of the Laravel model are queued to be stored in the index
    /// database ([`parts`]).
    store_parts: bool,
    /// The worker is running a job (or hasn't looked at the queue yet).
    busy: bool,
    shutdown: bool,
}

impl Queue {
    fn has_work(&self) -> bool {
        self.rescan || self.store_parts || !self.changed.is_empty() || !self.removed.is_empty()
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
    /// Goes up when what other files see can have changed (the
    /// declarations of an open document, a file on disk): the type and
    /// framework caches are kept for it. An edit inside a function body
    /// leaves it alone ([`PhpEngine::settle_edits`]), as IntelliJ's
    /// out-of-code-block modification count does.
    modification: AtomicU64,
    /// Goes up with every edit of an open document, inside bodies too: for
    /// what is read from the bodies of other files (the variables
    /// controllers pass a view).
    edits: AtomicU64,
    /// Goes up when an edit inside a body moved declarations without
    /// changing them ([`PhpEngine::framework_count`]).
    moves: AtomicU64,
    /// Files written with the text their open buffer already holds (an
    /// editor's save): their index update changes nothing the engine
    /// answers from, so it neither drops the caches nor inspects again.
    saved: Mutex<std::collections::HashSet<PathBuf>>,
    /// The open documents edited since their declarations were last
    /// compared, with their version before the first such edit (and its
    /// summary, when it was extracted).
    unsettled: Mutex<HashMap<DocId, Unsettled>>,
    /// Goes up with every watcher batch, rescan and Laravel model reset:
    /// what is read only from files on disk that aren't open (folder
    /// listings, `.env`, Vite and Inertia files) is kept for it.
    disk: AtomicU64,
    /// The parts of the Laravel model read from single files
    /// ([`parts`]), and the views below each folder for a disk generation.
    parts: parts::FileParts,
    view_listings: Mutex<parts::FolderListings>,
    file_listings: Mutex<parts::FileListings>,
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
    /// The Laravel environment keys, translations and Vite assets, for a
    /// modification count.
    laravel_env: Mutex<Option<(u64, Arc<EnvKeys>)>>,
    laravel_lang: Mutex<Option<(u64, Arc<Translations>)>>,
    laravel_assets: Mutex<Option<(u64, Arc<ViteAssets>)>>,
    /// The Laravel gates and policies, for a modification count.
    laravel_auth: Mutex<Option<(u64, Arc<AuthFacts>)>>,
    /// The Artisan commands, for a modification count.
    laravel_artisan: Mutex<Option<(u64, Arc<ArtisanCommands>)>>,
    laravel_livewire: Mutex<Option<(u64, Arc<LivewireComponents>)>>,
    laravel_inertia: Mutex<Option<(u64, Arc<InertiaPages>)>>,
    /// The Laravel routes, for a modification count.
    laravel_routes: Mutex<Option<(u64, Arc<RouteTable>)>>,
    /// The Laravel views, for a modification count.
    laravel_views: Mutex<Option<(u64, Arc<ViewTable>)>>,
    /// The variables passed to each view file, for a modification count.
    view_variables: Mutex<ViewVariables>,
    /// The props of anonymous components' views, typed from their callers.
    component_props: Mutex<ViewVariables>,
    /// The Blade components and custom directives, for a modification count.
    laravel_blade: Mutex<Option<(u64, Arc<BladeCatalog>)>>,
    /// What Laravel support shows (Settings › PHP › Laravel).
    laravel_settings: Mutex<LaravelSettings>,
    /// The tables of the data source chosen in Settings › PHP › Laravel.
    live_schema: RwLock<Option<Arc<LiveSchema>>>,
    /// The user's edited Laravel generator templates, for the generators
    /// that aren't given them with the request (the in-model actions).
    laravel_templates: Mutex<crate::frameworks::laravel::generate::TemplateSet>,
}

/// The engine keeps the parts of the Laravel model read from single files
/// ([`parts`]): by the stamp of an open buffer's text (its hash) or of the
/// file on disk (its size and modification time). Parts read from files on
/// disk are stored in the index database too, for the next session.
impl PartReader for PhpEngine {
    fn part<T: Serialize + DeserializeOwned + Send + Sync + 'static>(
        &self,
        kind: &'static str,
        path: &Path,
        context: &str,
        build: &dyn Fn(&str) -> T,
    ) -> Option<Arc<T>> {
        let path = normalize(path);
        let parts = &self.shared.parts;
        let (stamp, text) = match self.open_document(&path) {
            Some(document) if !document.embedded => {
                (parts::Stamp::Buffer(*blake3::hash(document.text.as_bytes()).as_bytes()), Some(document.text))
            }
            _ => match std::fs::metadata(&path) {
                Ok(meta) if meta.is_file() => {
                    (parts::Stamp::Disk { len: meta.len(), modified: meta.modified().ok() }, None)
                }
                _ => {
                    parts.remove(&path);
                    return None;
                }
            },
        };
        if let Some(found) = parts.get::<T>(kind, &path, &stamp, context) {
            return Some(found);
        }
        // Stored by an earlier session: used when the file's size and
        // modification time are unchanged (without reading it), or its
        // content hash.
        let index = self.shared.index.read().clone().filter(|index| index.is_persistent());
        let stored = index
            .as_ref()
            .and_then(|index| index.model_part(kind, &path).ok().flatten())
            .filter(|stored| stored.context == context);
        let disk = match &stamp {
            parts::Stamp::Disk { len, modified } => Some((*len, modified.and_then(parts::nanos))),
            parts::Stamp::Buffer(_) => None,
        };
        if let (Some(stored), Some((len, mtime @ Some(_)))) = (&stored, disk)
            && stored.len == len
            && stored.mtime == mtime
            && let Ok(part) = postcard::from_bytes::<T>(&stored.part)
        {
            let part = Arc::new(part);
            parts.insert_loaded(kind, &path, stamp, context, part.clone());
            return Some(part);
        }
        let text: Arc<str> = match text {
            Some(text) => text,
            None => Arc::from(std::fs::read_to_string(&path).ok()?),
        };
        let hash = *blake3::hash(text.as_bytes()).as_bytes();
        if let Some(stored) = &stored
            && stored.hash == hash
            && let Ok(part) = postcard::from_bytes::<T>(&stored.part)
        {
            let part = Arc::new(part);
            if let Some((len, mtime)) = disk {
                // Same text, touched: stored again with the new stamp.
                parts.queue(kind, &path, crate::index::StoredPart { len, mtime, ..stored.clone() });
                self.shared.request_store();
            }
            parts.insert_loaded(kind, &path, stamp, context, part.clone());
            return Some(part);
        }
        let part = Arc::new(build(&text));
        if let (Some(_), Some((len, mtime))) = (&index, disk)
            && let Ok(bytes) = postcard::to_allocvec(&*part)
        {
            let stored = crate::index::StoredPart {
                schema: crate::index::MODEL_PARTS_SCHEMA,
                hash,
                len,
                mtime,
                context: context.to_owned(),
                part: bytes,
            };
            parts.queue(kind, &path, stored);
            self.shared.request_store();
        }
        parts.insert(kind, &path, stamp, context, part.clone());
        Some(part)
    }

    /// The files' parts in parallel: reading, parsing and (in a new session)
    /// taking them from the index database are independent per file.
    fn parts_of<T: Serialize + DeserializeOwned + Send + Sync + 'static>(
        &self,
        kind: &'static str,
        files: &[(PathBuf, String)],
        build: &(dyn Fn(usize, &str) -> T + Sync),
    ) -> Vec<Option<Arc<T>>> {
        use rayon::prelude::*;
        files
            .par_iter()
            .enumerate()
            .map(|(at, (path, context))| self.part(kind, path, context, &|text| build(at, text)))
            .collect()
    }

    fn views_below(
        &self,
        base: &Path,
        namespace: Option<&str>,
        list: &dyn Fn() -> Vec<ViewEntry>,
    ) -> Arc<Vec<ViewEntry>> {
        let disk = self.disk_generation();
        let key = (base.to_path_buf(), namespace.map(str::to_owned));
        if let Some((at, found)) = self.shared.view_listings.lock().get(&key)
            && *at == disk
        {
            return found.clone();
        }
        let found = Arc::new(list());
        self.shared.view_listings.lock().insert(key, (disk, found.clone()));
        found
    }

    fn listing(
        &self,
        kind: &'static str,
        dir: &Path,
        list: &dyn Fn() -> Vec<(String, PathBuf)>,
    ) -> Arc<Vec<(String, PathBuf)>> {
        let disk = self.disk_generation();
        let key = (kind, dir.to_path_buf());
        if let Some((at, found)) = self.shared.file_listings.lock().get(&key)
            && *at == disk
        {
            return found.clone();
        }
        let found = Arc::new(list());
        self.shared.file_listings.lock().insert(key, (disk, found.clone()));
        found
    }
}

/// The variables passed to view files: by file, for a modification count.
type ViewVariables = HashMap<PathBuf, (u64, Arc<Vec<(String, String)>>)>;

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
            edits: AtomicU64::new(0),
            moves: AtomicU64::new(0),
            saved: Mutex::new(std::collections::HashSet::new()),
            unsettled: Mutex::new(HashMap::new()),
            disk: AtomicU64::new(0),
            parts: parts::FileParts::default(),
            view_listings: Mutex::new(HashMap::new()),
            file_listings: Mutex::new(HashMap::new()),
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
            laravel_env: Mutex::new(None),
            laravel_lang: Mutex::new(None),
            laravel_assets: Mutex::new(None),
            laravel_auth: Mutex::new(None),
            laravel_artisan: Mutex::new(None),
            laravel_livewire: Mutex::new(None),
            laravel_inertia: Mutex::new(None),
            laravel_routes: Mutex::new(None),
            laravel_views: Mutex::new(None),
            view_variables: Mutex::new(HashMap::new()),
            component_props: Mutex::new(HashMap::new()),
            laravel_blade: Mutex::new(None),
            laravel_settings: Mutex::new(LaravelSettings::default()),
            live_schema: RwLock::new(None),
            laravel_templates: Mutex::new(Default::default()),
        });
        let worker = shared.clone();
        let thread = std::thread::Builder::new()
            .name("openidea-php-engine".into())
            .stack_size(crate::syntax::stack::PARSER_THREAD_STACK)
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

    /// Goes up when an open document's declarations change, and with every
    /// watcher batch: what is cached for one count holds for every file.
    /// Edits inside function bodies don't move it.
    pub fn modification_count(&self) -> u64 {
        self.settle_edits();
        self.shared.modification.load(Ordering::SeqCst)
    }

    /// Goes up with [`modification_count`](Self::modification_count) and
    /// with every edit of an open document, inside bodies too.
    pub fn edit_count(&self) -> u64 {
        self.modification_count() + self.shared.edits.load(Ordering::SeqCst)
    }

    /// Compares the declarations of the documents edited since the last
    /// call with those before the edits, and moves the modification count
    /// when they differ, when the file is a script (routes, config and
    /// translation files are read as text) or a service provider (read for
    /// its Blade directives and bindings), or when the document closed.
    fn settle_edits(&self) {
        let pending: Vec<(DocId, Unsettled)> = {
            let mut unsettled = self.shared.unsettled.lock();
            if unsettled.is_empty() {
                return;
            }
            unsettled.drain().collect()
        };
        for (doc, (before, old)) in pending {
            let Some(current) = self.shared.documents.lock().get(&doc).cloned() else {
                self.shared.modification.fetch_add(1, Ordering::SeqCst);
                continue;
            };
            if current.version == before.version {
                continue;
            }
            // The old version is parsed apart: the cache holds the current one.
            let old = old.unwrap_or_else(|| {
                let name = format!("{}#{}", before.path.display(), before.version);
                Arc::new(FileSummary::extract(&ParsedFile::parse(&name, before.text.clone())))
            });
            let new = self.open_summary(&current);
            let same = same_declarations(&old, &new)
                && old.laravel == new.laravel
                && old.symfony == new.symfony
                && old.meta == new.meta
                && old.class_likes.len() == new.class_likes.len();
            if !same {
                self.shared.modification.fetch_add(1, Ordering::SeqCst);
                // What the other open files call may have appeared or gone.
                self.shared.inspect_open_documents_but(Some(doc));
                continue;
            }
            // Same declarations, some of them moved: only the models holding
            // their positions are dropped (and what framework support read
            // from the classes, which holds positions too).
            let moved: Vec<String> = old
                .class_likes
                .iter()
                .zip(&new.class_likes)
                .filter(|(was, now)| was != now)
                .map(|(_, now)| now.fqn.clone())
                .collect();
            if !moved.is_empty() {
                let generation = self.shared.modification.load(Ordering::SeqCst);
                self.shared.types.forget_classes(generation, &moved);
                self.shared.moves.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    /// The count Laravel and Symfony support cache what they read from
    /// classes for: [`modification_count`](Self::modification_count), and
    /// moved declarations too (their caches keep positions).
    pub(crate) fn framework_count(&self) -> u64 {
        self.modification_count() + self.shared.moves.load(Ordering::SeqCst)
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
        self.shared.disk.fetch_add(1, Ordering::SeqCst);
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
        if !changed.is_empty() || !removed.is_empty() {
            // Files were written, created or removed: folders are listed
            // again, and the parts read from these files are read again.
            self.shared.disk.fetch_add(1, Ordering::SeqCst);
            let touched: Vec<PathBuf> = changed.iter().chain(removed).map(|p| normalize(p)).collect();
            self.shared.parts.forget_below(&touched);
        }
        if changed.iter().chain(removed).any(|p| is_yaml_path(p) || p.ends_with("config")) {
            // The Symfony configuration is read again on next use.
            *self.shared.symfony_config.lock() = None;
            self.shared.modification.fetch_add(1, Ordering::SeqCst);
            self.shared.inspect_open_documents();
        }
        if changed.iter().chain(removed).any(|p| is_laravel_data(p)) {
            // `.env`, JSON translations, the Vite config or manifest: the
            // models built from them are read again on next use.
            self.shared.modification.fetch_add(1, Ordering::SeqCst);
            self.shared.inspect_open_documents();
        }
        if changed.iter().any(|p| is_laravel_input(p) || p.is_dir()) || removed.iter().any(|p| !is_php_path(p)) {
            // Detection, paths and modules are read again on next use.
            self.reset_laravel_cache();
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
        // An editor saving an open document: the engine already answers from
        // that text.
        let saves: Vec<&PathBuf> = changed
            .iter()
            .filter(|path| {
                self.open_document(path).is_some_and(|document| {
                    !document.embedded && std::fs::read_to_string(path).is_ok_and(|disk| *disk == *document.text)
                })
            })
            .collect();
        let only_saves = removed.is_empty() && saves.len() == changed.len();
        self.shared.saved.lock().extend(saves.into_iter().cloned());
        if !only_saves {
            self.shared.modification.fetch_add(1, Ordering::SeqCst);
        }
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
        let before = document.clone();
        document.version = version;
        document.text = Arc::from(text);
        drop(documents);
        // Whether other files see a change is decided when a cache next asks
        // (`settle_edits`), not on every keystroke.
        let old =
            self.shared.open_summaries.lock().get(&doc).filter(|(v, _)| *v == before.version).map(|(_, s)| s.clone());
        self.shared.unsettled.lock().entry(doc).or_insert((before, old));
        self.shared.edits.fetch_add(1, Ordering::SeqCst);
        self.shared.inspections.schedule(doc);
    }

    /// The editor closed the document: the file on disk counts again.
    pub fn document_closed(&self, doc: DocId) {
        let Some(closed) = self.shared.documents.lock().remove(&doc) else { return };
        self.shared.inspections.closed(doc, &self.shared.sink);
        self.shared.parses.remove(doc);
        self.shared.open_summaries.lock().remove(&doc);
        self.shared.modification.fetch_add(1, Ordering::SeqCst);
        // Closed unsaved, the other open files see the file on disk again;
        // edited since its declarations were last compared (saved and closed
        // before its own inspection ran), they may not have seen the edit.
        let edited = self.shared.unsettled.lock().remove(&doc).is_some();
        let unsaved =
            !closed.embedded && std::fs::read_to_string(&closed.path).map_or(true, |disk| *disk != *closed.text);
        if edited || unsaved {
            self.shared.inspect_open_documents();
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
    ///
    /// Settings › PHP › Laravel can force detection on or off and limit the
    /// modules read ([`PhpEngine::set_laravel_settings`]).
    pub fn laravel(&self) -> Option<Arc<LaravelProject>> {
        let modification = self.framework_count();
        let settings = self.laravel_settings();
        if settings.detection == LaravelDetection::Disabled {
            return None;
        }
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
                let force = settings.detection == LaravelDetection::Enabled;
                let root = self.root();
                // The resolver's facts (read from the index's summaries) are
                // needed right after: built at the same time when the
                // project looks like a Laravel one (roadmap phase 9.8.b).
                let (loaded, _) = rayon::join(
                    || LaravelProject::load_with(&root, force).map(Arc::new),
                    || (force || root.join("artisan").is_file()).then(|| self.resolver().laravel()),
                );
                self.shared.laravel.lock().loaded = Some(loaded.clone());
                loaded
            }
        };
        let project = loaded.map(|loaded| {
            // The resolver's facts for this modification count: the type
            // providers read the same ones.
            let facts = self.resolver().laravel();
            // Route files at `config('…')`-computed paths (Jetstream) need the
            // configuration, read here from the project as loaded:
            // `laravel_config` needs this project.
            let config = facts.routes.iter().any(|route| route.path.has_config()).then(|| {
                let packages = crate::frameworks::laravel::config::package_configs_with(&loaded, self);
                let previous = self.shared.laravel_config.lock().as_ref().map(|(_, keys)| keys.clone());
                let keys = ConfigKeys::read_parts(&loaded.paths.config, &packages, self, previous.as_deref());
                (packages, Arc::new(keys))
            });
            let project = Arc::new(
                loaded
                    .with_routes_config(&facts, config.as_ref().map(|(_, keys)| &**keys))
                    .with_module_system(settings.modules),
            );
            // The same configuration is `laravel_config`'s when the project
            // names the same package files (roadmap phase 9.4: it was read
            // twice).
            if let Some((packages, keys)) = config
                && crate::frameworks::laravel::config::package_configs_with(&project, self) == packages
            {
                *self.shared.laravel_config.lock() = Some((modification, keys));
            }
            project
        });
        let mut cache = self.shared.laravel.lock();
        if cache.loaded.is_some() {
            cache.project = Some((modification, project.clone()));
        }
        project
    }

    /// The class a Laravel global alias (`DB`, `\Str`) stands for, in a
    /// Laravel project. Read from the project as loaded, without building
    /// its routes.
    pub(crate) fn laravel_class_alias(&self, name: &str) -> Option<String> {
        if name.trim_start_matches('\\').contains('\\') {
            return None;
        }
        let loaded = self.shared.laravel.lock().loaded.clone();
        let project = match loaded {
            Some(loaded) => loaded,
            None => self.laravel(),
        }?;
        project.class_alias(name).map(str::to_owned)
    }

    /// Drops the Laravel project model with what it read from files that
    /// aren't PHP, and moves the modification count so every part built
    /// from it is built again.
    pub(crate) fn reset_laravel_cache(&self) {
        *self.shared.laravel.lock() = LaravelCache::default();
        self.shared.disk.fetch_add(1, Ordering::SeqCst);
        self.shared.modification.fetch_add(1, Ordering::SeqCst);
    }

    /// [`reset_laravel_cache`](Self::reset_laravel_cache), and drops the
    /// parts read from single files too: everything is read again.
    pub(crate) fn forget_laravel_parts(&self) {
        {
            let _storing = self.shared.parts.store_lock.lock();
            self.shared.parts.clear();
            if let Some(index) = self.shared.index.read().clone()
                && let Err(e) = index.clear_model_parts()
            {
                tracing::warn!("php engine: dropping the stored Laravel model: {e}");
            }
        }
        self.shared.view_listings.lock().clear();
        self.shared.file_listings.lock().clear();
        self.reset_laravel_cache();
    }

    /// Goes up with every watcher batch, rescan and Laravel model reset.
    pub fn disk_generation(&self) -> u64 {
        self.shared.disk.load(Ordering::SeqCst)
    }

    /// The files read into parts of the Laravel model so far, as `(kind,
    /// path)`, in order: tests check that a build reads only what changed.
    pub fn laravel_part_reads(&self) -> Vec<(&'static str, PathBuf)> {
        self.shared.parts.reads()
    }

    /// The parts of the Laravel model taken from the index database so far
    /// (stored by an earlier session), as `(kind, path)`, in order.
    pub fn laravel_part_loads(&self) -> Vec<(&'static str, PathBuf)> {
        self.shared.parts.loads()
    }

    /// How many parts of the Laravel model the index database holds (0
    /// without one).
    pub fn laravel_stored_parts(&self) -> u64 {
        let index = self.shared.index.read().clone();
        index.and_then(|index| index.model_part_count().ok()).unwrap_or(0)
    }

    /// The configuration keys of the Laravel project (`config/*.php`, open
    /// buffers first), or `None` when the project isn't a Laravel project.
    /// Read again when the modification count moves.
    pub fn laravel_config(&self) -> Option<Arc<ConfigKeys>> {
        let modification = self.framework_count();
        if let Some((at, keys)) = &*self.shared.laravel_config.lock()
            && *at == modification
        {
            return Some(keys.clone());
        }
        let project = self.laravel()?;
        let packages = crate::frameworks::laravel::config::package_configs_with(&project, self);
        let previous = self.shared.laravel_config.lock().as_ref().map(|(_, keys)| keys.clone());
        let keys = Arc::new(ConfigKeys::read_parts(&project.paths.config, &packages, self, previous.as_deref()));
        *self.shared.laravel_config.lock() = Some((modification, keys.clone()));
        Some(keys)
    }

    /// The text of the file `path`: its open buffer (not an embedded one),
    /// else the file on disk.
    pub(crate) fn text_of(&self, path: &Path) -> Option<String> {
        match self.open_document(path) {
            Some(document) if !document.embedded => Some(document.text.to_string()),
            _ => std::fs::read_to_string(path).ok(),
        }
    }

    /// A Laravel model in `slot` for the current modification count, built
    /// by `build` when it is older; `None` outside Laravel projects.
    fn laravel_cached<T>(
        &self,
        slot: &Mutex<Option<(u64, Arc<T>)>>,
        build: impl FnOnce(&LaravelProject) -> T,
    ) -> Option<Arc<T>> {
        self.laravel_cached_for(self.framework_count(), slot, |project, _| build(project))
    }

    /// [`laravel_cached`](Self::laravel_cached) for `generation` (a
    /// modification count or a disk generation); `build` gets the model it
    /// replaces, if any.
    fn laravel_cached_for<T>(
        &self,
        generation: u64,
        slot: &Mutex<Option<(u64, Arc<T>)>>,
        build: impl FnOnce(&LaravelProject, Option<&T>) -> T,
    ) -> Option<Arc<T>> {
        let previous = match &*slot.lock() {
            Some((at, found)) if *at == generation => return Some(found.clone()),
            Some((_, found)) => Some(found.clone()),
            None => None,
        };
        let project = self.laravel()?;
        let found = Arc::new(build(&project, previous.as_deref()));
        *slot.lock() = Some((generation, found.clone()));
        Some(found)
    }

    /// The keys of the Laravel project's `.env` and `.env.example`, or
    /// `None` when the project isn't a Laravel project.
    pub fn laravel_env(&self) -> Option<Arc<EnvKeys>> {
        // Only files on disk: read again after a watcher batch.
        self.laravel_cached_for(self.disk_generation(), &self.shared.laravel_env, |project, _| {
            EnvKeys::read(&project.root, |path| std::fs::read_to_string(path).ok())
        })
    }

    /// The translation keys of the Laravel project (`lang/`, open buffers
    /// first), or `None` when the project isn't a Laravel project.
    pub fn laravel_translations(&self) -> Option<Arc<Translations>> {
        self.laravel_cached_for(self.framework_count(), &self.shared.laravel_lang, |project, previous| {
            Translations::read_parts(project, self, previous)
        })
    }

    /// The Vite entry points, manifest and asset files of the Laravel
    /// project, or `None` when the project isn't a Laravel project.
    pub fn laravel_assets(&self) -> Option<Arc<ViteAssets>> {
        // Only files on disk: read again after a watcher batch.
        self.laravel_cached_for(self.disk_generation(), &self.shared.laravel_assets, |project, _| {
            ViteAssets::read(&project.root, &project.paths.resources, |path| std::fs::read_to_string(path).ok())
        })
    }

    /// The gates and policies of the Laravel project's service providers and
    /// policy folders (open buffers first), or `None` when the project isn't a
    /// Laravel project.
    pub fn laravel_auth(&self) -> Option<Arc<AuthFacts>> {
        self.laravel_cached(&self.shared.laravel_auth, |project| AuthFacts::read_parts(project, self))
    }

    /// The Artisan commands of the Laravel project (its command classes,
    /// `routes/console.php` closures and Laravel's own commands), or `None`
    /// when the project isn't a Laravel project.
    pub fn laravel_artisan(&self) -> Option<Arc<ArtisanCommands>> {
        self.laravel_cached(&self.shared.laravel_artisan, |project| ArtisanCommands::read(self, project))
    }

    /// The Livewire components of the Laravel project (empty without
    /// Livewire), or `None` when the project isn't a Laravel project.
    pub fn laravel_livewire(&self) -> Option<Arc<LivewireComponents>> {
        let views = self.laravel_views()?;
        self.laravel_cached(&self.shared.laravel_livewire, |project| LivewireComponents::read(self, project, &views))
    }

    /// The Inertia pages of the Laravel project (empty without Inertia), or
    /// `None` when the project isn't a Laravel project.
    pub fn laravel_inertia(&self) -> Option<Arc<InertiaPages>> {
        // Page files and `package.json` aren't PHP: read again after a
        // watcher batch, or a settings change (which resets the model).
        self.laravel_cached_for(self.disk_generation(), &self.shared.laravel_inertia, |project, _| {
            let dirs = self.laravel_settings().inertia_pages;
            InertiaPages::read_with(project, &dirs, self.text_of(&project.root.join("package.json")).as_deref())
        })
    }

    /// The routes and middleware of the Laravel project (its route files,
    /// open buffers first), or `None` when the project isn't a Laravel
    /// project. Read again when the modification count moves.
    pub fn laravel_routes(&self) -> Option<Arc<RouteTable>> {
        let modification = self.framework_count();
        if let Some((at, routes)) = &*self.shared.laravel_routes.lock()
            && *at == modification
        {
            return Some(routes.clone());
        }
        let project = self.laravel()?;
        let routes = Arc::new(RouteTable::read_parts(&project, self));
        *self.shared.laravel_routes.lock() = Some((modification, routes.clone()));
        Some(routes)
    }

    /// The views of the Laravel project (`resources/views`, the modules'
    /// and the registered namespaces' folders), or `None` when the project
    /// isn't a Laravel project. Read again when the modification count
    /// moves.
    pub fn laravel_views(&self) -> Option<Arc<ViewTable>> {
        let modification = self.framework_count();
        if let Some((at, views)) = &*self.shared.laravel_views.lock()
            && *at == modification
        {
            return Some(views.clone());
        }
        let project = self.laravel()?;
        let views = Arc::new(ViewTable::read_parts(&project, self));
        *self.shared.laravel_views.lock() = Some((modification, views.clone()));
        Some(views)
    }

    /// The Blade components and custom directives of the Laravel project,
    /// or `None` when the project isn't a Laravel project. Read again when
    /// the modification count moves.
    pub fn laravel_blade(&self) -> Option<Arc<BladeCatalog>> {
        let modification = self.framework_count();
        if let Some((at, catalog)) = &*self.shared.laravel_blade.lock()
            && *at == modification
        {
            return Some(catalog.clone());
        }
        let project = self.laravel()?;
        let views = self.laravel_views()?;
        let class_file = |class: &str| self.class_targets(class).into_iter().next().map(|target| target.path);
        let catalog = BladeCatalog::read_parts(&project, &views, self).with_registrations(
            &project,
            &views,
            self,
            class_file,
            |namespace| self.namespace_classes(namespace),
        );
        let catalog = Arc::new(catalog.with_ide_json(&project.ide_json, class_file));
        *self.shared.laravel_blade.lock() = Some((modification, catalog.clone()));
        Some(catalog)
    }

    /// The cache of [`PhpEngine::laravel_view_variables`].
    pub(crate) fn view_variables_cache(&self) -> &Mutex<ViewVariables> {
        &self.shared.view_variables
    }

    pub(crate) fn component_props_cache(&self) -> &Mutex<ViewVariables> {
        &self.shared.component_props
    }

    /// What Laravel support shows.
    pub fn laravel_settings(&self) -> LaravelSettings {
        self.shared.laravel_settings.lock().clone()
    }

    /// The user's edited Laravel generator templates
    /// ([`PhpEngine::set_laravel_templates`]).
    pub fn laravel_templates(&self) -> crate::frameworks::laravel::generate::TemplateSet {
        self.shared.laravel_templates.lock().clone()
    }

    /// Keeps the user's edited Laravel generator templates (the front end
    /// sends them when they change, and with each generator request).
    pub fn set_laravel_templates(&self, templates: crate::frameworks::laravel::generate::TemplateSet) {
        *self.shared.laravel_templates.lock() = templates;
    }

    /// Changes what Laravel support shows (the front end's settings). When
    /// detection, the modules or the Inertia page folders change, the
    /// project model is read again and open documents are inspected again.
    pub fn set_laravel_settings(&self, settings: LaravelSettings) {
        let model_changed = {
            let mut current = self.shared.laravel_settings.lock();
            let changed = current.detection != settings.detection
                || current.modules != settings.modules
                || current.inertia_pages != settings.inertia_pages;
            *current = settings;
            changed
        };
        if model_changed {
            *self.shared.laravel.lock() = LaravelCache::default();
            self.shared.disk.fetch_add(1, Ordering::SeqCst);
            self.shared.modification.fetch_add(1, Ordering::SeqCst);
            self.shared.inspect_open_documents();
        }
    }

    /// Uses the tables and columns of a live database (Settings › PHP ›
    /// Laravel) along with the migrations, the database winning; `None`
    /// goes back to the migrations alone. Open documents are inspected
    /// again.
    pub fn set_live_schema(&self, schema: Option<LiveSchema>) {
        {
            let mut current = self.shared.live_schema.write();
            if current.as_deref() == schema.as_ref() {
                return;
            }
            *current = schema.map(Arc::new);
        }
        self.shared.modification.fetch_add(1, Ordering::SeqCst);
        self.shared.inspect_open_documents();
    }

    /// The live database schema in use ([`PhpEngine::set_live_schema`]).
    pub fn live_schema(&self) -> Option<Arc<LiveSchema>> {
        self.shared.live_schema.read().clone()
    }

    /// Every open document.
    pub fn open_documents(&self) -> Vec<OpenDocument> {
        self.shared.documents.lock().values().cloned().collect()
    }

    /// The parse of an open document's current version.
    pub(crate) fn parse_open(&self, document: &OpenDocument) -> Arc<ParsedFile> {
        self.shared.parses.get_or_parse(document.doc, document.version, || document.text.clone())
    }

    /// The path of the open document `parsed` is the current parse of.
    pub(crate) fn parsed_path(&self, parsed: &ParsedFile) -> Option<PathBuf> {
        self.document_path(self.shared.parses.doc_of(parsed)?)
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

/// How many files a call-site lookup reads for one parameter.
const CALL_SITE_FILES: usize = 16;

/// Project declarations from the open buffers and the indexes, then the
/// bundled stubs.
impl Declarations for PhpEngine {
    /// A Laravel global alias (`DB::table()` in a file without a namespace)
    /// is the class it stands for.
    fn class_like(&self, fqn: &str) -> Option<ClassLike> {
        self.project_declaration(NameKind::ClassLike, fqn, |summary| summary.class_like(fqn).cloned())
            .or_else(|| self.stubs().class_like(fqn).map(|(_, class)| class.clone()))
            .or_else(|| {
                // Namespaced targets only, so aliases can't chain or loop.
                let class = self.laravel_class_alias(fqn).filter(|class| class.contains('\\'))?;
                self.class_like(&class)
            })
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
        // Decoded in parallel: hundreds of summaries on a new session
        // (roadmap phase 9.8.b).
        let mut summaries: Vec<(PathBuf, Arc<FileSummary>)> = {
            use rayon::prelude::*;
            indexed.par_iter().filter_map(|path| Some((path.clone(), self.shared_summary(path).ok()??))).collect()
        };
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
        let mut facts = LaravelFacts::merge_located(
            summaries.iter().map(|(path, summary)| (Some(path.as_path()), &summary.laravel)),
        );
        if let Some(live) = self.shared.live_schema.read().clone() {
            live.merge_into(&mut facts);
        }
        facts
    }

    /// The user models of the guards of `config/auth.php`; none outside a
    /// Laravel project.
    fn user_models(&self) -> crate::frameworks::laravel::auth::UserModels {
        match self.laravel_config() {
            Some(config) => crate::frameworks::laravel::auth::user_models(&config, &|path| self.text_of(path)),
            None => Default::default(),
        }
    }

    /// Reads the files of the class and of its subclasses (at most
    /// [`CALL_SITE_FILES`]), and for a public method the indexed files
    /// naming it when they are no more than that.
    fn call_site_types(&self, site: &crate::types::expr::CallSiteParam<'_>, public: bool, depth: u8) -> Vec<Type> {
        let Some(index) = self.index() else { return Vec::new() };
        let mut files: Vec<PathBuf> = Vec::new();
        let add = |path: PathBuf, files: &mut Vec<PathBuf>| {
            if !files.contains(&path) {
                files.push(path);
            }
        };
        // A function has no hierarchy: only the files naming it.
        let mut classes = if site.class.is_empty() { Vec::new() } else { vec![site.class.to_owned()] };
        let mut next = 0;
        while next < classes.len() && classes.len() <= CALL_SITE_FILES {
            let class = classes[next].clone();
            next += 1;
            for decl in index.declarations(NameKind::ClassLike, &class).unwrap_or_default() {
                add(decl.path(), &mut files);
            }
            for decl in index.direct_subclasses(&class).unwrap_or_default() {
                if !classes.contains(&decl.fqn) {
                    classes.push(decl.fqn);
                }
            }
        }
        if public {
            let short = site.method.rsplit('\\').next().unwrap_or(site.method);
            let naming = index.files_with_word(short).unwrap_or_default();
            if naming.len() <= CALL_SITE_FILES {
                for path in naming {
                    add(path, &mut files);
                }
            }
        }
        files.truncate(CALL_SITE_FILES);
        let documents = self.open_documents();
        let resolver = self.resolver();
        let mut out = Vec::new();
        for path in files {
            if crate::frameworks::laravel::views::is_blade(&path) {
                continue;
            }
            let open = documents.iter().find(|document| document.path == path);
            let parsed = match open {
                Some(document) => self.parse_open(document),
                None => {
                    let Ok(text) = std::fs::read_to_string(&path) else { continue };
                    Arc::new(ParsedFile::parse(&crate::index::path_key(&path), text.as_str()))
                }
            };
            let names = crate::names::FileNames::resolve(&parsed);
            let summary = FileSummary::extract(&parsed);
            let types = crate::types::ExprTypes::new(&parsed, &names, &summary, &resolver)
                .at_path(Some(&path))
                .with_call_site_depth(depth);
            crate::types::expr::call_site_arguments(&types, site, &mut out);
        }
        out
    }

    /// Reads the file declaring the class (its open buffer first), or the
    /// function `method` when `class` is empty.
    fn body_return(&self, class: &str, method: &str, depth: u8) -> Option<Type> {
        let index = self.index()?;
        let documents = self.open_documents();
        let resolver = self.resolver();
        let (kind, name) = if class.is_empty() { (NameKind::Function, method) } else { (NameKind::ClassLike, class) };
        for decl in index.declarations(kind, name).unwrap_or_default() {
            let path = decl.path();
            let open = documents.iter().find(|document| document.path == path);
            let parsed = match open {
                Some(document) => self.parse_open(document),
                None => {
                    let Ok(text) = std::fs::read_to_string(&path) else { continue };
                    Arc::new(ParsedFile::parse(&crate::index::path_key(&path), text.as_str()))
                }
            };
            let names = crate::names::FileNames::resolve(&parsed);
            let summary = FileSummary::extract(&parsed);
            let types = crate::types::ExprTypes::new(&parsed, &names, &summary, &resolver)
                .at_path(Some(&path))
                .with_call_site_depth(depth);
            let found =
                if class.is_empty() { types.function_body_return(method) } else { types.body_return(class, method) };
            if found.is_some() {
                return found;
            }
        }
        None
    }

    /// From the index (open buffers not saved yet aren't looked at).
    fn classes_named(&self, name: &str) -> Vec<String> {
        let found = self.index().and_then(|index| index.by_short_name(name).ok()).unwrap_or_default();
        found
            .into_iter()
            .filter(|decl| matches!(decl.kind, crate::index::DeclKind::ClassLike(_)))
            .map(|decl| decl.fqn)
            .collect()
    }

    /// From the index (open buffers not saved yet aren't looked at).
    fn direct_subclasses(&self, fqn: &str) -> Vec<String> {
        let found = self.index().and_then(|index| index.direct_subclasses(fqn).ok()).unwrap_or_default();
        found.into_iter().map(|decl| decl.fqn).collect()
    }

    /// The macros of the indexed files registering some (their open
    /// buffers first) and of open buffers not indexed as such, in path
    /// order.
    fn macros(&self) -> Vec<crate::summary::Macro> {
        let indexed = self.index().and_then(|index| index.macro_files().ok()).unwrap_or_default();
        let mut summaries: Vec<(PathBuf, Arc<FileSummary>)> =
            indexed.iter().filter_map(|path| Some((path.clone(), self.shared_summary(path).ok()??))).collect();
        let open: Vec<OpenDocument> = self.shared.documents.lock().values().cloned().collect();
        for document in open {
            if !indexed.contains(&document.path) {
                let summary = self.open_summary(&document);
                if !summary.laravel.macros.is_empty() {
                    summaries.push((document.path.clone(), summary));
                }
            }
        }
        summaries.sort_by(|a, b| a.0.cmp(&b.0));
        summaries
            .iter()
            .flat_map(|(path, summary)| {
                summary
                    .laravel
                    .macros
                    .iter()
                    .map(|found| crate::summary::Macro { file: Some(path.clone()), ..found.clone() })
            })
            .collect()
    }

    /// The configuration, then the facts of the indexed files that have
    /// some (their open buffers first) and of open buffers not indexed
    /// yet, in path order.
    fn symfony(&self) -> SymfonyProject {
        let indexed = self.index().and_then(|index| index.symfony_files().ok()).unwrap_or_default();
        // Decoded in parallel: hundreds of summaries on a new session
        // (roadmap phase 9.8.b).
        let mut summaries: Vec<(PathBuf, Arc<FileSummary>)> = {
            use rayon::prelude::*;
            indexed.par_iter().filter_map(|path| Some((path.clone(), self.shared_summary(path).ok()??))).collect()
        };
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

/// A file the Laravel project model reads when it loads: files that
/// aren't PHP (and `artisan`, which has no extension), and the PHP files
/// listing service providers, or registering more (a service provider).
fn is_laravel_input(path: &Path) -> bool {
    let provider = path.file_name().and_then(|n| n.to_str()).is_some_and(|name| name.ends_with("Provider.php"))
        || path.ends_with("bootstrap/providers.php")
        || path.ends_with("config/app.php")
        || path.ends_with("config/concord.php");
    provider
        || matches!(
            path.file_name().and_then(|n| n.to_str()),
            Some(
                "composer.json"
                    | "composer.lock"
                    | "installed.json"
                    | "module.json"
                    | "modules_statuses.json"
                    | "artisan"
                    | "ide.json"
            )
        )
        || path.ends_with("config/modules.php")
}

/// Files that aren't PHP but feed Laravel string references: `.env`
/// files, JSON translations, Vite's config and build manifest.
fn is_laravel_data(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    name.starts_with(".env")
        || name.starts_with("vite.config.")
        || name == "manifest.json"
        || (name.ends_with(".json") && path.components().any(|part| part.as_os_str() == "lang"))
}

fn is_manifest_name(path: &Path) -> bool {
    matches!(path.file_name().and_then(|n| n.to_str()), Some("composer.json" | "installed.json"))
}

// ------------------------------------------------------------------ worker

struct Job {
    rescan: bool,
    store_parts: bool,
    changed: Vec<PathBuf>,
    removed: Vec<PathBuf>,
}

impl Shared {
    fn run(self: Arc<Self>) {
        while let Some(job) = self.next_job() {
            if job.store_parts {
                self.store_parts();
            }
            if !job.rescan && job.changed.is_empty() && job.removed.is_empty() {
                continue;
            }
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
            store_parts: std::mem::take(&mut q.store_parts),
            changed: std::mem::take(&mut q.changed).into_iter().collect(),
            removed: std::mem::take(&mut q.removed).into_iter().collect(),
        };
        Some(job)
    }

    /// Asks the worker to store the queued parts of the Laravel model.
    fn request_store(&self) {
        let mut q = self.queue.lock();
        if !q.store_parts && !q.shutdown {
            q.store_parts = true;
            self.wake.notify_all();
        }
    }

    /// Stores the queued parts of the Laravel model in the index database,
    /// in one transaction.
    fn store_parts(&self) {
        let _storing = self.parts.store_lock.lock();
        let pending = self.parts.take_pending();
        let Some(index) = self.index.read().clone() else { return };
        if let Err(e) = index.store_model_parts(&pending) {
            tracing::warn!("php engine: storing the Laravel model: {e}");
        }
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
        let only_saves = {
            let mut saved = self.saved.lock();
            let only = drop.is_empty() && update.iter().all(|path| saved.contains(&normalize(path)));
            for path in &update {
                saved.remove(&normalize(path));
            }
            only
        };
        if only_saves {
            // Open buffers saved: what the engine answers from didn't change.
            let (files, declarations) = index.counts()?;
            let mut status = self.status.lock();
            status.files = files;
            status.declarations = declarations;
            return Ok(());
        }
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
        self.inspect_open_documents_but(None);
    }

    /// [`inspect_open_documents`](Self::inspect_open_documents), but for
    /// `except` (the document whose edit changed them, inspected already).
    fn inspect_open_documents_but(&self, except: Option<DocId>) {
        let open: Vec<DocId> =
            self.documents.lock().values().filter(|d| !d.embedded && Some(d.doc) != except).map(|d| d.doc).collect();
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

/// Whether two versions of a file declare the same things to other files:
/// their summaries equal but for positions (an edit in one body moves the
/// declarations after it) and the parse error flag. A script (no class or
/// function: routes, config, translations) and a service provider are
/// never the same, as framework support reads their code, not just their
/// declarations.
fn same_declarations(old: &FileSummary, new: &FileSummary) -> bool {
    let script = |s: &FileSummary| s.class_likes.is_empty() && s.functions.is_empty();
    let provider = |s: &FileSummary| {
        s.class_likes.iter().any(|class| class.extends.iter().any(|parent| parent.ends_with("ServiceProvider")))
    };
    if script(old) || script(new) || provider(old) || provider(new) {
        return false;
    }
    match (serde_json::to_value(old), serde_json::to_value(new)) {
        (Ok(mut old), Ok(mut new)) => {
            without_positions(&mut old);
            without_positions(&mut new);
            old == new
        }
        _ => false,
    }
}

/// Drops every [`Loc`](crate::summary::Loc) (an object of exactly `start`,
/// `end` and `range`) and the `has_errors` flag from a serialized summary.
fn without_positions(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.remove("has_errors");
            for field in map.values_mut() {
                let is_loc = field.as_object().is_some_and(|loc| {
                    loc.len() == 3 && loc.contains_key("start") && loc.contains_key("end") && loc.contains_key("range")
                });
                if is_loc {
                    *field = serde_json::Value::Null;
                } else {
                    without_positions(field);
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(without_positions),
        _ => {}
    }
}
