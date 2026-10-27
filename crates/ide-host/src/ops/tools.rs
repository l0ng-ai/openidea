//! Language server / debug adapter installer and JDK downloads (`ide-tools`).
use crate::Host;
use crate::ops::Channel;
use crate::rpc::Dispatcher;

use ide_core::{IdeError, IdeResult, RequestId};
use ide_sdk::Sdk;
use ide_tools::jdk::{JdkReleases, JdkVendor};
use ide_tools::{InstallEvent, ToolInfo, Tools};
use std::path::PathBuf;

/// The installer, reporting the executables chosen in the window's settings.
fn tools(host: &Host, window: &str) -> IdeResult<Tools> {
    let data = host.data_dir.clone();
    let (settings, root) = match host.project(window) {
        Ok(project) => (project.settings.effective(), project.root.clone()),
        Err(_) => (host.global_settings.effective(), Default::default()),
    };
    let custom = settings
        .tools
        .iter()
        .filter_map(|(command, t)| Some((command.clone(), ide_sdk::apply::setting_path(&root, &t.path)?)))
        .collect();
    // Godot is usually an app bundle / Flatpak outside the search path.
    let found = ide_sdk::godot::find(None).map(|p| (ide_sdk::godot::COMMAND.to_owned(), p));
    Ok(Tools::new(&data).with_custom_paths(custom).with_found_paths(found.into_iter().collect()))
}

/// The language definitions plus the servers defined in the window's settings.
fn languages(host: &Host, window: &str) -> Vec<ide_language::LanguageConfig> {
    let settings = match host.project(window) {
        Ok(project) => project.settings.effective(),
        Err(_) => host.global_settings.effective(),
    };
    let mut langs = host.languages.all();
    ide_sdk::apply::with_custom_servers(&mut langs, &settings);
    langs
}

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

fn reconfigure_servers(host: &Host) {
    for project in host.projects() {
        let lsp = project.lsp.clone();
        host.runtime.spawn(async move { lsp.reconfigure().await });
    }
}

/// Status of every known language server / debug adapter and the languages using it.
pub async fn tools_list(host: &Host, window: &str) -> IdeResult<Vec<ToolInfo>> {
    let tools = tools(host, window)?;
    let langs = languages(host, window);
    tokio::task::spawn_blocking(move || tools.list(&langs)).await.map_err(join_err)
}

/// Installs (or reinstalls) a tool into `<app-data>/tools`, streaming output through
/// `on_event`. Cancel with `cancel_request(request)`.
pub async fn tools_install(
    host: &Host,
    window: &str,
    name: String,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<ToolInfo> {
    let tools = tools(host, window)?;
    let langs = languages(host, window);
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        tools.install(&name, &langs, &cancel, &|e| {
            let _ = on_event.send(e);
        })
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    let info = result??;
    // Language servers whose launch depends on installed tools (jdtls loads the
    // java-debug bundle) pick the change up.
    reconfigure_servers(host);
    Ok(info)
}

/// Removes a tool the IDE installed.
pub async fn tools_uninstall(host: &Host, window: &str, name: String) -> IdeResult<ToolInfo> {
    let tools = tools(host, window)?;
    let langs = languages(host, window);
    let info = tokio::task::spawn_blocking(move || tools.uninstall(&name, &langs)).await.map_err(join_err)??;
    reconfigure_servers(host);
    Ok(info)
}

/// JDK distributions Download JDK offers.
pub fn jdk_download_vendors(_host: &Host, _window: &str) -> Vec<JdkVendor> {
    ide_tools::jdk::vendors()
}

/// Java versions `vendor` publishes; cancellable with `cancel_request(request)`.
pub async fn jdk_download_releases(
    host: &Host,
    window: &str,
    vendor: String,
    request: RequestId,
) -> IdeResult<JdkReleases> {
    let tools = tools(host, window)?;
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || tools.jdk_releases(&vendor, &cancel)).await.map_err(join_err);
    host.end_request(request);
    result?
}

/// Where Download JDK puts JDKs unless told otherwise.
pub fn jdk_download_location(host: &Host, _window: &str) -> IdeResult<ide_core::IpcPath> {
    Ok(ide_tools::jdk::jdks_dir(&host.data_dir).into())
}

/// Downloads the latest `vendor` JDK of Java `version` into `location` (default:
/// [`jdk_download_location`]), streaming progress through `on_event`; cancellable
/// with `cancel_request(request)`. The JDK is then detected like an installed one,
/// and language servers waiting for a JDK (jdtls) start on it.
#[allow(clippy::too_many_arguments)]
pub async fn jdk_download(
    host: &Host,
    window: &str,
    vendor: String,
    version: u32,
    location: Option<PathBuf>,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<Sdk> {
    let tools = tools(host, window)?;
    let location = location.filter(|p| !p.as_os_str().is_empty());
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let jdk = tools.download_jdk(&vendor, version, location.as_deref(), &cancel, &|e| {
            let _ = on_event.send(e);
        })?;
        let home = jdk.home.into_path_buf();
        // A chosen location is scanned from now on too (the default one is from startup).
        if let Some(location) = &location {
            ide_sdk::java::add_jdk_root(location);
        }
        ide_sdk::java::rescan_jdks();
        let jdk = ide_sdk::java::jdk_at(&home)
            .ok_or_else(|| IdeError::internal(format!("{} is not a JDK home", home.display())))?;
        IdeResult::Ok(ide_sdk::jdk_sdk(&jdk))
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    let sdk = result??;
    reconfigure_servers(host);
    Ok(sdk)
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("tools_list", |c| async move { tools_list(&c.host, &c.window).await });
    d.add("tools_install", |c| async move {
        tools_install(&c.host, &c.window, c.arg("name")?, c.arg("request")?, c.sender("onEvent")?).await
    });
    d.add("tools_uninstall", |c| async move { tools_uninstall(&c.host, &c.window, c.arg("name")?).await });
    d.add("jdk_download_vendors", |c| async move { Ok(jdk_download_vendors(&c.host, &c.window)) });
    d.add("jdk_download_releases", |c| async move {
        jdk_download_releases(&c.host, &c.window, c.arg("vendor")?, c.arg("request")?).await
    });
    d.add("jdk_download_location", |c| async move { jdk_download_location(&c.host, &c.window) });
    d.add("jdk_download", |c| async move {
        jdk_download(
            &c.host,
            &c.window,
            c.arg("vendor")?,
            c.arg("version")?,
            c.arg("location")?,
            c.arg("request")?,
            c.sender("onEvent")?,
        )
        .await
    });
}
