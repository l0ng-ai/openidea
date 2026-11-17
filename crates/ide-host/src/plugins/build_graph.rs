//! `build.dependencies`: the Dependency Analyzer's Maven / Gradle trees as the flat
//! list the plugin API passes (records can't nest), each module a root.

use ide_build::{GradleDependency, GradleReport, MavenDependency, MavenProject, Omission};
use ide_plugin::{DependencyNode, DependencyStatus, HostError};

/// Most nodes one call returns.
const MAX_NODES: usize = 100_000;

/// What the IDE has resolved of a project's builds, without running a build tool.
#[derive(Clone, Debug, Default)]
pub struct BuildGraph {
    /// Maven modules with their dependencies (with the transitive ones after a sync).
    pub maven: Vec<MavenProject>,
    pub gradle: Vec<GradleModule>,
}

/// A Gradle project and the reports the Dependency Analyzer read for it.
#[derive(Clone, Debug, Default)]
pub struct GradleModule {
    /// Gradle path (`:`, `:app`).
    pub path: String,
    /// One per configuration read.
    pub reports: Vec<GradleReport>,
}

/// The graph of `module` (a Maven `groupId:artifactId` or a Gradle path), or of every module.
pub fn dependency_nodes(graph: &BuildGraph, module: Option<&str>) -> Result<Vec<DependencyNode>, HostError> {
    let mut out = Nodes(Vec::new());
    let mut found = false;
    for p in graph.maven.iter().filter(|p| module.is_none_or(|m| m == p.key())) {
        found = true;
        let root = out.push(DependencyNode {
            group: p.group_id.clone(),
            artifact: p.artifact_id.clone(),
            version: p.version.clone(),
            scope: String::new(),
            status: DependencyStatus::Resolved,
            requested_version: None,
            parent: None,
        })?;
        out.maven(&p.dependencies, root)?;
    }
    for g in graph.gradle.iter().filter(|g| module.is_none_or(|m| m == g.path)) {
        found = true;
        let root = out.push(DependencyNode {
            group: String::new(),
            artifact: g.path.clone(),
            version: String::new(),
            scope: String::new(),
            status: DependencyStatus::Resolved,
            requested_version: None,
            parent: None,
        })?;
        for report in &g.reports {
            out.gradle(&report.dependencies, &report.configuration, root)?;
        }
    }
    match module {
        Some(m) if !found => Err(HostError::NotFound(format!("no Maven or Gradle module `{m}` in this project"))),
        _ => Ok(out.0),
    }
}

struct Nodes(Vec<DependencyNode>);

impl Nodes {
    fn push(&mut self, node: DependencyNode) -> Result<u32, HostError> {
        if self.0.len() >= MAX_NODES {
            return Err(HostError::Failed(format!(
                "the dependency graph has more than {MAX_NODES} nodes; ask for one module"
            )));
        }
        self.0.push(node);
        Ok((self.0.len() - 1) as u32)
    }

    fn maven(&mut self, deps: &[MavenDependency], parent: u32) -> Result<(), HostError> {
        for d in deps {
            let version = d.version.clone().unwrap_or_default();
            let (status, version, requested) = match d.omitted {
                // `version` lost to `conflict_with`.
                Some(Omission::Conflict) => (
                    DependencyStatus::OmittedForConflict,
                    d.conflict_with.clone().unwrap_or_else(|| version.clone()),
                    Some(version),
                ),
                Some(Omission::Duplicate | Omission::Cycle) => {
                    (DependencyStatus::OmittedForDuplicate, version, d.managed_from.clone())
                }
                None if d.managed_from.is_some() => (DependencyStatus::VersionManaged, version, d.managed_from.clone()),
                None => (DependencyStatus::Resolved, version, None),
            };
            let index = self.push(DependencyNode {
                group: d.group_id.clone(),
                artifact: d.artifact_id.clone(),
                requested_version: requested.filter(|r| *r != version),
                version,
                scope: d.scope.clone(),
                status,
                parent: Some(parent),
            })?;
            self.maven(&d.children, index)?;
        }
        Ok(())
    }

    fn gradle(&mut self, deps: &[GradleDependency], configuration: &str, parent: u32) -> Result<(), HostError> {
        // A constraint is not a dependency: it occurs as one elsewhere in the tree.
        for d in deps.iter().filter(|d| !d.constraint) {
            let (status, version, requested) = if d.project || d.unresolved {
                (DependencyStatus::Resolved, String::new(), None)
            } else {
                match (&d.requested, &d.selected) {
                    (_, None) => (DependencyStatus::Resolved, d.requested.clone().unwrap_or_default(), None),
                    // A platform or a constraint supplies the version.
                    (None, Some(selected)) => (DependencyStatus::VersionManaged, selected.clone(), None),
                    // Conflict resolution picked another version than this exact request.
                    (Some(requested), Some(selected)) if exact_version(requested) => {
                        (DependencyStatus::OmittedForConflict, selected.clone(), Some(requested.clone()))
                    }
                    // A range or a rich version (`1.+`, `{strictly 2.0}`) resolved as asked.
                    (Some(requested), Some(selected)) => {
                        (DependencyStatus::Resolved, selected.clone(), Some(requested.clone()))
                    }
                }
            };
            let status = if d.repeated && status == DependencyStatus::Resolved {
                DependencyStatus::OmittedForDuplicate
            } else {
                status
            };
            let index = self.push(DependencyNode {
                group: d.group.clone(),
                artifact: d.name.clone(),
                requested_version: requested.filter(|r| *r != version),
                version,
                scope: configuration.to_owned(),
                status,
                parent: Some(parent),
            })?;
            self.gradle(&d.children, configuration, index)?;
        }
        Ok(())
    }
}

/// `1.2.3`, not a range, dynamic or rich version (`[1,2)`, `1.+`, `latest.release`, `{strictly 1}`).
fn exact_version(v: &str) -> bool {
    !v.is_empty() && !v.starts_with("latest.") && !v.contains(['[', ']', '(', ')', ',', '+', '{', '}', ' '])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn maven(group: &str, artifact: &str, version: &str, scope: &str) -> MavenDependency {
        MavenDependency {
            group_id: group.into(),
            artifact_id: artifact.into(),
            version: Some(version.into()),
            kind: "jar".into(),
            scope: scope.into(),
            ..Default::default()
        }
    }

    fn gradle(group: &str, name: &str, requested: Option<&str>, selected: Option<&str>) -> GradleDependency {
        GradleDependency {
            group: group.into(),
            name: name.into(),
            requested: requested.map(Into::into),
            selected: selected.map(Into::into),
            ..Default::default()
        }
    }

    /// (group, artifact, version, scope, status, requested, parent) of every node.
    type Row<'a> = (&'a str, &'a str, &'a str, &'a str, DependencyStatus, Option<&'a str>, Option<u32>);

    fn rows(nodes: &[DependencyNode]) -> Vec<Row<'_>> {
        nodes
            .iter()
            .map(|n| {
                (
                    n.group.as_str(),
                    n.artifact.as_str(),
                    n.version.as_str(),
                    n.scope.as_str(),
                    n.status,
                    n.requested_version.as_deref(),
                    n.parent,
                )
            })
            .collect()
    }

    fn graph() -> BuildGraph {
        let mut lang3_lost = maven("org.apache.commons", "commons-lang3", "3.12.0", "compile");
        lang3_lost.omitted = Some(Omission::Conflict);
        lang3_lost.conflict_with = Some("3.14.0".into());
        let mut text = maven("org.apache.commons", "commons-text", "1.11.0", "compile");
        text.children = vec![lang3_lost];
        let mut logging = maven("commons-logging", "commons-logging", "1.3.0", "compile");
        logging.managed_from = Some("1.2".into());
        let mut junit_again = maven("junit", "junit", "4.13.2", "test");
        junit_again.omitted = Some(Omission::Duplicate);
        let mut hamcrest = maven("org.hamcrest", "hamcrest", "2.2", "test");
        hamcrest.children = vec![junit_again];
        let app = MavenProject {
            group_id: "com.example".into(),
            artifact_id: "app".into(),
            version: "1.0".into(),
            dependencies: vec![
                maven("org.apache.commons", "commons-lang3", "3.14.0", "compile"),
                text,
                logging,
                hamcrest,
            ],
            ..Default::default()
        };
        let mut databind = gradle("com.fasterxml.jackson.core", "jackson-databind", Some("2.15.0"), Some("2.15.3"));
        databind.repeated = true;
        let mut web = gradle("org.springframework.boot", "spring-boot-starter-web", None, Some("3.2.0"));
        web.children = vec![databind];
        let mut constraint = gradle("com.google.guava", "guava", Some("32.1.3-jre"), None);
        constraint.constraint = true;
        let mut core = gradle("", ":core", None, None);
        core.project = true;
        core.children = vec![constraint];
        let mut failed = gradle("org.missing", "gone", Some("9"), None);
        failed.unresolved = true;
        let report = GradleReport {
            project: ":web".into(),
            configuration: "runtimeClasspath".into(),
            dependencies: vec![
                web,
                core,
                gradle("org.slf4j", "slf4j-api", Some("2.+"), Some("2.0.13")),
                gradle("org.yaml", "snakeyaml", Some("2.2"), None),
                failed,
            ],
        };
        BuildGraph {
            maven: vec![app],
            gradle: vec![
                GradleModule { path: ":web".into(), reports: vec![report] },
                GradleModule { path: ":".into(), reports: Vec::new() },
            ],
        }
    }

    #[test]
    fn modules_are_roots_with_their_trees_flattened_under_them() {
        use DependencyStatus::*;
        let nodes = dependency_nodes(&graph(), None).unwrap();
        assert_eq!(
            rows(&nodes),
            [
                ("com.example", "app", "1.0", "", Resolved, None, None),
                ("org.apache.commons", "commons-lang3", "3.14.0", "compile", Resolved, None, Some(0)),
                ("org.apache.commons", "commons-text", "1.11.0", "compile", Resolved, None, Some(0)),
                (
                    "org.apache.commons",
                    "commons-lang3",
                    "3.14.0",
                    "compile",
                    OmittedForConflict,
                    Some("3.12.0"),
                    Some(2)
                ),
                ("commons-logging", "commons-logging", "1.3.0", "compile", VersionManaged, Some("1.2"), Some(0)),
                ("org.hamcrest", "hamcrest", "2.2", "test", Resolved, None, Some(0)),
                ("junit", "junit", "4.13.2", "test", OmittedForDuplicate, None, Some(5)),
                ("", ":web", "", "", Resolved, None, None),
                (
                    "org.springframework.boot",
                    "spring-boot-starter-web",
                    "3.2.0",
                    "runtimeClasspath",
                    VersionManaged,
                    None,
                    Some(7)
                ),
                (
                    "com.fasterxml.jackson.core",
                    "jackson-databind",
                    "2.15.3",
                    "runtimeClasspath",
                    OmittedForConflict,
                    Some("2.15.0"),
                    Some(8)
                ),
                ("", ":core", "", "runtimeClasspath", Resolved, None, Some(7)),
                ("org.slf4j", "slf4j-api", "2.0.13", "runtimeClasspath", Resolved, Some("2.+"), Some(7)),
                ("org.yaml", "snakeyaml", "2.2", "runtimeClasspath", Resolved, None, Some(7)),
                ("org.missing", "gone", "", "runtimeClasspath", Resolved, None, Some(7)),
                ("", ":", "", "", Resolved, None, None),
            ]
        );
    }

    #[test]
    fn one_module_by_its_maven_key_or_gradle_path() {
        let maven = dependency_nodes(&graph(), Some("com.example:app")).unwrap();
        assert_eq!((maven.len(), maven[0].artifact.as_str()), (7, "app"));
        let gradle = dependency_nodes(&graph(), Some(":web")).unwrap();
        assert_eq!((gradle.len(), gradle[0].artifact.as_str(), gradle[1].parent), (7, ":web", Some(0)));
        // A Gradle project with no report read yet is known, with nothing under it.
        assert_eq!(dependency_nodes(&graph(), Some(":")).unwrap().len(), 1);
        let err = dependency_nodes(&graph(), Some("app")).unwrap_err();
        assert!(matches!(err, HostError::NotFound(_)), "{err:?}");
        assert!(dependency_nodes(&BuildGraph::default(), None).unwrap().is_empty());
    }

    #[test]
    fn a_graph_too_large_for_one_call_fails() {
        let app = MavenProject {
            group_id: "g".into(),
            artifact_id: "a".into(),
            dependencies: vec![maven("g", "d", "1", "compile"); MAX_NODES],
            ..Default::default()
        };
        let graph = BuildGraph { maven: vec![app], gradle: Vec::new() };
        assert!(matches!(dependency_nodes(&graph, None), Err(HostError::Failed(_))));
    }

    #[test]
    fn exact_versions() {
        for v in ["1.0", "32.1.3-jre", "2.15.0"] {
            assert!(exact_version(v), "{v}");
        }
        for v in ["", "1.+", "[1.0,2.0)", "latest.release", "{strictly 1.0}"] {
            assert!(!exact_version(v), "{v}");
        }
    }
}
