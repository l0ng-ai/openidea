//! [`HostApi`] for one plugin's code: what its imports reach in the IDE.
//! Capabilities were checked by the runtime before any of this runs.

use super::{CommitAnswer, CommitRequest, CommitSelection, PluginContextKey, PluginEvent, PluginEventSink};
use ide_core::ipc_path::to_ipc;
use ide_core::{CancellationToken, TextEdit};
use ide_extension::Capability;
use ide_extension::Package;
use ide_extension::ledger::{Ledger, Subject};
use ide_language::ProgramPin;
use ide_plugin::{
    CommitChange, CommitDraft, EventKind, HostApi, HostError, HttpRequest, HttpResponse, NotificationLevel,
    ProcessChunk, ProcessCommand, ProcessOutput, Prompt, RepositoryStatus, StatusItem,
};
use parking_lot::{Mutex, RwLock};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command as StdCommand, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Largest storage of one plugin (keys + values).
const MAX_STORAGE: usize = 64 << 20;
const MAX_KEY: usize = 256;
/// Most status bar items per plugin.
const MAX_STATUS_ITEMS: usize = 8;
const MAX_CONTEXT_KEYS: usize = 100;
/// Most diff text of a pending commit, all files together.
const MAX_COMMIT_DIFF: usize = 1 << 20;
/// How long a window may take to describe its pending commit (it saves editors first).
const COMMIT_SELECTION_TIMEOUT: Duration = Duration::from_secs(30);
const COMMIT_MESSAGE_TIMEOUT: Duration = Duration::from_secs(10);

/// (window or `None` for every window, plugin, key).
type ContextKey = (Option<String>, String, String);

/// What plugins see of the open projects; provided by the app
/// ([`super::PluginHost::set_workspace`]), over [`crate::Host`] on the desktop.
pub trait PluginWorkspace: Send + Sync {
    /// Execution host of the Database subsystem; absent on unsupported hosts.
    fn database_host(&self) -> Option<Arc<crate::Host>> {
        None
    }

    /// A freshly resolved configuration owned by this plugin in the invoking project.
    fn run_configuration(&self, _client: &str, _plugin: &str, _config: &str) -> Result<ide_run::RunConfig, HostError> {
        Err(HostError::NotFound("run configuration unavailable".into()))
    }

    /// Window-owned reports shared with the MCP tools.
    fn open_editors(&self, _client: &str) -> Result<Vec<ide_plugin::OpenEditor>, HostError> {
        Ok(Vec::new())
    }
    /// Shared Find in Files service, preferring the invoking window's document store.
    fn search_text(
        &self,
        _client: Option<&str>,
        _root: &Path,
        _query: ide_plugin::TextQuery,
        _limit: u32,
        _cancel: &CancellationToken,
    ) -> Result<ide_plugin::TextSearch, HostError> {
        Err(HostError::Failed("search unavailable".into()))
    }
    /// Problems view reports for this window's project.
    fn problems(&self, _client: &str, _path: Option<&Path>) -> Result<Vec<ide_plugin::FileProblems>, HostError> {
        Ok(Vec::new())
    }

    /// Roots of the open projects.
    fn projects(&self) -> Vec<PathBuf>;
    /// Unsaved text of the open document at `path`.
    fn buffer_text(&self, path: &Path) -> Option<String>;
    /// A window's unsaved text, with the normal project overlay as fallback.
    fn buffer_text_in(&self, _client: Option<&str>, path: &Path) -> Option<String> {
        self.buffer_text(path)
    }
    /// An editor owned by this window.
    fn document_in(&self, _client: &str, path: &Path) -> Option<(u64, String)> {
        self.document(path)
    }
    /// Whether the editor holds changes for `path` that are not on disk yet;
    /// writing such a file would lose them.
    fn buffer_dirty(&self, _path: &Path) -> bool {
        false
    }
    /// Up to `limit` files of the project index below `root` whose root-relative path satisfies
    /// `matches`; `None` when no index covers `root` yet (the caller walks the disk instead).
    fn indexed_files(&self, _root: &Path, _matches: &dyn Fn(&Path) -> bool, _limit: usize) -> Option<Vec<PathBuf>> {
        None
    }
    /// Current index of the project rooted at `root`; never reads disk or calls LSP.
    fn symbols(
        &self,
        _root: &Path,
        _query: &str,
        _limit: usize,
        _cancel: &CancellationToken,
        _deadline: Instant,
    ) -> Result<Vec<ide_plugin::SymbolInfo>, HostError> {
        Err(HostError::NotFound("no project index is available".into()))
    }
    /// Version and text of the open document at `path`.
    fn document(&self, path: &Path) -> Option<(u64, String)>;
    /// Applies `edits` to the open document at `path` if it is still at
    /// `version`, as one change (one undo step in the editor).
    fn apply_edits(&self, path: &Path, version: u64, edits: &[TextEdit]) -> Result<u64, HostError>;
    /// Code from the project may run (git hooks and config on fetch).
    fn trusted(&self, root: &Path) -> bool;
    /// Root of the project open in `window`.
    fn project_of(&self, window: &str) -> Option<PathBuf>;
    /// Windows showing the open project at `root`, the most recently focused first.
    fn project_windows(&self, _root: &Path) -> Vec<String> {
        Vec::new()
    }
    /// Shows `items` as producer `source`'s diagnostics of `path` (replacing earlier ones).
    fn publish_diagnostics(&self, source: &str, path: &Path, items: Vec<ide_core::Diagnostic>)
    -> Result<(), HostError>;
    /// The encoding git content of `path` is read in (the project's file encoding).
    fn vcs_encoding(&self, _path: &Path) -> ide_vcs::TextEncoding {
        encoding_rs::UTF_8.into()
    }
    /// The user's values of `plugin`'s settings: the project's at `root`
    /// (over global), or global.
    fn plugin_settings(&self, _plugin: &str, _root: Option<&Path>) -> serde_json::Map<String, serde_json::Value> {
        serde_json::Map::new()
    }
}

/// Where plugin secrets live (the OS keychain on the desktop). Plugins can
/// only ask whether one is set; values go out only inside `net` requests.
pub trait SecretStore: Send + Sync {
    fn get(&self, plugin: &str, name: &str) -> Option<String>;
    /// Sets, or (`None`) deletes.
    fn set(&self, plugin: &str, name: &str, value: Option<&str>) -> Result<(), String>;
}

/// Fallback [`SecretStore`]: one file per plugin, readable only by the user.
pub struct FileSecretStore {
    pub dir: PathBuf,
}

impl FileSecretStore {
    fn file(&self, plugin: &str) -> PathBuf {
        self.dir.join(plugin).join("secrets.json")
    }

    fn load(&self, plugin: &str) -> BTreeMap<String, String> {
        std::fs::read(self.file(plugin)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
}

impl SecretStore for FileSecretStore {
    fn get(&self, plugin: &str, name: &str) -> Option<String> {
        self.load(plugin).remove(name)
    }

    fn set(&self, plugin: &str, name: &str, value: Option<&str>) -> Result<(), String> {
        let mut map = self.load(plugin);
        match value {
            Some(v) => map.insert(name.to_owned(), v.to_owned()),
            None => map.remove(name),
        };
        let file = self.file(plugin);
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        ide_vfs::create_private_dir(file.parent().expect("has parent")).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(&map).map_err(|e| e.to_string())?;
        replace_entry(&file, &bytes).map_err(|e| e.to_string())
    }
}

/// Largest response body a plugin receives.
const MAX_RESPONSE: usize = 8 << 20;
/// Largest stdout / stderr kept from a process.
const MAX_OUTPUT: usize = 4 << 20;
/// Most processes one plugin keeps running at once.
const MAX_PROCESSES: usize = 8;
/// Most output one stream of a handle holds until the plugin reads it.
const MAX_PENDING: usize = 1 << 20;
/// Most files `find-files` walks before giving up.
const MAX_WALK: usize = 200_000;

/// Runtime for plugin HTTP requests (actor threads block on it).
pub(super) fn net_runtime() -> &'static tokio::runtime::Runtime {
    static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("plugin-net")
            .enable_all()
            .build()
            .expect("plugin network runtime")
    })
}

#[derive(Debug)]
struct RedirectDenied(String);
impl std::fmt::Display for RedirectDenied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} is not granted for this redirect", self.0)
    }
}
impl std::error::Error for RedirectDenied {}

fn network_error(error: reqwest::Error) -> HostError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    while let Some(e) = source {
        if let Some(denied) = e.downcast_ref::<RedirectDenied>() {
            return HostError::Denied(denied.0.clone());
        }
        source = e.source();
    }
    HostError::Failed(error.to_string())
}

fn redirect_capability(from: &reqwest::Url, to: &reqwest::Url) -> Result<Capability, String> {
    if from.scheme() == "https" && to.scheme() == "http" {
        ide_plugin::net_host(to.as_str()).map(Capability::NetHttp)
    } else {
        ide_plugin::net_capability(to.as_str())
    }
}

/// Replaces `{{secret:<name>}}` in `value` with the plugin's secrets.
fn fill_secrets(value: &str, lookup: impl Fn(&str) -> Option<String>) -> Result<String, HostError> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(i) = rest.find("{{secret:") {
        out.push_str(&rest[..i]);
        let after = &rest[i + "{{secret:".len()..];
        let end = after.find("}}").ok_or_else(|| HostError::Invalid("unterminated {{secret:…}}".into()))?;
        let name = &after[..end];
        let secret = lookup(name).ok_or_else(|| HostError::NotFound(format!("secret {name:?} is not set")))?;
        out.push_str(&secret);
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

/// A plugin task shown in the UI.
struct TaskEntry {
    plugin: String,
    cancel: CancellationToken,
    cancelled: bool,
}

/// A question a plugin's call waits on: the user's (a prompt) or a window's.
pub(super) struct PromptEntry {
    pub(super) plugin: String,
    pub(super) client: String,
    pub(super) answer: Waiter,
}

pub(super) enum Waiter {
    Prompt(std::sync::mpsc::SyncSender<Option<Vec<String>>>),
    Commit(std::sync::mpsc::SyncSender<CommitAnswer>),
    Command(std::sync::mpsc::SyncSender<super::CommandAnswer>),
}

/// A process a plugin started and has not released (API 1.3 `process.start`).
/// Two reader threads copy its output into bounded buffers; the handle lives
/// as long as the plugin instance that started it.
struct Proc {
    client: Option<String>,
    state: Mutex<ProcState>,
}

struct ProcState {
    child: Child,
    stdin: Option<ChildStdin>,
    /// What it printed and the plugin hasn't read yet.
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    /// Its exit status once it ended (a code, or -1 when a signal ended it).
    status: Option<i32>,
    /// Reader threads still copying its pipes into the buffers above.
    readers: usize,
}

/// Which pipe a reader thread drains.
#[derive(Clone, Copy)]
enum Stream {
    Out,
    Err,
}

impl Proc {
    /// Copies `pipe` into the matching buffer until it closes, keeping the last
    /// [`MAX_PENDING`] bytes, then notes that the reader finished.
    fn read(self: &Arc<Self>, mut pipe: impl Read + Send + 'static, stream: Stream) {
        self.state.lock().readers += 1;
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8 << 10];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut state = this.state.lock();
                        let out = match stream {
                            Stream::Out => &mut state.stdout,
                            Stream::Err => &mut state.stderr,
                        };
                        out.extend_from_slice(&buf[..n]);
                        let over = out.len().saturating_sub(MAX_PENDING);
                        if over > 0 {
                            out.drain(..over);
                            let continuation = out.iter().take_while(|b| (**b & 0xC0) == 0x80).count();
                            out.drain(..continuation);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            this.state.lock().readers -= 1;
        });
    }

    /// Notes its exit status if it ended (dropping its stdin then).
    fn reap(&self) -> Result<(), HostError> {
        let mut state = self.state.lock();
        if state.status.is_none() {
            match try_wait_process(&mut state.child) {
                Ok(Some(status)) => {
                    state.status = Some(status.code().unwrap_or(-1));
                    state.stdin = None;
                }
                Ok(None) => {}
                Err(e) => return Err(failed(e)),
            }
        }
        Ok(())
    }

    /// Ends it and reaps it, so its status is known right away; killing twice
    /// does nothing.
    fn kill(&self) {
        let mut state = self.state.lock();
        state.stdin = None;
        if state.status.is_none() {
            ide_core::process::kill_tree(&mut state.child);
            if let Ok(status) = state.child.wait() {
                state.status = Some(status.code().unwrap_or(-1));
            }
        }
    }

    /// What it printed since the last call, each stream at most `max` bytes.
    fn chunk(&self, max: usize) -> ProcessChunk {
        let mut state = self.state.lock();
        let eof = state.readers == 0;
        ProcessChunk {
            stdout: take_text(&mut state.stdout, max, eof),
            stderr: take_text(&mut state.stderr, max, eof),
            status: state.status,
        }
    }
}

/// Decodes complete characters within the byte budget, retaining partial UTF-8
/// until the reader gets the rest (or EOF). Even a tiny budget makes progress.
fn take_text(buf: &mut Vec<u8>, max: usize, eof: bool) -> String {
    let limit = max.clamp(1, MAX_PENDING);
    let mut out = String::new();
    let mut consumed = 0;
    while consumed < buf.len() && out.len() < limit {
        let bytes = &buf[consumed..];
        let (valid, invalid) = match std::str::from_utf8(bytes) {
            Ok(text) => (text.len(), None),
            Err(e) => (e.valid_up_to(), Some(e.error_len())),
        };
        let text = std::str::from_utf8(&bytes[..valid]).expect("valid prefix");
        let mut end = text.len().min(limit - out.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == 0 && out.is_empty() && !text.is_empty() {
            end = text.chars().next().unwrap().len_utf8();
        }
        out.push_str(&text[..end]);
        consumed += end;
        if end < valid {
            break;
        }
        match invalid {
            Some(len) if len.is_some() || eof => {
                if !out.is_empty() && out.len() + '\u{fffd}'.len_utf8() > limit {
                    break;
                }
                out.push('\u{fffd}');
                consumed += len.unwrap_or(bytes.len() - valid);
            }
            _ => break,
        }
    }
    buf.drain(..consumed);
    out
}

/// Ends descendants before reaping an exited leader, while its process id is
/// still reserved. Otherwise inherited pipes can keep a completed call waiting.
fn try_wait_process(child: &mut Child) -> std::io::Result<Option<std::process::ExitStatus>> {
    #[cfg(unix)]
    {
        use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};
        let status = waitid(
            WaitId::Pid(Pid::from_child(child)),
            WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
        )?;
        if status.is_none() {
            return Ok(None);
        }
        ide_core::process::kill_tree(child);
        child.try_wait()
    }
    #[cfg(not(unix))]
    {
        let status = child.try_wait()?;
        if status.is_some() {
            ide_core::process::kill_tree(child);
        }
        Ok(status)
    }
}

fn env_name_eq(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    #[cfg(windows)]
    {
        // Use the platform's Command key comparison, including non-ASCII names.
        let mut probe = StdCommand::new("unused");
        probe.env(a, "").env(b, "");
        probe.get_envs().count() == 1
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// Validates against the environment after `prepare`, then freezes that snapshot
/// so only new keys are added, including when the host environment changes later.
fn append_process_env(command: &mut StdCommand, env: &[(String, String)]) -> Result<(), HostError> {
    if env.len() > 64 {
        return Err(HostError::Invalid("at most 64 environment variables".into()));
    }
    let mut inherited: Vec<_> = std::env::vars_os().collect();
    for (key, value) in command.get_envs() {
        inherited.retain(|(k, _)| !env_name_eq(k, key));
        if let Some(value) = value {
            inherited.push((key.to_owned(), value.to_owned()));
        }
    }
    for (key, value) in env {
        if key.is_empty() || key.len() > 256 || key.contains(['=', '\0']) {
            return Err(HostError::Invalid(format!("{key:?} is not an environment variable name")));
        }
        if value.len() > 4096 || value.contains('\0') {
            return Err(HostError::Invalid(format!("the value of {key:?} is too long or holds a NUL")));
        }
        if inherited.iter().any(|(k, _)| env_name_eq(k, std::ffi::OsStr::new(key))) {
            return Err(HostError::Invalid(format!(
                "environment variable {key:?} already exists; only new variables may be added"
            )));
        }
        inherited.push((key.into(), value.into()));
    }
    command.env_clear().envs(inherited);
    Ok(())
}

/// Approved project-specific programs.
pub(super) type ProjectPins = Arc<RwLock<HashMap<(String, String, PathBuf), ProgramPin>>>;

type ContentRequests = BTreeMap<(String, String, String), (String, Instant)>;

type SettingSnapshots = BTreeMap<(Option<String>, String), BTreeMap<String, String>>;

/// State shared by the host and every plugin's [`PluginApi`].
pub(super) struct Shared {
    pub sink: Arc<dyn PluginEventSink>,
    pub workspace: RwLock<Option<Arc<dyn PluginWorkspace>>>,
    /// `<plugins>/.data`: one directory per plugin id.
    pub data_dir: PathBuf,
    tasks: Mutex<HashMap<u64, TaskEntry>>,
    next_task: AtomicU64,
    /// (plugin, handle id) → the processes it started and has not released.
    processes: Mutex<HashMap<(String, u64), Arc<Proc>>>,
    next_process: AtomicU64,
    connections: super::ipc::Connections,
    pub loopbacks: RwLock<Arc<dyn super::auth::Service>>,
    process_shutdowns: Mutex<Vec<std::thread::JoinHandle<()>>>,
    pub(super) prompts: Mutex<HashMap<u64, PromptEntry>>,
    /// Plugins being stopped: their calls may not open new prompts (taken before `prompts`).
    pub(super) prompts_blocked: Mutex<BTreeSet<String>>,
    /// One network question per plugin; refusals throttle all hosts for 30 seconds.
    net_prompts: Mutex<HashMap<String, Option<Instant>>>,
    pub net_hosts_session_only: AtomicBool,
    session_net_hosts: Mutex<HashMap<String, BTreeSet<String>>>,
    pub(super) next_prompt: AtomicU64,
    pub(super) run_configurations: super::run_detectors::DynamicConfigurations,
    pub(super) run_targets: Mutex<super::run_targets::Targets>,
    pub(super) operations: Mutex<BTreeMap<String, super::execution::Operation>>,
    pub(super) content_tabs: Mutex<BTreeMap<(String, String, String), ide_plugin::ContentTab>>,
    pub(super) content_requests: Mutex<ContentRequests>,

    /// (plugin, item id) → item, for windows opened later.
    output: Mutex<BTreeMap<(String, String), String>>,
    decorations: Mutex<BTreeMap<String, Vec<super::DecorationSet>>>,
    status: Mutex<BTreeMap<(String, String), StatusItem>>,
    setting_snapshots: Mutex<SettingSnapshots>,
    window_status: Mutex<BTreeMap<(String, String, String), StatusItem>>,
    /// (scope, plugin, key) → JSON value.
    contexts: Mutex<BTreeMap<ContextKey, String>>,
    pub(super) closed_clients: Mutex<BTreeSet<String>>,
    /// plugin → kinds subscribed at run time (kept across idle reclaim).
    pub subscriptions: Mutex<super::event_paths::Subscriptions>,
    /// plugin → files it shows problems for, withdrawn when it stops.
    diagnostics: Mutex<HashMap<String, BTreeSet<PathBuf>>>,
    pub secrets: RwLock<Arc<dyn SecretStore>>,
    /// (plugin, `process:` capability) → the approved program.
    pub pins: Arc<RwLock<HashMap<(String, String), ProgramPin>>>,
    /// The grant ledger, shared with the [`super::PluginHost`]: `net:ask`
    /// looks up and records "always allow" hosts right where a request runs.
    pub ledger: Arc<Mutex<Ledger>>,
    pub project_pins: ProjectPins,
    pub event_editors: RwLock<HashMap<String, ide_plugin::EditorContext>>,
    /// Validated UI declarations (settings schemas, declared views).
    pub ui: Arc<ide_extension::UiStore>,
    /// Extension points plugins declare and what was contributed to them.
    pub registry: Arc<ide_extension::ExtensionRegistry>,
    /// The UI language the windows report (BCP 47).
    pub locale: RwLock<String>,
    /// (plugin, window) → the log tabs its code opened there, oldest first:
    /// what a tab may run when it starts.
    log_tabs: Mutex<HashMap<(String, String), LogTabs>>,
}

/// A window's log tabs of one plugin: key → what it runs, oldest first.
type LogTabs = Vec<(String, ide_plugin::ServiceLog)>;

/// Log tabs a plugin's code may have open in one window; opening more forgets
/// the oldest (that tab can no longer start its program).
const MAX_LOG_TABS: usize = 32;

impl Shared {
    pub fn new(
        sink: Arc<dyn PluginEventSink>,
        data_dir: PathBuf,
        pins: Arc<RwLock<HashMap<(String, String), ProgramPin>>>,
        ui: Arc<ide_extension::UiStore>,
        ledger: Arc<Mutex<Ledger>>,
        registry: Arc<ide_extension::ExtensionRegistry>,
    ) -> Arc<Self> {
        Arc::new(Self {
            ui,
            registry,
            locale: RwLock::new("en".into()),
            sink,
            workspace: RwLock::new(None),
            secrets: RwLock::new(Arc::new(FileSecretStore { dir: data_dir.clone() })),
            pins,
            ledger,
            project_pins: Arc::default(),
            event_editors: RwLock::default(),
            data_dir,
            tasks: Mutex::default(),
            next_task: AtomicU64::new(1),
            processes: Mutex::default(),
            next_process: AtomicU64::new(1),
            connections: super::ipc::Connections::default(),
            loopbacks: RwLock::new(Arc::new(super::auth::Loopbacks::default())),
            process_shutdowns: Mutex::default(),
            prompts: Mutex::default(),
            prompts_blocked: Mutex::default(),
            net_prompts: Mutex::default(),
            net_hosts_session_only: AtomicBool::new(false),
            session_net_hosts: Mutex::default(),
            next_prompt: AtomicU64::new(1),
            run_configurations: Arc::default(),
            run_targets: Mutex::default(),
            operations: Mutex::default(),
            content_tabs: Mutex::default(),
            content_requests: Mutex::default(),

            status: Mutex::default(),
            output: Mutex::default(),
            decorations: Mutex::default(),
            window_status: Mutex::default(),
            setting_snapshots: Mutex::default(),
            contexts: Mutex::default(),
            closed_clients: Mutex::default(),
            subscriptions: Mutex::default(),
            diagnostics: Mutex::default(),
            log_tabs: Mutex::default(),
        })
    }

    pub(super) fn workspace(&self) -> Option<Arc<dyn PluginWorkspace>> {
        self.workspace.read().clone()
    }

    pub fn project_of(&self, window: &str) -> Option<PathBuf> {
        self.workspace()?.project_of(window)
    }

    /// Shows `plugin`'s problems of `path`, remembering the file until they are
    /// cleared (by the plugin, or when it stops).
    fn publish_diagnostics(
        &self,
        plugin: &str,
        path: &Path,
        items: Vec<ide_core::Diagnostic>,
    ) -> Result<(), HostError> {
        let workspace = self.workspace().ok_or_else(|| HostError::NotFound("no project is open".into()))?;
        let empty = items.is_empty();
        workspace.publish_diagnostics(plugin, path, items)?;
        let mut published = self.diagnostics.lock();
        if empty {
            if let Some(paths) = published.get_mut(plugin) {
                paths.remove(path);
                if paths.is_empty() {
                    published.remove(plugin);
                }
            }
        } else {
            published.entry(plugin.to_owned()).or_default().insert(path.to_path_buf());
        }
        Ok(())
    }

    pub fn status_items(&self) -> Vec<(String, String, StatusItem)> {
        self.status.lock().iter().map(|((p, id), item)| (p.clone(), id.clone(), item.clone())).collect()
    }

    pub fn changed_settings(self: &Arc<Self>, pkg: &Package, client: Option<&str>) -> Vec<String> {
        let root = client.and_then(|c| self.project_of(c));
        let api = PluginApi { pkg: pkg.clone(), shared: self.clone() };
        let mut current = BTreeMap::new();
        for item in self.ui.items(super::ui_points::SETTINGS, Some(pkg.id())) {
            if let Some(properties) = item.decl.get("properties").and_then(|p| p.as_array()) {
                for property in properties {
                    if let Some(key) = property.get("key").and_then(|k| k.as_str())
                        && let Some(value) = api.setting(root.as_deref(), key)
                    {
                        current.insert(key.into(), value);
                    }
                }
            }
        }
        let previous =
            self.setting_snapshots.lock().insert((client.map(str::to_owned), pkg.id().into()), current.clone());
        previous
            .map(|old| current.into_iter().filter(|(k, v)| old.get(k) != Some(v)).map(|(k, _)| k).collect())
            .unwrap_or_default()
    }

    pub fn status_snapshot(&self, client: &str) -> Vec<super::PluginStatusItem> {
        let mut items: Vec<_> = self
            .status_items()
            .into_iter()
            .map(|(plugin_id, id, item)| super::PluginStatusItem { plugin_id, id, item, window: false })
            .collect();
        items.extend(self.window_status.lock().iter().filter(|((w, ..), _)| w == client).map(
            |((_, plugin_id, id), item)| super::PluginStatusItem {
                plugin_id: plugin_id.clone(),
                id: id.clone(),
                item: item.clone(),
                window: true,
            },
        ));
        items
    }

    pub fn context_keys(&self, client: Option<&str>) -> Vec<PluginContextKey> {
        let contexts = self.contexts.lock();
        let mut keys: BTreeMap<(&str, &str), &str> = BTreeMap::new();
        for ((_, plugin, key), value) in contexts.iter().filter(|((s, ..), _)| s.is_none()) {
            keys.insert((plugin, key), value);
        }
        if let Some(client) = client {
            for ((_, plugin, key), value) in contexts.iter().filter(|((s, ..), _)| s.as_deref() == Some(client)) {
                keys.insert((plugin, key), value);
            }
        }
        keys.into_iter()
            .map(|((p, k), v)| PluginContextKey { plugin_id: p.to_owned(), key: k.to_owned(), value: v.to_owned() })
            .collect()
    }

    /// Cancels prompts and drops context keys scoped to window `client` (it closed).
    /// Refuses further writes for it (late commands) until [`Self::reopen_client`].
    pub fn forget_client(&self, client: &str) {
        let mut closed = self.closed_clients.lock();
        closed.insert(client.to_owned());
        self.prompts.lock().retain(|_, entry| entry.client != client);
        drop(closed);
        self.contexts.lock().retain(|(scope, ..), _| scope.as_deref() != Some(client));
        self.loopbacks.read().forget_window(client);
        self.window_status.lock().retain(|(window, ..), _| window != client);
        self.operations.lock().retain(|_, op| op.client != client);
        self.content_tabs.lock().retain(|(_, window, _), _| window != client);
        self.content_requests.lock().retain(|(_, window, _), _| window != client);
        self.event_editors.write().remove(client);
        self.setting_snapshots.lock().retain(|(window, _), _| window.as_deref() != Some(client));
        let mine: Vec<_> = {
            let mut processes = self.processes.lock();
            let keys: Vec<_> = processes
                .iter()
                .filter(|(_, p)| p.client.as_deref() == Some(client))
                .map(|(key, _)| key.clone())
                .collect();
            keys.iter().filter_map(|key| processes.remove(key)).collect()
        };
        if !mine.is_empty() {
            // Window destruction runs on the UI thread; tree shutdown may wait.
            let worker = std::thread::spawn(move || {
                for proc in mine {
                    proc.kill();
                }
            });
            let mut workers = self.process_shutdowns.lock();
            workers.retain(|worker| !worker.is_finished());
            workers.push(worker);
        }
    }

    pub fn finish_process_shutdowns(&self) {
        let workers = std::mem::take(&mut *self.process_shutdowns.lock());
        for worker in workers {
            let _ = worker.join();
        }
    }

    /// A window labelled `client` is being created (labels are reused after a close).
    pub fn reopen_client(&self, client: &str) {
        self.closed_clients.lock().remove(client);
    }

    /// What the log tab `key` that `plugin`'s code opened in `window` runs.
    pub fn log_tab(&self, plugin: &str, window: &str, key: &str) -> Option<ide_plugin::ServiceLog> {
        let tabs = self.log_tabs.lock();
        let tabs = tabs.get(&(plugin.to_owned(), window.to_owned()))?;
        tabs.iter().find(|(k, _)| k == key).map(|(_, log)| log.clone())
    }

    /// Forgets the log tabs of a closed window, or of a stopped plugin.
    pub fn forget_log_tabs(&self, plugin: Option<&str>, window: Option<&str>) {
        self.log_tabs
            .lock()
            .retain(|(p, w), _| plugin.is_some_and(|plugin| plugin != p) || window.is_some_and(|window| window != w));
    }

    pub fn client_closed(&self, client: &str) -> bool {
        self.closed_clients.lock().contains(client)
    }

    /// Withdraws a plugin's run-time state (it stopped or failed). Its
    /// subscriptions go only with `subscriptions`, as they survive restarts.
    pub fn clear_plugin(&self, plugin: &str, subscriptions: bool) {
        self.withdraw_run_targets(Some(plugin), None);
        self.run_configurations.write().retain(|(p, _), _| p != plugin);
        self.operations.lock().retain(|_, op| op.plugin != plugin);
        self.content_tabs.lock().retain(|(p, _, _), _| p != plugin);
        self.content_requests.lock().retain(|(p, _, _), _| p != plugin);

        self.kill_processes(plugin);
        self.connections.clear(plugin);
        self.setting_snapshots.lock().retain(|(_, p), _| p != plugin);
        let channels: Vec<_> = {
            let mut output = self.output.lock();
            let keys: Vec<_> = output.keys().filter(|(p, _)| p == plugin).cloned().collect();
            for key in &keys {
                output.remove(key);
            }
            keys
        };
        for (_, channel) in channels {
            self.sink.emit(None, PluginEvent::OutputChanged { plugin_id: plugin.into(), channel, text: None });
        }

        self.loopbacks.read().clear(plugin);
        let removed: Vec<String> = {
            let mut status = self.status.lock();
            let ids: Vec<String> = status.keys().filter(|(p, _)| p == plugin).map(|(_, id)| id.clone()).collect();
            for id in &ids {
                status.remove(&(plugin.to_owned(), id.clone()));
            }
            ids
        };
        for id in removed {
            self.sink.emit(None, PluginEvent::StatusItemChanged { plugin_id: plugin.to_owned(), id, item: None });
        }
        let removed: Vec<_> = {
            let mut items = self.window_status.lock();
            let keys: Vec<_> = items.keys().filter(|(_, p, _)| p == plugin).cloned().collect();
            for key in &keys {
                items.remove(key);
            }
            keys
        };
        for (window, _, id) in removed {
            self.sink
                .emit(Some(&window), PluginEvent::WindowStatusItemChanged { plugin_id: plugin.into(), id, item: None });
        }
        if self.decorations.lock().remove(plugin).is_some() {
            self.sink.emit(None, PluginEvent::DecorationsChanged { plugin_id: plugin.into(), sets: Vec::new() });
        }
        self.withdraw_prompts(plugin);
        self.net_prompts.lock().remove(plugin);
        self.session_net_hosts.lock().remove(plugin);
        let removed: Vec<(Option<String>, String)> = {
            let mut contexts = self.contexts.lock();
            let keys: Vec<_> = contexts.keys().filter(|(_, p, _)| p == plugin).cloned().collect();
            for key in &keys {
                contexts.remove(key);
            }
            keys.into_iter().map(|(scope, _, key)| (scope, key)).collect()
        };
        for (scope, key) in removed {
            self.sink
                .emit(scope.as_deref(), PluginEvent::ContextChanged { plugin_id: plugin.to_owned(), key, value: None });
        }
        let tasks: Vec<u64> = self.tasks.lock().iter().filter(|(_, t)| t.plugin == plugin).map(|(id, _)| *id).collect();
        for id in tasks {
            self.end_task(id);
        }
        // Its problems go with it (an idle reclaim keeps them: it isn't cleared then).
        let paths = self.diagnostics.lock().remove(plugin).unwrap_or_default();
        if let Some(workspace) = self.workspace() {
            for path in paths {
                let _ = workspace.publish_diagnostics(plugin, &path, Vec::new());
            }
        }
        if subscriptions && self.subscriptions.lock().remove(plugin) {
            self.sink.emit(None, PluginEvent::SubscriptionsChanged);
        }
    }

    /// Ends every process `plugin` started: its handles go with its instance
    /// (it stopped, was disabled, or was reclaimed while idle).
    pub fn kill_processes(&self, plugin: &str) {
        let mine: Vec<Arc<Proc>> = {
            let mut processes = self.processes.lock();
            let keys: Vec<(String, u64)> = processes.keys().filter(|(p, _)| p == plugin).cloned().collect();
            keys.iter().filter_map(|k| processes.remove(k)).collect()
        };
        for proc in mine {
            proc.kill();
        }
    }

    /// The user cancelled a task in the UI.
    pub fn cancel_task(&self, id: u64) -> bool {
        let mut tasks = self.tasks.lock();
        let Some(t) = tasks.get_mut(&id) else { return false };
        t.cancelled = true;
        t.cancel.cancel();
        true
    }

    /// Closes the prompts `plugin` waits on: the calls waiting for the user
    /// wake up cancelled (dropping the senders).
    fn withdraw_prompts(&self, plugin: &str) {
        let ids: Vec<u64> = {
            let mut prompts = self.prompts.lock();
            let ids: Vec<u64> = prompts.iter().filter(|(_, p)| p.plugin == plugin).map(|(id, _)| *id).collect();
            for id in &ids {
                prompts.remove(id);
            }
            ids
        };
        for id in ids {
            self.sink.emit(None, PluginEvent::PromptClosed { prompt_id: id.to_string() });
        }
    }

    /// `plugin` is about to be stopped: withdraws its prompts, and its queued
    /// calls can't open new ones (they'd keep the stop waiting) until
    /// [`allow_prompts`](Self::allow_prompts).
    pub fn block_prompts(&self, plugin: &str) {
        self.prompts_blocked.lock().insert(plugin.to_owned());
        self.withdraw_prompts(plugin);
    }

    pub fn allow_prompts(&self, plugin: &str) {
        self.prompts_blocked.lock().remove(plugin);
    }

    /// The user answered (`Some`) or dismissed (`None`) a prompt.
    pub fn answer_prompt(&self, id: u64, answer: Option<Vec<String>>) -> bool {
        let mut prompts = self.prompts.lock();
        if !matches!(prompts.get(&id), Some(PromptEntry { answer: Waiter::Prompt(_), .. })) {
            return false;
        }
        let Some(PromptEntry { answer: Waiter::Prompt(tx), .. }) = prompts.remove(&id) else { return false };
        tx.send(answer).is_ok()
    }

    /// A window answered a [`CommitRequest`].
    pub fn answer_command(&self, client: &str, id: u64, answer: super::CommandAnswer) -> bool {
        let mut prompts = self.prompts.lock();
        if !matches!(prompts.get(&id), Some(PromptEntry { client: window, answer: Waiter::Command(_), .. }) if window == client)
        {
            return false;
        }
        let Some(PromptEntry { answer: Waiter::Command(tx), .. }) = prompts.remove(&id) else { return false };
        tx.try_send(answer).is_ok()
    }

    pub fn answer_commit(&self, id: u64, answer: CommitAnswer) -> bool {
        let mut prompts = self.prompts.lock();
        if !matches!(prompts.get(&id), Some(PromptEntry { answer: Waiter::Commit(_), .. })) {
            return false;
        }
        let Some(PromptEntry { answer: Waiter::Commit(tx), .. }) = prompts.remove(&id) else { return false };
        tx.send(answer).is_ok()
    }

    fn end_task(&self, id: u64) {
        if let Some(t) = self.tasks.lock().remove(&id) {
            self.sink.emit(None, PluginEvent::TaskEnded { plugin_id: t.plugin, task_id: id.to_string() });
        }
    }

    /// The plugin's stored values: one file per key, so a write only
    /// rewrites its own value.
    pub fn storage_dir(&self, plugin: &str) -> PathBuf {
        self.data_dir.join(plugin).join("storage")
    }
}

fn storage_io(e: std::io::Error) -> HostError {
    HostError::Failed(format!("storage: {e}"))
}

fn replace_entry(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut tmp =
        tempfile::Builder::new().prefix(".entry-").suffix(".tmp").tempfile_in(path.parent().expect("has parent"))?;
    tmp.write_all(bytes)?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// A key's file name: its hash, since keys may hold any character.
fn entry_name(key: &str) -> String {
    blake3::hash(key.as_bytes()).to_hex().to_string()
}

/// A stored entry: the key's length (2 bytes, little-endian), the key, then the value.
fn decode_entry(bytes: &[u8]) -> Option<(&str, &str)> {
    let len = usize::from(u16::from_le_bytes(bytes.get(..2)?.try_into().ok()?));
    let key = std::str::from_utf8(bytes.get(2..2 + len)?).ok()?;
    let value = std::str::from_utf8(&bytes[2 + len..]).ok()?;
    Some((key, value))
}

fn write_entry(dir: &Path, key: &str, value: &str) -> Result<(), HostError> {
    std::fs::create_dir_all(dir).map_err(storage_io)?;
    let file = dir.join(entry_name(key));
    let len = u16::try_from(key.len()).expect("keys are at most MAX_KEY bytes");
    let mut bytes = Vec::with_capacity(2 + key.len() + value.len());
    bytes.extend_from_slice(&len.to_le_bytes());
    bytes.extend_from_slice(key.as_bytes());
    bytes.extend_from_slice(value.as_bytes());
    replace_entry(&file, &bytes).map_err(storage_io)
}

/// The stored entries' files and the bytes of their keys and values.
fn entries(dir: &Path) -> Result<impl Iterator<Item = (PathBuf, usize)>, HostError> {
    let list = match std::fs::read_dir(dir) {
        Ok(list) => list,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new().into_iter()),
        Err(e) => return Err(storage_io(e)),
    };
    let mut out = Vec::new();
    for entry in list {
        let entry = entry.map_err(storage_io)?;
        let path = entry.path();
        if path.extension().is_some() {
            continue; // a write that didn't finish
        }
        let size = entry.metadata().map_err(storage_io)?.len();
        out.push((path, usize::try_from(size).unwrap_or(usize::MAX).saturating_sub(2)));
    }
    Ok(out.into_iter())
}

pub(super) struct PluginApi {
    pub pkg: Package,
    pub shared: Arc<Shared>,
}

impl PluginApi {
    fn id(&self) -> &str {
        self.pkg.id()
    }

    /// The storage directory, after moving a `storage.json` written by an
    /// older version into it.
    fn storage(&self) -> Result<PathBuf, HostError> {
        let dir = self.shared.storage_dir(self.id());
        std::fs::create_dir_all(&self.shared.data_dir).map_err(storage_io)?;
        ide_vfs::create_private_dir(dir.parent().expect("has parent")).map_err(failed)?;
        ide_vfs::create_private_dir(&dir).map_err(failed)?;
        let legacy = self.shared.data_dir.join(self.id()).join("storage.json");
        match std::fs::read(&legacy) {
            Ok(bytes) => {
                let map: BTreeMap<String, String> =
                    serde_json::from_slice(&bytes).map_err(|e| HostError::Failed(format!("storage: {e}")))?;
                for (key, value) in &map {
                    write_entry(&dir, key, value)?;
                }
                std::fs::remove_file(&legacy).map_err(storage_io)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(storage_io(e)),
        }
        Ok(dir)
    }

    /// The program approved for the (already checked) `process:` grant,
    /// verified right before it starts.
    #[cfg(test)]
    fn approved_program(&self, program: &str) -> Result<PathBuf, HostError> {
        self.approved_program_in_project(program, None)
    }

    pub(super) fn approved_program_in_project(&self, program: &str, root: Option<&Path>) -> Result<PathBuf, HostError> {
        if let Some(pin) = root.and_then(|root| {
            self.shared.project_pins.read().get(&(self.id().into(), format!("process:{program}"), root.into())).cloned()
        }) {
            return pin.verify().map(Path::to_path_buf).map_err(|e| HostError::Denied(e.to_string()));
        }
        let cap = format!("process:{program}");
        // Granted without a pinned file: the program wasn't found when it was
        // allowed, and installing it later approves nothing by itself.
        let pin = self.shared.pins.read().get(&(self.id().to_owned(), cap.clone())).cloned().ok_or_else(|| {
            HostError::Failed(format!(
                "{cap}: `{program}` was not found on PATH when this permission was allowed. \
                 Restarting doesn't approve a program installed later: once `{program}` is on PATH, \
                 clear {cap} in Settings › Plugins and select it again"
            ))
        })?;
        pin.verify().map(Path::to_path_buf).map_err(|e| HostError::Denied(format!("{cap}: {e}")))
    }
}

impl PluginApi {
    /// Runs an approved program until it exits or `cancel` fires, passing
    /// each output line to `on_line`; returns its exit code.
    pub(super) fn stream_process(
        &self,
        program: &str,
        args: Vec<String>,
        cwd: Option<&Path>,
        cancel: &CancellationToken,
        on_line: &dyn Fn(super::PluginOutputLine),
    ) -> Result<Option<i32>, HostError> {
        let binary = self.approved_program_in_project(program, cwd)?;
        let cwd = cwd.map(Path::to_path_buf).unwrap_or_else(|| self.shared.data_dir.join(self.id()));
        let _ = std::fs::create_dir_all(&cwd);
        let mut cmd = std::process::Command::new(&binary);
        ide_core::process::prepare(ide_core::process::own_group(&mut cmd));
        let mut child = cmd
            .args(&args)
            .current_dir(&cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| HostError::Failed(format!("{}: {e}", binary.display())))?;
        // Bounded: a program printing faster than the lines are sent waits on its pipe.
        let (tx, rx) = std::sync::mpsc::sync_channel(1024);
        let read = |pipe: Box<dyn std::io::Read + Send>, stderr: bool| {
            let tx = tx.clone();
            std::thread::spawn(move || {
                read_lines(pipe, MAX_OUTPUT_LINE, &mut |text| {
                    tx.send(super::PluginOutputLine { stderr, text }).is_ok()
                });
            });
        };
        if let Some(out) = child.stdout.take() {
            read(Box::new(out), false);
        }
        if let Some(err) = child.stderr.take() {
            read(Box::new(err), true);
        }
        drop(tx);
        // Revoking the grant removes the pin: stop then.
        let cap = format!("process:{program}");
        let pin = (self.id().to_owned(), cap.clone());
        let stop = |child: &mut std::process::Child| -> Option<HostError> {
            if cancel.is_cancelled() {
                kill_group(child);
                return Some(HostError::Cancelled);
            }
            if !self.shared.pins.read().contains_key(&pin) {
                kill_group(child);
                return Some(HostError::Denied(cap.clone()));
            }
            None
        };
        loop {
            if let Some(e) = stop(&mut child) {
                return Err(e);
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => on_line(line),
                // Both pipes closed: the program is done (or detached them).
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        loop {
            if let Some(status) = child.try_wait().map_err(failed)? {
                return Ok(status.code());
            }
            if let Some(e) = stop(&mut child) {
                return Err(e);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Longest output line a followed program sends; the rest of the line is dropped.
const MAX_OUTPUT_LINE: usize = 16 << 10;

/// Passes `pipe`'s lines (without `\r\n`, at most `max` bytes each) to `line`
/// until it returns false or the pipe closes, holding at most one line.
fn read_lines(pipe: Box<dyn std::io::Read + Send>, max: usize, line: &mut dyn FnMut(String) -> bool) {
    use std::io::{BufRead, Read};
    let mut reader = std::io::BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match (&mut reader).take(max as u64).read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if buf.last() != Some(&b'\n') && buf.len() == max {
            // Too long: skip to the end of the line.
            let mut rest = Vec::new();
            loop {
                rest.clear();
                match (&mut reader).take(max as u64).read_until(b'\n', &mut rest) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if rest.last() == Some(&b'\n') => break,
                    Ok(_) => {}
                }
            }
        }
        let end = buf.strip_suffix(b"\n").unwrap_or(&buf);
        let end = end.strip_suffix(b"\r").unwrap_or(end);
        if !line(String::from_utf8_lossy(end).into_owned()) {
            return;
        }
    }
}

/// Kills a program spawned in its own group and what it started. A kill that
/// lands while the program forks can miss the new process, so the group is
/// signalled again before the program is reaped (until then its group id
/// can't be reused).
fn kill_group(child: &mut std::process::Child) {
    ide_core::process::kill_tree_of(child.id());
    std::thread::sleep(Duration::from_millis(50));
    ide_core::process::kill_tree(child);
}

impl PluginApi {
    /// Sends `request` to `client`'s window and waits for its answer, until
    /// `cancel` fires, the plugin stops or `timeout` passes.
    fn ask_commit(
        &self,
        client: &str,
        request: CommitRequest,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<CommitAnswer, HostError> {
        let id = self.shared.next_prompt.fetch_add(1, Ordering::Relaxed);
        let (answer, answers) = std::sync::mpsc::sync_channel(1);
        {
            let closed = self.shared.closed_clients.lock();
            if closed.contains(client) {
                return Err(HostError::Cancelled);
            }
            let blocked = self.shared.prompts_blocked.lock();
            if blocked.contains(self.id()) {
                return Err(HostError::Cancelled);
            }
            self.shared.prompts.lock().insert(
                id,
                PromptEntry { plugin: self.id().to_owned(), client: client.to_owned(), answer: Waiter::Commit(answer) },
            );
        }
        let request_id = id.to_string();
        self.shared.sink.emit(
            Some(client),
            PluginEvent::CommitRequested { plugin_id: self.id().to_owned(), request_id: request_id.clone(), request },
        );
        let deadline = Instant::now() + timeout;
        loop {
            match answers.recv_timeout(Duration::from_millis(100)) {
                Ok(answer) => return Ok(answer),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                    if !cancel.is_cancelled() && Instant::now() < deadline => {}
                Err(e) => {
                    self.shared.prompts.lock().remove(&id);
                    self.shared.sink.emit(Some(client), PluginEvent::PromptClosed { prompt_id: request_id });
                    return Err(match e {
                        std::sync::mpsc::RecvTimeoutError::Timeout if !cancel.is_cancelled() => {
                            HostError::Failed("the window did not answer".into())
                        }
                        _ => HostError::Cancelled,
                    });
                }
            }
        }
    }
    /// Where `cmd` runs: the project root it names, else the plugin's data
    /// directory (created as needed).
    fn spawn_dir(&self, cwd: Option<&Path>) -> PathBuf {
        let dir = cwd.map(Path::to_path_buf).unwrap_or_else(|| self.shared.data_dir.join(self.id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    /// The process handle `id`, if this plugin started it and it is still open.
    fn process(&self, id: u64) -> Result<Arc<Proc>, HostError> {
        self.shared
            .processes
            .lock()
            .get(&(self.id().to_owned(), id))
            .cloned()
            .ok_or_else(|| HostError::NotFound(format!("no process {id}: it was closed, or belongs to another plugin")))
    }
}

/// The changes `selection` commits, diffed repository by repository.
pub(super) fn commit_draft(
    workspace: &dyn PluginWorkspace,
    selection: CommitSelection,
    cancel: &CancellationToken,
) -> Result<CommitDraft, HostError> {
    let mut changes = Vec::new();
    let mut budget = MAX_COMMIT_DIFF;
    for repo in &selection.repositories {
        if cancel.is_cancelled() {
            return Err(HostError::Cancelled);
        }
        let Some(r) = ide_vcs::Repo::discover(&repo.root.0).map_err(failed)? else {
            return Err(HostError::NotFound(format!("{} is not in a git repository", repo.root.0.display())));
        };
        let pending = r.pending_changes(&repo.options, budget, &|path| Ok(workspace.vcs_encoding(path))).map_err(
            |e| match e.kind {
                ide_core::error::ErrorKind::InvalidInput => HostError::Invalid(e.message),
                _ => HostError::Failed(e.message),
            },
        )?;
        let root = to_ipc(r.root());
        for c in pending {
            budget -= c.diff.as_ref().map_or(0, String::len).min(budget);
            changes.push(CommitChange {
                repository: root.clone(),
                path: to_ipc(&c.path),
                old_path: c.old_path.as_deref().map(to_ipc),
                status: c.status.to_owned(),
                diff: c.diff,
                truncated: c.truncated,
            });
        }
    }
    Ok(CommitDraft { revision: selection.revision, message: selection.message, amend: selection.amend, changes })
}

fn failed(e: impl std::fmt::Display) -> HostError {
    HostError::Failed(e.to_string())
}

impl HostApi for PluginApi {
    fn database_upsert(&self, root: &Path, source: ide_plugin::PluginDataSource) -> Result<(), HostError> {
        let (host, db) = self.database_host(root)?;
        let id = source.id.clone();
        let source = super::database::settings(source)?;
        self.remember_database_project(root, &id)?;
        host.runtime.block_on(db.upsert_plugin_source(self.pkg.id(), &id, source)).map_err(super::database::error)?;
        let internal = ide_db::plugin::source_id(self.pkg.id(), &id);
        for project in host.projects().into_iter().filter(|p| p.root == root) {
            host.runtime.block_on(project.db.disconnect_source(&internal));
        }
        super::database::changed(&host, root);
        Ok(())
    }
    fn database_remove(&self, root: &Path, id: &str) -> Result<(), HostError> {
        let (host, db) = self.database_host(root)?;
        host.runtime.block_on(db.remove_plugin_source(self.pkg.id(), id)).map_err(super::database::error)?;
        let internal = ide_db::plugin::source_id(self.pkg.id(), id);
        for project in host.projects().into_iter().filter(|p| p.root == root) {
            host.runtime.block_on(project.db.forget_plugin_source(&internal));
        }
        super::database::changed(&host, root);
        Ok(())
    }
    fn database_sources(&self, root: &Path) -> Result<Vec<String>, HostError> {
        let (_, db) = self.database_host(root)?;
        db.plugin_sources(self.pkg.id()).map_err(super::database::error)
    }
    fn database_credential(&self, root: &Path, id: &str, password: String) -> Result<(), HostError> {
        let (host, db) = self.database_host(root)?;
        let source = db.plugin_source(self.pkg.id(), id).map_err(super::database::error)?;
        self.remember_database_project(root, id)?;
        for project in host.projects().into_iter().filter(|p| p.root == root) {
            host.runtime.block_on(project.db.set_password(&source.id, Some(password.clone()), true)).map_err(failed)?;
        }
        Ok(())
    }
    fn database_connect(
        &self,
        root: &Path,
        client: &str,
        id: &str,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<(), HostError> {
        self.connect_database(root, client, id, cancel, timeout)
    }
    fn mcp_stdio_command(&self, client: &str) -> Option<Vec<String>> {
        let host = self.shared.workspace()?.database_host()?;
        let root = host.project(client).ok()?.root.clone();
        host.mcp_executable.read().as_ref().map(|exe| ide_mcp::stdio_command(exe, &root))
    }

    fn extension_contributions(&self, point: &str) -> Result<Vec<(String, String)>, HostError> {
        self.require_api("extension points", 5)?;
        match self.shared.registry.point_owner(point) {
            None => Err(HostError::NotFound(format!("no running plugin declares {point}"))),
            Some(owner) if owner != self.id() => Err(HostError::Denied(format!("extension point {point}"))),
            Some(_) => Ok(self
                .shared
                .registry
                .contributions_to(point)
                .into_iter()
                .map(|c| (c.plugin, c.data.to_string()))
                .collect()),
        }
    }

    fn register_run_target(&self, root: &Path, target: ide_plugin::PluginRunTarget) -> Result<(), HostError> {
        self.register_target(root, target)
    }
    fn unregister_run_target(&self, root: &Path, id: &str) {
        self.unregister_target(root, id);
    }

    fn start_run(
        &self,
        client: &str,
        config: &str,
        args: Vec<String>,
        debug: bool,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<String, HostError> {
        let _ = timeout;
        if cancel.is_cancelled() {
            return Err(HostError::Cancelled);
        }
        let mut run =
            self.shared.workspace().ok_or(HostError::Cancelled)?.run_configuration(client, self.id(), config)?;
        let binary = self.approved_program_in_project(&run.command, self.shared.project_of(client).as_deref())?;
        if debug && run.debug_adapter.is_none() {
            return Err(HostError::Invalid("this configuration has no debugger".into()));
        }
        let program = run.command.clone();
        if debug && run.extras.target.as_ref().is_some_and(|t| !t.is_empty()) {
            return Err(HostError::Invalid("debugging this target is not supported".into()));
        }
        if debug {
            run.command = binary.to_string_lossy().into_owned();
        }
        run.args.extend(args);
        let id = self.new_operation(
            client,
            super::execution::OperationKind::Run { config: config.into(), configuration: run.id.clone(), program },
        )?;
        run.extras.params.insert(super::execution::RUN_OPERATION.into(), id.clone());
        let request = super::WindowRequest::Run { operation: id.clone(), config: Box::new(run), debug };
        self.shared.sink.emit(
            Some(client),
            PluginEvent::WindowRequest { plugin_id: self.id().into(), request_id: String::new(), request },
        );
        Ok(id)
    }
    fn open_terminal_session(
        &self,
        client: &str,
        key: String,
        title: String,
        cmd: ProcessCommand,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<String, HostError> {
        super::execution::label(&key, 128)?;
        super::execution::label(&title, 256)?;
        let root =
            self.shared.project_of(client).ok_or_else(|| HostError::Invalid("no project in this window".into()))?;
        if !self.shared.workspace().is_some_and(|w| w.trusted(&root)) {
            return Err(HostError::Denied("project is not trusted".into()));
        }
        let binary = self.approved_program_in_project(&cmd.program, Some(&root))?;
        let mut command = StdCommand::new(&binary);
        append_process_env(&mut command, &cmd.env)?;
        if cmd.args.iter().any(|a| a.contains('\0')) {
            return Err(HostError::Invalid("NUL in terminal argument".into()));
        }
        let existing = self
            .shared
            .operations
            .lock()
            .iter()
            .find(|(_, op)| {
                op.plugin == self.id()
                    && op.client == client
                    && matches!(&op.kind, super::execution::OperationKind::Terminal { key: k, .. } if k == &key)
            })
            .map(|(id, _)| id.clone());
        let id = match existing {
            Some(id) => id,
            None => self.new_operation(
                client,
                super::execution::OperationKind::Terminal { key: key.clone(), command: cmd.clone() },
            )?,
        };
        let request = super::WindowRequest::Terminal {
            operation: id.clone(),
            key,
            title,
            program: binary.into(),
            args: cmd.args,
            env: cmd.env.into_iter().collect(),
            cwd: root.into(),
        };
        if let Err(error) = self.window_request(client, request, cancel, timeout) {
            self.shared.operations.lock().remove(&id);
            return Err(error);
        }
        Ok(id)
    }
    fn write_terminal(
        &self,
        client: &str,
        key: &str,
        text: String,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<(), HostError> {
        let root = self.shared.project_of(client).ok_or(HostError::Cancelled)?;
        if !self.shared.workspace().is_some_and(|w| w.trusted(&root)) {
            return Err(HostError::Denied("project is not trusted".into()));
        }
        let _ = timeout;
        if cancel.is_cancelled() {
            return Err(HostError::Cancelled);
        }
        let terminal = self
            .shared
            .operations
            .lock()
            .iter()
            .find(|(_, op)| {
                op.plugin == self.id()
                    && op.client == client
                    && op.root.as_ref() == Some(&root)
                    && matches!(&op.kind, super::execution::OperationKind::Terminal { key: k, .. } if k == key)
            })
            .and_then(|(_, op)| op.terminal.clone())
            .ok_or_else(|| HostError::NotFound("no running terminal with this key".into()))?;
        let (host, id) = terminal;
        host.upgrade().ok_or(HostError::Cancelled)?.terminals.write(id, &text).map_err(failed)
    }

    fn open_content_tab(
        &self,
        client: &str,
        tab: ide_plugin::ContentTab,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<(), HostError> {
        super::execution::validate_tab(&tab)?;
        let mut tabs = self.shared.content_tabs.lock();
        let key = (self.id().into(), client.into(), tab.key.clone());
        if !tabs.contains_key(&key) && tabs.keys().filter(|(p, w, _)| p == self.id() && w == client).count() >= 32 {
            return Err(HostError::Invalid("at most 32 content tabs".into()));
        }
        let previous = tabs.insert(key.clone(), tab.clone());
        drop(tabs);
        if let Err(error) = self.window_request(client, super::WindowRequest::ContentTab { tab }, cancel, timeout) {
            let mut tabs = self.shared.content_tabs.lock();
            if let Some(previous) = previous {
                tabs.insert(key, previous);
            } else {
                tabs.remove(&key);
            }
            return Err(error);
        }
        Ok(())
    }
    fn reply_content_tab(
        &self,
        client: &str,
        request: &str,
        reply: ide_plugin::ContentTabReply,
    ) -> Result<(), HostError> {
        super::execution::validate_reply(&reply)?;
        if self.shared.content_requests.lock().remove(&(self.id().into(), client.into(), request.into())).is_none() {
            return Err(HostError::NotFound("unknown content action request".into()));
        }
        self.shared.sink.emit(
            Some(client),
            PluginEvent::ContentTabReply { plugin_id: self.id().into(), request_id: request.into(), reply },
        );
        Ok(())
    }

    fn owns_command(&self, id: &str) -> bool {
        let commands = self.shared.ui.items(super::COMMANDS, None);
        let mut matches = commands.iter().filter(|c| id == format!("plugin.{}.{}", c.plugin_id, c.key)).peekable();
        matches.peek().is_some() && matches.all(|c| c.plugin_id == self.id())
    }

    fn open_editors(&self, client: &str) -> Result<Vec<ide_plugin::OpenEditor>, HostError> {
        self.shared.workspace().ok_or_else(|| HostError::NotFound("window project".into()))?.open_editors(client)
    }
    fn editor_open(&self, client: &str, path: &Path, selection: Option<ide_core::Range>) -> Result<(), HostError> {
        self.shared.sink.emit(Some(client), PluginEvent::EditorOpen { path: path.into(), selection });
        Ok(())
    }
    fn editor_ranges(
        &self,
        client: &str,
        path: &Path,
        ranges: Vec<ide_core::Range>,
        reveal: bool,
    ) -> Result<(), HostError> {
        let workspace = self.shared.workspace().ok_or_else(|| HostError::NotFound("window project".into()))?;
        if !workspace.open_editors(client)?.iter().any(|e| Path::new(&e.path) == path) {
            return Err(HostError::Invalid("editor does not belong to the invoking window".into()));
        }
        let (_, text) =
            workspace.document_in(client, path).ok_or_else(|| HostError::NotFound("editor is closed".into()))?;
        let document = ide_text::Document::new(&text);
        for r in &ranges {
            if !valid_range(&document, *r) {
                return Err(HostError::Invalid("range outside document".into()));
            }
        }
        self.shared.sink.emit(Some(client), PluginEvent::EditorRanges { path: path.into(), ranges, reveal });
        Ok(())
    }
    fn search_text(
        &self,
        client: Option<&str>,
        root: &Path,
        query: ide_plugin::TextQuery,
        limit: u32,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<ide_plugin::TextSearch, HostError> {
        let workspace = self.shared.workspace().ok_or_else(|| HostError::NotFound("project closed".into()))?;
        if query.pattern.len() > 16_384 || query.include.len() + query.exclude.len() > 256 {
            return Err(HostError::Invalid("search query too large".into()));
        }
        let token = cancel.child_token();
        let timed = token.clone();
        let (done, wait) = std::sync::mpsc::channel();
        let timer = std::thread::spawn(move || {
            if wait.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_err() {
                timed.cancel();
            }
        });
        let result = workspace.search_text(client, root, query, limit.min(10_000), &token);
        let _ = done.send(());
        let _ = timer.join();
        if cancel.is_cancelled() {
            Err(HostError::Cancelled)
        } else if Instant::now() >= deadline {
            Err(HostError::Failed("text search timed out".into()))
        } else {
            result
        }
    }
    fn problems(&self, client: &str, path: Option<&Path>) -> Result<Vec<ide_plugin::FileProblems>, HostError> {
        self.shared.workspace().ok_or_else(|| HostError::NotFound("window project".into()))?.problems(client, path)
    }
    fn decorations(&self, path: Option<&Path>, set: &str, items: Vec<ide_plugin::Decoration>) -> Result<(), HostError> {
        self.set_decorations(path, set, items, None, false)
    }
    fn file_decorations(
        &self,
        path: Option<&Path>,
        set: &str,
        item: Option<ide_plugin::FileDecoration>,
    ) -> Result<(), HostError> {
        self.set_decorations(path, set, Vec::new(), item, true)
    }
    fn vcs_log(
        &self,
        root: &Path,
        path: Option<&str>,
        limit: u32,
        cancel: &CancellationToken,
    ) -> Result<Vec<ide_plugin::CommitInfo>, HostError> {
        let repo = self.read_repo(root)?;
        let path = path
            .map(|p| ide_plugin::resolve_new_in_root(root, p).map(ide_core::IpcPath::from).map_err(HostError::Invalid))
            .transpose()?;
        let Some(repo) = repo else {
            return Ok(Vec::new());
        };
        if limit == 0 {
            return Ok(Vec::new());
        }
        let query = ide_vcs::LogQuery { path, limit: limit.min(1000), ..Default::default() };
        repo.log_cancellable(&query, cancel)
            .map(|cs| {
                cs.into_iter()
                    .map(|c| ide_plugin::CommitInfo {
                        id: c.id,
                        short_id: c.short_id,
                        author: c.author,
                        author_email: c.email,
                        date: (c.time_ms / 1000.0) as i64,
                        subject: c.summary,
                        body: c
                            .message
                            .split_once('\n')
                            .map_or(String::new(), |(_, body)| body.trim_start_matches('\n').into()),
                        parents: c.parents,
                    })
                    .collect()
            })
            .map_err(failed)
    }
    fn vcs_blame(
        &self,
        client: Option<&str>,
        root: &Path,
        path: &str,
    ) -> Result<Vec<ide_plugin::BlameLine>, HostError> {
        let repo = self.read_repo(root)?;
        let path = ide_plugin::resolve_new_in_root(root, path).map_err(HostError::Invalid)?;
        let Some(repo) = repo else {
            return Ok(Vec::new());
        };
        let workspace = self.shared.workspace().unwrap();
        let text = workspace.buffer_text_in(client, &path);
        repo.blame(&path, text.as_deref(), None, workspace.vcs_encoding(&path))
            .map(|lines| {
                lines
                    .into_iter()
                    .enumerate()
                    .map(|(i, l)| ide_plugin::BlameLine {
                        line: i as u32,
                        commit: l.commit,
                        author: l.author,
                        date: (l.time_ms / 1000.0) as i64,
                        summary: l.summary,
                    })
                    .collect()
            })
            .map_err(failed)
    }
    fn vcs_diff(
        &self,
        root: &Path,
        path: Option<&str>,
        against: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, HostError> {
        let repo = self.read_repo(root)?;
        let path = path.map(|p| ide_plugin::resolve_new_in_root(root, p).map_err(HostError::Invalid)).transpose()?;
        let Some(repo) = repo else {
            return Ok(None);
        };
        repo.working_tree_patch(path.as_deref(), against, 4 << 20, cancel).map(Some).map_err(failed)
    }

    fn execute_command(
        &self,
        invocation: &ide_plugin::Invocation,
        id: &str,
        arg: Option<String>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<Option<String>, HostError> {
        let client = from_window(invocation.client.as_deref(), "execute commands")?;
        let mut chain = invocation.command_chain.clone();
        chain.push(self.id().into());
        if chain.len() > 8 {
            return Err(HostError::Invalid("command nesting limit (8)".into()));
        }
        for command in self.shared.ui.items(super::COMMANDS, None) {
            if id == format!("plugin.{}.{}", command.plugin_id, command.key) && chain.contains(&command.plugin_id) {
                return Err(HostError::Invalid("recursive plugin command".into()));
            }
        }
        let request = self.shared.next_prompt.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        {
            let closed = self.shared.closed_clients.lock();
            let blocked = self.shared.prompts_blocked.lock();
            if closed.contains(client) || blocked.contains(self.id()) {
                return Err(HostError::Cancelled);
            }
            self.shared.prompts.lock().insert(
                request,
                PromptEntry { plugin: self.id().into(), client: client.into(), answer: Waiter::Command(tx) },
            );
        }
        self.shared.sink.emit(
            Some(client),
            PluginEvent::ExecuteCommand { request_id: request.to_string(), id: id.into(), arg, chain },
        );
        let deadline = Instant::now() + timeout;
        loop {
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(super::CommandAnswer::Value(value)) => return Ok(value),
                Ok(super::CommandAnswer::NotFound) => return Err(HostError::NotFound(id.into())),
                Ok(super::CommandAnswer::Failed(error)) => return Err(HostError::Failed(error)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                    if !cancel.is_cancelled() && Instant::now() < deadline => {}
                Err(_) => {
                    self.shared.prompts.lock().remove(&request);
                    return Err(HostError::Cancelled);
                }
            }
        }
    }
    fn output_write(&self, channel: &str, text: Option<&str>) -> Result<(), HostError> {
        if channel.is_empty() || channel.len() > 128 || channel.chars().any(char::is_control) {
            return Err(HostError::Invalid("output channel must be 1-128 bytes without control characters".into()));
        }
        let key = (self.id().to_owned(), channel.to_owned());
        let mut channels = self.shared.output.lock();
        if !channels.contains_key(&key) && channels.keys().filter(|(p, _)| p == self.id()).count() >= 32 {
            return Err(HostError::Invalid("at most 32 output channels".into()));
        }
        let buffer = channels.entry(key).or_default();
        if let Some(text) = text {
            let mut start = text.len().saturating_sub(1 << 20);
            while !text.is_char_boundary(start) {
                start += 1;
            }
            buffer.push_str(&text[start..]);
        } else {
            buffer.clear();
        }
        let mut remove = buffer.len().saturating_sub(1 << 20);
        while !buffer.is_char_boundary(remove) {
            remove += 1;
        }
        buffer.drain(..remove);
        let text = buffer.clone();
        drop(channels);
        self.shared.sink.emit(
            None,
            PluginEvent::OutputChanged { plugin_id: self.id().into(), channel: channel.into(), text: Some(text) },
        );
        Ok(())
    }
    fn output_reveal(&self, client: &str, channel: &str) -> Result<(), HostError> {
        let key = (self.id().to_owned(), channel.to_owned());
        if !self.shared.output.lock().contains_key(&key) {
            self.output_write(channel, None)?;
        }
        if self.shared.client_closed(client) {
            return Err(HostError::Cancelled);
        }
        let text = self.shared.output.lock().get(&key).cloned().unwrap_or_default();
        self.shared.sink.emit(
            Some(client),
            PluginEvent::RevealOutput { plugin_id: self.id().into(), channel: channel.into(), text },
        );
        Ok(())
    }
    fn require_api(&self, what: &str, minor: u64) -> Result<(), HostError> {
        self.pkg.manifest.needs_api(what, minor).map_err(HostError::Invalid)
    }

    fn notify(
        &self,
        client: Option<&str>,
        level: NotificationLevel,
        title: String,
        body: String,
        actions: Vec<ide_plugin::NotificationAction>,
    ) -> Result<(), HostError> {
        check_actions(self, &actions)?;
        let plugin_id = self.id().to_owned();
        self.shared.sink.emit(client, PluginEvent::Notification { plugin_id, level, title, body, actions });
        Ok(())
    }

    fn notify_project(
        &self,
        root: &Path,
        level: NotificationLevel,
        title: String,
        body: String,
        actions: Vec<ide_plugin::NotificationAction>,
    ) -> Result<(), HostError> {
        check_actions(self, &actions)?;
        let windows = self.shared.workspace().map(|w| w.project_windows(root)).unwrap_or_default();
        let window = windows
            .into_iter()
            .find(|w| !self.shared.client_closed(w))
            .ok_or_else(|| HostError::NotFound(format!("the project {} is not open", root.display())))?;
        let plugin_id = self.id().to_owned();
        self.shared.sink.emit(Some(&window), PluginEvent::Notification { plugin_id, level, title, body, actions });
        Ok(())
    }

    fn copy_to_clipboard(&self, client: Option<&str>, text: String) -> Result<(), HostError> {
        let client = from_window(client, "copy to the clipboard")?;
        self.shared.sink.emit(Some(client), PluginEvent::CopyToClipboard { plugin_id: self.id().to_owned(), text });
        Ok(())
    }

    fn open_url(&self, client: Option<&str>, url: String) -> Result<(), HostError> {
        let client = from_window(client, "open a URL")?;
        self.shared.sink.emit(Some(client), PluginEvent::OpenUrl { plugin_id: self.id().to_owned(), url });
        Ok(())
    }

    fn open_project(&self, client: Option<&str>, path: String, new_window: bool) -> Result<(), HostError> {
        let client = from_window(client, "open a project")?;
        self.shared
            .sink
            .emit(Some(client), PluginEvent::OpenProject { plugin_id: self.id().to_owned(), path, new_window });
        Ok(())
    }

    fn ask(
        &self,
        client: Option<&str>,
        prompt: Prompt,
        cancel: &CancellationToken,
    ) -> Result<Option<Vec<String>>, HostError> {
        let client = from_window(client, "ask the user")?;
        let id = self.shared.next_prompt.fetch_add(1, Ordering::Relaxed);
        let (answer, answers) = std::sync::mpsc::sync_channel(1);
        {
            let closed = self.shared.closed_clients.lock();
            if closed.contains(client) {
                return Err(HostError::Cancelled);
            }
            let blocked = self.shared.prompts_blocked.lock();
            if blocked.contains(self.id()) {
                return Err(HostError::Cancelled);
            }
            self.shared.prompts.lock().insert(
                id,
                PromptEntry { plugin: self.id().to_owned(), client: client.to_owned(), answer: Waiter::Prompt(answer) },
            );
        }
        let prompt_id = id.to_string();
        self.shared.sink.emit(
            Some(client),
            PluginEvent::PromptRequested { plugin_id: self.id().to_owned(), prompt_id: prompt_id.clone(), prompt },
        );
        loop {
            match answers.recv_timeout(Duration::from_millis(100)) {
                Ok(answer) => return Ok(answer),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) if !cancel.is_cancelled() => {}
                Err(_) => {
                    self.shared.prompts.lock().remove(&id);
                    self.shared.sink.emit(Some(client), PluginEvent::PromptClosed { prompt_id });
                    return Err(HostError::Cancelled);
                }
            }
        }
    }

    fn pending_commit(
        &self,
        client: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Option<CommitDraft>, HostError> {
        let client = from_window(client, "read the pending commit")?;
        let workspace = self.shared.workspace().ok_or_else(|| HostError::Failed("no workspace".into()))?;
        let root =
            workspace.project_of(client).ok_or_else(|| HostError::Invalid("the window has no project".into()))?;
        if !workspace.trusted(&root) {
            return Err(HostError::Invalid("the project is in Restricted Mode: git does not run there".into()));
        }
        let answer = self.ask_commit(client, CommitRequest::Selection, cancel, COMMIT_SELECTION_TIMEOUT)?;
        match answer {
            CommitAnswer::NoRepository => Ok(None),
            CommitAnswer::Selection { selection } => commit_draft(&*workspace, selection, cancel).map(Some),
            CommitAnswer::Done | CommitAnswer::Stale => Err(HostError::Failed("unexpected answer".into())),
        }
    }

    fn set_commit_message(&self, client: Option<&str>, revision: u64, message: String) -> Result<(), HostError> {
        let client = from_window(client, "set the commit message")?;
        let request = CommitRequest::SetMessage { revision, message };
        match self.ask_commit(client, request, &CancellationToken::new(), COMMIT_MESSAGE_TIMEOUT)? {
            CommitAnswer::Done => Ok(()),
            CommitAnswer::Stale => Err(HostError::Stale),
            CommitAnswer::NoRepository => Err(HostError::Invalid("the window's project has no repository".into())),
            CommitAnswer::Selection { .. } => Err(HostError::Failed("unexpected answer".into())),
        }
    }

    fn reveal_view(&self, client: Option<&str>, view: &str) -> Result<(), HostError> {
        let client = from_window(client, "reveal a view")?;
        let declared = self.shared.ui.items(super::ui_points::VIEWS, Some(self.id())).iter().any(|i| i.key == view);
        if !declared {
            return Err(HostError::NotFound(format!("the plugin declares no view {view:?}")));
        }
        self.shared
            .sink
            .emit(Some(client), PluginEvent::RevealView { plugin_id: self.id().to_owned(), view: view.to_owned() });
        Ok(())
    }

    fn status_item(&self, id: &str, item: Option<StatusItem>) {
        let key = (self.id().to_owned(), id.to_owned());
        {
            let mut status = self.shared.status.lock();
            match &item {
                Some(item) => {
                    let count = status.keys().filter(|(p, _)| p == self.id()).count();
                    if !status.contains_key(&key) && count >= MAX_STATUS_ITEMS {
                        tracing::warn!(plugin = %self.id(), "more than {MAX_STATUS_ITEMS} status items; {id:?} ignored");
                        return;
                    }
                    if status.get(&key) == Some(item) {
                        return;
                    }
                    status.insert(key, item.clone());
                }
                None => {
                    if status.remove(&key).is_none() {
                        return;
                    }
                }
            }
        }
        self.shared
            .sink
            .emit(None, PluginEvent::StatusItemChanged { plugin_id: self.id().to_owned(), id: id.to_owned(), item });
    }

    fn window_status_item(&self, client: &str, id: &str, item: Option<StatusItem>) -> Result<(), HostError> {
        let closed = self.shared.closed_clients.lock();
        let blocked = self.shared.prompts_blocked.lock();
        if closed.contains(client) || blocked.contains(self.id()) {
            return Err(HostError::Cancelled);
        }
        let key = (client.to_owned(), self.id().to_owned(), id.to_owned());
        let mut items = self.shared.window_status.lock();
        if let Some(item) = &item {
            if !items.contains_key(&key)
                && items.keys().filter(|(w, p, _)| w == client && p == self.id()).count() >= MAX_STATUS_ITEMS
            {
                return Err(HostError::Invalid("too many window status items".into()));
            }
            items.insert(key, item.clone());
        } else {
            items.remove(&key);
        }
        drop(items);
        self.shared.sink.emit(
            Some(client),
            PluginEvent::WindowStatusItemChanged { plugin_id: self.id().into(), id: id.into(), item },
        );
        Ok(())
    }

    fn set_context(&self, client: Option<&str>, key: &str, value: Option<String>) -> Result<(), HostError> {
        let map_key = (client.map(str::to_owned), self.id().to_owned(), key.to_owned());
        {
            let mut contexts = self.shared.contexts.lock();
            if client.is_some_and(|c| self.shared.closed_clients.lock().contains(c)) {
                return Ok(());
            }
            match &value {
                Some(value) => {
                    if contexts.get(&map_key) == Some(value) {
                        return Ok(());
                    }
                    let count = contexts.keys().filter(|(_, p, _)| p == self.id()).count();
                    if !contexts.contains_key(&map_key) && count >= MAX_CONTEXT_KEYS {
                        return Err(HostError::Invalid(format!("more than {MAX_CONTEXT_KEYS} context keys")));
                    }
                    contexts.insert(map_key, value.clone());
                }
                None => {
                    if contexts.remove(&map_key).is_none() {
                        return Ok(());
                    }
                }
            }
        }
        self.shared
            .sink
            .emit(client, PluginEvent::ContextChanged { plugin_id: self.id().to_owned(), key: key.to_owned(), value });
        Ok(())
    }

    fn projects(&self) -> Vec<PathBuf> {
        self.shared.workspace().map(|w| w.projects()).unwrap_or_default()
    }

    fn buffer_text(&self, path: &Path) -> Option<String> {
        self.shared.workspace()?.buffer_text(path)
    }

    fn document(&self, path: &Path) -> Option<(u64, String)> {
        self.shared.workspace()?.document(path)
    }

    fn apply_edits(
        &self,
        _client: Option<&str>,
        path: &Path,
        version: u64,
        edits: Vec<TextEdit>,
    ) -> Result<u64, HostError> {
        let workspace = self.shared.workspace().ok_or_else(|| HostError::NotFound("no project is open".into()))?;
        workspace.apply_edits(path, version, &edits)
    }

    fn storage_get(&self, key: &str) -> Result<Option<String>, HostError> {
        let file = self.storage()?.join(entry_name(key));
        match std::fs::read(&file) {
            Ok(bytes) => Ok(decode_entry(&bytes).filter(|(k, _)| *k == key).map(|(_, v)| v.to_owned())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(storage_io(e)),
        }
    }

    fn storage_set(&self, key: &str, value: Option<String>) -> Result<(), HostError> {
        if key.is_empty() || key.len() > MAX_KEY {
            return Err(HostError::Invalid(format!("keys are 1–{MAX_KEY} bytes")));
        }
        let dir = self.storage()?;
        let file = dir.join(entry_name(key));
        let Some(value) = value else {
            return match std::fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(storage_io(e)),
                _ => Ok(()),
            };
        };
        let others: usize = entries(&dir)?.filter(|(name, _)| *name != file).map(|(_, size)| size).sum();
        if others + key.len() + value.len() > MAX_STORAGE {
            return Err(HostError::Invalid(format!(
                "storage is limited to {} MiB (UTF-8 keys and values)",
                MAX_STORAGE >> 20
            )));
        }
        write_entry(&dir, key, &value)
    }

    fn storage_keys(&self, prefix: &str) -> Result<Vec<String>, HostError> {
        let dir = self.storage()?;
        let mut keys = Vec::new();
        for (file, _) in entries(&dir)? {
            let bytes = std::fs::read(&file).map_err(storage_io)?;
            if let Some((key, _)) = decode_entry(&bytes).filter(|(k, _)| k.starts_with(prefix)) {
                keys.push(key.to_owned());
            }
        }
        keys.sort();
        Ok(keys)
    }

    fn vcs_status(&self, root: &Path) -> Result<Option<RepositoryStatus>, HostError> {
        let Some(repo) = ide_vcs::Repo::discover(root).map_err(failed)? else { return Ok(None) };
        let info = repo.branch_info().map_err(failed)?;
        let changed = repo.status().map_err(failed)?.len();
        Ok(Some(RepositoryStatus {
            root: to_ipc(repo.root()),
            branch: info.head,
            commit: info.head_commit,
            upstream: info.upstream,
            ahead: info.ahead,
            behind: info.behind,
            operation: info.operation,
            changed_files: u32::try_from(changed).unwrap_or(u32::MAX),
        }))
    }

    fn vcs_remotes(&self, root: &Path) -> Result<Vec<(String, String)>, HostError> {
        let Some(repo) = ide_vcs::Repo::discover(root).map_err(failed)? else { return Ok(Vec::new()) };
        let remotes = repo.remotes().map_err(failed)?;
        Ok(remotes.into_iter().map(|r| (r.name, without_credentials(&r.url))).collect())
    }

    fn vcs_fetch(&self, root: &Path, cancel: &CancellationToken) -> Result<(), HostError> {
        let workspace = self.shared.workspace();
        if !workspace.is_some_and(|w| w.trusted(root)) {
            return Err(HostError::Failed("the project is in Restricted Mode: git does not run there".into()));
        }
        let Some(repo) = ide_vcs::Repo::discover(root).map_err(failed)? else {
            return Err(HostError::NotFound("the project is not in a git repository".into()));
        };
        match repo.fetch(cancel, &|_| {}) {
            Ok(()) => Ok(()),
            Err(_) if cancel.is_cancelled() => Err(HostError::Cancelled),
            Err(e) => Err(failed(e.message)),
        }
    }

    fn symbols(
        &self,
        root: &Path,
        query: &str,
        limit: usize,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<Vec<ide_plugin::SymbolInfo>, HostError> {
        if query.len() > 256 {
            return Err(HostError::Invalid("symbol query exceeds 256 UTF-8 bytes".into()));
        }
        self.shared.workspace().ok_or_else(|| HostError::NotFound("no project index is available".into()))?.symbols(
            root,
            query,
            limit.min(1000),
            cancel,
            deadline,
        )
    }

    fn find_files(&self, root: &Path, glob: &str, limit: usize) -> Result<Vec<String>, HostError> {
        let matcher = globset::GlobBuilder::new(glob)
            .literal_separator(true)
            .build()
            .map_err(|e| HostError::Invalid(format!("{glob:?}: {e}")))?
            .compile_matcher();
        // Project scope visits hidden files and folders (`.github`, `.config`):
        // only `.git` internals stay out, as in the walk below.
        let visible = |rel: &Path| !rel.iter().any(|c| c == ".git");
        // The project index already lists the files: walking a large tree on every call can take
        // longer than an editor provider's deadline (the plugin is then stopped as crashed).
        if let Some(files) = self
            .shared
            .workspace()
            .and_then(|w| w.indexed_files(root, &|rel| visible(rel) && matcher.is_match(rel), limit))
        {
            let mut out: Vec<String> = files.iter().map(|p| to_ipc(p)).collect();
            out.sort();
            return Ok(out);
        }
        let mut out = Vec::new();
        for (n, entry) in ignore::WalkBuilder::new(root)
            .hidden(false)
            .filter_entry(|e| e.file_name() != ".git")
            .build()
            .flatten()
            .enumerate()
        {
            if n >= MAX_WALK || out.len() >= limit {
                break;
            }
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(root) else { continue };
            if matcher.is_match(rel) {
                out.push(to_ipc(entry.path()));
            }
        }
        out.sort();
        Ok(out)
    }

    fn publish_diagnostics(&self, path: &Path, items: Vec<ide_core::Diagnostic>) -> Result<(), HostError> {
        self.shared.publish_diagnostics(self.id(), path, items)
    }

    fn fetch(&self, request: HttpRequest, cancel: &CancellationToken) -> Result<HttpResponse, HostError> {
        let secrets = self.shared.secrets.read().clone();
        let id = self.id().to_owned();
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in &request.headers {
            let value = fill_secrets(value, |n| secrets.get(&id, n))?;
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| HostError::Invalid(format!("header {name:?}: {e}")))?;
            let mut value = reqwest::header::HeaderValue::from_str(&value)
                .map_err(|e| HostError::Invalid(format!("header {name}: {e}")))?;
            value.set_sensitive(true);
            headers.append(name, value);
        }
        let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
            .map_err(|_| HostError::Invalid(format!("method {:?}", request.method)))?;
        let grants = request.grants.clone();
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.error("too many redirects");
            }
            let wanted = attempt.previous().last().map_or_else(
                || ide_plugin::net_capability(attempt.url().as_str()),
                |from| redirect_capability(from, attempt.url()),
            );
            match wanted {
                Ok(wanted) if grants.iter().any(|g| g.covers(&wanted)) => attempt.follow(),
                Ok(wanted) => attempt.error(RedirectDenied(wanted.to_string())),
                Err(error) => attempt.error(error),
            }
        });
        let client = ide_http::client::build_with_redirect(&ide_core::proxy_settings::proxy(), policy)
            .map_err(|e| HostError::Failed(e.message))?;
        let builder = client.request(method, &request.url).headers(headers).timeout(request.timeout);
        let builder = match request.body {
            Some(body) => builder.body(body),
            None => builder,
        };
        let cancel = cancel.clone();
        net_runtime().block_on(async move {
            let send = async {
                let response = builder.send().await.map_err(network_error)?;
                let status = response.status().as_u16();
                let headers = response
                    .headers()
                    .iter()
                    .map(|(k, v)| (k.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
                    .collect();
                let mut body = Vec::new();
                let mut response = response;
                while let Some(chunk) = response.chunk().await.map_err(|e| HostError::Failed(e.to_string()))? {
                    if body.len() + chunk.len() > MAX_RESPONSE {
                        return Err(HostError::Failed("response larger than 8 MiB".into()));
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(HttpResponse { status, headers, body })
            };
            tokio::select! {
                r = send => r,
                () = cancel.cancelled() => Err(HostError::Cancelled),
            }
        })
    }

    /// The `net:ask` answer: a host the user allowed with "always" is
    /// remembered in the ledger (no dialog again, background included); a new
    /// host is asked about in `client`'s window when there is one. Dismissal
    /// and refusal both deny and throttle further questions.
    fn net_ask(
        &self,
        subject: &Subject,
        client: Option<&str>,
        host: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<bool>, HostError> {
        if cancel.is_cancelled() {
            return Err(HostError::Cancelled);
        }
        if !self.pkg.manifest.declares(&Capability::NetAsk) {
            return Ok(None);
        }
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        {
            let ledger = self.shared.ledger.lock();
            if let Some(grant) = ledger.get(subject)
                && grant.confirmed
                && grant.has(&Capability::NetAsk)
                && grant.net_hosts.contains(&host)
            {
                return Ok(Some(true));
            }
        }
        if self.shared.session_net_hosts.lock().get(self.id()).is_some_and(|hosts| hosts.contains(&host)) {
            return Ok(Some(true));
        }
        let Some(client) = client else { return Ok(None) };
        {
            let closed = self.shared.closed_clients.lock();
            if closed.contains(client) {
                return Ok(None);
            }
        }
        if self.shared.prompts_blocked.lock().contains(self.id()) {
            return Ok(None);
        }
        {
            let mut prompts = self.shared.net_prompts.lock();
            if prompts.get(self.id()).is_some_and(|until| until.is_none_or(|until| until > Instant::now())) {
                return Ok(None);
            }
            prompts.insert(self.id().to_owned(), None);
        }
        let session_only = self.shared.net_hosts_session_only.load(Ordering::Relaxed);
        let answer = self.ask(Some(client), Prompt::NetPermission { host: host.clone(), session_only }, cancel);
        let result = match answer {
            Ok(Some(keys)) if keys == ["session"] || keys == ["always"] => {
                let mut ledger = self.shared.ledger.lock();
                if cancel.is_cancelled() {
                    Err(HostError::Cancelled)
                } else if ledger.get(subject).is_some_and(|g| g.confirmed && g.has(&Capability::NetAsk)) {
                    if session_only || keys == ["session"] {
                        self.shared.session_net_hosts.lock().entry(self.id().into()).or_default().insert(host);
                    } else {
                        ledger.remember_net_host(subject, &host);
                        if let Err(e) = ledger.save() {
                            tracing::warn!("saving plugin grants: {e}");
                        }
                    }
                    drop(ledger);
                    self.shared.sink.emit(None, PluginEvent::CommandsChanged);
                    Ok(Some(true))
                } else {
                    Ok(None)
                }
            }
            Ok(Some(keys)) if keys == ["once"] => Ok(Some(false)),
            Ok(_) => Ok(None),
            Err(e) => Err(e),
        };
        let mut prompts = self.shared.net_prompts.lock();
        if matches!(result, Ok(Some(_))) {
            prompts.remove(self.id());
        } else {
            prompts.insert(self.id().to_owned(), Some(Instant::now() + Duration::from_secs(30)));
        }
        result
    }

    fn secret_is_set(&self, name: &str) -> bool {
        self.shared.secrets.read().get(self.id(), name).is_some()
    }

    fn secret_set(&self, name: &str, value: Option<&str>) -> Result<(), HostError> {
        if !self.shared.ui.items(super::providers::SECRETS_POINT, Some(self.id())).iter().any(|s| s.key == name) {
            return Err(HostError::NotFound(format!("undeclared secret {name:?}")));
        }
        self.shared.secrets.read().set(self.id(), name, value).map_err(HostError::Failed)
    }
    fn begin_loopback(&self, client: &str, path: &str) -> Result<(u64, String), HostError> {
        let closed = self.shared.closed_clients.lock();
        let blocked = self.shared.prompts_blocked.lock();
        if closed.contains(client) || blocked.contains(self.id()) {
            return Err(HostError::Cancelled);
        }
        self.shared.loopbacks.read().begin(self.id(), client, path)
    }
    fn wait_loopback(
        &self,
        id: u64,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, HostError> {
        self.shared.loopbacks.read().clone().wait(self.id(), id, timeout, cancel)
    }
    fn close_loopback(&self, id: u64) {
        self.shared.loopbacks.read().close(self.id(), id);
    }
    fn ipc_connect(&self, name: &str, cancel: &CancellationToken, timeout: Duration) -> Result<u64, HostError> {
        self.shared.connections.connect(self.id(), name, cancel, timeout)
    }
    fn ipc_write(
        &self,
        id: u64,
        bytes: Vec<u8>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<(), HostError> {
        self.shared.connections.write(self.id(), id, bytes, cancel, timeout)
    }
    fn ipc_read(
        &self,
        id: u64,
        max: usize,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, HostError> {
        self.shared.connections.read(self.id(), id, max, timeout, cancel)
    }
    fn ipc_close(&self, id: u64) {
        self.shared.connections.close(self.id(), id);
    }
    fn run_process(
        &self,
        cmd: ProcessCommand,
        cwd: Option<&Path>,
        stdin: Option<String>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<ProcessOutput, HostError> {
        let binary = self.approved_program_in_project(&cmd.program, cwd.or(cmd.approval_root.as_deref()))?;
        let cwd = self.spawn_dir(cwd);
        let mut command = StdCommand::new(&binary);
        ide_core::process::prepare(&mut command);
        append_process_env(&mut command, &cmd.env)?;
        ide_core::process::own_group(&mut command);
        let mut child = command
            .args(&cmd.args)
            .current_dir(&cwd)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| HostError::Failed(format!("{}: {e}", binary.display())))?;
        if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
            std::thread::spawn(move || {
                use std::io::Write;
                let _ = pipe.write_all(input.as_bytes());
            });
        }
        let read = |pipe: Option<Box<dyn Read + Send>>| {
            std::thread::spawn(move || {
                let mut out = Vec::new();
                if let Some(p) = pipe {
                    let mut p = p;
                    let _ = p.by_ref().take(MAX_OUTPUT as u64).read_to_end(&mut out);
                    let _ = std::io::copy(&mut p, &mut std::io::sink());
                }
                let mut text = String::from_utf8_lossy(&out).into_owned();
                let mut end = text.len().min(MAX_OUTPUT);
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
                text
            })
        };
        let stdout = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
        let stderr = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = try_wait_process(&mut child).map_err(|e| HostError::Failed(e.to_string()))? {
                break status;
            }
            if cancel.is_cancelled() || Instant::now() >= deadline {
                ide_core::process::kill_tree(&mut child);
                return Err(if cancel.is_cancelled() {
                    HostError::Cancelled
                } else {
                    HostError::Failed(format!("{} timed out after {timeout:?}", cmd.program))
                });
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        Ok(ProcessOutput {
            status: status.code(),
            stdout: stdout.join().unwrap_or_default(),
            stderr: stderr.join().unwrap_or_default(),
        })
    }

    fn subscribe(&self, kind: EventKind) {
        if self.shared.subscriptions.lock().set(self.id(), kind) {
            self.shared.sink.emit(None, PluginEvent::SubscriptionsChanged);
        }
    }

    fn subscribe_paths(&self, kind: &str, globs: Vec<String>) -> Result<(), HostError> {
        let filter = super::event_paths::PathFilter::new(kind, globs)?;
        if self.shared.subscriptions.lock().set_paths(self.id(), kind, filter) {
            self.shared.sink.emit(None, PluginEvent::SubscriptionsChanged);
        }
        Ok(())
    }

    fn unsubscribe(&self, kind: &str) {
        if self.shared.subscriptions.lock().unsubscribe(self.id(), kind) {
            self.shared.sink.emit(None, PluginEvent::SubscriptionsChanged);
        }
    }
    fn start_process(&self, cmd: ProcessCommand, cwd: Option<&Path>, client: Option<&str>) -> Result<u64, HostError> {
        let binary = self.approved_program_in_project(&cmd.program, cwd.or(cmd.approval_root.as_deref()))?;
        let cwd = self.spawn_dir(cwd);
        if client.is_some_and(|c| self.shared.closed_clients.lock().contains(c)) {
            return Err(HostError::Cancelled);
        }
        {
            let processes = self.shared.processes.lock();
            let running = processes.keys().filter(|(plugin, _)| plugin == self.id()).count();
            if running >= MAX_PROCESSES {
                return Err(HostError::Invalid(format!(
                    "at most {MAX_PROCESSES} processes may run at once: release one first"
                )));
            }
        }
        let mut command = StdCommand::new(&binary);
        ide_core::process::prepare(&mut command);
        append_process_env(&mut command, &cmd.env)?;
        ide_core::process::own_group(&mut command);
        let mut child = command
            .args(&cmd.args)
            .current_dir(&cwd)
            // Always piped: `write` may come later, and a plugin that never
            // writes closes it (or loses it when it releases the handle).
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| HostError::Failed(format!("{}: {e}", binary.display())))?;
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
        let proc = Arc::new(Proc {
            client: client.map(str::to_owned),
            state: Mutex::new(ProcState {
                stdin: child.stdin.take(),
                child,
                stdout: Vec::new(),
                stderr: Vec::new(),
                status: None,
                readers: 0,
            }),
        });
        if let Some(pipe) = stdout {
            proc.read(pipe, Stream::Out);
        }
        if let Some(pipe) = stderr {
            proc.read(pipe, Stream::Err);
        }
        let closed = self.shared.closed_clients.lock();
        if client.is_some_and(|c| closed.contains(c)) {
            drop(closed);
            proc.kill();
            return Err(HostError::Cancelled);
        }
        let id = self.shared.next_process.fetch_add(1, Ordering::Relaxed);
        self.shared.processes.lock().insert((self.id().to_owned(), id), proc);
        drop(closed);
        Ok(id)
    }

    fn poll_process(&self, id: u64, max: usize) -> Result<ProcessChunk, HostError> {
        let proc = self.process(id)?;
        proc.reap()?;
        Ok(proc.chunk(max))
    }

    fn write_process(
        &self,
        id: u64,
        text: &str,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<(), HostError> {
        let proc = self.process(id)?;
        proc.reap()?;
        let mut pipe = {
            let mut state = proc.state.lock();
            if state.status.is_some() {
                return Err(HostError::Failed("the process already ended".into()));
            }
            state.stdin.take().ok_or_else(|| HostError::Failed("its stdin is closed".into()))?
        };
        let input = text.to_owned();
        let writer = proc.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            use std::io::Write;
            let result = pipe.write_all(input.as_bytes()).and_then(|()| pipe.flush());
            let mut state = writer.state.lock();
            if state.status.is_none() {
                state.stdin = Some(pipe);
            }
            let _ = tx.send(result);
        });
        let deadline = Instant::now() + timeout;
        loop {
            if cancel.is_cancelled() || Instant::now() >= deadline {
                proc.kill();
                return Err(if cancel.is_cancelled() {
                    HostError::Cancelled
                } else {
                    HostError::Failed("stdin write timed out".into())
                });
            }
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(result) => return result.map_err(|e| HostError::Failed(format!("stdin: {e}"))),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err(HostError::Failed("stdin writer stopped".into())),
            }
        }
    }

    fn close_process_stdin(&self, id: u64) -> Result<(), HostError> {
        let proc = self.process(id)?;
        proc.reap()?;
        let mut state = proc.state.lock();
        if state.status.is_some() {
            return Err(HostError::Failed("the process already ended".into()));
        }
        state.stdin = None;
        Ok(())
    }

    fn release_process(&self, id: u64) {
        let proc = self.shared.processes.lock().remove(&(self.id().to_owned(), id));
        if let Some(proc) = proc {
            proc.kill();
        }
    }

    fn kill_process(&self, id: u64) -> Result<(), HostError> {
        self.process(id)?.kill();
        Ok(())
    }

    fn wait_process(
        &self,
        id: u64,
        max: usize,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<ProcessChunk, HostError> {
        let proc = self.process(id)?;
        let deadline = Instant::now() + timeout;
        loop {
            proc.reap()?;
            let (ended, readers) = {
                let state = proc.state.lock();
                (state.status.is_some(), state.readers)
            };
            // Its output is only complete once its pipes reached the end too.
            if ended && readers == 0 {
                break;
            }
            if cancel.is_cancelled() {
                return Err(HostError::Cancelled);
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(proc.chunk(max))
    }

    fn task_begin(&self, client: Option<&str>, title: String, cancellable: bool, cancel: CancellationToken) -> u64 {
        let id = self.shared.next_task.fetch_add(1, Ordering::Relaxed);
        self.shared.tasks.lock().insert(id, TaskEntry { plugin: self.id().to_owned(), cancel, cancelled: false });
        self.shared.sink.emit(
            client,
            PluginEvent::TaskStarted { plugin_id: self.id().to_owned(), task_id: id.to_string(), title, cancellable },
        );
        id
    }

    fn task_report(&self, id: u64, done: u32, total: Option<u32>, message: Option<String>) {
        if !self.shared.tasks.lock().contains_key(&id) {
            return;
        }
        self.shared.sink.emit(
            None,
            PluginEvent::TaskProgress {
                plugin_id: self.id().to_owned(),
                task_id: id.to_string(),
                done,
                total,
                message,
            },
        );
    }

    fn task_cancelled(&self, id: u64) -> bool {
        self.shared.tasks.lock().get(&id).is_some_and(|t| t.cancelled)
    }

    fn task_end(&self, id: u64) {
        self.shared.end_task(id);
    }

    fn refresh_view(&self, view: &str) {
        self.shared
            .sink
            .emit(None, PluginEvent::ViewChanged { plugin_id: self.id().to_owned(), view: view.to_owned() });
    }

    fn post_view_message(&self, view: &str, message: String) -> Result<(), HostError> {
        let declared = [super::ui_points::VIEWS, super::ui_points::CUSTOM_EDITORS]
            .iter()
            .any(|point| self.shared.ui.items(point, Some(self.id())).iter().any(|i| i.key == view));
        if !declared {
            return Err(HostError::NotFound(format!("the plugin declares no view {view:?}")));
        }
        let event = PluginEvent::ViewMessage { plugin_id: self.id().to_owned(), view: view.to_owned(), message };
        self.shared.sink.emit(None, event);
        Ok(())
    }

    fn open_terminal(
        &self,
        client: Option<&str>,
        title: String,
        program: &str,
        args: Vec<String>,
        cwd: Option<&Path>,
    ) -> Result<(), HostError> {
        let binary = self.approved_program_in_project(program, cwd)?;
        let cwd = cwd.map(Path::to_path_buf).unwrap_or_else(|| self.shared.data_dir.join(self.id()));
        let _ = std::fs::create_dir_all(&cwd);
        let event = PluginEvent::OpenTerminal {
            plugin_id: self.id().to_owned(),
            title,
            program: binary.into(),
            args,
            cwd: cwd.into(),
        };
        self.shared.sink.emit(client, event);
        Ok(())
    }

    fn open_location(&self, client: Option<&str>, path: &Path, line: u32, column: u32) -> Result<(), HostError> {
        let event = PluginEvent::OpenLocation {
            plugin_id: self.id().to_owned(),
            path: path.to_path_buf().into(),
            line,
            column,
        };
        self.shared.sink.emit(client, event);
        Ok(())
    }

    fn open_log_tab(
        &self,
        client: &str,
        key: String,
        title: String,
        log: ide_plugin::ServiceLog,
    ) -> Result<(), HostError> {
        // Fails now, rather than in the tab, when the approved file is gone or changed.
        self.approved_program_in_project(&log.program, self.shared.project_of(client).as_deref())?;
        {
            let mut all = self.shared.log_tabs.lock();
            let tabs = all.entry((self.id().to_owned(), client.to_owned())).or_default();
            tabs.retain(|(k, _)| *k != key);
            tabs.push((key.clone(), log.clone()));
            if tabs.len() > MAX_LOG_TABS {
                tabs.remove(0);
            }
        }
        let event = PluginEvent::OpenLogTab { plugin_id: self.id().to_owned(), key, title, log };
        self.shared.sink.emit(Some(client), event);
        Ok(())
    }

    fn locale(&self) -> String {
        self.shared.locale.read().clone()
    }

    fn setting(&self, root: Option<&Path>, key: &str) -> Option<String> {
        let schema: Vec<super::ui_points::SettingSchema> = self
            .shared
            .ui
            .items(super::ui_points::SETTINGS, Some(self.id()))
            .into_iter()
            .find_map(|i| serde_json::from_value(i.decl.get("properties")?.clone()).ok())?;
        let setting = schema.into_iter().find(|s| s.key == key)?;
        let user = self.shared.workspace().map(|w| w.plugin_settings(self.id(), root)).unwrap_or_default();
        let value = user.get(key).filter(|v| setting.accepts(v)).cloned().unwrap_or(setting.default);
        serde_json::to_string(&value).ok()
    }

    fn plugin_dir(&self) -> Result<PathBuf, HostError> {
        ide_extension::validate_plugin_id(self.id()).map_err(HostError::Invalid)?;
        std::fs::create_dir_all(&self.shared.data_dir).map_err(failed)?;
        let data = self.shared.data_dir.join(self.id());
        ide_vfs::create_private_dir(&data).map_err(failed)?;
        let files = data.join("files");
        ide_vfs::create_private_dir(&files).map_err(failed)?;
        dunce::canonicalize(files).map_err(failed)
    }

    fn read_text_file(&self, real: &Path, max: usize) -> Result<String, HostError> {
        // Unsaved editor contents win, as they do for project files.
        if let Some(text) = self.shared.workspace().and_then(|w| w.buffer_text(real)) {
            return Ok(text);
        }
        let meta = std::fs::metadata(real).map_err(|e| not_a_file(real, e))?;
        if !meta.is_file() {
            return Err(HostError::Invalid(format!("{}: not a file", real.display())));
        }
        if meta.len() > max as u64 {
            return Err(too_large(real, max));
        }
        let loaded = ide_vfs::load_text(real).map_err(failed)?;
        if loaded.binary {
            return Err(HostError::Invalid(format!("{}: not text; read it as bytes", real.display())));
        }
        Ok(loaded.text)
    }

    fn write_text_file(&self, real: &Path, text: &str) -> Result<(), HostError> {
        check_unsaved(self.shared.workspace(), real)?;
        // Write back in the file's own encoding, so a GBK properties file stays
        // one; a file that is not there yet becomes UTF-8.
        let (encoding, has_bom) = match ide_vfs::load_text(real) {
            Ok(loaded) if loaded.binary => {
                return Err(HostError::Invalid(format!("{}: not text; write it as bytes", real.display())));
            }
            Ok(loaded) => (loaded.encoding, loaded.has_bom),
            Err(e) if e.kind == ide_core::error::ErrorKind::NotFound => ("utf-8".to_string(), false),
            Err(e) => return Err(not_writable(real, e)),
        };
        let private = self.plugin_dir().is_ok_and(|dir| real.starts_with(dir));
        check_write_path(real)?;
        if private {
            let bytes = ide_vfs::encode(text, &encoding, has_bom).map_err(|e| not_writable(real, e))?;
            ide_vfs::write_atomic_private(real, &bytes).map(drop).map_err(|e| not_writable(real, e))
        } else {
            ide_vfs::save_text(real, text, &encoding, has_bom).map(drop).map_err(|e| not_writable(real, e))
        }
    }

    fn write_bytes_file(&self, real: &Path, bytes: &[u8]) -> Result<(), HostError> {
        check_unsaved(self.shared.workspace(), real)?;
        let private = self.plugin_dir().is_ok_and(|dir| real.starts_with(dir));
        check_write_path(real)?;
        if private {
            ide_vfs::write_atomic_private(real, bytes).map(drop).map_err(|e| not_writable(real, e))
        } else {
            ide_vfs::write_atomic(real, bytes).map(drop).map_err(|e| not_writable(real, e))
        }
    }
}

/// Approved write paths are already resolved. Refuse substitutions since approval.
fn check_write_path(path: &Path) -> Result<(), HostError> {
    let parent = path.parent().ok_or_else(|| HostError::Invalid("no directory to put it in".into()))?;
    let checked = ide_plugin::resolve_writable_in_root(parent, &to_ipc(path)).map_err(HostError::Invalid)?;
    if checked != path {
        return Err(HostError::Invalid(format!("{}: file path changed before writing", path.display())));
    }
    Ok(())
}

/// A file that is not there, or cannot be read, as the plugin sees it.
fn not_a_file(path: &Path, e: std::io::Error) -> HostError {
    match e.kind() {
        std::io::ErrorKind::NotFound => HostError::NotFound(format!("{}: no such file", path.display())),
        std::io::ErrorKind::PermissionDenied => HostError::Denied(format!("{}: {}", path.display(), "not readable")),
        _ => failed(e),
    }
}

fn too_large(path: &Path, max: usize) -> HostError {
    HostError::Invalid(format!("{}: file is larger than {} MiB", path.display(), max >> 20))
}

/// Refuses to replace a file the editor holds unsaved changes for: the write
/// would lose them.
fn check_unsaved(workspace: Option<Arc<dyn PluginWorkspace>>, path: &Path) -> Result<(), HostError> {
    match workspace {
        Some(workspace) if workspace.buffer_dirty(path) => Err(HostError::Invalid(format!(
            "{}: the editor has unsaved changes for it; save them first",
            path.display()
        ))),
        _ => Ok(()),
    }
}

/// A write that did not land, as the plugin sees it.
fn not_writable(path: &Path, e: ide_core::error::IdeError) -> HostError {
    let message = format!("{}: {}", path.display(), e.message);
    match e.kind {
        ide_core::error::ErrorKind::NotFound => HostError::NotFound(message),
        ide_core::error::ErrorKind::PermissionDenied => HostError::Denied(message),
        ide_core::error::ErrorKind::InvalidInput => HostError::Invalid(message),
        _ => HostError::Failed(message),
    }
}

/// Notification buttons must name commands the plugin declares.
fn check_actions(api: &PluginApi, actions: &[ide_plugin::NotificationAction]) -> Result<(), HostError> {
    let commands = if actions.is_empty() { Vec::new() } else { api.shared.ui.items("commands", Some(api.id())) };
    match actions.iter().find(|a| !commands.iter().any(|c| c.key == a.command)) {
        Some(a) => Err(HostError::NotFound(format!("the plugin declares no command {:?}", a.command))),
        None => Ok(()),
    }
}

/// [`PluginWorkspace`] over the desktop host's open projects.
pub struct HostWorkspace(pub std::sync::Weak<crate::Host>);

impl HostWorkspace {
    fn project_for(&self, client: Option<&str>, root: &Path) -> Option<Arc<crate::project::Project>> {
        let host = self.0.upgrade()?;
        client
            .and_then(|w| host.project(w).ok())
            .filter(|p| p.root == root)
            .or_else(|| host.windows_for_root(root).first().and_then(|w| host.project(w).ok()))
    }
    fn projects(&self) -> Vec<Arc<crate::project::Project>> {
        self.0.upgrade().map(|h| h.projects()).unwrap_or_default()
    }

    /// The project holding an open document at `path`, and its id.
    fn open_document(&self, path: &Path) -> Option<(Arc<crate::project::Project>, ide_core::DocId)> {
        self.projects().into_iter().find_map(|p| p.documents.by_path(path).map(|doc| (p, doc)))
    }
}

impl PluginWorkspace for HostWorkspace {
    fn database_host(&self) -> Option<Arc<crate::Host>> {
        self.0.upgrade()
    }
    fn run_configuration(&self, client: &str, plugin: &str, config: &str) -> Result<ide_run::RunConfig, HostError> {
        let host = self.0.upgrade().ok_or(HostError::Cancelled)?;
        let prefix = format!("{}{}:", ide_run::EXTERNAL_PREFIX, plugin);
        let id = if config.starts_with(&prefix) { config.to_owned() } else { format!("{prefix}{config}") };
        let project = host.project(client).map_err(failed)?;
        project.require_trust().map_err(failed)?;
        let plugins = host.plugin_host().ok_or(HostError::Cancelled)?;
        let detected = plugins
            .run_detection()
            .detect(&project.root)
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| HostError::NotFound("no owned run configuration with this id".into()))?;
        let mut config = ide_run::load_user_configs(&project.root)
            .map_err(failed)?
            .into_iter()
            .find(|c| c.id == id)
            .unwrap_or(detected);
        ide_sdk::apply::apply_to_run_configs(
            std::slice::from_mut(&mut config),
            &project.root,
            &project.settings.effective(),
        );
        if config.debug_adapter.is_none() {
            let cwd = config.cwd.as_ref().map(|p| p.as_ref()).unwrap_or(&project.root);
            config.debug_adapter =
                config.args.iter().map(|arg| cwd.join(arg)).filter(|path| path.is_file()).find_map(|path| {
                    let language = project.languages.detect(&path, None);
                    project.languages.get(&language)?.debugger.map(|d| d.adapter)
                });
        }
        Ok(config)
    }

    fn buffer_text_in(&self, client: Option<&str>, path: &Path) -> Option<String> {
        client
            .and_then(|w| self.0.upgrade()?.project(w).ok()?.documents.text_of(path))
            .or_else(|| self.buffer_text(path))
    }
    fn document_in(&self, client: &str, path: &Path) -> Option<(u64, String)> {
        let project = self.0.upgrade()?.project(client).ok()?;
        let doc = project.documents.by_path(path)?;
        let snapshot = project.documents.snapshot(doc).ok()?;
        Some((u64::from(snapshot.version), snapshot.text))
    }
    fn open_editors(&self, client: &str) -> Result<Vec<ide_plugin::OpenEditor>, HostError> {
        let host = self.0.upgrade().ok_or(HostError::Cancelled)?;
        let project = host.project(client).map_err(failed)?;
        let active = host.mcp_reports.focused(client).map(|e| e.path.into_path_buf());
        Ok(host
            .mcp_reports
            .editors(&[client.into()])
            .into_iter()
            .map(|path| {
                let language = project
                    .languages
                    .detect(&path, project.documents.text_of(&path).as_deref().and_then(|t| t.lines().next()));
                ide_plugin::OpenEditor {
                    active: active.as_ref() == Some(&path),
                    dirty: project
                        .documents
                        .by_path(&path)
                        .is_some_and(|doc| project.documents.is_dirty(doc).unwrap_or(false)),
                    language: language.to_string(),
                    path: to_ipc(&path),
                }
            })
            .collect())
    }
    fn search_text(
        &self,
        client: Option<&str>,
        root: &Path,
        query: ide_plugin::TextQuery,
        limit: u32,
        cancel: &CancellationToken,
    ) -> Result<ide_plugin::TextSearch, HostError> {
        let host = self.0.upgrade().ok_or(HostError::Cancelled)?;
        let project = self.project_for(client, root).ok_or_else(|| HostError::NotFound("project closed".into()))?;
        if limit == 0 {
            return Ok(ide_plugin::TextSearch::default());
        }
        let mut query = ide_search::SearchQuery {
            pattern: query.pattern,
            is_regex: query.regex,
            case_sensitive: query.case_sensitive,
            whole_word: query.whole_word,
            include: query.include,
            exclude: query.exclude,
            scope: ide_search::SearchScope::Project,
            max_matches: limit.min(10_000).saturating_add(1),
            context: Default::default(),
        };
        query.exclude.extend(project.search_excludes());
        let files = Mutex::new(Vec::new());
        let summary = crate::ops::search::search_project(&project, &host.syntax(), &query, cancel, &|file| {
            files.lock().push(file)
        })
        .map_err(failed)?;
        if summary.cancelled || cancel.is_cancelled() {
            return Err(HostError::Cancelled);
        }
        let mut out = ide_plugin::TextSearch { matches: Vec::new(), limit_hit: summary.limit_hit };
        let mut bytes = 0usize;
        for file in files.into_inner() {
            if cancel.is_cancelled() {
                return Err(HostError::Cancelled);
            }
            // Restrict project.read to the project root, including symlink targets.
            let Ok(path) = ide_plugin::resolve_in_root(root, &to_ipc(&file.path.0)) else {
                continue;
            };
            let text = project.documents.text_of(&path).or_else(|| {
                let loaded = project.documents.load_file_bounded(&path, ide_plugin::MAX_READ_BYTES as usize).ok()?;
                (!loaded.binary && !loaded.too_large)
                    .then(|| ide_text::normalize_line_endings(&loaded.text).into_owned())
            });
            let Some(text) = text else {
                out.limit_hit = true;
                continue;
            };
            let doc = ide_text::Document::new(&text);
            for (start, end) in ide_search::match_ranges(&text, &query).map_err(failed)? {
                if out.matches.len() >= limit as usize {
                    out.limit_hit = true;
                    return Ok(out);
                }
                let range = ide_core::Range::new(doc.byte_to_pos(start), doc.byte_to_pos(end));
                let line = text[..start].rfind('\n').map_or(0, |i| i + 1);
                let end_line = text[start..].find('\n').map_or(text.len(), |i| start + i);
                let preview = text[line..end_line].trim_end_matches('\r');
                let mut cut = preview.len().min(4096);
                while !preview.is_char_boundary(cut) {
                    cut -= 1;
                }
                let preview = &preview[..cut];
                bytes += preview.len() + path.as_os_str().len() + 64;
                if bytes > 4 << 20 {
                    out.limit_hit = true;
                    return Ok(out);
                }
                out.matches.push(ide_plugin::TextMatch {
                    location: ide_plugin::Location { path: path.clone(), range },
                    line: preview.into(),
                });
            }
        }
        Ok(out)
    }
    fn problems(&self, client: &str, path: Option<&Path>) -> Result<Vec<ide_plugin::FileProblems>, HostError> {
        let host = self.0.upgrade().ok_or(HostError::Cancelled)?;
        let root = host.project(client).map_err(failed)?.root.clone();
        let windows = host.windows_for_root(&root);
        let mut out = Vec::new();
        for file in host.mcp_reports.problems(&windows) {
            if path.is_some_and(|p| p != file.path.0) {
                continue;
            }
            if ide_plugin::resolve_new_in_root(&root, &to_ipc(&file.path.0)).is_err() {
                continue;
            }
            let mut sources: BTreeMap<String, Vec<ide_core::Diagnostic>> = BTreeMap::new();
            for d in file.items {
                sources.entry(d.server.clone().or_else(|| d.source.clone()).unwrap_or_default()).or_default().push(d);
            }
            out.extend(sources.into_iter().map(|(source, diagnostics)| ide_plugin::FileProblems {
                path: to_ipc(&file.path.0),
                source,
                diagnostics,
            }));
        }
        Ok(out)
    }

    fn projects(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = HostWorkspace::projects(self).iter().map(|p| p.root.clone()).collect();
        roots.sort();
        roots.dedup();
        roots
    }

    fn buffer_text(&self, path: &Path) -> Option<String> {
        HostWorkspace::projects(self).iter().find_map(|p| p.documents.text_of(path))
    }

    fn buffer_dirty(&self, path: &Path) -> bool {
        let Some((project, doc)) = self.open_document(path) else { return false };
        project.documents.is_dirty(doc).unwrap_or(false)
    }

    fn indexed_files(&self, root: &Path, matches: &dyn Fn(&Path) -> bool, limit: usize) -> Option<Vec<PathBuf>> {
        // The index of the project rooted at `root` (a workspace member's files are in its own).
        let project = HostWorkspace::projects(self).into_iter().find(|p| p.root == root)?;
        project.index.files_matching(root, matches, limit)
    }

    fn symbols(
        &self,
        root: &Path,
        query: &str,
        limit: usize,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<Vec<ide_plugin::SymbolInfo>, HostError> {
        let project = HostWorkspace::projects(self)
            .into_iter()
            .find(|p| p.root == root)
            .ok_or_else(|| HostError::NotFound("the project is no longer open".into()))?;
        let stopped = || cancel.is_cancelled() || Instant::now() >= deadline;
        let interrupted = || {
            if cancel.is_cancelled() {
                HostError::Cancelled
            } else {
                HostError::Failed("symbol search timed out".into())
            }
        };
        let symbols = project
            .index
            .find_symbols_until(
                query,
                ide_index::SymbolFilter::All,
                limit.min(1000),
                &|path| path.starts_with(root),
                &stopped,
            )
            .ok_or_else(interrupted)?;
        let mut out = Vec::new();
        for s in symbols {
            if stopped() {
                return Err(interrupted());
            }
            out.push(ide_plugin::SymbolInfo {
                name: s.name,
                kind: serde_json::to_value(s.kind)
                    .ok()
                    .and_then(|k| k.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "unknown".into()),
                container: s.container,
                location: ide_plugin::Location { path: s.path.0, range: s.range },
            });
        }
        if stopped() {
            return Err(interrupted());
        }
        Ok(out)
    }

    fn document(&self, path: &Path) -> Option<(u64, String)> {
        let (project, doc) = self.open_document(path)?;
        let snap = project.documents.snapshot(doc).ok()?;
        Some((u64::from(snap.version), snap.text))
    }

    fn apply_edits(&self, path: &Path, version: u64, edits: &[TextEdit]) -> Result<u64, HostError> {
        let (project, doc) =
            self.open_document(path).ok_or_else(|| HostError::NotFound(format!("{} is not open", path.display())))?;
        let version = u32::try_from(version).map_err(|_| HostError::Stale)?;
        match project.documents.apply_edits_at(doc, version, edits) {
            Ok(Some(v)) => Ok(u64::from(v)),
            Ok(None) => Err(HostError::Stale),
            Err(e) if e.kind == ide_core::error::ErrorKind::InvalidInput => Err(HostError::Invalid(e.message)),
            Err(e) => Err(HostError::Failed(e.message)),
        }
    }

    fn trusted(&self, root: &Path) -> bool {
        HostWorkspace::projects(self).iter().any(|p| p.root == root && p.is_trusted())
    }

    fn project_of(&self, window: &str) -> Option<PathBuf> {
        self.0.upgrade()?.project(window).ok().map(|p| p.root.clone())
    }

    fn project_windows(&self, root: &Path) -> Vec<String> {
        let Some(host) = self.0.upgrade() else { return Vec::new() };
        let mut windows = host.windows_for_root(root);
        host.mcp_reports.most_recently_focused_first(&mut windows);
        windows
    }

    fn publish_diagnostics(
        &self,
        source: &str,
        path: &Path,
        items: Vec<ide_core::Diagnostic>,
    ) -> Result<(), HostError> {
        let projects = HostWorkspace::projects(self);
        let project = projects
            .iter()
            .filter(|p| path.starts_with(&p.root))
            .max_by_key(|p| p.root.as_os_str().len())
            .ok_or_else(|| HostError::Invalid(format!("{} is not in an open project", path.display())))?;
        project.sink.emit(ide_core::IdeEvent::Diagnostics {
            path: path.to_path_buf().into(),
            source: format!("plugin:{source}"),
            items,
        });
        Ok(())
    }

    fn vcs_encoding(&self, path: &Path) -> ide_vcs::TextEncoding {
        HostWorkspace::projects(self)
            .into_iter()
            .filter(|p| path.starts_with(&p.root))
            .max_by_key(|p| p.root.as_os_str().len())
            .and_then(|p| p.vcs_encoding(path, None).ok())
            .unwrap_or_else(|| encoding_rs::UTF_8.into())
    }

    fn plugin_settings(&self, plugin: &str, root: Option<&Path>) -> serde_json::Map<String, serde_json::Value> {
        let Some(host) = self.0.upgrade() else { return serde_json::Map::new() };
        let settings = match root.and_then(|r| host.projects().into_iter().find(|p| p.root == r)) {
            Some(p) => p.settings.effective(),
            None => host.global_settings.effective(),
        };
        settings.plugins.get(plugin).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(dir: &Path, pins: Arc<RwLock<HashMap<(String, String), ProgramPin>>>) -> PluginApi {
        let manifest = ide_extension::Manifest::parse(
            "id = \"acme.lint\"\nname = \"Lint\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n",
        )
        .unwrap();
        let sink: Arc<dyn PluginEventSink> = Arc::new(|_: Option<&str>, _: PluginEvent| {});
        let shared = Shared::new(
            sink,
            dir.join(".data"),
            pins,
            ide_extension::UiStore::new(),
            Arc::default(),
            Arc::new(ide_extension::ExtensionRegistry::new()),
        );
        PluginApi { pkg: Package::new(manifest, dir.to_path_buf()), shared }
    }

    #[test]
    fn net_questions_are_exclusive_throttled_and_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let mut api = api(dir.path(), Arc::default());
        api.pkg = Package::new(
            ide_extension::Manifest::parse(
                "id = \"acme.lint\"\nname = \"Lint\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.5\"\n[capabilities]\nrequired = [\"net:ask\"]\n",
            ).unwrap(),
            dir.path().to_path_buf(),
        );
        let subject = Subject::Installed(api.id().into());
        api.shared.ledger.lock().confirm(
            &ide_extension::ledger::Request {
                subject: subject.clone(),
                plugin_id: api.id(),
                version: "1.0.0",
                package_hash: "h",
                required: vec![Capability::NetAsk],
                optional: vec![],
            },
            &[],
            BTreeMap::new(),
        );
        for answer in [Some(vec!["always".into(), "once".into()]), None] {
            api.shared.net_prompts.lock().clear();
            let cancel = CancellationToken::new();
            std::thread::scope(|scope| {
                let run = scope.spawn(|| api.net_ask(&subject, Some("main"), "::1", &cancel));
                let deadline = Instant::now() + Duration::from_secs(5);
                let id = loop {
                    if let Some(id) = api.shared.prompts.lock().keys().next().copied() {
                        break id;
                    }
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(10));
                };
                assert_eq!(api.net_ask(&subject, Some("other"), "other.example", &cancel).unwrap(), None);
                if let Some(answer) = answer {
                    assert!(api.shared.answer_prompt(id, Some(answer)));
                    assert_eq!(run.join().unwrap().unwrap(), None);
                } else {
                    cancel.cancel();
                    assert!(matches!(run.join().unwrap(), Err(HostError::Cancelled)));
                }
            });
            assert!(api.shared.prompts.lock().is_empty());
            assert!(api.shared.ledger.lock().get(&subject).unwrap().net_hosts.is_empty());
            assert_eq!(api.net_ask(&subject, Some("main"), "new.example", &CancellationToken::new()).unwrap(), None);
        }
    }

    #[cfg(unix)]
    #[test]
    fn writes_recheck_approved_paths_after_symlink_substitution() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let api = api(tmp.path(), Arc::default());
        let root = tmp.path().join("project");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let path = ide_plugin::resolve_writable_in_root(&root, "nested/file.txt").unwrap();
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, "unchanged").unwrap();
        symlink(&outside, &path).unwrap();
        assert!(api.write_text_file(&path, "text").is_err());
        assert!(api.write_bytes_file(&path, b"bytes").is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "unchanged");

        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(root.join("nested")).unwrap();
        symlink(tmp.path(), root.join("nested")).unwrap();
        assert!(api.write_text_file(&path, "text").is_err());
        assert!(api.write_bytes_file(&path, b"bytes").is_err());
        assert!(!tmp.path().join("file.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn storage_and_secrets_do_not_write_through_temporary_symlinks() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let api = api(tmp.path(), Arc::default());
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, "unchanged").unwrap();
        let dir = api.storage().unwrap();
        let entry = dir.join(entry_name("key"));
        symlink(&outside, entry.with_extension("tmp")).unwrap();
        symlink(&outside, &entry).unwrap();
        api.storage_set("key", Some("value".into())).unwrap();
        assert_eq!(api.storage_get("key").unwrap().as_deref(), Some("value"));
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "unchanged");

        let secrets = FileSecretStore { dir: tmp.path().join("secrets") };
        secrets.set("acme.lint", "key", Some("before")).unwrap();
        symlink(&outside, secrets.file("acme.lint").with_extension("tmp")).unwrap();
        secrets.set("acme.lint", "key", Some("after")).unwrap();
        assert_eq!(secrets.get("acme.lint", "key").as_deref(), Some("after"));
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "unchanged");
    }

    #[cfg(unix)]
    #[test]
    fn storage_and_secrets_refuse_symlinked_private_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let api = api(tmp.path(), Arc::default());
        let dir = api.storage().unwrap();
        std::fs::remove_dir(&dir).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, &dir).unwrap();
        assert!(api.storage_set("key", Some("value".into())).is_err());
        let secrets = FileSecretStore { dir: tmp.path().join("secrets") };
        std::fs::create_dir(&secrets.dir).unwrap();
        std::os::unix::fs::symlink(&outside, secrets.dir.join("acme.lint")).unwrap();
        assert!(secrets.set("acme.lint", "key", Some("value")).is_err());
        assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn private_directory_matches_resolved_write_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let api = api(tmp.path(), Arc::default());
        let dir = api.plugin_dir().unwrap();
        let verbatim = std::fs::canonicalize(&dir).unwrap();
        for root in [&dir, &verbatim] {
            let path = ide_plugin::resolve_new_in_root(root, "state.txt").unwrap();
            assert!(path.starts_with(&dir), "private writes must use the private-directory branch");
            api.write_text_file(&path, "text").unwrap();
            api.write_bytes_file(&path, b"bytes").unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), b"bytes");
        }
    }

    #[test]
    fn storage_moves_an_older_storage_json_to_one_file_per_key() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join(".data/acme.lint/storage.json");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, r#"{"a":"1","b/c":"two"}"#).unwrap();
        let api = api(tmp.path(), Arc::default());
        assert_eq!(api.storage_keys("").unwrap(), ["a", "b/c"]);
        assert_eq!(api.storage_get("b/c").unwrap().as_deref(), Some("two"));
        assert!(!legacy.exists());
        api.storage_set("a", Some("3".into())).unwrap();
        api.storage_set("b/c", None).unwrap();
        assert_eq!(api.storage_keys("").unwrap(), ["a"]);
        assert_eq!(api.storage_get("a").unwrap().as_deref(), Some("3"));
        assert_eq!(api.storage_get("b/c").unwrap(), None);
    }

    #[test]
    fn storage_keeps_multimegabyte_indexes_after_host_recreation() {
        let tmp = tempfile::tempdir().unwrap();
        let value = "é".repeat(2 << 20);
        {
            let api = api(tmp.path(), Arc::default());
            api.storage_set("index", Some(value.clone())).unwrap();
        }
        let api = api(tmp.path(), Arc::default());
        assert_eq!(api.storage_get("index").unwrap().as_deref(), Some(value.as_str()));
        api.storage_set("index", None).unwrap();
        assert_eq!(api.storage_get("index").unwrap(), None);
    }

    #[test]
    fn storage_quota_counts_utf8_keys_and_values_and_preserves_data_on_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let api = api(tmp.path(), Arc::default());
        let key = "index";
        let mut value = "é".repeat(((64 << 20) - key.len()) / 2);
        value.push('x');
        api.storage_set(key, Some(value.clone())).unwrap();

        for (key, value) in [("x", String::new()), (key, format!("{value}x"))] {
            let err = api.storage_set(key, Some(value)).unwrap_err();
            assert!(matches!(err, HostError::Invalid(ref message) if message.contains("64 MiB")), "{err}");
        }
        assert_eq!(api.storage_keys("").unwrap(), [key]);
        assert_eq!(api.storage_get(key).unwrap().as_deref(), Some(value.as_str()));
        api.storage_set(key, Some("small".into())).unwrap();
        api.storage_set("other", Some("value".into())).unwrap();
        assert_eq!(api.storage_get("other").unwrap().as_deref(), Some("value"));
    }

    #[test]
    fn notification_actions_run_the_plugins_own_commands() {
        let tmp = tempfile::tempdir().unwrap();
        let api = api(tmp.path(), Arc::default());
        let _command = api.shared.ui.insert(ide_extension::UiContribution {
            plugin_id: api.id().into(),
            point: "commands".into(),
            key: "run".into(),
            decl: serde_json::json!({}),
        });
        let action = |command: &str| ide_plugin::NotificationAction {
            label: "Run".into(),
            command: command.into(),
            argument: Some("a\nb".into()),
        };
        let notify = |actions| api.notify(Some("main"), NotificationLevel::Info, "Done".into(), "".into(), actions);
        notify(vec![]).unwrap();
        notify(vec![action("run")]).unwrap();
        assert!(matches!(notify(vec![action("run"), action("other.command")]), Err(HostError::NotFound(_))));
    }

    #[test]
    fn repository_and_search_paths_match_ipc_events() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).arg(tmp.path()).status().unwrap().success());
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        let file = root.join("src/Example.java");
        std::fs::write(&file, "class Example {}\n").unwrap();
        let api = api(&root, Arc::default());
        assert_eq!(api.find_files(&root, "**/*.java", 8).unwrap(), [to_ipc(&file)]);
        assert_eq!(api.vcs_status(&root).unwrap().unwrap().root, to_ipc(&root));
    }

    /// A project index that lists `files` (root-relative), whatever is on disk.
    struct Indexed(PathBuf, Vec<&'static str>);
    impl PluginWorkspace for Indexed {
        fn projects(&self) -> Vec<PathBuf> {
            vec![self.0.clone()]
        }
        fn buffer_text(&self, _: &Path) -> Option<String> {
            None
        }
        fn document(&self, _: &Path) -> Option<(u64, String)> {
            None
        }
        fn apply_edits(&self, _: &Path, _: u64, _: &[TextEdit]) -> Result<u64, HostError> {
            Err(HostError::Stale)
        }
        fn trusted(&self, _: &Path) -> bool {
            true
        }
        fn project_of(&self, _: &str) -> Option<PathBuf> {
            None
        }
        fn publish_diagnostics(&self, _: &str, _: &Path, _: Vec<ide_core::Diagnostic>) -> Result<(), HostError> {
            Ok(())
        }
        fn indexed_files(&self, root: &Path, matches: &dyn Fn(&Path) -> bool, limit: usize) -> Option<Vec<PathBuf>> {
            (root == self.0).then(|| {
                self.1.iter().map(Path::new).filter(|rel| matches(rel)).take(limit).map(|rel| root.join(rel)).collect()
            })
        }
    }

    #[test]
    fn find_files_uses_the_project_index_when_there_is_one() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let api = api(&root, Arc::default());
        *api.shared.workspace.write() = Some(Arc::new(Indexed(
            root.clone(),
            vec!["src/b/UserMapper.xml", "src/a/OrderMapper.xml", ".idea/workspace.xml", ".git/index.xml", "pom.xml"],
        )));
        // Listed by the index, not walked: none of these exist on disk.
        assert_eq!(
            api.find_files(&root, "**/*Mapper.xml", 10).unwrap(),
            [to_ipc(&root.join("src/a/OrderMapper.xml")), to_ipc(&root.join("src/b/UserMapper.xml"))]
        );
        // Hidden folders are visited like any project scope; `.git` internals are not.
        assert_eq!(api.find_files(&root, "**/*.xml", 10).unwrap().len(), 4);
        assert_eq!(api.find_files(&root, ".idea/*.xml", 10).unwrap(), [to_ipc(&root.join(".idea/workspace.xml"))]);
        assert_eq!(api.find_files(&root, "**/*.xml", 1).unwrap().len(), 1);
        // Another root: no index covers it, so the disk is walked.
        let other = root.join("other");
        std::fs::create_dir_all(other.join(".config/tool")).unwrap();
        std::fs::write(other.join("a.xml"), "").unwrap();
        std::fs::write(other.join(".config/tool/index.xml"), "").unwrap();
        assert_eq!(api.find_files(&other, "*.xml", 10).unwrap(), [to_ipc(&other.join("a.xml"))]);
        assert_eq!(
            api.find_files(&other, ".config/tool/*.xml", 10).unwrap(),
            [to_ipc(&other.join(".config/tool/index.xml"))]
        );
    }

    #[test]
    fn process_environment_only_adds_variables() {
        let tmp = tempfile::tempdir().unwrap();
        // Environment overrides must be rejected before spawn, so no executable is needed.
        let binary = tmp.path().join("lint.exe");
        std::fs::write(&binary, "not an executable").unwrap();
        let pins: Arc<RwLock<HashMap<(String, String), ProgramPin>>> = Arc::default();
        pins.write().insert(("acme.lint".into(), "process:lint".into()), ProgramPin::approve(&binary).unwrap());
        let api = api(tmp.path(), pins);
        let inherited = std::env::vars_os()
            .find(|(key, _)| {
                !env_name_eq(key, "PATH".as_ref())
                    && key.to_str().is_some_and(|key| !key.is_empty() && !key.contains('='))
            })
            .unwrap()
            .0
            .into_string()
            .unwrap();
        for key in ["PATH".to_owned(), inherited] {
            let cmd = ProcessCommand {
                program: "lint".into(),
                env: vec![(key.clone(), "replacement".into())],
                ..Default::default()
            };
            let err = api
                .run_process(cmd.clone(), None, None, &CancellationToken::new(), Duration::from_secs(5))
                .unwrap_err();
            assert!(matches!(err, HostError::Invalid(ref message) if message.contains(&key)), "{err}");
            let err = api.start_process(cmd, None, None).unwrap_err();
            assert!(matches!(err, HostError::Invalid(ref message) if message.contains(&key)), "{err}");
        }
    }

    #[test]
    fn process_environment_uses_prepared_values_and_windows_key_rules() {
        let mut cmd = StdCommand::new("unused");
        ide_core::process::prepare(&mut cmd);
        cmd.env("OPENIDEA_PREPARED_ENV", "login-shell");
        let err = append_process_env(&mut cmd, &[("OPENIDEA_PREPARED_ENV".into(), "override".into())]).unwrap_err();
        assert!(err.to_string().contains("OPENIDEA_PREPARED_ENV"));
        for name in ["", "BAD=KEY", "BAD\0KEY"] {
            assert!(append_process_env(&mut cmd, &[(name.into(), "value".into())]).is_err());
        }
        for value in ["bad\0value".to_owned(), "x".repeat(4097)] {
            assert!(append_process_env(&mut cmd, &[("OPENIDEA_NEW_ENV".into(), value)]).is_err());
        }
        assert!(
            append_process_env(
                &mut cmd,
                &[("OPENIDEA_NEW_ENV".into(), "a".into()), ("OPENIDEA_NEW_ENV".into(), "b".into())]
            )
            .is_err()
        );
        assert_eq!(env_name_eq("PATH".as_ref(), "Path".as_ref()), cfg!(windows));
        #[cfg(windows)]
        {
            assert!(append_process_env(&mut cmd, &[("pAtH".into(), "override".into())]).is_err());
            assert!(env_name_eq("Ä_KEY".as_ref(), "ä_key".as_ref()));
        }
        cmd.env_remove("OPENIDEA_REMOVED_ENV");
        append_process_env(&mut cmd, &[("OPENIDEA_REMOVED_ENV".into(), "added".into())]).unwrap();
        assert_eq!(cmd.get_envs().find(|(k, _)| *k == "OPENIDEA_REMOVED_ENV").unwrap().1, Some("added".as_ref()));
    }

    #[test]
    fn process_output_preserves_partial_utf8_and_bounds_replacement_text() {
        let mut bytes = vec![0xe4, 0xb8];
        assert_eq!(take_text(&mut bytes, 1, false), "");
        bytes.extend_from_slice(&[0xad, b'x']);
        assert_eq!(take_text(&mut bytes, 1, false), "中");
        assert_eq!(take_text(&mut bytes, 0, false), "x");
        let mut bytes = vec![0xff; MAX_PENDING];
        let text = take_text(&mut bytes, MAX_PENDING, true);
        assert!(text.len() <= MAX_PENDING);
        assert!(!bytes.is_empty());
        assert_eq!(take_text(&mut vec![0xe4, 0xb8], 8, true), "�");
    }

    #[cfg(unix)]
    fn shell_api(dir: &Path) -> PluginApi {
        let pins: Arc<RwLock<HashMap<(String, String), ProgramPin>>> = Arc::default();
        pins.write()
            .insert(("acme.lint".into(), "process:sh".into()), ProgramPin::approve(Path::new("/bin/sh")).unwrap());
        api(dir, pins)
    }

    #[cfg(unix)]
    fn shell(script: &str) -> ProcessCommand {
        ProcessCommand {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            env: Vec::new(),
            approval_root: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn process_handles_are_bounded_scoped_and_released() {
        let tmp = tempfile::tempdir().unwrap();
        let api = shell_api(tmp.path());
        let mut ids = Vec::new();
        for _ in 0..MAX_PROCESSES {
            ids.push(api.start_process(shell("exec cat"), None, Some("main")).unwrap());
        }
        assert!(matches!(api.start_process(shell("exec cat"), None, None), Err(HostError::Invalid(_))));
        let proc = api.process(ids[0]).unwrap();
        api.release_process(ids[0]);
        assert!(proc.state.lock().child.try_wait().unwrap().is_some());
        assert!(api.process(ids[0]).is_err());
        let other = api.start_process(shell("exec cat"), None, Some("other")).unwrap();
        api.shared.forget_client("main");
        assert!(api.process(ids[1]).is_err());
        assert!(api.process(other).is_ok());
        assert!(matches!(api.start_process(shell("exec cat"), None, Some("main")), Err(HostError::Cancelled)));
        api.shared.kill_processes(api.id());
        assert!(api.shared.processes.lock().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn process_stdin_timeout_and_stop_do_not_deadlock() {
        let tmp = tempfile::tempdir().unwrap();
        let api = Arc::new(shell_api(tmp.path()));
        for stop in [false, true] {
            let id = api.start_process(shell("exec sleep 60"), None, Some("main")).unwrap();
            let proc = api.process(id).unwrap();
            let writer = api.clone();
            let thread = std::thread::spawn(move || {
                writer.write_process(id, &"x".repeat(1 << 20), &CancellationToken::new(), Duration::from_millis(150))
            });
            if stop {
                std::thread::sleep(Duration::from_millis(30));
                api.shared.kill_processes(api.id());
            }
            assert!(thread.join().unwrap().is_err());
            assert!(proc.state.lock().child.try_wait().unwrap().is_some());
            api.release_process(id);
        }
    }

    #[cfg(unix)]
    #[test]
    fn process_parent_exit_closes_descendant_pipes() {
        let tmp = tempfile::tempdir().unwrap();
        let api = shell_api(tmp.path());
        let token = CancellationToken::new();
        let before = Instant::now();
        let out =
            api.run_process(shell("sleep 60 & echo done"), None, None, &token, Duration::from_millis(300)).unwrap();
        assert_eq!(out.status, Some(0));
        assert_eq!(out.stdout.trim(), "done");
        assert!(before.elapsed() < Duration::from_secs(5));
        let id = api.start_process(shell("sleep 60 & echo done"), None, None).unwrap();
        let out = api.wait_process(id, MAX_PENDING, Duration::from_millis(300), &token).unwrap();
        assert_eq!(out.status, Some(0));
        assert_eq!(out.stdout.trim(), "done");
        assert_eq!(api.process(id).unwrap().state.lock().readers, 0);
        api.release_process(id);
    }

    #[cfg(unix)]
    #[test]
    fn process_output_is_drained_and_retention_is_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let api = shell_api(tmp.path());
        let token = CancellationToken::new();
        let cmd = shell("head -c 5242880 /dev/zero; head -c 5242880 /dev/zero >&2");
        let out = api.run_process(cmd.clone(), None, None, &token, Duration::from_secs(5)).unwrap();
        assert_eq!(out.status, Some(0));
        assert_eq!((out.stdout.len(), out.stderr.len()), (MAX_OUTPUT, MAX_OUTPUT));
        let id = api.start_process(cmd, None, None).unwrap();
        let out = api.wait_process(id, MAX_PENDING, Duration::from_secs(5), &token).unwrap();
        assert_eq!(out.status, Some(0));
        assert_eq!((out.stdout.len(), out.stderr.len()), (MAX_PENDING, MAX_PENDING));
        let state = api.process(id).unwrap();
        let state = state.state.lock();
        assert!(state.stdout.is_empty() && state.stderr.is_empty());
        drop(state);
        api.release_process(id);
    }

    #[test]
    fn programs_run_only_as_approved() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("lint");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let pins: Arc<RwLock<HashMap<(String, String), ProgramPin>>> = Arc::default();
        let api = api(tmp.path(), pins.clone());

        // Allowed while the program was missing: say how to fix it rather than "not granted".
        let err = api.approved_program("lint").unwrap_err().to_string();
        assert!(
            err.contains("was not found on PATH when this permission was allowed")
                && err.contains("clear process:lint in Settings › Plugins and select it again"),
            "{err}"
        );

        pins.write().insert(("acme.lint".into(), "process:lint".into()), ProgramPin::approve(&bin).unwrap());
        assert_eq!(api.approved_program("lint").unwrap(), bin);

        std::fs::write(&bin, "#!/bin/sh\necho replaced\n").unwrap();
        assert!(
            matches!(api.approved_program("lint"), Err(HostError::Denied(e)) if e.contains("changed since it was approved"))
        );
    }
    #[test]
    fn redirects_check_grants_before_connecting_and_downgrades_require_http() {
        assert_eq!(
            redirect_capability(&"https://localhost/start".parse().unwrap(), &"http://localhost/end".parse().unwrap())
                .unwrap(),
            Capability::NetHttp("localhost".into())
        );
        let source = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let source_port = source.local_addr().unwrap().port();
        let target_port = target.local_addr().unwrap().port();
        let worker = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = source.accept().unwrap();
            let mut buf = [0; 4096];
            let _ = stream.read(&mut buf);
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target_port}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let api = api(dir.path(), Arc::default());
        let result = api.fetch(
            HttpRequest {
                method: "GET".into(),
                url: format!("http://localhost:{source_port}/"),
                headers: Vec::new(),
                body: None,
                timeout: Duration::from_secs(2),
                grants: vec![Capability::Net("localhost".into())],
            },
            &CancellationToken::new(),
        );
        assert!(matches!(result, Err(HostError::Denied(cap)) if cap == "net:127.0.0.1"));
        assert!(target.accept().is_err(), "ungranted target must never receive a connection");
        worker.join().unwrap();
    }

    #[test]
    fn output_ring_keeps_utf8_and_is_withdrawn_on_stop() {
        let dir = tempfile::tempdir().unwrap();
        let api = api(dir.path(), Arc::default());
        api.output_write("build", Some(&"😀".repeat(300_000))).unwrap();
        let buffer = api.shared.output.lock().get(&(api.id().into(), "build".into())).cloned().unwrap();
        assert_eq!(buffer.len(), 1 << 20);
        api.output_write("build", Some("x")).unwrap();
        let buffer = api.shared.output.lock().get(&(api.id().into(), "build".into())).cloned().unwrap();
        assert!(buffer.len() <= 1 << 20 && buffer.ends_with('x'));
        api.output_write("build", None).unwrap();
        assert!(api.shared.output.lock().get(&(api.id().into(), "build".into())).unwrap().is_empty());
        api.shared.clear_plugin(api.id(), true);
        assert!(api.shared.output.lock().is_empty());
    }
}

/// The window a user action invoked the plugin from: browser tabs and clipboard writes
/// follow what the user did, never background work (which would reach every window).
fn from_window<'a>(client: Option<&'a str>, what: &str) -> Result<&'a str, HostError> {
    client.ok_or_else(|| HostError::Invalid(format!("can only {what} from a command the user invoked")))
}

/// `url` without the `user:password@` a remote may carry (`https://user:token@host/…`):
/// `vcs.read` must not hand out credentials. scp-style `git@host:path` has no password.
fn without_credentials(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return url.to_owned() };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => url.to_owned(),
    }
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    #[test]
    fn remote_urls_lose_their_credentials() {
        for (url, expected) in [
            ("https://user:ghp_token@github.com/o/r.git", "https://github.com/o/r.git"),
            ("https://token@gitlab.com/o/r", "https://gitlab.com/o/r"),
            ("ssh://git@host:2222/o/r.git", "ssh://host:2222/o/r.git"),
            ("https://github.com/o/r.git", "https://github.com/o/r.git"),
            ("https://github.com/o/r@v1", "https://github.com/o/r@v1"),
            ("git@github.com:o/r.git", "git@github.com:o/r.git"),
            ("/srv/git/r.git", "/srv/git/r.git"),
        ] {
            assert_eq!(without_credentials(url), expected, "{url}");
        }
        assert!(matches!(from_window(None, "open a URL"), Err(HostError::Invalid(_))));
        assert_eq!(from_window(Some("main"), "open a URL").unwrap(), "main");
    }
}

fn valid_range(document: &ide_text::Document, range: ide_core::Range) -> bool {
    range.start <= range.end
        && [range.start, range.end].into_iter().all(|pos| document.byte_to_pos(document.pos_to_byte(pos)) == pos)
}

impl PluginApi {
    fn read_repo(&self, root: &Path) -> Result<Option<ide_vcs::Repo>, HostError> {
        if !self.shared.workspace().is_some_and(|w| w.trusted(root)) {
            return Err(HostError::Failed("the project is in Restricted Mode: git does not run there".into()));
        }
        let repo = ide_vcs::Repo::discover(root).map_err(failed)?;
        if let Some(repo) = &repo {
            repo.set_execution_allowed(false);
        }
        Ok(repo)
    }
    fn set_decorations(
        &self,
        path: Option<&Path>,
        set: &str,
        mut items: Vec<ide_plugin::Decoration>,
        file: Option<ide_plugin::FileDecoration>,
        tree: bool,
    ) -> Result<(), HostError> {
        if set.is_empty() || set.len() > 128 {
            return Err(HostError::Invalid("set id must be 1-128 bytes".into()));
        }
        if items.len() > 10_000 || file.as_ref().and_then(|f| f.badge.as_ref()).is_some_and(|b| b.chars().count() > 2) {
            return Err(HostError::Invalid("decoration limit exceeded".into()));
        }
        items.retain(|d| decoration_style(&d.style));
        if items.iter().any(|d| d.range.start > d.range.end) {
            return Err(HostError::Invalid("reversed decoration range".into()));
        }
        let replacement = if let Some(path) = path {
            let workspace = self.shared.workspace().ok_or_else(|| HostError::NotFound("no project open".into()))?;
            let (root, real) = workspace
                .projects()
                .into_iter()
                .filter_map(|root| ide_plugin::resolve_new_in_root(&root, &to_ipc(path)).ok().map(|real| (root, real)))
                .max_by_key(|(root, _)| root.components().count())
                .ok_or_else(|| HostError::Invalid("path outside open projects".into()))?;
            Some(super::DecorationSet {
                root: root.into(),
                path: real.into(),
                set_id: set.into(),
                tree,
                items,
                file: file.filter(|f| decoration_style(&f.style)),
            })
        } else {
            None
        };
        let mut all = self.shared.decorations.lock();
        let mut sets = all.get(self.id()).cloned().unwrap_or_default();
        sets.retain(|s| !(s.tree == tree && s.set_id == set && replacement.as_ref().is_none_or(|r| r.path == s.path)));
        if let Some(replacement) = replacement {
            sets.push(replacement);
        }
        let names: BTreeSet<_> = sets.iter().filter(|s| s.tree == tree).map(|s| &s.set_id).collect();
        if names.len() > 50 || serde_json::to_vec(&sets).map_err(failed)?.len() > 4 << 20 {
            return Err(HostError::Invalid("decoration sets exceed plugin limits".into()));
        }
        // A plugin may spread one file's annotations across sets, but the combined limit is fixed.
        let mut counts = BTreeMap::new();
        for s in &sets {
            *counts.entry(&s.path).or_insert(0usize) += s.items.len();
        }
        if counts.values().any(|n| *n > 10_000) {
            return Err(HostError::Invalid("at most 10000 decorations per file".into()));
        }
        all.insert(self.id().into(), sets.clone());
        // Emit while holding the state lock so replacement snapshots cannot arrive out of order.
        self.shared.sink.emit(None, PluginEvent::DecorationsChanged { plugin_id: self.id().into(), sets });
        Ok(())
    }
}
fn decoration_style(style: &str) -> bool {
    matches!(
        style,
        "highlight"
            | "search"
            | "added"
            | "modified"
            | "removed"
            | "warning"
            | "error"
            | "info"
            | "underline"
            | "strikethrough"
            | "muted"
    )
}
impl Shared {
    pub(super) fn decoration_sets(&self) -> BTreeMap<String, Vec<super::DecorationSet>> {
        self.decorations.lock().clone()
    }
}

#[cfg(test)]
mod workbench_tests {
    use super::*;
    struct Workspace {
        root: PathBuf,
        trusted: bool,
        text: Option<String>,
    }
    impl PluginWorkspace for Workspace {
        fn projects(&self) -> Vec<PathBuf> {
            vec![self.root.clone()]
        }
        fn buffer_text(&self, _: &Path) -> Option<String> {
            self.text.clone()
        }
        fn document(&self, _: &Path) -> Option<(u64, String)> {
            self.text.clone().map(|s| (1, s))
        }
        fn apply_edits(&self, _: &Path, _: u64, _: &[TextEdit]) -> Result<u64, HostError> {
            Err(HostError::Stale)
        }
        fn trusted(&self, _: &Path) -> bool {
            self.trusted
        }
        fn project_of(&self, _: &str) -> Option<PathBuf> {
            Some(self.root.clone())
        }
        fn publish_diagnostics(&self, _: &str, _: &Path, _: Vec<ide_core::Diagnostic>) -> Result<(), HostError> {
            Ok(())
        }
        fn open_editors(&self, client: &str) -> Result<Vec<ide_plugin::OpenEditor>, HostError> {
            Ok(if client == "main" {
                vec![ide_plugin::OpenEditor {
                    path: to_ipc(&self.root.join("a.txt")),
                    language: "text".into(),
                    active: true,
                    dirty: true,
                }]
            } else {
                Vec::new()
            })
        }
    }
    fn api(root: &Path, trusted: bool, text: Option<&str>) -> PluginApi {
        let manifest = ide_extension::Manifest::parse(
            "id = \"test\"\nname = \"Test\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.4\"\n",
        )
        .unwrap();
        let shared = Shared::new(
            Arc::new(|_: Option<&str>, _: PluginEvent| {}),
            root.join(".data"),
            Arc::default(),
            ide_extension::UiStore::new(),
            Arc::default(),
            Arc::new(ide_extension::ExtensionRegistry::new()),
        );
        *shared.workspace.write() =
            Some(Arc::new(Workspace { root: root.into(), trusted, text: text.map(str::to_owned) }));
        PluginApi { pkg: Package::new(manifest, root.into()), shared }
    }
    #[test]
    fn command_exemption_requires_a_declared_unambiguous_owner() {
        let dir = tempfile::tempdir().unwrap();
        let api = api(dir.path(), true, None);
        let own = api.shared.ui.insert(ide_extension::UiContribution {
            plugin_id: "test".into(),
            point: super::super::COMMANDS.into(),
            key: "other.run".into(),
            decl: serde_json::json!({}),
        });
        assert!(api.owns_command("plugin.test.other.run"));
        assert!(!api.owns_command("plugin.test.unknown"));
        let other = api.shared.ui.insert(ide_extension::UiContribution {
            plugin_id: "test.other".into(),
            point: super::super::COMMANDS.into(),
            key: "run".into(),
            decl: serde_json::json!({}),
        });
        assert!(!api.owns_command("plugin.test.other.run"));
        drop(other);
        assert!(api.owns_command("plugin.test.other.run"));
        drop(own);
    }
    #[test]
    fn selections_validate_window_and_utf16_without_requiring_a_grant() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let path = root.join("a.txt");
        let api = api(&root, true, Some("😀abc"));
        let range = |col| ide_core::Range::point(ide_core::Pos::new(0, col));
        assert!(api.editor_ranges("main", &path, vec![range(2)], false).is_ok());
        assert!(api.editor_ranges("main", &path, vec![range(1)], true).is_err());
        assert!(api.editor_ranges("other", &path, vec![range(2)], false).is_err());
    }
    #[test]
    fn decoration_sets_validate_paths_limits_and_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let path = root.join("a.txt");
        std::fs::write(&path, "text").unwrap();
        let api = api(&root, true, None);
        let item = |style: &str| ide_plugin::Decoration {
            range: ide_core::Range::default(),
            style: style.into(),
            hover: None,
            after: Some("after".into()),
        };
        api.decorations(Some(&path), "set", vec![item("highlight"), item("unknown")]).unwrap();
        assert_eq!(api.shared.decoration_sets()["test"][0].items.len(), 1);
        assert!(api.decorations(Some(&root.join("../outside.txt")), "set", vec![]).is_err());
        api.decorations(None, "set", vec![]).unwrap();
        for i in 0..50 {
            api.decorations(Some(&path), &format!("s{i}"), vec![]).unwrap();
        }
        assert!(api.decorations(Some(&path), "overflow", vec![]).is_err());
        api.decorations(Some(&path), "s0", vec![item("info"); 10_000]).unwrap();
        assert!(api.decorations(Some(&path), "s1", vec![item("info")]).is_err());
        assert!(
            api.file_decorations(
                Some(&path),
                "tree",
                Some(ide_plugin::FileDecoration { badge: Some("abc".into()), style: "info".into(), tooltip: None })
            )
            .is_err()
        );
        api.shared.clear_plugin("test", true);
        assert!(api.shared.decoration_sets().is_empty());
    }
    fn git(root: &Path, args: &[&str]) {
        let out = StdCommand::new("git").current_dir(root).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
    #[test]
    fn vcs_reads_reuse_history_and_dirty_blame_and_require_trust() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        let path = root.join("a.txt");
        std::fs::write(&path, "committed\nsecond\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "Subject\n\nBody"]);
        std::fs::write(&path, "disk\nsecond\n").unwrap();
        let api = api(&root, true, Some("unsaved\nsecond\nnew\n"));
        let cancel = CancellationToken::new();
        let history = api.vcs_log(&root, Some("a.txt"), 10, &cancel).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].subject, "Subject");
        assert_eq!(history[0].body.trim(), "Body");
        assert!(history[0].date > 0);
        let lines = api.vcs_blame(None, &root, "a.txt").unwrap();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].commit.bytes().all(|b| b == b'0'));
        assert_eq!(lines[1].commit, history[0].id);
        assert_eq!(lines[2].line, 2);
        let patch = api.vcs_diff(&root, Some("a.txt"), None, &cancel).unwrap().unwrap();
        assert!(patch.contains("+disk"));
        assert!(!patch.contains("+unsaved"));
        assert!(api.vcs_diff(&root, None, Some("--output=outside"), &cancel).is_err());
        assert!(api.vcs_log(&root, Some("../outside"), 1, &cancel).is_err());
        std::fs::remove_file(&path).unwrap();
        assert_eq!(api.vcs_log(&root, Some("a.txt"), 10, &cancel).unwrap().len(), 1);
        assert!(api.vcs_diff(&root, Some("a.txt"), None, &cancel).unwrap().unwrap().contains("-committed"));
        let restricted = super::workbench_tests::api(&root, false, None);
        assert!(restricted.vcs_log(&root, None, 1, &cancel).is_err());
        assert!(restricted.vcs_blame(None, &root, "a.txt").is_err());
        assert!(restricted.vcs_diff(&root, None, None, &cancel).is_err());
        std::fs::write(&path, "x".repeat(5 << 20)).unwrap();
        assert!(api.vcs_diff(&root, None, None, &cancel).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn vcs_reads_never_run_repository_configured_helpers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "base"]);
        let marker = root.join("HELPER-RAN");
        let helper = format!("touch '{}'", marker.display());
        for key in [
            "core.fsmonitor",
            "diff.external",
            "diff.test.command",
            "diff.test.textconv",
            "filter.test.clean",
            "filter.test.process",
        ] {
            git(&root, &["config", key, &helper]);
        }
        git(&root, &["config", "filter.test.required", "true"]);
        assert!(!marker.exists(), "setup ran helper");
        std::fs::write(root.join(".gitattributes"), "*.txt diff=test filter=test\n").unwrap();
        std::fs::write(root.join("a.txt"), "changed\n").unwrap();
        let api = api(&root, true, Some("unsaved\n"));
        let cancel = CancellationToken::new();
        api.vcs_log(&root, None, 10, &cancel).unwrap();
        assert!(!marker.exists(), "log ran helper");
        api.vcs_blame(None, &root, "a.txt").unwrap();
        assert!(!marker.exists(), "blame ran helper");
        api.vcs_diff(&root, None, None, &cancel).unwrap();
        assert!(!marker.exists());
    }
}
