//! Running toolchain commands: short queries with a timeout and long-running
//! streaming commands that honour cancellation.

use ide_core::output_encoding::decode_tool_output;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub(crate) use ide_core::tool_path::search_path;

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
    ide_core::process::find_executable(name, &path)
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
    if !env.iter().any(|(k, _)| *k == "PATH") {
        cmd.env("PATH", search_path());
    }
    let mut child = ide_core::process::prepare(&mut cmd)
        .args(args)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    // Chunks as they come, `None` at the end of a pipe. A reader stops once the query
    // has returned, closing the pipe on whatever still writes to it.
    let (tx, rx) = mpsc::channel::<(bool, Option<Vec<u8>>)>();
    let pipes: [(bool, Box<dyn Read + Send>); 2] =
        [(true, Box::new(child.stdout.take()?)), (false, Box::new(child.stderr.take()?))];
    for (is_out, mut pipe) in pipes {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                let chunk = match pipe.read(&mut buf) {
                    Ok(0) => None,
                    Ok(n) => Some(buf[..n].to_vec()),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => None,
                };
                let end = chunk.is_none();
                if tx.send((is_out, chunk)).is_err() || end {
                    return;
                }
            }
        });
    }
    drop(tx);
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
    if !status.success() {
        return None;
    }
    // Up to the deadline, or briefly past it for a program that exited just before:
    // a process it left running (a wrapper's background job) can hold the pipes
    // open, or keep writing to them, after it exits.
    let until = deadline.max(Instant::now() + Duration::from_millis(100));
    let (mut out, mut err, mut open) = (Vec::new(), Vec::new(), 2);
    while open > 0 {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left) {
            Ok((is_out, Some(chunk))) => if is_out { &mut out } else { &mut err }.extend(chunk),
            Ok((_, None)) => open -= 1,
            Err(_) => break,
        }
    }
    let text = if out.trim_ascii().is_empty() { err } else { out };
    Some(decode_tool_output(&text).trim().to_owned())
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
            for line in BufReader::new(out).split(b'\n').map_while(Result::ok) {
                let _ = tx.send(decode_tool_output(&line).trim_end_matches('\r').to_owned());
            }
        }));
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(err).split(b'\n').map_while(Result::ok) {
                let _ = tx.send(decode_tool_output(&line).trim_end_matches('\r').to_owned());
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
