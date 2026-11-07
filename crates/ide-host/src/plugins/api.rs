//! [`HostApi`] for one plugin's code: what its imports reach in the IDE.
//! Capabilities were checked by the runtime before any of this runs.

use super::{CommitAnswer, CommitRequest, CommitSelection, PluginContextKey, PluginEvent, PluginEventSink};
use ide_core::ipc_path::to_ipc;
use ide_core::{CancellationToken, TextEdit};
use ide_extension::Package;
use ide_language::ProgramPin;
use ide_plugin::{
    CommitChange, CommitDraft, EventKind, HostApi, HostError, HttpRequest, HttpResponse, NotificationLevel,
    ProcessOutput, Prompt, RepositoryStatus, StatusItem,
};
use parking_lot::{Mutex, RwLock};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// A question a plugin's call waits on: the user's (a prompt) or a window's.
struct PromptEntry {
    plugin: String,
    answer: Waiter,
}

enum Waiter {
    Prompt(std::sync::mpsc::SyncSender<Option<Vec<String>>>),
    Commit(std::sync::mpsc::SyncSender<CommitAnswer>),
}

/// State shared by the host and every plugin's [`PluginApi`].
pub(super) struct Shared {
    pub sink: Arc<dyn PluginEventSink>,
    pub workspace: RwLock<Option<Arc<dyn PluginWorkspace>>>,
    /// `<plugins>/.data`: one directory per plugin id.
    pub data_dir: PathBuf,
    tasks: Mutex<HashMap<u64, TaskEntry>>,
    next_task: AtomicU64,
    prompts: Mutex<HashMap<u64, PromptEntry>>,
    /// Plugins being stopped: their calls may not open new prompts (taken before `prompts`).
    prompts_blocked: Mutex<BTreeSet<String>>,
    next_prompt: AtomicU64,
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
    /// The UI language the windows report (BCP 47).
    pub locale: RwLock<String>,
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
            locale: RwLock::new("en".into()),
            sink,
            workspace: RwLock::new(None),
            secrets: RwLock::new(Arc::new(FileSecretStore { dir: data_dir.clone() })),
            pins,
            data_dir,
            tasks: Mutex::default(),
            next_task: AtomicU64::new(1),
            prompts: Mutex::default(),
            prompts_blocked: Mutex::default(),
            next_prompt: AtomicU64::new(1),
            status: Mutex::default(),
            contexts: Mutex::default(),
            closed_clients: Mutex::default(),
            subscriptions: Mutex::default(),
            diagnostics: Mutex::default(),
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
        self.withdraw_prompts(plugin);
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
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, &file)).map_err(storage_io)
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
        let binary = self.approved_program(program)?;
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
            let blocked = self.shared.prompts_blocked.lock();
            if blocked.contains(self.id()) {
                return Err(HostError::Cancelled);
            }
            self.shared
                .prompts
                .lock()
                .insert(id, PromptEntry { plugin: self.id().to_owned(), answer: Waiter::Commit(answer) });
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
    fn notify(
        &self,
        client: Option<&str>,
        level: NotificationLevel,
        title: String,
        body: String,
        actions: Vec<ide_plugin::NotificationAction>,
    ) -> Result<(), HostError> {
        if !actions.is_empty() {
            let commands = self.shared.ui.items("commands", Some(self.id()));
            if let Some(a) = actions.iter().find(|a| !commands.iter().any(|c| c.key == a.command)) {
                return Err(HostError::NotFound(format!("the plugin declares no command {:?}", a.command)));
            }
        }
        let plugin_id = self.id().to_owned();
        self.shared.sink.emit(client, PluginEvent::Notification { plugin_id, level, title, body, actions });
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
            let blocked = self.shared.prompts_blocked.lock();
            if blocked.contains(self.id()) {
                return Err(HostError::Cancelled);
            }
            self.shared
                .prompts
                .lock()
                .insert(id, PromptEntry { plugin: self.id().to_owned(), answer: Waiter::Prompt(answer) });
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
        let shared = Shared::new(sink, dir.join(".data"), pins, ide_extension::UiStore::new());
        PluginApi { pkg: Package::new(manifest, dir.to_path_buf()), shared }
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
