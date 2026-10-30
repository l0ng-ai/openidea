//! Maven / Gradle tool windows (the build model and its background sync) and
//! Build › Build Project (compiling with the project's build system).
use crate::ops::Channel;
use crate::rpc::Dispatcher;
use crate::{Host, Project, apply_workspace_edit};

use ide_build::compile::{self, BuildEvent, BuildKind, BuildResult};
use ide_build::pom_edit::{ArtifactKey, Exclusion};
use ide_build::{BuildModel, BuildTool, SyncOptions, SyncProgress};
use ide_core::settings::Settings;
use ide_core::{FileEdit, IdeError, IdeEvent, IdeResult, Location, Range, RequestId, WorkspaceEdit};
use std::collections::BTreeMap;
use std::path::Path;

fn join_err(e: tokio::task::JoinError) -> IdeError {
    IdeError::internal(e.to_string())
}

/// `JAVA_HOME`: the project JDK, else the installed JDK matching `release` (none
/// when the project names no version).
fn java_env(project_jdk: Option<&ide_sdk::java::Jdk>, release: Option<u32>) -> BTreeMap<String, String> {
    let jdks = ide_sdk::java::installed_jdks();
    let jdk = project_jdk.or_else(|| release.and_then(|r| ide_sdk::java::pick_jdk(&jdks, Some(r))));
    jdk.map(|j| BTreeMap::from([("JAVA_HOME".to_owned(), j.home.to_string_lossy().into_owned())])).unwrap_or_default()
}

/// The build model with the launch settings applied: the JDK (`JAVA_HOME`), and
/// the Maven home and options from Settings › Maven.
pub fn load(root: &Path, cache: &Path, settings: &Settings) -> BuildModel {
    let mut model = ide_build::load_linked(
        root,
        cache,
        ide_sdk::apply::maven_local_repository(root, settings),
        &settings.languages.java.maven,
    );
    let jdk = ide_sdk::apply::project_jdk(root, settings);
    if let Some(m) = &mut model.maven {
        let mvn = ide_sdk::apply::maven_command(root, settings);
        let options = ide_sdk::apply::maven_options(root, settings);
        for p in &mut m.projects {
            p.env = java_env(jdk.as_ref(), p.java_version);
            if let Some(mvn) = &mvn {
                p.command = mvn.to_string_lossy().into_owned();
            }
            p.options = options.clone();
        }
    }
    if let Some(g) = &mut model.gradle {
        g.env = ide_sdk::apply::gradle_env(root, settings, java_env(jdk.as_ref(), g.java_version));
        g.command = ide_sdk::apply::gradle_command(root, &root.join(&g.dir), settings).to_string_lossy().into_owned();
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
        let hint = m.projects.iter().find_map(|p| missing(p.java_version));
        explain(&mut m.sync_error, hint);
    }
    if let Some(g) = &mut model.gradle
        && g.sync_error.is_some()
    {
        let hint = if settings.languages.java.gradle.jvm.trim().is_empty() { missing(g.java_version) } else { None };
        explain(&mut g.sync_error, hint);
    }
    model
}

/// Maven and Gradle projects of the window's project, from the build files plus the last sync.
pub async fn build_model(host: &Host, window: &str) -> IdeResult<BuildModel> {
    let project = host.project(window)?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    tokio::task::spawn_blocking(move || load(&root, &cache, &settings)).await.map_err(join_err)
}

/// Runs Maven (`help:effective-pom dependency:tree`) or Gradle (`tasks --all`) in the
/// background, reporting progress on `on_progress`; cancellable with `cancel_request(request)`.
/// Returns the refreshed model; a failed build is reported in its `syncError`.
pub async fn build_sync(
    host: &Host,
    window: &str,
    tool: BuildTool,
    request: RequestId,
    offline: bool,
    profiles: Vec<String>,
    on_progress: Channel<SyncProgress>,
) -> IdeResult<BuildModel> {
    let project = host.project(window)?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    let token = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let current = load(&root, &cache, &settings);
        let env = match tool {
            BuildTool::Maven => current
                .maven
                .as_ref()
                .and_then(|m| m.projects.iter().find(|p| !p.env.is_empty()))
                .map(|p| p.env.clone())
                .unwrap_or_default(),
            BuildTool::Gradle => current.gradle.as_ref().map(|g| g.env.clone()).unwrap_or_default(),
        };
        let options = SyncOptions {
            offline,
            profiles,
            env,
            maven_command: ide_sdk::apply::maven_command(&root, &settings).map(|p| p.to_string_lossy().into_owned()),
            maven_options: ide_sdk::apply::maven_options(&root, &settings),
            maven_settings: settings.languages.java.maven.clone(),
            gradle_command: current.gradle.as_ref().map(|g| g.command.clone()),
        };
        let progress = |p: SyncProgress| {
            let _ = on_progress.send(p);
        };
        match tool {
            BuildTool::Maven => ide_build::sync_maven(&root, &cache, &options, &token, &progress)?,
            BuildTool::Gradle => ide_build::sync_gradle(&root, &cache, &options, &token, &progress)?,
        }
        Ok::<BuildModel, IdeError>(load(&root, &cache, &settings))
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    let model = result??;
    if tool == BuildTool::Maven
        && let Some(maven) = &model.maven
    {
        // jdtls re-imports on pom changes but misses artifacts added to ~/.m2
        // meanwhile ("missing artifact" stays until Invalidate Caches); asking it
        // to update the project configurations re-resolves them (#436).
        let lsp = project.lsp.clone();
        let uris = maven.projects.iter().map(|p| ide_lsp::path_to_uri_string(&project.root.join(&p.pom))).collect();
        tokio::spawn(async move {
            if let Err(e) = lsp.java_update_project_configs(&project.root, uris).await {
                tracing::debug!("java/projectConfigurationsUpdate: {e}");
            }
        });
    }
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
                let edit =
                    WorkspaceEdit { files: vec![FileEdit::Edit { path: path.clone().into(), edits: vec![edit] }] };
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
    let project = host.project(window)?;
    let (root, cache, sink) = (project.root.clone(), project.build_cache_dir(), project.sink.clone());
    let settings = project.settings.effective();
    let token = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        for path in clear {
            sink.emit(IdeEvent::Diagnostics {
                path: path.into(),
                source: compile::DIAGNOSTICS_SOURCE.into(),
                items: Vec::new(),
            });
        }
        let plan = compile::plan(&root, &load(&root, &cache, &settings), kind, file.as_deref())?;
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
    d.add("build_sync", |c| async move {
        build_sync(
            &c.host,
            &c.window,
            c.arg("tool")?,
            c.arg("request")?,
            c.arg("offline")?,
            c.arg("profiles")?,
            c.sender("onProgress")?,
        )
        .await
    });
    d.add("maven_dependency_declaration", |c| async move {
        maven_dependency_declaration(&c.host, &c.window, c.arg("pom")?, c.arg("dependency")?).await
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
mod gradle_settings_tests {
    use super::*;

    #[test]
    fn model_for_sync_tasks_and_compile_uses_gradle_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("build.gradle"), "plugins { id 'java' }").unwrap();
        let wrapper = root.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" });
        std::fs::write(&wrapper, "").unwrap();
        let mut settings = Settings::default();
        let default = load(root, &root.join("cache"), &settings).gradle.unwrap();
        assert_eq!(default.command, wrapper.to_string_lossy());
        settings.languages.java.gradle.jvm = "jdk21".into();
        settings.languages.java.gradle.user_home = "user-home".into();
        settings.languages.java.gradle.distribution = ide_core::settings::GradleDistribution::Local;
        settings.languages.java.gradle.home = "gradle-install".into();
        let model = load(root, &root.join("cache"), &settings).gradle.unwrap();
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
