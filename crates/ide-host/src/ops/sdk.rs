//! Interpreters / toolchains (`ide-sdk`): discovery, Python virtualenvs and packages.
use crate::Host;
use crate::ops::Channel;
use ide_command::command;

use ide_core::{IdeError, IdeResult, RequestId};
use ide_sdk::python::PythonPackage;
use ide_sdk::{Sdk, SdkKind};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

pub mod container_python;
pub use container_python::{ContainerPython, sdk_container_python, sdk_container_python_refresh};

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

/// Executables found for "run this file", and where single files are compiled to.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocatedTools {
    pub tools: Vec<ide_sdk::locate::LocatedTool>,
    pub compile_dir: ide_core::IpcPath,
}

/// An interpreter another project uses: the project root and the SDK itself.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInterpreter {
    pub project: ide_core::IpcPath,
    pub sdk: Sdk,
}

/// Installed interpreters / toolchains of `kind`; project-local ones first.
#[command(trust = outside_restricted)]
pub async fn sdk_detect(host: &Host, window: &str, kind: SdkKind) -> IdeResult<Vec<Sdk>> {
    host.require_trust_if_project(window)?;
    let project = host.project(window).ok();
    if kind == SdkKind::Jdk {
        host.apply_added_jdks();
    }
    let root = project.as_ref().map(|p| p.root.clone());
    // The interpreter the project uses is a choice even where detection doesn't look (a
    // virtualenv in a subfolder, one picked by path), so it shows by name and version.
    let current = match (&project, kind) {
        (Some(p), SdkKind::Python) => ide_sdk::apply::python_interpreter(&p.root, &p.settings.effective()),
        _ => None,
    };
    tokio::task::spawn_blocking(move || {
        let mut sdks = ide_sdk::detect(kind, root.as_deref());
        if let Some(path) = current
            && !sdks.iter().any(|s| *s.path == *path)
            && let Some(sdk) = ide_sdk::python_interpreter_sdk(&path, root.as_deref())
        {
            sdks.push(sdk);
        }
        sdks
    })
    .await
    .map_err(join_err)
}

/// The Python interpreters of the recently opened projects, each with its project.
#[command(trust = outside_restricted)]
pub async fn sdk_python_project_interpreters(host: &Host, window: &str) -> IdeResult<Vec<ProjectInterpreter>> {
    // Newest first. The open project is skipped: `sdk_detect` lists its own.
    host.require_trust_if_project(window)?;
    let current = host.project(window).ok().map(|p| p.root.clone());
    let config = host.config_dir.clone();
    // Probing runs the project's interpreter (and its settings may name any program): only
    // projects trusted in their own right, not ones last opened in Restricted Mode.
    let roots: Vec<PathBuf> = ide_workspace::RecentProjects::load(&config)
        .list()
        .into_iter()
        .map(|p| p.path.into_path_buf())
        .filter(|root| current.as_deref() != Some(root.as_path()))
        .filter(|root| host.trust.window_trusted(root).unwrap_or(false))
        .collect();
    tokio::task::spawn_blocking(move || {
        // Each project resolves its configured interpreter, else its own virtualenv. The
        // probes run `python`, so keep them off the async runtime and bound how many run at
        // once: the recent list can hold ~30 projects, and each probe starts a process.
        const PROBES: usize = 4;
        let results = Mutex::new(Vec::with_capacity(roots.len()));
        let next = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..roots.len().min(PROBES) {
                scope.spawn(|| {
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(root) = roots.get(index) else { break };
                        let settings = ide_workspace::SettingsStore::load(&config, Some(root)).effective();
                        let Some(python) = ide_sdk::apply::python_interpreter(root, &settings) else { continue };
                        let Some(sdk) = ide_sdk::python_interpreter_sdk(&python, Some(root)) else { continue };
                        results
                            .lock()
                            .unwrap()
                            .push((index, ProjectInterpreter { project: root.as_path().into(), sdk }));
                    }
                });
            }
        });
        let mut found = results.into_inner().unwrap();
        found.sort_by_key(|(index, _)| *index);
        found.into_iter().map(|(_, interpreter)| interpreter).collect()
    })
    .await
    .map_err(join_err)
}

/// An existing Python executable or virtualenv folder as an SDK; `None` if Python cannot run.
#[command(trust = outside_restricted)]
pub async fn sdk_python_interpreter(host: &Host, window: &str, path: PathBuf) -> IdeResult<Option<Sdk>> {
    host.require_trust_if_project(window)?;
    let root = host.project(window).ok().map(|p| p.root.clone());
    tokio::task::spawn_blocking(move || Ok(ide_sdk::python_interpreter_sdk(&path, root.as_deref())))
        .await
        .map_err(join_err)?
}

/// The interpreter the project uses: the configured one, else its virtualenv.
#[command(trust = trusted)]
pub async fn sdk_python_effective(
    host: &Host,
    window: &str,
    near: Option<PathBuf>,
) -> IdeResult<Option<ide_core::IpcPath>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (config_dir, project_root) = (host.config_dir.clone(), project.root.clone());
    // Loading a member's settings needs more stack than a sync command's main thread has left.
    tokio::task::spawn_blocking(move || {
        let member = ide_workspace::workspace::Workspace::load(&project_root).ok().flatten().and_then(|w| {
            let near = near.as_deref()?;
            w.projects.into_iter().filter(|root| near.starts_with(root)).max_by_key(|root| root.components().count())
        });
        let (root, settings) = match member {
            Some(root) => {
                let settings = ide_workspace::SettingsStore::load(&config_dir, Some(&root)).effective();
                (root, settings)
            }
            None => (project_root.clone(), project.settings.effective()),
        };
        // A member with no Python of its own falls back to the primary project's
        // (the same chain run configurations use), so every answer names one interpreter.
        let interpreter = ide_sdk::apply::python_interpreter_near(&root, near.as_deref(), &settings).or_else(|| {
            (root != project_root)
                .then(|| ide_sdk::apply::python_interpreter(&project_root, &project.settings.effective()))
                .flatten()
        });
        Ok(interpreter.map(Into::into))
    })
    .await
    .map_err(join_err)?
}

/// The PHP interpreter chosen in Settings › Languages & Frameworks › PHP; `None`: the `php` on `PATH`.
#[command(trust = trusted)]
pub fn sdk_php_effective(host: &Host, window: &str) -> IdeResult<Option<ide_core::IpcPath>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let settings = project.settings.effective();
    Ok(ide_sdk::apply::setting_path(&project.root, &settings.languages.php.interpreter).map(Into::into))
}

/// The version of the PHP interpreter `php` and of the Xdebug it loads, run in `cwd` (default: the
/// project root).
#[command(trust = trusted)]
pub async fn sdk_php_xdebug(
    host: &Host,
    window: &str,
    php: PathBuf,
    cwd: Option<PathBuf>,
) -> IdeResult<ide_sdk::php::PhpXdebug> {
    host.require_trust(window)?;
    let cwd = cwd.or_else(|| host.project(window).ok().map(|p| p.root.clone()));
    tokio::task::spawn_blocking(move || ide_sdk::php::xdebug(&php, cwd.as_deref())).await.map_err(join_err)?
}

/// The PHP language level of the project `path` belongs to (a workspace member, by path, as
/// the language server configuration picks it).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PhpLanguageLevels {
    /// The one Intelephense checks against; `None`: its default.
    pub effective: Option<ide_sdk::php::PhpLanguageLevel>,
    /// The one Auto picks, from `composer.json`.
    pub auto: Option<ide_sdk::php::PhpLanguageLevel>,
    /// The workspace member `path` belongs to: its own settings choose the level, not the
    /// workspace's. `None`: the opened project.
    pub member: Option<ide_core::IpcPath>,
}

/// The PHP language level of the project `path` belongs to: the effective one and Auto's.
#[command(trust = trusted)]
pub async fn sdk_php_language_level(host: &Host, window: &str, path: PathBuf) -> IdeResult<PhpLanguageLevels> {
    let project = host.project(window)?;
    let (project_root, project_settings) = (project.root.clone(), project.settings.effective());
    let config_dir = host.config_dir.clone();
    tokio::task::spawn_blocking(move || {
        let member = ide_workspace::workspace::Workspace::load(&project_root).ok().flatten().and_then(|w| {
            w.projects.into_iter().filter(|p| path.starts_with(p)).max_by_key(|p| p.components().count())
        });
        let (root, settings) = match &member {
            Some(member) => (member, ide_workspace::SettingsStore::load(&config_dir, Some(member)).effective()),
            None => (&project_root, project_settings),
        };
        PhpLanguageLevels {
            effective: ide_sdk::php::language_level(root, &settings),
            auto: ide_sdk::php::composer_level(root),
            member: member.map(ide_core::IpcPath),
        }
    })
    .await
    .map_err(join_err)
}

/// The Composer project `path` belongs to, when its dependencies need `composer install`.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ComposerInstallState {
    pub root: ide_core::IpcPath,
    pub reason: ide_sdk::php::ComposerInstall,
}

/// The Composer project `path` belongs to, when its dependencies need `composer install`.
#[command(trust = trusted)]
pub async fn sdk_php_composer_install(
    host: &Host,
    window: &str,
    path: PathBuf,
) -> IdeResult<Option<ComposerInstallState>> {
    // `None` in an untrusted project too: `composer install` runs the project's scripts.
    let project = host.project(window)?;
    if !project.is_trusted() {
        return Ok(None);
    }
    let root = project.root.clone();
    tokio::task::spawn_blocking(move || {
        ide_sdk::php::composer_install(&path, &root)
            .map(|(root, reason)| ComposerInstallState { root: ide_core::IpcPath::from(root), reason })
    })
    .await
    .map_err(join_err)
}

/// SDK / library source folders shown under "External Libraries" in the Project view,
/// with the Maven / Gradle dependency jars of the build model.
#[command(trust = trusted)]
pub async fn sdk_project_libraries(
    host: &Host,
    window: &str,
    request: RequestId,
    on_groups: Channel<Vec<ide_sdk::libraries::LibraryGroup>>,
) -> IdeResult<Vec<ide_sdk::libraries::LibraryGroup>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    let cancel = host.begin_project_request(window, request);
    let container = container_python::library_group(host, &root, &settings);
    let libraries = {
        let (root, settings, cancel, on_groups) = (root.clone(), settings.clone(), cancel.clone(), on_groups.clone());
        tokio::task::spawn_blocking(move || {
            if let Some(group) = &container {
                let _ = on_groups.send(vec![group.clone()]);
            }
            let groups = ide_sdk::libraries::project_libraries_stream(&root, &settings, &[], &cancel, &|groups| {
                let _ = on_groups.send(groups);
            });
            container.into_iter().chain(groups).collect::<Vec<_>>()
        })
    };
    let dependencies = {
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            if cancel.is_cancelled() {
                return Vec::new();
            }
            let model = crate::ops::build::load(&root, &cache, &settings);
            let deps: Vec<ide_sdk::libraries::BuildDependency> = ide_build::dependency_coordinates(&root, &model)
                .into_iter()
                .map(|c| ide_sdk::libraries::BuildDependency {
                    gradle: c.gradle,
                    group: c.group_id,
                    artifact: c.artifact_id,
                    version: c.version,
                })
                .collect();
            if cancel.is_cancelled() {
                return Vec::new();
            }
            let groups = ide_sdk::libraries::dependency_groups(&root, &settings, &deps);
            if !cancel.is_cancelled() {
                let _ = on_groups.send(groups.clone());
            }
            groups
        })
    };
    let (libraries, dependencies) = tokio::join!(libraries, dependencies);
    host.end_request(request);
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let groups =
        ide_sdk::libraries::merge_groups([libraries.map_err(join_err)?, dependencies.map_err(join_err)?].concat());
    if host.project(window).is_ok_and(|current| std::sync::Arc::ptr_eq(&current, &project)) {
        host.mcp_reports
            .set_libraries(window, groups.iter().flat_map(|g| g.roots.iter().map(|r| r.path.0.clone())).collect());
    }
    Ok(groups)
}

/// Looks up `names` (bare command names): `node_modules/.bin` above `near`, then the search path.
#[command(trust = trusted)]
pub async fn sdk_locate_tools(
    host: &Host,
    window: &str,
    names: Vec<String>,
    near: Option<PathBuf>,
) -> IdeResult<LocatedTools> {
    host.require_trust(window)?;
    tokio::task::spawn_blocking(move || LocatedTools {
        tools: ide_sdk::locate::locate_tools(&names, near.as_deref()),
        compile_dir: ide_sdk::locate::compile_dir().into(),
    })
    .await
    .map_err(join_err)
}

/// Creates a Python environment with `tool` (`venv` / `uv` / `poetry`); output streams through `on_output`.
#[command(trust = outside_restricted)]
pub async fn sdk_python_create_venv(
    host: &Host,
    window: &str,
    tool: ide_sdk::python::VenvTool,
    base: PathBuf,
    location: PathBuf,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<Sdk> {
    host.require_trust_if_project(window)?;
    let cancel = host.begin_project_request(window, request);
    let result = tokio::task::spawn_blocking(move || {
        ide_sdk::python::create_venv(tool, &base, &location, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result?
}

#[command(trust = outside_restricted)]
pub async fn sdk_python_packages(
    host: &Host,
    window: &str,
    python: PathBuf,
    request: RequestId,
) -> IdeResult<Vec<PythonPackage>> {
    host.require_trust_if_project(window)?;
    let cancel = host.begin_project_request(window, request);
    let result =
        tokio::task::spawn_blocking(move || ide_sdk::python::list_packages(&python, &cancel)).await.map_err(join_err);
    host.end_request(request);
    result?
}

/// Installs (`uninstall = false`) or removes a package; output streams through `on_output`.
#[allow(clippy::too_many_arguments)]
#[command(trust = outside_restricted)]
pub async fn sdk_python_pip(
    host: &Host,
    window: &str,
    python: PathBuf,
    requirement: String,
    uninstall: bool,
    upgrade: bool,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<()> {
    host.require_trust_if_project(window)?;
    let project_root = host.project(window).ok().map(|p| p.root.clone());
    let cancel = host.begin_project_request(window, request);
    let result = tokio::task::spawn_blocking(move || {
        let send = |line: String| {
            let _ = on_output.send(line);
        };
        if uninstall {
            ide_sdk::python::uninstall_package(&python, &requirement, &cancel, &send)
        } else {
            ide_sdk::python::install_package(&python, &requirement, upgrade, project_root.as_deref(), &cancel, &send)
        }
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result?
}

/// The JDK whose home is `path`, as the SDK list shows it; `None` when it is no JDK home.
#[command(trust = trusted)]
pub async fn sdk_jdk_at(path: String) -> IdeResult<Option<Sdk>> {
    // A macOS bundle too (Add JDK from Disk…).
    tokio::task::spawn_blocking(move || {
        ide_sdk::java::jdk_at(std::path::Path::new(&path)).map(|j| ide_sdk::jdk_sdk(&j))
    })
    .await
    .map_err(join_err)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::HostConfig;
    use std::path::Path;
    use std::sync::Arc;

    fn fake_venv(root: &Path, name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let venv = root.join(name);
        std::fs::create_dir_all(venv.join("bin")).unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), "home = /usr/bin\nversion = 3.12.1\n").unwrap();
        let python = venv.join("bin/python");
        std::fs::write(&python, "#!/bin/sh\necho 3.12.1\n").unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        python
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_hand_picked_venv_is_resolved_like_a_detected_interpreter() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir(&root).unwrap();
        let host = Host::new(HostConfig {
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
        host.trust.decide(&root, true, false).unwrap();
        host.open_project("main", &root).unwrap();

        let sdk = sdk_python_interpreter(&host, "main", fake_venv(&root, ".venv")).await.unwrap().unwrap();
        assert_eq!((sdk.name.as_str(), sdk.source.as_str()), ("Python 3.12 (project)", "venv"));
        let python = fake_venv(&base, "erp19py3.12");
        let sdk = sdk_python_interpreter(&host, "main", python.parent().unwrap().parent().unwrap().into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!((sdk.name.as_str(), sdk.source.as_str()), ("Python 3.12 (erp19py3.12)", "venv"));
        assert_eq!(&*sdk.path, python.as_path());
        host.project("main")
            .unwrap()
            .settings
            .set(
                ide_workspace::SettingsScope::Project,
                "languages.python.interpreter",
                serde_json::to_value(&sdk.path).unwrap(),
            )
            .unwrap();
        host.close_project("main");
        host.open_project("main", &root).unwrap();
        let detected = sdk_detect(&host, "main", SdkKind::Python).await.unwrap();
        assert!(detected.iter().any(|s| s.path == sdk.path && s.name == sdk.name));
        assert_eq!(sdk_python_effective(&host, "main", None).await.unwrap(), Some(sdk.path));
        assert!(sdk_python_interpreter(&host, "main", root.join("README.md")).await.unwrap().is_none());
        host.close_project("main");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn another_projects_interpreter_is_listed_with_its_project() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        let other = base.join("shop");
        std::fs::create_dir_all(other.join(".openidea")).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let python = fake_venv(&other, ".venv");
        std::fs::write(
            other.join(".openidea/settings.toml"),
            "[languages.python]\ninterpreter = \".venv/bin/python\"\n",
        )
        .unwrap();
        // The projects the user opened before this one.
        let config = base.join("config");
        std::fs::create_dir_all(&config).unwrap();
        let recent = serde_json::json!([
            { "path": other.to_str().unwrap(), "name": "shop", "openedAtMs": 2.0, "branch": null },
            { "path": root.to_str().unwrap(), "name": "project", "openedAtMs": 1.0, "branch": null },
        ]);
        std::fs::write(config.join("recent.json"), serde_json::to_vec(&recent).unwrap()).unwrap();

        let host = Host::new(HostConfig {
            config_dir: config,
            data_dir: base.join("data"),
            local_data_dir: base.join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        host.trust.decide(&root, true, false).unwrap();
        host.open_project("main", &root).unwrap();

        // A project last opened in Restricted Mode: its interpreter is never run.
        host.trust.decide(&other, false, false).unwrap();
        assert!(sdk_python_project_interpreters(&host, "main").await.unwrap().is_empty());
        host.trust.decide(&other, true, false).unwrap();
        let list = sdk_python_project_interpreters(&host, "main").await.unwrap();
        assert_eq!(list.len(), 1, "{list:?}");
        assert_eq!(&*list[0].project, other.as_path());
        assert_eq!(&*list[0].sdk.path, python.as_path());
        assert_eq!(list[0].sdk.name, "Python 3.12 (shop)");
        host.close_project("main");
    }
}

ide_command::domain!(
    sdk:
    sdk_detect,
    sdk_jdk_at,
    sdk_locate_tools,
    sdk_php_composer_install,
    sdk_php_effective,
    sdk_php_language_level,
    sdk_php_xdebug,
    sdk_project_libraries,
    sdk_python_create_venv,
    sdk_python_effective,
    sdk_python_interpreter,
    sdk_python_packages,
    sdk_python_pip,
    sdk_python_project_interpreters,
);
