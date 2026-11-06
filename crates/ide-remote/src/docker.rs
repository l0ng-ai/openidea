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
    let command = remote_command(config, target, run.root, run.container_root);
    // Variables go by name (`-e NAME`) so their values stay out of the command line
    // echoed in the console; the docker CLI reads them from its own environment.
    let mut env: BTreeMap<String, String> = run.file_env.clone();
    if matches!(config.kind.as_str(), "python" | "pytest" | "django-test")
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
                "'{}' is a shell command line: only a Python script, module or console script can be debugged in a container",
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

/// The project's folder in the container of a Compose `service`, from the JSON of
/// `docker compose config --format json`: the target of a bind mount of the project
/// or a folder above it.
pub fn compose_container_root(config_json: &str, service: &str, root: &Path) -> IdeResult<String> {
    let model: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| IdeError::internal(format!("cannot read `docker compose config`: {e}")))?;
    let Some(svc) = model.pointer(&format!("/services/{}", service.replace('~', "~0").replace('/', "~1"))) else {
        return Err(IdeError::not_found(format!("the Compose files have no service '{service}'")));
    };
    let mounts = svc.get("volumes").and_then(|v| v.as_array()).into_iter().flatten();
    let mut best: Option<(usize, String)> = None;
    for m in mounts {
        if m.get("type").and_then(|t| t.as_str()) != Some("bind") {
            continue;
        }
        let (Some(source), Some(target)) =
            (m.get("source").and_then(|s| s.as_str()), m.get("target").and_then(|t| t.as_str()))
        else {
            continue;
        };
        let Ok(rel) = root.strip_prefix(source) else { continue };
        let depth = Path::new(source).components().count();
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

        let target = RunTarget { kind: RunTargetKind::Compose, name: "c".into(), ..Default::default() };
        assert!(container_config(&c, &run(&target, &none, &none)).unwrap_err().message.contains("no service"));
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
