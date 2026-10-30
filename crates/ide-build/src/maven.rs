//! Maven projects for the Maven tool window, read straight from `pom.xml`:
//! coordinates, `<modules>` (aggregators), profiles, plugins (declared plus
//! the default lifecycle bindings of the packaging) and direct dependencies.
//!
//! `${properties}` are resolved through the parent chain, which is followed
//! into the local repository (`~/.m2/repository`) when the parent is not in the
//! project, together with imported BOMs. Nothing here runs Maven: [`crate::sync`]
//! later replaces plugins and dependencies with the effective build.

use crate::xml::{self, Element};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

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
    /// Maven launcher: the nearest `mvnw` up to the project root (absolute), else `mvn`.
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
    /// `<build><plugins>` `maven-compiler-plugin` `<release>` / `<source>`.
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

fn read_properties(e: Option<&Element>) -> Vec<(String, String)> {
    e.map(|p| p.children.iter().map(|c| (c.name.clone(), c.text.trim().to_owned())).collect()).unwrap_or_default()
}

fn texts(e: &Element, path: &str, item: &str) -> Vec<String> {
    e.list(path, item).iter().map(|m| m.text.trim().to_owned()).filter(|m| !m.is_empty()).collect()
}

fn read_build(e: &Element, plugins: &mut Vec<RawPlugin>, managed: &mut Vec<RawPlugin>) {
    plugins.extend(e.list("build/plugins", "plugin").into_iter().filter_map(read_plugin));
    managed.extend(e.list("build/pluginManagement/plugins", "plugin").into_iter().filter_map(read_plugin));
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
        modules: texts(project, "modules", "module"),
        deps: project.list("dependencies", "dependency").into_iter().filter_map(read_dep).collect(),
        managed: project
            .list("dependencyManagement/dependencies", "dependency")
            .into_iter()
            .filter_map(read_dep)
            .collect(),
        ..RawPom::default()
    };
    read_build(project, &mut pom.plugins, &mut pom.managed_plugins);
    if let Some(c) = pom.plugins.iter().position(|p| p.artifact_id == "maven-compiler-plugin") {
        let plugin =
            project.list("build/plugins", "plugin").into_iter().filter(|p| p.text_of("artifactId").is_some()).nth(c);
        if let Some(cfg) = plugin.and_then(|p| p.child("configuration")) {
            pom.compiler_release = cfg.text_of("release").or_else(|| cfg.text_of("source"));
        }
    }
    for p in project.list("profiles", "profile") {
        let mut profile = RawProfile {
            id: p.text_of("id").unwrap_or_else(|| "default".into()),
            active_by_default: p.at("activation/activeByDefault").is_some_and(|a| a.text.trim() == "true"),
            modules: texts(p, "modules", "module"),
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
    poms: HashMap<PathBuf, Option<RawPom>>,
    contexts: HashMap<PathBuf, Inherited>,
}

/// `~/.m2/repository`, or `<localRepository>` from `~/.m2/settings.xml`.
pub(crate) fn default_local_repo() -> Option<PathBuf> {
    let m2 = dirs::home_dir()?.join(".m2");
    if let Some(settings) = std::fs::read_to_string(m2.join("settings.xml")).ok().and_then(|t| xml::parse(&t))
        && let Some(repo) = settings.text_of("localRepository")
    {
        let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
        return Some(PathBuf::from(repo.replace("${user.home}", &home)));
    }
    Some(m2.join("repository"))
}

impl Resolver {
    fn new(local_repo: Option<PathBuf>) -> Self {
        Self { local_repo, poms: HashMap::new(), contexts: HashMap::new() }
    }

    fn pom(&mut self, path: &Path) -> Option<RawPom> {
        self.poms
            .entry(path.to_path_buf())
            .or_insert_with(|| std::fs::read_to_string(path).ok().and_then(|t| parse_pom(&t)))
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
        for p in pom.profiles.iter().filter(|p| p.active_by_default) {
            merge_by(&mut ctx.properties, &p.properties, |(k, _)| k.clone());
            merge_by(&mut ctx.deps, &p.deps, RawDep::key);
            merge_plugins(&mut ctx.plugins, &p.plugins);
        }
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

/// Goals of well-known plugins (their plugin descriptors are not read).
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

/// A plugin as shown in the tree: execution goals plus the plugin's known goals, sorted.
pub(crate) fn plugin(group_id: &str, artifact_id: &str, version: Option<String>, goals: &[String]) -> MavenPlugin {
    let mut all: Vec<String> = known_goals(artifact_id).iter().map(|g| (*g).to_owned()).collect();
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

/// Directories never searched for POMs.
const SKIP_DIRS: &[&str] = &["node_modules", "target", "build", "out", "dist", "src", "vendor"];
const MAX_PROJECTS: usize = 1000;
const POM_SEARCH_DEPTH: usize = 3;

fn rel_path(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// The POMs that are not modules of another one: the root `pom.xml`, else the
/// shallowest `pom.xml` of each branch (a folder holding several builds).
fn top_level_poms(root: &Path) -> Vec<PathBuf> {
    let top = root.join("pom.xml");
    if top.is_file() {
        return vec![top];
    }
    let mut out = Vec::new();
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = queue.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut dirs: Vec<PathBuf> = Vec::new();
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().is_ok_and(|t| t.is_dir()) && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str())
            {
                dirs.push(e.path());
            }
        }
        dirs.sort();
        for d in dirs.into_iter().rev() {
            if d.join("pom.xml").is_file() {
                out.push(d.join("pom.xml"));
            } else if depth + 1 < POM_SEARCH_DEPTH {
                queue.push((d, depth + 1));
            }
        }
    }
    out.sort();
    out
}

/// Whether `root` holds a Maven build (cheap: the same search as [`load`] without parsing).
pub fn is_maven_project(root: &Path) -> bool {
    !top_level_poms(root).is_empty()
}

/// The `mvnw` nearest to `dir`, looking up to `root`.
fn wrapper(root: &Path, dir: &Path) -> String {
    let name = if cfg!(windows) { "mvnw.cmd" } else { "mvnw" };
    let mut cur = Some(dir);
    while let Some(d) = cur {
        if d.join(name).is_file() {
            return d.join(name).to_string_lossy().into_owned();
        }
        if d == root {
            break;
        }
        cur = d.parent();
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

pub(crate) fn load_with_repo(root: &Path, local_repo: Option<PathBuf>) -> MavenModel {
    let mut resolver = Resolver::new(local_repo);
    let mut model = MavenModel::default();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    // (pom, aggregated)
    let mut stack: Vec<(PathBuf, bool)> = top_level_poms(root).into_iter().rev().map(|p| (p, false)).collect();
    while let Some((path, aggregated)) = stack.pop() {
        if model.projects.len() >= MAX_PROJECTS {
            break;
        }
        let canonical = dunce::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !seen.insert(canonical) {
            continue;
        }
        let Some(pom) = resolver.pom(&path) else { continue };
        let dir = path.parent().unwrap_or(root).to_path_buf();
        let ctx = resolver.context(&path, 0);
        let props = resolver.properties_for(&pom, &ctx, &dir);
        let i = |s: &str| interpolate(s, &props);

        let mut module_names: Vec<String> = pom.modules.clone();
        for p in pom.profiles.iter().filter(|p| p.active_by_default) {
            module_names.extend(p.modules.iter().cloned());
        }
        let mut modules: Vec<PathBuf> = Vec::new();
        for m in module_names {
            let mut mp = dir.join(i(&m));
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
                plugin(&i(&p.group_id), &i(&p.artifact_id), version, &p.goals)
            })
            .collect();

        let jv = ["maven.compiler.release", "java.version", "maven.compiler.source", "maven.compiler.target"]
            .iter()
            .find_map(|k| props.get(*k).map(|v| i(v)))
            .or_else(|| pom.compiler_release.as_deref().map(i))
            .and_then(|v| java_version(&v));

        for p in &pom.profiles {
            if !model.profiles.iter().any(|x| x.id == p.id) {
                model.profiles.push(MavenProfile { id: p.id.clone(), active_by_default: p.active_by_default });
            }
        }
        let artifact_id = i(&pom.artifact_id);
        model.projects.push(MavenProject {
            pom: rel_path(root, &path),
            dir: rel_path(root, &dir),
            group_id: i(props.get("project.groupId").map(String::as_str).unwrap_or_default()),
            version: i(props.get("project.version").map(String::as_str).unwrap_or_default()),
            display_name: pom.name.as_deref().map(i).filter(|n| !n.is_empty()).unwrap_or_else(|| artifact_id.clone()),
            artifact_id,
            packaging,
            parent: pom.parent.as_ref().map(|p| format!("{}:{}:{}", p.group_id, p.artifact_id, i(&p.version))),
            modules: modules.iter().map(|m| rel_path(root, m)).collect(),
            aggregated,
            plugins,
            dependencies,
            profiles: pom.profiles.iter().map(|p| p.id.clone()).collect(),
            java_version: jv,
            command: wrapper(root, &dir),
            options: Vec::new(),
            env: BTreeMap::new(),
        });
        for m in modules.into_iter().rev() {
            stack.push((m, true));
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
        Self::from_model(&load(root), settings)
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
    let mut parts = Vec::new();
    for part in pom.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}

/// Every POM of the model (for change detection).
pub fn build_files(root: &Path, model: &MavenModel) -> Vec<PathBuf> {
    model.projects.iter().map(|p| root.join(&p.pom)).collect()
}

/// Projects and their plugins / dependencies from `mvn help:effective-pom` output
/// (`<project>` or `<projects>`), keyed `groupId:artifactId`.
pub fn parse_effective_pom(text: &str) -> Vec<(String, Vec<MavenPlugin>, Vec<MavenDependency>)> {
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
                .map(|pl| plugin(&pl.group_id, &pl.artifact_id, pl.version.clone(), &pl.goals))
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(model.projects.iter().all(|p| p.command == if cfg!(windows) { "mvn.cmd" } else { "mvn" }));
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
}
