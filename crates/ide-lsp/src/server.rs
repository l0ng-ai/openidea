//! One configured server for a `(name, root)` pair and the state of its current instance.

use crate::caps::ServerCaps;
use ide_core::event::ServerStatus;
use ide_core::{CancellationToken, IdeEvent, LanguageId, ServerId, SharedSink, TaskId};
use ide_jsonrpc::Peer;
use ide_language::LanguageServerConfig;
use lsp_types as lsp;
use parking_lot::{Mutex, RwLock};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Notify, watch};

/// An instance that stayed up this long ran fine: earlier crashes no longer count.
const STABLE_UPTIME: Duration = Duration::from_secs(180);
const MAX_RESTARTS: usize = 3;
const STDERR_LINES: usize = 50;
/// Diagnostics a server publishes for a transiently opened file shortly after
/// its `didClose` (analysis that was already running) are dropped too.
const TRANSIENT_GRACE: Duration = Duration::from_secs(3);

/// A live, initialized instance.
#[derive(Clone)]
pub struct Running {
    pub generation: u64,
    pub peer: Peer,
    pub caps: Arc<RwLock<ServerCaps>>,
    /// `workspace/didChangeWatchedFiles` registrations.
    pub watchers: Arc<RwLock<crate::file_watch::FileWatchers>>,
}

pub enum Conn {
    Idle,
    Starting,
    Ready(Running),
    Stopping,
    /// Binary not found; restart re-checks.
    Missing,
    /// Gave up (spawn failure or repeated crashes); restart re-checks.
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Starting,
    Ready,
    Down,
}

struct State {
    generation: u64,
    conn: Conn,
    events: VecDeque<IdeEvent>,
    publishing: bool,
}

/// A file opened on the server by the client itself (not by the user) for the
/// duration of a request, e.g. to widen a references search.
struct Transient {
    /// Requests holding the file open.
    holders: usize,
    generation: u64,
    /// The user opened the file meanwhile: its `didOpen` replaced ours.
    taken: bool,
    closed_at: Option<Instant>,
}

pub struct Progress {
    pub task: TaskId,
    pub title: String,
    pub message: Option<String>,
    /// Set while the server accepts `window/workDoneProgress/cancel` for it.
    pub cancel: Option<ide_core::task::CancelHandle>,
}

pub struct Server {
    pub id: ServerId,
    pub name: String,
    pub root: PathBuf,
    /// Configuration from the language definition.
    pub config: LanguageServerConfig,
    /// `config` with the settings hook applied, as the current instance was launched.
    effective: Mutex<Option<LanguageServerConfig>>,
    pub resolved_binary: RwLock<Option<PathBuf>>,
    languages: Mutex<Vec<LanguageId>>,
    state: Mutex<State>,
    /// The instance being initialized, from `initialized` until ready: registrations
    /// sent right after `initialized` must not be lost.
    initializing: Mutex<Option<Running>>,
    /// Fired when the instance being started is abandoned (stop / restart while starting).
    start_cancel: Mutex<CancellationToken>,
    phase: watch::Sender<Phase>,
    status: Mutex<(ServerStatus, Option<String>)>,
    /// Consecutive crashes of short-lived instances.
    crashes: Mutex<usize>,
    /// When the current instance was launched.
    started: Mutex<Option<Instant>>,
    stderr: Mutex<VecDeque<String>>,
    pub progress: Mutex<HashMap<String, Progress>>,
    /// What the editor shows per path: the pushed and the pulled diagnostics together.
    diagnostics: Mutex<HashMap<PathBuf, Vec<lsp::Diagnostic>>>,
    /// `publishDiagnostics` per path.
    pushed: Mutex<HashMap<PathBuf, Vec<lsp::Diagnostic>>>,
    /// `textDocument/diagnostic` reports per path, and the latest pull asked for each.
    pulled: Mutex<HashMap<PathBuf, Pulled>>,
    pulls: Mutex<HashMap<PathBuf, u64>>,
    /// When diagnostics were last published per path (empty lists included).
    published: Mutex<HashMap<PathBuf, Instant>>,
    /// Woken on every `publishDiagnostics` (Inspect Code waits on it).
    pub published_notify: Notify,
    /// Woken when the last `$/progress` task ends.
    idle_notify: Notify,
    /// `experimental/serverStatus` (rust-analyzer): `None` until the server sends
    /// one, then whether it is still loading the project.
    loading: Mutex<Option<bool>>,
    /// Woken whenever a `$/progress` task ends or the server's loading state changes.
    phase_notify: Notify,
    transient: Mutex<HashMap<PathBuf, Transient>>,
    pub java_build_lock: Arc<tokio::sync::Mutex<()>>,
    pub java_autobuild_suspended: std::sync::atomic::AtomicBool,
    pub external_project: tokio::sync::Mutex<crate::external_project::State>,
    pub external_diagnostics: std::sync::atomic::AtomicBool,
    pub external_refresh_queued: std::sync::atomic::AtomicBool,
    /// The instance whose just registered external project is loading, until an open file's
    /// diagnostics arrive (0: none).
    pub external_loading: std::sync::atomic::AtomicU64,
    /// kotlin-lsp's project import as the current instance last reported it.
    pub(crate) import_state: watch::Sender<Option<crate::kotlin_lsp::ImportState>>,
}

impl Server {
    pub fn new(config: LanguageServerConfig, root: PathBuf, language: LanguageId) -> Self {
        Self {
            id: ServerId::next(),
            name: config.name.clone(),
            root,
            config,
            effective: Mutex::new(None),
            resolved_binary: RwLock::new(None),
            languages: Mutex::new(vec![language]),
            state: Mutex::new(State { generation: 0, conn: Conn::Idle, events: VecDeque::new(), publishing: false }),
            initializing: Mutex::new(None),
            start_cancel: Mutex::new(CancellationToken::new()),
            phase: watch::channel(Phase::Down).0,
            status: Mutex::new((ServerStatus::Stopped, None)),
            crashes: Mutex::new(0),
            started: Mutex::new(None),
            stderr: Mutex::new(VecDeque::new()),
            progress: Mutex::new(HashMap::new()),
            diagnostics: Mutex::new(HashMap::new()),
            pushed: Mutex::new(HashMap::new()),
            pulled: Mutex::new(HashMap::new()),
            pulls: Mutex::new(HashMap::new()),
            published: Mutex::new(HashMap::new()),
            published_notify: Notify::new(),
            idle_notify: Notify::new(),
            loading: Mutex::new(None),
            phase_notify: Notify::new(),
            transient: Mutex::new(HashMap::new()),
            java_build_lock: Arc::new(tokio::sync::Mutex::new(())),
            java_autobuild_suspended: std::sync::atomic::AtomicBool::new(false),
            external_project: tokio::sync::Mutex::new(Default::default()),
            external_diagnostics: std::sync::atomic::AtomicBool::new(false),
            external_refresh_queued: std::sync::atomic::AtomicBool::new(false),
            external_loading: std::sync::atomic::AtomicU64::new(0),
            import_state: watch::channel(None).0,
        }
    }

    /// Configuration of the current (or last) instance; the base config before the first launch.
    pub fn effective_config(&self) -> LanguageServerConfig {
        let mut config = self.effective.lock().clone().unwrap_or_else(|| self.config.clone());
        if self.java_autobuild_suspended.load(std::sync::atomic::Ordering::SeqCst) {
            let mut settings = crate::handler::all_settings(&config);
            settings["java"]["autobuild"]["enabled"] = serde_json::json!(false);
            config.settings = Some(settings);
        }
        config
    }

    pub fn set_effective_config(&self, generation: u64, config: LanguageServerConfig) {
        let st = self.state.lock();
        if st.generation == generation && matches!(st.conn, Conn::Starting | Conn::Ready(_)) {
            *self.effective.lock() = Some(config);
        }
    }

    pub fn set_resolved_binary(&self, generation: u64, binary: Option<PathBuf>) -> bool {
        let st = self.state.lock();
        if st.generation != generation || !matches!(st.conn, Conn::Starting) {
            return false;
        }
        *self.resolved_binary.write() = binary;
        true
    }

    pub fn add_language(&self, language: &LanguageId) {
        let mut langs = self.languages.lock();
        if !langs.contains(language) {
            langs.push(language.clone());
        }
    }

    pub fn languages(&self) -> Vec<LanguageId> {
        self.languages.lock().clone()
    }

    // ---- instance state machine ----

    /// Idle → Starting; returns the new generation.
    pub fn begin_start(&self) -> Option<u64> {
        let mut st = self.state.lock();
        if !matches!(st.conn, Conn::Idle) {
            return None;
        }
        st.generation += 1;
        st.conn = Conn::Starting;
        *self.start_cancel.lock() = CancellationToken::new();
        *self.started.lock() = Some(Instant::now());
        self.import_state.send_replace(None);
        self.phase.send_replace(Phase::Starting);
        Some(st.generation)
    }

    /// Publishes instance `generation`'s import state unless a newer start replaced it; checked
    /// under the state lock so it cannot land after [`Self::begin_start`]'s reset.
    pub(crate) fn set_import_state(&self, generation: u64, state: crate::kotlin_lsp::ImportState) {
        let st = self.state.lock();
        if st.generation == generation {
            self.import_state.send_replace(Some(state));
        }
    }

    /// Starting → Missing/Failed, publishing the status the failed start reports
    /// before waiters wake: a request that wakes on `Phase::Down` reads the status
    /// to say why it has no server, and must not still see `Starting`.
    pub fn fail_start(
        &self,
        generation: u64,
        conn: Conn,
        sink: &SharedSink,
        status: ServerStatus,
        message: Option<String>,
    ) -> bool {
        let mut st = self.state.lock();
        if st.generation != generation || !matches!(st.conn, Conn::Starting) {
            return false;
        }
        st.conn = conn;
        self.queue_status(&mut st, status, message);
        self.phase.send_replace(Phase::Down);
        drop(st);
        self.publish(sink);
        true
    }

    /// Starting → Ready. False when the start was superseded or cancelled.
    pub fn mark_ready(&self, generation: u64, run: Running) -> bool {
        let mut st = self.state.lock();
        if st.generation != generation || !matches!(st.conn, Conn::Starting) {
            return false;
        }
        st.conn = Conn::Ready(run);
        *self.initializing.lock() = None;
        true
    }

    /// Wakes requests waiting for the instance (after status and documents are in place).
    pub fn announce_ready(&self, generation: u64) {
        let st = self.state.lock();
        if st.generation == generation && matches!(st.conn, Conn::Ready(_)) {
            self.phase.send_replace(Phase::Ready);
        }
    }

    pub fn running(&self) -> Option<Running> {
        match &self.state.lock().conn {
            Conn::Ready(r) => Some(r.clone()),
            _ => None,
        }
    }

    /// The instance told `initialized`, ready or not.
    pub fn instance(&self) -> Option<Running> {
        self.running().or_else(|| self.initializing.lock().clone())
    }

    /// Generation `generation` once it was told `initialized`, ready or not.
    pub fn initialized_gen(&self, generation: u64) -> Option<Running> {
        self.instance().filter(|r| r.generation == generation)
    }

    pub fn set_initializing(&self, run: Running) -> bool {
        let st = self.state.lock();
        if st.generation != run.generation || !matches!(st.conn, Conn::Starting) {
            return false;
        }
        *self.initializing.lock() = Some(run);
        true
    }

    /// The running instance if it is still generation `generation`.
    pub fn running_gen(&self, generation: u64) -> Option<Running> {
        self.running().filter(|r| r.generation == generation)
    }

    /// Waits while the server is starting; returns the instance once ready.
    pub async fn wait_ready(&self, timeout: Duration) -> Option<Running> {
        let mut rx = self.phase.subscribe();
        let _ = tokio::time::timeout(timeout, rx.wait_for(|p| *p != Phase::Starting)).await;
        self.running()
    }

    /// Ready → Stopping, returning the instance to shut down. An in-flight
    /// start is abandoned instead.
    pub fn begin_stop(&self, sink: &SharedSink, final_stop: bool) -> Option<Running> {
        let mut st = self.state.lock();
        match std::mem::replace(&mut st.conn, Conn::Idle) {
            Conn::Ready(run) => {
                st.conn = Conn::Stopping;
                self.phase.send_replace(Phase::Down);
                Some(run)
            }
            Conn::Starting => {
                st.generation += 1; // invalidates the in-flight start
                self.start_cancel.lock().cancel();
                self.queue_cleanup(&mut st);
                self.queue_status(&mut st, ServerStatus::Stopped, None);
                self.phase.send_replace(Phase::Down);
                drop(st);
                self.publish(sink);
                None
            }
            other => {
                st.conn = other;
                if final_stop {
                    self.queue_status(&mut st, ServerStatus::Stopped, None);
                }
                drop(st);
                self.publish(sink);
                None
            }
        }
    }

    /// Cancelled when the current start is abandoned.
    pub fn start_token(&self) -> CancellationToken {
        self.start_cancel.lock().clone()
    }

    pub fn end_stop(&self, generation: u64, sink: &SharedSink) {
        let mut st = self.state.lock();
        if st.generation != generation || !matches!(st.conn, Conn::Stopping) {
            return;
        }
        self.queue_cleanup(&mut st);
        self.queue_status(&mut st, ServerStatus::Stopped, None);
        st.conn = Conn::Idle;
        self.phase.send_replace(Phase::Down);
        drop(st);
        self.publish(sink);
    }

    /// Retires a crashed instance before another generation can start. Intentional
    /// closes belong to `end_stop`; a late supervisor must not clear its successor.
    pub fn on_closed(&self, generation: u64, sink: &SharedSink, code: Option<i32>) -> Option<Option<Duration>> {
        let mut st = self.state.lock();
        if st.generation != generation || !matches!(st.conn, Conn::Ready(_) | Conn::Starting) {
            return None;
        }
        let tail = self.stderr_tail(5);
        let cfg = self.effective_config();
        let mut message = match (code, &cfg.connect) {
            (Some(c), _) => format!("{} exited with code {c}", self.name),
            (None, Some(addr)) => format!("{}: the connection to the server ({addr}) closed", self.name),
            (None, None) => format!("{} terminated unexpectedly", self.name),
        };
        if !tail.is_empty() {
            message.push_str(":\n");
            message.push_str(&tail);
        }
        let delay = self.record_crash();
        message.push_str(if delay.is_some() {
            "\nRestarting…"
        } else {
            "\nCrashed repeatedly; restart it manually."
        });
        self.queue_cleanup(&mut st);
        self.queue_status(&mut st, ServerStatus::Crashed, Some(message));
        st.conn = if delay.is_some() { Conn::Idle } else { Conn::Failed };
        self.phase.send_replace(Phase::Down);
        drop(st);
        self.publish(sink);
        Some(delay)
    }

    pub fn is_idle_gen(&self, generation: u64) -> bool {
        let st = self.state.lock();
        st.generation == generation && matches!(st.conn, Conn::Idle)
    }

    /// Records a crash; returns the backoff before restarting, or `None` once
    /// [`MAX_RESTARTS`] instances in a row died before running [`STABLE_UPTIME`]
    /// (a server that crashes on every start, however slowly, is not restarted forever).
    pub fn record_crash(&self) -> Option<Duration> {
        let uptime = self.started.lock().map(|t| t.elapsed()).unwrap_or_default();
        let mut crashes = self.crashes.lock();
        if uptime >= STABLE_UPTIME {
            *crashes = 0;
        }
        *crashes += 1;
        let n = *crashes;
        (n <= MAX_RESTARTS).then(|| Duration::from_millis(500) * (1 << (n - 1)) as u32)
    }

    pub fn reset_for_restart(&self) {
        let mut st = self.state.lock();
        *self.crashes.lock() = 0;
        if matches!(st.conn, Conn::Missing | Conn::Failed) {
            st.conn = Conn::Idle;
        }
    }

    // ---- status ----

    pub fn status(&self) -> ServerStatus {
        self.status.lock().0
    }

    pub fn status_message(&self) -> Option<String> {
        self.status.lock().1.clone()
    }

    fn queue_status(&self, st: &mut State, status: ServerStatus, message: Option<String>) {
        let mut cur = self.status.lock();
        if cur.0 == status && cur.1 == message {
            return;
        }
        *cur = (status, message.clone());
        st.events.push_back(IdeEvent::LanguageServer { server: self.id, name: self.name.clone(), status, message });
    }

    fn queue_cleanup(&self, st: &mut State) {
        *self.initializing.lock() = None;
        for (id, title) in self.take_progress() {
            st.events.push_back(IdeEvent::Task {
                id,
                title,
                message: None,
                fraction: None,
                done: true,
                cancellable: false,
            });
        }
        self.progress_ended();
        for path in self.take_diagnostic_paths() {
            st.events.push_back(IdeEvent::Diagnostics {
                path: path.into(),
                source: self.name.clone(),
                items: Vec::new(),
            });
        }
    }

    pub fn emit(&self, sink: &SharedSink, event: IdeEvent) {
        self.state.lock().events.push_back(event);
        self.publish(sink);
    }

    /// One drainer preserves event order, including when a sink reenters
    /// the server. No state or manager lock is held across an external callback.
    fn publish(&self, sink: &SharedSink) {
        let mut st = self.state.lock();
        if st.publishing {
            return;
        }
        st.publishing = true;
        loop {
            let Some(event) = st.events.pop_front() else {
                st.publishing = false;
                return;
            };
            drop(st);
            sink.emit(event);
            st = self.state.lock();
        }
    }

    pub fn starting_status(&self, generation: u64, sink: &SharedSink) -> Option<CancellationToken> {
        let mut st = self.state.lock();
        if st.generation != generation || !matches!(st.conn, Conn::Starting) {
            return None;
        }
        self.queue_status(&mut st, ServerStatus::Starting, None);
        let cancel = self.start_cancel.lock().clone();
        drop(st);
        self.publish(sink);
        Some(cancel)
    }

    /// Ready ⇄ Busy depending on active `$/progress` tokens.
    pub fn refresh_busy_status(&self, sink: &SharedSink) {
        let mut st = self.state.lock();
        if !matches!(st.conn, Conn::Ready(_)) {
            return;
        }
        let busy = self.is_busy();
        self.queue_status(&mut st, if busy { ServerStatus::Busy } else { ServerStatus::Ready }, None);
        drop(st);
        self.publish(sink);
    }

    /// Whether the server reports work in progress (indexing, analysis).
    pub fn is_busy(&self) -> bool {
        !self.progress.lock().is_empty() || *self.loading.lock() == Some(true)
    }

    /// Whether the server says it is still loading the project, so an empty
    /// answer may not be final. Only `serverStatus` tells: `$/progress` also
    /// covers background work (indexing, builds) during which answers are final.
    pub fn is_loading(&self) -> bool {
        *self.loading.lock() == Some(true)
    }

    /// Records `experimental/serverStatus`: `quiescent` false while the project loads (also
    /// set while vtsls loads an external project, see `external_project`).
    pub fn set_loading(&self, sink: &SharedSink, loading: bool) {
        if self.loading.lock().replace(loading) == Some(loading) {
            return;
        }
        self.refresh_busy_status(sink);
        self.phase_ended();
    }

    /// Called after a `$/progress` task ended.
    pub fn progress_ended(&self) {
        self.phase_ended();
    }

    fn phase_ended(&self) {
        self.phase_notify.notify_waiters();
        if !self.is_busy() {
            self.idle_notify.notify_waiters();
        }
    }

    /// Woken when the next loading phase ends.
    pub fn phase_notified(&self) -> tokio::sync::futures::Notified<'_> {
        self.phase_notify.notified()
    }

    /// Waits until no `$/progress` task is active; false on timeout or cancellation.
    pub async fn wait_idle(&self, timeout: Duration, cancel: &CancellationToken) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.idle_notify.notified();
            if !self.is_busy() || self.running().is_none() {
                return !self.is_busy();
            }
            tokio::select! {
                () = notified => {}
                () = tokio::time::sleep_until(deadline) => return !self.is_busy(),
                () = cancel.cancelled() => return false,
            }
        }
    }

    // ---- transiently opened files ----

    /// Registers a holder of the transient file `path` on instance `generation`;
    /// true when the caller must send `didOpen` (first holder).
    pub fn hold_transient(&self, path: &Path, generation: u64) -> bool {
        let mut map = self.transient.lock();
        map.retain(|_, t| t.holders > 0 || t.closed_at.is_some_and(|c| c.elapsed() < TRANSIENT_GRACE));
        let t =
            map.entry(path.to_owned()).or_insert(Transient { holders: 0, generation, taken: false, closed_at: None });
        if t.holders == 0 || t.generation != generation {
            *t = Transient { holders: 1, generation, taken: false, closed_at: None };
            return true;
        }
        t.holders += 1;
        false
    }

    /// Drops a holder of `path`; true when the caller must send `didClose`
    /// (last holder, same instance, and the user did not open the file meanwhile).
    pub fn release_transient(&self, path: &Path, generation: u64) -> bool {
        let mut map = self.transient.lock();
        let Some(t) = map.get_mut(path) else { return false };
        if t.holders == 0 {
            return false;
        }
        t.holders -= 1;
        if t.holders > 0 {
            return false;
        }
        let close = !t.taken && t.generation == generation;
        if close {
            t.closed_at = Some(Instant::now());
        } else {
            map.remove(path);
        }
        close
    }

    /// The user opens `path` on instance `generation`: true when a transient
    /// copy is open there and must be closed before the user's `didOpen`.
    pub fn take_transient(&self, path: &Path, generation: u64) -> bool {
        let mut map = self.transient.lock();
        let Some(t) = map.get_mut(path) else { return false };
        let open = t.holders > 0 && !t.taken && t.generation == generation;
        if t.holders > 0 {
            t.taken = true;
        } else {
            map.remove(path);
        }
        open
    }

    /// Whether diagnostics published for `path` belong to a transient copy
    /// and must not reach the Problems view.
    pub fn suppresses_diagnostics(&self, path: &Path) -> bool {
        self.transient
            .lock()
            .get(path)
            .is_some_and(|t| !t.taken && (t.holders > 0 || t.closed_at.is_some_and(|c| c.elapsed() < TRANSIENT_GRACE)))
    }

    // ---- bookkeeping ----

    pub fn push_stderr(&self, generation: u64, line: String) {
        let st = self.state.lock();
        if st.generation != generation {
            return;
        }
        let mut buf = self.stderr.lock();
        if buf.len() == STDERR_LINES {
            buf.pop_front();
        }
        buf.push_back(line);
    }

    pub fn stderr_tail(&self, n: usize) -> String {
        let buf = self.stderr.lock();
        let lines: Vec<&str> = buf.iter().map(String::as_str).collect();
        crash_excerpt(&lines, n)
    }

    pub fn take_progress(&self) -> Vec<(TaskId, String)> {
        *self.loading.lock() = None;
        self.external_loading.store(0, std::sync::atomic::Ordering::Release);
        self.progress.lock().drain().map(|(_, p)| (p.task, p.title)).collect()
    }

    /// Records the diagnostics the server pushed for `path`; returns what the file now shows.
    pub fn set_diagnostics(&self, path: PathBuf, items: Vec<lsp::Diagnostic>) -> Vec<lsp::Diagnostic> {
        set_or_remove(&mut self.pushed.lock(), path.clone(), items);
        self.combine(path)
    }

    /// Records a pulled report for `path` (`None` items: unchanged since `result_id`'s
    /// predecessor); returns what the file now shows.
    pub fn set_pulled(
        &self,
        path: PathBuf,
        result_id: Option<String>,
        items: Option<Vec<lsp::Diagnostic>>,
    ) -> Vec<lsp::Diagnostic> {
        {
            let mut pulled = self.pulled.lock();
            let entry = pulled.entry(path.clone()).or_default();
            entry.result_id = result_id;
            if let Some(items) = items {
                entry.items = items;
            }
        }
        self.combine(path)
    }

    /// Forgets the pulled report of a closed file; `None` when there was none.
    pub fn clear_pulled(&self, path: &Path) -> Option<Vec<lsp::Diagnostic>> {
        self.pulls.lock().remove(path);
        self.pulled.lock().remove(path)?;
        Some(self.combine(path.to_owned()))
    }

    /// The `resultId` of the last report pulled for `path`.
    pub fn pulled_result_id(&self, path: &Path) -> Option<String> {
        self.pulled.lock().get(path).and_then(|p| p.result_id.clone())
    }

    /// Starts a pull for `path`, superseding earlier ones; see [`Server::is_latest_pull`].
    pub fn next_pull(&self, path: &Path) -> u64 {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.pulls.lock().insert(path.to_owned(), id);
        id
    }

    pub fn is_latest_pull(&self, path: &Path, id: u64) -> bool {
        self.pulls.lock().get(path) == Some(&id)
    }

    fn combine(&self, path: PathBuf) -> Vec<lsp::Diagnostic> {
        let mut items = self.pushed.lock().get(&path).cloned().unwrap_or_default();
        if let Some(pulled) = self.pulled.lock().get(&path) {
            for d in &pulled.items {
                if !items.contains(d) {
                    items.push(d.clone());
                }
            }
        }
        {
            let mut d = self.diagnostics.lock();
            self.published.lock().insert(path.clone(), Instant::now());
            set_or_remove(&mut d, path, items.clone());
        }
        self.published_notify.notify_waiters();
        items
    }

    /// When diagnostics for `path` were last published by this server.
    pub fn last_published(&self, path: &Path) -> Option<Instant> {
        self.published.lock().get(path).copied()
    }

    pub fn diagnostics_for(&self, path: &Path) -> Vec<lsp::Diagnostic> {
        self.diagnostics.lock().get(path).cloned().unwrap_or_default()
    }

    /// Every published diagnostic, by file.
    pub fn diagnostics_snapshot(&self) -> Vec<(PathBuf, lsp::Diagnostic)> {
        let d = self.diagnostics.lock();
        d.iter().flat_map(|(p, items)| items.iter().map(move |i| (p.clone(), i.clone()))).collect()
    }

    /// The current diagnostics of each file that has some.
    pub fn diagnostics_by_path(&self) -> Vec<(PathBuf, Vec<lsp::Diagnostic>)> {
        self.diagnostics.lock().iter().map(|(p, d)| (p.clone(), d.clone())).collect()
    }

    pub fn take_diagnostic_paths(&self) -> Vec<PathBuf> {
        self.published.lock().clear();
        self.pushed.lock().clear();
        self.pulled.lock().clear();
        self.pulls.lock().clear();
        self.diagnostics.lock().drain().map(|(p, _)| p).collect()
    }
}

/// A file's last `textDocument/diagnostic` report.
#[derive(Default)]
struct Pulled {
    result_id: Option<String>,
    items: Vec<lsp::Diagnostic>,
}

fn set_or_remove(map: &mut HashMap<PathBuf, Vec<lsp::Diagnostic>>, path: PathBuf, items: Vec<lsp::Diagnostic>) {
    if items.is_empty() {
        map.remove(&path);
    } else {
        map.insert(path, items);
    }
}

/// The last `n` stderr lines, led by the exception headline: Node.js / Python /
/// JVM crashes print the error first and a stack after it, so a plain tail
/// shows frames without saying what went wrong.
pub(crate) fn crash_excerpt(lines: &[&str], n: usize) -> String {
    const MAX_LINES: usize = 12;
    let start = lines.len().saturating_sub(n);
    let excerpt: Vec<&str> = match lines.iter().rposition(|l| is_error_headline(l)) {
        Some(i) if i >= start => lines[start..].to_vec(),
        Some(i) if lines.len() - i <= MAX_LINES => lines[i..].to_vec(),
        Some(i) => [lines[i], "…"].into_iter().chain(lines[start..].iter().copied()).collect(),
        None => lines[start..].to_vec(),
    };
    excerpt.join("\n")
}

fn is_error_headline(line: &str) -> bool {
    let l = line.trim_start();
    let head = l.split(':').next().unwrap_or_default();
    let named = (head.ends_with("Error") || head.ends_with("Exception")) && !head.contains(' ') && head.len() < l.len();
    named || l.starts_with("Exception in thread") || l.starts_with("thread '") && l.contains("panicked")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retirement_events_preserve_successor_diagnostics_on_the_same_path() {
        for stopping in [false, true] {
            let s = Arc::new(server());
            let path = PathBuf::from("/p/a.vue");
            let generation = s.begin_start().unwrap();
            s.set_diagnostics(path.clone(), vec![lsp::Diagnostic::default()]);
            s.progress.lock().insert(
                "old".into(),
                Progress { task: TaskId::next(), title: "Old work".into(), message: None, cancel: None },
            );
            let seen = Arc::new(Mutex::new(Vec::new()));
            let manager = Arc::new(Mutex::new(std::sync::Weak::<crate::LspManager>::new()));
            let sink: SharedSink = {
                let (s, path, seen, manager) = (s.clone(), path.clone(), seen.clone(), manager.clone());
                Arc::new(move |event: IdeEvent| match event {
                    IdeEvent::Diagnostics { items, .. } => seen.lock().push(items.len()),
                    IdeEvent::Task { done: true, .. } => {
                        s.begin_start().unwrap();
                        let shown = s.set_diagnostics(path.clone(), vec![lsp::Diagnostic::default()]);
                        let mgr = manager.lock().upgrade().unwrap();
                        mgr.emit_diagnostics(&s, path.clone(), shown, crate::text::Encoding::Utf16);
                    }
                    _ => {}
                })
            };
            let mgr = crate::LspManager::new(
                PathBuf::from("/p"),
                Arc::new(ide_language::LanguageRegistry::from_configs(vec![])),
                sink.clone(),
            );
            *manager.lock() = Arc::downgrade(&mgr);
            if stopping {
                s.state.lock().conn = Conn::Stopping;
                s.end_stop(generation, &sink);
            } else {
                assert!(s.on_closed(generation, &sink, None).is_some());
            }
            assert_eq!(s.diagnostics_for(&path).len(), 1);
            assert_eq!(*seen.lock(), vec![0, 1], "the UI must retain the replacement's diagnostics");
        }
    }

    fn server() -> Server {
        let cfg: LanguageServerConfig = toml::from_str("name = \"s\"\ncommand = \"s\"").unwrap();
        Server::new(cfg, PathBuf::from("/p"), LanguageId::new("vue"))
    }

    #[test]
    fn crashes_of_short_lived_instances_exhaust_the_budget_whatever_the_spacing() {
        let s = server();
        for _ in 0..MAX_RESTARTS {
            // Even crashes spread minutes apart count while each instance dies young.
            *s.started.lock() = Some(Instant::now());
            assert!(s.record_crash().is_some());
        }
        *s.started.lock() = Some(Instant::now());
        assert_eq!(s.record_crash(), None);
        s.reset_for_restart();
        assert!(s.record_crash().is_some());
    }

    #[test]
    fn a_stable_run_resets_the_budget() {
        let s = server();
        for _ in 0..MAX_RESTARTS {
            assert!(s.record_crash().is_some());
        }
        *s.started.lock() = Instant::now().checked_sub(STABLE_UPTIME);
        assert_eq!(s.record_crash(), Some(Duration::from_millis(500)));
    }

    #[test]
    fn external_build_suspends_only_the_effective_autobuild_setting() {
        let mut config: LanguageServerConfig = toml::from_str("name = \"jdtls\"\ncommand = \"jdtls\"").unwrap();
        config.settings = Some(serde_json::json!({"java": {"autobuild": {"enabled": true}, "other": "kept"}}));
        let server = Server::new(config.clone(), PathBuf::from("/p"), LanguageId::new("java"));
        server.java_autobuild_suspended.store(true, std::sync::atomic::Ordering::SeqCst);
        let settings = crate::handler::all_settings(&server.effective_config());
        assert_eq!(settings["java"]["autobuild"]["enabled"], false);
        assert_eq!(settings["java"]["other"], "kept");
        server.java_autobuild_suspended.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(server.effective_config(), config);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_start_reports_its_status_before_waiters_wake() {
        // The race behind "jdtls is not ready (Starting)": a request woken by the
        // phase change reads the status to say why it has no server, so the status
        // must already be the failure's.
        let s = Arc::new(server());
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let generation = s.begin_start().unwrap();
        let waiter = {
            let s = s.clone();
            tokio::spawn(async move {
                let run = s.wait_ready(Duration::from_secs(30)).await;
                (run.is_none(), s.status())
            })
        };
        tokio::task::yield_now().await;
        assert!(s.fail_start(generation, Conn::Failed, &sink, ServerStatus::Crashed, Some("boom".into())));
        assert_eq!(waiter.await.unwrap(), (true, ServerStatus::Crashed));
    }

    #[test]
    fn a_superseded_start_is_not_announced() {
        let s = server();
        let generation = s.begin_start().unwrap();
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        s.begin_stop(&sink, false); // abandons the start and invalidates its generation
        assert!(!s.fail_start(generation, Conn::Failed, &sink, ServerStatus::Crashed, Some("boom".into())));
        assert_eq!(s.status(), ServerStatus::Stopped);
    }

    #[test]
    fn failure_publication_can_restart_without_overwriting_the_new_phase() {
        for conn in [Conn::Missing, Conn::Failed] {
            let s = Arc::new(server());
            let generation = s.begin_start().unwrap();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink: SharedSink = {
                let (s, seen) = (s.clone(), seen.clone());
                Arc::new(move |event: IdeEvent| {
                    if let IdeEvent::LanguageServer { status, .. } = event {
                        seen.lock().push(status);
                        if status == ServerStatus::Crashed {
                            s.reset_for_restart();
                            let next = s.begin_start().unwrap();
                            let sink: SharedSink = Arc::new(|_: IdeEvent| {});
                            assert!(s.starting_status(next, &sink).is_some());
                        }
                    }
                })
            };
            assert!(s.fail_start(generation, conn, &sink, ServerStatus::Crashed, Some("boom".into())));
            assert_eq!(*s.phase.borrow(), Phase::Starting);
            assert_eq!(s.status(), ServerStatus::Starting);
            assert_eq!(*seen.lock(), vec![ServerStatus::Crashed, ServerStatus::Starting]);
        }
    }

    #[test]
    fn retirement_callbacks_cannot_clear_successor_state() {
        for stopping in [false, true] {
            let s = Arc::new(server());
            let generation = s.begin_start().unwrap();
            s.set_diagnostics(PathBuf::from("old"), vec![lsp::Diagnostic::default()]);
            *s.loading.lock() = Some(true);
            if stopping {
                s.state.lock().conn = Conn::Stopping;
            }
            let sink: SharedSink = {
                let s = s.clone();
                Arc::new(move |event: IdeEvent| {
                    if matches!(event, IdeEvent::Diagnostics { .. }) {
                        let next = s.begin_start().unwrap();
                        s.set_diagnostics(PathBuf::from("new"), vec![lsp::Diagnostic::default()]);
                        *s.loading.lock() = Some(true);
                        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
                        assert!(s.starting_status(next, &sink).is_some());
                    }
                })
            };
            if stopping {
                s.end_stop(generation, &sink);
            } else {
                assert_eq!(s.on_closed(generation, &sink, None), Some(Some(Duration::from_millis(500))));
            }
            assert_eq!(*s.phase.borrow(), Phase::Starting);
            assert_eq!(s.status(), ServerStatus::Starting);
            assert!(s.diagnostics_for(Path::new("old")).is_empty());
            assert_eq!(s.diagnostics_for(Path::new("new")).len(), 1);
            assert!(s.is_loading());
            assert_eq!(s.on_closed(generation, &sink, None), None);
            s.end_stop(generation, &sink);
            assert_eq!(*s.phase.borrow(), Phase::Starting);
            assert_eq!(s.diagnostics_for(Path::new("new")).len(), 1);
        }
    }

    #[test]
    fn a_start_keeps_its_cancel_token_when_publication_restarts_it() {
        let s = Arc::new(server());
        let generation = s.begin_start().unwrap();
        let sink: SharedSink = {
            let s = s.clone();
            Arc::new(move |event: IdeEvent| {
                if matches!(event, IdeEvent::LanguageServer { status: ServerStatus::Starting, .. })
                    && s.state.lock().generation == generation
                {
                    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
                    s.begin_stop(&sink, false);
                    let next = s.begin_start().unwrap();
                    assert!(s.starting_status(next, &sink).is_some());
                }
            })
        };
        let cancel = s.starting_status(generation, &sink).unwrap();
        assert!(cancel.is_cancelled());
        assert!(!s.start_token().is_cancelled());
        assert!(s.starting_status(generation, &sink).is_none());
        assert_eq!(*s.phase.borrow(), Phase::Starting);
        assert_eq!(s.status(), ServerStatus::Starting);
    }

    #[test]
    fn abandoned_start_cannot_replace_successor_launch_metadata() {
        let s = server();
        let old = s.begin_start().unwrap();
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        s.begin_stop(&sink, false);
        let next = s.begin_start().unwrap();
        let mut config = s.config.clone();
        config.command = "successor".into();
        s.set_effective_config(next, config.clone());
        assert!(s.set_resolved_binary(next, Some(PathBuf::from("successor"))));
        s.push_stderr(next, "successor output".into());
        config.command = "abandoned".into();
        s.set_effective_config(old, config);
        assert!(!s.set_resolved_binary(old, Some(PathBuf::from("abandoned"))));
        s.push_stderr(old, "abandoned output".into());
        assert_eq!(s.effective_config().command, "successor");
        assert_eq!(*s.resolved_binary.read(), Some(PathBuf::from("successor")));
        assert_eq!(s.stderr_tail(5), "successor output");
    }

    #[test]
    fn intentional_close_is_retired_only_by_the_stop_owner() {
        let s = server();
        let generation = s.begin_start().unwrap();
        s.state.lock().conn = Conn::Stopping;
        s.set_diagnostics(PathBuf::from("old"), vec![lsp::Diagnostic::default()]);
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        assert_eq!(s.on_closed(generation, &sink, None), None);
        assert_eq!(s.diagnostics_for(Path::new("old")).len(), 1);
        assert!(s.begin_start().is_none());
        s.end_stop(generation, &sink);
        assert!(s.diagnostics_for(Path::new("old")).is_empty());
        let next = s.begin_start().unwrap();
        assert!(s.starting_status(next, &sink).is_some());
        assert_eq!(s.on_closed(generation, &sink, None), None);
        assert_eq!(*s.phase.borrow(), Phase::Starting);
        assert_eq!(*s.crashes.lock(), 0);
    }

    #[test]
    fn crash_excerpt_keeps_the_exception_line() {
        // Node.js 24 crash of vue-language-server (issue #25), verbatim shape.
        let node = [
            "C:\\tools\\node_modules\\@vue\\language-server\\lib\\server.js:40",
            "                        projectInfoPromise = sendTsServerRequest('_vue:' + ts.server.protocol.CommandTypes.ProjectInfo, {",
            "                                                                                     ^",
            "",
            "TypeError: Cannot read properties of undefined (reading 'protocol')",
            "    at Object.getLanguageService (C:\\tools\\node_modules\\@vue\\language-server\\lib\\server.js:40:86)",
            "    at Immediate.<anonymous> (C:\\tools\\node_modules\\@volar\\language-server\\lib\\features\\languageFeatures.js:744:62)",
            "    at process.processImmediate (node:internal/timers:504:21)",
            "",
            "Node.js v24.12.0",
        ];
        let out = crash_excerpt(&node, 5);
        assert!(out.starts_with("TypeError: Cannot read properties of undefined (reading 'protocol')"), "{out}");
        assert!(out.ends_with("Node.js v24.12.0"));

        let python = [
            "Traceback (most recent call last):",
            "  File \"x.py\", line 1",
            "ModuleNotFoundError: No module named 'jedi'",
        ];
        assert_eq!(crash_excerpt(&python, 5), python.join("\n"));

        let mut long_stack = vec!["Exception in thread \"main\" java.lang.IllegalStateException: boom"];
        long_stack.extend(std::iter::repeat_n("\tat a.b.C.d(C.java:1)", 30));
        let out = crash_excerpt(&long_stack, 5);
        assert!(out.starts_with("Exception in thread \"main\""), "{out}");
        assert_eq!(out.lines().count(), 7);

        let plain = ["starting", "listening", "bye"];
        assert_eq!(crash_excerpt(&plain, 2), "listening\nbye");
        // "Error" in prose is not a headline.
        assert_eq!(crash_excerpt(&["No Error here: fine", "a", "b"], 2), "a\nb");
    }
}
