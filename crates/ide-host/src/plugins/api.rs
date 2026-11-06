//! [`HostApi`] for one plugin's code: what its imports reach in the IDE.
//! Capabilities were checked by the runtime before any of this runs.

use super::{PluginContextKey, PluginEvent, PluginEventSink};
use ide_core::ipc_path::to_ipc;
use ide_core::{CancellationToken, TextEdit};
use ide_extension::Package;
use ide_language::ProgramPin;
use ide_plugin::{
    EventKind, HostApi, HostError, HttpRequest, HttpResponse, NotificationLevel, ProcessOutput, RepositoryStatus,
    StatusItem,
};
use parking_lot::{Mutex, RwLock};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Largest storage of one plugin (keys + values).
const MAX_STORAGE: usize = 1 << 20;
const MAX_KEY: usize = 256;
/// Most status bar items per plugin.
const MAX_STATUS_ITEMS: usize = 8;
const MAX_CONTEXT_KEYS: usize = 100;

/// (window or `None` for every window, plugin, key).
type ContextKey = (Option<String>, String, String);

/// What plugins see of the open projects; provided by the app
/// ([`super::PluginHost::set_workspace`]), over [`crate::Host`] on the desktop.
pub trait PluginWorkspace: Send + Sync {
    /// Roots of the open projects.
    fn projects(&self) -> Vec<PathBuf>;
    /// Unsaved text of the open document at `path`.
    fn buffer_text(&self, path: &Path) -> Option<String>;
    /// Up to `limit` files of the project index below `root` whose root-relative path satisfies
    /// `matches`; `None` when no index covers `root` yet (the caller walks the disk instead).
    fn indexed_files(&self, _root: &Path, _matches: &dyn Fn(&Path) -> bool, _limit: usize) -> Option<Vec<PathBuf>> {
        None
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
    /// Shows `items` as producer `source`'s diagnostics of `path` (replacing earlier ones).
    fn publish_diagnostics(&self, source: &str, path: &Path, items: Vec<ide_core::Diagnostic>)
    -> Result<(), HostError>;
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
        std::fs::create_dir_all(file.parent().expect("has parent")).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(&map).map_err(|e| e.to_string())?;
        let tmp = file.with_extension("tmp");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
    }
}

/// Largest response body a plugin receives.
const MAX_RESPONSE: usize = 8 << 20;
/// Largest stdout / stderr kept from a process.
const MAX_OUTPUT: usize = 4 << 20;
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

/// State shared by the host and every plugin's [`PluginApi`].
pub(super) struct Shared {
    pub sink: Arc<dyn PluginEventSink>,
    pub workspace: RwLock<Option<Arc<dyn PluginWorkspace>>>,
    /// `<plugins>/.data`: one directory per plugin id.
    pub data_dir: PathBuf,
    tasks: Mutex<HashMap<u64, TaskEntry>>,
    next_task: AtomicU64,
    /// (plugin, item id) → item, for windows opened later.
    status: Mutex<BTreeMap<(String, String), StatusItem>>,
    /// (scope, plugin, key) → JSON value.
    contexts: Mutex<BTreeMap<ContextKey, String>>,
    closed_clients: Mutex<BTreeSet<String>>,
    /// plugin → kinds subscribed at run time (kept across idle reclaim).
    pub subscriptions: Mutex<HashMap<String, BTreeSet<EventKind>>>,
    /// plugin → files it shows problems for, withdrawn when it stops.
    diagnostics: Mutex<HashMap<String, BTreeSet<PathBuf>>>,
    pub secrets: RwLock<Arc<dyn SecretStore>>,
    /// (plugin, `process:` capability) → the approved program.
    pub pins: Arc<RwLock<HashMap<(String, String), ProgramPin>>>,
    /// Validated UI declarations (settings schemas, declared views).
    pub ui: Arc<ide_extension::UiStore>,
}

impl Shared {
    pub fn new(
        sink: Arc<dyn PluginEventSink>,
        data_dir: PathBuf,
        pins: Arc<RwLock<HashMap<(String, String), ProgramPin>>>,
        ui: Arc<ide_extension::UiStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            ui,
            sink,
            workspace: RwLock::new(None),
            secrets: RwLock::new(Arc::new(FileSecretStore { dir: data_dir.clone() })),
            pins,
            data_dir,
            tasks: Mutex::default(),
            next_task: AtomicU64::new(1),
            status: Mutex::default(),
            contexts: Mutex::default(),
            closed_clients: Mutex::default(),
            subscriptions: Mutex::default(),
            diagnostics: Mutex::default(),
        })
    }

    fn workspace(&self) -> Option<Arc<dyn PluginWorkspace>> {
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

    /// Drops the context keys scoped to window `client` (it closed), without events, and
    /// refuses further writes for it (late commands) until [`Self::reopen_client`].
    pub fn forget_client(&self, client: &str) {
        self.closed_clients.lock().insert(client.to_owned());
        self.contexts.lock().retain(|(scope, ..), _| scope.as_deref() != Some(client));
    }

    /// A window labelled `client` is being created (labels are reused after a close).
    pub fn reopen_client(&self, client: &str) {
        self.closed_clients.lock().remove(client);
    }

    /// Withdraws a plugin's run-time state (it stopped or failed). Its
    /// subscriptions go only with `subscriptions`, as they survive restarts.
    pub fn clear_plugin(&self, plugin: &str, subscriptions: bool) {
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
        if subscriptions && self.subscriptions.lock().remove(plugin).is_some() {
            self.sink.emit(None, PluginEvent::SubscriptionsChanged);
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

    fn end_task(&self, id: u64) {
        if let Some(t) = self.tasks.lock().remove(&id) {
            self.sink.emit(None, PluginEvent::TaskEnded { plugin_id: t.plugin, task_id: id.to_string() });
        }
    }

    pub fn storage_file(&self, plugin: &str) -> PathBuf {
        self.data_dir.join(plugin).join("storage.json")
    }
}

pub(super) struct PluginApi {
    pub pkg: Package,
    pub shared: Arc<Shared>,
}

impl PluginApi {
    fn id(&self) -> &str {
        self.pkg.id()
    }

    fn load_storage(&self) -> Result<BTreeMap<String, String>, HostError> {
        match std::fs::read(self.shared.storage_file(self.id())) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| HostError::Failed(format!("storage: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(HostError::Failed(format!("storage: {e}"))),
        }
    }

    fn save_storage(&self, map: &BTreeMap<String, String>) -> Result<(), HostError> {
        let file = self.shared.storage_file(self.id());
        let bytes = serde_json::to_vec(map).map_err(|e| HostError::Failed(e.to_string()))?;
        let io = |e: std::io::Error| HostError::Failed(format!("storage: {e}"));
        std::fs::create_dir_all(file.parent().expect("has parent")).map_err(io)?;
        let tmp = file.with_extension("tmp");
        std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, &file)).map_err(io)
    }

    /// The program approved for the (already checked) `process:` grant,
    /// verified right before it starts.
    fn approved_program(&self, program: &str) -> Result<PathBuf, HostError> {
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

fn failed(e: impl std::fmt::Display) -> HostError {
    HostError::Failed(e.to_string())
}

impl HostApi for PluginApi {
    fn notify(&self, client: Option<&str>, level: NotificationLevel, title: String, body: String) {
        self.shared
            .sink
            .emit(client, PluginEvent::Notification { plugin_id: self.id().to_owned(), level, title, body });
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
        Ok(self.load_storage()?.get(key).cloned())
    }

    fn storage_set(&self, key: &str, value: Option<String>) -> Result<(), HostError> {
        if key.is_empty() || key.len() > MAX_KEY {
            return Err(HostError::Invalid(format!("keys are 1–{MAX_KEY} bytes")));
        }
        let mut map = self.load_storage()?;
        let changed = match value {
            Some(v) => map.insert(key.to_owned(), v.clone()).as_ref() != Some(&v),
            None => map.remove(key).is_some(),
        };
        if !changed {
            return Ok(());
        }
        let size: usize = map.iter().map(|(k, v)| k.len() + v.len()).sum();
        if size > MAX_STORAGE {
            return Err(HostError::Invalid(format!("storage is limited to {} KiB", MAX_STORAGE >> 10)));
        }
        self.save_storage(&map)
    }

    fn storage_keys(&self, prefix: &str) -> Result<Vec<String>, HostError> {
        Ok(self.load_storage()?.into_keys().filter(|k| k.starts_with(prefix)).collect())
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

    fn find_files(&self, root: &Path, glob: &str, limit: usize) -> Result<Vec<String>, HostError> {
        let matcher = globset::GlobBuilder::new(glob)
            .literal_separator(true)
            .build()
            .map_err(|e| HostError::Invalid(format!("{glob:?}: {e}")))?
            .compile_matcher();
        // Hidden files and folders are left out, as in the walk below.
        let visible = |rel: &Path| !rel.iter().any(|c| c.to_str().is_some_and(|c| c.starts_with('.')));
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
        for (n, entry) in ignore::WalkBuilder::new(root).hidden(true).build().flatten().enumerate() {
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
        let client = ide_http::client::shared().map_err(|e| HostError::Failed(e.message))?;
        // A redirect to another host is refused after the fact (the shared
        // client follows redirects).
        let builder = client.request(method, &request.url).headers(headers).timeout(request.timeout);
        let builder = match request.body {
            Some(body) => builder.body(body),
            None => builder,
        };
        let cancel = cancel.clone();
        let host = ide_plugin::net_host(&request.url).map_err(HostError::Invalid)?;
        net_runtime().block_on(async move {
            let send = async {
                let response = builder.send().await.map_err(|e| HostError::Failed(e.to_string()))?;
                if ide_plugin::net_host(response.url().as_str()).ok().as_deref() != Some(host.as_str()) {
                    return Err(HostError::Denied(format!(
                        "net:{} (redirected)",
                        response.url().host_str().unwrap_or("?")
                    )));
                }
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

    fn secret_is_set(&self, name: &str) -> bool {
        self.shared.secrets.read().get(self.id(), name).is_some()
    }

    fn run_process(
        &self,
        program: &str,
        args: Vec<String>,
        cwd: Option<&Path>,
        stdin: Option<String>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<ProcessOutput, HostError> {
        let binary = self.approved_program(program)?;
        let cwd = cwd.map(Path::to_path_buf).unwrap_or_else(|| self.shared.data_dir.join(self.id()));
        let _ = std::fs::create_dir_all(&cwd);
        let mut child = std::process::Command::new(&binary)
            .args(&args)
            .current_dir(&cwd)
            .stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| HostError::Failed(format!("{}: {e}", binary.display())))?;
        if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
            std::thread::spawn(move || {
                use std::io::Write;
                let _ = pipe.write_all(input.as_bytes());
            });
        }
        let read = |pipe: Option<Box<dyn std::io::Read + Send>>| {
            std::thread::spawn(move || {
                use std::io::Read;
                let mut out = Vec::new();
                if let Some(p) = pipe {
                    let _ = p.take(MAX_OUTPUT as u64).read_to_end(&mut out);
                }
                String::from_utf8_lossy(&out).into_owned()
            })
        };
        let stdout = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>));
        let stderr = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>));
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| HostError::Failed(e.to_string()))? {
                break status;
            }
            if cancel.is_cancelled() || Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if cancel.is_cancelled() {
                    HostError::Cancelled
                } else {
                    HostError::Failed(format!("{program} timed out after {timeout:?}"))
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

    fn subscribe(&self, kind: EventKind, on: bool) {
        let changed = {
            let mut subs = self.shared.subscriptions.lock();
            let set = subs.entry(self.id().to_owned()).or_default();
            if on { set.insert(kind) } else { set.remove(&kind) }
        };
        if changed {
            self.shared.sink.emit(None, PluginEvent::SubscriptionsChanged);
        }
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
        let binary = self.approved_program(program)?;
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
}

/// [`PluginWorkspace`] over the desktop host's open projects.
pub struct HostWorkspace(pub std::sync::Weak<crate::Host>);

impl HostWorkspace {
    fn projects(&self) -> Vec<Arc<crate::project::Project>> {
        self.0.upgrade().map(|h| h.projects()).unwrap_or_default()
    }

    /// The project holding an open document at `path`, and its id.
    fn open_document(&self, path: &Path) -> Option<(Arc<crate::project::Project>, ide_core::DocId)> {
        self.projects().into_iter().find_map(|p| p.documents.by_path(path).map(|doc| (p, doc)))
    }
}

impl PluginWorkspace for HostWorkspace {
    fn projects(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = HostWorkspace::projects(self).iter().map(|p| p.root.clone()).collect();
        roots.sort();
        roots.dedup();
        roots
    }

    fn buffer_text(&self, path: &Path) -> Option<String> {
        HostWorkspace::projects(self).iter().find_map(|p| p.documents.text_of(path))
    }

    fn indexed_files(&self, root: &Path, matches: &dyn Fn(&Path) -> bool, limit: usize) -> Option<Vec<PathBuf>> {
        // The index of the project rooted at `root` (a workspace member's files are in its own).
        let project = HostWorkspace::projects(self).into_iter().find(|p| p.root == root)?;
        project.index.files_matching(root, matches, limit)
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
        let shared = Shared::new(sink, dir.join(".data"), pins, ide_extension::UiStore::new());
        PluginApi { pkg: Package::new(manifest, dir.to_path_buf()), shared }
    }

    #[test]
    fn repository_and_search_paths_match_ipc_events() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).arg(tmp.path()).status().unwrap().success());
        let root = tmp.path().canonicalize().unwrap();
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
        let root = tmp.path().canonicalize().unwrap();
        let api = api(&root, Arc::default());
        *api.shared.workspace.write() = Some(Arc::new(Indexed(
            root.clone(),
            vec!["src/b/UserMapper.xml", "src/a/OrderMapper.xml", ".idea/workspace.xml", "pom.xml"],
        )));
        // Listed by the index, not walked: none of these exist on disk.
        assert_eq!(
            api.find_files(&root, "**/*Mapper.xml", 10).unwrap(),
            [to_ipc(&root.join("src/a/OrderMapper.xml")), to_ipc(&root.join("src/b/UserMapper.xml"))]
        );
        assert_eq!(api.find_files(&root, "**/*.xml", 10).unwrap().len(), 3, "hidden folders are left out");
        assert_eq!(api.find_files(&root, "**/*.xml", 1).unwrap().len(), 1);
        // Another root: no index covers it, so the disk is walked.
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("a.xml"), "").unwrap();
        assert_eq!(api.find_files(&other, "*.xml", 10).unwrap(), [to_ipc(&other.join("a.xml"))]);
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
