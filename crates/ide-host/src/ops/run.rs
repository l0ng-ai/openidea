use super::Emit;
use crate::Host;
use ide_core::remote_settings::RunTargetKind;
use ide_core::{IdeError, IdeResult, RunId};
use ide_run::{OutputChunk, RunConfig, RunInfo, StartOptions};
use std::time::Duration;

/// Detected configs followed by user-defined ones (user ids win on conflict).
pub fn configs(host: &Host, window: &str) -> IdeResult<Vec<RunConfig>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    project_configs(&project.root, &project.settings.effective(), &host.config_dir)
}

pub(super) fn project_configs(
    root: &std::path::Path,
    settings: &ide_core::settings::Settings,
    config_dir: &std::path::Path,
) -> IdeResult<Vec<RunConfig>> {
    let user = ide_run::load_user_configs(root)?;
    let root_suppressed = ide_run::load_suppressed_config_ids(root)?;
    let mut all = detected_and_saved(root, settings, &user, &root_suppressed);
    if let Some(workspace) = ide_workspace::workspace::Workspace::load(root)? {
        for member in workspace.projects.into_iter().filter(|p| p.is_dir()) {
            let settings = ide_workspace::SettingsStore::load(config_dir, Some(&member)).effective();
            let saved = ide_run::load_user_configs(&member)?;
            let suppressed = ide_run::load_suppressed_config_ids(&member)?;
            let configs = detected_and_saved(&member, &settings, &saved, &suppressed);
            let key = crate::project::project_key(&member);
            let name = member.file_name().unwrap_or_default().to_string_lossy();
            for mut config in configs {
                for task in &mut config.extras.before_launch {
                    if matches!(task.kind.as_str(), "run" | "build") && !task.target.is_empty() {
                        task.target = format!("workspace:{}:{}", key, task.target);
                    }
                }
                for id in &mut config.extras.compound {
                    *id = format!("workspace:{key}:{id}");
                }
                config.id = format!("workspace:{}:{}", key, config.id);
                config.name = format!("{name} / {}", config.name);
                ide_run::scope::rebase(&mut config, &member, None);
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
/// its saved ones; toolchains from Languages & Frameworks applied. Build-tool choices stay as saved:
/// derived defaults must not be written back as explicit environment.
fn detected_and_saved(
    root: &std::path::Path,
    settings: &ide_core::settings::Settings,
    saved: &[RunConfig],
    suppressed: &[String],
) -> Vec<RunConfig> {
    let excluded_poms = crate::project::unlinked_maven_poms(root, settings);
    let gradle = settings
        .languages
        .java
        .gradle
        .linked_projects
        .as_ref()
        .map(|_| ide_build::gradle::load_linked(root, &settings.languages.java.gradle));
    let mut all: Vec<RunConfig> =
        ide_run::detect_with_profiles(root, &excluded_poms, settings.cmake.profiles.as_deref())
            .into_iter()
            .filter(|d| !suppressed.contains(&d.id) && !saved.iter().any(|u| u.id == d.id))
            .filter(|d| linked_config(root, gradle.as_deref(), &excluded_poms, d))
            .collect();
    all.extend(saved.iter().cloned());
    for config in all.iter_mut().filter(|c| !matches!(c.kind.as_str(), "gradle" | "maven")) {
        ide_sdk::apply::apply_to_run_configs(std::slice::from_mut(config), root, settings);
    }
    all
}

fn linked_config(
    root: &std::path::Path,
    gradle: Option<&[ide_build::GradleModel]>,
    excluded_poms: &[std::path::PathBuf],
    config: &RunConfig,
) -> bool {
    let module = config
        .extras
        .module
        .as_deref()
        .map(std::path::Path::new)
        .or(config.cwd.as_deref())
        .unwrap_or(std::path::Path::new(""));
    let owner = ide_core::project_roots::resolve(root, module);
    if matches!(config.kind.as_str(), "maven" | "application" | "spring-boot")
        && excluded_poms.iter().any(|pom| ide_core::project_roots::resolve(root, pom).parent() == Some(owner.as_path()))
    {
        return false;
    }
    if gradle.is_some()
        && (config.kind == "gradle"
            || (matches!(config.kind.as_str(), "application" | "spring-boot")
                && ["build.gradle", "build.gradle.kts"].iter().any(|name| owner.join(name).is_file())))
    {
        return gradle.unwrap_or_default().iter().any(|build| {
            if config.kind == "gradle" {
                root.join(&build.dir) == owner
            } else {
                build.projects.iter().any(|p| root.join(&p.dir) == owner)
            }
        });
    }
    true
}

/// Saves the user configurations. They come from [`configs`], toolchains applied, so what
/// settings derived is dropped again: only the user's own choices reach `run.toml`.
pub fn save_configs(
    host: &Host,
    window: &str,
    configs: &[RunConfig],
    removed_detected_ids: &[String],
) -> IdeResult<()> {
    let project = host.project(window)?;
    let settings = project.settings.effective();
    let configs: Vec<RunConfig> = configs
        .iter()
        .map(|c| match c.kind.as_str() {
            "gradle" | "maven" => c.clone(),
            _ => ide_sdk::apply::without_derived(c, &project.root, &settings),
        })
        .collect();
    ide_run::save_user_configs_with_removals(&project.root, &configs, removed_detected_ids)
}

/// The project `config` runs in (a workspace member, by its working directory) and its settings.
fn settings_for(
    host: &Host,
    project: &crate::project::Project,
    config: &mut RunConfig,
) -> IdeResult<(std::path::PathBuf, ide_core::settings::Settings)> {
    let workspace = ide_workspace::workspace::Workspace::load(&project.root)?;
    if workspace.is_some() {
        if config.extras.module.is_none() && !matches!(config.kind.as_str(), "application" | "spring-boot") {
            config.extras.module = config.cwd.as_deref().map(ide_core::ipc_path::to_ipc);
        }
        ide_run::scope::rebase(config, &project.root, None);
    }
    let member = workspace.and_then(|workspace| {
        let owner = ide_run::scope::owner(&project.root, config);
        workspace
            .projects
            .into_iter()
            .filter(|root| owner.starts_with(root))
            .max_by_key(|root| root.components().count())
    });
    Ok(match member {
        Some(root) => {
            let settings = ide_workspace::SettingsStore::load(&host.config_dir, Some(&root)).effective();
            (root, settings)
        }
        None => (project.root.clone(), project.settings.effective()),
    })
}

/// Temporary configurations as they are kept between sessions: without what settings derived
/// (toolchain commands, Maven options, `JAVA_HOME`…), so they follow later settings changes.
pub fn without_derived(host: &Host, window: &str, configs: Vec<RunConfig>) -> IdeResult<Vec<RunConfig>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    configs
        .into_iter()
        .map(|mut c| {
            if c.kind == "gradle" {
                return Ok(c);
            }
            let (root, settings) = settings_for(host, &project, &mut c)?;
            Ok(ide_sdk::apply::without_derived(&c, &root, &settings))
        })
        .collect()
}

/// Kept temporary configurations with today's settings applied, as [`configs`] lists the others.
pub fn apply_settings(host: &Host, window: &str, configs: Vec<RunConfig>) -> IdeResult<Vec<RunConfig>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    configs
        .into_iter()
        .map(|mut c| {
            if c.kind != "gradle" {
                let (root, settings) = settings_for(host, &project, &mut c)?;
                ide_sdk::apply::apply_to_run_configs(std::slice::from_mut(&mut c), &root, &settings);
            }
            Ok(c)
        })
        .collect()
}

pub async fn start(host: &Host, window: &str, config: RunConfig, on_output: Emit<OutputChunk>) -> IdeResult<RunInfo> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    if config.command.is_empty() {
        return Err(IdeError::invalid("run configuration has no command"));
    }
    // Settings › Run Targets: over SSH, or in a container.
    if config.kind == "tomcat" && config.extras.target.as_deref().is_some_and(|t| !t.is_empty()) {
        return Err(IdeError::invalid("Tomcat Local requires the local machine"));
    }
    if let Some(id) = config.extras.target.as_deref().filter(|t| !t.is_empty()) {
        let settings = project.settings.effective();
        let target = ide_remote::service::run_target(&settings, id)?;
        if target.kind != RunTargetKind::Ssh {
            // A local run of the docker CLI: the command is resolved in the container, and
            // this machine's toolchains and `PYTHONPATH` don't apply.
            let config = container::prepare(host, &project.root, target, config).await?;
            let encoding = settings.console.encoding;
            let options = StartOptions {
                encoding: Some(encoding).filter(|e| !e.trim().is_empty()),
                python_paths: Vec::new(),
                // A folder on this machine: not in the container.
                ruby_reporter: None,
            };
            project.require_trust()?;
            return host.processes.start(
                &project.root,
                &config,
                &options,
                project.sink.clone(),
                Box::new(move |c| on_output(c)),
            );
        }
        let out = on_output.clone();
        return host
            .remote
            .run(&settings, &project.root, &config, project.sink.clone(), Box::new(move |c| out(c)))
            .await;
    }
    let mut config = config;
    let (root, settings) = settings_for(host, &project, &mut config)?;
    let root = &root;
    // Configurations made in the UI name bare tools (`godot`) that may live outside PATH.
    // Maven re-applies too: a config listed before a settings change (daemon toggle,
    // Maven home) keeps the launcher that was current then; re-resolving at launch is
    // what makes the setting take effect without reopening the project.
    if config.kind == "maven" {
        ide_sdk::apply::prepare_maven_run(&mut config, root, &settings);
    } else if matches!(config.kind.as_str(), "gradle" | "tomcat") {
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
        python_paths: if *root != project.root { vec![root.clone()] } else { super::python::paths(&project) },
        ruby_reporter: ruby_reporter_dir(host, &config),
    };
    project.require_trust()?;
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

/// The Ruby test reporter's directory, installed on demand, for runs that take it.
fn ruby_reporter_dir(host: &Host, config: &RunConfig) -> Option<std::path::PathBuf> {
    if !ide_run::ruby_reporter::applies(config) {
        return None;
    }
    let dir = host.local_data_dir.join("ruby-reporter");
    match ide_run::ruby_reporter::install(&dir) {
        Ok(()) => Some(dir),
        Err(e) => {
            tracing::warn!("cannot install the Ruby test reporter in {}: {e}", dir.display());
            None
        }
    }
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
mod container;
pub use commands::*;

#[cfg(test)]
mod ownership_tests {
    use super::*;
    #[test]
    fn unlinked_builds_do_not_reappear_as_detected_application_configs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for name in ["maven", "gradle"] {
            let dir = root.join(name);
            std::fs::create_dir_all(dir.join("src/main/java")).unwrap();
            std::fs::write(
                dir.join("src/main/java/App.java"),
                "@SpringBootApplication class App { public static void main(String[] a) {} }",
            )
            .unwrap();
        }
        std::fs::write(root.join("maven/pom.xml"), "<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>").unwrap();
        std::fs::write(root.join("gradle/build.gradle.kts"), "plugins { id(\"org.springframework.boot\") }").unwrap();
        let defaults = detected_and_saved(root, &Default::default(), &[], &[]);
        assert!(defaults.iter().any(|c| c.kind == "spring-boot"));
        let mut settings = ide_core::settings::Settings::default();
        settings.languages.java.maven.unlinked_projects = vec!["maven/pom.xml".into()];
        settings.languages.java.gradle.linked_projects = Some(vec![]);
        let configs = detected_and_saved(root, &settings, &[], &[]);
        assert!(configs.is_empty(), "{configs:?}");
    }
}
