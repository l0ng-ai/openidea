//! Run configurations on Docker and Compose run targets: rewritten into a local
//! `docker run --rm` / `docker compose run --rm` of the configuration's program,
//! with the project bind-mounted and its paths and interpreters swapped for the
//! container's. The console, stdin, Stop and test parsers then work as for any
//! local run.

use crate::target::remote_command;
use ide_core::remote_settings::{RunTarget, RunTargetKind};
use ide_core::{IdeError, IdeResult};
use ide_run::RunConfig;
use std::collections::BTreeMap;
use std::path::Path;

/// What the rewrite needs besides the configuration and its target.
pub struct ContainerRun<'a> {
    pub target: &'a RunTarget,
    /// The project on this machine.
    pub root: &'a Path,
    /// Where the project is in the container.
    pub container_root: &'a str,
    /// The docker executable.
    pub docker: &'a str,
    /// The connection's variables for the docker CLI (`ide_docker::run_env`).
    pub endpoint_env: &'a BTreeMap<String, String>,
    /// Variables of the configuration's `.env` files, already read.
    pub file_env: &'a BTreeMap<String, String>,
    /// Variables the container gets elsewhere: the Compose service's `environment`, and the
    /// `.env` / `.flaskenv` a development server reads. Not passed: only consulted.
    pub service_env: &'a BTreeMap<String, String>,
    /// The Compose service's published ports: `(port here, port in the container)`.
    pub service_ports: &'a [(u16, u16)],
    /// Container name, unique per run.
    pub name: &'a str,
    /// `--user uid:gid`; `None` keeps the image's user.
    pub user: Option<(u32, u32)>,
    /// Runs the Python program under debugpy, for the debugger to attach.
    pub debug: Option<ContainerDebug<'a>>,
}

/// A debug run: the program starts under [`DEBUG_BOOTSTRAP`], which waits for the
/// debugger on `port` (published on this machine's loopback interface only).
pub struct ContainerDebug<'a> {
    pub port: u16,
    /// Folder on this machine holding [`DEBUG_BOOTSTRAP`] as [`DEBUG_BOOTSTRAP_NAME`].
    pub bootstrap_dir: &'a Path,
    /// The IDE's debugpy (the folder that contains the `debugpy` package), used when
    /// the image has none.
    pub debugpy: Option<&'a Path>,
}

/// The script that starts a debugged program in the container: it prints a line
/// starting with [`DEBUG_READY`] once debugpy listens, then runs the program.
pub const DEBUG_BOOTSTRAP: &str = include_str!("openidea_debug.py");
pub const DEBUG_BOOTSTRAP_NAME: &str = "openidea_debug.py";
/// Where the bootstrap folder and the IDE's debugpy are mounted (read-only).
const DEBUG_DIR: &str = "/opt/openidea/debug";
const DEBUGPY_DIR: &str = "/opt/openidea/debugpy-lib";
/// Start of the line the bootstrap prints when the debugger can attach.
pub const DEBUG_READY: &str = "debugpy is waiting for the debugger on port ";

/// The container folder of the project when a Docker target sets none.
pub fn default_container_root(root: &Path) -> String {
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name: String =
        name.chars().map(|c| if c.is_alphanumeric() || matches!(c, '_' | '-' | '.') { c } else { '-' }).collect();
    format!("/workspaces/{}", if name.is_empty() { "project" } else { &name })
}

/// The file here of `container_path` (a traceback line), through the mount whose container
/// folder is the longest prefix of it: `(folder here, folder in the container)`. `None`
/// outside every mount, and for `..`.
pub fn mounted_file(container_path: &str, mounts: &[(std::path::PathBuf, String)]) -> Option<std::path::PathBuf> {
    let (local, rest) = mounts
        .iter()
        .filter_map(|(local, folder)| {
            let rest = container_path.strip_prefix(folder.trim_end_matches('/'))?.strip_prefix('/')?;
            Some((local, folder.trim_end_matches('/').len(), rest))
        })
        .max_by_key(|(_, len, _)| *len)
        .map(|(local, _, rest)| (local, rest))?;
    let parts: Vec<&str> = rest.split('/').filter(|c| !c.is_empty() && *c != ".").collect();
    (!parts.is_empty() && !parts.contains(&"..")).then(|| parts.iter().fold(local.clone(), |p, c| p.join(c)))
}

/// A development server `program args` runs, and the port it listens on in the container.
/// They listen on `127.0.0.1` by default, which a published port can't reach: Django's
/// `runserver`, `flask run`, `uvicorn` and `fastapi dev` are made to listen on all interfaces
/// unless the command, or a variable `set` finds (the configuration, its env files, the
/// service's `environment`, `.env` / `.flaskenv`), already chooses an address.
fn dev_server(
    program: &str,
    args: &mut Vec<String>,
    env: &mut BTreeMap<String, String>,
    set: &dyn Fn(&str) -> Option<String>,
) -> Option<u16> {
    let name = |s: &str| s.rsplit('/').next().unwrap_or(s).trim_end_matches(".py").to_owned();
    // `words[0]` is the program: `words[i]` is `args[i - 1]`.
    let words: Vec<String> = std::iter::once(program).chain(args.iter().map(String::as_str)).map(name).collect();
    let option = |args: &[String], names: &[&str]| -> Option<String> {
        args.iter().enumerate().find_map(|(i, a)| {
            names.iter().find_map(|n| {
                if a == n { args.get(i + 1).cloned() } else { a.strip_prefix(&format!("{n}=")).map(str::to_owned) }
            })
        })
    };
    let port = |given: Option<String>, default: u16| given.and_then(|p| p.trim().parse().ok()).unwrap_or(default);
    // The word after `tool` and its options (`flask --app x run`): its index in `words`.
    let subcommand = |tool: &[&str], sub: &[&str]| {
        let start = words.iter().position(|w| tool.contains(&w.as_str()))? + 1;
        let mut i = start;
        while let Some(w) = words.get(i).filter(|w| w.starts_with('-')) {
            i += if matches!(w.as_str(), "--app" | "-A" | "--env-file" | "-e") { 2 } else { 1 };
        }
        words.get(i).filter(|w| sub.contains(&w.as_str())).map(|_| i - 1)
    };
    if let Some(i) = subcommand(&["manage", "django-admin", "django"], &["runserver"]) {
        // The first positional argument after `runserver` is `[address:]port`.
        let mut at = i + 1;
        while let Some(a) = args.get(at) {
            if matches!(a.as_str(), "--settings" | "--pythonpath" | "-v" | "--verbosity") {
                at += 2;
            } else if a.starts_with('-') {
                at += 1;
            } else {
                break;
            }
        }
        return Some(match args.get(at).cloned() {
            None => {
                args.insert(i + 1, "0.0.0.0:8000".into());
                8000
            }
            Some(p) if p.chars().all(|c| c.is_ascii_digit()) => {
                args[at] = format!("0.0.0.0:{p}");
                port(Some(p), 8000)
            }
            Some(address) => port(address.rsplit(':').next().map(str::to_owned), 8000),
        });
    }
    let host = option(args, &["--host", "-h"]).is_some();
    if subcommand(&["flask"], &["run"]).is_some() {
        if !host && set("FLASK_RUN_HOST").is_none() {
            env.insert("FLASK_RUN_HOST".into(), "0.0.0.0".into());
        }
        return Some(port(option(args, &["--port", "-p"]).or_else(|| set("FLASK_RUN_PORT")), 5000));
    }
    if words.iter().any(|w| w == "uvicorn") {
        if !host && set("UVICORN_HOST").is_none() {
            env.insert("UVICORN_HOST".into(), "0.0.0.0".into());
        }
        return Some(port(option(args, &["--port"]).or_else(|| set("UVICORN_PORT")), 8000));
    }
    if let Some(i) = subcommand(&["fastapi"], &["dev", "run"]) {
        // `fastapi run` listens on all interfaces already.
        if !host && words[i + 1] == "dev" {
            args.extend(["--host".into(), "0.0.0.0".into()]);
        }
        return Some(port(option(args, &["--port"]), 8000));
    }
    None
}

/// A container name for a run of `config_id`: Docker allows `[a-zA-Z0-9][a-zA-Z0-9_.-]*`.
pub fn container_name(config_id: &str, unique: &str) -> String {
    let id: String = config_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') { c } else { '-' })
        .take(40)
        .collect();
    format!("openidea-{}-{unique}", id.trim_matches('-'))
}

/// `config` as a local run of the docker CLI that runs it in a new container.
pub fn container_config(config: &RunConfig, run: &ContainerRun) -> IdeResult<RunConfig> {
    let target = run.target;
    let mut command = remote_command(config, target, run.root, run.container_root);
    let set = |key: &str| [&command.env, run.file_env, run.service_env].into_iter().find_map(|e| e.get(key).cloned());
    let mut added = BTreeMap::new();
    let server = if command.shell_line.is_none() {
        dev_server(&command.program.clone(), &mut command.args, &mut added, &set)
    } else {
        None
    };
    command.env.extend(added);
    // Variables go by name (`-e NAME`) so their values stay out of the command line
    // echoed in the console; the docker CLI reads them from its own environment.
    let mut env: BTreeMap<String, String> = run.file_env.clone();
    if matches!(config.kind.as_str(), "python" | "pytest" | "unittest" | "doctest" | "django-test")
        && !command.env.contains_key("PYTHONUNBUFFERED")
    {
        env.insert("PYTHONUNBUFFERED".into(), "1".into());
    }
    env.extend(command.env.clone());
    let pty = config.extras.emulate_terminal;
    let mut args: Vec<String> = Vec::new();
    match target.kind {
        RunTargetKind::Docker => {
            if target.image.trim().is_empty() {
                return Err(IdeError::invalid(format!("Run target '{}' has no image", target.name)));
            }
            args.extend(["run", "--rm", "--interactive", "--init"].map(String::from));
            if pty {
                args.push("--tty".into());
            }
            let root = run.root.to_string_lossy();
            args.extend(["--volume".into(), format!("{root}:{}", run.container_root)]);
        }
        RunTargetKind::Compose => {
            if target.service.trim().is_empty() {
                return Err(IdeError::invalid(format!("Run target '{}' has no service", target.name)));
            }
            args.push("compose".into());
            for file in target.compose_files.iter().map(|f| f.trim()).filter(|f| !f.is_empty()) {
                args.extend(["--file".into(), run.root.join(file).to_string_lossy().into_owned()]);
            }
            args.extend(["run", "--rm"].map(String::from));
            if !pty {
                args.push("--no-TTY".into());
            }
        }
        RunTargetKind::Ssh => return Err(IdeError::internal("an SSH target does not run in a container")),
    }
    args.extend(["--name".into(), run.name.to_owned(), "--label".into(), format!("openidea.run={}", config.id)]);
    args.extend(["--workdir".into(), command.cwd.clone()]);
    let mut docker_env = run.endpoint_env.clone();
    for (key, value) in &env {
        if run.endpoint_env.contains_key(key) {
            // `PATH`, `DOCKER_HOST`…: the CLI's own value differs from the container's.
            args.extend(["--env".into(), format!("{key}={value}")]);
        } else {
            args.extend(["--env".into(), key.clone()]);
            docker_env.insert(key.clone(), value.clone());
        }
    }
    for port in target.ports.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        args.extend(["--publish".into(), port.to_owned()]);
    }
    // A development server on a target without ports of its own: its port, on this machine's
    // loopback interface only (the service's mapping when it has one; `compose run` publishes
    // none of them).
    if let Some(port) = server.filter(|_| target.ports.iter().all(|p| p.trim().is_empty())) {
        let here = run.service_ports.iter().find(|(_, inside)| *inside == port).map_or(port, |(here, _)| *here);
        args.extend(["--publish".into(), format!("127.0.0.1:{here}:{port}")]);
    }
    if let Some((uid, gid)) = run.user {
        args.extend(["--user".into(), format!("{uid}:{gid}")]);
    }
    if let Some(debug) = &run.debug {
        let port = debug.port;
        args.extend(["--publish".into(), format!("127.0.0.1:{port}:{port}")]);
        args.extend(["--volume".into(), format!("{}:{DEBUG_DIR}:ro", debug.bootstrap_dir.to_string_lossy())]);
        if let Some(lib) = debug.debugpy {
            args.extend(["--volume".into(), format!("{}:{DEBUGPY_DIR}:ro", lib.to_string_lossy())]);
        }
    }
    let options = target.run_options.trim();
    if !options.is_empty() {
        args.extend(ide_run::import::split_args(options));
    }
    args.push(match target.kind {
        RunTargetKind::Compose => target.service.trim().to_owned(),
        _ => target.image.trim().to_owned(),
    });
    match (command.shell_line, &run.debug) {
        (Some(_), Some(_)) => {
            return Err(IdeError::invalid(format!(
                "'{}' is a shell command line: only a Python script, module or console script can be debugged in a container. Set Command to the Python executable and put the script or -m module in Arguments",
                config.name
            )));
        }
        (Some(line), None) => args.extend(["sh".into(), "-c".into(), line]),
        (None, Some(debug)) => {
            args.extend(debug_command(&command.program, &command.args, target, debug.port, run.container_root)?)
        }
        (None, None) => {
            args.push(command.program);
            args.extend(command.args);
        }
    }
    let mut out = config.clone();
    out.command = run.docker.to_owned();
    out.args = args;
    out.cwd = Some(run.root.to_path_buf().into());
    out.env = docker_env;
    let extras = &mut out.extras;
    extras.target = None;
    extras.env_files.clear();
    // The docker CLI needs `HOME` (contexts, credentials); the container gets only `env`.
    extras.include_system_env = true;
    // `docker stop` signals the container's process (the CLI may not forward a signal).
    extras.stop_command = Some(format!("{} stop {}", shell_word(run.docker), run.name));
    Ok(out)
}

/// The docker CLI arguments that run `python -c code` in a new container of the target's
/// image or service, named `name`. The container is kept when it exits, so `docker cp` can
/// copy from it while nothing runs; the caller removes it. The image's entrypoint is
/// skipped (it may wait for other services), as are the service's dependencies.
pub fn python_probe_args(target: &RunTarget, root: &Path, name: &str, code: &str) -> IdeResult<Vec<String>> {
    let python = match target.python.trim() {
        "" => "python3",
        python => python,
    };
    let mut args: Vec<String> = Vec::new();
    match target.kind {
        RunTargetKind::Docker => {
            if target.image.trim().is_empty() {
                return Err(IdeError::invalid(format!("Run target '{}' has no image", target.name)));
            }
            args.push("run".into());
        }
        RunTargetKind::Compose => {
            if target.service.trim().is_empty() {
                return Err(IdeError::invalid(format!("Run target '{}' has no service", target.name)));
            }
            args.push("compose".into());
            for file in target.compose_files.iter().map(|f| f.trim()).filter(|f| !f.is_empty()) {
                args.extend(["--file".into(), root.join(file).to_string_lossy().into_owned()]);
            }
            args.extend(["run", "--no-deps", "--no-TTY"].map(String::from));
        }
        RunTargetKind::Ssh => {
            return Err(IdeError::invalid(format!("Run target '{}' is not a container", target.name)));
        }
    }
    args.extend(["--name".into(), name.to_owned(), "--label".into(), "openidea.python-probe=true".into()]);
    args.extend(["--entrypoint".into(), python.to_owned()]);
    args.push(match target.kind {
        RunTargetKind::Compose => target.service.trim().to_owned(),
        _ => target.image.trim().to_owned(),
    });
    args.extend(["-c".into(), code.to_owned()]);
    Ok(args)
}

/// Project managers whose `run` executes in the project's environment (`uv run python …`).
const PYTHON_RUNNERS: [&str; 6] = ["uv", "poetry", "pdm", "pipenv", "hatch", "rye"];

fn is_python(program: &str) -> bool {
    let name = program.rsplit('/').next().unwrap_or(program);
    name == "python" || name == "python2" || name.starts_with("python3")
}

/// The container's command line that runs `program args` under [`DEBUG_BOOTSTRAP`]:
/// `python [options] <bootstrap> <port> <folder> (script | -m module | -c code) args`.
/// A console script (`pytest`) runs as a module of the interpreter next to it, or of the
/// target's; `uv run …` and the like keep the manager in front.
fn debug_command(
    program: &str,
    args: &[String],
    target: &RunTarget,
    port: u16,
    folder: &str,
) -> IdeResult<Vec<String>> {
    let tool_module = |tool: &str, rest: &[String]| -> Vec<String> {
        let module = tool.rsplit('/').next().unwrap_or(tool).to_owned();
        [vec!["-m".to_owned(), module], rest.to_vec()].concat()
    };
    let (mut line, rest): (Vec<String>, Vec<String>) = if is_python(program) {
        (vec![program.to_owned()], args.to_vec())
    } else if PYTHON_RUNNERS.contains(&program.rsplit('/').next().unwrap_or(program))
        && args.first().is_some_and(|a| a == "run")
        && args.len() > 1
    {
        if args[1].starts_with('-') {
            return Err(IdeError::invalid(
                "container debugging does not support runner options before the executable: use `uv run python script.py` or `uv run pytest` with options after the script or module",
            ));
        }
        if is_python(&args[1]) {
            (vec![program.to_owned(), "run".into(), args[1].clone()], args[2..].to_vec())
        } else {
            (vec![program.to_owned(), "run".into(), "python".into()], tool_module(&args[1], &args[2..]))
        }
    } else {
        let python = match program.rfind('/') {
            Some(i) => format!("{}python", &program[..=i]),
            None if !target.python.trim().is_empty() => target.python.trim().to_owned(),
            None => "python3".to_owned(),
        };
        (vec![python], tool_module(program, args))
    };
    // Interpreter options stay before the bootstrap (`-u`, `-X dev`).
    let mut i = 0;
    while let Some(a) = rest.get(i).filter(|a| a.starts_with('-') && *a != "-m" && *a != "-c") {
        line.push(a.clone());
        if matches!(a.as_str(), "-W" | "-X")
            && let Some(value) = rest.get(i + 1)
        {
            line.push(value.clone());
            i += 1;
        }
        i += 1;
    }
    let rest = &rest[i..];
    match rest.first().map(String::as_str) {
        None => return Err(IdeError::invalid("nothing to debug: the command names no Python script or module")),
        Some("-m" | "-c") if rest.len() < 2 => {
            return Err(IdeError::invalid(format!("nothing to debug: `{}` has no argument", rest[0])));
        }
        _ => {}
    }
    line.extend([format!("{DEBUG_DIR}/{DEBUG_BOOTSTRAP_NAME}"), port.to_string(), folder.to_owned()]);
    line.extend(rest.iter().cloned());
    Ok(line)
}

/// `word` for this machine's shell (the stop command runs there): the docker CLI found
/// outside `PATH` (Docker.app's bundle) may contain spaces.
fn shell_word(word: &str) -> String {
    if !word.contains(|c: char| c.is_whitespace() || "'\"$`\\&;|<>()*?#~".contains(c)) || word.is_empty() {
        word.to_owned()
    } else if cfg!(windows) {
        format!("\"{word}\"")
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// What `docker compose config --format json` says of a service.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ComposeService {
    /// Bind mounts: `(source here, target in the container)`.
    pub mounts: Vec<(String, String)>,
    /// Published ports: `(port here, port in the container)`.
    pub ports: Vec<(u16, u16)>,
    /// `environment:` (a variable without a value is empty).
    pub environment: BTreeMap<String, String>,
}

/// The mounts, ports and environment of a Compose `service`, from the JSON of `docker
/// compose config --format json`.
pub fn compose_service(config_json: &str, service: &str) -> IdeResult<ComposeService> {
    let model: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| IdeError::internal(format!("cannot read `docker compose config`: {e}")))?;
    let Some(svc) = model.pointer(&format!("/services/{}", service.replace('~', "~0").replace('/', "~1"))) else {
        return Err(IdeError::not_found(format!("the Compose files have no service '{service}'")));
    };
    let list = |key: &str| svc.get(key).and_then(|v| v.as_array()).into_iter().flatten();
    let number = |v: Option<&serde_json::Value>| match v? {
        serde_json::Value::Number(n) => n.as_u64().and_then(|n| u16::try_from(n).ok()),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    };
    Ok(ComposeService {
        mounts: list("volumes")
            .filter(|m| m.get("type").and_then(|t| t.as_str()) == Some("bind"))
            .filter_map(|m| Some((m.get("source")?.as_str()?.to_owned(), m.get("target")?.as_str()?.to_owned())))
            .collect(),
        ports: list("ports").filter_map(|p| Some((number(p.get("published"))?, number(p.get("target"))?))).collect(),
        environment: svc
            .get("environment")
            .and_then(|e| e.as_object())
            .into_iter()
            .flatten()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
            .collect(),
    })
}

/// The project's folder in the container of a Compose `service`, from the JSON of
/// `docker compose config --format json`: the target of a bind mount of the project
/// or a folder above it.
pub fn compose_container_root(config_json: &str, service: &str, root: &Path) -> IdeResult<String> {
    let mut best: Option<(usize, String)> = None;
    for (source, target) in compose_service(config_json, service)?.mounts {
        let Ok(rel) = root.strip_prefix(&source) else { continue };
        let depth = Path::new(&source).components().count();
        if best.as_ref().is_none_or(|(d, _)| depth > *d) {
            let rel = crate::mapping::posix(rel);
            let target = target.trim_end_matches('/');
            let folder = match (target.is_empty(), rel.is_empty()) {
                (true, true) => "/".to_owned(),
                (_, true) => target.to_owned(),
                _ => format!("{target}/{rel}"),
            };
            best = Some((depth, folder));
        }
    }
    best.map(|(_, folder)| folder).ok_or_else(|| {
        IdeError::invalid(format!(
            "service '{service}' does not mount the project folder: add a bind mount of it, or set the container folder of the run target"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::path::PathBuf;

    #[cfg(unix)]
    fn config(command: &str, args: &[&str]) -> RunConfig {
        RunConfig {
            id: "app".into(),
            name: "app".into(),
            kind: "python".into(),
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: BTreeMap::from([("DATA".to_owned(), "/work/proj/data".to_owned())]),
            detected: false,
            is_test: false,
            debug_adapter: None,
            allow_parallel: false,
            extras: Default::default(),
        }
    }

    #[cfg(unix)]
    fn run<'a>(
        target: &'a RunTarget,
        endpoint: &'a BTreeMap<String, String>,
        files: &'a BTreeMap<String, String>,
    ) -> ContainerRun<'a> {
        ContainerRun {
            target,
            root: Path::new("/work/proj"),
            container_root: "/workspaces/proj",
            docker: "/usr/local/bin/docker",
            endpoint_env: endpoint,
            file_env: files,
            service_env: files,
            service_ports: &[],
            name: "openidea-app-1",
            user: Some((501, 20)),
            debug: None,
        }
    }

    // Unix paths are not absolute on Windows.
    #[cfg(unix)]
    #[test]
    fn docker_target_runs_the_program_in_a_new_container() {
        let target = RunTarget {
            kind: RunTargetKind::Docker,
            name: "py".into(),
            image: "python:3.12".into(),
            ports: vec!["8000:8000".into(), " ".into()],
            run_options: r#"--network host --label "a b""#.into(),
            ..Default::default()
        };
        let endpoint = BTreeMap::from([
            ("DOCKER_CONTEXT".to_owned(), "orbstack".to_owned()),
            ("PATH".to_owned(), "/usr/local/bin".to_owned()),
        ]);
        let files = BTreeMap::from([("SECRET".to_owned(), "s3".to_owned())]);
        let mut c = config("/work/proj/.venv/bin/python", &["-u", "/work/proj/main.py"]);
        c.env.insert("PATH".into(), "/opt/bin".into());
        c.extras.target = Some("t".into());
        c.extras.env_files = vec![".env".into()];
        let out = container_config(&c, &run(&target, &endpoint, &files)).unwrap();
        assert_eq!(out.command, "/usr/local/bin/docker");
        assert_eq!(
            out.args.join(" "),
            "run --rm --interactive --init --volume /work/proj:/workspaces/proj \
             --name openidea-app-1 --label openidea.run=app --workdir /workspaces/proj \
             --env DATA --env PATH=/opt/bin --env PYTHONUNBUFFERED --env SECRET \
             --publish 8000:8000 --user 501:20 --network host --label a b \
             python:3.12 python3 -u /workspaces/proj/main.py"
        );
        assert_eq!(out.env["DATA"], "/workspaces/proj/data", "values reach the CLI's environment, mapped");
        assert_eq!(out.env["SECRET"], "s3");
        assert_eq!(out.env["PATH"], "/usr/local/bin", "the CLI keeps its own PATH");
        assert_eq!(out.env["DOCKER_CONTEXT"], "orbstack");
        assert_eq!(out.cwd.as_deref(), Some(Path::new("/work/proj")));
        assert_eq!(out.extras.target, None);
        assert!(out.extras.env_files.is_empty() && out.extras.include_system_env);
        assert_eq!(out.extras.stop_command.as_deref(), Some("/usr/local/bin/docker stop openidea-app-1"));
        assert_eq!(out.kind, "python", "test and output parsers still apply");

        let mut c = config("npm run dev", &[]);
        c.kind = "npm".into();
        c.extras.emulate_terminal = true;
        let target = RunTarget { kind: RunTargetKind::Docker, image: "node:22".into(), ..Default::default() };
        let mut r = run(&target, &endpoint, &files);
        r.user = None;
        let out = container_config(&c, &r).unwrap();
        assert!(out.args.starts_with(&["run", "--rm", "--interactive", "--init", "--tty"].map(String::from)));
        assert!(!out.args.contains(&"--user".to_string()) && !out.args.contains(&"PYTHONUNBUFFERED".to_string()));
        assert!(out.args.ends_with(&["node:22", "sh", "-c", "npm run dev"].map(String::from)));

        let target = RunTarget { kind: RunTargetKind::Docker, name: "none".into(), ..Default::default() };
        assert!(container_config(&c, &run(&target, &endpoint, &files)).unwrap_err().message.contains("no image"));
    }

    #[cfg(unix)]
    #[test]
    fn compose_target_runs_in_a_new_container_of_the_service() {
        let target = RunTarget {
            kind: RunTargetKind::Compose,
            compose_files: vec!["compose.yaml".into(), "compose.dev.yaml".into()],
            service: "web".into(),
            ..Default::default()
        };
        let none = BTreeMap::new();
        let mut c = config("/work/proj/.venv/bin/python", &["manage.py", "test"]);
        c.kind = "django-test".into();
        c.cwd = Some(PathBuf::from("/work/proj/backend").into());
        let mut r = run(&target, &none, &none);
        r.container_root = "/app";
        let out = container_config(&c, &r).unwrap();
        assert_eq!(
            out.args.join(" "),
            "compose --file /work/proj/compose.yaml --file /work/proj/compose.dev.yaml run --rm --no-TTY \
             --name openidea-app-1 --label openidea.run=app --workdir /app/backend \
             --env DATA --env PYTHONUNBUFFERED --user 501:20 web python3 manage.py test"
        );
        assert_eq!(out.env["DATA"], "/app/data");

        // A development server: on all interfaces, its port published on the loopback
        // interface only, through the service's own mapping when it has one.
        c.args = vec!["manage.py".into(), "runserver".into()];
        let out = container_config(&c, &r).unwrap().args.join(" ");
        assert!(out.contains("--publish 127.0.0.1:8000:8000") && !out.contains("--service-ports"), "{out}");
        assert!(out.ends_with("web python3 manage.py runserver 0.0.0.0:8000"), "{out}");
        r.service_ports = &[(8080, 8000)];
        let out = container_config(&c, &r).unwrap().args.join(" ");
        assert!(out.contains("--publish 127.0.0.1:8080:8000"), "{out}");
        let ports = RunTarget { ports: vec!["8000:8000".into()], ..target.clone() };
        let out = container_config(&c, &run(&ports, &none, &none)).unwrap().args.join(" ");
        assert!(
            out.contains("--publish 8000:8000") && !out.contains("127.0.0.1:8000"),
            "the target's own ports: {out}"
        );
        // A host the env file sets is the user's.
        c.args = vec!["-m".into(), "flask".into(), "run".into()];
        let files = BTreeMap::from([("FLASK_RUN_HOST".to_owned(), "127.0.0.1".to_owned())]);
        let out = container_config(&c, &run(&target, &none, &files)).unwrap();
        assert_eq!(out.env["FLASK_RUN_HOST"], "127.0.0.1");

        let target = RunTarget { kind: RunTargetKind::Compose, name: "c".into(), ..Default::default() };
        assert!(container_config(&c, &run(&target, &none, &none)).unwrap_err().message.contains("no service"));
    }

    #[cfg(unix)]
    #[test]
    fn python_probe_runs_the_interpreter_in_a_kept_container() {
        let root = Path::new("/work/proj");
        let target = RunTarget {
            kind: RunTargetKind::Compose,
            compose_files: vec!["compose.yaml".into()],
            service: "web".into(),
            python: "/venv/bin/python".into(),
            run_options: "--rm".into(),
            ..Default::default()
        };
        assert_eq!(
            python_probe_args(&target, root, "openidea-python-1", "print(1)").unwrap().join(" "),
            "compose --file /work/proj/compose.yaml run --no-deps --no-TTY --name openidea-python-1 \
             --label openidea.python-probe=true --entrypoint /venv/bin/python web -c print(1)"
        );
        let target = RunTarget { kind: RunTargetKind::Docker, image: "python:3.12".into(), ..Default::default() };
        assert_eq!(
            python_probe_args(&target, root, "p", "x").unwrap().join(" "),
            "run --name p --label openidea.python-probe=true --entrypoint python3 python:3.12 -c x"
        );
        let ssh = RunTarget { name: "box".into(), ..Default::default() };
        assert!(python_probe_args(&ssh, root, "p", "x").unwrap_err().message.contains("not a container"));
        let empty = RunTarget { kind: RunTargetKind::Compose, name: "c".into(), ..Default::default() };
        assert!(python_probe_args(&empty, root, "p", "x").unwrap_err().message.contains("no service"));
    }

    /// The container's command line of `c` debugged on `target` (after the image).
    #[cfg(unix)]
    fn debugged(target: &RunTarget, c: &RunConfig) -> IdeResult<Vec<String>> {
        let none = BTreeMap::new();
        let mut r = run(target, &none, &none);
        r.debug = Some(ContainerDebug {
            port: 41234,
            bootstrap_dir: Path::new("/data/container-debug"),
            debugpy: Some(Path::new("/data/tools/debugpy/lib")),
        });
        let out = container_config(c, &r)?;
        Ok(out.args)
    }

    #[cfg(unix)]
    #[test]
    fn debug_runs_the_program_under_the_bootstrap() {
        let target = RunTarget { kind: RunTargetKind::Docker, image: "python:3.12".into(), ..Default::default() };
        let boot = "/opt/openidea/debug/openidea_debug.py 41234 /workspaces/proj";
        assert!(DEBUG_BOOTSTRAP.contains(&format!("\"{DEBUG_READY}%d, project folder %s\"")));
        let line = |c: RunConfig| {
            let args = debugged(&target, &c).unwrap();
            let image = args.iter().position(|a| a == "python:3.12").unwrap();
            args[image + 1..].join(" ")
        };
        let args = debugged(&target, &config("python3", &["main.py"])).unwrap().join(" ");
        assert!(
            args.contains(
                "--user 501:20 --publish 127.0.0.1:41234:41234 \
                 --volume /data/container-debug:/opt/openidea/debug:ro \
                 --volume /data/tools/debugpy/lib:/opt/openidea/debugpy-lib:ro python:3.12"
            ),
            "{args}"
        );
        assert_eq!(
            line(config("/work/proj/.venv/bin/python", &["-u", "-X", "dev", "/work/proj/main.py", "a"])),
            format!("python3 -u -X dev {boot} /workspaces/proj/main.py a"),
            "interpreter options stay with the interpreter"
        );
        assert_eq!(line(config("python3", &["-m", "pytest", "-x"])), format!("python3 {boot} -m pytest -x"));
        assert_eq!(line(config("python3", &["-c", "print(1)", "a"])), format!("python3 {boot} -c print(1) a"));
        assert_eq!(
            line(config("/work/proj/.venv/bin/pytest", &["tests"])),
            format!("/workspaces/proj/.venv/bin/python {boot} -m pytest tests"),
            "a console script runs as a module of the interpreter next to it"
        );
        assert_eq!(line(config("uv", &["run", "python", "main.py"])), format!("uv run python {boot} main.py"));
        assert_eq!(line(config("uv", &["run", "pytest", "-x"])), format!("uv run python {boot} -m pytest -x"));
        let custom = RunTarget { python: "/usr/local/bin/python".into(), ..target.clone() };
        let args = debugged(&custom, &config("uvicorn", &["app:app"])).unwrap();
        assert!(args.join(" ").ends_with(&format!("python:3.12 /usr/local/bin/python {boot} -m uvicorn app:app")));

        for (command, args, error) in [
            ("python3", &["-u"][..], "nothing to debug"),
            ("python3", &["-m"][..], "`-m` has no argument"),
            ("uv", &["run", "--no-sync", "python", "main.py"][..], "use `uv run python"),
            ("uv", &["run", "--project", "sub", "python", "main.py"][..], "use `uv run python"),
            ("python manage.py runserver", &[][..], "shell command line"),
        ] {
            let err = debugged(&target, &config(command, args)).unwrap_err();
            assert!(err.message.contains(error), "{command}: {}", err.message);
        }

        // Without the IDE's copy only the bootstrap is mounted (the image brings debugpy).
        let none = BTreeMap::new();
        let mut r = run(&target, &none, &none);
        r.debug =
            Some(ContainerDebug { port: 41234, bootstrap_dir: Path::new("/data/container-debug"), debugpy: None });
        let args = container_config(&config("python3", &["main.py"]), &r).unwrap().args.join(" ");
        assert!(args.contains("openidea/debug:ro python:3.12") && !args.contains("debugpy-lib"), "{args}");
    }

    #[test]
    fn maps_files_printed_in_the_container_through_the_longest_mount() {
        let root = Path::new("project");
        let mounts = [
            (root.to_path_buf(), "/app/".to_owned()),
            (root.join("config").join("prod"), "/app/config".to_owned()),
            (root.join("src"), "/code".to_owned()),
        ];
        assert_eq!(mounted_file("/app/pkg/main.py", &mounts), Some(root.join("pkg").join("main.py")));
        assert_eq!(mounted_file("/app/./main.py", &mounts), Some(root.join("main.py")));
        assert_eq!(mounted_file("/app/config/db.py", &mounts), Some(root.join("config").join("prod").join("db.py")));
        assert_eq!(mounted_file("/code/mypkg/a.py", &mounts), Some(root.join("src").join("mypkg").join("a.py")));
        for outside in ["/application/main.py", "/app", "/app/", "/app/../etc/passwd", "/usr/lib/x.py"] {
            assert_eq!(mounted_file(outside, &mounts), None, "{outside}");
        }
    }

    #[test]
    fn development_servers_listen_on_all_interfaces() {
        let elsewhere = BTreeMap::from([("UVICORN_HOST".to_owned(), "127.0.0.1".to_owned())]);
        let run = |program: &str, args: &[&str]| {
            let mut args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            let mut env = BTreeMap::new();
            let set = |k: &str| elsewhere.get(k).cloned();
            let port = dev_server(program, &mut args, &mut env, &set);
            let env: Vec<String> = env.into_iter().map(|(k, v)| format!("{k}={v}")).collect();
            (port, args.join(" "), env.join(" "))
        };
        let out = |port: Option<u16>, args: &str, env: &str| (port, args.to_owned(), env.to_owned());
        assert_eq!(
            run("python3", &["manage.py", "runserver"]),
            out(Some(8000), "manage.py runserver 0.0.0.0:8000", "")
        );
        assert_eq!(
            run("/usr/bin/python", &["/w/manage.py", "runserver", "--noreload"]),
            out(Some(8000), "/w/manage.py runserver 0.0.0.0:8000 --noreload", "")
        );
        assert_eq!(
            run("python", &["manage.py", "runserver", "--settings", "x.dev", "8001"]),
            out(Some(8001), "manage.py runserver --settings x.dev 0.0.0.0:8001", "")
        );
        assert_eq!(
            run("python", &["manage.py", "runserver", "127.0.0.1:9000"]),
            out(Some(9000), "manage.py runserver 127.0.0.1:9000", "")
        );
        assert_eq!(
            run("python", &["-m", "django", "runserver"]),
            out(Some(8000), "-m django runserver 0.0.0.0:8000", "")
        );
        assert_eq!(run("django-admin", &["runserver"]), out(Some(8000), "runserver 0.0.0.0:8000", ""));
        assert_eq!(run("python", &["-m", "flask", "run"]), out(Some(5000), "-m flask run", "FLASK_RUN_HOST=0.0.0.0"));
        assert_eq!(
            run("flask", &["--app", "web", "run", "--port", "5001"]),
            out(Some(5001), "--app web run --port 5001", "FLASK_RUN_HOST=0.0.0.0")
        );
        assert_eq!(run("flask", &["run", "--host", "::", "-p", "7000"]), out(Some(7000), "run --host :: -p 7000", ""));
        assert_eq!(run("uvicorn", &["app:app", "--port=9001"]), out(Some(9001), "app:app --port=9001", ""));
        assert_eq!(run("fastapi", &["dev", "main.py"]), out(Some(8000), "dev main.py --host 0.0.0.0", ""));
        assert_eq!(run("fastapi", &["run", "main.py"]), out(Some(8000), "run main.py", ""));
        for (program, args) in [
            ("python", &["manage.py", "migrate"][..]),
            ("pytest", &["tests"]),
            ("poetry", &["run", "flask", "db", "upgrade"]),
            ("uv", &["run", "flask", "shell"]),
        ] {
            assert_eq!(run(program, args).0, None, "{program} {args:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn compose_container_root_follows_the_project_bind_mount() {
        let json = r#"{"services": {
            "web": {"volumes": [
                {"type": "volume", "source": "data", "target": "/data"},
                {"type": "bind", "source": "/work", "target": "/src"},
                {"type": "bind", "source": "/work/proj", "target": "/app/"}
            ]},
            "worker": {"volumes": [{"type": "bind", "source": "/work", "target": "/src"}]},
            "db": {}
        }}"#;
        let root = Path::new("/work/proj");
        assert_eq!(compose_container_root(json, "web", root).unwrap(), "/app", "the closest mount wins");
        assert_eq!(
            compose_service(json, "web").unwrap().mounts,
            [("/work".to_owned(), "/src".to_owned()), ("/work/proj".to_owned(), "/app/".to_owned())]
        );
        let served = r#"{"services": {"web": {
            "ports": [{"target": 8000, "published": "8080"}, {"target": 9000}],
            "environment": {"FLASK_RUN_HOST": "127.0.0.1", "EMPTY": null}
        }}}"#;
        let web = compose_service(served, "web").unwrap();
        assert_eq!(web.ports, [(8080, 8000)]);
        assert_eq!(web.environment["FLASK_RUN_HOST"], "127.0.0.1");
        assert_eq!(web.environment["EMPTY"], "");
        assert_eq!(compose_container_root(json, "worker", root).unwrap(), "/src/proj");
        assert!(compose_container_root(json, "db", root).unwrap_err().message.contains("does not mount"));
        assert_eq!(compose_container_root(json, "api", root).unwrap_err().kind, ide_core::error::ErrorKind::NotFound);
    }

    #[test]
    fn names_and_default_folder() {
        assert_eq!(container_name("workspace:a/b:Run app", "k3x"), "openidea-workspace-a-b-Run-app-k3x");
        assert_eq!(default_container_root(Path::new("/work/my proj")), "/workspaces/my-proj");
    }

    #[cfg(unix)]
    #[test]
    fn stop_quotes_the_docker_cli_for_the_shell() {
        assert_eq!(shell_word("/usr/local/bin/docker"), "/usr/local/bin/docker");
        assert_eq!(shell_word("/Volumes/My Apps/docker"), "'/Volumes/My Apps/docker'");
    }
}
