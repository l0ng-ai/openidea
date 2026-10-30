#[allow(unused_imports)]
use super::*;
use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::{IdeError, IdeResult};
use ide_run::RunConfig;

/// Configuration templates: per-type defaults applied to new configurations.
pub fn run_templates(host: &Host, window: &str) -> IdeResult<Vec<RunConfig>> {
    let root = host.project(window)?.root.clone();
    ide_run::load_templates(&root)
}

pub fn run_save_templates(host: &Host, window: &str, templates: Vec<RunConfig>) -> IdeResult<()> {
    let root = host.project(window)?.root.clone();
    ide_run::save_templates(&root, &templates)
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
    let root = host.project(window)?.root.clone();
    tokio::task::spawn_blocking(move || ide_run::tomcat::validate_home(&root.join(home)))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

pub async fn run_tomcat_artifacts(host: &Host, window: &str) -> IdeResult<Vec<ide_build::web::WebArtifact>> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let model = crate::ops::build::load(&project.root, &project.build_cache_dir(), &project.settings.effective());
        ide_build::web::artifacts(&project.root, &model)
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))
}

pub async fn run_tomcat_build(host: &Host, window: &str, config: RunConfig) -> IdeResult<Option<RunConfig>> {
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
        let plan = ide_build::web::build(
            &project.root,
            &model,
            id,
            &ide_run::tomcat::base_dir(&project.cache_dir, &config.id),
        )?;
        let mut env = plan.env;
        env.extend(config.env.clone());
        Ok(Some(RunConfig {
            id: format!("tomcat-build:{}", config.id),
            name: format!("Build {}", config.name),
            kind: if id.starts_with("maven:") { "maven" } else { "gradle" }.into(),
            command: plan.command,
            args: plan.args,
            cwd: Some(std::path::PathBuf::from(plan.cwd).into()),
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
        }))
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

pub async fn run_tomcat_update(host: &Host, window: &str, config: RunConfig, mode: String) -> IdeResult<()> {
    let project = host.project(window)?;
    if !host.processes.list().iter().any(|r| r.running && r.config_id == config.id) {
        return Err(IdeError::invalid("Start this Tomcat configuration before updating it"));
    }
    tokio::task::spawn_blocking(move || ide_run::tomcat::update(&project.root, &project.cache_dir, &config, &mode))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("run_tomcat_home", |c| async move { run_tomcat_home(&c.host, &c.window, c.arg("home")?).await });
    d.add("run_tomcat_artifacts", |c| async move { run_tomcat_artifacts(&c.host, &c.window).await });
    d.add("run_tomcat_build", |c| async move { run_tomcat_build(&c.host, &c.window, c.arg("config")?).await });
    d.add("run_tomcat_update", |c| async move {
        run_tomcat_update(&c.host, &c.window, c.arg("config")?, c.arg("mode")?).await
    });
    d.add("run_templates", |c| async move { run_templates(&c.host, &c.window) });
    d.add("run_save_templates", |c| async move { run_save_templates(&c.host, &c.window, c.arg("templates")?) });
    d.add("run_system_env", |c| async move { Ok(run_system_env(&c.host, &c.window)) });
    d.add("run_gradle_jvm_args_script", |c| async move {
        run_gradle_jvm_args_script(&c.host, &c.window, c.arg("jvmArgs")?).await
    });
    d.add("run_test_reports", |c| async move {
        run_test_reports(&c.host, &c.window, c.arg("module")?, c.arg("sinceMs")?).await
    });
}
