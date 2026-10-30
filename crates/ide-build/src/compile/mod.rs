//! Build › Build Project / Rebuild / Build Module / Build Artifacts: picks the
//! build system of the project (or of the file's module), runs it in the
//! background with cancellation and parses the compiler output into messages
//! for the Build tool window, the Problems view and the editor.

mod parse;

use crate::process::{self, Stream};
use crate::{BuildModel, maven};
use ide_core::{CancellationToken, Diagnostic, IdeError, IdeResult, Pos, Range, Severity};
use parse::{ColUnit, Format, OutputParser, RawMessage};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Diagnostics source of build messages in the Problems view and the editor.
pub const DIAGNOSTICS_SOURCE: &str = "build";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BuildKind {
    /// Incremental compile of sources and tests.
    Build,
    /// Clean, then build.
    Rebuild,
    /// Package the outputs (`package`, `assemble`, `cargo build --release`, `npm run build`).
    Artifacts,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BuildSystem {
    Maven,
    Gradle,
    Cargo,
    Go,
    #[serde(rename = "typescript")]
    TypeScript,
}

/// One command of a build.
#[derive(Clone, Debug, PartialEq)]
pub struct BuildStep {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    format: Format,
}

impl BuildStep {
    fn new(program: impl Into<String>, args: &[&str], cwd: &Path, format: Format) -> Self {
        BuildStep {
            program: program.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            cwd: cwd.to_path_buf(),
            env: BTreeMap::new(),
            format,
        }
    }

    /// The command line as echoed in the console.
    pub fn display(&self) -> String {
        let program = Path::new(&self.program).file_name().map_or(self.program.clone(), |n| n.to_string_lossy().into());
        std::iter::once(program)
            .chain(self.args.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() }))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BuildPlan {
    pub system: BuildSystem,
    /// Tree root title: `demo` / `Build module 'core'`.
    pub title: String,
    pub steps: Vec<BuildStep>,
}

/// A compiler message in IDE coordinates (0-based line, UTF-16 column).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BuildMessage {
    pub severity: Severity,
    pub text: String,
    /// Absolute path; `None` for messages about the build itself.
    pub path: Option<ide_core::IpcPath>,
    pub range: Option<Range>,
    pub code: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BuildEvent {
    /// The build starts: its tree root.
    Started {
        system: BuildSystem,
        title: String,
    },
    /// A command starts (echoed in the console).
    Step {
        command: String,
        cwd: ide_core::IpcPath,
    },
    /// Console output (one or more lines, each ending in `\n`).
    Output {
        text: String,
        stderr: bool,
    },
    Message {
        message: BuildMessage,
    },
    /// Status bar progress; `fraction` 0..1 or `None` when indeterminate.
    Progress {
        message: String,
        fraction: Option<f32>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    pub system: BuildSystem,
    pub title: String,
    pub success: bool,
    pub errors: u32,
    pub warnings: u32,
    pub duration_ms: f64,
    pub messages: Vec<BuildMessage>,
}

// ---------------------------------------------------------------- planning

fn has(dir: &Path, names: &[&str]) -> bool {
    names.iter().any(|n| dir.join(n).is_file())
}

fn detect_dir(dir: &Path, model: &BuildModel, root: &Path) -> Option<BuildSystem> {
    let rel = rel_str(root, dir);
    if model.maven.as_ref().is_some_and(|m| m.projects.iter().any(|p| p.dir == rel)) || has(dir, &["pom.xml"]) {
        Some(BuildSystem::Maven)
    } else if has(dir, &["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]) {
        Some(BuildSystem::Gradle)
    } else if has(dir, &["Cargo.toml"]) {
        Some(BuildSystem::Cargo)
    } else if has(dir, &["go.mod"]) {
        Some(BuildSystem::Go)
    } else if has(dir, &["tsconfig.json", "package.json"]) {
        Some(BuildSystem::TypeScript)
    } else {
        None
    }
}

/// `root/rel`, without a trailing separator for the root itself.
fn subdir(root: &Path, rel: &str) -> PathBuf {
    if rel.is_empty() { root.to_path_buf() } else { root.join(rel) }
}

fn rel_str(root: &Path, dir: &Path) -> String {
    dir.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

/// Directories from `file`'s folder up to `root` (inclusive).
fn ancestors_within<'a>(root: &'a Path, file: &'a Path) -> impl Iterator<Item = &'a Path> {
    let start = if file.is_dir() { Some(file) } else { file.parent() };
    start.into_iter().flat_map(Path::ancestors).take_while(move |d| d.starts_with(root))
}

/// The build of `root`, or of the module containing `file` (Build Module / Recompile).
pub fn plan(root: &Path, model: &BuildModel, kind: BuildKind, file: Option<&Path>) -> IdeResult<BuildPlan> {
    let project_name = root.file_name().map_or_else(|| "project".to_owned(), |n| n.to_string_lossy().into_owned());
    let module_dir = match file {
        Some(f) => {
            let dir = ancestors_within(root, f)
                .find(|d| detect_dir(d, model, root).is_some())
                .ok_or_else(|| IdeError::not_found(format!("{} is not in a module", f.display())))?;
            Some(dir.to_path_buf())
        }
        None => None,
    };
    let dir = module_dir.clone().unwrap_or_else(|| root.to_path_buf());
    let system = detect_dir(&dir, model, root)
        .or_else(|| if model.gradle.is_some() { Some(BuildSystem::Gradle) } else { None })
        .ok_or_else(|| IdeError::not_found("no supported build system (Maven, Gradle, Cargo, Go, TypeScript) found"))?;
    let module = module_dir.as_deref().filter(|d| *d != root);
    let title = match module {
        Some(d) => format!(
            "{}: build module '{}'",
            project_name,
            d.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned())
        ),
        None => project_name,
    };
    let steps = match system {
        BuildSystem::Maven => maven_steps(root, model, kind, module_dir.as_deref())?,
        BuildSystem::Gradle => gradle_steps(root, model, kind, module_dir.as_deref())?,
        BuildSystem::Cargo => cargo_steps(&dir, kind),
        // Go builds the file's package (a module holds many).
        BuildSystem::Go => go_steps(file.and_then(Path::parent).unwrap_or(&dir), kind),
        BuildSystem::TypeScript => ts_steps(&dir, kind),
    };
    Ok(BuildPlan { system, title, steps })
}

fn maven_steps(root: &Path, model: &BuildModel, kind: BuildKind, module: Option<&Path>) -> IdeResult<Vec<BuildStep>> {
    let fallback;
    let m = match &model.maven {
        Some(m) => m,
        None => {
            fallback = maven::load(root);
            &fallback
        }
    };
    let goals: &[&str] = match kind {
        BuildKind::Build => &["test-compile"],
        BuildKind::Rebuild => &["clean", "test-compile"],
        BuildKind::Artifacts => &["package", "-DskipTests"],
    };
    let tops: Vec<&maven::MavenProject> = m.projects.iter().filter(|p| !p.aggregated).collect();
    if tops.is_empty() {
        return Err(IdeError::not_found("no Maven project found"));
    }
    let step = |p: &maven::MavenProject, extra: &[String]| {
        let mut s = BuildStep::new(&p.command, &["-B", "-Dstyle.color=never"], &subdir(root, &p.dir), Format::Maven);
        s.args.extend(p.options.iter().cloned());
        s.args.extend(extra.iter().cloned());
        s.args.extend(goals.iter().map(|g| (*g).to_owned()));
        s.env = p.env.clone();
        s
    };
    let Some(module) = module else { return Ok(tops.iter().map(|p| step(p, &[])).collect()) };
    // The reactor root containing the module builds it with what it depends on (`-pl … -am`).
    let rel = rel_str(root, module);
    if !m.projects.iter().any(|p| p.dir == rel) {
        return Err(IdeError::not_found("no linked Maven project found for module"));
    }
    let top = tops
        .iter()
        .filter(|t| t.dir.is_empty() || rel == t.dir || rel.starts_with(&format!("{}/", t.dir)))
        .max_by_key(|t| t.dir.len())
        .copied()
        .unwrap_or(tops[0]);
    let top_dir = subdir(root, &top.dir);
    if module == top_dir {
        return Ok(vec![step(top, &[])]);
    }
    let pl = module.strip_prefix(&top_dir).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or(rel);
    Ok(vec![step(top, &["-pl".into(), pl, "-am".into()])])
}

fn gradle_steps(root: &Path, model: &BuildModel, kind: BuildKind, module: Option<&Path>) -> IdeResult<Vec<BuildStep>> {
    let fallback;
    let g = match &model.gradle {
        Some(g) => g,
        None => {
            fallback = crate::gradle::load(root).ok_or_else(|| IdeError::not_found("no Gradle build found"))?;
            &fallback
        }
    };
    let prefix = module
        .and_then(|m| {
            let rel = rel_str(root, m);
            g.projects.iter().filter(|p| p.dir == rel).map(|p| p.path.clone()).next()
        })
        .filter(|p| p != ":")
        .map(|p| format!("{p}:"))
        .unwrap_or_default();
    let tasks: Vec<String> = match kind {
        BuildKind::Build => vec![format!("{prefix}classes"), format!("{prefix}testClasses")],
        BuildKind::Rebuild => {
            vec![format!("{prefix}clean"), format!("{prefix}classes"), format!("{prefix}testClasses")]
        }
        BuildKind::Artifacts => vec![format!("{prefix}assemble")],
    };
    let mut s = BuildStep::new(&g.command, &["--console=plain"], &subdir(root, &g.dir), Format::Gradle);
    s.args.extend(tasks);
    s.env = g.env.clone();
    Ok(vec![s])
}

fn cargo_steps(dir: &Path, kind: BuildKind) -> Vec<BuildStep> {
    let build = |release: bool| {
        let mut args = vec!["build", "--all-targets", "--message-format=json"];
        if release {
            args = vec!["build", "--release", "--message-format=json"];
        }
        args.extend(["--manifest-path", "Cargo.toml"]);
        BuildStep::new("cargo", &args, dir, Format::Cargo)
    };
    match kind {
        BuildKind::Build => vec![build(false)],
        BuildKind::Rebuild => {
            vec![BuildStep::new("cargo", &["clean", "--manifest-path", "Cargo.toml"], dir, Format::Cargo), build(false)]
        }
        BuildKind::Artifacts => vec![build(true)],
    }
}

fn go_steps(dir: &Path, kind: BuildKind) -> Vec<BuildStep> {
    let module_root = dir.ancestors().find(|d| d.join("go.mod").is_file()).unwrap_or(dir);
    let target = if module_root == dir { "./...".to_owned() } else { format!("./{}/...", rel_str(module_root, dir)) };
    let mut args = vec!["build"];
    if kind == BuildKind::Rebuild {
        args.push("-a");
    }
    let mut s = BuildStep::new("go", &args, module_root, Format::Go);
    s.args.push(target);
    vec![s]
}

/// `pnpm` / `yarn` / `bun` / `npm`, from the lock file next to `package.json` or above it.
fn package_manager(dir: &Path) -> &'static str {
    for d in dir.ancestors() {
        if d.join("pnpm-lock.yaml").is_file() {
            return "pnpm";
        } else if d.join("yarn.lock").is_file() {
            return "yarn";
        } else if d.join("bun.lockb").is_file() || d.join("bun.lock").is_file() {
            return "bun";
        } else if d.join("package-lock.json").is_file() {
            return "npm";
        }
    }
    "npm"
}

fn has_build_script(dir: &Path) -> bool {
    std::fs::read(dir.join("package.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v.pointer("/scripts/build").is_some_and(serde_json::Value::is_string))
}

fn ts_steps(dir: &Path, kind: BuildKind) -> Vec<BuildStep> {
    let script = has_build_script(dir);
    if script && (kind == BuildKind::Artifacts || !dir.join("tsconfig.json").is_file()) {
        return vec![BuildStep::new(package_manager(dir), &["run", "build"], dir, Format::Tsc)];
    }
    let local = dir.ancestors().map(|d| d.join("node_modules/.bin/tsc")).find(|p| p.is_file());
    let program = local.map_or_else(|| "tsc".to_owned(), |p| p.to_string_lossy().into_owned());
    vec![BuildStep::new(program, &["--noEmit", "--pretty", "false", "-p", "."], dir, Format::Tsc)]
}

// ---------------------------------------------------------------- running

/// Project paths as the UI knows them: compilers may print the canonical path
/// (`/private/tmp/…` for `/tmp/…`).
struct PathMap {
    root: PathBuf,
    canonical: Option<PathBuf>,
}

impl PathMap {
    fn new(root: &Path) -> Self {
        let canonical = dunce::canonicalize(root).ok().filter(|c| c != root);
        PathMap { root: root.to_path_buf(), canonical }
    }

    fn resolve(&self, printed: &str, cwd: &Path, base: Option<&str>) -> PathBuf {
        let p = Path::new(printed);
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            let in_base = base.map(|b| Path::new(b).join(p)).filter(|c| c.exists());
            in_base.unwrap_or_else(|| cwd.join(p))
        };
        let abs = normalize(&abs);
        match &self.canonical {
            Some(c) => abs.strip_prefix(c).map(|r| self.root.join(r)).unwrap_or(abs),
            None => abs,
        }
    }
}

/// Removes `.` and resolvable `..` components without touching the file system.
fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir if out.file_name().is_some() => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Line texts of files, for converting printed columns to UTF-16.
#[derive(Default)]
struct Lines {
    files: HashMap<PathBuf, Option<Vec<String>>>,
}

impl Lines {
    fn line(&mut self, path: &Path, line: u32) -> Option<&str> {
        let lines = self.files.entry(path.to_path_buf()).or_insert_with(|| {
            std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).lines().map(str::to_owned).collect())
        });
        lines.as_ref()?.get(line as usize).map(String::as_str)
    }
}

/// 1-based column in `unit` → 0-based UTF-16 column of `text`.
fn utf16_col(text: Option<&str>, col: u32, unit: ColUnit) -> u32 {
    let n = col.saturating_sub(1);
    let Some(text) = text else { return n };
    match unit {
        ColUnit::Utf16 => n,
        ColUnit::Char => {
            text.chars().take(n as usize).map(|c| c.len_utf16() as u32).sum::<u32>()
                + n.saturating_sub(text.chars().count() as u32)
        }
        ColUnit::Byte => {
            let mut b = n as usize;
            while b > 0 && b < text.len() && !text.is_char_boundary(b) {
                b -= 1;
            }
            let b = b.min(text.len());
            text[..b].encode_utf16().count() as u32 + (n as usize).saturating_sub(text.len()) as u32
        }
    }
}

/// UTF-16 length of the identifier starting at UTF-16 column `col` of `text`.
fn identifier_len(text: &str, col: u32) -> u32 {
    let mut at = 0;
    let mut len = 0;
    for c in text.chars() {
        if at >= col {
            if !(c.is_alphanumeric() || c == '_' || c == '$') {
                break;
            }
            len += c.len_utf16() as u32;
        }
        at += c.len_utf16() as u32;
    }
    len
}

fn resolve(raw: RawMessage, cwd: &Path, paths: &PathMap, lines: &mut Lines) -> BuildMessage {
    let path = raw.path.as_deref().map(|p| paths.resolve(p, cwd, raw.base.as_deref()));
    let range = match (&path, raw.line) {
        (Some(p), Some(line)) => {
            let l = line - 1;
            let start_col = raw.col.map_or(0, |c| utf16_col(lines.line(p, l), c, raw.unit));
            let end = match (raw.end_line, raw.end_col) {
                (Some(el), Some(ec)) if el >= line => {
                    let el = el - 1;
                    Pos::new(el, utf16_col(lines.line(p, el), ec, raw.unit))
                }
                // A point: underline the identifier there, like the compilers' carets.
                _ => {
                    let word = lines.line(p, l).map_or(0, |t| identifier_len(t, start_col));
                    Pos::new(l, start_col + word)
                }
            };
            Some(Range::new(Pos::new(l, start_col), end))
        }
        _ => None,
    };
    BuildMessage { severity: raw.severity, text: raw.text, path: path.map(Into::into), range, code: raw.code }
}

fn progress_of(line: &str) -> Option<(String, Option<f32>)> {
    let line = line.trim();
    if let Some((name, i, total)) = crate::sync::maven_building(line) {
        return Some((format!("Building {name}"), Some((i.saturating_sub(1) as f32 / total.max(1) as f32).min(1.0))));
    }
    if let Some(task) = line.strip_prefix("> Task ") {
        return Some((format!("Running {}", task.split_whitespace().next().unwrap_or(task)), None));
    }
    if let Some(krate) = line.strip_prefix("Compiling ") {
        return Some((format!("Compiling {}", krate.split_whitespace().next().unwrap_or(krate)), None));
    }
    None
}

/// Runs `plan`, streaming console output, messages and progress to `on_event`.
/// Returns `cancelled` when `cancel` fires (the processes are killed).
pub fn run(
    root: &Path,
    plan: &BuildPlan,
    cancel: &CancellationToken,
    on_event: &(dyn Fn(BuildEvent) + Sync),
) -> IdeResult<BuildResult> {
    let started = Instant::now();
    on_event(BuildEvent::Started { system: plan.system, title: plan.title.clone() });
    let paths = PathMap::new(root);
    let mut lines = Lines::default();
    let mut messages: Vec<BuildMessage> = Vec::new();
    let mut seen: HashSet<(Option<PathBuf>, Option<Range>, String)> = HashSet::new();
    let mut success = true;
    let mut last_error_line = String::new();
    for step in &plan.steps {
        let command = step.display();
        on_event(BuildEvent::Step { command: command.clone(), cwd: step.cwd.clone().into() });
        on_event(BuildEvent::Progress { message: command.clone(), fraction: None });
        let mut parser = OutputParser::new(step.format);
        let mut emit = |raws: Vec<RawMessage>, messages: &mut Vec<BuildMessage>| {
            for raw in raws {
                let m = resolve(raw, &step.cwd, &paths, &mut lines);
                if seen.insert((m.path.clone().map(Into::into), m.range, m.text.clone())) {
                    on_event(BuildEvent::Message { message: m.clone() });
                    messages.push(m);
                }
            }
        };
        let out = process::run(&step.program, &step.args, &step.cwd, &step.env, cancel, |stream, line| {
            let parsed = parser.feed(line);
            match parsed.console {
                Some(text) if text.is_empty() => {}
                Some(text) => on_event(BuildEvent::Output { text, stderr: stream == Stream::Stderr }),
                None => {
                    on_event(BuildEvent::Output { text: format!("{line}\n"), stderr: stream == Stream::Stderr });
                    if let Some((message, fraction)) = progress_of(line) {
                        on_event(BuildEvent::Progress { message, fraction });
                    }
                }
            }
            let stripped = parse::strip_ansi(line);
            if !stripped.trim().is_empty() && !stripped.starts_with('{') {
                last_error_line = stripped;
            }
            emit(parsed.messages, &mut messages);
        });
        let out = match out {
            Ok(out) => out,
            Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Err(e),
            Err(e) => {
                let m = BuildMessage {
                    severity: Severity::Error,
                    text: e.message.clone(),
                    path: None,
                    range: None,
                    code: None,
                };
                on_event(BuildEvent::Output { text: format!("{}\n", e.message), stderr: true });
                on_event(BuildEvent::Message { message: m.clone() });
                messages.push(m);
                success = false;
                break;
            }
        };
        emit(parser.finish(), &mut messages);
        let code = if out.success { "0" } else { "non-zero" };
        on_event(BuildEvent::Output { text: format!("\nProcess finished with exit code {code}\n"), stderr: false });
        if !out.success {
            success = false;
            if !messages.iter().any(|m| m.severity == Severity::Error) {
                let summary = crate::sync::error_summary(&out.text);
                let text = if summary.is_empty() { last_error_line.clone() } else { summary };
                let m = BuildMessage { severity: Severity::Error, text, path: None, range: None, code: None };
                on_event(BuildEvent::Message { message: m.clone() });
                messages.push(m);
            }
            break;
        }
    }
    let count = |s: Severity| messages.iter().filter(|m| m.severity == s).count() as u32;
    Ok(BuildResult {
        system: plan.system,
        title: plan.title.clone(),
        success,
        errors: count(Severity::Error),
        warnings: count(Severity::Warning),
        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
        messages,
    })
}

/// Per-file editor / Problems diagnostics of the messages that have a position.
pub fn diagnostics(messages: &[BuildMessage]) -> BTreeMap<PathBuf, Vec<Diagnostic>> {
    let mut out: BTreeMap<PathBuf, Vec<Diagnostic>> = BTreeMap::new();
    for m in messages {
        let (Some(path), Some(range)) = (&m.path, m.range) else { continue };
        out.entry(path.to_path_buf()).or_default().push(Diagnostic {
            range,
            severity: m.severity,
            message: m.text.clone(),
            source: Some(DIAGNOSTICS_SOURCE.to_owned()),
            code: m.code.clone(),
            unnecessary: false,
            deprecated: false,
            server: Some(DIAGNOSTICS_SOURCE.to_owned()),
        });
    }
    out
}

// ---------------------------------------------------------------- JVM launches of non-Java modules

/// Whether the JVM module at `module` has Kotlin, Groovy or Scala sources, which jdtls does not compile.
pub fn has_non_java_sources(module: &Path) -> bool {
    fn walk(dir: &Path, depth: u32) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else { return false };
        entries.flatten().any(|e| {
            let p = e.path();
            if p.is_dir() {
                depth > 0 && walk(&p, depth - 1)
            } else {
                p.extension().is_some_and(|x| x == "kt" || x == "groovy" || x == "scala")
            }
        })
    }
    walk(&module.join("src"), 12)
}

/// Compiles the module at `module` with its build system before a JVM launch and
/// returns the class directories it wrote, to put ahead of the jdtls classpath.
pub fn build_for_launch(
    root: &Path,
    model: &BuildModel,
    module: &Path,
    test: bool,
    cancel: &CancellationToken,
) -> IdeResult<Vec<PathBuf>> {
    let plan = plan(root, model, BuildKind::Build, Some(module))?;
    let result = run(root, &plan, cancel, &|_| {})?;
    if !result.success {
        let errors: Vec<String> = result
            .messages
            .iter()
            .filter(|m| m.severity == Severity::Error)
            .take(5)
            .map(|m| match (&m.path, m.range) {
                (Some(p), Some(r)) => format!("{}:{}: {}", p.display(), r.start.line + 1, m.text),
                _ => m.text.clone(),
            })
            .collect();
        return Err(IdeError::internal(format!("Build failed:\n{}", errors.join("\n"))));
    }
    Ok(launch_class_dirs(plan.system, module, test))
}

fn launch_class_dirs(system: BuildSystem, module: &Path, test: bool) -> Vec<PathBuf> {
    let sets: &[&str] = if test { &["test", "main"] } else { &["main"] };
    let dirs: Vec<PathBuf> = match system {
        BuildSystem::Gradle => sets
            .iter()
            .flat_map(|s| {
                ["classes/kotlin", "classes/groovy", "classes/scala", "classes/java", "resources"]
                    .map(|d| module.join("build").join(d).join(s))
            })
            .collect(),
        BuildSystem::Maven if test => vec![module.join("target/test-classes"), module.join("target/classes")],
        BuildSystem::Maven => vec![module.join("target/classes")],
        _ => Vec::new(),
    };
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn plans_per_build_system() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("demo");
        write(
            &root,
            "pom.xml",
            "<project><artifactId>demo</artifactId><modules><module>core</module></modules></project>",
        );
        write(&root, "core/pom.xml", "<project><artifactId>core</artifactId></project>");
        write(&root, "core/src/main/java/A.java", "class A {}");
        let model = crate::load(&root, &tmp.path().join("cache"), None);
        let p = plan(&root, &model, BuildKind::Build, None).unwrap();
        assert_eq!(p.system, BuildSystem::Maven);
        assert_eq!(p.title, "demo");
        assert_eq!(p.steps.len(), 1);
        assert_eq!(p.steps[0].args, ["-B", "-Dstyle.color=never", "test-compile"]);
        let p = plan(&root, &model, BuildKind::Rebuild, Some(&root.join("core/src/main/java/A.java"))).unwrap();
        assert_eq!(p.steps[0].args, ["-B", "-Dstyle.color=never", "-pl", "core", "-am", "clean", "test-compile"]);
        assert_eq!(p.steps[0].cwd, root);
        assert_eq!(p.title, "demo: build module 'core'");

        let g = tmp.path().join("g");
        write(&g, "settings.gradle", "include 'app'");
        write(&g, "app/build.gradle", "apply plugin: 'java'");
        let model = crate::load(&g, &tmp.path().join("cache2"), None);
        let p = plan(&g, &model, BuildKind::Build, Some(&g.join("app/src/A.java"))).unwrap();
        assert_eq!(p.system, BuildSystem::Gradle);
        assert_eq!(p.steps[0].args, ["--console=plain", ":app:classes", ":app:testClasses"]);
        assert_eq!(
            plan(&g, &model, BuildKind::Artifacts, None).unwrap().steps[0].args,
            ["--console=plain", "assemble"]
        );

        let c = tmp.path().join("c");
        write(&c, "Cargo.toml", "[package]\nname='c'");
        let p = plan(&c, &BuildModel::default(), BuildKind::Rebuild, None).unwrap();
        assert_eq!(p.system, BuildSystem::Cargo);
        assert_eq!(p.steps.len(), 2);
        assert_eq!(p.steps[0].args[0], "clean");

        let go = tmp.path().join("go");
        write(&go, "go.mod", "module x");
        let p = plan(&go, &BuildModel::default(), BuildKind::Build, Some(&go.join("pkg/a/a.go"))).unwrap();
        assert_eq!(p.steps[0].args, ["build", "./pkg/a/..."]);
        assert_eq!(p.steps[0].cwd, go);

        let ts = tmp.path().join("ts");
        write(&ts, "package.json", r#"{"scripts":{"build":"vite build"}}"#);
        write(&ts, "tsconfig.json", "{}");
        write(&ts, "pnpm-lock.yaml", "");
        let p = plan(&ts, &BuildModel::default(), BuildKind::Build, None).unwrap();
        assert_eq!(p.steps[0].args, ["--noEmit", "--pretty", "false", "-p", "."]);
        let p = plan(&ts, &BuildModel::default(), BuildKind::Artifacts, None).unwrap();
        assert_eq!(
            (p.steps[0].program.as_str(), p.steps[0].args.as_slice()),
            ("pnpm", &["run".to_owned(), "build".to_owned()][..])
        );

        let none = tmp.path().join("none");
        std::fs::create_dir_all(&none).unwrap();
        assert!(plan(&none, &BuildModel::default(), BuildKind::Build, None).is_err());
    }

    #[test]
    fn columns_become_utf16() {
        assert_eq!(utf16_col(Some("a😀b"), 3, ColUnit::Char), 3);
        assert_eq!(utf16_col(Some("a😀b"), 6, ColUnit::Byte), 3);
        assert_eq!(utf16_col(Some("a😀b"), 4, ColUnit::Utf16), 3);
        assert_eq!(utf16_col(None, 5, ColUnit::Char), 4);
        assert_eq!(utf16_col(Some("ab"), 5, ColUnit::Char), 4);
        assert_eq!(identifier_len("x 😀ab_1 c", 2), 0);
        assert_eq!(identifier_len("x é_1 c", 2), 3);
    }

    // Uses Unix absolute paths for the canonical root.
    #[cfg(unix)]
    #[test]
    fn resolves_paths_against_cwd_and_canonical_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        write(&root, "src/a.ts", "let é = 1;\nlet x: number = 'a';\n");
        let map = PathMap { root: root.clone(), canonical: Some(PathBuf::from("/canon/p")) };
        assert_eq!(map.resolve("/canon/p/src/a.ts", &root, None), root.join("src/a.ts"));
        assert_eq!(map.resolve("./src/../src/a.ts", &root, None), root.join("src/a.ts"));
        let mut lines = Lines::default();
        let raw = RawMessage {
            severity: Severity::Error,
            text: "bad".into(),
            path: Some("src/a.ts".into()),
            line: Some(2),
            col: Some(5),
            end_line: None,
            end_col: None,
            unit: ColUnit::Utf16,
            code: Some("TS2322".into()),
            base: None,
        };
        let m = resolve(raw, &root, &map, &mut lines);
        assert_eq!(m.path.as_deref(), Some(root.join("src/a.ts").as_path()));
        assert_eq!(m.range, Some(Range::new(Pos::new(1, 4), Pos::new(1, 5))), "the identifier at the column");
        let d = diagnostics(&[m]);
        assert_eq!(d[&root.join("src/a.ts")][0].source.as_deref(), Some("build"));
    }

    #[test]
    fn runs_a_failing_build_and_reports_messages() {
        if cfg!(windows) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        write(&root, "main.go", "package main\n");
        let script = "echo '# demo'; echo './main.go:1:9: undefined: x' >&2; exit 1";
        let mut step = BuildStep::new("sh", &["-c", script], &root, Format::Go);
        step.env.insert("A".into(), "1".into());
        let plan = BuildPlan { system: BuildSystem::Go, title: "p".into(), steps: vec![step] };
        let events = parking_lot_free::Events::default();
        let result = run(&root, &plan, &CancellationToken::new(), &|e| events.push(e)).unwrap();
        assert!(!result.success);
        assert_eq!((result.errors, result.warnings), (1, 0));
        let m = &result.messages[0];
        assert_eq!(m.path.as_deref(), Some(root.join("main.go").as_path()));
        assert_eq!(m.range, Some(Range::new(Pos::new(0, 8), Pos::new(0, 12))));
        let kinds = events.kinds();
        assert_eq!(kinds.first().map(String::as_str), Some("started"));
        assert!(kinds.iter().any(|k| k == "message") && kinds.iter().any(|k| k == "output"));

        let cancel = CancellationToken::new();
        cancel.cancel();
        let slow = BuildPlan {
            system: BuildSystem::Go,
            title: "p".into(),
            steps: vec![BuildStep::new("sh", &["-c", "sleep 5"], &root, Format::Go)],
        };
        assert_eq!(run(&root, &slow, &cancel, &|_| {}).err().unwrap().kind, ide_core::error::ErrorKind::Cancelled);
    }

    mod parking_lot_free {
        use super::super::BuildEvent;
        use std::sync::Mutex;

        #[derive(Default)]
        pub struct Events(Mutex<Vec<String>>);

        impl Events {
            pub fn push(&self, e: BuildEvent) {
                let kind = serde_json::to_value(&e).unwrap()["kind"].as_str().unwrap().to_owned();
                self.0.lock().unwrap().push(kind);
            }
            pub fn kinds(&self) -> Vec<String> {
                self.0.lock().unwrap().clone()
            }
        }
    }

    #[test]
    fn non_java_launch_class_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let m = tmp.path();
        assert!(!has_non_java_sources(m));
        write(m, "src/main/java/A.java", "class A {}");
        assert!(!has_non_java_sources(m));
        write(m, "src/main/kotlin/a/App.kt", "fun main() {}");
        assert!(has_non_java_sources(m));
        let g = tmp.path().join("g");
        write(&g, "src/test/groovy/ASpec.groovy", "class ASpec {}");
        assert!(has_non_java_sources(&g));
        for d in ["build/classes/kotlin/main", "build/classes/kotlin/test", "build/resources/main", "target/classes"] {
            std::fs::create_dir_all(m.join(d)).unwrap();
        }
        assert_eq!(
            launch_class_dirs(BuildSystem::Gradle, m, false),
            [m.join("build/classes/kotlin/main"), m.join("build/resources/main")]
        );
        assert_eq!(launch_class_dirs(BuildSystem::Gradle, m, true)[0], m.join("build/classes/kotlin/test"));
        assert_eq!(launch_class_dirs(BuildSystem::Maven, m, true), [m.join("target/classes")]);
    }
}
