//! Interpreters / toolchains (`ide-sdk`): discovery, Python virtualenvs and packages.
use crate::Host;
use crate::ops::Channel;
use crate::rpc::Dispatcher;

use ide_core::{IdeError, IdeResult, RequestId};
use ide_sdk::python::PythonPackage;
use ide_sdk::{Sdk, SdkKind};
use std::path::PathBuf;

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

/// Installed interpreters / toolchains of `kind`; project-local ones first.
pub async fn sdk_detect(host: &Host, window: &str, kind: SdkKind) -> IdeResult<Vec<Sdk>> {
    host.require_trust(window)?;
    let project = host.project(window).ok();
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

/// The interpreter `path` picked by hand ("Add Python Interpreter" › Existing) as an SDK, named
/// like the detected ones; `None` when it isn't a usable Python.
pub async fn sdk_python_interpreter(host: &Host, window: &str, path: PathBuf) -> IdeResult<Option<Sdk>> {
    host.require_trust(window)?;
    let root = host.project(window).ok().map(|p| p.root.clone());
    tokio::task::spawn_blocking(move || Ok(ide_sdk::python_interpreter_sdk(&path, root.as_deref())))
        .await
        .map_err(join_err)?
}

/// The interpreter the project uses: the configured one, else its virtualenv.
pub fn sdk_python_effective(host: &Host, window: &str, near: Option<PathBuf>) -> IdeResult<Option<ide_core::IpcPath>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let member = ide_workspace::workspace::Workspace::load(&project.root)?.and_then(|w| {
        let near = near.as_deref()?;
        w.projects.into_iter().filter(|root| near.starts_with(root)).max_by_key(|root| root.components().count())
    });
    let (root, settings) = match member {
        Some(root) => {
            let settings = ide_workspace::SettingsStore::load(&host.config_dir, Some(&root)).effective();
            (root, settings)
        }
        None => (project.root.clone(), project.settings.effective()),
    };
    Ok(ide_sdk::apply::python_interpreter_near(&root, near.as_deref(), &settings).map(Into::into))
}

/// The PHP interpreter chosen in Settings › Languages & Frameworks › PHP; `None`: the `php` on `PATH`.
pub fn sdk_php_effective(host: &Host, window: &str) -> IdeResult<Option<ide_core::IpcPath>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let settings = project.settings.effective();
    Ok(ide_sdk::apply::setting_path(&project.root, &settings.languages.php.interpreter).map(Into::into))
}

/// The version of the PHP interpreter `php` and of the Xdebug it loads, run in `cwd` (default: the
/// project root).
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

/// `None` in an untrusted project too: `composer install` runs the project's scripts.
pub async fn sdk_php_composer_install(
    host: &Host,
    window: &str,
    path: PathBuf,
) -> IdeResult<Option<ComposerInstallState>> {
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
    let libraries = {
        let (root, settings, cancel, on_groups) = (root.clone(), settings.clone(), cancel.clone(), on_groups.clone());
        tokio::task::spawn_blocking(move || {
            ide_sdk::libraries::project_libraries_stream(&root, &settings, &[], &cancel, &|groups| {
                let _ = on_groups.send(groups);
            })
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
    Ok(ide_sdk::libraries::merge_groups([libraries.map_err(join_err)?, dependencies.map_err(join_err)?].concat()))
}

/// Looks up `names` (bare command names): `node_modules/.bin` above `near`, then the search path.
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
pub async fn sdk_python_create_venv(
    host: &Host,
    window: &str,
    tool: ide_sdk::python::VenvTool,
    base: PathBuf,
    location: PathBuf,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<Sdk> {
    host.require_trust(window)?;
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

pub async fn sdk_python_packages(
    host: &Host,
    window: &str,
    python: PathBuf,
    request: RequestId,
) -> IdeResult<Vec<PythonPackage>> {
    host.require_trust(window)?;
    let cancel = host.begin_project_request(window, request);
    let result =
        tokio::task::spawn_blocking(move || ide_sdk::python::list_packages(&python, &cancel)).await.map_err(join_err);
    host.end_request(request);
    result?
}

/// Installs (`uninstall = false`) or removes a package; output streams through `on_output`.
#[allow(clippy::too_many_arguments)]
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
    host.require_trust(window)?;
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

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("sdk_detect", |c| async move { sdk_detect(&c.host, &c.window, c.arg("kind")?).await });
    d.add(
        "sdk_python_interpreter",
        |c| async move { sdk_python_interpreter(&c.host, &c.window, c.arg("path")?).await },
    );
    d.add("sdk_python_effective", |c| async move { sdk_python_effective(&c.host, &c.window, c.arg("near")?) });
    d.add("sdk_php_effective", |c| async move { sdk_php_effective(&c.host, &c.window) });
    d.add("sdk_php_xdebug", |c| async move { sdk_php_xdebug(&c.host, &c.window, c.arg("php")?, c.arg("cwd")?).await });
    d.add(
        "sdk_php_language_level",
        |c| async move { sdk_php_language_level(&c.host, &c.window, c.arg("path")?).await },
    );
    d.add(
        "sdk_php_composer_install",
        |c| async move { sdk_php_composer_install(&c.host, &c.window, c.arg("path")?).await },
    );
    d.add("sdk_project_libraries", |c| async move {
        sdk_project_libraries(&c.host, &c.window, c.arg("request")?, c.sender("onGroups")?).await
    });
    d.add("sdk_locate_tools", |c| async move {
        sdk_locate_tools(&c.host, &c.window, c.arg("names")?, c.arg("near")?).await
    });
    d.add("sdk_python_create_venv", |c| async move {
        sdk_python_create_venv(
            &c.host,
            &c.window,
            c.arg("tool")?,
            c.arg("base")?,
            c.arg("location")?,
            c.arg("request")?,
            c.sender("onOutput")?,
        )
        .await
    });
    d.add("sdk_python_packages", |c| async move {
        sdk_python_packages(&c.host, &c.window, c.arg("python")?, c.arg("request")?).await
    });
    d.add("sdk_python_pip", |c| async move {
        sdk_python_pip(
            &c.host,
            &c.window,
            c.arg("python")?,
            c.arg("requirement")?,
            c.arg("uninstall")?,
            c.arg("upgrade")?,
            c.arg("request")?,
            c.sender("onOutput")?,
        )
        .await
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostConfig;
    use std::path::Path;
    use std::sync::Arc;

    fn fake_venv(root: &Path, name: &str) -> PathBuf {
        let bin = if cfg!(windows) { "Scripts" } else { "bin" };
        let python = if cfg!(windows) { "python.exe" } else { "python" };
        let venv = root.join(name);
        std::fs::create_dir_all(venv.join(bin)).unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), "home = /usr/bin\nversion = 3.12.1\n").unwrap();
        venv.join(bin).join(python)
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
        let sdk = sdk_python_interpreter(&host, "main", fake_venv(&base, "erp19py3.12")).await.unwrap().unwrap();
        assert_eq!((sdk.name.as_str(), sdk.source.as_str()), ("Python 3.12 (erp19py3.12)", "venv"));
        assert!(sdk_python_interpreter(&host, "main", root.join("README.md")).await.unwrap().is_none());
        host.close_project("main");
    }
}
