//! Gradle projects for the Gradle tool window: the project structure from
//! `settings.gradle(.kts)` (read statically) and the task list from
//! `gradle tasks --all` (after a sync; until then the usual tasks of the
//! applied plugins are shown).

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const SETTINGS_FILES: &[&str] = &["settings.gradle.kts", "settings.gradle"];
pub const BUILD_FILES: &[&str] = &["build.gradle.kts", "build.gradle"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GradleModel {
    /// Project-relative directory of the build (where `settings.gradle` is); `""` = project root.
    pub dir: String,
    /// The root project first, then subprojects in `include` order.
    pub projects: Vec<GradleProject>,
    pub java_version: Option<u32>,
    /// `gradlew` of the build (absolute), else `gradle`.
    pub command: String,
    /// Environment for runs (`JAVA_HOME`); filled in by the shell.
    pub env: BTreeMap<String, String>,
    /// When the task list was last read from Gradle (Unix ms); `None` = static defaults.
    pub synced_at: Option<f64>,
    pub stale: bool,
    pub sync_error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GradleProject {
    /// Gradle path: `:` for the root project, `:app`, `:libs:core`; for a project of a
    /// nested build its identity path (`:lib:core`), which addresses its tasks from the root.
    pub path: String,
    pub name: String,
    /// Project-relative directory.
    pub dir: String,
    /// Project-relative build script, if any.
    pub build_file: Option<String>,
    pub tasks: Vec<GradleTask>,
    /// Identity path of the nested build holding the project (`:lib` for `includeBuild`,
    /// `:buildSrc`); null for the opened build.
    #[serde(default)]
    pub build: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GradleTask {
    pub name: String,
    /// Lower-case group (`build`, `build setup`, `other`).
    pub group: String,
    pub description: Option<String>,
}

fn task(group: &str, name: &str) -> GradleTask {
    GradleTask { name: name.to_owned(), group: group.to_owned(), description: None }
}

/// A Groovy / Kotlin script with `//` and `/* */` comments removed.
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = ' ';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Quoted string literals in `s`.
fn literals(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(start) = rest.find(['"', '\'']) {
        let Some((value, used)) = literal(&rest[start..]) else { break };
        out.push(value);
        rest = &rest[start + used..];
    }
    out
}

/// Arguments of `include(...)` (Kotlin) or `include 'a', 'b'` (Groovy, continued
/// over lines that end with a comma).
fn include_args(after: &str) -> Vec<String> {
    if let Some(inner) = after.trim_start().strip_prefix('(') {
        return literals(&inner[..inner.find(')').unwrap_or(inner.len())]);
    }
    let mut out = Vec::new();
    for line in after.lines() {
        out.extend(literals(line));
        if !line.trim_end().ends_with(',') {
            break;
        }
    }
    out
}

/// What a settings script declares, read statically.
#[derive(Debug, Default, PartialEq)]
pub struct Settings {
    pub name: Option<String>,
    /// Included project paths (`:app`), in declaration order.
    pub includes: Vec<String>,
    /// Project directories that differ from the default `<path>` under the build
    /// dir, relative to it: `includeFlat` siblings and literal `projectDir = file(..)`.
    pub dirs: BTreeMap<String, String>,
}

/// The included projects, root project name and directory overrides of a settings script.
/// Interpolated (`"$m"`) names and directories cannot be read without Gradle and are skipped.
pub fn parse_settings(text: &str) -> Settings {
    let text = strip_comments(text);
    let mut s = Settings::default();
    for (i, _) in text.match_indices("rootProject.name") {
        let line = text[i + "rootProject.name".len()..].lines().next().unwrap_or_default();
        if let Some(n) = literals(line).into_iter().next() {
            s.name = Some(n);
        }
    }
    let mut from = 0;
    while let Some(i) = text[from..].find("include") {
        let at = from + i;
        from = at + "include".len();
        let flat = text[from..].starts_with("Flat");
        if flat {
            from += "Flat".len();
        }
        let before_ok = at == 0 || !text[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.');
        let after = &text[from..];
        let after_ok = after.starts_with(|c: char| c == '(' || c.is_whitespace());
        if !before_ok || !after_ok {
            continue;
        }
        for p in include_args(after).into_iter().filter(|p| !p.contains('$')) {
            let path = if p.starts_with(':') { p } else { format!(":{p}") };
            if path.len() <= 1 {
                continue;
            }
            // `includeFlat 'a'` is the sibling directory `../a` of the root project.
            if flat {
                s.dirs.insert(path.clone(), format!("../{}", path.trim_start_matches(':')));
            }
            if !s.includes.contains(&path) {
                s.includes.push(path);
            }
        }
    }
    // `project(':a').projectDir = file('../a')`; a later assignment wins, as in Gradle.
    for line in text.lines() {
        let Some((left, right)) = line.split_once(".projectDir") else { continue };
        let Some(right) = right.trim_start().strip_prefix('=') else { continue };
        let Some(arg) = right.trim_start().strip_prefix("file") else { continue };
        let (Some(path), Some(dir)) = (
            left.rsplit_once("project").map(|(_, p)| literals(p)).and_then(|l| l.into_iter().next()),
            literals(arg).into_iter().next(),
        ) else {
            continue;
        };
        if !path.contains('$') && !dir.contains('$') {
            let path = if path.starts_with(':') { path } else { format!(":{path}") };
            s.dirs.insert(path, dir);
        }
    }
    s
}

/// `a/b/../c` → `a/c`, without touching the filesystem.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir if out.file_name().is_some() => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

/// The first automatically discovered build, for callers operating on one build.
pub fn build_dir(root: &Path) -> Option<PathBuf> {
    build_dirs(root).into_iter().next()
}

fn build_dirs(root: &Path) -> Vec<PathBuf> {
    let markers: Vec<_> = SETTINGS_FILES.iter().chain(BUILD_FILES).copied().collect();
    ide_core::project_roots::discover(root, &markers)
}

fn wrapper(dir: &Path) -> String {
    let name = if cfg!(windows) { "gradlew.bat" } else { "gradlew" };
    if dir.join(name).is_file() {
        return dir.join(name).to_string_lossy().into_owned();
    }
    if cfg!(windows) { "gradle.bat".into() } else { "gradle".into() }
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// The tasks Gradle's own plugins add, for display before the first sync.
pub fn default_tasks(is_root: bool, script: &str) -> Vec<GradleTask> {
    let mut out = Vec::new();
    if is_root {
        out.extend([task("build setup", "init"), task("build setup", "wrapper")]);
    }
    for t in [
        "buildEnvironment",
        "dependencies",
        "dependencyInsight",
        "help",
        "javaToolchains",
        "projects",
        "properties",
        "tasks",
    ] {
        out.push(task("help", t));
    }
    let jvm = [
        "java",
        "application",
        "kotlin(",
        "org.jetbrains.kotlin",
        "groovy",
        "scala",
        "org.springframework.boot",
        "war",
    ]
    .iter()
    .any(|k| script.contains(k));
    if jvm {
        for t in ["assemble", "build", "buildDependents", "buildNeeded", "classes", "clean", "jar", "testClasses"] {
            out.push(task("build", t));
        }
        out.extend([task("verification", "check"), task("verification", "test"), task("documentation", "javadoc")]);
    }
    if script.contains("application") {
        out.push(task("application", "run"));
    }
    if script.contains("org.springframework.boot") {
        out.extend([task("application", "bootRun"), task("build", "bootJar")]);
    }
    out
}

/// Reads the Gradle build under `root` (no Gradle run), or `None` when there is none.
fn read_first(d: &Path, names: &[&str]) -> Option<(String, String)> {
    names.iter().find_map(|n| std::fs::read_to_string(d.join(n)).ok().map(|t| (n.to_string(), t)))
}

/// The project `path` in `pdir`, with the default tasks of its build script.
/// Outside `root` the directory stays absolute (`rel` falls back).
fn project_at(root: &Path, path: String, name: String, pdir: &Path) -> GradleProject {
    let script = read_first(pdir, BUILD_FILES);
    let tasks = default_tasks(path == ":", script.as_ref().map(|(_, t)| t.as_str()).unwrap_or_default());
    GradleProject {
        build_file: script.map(|(n, _)| rel(root, &pdir.join(n))),
        dir: rel(root, pdir),
        path,
        name,
        tasks,
        build: None,
    }
}

/// A project as Gradle evaluated it (the sync's init script, `gradle-model.gradle`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedProject {
    pub path: String,
    /// Absolute, canonical.
    pub dir: String,
    /// Absolute output folder (`layout.buildDirectory`).
    #[serde(default)]
    pub build_dir: Option<String>,
    #[serde(default)]
    pub source_sets: Vec<ReportedSourceSet>,
    /// Toolchain language version, else target compatibility.
    #[serde(default)]
    pub java: Option<u32>,
    /// Identity path of the nested build (included build, buildSrc) reporting the project.
    #[serde(default)]
    pub build: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReportedSourceSet {
    pub name: String,
    pub test: bool,
    /// Absolute source folders (Java, Kotlin, Groovy, …), which need not exist.
    #[serde(default)]
    pub src: Vec<String>,
    /// Absolute resource folders.
    #[serde(default)]
    pub res: Vec<String>,
    /// Set when Gradle changes the resources while copying them (filters, `expand`, renames,
    /// includes / excludes, extra sources), which the Java language server's copy does not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processed: Option<ProcessedResources>,
}

/// The task that copies a source set's resources, and where it writes them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessedResources {
    /// Task name in its project (`processResources`).
    pub task: String,
    /// Absolute output folder.
    pub dir: String,
}

const MODEL_LINE: &str = "@openidea-model\t";

/// The projects printed by `gradle-model.gradle`; malformed lines are skipped.
pub fn parse_reported_projects(output: &str) -> Vec<ReportedProject> {
    output.lines().filter_map(|l| serde_json::from_str(l.trim_end().strip_prefix(MODEL_LINE)?).ok()).collect()
}

/// Source roots of the reported source sets: `(absolute folder, is test, is resources)`.
pub fn reported_source_roots(reported: &[ReportedProject]) -> Vec<(PathBuf, ReportedRoot)> {
    let mut out: Vec<(PathBuf, ReportedRoot)> = Vec::new();
    for p in reported {
        for set in &p.source_sets {
            let (src, res) = if set.test {
                (ReportedRoot::Test, ReportedRoot::TestResources)
            } else {
                (ReportedRoot::Source, ReportedRoot::Resources)
            };
            for (dir, kind) in set.src.iter().map(|d| (d, src)).chain(set.res.iter().map(|d| (d, res))) {
                let dir = PathBuf::from(dir);
                // A folder shared by `main` and another set is `main`'s, as in IDEA.
                if !out.iter().any(|(d, _)| *d == dir) {
                    out.push((dir, kind));
                }
            }
        }
        // IDEA excludes the build folder of every module.
        if let Some(b) = &p.build_dir {
            out.push((PathBuf::from(b), ReportedRoot::Excluded));
        }
    }
    out
}

/// Role of a folder a Gradle sync reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportedRoot {
    Source,
    Test,
    Resources,
    TestResources,
    Excluded,
}

/// Replaces the statically read projects with the ones Gradle reported (root first):
/// settings scripts may compute their projects, which no static reading sees.
pub fn merge_reported_projects(root: &Path, model: &mut GradleModel, reported: &[ReportedProject]) {
    if reported.is_empty() {
        return;
    }
    let root_name = model.projects.iter().find(|p| p.path == ":").map(|p| p.name.clone());
    model.projects = reported
        .iter()
        .map(|p| {
            let name = match p.path.as_str() {
                ":" => root_name.clone().unwrap_or_default(),
                path => path.rsplit(':').next().unwrap_or_default().to_owned(),
            };
            let mut project = project_at(root, p.path.clone(), name, Path::new(&p.dir));
            // buildSrc is built before the build, never addressable as `:buildSrc:<task>`.
            if p.build.as_deref().is_some_and(|b| b.ends_with(":buildSrc")) {
                project.tasks.clear();
            }
            project.build = p.build.clone();
            project
        })
        .collect();
    // Each build reports its projects when it is evaluated (nested builds first).
    model.projects.sort_by(|a, b| a.path.cmp(&b.path));
    // One JDK runs the whole build: the newest any module needs.
    if let Some(v) = reported.iter().filter_map(|p| p.java).max() {
        model.java_version = Some(v);
    }
}

/// Project directories outside `root`, outermost only (`../svc`, not also `../svc/sources/app`):
/// the folders IDEA shows as extra top-level module roots.
pub fn external_roots<'a>(root: &Path, dirs: impl IntoIterator<Item = &'a str>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = dirs.into_iter().map(|d| root.join(d)).filter(|d| !d.starts_with(root)).collect();
    dirs.sort();
    dirs.dedup();
    let mut out: Vec<PathBuf> = Vec::new();
    for d in dirs {
        if !out.iter().any(|o| d.starts_with(o)) {
            out.push(d);
        }
    }
    out
}

pub fn load(root: &Path) -> Option<GradleModel> {
    let dir = build_dir(root)?;
    load_build(root, dir.strip_prefix(root).unwrap_or(&dir))
}

/// Loads exactly this build, without searching its child folders.
pub fn load_build(root: &Path, dir: &Path) -> Option<GradleModel> {
    // Linked builds are saved with forward slashes; rebuild the path so the launcher
    // and module folders use the platform's separators.
    let dir: PathBuf = root.join(dir).components().collect();
    if !SETTINGS_FILES.iter().chain(BUILD_FILES).any(|name| dir.join(name).is_file()) {
        return None;
    }
    let settings = read_first(&dir, SETTINGS_FILES).map(|(_, t)| parse_settings(&t)).unwrap_or_default();
    let root_name =
        settings.name.unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    let mut projects = vec![project_at(root, ":".into(), root_name, &dir)];
    for path in settings.includes {
        let pdir = match settings.dirs.get(&path) {
            Some(d) => normalize(&dir.join(d)),
            None => dir.join(path.trim_start_matches(':').replace(':', "/")),
        };
        let name = path.rsplit(':').next().unwrap_or_default().to_owned();
        projects.push(project_at(root, path, name, &pdir));
    }
    let java_version = projects
        .iter()
        .filter_map(|p| p.build_file.as_ref())
        .filter_map(|f| std::fs::read_to_string(root.join(f)).ok())
        .find_map(|t| script_java_version(&strip_comments(&t)));
    Some(GradleModel { dir: rel(root, &dir), projects, java_version, command: wrapper(&dir), ..GradleModel::default() })
}

/// Validates user-selected build folders and stores a stable, deduplicated identity.
pub fn normalize_linked_projects(root: &Path, dirs: &[String]) -> ide_core::IdeResult<Vec<String>> {
    let root = dunce::canonicalize(root)?;
    let mut out = Vec::new();
    for dir in dirs {
        let path = dunce::canonicalize(root.join(dir))?;
        if !path.is_dir() || !SETTINGS_FILES.iter().chain(BUILD_FILES).any(|name| path.join(name).is_file()) {
            return Err(ide_core::IdeError::invalid(format!("No Gradle build in {}", path.display())));
        }
        let dir = rel(&root, &path);
        if !out.contains(&dir) {
            out.push(dir);
        }
    }
    Ok(out)
}

/// The form `normalize_linked_projects` saves `dir` in, also for a folder that no longer
/// exists, so a path the UI sends (`C:\…` on Windows) matches the saved entry.
pub fn linked_project_key(root: &Path, dir: &str) -> String {
    match (dunce::canonicalize(root), dunce::canonicalize(root.join(dir))) {
        (Ok(root), Ok(path)) => rel(&root, &path),
        _ => dir.replace('\\', "/"),
    }
}

/// Linked build identities without reading their scripts (also used by index hot paths).
pub(crate) fn linked_dirs(root: &Path, settings: &ide_core::settings::GradleSettings) -> Vec<String> {
    match &settings.linked_projects {
        None => build_dirs(root).iter().map(|dir| rel(root, dir)).collect(),
        Some(dirs) => {
            let mut out = Vec::new();
            for dir in dirs {
                if let Ok(dirs) = normalize_linked_projects(root, std::slice::from_ref(dir)) {
                    for dir in dirs {
                        if !out.contains(&dir) {
                            out.push(dir);
                        }
                    }
                }
            }
            out
        }
    }
}

pub fn load_linked(root: &Path, settings: &ide_core::settings::GradleSettings) -> Vec<GradleModel> {
    linked_dirs(root, settings).iter().filter_map(|dir| load_build(root, Path::new(dir))).collect()
}

/// A build's task paths are local to it, so sync caches must be local to its identity too.
pub fn cache_dir(cache: &Path, build_dir: &str) -> PathBuf {
    if build_dir.is_empty() {
        return cache.to_path_buf();
    }
    let hash = build_dir.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    cache.join("gradle").join(format!("{hash:016x}"))
}

/// `JavaLanguageVersion.of(21)` / `sourceCompatibility = JavaVersion.VERSION_17` in a build script.
pub fn script_java_version(text: &str) -> Option<u32> {
    let number = |s: &str| -> Option<u32> {
        let s = s.trim_start_matches([' ', '=', '\t', '(', '"', '\'']);
        let s = s.strip_prefix("JavaVersion.VERSION_").unwrap_or(s);
        let s = s.strip_prefix("1_").or_else(|| s.strip_prefix("1.")).unwrap_or(s);
        s.chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()
    };
    for key in ["JavaLanguageVersion.of(", "sourceCompatibility", "jvmToolchain("] {
        if let Some(v) = text.find(key).and_then(|i| number(&text[i + key.len()..])) {
            return Some(v);
        }
    }
    None
}

/// Configurations whose dependencies are libraries (`testFixturesImplementation` ends in one).
const DEPENDENCY_CONFIGURATIONS: &[&str] = &[
    "implementation",
    "api",
    "compileOnly",
    "runtimeOnly",
    "compileOnlyApi",
    "annotationProcessor",
    "kapt",
    "ksp",
    "compile",
    "runtime",
    "testCompile",
    "testRuntime",
    "developmentOnly",
];

fn is_dependency_configuration(name: &str) -> bool {
    DEPENDENCY_CONFIGURATIONS.iter().any(|c| {
        name == *c || {
            let mut cap = c.chars();
            let first = cap.next().map(|f| f.to_ascii_uppercase()).into_iter();
            let capitalised: String = first.chain(cap).collect();
            name.len() > c.len() && name.ends_with(&capitalised)
        }
    })
}

/// `(group, artifact, version)` of the external dependencies a build script declares:
/// `implementation 'g:a:v'`, `api("g:a:v:classifier@jar")`, and the map notation
/// `implementation group: 'g', name: 'a', version: 'v'` (Groovy) / `group = "g", …` (Kotlin).
/// Versions written as `${gsonVersion}` are filled in from `properties` (`ext` values, see
/// [`script_properties`]); ranges, unknown names and catalog aliases (`libs.x`) are skipped.
pub fn script_dependencies(text: &str, properties: &BTreeMap<String, String>) -> Vec<(String, String, String)> {
    let text = strip_comments(text);
    let mut out = Vec::new();
    for line in text.lines().flat_map(statements) {
        let line = line.trim_start();
        let name: String = line.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if name.is_empty() || !is_dependency_configuration(&name) {
            continue;
        }
        let rest = &line[name.len()..];
        let lits = literals(rest);
        let map_value = |key: &str| -> Option<String> {
            let i = rest.find(key)?;
            let after = rest[i + key.len()..].trim_start().strip_prefix([':', '='])?;
            literals(after).into_iter().next()
        };
        let coordinate = match (map_value("group"), map_value("name"), map_value("version")) {
            (Some(g), Some(a), Some(v)) => Some((g, a, v)),
            _ => lits.first().and_then(|l| {
                let l = l.split('@').next().unwrap_or(l);
                let mut parts = l.split(':');
                Some((parts.next()?.to_owned(), parts.next()?.to_owned(), parts.next()?.to_owned()))
            }),
        };
        if let Some((g, a, v)) = coordinate {
            let v = interpolate(&v, properties);
            let plain = |s: &str| {
                !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
            };
            if plain(&g) && plain(&a) && plain(&v) && !v.contains('+') {
                out.push((g, a, v));
            }
        }
    }
    out
}

/// `line` split at `{` and `;` outside quoted strings, so a `${version}` stays in one piece.
fn statements(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < line.len() {
        let c = line[index..].chars().next().unwrap();
        if c == '"' || c == '\'' {
            index += literal(&line[index..]).map_or(line.len() - index, |(_, used)| used);
            continue;
        }
        if matches!(c, '{' | '}' | ';' | '\n') {
            out.push(&line[start..index]);
            start = index + c.len_utf8();
        }
        index += c.len_utf8();
    }
    out.push(&line[start..]);
    out
}

/// `apply from: 'x.gradle'` (Groovy) and `apply(from = "x.gradle.kts")` (Kotlin DSL)
/// targets, as written in the script.
pub fn applied_scripts(text: &str) -> Vec<String> {
    let text = strip_comments(text);
    let mut out = Vec::new();
    for (index, word) in code_words(&text) {
        if word != "apply" || !starts_word(&text, index) {
            continue;
        }
        let mut rest = text[index + "apply".len()..].trim_start();
        if let Some(inner) = rest.strip_prefix('(') {
            rest = inner.trim_start();
        }
        let Some(rest) = rest.strip_prefix("from") else { continue };
        let Some(rest) = rest.trim_start().strip_prefix(':').or_else(|| rest.trim_start().strip_prefix('=')) else {
            continue;
        };
        let mut rest = rest.trim_start();
        if let Some(inner) = rest.strip_prefix("file") {
            let inner = inner.trim_start();
            if let Some(inner) = inner.strip_prefix('(') {
                rest = inner.trim_start();
            }
        }
        if let Some((path, _)) = literal(rest) {
            out.push(path);
        }
    }
    out
}

/// Literal extra properties declared by Groovy's `ext` or Kotlin's `extra`.
pub fn script_properties(text: &str) -> BTreeMap<String, String> {
    let text = strip_comments(text);
    let mut out = BTreeMap::new();
    for (index, word) in code_words(&text) {
        if !starts_word(&text, index) {
            continue;
        }
        let rest = text[index + word.len()..].trim_start();
        if word == "val" || word == "var" {
            let (name, rest) = identifier(rest);
            let Some(rest) = rest.trim_start().strip_prefix("by").map(str::trim_start) else { continue };
            let Some(rest) = rest.strip_prefix("extra").map(str::trim_start) else { continue };
            if let Some(rest) = rest.strip_prefix('(')
                && let Some((value, used)) = literal(rest.trim_start())
                && rest.trim_start()[used..].trim_start().starts_with(')')
                && !name.is_empty()
            {
                out.insert(name.to_owned(), value);
            }
            continue;
        }
        if word != "ext" && word != "extra" {
            continue;
        }
        if let Some(block) = rest.strip_prefix('{') {
            if let Some(end) = matching_brace(block) {
                out.extend(assignments(&block[..end]));
            }
        } else if let Some(rest) = rest.strip_prefix('.') {
            let (name, rest) = identifier(rest);
            if let Some(value) = assigned_literal(rest)
                && !name.is_empty()
            {
                out.insert(name.to_owned(), value);
            }
        } else if let Some(rest) = rest.strip_prefix('[')
            && let Some((name, used)) = literal(rest.trim_start())
            && let Some(rest) = rest.trim_start()[used..].trim_start().strip_prefix(']')
            && let Some(value) = assigned_literal(rest)
        {
            out.insert(name, value);
        }
    }
    out
}

pub(crate) fn file_properties(build_dir: &Path) -> BTreeMap<String, String> {
    let text = std::fs::read_to_string(build_dir.join("gradle.properties")).unwrap_or_default();
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with(['#', '!']) {
                return None;
            }
            let separator = line.find(|c: char| c == '=' || c == ':' || c.is_whitespace())?;
            let (key, rest) = line.split_at(separator);
            let value = rest.trim_start().trim_start_matches(['=', ':']).trim_start();
            (!key.is_empty()).then(|| (key.to_owned(), value.to_owned()))
        })
        .collect()
}

/// The build script of a project and, recursively, the scripts it applies with `apply from`,
/// read from disk: absolute path and text. Targets that do not exist are skipped.
pub fn scripts_of(root: &Path, project_dir: &Path, build_dir: &Path, build_file: &Path) -> Vec<(PathBuf, String)> {
    const MAX_SCRIPTS: usize = 256;
    const MAX_DEPTH: usize = 32;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let first = normalize(&root.join(build_file));
    let Ok(identity) = dunce::canonicalize(&first) else { return out };
    seen.insert(identity);
    let mut stack = vec![(first, 0)];
    while let Some((path, depth)) = stack.pop() {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        if depth < MAX_DEPTH {
            let mut targets = Vec::new();
            for spec in applied_scripts(&text) {
                if seen.len() >= MAX_SCRIPTS {
                    break;
                }
                if let Some(target) = resolve_script(&spec, &path, project_dir, build_dir)
                    && let Ok(identity) = dunce::canonicalize(&target)
                    && seen.insert(identity)
                {
                    targets.push((target, depth + 1));
                }
            }
            stack.extend(targets.into_iter().rev());
        }
        out.push((path, text));
    }
    out
}

/// Relative targets are project-scoped, with a lenient fallback beside the applying script.
fn resolve_script(spec: &str, script: &Path, project_dir: &Path, build_dir: &Path) -> Option<PathBuf> {
    let spec = spec.trim();
    if spec.contains("://") {
        return None;
    }
    let properties = BTreeMap::from([
        ("rootDir".into(), build_dir.to_string_lossy().into_owned()),
        ("rootProject.projectDir".into(), build_dir.to_string_lossy().into_owned()),
        ("projectDir".into(), project_dir.to_string_lossy().into_owned()),
    ]);
    let spec = interpolate(spec, &properties);
    if spec.contains('$') {
        return None;
    }
    let path = Path::new(&spec);
    if path.is_absolute() {
        return path.is_file().then(|| normalize(path));
    }
    let project_path = normalize(&project_dir.join(path));
    if project_path.is_file() {
        return Some(project_path);
    }
    let path = normalize(&script.parent()?.join(path));
    path.is_file().then_some(path)
}

pub(crate) fn project_build_dir(root: &Path, model: &GradleModel, project: &GradleProject) -> PathBuf {
    let dir = project.build.as_ref().and_then(|build| model.projects.iter().find(|p| &p.path == build));
    root.join(dir.map_or(&model.dir, |p| &p.dir))
}

/// `2.8.9` for `${gsonVersion}` / `$gsonVersion` / `${ext.gsonVersion}`; unknown names and
/// expressions are left as written, so ranges and catalogs stay skipped.
fn interpolate(value: &str, properties: &BTreeMap<String, String>) -> String {
    if !value.contains('$') {
        return value.to_owned();
    }
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        let braced = chars.peek() == Some(&'{');
        if braced {
            chars.next();
        }
        let mut name = String::new();
        if braced {
            for n in chars.by_ref() {
                if n == '}' {
                    break;
                }
                name.push(n);
            }
        } else {
            while let Some(&n) = chars.peek() {
                if n.is_alphanumeric() || n == '_' || n == '.' {
                    name.push(n);
                    chars.next();
                } else {
                    break;
                }
            }
        }
        let key = name.strip_prefix("ext.").or_else(|| name.strip_prefix("extra.")).unwrap_or(&name);
        let bracket = name.strip_prefix("ext[").or_else(|| name.strip_prefix("extra[")).and_then(|rest| {
            let (key, used) = literal(rest.trim_start())?;
            (rest.trim_start()[used..].trim() == "]").then_some(key)
        });
        match properties.get(bracket.as_deref().unwrap_or(key)) {
            Some(v) if !name.is_empty() => out.push_str(v),
            _ => {
                out.push('$');
                if braced {
                    out.push('{');
                }
                out.push_str(&name);
                if braced {
                    out.push('}');
                }
            }
        }
    }
    out
}

/// Whether `index` starts a whole word in `text` (not `reapply`, `my.apply`).
fn starts_word(text: &str, index: usize) -> bool {
    text[..index].chars().next_back().is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == '.'))
}

/// Identifiers outside quoted strings, with their byte positions.
fn code_words(text: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < text.len() {
        let c = text[index..].chars().next().unwrap();
        if c == '"' || c == '\'' {
            index += literal(&text[index..]).map_or(text.len() - index, |(_, used)| used);
        } else if c.is_alphabetic() || c == '_' {
            let (word, _) = identifier(&text[index..]);
            out.push((index, word));
            index += word.len();
        } else {
            index += c.len_utf8();
        }
    }
    out
}

fn identifier(text: &str) -> (&str, &str) {
    let end = text.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(text.len());
    text.split_at(end)
}

fn assigned_literal(text: &str) -> Option<String> {
    let rest = text.trim_start().strip_prefix('=')?.trim_start();
    let (value, used) = literal(rest)?;
    // Do not turn a computed value (`'1.' + suffix`) into a concrete version.
    let tail = rest[used..].trim_start_matches([' ', '\t', '\r']);
    (tail.is_empty() || tail.starts_with(['\n', ';', '}'])).then_some(value)
}

/// The quoted string at the start of `s`, and how many bytes it spans.
fn literal(s: &str) -> Option<(String, usize)> {
    let quote = s.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let rest = &s[quote.len_utf8()..];
    let mut index = 0;
    while index < rest.len() {
        let c = rest[index..].chars().next()?;
        if c == quote {
            return Some((rest[..index].to_owned(), quote.len_utf8() + index + c.len_utf8()));
        }
        if c == '\\' {
            index += c.len_utf8();
            index += rest[index..].chars().next()?.len_utf8();
        } else if quote == '"' && rest[index..].starts_with("${") {
            index += 2;
            index += matching_brace(&rest[index..])? + 1;
        } else {
            index += c.len_utf8();
        }
    }
    None
}

/// Byte index of the `}` closing a `{` that was already consumed, ignoring quoted text.
fn matching_brace(text: &str) -> Option<usize> {
    let mut depth = 1usize;
    let mut index = 0;
    while index < text.len() {
        let c = text[index..].chars().next()?;
        if c == '"' || c == '\'' {
            index += literal(&text[index..])?.1;
            continue;
        }
        if c == '{' {
            depth += 1;
        } else if c == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
        index += c.len_utf8();
    }
    None
}

/// `name = 'value'` pairs in `text`.
fn assignments(text: &str) -> Vec<(String, String)> {
    statements(text)
        .into_iter()
        .filter_map(|statement| {
            let (name, rest) = identifier(statement.trim_start());
            let value = assigned_literal(rest)?;
            (!name.is_empty()).then(|| (name.to_owned(), value))
        })
        .collect()
}

/// Every settings and build script of the model (for change detection).
pub fn build_files(root: &Path, model: &GradleModel) -> Vec<PathBuf> {
    let dir = root.join(&model.dir);
    let mut out: Vec<PathBuf> = SETTINGS_FILES.iter().map(|f| dir.join(f)).filter(|p| p.is_file()).collect();
    out.extend(model.projects.iter().filter_map(|p| p.build_file.as_ref().map(|f| root.join(f))));
    // Scripts a build script applies are build files too: editing one can change the model.
    for project in &model.projects {
        let Some(file) = project.build_file.as_deref() else { continue };
        let build_dir = project_build_dir(root, model, project);
        let properties = build_dir.join("gradle.properties");
        if properties.is_file() {
            out.push(properties);
        }
        let applied = scripts_of(root, &root.join(&project.dir), &build_dir, Path::new(file));
        out.extend(applied.into_iter().skip(1).map(|(path, _)| path));
    }
    // The settings of each nested build (its root project's folder).
    for p in model.projects.iter().filter(|p| p.build.as_deref() == Some(p.path.as_str())) {
        let nested = root.join(&p.dir);
        out.extend(SETTINGS_FILES.iter().map(|f| nested.join(f)).filter(|f| f.is_file()));
    }
    // What IDEA's auto-import also watches: properties, the wrapper and version catalogs.
    let extra = ["gradle.properties", "gradle/wrapper/gradle-wrapper.properties"].map(|f| dir.join(f));
    out.extend(extra.into_iter().filter(|p| p.is_file()));
    if let Ok(entries) = std::fs::read_dir(dir.join("gradle")) {
        let mut catalogs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.to_string_lossy().ends_with(".versions.toml") && p.is_file())
            .collect();
        catalogs.sort();
        out.extend(catalogs);
    }
    out.sort();
    out.dedup();
    out
}

/// A build script without comments and with whitespace runs collapsed, so editing a
/// comment or reformatting does not make a sync stale (IDEA hashes lexer tokens alike).
pub(crate) fn script_fingerprint(text: &str) -> String {
    strip_comments(text).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `(project path, task)` from `gradle tasks --all` console output; tasks listed as
/// `app:run` belong to `:app`, unqualified ones to the root project `:`.
pub fn parse_tasks(output: &str) -> Vec<(String, GradleTask)> {
    let lines: Vec<&str> = output.lines().collect();
    let mut out = Vec::new();
    let mut group: Option<String> = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim_end();
        let underline = lines.get(i + 1).map(|l| l.trim_end()).unwrap_or_default();
        if !line.is_empty() && underline.len() >= 3 && underline.chars().all(|c| c == '-') && !line.starts_with('-') {
            group = line.strip_suffix(" tasks").map(str::to_lowercase);
            i += 2;
            continue;
        }
        if line.is_empty() {
            group = None;
            i += 1;
            continue;
        }
        if let Some(g) = &group {
            let (name, description) = match line.split_once(" - ") {
                Some((n, d)) => (n.trim(), Some(d.trim().to_owned())),
                None => (line.trim(), None),
            };
            if !name.is_empty() && !name.contains(char::is_whitespace) {
                let (project, task_name) = match name.rsplit_once(':') {
                    Some((p, t)) => (format!(":{}", p.trim_start_matches(':')), t),
                    None => (":".to_owned(), name),
                };
                out.push((project, GradleTask { name: task_name.to_owned(), group: g.clone(), description }));
            }
        }
        i += 1;
    }
    out
}

/// Static fallback until Gradle has reported its tasks.
pub(crate) fn has_war_plugin(script: &str) -> bool {
    let script = strip_comments(script);
    script.split(|c: char| !c.is_alphanumeric() && c != '_').any(|word| word == "war")
}

#[cfg(test)]
mod tests {
    #[test]
    fn default_linkage_discovers_all_shallow_builds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for file in [
            "Cargo.toml",
            "package.json",
            "fixtures/kotlin-gradle/settings.gradle.kts",
            "fixtures/kotlin-gradle/build.gradle.kts",
            "fixtures/kotlin-gradle/tools/settings.gradle",
            "services/backend/api/settings.gradle",
            "standalone/build.gradle",
            "ignored/src/settings.gradle",
            "ignored/out/build.gradle",
            "node_modules/example/settings.gradle",
            "target/example/build.gradle",
            "build/example/settings.gradle",
            "dist/example/build.gradle",
            "vendor/example/settings.gradle",
            ".hidden/settings.gradle",
            "too/deep/to/find/settings.gradle",
        ] {
            let path = root.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
        let models = super::load_linked(root, &Default::default());
        assert_eq!(
            models.iter().map(|m| m.dir.as_str()).collect::<Vec<_>>(),
            ["fixtures/kotlin-gradle", "ignored/src", "services/backend/api", "standalone"]
        );
        std::fs::write(root.join("build.gradle.kts"), "").unwrap();
        let models = super::load_linked(root, &Default::default());
        assert_eq!(models.len(), 1);
        assert!(models[0].dir.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn default_linkage_does_not_follow_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir(root.join("real")).unwrap();
        std::fs::write(root.join("real/build.gradle"), "").unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();
        let models = super::load_linked(root, &Default::default());
        assert_eq!(models.iter().map(|m| m.dir.as_str()).collect::<Vec<_>>(), ["real"]);
    }

    #[test]
    fn a_path_from_the_ui_finds_the_saved_link() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let external = temp.path().join("external");
        for dir in [root.join("a"), external.clone()] {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("settings.gradle"), "").unwrap();
        }
        let native = |p: &std::path::Path| p.to_string_lossy().into_owned();
        // Saved by linking; unlinking may send a native, absolute or non-canonical spelling.
        for (dir, sent) in [
            ("a", native(&root.join("a"))),
            ("a", "a".to_owned()),
            ("a", native(&root.join("a").join("..").join("a"))),
            ("../external", native(&external)),
        ] {
            let saved = super::normalize_linked_projects(&root, &[dir.into()]).unwrap();
            assert_eq!(super::linked_project_key(&root, &sent), saved[0], "{sent}");
        }
        // A folder deleted since it was linked still matches its saved entry.
        assert_eq!(super::linked_project_key(&root, r"gone\build"), "gone/build");
    }

    #[test]
    fn explicit_linkage_preserves_default_discovery_and_can_unlink_every_build() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in ["a", "b"] {
            std::fs::create_dir(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("settings.gradle"), format!("rootProject.name = '{dir}'")).unwrap();
        }
        assert_eq!(
            super::load_linked(root, &Default::default()).iter().map(|m| m.dir.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        let mut settings = ide_core::settings::GradleSettings {
            linked_projects: Some(vec!["b".into(), "./b".into(), "a".into()]),
            ..Default::default()
        };
        let models = super::load_linked(root, &settings);
        assert_eq!(models.iter().map(|g| g.dir.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        settings.linked_projects = Some(vec![]);
        assert!(super::load_linked(root, &settings).is_empty());
        assert!(super::normalize_linked_projects(root, &["missing".into()]).is_err());
        assert!(super::normalize_linked_projects(root, &["".into()]).is_err());
        assert!(super::load_build(root, root).is_none(), "exact loading never picks a child");
    }

    #[cfg(unix)]
    #[test]
    fn linked_directories_deduplicate_symlinks_and_keep_external_builds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let external = temp.path().join("external");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&external).unwrap();
        std::fs::write(external.join("build.gradle"), "").unwrap();
        std::os::unix::fs::symlink(&external, root.join("alias")).unwrap();
        let dirs = super::normalize_linked_projects(&root, &["alias".into(), "../external".into()]).unwrap();
        assert_eq!(dirs, [external.canonicalize().unwrap().to_string_lossy().to_string()]);
    }
    #[test]
    fn script_dependencies_read_string_and_map_notations() {
        let script = r#"
plugins { id 'java' }
dependencies {
    implementation 'com.google.guava:guava:33.0.0-jre'
    api("org.slf4j:slf4j-api:2.0.9")
    testImplementation "junit:junit:4.13.2@jar"
    // implementation 'commented:out:1.0'
    compileOnly group: 'org.projectlombok', name: 'lombok', version: '1.18.30'
    runtimeOnly(group = "com.h2database", name = "h2", version = "2.2.224")
    implementation "org.x:dyn:${ver}"
    implementation 'org.x:range:1.+'
    implementation libs.okhttp
    implementation project(':core')
    classpath 'not:a:library'
}
"#;
        let deps = script_dependencies(script, &BTreeMap::new());
        let names: Vec<String> = deps.iter().map(|(g, a, v)| format!("{g}:{a}:{v}")).collect();
        assert_eq!(
            names,
            [
                "com.google.guava:guava:33.0.0-jre",
                "org.slf4j:slf4j-api:2.0.9",
                "junit:junit:4.13.2",
                "org.projectlombok:lombok:1.18.30",
                "com.h2database:h2:2.2.224",
            ]
        );
    }

    #[test]
    fn applied_scripts_read_groovy_and_kotlin_forms() {
        let script = r#"
            apply plugin: 'java'
            apply from: 'gradle/dependencies.gradle'
            apply from: file('gradle/extra.gradle')
            apply(from = "gradle/kotlin.gradle.kts")
            apply(from = file("gradle/kotlin-file.gradle.kts"))
            // apply from: 'commented.gradle'
            reapply from: 'not-a-call.gradle'
        "#;
        assert_eq!(
            applied_scripts(script),
            [
                "gradle/dependencies.gradle",
                "gradle/extra.gradle",
                "gradle/kotlin.gradle.kts",
                "gradle/kotlin-file.gradle.kts"
            ]
        );
    }

    #[test]
    fn ext_values_fill_in_dependency_versions() {
        let script = r#"
            ext {
                gsonVersion = '2.8.9'
                junit = "4.13.2"
            }
            ext.logback = '1.4.14'
            dependencies {
                implementation "com.google.code.gson:gson:${gsonVersion}"
                testImplementation "junit:junit:$junit"
                implementation "ch.qos.logback:logback-classic:${ext.logback}"
                implementation 'org.plain:literal:1.0'
                implementation "org.x:unknown:${missing}"
            }
        "#;
        let names: Vec<String> = script_dependencies(script, &script_properties(script))
            .into_iter()
            .map(|(g, a, v)| format!("{g}:{a}:{v}"))
            .collect();
        assert_eq!(
            names,
            [
                "com.google.code.gson:gson:2.8.9",
                "junit:junit:4.13.2",
                "ch.qos.logback:logback-classic:1.4.14",
                "org.plain:literal:1.0",
            ]
        );
    }

    #[test]
    fn extra_properties_support_brackets_and_kotlin_delegates() {
        for declaration in [
            "ext.x = '1.2'",
            "ext { x = '1.2' }",
            "ext[\"x\"] = '1.2'",
            "extra[\"x\"] = \"1.2\"",
            "val x by extra(\"1.2\")",
        ] {
            let script = format!("{declaration}\ndependencies {{ implementation \"g:a:${{x}}\" }}");
            assert_eq!(
                script_dependencies(&script, &script_properties(&script)),
                [("g".into(), "a".into(), "1.2".into())],
                "{declaration}"
            );
        }
    }

    #[test]
    fn parsers_ignore_apply_and_ext_inside_strings() {
        let script = r#"
            println "apply from: 'fake.gradle'"
            println "ext.x = 'bogus'"
            ext.real = '1'
        "#;
        assert!(applied_scripts(script).is_empty());
        assert_eq!(script_properties(script), BTreeMap::from([("real".into(), "1".into())]));
    }

    #[test]
    fn dependency_statements_preserve_interpolation_and_escaped_quotes() {
        let script = r#"dependencies { implementation "g:a:${v}"; api(group = "g", name = "b", version = "${v}-RC1") }; dependencies { runtimeOnly 'g:c:2' }"#;
        let properties = BTreeMap::from([("v".into(), "1.2".into())]);
        assert_eq!(
            script_dependencies(script, &properties),
            [
                ("g".into(), "a".into(), "1.2".into()),
                ("g".into(), "b".into(), "1.2-RC1".into()),
                ("g".into(), "c".into(), "2".into())
            ]
        );
        assert_eq!(
            statements(r#"println "escaped\"; {still quoted}"; implementation 'g:a:1'"#),
            [r#"println "escaped\"; {still quoted}""#, " implementation 'g:a:1'"]
        );
    }

    #[test]
    fn dependency_versions_skip_unresolved_names_and_expressions() {
        let script = r#"dependencies {
            implementation "g:missing:${unknown}"
            implementation "g:expression:${1 + 2}"
            implementation "g:cyclic:${cycle}"
            implementation 'g:range:[1,2)'
            implementation 'g:dynamic:1.+'
        }"#;
        let properties = BTreeMap::from([("cycle".into(), "${cycle}".into())]);
        assert!(script_dependencies(script, &properties).is_empty());
    }

    #[test]
    fn extra_property_references_support_qualified_and_bracket_access() {
        let script = r#"dependencies {
            implementation "g:a:${ext.x}"
            implementation "g:b:${extra.x}"
            implementation "g:c:${ext['x']}"
            implementation "g:d:${extra["x"]}"
        }"#;
        let properties = BTreeMap::from([("x".into(), "1".into())]);
        assert_eq!(script_dependencies(script, &properties).len(), 4);
    }

    #[test]
    fn applied_scripts_are_read_recursively_and_survive_cycles() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("gradle")).unwrap();
        std::fs::write(root.join("build.gradle"), "apply from: 'gradle/deps.gradle'\n").unwrap();
        std::fs::write(root.join("gradle/deps.gradle"), "apply from: '$rootDir/gradle/more.gradle'\n").unwrap();
        std::fs::write(root.join("gradle/more.gradle"), "apply from: 'deps.gradle'\n").unwrap();

        let scripts: Vec<String> = scripts_of(root, root, root, Path::new("build.gradle"))
            .into_iter()
            .map(|(path, _)| path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(scripts, ["build.gradle", "gradle/deps.gradle", "gradle/more.gradle"]);
        assert_eq!(build_files(root, &load(root).unwrap()).len(), 3);
    }

    #[test]
    fn applied_paths_prefer_the_project_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("gradle")).unwrap();
        std::fs::write(root.join("build.gradle"), "apply from: 'gradle/deps.gradle'").unwrap();
        std::fs::write(root.join("gradle/deps.gradle"), "apply from: 'versions.gradle'").unwrap();
        std::fs::write(root.join("versions.gradle"), "right").unwrap();
        std::fs::write(root.join("gradle/versions.gradle"), "wrong").unwrap();
        let scripts = scripts_of(root, root, root, Path::new("build.gradle"));
        assert_eq!(scripts.len(), 3);
        assert_eq!(scripts[2].1, "right");
    }

    #[test]
    fn nested_applied_paths_are_relative_to_the_project_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("gradle")).unwrap();
        std::fs::write(root.join("build.gradle"), "apply from: 'gradle/a.gradle'").unwrap();
        std::fs::write(root.join("gradle/a.gradle"), "apply from: 'gradle/b.gradle'").unwrap();
        std::fs::write(root.join("gradle/b.gradle"), "").unwrap();
        let scripts = scripts_of(root, root, root, Path::new("build.gradle"));
        assert_eq!(scripts.len(), 3);
        assert_eq!(scripts[2].0, root.join("gradle/b.gradle"));
    }

    #[test]
    fn applied_paths_fall_back_to_the_applying_script_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("gradle")).unwrap();
        std::fs::write(root.join("build.gradle"), "apply from: 'gradle/a.gradle'").unwrap();
        std::fs::write(root.join("gradle/a.gradle"), "apply from: 'c.gradle'").unwrap();
        std::fs::write(root.join("gradle/c.gradle"), "").unwrap();
        let scripts = scripts_of(root, root, root, Path::new("build.gradle"));
        assert_eq!(scripts.len(), 3);
        assert_eq!(scripts[2].0, root.join("gradle/c.gradle"));
    }

    #[test]
    fn applied_paths_resolve_gradle_directory_variables() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let project = root.join("app");
        let script = project.join("gradle/deps.gradle");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(root.join("shared.gradle"), "").unwrap();
        std::fs::write(project.join("local.gradle"), "").unwrap();
        for prefix in ["$rootDir", "${rootDir}", "$rootProject.projectDir", "${rootProject.projectDir}"] {
            assert_eq!(
                resolve_script(&format!("{prefix}/shared.gradle"), &script, &project, root),
                Some(root.join("shared.gradle")),
                "{prefix}"
            );
        }
        for prefix in ["$projectDir", "${projectDir}"] {
            assert_eq!(
                resolve_script(&format!("{prefix}/local.gradle"), &script, &project, root),
                Some(project.join("local.gradle")),
                "{prefix}"
            );
        }
        assert_eq!(
            resolve_script(root.join("shared.gradle").to_str().unwrap(), &script, &project, root),
            Some(root.join("shared.gradle"))
        );
    }

    #[test]
    fn applied_scripts_skip_urls_and_missing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Even a local path resembling a URL must not be read.
        if !cfg!(windows) {
            for scheme in ["http", "https"] {
                let local = root.join(format!("{scheme}:/example.com/deps.gradle"));
                std::fs::create_dir_all(local.parent().unwrap()).unwrap();
                std::fs::write(local, "implementation 'g:remote:1'").unwrap();
            }
        }
        std::fs::write(root.join("build.gradle"), "apply from: 'http://example.com/deps.gradle'\napply(from = \"https://example.com/deps.gradle\")\napply from: 'missing.gradle'").unwrap();
        assert_eq!(scripts_of(root, root, root, Path::new("build.gradle")).len(), 1);
    }

    #[test]
    fn applied_scripts_deduplicate_self_application_and_path_aliases() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("gradle")).unwrap();
        std::fs::write(
            root.join("build.gradle"),
            "apply from: 'build.gradle'\napply from: 'gradle/../build.gradle'\napply from: 'gradle/a.gradle'",
        )
        .unwrap();
        std::fs::write(root.join("gradle/a.gradle"), "apply from: '../build.gradle'").unwrap();
        assert_eq!(scripts_of(root, root, root, Path::new("build.gradle")).len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn applied_scripts_deduplicate_symlink_cycles() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("build.gradle"), "apply from: 'alias/build.gradle'").unwrap();
        std::os::unix::fs::symlink(root, root.join("alias")).unwrap();
        assert_eq!(scripts_of(root, root, root, Path::new("build.gradle")).len(), 1);
    }

    #[test]
    fn applied_script_traversal_bounds_depth_and_total_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for i in 0..300 {
            std::fs::write(root.join(format!("{i}.gradle")), format!("apply from: '{}.gradle'", i + 1)).unwrap();
        }
        let chain = scripts_of(root, root, root, Path::new("0.gradle"));
        assert_eq!(chain.len(), 33);
        let fanout: String = (0..300).map(|i| format!("apply from: '{i}.gradle'\n")).collect();
        std::fs::write(root.join("build.gradle"), fanout).unwrap();
        assert_eq!(scripts_of(root, root, root, Path::new("build.gradle")).len(), 256);
    }

    #[test]
    fn applied_scripts_use_their_composite_build_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("included/app")).unwrap();
        std::fs::write(root.join("build.gradle"), "").unwrap();
        std::fs::write(root.join("included/build.gradle"), "").unwrap();
        std::fs::write(root.join("included/app/build.gradle"), "apply from: \"${rootDir}/deps.gradle\"").unwrap();
        std::fs::write(root.join("included/deps.gradle"), "implementation 'g:included:1'").unwrap();
        let mut model = load(root).unwrap();
        for (path, dir) in [(":included", "included"), (":included:app", "included/app")] {
            let mut project = project_at(root, path.into(), path.into(), &root.join(dir));
            project.build = Some(":included".into());
            model.projects.push(project);
        }
        assert!(build_files(root, &model).contains(&root.join("included/deps.gradle")));
        let model = crate::BuildModel { maven: None, gradle: vec![model] };
        assert_eq!(crate::dependency_coordinates(root, &model)[0].artifact_id, "included");
    }

    use super::*;

    #[test]
    fn settings_scripts() {
        let kts = r#"
            // include("commented")
            rootProject.name = "gradle-demo"
            include("app", "lib")
            include(":libs:core")
            /* include("block") */
            includeBuild("plugins")
        "#;
        let s = parse_settings(kts);
        assert_eq!(s.name.as_deref(), Some("gradle-demo"));
        assert_eq!(s.includes, [":app", ":lib", ":libs:core"]);
        assert!(s.dirs.is_empty());

        let groovy = "rootProject.name = 'demo'\ninclude 'a',\n        'b'\ninclude ':c'\nprintln 'x'\n";
        let s = parse_settings(groovy);
        assert_eq!(s.name.as_deref(), Some("demo"));
        assert_eq!(s.includes, [":a", ":b", ":c"]);
    }

    #[test]
    fn settings_include_flat_and_project_dirs() {
        let groovy = r#"
            includeFlat 'svc-a'
            includeFlat 'svc-b', 'svc-c' // trailing comment
            ['x', 'y'].each { m -> include ":svc-a:$m" }
            include ':wo'
            project(':wo').projectDir = file('../svc-a/.worktrees/wo')
            project(":dyn").projectDir = file("${rootDir}/dyn")
            includeFlated 'not-a-call'
        "#;
        let s = parse_settings(groovy);
        assert_eq!(s.includes, [":svc-a", ":svc-b", ":svc-c", ":wo"]);
        assert_eq!(
            s.dirs.into_iter().collect::<Vec<_>>(),
            [
                (":svc-a".into(), "../svc-a".into()),
                (":svc-b".into(), "../svc-b".into()),
                (":svc-c".into(), "../svc-c".into()),
                (":wo".into(), "../svc-a/.worktrees/wo".into()),
            ]
        );

        let kts = "includeFlat(\"k\")\nproject(\":k\").projectDir = file(\"../other\")";
        let s = parse_settings(kts);
        assert_eq!(s.includes, [":k"]);
        assert_eq!(s.dirs.get(":k").map(String::as_str), Some("../other"));
    }

    #[test]
    fn loads_include_flat_siblings() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        std::fs::create_dir_all(ws.join("root")).unwrap();
        std::fs::create_dir_all(ws.join("svc")).unwrap();
        std::fs::write(ws.join("root/settings.gradle"), "rootProject.name = 'Root'\nincludeFlat 'svc'").unwrap();
        std::fs::write(ws.join("svc/build.gradle"), "plugins { id 'java' }").unwrap();
        let root = ws.join("root");
        let m = load(&root).unwrap();
        let svc = m.projects.iter().find(|p| p.path == ":svc").unwrap();
        assert_eq!(Path::new(&svc.dir), ws.join("svc"));
        assert_eq!(svc.build_file.as_deref().map(Path::new), Some(ws.join("svc/build.gradle").as_path()));
        assert!(root.join(svc.build_file.as_ref().unwrap()).is_file());
    }

    #[test]
    fn task_list_output() {
        let out = "\
------------------------------------------------------------
Tasks runnable from root project 'gradle-demo'
------------------------------------------------------------

Application tasks
-----------------
app:run - Runs this project as a JVM application

Build Setup tasks
-----------------
init - Initializes a new Gradle build.
wrapper - Generates Gradle wrapper files.

Other tasks
-----------
app:compileJava - Compiles main Java source.
prepareKotlinBuildScriptModel
libs:core:jar

Rules
-----
Pattern: clean<TaskName>: Cleans the output files of a task.
";
        let tasks = parse_tasks(out);
        let flat: Vec<(&str, &str, &str, Option<&str>)> = tasks
            .iter()
            .map(|(p, t)| (p.as_str(), t.group.as_str(), t.name.as_str(), t.description.as_deref()))
            .collect();
        assert_eq!(
            flat,
            [
                (":app", "application", "run", Some("Runs this project as a JVM application")),
                (":", "build setup", "init", Some("Initializes a new Gradle build.")),
                (":", "build setup", "wrapper", Some("Generates Gradle wrapper files.")),
                (":app", "other", "compileJava", Some("Compiles main Java source.")),
                (":", "other", "prepareKotlinBuildScriptModel", None),
                (":libs:core", "other", "jar", None),
            ]
        );
    }

    #[test]
    fn loads_projects_and_default_tasks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("settings.gradle.kts"), "rootProject.name = \"demo\"\ninclude(\"app\")").unwrap();
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app/build.gradle.kts"), "plugins { application }").unwrap();
        let wrapper = if cfg!(windows) { "gradlew.bat" } else { "gradlew" };
        std::fs::write(root.join(wrapper), "#!/bin/sh").unwrap();
        let m = load(root).unwrap();
        assert_eq!(m.dir, "");
        let ps: Vec<(&str, &str, &str, Option<&str>)> = m
            .projects
            .iter()
            .map(|p| (p.path.as_str(), p.name.as_str(), p.dir.as_str(), p.build_file.as_deref()))
            .collect();
        assert_eq!(ps, [(":", "demo", "", None), (":app", "app", "app", Some("app/build.gradle.kts"))]);
        assert!(m.projects[0].tasks.iter().any(|t| t.name == "wrapper"));
        assert!(!m.projects[0].tasks.iter().any(|t| t.name == "build"));
        assert!(m.projects[1].tasks.iter().any(|t| t.name == "run" && t.group == "application"));
        assert!(m.command.ends_with(wrapper));
        assert_eq!(build_files(root, &m).len(), 2);
        assert_eq!(m.java_version, None);
        assert_eq!(
            script_java_version("java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }"),
            Some(21)
        );
        assert_eq!(script_java_version("sourceCompatibility = JavaVersion.VERSION_1_8"), Some(8));
        assert_eq!(script_java_version("kotlin { jvmToolchain(17) }"), Some(17));
        assert_eq!(script_java_version("sourceCompatibility = '11'"), Some(11));

        let none = tempfile::tempdir().unwrap();
        assert!(load(none.path()).is_none());
    }

    #[test]
    fn merges_included_builds_and_build_src_by_identity_path() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        for d in ["shop/app", "shop/buildSrc", "lib/core"] {
            std::fs::create_dir_all(ws.join(d)).unwrap();
        }
        std::fs::write(ws.join("shop/settings.gradle"), "rootProject.name = 'shop'\ninclude 'app'").unwrap();
        std::fs::write(ws.join("lib/settings.gradle"), "include 'core'").unwrap();
        let root = ws.join("shop");
        // In evaluation order, as the init script prints it: nested builds first.
        let line = |path: &str, d: &str, build: Option<&str>| {
            let project = ReportedProject {
                path: path.into(),
                dir: ws.join(d).to_string_lossy().into_owned(),
                build: build.map(Into::into),
                ..ReportedProject::default()
            };
            format!("{MODEL_LINE}{}\n", serde_json::to_string(&project).unwrap())
        };
        let out = [
            line(":lib", "lib", Some(":lib")),
            line(":lib:core", "lib/core", Some(":lib")),
            line(":buildSrc", "shop/buildSrc", Some(":buildSrc")),
            line(":", "shop", None),
            line(":app", "shop/app", None),
        ]
        .concat();
        let mut model = load(&root).unwrap();
        merge_reported_projects(&root, &mut model, &parse_reported_projects(&out));
        let projects: Vec<_> =
            model.projects.iter().map(|p| (p.path.as_str(), p.name.as_str(), p.build.as_deref())).collect();
        assert_eq!(
            projects,
            [
                (":", "shop", None),
                (":app", "app", None),
                (":buildSrc", "buildSrc", Some(":buildSrc")),
                (":lib", "lib", Some(":lib")),
                (":lib:core", "core", Some(":lib")),
            ]
        );
        let build_src = &model.projects[2];
        assert!(build_src.tasks.is_empty(), "buildSrc tasks cannot run from the root build");
        assert!(!model.projects[4].tasks.is_empty());
        assert!(build_files(&root, &model).contains(&ws.join("lib/settings.gradle")));
    }
}
