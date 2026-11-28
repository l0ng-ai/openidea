//! Interpreters / toolchains (`ide-sdk`): discovery, Python virtualenvs and packages.
use super::{blocking, blocking_value, join_error};
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
    blocking_value(move || {
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
    blocking_value(move || {
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
}

/// An existing Python executable or virtualenv folder as an SDK; `None` if Python cannot run.
#[command(trust = outside_restricted)]
pub async fn sdk_python_interpreter(host: &Host, window: &str, path: PathBuf) -> IdeResult<Option<Sdk>> {
    host.require_trust_if_project(window)?;
    let root = host.project(window).ok().map(|p| p.root.clone());
    blocking(move || Ok(ide_sdk::python_interpreter_sdk(&path, root.as_deref()))).await
}

/// `sys.path` of the interpreter `python`, for All Interpreters › Show Paths.
#[command(trust = outside_restricted)]
pub async fn sdk_python_sys_path(
    host: &Host,
    window: &str,
    python: PathBuf,
    request: RequestId,
) -> IdeResult<Vec<ide_core::IpcPath>> {
    host.require_trust_if_project(window)?;
    let cancel = host.begin_project_request(window, request);
    let result = blocking(move || {
        let paths = ide_sdk::libraries::python_sys_path(&python, &cancel);
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let paths = paths.ok_or_else(|| {
            IdeError::invalid(format!(
                "Cannot read sys.path of {}: the interpreter failed or did not answer in time",
                python.display()
            ))
        })?;
        Ok(paths.iter().map(|p| p.as_path().into()).collect())
    })
    .await;
    host.end_request(request);
    result
}

/// For each folder added to an interpreter's paths, why it stays off the import path
/// (`None`: it is used). The folders may not be saved yet.
#[command(trust = outside_restricted)]
pub async fn sdk_python_user_path_problems(
    host: &Host,
    window: &str,
    paths: Vec<String>,
) -> IdeResult<Vec<Option<ide_sdk::apply::UserPathProblem>>> {
    host.require_trust_if_project(window)?;
    blocking_value(move || paths.iter().map(|p| ide_sdk::apply::user_path(p).err()).collect()).await
}

/// The interpreter of the workspace member `near` belongs to, else the project's.
pub(crate) fn effective_python(
    config_dir: &std::path::Path,
    project: &crate::Project,
    near: Option<&std::path::Path>,
) -> Option<PathBuf> {
    let project_root = &project.root;
    let member = ide_workspace::workspace::Workspace::load(project_root).ok().flatten().and_then(|w| {
        let near = near?;
        w.projects.into_iter().filter(|root| near.starts_with(root)).max_by_key(|root| root.components().count())
    });
    let (root, settings) = match member {
        Some(root) => {
            let settings = ide_workspace::SettingsStore::load(config_dir, Some(&root)).effective();
            (root, settings)
        }
        None => (project_root.clone(), project.settings.effective()),
    };
    // A member with no Python of its own falls back to the primary project's
    // (the same chain run configurations use), so every answer names one interpreter.
    ide_sdk::apply::python_interpreter_near(&root, near, &settings).or_else(|| {
        (&root != project_root)
            .then(|| ide_sdk::apply::python_interpreter(project_root, &project.settings.effective()))
            .flatten()
    })
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
    let config_dir = host.config_dir.clone();
    // Loading a member's settings needs more stack than a sync command's main thread has left.
    blocking(move || Ok(effective_python(&config_dir, &project, near.as_deref()).map(Into::into))).await
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
    blocking(move || ide_sdk::php::xdebug(&php, cwd.as_deref())).await
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
    blocking_value(move || {
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
    blocking_value(move || {
        ide_sdk::php::composer_install(&path, &root)
            .map(|(root, reason)| ComposerInstallState { root: ide_core::IpcPath::from(root), reason })
    })
    .await
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
        ide_sdk::libraries::merge_groups([libraries.map_err(join_error)?, dependencies.map_err(join_error)?].concat());
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
    blocking_value(move || LocatedTools {
        tools: ide_sdk::locate::locate_tools(&names, near.as_deref()),
        compile_dir: ide_sdk::locate::compile_dir().into(),
    })
    .await
}

/// The environments the window's project defines for Hatch, `default` first (hatch must be on PATH).
#[command(trust = outside_restricted)]
pub async fn sdk_python_hatch_envs(host: &Host, window: &str, request: RequestId) -> IdeResult<Vec<String>> {
    host.require_trust_if_project(window)?;
    let root = host.project(window)?.root.clone();
    let cancel = host.begin_project_request(window, request);
    let result = blocking(move || ide_sdk::python::hatch_envs(&root, &cancel)).await;
    host.end_request(request);
    result
}

/// Creates a Python environment and streams its output through `on_output`.
/// With Pipenv, `install_packages` also installs the packages declared in the project's `Pipfile`.
/// With venv / uv, `system_site_packages` lets the environment see the base interpreter's packages.
#[allow(clippy::too_many_arguments)]
#[command(trust = outside_restricted)]
pub async fn sdk_python_create_venv(
    host: &Host,
    window: &str,
    tool: ide_sdk::python::VenvTool,
    base: PathBuf,
    location: PathBuf,
    install_packages: bool,
    system_site_packages: bool,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<Sdk> {
    host.require_trust_if_project(window)?;
    let cancel = host.begin_project_request(window, request);
    let result = blocking(move || {
        ide_sdk::python::create_venv(tool, &base, &location, install_packages, system_site_packages, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await;
    host.end_request(request);
    result
}

#[command(trust = outside_restricted)]
pub async fn sdk_python_packages(
    host: &Host,
    window: &str,
    python: PathBuf,
    outdated: bool,
    request: RequestId,
) -> IdeResult<Vec<PythonPackage>> {
    host.require_trust_if_project(window)?;
    let cancel = host.begin_project_request(window, request);
    let result = blocking(move || ide_sdk::python::list_packages(&python, outdated, &cancel)).await;
    host.end_request(request);
    result
}

/// A package index other than PyPI that installing from `python` uses; `None` for PyPI.
#[command(trust = outside_restricted)]
pub async fn sdk_python_package_index(
    host: &Host,
    window: &str,
    python: PathBuf,
    request: RequestId,
) -> IdeResult<Option<String>> {
    host.require_trust_if_project(window)?;
    let project_root = host.project(window).ok().map(|p| p.root.clone());
    let cancel = host.begin_project_request(window, request);
    let result = blocking(move || ide_sdk::python::configured_index(&python, project_root.as_deref(), &cancel)).await;
    host.end_request(request);
    result
}

/// Installs (`uninstall = false`, in editable mode with `editable`) or removes a package; output
/// streams through `on_output`.
#[allow(clippy::too_many_arguments)]
#[command(trust = outside_restricted)]
pub async fn sdk_python_pip(
    host: &Host,
    window: &str,
    python: PathBuf,
    requirement: String,
    uninstall: bool,
    upgrade: bool,
    editable: bool,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<()> {
    host.require_trust_if_project(window)?;
    let project_root = host.project(window).ok().map(|p| p.root.clone());
    let cancel = host.begin_project_request(window, request);
    let result = blocking(move || {
        let send = |line: String| {
            let _ = on_output.send(line);
        };
        if uninstall {
            ide_sdk::python::uninstall_package(&python, &requirement, &cancel, &send)
        } else {
            ide_sdk::python::install_package(
                &python,
                &requirement,
                upgrade,
                editable,
                project_root.as_deref(),
                &cancel,
                &send,
            )
        }
    })
    .await;
    host.end_request(request);
    result
}

/// The JDK whose home is `path`, as the SDK list shows it; `None` when it is no JDK home.
#[command(trust = trusted)]
pub async fn sdk_jdk_at(path: String) -> IdeResult<Option<Sdk>> {
    // A macOS bundle too (Add JDK from Disk…).
    blocking_value(move || ide_sdk::java::jdk_at(std::path::Path::new(&path)).map(|j| ide_sdk::jdk_sdk(&j))).await
}

/// `flutter --version --machine` of the Flutter SDK at `path`, or of the `flutter` on the
/// search path when `path` is empty; `None` when there is no Flutter SDK.
#[command(trust = trusted)]
pub async fn sdk_flutter_at(
    host: &Host,
    window: &str,
    path: String,
) -> IdeResult<Option<ide_sdk::flutter::FlutterVersion>> {
    let root = host.project(window).ok().map(|p| p.root.clone());
    blocking_value(move || {
        let root = root.unwrap_or_default();
        let sdk = match ide_sdk::apply::setting_path(&root, &path) {
            Some(sdk) => Some(sdk),
            None => ide_core::tool_path::find_command("flutter", &ide_core::tool_path::search_path_in(&root), &root)
                .and_then(|f| ide_sdk::flutter::sdk_of(&f)),
        };
        sdk.and_then(|sdk| ide_sdk::flutter::version(&sdk))
    })
    .await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::HostConfig;
    use std::path::Path;

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
    async fn a_launch_takes_the_user_paths_of_the_interpreter_it_uses() {
        use crate::ops::python::{debug_python, with_user_paths};
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let (root, bare, own) = (base.join("project"), base.join("bare"), base.join("own"));
        let (for_main, for_own) = (base.join("for-main"), base.join("for-own"));
        for dir in [&root, &bare, &own, &for_main, &for_own] {
            std::fs::create_dir(dir).unwrap();
        }
        let (main_python, own_python) = (fake_venv(&root, ".venv"), fake_venv(&own, ".venv"));
        ide_workspace::workspace::Workspace::attach(&root, "ws", vec![root.clone(), bare.clone(), own.clone()])
            .unwrap();
        let host = Host::new(HostConfig { local_data_dir: base.join("local"), ..HostConfig::for_test(&base) });
        host.trust.decide(&root, true, false).unwrap();
        host.open_project("main", &root).unwrap();
        let project = host.project("main").unwrap();
        let text = |p: &Path| p.to_string_lossy().into_owned();
        project
            .settings
            .set(
                ide_workspace::SettingsScope::Global,
                "languages.python.interpreterPaths",
                serde_json::json!({ text(&main_python): [text(&for_main)], text(&own_python): [text(&for_own)] }),
            )
            .unwrap();
        let paths = |command: Option<&str>, near: &Path| {
            with_user_paths(Vec::new(), &host.config_dir, &project, command, Some(near))
        };

        // A member without a Python of its own runs on the primary project's interpreter;
        // a member with its own virtualenv on that one.
        assert_eq!(paths(None, &root), std::slice::from_ref(&for_main));
        assert_eq!(paths(None, &bare), std::slice::from_ref(&for_main));
        assert_eq!(paths(None, &own), std::slice::from_ref(&for_own));
        // The interpreter a launch names wins over where it runs; a manager's command does not name one.
        assert_eq!(paths(Some(&text(&own_python)), &bare), std::slice::from_ref(&for_own));
        assert_eq!(paths(Some("uv"), &own), std::slice::from_ref(&for_own));
        assert_eq!(paths(Some("python3"), &bare), std::slice::from_ref(&for_main));
        // What is already on the path is neither repeated nor dropped.
        let kept = with_user_paths(vec![root.clone(), for_main.clone()], &host.config_dir, &project, None, Some(&root));
        assert_eq!(kept, [root.clone(), for_main]);

        // Debug resolves a relative command against its working directory before sending it.
        let debug_interpreter = bare.join("..").join(own_python.strip_prefix(&base).unwrap());
        let mut launch = ide_dap::LaunchConfig {
            name: "Python".into(),
            adapter: "debugpy".into(),
            request: "launch".into(),
            program: None,
            args: vec![],
            cwd: Some(bare.as_path().into()),
            env: Default::default(),
            extra_json: Some(serde_json::json!({ "python": text(&debug_interpreter) }).to_string()),
        };
        assert_eq!(debug_python(&launch), Some(text(&debug_interpreter)));
        assert_eq!(paths(debug_python(&launch).as_deref(), &bare), [for_own]);
        launch.extra_json = Some(serde_json::json!({ "python": ["uv", "run", "python"] }).to_string());
        assert_eq!(debug_python(&launch), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_hand_picked_venv_is_resolved_like_a_detected_interpreter() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir(&root).unwrap();
        let host = Host::new(HostConfig { local_data_dir: base.join("local"), ..HostConfig::for_test(&base) });
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

        let host = Host::new(HostConfig { local_data_dir: base.join("local"), ..HostConfig::for_test(&base) });
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
    sdk_flutter_at,
    sdk_jdk_at,
    sdk_locate_tools,
    sdk_php_composer_install,
    sdk_php_effective,
    sdk_php_language_level,
    sdk_php_xdebug,
    sdk_project_libraries,
    sdk_python_create_venv,
    sdk_python_effective,
    sdk_python_hatch_envs,
    sdk_python_interpreter,
    sdk_python_packages,
    sdk_python_package_index,
    sdk_python_pip,
    sdk_python_project_interpreters,
    sdk_python_sys_path,
    sdk_python_user_path_problems,
);
