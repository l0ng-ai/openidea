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
    let root = host.project(window).ok().map(|p| p.root.clone());
    tokio::task::spawn_blocking(move || ide_sdk::detect(kind, root.as_deref())).await.map_err(join_err)
}

/// The interpreter the project uses: the configured one, else its virtualenv.
pub fn sdk_python_effective(host: &Host, window: &str) -> IdeResult<Option<ide_core::IpcPath>> {
    let project = host.project(window)?;
    Ok(ide_sdk::apply::python_interpreter(&project.root, &project.settings.effective()).map(Into::into))
}

/// SDK / library source folders shown under "External Libraries" in the Project view,
/// with the Maven / Gradle dependency jars of the build model.
pub async fn sdk_project_libraries(host: &Host, window: &str) -> IdeResult<Vec<ide_sdk::libraries::LibraryGroup>> {
    let project = host.project(window)?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    tokio::task::spawn_blocking(move || {
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
        ide_sdk::libraries::project_libraries(&root, &settings, &deps)
    })
    .await
    .map_err(join_err)
}

/// Looks up `names` (bare command names): `node_modules/.bin` above `near`, then the search path.
pub async fn sdk_locate_tools(
    _host: &Host,
    _window: &str,
    names: Vec<String>,
    near: Option<PathBuf>,
) -> IdeResult<LocatedTools> {
    tokio::task::spawn_blocking(move || LocatedTools {
        tools: ide_sdk::locate::locate_tools(&names, near.as_deref()),
        compile_dir: ide_sdk::locate::compile_dir().into(),
    })
    .await
    .map_err(join_err)
}

/// `base -m venv location`; output lines stream through `on_output`.
pub async fn sdk_python_create_venv(
    host: &Host,
    _window: &str,
    base: PathBuf,
    location: PathBuf,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<Sdk> {
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        ide_sdk::python::create_venv(&base, &location, &cancel, &|line| {
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
    _window: &str,
    python: PathBuf,
    request: RequestId,
) -> IdeResult<Vec<PythonPackage>> {
    let cancel = host.begin_request(request);
    let result =
        tokio::task::spawn_blocking(move || ide_sdk::python::list_packages(&python, &cancel)).await.map_err(join_err);
    host.end_request(request);
    result?
}

/// Installs (`uninstall = false`) or removes a package; output streams through `on_output`.
#[allow(clippy::too_many_arguments)]
pub async fn sdk_python_pip(
    host: &Host,
    _window: &str,
    python: PathBuf,
    requirement: String,
    uninstall: bool,
    upgrade: bool,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let send = |line: String| {
            let _ = on_output.send(line);
        };
        if uninstall {
            ide_sdk::python::uninstall_package(&python, &requirement, &cancel, &send)
        } else {
            ide_sdk::python::install_package(&python, &requirement, upgrade, &cancel, &send)
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
    d.add("sdk_python_effective", |c| async move { sdk_python_effective(&c.host, &c.window) });
    d.add("sdk_project_libraries", |c| async move { sdk_project_libraries(&c.host, &c.window).await });
    d.add("sdk_locate_tools", |c| async move {
        sdk_locate_tools(&c.host, &c.window, c.arg("names")?, c.arg("near")?).await
    });
    d.add("sdk_python_create_venv", |c| async move {
        sdk_python_create_venv(
            &c.host,
            &c.window,
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
