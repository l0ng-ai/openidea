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
    languages: Mutex<Vec<LanguageId>>,
    state: Mutex<State>,
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
    diagnostics: Mutex<HashMap<PathBuf, Vec<lsp::Diagnostic>>>,
    /// When diagnostics were last published per path (empty lists included).
    published: Mutex<HashMap<PathBuf, Instant>>,
    /// Woken on every `publishDiagnostics` (Inspect Code waits on it).
    pub published_notify: Notify,
    /// Woken when the last `$/progress` task ends.
    idle_notify: Notify,
    transient: Mutex<HashMap<PathBuf, Transient>>,
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
            start_cancel: Mutex::new(CancellationToken::new()),
            phase: watch::channel(Phase::Down).0,
            status: Mutex::new((ServerStatus::Stopped, None)),
            crashes: Mutex::new(0),
            started: Mutex::new(None),
            stderr: Mutex::new(VecDeque::new()),
            progress: Mutex::new(HashMap::new()),
            diagnostics: Mutex::new(HashMap::new()),
            published: Mutex::new(HashMap::new()),
            published_notify: Notify::new(),
            idle_notify: Notify::new(),
            transient: Mutex::new(HashMap::new()),
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
        *self.start_cancel.lock() = CancellationToken::new();
        *self.started.lock() = Some(Instant::now());
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
                self.start_cancel.lock().cancel();
                self.phase.send_replace(Phase::Down);
                None
            }
            other => {
                st.conn = other;
                None
            }
        }
    }

    /// Cancelled when the current start is abandoned.
    pub fn start_token(&self) -> CancellationToken {
        self.start_cancel.lock().clone()
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
        *self.crashes.lock() = 0;
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

    /// Whether the server reports work in progress (indexing, analysis).
    pub fn is_busy(&self) -> bool {
        !self.progress.lock().is_empty()
    }

    /// Called after a `$/progress` task ended.
    pub fn progress_ended(&self) {
        if !self.is_busy() {
            self.idle_notify.notify_waiters();
        }
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

    pub fn push_stderr(&self, line: String) {
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

    /// The current diagnostics of each file that has some.
    pub fn diagnostics_by_path(&self) -> Vec<(PathBuf, Vec<lsp::Diagnostic>)> {
        self.diagnostics.lock().iter().map(|(p, d)| (p.clone(), d.clone())).collect()
    }

    pub fn take_diagnostic_paths(&self) -> Vec<PathBuf> {
        self.published.lock().clear();
        self.diagnostics.lock().drain().map(|(p, _)| p).collect()
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
