//! One configured server for a `(name, root)` pair and the state of its current instance.

use crate::caps::ServerCaps;
use ide_core::event::ServerStatus;
use ide_core::{IdeEvent, LanguageId, ServerId, SharedSink, TaskId};
use ide_jsonrpc::Peer;
use ide_language::LanguageServerConfig;
use lsp_types as lsp;
use parking_lot::{Mutex, RwLock};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Notify, watch};

const CRASH_WINDOW: Duration = Duration::from_secs(180);
const MAX_RESTARTS: usize = 3;
const STDERR_LINES: usize = 50;

/// A live, initialized instance.
#[derive(Clone)]
pub struct Running {
    pub generation: u64,
    pub peer: Peer,
    pub caps: Arc<RwLock<ServerCaps>>,
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
}

pub struct Progress {
    pub task: TaskId,
    pub title: String,
    pub message: Option<String>,
}

pub struct Server {
    pub id: ServerId,
    pub name: String,
    pub root: PathBuf,
    /// Configuration from the language definition.
    pub config: LanguageServerConfig,
    /// `config` with the settings hook applied, as the current instance was launched.
    effective: Mutex<Option<LanguageServerConfig>>,
    languages: Mutex<Vec<LanguageId>>,
    state: Mutex<State>,
    phase: watch::Sender<Phase>,
    status: Mutex<(ServerStatus, Option<String>)>,
    crashes: Mutex<VecDeque<Instant>>,
    stderr: Mutex<VecDeque<String>>,
    pub progress: Mutex<HashMap<String, Progress>>,
    diagnostics: Mutex<HashMap<PathBuf, Vec<lsp::Diagnostic>>>,
    /// When diagnostics were last published per path (empty lists included).
    published: Mutex<HashMap<PathBuf, Instant>>,
    /// Woken on every `publishDiagnostics` (Inspect Code waits on it).
    pub published_notify: Notify,
}

impl Server {
    pub fn new(config: LanguageServerConfig, root: PathBuf, language: LanguageId) -> Self {
        Self {
            id: ServerId::next(),
            name: config.name.clone(),
            root,
            config,
            effective: Mutex::new(None),
            languages: Mutex::new(vec![language]),
            state: Mutex::new(State { generation: 0, conn: Conn::Idle }),
            phase: watch::channel(Phase::Down).0,
            status: Mutex::new((ServerStatus::Stopped, None)),
            crashes: Mutex::new(VecDeque::new()),
            stderr: Mutex::new(VecDeque::new()),
            progress: Mutex::new(HashMap::new()),
            diagnostics: Mutex::new(HashMap::new()),
            published: Mutex::new(HashMap::new()),
            published_notify: Notify::new(),
        }
    }

    /// Configuration of the current (or last) instance; the base config before the first launch.
    pub fn effective_config(&self) -> LanguageServerConfig {
        self.effective.lock().clone().unwrap_or_else(|| self.config.clone())
    }

    pub fn set_effective_config(&self, config: LanguageServerConfig) {
        *self.effective.lock() = Some(config);
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
        self.phase.send_replace(Phase::Starting);
        Some(st.generation)
    }

    /// Starting → Missing/Failed.
    pub fn finish_start(&self, generation: u64, conn: Conn) -> bool {
        let mut st = self.state.lock();
        if st.generation == generation && matches!(st.conn, Conn::Starting) {
            st.conn = conn;
            self.phase.send_replace(Phase::Down);
            return true;
        }
        false
    }

    /// Starting → Ready. False when the start was superseded or cancelled.
    pub fn mark_ready(&self, generation: u64, run: Running) -> bool {
        let mut st = self.state.lock();
        if st.generation != generation || !matches!(st.conn, Conn::Starting) {
            return false;
        }
        st.conn = Conn::Ready(run);
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
    pub fn begin_stop(&self) -> Option<Running> {
        let mut st = self.state.lock();
        match std::mem::replace(&mut st.conn, Conn::Idle) {
            Conn::Ready(run) => {
                st.conn = Conn::Stopping;
                self.phase.send_replace(Phase::Down);
                Some(run)
            }
            Conn::Starting => {
                st.generation += 1; // invalidates the in-flight start
                self.phase.send_replace(Phase::Down);
                None
            }
            other => {
                st.conn = other;
                None
            }
        }
    }

    pub fn end_stop(&self, generation: u64) {
        let mut st = self.state.lock();
        if st.generation == generation && matches!(st.conn, Conn::Stopping) {
            st.conn = Conn::Idle;
        }
    }

    /// Instance `generation`'s connection closed. `None` if superseded, else whether
    /// the close was intentional.
    pub fn on_closed(&self, generation: u64) -> Option<bool> {
        let mut st = self.state.lock();
        if st.generation != generation {
            return None;
        }
        match &st.conn {
            Conn::Ready(_) | Conn::Starting => {
                st.conn = Conn::Idle;
                self.phase.send_replace(Phase::Down);
                Some(false)
            }
            _ => Some(true),
        }
    }

    pub fn is_idle_gen(&self, generation: u64) -> bool {
        let st = self.state.lock();
        st.generation == generation && matches!(st.conn, Conn::Idle)
    }

    pub fn give_up(&self, generation: u64) {
        let mut st = self.state.lock();
        if st.generation == generation && matches!(st.conn, Conn::Idle) {
            st.conn = Conn::Failed;
        }
    }

    /// Records a crash; returns the backoff before restarting, or `None` when
    /// the restart budget for the window is exhausted.
    pub fn record_crash(&self) -> Option<Duration> {
        let mut crashes = self.crashes.lock();
        let now = Instant::now();
        crashes.push_back(now);
        while crashes.front().is_some_and(|t| now.duration_since(*t) > CRASH_WINDOW) {
            crashes.pop_front();
        }
        let n = crashes.len();
        (n <= MAX_RESTARTS).then(|| Duration::from_millis(500) * (1 << (n - 1)) as u32)
    }

    pub fn reset_for_restart(&self) {
        self.crashes.lock().clear();
        let mut st = self.state.lock();
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

    pub fn set_status(&self, sink: &SharedSink, status: ServerStatus, message: Option<String>) {
        {
            let mut cur = self.status.lock();
            if cur.0 == status && cur.1 == message {
                return;
            }
            *cur = (status, message.clone());
        }
        sink.emit(IdeEvent::LanguageServer { server: self.id, name: self.name.clone(), status, message });
    }

    /// Ready ⇄ Busy depending on active `$/progress` tokens.
    pub fn refresh_busy_status(&self, sink: &SharedSink) {
        if self.running().is_none() {
            return;
        }
        let busy = !self.progress.lock().is_empty();
        self.set_status(sink, if busy { ServerStatus::Busy } else { ServerStatus::Ready }, None);
    }

    // ---- bookkeeping ----

    pub fn push_stderr(&self, line: String) {
        let mut buf = self.stderr.lock();
        if buf.len() == STDERR_LINES {
            buf.pop_front();
        }
        buf.push_back(line);
    }

    pub fn stderr_tail(&self, n: usize) -> String {
        let buf = self.stderr.lock();
        let skip = buf.len().saturating_sub(n);
        buf.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n")
    }

    pub fn take_progress(&self) -> Vec<(TaskId, String)> {
        self.progress.lock().drain().map(|(_, p)| (p.task, p.title)).collect()
    }

    pub fn set_diagnostics(&self, path: PathBuf, items: Vec<lsp::Diagnostic>) {
        {
            let mut d = self.diagnostics.lock();
            self.published.lock().insert(path.clone(), Instant::now());
            if items.is_empty() {
                d.remove(&path);
            } else {
                d.insert(path, items);
            }
        }
        self.published_notify.notify_waiters();
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

    pub fn take_diagnostic_paths(&self) -> Vec<PathBuf> {
        self.published.lock().clear();
        self.diagnostics.lock().drain().map(|(p, _)| p).collect()
    }
}
