//! Single-file Java compilation with `javac` for the Recompile action (#2476).
//!
//! A module build (`-pl … -am`) still walks every upstream module, and packaging
//! walks the whole reactor; compiling one file only needs that file's module
//! outputs plus its dependency classpath, which is much faster to assemble.
use super::*;
use serde::{Deserialize, Serialize};
use std::fs;

/// Output file of the `dependency:build-classpath` probe, relative to each module.
const CP_FILE: &str = "target/ide-compile-cp.txt";
// Older records include undeclared reactor test outputs even in runtime classpaths.
const CLASSPATH_CACHE_VERSION: u32 = 1;
const GRADLE_COMPILE_CP_INIT_SCRIPT: &str = include_str!("../gradle-compile-cp.init.gradle");

pub(super) fn is_java_file(file: &Path) -> IdeResult<String> {
    if file.extension().is_none_or(|ext| !ext.eq_ignore_ascii_case("java")) {
        return Err(IdeError::invalid("only Java sources can be compiled as a single file"));
    }
    if !file.is_file() {
        return Err(IdeError::not_found("no Java source found for single-file compilation"));
    }
    Ok(file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

pub(super) fn is_test_source(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split(['/', '\\']).collect();
    parts.windows(2).any(|w| w == ["src", "test"])
}

pub(super) fn java_home_major(env: &BTreeMap<String, String>) -> Option<u32> {
    let home = env.get("JAVA_HOME").filter(|h| !h.trim().is_empty())?;
    let release = fs::read_to_string(Path::new(home).join("release")).ok()?;
    let value = release.lines().find_map(|l| l.trim().strip_prefix("JAVA_VERSION="))?;
    let value = value.trim().trim_matches(['"', '\'']);
    language_release(value)
}

/// `--release N` from JDK 9 on; older compilers only know `-source` / `-target`.
pub(super) fn release_args(level: Option<u32>, jdk_major: Option<u32>) -> Vec<String> {
    let Some(level) = level else { return Vec::new() };
    if jdk_major.is_none_or(|m| m >= 9) {
        vec!["--release".into(), level.to_string()]
    } else {
        vec!["-source".into(), format!("1.{level}"), "-target".into(), format!("1.{level}")]
    }
}

pub(super) fn join_classpath(entries: impl IntoIterator<Item = String>) -> String {
    let separator = if cfg!(windows) { ";" } else { ":" };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in entries {
        if !entry.is_empty() && seen.insert(entry.clone()) {
            out.push(entry);
        }
    }
    out.join(separator)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_javac_step(
    javac: &str,
    cwd: &Path,
    out_dir: &Path,
    classpath: &str,
    sources: &[PathBuf],
    release: Vec<String>,
    file: &Path,
    env: BTreeMap<String, String>,
) -> IdeResult<BuildStep> {
    fs::create_dir_all(out_dir)
        .map_err(|e| IdeError::internal(format!("cannot create {} ({e})", out_dir.display())))?;
    // Raw `javac` prints `path:line: error: …`, the same form Gradle forwards.
    let mut step = BuildStep::new(javac, &[], cwd, Format::Gradle);
    step.args.extend(["-encoding".into(), "UTF-8".into(), "-g".into()]);
    step.args.extend(["-d".into(), out_dir.to_string_lossy().into_owned()]);
    if !classpath.is_empty() {
        step.args.extend(["-cp".into(), classpath.to_owned()]);
    }
    // Classes of the module that were never built (or are older than their source) are read
    // from its sources; only `file` is written, so a test compile never puts main classes
    // into test-classes.
    if !sources.is_empty() {
        let separator = if cfg!(windows) { ";" } else { ":" };
        step.args.push("-sourcepath".into());
        step.args.push(sources.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>().join(separator));
        step.args.push("-implicit:none".into());
    }
    step.args.extend(release);
    step.args.push(file.to_string_lossy().into_owned());
    step.env = env;
    step.mkdirs = vec![out_dir.to_path_buf()];
    Ok(step)
}

/// The resolved dependency classpath for one module and scope, tied to the same
/// inputs as its launch build so POM, JDK, settings and profile changes invalidate it.
#[derive(Debug, Deserialize, Serialize)]
struct CachedClasspath {
    version: u32,
    fingerprint: LaunchFingerprint,
    classpath: String,
}

/// A `.java` source and the module build that compiles it.
pub struct SingleFileTarget {
    /// Absolute module directory.
    pub module: PathBuf,
    /// The source is under `src/test`: compile to test classes with the test classpath.
    pub test: bool,
    /// Absolute `target/classes` (or `target/test-classes`).
    pub out_dir: PathBuf,
    /// Reactor root building the module (owns the Maven command and options).
    pub top: maven::MavenProject,
    /// `-pl` value of the module relative to the reactor root; empty when the
    /// module is the root itself.
    pub pl: String,
    /// `maven.compiler.release` (or equivalent) of the module's project.
    pub java_version: Option<u32>,
}

/// Locates the linked Maven module owning a `.java` source file.
pub fn single_file_target(root: &Path, model: &BuildModel, file: &Path) -> IdeResult<SingleFileTarget> {
    is_java_file(file)?;
    let Some(m) = &model.maven else {
        return Err(IdeError::not_found("no linked Maven project found for module"));
    };
    // The innermost project whose directory contains the file owns it; the
    // aggregator root (`""`) is a prefix of everything, so take the longest match.
    let rel = rel_str(root, file);
    let project = m
        .projects
        .iter()
        .filter(|p| rel == p.dir || rel.starts_with(&format!("{}/", p.dir)) || p.dir.is_empty())
        .max_by_key(|p| p.dir.len())
        .ok_or_else(|| IdeError::not_found("no linked Maven project found for module"))?;
    if project.packaging == "pom" {
        // An aggregator owns no sources itself: a file that only matches it
        // belongs to no linked module.
        return Err(IdeError::not_found("no linked Maven project found for module"));
    }
    let module = subdir(root, &project.dir);
    let top = maven_reactor(m, &project.dir)
        .ok_or_else(|| IdeError::not_found("no linked Maven project found for module"))?;
    let top_dir = subdir(root, &top.dir);
    let pl = module.strip_prefix(&top_dir).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    // Test sources see the test classpath and compile into test classes.
    let test = is_test_source(&rel);
    let out_dir = module.join("target").join(if test { "test-classes" } else { "classes" });
    Ok(SingleFileTarget { module, test, out_dir, top: top.clone(), pl, java_version: project.java_version })
}

/// The Maven reactor target for a launch module whose source file is not known yet.
fn module_target(root: &Path, model: &BuildModel, module: &Path, test: bool) -> IdeResult<SingleFileTarget> {
    let Some(m) = &model.maven else {
        return Err(IdeError::not_found("no linked Maven project found for module"));
    };
    let module = if module.is_absolute() { module.to_path_buf() } else { root.join(module) };
    let project = m
        .projects
        .iter()
        .find(|p| root.join(&p.dir) == module)
        .ok_or_else(|| IdeError::not_found("no linked Maven project found for module"))?;
    if project.packaging == "pom" {
        return Err(IdeError::not_found("the launch module is a Maven aggregator without sources"));
    }
    let top = maven_reactor(m, &project.dir)
        .ok_or_else(|| IdeError::not_found("no linked Maven reactor found for module"))?;
    let top_dir = subdir(root, &top.dir);
    let pl = module.strip_prefix(&top_dir).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let out_dir = module.join("target").join(if test { "test-classes" } else { "classes" });
    Ok(SingleFileTarget { module, test, out_dir, top: top.clone(), pl, java_version: project.java_version })
}

/// `javac` for the module: its `JAVA_HOME`, else `PATH`.
pub fn find_javac(env: &BTreeMap<String, String>) -> String {
    let home = env.get("JAVA_HOME").map(Path::new);
    let exe = if cfg!(windows) { "javac.exe" } else { "javac" };
    if let Some(javac) = home.map(|h| h.join("bin").join(exe)).filter(|p| p.is_file()) {
        return javac.to_string_lossy().into_owned();
    }
    exe.to_owned()
}

/// Dependency classpath of the module: existing reactor class directories plus
/// `mvn dependency:build-classpath` (which resolves without compiling anything,
/// so `-am` stays cheap). Entries are platform-separated (`;` on Windows).
pub fn single_file_classpath(root: &Path, model: &BuildModel, target: &SingleFileTarget) -> IdeResult<String> {
    single_file_classpath_cancellable(root, model, target, &CancellationToken::new())
}

fn single_file_classpath_cancellable(
    root: &Path,
    model: &BuildModel,
    target: &SingleFileTarget,
    cancel: &CancellationToken,
) -> IdeResult<String> {
    let scope = if target.test { "test" } else { "compile" };
    classpath(root, model, target, scope, false, cancel)
}

/// Runtime (or test) dependency classpath for a launch module.
///
/// The Java language server runs on its own JDK, so its Maven model can select a
/// different JDK profile and dependency classifier than the project launch. Use the
/// same Maven process that builds the module instead.
pub fn module_classpath(
    root: &Path,
    model: &BuildModel,
    module: &Path,
    test: bool,
    local_repo: Option<PathBuf>,
    cache: &Path,
    cancel: &ide_core::CancellationToken,
) -> IdeResult<String> {
    module_classpaths(root, model, &[module.to_path_buf()], test, local_repo, cache, cancel)
}

/// [`module_classpath`] of `modules[0]`. The other modules, launched together with it
/// (#3971), share its Maven probe when they have no cached classpath, which leaves
/// theirs cached for their own launches.
pub fn module_classpaths(
    root: &Path,
    model: &BuildModel,
    modules: &[PathBuf],
    test: bool,
    local_repo: Option<PathBuf>,
    cache: &Path,
    cancel: &ide_core::CancellationToken,
) -> IdeResult<String> {
    let mut probes: Vec<Probe> = Vec::new();
    for (i, module) in modules.iter().enumerate() {
        let target = match module_target(root, model, module, test) {
            Ok(target) => target,
            Err(e) if i == 0 => return Err(e),
            Err(_) => continue,
        };
        if i > 0 && (target.top.dir != probes[0].0.top.dir || probes.iter().any(|p| p.0.module == target.module)) {
            continue;
        }
        let fingerprint = launch_fingerprint(root, model, &target.module, test, local_repo.clone(), cancel)?;
        let cache_path = classpath_cache_path(root, cache, &target.module, test);
        if let (Some(fingerprint), Some(path)) = (&fingerprint, &cache_path)
            && let Ok(bytes) = fs::read(path)
            && let Ok(cached) = serde_json::from_slice::<CachedClasspath>(&bytes)
            && cached.version == CLASSPATH_CACHE_VERSION
            && cached.fingerprint == *fingerprint
            && classpath_entries_exist(root, &cached.classpath)
        {
            if i == 0 {
                return Ok(cached.classpath);
            }
            continue;
        }
        probes.push(Probe(target, fingerprint, cache_path));
    }
    let scope = if test { "test" } else { "runtime" };
    let targets: Vec<&SingleFileTarget> = probes.iter().map(|p| &p.0).collect();
    let classpaths = match classpaths(root, model, &targets, scope, true, cancel) {
        Ok(classpaths) => classpaths,
        // Another module's failure must not cost this launch its own probe.
        Err(_) if targets.len() > 1 && !cancel.is_cancelled() => {
            classpaths(root, model, &targets[..1], scope, true, cancel)?
        }
        Err(e) => return Err(e),
    };
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    for (Probe(_, fingerprint, cache_path), classpath) in probes.into_iter().zip(&classpaths) {
        if let (Some(fingerprint), Some(path)) = (fingerprint, cache_path) {
            let cached =
                CachedClasspath { version: CLASSPATH_CACHE_VERSION, fingerprint, classpath: classpath.clone() };
            if let Err(error) = cache_classpath(&path, &cached) {
                tracing::debug!(path = %path.display(), %error, "Cannot cache the Java launch classpath");
            }
        }
    }
    Ok(classpaths.into_iter().next().unwrap())
}

/// A module whose classpath the Maven probe resolves, with its cache key and file.
struct Probe(SingleFileTarget, Option<LaunchFingerprint>, Option<PathBuf>);

/// One cache file per module and scope. Mirroring the module path keeps nested
/// modules and their different dependency scopes from overwriting each other.
fn classpath_cache_path(root: &Path, cache: &Path, module: &Path, test: bool) -> Option<PathBuf> {
    let relative = module.strip_prefix(root).ok()?;
    let mut path = cache.join("java-launch/classpaths");
    path.push(if relative.as_os_str().is_empty() { Path::new("_root") } else { relative });
    path.push(if test { "test.json" } else { "runtime.json" });
    Some(path)
}

/// Best-effort cache persistence. A failed write only costs one later Maven
/// probe, so the launch still succeeds even when the cache directory is unusable.
fn cache_classpath(path: &Path, cached: &CachedClasspath) -> IdeResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec(cached).map_err(|e| IdeError::internal(e.to_string()))?)?;
    Ok(())
}

/// A cache entry stays valid while every file exists. Maven also emits reactor
/// output directories for modules with no classes, which may legitimately never be
/// created; the launch snapshot already supplies the module's classes in that case.
fn classpath_entries_exist(root: &Path, classpath: &str) -> bool {
    // Temp directories on macOS are commonly reached through `/var`, while Maven
    // reports the canonical `/private/var` path. Compare against both spellings.
    let canonical_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    std::env::split_paths(classpath).all(|entry| {
        entry.exists()
            || ((entry.starts_with(root) || entry.starts_with(&canonical_root))
                && (entry.ends_with(Path::new("target/classes")) || entry.ends_with(Path::new("target/test-classes"))))
    })
}

fn classpath(
    root: &Path,
    model: &BuildModel,
    target: &SingleFileTarget,
    scope: &str,
    compile_first: bool,
    cancel: &CancellationToken,
) -> IdeResult<String> {
    Ok(classpaths(root, model, &[target], scope, compile_first, cancel)?.pop().unwrap())
}

/// The classpath of each of `targets` (modules of one reactor) from one Maven probe.
fn classpaths(
    root: &Path,
    model: &BuildModel,
    targets: &[&SingleFileTarget],
    scope: &str,
    compile_first: bool,
    cancel: &CancellationToken,
) -> IdeResult<Vec<String>> {
    let top = &targets[0].top;
    let probe = CP_FILE;
    let mut args = vec!["-B", "-Dstyle.color=never", maven::LOCAL_REPO_TRACKING_ARG];
    args.extend(top.options.iter().map(String::as_str));
    // The reactor root among them builds every module.
    let selection = if targets.iter().any(|t| t.pl.is_empty()) {
        String::new()
    } else {
        let mut pl: Vec<&str> = targets.iter().map(|t| t.pl.as_str()).collect();
        pl.sort();
        pl.dedup();
        pl.join(",")
    };
    if !selection.is_empty() {
        args.extend(["-pl", selection.as_str(), "-am"]);
    }
    let output_arg = format!("-Dmdep.outputFile={probe}");
    let scope_arg = format!("-Dmdep.includeScope={scope}");
    // A launch build may only have reached `compile`. Running `compile` in this
    // same Maven session lets the dependency plugin resolve Reactor siblings from
    // their target/classes without paying for package-phase plugins.
    if compile_first {
        args.push("compile");
    }
    let build_classpath =
        maven::plugin_goal("dependency:build-classpath", maven::local_repository_for(&top.options).as_deref());
    args.extend([build_classpath.as_str(), output_arg.as_str(), scope_arg.as_str(), "-q"]);
    let top_dir = subdir(root, &top.dir);
    let owned_args: Vec<String> = args.into_iter().map(str::to_owned).collect();
    let out = process::run_bounded(&top.command, &owned_args, &top_dir, &top.env, cancel, |_, _| {}).map_err(|e| {
        if e.kind == ide_core::error::ErrorKind::Cancelled {
            e
        } else {
            IdeError::internal(format!("cannot resolve the compile classpath: {}", e.message))
        }
    })?;
    if !out.success {
        // Maven reports reactor/dependency failures on stdout, not only stderr.
        let tail: Vec<&str> = out.text.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail.iter().rev().take(5).rev().cloned().collect::<Vec<_>>().join("\n");
        return Err(IdeError::internal(format!("cannot resolve the compile classpath:\n{tail}")));
    }
    targets.iter().map(|target| target_classpath(root, model, target)).collect()
}

/// The classpath of `target` after a probe: its reactor class directories, then
/// the dependencies Maven wrote to the module's probe file.
fn target_classpath(root: &Path, model: &BuildModel, target: &SingleFileTarget) -> IdeResult<String> {
    let mut entries: Vec<String> = Vec::new();
    // The module's own classes first: the file almost always uses classes next to it.
    let own: &[&str] = if target.test { &["target/test-classes", "target/classes"] } else { &["target/classes"] };
    for out in own {
        let path = target.module.join(out);
        if path.is_dir() {
            entries.push(path.to_string_lossy().into_owned());
        }
    }
    if let Some(m) = &model.maven {
        // Upstream reactor modules first: their freshly built classes shadow
        // installed snapshots of the same artifacts.
        for project in maven_launch_projects(root, m, &target.module, target.test) {
            let dir = subdir(root, &project.dir);
            if dir == target.module {
                continue;
            }
            // A dependency's tests are not exported with its main artifact. Any explicitly
            // declared test artifact is supplied by Maven's resolved classpath below.
            let path = dir.join("target/classes");
            if path.is_dir() {
                entries.push(path.to_string_lossy().into_owned());
            }
        }
    }
    // With `-am` every visited module writes its own file; only this module's counts.
    let cp_file = target.module.join(CP_FILE);
    let content = fs::read_to_string(&cp_file).map_err(|e| {
        IdeError::internal(format!("cannot resolve the compile classpath: {} ({e})", cp_file.display()))
    })?;
    let separator = if cfg!(windows) { ';' } else { ':' };
    entries.extend(content.split([separator, '\n', '\r']).map(str::trim).filter(|e| !e.is_empty()).map(str::to_owned));
    Ok(join_classpath(entries))
}

/// The `javac` step compiling `file` into `target`'s output directory.
pub fn javac_step(target: &SingleFileTarget, file: &Path, classpath: &str, javac: &str) -> IdeResult<BuildStep> {
    let sources = source_roots(target);
    let release = release_args(target.java_version, java_home_major(&target.top.env));
    build_javac_step(javac, &target.module, &target.out_dir, classpath, &sources, release, file, target.top.env.clone())
}

/// The module's Java source folders that exist, generated ones included; test sources see
/// the main ones too.
fn source_roots(target: &SingleFileTarget) -> Vec<PathBuf> {
    let scopes: &[(&str, &str)] = if target.test {
        &[("src/test/java", "target/generated-test-sources"), ("src/main/java", "target/generated-sources")]
    } else {
        &[("src/main/java", "target/generated-sources")]
    };
    let mut roots = Vec::new();
    for (src, generated) in scopes {
        roots.push(target.module.join(src));
        let generated = target.module.join(generated);
        let mut dirs: Vec<PathBuf> =
            fs::read_dir(&generated).into_iter().flatten().flatten().map(|d| d.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        roots.extend(dirs);
    }
    roots.retain(|p| p.is_dir());
    roots
}

/// Resolves the classpath and plans the `javac` invocation for one Java source.
pub fn compile_file_plan(root: &Path, model: &BuildModel, file: &Path) -> IdeResult<BuildPlan> {
    compile_file_plan_cancellable(root, model, file, &CancellationToken::new())
}

/// Cancellable [`compile_file_plan`].
pub fn compile_file_plan_cancellable(
    root: &Path,
    model: &BuildModel,
    file: &Path,
    cancel: &CancellationToken,
) -> IdeResult<BuildPlan> {
    let target = single_file_target(root, model, file)?;
    let classpath = single_file_classpath_cancellable(root, model, &target, cancel)?;
    let javac = find_javac(&target.top.env);
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(BuildPlan {
        system: BuildSystem::Maven,
        title: format!("Compile {name}"),
        steps: vec![javac_step(&target, file, &classpath, &javac)?],
    })
}

fn gradle_for_file<'a>(
    root: &Path,
    model: &'a BuildModel,
    file: &Path,
) -> Option<(&'a crate::GradleModel, &'a crate::GradleProject, PathBuf)> {
    let file = normalize(file);
    let file_ref = &file;
    model
        .gradle
        .iter()
        .flat_map(|g| {
            let g_dir = normalize(&subdir(root, &g.dir));
            let g_depth = g_dir.components().count();
            g.projects.iter().filter_map(move |p| {
                let p_dir = normalize(&subdir(root, &p.dir));
                file_ref.starts_with(&p_dir).then_some((g, p, p_dir, g_depth))
            })
        })
        .max_by_key(|(_, _, p_dir, g_depth)| (p_dir.components().count(), *g_depth))
        .map(|(g, p, p_dir, _)| (g, p, p_dir))
}

/// Whether `file` lies inside a linked Gradle project of `model`.
pub fn has_gradle_file_target(root: &Path, model: &BuildModel, file: &Path) -> bool {
    gradle_for_file(root, model, file).is_some()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GradleCompileCp {
    out_dir: Option<String>,
    #[serde(default)]
    classpath: Vec<String>,
    #[serde(default)]
    src_dirs: Vec<String>,
    release: Option<u32>,
}

/// Resolves the compile classpath from Gradle and plans a single-file `javac` step.
pub fn gradle_compile_file_plan(
    root: &Path,
    model: &BuildModel,
    file: &Path,
    cache: &Path,
    cancel: &CancellationToken,
) -> IdeResult<BuildPlan> {
    let name = is_java_file(file)?;
    let (gradle, project, module_dir) = gradle_for_file(root, model, file)
        .ok_or_else(|| IdeError::not_found("no linked Gradle project found for file"))?;
    let rel = rel_str(&module_dir, file);
    let test = is_test_source(&rel);
    let scope = if test { "test" } else { "main" };

    fs::create_dir_all(cache)?;
    let init_script = cache.join("gradle-compile-cp.init.gradle");
    fs::write(&init_script, GRADLE_COMPILE_CP_INIT_SCRIPT)?;
    let args = vec![
        "--console=plain".into(),
        "-q".into(),
        "-Dorg.gradle.configuration-cache=false".into(),
        "--init-script".into(),
        init_script.to_string_lossy().into_owned(),
        format!("-Popenidea.target={}", project.path),
        format!("-Popenidea.scope={scope}"),
        "help".into(),
    ];
    let gradle_dir = subdir(root, &gradle.dir);
    let mut reported: Option<String> = None;
    let out = process::run_bounded(&gradle.command, &args, &gradle_dir, &gradle.env, cancel, |_, line| {
        if let Some(json) = line.strip_prefix("@openidea-compile-cp\t") {
            reported = Some(json.to_owned());
        }
    })
    .map_err(|e| {
        if e.kind == ide_core::error::ErrorKind::Cancelled {
            e
        } else {
            IdeError::internal(format!("cannot resolve the compile classpath: {}", e.message))
        }
    })?;
    if !out.success {
        let tail: Vec<&str> = out.text.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail.iter().rev().take(5).rev().cloned().collect::<Vec<_>>().join("\n");
        return Err(IdeError::internal(format!("cannot resolve the compile classpath:\n{tail}")));
    }
    let json = reported.ok_or_else(|| {
        IdeError::internal(format!(
            "cannot resolve the compile classpath: Gradle did not report source set '{scope}' for {}",
            project.path
        ))
    })?;
    let cp: GradleCompileCp = serde_json::from_str(&json)
        .map_err(|e| IdeError::internal(format!("cannot parse Gradle compile classpath: {e}")))?;

    let out_dir = cp
        .out_dir
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| module_dir.join("build/classes/java").join(scope));
    let mut cp_entries: Vec<String> = Vec::new();
    if out_dir.is_dir() {
        cp_entries.push(out_dir.to_string_lossy().into_owned());
    }
    if test {
        let main_out = module_dir.join("build/classes/java/main");
        if main_out.is_dir() {
            cp_entries.push(main_out.to_string_lossy().into_owned());
        }
    }
    for sibling in &gradle.projects {
        let sibling_dir = subdir(root, &sibling.dir);
        if sibling_dir == module_dir {
            continue;
        }
        let classes = sibling_dir.join("build/classes/java/main");
        if classes.is_dir() {
            cp_entries.push(classes.to_string_lossy().into_owned());
        }
    }
    cp_entries.extend(cp.classpath);
    let classpath = join_classpath(cp_entries);

    let mut sources: Vec<PathBuf> = cp.src_dirs.into_iter().map(PathBuf::from).filter(|p| p.is_dir()).collect();
    if sources.is_empty() {
        let fallback: &[&str] = if test { &["src/test/java", "src/main/java"] } else { &["src/main/java"] };
        sources.extend(fallback.iter().map(|s| module_dir.join(s)).filter(|p| p.is_dir()));
    }
    let javac = find_javac(&gradle.env);
    let release = release_args(cp.release.or(gradle.java_version), java_home_major(&gradle.env));
    let step =
        build_javac_step(&javac, &module_dir, &out_dir, &classpath, &sources, release, file, gradle.env.clone())?;
    Ok(BuildPlan { system: BuildSystem::Gradle, title: format!("Compile {name}"), steps: vec![step] })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, value: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }

    fn fixture(root: &Path) -> BuildModel {
        write(
            root,
            "pom.xml",
            r#"<project><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version>
            <packaging>pom</packaging><modules><module>shared</module><module>lib</module><module>app</module></modules></project>"#,
        );
        write(
            root,
            "lib/pom.xml",
            r#"<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version></parent>
            <artifactId>lib</artifactId><dependencies><dependency><groupId>demo</groupId><artifactId>shared</artifactId><version>1</version></dependency></dependencies></project>"#,
        );
        write(
            root,
            "shared/pom.xml",
            r#"<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version></parent>
            <artifactId>shared</artifactId></project>"#,
        );
        write(
            root,
            "app/pom.xml",
            r#"<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version></parent>
            <artifactId>app</artifactId><dependencies><dependency><groupId>demo</groupId><artifactId>lib</artifactId><version>1</version></dependency></dependencies></project>"#,
        );
        write(root, "app/src/main/java/demo/Main.java", "class Main {}");
        write(root, "app/src/test/java/demo/MainTest.java", "class MainTest {}");
        write(root, "lib/target/classes/Lib.class", "built");
        write(root, "shared/target/classes/Shared.class", "built");
        crate::load(root, &root.join("cache"), None)
    }

    #[test]
    fn target_finds_the_owning_module_and_the_test_scope() {
        let dir = tempfile::tempdir().unwrap();
        let root_buf = dunce::canonicalize(dir.path()).unwrap();
        let root = root_buf.as_path();
        let model = fixture(root);
        let main = single_file_target(root, &model, &root.join("app/src/main/java/demo/Main.java")).unwrap();
        assert_eq!(main.module, root.join("app"));
        assert!(!main.test);
        assert_eq!(main.out_dir, root.join("app/target/classes"));
        let test = single_file_target(root, &model, &root.join("app/src/test/java/demo/MainTest.java")).unwrap();
        assert!(test.test);
        assert_eq!(test.out_dir, root.join("app/target/test-classes"));
    }

    #[test]
    fn target_rejects_non_java_missing_and_unlinked_files() {
        let dir = tempfile::tempdir().unwrap();
        let root_buf = dunce::canonicalize(dir.path()).unwrap();
        let root = root_buf.as_path();
        let model = fixture(root);
        write(root, "app/pom.xml", "<project/>");
        assert!(single_file_target(root, &model, &root.join("app/pom.xml")).is_err());
        assert!(single_file_target(root, &model, &root.join("app/src/main/java/demo/Missing.java")).is_err());
        write(root, "other/Main.java", "class Main {}");
        assert!(single_file_target(root, &model, &root.join("other/Main.java")).is_err());
    }

    #[test]
    fn javac_prefers_the_module_jdk_and_scopes_test_sources() {
        let dir = tempfile::tempdir().unwrap();
        let root_buf = dunce::canonicalize(dir.path()).unwrap();
        let root = root_buf.as_path();
        let model = fixture(root);
        let file = root.join("app/src/test/java/demo/MainTest.java");
        let target = single_file_target(root, &model, &file).unwrap();
        let jdk = root.join("jdk");
        fs::create_dir_all(jdk.join("bin")).unwrap();
        let exe = if cfg!(windows) { "javac.exe" } else { "javac" };
        fs::write(jdk.join("bin").join(exe), "fake").unwrap();
        let mut target = target;
        target.top.env.insert("JAVA_HOME".into(), jdk.to_string_lossy().into_owned());
        let step = javac_step(&target, &file, "/repo/a.jar", &find_javac(&target.top.env)).unwrap();
        assert!(step.program.ends_with(exe));
        assert!(target.out_dir.is_dir());
        let args = step.args.join(" ");
        assert!(args.contains("-encoding UTF-8"), "{args}");
        assert!(args.contains("-d ") && args.contains("test-classes"), "{args}");
        assert!(args.contains("-cp /repo/a.jar"), "{args}");
        assert!(args.contains("MainTest.java"), "{args}");
        // Test sources resolve their own and the main sources, without writing them.
        let sourcepath = step.args.iter().position(|a| a == "-sourcepath").map(|i| step.args[i + 1].clone());
        let roots = sourcepath.expect("a -sourcepath");
        assert!(roots.contains("src/test/java") && roots.contains("src/main/java"), "{roots}");
        assert!(step.args.iter().any(|a| a == "-implicit:none"), "{args}");
        // No `JAVA_HOME`: plain `javac` from `PATH`.
        assert_eq!(find_javac(&BTreeMap::new()), exe);
    }

    /// The classpath probe runs the project's Maven command with `-pl … -am`
    /// `dependency:build-classpath`; the fake `mvnw` below only records its
    /// arguments and writes a canned classpath file for the `-pl` module.
    #[cfg(unix)]
    #[test]
    fn classpath_probe_writes_one_file_per_module_and_reads_the_compiled_one() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let root_buf = dunce::canonicalize(dir.path()).unwrap();
        let root = root_buf.as_path();
        fixture(root);
        let script = root.join("mvnw");
        fs::write(
            &script,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > args.txt\npl='.'\nwhile [ $# -gt 0 ]; do\nif [ \"$1\" = \"-pl\" ]; then pl=\"$2\"; shift 2; else shift; fi\ndone\nmkdir -p \"$pl/target\"\nprintf '/repo/a.jar:/repo/b.jar' > \"$pl/target/ide-compile-cp.txt\"\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let model = crate::load(root, &root.join("cache"), None);
        let file = root.join("app/src/main/java/demo/Main.java");
        let target = single_file_target(root, &model, &file).unwrap();
        assert!(target.top.command.ends_with("mvnw"));
        assert_eq!(target.pl, "app");
        fs::create_dir_all(root.join("lib/target/test-classes")).unwrap();
        let cp = single_file_classpath(root, &model, &target).unwrap();
        assert!(!std::env::split_paths(&cp).any(|p| p == root.join("lib/target/test-classes")), "{cp}");
        let separator = ':';
        // Reactor class directories first, so fresh outputs shadow installed snapshots.
        let lib = root.join("lib/target/classes").to_string_lossy().into_owned();
        assert!(cp.starts_with(&lib), "{cp}");
        // The module's own classes come first once they exist.
        fs::create_dir_all(root.join("app/target/classes")).unwrap();
        let cp = single_file_classpath(root, &model, &target).unwrap();
        let own = root.join("app/target/classes").to_string_lossy().into_owned();
        assert!(cp.starts_with(&format!("{own}:{lib}")), "{cp}");
        assert!(cp.contains("/repo/a.jar"), "{cp}");
        assert!(cp.contains("/repo/b.jar"), "{cp}");
        assert!(cp.split(separator).count() >= 3, "{cp}");
        let args = fs::read_to_string(root.join("args.txt")).unwrap();
        assert!(!args.lines().any(|a| a == "compile" || a == "package"), "{args}");
        assert!(args.lines().any(|a| a == "-Dmdep.includeScope=compile"), "{args}");
        fs::create_dir_all(root.join("app/target/test-classes")).unwrap();
        let target = single_file_target(root, &model, &root.join("app/src/test/java/demo/MainTest.java")).unwrap();
        let cp = single_file_classpath(root, &model, &target).unwrap();
        let paths: Vec<_> = std::env::split_paths(&cp).collect();
        assert_eq!(paths[0], root.join("app/target/test-classes"));
        assert!(paths.contains(&root.join("app/target/classes")), "{cp}");
        assert!(!paths.contains(&root.join("lib/target/test-classes")), "{cp}");
        let args = fs::read_to_string(root.join("args.txt")).unwrap();
        assert!(args.lines().any(|a| a == "-Dmdep.includeScope=test"), "{args}");
    }

    /// Launches request Maven's matching scope without adding reactor test outputs.
    #[cfg(unix)]
    #[test]
    fn launch_module_classpath_uses_the_matching_dependency_scope() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let root_buf = dunce::canonicalize(dir.path()).unwrap();
        let root = root_buf.as_path();
        fixture(root);
        let script = root.join("mvnw");
        fs::write(
            &script,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > args.txt\npl='.'\nwhile [ $# -gt 0 ]; do\nif [ \"$1\" = \"-pl\" ]; then pl=\"$2\"; shift 2; else shift; fi\ndone\nmkdir -p \"$pl/target\"\nprintf '/repo/runtime.jar:/repo/fixture-tests.jar:/repo/fixture/target/test-classes' > \"$pl/target/ide-compile-cp.txt\"\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let model = crate::load(root, &root.join("cache"), None);

        for dir in
            ["app/target/classes", "app/target/test-classes", "lib/target/test-classes", "shared/target/test-classes"]
        {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let cache = root.join("cache");
        let runtime =
            module_classpath(root, &model, &root.join("app"), false, None, &cache, &CancellationToken::new()).unwrap();
        let paths: Vec<_> = std::env::split_paths(&runtime).collect();
        assert!(paths.contains(&root.join("app/target/classes")), "{runtime}");
        assert!(paths.contains(&root.join("lib/target/classes")), "{runtime}");
        assert!(!paths.contains(&root.join("app/target/test-classes")), "{runtime}");
        assert!(!paths.contains(&root.join("lib/target/test-classes")), "{runtime}");
        assert!(paths.contains(&root.join("shared/target/classes")), "{runtime}");
        assert!(!paths.contains(&root.join("shared/target/test-classes")), "{runtime}");
        assert!(paths.contains(&PathBuf::from("/repo/fixture-tests.jar")), "{runtime}");
        assert!(paths.contains(&PathBuf::from("/repo/fixture/target/test-classes")), "{runtime}");
        assert!(runtime.contains("/repo/runtime.jar"), "{runtime}");
        let args = fs::read_to_string(root.join("args.txt")).unwrap();
        assert!(args.lines().any(|a| a == "compile"), "{args}");
        assert!(!args.lines().any(|a| a == "package"), "{args}");
        assert!(args.lines().any(|a| a == "-Dmdep.includeScope=runtime"), "{args}");

        let test =
            module_classpath(root, &model, &root.join("app"), true, None, &cache, &CancellationToken::new()).unwrap();
        assert!(test.contains("/repo/fixture-tests.jar"), "{test}");
        let paths: Vec<_> = std::env::split_paths(&test).collect();
        assert!(paths.contains(&root.join("app/target/test-classes")), "{test}");
        assert!(paths.contains(&root.join("app/target/classes")), "{test}");
        assert!(paths.contains(&root.join("lib/target/classes")), "{test}");
        assert!(!paths.contains(&root.join("lib/target/test-classes")), "{test}");
        assert!(paths.contains(&root.join("shared/target/classes")), "{test}");
        assert!(!paths.contains(&root.join("shared/target/test-classes")), "{test}");
        assert!(paths.contains(&PathBuf::from("/repo/fixture/target/test-classes")), "{test}");
        let args = fs::read_to_string(root.join("args.txt")).unwrap();
        assert!(args.lines().any(|a| a == "-Dmdep.includeScope=test"), "{args}");
    }

    /// Modules launched together resolve their classpaths in one Maven probe and leave
    /// the others' cached; a probe another module breaks still resolves the first one.
    #[cfg(unix)]
    #[test]
    fn launch_modules_share_one_classpath_probe() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let root_buf = dunce::canonicalize(dir.path()).unwrap();
        let root = root_buf.as_path();
        fixture(root);
        write(root, "lib/src/main/java/demo/Lib.java", "class Lib {}");
        let script = root.join("mvnw");
        fs::write(
            &script,
            "#!/bin/sh\necho \"$@\" >> calls.txt\npl='.'\nwhile [ $# -gt 0 ]; do\nif [ \"$1\" = \"-pl\" ]; then pl=\"$2\"; shift 2; else shift; fi\ndone\ncase \"$pl\" in *lib*) [ -f lib/broken ] && exit 1;; esac\nfor m in $(echo \"$pl\" | tr ',' ' '); do mkdir -p \"$m/target\" repo; touch \"repo/$m.jar\"; printf \"$PWD/repo/$m.jar\" > \"$m/target/ide-compile-cp.txt\"; done\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let model = crate::load(root, &root.join("cache"), None);
        let cache = root.join("cache");
        let cancel = CancellationToken::new();
        let calls = || fs::read_to_string(root.join("calls.txt")).unwrap_or_default().lines().count();
        let modules = [root.join("app"), root.join("lib"), root.join("app")];
        let app = module_classpaths(root, &model, &modules, false, None, &cache, &cancel).unwrap();
        assert!(app.contains("/repo/app.jar") && !app.contains("repo/lib.jar"), "{app}");
        assert_eq!(calls(), 1);
        assert!(fs::read_to_string(root.join("calls.txt")).unwrap().contains("-pl app,lib -am compile"));
        let lib = module_classpath(root, &model, &root.join("lib"), false, None, &cache, &cancel).unwrap();
        assert!(lib.contains("/repo/lib.jar"), "{lib}");
        assert_eq!(calls(), 1, "lib's classpath came from the shared probe");
        // A probe another module breaks is retried for the first module alone.
        write(root, "lib/src/main/java/demo/Lib.java", "class Lib { int changed; }");
        write(root, "lib/broken", "");
        let app = module_classpaths(root, &model, &[root.join("app"), root.join("lib")], false, None, &cache, &cancel)
            .unwrap();
        assert!(app.contains("/repo/app.jar"), "{app}");
        assert_eq!(calls(), 3, "the shared probe failed, then app was probed alone");
        // The first module's own failure stays its failure.
        assert!(module_classpath(root, &model, &root.join("lib"), false, None, &cache, &cancel).is_err());
    }

    /// The launch classpath follows the Maven runner JDK and is reused until that
    /// build input changes; the probe does not run packaging plugins.
    #[cfg(unix)]
    #[test]
    fn launch_classpath_cache_follows_the_runner_jdk_and_format() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let root_buf = dunce::canonicalize(dir.path()).unwrap();
        let root = root_buf.as_path();
        fixture(root);
        let script = root.join("mvnw");
        // `dependency:build-classpath` reports reactor outputs as absolute paths. Keep
        // the fake probe faithful so the cache's existence check sees the output.
        fs::write(
            &script,
            "#!/bin/sh\nprintf x >> calls.txt\npl='.'\nwhile [ $# -gt 0 ]; do\nif [ \"$1\" = \"-pl\" ]; then pl=\"$2\"; shift 2; else shift; fi\ndone\nmkdir -p \"$pl/target/classes\" \"$JAVA_HOME/classpath\"\n: > \"$JAVA_HOME/classpath/jdk.jar\"\nprintf '%s/classpath/jdk.jar:%s/%s/target/classes:%s/empty/target/classes' \"$JAVA_HOME\" \"$(pwd)\" \"$pl\" \"$(pwd)\" > \"$pl/target/ide-compile-cp.txt\"\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let mut model = crate::load(root, &root.join("cache"), None);
        for (name, version) in [("jdk21", "21"), ("jdk8", "8")] {
            let home = root.join(name);
            fs::create_dir_all(home.join("bin")).unwrap();
            fs::write(home.join("release"), format!("JAVA_VERSION=\"{version}\"\n")).unwrap();
            fs::write(home.join("bin/java"), "").unwrap();
        }
        fs::create_dir_all(root.join("app/target/classes")).unwrap();
        let cache = root.join("classpath-cache");
        let cancel = CancellationToken::new();
        let jdk21 = root.join("jdk21");
        for project in &mut model.maven.as_mut().unwrap().projects {
            project.env.insert("JAVA_HOME".into(), jdk21.to_string_lossy().into_owned());
        }
        let first = module_classpath(root, &model, &root.join("app"), false, None, &cache, &cancel).unwrap();
        assert!(first.contains("jdk21/classpath/jdk.jar"), "{first}");
        assert!(!first.contains("jdk8/classpath/jdk.jar"), "{first}");
        let second = module_classpath(root, &model, &root.join("app"), false, None, &cache, &cancel).unwrap();
        assert_eq!(second, first);
        assert_eq!(fs::read_to_string(root.join("calls.txt")).unwrap(), "x");

        let record = classpath_cache_path(root, &cache, &root.join("app"), false).unwrap();
        let current: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
        let test_output = root.join("lib/target/test-classes");
        fs::create_dir_all(&test_output).unwrap();
        let polluted = std::env::join_paths(std::env::split_paths(&first).chain([test_output])).unwrap();
        let mut calls = "x".to_owned();
        for version in [None, Some(0), Some(u32::MAX)] {
            let mut stale = current.clone();
            stale["classpath"] = polluted.to_string_lossy().as_ref().into();
            if let Some(version) = version {
                stale["version"] = version.into();
            } else {
                stale.as_object_mut().unwrap().remove("version");
            }
            fs::write(&record, serde_json::to_vec(&stale).unwrap()).unwrap();
            let rebuilt = module_classpath(root, &model, &root.join("app"), false, None, &cache, &cancel).unwrap();
            assert_eq!(rebuilt, first, "incompatible cache format {version:?} must be rebuilt");
            calls.push('x');
            assert_eq!(fs::read_to_string(root.join("calls.txt")).unwrap(), calls);
            let reused = module_classpath(root, &model, &root.join("app"), false, None, &cache, &cancel).unwrap();
            assert_eq!(reused, rebuilt);
            assert_eq!(fs::read_to_string(root.join("calls.txt")).unwrap(), calls);
        }

        let jdk8 = root.join("jdk8");
        for project in &mut model.maven.as_mut().unwrap().projects {
            project.env.insert("JAVA_HOME".into(), jdk8.to_string_lossy().into_owned());
        }
        let switched = module_classpath(root, &model, &root.join("app"), false, None, &cache, &cancel).unwrap();
        assert!(switched.contains("jdk8/classpath/jdk.jar"), "{switched}");
        assert!(!switched.contains("jdk21/classpath/jdk.jar"), "{switched}");
        calls.push('x');
        assert_eq!(fs::read_to_string(root.join("calls.txt")).unwrap(), calls);
    }

    #[test]
    fn javac_step_omits_empty_classpath_and_uses_source_target_on_jdk_8() {
        let dir = tempfile::tempdir().unwrap();
        let root_buf = dunce::canonicalize(dir.path()).unwrap();
        let root = root_buf.as_path();
        let mut model = fixture(root);
        let file = root.join("app/src/main/java/demo/Main.java");
        let jdk8 = root.join("jdk8");
        fs::create_dir_all(jdk8.join("bin")).unwrap();
        fs::write(jdk8.join("release"), "JAVA_VERSION=\"1.8.0_372\"\n").unwrap();
        let project = model.maven.as_mut().unwrap().projects.iter_mut().find(|p| p.dir == "app").unwrap();
        project.java_version = Some(8);
        let mut target = single_file_target(root, &model, &file).unwrap();
        target.top.env.insert("JAVA_HOME".into(), jdk8.to_string_lossy().into_owned());
        let step = javac_step(&target, &file, "", "javac").unwrap();
        assert!(!step.args.iter().any(|a| a == "-cp"), "{:?}", step.args);
        assert!(step.args.iter().any(|a| a == "-g"), "{:?}", step.args);
        assert!(step.args.windows(4).any(|w| w == ["-source", "1.8", "-target", "1.8"]), "{:?}", step.args);
        assert!(!step.args.iter().any(|a| a == "--release"), "{:?}", step.args);
    }

    #[cfg(unix)]
    #[test]
    fn gradle_single_file_compiles_with_source_set_classpath_and_siblings() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let root_buf = dunce::canonicalize(dir.path()).unwrap();
        let root = root_buf.as_path();
        write(root, "settings.gradle", "include ':lib', ':app'");
        write(root, "lib/build.gradle", "plugins { id 'java' }");
        write(root, "app/build.gradle", "plugins { id 'java' }");
        write(root, "app/src/main/java/demo/App.java", "package demo; class App {}");
        write(root, "app/src/test/java/demo/AppTest.java", "package demo; class AppTest {}");
        fs::create_dir_all(root.join("lib/build/classes/java/main")).unwrap();
        fs::create_dir_all(root.join("app/build/classes/java/main")).unwrap();
        let wrapper = root.join("gradlew");
        fs::write(
            &wrapper,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > gradle_args.txt\nscope='main'\nfor a in \"$@\"; do\ncase \"$a\" in -Popenidea.scope=*) scope=\"${a#-Popenidea.scope=}\" ;; esac\ndone\nprintf '@openidea-compile-cp\\t{\"outDir\":\"%s/app/build/classes/java/%s\",\"classpath\":[\"%s/deps/guava.jar\"],\"srcDirs\":[\"%s/app/src/%s/java\"],\"release\":17}\\n' \"$PWD\" \"$scope\" \"$PWD\" \"$PWD\" \"$scope\"\n",
        )
        .unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();

        let model = crate::load(root, &root.join("cache"), None);
        let cache = root.join("cache");
        let cancel = CancellationToken::new();

        let main_file = root.join("app/src/main/java/demo/App.java");
        let main_plan = gradle_compile_file_plan(root, &model, &main_file, &cache, &cancel).unwrap();
        assert_eq!(main_plan.system, BuildSystem::Gradle);
        assert_eq!(main_plan.title, "Compile App.java");
        let step = &main_plan.steps[0];
        let args = fs::read_to_string(root.join("gradle_args.txt")).unwrap();
        assert!(args.lines().any(|a| a == "-Popenidea.target=:app"), "{args}");
        assert!(args.lines().any(|a| a == "-Popenidea.scope=main"), "{args}");
        let cp = &step.args[step.args.iter().position(|a| a == "-cp").unwrap() + 1];
        let paths: Vec<_> = std::env::split_paths(cp).collect();
        assert!(paths.contains(&root.join("app/build/classes/java/main")), "{cp}");
        assert!(paths.contains(&root.join("lib/build/classes/java/main")), "{cp}");
        assert!(paths.contains(&root.join("deps/guava.jar")), "{cp}");
        assert!(step.args.windows(2).any(|w| w == ["--release", "17"]), "{:?}", step.args);
        assert!(step.args.iter().any(|a| a == "-implicit:none"), "{:?}", step.args);

        let test_file = root.join("app/src/test/java/demo/AppTest.java");
        let test_plan = gradle_compile_file_plan(root, &model, &test_file, &cache, &cancel).unwrap();
        assert_eq!(test_plan.title, "Compile AppTest.java");
        let test_step = &test_plan.steps[0];
        let args = fs::read_to_string(root.join("gradle_args.txt")).unwrap();
        assert!(args.lines().any(|a| a == "-Popenidea.scope=test"), "{args}");
        assert!(
            test_step.args.windows(2).any(|w| w == ["-d", &root.join("app/build/classes/java/test").to_string_lossy()])
        );
    }
}
