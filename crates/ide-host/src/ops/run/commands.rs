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

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
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
