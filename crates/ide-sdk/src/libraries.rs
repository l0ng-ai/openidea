//! "External Libraries" of a project (IDEA's library / SDK roots in the
//! Project view): the folders holding the sources of the project's SDKs and
//! dependencies — the Python interpreter's standard library and site-packages,
//! the JDK, `node_modules` packages, Cargo crates and the Rust standard
//! library, GOROOT and the Go module cache.
//!
//! Ecosystems are detected in the project and its modules. SDK and graph probes
//! are cached until manifests or settings change; Node packages are read on refresh.
//!
//! Archives are listed as browsable roots (`<archive>!`, see `ide_vfs`): the
//! JDK's `src.zip` and the Maven / Gradle dependency jars (source attachments resolved by JDT).

use crate::exe;
use crate::exec::{query_in, query_in_cancellable, which};
use ide_core::CancellationToken;
use ide_core::settings::Settings;
use quick_xml::{Reader, XmlVersion, events::Event};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

/// One SDK or library with its source folders (`< Python 3.12 (.venv) >`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGroup {
    /// Display name, e.g. `Python 3.12 (.venv)`.
    pub name: String,
    /// `python` | `jdk` | `nodeModules` | `nodeCore` | `rust` | `cargo` | `go` | `goModules` | `maven` | `gradle` | `classpath`.
    pub kind: String,
    pub roots: Vec<LibraryRoot>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRoot {
    /// Folder name, e.g. `python3.12` or `site-packages`, the package (`serde 1.0.200`)
    /// or the archive (`src.zip`, `guava-33.0.0-jre-sources.jar`).
    pub name: String,
    /// A folder, or an archive's root (`<archive>!`).
    pub path: ide_core::IpcPath,
}

const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
/// `cargo metadata` / `go list` load the whole dependency graph.
const GRAPH_TIMEOUT: Duration = Duration::from_secs(60);

/// Prints the interpreter's library folders as JSON: `[stdlib, platstdlib, purelib, platlib]`.
const PYTHON_PATHS: &str = "import json,sysconfig;p=sysconfig.get_paths();\
print(json.dumps([p.get(k) for k in ('stdlib','platstdlib','purelib','platlib')]))";

const JAVA_MANIFESTS: &[&str] =
    &["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];
const CARGO_MANIFESTS: &[&str] = &["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"];
const GO_MANIFESTS: &[&str] = &["go.mod", "go.sum", "go.work"];
const RUBY_MANIFESTS: &[&str] = &["Gemfile", "Gemfile.lock", ".ruby-version", ".tool-versions", "mise.toml"];

/// A Maven / Gradle dependency of the project, from the build model.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BuildDependency {
    /// Resolved by Gradle (else Maven): looked up in the Gradle cache first.
    pub gradle: bool,
    pub group: String,
    pub artifact: String,
    pub version: String,
}

/// The project's SDK and dependency library groups. Runs the
/// toolchains (in parallel), so call it off the UI / command thread.
/// `dependencies` (from the build model) are listed when their jars are in the local repositories.
pub fn project_libraries(root: &Path, settings: &Settings, dependencies: &[BuildDependency]) -> Vec<LibraryGroup> {
    project_libraries_stream(root, settings, dependencies, &CancellationToken::new(), &|_| {})
}

/// Publishes each ecosystem independently; a failed or slow graph cannot hide other libraries.
pub fn project_libraries_stream(
    root: &Path,
    settings: &Settings,
    dependencies: &[BuildDependency],
    cancel: &CancellationToken,
    on_groups: &(dyn Fn(Vec<LibraryGroup>) + Sync),
) -> Vec<LibraryGroup> {
    type Detect = fn(&Path, &Settings, &CancellationToken) -> Vec<LibraryGroup>;
    let detectors: [Detect; 5] = [python_groups, jdk_groups, node_groups, go_groups, ruby_groups];
    let roots = library_project_roots(root, cancel);
    let settings = module_settings(root, settings);
    std::thread::scope(|s| {
        let handles: Vec<_> = detectors
            .iter()
            .map(|d| {
                let (roots, settings) = (&roots, &settings);
                s.spawn(move || {
                    let mut groups = Vec::new();
                    for dir in roots {
                        if cancel.is_cancelled() {
                            break;
                        }
                        let batch = d(dir, settings, cancel);
                        if !cancel.is_cancelled() && !batch.is_empty() {
                            on_groups(batch.clone());
                            groups.extend(batch);
                        }
                    }
                    groups
                })
            })
            .collect();
        let rust = s.spawn(|| {
            let project = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
            let mut seen = std::collections::HashSet::new();
            let mut groups = Vec::new();
            for dir in &roots {
                if cancel.is_cancelled() {
                    break;
                }
                if !dir.join("Cargo.toml").is_file() {
                    continue;
                }
                let bin = crate::apply::rust_bin(dir, &settings).map(|(bin, _)| bin);
                let workspace = tool(bin, "cargo")
                    .and_then(|cargo| {
                        query_in_cancellable(
                            &cargo,
                            &["locate-project", "--workspace", "--message-format", "plain"],
                            dir,
                            &[],
                            QUERY_TIMEOUT,
                            cancel,
                        )
                    })
                    .map(PathBuf::from)
                    .filter(|manifest| manifest.is_file())
                    .and_then(|manifest| manifest.parent().map(Path::to_path_buf))
                    .unwrap_or_else(|| dir.clone());
                if !seen.insert(workspace.clone()) {
                    continue;
                }
                // Resolving writes a Cargo.lock. A crate outside the project's workspace (one in its
                // `exclude`) without its own keeps none, as RustRover leaves crates it doesn't attach.
                let locked = workspace.canonicalize().unwrap_or_else(|_| workspace.clone()) != project
                    && !workspace.join("Cargo.lock").is_file();
                let batch = rust_groups(&workspace, &settings, locked, cancel);
                if !cancel.is_cancelled() && !batch.is_empty() {
                    on_groups(batch.clone());
                    groups.extend(batch);
                }
            }
            groups
        });
        let deps = s.spawn(|| {
            if cancel.is_cancelled() {
                return Vec::new();
            }
            let mut groups = dependency_groups(root, &settings, dependencies);
            groups.extend(classpath_groups(&roots));
            groups.extend(project_structure_groups(root, &settings));
            if !cancel.is_cancelled() && !groups.is_empty() {
                on_groups(groups.clone());
            }
            groups
        });
        merge_groups(
            handles
                .into_iter()
                .chain([rust, deps])
                .flat_map(|h| {
                    h.join().unwrap_or_else(|error| {
                        tracing::warn!(?error, "external libraries provider panicked");
                        Vec::new()
                    })
                })
                .collect(),
        )
    })
}

fn library_project_roots(root: &Path, cancel: &CancellationToken) -> Vec<PathBuf> {
    use ide_core::project_roots::{
        SEARCH_DEPTH, discover_matching_cancellable, expand_members, node_workspace_members,
    };
    let mut roots = discover_matching_cancellable(root, SEARCH_DEPTH, false, cancel, |dir| {
        [
            "package.json",
            "pnpm-workspace.yaml",
            "Cargo.toml",
            "go.mod",
            "go.work",
            "Gemfile",
            ".ruby-version",
            "pyproject.toml",
            "setup.py",
            "requirements.txt",
            ".python-version",
            ".tool-versions",
            "mise.toml",
        ]
        .iter()
        .chain(JAVA_MANIFESTS)
        .any(|name| dir.join(name).is_file())
            || [".venv", "venv", ".pixi"].iter().any(|name| dir.join(name).is_dir())
            || dir == root
    });
    let mut scanned = std::collections::HashSet::new();
    let mut index = 0;
    while index < roots.len() && !cancel.is_cancelled() {
        let dir = roots[index].clone();
        index += 1;
        if !scanned.insert(dir.clone()) {
            continue;
        }
        let mut members = node_workspace_members(&dir);
        if let Some(manifest) = std::fs::read_to_string(dir.join("Cargo.toml"))
            .ok()
            .and_then(|text| toml::from_str::<toml::Value>(&text).ok())
        {
            let patterns: Vec<String> = manifest
                .get("workspace")
                .and_then(|w| w.get("members"))
                .and_then(toml::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(toml::Value::as_str)
                .map(str::to_owned)
                .collect();
            members.extend(expand_members(&dir, &patterns, "Cargo.toml"));
        }
        if let Ok(work) = std::fs::read_to_string(dir.join("go.work")) {
            members.extend(ide_run::go::work_modules(&work).into_iter().map(|path| dir.join(path)));
        }
        roots.extend(
            members
                .into_iter()
                .map(|dir| ide_core::project_roots::resolve(&dir, Path::new("")))
                .filter(|dir| !scanned.contains(dir)),
        );
    }
    roots.sort();
    roots.dedup();
    roots
}

fn module_settings(root: &Path, settings: &Settings) -> Settings {
    let mut settings = settings.clone();
    let l = &mut settings.languages;
    for value in [
        &mut l.python.interpreter,
        &mut l.ruby.interpreter,
        &mut l.node.interpreter,
        &mut l.rust.toolchain,
        &mut l.rust.stdlib,
        &mut l.go.goroot,
        &mut l.go.gopath,
        &mut l.java.jdk,
    ] {
        if let Some(path) = crate::apply::setting_path(root, value) {
            *value = path.to_string_lossy().into_owned();
        }
    }
    settings
}

pub fn merge_groups(groups: Vec<LibraryGroup>) -> Vec<LibraryGroup> {
    let mut merged: Vec<LibraryGroup> = Vec::new();
    for group in groups {
        if let Some(existing) = merged.iter_mut().find(|g| g.kind == group.kind && g.name == group.name) {
            for root in group.roots {
                if !existing.roots.iter().any(|r| r.path == root.path) {
                    existing.roots.push(root);
                }
            }
        } else {
            merged.push(group);
        }
    }
    merged
}

// ------------------------------------------------------------------ cache

/// Size and modification time of each manifest (`None`: missing).
pub(crate) type Stamp = Vec<(PathBuf, Option<(SystemTime, u64)>)>;

struct Cached {
    /// Settings the result depends on.
    key: String,
    stamp: Stamp,
    groups: Vec<LibraryGroup>,
}

static CACHE: LazyLock<Mutex<HashMap<(PathBuf, &'static str), Cached>>> = LazyLock::new(Default::default);

pub fn invalidate_go(root: &Path) {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).remove(&(root.to_path_buf(), "go"));
}

pub(crate) fn stamp(files: &[PathBuf]) -> Stamp {
    files
        .iter()
        .map(|f| {
            let meta = std::fs::metadata(f).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
            (f.clone(), meta)
        })
        .collect()
}

/// `detect()` unless the last result for `(root, ecosystem)` was computed with
/// the same `key` and unchanged `manifests`.
pub(crate) fn cached(
    root: &Path,
    ecosystem: &'static str,
    key: String,
    manifests: &[PathBuf],
    detect: impl FnOnce() -> Vec<LibraryGroup>,
) -> Vec<LibraryGroup> {
    cached_optional(root, ecosystem, key, manifests, || Some(detect())).unwrap_or_default()
}

fn cached_cancellable(
    root: &Path,
    ecosystem: &'static str,
    key: String,
    manifests: &[PathBuf],
    cancel: &CancellationToken,
    detect: impl FnOnce() -> Vec<LibraryGroup>,
) -> Vec<LibraryGroup> {
    cached_optional(root, ecosystem, key, manifests, || {
        let groups = detect();
        (!cancel.is_cancelled()).then_some(groups)
    })
    .unwrap_or_default()
}

fn cached_optional(
    root: &Path,
    ecosystem: &'static str,
    key: String,
    manifests: &[PathBuf],
    detect: impl FnOnce() -> Option<Vec<LibraryGroup>>,
) -> Option<Vec<LibraryGroup>> {
    let id = (root.to_path_buf(), ecosystem);
    let now = stamp(manifests);
    if let Some(c) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&id)
        && c.key == key
        && c.stamp == now
    {
        return Some(c.groups.clone());
    }
    let groups = detect()?;
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Cached { key, stamp: now, groups: groups.clone() });
    Some(groups)
}

/// `names` below `root` when at least one of them exists (the project uses that ecosystem).
fn manifests(root: &Path, names: &[&str]) -> Option<Vec<PathBuf>> {
    let files: Vec<PathBuf> = names.iter().map(|n| root.join(n)).collect();
    files.iter().any(|f| f.is_file()).then_some(files)
}

fn group(name: impl Into<String>, kind: &str, roots: Vec<LibraryRoot>) -> Option<LibraryGroup> {
    (!roots.is_empty()).then(|| LibraryGroup { name: name.into(), kind: kind.into(), roots })
}

/// A configured toolchain `bin` dir's `name`, else `name` on the search path.
fn tool(bin: Option<PathBuf>, name: &str) -> Option<PathBuf> {
    bin.map(|b| b.join(exe(name))).filter(|p| p.is_file()).or_else(|| which(name))
}

// ------------------------------------------------------------------ python

fn python_groups(root: &Path, s: &Settings, cancel: &CancellationToken) -> Vec<LibraryGroup> {
    let Some(python) = crate::apply::python_interpreter(root, s) else { return Vec::new() };
    let mut files = vec![python.clone()];
    files.extend(crate::venv_of(&python).map(|v| v.join("pyvenv.cfg")));
    cached_cancellable(root, "python", python.display().to_string(), &files, cancel, || {
        python_libraries(&python, Some(root)).into_iter().collect()
    })
}

/// Standard library and site-packages folders of a Python interpreter.
pub fn python_libraries(python: &Path, root: Option<&Path>) -> Option<LibraryGroup> {
    // In a neutral directory: the working directory comes first on `sys.path` for `-c`.
    let dir = crate::python::neutral_dir();
    let out = query_in(python, &["-c", PYTHON_PATHS], dir.as_ref().map(|d| d.path()), &[], QUERY_TIMEOUT)?;
    let name = crate::discover::python_sdk(python, "system", root).map(|s| s.name).unwrap_or_else(|| "Python".into());
    group(name, "python", library_roots(parse_python_paths(&out)))
}

pub(crate) fn parse_python_paths(out: &str) -> Vec<PathBuf> {
    let json = out.lines().rev().find(|l| l.trim_start().starts_with('[')).unwrap_or("[]");
    serde_json::from_str::<Vec<Option<String>>>(json)
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .map(PathBuf::from)
        .collect()
}

/// Existing folders among `paths`, deduplicated (also through symlinks), in order.
pub(crate) fn library_roots(paths: Vec<PathBuf>) -> Vec<LibraryRoot> {
    named_roots(
        paths
            .into_iter()
            .map(|p| {
                (p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string()), p)
            })
            .collect(),
    )
}

/// Existing folders among `(name, path)`, deduplicated (also through symlinks), in order.
pub(crate) fn named_roots(roots: Vec<(String, PathBuf)>) -> Vec<LibraryRoot> {
    let mut seen = std::collections::HashSet::new();
    roots
        .into_iter()
        .filter(|(_, p)| p.is_dir() && seen.insert(dunce::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .map(|(name, p)| LibraryRoot { name, path: p.into() })
        .collect()
}

// ------------------------------------------------------------------ ruby

fn ruby_groups(root: &Path, s: &Settings, cancel: &CancellationToken) -> Vec<LibraryGroup> {
    let Some(files) = manifests(root, RUBY_MANIFESTS) else { return Vec::new() };
    if !root.join("Gemfile").is_file() && !root.join(".ruby-version").is_file() {
        return Vec::new();
    }
    let Some(ruby) = crate::apply::ruby_interpreter(root, s) else { return Vec::new() };
    cached_cancellable(root, "ruby", ruby.display().to_string(), &files, cancel, || {
        let name = crate::ruby::ruby_sdk(&ruby, "system").map(|s| s.name).unwrap_or_else(|| "Ruby".into());
        let (stdlib, gems) = crate::ruby::library_roots(&ruby, Some(root));
        let mut out = Vec::new();
        out.extend(group(name, "ruby", named_roots(stdlib)));
        out.extend(group("Gems", "gems", named_roots(gems)));
        out
    })
}

// ------------------------------------------------------------------ jdk

fn jdk_groups(root: &Path, s: &Settings, cancel: &CancellationToken) -> Vec<LibraryGroup> {
    // Java modules without a build manifest carry `.classpath` / `.project` /
    // `.idea` instead; a configured JDK or declared source roots mark one too.
    let files = match manifests(root, JAVA_MANIFESTS) {
        Some(files) => files,
        None => {
            let java = [".classpath", ".project"].iter().any(|f| root.join(f).is_file())
                || idea_java_project(root)
                || !s.languages.java.jdk.trim().is_empty()
                || !s.project_structure.source_roots.is_empty();
            if !java {
                return Vec::new();
            }
            [".classpath", ".project"].iter().map(|f| root.join(f)).collect()
        }
    };
    cached_cancellable(root, "jdk", s.languages.java.jdk.clone(), &files, cancel, || {
        let jdk = crate::apply::project_jdk(root, s).or_else(|| {
            crate::java::pick_jdk(&crate::java::installed_jdks(), crate::java::project_java_version(root)).cloned()
        });
        jdk.and_then(|j| jdk_library(&j)).into_iter().collect()
    })
}

fn project_structure_groups(root: &Path, s: &Settings) -> Vec<LibraryGroup> {
    let mut out = Vec::new();
    for lib in &s.project_structure.libraries {
        let mut roots = Vec::new();
        for entry in lib.classes.iter().chain(&lib.sources) {
            let Some(path) = crate::apply::setting_path(root, entry) else { continue };
            let label = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string());
            if path.is_file() {
                roots.push(LibraryRoot { name: label, path: ide_vfs::archive_root(&path).into() });
            } else if path.is_dir() {
                roots.push(LibraryRoot { name: label, path: path.into() });
            }
        }
        if !roots.is_empty() {
            let name = if lib.name.trim().is_empty() { roots[0].name.clone() } else { lib.name.trim().to_owned() };
            out.push(LibraryGroup { name, kind: "library".into(), roots });
        }
    }
    out
}

/// JDT libraries of modules without a Maven / Gradle manifest: each `.classpath`
/// in `roots` (the project root and its discovered modules) becomes a group.
fn classpath_groups(roots: &[PathBuf]) -> Vec<LibraryGroup> {
    let mut out = Vec::new();
    for dir in roots {
        let file = dir.join(".classpath");
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let mut seen = std::collections::HashSet::new();
        let entries: Vec<LibraryRoot> = classpath_entries(dir, &text)
            .into_iter()
            .filter(|path| seen.insert(dunce::canonicalize(path).unwrap_or_else(|_| path.clone())))
            .filter_map(|path| {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.display().to_string());
                if path.is_file() {
                    Some(LibraryRoot { name, path: ide_vfs::archive_root(&path).into() })
                } else {
                    path.is_dir().then(|| LibraryRoot { name, path: path.into() })
                }
            })
            .collect();
        if !entries.is_empty() {
            let name = dir
                .file_name()
                .map(|n| format!(".classpath ({})", n.to_string_lossy()))
                .unwrap_or_else(|| ".classpath".into());
            out.push(LibraryGroup { name, kind: "classpath".into(), roots: entries });
        }
    }
    out
}

/// `path` (or its `sourcepath`, when it exists) of `.classpath` `kind="lib"`
/// entries resolved against the module dir; entries pointing nowhere are dropped.
pub(crate) fn classpath_entries(dir: &Path, text: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut reader = Reader::from_str(text);
    loop {
        match reader.read_event() {
            Ok(Event::Empty(ref tag)) | Ok(Event::Start(ref tag)) => {
                if !tag.local_name().as_ref().eq_ignore_ascii_case("classpathentry") {
                    continue;
                }
                let (mut kind, mut path, mut srcpath) = (String::new(), String::new(), String::new());
                for a in tag.attributes().flatten() {
                    let Ok(value) = a.normalized_value(XmlVersion::Implicit1_0) else { continue };
                    match a.key.as_ref() {
                        "kind" => kind = value.into_owned(),
                        "path" => path = value.into_owned(),
                        "sourcepath" => srcpath = value.into_owned(),
                        _ => {}
                    }
                }
                if kind != "lib" {
                    continue;
                }
                for p in [&srcpath, &path] {
                    let p = p.trim_matches('/');
                    if p.is_empty() {
                        continue;
                    }
                    let candidate = dir.join(p);
                    if candidate.exists() {
                        out.push(candidate);
                        break;
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    out
}

/// The JDK home and its sources (`lib/src.zip`, `src.zip` in JDK 8) as library roots.
/// An IntelliJ project (`.idea`) that is a Java one: a Java SDK or language level in
/// `misc.xml`, or a Java module file. GoLand, PyCharm and WebStorm write `.idea` too, so the
/// folder alone doesn't make a project need the JDK.
fn idea_java_project(root: &Path) -> bool {
    let idea = root.join(".idea");
    if !idea.is_dir() {
        return false;
    }
    let misc = std::fs::read_to_string(idea.join("misc.xml")).unwrap_or_default();
    if misc.contains("JavaSDK") || misc.contains("languageLevel=\"JDK_") {
        return true;
    }
    let java_module = |dir: &Path| {
        std::fs::read_dir(dir).into_iter().flatten().flatten().any(|e| {
            e.path().extension().is_some_and(|x| x == "iml")
                && std::fs::read_to_string(e.path()).is_ok_and(|t| t.contains("JAVA_MODULE"))
        })
    };
    java_module(root) || java_module(&idea)
}

pub(crate) fn jdk_library(jdk: &crate::java::Jdk) -> Option<LibraryGroup> {
    let name = jdk_name(&jdk.home).unwrap_or_else(|| format!("JDK {}", jdk.major));
    let mut roots = named_roots(vec![(name.clone(), jdk.home.clone())]);
    if let Some(src) = ["lib/src.zip", "src.zip"].iter().map(|r| jdk.home.join(r)).find(|p| p.is_file()) {
        roots.push(LibraryRoot { name: "src.zip".into(), path: ide_vfs::archive_root(&src).into() });
    }
    group(name, "jdk", roots)
}

/// `temurin-21` for `…/temurin-21.jdk/Contents/Home` (macOS bundles) or `…/temurin-21`.
pub(crate) fn jdk_name(home: &Path) -> Option<String> {
    let dir = if home.ends_with("Contents/Home") { home.parent()?.parent()? } else { home };
    let name = dir.file_name()?.to_string_lossy();
    Some(name.strip_suffix(".jdk").unwrap_or(&name).to_owned())
}

// ------------------------------------------------------------------ maven / gradle

pub fn dependency_groups(root: &Path, s: &Settings, deps: &[BuildDependency]) -> Vec<LibraryGroup> {
    if deps.is_empty() {
        return Vec::new();
    }
    let maven_repo = crate::apply::maven_local_repository(root, s).or_else(crate::apply::default_maven_repository);
    // The home Gradle runs with, not just the one this process inherited.
    let gradle_home = crate::apply::setting_path(root, &s.languages.java.gradle.user_home).or_else(gradle_user_home);
    let files: Vec<PathBuf> = JAVA_MANIFESTS.iter().map(|n| root.join(n)).collect();
    let key = format!("{maven_repo:?}\n{gradle_home:?}\n{deps:?}");
    cached(root, "buildDependencies", key, &files, || {
        dependency_libraries(deps, maven_repo.as_deref(), gradle_home.as_deref())
    })
}

/// `$GRADLE_USER_HOME`, else `~/.gradle`: what Gradle uses when Settings › Gradle ›
/// user home is empty.
fn gradle_user_home() -> Option<PathBuf> {
    std::env::var_os("GRADLE_USER_HOME").map(PathBuf::from).or_else(|| Some(crate::home_dir()?.join(".gradle")))
}

/// One `Maven: g:a:v` / `Gradle: g:a:v` group per dependency whose jar is in a
/// local repository, its root being the binary jar so Java classes open through JDT's source provider.
pub(crate) fn dependency_libraries(
    deps: &[BuildDependency],
    maven_repo: Option<&Path>,
    gradle_home: Option<&Path>,
) -> Vec<LibraryGroup> {
    let mut deps: Vec<&BuildDependency> = deps.iter().collect();
    deps.sort();
    deps.dedup();
    deps.into_iter()
        .filter_map(|d| {
            let maven = || maven_repo.and_then(|r| maven_jar(r, d));
            let gradle = || gradle_home.and_then(|h| gradle_jar(h, d));
            let jar = if d.gradle { gradle().or_else(maven) } else { maven().or_else(gradle) }?;
            let tool = if d.gradle { "Gradle" } else { "Maven" };
            let name = jar.file_name()?.to_string_lossy().into_owned();
            group(
                format!("{tool}: {}:{}:{}", d.group, d.artifact, d.version),
                &tool.to_lowercase(),
                vec![LibraryRoot { name, path: ide_vfs::archive_root(&jar).into() }],
            )
        })
        .collect()
}

/// The `.toml` of a version catalog published as `group:artifact:version` (Gradle's
/// `version-catalog` plugin) that a build imports with `from("…")`: from Gradle's cache, else
/// the local Maven repository. `None` until a build has downloaded it.
pub fn published_version_catalog(root: &Path, s: &Settings, coordinates: &str) -> Option<PathBuf> {
    let mut parts = coordinates.trim().split(':');
    let d = BuildDependency {
        gradle: true,
        group: parts.next()?.to_owned(),
        artifact: parts.next()?.to_owned(),
        version: parts.next()?.to_owned(),
    };
    if parts.next().is_some() || !valid_coordinate(&d) {
        return None;
    }
    let file = format!("{}-{}.toml", d.artifact, d.version);
    let gradle = crate::apply::setting_path(root, &s.languages.java.gradle.user_home).or_else(gradle_user_home);
    let cached = gradle.and_then(|home| {
        let dir = home.join("caches/modules-2/files-2.1").join(&d.group).join(&d.artifact).join(&d.version);
        let mut found: Vec<PathBuf> =
            std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path().join(&file)).filter(|p| p.is_file()).collect();
        found.sort();
        found.into_iter().next()
    });
    cached.or_else(|| {
        let repo = crate::apply::maven_local_repository(root, s).or_else(crate::apply::default_maven_repository)?;
        let path = repo.join(d.group.replace('.', "/")).join(&d.artifact).join(&d.version).join(&file);
        path.is_file().then_some(path)
    })
}

/// No path separators, interpolations or `..` segments (coordinates become paths).
fn valid_coordinate(d: &BuildDependency) -> bool {
    [&d.group, &d.artifact, &d.version]
        .iter()
        .all(|p| !p.is_empty() && !p.contains(['/', '\\', '$']) && !p.split('.').any(str::is_empty))
}

/// `<repo>/<group as path>/<artifact>/<version>/<artifact>-<version>(-sources).jar`.
pub(crate) fn maven_jar(repo: &Path, d: &BuildDependency) -> Option<PathBuf> {
    if !valid_coordinate(d) {
        return None;
    }
    let dir = repo.join(d.group.replace('.', "/")).join(&d.artifact).join(&d.version);
    [".jar", "-sources.jar"]
        .iter()
        .map(|suffix| dir.join(format!("{}-{}{suffix}", d.artifact, d.version)))
        .find(|p| p.is_file())
}

/// `<gradle home>/caches/modules-2/files-2.1/<group>/<artifact>/<version>/<hash>/<artifact>-<version>(-sources).jar`.
pub(crate) fn gradle_jar(home: &Path, d: &BuildDependency) -> Option<PathBuf> {
    if !valid_coordinate(d) {
        return None;
    }
    let dir = home.join("caches/modules-2/files-2.1").join(&d.group).join(&d.artifact).join(&d.version);
    let mut hashes: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).collect();
    hashes.sort();
    [".jar", "-sources.jar"].iter().find_map(|suffix| {
        let file = format!("{}-{}{suffix}", d.artifact, d.version);
        hashes.iter().map(|h| h.join(&file)).find(|p| p.is_file())
    })
}

// ------------------------------------------------------------------ node

fn node_groups(root: &Path, s: &Settings, _cancel: &CancellationToken) -> Vec<LibraryGroup> {
    if !root.join("package.json").is_file() {
        return Vec::new();
    }
    let node = tool(crate::apply::node_dir(root, s), "node");
    node_libraries(root, node.as_deref())
}

/// `node_modules/<dep>` of the direct dependencies in `package.json`, and the
/// Node.js core typings (`@types/node`, from the project or the runtime's global `lib`).
pub(crate) fn node_libraries(root: &Path, node: Option<&Path>) -> Vec<LibraryGroup> {
    let manifest = std::fs::read_to_string(root.join("package.json")).unwrap_or_else(|error| {
        tracing::warn!(?root, %error, "cannot read package.json for external libraries");
        String::new()
    });
    let resolve =
        |name: &str| root.ancestors().map(|dir| dir.join("node_modules").join(name)).find(|path| path.is_dir());
    let deps = named_roots(
        package_dependencies(&manifest).into_iter().filter_map(|d| Some((d.clone(), resolve(&d)?))).collect(),
    );
    let mut core: Vec<_> = resolve("@types/node").into_iter().collect();
    // `<prefix>/bin/node` → `<prefix>/lib/node_modules`.
    if let Some(prefix) =
        node.and_then(|n| dunce::canonicalize(n).ok()).and_then(|n| Some(n.parent()?.parent()?.to_path_buf()))
    {
        core.push(prefix.join("lib/node_modules/@types/node"));
    }
    let mut core = named_roots(core.into_iter().map(|p| ("@types/node".to_owned(), p)).collect());
    core.truncate(1);
    [group("Node.js Core", "nodeCore", core), group("node_modules", "nodeModules", deps)]
        .into_iter()
        .flatten()
        .collect()
}

/// Names of the direct dependencies (all dependency kinds), sorted, deduplicated.
pub(crate) fn package_dependencies(package_json: &str) -> Vec<String> {
    let json = match serde_json::from_str::<serde_json::Value>(package_json) {
        Ok(json) => json,
        Err(error) => {
            tracing::warn!(%error, "cannot parse package.json for external libraries");
            return Vec::new();
        }
    };
    let mut names: Vec<String> = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
        .iter()
        .filter_map(|k| json.get(k)?.as_object())
        .flat_map(|o| o.keys().cloned())
        .filter(|n| !n.is_empty() && !n.contains("..") && !n.starts_with('/'))
        .collect();
    names.sort();
    names.dedup();
    names
}

// ------------------------------------------------------------------ rust

/// `locked`: `cargo metadata --locked`, which fails instead of writing a Cargo.lock.
fn rust_groups(root: &Path, s: &Settings, locked: bool, cancel: &CancellationToken) -> Vec<LibraryGroup> {
    let Some(files) = manifests(root, CARGO_MANIFESTS) else { return Vec::new() };
    if !root.join("Cargo.toml").is_file() {
        return Vec::new();
    }
    let r = &s.languages.rust;
    let bin = crate::apply::rust_bin(root, s).map(|(b, _)| b);
    let mut out = cached_cancellable(root, "rust", format!("{}\n{}", r.toolchain, r.stdlib), &files, cancel, || {
        let mut out = Vec::new();
        if let Some(rustc) = tool(bin.clone(), "rustc") {
            let version = query_in_cancellable(&rustc, &["--version"], root, &[], QUERY_TIMEOUT, cancel);
            let library = crate::apply::setting_path(root, &r.stdlib).or_else(|| {
                let sysroot = query_in_cancellable(&rustc, &["--print", "sysroot"], root, &[], QUERY_TIMEOUT, cancel)?;
                Some(PathBuf::from(sysroot).join("lib/rustlib/src/rust/library"))
            });
            let name = match version.as_deref().and_then(|v| v.split_whitespace().nth(1)) {
                Some(v) => format!("Rust {v}"),
                None => "Rust".into(),
            };
            out.extend(library.and_then(|l| group(name, "rust", library_roots(vec![l]))));
        }
        out
    });
    if let Some(cargo) = tool(bin, "cargo") {
        let graph = cached_optional(root, "cargo", r.toolchain.clone(), &files, || {
            let mut args = vec!["metadata", "--format-version", "1", "--offline"];
            if locked {
                args.push("--locked");
            }
            let json = query_in_cancellable(&cargo, &args, root, &[], GRAPH_TIMEOUT, cancel)?;
            let roots = parse_cargo_metadata(&json)?;
            Some(group("Cargo dependencies", "cargo", named_roots(roots)).into_iter().collect())
        });
        out.extend(graph.unwrap_or_else(|| {
            let home = ide_core::process::host_var_os("CARGO_HOME")
                .map(PathBuf::from)
                .or_else(|| Some(crate::home_dir()?.join(".cargo")));
            let roots = home.map(|home| cargo_lock_roots(root, &root.join(home))).unwrap_or_default();
            group("Cargo dependencies", "cargo", named_roots(roots)).into_iter().collect()
        }));
    }
    out
}

/// An incomplete offline graph still has useful downloaded sources recorded in Cargo.lock.
fn cargo_lock_roots(root: &Path, home: &Path) -> Vec<(String, PathBuf)> {
    let lock = std::fs::read_to_string(root.join("Cargo.lock")).ok();
    let Some(lock) = lock.and_then(|s| toml::from_str::<toml::Value>(&s).ok()) else {
        return Vec::new();
    };
    let Some(packages) = lock.get("package").and_then(toml::Value::as_array) else {
        return Vec::new();
    };
    let sources: Vec<PathBuf> =
        std::fs::read_dir(home.join("registry/src")).into_iter().flatten().flatten().map(|e| e.path()).collect();
    packages
        .iter()
        .filter_map(|p| {
            let source = p.get("source")?.as_str()?;
            // Other registries cannot be identified safely from a hashed cache folder alone.
            if source != "registry+https://github.com/rust-lang/crates.io-index" {
                return None;
            }
            let name = p.get("name")?.as_str()?;
            let version = p.get("version")?.as_str()?;
            let path = sources
                .iter()
                .filter(|dir| {
                    dir.file_name().is_some_and(|n| {
                        let n = n.to_string_lossy();
                        n.starts_with("index.crates.io-") || n.starts_with("github.com-")
                    })
                })
                .map(|dir| dir.join(format!("{name}-{version}")))
                .find(|dir| dir.join("Cargo.toml").is_file())?;
            Some((format!("{name} {version}"), path))
        })
        .collect()
}

/// `(name version, source dir)` of the non-workspace packages in `cargo metadata` output, by name.
pub(crate) fn parse_cargo_metadata(json: &str) -> Option<Vec<(String, PathBuf)>> {
    #[derive(Deserialize)]
    struct Package {
        name: String,
        version: String,
        id: Option<String>,
        source: Option<String>,
        manifest_path: PathBuf,
    }
    #[derive(Deserialize)]
    struct Metadata {
        packages: Vec<Package>,
        #[serde(default)]
        workspace_members: Vec<String>,
    }
    let meta = match serde_json::from_str::<Metadata>(json) {
        Ok(meta) => meta,
        Err(error) => {
            tracing::warn!(%error, "cannot parse Cargo metadata for external libraries");
            return None;
        }
    };
    let mut out: Vec<(String, PathBuf)> = meta
        .packages
        .into_iter()
        .filter(|p| p.source.is_some() || p.id.as_ref().is_some_and(|id| !meta.workspace_members.contains(id)))
        .filter_map(|p| Some((format!("{} {}", p.name, p.version), p.manifest_path.parent()?.to_path_buf())))
        .collect();
    out.sort_by_cached_key(|(name, _)| name.to_lowercase());
    Some(out)
}

// ------------------------------------------------------------------ go

fn go_groups(root: &Path, s: &Settings, cancel: &CancellationToken) -> Vec<LibraryGroup> {
    let Some(mut files) = manifests(root, GO_MANIFESTS) else { return Vec::new() };
    if !root.join("go.mod").is_file() && !root.join("go.work").is_file() {
        return Vec::new();
    }
    if let Ok(work) = std::fs::read_to_string(root.join("go.work")) {
        for module in ide_run::go::work_modules(&work) {
            files.extend([root.join(&module).join("go.mod"), root.join(&module).join("go.sum")]);
        }
    }
    files.extend([root.join("go.work.sum"), root.join("vendor/modules.txt")]);
    let g = &s.languages.go;
    cached_cancellable(root, "go", serde_json::to_string(g).unwrap_or_default(), &files, cancel, || {
        let goroot = crate::apply::goroot(root, s);
        let Some(go) = tool(goroot.as_ref().map(|r| r.join("bin")), "go") else { return Vec::new() };
        let goroot_s = goroot.as_ref().map(|p| p.to_string_lossy().into_owned());
        let gopath = crate::apply::setting_path(root, &g.gopath).map(|p| p.to_string_lossy().into_owned());
        // Never download modules or toolchains just to list libraries.
        let module_env = crate::go::module_environment(root, &g.modules);
        let mut env: Vec<(&str, &str)> = module_env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        // Listing libraries must stay offline even when module commands use a proxy.
        env.extend([("GOPROXY", "off"), ("GOTOOLCHAIN", "local")]);
        env.extend(goroot_s.as_deref().map(|v| ("GOROOT", v)));
        env.extend(gopath.as_deref().map(|v| ("GOPATH", v)));
        let mut out = Vec::new();
        if let Some(vars) =
            query_in_cancellable(&go, &["env", "GOROOT", "GOVERSION"], root, &env, QUERY_TIMEOUT, cancel)
        {
            let mut lines = vars.lines().map(str::trim);
            let (dir, version) = (lines.next().unwrap_or_default(), lines.next().unwrap_or_default());
            let name = match version.strip_prefix("go") {
                Some(v) if !v.is_empty() => format!("Go SDK {v}"),
                _ => "Go SDK".into(),
            };
            if !dir.is_empty() {
                out.extend(group(name, "go", library_roots(vec![Path::new(dir).join("src")])));
            }
        }
        let flags = module_env.get("GOFLAGS").map(String::as_str).unwrap_or("");
        let vendor = root.join("vendor");
        let use_vendor = vendor.is_dir()
            && (flags.split_whitespace().any(|f| f == "-mod=vendor")
                || (g.modules.auto_vendor && !flags.split_whitespace().any(|f| f.starts_with("-mod="))));
        if use_vendor {
            if let Ok(text) = std::fs::read_to_string(vendor.join("modules.txt")) {
                let modules = vendor_roots(&vendor, &text);
                out.extend(group("Go Modules", "goModules", named_roots(modules)));
            }
        } else if let Some(text) =
            query_in_cancellable(&go, &["list", "-m", "-e", "-json", "all"], root, &env, GRAPH_TIMEOUT, cancel)
        {
            out.extend(group("Go Modules", "goModules", named_roots(parse_go_modules(&text))));
        }
        out
    })
}

fn vendor_roots(vendor: &Path, text: &str) -> Vec<(String, PathBuf)> {
    let mut seen = std::collections::HashSet::new();
    text.lines()
        .filter_map(|line| {
            let module = line.strip_prefix("# ")?.split_whitespace().next()?;
            if module == "=>" || !seen.insert(module) {
                return None;
            }
            let path = vendor.join(module);
            path.is_dir().then(|| (module.to_string(), path))
        })
        .collect()
}

/// `(path@version, dir)` of the downloaded non-main modules in `go list -m -json` output.
pub(crate) fn parse_go_modules(text: &str) -> Vec<(String, PathBuf)> {
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Module {
        path: String,
        version: Option<String>,
        dir: Option<PathBuf>,
        #[serde(default)]
        main: bool,
    }
    serde_json::Deserializer::from_str(text)
        .into_iter::<Module>()
        .map_while(Result::ok)
        .filter(|m| !m.main)
        .filter_map(|m| {
            let name = match &m.version {
                Some(v) => format!("{}@{v}", m.path),
                None => m.path.clone(),
            };
            Some((name, m.dir?))
        })
        .collect()
}

#[cfg(test)]
mod go_cache_tests {
    use super::*;

    #[test]
    fn library_discovery_includes_declared_workspace_members_beyond_the_search_depth() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("package.json"), r#"{"workspaces":["nested/very/deep/packages/*"]}"#).unwrap();
        std::fs::write(root.join("Cargo.toml"), "[workspace]\nmembers=['nested/very/deep/crates/*']\n").unwrap();
        std::fs::write(root.join("go.work"), "go 1.22\nuse ./nested/very/deep/go\n").unwrap();
        for (dir, marker) in [("packages/web", "package.json"), ("crates/api", "Cargo.toml"), ("go", "go.mod")] {
            let member = root.join("nested/very/deep").join(dir);
            std::fs::create_dir_all(&member).unwrap();
            std::fs::write(member.join(marker), "").unwrap();
        }
        let roots = library_project_roots(root, &CancellationToken::new());
        for member in ["packages/web", "crates/api", "go"] {
            assert!(roots.contains(&root.join("nested/very/deep").join(member)), "{member}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn cancelled_sdk_queries_do_not_poison_the_next_refresh() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("Cargo.toml"), "[package]\nname='app'\nversion='0.1.0'\n").unwrap();
        let bin = root.join("tools");
        std::fs::create_dir(&bin).unwrap();
        let library = root.join("stdlib");
        std::fs::create_dir(&library).unwrap();
        let started = root.join("rustc-started");
        for (name, script) in [
            ("rustc", format!("#!/bin/sh\ntouch '{}'\nexec sleep 60\n", started.display())),
            ("cargo", "#!/bin/sh\nexit 1\n".into()),
        ] {
            let path = bin.join(name);
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut settings = Settings::default();
        settings.languages.rust.toolchain = "tools".into();
        settings.languages.rust.stdlib = "stdlib".into();
        let cancel = CancellationToken::new();
        std::thread::scope(|scope| {
            let task = scope.spawn(|| project_libraries_stream(root, &settings, &[], &cancel, &|_| {}));
            let deadline = Instant::now() + Duration::from_secs(5);
            while !started.is_file() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            cancel.cancel();
            task.join().unwrap();
            assert!(started.is_file());
        });
        std::fs::write(bin.join("rustc"), "#!/bin/sh\necho 'rustc 1.2.3'\n").unwrap();
        let groups = project_libraries(root, &settings, &[]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Rust 1.2.3");
        assert_eq!(groups[0].roots[0].path, library);
    }

    #[test]
    fn libraries_keep_downloaded_crates_when_an_offline_graph_is_incomplete() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        let home = tmp.path().join("cargo");
        std::fs::create_dir_all(&root).unwrap();
        let serde = home.join("registry/src/index.crates.io-test/serde-1.0.200");
        std::fs::create_dir_all(&serde).unwrap();
        std::fs::write(serde.join("Cargo.toml"), "").unwrap();
        std::fs::write(
            root.join("Cargo.lock"),
            r#"
            version = 4
            [[package]]
            name = "serde"
            version = "1.0.200"
            source = "registry+https://github.com/rust-lang/crates.io-index"
            [[package]]
            name = "not-downloaded"
            version = "9.0.0"
            source = "registry+https://github.com/rust-lang/crates.io-index"
        "#,
        )
        .unwrap();
        assert_eq!(cargo_lock_roots(&root, &home), [("serde 1.0.200".into(), serde)]);
    }

    #[cfg(unix)]
    #[test]
    fn failed_cargo_queries_are_retried_without_manifest_changes() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("Cargo.toml"), "[workspace]\nmembers=['members/*']\n").unwrap();
        let member = root.join("members/app");
        std::fs::create_dir_all(&member).unwrap();
        std::fs::write(member.join("Cargo.toml"), "[package]\nname='app'\nversion='0.1.0'\n").unwrap();
        let bin = root.join("tools");
        std::fs::create_dir(&bin).unwrap();
        for name in ["cargo", "rustc"] {
            let path = bin.join(name);
            std::fs::write(&path, "#!/bin/sh\nexit 1\n").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut settings = Settings::default();
        settings.languages.rust.toolchain = "tools".into();
        assert!(project_libraries(root, &settings, &[]).is_empty());
        let source = root.join("local");
        std::fs::create_dir(&source).unwrap();
        let json = serde_json::json!({"packages": [{"id":"dep", "name":"dep", "version":"1.0.0", "source":null,
            "manifest_path":source.join("Cargo.toml")}], "workspace_members":[]});
        let calls = root.join("metadata-calls");
        std::fs::write(bin.join("cargo"), format!("#!/bin/sh\nif [ \"$1\" = locate-project ]; then echo '{}'; exit; fi\necho called >> '{}'\ncat <<'JSON'\n{json}\nJSON\n", root.join("Cargo.toml").display(), calls.display())).unwrap();
        let groups = project_libraries(root, &settings, &[]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].kind, "cargo");
        assert_eq!(groups[0].roots[0].path, source);
        assert_eq!(std::fs::read_to_string(calls).unwrap().lines().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn cargo_metadata_writes_no_lock_file_for_a_crate_outside_the_workspace() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        std::fs::write(root.join("Cargo.toml"), "[workspace]\nmembers=['app']\nexclude=['vendored']\n").unwrap();
        for name in ["app", "vendored"] {
            std::fs::create_dir(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("Cargo.toml"), format!("[package]\nname='{name}'\nversion='0.1.0'\n"))
                .unwrap();
        }
        let bin = root.join("tools");
        std::fs::create_dir(&bin).unwrap();
        let calls = root.join("metadata-calls");
        // Like cargo: an excluded crate is its own workspace.
        let cargo = format!(
            "#!/bin/sh\nif [ \"$1\" = locate-project ]; then case \"$(pwd -P)\" in */vendored) echo \"$(pwd -P)/Cargo.toml\";; *) echo '{}';; esac; exit; fi\necho \"$(pwd -P) $*\" >> '{}'\nexit 1\n",
            root.join("Cargo.toml").display(),
            calls.display()
        );
        for (name, script) in [("cargo", cargo.as_str()), ("rustc", "#!/bin/sh\nexit 1\n")] {
            std::fs::write(bin.join(name), script).unwrap();
            std::fs::set_permissions(bin.join(name), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut settings = Settings::default();
        settings.languages.rust.toolchain = "tools".into();
        let metadata = |dir: &Path| {
            let prefix = format!("{} metadata ", dir.display());
            let calls = std::fs::read_to_string(&calls).unwrap();
            calls.lines().rev().find_map(|l| l.strip_prefix(&prefix).map(str::to_owned))
        };

        project_libraries(&root, &settings, &[]);
        // The project's own workspace resolves as before, writing its Cargo.lock if it has none.
        assert_eq!(metadata(&root).as_deref(), Some("--format-version 1 --offline"));
        assert_eq!(metadata(&root.join("vendored")).as_deref(), Some("--format-version 1 --offline --locked"));

        // A crate with its own Cargo.lock keeps resolving with it.
        std::fs::write(root.join("vendored/Cargo.lock"), "version = 4\n").unwrap();
        project_libraries(&root, &settings, &[]);
        assert_eq!(metadata(&root.join("vendored")).as_deref(), Some("--format-version 1 --offline"));
    }

    #[cfg(unix)]
    #[test]
    fn libraries_publish_node_and_maven_while_cargo_is_running_and_cancel_it() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::mpsc;
        use std::time::Instant;

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("Cargo.toml"), "[package]\nname='app'\nversion='0.1.0'\n").unwrap();
        std::fs::write(root.join("package.json"), r#"{"dependencies":{"dep":"1"}}"#).unwrap();
        std::fs::create_dir_all(root.join("node_modules/dep")).unwrap();
        let bin = root.join("tools");
        std::fs::create_dir(&bin).unwrap();
        let started = root.join("cargo-started");
        for (name, script) in [
            ("rustc", "#!/bin/sh\nexit 1\n".to_owned()),
            (
                "cargo",
                format!(
                    "#!/bin/sh\nif [ \"$1\" = locate-project ]; then echo '{}'; exit; fi\ntouch '{}'\nexec sleep 60\n",
                    root.join("Cargo.toml").display(),
                    started.display()
                ),
            ),
        ] {
            let path = bin.join(name);
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut settings = Settings::default();
        settings.languages.rust.toolchain = "tools".into();
        settings.languages.java.maven.local_repository = root.join("m2").to_string_lossy().into_owned();
        let jar = root.join("m2/g/a/1/a-1.jar");
        std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
        std::fs::write(jar, "").unwrap();
        let deps = [BuildDependency { gradle: false, group: "g".into(), artifact: "a".into(), version: "1".into() }];
        let cancel = CancellationToken::new();
        let (tx, rx) = mpsc::channel();
        std::thread::scope(|scope| {
            let task = scope.spawn(|| {
                project_libraries_stream(root, &settings, &deps, &cancel, &|g| {
                    tx.send(g).unwrap();
                })
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut kinds = Vec::new();
            while Instant::now() < deadline
                && !(kinds.contains(&"nodeModules".to_owned())
                    && kinds.contains(&"maven".to_owned())
                    && started.is_file())
            {
                if let Ok(groups) = rx.recv_timeout(Duration::from_millis(20)) {
                    kinds.extend(groups.into_iter().map(|g| g.kind));
                }
            }
            cancel.cancel();
            task.join().unwrap();
            assert!(started.is_file(), "cargo query should have started");
            assert!(kinds.contains(&"nodeModules".to_owned()));
            assert!(kinds.contains(&"maven".to_owned()));
            assert!(Instant::now() < deadline, "cancellation should stop the graph query promptly");
        });
    }

    #[test]
    fn finds_published_version_catalogs_in_the_gradle_cache_and_maven_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut s = Settings::default();
        s.languages.java.gradle.user_home = root.join("gradle").to_string_lossy().into_owned();
        s.languages.java.maven.local_repository = root.join("m2").to_string_lossy().into_owned();
        let cached = root.join("gradle/caches/modules-2/files-2.1/com.acme/catalog/1.2/abc123/catalog-1.2.toml");
        std::fs::create_dir_all(cached.parent().unwrap()).unwrap();
        std::fs::write(&cached, "[libraries]").unwrap();
        assert_eq!(published_version_catalog(root, &s, "com.acme:catalog:1.2"), Some(cached));
        let local = root.join("m2/com/acme/other/2.0/other-2.0.toml");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::write(&local, "[libraries]").unwrap();
        assert_eq!(published_version_catalog(root, &s, " com.acme:other:2.0 "), Some(local));
        for missing in ["com.acme:catalog:9", "com.acme:catalog", "a:b:c:d", "../x:y:z"] {
            assert_eq!(published_version_catalog(root, &s, missing), None, "{missing}");
        }
    }

    #[test]
    fn dependency_jars_come_from_the_configured_gradle_home() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut s = Settings::default();
        s.languages.java.gradle.user_home = root.join("gradle").to_string_lossy().into_owned();
        // Only in the home Gradle runs with, not in `$GRADLE_USER_HOME` / `~/.gradle`.
        let jar = root.join("gradle/caches/modules-2/files-2.1/com.acme/lib/1.0/abc123/lib-1.0.jar");
        std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
        std::fs::write(&jar, b"jar").unwrap();

        let deps =
            [BuildDependency { gradle: true, group: "com.acme".into(), artifact: "lib".into(), version: "1.0".into() }];
        let groups = dependency_groups(root, &s, &deps);
        assert_eq!(groups.len(), 1, "{groups:?}");
        assert_eq!(groups[0].name, "Gradle: com.acme:lib:1.0");
        assert_eq!(groups[0].roots[0].name, "lib-1.0.jar");
    }
    #[test]
    fn vendor_roots_include_local_replacements_once() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("example.com/local")).unwrap();
        let text = "# example.com/local v0.0.0 => ../local\n## explicit; go 1.22\nexample.com/local\n# example.com/local => ../local\n";
        assert_eq!(
            vendor_roots(dir.path(), text),
            vec![("example.com/local".into(), dir.path().join("example.com/local"))]
        );
    }

    #[test]
    fn go_commands_invalidate_the_graph_even_when_manifests_are_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let count = std::cell::Cell::new(0);
        let detect = || {
            count.set(count.get() + 1);
            Vec::new()
        };
        cached(dir.path(), "go", "same".into(), &[], detect);
        cached(dir.path(), "go", "same".into(), &[], detect);
        assert_eq!(count.get(), 1);
        invalidate_go(dir.path());
        cached(dir.path(), "go", "same".into(), &[], detect);
        assert_eq!(count.get(), 2);
    }

    #[test]
    fn classpath_entries_resolve_lib_paths_against_the_module() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("guava.jar"), "").unwrap();
        std::fs::create_dir_all(root.join("classes")).unwrap();
        std::fs::create_dir_all(root.join("lib")).unwrap();
        std::fs::write(root.join("lib/servlet.jar"), "").unwrap();
        let text = r#"<?xml version="1.0" encoding="UTF-8"?>
<classpath>
    <classpathentry kind="src" path="src"/>
    <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
    <classpathentry kind="lib" path="guava.jar" sourcepath="sources.zip"/>
    <classpathentry kind="lib" path="classes"/>
    <classpathentry kind="lib" path="/lib/servlet.jar"/>
    <classpathentry kind="lib" path="missing.jar"/>
    <classpathentry kind="output" path="bin"/>
</classpath>"#;
        std::fs::write(root.join("sources.zip"), "").unwrap();
        assert_eq!(
            classpath_entries(root, text),
            vec![root.join("sources.zip"), root.join("classes"), root.join("lib/servlet.jar")]
        );
    }

    #[test]
    fn classpath_groups_lists_jars_per_module() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join(".classpath"), r#"<classpath><classpathentry kind="lib" path="a.jar"/></classpath>"#)
            .unwrap();
        std::fs::write(root.join("a.jar"), "").unwrap();
        let module = root.join("module-b");
        std::fs::create_dir_all(&module).unwrap();
        std::fs::write(
            module.join(".classpath"),
            r#"<classpath><classpathentry kind="lib" path="../shared.jar"/></classpath>"#,
        )
        .unwrap();
        std::fs::write(root.join("shared.jar"), "").unwrap();
        let groups = classpath_groups(&[root.to_path_buf(), module]);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].kind, "classpath");
        assert_eq!(groups[0].roots.len(), 1);
        assert!(groups[0].roots[0].path.to_string_lossy().ends_with("a.jar!"));
        assert_eq!(groups[1].roots.len(), 1);
    }
}

#[cfg(test)]
mod idea_project_tests {
    use super::*;

    #[test]
    fn an_idea_folder_marks_a_java_project_only_when_it_declares_java() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(!idea_java_project(root));
        // GoLand / PyCharm write `.idea` without any Java in it.
        std::fs::create_dir_all(root.join(".idea")).unwrap();
        std::fs::write(root.join(".idea/misc.xml"), r#"<project version="4"><component name="GOROOT" /></project>"#)
            .unwrap();
        std::fs::write(root.join(".idea/demo.iml"), r#"<module type="WEB_MODULE" version="4" />"#).unwrap();
        assert!(!idea_java_project(root));
        // A Java module file, at the root or in `.idea`.
        std::fs::write(root.join("app.iml"), r#"<module type="JAVA_MODULE" version="4" />"#).unwrap();
        assert!(idea_java_project(root));
        std::fs::remove_file(root.join("app.iml")).unwrap();
        // The project JDK in misc.xml.
        std::fs::write(
            root.join(".idea/misc.xml"),
            r#"<project version="4"><component name="ProjectRootManager" languageLevel="JDK_17" project-jdk-name="17" project-jdk-type="JavaSDK" /></project>"#,
        )
        .unwrap();
        assert!(idea_java_project(root));
    }
}
