//! One debug session: the adapter connection, its capabilities, the event
//! loop translating DAP events into `IdeEvent::Debug`, and reverse requests.

use crate::adapter::AdapterSpec;
use crate::connection::{Connection, DapError, Incoming};
use crate::{Breakpoint, BreakpointState, DataBreakpoint, DebugManager, FunctionBreakpoint, SessionOwner};
use ide_core::event::DebugEvent;
use ide_core::{DebugSessionId, IdeEvent, TaskId};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Weak;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Set once `configurationDone` was sent; breakpoint updates go out live after that.
    pub configured: AtomicBool,
    pub initialized: watch::Sender<bool>,
    pub terminated: AtomicBool,
    /// Breakpoints replaced for run to cursor / force stepping, restored on the next stop.
    pub pending_restore: Mutex<PendingRestore>,
    /// Adapter breakpoint id → (file, index in the stored list).
    pub breakpoint_ids: Mutex<HashMap<i64, (PathBuf, usize)>>,
    /// Resolved path → the path as the IDE knows it, for adapters given resolved paths.
    resolved_paths: Mutex<HashMap<PathBuf, PathBuf>>,
    progress: Mutex<HashMap<String, TaskId>>,
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
            configured: AtomicBool::new(false),
            initialized: watch::channel(false).0,
            terminated: AtomicBool::new(false),
            pending_restore: Mutex::default(),
            breakpoint_ids: Mutex::new(HashMap::new()),
            resolved_paths: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
        }
    }

    pub fn emit(&self, event: DebugEvent) {
        self.owner.sink.emit(IdeEvent::Debug { session: self.id, event });
    }

    /// `path` as sent to the adapter (resolved for [`RESOLVES_PATHS`] adapters).
    pub fn adapter_path(&self, path: &Path) -> PathBuf {
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
        self.resolved_paths.lock().get(Path::new(path)).cloned()
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
        if let Some(mut c) = self.adapter_process.lock().take() {
            let _ = c.start_kill();
        }
        for mut c in std::mem::take(&mut *self.debuggees.lock()) {
            let _ = c.start_kill();
        }
    }
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
    if let Some(mgr) = manager.upgrade() {
        mgr.session_closed(&session);
    }
}

async fn on_event(mgr: &Arc<DebugManager>, s: &Arc<Session>, event: &str, body: Value) {
    let int = |k: &str| body.get(k).and_then(Value::as_i64);
    let str_ = |k: &str| body.get(k).and_then(Value::as_str).map(str::to_owned);
    match event {
        "initialized" => {
            s.initialized.send_replace(true);
            s.emit(DebugEvent::Initialized);
        }
        "stopped" => {
            mgr.restore_breakpoints(s).await;
            s.emit(DebugEvent::Stopped {
                thread_id: int("threadId").unwrap_or(0),
                reason: str_("reason").unwrap_or_else(|| "pause".into()),
                description: str_("description").or_else(|| str_("text")),
                all_threads_stopped: body.get("allThreadsStopped").and_then(Value::as_bool).unwrap_or(false),
            });
        }
        "continued" => s.emit(DebugEvent::Continued {
            thread_id: int("threadId").unwrap_or(0),
            all_threads_continued: body.get("allThreadsContinued").and_then(Value::as_bool).unwrap_or(true),
        }),
        "output" => {
            let category = str_("category").unwrap_or_else(|| "console".into());
            if category == "telemetry" {
                return;
            }
            let output = str_("output").unwrap_or_default();
            s.emit(DebugEvent::Output { category, output });
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
            if !s.terminated.swap(true, Ordering::AcqRel) {
                s.emit(DebugEvent::Terminated);
            }
            let mgr = mgr.clone();
            let s = s.clone();
            tokio::spawn(async move { mgr.shutdown(&s, false).await });
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
                (id, str_("title").unwrap_or_else(|| s.name.clone()))
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

/// `runInTerminal`: spawns the debuggee directly and forwards its output to the console.
pub(crate) fn run_in_terminal(s: &Arc<Session>, args: &Value) -> Result<Value, String> {
    let argv: Vec<String> = args
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let Some((program, rest)) = argv.split_first() else {
        return Err("runInTerminal without args".into());
    };
    let mut cmd = tokio::process::Command::new(program);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.args(rest)
        .envs(ide_core::process::shell_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = args.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        cmd.current_dir(cwd);
    }
    if let Some(env) = args.get("env").and_then(Value::as_object) {
        for (k, v) in env {
            match v.as_str() {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            };
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to start {program}: {e}"))?;
    let pid = child.id();
    if let Some(out) = child.stdout.take() {
        forward_output(s, out, "stdout");
    }
    if let Some(err) = child.stderr.take() {
        forward_output(s, err, "stderr");
    }
    s.debuggees.lock().push(child);
    Ok(json!({ "processId": pid }))
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
