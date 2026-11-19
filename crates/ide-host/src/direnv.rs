//! The project's direnv environment: when the project root has an `.envrc`, `direnv export
//! json` runs there and every child started in the project gets what it exports
//! ([`ide_core::project_env`]): terminals, runs, language servers (which wait for it), build
//! tools and debuggers, locally and on a remote host alike. An `.envrc` with `use flake`
//! loads a Nix flake's devshell this way.
//!
//! `.envrc` is project code: it runs in trusted projects only, and only once the user
//! allowed it with `direnv allow`, which the IDE never does for them.

use ide_core::event::DirenvStatus;
use ide_core::{CancellationToken, IdeEvent, SharedSink, TaskId};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

pub(crate) const ENVRC: &str = ".envrc";

/// Files in the project root whose change offers a reload: the `.envrc` and the flake
/// `use flake` evaluates.
const WATCHED: [&str; 3] = [ENVRC, "flake.nix", "flake.lock"];

/// A cold `use flake` builds or downloads the devshell: minutes, not seconds.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Output lines kept for a failure's notification.
const TAIL_LINES: usize = 12;

pub(crate) type Changes = Vec<(OsString, Option<OsString>)>;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    /// The user hasn't allowed this `.envrc` (`direnv allow`).
    Blocked,
    Failed(String),
    Cancelled,
}

pub(crate) fn has_envrc(root: &Path) -> bool {
    root.join(ENVRC).is_file()
}

/// `direnv` on the IDE's search path.
pub(crate) fn program() -> Option<PathBuf> {
    ide_core::process::find_executable("direnv", &ide_core::tool_path::search_path())
}

/// The watched file among `paths` (changed or removed below `root`), when the project has an
/// `.envrc` or just lost it: what a reload would pick up.
pub(crate) fn reload_offer<'a>(root: &Path, paths: impl IntoIterator<Item = &'a PathBuf>) -> Option<String> {
    let file = paths
        .into_iter()
        .filter(|p| p.parent() == Some(root))
        .filter_map(|p| p.file_name()?.to_str())
        .find(|name| WATCHED.contains(name))?;
    (file == ENVRC || has_envrc(root)).then(|| file.to_owned())
}

/// Runs `program export json` in `root` from the environment children outside any project
/// get (not the project's last one: a reload must not see its own result), reporting
/// direnv's progress lines to `on_line`. Gives up after `timeout` or once `cancel` fires,
/// stopping what direnv started (`nix`) too.
pub(crate) fn export(
    program: &Path,
    root: &Path,
    timeout: Duration,
    cancel: &CancellationToken,
    on_line: &dyn Fn(&str),
) -> Result<Changes, Failure> {
    let mut cmd = Command::new(program);
    ide_core::process::prepare(ide_core::process::own_group(&mut cmd));
    let mut child = cmd
        .args(["export", "json"])
        .current_dir(root)
        .env_clear()
        .envs(ide_core::process::host_vars())
        .envs(ide_core::process::shell_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Failure::Failed(format!("cannot start {}: {e}", program.display())))?;
    let mut stdout = child.stdout.take().expect("piped");
    let out = std::thread::spawn(move || {
        let mut buf = Vec::new();
        stdout.read_to_end(&mut buf).map(|_| buf)
    });
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let stderr = child.stderr.take().expect("piped");
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
            let line = ide_core::output_encoding::decode_tool_output(&line).trim_end_matches('\r').to_owned();
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + timeout;
    let mut tail: Vec<String> = Vec::new();
    let mut keep = |line: String| {
        on_line(&line);
        tail.push(line);
        let excess = tail.len().saturating_sub(TAIL_LINES);
        tail.drain(..excess);
    };
    loop {
        if cancel.is_cancelled() {
            ide_core::process::kill_tree(&mut child);
            return Err(Failure::Cancelled);
        }
        if Instant::now() > deadline {
            ide_core::process::kill_tree(&mut child);
            return Err(Failure::Failed(format!(
                "direnv did not finish within {} minutes.\n\n{}",
                timeout.as_secs() / 60,
                tail.join("\n")
            )));
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => keep(line),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = child.wait().map_err(|e| Failure::Failed(e.to_string()))?;
    let stdout = out.join().ok().and_then(Result::ok).unwrap_or_default();
    if tail.iter().any(|l| l.contains("is blocked") || l.contains("is not allowed")) {
        return Err(Failure::Blocked);
    }
    if !status.success() {
        let tail = tail.join("\n");
        return Err(Failure::Failed(if tail.is_empty() { format!("direnv exited with {status}") } else { tail }));
    }
    parse(&stdout).map_err(Failure::Failed)
}

/// `direnv export json`'s output: the variables to set, `null` for those to unset; nothing
/// when there is nothing to change.
fn parse(stdout: &[u8]) -> Result<Changes, String> {
    if stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(Changes::new());
    }
    let vars: BTreeMap<String, Option<String>> =
        serde_json::from_slice(stdout).map_err(|e| format!("unexpected output from direnv: {e}"))?;
    Ok(vars.into_iter().map(|(k, v)| (k.into(), v.map(Into::into))).collect())
}

/// Loads `root`'s environment with `program` (`None`: direnv isn't installed) into
/// [`ide_core::project_env`], as a cancellable background task; what went wrong is a
/// [`IdeEvent::Direnv`]. `current` says whether this load still owns `root` (not closed or
/// superseded by a newer one meanwhile) and is checked again before anything is applied.
pub(crate) fn load(
    root: &Path,
    program: Option<&Path>,
    sink: &SharedSink,
    cancel: &CancellationToken,
    timeout: Duration,
    hint_missing: bool,
    current: &dyn Fn(&dyn Fn()),
) {
    let report = |status: DirenvStatus| sink.emit(IdeEvent::Direnv { root: root.to_path_buf().into(), status });
    let Some(program) = program else {
        current(&|| ide_core::project_env::settle(root));
        if hint_missing {
            report(DirenvStatus::NotInstalled);
        }
        return;
    };
    let task = TaskId::next();
    let _cancel_handle = ide_core::task::on_cancel(task, {
        let cancel = cancel.clone();
        move || cancel.cancel()
    });
    let progress = |message: Option<String>, done: bool| {
        sink.emit(IdeEvent::Task {
            id: task,
            title: "Loading the direnv environment".into(),
            message,
            fraction: None,
            done,
            cancellable: !done,
        });
    };
    progress(Some(format!("{} export json", program.display())), false);
    let result = export(program, root, timeout, cancel, &|line| progress(Some(line.to_owned()), false));
    progress(None, true);
    match result {
        Ok(changes) => {
            tracing::info!("direnv: {} variables for {}", changes.len(), root.display());
            current(&|| ide_core::project_env::set(root, changes.clone()));
        }
        Err(Failure::Blocked) => {
            // As in a shell: a blocked `.envrc` isn't loaded.
            current(&|| ide_core::project_env::set(root, Changes::new()));
            report(DirenvStatus::Blocked);
        }
        Err(Failure::Failed(message)) => {
            tracing::warn!("direnv in {}: {message}", root.display());
            current(&|| ide_core::project_env::settle(root));
            report(DirenvStatus::Failed { message });
        }
        // Closed or superseded (that one settles), or stopped from the task list.
        Err(Failure::Cancelled) => current(&|| ide_core::project_env::settle(root)),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use ide_core::EventSink;
    use parking_lot::Mutex;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    /// A stand-in `direnv`: checks its arguments, then prints `stderr` and `out.json` of the
    /// folder it runs in and exits with `code`, or blocks like direnv on an `.envrc` not allowed.
    fn fake_direnv(dir: &Path) -> PathBuf {
        let program = dir.join("direnv");
        std::fs::write(
            &program,
            r#"#!/bin/sh
[ "$1 $2" = "export json" ] || { echo "direnv: unexpected arguments $*" >&2; exit 2; }
echo "direnv: loading $PWD/.envrc" >&2
[ -f slow ] && sleep 30
[ -f blocked ] && { echo "direnv: error $PWD/.envrc is blocked. Run \`direnv allow\` to approve its content" >&2; exit 1; }
[ -f stderr ] && cat stderr >&2
[ -f out.json ] && cat out.json
echo "direnv: export +NIX_DEV" >&2
exit "$(cat code 2>/dev/null || echo 0)"
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        program
    }

    fn project() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join(ENVRC), "use flake\n").unwrap();
        let program = fake_direnv(tmp.path());
        (tmp, root, program)
    }

    fn run(program: &Path, root: &Path) -> (Result<Changes, Failure>, Vec<String>) {
        let lines = Mutex::new(Vec::new());
        let result = export(program, root, Duration::from_secs(20), &CancellationToken::new(), &|l| {
            lines.lock().push(l.to_owned())
        });
        (result, lines.into_inner())
    }

    fn change(k: &str, v: Option<&str>) -> (OsString, Option<OsString>) {
        (k.into(), v.map(Into::into))
    }

    #[test]
    fn exported_variables_are_set_and_unset() {
        let (_tmp, root, program) = project();
        std::fs::write(
            root.join("out.json"),
            r#"{"PATH":"/nix/store/abc-devshell/bin:/usr/bin","IN_NIX_SHELL":"impure","OLD":null}"#,
        )
        .unwrap();
        let (result, lines) = run(&program, &root);
        assert_eq!(
            result.unwrap(),
            [
                change("IN_NIX_SHELL", Some("impure")),
                change("OLD", None),
                change("PATH", Some("/nix/store/abc-devshell/bin:/usr/bin")),
            ]
        );
        assert_eq!(lines, [format!("direnv: loading {}/.envrc", root.display()), "direnv: export +NIX_DEV".into()]);
    }

    #[test]
    fn nothing_to_export_changes_nothing() {
        let (_tmp, root, program) = project();
        assert_eq!(run(&program, &root).0, Ok(Changes::new()));
    }

    #[test]
    fn a_blocked_envrc_is_reported_as_such() {
        let (_tmp, root, program) = project();
        std::fs::write(root.join("blocked"), "").unwrap();
        assert_eq!(run(&program, &root).0, Err(Failure::Blocked));
    }

    #[test]
    fn a_failure_reports_the_end_of_the_output() {
        let (_tmp, root, program) = project();
        std::fs::write(root.join("stderr"), "error: flake 'path:/p' does not provide attribute 'devShells'\n").unwrap();
        std::fs::write(root.join("code"), "1").unwrap();
        let Err(Failure::Failed(message)) = run(&program, &root).0 else { panic!("a failure") };
        assert!(message.contains("does not provide attribute 'devShells'"), "{message}");

        std::fs::remove_file(root.join("code")).unwrap();
        std::fs::write(root.join("out.json"), "not json").unwrap();
        let Err(Failure::Failed(message)) = run(&program, &root).0 else { panic!("a failure") };
        assert!(message.starts_with("unexpected output from direnv"), "{message}");
    }

    #[test]
    fn a_slow_direnv_times_out_or_is_cancelled() {
        let (_tmp, root, program) = project();
        std::fs::write(root.join("slow"), "").unwrap();
        let started = Instant::now();
        let result = export(&program, &root, Duration::from_secs(2), &CancellationToken::new(), &|_| {});
        let Err(Failure::Failed(message)) = result else { panic!("a timeout") };
        assert!(message.starts_with("direnv did not finish within"), "{message}");
        assert!(message.contains("direnv: loading"), "{message}");

        let cancel = CancellationToken::new();
        let c = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            c.cancel();
        });
        assert_eq!(export(&program, &root, Duration::from_secs(60), &cancel, &|_| {}), Err(Failure::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn missing_program_is_a_start_failure() {
        let (_tmp, root, _) = project();
        let Err(Failure::Failed(message)) = run(Path::new("/openidea-no-such/direnv"), &root).0 else { panic!() };
        assert!(message.starts_with("cannot start"), "{message}");
    }

    #[derive(Default)]
    struct Events(Mutex<Vec<IdeEvent>>);
    impl EventSink for Events {
        fn emit(&self, e: IdeEvent) {
            self.0.lock().push(e);
        }
    }

    fn statuses(events: &Events) -> Vec<DirenvStatus> {
        events
            .0
            .lock()
            .iter()
            .filter_map(|e| match e {
                IdeEvent::Direnv { status, .. } => Some(status.clone()),
                _ => None,
            })
            .collect()
    }

    fn load_with(root: &Path, program: Option<&Path>, hint: bool) -> Arc<Events> {
        let events = Arc::new(Events::default());
        let sink: SharedSink = events.clone();
        ide_core::project_env::begin_loading(root);
        load(root, program, &sink, &CancellationToken::new(), Duration::from_secs(20), hint, &|apply| apply());
        events
    }

    #[test]
    fn children_in_the_project_get_what_direnv_exported() {
        let (_tmp, root, program) = project();
        std::fs::write(root.join("out.json"), r#"{"OPENIDEA_TEST_DEVSHELL":"1"}"#).unwrap();
        let events = load_with(&root, Some(&program), true);
        assert!(statuses(&events).is_empty());
        assert!(!ide_core::project_env::is_loading(&root));
        let mut cmd = Command::new("true");
        cmd.current_dir(root.join("src"));
        ide_core::process::host_env(&mut cmd);
        assert!(cmd.get_envs().any(|(k, v)| k == "OPENIDEA_TEST_DEVSHELL" && v == Some("1".as_ref())));
        // A task shows the progress, and ends.
        let tasks: Vec<_> = events
            .0
            .lock()
            .iter()
            .filter_map(|e| match e {
                IdeEvent::Task { message, done, .. } => Some((message.clone(), *done)),
                _ => None,
            })
            .collect();
        assert!(tasks.iter().any(|(m, _)| m.as_deref() == Some("direnv: export +NIX_DEV")), "{tasks:?}");
        assert_eq!(tasks.last(), Some(&(None, true)));

        // Blocked after an edit: the environment goes, as in a shell.
        std::fs::write(root.join("blocked"), "").unwrap();
        let events = load_with(&root, Some(&program), true);
        assert_eq!(statuses(&events), [DirenvStatus::Blocked]);
        assert!(ide_core::project_env::for_dir(&root).is_empty());

        // A failure keeps the last environment and says why.
        std::fs::remove_file(root.join("blocked")).unwrap();
        load_with(&root, Some(&program), true);
        std::fs::write(root.join("stderr"), "error: syntax error in flake.nix\n").unwrap();
        std::fs::write(root.join("code"), "1").unwrap();
        let events = load_with(&root, Some(&program), true);
        let [DirenvStatus::Failed { message }] = &statuses(&events)[..] else { panic!("{:?}", statuses(&events)) };
        assert!(message.contains("syntax error in flake.nix"), "{message}");
        assert!(!ide_core::project_env::for_dir(&root).is_empty());
        ide_core::project_env::remove(&root);
    }

    #[test]
    fn direnv_not_installed_is_hinted_once_and_does_not_block() {
        let (_tmp, root, _) = project();
        let events = load_with(&root, None, true);
        assert_eq!(statuses(&events), [DirenvStatus::NotInstalled]);
        assert!(!ide_core::project_env::is_loading(&root), "language servers start anyway");
        assert!(statuses(&load_with(&root, None, false)).is_empty());
        ide_core::project_env::remove(&root);
    }

    #[test]
    fn changes_to_the_envrc_or_flake_offer_a_reload() {
        let (_tmp, root, _) = project();
        let paths = |names: &[&str]| names.iter().map(|n| root.join(n)).collect::<Vec<_>>();
        assert_eq!(reload_offer(&root, &paths(&["src/main.rs", "flake.lock"])), Some("flake.lock".into()));
        assert_eq!(reload_offer(&root, &paths(&[".envrc"])), Some(".envrc".into()));
        assert_eq!(reload_offer(&root, &paths(&["sub/flake.nix", "src/main.rs"])), None, "the project root's only");
        std::fs::remove_file(root.join(ENVRC)).unwrap();
        assert_eq!(reload_offer(&root, &paths(&["flake.nix"])), None, "no .envrc: nothing loads the flake");
        assert_eq!(reload_offer(&root, &paths(&[".envrc"])), Some(".envrc".into()), "removed: reload unloads");
    }
}
