use super::Emit;
use crate::Host;
use ide_core::{IdeError, IdeResult, RunId};
use ide_run::{OutputChunk, RunConfig, RunInfo, StartOptions};
use std::time::Duration;

/// Detected configs followed by user-defined ones (user ids win on conflict).
pub fn configs(host: &Host, window: &str) -> IdeResult<Vec<RunConfig>> {
    let project = host.project(window)?;
    let root = project.root.clone();
    let user = ide_run::load_user_configs(&root)?;
    let suppressed = ide_run::load_suppressed_config_ids(&root)?;
    let settings = project.settings.effective();
    let excluded_poms = crate::project::unlinked_maven_poms(&root, &settings);
    let mut all: Vec<RunConfig> = ide_run::detect_excluding(&root, &excluded_poms)
        .into_iter()
        .filter(|d| !suppressed.contains(&d.id) && !user.iter().any(|u| u.id == d.id))
        .collect();
    all.extend(user);
    // Project interpreter / package manager / toolchains from Languages & Frameworks.
    // Keep Gradle choices unmodified in the editor: derived defaults must not be saved as explicit env.
    for config in all.iter_mut().filter(|c| c.kind != "gradle") {
        ide_sdk::apply::apply_to_run_configs(std::slice::from_mut(config), &root, &settings);
    }
    Ok(all)
}

pub fn save_configs(
    host: &Host,
    window: &str,
    configs: &[RunConfig],
    removed_detected_ids: &[String],
) -> IdeResult<()> {
    ide_run::save_user_configs_with_removals(&host.project(window)?.root, configs, removed_detected_ids)
}

pub async fn start(host: &Host, window: &str, config: RunConfig, on_output: Emit<OutputChunk>) -> IdeResult<RunInfo> {
    let project = host.project(window)?;
    if config.command.is_empty() {
        return Err(IdeError::invalid("run configuration has no command"));
    }
    // Settings › Run Targets: over SSH.
    if config.kind == "tomcat" && config.extras.target.as_deref().is_some_and(|t| !t.is_empty()) {
        return Err(IdeError::invalid("Tomcat Local requires the local machine"));
    }
    if config.extras.target.as_deref().is_some_and(|t| !t.is_empty()) {
        let settings = project.settings.effective();
        let out = on_output.clone();
        return host
            .remote
            .run(&settings, &project.root, &config, project.sink.clone(), Box::new(move |c| out(c)))
            .await;
    }
    let settings = project.settings.effective();
    // Configurations made in the UI name bare tools (`godot`) that may live outside PATH.
    let mut config = config;
    if matches!(config.kind.as_str(), "gradle" | "tomcat") {
        ide_sdk::apply::apply_to_run_configs(std::slice::from_mut(&mut config), &project.root, &settings);
    } else {
        ide_sdk::apply::resolve_run_command(&mut config, &project.root, &settings);
    }
    if config.command == ide_sdk::godot::COMMAND {
        return Err(IdeError::unavailable(ide_sdk::godot::NOT_FOUND));
    }
    if config.kind == "tomcat" {
        if host.processes.list().iter().any(|r| r.running && r.config_id == config.id) {
            return Err(IdeError::invalid("This Tomcat configuration is already running"));
        }
        let (root, cache) = (project.root.clone(), project.cache_dir.clone());
        config = tokio::task::spawn_blocking(move || {
            ide_run::tomcat::prepare(&root, &cache, &mut config)?;
            Ok::<_, IdeError>(config)
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    }
    let encoding = settings.console.encoding;
    let options = StartOptions {
        encoding: Some(encoding).filter(|e| !e.trim().is_empty()),
        python_paths: super::python::paths(&project),
    };
    host.processes.start(&project.root, &config, &options, project.sink.clone(), Box::new(move |c| on_output(c)))
}

/// Stops a run (interrupt, then kill after Settings › Run's termination timeout).
pub fn stop(host: &Host, window: &str, id: RunId) -> IdeResult<()> {
    let settings = match host.project(window) {
        Ok(p) => p.settings.effective(),
        Err(_) => host.global_settings.effective(),
    };
    let grace = Duration::from_millis(u64::from(settings.run.termination_timeout_ms));
    if host.remote.runs.contains(id) {
        return host.remote.runs.stop(id, grace);
    }
    host.processes.stop_with_grace(id, grace)
}

pub fn stdin(host: &Host, id: RunId, data: &str) -> IdeResult<()> {
    if host.remote.runs.contains(id) {
        return host.remote.runs.write_stdin(id, data);
    }
    host.processes.write_stdin(id, data)
}

pub fn resize(host: &Host, id: RunId, cols: u16, rows: u16) -> IdeResult<()> {
    if host.remote.runs.contains(id) {
        return host.remote.runs.resize(id, cols, rows);
    }
    host.processes.resize(id, cols, rows)
}

pub fn close_stdin(host: &Host, id: RunId) -> IdeResult<()> {
    if host.remote.runs.contains(id) {
        return host.remote.runs.close_stdin(id);
    }
    host.processes.close_stdin(id)
}

pub fn list(host: &Host) -> Vec<RunInfo> {
    let mut runs = host.processes.list();
    runs.extend(host.remote.runs.list());
    runs
}

mod commands;
pub use commands::*;
