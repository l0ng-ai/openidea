use super::*;
use std::path::PathBuf;

pub(super) struct Scope {
    pub root: PathBuf,
    pub cache: PathBuf,
    pub settings: Settings,
}

pub(super) fn scopes(project: &Project, config: &Path) -> IdeResult<Vec<Scope>> {
    scopes_at(&project.root, &project.build_cache_dir(), config, project.settings.effective())
}

fn scopes_at(root: &Path, cache: &Path, config: &Path, settings: Settings) -> IdeResult<Vec<Scope>> {
    Ok(match ide_workspace::workspace::Workspace::load(root)? {
        Some(workspace) => workspace
            .projects
            .into_iter()
            .filter(|p| p.is_dir())
            .map(|root| Scope {
                cache: cache.join(crate::project::project_key(&root)),
                settings: ide_workspace::SettingsStore::load(config, Some(&root)).effective(),
                root,
            })
            .collect(),
        None => vec![Scope { root: root.to_owned(), cache: cache.to_owned(), settings }],
    })
}

fn absolute(root: &Path, path: &str) -> String {
    let path = if path.is_empty() { root.to_owned() } else { root.join(path) };
    ide_core::ipc_path::to_ipc(&path)
}

pub(super) fn load_scopes(root: &Path, scopes: &[Scope]) -> BuildModel {
    let mut combined = BuildModel::default();
    for scope in scopes {
        let mut model = load(&scope.root, &scope.cache, &scope.settings);
        if scope.root == root {
            return model;
        }
        if let Some(maven) = &mut model.maven {
            let owner = ide_core::ipc_path::to_ipc(&scope.root);
            for p in &mut maven.projects {
                p.project_root = Some(owner.clone());
                p.pom = absolute(&scope.root, &p.pom);
                p.dir = absolute(&scope.root, &p.dir);
                for module in &mut p.modules {
                    *module = absolute(&scope.root, module);
                }
            }
            for profile in &mut maven.profiles {
                profile.project_root = Some(owner.clone());
            }
        }
        if let Some(maven) = model.maven {
            match &mut combined.maven {
                None => combined.maven = Some(maven),
                Some(all) => {
                    all.projects.extend(maven.projects);
                    all.profiles.extend(maven.profiles);
                    all.synced_at = match (all.synced_at, maven.synced_at) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        _ => None,
                    };
                    all.stale |= maven.stale;
                    if let Some(error) = maven.sync_error {
                        all.sync_error = Some(match all.sync_error.take() {
                            Some(previous) => format!("{previous}\n{error}"),
                            None => error,
                        });
                    }
                }
            }
        }
        for g in &mut model.gradle {
            g.dir = absolute(&scope.root, &g.dir);
            for p in &mut g.projects {
                p.dir = absolute(&scope.root, &p.dir);
                p.build_file = p.build_file.as_ref().map(|f| absolute(&scope.root, f));
            }
        }
        combined.gradle.extend(model.gradle);
    }
    combined
}

pub(super) fn load_project(project: &Project, config: &Path) -> IdeResult<BuildModel> {
    Ok(load_scopes(&project.root, &scopes(project, config)?))
}

pub(super) fn selected(scope: &Scope, window_root: &Path, tool: BuildTool, dir: Option<&str>) -> bool {
    let Some(dir) = dir else { return true };
    match tool {
        BuildTool::Maven => scope.root == Path::new(dir),
        BuildTool::Gradle => load(&scope.root, &scope.cache, &scope.settings)
            .gradle
            .iter()
            .any(|g| window_root.join(dir) == scope.root.join(&g.dir)),
    }
}

/// Build files select their member's language server, including independent nested builds.
pub(super) fn update_files(root: &Path, scopes: &[Scope], model: &BuildModel, tool: BuildTool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    match tool {
        BuildTool::Maven => {
            for scope in scopes {
                // A reactor with unlinked modules must not be imported as a whole again.
                let imported = crate::project::jdtls_maven_import(&scope.root, &scope.settings).1;
                let paths: Vec<_> = match imported {
                    Some(uris) => uris
                        .iter()
                        .filter_map(|u| ide_lsp::uri_to_path(u))
                        .filter(|p| p.file_name().is_some_and(|n| n == "pom.xml"))
                        .collect(),
                    None => model
                        .maven
                        .iter()
                        .flat_map(|m| &m.projects)
                        .filter(|p| p.project_root.as_ref().is_none_or(|owner| Path::new(owner) == scope.root))
                        .map(|p| root.join(&p.pom))
                        .collect(),
                };
                for path in paths {
                    if !files.contains(&path) {
                        files.push(path);
                    }
                }
            }
        }
        BuildTool::Gradle => {
            for file in model.gradle.iter().flat_map(|g| &g.projects).filter_map(|p| p.build_file.as_ref()) {
                let path = root.join(file);
                if !files.contains(&path) {
                    files.push(path);
                }
            }
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_models_use_member_settings_paths_and_caches() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let workspace = base.join("workspace");
        let config = base.join("config");
        let cache = base.join("cache");
        let members: Vec<_> = ["first", "second"].into_iter().map(|name| base.join(name)).collect();
        for member in &members {
            std::fs::create_dir_all(member.join("extra")).unwrap();
            std::fs::write(
                member.join("pom.xml"),
                r#"<project><artifactId>app</artifactId>
              <profiles><profile><id>extra</id><modules><module>extra</module></modules></profile></profiles>
            </project>"#,
            )
            .unwrap();
            std::fs::write(member.join("extra/pom.xml"), "<project><artifactId>extra</artifactId></project>").unwrap();
            std::fs::write(member.join("settings.gradle"), "rootProject.name = 'app'").unwrap();
            std::fs::write(member.join("build.gradle"), "").unwrap();
        }
        ide_workspace::workspace::Workspace::save(&workspace, "Workspace", members.clone(), true).unwrap();
        let first_cache = cache.join(crate::project::project_key(&members[0]));
        ide_build::save_maven_profiles(&first_cache, &["extra".into()]).unwrap();
        let settings = ide_workspace::SettingsStore::load(&config, Some(&members[1]));
        settings
            .set(
                ide_workspace::settings::SettingsScope::Project,
                "languages.java.gradle.linkedProjects",
                serde_json::json!([]),
            )
            .unwrap();
        let scopes = scopes_at(&workspace, &cache, &config, Settings::default()).unwrap();
        assert_eq!(scopes[0].cache, first_cache);
        let model = load_scopes(&workspace, &scopes);
        let maven = model.maven.as_ref().unwrap();
        assert_eq!(maven.projects.len(), 3);
        assert_eq!(maven.projects[0].modules, [absolute(&members[0], "extra/pom.xml")]);
        assert!(maven.projects.iter().all(|p| Path::new(&p.pom).is_absolute() && Path::new(&p.dir).is_absolute()));
        assert_eq!(maven.profiles.len(), 2);
        assert_ne!(maven.profiles[0].project_root, maven.profiles[1].project_root);
        let updates = update_files(&workspace, &scopes, &model, BuildTool::Maven);
        assert_eq!(updates.len(), 3);
        assert!(updates.iter().all(|p| members.iter().any(|root| p.starts_with(root))));
        assert_eq!(update_files(&workspace, &scopes, &model, BuildTool::Gradle), [members[0].join("build.gradle")]);
        assert_eq!(model.gradle.len(), 1);
        assert_eq!(model.gradle[0].dir, absolute(&members[0], ""));
        assert!(selected(&scopes[0], &workspace, BuildTool::Maven, Some(&absolute(&members[0], ""))));
        assert!(!selected(&scopes[1], &workspace, BuildTool::Maven, Some(&absolute(&members[0], ""))));
        assert!(selected(&scopes[0], &workspace, BuildTool::Gradle, Some(&model.gradle[0].dir)));
        assert!(!selected(&scopes[1], &workspace, BuildTool::Gradle, Some(&model.gradle[0].dir)));
        assert_eq!(ide_build::maven_profiles(&scopes[1].cache), Vec::<String>::new());
        let standalone = scopes_at(&members[0], &cache, &config, Settings::default()).unwrap();
        assert_eq!(load_scopes(&members[0], &standalone), load(&members[0], &cache, &Settings::default()));
        ide_workspace::workspace::Workspace::save(&workspace, "Workspace", vec![members[1].clone()], false).unwrap();
        let scopes = scopes_at(&workspace, &cache, &config, Settings::default()).unwrap();
        let model = load_scopes(&workspace, &scopes);
        assert_eq!(model.maven.unwrap().projects.len(), 1);
        assert!(model.gradle.is_empty());
        std::fs::remove_dir_all(&members[1]).unwrap();
        let scopes = scopes_at(&workspace, &cache, &config, Settings::default()).unwrap();
        assert_eq!(load_scopes(&workspace, &scopes), BuildModel::default());
    }

    #[test]
    fn reload_keeps_unlinked_modules_out_of_member_language_servers() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        for name in ["enabled", "hidden"] {
            std::fs::create_dir(root.join(name)).unwrap();
            std::fs::write(
                root.join(name).join("pom.xml"),
                format!("<project><artifactId>{name}</artifactId></project>"),
            )
            .unwrap();
        }
        std::fs::write(root.join("pom.xml"), "<project><artifactId>parent</artifactId><packaging>pom</packaging><modules><module>enabled</module><module>hidden</module></modules></project>").unwrap();
        let mut settings = Settings::default();
        settings.languages.java.maven.unlinked_projects = vec!["hidden/pom.xml".into()];
        let scope = Scope { root: root.clone(), cache: root.join("cache"), settings };
        let model = load(&scope.root, &scope.cache, &scope.settings);
        assert_eq!(update_files(&root, &[scope], &model, BuildTool::Maven), [root.join("enabled/pom.xml")]);
    }
}
