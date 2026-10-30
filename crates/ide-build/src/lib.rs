//! Build tool models for the Maven and Gradle tool windows, and Build › Build
//! Project ([`compile`]) for Maven, Gradle, Cargo, Go and TypeScript projects.
//!
//! [`load`] reads the project's build files (instant, no build tool involved)
//! and merges what the last sync ([`sync_maven`] / [`sync_gradle`], which run
//! Maven / Gradle in the background) cached for the project.

pub mod compile;
pub mod gradle;
pub mod maven;
pub mod pom_edit;
mod process;
mod sync;
pub mod web;
mod xml;

pub use gradle::{GradleModel, GradleProject, GradleTask};
pub use maven::{MavenDependency, MavenModel, MavenPlugin, MavenProfile, MavenProject, Omission};
pub use sync::{SyncOptions, SyncProgress, sync_gradle, sync_maven};

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BuildTool {
    Maven,
    Gradle,
}

/// The build systems of a project; `None` when the project does not use one.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BuildModel {
    pub maven: Option<MavenModel>,
    pub gradle: Option<GradleModel>,
}

/// Static model of the builds under `root`, merged with the sync results cached in `cache_dir`.
/// Parent POMs are looked up in `maven_repo` (the configured local repository), else the default one.
pub fn load(root: &Path, cache_dir: &Path, maven_repo: Option<PathBuf>) -> BuildModel {
    load_linked(root, cache_dir, maven_repo, &ide_core::settings::MavenSettings::default())
}

/// Loads only linked Maven reactors, retaining an empty model so projects can be re-added.
pub fn load_linked(
    root: &Path,
    cache_dir: &Path,
    maven_repo: Option<PathBuf>,
    settings: &ide_core::settings::MavenSettings,
) -> BuildModel {
    let maven = maven::is_maven_project(root).then(|| {
        let mut m = maven::load_with_repo(root, maven_repo.or_else(maven::default_local_repo));
        maven::UnlinkedProjects::from_model(&m, settings).filter(&mut m);
        sync::apply_maven_cache(root, cache_dir, &mut m);
        m
    });
    let gradle = gradle::load(root).map(|mut g| {
        sync::apply_gradle_cache(root, cache_dir, &mut g);
        g
    });
    BuildModel { maven, gradle }
}

/// A library the project depends on, as `groupId:artifactId:version`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DependencyCoordinate {
    /// Gradle builds resolve into the Gradle cache, Maven ones into the local repository.
    pub gradle: bool,
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
}

/// The external libraries of `model`, sorted and deduplicated: Maven dependencies
/// (with the transitive ones the last sync read), except the build's own modules,
/// `pom` imports and `system` scope; dependencies declared in the Gradle build scripts.
pub fn dependency_coordinates(root: &Path, model: &BuildModel) -> Vec<DependencyCoordinate> {
    let mut out = Vec::new();
    if let Some(m) = &model.maven {
        let modules: std::collections::HashSet<String> = m.projects.iter().map(MavenProject::key).collect();
        let mut stack: Vec<&MavenDependency> = m.projects.iter().flat_map(|p| &p.dependencies).collect();
        while let Some(d) = stack.pop() {
            // Omitted occurrences (conflict losers, duplicates) are not on any classpath.
            if !d.resolved() {
                continue;
            }
            stack.extend(&d.children);
            let Some(version) = d.version.as_deref().filter(|v| !v.is_empty() && !v.contains("${")) else {
                continue;
            };
            if d.kind == "pom" || matches!(d.scope.as_str(), "import" | "system") {
                continue;
            }
            if modules.contains(&format!("{}:{}", d.group_id, d.artifact_id)) {
                continue;
            }
            out.push(DependencyCoordinate {
                gradle: false,
                group_id: d.group_id.clone(),
                artifact_id: d.artifact_id.clone(),
                version: version.to_owned(),
            });
        }
    }
    if let Some(g) = &model.gradle {
        for script in g.projects.iter().filter_map(|p| p.build_file.as_ref()) {
            let Ok(text) = std::fs::read_to_string(root.join(script)) else { continue };
            out.extend(gradle::script_dependencies(&text).into_iter().map(|(group_id, artifact_id, version)| {
                DependencyCoordinate { gradle: true, group_id, artifact_id, version }
            }));
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Whether a created / changed / removed project-relative path can change the build model.
pub fn affects_build(rel: &Path) -> bool {
    let Some(name) = rel.file_name().and_then(|n| n.to_str()) else { return false };
    name == "pom.xml"
        || gradle::SETTINGS_FILES.contains(&name)
        || gradle::BUILD_FILES.contains(&name)
        || matches!(name, "mvnw" | "mvnw.cmd" | "gradlew" | "gradlew.bat")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_build_systems_and_build_files() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache");
        let root = tmp.path().join("p");
        std::fs::create_dir_all(root.join("svc")).unwrap();
        assert_eq!(load(&root, &cache, None), BuildModel::default());
        std::fs::write(root.join("svc/pom.xml"), "<project><artifactId>svc</artifactId></project>").unwrap();
        std::fs::write(root.join("build.gradle"), "").unwrap();
        let m = load(&root, &cache, None);
        assert_eq!(m.maven.unwrap().projects[0].pom, "svc/pom.xml");
        assert_eq!(m.gradle.unwrap().projects[0].path, ":");
        assert!(affects_build(Path::new("a/pom.xml")) && affects_build(Path::new("settings.gradle.kts")));
        assert!(!affects_build(Path::new("src/Main.java")));
    }

    #[test]
    fn dependency_coordinates_flatten_maven_trees_and_read_gradle_scripts() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("build.gradle"), "dependencies { implementation 'org.a:x:1.0' }\n").unwrap();
        let dep = |g: &str, a: &str, v: Option<&str>, children: Vec<MavenDependency>| MavenDependency {
            group_id: g.into(),
            artifact_id: a.into(),
            version: v.map(Into::into),
            kind: "jar".into(),
            scope: "compile".into(),
            children,
            ..Default::default()
        };
        let maven = MavenModel {
            projects: vec![
                MavenProject {
                    group_id: "me".into(),
                    artifact_id: "app".into(),
                    dependencies: vec![
                        dep("me", "core", Some("1"), vec![]),
                        dep(
                            "org.b",
                            "y",
                            Some("2"),
                            vec![
                                dep("org.c", "z", Some("3"), vec![]),
                                MavenDependency {
                                    omitted: Some(Omission::Conflict),
                                    conflict_with: Some("3".into()),
                                    ..dep("org.c", "z", Some("1"), vec![])
                                },
                            ],
                        ),
                        dep("org.d", "unresolved", Some("${v}"), vec![]),
                    ],
                    ..Default::default()
                },
                MavenProject { group_id: "me".into(), artifact_id: "core".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        let gradle = gradle::load(root);
        let model = BuildModel { maven: Some(maven), gradle };
        let names: Vec<String> = dependency_coordinates(root, &model)
            .into_iter()
            .map(|c| format!("{}{}:{}:{}", if c.gradle { "G " } else { "M " }, c.group_id, c.artifact_id, c.version))
            .collect();
        assert_eq!(names, ["M org.b:y:2", "M org.c:z:3", "G org.a:x:1.0"]);
    }
}
