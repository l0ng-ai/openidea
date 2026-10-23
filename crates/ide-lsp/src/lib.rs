//! Language server manager.
//!
//! Servers start lazily per `(server name, workspace root)` when a document of
//! a matching language opens. Several servers may serve one language (e.g.
//! `vtsls` + `eslint`); results are merged. Every request takes positions in
//! IDE coordinates (UTF-16, 0-based) and returns IDE types from [`types`],
//! never `lsp-types`, so the IPC surface stays stable.

mod caps;
mod convert;
mod file_ops;
mod handler;
mod inspect;
pub mod jdtls;
mod launch;
mod server;
mod text;
pub mod types;
mod uri;
mod virtual_doc;

pub use inspect::{FileInspection, InspectHost, InspectOptions};
pub use launch::{LaunchError, Launcher, ProcessLauncher, search_path};
pub use uri::{is_virtual_uri, path_to_uri_string, uri_target, uri_to_path};

use caps::{ServerCaps, SyncKind};
use convert::{Conv, lsp_range};
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
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;
use text::{DocText, Encoding};
use types::*;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(5);
const LONG_TIMEOUT: Duration = Duration::from_secs(30);
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

struct Attached {
    server: Arc<Server>,
    /// Instance generation the document was `didOpen`ed on, if any.
    opened_gen: Option<u64>,
}

struct DocState {
    path: PathBuf,
    uri: lsp::Uri,
    language: LanguageId,
    version: i32,
    text: Arc<DocText>,
    servers: Vec<Attached>,
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
    path: PathBuf,
    uri: lsp::Uri,
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
}

pub struct LspManager {
    me: Weak<LspManager>,
    project_root: PathBuf,
    languages: Arc<LanguageRegistry>,
    sink: SharedSink,
    launcher: Arc<dyn Launcher>,
    runtime: tokio::runtime::Handle,
    servers: Mutex<Vec<Arc<Server>>>,
    docs: Mutex<HashMap<DocId, DocState>>,
    apply_edit_hook: RwLock<Option<ApplyEditHook>>,
    config_hook: RwLock<Option<ConfigHook>>,
    shutting_down: AtomicBool,
    /// `window/showMessage` texts already surfaced; servers repeat them on every restart/reconfigure.
    shown_messages: Mutex<HashSet<(String, String)>>,
    /// Virtual (non-`file:`) URIs a server returned, by the server that owns them.
    virtual_origins: Mutex<HashMap<String, ide_core::ServerId>>,
    /// Contents fetched for virtual URIs.
    virtual_docs: Mutex<HashMap<String, VirtualDocument>>,
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

fn unsupported(feature: &str) -> IdeError {
    IdeError::unavailable(format!("no running language server supports {feature}"))
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
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            project_root,
            languages,
            sink,
            launcher,
            runtime: runtime_handle(),
            servers: Mutex::new(Vec::new()),
            docs: Mutex::new(HashMap::new()),
            apply_edit_hook: RwLock::new(None),
            config_hook: RwLock::new(None),
            shutting_down: AtomicBool::new(false),
            shown_messages: Mutex::new(HashSet::new()),
            virtual_origins: Mutex::new(HashMap::new()),
            virtual_docs: Mutex::new(HashMap::new()),
        })
    }

    // ---- server lookup & lifecycle ----

    fn server_for(&self, cfg: &LanguageServerConfig, language: &LanguageId, path: &Path) -> Arc<Server> {
        let mut servers = self.servers.lock();
        let root = launch::find_root(&self.project_root, path, &cfg.root_markers).unwrap_or_else(|| {
            // Outside the project (library sources, …): reuse a running instance.
            servers
                .iter()
                .filter(|s| s.name == cfg.name)
                .min_by_key(|s| s.root != self.project_root)
                .map(|s| s.root.clone())
                .unwrap_or_else(|| self.project_root.clone())
        });
        if let Some(s) = servers.iter().find(|s| s.name == cfg.name && s.root == root) {
            s.add_language(language);
            return s.clone();
        }
        let server = Arc::new(Server::new(cfg.clone(), root, language.clone()));
        servers.push(server.clone());
        server
    }

    /// The servers serving `path`: every regular one, and each `fallback` one
    /// only while all servers listed before it are missing.
    fn servers_for(&self, language: &LanguageId, path: &Path) -> Vec<Arc<Server>> {
        let Some(cfg) = self.languages.get(language) else { return Vec::new() };
        let mut out = Vec::new();
        let mut available_before = false;
        for sc in &cfg.language_servers {
            if sc.fallback && available_before {
                continue;
            }
            let server = self.server_for(sc, language, path);
            available_before |= server.status() != ide_core::event::ServerStatus::Missing;
            out.push(server);
        }
        out
    }

    /// A server turned out to be missing: attach the fallbacks it was hiding
    /// to the open documents (and start them).
    fn attach_fallbacks(&self) {
        let open: Vec<(DocId, LanguageId, PathBuf)> =
            self.docs.lock().iter().map(|(id, d)| (*id, d.language.clone(), d.path.clone())).collect();
        let wanted: Vec<(DocId, Vec<Arc<Server>>)> =
            open.into_iter().map(|(id, language, path)| (id, self.servers_for(&language, &path))).collect();
        let mut start = Vec::new();
        {
            let mut docs = self.docs.lock();
            for (id, servers) in wanted {
                let Some(d) = docs.get_mut(&id) else { continue };
                for server in servers {
                    if d.servers.iter().any(|a| a.server.id == server.id) {
                        continue;
                    }
                    let mut attached = Attached { server: server.clone(), opened_gen: None };
                    if let Some(run) = server.running() {
                        if run.caps.read().open_close
                            && let Err(e) = run.peer.notify("textDocument/didOpen", d.did_open_params())
                        {
                            tracing::debug!("{}: didOpen: {e}", server.name);
                        }
                        attached.opened_gen = Some(run.generation);
                    }
                    d.servers.push(attached);
                    if !start.iter().any(|s: &Arc<Server>| s.id == server.id) {
                        start.push(server);
                    }
                }
            }
        }
        for server in &start {
            self.ensure_started(server);
        }
    }

    fn ensure_started(&self, server: &Arc<Server>) {
        if self.shutting_down.load(Ordering::Acquire) {
            return;
        }
        let Some(generation) = server.begin_start() else { return };
        let Some(me) = self.me.upgrade() else { return };
        let server = server.clone();
        self.runtime.spawn(async move { me.run_instance(server, generation).await });
    }

    async fn run_instance(self: Arc<Self>, server: Arc<Server>, generation: u64) {
        server.set_status(&self.sink, ide_core::event::ServerStatus::Starting, None);
        let handler = Arc::new(handler::ClientHandler::new(self.me.clone(), server.clone(), generation));
        let me = self.clone();
        let tail = server.clone();
        // The settings hook may touch the filesystem (e.g. scanning for JDKs).
        let launched = tokio::task::spawn_blocking(move || {
            let cfg = me.configured(&tail);
            tail.set_effective_config(cfg.clone());
            let root = tail.root.clone();
            if let Some(message) = &cfg.launch_error {
                // A missing binary still asks to be installed first.
                let missing = !me.launcher.available(&cfg, &root);
                return Err(if missing { LaunchError::Missing } else { LaunchError::Failed(message.clone()) });
            }
            me.launcher.launch(&cfg, &root, handler, Box::new(move |line| tail.push_stderr(line)))
        })
        .await
        .unwrap_or_else(|e| Err(LaunchError::Failed(e.to_string())));

        let peer = match launched {
            Ok(peer) => peer,
            Err(LaunchError::Missing) => {
                let cfg = server.effective_config();
                let message =
                    cfg.install_hint.clone().unwrap_or_else(|| format!("`{}` was not found on PATH", cfg.command));
                if server.finish_start(generation, Conn::Missing) {
                    server.set_status(&self.sink, ide_core::event::ServerStatus::Missing, Some(message));
                    self.attach_fallbacks();
                }
                return;
            }
            Err(LaunchError::Failed(message)) => {
                tracing::warn!("{}: {message}", server.name);
                if server.finish_start(generation, Conn::Failed) {
                    server.set_status(&self.sink, ide_core::event::ServerStatus::Crashed, Some(message));
                }
                return;
            }
        };

        let init = self.initialize_params(&server);
        let result = tokio::time::timeout(Duration::from_secs(60), peer.request::<_, Value>("initialize", init, None))
            .await
            .unwrap_or(Err(RpcError::Timeout));
        let caps = match result {
            Ok(result) => {
                if let Some(info) = result.get("serverInfo") {
                    tracing::info!("{} initialized: {info}", server.name);
                }
                ServerCaps::parse(result.get("capabilities").cloned().unwrap_or_else(|| json!({})))
            }
            Err(e) => {
                tracing::warn!("{}: initialize failed: {e}", server.name);
                peer.kill();
                // Treated like a crash so transient failures retry with backoff.
                self.spawn_supervisor(server, generation, peer);
                return;
            }
        };
        if let Err(e) = peer.notify("initialized", json!({})) {
            tracing::warn!("{}: {e}", server.name);
        }
        let run = Running { generation, peer: peer.clone(), caps: Arc::new(RwLock::new(caps)) };

        // Publish readiness and (re)open attached documents atomically w.r.t. did_change.
        {
            let mut docs = self.docs.lock();
            if !server.mark_ready(generation, run.clone()) {
                drop(docs);
                peer.kill();
                return;
            }
            let open_close = run.caps.read().open_close;
            for d in docs.values_mut() {
                let params = d.did_open_params();
                for a in d.servers.iter_mut().filter(|a| a.server.id == server.id && a.opened_gen != Some(generation)) {
                    if open_close && let Err(e) = peer.notify("textDocument/didOpen", params.clone()) {
                        tracing::debug!("{}: didOpen: {e}", server.name);
                    }
                    a.opened_gen = Some(generation);
                }
            }
        }
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
        use ide_core::event::ServerStatus;
        let intentional = match server.on_closed(generation) {
            Some(intentional) => intentional || self.shutting_down.load(Ordering::Acquire),
            None => return, // superseded instance
        };
        self.clear_server_state(&server);
        if intentional {
            return;
        }
        let tail = server.stderr_tail(5);
        let mut message = match code {
            Some(c) => format!("{} exited with code {c}", server.name),
            None => format!("{} terminated unexpectedly", server.name),
        };
        if !tail.is_empty() {
            message.push_str(":\n");
            message.push_str(&tail);
        }
        match server.record_crash() {
            Some(delay) => {
                server.set_status(&self.sink, ServerStatus::Crashed, Some(format!("{message}\nRestarting…")));
                tokio::time::sleep(delay).await;
                if server.is_idle_gen(generation) {
                    self.ensure_started(&server);
                }
            }
            None => {
                server.give_up(generation);
                server.set_status(
                    &self.sink,
                    ServerStatus::Crashed,
                    Some(format!("{message}\nCrashed repeatedly; restart it manually.")),
                );
            }
        }
    }

    /// Ends progress tasks and withdraws diagnostics of a dead instance.
    fn clear_server_state(&self, server: &Server) {
        for (id, title) in server.take_progress() {
            self.sink.emit(ide_core::IdeEvent::Task { id, title, message: None, fraction: None, done: true });
        }
        for path in server.take_diagnostic_paths() {
            self.sink.emit(ide_core::IdeEvent::Diagnostics {
                path: path.into(),
                source: server.name.clone(),
                items: Vec::new(),
            });
        }
    }

    fn initialize_params(&self, server: &Server) -> Value {
        let root_uri = uri::path_to_uri(&server.root);
        let name = server.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "root".into());
        let init_options = server
            .effective_config()
            .initialization_options
            .as_ref()
            .and_then(|v| serde_json::to_value(v).ok())
            .unwrap_or(Value::Null);
        let mut params = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") },
            "locale": "en",
            "rootPath": server.root.to_string_lossy(),
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": root_uri, "name": name }],
            "capabilities": caps::client_capabilities(),
            "trace": "off",
        });
        if !init_options.is_null() {
            params["initializationOptions"] = init_options;
        }
        params
    }

    pub(crate) fn workspace_folders(&self, server: &Server) -> Value {
        let name = server.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "root".into());
        json!([{ "uri": uri::path_to_uri(&server.root), "name": name }])
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
        let key = path.to_str().filter(|s| is_virtual_uri(s))?;
        self.virtual_docs.lock().get(key).map(|d| Arc::new(DocText::new(&d.text)))
    }

    pub(crate) fn conv(&self, enc: Encoding) -> Conv<'_> {
        Conv::new(enc, move |p: &Path| self.text_for_path(p))
    }

    // ---- document sync (driven by ide-workspace's DocumentObserver) ----
    pub fn did_open(&self, doc: DocId, path: &Path, language: &LanguageId, version: u32, text: &str) {
        if self.docs.lock().contains_key(&doc) {
            self.did_close(doc);
        }
        let servers = self.servers_for(language, path);
        self.attach(doc, path.to_owned(), uri::path_to_uri(path), language, version, text, servers);
    }

    /// Opens a read-only virtual document (`jdt://…`) on the server that
    /// returned its URI (`didOpen` only: it is never changed or saved).
    pub fn did_open_virtual(&self, doc: DocId, uri: &str, language: &LanguageId, version: u32, text: &str) {
        if self.docs.lock().contains_key(&doc) {
            self.did_close(doc);
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
        let mut state = DocState {
            path,
            uri,
            language: language.clone(),
            version: version as i32,
            text: Arc::new(DocText::new(text)),
            servers: servers.iter().map(|s| Attached { server: s.clone(), opened_gen: None }).collect(),
        };
        {
            let mut docs = self.docs.lock();
            let params = state.did_open_params();
            for a in &mut state.servers {
                if let Some(run) = a.server.running() {
                    if run.caps.read().open_close
                        && let Err(e) = run.peer.notify("textDocument/didOpen", params.clone())
                    {
                        tracing::debug!("{}: didOpen: {e}", a.server.name);
                    }
                    a.opened_gen = Some(run.generation);
                }
            }
            docs.insert(doc, state);
        }
        for s in &servers {
            self.ensure_started(s);
        }
    }

    pub fn did_change(&self, doc: DocId, version: u32, changes: &[AppliedChange], full_text: &dyn Fn() -> String) {
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
        if targets.is_empty() {
            return;
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
    }

    pub fn did_close(&self, doc: DocId) {
        let Some(d) = self.docs.lock().remove(&doc) else { return };
        for a in &d.servers {
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
        Ok(DocSnap {
            path: d.path.clone(),
            uri: d.uri.clone(),
            text: d.text.clone(),
            servers: d.servers.iter().map(|a| a.server.clone()).collect(),
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
            return Err(unsupported(feature));
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
        let fut = t.run.peer.request::<P, R>(method, params, cancel.cloned());
        match tokio::time::timeout(timeout, fut).await {
            Ok(r) => r.map_err(|e| rpc_err(&t.server.name, method, e)),
            Err(_) => Err(rpc_err(&t.server.name, method, RpcError::Timeout)),
        }
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
        let requests = targets.iter().map(|t| {
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
                    list.items
                        .extend(items.into_iter().map(|i| convert::completion_item(&conv, &snap.path, i, t.server.id)));
                }
                Err(e) => out.fail(e),
            }
        }
        out.finish(CompletionList { is_incomplete: false, items: Vec::new() })
    }

    pub async fn resolve_completion(&self, doc: DocId, item: CompletionItem) -> IdeResult<CompletionItem> {
        let snap = self.snapshot(doc)?;
        let Some(server) = snap.servers.iter().find(|s| s.id == item.server) else { return Ok(item) };
        let Some(t) = self
            .ready_targets(std::slice::from_ref(server), |c| c.has_sub("completionProvider", "resolveProvider"))
            .await
            .pop()
        else {
            return Ok(item);
        };
        let lsp_item = convert::lsp_completion_item(&snap.text, t.enc(), &item);
        let resolved: lsp::CompletionItem =
            self.call(&t, "completionItem/resolve", lsp_item, None, DEFAULT_TIMEOUT).await?;
        let mut out = item;
        convert::overlay_completion(&self.conv(t.enc()), &snap.path, &mut out, resolved, false);
        Ok(out)
    }

    pub async fn hover(&self, doc: DocId, pos: Pos, cancel: CancellationToken) -> IdeResult<Option<Hover>> {
        let (snap, targets) = self.doc_targets(doc, "hover", |c| c.has("hoverProvider")).await?;
        let mut out = Outcome::new();
        for t in &targets {
            let r: IdeResult<Option<lsp::Hover>> =
                self.call(t, "textDocument/hover", snap.pos_params(t, pos), Some(&cancel), DEFAULT_TIMEOUT).await;
            match r {
                Ok(Some(h)) => {
                    if let Some(h) = convert::hover(&self.conv(t.enc()), &snap.path, h) {
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
        for t in &targets {
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
        let (method, cap, feature) = match kind {
            GotoKind::Definition => ("textDocument/definition", "definitionProvider", "go to definition"),
            GotoKind::Declaration => ("textDocument/declaration", "declarationProvider", "go to declaration"),
            GotoKind::TypeDefinition => {
                ("textDocument/typeDefinition", "typeDefinitionProvider", "go to type definition")
            }
            GotoKind::Implementation => {
                ("textDocument/implementation", "implementationProvider", "go to implementation")
            }
        };
        let (snap, targets) = self.doc_targets(doc, feature, |c| c.has(cap)).await?;
        let mut out = Outcome::new();
        for t in &targets {
            match self
                .call::<_, Option<lsp::GotoDefinitionResponse>>(
                    t,
                    method,
                    snap.pos_params(t, pos),
                    None,
                    DEFAULT_TIMEOUT,
                )
                .await
            {
                Ok(Some(r)) => {
                    let locs = convert::goto_response(&self.conv(t.enc()), r);
                    self.note_virtual(&t.server, locs.iter().map(|l| l.uri.as_deref()));
                    if !locs.is_empty() {
                        return Ok(locs);
                    }
                    out.value = Some(Vec::new());
                }
                Ok(None) => out.value = Some(Vec::new()),
                Err(e) => out.fail(e),
            }
        }
        out.finish(Vec::new())
    }

    pub async fn references(&self, doc: DocId, pos: Pos, include_declaration: bool) -> IdeResult<Vec<Location>> {
        let (snap, targets) = self.doc_targets(doc, "find references", |c| c.has("referencesProvider")).await?;
        let requests = targets.iter().map(|t| {
            let mut params = snap.pos_params(t, pos);
            params["context"] = json!({ "includeDeclaration": include_declaration });
            async move {
                (
                    t,
                    self.call::<_, Option<Vec<lsp::Location>>>(
                        t,
                        "textDocument/references",
                        params,
                        None,
                        LONG_TIMEOUT,
                    )
                    .await,
                )
            }
        });
        let mut out = Outcome::new();
        for (t, r) in join_all(requests).await {
            match r {
                Ok(locs) => {
                    let conv = self.conv(t.enc());
                    let locs: Vec<Location> =
                        locs.unwrap_or_default().iter().filter_map(|l| conv.location(l)).collect();
                    self.note_virtual(&t.server, locs.iter().map(|l| l.uri.as_deref()));
                    out.value.get_or_insert_with(Vec::new).extend(locs);
                }
                Err(e) => out.fail(e),
            }
        }
        let mut v = out.finish(Vec::new())?;
        convert::dedup_locations(&mut v);
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
                    return Ok(hs.into_iter().map(|h| convert::highlight(&conv, &snap.path, h)).collect());
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
            return Err(unsupported("workspace symbols"));
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
                    acc.extend(
                        actions.unwrap_or_default().into_iter().map(|a| convert::code_action(&conv, a, t.server.id)),
                    );
                }
                Err(e) => out.fail(e),
            }
        }
        out.finish(Vec::new()).map(|actions| CodeActionQuery { actions, advertised_kinds })
    }

    pub async fn resolve_code_action(&self, doc: DocId, action: CodeAction) -> IdeResult<CodeAction> {
        let snap = self.snapshot(doc)?;
        let servers: Vec<Arc<Server>> = match snap.servers.iter().find(|s| s.id == action.server) {
            Some(s) => vec![s.clone()],
            None => self.servers.lock().iter().filter(|s| s.id == action.server).cloned().collect(),
        };
        let Some(t) = self.ready_targets(&servers, |c| c.has_sub("codeActionProvider", "resolveProvider")).await.pop()
        else {
            return Ok(action);
        };
        let resolved: lsp::CodeAction =
            self.call(&t, "codeAction/resolve", convert::lsp_code_action(&action), None, DEFAULT_TIMEOUT).await?;
        Ok(convert::merge_code_action(&self.conv(t.enc()), action, resolved))
    }

    pub async fn execute_command(&self, doc: DocId, command: Command) -> IdeResult<()> {
        let servers = match self.snapshot(doc) {
            Ok(snap) => snap.servers,
            Err(_) => self.servers.lock().clone(),
        };
        let name = command.command.clone();
        let targets = self.ready_targets(&servers, |c| c.commands().contains(&name)).await;
        let t = targets
            .first()
            .ok_or_else(|| IdeError::unavailable(format!("no language server provides command `{name}`")))?;
        let params = json!({ "command": command.command, "arguments": command.arguments });
        let _: Value = self.call(t, "workspace/executeCommand", params, None, LONG_TIMEOUT).await?;
        Ok(())
    }

    pub async fn prepare_rename(&self, doc: DocId, pos: Pos) -> IdeResult<Option<Range>> {
        let (snap, targets) = self.doc_targets(doc, "rename", |c| c.has("renameProvider")).await?;
        let t = &targets[0];
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

    pub async fn rename(&self, doc: DocId, pos: Pos, new_name: String) -> IdeResult<WorkspaceEdit> {
        let (snap, targets) = self.doc_targets(doc, "rename", |c| c.has("renameProvider")).await?;
        let t = &targets[0];
        let mut params = snap.pos_params(t, pos);
        params["newName"] = json!(new_name);
        let r: Option<lsp::WorkspaceEdit> = self.call(t, "textDocument/rename", params, None, LONG_TIMEOUT).await?;
        Ok(r.map(|e| convert::workspace_edit(&self.conv(t.enc()), e)).unwrap_or_default())
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
    fn open_for_file_op(&self, t: &Target, moves: &[(PathBuf, PathBuf, bool)]) -> Option<lsp::Uri> {
        if !t.caps().open_close {
            return None;
        }
        let docs = self.docs.lock();
        let busy = docs
            .values()
            .any(|d| d.servers.iter().any(|a| a.server.id == t.server.id && a.opened_gen == Some(t.run.generation)));
        if busy {
            return None;
        }
        let languages = t.server.languages();
        let candidate =
            moves.iter().flat_map(
                |(from, _, is_dir)| {
                    if *is_dir { sample_files(from, FILE_OP_SAMPLE) } else { vec![from.clone()] }
                },
            );
        for file in candidate {
            let language = self.languages.detect(&file, None);
            if !languages.contains(&language) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let uri = uri::path_to_uri(&file);
            let params =
                json!({ "textDocument": { "uri": uri, "languageId": language.as_str(), "version": 0, "text": text } });
            if t.run.peer.notify("textDocument/didOpen", params).is_ok() {
                return Some(uri);
            }
        }
        None
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
            let Some(params) = Self::file_op_params(&t, "willRename", &moves) else { continue };
            out.servers.push(t.server.name.clone());
            let opened = self.open_for_file_op(&t, &moves);
            let r: IdeResult<Option<lsp::WorkspaceEdit>> =
                self.call(&t, "workspace/willRenameFiles", params, Some(&cancel), LONG_TIMEOUT).await;
            if let Some(uri) = opened {
                let _ = t.run.peer.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } }));
            }
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
        let requests = targets.iter().map(|t| {
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

    pub async fn call_hierarchy(
        &self,
        doc: DocId,
        pos: Pos,
        direction: HierarchyDirection,
    ) -> IdeResult<Vec<HierarchyItem>> {
        let (snap, targets) = self.doc_targets(doc, "call hierarchy", |c| c.has("callHierarchyProvider")).await?;
        let t = &targets[0];
        let items: Option<Vec<lsp::CallHierarchyItem>> =
            self.call(t, "textDocument/prepareCallHierarchy", snap.pos_params(t, pos), None, DEFAULT_TIMEOUT).await?;
        let mut out = Vec::new();
        for item in items.unwrap_or_default() {
            let params = json!({ "item": item });
            match direction {
                HierarchyDirection::Incoming => {
                    let calls: Option<Vec<lsp::CallHierarchyIncomingCall>> =
                        self.call(t, "callHierarchy/incomingCalls", params, None, LONG_TIMEOUT).await?;
                    let conv = self.conv(t.enc());
                    for c in calls.unwrap_or_default() {
                        let (path, _) = uri_target(c.from.uri.as_str());
                        let ranges = c.from_ranges.iter().map(|r| conv.range(&path, *r)).collect();
                        out.extend(convert::call_item(&conv, &c.from, ranges));
                    }
                }
                HierarchyDirection::Outgoing => {
                    let calls: Option<Vec<lsp::CallHierarchyOutgoingCall>> =
                        self.call(t, "callHierarchy/outgoingCalls", params, None, LONG_TIMEOUT).await?;
                    let conv = self.conv(t.enc());
                    let (src, _) = uri_target(item.uri.as_str());
                    for c in calls.unwrap_or_default() {
                        let ranges = c.from_ranges.iter().map(|r| conv.range(&src, *r)).collect();
                        out.extend(convert::call_item(&conv, &c.to, ranges));
                    }
                }
            }
        }
        self.note_virtual(&t.server, out.iter().map(|i| i.uri.as_deref()));
        Ok(out)
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
        let method = match direction {
            HierarchyDirection::Incoming => "typeHierarchy/supertypes",
            HierarchyDirection::Outgoing => "typeHierarchy/subtypes",
        };
        let mut out = Vec::new();
        for item in items.unwrap_or_default() {
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

    /// Contents of a virtual document, from the server that owns `uri`:
    /// `workspace/textDocumentContent` (LSP 3.18) when the server serves the
    /// scheme, jdtls' `java/classFileContents` for `jdt:` URIs. Cached.
    pub async fn virtual_document(&self, uri: &str) -> IdeResult<VirtualDocument> {
        if let Some(d) = self.virtual_docs.lock().get(uri) {
            return Ok(d.clone());
        }
        let scheme = virtual_doc::scheme(uri).to_owned();
        let origin = self.origin_server(uri);
        let mut servers: Vec<Arc<Server>> = origin.iter().cloned().collect();
        servers.extend(self.servers.lock().iter().filter(|s| Some(s.id) != origin.as_ref().map(|o| o.id)).cloned());
        let targets = self.ready_targets(&servers, |_| true).await;
        let mut error = None;
        for t in &targets {
            let languages = t.server.languages();
            let serves_scheme = t.caps().content_schemes().contains(&scheme);
            let result: IdeResult<Option<String>> = if serves_scheme {
                self.call::<_, Option<Value>>(
                    t,
                    "workspace/textDocumentContent",
                    json!({ "uri": uri }),
                    None,
                    LONG_TIMEOUT,
                )
                .await
                .map(|v| v.and_then(|v| v.get("text").and_then(Value::as_str).map(str::to_owned)))
            } else if scheme == "jdt" && languages.iter().any(|l| l.as_str() == "java") {
                self.call::<_, Option<String>>(t, "java/classFileContents", json!({ "uri": uri }), None, LONG_TIMEOUT)
                    .await
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
            let decompiled = virtual_doc::is_decompiled(&text);
            let title = virtual_doc::title(uri, decompiled);
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
                description: virtual_doc::description(uri),
                decompiled,
            };
            self.virtual_origins.lock().entry(uri.to_owned()).or_insert(t.server.id);
            let mut cache = self.virtual_docs.lock();
            if cache.len() >= VIRTUAL_CACHE_LIMIT {
                cache.clear();
            }
            cache.insert(uri.to_owned(), doc.clone());
            return Ok(doc);
        }
        Err(error.unwrap_or_else(|| IdeError::not_found(format!("no language server provides the contents of {uri}"))))
    }

    /// Called when a server sends `workspace/applyEdit`; installed by `src-tauri`
    /// so edits flow through `ide-workspace::Documents`.
    pub fn set_config_hook(&self, hook: Box<ConfigFn>) {
        *self.config_hook.write() = Some(Arc::from(hook));
    }

    /// The server's base configuration with the settings hook applied.
    fn configured(&self, server: &Server) -> LanguageServerConfig {
        let mut cfg = server.config.clone();
        if let Some(hook) = self.config_hook.read().clone() {
            hook(&mut cfg, &server.root);
        }
        cfg
    }

    /// Restarts running servers whose settings-derived configuration changed
    /// (e.g. a new project interpreter); stopped ones pick it up on their next start.
    pub async fn reconfigure(&self) {
        let servers: Vec<Arc<Server>> = self.servers.lock().clone();
        for s in servers {
            let next = self.configured(&s);
            if next == s.effective_config() {
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
                // Missing / crashed servers retry with the new configuration (e.g. a new PATH).
                ide_core::event::ServerStatus::Missing | ide_core::event::ServerStatus::Crashed => {
                    s.reset_for_restart();
                    self.ensure_started(&s);
                }
                ide_core::event::ServerStatus::Stopped => {}
            }
        }
    }

    pub fn set_apply_edit_hook(&self, hook: Box<dyn Fn(WorkspaceEdit) -> bool + Send + Sync>) {
        *self.apply_edit_hook.write() = Some(Arc::from(hook));
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
        let s = self
            .servers
            .lock()
            .iter()
            .find(|s| s.id == server)
            .cloned()
            .ok_or_else(|| IdeError::not_found(format!("unknown language server {server}")))?;
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
        let Some(run) = server.begin_stop() else {
            if final_stop {
                server.set_status(&self.sink, ide_core::event::ServerStatus::Stopped, None);
            }
            return;
        };
        let peer = run.peer.clone();
        let graceful = async {
            peer.request::<_, Value>("shutdown", (), None).await.ok();
            peer.notify("exit", ()).ok();
            peer.closed().await;
        };
        if tokio::time::timeout(Duration::from_secs(3), graceful).await.is_err() {
            peer.kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), peer.closed()).await;
        }
        peer.kill();
        server.end_stop(run.generation);
        self.clear_server_state(server);
        server.set_status(&self.sink, ide_core::event::ServerStatus::Stopped, None);
    }

    pub async fn shutdown_all(&self) {
        self.shutting_down.store(true, Ordering::Release);
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
        assert_send(m.call_hierarchy(doc, Pos::default(), HierarchyDirection::Incoming));
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
