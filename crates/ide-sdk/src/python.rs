//! Python environments: creating virtualenvs and managing packages with pip
//! (or `uv pip` for environments created by uv, which ship without pip).

use crate::exec::{query_in, stream, which};
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
}

/// Creates a virtualenv at `location` with `base -m venv` and returns its interpreter.
pub fn create_venv(
    base: &Path,
    location: &Path,
    cancel: &CancellationToken,
    on_line: &dyn Fn(String),
) -> IdeResult<Sdk> {
    if location.join("pyvenv.cfg").is_file() {
        return Err(IdeError::new(
            ide_core::error::ErrorKind::AlreadyExists,
            format!("{} already contains a virtual environment", location.display()),
        ));
    }
    if let Some(parent) = location.parent() {
        std::fs::create_dir_all(parent)?;
    }
    stream(base, &venv_args(location), None, &[], cancel, on_line)?;
    let python = location.join(bin_dir()).join(exe("python"));
    crate::discover::python_sdk(&python, "venv", location.parent().and_then(Path::parent))
        .ok_or_else(|| IdeError::internal(format!("{} was not created", python.display())))
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

/// Installed packages (`pip list --format=json`), sorted by name.
pub fn list_packages(python: &Path, cancel: &CancellationToken) -> IdeResult<Vec<PythonPackage>> {
    if !python.is_file() {
        return Err(IdeError::not_found(format!("{} does not exist", python.display())));
    }
    let installer = installer(python)?;
    let (program, args) = pip_command(python, &installer, &["list", "--format", "json"]);
    let dir = neutral_dir();
    let out = stream(&program, &args, dir.as_ref().map(|d| d.path()), &pip_env(python), cancel, &|_| {})?;
    let mut packages = parse_pip_list(&out)?;
    packages.sort_by_key(|p| p.name.to_lowercase());
    Ok(packages)
}

pub(crate) fn parse_pip_list(out: &str) -> IdeResult<Vec<PythonPackage>> {
    // Skip the echoed command line and any warnings before the JSON array.
    let json = out.lines().find(|l| l.trim_start().starts_with('[')).unwrap_or("[]");
    serde_json::from_str(json).map_err(|e| IdeError::internal(format!("unexpected pip output: {e}")))
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
    let mut sub = vec!["install"];
    if upgrade {
        sub.push("--upgrade");
    }
    sub.push(&requirement);
    let (program, args) = pip_command(python, &installer, &sub);
    let dir = neutral_dir();
    stream(&program, &args, dir.as_ref().map(|d| d.path()), &pip_env(python), cancel, on_line).map(|_| ())
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
    let (program, args) = pip_command(python, &installer, &["uninstall", "-y", name]);
    let dir = neutral_dir();
    stream(&program, &args, dir.as_ref().map(|d| d.path()), &pip_env(python), cancel, on_line).map(|_| ())
}
