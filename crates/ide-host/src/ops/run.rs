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
    let root_suppressed = ide_run::load_suppressed_config_ids(&root)?;
    let settings = project.settings.effective();
    let mut all = detected_and_saved(&root, &settings, &user, &root_suppressed);
    if let Some(workspace) = ide_workspace::workspace::Workspace::load(&root)? {
        for member in workspace.projects.into_iter().filter(|p| p.is_dir()) {
            let settings = ide_workspace::SettingsStore::load(&host.config_dir, Some(&member)).effective();
            let saved = ide_run::load_user_configs(&member)?;
            let suppressed = ide_run::load_suppressed_config_ids(&member)?;
            let configs = detected_and_saved(&member, &settings, &saved, &suppressed);
            let key = crate::project::project_key(&member);
            let name = member.file_name().unwrap_or_default().to_string_lossy();
            for mut config in configs {
                config.id = format!("workspace:{}:{}", key, config.id);
                config.name = format!("{name} / {}", config.name);
                config.cwd = Some(config.cwd.map(|p| member.join(&*p)).unwrap_or_else(|| member.clone()).into());
                config.detected = true;
                if !user.iter().any(|u| u.id == config.id) && !root_suppressed.contains(&config.id) {
                    all.push(config);
                }
            }
        }
    }
    Ok(all)
}

/// A project's detected configurations (minus removed ones and unlinked Maven projects), then
/// its saved ones; toolchains from Languages & Frameworks applied. Gradle choices stay as saved:
/// derived defaults must not be written back as explicit environment.
fn detected_and_saved(
    root: &std::path::Path,
    settings: &ide_core::settings::Settings,
    saved: &[RunConfig],
    suppressed: &[String],
) -> Vec<RunConfig> {
    let excluded_poms = crate::project::unlinked_maven_poms(root, settings);
    let mut all: Vec<RunConfig> = ide_run::detect_excluding(root, &excluded_poms)
        .into_iter()
        .filter(|d| !suppressed.contains(&d.id) && !saved.iter().any(|u| u.id == d.id))
        .collect();
    all.extend(saved.iter().cloned());
    for config in all.iter_mut().filter(|c| c.kind != "gradle") {
        ide_sdk::apply::apply_to_run_configs(std::slice::from_mut(config), root, settings);
    }
    all
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
    let member = ide_workspace::workspace::Workspace::load(&project.root)?.and_then(|workspace| {
        let cwd = config.cwd.as_deref()?;
        workspace.projects.into_iter().filter(|root| cwd.starts_with(root)).max_by_key(|root| root.components().count())
    });
    let root = member.as_ref().unwrap_or(&project.root);
    let settings = match &member {
        Some(root) => ide_workspace::SettingsStore::load(&host.config_dir, Some(root)).effective(),
        None => project.settings.effective(),
    };
    // Configurations made in the UI name bare tools (`godot`) that may live outside PATH.
    let mut config = config;
    if matches!(config.kind.as_str(), "gradle" | "tomcat") {
        ide_sdk::apply::apply_to_run_configs(std::slice::from_mut(&mut config), root, &settings);
    } else {
        ide_sdk::apply::resolve_run_command(&mut config, root, &settings);
    }
    if config.kind == "go" {
        ide_sdk::apply::apply_to_run_configs(std::slice::from_mut(&mut config), root, &settings);
        ide_sdk::go::apply_to_run(&mut config, &settings.languages.go.build_tags);
    }
    if config.command == ide_sdk::godot::COMMAND {
        return Err(IdeError::unavailable(ide_sdk::godot::NOT_FOUND));
    }
    if config.kind == "tomcat" {
        if host.processes.list().iter().any(|r| r.running && r.config_id == config.id) {
            return Err(IdeError::invalid("This Tomcat configuration is already running"));
        }
        let (root, cache) = (root.clone(), project.cache_dir.clone());
        config = tokio::task::spawn_blocking(move || {
            ide_run::tomcat::prepare(&root, &cache, &mut config)?;
            Ok::<_, IdeError>(config)
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    }
    if config.kind == "go" && config.extras.params.get("scope").is_some_and(|s| s == "file") {
        let root = project.root.clone();
        config = host
            .blocking(move || {
                ide_run::go::prepare_test_file(&root, &mut config)?;
                Ok(config)
            })
            .await?;
    }
    let encoding = settings.console.encoding;
    let options = StartOptions {
        encoding: Some(encoding).filter(|e| !e.trim().is_empty()),
        python_paths: if member.is_some() { vec![root.clone()] } else { super::python::paths(&project) },
    };
    let mut sink = project.sink.clone();
    if config.kind == "go" && matches!(config.args.first().map(String::as_str), Some("mod" | "work")) {
        let previous = sink;
        let root = project.root.clone();
        sink = std::sync::Arc::new(move |event: ide_core::IdeEvent| {
            if matches!(&event, ide_core::IdeEvent::RunExited { .. }) {
                ide_sdk::libraries::invalidate_go(&root);
            }
            previous.emit(event);
        });
    }
    host.processes.start(&project.root, &config, &options, sink, Box::new(move |c| on_output(c)))
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
