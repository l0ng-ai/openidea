//! Running toolchain commands: short queries with a timeout and long-running
//! streaming commands that honour cancellation.

use ide_core::{CancellationToken, IdeError, IdeResult};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The process `PATH` (already the login shell's in the app) plus common tool dirs.
pub fn search_path() -> OsString {
    let mut dirs: Vec<PathBuf> =
        std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = crate::home_dir() {
        for rel in [".cargo/bin", ".local/bin", "go/bin", ".pyenv/shims", ".bun/bin", ".npm-global/bin", ".volta/bin"] {
            dirs.push(home.join(rel));
        }
        // nvm: newest installed node's bin, as language servers are launched.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin")).collect();
            versions.sort();
            dirs.extend(versions.into_iter().rev());
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(d));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()));
    std::env::join_paths(dirs).unwrap_or_default()
}

/// `dir` in front of the search path, as a `PATH` value.
pub(crate) fn path_with(dirs: &[&Path]) -> String {
    let mut all: Vec<PathBuf> = dirs.iter().map(|d| d.to_path_buf()).collect();
    all.extend(std::env::split_paths(&search_path()));
    let mut seen = std::collections::HashSet::new();
    all.retain(|d| seen.insert(d.clone()));
    std::env::join_paths(all).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Resolves a command name on the search path.
pub(crate) fn which(name: &str) -> Option<PathBuf> {
    let path = search_path();
    std::env::split_paths(&path).map(|d| d.join(crate::exe(name))).find(|p| p.is_file())
}

/// Runs `program args` and returns trimmed stdout (stderr when stdout is empty)
/// on success; `None` on failure or after `timeout`.
pub(crate) fn query(program: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    query_in(program, args, None, &[], timeout)
}

/// [`query`] in `cwd` with extra environment variables.
pub(crate) fn query_in(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> Option<String> {
    let mut cmd = Command::new(program);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = ide_core::process::prepare(&mut cmd)
        .args(args)
        .env("PATH", search_path())
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let (out, err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    if !status.success() {
        return None;
    }
    let text = if out.trim().is_empty() { err } else { out };
    Some(text.trim().to_owned())
}

/// Runs a command to completion, reporting every output line (stdout and
/// stderr) through `on_line`. Killed when `cancel` fires. Fails with the last
/// output lines when the exit status is non-zero.
pub(crate) fn stream(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    env: &[(String, String)],
    cancel: &CancellationToken,
    on_line: &dyn Fn(String),
) -> IdeResult<String> {
    let mut cmd = Command::new(program);
    ide_core::process::prepare(&mut cmd);
    cmd.args(args).env("PATH", search_path()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.envs(env.iter().map(|(k, v)| (k, v)));
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    on_line(format!("$ {} {}", program.display(), args.join(" ")));
    let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("cannot run {}: {e}", program.display())))?;
    let (tx, rx) = mpsc::channel::<String>();
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        }));
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        }));
    }
    drop(tx);
    let mut collected = String::new();
    let mut tail: std::collections::VecDeque<String> = Default::default();
    let status = loop {
        while let Ok(line) = rx.try_recv() {
            collected.push_str(&line);
            collected.push('\n');
            tail.push_back(line.clone());
            if tail.len() > 8 {
                tail.pop_front();
            }
            on_line(line);
        }
        if cancel.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(IdeError::cancelled());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(e.into()),
        }
    };
    for r in readers {
        let _ = r.join();
    }
    for line in rx.try_iter() {
        collected.push_str(&line);
        collected.push('\n');
        tail.push_back(line.clone());
        if tail.len() > 8 {
            tail.pop_front();
        }
        on_line(line);
    }
    if !status.success() {
        let detail = tail.into_iter().collect::<Vec<_>>().join("\n");
        return Err(IdeError::new(
            ide_core::error::ErrorKind::Io,
            format!("{} exited with {status}\n{detail}", program.display()),
        ));
    }
    Ok(collected)
}
