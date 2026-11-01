//! WASM plugins (`ide-plugin`). Each window subscribes once with
//! `plugin_subscribe(channel)` and receives [`PluginEvent`]s addressed to it
//! (insert-text requests, notifications) plus broadcasts (list/theme changes).

use crate::state::AppState;
use ide_core::{IdeError, IdeResult};
use ide_plugin::{
    ActiveTheme, CatalogPlugin, Invocation, Limits, PluginEvent, PluginHost, PluginInfo, PluginsSnapshot,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Window};

/// How long `plugin_list` waits for the startup load before answering with what it has.
const INITIAL_LOAD_WAIT: Duration = Duration::from_secs(5);

/// Window label → its event channel.
static SUBSCRIBERS: LazyLock<Mutex<HashMap<String, Channel<PluginEvent>>>> = LazyLock::new(Default::default);

fn deliver(client: Option<&str>, event: PluginEvent) {
    let mut subs = SUBSCRIBERS.lock();
    match client {
        Some(label) => {
            if let Some(ch) = subs.get(label)
                && ch.send(event).is_err()
            {
                subs.remove(label);
            }
        }
        None => subs.retain(|_, ch| ch.send(event.clone()).is_ok()),
    }
}

/// Creates the host over `<config>/plugins` and loads installed plugins in the background.
pub fn create_host(_app: &AppHandle, config_dir: &Path) -> IdeResult<Arc<PluginHost>> {
    let host = Arc::new(PluginHost::new(config_dir.join("plugins"), Arc::new(deliver), Limits::default())?);
    let loader = host.clone();
    std::thread::Builder::new().name("plugin-load".into()).spawn(move || loader.load_all())?;
    Ok(host)
}

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(join_err)?
}

/// Routes this window's plugin events to `on_event` (replaces an earlier subscription).
#[tauri::command]
#[specta::specta]
pub fn plugin_subscribe(window: Window, on_event: Channel<PluginEvent>) {
    SUBSCRIBERS.lock().insert(window.label().to_owned(), on_event);
}

/// Installed plugins plus the dev plugins of this window's project
/// (`<project>/.openidea/plugins/*`, rescanned on every call).
#[tauri::command]
#[specta::specta]
pub async fn plugin_list(window: Window, state: State<'_, AppState>) -> IdeResult<PluginsSnapshot> {
    let host = state.plugins.clone();
    let root = state.project(window.label()).ok().map(|p| p.root.clone());
    blocking(move || {
        // A window opened at startup would otherwise see no plugins and drop the selected theme.
        host.wait_initial_load(INITIAL_LOAD_WAIT);
        if let Some(root) = &root {
            host.sync_project(root);
        }
        Ok(host.list(root.as_deref()))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_set_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> IdeResult<()> {
    let host = state.plugins.clone();
    blocking(move || host.set_enabled(&id, enabled)).await
}

/// Installs the plugin package in `path` (a folder with `plugin.toml`).
#[tauri::command]
#[specta::specta]
pub async fn plugin_install_dir(state: State<'_, AppState>, path: PathBuf) -> IdeResult<PluginInfo> {
    let host = state.plugins.clone();
    blocking(move || host.install_from_dir(&path)).await
}

/// Plugin packages available locally for installation: `<resources>/plugins`
/// when bundled, plus the repository's sample `plugins/` in debug builds.
/// There is no network marketplace.
#[tauri::command]
#[specta::specta]
pub async fn plugin_catalog(app: AppHandle) -> IdeResult<Vec<CatalogPlugin>> {
    let mut dirs: Vec<PathBuf> = app.path().resource_dir().map(|d| vec![d.join("plugins")]).unwrap_or_default();
    if cfg!(debug_assertions) {
        dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins"));
    }
    blocking(move || Ok(ide_plugin::scan_catalog(&dirs))).await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_uninstall(state: State<'_, AppState>, id: String) -> IdeResult<()> {
    let host = state.plugins.clone();
    blocking(move || host.uninstall(&id)).await
}

/// Re-reads a plugin from disk (after rebuilding a dev plugin).
#[tauri::command]
#[specta::specta]
pub async fn plugin_reload(state: State<'_, AppState>, id: String) -> IdeResult<PluginInfo> {
    let host = state.plugins.clone();
    blocking(move || host.reload(&id)).await
}

/// Runs a plugin command in the context of this window's project.
#[tauri::command]
#[specta::specta]
pub async fn plugin_run_command(
    window: Window,
    state: State<'_, AppState>,
    plugin_id: String,
    command_id: String,
    arg: Option<String>,
) -> IdeResult<Option<String>> {
    let host = state.plugins.clone();
    let project = state.project(window.label()).ok();
    let invocation = Invocation {
        client: Some(window.label().to_owned()),
        workspace_root: project.as_ref().map(|p| p.root.clone()),
        buffer_text: project.map(|p| {
            let documents = p.documents.clone();
            Arc::new(move |path: &Path| documents.text_of(path)) as ide_plugin::BufferText
        }),
    };
    blocking(move || host.run_command(&plugin_id, &command_id, arg.as_deref(), invocation)).await
}

/// The UI reports the focused editor's file (`active-file` for plugins).
#[tauri::command]
#[specta::specta]
pub fn plugin_set_active_file(window: Window, state: State<'_, AppState>, path: Option<String>) {
    state.plugins.set_active_file(window.label(), path);
}

/// Selects a plugin theme; both `None` restores the built-in theme.
#[tauri::command]
#[specta::specta]
pub fn plugin_set_theme(
    state: State<'_, AppState>,
    plugin_id: Option<String>,
    theme_id: Option<String>,
) -> IdeResult<Option<ActiveTheme>> {
    match (plugin_id.as_deref(), theme_id.as_deref()) {
        (Some(p), Some(t)) => state.plugins.set_theme(Some((p, t))),
        _ => state.plugins.set_theme(None),
    }
}

/// The UI reports the selected plugin theme's resolved frame colour (`#rrggbb[aa]`),
/// which new windows open in before their page loads.
#[tauri::command]
#[specta::specta]
pub fn plugin_set_theme_frame(state: State<'_, AppState>, color: Option<String>) -> IdeResult<()> {
    state.plugins.set_theme_frame(color.as_deref())
}
