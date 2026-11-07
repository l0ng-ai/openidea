#[allow(unused_imports)]
use super::*;
use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::{IdeError, IdeResult};
use ide_run::RunConfig;
use ide_run::import::{RunImport, RunImportSource};

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
pub fn run_templates(host: &Host, window: &str) -> IdeResult<Vec<RunConfig>> {
    let root = host.project(window)?.root.clone();
    ide_run::load_templates(&root)
}

pub fn run_save_templates(host: &Host, window: &str, templates: Vec<RunConfig>) -> IdeResult<()> {
    let root = host.project(window)?.root.clone();
    ide_run::save_templates(&root, &templates)
}

/// Project files run configurations can be imported from (`.vscode/launch.json`).
pub fn run_import_sources(host: &Host, window: &str) -> IdeResult<Vec<RunImportSource>> {
    let root = host.project(window)?.root.clone();
    Ok(ide_run::import::available(&root))
}

/// Configurations read from `source`, not saved; names already in `existing` (the
/// configurations being edited) are skipped.
pub fn run_import_configs(
    host: &Host,
    window: &str,
    source: RunImportSource,
    existing: Vec<RunConfig>,
) -> IdeResult<RunImport> {
    host.require_trust(window)?;
    let root = host.project(window)?.root.clone();
    ide_run::import_configs(&root, source, &existing)
}

/// The environment runs inherit when "Include system environment variables" is on.
pub fn run_system_env(_host: &Host, _window: &str) -> std::collections::BTreeMap<String, String> {
    ide_run::system_env()
}

/// Writes the Gradle init script that adds `jvm_args` to the JVMs the build forks
/// (`bootRun`, `run`, tests) and returns its path, for `--init-script`.
pub async fn run_gradle_jvm_args_script(_host: &Host, _window: &str, jvm_args: Vec<String>) -> IdeResult<String> {
    tokio::task::spawn_blocking(move || {
        ide_run::gradle_jvm::write_init_script(&ide_run::gradle_jvm::default_dir(), &jvm_args)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| IdeError::internal(format!("cannot write the Gradle init script: {e}")))
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Writes one of the IDE's Gradle init scripts (`text`; the file is named `<name>-<hash>`) on
/// the machine that runs the build, for `--init-script`, and returns its path.
pub async fn run_gradle_init_script(_host: &Host, _window: &str, name: String, text: String) -> IdeResult<String> {
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

pub async fn run_tomcat_home(host: &Host, window: &str, home: String) -> IdeResult<ide_run::tomcat::TomcatHome> {
    host.require_trust(window)?;
    let root = host.project(window)?.root.clone();
    tokio::task::spawn_blocking(move || ide_run::tomcat::validate_home(&root.join(home)))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

pub async fn run_tomcat_installations(
    host: &Host,
    window: &str,
) -> IdeResult<Vec<ide_run::tomcat::TomcatInstallation>> {
    host.require_trust(window)?;
    tokio::task::spawn_blocking(ide_run::tomcat::detect_installations)
        .await
        .map_err(|e| IdeError::internal(e.to_string()))
}

pub async fn run_tomcat_artifacts(host: &Host, window: &str) -> IdeResult<Vec<ide_build::web::WebArtifact>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let model = crate::ops::build::load(&project.root, &project.build_cache_dir(), &project.settings.effective());
        ide_build::web::artifacts(&project.root, &model)
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))
}

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
        let mut plan = ide_build::web::build(
            &project.root,
            &model,
            id,
            &ide_run::tomcat::effective_base_dir(&project.root, &project.cache_dir, &config),
        )?;
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

/// Updates a running Tomcat artifact deployment from the module's compiled output and web
/// resources (`ide_run::tomcat::sync_outputs`). `false`: rebuild the WAR instead.
pub async fn run_tomcat_sync(
    host: &Host,
    window: &str,
    config: RunConfig,
    module: std::path::PathBuf,
    class_paths: Vec<String>,
    resources_only: bool,
) -> IdeResult<bool> {
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
        let base = ide_run::tomcat::effective_base_dir(&project.root, &project.cache_dir, &config);
        ide_run::tomcat::sync_outputs(&base, &module, &class_paths, resources_only)
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("run_dotnet_resolve", |c| async move {
        run_dotnet_resolve(&c.host, &c.window, c.arg("config")?, c.arg("debug")?).await
    });
    d.add("run_application_build", |c| async move {
        run_application_build(&c.host, &c.window, c.arg("config")?, c.arg("module")?).await
    });
    d.add("run_application_publish", |c| async move {
        run_application_publish(&c.host, &c.window, c.arg("config")?, c.arg("classPaths")?, c.arg("mainClass")?).await
    });
    d.add("run_tomcat_home", |c| async move { run_tomcat_home(&c.host, &c.window, c.arg("home")?).await });
    d.add("run_tomcat_installations", |c| async move { run_tomcat_installations(&c.host, &c.window).await });
    d.add("run_tomcat_artifacts", |c| async move { run_tomcat_artifacts(&c.host, &c.window).await });
    d.add("run_tomcat_build", |c| async move { run_tomcat_build(&c.host, &c.window, c.arg("config")?).await });
    d.add("run_tomcat_sync", |c| async move {
        run_tomcat_sync(
            &c.host,
            &c.window,
            c.arg("config")?,
            c.arg("module")?,
            c.arg("classPaths")?,
            c.arg("resourcesOnly")?,
        )
        .await
    });
    d.add("run_tomcat_update", |c| async move {
        run_tomcat_update(&c.host, &c.window, c.arg("config")?, c.arg("mode")?).await
    });
    d.add("run_templates", |c| async move { run_templates(&c.host, &c.window) });
    d.add("run_save_templates", |c| async move { run_save_templates(&c.host, &c.window, c.arg("templates")?) });
    d.add("run_import_sources", |c| async move { run_import_sources(&c.host, &c.window) });
    d.add("run_import_configs", |c| async move {
        run_import_configs(&c.host, &c.window, c.arg("source")?, c.arg("existing")?)
    });
    d.add("run_system_env", |c| async move { Ok(run_system_env(&c.host, &c.window)) });
    d.add("run_gradle_jvm_args_script", |c| async move {
        run_gradle_jvm_args_script(&c.host, &c.window, c.arg("jvmArgs")?).await
    });
    d.add("run_gradle_init_script", |c| async move {
        run_gradle_init_script(&c.host, &c.window, c.arg("name")?, c.arg("text")?).await
    });
    d.add("run_test_reports", |c| async move {
        run_test_reports(&c.host, &c.window, c.arg("module")?, c.arg("sinceMs")?).await
    });
}
