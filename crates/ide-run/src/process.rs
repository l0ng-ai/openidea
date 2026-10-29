//! Process lifecycle for run configurations: spawn (on pipes, or on a pseudo-terminal
//! for "Emulate terminal in output console"), stream output, stdin, stop.

use crate::utf8::OutputDecoder;
use crate::{OutputChunk, RunConfig, RunInfo};
use ide_core::{IdeError, IdeEvent, IdeResult, RunId, SharedSink};
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

const BATCH_INTERVAL: Duration = Duration::from_millis(8);
const BATCH_BYTES: usize = 64 * 1024;
/// After the main process exits, how long to wait for pipes still held by
/// orphaned descendants before reporting the exit.
const EXIT_DRAIN: Duration = Duration::from_millis(500);
/// Delay between SIGINT and SIGKILL on [`ProcessManager::stop`].
const STOP_GRACE: Duration = Duration::from_secs(3);
/// Longest a configuration's stop command (e.g. `docker stop`) may take before signals follow.
const STOP_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// Finished runs kept for [`ProcessManager::list`].
const MAX_FINISHED: usize = 20;
/// PTY size until the console reports its own.
const DEFAULT_PTY: (u16, u16) = (120, 30);

type OutputFn = Arc<dyn Fn(OutputChunk) + Send + Sync>;

/// Environment of a launched process: the inherited one (unless cleared) plus `vars`.
#[derive(Clone, Debug, Default)]
struct LaunchEnv {
    clear: bool,
    vars: BTreeMap<String, String>,
}

/// A configuration's stop command and where it runs.
struct StopCommand {
    line: String,
    cwd: PathBuf,
    env: LaunchEnv,
}

struct Entry {
    id: RunId,
    config_id: String,
    name: String,
    pid: Option<u32>,
    stdin: Mutex<Option<Box<dyn Write + Send>>>,
    /// The PTY master of a terminal-emulated run (resize; dropped on exit).
    pty: Option<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    stop: Option<StopCommand>,
    output: OutputFn,
    exited: AtomicBool,
    stopping: AtomicBool,
}

impl Entry {
    fn info(&self) -> RunInfo {
        RunInfo {
            id: self.id,
            config_id: self.config_id.clone(),
            name: self.name.clone(),
            pid: self.pid,
            running: !self.exited.load(Ordering::Acquire),
            pty: self.pty.is_some(),
        }
    }
}

/// Per-start options taken from settings.
#[derive(Clone, Debug, Default)]
pub struct StartOptions {
    /// Output encoding label (`UTF-8`, `GBK`, `windows-1252`…); `None` = UTF-8.
    pub encoding: Option<String>,
    /// Project content and source roots added to Python launch environments.
    pub python_paths: Vec<PathBuf>,
}

#[derive(Default)]
pub struct ProcessManager {
    runs: Arc<Mutex<BTreeMap<RunId, Arc<Entry>>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stream {
    Stdout,
    Stderr,
}

enum Exit {
    Pipes(std::io::Result<ExitStatus>),
    Pty(std::io::Result<portable_pty::ExitStatus>),
}

enum Msg {
    Data(Stream, Vec<u8>),
    Exited(Exit),
}

/// The program and arguments actually executed, plus the echoed command line.
pub(crate) struct Invocation {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Passed verbatim (Windows `cmd /S /C "…"`: cmd does not parse C runtime quoting).
    pub raw_args: bool,
    /// A command line run by the platform shell (`display` is the line).
    pub shell: bool,
    pub display: String,
}

const SHELL_CHARS: &[char] = &[
    '|', '&', ';', '<', '>', '(', ')', '$', '`', '\\', '"', '\'', '*', '?', '[', ']', '#', '~', '=', '%', '{', '}',
    '\n',
];

fn needs_quoting(s: &str) -> bool {
    s.is_empty() || s.contains(char::is_whitespace) || s.contains(SHELL_CHARS)
}

fn quote(s: &str) -> String {
    if !needs_quoting(s) {
        s.to_owned()
    } else if cfg!(windows) {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

pub(crate) fn invocation(config: &RunConfig, cwd: &Path) -> Invocation {
    let windows = cfg!(windows);
    let command = config.command.trim();
    let looks_like_shell = command.contains(char::is_whitespace) || command.contains(SHELL_CHARS);
    if config.args.is_empty() && looks_like_shell && !cwd.join(command).is_file() {
        return shell_invocation(command, windows, std::env::var("COMSPEC").ok());
    }
    let program = resolve_program(command, cwd, &config.env, windows);
    let mut display = quote(command);
    for a in &config.args {
        display.push(' ');
        display.push_str(&quote(a));
    }
    Invocation { program, args: config.args.clone(), raw_args: false, shell: false, display }
}

/// "Shorten command line" for a `java` launch too long for the platform (see
/// [`crate::java_cmdline`]): rewrites `inv` and returns the temporary file to delete on exit.
fn shorten_java(inv: &mut Invocation, config: &RunConfig, cwd: &Path) -> IdeResult<TempFile> {
    if inv.raw_args || !crate::java_cmdline::is_java_launcher(&inv.program) {
        return Ok(TempFile(None));
    }
    let java = if inv.program.components().count() == 1 {
        crate::which::find_executable(&inv.program.to_string_lossy(), &crate::wrap::search_path(config))
            .unwrap_or_else(|| inv.program.clone())
    } else {
        inv.program.clone()
    };
    let dir = crate::java_cmdline::default_temp_dir();
    let shortened = crate::java_cmdline::shorten(&java, &inv.args, cwd, cfg!(windows), &dir)
        .map_err(|e| IdeError::internal(format!("cannot shorten the command line: {e}")))?;
    let Some(s) = shortened else { return Ok(TempFile(None)) };
    tracing::debug!(how = s.how.as_str(), file = %s.file.display(), "java command line shortened");
    let mut display = quote(config.command.trim());
    for a in &s.args {
        display.push(' ');
        display.push_str(&quote(a));
    }
    inv.args = s.args;
    inv.display = display;
    Ok(TempFile(Some(s.file)))
}

/// Tells JVM and Python processes to write the encoding the console decodes (see
/// [`ide_core::output_encoding`]); returns the notice line to hide from the output.
fn match_console_encoding(
    inv: &mut Invocation,
    env: &mut LaunchEnv,
    config: &RunConfig,
    options: &StartOptions,
) -> Option<String> {
    use ide_core::output_encoding;
    let inherit = !env.clear;
    let inherited = |key: &str| if inherit { std::env::var(key).ok() } else { None };
    let encoding = options.encoding.as_deref().unwrap_or("UTF-8");
    let fix = if inv.shell {
        output_encoding::fix_command_line(&inv.display, &env.vars, inherited, encoding, cfg!(windows))
    } else {
        let program = inv.program.to_string_lossy();
        output_encoding::fix(&program, &inv.args, &env.vars, inherited, encoding, cfg!(windows))
    };
    env.vars.extend(fix.env);
    if !fix.java_args.is_empty() && !inv.raw_args {
        inv.args.splice(0..0, fix.java_args);
        let mut display = quote(config.command.trim());
        for a in &inv.args {
            display.push(' ');
            display.push_str(&quote(a));
        }
        inv.display = display;
    }
    fix.notice
}

/// A launch's pathing jar / argfile, deleted when dropped (the process exited, or never started).
struct TempFile(Option<PathBuf>);

impl Drop for TempFile {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            let _ = std::fs::remove_file(f);
        }
    }
}

/// `command` as one line for the platform shell: `/bin/sh -c`, or `cmd /D /S /C "…"`
/// (`/S` strips exactly the outer quotes, so the line's own quoting survives).
fn shell_invocation(command: &str, windows: bool, comspec: Option<String>) -> Invocation {
    if windows {
        return Invocation {
            program: comspec.filter(|c| !c.is_empty()).unwrap_or_else(|| "cmd.exe".into()).into(),
            args: vec!["/D".into(), "/S".into(), "/C".into(), format!("\"{command}\"")],
            raw_args: true,
            shell: true,
            display: command.into(),
        };
    }
    Invocation {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), command.into()],
        raw_args: false,
        shell: true,
        display: command.into(),
    }
}

/// The program to spawn: relative paths like `./gradlew` or `.venv/bin/python`
/// against the run directory; on Windows a bare name through `PATH` × `PATHEXT`
/// (`kotlinc` → `kotlinc.bat`), which `Command` would only try as `.exe`.
fn resolve_program(command: &str, cwd: &Path, env: &BTreeMap<String, String>, windows: bool) -> PathBuf {
    let path = Path::new(command);
    if path.is_relative() && path.components().count() > 1 {
        return cwd.join(path);
    }
    if windows && path.components().count() == 1 && path.is_relative() {
        let search = env
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
            .map(|(_, v)| std::ffi::OsString::from(v))
            .or_else(|| std::env::var_os("PATH"))
            .unwrap_or_default();
        let pathext = std::env::var("PATHEXT").ok();
        if let Some(found) = crate::which::find_executable_in(command, &search, true, pathext.as_deref()) {
            return found;
        }
    }
    path.to_path_buf()
}

/// "Save console output to file": everything shown in the console is also written to `path`.
fn tee_output(path: &Path, on_output: OutputFn) -> IdeResult<OutputFn> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file = std::fs::File::create(path)
        .map_err(|e| IdeError::invalid(format!("cannot write console output to {}: {e}", path.display())))?;
    let file = Mutex::new(std::io::LineWriter::new(file));
    Ok(Arc::new(move |chunk: OutputChunk| {
        let text = match &chunk {
            OutputChunk::Stdout { text } | OutputChunk::Stderr { text } | OutputChunk::System { text } => text,
        };
        let _ = file.lock().write_all(text.as_bytes());
        on_output(chunk);
    }))
}

fn resolve_cwd(root: &Path, cwd: Option<&Path>) -> PathBuf {
    match cwd {
        Some(c) if c.is_absolute() => c.to_path_buf(),
        Some(c) if !c.as_os_str().is_empty() => root.join(c),
        _ => root.to_path_buf(),
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a run; its `IdeEvent::RunExited` goes to `sink` (the starter's) only.
    pub fn start(
        &self,
        root: &Path,
        config: &RunConfig,
        options: &StartOptions,
        sink: SharedSink,
        on_output: Box<dyn Fn(OutputChunk) + Send + Sync>,
    ) -> IdeResult<RunInfo> {
        if config.command.trim().is_empty() {
            return Err(IdeError::invalid("run configuration has no command"));
        }
        let cwd = resolve_cwd(root, config.cwd.as_deref());
        if !cwd.is_dir() {
            return Err(IdeError::not_found(format!("working directory does not exist: {}", cwd.display())));
        }
        let mut inv = invocation(config, &cwd);
        let extras = &config.extras;
        if extras.emulate_terminal && extras.stdin_file.is_some() {
            return Err(IdeError::invalid("input cannot be redirected from a file when emulating a terminal"));
        }
        let mut env = launch_env(root, config)?;
        if matches!(config.kind.as_str(), "python" | "pytest") {
            crate::python_path::extend(&mut env.vars, &options.python_paths, !env.clear)?;
        }
        let on_output: OutputFn = Arc::from(on_output);
        let on_output = match extras.output_file.as_deref() {
            Some(file) => tee_output(&resolve_cwd(root, Some(Path::new(file))), on_output)?,
            None => on_output,
        };
        let stop = extras.stop_command.as_deref().map(str::trim).filter(|l| !l.is_empty()).map(|line| StopCommand {
            line: line.to_owned(),
            cwd: cwd.clone(),
            env: env.clone(),
        });
        // A terminal re-encodes output itself; pipes carry the process's bytes as they are.
        let notice =
            if extras.emulate_terminal { None } else { match_console_encoding(&mut inv, &mut env, config, options) };
        let temp = shorten_java(&mut inv, config, &cwd)?;
        if extras.emulate_terminal {
            return self.start_pty(config, &inv, &cwd, &env, stop, options, sink, on_output, temp);
        }

        let mut cmd = Command::new(&inv.program);
        if inv.raw_args {
            add_raw_args(&mut cmd, &inv.args);
        } else {
            cmd.args(&inv.args);
        }
        cmd.current_dir(&cwd).stdout(Stdio::piped()).stderr(Stdio::piped());
        let redirected = match extras.stdin_file.as_deref() {
            Some(file) => {
                let path = resolve_cwd(root, Some(Path::new(file)));
                let f = std::fs::File::open(&path)
                    .map_err(|e| IdeError::not_found(format!("cannot redirect input from {}: {e}", path.display())))?;
                cmd.stdin(Stdio::from(f));
                true
            }
            None => {
                cmd.stdin(Stdio::piped());
                false
            }
        };
        apply_env(&mut cmd, &env);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | ide_core::process::CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => IdeError::unavailable(format!("command not found: {}", config.command)),
            _ => IdeError::from(e),
        })?;

        let id = RunId::next();
        let stdin: Option<Box<dyn Write + Send>> = match child.stdin.take() {
            Some(pipe) if !redirected => Some(Box::new(pipe)),
            _ => None,
        };
        let entry = Arc::new(Entry {
            id,
            config_id: config.id.clone(),
            name: config.name.clone(),
            pid: Some(child.id()),
            stdin: Mutex::new(stdin),
            pty: None,
            stop,
            output: on_output.clone(),
            exited: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
        });
        self.register(entry.clone());

        on_output(OutputChunk::System { text: format!("{}\n", inv.display) });

        let (tx, rx) = mpsc::channel();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let result = (|| -> std::io::Result<()> {
            if let Some(out) = stdout {
                spawn_reader(id, Stream::Stdout, out, tx.clone())?;
            }
            if let Some(err) = stderr {
                spawn_reader(id, Stream::Stderr, err, tx.clone())?;
            }
            spawn_pump(rx, on_output, entry.clone(), sink, options.encoding.clone(), notice)?;
            Ok(())
        })();
        if let Err(e) = result {
            let _ = child.kill();
            let _ = child.wait();
            entry.exited.store(true, Ordering::Release);
            return Err(IdeError::internal(format!("failed to start output threads: {e}")));
        }
        // The waiter owns the child; it must exist for the pump to ever finish.
        let waiter_tx = tx;
        std::thread::Builder::new()
            .name(format!("openidea-run-wait-{}", id.0))
            .spawn(move || {
                let status = child.wait();
                drop(temp);
                let _ = waiter_tx.send(Msg::Exited(Exit::Pipes(status)));
            })
            .map_err(|e| IdeError::internal(format!("failed to start waiter thread: {e}")))?;

        tracing::debug!(%id, config = %config.id, pid = ?entry.pid, "run started");
        Ok(entry.info())
    }

    /// [`Self::start`] on a pseudo-terminal: one merged output stream of raw terminal data.
    #[allow(clippy::too_many_arguments)]
    fn start_pty(
        &self,
        config: &RunConfig,
        inv: &Invocation,
        cwd: &Path,
        env: &LaunchEnv,
        stop: Option<StopCommand>,
        options: &StartOptions,
        sink: SharedSink,
        on_output: OutputFn,
        temp: TempFile,
    ) -> IdeResult<RunInfo> {
        let pair = native_pty_system()
            .openpty(pty_size(DEFAULT_PTY.0, DEFAULT_PTY.1))
            .map_err(|e| IdeError::internal(format!("openpty failed: {e}")))?;
        let mut cmd = CommandBuilder::new(&inv.program);
        cmd.args(&inv.args);
        cmd.cwd(cwd);
        if env.clear {
            cmd.env_clear();
        } else {
            for (k, v) in ide_core::process::host_env_fixes() {
                match v {
                    Some(v) => cmd.env(k, v),
                    None => cmd.env_remove(k),
                }
            }
            for (k, v) in ide_core::process::shell_env() {
                cmd.env(k, v);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in &env.vars {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
            let text = e.to_string();
            if text.contains("No such file") || text.contains("not found") {
                IdeError::unavailable(format!("command not found: {}", config.command))
            } else {
                IdeError::unavailable(format!("failed to start `{}`: {text}", config.command))
            }
        })?;
        // The child holds its own copy of the slave; dropping ours lets reads hit EOF on exit.
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| IdeError::internal(format!("pty reader: {e}")))?;
        let writer = pair.master.take_writer().map_err(|e| IdeError::internal(format!("pty writer: {e}")))?;

        let id = RunId::next();
        let entry = Arc::new(Entry {
            id,
            config_id: config.id.clone(),
            name: config.name.clone(),
            pid: child.process_id(),
            stdin: Mutex::new(Some(writer)),
            pty: Some(Mutex::new(Some(pair.master))),
            stop,
            output: on_output.clone(),
            exited: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
        });
        self.register(entry.clone());
        on_output(OutputChunk::System { text: format!("{}\n", inv.display) });

        let (tx, rx) = mpsc::channel();
        let result = spawn_reader(id, Stream::Stdout, reader, tx.clone())
            .and_then(|_| spawn_pump(rx, on_output, entry.clone(), sink, options.encoding.clone(), None));
        if let Err(e) = result {
            let _ = child.kill();
            let _ = child.wait();
            entry.exited.store(true, Ordering::Release);
            return Err(IdeError::internal(format!("failed to start output threads: {e}")));
        }
        std::thread::Builder::new()
            .name(format!("openidea-run-wait-{}", id.0))
            .spawn(move || {
                let status = child.wait();
                drop(temp);
                let _ = tx.send(Msg::Exited(Exit::Pty(status)));
            })
            .map_err(|e| IdeError::internal(format!("failed to start waiter thread: {e}")))?;
        tracing::debug!(%id, config = %config.id, pid = ?entry.pid, "run started on a pty");
        Ok(entry.info())
    }

    /// Resizes the pseudo-terminal of a terminal-emulated run.
    pub fn resize(&self, id: RunId, cols: u16, rows: u16) -> IdeResult<()> {
        let entry = self.entry(id)?;
        let Some(pty) = &entry.pty else { return Err(IdeError::invalid("the process does not run in a terminal")) };
        match pty.lock().as_ref() {
            Some(master) => {
                master.resize(pty_size(cols, rows)).map_err(|e| IdeError::internal(format!("resize failed: {e}")))
            }
            None => Ok(()),
        }
    }

    fn register(&self, entry: Arc<Entry>) {
        let mut runs = self.runs.lock();
        runs.retain(|_, e| !(e.config_id == entry.config_id && e.exited.load(Ordering::Acquire)));
        let finished: Vec<RunId> = runs.values().filter(|e| e.exited.load(Ordering::Acquire)).map(|e| e.id).collect();
        if finished.len() >= MAX_FINISHED {
            for id in &finished[..=finished.len() - MAX_FINISHED] {
                runs.remove(id);
            }
        }
        runs.insert(entry.id, entry);
    }

    fn entry(&self, id: RunId) -> IdeResult<Arc<Entry>> {
        self.runs.lock().get(&id).cloned().ok_or_else(|| IdeError::not_found(format!("no such run: {id}")))
    }

    pub fn write_stdin(&self, id: RunId, data: &str) -> IdeResult<()> {
        let entry = self.entry(id)?;
        if entry.exited.load(Ordering::Acquire) {
            return Err(IdeError::invalid("process has exited"));
        }
        let mut stdin = entry.stdin.lock();
        let pipe = stdin.as_mut().ok_or_else(|| IdeError::invalid("stdin is closed"))?;
        let res = pipe.write_all(data.as_bytes()).and_then(|_| pipe.flush());
        if let Err(e) = res {
            if e.kind() == std::io::ErrorKind::BrokenPipe {
                *stdin = None;
            }
            return Err(e.into());
        }
        Ok(())
    }

    /// Closes the process's stdin (sends EOF; on a terminal, types ^D).
    pub fn close_stdin(&self, id: RunId) -> IdeResult<()> {
        let entry = self.entry(id)?;
        if entry.pty.is_some() {
            return self.write_stdin(id, "\u{4}");
        }
        entry.stdin.lock().take();
        Ok(())
    }

    /// Graceful stop (SIGINT, then SIGKILL after a timeout), whole process group.
    pub fn stop(&self, id: RunId) -> IdeResult<()> {
        self.stop_with_grace(id, STOP_GRACE)
    }

    /// [`Self::stop`] with an explicit grace period before the kill. A configuration's
    /// stop command runs first; signals follow only if the process outlives it.
    pub fn stop_with_grace(&self, id: RunId, grace: Duration) -> IdeResult<()> {
        let entry = self.entry(id)?;
        if entry.exited.load(Ordering::Acquire) {
            return Ok(());
        }
        let Some(pid) = entry.pid else { return Ok(()) };
        if entry.stopping.swap(true, Ordering::AcqRel) {
            // Second stop request: don't wait out the grace period.
            kill_tree(pid, true);
            return Ok(());
        }
        if entry.stop.is_none() {
            kill_tree(pid, false);
        }
        let entry = entry.clone();
        std::thread::Builder::new()
            .name(format!("openidea-run-stop-{}", id.0))
            .spawn(move || {
                let exits_within = |limit: Duration| {
                    let deadline = Instant::now() + limit;
                    while Instant::now() < deadline {
                        if !group_alive(pid, &entry) {
                            return true;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    !group_alive(pid, &entry)
                };
                if let Some(stop) = &entry.stop {
                    run_stop_command(stop, &entry.output);
                    if exits_within(grace) {
                        return;
                    }
                    kill_tree(pid, false);
                }
                if !exits_within(grace) {
                    tracing::debug!(id = %entry.id, pid, "process ignored interrupt; killing");
                    kill_tree(pid, true);
                }
            })
            .map_err(|e| IdeError::internal(format!("failed to start stop thread: {e}")))?;
        Ok(())
    }

    pub fn list(&self) -> Vec<RunInfo> {
        self.runs.lock().values().map(|e| e.info()).collect()
    }

    /// Kills every running process tree at once (shutting down).
    pub fn kill_all(&self) {
        for entry in self.runs.lock().values() {
            if !entry.exited.load(Ordering::Acquire)
                && let Some(pid) = entry.pid
            {
                kill_tree(pid, true);
            }
        }
    }
}

impl Drop for ProcessManager {
    fn drop(&mut self) {
        self.kill_all();
    }
}

/// The environment a configuration's process gets on top of the inherited one: `.env`
/// files, then the configured variables (later wins).
fn launch_env(root: &Path, config: &RunConfig) -> IdeResult<LaunchEnv> {
    let extras = &config.extras;
    let mut vars = if extras.env_files.is_empty() {
        BTreeMap::new()
    } else {
        let base: BTreeMap<String, String> =
            if extras.include_system_env { crate::system_env() } else { BTreeMap::new() };
        let paths: Vec<PathBuf> = extras.env_files.iter().map(|f| resolve_cwd(root, Some(Path::new(f)))).collect();
        crate::envfile::load(&paths, &base).map_err(|e| IdeError::not_found(format!("cannot read .env file: {e}")))?
    };
    if matches!(config.kind.as_str(), "python" | "pytest")
        && !config.env.contains_key("PYTHONUNBUFFERED")
        && !vars.contains_key("PYTHONUNBUFFERED")
    {
        vars.insert("PYTHONUNBUFFERED".into(), "1".into());
    }
    vars.extend(config.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    Ok(LaunchEnv { clear: !extras.include_system_env, vars })
}

fn apply_env(cmd: &mut Command, env: &LaunchEnv) {
    if env.clear {
        cmd.env_clear();
    } else {
        ide_core::process::host_env(cmd).envs(ide_core::process::shell_env());
    }
    cmd.envs(&env.vars);
}

/// Runs `stop.line` through the platform shell and waits for it (bounded), echoing it
/// and any error output to the console.
fn run_stop_command(stop: &StopCommand, output: &OutputFn) {
    output(OutputChunk::System { text: format!("{}\n", stop.line) });
    let inv = shell_invocation(&stop.line, cfg!(windows), std::env::var("COMSPEC").ok());
    let mut cmd = Command::new(&inv.program);
    ide_core::process::prepare(&mut cmd);
    if inv.raw_args {
        add_raw_args(&mut cmd, &inv.args);
    } else {
        cmd.args(&inv.args);
    }
    cmd.current_dir(&stop.cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    apply_env(&mut cmd, &stop.env);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            output(OutputChunk::Stderr { text: format!("Cannot run the stop command: {e}\n") });
            return;
        }
    };
    let stderr = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        })
    });
    let deadline = Instant::now() + STOP_COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let err = stderr.and_then(|h| h.join().ok()).unwrap_or_default();
    if !status.is_some_and(|s| s.success()) && !err.trim().is_empty() {
        output(OutputChunk::Stderr { text: format!("{}\n", err.trim_end()) });
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: if cols == 0 { DEFAULT_PTY.0 } else { cols },
        rows: if rows == 0 { DEFAULT_PTY.1 } else { rows },
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(unix)]
fn group_alive(pid: u32, _entry: &Entry) -> bool {
    // Signal 0 probes the group; it fails with ESRCH once every member is gone.
    unsafe { libc::kill(-(pid as libc::pid_t), 0) == 0 }
}

#[cfg(not(unix))]
fn group_alive(_pid: u32, entry: &Entry) -> bool {
    !entry.exited.load(Ordering::Acquire)
}

#[cfg(unix)]
fn kill_tree(pid: u32, force: bool) {
    let sig = if force { libc::SIGKILL } else { libc::SIGINT };
    let pid = pid as libc::pid_t;
    if pid <= 0 {
        return;
    }
    unsafe {
        if libc::kill(-pid, sig) != 0 {
            // Not a group leader after all (e.g. setpgid raced); signal the process itself.
            libc::kill(pid, sig);
        }
    }
}

#[cfg(windows)]
fn add_raw_args(cmd: &mut Command, args: &[String]) {
    use std::os::windows::process::CommandExt;
    for a in args {
        cmd.raw_arg(a);
    }
}

#[cfg(not(windows))]
fn add_raw_args(cmd: &mut Command, args: &[String]) {
    cmd.args(args);
}

#[cfg(windows)]
fn kill_tree(pid: u32, _force: bool) {
    use std::os::windows::process::CommandExt;
    // Console children have no reliable graceful signal from outside their console.
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(ide_core::process::CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn spawn_reader(
    id: RunId,
    stream: Stream,
    mut pipe: impl Read + Send + 'static,
    tx: Sender<Msg>,
) -> std::io::Result<()> {
    let label = if stream == Stream::Stdout { "out" } else { "err" };
    std::thread::Builder::new().name(format!("openidea-run-{label}-{}", id.0)).spawn(move || {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Msg::Data(stream, buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    })?;
    Ok(())
}

fn chunk(stream: Stream, text: String) -> OutputChunk {
    match stream {
        Stream::Stdout => OutputChunk::Stdout { text },
        Stream::Stderr => OutputChunk::Stderr { text },
    }
}

/// Merges both streams in arrival order, batching consecutive output of the same stream.
fn spawn_pump(
    rx: mpsc::Receiver<Msg>,
    on_output: OutputFn,
    entry: Arc<Entry>,
    sink: SharedSink,
    encoding: Option<String>,
    notice: Option<String>,
) -> std::io::Result<()> {
    std::thread::Builder::new().name(format!("openidea-run-pump-{}", entry.id.0)).spawn(move || {
        let mut out_dec = OutputDecoder::for_label(encoding.as_deref());
        let mut err_dec = OutputDecoder::for_label(encoding.as_deref());
        // "Picked up JAVA_TOOL_OPTIONS: …" from every JVM given the console encoding, on
        // either stream (`spring-boot:run` copies its fork's stderr to Maven's stdout).
        let filter = || notice.clone().map(ide_core::output_encoding::NoticeFilter::new);
        let (mut out_notice, mut err_notice) = (filter(), filter());
        let mut decoded = String::new();
        let mut pending = String::new();
        let mut pending_stream = Stream::Stdout;
        let mut batch_started: Option<Instant> = None;
        let mut status: Option<Exit> = None;
        let mut drain_deadline: Option<Instant> = None;

        let flush = |pending: &mut String, stream: Stream, started: &mut Option<Instant>| {
            if !pending.is_empty() {
                on_output(chunk(stream, std::mem::take(pending)));
            }
            *started = None;
        };

        loop {
            let now = Instant::now();
            let wait = [
                batch_started.map(|t| (t + BATCH_INTERVAL).saturating_duration_since(now)),
                drain_deadline.map(|t| t.saturating_duration_since(now)),
            ]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(Duration::from_secs(3600));
            match rx.recv_timeout(wait) {
                Ok(Msg::Data(stream, bytes)) => {
                    if stream != pending_stream {
                        flush(&mut pending, pending_stream, &mut batch_started);
                        pending_stream = stream;
                    }
                    let (dec, notice) = match stream {
                        Stream::Stdout => (&mut out_dec, &mut out_notice),
                        Stream::Stderr => (&mut err_dec, &mut err_notice),
                    };
                    match notice {
                        Some(filter) => {
                            dec.decode_into(&bytes, &mut decoded);
                            filter.filter(&decoded, &mut pending);
                            decoded.clear();
                        }
                        None => dec.decode_into(&bytes, &mut pending),
                    }
                    if !pending.is_empty() && batch_started.is_none() {
                        batch_started = Some(Instant::now());
                    }
                    if pending.len() >= BATCH_BYTES {
                        flush(&mut pending, pending_stream, &mut batch_started);
                    }
                }
                Ok(Msg::Exited(s)) => {
                    status = Some(s);
                    drain_deadline = Some(Instant::now() + EXIT_DRAIN);
                }
                Err(RecvTimeoutError::Timeout) => {
                    if drain_deadline.is_some_and(|d| Instant::now() >= d) {
                        break;
                    }
                    if batch_started.is_some_and(|t| t.elapsed() >= BATCH_INTERVAL) {
                        flush(&mut pending, pending_stream, &mut batch_started);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        flush(&mut pending, pending_stream, &mut batch_started);
        for (stream, dec, notice) in
            [(Stream::Stdout, &mut out_dec, &mut out_notice), (Stream::Stderr, &mut err_dec, &mut err_notice)]
        {
            let mut rest = dec.finish();
            if let Some(filter) = notice {
                let tail = std::mem::take(&mut rest);
                filter.filter(&tail, &mut rest);
                rest.push_str(&filter.finish());
            }
            if !rest.is_empty() {
                on_output(chunk(stream, rest));
            }
        }

        let (code, message) = describe_exit(status);
        on_output(OutputChunk::System { text: format!("\n{message}\n") });
        entry.stdin.lock().take();
        if let Some(pty) = &entry.pty {
            pty.lock().take();
        }
        entry.exited.store(true, Ordering::Release);
        tracing::debug!(id = %entry.id, ?code, "run exited");
        sink.emit(IdeEvent::RunExited { run: entry.id, code });
    })?;
    Ok(())
}

#[cfg(unix)]
fn signal_name(sig: i32) -> &'static str {
    match sig {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        _ => "signal",
    }
}

/// IDEA wording: `Process finished with exit code 130 (interrupted by signal 2:SIGINT)`.
fn describe_exit(status: Option<Exit>) -> (Option<i32>, String) {
    match status {
        Some(Exit::Pipes(Ok(s))) => {
            if let Some(code) = s.code() {
                return (Some(code), format!("Process finished with exit code {code}"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if let Some(sig) = s.signal() {
                    return signalled(sig);
                }
            }
            (None, "Process finished".to_owned())
        }
        Some(Exit::Pty(Ok(s))) => match s.signal() {
            None => {
                let code = s.exit_code() as i32;
                (Some(code), format!("Process finished with exit code {code}"))
            }
            Some(name) => match signal_number(name) {
                Some(sig) => signalled(sig),
                None => (None, format!("Process finished ({name})")),
            },
        },
        Some(Exit::Pipes(Err(e)) | Exit::Pty(Err(e))) => {
            (None, format!("Process finished with unknown exit status: {e}"))
        }
        None => (None, "Process finished".to_owned()),
    }
}

#[cfg(unix)]
fn signalled(sig: i32) -> (Option<i32>, String) {
    let code = 128 + sig;
    (Some(code), format!("Process finished with exit code {code} (interrupted by signal {sig}:{})", signal_name(sig)))
}

#[cfg(not(unix))]
fn signalled(sig: i32) -> (Option<i32>, String) {
    (Some(128 + sig), format!("Process finished with exit code {}", 128 + sig))
}

/// The number of a signal from the `strsignal` description portable-pty reports.
#[cfg(unix)]
fn signal_number(description: &str) -> Option<i32> {
    (1..32).find(|&sig| {
        // SAFETY: `strsignal` returns a pointer to a NUL-terminated C string that stays
        // valid until the next call on this thread; it is copied before that.
        let name = unsafe { libc::strsignal(sig) };
        !name.is_null() && unsafe { std::ffi::CStr::from_ptr(name) }.to_string_lossy() == description
    })
}

#[cfg(not(unix))]
fn signal_number(_description: &str) -> Option<i32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_lines_use_cmd_verbatim_on_windows() {
        let line = r#"(if not exist "C:\T\openidea-run" mkdir "C:\T\openidea-run") && "C:\Program Files\rustc.exe" -o "C:\T\openidea-run\hi.exe" hi.rs"#;
        let inv = shell_invocation(line, true, Some(r"C:\Windows\system32\cmd.exe".into()));
        assert_eq!(inv.program, PathBuf::from(r"C:\Windows\system32\cmd.exe"));
        assert_eq!(inv.args, ["/D", "/S", "/C", &format!("\"{line}\"")]);
        assert!(inv.raw_args);
        assert_eq!(inv.display, line);
        assert_eq!(shell_invocation("dir", true, None).program, PathBuf::from("cmd.exe"));
        assert_eq!(shell_invocation("dir", true, Some(String::new())).program, PathBuf::from("cmd.exe"));

        let unix = shell_invocation("mkdir -p /tmp/x && cc -o /tmp/x/a a.c", false, None);
        assert_eq!(unix.program, PathBuf::from("/bin/sh"));
        assert_eq!(unix.args, ["-c", "mkdir -p /tmp/x && cc -o /tmp/x/a a.c"]);
        assert!(!unix.raw_args);
    }

    #[test]
    fn resolves_bare_names_through_pathext_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("kotlinc.bat"), "@echo off\n").unwrap();
        let cwd = dir.path();
        let path = std::env::join_paths([&bin]).unwrap().to_string_lossy().into_owned();
        // Windows environment keys are case-insensitive (`Path`).
        let env = BTreeMap::from([("Path".to_owned(), path)]);
        assert_eq!(resolve_program("kotlinc", cwd, &env, true), bin.join("kotlinc.bat"));
        // Not found: left to the OS (`command not found` at spawn).
        assert_eq!(resolve_program("nope", cwd, &env, true), PathBuf::from("nope"));
        // Unix: bare names are left to `execvp`.
        assert_eq!(resolve_program("kotlinc", cwd, &env, false), PathBuf::from("kotlinc"));
        // Relative paths resolve against the run directory on every platform.
        assert_eq!(resolve_program("./gradlew", cwd, &env, true), cwd.join("./gradlew"));
        assert_eq!(resolve_program(".venv/bin/python", cwd, &env, false), cwd.join(".venv/bin/python"));
    }
}
