//! "External Libraries" of a project (IDEA's library / SDK roots in the
//! Project view): the folders holding the sources of the project's SDKs and
//! dependencies — the Python interpreter's standard library and site-packages,
//! the JDK, `node_modules` packages, Cargo crates and the Rust standard
//! library, GOROOT and the Go module cache.
//!
//! Each ecosystem is detected only when the project has its manifest, and its
//! result is cached until the manifests (or the relevant settings) change.
//!
//! Archives are listed as browsable roots (`<archive>!`, see `ide_vfs`): the
//! JDK's `src.zip` and the Maven / Gradle dependency jars (sources jars preferred).

use crate::exe;
use crate::exec::{query, query_in, which};
use ide_core::settings::Settings;
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
    /// `python` | `jdk` | `nodeModules` | `nodeCore` | `rust` | `cargo` | `go` | `goModules` | `maven` | `gradle`.
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
const NODE_MANIFESTS: &[&str] = &["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];
const CARGO_MANIFESTS: &[&str] = &["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"];
const GO_MANIFESTS: &[&str] = &["go.mod", "go.sum", "go.work"];

/// A Maven / Gradle dependency of the project, from the build model.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BuildDependency {
    /// Resolved by Gradle (else Maven): looked up in the Gradle cache first.
    pub gradle: bool,
    pub group: String,
    pub artifact: String,
    pub version: String,
}

/// The project's library groups; empty when no SDK is configured. Runs the
/// toolchains (in parallel), so call it off the UI / command thread.
/// `dependencies` (from the build model) are listed when their jars are in the local repositories.
pub fn project_libraries(root: &Path, settings: &Settings, dependencies: &[BuildDependency]) -> Vec<LibraryGroup> {
    type Detect = fn(&Path, &Settings) -> Vec<LibraryGroup>;
    let detectors: [Detect; 5] = [python_groups, jdk_groups, node_groups, rust_groups, go_groups];
    std::thread::scope(|s| {
        let handles: Vec<_> = detectors.iter().map(|d| s.spawn(move || d(root, settings))).collect();
        let deps = s.spawn(|| dependency_groups(root, settings, dependencies));
        handles.into_iter().chain([deps]).flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

// ------------------------------------------------------------------ cache

/// Size and modification time of each manifest (`None`: missing).
type Stamp = Vec<(PathBuf, Option<(SystemTime, u64)>)>;

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

fn stamp(files: &[PathBuf]) -> Stamp {
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
    let id = (root.to_path_buf(), ecosystem);
    let now = stamp(manifests);
    if let Some(c) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&id)
        && c.key == key
        && c.stamp == now
    {
        return c.groups.clone();
    }
    let groups = detect();
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Cached { key, stamp: now, groups: groups.clone() });
    groups
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

fn python_groups(root: &Path, s: &Settings) -> Vec<LibraryGroup> {
    let Some(python) = crate::apply::python_interpreter(root, s) else { return Vec::new() };
    let mut files = vec![python.clone()];
    files.extend(crate::venv_of(&python).map(|v| v.join("pyvenv.cfg")));
    cached(root, "python", python.display().to_string(), &files, || {
        python_libraries(&python, Some(root)).into_iter().collect()
    })
}

/// Standard library and site-packages folders of a Python interpreter.
pub fn python_libraries(python: &Path, root: Option<&Path>) -> Option<LibraryGroup> {
    let out = query(python, &["-c", PYTHON_PATHS], QUERY_TIMEOUT)?;
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

// ------------------------------------------------------------------ jdk

fn jdk_groups(root: &Path, s: &Settings) -> Vec<LibraryGroup> {
    let Some(files) = manifests(root, JAVA_MANIFESTS) else { return Vec::new() };
    cached(root, "jdk", s.languages.java.jdk.clone(), &files, || {
        let jdk = crate::apply::project_jdk(root, s).or_else(|| {
            crate::java::pick_jdk(&crate::java::installed_jdks(), crate::java::project_java_version(root)).cloned()
        });
        jdk.and_then(|j| jdk_library(&j)).into_iter().collect()
    })
}

/// The JDK home and its sources (`lib/src.zip`, `src.zip` in JDK 8) as library roots.
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

fn dependency_groups(root: &Path, s: &Settings, deps: &[BuildDependency]) -> Vec<LibraryGroup> {
    if deps.is_empty() {
        return Vec::new();
    }
    let maven_repo = crate::apply::maven_local_repository(root, s).or_else(default_maven_repository);
    let gradle_home = gradle_user_home();
    let files: Vec<PathBuf> = JAVA_MANIFESTS.iter().map(|n| root.join(n)).collect();
    let key = format!("{maven_repo:?}\n{gradle_home:?}\n{deps:?}");
    cached(root, "buildDependencies", key, &files, || {
        dependency_libraries(deps, maven_repo.as_deref(), gradle_home.as_deref())
    })
}

/// `~/.m2/repository` (Settings › Maven › Local repository overrides it).
fn default_maven_repository() -> Option<PathBuf> {
    Some(crate::home_dir()?.join(".m2/repository"))
}

/// `$GRADLE_USER_HOME`, else `~/.gradle`.
fn gradle_user_home() -> Option<PathBuf> {
    std::env::var_os("GRADLE_USER_HOME").map(PathBuf::from).or_else(|| Some(crate::home_dir()?.join(".gradle")))
}

/// One `Maven: g:a:v` / `Gradle: g:a:v` group per dependency whose jar is in a
/// local repository, its root being the jar (the `-sources.jar` when downloaded).
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
    ["-sources.jar", ".jar"]
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
    ["-sources.jar", ".jar"].iter().find_map(|suffix| {
        let file = format!("{}-{}{suffix}", d.artifact, d.version);
        hashes.iter().map(|h| h.join(&file)).find(|p| p.is_file())
    })
}

// ------------------------------------------------------------------ node

fn node_groups(root: &Path, s: &Settings) -> Vec<LibraryGroup> {
    let Some(files) = manifests(root, NODE_MANIFESTS) else { return Vec::new() };
    if !root.join("package.json").is_file() {
        return Vec::new();
    }
    cached(root, "node", s.languages.node.interpreter.clone(), &files, || {
        let node = tool(crate::apply::node_dir(root, s), "node");
        node_libraries(root, node.as_deref())
    })
}

/// `node_modules/<dep>` of the direct dependencies in `package.json`, and the
/// Node.js core typings (`@types/node`, from the project or the runtime's global `lib`).
pub(crate) fn node_libraries(root: &Path, node: Option<&Path>) -> Vec<LibraryGroup> {
    let manifest = std::fs::read_to_string(root.join("package.json")).unwrap_or_default();
    let modules = root.join("node_modules");
    let deps = named_roots(package_dependencies(&manifest).into_iter().map(|d| (d.clone(), modules.join(d))).collect());
    let mut core = vec![modules.join("@types/node")];
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
    let Ok(json) = serde_json::from_str::<serde_json::Value>(package_json) else { return Vec::new() };
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

fn rust_groups(root: &Path, s: &Settings) -> Vec<LibraryGroup> {
    let Some(files) = manifests(root, CARGO_MANIFESTS) else { return Vec::new() };
    if !root.join("Cargo.toml").is_file() {
        return Vec::new();
    }
    let r = &s.languages.rust;
    cached(root, "rust", format!("{}\n{}", r.toolchain, r.stdlib), &files, || {
        let bin = crate::apply::rust_bin(root, s).map(|(b, _)| b);
        let mut out = Vec::new();
        if let Some(rustc) = tool(bin.clone(), "rustc") {
            let version = query_in(&rustc, &["--version"], Some(root), &[], QUERY_TIMEOUT);
            let library = crate::apply::setting_path(root, &r.stdlib).or_else(|| {
                let sysroot = query_in(&rustc, &["--print", "sysroot"], Some(root), &[], QUERY_TIMEOUT)?;
                Some(PathBuf::from(sysroot).join("lib/rustlib/src/rust/library"))
            });
            let name = match version.as_deref().and_then(|v| v.split_whitespace().nth(1)) {
                Some(v) => format!("Rust {v}"),
                None => "Rust".into(),
            };
            out.extend(library.and_then(|l| group(name, "rust", library_roots(vec![l]))));
        }
        if let Some(cargo) = tool(bin, "cargo")
            && let Some(json) =
                query_in(&cargo, &["metadata", "--format-version", "1", "--offline"], Some(root), &[], GRAPH_TIMEOUT)
        {
            out.extend(group("Cargo dependencies", "cargo", named_roots(parse_cargo_metadata(&json))));
        }
        out
    })
}

/// `(name version, source dir)` of the non-workspace packages in `cargo metadata` output, by name.
pub(crate) fn parse_cargo_metadata(json: &str) -> Vec<(String, PathBuf)> {
    #[derive(Deserialize)]
    struct Package {
        name: String,
        version: String,
        source: Option<String>,
        manifest_path: PathBuf,
    }
    #[derive(Deserialize)]
    struct Metadata {
        packages: Vec<Package>,
    }
    let Ok(meta) = serde_json::from_str::<Metadata>(json) else { return Vec::new() };
    let mut out: Vec<(String, PathBuf)> = meta
        .packages
        .into_iter()
        .filter(|p| p.source.is_some())
        .filter_map(|p| Some((format!("{} {}", p.name, p.version), p.manifest_path.parent()?.to_path_buf())))
        .collect();
    out.sort_by_cached_key(|(name, _)| name.to_lowercase());
    out
}

// ------------------------------------------------------------------ go

fn go_groups(root: &Path, s: &Settings) -> Vec<LibraryGroup> {
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
    cached(root, "go", serde_json::to_string(g).unwrap_or_default(), &files, || {
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
        if let Some(vars) = query_in(&go, &["env", "GOROOT", "GOVERSION"], Some(root), &env, QUERY_TIMEOUT) {
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
        } else if let Some(text) = query_in(&go, &["list", "-m", "-e", "-json", "all"], Some(root), &env, GRAPH_TIMEOUT)
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
}
