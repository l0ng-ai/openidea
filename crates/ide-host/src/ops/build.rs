//! Maven / Gradle tool windows (the build model and its background sync) and
//! Build › Build Project (compiling with the project's build system).
mod workspace;

use super::dependencies::{MavenCentralArtifacts, MavenCentralGroups, MavenCentralVersions};
use crate::ops::Channel;
use crate::rpc::Dispatcher;
use crate::{Host, Project, apply_workspace_edit};

use ide_build::compile::{self, BuildEvent, BuildKind, BuildResult};
use ide_build::maven::PomGoto;
use ide_build::maven::completion::{PomCompletion, PomCompletionOption};
use ide_build::pom_edit::{ArtifactKey, Exclusion};
use ide_build::{BuildModel, BuildTool, SyncOptions, SyncProgress};
use ide_core::settings::Settings;
use ide_core::{DocId, FileEdit, IdeError, IdeEvent, IdeResult, Location, Pos, Range, RequestId, WorkspaceEdit};
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
    let config = host.config_dir.clone();
    tokio::task::spawn_blocking(move || workspace::load_project(&project, &config)).await.map_err(join_err)?
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
    let token = host.begin_project_request(window, request);
    let completion_token = token.clone();
    let bridge_profiles = profiles.clone();
    let p = project.clone();
    let config = host.config_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        let scopes = workspace::scopes(&p, &config)?;
        let selected: Vec<_> =
            scopes.iter().filter(|scope| workspace::selected(scope, &p.root, tool, build_dir.as_deref())).collect();
        if selected.is_empty() {
            return Err(IdeError::not_found("Build project is no longer linked"));
        }
        let mut profiles_changed = false;
        for scope in selected {
            if token.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let (root, cache, settings) = (&scope.root, &scope.cache, &scope.settings);
            let current = load(root, cache, settings);
            if tool == BuildTool::Maven && current.maven.is_some() {
                let changed = ide_build::save_maven_profiles(cache, &profiles).unwrap_or_else(|e| {
                    tracing::warn!("Maven profiles not saved: {e}");
                    false
                });
                if changed {
                    p.sink.emit(IdeEvent::ProjectRootsChanged { root: p.root.clone().into() });
                }
                profiles_changed |= changed;
            }
            let env = current
                .maven
                .as_ref()
                .and_then(|m| m.projects.iter().find(|p| !p.env.is_empty()))
                .map(|p| p.env.clone())
                .unwrap_or_default();
            let options = SyncOptions {
                offline,
                profiles: profiles.clone(),
                env,
                maven_command: ide_sdk::apply::maven_command(root, settings).map(|p| p.to_string_lossy().into_owned()),
                maven_options: ide_sdk::apply::maven_options(root, settings),
                maven_settings: settings.languages.java.maven.clone(),
                gradle_command: None,
            };
            let progress = |p: SyncProgress| {
                let _ = on_progress.send(p);
            };
            match tool {
                BuildTool::Maven if current.maven.is_some() => {
                    ide_build::sync_maven(root, cache, &options, &token, &progress)?
                }
                BuildTool::Maven => {}
                BuildTool::Gradle => {
                    for g in current
                        .gradle
                        .iter()
                        .filter(|g| build_dir.as_ref().is_none_or(|dir| p.root.join(dir) == root.join(&g.dir)))
                    {
                        if token.is_cancelled() {
                            return Err(IdeError::cancelled());
                        }
                        let options = SyncOptions {
                            env: g.env.clone(),
                            gradle_command: Some(g.command.clone()),
                            ..options.clone()
                        };
                        ide_build::sync_gradle_model(root, cache, g, &options, &token, &progress)?;
                    }
                }
            }
        }
        let scopes = workspace::scopes(&p, &config)?;
        let model = workspace::load_scopes(&p.root, &scopes);
        let updates = workspace::update_files(&p.root, &scopes, &model, tool);
        Ok::<_, IdeError>((model, profiles_changed, updates))
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    let (model, profiles_changed, updates) = result??;
    if completion_token.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    if tool == BuildTool::Gradle {
        // The sync may report project folders outside the project (`includeFlat`): index and list them.
        project.refresh_index_scope();
        let p = project.clone();
        tokio::task::spawn_blocking(move || p.refresh_repositories());
    }
    // New source folders and dependency versions: the Project view and External Libraries reload.
    project.sink.emit(ide_core::IdeEvent::ProjectRootsChanged { root: project.root.clone().into() });
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
    let lsp = project.lsp.clone();
    tokio::spawn(async move {
        if profiles_changed {
            // jdtls takes the profiles from its Maven settings (see `ide_sdk::maven_profiles`).
            lsp.reconfigure().await;
        }
        for file in updates {
            let uri = ide_lsp::path_to_uri_string(&file);
            if let Err(e) = lsp.java_update_project_configs(&file, vec![uri]).await {
                tracing::debug!("java/projectConfigurationsUpdate: {e}");
            }
        }
    });
    Ok(model)
}

/// The POM declaring `dependency` for the Maven module `pom` (project-relative): the
/// module's own, else its nearest parent in the project; its path, text and declaration.
fn declaring_pom(
    project: &Project,
    config: &Path,
    pom: &str,
    dependency: &ArtifactKey,
) -> IdeResult<(std::path::PathBuf, String, Range)> {
    let scopes = workspace::scopes(project, config)?;
    let path = project.root.join(pom);
    let scope = scopes
        .iter()
        .filter(|s| path.starts_with(&s.root))
        .max_by_key(|s| s.root.components().count())
        .ok_or_else(|| IdeError::not_found("Maven project is no longer linked"))?;
    let model = load(&scope.root, &scope.cache, &scope.settings).maven.unwrap_or_default();
    let pom = model
        .projects
        .iter()
        .find(|p| scope.root.join(&p.pom) == path)
        .ok_or_else(|| IdeError::not_found("Maven project is no longer linked"))?;
    for rel in ide_build::pom_edit::declaring_poms(&model, &pom.pom) {
        let path = scope.root.join(&rel);
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
    let config = host.config_dir.clone();
    let token = host.begin_project_request(window, request);
    let result = tokio::task::spawn_blocking(move || {
        let scopes = workspace::scopes(&project, &config)?;
        let scope = scopes
            .iter()
            .find(|s| workspace::selected(s, &project.root, BuildTool::Gradle, build_dir.as_deref()))
            .ok_or_else(|| IdeError::not_found("Gradle project is no longer linked"))?;
        let model = load(&scope.root, &scope.cache, &scope.settings);
        let gradle = model
            .gradle
            .iter()
            .find(|g| build_dir.as_ref().is_none_or(|dir| project.root.join(dir) == scope.root.join(&g.dir)))
            .ok_or_else(|| IdeError::not_found("Gradle project is no longer linked"))?;
        let options = SyncOptions {
            offline,
            env: gradle.env.clone(),
            gradle_command: Some(gradle.command.clone()),
            ..Default::default()
        };
        ide_build::gradle_dependencies(&scope.root, gradle, &options, &gradle_path, &configuration, &token)
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
    let config = host.config_dir.clone();
    tokio::task::spawn_blocking(move || {
        let (path, _, range) = declaring_pom(&project, &config, &pom, &dependency)?;
        Ok(Location::file(path, range))
    })
    .await
    .map_err(join_err)?
}

/// The go-to-declaration target at `pos` of the Maven POM `pom` (project-relative, or
/// absolute for a parent POM opened from the local repository): the definition of the
/// `${property}` at the caret, or the `<dependencyManagement>` / `<pluginManagement>`
/// entry providing the dependency's / plugin's version, along the parent chain (into
/// the local repository when a parent is not in the project), else the artifact's own
/// POM (a project module's, or the local repository's). `None` when nothing
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
        let modules = || {
            let model = load(&project.root, &project.build_cache_dir(), &settings).maven.unwrap_or_default();
            model
                .projects
                .into_iter()
                .map(|p| ide_build::maven::ModulePom {
                    group_id: p.group_id,
                    artifact_id: p.artifact_id,
                    pom: project.root.join(&p.pom),
                })
                .collect()
        };
        Ok(ide_build::maven::goto_declaration_in(&text, &path, pos, repo, modules))
    })
    .await
    .map_err(join_err)?
}

/// How long completion waits for Maven Central before answering from the local repository.
const CENTRAL_WAIT: std::time::Duration = std::time::Duration::from_secs(1);

/// Completion of the `<dependency>` coordinate the caret (`offset`, UTF-16) sits
/// in the value of in the POM `doc`: the coordinates installed in the local
/// repository (Settings › Maven's, else `~/.m2/repository`) — group ids,
/// the chosen group's artifacts, the chosen artifact's versions — topped up
/// with Maven Central's (the search endpoint's popular coordinates, the
/// published version metadata), which the shared version cache keeps for the
/// session. `None` when the caret is not in a `<dependency>` coordinate element.
pub async fn maven_dependency_completion(
    host: &Host,
    window: &str,
    doc: DocId,
    offset: u32,
    request: RequestId,
) -> IdeResult<Option<PomCompletion>> {
    use ide_build::maven::completion::{PomCompletionKind, local_options};
    let project = host.project(window)?;
    let cache = host.dependency_versions.clone();
    let cancel = host.begin_project_read_request(window, request);
    let result = host
        .blocking(move || {
            let snap = project.documents.snapshot(doc)?;
            if snap.large || snap.read_only || !snap.path.file_name().is_some_and(|name| name == "pom.xml") {
                return Ok(None);
            }
            let Some(target) = ide_build::maven::completion::completion_target(&snap.text, offset) else {
                return Ok(None);
            };
            let settings = project.settings.effective();
            let repo = ide_sdk::apply::maven_local_repository(&project.root, &settings)
                .or_else(ide_build::maven::default_local_repo);
            let mut options = repo.map_or_else(Vec::new, |repo| local_options(&repo, &target));
            // Central's answers are cached for the session (the shared version cache).
            // The local repository answers at once: Central gets `CENTRAL_WAIT`, then the
            // lookup finishes in the background and fills the cache for the next request.
            // Offline, behind a proxy or rate-limited, a failed fetch never fails completion.
            let remote = {
                let (cache, target) = (cache.clone(), target.clone());
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    let detached = ide_core::CancellationToken::new();
                    let found = match target.kind {
                        PomCompletionKind::GroupId if !target.typed.is_empty() => {
                            cache.versions(&MavenCentralGroups, &target.typed, &detached).unwrap_or_default()
                        }
                        PomCompletionKind::ArtifactId => match &target.group {
                            Some(group) => cache
                                .versions(&MavenCentralArtifacts { group: group.clone() }, &target.typed, &detached)
                                .unwrap_or_default(),
                            None => Vec::new(),
                        },
                        PomCompletionKind::Version => match (&target.group, &target.artifact) {
                            (Some(group), Some(artifact)) => cache
                                .versions(&MavenCentralVersions, &format!("{group}:{artifact}"), &detached)
                                .unwrap_or_default(),
                            _ => Vec::new(),
                        },
                        _ => Vec::new(), // A group id from nothing: the search endpoint has no such query.
                    };
                    let _ = tx.send(found);
                });
                rx.recv_timeout(CENTRAL_WAIT).unwrap_or_default()
            };
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let known: std::collections::HashSet<String> = options.iter().map(|o| o.label.clone()).collect();
            options.extend(
                remote
                    .into_iter()
                    .filter(|label| !known.contains(label))
                    .map(|label| PomCompletionOption { label, detail: None }),
            );
            options.truncate(ide_build::maven::completion::MAX_OPTIONS);
            Ok(Some(PomCompletion { from: target.from, to: target.to, kind: target.kind, options }))
        })
        .await;
    host.end_request(request);
    result
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
    let config = host.config_dir.clone();
    tokio::task::spawn_blocking(move || {
        let (path, text, range) = declaring_pom(&project, &config, &pom, &dependency)?;
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

fn cmake_plan(root: &Path, kind: BuildKind, configs: &[ide_run::RunConfig], id: &str) -> IdeResult<compile::BuildPlan> {
    let commands = ide_run::cmake_build_configs(configs, id)?;
    let title = commands.last().map(|c| c.name.clone()).unwrap_or_default();
    let mut steps = Vec::new();
    for mut config in commands {
        let cwd = ide_core::project_roots::resolve(root, config.cwd.as_deref().unwrap_or(Path::new("")));
        ide_run::prepare_cmake(&config, &cwd)?;
        if kind == BuildKind::Rebuild && config.args.first().is_some_and(|a| a == "--build") {
            config.args.insert(2, "--clean-first".into());
        }
        steps.push(compile::BuildStep::cmake(&config.command, config.args, cwd, config.env));
    }
    Ok(compile::BuildPlan { system: compile::BuildSystem::CMake, title, steps })
}

/// Build › Build Project / Rebuild Project / Build Module (`file`: a file or folder of the
/// module) / Build Artifacts, streaming the console and messages on `on_event`; cancellable
/// with `cancel_request(request)`. Diagnostics of `clear` (the files of the previous build)
/// are cleared first; the new messages are published as `build` diagnostics.
#[allow(clippy::too_many_arguments)]
pub async fn build_run(
    host: &Host,
    window: &str,
    kind: BuildKind,
    file: Option<std::path::PathBuf>,
    cmake: Option<String>,
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
        // Fast path (#2476): an unchanged single-project Maven build skips
        // Maven entirely. Previous diagnostics stay: nothing changed, so they
        // are still accurate.
        let single = cmake.is_none() && ide_workspace::workspace::Workspace::load(&root)?.is_none();
        if single && kind == BuildKind::Build {
            let model = with_profiles(load(&root, &cache, &settings), &cache);
            if compile::menu_up_to_date(&cache, &root, &model, file.as_deref(), &token) {
                let started = std::time::Instant::now();
                let plan = prepare_plan(
                    compile::plan(&root, &model, kind, file.as_deref(), settings.cmake.profiles.as_deref())?,
                    &root,
                    &settings,
                );
                let _ = on_event.send(BuildEvent::Started { system: plan.system, title: plan.title.clone() });
                let _ = on_event.send(BuildEvent::Output {
                    text: "Up to date: no changes, build skipped.\n".into(),
                    stderr: false,
                });
                return Ok(BuildResult {
                    system: plan.system,
                    title: plan.title,
                    success: true,
                    errors: 0,
                    warnings: 0,
                    duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                    messages: Vec::new(),
                });
            }
        }
        for path in clear {
            sink.emit(IdeEvent::Diagnostics {
                path: path.into(),
                source: compile::DIAGNOSTICS_SOURCE.into(),
                items: Vec::new(),
            });
        }
        let plan = if let Some(id) = cmake {
            let configs = super::run::project_configs(&root, &settings, &config_dir)?;
            cmake_plan(&root, kind, &configs, &id)?
        } else if let Some(workspace) = ide_workspace::workspace::Workspace::load(&root)? {
            let mut combined: Option<compile::BuildPlan> = None;
            for member in workspace.projects.iter().filter(|p| file.as_ref().is_none_or(|f| f.starts_with(p))) {
                let settings = ide_workspace::SettingsStore::load(&config_dir, Some(member)).effective();
                let member_cache =
                    if member == &root { cache.clone() } else { cache.join(crate::project::project_key(member)) };
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
        if result.success && single && kind == BuildKind::Build {
            let model = with_profiles(load(&root, &cache, &settings), &cache);
            compile::record_menu_build(&cache, &root, &model, file.as_deref(), &token);
        }
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

/// Build › Compile File: compiles one Java source of a linked Maven module with
/// `javac`, streaming the console and messages on `on_event`; cancellable with
/// `cancel_request(request)`. Diagnostics of `clear` (the files of the previous
/// build) are cleared first; the new messages are published as `build`
/// diagnostics.
pub async fn build_compile_file(
    host: &Host,
    window: &str,
    file: std::path::PathBuf,
    request: RequestId,
    clear: Vec<std::path::PathBuf>,
    on_event: Channel<BuildEvent>,
) -> IdeResult<BuildResult> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (root, cache, sink) = (project.root.clone(), project.build_cache_dir(), project.sink.clone());
    let settings = project.settings.effective();
    let token = host.begin_project_request(window, request);
    let result = tokio::task::spawn_blocking(move || {
        for path in clear {
            sink.emit(IdeEvent::Diagnostics {
                path: path.into(),
                source: compile::DIAGNOSTICS_SOURCE.into(),
                items: Vec::new(),
            });
        }
        let plan = compile::compile_file_plan(&root, &with_profiles(load(&root, &cache, &settings), &cache), &file)?;
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
    d.add("maven_dependency_completion", |c| async move {
        maven_dependency_completion(&c.host, &c.window, c.arg("doc")?, c.arg("offset")?, c.arg("request")?).await
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
            c.arg("cmake")?,
            c.arg("request")?,
            c.arg("clear")?,
            c.sender("onEvent")?,
        )
        .await
    });
    d.add("build_compile_file", |c| async move {
        build_compile_file(&c.host, &c.window, c.arg("file")?, c.arg("request")?, c.arg("clear")?, c.sender("onEvent")?)
            .await
    });
}

#[cfg(test)]
mod build_tool_settings_tests {
    use super::*;

    #[test]
    fn cmake_builds_keep_target_configuration_environment_and_directory() {
        let root = tempfile::tempdir().unwrap();
        let member = root.path().join("nested project");
        std::fs::create_dir_all(&member).unwrap();
        let config = |id: &str, args: &[&str]| -> ide_run::RunConfig {
            serde_json::from_value(serde_json::json!({
                "id":id,"name":id,"kind":"cmake","command":"custom-cmake",
                "args":args,"cwd":"nested project","env":{"PROFILE":"release"},
                "detected":true,"isTest":false,"debugAdapter":null
            }))
            .unwrap()
        };
        let configure = config("configure", &["-S", ".", "-B", "release", "-G", "Ninja"]);
        let mut build =
            config("target", &["--build", "release", "--target", "hello", "--config", "Release", "-j", "8"]);
        build.extras.before_launch.push(ide_run::BeforeLaunchTask { kind: "build".into(), target: "configure".into() });
        let configs = [configure, build];
        for kind in [BuildKind::Build, BuildKind::Rebuild] {
            let plan = cmake_plan(root.path(), kind, &configs, "target").unwrap();
            assert_eq!(plan.system, compile::BuildSystem::CMake);
            assert_eq!(plan.steps.len(), 2);
            assert_eq!(plan.steps[0].args, configs[0].args);
            let mut args = configs[1].args.clone();
            if kind == BuildKind::Rebuild {
                args.insert(2, "--clean-first".into());
            }
            assert_eq!(plan.steps[1].args, args);
            for step in plan.steps {
                assert_eq!(step.program, "custom-cmake");
                assert_eq!(step.cwd, member);
                assert_eq!(step.env["PROFILE"], "release");
            }
        }
    }

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

#[cfg(test)]
mod maven_completion_tests {
    use super::*;
    use crate::ops::dependencies::hashed_key;
    use ide_build::maven::completion::PomCompletionKind;
    use ide_core::CancellationToken;
    use ide_workspace::dependencies::DependencyVersionSource;
    use std::sync::Arc;

    /// Cache answers the test plants before completing, so the op's Central
    /// lookups hit the session cache and the network is never reached.
    struct FakeSource(&'static str, Vec<&'static str>);
    impl DependencyVersionSource for FakeSource {
        fn id(&self) -> &'static str {
            self.0
        }
        fn cache_key(&self, package: &str) -> Option<String> {
            Some(hashed_key(self.0, package))
        }
        fn fetch(&self, _: &str, _: &CancellationToken) -> IdeResult<Vec<String>> {
            Ok(self.1.iter().map(|s| (*s).to_owned()).collect())
        }
    }

    const GROUPS: &str = "maven-central-groups";
    const ARTIFACTS: &str = "maven-central-artifacts";
    const VERSIONS: &str = "maven-central-versions";

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn completes_dependency_coordinates_from_the_local_repository_then_central() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let (root, repo) = (base.join("project"), base.join("repository"));
        std::fs::create_dir_all(&root).unwrap();
        // Settings › Maven's local repository points at the fixture, so the
        // test machine's own ~/.m2 is never read.
        std::fs::create_dir_all(base.join("config")).unwrap();
        std::fs::write(
            base.join("config/settings.toml"),
            format!("[languages.java.maven]\nlocalRepository = \"{}\"\n", repo.to_string_lossy().replace('\\', "/")),
        )
        .unwrap();
        for file in [
            "org/apache/maven/maven-core/4.0.0-rc-5/maven-core-4.0.0-rc-5.jar",
            "org/example/lib/2.0/lib-2.0.jar",
            "org/lib/1.0/lib-1.0.jar",
        ] {
            let path = repo.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"").unwrap();
        }
        let text = "<project>\n  <dependencies>\n    <dependency>\n      <groupId>org</groupId>\n      <artifactId>lib</artifactId>\n      <version>1.0</version>\n    </dependency>\n    <dependency>\n      <groupId>org.example</groupId>\n      <artifactId></artifactId>\n    </dependency>\n    <dependency>\n      <groupId>org.example</groupId>\n      <artifactId>lib</artifactId>\n      <version></version>\n    </dependency>\n  </dependencies>\n</project>\n";
        let path = root.join("pom.xml");
        std::fs::write(&path, text).unwrap();

        let host = Host::new(crate::HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        let project = host.open_project("main", &root).unwrap();
        let info = project.documents.open(&path).unwrap();

        let token = CancellationToken::new();
        host.dependency_versions.versions(&FakeSource(GROUPS, vec!["org.zzz"]), "org", &token).unwrap();
        host.dependency_versions.versions(&FakeSource(ARTIFACTS, vec!["api"]), "org.example\u{1}", &token).unwrap();
        host.dependency_versions.versions(&FakeSource(VERSIONS, vec!["9.9"]), "org.example:lib", &token).unwrap();

        let at = |needle: &str| (text.find(needle).unwrap() + needle.len()) as u32;
        let next = std::sync::atomic::AtomicU32::new(500);
        let complete = |offset: u32| {
            maven_dependency_completion(
                &host,
                "main",
                info.id,
                offset,
                RequestId(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)),
            )
        };
        fn labels(c: &PomCompletion) -> Vec<&str> {
            c.options.iter().map(|o| o.label.as_str()).collect()
        }

        let group =
            complete(text.find("<groupId>org").unwrap() as u32 + "<groupId>org".len() as u32).await.unwrap().unwrap();
        assert_eq!(group.kind, PomCompletionKind::GroupId);
        // The installed groups first, Central's cached suggestions behind them.
        assert_eq!(labels(&group), ["org", "org.apache.maven", "org.example", "org.zzz"]);
        // Nothing outside a dependency's coordinates.
        let outside = complete(at("<dependencies>")).await;
        assert!(matches!(outside, Ok(None)), "{outside:?}");

        let empty_artifact = text.find("<artifactId></artifactId>").unwrap() as u32 + "<artifactId>".len() as u32;
        let artifact = complete(empty_artifact).await;
        let artifact = match artifact {
            Ok(Some(a)) => a,
            other => panic!("artifact completion: {other:?}"),
        };
        assert_eq!(artifact.kind, PomCompletionKind::ArtifactId);
        let installed = artifact.options.first().unwrap();
        assert_eq!((installed.label.as_str(), installed.detail.as_deref()), ("lib", Some("2.0")));
        assert_eq!(labels(&artifact), ["lib", "api"]);

        let empty_version = text.find("<version></version>").unwrap() as u32 + "<version>".len() as u32;
        let version = complete(empty_version).await.unwrap().unwrap();
        assert_eq!(version.kind, PomCompletionKind::Version);
        assert_eq!(labels(&version), ["2.0", "9.9"]);
        host.close_project("main");
    }
}
