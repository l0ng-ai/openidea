//! Docker for the Services tool window, driven through the `docker` CLI (like git
//! is driven through its CLI): listing with `--format '{{json .}}'`, container
//! lifecycle, logs and `docker events` streams, pulls and prunes.
//!
//! Every function blocks; callers run them off the UI / command threads.

mod connection;
mod model;
mod process;

pub use connection::*;
pub use model::*;

use ide_core::{CancellationToken, IdeError, IdeResult};
use process::Stream;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

/// Listing and lifecycle commands normally answer in well under a second; a
/// wedged daemon must not keep a worker thread forever.
const QUICK: Duration = Duration::from_secs(20);
/// Stop / restart wait for the container's grace period (10 s by default).
const LIFECYCLE: Duration = Duration::from_secs(90);

/// Locates the docker executable once per process. GUI apps on macOS start with a
/// minimal `PATH`, so the usual install locations are probed after the lookup.
pub fn docker_executable() -> Option<PathBuf> {
    static DOCKER: OnceLock<Option<PathBuf>> = OnceLock::new();
    DOCKER
        .get_or_init(|| {
            if let Some(explicit) = std::env::var_os("OPENIDEA_DOCKER").map(PathBuf::from).filter(|p| p.is_file()) {
                return Some(explicit);
            }
            if let Ok(found) = which::which("docker") {
                return Some(found);
            }
            let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
            let mut candidates: Vec<PathBuf> = if cfg!(windows) {
                vec![PathBuf::from(r"C:\Program Files\Docker\Docker\resources\bin\docker.exe")]
            } else {
                [
                    "/usr/local/bin/docker",
                    "/opt/homebrew/bin/docker",
                    "/Applications/Docker.app/Contents/Resources/bin/docker",
                    "/usr/bin/docker",
                    "/snap/bin/docker",
                ]
                .iter()
                .map(PathBuf::from)
                .collect()
            };
            if let Some(home) = home.filter(|_| !cfg!(windows)) {
                candidates.push(home.join(".orbstack/bin/docker"));
                candidates.push(home.join(".rd/bin/docker"));
                candidates.push(home.join(".docker/bin/docker"));
            }
            candidates.into_iter().find(|p| p.is_file())
        })
        .clone()
}

/// Environment for docker command lines a run configuration launches: the endpoint's
/// variables plus a `PATH` that starts with docker's directory (GUI apps on macOS
/// lack the usual install locations), so `docker` / `docker compose` resolve.
pub fn run_env(ep: &DockerEndpoint) -> std::collections::BTreeMap<String, String> {
    let mut env = ep.env_vars();
    if let Some(dir) = docker_executable().as_deref().and_then(Path::parent) {
        let current = ide_core::process::host_var_os("PATH").unwrap_or_default();
        let mut dirs: Vec<PathBuf> = vec![dir.to_path_buf()];
        dirs.extend(std::env::split_paths(&current).filter(|d| d != dir));
        if let Ok(path) = std::env::join_paths(dirs) {
            env.insert("PATH".into(), path.to_string_lossy().into_owned());
        }
    }
    env
}

fn binary() -> IdeResult<PathBuf> {
    docker_executable()
        .ok_or_else(|| IdeError::unavailable("docker executable not found; install Docker and make sure it is on PATH"))
}

fn command(ep: &DockerEndpoint, args: &[&str]) -> IdeResult<Command> {
    let mut cmd = Command::new(binary()?);
    ep.apply(&mut cmd);
    cmd.args(args).env("DOCKER_CLI_HINTS", "false").env("NO_COLOR", "1");
    tracing::debug!(?args, "docker");
    Ok(cmd)
}

/// Runs a docker command, mapping a non-zero exit to an error with docker's message.
fn run(ep: &DockerEndpoint, args: &[&str], timeout: Duration) -> IdeResult<String> {
    let out = process::run(command(ep, args)?, timeout, None)?;
    if out.success { Ok(out.stdout) } else { Err(failure(args, &out.stderr, &out.stdout)) }
}

fn failure(args: &[&str], stderr: &str, stdout: &str) -> IdeError {
    let msg = [stderr, stdout].iter().map(|s| s.trim()).find(|s| !s.is_empty()).unwrap_or_default();
    let msg = msg.strip_prefix("Error response from daemon: ").unwrap_or(msg).to_owned();
    let msg = if msg.is_empty() { format!("docker {} failed", args.first().copied().unwrap_or_default()) } else { msg };
    let lower = msg.to_ascii_lowercase();
    if lower.contains("no such") || lower.contains("not found") {
        IdeError::not_found(msg)
    } else if lower.contains("cannot connect to the docker daemon") || lower.contains("is the docker daemon running") {
        IdeError::unavailable(msg)
    } else {
        IdeError::internal(msg)
    }
}

/// Whether docker can be used right now.
pub fn availability(ep: &DockerEndpoint) -> DockerAvailability {
    let Ok(cmd) = command(ep, &["version", "--format", "{{json .}}"]) else {
        return DockerAvailability::NotInstalled;
    };
    match process::run(cmd, Duration::from_secs(15), None) {
        Ok(out) => parse_version(&out.stdout, &out.stderr, out.success),
        Err(e) => DockerAvailability::DaemonDown { message: e.message, context: None },
    }
}

/// Availability plus containers, images, volumes and networks (listed in parallel).
pub fn snapshot(ep: &DockerEndpoint) -> DockerSnapshot {
    let availability = availability(ep);
    let executable = docker_executable().map(|p| ide_core::ipc_path::to_ipc(&p));
    let mut snap = DockerSnapshot {
        availability,
        executable,
        containers: Vec::new(),
        images: Vec::new(),
        volumes: Vec::new(),
        networks: Vec::new(),
        errors: Vec::new(),
        global_args: ep.global_args(),
    };
    if !matches!(snap.availability, DockerAvailability::Ready { .. }) {
        return snap;
    }
    const FMT: &str = "{{json .}}";
    let (containers, images, volumes, networks) = std::thread::scope(|s| {
        let c = s.spawn(|| run(ep, &["ps", "--all", "--no-trunc", "--format", FMT], QUICK));
        let i = s.spawn(|| run(ep, &["image", "ls", "--no-trunc", "--format", FMT], QUICK));
        let v = s.spawn(|| run(ep, &["volume", "ls", "--format", FMT], QUICK));
        let n = s.spawn(|| run(ep, &["network", "ls", "--no-trunc", "--format", FMT], QUICK));
        let join = |h: std::thread::ScopedJoinHandle<'_, IdeResult<String>>| {
            h.join().unwrap_or_else(|_| Err(IdeError::internal("docker listing panicked")))
        };
        (join(c), join(i), join(v), join(n))
    });
    let mut take = |r: IdeResult<String>, what: &str| match r {
        Ok(text) => Some(text),
        Err(e) => {
            snap.errors.push(format!("{what}: {}", e.message));
            None
        }
    };
    if let Some(t) = take(containers, "Containers") {
        snap.containers = parse_containers(&t);
    }
    if let Some(t) = take(images, "Images") {
        snap.images = parse_images(&t);
    }
    if let Some(t) = take(volumes, "Volumes") {
        snap.volumes = parse_volumes(&t);
    }
    if let Some(t) = take(networks, "Networks") {
        snap.networks = parse_networks(&t);
    }
    snap
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ContainerOp {
    Start,
    Stop,
    Restart,
    Pause,
    Unpause,
    Kill,
}

impl ContainerOp {
    fn verb(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Pause => "pause",
            Self::Unpause => "unpause",
            Self::Kill => "kill",
        }
    }
}

/// Starts / stops / … the containers `ids`.
pub fn container_op(ep: &DockerEndpoint, ids: &[String], op: ContainerOp) -> IdeResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut args = vec!["container", op.verb()];
    args.extend(ids.iter().map(String::as_str));
    run(ep, &args, LIFECYCLE).map(drop)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DockerObject {
    Container,
    Image,
    Volume,
    Network,
}

impl DockerObject {
    fn noun(self) -> &'static str {
        match self {
            Self::Container => "container",
            Self::Image => "image",
            Self::Volume => "volume",
            Self::Network => "network",
        }
    }
}

/// `docker <object> rm` (`force`: stop running containers / untag used images first).
pub fn remove(ep: &DockerEndpoint, object: DockerObject, ids: &[String], force: bool) -> IdeResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut args = vec![object.noun(), "rm"];
    if force && matches!(object, DockerObject::Container | DockerObject::Image | DockerObject::Volume) {
        args.push("--force");
    }
    args.extend(ids.iter().map(String::as_str));
    run(ep, &args, LIFECYCLE).map(drop)
}

/// `docker inspect` of one object, pretty-printed.
pub fn inspect(ep: &DockerEndpoint, object: DockerObject, id: &str) -> IdeResult<String> {
    let out = run(ep, &["inspect", "--type", object.noun(), id], QUICK)?;
    match serde_json::from_str::<serde_json::Value>(&out) {
        // A one-element array for a single id: show the object itself.
        Ok(serde_json::Value::Array(mut items)) if items.len() == 1 => {
            Ok(serde_json::to_string_pretty(&items.remove(0)).unwrap_or(out))
        }
        Ok(v) => Ok(serde_json::to_string_pretty(&v).unwrap_or(out)),
        Err(_) => Ok(out),
    }
}

/// Streams a container's logs (`tail` last lines, then follows while `follow`)
/// until it ends or `cancel` fires.
pub fn logs(
    ep: &DockerEndpoint,
    id: &str,
    tail: u32,
    follow: bool,
    timestamps: bool,
    cancel: &CancellationToken,
    on_line: &dyn Fn(DockerLogLine),
) -> IdeResult<()> {
    let tail = tail.to_string();
    let mut args = vec!["logs", "--tail", &tail];
    if follow {
        args.push("--follow");
    }
    if timestamps {
        args.push("--timestamps");
    }
    args.push(id);
    let (ok, stderr) = process::stream(command(ep, &args)?, cancel, &mut |stream, text| {
        on_line(DockerLogLine { stderr: stream == Stream::Stderr, text })
    })?;
    if ok { Ok(()) } else { Err(failure(&args, &stderr.join("\n"), "")) }
}

/// Follows `docker events` until it ends (daemon gone) or `cancel` fires.
pub fn watch_events(ep: &DockerEndpoint, cancel: &CancellationToken, on_event: &dyn Fn(DockerEvent)) -> IdeResult<()> {
    let args = ["events", "--format", "{{json .}}"];
    let (ok, stderr) = process::stream(command(ep, &args)?, cancel, &mut |stream, line| {
        if stream == Stream::Stdout
            && let Some(e) = parse_event(&line)
        {
            on_event(e);
        }
    })?;
    if ok { Ok(()) } else { Err(failure(&args, &stderr.join("\n"), "")) }
}

/// Runs a long docker command (pull, prune, compose…), streaming its output lines.
fn run_streaming(
    ep: &DockerEndpoint,
    config: Option<&Path>,
    args: &[&str],
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    on_output(format!("docker {}", args.join(" ")));
    let mut cmd = command(ep, args)?;
    if let Some(dir) = config {
        cmd.env("DOCKER_CONFIG", dir);
    }
    let (ok, stderr) = process::stream(cmd, cancel, &mut |_, line| {
        if !line.trim().is_empty() {
            on_output(line);
        }
    })?;
    if ok { Ok(()) } else { Err(failure(args, &stderr.join("\n"), "")) }
}

/// `docker pull <reference>`; with `auth` it logs in to the registry first, in a
/// throwaway config directory (the user's docker config stays untouched).
pub fn pull(
    ep: &DockerEndpoint,
    reference: &str,
    auth: Option<&RegistryAuth>,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let reference = reference.trim();
    if reference.is_empty() || reference.starts_with('-') {
        return Err(IdeError::invalid("enter an image name, e.g. postgres:16"));
    }
    let Some(auth) = auth else { return run_streaming(ep, None, &["pull", reference], cancel, on_output) };
    let config = TempConfig::new()?;
    on_output(format!("Logging in to {} as {}", auth.address, auth.username));
    login_in(ep, &config.dir, auth, Some(cancel))?;
    run_streaming(ep, Some(&config.dir), &["pull", reference], cancel, on_output)
}

/// `docker login` with `auth`; returns docker's answer (`Login Succeeded`). Nothing is
/// stored in the user's docker config.
pub fn login(ep: &DockerEndpoint, auth: &RegistryAuth) -> IdeResult<String> {
    let config = TempConfig::new()?;
    login_in(ep, &config.dir, auth, None)
}

fn login_in(
    ep: &DockerEndpoint,
    config: &Path,
    auth: &RegistryAuth,
    cancel: Option<&CancellationToken>,
) -> IdeResult<String> {
    let host = registry_host(&auth.address);
    let user = auth.username.trim();
    if host.is_empty() || host.starts_with('-') || user.is_empty() || user.starts_with('-') {
        return Err(IdeError::invalid("the registry needs an address and a username"));
    }
    let mut args = vec!["login", "--username", user, "--password-stdin"];
    // Docker Hub is the CLI's default server.
    if host != "docker.io" {
        args.push(&host);
    }
    let mut cmd = command(ep, &args)?;
    cmd.env("DOCKER_CONFIG", config);
    let out = process::run_with_input(cmd, QUICK, cancel, Some(&auth.password))?;
    if out.success {
        Ok(out.stdout.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("Login Succeeded").to_owned())
    } else {
        Err(failure(&args, &out.stderr, &out.stdout))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PruneTarget {
    Containers,
    /// Dangling images only.
    Images,
    /// Every image no container uses.
    AllImages,
    Volumes,
    Networks,
    /// Stopped containers, unused networks, dangling images and build cache.
    System,
}

/// `docker <object> prune --force`.
pub fn prune(
    ep: &DockerEndpoint,
    target: PruneTarget,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let args: &[&str] = match target {
        PruneTarget::Containers => &["container", "prune", "--force"],
        PruneTarget::Images => &["image", "prune", "--force"],
        PruneTarget::AllImages => &["image", "prune", "--all", "--force"],
        PruneTarget::Volumes => &["volume", "prune", "--force"],
        PruneTarget::Networks => &["network", "prune", "--force"],
        PruneTarget::System => &["system", "prune", "--force"],
    };
    run_streaming(ep, None, args, cancel, on_output)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ComposeOp {
    Start,
    Stop,
    Restart,
    /// Stops and removes the project's containers and networks.
    Down,
}

/// Runs `docker compose -p <project> <op>` for a project found through container
/// labels. `files` / `working_dir` (from the labels too) are passed when they still
/// exist, so commands that need the model keep working.
pub fn compose_op(
    ep: &DockerEndpoint,
    project: &str,
    files: &[String],
    working_dir: Option<&str>,
    op: ComposeOp,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let mut args: Vec<&str> = vec!["compose", "--project-name", project];
    let existing: Vec<&String> = files.iter().filter(|f| Path::new(f).is_file()).collect();
    if !existing.is_empty() && existing.len() == files.len() {
        for f in existing {
            args.push("--file");
            args.push(f);
        }
        if let Some(dir) = working_dir.filter(|d| Path::new(d).is_dir()) {
            args.push("--project-directory");
            args.push(dir);
        }
    }
    args.push(match op {
        ComposeOp::Start => "start",
        ComposeOp::Stop => "stop",
        ComposeOp::Restart => "restart",
        ComposeOp::Down => "down",
    });
    run_streaming(ep, None, &args, cancel, on_output)
}
