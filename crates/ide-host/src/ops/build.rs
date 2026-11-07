//! Maven / Gradle tool windows (the build model and its background sync) and
//! Build › Build Project (compiling with the project's build system).
use crate::ops::Channel;
use crate::rpc::Dispatcher;
use crate::{Host, Project, apply_workspace_edit};

use ide_build::compile::{self, BuildEvent, BuildKind, BuildResult};
use ide_build::maven::PomGoto;
use ide_build::pom_edit::{ArtifactKey, Exclusion};
use ide_build::{BuildModel, BuildTool, SyncOptions, SyncProgress};
use ide_core::settings::Settings;
use ide_core::{FileEdit, IdeError, IdeEvent, IdeResult, Location, Pos, Range, RequestId, WorkspaceEdit};
use std::collections::BTreeMap;
use std::path::Path;

fn join_err(e: tokio::task::JoinError) -> IdeError {
    IdeError::internal(e.to_string())
}

/// The build model with the launch settings applied: the JDK (`JAVA_HOME`), and
/// the Maven home and options from Settings › Maven.
pub fn load(root: &Path, cache: &Path, settings: &Settings) -> BuildModel {
    let mut model = ide_build::load_linked(
        root,
        cache,
        ide_sdk::apply::maven_local_repository(root, settings),
        &settings.languages.java.maven,
        &settings.languages.java.gradle,
    );
    let jdk = ide_sdk::apply::project_jdk(root, settings);
    if let Some(m) = &mut model.maven {
        let mvn = ide_sdk::apply::maven_command(root, settings);
        let options = ide_sdk::apply::maven_options(root, settings);
        for p in &mut m.projects {
            p.env = ide_sdk::apply::maven_build_env(root, settings, p.java_version);
            if let Some(mvn) = &mvn {
                p.command = mvn.to_string_lossy().into_owned();
            }
            p.options = options.clone();
        }
    }
    for g in &mut model.gradle {
        g.command = ide_sdk::apply::gradle_command(root, &root.join(&g.dir), settings).to_string_lossy().into_owned();
        g.env = ide_sdk::apply::gradle_build_env(root, &root.join(&g.dir), &g.command, settings, g.java_version);
    }
    // A failed sync of a project no installed JDK can build says so first (with a Download JDK action).
    let missing = |release: Option<u32>| match jdk {
        Some(_) => None,
        None => ide_sdk::java::missing_jdk_message(&ide_sdk::java::installed_jdks(), release),
    };
    let explain = |error: &mut Option<String>, hint: Option<String>| {
        if let (Some(e), Some(hint)) = (error.as_mut(), hint) {
            *e = format!("{hint}\n{e}");
        }
    };
    if let Some(m) = &mut model.maven
        && m.sync_error.is_some()
    {
        let hint = if settings.languages.java.maven.runner_jre.trim().is_empty() {
            m.projects.iter().find_map(|p| missing(p.java_version))
        } else {
            None
        };
        explain(&mut m.sync_error, hint);
    }
    for g in &mut model.gradle {
        if g.sync_error.is_some() {
            let hint =
                if settings.languages.java.gradle.jvm.trim().is_empty() { missing(g.java_version) } else { None };
            explain(&mut g.sync_error, hint);
        }
    }
    model
}

/// Build and Run use the same selected toolchain and module-local runtime discovery.
fn prepare_plan(mut plan: compile::BuildPlan, root: &Path, settings: &Settings) -> compile::BuildPlan {
    let kind = match plan.system {
        compile::BuildSystem::Cargo => "cargo",
        compile::BuildSystem::Go => "go",
        compile::BuildSystem::TypeScript => "npm",
        _ => return plan,
    };
    for step in &mut plan.steps {
        let mut config = ide_run::RunConfig {
            id: String::new(),
            name: String::new(),
            kind: kind.into(),
            command: step.program.clone(),
            args: step.args.clone(),
            cwd: Some(step.cwd.clone().into()),
            env: step.env.clone(),
            detected: true,
            is_test: false,
            debug_adapter: None,
            allow_parallel: false,
            extras: Default::default(),
        };
        config.extras.module = Some(ide_core::ipc_path::to_ipc(&step.cwd));
        ide_sdk::apply::apply_to_run_configs(std::slice::from_mut(&mut config), root, settings);
        if kind == "go" {
            config.extras.params.insert("useTags".into(), "true".into());
            ide_sdk::go::apply_to_run(&mut config, &settings.languages.go.build_tags);
        }
        step.program = config.command;
        step.args = config.args;
        step.env = config.env;
    }
    plan
}

/// `model` building with the Maven profiles of the last sync (`-P`), as Maven runs from
/// the tool window do.
fn with_profiles(mut model: BuildModel, cache: &Path) -> BuildModel {
    let profiles = ide_build::maven_profiles(cache);
    if let (Some(m), false) = (&mut model.maven, profiles.is_empty()) {
        for p in &mut m.projects {
            p.options.push(format!("-P{}", profiles.join(",")));
        }
    }
    model
}

/// Maven and Gradle projects of the window's project, from the build files plus the last sync.
pub async fn build_model(host: &Host, window: &str) -> IdeResult<BuildModel> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    tokio::task::spawn_blocking(move || load(&root, &cache, &settings)).await.map_err(join_err)
}

fn linked_gradle_paths(
    root: &Path,
    settings: &ide_core::settings::GradleSettings,
    paths: &[String],
    link: bool,
) -> IdeResult<Vec<String>> {
    let existing = settings
        .linked_projects
        .clone()
        .unwrap_or_else(|| ide_build::gradle::load_linked(root, settings).into_iter().map(|g| g.dir).collect());
    let mut linked = Vec::new();
    for path in existing {
        let normalized = ide_build::gradle::normalize_linked_projects(root, std::slice::from_ref(&path))
            .unwrap_or_else(|_| vec![path]);
        for path in normalized {
            if !linked.contains(&path) {
                linked.push(path);
            }
        }
    }
    if link {
        let directories: Vec<String> = paths
            .iter()
            .map(|path| {
                let path = root.join(path);
                let is_script = path.file_name().and_then(|n| n.to_str()).is_some_and(|name| {
                    ide_build::gradle::SETTINGS_FILES.contains(&name) || ide_build::gradle::BUILD_FILES.contains(&name)
                });
                if is_script && path.is_file() {
                    path.parent().unwrap_or(root).to_string_lossy().into_owned()
                } else {
                    path.to_string_lossy().into_owned()
                }
            })
            .collect();
        for path in ide_build::gradle::normalize_linked_projects(root, &directories)? {
            if !linked.contains(&path) {
                linked.push(path);
            }
        }
    } else {
        let unlinked: Vec<String> = paths.iter().map(|p| ide_build::gradle::linked_project_key(root, p)).collect();
        linked.retain(|path| !paths.contains(path) && !unlinked.contains(path));
    }
    Ok(linked)
}

async fn set_gradle_projects(host: &Host, window: &str, paths: Vec<String>, link: bool) -> IdeResult<BuildModel> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        if ide_workspace::workspace::Workspace::load(&project.root)?.is_some() {
            return Err(IdeError::invalid("Open a workspace member as a project to link Gradle builds"));
        }
        let linked =
            linked_gradle_paths(&project.root, &project.settings.effective().languages.java.gradle, &paths, link)?;
        let key = "languages.java.gradle.linkedProjects";
        let settings =
            project.settings.set(ide_workspace::settings::SettingsScope::Project, key, serde_json::json!(linked))?;
        project.refresh_index_scope();
        project.lsp.reconfigure_soon();
        project.sink.emit(IdeEvent::SettingsChanged { key: key.into() });
        project.sink.emit(IdeEvent::ProjectRootsChanged { root: project.root.clone().into() });
        Ok::<BuildModel, IdeError>(load(&project.root, &project.build_cache_dir(), &settings))
    })
    .await
    .map_err(join_err)?
}

/// Links independent builds without changing their Gradle scripts.
pub async fn gradle_link_projects(host: &Host, window: &str, paths: Vec<String>) -> IdeResult<BuildModel> {
    set_gradle_projects(host, window, paths, true).await
}

/// Stops importing the selected independent builds; files and saved run configurations stay intact.
pub async fn gradle_unlink_projects(host: &Host, window: &str, paths: Vec<String>) -> IdeResult<BuildModel> {
    set_gradle_projects(host, window, paths, false).await
}

/// Runs Maven (`help:effective-pom dependency:tree`) or Gradle (`tasks --all`) in the
/// background, reporting progress on `on_progress`; cancellable with `cancel_request(request)`.
/// Returns the refreshed model; a failed build is reported in its `syncError`.
#[allow(clippy::too_many_arguments)]
pub async fn build_sync(
    host: &Host,
    window: &str,
    tool: BuildTool,
    request: RequestId,
    offline: bool,
    profiles: Vec<String>,
    build_dir: Option<String>,
    on_progress: Channel<SyncProgress>,
) -> IdeResult<BuildModel> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    let bridge_profiles = profiles.clone();
    // What the Java language server and Build Project resolve the project with from now on.
    let profiles_changed = tool == BuildTool::Maven
        && ide_build::save_maven_profiles(&cache, &profiles).unwrap_or_else(|e| {
            tracing::warn!("Maven profiles not saved: {e}");
            false
        });
    if profiles_changed {
        // The modules of the chosen profiles are read from the POMs with them from now on (the
        // project tree's module folders too), whether or not Maven itself can run.
        project.sink.emit(ide_core::IdeEvent::ProjectRootsChanged { root: project.root.clone().into() });
    }
    let token = host.begin_project_request(window, request);
    let completion_token = token.clone();
    let original_links = settings.languages.java.gradle.linked_projects.clone();
    let result = tokio::task::spawn_blocking(move || {
        let current = load(&root, &cache, &settings);
        let env = match tool {
            BuildTool::Maven => current
                .maven
                .as_ref()
                .and_then(|m| m.projects.iter().find(|p| !p.env.is_empty()))
                .map(|p| p.env.clone())
                .unwrap_or_default(),
            BuildTool::Gradle => BTreeMap::new(),
        };
        let options = SyncOptions {
            offline,
            profiles,
            env,
            maven_command: ide_sdk::apply::maven_command(&root, &settings).map(|p| p.to_string_lossy().into_owned()),
            maven_options: ide_sdk::apply::maven_options(&root, &settings),
            maven_settings: settings.languages.java.maven.clone(),
            gradle_command: None,
        };
        let progress = |p: SyncProgress| {
            let _ = on_progress.send(p);
        };
        match tool {
            BuildTool::Maven => ide_build::sync_maven(&root, &cache, &options, &token, &progress)?,
            BuildTool::Gradle => {
                if let Some(dir) = &build_dir
                    && !current.gradle.iter().any(|g| &g.dir == dir)
                {
                    return Err(IdeError::not_found("Gradle project is no longer linked"));
                }
                for g in current.gradle.iter().filter(|g| build_dir.as_ref().is_none_or(|dir| dir == &g.dir)) {
                    if token.is_cancelled() {
                        return Err(IdeError::cancelled());
                    }
                    let options =
                        SyncOptions { env: g.env.clone(), gradle_command: Some(g.command.clone()), ..options.clone() };
                    ide_build::sync_gradle_model(&root, &cache, g, &options, &token, &progress)?;
                }
                if token.is_cancelled() {
                    return Err(IdeError::cancelled());
                }
            }
        }
        Ok::<BuildModel, IdeError>(load(&root, &cache, &settings))
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    let model = result??;
    if completion_token.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    if tool == BuildTool::Gradle && original_links != project.settings.effective().languages.java.gradle.linked_projects
    {
        // A late sync must not re-import a build that was unlinked while it ran.
        return tokio::task::spawn_blocking(move || {
            load(&project.root, &project.build_cache_dir(), &project.settings.effective())
        })
        .await
        .map_err(join_err);
    }
    if tool == BuildTool::Gradle {
        // The sync may report project folders outside the project (`includeFlat`): index and list them.
        project.refresh_index_scope();
        project.sink.emit(ide_core::IdeEvent::ProjectRootsChanged { root: project.root.clone().into() });
        let p = project.clone();
        tokio::task::spawn_blocking(move || p.refresh_repositories());
    }
    if tool == BuildTool::Maven
        && model.maven.is_some()
        && let Some(bridge) = &project.kotlin_bridge
    {
        bridge.configure_maven(offline, bridge_profiles);
    }
    // jdtls re-imports on pom changes but misses artifacts added to ~/.m2
    // meanwhile ("missing artifact" stays until Invalidate Caches); asking it
    // to update the project configurations re-resolves them (#436). The same
    // holds for Gradle: it reuses its cached classpath on restart, so a
    // dependency added to `build.gradle` stays unresolved until told to sync.
    let build_files: Vec<String> = match tool {
        BuildTool::Maven => model.maven.iter().flat_map(|m| m.projects.iter().map(|p| p.pom.clone())).collect(),
        BuildTool::Gradle => {
            model.gradle.iter().flat_map(|g| g.projects.iter().filter_map(|p| p.build_file.clone())).collect()
        }
    };
    let lsp = project.lsp.clone();
    // With a module of a reactor unlinked, jdtls imports the other modules one by one and
    // not the reactor: naming the reactor here would import it again, all modules included.
    let imported = match tool {
        BuildTool::Maven => crate::project::jdtls_maven_import(&project.root, &project.settings.effective()).1,
        BuildTool::Gradle => None,
    };
    let uris = match imported {
        Some(files) => files.into_iter().filter(|f| f.ends_with("/pom.xml")).collect(),
        None => build_files.iter().map(|f| ide_lsp::path_to_uri_string(&project.root.join(f))).collect(),
    };
    tokio::spawn(async move {
        if profiles_changed {
            // jdtls takes the profiles from its Maven settings (see `ide_sdk::maven_profiles`).
            lsp.reconfigure().await;
        }
        if let Err(e) = lsp.java_update_project_configs(&project.root, uris).await {
            tracing::debug!("java/projectConfigurationsUpdate: {e}");
        }
    });
    Ok(model)
}

/// The POM declaring `dependency` for the Maven module `pom` (project-relative): the
/// module's own, else its nearest parent in the project; its path, text and declaration.
fn declaring_pom(
    project: &Project,
    pom: &str,
    dependency: &ArtifactKey,
) -> IdeResult<(std::path::PathBuf, String, Range)> {
    let model = ide_build::maven::load(&project.root);
    for rel in ide_build::pom_edit::declaring_poms(&model, pom) {
        let path = project.root.join(&rel);
        let text = project.text_of(&path)?;
        if let Some(range) = ide_build::pom_edit::declaration(&text, dependency) {
            return Ok((path, text, range));
        }
    }
    Err(IdeError::not_found(format!(
        "{dependency} is not declared in a pom.xml of this project (it may come from an imported BOM or an external parent POM)"
    )))
}

/// The `.toml` of a version catalog the build imports as `group:artifact:version`, once a
/// build has downloaded it (`ide_sdk::libraries::published_version_catalog`).
pub async fn gradle_published_catalog(
    host: &Host,
    window: &str,
    coordinates: String,
) -> IdeResult<Option<ide_core::IpcPath>> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        ide_sdk::libraries::published_version_catalog(&project.root, &project.settings.effective(), &coordinates)
            .map(Into::into)
    })
    .await
    .map_err(join_err)
}

/// The resolved dependency tree of the Gradle project `gradle_path` (`:`, `:app`) for
/// `configuration`, from Gradle's `dependencies` report; cancellable with `cancel_request(request)`.
pub async fn gradle_dependencies(
    host: &Host,
    window: &str,
    gradle_path: String,
    configuration: String,
    offline: bool,
    request: RequestId,
    build_dir: Option<String>,
) -> IdeResult<Vec<ide_build::GradleDependency>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    let token = host.begin_project_request(window, request);
    let result = tokio::task::spawn_blocking(move || {
        let model = load(&root, &cache, &settings);
        let gradle = model
            .gradle
            .iter()
            .find(|g| build_dir.as_ref().is_none_or(|dir| &g.dir == dir))
            .ok_or_else(|| IdeError::not_found("Gradle project is no longer linked"))?;
        let options = SyncOptions {
            offline,
            env: gradle.env.clone(),
            gradle_command: Some(gradle.command.clone()),
            ..Default::default()
        };
        ide_build::gradle_dependencies(&root, gradle, &options, &gradle_path, &configuration, &token)
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result?
}

/// Where the direct dependency `dependency` of the Maven module `pom` is declared.
pub async fn maven_dependency_declaration(
    host: &Host,
    window: &str,
    pom: String,
    dependency: ArtifactKey,
) -> IdeResult<Location> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let (path, _, range) = declaring_pom(&project, &pom, &dependency)?;
        Ok(Location::file(path, range))
    })
    .await
    .map_err(join_err)?
}

/// The go-to-declaration target at `pos` of the Maven POM `pom` (project-relative, or
/// absolute for a parent POM opened from the local repository): the definition of the
/// `${property}` at the caret, or the `<dependencyManagement>` / `<pluginManagement>`
/// entry providing the dependency's / plugin's version, along the parent chain (into
/// the local repository when a parent is not in the project). `None` when nothing
/// resolvable is under the caret.
pub async fn maven_goto_declaration(host: &Host, window: &str, pom: String, pos: Pos) -> IdeResult<Option<PomGoto>> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let given = Path::new(&pom);
        let path = if given.is_absolute() { given.to_path_buf() } else { project.root.join(given) };
        let text = project.text_of(&path)?;
        let settings = project.settings.effective();
        let repo = ide_sdk::apply::maven_local_repository(&project.root, &settings)
            .or_else(ide_build::maven::default_local_repo);
        Ok(ide_build::maven::goto_declaration(&text, &path, pos, repo))
    })
    .await
    .map_err(join_err)?
}

/// Adds an `<exclusion>` of `exclusion` to the declaration of the direct dependency
/// `dependency` of the Maven module `pom`, through the open document when there is one
/// (saved). Returns the declaration; nothing changes when it already excludes it.
pub async fn maven_exclude_dependency(
    host: &Host,
    window: &str,
    pom: String,
    dependency: ArtifactKey,
    exclusion: ArtifactKey,
) -> IdeResult<Location> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let (path, text, range) = declaring_pom(&project, &pom, &dependency)?;
        match ide_build::pom_edit::add_exclusion(&text, &dependency, &exclusion) {
            Some(Exclusion::Edit(edit)) => {
                let edit = WorkspaceEdit {
                    files: vec![FileEdit::Edit { path: path.clone().into(), edits: vec![edit], version: None }],
                    ..Default::default()
                };
                apply_workspace_edit(&project.documents, &edit)?;
            }
            Some(Exclusion::Present) => {}
            None => return Err(IdeError::not_found(format!("{dependency} is not declared in {}", path.display()))),
        }
        Ok(Location::file(path, range))
    })
    .await
    .map_err(join_err)?
}

/// Build › Build Project / Rebuild Project / Build Module (`file`: a file or folder of the
/// module) / Build Artifacts, streaming the console and messages on `on_event`; cancellable
/// with `cancel_request(request)`. Diagnostics of `clear` (the files of the previous build)
/// are cleared first; the new messages are published as `build` diagnostics.
pub async fn build_run(
    host: &Host,
    window: &str,
    kind: BuildKind,
    file: Option<std::path::PathBuf>,
    request: RequestId,
    clear: Vec<std::path::PathBuf>,
    on_event: Channel<BuildEvent>,
) -> IdeResult<BuildResult> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (root, cache, sink) = (project.root.clone(), project.build_cache_dir(), project.sink.clone());
    let settings = project.settings.effective();
    let config_dir = host.config_dir.clone();
    let token = host.begin_project_request(window, request);
    let result = tokio::task::spawn_blocking(move || {
        for path in clear {
            sink.emit(IdeEvent::Diagnostics {
                path: path.into(),
                source: compile::DIAGNOSTICS_SOURCE.into(),
                items: Vec::new(),
            });
        }
        let plan = if let Some(workspace) = ide_workspace::workspace::Workspace::load(&root)? {
            let mut combined: Option<compile::BuildPlan> = None;
            for member in workspace.projects.iter().filter(|p| file.as_ref().is_none_or(|f| f.starts_with(p))) {
                let settings = ide_workspace::SettingsStore::load(&config_dir, Some(member)).effective();
                let member_cache = cache.join(crate::project::project_key(member));
                let model = with_profiles(load(member, &member_cache, &settings), &member_cache);
                let plan = prepare_plan(
                    compile::plan(member, &model, kind, file.as_deref(), settings.cmake.profiles.as_deref())?,
                    member,
                    &settings,
                );
                match &mut combined {
                    Some(combined) => combined.steps.extend(plan.steps),
                    None => combined = Some(plan),
                }
            }
            let mut plan = combined.ok_or_else(|| IdeError::invalid("No workspace project to build"))?;
            plan.title = workspace.name;
            plan
        } else {
            prepare_plan(
                compile::plan(
                    &root,
                    &with_profiles(load(&root, &cache, &settings), &cache),
                    kind,
                    file.as_deref(),
                    settings.cmake.profiles.as_deref(),
                )?,
                &root,
                &settings,
            )
        };
        let result = compile::run(&root, &plan, &token, &|e| {
            let _ = on_event.send(e);
        })?;
        for (path, items) in compile::diagnostics(&result.messages) {
            sink.emit(IdeEvent::Diagnostics { path: path.into(), source: compile::DIAGNOSTICS_SOURCE.into(), items });
        }
        Ok(result)
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result?
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("build_model", |c| async move { build_model(&c.host, &c.window).await });
    d.add("gradle_link_projects", |c| async move { gradle_link_projects(&c.host, &c.window, c.arg("paths")?).await });
    d.add(
        "gradle_unlink_projects",
        |c| async move { gradle_unlink_projects(&c.host, &c.window, c.arg("paths")?).await },
    );
    d.add("build_sync", |c| async move {
        build_sync(
            &c.host,
            &c.window,
            c.arg("tool")?,
            c.arg("request")?,
            c.arg("offline")?,
            c.arg("profiles")?,
            c.arg("buildDir")?,
            c.sender("onProgress")?,
        )
        .await
    });
    d.add("gradle_published_catalog", |c| async move {
        gradle_published_catalog(&c.host, &c.window, c.arg("coordinates")?).await
    });
    d.add("gradle_dependencies", |c| async move {
        gradle_dependencies(
            &c.host,
            &c.window,
            c.arg("gradlePath")?,
            c.arg("configuration")?,
            c.arg("offline")?,
            c.arg("request")?,
            c.arg("buildDir")?,
        )
        .await
    });
    d.add("maven_dependency_declaration", |c| async move {
        maven_dependency_declaration(&c.host, &c.window, c.arg("pom")?, c.arg("dependency")?).await
    });
    d.add("maven_goto_declaration", |c| async move {
        maven_goto_declaration(&c.host, &c.window, c.arg("pom")?, c.arg("pos")?).await
    });
    d.add("maven_exclude_dependency", |c| async move {
        maven_exclude_dependency(&c.host, &c.window, c.arg("pom")?, c.arg("dependency")?, c.arg("exclusion")?).await
    });
    d.add("build_run", |c| async move {
        build_run(
            &c.host,
            &c.window,
            c.arg("kind")?,
            c.arg("file")?,
            c.arg("request")?,
            c.arg("clear")?,
            c.sender("onEvent")?,
        )
        .await
    });
}

#[cfg(test)]
mod build_tool_settings_tests {
    use super::*;

    #[test]
    fn builds_apply_the_same_explicit_toolchains_as_runs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let tool = |name: &str| format!("{name}{}", std::env::consts::EXE_SUFFIX);
        for name in ["cargo", "go"] {
            let path = root.join("sdk").join("bin").join(tool(name));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
        let mut settings = Settings::default();
        settings.languages.rust.toolchain = "sdk".into();
        settings.languages.go.goroot = "sdk".into();
        settings.languages.go.build_tags.custom = "integration".into();
        settings.languages.node.package_manager = "yarn".into();
        for (marker, source, program) in [
            (
                "Cargo.toml",
                "[package]\nname='demo'\nversion='0.1.0'",
                root.join("sdk").join("bin").join(tool("cargo")).to_string_lossy().into_owned(),
            ),
            ("go.mod", "module demo", root.join("sdk").join("bin").join(tool("go")).to_string_lossy().into_owned()),
            ("package.json", r#"{"scripts":{"build":"echo built"},"packageManager":"pnpm@10"}"#, "yarn".into()),
        ] {
            let dir = root.join(marker.replace('.', "-"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(marker), source).unwrap();
            let plan = prepare_plan(
                compile::plan(&dir, &Default::default(), BuildKind::Artifacts, None, None).unwrap(),
                root,
                &settings,
            );
            assert_eq!(plan.steps[0].program, program);
            assert_eq!(plan.steps[0].cwd, dir);
            if marker == "go.mod" {
                assert!(plan.steps[0].args.contains(&"-tags=integration".into()));
            }
        }
    }

    #[test]
    fn linking_retains_the_implicit_build_and_unlinking_all_stays_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        for name in ["a", "b"] {
            std::fs::create_dir(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("settings.gradle"), format!("rootProject.name = '{name}'")).unwrap();
        }
        let mut settings = ide_core::settings::GradleSettings::default();
        let linked = linked_gradle_paths(&root, &settings, &["b/settings.gradle".into()], true).unwrap();
        assert_eq!(linked, ["a", "b"]);
        settings.linked_projects = Some(linked);
        assert_eq!(linked_gradle_paths(&root, &settings, &["b".into()], true).unwrap(), ["a", "b"]);
        assert!(linked_gradle_paths(&root, &settings, &["missing".into()], true).is_err());
        settings.linked_projects = Some(vec!["./a".into(), root.join("b").to_string_lossy().into_owned()]);
        settings.linked_projects = Some(linked_gradle_paths(&root, &settings, &["a".into()], false).unwrap());
        assert_eq!(settings.linked_projects.as_ref().unwrap(), &["b"]);
        settings.linked_projects = Some(linked_gradle_paths(&root, &settings, &["b".into()], false).unwrap());
        assert!(ide_build::gradle::load_linked(&root, &settings).is_empty());
        assert!(root.join("a/settings.gradle").is_file());
        assert!(root.join("b/settings.gradle").is_file());
    }

    #[test]
    fn settings_resolve_each_linked_builds_own_wrapper() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let mut settings = Settings::default();
        settings.languages.java.gradle.linked_projects = Some(vec!["a".into(), "b".into()]);
        let executable = if cfg!(windows) { "gradlew.bat" } else { "gradlew" };
        for dir in ["a", "b"] {
            std::fs::create_dir(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("build.gradle"), "plugins { id 'java' }").unwrap();
            std::fs::write(root.join(dir).join(executable), "").unwrap();
        }
        let model = load(&root, &root.join("cache"), &settings);
        assert_eq!(model.gradle.len(), 2);
        for g in model.gradle {
            assert_eq!(g.command, root.join(&g.dir).join(executable).to_string_lossy());
        }
    }

    #[test]
    fn model_for_maven_sync_goals_and_compile_uses_runner_jre() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::write(root.join("pom.xml"),
            r#"<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>app</artifactId><version>1</version></project>"#
        ).unwrap();
        for name in ["project-jdk", "runner-jdk"] {
            let home = root.join(name);
            std::fs::create_dir_all(home.join("bin")).unwrap();
            std::fs::write(home.join("bin").join(if cfg!(windows) { "java.exe" } else { "java" }), "").unwrap();
            std::fs::write(home.join("release"), "JAVA_VERSION=\"21\"\n").unwrap();
        }
        let mut settings = Settings::default();
        settings.languages.java.jdk = "project-jdk".into();
        for runner in ["", "runner-jdk"] {
            settings.languages.java.maven.runner_jre = runner.into();
            let expected = root.join(if runner.is_empty() { "project-jdk" } else { runner });
            let model = load(&root, &root.join("cache"), &settings);
            assert_eq!(model.maven.as_ref().unwrap().projects[0].env["JAVA_HOME"], expected.to_string_lossy());
            let plan = compile::plan(&root, &model, BuildKind::Build, None, None).unwrap();
            assert!(!plan.steps.is_empty());
            for step in plan.steps {
                assert_eq!(step.env["JAVA_HOME"], expected.to_string_lossy());
            }
        }
    }

    #[test]
    fn model_for_sync_tasks_and_compile_uses_gradle_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("build.gradle"), "plugins { id 'java' }").unwrap();
        let wrapper = root.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" });
        std::fs::write(&wrapper, "").unwrap();
        let mut settings = Settings::default();
        let default = load(root, &root.join("cache"), &settings).gradle.remove(0);
        assert_eq!(default.command, wrapper.to_string_lossy());
        settings.languages.java.gradle.jvm = "jdk21".into();
        settings.languages.java.gradle.user_home = "user-home".into();
        settings.languages.java.gradle.distribution = ide_core::settings::GradleDistribution::Local;
        settings.languages.java.gradle.home = "gradle-install".into();
        let model = load(root, &root.join("cache"), &settings).gradle.remove(0);
        assert_eq!(
            model.command,
            root.join("gradle-install")
                .join("bin")
                .join(if cfg!(windows) { "gradle.bat" } else { "gradle" })
                .to_string_lossy()
        );
        assert_eq!(model.env["JAVA_HOME"], root.join("jdk21").to_string_lossy());
        assert_eq!(model.env["GRADLE_USER_HOME"], root.join("user-home").to_string_lossy());
    }
}
