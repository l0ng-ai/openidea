//! Build tool models for the Maven, Gradle and sbt tool windows, and Build › Build
//! Project ([`compile`]) for Maven, Gradle, Cargo, Go and TypeScript projects.
//!
//! [`load`] reads the project's build files (instant, no build tool involved)
//! and merges what the last sync ([`sync_maven`] / [`sync_gradle`], which run
//! Maven / Gradle in the background) cached for the project.

pub mod application_update;
pub mod compile;
pub mod gradle;
mod gradle_deps;
pub mod kotlin_bridge;
pub mod maven;
pub mod pom_edit;
mod process;
#[cfg(test)]
mod process_numbers;
pub mod sbt;
mod sync;
pub mod web;
mod xml;

pub use gradle::{GradleModel, GradleProject, GradleTask};
pub use gradle_deps::{GradleDependency, GradleReport, gradle_dependencies, gradle_reports, save_gradle_report};
pub use maven::{MavenDependency, MavenModel, MavenPlugin, MavenProfile, MavenProject, Omission};
pub use sbt::{SbtBuild, SbtProject};
pub use sync::{
    SyncOptions, SyncProgress, maven_offline, maven_profiles, save_maven_offline, save_maven_profiles, sync_gradle,
    sync_gradle_model, sync_maven,
};

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
    #[serde(default)]
    pub gradle: Vec<GradleModel>,
    /// sbt builds, read from their `build.sbt` (sbt is not started).
    #[serde(default)]
    pub sbt: Vec<SbtBuild>,
}

impl BuildModel {
    /// Prefer the deepest linked build owning the module over a composite including it.
    pub fn gradle_for_module(&self, root: &Path, module: &Path) -> Option<&GradleModel> {
        let module = root.join(module);
        self.gradle.iter().filter(|g| g.projects.iter().any(|p| root.join(&p.dir) == module)).min_by_key(|g| {
            let dir = root.join(&g.dir);
            std::cmp::Reverse(if module.starts_with(&dir) { dir.components().count() } else { 0 })
        })
    }
}

/// Static model of the builds under `root`, merged with the sync results cached in `cache_dir`.
/// Parent POMs are looked up in `maven_repo` (the configured local repository), else the default one.
pub fn load(root: &Path, cache_dir: &Path, maven_repo: Option<PathBuf>) -> BuildModel {
    load_linked(
        root,
        cache_dir,
        maven_repo,
        &ide_core::settings::MavenSettings::default(),
        &ide_core::settings::GradleSettings::default(),
    )
}

/// Loads only linked Maven reactors, retaining an empty model so projects can be re-added.
pub fn load_linked(
    root: &Path,
    cache_dir: &Path,
    maven_repo: Option<PathBuf>,
    settings: &ide_core::settings::MavenSettings,
    gradle_settings: &ide_core::settings::GradleSettings,
) -> BuildModel {
    let maven = maven::has_projects(root, settings).then(|| {
        let profiles = settings.profiles(&sync::maven_profiles(cache_dir));
        let repo = maven_repo.or_else(maven::default_local_repo);
        let mut m = maven::load_with_linked(root, repo, &profiles, &settings.linked_projects);
        maven::UnlinkedProjects::from_model(&m, settings).filter(&mut m);
        // The user settings' profiles can be chosen too (`-P` applies to them as well).
        for p in maven::user_settings_file(root, settings).map(|f| maven::settings_profiles(&f)).unwrap_or_default() {
            if !m.profiles.iter().any(|x| x.id == p.id) {
                m.profiles.push(p);
            }
        }
        sync::apply_maven_cache(root, cache_dir, &mut m);
        m
    });
    let gradle = gradle::load_linked(root, gradle_settings)
        .into_iter()
        .map(|mut g| {
            sync::apply_gradle_cache(root, &gradle::cache_dir(cache_dir, &g.dir), &mut g);
            g
        })
        .collect();
    BuildModel { maven, gradle, sbt: sbt::load(root) }
}

/// Gradle project folders outside `root` as of the last sync (`includeFlat` siblings):
/// extra content roots, as IDEA lists module roots beside the project folder.
/// Reads only the sync's cached projects (no build script), so it is cheap enough for hot paths.
pub fn gradle_external_roots(
    root: &Path,
    cache_dir: &Path,
    settings: &ide_core::settings::GradleSettings,
) -> Vec<PathBuf> {
    let builds = gradle::linked_dirs(root, settings);
    let dirs: Vec<String> = builds
        .iter()
        .flat_map(|dir| {
            std::iter::once(root.join(dir).to_string_lossy().into_owned()).chain(
                sync::reported_gradle_projects(&gradle::cache_dir(cache_dir, dir))
                    .iter()
                    .map(|p| p.dir.clone())
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    gradle::external_roots(root, dirs.iter().map(String::as_str))
}

/// Directories outside `root`, outermost only, of Maven POMs linked from there and, in a
/// trusted project, of the modules its reactor lists there (`<module>../service-a</module>`):
/// extra content roots, as IDEA imports such modules with content roots of their own.
/// Linked POMs are read as explicit paths; the reactor's POMs are parsed, but not their
/// parents, and nothing walks directories. `cache_dir` holds the profiles chosen at the last sync.
pub fn maven_external_roots(
    root: &Path,
    cache_dir: &Path,
    settings: &ide_core::settings::MavenSettings,
    trusted: bool,
) -> Vec<PathBuf> {
    let mut dirs = maven::external_pom_dirs(root, &settings.linked_projects);
    if trusted {
        let profiles = settings.profiles(&sync::maven_profiles(cache_dir));
        dirs.extend(maven::reactor_external_dirs(root, &profiles, &settings.unlinked_projects));
    }
    let owned: Vec<String> = dirs.iter().map(|dir| dir.to_string_lossy().into_owned()).collect();
    gradle::external_roots(root, owned.iter().map(String::as_str))
}

/// Source, resource and build folders of the last Gradle sync, absolute.
pub fn gradle_source_roots(
    root: &Path,
    cache_dir: &Path,
    settings: &ide_core::settings::GradleSettings,
) -> Vec<(PathBuf, gradle::ReportedRoot)> {
    let reported = gradle::linked_dirs(root, settings)
        .iter()
        .flat_map(|dir| sync::reported_gradle_projects(&gradle::cache_dir(cache_dir, dir)).as_ref().clone())
        .collect::<Vec<_>>();
    gradle::reported_source_roots(&reported)
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
/// `pom` imports and `system` scope; dependencies declared in the Gradle build scripts,
/// including the scripts they pull in with `apply from`.
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
    for g in &model.gradle {
        for p in &g.projects {
            let Some(build_file) = p.build_file.as_deref() else { continue };
            let build_dir = gradle::project_build_dir(root, g, p);
            let scripts = gradle::scripts_of(root, &root.join(&p.dir), &build_dir, Path::new(build_file));
            // The script's own `ext` values win over the scripts it applies.
            let mut properties = std::collections::BTreeMap::new();
            for (_, text) in scripts.iter().rev() {
                properties.extend(gradle::script_properties(text));
            }
            properties.extend(gradle::file_properties(&build_dir));
            for (_, text) in &scripts {
                out.extend(gradle::script_dependencies(text, &properties).into_iter().map(
                    |(group_id, artifact_id, version)| DependencyCoordinate {
                        gradle: true,
                        group_id,
                        artifact_id,
                        version,
                    },
                ));
            }
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
    fn external_linked_build_is_indexed_before_sync_and_disappears_when_unlinked() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let external = temp.path().join("external");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&external).unwrap();
        std::fs::write(external.join("settings.gradle"), "").unwrap();
        let mut settings = ide_core::settings::GradleSettings {
            linked_projects: Some(vec![external.to_string_lossy().into_owned()]),
            ..Default::default()
        };
        assert_eq!(
            gradle_external_roots(&root, &temp.path().join("cache"), &settings),
            [dunce::canonicalize(&external).unwrap()]
        );
        settings.linked_projects = Some(vec![]);
        assert!(gradle_external_roots(&root, &temp.path().join("cache"), &settings).is_empty());
    }

    #[test]
    fn reactor_modules_outside_the_root_are_content_roots_of_a_trusted_project() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("workspace");
        let cache = base.join("cache");
        let write = |rel: &str, text: &str| {
            let path = base.join(rel).join("pom.xml");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, format!("<project><artifactId>{rel}</artifactId>{text}</project>")).unwrap();
        };
        let reactor = |modules: &str| {
            format!(
                "<packaging>pom</packaging><modules>{modules}</modules>\
                 <profiles><profile><id>extra</id><modules><module>../service-c</module></modules></profile></profiles>"
            )
        };
        let all = "<module>core</module><module>../service-a</module><module>..</module>";
        write("workspace", &reactor(all));
        write("workspace/core", "<modules><module>../../service-d</module></modules>");
        write("service-a", "<modules><module>impl</module><module>../service-e</module></modules>");
        for module in ["service-a/impl", "service-c", "service-d", "service-e", "unrelated"] {
            write(module, "");
        }
        // The folder holding the project is not a module beside it, nor are its other modules.
        write("", "<modules><module>workspace</module><module>unrelated</module></modules>");

        let mut settings = ide_core::settings::MavenSettings::default();
        let roots = |settings: &ide_core::settings::MavenSettings, trusted| {
            maven_external_roots(&root, &cache, settings, trusted)
        };
        let (a, c, d, e) =
            (base.join("service-a"), base.join("service-c"), base.join("service-d"), base.join("service-e"));
        assert_eq!(roots(&settings, true), [a.clone(), d.clone(), e.clone()]);
        assert!(roots(&settings, false).is_empty(), "Restricted Mode does not widen the index");

        settings.active_profiles = "extra".into();
        assert_eq!(roots(&settings, true), [a.clone(), c.clone(), d.clone(), e.clone()]);
        save_maven_profiles(&cache, &["!extra".into()]).unwrap();
        assert_eq!(roots(&settings, true), [a.clone(), d.clone(), e.clone()]);

        settings.unlinked_projects = vec![a.join("pom.xml").to_string_lossy().replace('\\', "/")];
        assert_eq!(roots(&settings, true), std::slice::from_ref(&d));
        settings.unlinked_projects.clear();

        write("workspace", &reactor("<module>core</module>"));
        assert_eq!(roots(&settings, true), std::slice::from_ref(&d));
        write("workspace/core", "");
        assert!(roots(&settings, true).is_empty());
        write("workspace", &reactor(all));
        assert_eq!(roots(&settings, true), [a, e]);
    }

    #[test]
    fn settings_profiles_and_checkbox_choices_control_modules_before_sync() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join("extra")).unwrap();
        std::fs::write(root.join("extra/pom.xml"), "<project><artifactId>extra</artifactId></project>").unwrap();
        std::fs::write(
            root.join("pom.xml"),
            r#"<project><artifactId>root</artifactId><packaging>pom</packaging>
            <profiles><profile><id>extra</id><modules><module>extra</module></modules></profile></profiles></project>"#,
        )
        .unwrap();
        let cache = root.join("cache");
        let settings = ide_core::settings::MavenSettings { active_profiles: "extra".into(), ..Default::default() };
        let modules = |settings: &ide_core::settings::MavenSettings| {
            load_linked(root, &cache, None, settings, &Default::default()).maven.unwrap().projects[0].modules.clone()
        };
        assert!(modules(&Default::default()).is_empty());
        assert_eq!(modules(&settings), ["extra/pom.xml"]);
        assert_eq!(maven::load_linked(root, &settings).projects[0].modules, ["extra/pom.xml"]);
        save_maven_profiles(&cache, &["!extra".into()]).unwrap();
        assert!(modules(&settings).is_empty());
    }

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
        assert_eq!(m.gradle[0].projects[0].path, ":");
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
        let gradle = gradle::load(root).into_iter().collect();
        let model = BuildModel { maven: Some(maven), gradle, sbt: Vec::new() };
        let names: Vec<String> = dependency_coordinates(root, &model)
            .into_iter()
            .map(|c| format!("{}{}:{}:{}", if c.gradle { "G " } else { "M " }, c.group_id, c.artifact_id, c.version))
            .collect();
        assert_eq!(names, ["M org.b:y:2", "M org.c:z:3", "G org.a:x:1.0"]);
    }

    #[test]
    fn dependency_coordinates_read_scripts_brought_in_by_apply_from() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("gradle")).unwrap();
        std::fs::write(root.join("build.gradle"), "apply from: 'gradle/dependencies.gradle'\n").unwrap();
        std::fs::write(
            root.join("gradle/dependencies.gradle"),
            "ext { gson = '2.8.9' }\ndependencies { implementation \"com.google.code.gson:gson:${gson}\" }\n",
        )
        .unwrap();
        let model = BuildModel { maven: None, gradle: gradle::load(root).into_iter().collect(), sbt: Vec::new() };
        let names: Vec<String> = dependency_coordinates(root, &model)
            .into_iter()
            .map(|c| format!("{}:{}:{}", c.group_id, c.artifact_id, c.version))
            .collect();
        assert_eq!(names, ["com.google.code.gson:gson:2.8.9"]);
    }

    #[test]
    fn gradle_properties_override_script_extra_values() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("build.gradle"), "ext.v = 'wrong'\napply from: 'deps.gradle'").unwrap();
        std::fs::write(
            root.join("deps.gradle"),
            "ext.v = 'alsoWrong'\nimplementation \"g:a:${v}\"\nimplementation \"g:b:${onlyInProperties}\"",
        )
        .unwrap();
        std::fs::write(root.join("gradle.properties"), "# versions\nv = 1.2\nonlyInProperties: 2.3\n").unwrap();
        let model = BuildModel { maven: None, gradle: gradle::load(root).into_iter().collect(), sbt: Vec::new() };
        let versions: Vec<_> = dependency_coordinates(root, &model).into_iter().map(|c| c.version).collect();
        assert_eq!(versions, ["1.2", "2.3"]);
    }
}
