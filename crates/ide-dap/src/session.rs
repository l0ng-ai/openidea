//! One debug session: the adapter connection, its capabilities, the event
//! loop translating DAP events into `IdeEvent::Debug`, and reverse requests.

use crate::adapter::AdapterSpec;
use crate::connection::{Connection, DapError, Incoming};
use crate::{Breakpoint, BreakpointState, DataBreakpoint, DebugManager, FunctionBreakpoint, SessionOwner};
use ide_core::event::DebugEvent;
#[cfg(unix)]
use ide_core::process::process_tree;
use ide_core::{DebugSessionId, IdeEvent, TaskId};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Weak;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Child;
use tokio::sync::{mpsc, watch};

/// What has to be re-sent on the next stop.
#[derive(Default)]
pub(crate) struct PendingRestore {
    pub files: BTreeSet<PathBuf>,
    pub functions: bool,
    pub data: bool,
}

pub(crate) struct Session {
    pub id: DebugSessionId,
    /// Who started the session (inherited by child sessions); all its events go to the owner's sink.
    pub owner: SessionOwner,
    pub name: String,
    pub adapter: String,
    pub parent: Option<DebugSessionId>,
    pub request: String,
    pub conn: Connection,
    pub spec: AdapterSpec,
    /// TCP port of a server-mode adapter (for `startDebugging` child sessions).
    pub port: Option<u16>,
    pub caps: Mutex<Value>,
    pub adapter_process: Mutex<Option<Child>>,
    /// Processes started for `runInTerminal`.
    pub debuggees: Mutex<Vec<Child>>,
    /// The terminal a `runInTerminal` program runs in: typed input goes to it.
    pub program: Mutex<Option<ProgramTerminal>>,
    /// The job object over the adapter and everything it started: the program an adapter
    /// like java-debug launches is its child, so a forced stop (and the session's
    /// cleanup) ends the whole tree even when the adapter exited first and the reported
    /// pid no longer names it. `None` when the assignment failed; the kill then falls
    /// back to the captured process tree.
    #[cfg(windows)]
    pub job: Mutex<Option<ide_core::process::Job>>,
    /// Set once `configurationDone` was sent; breakpoint updates go out live after that.
    pub configured: AtomicBool,
    pub initialized: watch::Sender<bool>,
    pub startup_cancel: ide_core::CancellationToken,
    pub output_drained: watch::Sender<bool>,
    pub terminated: AtomicBool,
    /// Set by a second Stop: the one waiting for the program kills it instead.
    pub stop_force: AtomicBool,
    /// `systemProcessId` from the adapter's `process` event: the program being debugged.
    pub debuggee_pid: AtomicI64,
    /// The JVM an app-launched (Kotlin) session started, or the local JVM an attach session
    /// found by its JDWP port. Separate from `debuggee_pid`, which decides how Stop signals the
    /// program and is 0 for Kotlin.
    pub jvm_pid: AtomicI64,
    /// JDWP port of an attach to a local JVM, to look the JVM up again; unset for a remote one.
    pub jdwp_port: std::sync::OnceLock<u16>,
    /// The attach goes through the listen-mode relay of [`crate::jdwp::listen_for_jvm`].
    pub listen_relay: AtomicBool,
    pub suspended: Suspension,
    /// Pids signalled for the current stop: the reported pid and everything it started (an
    /// adapter may report the launcher shell, whose child is the program).
    #[cfg_attr(not(unix), allow(dead_code))]
    pub stop_pids: parking_lot::Mutex<Vec<i32>>,
    #[cfg(windows)]
    pub stop_tree: Mutex<Option<ide_core::process::ProcessTree>>,
    /// Breakpoints replaced for run to cursor / force stepping, restored on the next stop.
    pub pending_restore: Mutex<PendingRestore>,
    /// Adapter breakpoint id → (file, index in the stored list).
    pub breakpoint_ids: Mutex<HashMap<i64, (PathBuf, usize)>>,
    /// Resolved path → the path as the IDE knows it, for adapters given resolved paths.
    resolved_paths: Mutex<HashMap<PathBuf, PathBuf>>,
    progress: Mutex<HashMap<String, TaskId>>,
    /// Relay between a Kotlin adapter and its JVM. Dropping it closes both sockets.
    pub jdwp_link: parking_lot::Mutex<Option<ide_jdwp::JdwpLink>>,
    pub jvm_inspector: parking_lot::Mutex<Option<Arc<dyn ide_jvm_inspect::JvmInspector>>>,
    /// One inspector request per session at a time.
    pub inspect_lock: tokio::sync::Mutex<()>,
    /// Cancelled when the session ends, so a request still waiting on the inspector lets go of
    /// it (and of the JDWP link it holds).
    pub ended: ide_core::CancellationToken,
    /// `hostName` (empty when absent) and `port` of the session's `attach` request, as the IDE
    /// was given them: Kotlin then replaces them with the link's. Unlike `jdwp_port`, also set
    /// for a remote JVM.
    pub attach_target: std::sync::OnceLock<(String, u16)>,
    /// Set once `configure` has recorded where the program's JVM is (the fields above, the
    /// Kotlin link), just before the `launch`/`attach` request goes out.
    pub jvm_located: watch::Sender<bool>,
    pub kotlin_mirror: Mutex<Option<crate::kotlin::SourceMirror>>,
    pub jvm_memory: tokio::sync::Mutex<crate::JvmMemoryState>,
}

/// Which threads of the program are suspended: each from its `stopped` event until a
/// `continued` event or a successful resume/step request for it. Never cleared elsewhere, since
/// a stale "suspended" only makes a later check refuse. fwcd and java-debug stop a breakpoint's
/// thread alone, so a thread can run while another stays stopped.
///
/// A resume reply ends only the stops taken before the request was sent: a thread's next
/// `stopped` event can overtake the reply. The check and the removal happen under one lock, so
/// no stop can land between them and be lost.
#[derive(Default)]
pub(crate) struct Suspension(Mutex<Stops>);

#[derive(Default)]
struct Stops {
    /// Counts stops, and moves back to an earlier stopped thread: an object read under one
    /// ticket is stale under another.
    ticket: u64,
    /// Threads stopped alone by their event, oldest first, with the ticket of that stop.
    threads: Vec<(i64, u64)>,
    /// The ticket of a stop of every thread (`allThreadsStopped`, or no thread id): any resume
    /// ends it.
    all: Option<u64>,
}

impl Stops {
    fn latest(&self) -> Option<u64> {
        self.threads.last().map(|&(_, ticket)| ticket).max(self.all)
    }

    /// Ends the stops taken by ticket `upto` of `thread`, or of every thread.
    fn release(&mut self, thread: Option<i64>, every: bool, upto: u64) {
        let latest = self.latest();
        if every || thread.is_none() || self.all.is_some_and(|t| t <= upto) {
            self.all = self.all.filter(|&t| t > upto);
            self.threads.retain(|&(_, t)| t > upto);
        } else {
            self.threads.retain(|&(id, t)| Some(id) != thread || t > upto);
        }
        // Back on an earlier thread's stop, as the JDWP link moves to it with a new generation.
        let now = self.latest();
        if now.is_some() && now != latest {
            self.ticket += 1;
        }
    }
}

impl Suspension {
    /// Whether some thread is stopped.
    pub fn get(&self) -> bool {
        let stops = self.0.lock();
        stops.all.is_some() || !stops.threads.is_empty()
    }

    /// A `stopped` event; `all`: its `allThreadsStopped`.
    pub fn stopped(&self, thread: Option<i64>, all: bool) {
        let mut stops = self.0.lock();
        stops.ticket += 1;
        let ticket = stops.ticket;
        match thread.filter(|_| !all) {
            Some(thread) => {
                stops.threads.retain(|&(id, _)| id != thread);
                stops.threads.push((thread, ticket));
            }
            None => stops.all = Some(ticket),
        }
    }

    /// A `continued` event; `all`: its `allThreadsContinued`.
    pub fn continued(&self, thread: Option<i64>, all: bool) {
        self.0.lock().release(thread, all, u64::MAX);
    }

    /// Take before sending a resume-like request and pass to [`Self::resumed`].
    pub fn ticket(&self) -> u64 {
        self.0.lock().ticket
    }

    /// After a successful resume-like request for `thread`; `all`: every thread ran.
    pub fn resumed(&self, ticket: u64, thread: i64, all: bool) {
        self.0.lock().release(Some(thread), all, ticket);
    }
}

/// Adapters that only match files by their resolved path: Godot maps a script to
/// `res://` by prefix and silently never stops at a breakpoint set through a
/// symlinked path (`/tmp/game` while the editor has `/private/tmp/game`).
const RESOLVES_PATHS: &[&str] = &["godot"];

impl Session {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: DebugSessionId,
        owner: SessionOwner,
        name: String,
        adapter: String,
        parent: Option<DebugSessionId>,
        request: String,
        conn: Connection,
        spec: AdapterSpec,
        port: Option<u16>,
        child: Option<Child>,
    ) -> Self {
        // Before `child` moves into the session: the adapter is the root of the job, so
        // everything it starts (java-debug's JVM) is in there by inheritance.
        #[cfg(windows)]
        let job = child.as_ref().and_then(tokio::process::Child::id).and_then(ide_core::process::Job::for_pid);
        Self {
            id,
            owner,
            name,
            adapter,
            parent,
            request,
            conn,
            spec,
            port,
            caps: Mutex::new(Value::Null),
            adapter_process: Mutex::new(child),
            debuggees: Mutex::new(Vec::new()),
            program: Mutex::new(None),
            #[cfg(windows)]
            job: Mutex::new(job),
            configured: AtomicBool::new(false),
            initialized: watch::channel(false).0,
            startup_cancel: ide_core::CancellationToken::new(),
            output_drained: watch::channel(true).0,
            terminated: AtomicBool::new(false),
            stop_force: AtomicBool::new(false),
            debuggee_pid: AtomicI64::new(0),
            jvm_pid: AtomicI64::new(0),
            jdwp_port: std::sync::OnceLock::new(),
            listen_relay: AtomicBool::new(false),
            suspended: Suspension::default(),
            stop_pids: parking_lot::Mutex::new(Vec::new()),
            #[cfg(windows)]
            stop_tree: Mutex::new(None),
            pending_restore: Mutex::default(),
            breakpoint_ids: Mutex::new(HashMap::new()),
            resolved_paths: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
            jdwp_link: parking_lot::Mutex::new(None),
            jvm_inspector: parking_lot::Mutex::new(None),
            inspect_lock: tokio::sync::Mutex::default(),
            ended: ide_core::CancellationToken::new(),
            attach_target: std::sync::OnceLock::new(),
            jvm_located: watch::channel(false).0,
            kotlin_mirror: Mutex::new(None),
            jvm_memory: tokio::sync::Mutex::default(),
        }
    }

    pub fn emit(&self, event: DebugEvent) {
        self.owner.sink.emit(IdeEvent::Debug { session: self.id, event });
    }

    /// `path` as sent to the adapter (resolved for [`RESOLVES_PATHS`] adapters).
    pub fn adapter_path(&self, path: &Path) -> PathBuf {
        if let Some(path) = self.kotlin_mirror.lock().as_ref().and_then(|m| m.adapter_path(path)) {
            return path;
        }
        if self.adapter == "java-debug" || (cfg!(windows) && self.adapter == "netcoredbg") {
            let native = windows_source_path(&path.to_string_lossy());
            self.resolved_paths.lock().insert(native.clone(), path.to_path_buf());
            return native;
        }
        if !RESOLVES_PATHS.contains(&self.adapter.as_str()) {
            return path.to_path_buf();
        }
        match std::fs::canonicalize(path) {
            Ok(real) if real != path => {
                self.resolved_paths.lock().insert(real.clone(), path.to_path_buf());
                real
            }
            _ => path.to_path_buf(),
        }
    }

    /// A path from the adapter as the IDE knows it (undoes [`Session::adapter_path`]).
    pub fn client_path(&self, path: &str) -> Option<PathBuf> {
        if let Some(real) = self.kotlin_mirror.lock().as_ref().and_then(|m| m.client_path(Path::new(path))) {
            return Some(real);
        }
        let key = if self.adapter == "java-debug" || (cfg!(windows) && self.adapter == "netcoredbg") {
            windows_source_path(path)
        } else {
            PathBuf::from(path)
        };
        self.resolved_paths.lock().get(&key).cloned().or_else(|| {
            (self.adapter == "java-debug" && is_windows_source_path(path))
                .then(|| PathBuf::from(path.replace('\\', "/")))
        })
    }

    pub fn supports(&self, cap: &str) -> bool {
        self.caps.lock().get(cap).and_then(Value::as_bool).unwrap_or(false)
    }

    /// Sends the breakpoints of one file (disabled ones omitted, plus an optional
    /// temporary line) and returns verification states aligned with `breakpoints`.
    pub async fn send_breakpoints(
        &self,
        path: &Path,
        breakpoints: &[Breakpoint],
        temp_line: Option<u32>,
    ) -> Result<Vec<BreakpointState>, DapError> {
        let enabled: Vec<usize> = (0..breakpoints.len()).filter(|&i| breakpoints[i].enabled).collect();
        let mut source_bps: Vec<Value> = enabled
            .iter()
            .map(|&i| {
                let b = &breakpoints[i];
                let mut v = json!({ "line": b.line + 1 });
                if let Some(c) = b.condition.as_deref().filter(|c| !c.trim().is_empty()) {
                    v["condition"] = c.into();
                }
                if let Some(c) = b.hit_condition.as_deref().filter(|c| !c.trim().is_empty()) {
                    v["hitCondition"] = c.into();
                }
                if let Some(m) = b.log_message.as_deref().filter(|m| !m.is_empty()) {
                    v["logMessage"] = m.into();
                }
                v
            })
            .collect();
        if let Some(line) = temp_line
            && !enabled.iter().any(|&i| breakpoints[i].line == line)
        {
            source_bps.push(json!({ "line": line + 1 }));
        }
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        let body = self
            .conn
            .request_timeout(
                "setBreakpoints",
                json!({
                    "source": { "path": self.adapter_path(path), "name": name },
                    "breakpoints": source_bps,
                    "sourceModified": false,
                }),
                Duration::from_secs(10),
            )
            .await?;
        let returned = body.get("breakpoints").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut ids = self.breakpoint_ids.lock();
        ids.retain(|_, (p, _)| p != path);
        let mut states: Vec<BreakpointState> = breakpoints
            .iter()
            .map(|b| BreakpointState {
                line: b.line,
                verified: false,
                message: (!b.enabled).then(|| "Disabled".to_owned()),
            })
            .collect();
        for (k, &i) in enabled.iter().enumerate() {
            let Some(r) = returned.get(k) else { continue };
            if let Some(id) = r.get("id").and_then(Value::as_i64) {
                ids.insert(id, (path.to_path_buf(), i));
            }
            states[i] = state_from(r, breakpoints[i].line);
        }
        Ok(states)
    }

    /// Sends method breakpoints (disabled ones omitted); states aligned with `list`.
    pub async fn send_function_breakpoints(
        &self,
        list: &[FunctionBreakpoint],
    ) -> Result<Vec<BreakpointState>, DapError> {
        let enabled: Vec<usize> = (0..list.len()).filter(|&i| list[i].enabled).collect();
        let sent: Vec<Value> = enabled
            .iter()
            .map(|&i| {
                let b = &list[i];
                let mut v = json!({ "name": b.name });
                with_conditions(&mut v, b.condition.as_deref(), b.hit_condition.as_deref());
                v
            })
            .collect();
        let body = self
            .conn
            .request_timeout("setFunctionBreakpoints", json!({ "breakpoints": sent }), Duration::from_secs(10))
            .await?;
        Ok(align_states(list.iter().map(|b| b.enabled), &enabled, &body))
    }

    /// Sends field watchpoints (disabled ones omitted); states aligned with `list`.
    pub async fn send_data_breakpoints(&self, list: &[DataBreakpoint]) -> Result<Vec<BreakpointState>, DapError> {
        let enabled: Vec<usize> = (0..list.len()).filter(|&i| list[i].enabled).collect();
        let sent: Vec<Value> = enabled
            .iter()
            .map(|&i| {
                let b = &list[i];
                let mut v = json!({ "dataId": b.data_id });
                if let Some(a) = b.access_type.as_deref().filter(|a| !a.is_empty()) {
                    v["accessType"] = a.into();
                }
                with_conditions(&mut v, b.condition.as_deref(), b.hit_condition.as_deref());
                v
            })
            .collect();
        let body = self
            .conn
            .request_timeout("setDataBreakpoints", json!({ "breakpoints": sent }), Duration::from_secs(10))
            .await?;
        Ok(align_states(list.iter().map(|b| b.enabled), &enabled, &body))
    }

    /// Kills the adapter and every debuggee we started.
    pub fn kill_processes(&self) {
        self.ended.cancel();
        // The inspector holds a clone of the link, so both go.
        self.jvm_inspector.lock().take();
        self.jdwp_link.lock().take();
        #[cfg(unix)]
        if self.request == "launch" {
            for group in launch_groups(self) {
                ide_core::process::kill_tree_of(group as u32);
            }
        }
        // The job first: it ends the adapter and everything it started (the program
        // java-debug launched is its child), members included that the stop's captured
        // tree never saw. An empty job is unaffected, and whatever survives this session
        // dies when the handle closes (`KILL_ON_JOB_CLOSE`).
        #[cfg(windows)]
        if let Some(job) = self.job.lock().as_ref() {
            job.terminate();
        }
        #[cfg(windows)]
        if let Some(tree) = self.stop_tree.lock().as_ref() {
            tree.terminate();
        }
        if let Some(mut c) = self.adapter_process.lock().take() {
            if self.adapter == "rdbg"
                && let Some(pid) = c.id()
            {
                ide_core::process::kill_tree_of(pid);
            }
            let _ = c.start_kill();
        }
        for mut c in std::mem::take(&mut *self.debuggees.lock()) {
            let _ = c.start_kill();
        }
        if let Some(mut program) = self.program.lock().take() {
            let _ = program.child.kill();
            let _ = std::thread::Builder::new().name("openidea-debug-reap".into()).spawn(move || {
                let _ = program.child.wait();
            });
        }
    }
}

/// How long Stop waits for a launched program to exit before reporting the session ended.
pub(crate) const DEBUGGEE_EXIT_WAIT: Duration = Duration::from_secs(10);

pub(crate) async fn remember_debuggee(s: &Arc<Session>) {
    #[cfg(windows)]
    {
        let Ok(pid) = u32::try_from(s.debuggee_pid.load(Ordering::Acquire)) else { return };
        if s.request != "launch" || pid == 0 || s.stop_tree.lock().is_some() {
            return;
        }
        if let Ok(tree) = tokio::task::spawn_blocking(move || ide_core::process::ProcessTree::capture(pid)).await {
            s.stop_tree.lock().get_or_insert(tree);
        }
    }
    #[cfg(not(windows))]
    let _ = s;
}

/// Asks the program itself to exit (`force` = SIGKILL) without ending the adapter session:
/// its output keeps flowing over DAP while it shuts down. The first call remembers the pid
/// tree, because the reported pid may die before its program does.
pub(crate) async fn signal_debuggee(s: &Arc<Session>, force: bool) {
    if s.request != "launch" {
        return;
    }
    #[cfg(not(windows))]
    let pid = s.debuggee_pid.load(Ordering::Acquire);
    #[cfg(unix)]
    {
        let needs_tree = pid > 0 && s.stop_pids.lock().is_empty();
        if needs_tree {
            let tree = tokio::task::spawn_blocking(move || process_tree(pid as i32)).await.unwrap_or_default();
            *s.stop_pids.lock() = tree;
        }
        let known = s.stop_pids.lock();
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        if force {
            // A forced stop kills the launch: every root the session spawned leads its own
            // process group (`own_group` at spawn), so one signal reaches the program and
            // everything it started, even processes born after the snapshot below was
            // taken — the adapter's program is in the adapter's group. The session's own
            // JVM roots (Kotlin) and `runInTerminal` programs lead groups of their own.
            // The roots are unreaped until the session drops them, so their ids (and the
            // groups named by them) cannot have been reused yet.
            for group in launch_groups(s) {
                // SAFETY: plain syscalls on the processes this session started.
                if unsafe { libc::kill(-group, libc::SIGKILL) } != 0 {
                    unsafe { libc::kill(group, libc::SIGKILL) };
                }
            }
        }
        // Children first: the shell that started the program would otherwise reparent it.
        for p in known.iter().rev() {
            // SAFETY: plain syscall on the processes this session started.
            unsafe {
                libc::kill(*p, signal);
            }
        }
    }
    #[cfg(windows)]
    {
        // Console programs have no external graceful signal; the adapter gets its chance
        // first. The job ends the program and everything it started, members included
        // that the captured tree never saw.
        if force {
            if let Some(job) = s.job.lock().as_ref() {
                job.terminate();
            }
            // A separately spawned program may have rejected assignment to the adapter's job.
            if let Some(tree) = s.stop_tree.lock().as_ref() {
                tree.terminate();
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    let _ = (pid, force);
}

/// The process groups the session spawned roots for: the adapter's (the program it
/// launched is in it), the JVMs the session started itself, the `runInTerminal` program.
#[cfg(unix)]
fn launch_groups(s: &Session) -> Vec<libc::pid_t> {
    let mut groups = Vec::new();
    let mut push = |id: Option<u32>| {
        if let Ok(pid) = libc::pid_t::try_from(id.unwrap_or(0)) {
            groups.push(pid);
        }
    };
    push(s.adapter_process.lock().as_ref().and_then(tokio::process::Child::id));
    for child in s.debuggees.lock().iter() {
        push(child.id());
    }
    push(s.program.lock().as_ref().and_then(|p| p.child.process_id()));
    groups.retain(|g| *g > 0);
    groups
}

/// Whether the launch is still running: the stop's captured tree when there is one,
/// otherwise the session's job (the adapter and everything it started).
#[cfg(windows)]
fn launch_running(s: &Arc<Session>) -> bool {
    if let Some(tree) = s.stop_tree.lock().as_ref() {
        tree.is_running()
    } else {
        s.job.lock().as_ref().is_some_and(|job| job.is_running())
    }
}

/// Waits until the program a `launch` session started is gone; a second Stop kills it.
pub(crate) async fn wait_for_debuggee(s: &Arc<Session>, terminate: bool) {
    if !terminate || s.request != "launch" {
        return;
    }
    let pid = s.debuggee_pid.load(Ordering::Acquire);
    if pid <= 0 {
        return;
    }
    tracing::info!(session = s.id.0, pid, "stop: waiting for the debugged program to exit");
    #[cfg(unix)]
    {
        use std::time::Instant;
        let mut targets = s.stop_pids.lock().clone();
        if targets.is_empty() {
            targets = tokio::task::spawn_blocking(move || process_tree(pid as i32)).await.unwrap_or_default();
        }
        let alive = || targets.iter().any(|p| unsafe { libc::kill(*p, 0) } == 0);
        let deadline = Instant::now() + DEBUGGEE_EXIT_WAIT;
        while alive() {
            if s.stop_force.swap(false, Ordering::AcqRel) {
                signal_debuggee(s, true).await;
            }
            if Instant::now() >= deadline {
                // The program ignored the terminate: do not leave it running.
                signal_debuggee(s, true).await;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    #[cfg(windows)]
    {
        remember_debuggee(s).await;
        let deadline = std::time::Instant::now() + DEBUGGEE_EXIT_WAIT;
        // The captured tree is the oracle when it was captured; otherwise the job (every
        // process the launch started) is, so a failed capture can no longer end the wait
        // while the program still holds its port.
        while launch_running(s) {
            if s.stop_force.swap(false, Ordering::AcqRel) || std::time::Instant::now() >= deadline {
                signal_debuggee(s, true).await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
    }
}

// java-debug and Windows netcoredbg need native separators for source lookup.
// Keep DAP path mode, but normalize Windows drive and UNC paths.
fn is_windows_source_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
        || path.starts_with("//")
        || path.starts_with(r"\\")
}

fn windows_source_path(path: &str) -> PathBuf {
    if is_windows_source_path(path) { PathBuf::from(path.replace('/', r"\")) } else { PathBuf::from(path) }
}

fn with_conditions(v: &mut Value, condition: Option<&str>, hit_condition: Option<&str>) {
    if let Some(c) = condition.filter(|c| !c.trim().is_empty()) {
        v["condition"] = c.into();
    }
    if let Some(c) = hit_condition.filter(|c| !c.trim().is_empty()) {
        v["hitCondition"] = c.into();
    }
}

/// States for a list whose enabled entries (`sent`, by index) went out in order.
fn align_states(all: impl Iterator<Item = bool>, sent: &[usize], body: &Value) -> Vec<BreakpointState> {
    let returned = body.get("breakpoints").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut states: Vec<BreakpointState> = all
        .map(|e| BreakpointState { line: 0, verified: false, message: (!e).then(|| "Disabled".to_owned()) })
        .collect();
    for (k, &i) in sent.iter().enumerate() {
        if let Some(r) = returned.get(k) {
            states[i] = state_from(r, 0);
        }
    }
    states
}

pub(crate) fn state_from(r: &Value, fallback_line: u32) -> BreakpointState {
    BreakpointState {
        line: r.get("line").and_then(Value::as_u64).map(|l| (l as u32).saturating_sub(1)).unwrap_or(fallback_line),
        verified: r.get("verified").and_then(Value::as_bool).unwrap_or(false),
        message: r.get("message").and_then(Value::as_str).map(str::to_owned),
    }
}

/// Processes adapter traffic until the connection closes.
pub(crate) async fn event_loop(
    manager: Weak<DebugManager>,
    session: Arc<Session>,
    mut incoming: mpsc::UnboundedReceiver<Incoming>,
) {
    while let Some(msg) = incoming.recv().await {
        let Some(mgr) = manager.upgrade() else { break };
        match msg {
            Incoming::Event { event, body } => on_event(&mgr, &session, &event, body).await,
            Incoming::Request { seq, command, arguments } => {
                on_reverse_request(&mgr, &session, seq, &command, arguments)
            }
            Incoming::Closed => break,
        }
    }
    // rdbg closes DAP before Ruby's remaining at_exit handlers print the test summary.
    if session.adapter == "rdbg" && session.request == "launch" {
        let mut drained = session.output_drained.subscribe();
        let _ = tokio::time::timeout(DEBUGGEE_EXIT_WAIT, drained.wait_for(|done| *done)).await;
    }
    if let Some(mgr) = manager.upgrade() {
        mgr.session_closed(&session);
    }
}

async fn on_event(mgr: &Arc<DebugManager>, s: &Arc<Session>, event: &str, mut body: Value) {
    if let Some(mirror) = s.kotlin_mirror.lock().as_ref() {
        mirror.translate(&mut body);
    }
    let int = |k: &str| body.get(k).and_then(Value::as_i64);
    let str_ = |k: &str| body.get(k).and_then(Value::as_str).map(str::to_owned);
    match event {
        "initialized" => {
            s.initialized.send_replace(true);
            s.emit(DebugEvent::Initialized);
        }
        "stopped" => {
            let all = body.get("allThreadsStopped").and_then(Value::as_bool).unwrap_or(false);
            s.suspended.stopped(int("threadId"), all);
            let reason = str_("reason").unwrap_or_else(|| "pause".into());
            mgr.restore_breakpoints(s).await;
            s.emit(DebugEvent::Stopped {
                thread_id: int("threadId").unwrap_or(0),
                reason,
                description: str_("description").or_else(|| str_("text")),
                all_threads_stopped: all,
            });
        }
        "continued" => {
            let all = body.get("allThreadsContinued").and_then(Value::as_bool);
            // DAP: an event without the flag continues its thread alone. The UI keeps treating
            // it as all threads; the suspension, which holds only threads that stopped, need not.
            s.suspended.continued(int("threadId"), all.unwrap_or(false));
            s.emit(DebugEvent::Continued {
                thread_id: int("threadId").unwrap_or(0),
                all_threads_continued: all.unwrap_or(true),
            });
        }
        "output" => {
            let category = str_("category").unwrap_or_else(|| "console".into());
            if category == "telemetry" {
                return;
            }
            let output = str_("output").unwrap_or_default();
            if tracing::enabled!(tracing::Level::DEBUG) && mgr.stopping.lock().contains_key(&s.id) {
                tracing::debug!(session = ?s.id, bytes = output.len(), "output during stop");
            }
            s.emit(DebugEvent::Output { category, output });
        }
        // The program the adapter started: Stop must wait for it, not for the adapter's reply.
        // `process` is the DAP event; java-debug announces the same thing as `processid`.
        "process" | "processid" => {
            if let Some(pid) = int("systemProcessId").or_else(|| int("processId")).filter(|p| *p > 0) {
                s.debuggee_pid.store(pid, Ordering::Release);
            }
        }
        "thread" => s.emit(DebugEvent::Thread {
            thread_id: int("threadId").unwrap_or(0),
            started: body.get("reason").and_then(Value::as_str) != Some("exited"),
        }),
        "breakpoint" => {
            let Some(bp) = body.get("breakpoint") else { return };
            let Some(id) = bp.get("id").and_then(Value::as_i64) else { return };
            let Some((path, index)) = s.breakpoint_ids.lock().get(&id).cloned() else { return };
            if mgr.update_breakpoint_state(&path, index, bp) {
                s.emit(DebugEvent::BreakpointsChanged { path: path.into() });
            }
        }
        // Godot repeats `exited` / `terminated` when the client disconnects afterwards.
        "exited" if !s.terminated.load(Ordering::Acquire) => {
            s.emit(DebugEvent::Exited { code: int("exitCode").unwrap_or(0) as i32 })
        }
        "exited" => {}
        "terminated" => {
            let first = !s.terminated.swap(true, Ordering::AcqRel);
            let mgr = mgr.clone();
            let s = s.clone();
            // Waiting here would stop reading the adapter: it keeps sending the program's last
            // output while the program exits. Wait off the reader task, then report the end.
            tokio::spawn(async move {
                if first {
                    wait_for_debuggee(&s, true).await;
                    s.emit(DebugEvent::Terminated);
                }
                mgr.shutdown(&s, false).await;
            });
        }
        "capabilities" => {
            if let Some(new) = body.get("capabilities").and_then(Value::as_object) {
                let mut caps = s.caps.lock();
                if !caps.is_object() {
                    *caps = json!({});
                }
                if let Some(obj) = caps.as_object_mut() {
                    obj.extend(new.clone());
                }
            }
        }
        "progressStart" | "progressUpdate" | "progressEnd" => {
            let Some(pid) = str_("progressId") else { return };
            let done = event == "progressEnd";
            let (id, title) = {
                let mut progress = s.progress.lock();
                let id =
                    if done { progress.remove(&pid) } else { Some(*progress.entry(pid).or_insert_with(TaskId::next)) };
                (id, str_("title").map(|t| ide_core::task::display_title(&t)).unwrap_or_else(|| s.name.clone()))
            };
            let Some(id) = id else { return };
            s.owner.sink.emit(IdeEvent::Task {
                id,
                title,
                message: str_("message"),
                fraction: body.get("percentage").and_then(Value::as_f64).map(|p| (p / 100.0) as f32),
                done,
                cancellable: false,
            });
        }
        "hotcodereplace" => s.emit(DebugEvent::HotCodeReplace {
            change_type: crate::hot_code_replace_type(body.get("changeType")),
            message: str_("message").unwrap_or_default(),
        }),
        _ => tracing::trace!("dap: ignored event {event}"),
    }
}

fn on_reverse_request(mgr: &Arc<DebugManager>, s: &Arc<Session>, seq: i64, command: &str, args: Value) {
    match command {
        "runInTerminal" => {
            let result = run_in_terminal(s, &args);
            let _ = s.conn.respond(seq, command, result);
        }
        "startDebugging" => {
            let mgr = mgr.clone();
            let s = s.clone();
            tokio::spawn(async move {
                let request = args.get("request").and_then(Value::as_str).unwrap_or("launch").to_owned();
                let configuration = args.get("configuration").cloned().unwrap_or_else(|| json!({}));
                let result = mgr.start_child(&s, request, configuration).await;
                let _ = s.conn.respond(seq, "startDebugging", result.map(|_| Value::Null).map_err(|e| e.message));
            });
        }
        _ => {
            let _ = s.conn.respond(seq, command, Err(format!("unsupported reverse request {command}")));
        }
    }
}

/// A `runInTerminal` program and the pseudo-terminal it runs in.
pub(crate) struct ProgramTerminal {
    writer: ide_core::input::InputWriter,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    _master: Box<dyn portable_pty::MasterPty + Send>,
}

impl ProgramTerminal {
    pub(crate) fn write(&mut self, text: &str) -> std::io::Result<()> {
        self.writer.write(text.as_bytes())
    }
}

/// `runInTerminal`: starts the debuggee on a pseudo-terminal, as an IDE terminal would (CodeLLDB
/// starts a launcher that gives the program its terminal, and the program reads input only from
/// a terminal), forwards its output to the console, and keeps the terminal for typed input.
pub(crate) fn run_in_terminal(s: &Arc<Session>, args: &Value) -> Result<Value, String> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    let argv: Vec<String> = args
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let Some((program, rest)) = argv.split_first() else {
        return Err("runInTerminal without args".into());
    };
    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 200, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("cannot open a terminal for {program}: {e}"))?;
    #[cfg(unix)]
    let wait_writable = ide_core::input::nonblocking(
        pair.master.as_raw_fd().ok_or_else(|| format!("terminal of {program}: PTY has no file descriptor"))?,
    )
    .map_err(|e| format!("terminal of {program}: {e}"))?;
    #[cfg(unix)]
    let wait_readable = ide_core::input::readable(
        pair.master.as_raw_fd().ok_or_else(|| format!("terminal of {program}: PTY has no file descriptor"))?,
    )
    .map_err(|e| format!("terminal of {program}: {e}"))?;
    let mut cmd = CommandBuilder::new(program);
    // CodeLLDB's launcher clears the terminal first; the console keeps the session's earlier output.
    cmd.args(rest.iter().filter(|a| *a != "--clear-screen"));
    for (k, v) in ide_core::process::host_env_fixes() {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        }
    }
    for (k, v) in ide_core::process::shell_env() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    match args.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        Some(cwd) => cmd.cwd(cwd),
        None => cmd.cwd(&s.spec.cwd),
    }
    if let Some(env) = args.get("env").and_then(Value::as_object) {
        for (k, v) in env {
            match v.as_str() {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            };
        }
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("failed to start {program}: {e}"))?;
    // The program joins the session's job, so Stop reaches what it starts (its children),
    // though only the program itself is the session's child.
    #[cfg(windows)]
    if let Some(pid) = child.process_id()
        && let Some(job) = s.job.lock().as_ref()
    {
        job.assign_pid(pid);
    }
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| format!("terminal of {program}: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("terminal of {program}: {e}"))?;
    let writer = ide_core::input::InputWriter::new(
        format!("openidea-debug-input-{}", s.id.0),
        writer,
        #[cfg(unix)]
        wait_writable,
        |e| {
            tracing::warn!("debug input: {e}");
        },
    )
    .inspect_err(|_| {
        let _ = child.kill();
        let _ = child.wait();
    })
    .map_err(|e| format!("terminal input worker: {e}"))?;
    let pid = child.process_id();
    forward_terminal_output(
        s,
        reader,
        #[cfg(unix)]
        wait_readable,
    );
    if let Some(mut previous) = s.program.lock().replace(ProgramTerminal { writer, child, _master: pair.master }) {
        let _ = previous.child.kill();
    }
    s.owner.sink.emit(IdeEvent::Debug { session: s.id, event: DebugEvent::ProgramInput });
    Ok(json!({ "processId": pid }))
}

/// The program's terminal output, as stdout lines (`\r\n` as `\n`; colours are kept).
fn forward_terminal_output(
    s: &Session,
    mut reader: Box<dyn std::io::Read + Send>,
    #[cfg(unix)] mut wait_readable: impl FnMut() -> std::io::Result<()> + Send + 'static,
) {
    let session = s.id;
    let sink = s.owner.sink.clone();
    let _ = std::thread::Builder::new().name(format!("openidea-debuggee-{}", session.0)).spawn(move || {
        let mut buf = vec![0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => pending.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    #[cfg(unix)]
                    if let Err(e) = wait_readable()
                        && e.kind() != std::io::ErrorKind::Interrupted
                    {
                        tracing::warn!(%session, "debug terminal read: {e}");
                        break;
                    }
                    #[cfg(not(unix))]
                    std::thread::sleep(std::time::Duration::from_millis(4));
                    continue;
                }
                #[cfg(unix)]
                Err(e) if e.raw_os_error() == Some(libc::EIO) => break,
                Err(e) => {
                    tracing::warn!(%session, "debug terminal read: {e}");
                    break;
                }
            }
            // Keep incomplete UTF-8 sequences, and a `\r` that may start a `\r\n`, for the next chunk.
            let mut valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            if valid > 0 && pending[valid - 1] == b'\r' {
                valid -= 1;
            }
            let output = String::from_utf8_lossy(&pending[..valid]).replace("\r\n", "\n");
            pending.drain(..valid);
            if !output.is_empty() {
                sink.emit(IdeEvent::Debug { session, event: DebugEvent::Output { category: "stdout".into(), output } });
            }
        }
        if !pending.is_empty() {
            let output = String::from_utf8_lossy(&pending).replace("\r\n", "\n");
            sink.emit(IdeEvent::Debug { session, event: DebugEvent::Output { category: "stdout".into(), output } });
        }
    });
}

fn forward_output<R: AsyncRead + Unpin + Send + 'static>(s: &Session, mut stream: R, category: &'static str) {
    let session = s.id;
    let sink = s.owner.sink.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Keep incomplete UTF-8 sequences for the next chunk.
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    if !text.is_empty() {
                        sink.emit(IdeEvent::Debug {
                            session,
                            event: DebugEvent::Output { category: category.into(), output: text },
                        });
                    }
                }
            }
        }
        if !pending.is_empty() {
            let output = String::from_utf8_lossy(&pending).into_owned();
            sink.emit(IdeEvent::Debug { session, event: DebugEvent::Output { category: category.into(), output } });
        }
    });
}

/// The attach listener must be on the command line before the user's arguments, which may
/// override it; the memory view needs it because the JVM is started by the IDE, not attached to.
/// Not on Windows (`windows`), which the memory view does not support.
fn kotlin_jvm_args(user: Vec<String>, windows: bool) -> Vec<String> {
    if windows || !ide_jvm_attach::wants_listener_flag(&user.join(" ")) {
        return user;
    }
    let mut args = Vec::with_capacity(user.len() + 1);
    args.push(ide_jvm_attach::START_LISTENER_FLAG.to_owned());
    args.extend(user);
    args
}

/// Launch with the IDE's resolved runtime and classpath; the adapter only attaches.
pub(crate) async fn start_kotlin_debuggee(s: &Arc<Session>, args: &mut Value) -> ide_core::IdeResult<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let java = args.get("javaExec").and_then(Value::as_str).unwrap_or("java");
    let strings = |key: &str| -> Vec<String> {
        args.get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default()
    };
    let classpath =
        std::env::join_paths(strings("classPaths")).map_err(|e| ide_core::IdeError::invalid(e.to_string()))?;
    let mut cmd = tokio::process::Command::new(java);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.args(kotlin_jvm_args(strings("vmArguments"), cfg!(windows)))
        // Let the JVM pick its own port (`:0`) and report it below: pre-picking a free
        // port here races with other processes that may take it before the JVM binds.
        .arg("-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0")
        .arg("-cp")
        .arg(classpath);
    let modules = strings("modulePaths");
    if !modules.is_empty() {
        cmd.arg("--module-path")
            .arg(std::env::join_paths(modules).map_err(|e| ide_core::IdeError::invalid(e.to_string()))?);
    }
    cmd.arg(
        args.get("mainClass")
            .and_then(Value::as_str)
            .ok_or_else(|| ide_core::IdeError::invalid("Missing Kotlin main class"))?,
    )
    .args(strings("programArgs"))
    .current_dir(&s.spec.cwd)
    .envs(ide_core::process::shell_env())
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    if let Some(env) = args.get("env").and_then(Value::as_object) {
        for (k, v) in env {
            if let Some(v) = v.as_str() {
                cmd.env(k, v);
            }
        }
    }
    // A root the session spawns itself: its own process group on Unix (`kill(-pgid)` in a
    // forced stop), the session's job on Windows, so a stop reaches what it forks.
    ide_core::process::own_group(cmd.as_std_mut());
    let mut child = cmd.spawn()?;
    if let Some(pid) = child.id() {
        s.jvm_pid.store(i64::from(pid), Ordering::Release);
        #[cfg(windows)]
        if let Some(job) = s.job.lock().as_ref() {
            job.assign_pid(pid);
        }
    }
    if let Some(err) = child.stderr.take() {
        forward_output(s, err, "stderr");
    }
    let mut stdout =
        BufReader::new(child.stdout.take().ok_or_else(|| ide_core::IdeError::internal("Missing JVM stdout"))?);
    // The JVM chose the port (`:0` above) and reports it here; reading it back removes
    // the free-port race window entirely.
    let port = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let mut line = String::new();
            if stdout.read_line(&mut line).await? == 0 {
                return Err(ide_core::IdeError::unavailable("JVM exited before starting its debug listener"));
            }
            if line.contains("Listening for transport dt_socket") {
                return parse_jdwp_port(&line).ok_or_else(|| {
                    ide_core::IdeError::unavailable(format!("JVM reported an unreadable debug port: {}", line.trim()))
                });
            }
            s.emit(DebugEvent::Output { category: "stdout".into(), output: line });
        }
    })
    .await
    .map_err(|_| ide_core::IdeError::unavailable("JVM did not start its debug listener"))??;
    forward_output(s, stdout, "stdout");
    s.debuggees.lock().push(child);
    args["hostName"] = json!("127.0.0.1");
    args["port"] = json!(port);
    args["timeout"] = json!(10000);
    Ok(())
}

/// The port a JVM chose, from `Listening for transport dt_socket at address: <port>`
/// (some JVMs print `host:port` or `[::1]:port`, so take what follows the last colon).
fn parse_jdwp_port(line: &str) -> Option<u16> {
    line.rsplit_once("address:")?.1.trim().rsplit(':').next()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::{Suspension, kotlin_jvm_args, parse_jdwp_port};

    #[test]
    fn a_resume_reply_clears_the_stop_it_was_sent_for() {
        let s = Suspension::default();
        assert!(!s.get());
        s.stopped(Some(1), true);
        let ticket = s.ticket();
        s.resumed(ticket, 1, true);
        assert!(!s.get());
    }

    #[test]
    fn a_stop_after_the_resume_request_keeps_the_session_suspended() {
        let s = Suspension::default();
        s.stopped(Some(1), true);
        let ticket = s.ticket();
        // The next breakpoint's `stopped` event overtakes the reply to `continue`.
        s.continued(Some(1), true);
        s.stopped(Some(1), true);
        s.resumed(ticket, 1, true);
        assert!(s.get());
        // A reply for the new stop still clears it.
        s.resumed(s.ticket(), 1, true);
        assert!(!s.get());
    }

    #[test]
    fn a_reply_after_a_continued_event_changes_nothing() {
        let s = Suspension::default();
        s.stopped(Some(1), true);
        let ticket = s.ticket();
        s.continued(Some(1), true);
        s.resumed(ticket, 1, true);
        assert!(!s.get());
        s.stopped(Some(1), true);
        assert!(s.get());
    }

    #[test]
    fn concurrent_stops_are_never_lost() {
        let s = std::sync::Arc::new(Suspension::default());
        s.stopped(Some(1), true);
        let ticket = s.ticket();
        let stopping = {
            let s = s.clone();
            std::thread::spawn(move || (0..10_000).for_each(|_| s.stopped(Some(1), true)))
        };
        for _ in 0..10_000 {
            s.resumed(ticket, 1, true);
        }
        stopping.join().unwrap();
        // However they interleave, a resume for the old ticket never clears a later stop.
        assert!(s.get());
        assert_eq!(s.ticket(), ticket + 10_000);
    }

    /// fwcd and java-debug stop a breakpoint's thread alone (`SUSPEND_EVENT_THREAD`): 7, then 8.
    fn two_threads_stopped() -> Suspension {
        let s = Suspension::default();
        s.stopped(Some(7), false);
        s.stopped(Some(8), false);
        s
    }

    #[test]
    fn continuing_the_latest_stopped_thread_keeps_the_other_as_a_new_stop() {
        let s = two_threads_stopped();
        let ticket = s.ticket();
        s.continued(Some(8), false);
        assert!(s.get());
        // Objects read on thread 8's stop are stale.
        assert_eq!(s.ticket(), ticket + 1);
        s.continued(Some(7), false);
        assert!(!s.get());
    }

    #[test]
    fn continuing_an_earlier_stopped_thread_keeps_the_latest_stop() {
        let s = two_threads_stopped();
        let ticket = s.ticket();
        s.continued(Some(7), false);
        assert!(s.get());
        assert_eq!(s.ticket(), ticket);
    }

    #[test]
    fn continuing_all_threads_ends_every_stop() {
        let s = two_threads_stopped();
        s.continued(Some(7), true);
        assert!(!s.get());
        let s = two_threads_stopped();
        s.continued(None, false);
        assert!(!s.get());
    }

    #[test]
    fn continuing_a_thread_that_did_not_stop_changes_nothing() {
        let s = two_threads_stopped();
        let ticket = s.ticket();
        s.continued(Some(5), false);
        assert!(s.get());
        assert_eq!(s.ticket(), ticket);
    }

    #[test]
    fn a_step_reply_resumes_its_thread_alone() {
        let s = two_threads_stopped();
        let ticket = s.ticket();
        s.resumed(ticket, 8, false);
        assert!(s.get());
        assert_eq!(s.ticket(), ticket + 1);
        s.resumed(s.ticket(), 7, true);
        assert!(!s.get());
    }

    #[test]
    fn a_thread_stopping_again_before_its_resume_reply_stays_stopped() {
        let s = two_threads_stopped();
        let ticket = s.ticket();
        // Thread 7's step ends, and its `stopped` event overtakes the reply to `next`.
        s.stopped(Some(7), false);
        s.resumed(ticket, 7, false);
        s.continued(Some(8), false);
        assert!(s.get());
    }

    #[test]
    fn a_stop_of_every_thread_ends_with_any_resume() {
        let s = Suspension::default();
        s.stopped(Some(7), false);
        s.stopped(Some(8), true);
        s.continued(Some(8), false);
        assert!(!s.get());
        // A stop without a thread.
        s.stopped(None, false);
        s.resumed(s.ticket(), 5, false);
        assert!(!s.get());
    }

    #[test]
    fn kotlin_launch_starts_attach_listener_first() {
        assert_eq!(
            kotlin_jvm_args(vec!["-Xmx1g".into()], false),
            vec!["-XX:+StartAttachListener".to_string(), "-Xmx1g".into()]
        );
        assert_eq!(
            kotlin_jvm_args(vec!["-XX:+DisableAttachMechanism".into()], false),
            vec!["-XX:+DisableAttachMechanism".to_string()]
        );
    }

    #[test]
    fn kotlin_launch_on_windows_gets_no_attach_listener() {
        assert_eq!(kotlin_jvm_args(vec!["-Xmx1g".into()], true), vec!["-Xmx1g".to_string()]);
    }

    #[test]
    fn reads_the_port_the_jvm_chose() {
        assert_eq!(parse_jdwp_port("Listening for transport dt_socket at address: 51234"), Some(51234));
        assert_eq!(parse_jdwp_port("Listening for transport dt_socket at address: 127.0.0.1:51234"), Some(51234));
        assert_eq!(parse_jdwp_port("Listening for transport dt_socket at address: [::1]:51234"), Some(51234));
        assert_eq!(parse_jdwp_port("unrelated output"), None);
    }
}
