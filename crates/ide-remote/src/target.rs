//! Run configurations on a run target: the project is synchronised to the
//! target's folder, then the command runs there over SSH with local paths and
//! interpreters swapped for their remote counterparts.

use ide_core::remote_settings::RunTarget;
use ide_core::{CancellationToken, IdeError, IdeEvent, IdeResult, RunId, SharedSink};
use ide_run::{OutputChunk, RunConfig, RunInfo};
use ide_ssh::sftp::join;
use ide_ssh::{Output, RemoteProcess, Session, Sig};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

type OutputFn = Arc<dyn Fn(OutputChunk) + Send + Sync>;
/// Uploads local changes before the run; reports progress lines.
pub type SyncFn = Box<dyn FnOnce(OutputFn) -> Pin<Box<dyn Future<Output = IdeResult<()>> + Send>> + Send>;

/// The remote program, arguments, folder and environment of a configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    /// A whole shell command line (configurations with a command and no arguments).
    pub shell_line: Option<String>,
}

impl RemoteCommand {
    pub fn line(&self) -> String {
        match &self.shell_line {
            Some(line) => {
                let exports: String = self
                    .env
                    .iter()
                    .map(|(k, v)| format!("export {}; ", ide_ssh::shell::quote(&format!("{k}={v}"))))
                    .collect();
                format!("cd {} && {exports}{line}", ide_ssh::shell::quote(&self.cwd))
            }
            None => ide_ssh::shell::command_line(Some(&self.cwd), &self.env, &self.program, &self.args),
        }
    }

    /// The echoed command line.
    pub fn display(&self) -> String {
        match &self.shell_line {
            Some(line) => line.clone(),
            None => std::iter::once(self.program.as_str())
                .chain(self.args.iter().map(String::as_str))
                .map(ide_ssh::shell::quote)
                .collect::<Vec<_>>()
                .join(" "),
        }
    }
}

/// `s` with the path `root` replaced by `remote` where it appears as a whole path
/// (followed by a separator or the end of a path), not as the prefix of a longer name.
/// The rest of a Windows path after the root takes `/` separators too.
fn replace_root(s: &str, root: &str, remote: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(root) {
        let mut after = &rest[i + root.len()..];
        let whole = after.chars().next().is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '_' | '-' | '.')));
        out.push_str(&rest[..i]);
        if whole {
            out.push_str(remote);
            if root.contains('\\') {
                let end = after
                    .find(|c: char| c.is_whitespace() || matches!(c, ';' | ',' | '"' | '\''))
                    .unwrap_or(after.len());
                out.push_str(&after[..end].replace('\\', "/"));
                after = &after[end..];
            }
        } else {
            out.push_str(root);
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

fn file_name(program: &str) -> &str {
    program.rsplit(['/', '\\']).next().unwrap_or(program)
}

/// The target's interpreter for a local interpreter executable, if it is one.
fn interpreter<'a>(program: &str, target: &'a RunTarget) -> Option<&'a str> {
    let name = file_name(program).trim_end_matches(".exe").to_ascii_lowercase();
    let pick = |configured: &'a str, default: &'a str| {
        Some(if configured.trim().is_empty() { default } else { configured.trim() })
    };
    if name == "python" || name.starts_with("python3") || name == "python2" {
        pick(&target.python, "python3")
    } else if name == "node" {
        pick(&target.node, "node")
    } else if name == "java" {
        pick(&target.java, "java")
    } else {
        None
    }
}

/// Builds the remote command of `config`; `root` (the project) maps onto `remote_root`.
pub fn remote_command(config: &RunConfig, target: &RunTarget, root: &Path, remote_root: &str) -> RemoteCommand {
    target_command(config, target, root, remote_root, true)
}

/// Maps paths and interpreters while preserving argv, including a command containing spaces.
/// Unlike SSH/container shell configurations, plugin wrappers never accept a shell line.
pub fn argv_command(config: &RunConfig, target: &RunTarget, root: &Path, remote_root: &str) -> RemoteCommand {
    target_command(config, target, root, remote_root, false)
}

/// `java` flags whose value is a path list that may point outside the project
/// (`~/.m2` jars, `--module-path` entries): deployment sync only uploads the
/// project root, so these entries need their own sync + rewrite (#2641).
const PATH_LIST_FLAGS: [&str; 6] =
    ["-cp", "-classpath", "--class-path", "-p", "--module-path", "--upgrade-module-path"];

/// The separator of a `-cp` value on this (client) machine.
pub fn classpath_separator() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

fn split_path_list(value: &str) -> Vec<&str> {
    value.split(classpath_separator()).filter(|e| !e.is_empty()).collect()
}

/// Absolute classpath entries of `args` that live outside the project root.
/// Unresolved placeholders (`${…}`), wildcards and relative entries pass through:
///
/// callers map the project root already, and only concrete local files can be synced.
pub fn external_classpath_entries(args: &[String], root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if PATH_LIST_FLAGS.contains(&args[i].as_str()) && i + 1 < args.len() {
            let value = &args[i + 1];
            if !value.contains("${") {
                for entry in split_path_list(value) {
                    if entry.contains('*') {
                        continue;
                    }
                    let path = PathBuf::from(entry);
                    if path.is_absolute() && !path.starts_with(root) && !out.contains(&path) {
                        out.push(path);
                    }
                }
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    out
}

/// The remote home of an outside-root dependency: mirrored under `.remote-libs`
/// (never `.openidea*`: deployment excludes those names), so the layout stays
/// debuggable and collision-free per client machine.
pub fn external_lib_remote(remote_root: &str, local: &Path) -> String {
    let spelling = local.to_string_lossy().replace('\\', "/");
    let stripped = spelling.trim_start_matches('/').replace(':', "");
    join(remote_root.trim_end_matches('/'), &format!(".remote-libs/{stripped}"))
}

/// Rewrites the outside-root classpath entries of `args` onto their synced remote
/// copies; returns the new args and the (local entry, remote base) pairs to upload.
/// Entries inside the project root are untouched: `target_command` maps those.
pub fn rewrite_external_classpath(
    args: &[String],
    root: &Path,
    remote_root: &str,
) -> (Vec<String>, Vec<(PathBuf, String)>) {
    let mut table: Vec<(PathBuf, String)> = Vec::new();
    let mut out = args.to_vec();
    let mut i = 0;
    while i < out.len() {
        if PATH_LIST_FLAGS.contains(&out[i].as_str()) && i + 1 < out.len() {
            let value = out[i + 1].clone();
            if !value.contains("${") {
                let mut rewritten = Vec::new();
                let mut changed = false;
                for entry in split_path_list(&value) {
                    let path = PathBuf::from(entry);
                    if !entry.contains('*') && path.is_absolute() && !path.starts_with(root) {
                        let remote = match table.iter().find(|(p, _)| p == &path) {
                            Some((_, r)) => r.clone(),
                            None => {
                                let r = external_lib_remote(remote_root, &path);
                                table.push((path, r.clone()));
                                r
                            }
                        };
                        rewritten.push(remote);
                        changed = true;
                    } else {
                        rewritten.push(entry.to_owned());
                    }
                }
                if changed {
                    out[i + 1] = rewritten.join(&classpath_separator().to_string());
                }
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    (out, table)
}

fn target_command(
    config: &RunConfig,
    target: &RunTarget,
    root: &Path,
    remote_root: &str,
    allow_shell: bool,
) -> RemoteCommand {
    let root_str = root.to_string_lossy().into_owned();
    let map = |s: &str| -> String {
        if root_str.is_empty() {
            return s.to_owned();
        }
        replace_root(s, &root_str, remote_root.trim_end_matches('/')).replace('\\', "/")
    };
    let map_text = |s: &str| -> String {
        if root_str.is_empty() { s.to_owned() } else { replace_root(s, &root_str, remote_root.trim_end_matches('/')) }
    };
    let cwd = match config.cwd.as_ref().map(|p| p.to_path_buf()) {
        Some(dir) if dir.is_absolute() => match dir.strip_prefix(root) {
            Ok(rel) => join(remote_root, &crate::mapping::posix(rel)),
            Err(_) => remote_root.to_owned(),
        },
        Some(dir) if !dir.as_os_str().is_empty() => join(remote_root, &crate::mapping::posix(&dir)),
        _ => remote_root.to_owned(),
    };
    let env = config.env.iter().map(|(k, v)| (k.clone(), map_text(v))).collect();
    let command = config.command.trim();
    if allow_shell && config.args.is_empty() && command.contains(char::is_whitespace) {
        return RemoteCommand {
            program: String::new(),
            args: Vec::new(),
            cwd,
            env,
            shell_line: Some(map_text(command)),
        };
    }
    let program = match interpreter(command, target) {
        Some(remote) => remote.to_owned(),
        None if Path::new(command).is_absolute() && Path::new(command).starts_with(root) => map(command),
        None if Path::new(command).is_absolute() => file_name(command).to_owned(),
        None => command.to_owned(),
    };
    let args = config.args.iter().map(|a| map_text(a)).collect();
    RemoteCommand { program, args, cwd, env, shell_line: None }
}

/// How long Stop waits for the channel to close after `KILL`.
const KILL_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

struct RemoteRun {
    info: Mutex<RunInfo>,
    process: Mutex<Option<Arc<RemoteProcess>>>,
    cancel: CancellationToken,
    /// Stop gave up waiting for the channel to report the exit: the run finishes locally.
    abandon: CancellationToken,
    stopping: AtomicBool,
    /// The runtime it started on: stdin / stop requests may come from threads without one.
    runtime: tokio::runtime::Handle,
}

/// Runs on run targets, alongside the local `ide_run::ProcessManager`.
#[derive(Default)]
pub struct RemoteRuns {
    runs: Arc<Mutex<BTreeMap<RunId, Arc<RemoteRun>>>>,
}

pub struct RemoteStart {
    pub session: Arc<Session>,
    pub target: RunTarget,
    pub root: std::path::PathBuf,
    /// The target's project folder, resolved on the host.
    pub remote_root: String,
    /// Uploads local changes first (`sync_before_run`).
    pub sync: Option<SyncFn>,
}

impl RemoteRuns {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn contains(&self, id: RunId) -> bool {
        self.runs.lock().contains_key(&id)
    }

    pub fn list(&self) -> Vec<RunInfo> {
        self.runs.lock().values().map(|r| r.info.lock().clone()).collect()
    }

    /// Starts `config` on the target; returns at once (synchronisation and the
    /// remote process follow in the background, reported as output).
    pub fn start(
        &self,
        start: RemoteStart,
        config: &RunConfig,
        sink: SharedSink,
        on_output: Box<dyn Fn(OutputChunk) + Send + Sync>,
    ) -> RunInfo {
        let id = RunId::next();
        let pty = config.extras.emulate_terminal;
        let info =
            RunInfo { id, config_id: config.id.clone(), name: config.name.clone(), pid: None, running: true, pty };
        let run = Arc::new(RemoteRun {
            info: Mutex::new(info.clone()),
            process: Mutex::new(None),
            cancel: CancellationToken::new(),
            abandon: CancellationToken::new(),
            stopping: AtomicBool::new(false),
            runtime: tokio::runtime::Handle::current(),
        });
        self.runs.lock().insert(id, run.clone());
        let on_output: OutputFn = Arc::from(on_output);
        let command = remote_command(config, &start.target, &start.root, &start.remote_root);
        tokio::spawn(async move {
            let code = run_remote(&run, start, command, pty, on_output.clone()).await;
            let message = match &code {
                Ok(Some(c)) => format!("Process finished with exit code {c}"),
                Ok(None) if run.stopping.load(Ordering::Acquire) => "Process finished (stopped)".to_owned(),
                Ok(None) => "Process finished".to_owned(),
                Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => "Process finished (stopped)".to_owned(),
                Err(e) => format!("Cannot run on the target: {}", e.message),
            };
            on_output(OutputChunk::System { text: format!("\n{message}\n") });
            run.info.lock().running = false;
            run.process.lock().take();
            let code = code.ok().flatten().and_then(|c| i32::try_from(c).ok());
            sink.emit(IdeEvent::RunExited { run: id, code });
        });
        info
    }

    pub fn write_stdin(&self, id: RunId, data: &str) -> IdeResult<()> {
        let (process, rt) = self.process(id)?;
        let data = data.as_bytes().to_vec();
        rt.spawn(async move { process.write(&data).await });
        Ok(())
    }

    pub fn close_stdin(&self, id: RunId) -> IdeResult<()> {
        let (process, rt) = self.process(id)?;
        rt.spawn(async move { process.eof().await });
        Ok(())
    }

    pub fn resize(&self, id: RunId, cols: u16, rows: u16) -> IdeResult<()> {
        let (process, rt) = self.process(id)?;
        rt.spawn(async move { process.resize(cols, rows).await });
        Ok(())
    }

    /// `INT`, then `KILL` (closing the channel) after `grace`; a channel that still reports no
    /// exit after another [`KILL_WAIT`] is left behind and the run finishes as stopped.
    pub fn stop(&self, id: RunId, grace: std::time::Duration) -> IdeResult<()> {
        let run =
            self.runs.lock().get(&id).cloned().ok_or_else(|| IdeError::not_found(format!("no such run: {id}")))?;
        run.stopping.store(true, Ordering::Release);
        run.cancel.cancel();
        let Some(process) = run.process.lock().clone() else { return Ok(()) };
        let rt = run.runtime.clone();
        rt.spawn(async move {
            let _ = process.signal(Sig::INT).await;
            tokio::time::sleep(grace).await;
            if run.info.lock().running {
                let _ = process.signal(Sig::KILL).await;
                tokio::time::sleep(KILL_WAIT).await;
                run.abandon.cancel();
            }
        });
        Ok(())
    }

    fn process(&self, id: RunId) -> IdeResult<(Arc<RemoteProcess>, tokio::runtime::Handle)> {
        let run =
            self.runs.lock().get(&id).cloned().ok_or_else(|| IdeError::not_found(format!("no such run: {id}")))?;
        let process = run.process.lock().clone();
        let process = process.ok_or_else(|| IdeError::unavailable("the remote process has not started yet"))?;
        Ok((process, run.runtime.clone()))
    }
}

async fn run_remote(
    run: &RemoteRun,
    start: RemoteStart,
    command: RemoteCommand,
    pty: bool,
    on_output: OutputFn,
) -> IdeResult<Option<u32>> {
    on_output(OutputChunk::System { text: format!("[{}] {}\n", start.target.name, start.session.label()) });
    if let Some(sync) = start.sync {
        tokio::select! {
            r = sync(on_output.clone()) => r?,
            _ = run.cancel.cancelled() => return Err(IdeError::cancelled()),
        }
    }
    if run.cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    on_output(OutputChunk::System { text: format!("{}\n", command.display()) });
    let out = on_output.clone();
    let process = start
        .session
        .spawn(
            &command.line(),
            pty.then_some((120, 30)),
            Box::new(move |chunk| match chunk {
                Output::Stdout(b) => out(OutputChunk::Stdout { text: String::from_utf8_lossy(b).into_owned() }),
                Output::Stderr(b) => out(OutputChunk::Stderr { text: String::from_utf8_lossy(b).into_owned() }),
            }),
        )
        .await?;
    let process = Arc::new(process);
    *run.process.lock() = Some(process.clone());
    tokio::select! {
        code = process.wait() => Ok(code),
        _ = run.abandon.cancelled() => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn config(command: &str, args: &[&str], cwd: Option<&str>) -> RunConfig {
        RunConfig {
            id: "c".into(),
            name: "c".into(),
            kind: "python".into(),
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: cwd.map(|c| ide_core::IpcPath::from(std::path::PathBuf::from(c))),
            env: BTreeMap::from([("DATA".to_owned(), "/work/proj/data".to_owned())]),
            detected: false,
            is_test: false,
            debug_adapter: None,
            allow_parallel: false,
            extras: Default::default(),
        }
    }

    // Unix paths are not absolute on Windows (`tests/remote.rs` runs there).
    #[cfg(unix)]
    #[test]
    fn maps_interpreters_paths_and_folders() {
        let target = RunTarget { python: "/opt/py/bin/python".into(), ..Default::default() };
        let root = Path::new("/work/proj");
        let c = remote_command(
            &config("/work/proj/.venv/bin/python", &["-u", "/work/proj/src/main.py"], Some("/work/proj/src")),
            &target,
            root,
            "/home/me/proj",
        );
        assert_eq!(c.program, "/opt/py/bin/python");
        assert_eq!(c.args, ["-u", "/home/me/proj/src/main.py"]);
        assert_eq!(c.cwd, "/home/me/proj/src");
        assert_eq!(c.env["DATA"], "/home/me/proj/data");
        assert_eq!(
            c.line(),
            "cd /home/me/proj/src && exec env DATA=/home/me/proj/data /opt/py/bin/python -u /home/me/proj/src/main.py"
        );

        let c = remote_command(&config("npm run dev", &[], None), &target, root, "/home/me/proj");
        assert_eq!(c.line(), "cd /home/me/proj && export DATA=/home/me/proj/data; npm run dev");
        let c = remote_command(&config("/usr/local/bin/node", &["app.js"], None), &RunTarget::default(), root, "/srv");
        assert_eq!((c.program.as_str(), c.cwd.as_str()), ("node", "/srv"));
        let c = remote_command(&config("/usr/bin/make", &["test"], None), &RunTarget::default(), root, "/srv");
        assert_eq!(c.program, "make");
    }

    #[test]
    fn maps_the_root_only_as_a_whole_path() {
        assert_eq!(replace_root("/work/proj2/x:/work/proj/y", "/work/proj", "/srv"), "/work/proj2/x:/srv/y");
        assert_eq!(replace_root("/work/proj", "/work/proj", "/srv"), "/srv");
        assert_eq!(replace_root(r"C:\p\src/a.py C:\p2", r"C:\p", "/srv"), r"/srv/src/a.py C:\p2");
    }

    /// Unix/Windows spellings of the same layout: one inside-root entry, one
    /// `~/.m2` jar twice, a placeholder value, a wildcard and a module path.
    fn classpath_fixture() -> (PathBuf, Vec<String>, String, String) {
        let (root, classes, m2) = if cfg!(windows) {
            (r"C:\proj", r"C:\proj\target\classes", r"C:\Users\me\.m2\a.jar")
        } else {
            ("/proj", "/proj/target/classes", "/home/me/.m2/a.jar")
        };
        let sep = classpath_separator();
        let args = vec![
            "-cp".to_owned(),
            format!("{classes}{sep}{m2}{sep}{m2}"),
            "-p".to_owned(),
            m2.to_owned(),
            "-cp".to_owned(),
            "${classpath}".to_owned(),
            "-cp".to_owned(),
            "/elsewhere/lib/*".to_owned(),
        ];
        (PathBuf::from(root), args, m2.to_owned(), classes.to_owned())
    }

    #[test]
    fn collects_outside_root_classpath_entries_once() {
        let (root, args, m2, _) = classpath_fixture();
        let entries = external_classpath_entries(&args, &root);
        assert_eq!(entries, vec![PathBuf::from(m2)]);
    }

    #[test]
    fn rewrites_outside_root_entries_onto_remote_lib_copies() {
        let (root, args, m2, classes) = classpath_fixture();
        let (rewritten, table) = rewrite_external_classpath(&args, &root, "/srv/app");
        let remote = if cfg!(windows) {
            "/srv/app/.remote-libs/C/Users/me/.m2/a.jar".to_owned()
        } else {
            "/srv/app/.remote-libs/home/me/.m2/a.jar".to_owned()
        };
        assert_eq!(table, vec![(PathBuf::from(m2), remote.clone())]);
        let sep = classpath_separator();
        assert_eq!(rewritten[1], format!("{classes}{sep}{remote}{sep}{remote}"));
        assert_eq!(rewritten[3], remote);
        // Placeholders and wildcards pass through untouched.
        assert_eq!(rewritten[5], "${classpath}");
        assert_eq!(rewritten[7], "/elsewhere/lib/*");
    }
}
