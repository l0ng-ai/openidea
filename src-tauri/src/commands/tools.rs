//! Language server / debug adapter installer and JDK downloads (`ide-tools`).

use crate::state::AppState;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_sdk::Sdk;
use ide_tools::jdk::{JdkReleases, JdkVendor};
use ide_tools::{InstallEvent, ToolInfo, Tools};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Window};

/// The installer, reporting the executables chosen in the window's settings.
fn tools(app: &AppHandle, state: &AppState, window: &Window) -> IdeResult<Tools> {
    let data = app.path().app_data_dir().map_err(|e| IdeError::internal(e.to_string()))?;
    let (settings, root) = match state.project(window.label()) {
        Ok(project) => (project.settings.effective(), project.root.clone()),
        Err(_) => (state.global_settings.effective(), Default::default()),
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

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

/// Status of every known language server / debug adapter and the languages using it.
#[tauri::command]
#[specta::specta]
pub async fn tools_list(app: AppHandle, window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ToolInfo>> {
    let tools = tools(&app, &state, &window)?;
    let langs = state.languages.all();
    tauri::async_runtime::spawn_blocking(move || tools.list(&langs)).await.map_err(join_err)
}

/// Installs (or reinstalls) a tool into `<app-data>/tools`, streaming output through
/// `on_event`. Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn tools_install(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    name: String,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<ToolInfo> {
    let tools = tools(&app, &state, &window)?;
    let langs = state.languages.all();
    let cancel = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
        tools.install(&name, &langs, &cancel, &|e| {
            let _ = on_event.send(e);
        })
    })
    .await
    .map_err(join_err);
    state.end_request(request);
    let info = result??;
    // Language servers whose launch depends on installed tools (jdtls loads the
    // java-debug bundle) pick the change up.
    reconfigure_servers(&state);
    Ok(info)
}

/// Removes a tool the IDE installed.
#[tauri::command]
#[specta::specta]
pub async fn tools_uninstall(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    name: String,
) -> IdeResult<ToolInfo> {
    let tools = tools(&app, &state, &window)?;
    let langs = state.languages.all();
    let info =
        tauri::async_runtime::spawn_blocking(move || tools.uninstall(&name, &langs)).await.map_err(join_err)??;
    reconfigure_servers(&state);
    Ok(info)
}

/// JDK distributions Download JDK offers.
#[tauri::command]
#[specta::specta]
pub fn jdk_download_vendors() -> Vec<JdkVendor> {
    ide_tools::jdk::vendors()
}

/// Java versions `vendor` publishes; cancellable with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn jdk_download_releases(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    vendor: String,
    request: RequestId,
) -> IdeResult<JdkReleases> {
    let tools = tools(&app, &state, &window)?;
    let cancel = state.begin_request(request);
    let result =
        tauri::async_runtime::spawn_blocking(move || tools.jdk_releases(&vendor, &cancel)).await.map_err(join_err);
    state.end_request(request);
    result?
}

/// Where Download JDK puts JDKs unless told otherwise.
#[tauri::command]
#[specta::specta]
pub fn jdk_download_location(app: AppHandle) -> IdeResult<ide_core::IpcPath> {
    let data = app.path().app_data_dir().map_err(|e| IdeError::internal(e.to_string()))?;
    Ok(ide_tools::jdk::jdks_dir(&data).into())
}

/// Downloads the latest `vendor` JDK of Java `version` into `location` (default:
/// [`jdk_download_location`]), streaming progress through `on_event`; cancellable
/// with `cancel_request(request)`. The JDK is then detected like an installed one,
/// and language servers waiting for a JDK (jdtls) start on it.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn jdk_download(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    vendor: String,
    version: u32,
    location: Option<PathBuf>,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<Sdk> {
    let tools = tools(&app, &state, &window)?;
    let location = location.filter(|p| !p.as_os_str().is_empty());
    let cancel = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
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
    state.end_request(request);
    let sdk = result??;
    reconfigure_servers(&state);
    Ok(sdk)
}

fn reconfigure_servers(state: &AppState) {
    for project in state.projects() {
        let lsp = project.lsp.clone();
        tauri::async_runtime::spawn(async move { lsp.reconfigure().await });
    }
}
