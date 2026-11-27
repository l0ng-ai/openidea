//! Commands agents run in the Run tool window (`run_command` and the tools that follow it
//! up): one tab per name, `_agent_<name>`, that the user watches and can type into, rerun,
//! stop or close. As JetBrains' `execute_terminal_command` does, the process runs on pipes,
//! not a pseudo-terminal, so programs print plain lines (no progress bars or redraws), and
//! what the agent reads is cleaned ([`clean_output`]) and cut to a number of lines
//! ([`truncate_lines`]). The Run tool window starts every process of the tab,
//! as for any run, so the tab behaves like the others; [`AGENT_PARAM`] brings each start
//! back here, where the output is logged for the agent and what the user did is recorded.

use super::output::{TRUNCATED_MARKER, temp_output_file};
use crate::ops::Emit;
use ide_core::{IdeEvent, IdeResult, RunId, SharedSink};
use ide_run::{OutputChunk, RunConfig, RunInfo};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

/// Run configuration parameter naming the agent tab a start belongs to.
pub const AGENT_PARAM: &str = "mcp.agentRun";
/// Run configuration parameter with Settings › Tools › Terminal › Shell path (may be empty).
pub const SHELL_PARAM: &str = "mcp.agentShell";
/// What every agent tab's name starts with.
pub const NAME_PREFIX: &str = "_agent_";
const MAX_NAME_LENGTH: usize = 64;
/// How much of the log a wait for a pattern reads at a time.
const SCAN_CHUNK: usize = 4 << 20;

/// The tab name for what an agent asked for: trimmed, with [`NAME_PREFIX`] once.
pub fn tab_name(raw: &str) -> IdeResult<String> {
    let raw = raw.trim();
    let bare = raw.strip_prefix(NAME_PREFIX).unwrap_or(raw);
    if bare.is_empty() {
        return Err(ide_core::IdeError::invalid("name must not be empty"));
    }
    if bare.chars().count() > MAX_NAME_LENGTH {
        return Err(ide_core::IdeError::invalid(format!("name must be at most {MAX_NAME_LENGTH} characters")));
    }
    if bare.chars().any(char::is_control) {
        return Err(ide_core::IdeError::invalid("name must not contain control characters"));
    }
    Ok(format!("{NAME_PREFIX}{bare}"))
}

/// The agent tabs of every open project.
#[derive(Default)]
pub struct AgentRuns(Mutex<Vec<Arc<AgentRun>>>);

impl AgentRuns {
    pub fn get(&self, root: &Path, name: &str) -> Option<Arc<AgentRun>> {
        self.0.lock().iter().find(|r| r.root == root && r.name == name).cloned()
    }

    pub fn list(&self, root: &Path) -> Vec<Arc<AgentRun>> {
        self.0.lock().iter().filter(|r| r.root == root).cloned().collect()
    }

    /// The tab for the agent's next start of `name`: refused while its process runs, since
    /// only an explicit `stop_run` may end it.
    pub(crate) fn prepare(
        &self,
        root: &Path,
        window: &str,
        name: &str,
        command: &str,
        cwd: &str,
    ) -> Result<Arc<AgentRun>, Arc<AgentRun>> {
        let mut runs = self.0.lock();
        let run = match runs.iter().find(|r| r.root == root && r.name == name) {
            Some(run) => run.clone(),
            None => {
                let run = Arc::new(AgentRun::new(root, name, command, cwd));
                runs.push(run.clone());
                run
            }
        };
        drop(runs);
        let mut s = run.state.lock();
        if s.running() {
            drop(s);
            return Err(run);
        }
        *run.window.lock() = window.to_owned();
        s.command = command.to_owned();
        s.cwd = cwd.to_owned();
        s.agent_start = true;
        s.start_error = None;
        s.closed_at = None;
        s.interventions.clear();
        s.reported = 0;
        drop(s);
        Ok(run)
    }

    /// The agent's start did not reach the Run tool window: a tab that never ran is dropped.
    pub(crate) fn abandon(&self, run: &Arc<AgentRun>) {
        let never_ran = {
            let mut s = run.state.lock();
            s.agent_start = false;
            s.process.is_none()
        };
        if never_ran {
            self.0.lock().retain(|r| !Arc::ptr_eq(r, run));
            run.remove_log();
        }
    }

    /// Called for every run start: for a start of an agent tab, turns its command line into
    /// the shell's invocation and opens a new process record.
    pub(crate) fn launch(&self, root: &Path, window: &str, config: &mut RunConfig) -> Option<Launch> {
        let name = config.extras.params.get(AGENT_PARAM).cloned()?;
        let line = config.command.clone();
        let cwd = config.cwd.as_deref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let run = {
            let mut runs = self.0.lock();
            match runs.iter().find(|r| r.root == root && r.name == name) {
                Some(run) => run.clone(),
                None => {
                    let run = Arc::new(AgentRun::new(root, &name, &line, &cwd));
                    runs.push(run.clone());
                    run
                }
            }
        };
        *run.window.lock() = window.to_owned();
        let shell = config.extras.params.get(SHELL_PARAM).cloned();
        let (program, args) = shell_invocation(shell.as_deref(), &line);
        config.command = program;
        config.args = args;
        config.extras.target = Some(String::new());
        // Pipes: the Run tool window's console shows the output and sends the user's input lines.
        config.extras.emulate_terminal = false;
        let generation = run.begin(&line);
        Some(Launch { run, generation })
    }

    fn by_process(&self, id: RunId) -> Option<Arc<AgentRun>> {
        self.0.lock().iter().find(|r| r.state.lock().process.as_ref().is_some_and(|p| p.run == Some(id))).cloned()
    }

    /// A Stop of run `id`, from the agent's `stop_run` or the user.
    pub(crate) fn stopping(&self, id: RunId) {
        if let Some(run) = self.by_process(id) {
            run.stopping(id);
        }
    }

    /// Input the user typed into run `id`.
    pub(crate) fn user_input(&self, id: RunId, data: &str) {
        if let Some(run) = self.by_process(id) {
            run.user_input(data);
        }
    }

    /// The user closed the tab of `name`.
    pub fn closed(&self, root: &Path, name: &str) {
        if let Some(run) = self.get(root, name) {
            run.closed();
        }
    }

    /// The window's project closed: its tabs are gone with it.
    pub(crate) fn forget_window(&self, window: &str) {
        let gone: Vec<_> = {
            let mut runs = self.0.lock();
            let (gone, kept) = std::mem::take(&mut *runs).into_iter().partition(|r| *r.window.lock() == window);
            *runs = kept;
            gone
        };
        for run in gone {
            run.remove_log();
            run.changed.notify_waiters();
        }
    }
}

/// One start of an agent tab, from [`AgentRuns::launch`].
pub(crate) struct Launch {
    run: Arc<AgentRun>,
    generation: u64,
}

impl Launch {
    /// The run's output callback, also logging for the agent.
    pub(crate) fn wrap_output(&self, on_output: Emit<OutputChunk>) -> Emit<OutputChunk> {
        let run = self.run.clone();
        Arc::new(move |chunk: OutputChunk| {
            if let OutputChunk::Stdout { text } | OutputChunk::Stderr { text } = &chunk {
                run.output(text);
            }
            on_output(chunk);
        })
    }

    /// The run's event sink, also recording its exit.
    pub(crate) fn wrap_sink(&self, sink: SharedSink) -> SharedSink {
        let (run, generation) = (self.run.clone(), self.generation);
        Arc::new(move |event: IdeEvent| {
            if let IdeEvent::RunExited { code, .. } = &event {
                run.exited(generation, *code);
            }
            sink.emit(event);
        })
    }

    pub(crate) fn started(&self, result: &IdeResult<RunInfo>) {
        let mut s = self.run.state.lock();
        let Some(p) = s.process.as_mut().filter(|p| p.generation == self.generation) else { return };
        match result {
            Ok(info) => p.run = Some(info.id),
            Err(e) => {
                if p.ended.is_none() {
                    p.ended = Some((SystemTime::now(), None));
                }
                s.start_error = Some(e.message.clone());
            }
        }
        drop(s);
        self.run.changed.notify_waiters();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    Agent,
    User,
}

enum Intervention {
    Input(String),
    Key(&'static str),
    Rerun,
    Stop,
    Close,
}

#[derive(Default)]
enum Escape {
    #[default]
    None,
    Started,
    Sequence,
}

struct Process {
    generation: u64,
    run: Option<RunId>,
    by: Actor,
    started_at: SystemTime,
    /// Where its output starts in the tab's log.
    offset: u64,
    ended: Option<(SystemTime, Option<i32>)>,
    stopped_by: Option<Actor>,
}

struct State {
    command: String,
    cwd: String,
    log: Option<(PathBuf, std::fs::File)>,
    log_len: u64,
    generation: u64,
    process: Option<Process>,
    /// The next start of the tab is the agent's (`run_command`); any other is the user's rerun.
    agent_start: bool,
    /// The next Stop of the process is the agent's (`stop_run`).
    agent_stop: bool,
    start_error: Option<String>,
    interventions: Vec<(SystemTime, Intervention)>,
    /// Interventions already told to the agent.
    reported: usize,
    typed: String,
    escape: Escape,
    closed_at: Option<SystemTime>,
    last_output_at: Option<SystemTime>,
}

impl State {
    fn running(&self) -> bool {
        self.process.as_ref().is_some_and(|p| p.ended.is_none())
    }
}

/// An agent tab.
pub struct AgentRun {
    pub root: PathBuf,
    pub name: String,
    window: Mutex<String>,
    state: Mutex<State>,
    /// Signalled on every change: output, start, exit, intervention.
    changed: tokio::sync::Notify,
}

/// What a wait ended with.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WaitEnd {
    Exited,
    Matched,
    UserIntervened,
    TimedOut,
}

impl WaitEnd {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exited => "exited",
            Self::Matched => "matched",
            Self::UserIntervened => "userIntervened",
            Self::TimedOut => "timedOut",
        }
    }
}

/// What the agent is told to do when the user intervened.
pub const INTERVENTION_ADVICE: &str = "The user intervened in this command. Unless the user asked you otherwise, stop \
what you are doing now and tell the user you received the intervention; wait for the user's confirmation before you \
continue. Do not stop the process because of this.";

impl AgentRun {
    fn new(root: &Path, name: &str, command: &str, cwd: &str) -> Self {
        Self {
            root: root.to_owned(),
            name: name.to_owned(),
            window: Mutex::default(),
            state: Mutex::new(State {
                command: command.to_owned(),
                cwd: cwd.to_owned(),
                log: None,
                log_len: 0,
                generation: 0,
                process: None,
                agent_start: false,
                agent_stop: false,
                start_error: None,
                interventions: Vec::new(),
                reported: 0,
                typed: String::new(),
                escape: Escape::None,
                closed_at: None,
                last_output_at: None,
            }),
            changed: tokio::sync::Notify::new(),
        }
    }

    pub fn window(&self) -> String {
        self.window.lock().clone()
    }

    fn begin(&self, line: &str) -> u64 {
        let mut s = self.state.lock();
        s.generation += 1;
        let generation = s.generation;
        let by = if std::mem::take(&mut s.agent_start) { Actor::Agent } else { Actor::User };
        let now = SystemTime::now();
        if by == Actor::User {
            s.interventions.push((now, Intervention::Rerun));
        }
        s.command = line.to_owned();
        s.agent_stop = false;
        s.start_error = None;
        s.closed_at = None;
        s.typed.clear();
        s.escape = Escape::None;
        let offset = s.log_len;
        s.process = Some(Process { generation, run: None, by, started_at: now, offset, ended: None, stopped_by: None });
        drop(s);
        self.changed.notify_waiters();
        generation
    }

    fn output(&self, text: &str) {
        let mut s = self.state.lock();
        if s.log.is_none() {
            match temp_output_file(&format!("agent-{}", self.name)) {
                Ok(log) => s.log = Some(log),
                Err(e) => tracing::warn!("cannot log the output of {}: {e}", self.name),
            }
        }
        let written = s.log.as_mut().is_some_and(|(_, file)| file.write_all(text.as_bytes()).is_ok());
        if written {
            s.log_len += text.len() as u64;
        }
        s.last_output_at = Some(SystemTime::now());
        drop(s);
        self.changed.notify_waiters();
    }

    fn exited(&self, generation: u64, code: Option<i32>) {
        let mut s = self.state.lock();
        if let Some(p) = s.process.as_mut().filter(|p| p.generation == generation && p.ended.is_none()) {
            p.ended = Some((SystemTime::now(), code));
        }
        s.typed.clear();
        drop(s);
        self.changed.notify_waiters();
    }

    /// The agent is about to stop the process (`stop_run`).
    pub(crate) fn agent_stopping(&self) {
        self.state.lock().agent_stop = true;
    }

    fn stopping(&self, id: RunId) {
        let mut s = self.state.lock();
        let actor = if s.agent_stop { Actor::Agent } else { Actor::User };
        let Some(p) = s.process.as_mut().filter(|p| p.run == Some(id) && p.ended.is_none()) else { return };
        // A second Stop kills what the first asked to exit: still the first one's stop.
        if p.stopped_by.is_some() {
            return;
        }
        p.stopped_by = Some(actor);
        if actor == Actor::User {
            s.interventions.push((SystemTime::now(), Intervention::Stop));
        }
        drop(s);
        self.changed.notify_waiters();
    }

    fn closed(&self) {
        let mut s = self.state.lock();
        if s.closed_at.is_some() {
            return;
        }
        let now = SystemTime::now();
        s.closed_at = Some(now);
        s.interventions.push((now, Intervention::Close));
        drop(s);
        self.changed.notify_waiters();
    }

    /// What the user typed: the Run console sends whole lines (a line break ends one); control
    /// keys are told at once, escape sequences left out.
    fn user_input(&self, data: &str) {
        let mut s = self.state.lock();
        let now = SystemTime::now();
        let mut found = false;
        for c in data.chars() {
            match s.escape {
                Escape::Started => {
                    s.escape = if matches!(c, '[' | 'O') { Escape::Sequence } else { Escape::None };
                    continue;
                }
                Escape::Sequence => {
                    if ('@'..='~').contains(&c) {
                        s.escape = Escape::None;
                    }
                    continue;
                }
                Escape::None => {}
            }
            let key = match c {
                '\x1b' => {
                    s.escape = Escape::Started;
                    continue;
                }
                '\r' | '\n' => {
                    let line = std::mem::take(&mut s.typed);
                    s.interventions.push((now, Intervention::Input(line)));
                    found = true;
                    continue;
                }
                '\x7f' | '\x08' => {
                    s.typed.pop();
                    continue;
                }
                '\x03' => "Ctrl+C",
                '\x04' => "Ctrl+D",
                '\x1a' => "Ctrl+Z",
                '\x1c' => "Ctrl+\\",
                '\t' => {
                    s.typed.push('\t');
                    continue;
                }
                c if c.is_control() => continue,
                c => {
                    s.typed.push(c);
                    continue;
                }
            };
            s.typed.clear();
            s.interventions.push((now, Intervention::Key(key)));
            found = true;
        }
        drop(s);
        if found {
            self.changed.notify_waiters();
        }
    }

    fn remove_log(&self) {
        if let Some((path, file)) = self.state.lock().log.take() {
            drop(file);
            let _ = std::fs::remove_file(path);
        }
    }

    pub fn running(&self) -> bool {
        self.state.lock().running()
    }

    pub fn command(&self) -> String {
        self.state.lock().command.clone()
    }

    pub fn start_error(&self) -> Option<String> {
        self.state.lock().start_error.clone()
    }

    /// The process the agent can stop or type into.
    pub fn live_process(&self) -> Option<RunId> {
        let s = self.state.lock();
        s.process.as_ref().filter(|p| p.ended.is_none()).and_then(|p| p.run)
    }

    /// Where the output of the current (or last) process starts in the log.
    pub fn process_offset(&self) -> u64 {
        let s = self.state.lock();
        s.process.as_ref().map_or(s.log_len, |p| p.offset)
    }

    pub fn log_len(&self) -> u64 {
        self.state.lock().log_len
    }

    fn has_unreported(&self) -> bool {
        let s = self.state.lock();
        s.reported < s.interventions.len()
    }

    fn ended(&self) -> bool {
        let s = self.state.lock();
        s.process.as_ref().is_none_or(|p| p.ended.is_some()) || s.closed_at.is_some()
    }

    /// Log text from `from` up to `max` bytes; returns it with where it starts and ends
    /// (moved to character boundaries).
    pub fn read(&self, from: u64, max: usize) -> IdeResult<(String, u64, u64)> {
        let (path, len) = {
            let s = self.state.lock();
            match &s.log {
                Some((path, _)) => (path.clone(), s.log_len),
                None => return Ok((String::new(), from.min(s.log_len), from.min(s.log_len))),
            }
        };
        let from = from.min(len);
        let to = len.min(from.saturating_add(max as u64));
        let mut file = std::fs::File::open(&path)
            .map_err(|e| ide_core::IdeError::not_found(format!("the output log is no longer available: {e}")))?;
        file.seek(SeekFrom::Start(from))?;
        let mut bytes = vec![0; (to - from) as usize];
        file.read_exact(&mut bytes)?;
        let skip = bytes.iter().take_while(|b| (**b & 0xC0) == 0x80).count();
        let valid = match std::str::from_utf8(&bytes[skip..]) {
            Ok(_) => bytes.len(),
            Err(e) => skip + e.valid_up_to(),
        };
        let text = String::from_utf8_lossy(&bytes[skip..valid]).into_owned();
        Ok((text, from + skip as u64, from + valid as u64))
    }

    /// The last `lines` lines of the log, at most `max` bytes, from `from` on.
    pub fn tail(&self, from: u64, lines: usize, max: usize) -> IdeResult<(String, u64, u64)> {
        let len = self.log_len();
        let start = len.saturating_sub(max as u64).max(from);
        let (text, start, end) = self.read(start, max)?;
        let body = text.strip_suffix('\n').unwrap_or(&text);
        let cut = body.match_indices('\n').rev().nth(lines.max(1) - 1).map_or(0, |(i, _)| i + 1);
        Ok((text[cut..].to_owned(), start + cut as u64, end))
    }

    /// Waits until the process ends, `pattern` matches its output from `from`, the user
    /// intervenes or `deadline` passes. Cancelling the wait leaves the process running.
    pub async fn wait(
        &self,
        deadline: tokio::time::Instant,
        pattern: Option<&regex_lite::Regex>,
        from: u64,
        cancel: &ide_core::CancellationToken,
    ) -> IdeResult<WaitEnd> {
        let mut scanned = from;
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.has_unreported() {
                return Ok(WaitEnd::UserIntervened);
            }
            if let Some(pattern) = pattern {
                let (text, start, end) = self.read(scanned, SCAN_CHUNK)?;
                if pattern.is_match(&text) {
                    return Ok(WaitEnd::Matched);
                }
                // Lines can arrive in pieces: the last one is scanned again with the rest.
                let next = text.rfind('\n').map_or(start, |i| start + i as u64 + 1);
                let more = end < self.log_len();
                // A line longer than a chunk is given up on rather than read for ever.
                scanned = if more && next == start { end } else { next };
                if more {
                    continue;
                }
            }
            if self.ended() {
                return Ok(WaitEnd::Exited);
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(WaitEnd::TimedOut);
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep_until(deadline) => {}
                _ = cancel.cancelled() => return Err(ide_core::IdeError::cancelled()),
            }
        }
    }

    /// The tab's state for the agent.
    pub fn status(&self) -> Map<String, Value> {
        let s = self.state.lock();
        let mut out = Map::new();
        out.insert("name".into(), self.name.clone().into());
        out.insert("command".into(), s.command.clone().into());
        out.insert("workingDirectory".into(), s.cwd.clone().into());
        let state = match (&s.process, &s.start_error) {
            (_, Some(_)) => "startFailed",
            (None, None) => "starting",
            (Some(p), None) => match (p.ended, p.stopped_by) {
                (None, _) if p.run.is_none() => "starting",
                (None, Some(_)) => "stopping",
                (None, None) => "running",
                (Some(_), Some(Actor::Agent)) => "stoppedByAgent",
                (Some(_), Some(Actor::User)) => "stoppedByUser",
                (Some((_, Some(0))), None) => "succeeded",
                (Some((_, Some(code))), None) if crash(code).is_some() => "crashed",
                (Some(_), None) => "failed",
            },
        };
        out.insert("state".into(), state.into());
        if let Some(error) = &s.start_error {
            out.insert("error".into(), error.clone().into());
        }
        if let Some(p) = &s.process {
            out.insert("startedBy".into(), actor(p.by).into());
            out.insert("startedAt".into(), timestamp(p.started_at).into());
            if let Some((at, code)) = p.ended {
                out.insert("endedAt".into(), timestamp(at).into());
                if let Some(code) = code {
                    out.insert("exitCode".into(), code.into());
                    if let Some(signal) = crash(code) {
                        out.insert("crash".into(), signal.into());
                    }
                }
            }
            out.insert("outputOffset".into(), p.offset.into());
        }
        out.insert("outputLength".into(), s.log_len.into());
        if let Some(at) = s.last_output_at {
            out.insert("lastOutputAt".into(), timestamp(at).into());
        }
        if let Some(at) = s.closed_at {
            out.insert("tabClosedAt".into(), timestamp(at).into());
        }
        out
    }

    /// Interventions not told to the agent yet, now told.
    pub fn take_interventions(&self) -> Vec<Value> {
        let mut s = self.state.lock();
        let new: Vec<Value> = s.interventions[s.reported..]
            .iter()
            .map(|(at, i)| {
                let at = timestamp(*at);
                let message = match i {
                    Intervention::Input(line) if line.is_empty() => "The user pressed Enter".to_owned(),
                    Intervention::Input(line) => format!("User input: {line}"),
                    Intervention::Key(key) => format!("The user pressed {key}"),
                    Intervention::Rerun => format!("The user reran this command at {at}"),
                    Intervention::Stop => format!("The user stopped this command at {at}"),
                    Intervention::Close => format!("The user closed this tab at {at}"),
                };
                json!({ "at": at, "message": message })
            })
            .collect();
        s.reported = s.interventions.len();
        new
    }
}

fn actor(a: Actor) -> &'static str {
    match a {
        Actor::Agent => "agent",
        Actor::User => "user",
    }
}

/// How a process that died of a fault reports it: `128 + signal` (from the signal itself or
/// a shell that ran it), or an `NTSTATUS` error code on Windows.
pub fn crash(code: i32) -> Option<String> {
    if cfg!(windows) {
        let status = code as u32;
        return (status & 0xC000_0000 == 0xC000_0000).then(|| format!("exception 0x{status:08X}"));
    }
    let signal = code.checked_sub(128)?;
    let name = match signal {
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        7 if cfg!(target_os = "linux") => "SIGBUS",
        10 if !cfg!(target_os = "linux") => "SIGBUS",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        31 if cfg!(target_os = "linux") => "SIGSYS",
        12 if !cfg!(target_os = "linux") => "SIGSYS",
        _ => return None,
    };
    Some(name.to_owned())
}

/// `program` and arguments running `line` in Settings › Tools › Terminal › Shell path
/// (the user's login shell when empty), as the IDE's terminal would, but non-interactive.
fn shell_invocation(shell: Option<&str>, line: &str) -> (String, Vec<String>) {
    let configured = shell.map(str::trim).filter(|s| !s.is_empty());
    let words = configured.map(|s| super::process::split_words(s).unwrap_or_else(|_| vec![s.to_owned()]));
    let (program, mut args) = match words.as_deref() {
        Some([program, rest @ ..]) => ide_terminal::resolve_shell(Some(program), rest),
        _ => ide_terminal::resolve_shell(None, &[]),
    };
    let base = program.rsplit(['/', '\\']).next().unwrap_or(&program).to_ascii_lowercase();
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    match base {
        // The run's own shell line handling (`cmd /D /S /C "…"`) keeps the line's quoting.
        "cmd" => (line.to_owned(), Vec::new()),
        "pwsh" | "powershell" => {
            args.retain(|a| a != "-l");
            args.extend(["-NoLogo".to_owned(), "-Command".to_owned(), line.to_owned()]);
            (program, args)
        }
        // `-l` must be the only option of csh.
        "csh" | "tcsh" => {
            args.retain(|a| a != "-l");
            args.extend(["-c".to_owned(), line.to_owned()]);
            (program, args)
        }
        _ => {
            args.extend(["-c".to_owned(), line.to_owned()]);
            (program, args)
        }
    }
}

/// Output as an agent reads it: escape sequences (colour, cursor, window title) removed, and of a
/// line rewritten with `\r` (a progress bar), only what was written last. Other control
/// characters but tabs go too.
pub fn clean_output(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            text.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters, then a final byte.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC (and the like): up to BEL or ESC \.
            Some(']' | 'P' | '_' | '^') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let last = line.rsplit('\r').find(|part| !part.is_empty()).unwrap_or("");
            last.chars().filter(|c| *c == '\t' || !c.is_control()).collect()
        })
        .collect();
    lines.join("\n")
}

/// Which lines [`truncate_lines`] drops, as in JetBrains' MCP tools.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TruncateMode {
    /// The first lines: the end of the output stays.
    Start,
    /// Lines in the middle: its start and end stay.
    Middle,
    /// The last lines: the start stays.
    End,
    /// None: all of it.
    None,
}

impl TruncateMode {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name.trim().to_ascii_uppercase().as_str() {
            "START" => Self::Start,
            "MIDDLE" => Self::Middle,
            "END" => Self::End,
            "NONE" => Self::None,
            _ => return None,
        })
    }
}

/// At most `max_lines` lines of `text`, with a marker line where lines were left out; also
/// returns how many were. A line break at the end starts no line.
pub fn truncate_lines(text: &str, max_lines: usize, mode: TruncateMode) -> (String, usize) {
    let (body, newline) = match text.strip_suffix('\n') {
        Some(body) => (body, "\n"),
        None => (text, ""),
    };
    let lines: Vec<&str> = body.split('\n').collect();
    if mode == TruncateMode::None || lines.len() <= max_lines {
        return (text.to_owned(), 0);
    }
    let dropped = lines.len() - max_lines;
    let kept = match mode {
        TruncateMode::Start => [&[TRUNCATED_MARKER][..], &lines[dropped..]].concat(),
        TruncateMode::End => [&lines[..max_lines], &[TRUNCATED_MARKER][..]].concat(),
        _ => {
            let head = max_lines / 2;
            [&lines[..head], &[TRUNCATED_MARKER][..], &lines[lines.len() - (max_lines - head)..]].concat()
        }
    };
    (kept.join("\n") + newline, dropped)
}

/// `2026-11-12T08:30:05.123Z`.
pub fn timestamp(at: SystemTime) -> String {
    let ms = at.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (h, m, s, milli) = (rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> AgentRun {
        AgentRun::new(Path::new("/p"), "_agent_x", "echo", "")
    }

    fn messages(run: &AgentRun) -> Vec<String> {
        run.take_interventions().iter().map(|v| v["message"].as_str().unwrap().to_owned()).collect()
    }

    #[test]
    fn names_get_the_prefix_once() {
        assert_eq!(tab_name(" build ").unwrap(), "_agent_build");
        assert_eq!(tab_name("_agent_build").unwrap(), "_agent_build");
        assert!(tab_name("_agent_").is_err());
        assert!(tab_name("a\nb").is_err());
        assert!(tab_name(&"x".repeat(65)).is_err());
    }

    #[test]
    fn typed_keys_become_lines_and_control_keys() {
        let run = run();
        run.user_input("npm tset");
        run.user_input("\x7f\x7f\x7fest\x1b[A\x1b[200~ --ci\x1b[201~\r");
        run.user_input("\r");
        run.user_input("y\x03");
        assert_eq!(messages(&run), ["User input: npm test --ci", "The user pressed Enter", "The user pressed Ctrl+C"]);
        assert!(messages(&run).is_empty(), "told once");
    }

    #[test]
    fn starts_that_the_agent_did_not_ask_for_are_reruns() {
        let run = run();
        run.state.lock().agent_start = true;
        let first = run.begin("echo");
        assert!(messages(&run).is_empty());
        run.exited(first, Some(0));
        assert_eq!(run.status()["state"], "succeeded");
        run.begin("echo");
        let told = messages(&run);
        assert_eq!(told.len(), 1);
        assert!(told[0].starts_with("The user reran this command at "), "{told:?}");
        assert_eq!(run.status()["startedBy"], "user");
    }

    #[test]
    fn stops_are_the_agents_only_when_it_asked() {
        let run = run();
        run.state.lock().agent_start = true;
        let generation = run.begin("sleep 9");
        run.state.lock().process.as_mut().unwrap().run = Some(RunId(7));
        run.stopping(RunId(7));
        run.stopping(RunId(7));
        assert_eq!(messages(&run).len(), 1, "a second Stop (kill) is not another intervention");
        run.exited(generation, Some(130));
        assert_eq!(run.status()["state"], "stoppedByUser");

        run.state.lock().agent_start = true;
        let generation = run.begin("sleep 9");
        run.state.lock().process.as_mut().unwrap().run = Some(RunId(8));
        run.agent_stopping();
        run.stopping(RunId(8));
        run.exited(generation, Some(143));
        assert_eq!(run.status()["state"], "stoppedByAgent");
    }

    #[test]
    fn faults_are_crashes_and_other_codes_failures() {
        let run = run();
        for (code, state) in [(1, "failed"), (130, "failed")] {
            let generation = run.begin("x");
            run.exited(generation, Some(code));
            assert_eq!(run.status()["state"], state, "{code}");
        }
        if cfg!(unix) {
            let generation = run.begin("x");
            run.exited(generation, Some(139));
            let status = run.status();
            assert_eq!(status["state"], "crashed");
            assert_eq!(status["crash"], "SIGSEGV");
        }
    }

    #[test]
    fn reads_whole_characters_and_tails_lines() {
        let run = run();
        run.begin("x");
        run.output("one\n");
        run.output("twö\nthree\n");
        // `ö` is bytes 6..8: a cut inside it moves to the character's end or start.
        let (text, start, end) = run.read(5, 2).unwrap();
        assert_eq!((text.as_str(), start, end), ("w", 5, 6));
        let (text, start, end) = run.read(7, 3).unwrap();
        assert_eq!((text.as_str(), start, end), ("\nt", 8, 10));
        let (tail, start, _) = run.tail(0, 2, 1000).unwrap();
        assert_eq!(tail, "twö\nthree\n");
        assert_eq!(start, 4);
        run.remove_log();
    }

    #[test]
    fn shells_get_their_command_option() {
        assert_eq!(shell_invocation(Some("/bin/zsh"), "ls -a").1, ["-l", "-c", "ls -a"]);
        assert_eq!(shell_invocation(Some("/bin/bash --norc"), "ls").1, ["--norc", "-c", "ls"]);
        assert_eq!(shell_invocation(Some("/bin/tcsh"), "ls").1, ["-c", "ls"]);
        assert_eq!(shell_invocation(Some("/usr/bin/pwsh"), "ls").1, ["-NoLogo", "-Command", "ls"]);
        assert_eq!(shell_invocation(Some("cmd.exe"), "dir /b"), ("dir /b".to_owned(), Vec::new()));
    }

    #[test]
    fn timestamps_are_utc() {
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(1_794_478_205_123);
        assert_eq!(timestamp(at), "2026-11-12T10:10:05.123Z");
    }

    #[test]
    fn output_is_cleaned_of_escapes_and_overwritten_lines() {
        let raw = "\x1b[32mok\x1b[0m\r\n\x1b]0;title\x07 10%\r 50%\r100%\r\ndone\x1b]0;t\x1b\\\x08\n\tx";
        assert_eq!(clean_output(raw), "ok\n100%\ndone\n\tx");
        assert_eq!(clean_output("plain\nlines"), "plain\nlines");
        assert_eq!(clean_output("half\r"), "half", "a trailing carriage return keeps the line");
    }

    #[test]
    fn lines_are_truncated_as_jetbrains_does() {
        let text = "1\n2\n3\n4\n5";
        assert_eq!(truncate_lines(text, 2, TruncateMode::Start), (format!("{TRUNCATED_MARKER}\n4\n5"), 3));
        assert_eq!(truncate_lines(text, 2, TruncateMode::End), (format!("1\n2\n{TRUNCATED_MARKER}"), 3));
        assert_eq!(truncate_lines(text, 3, TruncateMode::Middle), (format!("1\n{TRUNCATED_MARKER}\n4\n5"), 2));
        assert_eq!(truncate_lines(text, 2, TruncateMode::None), (text.to_owned(), 0));
        assert_eq!(truncate_lines(text, 5, TruncateMode::Start), (text.to_owned(), 0));
        assert_eq!(truncate_lines("1\n2\n3\n", 2, TruncateMode::Start), (format!("{TRUNCATED_MARKER}\n2\n3\n"), 1));
        assert_eq!(TruncateMode::parse("middle"), Some(TruncateMode::Middle));
        assert_eq!(TruncateMode::parse("x"), None);
    }
}
