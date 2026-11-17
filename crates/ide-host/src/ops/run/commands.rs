use crate::Host;
use ide_command::command;
use ide_core::{IdeError, IdeResult};
use ide_run::RunConfig;
use ide_run::import::{RunImport, RunImportSource};

#[command(trust = trusted)]
pub async fn run_dotnet_resolve(host: &Host, window: &str, config: RunConfig, debug: bool) -> IdeResult<RunConfig> {
    host.require_trust(window)?;
    if !matches!(config.kind.as_str(), "dotnet" | "dotnet-test")
        || config.extras.target.as_ref().is_some_and(|s| !s.is_empty())
    {
        return Err(IdeError::invalid(".NET Project requires the local machine"));
    }
    let project = host.project(window)?;
    let mut config = host.blocking(move || ide_run::dotnet::resolve(&project.root, config)).await?;
    if debug {
        let root = host.project(window)?.root.clone();
        let target = ide_run::dotnet::target_path(&root, &config).await?;
        config.extras.params.insert("targetPath".into(), target);
    }
    Ok(config)
}

fn application_cache(project: &crate::project::Project, id: &str) -> std::path::PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut hash);
    project.cache_dir.join("application-update").join(format!("{:x}", hash.finish()))
}

#[command(trust = trusted)]
pub async fn run_application_build(
    host: &Host,
    window: &str,
    config: RunConfig,
    module: std::path::PathBuf,
) -> IdeResult<RunConfig> {
    host.require_trust(window)?;
    if config.kind != "spring-boot" || config.extras.target.as_ref().is_some_and(|t| !t.is_empty()) {
        return Err(IdeError::invalid("Application resource updates require a local Spring Boot configuration"));
    }
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let model = crate::ops::build::load(&project.root, &project.build_cache_dir(), &project.settings.effective());
        let plan = ide_build::application_update::plan(
            &project.root,
            &model,
            &module,
            &application_cache(&project, &config.id),
        )?;
        let mut env = plan.env;
        env.extend(config.env);
        Ok(RunConfig {
            id: format!("application-build:{}", config.id),
            name: format!("Update {}", config.name),
            kind: plan.kind.into(),
            command: plan.command,
            args: plan.args,
            cwd: Some(project.root.join(plan.cwd).into()),
            env,
            detected: false,
            is_test: false,
            debug_adapter: None,
            allow_parallel: false,
            extras: ide_run::RunExtras {
                include_system_env: config.extras.include_system_env,
                env_files: config.extras.env_files,
                ..Default::default()
            },
        })
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

#[command(trust = trusted)]
pub async fn run_application_publish(
    host: &Host,
    window: &str,
    config: RunConfig,
    class_paths: Vec<String>,
    main_class: String,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        ide_build::application_update::publish(
            &project.root,
            &application_cache(&project, &config.id),
            &class_paths,
            &main_class,
        )
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Configuration templates: per-type defaults applied to new configurations.
#[command(trust = trusted)]
pub async fn run_templates(host: &Host, window: &str) -> IdeResult<Vec<RunConfig>> {
    let root = host.project(window)?.root.clone();
    crate::ops::doc::blocking(move || ide_run::load_templates(&root)).await
}

#[command(trust = trusted)]
pub async fn run_save_templates(host: &Host, window: &str, templates: Vec<RunConfig>) -> IdeResult<()> {
    let root = host.project(window)?.root.clone();
    crate::ops::doc::blocking(move || ide_run::save_templates(&root, &templates)).await
}

/// Project files run configurations can be imported from (`.vscode/launch.json`).
#[command(trust = trusted)]
pub async fn run_import_sources(host: &Host, window: &str) -> IdeResult<Vec<RunImportSource>> {
    let root = host.project(window)?.root.clone();
    crate::ops::doc::blocking(move || Ok(ide_run::import::available(&root))).await
}

/// Configurations read from `source`, not saved; names already in `existing` are skipped.
#[command(trust = trusted)]
pub async fn run_import_configs(
    host: &Host,
    window: &str,
    source: RunImportSource,
    existing: Vec<RunConfig>,
) -> IdeResult<RunImport> {
    // `existing`: the configurations being edited.
    host.require_trust(window)?;
    let root = host.project(window)?.root.clone();
    crate::ops::doc::blocking(move || ide_run::import_configs(&root, source, &existing)).await
}

/// The environment runs inherit when "Include system environment variables" is on.
#[command(trust = always)]
pub fn run_system_env() -> std::collections::BTreeMap<String, String> {
    ide_run::system_env()
}

/// Variables of the `.env` files a debug launch names, for the debugger to start with.
#[command(trust = trusted)]
pub async fn run_env_files(files: Vec<std::path::PathBuf>) -> IdeResult<std::collections::BTreeMap<String, String>> {
    // In order (later files win): the same files a run loads, over the system environment
    // debug adapters inherit.
    crate::ops::doc::blocking(move || {
        ide_run::envfile::load(&files, &ide_run::system_env())
            .map_err(|e| IdeError::not_found(format!("cannot read .env file: {e}")))
    })
    .await
}

/// Writes the Gradle init script adding `jvm_args` to the JVMs the build forks; returns its path.
#[command(trust = always)]
pub async fn run_gradle_jvm_args_script(jvm_args: Vec<String>) -> IdeResult<String> {
    // The forked JVMs: `bootRun`, `run`, tests; the path is for `--init-script`.
    tokio::task::spawn_blocking(move || {
        ide_run::gradle_jvm::write_init_script(&ide_run::gradle_jvm::default_dir(), &jvm_args)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| IdeError::internal(format!("cannot write the Gradle init script: {e}")))
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Writes one of the IDE's Gradle init scripts where the build runs; returns its path.
#[command(trust = trusted)]
pub async fn run_gradle_init_script(name: String, text: String) -> IdeResult<String> {
    // `text`; the file is named `<name>-<hash>`, for `--init-script`.
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(IdeError::invalid(format!("invalid init script name {name:?}")));
    }
    tokio::task::spawn_blocking(move || {
        ide_run::gradle_jvm::write_script(&ide_run::gradle_jvm::default_dir(), &name, &text)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| IdeError::internal(format!("cannot write the Gradle init script: {e}")))
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Results from the JUnit XML reports (Surefire, Failsafe, Gradle) of the module at
/// `module` (relative to the project root) written since `since_ms` (Unix epoch, ms).
#[command(trust = trusted)]
pub async fn run_test_reports(
    host: &Host,
    window: &str,
    module: Option<std::path::PathBuf>,
    since_ms: f64,
) -> IdeResult<Vec<ide_run::junit::TestCaseReport>> {
    let root = host.project(window)?.root.clone();
    let dir = module.map(|m| root.join(m)).unwrap_or(root);
    let since = std::time::UNIX_EPOCH + std::time::Duration::from_millis(since_ms.max(0.0) as u64);
    tokio::task::spawn_blocking(move || ide_run::junit::read_reports(&ide_run::junit::report_dirs(&dir), since))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))
}

#[command(trust = trusted)]
pub async fn run_tomcat_home(host: &Host, window: &str, home: String) -> IdeResult<ide_run::tomcat::TomcatHome> {
    host.require_trust(window)?;
    let root = host.project(window)?.root.clone();
    tokio::task::spawn_blocking(move || ide_run::tomcat::validate_home(&root.join(home)))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

#[command(trust = trusted)]
pub async fn run_tomcat_installations(
    host: &Host,
    window: &str,
) -> IdeResult<Vec<ide_run::tomcat::TomcatInstallation>> {
    host.require_trust(window)?;
    tokio::task::spawn_blocking(ide_run::tomcat::detect_installations)
        .await
        .map_err(|e| IdeError::internal(e.to_string()))
}

/// Id prefix of a Project Structure WAR artifact (a project without a build tool).
const PROJECT_ARTIFACT: &str = "project:";

fn project_web_artifacts(ps: &ide_core::settings::ProjectStructureSettings) -> Vec<ide_build::web::WebArtifact> {
    ide_build::compile::structure_web_artifacts(ps)
        .into_iter()
        .map(|a| ide_build::web::WebArtifact {
            id: format!("{PROJECT_ARTIFACT}{}", a.name),
            name: a.name.split(':').next().unwrap_or(&a.name).to_owned(),
            module: if a.module == "." { String::new() } else { a.module.clone() },
            tool: "project".into(),
        })
        .collect()
}

/// Compiles the project and packs the Project Structure artifact `name` as the WAR Tomcat
/// deploys, recorded in `base` like a build tool's archive.
fn build_project_war(
    root: &std::path::Path,
    settings: &ide_core::settings::Settings,
    detected: &[ide_workspace::roots::SourceFolder],
    name: &str,
    base: &std::path::Path,
    cache: &std::path::Path,
) -> IdeResult<()> {
    use ide_build::compile;
    let (ps, roots, jdk) = crate::ops::build::structure_inputs(root, settings, detected);
    let artifact = ps
        .artifacts
        .iter()
        .find(|a| a.name == name)
        .ok_or_else(|| IdeError::invalid(format!("No artifact named {name} in Project Structure › Artifacts")))?;
    let war = base.join("artifact").join(format!(
        "{}.war",
        name.split(':').next().unwrap_or(name).replace(|c: char| !c.is_alphanumeric() && c != '-', "_")
    ));
    let plan = compile::structure_war_plan(
        root,
        &ps,
        &roots,
        jdk.as_ref(),
        &settings.languages.java.language_level,
        artifact,
        &war,
        cache,
    )?;
    let result = compile::run(root, &plan, &ide_core::CancellationToken::new(), &|_| {})?;
    if !result.success {
        let first = result.messages.iter().find(|m| m.severity == ide_core::Severity::Error);
        let text = match first {
            Some(m) => match (&m.path, m.range) {
                (Some(path), Some(range)) => {
                    format!("{}:{}: {}", std::path::PathBuf::from(path.clone()).display(), range.start.line + 1, m.text)
                }
                _ => m.text.clone(),
            },
            None => "the build failed".into(),
        };
        return Err(IdeError::invalid(format!("Cannot build {name}: {text}")));
    }
    std::fs::create_dir_all(base)?;
    std::fs::write(base.join("artifact-id.txt"), format!("{PROJECT_ARTIFACT}{name}"))?;
    std::fs::write(base.join("artifact-path.txt"), war.to_string_lossy().as_bytes())?;
    Ok(())
}

#[command(trust = trusted)]
pub async fn run_tomcat_artifacts(host: &Host, window: &str) -> IdeResult<Vec<ide_build::web::WebArtifact>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let settings = project.settings.effective();
        let model = crate::ops::build::load(&project.root, &project.build_cache_dir(), &settings);
        let mut artifacts = ide_build::web::artifacts(&project.root, &model);
        // Without a build tool, the Project Structure's WAR artifacts are built by the IDE.
        if model.maven.is_none() && model.gradle.is_empty() {
            let detected = project.detected_roots.read().clone();
            let (ps, _, _) = crate::ops::build::structure_inputs(&project.root, &settings, &detected);
            artifacts.extend(project_web_artifacts(&ps));
        }
        artifacts
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))
}

#[command(trust = trusted)]
pub async fn run_tomcat_build(host: &Host, window: &str, config: RunConfig) -> IdeResult<Option<RunConfig>> {
    host.require_trust(window)?;
    if config.extras.params.get("deployment").is_some_and(|v| v != "artifact") {
        return Ok(None);
    }
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let model = crate::ops::build::load(&project.root, &project.build_cache_dir(), &project.settings.effective());
        let artifacts = ide_build::web::artifacts(&project.root, &model);
        let id = config
            .extras
            .params
            .get("artifact")
            .filter(|s| !s.is_empty())
            .or_else(|| artifacts.first().map(|a| &a.id))
            .ok_or_else(|| IdeError::invalid("Choose a WAR artifact"))?;
        let base = ide_run::tomcat::effective_base_dir(&project.root, &project.cache_dir, &config)?;
        if let Some(name) = id.strip_prefix(PROJECT_ARTIFACT) {
            let settings = project.settings.effective();
            let detected = project.detected_roots.read().clone();
            build_project_war(&project.root, &settings, &detected, name, &base, &project.build_cache_dir())?;
            return Ok(None);
        }
        // "Build before launch" is skipped when the built WAR is already newer than the
        // sources of every module in the build, so a repeated run does not rebuild (IDEA's
        // up-to-date check) but a change in a dependency module does.
        let modules: Vec<std::path::PathBuf> = model
            .maven
            .iter()
            .flat_map(|m| m.projects.iter().map(|p| p.dir.as_str()))
            .chain(model.gradle.iter().flat_map(|g| g.projects.iter().map(|p| p.dir.as_str())))
            .map(std::path::PathBuf::from)
            .collect();
        if ide_run::tomcat::artifact_is_current(&project.root, &base, &config, &modules) {
            return Ok(None);
        }
        let mut plan = ide_build::web::build(&project.root, &model, id, &base)?;
        plan.env.extend(config.env.clone());
        let mut build = RunConfig {
            id: format!("tomcat-build:{}", config.id),
            name: format!("Build {}", config.name),
            kind: if id.starts_with("maven:") { "maven" } else { "gradle" }.into(),
            command: plan.command.clone(),
            args: vec![],
            cwd: Some(std::path::PathBuf::from(&plan.cwd).into()),
            env: plan.env.clone(),
            detected: false,
            is_test: false,
            debug_adapter: None,
            allow_parallel: false,
            extras: ide_run::RunExtras {
                include_system_env: config.extras.include_system_env,
                env_files: config.extras.env_files,
                ..Default::default()
            },
        };
        plan.resolve_project(
            &project.root,
            &ide_run::resolved_env(&project.root, &build)?,
            &ide_core::CancellationToken::new(),
        )?;
        build.args = plan.args;
        Ok(Some(build))
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

#[command(trust = trusted)]
pub async fn run_tomcat_update(host: &Host, window: &str, config: RunConfig, mode: String) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    if !host.processes.list().iter().any(|r| r.running && r.config_id == config.id) {
        return Err(IdeError::invalid("Start this Tomcat configuration before updating it"));
    }
    tokio::task::spawn_blocking(move || ide_run::tomcat::update(&project.root, &project.cache_dir, &config, &mode))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

#[command(trust = trusted)]
pub async fn run_tomcat_sync(
    host: &Host,
    window: &str,
    config: RunConfig,
    module: std::path::PathBuf,
    class_paths: Vec<String>,
    resources_only: bool,
) -> IdeResult<bool> {
    // Updates a running Tomcat artifact deployment from the module's compiled output and web
    // resources (`ide_run::tomcat::sync_outputs`). `false`: rebuild the WAR instead.
    host.require_trust(window)?;
    let project = host.project(window)?;
    if !host.processes.list().iter().any(|r| r.running && r.config_id == config.id) {
        return Err(IdeError::invalid("Start this Tomcat configuration before updating it"));
    }
    if config.extras.params.get("deployment").is_some_and(|v| v != "artifact") {
        return Ok(false);
    }
    tokio::task::spawn_blocking(move || {
        let module = dunce::canonicalize(project.root.join(module))?;
        let class_paths: Vec<_> =
            class_paths.iter().filter_map(|p| dunce::canonicalize(project.root.join(p)).ok()).collect();
        let base = ide_run::tomcat::effective_base_dir(&project.root, &project.cache_dir, &config)?;
        ide_run::tomcat::sync_outputs(&base, &module, &class_paths, resources_only)
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

ide_command::domain!(
    run_commands:
    run_application_build,
    run_application_publish,
    run_dotnet_resolve,
    run_env_files,
    run_gradle_init_script,
    run_gradle_jvm_args_script,
    run_import_configs,
    run_import_sources,
    run_save_templates,
    run_system_env,
    run_templates,
    run_test_reports,
    run_tomcat_artifacts,
    run_tomcat_build,
    run_tomcat_home,
    run_tomcat_installations,
    run_tomcat_sync,
    run_tomcat_update,
);
