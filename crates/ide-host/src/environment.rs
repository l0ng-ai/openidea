//! The environment child processes get beyond this process's own: the login shell's as
//! re-read by Reload Environment, and (remote server) the project's
//! `devcontainer.json` `remoteEnv`, plus its `postStartCommand` once per server start.
//!
//! Both reach every child through `ide_core::process::set_env_overlay`: terminals, runs,
//! language servers, debug adapters, build tools and git all spawn through
//! `ide_core::process::prepare` / `host_env`.

use ide_core::event::NotifyLevel;
use ide_core::{CancellationToken, IdeError, IdeEvent, IdeResult, SharedSink, TaskId};
use ide_workspace::devcontainer::{self, LifecycleCommand};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeSet, HashSet};
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

type Changes = Vec<(OsString, Option<OsString>)>;

/// What Reload Environment changed.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnvReloaded {
    /// Names of the variables new child processes now get differently (added, changed or removed).
    pub changed: Vec<String>,
    /// The `devcontainer.json` whose `remoteEnv` applies, if any.
    pub devcontainer: Option<String>,
    /// Whether the login shell was read (it isn't on Windows).
    pub shell_read: bool,
}

#[derive(Default)]
struct State {
    /// The login shell's environment when this process started (before the first reload).
    baseline: Option<Vec<(OsString, OsString)>>,
    /// The login shell's changes since this process started (Reload Environment).
    login: Changes,
    /// The open project's `remoteEnv`.
    project: Changes,
    /// Project roots whose `postStartCommand` ran in this process.
    post_started: HashSet<PathBuf>,
}

pub struct Environment {
    /// Whether the open project's `devcontainer.json` applies (the remote server: one project per process).
    project_env: bool,
    data_dir: PathBuf,
    state: Mutex<State>,
    /// Stops running `postStartCommand`s when the host shuts down.
    cancel: CancellationToken,
}

impl Environment {
    pub(crate) fn new(project_env: bool, data_dir: PathBuf) -> Self {
        Self { project_env, data_dir, state: Mutex::default(), cancel: CancellationToken::new() }
    }

    pub(crate) fn shutdown(&self) {
        self.cancel.cancel();
    }

    /// A project opened at `root`: applies its `remoteEnv` and returns its `postStartCommand`
    /// when it hasn't run in this process yet. Problems with the file are notified, not errors.
    pub(crate) fn project_opened(&self, root: &Path, sink: &SharedSink) -> Option<LifecycleCommand> {
        if !self.project_env {
            return None;
        }
        let config = self.load_project(root, sink);
        let post_start = config.and_then(|c| c.post_start);
        let first = self.state.lock().post_started.insert(root.to_path_buf());
        post_start.filter(|_| first)
    }

    pub(crate) fn project_closed(&self) {
        if self.project_env {
            self.state.lock().project.clear();
            self.publish();
        }
    }

    /// Reads `root`'s `devcontainer.json` and applies its `remoteEnv` (none: clears it).
    fn load_project(&self, root: &Path, sink: &SharedSink) -> Option<devcontainer::DevContainer> {
        let config = match devcontainer::load(root) {
            Ok(c) => c,
            Err(e) => {
                sink.emit(IdeEvent::Notify {
                    level: NotifyLevel::Warning,
                    title: "devcontainer.json was not applied".into(),
                    body: Some(e),
                });
                None
            }
        };
        let login = self.state.lock().login.clone();
        let project = config.as_ref().map(|c| project_changes(c, root, &login)).unwrap_or_default();
        self.state.lock().project = project;
        self.publish();
        config
    }

    fn publish(&self) {
        let state = self.state.lock();
        ide_core::process::set_env_overlay(merge(&state.login, &state.project));
    }

    /// Reload Environment: reads the login shell again and re-applies the project's
    /// `remoteEnv` (`root`). Blocking (it runs the shell); children already running keep
    /// their environment.
    pub fn reload(&self, root: Option<&Path>, sink: &SharedSink) -> IdeResult<EnvReloaded> {
        let before: Vec<_> = ide_core::process::host_vars().collect();
        let fresh = crate::shell_env::read_login_env_now().map_err(IdeError::unavailable)?;
        let shell_read = fresh.is_some();
        if let Some(fresh) = fresh {
            let old = {
                let mut state = self.state.lock();
                let baseline = state
                    .baseline
                    .get_or_insert_with(|| ide_core::process::login_env().map(|v| v.to_vec()).unwrap_or_default());
                baseline.clone()
            };
            let login = login_changes(&|k| std::env::var_os(k), &old, &fresh, &|path| {
                ide_tools::path_with_tools(&self.data_dir, path)
            });
            ide_core::process::set_shell_env(fresh);
            self.state.lock().login = login;
        }
        let devcontainer = match root.filter(|_| self.project_env) {
            Some(root) => self.load_project(root, sink).map(|c| c.path.to_string_lossy().into_owned()),
            None => {
                self.publish();
                None
            }
        };
        let after: Vec<_> = ide_core::process::host_vars().collect();
        Ok(EnvReloaded { changed: changed_names(&before, &after), devcontainer, shell_read })
    }

    /// Runs `cmd` (a `postStartCommand`) in `root` on its own thread, as a background task;
    /// a failure is a notification.
    pub(crate) fn spawn_post_start(&self, cmd: LifecycleCommand, root: PathBuf, sink: SharedSink) {
        let cancel = self.cancel.child_token();
        let spawned = std::thread::Builder::new().name("openidea-post-start".into()).spawn(move || {
            run_post_start(&cmd, &root, &sink, &cancel);
        });
        if let Err(e) = spawned {
            tracing::warn!("postStartCommand: {e}");
        }
    }
}

/// `project` after `login`; one entry per name, the later one winning.
fn merge(login: &Changes, project: &Changes) -> Changes {
    let mut out: Changes = login.iter().filter(|(k, _)| !project.iter().any(|(p, _)| p == k)).cloned().collect();
    out.extend(project.iter().cloned());
    out
}

/// What children need on top of this process's environment (`process`) to see the login
/// shell's `fresh` one: changed and new variables, and those `old` (the shell at startup)
/// had that it no longer sets, when this process took them from it. `PATH` gets the
/// managed tool folders (`with_tools`) as at startup.
fn login_changes(
    process: &dyn Fn(&OsStr) -> Option<OsString>,
    old: &[(OsString, OsString)],
    fresh: &[(OsString, OsString)],
    with_tools: &dyn Fn(&OsStr) -> OsString,
) -> Changes {
    let effective = |k: &OsStr, v: &OsStr| if k == "PATH" { with_tools(v) } else { v.to_owned() };
    let mut out = Changes::new();
    for (k, v) in fresh {
        let v = effective(k, v);
        if process(k).as_ref() != Some(&v) {
            out.push((k.clone(), Some(v)));
        }
    }
    for (k, v) in old {
        if !fresh.iter().any(|(f, _)| f == k) && process(k) == Some(effective(k, v)) {
            out.push((k.clone(), None));
        }
    }
    out
}

/// `remoteEnv` resolved against the environment before it (this process's plus `login`).
fn project_changes(config: &devcontainer::DevContainer, root: &Path, login: &Changes) -> Changes {
    let lookup = |name: &str| -> Option<String> {
        match login.iter().find(|(k, _)| k == name) {
            Some((_, v)) => v.as_ref().map(|v| v.to_string_lossy().into_owned()),
            None => std::env::var_os(name).map(|v| v.to_string_lossy().into_owned()),
        }
    };
    devcontainer::resolve_env(config, root, &lookup).into_iter().map(|(k, v)| (k.into(), v.map(Into::into))).collect()
}

fn changed_names(before: &[(OsString, OsString)], after: &[(OsString, OsString)]) -> Vec<String> {
    let get = |vars: &[(OsString, OsString)], k: &OsString| vars.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let names: BTreeSet<&OsString> = before.iter().chain(after).map(|(k, _)| k).collect();
    names.into_iter().filter(|k| get(before, k) != get(after, k)).map(|k| k.to_string_lossy().into_owned()).collect()
}

/// Output lines kept for the failure notification.
const TAIL_LINES: usize = 20;
const TITLE: &str = "postStartCommand";

/// Runs a `postStartCommand` to the end (each of an object's commands in parallel),
/// reporting progress as a background task and a failure as an error notification.
fn run_post_start(cmd: &LifecycleCommand, root: &Path, sink: &SharedSink, cancel: &CancellationToken) {
    let task = TaskId::next();
    let _cancel_handle = ide_core::task::on_cancel(task, {
        let cancel = cancel.clone();
        move || cancel.cancel()
    });
    let progress = |message: Option<String>, done: bool| {
        sink.emit(IdeEvent::Task { id: task, title: TITLE.into(), message, fraction: None, done, cancellable: !done });
    };
    progress(Some("Starting…".into()), false);
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let on_line = |name: Option<&str>, line: String| {
        tracing::info!(target: "post_start", "{}{line}", name.map(|n| format!("[{n}] ")).unwrap_or_default());
        progress(Some(line.clone()), false);
        let mut tail = tail.lock();
        tail.push(match name {
            Some(n) => format!("[{n}] {line}"),
            None => line,
        });
        let excess = tail.len().saturating_sub(TAIL_LINES);
        tail.drain(..excess);
    };
    let failures: Vec<String> = std::thread::scope(|scope| {
        let runs: Vec<_> = cmd
            .commands()
            .into_iter()
            .map(|(name, c)| {
                let on_line = &on_line;
                scope.spawn(move || {
                    let argv = c.argv().unwrap_or_default();
                    run_one(&argv, root, cancel, &|line| on_line(name, line))
                        .err()
                        .map(|e| name.map_or_else(|| e.clone(), |n| format!("{n}: {e}")))
                })
            })
            .collect();
        runs.into_iter().filter_map(|r| r.join().unwrap_or_else(|_| Some("panicked".into()))).collect()
    });
    progress(None, true);
    if failures.is_empty() || cancel.is_cancelled() {
        return;
    }
    let tail = tail.lock().join("\n");
    let body = if tail.is_empty() { failures.join("\n") } else { format!("{}\n\n{tail}", failures.join("\n")) };
    sink.emit(IdeEvent::Notify {
        level: NotifyLevel::Error,
        title: "postStartCommand failed".into(),
        body: Some(body),
    });
}

/// Runs `argv` in `root` with the children's environment, its stdout and stderr line by line
/// to `on_line`; `Err` says how it failed.
fn run_one(argv: &[String], root: &Path, cancel: &CancellationToken, on_line: &dyn Fn(String)) -> Result<(), String> {
    let (program, args) = argv.split_first().ok_or("empty command")?;
    let mut child = ide_core::process::prepare(&mut Command::new(program))
        .args(args)
        .current_dir(root)
        .envs(ide_core::process::shell_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start {program}: {e}"))?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let pipes: [Option<Box<dyn Read + Send>>; 2] = [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
    ];
    for pipe in pipes.into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    let status = loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => on_line(line),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break child.wait(),
        }
        if cancel.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        // A process it started in the background may keep the pipes open: the command is done.
        if let Ok(Some(status)) = child.try_wait() {
            let deadline = std::time::Instant::now() + Duration::from_secs(1);
            while let Ok(line) = rx.recv_timeout(Duration::from_millis(100)) {
                on_line(line);
                if std::time::Instant::now() > deadline {
                    break;
                }
            }
            break Ok(status);
        }
    }
    .map_err(|e| e.to_string())?;
    match status.code() {
        Some(0) => Ok(()),
        Some(code) => Err(format!("exited with code {code}")),
        None => Err("terminated by a signal".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::EventSink;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    fn change(k: &str, v: Option<&str>) -> (OsString, Option<OsString>) {
        (k.into(), v.map(Into::into))
    }

    #[test]
    fn reload_changes_are_relative_to_this_process() {
        // This process took the login shell's environment at startup (the server), PATH with tools.
        let process = vars(&[("PATH", "/tools:/a"), ("KEEP", "1"), ("EDITED", "old"), ("DROPPED", "x"), ("SSH", "s")]);
        let old = vars(&[("PATH", "/a"), ("KEEP", "1"), ("EDITED", "old"), ("DROPPED", "x")]);
        let fresh = vars(&[("PATH", "/b:/a"), ("KEEP", "1"), ("EDITED", "new"), ("ADDED", "y")]);
        let lookup = |k: &OsStr| process.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let with_tools = |p: &OsStr| {
            let mut s = OsString::from("/tools:");
            s.push(p);
            s
        };
        let got = login_changes(&lookup, &old, &fresh, &with_tools);
        assert_eq!(
            got,
            [
                change("PATH", Some("/tools:/b:/a")),
                change("EDITED", Some("new")),
                change("ADDED", Some("y")),
                change("DROPPED", None),
            ]
        );
        // Nothing changed: nothing to apply.
        assert!(login_changes(&lookup, &old, &old, &with_tools).is_empty());
    }

    #[test]
    fn variables_the_process_had_before_the_shell_stay() {
        // The desktop app: the shell had `FROM_LAUNCHD` with another value than the process.
        let process = vars(&[("FROM_LAUNCHD", "process")]);
        let lookup = |k: &OsStr| process.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let got = login_changes(&lookup, &vars(&[("FROM_LAUNCHD", "shell")]), &[], &|p| p.to_owned());
        assert!(got.is_empty(), "{got:?}");
    }

    #[test]
    fn project_variables_win_and_see_the_reloaded_login_values() {
        let login = vec![change("OPENIDEA_TEST_TOOLS", Some("/reloaded")), change("A", Some("login"))];
        let config = devcontainer::parse(
            r#"{ "remoteEnv": { "A": "project", "B": "${containerEnv:OPENIDEA_TEST_TOOLS}/bin" } }"#,
        )
        .unwrap();
        let project = project_changes(&config, Path::new("/p"), &login);
        assert_eq!(project, [change("A", Some("project")), change("B", Some("/reloaded/bin"))]);
        let merged = merge(&login, &project);
        assert_eq!(
            merged,
            [
                change("OPENIDEA_TEST_TOOLS", Some("/reloaded")),
                change("A", Some("project")),
                change("B", Some("/reloaded/bin"))
            ]
        );
    }

    #[test]
    fn changed_names_cover_added_edited_and_removed() {
        let before = vars(&[("A", "1"), ("B", "2"), ("C", "3")]);
        let after = vars(&[("A", "1"), ("B", "two"), ("D", "4")]);
        assert_eq!(changed_names(&before, &after), ["B", "C", "D"]);
    }

    // Used by the Unix-only post-start tests.
    #[cfg_attr(not(unix), allow(dead_code))]
    #[derive(Default)]
    struct Events(Mutex<Vec<IdeEvent>>);
    impl EventSink for Events {
        fn emit(&self, e: IdeEvent) {
            self.0.lock().push(e);
        }
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    fn run(cmd: LifecycleCommand, root: &Path) -> Vec<IdeEvent> {
        let events = Arc::new(Events::default());
        let sink: SharedSink = events.clone();
        run_post_start(&cmd, root, &sink, &CancellationToken::new());
        events.0.lock().clone()
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    fn failure(events: &[IdeEvent]) -> Option<String> {
        events.iter().find_map(|e| match e {
            IdeEvent::Notify { level: NotifyLevel::Error, body, .. } => body.clone(),
            _ => None,
        })
    }

    #[cfg(unix)]
    #[test]
    fn post_start_forms_run_in_the_project_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let events = run(LifecycleCommand::Shell("pwd > shell.txt; echo done".into()), root);
        assert!(failure(&events).is_none(), "{events:?}");
        let pwd = std::fs::read_to_string(root.join("shell.txt")).unwrap();
        assert_eq!(dunce::canonicalize(pwd.trim()).unwrap(), dunce::canonicalize(root).unwrap());
        let messages: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                IdeEvent::Task { message, done, .. } => Some((message.clone(), *done)),
                _ => None,
            })
            .collect();
        assert!(messages.contains(&(Some("done".into()), false)), "{messages:?}");
        assert_eq!(messages.last(), Some(&(None, true)));

        let exec = LifecycleCommand::Exec(vec!["touch".into(), "exec file.txt".into()]);
        assert!(failure(&run(exec, root)).is_none());
        assert!(root.join("exec file.txt").is_file(), "array form: no shell splitting");

        let parallel = LifecycleCommand::Parallel(vec![
            ("a".into(), LifecycleCommand::Shell("touch a.txt".into())),
            ("b".into(), LifecycleCommand::Exec(vec!["touch".into(), "b.txt".into()])),
        ]);
        assert!(failure(&run(parallel, root)).is_none());
        assert!(root.join("a.txt").is_file() && root.join("b.txt").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_post_start_is_notified_with_its_output() {
        let tmp = tempfile::tempdir().unwrap();
        let events = run(LifecycleCommand::Shell("echo starting; echo broken >&2; exit 3".into()), tmp.path());
        let body = failure(&events).expect("a failure notification");
        assert!(body.contains("exited with code 3"), "{body}");
        assert!(body.contains("starting") && body.contains("broken"), "{body}");
        assert!(matches!(events.last(), Some(IdeEvent::Notify { .. })));

        let parallel = LifecycleCommand::Parallel(vec![
            ("ok".into(), LifecycleCommand::Shell("true".into())),
            ("missing".into(), LifecycleCommand::Exec(vec!["openidea-no-such-program".into()])),
        ]);
        let body = failure(&run(parallel, tmp.path())).unwrap();
        assert!(body.starts_with("missing: cannot start openidea-no-such-program"), "{body}");
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_stops_a_running_post_start() {
        let tmp = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let started = std::time::Instant::now();
        let c = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            c.cancel();
        });
        let result = run_one(&["sleep".into(), "30".into()], tmp.path(), &cancel, &|_| {});
        assert_eq!(result, Err("cancelled".into()));
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
