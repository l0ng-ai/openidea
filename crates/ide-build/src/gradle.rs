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

/// `(root project name, included project paths)` from a settings script.
pub fn parse_settings(text: &str) -> (Option<String>, Vec<String>) {
    let text = strip_comments(text);
    let mut name = None;
    let mut includes: Vec<String> = Vec::new();
    for (i, _) in text.match_indices("rootProject.name") {
        let line = text[i + "rootProject.name".len()..].lines().next().unwrap_or_default();
        if let Some(n) = literals(line).into_iter().next() {
            name = Some(n);
        }
    }
    let mut from = 0;
    while let Some(i) = text[from..].find("include") {
        let at = from + i;
        from = at + "include".len();
        let before_ok = at == 0 || !text[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.');
        let after = &text[from..];
        let after_ok = after.starts_with(|c: char| c == '(' || c.is_whitespace());
        if !before_ok || !after_ok {
            continue;
        }
        for p in include_args(after) {
            let path = if p.starts_with(':') { p } else { format!(":{p}") };
            if path.len() > 1 && !includes.contains(&path) {
                includes.push(path);
            }
        }
    }
    (name, includes)
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
pub fn load(root: &Path) -> Option<GradleModel> {
    let dir = build_dir(root)?;
    let read = |d: &Path, names: &[&str]| {
        names.iter().find_map(|n| std::fs::read_to_string(d.join(n)).ok().map(|t| (n.to_string(), t)))
    };
    let (name, includes) = read(&dir, SETTINGS_FILES).map(|(_, t)| parse_settings(&t)).unwrap_or_default();
    let root_name =
        name.unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    let mut projects = Vec::new();
    let mut add = |path: String, name: String, pdir: PathBuf| {
        let script = read(&pdir, BUILD_FILES);
        let tasks = default_tasks(path == ":", script.as_ref().map(|(_, t)| t.as_str()).unwrap_or_default());
        projects.push(GradleProject {
            build_file: script.map(|(n, _)| rel(root, &pdir.join(n))),
            dir: rel(root, &pdir),
            path,
            name,
            tasks,
        });
    };
    add(":".into(), root_name, dir.clone());
    for path in includes {
        let pdir = dir.join(path.trim_start_matches(':').replace(':', "/"));
        let name = path.rsplit(':').next().unwrap_or_default().to_owned();
        add(path, name, pdir);
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
    out
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
        let (name, includes) = parse_settings(kts);
        assert_eq!(name.as_deref(), Some("gradle-demo"));
        assert_eq!(includes, [":app", ":lib", ":libs:core"]);

        let groovy = "rootProject.name = 'demo'\ninclude 'a',\n        'b'\ninclude ':c'\nprintln 'x'\n";
        let (name, includes) = parse_settings(groovy);
        assert_eq!(name.as_deref(), Some("demo"));
        assert_eq!(includes, [":a", ":b", ":c"]);
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
