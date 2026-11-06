//! Plugins: Tauri adapter over `ide_host::plugins::PluginHost`. Each window
//! subscribes once with `plugin_subscribe(channel)` and receives
//! [`PluginEvent`]s addressed to it (notifications, consent requests, tasks)
//! plus broadcasts (list/theme/status item changes).

use crate::state::AppState;
use ide_core::{IdeError, IdeResult};
use ide_extension::ActivationEvent;
use ide_host::plugins::intellij::{self, InstalledIntellijTheme, IntellijThemeSource};
use ide_host::plugins::{
    ActiveTheme, CatalogPlugin, Consent, EventKind, FileProblems, HostWorkspace, InstallPreview, PackageFile,
    PluginEditor, PluginEvent, PluginHost, PluginInfo, PluginStatusItem, PluginsSnapshot, WorkbenchEvent,
};
use ide_plugin::{Invocation, Limits};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Window};

/// How long `plugin_list` waits for the startup load before answering with what it has.
const INITIAL_LOAD_WAIT: Duration = Duration::from_secs(5);
/// `on-startup-finished` fires this long after the installed plugins are loaded.
const STARTUP_FINISHED_DELAY: Duration = Duration::from_millis(1500);
/// How often the marketplace index is read again (revocations).
const MARKET_REFRESH: Duration = Duration::from_secs(24 * 60 * 60);
/// Period of [`PluginHost::flush_events`]; [`PluginHost::tick`] runs every
/// [`TICKS_PER_SUPERVISION`] of them.
const EVENT_FLUSH: Duration = Duration::from_millis(250);
const TICKS_PER_SUPERVISION: u32 = 20;
/// Plugin changes (install, enable, grants) reach remote servers after this quiet time.
const REMOTE_SYNC_DELAY: Duration = Duration::from_millis(800);

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

/// Delivers a plugin event to one window (remote windows: from their server).
pub(crate) fn deliver_to(window: &str, event: PluginEvent) {
    deliver(Some(window), event);
}

/// Re-syncs remote servers' plugins once plugin changes settle.
fn schedule_remote_sync(app: &AppHandle) {
    static SCHEDULED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if SCHEDULED.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REMOTE_SYNC_DELAY).await;
        SCHEDULED.store(false, std::sync::atomic::Ordering::Release);
        let Some(state) = app.try_state::<crate::state::AppState>() else { return };
        for (window, connection) in state.remote_dev.all() {
            crate::remote_dev::sync_plugin_packages(&state.plugins, &connection, &window).await;
        }
    });
}

/// Creates the host over `<app-data>/plugins` and loads installed plugins in
/// the background (no Wasm is instantiated until an activation event).
pub fn create_host(app: &AppHandle, data_dir: &Path, project_host: &Arc<ide_host::Host>) -> IdeResult<Arc<PluginHost>> {
    let projects = Arc::downgrade(project_host);
    let app = app.clone();
    let sink = move |client: Option<&str>, event: PluginEvent| {
        if matches!(event, PluginEvent::CommandsChanged)
            && app.try_state::<crate::state::AppState>().is_some_and(|s| !s.remote_dev.all().is_empty())
        {
            schedule_remote_sync(&app);
        }
        if matches!(event, PluginEvent::LanguagesChanged) {
            if let Some(projects) = projects.upgrade() {
                projects.plugin_languages_changed();
            }
            // Remote windows: their servers run the languages.
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                let plugins = state.plugins.clone();
                for (window, connection) in state.remote_dev.all() {
                    let plugins = plugins.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::remote_dev::sync_plugin_languages(&plugins, &connection, &window).await
                    });
                }
            }
        }
        deliver(client, event);
    };
    let host = Arc::new(PluginHost::new(data_dir.join("plugins"), Arc::new(sink), Limits::default())?);
    // Plugin languages join detection, LSP and DAP of every project (forks share the store),
    // and the syntax of the ones without a built-in grammar comes from their plugin.
    project_host.languages.attach_plugins(host.language_store().clone());
    ide_language::set_external_syntax(Some(host.syntax_provider()));
    ide_run::set_external_detection(Some(host.run_detection()));
    host.set_workspace(Some(Arc::new(HostWorkspace(Arc::downgrade(project_host)))));
    // Released builds list the official plugins (published with each release) until the user picks another index.
    if !cfg!(debug_assertions) {
        host.set_default_market_url(Some(ide_host::plugins::OFFICIAL_MARKET_INDEX.into()));
    }
    #[cfg(target_os = "macos")]
    host.set_secret_store(Arc::new(KeychainSecrets));
    ide_host::plugins::set_editor_providers(Some(&host));
    let weak = Arc::downgrade(project_host);
    host.set_project_policy(Arc::new(move |root| {
        weak.upgrade().is_some_and(|host| host.trust.trusted(root).unwrap_or(false))
    }));
    let loader = Arc::downgrade(&host);
    std::thread::Builder::new().name("plugin-load".into()).spawn(move || {
        let Some(host) = loader.upgrade() else { return };
        host.load_all();
        drop(host);
        std::thread::sleep(STARTUP_FINISHED_DELAY);
        let Some(host) = loader.upgrade() else { return };
        host.startup_finished();
        host.warm_component_cache();
        drop(host);
        // Event delivery; supervision (crash reports, idle reclaim, `on-schedule`);
        // the daily marketplace check (revocations).
        let mut market_due = std::time::Instant::now() + Duration::from_secs(60);
        for n in 1u32.. {
            std::thread::sleep(EVENT_FLUSH);
            let Some(host) = loader.upgrade() else { return };
            host.flush_events();
            if n % TICKS_PER_SUPERVISION == 0 {
                host.tick();
            }
            if std::time::Instant::now() >= market_due {
                market_due = std::time::Instant::now() + MARKET_REFRESH;
                if host.market_url().is_some()
                    && let Err(e) = host.refresh_market()
                {
                    tracing::info!("plugin marketplace: {e}");
                }
            }
        }
    })?;
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

/// Installed and linked plugins plus the project plugins of this window's
/// project (`<project>/.openidea/plugins/*`, rescanned on every call), with
/// the UI contributions to project.
#[tauri::command]
#[specta::specta]
pub async fn plugin_list(window: Window, state: State<'_, AppState>) -> IdeResult<PluginsSnapshot> {
    let host = state.plugins.clone();
    let root = state.project(window.label()).ok().map(|p| p.root.clone());
    blocking(move || {
        // A window opened at startup would otherwise see no plugins and drop the selected theme.
        host.wait_initial_load(INITIAL_LOAD_WAIT);
        host.sync_links();
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

/// Validates the package in `path` for the install page (nothing is copied).
#[tauri::command]
#[specta::specta]
pub async fn plugin_preview_install(state: State<'_, AppState>, path: PathBuf) -> IdeResult<InstallPreview> {
    let host = state.plugins.clone();
    blocking(move || host.preview_install(&path)).await
}

/// Installs the plugin package in `path` (a folder with `plugin.toml`) with
/// the capabilities the user accepted on the install page.
#[tauri::command]
#[specta::specta]
pub async fn plugin_install_dir(state: State<'_, AppState>, path: PathBuf, consent: Consent) -> IdeResult<PluginInfo> {
    let host = state.plugins.clone();
    blocking(move || host.install_from_dir(&path, &consent)).await
}

/// Confirms a plugin waiting for consent (project plugins, new capabilities).
#[tauri::command]
#[specta::specta]
pub async fn plugin_grant(state: State<'_, AppState>, id: String, consent: Consent) -> IdeResult<PluginInfo> {
    let host = state.plugins.clone();
    blocking(move || host.grant(&id, &consent)).await
}

/// Grants or revokes one declared capability.
#[tauri::command]
#[specta::specta]
pub async fn plugin_set_capability(
    state: State<'_, AppState>,
    id: String,
    capability: String,
    granted: bool,
) -> IdeResult<PluginInfo> {
    let host = state.plugins.clone();
    blocking(move || host.set_capability(&id, &capability, granted)).await
}

/// Links a development plugin folder (`openidea-plugin link` does the same from a terminal).
#[tauri::command]
#[specta::specta]
pub async fn plugin_link(state: State<'_, AppState>, path: PathBuf) -> IdeResult<PluginInfo> {
    let host = state.plugins.clone();
    blocking(move || host.link(&path)).await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_unlink(state: State<'_, AppState>, id: String) -> IdeResult<()> {
    let host = state.plugins.clone();
    blocking(move || host.unlink(&id)).await
}

/// Validated assets of a plugin whose id starts with `prefix` (icon theme mapping and SVGs).
#[tauri::command]
#[specta::specta]
pub async fn plugin_assets(
    state: State<'_, AppState>,
    plugin_id: String,
    prefix: String,
) -> IdeResult<Vec<(String, String)>> {
    let host = state.plugins.clone();
    blocking(move || host.assets(&plugin_id, &prefix)).await
}

/// An activation event from the UI: `kind` is `language`, `file` (project-relative path) or `view`.
#[tauri::command]
#[specta::specta]
pub async fn plugin_activation_event(
    window: Window,
    state: State<'_, AppState>,
    kind: String,
    value: String,
) -> IdeResult<()> {
    let event = match kind.as_str() {
        "language" => ActivationEvent::Language(value),
        "file" => ActivationEvent::File(value),
        "view" => ActivationEvent::View(value),
        _ => return Err(IdeError::invalid(format!("unknown activation event kind {kind:?}"))),
    };
    let project = state.project(window.label()).ok();
    if project.as_ref().is_some_and(|p| !p.is_trusted()) {
        return Ok(()); // Restricted Mode: no plugin code runs for this project.
    }
    let host = state.plugins.clone();
    blocking(move || {
        host.activation_event(&event, project.as_ref().map(|p| p.root.as_path()));
        Ok(())
    })
    .await
}

/// Plugin packages available locally for installation: `<resources>/plugins`
/// when bundled, plus the repository's official plugins in debug builds.
#[tauri::command]
#[specta::specta]
pub async fn plugin_catalog(app: AppHandle, state: State<'_, AppState>) -> IdeResult<Vec<CatalogPlugin>> {
    let mut dirs: Vec<PathBuf> = app.path().resource_dir().map(|d| vec![d.join("plugins")]).unwrap_or_default();
    if cfg!(debug_assertions) {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        dirs.push(repo.join("plugins/official"));
    }
    let host = state.plugins.clone();
    blocking(move || Ok(host.catalog(&dirs))).await
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

/// Runs a plugin command in the context of this window's project and focused editor.
#[tauri::command]
#[specta::specta]
pub async fn plugin_run_command(
    window: Window,
    state: State<'_, AppState>,
    plugin_id: String,
    command_id: String,
    arg: Option<String>,
    editor: Option<PluginEditor>,
) -> IdeResult<Option<String>> {
    let host = state.plugins.clone();
    let project = state.project(window.label()).ok();
    let invocation = Invocation {
        client: Some(window.label().to_owned()),
        workspace_root: project.as_ref().map(|p| p.root.clone()),
        editor: editor.map(PluginEditor::context),
    };
    blocking(move || host.run_command(&plugin_id, &command_id, arg.as_deref(), invocation)).await
}

/// Workbench events from this window (only the kinds of `plugin_event_kinds`).
#[tauri::command]
#[specta::specta]
pub fn plugin_post_events(window: Window, state: State<'_, AppState>, events: Vec<WorkbenchEvent>) {
    state.plugins.post_events(Some(window.label()), events);
}

/// Kinds of workbench events plugins want (re-fetch on `subscriptionsChanged`).
#[tauri::command]
#[specta::specta]
pub async fn plugin_event_kinds(app: tauri::AppHandle) -> Vec<EventKind> {
    let host = app.state::<AppState>().plugins.clone();
    // Asked once at startup: before the first load, the declared `on-event:` kinds
    // would be missing, and the `commandsChanged` that load sends may precede the window's subscription.
    let kinds = tauri::async_runtime::spawn_blocking(move || {
        host.wait_initial_load(INITIAL_LOAD_WAIT);
        host.event_kinds().into_iter().collect()
    });
    kinds.await.unwrap_or_default()
}

/// Every plugin status bar item (later changes arrive as `statusItemChanged`).
#[tauri::command]
#[specta::specta]
pub fn plugin_status_items(state: State<'_, AppState>) -> Vec<PluginStatusItem> {
    state
        .plugins
        .status_items()
        .into_iter()
        .map(|(plugin_id, id, item)| PluginStatusItem { plugin_id, id, item })
        .collect()
}

/// Cancels a plugin task (`taskStarted` with `cancellable`).
#[tauri::command]
#[specta::specta]
pub fn plugin_cancel_task(state: State<'_, AppState>, task_id: String) -> bool {
    state.plugins.cancel_task(&task_id)
}

/// Gutter markers of plugin `line-markers` providers for an open document.
#[tauri::command]
#[specta::specta]
pub async fn plugin_line_markers(
    window: Window,
    state: State<'_, AppState>,
    doc: ide_core::DocId,
) -> IdeResult<Vec<ide_host::plugins::LineMarkerInfo>> {
    ide_host::ops::lsp::plugin_line_markers(&state.host, window.label(), doc).await
}

/// Content of a plugin view (`doc`: the document of a custom editor; `editor`: for
/// a tool window, the window's active editor, as commands get it).
#[tauri::command]
#[specta::specta]
pub async fn plugin_view_render(
    window: Window,
    state: State<'_, AppState>,
    plugin_id: String,
    view: String,
    viewport: Option<ide_plugin::Viewport>,
    doc: Option<ide_core::DocId>,
    editor: Option<PluginEditor>,
) -> IdeResult<ide_plugin::View> {
    let plugins = state.plugins.clone();
    ide_host::plugins::views::render(&state.host, plugins, window.label(), plugin_id, view, viewport, doc, editor).await
}

/// A user action in a plugin view or custom editor (`doc`, `editor`: as for rendering).
#[tauri::command]
#[specta::specta]
pub async fn plugin_view_event(
    window: Window,
    state: State<'_, AppState>,
    plugin_id: String,
    view: String,
    event: ide_plugin::ViewEvent,
    doc: Option<ide_core::DocId>,
    editor: Option<PluginEditor>,
) -> IdeResult<()> {
    let plugins = state.plugins.clone();
    ide_host::plugins::views::event(&state.host, plugins, window.label(), plugin_id, view, event, doc, editor).await
}

/// The page of a plugin's web view or custom editor (`web = …`).
#[tauri::command]
#[specta::specta]
pub fn plugin_web_page(
    state: State<'_, AppState>,
    plugin_id: String,
    view: String,
) -> IdeResult<ide_host::plugins::web::WebPage> {
    state.plugins.web_page(&plugin_id, &view)
}

/// Largest file a web view saves or opens (`openidea.saveFile` / `openFile`).
const MAX_WEB_VIEW_FILE: u64 = 64 << 20;

/// Writes what a web view saves (`openidea.saveFile`) to the path the user
/// chose in the save dialog, on this machine.
#[tauri::command]
#[specta::specta]
pub async fn plugin_web_save_file(path: PathBuf, base64: String) -> IdeResult<()> {
    use base64::Engine;
    if base64.len() as u64 > MAX_WEB_VIEW_FILE / 3 * 4 + 4 {
        return Err(IdeError::invalid(format!("larger than {} MiB", MAX_WEB_VIEW_FILE >> 20)));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|e| IdeError::invalid(format!("not base64: {e}")))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| IdeError::new(ide_core::error::ErrorKind::Io, format!("{}: {e}", path.display())))
}

/// Reads the file the user picked in an open dialog for a web view
/// (`openidea.openFile`), on this machine; base64.
#[tauri::command]
#[specta::specta]
pub async fn plugin_web_read_file(path: PathBuf) -> IdeResult<String> {
    use base64::Engine;
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| IdeError::new(ide_core::error::ErrorKind::Io, format!("{}: {e}", path.display())))?;
    if !meta.is_file() || meta.len() > MAX_WEB_VIEW_FILE {
        return Err(IdeError::invalid(format!(
            "{}: not a file of at most {} MiB",
            path.display(),
            MAX_WEB_VIEW_FILE >> 20
        )));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| IdeError::new(ide_core::error::ErrorKind::Io, format!("{}: {e}", path.display())))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// The marketplace's plugins: read again when `refresh` or when none was read yet, else the last index read.
#[tauri::command]
#[specta::specta]
pub async fn plugin_market(
    state: State<'_, AppState>,
    refresh: bool,
) -> IdeResult<Vec<ide_host::plugins::MarketPlugin>> {
    let host = state.plugins.clone();
    blocking(move || host.market_listing(refresh)).await
}

#[tauri::command]
#[specta::specta]
pub fn plugin_market_url(state: State<'_, AppState>) -> Option<String> {
    state.plugins.market_url()
}

/// Sets the marketplace index URL (an `https://…/index.json` or a local path; `None` for the default).
#[tauri::command]
#[specta::specta]
pub fn plugin_set_market_url(state: State<'_, AppState>, url: Option<String>) {
    state.plugins.set_market_url(url);
}

/// Downloads and checks a marketplace plugin; returns the folder for the install page.
#[tauri::command]
#[specta::specta]
pub async fn plugin_market_download(state: State<'_, AppState>, id: String) -> IdeResult<PathBuf> {
    let host = state.plugins.clone();
    blocking(move || host.download_market_plugin(&id)).await
}

/// Unpacks a package file (`.oiplugin` or `.zip`); returns the folder for the install page.
#[tauri::command]
#[specta::specta]
pub async fn plugin_unpack_package(state: State<'_, AppState>, path: PathBuf) -> IdeResult<PathBuf> {
    let host = state.plugins.clone();
    blocking(move || host.unpack_package(&path)).await
}

/// Reads an IntelliJ theme plugin (`.jar`, Marketplace `.zip`, plugin folder) or `.theme.json` to import.
#[tauri::command]
#[specta::specta]
pub async fn plugin_read_intellij_theme(path: PathBuf) -> IdeResult<IntellijThemeSource> {
    blocking(move || intellij::read_source(&path)).await
}

/// Theme plugins installed in the JetBrains IDEs of this user, the ones in use first.
#[tauri::command]
#[specta::specta]
pub async fn plugin_installed_intellij_themes() -> IdeResult<Vec<InstalledIntellijTheme>> {
    blocking(|| Ok(intellij::installed_themes())).await
}

/// Writes a package the UI generated (an imported theme); returns the folder for the install page.
#[tauri::command]
#[specta::specta]
pub async fn plugin_stage_package(
    state: State<'_, AppState>,
    name: String,
    files: Vec<PackageFile>,
) -> IdeResult<PathBuf> {
    let host = state.plugins.clone();
    blocking(move || host.stage_package(&name, &files)).await
}

/// Goes back to the version the last update of `id` replaced.
#[tauri::command]
#[specta::specta]
pub async fn plugin_roll_back(state: State<'_, AppState>, id: String) -> IdeResult<PluginInfo> {
    let host = state.plugins.clone();
    blocking(move || host.roll_back_update(&id)).await
}

/// A secret a plugin declares, and whether the user stored it.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginSecretState {
    pub name: String,
    pub set: bool,
}

#[tauri::command]
#[specta::specta]
pub fn plugin_secrets(state: State<'_, AppState>, plugin_id: String) -> IdeResult<Vec<PluginSecretState>> {
    Ok(state.plugins.secrets(&plugin_id)?.into_iter().map(|(name, set)| PluginSecretState { name, set }).collect())
}

/// Stores a plugin secret (`None` or empty deletes it). The value never goes back to the UI or the plugin.
#[tauri::command]
#[specta::specta]
pub fn plugin_set_secret(
    state: State<'_, AppState>,
    plugin_id: String,
    name: String,
    value: Option<String>,
) -> IdeResult<()> {
    state.plugins.set_secret(&plugin_id, &name, value.as_deref())
}

/// Plugin secrets in the login keychain (service `ai.l0ng.openidea.plugin.<id>`).
#[cfg(target_os = "macos")]
struct KeychainSecrets;

#[cfg(target_os = "macos")]
impl ide_host::plugins::SecretStore for KeychainSecrets {
    fn get(&self, plugin: &str, name: &str) -> Option<String> {
        let bytes = security_framework::passwords::get_generic_password(&Self::service(plugin), name).ok()?;
        String::from_utf8(bytes).ok()
    }

    fn set(&self, plugin: &str, name: &str, value: Option<&str>) -> Result<(), String> {
        let service = Self::service(plugin);
        match value {
            Some(v) => security_framework::passwords::set_generic_password(&service, name, v.as_bytes()),
            None => match security_framework::passwords::delete_generic_password(&service, name) {
                // Deleting what isn't there is fine.
                Err(e) if e.code() == -25300 => Ok(()),
                other => other,
            },
        }
        .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
impl KeychainSecrets {
    fn service(plugin: &str) -> String {
        format!("ai.l0ng.openidea.plugin.{plugin}")
    }
}

/// The UI reports the focused editor's file (`editor-focused` events).
#[tauri::command]
#[specta::specta]
pub fn plugin_set_active_file(window: Window, state: State<'_, AppState>, path: Option<String>) {
    state.plugins.set_active_file(window.label(), path);
}

/// The UI reports this window's focused text editor and its selections (MCP
/// tool calls for this window's project get it).
#[tauri::command]
#[specta::specta]
pub fn plugin_set_focused_editor(window: Window, state: State<'_, AppState>, editor: Option<PluginEditor>) {
    state.plugins.set_focused_editor(window.label(), editor.map(PluginEditor::context));
}

/// The UI reports the files open in this window's editor tabs (`workspace.open-editors`).
#[tauri::command]
#[specta::specta]
pub fn plugin_set_open_editors(window: Window, state: State<'_, AppState>, paths: Vec<ide_core::IpcPath>) {
    state.plugins.set_open_editors(window.label(), paths.into_iter().map(PathBuf::from).collect());
}

/// The UI reports what this window's Problems view lists for the files that
/// changed (all of them, with `reset`), for `diagnostics.problems`.
#[tauri::command]
#[specta::specta]
pub fn plugin_report_problems(window: Window, state: State<'_, AppState>, reset: bool, files: Vec<FileProblems>) {
    let files = files.into_iter().map(|f| (PathBuf::from(f.path), f.items)).collect();
    state.plugins.report_problems(window.label(), reset, files);
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

use ide_host::plugins::index_ops::NavigationFiles;

#[tauri::command]
#[specta::specta]
pub async fn plugin_navigation_files(window: Window, state: State<'_, AppState>) -> IdeResult<NavigationFiles> {
    ide_host::plugins::index_ops::plugin_navigation_files(&state.host, state.plugins.clone(), window.label()).await
}

#[tauri::command]
#[specta::specta]
pub fn plugin_navigation_invalidate(
    window: Window,
    state: State<'_, AppState>,
    paths: Option<Vec<PathBuf>>,
) -> IdeResult<()> {
    ide_host::plugins::index_ops::plugin_navigation_invalidate(
        &state.host,
        state.plugins.clone(),
        window.label(),
        paths,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_navigation_index(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    request: ide_core::RequestId,
) -> IdeResult<()> {
    ide_host::plugins::index_ops::plugin_navigation_index(
        &state.host,
        state.plugins.clone(),
        window.label(),
        paths,
        request,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_navigation_goto(
    window: Window,
    state: State<'_, AppState>,
    doc: ide_core::DocId,
    pos: ide_core::Pos,
) -> IdeResult<Option<ide_plugin::indexing::NavigationResult>> {
    ide_host::plugins::index_ops::plugin_navigation_goto(&state.host, state.plugins.clone(), window.label(), doc, pos)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_navigation_markers(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
) -> IdeResult<Vec<ide_plugin::indexing::FileMarkers>> {
    ide_host::plugins::index_ops::plugin_navigation_markers(&state.host, state.plugins.clone(), window.label(), paths)
        .await
}
