//! Maven projects for the Maven tool window, read straight from `pom.xml`:
//! coordinates, `<modules>` (aggregators), profiles, plugins (declared plus
//! the default lifecycle bindings of the packaging) and direct dependencies.
//!
//! `${properties}` are resolved through the parent chain, which is followed
//! into the local repository (`~/.m2/repository`) when the parent is not in the
//! project, together with imported BOMs. Nothing here runs Maven: [`crate::sync`]
//! later replaces plugins and dependencies with the effective build.

use crate::xml::{self, Element};
use ide_core::{Pos, Range};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub mod completion;
pub mod sources;

/// Lets the IDE's own Maven runs (Reload, Build) use what the local repository already
/// has. Maven 3.9 re-resolves an artifact whose recorded origin repository (`_remote.repositories`)
/// isn't declared in the build, such as a vendor jar downloaded through another project or
/// installed by hand, and fails when no declared repository has it. Tracking under another
/// file name makes such artifacts count as locally installed. Maven goals the user runs keep
/// plain Maven's behaviour.
pub const LOCAL_REPO_TRACKING_ARG: &str = "-Daether.enhancedLocalRepository.trackingFilename=openidea.repositories";

/// Phases shown under "Lifecycle" (IDEA's default list).
pub const LIFECYCLE: &[&str] =
    &["clean", "validate", "compile", "test", "package", "verify", "install", "site", "deploy"];

/// Every phase of the clean, default and site lifecycles (Execute Maven Goal completion).
pub const ALL_PHASES: &[&str] = &[
    "pre-clean",
    "clean",
    "post-clean",
    "validate",
    "initialize",
    "generate-sources",
    "process-sources",
    "generate-resources",
    "process-resources",
    "compile",
    "process-classes",
    "generate-test-sources",
    "process-test-sources",
    "generate-test-resources",
    "process-test-resources",
    "test-compile",
    "process-test-classes",
    "test",
    "prepare-package",
    "package",
    "pre-integration-test",
    "integration-test",
    "post-integration-test",
    "verify",
    "install",
    "deploy",
    "pre-site",
    "site",
    "post-site",
    "site-deploy",
];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MavenModel {
    /// Pre-order: every aggregator comes before its modules.
    pub projects: Vec<MavenProject>,
    /// Profiles declared by any project, first declaration wins.
    pub profiles: Vec<MavenProfile>,
    /// When the effective build was last read (Unix ms); `None` = only the static POM parse.
    pub synced_at: Option<f64>,
    /// Build files changed since that sync.
    pub stale: bool,
    pub sync_error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MavenProject {
    /// Owning project folder when displayed in a workspace.
    #[specta(optional)]
    pub project_root: Option<String>,
    /// Project-relative, `/`-separated (`pom.xml`, `core/pom.xml`).
    pub pom: String,
    /// Project-relative directory; `""` = the project root.
    pub dir: String,
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
    pub packaging: String,
    /// `<name>` (resolved), else the artifactId.
    pub display_name: String,
    /// `groupId:artifactId:version` of the parent POM.
    pub parent: Option<String>,
    /// `pom` paths of this aggregator's modules.
    pub modules: Vec<String>,
    /// Listed as a module of another project here.
    pub aggregated: bool,
    pub plugins: Vec<MavenPlugin>,
    pub dependencies: Vec<MavenDependency>,
    /// Profile ids declared in this POM.
    pub profiles: Vec<String>,
    /// Java feature version the project compiles for (`maven.compiler.release`, `java.version`…).
    pub java_version: Option<u32>,
    /// Maven launcher: the nearest `mvnw` (absolute), else `mvn`. Inside the opened
    /// project the search stops at its root; outside it, the search stops before
    /// that root so a linked project keeps its own wrapper.
    pub command: String,
    /// Options before the goals (`-s`, `-Dmaven.repo.local=`); filled in by the shell from settings.
    pub options: Vec<String>,
    /// Environment for runs (`JAVA_HOME` of the matching JDK); filled in by the shell.
    pub env: BTreeMap<String, String>,
}

impl MavenProject {
    pub fn key(&self) -> String {
        format!("{}:{}", self.group_id, self.artifact_id)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MavenPlugin {
    pub group_id: String,
    pub artifact_id: String,
    pub version: Option<String>,
    /// Goal prefix (`clean`, `spring-boot`): goals run as `<prefix>:<goal>`.
    pub prefix: String,
    /// Sorted goal names.
    pub goals: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MavenDependency {
    pub group_id: String,
    pub artifact_id: String,
    pub version: Option<String>,
    /// `jar`, `pom`, `test-jar`…
    #[serde(rename = "type")]
    pub kind: String,
    pub classifier: Option<String>,
    pub scope: String,
    pub optional: bool,
    /// Transitive dependencies (only after a sync).
    pub children: Vec<MavenDependency>,
    /// Why Maven left this occurrence out of the resolved graph (`dependency:tree -Dverbose`).
    #[serde(default)]
    #[specta(optional)]
    pub omitted: Option<Omission>,
    /// The version that won when `omitted` is `Conflict`.
    #[serde(default)]
    #[specta(optional)]
    pub conflict_with: Option<String>,
    /// The version requested before `<dependencyManagement>` replaced it.
    #[serde(default)]
    #[specta(optional)]
    pub managed_from: Option<String>,
}

impl MavenDependency {
    /// Part of the resolved graph (not a verbose-tree placeholder for an omitted occurrence).
    pub fn resolved(&self) -> bool {
        self.omitted.is_none()
    }
}

/// Why a dependency occurrence is not part of the resolved graph.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Omission {
    /// Another occurrence of the same version is nearer the root.
    Duplicate,
    /// Another version is nearer the root (or declared first) and wins.
    Conflict,
    /// The artifact depends on itself through this path.
    Cycle,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MavenProfile {
    /// Owning project folder when displayed in a workspace.
    #[specta(optional)]
    pub project_root: Option<String>,
    pub id: String,
    pub active_by_default: bool,
}

// ---------------------------------------------------------------- raw POM

#[derive(Clone, Debug, Default)]
struct ParentRef {
    group_id: String,
    artifact_id: String,
    version: String,
    relative_path: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct RawDep {
    group_id: String,
    artifact_id: String,
    version: Option<String>,
    kind: Option<String>,
    classifier: Option<String>,
    scope: Option<String>,
    optional: bool,
}

impl RawDep {
    fn key(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.group_id,
            self.artifact_id,
            self.kind.as_deref().unwrap_or("jar"),
            self.classifier.as_deref().unwrap_or("")
        )
    }
}

#[derive(Clone, Debug, Default)]
struct RawPlugin {
    group_id: String,
    artifact_id: String,
    version: Option<String>,
    /// Goals bound by `<executions>`.
    goals: Vec<String>,
}

impl RawPlugin {
    fn key(&self) -> String {
        format!("{}:{}", self.group_id, self.artifact_id)
    }
}

#[derive(Clone, Debug, Default)]
struct RawProfile {
    id: String,
    active_by_default: bool,
    modules: Vec<String>,
    properties: Vec<(String, String)>,
    deps: Vec<RawDep>,
    plugins: Vec<RawPlugin>,
}

#[derive(Clone, Debug, Default)]
struct RawPom {
    group_id: Option<String>,
    artifact_id: String,
    version: Option<String>,
    packaging: Option<String>,
    name: Option<String>,
    parent: Option<ParentRef>,
    properties: Vec<(String, String)>,
    modules: Vec<String>,
    deps: Vec<RawDep>,
    managed: Vec<RawDep>,
    plugins: Vec<RawPlugin>,
    managed_plugins: Vec<RawPlugin>,
    profiles: Vec<RawProfile>,
    /// `maven-compiler-plugin` `<release>` / `<source>` of `<build><plugins>`, else of
    /// `<pluginManagement>`.
    compiler_release: Option<String>,
}

fn read_dep(e: &Element) -> Option<RawDep> {
    Some(RawDep {
        group_id: e.text_of("groupId")?,
        artifact_id: e.text_of("artifactId")?,
        version: e.text_of("version"),
        kind: e.text_of("type"),
        classifier: e.text_of("classifier"),
        scope: e.text_of("scope"),
        optional: e.text_of("optional").is_some_and(|o| o == "true"),
    })
}

fn read_plugin(e: &Element) -> Option<RawPlugin> {
    let mut goals: Vec<String> = Vec::new();
    for exec in e.list("executions", "execution") {
        for g in exec.list("goals", "goal") {
            let g = g.text.trim();
            if !g.is_empty() && !goals.iter().any(|x| x == g) {
                goals.push(g.to_owned());
            }
        }
    }
    Some(RawPlugin {
        group_id: e.text_of("groupId").unwrap_or_else(|| "org.apache.maven.plugins".into()),
        artifact_id: e.text_of("artifactId")?,
        version: e.text_of("version"),
        goals,
    })
}

pub(crate) fn read_properties(e: Option<&Element>) -> Vec<(String, String)> {
    e.map(|p| p.children.iter().map(|c| (c.name.clone(), c.text.trim().to_owned())).collect()).unwrap_or_default()
}

fn texts(e: &Element, path: &str, item: &str) -> Vec<String> {
    e.list(path, item).iter().map(|m| m.text.trim().to_owned()).filter(|m| !m.is_empty()).collect()
}

/// Child modules of a project or profile: `<modules>` (model 4.0.0) plus `<subprojects>`,
/// which Maven 4 (model 4.1.0) uses instead.
fn module_names(e: &Element) -> Vec<String> {
    let mut names = texts(e, "modules", "module");
    names.extend(texts(e, "subprojects", "subproject"));
    names
}

fn read_build(e: &Element, plugins: &mut Vec<RawPlugin>, managed: &mut Vec<RawPlugin>) {
    plugins.extend(e.list("build/plugins", "plugin").into_iter().filter_map(read_plugin));
    managed.extend(e.list("build/pluginManagement/plugins", "plugin").into_iter().filter_map(read_plugin));
}

/// `maven-compiler-plugin` `<release>` / `<source>` among the plugins at `path`.
fn compiler_level(project: &Element, path: &str) -> Option<String> {
    project
        .list(path, "plugin")
        .into_iter()
        .find(|p| p.text_of("artifactId").as_deref() == Some("maven-compiler-plugin"))
        .and_then(|p| p.child("configuration"))
        .and_then(|c| c.text_of("release").or_else(|| c.text_of("source")))
}

fn read_raw(project: &Element) -> RawPom {
    let parent = project.child("parent").and_then(|p| {
        Some(ParentRef {
            group_id: p.text_of("groupId")?,
            artifact_id: p.text_of("artifactId")?,
            version: p.text_of("version").unwrap_or_default(),
            // `<relativePath/>` (empty) means "look it up in the repository".
            relative_path: p.child("relativePath").map(|r| r.text.trim().to_owned()),
        })
    });
    let mut pom = RawPom {
        group_id: project.text_of("groupId"),
        artifact_id: project.text_of("artifactId").unwrap_or_default(),
        version: project.text_of("version"),
        packaging: project.text_of("packaging"),
        name: project.text_of("name"),
        parent,
        properties: read_properties(project.child("properties")),
        modules: module_names(project),
        deps: project.list("dependencies", "dependency").into_iter().filter_map(read_dep).collect(),
        managed: project
            .list("dependencyManagement/dependencies", "dependency")
            .into_iter()
            .filter_map(read_dep)
            .collect(),
        ..RawPom::default()
    };
    read_build(project, &mut pom.plugins, &mut pom.managed_plugins);
    pom.compiler_release =
        compiler_level(project, "build/plugins").or_else(|| compiler_level(project, "build/pluginManagement/plugins"));
    for p in project.list("profiles", "profile") {
        let mut profile = RawProfile {
            id: p.text_of("id").unwrap_or_else(|| "default".into()),
            active_by_default: p.at("activation/activeByDefault").is_some_and(|a| a.text.trim() == "true"),
            modules: module_names(p),
            properties: read_properties(p.child("properties")),
            deps: p.list("dependencies", "dependency").into_iter().filter_map(read_dep).collect(),
            ..RawProfile::default()
        };
        let mut managed = Vec::new();
        read_build(p, &mut profile.plugins, &mut managed);
        pom.profiles.push(profile);
    }
    pom
}

fn parse_pom(text: &str) -> Option<RawPom> {
    let root = xml::parse(text)?;
    (root.name == "project").then(|| read_raw(&root))
}

// ---------------------------------------------------------------- properties

/// Replaces `${key}` with `props[key]` (also `pom.x` → `project.x`, `env.X`), repeatedly
/// for nested references; unknown keys are kept as written.
pub(crate) fn interpolate(s: &str, props: &HashMap<String, String>) -> String {
    let mut out = s.to_owned();
    for _ in 0..10 {
        if !out.contains("${") {
            break;
        }
        let mut next = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(i) = rest.find("${") {
            next.push_str(&rest[..i]);
            let tail = &rest[i + 2..];
            let Some(end) = tail.find('}') else {
                next.push_str(&rest[i..]);
                rest = "";
                break;
            };
            let key = &tail[..end];
            let alias = key.strip_prefix("pom.").map(|k| format!("project.{k}"));
            let value = props
                .get(key)
                .or_else(|| alias.as_ref().and_then(|a| props.get(a)))
                .cloned()
                .or_else(|| key.strip_prefix("env.").and_then(|v| std::env::var(v).ok()));
            match value {
                Some(v) => next.push_str(&v),
                None => next.push_str(&rest[i..i + 3 + end]),
            }
            rest = &tail[end + 1..];
        }
        next.push_str(rest);
        if next == out {
            break;
        }
        out = next;
    }
    out
}

// ---------------------------------------------------------------- inheritance

/// Everything a POM inherits, with raw (uninterpolated) values: Maven interpolates
/// after inheritance, so `${project.version}` in a parent means the child's version.
#[derive(Clone, Debug, Default)]
struct Inherited {
    group_id: Option<String>,
    version: Option<String>,
    properties: Vec<(String, String)>,
    deps: Vec<RawDep>,
    managed: Vec<RawDep>,
    plugins: Vec<RawPlugin>,
    managed_plugins: Vec<RawPlugin>,
    /// The nearest `maven-compiler-plugin` `<release>` / `<source>`: a module usually
    /// inherits its compiler level from the parent's (managed) plugin configuration.
    compiler_release: Option<String>,
    /// `<id>`, `activeByDefault`: profiles of the POM and its ancestors —
    /// Maven lets a child enable a parent's profiles with `-P`.
    profiles: Vec<(String, bool)>,
}

fn merge_by<T: Clone>(base: &mut Vec<T>, own: &[T], key: impl Fn(&T) -> String) {
    let mut index: HashMap<String, usize> = base.iter().enumerate().map(|(i, b)| (key(b), i)).collect();
    for item in own {
        match index.get(&key(item)) {
            Some(&i) => base[i] = item.clone(),
            None => {
                index.insert(key(item), base.len());
                base.push(item.clone());
            }
        }
    }
}

fn merge_plugins(base: &mut Vec<RawPlugin>, own: &[RawPlugin]) {
    for p in own {
        match base.iter_mut().find(|b| b.key() == p.key()) {
            Some(b) => {
                if p.version.is_some() {
                    b.version = p.version.clone();
                }
                for g in &p.goals {
                    if !b.goals.contains(g) {
                        b.goals.push(g.clone());
                    }
                }
            }
            None => base.push(p.clone()),
        }
    }
}

const MAX_PARENT_DEPTH: usize = 10;

struct Resolver {
    local_repo: Option<PathBuf>,
    /// The chosen profiles (`-P` entries; `!id` / `-id` deactivates).
    profiles: Vec<String>,
    poms: HashMap<PathBuf, Option<RawPom>>,
    contexts: HashMap<PathBuf, Inherited>,
}

/// `~/.m2/repository`, or `<localRepository>` from `~/.m2/settings.xml`.
pub fn default_local_repo() -> Option<PathBuf> {
    let m2 = dirs::home_dir()?.join(".m2");
    local_repository_of(&m2.join("settings.xml")).or(Some(m2.join("repository")))
}

/// The user `settings.xml` a build reads: the configured one (`~/` and project-relative
/// paths allowed), else `~/.m2/settings.xml`.
pub fn user_settings_file(root: &Path, settings: &ide_core::settings::MavenSettings) -> Option<PathBuf> {
    let configured = settings.user_settings.trim();
    if configured.is_empty() {
        return Some(dirs::home_dir()?.join(".m2").join("settings.xml"));
    }
    let path = match configured.strip_prefix("~/") {
        Some(rest) => dirs::home_dir()?.join(rest),
        None => PathBuf::from(configured),
    };
    Some(if path.is_absolute() { path } else { root.join(path) })
}

/// The profiles a `settings.xml` defines, for the Profiles list beside the POMs' own (as
/// IDEA lists them): checked by default when `<activeProfiles>` names them or they are
/// `activeByDefault`.
pub fn settings_profiles(settings: &Path) -> Vec<MavenProfile> {
    let Some(root) = xml::read_text(settings).as_deref().and_then(xml::parse) else {
        return Vec::new();
    };
    let active: Vec<String> =
        root.list("activeProfiles", "activeProfile").iter().map(|e| e.text.trim().to_owned()).collect();
    let mut profiles: Vec<MavenProfile> = Vec::new();
    for profile in root.list("profiles", "profile") {
        let Some(id) = profile.text_of("id") else { continue };
        if profiles.iter().any(|p| p.id == id) {
            continue;
        }
        let by_default = profile.at("activation/activeByDefault").is_some_and(|e| e.text.trim() == "true");
        profiles.push(MavenProfile { active_by_default: by_default || active.contains(&id), id, ..Default::default() });
    }
    profiles
}

/// `<localRepository>` of a settings file, when it names one: the repository a build
/// with `-s <file>` resolves into, which is not necessarily the user's default.
pub fn local_repository_of(settings: &Path) -> Option<PathBuf> {
    let text = xml::read_text(settings)?;
    let root = xml::parse(&text)?;
    let repo = root.text_of("localRepository")?.trim().to_owned();
    if repo.is_empty() {
        return None;
    }
    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
    Some(PathBuf::from(repo.replace("${user.home}", &home)))
}

impl Resolver {
    fn new(local_repo: Option<PathBuf>, profiles: &[String]) -> Self {
        Self { local_repo, profiles: profiles.to_vec(), poms: HashMap::new(), contexts: HashMap::new() }
    }

    /// The active profiles of a POM: the chosen ones, and the `activeByDefault` ones not turned
    /// off while none of the POM's other profiles is chosen (Maven's rule).
    fn active<'a>(&self, profiles: &'a [RawProfile]) -> impl Iterator<Item = &'a RawProfile> {
        let chosen = |id: &str| profile_choice(&self.profiles, id);
        let any_chosen = profiles.iter().any(|p| chosen(&p.id) == Some(true));
        profiles.iter().filter(move |p| chosen(&p.id).unwrap_or(p.active_by_default && !any_chosen))
    }

    fn pom(&mut self, path: &Path) -> Option<RawPom> {
        self.poms
            .entry(path.to_path_buf())
            .or_insert_with(|| xml::read_text(path).as_deref().and_then(parse_pom))
            .clone()
    }

    fn repo_pom(&self, group: &str, artifact: &str, version: &str) -> Option<PathBuf> {
        if version.is_empty() || version.contains("${") {
            return None;
        }
        let mut p = self.local_repo.clone()?;
        p.extend(group.split('.'));
        p.push(artifact);
        p.push(version);
        p.push(format!("{artifact}-{version}.pom"));
        p.is_file().then_some(p)
    }

    /// The parent POM file of the POM in `dir`: in the project via `relativePath`
    /// (default `../pom.xml`) when its coordinates match, else in the local repository.
    fn parent_path(&mut self, dir: &Path, parent: &ParentRef) -> Option<PathBuf> {
        let rel = parent.relative_path.clone().unwrap_or_else(|| "../pom.xml".into());
        if !rel.is_empty() {
            let mut candidate = dir.join(&rel);
            if candidate.is_dir() {
                candidate.push("pom.xml");
            }
            if let Some(p) = self.pom(&candidate) {
                let group = p.group_id.clone().or_else(|| p.parent.as_ref().map(|pp| pp.group_id.clone()));
                if p.artifact_id == parent.artifact_id && group.as_deref() == Some(parent.group_id.as_str()) {
                    return Some(candidate);
                }
            }
        }
        self.repo_pom(&parent.group_id, &parent.artifact_id, &parent.version)
    }

    /// What the POM at `path` hands down to its children (its parents' plus its own).
    fn context(&mut self, path: &Path, depth: usize) -> Inherited {
        if let Some(c) = self.contexts.get(path) {
            return c.clone();
        }
        let Some(pom) = self.pom(path) else { return Inherited::default() };
        let dir = path.parent().unwrap_or(Path::new("")).to_path_buf();
        let mut ctx = match &pom.parent {
            Some(parent) if depth < MAX_PARENT_DEPTH => match self.parent_path(&dir, parent) {
                Some(pp) => self.context(&pp, depth + 1),
                None => Inherited::default(),
            },
            _ => Inherited::default(),
        };
        let parent_ref = pom.parent.clone().unwrap_or_default();
        ctx.group_id = pom.group_id.clone().or(ctx.group_id).or(Some(parent_ref.group_id.clone()));
        ctx.version = pom.version.clone().or(ctx.version).or(Some(parent_ref.version.clone()));
        merge_by(&mut ctx.properties, &pom.properties, |(k, _)| k.clone());
        merge_by(&mut ctx.deps, &pom.deps, RawDep::key);
        merge_plugins(&mut ctx.plugins, &pom.plugins);
        merge_plugins(&mut ctx.managed_plugins, &pom.managed_plugins);
        if pom.compiler_release.is_some() {
            ctx.compiler_release = pom.compiler_release.clone();
        }
        for p in self.active(&pom.profiles) {
            merge_by(&mut ctx.properties, &p.properties, |(k, _)| k.clone());
            merge_by(&mut ctx.deps, &p.deps, RawDep::key);
            merge_plugins(&mut ctx.plugins, &p.plugins);
        }
        merge_by(
            &mut ctx.profiles,
            &pom.profiles.iter().map(|p| (p.id.clone(), p.active_by_default)).collect::<Vec<_>>(),
            |(id, _)| id.clone(),
        );
        // Managed dependencies: own entries win; imported BOMs fill the gaps.
        let props = self.properties_for(&pom, &ctx, &dir);
        let mut imported: Vec<RawDep> = Vec::new();
        for m in &pom.managed {
            if m.scope.as_deref() == Some("import") && depth < MAX_PARENT_DEPTH {
                let (g, a) = (interpolate(&m.group_id, &props), interpolate(&m.artifact_id, &props));
                let v = interpolate(m.version.as_deref().unwrap_or_default(), &props);
                if let Some(bom) = self.repo_pom(&g, &a, &v) {
                    imported.extend(self.resolved_managed(&bom, depth + 1));
                }
            }
        }
        let own: Vec<RawDep> = pom.managed.iter().filter(|m| m.scope.as_deref() != Some("import")).cloned().collect();
        merge_by(&mut ctx.managed, &own, RawDep::key);
        let mut known: HashSet<String> = ctx.managed.iter().map(RawDep::key).collect();
        for d in imported {
            if known.insert(d.key()) {
                ctx.managed.push(d);
            }
        }
        self.contexts.insert(path.to_path_buf(), ctx.clone());
        ctx
    }

    /// Managed dependencies of a BOM, interpolated with the BOM's own properties.
    fn resolved_managed(&mut self, bom: &Path, depth: usize) -> Vec<RawDep> {
        let ctx = self.context(bom, depth);
        let Some(pom) = self.pom(bom) else { return Vec::new() };
        let dir = bom.parent().unwrap_or(Path::new("")).to_path_buf();
        let props = self.properties_for(&pom, &ctx, &dir);
        ctx.managed
            .iter()
            .map(|d| RawDep {
                group_id: interpolate(&d.group_id, &props),
                artifact_id: interpolate(&d.artifact_id, &props),
                version: d.version.as_deref().map(|v| interpolate(v, &props)),
                ..d.clone()
            })
            .collect()
    }

    /// Properties visible in `pom`: inherited and own `<properties>` plus `project.*` built-ins.
    fn properties_for(&self, pom: &RawPom, ctx: &Inherited, dir: &Path) -> HashMap<String, String> {
        let mut props: HashMap<String, String> = ctx.properties.iter().cloned().collect();
        let group = pom.group_id.clone().or(ctx.group_id.clone()).unwrap_or_default();
        let version = pom.version.clone().or(ctx.version.clone()).unwrap_or_default();
        let basedir = dir.to_string_lossy().into_owned();
        let mut set = |k: &str, v: &str| {
            props.insert(k.to_owned(), v.to_owned());
        };
        set("project.groupId", &group);
        set("project.artifactId", &pom.artifact_id);
        set("project.version", &version);
        set("project.packaging", pom.packaging.as_deref().unwrap_or("jar"));
        set("project.basedir", &basedir);
        set("basedir", &basedir);
        set("project.build.directory", &format!("{basedir}/target"));
        if let Some(name) = &pom.name {
            set("project.name", name);
        }
        if let Some(p) = &pom.parent {
            set("project.parent.groupId", &p.group_id);
            set("project.parent.artifactId", &p.artifact_id);
            set("project.parent.version", &p.version);
            set("parent.version", &p.version);
        }
        props
    }
}

/// Files and source/resource trees consumed by a launch build. Unresolved custom
/// roots disable reuse rather than silently omitting an input.
pub(crate) fn launch_inputs(
    root: &Path,
    projects: &[&MavenProject],
    local_repo: Option<PathBuf>,
) -> Option<Vec<PathBuf>> {
    fn roots(el: &Element, parent: &str, dir: &Path, out: &mut Vec<PathBuf>) -> Option<()> {
        let input =
            matches!(el.name.as_str(), "sourceDirectory" | "testSourceDirectory" | "sourceDir" | "testSourceDir")
                || (matches!(parent, "sources" | "sourceDirs" | "testSources" | "testSourceDirs")
                    && matches!(el.name.as_str(), "source" | "sourceDir" | "testSourceDir"))
                || (matches!(parent, "resource" | "testResource" | "source" | "testSource") && el.name == "directory")
                || (parent == "filters" && el.name == "filter");
        // Profile activation may depend on the presence of an otherwise unrelated file.
        let activation = parent == "file" && matches!(el.name.as_str(), "exists" | "missing");
        if input || activation {
            // Other properties can be overridden by -D, profiles or settings.
            // Without Maven's effective roots, conservatively disable reuse for them.
            let value = el
                .text
                .trim()
                .replace("${project.basedir}", &dir.to_string_lossy())
                .replace("${basedir}", &dir.to_string_lossy());
            if value.contains("${") {
                return None;
            }
            if !value.is_empty() {
                out.push(dir.join(value));
            }
        }
        for child in &el.children {
            roots(child, &el.name, dir, out)?;
        }
        Some(())
    }
    let mut resolver = Resolver::new(local_repo.or_else(default_local_repo), &[]);
    let mut out = Vec::new();
    for project in projects {
        let dir = root.join(&project.dir);
        // Include all conventional language/resource roots, including nonstandard files under src.
        out.push(dir.join("src"));
        let pom = root.join(&project.pom);
        resolver.context(&pom, 0);
        let mut path = pom;
        let mut seen = HashSet::new();
        loop {
            let canonical = dunce::canonicalize(&path).ok()?;
            if !seen.insert(canonical) || seen.len() > MAX_PARENT_DEPTH {
                return None;
            }
            out.push(path.clone());
            let text = xml::read_text(&path)?;
            roots(&xml::parse(&text)?, "", &dir, &mut out)?;
            let raw = resolver.pom(&path)?;
            let Some(parent) = raw.parent else { break };
            path = resolver.parent_path(path.parent()?, &parent)?;
        }
    }
    // Also track imported BOMs read while resolving inheritance.
    out.extend(resolver.poms.into_keys());
    out.sort();
    out.dedup();
    Some(out)
}

// ---------------------------------------------------------------- plugins

/// `maven-clean-plugin` → `clean`, `spring-boot-maven-plugin` → `spring-boot`.
pub fn goal_prefix(artifact_id: &str) -> String {
    if let Some(p) = artifact_id.strip_prefix("maven-").and_then(|r| r.strip_suffix("-plugin")) {
        return p.to_owned();
    }
    if let Some(p) = artifact_id.strip_suffix("-maven-plugin") {
        return p.to_owned();
    }
    artifact_id.strip_suffix("-plugin").unwrap_or(artifact_id).to_owned()
}

/// Goals of every plugin jar read so far, by the path of that jar.
static DESCRIPTOR: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();

/// `<goal>` names of the plugin descriptor inside its jar (`META-INF/maven/plugin.xml`),
/// which is where Maven itself takes the list `plugin:help` prints. Empty when the jar
/// is not in the local repository yet.
fn descriptor_goals(repo: &Path, group_id: &str, artifact_id: &str, version: &str) -> Vec<String> {
    // Keyed by the jar itself, not by its coordinates: a repository can be replaced
    // between runs, and a test's empty repository must not answer for another's.
    // One `push` per group segment: the layout is `<repo>/<group as directories>/…` on
    // every platform, Windows' separator included.
    let mut dir = repo.to_path_buf();
    dir.extend(group_id.split('.'));
    dir.push(artifact_id);
    dir.push(version);
    let Some(jar) = plugin_jar(&dir, artifact_id, version) else { return Vec::new() };
    let key = jar.to_string_lossy().into_owned();
    let cache = DESCRIPTOR.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cached) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return cached.clone();
    }
    // A failed read is not remembered: the jar may be half written by Maven right now.
    let Some(goals) = read_descriptor(&jar) else { return Vec::new() };
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(key, goals.clone());
    goals
}

/// The plugin's jar in its version directory: `<artifactId>-<version>.jar`, or — for a
/// SNAPSHOT installed from a repository, whose file name carries a timestamp — the newest
/// `<artifactId>-*.jar` that is neither sources nor javadoc.
fn plugin_jar(dir: &Path, artifact_id: &str, version: &str) -> Option<PathBuf> {
    let exact = dir.join(format!("{artifact_id}-{version}.jar"));
    if exact.is_file() {
        return Some(exact);
    }
    let prefix = format!("{artifact_id}-");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !name.starts_with(&prefix) || !name.ends_with(".jar") || name.ends_with("-sources.jar") {
            continue;
        }
        if name.ends_with("-javadoc.jar") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else { continue };
        if best.as_ref().is_none_or(|(at, _)| modified > *at) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, p)| p)
}

fn read_descriptor(jar: &Path) -> Option<Vec<String>> {
    let file = std::fs::File::open(jar).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name("META-INF/maven/plugin.xml").ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    let root = xml::parse(&text)?;
    let mut goals: Vec<String> =
        root.list("mojos", "mojo").iter().filter_map(|m| m.text_of("goal")).map(|g| g.trim().to_owned()).collect();
    goals.retain(|g| !g.is_empty());
    goals.sort();
    goals.dedup();
    Some(goals)
}

/// Goals of well-known plugins, for a jar that is not in the local repository yet.
fn known_goals(artifact_id: &str) -> &'static [&'static str] {
    match artifact_id {
        "maven-clean-plugin" => &["clean", "help"],
        "maven-resources-plugin" => &["copy-resources", "help", "resources", "testResources"],
        "maven-compiler-plugin" => &["compile", "help", "testCompile"],
        "maven-surefire-plugin" => &["help", "test"],
        "maven-failsafe-plugin" => &["help", "integration-test", "verify"],
        "maven-jar-plugin" => &["help", "jar", "test-jar"],
        "maven-war-plugin" => &["exploded", "help", "inplace", "war"],
        "maven-ear-plugin" => &["ear", "generate-application-xml", "help"],
        "maven-install-plugin" => &["help", "install", "install-file"],
        "maven-deploy-plugin" => &["deploy", "deploy-file", "help"],
        "maven-site-plugin" => {
            &["attach-descriptor", "deploy", "effective-site", "help", "jar", "run", "site", "stage", "stage-deploy"]
        }
        "maven-source-plugin" => &["aggregate", "help", "jar", "jar-no-fork", "test-jar", "test-jar-no-fork"],
        "maven-javadoc-plugin" => {
            &["aggregate", "aggregate-jar", "fix", "help", "jar", "javadoc", "test-jar", "test-javadoc"]
        }
        "maven-dependency-plugin" => &[
            "analyze",
            "analyze-dep-mgt",
            "build-classpath",
            "copy",
            "copy-dependencies",
            "get",
            "go-offline",
            "help",
            "list",
            "properties",
            "purge-local-repository",
            "resolve",
            "resolve-plugins",
            "sources",
            "tree",
            "unpack",
            "unpack-dependencies",
        ],
        "maven-help-plugin" => &[
            "active-profiles",
            "all-profiles",
            "describe",
            "effective-pom",
            "effective-settings",
            "evaluate",
            "help",
            "system",
        ],
        "maven-enforcer-plugin" => &["display-info", "enforce", "help"],
        "maven-shade-plugin" => &["help", "shade"],
        "maven-assembly-plugin" => &["help", "single"],
        "maven-antrun-plugin" => &["help", "run"],
        "maven-release-plugin" => {
            &["branch", "clean", "help", "perform", "prepare", "rollback", "stage", "update-versions"]
        }
        "maven-plugin-plugin" => &["addPluginArtifactMetadata", "descriptor", "help", "helpmojo", "report"],
        "maven-gpg-plugin" => &["help", "sign", "sign-and-deploy-file"],
        "spring-boot-maven-plugin" => &[
            "build-image",
            "build-image-no-fork",
            "build-info",
            "help",
            "process-aot",
            "process-test-aot",
            "repackage",
            "run",
            "start",
            "stop",
            "test-run",
        ],
        "exec-maven-plugin" => &["exec", "help", "java"],
        "jacoco-maven-plugin" => &[
            "check",
            "dump",
            "help",
            "instrument",
            "merge",
            "prepare-agent",
            "prepare-agent-integration",
            "report",
            "restore-instrumented-classes",
        ],
        "build-helper-maven-plugin" => &[
            "add-resource",
            "add-source",
            "add-test-resource",
            "add-test-source",
            "attach-artifact",
            "help",
            "parse-version",
            "regex-property",
            "reserve-network-port",
            "timestamp-property",
        ],
        "versions-maven-plugin" => &[
            "display-dependency-updates",
            "display-plugin-updates",
            "display-property-updates",
            "help",
            "set",
            "update-parent",
            "update-properties",
            "use-latest-releases",
        ],
        "kotlin-maven-plugin" => &["compile", "help", "kapt", "test-compile", "test-kapt"],
        "flatten-maven-plugin" => &["clean", "flatten", "help"],
        "native-maven-plugin" => {
            &["add-reachability-metadata", "compile", "compile-no-fork", "generate-metadata", "help", "test"]
        }
        _ => &[],
    }
}

/// Plugins Maven binds to the default lifecycle of `packaging` (plus clean and site).
fn lifecycle_plugins(packaging: &str) -> &'static [&'static str] {
    match packaging {
        "pom" => &["maven-clean-plugin", "maven-install-plugin", "maven-deploy-plugin", "maven-site-plugin"],
        "war" => &[
            "maven-clean-plugin",
            "maven-resources-plugin",
            "maven-compiler-plugin",
            "maven-surefire-plugin",
            "maven-war-plugin",
            "maven-install-plugin",
            "maven-deploy-plugin",
            "maven-site-plugin",
        ],
        "maven-plugin" => &[
            "maven-clean-plugin",
            "maven-resources-plugin",
            "maven-compiler-plugin",
            "maven-plugin-plugin",
            "maven-surefire-plugin",
            "maven-jar-plugin",
            "maven-install-plugin",
            "maven-deploy-plugin",
            "maven-site-plugin",
        ],
        _ => &[
            "maven-clean-plugin",
            "maven-resources-plugin",
            "maven-compiler-plugin",
            "maven-surefire-plugin",
            "maven-jar-plugin",
            "maven-install-plugin",
            "maven-deploy-plugin",
            "maven-site-plugin",
        ],
    }
}

/// A plugin as shown in the tree: the goals its jar declares, the ones known by name for
/// the common plugins, and the ones the project binds in `<executions>`, sorted. IDEA lists
/// a plugin's goals the same way, which is why a plugin outside the table (checkstyle, say)
/// still shows every goal it offers instead of only the bound one.
pub(crate) fn plugin(
    group_id: &str,
    artifact_id: &str,
    version: Option<String>,
    goals: &[String],
    local_repo: Option<&Path>,
) -> MavenPlugin {
    let mut all: Vec<String> = known_goals(artifact_id).iter().map(|g| (*g).to_owned()).collect();
    let repo = local_repo.map(Path::to_path_buf).or_else(default_local_repo);
    // An unresolved `${…}` version names no jar: the table and the bound goals stand in.
    if let (Some(repo), Some(version)) = (repo.as_deref(), version.as_deref().filter(|v| !v.contains("${"))) {
        for g in descriptor_goals(repo, group_id, artifact_id, version) {
            if !all.contains(&g) {
                all.push(g);
            }
        }
    }
    for g in goals {
        if !all.contains(g) {
            all.push(g.clone());
        }
    }
    all.sort();
    MavenPlugin {
        group_id: group_id.to_owned(),
        artifact_id: artifact_id.to_owned(),
        version,
        prefix: goal_prefix(artifact_id),
        goals: all,
    }
}

// ---------------------------------------------------------------- loading

const MAX_PROJECTS: usize = 1000;

/// The POMs that are not modules of another one: the root `pom.xml`, else the
/// shallowest `pom.xml` of each branch (a folder holding several builds). An
/// aggregate POM directly inside `src/` counts too (issue #1001: `src/pom.xml`
/// with its modules beside it, `src/app/pom.xml` and so on).
fn top_level_poms(root: &Path) -> Vec<PathBuf> {
    ide_core::project_roots::discover(root, &["pom.xml"]).into_iter().map(|dir| dir.join("pom.xml")).collect()
}

/// Whether `root` holds a Maven build (cheap: the same search as [`load`] without parsing).
pub fn is_maven_project(root: &Path) -> bool {
    !top_level_poms(root).is_empty()
}

/// The `mvnw` nearest to `dir`. Inside `root` the walk stops at `root`. Outside it,
/// the walk stops before entering `root` or any ancestor of `root`: a sibling project
/// keeps its own wrapper, and the search does not continue to the filesystem root.
fn wrapper(root: &Path, dir: &Path) -> String {
    let name = if cfg!(windows) { "mvnw.cmd" } else { "mvnw" };
    let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let dir = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let external = !dir.starts_with(&root);
    let mut cur = Some(dir.as_path());
    while let Some(d) = cur {
        if d.join(name).is_file() {
            return d.join(name).to_string_lossy().into_owned();
        }
        if !external && d == root {
            break;
        }
        let Some(parent) = d.parent() else { break };
        // `parent` inside the opened project, or an ancestor of it (the common parent,
        // then the filesystem root). Stop before inspecting those.
        if external && (parent.starts_with(&root) || root.starts_with(parent)) {
            break;
        }
        cur = Some(parent);
    }
    if cfg!(windows) { "mvn.cmd".into() } else { "mvn".into() }
}

fn java_version(v: &str) -> Option<u32> {
    let v = v.trim();
    let mut parts = v.split('.');
    let first: u32 = parts.next()?.trim().parse().ok()?;
    if first == 1 { parts.next()?.trim().parse().ok() } else { Some(first) }
}

/// Reads every Maven project under `root` from its POMs (no Maven run).
pub fn load(root: &Path) -> MavenModel {
    load_with_repo(root, default_local_repo())
}

/// [`load`] with the POMs `settings` link (Add Maven Projects).
pub fn load_linked(root: &Path, settings: &ide_core::settings::MavenSettings) -> MavenModel {
    load_with_linked(root, default_local_repo(), &settings.profiles(&[]), &settings.linked_projects)
}

pub(crate) fn load_with_repo(root: &Path, local_repo: Option<PathBuf>) -> MavenModel {
    load_with(root, local_repo, &[])
}

/// The `-P` entries' choice for profile `id`: on, off (`!id` / `-id`), or none (the last wins).
fn profile_choice(chosen: &[String], id: &str) -> Option<bool> {
    chosen.iter().rev().find_map(|c| {
        let c = c.trim();
        if c == id {
            Some(true)
        } else if c.strip_prefix('!').or_else(|| c.strip_prefix('-')) == Some(id) {
            Some(false)
        } else {
            None
        }
    })
}

pub(crate) fn load_with(root: &Path, local_repo: Option<PathBuf>, profiles: &[String]) -> MavenModel {
    load_with_linked(root, local_repo, profiles, &[])
}

/// The `pom.xml` files `linked` names. Each entry is used as written (project-relative,
/// `../sibling/pom.xml`, or absolute) and canonicalized; a path that is not an existing
/// `pom.xml` is skipped. Nothing here lists a directory or walks parents looking for builds.
fn linked_poms(root: &Path, linked: &[String]) -> Vec<PathBuf> {
    let base = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut out: Vec<PathBuf> = Vec::new();
    for pom in linked {
        let Some(path) = dunce::canonicalize(base.join(pom.trim())).ok() else { continue };
        if is_pom_file(&path) && !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

fn is_pom_file(path: &Path) -> bool {
    path.is_file()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| if cfg!(windows) { name.eq_ignore_ascii_case("pom.xml") } else { name == "pom.xml" })
}

/// Identity of `path` (both canonical) within `root`: project-relative inside it,
/// otherwise the absolute path with forward slashes.
fn project_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// Canonical `pom.xml` paths named by `linked`, keyed by the spelling to store and to
/// show so unlink removes the same entry settings hold. The first spelling wins.
fn linked_identities(root: &Path, linked: &[String]) -> HashMap<PathBuf, String> {
    let mut out = HashMap::new();
    for entry in linked {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some(path) = dunce::canonicalize(root.join(entry)).ok() else { continue };
        if is_pom_file(&path) {
            out.entry(path).or_insert_with(|| entry.replace('\\', "/"));
        }
    }
    out
}

/// Stable, deduplicated form of `poms` for `languages.java.maven.linkedProjects`.
/// An existing `pom.xml` inside `root` is project-relative; one outside it is the
/// canonical absolute path. Spellings of the same file (`../B/pom.xml`, an absolute
/// path, a symlink) collapse to one entry. A path that exists and is not a `pom.xml`
/// is dropped. A `pom.xml` that cannot be resolved yet is kept, so a link is not
/// discarded while its volume is offline. No directory is scanned.
pub fn normalize_linked_poms(root: &Path, poms: &[String]) -> Vec<String> {
    let Some(root) = dunce::canonicalize(root).ok() else {
        let mut out = Vec::new();
        for pom in poms {
            let pom = normalized_pom(pom);
            if !pom.is_empty() && pom_name_ok(&pom) && !out.contains(&pom) {
                out.push(pom);
            }
        }
        return out;
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for pom in poms {
        let pom = pom.trim();
        if pom.is_empty() {
            continue;
        }
        let key = match dunce::canonicalize(root.join(pom)) {
            Ok(path) if is_pom_file(&path) => project_rel(&root, &path),
            Ok(_) => continue,
            Err(_) => {
                let fallback = normalized_pom(pom);
                let joined = root.join(pom);
                if !pom_name_ok(&fallback) || (joined.exists() && !is_pom_file(&joined)) {
                    continue;
                }
                fallback
            }
        };
        if key.is_empty() || !seen.insert(key.clone()) {
            continue;
        }
        out.push(key);
    }
    out
}

fn pom_name_ok(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    if cfg!(windows) { name.eq_ignore_ascii_case("pom.xml") } else { name == "pom.xml" }
}

/// Directories of linked `pom.xml` files that sit outside `root` (the opened project
/// stays the root). Callers keep the outermost directory only. Modules a POM declares
/// outside its own directory are not included: a linked file cannot widen the indexed
/// tree to an arbitrary path.
pub fn external_pom_dirs(root: &Path, linked: &[String]) -> Vec<PathBuf> {
    let base = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut out = Vec::new();
    for pom in linked_poms(root, linked) {
        let Some(dir) = pom.parent() else { continue };
        if dir.starts_with(&base) || out.iter().any(|have| have == dir) {
            continue;
        }
        out.push(dir.to_path_buf());
    }
    out
}

/// Whether `root` holds a Maven build or the settings link one inside it.
pub fn has_projects(root: &Path, settings: &ide_core::settings::MavenSettings) -> bool {
    is_maven_project(root) || !linked_poms(root, &settings.linked_projects).is_empty()
}

/// The model with the chosen `profiles` (`-P` entries; `!id` deactivates: their modules,
/// dependencies and properties are part of the model, those turned off are not) and the
/// `linked` POMs (Add Maven Projects): builds that no reactor lists, shown as independent
/// top-level projects, including a `pom.xml` outside the opened root. A linked POM that
/// turns out to be a module of the root reactor stays that module. The same canonical file
/// is loaded once, so a cycle or a second spelling does not duplicate it or edit either POM.
pub fn load_with_linked(
    root: &Path,
    local_repo: Option<PathBuf>,
    profiles: &[String],
    linked: &[String],
) -> MavenModel {
    let mut resolver = Resolver::new(local_repo, profiles);
    let mut model = MavenModel::default();
    // Canonical POM → its project, for a module listed again by a later aggregator.
    let mut seen: HashMap<PathBuf, Option<usize>> = HashMap::new();
    let canonical_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let linked_ids = linked_identities(&canonical_root, linked);
    let mut tops = top_level_poms(root);
    for pom in linked_poms(root, linked) {
        if !tops.contains(&pom) {
            tops.push(pom);
        }
    }
    // (pom, aggregated); the root reactor and its modules come before linked POMs.
    // (pom, listed by): a module carries the top-level project its chain started from and
    // whether the aggregator listing it lies inside the opened root.
    let mut stack: Vec<(PathBuf, Option<(usize, bool)>)> = tops.into_iter().rev().map(|p| (p, None)).collect();
    while let Some((path, listed_by)) = stack.pop() {
        let aggregated = listed_by.is_some();
        if model.projects.len() >= MAX_PROJECTS {
            break;
        }
        let canonical = dunce::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if let Some(known) = seen.get(&canonical) {
            // Found as a top-level POM first, then listed by an aggregator elsewhere
            // (`<module>../</module>` of `parent/pom.xml`): it is that aggregator's module.
            // Not when the chain leads back to where it started (a cycle), and not for an
            // aggregator outside the opened root: a linked sibling does not take it over.
            if let (Some(known), Some((origin, true))) = (*known, listed_by)
                && known != origin
            {
                model.projects[known].aggregated = true;
            }
            continue;
        }
        seen.insert(canonical.clone(), None);
        let Some(pom) = resolver.pom(&path) else { continue };
        let dir = path.parent().unwrap_or(root).to_path_buf();
        let dir_canon = dunce::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        let ctx = resolver.context(&path, 0);
        let props = resolver.properties_for(&pom, &ctx, &dir);
        let i = |s: &str| interpolate(s, &props);

        let mut module_names: Vec<String> = pom.modules.clone();
        for p in resolver.active(&pom.profiles) {
            module_names.extend(p.modules.iter().cloned());
        }
        let mut modules: Vec<PathBuf> = Vec::new();
        for m in module_names {
            let mut mp = crate::gradle::normalize(&dir.join(i(&m)));
            if mp.is_dir() || mp.extension().is_none_or(|e| e != "xml") {
                mp.push("pom.xml");
            }
            if mp.is_file() && !modules.contains(&mp) {
                modules.push(mp);
            }
        }

        let packaging = i(pom.packaging.as_deref().unwrap_or("jar"));
        let managed: HashMap<String, &RawDep> = ctx.managed.iter().map(|m| (m.key(), m)).collect();
        let managed_version = |d: &RawDep| managed.get(&d.key()).and_then(|m| m.version.clone());
        let managed_scope = |d: &RawDep| managed.get(&d.key()).and_then(|m| m.scope.clone());
        let dependencies = ctx
            .deps
            .iter()
            .map(|d| MavenDependency {
                group_id: i(&d.group_id),
                artifact_id: i(&d.artifact_id),
                version: d.version.clone().or_else(|| managed_version(d)).map(|v| i(&v)),
                kind: d.kind.clone().unwrap_or_else(|| "jar".into()),
                classifier: d.classifier.clone(),
                scope: d.scope.clone().or_else(|| managed_scope(d)).unwrap_or_else(|| "compile".into()),
                optional: d.optional,
                ..MavenDependency::default()
            })
            .collect();

        let mut plugins: Vec<RawPlugin> = ctx.plugins.clone();
        for a in lifecycle_plugins(&packaging) {
            if !plugins.iter().any(|p| p.artifact_id == *a) {
                plugins.push(RawPlugin {
                    group_id: "org.apache.maven.plugins".into(),
                    artifact_id: (*a).into(),
                    ..RawPlugin::default()
                });
            }
        }
        let plugins = plugins
            .iter()
            .map(|p| {
                let version = p
                    .version
                    .clone()
                    .or_else(|| ctx.managed_plugins.iter().find(|m| m.key() == p.key()).and_then(|m| m.version.clone()))
                    .map(|v| i(&v))
                    .filter(|v| !v.contains("${"));
                plugin(&i(&p.group_id), &i(&p.artifact_id), version, &p.goals, resolver.local_repo.as_deref())
            })
            .collect();

        let jv = ["maven.compiler.release", "java.version", "maven.compiler.source", "maven.compiler.target"]
            .iter()
            .find_map(|k| props.get(*k).map(|v| i(v)))
            .or_else(|| ctx.compiler_release.as_deref().map(i))
            .and_then(|v| java_version(&v));

        // The project can activate the profiles of its own POM and its ancestors'.
        for (id, active) in &ctx.profiles {
            if !model.profiles.iter().any(|x| x.id == *id) {
                model.profiles.push(MavenProfile { id: id.clone(), active_by_default: *active, ..Default::default() });
            }
        }
        let artifact_id = i(&pom.artifact_id);
        let module_ids: Vec<String> = modules
            .iter()
            .map(|m| {
                let canonical = dunce::canonicalize(m).unwrap_or_else(|_| m.clone());
                linked_ids.get(&canonical).cloned().unwrap_or_else(|| project_rel(&canonical_root, &canonical))
            })
            .collect();
        model.projects.push(MavenProject {
            project_root: None,
            pom: linked_ids.get(&canonical).cloned().unwrap_or_else(|| project_rel(&canonical_root, &canonical)),
            dir: project_rel(&canonical_root, &dir_canon),
            group_id: i(props.get("project.groupId").map(String::as_str).unwrap_or_default()),
            version: i(props.get("project.version").map(String::as_str).unwrap_or_default()),
            display_name: pom.name.as_deref().map(i).filter(|n| !n.is_empty()).unwrap_or_else(|| artifact_id.clone()),
            artifact_id,
            packaging,
            parent: pom.parent.as_ref().map(|p| format!("{}:{}:{}", p.group_id, p.artifact_id, i(&p.version))),
            modules: module_ids,
            aggregated,
            plugins,
            dependencies,
            profiles: ctx.profiles.iter().map(|(id, _)| id.clone()).collect(),
            java_version: jv,
            command: wrapper(&canonical_root, &dir_canon),
            options: Vec::new(),
            env: BTreeMap::new(),
        });
        let index = model.projects.len() - 1;
        seen.insert(canonical, Some(index));
        let origin = listed_by.map_or(index, |(origin, _)| origin);
        let inside = dir_canon.starts_with(&canonical_root);
        for m in modules.into_iter().rev() {
            stack.push((m, Some((origin, inside))));
        }
    }
    model
}

/// Shared linkage decision for every Maven consumer, including modules outside a reactor directory.
#[derive(Default)]
pub struct UnlinkedProjects {
    poms: std::collections::BTreeSet<String>,
}

impl UnlinkedProjects {
    pub fn load(root: &Path, settings: &ide_core::settings::MavenSettings) -> Self {
        if settings.unlinked_projects.is_empty() {
            return Self::default();
        }
        Self::from_model(&load_linked(root, settings), settings)
    }

    pub fn from_model(model: &MavenModel, settings: &ide_core::settings::MavenSettings) -> Self {
        let mut result = Self::default();
        let mut pending = settings.unlinked_projects.clone();
        while let Some(pom) = pending.pop() {
            let pom = normalized_pom(&pom);
            if !result.poms.insert(pom.clone()) {
                continue;
            }
            if let Some(project) = model.projects.iter().find(|p| normalized_pom(&p.pom) == pom) {
                pending.extend(project.modules.iter().cloned());
            }
        }
        result
    }

    pub fn contains(&self, pom: &str) -> bool {
        self.poms.contains(&normalized_pom(pom))
    }

    pub fn poms(&self) -> impl Iterator<Item = &str> {
        self.poms.iter().map(String::as_str)
    }

    /// The POMs the Java language server should import when an unlinked POM is a module of a
    /// linked reactor, else `None` (excluding the unlinked directories is enough then).
    ///
    /// jdtls imports an aggregator together with all of its modules, whatever its import
    /// exclusions say, so a reactor keeping an unlinked module is left out; its other linked
    /// modules are listed on their own. Such an aggregator (`pom` packaging) has no sources.
    pub fn import_poms(&self, model: &MavenModel) -> Option<Vec<String>> {
        let linked: Vec<&MavenProject> = model.projects.iter().filter(|p| !self.contains(&p.pom)).collect();
        if !linked.iter().any(|p| p.modules.iter().any(|m| self.contains(m))) {
            return None;
        }
        let by_pom: std::collections::HashMap<String, &MavenProject> =
            model.projects.iter().map(|p| (normalized_pom(&p.pom), p)).collect();
        // Whether `pom`'s module tree reaches an unlinked POM.
        let reaches_unlinked = |pom: &str| {
            let mut seen = std::collections::HashSet::new();
            let mut pending = vec![normalized_pom(pom)];
            while let Some(pom) = pending.pop() {
                if !seen.insert(pom.clone()) {
                    continue;
                }
                let Some(project) = by_pom.get(&pom) else { continue };
                for module in &project.modules {
                    if self.contains(module) {
                        return true;
                    }
                    pending.push(normalized_pom(module));
                }
            }
            false
        };
        Some(linked.into_iter().filter(|p| !reaches_unlinked(&p.pom)).map(|p| normalized_pom(&p.pom)).collect())
    }

    pub fn filter(&self, model: &mut MavenModel) {
        model.projects.retain(|p| !self.contains(&p.pom));
        for project in &mut model.projects {
            project.modules.retain(|p| !self.contains(p));
        }
        model.profiles.retain(|p| model.projects.iter().any(|project| project.profiles.contains(&p.id)));
    }
}

fn normalized_pom(pom: &str) -> String {
    let pom = pom.replace('\\', "/");
    let unc = pom.starts_with("//");
    let absolute = pom.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in pom.split('/') {
        match part {
            "" | "." => {}
            // Keep a drive letter (`C:`) and a leading `..` that has nothing to climb.
            ".." if parts.last().is_some_and(|p| *p != ".." && !p.ends_with(':')) => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    let joined = parts.join("/");
    if unc {
        format!("//{joined}")
    } else if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Every POM of the model (for change detection).
pub fn build_files(root: &Path, model: &MavenModel) -> Vec<PathBuf> {
    model.projects.iter().map(|p| root.join(&p.pom)).collect()
}

/// Projects and their plugins / dependencies from `mvn help:effective-pom` output
/// (`<project>` or `<projects>`), keyed `groupId:artifactId`.
pub fn parse_effective_pom(text: &str) -> Vec<(String, Vec<MavenPlugin>, Vec<MavenDependency>)> {
    parse_effective_pom_in(text, None)
}

/// The same, with the local repository the project actually builds against (a
/// `-Dmaven.repo.local` of the build, say): the plugin goals come from jars there,
/// rather than from the user's default one.
pub fn parse_effective_pom_in(
    text: &str,
    local_repo: Option<&Path>,
) -> Vec<(String, Vec<MavenPlugin>, Vec<MavenDependency>)> {
    let Some(root) = xml::parse(text) else { return Vec::new() };
    let projects: Vec<&Element> =
        if root.name == "projects" { root.children_named("project").collect() } else { vec![&root] };
    projects
        .into_iter()
        .map(|p| {
            let raw = read_raw(p);
            let group = raw.group_id.clone().or(raw.parent.as_ref().map(|pp| pp.group_id.clone())).unwrap_or_default();
            let plugins = raw
                .plugins
                .iter()
                .map(|pl| plugin(&pl.group_id, &pl.artifact_id, pl.version.clone(), &pl.goals, local_repo))
                .collect();
            let deps = raw
                .deps
                .iter()
                .map(|d| MavenDependency {
                    group_id: d.group_id.clone(),
                    artifact_id: d.artifact_id.clone(),
                    version: d.version.clone(),
                    kind: d.kind.clone().unwrap_or_else(|| "jar".into()),
                    classifier: d.classifier.clone(),
                    scope: d.scope.clone().unwrap_or_else(|| "compile".into()),
                    optional: d.optional,
                    ..MavenDependency::default()
                })
                .collect();
            (format!("{group}:{}", raw.artifact_id), plugins, deps)
        })
        .collect()
}

/// `g:a:type[:classifier]:version[:scope]` from a `dependency:tree` line, with the
/// `-Dverbose` annotations: `(g:a:jar:1:compile - omitted for conflict with 2)`,
/// `g:a:jar:1:compile (version managed from 0.9)`, `(optional)`.
fn parse_coords(s: &str) -> Option<MavenDependency> {
    let s = s.trim();
    let (s, wrapped) = match s.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
        Some(inner) => (inner, true),
        None => (s, false),
    };
    let (coords, notes) = s.split_once(' ').unwrap_or((s, ""));
    let parts: Vec<&str> = coords.split(':').collect();
    let (g, a, t, c, v, scope) = match parts.as_slice() {
        [g, a, t, v] => (g, a, t, None, v, None),
        [g, a, t, v, s] => (g, a, t, None, v, Some(*s)),
        [g, a, t, c, v, s] => (g, a, t, Some(*c), v, Some(*s)),
        _ => return None,
    };
    let mut dep = MavenDependency {
        group_id: (*g).to_owned(),
        artifact_id: (*a).to_owned(),
        version: Some((*v).to_owned()),
        kind: (*t).to_owned(),
        classifier: c.map(|c| (*c).to_owned()),
        scope: scope.unwrap_or("compile").to_owned(),
        ..MavenDependency::default()
    };
    let notes = notes.replace(['(', ')'], ";").replace(" - ", ";");
    for note in notes.split(';').map(|n| n.trim().trim_start_matches("- ").trim()) {
        if note == "optional" {
            dep.optional = true;
        } else if let Some(winner) = note.strip_prefix("omitted for conflict with ") {
            dep.omitted = Some(Omission::Conflict);
            dep.conflict_with = Some(winner.trim().to_owned());
        } else if note == "omitted for duplicate" {
            dep.omitted = Some(Omission::Duplicate);
        } else if note == "omitted for cycle" {
            dep.omitted = Some(Omission::Cycle);
        } else if let Some(from) = note.strip_prefix("version managed from ") {
            dep.managed_from = Some(from.trim().to_owned());
        }
    }
    // A parenthesised line is always an omitted occurrence, even with an unknown reason.
    if wrapped && dep.omitted.is_none() {
        dep.omitted = Some(Omission::Duplicate);
    }
    Some(dep)
}

fn insert_at(list: &mut Vec<MavenDependency>, depth: usize, dep: MavenDependency) {
    if depth == 0 {
        list.push(dep);
        return;
    }
    match list.last_mut() {
        Some(last) => insert_at(&mut last.children, depth - 1, dep),
        None => list.push(dep),
    }
}

/// Dependency trees from `mvn dependency:tree` console output, keyed `groupId:artifactId`
/// of the module; each value is the module's direct dependencies with their transitive ones.
pub fn parse_dependency_tree(output: &str) -> Vec<(String, Vec<MavenDependency>)> {
    let mut out: Vec<(String, Vec<MavenDependency>)> = Vec::new();
    let mut current: Option<usize> = None;
    let mut expect_root = false;
    for line in output.lines() {
        let line = line.trim_end();
        let body = line.strip_prefix("[INFO] ").or_else(|| line.strip_prefix("[INFO]"));
        let Some(body) = body else {
            current = None;
            continue;
        };
        if body.starts_with("--- ") && body.contains(":tree ") {
            expect_root = true;
            current = None;
            continue;
        }
        if expect_root {
            // The module's own coordinates; Maven may log other lines first ("Loaded … prefixes").
            if let Some(root) = parse_coords(body).filter(|_| !body.contains(' ')) {
                expect_root = false;
                out.push((format!("{}:{}", root.group_id, root.artifact_id), Vec::new()));
                current = Some(out.len() - 1);
            } else if body.starts_with("---") || body.starts_with("BUILD") {
                expect_root = false;
            }
            continue;
        }
        let Some(idx) = current else { continue };
        // Tree lines: depth = 3 characters of `|  ` / `   ` per level before `+- ` / `\- `.
        let Some(marker) = body.find("+- ").or_else(|| body.find("\\- ")) else {
            current = None;
            continue;
        };
        let prefix = &body[..marker];
        if !prefix.chars().all(|c| c == ' ' || c == '|') {
            current = None;
            continue;
        }
        if let Some(dep) = parse_coords(&body[marker + 3..]) {
            insert_at(&mut out[idx].1, marker / 3, dep);
        }
    }
    out
}

// ---------------------------------------------------------------- goto declaration

/// What a go-to-declaration in a POM found, and where.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PomGoto {
    /// Absolute path of the file with the declaration: the POM itself, or a parent
    /// POM of the local repository when the definition is inherited from one.
    pub path: PathBuf,
    pub range: Range,
    /// What was found.
    pub kind: PomGotoKind,
    /// The declaration as named for the user (`example.version`, `com.example:example-lib`).
    pub label: String,
}

/// The kind of declaration a POM go-to-declaration found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PomGotoKind {
    /// A `<properties>` entry of the POM or one of its parents.
    Property,
    /// A `<dependencyManagement>` entry providing the dependency's version.
    ManagedDependency,
    /// A `<pluginManagement>` entry providing the plugin's version.
    ManagedPlugin,
    /// The POM of the artifact itself: a project module's, else the local repository's.
    ArtifactPom,
}

/// A Maven project of the workspace, for going to a dependency on it.
pub struct ModulePom {
    pub group_id: String,
    pub artifact_id: String,
    pub pom: PathBuf,
}

/// Byte offset of `pos` (0-based line / UTF-16 column), clamped to `text`.
fn offset_at(text: &str, pos: Pos) -> usize {
    let (mut line_seen, mut at) = (0usize, 0usize);
    if pos.line > 0 {
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                line_seen += 1;
                if line_seen == pos.line as usize {
                    at = i + 1;
                    break;
                }
            }
        }
        if line_seen < pos.line as usize {
            return text.len();
        }
    }
    let line_end = text[at..].find('\n').map_or(text.len(), |i| at + i);
    let (mut col, mut byte) = (0u32, at);
    for c in text[at..line_end].chars() {
        let width = c.len_utf16() as u32;
        if col + width > pos.col {
            break;
        }
        col += width;
        byte += c.len_utf8();
    }
    byte
}

/// 0-based line / UTF-16 column of byte offset `at`.
fn pos_at(text: &str, at: usize) -> Pos {
    let before = &text[..at];
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    Pos::new(before.matches('\n').count() as u32, before[line_start..].encode_utf16().count() as u32)
}

/// The `${property}` reference covering byte offset `at`: its name and the span of
/// the whole reference. `None` when `at` is outside one (a closing `${…}` before it
/// ends the search: references do not nest).
fn property_ref_at(text: &str, at: usize) -> Option<(&str, usize, usize)> {
    // `at` may sit on the `$` itself.
    let open = text[..at].rfind("${").or_else(|| text[at..].starts_with("${").then_some(at))?;
    let close = open + 2 + text[open + 2..].find('}')?;
    (close >= at).then(|| (text[open + 2..close].trim(), open, close + 1))
}

/// The elements containing `at`, from the root down to the innermost one.
pub(crate) fn element_path(root: &Element, at: usize) -> Vec<&Element> {
    let mut path = vec![root];
    loop {
        let Some(next) = path.last().unwrap().children.iter().find(|c| c.start <= at && at < c.end) else {
            return path;
        };
        path.push(next);
    }
}

/// The `<groupId>` / `<artifactId>` of a dependency or plugin element, with the
/// plugin default (`org.apache.maven.plugins`) applied.
fn coordinates(e: &Element, props: &HashMap<String, String>) -> Option<(String, String)> {
    let group = if e.name == "plugin" && e.text_of("groupId").is_none() {
        "org.apache.maven.plugins".to_owned()
    } else {
        interpolate(&e.text_of("groupId")?, props)
    };
    Some((group, interpolate(&e.text_of("artifactId")?, props)))
}

/// The go-to-declaration target at `pos` (0-based line / UTF-16 column) of the POM
/// `text` stored at `path` (the current buffer text when the file is open): a
/// `${property}` reference to the `<properties>` entry that defines it along the
/// parent chain, or a dependency / plugin to the `<dependencyManagement>` /
/// `<pluginManagement>` entry that provides its version (a parent POM, followed into
/// the local repository when it is not in the project). `None` when there is no
/// resolvable declaration here.
pub fn goto_declaration(text: &str, path: &Path, pos: Pos, local_repo: Option<PathBuf>) -> Option<PomGoto> {
    goto_declaration_in(text, path, pos, local_repo, Vec::new)
}

/// [`goto_declaration`], where a `<parent>` and a dependency or plugin whose version no
/// management entry provides (or a management entry itself) go to the artifact's own
/// POM: the project module among `modules` with its coordinates, else the local
/// repository's POM of its version.
pub fn goto_declaration_in(
    text: &str,
    path: &Path,
    pos: Pos,
    local_repo: Option<PathBuf>,
    modules: impl FnOnce() -> Vec<ModulePom>,
) -> Option<PomGoto> {
    let root = xml::parse(text).filter(|e| e.name == "project")?;
    let at = offset_at(text, pos);
    if let Some((name, _, _)) = property_ref_at(text, at)
        && !name.is_empty()
    {
        return property_target(text, path, name, local_repo);
    }
    // A `<dependency>` / `<plugin>` in a declaration position: its version may come
    // from a management entry of this POM or an ancestor's.
    let elements = element_path(&root, at);
    if elements.get(1).is_some_and(|e| e.name == "parent") {
        let chain = parent_chain(path, text, local_repo);
        let (pom, parent_text) = chain.get(1)?;
        let label = elements[1].text_of("artifactId").unwrap_or_default();
        return Some(pom_goto(pom.clone(), parent_text, label));
    }
    let e = elements.iter().rev().find(|e| e.name == "dependency" || e.name == "plugin")?;
    // A management entry declares the version: it goes to the artifact (a BOM import, say).
    if !elements.iter().any(|a| a.name == "dependencyManagement" || a.name == "pluginManagement") {
        let kind = match e.name.as_str() {
            "dependency" => PomGotoKind::ManagedDependency,
            _ => PomGotoKind::ManagedPlugin,
        };
        if let Some(found) = managed_target(text, path, e, kind, local_repo.clone()) {
            return Some(found);
        }
    }
    artifact_target(text, path, e, local_repo, modules)
}

/// The artifact's own POM for a dependency or plugin element `e`.
fn artifact_target(
    text: &str,
    path: &Path,
    e: &Element,
    local_repo: Option<PathBuf>,
    modules: impl FnOnce() -> Vec<ModulePom>,
) -> Option<PomGoto> {
    let mut resolver = Resolver::new(local_repo.clone(), &[]);
    let chain = parent_chain(path, text, local_repo);
    let props = properties_at(&mut resolver, &chain, 0);
    let (group, artifact) = coordinates(e, &props)?;
    let label = format!("{group}:{artifact}");
    if let Some(module) = modules().into_iter().find(|m| m.group_id == group && m.artifact_id == artifact) {
        let module_text = xml::read_text(&module.pom)?;
        return Some(pom_goto(module.pom, &module_text, label));
    }
    let version = interpolate(&e.text_of("version")?, &props);
    let pom = resolver.repo_pom(&group, &artifact, &version)?;
    let pom_text = xml::read_text(&pom)?;
    Some(pom_goto(pom, &pom_text, label))
}

/// The POM at `path` as a target, at its `<artifactId>`.
fn pom_goto(path: PathBuf, text: &str, label: String) -> PomGoto {
    let range = xml::parse(text)
        .filter(|e| e.name == "project")
        .and_then(|root| root.child("artifactId").map(|a| range_of(text, a)))
        .unwrap_or_default();
    PomGoto { path, range, kind: PomGotoKind::ArtifactPom, label }
}

/// The parent POMs of the POM in `text` at `path`, child-first (its `<parent>` refs,
/// via `relativePath` in the project or the local repository), with their texts.
fn parent_chain(path: &Path, text: &str, local_repo: Option<PathBuf>) -> Vec<(PathBuf, String)> {
    let mut resolver = Resolver::new(local_repo, &[]);
    let path = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut chain = vec![(path.clone(), text.to_owned())];
    let mut dir = path.parent().unwrap_or(Path::new("")).to_path_buf();
    let mut pom = parse_pom(text);
    for _ in 0..MAX_PARENT_DEPTH {
        let Some(parent) = pom.and_then(|p| p.parent) else { return chain };
        let Some(pp) = resolver.parent_path(&dir, &parent) else { return chain };
        let pp = dunce::canonicalize(&pp).unwrap_or(pp);
        let Some(next) = xml::read_text(&pp) else { return chain };
        pom = resolver.pom(&pp);
        dir = pp.parent().unwrap_or(Path::new("")).to_path_buf();
        chain.push((pp, next));
    }
    chain
}

/// The properties visible in the POM at `chain[i]`: inherited (its parents' and
/// ancestors' own entries) plus its own, and the `project.*` built-ins.
fn properties_at(resolver: &mut Resolver, chain: &[(PathBuf, String)], i: usize) -> HashMap<String, String> {
    let (p, text) = &chain[i];
    let Some(pom) = parse_pom(text) else { return HashMap::new() };
    let dir = p.parent().unwrap_or(Path::new("")).to_path_buf();
    let ctx = resolver.context(p, 0);
    resolver.properties_for(&pom, &ctx, &dir)
}

/// Where the property `name` is declared: the `project.*` built-ins go to their
/// coordinate elements, the rest to the first `<properties>` entry along the parent
/// chain declaring it (a child's definition wins over a parent's; an active
/// profile's counts as the POM's own). The winner's path, element range and name.
fn property_target(text: &str, path: &Path, name: &str, local_repo: Option<PathBuf>) -> Option<PomGoto> {
    let name = name.strip_prefix("pom.").map(|n| format!("project.{n}")).unwrap_or_else(|| name.to_owned());
    let resolver = Resolver::new(local_repo.clone(), &[]);
    let chain = parent_chain(path, text, local_repo);
    // `project.parent.*` (and the legacy `parent.*` spellings) are declared by the
    // clicked POM's own `<parent>` section.
    let parent_key = match name.as_str() {
        "project.parent.groupId"
        | "project.parent.artifactId"
        | "project.parent.version"
        | "parent.groupId"
        | "parent.version" => {
            let key = name.rsplit('.').next().unwrap();
            Some(&name[name.len() - key.len()..])
        }
        _ => None,
    };
    if let Some(key) = parent_key {
        if !matches!(key, "groupId" | "artifactId" | "version") {
            return None; // No other `project.parent.*` property has a declaration.
        }
        let root = xml::parse(&chain[0].1).filter(|e| e.name == "project")?;
        let e = root.child("parent")?.child(key)?;
        return Some(PomGoto {
            path: chain[0].0.clone(),
            range: range_of(&chain[0].1, e),
            kind: PomGotoKind::Property,
            label: name.clone(),
        });
    }
    // Built-in coordinates: the POM's own element, else the first ancestor declaring one.
    if let Some(key) = name.strip_prefix("project.") {
        if !matches!(key, "groupId" | "artifactId" | "version" | "packaging" | "name") {
            return None; // `project.basedir`, `project.build.directory`… have no element.
        }
        for (p, text) in &chain {
            let Some(root) = xml::parse(text).filter(|e| e.name == "project") else { continue };
            let Some(e) = root.child(key).filter(|e| !e.text.trim().is_empty()) else { continue };
            return Some(PomGoto {
                path: p.clone(),
                range: range_of(text, e),
                kind: PomGotoKind::Property,
                label: name.clone(),
            });
        }
        return None;
    }
    // A property of `<properties>`: the first POM of the chain (child-first) that
    // declares it, at project level or in an active profile.
    for (p, text) in &chain {
        let Some(root) = xml::parse(text).filter(|e| e.name == "project") else { continue };
        let active: Vec<String> = parse_pom(text)
            .map(|pom| resolver.active(&pom.profiles).map(|pr| pr.id.clone()).collect())
            .unwrap_or_default();
        // Project level first, then the first active profile declaring the property.
        let e = root.child("properties").and_then(|props| props.child(&name)).or_else(|| {
            root.list("profiles", "profile")
                .into_iter()
                .find(|profile| {
                    active.contains(&profile.child("id").map(|id| id.text.trim().to_owned()).unwrap_or_default())
                        && profile.child("properties").and_then(|props| props.child(&name)).is_some()
                })?
                .child("properties")?
                .child(&name)
        });
        if let Some(e) = e {
            return Some(PomGoto {
                path: p.clone(),
                range: range_of(text, e),
                kind: PomGotoKind::Property,
                label: name.clone(),
            });
        }
    }
    None
}

/// The `<dependencyManagement>` / `<pluginManagement>` entry providing the version
/// of the dependency / plugin element `e`: this POM's own management first, then the
/// parent chain, child-first (the nearest declaration wins). Coordinates are matched
/// after interpolation with each POM's effective properties.
fn managed_target(
    text: &str,
    path: &Path,
    e: &Element,
    kind: PomGotoKind,
    local_repo: Option<PathBuf>,
) -> Option<PomGoto> {
    let mut resolver = Resolver::new(local_repo.clone(), &[]);
    let chain = parent_chain(path, text, local_repo);
    let key = coordinates(e, &properties_at(&mut resolver, &chain, 0))?;
    let (section, item) = match kind {
        PomGotoKind::ManagedDependency => ("dependencyManagement/dependencies", "dependency"),
        _ => ("build/pluginManagement/plugins", "plugin"),
    };
    for (i, (p, text)) in chain.iter().enumerate() {
        let root = xml::parse(text).filter(|e| e.name == "project")?;
        let props = properties_at(&mut resolver, &chain, i);
        let Some(hit) = root.list(section, item).into_iter().find(|m| coordinates(m, &props).as_ref() == Some(&key))
        else {
            continue;
        };
        let target = hit.child("artifactId").unwrap_or(hit);
        return Some(PomGoto {
            path: p.clone(),
            range: range_of(text, target),
            kind,
            label: format!("{}:{}", key.0, key.1),
        });
    }
    None
}

/// The range of element `e` in `text`.
fn range_of(text: &str, e: &Element) -> Range {
    Range::new(pos_at(text, e.start), pos_at(text, e.end))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `parent_chain` returns paths normalized by `dunce::canonicalize`, so the
    /// expected values compared against them must go through the same call: the
    /// temp dirs sit behind symlinks on macOS (`/var` → `/private/var`) and under
    /// an 8.3 short name on Windows, and raw paths would not match on those runners.
    fn canon(path: &Path) -> PathBuf {
        dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    }

    /// A plugin jar in `repo` whose descriptor declares `goals`.
    fn write_plugin_jar(repo: &Path, group: &str, artifact: &str, version: &str, goals: &[&str]) {
        let dir = repo.join(group.replace('.', "/")).join(artifact).join(version);
        std::fs::create_dir_all(&dir).unwrap();
        let mojos: String = goals.iter().map(|g| format!("<mojo><goal>{g}</goal></mojo>")).collect();
        let descriptor = format!("<plugin><mojos>{mojos}</mojos></plugin>");
        let file = std::fs::File::create(dir.join(format!("{artifact}-{version}.jar"))).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("META-INF/maven/plugin.xml", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut zip, descriptor.as_bytes()).unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn a_plugin_lists_the_goals_its_jar_declares() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        write_plugin_jar(
            repo,
            "org.apache.maven.plugins",
            "maven-checkstyle-plugin",
            "3.3.1",
            &["checkstyle", "checkstyle-aggregate", "help", "check"],
        );
        let p = plugin(
            "org.apache.maven.plugins",
            "maven-checkstyle-plugin",
            Some("3.3.1".into()),
            &["check".to_owned()],
            Some(repo),
        );
        assert_eq!(p.goals, ["check", "checkstyle", "checkstyle-aggregate", "help"], "every goal the plugin offers");
        assert_eq!(p.prefix, "checkstyle");
    }

    #[test]
    fn settings_profiles_are_listed_with_the_active_ones_checked() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.xml");
        std::fs::write(
            &file,
            r#"<settings>
  <profiles>
    <profile><id>nexus</id></profile>
    <profile><id>jdk21</id><activation><activeByDefault>true</activeByDefault></activation></profile>
    <profile><id>release</id></profile>
    <profile><id>nexus</id></profile>
    <profile><activation/></profile>
  </profiles>
  <activeProfiles><activeProfile>nexus</activeProfile></activeProfiles>
</settings>"#,
        )
        .unwrap();
        let p = |id: &str, active| MavenProfile { id: id.into(), active_by_default: active, ..Default::default() };
        assert_eq!(settings_profiles(&file), [p("nexus", true), p("jdk21", true), p("release", false)]);
        assert!(settings_profiles(&tmp.path().join("missing.xml")).is_empty());

        let mut s = ide_core::settings::MavenSettings::default();
        let home = dirs::home_dir().unwrap();
        assert_eq!(user_settings_file(tmp.path(), &s), Some(home.join(".m2/settings.xml")));
        s.user_settings = "conf/settings.xml".into();
        assert_eq!(user_settings_file(tmp.path(), &s), Some(tmp.path().join("conf/settings.xml")));
        s.user_settings = "~/work/settings.xml".into();
        assert_eq!(user_settings_file(tmp.path(), &s), Some(home.join("work/settings.xml")));
    }

    #[test]
    fn a_settings_file_names_the_repository_to_read_goals_from() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = tmp.path().join("settings.xml");
        std::fs::write(
            &settings,
            "<settings><localRepository>${user.home}/repo-from-settings</localRepository></settings>",
        )
        .unwrap();
        let repo = local_repository_of(&settings).unwrap();
        assert!(repo.ends_with("repo-from-settings"), "{}", repo.display());
        assert!(!repo.to_string_lossy().contains("${user.home}"));
        // A settings file that names none leaves Maven's default alone.
        let plain = tmp.path().join("plain.xml");
        std::fs::write(&plain, "<settings><offline>true</offline></settings>").unwrap();
        assert!(local_repository_of(&plain).is_none());
        assert!(local_repository_of(&tmp.path().join("missing.xml")).is_none());
    }

    #[test]
    fn effective_pom_goals_come_from_the_local_repository_it_is_given() {
        let tmp = tempfile::tempdir().unwrap();
        write_plugin_jar(tmp.path(), "org.apache.maven.plugins", "maven-demo-plugin", "1.0", &["run", "help"]);
        let text = "<project><groupId>g</groupId><artifactId>a</artifactId><build><plugins>\
            <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-demo-plugin</artifactId>\
            <version>1.0</version><executions><execution><goals><goal>run</goal></goals></execution></executions>\
            </plugin></plugins></build></project>";
        let with_repo = parse_effective_pom_in(text, Some(tmp.path()));
        assert_eq!(with_repo[0].1[0].goals, ["help", "run"], "the jar's own goals come first");
        // Without that repository the plugin is unknown: only what the project binds.
        assert_eq!(parse_effective_pom(text)[0].1[0].goals, ["run"]);
    }

    #[test]
    fn a_snapshot_plugin_is_found_by_its_timestamped_jar() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("g/p/maven-demo-plugin/1.0-SNAPSHOT");
        std::fs::create_dir_all(&dir).unwrap();
        let descriptor = "<plugin><mojos><mojo><goal>run</goal></mojo></mojos></plugin>";
        let file = std::fs::File::create(dir.join("maven-demo-plugin-1.0-20240101.120000-3.jar")).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("META-INF/maven/plugin.xml", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut zip, descriptor.as_bytes()).unwrap();
        zip.finish().unwrap();
        // A sibling sources jar must not win.
        std::fs::File::create(dir.join("maven-demo-plugin-1.0-20240101.120000-3-sources.jar")).unwrap();
        let p = plugin("g.p", "maven-demo-plugin", Some("1.0-SNAPSHOT".into()), &[], Some(tmp.path()));
        assert_eq!(p.goals, ["run"]);
    }

    #[test]
    fn a_plugin_without_its_jar_keeps_the_table_and_the_bound_goals() {
        let tmp = tempfile::tempdir().unwrap();
        let p = plugin(
            "org.apache.maven.plugins",
            "maven-checkstyle-plugin",
            Some("3.3.1".into()),
            &["check".to_owned()],
            Some(tmp.path()),
        );
        assert_eq!(p.goals, ["check"], "nothing beyond what the project binds");
        let known =
            plugin("org.apache.maven.plugins", "maven-compiler-plugin", Some("3.13.0".into()), &[], Some(tmp.path()));
        assert_eq!(known.goals, ["compile", "help", "testCompile"], "the common plugins keep their table");
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    const PARENT: &str = r#"<project>
      <groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version>
      <packaging>pom</packaging><name>${project.artifactId} build</name>
      <modules><module>core</module><module>app</module></modules>
      <properties><junit.version>5.10.2</junit.version><maven.compiler.release>21</maven.compiler.release></properties>
      <dependencyManagement><dependencies>
        <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>${junit.version}</version><scope>test</scope></dependency>
      </dependencies></dependencyManagement>
      <build><pluginManagement><plugins>
        <plugin><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin>
      </plugins></pluginManagement></build>
      <profiles>
        <profile><id>dev</id><activation><activeByDefault>true</activeByDefault></activation></profile>
        <profile><id>extra</id><modules><module>extra</module></modules></profile>
      </profiles>
    </project>"#;

    #[test]
    fn maven_4_subprojects_are_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(
            root,
            "pom.xml",
            r#"<project xmlns="http://maven.apache.org/POM/4.1.0"><modelVersion>4.1.0</modelVersion>
              <groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version><packaging>pom</packaging>
              <subprojects><subproject>core</subproject></subprojects>
              <profiles><profile><id>extra</id><subprojects><subproject>extra</subproject></subprojects></profile></profiles>
            </project>"#,
        );
        write(root, "core/pom.xml", "<project><artifactId>core</artifactId></project>");
        write(root, "extra/pom.xml", "<project><artifactId>extra</artifactId></project>");
        let model = load_with_repo(root, None);
        assert_eq!(model.projects[0].modules, ["core/pom.xml"]);
        assert!(model.projects.iter().any(|p| p.pom == "core/pom.xml" && p.aggregated));
    }

    #[test]
    fn modules_inherit_the_compiler_level_of_the_parent_plugin_configuration() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let parent = |build: &str| {
            format!(
                r#"<project><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version><packaging>pom</packaging>
                  <modules><module>core</module><module>app</module></modules>
                  <properties><jdk>17</jdk></properties>{build}</project>"#
            )
        };
        let child = |name: &str, build: &str| {
            format!(
                r#"<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version></parent>
                  <artifactId>{name}</artifactId>{build}</project>"#
            )
        };
        let compiler = |level: &str| {
            format!(
                "<plugin><artifactId>maven-compiler-plugin</artifactId><configuration><source>{level}</source></configuration></plugin>"
            )
        };
        let versions = |model: &MavenModel| -> Vec<(String, Option<u32>)> {
            model.projects.iter().map(|p| (p.pom.clone(), p.java_version)).collect()
        };
        let app_build = format!("<build><plugins>{}</plugins></build>", compiler("21"));
        write(root, "core/pom.xml", &child("core", ""));
        write(root, "app/pom.xml", &child("app", &app_build));
        for build in [
            format!("<build><pluginManagement><plugins>{}</plugins></pluginManagement></build>", compiler("${jdk}")),
            format!("<build><plugins>{}</plugins></build>", compiler("1.8")),
        ] {
            write(root, "pom.xml", &parent(&build));
            let expected = if build.contains("1.8") { 8 } else { 17 };
            assert_eq!(
                versions(&load_with_repo(root, None)),
                [
                    ("pom.xml".to_owned(), Some(expected)),
                    ("core/pom.xml".to_owned(), Some(expected)),
                    ("app/pom.xml".to_owned(), Some(21)),
                ],
                "{build}"
            );
        }
    }

    #[test]
    fn multi_module_parent_properties_and_managed_versions() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "pom.xml", PARENT);
        write(
            root,
            "core/pom.xml",
            r#"<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version></parent>
              <artifactId>core</artifactId>
              <dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies>
            </project>"#,
        );
        write(
            root,
            "app/pom.xml",
            r#"<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version></parent>
              <artifactId>app</artifactId><name>Demo App</name><packaging>war</packaging>
              <dependencies>
                <dependency><groupId>${project.groupId}</groupId><artifactId>core</artifactId><version>${project.version}</version></dependency>
                <dependency><groupId>x</groupId><artifactId>opt</artifactId><version>2</version><optional>true</optional><scope>provided</scope></dependency>
              </dependencies>
              <build><plugins>
                <plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId>
                  <executions><execution><goals><goal>repackage</goal><goal>custom</goal></goals></execution></executions>
                </plugin>
              </plugins></build>
            </project>"#,
        );
        write(root, "extra/pom.xml", "<project><artifactId>extra</artifactId></project>");
        let model = load_with_repo(root, None);
        let names: Vec<(&str, &str, bool)> =
            model.projects.iter().map(|p| (p.pom.as_str(), p.display_name.as_str(), p.aggregated)).collect();
        assert_eq!(
            names,
            [("pom.xml", "parent build", false), ("core/pom.xml", "core", true), ("app/pom.xml", "Demo App", true)]
        );
        let parent = &model.projects[0];
        assert_eq!(parent.modules, ["core/pom.xml", "app/pom.xml"]);
        assert_eq!(parent.packaging, "pom");
        assert_eq!(parent.dir, "");
        let prefixes: Vec<&str> = parent.plugins.iter().map(|p| p.prefix.as_str()).collect();
        assert_eq!(prefixes, ["clean", "install", "deploy", "site"]);

        let core = &model.projects[1];
        assert_eq!((core.group_id.as_str(), core.version.as_str(), core.dir.as_str()), ("demo", "1.0", "core"));
        assert_eq!(core.parent.as_deref(), Some("demo:parent:1.0"));
        assert_eq!(core.java_version, Some(21));
        let junit = &core.dependencies[0];
        assert_eq!((junit.version.as_deref(), junit.scope.as_str()), (Some("5.10.2"), "test"));
        let surefire = core.plugins.iter().find(|p| p.prefix == "surefire").unwrap();
        assert_eq!(surefire.version.as_deref(), Some("3.2.5"));
        assert_eq!(surefire.goals, ["help", "test"]);
        assert!(core.plugins.iter().any(|p| p.prefix == "jar"));

        let app = &model.projects[2];
        assert_eq!(app.packaging, "war");
        let deps: Vec<(String, Option<String>, String, bool)> = app
            .dependencies
            .iter()
            .map(|d| (d.artifact_id.clone(), d.version.clone(), d.scope.clone(), d.optional))
            .collect();
        assert_eq!(
            deps,
            [
                ("core".into(), Some("1.0".into()), "compile".into(), false),
                ("opt".into(), Some("2".into()), "provided".into(), true)
            ]
        );
        assert_eq!(app.dependencies[0].group_id, "demo");
        let boot = &app.plugins[0];
        assert_eq!((boot.prefix.as_str(), boot.group_id.as_str()), ("spring-boot", "org.springframework.boot"));
        assert!(boot.goals.contains(&"run".to_owned()) && boot.goals.contains(&"custom".to_owned()));
        assert!(boot.goals.windows(2).all(|w| w[0] <= w[1]), "sorted");
        assert!(app.plugins.iter().any(|p| p.prefix == "war") && !app.plugins.iter().any(|p| p.prefix == "jar"));

        let profiles: Vec<(&str, bool)> = model.profiles.iter().map(|p| (p.id.as_str(), p.active_by_default)).collect();
        assert_eq!(profiles, [("dev", true), ("extra", false)]);
        assert_eq!(parent.profiles, ["dev", "extra"]);
        assert_eq!(core.profiles, ["dev", "extra"], "a module inherits its parent's profiles");
        assert!(model.projects.iter().all(|p| p.command == if cfg!(windows) { "mvn.cmd" } else { "mvn" }));
    }

    /// Add Maven Projects: a POM inside the project that no reactor lists becomes an
    /// independent top-level project; one the root reactor lists stays its module.
    #[test]
    fn linked_poms_outside_the_reactor_are_top_level_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(
            root,
            "pom.xml",
            "<project><groupId>demo</groupId><artifactId>main</artifactId><version>1.0</version><packaging>pom</packaging><modules><module>core</module></modules></project>",
        );
        write(
            root,
            "core/pom.xml",
            "<project><groupId>demo</groupId><artifactId>core</artifactId><version>1.0</version></project>",
        );
        write(
            root,
            "stub/pom.xml",
            "<project><groupId>demo</groupId><artifactId>stub</artifactId><version>1.0</version></project>",
        );
        let top = |m: &MavenModel| m.projects.iter().map(|p| (p.dir.clone(), p.aggregated)).collect::<Vec<_>>();

        assert_eq!(top(&load_with_linked(root, None, &[], &[])), [("".into(), false), ("core".into(), true)]);
        let linked: Vec<String> =
            ["stub/pom.xml", "./core/pom.xml", "../outside/pom.xml", "missing/pom.xml"].map(String::from).into();
        assert_eq!(
            top(&load_with_linked(root, None, &[], &linked)),
            [("".into(), false), ("core".into(), true), ("stub".into(), false)]
        );

        // Deeper than the folder search reaches: only the link makes it a Maven project.
        let deep = tempfile::tempdir().unwrap();
        write(deep.path(), "a/b/c/tool/pom.xml", "<project><artifactId>tool</artifactId></project>");
        let settings = ide_core::settings::MavenSettings {
            linked_projects: vec!["a/b/c/tool/pom.xml".into()],
            ..Default::default()
        };
        assert!(!has_projects(deep.path(), &Default::default()));
        assert!(has_projects(deep.path(), &settings));
        assert_eq!(top(&load_linked(deep.path(), &settings)), [("a/b/c/tool".into(), false)]);
    }

    /// A sibling Maven project is linked beside the opened root. Its reactor, including a
    /// module that points back at the opened project, is read once. Neither POM is rewritten,
    /// and only the linked project's directory is an extra content root — not the common
    /// parent and not a module that lives outside that directory.
    #[test]
    fn external_sibling_keeps_its_directory_and_does_not_edit_poms() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let a = base.join("A");
        let b = base.join("B");
        let c = base.join("C");
        std::fs::create_dir_all(a.join("core")).unwrap();
        std::fs::create_dir_all(b.join("mod")).unwrap();
        std::fs::create_dir_all(&c).unwrap();
        let a_pom = "<project><groupId>demo</groupId><artifactId>a</artifactId><version>1</version><packaging>pom</packaging><modules><module>core</module></modules></project>";
        let b_pom = "<project><groupId>demo</groupId><artifactId>b</artifactId><version>1</version><packaging>pom</packaging><modules><module>mod</module><module>../A</module><module>../C</module><module>.</module></modules></project>";
        let c_pom = "<project><groupId>demo</groupId><artifactId>c</artifactId><version>1</version><modules><module>../B</module></modules></project>";
        std::fs::write(a.join("pom.xml"), a_pom).unwrap();
        std::fs::write(a.join("core/pom.xml"), "<project><artifactId>core</artifactId></project>").unwrap();
        std::fs::write(b.join("pom.xml"), b_pom).unwrap();
        std::fs::write(b.join("mod/pom.xml"), "<project><artifactId>bmod</artifactId></project>").unwrap();
        std::fs::write(c.join("pom.xml"), c_pom).unwrap();
        let wrapper = if cfg!(windows) { "mvnw.cmd" } else { "mvnw" };
        std::fs::write(a.join(wrapper), "#!/bin/sh\n").unwrap();
        std::fs::write(b.join(wrapper), "#!/bin/sh\n").unwrap();
        std::fs::write(base.join(wrapper), "#!/bin/sh\n").unwrap();

        let discovered = load_with_linked(&a, None, &[], &[]);
        assert_eq!(discovered.projects.iter().map(|p| p.artifact_id.as_str()).collect::<Vec<_>>(), ["a", "core"]);

        let stored = vec!["../B/pom.xml".into()];
        let linked = load_with_linked(&a, None, &[], &stored);
        let b_project = linked.projects.iter().find(|p| p.artifact_id == "b").unwrap();
        assert!(!b_project.aggregated);
        assert_eq!(b_project.pom, "../B/pom.xml");
        assert_eq!(dunce::canonicalize(a.join(&b_project.dir)).unwrap(), b);
        assert_eq!(dunce::canonicalize(&b_project.command).unwrap(), dunce::canonicalize(b.join(wrapper)).unwrap());
        let a_project = linked.projects.iter().find(|p| p.artifact_id == "a").unwrap();
        assert!(!a_project.aggregated);
        assert_eq!(a_project.modules, ["core/pom.xml"]);
        assert_eq!(dunce::canonicalize(&a_project.command).unwrap(), dunce::canonicalize(a.join(wrapper)).unwrap());
        assert_eq!(linked.projects.iter().filter(|p| p.artifact_id == "a").count(), 1);
        assert_eq!(linked.projects.iter().filter(|p| p.artifact_id == "b").count(), 1);
        assert!(linked.projects.iter().any(|p| p.artifact_id == "c" && p.aggregated));
        assert!(linked.projects.iter().any(|p| p.artifact_id == "bmod" && p.aggregated));
        let again = load_with_linked(&a, None, &[], &stored);
        assert_eq!(
            again.projects.iter().map(|p| &p.pom).collect::<Vec<_>>(),
            linked.projects.iter().map(|p| &p.pom).collect::<Vec<_>>()
        );

        let absolute = b.join("pom.xml").to_string_lossy().replace('\\', "/");
        let via_a = a.join("../B/pom.xml").to_string_lossy().replace('\\', "/");
        let normalized = normalize_linked_poms(
            &a,
            &[
                "../B/pom.xml".into(),
                absolute,
                via_a,
                a.join("pom.xml").to_string_lossy().into_owned(),
                b.to_string_lossy().into_owned(),
                "stub/pom.xml".into(),
                "notes.xml".into(),
            ],
        );
        assert_eq!(normalized.len(), 3, "{normalized:?}");
        assert_eq!(normalized[0], dunce::canonicalize(b.join("pom.xml")).unwrap().to_string_lossy().replace('\\', "/"));
        assert_eq!(normalized[1], "pom.xml");
        assert_eq!(normalized[2], "stub/pom.xml");
        assert_eq!(crate::maven_external_roots(&a, &normalized), vec![b.clone()]);
        assert_eq!(crate::maven_external_roots(&a, &stored), vec![b.clone()]);

        let removed = load_with_linked(&a, None, &[], &[]);
        assert!(removed.projects.iter().all(|p| p.artifact_id != "b"));
        assert_eq!(std::fs::read_to_string(a.join("pom.xml")).unwrap(), a_pom);
        assert_eq!(std::fs::read_to_string(b.join("pom.xml")).unwrap(), b_pom);
        assert_eq!(std::fs::read_to_string(c.join("pom.xml")).unwrap(), c_pom);
        assert!(b.join("mod/pom.xml").is_file());
    }

    /// The launcher recorded on an external project is that project's wrapper, and
    /// running it uses the external directory as the working directory.
    #[cfg(unix)]
    #[test]
    fn external_project_wrapper_runs_in_its_own_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let a = base.join("A");
        let b = base.join("B");
        std::fs::create_dir_all(b.join("src/main/java")).unwrap();
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("pom.xml"), "<project><artifactId>a</artifactId></project>").unwrap();
        std::fs::write(
            b.join("pom.xml"),
            "<project><artifactId>b</artifactId><build><sourceDirectory>src/main/java</sourceDirectory></build></project>",
        )
        .unwrap();
        std::fs::write(b.join("src/main/java/B.java"), "class B {}").unwrap();
        let script = b.join("mvnw");
        std::fs::write(&script, "#!/bin/sh\npwd > \"$1\"\nprintf 'BUILD SUCCESS\\n'\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let model = load_with_linked(&a, None, &[], &["../B/pom.xml".into()]);
        let project = model.projects.iter().find(|p| p.artifact_id == "b").unwrap();
        let cwd = a.join(&project.dir);
        assert_eq!(dunce::canonicalize(&cwd).unwrap(), b);
        let marker = tmp.path().join("cwd");
        let out = crate::process::run(
            &project.command,
            &[marker.to_string_lossy().into_owned()],
            &cwd,
            &std::collections::BTreeMap::new(),
            &ide_core::CancellationToken::new(),
            |_, _| {},
        )
        .unwrap();
        assert!(out.success, "{}", out.text);
        let recorded = dunce::canonicalize(std::fs::read_to_string(&marker).unwrap().trim()).unwrap();
        assert_eq!(recorded, b);
    }

    /// #2877: an aggregator in a subfolder lists the root POM as `../`; linked, it holds every
    /// module, the root one included, under the same POM paths the projects have.
    #[test]
    fn an_aggregator_in_a_subfolder_holds_the_root_pom() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let child = |id: &str, rel: &str| {
            format!(
                "<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version><relativePath>{rel}</relativePath></parent><artifactId>{id}</artifactId></project>"
            )
        };
        write(root, "pom.xml", &child("app", "parent/pom.xml"));
        write(
            root,
            "parent/pom.xml",
            "<project><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version><packaging>pom</packaging><modules><module>../</module><module>../infra</module></modules></project>",
        );
        write(root, "infra/pom.xml", &child("infra", "../parent/pom.xml"));

        let model = load_with_linked(root, None, &[], &["parent/pom.xml".into()]);
        let tops: Vec<&str> = model.projects.iter().filter(|p| !p.aggregated).map(|p| p.artifact_id.as_str()).collect();
        assert_eq!(tops, ["parent"]);
        let parent = model.projects.iter().find(|p| p.artifact_id == "parent").unwrap();
        assert_eq!(parent.modules, ["pom.xml", "infra/pom.xml"]);
        for pom in &parent.modules {
            assert!(model.projects.iter().any(|p| &p.pom == pom), "{pom}");
        }

        // A cycle (the root lists the aggregator, which lists the root) keeps the root on top.
        write(
            root,
            "pom.xml",
            "<project><groupId>demo</groupId><artifactId>app</artifactId><version>1.0</version><packaging>pom</packaging><modules><module>parent</module></modules></project>",
        );
        let model = load_with_linked(root, None, &[], &[]);
        let tops: Vec<&str> = model.projects.iter().filter(|p| !p.aggregated).map(|p| p.artifact_id.as_str()).collect();
        assert_eq!(tops, ["app"]);
    }

    #[test]
    fn chosen_profiles_bring_their_modules_and_dependencies() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(
            root,
            "pom.xml",
            r#"<project><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version><packaging>pom</packaging>
              <modules><module>core</module></modules>
              <profiles>
                <profile><id>flink-1.17</id><activation><activeByDefault>true</activeByDefault></activation>
                  <modules><module>flink-1.17</module></modules></profile>
                <profile><id>flink-1.20</id><modules><module>flink-1.20</module></modules>
                  <dependencies><dependency><groupId>org.apache.flink</groupId><artifactId>flink-core</artifactId><version>1.20.0</version></dependency></dependencies>
                </profile>
              </profiles>
            </project>"#,
        );
        for m in ["core", "flink-1.17", "flink-1.20"] {
            write(
                root,
                &format!("{m}/pom.xml"),
                &format!(
                    "<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version></parent><artifactId>{m}</artifactId></project>"
                ),
            );
        }
        let dirs = |m: &MavenModel| m.projects.iter().map(|p| p.dir.clone()).collect::<Vec<_>>();
        let flink = |m: &MavenModel, dir: &str| {
            m.projects.iter().find(|p| p.dir == dir).unwrap().dependencies.iter().any(|d| d.artifact_id == "flink-core")
        };

        let default = load_with(root, None, &[]);
        assert_eq!(dirs(&default), ["", "core", "flink-1.17"]);
        assert!(!flink(&default, "core"));

        // Choosing another profile of the POM turns its activeByDefault one off (as `-P` does).
        let chosen = load_with(root, None, &["flink-1.20".into()]);
        assert_eq!(dirs(&chosen), ["", "core", "flink-1.20"]);
        assert!(flink(&chosen, "core"), "a module inherits the chosen profile's dependencies");

        let both = load_with(root, None, &["flink-1.20".into(), "flink-1.17".into()]);
        assert_eq!(dirs(&both), ["", "core", "flink-1.17", "flink-1.20"]);
        assert_eq!(dirs(&load_with(root, None, &["!flink-1.17".into()])), ["", "core"]);
    }

    #[test]
    fn profiles_of_a_parent_pom_are_inherited() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(
            root,
            "pom.xml",
            r#"<project><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version>
              <packaging>pom</packaging><modules><module>child</module></modules>
              <profiles>
                <profile><id>jdk8</id></profile>
                <profile><id>jdk21</id><activation><activeByDefault>true</activeByDefault></activation></profile>
              </profiles>
            </project>"#,
        );
        write(
            root,
            "child/pom.xml",
            r#"<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version></parent>
              <artifactId>child</artifactId>
              <profiles><profile><id>own</id></profile></profiles>
            </project>"#,
        );
        let model = load_with_repo(root, None);
        let child = &model.projects[1];
        // `-Pjdk8` on the module activates the parent's profile, so it is listed.
        assert_eq!(child.profiles, ["jdk8", "jdk21", "own"]);
        let profiles: Vec<(&str, bool)> = model.profiles.iter().map(|p| (p.id.as_str(), p.active_by_default)).collect();
        assert_eq!(profiles, [("jdk8", false), ("jdk21", true), ("own", false)]);
    }

    #[test]
    fn parent_and_bom_from_the_local_repository_and_wrapper() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let root = tmp.path().join("proj");
        write(
            &repo,
            "org/boot/boot-parent/3.0/boot-parent-3.0.pom",
            r#"<project><groupId>org.boot</groupId><artifactId>boot-parent</artifactId><version>3.0</version>
              <properties><java.version>17</java.version><lib.version>9.9</lib.version></properties>
              <dependencyManagement><dependencies>
                <dependency><groupId>org.boot</groupId><artifactId>bom</artifactId><version>${project.parent.version}</version><type>pom</type><scope>import</scope></dependency>
                <dependency><groupId>org.boot</groupId><artifactId>web</artifactId><version>${lib.version}</version></dependency>
              </dependencies></dependencyManagement>
              <build><plugins><plugin><groupId>org.boot</groupId><artifactId>boot-maven-plugin</artifactId><version>${project.version}</version></plugin></plugins></build>
              <parent><groupId>org.boot</groupId><artifactId>root</artifactId><version>3.0</version></parent>
            </project>"#,
        );
        write(
            &repo,
            "org/boot/root/3.0/root-3.0.pom",
            "<project><groupId>org.boot</groupId><artifactId>root</artifactId><version>3.0</version></project>",
        );
        write(
            &repo,
            "org/boot/bom/3.0/bom-3.0.pom",
            r#"<project><groupId>org.boot</groupId><artifactId>bom</artifactId><version>3.0</version>
              <properties><json.version>2.1</json.version></properties>
              <dependencyManagement><dependencies>
                <dependency><groupId>org.json</groupId><artifactId>json</artifactId><version>${json.version}</version></dependency>
                <dependency><groupId>org.boot</groupId><artifactId>web</artifactId><version>0.1</version></dependency>
              </dependencies></dependencyManagement>
            </project>"#,
        );
        write(
            &root,
            "pom.xml",
            r#"<project><parent><groupId>org.boot</groupId><artifactId>boot-parent</artifactId><version>3.0</version><relativePath/></parent>
              <groupId>com.example</groupId><artifactId>demo</artifactId><version>0.1-SNAPSHOT</version>
              <dependencies>
                <dependency><groupId>org.boot</groupId><artifactId>web</artifactId></dependency>
                <dependency><groupId>org.json</groupId><artifactId>json</artifactId></dependency>
                <dependency><groupId>unknown</groupId><artifactId>x</artifactId></dependency>
              </dependencies>
            </project>"#,
        );
        let wrapper = if cfg!(windows) { "mvnw.cmd" } else { "mvnw" };
        write(&root, wrapper, "#!/bin/sh");
        let model = load_with_repo(&root, Some(repo));
        let p = &model.projects[0];
        assert_eq!(p.java_version, Some(17));
        let versions: Vec<Option<&str>> = p.dependencies.iter().map(|d| d.version.as_deref()).collect();
        assert_eq!(versions, [Some("9.9"), Some("2.1"), None], "parent's own entry wins over its BOM");
        let boot = p.plugins.iter().find(|pl| pl.artifact_id == "boot-maven-plugin").unwrap();
        assert_eq!(boot.version.as_deref(), Some("0.1-SNAPSHOT"), "interpolated with the child's version");
        assert_eq!(boot.prefix, "boot");
        assert!(p.command.ends_with(wrapper) && Path::new(&p.command).is_absolute());
    }

    #[test]
    fn folders_of_separate_builds_and_module_cycles() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(
            root,
            "a/pom.xml",
            "<project><groupId>g</groupId><artifactId>a</artifactId><modules><module>../b</module></modules></project>",
        );
        write(
            root,
            "b/pom.xml",
            "<project><groupId>g</groupId><artifactId>b</artifactId><modules><module>../a</module></modules></project>",
        );
        write(root, "c/target/pom.xml", "<project><artifactId>ignored</artifactId></project>");
        let model = load_with_repo(root, None);
        let names: Vec<&str> = model.projects.iter().map(|p| p.artifact_id.as_str()).collect();
        assert_eq!(names, ["a", "b"]);
        assert!(is_maven_project(root));
        assert!(!is_maven_project(&root.join("c")));
    }

    #[test]
    fn non_utf8_pom_with_declared_encoding_is_a_build() {
        // Issue #2439: a GBK `pom.xml` is not valid UTF-8; it must still load
        // instead of vanishing as "No maven project".
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (bytes, _, _) = encoding_rs::GBK.encode(
            "<?xml version=\"1.0\" encoding=\"GBK\"?>\n<project><groupId>g</groupId>\
             <artifactId>应用</artifactId><version>1</version><name>演示</name></project>",
        );
        std::fs::write(root.join("pom.xml"), bytes.as_ref()).unwrap();
        let model = load_with_repo(root, None);
        assert_eq!(model.projects.len(), 1);
        assert_eq!(model.projects[0].artifact_id, "应用");
        assert_eq!(model.projects[0].display_name, "演示");
        assert!(is_maven_project(root));
    }

    #[test]
    fn aggregate_pom_in_src_is_a_build() {
        // Issue #1001: `src/pom.xml` aggregating modules under `src/` is recognized,
        // with its modules loaded — while `src` stays unsearched otherwise.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(
            root,
            "src/pom.xml",
            "<project><groupId>g</groupId><artifactId>parent</artifactId><packaging>pom</packaging>\
             <modules><module>app</module></modules></project>",
        );
        write(root, "src/app/pom.xml", "<project><groupId>g</groupId><artifactId>app</artifactId></project>");
        let model = load_with_repo(root, None);
        let names: Vec<&str> = model.projects.iter().map(|p| p.artifact_id.as_str()).collect();
        assert_eq!(names, ["parent", "app"]);
        assert!(is_maven_project(root));
    }

    #[test]
    fn property_interpolation() {
        let props: HashMap<String, String> =
            [("a", "${b}-x"), ("b", "1"), ("project.version", "2"), ("self", "${self}")]
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect();
        assert_eq!(interpolate("v${a}/${pom.version}/${missing}/${", &props), "v1-x/2/${missing}/${");
        assert_eq!(interpolate("${self}", &props), "${self}");
    }

    #[test]
    fn prefixes() {
        assert_eq!(goal_prefix("maven-surefire-plugin"), "surefire");
        assert_eq!(goal_prefix("spring-boot-maven-plugin"), "spring-boot");
        assert_eq!(goal_prefix("frontend-plugin"), "frontend");
        assert_eq!(goal_prefix("odd"), "odd");
    }

    #[test]
    fn effective_pom_projects() {
        let text = r#"<?xml version="1.0"?><projects>
          <project><parent><groupId>demo</groupId><artifactId>p</artifactId><version>1</version></parent>
            <artifactId>core</artifactId>
            <dependencies><dependency><groupId>j</groupId><artifactId>junit</artifactId><version>5</version><scope>test</scope></dependency></dependencies>
            <build><plugins><plugin><artifactId>maven-clean-plugin</artifactId><version>3.2.0</version>
              <executions><execution><id>default-clean</id><phase>clean</phase><goals><goal>clean</goal></goals></execution></executions>
            </plugin></plugins></build>
          </project>
          <project><groupId>demo</groupId><artifactId>p</artifactId></project>
        </projects>"#;
        let projects = parse_effective_pom(text);
        assert_eq!(projects.len(), 2);
        let (key, plugins, deps) = &projects[0];
        assert_eq!(key, "demo:core");
        assert_eq!((plugins[0].prefix.as_str(), plugins[0].version.as_deref()), ("clean", Some("3.2.0")));
        assert_eq!(plugins[0].goals, ["clean", "help"]);
        assert_eq!((deps[0].artifact_id.as_str(), deps[0].scope.as_str()), ("junit", "test"));
        assert_eq!(projects[1].0, "demo:p");
    }

    #[test]
    fn dependency_tree_output() {
        let out = "\
[INFO] --- dependency:3.7.0:tree (default-cli) @ multi-parent ---
[INFO] demo:multi-parent:pom:1.0-SNAPSHOT
[INFO]
[INFO] --- dependency:3.7.0:tree (default-cli) @ core ---
[INFO] demo:core:jar:1.0-SNAPSHOT
[INFO] +- org.junit.jupiter:junit-jupiter:jar:5.10.2:test
[INFO] |  +- org.junit.jupiter:junit-jupiter-api:jar:5.10.2:test
[INFO] |  |  \\- org.opentest4j:opentest4j:jar:1.3.0:test
[INFO] |  \\- org.junit.jupiter:junit-jupiter-engine:jar:5.10.2:test
[INFO] \\- com.x:native:jar:linux:1.0:compile (optional)
[INFO] ------------------------------------------------------------------------
[INFO] --- dependency:3.10.0:tree (default-cli) @ app ---
[INFO] Loaded 74 auto-discovered prefixes for remote repository apache.snapshots (prefixes-apache.snapshots.txt)
[INFO] demo:app:jar:1.0-SNAPSHOT
[INFO] \\- demo:core:jar:1.0-SNAPSHOT:compile
";
        let trees = parse_dependency_tree(out);
        let keys: Vec<&str> = trees.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["demo:multi-parent", "demo:core", "demo:app"]);
        assert!(trees[0].1.is_empty());
        let core = &trees[1].1;
        assert_eq!(core.len(), 2);
        assert_eq!(core[0].artifact_id, "junit-jupiter");
        let kids: Vec<&str> = core[0].children.iter().map(|d| d.artifact_id.as_str()).collect();
        assert_eq!(kids, ["junit-jupiter-api", "junit-jupiter-engine"]);
        assert_eq!(core[0].children[0].children[0].artifact_id, "opentest4j");
        let native = &core[1];
        assert_eq!(
            (native.classifier.as_deref(), native.version.as_deref(), native.optional),
            (Some("linux"), Some("1.0"), true)
        );
        assert_eq!(trees[2].1[0].scope, "compile");
    }

    /// `mvn org.apache.maven.plugins:maven-dependency-plugin:3.8.1:tree -Dverbose` on a project
    /// whose libraries ask for different commons-lang3 / commons-text / guava versions.
    #[test]
    fn verbose_dependency_tree_output() {
        let trees = parse_dependency_tree(include_str!("../testdata/dependency-tree-verbose.txt"));
        assert_eq!(trees.len(), 1);
        let (key, deps) = &trees[0];
        assert_eq!(key, "demo:conflict-demo");
        let direct: Vec<&str> = deps.iter().map(|d| d.artifact_id.as_str()).collect();
        assert_eq!(direct, ["hamcrest-core", "commons-text", "commons-configuration2", "guava", "guice", "junit"]);
        assert!(deps.iter().all(MavenDependency::resolved));

        let config = &deps[2].children;
        let lang3 = &config[0];
        assert_eq!(
            (lang3.artifact_id.as_str(), lang3.version.as_deref(), lang3.omitted, lang3.conflict_with.as_deref()),
            ("commons-lang3", Some("3.14.0"), Some(Omission::Conflict), Some("3.12.0"))
        );
        assert_eq!(lang3.scope, "compile");
        let logging = &config[2];
        assert_eq!(
            (logging.version.as_deref(), logging.managed_from.as_deref(), logging.omitted),
            (Some("1.2"), Some("1.3.0"), None)
        );
        let guava = &deps[4].children[2];
        assert_eq!((guava.version.as_deref(), guava.conflict_with.as_deref()), (Some("30.1-jre"), Some("32.1.3-jre")));
        let hamcrest = &deps[5].children[0];
        assert_eq!((hamcrest.omitted, hamcrest.scope.as_str()), (Some(Omission::Duplicate), "test"));
        assert_eq!(deps[1].children[0].omitted, None, "the winning commons-lang3");
    }

    #[test]
    fn verbose_annotations() {
        // (line, omitted, conflict winner, managed from, optional)
        type Case<'a> = (&'a str, Option<Omission>, Option<&'a str>, Option<&'a str>, bool);
        let cases: &[Case] = &[
            ("(g:a:jar:1:compile - omitted for cycle)", Some(Omission::Cycle), None, None, false),
            (
                "(g:a:jar:1:compile - version managed from 0.9; omitted for duplicate)",
                Some(Omission::Duplicate),
                None,
                Some("0.9"),
                false,
            ),
            ("g:a:jar:1:compile (optional)", None, None, None, true),
            (
                "(g:a:jar:1:runtime (optional) - omitted for conflict with 2)",
                Some(Omission::Conflict),
                Some("2"),
                None,
                true,
            ),
            (
                "(g:a:jar:1:compile - scope updated from runtime; omitted for duplicate)",
                Some(Omission::Duplicate),
                None,
                None,
                false,
            ),
            (
                "g:a:jar:1:compile (version managed from 0.9; scope managed from runtime)",
                None,
                None,
                Some("0.9"),
                false,
            ),
        ];
        for (line, omitted, winner, managed, optional) in cases {
            let d = parse_coords(line).unwrap();
            assert_eq!(
                (d.omitted, d.conflict_with.as_deref(), d.managed_from.as_deref(), d.optional),
                (*omitted, *winner, *managed, *optional),
                "{line}"
            );
            assert_eq!((d.group_id.as_str(), d.version.as_deref()), ("g", Some("1")), "{line}");
        }
    }

    // ---------------------------------------------------- goto declaration

    /// The position of the first character of `needle` (a click on it).
    fn at(text: &str, needle: &str) -> Pos {
        pos_at(text, text.find(needle).unwrap())
    }

    /// A parent POM and a child of it in `tmp`: the parent at `tmp/pom.xml`, the
    /// child at `tmp/app/pom.xml` (found through the default `../pom.xml`).
    fn write_parent_child(tmp: &Path, parent: &str, child: &str) {
        std::fs::create_dir_all(tmp.join("app")).unwrap();
        std::fs::write(tmp.join("pom.xml"), parent).unwrap();
        std::fs::write(tmp.join("app/pom.xml"), child).unwrap();
    }

    const CHILD_HEADER: &str = r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
  <parent>
    <groupId>com.example</groupId>
    <artifactId>parent</artifactId>
    <version>1.0</version>
  </parent>
  <artifactId>app</artifactId>
"#;

    const PARENT_HEADER: &str = r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
  <groupId>com.example</groupId>
  <artifactId>parent</artifactId>
  <version>1.0</version>
"#;

    #[test]
    fn a_property_reference_finds_its_definition_in_the_same_pom() {
        let text = format!(
            r#"{CHILD_HEADER}<properties>
    <example.version>1.2.3</example.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>lib</artifactId>
      <version>${{example.version}}</version>
    </dependency>
  </dependencies>
</project>"#
        );
        let path = Path::new("/tmp/pom.xml");
        let goto = goto_declaration(&text, path, at(&text, "${example.version}"), None).unwrap();
        assert_eq!(goto.kind, PomGotoKind::Property);
        assert_eq!(goto.label, "example.version");
        assert_eq!(goto.path, path);
        let from = text.find("<example.version>").unwrap();
        let to = text.find("</example.version>").unwrap() + "</example.version>".len();
        assert_eq!(goto.range, Range::new(pos_at(&text, from), pos_at(&text, to)));
    }

    #[test]
    fn an_inherited_property_reference_finds_its_definition_in_the_parent_pom() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = format!(
            r#"{PARENT_HEADER}<properties>
    <example.version>1.2.3</example.version>
  </properties>
</project>"#
        );
        let child = format!(
            r#"{CHILD_HEADER}<dependencies>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>lib</artifactId>
    <version>${{example.version}}</version>
  </dependency>
</dependencies>
</project>"#
        );
        write_parent_child(tmp.path(), &parent, &child);
        let path = tmp.path().join("app/pom.xml");
        let text = std::fs::read_to_string(&path).unwrap();
        let goto = goto_declaration(&text, &path, at(&text, "${example.version}"), None).unwrap();
        assert_eq!(goto.kind, PomGotoKind::Property);
        assert_eq!(goto.path, canon(&tmp.path().join("pom.xml")));
        let from = parent.find("<example.version>").unwrap();
        assert_eq!(goto.range.start, pos_at(&parent, from));
    }

    #[test]
    fn a_child_property_wins_over_the_parent_s_definition() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = format!(
            r#"{PARENT_HEADER}<properties>
    <example.version>1.0.0</example.version>
  </properties>
</project>"#
        );
        let child = format!(
            r#"{CHILD_HEADER}<properties>
    <example.version>2.0.0</example.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>lib</artifactId>
      <version>${{example.version}}</version>
    </dependency>
  </dependencies>
</project>"#
        );
        write_parent_child(tmp.path(), &parent, &child);
        let path = tmp.path().join("app/pom.xml");
        let text = std::fs::read_to_string(&path).unwrap();
        let goto = goto_declaration(&text, &path, at(&text, "${example.version}"), None).unwrap();
        assert_eq!(goto.path, canon(&path), "the child's own definition");
        let from = text.find("<example.version>").unwrap();
        let to = text.find("</example.version>").unwrap() + "</example.version>".len();
        assert_eq!(goto.range, Range::new(pos_at(&text, from), pos_at(&text, to)));
        assert!(text[from..to].contains("2.0.0"));
    }

    #[test]
    fn a_managed_dependency_reference_finds_the_managing_declaration_in_the_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = format!(
            r#"{PARENT_HEADER}<properties>
    <example.version>1.2.3</example.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>example-lib</artifactId>
        <version>${{example.version}}</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>"#
        );
        let child = format!(
            r#"{CHILD_HEADER}<dependencies>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>example-lib</artifactId>
  </dependency>
</dependencies>
</project>"#
        );
        write_parent_child(tmp.path(), &parent, &child);
        let path = tmp.path().join("app/pom.xml");
        let text = std::fs::read_to_string(&path).unwrap();
        let goto = goto_declaration(&text, &path, at(&text, "<artifactId>example-lib"), None).unwrap();
        assert_eq!(goto.kind, PomGotoKind::ManagedDependency);
        assert_eq!(goto.label, "com.example:example-lib");
        assert_eq!(goto.path, canon(&tmp.path().join("pom.xml")));
        let from = parent.find("<artifactId>example-lib</artifactId>").unwrap();
        let to = from + "<artifactId>example-lib</artifactId>".len();
        assert_eq!(goto.range, Range::new(pos_at(&parent, from), pos_at(&parent, to)));
    }

    #[test]
    fn a_managed_plugin_reference_finds_the_managing_declaration_in_the_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = format!(
            r#"{PARENT_HEADER}<build>
  <pluginManagement>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
      </plugin>
    </plugins>
  </pluginManagement>
</build>
</project>"#
        );
        let child = format!(
            r#"{CHILD_HEADER}<build>
  <plugins>
    <plugin>
      <artifactId>maven-compiler-plugin</artifactId>
    </plugin>
  </plugins>
</build>
</project>"#
        );
        write_parent_child(tmp.path(), &parent, &child);
        let path = tmp.path().join("app/pom.xml");
        let text = std::fs::read_to_string(&path).unwrap();
        let goto = goto_declaration(&text, &path, at(&text, "<artifactId>maven-compiler-plugin"), None).unwrap();
        assert_eq!(goto.kind, PomGotoKind::ManagedPlugin);
        assert_eq!(goto.label, "org.apache.maven.plugins:maven-compiler-plugin");
        assert_eq!(goto.path, canon(&tmp.path().join("pom.xml")));
    }

    #[test]
    fn an_inherited_property_is_found_in_a_parent_pom_of_the_local_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repository");
        let parent_dir = repo.join("com/example/parent/1.0");
        std::fs::create_dir_all(&parent_dir).unwrap();
        let parent = format!(
            r#"{PARENT_HEADER}<properties>
    <example.version>1.2.3</example.version>
  </properties>
</project>"#
        );
        std::fs::write(parent_dir.join("parent-1.0.pom"), &parent).unwrap();
        let child = format!(
            r#"{CHILD_HEADER}<dependencies>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>lib</artifactId>
    <version>${{example.version}}</version>
  </dependency>
</dependencies>
</project>"#
        );
        let path = tmp.path().join("app/pom.xml");
        std::fs::create_dir_all(tmp.path().join("app")).unwrap();
        std::fs::write(&path, &child).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let goto = goto_declaration(&text, &path, at(&text, "${example.version}"), Some(repo)).unwrap();
        assert_eq!(goto.kind, PomGotoKind::Property);
        assert_eq!(goto.path, canon(&parent_dir.join("parent-1.0.pom")));
        assert_eq!(goto.range.start, pos_at(&parent, parent.find("<example.version>").unwrap()));
    }

    #[test]
    fn project_version_resolves_to_the_first_pom_declaring_its_own_version() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = format!(r#"{PARENT_HEADER}<packaging>pom</packaging></project>"#);
        let child = format!(
            r#"{CHILD_HEADER}<dependencies>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>lib</artifactId>
    <version>${{project.version}}</version>
  </dependency>
</dependencies>
</project>"#
        );
        write_parent_child(tmp.path(), &parent, &child);
        let path = tmp.path().join("app/pom.xml");
        let text = std::fs::read_to_string(&path).unwrap();
        let goto = goto_declaration(&text, &path, at(&text, "${project.version}"), None).unwrap();
        assert_eq!(goto.path, canon(&tmp.path().join("pom.xml")), "the child has no own <version>");
        assert_eq!(goto.range.start, pos_at(&parent, parent.find("<version>").unwrap()));
    }

    #[test]
    fn clicks_without_a_resolvable_declaration_find_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = format!(
            r#"{PARENT_HEADER}<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>managed-lib</artifactId>
      <version>1.0</version>
    </dependency>
  </dependencies>
</dependencyManagement>
</project>"#
        );
        let child = format!(
            r#"{CHILD_HEADER}<dependencies>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>direct-lib</artifactId>
    <version>${{missing.key}}</version>
  </dependency>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>other-lib</artifactId>
    <version>2.0</version>
  </dependency>
</dependencies>
</project>"#
        );
        write_parent_child(tmp.path(), &parent, &child);
        let path = tmp.path().join("app/pom.xml");
        let text = std::fs::read_to_string(&path).unwrap();
        // The property is declared nowhere along the chain.
        assert_eq!(goto_declaration(&text, &path, at(&text, "${missing.key}"), None), None);
        // The dependency names its own version and no local repository has its POM.
        assert_eq!(goto_declaration(&text, &path, at(&text, "<artifactId>other-lib"), None), None);
        // A management entry declares the version; its artifact's POM is not at hand either.
        let parent_path = tmp.path().join("pom.xml");
        let parent_text = std::fs::read_to_string(&parent_path).unwrap();
        assert_eq!(
            goto_declaration(&parent_text, &parent_path, at(&parent_text, "<artifactId>managed-lib"), None),
            None
        );
        // Offsets beyond the document, and non-POM documents, find nothing.
        assert_eq!(goto_declaration(&text, &path, Pos::new(999, 0), None), None);
        assert_eq!(goto_declaration("<project></project>", &path, Pos::new(0, 3), None), None);
    }

    #[test]
    fn artifacts_go_to_their_own_pom_in_the_project_or_the_local_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let bom_dir = repo.join("com/alibaba/cloud/spring-cloud-alibaba-dependencies/2.2.6.RELEASE");
        std::fs::create_dir_all(&bom_dir).unwrap();
        let bom = "<project>\n  <groupId>com.alibaba.cloud</groupId>\n  <artifactId>spring-cloud-alibaba-dependencies</artifactId>\n</project>";
        std::fs::write(bom_dir.join("spring-cloud-alibaba-dependencies-2.2.6.RELEASE.pom"), bom).unwrap();
        let parent = format!(
            r#"{PARENT_HEADER}<properties><alibaba.version>2.2.6.RELEASE</alibaba.version></properties>
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.alibaba.cloud</groupId>
      <artifactId>spring-cloud-alibaba-dependencies</artifactId>
      <version>${{alibaba.version}}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
</project>"#
        );
        let child = format!(
            r#"{CHILD_HEADER}<dependencies>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>core</artifactId>
    <version>1.0</version>
  </dependency>
</dependencies>
</project>"#
        );
        write_parent_child(tmp.path(), &parent, &child);
        let core = tmp.path().join("core/pom.xml");
        std::fs::create_dir_all(core.parent().unwrap()).unwrap();
        std::fs::write(
            &core,
            "<project>\n  <groupId>com.example</groupId>\n  <artifactId>core</artifactId>\n</project>",
        )
        .unwrap();
        let modules =
            || vec![ModulePom { group_id: "com.example".into(), artifact_id: "core".into(), pom: core.clone() }];

        // A BOM import in <dependencyManagement> opens the BOM from the local repository.
        let parent_path = tmp.path().join("pom.xml");
        let parent_text = std::fs::read_to_string(&parent_path).unwrap();
        let at_bom = at(&parent_text, "spring-cloud-alibaba-dependencies<");
        let goto = goto_declaration_in(&parent_text, &parent_path, at_bom, Some(repo.clone()), modules).unwrap();
        assert_eq!(goto.path, bom_dir.join("spring-cloud-alibaba-dependencies-2.2.6.RELEASE.pom"));
        assert_eq!(goto.kind, PomGotoKind::ArtifactPom);
        assert_eq!(goto.range.start, pos_at(bom, bom.find("<artifactId>").unwrap()));

        // A dependency on a project module opens the module's POM.
        let path = tmp.path().join("app/pom.xml");
        let text = std::fs::read_to_string(&path).unwrap();
        let goto =
            goto_declaration_in(&text, &path, at(&text, "core</artifactId>"), Some(repo.clone()), modules).unwrap();
        assert_eq!((goto.path.as_path(), goto.label.as_str()), (core.as_path(), "com.example:core"));

        // The <parent> section opens the parent POM.
        let goto = goto_declaration_in(&text, &path, at(&text, "parent</artifactId>"), Some(repo), modules).unwrap();
        assert_eq!(goto.path, canon(&parent_path));
        assert_eq!(goto.kind, PomGotoKind::ArtifactPom);
    }

    #[test]
    fn a_property_reference_after_non_ascii_text_is_still_found() {
        let text = format!(
            r#"{CHILD_HEADER}<properties>
    <!-- Версия сборки: сборка 2026 -->
    <example.version>1.2.3</example.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>lib</artifactId>
      <!-- Проверка: ссылка на свойство -->
      <version>${{example.version}}</version>
    </dependency>
  </dependencies>
</project>"#
        );
        let path = Path::new("/tmp/pom.xml");
        let goto = goto_declaration(&text, path, at(&text, "${example.version}"), None).unwrap();
        assert_eq!(goto.kind, PomGotoKind::Property);
        assert_eq!(goto.path, path);
    }
}

#[cfg(test)]
mod linkage_tests {
    use super::*;
    use ide_core::settings::MavenSettings;

    #[test]
    fn excludes_reactor_modules_and_profiles_but_keeps_other_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for (name, body) in [
            (
                "a",
                "<modules><module>child</module><module>../shared</module></modules><profiles><profile><id>only-a</id></profile></profiles>",
            ),
            ("a/child", ""),
            ("shared", ""),
            ("b", ""),
        ] {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(
                root.join(name).join("pom.xml"),
                format!("<project><artifactId>{name}</artifactId>{body}</project>"),
            )
            .unwrap();
        }
        let original = load_with_repo(root, None);
        let settings = MavenSettings { unlinked_projects: vec!["./a/pom.xml".into()], ..Default::default() };
        let unlinked = UnlinkedProjects::from_model(&original, &settings);
        assert!(unlinked.contains("a/child/pom.xml"));
        assert!(unlinked.contains("shared/pom.xml"));
        assert!(unlinked.contains("a/../shared/pom.xml"));
        assert!(!unlinked.contains("b/pom.xml"));
        let mut model = original.clone();
        unlinked.filter(&mut model);
        assert_eq!(model.projects.iter().map(|p| p.pom.as_str()).collect::<Vec<_>>(), ["b/pom.xml"]);
        assert!(model.profiles.is_empty());
        let mut restored = original.clone();
        UnlinkedProjects::from_model(&original, &MavenSettings::default()).filter(&mut restored);
        assert_eq!(restored, original);
    }

    #[test]
    fn language_server_imports_reactor_modules_individually_once_one_is_unlinked() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // r ─┬─ x
        //    ├─ y ─┬─ y/y1
        //    │     └─ y/y2
        //    └─ z          other/ is a separate root.
        for (dir, modules) in [
            ("r", "<modules><module>x</module><module>y</module><module>z</module></modules>"),
            ("r/x", ""),
            ("r/y", "<modules><module>y1</module><module>y2</module></modules>"),
            ("r/y/y1", ""),
            ("r/y/y2", ""),
            ("r/z", ""),
            ("other", ""),
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(
                root.join(dir).join("pom.xml"),
                format!("<project><artifactId>{dir}</artifactId>{modules}</project>"),
            )
            .unwrap();
        }
        let model = load_with_repo(root, None);
        let cases: [(&[&str], Option<&[&str]>); 5] = [
            // Nothing unlinked, or whole roots: the import exclusions do it.
            (&[], None),
            (&["other/pom.xml"], None),
            (&["r/pom.xml"], None),
            // A module of a linked reactor: every other linked POM, minus the aggregators above it.
            (&["r/y/y1/pom.xml"], Some(&["other/pom.xml", "r/x/pom.xml", "r/y/y2/pom.xml", "r/z/pom.xml"])),
            (&["./r/y/pom.xml"], Some(&["other/pom.xml", "r/x/pom.xml", "r/z/pom.xml"])),
        ];
        for (unlinked, expected) in cases {
            let settings = MavenSettings {
                unlinked_projects: unlinked.iter().map(|s| s.to_string()).collect(),
                ..Default::default()
            };
            let mut poms = UnlinkedProjects::from_model(&model, &settings).import_poms(&model);
            if let Some(poms) = &mut poms {
                poms.sort();
            }
            assert_eq!(poms, expected.map(|e| e.iter().map(|s| s.to_string()).collect::<Vec<_>>()), "{unlinked:?}");
        }
    }
}
