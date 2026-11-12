//! Language server manager.
//!
//! Servers start lazily per `(server name, workspace root)` when a document of
//! a matching language opens. Several servers may serve one language (e.g.
//! `vtsls` + `eslint`); results are merged. Every request takes positions in
//! IDE coordinates (UTF-16, 0-based) and returns IDE types from [`types`],
//! never `lsp-types`, so the IPC surface stays stable.

mod angular;
mod arduino;
mod caps;
mod clang_tidy;
mod compose;
mod convert;
mod external_project;
mod file_ops;
mod file_watch;
mod go_mod;
mod go_scope;
mod handler;
mod injections;
mod inspect;
pub mod jdtls;
mod kotlin_lsp;
mod launch;
mod library_source;
mod loading;
mod notebook;
mod pull;
mod scope;
mod server;
mod tcp;
mod text;
mod ts_file_moves;
mod tsserver_bridge;
pub mod types;
mod uri;
mod virtual_doc;
mod vue_navigation;

pub use injections::{InjectedRange, InjectionProvider, MAX_INJECTED_DOCUMENT_BYTES};
pub use inspect::{FileInspection, InspectHost, InspectOptions};
pub use jdtls::jvm_inspect::JdtJvmInspector;
pub use kotlin_lsp::{KotlinDebugServer, KotlinDebugUnavailable};
pub use launch::{LaunchError, Launcher, ProcessLauncher};
pub use notebook::{NotebookCell, NotebookCellDoc, cell_uri};
pub use scope::{CandidateFiles, CandidateFn, CandidateQuery, MAX_CANDIDATES};
pub use uri::{is_virtual_uri, path_to_uri_string, uri_target, uri_to_path};

use caps::{ServerCaps, SyncKind};
use convert::{Conv, lsp_range};
use futures::StreamExt;
use futures::future::join_all;
use ide_core::error::ErrorKind;
use ide_core::{
    CancellationToken, DocId, IdeError, IdeResult, LanguageId, Location, OutlineItem, Pos, Range, SharedSink, TextEdit,
    WorkspaceEdit,
};
use ide_jsonrpc::RpcError;
use ide_language::{LanguageRegistry, LanguageServerConfig};
use ide_text::AppliedChange;
use lsp_types as lsp;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use server::{Conn, Running, Server};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;
use text::{DocText, Encoding};
use types::*;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(5);
const LONG_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a server may take to answer `initialize`. Some import the whole
/// build there (kotlin-lsp, jdtls on a large Gradle project) and need minutes
/// on a cold start; the status shows "starting" meanwhile, and a crash still
/// ends the wait at once.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(300);
/// How long a request waits for a server that is still initializing.
const START_WAIT: Duration = Duration::from_secs(10);
/// File moves may start a server (jdtls takes a while to import).
const FILE_OP_START_WAIT: Duration = Duration::from_secs(20);
/// Files of a moved folder looked at to find the languages involved.
const FILE_OP_SAMPLE: usize = 200;

pub type ApplyEditHook = Arc<dyn Fn(WorkspaceEdit) -> bool + Send + Sync>;
/// Adjusts a server's configuration (env, initialization options) from user
/// settings before each launch; receives the server's workspace root.
pub type ConfigFn = dyn Fn(&mut LanguageServerConfig, &Path) + Send + Sync;
pub type ConfigHook = Arc<ConfigFn>;
/// Prepares dependencies on a blocking worker immediately before launching an installed server.
pub type PrepareFn = dyn Fn(&LanguageServerConfig, &Path, &CancellationToken) + Send + Sync;
/// The servers a language uses, from its definition's list (user settings
/// disable some and add others).
pub type ServersFn = dyn Fn(&LanguageId, &[LanguageServerConfig]) -> Vec<LanguageServerConfig> + Send + Sync;

struct Attached {
    server: Arc<Server>,
    /// Instance generation the document was `didOpen`ed on, if any.
    opened_gen: Option<u64>,
}

struct DocState {
    path: PathBuf,
    /// `path` with links resolved, to recognise a document under another name.
    canonical: PathBuf,
    uri: lsp::Uri,
    language: LanguageId,
    version: i32,
    text: Arc<DocText>,
    servers: Vec<Attached>,
    /// Open YAML document whose filename does not match a Compose glob and whose content is Compose.
    compose_detected: bool,
    /// The notebook a code cell belongs to: synced through `notebookDocument/*`, not as a file.
    notebook: Option<PathBuf>,
}

impl DocState {
    fn did_open_params(&self) -> Value {
        json!({
            "textDocument": {
                "uri": self.uri,
                "languageId": self.language.as_str(),
                "version": self.version,
                "text": self.text.as_str(),
            }
        })
    }
}

/// A server instance a request can be sent to.
#[derive(Clone)]
struct Target {
    server: Arc<Server>,
    run: Running,
}

impl Target {
    fn enc(&self) -> Encoding {
        self.run.caps.read().encoding
    }
    fn caps(&self) -> parking_lot::RwLockReadGuard<'_, ServerCaps> {
        self.run.caps.read()
    }
}

struct DocSnap {
    version: i32,
    path: PathBuf,
    uri: lsp::Uri,
    language: LanguageId,
    text: Arc<DocText>,
    servers: Vec<Arc<Server>>,
}

impl DocSnap {
    fn ident(&self) -> Value {
        json!({ "uri": self.uri })
    }
    fn position(&self, t: &Target, pos: Pos) -> lsp::Position {
        self.text.ide_to_lsp(t.enc(), pos)
    }
    fn range(&self, t: &Target, r: Range) -> lsp::Range {
        lsp_range(&self.text, t.enc(), r)
    }
    fn pos_params(&self, t: &Target, pos: Pos) -> Value {
        json!({ "textDocument": self.ident(), "position": self.position(t, pos) })
    }
    /// Whether `t` is asked about `pos`: the Angular server not about the
    /// TypeScript outside a component's template and styles (see [`angular`]).
    fn asks(&self, t: &Target, pos: Pos) -> bool {
        t.server.name != angular::SERVER
            || angular::serves_position(self.language.as_str(), self.text.as_str(), self.text.byte_offset(pos))
    }
}

/// Receives the folders outside the project that servers want watched.
pub type WatchRootsFn = dyn Fn(Vec<PathBuf>) + Send + Sync;

pub type JdtlsSharedFn = dyn Fn() -> bool + Send + Sync;

#[derive(Default)]
struct JdtlsWorkspace {
    initialized: bool,
    shared: bool,
    roots: Vec<PathBuf>,
    transitioning: bool,
}

fn is_local_jdtls(config: &LanguageServerConfig) -> bool {
    config.name == "jdtls"
}

pub struct LspManager {
    me: Weak<LspManager>,
    project_root: PathBuf,
    content_roots: RwLock<Vec<PathBuf>>,
    languages: Arc<LanguageRegistry>,
    sink: SharedSink,
    launcher: Arc<dyn Launcher>,
    runtime: tokio::runtime::Handle,
    servers: Mutex<Vec<Arc<Server>>>,
    docs: Mutex<HashMap<DocId, DocState>>,
    apply_edit_hook: RwLock<Option<ApplyEditHook>>,
    applied_edits: tokio::sync::broadcast::Sender<(ide_core::ServerId, WorkspaceEdit)>,
    config_hook: RwLock<Option<ConfigHook>>,
    prepare_hook: RwLock<Option<Arc<PrepareFn>>>,
    servers_hook: RwLock<Option<Arc<ServersFn>>>,
    candidates_hook: RwLock<Option<Arc<CandidateFn>>>,
    excludes_hook: RwLock<Option<Arc<external_project::ExcludesFn>>>,
    watch_roots_hook: RwLock<Option<Arc<WatchRootsFn>>>,
    jdtls_shared_hook: RwLock<Option<Arc<JdtlsSharedFn>>>,
    jdtls_workspace: Mutex<JdtlsWorkspace>,
    reconfigure_lock: tokio::sync::Mutex<()>,
    shutting_down: AtomicBool,
    execution_allowed: AtomicBool,
    java_usages_warned: AtomicBool,
    /// java-debug DAP port → the module path whose jdtls serves it.
    debug_servers: Mutex<HashMap<u16, PathBuf>>,
    configuration_cache: Arc<Mutex<jdtls::configuration::ConfigurationCache>>,
    /// `window/showMessage` texts already surfaced; servers repeat them on every restart/reconfigure.
    shown_messages: Mutex<HashSet<(String, String)>>,
    /// go.mod files whose upgrades gopls has been asked to check this session.
    go_mod_checked: Mutex<HashSet<PathBuf>>,
    /// Virtual (non-`file:`) URIs a server returned, by the server that owns them.
    virtual_origins: Mutex<HashMap<String, ide_core::ServerId>>,
    /// Contents fetched for virtual URIs.
    virtual_docs: Mutex<HashMap<String, VirtualDocument>>,
    injections: injections::State,
    /// Open notebooks by path. Locked before `docs` when both are.
    notebooks: Mutex<HashMap<PathBuf, notebook::NotebookState>>,
}

/// Fetched virtual documents kept before the cache is reset.
const VIRTUAL_CACHE_LIMIT: usize = 256;

fn runtime_handle() -> tokio::runtime::Handle {
    static FALLBACK: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    tokio::runtime::Handle::try_current().unwrap_or_else(|_| {
        FALLBACK
            .get_or_init(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_name("ide-lsp")
                    .enable_all()
                    .build()
                    .expect("build ide-lsp runtime")
            })
            .handle()
            .clone()
    })
}

fn goto_is_empty(r: &Option<lsp::GotoDefinitionResponse>) -> bool {
    match r {
        None => true,
        Some(lsp::GotoDefinitionResponse::Scalar(_)) => false,
        Some(lsp::GotoDefinitionResponse::Array(v)) => v.is_empty(),
        Some(lsp::GotoDefinitionResponse::Link(v)) => v.is_empty(),
    }
}

fn rpc_err(server: &str, method: &str, e: RpcError) -> IdeError {
    match e {
        RpcError::Cancelled => IdeError::cancelled(),
        RpcError::Server { code, .. } if code == ide_jsonrpc::codes::CONTENT_MODIFIED => IdeError::cancelled(),
        RpcError::Closed => IdeError::unavailable(format!("{server} is not running")),
        RpcError::Timeout => IdeError::new(ErrorKind::Protocol, format!("{server}: {method} timed out")),
        RpcError::Server { message, .. } => IdeError::new(ErrorKind::Protocol, format!("{server}: {message}")),
        RpcError::Protocol(m) => IdeError::new(ErrorKind::Protocol, format!("{server}: {m}")),
    }
}

/// Sends the user's `didOpen` for `path`, closing a transient copy of the file
/// first (one a references search opened).
fn user_did_open(server: &Server, run: &Running, path: &Path, uri: &lsp::Uri, params: Value) {
    if server.take_transient(path, run.generation)
        && let Err(e) = run.peer.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } }))
    {
        tracing::debug!("{}: didClose: {e}", server.name);
    }
    if let Err(e) = run.peer.notify("textDocument/didOpen", params) {
        tracing::debug!("{}: didOpen: {e}", server.name);
    }
}

/// No target for `feature`: names the running servers that lack it, so the UI can
/// tell "the server can't do this" from "no server is running" (the UI's
/// `unavailableText` matches the "… doesn't support …" wording).
fn unsupported(servers: &[Arc<Server>], feature: &str) -> IdeError {
    let running: Vec<&str> = servers.iter().filter(|s| s.running().is_some()).map(|s| s.name.as_str()).collect();
    if running.is_empty() {
        IdeError::unavailable(format!("no running language server supports {feature}"))
    } else {
        let servers = running.join(", ");
        IdeError::unavailable(format!("{servers} doesn't support {feature}"))
    }
}

/// Folds per-server results: any success wins over errors; errors surface only
/// when every server failed (cancellation first).
struct Outcome<T> {
    value: Option<T>,
    error: Option<IdeError>,
}

impl<T> Outcome<T> {
    fn new() -> Self {
        Self { value: None, error: None }
    }
    fn fail(&mut self, e: IdeError) {
        if e.kind == ErrorKind::Cancelled || self.error.is_none() {
            self.error = Some(e);
        }
    }
    fn finish(self, empty: T) -> IdeResult<T> {
        match (self.value, self.error) {
            (Some(v), _) => Ok(v),
            (None, Some(e)) => Err(e),
            (None, None) => Ok(empty),
        }
    }
}

/// How often a rename the server withdrew (`ContentModified`) is asked, and the pause between.
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(300);

/// Implementation requests of one line-marker pass in flight at once.
const IMPLEMENTATION_CONCURRENCY: usize = 4;

/// How a virtual document's content was decoded, and whether it can be
/// re-decoded ("Reload with Encoding").
struct Decoding {
    encoding: String,
    has_bom: bool,
    can_reload: bool,
}

impl Decoding {
    /// Text the server decoded itself: no raw bytes here to re-read.
    fn server_text() -> Self {
        Decoding { encoding: "utf-8".into(), has_bom: false, can_reload: false }
    }
}

/// jdtls' source attachment of a `jdt:` class (`java.project.resolveSourceAttachment`).
struct SourceAttachment {
    path: Option<String>,
    encoding: Option<String>,
    can_edit_encoding: bool,
}

/// Reads a `jar:` document's source: an entry as is, a class from the sources
/// jar next to its binary. `encoding` decodes with it instead of detecting.
fn read_jar_source(uri: &str, encoding: Option<&str>) -> Option<(String, ide_vfs::LoadedText)> {
    match library_source::parse(uri) {
        Some(e) if !e.entry.ends_with(".class") => {
            library_source::read_entry(&e.jar, &e.entry, encoding).map(|loaded| (e.entry, loaded))
        }
        Some(_) => library_source::class_source(uri, encoding)
            .and_then(|(source, loaded)| Some((library_source::parse(&source)?.entry, loaded))),
        None => None,
    }
}

/// Library classes in `jar:` targets (the official Kotlin LSP) go to their source
/// in the artifact's sources jar when it is cached, at the declaration of the
/// name navigated from; [`LspManager::virtual_document`] serves it.
async fn library_sources(snap: &DocSnap, pos: Pos, locs: Vec<Location>) -> Vec<Location> {
    if !locs.iter().any(|l| l.uri.as_deref().is_some_and(|u| u.starts_with("jar:") && u.ends_with(".class"))) {
        return locs;
    }
    let name = library_source::identifier_at(snap.text.line(pos.line as usize), pos.col).map(str::to_owned);
    tokio::task::spawn_blocking(move || {
        locs.into_iter()
            .map(|loc| {
                let Some(uri) = loc.uri.as_deref().filter(|u| u.starts_with("jar:") && u.ends_with(".class")) else {
                    return loc;
                };
                let Some((source, loaded)) = library_source::class_source(uri, None) else { return loc };
                let range =
                    name.as_deref().map(|n| library_source::declaration_range(&loaded.text, n)).unwrap_or_default();
                Location { path: source.clone().into(), range, uri: Some(source) }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

const JAVA_IMPLEMENTATIONS: &str = "openidea.java.implementations";

/// The answer of [`JAVA_IMPLEMENTATIONS`]: `complete` when the type is declared in the
/// sources, so no dependency can implement it.
#[derive(serde::Deserialize)]
struct SourceImplementations {
    locations: Vec<lsp::Location>,
    complete: bool,
}

/// Receives the implementations found so far, before a slower search for the rest.
type Partial<'a> = Option<&'a (dyn Fn(Vec<Location>) + Send + Sync)>;

/// Receives the references found so far, before a slower search for the rest.
pub type PartialReferences<'a> = Option<&'a (dyn Fn(References) + Send + Sync)>;

/// `first`, then those of `more` not in it (same file and start).
fn merge_locations(first: Vec<Location>, more: Vec<Location>) -> Vec<Location> {
    let mut seen: HashSet<(PathBuf, Pos)> = first.iter().map(|l| (l.path.to_path_buf(), l.range.start)).collect();
    let mut out = first;
    out.extend(more.into_iter().filter(|l| seen.insert((l.path.to_path_buf(), l.range.start))));
    out
}

fn goto_method(kind: GotoKind) -> (&'static str, &'static str, &'static str) {
    match kind {
        GotoKind::Definition => ("textDocument/definition", "definitionProvider", "go to definition"),
        GotoKind::Declaration => ("textDocument/declaration", "declarationProvider", "go to declaration"),
        GotoKind::TypeDefinition => ("textDocument/typeDefinition", "typeDefinitionProvider", "go to type definition"),
        GotoKind::Implementation => ("textDocument/implementation", "implementationProvider", "go to implementation"),
    }
}

impl LspManager {
    pub fn new(project_root: PathBuf, languages: Arc<LanguageRegistry>, sink: SharedSink) -> Arc<Self> {
        Self::with_launcher(project_root, languages, sink, Arc::new(ProcessLauncher))
    }

    /// Like [`LspManager::new`] with a custom way of starting servers (tests, remote setups).
    pub fn with_launcher(
        project_root: PathBuf,
        languages: Arc<LanguageRegistry>,
        sink: SharedSink,
        launcher: Arc<dyn Launcher>,
    ) -> Arc<Self> {
        Arc::<Self>::new_cyclic(|me| Self {
            me: me.clone(),
            project_root,
            content_roots: RwLock::new(Vec::new()),
            languages,
            sink: {
                let me = me.clone();
                Arc::new(move |event| {
                    if let Some(mgr) = me.upgrade() {
                        if let Some(event) = mgr.map_injected_event(event) {
                            sink.emit(event);
                        }
                    } else {
                        sink.emit(event);
                    }
                })
            },
            launcher,
            runtime: runtime_handle(),
            servers: Mutex::new(Vec::new()),
            docs: Mutex::new(HashMap::new()),
            apply_edit_hook: RwLock::new(None),
            applied_edits: tokio::sync::broadcast::channel(64).0,
            config_hook: RwLock::new(None),
            prepare_hook: RwLock::new(None),
            servers_hook: RwLock::new(None),
            candidates_hook: RwLock::new(None),
            excludes_hook: RwLock::new(None),
            watch_roots_hook: RwLock::new(None),
            jdtls_shared_hook: RwLock::new(None),
            jdtls_workspace: Mutex::new(Default::default()),
            reconfigure_lock: tokio::sync::Mutex::new(()),
            shutting_down: AtomicBool::new(false),
            execution_allowed: AtomicBool::new(true),
            java_usages_warned: AtomicBool::new(false),
            debug_servers: Mutex::new(HashMap::new()),
            configuration_cache: Arc::new(Mutex::new(Default::default())),
            shown_messages: Mutex::new(HashSet::new()),
            go_mod_checked: Mutex::new(HashSet::new()),
            virtual_origins: Mutex::new(HashMap::new()),
            virtual_docs: Mutex::new(HashMap::new()),
            injections: injections::State::default(),
            notebooks: Mutex::new(HashMap::new()),
        })
    }

    // ---- server lookup & lifecycle ----

    pub fn set_content_roots(&self, roots: Vec<PathBuf>) {
        let changed = {
            let mut current = self.content_roots.write();
            let changed = *current != roots;
            *current = roots;
            changed
        };
        if changed
            && self.desired_jdtls_workspace().0
            && let Some(me) = self.me.upgrade()
        {
            me.reconfigure_soon();
        }
    }

    /// Shares JDT LS within this manager; callers reconfigure after the hook's value changes.
    pub fn set_jdtls_shared_hook(&self, hook: Box<JdtlsSharedFn>) {
        *self.jdtls_shared_hook.write() = Some(Arc::from(hook));
    }

    fn desired_jdtls_workspace(&self) -> (bool, Vec<PathBuf>) {
        let shared = self.jdtls_shared_hook.read().as_ref().is_some_and(|hook| hook());
        let mut roots = Vec::new();
        if shared {
            roots.push(self.project_root.clone());
            for root in self.content_roots.read().iter() {
                if root.is_absolute() && root.is_dir() && !roots.contains(root) {
                    roots.push(root.clone());
                }
            }
        }
        (shared, roots)
    }

    fn jdtls_workspace_state(&self) -> parking_lot::MutexGuard<'_, JdtlsWorkspace> {
        let mut state = self.jdtls_workspace.lock();
        if !state.initialized {
            (state.shared, state.roots) = self.desired_jdtls_workspace();
            state.initialized = true;
        }
        state
    }

    fn server_workspace_roots(&self, server: &Server) -> Vec<PathBuf> {
        if is_local_jdtls(&server.config) {
            let state = self.jdtls_workspace_state();
            if state.shared {
                return state.roots.clone();
            }
        }
        vec![server.root.clone()]
    }

    fn project_root_for(&self, path: &Path) -> PathBuf {
        self.content_roots
            .read()
            .iter()
            .chain(std::iter::once(&self.project_root))
            .filter(|root| path.starts_with(root))
            .max_by_key(|root| root.components().count())
            .cloned()
            .unwrap_or_else(|| self.project_root.clone())
    }

    fn server_for(&self, cfg: &LanguageServerConfig, language: &LanguageId, path: &Path) -> Arc<Server> {
        let shared = is_local_jdtls(cfg).then(|| self.jdtls_workspace_state());
        let mut servers = self.servers.lock();
        let project = self.project_root_for(path);
        let sketch = (cfg.name == arduino::SERVER).then(|| arduino::sketch_root(&project, path)).flatten();
        let root = if shared.as_ref().is_some_and(|state| state.shared) {
            self.project_root.clone()
        } else {
            sketch.or_else(|| launch::find_root(&project, path, &cfg.root_markers)).unwrap_or_else(|| {
                // Outside the project (library sources, …): reuse a running instance.
                servers
                    .iter()
                    .filter(|s| s.name == cfg.name)
                    .min_by_key(|s| s.root != self.project_root)
                    .map(|s| s.root.clone())
                    .unwrap_or_else(|| self.project_root.clone())
            })
        };
        if let Some(s) = servers.iter().find(|s| s.name == cfg.name && s.root == root) {
            s.add_language(language);
            return s.clone();
        }
        let server = Arc::new(Server::new(cfg.clone(), root, language.clone()));
        servers.push(server.clone());
        server
    }

    /// The servers serving `path`: every regular one, and each `fallback` one
    /// only while all servers listed before it are missing. One that requires a
    /// root marker serves only files below one, and stands in for no other.
    fn servers_for(&self, language: &LanguageId, path: &Path) -> Vec<Arc<Server>> {
        if let Some(servers) = self.arduino_servers(language, path) {
            return servers;
        }
        let mut out = Vec::new();
        let mut available_before = false;
        for sc in &self.language_servers(language) {
            if sc.fallback && available_before {
                continue;
            }
            if sc.require_root_marker
                && launch::marked_root(&self.project_root_for(path), path, &sc.root_markers).is_none()
            {
                continue;
            }
            let server = self.server_for(sc, language, path);
            available_before |= !sc.require_root_marker && server.status() != ide_core::event::ServerStatus::Missing;
            out.push(server);
        }
        out
    }

    /// The definitions of the servers `language` uses.
    fn language_servers(&self, language: &LanguageId) -> Vec<LanguageServerConfig> {
        if !self.execution_allowed.load(Ordering::Acquire) {
            return Vec::new();
        }
        let Some(cfg) = self.languages.get(language) else { return Vec::new() };
        match self.servers_hook.read().clone() {
            Some(hook) => hook(language, &cfg.language_servers),
            None => cfg.language_servers,
        }
    }

    /// A server turned out to be missing: attach the fallbacks it was hiding
    /// to the open documents (and start them). Also attaches servers newly
    /// enabled in settings.
    fn attach_fallbacks(&self) {
        let _gate = self.injections.gate.lock();
        let open: Vec<(DocId, LanguageId, PathBuf)> = self
            .docs
            .lock()
            .iter()
            .filter(|(_, d)| d.notebook.is_none())
            .map(|(id, d)| (*id, d.language.clone(), d.path.clone()))
            .collect();
        let wanted: Vec<(DocId, Vec<Arc<Server>>)> =
            open.into_iter().map(|(id, language, path)| (id, self.servers_for(&language, &path))).collect();
        let mut start = Vec::new();
        let mut opened = Vec::new();
        {
            let mut docs = self.docs.lock();
            for (id, servers) in wanted {
                let Some(d) = docs.get_mut(&id) else { continue };
                for server in &servers {
                    if d.servers.iter().any(|a| a.server.id == server.id) {
                        continue;
                    }
                    let mut attached = Attached { server: server.clone(), opened_gen: None };
                    if let Some(run) = server.running() {
                        if run.caps.read().open_close {
                            user_did_open(server, &run, &d.path, &d.uri, d.did_open_params());
                        }
                        attached.opened_gen = Some(run.generation);
                        opened.push((id, server.clone()));
                    }
                    d.servers.push(attached);
                    if !start.iter().any(|s: &Arc<Server>| s.id == server.id) {
                        start.push(server.clone());
                    }
                }
                // In definition order: the first server answers hover, rename and symbols.
                d.servers.sort_by_key(|a| servers.iter().position(|s| s.id == a.server.id).unwrap_or(usize::MAX));
            }
        }
        for (doc, server) in opened {
            self.schedule_pull(doc, Some(&server), Duration::ZERO);
        }
        for server in self.attach_notebook_servers() {
            if !start.iter().any(|s| s.id == server.id) {
                start.push(server);
            }
        }
        for server in &start {
            self.ensure_started(server);
        }
    }

    fn ensure_started(&self, server: &Arc<Server>) {
        if self.shutting_down.load(Ordering::Acquire) || !self.execution_allowed.load(Ordering::Acquire) {
            return;
        }
        let workspace = is_local_jdtls(&server.config).then(|| self.jdtls_workspace_state());
        if let Some(state) = &workspace {
            if state.transitioning || !self.servers.lock().iter().any(|s| s.id == server.id) {
                return;
            }
            let (shared, roots) = self.desired_jdtls_workspace();
            if state.shared != shared || (shared && state.roots != roots) {
                if let Some(me) = self.me.upgrade() {
                    me.reconfigure_soon();
                }
                return;
            }
        }
        let startup = if is_local_jdtls(&server.config) {
            match server.startup_lock.clone().try_lock_owned() {
                Ok(guard) => Some(guard),
                Err(_) => return,
            }
        } else {
            None
        };
        // `begin_start` only claims Idle servers, so a claimed server is never a
        // live one. Its root is the process's working directory: starting with
        // one deleted from disk fails (`os error 267` on Windows). Such a
        // server can never serve again, so drop it instead of leaving a
        // permanently "Crashed" entry behind (e.g. the root vanishing during
        // the crash-restart backoff, or an open-file request arriving later).
        let Some(generation) = server.begin_start() else { return };
        let Some(me) = self.me.upgrade() else { return };
        if !server.root.is_dir() {
            tracing::info!("{}: workspace root {} is gone, dropping", server.name, server.root.display());
            server.begin_stop(&self.sink, true);
            self.forget(std::slice::from_ref(server));
            return;
        }
        let server = server.clone();
        self.runtime.spawn(async move {
            let _startup = startup;
            me.run_instance(server, generation).await;
        });
    }

    async fn run_instance(self: Arc<Self>, server: Arc<Server>, generation: u64) {
        let Some(cancel) = server.starting_status(generation, &self.sink) else { return };
        let handler = Arc::new(handler::ClientHandler::new(self.me.clone(), server.clone(), generation));
        let me = self.clone();
        let tail = server.clone();
        let launch_cancel = cancel.clone();
        // The settings hook may touch the filesystem (e.g. scanning for JDKs); TCP
        // servers may take a while to start listening.
        let launched = tokio::task::spawn_blocking(move || {
            if !me.execution_allowed.load(Ordering::Acquire) {
                return Err(LaunchError::Config("Project is in Restricted Mode".into()));
            }
            let mut cfg = me.configured(&tail);
            if !me.execution_allowed.load(Ordering::Acquire) || launch_cancel.is_cancelled() {
                return Err(LaunchError::Config("Project is in Restricted Mode".into()));
            }
            tail.set_effective_config(generation, cfg.clone());
            let prepare = me.prepare_hook.read().clone();
            if !launch_cancel.is_cancelled()
                && me.launcher.available(&cfg, &tail.root)
                && let Some(prepare) = prepare
            {
                prepare(&cfg, &tail.root, &launch_cancel);
                cfg = me.configured(&tail);
            }
            tail.set_effective_config(generation, cfg.clone());
            let root = tail.root.clone();
            if let Some(message) = &cfg.launch_error {
                // A missing binary still asks to be installed first.
                let missing = !me.launcher.available(&cfg, &root);
                return Err(if missing { LaunchError::Missing } else { LaunchError::Config(message.clone()) });
            }
            if !me.execution_allowed.load(Ordering::Acquire) || launch_cancel.is_cancelled() {
                return Err(LaunchError::Config("Project is in Restricted Mode".into()));
            }
            me.launcher.launch_resolved(
                &cfg,
                &root,
                handler,
                Box::new(move |line| tail.push_stderr(generation, line)),
                &launch_cancel,
            )
        })
        .await
        .unwrap_or_else(|e| Err(LaunchError::Failed(e.to_string())));

        let peer = match launched {
            Ok((peer, binary)) => {
                if !server.set_resolved_binary(generation, binary) {
                    Self::kill_peer(&server, &peer).await;
                    return;
                }
                peer
            }
            Err(LaunchError::Missing) => {
                let cfg = server.effective_config();
                let message =
                    cfg.install_hint.clone().unwrap_or_else(|| format!("`{}` was not found on PATH", cfg.command));
                if server.fail_start(
                    generation,
                    Conn::Missing,
                    &self.sink,
                    ide_core::event::ServerStatus::Missing,
                    Some(message),
                ) {
                    self.attach_fallbacks();
                }
                return;
            }
            Err(LaunchError::Config(message)) => {
                tracing::warn!("{}: {message}", server.name);
                server.fail_start(
                    generation,
                    Conn::Failed,
                    &self.sink,
                    ide_core::event::ServerStatus::Misconfigured,
                    Some(message),
                );
                return;
            }
            Err(LaunchError::Failed(message)) => {
                tracing::warn!("{}: {message}", server.name);
                server.fail_start(
                    generation,
                    Conn::Failed,
                    &self.sink,
                    ide_core::event::ServerStatus::Crashed,
                    Some(message),
                );
                return;
            }
        };

        let mut init = self.initialize_params(&server);
        if server.name == "jdtls"
            && init["initializationOptions"].get("triggerFiles").is_none()
            && let Some(paths) = init
                .pointer("/initializationOptions/settings/java/project/sourcePaths")
                .and_then(Value::as_array)
                .cloned()
        {
            let root = server.root.clone();
            if let Ok(Some(path)) = tokio::task::spawn_blocking(move || jdtls::source_trigger(&root, &paths)).await {
                init["initializationOptions"]["triggerFiles"] = json!([uri::path_to_uri_string(&path)]);
            }
        }
        let result = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                Self::kill_peer(&server, &peer).await;
                return;
            }
            result = tokio::time::timeout(INITIALIZE_TIMEOUT, peer.request::<_, Value>("initialize", init, Some(cancel.clone()))) => result.unwrap_or(Err(RpcError::Timeout)),
        };
        let caps = match result {
            Ok(result) => {
                if let Some(info) = result.get("serverInfo") {
                    tracing::info!("{} initialized: {info}", server.name);
                }
                let mut caps_val = result.get("capabilities").cloned().unwrap_or_else(|| json!({}));
                if server.name == arduino::SERVER {
                    arduino::sanitize_server_capabilities(&mut caps_val);
                }
                let mut caps = ServerCaps::parse(caps_val);
                let cfg = server.effective_config();
                caps.restrict(caps::Restriction::new(&server.name, &cfg.features, &cfg.code_action_kinds));
                caps
            }
            Err(e) => {
                tracing::warn!("{}: initialize failed: {e}", server.name);
                if matches!(e, RpcError::Closed) {
                    // The server is exiting: let it, so the crash report has its exit code and last output.
                    let _ = tokio::time::timeout(Duration::from_secs(3), peer.closed()).await;
                }
                Self::kill_peer(&server, &peer).await;
                // Treated like a crash so transient failures retry with backoff.
                self.spawn_supervisor(server, generation, peer);
                return;
            }
        };
        let run =
            Running { generation, peer: peer.clone(), caps: Arc::new(RwLock::new(caps)), watchers: Default::default() };
        if !server.set_initializing(run.clone()) {
            Self::kill_peer(&server, &peer).await;
            return;
        }
        if let Err(e) = peer.notify("initialized", json!({})) {
            tracing::warn!("{}: {e}", server.name);
        }
        // Servers that don't ask with `workspace/configuration` only learn settings this way.
        let cfg = server.effective_config();
        if cfg.settings.is_some()
            && let Err(e) =
                peer.notify("workspace/didChangeConfiguration", json!({ "settings": handler::all_settings(&cfg) }))
        {
            tracing::debug!("{}: didChangeConfiguration: {e}", server.name);
        }

        self.refresh_external_project(&server, &run).await;

        // Publish readiness and (re)open attached documents atomically w.r.t. did_change.
        let mut reopened = Vec::new();
        let ready = {
            let mut docs = self.docs.lock();
            if !server.mark_ready(generation, run.clone()) {
                false
            } else {
                let open_close = run.caps.read().open_close;
                for (id, d) in docs.iter_mut().filter(|(_, d)| d.notebook.is_none()) {
                    let params = d.did_open_params();
                    for a in
                        d.servers.iter_mut().filter(|a| a.server.id == server.id && a.opened_gen != Some(generation))
                    {
                        if open_close && let Err(e) = peer.notify("textDocument/didOpen", params.clone()) {
                            tracing::debug!("{}: didOpen: {e}", server.name);
                        }
                        a.opened_gen = Some(generation);
                        reopened.push(*id);
                    }
                }
                true
            }
        };
        if !ready {
            Self::kill_peer(&server, &peer).await;
            return;
        }
        for doc in reopened {
            self.schedule_pull(doc, Some(&server), Duration::ZERO);
        }
        self.reopen_notebooks(&server, &run);
        self.check_clang_tidy(&server).await;
        self.check_vue_navigation(&server).await;
        server.refresh_busy_status(&self.sink);
        server.announce_ready(generation);
        self.spawn_supervisor(server, generation, peer);
    }

    fn spawn_supervisor(&self, server: Arc<Server>, generation: u64, peer: ide_jsonrpc::Peer) {
        let weak = self.me.clone();
        self.runtime.spawn(async move {
            let code = peer.closed().await;
            if let Some(me) = weak.upgrade() {
                me.on_instance_closed(server, generation, code).await;
            }
        });
    }

    async fn on_instance_closed(self: Arc<Self>, server: Arc<Server>, generation: u64, code: Option<i32>) {
        if self.shutting_down.load(Ordering::Acquire) {
            return;
        }
        let Some(delay) = server.on_closed(generation, &self.sink, code) else { return };
        self.file_watch_roots_changed();
        if !server.root.is_dir() {
            self.forget(std::slice::from_ref(&server));
            return;
        }
        if let Some(delay) = delay {
            tokio::time::sleep(delay).await;
            if server.is_idle_gen(generation) {
                self.ensure_started(&server);
            }
        }
    }

    fn initialize_params(&self, server: &Server) -> Value {
        let root_uri = uri::path_to_uri(&server.root);
        let cfg = server.effective_config();
        let mut init_options =
            cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).unwrap_or(Value::Null);
        if server.name == "jdtls" {
            if !init_options.is_object() {
                init_options = json!({});
            }
            init_options["settings"] = handler::all_settings(&cfg);
            let shared = is_local_jdtls(&server.config) && self.jdtls_workspace_state().shared;
            if shared {
                init_options["workspaceFolders"] = json!(
                    self.server_workspace_roots(server)
                        .iter()
                        .map(|root| uri::path_to_uri_string(root))
                        .collect::<Vec<_>>()
                );
            }
            let triggers: Vec<_> = self
                .docs
                .lock()
                .values()
                .filter(|d| {
                    d.language.as_str() == "java"
                        && d.path.is_absolute()
                        && d.servers.iter().any(|a| a.server.id == server.id)
                })
                .map(|d| uri::path_to_uri_string(&d.path))
                .collect();
            if !triggers.is_empty() && init_options.get("triggerFiles").is_none() {
                // Re-import cached invisible projects with the current source model.
                init_options["triggerFiles"] = json!(triggers);
            }
        }
        let mut params = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") },
            "locale": "en",
            "rootPath": server.root.to_string_lossy(),
            "rootUri": root_uri,
            "workspaceFolders": self.workspace_folders(server),
            "capabilities": caps::client_capabilities(),
            "trace": "off",
        });
        if server.name == arduino::SERVER {
            arduino::configure_client_capabilities(&mut params["capabilities"]);
        }
        if server.name == "gopls" {
            params["capabilities"]["experimental"]["interactiveResolve"] = json!({ "inputTypes": ["string"] });
        }
        if server.name == "csharp-ls" {
            params["capabilities"]["experimental"]["csharp"]["metadataUris"] = json!(true);
        }
        if !init_options.is_null() {
            params["initializationOptions"] = init_options;
        }
        params
    }

    pub(crate) fn workspace_folders(&self, server: &Server) -> Value {
        json!(
            self.server_workspace_roots(server)
                .iter()
                .map(|root| {
                    let name =
                        root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "root".into());
                    json!({"uri": uri::path_to_uri(root), "name": name})
                })
                .collect::<Vec<_>>()
        )
    }

    pub(crate) fn sink(&self) -> &SharedSink {
        &self.sink
    }

    /// True the first time `server` shows `text` in this project.
    pub(crate) fn first_message(&self, server: &str, text: &str) -> bool {
        self.shown_messages.lock().insert((server.to_owned(), text.to_owned()))
    }

    pub(crate) fn apply_edit_hook(&self) -> Option<ApplyEditHook> {
        self.apply_edit_hook.read().clone()
    }

    /// Text of an open document by path, for position-encoding conversion.
    pub(crate) fn text_for_path(&self, path: &Path) -> Option<Arc<DocText>> {
        if let Some(t) = self.docs.lock().values().find(|d| d.path == path).map(|d| d.text.clone()) {
            return Some(t);
        }
        if let Ok(key) = dunce::canonicalize(path)
            && let Some(text) = self.docs.lock().values().find(|d| d.canonical == key).map(|d| d.text.clone())
        {
            return Some(text);
        }
        let key = path.to_str().filter(|s| is_virtual_uri(s))?;
        self.virtual_docs.lock().get(key).map(|d| Arc::new(DocText::new(&d.text)))
    }

    pub(crate) fn conv(&self, enc: Encoding) -> Conv<'_> {
        Conv::new(enc, move |p: &Path| self.text_for_path(p))
            .with_injections(move |loc| self.map_injected_location(loc), move |edit| self.map_injected_edit(edit))
    }

    // ---- document sync (driven by ide-workspace's DocumentObserver) ----
    pub fn did_open(&self, doc: DocId, path: &Path, language: &LanguageId, version: u32, text: &str) {
        let _gate = self.injections.gate.lock();
        if self.docs.lock().contains_key(&doc) {
            self.close_injections(doc);
            self.close_document(doc);
        }
        let servers = self.servers_for(language, path);
        self.attach(doc, path.to_owned(), uri::path_to_uri(path), language, version, text, servers);
        self.schedule_injections(doc);
    }

    /// Opens a read-only virtual document (`jdt://…`) on the server that
    /// returned its URI (`didOpen` only: it is never changed or saved).
    pub fn did_open_virtual(&self, doc: DocId, uri: &str, language: &LanguageId, version: u32, text: &str) {
        let _gate = self.injections.gate.lock();
        if self.docs.lock().contains_key(&doc) {
            self.close_injections(doc);
            self.close_document(doc);
        }
        let Ok(lsp_uri) = uri.parse::<lsp::Uri>() else {
            tracing::debug!("not a valid URI: {uri}");
            return;
        };
        let servers = match self.origin_server(uri) {
            Some(s) => vec![s],
            None => self.servers_for(language, &self.project_root),
        };
        self.attach(doc, PathBuf::from(uri), lsp_uri, language, version, text, servers);
    }

    #[allow(clippy::too_many_arguments)]
    fn attach(
        &self,
        doc: DocId,
        path: PathBuf,
        uri: lsp::Uri,
        language: &LanguageId,
        version: u32,
        text: &str,
        servers: Vec<Arc<Server>>,
    ) {
        let canonical = dunce::canonicalize(&path).unwrap_or_else(|_| path.clone());
        let canonical_path = canonical.clone();
        let compose_detected = language.as_str() == "yaml" && compose::is_content_detected_compose_file(&path, text);
        let mut state = DocState {
            path,
            canonical,
            uri,
            language: language.clone(),
            version: version as i32,
            text: Arc::new(DocText::new(text)),
            servers: servers.iter().map(|s| Attached { server: s.clone(), opened_gen: None }).collect(),
            compose_detected,
            notebook: None,
        };
        let compose_added = {
            let mut docs = self.docs.lock();
            let already_detected =
                compose_detected && docs.values().any(|d| d.compose_detected && d.path == state.path);
            let params = state.did_open_params();
            for a in &mut state.servers {
                if let Some(run) = a.server.running() {
                    if run.caps.read().open_close {
                        user_did_open(&a.server, &run, &state.path, &state.uri, params.clone());
                    }
                    a.opened_gen = Some(run.generation);
                }
            }
            docs.insert(doc, state);
            compose_detected && !already_detected
        };
        self.schedule_pull(doc, None, Duration::ZERO);
        for s in &servers {
            self.ensure_started(s);
            // Waits for a server still starting, so it is not tied to `running()` below.
            if s.name == "gopls"
                && let Some(me) = self.me.upgrade()
            {
                let (path, server) = (canonical_path.clone(), s.clone());
                self.runtime.spawn(async move { me.check_go_mod(doc, &path, server).await });
            }
            if s.running().is_some()
                && let Some(me) = self.me.upgrade()
            {
                if s.name == compose::SERVER && compose_added {
                    me.reconfigure_soon();
                }
                let hint = me.clone();
                let server = s.clone();
                self.runtime.spawn(async move { me.check_clang_tidy(&server).await });
                let server = s.clone();
                self.runtime.spawn(async move { hint.check_vue_navigation(&server).await });
            }
        }
    }

    pub fn did_change(&self, doc: DocId, version: u32, changes: &[AppliedChange], full_text: &dyn Fn() -> String) {
        let _gate = self.injections.gate.lock();
        let mut docs = self.docs.lock();
        let Some(d) = docs.get_mut(&doc) else { return };
        d.version = version as i32;

        // Servers that have this document open on their current instance.
        let targets: Vec<(Arc<Server>, Running, SyncKind, Encoding)> = d
            .servers
            .iter()
            .filter_map(|a| {
                let run = a.server.running()?;
                (a.opened_gen == Some(run.generation)).then_some(())?;
                let (sync, enc) = {
                    let caps = run.caps.read();
                    (caps.sync, caps.encoding)
                };
                (sync != SyncKind::None).then(|| (a.server.clone(), run, sync, enc))
            })
            .collect();
        let wants = |e: Encoding| targets.iter().any(|t| t.2 == SyncKind::Incremental && t.3 == e);
        let (need8, need16, need32) = (wants(Encoding::Utf8), wants(Encoding::Utf16), wants(Encoding::Utf32));

        let mut events: HashMap<u8, Vec<Value>> = HashMap::new();
        let text = Arc::make_mut(&mut d.text);
        let mut in_sync = true;
        for c in changes {
            for (need, enc, key) in
                [(need8, Encoding::Utf8, 8u8), (need16, Encoding::Utf16, 16), (need32, Encoding::Utf32, 32)]
            {
                if need {
                    let range = lsp_range(text, enc, c.range);
                    events.entry(key).or_default().push(json!({ "range": range, "text": c.text }));
                }
            }
            if text.apply(c.range, &c.text).is_err() {
                in_sync = false;
                break;
            }
        }
        if !in_sync {
            tracing::warn!("lsp text copy of {} out of sync; resending full text", d.path.display());
            text.set(&full_text());
        }
        let full = json!([{ "text": text.as_str() }]);
        for (server, run, sync, enc) in targets {
            let key = match enc {
                Encoding::Utf8 => 8,
                Encoding::Utf16 => 16,
                Encoding::Utf32 => 32,
            };
            let content = if !in_sync || sync == SyncKind::Full {
                full.clone()
            } else {
                Value::Array(events.get(&key).cloned().unwrap_or_default())
            };
            let params = json!({
                "textDocument": { "uri": d.uri, "version": d.version },
                "contentChanges": content,
            });
            if let Err(e) = run.peer.notify("textDocument/didChange", params) {
                tracing::debug!("{}: didChange: {e}", server.name);
            }
        }
        let compose_changed = if d.language.as_str() == "yaml" && !compose::is_named_compose_file(&d.path) {
            let now = compose::is_compose_content(text.as_str());
            let changed = std::mem::replace(&mut d.compose_detected, now) != now;
            let closed_path = d.path.clone();
            changed && !docs.iter().any(|(id, other)| *id != doc && other.compose_detected && other.path == closed_path)
        } else {
            false
        };
        drop(docs);
        if compose_changed && let Some(me) = self.me.upgrade() {
            me.reconfigure_soon();
        }
        self.schedule_pull(doc, None, pull::AFTER_EDIT);
        self.invalidate_injections(doc);
        self.schedule_injections(doc);
    }

    /// Sends the documents open on instance `generation` of `server` again, as a `didChange`
    /// with their unchanged text, so the server parses them with the settings it just read.
    pub(crate) fn resync_documents(&self, server: &Server, generation: u64) {
        let Some(run) = server.running_gen(generation) else { return };
        if run.caps.read().sync == SyncKind::None {
            return;
        }
        let docs = self.docs.lock();
        for d in docs.values().filter(|d| d.notebook.is_none()) {
            if !d.servers.iter().any(|a| a.server.id == server.id && a.opened_gen == Some(generation)) {
                continue;
            }
            let params = json!({
                "textDocument": { "uri": d.uri, "version": d.version },
                "contentChanges": [{ "text": d.text.as_str() }],
            });
            if let Err(e) = run.peer.notify("textDocument/didChange", params) {
                tracing::debug!("{}: didChange: {e}", server.name);
            }
        }
    }

    pub fn did_save(&self, doc: DocId, text: &str) {
        let mut docs = self.docs.lock();
        let Some(d) = docs.get_mut(&doc) else { return };
        if d.text.as_str() != text {
            Arc::make_mut(&mut d.text).set(text);
        }
        for a in &d.servers {
            let Some(run) = a.server.running() else { continue };
            if a.opened_gen != Some(run.generation) {
                continue;
            }
            let Some(include_text) = run.caps.read().save else { continue };
            let mut params = json!({ "textDocument": { "uri": d.uri } });
            if include_text {
                params["text"] = json!(text);
            }
            if let Err(e) = run.peer.notify("textDocument/didSave", params) {
                tracing::debug!("{}: didSave: {e}", a.server.name);
            }
        }
        drop(docs);
        self.schedule_pull(doc, None, Duration::ZERO);
        self.pull_dependents(doc);
        self.go_mod_saved(doc);
    }

    pub fn did_close(&self, doc: DocId) {
        let _gate = self.injections.gate.lock();
        self.close_injections(doc);
        self.close_document(doc);
    }

    fn close_document(&self, doc: DocId) {
        let (d, compose_removed) = {
            let mut docs = self.docs.lock();
            let Some(d) = docs.remove(&doc) else { return };
            let removed =
                d.compose_detected && !docs.values().any(|other| other.compose_detected && other.path == d.path);
            (d, removed)
        };
        if compose_removed && let Some(me) = self.me.upgrade() {
            me.reconfigure_soon();
        }
        for a in &d.servers {
            self.forget_pulled(&a.server, &d.path, a.server.running().as_ref());
            let Some(run) = a.server.running() else { continue };
            if a.opened_gen == Some(run.generation)
                && run.caps.read().open_close
                && let Err(e) = run.peer.notify("textDocument/didClose", json!({ "textDocument": { "uri": d.uri } }))
            {
                tracing::debug!("{}: didClose: {e}", a.server.name);
            }
        }
    }

    // ---- request plumbing ----

    fn snapshot(&self, doc: DocId) -> IdeResult<DocSnap> {
        let docs = self.docs.lock();
        let d = docs.get(&doc).ok_or_else(|| IdeError::not_found(format!("{doc} is not open")))?;
        // A cell is asked only of the servers its notebook is open on (those that sync notebooks).
        let servers = d
            .servers
            .iter()
            .filter(|a| {
                d.notebook.is_none()
                    || a.opened_gen.is_some_and(|g| a.server.running().is_some_and(|run| run.generation == g))
            })
            .map(|a| a.server.clone())
            .collect();
        Ok(DocSnap {
            version: d.version,
            path: d.path.clone(),
            uri: d.uri.clone(),
            language: d.language.clone(),
            text: d.text.clone(),
            servers,
        })
    }

    async fn ready_targets(&self, servers: &[Arc<Server>], pred: impl Fn(&ServerCaps) -> bool) -> Vec<Target> {
        let ready = join_all(servers.iter().map(|s| s.wait_ready(START_WAIT))).await;
        servers
            .iter()
            .zip(ready)
            .filter_map(|(s, run)| {
                let run = run?;
                let ok = pred(&run.caps.read());
                ok.then(|| Target { server: s.clone(), run })
            })
            .collect()
    }

    async fn doc_targets(
        &self,
        doc: DocId,
        feature: &str,
        pred: impl Fn(&ServerCaps) -> bool,
    ) -> IdeResult<(DocSnap, Vec<Target>)> {
        let snap = self.snapshot(doc)?;
        let targets = self.ready_targets(&snap.servers, pred).await;
        if targets.is_empty() {
            return Err(unsupported(&snap.servers, feature));
        }
        Ok((snap, targets))
    }

    async fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        t: &Target,
        method: &str,
        params: P,
        cancel: Option<&CancellationToken>,
        timeout: Duration,
    ) -> IdeResult<R> {
        let params = serde_json::to_value(params).map_err(|e| IdeError::internal(e.to_string()))?;
        let stamp = self.injected_request_stamp(&params);
        let fut = async {
            if t.server.name == "csharp-ls" {
                let mut value = t.run.peer.request::<Value, Value>(method, params, cancel.cloned()).await?;
                virtual_doc::normalize_csharp_uris(&mut value);
                serde_json::from_value(value).map_err(|e| RpcError::Protocol(format!("{method}: {e}")))
            } else {
                t.run.peer.request::<Value, R>(method, params, cancel.cloned()).await
            }
        };
        let result = match tokio::time::timeout(timeout, fut).await {
            Ok(r) => r.map_err(|e| rpc_err(&t.server.name, method, e)),
            Err(_) => Err(rpc_err(&t.server.name, method, RpcError::Timeout)),
        };
        if let Some((doc, version)) = stamp {
            self.check_injected_request(doc, version)?;
        }
        result
    }

    // ---- features ----
    pub async fn completion(
        &self,
        doc: DocId,
        pos: Pos,
        trigger: Option<String>,
        cancel: CancellationToken,
    ) -> IdeResult<CompletionList> {
        let (snap, targets) = self.doc_targets(doc, "completion", |c| c.has("completionProvider")).await?;
        let requests = targets.iter().filter(|t| snap.asks(t, pos)).map(|t| {
            let context = match &trigger {
                Some(ch) if t.caps().completion_triggers().contains(ch) => {
                    json!({ "triggerKind": 2, "triggerCharacter": ch })
                }
                _ => json!({ "triggerKind": 1 }),
            };
            let mut params = snap.pos_params(t, pos);
            params["context"] = context;
            let cancel = &cancel;
            async move {
                let r = self.call::<_, Value>(t, "textDocument/completion", params, Some(cancel), COMPLETION_TIMEOUT);
                (t, r.await)
            }
        });
        let mut out = Outcome::new();
        for (t, result) in join_all(requests).await {
            match result {
                Ok(v) => {
                    let (incomplete, items) = convert::parse_completion_response(v);
                    let conv = self.conv(t.enc());
                    let list = out.value.get_or_insert(CompletionList { is_incomplete: false, items: Vec::new() });
                    list.is_incomplete |= incomplete;
                    list.items.extend(items.into_iter().filter_map(|i| {
                        let mut item = convert::completion_item(&conv, &snap.path, i, t.server.id);
                        self.bound_completion(doc, &mut item).then_some(item)
                    }));
                }
                Err(e) => out.fail(e),
            }
        }
        out.finish(CompletionList { is_incomplete: false, items: Vec::new() })
    }

    /// LSP 3.18 `textDocument/inlineCompletion` from every server advertising
    /// `inlineCompletionProvider` (`automatic`: triggered by typing, not explicitly).
    pub async fn inline_completion(
        &self,
        doc: DocId,
        pos: Pos,
        automatic: bool,
        cancel: CancellationToken,
    ) -> IdeResult<Vec<InlineCompletionItem>> {
        let (snap, targets) = self.doc_targets(doc, "inline completion", |c| c.has("inlineCompletionProvider")).await?;
        let requests = targets.iter().map(|t| {
            let mut params = snap.pos_params(t, pos);
            params["context"] = json!({ "triggerKind": if automatic { 2 } else { 1 } });
            let cancel = &cancel;
            async move {
                let r =
                    self.call::<_, Value>(t, "textDocument/inlineCompletion", params, Some(cancel), COMPLETION_TIMEOUT);
                (t, r.await)
            }
        });
        let mut out = Outcome::new();
        for (t, result) in join_all(requests).await {
            match result {
                Ok(v) => {
                    let conv = self.conv(t.enc());
                    let items = convert::inline_completion_items(&conv, &snap.path, v, t.server.id);
                    out.value.get_or_insert_with(Vec::new).extend(items);
                }
                Err(e) => out.fail(e),
            }
        }
        out.finish(Vec::new())
    }

    pub async fn resolve_completion(&self, doc: DocId, mut item: CompletionItem) -> IdeResult<CompletionItem> {
        let original = item.clone();
        let host_doc = doc;
        let doc = self.resolve_injected_origin(doc, &mut item.data)?;
        let snap = self.snapshot(doc)?;
        let Some(server) = snap.servers.iter().find(|s| s.id == item.server) else { return Ok(original) };
        let Some(t) = self
            .ready_targets(std::slice::from_ref(server), |c| c.has_sub("completionProvider", "resolveProvider"))
            .await
            .pop()
        else {
            return Ok(original);
        };
        if let Some(command) = item.command.take() {
            item.command = Some(self.injected_command(doc, command)?.1);
        }
        let lsp_item = convert::lsp_completion_item(&snap.text, t.enc(), &item);
        let resolved: lsp::CompletionItem =
            self.call(&t, "completionItem/resolve", lsp_item, None, DEFAULT_TIMEOUT).await?;
        if doc != host_doc {
            self.check_injected_request(doc, snap.version)?;
        }
        let mut out = item;
        convert::overlay_completion(&self.conv(t.enc()), &snap.path, &mut out, resolved, false);
        if !self.bound_completion(doc, &mut out) {
            return Err(IdeError::cancelled());
        }
        Ok(out)
    }

    pub async fn hover(&self, doc: DocId, pos: Pos, cancel: CancellationToken) -> IdeResult<Option<Hover>> {
        let (snap, targets) = self.doc_targets(doc, "hover", |c| c.has("hoverProvider")).await?;
        let mut out = Outcome::new();
        for t in targets.iter().filter(|t| snap.asks(t, pos)) {
            let r: IdeResult<Option<lsp::Hover>> =
                loading::while_loading(&t.server, Some(&cancel), loading::LOADING_WAIT, Option::is_none, || {
                    self.call(t, "textDocument/hover", snap.pos_params(t, pos), Some(&cancel), DEFAULT_TIMEOUT)
                })
                .await;
            match r {
                // Still loading: no documentation yet, not an error.
                Err(e) if e.kind == ErrorKind::TimedOut && t.server.is_loading() => out.value = Some(None),
                Ok(Some(h)) => {
                    if let Some(mut h) = convert::hover(&self.conv(t.enc()), &snap.path, h) {
                        if let Some(range) = h.range {
                            let Some(range) = self.clip_injected_range(doc, range) else { continue };
                            h.range = Some(range);
                        }
                        return Ok(Some(h));
                    }
                    out.value = Some(None);
                }
                Ok(None) => out.value = Some(None),
                Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
                Err(e) => out.fail(e),
            }
        }
        out.finish(None)
    }

    pub async fn signature_help(&self, doc: DocId, pos: Pos) -> IdeResult<Option<SignatureHelp>> {
        let (snap, targets) = self.doc_targets(doc, "signature help", |c| c.has("signatureHelpProvider")).await?;
        let mut out = Outcome::new();
        for t in targets.iter().filter(|t| snap.asks(t, pos)) {
            let mut params = snap.pos_params(t, pos);
            params["context"] = json!({ "triggerKind": 1, "isRetrigger": false });
            match self
                .call::<_, Option<lsp::SignatureHelp>>(t, "textDocument/signatureHelp", params, None, DEFAULT_TIMEOUT)
                .await
            {
                Ok(Some(h)) => {
                    if let Some(h) = convert::signature_help(t.enc(), h) {
                        return Ok(Some(h));
                    }
                    out.value = Some(None);
                }
                Ok(None) => out.value = Some(None),
                Err(e) => out.fail(e),
            }
        }
        out.finish(None)
    }

    pub async fn goto(&self, doc: DocId, pos: Pos, kind: GotoKind) -> IdeResult<Vec<Location>> {
        if matches!(kind, GotoKind::Definition) {
            let snap = self.snapshot(doc)?;
            if let Some(result) =
                self.configuration_navigation(&snap, pos, false, false, &CancellationToken::new()).await?
                && !result.locations.is_empty()
            {
                return Ok(result.locations);
            }
        }
        let (method, cap, feature) = goto_method(kind);
        let (snap, targets) = self.doc_targets(doc, feature, |c| c.has(cap)).await?;
        self.goto_in(&snap, &targets, method, pos, None, None).await
    }

    /// Go to Implementation, with the implementations found first passed to `partial` while
    /// the search goes on: jdtls answers from the project's sources quickly, then searches every
    /// dependency jar for a type declared in one. Returns them all, the first ones first.
    pub async fn goto_implementation(
        &self,
        doc: DocId,
        pos: Pos,
        cancel: CancellationToken,
        partial: &(dyn Fn(Vec<Location>) + Send + Sync),
    ) -> IdeResult<Vec<Location>> {
        let (method, cap, feature) = goto_method(GotoKind::Implementation);
        let (snap, targets) = self.doc_targets(doc, feature, |c| c.has(cap)).await?;
        self.goto_in(&snap, &targets, method, pos, Some(&cancel), Some(partial)).await
    }

    /// Implementations of the symbols at each of `positions` (gutter line
    /// markers), one list per position in order. A position whose request
    /// fails gets an empty list; when every one fails, the first error is
    /// returned (an unavailable server is not "no implementations").
    pub async fn implementations(
        &self,
        doc: DocId,
        positions: &[Pos],
        cancel: CancellationToken,
    ) -> IdeResult<Vec<Vec<Location>>> {
        let (method, cap, feature) = goto_method(GotoKind::Implementation);
        let (snap, targets) = self.doc_targets(doc, feature, |c| c.has(cap)).await?;
        let requests = positions.iter().copied().map(|pos| {
            let (snap, targets, cancel) = (&snap, &targets, &cancel);
            async move { self.goto_in(snap, targets, method, pos, Some(cancel), None).await }
        });
        let results: Vec<IdeResult<Vec<Location>>> =
            futures::stream::iter(requests).buffered(IMPLEMENTATION_CONCURRENCY).collect().await;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if !results.is_empty() && results.iter().all(Result::is_err) {
            return Err(results.into_iter().find_map(Result::err).expect("all failed"));
        }
        Ok(results.into_iter().map(Result::unwrap_or_default).collect())
    }

    /// jdtls: the implementations in the project's sources (`openidea.java.implementations`),
    /// and whether they are all there are. Its standard request builds the type hierarchy over
    /// every dependency jar too, which takes long in a project with many dependencies.
    async fn java_source_implementations(
        &self,
        snap: &DocSnap,
        t: &Target,
        pos: Pos,
        cancel: Option<&CancellationToken>,
    ) -> (Vec<Location>, bool) {
        if t.server.name != "jdtls" || !t.caps().commands().iter().any(|c| c == JAVA_IMPLEMENTATIONS) {
            return (Vec::new(), false);
        }
        let params = snap.pos_params(t, pos);
        let arguments =
            json!([params["textDocument"]["uri"], params["position"]["line"], params["position"]["character"]]);
        let result: IdeResult<SourceImplementations> = self
            .call(
                t,
                "workspace/executeCommand",
                json!({ "command": JAVA_IMPLEMENTATIONS, "arguments": arguments }),
                cancel,
                DEFAULT_TIMEOUT,
            )
            .await;
        match result {
            Ok(found) => {
                let locs =
                    convert::goto_response(&self.conv(t.enc()), lsp::GotoDefinitionResponse::Array(found.locations));
                let locs = library_sources(snap, pos, locs).await;
                self.note_virtual(&t.server, locs.iter().map(|l| l.uri.as_deref()));
                (locs, found.complete)
            }
            Err(e) => {
                tracing::debug!("{JAVA_IMPLEMENTATIONS}: {}", e.message);
                (Vec::new(), false)
            }
        }
    }

    async fn goto_in(
        &self,
        snap: &DocSnap,
        targets: &[Target],
        method: &str,
        pos: Pos,
        cancel: Option<&CancellationToken>,
        partial: Partial<'_>,
    ) -> IdeResult<Vec<Location>> {
        let mut out = Outcome::new();
        for t in targets.iter().filter(|t| snap.asks(t, pos)) {
            // Found in the sources before the standard request searches the dependencies too.
            let mut first = Vec::new();
            if method == "textDocument/implementation" {
                let (locs, complete) = self.java_source_implementations(snap, t, pos, cancel).await;
                if complete && !locs.is_empty() {
                    return Ok(locs);
                }
                if let Some(partial) = partial
                    && !locs.is_empty()
                {
                    partial(locs.clone());
                    first = locs;
                }
            }
            let r = loading::while_loading(&t.server, cancel, loading::LOADING_WAIT, goto_is_empty, || {
                self.call::<_, Option<lsp::GotoDefinitionResponse>>(
                    t,
                    method,
                    snap.pos_params(t, pos),
                    cancel,
                    DEFAULT_TIMEOUT,
                )
            })
            .await;
            match r {
                Ok(Some(r)) => {
                    let locs = convert::goto_response(&self.conv(t.enc()), r);
                    let locs = library_sources(snap, pos, locs).await;
                    self.note_virtual(&t.server, locs.iter().map(|l| l.uri.as_deref()));
                    self.note_arduino_sources(&t.server, &locs);
                    let locs = merge_locations(first, locs);
                    if !locs.is_empty() {
                        return Ok(locs);
                    }
                    out.value = Some(Vec::new());
                }
                Ok(None) if !first.is_empty() => return Ok(first),
                Ok(None) => out.value = Some(Vec::new()),
                // Those shown stay valid when the rest can't be found.
                Err(e) if !first.is_empty() && e.kind != ErrorKind::Cancelled => {
                    tracing::debug!("go to implementation in the dependencies: {}", e.message);
                    return Ok(first);
                }
                Err(e) => out.fail(e),
            }
        }
        out.finish(Vec::new())
    }

    /// References of the symbol at `pos`. With `project_wide`, files outside
    /// the servers' analysis scope that mention the name are opened for the
    /// search (see [`scope`]); without, only what the servers analyse counts
    /// (cheap, for bulk scans over many symbols).
    pub async fn references(
        &self,
        doc: DocId,
        pos: Pos,
        include_declaration: bool,
        project_wide: bool,
        cancel: CancellationToken,
    ) -> IdeResult<References> {
        self.references_streaming(doc, pos, include_declaration, project_wide, true, cancel, None).await
    }

    /// [`Self::references`]. Java: without `libraries`, only the workspace's sources
    /// are searched (`libraries_skipped`); with it and `project_wide`, those found
    /// there arrive on `partial` before the dependencies and the JDK are searched.
    #[allow(clippy::too_many_arguments)]
    pub async fn references_streaming(
        &self,
        doc: DocId,
        pos: Pos,
        include_declaration: bool,
        project_wide: bool,
        libraries: bool,
        cancel: CancellationToken,
        partial: PartialReferences<'_>,
    ) -> IdeResult<References> {
        let snap = self.snapshot(doc)?;
        if snap.language.as_str() != "java"
            && let Some(result) = self.configuration_navigation(&snap, pos, true, include_declaration, &cancel).await?
        {
            return Ok(result);
        }
        // Scoped probes back code lenses and bulk analysis. Keep their native cost;
        // configuration indexing is reserved for explicit, project-wide usages.
        let configuration = async {
            if project_wide && snap.language.as_str() == "java" {
                self.configuration_navigation(&snap, pos, true, include_declaration, &cancel).await
            } else {
                Ok(None)
            }
        };
        let native =
            self.native_references(doc, pos, include_declaration, project_wide, libraries, cancel.clone(), partial);
        futures::pin_mut!(configuration, native);
        let (configuration, result) = match futures::future::select(configuration, native).await {
            futures::future::Either::Left((configuration, native)) => (configuration, native.await),
            futures::future::Either::Right((result, configuration)) => {
                // The configuration index is rebuilt after Java changes, which takes seconds in a
                // project with many dependencies: the usages found meanwhile are shown first.
                if let (Some(partial), Ok(found)) = (partial, &result)
                    && !found.locations.is_empty()
                {
                    partial(found.clone());
                }
                (configuration.await, result)
            }
        };
        let configuration = configuration?;
        let mut result = result?;
        if let Some(configuration) = configuration {
            result.locations.extend(configuration.locations);
            result.incomplete = result.incomplete.or(configuration.incomplete);
            convert::dedup_locations(&mut result.locations);
        }
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    async fn native_references(
        &self,
        doc: DocId,
        pos: Pos,
        include_declaration: bool,
        project_wide: bool,
        libraries: bool,
        cancel: CancellationToken,
        partial: PartialReferences<'_>,
    ) -> IdeResult<References> {
        let (snap, targets) = self.doc_targets(doc, "find references", |c| c.has("referencesProvider")).await?;
        // The extension preserves method identity before JDT collapses references to locations.
        // Old/custom servers retain the standard protocol, including cancellation and scope widening.
        if targets.len() == 1
            && targets[0].server.name == "jdtls"
            && targets[0].caps().commands().iter().any(|c| c == "openidea.java.usages")
        {
            let classified = async {
                let t = &targets[0];
                let extension_error = Mutex::new(None);
                let (snap, cancel, extension_error) = (&snap, &cancel, &extension_error);
                // `sources`: the workspace's source folders only, without dependency jars and the JDK.
                let query = |sources: bool| async move {
                    if cancel.is_cancelled() || self.docs.lock().get(&doc).is_none_or(|d| d.version != snap.version) {
                        return Err(IdeError::cancelled());
                    }
                    let params = snap.pos_params(t, pos);
                    let mut arguments = json!([
                        params["textDocument"]["uri"],
                        params["position"]["line"],
                        params["position"]["character"],
                        include_declaration
                    ]);
                    if sources {
                        arguments.as_array_mut().expect("arguments").push(json!("sources"));
                    }
                    #[derive(serde::Deserialize)]
                    struct JavaReference {
                        #[serde(default)]
                        access: Option<ReferenceAccess>,
                        location: lsp::Location,
                        kind: ReferenceKind,
                        #[serde(default)]
                        text: Option<String>,
                    }
                    let result: IdeResult<Vec<JavaReference>> = self
                        .call(
                            t,
                            "workspace/executeCommand",
                            json!({ "command": "openidea.java.usages", "arguments": arguments }),
                            Some(cancel),
                            LONG_TIMEOUT,
                        )
                        .await;
                    if let Err(e) = &result {
                        *extension_error.lock() = Some(e.clone());
                    }
                    let rows = result?;
                    if cancel.is_cancelled() || self.docs.lock().get(&doc).is_none_or(|d| d.version != snap.version) {
                        return Err(IdeError::cancelled());
                    }
                    let conv = self.conv(t.enc());
                    Ok(rows
                        .into_iter()
                        .filter_map(|r| {
                            conv.location(&r.location).map(|location| ClassifiedReference {
                                location,
                                kind: r.kind,
                                access: r.access,
                                text: r.text,
                            })
                        })
                        .collect::<Vec<_>>())
                };
                let files = |v: &Vec<ClassifiedReference>| {
                    v.iter().filter(|r| r.location.uri.is_none()).map(|r| r.location.path.to_path_buf()).collect()
                };
                let mut libraries_skipped = false;
                let widened = if project_wide {
                    // A library method has thousands of usages in the dependencies and the JDK,
                    // which take seconds to search: those in the sources (where scope widening
                    // searches again) are shown first, then the rest are searched once.
                    let sources = self.widened(snap, t, pos, cancel, || query(true), files).await?;
                    if let Some(e) = extension_error.lock().take() {
                        return Err(e);
                    }
                    let mut seen = std::collections::HashSet::new();
                    let found: Vec<_> = sources
                        .second
                        .into_iter()
                        .flatten()
                        .chain(sources.first)
                        .filter(|r| seen.insert(r.location.clone()))
                        .collect();
                    let all = if !libraries {
                        libraries_skipped = true;
                        Vec::new()
                    } else {
                        if let Some(partial) = partial
                            && !found.is_empty()
                        {
                            partial(References {
                                locations: found.iter().map(|r| r.location.clone()).collect(),
                                classified: found.clone(),
                                incomplete: sources.incomplete,
                                libraries_skipped: false,
                            });
                        }
                        query(false).await?
                    };
                    scope::Widened { first: all, second: Some(found), incomplete: sources.incomplete }
                } else {
                    // Scoped probes (usage counts, bulk scans) run for many symbols at once:
                    // without `libraries`, the dependencies and the JDK are not searched.
                    libraries_skipped = !libraries;
                    let first = query(!libraries).await?;
                    let empty = first.is_empty();
                    scope::Widened::only(first, empty, &t.server)
                };
                // A changed source also invalidates an earlier answer retained by scope widening.
                if cancel.is_cancelled() || self.docs.lock().get(&doc).is_none_or(|d| d.version != snap.version) {
                    return Err(IdeError::cancelled());
                }
                // Scope widening can retain the first answer after a failed second query.
                if let Some(e) = extension_error.lock().take() {
                    return Err(e);
                }
                let mut seen = std::collections::HashSet::new();
                // Prefer the second query's metadata for repeated locations.
                let classified: Vec<_> = widened
                    .second
                    .into_iter()
                    .flatten()
                    .chain(widened.first)
                    .filter(|r| seen.insert(r.location.clone()))
                    .collect();
                let locations: Vec<Location> = classified.iter().map(|r| r.location.clone()).collect();
                self.note_virtual(&t.server, locations.iter().map(|l| l.uri.as_deref()));
                self.note_arduino_sources(&t.server, &locations);
                Ok(References { locations, classified, incomplete: widened.incomplete, libraries_skipped })
            }
            .await;
            match classified {
                Ok(references) => return Ok(references),
                Err(e) => {
                    if e.kind == ErrorKind::Cancelled
                        || cancel.is_cancelled()
                        || self.docs.lock().get(&doc).is_none_or(|d| d.version != snap.version)
                    {
                        return Err(IdeError::cancelled());
                    }
                    if !self.java_usages_warned.swap(true, Ordering::Relaxed) {
                        tracing::warn!("Java usages extension failed; using standard references: {e}");
                    }
                }
            }
        }
        let requests = targets.iter().map(|t| {
            let (snap, cancel) = (&snap, &cancel);
            async move {
                // The Angular server searches the file's own project only: more open
                // files don't widen it.
                let angular = t.server.name == angular::SERVER;
                let query = || async move {
                    let mut params = snap.pos_params(t, pos);
                    params["context"] = json!({ "includeDeclaration": include_declaration });
                    let locs: Option<Vec<lsp::Location>> =
                        self.call(t, "textDocument/references", params, Some(cancel), LONG_TIMEOUT).await?;
                    let conv = self.conv(t.enc());
                    Ok(locs.unwrap_or_default().iter().filter_map(|l| conv.location(l)).collect::<Vec<Location>>())
                };
                let files =
                    |v: &Vec<Location>| v.iter().filter(|l| l.uri.is_none()).map(|l| l.path.to_path_buf()).collect();
                let result = if project_wide && !angular {
                    self.widened(snap, t, pos, cancel, query, files).await
                } else {
                    query().await.map(|first| {
                        let empty = first.is_empty();
                        scope::Widened::only(first, empty, &t.server)
                    })
                };
                (t, result)
            }
        });
        // The Angular server lists the declaration even when not asked to: the one
        // the definition at `pos` points to is taken out of its answer.
        let declarations = async {
            if include_declaration || !targets.iter().any(|t| t.server.name == angular::SERVER) {
                return Vec::new();
            }
            let defining = self.ready_targets(&snap.servers, |c| c.has("definitionProvider")).await;
            self.goto_in(&snap, &defining, "textDocument/definition", pos, Some(&cancel), None)
                .await
                .unwrap_or_default()
        };
        let (results, declarations) = futures::join!(join_all(requests), declarations);
        let mut out = Outcome::new();
        for (t, r) in results {
            match r {
                Ok(w) => {
                    let acc = out.value.get_or_insert_with(References::default);
                    let mut locs: Vec<Location> = w.first.into_iter().chain(w.second.into_iter().flatten()).collect();
                    if t.server.name == angular::SERVER {
                        locs.retain(|l| !declarations.contains(l));
                    }
                    self.note_virtual(&t.server, locs.iter().map(|l| l.uri.as_deref()));
                    self.note_arduino_sources(&t.server, &locs);
                    acc.locations.extend(locs);
                    acc.incomplete = acc.incomplete.or(w.incomplete);
                }
                Err(e) => out.fail(e),
            }
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let mut v = out.finish(References::default())?;
        convert::dedup_locations(&mut v.locations);
        if project_wide && let Some(t) = targets.first().filter(|_| snap.language.as_str() == "go") {
            // Usages in other modules take a view per module: those in reach come first.
            if let Some(partial) = partial
                && !v.locations.is_empty()
            {
                partial(v.clone());
            }
            v.locations.extend(self.go_mentions_beyond_search(&snap, t, pos, &cancel, false).await.locations);
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            convert::dedup_locations(&mut v.locations);
        }
        Ok(v)
    }

    pub async fn document_highlights(&self, doc: DocId, pos: Pos) -> IdeResult<Vec<Highlight>> {
        let (snap, targets) =
            self.doc_targets(doc, "document highlights", |c| c.has("documentHighlightProvider")).await?;
        let mut out = Outcome::new();
        for t in &targets {
            let r = self
                .call::<_, Option<Vec<lsp::DocumentHighlight>>>(
                    t,
                    "textDocument/documentHighlight",
                    snap.pos_params(t, pos),
                    None,
                    DEFAULT_TIMEOUT,
                )
                .await;
            match r {
                Ok(Some(hs)) if !hs.is_empty() => {
                    let conv = self.conv(t.enc());
                    return Ok(hs
                        .into_iter()
                        .filter_map(|h| {
                            let mut h = convert::highlight(&conv, &snap.path, h);
                            h.range = self.clip_injected_range(doc, h.range)?;
                            Some(h)
                        })
                        .collect());
                }
                Ok(_) => out.value = Some(Vec::new()),
                Err(e) => out.fail(e),
            }
        }
        out.finish(Vec::new())
    }

    pub async fn document_symbols(&self, doc: DocId) -> IdeResult<Option<Vec<OutlineItem>>> {
        let snap = self.snapshot(doc)?;
        let targets = self.ready_targets(&snap.servers, |c| c.has("documentSymbolProvider")).await;
        let mut out = Outcome::new();
        for t in &targets {
            let params = json!({ "textDocument": snap.ident() });
            match self
                .call::<_, Option<lsp::DocumentSymbolResponse>>(
                    t,
                    "textDocument/documentSymbol",
                    params,
                    None,
                    DEFAULT_TIMEOUT,
                )
                .await
            {
                Ok(Some(r)) => return Ok(Some(convert::document_symbols(&self.conv(t.enc()), &snap.path, r))),
                Ok(None) => out.value = Some(Some(Vec::new())),
                Err(e) => out.fail(e),
            }
        }
        out.finish(None)
    }

    pub async fn workspace_symbols(&self, query: &str, cancel: CancellationToken) -> IdeResult<Vec<WorkspaceSymbol>> {
        let servers: Vec<Arc<Server>> = self.servers.lock().clone();
        let targets = self.ready_targets(&servers, |c| c.has("workspaceSymbolProvider")).await;
        if targets.is_empty() {
            return Err(unsupported(&servers, "workspace symbols"));
        }
        let requests = targets.iter().map(|t| {
            let cancel = &cancel;
            async move {
                let r = self
                    .call::<_, Option<lsp::WorkspaceSymbolResponse>>(
                        t,
                        "workspace/symbol",
                        json!({ "query": query }),
                        Some(cancel),
                        DEFAULT_TIMEOUT,
                    )
                    .await;
                (t, r)
            }
        });
        let mut out = Outcome::new();
        for (t, r) in join_all(requests).await {
            match r {
                Ok(r) => {
                    let acc = out.value.get_or_insert_with(Vec::new);
                    if let Some(r) = r {
                        let syms = convert::workspace_symbols(&self.conv(t.enc()), r);
                        self.note_virtual(&t.server, syms.iter().map(|s| s.location.uri.as_deref()));
                        acc.extend(syms);
                    }
                }
                Err(e) => out.fail(e),
            }
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        out.finish(Vec::new())
    }

    pub async fn code_actions(&self, doc: DocId, range: Range, only: Vec<String>) -> IdeResult<Vec<CodeAction>> {
        self.query_code_actions(doc, range, only, None).await.map(|q| q.actions)
    }

    /// Like [`Self::code_actions`], cancellable, with the servers' advertised kinds.
    pub async fn code_action_query(
        &self,
        doc: DocId,
        range: Range,
        only: Vec<String>,
        cancel: CancellationToken,
    ) -> IdeResult<CodeActionQuery> {
        let result = self.query_code_actions(doc, range, only, Some(&cancel)).await;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        result
    }

    async fn query_code_actions(
        &self,
        doc: DocId,
        range: Range,
        only: Vec<String>,
        cancel: Option<&CancellationToken>,
    ) -> IdeResult<CodeActionQuery> {
        let (snap, targets) = self.doc_targets(doc, "code actions", |c| c.has("codeActionProvider")).await?;
        let advertised_kinds = targets.iter().try_fold(Vec::<String>::new(), |mut acc, t| {
            for k in t.caps().code_action_kinds()? {
                if !acc.contains(&k) {
                    acc.push(k);
                }
            }
            Some(acc)
        });
        let with_diagnostics = !source_actions_only(&only);
        let requests = targets.iter().map(|t| {
            let lsp_range = snap.range(t, range);
            let diagnostics: Vec<lsp::Diagnostic> = if with_diagnostics {
                t.server
                    .diagnostics_for(&snap.path)
                    .into_iter()
                    .filter(|d| convert::ranges_overlap(d.range, lsp_range))
                    .collect()
            } else {
                Vec::new()
            };
            let mut context = json!({ "diagnostics": diagnostics, "triggerKind": 1 });
            if !only.is_empty() {
                context["only"] = json!(only);
            }
            let params = json!({ "textDocument": snap.ident(), "range": lsp_range, "context": context });
            async move {
                (
                    t,
                    self.call::<_, Option<Vec<lsp::CodeActionOrCommand>>>(
                        t,
                        "textDocument/codeAction",
                        params,
                        cancel,
                        DEFAULT_TIMEOUT,
                    )
                    .await,
                )
            }
        });
        let mut out = Outcome::new();
        for (t, r) in join_all(requests).await {
            match r {
                Ok(actions) => {
                    let conv = self.conv(t.enc());
                    let acc = out.value.get_or_insert_with(Vec::new);
                    let caps = t.caps();
                    acc.extend(
                        actions
                            .unwrap_or_default()
                            .into_iter()
                            .map(|a| {
                                let mut action =
                                    convert::code_action(&conv, &snap.path, a, t.server.id, &t.server.name);
                                self.tag_injected_origin(doc, &mut action.data);
                                self.tag_injected_command(doc, action.server, &mut action.command);
                                action
                            })
                            // Servers may ignore `only`, and the kinds kept for this one.
                            .filter(|a| caps.restriction.keeps_action(a.kind.as_deref())),
                    );
                }
                Err(e) => out.fail(e),
            }
        }
        out.finish(Vec::new()).map(|actions| CodeActionQuery { actions, advertised_kinds })
    }

    pub async fn resolve_code_action(&self, doc: DocId, mut action: CodeAction) -> IdeResult<CodeAction> {
        let original = action.clone();
        let host_doc = doc;
        let doc = self.resolve_injected_origin(doc, &mut action.data)?;
        let snap = self.snapshot(doc)?;
        let servers: Vec<Arc<Server>> = match snap.servers.iter().find(|s| s.id == action.server) {
            Some(s) => vec![s.clone()],
            None => self.servers.lock().iter().filter(|s| s.id == action.server).cloned().collect(),
        };
        let Some(t) = self.ready_targets(&servers, |c| c.has_sub("codeActionProvider", "resolveProvider")).await.pop()
        else {
            return Ok(original);
        };
        if let Some(command) = action.command.take() {
            action.command = Some(self.injected_command(doc, command)?.1);
        }
        let resolved: lsp::CodeAction =
            self.call(&t, "codeAction/resolve", convert::lsp_code_action(&action), None, DEFAULT_TIMEOUT).await?;
        if doc != host_doc {
            self.check_injected_request(doc, snap.version)?;
        }
        let mut action = convert::merge_code_action(&self.conv(t.enc()), action, resolved);
        self.tag_injected_origin(doc, &mut action.data);
        self.tag_injected_command(doc, action.server, &mut action.command);
        Ok(action)
    }

    pub async fn execute_command(&self, doc: DocId, command: Command) -> IdeResult<()> {
        if command.command == injections::COMMAND {
            self.refresh_injections(doc).await?;
        }
        let (doc, command, server) = self.injected_command(doc, command)?;
        let servers = match self.snapshot(doc) {
            Ok(snap) => snap.servers,
            Err(_) => self.servers.lock().clone(),
        };
        let name = command.command.clone();
        let servers: Vec<_> = servers.into_iter().filter(|s| server.is_none_or(|id| s.id == id)).collect();
        let targets = self.ready_targets(&servers, |c| c.commands().contains(&name)).await;
        let t = targets
            .first()
            .ok_or_else(|| IdeError::unavailable(format!("no language server provides command `{name}`")))?;
        let params = json!({ "command": command.command, "arguments": command.arguments });
        let _: Value = self.call(t, "workspace/executeCommand", params, None, LONG_TIMEOUT).await?;
        Ok(())
    }

    /// Whether a server of `doc` (`server`, when given) provides the command `name`. Code actions
    /// can carry commands other editors' extensions run themselves after the edit (vtsls'
    /// `_typescript.didOrganizeImports`): no server provides those.
    pub async fn provides_command(&self, doc: DocId, server: Option<ide_core::ServerId>, name: &str) -> bool {
        if name == injections::COMMAND {
            return self.provides_injected_command(doc, server);
        }
        let servers = match self.snapshot(doc) {
            Ok(snap) => snap.servers,
            Err(_) => self.servers.lock().clone(),
        };
        self.ready_targets(&servers, |c| c.commands().iter().any(|c| c == name))
            .await
            .iter()
            .any(|t| server.is_none_or(|s| t.server.id == s))
    }

    async fn command_target(&self, doc: DocId, server: ide_core::ServerId, name: &str) -> IdeResult<Target> {
        let snap = self.snapshot(doc)?;
        self.ready_targets(&snap.servers, |c| c.commands().iter().any(|c| c == name))
            .await
            .into_iter()
            .find(|t| t.server.id == server)
            .ok_or_else(|| IdeError::unavailable(format!("no language server provides command `{name}`")))
    }

    /// Resolve only after explicit invocation; previews must never ask for input.
    pub async fn resolve_command(
        &self,
        doc: DocId,
        server: ide_core::ServerId,
        command: Command,
        answers: Vec<FormAnswer>,
        cancel: CancellationToken,
    ) -> IdeResult<Option<CommandForm>> {
        let (doc, command, pinned) = self.injected_command(doc, command)?;
        if pinned.is_some_and(|id| id != server) {
            return Err(IdeError::cancelled());
        }
        // Nothing to ask for a command its server doesn't provide (executing it decides).
        if !self.provides_command(doc, Some(server), &command.command).await {
            return Ok(None);
        }
        let t = self.command_target(doc, server, &command.command).await?;
        let interactive = t.server.name == "gopls"
            && t.caps()
                .raw
                .pointer("/experimental/interactiveResolveProvider/kinds")
                .and_then(Value::as_array)
                .is_some_and(|k| k.iter().any(|v| v == "command"));
        if !interactive {
            return Ok(None);
        }
        let params = json!({ "command": command.command, "arguments": command.arguments, "formAnswers": answers });
        let response: Value = self.call(&t, "command/resolve", params, Some(&cancel), LONG_TIMEOUT).await?;
        let parse_error = |e: serde_json::Error| IdeError::internal(format!("invalid command form: {e}"));
        let fields = response.get("formFields").filter(|v| !v.is_null()).cloned().unwrap_or(json!([]));
        for field in fields.as_array().into_iter().flatten() {
            if field.pointer("/type/kind").and_then(Value::as_str) != Some("string") {
                return Err(IdeError::unavailable("unsupported command input type"));
            }
        }
        let mut command = Some(Command {
            title: command.title,
            command: response
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| IdeError::internal("command form omitted command"))?
                .to_owned(),
            arguments: serde_json::from_value(response.get("arguments").cloned().unwrap_or(json!([])))
                .map_err(parse_error)?,
        });
        self.tag_injected_command(doc, server, &mut command);
        Ok(Some(CommandForm {
            command: command.expect("resolved command"),
            form_fields: serde_json::from_value(fields).map_err(parse_error)?,
            form_answers: serde_json::from_value(
                response.get("formAnswers").filter(|v| !v.is_null()).cloned().unwrap_or(json!([])),
            )
            .map_err(parse_error)?,
        }))
    }

    /// Execute on the originating server and return files from successfully applied edits.
    pub async fn execute_action_command(
        &self,
        doc: DocId,
        server: ide_core::ServerId,
        command: Command,
        answers: Vec<FormAnswer>,
        cancel: CancellationToken,
    ) -> IdeResult<Vec<PathBuf>> {
        if command.command == injections::COMMAND {
            self.refresh_injections(doc).await?;
        }
        let (doc, command, pinned) = self.injected_command(doc, command)?;
        if pinned.is_some_and(|id| id != server) {
            return Err(IdeError::cancelled());
        }
        let t = self.command_target(doc, server, &command.command).await?;
        let open_created = t.server.name == "gopls" && command.command == "gopls.add_test";
        let mut edits = self.applied_edits.subscribe();
        let mut params = json!({ "command": command.command, "arguments": command.arguments });
        if !answers.is_empty() {
            params["formAnswers"] = json!(answers);
        }
        let _: Value = self.call(&t, "workspace/executeCommand", params, Some(&cancel), LONG_TIMEOUT).await?;
        let mut created = Vec::new();
        while let Ok((origin, edit)) = edits.try_recv() {
            if open_created && origin == server {
                for file in edit.files {
                    if let ide_core::FileEdit::Create { path, .. } = file {
                        created.push(path.into());
                    }
                }
            }
        }
        Ok(created)
    }

    pub async fn prepare_rename(&self, doc: DocId, pos: Pos) -> IdeResult<Option<Range>> {
        let (snap, targets) = self.doc_targets(doc, "rename", |c| c.has("renameProvider")).await?;
        let mut out = Outcome::new();
        for t in &targets {
            match self.prepare_rename_on(&snap, t, pos).await {
                Ok(Some(range)) => return Ok(Some(range)),
                Ok(None) => out.value = Some(None),
                Err(e) => out.fail(e),
            }
        }
        out.finish(None)
    }

    /// What `t` renames at `pos`; one without `prepareRename` renames the word there.
    async fn prepare_rename_on(&self, snap: &DocSnap, t: &Target, pos: Pos) -> IdeResult<Option<Range>> {
        if !t.caps().has_sub("renameProvider", "prepareProvider") {
            return Ok(snap.text.word_range_at(pos));
        }
        let r: Option<lsp::PrepareRenameResponse> =
            self.call(t, "textDocument/prepareRename", snap.pos_params(t, pos), None, DEFAULT_TIMEOUT).await?;
        let conv = self.conv(t.enc());
        Ok(match r {
            None => None,
            Some(lsp::PrepareRenameResponse::Range(r)) => Some(conv.range(&snap.path, r)),
            Some(lsp::PrepareRenameResponse::RangeWithPlaceholder { range, .. }) => Some(conv.range(&snap.path, range)),
            Some(lsp::PrepareRenameResponse::DefaultBehavior { default_behavior }) => {
                if default_behavior {
                    snap.text.word_range_at(pos)
                } else {
                    None
                }
            }
        })
    }

    /// Renames across the project: like [`Self::references`], files outside the
    /// server's analysis scope that mention the name are opened for the request.
    /// Every server that can rename there does: the Angular server adds the
    /// templates to vtsls's edit, whose own edits win where both change the same text.
    pub async fn rename(
        &self,
        doc: DocId,
        pos: Pos,
        new_name: String,
        cancel: CancellationToken,
    ) -> IdeResult<Renamed> {
        let (snap, targets) = self.doc_targets(doc, "rename", |c| c.has("renameProvider")).await?;
        let renaming = self.rename_targets(&snap, &targets, pos).await;
        let edits = join_all(renaming.into_iter().map(|t| self.rename_on(&snap, t, pos, &new_name, &cancel))).await;
        let mut out = Outcome::new();
        let mut incomplete = None;
        for edit in edits {
            match edit {
                Ok(renamed) => {
                    incomplete = incomplete.or(renamed.incomplete);
                    match &mut out.value {
                        Some(merged) => convert::merge_workspace_edit(merged, renamed.edit),
                        None => out.value = Some(renamed.edit),
                    }
                }
                Err(e) => out.fail(e),
            }
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        Ok(Renamed { preview: false, edit: out.finish(WorkspaceEdit::default())?, incomplete })
    }

    /// The servers that can rename at `pos`, the first one when none can (a
    /// single one is asked without `prepareRename`).
    async fn rename_targets<'t>(&self, snap: &DocSnap, targets: &'t [Target], pos: Pos) -> Vec<&'t Target> {
        if targets.len() > 1 {
            let prepared = join_all(targets.iter().map(|t| self.prepare_rename_on(snap, t, pos))).await;
            let able: Vec<&Target> =
                targets.iter().zip(prepared).filter(|(_, r)| matches!(r, Ok(Some(_)))).map(|(t, _)| t).collect();
            if !able.is_empty() {
                return able;
            }
        }
        vec![&targets[0]]
    }

    async fn rename_on(
        &self,
        snap: &DocSnap,
        t: &Target,
        pos: Pos,
        new_name: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<Renamed> {
        let query = || async {
            let mut params = snap.pos_params(t, pos);
            params["newName"] = json!(new_name);
            // A server still analysing an edit withdraws the rename (`ContentModified`, which
            // arrives as a cancellation). The user asked for it: ask again shortly instead of
            // dropping it without a word, and say why if it keeps being withdrawn.
            let mut attempt = 0;
            let r: Option<lsp::WorkspaceEdit> = loop {
                match self.call(t, "textDocument/rename", params.clone(), Some(cancel), LONG_TIMEOUT).await {
                    Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled && !cancel.is_cancelled() => {
                        attempt += 1;
                        if attempt >= RENAME_ATTEMPTS {
                            return Err(IdeError::invalid(format!(
                                "{} was still analysing a change and withdrew the rename; try again",
                                t.server.name
                            )));
                        }
                        tokio::time::sleep(RENAME_RETRY_DELAY).await;
                    }
                    r => break r?,
                }
            };
            Ok(r.map(|e| convert::workspace_edit(&self.conv(t.enc()), e)).unwrap_or_default())
        };
        // The Angular server renames in the file's own project only, whatever is open.
        if t.server.name == angular::SERVER {
            let edit = query().await?;
            let empty = edit.files.is_empty();
            let w = scope::Widened::only((), empty, &t.server);
            return Ok(Renamed { preview: false, edit, incomplete: w.incomplete });
        }
        let files = |e: &WorkspaceEdit| {
            e.files
                .iter()
                .filter_map(|f| match f {
                    ide_core::FileEdit::Edit { path, .. } => Some(path.to_path_buf()),
                    _ => None,
                })
                .collect()
        };
        let w = self.widened(snap, t, pos, cancel, query, files).await?;
        // The second edit covers the first: its files stay analysed.
        let mut edit = w.second.unwrap_or(w.first);
        let mut more: BTreeMap<PathBuf, Vec<TextEdit>> = BTreeMap::new();
        for l in self.go_mentions_beyond_search(snap, t, pos, cancel, false).await.locations {
            more.entry(l.path.to_path_buf())
                .or_default()
                .push(TextEdit { range: l.range, new_text: new_name.to_owned() });
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let files =
            more.into_iter().map(|(path, edits)| ide_core::FileEdit::Edit { path: path.into(), edits, version: None });
        convert::merge_workspace_edit(&mut edit, WorkspaceEdit { files: files.collect(), ..Default::default() });
        Ok(Renamed { preview: false, edit, incomplete: w.incomplete })
    }

    // ---- file operations (`workspace/willRenameFiles`, `workspace/didRenameFiles`) ----

    /// Servers that may care about `paths` (with `is_dir`) moving: those serving
    /// their languages (started when needed) and every other running server.
    fn servers_for_paths(&self, paths: &[(PathBuf, bool)]) -> Vec<Arc<Server>> {
        let mut out: Vec<Arc<Server>> = Vec::new();
        for (path, is_dir) in paths {
            let files = if *is_dir { sample_files(path, FILE_OP_SAMPLE) } else { vec![path.clone()] };
            let mut langs: Vec<LanguageId> = Vec::new();
            for f in &files {
                let l = self.languages.detect(f, None);
                if !langs.contains(&l) {
                    langs.push(l);
                }
            }
            for l in langs {
                for s in self.servers_for(&l, path) {
                    if !out.iter().any(|o| o.id == s.id) {
                        out.push(s);
                    }
                }
            }
        }
        let running: Vec<Arc<Server>> = self.servers.lock().iter().filter(|s| s.running().is_some()).cloned().collect();
        for s in running {
            if !out.iter().any(|o| o.id == s.id) {
                out.push(s);
            }
        }
        out
    }

    /// `{ files: [{ oldUri, newUri }] }` for the moves `t`'s `op` filters accept.
    fn file_op_params(t: &Target, op: &str, moves: &[(PathBuf, PathBuf, bool)]) -> Option<Value> {
        let caps = t.caps();
        let filters = file_ops::parse_filters(caps.file_operation(op))?;
        let files: Vec<Value> = moves
            .iter()
            .filter(|(from, _, is_dir)| file_ops::any_match(&filters, from, *is_dir))
            .map(|(from, to, _)| json!({ "oldUri": uri::path_to_uri(from), "newUri": uri::path_to_uri(to) }))
            .collect();
        (!files.is_empty()).then(|| json!({ "files": files }))
    }

    /// Some servers (tsserver) only answer for files of a loaded project: when
    /// `t` has no document open, one moved file of its languages is opened for the request.
    fn open_for_file_op(&self, t: &Target, moves: &[(PathBuf, PathBuf, bool)]) -> scope::TransientFiles<'_> {
        let mut opened = scope::TransientFiles::empty(self, t);
        if !t.caps().open_close {
            return opened;
        }
        let busy =
            self.docs.lock().values().any(|d| {
                d.servers.iter().any(|a| a.server.id == t.server.id && a.opened_gen == Some(t.run.generation))
            });
        if busy {
            return opened;
        }
        let languages = t.server.languages();
        let candidate =
            moves.iter().flat_map(
                |(from, _, is_dir)| {
                    if *is_dir { sample_files(from, FILE_OP_SAMPLE) } else { vec![from.clone()] }
                },
            );
        for file in candidate {
            // A move may have already removed the sampled entry on disk.
            if !file.is_file() {
                continue;
            }
            let language = self.languages.detect(&file, None);
            if !languages.contains(&language) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            opened.hold(&file, &language, &text);
            break;
        }
        opened
    }

    /// Asks the servers for the edits that keep references intact when files or
    /// folders move (`moves`: from → to, before the move happens).
    pub async fn will_rename_files(
        &self,
        moves: &[(PathBuf, PathBuf)],
        cancel: CancellationToken,
    ) -> IdeResult<FileRenameEdits> {
        let moves: Vec<(PathBuf, PathBuf, bool)> =
            moves.iter().map(|(f, t)| (f.clone(), t.clone(), f.is_dir())).collect();
        let servers = self.servers_for_paths(&moves.iter().map(|(f, _, d)| (f.clone(), *d)).collect::<Vec<_>>());
        for s in &servers {
            self.ensure_started(s);
        }
        let ready = join_all(servers.iter().map(|s| s.wait_ready(FILE_OP_START_WAIT))).await;
        let targets: Vec<Target> =
            servers.iter().zip(ready).filter_map(|(s, run)| Some(Target { server: s.clone(), run: run? })).collect();
        let mut out = FileRenameEdits::default();
        for t in targets {
            let Some(params) = Self::file_op_params(&t, "willRename", &moves) else {
                if t.server.config.tsserver_project && t.caps().commands().iter().any(|c| c == ts_file_moves::COMMAND) {
                    out.servers.push(t.server.name.clone());
                    let opened = self.open_for_file_op(&t, &moves);
                    for (from, to, _) in &moves {
                        let r: IdeResult<Value> = self
                            .call(
                                &t,
                                "workspace/executeCommand",
                                ts_file_moves::request(from, to),
                                Some(&cancel),
                                LONG_TIMEOUT,
                            )
                            .await;
                        match r {
                            Ok(result) => out.edit.files.extend(ts_file_moves::edit(&result).files),
                            Err(e) if e.kind == ErrorKind::Cancelled && cancel.is_cancelled() => return Err(e),
                            Err(e) => out.errors.push(e.message),
                        }
                    }
                    drop(opened);
                }
                continue;
            };
            out.servers.push(t.server.name.clone());
            let opened = self.open_for_file_op(&t, &moves);
            let r: IdeResult<Option<lsp::WorkspaceEdit>> =
                self.call(&t, "workspace/willRenameFiles", params, Some(&cancel), LONG_TIMEOUT).await;
            drop(opened);
            match r {
                Ok(Some(edit)) => out.edit.files.extend(convert::workspace_edit(&self.conv(t.enc()), edit).files),
                Ok(None) => {}
                Err(e) if e.kind == ErrorKind::Cancelled && cancel.is_cancelled() => return Err(e),
                Err(e) => out.errors.push(e.message),
            }
        }
        Ok(out)
    }

    /// Tells running servers that files or folders moved (`moves`: from → to, after the move).
    pub fn did_rename_files(&self, moves: &[(PathBuf, PathBuf)]) {
        if !moves.is_empty() {
            self.configuration_cache.lock().invalidate_paths();
        }
        let moves: Vec<(PathBuf, PathBuf, bool)> =
            moves.iter().map(|(f, t)| (f.clone(), t.clone(), t.is_dir())).collect();
        let servers: Vec<Arc<Server>> = self.servers.lock().clone();
        for s in servers {
            let Some(run) = s.running() else { continue };
            let t = Target { server: s.clone(), run };
            let Some(params) = Self::file_op_params(&t, "didRename", &moves) else { continue };
            if let Err(e) = t.run.peer.notify("workspace/didRenameFiles", params) {
                tracing::debug!("{}: didRenameFiles: {e}", s.name);
            }
        }
    }

    /// Files that changed on disk, outside the editor too (a checkout, another tool), sent to
    /// running servers through `workspace/didChangeWatchedFiles`. A server that registered file
    /// watchers hears of what they match, including `excluded_dirs` (folders in excluded or
    /// ignored trees whose entries came or went, reported as created): a package installed
    /// into `.venv` or a `go.mod` rewritten by `go get` is picked up without a restart. Other
    /// servers hear of their languages' files under their root; without it jdtls's incremental
    /// build never sees them, so a launch runs stale classes.
    ///
    /// Creates and changes for documents synced on a server's current instance are left out.
    /// Their text reaches the server through `didOpen`/`didChange`, including clean-buffer
    /// reloads. A server that re-reads the file on the watched change (csharp-ls) would apply
    /// the reload and then the `didChange` computed against the pre-reload copy, so it would
    /// keep analysing content that diverges from both the disk and the editor (#1780).
    /// Deletions still reach it: document sync does not describe workspace membership.
    pub fn watched_files_changed(
        &self,
        created: &[PathBuf],
        modified: &[PathBuf],
        removed: &[PathBuf],
        excluded_dirs: &[PathBuf],
    ) {
        use file_watch::Change;
        if !created.is_empty() || !removed.is_empty() || !excluded_dirs.is_empty() {
            self.configuration_cache.lock().invalidate_paths();
        }
        let servers: Vec<Arc<Server>> = self.servers.lock().clone();
        let open: HashMap<(ide_core::ServerId, u64), HashSet<PathBuf>> = {
            let docs = self.docs.lock();
            let mut open: HashMap<_, HashSet<_>> = HashMap::new();
            for d in docs.values() {
                for a in &d.servers {
                    if let Some(generation) = a.opened_gen {
                        open.entry((a.server.id, generation))
                            .or_default()
                            .extend([d.path.clone(), d.canonical.clone()]);
                    }
                }
            }
            open
        };
        let canonical: HashMap<_, _> =
            created.iter().chain(modified).filter_map(|p| dunce::canonicalize(p).ok().map(|c| (p, c))).collect();
        for s in servers {
            let Some(run) = s.running() else { continue };
            let open = open.get(&(s.id, run.generation)).filter(|_| run.caps.read().sync != SyncKind::None);
            let send = |p: &PathBuf, change: Change| {
                change == Change::Deleted
                    || !open
                        .is_some_and(|paths| paths.contains(p) || canonical.get(p).is_some_and(|c| paths.contains(c)))
            };
            let all = [(created, Change::Created), (modified, Change::Changed), (removed, Change::Deleted)]
                .into_iter()
                .flat_map(|(paths, change)| paths.iter().map(move |p| (p, change)));
            let watchers = run.watchers.read();
            let roots = self.server_workspace_roots(&s);
            let changes: Vec<(&PathBuf, Change)> = if watchers.is_empty() {
                // Dart watches the filesystem itself and rejects this unregistered notification.
                if s.name == "dart" {
                    continue;
                }
                let languages = s.languages();
                all.filter(|(p, change)| {
                    roots.iter().any(|root| p.starts_with(root))
                        && languages.contains(&self.languages.detect(p, None))
                        && send(p, *change)
                })
                .collect()
            } else {
                all.chain(excluded_dirs.iter().map(|p| (p, Change::Created)))
                    .filter(|(p, change)| roots.iter().any(|root| watchers.wants(root, p, *change)) && send(p, *change))
                    .collect()
            };
            drop(watchers);
            if changes.is_empty() {
                continue;
            }
            let changes: Vec<Value> =
                changes.iter().map(|(p, c)| json!({ "uri": uri::path_to_uri(p), "type": *c as u8 })).collect();
            if let Err(e) = run.peer.notify("workspace/didChangeWatchedFiles", json!({ "changes": changes })) {
                tracing::debug!("{}: didChangeWatchedFiles: {e}", s.name);
            }
        }
    }

    /// Called with the folders outside the project that servers registered file watchers
    /// for (a virtualenv elsewhere, a path dependency), whenever they change. Changes
    /// below them go to [`Self::watched_files_changed`].
    pub fn set_file_watch_roots_hook(&self, hook: Box<WatchRootsFn>) {
        *self.watch_roots_hook.write() = Some(Arc::from(hook));
        self.file_watch_roots_changed();
    }

    pub(crate) fn file_watch_roots_changed(&self) {
        let Some(hook) = self.watch_roots_hook.read().clone() else { return };
        let servers: Vec<Arc<Server>> = self.servers.lock().clone();
        let mut roots: Vec<PathBuf> = Vec::new();
        for run in servers.iter().filter_map(|s| s.instance()) {
            roots.extend(
                run.watchers.read().bases().filter(|b| !b.starts_with(&self.project_root)).map(Path::to_path_buf),
            );
        }
        roots.sort();
        roots.dedup();
        // Sorted, so a folder's subfolders follow it.
        let mut outer: Vec<PathBuf> = Vec::new();
        for r in roots {
            if !outer.last().is_some_and(|o| r.starts_with(o)) {
                outer.push(r);
            }
        }
        hook(outer);
    }

    /// Checks initialized capabilities, including dynamic registrations, before choosing a formatter.
    pub async fn can_format(&self, doc: DocId) -> IdeResult<bool> {
        let snap = self.snapshot(doc)?;
        Ok(!self.ready_targets(&snap.servers, |c| c.has("documentFormattingProvider")).await.is_empty())
    }

    pub async fn format(&self, doc: DocId, range: Option<Range>, options: FormatOptions) -> IdeResult<Vec<TextEdit>> {
        let (method, cap, feature) = match range {
            None => ("textDocument/formatting", "documentFormattingProvider", "formatting"),
            Some(_) => ("textDocument/rangeFormatting", "documentRangeFormattingProvider", "range formatting"),
        };
        let (snap, targets) = self.doc_targets(doc, feature, |c| c.has(cap)).await?;
        let t = &targets[0];
        let mut params = json!({
            "textDocument": snap.ident(),
            "options": { "tabSize": options.tab_size, "insertSpaces": options.insert_spaces },
        });
        if let Some(r) = range {
            params["range"] = json!(snap.range(t, r));
        }
        let edits: Option<Vec<lsp::TextEdit>> = self.call(t, method, params, None, DEFAULT_TIMEOUT).await?;
        Ok(self.conv(t.enc()).text_edits(&snap.path, edits.unwrap_or_default()))
    }

    pub async fn inlay_hints(&self, doc: DocId, range: Range) -> IdeResult<Vec<InlayHint>> {
        let (snap, targets) = self.doc_targets(doc, "inlay hints", |c| c.has("inlayHintProvider")).await?;
        let angular = angular::serves_inlay_hints(snap.language.as_str(), snap.text.as_str());
        let requests = targets.iter().filter(|t| angular || t.server.name != angular::SERVER).map(|t| {
            let params = json!({ "textDocument": snap.ident(), "range": snap.range(t, range) });
            async move {
                (
                    t,
                    self.call::<_, Option<Vec<lsp::InlayHint>>>(
                        t,
                        "textDocument/inlayHint",
                        params,
                        None,
                        DEFAULT_TIMEOUT,
                    )
                    .await,
                )
            }
        });
        let mut out = Outcome::new();
        for (t, r) in join_all(requests).await {
            match r {
                Ok(hints) => {
                    let conv = self.conv(t.enc());
                    let acc = out.value.get_or_insert_with(Vec::new);
                    acc.extend(
                        hints.unwrap_or_default().into_iter().map(|h| convert::inlay_hint(&conv, &snap.path, h)),
                    );
                }
                Err(e) => out.fail(e),
            }
        }
        let mut v = out.finish(Vec::new())?;
        v.sort_by_key(|h| h.position);
        Ok(v)
    }

    pub async fn semantic_tokens(&self, doc: DocId) -> IdeResult<Option<SemanticTokens>> {
        let snap = self.snapshot(doc)?;
        let targets =
            self.ready_targets(&snap.servers, |c| c.semantic_tokens_full() && c.semantic_legend.is_some()).await;
        let Some(t) = targets.first() else { return Ok(None) };
        let params = json!({ "textDocument": snap.ident() });
        let r: Option<Value> = self.call(t, "textDocument/semanticTokens/full", params, None, DEFAULT_TIMEOUT).await?;
        let Some(data) = r.as_ref().and_then(|v| v.get("data")).and_then(Value::as_array) else { return Ok(None) };
        let data: Vec<u32> = data.iter().map(|n| n.as_u64().unwrap_or(0) as u32).collect();
        let (enc, legend) = {
            let caps = t.caps();
            (caps.encoding, caps.semantic_legend.clone().unwrap_or_default())
        };
        let text = (enc != Encoding::Utf16).then(|| self.text_for_path(&snap.path).unwrap_or(snap.text.clone()));
        Ok(Some(SemanticTokens {
            data: convert::decode_semantic_tokens(&data, enc, text.as_deref()),
            token_types: legend.0,
            token_modifiers: legend.1,
        }))
    }

    pub async fn code_lens(&self, doc: DocId) -> IdeResult<Vec<CodeLens>> {
        let (snap, targets) = self.doc_targets(doc, "code lens", |c| c.has("codeLensProvider")).await?;
        let requests = targets.iter().map(|t| {
            let params = json!({ "textDocument": snap.ident() });
            async move {
                let lenses = self
                    .call::<_, Option<Vec<lsp::CodeLens>>>(t, "textDocument/codeLens", params, None, DEFAULT_TIMEOUT)
                    .await?;
                let lenses = lenses.unwrap_or_default();
                if !t.caps().has_sub("codeLensProvider", "resolveProvider") {
                    return Ok::<_, IdeError>((t, lenses));
                }
                let resolved = join_all(lenses.into_iter().map(|l| async move {
                    if l.command.is_some() {
                        return l;
                    }
                    let original = l.clone();
                    self.call::<_, lsp::CodeLens>(t, "codeLens/resolve", l, None, DEFAULT_TIMEOUT)
                        .await
                        .unwrap_or(original)
                }))
                .await;
                Ok((t, resolved))
            }
        });
        let mut out = Outcome::new();
        for r in join_all(requests).await {
            match r {
                Ok((t, lenses)) => {
                    let conv = self.conv(t.enc());
                    let acc = out.value.get_or_insert_with(Vec::new);
                    acc.extend(lenses.into_iter().map(|l| convert::code_lens(&conv, &snap.path, l)));
                }
                Err(e) => out.fail(e),
            }
        }
        out.finish(Vec::new())
    }

    /// The document's links; ones without a target are resolved when the server can.
    pub async fn document_links(&self, doc: DocId) -> IdeResult<Vec<DocumentLink>> {
        let (snap, targets) = self.doc_targets(doc, "document links", |c| c.has("documentLinkProvider")).await?;
        let requests = targets.iter().map(|t| {
            let params = json!({ "textDocument": snap.ident() });
            async move {
                let links = self
                    .call::<_, Option<Vec<lsp::DocumentLink>>>(
                        t,
                        "textDocument/documentLink",
                        params,
                        None,
                        DEFAULT_TIMEOUT,
                    )
                    .await?
                    .unwrap_or_default();
                if !t.caps().has_sub("documentLinkProvider", "resolveProvider") {
                    return Ok::<_, IdeError>((t, links));
                }
                let resolved = join_all(links.into_iter().map(|l| async move {
                    if l.target.is_some() {
                        return l;
                    }
                    let original = l.clone();
                    self.call::<_, lsp::DocumentLink>(t, "documentLink/resolve", l, None, DEFAULT_TIMEOUT)
                        .await
                        .unwrap_or(original)
                }))
                .await;
                Ok((t, resolved))
            }
        });
        let mut out = Outcome::new();
        for r in join_all(requests).await {
            match r {
                Ok((t, links)) => {
                    let conv = self.conv(t.enc());
                    let acc = out.value.get_or_insert_with(Vec::new);
                    acc.extend(links.into_iter().filter_map(|l| convert::document_link(&conv, &snap.path, l)));
                }
                Err(e) => out.fail(e),
            }
        }
        out.finish(Vec::new())
    }

    pub async fn call_hierarchy(
        &self,
        doc: DocId,
        pos: Pos,
        direction: HierarchyDirection,
        cancel: CancellationToken,
    ) -> IdeResult<CallHierarchy> {
        let (snap, targets) = self.doc_targets(doc, "call hierarchy", |c| c.has("callHierarchyProvider")).await?;
        let t = &targets[0];
        let cancel = &cancel;
        let items: Option<Vec<lsp::CallHierarchyItem>> = self
            .call(t, "textDocument/prepareCallHierarchy", snap.pos_params(t, pos), Some(cancel), DEFAULT_TIMEOUT)
            .await?;
        let items = items.filter(|i| !i.is_empty()).ok_or_else(no_hierarchy_target)?;
        let query = || async {
            let mut out = Vec::new();
            for item in &items {
                let params = json!({ "item": item });
                match direction {
                    HierarchyDirection::Incoming => {
                        let calls: Option<Vec<lsp::CallHierarchyIncomingCall>> =
                            self.call(t, "callHierarchy/incomingCalls", params, Some(cancel), LONG_TIMEOUT).await?;
                        let conv = self.conv(t.enc());
                        for c in calls.unwrap_or_default() {
                            let (path, _) = uri_target(c.from.uri.as_str());
                            let ranges = c.from_ranges.iter().map(|r| conv.range(&path, *r)).collect();
                            out.extend(convert::call_item(&conv, &c.from, ranges));
                        }
                    }
                    HierarchyDirection::Outgoing => {
                        let calls: Option<Vec<lsp::CallHierarchyOutgoingCall>> =
                            self.call(t, "callHierarchy/outgoingCalls", params, Some(cancel), LONG_TIMEOUT).await?;
                        let conv = self.conv(t.enc());
                        let (src, _) = uri_target(item.uri.as_str());
                        for c in calls.unwrap_or_default() {
                            let ranges = c.from_ranges.iter().map(|r| conv.range(&src, *r)).collect();
                            out.extend(convert::call_item(&conv, &c.to, ranges));
                        }
                    }
                }
            }
            Ok(out)
        };
        let (out, incomplete) = match direction {
            // Callers are references: they may sit in files outside the server's scope.
            HierarchyDirection::Incoming => {
                let files = |v: &Vec<HierarchyItem>| {
                    v.iter().filter(|i| i.uri.is_none()).map(|i| i.path.to_path_buf()).collect()
                };
                let w = self.widened(&snap, t, pos, cancel, query, files).await?;
                (w.second.unwrap_or(w.first), w.incomplete)
            }
            HierarchyDirection::Outgoing => (query().await?, None),
        };
        let mut out = out;
        if direction == HierarchyDirection::Incoming {
            for caller in self.go_mentions_beyond_search(&snap, t, pos, cancel, true).await.callers {
                match out.iter_mut().find(|i| i.path == caller.path && i.range == caller.range) {
                    Some(item) => item.from_ranges.extend(caller.from_ranges),
                    None => out.push(caller),
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        self.note_virtual(&t.server, out.iter().map(|i| i.uri.as_deref()));
        Ok(CallHierarchy { items: out, incomplete })
    }

    pub async fn type_hierarchy(
        &self,
        doc: DocId,
        pos: Pos,
        direction: HierarchyDirection,
    ) -> IdeResult<Vec<HierarchyItem>> {
        let (snap, targets) = self.doc_targets(doc, "type hierarchy", |c| c.has("typeHierarchyProvider")).await?;
        let t = &targets[0];
        // Items stay raw JSON: they go back to the server as they came (`data`),
        // and lsp-types mistypes `tags` (jdtls sends an array).
        let items: Option<Vec<serde_json::Value>> =
            self.call(t, "textDocument/prepareTypeHierarchy", snap.pos_params(t, pos), None, DEFAULT_TIMEOUT).await?;
        let items = items.filter(|i| !i.is_empty()).ok_or_else(no_hierarchy_target)?;
        let method = match direction {
            HierarchyDirection::Incoming => "typeHierarchy/supertypes",
            HierarchyDirection::Outgoing => "typeHierarchy/subtypes",
        };
        let mut out = Vec::new();
        for item in items {
            let related: Option<Vec<serde_json::Value>> =
                self.call(t, method, json!({ "item": item }), None, LONG_TIMEOUT).await?;
            let conv = self.conv(t.enc());
            out.extend(
                related
                    .unwrap_or_default()
                    .iter()
                    .filter_map(convert::type_item_from_json)
                    .filter_map(|i| convert::type_item(&conv, &i)),
            );
        }
        self.note_virtual(&t.server, out.iter().map(|i| i.uri.as_deref()));
        Ok(out)
    }

    // ---- virtual documents ----

    /// Remembers which server returned virtual URIs, so their contents and
    /// requests inside them go back to it.
    fn note_virtual<'u>(&self, server: &Arc<Server>, uris: impl Iterator<Item = Option<&'u str>>) {
        let mut origins = None;
        for uri in uris.flatten() {
            origins.get_or_insert_with(|| self.virtual_origins.lock()).insert(uri.to_owned(), server.id);
        }
    }

    fn origin_server(&self, uri: &str) -> Option<Arc<Server>> {
        let id = *self.virtual_origins.lock().get(uri)?;
        self.servers.lock().iter().find(|s| s.id == id).cloned()
    }

    /// The binary archive behind a library document, never its displayed tab title.
    pub fn library_archive(uri: &str) -> Option<PathBuf> {
        if virtual_doc::scheme(uri) == "jar" {
            return library_source::parse(uri).map(|e| e.jar);
        }
        virtual_doc::description(uri).filter(|p| p.ends_with(".jar") && Path::new(p).is_absolute()).map(PathBuf::from)
    }

    /// Open an attached archive at the declaration under the decompiled editor's caret.
    pub async fn library_source_location(
        &self,
        uri: &str,
        sources: PathBuf,
        pos: Pos,
        cancel: &CancellationToken,
    ) -> IdeResult<Option<Location>> {
        let previous = tokio::select! {
            result = self.virtual_document(uri) => result?,
            _ = cancel.cancelled() => return Err(IdeError::cancelled()),
        };
        let name = previous
            .text
            .lines()
            .nth(pos.line as usize)
            .and_then(|line| library_source::identifier_at(line, pos.col))
            .map(str::to_owned);
        let original = uri.to_owned();
        let archive = sources.clone();
        let found = tokio::task::spawn_blocking(move || {
            library_source::source_in_archive(&original, &archive, None).map(|(uri, loaded)| {
                let range =
                    name.as_deref().map(|n| library_source::declaration_range(&loaded.text, n)).unwrap_or_default();
                Location { path: uri.clone().into(), uri: Some(uri), range }
            })
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if found.is_some() {
            if virtual_doc::scheme(uri) == "jdt" {
                let result = self
                    .jdtls_command_cancellable(
                        &self.project_root,
                        "java.project.updateSourceAttachment",
                        vec![json!({ "classFileUri": uri, "attributes": { "sourceAttachmentPath": sources } })],
                        cancel,
                    )
                    .await?;
                if let Some(error) = result.get("errorMessage").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    return Err(IdeError::unavailable(error));
                }
            }
            self.virtual_docs.lock().remove(uri);
        }
        Ok(found)
    }

    /// Contents of a virtual document, from the server that owns `uri`:
    /// `workspace/textDocumentContent` (LSP 3.18) when the server serves the
    /// scheme, jdtls' `java/classFileContents` for `jdt:` URIs. A `jar:` entry
    /// is read from its archive, a `jar:` class shown as its library source
    /// (see [`library_source`]) or else decompiled by the server. Cached.
    pub async fn virtual_document(&self, uri: &str) -> IdeResult<VirtualDocument> {
        if let Some(d) = self.virtual_docs.lock().get(uri) {
            return Ok(d.clone());
        }
        let scheme = virtual_doc::scheme(uri).to_owned();
        let jar_class = scheme == "jar" && library_source::parse(uri).is_some_and(|e| e.entry.ends_with(".class"));
        if scheme == "jar" {
            let found = {
                let uri = uri.to_owned();
                tokio::task::spawn_blocking(move || read_jar_source(&uri, None)).await.ok().flatten()
            };
            if let Some((entry, loaded)) = found {
                return Ok(self.store_jar_entry(uri, entry, loaded));
            }
        }
        let class_file = scheme == "jdt" || (scheme == "file" && uri.ends_with(".class"));
        let origin = self.origin_server(uri);
        let mut servers: Vec<Arc<Server>> = origin.iter().cloned().collect();
        servers.extend(self.servers.lock().iter().filter(|s| Some(s.id) != origin.as_ref().map(|o| o.id)).cloned());
        let targets = self.ready_targets(&servers, |_| true).await;
        let mut error = None;
        for t in &targets {
            let languages = t.server.languages();
            let mut description = None;
            let serves_scheme = t.caps().content_schemes().contains(&scheme);
            let result: IdeResult<Option<String>> = if serves_scheme && !class_file {
                self.call::<_, Option<Value>>(
                    t,
                    "workspace/textDocumentContent",
                    json!({ "uri": uri }),
                    None,
                    LONG_TIMEOUT,
                )
                .await
                .map(|v| v.and_then(|v| v.get("text").and_then(Value::as_str).map(str::to_owned)))
            } else if class_file && languages.iter().any(|l| l.as_str() == "java") {
                self.call::<_, Option<String>>(t, "java/classFileContents", json!({ "uri": uri }), None, LONG_TIMEOUT)
                    .await
            } else if scheme == "csharp" && t.server.name == "csharp-ls" {
                self.call::<_, Option<virtual_doc::CSharpMetadata>>(
                    t,
                    "csharp/metadata",
                    json!({ "textDocument": { "uri": uri } }),
                    None,
                    LONG_TIMEOUT,
                )
                .await
                .map(|metadata| {
                    metadata.map(|m| {
                        description = m.assembly_name.filter(|name| !name.is_empty());
                        m.source
                    })
                })
            } else if jar_class && t.caps().commands().iter().any(|c| c == "decompile") {
                // The official Kotlin LSP: `decompile` answers `{ code, language }`.
                self.call::<_, Option<Value>>(
                    t,
                    "workspace/executeCommand",
                    json!({ "command": "decompile", "arguments": [uri] }),
                    None,
                    LONG_TIMEOUT,
                )
                .await
                .map(|v| {
                    v.and_then(|v| match v {
                        Value::String(text) => Some(text),
                        v => ["code", "text", "content"]
                            .iter()
                            .find_map(|k| v.get(k).and_then(Value::as_str))
                            .map(str::to_owned),
                    })
                })
            } else {
                continue;
            };
            let text = match result {
                Ok(Some(text)) if !text.is_empty() => text,
                Ok(_) => continue,
                Err(e) => {
                    error.get_or_insert(e);
                    continue;
                }
            };
            // jdtls decodes attached sources itself: its attachment encoding is
            // the document's real charset, and editable ones can be re-decoded.
            let decoding = if scheme == "jdt" && t.server.name == jdtls::SERVER && !virtual_doc::is_decompiled(&text) {
                match self.jdt_source_attachment(uri).await {
                    Some(att) if att.path.is_some() => Decoding {
                        encoding: att.encoding.unwrap_or_else(|| "utf-8".into()),
                        has_bom: false,
                        can_reload: att.can_edit_encoding,
                    },
                    _ => Decoding::server_text(),
                }
            } else {
                Decoding::server_text()
            };
            return Ok(self.store_virtual(uri, text, None, description, &languages, Some(t.server.id), decoding));
        }
        if jar_class && error.is_none() {
            return Err(IdeError::not_found(format!(
                "no source or decompiler is available for {}: its sources jar is not in the local Maven or Gradle cache, and no language server decompiles it",
                virtual_doc::title(uri, false)
            )));
        }
        Err(error.unwrap_or_else(|| IdeError::not_found(format!("no language server provides the contents of {uri}"))))
    }

    /// Caches `text` as the virtual document `uri`, titled `title` (else after the URI).
    #[allow(clippy::too_many_arguments)]
    fn store_virtual(
        &self,
        uri: &str,
        text: String,
        title: Option<String>,
        description: Option<String>,
        languages: &[LanguageId],
        server: Option<ide_core::ServerId>,
        decoding: Decoding,
    ) -> VirtualDocument {
        let decompiled = if virtual_doc::scheme(uri) == "csharp" {
            virtual_doc::is_csharp_decompiled(uri)
        } else {
            virtual_doc::is_decompiled(&text)
        };
        let title = title.unwrap_or_else(|| virtual_doc::title(uri, decompiled));
        let detected = self.languages.detect(Path::new(&title), None);
        let language_id = if detected == LanguageId::plain_text() {
            languages.first().cloned().unwrap_or(detected)
        } else {
            detected
        };
        let doc = VirtualDocument {
            uri: uri.to_owned(),
            text,
            language_id,
            title,
            description: description.or_else(|| virtual_doc::description(uri)),
            decompiled,
            encoding: decoding.encoding,
            has_bom: decoding.has_bom,
            can_reload_encoding: decoding.can_reload,
        };
        if let Some(server) = server {
            self.virtual_origins.lock().entry(uri.to_owned()).or_insert(server);
        }
        let mut cache = self.virtual_docs.lock();
        if cache.len() >= VIRTUAL_CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(uri.to_owned(), doc.clone());
        doc
    }

    /// Caches a decoded `jar:` entry under the document's original URI, titled
    /// after the entry; the backend owns these bytes, so they can be re-decoded.
    fn store_jar_entry(&self, uri: &str, entry: String, loaded: ide_vfs::LoadedText) -> VirtualDocument {
        let title = entry.rsplit('/').next().unwrap_or(&entry).to_owned();
        self.store_virtual(
            uri,
            loaded.text,
            Some(title),
            None,
            &[],
            self.origin_server(uri).map(|s| s.id),
            Decoding { encoding: loaded.encoding, has_bom: loaded.has_bom, can_reload: true },
        )
    }

    /// The source attachment jdtls resolves for a `jdt:` class; `None` when the
    /// command is unavailable or the class's container cannot be queried.
    async fn jdt_source_attachment(&self, uri: &str) -> Option<SourceAttachment> {
        let result = self
            .jdtls_command(
                &self.project_root,
                "java.project.resolveSourceAttachment",
                vec![json!({ "classFileUri": uri })],
            )
            .await
            .ok()?;
        if result.get("errorMessage").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
            return None;
        }
        let attrs = result.get("attributes")?;
        let non_empty = |key: &str| attrs.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        Some(SourceAttachment {
            path: non_empty("sourceAttachmentPath"),
            encoding: non_empty("sourceAttachmentEncoding"),
            can_edit_encoding: attrs.get("canEditEncoding").and_then(Value::as_bool).unwrap_or(true),
        })
    }

    /// Updates a `jdt:` class's source attachment encoding. The command drops
    /// the attachment when the path is omitted, so the resolved path is always
    /// sent along with the encoding.
    async fn update_jdt_source_encoding(&self, uri: &str, path: &str, encoding: &str) -> IdeResult<()> {
        let result = self
            .jdtls_command(
                &self.project_root,
                "java.project.updateSourceAttachment",
                vec![json!({
                    "classFileUri": uri,
                    "attributes": { "sourceAttachmentPath": path, "sourceAttachmentEncoding": encoding },
                })],
            )
            .await?;
        if let Some(error) = result.get("errorMessage").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return Err(IdeError::unavailable(error));
        }
        Ok(())
    }

    /// Waits until the resolved attachment reports `encoding`; `false` once
    /// `until` passes. Maven applies attachment updates in a background job,
    /// so the new encoding is not visible immediately after the update.
    async fn wait_for_jdt_source_encoding(&self, uri: &str, encoding: &str, until: tokio::time::Instant) -> bool {
        loop {
            match self.jdt_source_attachment(uri).await {
                Some(att) if att.encoding.as_deref() == Some(encoding) => return true,
                _ if tokio::time::Instant::now() < until => {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                }
                _ => return false,
            }
        }
    }

    /// "Reload with Encoding" for a virtual document: re-reads its origin with
    /// `encoding` and replaces the cached content. `jar:` entries are re-read
    /// here; `jdt:` sources are decoded by jdtls, so its source attachment
    /// encoding is updated and the contents fetched again (keeping the server's
    /// text and positions in sync). Server-generated content cannot be re-decoded.
    pub async fn reload_virtual(&self, uri: &str, encoding: &str) -> IdeResult<VirtualDocument> {
        ide_vfs::encode("", encoding, false)?;
        match virtual_doc::scheme(uri) {
            "jar" => {
                let (owned_uri, owned_encoding) = (uri.to_owned(), encoding.to_owned());
                let found = tokio::task::spawn_blocking(move || read_jar_source(&owned_uri, Some(&owned_encoding)))
                    .await
                    .map_err(|e| IdeError::internal(e.to_string()))?;
                let Some((entry, loaded)) = found else {
                    return Err(IdeError::not_found(format!(
                        "no source is available for {}",
                        virtual_doc::title(uri, false)
                    )));
                };
                Ok(self.store_jar_entry(uri, entry, loaded))
            }
            "jdt" if self.origin_server(uri).is_none_or(|s| s.name == jdtls::SERVER) => {
                let Some(att) = self.jdt_source_attachment(uri).await else {
                    return Err(IdeError::unavailable("jdtls cannot resolve the source attachment of this class"));
                };
                let Some(path) = att.path else {
                    return Err(IdeError::invalid("this class has no attached sources to re-decode"));
                };
                if !att.can_edit_encoding {
                    return Err(IdeError::invalid("the source attachment encoding of this library cannot be changed"));
                }
                self.update_jdt_source_encoding(uri, &path, encoding).await?;
                // Maven containers apply the update in a background job (persist
                // attached sources, then refresh the classpath): wait until the
                // resolved attachment reports the new encoding, else the refetch
                // below would still decode with the old one.
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
                let first_try = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
                if !self.wait_for_jdt_source_encoding(uri, encoding, first_try).await {
                    // jdtls matches the existing encoding attribute by reference
                    // (`==`), so an entry restored from the saved container state
                    // gains a duplicate attribute and keeps the old value. That
                    // update still refreshes the container, after which a second
                    // update replaces the value correctly.
                    self.update_jdt_source_encoding(uri, &path, encoding).await?;
                    if !self.wait_for_jdt_source_encoding(uri, encoding, deadline).await {
                        return Err(IdeError::unavailable(
                            "jdtls did not apply the source attachment encoding; try reloading again",
                        ));
                    }
                }
                // JDT keeps the class file's decoded buffer cached, so
                // classFileContents would still return the old decoding: re-read
                // the attached source entry here, like `jar:` documents. The
                // server's open document is kept in sync by the regular
                // document change flow.
                let (owned_uri, owned_path, owned_encoding) = (uri.to_owned(), path.clone(), encoding.to_owned());
                let found = tokio::task::spawn_blocking(move || {
                    library_source::source_in_archive(&owned_uri, Path::new(&owned_path), Some(&owned_encoding))
                })
                .await
                .map_err(|e| IdeError::internal(e.to_string()))?;
                if let Some((_source_uri, loaded)) = found {
                    return Ok(self.store_virtual(
                        uri,
                        loaded.text,
                        None,
                        None,
                        &[],
                        self.origin_server(uri).map(|s| s.id),
                        Decoding { encoding: loaded.encoding, has_bom: loaded.has_bom, can_reload: true },
                    ));
                }
                // Attachments that are not readable archives (e.g. folders):
                // fall back to the server's contents.
                self.virtual_docs.lock().remove(uri);
                self.virtual_document(uri).await
            }
            _ => Err(IdeError::invalid(
                "this document's content is generated by a language server and cannot be re-decoded with another encoding",
            )),
        }
    }

    /// Called when a server sends `workspace/applyEdit`; installed by `src-tauri`
    /// so edits flow through `ide-workspace::Documents`.
    pub fn set_config_hook(&self, hook: Box<ConfigFn>) {
        *self.config_hook.write() = Some(Arc::from(hook));
    }

    pub fn set_prepare_hook(&self, hook: Box<PrepareFn>) {
        *self.prepare_hook.write() = Some(Arc::from(hook));
    }

    /// Installed by `src-tauri` to apply the servers enabled / defined in settings.
    pub fn set_servers_hook(&self, hook: Box<ServersFn>) {
        *self.servers_hook.write() = Some(Arc::from(hook));
    }

    /// The server's base configuration with the settings hook applied.
    fn configured(&self, server: &Server) -> LanguageServerConfig {
        let mut cfg = server.config.clone();
        if !self.execution_allowed.load(Ordering::Acquire) {
            cfg.launch_error = Some("Project is in Restricted Mode".into());
            return cfg;
        }
        if let Some(hook) = self.config_hook.read().clone() {
            hook(&mut cfg, &server.root);
        }
        if cfg.name == compose::SERVER {
            compose::configure_yaml_compose_schemas(&mut cfg, &self.open_compose_files());
        }
        cfg
    }

    fn open_compose_files(&self) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> =
            self.docs.lock().values().filter(|d| d.compose_detected).map(|d| d.path.clone()).collect();
        files.sort();
        files.dedup();
        files
    }

    /// Restarts running servers whose settings-derived configuration changed
    /// (e.g. a new project interpreter); stopped ones pick it up on their next start.
    /// A change of `settings` alone reaches a running server without a restart.
    /// Servers no longer enabled stop; newly enabled ones attach to open documents.
    pub fn set_execution_allowed(&self, allowed: bool) {
        let previous = self.execution_allowed.swap(allowed, Ordering::AcqRel);
        if !allowed {
            for server in self.servers.lock().iter() {
                server.start_token().cancel();
            }
        }
        if allowed && !previous {
            let servers = self.servers.lock().clone();
            for server in &servers {
                server.reset_for_restart();
                self.ensure_started(server);
            }
        }
        if allowed != previous {
            self.injection_providers_changed();
        }
    }

    /// [`Self::reconfigure`] on the manager's runtime, for callers outside one (file watchers).
    pub fn reconfigure_soon(self: &Arc<Self>) {
        let me = self.clone();
        self.runtime.spawn(async move { me.reconfigure().await });
    }

    pub async fn reconfigure(&self) {
        let _reconfigure = self.reconfigure_lock.lock().await;
        if !self.execution_allowed.load(Ordering::Acquire) {
            let servers = self.servers.lock().clone();
            join_all(servers.iter().map(|s| self.stop_instance(s, true))).await;
            return;
        }
        let existing: Vec<ide_core::ServerId> = self.servers.lock().iter().map(|s| s.id).collect();
        self.reconfigure_jdtls_workspace().await;
        self.stop_unlisted().await;
        let Some(me) = self.me.upgrade() else { return };
        let servers: Vec<Arc<Server>> = self.servers.lock().clone();
        for s in servers {
            // Created in this pass (the jdtls of a new workspace layout): it starts with the
            // current configuration, though it may not have recorded it yet.
            if !existing.contains(&s.id) {
                continue;
            }
            // The settings hook may run tools (`npm root -g`), as when the server starts.
            let next = match tokio::task::spawn_blocking({
                let (me, s) = (me.clone(), s.clone());
                move || me.configured(&s)
            })
            .await
            {
                Ok(next) => next,
                Err(e) => {
                    tracing::warn!("{}: settings hook failed: {e}", s.name);
                    continue;
                }
            };
            let current = s.effective_config();
            if next == current {
                continue;
            }
            let without_settings = |c: &LanguageServerConfig| LanguageServerConfig { settings: None, ..c.clone() };
            if let Some(run) = s.running()
                && without_settings(&next) == without_settings(&current)
                && !jdtls::source_paths_removed(&current, &next)
            {
                s.set_effective_config(run.generation, next);
                let params = json!({ "settings": handler::all_settings(&s.effective_config()) });
                if let Err(e) = run.peer.notify("workspace/didChangeConfiguration", params) {
                    tracing::debug!("{}: didChangeConfiguration: {e}", s.name);
                }
                continue;
            }
            match s.status() {
                ide_core::event::ServerStatus::Ready
                | ide_core::event::ServerStatus::Busy
                | ide_core::event::ServerStatus::Starting => {
                    tracing::info!("{}: configuration changed, restarting", s.name);
                    self.stop_instance(&s, false).await;
                    s.reset_for_restart();
                    self.ensure_started(&s);
                }
                // Missing / crashed / misconfigured servers retry with the new configuration (e.g. a new PATH).
                ide_core::event::ServerStatus::Missing
                | ide_core::event::ServerStatus::Crashed
                | ide_core::event::ServerStatus::Misconfigured => {
                    s.reset_for_restart();
                    self.ensure_started(&s);
                }
                ide_core::event::ServerStatus::Stopped => {}
            }
        }
        self.attach_fallbacks();
        self.detach_shadowed_fallbacks().await;
        self.injection_providers_changed();
    }

    async fn reconfigure_jdtls_workspace(&self) {
        let (shared, roots) = self.desired_jdtls_workspace();
        let retired = {
            // Opens attach atomically with root selection; no document can acquire an old
            // instance between removing the registry entries and detaching its documents.
            let _gate = self.injections.gate.lock();
            let mut state = self.jdtls_workspace_state();
            if state.shared == shared && (!shared || state.roots == roots) {
                return;
            }
            state.transitioning = true;
            state.shared = shared;
            state.roots = roots;
            let mut servers = self.servers.lock();
            let retired: Vec<_> = servers.iter().filter(|s| is_local_jdtls(&s.config)).cloned().collect();
            servers.retain(|s| !is_local_jdtls(&s.config));
            for doc in self.docs.lock().values_mut() {
                doc.servers.retain(|a| !is_local_jdtls(&a.server.config));
            }
            retired
        };
        for server in &retired {
            self.stop_instance(server, true).await;
        }
        self.forget(&retired);
        self.jdtls_workspace.lock().transitioning = false;
        self.attach_fallbacks();
        let pending: Vec<_> = self.servers.lock().iter().filter(|s| is_local_jdtls(&s.config)).cloned().collect();
        for server in pending {
            self.ensure_started(&server);
        }
    }

    /// A server enabled again shadows the fallbacks attached in its place: they
    /// leave the open documents, and stop once no document uses them.
    async fn detach_shadowed_fallbacks(&self) {
        let open: Vec<(DocId, LanguageId, PathBuf)> =
            self.docs.lock().iter().map(|(id, d)| (*id, d.language.clone(), d.path.clone())).collect();
        let mut shadowed: Vec<(DocId, Vec<ide_core::ServerId>)> = Vec::new();
        for (id, language, path) in open {
            let configs = self.language_servers(&language);
            let wanted = self.servers_for(&language, &path);
            let docs = self.docs.lock();
            let Some(d) = docs.get(&id) else { continue };
            let gone: Vec<ide_core::ServerId> = d
                .servers
                .iter()
                .filter(|a| {
                    !wanted.iter().any(|w| w.id == a.server.id)
                        && (configs.iter().any(|c| c.fallback && c.name == a.server.name)
                            || (a.server.name == "clangd" && wanted.iter().any(|s| s.name == arduino::SERVER)))
                })
                .map(|a| a.server.id)
                .collect();
            if !gone.is_empty() {
                shadowed.push((id, gone));
            }
        }
        if shadowed.is_empty() {
            return;
        }
        let mut detached: Vec<Arc<Server>> = Vec::new();
        {
            let mut docs = self.docs.lock();
            for (id, gone) in shadowed {
                let Some(d) = docs.get_mut(&id) else { continue };
                let (leaving, staying): (Vec<Attached>, Vec<Attached>) =
                    d.servers.drain(..).partition(|a| gone.contains(&a.server.id));
                d.servers = staying;
                for a in leaving {
                    if let Some(run) = a.server.running()
                        && a.opened_gen == Some(run.generation)
                        && run.caps.read().open_close
                        && let Err(e) =
                            run.peer.notify("textDocument/didClose", json!({ "textDocument": { "uri": d.uri } }))
                    {
                        tracing::debug!("{}: didClose: {e}", a.server.name);
                    }
                    self.sink.emit(ide_core::IdeEvent::Diagnostics {
                        path: d.path.clone().into(),
                        source: a.server.name.clone(),
                        items: Vec::new(),
                    });
                    if !detached.iter().any(|s| s.id == a.server.id) {
                        detached.push(a.server);
                    }
                }
            }
            let in_use = |s: &Arc<Server>| docs.values().any(|d| d.servers.iter().any(|a| a.server.id == s.id));
            detached.retain(|s| !in_use(s));
        }
        if detached.is_empty() {
            return;
        }
        for s in &detached {
            tracing::info!("{}: shadowed by an enabled server, stopping", s.name);
            self.stop_instance(s, true).await;
        }
        self.forget(&detached);
    }

    /// Stops and forgets the servers that none of their languages uses any more.
    async fn stop_unlisted(&self) {
        let servers: Vec<Arc<Server>> = self.servers.lock().clone();
        let unlisted: Vec<Arc<Server>> = servers
            .into_iter()
            .filter(|s| !s.languages().iter().any(|l| self.language_servers(l).iter().any(|c| c.name == s.name)))
            .collect();
        if unlisted.is_empty() {
            return;
        }
        for s in &unlisted {
            tracing::info!("{}: no longer enabled, stopping", s.name);
            self.stop_instance(s, true).await;
        }
        let gone = |s: &Arc<Server>| unlisted.iter().any(|u| u.id == s.id);
        for d in self.docs.lock().values_mut() {
            d.servers.retain(|a| !gone(&a.server));
        }
        self.forget(&unlisted);
    }

    /// Drops stopped servers from the list and tells the UI they are gone.
    fn forget(&self, gone: &[Arc<Server>]) {
        self.servers.lock().retain(|s| !gone.iter().any(|g| g.id == s.id));
        for s in gone {
            self.sink.emit(ide_core::IdeEvent::LanguageServerRemoved { server: s.id });
        }
    }

    pub fn set_apply_edit_hook(&self, hook: Box<dyn Fn(WorkspaceEdit) -> bool + Send + Sync>) {
        *self.apply_edit_hook.write() = Some(Arc::from(hook));
    }

    /// Emits every server's current diagnostics again: a UI that (re)loaded
    /// after they were published has missed those events.
    pub fn resend_diagnostics(&self) {
        let servers: Vec<Arc<Server>> = self.servers.lock().clone();
        for server in servers {
            let encoding = server.running().map(|r| r.caps.read().encoding).unwrap_or_default();
            for (path, items) in server.diagnostics_by_path() {
                self.emit_diagnostics(&server, path, items, encoding);
            }
        }
    }

    pub fn servers(&self) -> Vec<ServerInfo> {
        self.servers
            .lock()
            .iter()
            .map(|s| ServerInfo {
                id: s.id,
                name: s.name.clone(),
                root: s.root.clone().into(),
                languages: s.languages(),
                status: s.status(),
                pid: s.running().and_then(|r| r.peer.pid()),
            })
            .collect()
    }

    pub async fn restart(&self, server: ide_core::ServerId) -> IdeResult<()> {
        let _reconfigure = self.reconfigure_lock.lock().await;
        let s = self
            .servers
            .lock()
            .iter()
            .find(|s| s.id == server)
            .cloned()
            .ok_or_else(|| IdeError::not_found(format!("unknown language server {server}")))?;
        if !s.root.is_dir() {
            return Err(IdeError::unavailable(format!(
                "the workspace root of {} is gone: {}",
                s.name,
                s.root.display()
            )));
        }
        self.stop_instance(&s, false).await;
        s.reset_for_restart();
        self.ensure_started(&s);
        match s.wait_ready(Duration::from_secs(60)).await {
            Some(_) => Ok(()),
            None => {
                Err(IdeError::unavailable(s.status_message().unwrap_or_else(|| format!("{} failed to start", s.name))))
            }
        }
    }

    /// Gracefully stops the current instance (`shutdown` + `exit`, then kill).
    async fn stop_instance(&self, server: &Arc<Server>, final_stop: bool) {
        let Some(run) = server.begin_stop(&self.sink, final_stop) else {
            if is_local_jdtls(&server.config) {
                let _startup = server.startup_lock.lock().await;
            }
            return;
        };
        let peer = run.peer.clone();
        // A server we connected to without starting it (an open Godot editor) is not
        // ours to shut down: only the connection closes.
        if peer.pid().is_none() && server.effective_config().connect.is_some() {
            peer.kill();
            server.end_stop(run.generation, &self.sink);
            self.file_watch_roots_changed();
            return;
        }
        let graceful = async {
            self.close_external_project(server, &run).await;
            peer.request::<_, Value>("shutdown", (), None).await.ok();
            peer.notify("exit", ()).ok();
            peer.closed().await;
        };
        if tokio::time::timeout(Duration::from_secs(3), graceful).await.is_err() {
            peer.kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), peer.closed()).await;
        }
        Self::kill_peer(server, &peer).await;
        if is_local_jdtls(&server.config) {
            let _startup = server.startup_lock.lock().await;
        }
        server.end_stop(run.generation, &self.sink);
        self.file_watch_roots_changed();
    }

    async fn kill_peer(server: &Server, peer: &ide_jsonrpc::Peer) {
        peer.kill();
        if is_local_jdtls(&server.config) && peer.pid().is_some() {
            peer.exited().await;
        }
    }

    pub async fn shutdown_all(&self) {
        self.shutting_down.store(true, Ordering::Release);
        let _reconfigure = self.reconfigure_lock.lock().await;
        let servers: Vec<Arc<Server>> = self.servers.lock().clone();
        join_all(servers.iter().map(|s| self.stop_instance(s, true))).await;
    }
}

impl Drop for LspManager {
    fn drop(&mut self) {
        for s in self.servers.get_mut().iter() {
            if let Some(run) = s.running() {
                run.peer.kill();
            }
        }
    }
}

/// Up to `limit` files below `dir` (hidden folders, `node_modules` and `target` skipped).
fn sample_files(dir: &Path, limit: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&d) else { continue };
        for entry in read.flatten() {
            if out.len() >= limit {
                return out;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => {
                    if !name.starts_with('.') && name != "node_modules" && name != "target" {
                        stack.push(entry.path());
                    }
                }
                Ok(ft) if ft.is_file() => out.push(entry.path()),
                _ => {}
            }
        }
    }
    out
}

/// Whole-file `source.*` actions (Optimize Imports, fix all) don't act on
/// diagnostics; passing them makes some servers hold back (tsserver keeps
/// unused imports while the file has errors).
fn source_actions_only(only: &[String]) -> bool {
    !only.is_empty() && only.iter().all(|k| k == "source" || k.starts_with("source."))
}

/// Preparing a call / type hierarchy found no symbol at the position: the UI
/// then retries at the enclosing declaration.
fn no_hierarchy_target() -> IdeError {
    IdeError::not_found("No symbol to show the hierarchy of at the caret")
}

#[cfg(test)]
mod send_check {
    use super::*;

    fn assert_send<T: Send>(_: T) {}

    #[allow(dead_code, unreachable_code, clippy::diverging_sub_expression)]
    fn futures_are_send(m: &LspManager) {
        let doc = DocId(1);
        assert_send(m.completion(doc, Pos::default(), None, CancellationToken::new()));
        assert_send(m.hover(doc, Pos::default(), CancellationToken::new()));
        assert_send(m.code_lens(doc));
        assert_send(m.workspace_symbols("", CancellationToken::new()));
        assert_send(m.call_hierarchy(doc, Pos::default(), HierarchyDirection::Incoming, CancellationToken::new()));
        assert_send(m.restart(ide_core::ServerId(1)));
        assert_send(m.shutdown_all());
        assert_send(m.semantic_tokens(doc));
        assert_send(m.code_actions(doc, Range::default(), vec![]));
        assert_send(m.will_rename_files(&[], CancellationToken::new()));
    }
}

#[cfg(test)]
mod code_action_tests {
    use super::source_actions_only;

    #[test]
    fn source_kinds_skip_diagnostics() {
        let kinds = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(source_actions_only(&kinds(&["source.organizeImports"])));
        assert!(source_actions_only(&kinds(&["source", "source.fixAll"])));
        assert!(!source_actions_only(&kinds(&[])));
        assert!(!source_actions_only(&kinds(&["quickfix"])));
        assert!(!source_actions_only(&kinds(&["source.organizeImports", "refactor"])));
        assert!(!source_actions_only(&kinds(&["sourcefoo"])));
    }
}
