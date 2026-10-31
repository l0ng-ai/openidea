//! Run configurations, builds and terminal commands (they ask the user first unless brave mode is on).

use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_build::compile::{BuildEvent, BuildKind, BuildResult};
use ide_core::mcp::McpToolKind;
use ide_core::{IdeError, IdeResult, RequestId, RunId};
use ide_run::{OutputChunk, RunConfig};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

const DEFAULT_TIMEOUT_MS: usize = 120_000;
const TERMINAL_MAX_TIMEOUT_MS: usize = 600_000;
const RUN_MAX_TIMEOUT_MS: usize = 1_800_000;
const BUILD_DEFAULT_TIMEOUT_MS: usize = 600_000;
const BUILD_MAX_TIMEOUT_MS: usize = 3_600_000;
/// Lines of a run's or a failed build's output returned inline (the rest is in `fullOutputPath`).
const RUN_OUTPUT_LINES: usize = 300;
const TERMINAL_DEFAULT_LINES: usize = 2000;
const TERMINAL_MAX_LINES: usize = 20_000;
/// Longer output lines are cut (minified bundles, progress bars without newlines).
const MAX_LINE_CHARS: usize = 4000;
/// A terminal command's output kept in memory; more is dropped (with a note).
const MAX_CAPTURE_BYTES: usize = 16 << 20;
/// A run's output tail kept in memory (the whole output goes to its file).
const RUN_TAIL_BYTES: usize = 1 << 20;
const BUILD_MAX_PROBLEMS: usize = 300;
/// After a command exits, how long to wait for pipes still held by its background children.
const PIPE_DRAIN: Duration = Duration::from_millis(500);

pub fn tools() -> Vec<Tool> {
    vec![get_run_configurations(), execute_run_configuration(), execute_terminal_command(), build_project()]
}

// ---------------------------------------------------------------- helpers

fn timeout(call: &Call, default: usize, max: usize) -> IdeResult<Duration> {
    Ok(Duration::from_millis(call.count("timeout", default, max)? as u64))
}

/// Which part of long output is cut.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Truncate {
    /// Cut the beginning: keep the last lines (where results and errors usually are).
    Start,
    /// Keep the first and the last lines.
    Middle,
    /// Cut the end: keep the first lines.
    End,
    None,
}

impl Truncate {
    fn parse(s: Option<&str>) -> IdeResult<Self> {
        match s.map(|s| s.trim().to_ascii_uppercase()).as_deref() {
            None | Some("") | Some("START") => Ok(Self::Start),
            Some("MIDDLE") => Ok(Self::Middle),
            Some("END") => Ok(Self::End),
            Some("NONE") => Ok(Self::None),
            Some(other) => {
                Err(IdeError::invalid(format!("`truncateMode` must be START, MIDDLE, END or NONE, not {other}")))
            }
        }
    }
}

fn cut_line(line: &str) -> String {
    match line.char_indices().nth(MAX_LINE_CHARS) {
        Some((cut, _)) => format!("{} … (line truncated)", &line[..cut]),
        None => line.to_owned(),
    }
}

/// `text` limited to `max` lines; returns it and the number of lines left out.
pub(crate) fn truncate(text: &str, max: usize, mode: Truncate) -> (String, usize) {
    let body = text.strip_suffix('\n').unwrap_or(text);
    if body.is_empty() {
        return (String::new(), 0);
    }
    let lines: Vec<&str> = body.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let total = lines.len();
    let join = |part: &[&str]| part.iter().map(|l| cut_line(l)).collect::<Vec<_>>().join("\n");
    if mode == Truncate::None || total <= max {
        return (join(&lines), 0);
    }
    let omitted = total - max;
    let marker = format!("… {omitted} lines omitted …");
    let text = match mode {
        Truncate::Start => format!("{marker}\n{}", join(&lines[omitted..])),
        Truncate::End => format!("{}\n{marker}", join(&lines[..max])),
        _ => {
            let head = max / 2;
            let tail = max - head;
            format!("{}\n{marker}\n{}", join(&lines[..head]), join(&lines[total - tail..]))
        }
    };
    (text, omitted)
}

fn temp_output_file(prefix: &str) -> IdeResult<(PathBuf, std::fs::File)> {
    let dir = output_dir()?;
    let safe: String =
        prefix.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).take(40).collect();
    let path = dir.join(format!("{safe}-{}.log", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options.open(&path)?;
    Ok((path, file))
}

/// A directory only this user can read: output may hold secrets, and `/tmp` is shared on Linux.
fn output_dir() -> IdeResult<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        let dir = std::env::temp_dir().join(format!("openidea-mcp-{uid}"));
        match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        let meta = std::fs::symlink_metadata(&dir)?;
        if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
            return Err(IdeError::new(
                ide_core::error::ErrorKind::PermissionDenied,
                format!("{} is not a private directory of this user", dir.display()),
            ));
        }
        Ok(dir)
    }
    #[cfg(not(unix))]
    {
        let dir = std::env::temp_dir().join("openidea-mcp");
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }
}

/// POSIX-like word splitting: whitespace separates, quotes group, `\` escapes (not inside `'…'`).
pub(crate) fn split_words(line: &str) -> IdeResult<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => word.push(c),
                        None => return Err(IdeError::invalid("unterminated ' quote")),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(c @ ('"' | '\\' | '$' | '`')) => word.push(c),
                            Some(c) => {
                                word.push('\\');
                                word.push(c);
                            }
                            None => return Err(IdeError::invalid("unterminated \" quote")),
                        },
                        Some(c) => word.push(c),
                        None => return Err(IdeError::invalid("unterminated \" quote")),
                    }
                }
            }
            '\\' if !cfg!(windows) => {
                in_word = true;
                if let Some(c) = chars.next() {
                    word.push(c);
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    if in_word {
        words.push(word);
    }
    Ok(words)
}

fn quote(arg: &str) -> String {
    let plain = !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c));
    if plain { arg.to_owned() } else { format!("'{}'", arg.replace('\'', "'\\''")) }
}

fn command_line(config: &RunConfig) -> String {
    std::iter::once(config.command.clone()).chain(config.args.iter().map(|a| quote(a))).collect::<Vec<_>>().join(" ")
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    let pid = pid as libc::pid_t;
    if pid <= 0 {
        return;
    }
    // SAFETY: plain signal delivery; the process was started as its own group leader.
    unsafe {
        if libc::kill(-pid, libc::SIGKILL) != 0 {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null());
    ide_core::process::prepare(&mut cmd);
    let _ = cmd.status();
}

// ---------------------------------------------------------------- run configurations

const RUN_POINTS_NOTE: &str = "Run points inside files (tests, main functions) are detected by the editor only and \
are not available through MCP yet. Run a configuration by `configurationName`, or run the test command with \
execute_terminal_command.";

fn get_run_configurations() -> Tool {
    Tool::new(
        "get_run_configurations",
        McpToolKind::Read,
        "Lists the project's run configurations: saved ones and those detected from the build files (package.json \
scripts, Cargo targets, Gradle/Maven tasks, Go, Python, Makefile and justfile targets…). Each has its name (pass it to \
execute_run_configuration), type, command, program arguments, working directory and environment variables. With \
`filePath`, returns the run points (tests, main functions) of that file instead; these are not available through MCP \
yet, so the list is empty.",
        |call| async move {
            if let Some(file) = call.opt_str("filePath")?.filter(|f| !f.trim().is_empty()) {
                let path = call.resolve(&file)?;
                return Output::json(json!({
                    "filePath": call.display(&path),
                    "runPoints": [],
                    "note": RUN_POINTS_NOTE,
                }));
            }
            let configs = load_configs(&call).await?;
            let list: Vec<Value> = configs.iter().map(|c| describe_config(&call, c)).collect();
            Output::json(json!({ "configurations": list }))
        },
    )
    .param(Param::optional(
        "filePath",
        ParamType::String,
        "A file of the project: list its run points (tests, main functions) instead of the configurations",
    ))
}

async fn load_configs(call: &Call) -> IdeResult<Vec<RunConfig>> {
    let host = call.host();
    let window = call.window().to_owned();
    let h = host.clone();
    host.blocking(move || ide_host::ops::run::configs(&h, &window)).await
}

fn supports_overrides(config: &RunConfig) -> bool {
    config.extras.compound.is_empty() && !config.command.trim().is_empty()
}

fn describe_config(call: &Call, c: &RunConfig) -> Value {
    let cwd = c.cwd.as_deref().map(|p| if p.is_absolute() { p.to_path_buf() } else { call.root().join(p) });
    let mut v = json!({
        "name": c.name,
        "type": c.kind,
        "supportsDynamicLaunchOverrides": supports_overrides(c),
    });
    if !c.extras.compound.is_empty() {
        v["compound"] = json!(c.extras.compound);
    } else {
        v["command"] = c.command.clone().into();
        v["programArguments"] = c.args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ").into();
        v["workingDirectory"] = call.display(&cwd.unwrap_or_else(|| call.root().to_path_buf())).into();
    }
    if !c.env.is_empty() {
        v["envs"] = json!(c.env);
    }
    if c.is_test {
        v["isTest"] = true.into();
    }
    if c.detected {
        v["detected"] = true.into();
    }
    v
}

/// The configuration named `name` (exact, then case-insensitive, then by id).
fn find_config(configs: Vec<RunConfig>, name: &str) -> IdeResult<RunConfig> {
    let name = name.trim();
    let pick = |f: &dyn Fn(&RunConfig) -> bool| configs.iter().position(f);
    let found = pick(&|c| c.name == name)
        .or_else(|| pick(&|c| c.name.eq_ignore_ascii_case(name)))
        .or_else(|| pick(&|c| c.id == name));
    match found {
        Some(i) => Ok(configs.into_iter().nth(i).unwrap_or_else(|| unreachable!())),
        None => {
            let names: Vec<_> = configs.iter().map(|c| format!("`{}`", c.name)).collect();
            Err(IdeError::not_found(if names.is_empty() {
                format!("No run configuration named `{name}`: the project has none.")
            } else {
                format!(
                    "No run configuration named `{name}`. Available: {}. See get_run_configurations.",
                    names.join(", ")
                )
            }))
        }
    }
}

/// Applies the one-off overrides: missing or empty keeps the configuration's value,
/// whitespace-only clears it; `envs` merge (a whitespace-only value removes the variable).
fn apply_overrides(
    config: &mut RunConfig,
    root: &Path,
    args: Option<String>,
    cwd: Option<String>,
    envs: Vec<(String, String)>,
) -> IdeResult<()> {
    if let Some(args) = args.filter(|a| !a.is_empty()) {
        let words = split_words(&args)?;
        // A configuration that is one shell line (`npm run dev`, no separate arguments)
        // keeps its command and gets the new line's arguments appended.
        let shell_line = config.args.is_empty() && config.command.trim().contains(char::is_whitespace);
        if shell_line {
            if !words.is_empty() {
                config.command = format!("{} {}", config.command.trim(), args.trim());
            }
        } else {
            config.args = words;
        }
    }
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        if dir.trim().is_empty() {
            config.cwd = None;
        } else {
            let path = crate::project::resolve(root, &dir)?;
            if !path.is_dir() {
                return Err(IdeError::not_found(format!("workingDirectory {} is not a directory", path.display())));
            }
            config.cwd = Some(path.into());
        }
    }
    for (key, value) in envs {
        if key.trim().is_empty() || value.is_empty() {
            continue;
        }
        if value.trim().is_empty() {
            config.env.remove(&key);
        } else {
            config.env.insert(key, value);
        }
    }
    Ok(())
}

/// A run's output: the whole of it to a file, its tail in memory.
struct RunCapture {
    tail: String,
    dropped: bool,
    file: Option<std::fs::File>,
}

impl RunCapture {
    fn push(&mut self, text: &str) {
        if let Some(f) = &mut self.file
            && f.write_all(text.as_bytes()).is_err()
        {
            self.file = None;
        }
        self.tail.push_str(text);
        if self.tail.len() > 2 * RUN_TAIL_BYTES {
            let mut cut = self.tail.len() - RUN_TAIL_BYTES;
            while !self.tail.is_char_boundary(cut) {
                cut += 1;
            }
            self.tail.drain(..cut);
            self.dropped = true;
        }
    }
}

/// Polls how run `id` ended: `None` while running, else its exit code (if known).
fn run_exit(host: &ide_host::Host, id: RunId) -> Option<Option<i32>> {
    match host.processes.exit_code(id) {
        Ok(exit) => exit,
        // Remote (SSH) runs, or a finished run already forgotten: the run list knows whether it runs.
        Err(_) => match ide_host::ops::run::list(host).into_iter().find(|r| r.id == id) {
            Some(r) if r.running => None,
            _ => Some(None),
        },
    }
}

fn execute_run_configuration() -> Tool {
    Tool::new(
        "execute_run_configuration",
        McpToolKind::Execute,
        "Runs a run configuration of the project (see get_run_configurations) and, by default, waits for it to \
exit. Asks the user first unless brave mode is on. One-off overrides for this launch only: `programArguments` \
(replaces the configuration's arguments), `workingDirectory`, `envs` (merged into the configuration's variables). An \
empty or missing override keeps the configuration's value; a whitespace-only one clears it (an `envs` value of \
whitespace removes that variable). Returns `exitCode` (absent while running or when a signal ended it), the last 300 \
lines of the console `output`, and `fullOutputPath`, a file with the whole output that keeps growing while the \
process runs. When `timeout` expires the process keeps running (`timedOut: true`); stop it from the IDE or with \
execute_terminal_command. Before-launch tasks of the configuration are not run, and the run does not appear in the \
IDE's Run tool window.",
        |call| async move {
            let name = call.opt_str("configurationName")?.filter(|n| !n.trim().is_empty());
            let file = call.opt_str("filePath")?.filter(|f| !f.trim().is_empty());
            let name = match (name, file) {
                (Some(name), _) => name,
                (None, Some(_)) => return Err(IdeError::unavailable(RUN_POINTS_NOTE)),
                (None, None) => {
                    return Err(IdeError::invalid("pass `configurationName` (see get_run_configurations)"));
                }
            };
            let wait = call.flag("waitForExit", true)?;
            let limit = timeout(&call, DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS)?;
            let mut config = find_config(load_configs(&call).await?, &name)?;
            if !config.extras.compound.is_empty() {
                return Err(IdeError::invalid(format!(
                    "`{}` is a compound configuration; run its configurations ({}) one by one",
                    config.name,
                    config.extras.compound.join(", ")
                )));
            }
            let envs = call.str_map("envs")?;
            // The user approves the environment overrides too (`NODE_OPTIONS`, `PATH`, ...).
            let env_detail: String = envs
                .iter()
                .map(|(k, v)| if v.trim().is_empty() { format!("\nunset {k}") } else { format!("\n{k}={v}") })
                .collect();
            apply_overrides(
                &mut config,
                call.root(),
                call.opt_str("programArguments")?,
                call.opt_str("workingDirectory")?,
                envs,
            )?;
            let cwd = match config.cwd.as_deref() {
                Some(p) if p.is_absolute() => p.to_path_buf(),
                Some(p) => call.root().join(p),
                None => call.root().to_path_buf(),
            };
            call.confirm(
                &config.name,
                Some(format!("{}\nin {}{env_detail}", command_line(&config), call.display(&cwd))),
            )
            .await?;

            let (path, file) = temp_output_file(&format!("run-{}", config.name))?;
            let capture = Arc::new(Mutex::new(RunCapture { tail: String::new(), dropped: false, file: Some(file) }));
            let sink = capture.clone();
            let emit: ide_host::ops::Emit<OutputChunk> = Arc::new(move |chunk: OutputChunk| {
                let (OutputChunk::Stdout { text } | OutputChunk::Stderr { text } | OutputChunk::System { text }) =
                    &chunk;
                sink.lock().push(text);
            });
            let host = call.host();
            let info = ide_host::ops::run::start(&host, call.window(), config.clone(), emit).await?;

            let mut exit = None;
            let mut timed_out = false;
            if wait {
                let deadline = Instant::now() + limit;
                loop {
                    if let Some(e) = run_exit(&host, info.id) {
                        exit = Some(e);
                        break;
                    }
                    if Instant::now() >= deadline {
                        timed_out = true;
                        break;
                    }
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                        _ = call.cancel.cancelled() => {
                            let _ = ide_host::ops::run::stop(&host, call.window(), info.id);
                            return Err(IdeError::cancelled());
                        }
                    }
                }
            }
            let (tail, dropped) = {
                let c = capture.lock();
                (c.tail.clone(), c.dropped)
            };
            let (output, omitted) = truncate(&tail, RUN_OUTPUT_LINES, Truncate::Start);
            let mut result = Map::new();
            result.insert("configurationName".into(), config.name.into());
            match exit {
                Some(code) => {
                    if let Some(code) = code {
                        result.insert("exitCode".into(), code.into());
                    }
                }
                None => {
                    result.insert("running".into(), true.into());
                }
            }
            if timed_out {
                result.insert("timedOut".into(), true.into());
            }
            result.insert("output".into(), output.into());
            if omitted > 0 || dropped {
                result.insert("outputTruncated".into(), true.into());
            }
            result.insert("fullOutputPath".into(), path.to_string_lossy().into_owned().into());
            Output::json(Value::Object(result))
        },
    )
    .param(Param::optional(
        "configurationName",
        ParamType::String,
        "Name of the run configuration, as get_run_configurations lists it",
    ))
    .param(Param::optional(
        "filePath",
        ParamType::String,
        "With `line`: run the run point (test, main function) there. Not available through MCP yet",
    ))
    .param(Param::optional("line", ParamType::Integer, "1-based line of the run point in `filePath`"))
    .param(Param::optional(
        "programArguments",
        ParamType::String,
        "Arguments for this launch, as one shell-quoted string; replaces the configuration's",
    ))
    .param(Param::optional(
        "workingDirectory",
        ParamType::String,
        "Working directory for this launch (project-relative or absolute)",
    ))
    .param(Param::optional(
        "envs",
        ParamType::StringMap,
        "Environment variables for this launch, merged into the configuration's",
    ))
    .param(Param::optional(
        "waitForExit",
        ParamType::Boolean,
        "Wait for the process to exit (default true); false returns right after it starts",
    ))
    .param(Param::optional(
        "timeout",
        ParamType::Integer,
        "Milliseconds to wait for the exit (default 120000, at most 1800000); the process keeps running after it",
    ))
}

// ---------------------------------------------------------------- terminal commands

pub(crate) struct CommandOutput {
    pub text: String,
    pub code: Option<i32>,
    pub timed_out: bool,
    /// Output beyond [`MAX_CAPTURE_BYTES`] was dropped.
    pub overflow: bool,
}

/// The user's shell running `command` as a login shell (its profile's PATH and variables).
fn shell_argv(command: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        let comspec = std::env::var("COMSPEC").ok().filter(|c| !c.is_empty()).unwrap_or_else(|| "cmd.exe".into());
        // `/S` strips exactly the outer quotes, so the line's own quoting survives.
        (comspec, vec!["/D".into(), "/S".into(), "/C".into(), format!("\"{command}\"")])
    } else {
        (ide_terminal::default_shell_path(), vec!["-l".into(), "-c".into(), command.into()])
    }
}

async fn read_into(mut pipe: impl tokio::io::AsyncRead + Unpin, buf: Arc<Mutex<(Vec<u8>, bool)>>) {
    let mut chunk = [0u8; 8192];
    while let Ok(n) = pipe.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        let mut b = buf.lock();
        let room = MAX_CAPTURE_BYTES.saturating_sub(b.0.len());
        if room < n {
            b.1 = true;
        }
        let take = n.min(room);
        b.0.extend_from_slice(&chunk[..take]);
    }
}

/// Runs `program` in `cwd` with the IDE's child-process environment, stdout and stderr
/// combined; kills the process tree on timeout or cancellation.
pub(crate) async fn run_process(
    program: &str,
    args: &[String],
    raw_args: bool,
    cwd: &Path,
    limit: Duration,
    cancel: &ide_core::CancellationToken,
) -> IdeResult<CommandOutput> {
    let mut cmd = tokio::process::Command::new(program);
    if raw_args {
        #[cfg(windows)]
        for a in args {
            cmd.as_std_mut().raw_arg(a);
        }
        #[cfg(not(windows))]
        cmd.args(args);
    } else {
        cmd.args(args);
    }
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // What terminals and runs get: the login shell's variables this process lacks, the reloaded environment.
    cmd.envs(ide_core::process::shell_env());
    ide_core::process::prepare(cmd.as_std_mut());
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | ide_core::process::CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => IdeError::not_found(format!("command not found: {program}")),
        _ => IdeError::from(e),
    })?;
    let pid = child.id();
    let buf = Arc::new(Mutex::new((Vec::new(), false)));
    let mut out = tokio::spawn(read_into(child.stdout.take().expect("piped stdout"), buf.clone()));
    let mut err = tokio::spawn(read_into(child.stderr.take().expect("piped stderr"), buf.clone()));
    let mut timed_out = false;
    let mut cancelled = false;
    let status = tokio::select! {
        s = child.wait() => Some(s?),
        _ = tokio::time::sleep(limit) => { timed_out = true; None }
        _ = cancel.cancelled() => { cancelled = true; None }
    };
    let status = match status {
        Some(s) => Some(s),
        None => {
            if let Some(pid) = pid {
                kill_tree(pid);
            }
            let _ = child.kill().await;
            child.wait().await.ok()
        }
    };
    let _ = tokio::time::timeout(PIPE_DRAIN, futures::future::join(&mut out, &mut err)).await;
    out.abort();
    err.abort();
    if cancelled {
        return Err(IdeError::cancelled());
    }
    let (bytes, overflow) = std::mem::take(&mut *buf.lock());
    let code = if timed_out { None } else { status.and_then(|s| s.code()) };
    Ok(CommandOutput { text: String::from_utf8_lossy(&bytes).into_owned(), code, timed_out, overflow })
}

fn execute_terminal_command() -> Tool {
    Tool::new(
        "execute_terminal_command",
        McpToolKind::Execute,
        "Runs a command in the project root with the environment of the IDE's terminals and waits for it. Asks the \
user first unless brave mode is on. By default the command line goes to the user's login shell (`$SHELL -l -c`; \
`cmd /C` on Windows), so pipes, globs and `&&` work; `executeInShell: false` splits it into words and runs the \
program directly. stdout and stderr are combined. Not interactive: stdin is empty, so commands that prompt fail or \
wait. On `timeout` the whole process tree is killed and `timedOut: true` is returned. Long output keeps \
`maxLinesCount` lines: `truncateMode` START (default) cuts the beginning and keeps the end, END keeps the beginning, \
MIDDLE keeps both ends, NONE keeps everything; when cut, `fullOutputPath` names a file with all of it. Returns \
`exitCode`, `output` and, when cut, `omittedLines`. The command does not run in a visible terminal tab.",
        |call| async move {
            let command = call.str("command")?;
            if command.trim().is_empty() {
                return Err(IdeError::invalid("`command` is empty"));
            }
            let in_shell = call.flag("executeInShell", true)?;
            // Accepted for compatibility: commands never run in a terminal tab here.
            let _ = call.flag("reuseExistingTerminalWindow", false)?;
            let limit = timeout(&call, DEFAULT_TIMEOUT_MS, TERMINAL_MAX_TIMEOUT_MS)?;
            let max_lines = call.count("maxLinesCount", TERMINAL_DEFAULT_LINES, TERMINAL_MAX_LINES)?;
            let mode = Truncate::parse(call.opt_str("truncateMode")?.as_deref())?;
            let (program, args, raw) = if in_shell {
                let (program, args) = shell_argv(&command);
                (program, args, cfg!(windows))
            } else {
                let mut words = split_words(&command)?;
                if words.is_empty() {
                    return Err(IdeError::invalid("`command` is empty"));
                }
                let program = words.remove(0);
                (program, words, false)
            };
            let cwd = call.root().to_path_buf();
            call.confirm(command.trim(), Some(format!("in {}", cwd.display()))).await?;
            let out = run_process(&program, &args, raw, &cwd, limit, &call.cancel).await?;

            let (output, omitted) = truncate(&out.text, max_lines, mode);
            let mut result = Map::new();
            if let Some(code) = out.code {
                result.insert("exitCode".into(), code.into());
            }
            if out.timed_out {
                result.insert("timedOut".into(), true.into());
                result.insert(
                    "note".into(),
                    format!(
                        "The command did not finish within {} ms; it and its child processes were killed.",
                        limit.as_millis()
                    )
                    .into(),
                );
            } else if out.code.is_none() {
                result.insert("note".into(), "The command was ended by a signal.".into());
            }
            result.insert("output".into(), output.into());
            if omitted > 0 {
                result.insert("omittedLines".into(), omitted.into());
            }
            if out.overflow {
                result.insert("outputOverflow".into(), "output beyond 16 MB was discarded".into());
            }
            if omitted > 0 || out.overflow {
                let (path, mut file) = temp_output_file("terminal")?;
                file.write_all(out.text.as_bytes())?;
                result.insert("fullOutputPath".into(), path.to_string_lossy().into_owned().into());
            }
            Output::json(Value::Object(result))
        },
    )
    .param(Param::required("command", ParamType::String, "The command line to run"))
    .param(Param::optional(
        "executeInShell",
        ParamType::Boolean,
        "Run through the user's login shell (default true); false runs the program directly",
    ))
    .param(Param::optional(
        "reuseExistingTerminalWindow",
        ParamType::Boolean,
        "Ignored: commands never run in a terminal tab",
    ))
    .param(Param::optional(
        "timeout",
        ParamType::Integer,
        "Milliseconds before the command is killed (default 120000, at most 600000)",
    ))
    .param(Param::optional("maxLinesCount", ParamType::Integer, "Most output lines returned (default 2000)"))
    .param(Param::optional(
        "truncateMode",
        ParamType::Enum(&["START", "MIDDLE", "END", "NONE"]),
        "Which part of long output is cut: START (default, keeps the end), MIDDLE, END (keeps the beginning), NONE",
    ))
}

// ---------------------------------------------------------------- build

/// Request ids of the UI count up from 1; MCP builds use the upper half to stay apart.
fn next_request() -> RequestId {
    static NEXT: AtomicU32 = AtomicU32::new(0x8000_0000);
    RequestId(NEXT.fetch_add(1, Ordering::Relaxed))
}

fn problem(call: &Call, m: &ide_build::compile::BuildMessage) -> Value {
    let mut v = json!({
        "severity": serde_json::to_value(m.severity).unwrap_or(Value::Null),
        "message": m.text,
    });
    if let Some(path) = &m.path {
        v["filePath"] = call.display(path).into();
    }
    if let Some(range) = m.range {
        v["line"] = (range.start.line + 1).into();
        v["column"] = (range.start.col + 1).into();
    }
    if let Some(code) = &m.code {
        v["code"] = code.clone().into();
    }
    v
}

fn build_project() -> Tool {
    Tool::new(
        "build_project",
        McpToolKind::Execute,
        "Builds the project with its build system, like Build › Build Project: Maven (test-compile), Gradle, Cargo \
(cargo build), Go (go build) or TypeScript (tsc). `rebuild: true` cleans first. With `filesToRebuild`, builds the \
modules containing those files instead of the whole project. Asks the user first unless brave mode is on. Waits for \
the build and returns `success`, the error and warning counts and `problems` parsed from the compiler output \
(project-relative `filePath`, 1-based `line`/`column`); a failed build also returns the end of its console output. \
On `timeout` the build is stopped (`timedOut: true`).",
        |call| async move {
            let kind = if call.flag("rebuild", false)? { BuildKind::Rebuild } else { BuildKind::Build };
            let limit = timeout(&call, BUILD_DEFAULT_TIMEOUT_MS, BUILD_MAX_TIMEOUT_MS)?;
            let mut targets: Vec<Option<PathBuf>> = Vec::new();
            let mut dirs: Vec<PathBuf> = Vec::new();
            for f in call.str_list("filesToRebuild")?.iter().filter(|f| !f.trim().is_empty()) {
                let path = call.resolve(f)?;
                let dir = if path.is_dir() { path.clone() } else { path.parent().unwrap_or(&path).to_path_buf() };
                if !dirs.contains(&dir) {
                    dirs.push(dir);
                    targets.push(Some(path));
                }
            }
            if targets.is_empty() {
                targets.push(None);
            }
            let subject = if kind == BuildKind::Rebuild { "Rebuild project" } else { "Build project" };
            let detail = targets.iter().flatten().map(|p| call.display(p)).collect::<Vec<_>>().join(", ");
            call.confirm(subject, (!detail.is_empty()).then(|| format!("modules of {detail}"))).await?;

            let host = call.host();
            let console = Arc::new(Mutex::new(String::new()));
            let deadline = Instant::now() + limit;
            let mut results: Vec<BuildResult> = Vec::new();
            let mut timed_out = false;
            for target in targets {
                let request = next_request();
                let sink = console.clone();
                let channel = ide_host::ops::Channel::new(move |e: BuildEvent| match e {
                    BuildEvent::Output { text, .. } => sink.lock().push_str(&text),
                    BuildEvent::Step { command, .. } => sink.lock().push_str(&format!("$ {command}\n")),
                    _ => {}
                });
                let build =
                    ide_host::ops::build::build_run(&host, call.window(), kind, target, request, Vec::new(), channel);
                tokio::pin!(build);
                let remaining = deadline.saturating_duration_since(Instant::now());
                let outcome = tokio::select! {
                    r = &mut build => Some(r),
                    _ = tokio::time::sleep(remaining) => { timed_out = true; None }
                    _ = call.cancel.cancelled() => {
                        host.cancel_request(request);
                        let _ = build.await;
                        return Err(IdeError::cancelled());
                    }
                };
                match outcome {
                    Some(r) => results.push(r?),
                    None => {
                        host.cancel_request(request);
                        let _ = build.await;
                        break;
                    }
                }
                if results.last().is_some_and(|r| !r.success) {
                    break;
                }
            }
            let success = !timed_out && results.iter().all(|r| r.success);
            let messages: Vec<_> = results.iter().flat_map(|r| r.messages.iter()).collect();
            let mut result = Map::new();
            result.insert("success".into(), success.into());
            if timed_out {
                result.insert("timedOut".into(), true.into());
            }
            if let Some(first) = results.first() {
                result.insert("buildSystem".into(), serde_json::to_value(first.system).unwrap_or(Value::Null));
            }
            result.insert("errors".into(), results.iter().map(|r| r.errors).sum::<u32>().into());
            result.insert("warnings".into(), results.iter().map(|r| r.warnings).sum::<u32>().into());
            result.insert(
                "durationMs".into(),
                (results.iter().map(|r| r.duration_ms).sum::<f64>().round() as u64).into(),
            );
            result.insert(
                "problems".into(),
                messages.iter().take(BUILD_MAX_PROBLEMS).map(|m| problem(&call, m)).collect::<Vec<_>>().into(),
            );
            if messages.len() > BUILD_MAX_PROBLEMS {
                result.insert("omittedProblems".into(), (messages.len() - BUILD_MAX_PROBLEMS).into());
            }
            if !success {
                let (tail, _) = truncate(&console.lock(), RUN_OUTPUT_LINES, Truncate::Start);
                result.insert("output".into(), tail.into());
            }
            Output::json(Value::Object(result))
        },
    )
    .param(Param::optional(
        "filesToRebuild",
        ParamType::StringList,
        "Files (or folders) whose modules to build instead of the whole project",
    ))
    .param(Param::optional("rebuild", ParamType::Boolean, "Clean before building (default false)"))
    .param(Param::optional(
        "timeout",
        ParamType::Integer,
        "Milliseconds before the build is stopped (default 600000, at most 3600000)",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_by_mode() {
        let text = "1\n2\n3\n4\n5\n";
        assert_eq!(truncate(text, 10, Truncate::Start), ("1\n2\n3\n4\n5".into(), 0));
        assert_eq!(truncate(text, 2, Truncate::Start), ("… 3 lines omitted …\n4\n5".into(), 3));
        assert_eq!(truncate(text, 2, Truncate::End), ("1\n2\n… 3 lines omitted …".into(), 3));
        assert_eq!(truncate(text, 3, Truncate::Middle), ("1\n… 2 lines omitted …\n4\n5".into(), 2));
        assert_eq!(truncate(text, 1, Truncate::None).1, 0);
        assert_eq!(truncate("", 5, Truncate::Start), (String::new(), 0));
    }

    #[test]
    fn splits_words_like_a_shell() {
        assert_eq!(split_words(r#"a  'b c' "d \"e\"" f\ g"#).unwrap(), ["a", "b c", "d \"e\"", "f g"]);
        assert_eq!(split_words("x ''").unwrap(), ["x", ""]);
        assert!(split_words("'open").is_err());
    }

    #[test]
    fn overrides_keep_clear_and_merge() {
        let mut c = RunConfig {
            id: "user:x".into(),
            name: "x".into(),
            kind: "shell".into(),
            command: "prog".into(),
            args: vec!["a".into()],
            cwd: Some(PathBuf::from("sub").into()),
            env: [("A".to_owned(), "1".to_owned()), ("B".to_owned(), "2".to_owned())].into(),
            detected: false,
            is_test: false,
            debug_adapter: None,
            allow_parallel: false,
            extras: Default::default(),
        };
        let root = Path::new("/");
        apply_overrides(&mut c, root, Some(String::new()), None, vec![]).unwrap();
        assert_eq!(c.args, ["a"]);
        apply_overrides(
            &mut c,
            root,
            Some("x 'y z'".into()),
            Some("  ".into()),
            vec![("B".into(), " ".into()), ("C".into(), "3".into())],
        )
        .unwrap();
        assert_eq!(c.args, ["x", "y z"]);
        assert!(c.cwd.is_none());
        assert_eq!(c.env.keys().collect::<Vec<_>>(), ["A", "C"]);
        apply_overrides(&mut c, root, Some(" ".into()), None, vec![]).unwrap();
        assert!(c.args.is_empty());
    }
}
