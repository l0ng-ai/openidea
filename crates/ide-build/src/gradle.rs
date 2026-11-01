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
    /// Gradle path: `:` for the root project, `:app`, `:libs:core`.
    pub path: String,
    pub name: String,
    /// Project-relative directory.
    pub dir: String,
    /// Project-relative build script, if any.
    pub build_file: Option<String>,
    pub tasks: Vec<GradleTask>,
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
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            out.push(chars.by_ref().take_while(|&n| n != c).collect());
        }
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

/// The directory of the Gradle build under `root`: the root itself, or a direct
/// subfolder, holding a settings or build script.
pub fn build_dir(root: &Path) -> Option<PathBuf> {
    let has = |d: &Path| SETTINGS_FILES.iter().chain(BUILD_FILES).any(|f| d.join(f).is_file());
    if has(root) {
        return Some(root.to_path_buf());
    }
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    dirs.into_iter().find(|d| SETTINGS_FILES.iter().any(|f| d.join(f).is_file()))
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
    GradleProject { build_file: script.map(|(n, _)| rel(root, &pdir.join(n))), dir: rel(root, pdir), path, name, tasks }
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
            project_at(root, p.path.clone(), name, Path::new(&p.dir))
        })
        .collect();
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
/// Versions with interpolations, ranges and catalog aliases (`libs.x`) are skipped.
pub fn script_dependencies(text: &str) -> Vec<(String, String, String)> {
    let text = strip_comments(text);
    let mut out = Vec::new();
    for line in text.lines().flat_map(|l| l.split(['{', ';'])) {
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

/// Every settings and build script of the model (for change detection).
pub fn build_files(root: &Path, model: &GradleModel) -> Vec<PathBuf> {
    let dir = root.join(&model.dir);
    let mut out: Vec<PathBuf> = SETTINGS_FILES.iter().map(|f| dir.join(f)).filter(|p| p.is_file()).collect();
    out.extend(model.projects.iter().filter_map(|p| p.build_file.as_ref().map(|f| root.join(f))));
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
        let deps = script_dependencies(script);
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
}
