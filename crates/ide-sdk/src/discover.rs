//! Finding installed interpreters and toolchains.

use crate::exec::{executables_in, query, search_path, which};
use crate::python::hatch_env_paths;
use crate::{Sdk, SdkKind, bin_dir, exe, home_dir, pinned, venv_of};
use ide_core::process::{host_var_os, host_var_os_in};
use ide_core::version_managers::{self, Tool};
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

const VERSION_TIMEOUT: Duration = Duration::from_secs(4);
/// `conda env list` starts conda's own Python and reports the frozen state of every
/// registered prefix — seconds even on a warm machine (26.x measured 2–3 s), which a
/// `--version` budget cannot spare (#3729).
const CONDA_ENV_LIST_TIMEOUT: Duration = Duration::from_secs(12);

/// Installed SDKs of `kind`, project-local ones (`root`) first. Blocking: runs
/// `--version` queries in parallel.
pub fn detect(kind: SdkKind, root: Option<&Path>) -> Vec<Sdk> {
    let mut out = match kind {
        SdkKind::Python => python(root, which),
        SdkKind::Node => node(),
        SdkKind::Php => php(),
        SdkKind::PackageManager => package_managers(),
        SdkKind::Rust => rust(),
        SdkKind::Go => go(),
        SdkKind::TypeScript => typescript(root),
        SdkKind::Jdk => jdk(),
        SdkKind::Maven => maven(),
        SdkKind::Ruby => crate::ruby::detect(root),
        SdkKind::Zig => zig(),
        SdkKind::Dotnet => dotnet(),
        SdkKind::Flutter => crate::flutter::detect(),
    };
    if let Some(root) = root {
        pinned_first(&mut out, kind, root);
    }
    out
}

fn tool_of(kind: SdkKind) -> Option<Tool> {
    match kind {
        SdkKind::Python => Some(Tool::Python),
        SdkKind::Node => Some(Tool::Node),
        SdkKind::Go => Some(Tool::Go),
        SdkKind::Jdk => Some(Tool::Java),
        SdkKind::Maven => Some(Tool::Maven),
        SdkKind::Ruby => Some(Tool::Ruby),
        SdkKind::Zig => Some(Tool::Zig),
        SdkKind::Php
        | SdkKind::PackageManager
        | SdkKind::Rust
        | SdkKind::TypeScript
        | SdkKind::Dotnet
        | SdkKind::Flutter => None,
    }
}

/// Moves the install the project pins for mise / asdf after the project's own SDKs
/// (virtualenvs), ahead of the rest.
fn pinned_first(sdks: &mut Vec<Sdk>, kind: SdkKind, root: &Path) {
    let Some((dir, _)) = tool_of(kind).and_then(|t| pinned::pinned_install(root, t)) else { return };
    let Some(i) = sdks.iter().position(|s| s.path.starts_with(&dir)) else { return };
    let at = sdks.iter().take_while(|s| matches!(s.source.as_str(), "venv" | "pipenv" | "hatch")).count().min(i);
    let sdk = sdks.remove(i);
    sdks.insert(at, sdk);
}

/// Runs `f` over `items` on scoped threads (version queries spawn processes).
pub(crate) fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> Option<R> + Sync) -> Vec<R> {
    std::thread::scope(|s| {
        let handles: Vec<_> = items.iter().map(|item| s.spawn(|| f(item))).collect();
        handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    })
}

fn dedupe_by_real_path(paths: Vec<(PathBuf, &'static str)>) -> Vec<(PathBuf, &'static str)> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|(p, _)| p.is_file() && seen.insert(p.canonicalize().unwrap_or_else(|_| p.clone())))
        .collect()
}

// ------------------------------------------------------------------ python

/// Project-local virtualenv directories checked by auto-detection, in order.
pub(crate) const PROJECT_VENVS: [&str; 4] = [".venv", "venv", "env", ".env"];

/// `<root>/<venv>/bin/python` of the first project virtualenv or pixi environment, else the
/// interpreter of the project's Pipenv environment or its `default` Hatch environment, in that order.
pub(crate) fn project_venv_python(root: &Path) -> Option<PathBuf> {
    PROJECT_VENVS
        .iter()
        .map(|v| root.join(v))
        .filter(|v| v.join("pyvenv.cfg").is_file())
        .map(|v| v.join(bin_dir()).join(exe("python")))
        .find(|p| p.is_file())
        .or_else(|| {
            subdirs(&root.join(".pixi/envs")).iter().find_map(|env| {
                [env.join(exe("python")), env.join("bin").join(exe("python"))].into_iter().find(|p| p.is_file())
            })
        })
        .or_else(|| pipenv_env_python(root))
        .or_else(|| hatch_default_python(root))
}

/// Pipenv's active workon home first, followed by the other conventional location.
fn workon_homes(home: &Path, env: impl Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let var = |key: &str| env(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    let data = var("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share"));
    let mut defaults = [home.join(".virtualenvs"), data.join("virtualenvs")];
    if !cfg!(windows) {
        defaults.swap(0, 1);
    }
    var("WORKON_HOME").into_iter().chain(defaults).collect()
}

/// How many folders pipenv searches for a `Pipfile`, the project's own and those above it
/// (`PIPENV_MAX_DEPTH`, 10 by default).
const PIPFILE_MAX_DEPTH: usize = 10;

/// The folder of the `Pipfile` pipenv uses for a project opened at `root`: the nearest one in
/// `root` or the folders above it, searched as pipenv does.
pub(crate) fn pipfile_dir(root: &Path) -> Option<PathBuf> {
    root.ancestors().take(PIPFILE_MAX_DEPTH).find(|dir| dir.join("Pipfile").is_file()).map(Path::to_path_buf)
}

/// The folder name pipenv gives the environment of the project whose `Pipfile` is in `dir`
/// (`venv_locator._get_virtualenv_hash`): the folder's name with shell-special characters
/// replaced and cut to 42 characters, `-`, and the URL-safe base64 of the first 6 bytes of
/// the SHA-256 of the `Pipfile` path.
pub(crate) fn pipenv_env_name(dir: &Path) -> String {
    use base64::Engine;
    use sha2::Digest;
    let name: String = (dir.file_name().unwrap_or_default().to_string_lossy().chars())
        .map(|c| if " &$`!*@\"()[]\\\r\n\t".contains(c) { '_' } else { c })
        .take(42)
        .collect();
    let digest = sha2::Sha256::digest(dir.join("Pipfile").to_string_lossy().as_bytes());
    format!("{name}-{}", base64::engine::general_purpose::URL_SAFE.encode(&digest[..6]))
}

/// The project a Pipenv virtualenv belongs to. Pipenv records the project folder in
/// `<venv>/.project`; virtualenvwrapper does too, so the environment must also carry the
/// name pipenv derives from that project's `Pipfile`, or be the project's own `.venv`.
fn pipenv_project(venv: &Path) -> Option<PathBuf> {
    let project = PathBuf::from(std::fs::read_to_string(venv.join(".project")).ok()?.trim());
    let named = venv.file_name().is_some_and(|name| *name.to_string_lossy() == pipenv_env_name(&project));
    (project.is_absolute() && project.join("Pipfile").is_file() && (named || venv == project.join(".venv")))
        .then_some(project)
}

/// The interpreter of the Pipenv environment `pipenv --venv` names for the project at `root`,
/// found without starting pipenv, which takes about a second.
fn pipenv_env_python(root: &Path) -> Option<PathBuf> {
    let dir = pipfile_dir(root)?;
    let var = |key: &str| host_var_os_in(&dir, key);
    let homes = home_dir().map(|home| workon_homes(&home, var)).unwrap_or_default();
    pipenv_env_in(&dir, &homes, var("PIPENV_CUSTOM_VENV_NAME").as_deref())
}

/// A project-local environment, an explicitly selected path or name, or Pipenv's hashed name.
fn pipenv_env_in(dir: &Path, homes: &[PathBuf], custom_name: Option<&OsStr>) -> Option<PathBuf> {
    let dot_venv = dir.join(".venv");
    let python_in = |env: &Path| {
        let python = env.join(bin_dir()).join(exe("python"));
        (env.join("pyvenv.cfg").is_file() && python.is_file()).then_some(python)
    };
    if dot_venv.is_file() {
        let pointer = std::fs::read_to_string(&dot_venv).ok()?;
        let pointer = pointer.trim();
        if !pointer.is_empty() {
            let path = Path::new(pointer);
            let components = path.components().filter(|part| *part != std::path::Component::CurDir);
            let home = if components.count() > 1 || pointer.ends_with(std::path::is_separator) {
                dir.join(path)
            } else {
                homes.first()?.join(path)
            };
            return python_in(&dunce::canonicalize(home).ok()?);
        }
    }
    if let Some(python) = python_in(&dot_venv) {
        return Some(python);
    }
    if let Some(name) = custom_name.filter(|name| !name.is_empty()) {
        let path = Path::new(name);
        return if path.is_absolute() { python_in(path) } else { python_in(&homes.first()?.join(path)) };
    }

    // Pipenv hashes the path it was started in, which may or may not have its symlinks resolved.
    let mut names: Vec<String> = [Some(dir.to_path_buf()), dunce::canonicalize(dir).ok()]
        .into_iter()
        .flatten()
        .map(|d| pipenv_env_name(&d))
        .collect();
    names.dedup();
    homes.iter().flat_map(|home| names.iter().map(move |name| home.join(name))).find_map(|home| python_in(&home))
}

/// `/usr/bin/python3` on macOS is a stub that opens an installer dialog when
/// the Command Line Tools are missing; never run it then.
fn usable(path: &Path) -> bool {
    if cfg!(target_os = "macos") && path.starts_with("/usr/bin") {
        return Path::new("/Library/Developer/CommandLineTools/usr/bin").is_dir()
            || Path::new("/Applications/Xcode.app").is_dir();
    }
    true
}

fn is_python_name(name: &str) -> bool {
    let name = name.strip_suffix(".exe").unwrap_or(name);
    let Some(rest) = name.strip_prefix("python") else { return false };
    rest.is_empty()
        || rest == "3"
        || rest.strip_prefix("3.").is_some_and(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
}

/// Prefixes named by `conda env list`: `base * /opt/conda`, `myenv  /opt/conda/envs/myenv`,
/// a `--prefix` env shown as a bare path, comment lines skipped (#2240).
pub(crate) fn conda_env_list_prefixes(output: &str) -> Vec<PathBuf> {
    output
        .lines()
        .map(|l| l.trim_start_matches(['#', '*', ' ']).trim_end())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            // `name   /path` or a bare `/path` (a --prefix env shows no name): the path
            // starts at the first rooted prefix — a drive letter, '/', '~' or '\\\\' —
            // so names and the stripped "# conda environments:" header never leak, and
            // paths with spaces (C:\\Program Files\\...) stay whole.
            let bytes = l.as_bytes();
            let drive = (0..bytes.len().saturating_sub(2))
                .filter(|&i| {
                    bytes[i].is_ascii_alphabetic()
                        && bytes[i + 1] == b':'
                        && (bytes[i + 2] == b'\\' || bytes[i + 2] == b'/')
                })
                .map(Some);
            let start = [l.find(['/', '~']), l.find("\\\\")].into_iter().chain(drive).flatten().min();
            start.map(|i| PathBuf::from(l[i..].trim()))
        })
        .collect()
}

/// Prefixes from conda's `~/.conda/environments.txt` registry: one absolute path per
/// line, blanks and `#` comments skipped (#3729).
fn conda_environments_txt_prefixes(output: &str) -> Vec<PathBuf> {
    output.lines().map(|l| l.trim()).filter(|l| !l.is_empty() && !l.starts_with('#')).map(PathBuf::from).collect()
}

/// The host's directory conventions; a parameter so tests cover every platform.
#[derive(Clone, Copy)]
enum Host {
    Windows,
    Mac,
    Unix,
}

impl Host {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Unix
        }
    }
}

/// Where Poetry creates virtualenvs: `POETRY_VIRTUALENVS_PATH`, else `virtualenvs` in its
/// cache dir — `POETRY_CACHE_DIR`, else `%LOCALAPPDATA%\pypoetry\Cache` (Windows),
/// `~/Library/Caches/pypoetry` (macOS) or `$XDG_CACHE_HOME/pypoetry` / `~/.cache/pypoetry`.
fn poetry_venv_dirs(host: Host, home: &Path, env: impl Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let var = |key: &str| env(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    let cache = var("POETRY_CACHE_DIR").unwrap_or_else(|| match host {
        Host::Windows => {
            let local = var("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local"));
            local.join("pypoetry").join("Cache")
        }
        Host::Mac => home.join("Library/Caches/pypoetry"),
        Host::Unix => var("XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache")).join("pypoetry"),
    });
    var("POETRY_VIRTUALENVS_PATH").into_iter().chain([cache.join("virtualenvs")]).collect()
}

/// Hatch's name for the environment every project has.
const DEFAULT_HATCH_ENV: &str = "default";

/// Where Hatch keeps virtual environments: `env/virtual` in its data directory, which is
/// `HATCH_DATA_DIR`, else `%LOCALAPPDATA%\hatch` (Windows), `~/Library/Application Support/hatch`
/// (macOS) or `$XDG_DATA_HOME/hatch` / `~/.local/share/hatch`.
fn hatch_env_dir(host: Host, home: &Path, env: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    let var = |key: &str| env(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    let data = var("HATCH_DATA_DIR").unwrap_or_else(|| match host {
        Host::Windows => var("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local")).join("hatch"),
        Host::Mac => home.join("Library/Application Support/hatch"),
        Host::Unix => var("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share")).join("hatch"),
    });
    data.join("env").join("virtual")
}

/// The folder name Hatch derives from a project's path: the first 8 characters of the URL-safe
/// base64 SHA-256 of the path, which it case-folds on Windows and macOS.
fn hatch_project_id(host: Host, root: &Path) -> String {
    use base64::Engine;
    use sha2::Digest;
    let path = root.to_string_lossy();
    let path = if matches!(host, Host::Unix) { path.into_owned() } else { casefold(&path) };
    let mut id = base64::engine::general_purpose::URL_SAFE.encode(sha2::Sha256::digest(path.as_bytes()));
    id.truncate(8);
    id
}

/// Python's `str.casefold()` for the letters a path is likely to hold: lower case, with the
/// letters that case-fold to more than their lower case expanded (`ß` → `ss`). `ponytail:` the
/// rest of Unicode's full case folding (Cherokee, Greek symbol variants, iota subscripts) is
/// lower-cased only; a project path with them gets no default environment picked.
fn casefold(text: &str) -> String {
    text.chars().fold(String::with_capacity(text.len()), |mut out, c| {
        match c {
            'ß' | 'ẞ' => out.push_str("ss"),
            'ſ' => out.push('s'),
            'ς' => out.push('σ'),
            'µ' => out.push('μ'),
            'ﬀ' => out.push_str("ff"),
            'ﬁ' => out.push_str("fi"),
            'ﬂ' => out.push_str("fl"),
            'ﬃ' => out.push_str("ffi"),
            'ﬄ' => out.push_str("ffl"),
            'ﬅ' | 'ﬆ' => out.push_str("st"),
            _ => out.extend(c.to_lowercase()),
        }
        out
    })
}

/// The Hatch project and environment a virtualenv is, told by where it lives:
/// `…/env/virtual/<project name>/<project id>/<environment>`, the `default` environment being
/// the one named after the project. `None` for Hatch's internal environments (`hatch-test.py3.12`, …).
fn hatch_env(venv: &Path) -> Option<(String, String)> {
    let project = venv.parent()?.parent()?;
    if !project.parent()?.ends_with("env/virtual") {
        return None;
    }
    let (name, project) = (venv.file_name()?.to_string_lossy(), project.file_name()?.to_string_lossy());
    if name == project {
        return Some((project.into_owned(), DEFAULT_HATCH_ENV.to_owned()));
    }
    (!name.starts_with("hatch-")).then(|| (project.into_owned(), name.into_owned()))
}

/// The folder Hatch takes as the project for `root`: the nearest one, `root` or above it, with a
/// `pyproject.toml` or `setup.py`, else `root` itself when it has a `hatch.toml`.
fn hatch_project_root(root: &Path) -> Option<PathBuf> {
    root.ancestors()
        .find(|dir| dir.join("pyproject.toml").is_file() || dir.join("setup.py").is_file())
        .or_else(|| root.join("hatch.toml").is_file().then_some(root))
        .map(Path::to_path_buf)
}

pub(crate) fn hatch_project_config(root: &Path) -> Option<(PathBuf, toml::Value)> {
    fn read(path: &Path) -> Option<toml::Value> {
        if !path.is_file() {
            return None;
        }
        toml::from_str(&std::fs::read_to_string(path).ok()?).ok()
    }
    let project = hatch_project_root(root)?;
    let config = project.join("hatch.toml");
    let settings = if config.is_file() {
        read(&config)?
    } else {
        let metadata = read(&project.join("pyproject.toml"))?;
        metadata.get("tool")?.get("hatch").filter(|config| config.is_table())?.clone()
    };
    Some((project, settings))
}

/// Resolve the default when applying a runtime or language server without starting Hatch.
fn hatch_default_python(root: &Path) -> Option<PathBuf> {
    let (project, config) = hatch_project_config(root)?;
    let custom = host_var_os_in(&project, "HATCH_ENV_TYPE_VIRTUAL_PATH").filter(|p| !p.is_empty()).or_else(|| {
        config.get("envs")?.get(DEFAULT_HATCH_ENV)?.get("path")?.as_str().filter(|p| !p.is_empty()).map(Into::into)
    });
    if let Some(home) = custom {
        let home = PathBuf::from(home);
        let home = if home.is_absolute() { home } else { dunce::canonicalize(project.join(home)).ok()? };
        let python = home.join(bin_dir()).join(exe("python"));
        return (home.join("pyvenv.cfg").is_file() && python.is_file()).then_some(python);
    }
    stored_hatch_env_pythons(&project)
        .into_iter()
        .find(|p| venv_of(p).and_then(|v| hatch_env(&v)).is_some_and(|(_, env)| env == DEFAULT_HATCH_ENV))
}

fn stored_hatch_env_pythons(project: &Path) -> Vec<PathBuf> {
    let Some(home) = home_dir() else { return Vec::new() };
    hatch_envs_in(project, &hatch_env_dir(Host::current(), &home, |key| host_var_os(key)), Host::current())
}

fn hatch_envs_in(root: &Path, storage: &Path, host: Host) -> Vec<PathBuf> {
    // Hatch hashes the path it was started in, which may or may not have its symlinks resolved.
    let mut ids: Vec<String> = [Some(root.to_path_buf()), dunce::canonicalize(root).ok()]
        .into_iter()
        .flatten()
        .map(|path| hatch_project_id(host, &path))
        .collect();
    ids.dedup();
    subdirs(storage)
        .iter()
        .flat_map(|project| ids.iter().flat_map(|id| subdirs(&project.join(id))))
        .filter(|env| hatch_env(env).is_some())
        .map(|env| env.join(bin_dir()).join(exe("python")))
        .filter(|python| python.is_file())
        .collect()
}

/// Where uv installs Pythons (`uv python dir`): `UV_PYTHON_INSTALL_DIR`, else `python` in its
/// data dir — `%APPDATA%\uv` on Windows (`%APPDATA%\uv\data` when an older uv made it), else
/// `$XDG_DATA_HOME/uv` / `~/.local/share/uv` (older uv on macOS: `~/Library/Application Support/uv`).
fn uv_python_dirs(host: Host, home: &Path, env: impl Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let var = |key: &str| env(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    let data = match host {
        Host::Windows => {
            let roaming = var("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming"));
            vec![roaming.join("uv"), roaming.join("uv").join("data")]
        }
        Host::Mac | Host::Unix => {
            let xdg = var("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share")).join("uv");
            let legacy = matches!(host, Host::Mac).then(|| home.join("Library/Application Support/uv"));
            [xdg].into_iter().chain(legacy).collect()
        }
    };
    var("UV_PYTHON_INSTALL_DIR").into_iter().chain(data.into_iter().map(|d| d.join("python"))).collect()
}

/// The interpreter of a uv-managed install: `python.exe` at its root on Windows, `bin/python3` elsewhere.
fn uv_python(install: &Path) -> Option<PathBuf> {
    [install.join(exe("python")), install.join("bin").join(exe("python3"))].into_iter().find(|p| p.is_file())
}

fn python(root: Option<&Path>, which_hatch: impl Fn(&str) -> Option<PathBuf>) -> Vec<Sdk> {
    let mut found: Vec<(PathBuf, &'static str)> = Vec::new();
    let hatch_project = root.and_then(hatch_project_config).map(|(project, _)| project);
    let mut hatch_names = HashMap::new();
    if let Some(root) = root {
        if let Some(project) = &hatch_project {
            if let Some(envs) = which_hatch("hatch").and_then(|hatch| hatch_env_paths(project, &hatch)) {
                for (path, name) in envs {
                    hatch_names.entry(path.clone()).or_insert(name);
                    found.push((path, "venv"));
                }
            } else {
                found.extend(stored_hatch_env_pythons(project).into_iter().map(|p| (p, "venv")));
            }
        }
        for v in PROJECT_VENVS {
            let dir = root.join(v);
            if dir.join("pyvenv.cfg").is_file() {
                found.push((dir.join(bin_dir()).join(exe("python")), "venv"));
            }
        }
        // pixi environments (`.pixi/envs/<env>`), which are no virtualenvs.
        for env in subdirs(&root.join(".pixi/envs")) {
            let python =
                [env.join(exe("python")), env.join("bin").join(exe("python"))].into_iter().find(|p| p.is_file());
            if let Some(python) = python {
                found.push((python, "pixi"));
            }
        }
        if let Some(python) = pipenv_env_python(root) {
            // The selected Pipenv environment may already be a project-local virtualenv.
            if let Some((_, source)) = found.iter_mut().find(|(path, _)| *path == python) {
                *source = "pipenv";
            } else {
                found.push((python, "pipenv"));
            }
        }
    }
    if let Ok(venv) = std::env::var("VIRTUAL_ENV") {
        found.push((Path::new(&venv).join(bin_dir()).join(exe("python")), "venv"));
    }
    if let Some(home) = home_dir() {
        // Virtualenvs managed by virtualenvwrapper / pipenv / poetry.
        let var = |key: &str| host_var_os(key);
        for dir in workon_homes(&home, var).into_iter().chain(poetry_venv_dirs(Host::current(), &home, var)) {
            for env in subdirs(&dir) {
                found.push((env.join(bin_dir()).join(exe("python")), "venv"));
            }
        }
        let pyenv = std::env::var_os("PYENV_ROOT").map(PathBuf::from).unwrap_or_else(|| home.join(".pyenv"));
        for v in subdirs(&pyenv.join("versions")) {
            found.push((v.join(bin_dir()).join(exe("python")), "pyenv"));
        }
        // Hatch environments of every project: `<project name>/<project id>/<environment>`.
        for project in subdirs(&hatch_env_dir(Host::current(), &home, var)) {
            for env in subdirs(&project).iter().flat_map(|id| subdirs(id)).filter(|env| hatch_env(env).is_some()) {
                found.push((env.join(bin_dir()).join(exe("python")), "venv"));
            }
        }
        for dir in uv_python_dirs(Host::current(), &home, var) {
            found.extend(subdirs(&dir).iter().filter_map(|v| uv_python(v)).map(|p| (p, "uv")));
        }
        for (v, manager) in version_managers::installs(Tool::Python) {
            found.extend(pinned::python_in_install(&v).map(|p| (p, manager)));
        }
        let mut conda_roots: Vec<PathBuf> =
            ["miniconda3", "anaconda3", "miniforge3", "mambaforge", "micromamba", "opt/miniconda3"]
                .iter()
                .map(|d| home.join(d))
                .collect();
        conda_roots.push(PathBuf::from("/opt/homebrew/Caskroom/miniconda/base"));
        conda_roots.push(PathBuf::from("/opt/miniconda3"));
        conda_roots.push(PathBuf::from("/opt/anaconda3"));
        if let Some(prefix) = std::env::var_os("CONDA_PREFIX") {
            conda_roots.push(PathBuf::from(prefix));
        }
        // Conda's own registry of known prefixes (`~/.conda/environments.txt`, one path
        // per line, kept current on create/remove/activation): names `--prefix` envs kept
        // outside `envs/` just like `conda env list`, and reads even when the query below
        // comes up empty — conda 26.x starts slowly enough to miss a short timeout, and a
        // missed query hid every such env (#3729).
        if let Ok(text) = std::fs::read_to_string(home.join(".conda").join("environments.txt")) {
            conda_roots.extend(conda_environments_txt_prefixes(&text));
        }
        // A conda on PATH reveals a non-default install root (Anaconda on D:\, Miniconda
        // in ProgramData): the binary lives at <root>/Scripts/conda.exe (Windows) or
        // <root>/bin/conda. Without this, an install outside the home-dir guesses keeps
        // every `envs/` environment invisible (#2240).
        if let Some(conda) = which("conda") {
            if let Some(root) = conda.parent().and_then(Path::parent) {
                conda_roots.push(root.to_path_buf());
            }
            // `conda env list` also names `--prefix` envs kept outside `envs/` and envs_dirs
            // configured in .condarc — every env the user sees on the CLI shows up here.
            if let Some(list) = query(&conda, &["env", "list"], CONDA_ENV_LIST_TIMEOUT) {
                conda_roots.extend(conda_env_list_prefixes(&list));
            }
        }
        let mut seen_roots = HashSet::new();
        conda_roots.retain(|r| seen_roots.insert(r.clone()));
        // Conda prefixes keep `python.exe` at the env root on Windows (`envs/x/python.exe`),
        // not under Scripts/ like a virtualenv — probe every conventional location (#2240).
        let conda_python = |prefix: &Path| -> Option<PathBuf> {
            [
                prefix.join(exe("python")),
                prefix.join(bin_dir()).join(exe("python")),
                prefix.join("bin").join(exe("python")),
            ]
            .into_iter()
            .find(|p| p.is_file())
        };
        for base in conda_roots {
            if let Some(p) = conda_python(&base) {
                found.push((p, "conda"));
            }
            for env in subdirs(&base.join("envs")) {
                if let Some(p) = conda_python(&env) {
                    found.push((p, "conda"));
                }
            }
        }
    }
    for dir in std::env::split_paths(&search_path()) {
        if dir.ends_with(".pyenv/shims") || version_managers::is_shims_dir(&dir) {
            continue;
        }
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| is_python_name(n))
            .collect();
        names.sort();
        for n in names {
            found.push((dir.join(n), "system"));
        }
    }
    // A virtualenv's python is a symlink to its base interpreter: dedupe venvs by
    // their own path, the rest by the resolved binary.
    let mut seen_venv = HashSet::new();
    let mut seen_real = HashSet::new();
    let candidates: Vec<(PathBuf, &'static str)> = found
        .into_iter()
        .filter(|(p, _)| p.is_file() && usable(p))
        .filter(|(p, source)| {
            if *source == "venv" || venv_of(p).is_some() {
                let home = venv_of(p).unwrap_or_else(|| p.clone());
                seen_venv.insert(dunce::canonicalize(&home).unwrap_or(home))
            } else {
                seen_real.insert(p.canonicalize().unwrap_or_else(|_| p.clone()))
            }
        })
        .map(
            |(p, source)| {
                if venv_of(&p).is_some() && !matches!(source, "conda" | "pipenv") { (p, "venv") } else { (p, source) }
            },
        )
        .collect();
    par_map(&candidates, |(path, source)| match (*source, &hatch_project, hatch_names.get(path)) {
        ("venv", Some(project), Some(name)) => hatch_sdk(path, project, name),
        _ => python_sdk(path, source, root),
    })
}

/// A runnable Python executable or virtualenv folder, named like detected SDKs.
pub fn python_interpreter_sdk(path: &Path, root: Option<&Path>) -> Option<Sdk> {
    let path = if path.is_dir() && path.join("pyvenv.cfg").is_file() {
        path.join(bin_dir()).join(exe("python"))
    } else {
        path.to_path_buf()
    };
    if !path.is_file() || !usable(&path) {
        return None;
    }
    // Run Python code: --version and pyvenv.cfg can still work after the base
    // installation (including its standard library) has been removed.
    let version =
        query(&path, &["-I", "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], VERSION_TIMEOUT)?;
    if version.split('.').count() != 3
        || !version.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let source = if let Some(home) = venv_of(&path) {
        let pipenv_home = root.and_then(pipenv_env_python).and_then(|p| venv_of(&p));
        if pipenv_home.is_some_and(|p| dunce::canonicalize(p).is_ok_and(|p| dunce::canonicalize(&home).ok() == Some(p)))
        {
            "pipenv"
        } else {
            "venv"
        }
    } else {
        "system"
    };
    Some(python_sdk_with_version(&path, source, root, version, None))
}

pub(crate) fn python_sdk(path: &Path, source: &str, root: Option<&Path>) -> Option<Sdk> {
    Some(python_sdk_with_version(path, source, root, python_version(path)?, None))
}

pub(crate) fn hatch_sdk(path: &Path, project: &Path, name: &str) -> Option<Sdk> {
    let owner = venv_of(path)
        .and_then(|home| hatch_env(&home))
        .map(|(owner, _)| owner)
        .unwrap_or_else(|| project.file_name().unwrap_or_default().to_string_lossy().into_owned());
    Some(python_sdk_with_version(path, "venv", Some(project), python_version(path)?, Some((owner, name.to_owned()))))
}

fn python_version(path: &Path) -> Option<String> {
    query(path, &["--version"], VERSION_TIMEOUT)
        .and_then(|v| v.strip_prefix("Python ").map(str::to_owned))
        .or_else(|| pyvenv_version(path))
}

fn python_sdk_with_version(
    path: &Path,
    source: &str,
    root: Option<&Path>,
    version: String,
    hatch: Option<(String, String)>,
) -> Sdk {
    let short = version.split('.').take(2).collect::<Vec<_>>().join(".");
    let venv = venv_of(path);
    let pipenv = if source == "pipenv" {
        root.and_then(pipfile_dir)
    } else if source == "venv" && hatch.is_none() {
        venv.as_deref().and_then(pipenv_project)
    } else {
        None
    };
    let source = if pipenv.is_some() { "pipenv" } else { source };
    let hatch = hatch.or_else(|| venv.as_deref().filter(|_| source == "venv").and_then(hatch_env));
    let source = if hatch.is_some() { "hatch" } else { source };
    let label = match (&venv, source) {
        // Every project has a `default`: the project names it, as Pipenv's are named.
        (_, "hatch") => match hatch {
            Some((project, env)) if env != DEFAULT_HATCH_ENV => format!("Python {short} (Hatch: {project}:{env})"),
            Some((project, _)) => format!("Python {short} (Hatch: {project})"),
            None => format!("Python {short} (Hatch)"),
        },
        (_, "pipenv") => {
            let project = pipenv.as_deref().and_then(Path::file_name).unwrap_or_default().to_string_lossy();
            format!("Python {short} (Pipenv: {project})")
        }
        (Some(home), _) => {
            let dir = home.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            // `.venv` inside a project reads better as the folder that holds it (the project,
            // or a member such as `backend`), like PyCharm.
            let owner = home.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned());
            match (dir.starts_with('.') || dir == "venv" || dir == "env", owner, root) {
                (true, Some(owner), Some(root)) if home.starts_with(root) => format!("Python {short} ({owner})"),
                _ => format!("Python {short} ({dir})"),
            }
        }
        (None, "conda") => format!("Python {short} (conda: {})", conda_env_name(path).unwrap_or_default()),
        (None, "pixi") => {
            let env = pixi_env_name(path).unwrap_or_default();
            format!("Python {short} (pixi: {env})")
        }
        (None, "pyenv") => format!("Python {short} (pyenv)"),
        (None, tool @ ("uv" | "mise" | "asdf")) => format!("Python {short} ({tool})"),
        _ => format!("Python {short}"),
    };
    Sdk {
        path: path.into(),
        name: label,
        version: Some(version),
        source: source.to_owned(),
        home: venv
            .or_else(|| (source == "pixi").then(|| pixi_env_home(path)).flatten())
            .or_else(|| (source == "conda").then(|| conda_env_home(path)).flatten())
            .or_else(|| path.parent().and_then(Path::parent).map(Path::to_path_buf))
            .map(Into::into),
        extra: None,
    }
}

/// The prefix of a conda interpreter: `<env>/bin/python` on Unix, `<env>/python.exe` on Windows.
pub(crate) fn conda_env_home(python: &Path) -> Option<PathBuf> {
    let dir = python.parent()?;
    let bin = dir.file_name().is_some_and(|n| n == "bin" || n.eq_ignore_ascii_case("Scripts"));
    Some(if bin { dir.parent()? } else { dir }.to_path_buf())
}

/// The name conda gives an environment: `base` for the installation itself (it holds
/// `condabin/`), else the prefix's folder (`envs/<name>`, or a `--prefix` env's directory).
fn conda_env_name(python: &Path) -> Option<String> {
    let home = conda_env_home(python)?;
    if home.join("condabin").is_dir() {
        return Some("base".into());
    }
    home.file_name().map(|n| n.to_string_lossy().into_owned())
}

/// `.pixi/envs/<env>` of a pixi interpreter (`<env>/python`, `<env>/bin/python`).
fn pixi_env_home(python: &Path) -> Option<PathBuf> {
    let dir = python.parent()?;
    let env = if dir.file_name().is_some_and(|n| n == "bin") { dir.parent()? } else { dir };
    (env.parent()?.file_name()? == "envs" && env.parent()?.parent()?.file_name()? == ".pixi").then(|| env.to_path_buf())
}

/// The name of a pixi interpreter's environment (`<env>` of `.pixi/envs/<env>`).
fn pixi_env_name(python: &Path) -> Option<String> {
    pixi_env_home(python)?.file_name().map(|n| n.to_string_lossy().into_owned())
}

pub(crate) fn pyvenv_version(python: &Path) -> Option<String> {
    let cfg = std::fs::read_to_string(venv_of(python)?.join("pyvenv.cfg")).ok()?;
    cfg.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        matches!(k.trim(), "version" | "version_info").then(|| v.trim().to_owned())
    })
}

pub(crate) fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> =
        std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    out.sort();
    out
}

// ------------------------------------------------------------------ node

/// Node's own version managers, by where they keep installs below the home directory.
const NODE_MANAGERS: &[(&str, &str)] =
    &[(".nvm/versions/node", "nvm"), (".volta/tools/image/node", "volta"), (".local/share/fnm/node-versions", "fnm")];

/// Where a Node on the search path comes from: its version manager, "system" for one
/// of the system's own bin directories, "path" for anything else the user put on `PATH`.
pub(crate) fn node_source(path: &Path, home: Option<&Path>) -> &'static str {
    let managed = home.and_then(|home| {
        NODE_MANAGERS.iter().find(|(dir, _)| path.starts_with(home.join(dir))).map(|(_, manager)| *manager)
    });
    managed.or_else(|| version_managers::manager_of(path)).unwrap_or_else(|| {
        if path.parent().is_some_and(ide_core::tool_path::is_system_dir) { "system" } else { "path" }
    })
}

/// Where a PHP on the search path comes from: its version manager or distribution,
/// "system" for one of the system's own bin directories, "path" for anything else.
pub(crate) fn php_source(path: &Path, home: Option<&Path>) -> &'static str {
    let under = |dir: &str| home.is_some_and(|h| path.starts_with(h.join(dir)));
    if under(".phpbrew") {
        "phpbrew"
    } else if under(".phpenv") {
        "phpenv"
    } else if under(".config/herd-lite") || under("Library/Application Support/Herd") {
        "herd"
    } else if path.starts_with("/opt/homebrew") || path.starts_with("/usr/local/opt") {
        "homebrew"
    } else if let Some(manager) = version_managers::manager_of(path) {
        manager
    } else if path.parent().is_some_and(ide_core::tool_path::is_system_dir) {
        "system"
    } else {
        "path"
    }
}

/// A PHP CLI named with its version, as Debian / Ubuntu (`ppa:ondrej/php`) install them:
/// `php8.1`, `php81`. Not `php-cgi8.1`, `phpize8.1` or `phpdbg8.1`.
pub(crate) fn is_versioned_php_name(name: &str) -> bool {
    let name = name.strip_suffix(".exe").unwrap_or(name);
    let Some(version) = name.strip_prefix("php") else { return false };
    let mut parts = version.splitn(2, '.');
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    parts.next().is_some_and(digits) && parts.next().is_none_or(digits)
}

/// The versioned PHP CLIs in `dirs`, in `PATH` order (sorted by name within a directory).
pub(crate) fn versioned_php_in(dirs: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for dir in dirs {
        if version_managers::is_shims_dir(&dir) {
            continue;
        }
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| is_versioned_php_name(n))
            .collect();
        names.sort();
        found.extend(names.into_iter().map(|n| dir.join(n)).filter(|p| p.is_file()));
    }
    found
}

/// `php` CLIs: every one on `PATH` (also versioned ones, `php8.1`), Homebrew's versioned
/// formulae, PHP version managers, Laravel Herd, and the usual Windows distributions (XAMPP, Laragon).
fn php() -> Vec<Sdk> {
    let mut found: Vec<(PathBuf, &'static str)> = Vec::new();
    let home = home_dir();
    for p in executables_in("php", std::env::split_paths(&search_path())) {
        if version_managers::is_shim(&p) {
            continue;
        }
        let source = php_source(&p, home.as_deref());
        found.push((p, source));
    }
    // After the plain `php`: deduplication keeps `/usr/bin/php` over the `php8.3` it links to.
    for p in versioned_php_in(std::env::split_paths(&search_path())) {
        let source = php_source(&p, home.as_deref());
        found.push((p, source));
    }
    let named = |dir: &Path, prefix: &str| -> Vec<PathBuf> {
        subdirs(dir)
            .into_iter()
            .filter(|d| d.file_name().is_some_and(|n| n.to_string_lossy().starts_with(prefix)))
            .collect()
    };
    for opt in ["/opt/homebrew/opt", "/usr/local/opt"] {
        for d in named(Path::new(opt), "php") {
            found.push((d.join("bin").join(exe("php")), "homebrew"));
        }
    }
    for d in named(Path::new("/usr/local"), "php") {
        found.push((d.join("bin").join(exe("php")), "system"));
    }
    if let Some(home) = &home {
        for v in subdirs(&home.join(".phpbrew/php")).into_iter().rev() {
            found.push((v.join("bin").join(exe("php")), "phpbrew"));
        }
        for v in subdirs(&home.join(".phpenv/versions")).into_iter().rev() {
            found.push((v.join("bin").join(exe("php")), "phpenv"));
        }
        found.push((home.join(".config/herd-lite/bin").join(exe("php")), "herd"));
        let herd = home.join("Library/Application Support/Herd/bin");
        for entry in std::fs::read_dir(&herd).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("php") && !name.contains('-') && entry.path().is_file() {
                found.push((entry.path(), "herd"));
            }
        }
    }
    if cfg!(windows) {
        found.push((PathBuf::from(r"C:\xampp\php\php.exe"), "xampp"));
        found.push((PathBuf::from(r"C:\php\php.exe"), "system"));
        for d in subdirs(Path::new(r"C:\laragon\bin\php")) {
            found.push((d.join("php.exe"), "laragon"));
        }
    }
    let found = dedupe_by_real_path(found);
    let mut sdks = par_map(&found, |(path, source)| {
        let version = query(path, &["-r", "echo PHP_VERSION;"], VERSION_TIMEOUT)?;
        let version = version.trim().to_owned();
        if version.is_empty() {
            return None;
        }
        Some(Sdk {
            path: path.clone().into(),
            name: format!("PHP {version}"),
            version: Some(version),
            source: (*source).to_owned(),
            home: path.parent().and_then(Path::parent).map(Into::into),
            extra: None,
        })
    });
    newest_first(&mut sdks);
    sdks
}

/// Newest version first, number by number (8.3.12 before 8.3.9); stable, so on equal
/// versions the `PATH` install stays first.
pub(crate) fn newest_first(sdks: &mut [Sdk]) {
    let key = |s: &Sdk| ide_core::tool_path::version_key(s.version.as_deref().unwrap_or(""));
    sdks.sort_by_key(|s| std::cmp::Reverse(key(s)));
}

fn node() -> Vec<Sdk> {
    let mut found: Vec<(PathBuf, &'static str)> = Vec::new();
    // Every Node on the search path, not only the first one `which` finds: an SSH
    // session's minimal PATH puts /usr/bin ahead of the user's own ~/.local/bin, so
    // /usr/bin/node would be the only install listed (#440).
    for p in executables_in("node", std::env::split_paths(&search_path())) {
        // A mise / asdf shim picks the version by directory: its installs are listed instead.
        if version_managers::is_shim(&p) {
            continue;
        }
        let source = node_source(&p, home_dir().as_deref());
        found.push((p, source));
    }
    if let Some(home) = home_dir() {
        for v in subdirs(&home.join(".nvm/versions/node")).into_iter().rev() {
            found.push((v.join("bin").join(exe("node")), "nvm"));
        }
        for v in subdirs(&home.join(".volta/tools/image/node")).into_iter().rev() {
            found.push((v.join("bin").join(exe("node")), "volta"));
        }
        for v in subdirs(&home.join(".local/share/fnm/node-versions")).into_iter().rev() {
            found.push((v.join("installation/bin").join(exe("node")), "fnm"));
        }
    }
    for (v, manager) in version_managers::installs(Tool::Node).into_iter().rev() {
        found.push((v.join("bin").join(exe("node")), manager));
    }
    let found = dedupe_by_real_path(found);
    par_map(&found, |(path, source)| {
        let version = query(path, &["--version"], VERSION_TIMEOUT)?;
        let version = version.trim_start_matches('v').to_owned();
        Some(Sdk {
            path: path.clone().into(),
            name: format!("Node.js {version}"),
            version: Some(version),
            source: (*source).to_owned(),
            home: path.parent().and_then(Path::parent).map(Into::into),
            extra: None,
        })
    })
}

fn package_managers() -> Vec<Sdk> {
    let found: Vec<(&str, PathBuf)> =
        ["npm", "pnpm", "yarn", "bun"].iter().filter_map(|n| Some((*n, which(n)?))).collect();
    par_map(&found, |(name, path)| {
        let version = query(path, &["--version"], VERSION_TIMEOUT);
        Some(Sdk {
            path: path.clone().into(),
            name: (*name).to_owned(),
            version,
            source: "path".into(),
            home: None,
            extra: None,
        })
    })
}

// ------------------------------------------------------------------ rust

fn rust_sdk(bin: &Path, name: String, source: &str, home: Option<PathBuf>) -> Option<Sdk> {
    let rustc = bin.join(exe("rustc"));
    if !rustc.is_file() {
        return None;
    }
    let version = query(&rustc, &["--version"], VERSION_TIMEOUT)
        .map(|v| v.trim_start_matches("rustc ").split_whitespace().next().unwrap_or_default().to_owned());
    let stdlib = home
        .as_ref()
        .map(|h| h.join("lib/rustlib/src/rust/library"))
        .or_else(|| {
            let sysroot = query(&rustc, &["--print", "sysroot"], VERSION_TIMEOUT)?;
            Some(PathBuf::from(sysroot).join("lib/rustlib/src/rust/library"))
        })
        .filter(|p| p.is_dir());
    Some(Sdk {
        path: bin.into(),
        name,
        version,
        source: source.to_owned(),
        home: home.map(Into::into),
        extra: stdlib.map(Into::into),
    })
}

fn rust() -> Vec<Sdk> {
    let rustup_home =
        std::env::var_os("RUSTUP_HOME").map(PathBuf::from).or_else(|| home_dir().map(|h| h.join(".rustup")));
    let toolchains = rustup_home.map(|h| subdirs(&h.join("toolchains"))).unwrap_or_default();
    let mut out = par_map(&toolchains, |dir| {
        let name = dir.file_name()?.to_string_lossy().into_owned();
        rust_sdk(&dir.join("bin"), name, "rustup", Some(dir.clone()))
    });
    // A rustc not managed by rustup (Homebrew, distro packages).
    if let Some(cargo) = which("cargo") {
        let bin = cargo.parent().map(Path::to_path_buf).unwrap_or_default();
        let is_proxy = bin.ends_with(".cargo/bin");
        if !is_proxy && !out.iter().any(|s| s.path == bin) {
            out.extend(rust_sdk(&bin, format!("{}", bin.display()), "path", None));
        }
    }
    out
}

// ------------------------------------------------------------------ go

fn go_version(goroot: &Path) -> Option<String> {
    let text = std::fs::read_to_string(goroot.join("VERSION")).ok();
    let first = text.as_deref().and_then(|t| t.lines().next()).map(str::to_owned);
    first
        .or_else(|| {
            query(&goroot.join("bin").join(exe("go")), &["version"], VERSION_TIMEOUT)?
                .split_whitespace()
                .nth(2)
                .map(str::to_owned)
        })
        .map(|v| v.trim_start_matches("go").to_owned())
}

fn go() -> Vec<Sdk> {
    let mut roots: Vec<(PathBuf, &'static str)> = Vec::new();
    let path_go = which("go");
    let default_gopath =
        path_go.as_ref().and_then(|go| query(go, &["env", "GOPATH"], VERSION_TIMEOUT)).map(PathBuf::from);
    if let Some(go) = path_go.as_ref().filter(|p| !version_managers::is_shim(p))
        && let Some(root) = query(go, &["env", "GOROOT"], VERSION_TIMEOUT)
    {
        roots.push((PathBuf::from(root), "path"));
    }
    for p in ["/usr/local/go", "/opt/homebrew/opt/go/libexec", "/usr/local/opt/go/libexec", "/usr/lib/go"] {
        roots.push((PathBuf::from(p), "system"));
    }
    if let Some(home) = home_dir() {
        for d in subdirs(&home.join("sdk")) {
            roots.push((d, "sdk"));
        }
        for d in subdirs(&home.join("go/pkg/mod/golang.org")) {
            if d.file_name().is_some_and(|n| n.to_string_lossy().starts_with("toolchain@")) {
                roots.push((d, "toolchain"));
            }
        }
    }
    for (d, manager) in version_managers::installs(Tool::Go) {
        roots.extend(pinned::goroot_in_install(&d).map(|r| (r, manager)));
    }
    let mut seen = HashSet::new();
    roots.retain(|(r, _)| {
        r.join("bin").join(exe("go")).is_file() && seen.insert(r.canonicalize().unwrap_or_else(|_| r.clone()))
    });
    par_map(&roots, |(root, source)| {
        let version = go_version(root);
        Some(Sdk {
            path: root.clone().into(),
            name: format!("Go {}", version.clone().unwrap_or_default()).trim().to_owned(),
            version,
            source: (*source).to_owned(),
            home: Some(root.clone().into()),
            extra: default_gopath.clone().map(Into::into),
        })
    })
}

// ------------------------------------------------------------------ zig

/// The directory holding the `zig` executable of the install rooted at `base`,
/// the way the common distributions lay it out: `zig` at the root (official
/// tarballs, mise / asdf installs), `<base>/bin/zig` (Homebrew) or one
/// directory down (zvm's nested version folders).
fn zig_dir(base: &Path) -> Option<PathBuf> {
    if base.join(exe("zig")).is_file() {
        return Some(base.to_path_buf());
    }
    let bin = base.join(bin_dir());
    if bin.join(exe("zig")).is_file() {
        return Some(bin);
    }
    subdirs(base).into_iter().find(|d| d.join(exe("zig")).is_file())
}

/// Zig toolchains: PATH, Homebrew, zvm and mise / asdf installs. `path` is the
/// directory holding `zig`, which is what `languages.zig.zig` stores.
fn zig() -> Vec<Sdk> {
    let mut roots: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(bin) = which("zig").filter(|p| !version_managers::is_shim(p))
        && let Some(dir) = bin.parent()
    {
        roots.push((dir.to_path_buf(), "path"));
    }
    for p in ["/opt/homebrew/opt/zig", "/usr/local/opt/zig"] {
        roots.push((PathBuf::from(p), "system"));
    }
    if let Some(home) = home_dir() {
        for d in subdirs(&home.join(".zvm")) {
            roots.push((d, "zvm"));
        }
    }
    for (d, manager) in version_managers::installs(Tool::Zig) {
        roots.push((d, manager));
    }
    let mut dirs: Vec<(PathBuf, &'static str)> =
        roots.into_iter().filter_map(|(base, source)| zig_dir(&base).map(|dir| (dir, source))).collect();
    let mut seen = HashSet::new();
    dirs.retain(|(dir, _)| seen.insert(dir.canonicalize().unwrap_or_else(|_| dir.clone())));
    par_map(&dirs, |(dir, source)| {
        let version = query(&dir.join(exe("zig")), &["version"], VERSION_TIMEOUT).map(|v| v.trim().to_owned());
        Some(Sdk {
            path: dir.clone().into(),
            name: format!("Zig {}", version.as_deref().unwrap_or_default()).trim().to_owned(),
            version,
            source: (*source).to_owned(),
            home: Some(dir.clone().into()),
            extra: None,
        })
    })
}

/// The SDKs `dotnet --list-sdks` reports, newest first: only the `dotnet` that runs
/// `dotnet new` can use them.
fn dotnet() -> Vec<Sdk> {
    let Some(dotnet) = which("dotnet") else { return Vec::new() };
    dotnet_sdks(&query(&dotnet, &["--list-sdks"], VERSION_TIMEOUT).unwrap_or_default())
}

/// `10.0.401 [/usr/local/share/dotnet/sdk]` lines, oldest first, as SDKs newest first.
fn dotnet_sdks(list: &str) -> Vec<Sdk> {
    list.lines()
        .filter_map(|line| {
            let (version, root) = line.trim().split_once(" [")?;
            let dir = Path::new(root.strip_suffix(']')?).join(version);
            let channel: Vec<&str> = version.split(['.', '-']).take(2).collect();
            Some(Sdk {
                path: dir.into(),
                name: format!(".NET {}", channel.join(".")),
                version: Some(version.to_owned()),
                source: "dotnet".into(),
                home: None,
                extra: None,
            })
        })
        .rev()
        .collect()
}

#[cfg(test)]
mod dotnet_tests {
    #[test]
    fn lists_sdks_newest_first() {
        let sdks = super::dotnet_sdks(
            "8.0.404 [/usr/local/share/dotnet/sdk]\n10.0.100-rc.2.25502.107 [/usr/local/share/dotnet/sdk]\n\nnot an sdk\n",
        );
        let shown: Vec<_> = sdks.iter().map(|s| (s.name.as_str(), s.version.as_deref().unwrap())).collect();
        assert_eq!(shown, [(".NET 10.0", "10.0.100-rc.2.25502.107"), (".NET 8.0", "8.0.404")]);
        assert!(sdks[1].path.ends_with("sdk/8.0.404"));
        assert!(super::dotnet_sdks("").is_empty());
    }
}

#[cfg(test)]
mod zig_tests {
    use super::*;

    #[test]
    fn finds_the_zig_directory_of_each_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let install = |rel: &str| {
            let dir = tmp.path().join(rel);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(exe("zig")), "").unwrap();
            dir
        };
        // Official tarballs and mise / asdf installs: `zig` at the root.
        let root = install("0.14.1");
        assert_eq!(zig_dir(&root), Some(root));
        // Homebrew: <opt>/bin/zig.
        let brew = install("brew/bin");
        assert_eq!(zig_dir(brew.parent().unwrap()), Some(brew));
        // zvm: one directory down.
        let zvm = install("zvm/x");
        assert_eq!(zig_dir(&tmp.path().join("zvm")), Some(zvm));
        assert_eq!(zig_dir(&tmp.path().join("missing")), None);
    }
}

// ------------------------------------------------------------------ typescript

/// `node_modules/typescript/lib` of the project (root or a direct workspace member).
pub(crate) fn workspace_tsdk(root: &Path) -> Option<PathBuf> {
    let lib = root.join("node_modules/typescript/lib");
    lib.join("tsserver.js").is_file().then_some(lib)
}

fn typescript(root: Option<&Path>) -> Vec<Sdk> {
    let mut out = Vec::new();
    // TypeScript 7 has no `tsserver.js`; its package directory stands for it (`native_tsdk`).
    let native = || {
        let package = root?.join("node_modules/typescript");
        crate::npm::native_typescript(&package).map(|_| package.join("lib"))
    };
    if let Some(lib) = root.and_then(workspace_tsdk).or_else(native) {
        let version = std::fs::read_to_string(lib.parent().unwrap_or(&lib).join("package.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(str::to_owned));
        out.push(Sdk {
            path: lib.clone().into(),
            name: format!(
                "TypeScript {}{}",
                version.clone().unwrap_or_default(),
                if crate::npm::has_ts_api(&lib) { "" } else { " (native)" }
            )
            .replace("  ", " ")
            .trim()
            .to_owned(),
            version,
            source: "workspace".into(),
            home: lib.parent().map(Into::into),
            extra: None,
        });
    }
    out
}

// ------------------------------------------------------------------ jdk

/// `KEY="value"` of a JDK `release` file.
fn release_value(release: &str, key: &str) -> Option<String> {
    let line = release.lines().find_map(|l| l.trim().strip_prefix(key)?.strip_prefix('='))?;
    Some(line.trim().trim_matches('"').to_owned()).filter(|v| !v.is_empty())
}

fn jdk() -> Vec<Sdk> {
    crate::java::rescan_jdks().iter().map(jdk_sdk).collect()
}

/// A JDK as the SDK pickers list it (`Eclipse Adoptium 25.0.1`).
pub fn jdk_sdk(j: &crate::java::Jdk) -> Sdk {
    let java_home = std::env::var_os("JAVA_HOME").and_then(|h| crate::launch_path(Path::new(&h)).ok());
    let release = std::fs::read_to_string(j.home.join("release")).unwrap_or_default();
    let version = release_value(&release, "JAVA_VERSION").unwrap_or_else(|| j.major.to_string());
    let name = match release_value(&release, "IMPLEMENTOR") {
        Some(vendor) => format!("{vendor} {version}"),
        None => format!("JDK {version}"),
    };
    let source = if java_home.as_ref() == Some(&j.home) {
        "JAVA_HOME"
    } else if crate::java::is_downloaded(&j.home) {
        "downloaded"
    } else if crate::java::is_added(&j.home) {
        "added"
    } else {
        version_managers::manager_of(&j.home).unwrap_or("system")
    };
    Sdk {
        path: j.home.clone().into(),
        name,
        version: Some(version),
        source: source.to_owned(),
        home: Some(j.home.clone().into()),
        extra: None,
    }
}

// ------------------------------------------------------------------ maven

/// Maven version from `lib/maven-core-<version>.jar`.
fn maven_version(home: &Path) -> Option<String> {
    std::fs::read_dir(home.join("lib")).ok()?.flatten().find_map(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        Some(name.strip_prefix("maven-core-")?.strip_suffix(".jar")?.to_owned())
    })
}

/// A Maven home (`bin/mvn` and `lib/`); Homebrew's formula keeps it in `libexec`.
fn maven_home(dir: &Path) -> Option<PathBuf> {
    let mvn = if cfg!(windows) { "mvn.cmd" } else { "mvn" };
    [dir.join("libexec"), dir.to_path_buf()]
        .into_iter()
        .find(|h| h.join("bin").join(mvn).is_file() && h.join("lib").is_dir())
}

fn maven() -> Vec<Sdk> {
    let mut found: Vec<(PathBuf, &'static str)> = Vec::new();
    // Windows' Maven ships `mvn.cmd` only (`which` looks for `mvn.exe`).
    let on_path = if cfg!(windows) {
        std::env::split_paths(&search_path()).map(|d| d.join("mvn.cmd")).find(|p| p.is_file())
    } else {
        which("mvn")
    };
    if let Some(mvn) = on_path.and_then(|p| crate::launch_path(&p).ok())
        && let Some(home) = mvn.parent().and_then(Path::parent)
    {
        found.push((home.to_path_buf(), "path"));
    }
    for var in ["MAVEN_HOME", "M2_HOME"] {
        if let Some(h) = std::env::var_os(var) {
            found.push((PathBuf::from(h), "env"));
        }
    }
    for p in ["/opt/homebrew/opt/maven", "/usr/local/opt/maven", "/usr/share/maven", "/opt/maven"] {
        found.push((PathBuf::from(p), "system"));
    }
    if let Some(home) = home_dir() {
        for d in subdirs(&home.join(".sdkman/candidates/maven")) {
            found.push((d, "sdkman"));
        }
        for (d, manager) in version_managers::installs(Tool::Maven) {
            found.extend(subdirs(&d).into_iter().map(|s| (s, manager)));
            found.push((d, manager));
        }
        // Distributions the Maven wrapper downloaded: `dists/apache-maven-3.9.6-bin/<hash>/apache-maven-3.9.6`,
        // or since wrapper 3.3 the home itself, `dists/apache-maven-3.9.6/<hash>`.
        for dist in subdirs(&home.join(".m2/wrapper/dists")) {
            for hash in subdirs(&dist) {
                found.extend(subdirs(&hash).into_iter().map(|d| (d, "wrapper")));
                found.push((hash, "wrapper"));
            }
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (dir, source) in found {
        let Some(home) = maven_home(&dir) else { continue };
        let home = crate::launch_path(&home).unwrap_or(home);
        if !seen.insert(home.clone()) {
            continue;
        }
        let version = maven_version(&home);
        out.push(Sdk {
            path: home.clone().into(),
            name: format!("Maven {}", version.clone().unwrap_or_default()).trim().to_owned(),
            version,
            source: source.to_owned(),
            home: Some(home.into()),
            extra: None,
        });
    }
    out
}

#[cfg(all(test, windows))]
mod maven_path_tests {
    use super::*;
    use crate::launch_path;
    use std::process::Command;

    struct Subst {
        name: String,
        root: PathBuf,
        _lock: std::fs::File,
    }

    impl Subst {
        fn new(target: &Path) -> Self {
            // Drive letters are shared across nextest's test processes; hold the lock until unmapping.
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(std::env::temp_dir().join("openidea-sdk-subst.lock"))
                .unwrap();
            lock.lock().unwrap();
            let marker = format!("{}.subst", target.file_name().unwrap().to_string_lossy());
            std::fs::write(target.join(&marker), "").unwrap();
            for letter in (b'D'..=b'Z').rev() {
                let name = format!("{}:", char::from(letter));
                let root = PathBuf::from(format!("{name}\\"));
                if root.exists() {
                    continue;
                }
                let output = Command::new("subst").arg(&name).arg(target).output().unwrap();
                if output.status.success() && root.join(&marker).exists() {
                    return Self { name, root, _lock: lock };
                }
            }
            panic!("no free drive for Maven path verification");
        }
    }

    impl Drop for Subst {
        fn drop(&mut self) {
            let _ = Command::new("subst").args([&self.name, "/D"]).output();
        }
    }

    fn install(home: &Path) {
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::create_dir_all(home.join("lib")).unwrap();
        std::fs::write(home.join("bin/mvn.cmd"), "@echo off\n").unwrap();
        std::fs::write(home.join("lib/maven-core-3.9.16.jar"), "").unwrap();
    }

    #[test]
    fn mapped_maven_home_and_launcher_keep_their_drive() {
        let mapped = tempfile::tempdir().unwrap();
        install(&mapped.path().join("apache-maven"));
        let drive = Subst::new(mapped.path());
        let home = drive.root.join("apache-maven");
        let launcher = home.join("bin/mvn.cmd");
        assert_ne!(dunce::canonicalize(&home).unwrap(), home);
        assert_eq!(launch_path(&home).unwrap(), home);
        assert_eq!(launch_path(&launcher).unwrap(), launcher);
        assert_eq!(maven_home(&home), Some(home.clone()));
        assert_eq!(maven_version(&home).as_deref(), Some("3.9.16"));
        let jdk = drive.root.join("jdk");
        std::fs::create_dir_all(jdk.join("bin")).unwrap();
        std::fs::write(jdk.join("bin/java.exe"), "").unwrap();
        std::fs::write(jdk.join("release"), "JAVA_VERSION=\"17.0.9\"\n").unwrap();
        assert_eq!(crate::java::jdk_at(&jdk).unwrap().home, jdk);
    }

    #[test]
    fn a_launcher_link_outside_the_mapped_root_still_finds_its_install() {
        let mapped = tempfile::tempdir().unwrap();
        let real = tempfile::tempdir().unwrap();
        install(real.path());
        let drive = Subst::new(mapped.path());
        let link = mapped.path().join("shims");
        let output = Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()))
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(real.path().join("bin"))
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let launcher = launch_path(&drive.root.join("shims/mvn.cmd")).unwrap();
        assert_eq!(launcher, dunce::canonicalize(real.path().join("bin/mvn.cmd")).unwrap());
        let home = launcher.parent().and_then(Path::parent).and_then(maven_home).unwrap();
        assert_eq!(home, dunce::canonicalize(real.path()).unwrap());
    }
}

#[cfg(test)]
mod pixi_tests {
    use super::*;

    #[test]
    fn a_pixi_env_is_a_project_python_and_an_sdk_home() {
        let root = tempfile::tempdir().unwrap();
        let env = root.path().join(".pixi/envs/default");
        let bin = if cfg!(windows) { env.clone() } else { env.join("bin") };
        std::fs::create_dir_all(&bin).unwrap();
        let python = bin.join(exe("python"));
        std::fs::write(&python, "").unwrap();

        assert_eq!(project_venv_python(root.path()), Some(python.clone()));
        assert_eq!(pixi_env_home(&python), Some(env.clone()));
        assert_eq!(pixi_env_name(&python).as_deref(), Some("default"));

        // A second env sorts after; the first with a Python wins.
        let other = root.path().join(".pixi/envs/aaa-empty");
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(project_venv_python(root.path()), Some(python));
    }

    #[test]
    fn non_pixi_paths_have_no_pixi_home() {
        assert_eq!(pixi_env_home(Path::new("/usr/bin/python3")), None);
        assert_eq!(pixi_env_home(Path::new("/p/.venv/bin/python")), None);
        assert_eq!(pixi_env_home(Path::new("/p/envs/x/bin/python")), None);
    }
}

#[cfg(test)]
mod hatch_tests {
    use super::*;

    fn venv(home: &Path) -> PathBuf {
        let python = home.join(bin_dir()).join(exe("python"));
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "").unwrap();
        std::fs::write(home.join("pyvenv.cfg"), "version = 3.12.1\n").unwrap();
        python
    }

    #[test]
    fn the_project_id_is_hatchs_hash_of_the_path() {
        // `base64.urlsafe_b64encode(sha256(path)).decode()[:8]`, the path case-folded on Windows and macOS.
        let root = Path::new("/Users/Me/Shop");
        assert_eq!(hatch_project_id(Host::Unix, root), "nrZdKLu1");
        assert_eq!(hatch_project_id(Host::Mac, root), "6jvy1__M");
        assert_eq!(hatch_project_id(Host::Windows, root), "6jvy1__M");
        // `"Straße".casefold()` is `strasse`, where lower-casing keeps the `ß`.
        assert_eq!(hatch_project_id(Host::Mac, Path::new("/Users/me/Straße/shop")), "uZq42xD1");
        assert_eq!(casefold("ẞſﬁΣς"), "sssfiσσ");
    }

    #[test]
    fn a_default_hatch_environment_at_a_custom_path_is_used_after_pipenv() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("shop");
        let subdir = project.join("src");
        std::fs::create_dir_all(&subdir).unwrap();
        let external = venv(&tmp.path().join("custom default"));
        std::fs::write(project.join("pyproject.toml"), "[tool.hatch.envs.default]\npath = '../custom default'\n")
            .unwrap();
        std::fs::write(project.join("Pipfile"), "").unwrap();
        let pipenv = venv(&project.join(".venv"));
        assert_eq!(project_venv_python(&subdir), Some(pipenv));
        std::fs::remove_dir_all(project.join(".venv")).unwrap();
        assert_eq!(project_venv_python(&subdir), Some(dunce::canonicalize(external).unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn sdk_detection_uses_hatch_find_for_existing_custom_environments() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("shop");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("hatch.toml"), "").unwrap();
        let external = tmp.path().join("custom docs");
        let docs = venv(&external);
        let hatch = tmp.path().join("hatch");
        std::fs::write(
            &hatch,
            format!(
                "#!/bin/sh\ncase \"$3 $4 $6\" in\n\
                 'env show ') echo '{{\"default\":{{}},\"docs\":{{}},\"hatch-build\":{{}}}}';;\n\
                 'env find docs') echo 'Looking up environment'; echo '{external}';;\n\
                 'env find default') echo '{missing}';;\n\
                 *) exit 1;;\nesac\n",
                external = external.display(),
                missing = tmp.path().join("missing").display(),
            ),
        )
        .unwrap();
        std::fs::set_permissions(&hatch, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sdks = python(Some(&project), |tool| (tool == "hatch").then(|| hatch.clone()));
        let sdk = sdks.iter().find(|sdk| &*sdk.path == docs.as_path()).unwrap();
        assert_eq!((sdk.name.as_str(), sdk.source.as_str()), ("Python 3.12 (Hatch: shop:docs)", "hatch"));
    }

    #[test]
    fn the_project_is_the_nearest_folder_with_a_pyproject() {
        let tmp = tempfile::tempdir().unwrap();
        let shop = tmp.path().join("shop");
        std::fs::create_dir_all(shop.join("src/pkg")).unwrap();
        assert_eq!(hatch_project_root(&shop), None);
        std::fs::write(shop.join("hatch.toml"), "").unwrap();
        assert_eq!(hatch_project_root(&shop), Some(shop.clone()));
        std::fs::write(shop.join("pyproject.toml"), "").unwrap();
        assert_eq!(hatch_project_root(&shop.join("src/pkg")), Some(shop));
    }

    #[test]
    fn a_projects_environments_are_the_ones_under_its_id() {
        let tmp = tempfile::tempdir().unwrap();
        let (shop, other) = (tmp.path().join("shop"), tmp.path().join("elsewhere").join("shop"));
        std::fs::create_dir_all(&shop).unwrap();
        let storage = tmp.path().join("data").join("env").join("virtual");
        let id = hatch_project_id(Host::current(), &dunce::canonicalize(&shop).unwrap());
        let ours = storage.join("shop").join(id);
        // Another project of the same name keeps its environments under its own id.
        let theirs = storage.join("shop").join(hatch_project_id(Host::current(), &other));
        let (default, docs) = (venv(&ours.join("shop")), venv(&ours.join("docs")));
        let theirs = venv(&theirs.join("shop"));
        std::fs::create_dir_all(ours.join("half-made")).unwrap();
        // Hatch's own test environments live beside the project's.
        let internal = venv(&ours.join("hatch-test.py3.12"));

        assert_eq!(hatch_envs_in(&shop, &storage, Host::current()), [docs.clone(), default.clone()]);
        assert_eq!(hatch_env(internal.parent().unwrap().parent().unwrap()), None);
        assert!(hatch_envs_in(&other, &tmp.path().join("missing"), Host::current()).is_empty());

        let sdk = python_sdk(&default, "venv", Some(&shop)).unwrap();
        // Named by their project, as every project has a `default`.
        assert_eq!((sdk.name.as_str(), sdk.source.as_str()), ("Python 3.12 (Hatch: shop)", "hatch"));
        assert_eq!(python_sdk(&docs, "venv", None).unwrap().name, "Python 3.12 (Hatch: shop:docs)");
        assert_eq!(python_sdk(&theirs, "venv", None).unwrap().name, "Python 3.12 (Hatch: shop)");
        // A project whose name starts like Hatch's internal environments keeps its `default`.
        let named = venv(&storage.join("hatch-shop").join("abcdefgh").join("hatch-shop"));
        assert_eq!(python_sdk(&named, "venv", None).unwrap().name, "Python 3.12 (Hatch: hatch-shop)");
        // A virtualenv that merely sits three folders deep is no Hatch environment.
        let plain = venv(&tmp.path().join("a").join("b").join("c"));
        assert_eq!(python_sdk(&plain, "venv", None).unwrap().source, "venv");
    }
}

#[cfg(test)]
mod pipenv_tests {
    use super::*;

    fn venv(home: &Path, project: &Path) -> PathBuf {
        let python = home.join(bin_dir()).join(exe("python"));
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "").unwrap();
        std::fs::write(home.join("pyvenv.cfg"), "version = 3.12.1\n").unwrap();
        std::fs::write(home.join(".project"), project.to_string_lossy().as_bytes()).unwrap();
        python
    }

    #[test]
    fn environments_are_named_as_pipenv_names_them() {
        // `sanitize(folder)[:42] + "-" + urlsafe_b64encode(sha256(Pipfile path).digest()[:6])`, from pipenv.
        #[cfg(unix)]
        assert_eq!(pipenv_env_name(Path::new("/home/me/My Shop (2)")), "My_Shop__2_-6rNTtAUD");
        #[cfg(windows)]
        assert_eq!(pipenv_env_name(Path::new(r"C:\Users\me\My Shop (2)")), "My_Shop__2_-ED1rXUDC");
    }

    #[test]
    fn the_environment_named_for_the_pipfile_is_the_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let tmp = dunce::canonicalize(tmp.path()).unwrap();
        let (shop, blog) = (tmp.join("shop"), tmp.join("blog"));
        for project in [&shop, &blog] {
            std::fs::create_dir_all(project.join("src/pkg")).unwrap();
            std::fs::write(project.join("Pipfile"), "").unwrap();
        }
        let homes = [tmp.join("missing"), tmp.join(".virtualenvs"), tmp.join("workon")];
        // virtualenvwrapper's `mkproject` writes `.project` too: its environment is not pipenv's,
        // though it comes first and its project has a Pipfile.
        let wrapper = venv(&homes[1].join("shop"), &shop);
        let shop_python = venv(&homes[2].join(pipenv_env_name(&shop)), &shop);
        let blog_python = venv(&homes[2].join(pipenv_env_name(&blog)), &blog);

        assert_eq!(pipenv_env_in(&shop, &homes, None), Some(shop_python.clone()));
        assert_eq!(pipenv_env_in(&blog, &homes, None), Some(blog_python));
        // Opened in a sub-folder, the project is the one pipenv finds above it.
        assert_eq!(pipfile_dir(&shop.join("src/pkg")), Some(shop.clone()));
        assert_eq!(pipfile_dir(&tmp), None);

        let sdk = python_sdk(&shop_python, "venv", Some(&blog)).unwrap();
        assert_eq!((sdk.name.as_str(), sdk.source.as_str()), ("Python 3.12 (Pipenv: shop)", "pipenv"));
        assert_eq!(
            sdk.home.as_deref().map(|h| h.to_path_buf()),
            shop_python.parent().unwrap().parent().map(Into::into)
        );
        let sdk = python_sdk(&wrapper, "venv", None).unwrap();
        assert_eq!((sdk.name.as_str(), sdk.source.as_str()), ("Python 3.12 (shop)", "venv"));
    }

    #[test]
    fn a_pipenv_environment_inside_the_project_is_named_as_pipenvs() {
        let tmp = tempfile::tempdir().unwrap();
        let shop = tmp.path().join("shop");
        std::fs::create_dir_all(&shop).unwrap();
        std::fs::write(shop.join("Pipfile"), "").unwrap();
        let python = venv(&shop.join(".venv"), &shop);
        assert_eq!(project_venv_python(&shop), Some(python.clone()));
        assert_eq!(pipenv_env_in(&shop, &[], None), Some(python.clone()));
        assert_eq!(python_sdk(&python, "venv", Some(&shop)).unwrap().name, "Python 3.12 (Pipenv: shop)");
    }

    #[test]
    fn pipenv_uses_the_explicit_environment_without_a_project_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let tmp = dunce::canonicalize(tmp.path()).unwrap();
        let shop = tmp.join("shop");
        let subdir = shop.join("src");
        std::fs::create_dir_all(&subdir).unwrap();
        std::fs::write(shop.join("Pipfile"), "").unwrap();
        let homes = [tmp.join("workon")];
        venv(&homes[0].join(pipenv_env_name(&shop)), &shop);
        let named = homes[0].join("named");
        let named_python = venv(&named, &shop);
        std::fs::remove_file(named.join(".project")).unwrap();
        let outside = tmp.join("outside");
        let external_python = venv(&outside, &shop);
        std::fs::remove_file(outside.join(".project")).unwrap();
        let marker = shop.join(".venv");
        let name = Some(OsStr::new("named"));

        assert_eq!(pipenv_env_in(&shop, &homes, name), Some(named_python.clone()));
        assert_eq!(pipenv_env_in(&shop, &[], Some(outside.as_os_str())), Some(external_python.clone()));
        for pointer in ["../outside".into(), outside.to_string_lossy()] {
            std::fs::write(&marker, format!("  {pointer}\n")).unwrap();
            assert_eq!(pipenv_env_in(&shop, &homes, name), Some(external_python.clone()));
            assert_eq!(project_venv_python(&subdir), Some(external_python.clone()));
        }
        let sdk = detect(SdkKind::Python, Some(&subdir)).into_iter().next().unwrap();
        assert_eq!(sdk.path.to_path_buf(), external_python);
        assert_eq!((sdk.name.as_str(), sdk.source.as_str()), ("Python 3.12 (Pipenv: shop)", "pipenv"));

        std::fs::write(&marker, "named").unwrap();
        assert_eq!(pipenv_env_in(&shop, &homes, None), Some(named_python));
        std::fs::write(&marker, "missing").unwrap();
        assert_eq!(pipenv_env_in(&shop, &homes, name), None);
    }
}

#[cfg(test)]
mod conda_tests {
    use super::*;

    #[test]
    fn conda_envs_are_named_after_their_prefix_on_every_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("anaconda3");
        std::fs::create_dir_all(root.join("condabin")).unwrap();
        let name = |python: PathBuf| super::conda_env_name(&python);
        // Windows: python.exe at the prefix root.
        assert_eq!(name(root.join("envs/agent-gateway/python.exe")).as_deref(), Some("agent-gateway"));
        assert_eq!(name(root.join("python.exe")).as_deref(), Some("base"));
        // Unix: <prefix>/bin/python.
        assert_eq!(name(root.join("envs/ml/bin/python")).as_deref(), Some("ml"));
        assert_eq!(name(root.join("bin/python")).as_deref(), Some("base"));
        // A `--prefix` env outside envs/.
        assert_eq!(name(tmp.path().join("work/.conda/python.exe")).as_deref(), Some(".conda"));
        assert_eq!(
            super::conda_env_home(&root.join("envs/agent-gateway/python.exe")),
            Some(root.join("envs/agent-gateway"))
        );
    }

    #[test]
    fn conda_env_list_names_named_prefix_and_bare_prefix_envs() {
        // `conda env list` on Windows with Anaconda on a second drive (#2240).
        let output = "\
# conda environments:
#
base                  *  D:\\soft\\anaconda3
ml                       D:\\soft\\anaconda3\\envs\\ml
                         D:\\envs\\scratchpad
legacy                   C:\\Users\\dev\\.conda\\envs\\legacy
";
        let prefixes = conda_env_list_prefixes(output);
        assert_eq!(
            prefixes,
            vec![
                PathBuf::from("D:\\soft\\anaconda3"),
                PathBuf::from("D:\\soft\\anaconda3\\envs\\ml"),
                PathBuf::from("D:\\envs\\scratchpad"),
                PathBuf::from("C:\\Users\\dev\\.conda\\envs\\legacy"),
            ]
        );
    }

    #[test]
    fn conda_env_list_handles_unix_and_empty_output() {
        assert!(conda_env_list_prefixes("").is_empty());
        let output = "# conda environments:\n#\nbase  *  /opt/miniconda3\nprod     /opt/miniconda3/envs/prod\n";
        assert_eq!(
            conda_env_list_prefixes(output),
            vec![PathBuf::from("/opt/miniconda3"), PathBuf::from("/opt/miniconda3/envs/prod")]
        );
    }

    #[test]
    fn conda_env_list_parses_the_26_x_legend_and_prefix_envs() {
        // conda 26.9.4 on Windows (`conda create -p D:\condaenvs\camera`) (#3729): the
        // header grew the active/frozen legend, `--prefix` envs list bare paths, the
        // install root repeats (registered twice), and nothing is active in that shell.
        let output = "\
# conda environments:
#
# * -> active
# + -> frozen
base                     d:\\ProgramData\\miniconda3
camera                   D:\\condaenvs\\camera
llmstudy                 D:\\condaenvs\\llmstudy
base                     d:\\ProgramData\\miniconda3
";
        let prefixes = conda_env_list_prefixes(output);
        assert_eq!(
            prefixes,
            vec![
                PathBuf::from("d:\\ProgramData\\miniconda3"),
                PathBuf::from("D:\\condaenvs\\camera"),
                PathBuf::from("D:\\condaenvs\\llmstudy"),
                PathBuf::from("d:\\ProgramData\\miniconda3"),
            ]
        );
    }

    #[test]
    fn conda_environments_txt_names_every_registered_prefix() {
        // `~/.conda/environments.txt` written by the same conda 26.9.4 (#3729).
        let output = "\
C:\\Users\\dev\\miniconda3
D:\\condaenvs\\camera

# a comment line conda never writes, tolerated anyway
D:\\condaenvs\\llmstudy
";
        assert_eq!(
            conda_environments_txt_prefixes(output),
            vec![
                PathBuf::from("C:\\Users\\dev\\miniconda3"),
                PathBuf::from("D:\\condaenvs\\camera"),
                PathBuf::from("D:\\condaenvs\\llmstudy"),
            ]
        );
        assert!(conda_environments_txt_prefixes("").is_empty());
    }
}

#[cfg(test)]
mod env_manager_dir_tests {
    use super::*;
    use std::collections::HashMap;

    fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let vars: HashMap<String, OsString> = vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).into())).collect();
        move |key| vars.get(key).cloned()
    }

    #[test]
    fn poetry_venvs_follow_each_platforms_cache_dir() {
        let home = Path::new("/home/me");
        let local = Path::new("C:/Users/me/AppData/Local");
        assert_eq!(
            poetry_venv_dirs(Host::Windows, home, env(&[("LOCALAPPDATA", "C:/Users/me/AppData/Local")])),
            vec![local.join("pypoetry").join("Cache").join("virtualenvs")]
        );
        assert_eq!(
            poetry_venv_dirs(Host::Windows, home, env(&[])),
            vec![home.join("AppData").join("Local").join("pypoetry").join("Cache").join("virtualenvs")]
        );
        assert_eq!(
            poetry_venv_dirs(Host::Mac, home, env(&[])),
            vec![home.join("Library").join("Caches").join("pypoetry").join("virtualenvs")]
        );
        assert_eq!(
            poetry_venv_dirs(Host::Unix, home, env(&[])),
            vec![home.join(".cache").join("pypoetry").join("virtualenvs")]
        );
        assert_eq!(
            poetry_venv_dirs(Host::Unix, home, env(&[("XDG_CACHE_HOME", "/xdg/cache")])),
            vec![Path::new("/xdg/cache").join("pypoetry").join("virtualenvs")]
        );
    }

    #[test]
    fn hatch_environments_follow_each_platforms_data_dir() {
        let home = Path::new("/home/me");
        let virtual_in = |data: PathBuf| data.join("env").join("virtual");
        assert_eq!(
            hatch_env_dir(Host::Windows, home, env(&[("LOCALAPPDATA", "C:/Users/me/AppData/Local")])),
            virtual_in(Path::new("C:/Users/me/AppData/Local").join("hatch"))
        );
        assert_eq!(
            hatch_env_dir(Host::Mac, home, env(&[])),
            virtual_in(home.join("Library").join("Application Support").join("hatch"))
        );
        assert_eq!(hatch_env_dir(Host::Unix, home, env(&[])), virtual_in(home.join(".local/share").join("hatch")));
        assert_eq!(
            hatch_env_dir(Host::Unix, home, env(&[("XDG_DATA_HOME", "/xdg/data")])),
            virtual_in(Path::new("/xdg/data").join("hatch"))
        );
        assert_eq!(
            hatch_env_dir(Host::Mac, home, env(&[("HATCH_DATA_DIR", "/hatch"), ("XDG_DATA_HOME", "/xdg/data")])),
            virtual_in(PathBuf::from("/hatch"))
        );
    }

    #[test]
    fn workon_homes_follow_pipenv_and_virtualenvwrapper() {
        let home = Path::new("/home/me");
        let order = |xdg: PathBuf| {
            let wrapper = home.join(".virtualenvs");
            if cfg!(windows) { [wrapper, xdg] } else { [xdg, wrapper] }
        };
        let defaults = order(home.join(".local/share/virtualenvs"));
        assert_eq!(workon_homes(home, env(&[("WORKON_HOME", "")])), defaults);
        assert_eq!(
            workon_homes(home, env(&[("WORKON_HOME", "/envs"), ("XDG_DATA_HOME", "/xdg/data")])),
            std::iter::once(PathBuf::from("/envs"))
                .chain(order(PathBuf::from("/xdg/data/virtualenvs")))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn poetry_overrides_come_first_and_empty_ones_are_ignored() {
        let home = Path::new("/home/me");
        assert_eq!(
            poetry_venv_dirs(
                Host::Unix,
                home,
                env(&[("POETRY_VIRTUALENVS_PATH", "/envs"), ("POETRY_CACHE_DIR", "/cache")])
            ),
            vec![PathBuf::from("/envs"), Path::new("/cache").join("virtualenvs")]
        );
        assert_eq!(
            poetry_venv_dirs(Host::Unix, home, env(&[("POETRY_VIRTUALENVS_PATH", ""), ("POETRY_CACHE_DIR", "")])),
            vec![home.join(".cache").join("pypoetry").join("virtualenvs")]
        );
    }

    #[test]
    fn uv_pythons_follow_each_platforms_data_dir() {
        let home = Path::new("/home/me");
        let roaming = Path::new("C:/Users/me/AppData/Roaming");
        assert_eq!(
            uv_python_dirs(Host::Windows, home, env(&[("APPDATA", "C:/Users/me/AppData/Roaming")])),
            vec![roaming.join("uv").join("python"), roaming.join("uv").join("data").join("python")]
        );
        assert_eq!(
            uv_python_dirs(Host::Mac, home, env(&[])),
            vec![
                home.join(".local").join("share").join("uv").join("python"),
                home.join("Library").join("Application Support").join("uv").join("python"),
            ]
        );
        assert_eq!(
            uv_python_dirs(Host::Unix, home, env(&[("XDG_DATA_HOME", "/xdg/data")])),
            vec![Path::new("/xdg/data").join("uv").join("python")]
        );
        assert_eq!(
            uv_python_dirs(Host::Unix, home, env(&[("UV_PYTHON_INSTALL_DIR", "/pythons")])),
            vec![PathBuf::from("/pythons"), home.join(".local").join("share").join("uv").join("python")]
        );
    }

    #[test]
    fn a_uv_install_finds_its_interpreter_on_either_layout() {
        let tmp = tempfile::tempdir().unwrap();
        // Windows: python.exe at the install root.
        let windows = tmp.path().join("cpython-3.13.15-windows-x86_64-none");
        std::fs::create_dir_all(&windows).unwrap();
        std::fs::write(windows.join(exe("python")), "").unwrap();
        assert_eq!(uv_python(&windows), Some(windows.join(exe("python"))));
        // Unix: bin/python3.
        let unix = tmp.path().join("cpython-3.13.15-linux-x86_64-gnu");
        std::fs::create_dir_all(unix.join("bin")).unwrap();
        std::fs::write(unix.join("bin").join(exe("python3")), "").unwrap();
        assert_eq!(uv_python(&unix), Some(unix.join("bin").join(exe("python3"))));
        // uv's own bookkeeping folders (`.temp`, `.cache`) hold no interpreter.
        let temp = tmp.path().join(".temp");
        std::fs::create_dir_all(&temp).unwrap();
        assert_eq!(uv_python(&temp), None);
    }
}
