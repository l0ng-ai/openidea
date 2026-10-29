//! Finding installed interpreters and toolchains.

use crate::exec::{query, search_path, which};
use crate::{Sdk, SdkKind, bin_dir, exe, home_dir, pinned, venv_of};
use ide_core::version_managers::{self, Tool};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

const VERSION_TIMEOUT: Duration = Duration::from_secs(4);

/// Installed SDKs of `kind`, project-local ones (`root`) first. Blocking: runs
/// `--version` queries in parallel.
pub fn detect(kind: SdkKind, root: Option<&Path>) -> Vec<Sdk> {
    let mut out = match kind {
        SdkKind::Python => python(root),
        SdkKind::Node => node(),
        SdkKind::PackageManager => package_managers(),
        SdkKind::Rust => rust(),
        SdkKind::Go => go(),
        SdkKind::TypeScript => typescript(root),
        SdkKind::Jdk => jdk(),
        SdkKind::Maven => maven(),
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
        SdkKind::PackageManager | SdkKind::Rust | SdkKind::TypeScript => None,
    }
}

/// Moves the install the project pins for mise / asdf after the project's own SDKs
/// (virtualenvs), ahead of the rest.
fn pinned_first(sdks: &mut Vec<Sdk>, kind: SdkKind, root: &Path) {
    let Some((dir, _)) = tool_of(kind).and_then(|t| pinned::pinned_install(root, t)) else { return };
    let Some(i) = sdks.iter().position(|s| s.path.starts_with(&dir)) else { return };
    let at = sdks.iter().take_while(|s| s.source == "venv").count().min(i);
    let sdk = sdks.remove(i);
    sdks.insert(at, sdk);
}

/// Runs `f` over `items` on scoped threads (version queries spawn processes).
fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> Option<R> + Sync) -> Vec<R> {
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

/// `<root>/<venv>/bin/python` of the first project virtualenv.
pub(crate) fn project_venv_python(root: &Path) -> Option<PathBuf> {
    PROJECT_VENVS
        .iter()
        .map(|v| root.join(v))
        .filter(|v| v.join("pyvenv.cfg").is_file())
        .map(|v| v.join(bin_dir()).join(exe("python")))
        .find(|p| p.is_file())
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

fn python(root: Option<&Path>) -> Vec<Sdk> {
    let mut found: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(root) = root {
        for v in PROJECT_VENVS {
            let dir = root.join(v);
            if dir.join("pyvenv.cfg").is_file() {
                found.push((dir.join(bin_dir()).join(exe("python")), "venv"));
            }
        }
    }
    if let Ok(venv) = std::env::var("VIRTUAL_ENV") {
        found.push((Path::new(&venv).join(bin_dir()).join(exe("python")), "venv"));
    }
    if let Some(home) = home_dir() {
        // Virtualenvs managed by virtualenvwrapper / pipenv / poetry.
        for dir in [".virtualenvs", ".local/share/virtualenvs", "Library/Caches/pypoetry/virtualenvs"] {
            for env in subdirs(&home.join(dir)) {
                found.push((env.join(bin_dir()).join(exe("python")), "venv"));
            }
        }
        let pyenv = std::env::var_os("PYENV_ROOT").map(PathBuf::from).unwrap_or_else(|| home.join(".pyenv"));
        for v in subdirs(&pyenv.join("versions")) {
            found.push((v.join(bin_dir()).join(exe("python")), "pyenv"));
        }
        for v in subdirs(&home.join(".local/share/uv/python")) {
            found.push((v.join(bin_dir()).join(exe("python3")), "uv"));
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
        for base in conda_roots {
            found.push((base.join(bin_dir()).join(exe("python")), "conda"));
            for env in subdirs(&base.join("envs")) {
                found.push((env.join(bin_dir()).join(exe("python")), "conda"));
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
                seen_venv.insert(venv_of(p).unwrap_or_else(|| p.clone()))
            } else {
                seen_real.insert(p.canonicalize().unwrap_or_else(|_| p.clone()))
            }
        })
        .map(|(p, source)| if venv_of(&p).is_some() && source != "conda" { (p, "venv") } else { (p, source) })
        .collect();
    par_map(&candidates, |(path, source)| python_sdk(path, source, root))
}

pub(crate) fn python_sdk(path: &Path, source: &str, root: Option<&Path>) -> Option<Sdk> {
    let version = query(path, &["--version"], VERSION_TIMEOUT)
        .and_then(|v| v.strip_prefix("Python ").map(str::to_owned))
        .or_else(|| pyvenv_version(path))?;
    let short = version.split('.').take(2).collect::<Vec<_>>().join(".");
    let venv = venv_of(path);
    let label = match (&venv, source) {
        (Some(home), _) => {
            let dir = home.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            // `.venv` inside a project reads better as the project name, like PyCharm.
            let owner = home.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned());
            match (dir.starts_with('.') || dir == "venv" || dir == "env", owner, root) {
                (true, Some(owner), Some(root)) if home.parent() == Some(root) => format!("Python {short} ({owner})"),
                _ => format!("Python {short} ({dir})"),
            }
        }
        (None, "conda") => {
            let env = path
                .parent()
                .and_then(Path::parent)
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned());
            format!("Python {short} (conda: {})", env.unwrap_or_default())
        }
        (None, "pyenv") => format!("Python {short} (pyenv)"),
        (None, tool @ ("uv" | "mise" | "asdf")) => format!("Python {short} ({tool})"),
        _ => format!("Python {short}"),
    };
    Some(Sdk {
        path: path.into(),
        name: label,
        version: Some(version),
        source: source.to_owned(),
        home: venv.or_else(|| path.parent().and_then(Path::parent).map(Path::to_path_buf)).map(Into::into),
        extra: None,
    })
}

fn pyvenv_version(python: &Path) -> Option<String> {
    let cfg = std::fs::read_to_string(venv_of(python)?.join("pyvenv.cfg")).ok()?;
    cfg.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        matches!(k.trim(), "version" | "version_info").then(|| v.trim().to_owned())
    })
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> =
        std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    out.sort();
    out
}

// ------------------------------------------------------------------ node

fn node() -> Vec<Sdk> {
    let mut found: Vec<(PathBuf, &'static str)> = Vec::new();
    // A mise / asdf shim picks the version by directory: its installs are listed instead.
    if let Some(p) = which("node").filter(|p| !version_managers::is_shim(p)) {
        let source = version_managers::manager_of(&p).unwrap_or("path");
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
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        found.push((PathBuf::from(p), "system"));
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

// ------------------------------------------------------------------ typescript

/// `node_modules/typescript/lib` of the project (root or a direct workspace member).
pub(crate) fn workspace_tsdk(root: &Path) -> Option<PathBuf> {
    let lib = root.join("node_modules/typescript/lib");
    lib.join("tsserver.js").is_file().then_some(lib)
}

fn typescript(root: Option<&Path>) -> Vec<Sdk> {
    let mut out = Vec::new();
    if let Some(lib) = root.and_then(workspace_tsdk) {
        let version = std::fs::read_to_string(lib.parent().unwrap_or(&lib).join("package.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(str::to_owned));
        out.push(Sdk {
            path: lib.clone().into(),
            name: format!("TypeScript {}", version.clone().unwrap_or_default()).trim().to_owned(),
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
    let java_home = std::env::var_os("JAVA_HOME").and_then(|h| dunce::canonicalize(h).ok());
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
    if let Some(mvn) = on_path.and_then(|p| dunce::canonicalize(p).ok())
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
        let home = dunce::canonicalize(&home).unwrap_or(home);
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
