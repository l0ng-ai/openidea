//! Wasmtime glue for the `openidea:plugin@1.0.0` world (`wit/`): one shared
//! engine, one `Store` per plugin. Everything a call may do outside the
//! sandbox goes through [`HostApi`], implemented by the host; the imports
//! themselves are in `wit_host`.

use crate::types::{
    CodeAction, CommitDraft, CommitProblem, CompletionItem, FileOperation, InlineSuggestion, LineMarker, Location,
    PluginHover, PluginInlayHint, ProviderDocument, SemanticToken,
};
use crate::types::{
    EventKind, HostError, HttpRequest, HttpResponse, Invocation, Limits, NotificationLevel, ProcessChunk,
    ProcessCommand, ProcessOutput, Prompt, RepositoryStatus, StatusItem, SyntaxFold, SyntaxSymbol, SyntaxToken,
    WorkbenchEvent,
};
use crate::types::{
    FieldValue, ServiceLog, ServiceLogToggle, ServicePane, ServiceTab, TableSort, View, ViewBody, ViewButton,
    ViewEvent, ViewField, ViewListItem, ViewTable, ViewTreeItem, Viewport,
};
use crate::wit_host::{
    bindings, commit_checks_bindings, details_bindings, endpoints_bindings, file_actions_bindings, hover_bindings,
    indexing_bindings, inlay_bindings, providers_bindings, semantic_bindings, syntax_bindings, views_bindings,
};
use ide_core::CancellationToken;
use ide_core::ipc_path::to_ipc;
use ide_extension::Capability;
use parking_lot::Mutex;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use wasmtime::component::{Component, HasSelf, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder, UpdateDeadline};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

use bindings::openidea::plugin::events as wit_events;
use bindings::openidea::plugin::types as wit_types;
use commit_checks_bindings::exports::openidea::plugin::commit_checker as wit_cc;
use details_bindings::exports::openidea::plugin::detail_provider as wit_detail;
use details_bindings::openidea::plugin::detail_types as wit_dt;
use endpoints_bindings::exports::openidea::plugin::endpoints_provider as wit_endpoints;
use file_actions_bindings::exports::openidea::plugin::file_actions as wit_fa;
use hover_bindings::exports::openidea::plugin::hover_provider as wit_hover;
use indexing_bindings::exports::openidea::plugin::document_indexer as wit_index;
use inlay_bindings::exports::openidea::plugin::inlay_hints_provider as wit_inlay;
use providers_bindings::exports::openidea::plugin::providers as wit_prov;
use semantic_bindings::exports::openidea::plugin::semantic_tokens_provider as wit_sem;
use syntax_bindings::exports::openidea::plugin::syntax_provider as wit_syntax;
use views_bindings::exports::openidea::plugin::view_provider as wit_view;
use views_bindings::openidea::plugin::view_types as wit_vt;

/// The API version of the world above, `major.minor` of [`host_api`].
pub const API_VERSION: &str = "1.3";
const EPOCH_TICK: Duration = Duration::from_millis(10);
pub(crate) const MAX_TEXT: usize = 1 << 20;
pub(crate) const MAX_TITLE: usize = 256;
const STDERR_CAPACITY: usize = 256 << 10;
/// Message of a call interrupted through [`Runtime::cancel_handle`].
pub const CANCELLED: &str = "was cancelled";

/// What plugin code may ask of the IDE, per plugin. Implemented by the host,
/// which routes notifications and status items to windows and edits to open
/// documents. Capabilities are already checked when these are called.
pub trait HostApi: Send + Sync {
    /// Shows a notification; `actions` name commands the plugin declares.
    fn notify(
        &self,
        client: Option<&str>,
        level: NotificationLevel,
        title: String,
        body: String,
        actions: Vec<crate::NotificationAction>,
    ) -> Result<(), HostError>;
    fn copy_to_clipboard(&self, client: Option<&str>, text: String) -> Result<(), HostError> {
        let _ = (client, text);
        Ok(())
    }
    fn open_url(&self, client: Option<&str>, url: String) -> Result<(), HostError> {
        let _ = (client, url);
        Ok(())
    }
    fn open_project(&self, client: Option<&str>, path: String, new_window: bool) -> Result<(), HostError> {
        let _ = (client, path, new_window);
        Err(HostError::Invalid("opening projects is unavailable".into()))
    }
    /// Shows `prompt` in `client`'s window and waits for the answer until the
    /// user gives one or `cancel` fires: the chosen keys (`QuickPick`), the
    /// text (`Input`, one element) or any value (`Confirm`: OK); `None` when
    /// dismissed.
    fn ask(
        &self,
        client: Option<&str>,
        prompt: Prompt,
        cancel: &CancellationToken,
    ) -> Result<Option<Vec<String>>, HostError> {
        let _ = (client, prompt, cancel);
        Ok(None)
    }
    /// Brings the plugin's declared view to the front in `client`'s window.
    fn reveal_view(&self, client: Option<&str>, view: &str) -> Result<(), HostError> {
        let _ = (client, view);
        Ok(())
    }
    /// Sets (`Some`) or removes the plugin's status bar item `id`.
    fn status_item(&self, id: &str, item: Option<StatusItem>);
    /// Sets (`Some`, validated JSON text) or removes the plugin's context key,
    /// for window `client` (every window if `None`).
    fn set_context(&self, client: Option<&str>, key: &str, value: Option<String>) -> Result<(), HostError> {
        let _ = (client, key, value);
        Ok(())
    }
    /// Roots of the open projects.
    fn projects(&self) -> Vec<std::path::PathBuf>;
    /// The most specific open project containing a document (including a new file).
    fn project_of(&self, path: &Path) -> Option<std::path::PathBuf> {
        if !path.is_absolute() {
            return None;
        }
        let real = crate::resolve_real(path);
        self.projects()
            .into_iter()
            .filter(|root| real.starts_with(crate::resolve_real(root)))
            .max_by_key(|root| root.components().count())
    }
    /// Unsaved text of an open editor's file.
    fn buffer_text(&self, path: &Path) -> Option<String>;
    /// Version and text of the open document at `path`.
    fn document(&self, path: &Path) -> Option<(u64, String)>;
    /// Applies edits to the open document at `path` if it is still at `version`.
    fn apply_edits(
        &self,
        client: Option<&str>,
        path: &Path,
        version: u64,
        edits: Vec<ide_core::TextEdit>,
    ) -> Result<u64, HostError>;
    fn storage_get(&self, key: &str) -> Result<Option<String>, HostError>;
    /// Sets, or (`None`) deletes.
    fn storage_set(&self, key: &str, value: Option<String>) -> Result<(), HostError>;
    fn storage_keys(&self, prefix: &str) -> Result<Vec<String>, HostError>;
    fn vcs_status(&self, root: &Path) -> Result<Option<RepositoryStatus>, HostError>;
    fn vcs_remotes(&self, root: &Path) -> Result<Vec<(String, String)>, HostError> {
        let _ = root;
        Ok(Vec::new())
    }
    fn vcs_fetch(&self, root: &Path, cancel: &CancellationToken) -> Result<(), HostError>;
    /// The commit being prepared in `client`'s window (`None`: no repository),
    /// waiting for the window until `cancel` fires.
    fn pending_commit(
        &self,
        client: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Option<CommitDraft>, HostError> {
        let _ = (client, cancel);
        Ok(None)
    }
    /// Replaces the commit message of `client`'s window if its draft is still at
    /// `revision` (else [`HostError::Stale`]).
    fn set_commit_message(&self, client: Option<&str>, revision: u64, message: String) -> Result<(), HostError> {
        let _ = (client, revision, message);
        Err(HostError::Invalid("no commit is being prepared".into()))
    }
    /// Subscribes to (or unsubscribes from) a kind of workbench event.
    /// Project files matching `glob` (root-relative), at most `limit`.
    fn find_files(&self, root: &Path, glob: &str, limit: usize) -> Result<Vec<String>, HostError>;
    /// Replaces the plugin's diagnostics for `path`.
    fn publish_diagnostics(&self, path: &Path, items: Vec<ide_core::Diagnostic>) -> Result<(), HostError>;
    /// Performs `request` (its host is granted), filling in secret placeholders.
    fn fetch(&self, request: HttpRequest, cancel: &CancellationToken) -> Result<HttpResponse, HostError>;
    fn secret_is_set(&self, name: &str) -> bool;
    /// Runs the approved file of `process:<program>` with `cmd.env` added to
    /// the inherited environment, and waits.
    fn run_process(
        &self,
        cmd: ProcessCommand,
        cwd: Option<&Path>,
        stdin: Option<String>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<ProcessOutput, HostError>;
    /// Delivers every event of `kind`, dropping its path filter.
    fn subscribe(&self, kind: EventKind);
    /// Delivers `kind` (`file-opened`, `file-saved`) only for paths matching `globs`.
    fn subscribe_paths(&self, kind: &str, globs: Vec<String>) -> Result<(), HostError>;
    fn unsubscribe(&self, kind: &str);
    /// Starts `cmd` and returns the handle to it without waiting.
    fn start_process(&self, cmd: ProcessCommand, cwd: Option<&Path>) -> Result<u64, HostError>;
    /// What process `id` printed since the last call, each stream at most
    /// `max` bytes (the rest waits for the next call), and its status once it
    /// ended.
    fn poll_process(&self, id: u64, max: usize) -> Result<ProcessChunk, HostError>;
    /// Writes `text` to the stdin of process `id`.
    fn write_process(&self, id: u64, text: &str) -> Result<(), HostError>;
    /// Closes the stdin of process `id`.
    fn close_process_stdin(&self, id: u64) -> Result<(), HostError>;
    /// Ends process `id`; not an error if it already ended.
    fn kill_process(&self, id: u64) -> Result<(), HostError>;
    /// Waits up to `timeout` for process `id` to end (`ZERO` only checks) and
    /// returns what it printed meanwhile with its status once it ended.
    fn wait_process(
        &self,
        id: u64,
        max: usize,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<ProcessChunk, HostError>;
    /// Starts a progress indicator; cancelling it from the UI cancels `cancel`.
    fn task_begin(&self, client: Option<&str>, title: String, cancellable: bool, cancel: CancellationToken) -> u64;
    fn task_report(&self, id: u64, done: u32, total: Option<u32>, message: Option<String>);
    fn task_cancelled(&self, id: u64) -> bool;
    fn task_end(&self, id: u64);
    /// The plugin's view (or custom editors) `view` must be rendered again.
    fn refresh_view(&self, view: &str);
    /// A message for the script of the `html` body of `view`.
    fn post_view_message(&self, view: &str, message: String) -> Result<(), HostError>;
    /// Opens a terminal in `client`'s window running the approved file of
    /// `process:<program>` in `cwd`.
    fn open_terminal(
        &self,
        client: Option<&str>,
        title: String,
        program: &str,
        args: Vec<String>,
        cwd: Option<&Path>,
    ) -> Result<(), HostError>;
    fn open_location(&self, client: Option<&str>, path: &Path, line: u32, column: u32) -> Result<(), HostError>;
    /// The IDE's UI language as a BCP 47 tag.
    fn locale(&self) -> String;
    /// A setting of the plugin as JSON (project over global over the schema default).
    fn setting(&self, root: Option<&Path>, key: &str) -> Option<String>;
    /// Reads and decodes a text file outside the project, whose real path an
    /// `fs.read` grant already covers: the unsaved buffer wins, then the disk.
    /// `max` bounds the bytes read.
    fn read_text_file(&self, real: &Path, max: usize) -> Result<String, HostError>;
    /// Replaces the text of a file whose real path the caller already checked:
    /// in one step, keeping its encoding and BOM (a new file is UTF-8). Refused
    /// while an editor holds unsaved changes for it.
    fn write_text_file(&self, real: &Path, text: &str) -> Result<(), HostError>;
    /// Replaces the bytes of a file whose real path the caller already checked,
    /// in one step. Refused while an editor holds unsaved changes for it.
    fn write_bytes_file(&self, real: &Path, bytes: &[u8]) -> Result<(), HostError>;
}

/// Shared compilation engine plus an epoch ticker thread for wall-clock limits.
pub struct PluginEngine {
    engine: Engine,
    linker: Linker<StoreData>,
}

impl PluginEngine {
    pub fn new() -> Result<Self, String> {
        let mut config = Config::new();
        config.wasm_component_model(true).consume_fuel(true).epoch_interruption(true);
        let engine = Engine::new(&config).map_err(|e| format!("wasm engine: {e}"))?;
        let mut linker = Linker::new(&engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker).map_err(|e| e.to_string())?;
        bindings::Plugin::add_to_linker::<_, HasSelf<_>>(&mut linker, |s| s).map_err(|e| e.to_string())?;

        let weak = engine.weak();
        std::thread::Builder::new()
            .name("plugin-epoch".into())
            .spawn(move || {
                while let Some(engine) = weak.upgrade() {
                    engine.increment_epoch();
                    drop(engine);
                    std::thread::sleep(EPOCH_TICK);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { engine, linker })
    }

    pub fn compile(&self, wasm: &Path) -> Result<Component, String> {
        let bytes = std::fs::read(wasm).map_err(|e| format!("{}: {e}", wasm.display()))?;
        self.compile_bytes(&bytes).map_err(|e| format!("{}: {e}", wasm.display()))
    }

    pub fn compile_bytes(&self, bytes: &[u8]) -> Result<Component, String> {
        Component::new(&self.engine, bytes).map_err(|e| format!("not a valid plugin component: {e}"))
    }

    /// Compiles `wasm`, or loads it precompiled from `cache_dir`: the key is the module's hash plus the engine's compatibility hash,
    /// so an engine upgrade simply misses and recompiles. Cache failures only
    /// cost the compilation.
    pub fn compile_cached(&self, wasm: &Path, cache_dir: &Path) -> Result<Component, String> {
        let bytes = std::fs::read(wasm).map_err(|e| format!("{}: {e}", wasm.display()))?;
        let file = cache_dir.join(format!("{}.cwasm", self.cache_key(&bytes)));
        if file.is_file() {
            // SAFETY: the cache directory belongs to the IDE (inside its plugins
            // directory) and is written only by `store_precompiled` below from
            // components this engine compiled; a corrupt file fails validation.
            match unsafe { Component::deserialize_file(&self.engine, &file) } {
                Ok(component) => return Ok(component),
                Err(e) => {
                    tracing::info!("discarding precompiled {}: {e}", file.display());
                    let _ = std::fs::remove_file(&file);
                }
            }
        }
        let component = self.compile_bytes(&bytes).map_err(|e| format!("{}: {e}", wasm.display()))?;
        store_precompiled(&component, &file);
        Ok(component)
    }

    /// Fills the cache for `wasm` if needed (background warm-up). Returns the
    /// cache file name, to keep it when pruning.
    pub fn precompile(&self, wasm: &Path, cache_dir: &Path) -> Result<String, String> {
        let bytes = std::fs::read(wasm).map_err(|e| format!("{}: {e}", wasm.display()))?;
        let name = format!("{}.cwasm", self.cache_key(&bytes));
        let file = cache_dir.join(&name);
        if !file.is_file() {
            let component = self.compile_bytes(&bytes)?;
            store_precompiled(&component, &file);
        }
        Ok(name)
    }

    fn cache_key(&self, bytes: &[u8]) -> String {
        use std::hash::{Hash, Hasher};
        let mut engine = std::collections::hash_map::DefaultHasher::new();
        self.engine.precompile_compatibility_hash().hash(&mut engine);
        let module = blake3::hash(bytes).to_hex();
        format!("{}-{:016x}", &module[..32], engine.finish())
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Rejects a component this host can't run, with a message that says what
    /// to do: one importing interfaces outside the plugin API and WASI, or one
    /// built for a plugin API this host doesn't implement (another major, or a
    /// newer minor), or one that doesn't link: an import the host lacks or
    /// declares with another type (same API version, different WIT), or a
    /// missing plugin export. Returns the API version the component was built
    /// for (`None`: it uses no plugin interface).
    pub fn check_component(&self, component: &Component) -> Result<Option<semver::Version>, String> {
        let ty = component.component_type();
        let imports: Vec<String> = ty.imports(&self.engine).map(|(name, _)| name.to_owned()).collect();
        let foreign: Vec<&str> = imports
            .iter()
            .map(String::as_str)
            .filter(|i| !(i.starts_with(PLUGIN_PACKAGE_PREFIX) || i.starts_with("wasi:")))
            .collect();
        if !foreign.is_empty() {
            return Err(format!("the component imports interfaces the IDE does not provide: {}", foreign.join(", ")));
        }
        let exports = ty.exports(&self.engine).map(|(name, _)| name.to_owned()).collect::<Vec<_>>();
        let built_for = component_api(imports.iter().chain(&exports).map(String::as_str))?;
        if let Some(v) = &built_for {
            check_api(v, &host_api())?;
        }
        let pre = self.linker.instantiate_pre(component).map_err(|e| link_error(&format!("{e:#}")))?;
        bindings::PluginIndices::new(&pre).map_err(|e| link_error(&format!("{e:#}")))?;
        Ok(built_for)
    }
}

/// Explains a component that doesn't link against this host's plugin API.
fn link_error(detail: &str) -> String {
    format!(
        "the component doesn't match the plugin API of this IDE ({API_VERSION}): {detail}. \
         If it was built for a newer OpenIDEA, update OpenIDEA; otherwise rebuild it with the {API_VERSION} SDK"
    )
}

/// Interface names of the plugin API start with this (`openidea:plugin/log@1.0.0`).
const PLUGIN_PACKAGE_PREFIX: &str = "openidea:plugin/";

/// The plugin API this host implements: the version of the `wit/` package.
pub fn host_api() -> semver::Version {
    semver::Version::parse(ide_extension::ENGINE_VERSION).expect("ENGINE_VERSION is a semantic version")
}

/// The plugin API version a component was built for: the highest version on
/// its `openidea:plugin/*` imports and exports. An unversioned plugin
/// interface is an error, since nothing could tell compatible hosts apart.
pub fn component_api<'a>(names: impl IntoIterator<Item = &'a str>) -> Result<Option<semver::Version>, String> {
    let mut highest: Option<semver::Version> = None;
    for name in names {
        let Some(rest) = name.strip_prefix(PLUGIN_PACKAGE_PREFIX) else { continue };
        let Some((_, version)) = rest.split_once('@') else {
            return Err(format!("the component uses the unversioned plugin interface {name:?}"));
        };
        let version =
            semver::Version::parse(version).map_err(|e| format!("bad plugin API version in {name:?}: {e}"))?;
        if highest.as_ref().is_none_or(|h| version > *h) {
            highest = Some(version);
        }
    }
    Ok(highest)
}

/// A component built for `built_for` runs on a host implementing `host` when
/// the major versions match and the host's minor is at least as new (1.x only
/// adds; patches change no interface; 0.x makes no promise, so there every
/// minor is its own API).
pub fn check_api(built_for: &semver::Version, host: &semver::Version) -> Result<(), String> {
    let (b, h) = ((built_for.major, built_for.minor), (host.major, host.minor));
    let same_line = b.0 == h.0 && (h.0 > 0 || b.1 == h.1);
    if same_line && b <= h {
        return Ok(());
    }
    let newer = b > h;
    let (b, h) = (format!("{}.{}", b.0, b.1), format!("{}.{}", h.0, h.1));
    Err(if newer {
        format!("the component was built for plugin API {b}, newer than this IDE's {h}: update OpenIDEA")
    } else {
        format!("the component was built for plugin API {b}; this IDE runs {h}: rebuild it with the {h} SDK")
    })
}

fn store_precompiled(component: &Component, file: &Path) {
    let Ok(bytes) = component.serialize() else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Unique per write: two threads may store the same component at once, and a
    // shared temporary file could be renamed into place half written.
    static WRITES: AtomicU64 = AtomicU64::new(0);
    let tmp = file.with_extension(format!("tmp{}-{}", std::process::id(), WRITES.fetch_add(1, Ordering::Relaxed)));
    if std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, file)).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Interrupts the running call: the epoch callback traps on `flag`, host
/// operations (a fetch) watch `token`. Reset when a call starts.
#[derive(Default)]
pub struct CallCancel {
    flag: AtomicBool,
    token: Mutex<CancellationToken>,
}

impl CallCancel {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
        self.token.lock().cancel();
    }

    /// Cooperative cancellation: host operations (`net`, `process`, fetch)
    /// return `cancelled` and tasks report it; the guest keeps its instance.
    pub fn cancel_soft(&self) {
        self.token.lock().cancel();
    }

    pub(crate) fn token(&self) -> CancellationToken {
        self.token.lock().clone()
    }

    fn is_set(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    fn reset(&self) {
        self.flag.store(false, Ordering::Release);
        *self.token.lock() = CancellationToken::new();
    }
}

pub struct StoreData {
    /// The running call is interrupted at the next epoch tick past this.
    pub(crate) deadline: Instant,
    /// Wall-clock limit of the running call (for the message).
    pub(crate) timeout: Duration,
    pub(crate) call_started: Instant,
    pub(crate) cancel: Arc<CallCancel>,
    pub(crate) limits: Limits,
    wasi: WasiCtx,
    pub(crate) table: ResourceTable,
    store_limits: StoreLimits,
    stderr: MemoryOutputPipe,
    stderr_seen: usize,
    pub(crate) plugin_id: String,
    pub(crate) granted: Vec<Capability>,
    pub(crate) host: Arc<dyn HostApi>,
    pub(crate) invocation: Invocation,
    /// The running call is a command or an event, so it may ask the user.
    pub(crate) interactive: bool,
    /// Tasks begun by the running call and not ended yet.
    pub(crate) open_tasks: Vec<u64>,
    pub(crate) last_report: Option<Instant>,
}

impl WasiView for StoreData {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}

impl StoreData {
    /// New guest stderr output since the last call (panic messages, eprintln!).
    fn drain_stderr(&mut self) -> String {
        let all = self.stderr.contents();
        let new = String::from_utf8_lossy(&all[self.stderr_seen.min(all.len())..]).into_owned();
        self.stderr_seen = all.len();
        new
    }
}

pub(crate) fn clip(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

/// A call failed: either the plugin returned an error (it stays usable) or it
/// trapped / ran out of budget (the instance is poisoned and must be dropped).
#[derive(Debug)]
pub enum CallError {
    /// The plugin returned an error.
    Guest(GuestError),
    /// The instance trapped (panic, fuel, memory, timeout) and is unusable.
    Trap(String),
}

impl CallError {
    fn missing_export(interface: &str) -> Self {
        Self::Guest(GuestError::Failed(format!("the plugin does not export {interface}")))
    }
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Guest(e) => e.fmt(f),
            Self::Trap(e) => f.write_str(e),
        }
    }
}

/// An error a plugin returned (the API's `error` variant).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuestError {
    /// A capability it needs is not granted.
    Denied(String),
    Stale,
    NotFound(String),
    Invalid(String),
    /// The user cancelled, or the plugin is being stopped.
    Cancelled,
    Failed(String),
}

impl GuestError {
    /// Whether this is the plugin failing, as opposed to an outcome the
    /// user or the host caused (cancelling, a missing grant, bad input).
    pub fn is_failure(&self) -> bool {
        matches!(self, Self::Failed(_))
    }
}

impl std::fmt::Display for GuestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied(c) => write!(f, "permission {c} was not granted"),
            Self::Stale => f.write_str("the document changed meanwhile"),
            Self::NotFound(m) => write!(f, "not found: {m}"),
            Self::Invalid(m) => write!(f, "invalid: {m}"),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Failed(m) => f.write_str(m),
        }
    }
}

impl From<GuestError> for ide_core::IdeError {
    fn from(e: GuestError) -> Self {
        use ide_core::error::ErrorKind;
        let kind = match &e {
            GuestError::Denied(_) => ErrorKind::PermissionDenied,
            GuestError::Stale => ErrorKind::OutOfSync,
            GuestError::NotFound(_) => ErrorKind::NotFound,
            GuestError::Invalid(_) => ErrorKind::InvalidInput,
            GuestError::Cancelled => ErrorKind::Cancelled,
            GuestError::Failed(_) => ErrorKind::Internal,
        };
        ide_core::IdeError::new(kind, e.to_string())
    }
}

pub struct RuntimeSetup {
    pub plugin_id: String,
    pub version: String,
    /// Capabilities granted to the plugin.
    pub granted: Vec<Capability>,
    pub host: Arc<dyn HostApi>,
    pub limits: Limits,
}

pub struct Runtime {
    store: Store<StoreData>,
    exports: Exports,
    limits: Limits,
    version: String,
}

/// What the component exports: the `plugin` world, plus optional interfaces.
struct Exports {
    plugin: bindings::Plugin,
    syntax: Option<wit_syntax::Guest>,
    providers: Option<wit_prov::Guest>,
    indexer: Option<wit_index::Guest>,
    file_actions: Option<wit_fa::Guest>,
    views: Option<wit_view::Guest>,
    semantic: Option<wit_sem::Guest>,
    details: Option<wit_detail::Guest>,
    hover: Option<wit_hover::Guest>,
    commit_checks: Option<wit_cc::Guest>,
    inlay: Option<wit_inlay::Guest>,
    endpoints: Option<wit_endpoints::Guest>,
}

/// Most results one syntax call may return (more are dropped).
const MAX_SYNTAX_ITEMS: usize = 200_000;
/// Most events per delivered batch.
const MAX_BATCH: usize = 1000;

fn event_to_wit(e: WorkbenchEvent) -> wit_events::Event {
    match e {
        WorkbenchEvent::FileOpened(p) => wit_events::Event::FileOpened(p),
        WorkbenchEvent::FileSaved(p) => wit_events::Event::FileSaved(p),
        WorkbenchEvent::EditorFocused(p) => wit_events::Event::EditorFocused(p),
        WorkbenchEvent::VcsChanged(p) => wit_events::Event::VcsChanged(p),
        WorkbenchEvent::Scheduled => wit_events::Event::Scheduled,
        WorkbenchEvent::ActionPerformed(a) => wit_events::Event::ActionPerformed(wit_events::ActionPerformed {
            action: a.action,
            title: a.title,
            source: a.source.name().to_owned(),
            shortcut: a.shortcut,
        }),
    }
}

impl Runtime {
    pub fn instantiate(engine: &PluginEngine, component: &Component, setup: RuntimeSetup) -> Result<Self, String> {
        let stderr = MemoryOutputPipe::new(STDERR_CAPACITY);
        // No preopened dirs, env, args or network: host imports are the only way out.
        let wasi = WasiCtx::builder().stderr(stderr.clone()).build();
        let store_limits = StoreLimitsBuilder::new()
            .memory_size(setup.limits.memory_bytes)
            .instances(32)
            .tables(64)
            .memories(8)
            .trap_on_grow_failure(true)
            .build();
        let now = Instant::now();
        let data = StoreData {
            deadline: now + setup.limits.timeout,
            timeout: setup.limits.timeout,
            call_started: now,
            cancel: Arc::default(),
            limits: setup.limits,
            wasi,
            table: ResourceTable::new(),
            store_limits,
            stderr,
            stderr_seen: 0,
            plugin_id: setup.plugin_id,
            granted: setup.granted,
            host: setup.host,
            invocation: Invocation::default(),
            interactive: false,
            open_tasks: Vec::new(),
            last_report: None,
        };
        let mut store = Store::new(&engine.engine, data);
        store.limiter(|d| &mut d.store_limits);
        // Checked every epoch tick: the per-call deadline and cancellation.
        store.epoch_deadline_callback(|ctx| {
            let data = ctx.data();
            if data.cancel.is_set() {
                Err(wasmtime::Error::msg(CANCELLED))
            } else if Instant::now() >= data.deadline {
                Err(wasmtime::Error::msg(format!("timed out after {:?}", data.timeout)))
            } else {
                Ok(UpdateDeadline::Continue(1))
            }
        });
        arm(&mut store, &setup.limits, setup.limits.timeout).map_err(|e| e.to_string())?;
        let api_hint = |e: wasmtime::Error| {
            let msg = describe_trap(&e, &setup.limits);
            if msg.contains("openidea:plugin/") { link_error(&msg) } else { msg }
        };
        let pre = engine.linker.instantiate_pre(component).map_err(api_hint)?;
        let plugin_indices = bindings::PluginIndices::new(&pre).map_err(api_hint)?;
        let syntax_indices = wit_syntax::GuestIndices::new(&pre).ok();
        let index_indices = wit_index::GuestIndices::new(&pre).ok();
        let file_action_indices = wit_fa::GuestIndices::new(&pre).ok();
        let provider_indices = wit_prov::GuestIndices::new(&pre).ok();
        let view_indices = wit_view::GuestIndices::new(&pre).ok();
        let semantic_indices = wit_sem::GuestIndices::new(&pre).ok();
        let detail_indices = wit_detail::GuestIndices::new(&pre).ok();
        let hover_indices = wit_hover::GuestIndices::new(&pre).ok();
        let commit_check_indices = wit_cc::GuestIndices::new(&pre).ok();
        let inlay_indices = wit_inlay::GuestIndices::new(&pre).ok();
        let endpoint_indices = wit_endpoints::GuestIndices::new(&pre).ok();
        let instance = pre.instantiate(&mut store).map_err(api_hint)?;
        let plugin = plugin_indices.load(&mut store, &instance).map_err(api_hint)?;
        let syntax = match syntax_indices {
            Some(indices) => Some(indices.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        let providers = match provider_indices {
            Some(indices) => Some(indices.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        let indexer = match index_indices {
            Some(i) => Some(i.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        let file_actions = match file_action_indices {
            Some(i) => Some(i.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        let views = match view_indices {
            Some(indices) => Some(indices.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        let semantic = match semantic_indices {
            Some(indices) => Some(indices.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        let details = match detail_indices {
            Some(indices) => Some(indices.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        let hover = match hover_indices {
            Some(indices) => Some(indices.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        let commit_checks = match commit_check_indices {
            Some(indices) => Some(indices.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        let inlay = match inlay_indices {
            Some(indices) => Some(indices.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        let endpoints = match endpoint_indices {
            Some(indices) => Some(indices.load(&mut store, &instance).map_err(api_hint)?),
            None => None,
        };
        Ok(Self {
            store,
            exports: Exports {
                plugin,
                syntax,
                providers,
                views,
                indexer,
                semantic,
                details,
                hover,
                commit_checks,
                inlay,
                endpoints,
                file_actions,
            },
            limits: setup.limits,
            version: setup.version,
        })
    }

    /// The component exports `syntax-provider`.
    pub fn has_syntax(&self) -> bool {
        self.exports.syntax.is_some()
    }

    pub fn syntax_highlights(
        &mut self,
        language: &str,
        text: &str,
        timeout: Duration,
    ) -> Result<Vec<SyntaxToken>, CallError> {
        let tokens = self.syntax_call(timeout, |s, store| s.call_highlights(store, language, text))?;
        Ok(tokens
            .into_iter()
            .take(MAX_SYNTAX_ITEMS)
            .map(|t| SyntaxToken { start: t.start, end: t.end, kind: clip(t.kind, 32) })
            .collect())
    }

    pub fn syntax_outline(
        &mut self,
        language: &str,
        text: &str,
        timeout: Duration,
    ) -> Result<Vec<SyntaxSymbol>, CallError> {
        let symbols = self.syntax_call(timeout, |s, store| s.call_outline(store, language, text))?;
        Ok(symbols
            .into_iter()
            .take(MAX_SYNTAX_ITEMS)
            .map(|s| SyntaxSymbol {
                name: clip(s.name, MAX_TITLE),
                detail: s.detail.map(|d| clip(d, MAX_TITLE)),
                kind: clip(s.kind, 32),
                start: s.start,
                end: s.end,
                name_start: s.name_start,
                name_end: s.name_end,
                parent: s.parent,
            })
            .collect())
    }

    pub fn syntax_folding(
        &mut self,
        language: &str,
        text: &str,
        timeout: Duration,
    ) -> Result<Vec<SyntaxFold>, CallError> {
        let folds = self.syntax_call(timeout, |s, store| s.call_folding(store, language, text))?;
        Ok(folds
            .into_iter()
            .take(MAX_SYNTAX_ITEMS)
            .map(|f| SyntaxFold { start_line: f.start_line, end_line: f.end_line, kind: clip(f.kind, 32) })
            .collect())
    }

    fn syntax_call<R>(
        &mut self,
        timeout: Duration,
        f: impl FnOnce(&wit_syntax::Guest, &mut Store<StoreData>) -> wasmtime::Result<R>,
    ) -> Result<R, CallError> {
        if self.exports.syntax.is_none() {
            return Err(CallError::missing_export("syntax-provider"));
        }
        self.call(Invocation::default(), timeout, |exports, store| f(exports.syntax.as_ref().expect("checked"), store))
    }

    pub fn index_document(
        &mut self,
        path: &str,
        text: &str,
        symbols: &[crate::indexing::IndexSymbol],
        invocation: Invocation,
    ) -> Result<crate::indexing::Edges, CallError> {
        if self.exports.indexer.is_none() {
            return Err(CallError::missing_export("document-indexer"));
        }
        let doc = wit_index::Document {
            path: path.into(),
            text: text.into(),
            symbols: symbols
                .iter()
                .map(|s| wit_index::Symbol {
                    name: s.name.clone(),
                    kind: s.kind.clone(),
                    container: s.container.clone(),
                    range: range_to_wit(s.range),
                })
                .collect(),
        };
        let edges = self.call(invocation, self.limits.timeout, |e, store| {
            e.indexer.as_ref().expect("checked").call_index(store, &doc)
        })?;
        fn anchor(a: wit_index::Anchor) -> crate::indexing::Anchor {
            crate::indexing::Anchor { key: a.key, range: range_from_wit(a.range) }
        }
        Ok(crate::indexing::Edges {
            definitions: edges.definitions.into_iter().map(anchor).collect(),
            references: edges.references.into_iter().map(anchor).collect(),
            aliases: edges
                .aliases
                .into_iter()
                .map(|a| crate::indexing::Alias { prefix: a.prefix, target: a.target })
                .collect(),
            markers: edges.markers.into_iter().map(anchor).collect(),
        })
    }

    /// The component exports `providers`.
    pub fn has_providers(&self) -> bool {
        self.exports.providers.is_some()
    }

    fn provider_call<R>(
        &mut self,
        timeout: Duration,
        f: impl FnOnce(&wit_prov::Guest, &mut Store<StoreData>) -> wasmtime::Result<R>,
    ) -> Result<R, CallError> {
        if self.exports.providers.is_none() {
            return Err(CallError::missing_export("providers"));
        }
        self.call(Invocation::default(), timeout, |e, store| f(e.providers.as_ref().expect("checked"), store))
    }

    pub fn provide_completion(
        &mut self,
        doc: &ProviderDocument,
        at: ide_core::Pos,
        trigger: Option<&str>,
        timeout: Duration,
    ) -> Result<Vec<CompletionItem>, CallError> {
        let d = doc_to_wit(doc);
        let items = self.provider_call(timeout, |p, s| p.call_completion(s, &d, pos_to_wit(at), trigger))?;
        Ok(items
            .into_iter()
            .take(MAX_PROVIDER_ITEMS)
            .map(|i| CompletionItem {
                label: clip(i.label, MAX_TITLE),
                detail: i.detail.map(|d| clip(d, MAX_TITLE)),
                kind: i.kind.map(|k| clip(k, 32)),
                insert_text: clip(i.insert_text, 64 << 10),
                snippet: i.snippet,
                replace: i.replace.map(range_from_wit),
                sort_text: i.sort_text.map(|t| clip(t, 64)),
                filter_text: i.filter_text.map(|t| clip(t, MAX_TITLE)),
                documentation: i.documentation.map(|d| clip(d, 16 << 10)),
                additional_edits: i
                    .additional_edits
                    .into_iter()
                    .take(MAX_ADDITIONAL_EDITS)
                    .map(edit_from_wit)
                    .collect(),
            })
            .collect())
    }

    pub fn provide_inline_completion(
        &mut self,
        doc: &ProviderDocument,
        at: ide_core::Pos,
        timeout: Duration,
    ) -> Result<Option<InlineSuggestion>, CallError> {
        let d = doc_to_wit(doc);
        let s = self.provider_call(timeout, |p, s| p.call_inline_completion(s, &d, pos_to_wit(at)))?;
        Ok(s.map(|s| InlineSuggestion {
            insert_text: clip(s.insert_text, 64 << 10),
            replace: s.replace.map(range_from_wit),
        }))
    }

    pub fn provide_code_actions(
        &mut self,
        doc: &ProviderDocument,
        selection: ide_core::Range,
        timeout: Duration,
    ) -> Result<Vec<CodeAction>, CallError> {
        let mut out = Vec::new();
        if self.exports.providers.is_some() {
            let d = doc_to_wit(doc);
            let actions = self.provider_call(timeout, |p, s| p.call_code_actions(s, &d, range_to_wit(selection)))?;
            out.extend(actions.into_iter().take(MAX_PROVIDER_ITEMS).map(code_action_from_wit));
        }
        if self.exports.file_actions.is_some() {
            let d = file_action_doc(doc);
            let actions = self.call(Invocation::default(), timeout, |e, store| {
                e.file_actions.as_ref().expect("checked").call_code_actions(store, &d, range_to_wit(selection))
            })?;
            out.extend(actions.into_iter().take(MAX_PROVIDER_ITEMS).map(file_action_from_wit));
        }
        if out.is_empty() && self.exports.providers.is_none() {
            return Err(CallError::missing_export("providers"));
        }
        Ok(out)
    }

    /// The edits of an action `provide_code_actions` returned with `data`.
    pub fn resolve_code_action(
        &mut self,
        doc: &ProviderDocument,
        action: &CodeAction,
        timeout: Duration,
    ) -> Result<CodeAction, CallError> {
        if action.file_action {
            if self.exports.file_actions.is_none() {
                return Err(CallError::missing_export("file-actions"));
            }
            let d = file_action_doc(doc);
            let a = file_action_to_wit(action);
            let resolved = self.call(Invocation::default(), timeout, |e, store| {
                e.file_actions.as_ref().expect("checked").call_resolve(store, &d, &a)
            })?;
            return resolved.map(file_action_from_wit).map_err(|e| CallError::Guest(e.into()));
        }
        let d = doc_to_wit(doc);
        let a = code_action_to_wit(action);
        let resolved = self.provider_call(timeout, |p, s| p.call_resolve_code_action(s, &d, &a))?;
        resolved.map(code_action_from_wit).map_err(|e| CallError::Guest(e.into()))
    }

    pub fn provide_definition(
        &mut self,
        doc: &ProviderDocument,
        at: ide_core::Pos,
        timeout: Duration,
    ) -> Result<Vec<Location>, CallError> {
        let d = doc_to_wit(doc);
        let locations = self.provider_call(timeout, |p, s| p.call_definition(s, &d, pos_to_wit(at)))?;
        Ok(locations.into_iter().take(MAX_PROVIDER_ITEMS).map(location_from_wit).collect())
    }

    pub fn provide_line_markers(
        &mut self,
        doc: &ProviderDocument,
        timeout: Duration,
    ) -> Result<Vec<LineMarker>, CallError> {
        let d = doc_to_wit(doc);
        let markers = self.provider_call(timeout, |p, s| p.call_line_markers(s, &d))?;
        Ok(markers
            .into_iter()
            .take(MAX_PROVIDER_ITEMS)
            .map(|m| LineMarker {
                line: m.line,
                icon: m.icon.map(|i| clip(i, 32)),
                tooltip: clip(m.tooltip, 1024),
                target: m.target.map(location_from_wit),
            })
            .collect())
    }

    pub fn provide_semantic_tokens(
        &mut self,
        doc: &ProviderDocument,
        timeout: Duration,
    ) -> Result<Vec<SemanticToken>, CallError> {
        if self.exports.semantic.is_none() {
            return Err(CallError::missing_export("semantic-tokens-provider"));
        }
        let d = wit_sem::Document {
            path: to_ipc(&doc.path),
            language: doc.language.clone(),
            version: doc.version,
            text: doc.text.clone(),
        };
        let tokens = self.call(Invocation::default(), timeout, |e, store| {
            e.semantic.as_ref().expect("checked").call_semantic_tokens(store, &d)
        })?;
        Ok(tokens
            .into_iter()
            .take(MAX_SEMANTIC_TOKENS)
            .map(|t| SemanticToken {
                range: range_from_wit(t.range),
                kind: clip(t.kind, 32),
                modifiers: t.modifiers.into_iter().take(MAX_TOKEN_MODIFIERS).map(|m| clip(m, 32)).collect(),
            })
            .collect())
    }

    pub fn provide_hover(
        &mut self,
        doc: &ProviderDocument,
        at: ide_core::Pos,
        timeout: Duration,
    ) -> Result<Option<PluginHover>, CallError> {
        if self.exports.hover.is_none() {
            return Err(CallError::missing_export("hover-provider"));
        }
        let d = wit_hover::Document {
            path: to_ipc(&doc.path),
            language: doc.language.clone(),
            version: doc.version,
            text: doc.text.clone(),
        };
        let hover = self.call(Invocation::default(), timeout, |e, store| {
            e.hover.as_ref().expect("checked").call_hover(store, &d, pos_to_wit(at))
        })?;
        Ok(hover
            .filter(|h| !h.markdown.trim().is_empty())
            .map(|h| PluginHover { markdown: clip(h.markdown, MAX_HOVER_BYTES), range: h.range.map(range_from_wit) }))
    }

    pub fn provide_inlay_hints(
        &mut self,
        doc: &ProviderDocument,
        range: ide_core::Range,
        timeout: Duration,
    ) -> Result<Vec<PluginInlayHint>, CallError> {
        if self.exports.inlay.is_none() {
            return Err(CallError::missing_export("inlay-hints-provider"));
        }
        let d = wit_inlay::Document {
            path: to_ipc(&doc.path),
            language: doc.language.clone(),
            version: doc.version,
            text: doc.text.clone(),
        };
        let r = wit_types::Range { start: pos_to_wit(range.start), end: pos_to_wit(range.end) };
        let hints = self.call(Invocation::default(), timeout, |e, store| {
            e.inlay.as_ref().expect("checked").call_inlay_hints(store, &d, r)
        })?;
        Ok(hints
            .into_iter()
            .filter(|h| !h.label.trim().is_empty())
            .take(MAX_PROVIDER_ITEMS)
            .map(|h| PluginInlayHint {
                position: ide_core::Pos::new(h.position.line, h.position.character),
                label: clip(h.label, 256),
                kind: clip(h.kind, 32),
                tooltip: h.tooltip.map(|t| clip(t, 1024)),
                padding_left: h.padding_left,
                padding_right: h.padding_right,
            })
            .collect())
    }

    pub fn activate(&mut self) -> Result<(), CallError> {
        let data = self.store.data();
        let ctx = wit_types::Context {
            plugin_id: data.plugin_id.clone(),
            plugin_version: self.version.clone(),
            api_version: API_VERSION.into(),
            capabilities: data.granted.iter().map(|c| c.to_string()).collect(),
        };
        self.call(Invocation::default(), self.limits.timeout, |e, store| {
            e.plugin.openidea_plugin_lifecycle().call_activate(store, &ctx)
        })
        .and_then(|r| r.map_err(|e| CallError::Guest(e.into())))
    }

    pub fn run_command(
        &mut self,
        id: &str,
        arg: Option<&str>,
        invocation: Invocation,
    ) -> Result<Option<String>, CallError> {
        let result = self.call(invocation, self.limits.timeout, |e, store| {
            let ctx = store.data_mut().new_invocation()?;
            store.data_mut().interactive = true;
            let r = e.plugin.openidea_plugin_commands().call_run(
                &mut *store,
                id,
                wasmtime::component::Resource::new_borrow(ctx.rep()),
                arg,
            );
            store.data_mut().drop_invocation(ctx);
            r
        })?;
        result.map_err(|e| CallError::Guest(e.into()))
    }

    /// The component exports `view-provider`.
    pub fn has_views(&self) -> bool {
        self.exports.views.is_some()
    }

    /// Content of a view or custom editor (`invocation.editor`: its document).
    pub fn render_view(
        &mut self,
        view: &str,
        viewport: Option<Viewport>,
        invocation: Invocation,
    ) -> Result<View, CallError> {
        if self.exports.views.is_none() {
            return Err(CallError::missing_export("view-provider"));
        }
        let viewport = viewport.map(|v| wit_vt::Viewport { first_row: v.first_row, rows: v.rows.min(MAX_TABLE_ROWS) });
        let result = self.call(invocation, self.limits.timeout, |e, store| {
            let ctx = store.data_mut().new_invocation()?;
            let views = e.views.as_ref().expect("checked");
            let r =
                views.call_render(&mut *store, view, viewport, wasmtime::component::Resource::new_borrow(ctx.rep()));
            store.data_mut().drop_invocation(ctx);
            r
        })?;
        match result {
            Ok(v) => Ok(view_from_wit(v)),
            Err(e) => Err(CallError::Guest(e.into())),
        }
    }

    /// Project routes, with an explicit project invocation and background budget.
    pub fn endpoints(&mut self, invocation: Invocation, timeout: Duration) -> Result<Vec<crate::Endpoint>, CallError> {
        if self.exports.endpoints.is_none() {
            return Err(CallError::missing_export("endpoints-provider"));
        }
        let result = self.call(invocation, timeout, |e, store| {
            let ctx = store.data_mut().new_invocation()?;
            let r = e
                .endpoints
                .as_ref()
                .expect("checked")
                .call_endpoints(&mut *store, wasmtime::component::Resource::new_borrow(ctx.rep()));
            store.data_mut().drop_invocation(ctx);
            r
        })?;
        let entries = result.map_err(|e| CallError::Guest(e.into()))?;
        if entries.len() > MAX_PROVIDER_ITEMS {
            return Err(CallError::Guest(GuestError::Invalid("too many endpoints".into())));
        }
        Ok(entries
            .into_iter()
            .map(|e| crate::Endpoint {
                method: e.method,
                path: e.path,
                framework: e.framework,
                handler: e.handler,
                location: location_from_wit(e.location),
            })
            .collect())
    }

    /// The Services pane of node `key` of the plugin's services view `view`.
    pub fn service_detail(
        &mut self,
        view: &str,
        key: &str,
        invocation: Invocation,
    ) -> Result<Vec<ServiceTab>, CallError> {
        if self.exports.details.is_none() {
            return Err(CallError::missing_export("detail-provider"));
        }
        let result = self.call(invocation, self.limits.timeout, |e, store| {
            let ctx = store.data_mut().new_invocation()?;
            let details = e.details.as_ref().expect("checked");
            let r = details.call_detail(&mut *store, view, key, wasmtime::component::Resource::new_borrow(ctx.rep()));
            store.data_mut().drop_invocation(ctx);
            r
        })?;
        match result {
            Ok(tabs) => Ok(tabs.into_iter().take(MAX_SERVICE_TABS).map(service_tab_from_wit).collect()),
            Err(e) => Err(CallError::Guest(e.into())),
        }
    }

    /// Runs the plugin's before-commit check `check` on `draft`.
    pub fn commit_check(
        &mut self,
        check: &str,
        draft: CommitDraft,
        invocation: Invocation,
    ) -> Result<Vec<CommitProblem>, CallError> {
        if self.exports.commit_checks.is_none() {
            return Err(CallError::missing_export("commit-checker"));
        }
        let draft = crate::wit_host::commit_draft_to_wit(draft);
        let result = self.call(invocation, self.limits.timeout, |e, store| {
            let ctx = store.data_mut().new_invocation()?;
            let checks = e.commit_checks.as_ref().expect("checked");
            let r = checks.call_check(&mut *store, check, &draft, wasmtime::component::Resource::new_borrow(ctx.rep()));
            store.data_mut().drop_invocation(ctx);
            r
        })?;
        match result {
            Ok(problems) => Ok(problems.into_iter().take(MAX_COMMIT_PROBLEMS).map(commit_problem_from_wit).collect()),
            Err(e) => Err(CallError::Guest(e.into())),
        }
    }

    /// A user action in a view or custom editor.
    pub fn view_event(&mut self, view: &str, event: ViewEvent, invocation: Invocation) -> Result<(), CallError> {
        if self.exports.views.is_none() {
            return Err(CallError::missing_export("view-provider"));
        }
        let event = event_to_wit_view(event);
        let result = self.call(invocation, self.limits.timeout, |e, store| {
            let ctx = store.data_mut().new_invocation()?;
            store.data_mut().interactive = true;
            let views = e.views.as_ref().expect("checked");
            let r = views.call_handle(&mut *store, view, &event, wasmtime::component::Resource::new_borrow(ctx.rep()));
            store.data_mut().drop_invocation(ctx);
            r
        })?;
        result.map_err(|e| CallError::Guest(e.into()))
    }

    /// Delivers a batch of events (from the window in `invocation`).
    pub fn handle_events(&mut self, events: Vec<WorkbenchEvent>, invocation: Invocation) -> Result<(), CallError> {
        let events: Vec<wit_events::Event> = events.into_iter().take(MAX_BATCH).map(event_to_wit).collect();
        self.call(invocation, self.limits.timeout, |e, store| {
            let ctx = store.data_mut().new_invocation()?;
            store.data_mut().interactive = true;
            let r = e.plugin.openidea_plugin_event_handler().call_handle(
                &mut *store,
                &events,
                wasmtime::component::Resource::new_borrow(ctx.rep()),
            );
            store.data_mut().drop_invocation(ctx);
            r
        })
    }

    /// Best effort; errors are logged.
    pub fn deactivate(&mut self) {
        if let Err(e) = self.call(Invocation::default(), self.limits.timeout, |e, store| {
            e.plugin.openidea_plugin_lifecycle().call_deactivate(store)
        }) {
            tracing::warn!(plugin = %self.store.data().plugin_id, "deactivate failed: {e}");
        }
    }

    /// Interrupts the running call when cancelled (the instance is then
    /// poisoned, like after a timeout). Reset when the next call starts.
    pub fn cancel_handle(&self) -> Arc<CallCancel> {
        self.store.data().cancel.clone()
    }

    fn call<R>(
        &mut self,
        invocation: Invocation,
        timeout: Duration,
        f: impl FnOnce(&Exports, &mut Store<StoreData>) -> wasmtime::Result<R>,
    ) -> Result<R, CallError> {
        arm(&mut self.store, &self.limits, timeout).map_err(|e| CallError::Trap(e.to_string()))?;
        self.store.data_mut().invocation = invocation;
        let result = f(&self.exports, &mut self.store);
        let data = self.store.data_mut();
        data.invocation = Invocation::default();
        data.interactive = false;
        // Tasks don't outlive the call that began them.
        for id in std::mem::take(&mut data.open_tasks) {
            data.host.task_end(id);
        }
        let stderr = data.drain_stderr();
        if !stderr.trim().is_empty() {
            tracing::info!(plugin = %data.plugin_id, "stderr: {}", stderr.trim_end());
        }
        match result {
            Ok(r) => Ok(r),
            Err(e) => {
                let mut msg = describe_trap(&e, &self.limits);
                // Typically the panic message: "panicked at src/lib.rs:1:2:\nboom".
                let detail: Vec<&str> =
                    stderr.lines().filter(|l| !l.trim().is_empty() && !l.starts_with("note:")).collect();
                if !detail.is_empty() {
                    let tail = detail[detail.len().saturating_sub(4)..].join("\n");
                    msg = format!("{msg}\n{}", clip(tail, 1024));
                }
                Err(CallError::Trap(msg))
            }
        }
    }
}

/// Most items one provider call may return (more are dropped).
const MAX_PROVIDER_ITEMS: usize = 10_000;
const MAX_SEMANTIC_TOKENS: usize = 1 << 16;
const MAX_TOKEN_MODIFIERS: usize = 8;
const MAX_HOVER_BYTES: usize = 64 * 1024;

fn pos_to_wit(p: ide_core::Pos) -> wit_types::Position {
    wit_types::Position { line: p.line, character: p.col }
}

fn range_to_wit(r: ide_core::Range) -> wit_types::Range {
    wit_types::Range { start: pos_to_wit(r.start), end: pos_to_wit(r.end) }
}

fn range_from_wit(r: wit_types::Range) -> ide_core::Range {
    ide_core::Range::new(
        ide_core::Pos::new(r.start.line, r.start.character),
        ide_core::Pos::new(r.end.line, r.end.character),
    )
}

fn location_from_wit(l: wit_types::Location) -> Location {
    Location { path: std::path::PathBuf::from(l.path), range: range_from_wit(l.range) }
}

fn doc_to_wit(d: &ProviderDocument) -> wit_prov::Document {
    wit_prov::Document { path: to_ipc(&d.path), language: d.language.clone(), version: d.version, text: d.text.clone() }
}

/// Resets the budgets for the next call: fuel, deadline, cancellation.
fn arm(store: &mut Store<StoreData>, limits: &Limits, timeout: Duration) -> wasmtime::Result<()> {
    store.set_fuel(limits.fuel)?;
    let data = store.data_mut();
    let now = Instant::now();
    data.call_started = now;
    data.deadline = now + timeout;
    data.timeout = timeout;
    data.last_report = None;
    data.cancel.reset();
    // The callback above runs every tick and decides.
    store.set_epoch_deadline(1);
    Ok(())
}

fn describe_trap(e: &wasmtime::Error, limits: &Limits) -> String {
    match e.downcast_ref::<wasmtime::Trap>() {
        Some(wasmtime::Trap::OutOfFuel) => format!("exceeded its CPU budget ({} fuel per call)", limits.fuel),
        Some(wasmtime::Trap::Interrupt) => CANCELLED.to_owned(),
        Some(wasmtime::Trap::UnreachableCodeReached) => "crashed (panic / unreachable)".to_owned(),
        Some(trap) => format!("trapped: {trap}"),
        None => {
            let root = e.root_cause().to_string();
            if root.contains("memory") {
                format!("{root} (memory limit {} MiB)", limits.memory_bytes >> 20)
            } else {
                root
            }
        }
    }
}

/// Most table rows one render returns (and a viewport asks for).
const MAX_TABLE_ROWS: u32 = 2_000;
/// Most tree / list items and form fields per view.
const MAX_VIEW_ITEMS: usize = 20_000;
const MAX_CELL: usize = 64 << 10;
const MAX_HTML: usize = 4 << 20;

/// Most additional edits of a completion item.
const MAX_ADDITIONAL_EDITS: usize = 100;

fn edit_from_wit(e: wit_types::TextEdit) -> ide_core::TextEdit {
    ide_core::TextEdit { range: range_from_wit(e.range), new_text: e.text }
}

fn code_action_from_wit(a: wit_prov::CodeAction) -> CodeAction {
    CodeAction {
        title: clip(a.title, MAX_TITLE),
        kind: a.kind.map(|k| clip(k, 64)),
        preferred: a.preferred,
        edits: a
            .edits
            .into_iter()
            .map(|f| (std::path::PathBuf::from(f.path), f.edits.into_iter().map(edit_from_wit).collect()))
            .collect(),
        operations: Vec::new(),
        open: None,
        data: a.data.map(|d| clip(d, 64 << 10)),
        file_action: false,
    }
}

fn code_action_to_wit(a: &CodeAction) -> wit_prov::CodeAction {
    wit_prov::CodeAction {
        title: a.title.clone(),
        kind: a.kind.clone(),
        preferred: a.preferred,
        edits: a
            .edits
            .iter()
            .map(|(path, edits)| wit_prov::FileEdit {
                path: to_ipc(path),
                edits: edits
                    .iter()
                    .map(|e| wit_types::TextEdit { range: range_to_wit(e.range), text: e.new_text.clone() })
                    .collect(),
            })
            .collect(),
        data: a.data.clone(),
    }
}

const MAX_FILE_OPERATIONS: usize = 1000;

fn file_action_doc(doc: &ProviderDocument) -> wit_fa::Document {
    wit_fa::Document {
        path: to_ipc(&doc.path),
        language: doc.language.clone(),
        version: doc.version,
        text: doc.text.clone(),
    }
}

fn file_action_from_wit(a: wit_fa::FileAction) -> CodeAction {
    CodeAction {
        title: clip(a.title, MAX_TITLE),
        kind: a.kind.map(|k| clip(k, 64)),
        preferred: a.preferred,
        edits: a
            .edits
            .into_iter()
            .map(|f| (std::path::PathBuf::from(f.path), f.edits.into_iter().map(edit_from_wit).collect()))
            .collect(),
        operations: a.operations.into_iter().take(MAX_FILE_OPERATIONS).map(operation_from_wit).collect(),
        open: a.open.map(std::path::PathBuf::from),
        data: a.data.map(|d| clip(d, 64 << 10)),
        file_action: true,
    }
}

fn file_action_to_wit(a: &CodeAction) -> wit_fa::FileAction {
    wit_fa::FileAction {
        title: a.title.clone(),
        kind: a.kind.clone(),
        preferred: a.preferred,
        operations: a
            .operations
            .iter()
            .map(|op| match op {
                FileOperation::Create { path, text, overwrite } => wit_fa::FileOperation::Create(wit_fa::CreateFile {
                    path: to_ipc(path),
                    text: text.clone(),
                    overwrite: *overwrite,
                }),
                FileOperation::Rename { from, to } => {
                    wit_fa::FileOperation::Rename(wit_fa::RenameFile { path: to_ipc(from), new_path: to_ipc(to) })
                }
                FileOperation::Delete { path } => {
                    wit_fa::FileOperation::Delete(wit_fa::DeleteFile { path: to_ipc(path) })
                }
            })
            .collect(),
        edits: a
            .edits
            .iter()
            .map(|(path, edits)| wit_fa::FileEdit {
                path: to_ipc(path),
                edits: edits
                    .iter()
                    .map(|e| wit_types::TextEdit { range: range_to_wit(e.range), text: e.new_text.clone() })
                    .collect(),
            })
            .collect(),
        open: a.open.as_deref().map(to_ipc),
        data: a.data.clone(),
    }
}

fn operation_from_wit(op: wit_fa::FileOperation) -> FileOperation {
    match op {
        wit_fa::FileOperation::Create(c) => {
            FileOperation::Create { path: c.path.into(), text: c.text, overwrite: c.overwrite }
        }
        wit_fa::FileOperation::Rename(r) => FileOperation::Rename { from: r.path.into(), to: r.new_path.into() },
        wit_fa::FileOperation::Delete(d) => FileOperation::Delete { path: d.path.into() },
    }
}

fn opt_clip(s: Option<String>, max: usize) -> Option<String> {
    s.map(|s| clip(s, max))
}

const MAX_COMMIT_PROBLEMS: usize = 50;

fn commit_problem_from_wit(p: wit_cc::CommitProblem) -> CommitProblem {
    let (path, range) = match p.location {
        Some(l) => (Some(clip(l.path, 4096)), Some(range_from_wit(l.range))),
        None => (None, None),
    };
    CommitProblem { message: clip(p.message, 4096), path, range }
}

const MAX_SERVICE_TABS: usize = 8;
const MAX_LOG_TOGGLES: usize = 8;
const MAX_LOG_ARGS: usize = 256;
const MAX_LOG_ARG: usize = 4096;

fn service_tab_from_wit(t: wit_dt::Tab) -> ServiceTab {
    let body = match t.body {
        wit_dt::Pane::Message(m) => ServicePane::Message(clip(m, 16 << 10)),
        wit_dt::Pane::Text(text) => ServicePane::Text(clip(text, MAX_TEXT)),
        wit_dt::Pane::Log(log) => {
            let args_fit = |args: &[String]| args.len() <= MAX_LOG_ARGS && args.iter().all(|a| a.len() <= MAX_LOG_ARG);
            if args_fit(&log.args)
                && log.toggles.len() <= MAX_LOG_TOGGLES
                && log.toggles.iter().all(|t| args_fit(&t.args))
            {
                ServicePane::Log(ServiceLog {
                    program: clip(log.program, 256),
                    args: log.args,
                    toggles: log
                        .toggles
                        .into_iter()
                        .map(|t| ServiceLogToggle { id: clip(t.id, 64), label: clip(t.label, MAX_TITLE), args: t.args })
                        .collect(),
                })
            } else {
                ServicePane::Message(format!(
                    "This log asks for more than {MAX_LOG_ARGS} arguments of {MAX_LOG_ARG} bytes or {MAX_LOG_TOGGLES} toggles."
                ))
            }
        }
    };
    ServiceTab { id: clip(t.id, 64), label: clip(t.label, MAX_TITLE), body }
}

/// A `table` body carried by the `other` case (the sortable variant, plugins/
/// README.md §10): the usual table fields as JSON plus `sort`, the column the
/// plugin orders by and the direction, or null. Anything unparsable degrades
/// like a body this host doesn't know.
fn sortable_table_from_json(data: &str) -> Option<ViewTable> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Json {
        #[serde(default)]
        columns: Vec<String>,
        #[serde(default)]
        total_rows: u32,
        #[serde(default)]
        first_row: u32,
        #[serde(default)]
        rows: Vec<Vec<String>>,
        #[serde(default)]
        editable: bool,
        #[serde(default)]
        sort: Option<TableSort>,
    }
    let json: Json = serde_json::from_str(data).ok()?;
    Some(ViewTable {
        columns: json.columns.into_iter().take(1000).map(|c| clip(c, MAX_TITLE)).collect(),
        total_rows: json.total_rows,
        first_row: json.first_row,
        rows: json
            .rows
            .into_iter()
            .take(MAX_TABLE_ROWS as usize)
            .map(|r| r.into_iter().take(1000).map(|c| clip(c, MAX_CELL)).collect())
            .collect(),
        editable: json.editable,
        sortable: true,
        sort: json.sort,
    })
}

fn view_from_wit(v: wit_vt::View) -> View {
    let body = match v.body {
        wit_vt::Body::Message(m) => ViewBody::Message(clip(m, 16 << 10)),
        wit_vt::Body::Other(e) => match e.kind.as_str() {
            "table" => match sortable_table_from_json(&e.data) {
                Some(t) => ViewBody::Table(t),
                None => ViewBody::Message("This view needs a newer version of OpenIDEA (table).".into()),
            },
            _ => ViewBody::Message(format!("This view needs a newer version of OpenIDEA ({}).", clip(e.kind, 64))),
        },
        wit_vt::Body::Tree(items) => ViewBody::Tree(
            items
                .into_iter()
                .take(MAX_VIEW_ITEMS)
                .map(|i| ViewTreeItem {
                    key: clip(i.key, 1024),
                    parent: opt_clip(i.parent, 1024),
                    label: clip(i.label, MAX_TITLE),
                    icon: opt_clip(i.icon, 64),
                    detail: opt_clip(i.detail, MAX_TITLE),
                    expandable: i.expandable,
                    expanded: i.expanded,
                })
                .collect(),
        ),
        wit_vt::Body::List(items) => ViewBody::List(
            items
                .into_iter()
                .take(MAX_VIEW_ITEMS)
                .map(|i| ViewListItem {
                    key: clip(i.key, 1024),
                    label: clip(i.label, MAX_TITLE),
                    icon: opt_clip(i.icon, 64),
                    detail: opt_clip(i.detail, MAX_TITLE),
                })
                .collect(),
        ),
        wit_vt::Body::Form(fields) => ViewBody::Form(
            fields
                .into_iter()
                .take(MAX_VIEW_ITEMS)
                .filter_map(|f| {
                    let value = match f.value {
                        wit_vt::FieldValue::Text(t) => FieldValue::Text(clip(t, MAX_CELL)),
                        wit_vt::FieldValue::Multiline(t) => FieldValue::Multiline(clip(t, 1 << 20)),
                        wit_vt::FieldValue::Checkbox(b) => FieldValue::Checkbox(b),
                        wit_vt::FieldValue::Choice((options, selected)) => FieldValue::Choice {
                            options: options.into_iter().take(1000).map(|o| clip(o, MAX_TITLE)).collect(),
                            selected: clip(selected, MAX_TITLE),
                        },
                        wit_vt::FieldValue::Other(e) => match e.kind.as_str() {
                            "label" => FieldValue::Label(clip(serde_json::from_str(&e.data).ok()?, MAX_CELL)),
                            "readonly-text" => {
                                #[derive(serde::Deserialize)]
                                struct ReadonlyText {
                                    text: String,
                                    #[serde(default)]
                                    multiline: bool,
                                }
                                let value: ReadonlyText = serde_json::from_str(&e.data).ok()?;
                                FieldValue::ReadonlyText {
                                    text: clip(value.text, if value.multiline { 1 << 20 } else { MAX_CELL }),
                                    multiline: value.multiline,
                                }
                            }
                            _ => return None,
                        },
                    };
                    Some(ViewField { key: clip(f.key, 128), label: clip(f.label, MAX_TITLE), value })
                })
                .collect(),
        ),
        wit_vt::Body::Table(t) => ViewBody::Table(ViewTable {
            columns: t.columns.into_iter().take(1000).map(|c| clip(c, MAX_TITLE)).collect(),
            total_rows: t.total_rows,
            first_row: t.first_row,
            rows: t
                .rows
                .into_iter()
                .take(MAX_TABLE_ROWS as usize)
                .map(|r| r.into_iter().take(1000).map(|c| clip(c, MAX_CELL)).collect())
                .collect(),
            editable: t.editable,
            // The plain body predates sortable headers; `other` kind `table` opts in.
            sortable: false,
            sort: None,
        }),
        wit_vt::Body::Html(h) => ViewBody::Html(clip(h, MAX_HTML)),
    };
    View {
        toolbar: v
            .toolbar
            .into_iter()
            .take(32)
            .map(|b| ViewButton {
                id: clip(b.id, 64),
                label: clip(b.label, MAX_TITLE),
                icon: opt_clip(b.icon, 64),
                enabled: b.enabled,
            })
            .collect(),
        body,
        status: opt_clip(v.status, 1024),
    }
}

fn event_to_wit_view(e: ViewEvent) -> wit_vt::ViewEvent {
    use wit_vt::ViewEvent as W;
    match e {
        ViewEvent::Button { id } => W::Button(id),
        ViewEvent::Activate { key } => W::Activate(key),
        ViewEvent::Select { key } => W::Select(key),
        ViewEvent::Expand { key } => W::Expand(key),
        ViewEvent::Collapse { key } => W::Collapse(key),
        ViewEvent::Field { key, value } => W::Field((key, value)),
        ViewEvent::Cell { row, column, value } => W::Cell(wit_vt::CellEdit { row, column, value }),
        ViewEvent::InsertRow { before } => W::InsertRow(before),
        ViewEvent::DeleteRows { rows } => W::DeleteRows(rows),
        ViewEvent::Message { text } => W::Message(text),
        ViewEvent::TableSelect { row } => {
            W::Other(wit_types::Extension { kind: "table-select".into(), data: format!(r#"{{"row":{row}}}"#) })
        }
        ViewEvent::TableActivate { row } => {
            W::Other(wit_types::Extension { kind: "table-activate".into(), data: format!(r#"{{"row":{row}}}"#) })
        }
        // A sortable table's header click, as an `other` view-event (plugins/
        // README.md §10): the SDKs decode the kinds they know.
        ViewEvent::Sort { column, descending } => W::Other(wit_types::Extension {
            kind: "sort".into(),
            data: format!(r#"{{"column":{column},"descending":{descending}}}"#),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_field_extensions_are_parsed_and_unknown_or_malformed_fields_are_skipped() {
        let fields = [
            ("label", r#""Title \"quoted\"""#),
            ("readonly-text", r#"{"text":"one\ntwo","multiline":true}"#),
            ("readonly-text", r#"{"text":"author"}"#),
            ("label", "{}"),
            ("readonly-text", r#"{"text":false}"#),
            ("future", "null"),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, (kind, data))| wit_vt::Field {
            key: i.to_string(),
            label: "Field".into(),
            value: wit_vt::FieldValue::Other(wit_types::Extension { kind: kind.into(), data: data.into() }),
        })
        .collect();
        let view = view_from_wit(wit_vt::View { toolbar: vec![], body: wit_vt::Body::Form(fields), status: None });
        let ViewBody::Form(fields) = view.body else { panic!("form") };
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[0].value, FieldValue::Label("Title \"quoted\"".into()));
        assert_eq!(fields[1].value, FieldValue::ReadonlyText { text: "one\ntwo".into(), multiline: true });
        assert_eq!(fields[2].value, FieldValue::ReadonlyText { text: "author".into(), multiline: false });
    }

    #[test]
    fn table_row_events_leave_through_released_extension_case() {
        for (event, kind) in [
            (ViewEvent::TableSelect { row: 51 }, "table-select"),
            (ViewEvent::TableActivate { row: 51 }, "table-activate"),
        ] {
            let wit_vt::ViewEvent::Other(extension) = event_to_wit_view(event) else { panic!("other") };
            assert_eq!(extension.kind, kind);
            assert_eq!(extension.data, r#"{"row":51}"#);
        }
    }

    #[cfg(windows)]
    #[test]
    fn provider_and_resolved_action_paths_match_ipc_events() {
        for (path, expected) in [
            (r"C:\project\Example.java", "C:/project/Example.java"),
            (r"\\?\C:\project\Example.java", "C:/project/Example.java"),
            (r"\\server\share\Example.java", "//server/share/Example.java"),
        ] {
            let doc = ProviderDocument { path: path.into(), ..Default::default() };
            assert_eq!(doc_to_wit(&doc).path, expected);
            let action = CodeAction {
                title: "Fix".into(),
                kind: None,
                preferred: false,
                edits: vec![(path.into(), Vec::new())],
                operations: Vec::new(),
                open: None,
                data: None,
                file_action: false,
            };
            assert_eq!(code_action_to_wit(&action).edits[0].path, expected);
        }
    }

    fn ext(kind: &str) -> wit_types::Extension {
        wit_types::Extension { kind: kind.into(), data: "{}".into() }
    }

    #[test]
    fn bodies_and_fields_of_a_newer_api_degrade() {
        let view = |body| wit_vt::View { toolbar: Vec::new(), body, status: None };
        let shown = view_from_wit(view(wit_vt::Body::Other(ext("markdown"))));
        assert_eq!(shown.body, ViewBody::Message("This view needs a newer version of OpenIDEA (markdown).".into()));
        let field = |key: &str, value| wit_vt::Field { key: key.into(), label: key.into(), value };
        let form = view_from_wit(view(wit_vt::Body::Form(vec![
            field("color", wit_vt::FieldValue::Other(ext("color"))),
            field("name", wit_vt::FieldValue::Text("n".into())),
        ])));
        let ViewBody::Form(fields) = form.body else { panic!("a form") };
        assert_eq!(fields.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(), ["name"], "unknown fields are left out");
    }

    #[test]
    fn a_sortable_table_arrives_through_other() {
        let view = |data: &str| wit_vt::View {
            toolbar: Vec::new(),
            body: wit_vt::Body::Other(wit_types::Extension { kind: "table".into(), data: data.into() }),
            status: None,
        };
        let shown = view_from_wit(view(
            r#"{"columns":["ext","files"],"totalRows":3,"firstRow":1,"rows":[["rs","2"],["md","1"]],
                "editable":false,"sort":{"column":1,"descending":true}}"#,
        ));
        let ViewBody::Table(t) = shown.body else { panic!("{shown:?}") };
        assert_eq!(t.columns, ["ext".to_owned(), "files".into()]);
        assert_eq!((t.total_rows, t.first_row, t.editable), (3, 1, false));
        assert!(t.sortable, "a `table` through `other` opts the headers in");
        assert_eq!(t.sort, Some(TableSort { column: 1, descending: true }));

        // No sort yet: still clickable headers, just no arrow.
        let fresh = view_from_wit(view(
            r#"{"columns":["a"],"totalRows":0,"firstRow":0,"rows":[],"editable":false,"sort":null}"#,
        ));
        let ViewBody::Table(t) = fresh.body else { panic!("{fresh:?}") };
        assert!(t.sortable);
        assert_eq!(t.sort, None);

        // Broken JSON degrades like any body the host doesn't know.
        let broken = view_from_wit(view("{not json"));
        assert!(matches!(broken.body, ViewBody::Message(_)), "{broken:?}");
    }

    #[test]
    fn a_sort_click_leaves_as_an_other_extension() {
        let wit = event_to_wit_view(ViewEvent::Sort { column: 2, descending: true });
        let wit_vt::ViewEvent::Other(e) = wit else { panic!("{wit:?}") };
        assert_eq!((e.kind.as_str(), e.data.as_str()), ("sort", r#"{"column":2,"descending":true}"#));
    }
}
