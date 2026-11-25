//! The IDE's own Java build of Maven and Gradle modules (#4078): javac compiles the modules a
//! launch or build needs, in a resident process, with the configuration the build tool itself
//! gives the compiler.
//!
//! - **Model.** A prepare run generates sources, processes resources and records each
//!   project's source roots, classpaths, compiler configuration and annotation processor path:
//!   `mvn process-resources resources:testResources` with the `java/java-build` extension, or
//!   Gradle's `openideaBuildModel` task from `gradle-build.init.gradle`. It runs only when what
//!   the model is built from changes ([`model::prepare_fingerprint`],
//!   [`model::gradle_prepare_fingerprint`]): build scripts, settings, the launcher, generator
//!   inputs, or a missing generated root.
//! - **Outputs.** The prepare run redirects every project's output into the IDE's cache, so
//!   neither the language server nor a terminal build writes the classes a launch runs, and
//!   projects of the build resolve to those folders, never to jars.
//! - **Compile.** Projects compile in dependency order with javac (`jbuild::javac`), class by
//!   class ([`incremental`]): the changed sources, then those an API change reaches.
//! - **Fallback.** Projects the build compiles with more than javac (Kotlin, Groovy, AspectJ,
//!   enhancers, another compiler id), multi-release jars and Java modules are left to the build
//!   tool's own build.
mod classfile;
mod incremental;
mod javac;
mod model;

pub use classfile::ClassFile;
pub use javac::{JavacPool, Reply, ServerKey};

use incremental::{ClassRecord, SetStamp, SetState};
pub use model::{CompilerConfig, ProjectModel, ReactorModel, ResourceRoot, SourceSet};

use crate::compile::fingerprint;
use crate::compile::{
    BuildEvent, BuildKind, BuildMessage, BuildPlan, BuildStep, BuildSystem, LaunchFingerprint, gradle_build_step,
    maven_build_step, maven_reactor_dir, reactor_projects_of,
};
use crate::process;
use crate::{BuildModel, maven};
use ide_core::{CancellationToken, IdeError, IdeResult, Pos, Range, Severity};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

fn subdir(root: &Path, rel: &str) -> PathBuf {
    root.join(rel).components().collect()
}

/// The resident part of the build: javac servers and one lock per reactor.
#[derive(Default)]
pub struct JavaBuildService {
    pub servers: JavacPool,
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl JavaBuildService {
    fn lock(&self, dir: &Path) -> Arc<Mutex<()>> {
        self.locks.lock().unwrap().entry(dir.to_path_buf()).or_default().clone()
    }
}

/// One build of the IDE's Java build service.
pub struct JavaBuild<'a> {
    pub root: &'a Path,
    pub model: &'a BuildModel,
    pub cache: &'a Path,
    /// `java/java-build`'s jar: the javac server and the Maven extension.
    pub jar: &'a Path,
    /// Changes when the jar does, so models recorded by an older extension are prepared again.
    pub jar_version: &'a str,
    pub local_repo: Option<PathBuf>,
    pub service: &'a JavaBuildService,
    /// The JDK home that compiles for a release, when Maven's environment names none.
    pub jdk: &'a (dyn Fn(Option<u32>) -> Option<PathBuf> + Sync),
}

/// A build the service compiles: a Maven reactor (its top project) or a Gradle build.
#[derive(Clone, Copy)]
enum Reactor<'a> {
    Maven(&'a maven::MavenProject),
    Gradle(&'a crate::GradleModel),
}

impl Reactor<'_> {
    /// Project-relative folder of the reactor.
    fn rel_dir(&self) -> &str {
        match self {
            Reactor::Maven(top) => &top.dir,
            Reactor::Gradle(g) => &g.dir,
        }
    }

    /// Where its state and outputs live under the cache (`java-build/<key>`).
    fn key(&self) -> String {
        match self {
            Reactor::Maven(top) => top.dir.clone(),
            Reactor::Gradle(g) if g.dir.is_empty() => "_gradle".into(),
            Reactor::Gradle(g) => format!("{}/_gradle", g.dir),
        }
    }

    fn env(&self) -> &BTreeMap<String, String> {
        match self {
            Reactor::Maven(top) => &top.env,
            Reactor::Gradle(g) => &g.env,
        }
    }

    fn system(&self) -> BuildSystem {
        match self {
            Reactor::Maven(_) => BuildSystem::Maven,
            Reactor::Gradle(_) => BuildSystem::Gradle,
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Reactor::Maven(_) => "Maven",
            Reactor::Gradle(_) => "Gradle",
        }
    }
}

/// One source set to compile, and where its reactor's build keeps its state.
#[derive(Clone, Copy)]
struct SetBuild<'a> {
    top: Reactor<'a>,
    dir: &'a Path,
    project: &'a ProjectModel,
    test: bool,
    outputs: &'a HashMap<PathBuf, (String, bool)>,
    /// Sources to compile even unchanged (Recompile).
    force: &'a BTreeSet<PathBuf>,
}

/// What a launch runs after its build.
#[derive(Debug, Default)]
pub struct LaunchOutputs {
    /// The class folders of the launch's projects, then its runtime classpath.
    pub class_paths: Vec<PathBuf>,
    /// Why the build failed; the class folders keep the last successful classes.
    pub failure: Option<String>,
    pub messages: Vec<BuildMessage>,
}

#[derive(Debug)]
pub enum Built {
    Done(LaunchOutputs),
    /// The service doesn't build this module (and why); the caller builds it with Maven.
    Unsupported(String),
}

/// `(length, mtime in ns)` of a file.
type FileStamp = (u64, u128);

/// `(length, mtime in ns)` of a file; `None` for a folder or a missing file.
fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    Some((meta.len(), mtime))
}

fn now_generation() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64)
}

/// Matches Ant-style patterns (`**/*.java`, `com/acme/**`) against a `/`-separated path.
fn ant_match(pattern: &str, path: &str) -> bool {
    fn segments(p: &[&str], s: &[&str]) -> bool {
        match p.first() {
            None => s.is_empty(),
            Some(&"**") => (0..=s.len()).any(|i| segments(&p[1..], &s[i..])),
            Some(seg) => !s.is_empty() && glob(seg, s[0]) && segments(&p[1..], &s[1..]),
        }
    }
    fn glob(p: &str, s: &str) -> bool {
        let (p, s): (Vec<char>, Vec<char>) = (p.chars().collect(), s.chars().collect());
        let (mut pi, mut si, mut star, mut mark) = (0, 0, None, 0);
        while si < s.len() {
            if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
                pi += 1;
                si += 1;
            } else if pi < p.len() && p[pi] == '*' {
                star = Some(pi);
                mark = si;
                pi += 1;
            } else if let Some(st) = star {
                pi = st + 1;
                mark += 1;
                si = mark;
            } else {
                return false;
            }
        }
        while pi < p.len() && p[pi] == '*' {
            pi += 1;
        }
        pi == p.len()
    }
    let pattern = pattern.replace('\\', "/");
    let pattern = if pattern.ends_with('/') { format!("{pattern}**") } else { pattern };
    let p: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let s: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    segments(&p, &s)
}

/// The `.java` files of a source set, filtered by the compiler's includes and excludes.
fn java_sources(set: &SourceSet, cancel: &CancellationToken) -> IdeResult<Vec<PathBuf>> {
    let config = set.compiler.as_ref();
    let includes = config.map(|c| c.includes.as_slice()).unwrap_or_default();
    let excludes = config.map(|c| c.excludes.as_slice()).unwrap_or_default();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for root in &set.source_roots {
        if model::is_processor_output(set, root) || !root.is_dir() {
            continue;
        }
        let mut pending = vec![root.clone()];
        while let Some(dir) = pending.pop() {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|e| e == "java") {
                    let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                    let included = includes.is_empty() || includes.iter().any(|p| ant_match(p, &rel));
                    if included && !excludes.iter().any(|p| ant_match(p, &rel)) && seen.insert(path.clone()) {
                        out.push(path);
                    }
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// `-g`, `-g:lines,vars` or `-g:none`, as maven-compiler-plugin passes them.
fn debug_args(c: &CompilerConfig) -> Vec<String> {
    if c.debug == Some(false) {
        return vec!["-g:none".into()];
    }
    match c.debuglevel.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        Some(level) => vec![format!("-g:{level}")],
        None => vec!["-g".into()],
    }
}

/// The JDK feature version of `release` / `source` (`1.8` → 8).
fn feature(version: &str) -> Option<u32> {
    let v = version.trim();
    v.strip_prefix("1.").unwrap_or(v).split('.').next()?.parse().ok()
}

/// javac options for a source set, as maven-compiler-plugin builds them, except for the
/// annotation processors' output, which goes to `generated` in the IDE's outputs.
fn javac_options(set: &SourceSet, classpath: &[PathBuf], generated: &Path, jdk_major: Option<u32>) -> Vec<String> {
    let c = set.compiler.clone().unwrap_or_default();
    let mut args: Vec<String> = vec!["-d".into(), set.output.to_string_lossy().into_owned()];
    let separator = if cfg!(windows) { ";" } else { ":" };
    args.push("-classpath".into());
    args.push(
        std::iter::once(set.output.to_string_lossy().into_owned())
            .chain(classpath.iter().filter(|p| **p != set.output).map(|p| p.to_string_lossy().into_owned()))
            .collect::<Vec<_>>()
            .join(separator),
    );
    // Sources outside the compiled set (another root's classes) are found as classes only.
    args.extend(["-sourcepath".into(), String::new()]);
    args.extend(["-s".into(), generated.to_string_lossy().into_owned()]);
    if let Some(path) = c.processor_path.as_ref().filter(|p| !p.is_empty()) {
        args.push("-processorpath".into());
        args.push(path.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>().join(separator));
    }
    if let Some(processors) = c.annotation_processors.as_ref().filter(|p| !p.is_empty()) {
        args.push("-processor".into());
        args.push(processors.join(","));
    }
    if let Some(proc) = c.proc.as_deref().filter(|p| !p.is_empty()) {
        args.push(format!("-proc:{proc}"));
    }
    args.extend(debug_args(&c));
    if c.parameters == Some(true) {
        args.push("-parameters".into());
    }
    if c.enable_preview == Some(true) {
        args.push("--enable-preview".into());
    }
    if c.show_warnings == Some(false) {
        args.push("-nowarn".into());
    }
    if c.show_deprecation == Some(true) {
        args.push("-deprecation".into());
    }
    if let Some(encoding) = c.encoding.as_deref().filter(|e| !e.is_empty()) {
        args.extend(["-encoding".into(), encoding.to_owned()]);
    }
    let modern = jdk_major.is_none_or(|m| m >= 9);
    match c.release.as_deref().filter(|r| !r.trim().is_empty()) {
        Some(release) if modern => args.extend(["--release".into(), release.trim().to_owned()]),
        _ => {
            if let Some(source) = c.source.as_deref().filter(|s| !s.is_empty()) {
                args.extend(["-source".into(), source.to_owned()]);
            }
            if let Some(target) = c.target.as_deref().filter(|s| !s.is_empty()) {
                args.extend(["-target".into(), target.to_owned()]);
            }
        }
    }
    for (key, value) in &c.compiler_arguments {
        args.push(if key.starts_with('-') { key.clone() } else { format!("-{key}") });
        if let Some(value) = value.as_ref().filter(|v| !v.is_empty()) {
            args.push(value.clone());
        }
    }
    if let Some(argument) = &c.compiler_argument {
        args.extend(argument.split_whitespace().map(str::to_owned));
    }
    args.extend(c.compiler_args.iter().filter(|a| !a.is_empty()).cloned());
    args
}

/// `.mvn/jvm.config` of the reactor: the options Maven's JVM (and so its in-process javac) runs with.
fn jvm_config(top: Reactor, top_dir: &Path) -> Vec<String> {
    if matches!(top, Reactor::Gradle(_)) {
        return Vec::new();
    }
    let Ok(text) = std::fs::read_to_string(top_dir.join(".mvn/jvm.config")) else { return Vec::new() };
    text.lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .flat_map(str::split_whitespace)
        .map(|a| a.replace("${MAVEN_PROJECTBASEDIR}", &top_dir.to_string_lossy()))
        .collect()
}

fn jdk_major(home: &Path) -> Option<u32> {
    let release = std::fs::read_to_string(home.join("release")).ok()?;
    let value = release.lines().find_map(|l| l.trim().strip_prefix("JAVA_VERSION="))?;
    feature(value.trim().trim_matches(['"', '\'']))
}

fn message_text(m: &BuildMessage) -> String {
    let severity = match m.severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        _ => "note",
    };
    match (&m.path, m.range) {
        (Some(p), Some(r)) => {
            format!("{}:{}:{}: {severity}: {}\n", p.display(), r.start.line + 1, r.start.col + 1, m.text)
        }
        (Some(p), None) => format!("{}: {severity}: {}\n", p.display(), m.text),
        _ => format!("{severity}: {}\n", m.text),
    }
}

fn diagnostic(reply: &Reply) -> Option<BuildMessage> {
    let Reply::Diagnostic { severity, path, line, column, end_line, end_column, code, message } = reply else {
        return None;
    };
    let severity = match severity.as_str() {
        "error" => Severity::Error,
        "warning" => Severity::Warning,
        _ => Severity::Info,
    };
    let range = line.map(|line| {
        let start = Pos::new(line.saturating_sub(1), column.unwrap_or(0));
        let end = match (end_line, end_column) {
            (Some(l), Some(c)) if *l >= line => Pos::new(l - 1, *c),
            _ => start,
        };
        Range::new(start, end)
    });
    Some(BuildMessage {
        severity,
        text: message.clone(),
        path: path.clone().map(Into::into),
        range,
        code: code.clone(),
    })
}

/// What a build compiles.
#[derive(Clone, Copy, Debug)]
pub enum Target<'p> {
    /// What the launch of the module at this folder runs: its main (or test) classes and the
    /// reactor projects they depend on.
    Launch { module: &'p Path, test: bool },
    /// Build Module: the main and test classes of the module holding this file or folder, and
    /// the reactor projects they depend on.
    Module(&'p Path),
    /// Build Project: every module of every linked reactor.
    Project,
    /// Recompile: this source, even unchanged, and what its changes reach.
    File(&'p Path),
}

impl JavaBuild<'_> {
    /// Builds what the launch of `module` runs (its main or test classes and the reactor
    /// projects they depend on) and returns the classpath to run it with.
    pub fn build_launch(
        &self,
        module: &Path,
        test: bool,
        kind: BuildKind,
        cancel: &CancellationToken,
        on_event: &(dyn Fn(BuildEvent) + Sync),
    ) -> IdeResult<Built> {
        self.build(Target::Launch { module, test }, kind, cancel, on_event)
    }

    /// The Maven reactor or Gradle build of the module holding `path`, and the module's folder.
    fn reactor_and_module(&self, path: &Path) -> Option<(Reactor<'_>, PathBuf)> {
        let rel = |dir: &Path| dir.strip_prefix(self.root).unwrap_or(dir).to_string_lossy().replace('\\', "/");
        // The deepest project folder holding it, of either build tool.
        let maven = self.model.maven.iter().flat_map(|m| m.projects.iter().map(|p| subdir(self.root, &p.dir)));
        let gradle = self.model.gradle.iter().flat_map(|g| g.projects.iter().map(|p| subdir(self.root, &p.dir)));
        let dir = maven.chain(gradle).filter(|dir| path.starts_with(dir)).max_by_key(|dir| dir.components().count())?;
        if let Some(m) = &self.model.maven
            && let Some(top) = maven_reactor_dir(m, &rel(&dir))
        {
            return Some((Reactor::Maven(top), dir));
        }
        let g = self.model.gradle_for_module(self.root, &dir)?;
        Some((Reactor::Gradle(g), dir))
    }

    fn reactor_of(&self, module: &Path) -> Option<Reactor<'_>> {
        self.reactor_and_module(module).map(|(top, _)| top)
    }

    /// The classpath a launch of `module` runs with when it doesn't build (Before launch: no
    /// build): the outputs of the last build, `None` when the module was never built here.
    pub fn recorded_launch(&self, module: &Path, test: bool) -> Option<Vec<PathBuf>> {
        let top = self.reactor_of(module)?;
        let record = model::load_record(&model::reactor_dir(self.cache, &top.key()))?;
        let project = record.model.projects.iter().find(|p| p.dir == module)?;
        let paths = class_paths(project, test);
        paths.first().is_some_and(|p| p.is_dir()).then_some(paths)
    }

    /// Builds `target`. A launch gets the classpath to run with; the others an empty one.
    pub fn build(
        &self,
        target: Target,
        kind: BuildKind,
        cancel: &CancellationToken,
        on_event: &(dyn Fn(BuildEvent) + Sync),
    ) -> IdeResult<Built> {
        let rel = |path: &Path| path.strip_prefix(self.root).unwrap_or(path).to_string_lossy().replace('\\', "/");
        let (tops, title) = match target {
            Target::Project => {
                let maven = self.model.maven.iter().flat_map(|m| m.projects.iter().filter(|p| !p.aggregated));
                let tops: Vec<Reactor> =
                    maven.map(Reactor::Maven).chain(self.model.gradle.iter().map(Reactor::Gradle)).collect();
                let name = self.root.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
                (tops, format!("Build '{name}'"))
            }
            Target::Launch { module, .. } | Target::Module(module) | Target::File(module) => {
                let Some((top, dir)) = self.reactor_and_module(module) else {
                    return Ok(Built::Unsupported("the file belongs to no Maven or Gradle module".into()));
                };
                let name = match target {
                    Target::File(file) => file.file_name(),
                    _ => dir.file_name(),
                }
                .map_or_else(|| rel(&dir), |n| n.to_string_lossy().into_owned());
                (vec![top], format!("Build '{name}'"))
            }
        };
        if tops.is_empty() {
            return Ok(Built::Unsupported("no Maven or Gradle build".into()));
        }
        on_event(BuildEvent::Started { system: BuildSystem::Javac, title });
        // Nested Maven and Gradle runs report into the same build.
        let nested = |event: BuildEvent| {
            if !matches!(event, BuildEvent::Started { .. }) {
                on_event(event);
            }
        };
        let mut messages = Vec::new();
        let mut class_path = Vec::new();
        for top in tops {
            let dir = model::reactor_dir(self.cache, &top.key());
            let lock = self.service.lock(&dir);
            let _guard = lock.lock().unwrap();
            let Some(reactor_model) = self.prepared(top, &dir, kind, cancel, &nested)? else {
                // The build tool's own build reports why (a build script error, a version the
                // extension doesn't load in).
                return Ok(Built::Unsupported(format!("{} could not prepare the build", top.name())));
            };
            let project_at = |path: &Path| {
                reactor_model
                    .projects
                    .iter()
                    .filter(|p| path.starts_with(&p.dir))
                    .max_by_key(|p| p.dir.components().count())
            };
            let mut force = BTreeSet::new();
            let projects: Vec<(&ProjectModel, bool)> = match target {
                Target::Launch { module, test } => {
                    let Some(project) = reactor_model.projects.iter().find(|p| p.dir == module) else {
                        return Ok(Built::Unsupported(format!(
                            "the build has no Java project at {}",
                            module.display()
                        )));
                    };
                    class_path = class_paths(project, test);
                    launch_projects(&reactor_model, project, test)
                }
                Target::Module(path) => {
                    let Some(project) = project_at(path) else {
                        return Ok(Built::Unsupported(format!("no Java project holds {}", path.display())));
                    };
                    let mut all: Vec<(&ProjectModel, bool)> = Vec::new();
                    for member in reactor_model.projects.iter().filter(|p| p.dir.starts_with(&project.dir)) {
                        for set in launch_projects(&reactor_model, member, true) {
                            if !all.iter().any(|(p, t)| p.dir == set.0.dir && *t == set.1) {
                                all.push(set);
                            }
                        }
                    }
                    all
                }
                Target::File(file) => {
                    let Some(project) = project_at(file) else {
                        return Ok(Built::Unsupported(format!("no Java project holds {}", file.display())));
                    };
                    let test = project.test.source_roots.iter().any(|r| file.starts_with(r));
                    force.insert(file.to_path_buf());
                    launch_projects(&reactor_model, project, test)
                }
                Target::Project => {
                    let mut all: Vec<(&ProjectModel, bool)> = Vec::new();
                    for project in &reactor_model.projects {
                        for set in launch_projects(&reactor_model, project, true) {
                            if !all.iter().any(|(p, t)| p.dir == set.0.dir && *t == set.1) {
                                all.push(set);
                            }
                        }
                    }
                    all
                }
            };
            for (project, test) in &projects {
                if let Some(reason) = project.unsupported(*test) {
                    return Ok(Built::Unsupported(reason));
                }
                // A launch of a Java module runs it from the module path, which the language server reports.
                if project.main.source_roots.iter().any(|r| r.join("module-info.java").is_file()) {
                    return Ok(Built::Unsupported(format!("{} is a Java module", project.artifact_id)));
                }
            }
            if kind == BuildKind::Rebuild {
                for (project, test) in &projects {
                    self.clean(&dir, project, *test)?;
                }
            }
            if let Some(mut failure) = self.resources(top, &dir, &projects, cancel, &nested)? {
                failure.class_paths = class_path;
                return Ok(Built::Done(failure));
            }
            let outputs: HashMap<PathBuf, (String, bool)> = reactor_model
                .projects
                .iter()
                .flat_map(|p| [(p.main.output.clone(), (p.key(), false)), (p.test.output.clone(), (p.key(), true))])
                .collect();
            let total = projects.len();
            for (i, (project, tests)) in projects.iter().enumerate() {
                on_event(BuildEvent::Progress {
                    message: format!("Compiling {}", project.artifact_id),
                    fraction: Some(i as f32 / total.max(1) as f32),
                });
                let set = SetBuild { top, dir: &dir, project, test: *tests, outputs: &outputs, force: &force };
                if self.compile_set(&set, cancel, on_event, &mut messages)? {
                    let errors: Vec<String> = messages
                        .iter()
                        .filter(|m| m.severity == Severity::Error)
                        .take(5)
                        .map(|m| message_text(m).trim_end().to_owned())
                        .collect();
                    let failure = format!("Build failed:\n{}", errors.join("\n"));
                    return Ok(Built::Done(LaunchOutputs {
                        class_paths: class_path,
                        failure: Some(failure),
                        messages,
                    }));
                }
            }
        }
        Ok(Built::Done(LaunchOutputs { class_paths: class_path, failure: None, messages }))
    }

    /// The reactor's model, from the record when it is current, else from a prepare run.
    /// `None` when the prepare run failed.
    fn prepared(
        &self,
        top: Reactor,
        dir: &Path,
        kind: BuildKind,
        cancel: &CancellationToken,
        on_event: &(dyn Fn(BuildEvent) + Sync),
    ) -> IdeResult<Option<ReactorModel>> {
        let out = model::output_root(self.cache, &top.key());
        let model_file = dir.join("model.json");
        let (step, fingerprint) = match top {
            Reactor::Maven(top) => {
                let m = self.model.maven.as_ref().expect("a Maven reactor");
                let reactor = reactor_projects_of(m, top);
                let goals = ["process-resources".to_owned(), "resources:testResources".to_owned()];
                let step = model::maven_step(self.root, top, self.jar, &out, Some(&model_file), &goals);
                let fingerprint = model::prepare_fingerprint(
                    self.root,
                    &reactor,
                    &step,
                    self.local_repo.clone(),
                    self.jar_version,
                    cancel,
                )?;
                (step, fingerprint)
            }
            Reactor::Gradle(g) => {
                let init = model::gradle_init_script(dir)?;
                let tasks = ["openideaBuildModel".to_owned()];
                let step = model::gradle_step(self.root, g, &init, &out, Some(&model_file), &tasks);
                let fingerprint = model::gradle_prepare_fingerprint(self.root, g, &step, self.jar_version, cancel)?;
                (step, Some(fingerprint))
            }
        };
        if kind != BuildKind::Rebuild
            && let (Some(current), Some(record)) = (&fingerprint, model::load_record(dir))
            && record.fingerprint == *current
            && model::generated_roots_exist(&record.model)
        {
            return Ok(Some(record.model));
        }
        on_event(BuildEvent::Progress {
            message: format!("Generating sources and reading the {} build", top.name()),
            fraction: None,
        });
        let _ = std::fs::remove_file(&model_file);
        let plan = BuildPlan { system: top.system(), title: String::new(), steps: vec![step] };
        let result = crate::compile::run(self.root, &plan, cancel, on_event)?;
        if !result.success {
            return Ok(None);
        }
        let reactor_model = model::read_model(&model_file)?;
        if let Some(fingerprint) = fingerprint {
            model::save_record(dir, &model::PrepareRecord { fingerprint, model: reactor_model.clone() })?;
        }
        // The prepare run processed every project's resources.
        for project in &reactor_model.projects {
            for test in [false, true] {
                let stamp = resource_stamp(project.set(test), cancel)?;
                model::write_json(&state_path(dir, project, test, "resources"), &stamp)?;
            }
        }
        Ok(Some(reactor_model))
    }

    /// Processes the resources that changed since they were last processed, with the build
    /// tool (filtering, includes, target paths), into the IDE's outputs. `Some` on failure.
    fn resources(
        &self,
        top: Reactor,
        dir: &Path,
        projects: &[(&ProjectModel, bool)],
        cancel: &CancellationToken,
        on_event: &(dyn Fn(BuildEvent) + Sync),
    ) -> IdeResult<Option<LaunchOutputs>> {
        let mut changed: Vec<(&ProjectModel, bool, BTreeMap<PathBuf, FileStamp>)> = Vec::new();
        for (project, test) in projects {
            let stamp = resource_stamp(project.set(*test), cancel)?;
            let recorded: Option<BTreeMap<PathBuf, FileStamp>> =
                std::fs::read(state_path(dir, project, *test, "resources"))
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok());
            if recorded.as_ref() != Some(&stamp) {
                changed.push((project, *test, stamp));
            }
        }
        if changed.is_empty() {
            return Ok(None);
        }
        on_event(BuildEvent::Progress { message: "Processing resources".into(), fraction: None });
        let out = model::output_root(self.cache, &top.key());
        let step = match top {
            Reactor::Maven(top) => {
                let top_dir = subdir(self.root, &top.dir);
                let mut selection: Vec<String> = changed
                    .iter()
                    .map(|(p, _, _)| {
                        let rel = p.dir.strip_prefix(&top_dir).unwrap_or(&p.dir).to_string_lossy().replace('\\', "/");
                        if rel.is_empty() { ".".to_owned() } else { rel }
                    })
                    .collect();
                selection.sort();
                selection.dedup();
                let mut extra = vec!["-q".to_owned(), "-pl".to_owned(), selection.join(",")];
                extra.push("resources:resources".into());
                if changed.iter().any(|(_, test, _)| *test) {
                    extra.push("resources:testResources".into());
                }
                model::maven_step(self.root, top, self.jar, &out, None, &extra)
            }
            Reactor::Gradle(g) => {
                let mut tasks = vec!["-q".to_owned()];
                for (project, test, _) in &changed {
                    let path = project.gradle_path.as_deref().unwrap_or(":");
                    let prefix = if path == ":" { String::new() } else { format!("{path}:") };
                    tasks.push(format!("{prefix}{}", if *test { "processTestResources" } else { "processResources" }));
                }
                let init = model::gradle_init_script(dir)?;
                model::gradle_step(self.root, g, &init, &out, None, &tasks)
            }
        };
        let plan = BuildPlan { system: top.system(), title: String::new(), steps: vec![step] };
        let result = crate::compile::run(self.root, &plan, cancel, on_event)?;
        if !result.success {
            return Ok(Some(LaunchOutputs {
                class_paths: Vec::new(),
                failure: Some(format!("{} could not process the resources", top.name())),
                messages: result.messages,
            }));
        }
        for (project, test, stamp) in changed {
            model::write_json(&state_path(dir, project, test, "resources"), &stamp)?;
        }
        Ok(None)
    }

    /// Removes the classes of a source set and its record: the next build compiles it from scratch.
    fn clean(&self, dir: &Path, project: &ProjectModel, test: bool) -> IdeResult<()> {
        let set = project.set(test);
        remove_classes(&set.output);
        let _ = std::fs::remove_dir_all(generated_dir(dir, project, test));
        let _ = std::fs::remove_file(state_path(dir, project, test, "compile"));
        Ok(())
    }

    /// Compiles what changed in one source set (see [`incremental`]). Returns whether it failed.
    fn compile_set(
        &self,
        build: &SetBuild,
        cancel: &CancellationToken,
        on_event: &(dyn Fn(BuildEvent) + Sync),
        messages: &mut Vec<BuildMessage>,
    ) -> IdeResult<bool> {
        let SetBuild { top, dir, project, test, outputs, force } = *build;
        let set = project.set(test);
        if set.compiler.as_ref().is_some_and(|c| c.skip == Some(true)) || set.compiler.is_none() {
            return Ok(false);
        }
        let sources = java_sources(set, cancel)?;
        let source_stamps: BTreeMap<PathBuf, FileStamp> =
            sources.iter().filter_map(|s| Some((s.clone(), file_stamp(s)?))).collect();
        let state_file = state_path(dir, project, test, "compile");
        let previous = incremental::load_state(&state_file);
        let config = set.compiler.clone().unwrap_or_default();
        let release = config.release.as_deref().or(config.source.as_deref()).and_then(feature);
        let java_home = self.java_home(top, &config, release)?;
        let generated = generated_dir(dir, project, test);
        let classpath: Vec<PathBuf> = if test {
            std::iter::once(project.main.output.clone()).chain(set.classpath.iter().cloned()).collect()
        } else {
            set.classpath.clone()
        };
        let options = javac_options(set, &classpath, &generated, jdk_major(&java_home));
        let reactor: Vec<PathBuf> =
            classpath.iter().filter(|e| **e != set.output && outputs.contains_key(*e)).cloned().collect();
        let stamp = SetStamp {
            options: options.clone(),
            libraries: classpath
                .iter()
                .filter(|e| **e != set.output && !outputs.contains_key(*e))
                .map(|e| (e.clone(), file_stamp(e)))
                .collect(),
            reactor: reactor.clone(),
            processor_path: config.processor_path.iter().flatten().map(|p| (p.clone(), file_stamp(p))).collect(),
            java_home: java_home.clone(),
        };

        // What the reactor outputs it compiles against changed since it last compiled.
        let mut upstream = BTreeMap::new();
        let mut upstream_changed = BTreeSet::new();
        let mut upstream_all = false;
        for entry in &reactor {
            let (key, entry_test) = &outputs[entry];
            let state = incremental::load_state(&state_path_of(dir, key, *entry_test, "compile"));
            let generation = state.as_ref().map_or(0, |s| s.generation);
            upstream.insert(entry.clone(), generation);
            let recorded = previous.as_ref().and_then(|p| p.upstream.get(entry)).copied();
            if recorded == Some(generation) {
                continue;
            }
            match (recorded, state.and_then(|s| s.changes_since(recorded?))) {
                (Some(_), Some(changed)) => upstream_changed.extend(changed),
                _ => upstream_all = true,
            }
        }

        let had_state = previous.is_some();
        let previous = previous.unwrap_or_default();
        let changed: BTreeSet<PathBuf> = source_stamps
            .iter()
            .filter(|(path, stamp)| {
                previous.sources.get(*path) != Some(*stamp) || previous.dirty.contains(*path) || force.contains(*path)
            })
            .map(|(path, _)| path.clone())
            .collect();
        let removed: BTreeSet<PathBuf> =
            previous.sources.keys().filter(|p| !source_stamps.contains_key(*p)).cloned().collect();
        let from_scratch = !had_state
            || previous.stamp != stamp
            || upstream_all
            || !set.output.is_dir()
            || (!previous.success && previous.dirty.is_empty());
        if !from_scratch && changed.is_empty() && removed.is_empty() && upstream_changed.is_empty() {
            return Ok(false);
        }
        // Processors that aggregate (or name no originating source) can't be followed class by class.
        let from_scratch = from_scratch
            || (!previous.generated.is_empty() || !previous.unowned.is_empty())
                && !(changed.is_empty() && removed.is_empty() && upstream_changed.is_empty());

        let mut state = SetState {
            stamp,
            sources: source_stamps.clone(),
            generation: previous.generation,
            upstream,
            classes: previous.classes,
            changes: previous.changes,
            ..Default::default()
        };
        let mut api_changed = BTreeSet::new();
        let mut constants_changed = false;
        // Classes of removed sources go first, and count as changed.
        let gone: Vec<String> = state
            .classes
            .iter()
            .filter(|(_, r)| r.source.as_ref().is_some_and(|s| removed.contains(s)))
            .map(|(n, _)| n.clone())
            .collect();
        for name in gone {
            let record = state.classes.remove(&name).expect("listed");
            let _ = std::fs::remove_file(&record.file);
            constants_changed |= record.constants != incremental::NO_CONSTANTS;
            api_changed.insert(name);
        }
        let mut to_compile: BTreeSet<PathBuf> = if from_scratch || constants_changed {
            remove_classes(&set.output);
            for file in previous.generated.iter().chain(&previous.unowned) {
                let _ = std::fs::remove_file(file);
            }
            let _ = std::fs::remove_dir_all(&generated);
            state.classes.retain(|_, r| r.source.is_some());
            source_stamps.keys().cloned().collect()
        } else {
            let affected =
                incremental::with_subclasses(&state.classes, &upstream_changed.union(&api_changed).cloned().collect());
            changed.iter().cloned().chain(incremental::dependent_sources(&state.classes, &affected)).collect()
        };
        std::fs::create_dir_all(&set.output)?;
        std::fs::create_dir_all(&generated)?;

        let set_name = if test { "tests" } else { "main" };
        let total = source_stamps.len();
        let mut compiled: BTreeSet<PathBuf> = BTreeSet::new();
        let mut server = None;
        loop {
            let batch: BTreeSet<PathBuf> = to_compile
                .iter()
                .filter(|s| !compiled.contains(*s) && source_stamps.contains_key(*s))
                .cloned()
                .collect();
            if batch.is_empty() {
                break;
            }
            // The classes the batch replaces: their files go first, so nothing stale is left.
            let replaced: BTreeMap<String, ClassRecord> = state
                .classes
                .iter()
                .filter(|(_, r)| r.source.as_ref().is_some_and(|s| batch.contains(s)))
                .map(|(n, r)| (n.clone(), r.clone()))
                .collect();
            for (name, record) in &replaced {
                let _ = std::fs::remove_file(&record.file);
                state.classes.remove(name);
            }
            let files: Vec<PathBuf> = batch.iter().cloned().collect();
            let noun = if total == 1 { "file" } else { "files" };
            let count = if files.len() == total {
                format!("{total} {noun}")
            } else {
                format!("{} of {total} {noun}", files.len())
            };
            on_event(BuildEvent::Step {
                command: format!("javac {} ({set_name}, {count})", project.artifact_id),
                cwd: project.dir.clone().into(),
            });
            if server.is_none() {
                let key = ServerKey {
                    java_home: java_home.clone(),
                    jvm_args: jvm_config(top, &subdir(self.root, top.rel_dir())),
                };
                server = Some(self.service.servers.server(self.jar, &key)?);
            }
            let mut written: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
            let result = server.as_ref().expect("started").compile(
                &options,
                &files,
                config.encoding.as_deref(),
                cancel,
                |reply| match reply {
                    Reply::Output { path, source } => written.push((path.clone(), source.clone())),
                    Reply::Generated { path, .. } => state.generated.push(path.clone()),
                    Reply::OutputText { text } => on_event(BuildEvent::Output { text: text.clone(), stderr: false }),
                    Reply::Diagnostic { .. } => {
                        if let Some(m) = diagnostic(reply) {
                            on_event(BuildEvent::Output {
                                text: message_text(&m),
                                stderr: m.severity == Severity::Error,
                            });
                            on_event(BuildEvent::Message { message: m.clone() });
                            messages.push(m);
                        }
                    }
                    Reply::Done { .. } => {}
                },
            );
            if !matches!(result, Ok(true)) {
                for (path, _) in &written {
                    let _ = std::fs::remove_file(path);
                }
                // The next build starts from the state this one started from, with whatever this
                // one had to compile still to compile. Its earlier rounds' classes are not the
                // baseline: compared with them, the API and constant changes those rounds found
                // would never reach this set's dependents or the sets compiled against it.
                let mut retry = incremental::load_state(&state_file).unwrap_or_default();
                retry.dirty.extend(to_compile.union(&compiled).filter(|s| source_stamps.contains_key(*s)).cloned());
                retry.success = false;
                let _ = model::write_json(&state_file, &retry);
                return result.map(|_| true);
            }
            // javac names sources as they were passed; other spellings are matched canonically,
            // and classes of sources outside the set (processors' output) are unowned.
            let canonical: HashMap<PathBuf, &PathBuf> =
                batch.iter().filter_map(|s| Some((dunce::canonicalize(s).ok()?, s))).collect();
            let own = |source: PathBuf| -> Option<PathBuf> {
                if source_stamps.contains_key(&source) {
                    return Some(source);
                }
                canonical.get(&dunce::canonicalize(&source).ok()?).map(|s| (*s).clone())
            };
            let mut fresh = BTreeMap::new();
            for (path, source) in written {
                let source = source.and_then(own);
                let class = (path.extension().is_some_and(|e| e == "class"))
                    .then(|| std::fs::read(&path).ok())
                    .flatten()
                    .and_then(|bytes| classfile::parse(&bytes));
                match (class, source) {
                    (Some(class), Some(source)) => {
                        let (name, record) = ClassRecord::new(class, path, Some(source));
                        fresh.insert(name, record);
                    }
                    _ => state.unowned.push(path),
                }
            }
            let round = incremental::diff(&replaced, &fresh);
            constants_changed |= round.constants;
            api_changed.extend(round.api.iter().cloned());
            state.classes.extend(fresh);
            compiled.extend(batch);
            if constants_changed {
                // Constants are copied into the classes that use them: compile the rest too.
                to_compile.extend(source_stamps.keys().cloned());
                continue;
            }
            let affected =
                incremental::with_subclasses(&state.classes, &round.api.union(&upstream_changed).cloned().collect());
            to_compile.extend(incremental::dependent_sources(&state.classes, &affected));
            to_compile.extend(incremental::shadowed_sources(&state.classes, &round.added));
        }
        state.success = true;
        if !compiled.is_empty() || !api_changed.is_empty() {
            let changed =
                incremental::with_subclasses(&state.classes, &api_changed.union(&upstream_changed).cloned().collect());
            state.log(now_generation(), changed, !had_state || constants_changed);
        }
        model::write_json(&state_file, &state)?;
        Ok(false)
    }

    /// The JDK compiling a source set: the compiler plugin's forked `executable`, else Maven's
    /// `JAVA_HOME`, else one for the release.
    fn java_home(&self, top: Reactor, config: &CompilerConfig, release: Option<u32>) -> IdeResult<PathBuf> {
        if config.fork == Some(true)
            && let Some(home) = config.executable.as_deref().map(Path::new).and_then(|e| e.parent()?.parent())
            && home.join("bin").is_dir()
        {
            return Ok(home.to_path_buf());
        }
        if let Some(home) = top.env().get("JAVA_HOME").map(PathBuf::from).filter(|h| h.join("bin").is_dir()) {
            return Ok(home);
        }
        (self.jdk)(release).ok_or_else(|| {
            IdeError::unavailable(match release {
                Some(release) => format!("No JDK {release} or newer is installed to compile the module"),
                None => "No JDK is installed to compile the module".to_owned(),
            })
        })
    }
}

/// The source sets a launch of `target` needs, dependencies first: its main classes (and
/// its test classes for a test launch) and the reactor projects on their classpath.
fn launch_projects<'a>(model: &'a ReactorModel, target: &'a ProjectModel, test: bool) -> Vec<(&'a ProjectModel, bool)> {
    let by_output: HashMap<&Path, &ProjectModel> =
        model.projects.iter().map(|p| (p.main.output.as_path(), p)).collect();
    let by_test_output: HashMap<&Path, &ProjectModel> =
        model.projects.iter().map(|p| (p.test.output.as_path(), p)).collect();
    fn visit<'a>(
        project: &'a ProjectModel,
        test: bool,
        by_output: &HashMap<&Path, &'a ProjectModel>,
        by_test_output: &HashMap<&Path, &'a ProjectModel>,
        seen: &mut HashSet<(PathBuf, bool)>,
        out: &mut Vec<(&'a ProjectModel, bool)>,
    ) {
        if !seen.insert((project.dir.clone(), test)) {
            return;
        }
        if test {
            visit(project, false, by_output, by_test_output, seen, out);
        }
        for entry in &project.set(test).classpath {
            if let Some(upstream) = by_output.get(entry.as_path()).filter(|p| p.dir != project.dir) {
                visit(upstream, false, by_output, by_test_output, seen, out);
            } else if let Some(upstream) = by_test_output.get(entry.as_path()).filter(|p| p.dir != project.dir) {
                visit(upstream, true, by_output, by_test_output, seen, out);
            }
        }
        out.push((project, test));
    }
    let mut out = Vec::new();
    visit(target, test, &by_output, &by_test_output, &mut HashSet::new(), &mut out);
    out
}

/// The launch classpath: the target's class folders, then its runtime classpath.
fn class_paths(target: &ProjectModel, test: bool) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: &PathBuf| {
        if !out.contains(p) {
            out.push(p.clone());
        }
    };
    if test {
        push(&target.test.output);
    }
    push(&target.main.output);
    for entry in &target.set(test).runtime_classpath {
        push(entry);
    }
    out
}

fn state_path(dir: &Path, project: &ProjectModel, test: bool, what: &str) -> PathBuf {
    state_path_of(dir, &project.key(), test, what)
}

fn state_path_of(dir: &Path, key: &str, test: bool, what: &str) -> PathBuf {
    dir.join("state").join(key.replace(':', ".")).join(format!("{}-{what}.json", if test { "test" } else { "main" }))
}

fn generated_dir(dir: &Path, project: &ProjectModel, test: bool) -> PathBuf {
    dir.join("generated").join(project.key().replace(':', ".")).join(if test {
        "test-annotations"
    } else {
        "annotations"
    })
}

/// Deletes the `.class` files under `dir`, keeping the resources next to them.
fn remove_classes(dir: &Path) {
    let mut pending = vec![dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                pending.push(path);
            } else if path.extension().is_some_and(|e| e == "class") {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// `(length, mtime)` of every file in a source set's resource folders.
fn resource_stamp(set: &SourceSet, cancel: &CancellationToken) -> IdeResult<BTreeMap<PathBuf, FileStamp>> {
    let mut out = BTreeMap::new();
    for root in &set.resources {
        let mut pending = vec![root.directory.clone()];
        while let Some(dir) = pending.pop() {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    pending.push(path);
                } else if let Some(stamp) = file_stamp(&path) {
                    out.insert(path, stamp);
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
