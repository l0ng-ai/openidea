//! Python environments: creating virtualenvs and managing packages with pip
//! (or `uv pip` for environments created by uv, which ship without pip).

use crate::exec::{query_in, query_in_cancellable, stream, which};
use crate::{Sdk, bin_dir, exe, venv_of};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PythonPackage {
    pub name: String,
    pub version: String,
    /// The newest release the interpreter can install; only [`list_packages`] with `outdated` sets it.
    #[specta(optional)]
    pub latest_version: Option<String>,
}

/// The tool that creates a new Python environment in "Add Python Interpreter".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum VenvTool {
    /// `base -m venv <location>`.
    Venv,
    /// `uv venv <location> --python <base>` (uv must be on PATH).
    Uv,
    /// `poetry env use <base>` in the project, then `poetry env info --path`.
    Poetry,
    /// `conda create -n <name> -y` for a bare name, else `-p <location>` (conda must be on PATH).
    Conda,
    /// `pipenv --python <base>` in the project (pipenv must be on PATH).
    Pipenv,
    /// `hatch env create <env>` in the project (hatch must be on PATH).
    Hatch,
}

/// Creates a virtualenv at `location` with `tool` and returns its interpreter.
/// `base` is the interpreter uv / venv build on, or the one poetry's / pipenv's / hatch's env uses.
/// `install` also installs the packages the project declares, for the tool that reads them (pipenv).
/// For Hatch, `location` is `<project>/<environment name>`: Hatch decides where the environment goes.
pub fn create_venv(
    tool: VenvTool,
    base: &Path,
    location: &Path,
    install: bool,
    cancel: &CancellationToken,
    on_line: &dyn Fn(String),
) -> IdeResult<Sdk> {
    create_venv_with(tool, base, location, install, which, cancel, on_line)
}

/// [`create_venv`] with the tool lookup injectable (tests fake `uv` / `poetry`).
pub(crate) fn create_venv_with(
    tool: VenvTool,
    base: &Path,
    location: &Path,
    install: bool,
    which: impl Fn(&str) -> Option<PathBuf>,
    cancel: &CancellationToken,
    on_line: &dyn Fn(String),
) -> IdeResult<Sdk> {
    match tool {
        VenvTool::Venv | VenvTool::Uv => {
            if location.join("pyvenv.cfg").is_file() {
                return Err(IdeError::new(
                    ide_core::error::ErrorKind::AlreadyExists,
                    format!("{} already contains a virtual environment", location.display()),
                ));
            }
            if let Some(parent) = location.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let (program, args) = match tool {
                VenvTool::Uv => {
                    let uv = which("uv").ok_or_else(|| {
                        IdeError::unavailable("uv is not installed (install it from https://docs.astral.sh/uv)")
                    })?;
                    (
                        uv,
                        vec![
                            "venv".to_owned(),
                            location.to_string_lossy().into_owned(),
                            "--python".to_owned(),
                            base.to_string_lossy().into_owned(),
                        ],
                    )
                }
                _ => (base.to_path_buf(), venv_args(location)),
            };
            stream(&program, &args, None, &[], cancel, on_line)?;
            let python = location.join(bin_dir()).join(exe("python"));
            crate::discover::python_sdk(&python, "venv", location.parent().and_then(Path::parent))
                .ok_or_else(|| IdeError::internal(format!("{} was not created", python.display())))
        }
        VenvTool::Poetry => create_poetry_env(base, location, &which, cancel, on_line),
        VenvTool::Conda => create_conda_env(base, location, &which, cancel, on_line),
        VenvTool::Pipenv => create_pipenv_env(base, location, install, &which, cancel, on_line),
        VenvTool::Hatch => create_hatch_env(base, location, &which, cancel, on_line),
    }
}

const HATCH_MISSING: &str = "Hatch is not installed (install it from https://hatch.pypa.io)";
const HATCH_SHOW_ARGS: [&str; 5] = ["--no-color", "--no-interactive", "env", "show", "--json"];

/// Hatch's own environments (`hatch-build`, `hatch-test.py3.12`, `hatch-static-analysis`, …).
fn is_internal_hatch_env(name: &str) -> bool {
    name.starts_with("hatch-")
}

/// The environments the project at `root` defines for Hatch (`hatch env show --json`), `default`
/// first, without Hatch's internal ones. Unconfigured projects return an empty list.
pub fn hatch_envs(root: &Path, cancel: &CancellationToken) -> IdeResult<Vec<String>> {
    // Hatch first installs the environment plugins the project requires, which can take a while.
    hatch_envs_with(root, which, Duration::from_secs(120), cancel)
}

pub(crate) fn hatch_envs_with(
    root: &Path,
    which: impl Fn(&str) -> Option<PathBuf>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> IdeResult<Vec<String>> {
    let Some((project, _)) = crate::discover::hatch_project_config(root) else { return Ok(Vec::new()) };
    let hatch = which("hatch").ok_or_else(|| IdeError::unavailable(HATCH_MISSING))?;
    let args = HATCH_SHOW_ARGS.map(str::to_owned);
    // Cancelled when the caller cancels, or when `timeout` passes first.
    let token = cancel.child_token();
    let (done, finished) = std::sync::mpsc::channel::<()>();
    let watchdog = token.clone();
    std::thread::spawn(move || {
        if finished.recv_timeout(timeout) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
            watchdog.cancel();
        }
    });
    let out = stream(&hatch, &args, Some(&project), &[], &token, &|_| {});
    drop(done);
    match out {
        Err(_) if token.is_cancelled() && !cancel.is_cancelled() => Err(IdeError::new(
            ide_core::error::ErrorKind::TimedOut,
            format!("`hatch env show` did not finish within {} seconds", timeout.as_secs()),
        )),
        out => parse_hatch_envs(&out?),
    }
}

fn hatch_find_args(name: &str) -> [&str; 6] {
    ["--no-color", "--no-interactive", "env", "find", "--", name]
}

fn hatch_output_home(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .rev()
        .map(|line| PathBuf::from(line.trim()))
        .find(|home| home.is_absolute() && home.join("pyvenv.cfg").is_file())
}

/// Existing project virtualenvs, including custom locations resolved by Hatch itself.
pub(crate) fn hatch_env_paths(root: &Path, hatch: &Path) -> Option<Vec<(PathBuf, String)>> {
    const TIMEOUT: Duration = Duration::from_secs(4);
    let output = query_in(hatch, &HATCH_SHOW_ARGS, Some(root), &[], TIMEOUT)?;
    let names = parse_hatch_envs(&output).ok()?;
    Some(
        names
            .chunks(4)
            .flat_map(|names| {
                crate::discover::par_map(names, |name| {
                    let output = query_in(hatch, &hatch_find_args(name), Some(root), &[], TIMEOUT)?;
                    let python = hatch_output_home(&output)?.join(bin_dir()).join(exe("python"));
                    python.is_file().then(|| (python, name.clone()))
                })
            })
            .collect(),
    )
}

pub(crate) fn parse_hatch_envs(out: &str) -> IdeResult<Vec<String>> {
    // Skip anything Hatch prints before the JSON object (warnings, the echoed command line).
    let json = out.lines().find(|l| l.trim_start().starts_with('{')).unwrap_or("{}");
    let envs: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(json).map_err(|e| IdeError::internal(format!("unexpected hatch output: {e}")))?;
    let mut names: Vec<String> = envs.into_iter().map(|(name, _)| name).filter(|n| !is_internal_hatch_env(n)).collect();
    names.sort_by_key(|name| name != "default");
    Ok(names)
}

/// An environment that already exists is reused rather than rebuilt. If `base` is another
/// Python version than the environment's, nothing is changed and the error says how to go on.
fn reuse_existing_env(home: &Path, base: &Path, remove: &str) -> IdeResult<()> {
    let short = |version: &str| version.split('.').take(2).collect::<Vec<_>>().join(".");
    let existing = crate::discover::pyvenv_version(&home.join(bin_dir()).join(exe("python")));
    let wanted = query_in(base, &["--version"], None, &[], Duration::from_secs(15))
        .and_then(|v| v.strip_prefix("Python ").map(str::to_owned));
    match (existing.as_deref().map(short), wanted.as_deref().map(short)) {
        (Some(existing), Some(wanted)) if existing != wanted => Err(IdeError::new(
            ide_core::error::ErrorKind::AlreadyExists,
            format!(
                "{} already holds a Python {existing} environment, not Python {wanted} like the base interpreter. \
                 Select it under Existing environment, or remove it first with `{remove}`.",
                home.display()
            ),
        )),
        _ => Ok(()),
    }
}

/// `hatch env create <env>` in the project directory, with `base` as the Python the environment
/// is built on (`HATCH_PYTHON`; an environment that pins its own `python` keeps it). Hatch keeps
/// an environment that exists, whatever `base` is: one on another Python version is refused
/// instead. Then `hatch run` in it prints its prefix, after bringing an environment that already
/// existed up to date: one left half-made by an interrupted creation has no dependencies yet.
fn create_hatch_env(
    base: &Path,
    location: &Path,
    which: &dyn Fn(&str) -> Option<PathBuf>,
    cancel: &CancellationToken,
    on_line: &dyn Fn(String),
) -> IdeResult<Sdk> {
    let project = location
        .parent()
        .filter(|p| p.is_dir())
        .ok_or_else(|| IdeError::invalid("Hatch environments need an open project directory"))?;
    let (project, _) = crate::discover::hatch_project_config(project)
        .ok_or_else(|| IdeError::invalid("This project has no Hatch configuration"))?;
    let hatch = which("hatch").ok_or_else(|| IdeError::unavailable(HATCH_MISSING))?;
    let env = location
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| IdeError::invalid("select a Hatch environment"))?;
    let hatch_python = [("HATCH_PYTHON".to_owned(), base.to_string_lossy().into_owned())];
    let run = |args: &[&str]| {
        let args: Vec<String> =
            ["--no-color", "--no-interactive"].iter().chain(args).map(|a| (*a).to_owned()).collect();
        stream(&hatch, &args, Some(&project), &hatch_python, cancel, on_line)
    };
    let existing = query_in_cancellable(&hatch, &hatch_find_args(&env), &project, &[], Duration::from_secs(30), cancel)
        .and_then(|out| hatch_output_home(&out));
    if let Some(home) = existing {
        reuse_existing_env(&home, base, &format!("hatch env remove {env}"))?;
    }
    run(&["env", "create", &env])?;
    let out = run(&["--env", &env, "run", "python", "-c", "import sys; print(sys.prefix)"])?;
    let home = hatch_output_home(&out).ok_or_else(|| IdeError::internal("hatch created no environment".to_owned()))?;
    let python = home.join(bin_dir()).join(exe("python"));
    crate::discover::hatch_sdk(&python, &project, &env)
        .ok_or_else(|| IdeError::internal(format!("{} was not created", python.display())))
}

/// `poetry env use <base>` in the project directory (the parent of `location`, which the
/// dialog fills with `<root>/.venv` only as a hint — poetry keeps its envs under its own
/// cache), then `poetry env info --path` for the interpreter it made or reused.
fn create_poetry_env(
    base: &Path,
    location: &Path,
    which: &dyn Fn(&str) -> Option<PathBuf>,
    cancel: &CancellationToken,
    on_line: &dyn Fn(String),
) -> IdeResult<Sdk> {
    let poetry = which("poetry")
        .ok_or_else(|| IdeError::unavailable("Poetry is not installed (install it from https://python-poetry.org)"))?;
    let project = location
        .parent()
        .filter(|p| p.is_dir())
        .ok_or_else(|| IdeError::invalid("Poetry environments need an open project directory"))?;
    stream(
        &poetry,
        &["env".to_owned(), "use".to_owned(), base.to_string_lossy().into_owned()],
        Some(project),
        &[],
        cancel,
        on_line,
    )?;
    let home = query_in(&poetry, &["env", "info", "--path"], Some(project), &[], Duration::from_secs(30))
        .map(PathBuf::from)
        .ok_or_else(|| IdeError::internal("poetry created no environment".to_owned()))?;
    let python = home.join(bin_dir()).join(exe("python"));
    crate::discover::python_sdk(&python, "venv", Some(project))
        .ok_or_else(|| IdeError::internal(format!("{} was not created", python.display())))
}

/// Pipenv's environment for the project (`location` is a hint inside it, as for Poetry: pipenv
/// keeps its envs under `WORKON_HOME`). `pipenv --python <base>` creates it when `pipenv --venv`
/// finds none, writing a `Pipfile` (from `requirements.txt` if there is one) when the project
/// has none. `install` then runs `pipenv install --dev` for the packages of the `Pipfile`.
fn create_pipenv_env(
    base: &Path,
    location: &Path,
    install: bool,
    which: &dyn Fn(&str) -> Option<PathBuf>,
    cancel: &CancellationToken,
    on_line: &dyn Fn(String),
) -> IdeResult<Sdk> {
    let pipenv = which("pipenv")
        .ok_or_else(|| IdeError::unavailable("Pipenv is not installed (install it from https://pipenv.pypa.io)"))?;
    let project = location
        .parent()
        .filter(|p| p.is_dir())
        .ok_or_else(|| IdeError::invalid("Pipenv environments need an open project directory"))?;
    // No prompts or spinner, and the project's own environment even when the IDE was
    // started from inside another virtualenv.
    const ENV: [(&str, &str); 3] = [("PIPENV_YES", "1"), ("PIPENV_NOSPIN", "1"), ("PIPENV_IGNORE_VIRTUALENVS", "1")];
    let env = ENV.map(|(k, v)| (k.to_owned(), v.to_owned()));
    let venv = || {
        query_in_cancellable(&pipenv, &["--venv"], project, &ENV, Duration::from_secs(30), cancel)
            .map(PathBuf::from)
            .filter(|home| home.join("pyvenv.cfg").is_file())
    };
    match venv() {
        Some(home) => reuse_existing_env(&home, base, "pipenv --rm")?,
        None => {
            let args = ["--python".to_owned(), base.to_string_lossy().into_owned()];
            stream(&pipenv, &args, Some(project), &env, cancel, on_line)?;
        }
    }
    // Decided after creation: pipenv may just have written the `Pipfile`, or found one above the project.
    let pipfile_dir = crate::discover::pipfile_dir(project);
    if install && pipfile_dir.is_some() {
        stream(&pipenv, &["install".to_owned(), "--dev".to_owned()], Some(project), &env, cancel, on_line)?;
    }
    let home = venv().ok_or_else(|| IdeError::internal("pipenv created no environment".to_owned()))?;
    // Pipenv records the project only when it creates the environment: one it reuses after an
    // interrupted creation has no `.project`, and detection would not know whose it is.
    let record = home.join(".project");
    if !record.exists() {
        let owner = pipfile_dir.as_deref().unwrap_or(project);
        let _ = std::fs::write(record, owner.to_string_lossy().as_bytes());
    }
    let python = home.join(bin_dir()).join(exe("python"));
    crate::discover::python_sdk(&python, "pipenv", Some(project))
        .ok_or_else(|| IdeError::internal(format!("{} was not created", python.display())))
}

/// `conda create -n <name> -y` builds a named environment in conda's envs directory when
/// `location` is a bare name, `conda create -p <location> -y` one at that prefix otherwise.
/// `base` pins the Python version (`python=<major.minor>`) when it reports one, so the
/// created env matches the interpreter the user picked rather than conda's default.
fn create_conda_env(
    base: &Path,
    location: &Path,
    which: &dyn Fn(&str) -> Option<PathBuf>,
    cancel: &CancellationToken,
    on_line: &dyn Fn(String),
) -> IdeResult<Sdk> {
    // A bare name is a named environment in conda's own envs directory (`conda create -n`).
    let name = conda_env_name(location);
    if name.is_none() && location.join("conda-meta").is_dir() {
        return Err(IdeError::new(
            ide_core::error::ErrorKind::AlreadyExists,
            format!("{} already contains a conda environment", location.display()),
        ));
    }
    let conda = which("conda")
        .ok_or_else(|| IdeError::unavailable("conda is not installed (install it from https://docs.conda.io)"))?;
    let prefixes = || {
        query_in(&conda, &["env", "list"], None, &[], Duration::from_secs(15))
            .map(|list| crate::discover::conda_env_list_prefixes(&list))
            .unwrap_or_default()
    };
    if let Some(name) = name {
        if prefixes().iter().any(|p| p.file_name().is_some_and(|n| n == name)) {
            return Err(IdeError::new(
                ide_core::error::ErrorKind::AlreadyExists,
                format!("A conda environment named {name} already exists"),
            ));
        }
    } else if let Some(parent) = location.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let version = query_in(base, &["--version"], None, &[], Duration::from_secs(15))
        .and_then(|v| v.strip_prefix("Python ").map(str::to_owned));
    stream(&conda, &conda_create_args(location, version.as_deref()), None, &[], cancel, on_line)?;
    let prefix = match name {
        Some(name) => prefixes()
            .into_iter()
            .find(|p| p.file_name().is_some_and(|n| n == name))
            .ok_or_else(|| IdeError::internal(format!("conda did not report the environment {name}")))?,
        None => location.to_path_buf(),
    };
    // Conda keeps `python.exe` at the prefix root on Windows, not under Scripts/.
    let python = [prefix.join(exe("python")), prefix.join(bin_dir()).join(exe("python"))]
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| prefix.join(bin_dir()).join(exe("python")));
    crate::discover::python_sdk(&python, "conda", prefix.parent().and_then(Path::parent))
        .ok_or_else(|| IdeError::internal(format!("{} was not created", python.display())))
}

/// The environment name when `location` is a bare name rather than a path.
fn conda_env_name(location: &Path) -> Option<&str> {
    let text = location.to_str()?;
    (!text.is_empty() && !text.contains(['/', '\\', ':']) && text != "." && text != "..").then_some(text)
}

/// `conda create -n <name>` for a bare name, `-p <prefix>` for a path, with the base's `major.minor` Python.
pub(crate) fn conda_create_args(location: &Path, version: Option<&str>) -> Vec<String> {
    let mut args = match conda_env_name(location) {
        Some(name) => vec!["create".to_owned(), "-n".to_owned(), name.to_owned()],
        None => vec!["create".to_owned(), "-p".to_owned(), location.to_string_lossy().into_owned()],
    };
    args.push("-y".to_owned());
    let short = version.map(|v| v.split('.').take(2).collect::<Vec<_>>().join(".")).unwrap_or_default();
    if !short.is_empty() {
        args.push(format!("python={short}"));
    }
    args
}

/// Arguments of `base -m venv location`. `-I` (isolated mode) keeps the working
/// directory off `sys.path`: a project's `logging.py` or `typing.py` there would
/// otherwise shadow the standard library modules venv imports. (`-P` does just
/// that but needs Python 3.11.)
pub(crate) fn venv_args(location: &Path) -> Vec<String> {
    vec!["-I".to_owned(), "-m".to_owned(), "venv".to_owned(), location.to_string_lossy().into_owned()]
}

/// A fresh, empty, private directory to run `python -m …` / `python -c …` in. Python
/// puts the working directory first on `sys.path` for those, and the IDE's own (or a
/// project's) could hold modules that shadow the standard library or pip. Not `-I`:
/// that also drops the user site, hiding `pip install --user` packages. `None` (the
/// inherited directory) if it cannot be created.
pub(crate) fn neutral_dir() -> Option<tempfile::TempDir> {
    tempfile::Builder::new().prefix("openidea-python-").tempdir().ok()
}

/// How packages of an interpreter are managed.
enum Installer {
    Pip,
    /// `uv pip … --python <interpreter>`.
    Uv(PathBuf),
}

fn has_pip(python: &Path) -> bool {
    let dir = neutral_dir();
    query_in(python, &["-m", "pip", "--version"], dir.as_ref().map(|d| d.path()), &[], Duration::from_secs(10))
        .is_some()
}

fn installer(python: &Path) -> IdeResult<Installer> {
    if has_pip(python) {
        return Ok(Installer::Pip);
    }
    if let Some(uv) = which("uv") {
        return Ok(Installer::Uv(uv));
    }
    Err(IdeError::unavailable(format!(
        "pip is not available for {} (install it with `{} -m ensurepip`, or install uv)",
        python.display(),
        python.display()
    )))
}

/// `(program, args)` for a pip sub-command.
fn pip_command(python: &Path, installer: &Installer, sub: &[&str]) -> (PathBuf, Vec<String>) {
    match installer {
        Installer::Pip => {
            let mut args = vec!["-m".into(), "pip".into()];
            args.extend(sub.iter().map(|s| (*s).to_owned()));
            args.push("--disable-pip-version-check".into());
            (python.to_path_buf(), args)
        }
        Installer::Uv(uv) => {
            let mut args =
                vec!["pip".to_owned(), sub[0].to_owned(), "--python".into(), python.to_string_lossy().into_owned()];
            // uv has no `-y`: uninstall never prompts.
            args.extend(sub[1..].iter().filter(|s| **s != "-y").map(|s| (*s).to_owned()));
            (uv.clone(), args)
        }
    }
}

/// Environment for pip runs: the venv activated, so console scripts land in it.
fn pip_env(python: &Path) -> Vec<(String, String)> {
    venv_of(python).map(|v| vec![("VIRTUAL_ENV".to_owned(), v.to_string_lossy().into_owned())]).unwrap_or_default()
}

/// How long the check for newer releases may take in all: offline, pip waits for every
/// package in turn.
const OUTDATED_LIMIT: Duration = Duration::from_secs(120);

/// Installed packages (`pip list --format=json`), sorted by name. With `outdated`, only the
/// ones the configured index has a newer release of (`--outdated`, which goes to the network).
pub fn list_packages(python: &Path, outdated: bool, cancel: &CancellationToken) -> IdeResult<Vec<PythonPackage>> {
    if !python.is_file() {
        return Err(IdeError::not_found(format!("{} does not exist", python.display())));
    }
    let installer = installer(python)?;
    let mut env = pip_env(python);
    if matches!(installer, Installer::Pip) {
        // Quiet mode suppresses the JSON package list, including with --format json.
        env.push(("PIP_QUIET".into(), "0".into()));
    }
    let mut sub = vec!["list", "--format", "json"];
    if outdated {
        sub.push("--outdated");
        // One retry, so a request that fails always prints pip's retry warning (`retries = 0`
        // in pip.conf would hide it); the command line wins over pip.conf and `PIP_RETRIES`.
        if matches!(installer, Installer::Pip) {
            sub.extend(["--retries", "1", "--timeout", "5"]);
        }
    }
    let (program, args) = pip_command(python, &installer, &sub);
    let dir = neutral_dir();
    let run =
        |cancel: &CancellationToken| stream(&program, &args, dir.as_ref().map(|d| d.path()), &env, cancel, &|_| {});
    let out = if outdated { with_deadline(cancel, OUTDATED_LIMIT, run)? } else { run(cancel)? };
    if outdated && pip_request_failed(&out) {
        return Err(IdeError::unavailable("pip could not reach the package index for every package"));
    }
    let mut packages = parse_pip_list(&out)?;
    packages.sort_by_key(|p| p.name.to_lowercase());
    Ok(packages)
}

/// Runs `work` with a token that is also cancelled after `limit`; that is reported as timed out.
pub(crate) fn with_deadline<T>(
    cancel: &CancellationToken,
    limit: Duration,
    work: impl FnOnce(&CancellationToken) -> IdeResult<T>,
) -> IdeResult<T> {
    let token = cancel.child_token();
    let (done, finished) = std::sync::mpsc::channel::<()>();
    let timer = std::thread::spawn({
        let token = token.clone();
        move || {
            if finished.recv_timeout(limit) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
                token.cancel();
            }
        }
    });
    let result = work(&token);
    drop(done);
    let _ = timer.join();
    match result {
        Err(e) if token.is_cancelled() && !cancel.is_cancelled() => Err(IdeError::new(
            ide_core::error::ErrorKind::TimedOut,
            format!("timed out after {} s: {e}", limit.as_secs()),
        )),
        other => other,
    }
}

/// pip reports a package it could not look up as up to date: exit 0, the package left out of
/// the list, and only its retry warnings. A warning means a request failed, so the list may
/// be missing newer releases. (uv fails instead.)
pub(crate) fn pip_request_failed(out: &str) -> bool {
    out.lines().any(|l| l.starts_with("WARNING: Retrying ("))
}

pub(crate) fn parse_pip_list(out: &str) -> IdeResult<Vec<PythonPackage>> {
    #[derive(Deserialize)]
    struct Listed {
        name: String,
        version: String,
        latest_version: Option<String>,
    }
    // Skip the echoed command line and any warnings before the JSON array.
    let json = out
        .lines()
        .find(|l| l.trim_start().starts_with('['))
        .ok_or_else(|| IdeError::internal("unexpected pip output: missing package list"))?;
    let listed: Vec<Listed> =
        serde_json::from_str(json).map_err(|e| IdeError::internal(format!("unexpected pip output: {e}")))?;
    Ok(listed
        .into_iter()
        .map(|p| PythonPackage { name: p.name, version: p.version, latest_version: p.latest_version })
        .collect())
}

/// A requirement naming a local path (`.`, `./pkg`, `../lib[dev]`) made absolute
/// against `base` (the project root): pip runs in [`neutral_dir`], not the project.
pub(crate) fn resolve_requirement(requirement: &str, base: Option<&Path>) -> IdeResult<String> {
    if !requirement.starts_with('.') {
        return Ok(requirement.to_owned());
    }
    let base = base.ok_or_else(|| IdeError::invalid("a relative path needs an open project"))?;
    Ok(base.join(requirement).to_string_lossy().into_owned())
}

/// Environments with a pip run in progress, by [`environment_key`].
static BUSY: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

/// Holds an environment for one pip run; two runs at once can leave it half installed.
pub(crate) struct Busy(PathBuf);

impl Busy {
    pub(crate) fn take(python: &Path) -> IdeResult<Self> {
        let key = environment_key(python);
        let mut busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        if busy.contains(&key) {
            return Err(IdeError::unavailable("another package operation is running for this interpreter"));
        }
        busy.push(key.clone());
        Ok(Self(key))
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.lock().unwrap_or_else(|e| e.into_inner()).retain(|k| *k != self.0);
    }
}

/// A virtualenv's folder (its `python` and `python3` are one environment), else the interpreter.
fn environment_key(python: &Path) -> PathBuf {
    venv_of(python).unwrap_or_else(|| python.to_path_buf())
}

/// Installs (or upgrades, with `upgrade`) a requirement such as `requests` or `django==5.0`;
/// relative paths (`./pkg`) are resolved against `project_root`.
pub fn install_package(
    python: &Path,
    requirement: &str,
    upgrade: bool,
    project_root: Option<&Path>,
    cancel: &CancellationToken,
    on_line: &dyn Fn(String),
) -> IdeResult<()> {
    let requirement = requirement.trim();
    if requirement.is_empty() || requirement.starts_with('-') {
        return Err(IdeError::invalid("enter a package name or requirement"));
    }
    let requirement = resolve_requirement(requirement, project_root)?;
    let installer = installer(python)?;
    let _busy = Busy::take(python)?;
    let mut sub = vec!["install"];
    if upgrade {
        sub.push("--upgrade");
    }
    sub.push(&requirement);
    let (program, args) = pip_command(python, &installer, &sub);
    let dir = neutral_dir();
    stream(&program, &args, dir.as_ref().map(|d| d.path()), &pip_env(python), cancel, on_line).map(|_| ())
}

/// Run by the interpreter itself, so markers and PEP 440 specifiers are judged as pip would:
/// prints, per requirement of `argv[1]` (a JSON list), `null` when satisfied or not applicable
/// there, else `{"installed": <version or null>}`.
const CHECK_REQUIREMENTS: &str = r#"
import json, re, sys
try:
    from packaging.requirements import Requirement
except Exception:
    try:
        from pip._vendor.packaging.requirements import Requirement
    except Exception:
        Requirement = None
from importlib import metadata
norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()
installed = {}
for d in metadata.distributions():
    name = d.metadata["Name"]
    if name:
        installed.setdefault(norm(name), d.version)
out = []
for line in json.loads(sys.argv[1]):
    try:
        if Requirement:
            r = Requirement(line)
            name, spec, applies = r.name, r.specifier, r.marker is None or r.marker.evaluate({"extra": ""})
        else:
            # Without packaging only names are compared; a marker can't be judged.
            name, spec, applies = re.match(r"[A-Za-z0-9._-]+", line).group(0), None, ";" not in line
        version = installed.get(norm(name))
        if not applies or (version is not None and (spec is None or spec.contains(version, prereleases=True))):
            out.append(None)
        else:
            out.append({"installed": version})
    except Exception:
        out.append(None)
print(json.dumps(out))
"#;

#[derive(Debug, Deserialize, PartialEq)]
pub struct Unsatisfied {
    /// The version installed that misses the specifier; `None` when not installed.
    pub installed: Option<String>,
}

/// Which of `requirements` (PEP 508 strings) `python` doesn't satisfy, in order;
/// `None` for satisfied ones, for ones whose marker excludes this interpreter, and
/// for ones it can't parse.
pub fn unsatisfied_requirements(
    python: &Path,
    requirements: &[&str],
    cancel: &CancellationToken,
) -> IdeResult<Vec<Option<Unsatisfied>>> {
    let list = serde_json::to_string(requirements).map_err(|e| IdeError::internal(e.to_string()))?;
    let dir = neutral_dir().ok_or_else(|| IdeError::internal("no temporary directory"))?;
    let out = query_in_cancellable(
        python,
        &["-c", CHECK_REQUIREMENTS, &list],
        dir.path(),
        &[],
        Duration::from_secs(20),
        cancel,
    );
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let out =
        out.ok_or_else(|| IdeError::unavailable(format!("cannot check requirements with {}", python.display())))?;
    let json = out.lines().rev().find(|l| l.starts_with('[')).unwrap_or("");
    let result: Vec<Option<Unsatisfied>> =
        serde_json::from_str(json).map_err(|e| IdeError::internal(format!("unexpected output: {e}")))?;
    if result.len() != requirements.len() {
        return Err(IdeError::internal("unexpected output: wrong number of results"));
    }
    Ok(result)
}

pub fn uninstall_package(
    python: &Path,
    name: &str,
    cancel: &CancellationToken,
    on_line: &dyn Fn(String),
) -> IdeResult<()> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') {
        return Err(IdeError::invalid("no package selected"));
    }
    let installer = installer(python)?;
    let _busy = Busy::take(python)?;
    let (program, args) = pip_command(python, &installer, &["uninstall", "-y", name]);
    let dir = neutral_dir();
    stream(&program, &args, dir.as_ref().map(|d| d.path()), &pip_env(python), cancel, on_line).map(|_| ())
}

/// A package index other than PyPI that installing from `python` uses, as configured for pip
/// (`pip config list`, `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL`) or for uv (its environment
/// variables, `uv.toml`, `[tool.uv]` in the project's `pyproject.toml`). Package names should
/// then not be sent to PyPI unasked: a private package may have a public namesake.
pub fn configured_index(
    python: &Path,
    project_root: Option<&Path>,
    cancel: &CancellationToken,
) -> IdeResult<Option<String>> {
    let env = |key: &str| std::env::var(key).ok().and_then(|v| custom_index_url(&v).map(str::to_owned));
    for key in ["PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL"] {
        if let Some(url) = env(key) {
            return Ok(Some(url));
        }
    }
    match installer(python)? {
        Installer::Pip => {
            let (program, args) = pip_command(python, &Installer::Pip, &["config", "list"]);
            let dir = neutral_dir();
            let out = stream(&program, &args, dir.as_ref().map(|d| d.path()), &pip_env(python), cancel, &|_| {})?;
            Ok(pip_config_index(&out))
        }
        Installer::Uv(_) => {
            for key in ["UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_DEFAULT_INDEX", "UV_INDEX"] {
                if let Some(url) = env(key) {
                    return Ok(Some(url));
                }
            }
            let mut files: Vec<PathBuf> = Vec::new();
            if let Some(root) = project_root {
                files.push(root.join("uv.toml"));
                files.push(root.join("pyproject.toml"));
            }
            if let Some(config) = std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
            {
                files.push(config.join("uv/uv.toml"));
            }
            if let Some(config) = dirs::config_dir() {
                files.push(config.join("uv/uv.toml"));
            }
            files.push(PathBuf::from("/etc/uv/uv.toml"));
            Ok(files.iter().find_map(|f| uv_config_index(f.file_name()?.to_str()?, &std::fs::read_to_string(f).ok()?)))
        }
    }
}

fn custom_index_url(value: &str) -> Option<&str> {
    value.split_whitespace().find(|value| {
        !url::Url::parse(value)
            .is_ok_and(|url| url.scheme() == "https" && matches!(url.host_str(), Some("pypi.org" | "pypi.python.org")))
    })
}

/// The first non-PyPI `index-url` / `extra-index-url` in `pip config list` output
/// (`global.index-url='https://…'`, `:env:.extra-index-url='…'`).
pub(crate) fn pip_config_index(out: &str) -> Option<String> {
    out.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if !key.ends_with(".index-url") && !key.ends_with(".extra-index-url") {
            return None;
        }
        custom_index_url(value.trim().trim_matches(['\'', '"'])).map(str::to_owned)
    })
}

/// An index configured in a uv config file: `index-url`, `extra-index-url` or `[[index]]`
/// in `uv.toml`, the same under `[tool.uv]` in `pyproject.toml`.
pub(crate) fn uv_config_index(file_name: &str, text: &str) -> Option<String> {
    let doc: toml::Table = text.parse().ok()?;
    let uv = if file_name == "pyproject.toml" { doc.get("tool")?.get("uv")?.as_table()? } else { &doc };
    let extras = uv.get("extra-index-url").and_then(toml::Value::as_array);
    let indexes = uv.get("index").and_then(toml::Value::as_array);
    uv.get("index-url")
        .into_iter()
        .chain(extras.into_iter().flatten())
        .chain(indexes.into_iter().flatten().filter_map(|index| index.get("url")))
        .filter_map(toml::Value::as_str)
        .find_map(custom_index_url)
        .map(str::to_owned)
}
