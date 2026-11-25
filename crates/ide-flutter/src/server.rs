//! A Flutter tool serving pages for the IDE to embed, one per project window, started when first
//! asked for. It reports its address on stdout. A server that fails or exits is not restarted on
//! its own: the next request starts a new one.

use crate::{KILL_GRACE, OUTPUT_TAIL, keep_output, read_lines, spawn_watched};
use ide_core::process::{kill_tree, terminate_tree};
use parking_lot::{Condvar, Mutex};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// What one line of the tool's output says.
pub(crate) enum Line {
    /// The page's address: the server is ready.
    Url(String),
    /// Text worth showing if the server fails.
    Output(String),
    /// Nothing worth keeping.
    Skip,
}

/// How to run one kind of server.
pub(crate) struct Spec {
    /// For messages, e.g. "Flutter DevTools".
    pub name: &'static str,
    pub args: &'static [&'static str],
    pub timeout: Duration,
    pub executable: fn(&Path) -> Option<PathBuf>,
    pub not_found: &'static str,
    pub line: fn(&str) -> Line,
    /// The failure to report, from the output kept until the tool exited.
    pub failed: fn(String) -> String,
}

#[derive(Default)]
enum Status {
    #[default]
    Stopped,
    Starting,
    Ready(String),
    Failed(String),
}

#[derive(Default)]
struct State {
    /// Bumped by every start and stop: a reader of an older process no longer has a say.
    generation: u64,
    child: Option<Child>,
    status: Status,
}

impl State {
    fn shut_down(&mut self) {
        self.generation += 1;
        if let Some(mut child) = self.child.take() {
            std::thread::spawn(move || terminate_tree(&mut child, KILL_GRACE));
        }
    }
}

struct Shared {
    root: PathBuf,
    spec: &'static Spec,
    /// The configured executable; the spec's lookup on the search path without one.
    executable: crate::Configured,
    timeout: Duration,
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    /// Applies `status` unless this process was replaced or stopped; false if it was.
    fn set(&self, generation: u64, status: Status) -> bool {
        let mut state = self.state.lock();
        if state.generation != generation {
            return false;
        }
        state.status = status;
        self.changed.notify_all();
        true
    }
}

pub struct ToolServer(Arc<Shared>);

impl ToolServer {
    pub(crate) fn new(root: PathBuf, spec: &'static Spec, executable: crate::Configured) -> Self {
        Self::with_executable(root, spec, executable, spec.timeout)
    }

    pub(crate) fn with_executable(
        root: PathBuf,
        spec: &'static Spec,
        executable: crate::Configured,
        timeout: Duration,
    ) -> Self {
        Self(Arc::new(Shared { root, spec, executable, timeout, state: Mutex::default(), changed: Condvar::new() }))
    }

    /// The server's address, starting it with `extra` arguments if none runs. Blocks until it is known.
    pub fn url(&self, extra: &[String]) -> Result<String, String> {
        let shared = &self.0;
        let deadline = Instant::now() + shared.timeout;
        let mut state = shared.state.lock();
        if matches!(state.status, Status::Stopped | Status::Failed(_)) {
            state.generation += 1;
            state.status = Status::Starting;
            let (shared, generation, extra) = (shared.clone(), state.generation, extra.to_vec());
            std::thread::spawn(move || run(&shared, generation, &extra));
        }
        loop {
            match &state.status {
                Status::Ready(url) => return Ok(url.clone()),
                Status::Failed(message) => return Err(message.clone()),
                Status::Stopped => return Err(format!("{} was stopped", shared.spec.name)),
                Status::Starting => {}
            }
            if shared.changed.wait_until(&mut state, deadline).timed_out() {
                state.shut_down();
                let message = format!("{} did not start in time", shared.spec.name);
                state.status = Status::Failed(message.clone());
                shared.changed.notify_all();
                return Err(message);
            }
        }
    }

    /// Ends the server (project closed, or no longer trusted).
    pub fn stop(&self) {
        let mut state = self.0.state.lock();
        state.shut_down();
        state.status = Status::Stopped;
        self.0.changed.notify_all();
    }

    /// Ends the server before returning, for a process about to exit.
    pub fn kill(&self) {
        let mut state = self.0.state.lock();
        state.generation += 1;
        state.status = Status::Stopped;
        if let Some(mut child) = state.child.take() {
            kill_tree(&mut child);
        }
        self.0.changed.notify_all();
    }

    #[cfg(all(test, unix))]
    pub(crate) fn is_stopped(&self) -> bool {
        matches!(self.0.state.lock().status, Status::Stopped)
    }
}

/// One server's whole life, on its own thread.
fn run(shared: &Arc<Shared>, generation: u64, extra: &[String]) {
    let spec = shared.spec;
    let fail = |message: String| {
        shared.set(generation, Status::Failed(message));
    };
    let Some(executable) = (shared.executable)().or_else(|| (spec.executable)(&shared.root)) else {
        return fail(spec.not_found.into());
    };
    let args: Vec<&str> = spec.args.iter().copied().chain(extra.iter().map(String::as_str)).collect();
    let mut child = match spawn_watched(&executable, &args, &shared.root) {
        Ok(child) => child,
        Err(e) => return fail(format!("could not run {}: {e}", executable.display())),
    };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        terminate_tree(&mut child, Duration::ZERO);
        return fail("no output pipe".into());
    };
    {
        let mut state = shared.state.lock();
        if state.generation != generation {
            drop(state);
            terminate_tree(&mut child, KILL_GRACE);
            return;
        }
        state.child = Some(child);
    }
    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(OUTPUT_TAIL)));
    let errors = {
        let tail = tail.clone();
        std::thread::spawn(move || {
            read_lines(stderr, |line| {
                keep_output(&tail, line);
                true
            });
        })
    };
    read_lines(stdout, |line| match (spec.line)(line) {
        Line::Url(url) => shared.set(generation, Status::Ready(url)),
        Line::Output(text) => {
            keep_output(&tail, &text);
            true
        }
        Line::Skip => true,
    });
    let _ = errors.join();

    let mut state = shared.state.lock();
    if state.generation != generation {
        return;
    }
    let child = state.child.take();
    state.status = if matches!(state.status, Status::Ready(_)) {
        Status::Stopped
    } else {
        let message = Vec::from(std::mem::take(&mut *tail.lock())).join("\n");
        Status::Failed((spec.failed)(message))
    };
    shared.changed.notify_all();
    drop(state);
    if let Some(mut child) = child {
        std::thread::spawn(move || terminate_tree(&mut child, Duration::ZERO));
    }
}
