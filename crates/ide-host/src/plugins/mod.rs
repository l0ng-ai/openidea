//! The plugin host: assembles the extension
//! registry (`ide-extension`), the grant ledger and the Wasm runtime
//! (`ide-plugin`). It runs where the project is — in the desktop app for local
//! projects, in `openidea-server` for remote ones; the desktop shell only adapts
//! it to Tauri commands.
//!
//! Lifecycle of a package: its manifest is parsed and every declaration
//! validated by its extension point (no side effects); the grant ledger decides
//! whether it may load (project and new plugins wait for the user's consent);
//! then its contributions are committed all or nothing. Code is instantiated
//! only when one of its activation events fires (a command runs, or start-up
//! finished for `on-startup-finished`).
//!
//! Sources: `<plugins_dir>/<id>/` (installed), `<project>/.openidea/plugins/*/`
//! (project plugins, loaded by [`PluginHost::sync_project`] for trusted
//! projects) and folders linked with `openidea-plugin link` (`links.json`).

mod api;
mod icon_extensions;
mod icon_patterns;
mod icon_settings;
mod icons;
pub mod index_ops;
mod install;
pub mod intellij;
mod market;
pub mod navigation;
mod points;
mod providers;
pub mod remote;
pub mod remote_host;
mod run_detectors;
mod theme;
mod types;
pub mod ui_points;
pub mod views;
pub mod web;

pub use api::{FileSecretStore, HostWorkspace, PluginWorkspace, SecretStore};
pub use icons::{map_asset as icon_theme_map_asset, sanitize_svg, svg_prefix as icon_theme_svg_prefix};
pub use market::{
    INDEX_FILE as MARKET_INDEX_FILE, MarketPlugin, OFFICIAL_INDEX as OFFICIAL_MARKET_INDEX, OFFICIAL_PUBLISHER,
    read_url as read_market_url, resolve as resolve_market_href,
};
pub use points::{COMMANDS, CommandDecl, register_builtin_points};
pub use providers::{ProviderKind, set_editor_providers};
pub(crate) use providers::{editor_plugin_host, editor_providers as editor_providers_for};
pub use theme::{ThemeDef, ThemeKind};
pub use types::*;

use ide_core::{IdeError, IdeResult, LanguageId};
use ide_extension::ledger::{self, BinaryGrant, Decision, Ledger, Request, Subject};
use ide_extension::{
    ActivationEvent, Capability, CapabilityInfo, ContributionIndex, ExtensionRegistry, MANIFEST_FILE, Manifest,
    Package, UiContribution, UiStore,
};
use ide_language::plugin_point::PluginLanguages;
use ide_language::{LanguageConfig, ProgramPin};
use ide_plugin::{
    Actor, ActorError, CANCELLED, CallError, HostApi, HostError, Invocation, Limits, PluginEngine, Runtime,
    RuntimeSetup,
};
use parking_lot::{Condvar, Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

const STATE_FILE: &str = "state.json";
const LINKS_FILE: &str = "links.json";
/// Project plugins live here, relative to a project root.
pub const DEV_PLUGINS_DIR: &str = ".openidea/plugins";

#[derive(Default, Serialize, Deserialize)]
struct PersistedState {
    #[serde(default)]
    disabled: BTreeSet<String>,
    #[serde(default)]
    theme: Option<ThemeRef>,
    /// Marketplace index URL (or folder path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    market_url: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct ThemeRef {
    plugin: String,
    theme: String,
    /// The theme's window frame colour as the UI resolved it (`#rrggbb[aa]`), so
    /// new windows open in it before the plugin is loaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    frame: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Links {
    #[serde(default)]
    paths: Vec<PathBuf>,
}

struct Meta {
    status: PluginStatus,
    error: Option<String>,
    warnings: Vec<String>,
    /// Capabilities the ledger granted (valid while live).
    granted: Vec<Capability>,
    /// Required capabilities still awaiting consent (`NeedsConsent`).
    pending: Vec<Capability>,
    /// Capabilities the declarations need beyond the manifest (`process:` of a language server).
    declared_extra: Vec<Capability>,
    stats: PluginStats,
    /// Durations of the recent calls (ms), for the p95.
    latencies: VecDeque<f32>,
    /// Consecutive crashes; reset by a call that returns.
    failures: u32,
    /// No restart before this (backoff after a crash).
    retry_at: Option<Instant>,
    /// The component exports `syntax-provider` (known once activated).
    has_syntax: bool,
    /// Next `on-schedule` activation.
    next_schedule: Option<Instant>,
    /// The trusted publisher of a signed installed package.
    publisher: Option<String>,
}

impl Meta {
    fn new() -> Self {
        Self {
            status: PluginStatus::Disabled,
            error: None,
            warnings: Vec::new(),
            granted: Vec::new(),
            pending: Vec::new(),
            declared_extra: Vec::new(),
            stats: PluginStats::default(),
            latencies: VecDeque::new(),
            failures: 0,
            retry_at: None,
            has_syntax: false,
            publisher: None,
            next_schedule: None,
        }
    }

    fn record_call(&mut self, elapsed: Duration, ok: bool) {
        let ms = elapsed.as_secs_f64() * 1000.0;
        self.stats.calls += 1;
        self.stats.max_call_ms = self.stats.max_call_ms.max(ms);
        if !ok {
            self.stats.errors += 1;
        }
        if self.latencies.len() == LATENCY_WINDOW {
            self.latencies.pop_front();
        }
        self.latencies.push_back(ms as f32);
    }

    fn p95(&self) -> f64 {
        if self.latencies.is_empty() {
            return 0.0;
        }
        let mut sorted: Vec<f32> = self.latencies.iter().copied().collect();
        sorted.sort_by(f32::total_cmp);
        f64::from(sorted[(sorted.len() * 95).div_ceil(100).saturating_sub(1)])
    }
}

/// Calls kept for the latency percentile.
const LATENCY_WINDOW: usize = 128;

/// Events waiting for one plugin (from one window).
struct EventQueue {
    since: Instant,
    events: Vec<WorkbenchEvent>,
}

/// Most events queued per plugin and window; older ones are dropped.
const MAX_QUEUED_EVENTS: usize = 500;
/// How long events for a plugin that is not running are collected before it
/// is activated to receive them.
const IDLE_BATCH: Duration = Duration::from_secs(2);

struct LoadedPlugin {
    pkg: Package,
    /// The manifest failed to parse: `pkg` is a placeholder.
    invalid: bool,
    source: PluginSource,
    /// Project that owns a project plugin.
    dev_root: Option<PathBuf>,
    meta: Mutex<Meta>,
    /// The running instance, on its own thread.
    runtime: Mutex<Option<Arc<Actor>>>,
    /// Event batches handed to the actor and not finished yet.
    batches: Arc<Mutex<Batches>>,
}

#[derive(Default)]
struct Batches {
    /// Posted, not finished.
    pending: u32,
    /// Kinds of the batch being handled right now.
    running: Option<BTreeSet<EventKind>>,
}

impl LoadedPlugin {
    /// Statistics of one call; a call that returned (`healthy`) ends a crash streak.
    fn record_call(&self, elapsed: Duration, ok: bool, healthy: bool) {
        let mut meta = self.meta.lock();
        meta.record_call(elapsed, ok);
        if healthy && meta.failures > 0 {
            meta.failures = 0;
            meta.retry_at = None;
            meta.error = None;
        }
    }

    fn id(&self) -> &str {
        self.pkg.id()
    }

    fn manifest(&self) -> &Manifest {
        &self.pkg.manifest
    }

    fn dir(&self) -> &Path {
        &self.pkg.dir
    }

    fn status(&self) -> PluginStatus {
        self.meta.lock().status
    }

    fn subject(&self) -> Subject {
        match self.source {
            PluginSource::Installed => Subject::Installed(self.id().to_owned()),
            PluginSource::Dev | PluginSource::Linked => Subject::Path(self.dir().to_path_buf()),
        }
    }
}

/// The user's answer on an install or consent page.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Consent {
    /// Optional capabilities the user accepted (`net:crates.io`, …). Required
    /// ones are implied by consenting at all.
    pub optional: Vec<String>,
    /// The user accepted a package signed by another key than the installed
    /// copy ([`InstallPreview::signer_changed`]).
    #[serde(default)]
    pub signer_change: bool,
}

impl Consent {
    /// Accept everything the plugin asks for (tests, trusted official plugins).
    pub fn all() -> Self {
        Self { optional: vec!["*".into()], signer_change: true }
    }

    fn accepts(&self, cap: &Capability) -> bool {
        self.optional.iter().any(|s| s == "*" || s.parse::<Capability>().is_ok_and(|c| c == *cap))
    }
}

/// What the install page shows before anything is copied.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub has_code: bool,
    pub capabilities: Vec<CapabilityInfo>,
    pub contributions: Vec<ContributionCount>,
    pub warnings: Vec<String>,
    /// Version currently installed under the same id.
    pub replaces: Option<String>,
    /// Not signed by a publisher the marketplace index trusts: warn the user.
    pub unsigned: bool,
    /// The verified publisher.
    pub publisher: Option<String>,
    /// Replaces an installed copy signed with another key, which didn't
    /// endorse this package's (or this one is unsigned): the user confirms it
    /// ([`Consent::signer_change`]).
    pub signer_changed: bool,
    /// Something to confirm: a first install, an unsigned package, another
    /// signer, or capabilities the installed version wasn't granted or
    /// refused. Without, an update installs with the grants it has.
    pub needs_consent: bool,
}

type ProjectPolicy = Arc<dyn Fn(&Path) -> bool + Send + Sync>;
/// (plugin, window) of a batch of workbench events.
type QueueKey = (String, Option<String>);
type PathVar = Arc<dyn Fn() -> Option<OsString> + Send + Sync>;

pub struct PluginHost {
    project_policy: RwLock<ProjectPolicy>,
    engine: PluginEngine,
    plugins_dir: PathBuf,
    sink: Arc<dyn PluginEventSink>,
    limits: Limits,
    registry: Arc<ExtensionRegistry>,
    ui: Arc<UiStore>,
    languages: Arc<PluginLanguages>,
    run_detectors: Arc<run_detectors::RunDetectors>,
    /// `[[contributes.providers]]` of enabled plugins.
    providers: Arc<providers::Providers>,
    navigation: Mutex<navigation::NavigationIndex>,
    /// Validated UI declarations of installed packages (start-up reuses them).
    index: Arc<ContributionIndex>,
    ledger: Mutex<Ledger>,
    plugins: RwLock<BTreeMap<String, Arc<LoadedPlugin>>>,
    state: Mutex<PersistedState>,
    /// What every plugin's [`api::PluginApi`] shares: sink, registry,
    /// workspace, status items, tasks, subscriptions.
    shared: Arc<api::Shared>,
    /// Workbench events waiting for delivery: (plugin, window) → batch.
    queues: Mutex<BTreeMap<QueueKey, EventQueue>>,
    /// Serializes loading / unloading so concurrent windows can't race.
    lifecycle: Mutex<()>,
    /// Set once the first [`load_all`](Self::load_all) has finished.
    initial_load: (Mutex<bool>, Condvar),
    /// `on-startup-finished` has fired.
    startup_finished: AtomicBool,
    /// The theme last announced with `ThemeChanged`.
    announced_theme: Mutex<Option<ActiveTheme>>,
    /// [`PluginLanguages::revision`] last announced with `LanguagesChanged`.
    announced_languages: AtomicU64,
    /// `PATH` used to resolve `process:` programs at grant time.
    path_var: RwLock<PathVar>,
    /// (plugin id, `process:` capability) → the approved program; read by the
    /// language store's policy (plugin language servers and debug adapters).
    pins: Arc<RwLock<HashMap<(String, String), ProgramPin>>>,
    /// The last marketplace index read: trust root for signatures, revocations.
    market: RwLock<Option<ide_extension::package::Index>>,
    /// The official publisher's keys the index is pinned to (none: as listed).
    official_keys: RwLock<Vec<String>>,
    /// `id@version` of the updates last announced.
    announced_updates: Mutex<Vec<String>>,
    /// The marketplace used while the user has set none (the app's official one).
    default_market_url: RwLock<Option<String>>,
    /// Updates not confirmed yet (the new version hasn't started once): what
    /// to roll back to.
    updates: Mutex<HashMap<String, PendingUpdate>>,
}

struct PendingUpdate {
    previous: String,
    grant: Option<ledger::Grant>,
}

impl PluginHost {
    /// Creates the host; call [`load_all`](Self::load_all) to load installed plugins.
    pub fn new(plugins_dir: PathBuf, sink: Arc<dyn PluginEventSink>, limits: Limits) -> IdeResult<Self> {
        std::fs::create_dir_all(&plugins_dir)?;
        install::recover(&plugins_dir);
        let state = std::fs::read_to_string(plugins_dir.join(STATE_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let registry = Arc::new(ExtensionRegistry::new());
        let ui = UiStore::new();
        let index = Arc::new(ContributionIndex::new(
            plugins_dir.join(".cache").join("contributions"),
            env!("CARGO_PKG_VERSION"),
        ));
        ui.set_index(Some(index.clone()));
        let languages = PluginLanguages::new();
        let run_detectors: Arc<run_detectors::RunDetectors> = Arc::default();
        let providers: Arc<providers::Providers> = Arc::default();
        register_builtin_points(&registry, &ui, &languages, &run_detectors, &providers).map_err(IdeError::internal)?;
        let pins: Arc<RwLock<HashMap<(String, String), ProgramPin>>> = Arc::default();
        let policy_pins = pins.clone();
        languages.set_process_policy(Arc::new(move |plugin, cap| {
            policy_pins.read().get(&(plugin.to_owned(), cap.to_string())).cloned()
        }));
        let shared = api::Shared::new(sink.clone(), plugins_dir.join(".data"), pins.clone(), ui.clone());
        let official_keys = market::built_in_official_keys();
        let market = RwLock::new(Self::load_market_index(&plugins_dir, &official_keys));
        let host = Self {
            market,
            official_keys: RwLock::new(official_keys),
            announced_updates: Mutex::default(),
            default_market_url: RwLock::new(None),
            updates: Mutex::default(),
            project_policy: RwLock::new(Arc::new(|_| false)),
            engine: PluginEngine::new().map_err(IdeError::internal)?,
            ledger: Mutex::new(Ledger::load(&plugins_dir)),
            plugins_dir,
            sink,
            limits,
            registry,
            ui,
            languages,
            run_detectors,
            providers,
            navigation: Mutex::default(),
            index,
            plugins: RwLock::default(),
            state: Mutex::new(state),
            shared,
            queues: Mutex::default(),
            lifecycle: Mutex::new(()),
            initial_load: (Mutex::new(false), Condvar::new()),
            startup_finished: AtomicBool::new(false),
            announced_theme: Mutex::new(None),
            announced_languages: AtomicU64::new(0),
            path_var: RwLock::new(Arc::new(|| std::env::var_os("PATH"))),
            pins,
        };
        host.refresh_pins(&host.ledger.lock());
        Ok(host)
    }

    pub fn plugins_dir(&self) -> &Path {
        &self.plugins_dir
    }

    /// The extension registry: feature crates register their points here.
    pub fn registry(&self) -> &Arc<ExtensionRegistry> {
        &self.registry
    }

    /// `PATH` for resolving `process:` programs when they are granted.
    pub fn set_program_path(&self, path: PathVar) {
        *self.path_var.write() = path;
    }

    /// Loads every installed and linked package (already loaded ones are kept).
    /// Instantiates no Wasm: code runs on its activation events.
    pub fn load_all(&self) {
        let _guard = self.lifecycle.lock();
        let dirs = package_dirs(&self.plugins_dir);
        self.migrate_grants(&dirs);
        for dir in dirs {
            if !self.is_loaded_from(&dir) {
                self.load_dir(&dir, PluginSource::Installed, None);
            }
        }
        for dir in self.links().paths {
            if !self.is_loaded_from(&dir) && dir.join(MANIFEST_FILE).is_file() {
                self.load_dir(&dir, PluginSource::Linked, None);
            }
        }
        let (done, cv) = &self.initial_load;
        *done.lock() = true;
        cv.notify_all();
        self.changed();
    }

    /// Fires `on-startup-finished`: activates the plugins waiting for it.
    /// Plugins loaded afterwards with that event activate right away.
    pub fn startup_finished(&self) {
        if self.startup_finished.swap(true, Ordering::AcqRel) {
            return;
        }
        let waiting: Vec<_> = self
            .plugins
            .read()
            .values()
            .filter(|p| {
                p.status() == PluginStatus::Inactive
                    && p.manifest().activation.contains(&ActivationEvent::StartupFinished)
            })
            .cloned()
            .collect();
        for p in waiting {
            let _ = self.ensure_active(&p, None);
        }
        self.changed();
    }

    /// Where compiled components are kept between runs.
    fn component_cache(&self) -> PathBuf {
        self.plugins_dir.join(".cache").join("components")
    }

    /// Precompiles every loaded plugin's component that is not cached yet and
    /// drops cache entries no loaded plugin uses (after an engine upgrade or an
    /// uninstall), compiled components and indexed contributions alike. Slow;
    /// call it on a background thread after start-up.
    pub fn warm_component_cache(&self) {
        let digests: Vec<Arc<str>> = self.plugins.read().values().filter_map(|p| p.pkg.digest.clone()).collect();
        self.index.prune(digests.iter().map(|d| &**d));
        let cache = self.component_cache();
        let wasm: Vec<PathBuf> = self
            .plugins
            .read()
            .values()
            .filter(|p| p.status() != PluginStatus::Disabled)
            .filter_map(|p| p.manifest().wasm.as_ref().map(|w| p.dir().join(w)))
            .collect();
        let mut keep = BTreeSet::new();
        for file in wasm {
            match self.engine.precompile(&file, &cache) {
                Ok(name) => {
                    keep.insert(name);
                }
                Err(e) => tracing::debug!("precompiling {}: {e}", file.display()),
            }
        }
        if let Ok(entries) = std::fs::read_dir(&cache) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if !keep.contains(&name) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }

    /// Fires an activation event from the UI (`on-language:rust`, `on-file:…`, `on-view:…`).
    pub fn activation_event(&self, event: &ActivationEvent, project: Option<&Path>) {
        let targets: Vec<_> = self
            .plugins
            .read()
            .values()
            .filter(|p| p.status() == PluginStatus::Inactive)
            .filter(|p| p.dev_root.is_none() || p.dev_root.as_deref() == project)
            .filter(|p| p.manifest().activation.iter().any(|a| activation_matches(a, event)))
            .cloned()
            .collect();
        if targets.is_empty() {
            return;
        }
        for p in targets {
            let _ = self.ensure_active(&p, None);
        }
        self.changed();
    }

    /// Waits (at most `timeout`) for the first [`load_all`](Self::load_all), so a
    /// listing made at startup already holds the installed plugins and the
    /// selected theme. Returns whether loading has finished.
    pub fn wait_initial_load(&self, timeout: Duration) -> bool {
        let (done, cv) = &self.initial_load;
        let mut done = done.lock();
        if !*done {
            cv.wait_while_for(&mut done, |d| !*d, timeout);
        }
        *done
    }

    /// Whether project plugins of a root may load (project trust).
    pub fn set_project_policy(&self, policy: ProjectPolicy) {
        *self.project_policy.write() = policy;
    }

    /// Unloads the project plugins of `root` (the project became untrusted or closed).
    pub fn restrict_project(&self, root: &Path) {
        let _guard = self.lifecycle.lock();
        let ids: Vec<_> = self
            .plugins
            .read()
            .iter()
            .filter(|(_, p)| p.dev_root.as_deref() == Some(root))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.unload(&id);
        }
        self.changed();
    }

    /// Loads new project plugins from `<root>/.openidea/plugins/` (trusted
    /// projects only) and unloads vanished ones. Each still needs the user's
    /// consent before it runs.
    pub fn sync_project(&self, root: &Path) {
        if !(self.project_policy.read())(root) {
            self.restrict_project(root);
            return;
        }
        let _guard = self.lifecycle.lock();
        let dirs = package_dirs(&ide_core::project_dir::path(root, "plugins"));
        let stale: Vec<String> = self
            .plugins
            .read()
            .iter()
            .filter(|(_, p)| p.dev_root.as_deref() == Some(root) && !dirs.iter().any(|d| d == p.dir()))
            .map(|(id, _)| id.clone())
            .collect();
        let mut changed = !stale.is_empty();
        for id in stale {
            self.unload(&id);
        }
        for dir in dirs {
            if !self.is_loaded_from(&dir) {
                self.load_dir(&dir, PluginSource::Dev, Some(root.to_path_buf()));
                changed = true;
            }
        }
        if changed {
            self.changed();
        }
    }

    /// Re-reads `links.json` (written by `openidea-plugin link`): loads new
    /// linked plugins and unloads unlinked ones.
    pub fn sync_links(&self) {
        let links = self.links().paths;
        let _guard = self.lifecycle.lock();
        let stale: Vec<String> = self
            .plugins
            .read()
            .iter()
            .filter(|(_, p)| p.source == PluginSource::Linked && !links.iter().any(|l| l == p.dir()))
            .map(|(id, _)| id.clone())
            .collect();
        let mut changed = !stale.is_empty();
        for id in stale {
            self.unload(&id);
        }
        for dir in links {
            if !self.is_loaded_from(&dir) && dir.join(MANIFEST_FILE).is_file() {
                self.load_dir(&dir, PluginSource::Linked, None);
                changed = true;
            }
        }
        if changed {
            self.changed();
        }
    }

    /// Links a development plugin folder (loaded until unlinked; granted by path).
    pub fn link(&self, dir: &Path) -> IdeResult<PluginInfo> {
        let dir = dunce::canonicalize(dir)?;
        Manifest::load(&dir).map_err(IdeError::invalid)?;
        let mut links = self.links();
        if !links.paths.contains(&dir) {
            links.paths.push(dir.clone());
            self.save_links(&links)?;
        }
        self.sync_links();
        let id = self.plugins.read().values().find(|p| p.dir() == dir).map(|p| p.id().to_owned());
        self.info_of(&id.ok_or_else(|| IdeError::invalid("the linked plugin's id is already in use"))?)
    }

    pub fn unlink(&self, id: &str) -> IdeResult<()> {
        let plugin = self.get(id)?;
        if plugin.source != PluginSource::Linked {
            return Err(IdeError::invalid(format!("plugin {id:?} is not linked")));
        }
        let mut links = self.links();
        links.paths.retain(|p| p != plugin.dir());
        self.save_links(&links)?;
        self.sync_links();
        Ok(())
    }

    /// Installed and linked plugins plus the project plugins of `project`.
    pub fn list(&self, project: Option<&Path>) -> PluginsSnapshot {
        let visible: Vec<Arc<LoadedPlugin>> = self
            .plugins
            .read()
            .values()
            .filter(|p| p.dev_root.is_none() || p.dev_root.as_deref() == project)
            .cloned()
            .collect();
        let ids: BTreeSet<&str> = visible.iter().map(|p| p.id()).collect();
        let ui: Vec<UiContribution> =
            self.ui.snapshot().into_iter().filter(|c| ids.contains(c.plugin_id.as_str())).collect();
        let mut plugins: Vec<PluginInfo> = visible.iter().map(|p| self.info(p)).collect();
        plugins.sort_by_key(|p| p.name.to_lowercase());
        PluginsSnapshot { plugins, active_theme: self.active_theme(), ui }
    }

    pub fn info_of(&self, id: &str) -> IdeResult<PluginInfo> {
        let plugin = self.get(id)?;
        Ok(self.info(&plugin))
    }

    /// UI contributions of one point (all live plugins).
    pub fn ui_items(&self, point: &str) -> Vec<UiContribution> {
        self.ui.items(point, None)
    }

    /// Validated assets of a plugin whose id starts with `prefix` (icon theme SVGs).
    pub fn assets(&self, id: &str, prefix: &str) -> IdeResult<Vec<(String, String)>> {
        let plugin = self.get(id)?;
        if !plugin.status().is_live() {
            return Err(IdeError::unavailable(format!("plugin {id:?} is not enabled")));
        }
        Ok(self.ui.assets_with_prefix(id, prefix).into_iter().map(|(k, v)| (k, v.to_string())).collect())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> IdeResult<()> {
        let _guard = self.lifecycle.lock();
        let plugin = self.get(id)?;
        {
            let mut state = self.state.lock();
            if enabled {
                state.disabled.remove(id)
            } else {
                state.disabled.insert(id.to_owned())
            };
        }
        self.save_state();
        self.stop(&plugin);
        if enabled {
            self.start(&plugin);
        } else {
            plugin.meta.lock().status = PluginStatus::Disabled;
        }
        self.changed();
        Ok(())
    }

    /// Re-reads a plugin from disk (e.g. after rebuilding a dev plugin).
    pub fn reload(&self, id: &str) -> IdeResult<PluginInfo> {
        let _guard = self.lifecycle.lock();
        let plugin = self.get(id)?;
        let (dir, source, root) = (plugin.dir().to_path_buf(), plugin.source, plugin.dev_root.clone());
        self.unload(id);
        let new_id = self.load_dir(&dir, source, root);
        self.changed();
        self.info_of(&new_id)
    }

    /// Validates a package for the install page: nothing is copied or run.
    pub fn preview_install(&self, src: &Path) -> IdeResult<InstallPreview> {
        let (pkg, set) = self.validate_package(src)?;
        if let Some(problem) = self.signature_problem(src) {
            return Err(IdeError::invalid(format!("refusing {}: {problem}", pkg.id())));
        }
        let publisher = self.verified_publisher(src);
        let m = &pkg.manifest;
        let replaces = self.plugins.read().get(&m.id).map(|p| p.manifest().version.clone());
        // An update shows what the installed version was granted.
        let grant = replaces
            .as_ref()
            .and_then(|_| self.ledger.lock().get(&Subject::Installed(m.id.clone())).cloned())
            .filter(|g| g.confirmed);
        let granted = |c: &Capability| grant.as_ref().is_some_and(|g| g.has(c));
        let mut capabilities: Vec<CapabilityInfo> =
            m.capabilities.all().map(|c| CapabilityInfo::new(c, m.capabilities.is_optional(c), granted(c))).collect();
        for extra in &set.capabilities {
            if !m.declares(extra) {
                capabilities.push(CapabilityInfo::new(extra, true, granted(extra)));
            }
        }
        capabilities.sort_by(|a, b| b.risk.cmp(&a.risk).then(a.id.cmp(&b.id)));
        let signer_changed = self.signer_changed(&m.id, src);
        let answered = |c: &CapabilityInfo| {
            c.granted || (c.optional && grant.as_ref().is_some_and(|g| g.declined.contains(&c.id)))
        };
        let needs_consent =
            grant.is_none() || publisher.is_none() || signer_changed || !capabilities.iter().all(answered);
        Ok(InstallPreview {
            id: m.id.clone(),
            name: m.name.clone(),
            version: m.version.clone(),
            description: m.description.clone(),
            authors: m.authors.clone(),
            has_code: m.wasm.is_some(),
            capabilities,
            contributions: counts(m),
            warnings: set.warnings.clone(),
            replaces,
            unsigned: publisher.is_none(),
            publisher,
            signer_changed,
            needs_consent,
        })
    }

    /// Installs the package in `src` (manifest + the files its declarations
    /// reference) with the user's `consent`, replacing an installed version
    /// with the same id atomically.
    pub fn install_from_dir(&self, src: &Path, consent: &Consent) -> IdeResult<PluginInfo> {
        let _guard = self.lifecycle.lock();
        let (pkg, set) = self.validate_package(src)?;
        let id = pkg.id().to_owned();
        if let Some(existing) = self.plugins.read().get(&id)
            && existing.source != PluginSource::Installed
        {
            return Err(IdeError::new(
                ide_core::error::ErrorKind::AlreadyExists,
                format!("a development plugin with id {id:?} is loaded from {}", existing.dir().display()),
            ));
        }
        // A signature that doesn't hold is worse than none.
        if let Some(problem) = self.signature_problem(src) {
            return Err(IdeError::invalid(format!("refusing {id}: {problem}")));
        }
        if !consent.signer_change && self.signer_changed(&id, src) {
            return Err(IdeError::invalid(format!(
                "refusing {id}: it is signed by another key than the installed version; confirm the change of signer"
            )));
        }
        let version = pkg.manifest.version.clone();
        if let Some(r) = self.market.read().as_ref().and_then(|i| i.revocation(&id, &version)) {
            return Err(IdeError::invalid(format!("{id} {version} was revoked: {}", r.reason)));
        }
        let mut files = set.files.clone();
        files.extend(pkg.manifest.wasm.clone());
        let hash = ledger::package_hash(src, &files)?;
        let root = self.plugins_dir.join(&id);
        let current = install::active_dir(&root);
        let same_dir = dunce::canonicalize(src)
            .ok()
            .zip(current.as_ref().and_then(|c| dunce::canonicalize(c).ok()))
            .is_some_and(|(a, b)| a == b);
        let subject = Subject::Installed(id.clone());
        let old_grant = self.ledger.lock().get(&subject).cloned();
        self.unload(&id);
        let previous = if same_dir {
            std::fs::write(current.as_ref().expect("same dir").join(install::HASH_FILE), &hash)?;
            None
        } else {
            let version_of = |d: &Path| Manifest::load(d).ok().map(|m| m.version);
            let previous = install::install_version(src, &root, &version, &files, &hash, version_of)?;
            market::copy_signature(src, &root.join(&version));
            previous
        };
        // Consent covers what the install page showed.
        let request = request_for(&subject, &pkg.manifest, &hash, &set.capabilities);
        self.record_consent(&request, consent);
        let dir = install::active_dir(&root).ok_or_else(|| IdeError::internal("the installed version is missing"))?;
        self.load_dir(&dir, PluginSource::Installed, None);
        if let Some(previous) = previous {
            let failed = self
                .get(&id)
                .ok()
                .filter(|p| p.status() == PluginStatus::Failed)
                .map(|p| p.meta.lock().error.clone().unwrap_or_else(|| "it failed to load".into()));
            if let Some(reason) = failed {
                self.roll_back(&id, &previous, &version, old_grant);
                self.changed();
                return Err(IdeError::invalid(format!(
                    "{} {version} could not start ({reason}); version {previous} was restored",
                    pkg.manifest.name
                )));
            }
            // Confirmed once the new version's code has started (or right away without code).
            if pkg.manifest.wasm.is_some() {
                self.updates.lock().insert(id.clone(), PendingUpdate { previous, grant: old_grant });
            }
        }
        install::prune(&root);
        self.changed();
        self.info_of(&id)
    }

    /// Makes `previous` the active version of `id` again and drops `failed`
    /// (its directory, its consent). Called with the plugin unloaded or not.
    fn roll_back(&self, id: &str, previous: &str, failed: &str, grant: Option<ledger::Grant>) {
        let root = self.plugins_dir.join(id);
        self.unload(id);
        if let Err(e) = install::activate_version(&root, previous) {
            tracing::warn!("plugin {id}: rolling back to {previous}: {e}");
            return;
        }
        if failed != previous {
            let _ = std::fs::remove_dir_all(root.join(failed));
        }
        {
            let mut ledger = self.ledger.lock();
            ledger.restore(&Subject::Installed(id.to_owned()), grant);
            self.save_ledger(&ledger);
        }
        self.updates.lock().remove(id);
        if let Some(dir) = install::active_dir(&root) {
            self.load_dir(&dir, PluginSource::Installed, None);
        }
    }

    /// An update whose code failed to start: back to the previous version.
    /// Returns the message for the user when it rolled back.
    fn roll_back_failed_update(
        &self,
        plugin: &Arc<LoadedPlugin>,
        reason: &str,
        client: Option<&str>,
    ) -> Option<String> {
        let id = plugin.id().to_owned();
        let pending = self.updates.lock().remove(&id)?;
        let version = plugin.manifest().version.clone();
        let name = plugin.manifest().name.clone();
        // The caller may hold the lifecycle lock (activation during start-up): don't wait for it forever.
        let _guard = self.lifecycle.try_lock_for(Duration::from_secs(5));
        self.roll_back(&id, &pending.previous, &version, pending.grant);
        let message = format!("{name} {version} failed to start ({reason}); version {} was restored", pending.previous);
        self.emit(
            client,
            PluginEvent::Notification {
                plugin_id: id,
                level: ide_plugin::NotificationLevel::Warning,
                title: format!("{name} update rolled back"),
                body: message.clone(),
            },
        );
        self.changed();
        Some(message)
    }

    /// Settings › Plugins › Roll Back: the version the last update replaced.
    pub fn roll_back_update(&self, id: &str) -> IdeResult<PluginInfo> {
        let _guard = self.lifecycle.lock();
        let plugin = self.get(id)?;
        if plugin.source != PluginSource::Installed {
            return Err(IdeError::invalid("only installed plugins have versions to roll back to"));
        }
        let root = self.plugins_dir.join(id);
        let previous = install::previous_version(&root)
            .ok_or_else(|| IdeError::not_found(format!("{id} has no earlier version to roll back to")))?;
        let current = plugin.manifest().version.clone();
        // The earlier version's consent: what it declared, as granted now where it overlaps.
        let grant = self.ledger.lock().get(&Subject::Installed(id.to_owned())).cloned();
        self.roll_back(id, &previous, &current, grant);
        self.changed();
        self.info_of(id)
    }

    /// Confirms a plugin waiting for consent (project plugins, new capabilities).
    pub fn grant(&self, id: &str, consent: &Consent) -> IdeResult<PluginInfo> {
        let _guard = self.lifecycle.lock();
        let plugin = self.get(id)?;
        if plugin.invalid {
            return Err(IdeError::invalid("the plugin's manifest is invalid"));
        }
        let hash = self.package_hash_of(&plugin);
        let extra = plugin.meta.lock().declared_extra.clone();
        let request = request_for(&plugin.subject(), plugin.manifest(), &hash, &extra);
        self.record_consent(&request, consent);
        self.stop(&plugin);
        if !self.state.lock().disabled.contains(id) {
            self.start(&plugin);
        }
        self.changed();
        self.info_of(id)
    }

    /// Grants or revokes one capability (Settings › Plugins › Permissions).
    /// Revoking a required one stops the plugin until consent is given again.
    pub fn set_capability(&self, id: &str, capability: &str, granted: bool) -> IdeResult<PluginInfo> {
        let _guard = self.lifecycle.lock();
        let plugin = self.get(id)?;
        let cap: Capability = capability.parse().map_err(IdeError::invalid)?;
        if !plugin.manifest().declares(&cap) && !plugin.meta.lock().declared_extra.contains(&cap) {
            return Err(IdeError::invalid(format!("plugin {id:?} does not declare {cap}")));
        }
        {
            let mut ledger = self.ledger.lock();
            let subject = plugin.subject();
            if ledger.get(&subject).is_none() {
                return Err(IdeError::invalid(format!("plugin {id:?} has not been confirmed yet")));
            }
            ledger.set(&subject, &cap, granted);
            if granted
                && let Capability::Process(program) = &cap
                && let Some(bin) = self.resolve_binary(program)
            {
                ledger.set_binary(&subject, &cap, bin);
            }
            self.save_ledger(&ledger);
        }
        self.stop(&plugin);
        if !self.state.lock().disabled.contains(id) {
            self.start(&plugin);
        }
        self.changed();
        self.info_of(id)
    }

    /// The program a `process:` grant allows, checked against the file
    /// approved for it. Errors ask the user to confirm again.
    pub fn program_for(&self, id: &str, program: &str) -> IdeResult<PathBuf> {
        let plugin = self.get(id)?;
        let cap = Capability::Process(program.to_owned());
        self.ledger
            .lock()
            .check_binary(&plugin.subject(), &cap)
            .map_err(|e| IdeError::new(ide_core::error::ErrorKind::PermissionDenied, e))
    }

    pub fn uninstall(&self, id: &str) -> IdeResult<()> {
        let _guard = self.lifecycle.lock();
        let plugin = self.get(id)?;
        if plugin.source != PluginSource::Installed {
            return Err(IdeError::invalid(
                "development plugins are removed by deleting them from .openidea/plugins or unlinking them",
            ));
        }
        // Its secrets (kept outside its directory, in the OS keychain on the desktop) go with it.
        let secrets: Vec<String> = plugin
            .manifest()
            .contributes
            .get(providers::SECRETS_POINT)
            .and_then(toml::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|s| s.get("name")?.as_str().map(str::to_owned))
            .collect();
        self.unload(id);
        {
            let store = self.shared.secrets.read().clone();
            for name in &secrets {
                if let Err(e) = store.set(id, name, None) {
                    tracing::warn!(plugin = %id, "cannot delete secret {name:?}: {e}");
                }
            }
        }
        // Every version (`<id>/<version>`), or the flat directory of an older install.
        let root = self.plugins_dir.join(id);
        std::fs::remove_dir_all(if root.is_dir() { root } else { plugin.dir().to_path_buf() })?;
        self.updates.lock().remove(id);
        // Its storage goes with it.
        let _ = std::fs::remove_dir_all(self.shared.data_dir.join(id));
        {
            let mut ledger = self.ledger.lock();
            ledger.remove(&plugin.subject());
            self.save_ledger(&ledger);
        }
        {
            let mut state = self.state.lock();
            state.disabled.remove(id);
            if state.theme.as_ref().is_some_and(|t| t.plugin == id) {
                state.theme = None;
            }
        }
        self.save_state();
        self.changed();
        Ok(())
    }

    /// Runs a plugin command, activating the plugin first when needed
    /// (`on-command`). Blocks for up to the configured time limit.
    pub fn run_command(
        &self,
        id: &str,
        command: &str,
        arg: Option<&str>,
        invocation: Invocation,
    ) -> IdeResult<Option<String>> {
        let (cmd, arg) = (command.to_owned(), arg.map(str::to_owned));
        self.code_call(id, invocation, "running the command", move |rt, inv| rt.run_command(&cmd, arg.as_deref(), inv))
    }

    /// Content of a declared view, or of a custom editor (`invocation.editor`
    /// is its document). Activates the plugin (`on-view`).
    pub fn render_view(
        &self,
        id: &str,
        view: &str,
        viewport: Option<ide_plugin::Viewport>,
        invocation: Invocation,
    ) -> IdeResult<ide_plugin::View> {
        self.declared_view(id, view)?;
        let view = view.to_owned();
        self.code_call(id, invocation, "rendering the view", move |rt, inv| rt.render_view(&view, viewport, inv))
    }

    /// A user action in a view or custom editor.
    pub fn view_event(
        &self,
        id: &str,
        view: &str,
        event: ide_plugin::ViewEvent,
        invocation: Invocation,
    ) -> IdeResult<()> {
        self.declared_view(id, view)?;
        let view = view.to_owned();
        self.code_call(id, invocation, "handling the view's event", move |rt, inv| {
            rt.view_event(&view, event.clone(), inv)
        })
    }

    /// Runs `program` for a `process` body of one of the plugin's views,
    /// streaming its output until it exits or `cancel` fires. Needs the
    /// plugin's `process:<program>` grant.
    #[allow(clippy::too_many_arguments)]
    pub fn stream_view_process(
        &self,
        id: &str,
        view: &str,
        program: &str,
        args: Vec<String>,
        cwd: Option<PathBuf>,
        cancel: &ide_core::CancellationToken,
        on_line: &dyn Fn(PluginOutputLine),
    ) -> IdeResult<Option<i32>> {
        self.declared_view(id, view)?;
        let plugin =
            self.plugins.read().get(id).cloned().ok_or_else(|| IdeError::not_found(format!("plugin {id:?}")))?;
        if !plugin.status().is_live() {
            return Err(IdeError::unavailable(format!("plugin {id:?} is not running")));
        }
        let cap = Capability::Process(program.to_owned());
        if !plugin.meta.lock().granted.iter().any(|g| g.covers(&cap)) {
            let denied = HostError::Denied(cap.to_string()).to_string();
            return Err(IdeError::new(ide_core::error::ErrorKind::PermissionDenied, denied));
        }
        let api = api::PluginApi { pkg: plugin.pkg.clone(), shared: self.shared.clone() };
        api.stream_process(program, args, cwd.as_deref(), cancel, on_line).map_err(|e| match e {
            HostError::Cancelled => IdeError::cancelled(),
            HostError::NotFound(m) => IdeError::not_found(m),
            HostError::Invalid(m) => IdeError::invalid(m),
            e => IdeError::unavailable(e.to_string()),
        })
    }

    /// `view` is a declared view or custom editor, or `"<view>/<item key>"`:
    /// the detail pane of an item of a `services` view.
    fn declared_view(&self, id: &str, view: &str) -> IdeResult<()> {
        let declared = match view.split_once('/') {
            Some((services, _)) => self
                .ui
                .items(ui_points::VIEWS, Some(id))
                .iter()
                .any(|i| i.key == services && i.decl["location"].as_str() == Some(ui_points::SERVICES_LOCATION)),
            None => [ui_points::VIEWS, ui_points::CUSTOM_EDITORS]
                .iter()
                .any(|point| self.ui.items(point, Some(id)).iter().any(|i| i.key == view)),
        };
        if declared { Ok(()) } else { Err(IdeError::not_found(format!("plugin {id:?} declares no view {view:?}"))) }
    }

    /// One call into a plugin's code for the UI: checks it may run (asking
    /// for missing consent), activates it, retries once when the instance was
    /// reclaimed meanwhile, and reports crashes.
    fn code_call<R: Send + 'static>(
        &self,
        id: &str,
        invocation: Invocation,
        what: &str,
        f: impl Fn(&mut Runtime, Invocation) -> Result<R, CallError> + Clone + Send + 'static,
    ) -> IdeResult<R> {
        let plugin = self.get(id)?;
        let client = invocation.client.clone();
        {
            let meta = plugin.meta.lock();
            let reason = match meta.status {
                PluginStatus::Disabled => Some(format!("plugin {id:?} is disabled")),
                PluginStatus::Static => Some(format!("plugin {id:?} has no code")),
                PluginStatus::NeedsConsent => Some(format!("plugin {id:?} is waiting for your permission")),
                PluginStatus::Failed => {
                    Some(format!("plugin {id:?} is not running: {}", meta.error.as_deref().unwrap_or("failed")))
                }
                PluginStatus::Active | PluginStatus::Inactive => None,
            };
            if let Some(reason) = reason {
                return Err(IdeError::unavailable(reason));
            }
        }
        let pending = plugin.meta.lock().pending.clone();
        if !pending.is_empty() {
            // Migrated from 0.1: ask for what was not granted automatically, on first use.
            self.emit(
                client.as_deref(),
                PluginEvent::ConsentRequested {
                    plugin_id: id.to_owned(),
                    capabilities: pending.iter().map(|c| CapabilityInfo::new(c, false, false)).collect(),
                },
            );
            return Err(IdeError::new(
                ide_core::error::ErrorKind::PermissionDenied,
                format!("plugin {id:?} needs your permission first"),
            ));
        }
        // Twice at most: the instance may be reclaimed between picking it and queueing the call.
        for attempt in 0..2 {
            let (actor, activated) = self.ensure_active(&plugin, client.as_deref())?;
            if activated {
                self.changed();
            }
            let started = Instant::now();
            let (call, inv) = (f.clone(), invocation.clone());
            let result = actor.call(None, move |rt| call(rt, inv));
            if !matches!(result, Err(ActorError::Stopped | ActorError::SoftTimeout | ActorError::Cancelled)) {
                let crashed = matches!(result, Err(ActorError::Call(CallError::Trap(_))));
                // Cancelling or a missing grant is not the plugin failing.
                let ok = match &result {
                    Ok(_) => true,
                    Err(ActorError::Call(CallError::Guest(e))) => !e.is_failure(),
                    Err(_) => false,
                };
                self.record_call(&plugin, started.elapsed(), ok, !crashed);
            }
            match result {
                Ok(value) => return Ok(value),
                Err(ActorError::Call(CallError::Guest(e))) => return Err(e.into()),
                Err(ActorError::Call(CallError::Trap(e))) => {
                    self.reap(&plugin, &actor, client.as_deref());
                    return Err(IdeError::internal(format!("plugin {id:?} {e}")));
                }
                Err(ActorError::Stopped | ActorError::SoftTimeout | ActorError::Cancelled) => {
                    self.reap(&plugin, &actor, client.as_deref());
                    if attempt == 1 {
                        break;
                    }
                }
            }
        }
        Err(IdeError::unavailable(format!("plugin {id:?} stopped before {what}; try again")))
    }

    /// Interrupts the plugin's running call, if any. Its instance is dropped
    /// and started again on next use; this does not count as a crash.
    pub fn cancel(&self, id: &str) {
        if let Some(actor) = self.plugins.read().get(id).and_then(|p| p.runtime.lock().clone()) {
            actor.cancel();
        }
    }

    /// Runs a `syntax-provider` call of the plugin contributing `language`,
    /// activating it on first use. `None` when no running plugin provides it
    /// (or the call failed: the editor then shows plain text).
    fn syntax_call<R: Send + 'static>(
        &self,
        language: &LanguageId,
        f: impl FnOnce(&mut Runtime, Duration) -> Result<R, CallError> + Send + 'static,
    ) -> Option<R> {
        let owner = self.languages.owner_of(language)?;
        let plugin = self.get(&owner).ok()?;
        {
            let meta = plugin.meta.lock();
            let usable =
                matches!(meta.status, PluginStatus::Active | PluginStatus::Inactive) && meta.pending.is_empty();
            // Known not to provide syntax (activated before without it).
            if !usable || (meta.stats.activations > 0 && !meta.has_syntax) {
                return None;
            }
        }
        plugin.manifest().wasm.as_ref()?;
        let (actor, activated) = self.ensure_active(&plugin, None).ok()?;
        if activated {
            self.changed();
        }
        if !plugin.meta.lock().has_syntax {
            return None;
        }
        // Edit path: stop waiting at the soft deadline (the result is dropped
        // but the instance kept); interrupt at the hard one.
        let started = Instant::now();
        let hard = self.limits.edit_hard;
        let result = actor.call(Some(self.limits.edit_soft), move |rt| f(rt, hard));
        self.finish_provider_call(&plugin, &actor, started, result)
    }

    /// Plugins' `runDetectors`, for [`ide_run::set_external_detection`].
    pub fn run_detection(&self) -> Arc<dyn ide_run::ExternalDetection> {
        Arc::new(run_detectors::PluginRunDetection { store: self.run_detectors.clone(), pins: self.pins.clone() })
    }

    /// The syntax of plugin languages, for [`ide_language::set_external_syntax`].
    pub fn syntax_provider(self: &Arc<Self>) -> Arc<dyn ide_language::ExternalSyntax> {
        Arc::new(PluginSyntax(Arc::downgrade(self)))
    }

    /// The UI reports which file its focused editor shows (`editor-focused`).
    pub fn set_active_file(&self, client: &str, path: Option<String>) {
        self.post_events(Some(client), vec![WorkbenchEvent::EditorFocused(path)]);
    }

    /// Where plugin secrets are kept (default: files under the plugins
    /// directory; the desktop app uses the OS keychain).
    pub fn set_secret_store(&self, store: Arc<dyn SecretStore>) {
        *self.shared.secrets.write() = store;
    }

    /// Stores (or, with `None`, deletes) a secret the plugin declares under
    /// `[[contributes.secrets]]`.
    pub fn set_secret(&self, id: &str, name: &str, value: Option<&str>) -> IdeResult<()> {
        let plugin = self.get(id)?;
        if !self.ui.items(providers::SECRETS_POINT, Some(plugin.id())).iter().any(|s| s.key == name) {
            return Err(IdeError::not_found(format!("plugin {id:?} declares no secret {name:?}")));
        }
        let value = value.map(str::trim).filter(|v| !v.is_empty());
        self.shared.secrets.read().set(plugin.id(), name, value).map_err(IdeError::internal)
    }

    /// The declared secrets of a plugin and whether each is set.
    pub fn secrets(&self, id: &str) -> IdeResult<Vec<(String, bool)>> {
        let plugin = self.get(id)?;
        let store = self.shared.secrets.read().clone();
        Ok(self
            .ui
            .items(providers::SECRETS_POINT, Some(plugin.id()))
            .into_iter()
            .map(|s| {
                let set = store.get(plugin.id(), &s.key).is_some();
                (s.key, set)
            })
            .collect())
    }

    /// What plugins see of the open projects (documents, edits, trust).
    pub fn set_workspace(&self, workspace: Option<Arc<dyn PluginWorkspace>>) {
        *self.shared.workspace.write() = workspace;
    }

    /// Every plugin status bar item: (plugin, item id, item).
    pub fn status_items(&self) -> Vec<(String, String, ide_plugin::StatusItem)> {
        self.shared.status_items()
    }

    /// The user cancelled a plugin task (`task_id` from `TaskStarted`).
    pub fn cancel_task(&self, task_id: &str) -> bool {
        task_id.parse().is_ok_and(|id| self.shared.cancel_task(id))
    }

    /// Kinds of workbench events some running or activatable plugin wants;
    /// the UI reports only these.
    pub fn event_kinds(&self) -> BTreeSet<EventKind> {
        let subs = self.shared.subscriptions.lock().clone();
        let mut out = BTreeSet::new();
        for p in self.plugins.read().values() {
            for kind in EventKind::ALL {
                if self.wants(p, kind, subs.get(p.id())) {
                    out.insert(kind);
                }
            }
        }
        out
    }

    /// Whether `plugin` gets `kind` events: subscribed at run time or with
    /// `on-event:<kind>`, the capability granted, and able to run.
    fn wants(&self, plugin: &LoadedPlugin, kind: EventKind, runtime: Option<&BTreeSet<EventKind>>) -> bool {
        let declared =
            plugin.manifest().activation.iter().any(|a| matches!(a, ActivationEvent::Event(k) if k == kind.name()));
        if !declared && !runtime.is_some_and(|s| s.contains(&kind)) {
            return false;
        }
        let meta = plugin.meta.lock();
        matches!(meta.status, PluginStatus::Active | PluginStatus::Inactive)
            && kind.capability().is_none_or(|cap| meta.granted.iter().any(|g| g.covers(&cap)))
    }

    /// Queues workbench events from window `client` for the plugins that want
    /// them; [`flush_events`](Self::flush_events) delivers them in batches.
    pub fn post_events(&self, client: Option<&str>, events: Vec<WorkbenchEvent>) {
        if events.is_empty() {
            return;
        }
        let subs = self.shared.subscriptions.lock().clone();
        let plugins: Vec<_> = self.plugins.read().values().cloned().collect();
        let now = Instant::now();
        let mut queues = self.queues.lock();
        for p in plugins {
            let wanted: Vec<WorkbenchEvent> =
                events.iter().filter(|e| self.wants(&p, e.kind(), subs.get(p.id()))).cloned().collect();
            if wanted.is_empty() {
                continue;
            }
            let queue = queues
                .entry((p.id().to_owned(), client.map(str::to_owned)))
                .or_insert_with(|| EventQueue { since: now, events: Vec::new() });
            queue.events.extend(wanted);
            let excess = queue.events.len().saturating_sub(MAX_QUEUED_EVENTS);
            queue.events.drain(..excess);
        }
    }

    /// Delivers queued events: to running plugins right away, to idle ones
    /// (which must be activated) after [`IDLE_BATCH`], so frequent events
    /// don't keep waking them. Call it a few times a second.
    pub fn flush_events(&self) {
        self.flush_events_at(Instant::now());
    }

    #[doc(hidden)]
    pub fn flush_events_at(&self, now: Instant) {
        let due: Vec<(QueueKey, Vec<WorkbenchEvent>)> = {
            let mut queues = self.queues.lock();
            let plugins = self.plugins.read();
            let keys: Vec<_> = queues
                .iter()
                .filter(|((id, _), q)| {
                    let running =
                        plugins.get(id).is_some_and(|p| p.runtime.lock().as_ref().is_some_and(|a| a.is_alive()));
                    running
                        || now.saturating_duration_since(q.since) >= IDLE_BATCH
                        || q.events.len() >= MAX_QUEUED_EVENTS / 2
                        || q.events.contains(&WorkbenchEvent::Scheduled)
                })
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter().filter_map(|k| queues.remove(&k).map(|q| (k, q.events))).collect()
        };
        let mut changed = false;
        for ((id, client), events) in due {
            changed |= self.deliver(&id, client, events);
        }
        // Batches that crashed since.
        let plugins: Vec<_> = self.plugins.read().values().cloned().collect();
        for p in plugins {
            let dead = p.runtime.lock().clone().filter(|a| !a.is_alive());
            if let Some(actor) = dead {
                self.reap(&p, &actor, None);
            }
        }
        if changed {
            self.changed();
        }
    }

    /// Waits (at most `timeout`) until every posted event batch was handled.
    /// Returns whether they all were.
    #[doc(hidden)]
    pub fn wait_events(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let busy = self.plugins.read().values().any(|p| p.batches.lock().pending > 0);
            if !busy {
                self.flush_events_at(Instant::now());
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Hands one batch to the plugin's `event-handler.handle` without waiting
    /// for it. A newer batch of the same kinds cooperatively cancels the one
    /// being handled (a save while the previous save is still being checked).
    /// Returns whether the plugin was activated.
    fn deliver(&self, id: &str, client: Option<String>, events: Vec<WorkbenchEvent>) -> bool {
        let Ok(plugin) = self.get(id) else { return false };
        if !plugin.meta.lock().pending.is_empty() {
            return false;
        }
        let Ok((actor, activated)) = self.ensure_active(&plugin, client.as_deref()) else { return false };
        let invocation = Invocation {
            workspace_root: client.as_deref().and_then(|c| self.shared.project_of(c)),
            client: client.clone(),
            editor: None,
        };
        let kinds: BTreeSet<EventKind> = events.iter().map(WorkbenchEvent::kind).collect();
        {
            let mut batches = plugin.batches.lock();
            if batches.running.as_ref() == Some(&kinds) && !kinds.contains(&EventKind::Scheduled) {
                actor.cancel_soft();
            }
            batches.pending += 1;
        }
        let started = Instant::now();
        let (start, finish) = (plugin.batches.clone(), plugin.batches.clone());
        let done_plugin = plugin.clone();
        actor.post(
            move |rt| {
                start.lock().running = Some(kinds);
                rt.handle_events(events, invocation)
            },
            move |result| {
                let crashed = matches!(result, Err(ActorError::Call(CallError::Trap(_))));
                if !matches!(result, Err(ActorError::Stopped)) {
                    done_plugin.record_call(started.elapsed(), result.is_ok(), !crashed);
                }
                match &result {
                    Err(ActorError::Call(CallError::Guest(e))) => {
                        tracing::debug!(plugin = %done_plugin.id(), "events: {e}")
                    }
                    Err(ActorError::Call(CallError::Trap(e))) => {
                        tracing::warn!(plugin = %done_plugin.id(), "events: {e}")
                    }
                    _ => {}
                }
                let mut batches = finish.lock();
                batches.pending = batches.pending.saturating_sub(1);
                batches.running = None;
            },
        );
        activated
    }

    /// Selects a plugin theme (`None` restores the built-in theme).
    pub fn set_theme(&self, selection: Option<(&str, &str)>) -> IdeResult<Option<ActiveTheme>> {
        if let Some((plugin, theme)) = selection {
            self.get(plugin)?;
            if !self.ui.items(theme::POINT_ID, Some(plugin)).iter().any(|t| t.key == theme) {
                return Err(IdeError::not_found(format!("plugin {plugin:?} has no theme {theme:?}")));
            }
        }
        self.state.lock().theme =
            selection.map(|(plugin, theme)| ThemeRef { plugin: plugin.into(), theme: theme.into(), frame: None });
        self.save_state();
        let active = self.active_theme();
        *self.announced_theme.lock() = active.clone();
        self.emit(None, PluginEvent::ThemeChanged { theme: active.clone() });
        Ok(active)
    }

    /// Records the selected theme's resolved window frame colour (`#rgb`,
    /// `#rrggbb` or `#rrggbbaa`); ignored without a selected theme.
    pub fn set_theme_frame(&self, frame: Option<&str>) -> IdeResult<()> {
        if let Some(f) = frame
            && !is_hex_color(f)
        {
            return Err(IdeError::invalid(format!("not a hex colour: {f:?}")));
        }
        let changed = match self.state.lock().theme.as_mut() {
            Some(t) if t.frame.as_deref() != frame => {
                t.frame = frame.map(str::to_owned);
                true
            }
            _ => false,
        };
        if changed {
            self.save_state();
        }
        Ok(())
    }

    /// Frame colour for a new window: the recorded one of the selected theme,
    /// unless its plugin is disabled. Available before plugins are loaded.
    pub fn startup_frame(&self) -> Option<String> {
        let state = self.state.lock();
        let t = state.theme.as_ref()?;
        if state.disabled.contains(&t.plugin) {
            return None;
        }
        t.frame.clone()
    }

    /// The selected plugin theme, when its plugin is enabled and live.
    pub fn active_theme(&self) -> Option<ActiveTheme> {
        let sel = self.state.lock().theme.clone()?;
        let item = self.ui.items(theme::POINT_ID, Some(&sel.plugin)).into_iter().find(|t| t.key == sel.theme)?;
        let theme: ThemeDef = serde_json::from_value(item.decl).ok()?;
        Some(ActiveTheme { plugin_id: sel.plugin, theme })
    }

    /// Languages contributed by live plugins.
    pub fn languages(&self) -> Vec<LanguageConfig> {
        self.languages.all()
    }

    /// Plugin languages for a remote project's server, with the programs each
    /// plugin was granted ([`remote::RemotePluginLanguages::sync`]).
    pub fn remote_languages(&self) -> Vec<remote::RemoteLanguage> {
        let plugins = self.plugins.read();
        let ledger = self.ledger.lock();
        self.languages
            .with_owners()
            .into_iter()
            .map(|(plugin, language)| {
                let grant = plugins.get(&plugin).and_then(|p| ledger.get(&p.subject()).cloned());
                let granted = ide_language::plugin_point::required_capabilities(&language)
                    .into_iter()
                    .filter(|cap| grant.as_ref().is_some_and(|g| g.confirmed && g.has(cap)))
                    .filter_map(|cap| match cap {
                        Capability::Process(program) => Some(program),
                        _ => None,
                    })
                    .collect();
                remote::RemoteLanguage { plugin, language, granted }
            })
            .collect()
    }

    /// The overlay of plugin languages (for the language registry).
    pub fn language_store(&self) -> &Arc<PluginLanguages> {
        &self.languages
    }

    /// Plugin packages found in `dirs` (first occurrence of an id wins). Invalid
    /// manifests are skipped; packages that fail validation carry a `problem`.
    pub fn catalog(&self, dirs: &[PathBuf]) -> Vec<CatalogPlugin> {
        let mut out: Vec<CatalogPlugin> = Vec::new();
        for dir in dirs.iter().flat_map(|d| package_dirs(d)) {
            let Ok(m) = Manifest::load(&dir) else { continue };
            if out.iter().any(|c| c.id == m.id) {
                continue;
            }
            let pkg = Package::new(m.clone(), dir.clone());
            let problem = match self.registry.prepare(&pkg) {
                Err(e) => Some(e),
                Ok(_) => m
                    .wasm
                    .as_ref()
                    .filter(|w| !dir.join(w).is_file())
                    .map(|w| format!("{} is missing; build the plugin first", w.display())),
            };
            out.push(CatalogPlugin {
                has_code: m.wasm.is_some(),
                capabilities: m
                    .capabilities
                    .all()
                    .map(|c| CapabilityInfo::new(c, m.capabilities.is_optional(c), false))
                    .collect(),
                contributions: counts(&m),
                id: m.id,
                name: m.name,
                version: m.version,
                description: m.description,
                authors: m.authors,
                homepage: m.homepage,
                change_notes: m.change_notes,
                path: dir.into(),
                problem,
            });
        }
        out.sort_by_key(|a| a.name.to_lowercase());
        out
    }

    /// Deactivates every plugin (also done on drop).
    pub fn shutdown(&self) {
        let actors: Vec<_> = self.plugins.read().values().filter_map(|p| p.runtime.lock().take()).collect();
        for a in &actors {
            a.stop(false);
        }
        for a in actors {
            a.stop(true);
        }
    }

    /// Periodic upkeep (every few seconds): reports crashes nobody waited
    /// for, reclaims idle instances and fires due `on-schedule` activations
    /// (which don't keep a plugin alive: it is reclaimed again when idle).
    pub fn tick(&self) {
        self.tick_at(Instant::now());
    }

    /// [`tick`](Self::tick) as if it were `now` (schedules only; tests).
    #[doc(hidden)]
    pub fn tick_at(&self, now: Instant) {
        let plugins: Vec<_> = self.plugins.read().values().cloned().collect();
        let mut changed = false;
        for p in plugins {
            let actor = p.runtime.lock().clone();
            if let Some(a) = &actor {
                if !a.is_alive() {
                    self.reap(&p, a, None);
                    continue;
                }
                if self.limits.idle_timeout.is_some_and(|idle| !a.is_busy() && a.idle_for() >= idle) {
                    changed |= self.reclaim(&p, a);
                }
            }
            let every = p.manifest().activation.iter().filter_map(|e| match e {
                ActivationEvent::Schedule(secs) => Some(Duration::from_secs(u64::from(*secs).max(1))),
                _ => None,
            });
            let Some(every) = every.min() else { continue };
            let due = {
                let mut meta = p.meta.lock();
                let next = *meta.next_schedule.get_or_insert(now + every);
                if next > now {
                    false
                } else {
                    meta.next_schedule = Some(now + every);
                    meta.status == PluginStatus::Inactive && meta.pending.is_empty()
                }
            };
            let restricted = p.dev_root.as_deref().is_some_and(|root| !(self.project_policy.read())(root));
            if due && !restricted && self.startup_finished.load(Ordering::Acquire) {
                // Activates it if needed and calls `handle([scheduled])`.
                self.queues
                    .lock()
                    .entry((p.id().to_owned(), None))
                    .or_insert_with(|| EventQueue { since: now, events: Vec::new() })
                    .events
                    .push(WorkbenchEvent::Scheduled);
            }
        }
        if changed {
            self.changed();
        }
        self.flush_events_at(now);
    }

    /// Number of plugins with a live Wasm instance.
    pub fn instances(&self) -> usize {
        self.plugins.read().values().filter(|p| p.runtime.lock().as_ref().is_some_and(|a| a.is_alive())).count()
    }

    // ---- internals ----

    fn get(&self, id: &str) -> IdeResult<Arc<LoadedPlugin>> {
        let plugin =
            self.plugins.read().get(id).cloned().ok_or_else(|| IdeError::not_found(format!("no plugin {id:?}")))?;
        if plugin.dev_root.as_deref().is_some_and(|root| !(self.project_policy.read())(root)) {
            return Err(IdeError::unavailable("Project is in Restricted Mode"));
        }
        Ok(plugin)
    }

    fn is_loaded_from(&self, dir: &Path) -> bool {
        self.plugins.read().values().any(|p| p.dir() == dir)
    }

    /// Parses and validates a package directory; nothing takes effect.
    fn validate_package(&self, src: &Path) -> IdeResult<(Package, ide_extension::PreparedSet)> {
        let manifest = Manifest::load(src).map_err(IdeError::invalid)?;
        let pkg = Package::new(manifest, src.to_path_buf());
        let set = self.registry.prepare(&pkg).map_err(IdeError::invalid)?;
        if let Some(wasm) = &pkg.manifest.wasm {
            if !src.join(wasm).is_file() {
                return Err(IdeError::invalid(format!(
                    "{} is missing (referenced by plugin.toml); build the plugin first",
                    wasm.display()
                )));
            }
            // Precompiled on the way: the installed copy has the same bytes.
            let component =
                self.engine.compile_cached(&src.join(wasm), &self.component_cache()).map_err(IdeError::invalid)?;
            self.engine.check_component(&component).map_err(IdeError::invalid)?;
        }
        Ok((pkg, set))
    }

    /// Loads one package and starts it unless disabled. Returns the plugin id.
    fn load_dir(&self, dir: &Path, source: PluginSource, dev_root: Option<PathBuf>) -> String {
        let (manifest, error) = match Manifest::load(dir) {
            Ok(m) => (m, None),
            Err(e) => (placeholder_manifest(dir), Some(e)),
        };
        let invalid = error.is_some();
        let id = manifest.id.clone();
        let mut pkg = Package::new(manifest, dir.to_path_buf());
        if source == PluginSource::Installed
            && let Ok(digest) = std::fs::read_to_string(dir.join(install::HASH_FILE))
            && !digest.trim().is_empty()
        {
            // Installed copies don't change: their validated UI declarations are indexed.
            pkg = pkg.with_digest(digest.trim());
        }
        let plugin = Arc::new(LoadedPlugin {
            pkg,
            invalid,
            source,
            dev_root,
            meta: Mutex::new(Meta::new()),
            batches: Arc::default(),
            runtime: Mutex::new(None),
        });
        {
            let mut plugins = self.plugins.write();
            if let Some(existing) = plugins.get(&id) {
                tracing::warn!(
                    "plugin {id:?} at {} ignored: already loaded from {}",
                    dir.display(),
                    existing.dir().display()
                );
                return id;
            }
            plugins.insert(id.clone(), plugin.clone());
        }
        if let Some(e) = error {
            tracing::warn!("plugin {}: {e}", dir.display());
            let mut meta = plugin.meta.lock();
            meta.status = PluginStatus::Failed;
            meta.error = Some(e);
        } else if !self.state.lock().disabled.contains(&id) {
            self.start(&plugin);
        }
        id
    }

    fn unload(&self, id: &str) {
        let Some(plugin) = self.plugins.write().remove(id) else { return };
        self.stop(&plugin);
    }

    /// Validates, checks grants and commits the contributions; activates code
    /// whose activation event already fired.
    fn start(&self, plugin: &Arc<LoadedPlugin>) {
        self.registry.dispose_plugin(plugin.id());
        if plugin.source == PluginSource::Installed
            && let Some(reason) = self.revoked_reason(plugin.id(), &plugin.manifest().version, plugin.dir())
        {
            return self.set_failed(plugin, format!("revoked: {reason}"));
        }
        if plugin.source == PluginSource::Installed {
            let publisher = self.verified_publisher(plugin.dir());
            plugin.meta.lock().publisher = publisher;
        }
        let set = match self.registry.prepare(&plugin.pkg) {
            Ok(set) => set,
            Err(e) => return self.set_failed(plugin, e),
        };
        let hash = self.package_hash_of(plugin);
        let request = request_for(&plugin.subject(), plugin.manifest(), &hash, &set.capabilities);
        let decision = {
            let mut ledger = self.ledger.lock();
            let d = ledger.decide(&request);
            self.save_ledger(&ledger);
            d
        };
        {
            let mut meta = plugin.meta.lock();
            meta.warnings = set.warnings.clone();
            meta.declared_extra = set.capabilities.clone();
            meta.error = None;
        }
        let (granted, pending) = match decision {
            Decision::Allowed { granted, pending } => (granted, pending),
            Decision::NeedsConfirmation { new, .. } => {
                let mut meta = plugin.meta.lock();
                meta.status = PluginStatus::NeedsConsent;
                meta.pending = new;
                meta.granted.clear();
                return;
            }
        };
        if let Err(e) = self.registry.commit(set) {
            return self.set_failed(plugin, e);
        }
        {
            let mut meta = plugin.meta.lock();
            meta.granted = granted;
            meta.pending = pending;
            meta.status = if plugin.manifest().wasm.is_some() { PluginStatus::Inactive } else { PluginStatus::Static };
        }
        let eager = plugin.manifest().activation.contains(&ActivationEvent::StartupFinished)
            && self.startup_finished.load(Ordering::Acquire);
        if eager {
            let _ = self.ensure_active(plugin, None);
        }
    }

    /// The plugin's running instance, instantiating and activating its code
    /// first if needed. Returns whether it was activated now.
    fn ensure_active(&self, plugin: &Arc<LoadedPlugin>, client: Option<&str>) -> IdeResult<(Arc<Actor>, bool)> {
        let mut runtime = plugin.runtime.lock();
        if let Some(actor) = runtime.as_ref() {
            if actor.is_alive() {
                return Ok((actor.clone(), false));
            }
            // Crashed while nobody was waiting for it.
            let actor = actor.clone();
            drop(runtime);
            self.reap(plugin, &actor, client);
            runtime = plugin.runtime.lock();
            if let Some(actor) = runtime.as_ref().filter(|a| a.is_alive()) {
                return Ok((actor.clone(), false));
            }
        }
        if plugin.status() != PluginStatus::Inactive {
            return Err(IdeError::unavailable(format!("plugin {:?} cannot be activated", plugin.id())));
        }
        if let Some(wait) = plugin.meta.lock().retry_at.map(|at| at.saturating_duration_since(Instant::now()))
            && !wait.is_zero()
        {
            return Err(IdeError::unavailable(format!(
                "plugin {:?} crashed and restarts in {:.1}s",
                plugin.id(),
                wait.as_secs_f64()
            )));
        }
        let Some(wasm) = plugin.manifest().wasm.clone() else {
            return Err(IdeError::unavailable(format!("plugin {:?} has no code", plugin.id())));
        };
        let started = Instant::now();
        let granted = plugin.meta.lock().granted.clone();
        let api: Arc<dyn HostApi> = Arc::new(api::PluginApi { pkg: plugin.pkg.clone(), shared: self.shared.clone() });
        let setup = RuntimeSetup {
            plugin_id: plugin.id().to_owned(),
            version: plugin.manifest().version.clone(),
            granted,
            host: api,
            limits: self.limits,
        };
        let instance = self
            .engine
            .compile_cached(&plugin.dir().join(wasm), &self.component_cache())
            .and_then(|component| Runtime::instantiate(&self.engine, &component, setup));
        let mut rt = match instance {
            Ok(rt) => rt,
            Err(e) => {
                drop(runtime);
                if let Some(message) = self.roll_back_failed_update(plugin, &e, client) {
                    return Err(IdeError::unavailable(message));
                }
                self.fail(plugin, &e, client);
                return Err(IdeError::internal(format!("plugin {:?} {e}", plugin.id())));
            }
        };
        let crash = match rt.activate() {
            Ok(_) => None,
            Err(CallError::Trap(e)) => Some(format!("activation {e}")),
            Err(CallError::Guest(e)) => {
                drop(runtime);
                let e = format!("activation failed: {e}");
                if let Some(message) = self.roll_back_failed_update(plugin, &e, client) {
                    return Err(IdeError::unavailable(message));
                }
                self.fail(plugin, &e, client);
                return Err(IdeError::internal(format!("plugin {:?} {e}", plugin.id())));
            }
        };
        if let Some(e) = crash {
            drop(runtime);
            if let Some(message) = self.roll_back_failed_update(plugin, &e, client) {
                return Err(IdeError::unavailable(message));
            }
            self.crashed(plugin, &e, client);
            return Err(IdeError::internal(format!("plugin {:?} {e}", plugin.id())));
        }
        // An update's first start: confirmed.
        self.updates.lock().remove(plugin.id());
        let has_syntax = rt.has_syntax();
        let actor = match Actor::spawn(plugin.id(), rt) {
            Ok(a) => Arc::new(a),
            Err(e) => return Err(IdeError::internal(format!("plugin {:?}: {e}", plugin.id()))),
        };
        *runtime = Some(actor.clone());
        let mut meta = plugin.meta.lock();
        meta.status = PluginStatus::Active;
        meta.has_syntax = has_syntax;
        meta.stats.activations += 1;
        meta.stats.activation_ms = started.elapsed().as_secs_f64() * 1000.0;
        Ok((actor, true))
    }

    fn record_call(&self, plugin: &LoadedPlugin, elapsed: Duration, ok: bool, healthy: bool) {
        plugin.record_call(elapsed, ok, healthy);
    }

    /// Clears `actor` from the plugin if it ended, reporting its crash once.
    fn reap(&self, plugin: &LoadedPlugin, actor: &Arc<Actor>, client: Option<&str>) {
        if actor.is_alive() {
            return;
        }
        {
            let mut runtime = plugin.runtime.lock();
            if runtime.as_ref().is_some_and(|r| Arc::ptr_eq(r, actor)) {
                *runtime = None;
            }
        }
        let Some(error) = actor.take_crash() else { return };
        self.clear_plugin_navigation(plugin.id());
        if error.starts_with(CANCELLED) {
            // Cancelled on request: restart on next use, no backoff.
            let mut meta = plugin.meta.lock();
            if meta.status == PluginStatus::Active {
                meta.status = PluginStatus::Inactive;
            }
            drop(meta);
            self.changed();
            return;
        }
        self.crashed(plugin, &error, client);
    }

    /// A trap dropped the plugin's instance: restart it on next use after a
    /// backoff, or stop it for the session after too many crashes in a row.
    fn crashed(&self, plugin: &LoadedPlugin, error: &str, client: Option<&str>) {
        let failures = {
            let mut meta = plugin.meta.lock();
            meta.failures += 1;
            meta.stats.crashes += 1;
            meta.failures
        };
        if failures >= self.limits.max_failures.max(1) {
            let error =
                if failures > 1 { format!("{error} (crashed {failures} times in a row)") } else { error.to_owned() };
            return self.fail(plugin, &error, client);
        }
        let delay = self.limits.backoff(failures);
        tracing::warn!(plugin = %plugin.id(), "crashed ({failures}), restarting in {delay:?}: {error}");
        {
            let mut meta = plugin.meta.lock();
            if meta.status == PluginStatus::Active {
                meta.status = PluginStatus::Inactive;
            }
            meta.error = Some(error.to_owned());
            meta.retry_at = Some(Instant::now() + delay);
        }
        if failures == 1 {
            self.emit(
                client,
                PluginEvent::Notification {
                    plugin_id: plugin.id().to_owned(),
                    level: NotificationLevel::Warning,
                    title: format!("Plugin \u{201c}{}\u{201d} crashed", plugin.manifest().name),
                    body: format!("{error}\nIt restarts the next time it is needed."),
                },
            );
        }
        self.changed();
    }

    /// Ends an idle instance; the plugin activates again on its next event.
    fn reclaim(&self, plugin: &LoadedPlugin, actor: &Arc<Actor>) -> bool {
        {
            let mut runtime = plugin.runtime.lock();
            if !runtime.as_ref().is_some_and(|r| Arc::ptr_eq(r, actor)) || actor.is_busy() {
                return false;
            }
            *runtime = None;
        }
        actor.stop(false);
        let mut meta = plugin.meta.lock();
        if meta.status == PluginStatus::Active {
            meta.status = PluginStatus::Inactive;
        }
        meta.stats.reclaims += 1;
        tracing::debug!(plugin = %plugin.id(), "reclaimed after {:?} idle", actor.idle_for());
        true
    }

    fn stop(&self, plugin: &LoadedPlugin) {
        self.clear_plugin_navigation(plugin.id());
        if let Some(actor) = plugin.runtime.lock().take() {
            actor.stop(true);
        }
        self.registry.dispose_plugin(plugin.id());
        self.shared.clear_plugin(plugin.id(), true);
        self.queues.lock().retain(|(id, _), _| id != plugin.id());
    }

    fn set_failed(&self, plugin: &LoadedPlugin, error: String) {
        self.clear_plugin_navigation(plugin.id());
        tracing::warn!(plugin = %plugin.id(), "{error}");
        self.registry.dispose_plugin(plugin.id());
        let mut meta = plugin.meta.lock();
        meta.status = PluginStatus::Failed;
        meta.error = Some(error);
    }

    fn fail(&self, plugin: &LoadedPlugin, error: &str, client: Option<&str>) {
        self.clear_plugin_navigation(plugin.id());
        tracing::warn!(plugin = %plugin.id(), "disabled after failure: {error}");
        if let Some(actor) = plugin.runtime.lock().take() {
            actor.stop(false);
        }
        self.shared.clear_plugin(plugin.id(), true);
        self.set_failed(plugin, error.to_owned());
        self.emit(
            client,
            PluginEvent::Notification {
                plugin_id: plugin.id().to_owned(),
                level: NotificationLevel::Error,
                title: format!("Plugin \u{201c}{}\u{201d} was disabled", plugin.manifest().name),
                body: error.to_owned(),
            },
        );
        self.changed();
    }

    /// Contributions or statuses changed: tell the UI and re-announce the theme if it changed.
    fn changed(&self) {
        // Held by this thread when called from a grant change, which refreshed them already.
        if let Some(ledger) = self.ledger.try_lock() {
            self.refresh_pins(&ledger);
        }
        self.emit(None, PluginEvent::CommandsChanged);
        let languages = self.languages.revision();
        if self.announced_languages.swap(languages, Ordering::AcqRel) != languages {
            self.emit(None, PluginEvent::LanguagesChanged);
        }
        let active = self.active_theme();
        let mut announced = self.announced_theme.lock();
        if *announced != active {
            *announced = active.clone();
            drop(announced);
            self.emit(None, PluginEvent::ThemeChanged { theme: active });
        }
    }

    fn emit(&self, client: Option<&str>, event: PluginEvent) {
        self.sink.emit(client, event);
    }

    fn save_state(&self) {
        let json = serde_json::to_string_pretty(&*self.state.lock()).unwrap_or_default();
        if let Err(e) = std::fs::write(self.plugins_dir.join(STATE_FILE), json) {
            tracing::warn!("saving plugin state: {e}");
        }
    }

    fn save_ledger(&self, ledger: &Ledger) {
        if let Err(e) = ledger.save() {
            tracing::warn!("saving plugin grants: {e}");
        }
        self.refresh_pins(ledger);
        // Grants of programs that exist only on a remote host change no local pin,
        // but what a remote server may start (`LanguagesChanged` re-syncs it).
        if !self.languages.with_owners().is_empty() {
            self.languages.invalidate();
        }
    }

    /// Recomputes the approved programs of every plugin; plugin languages
    /// pick up a change on their next lookup.
    fn refresh_pins(&self, ledger: &Ledger) {
        let mut pins = HashMap::new();
        for plugin in self.plugins.read().values() {
            let subject = plugin.subject();
            let declared =
                plugin.manifest().capabilities.all().cloned().chain(plugin.meta.lock().declared_extra.clone());
            for cap in declared.filter(|c| matches!(c, Capability::Process(_))) {
                if let Some(bin) = ledger.pinned_binary(&subject, &cap) {
                    pins.insert(
                        (plugin.id().to_owned(), cap.to_string()),
                        ProgramPin { path: bin.path, hash: bin.hash },
                    );
                }
            }
        }
        let mut current = self.pins.write();
        if *current != pins {
            *current = pins;
            drop(current);
            self.languages.invalidate();
        }
    }

    fn links(&self) -> Links {
        std::fs::read_to_string(self.plugins_dir.join(LINKS_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_links(&self, links: &Links) -> IdeResult<()> {
        let json = serde_json::to_string_pretty(links).map_err(|e| IdeError::internal(e.to_string()))?;
        std::fs::write(self.plugins_dir.join(LINKS_FILE), json)?;
        Ok(())
    }

    /// The installed package's recorded hash; development plugins are granted by path.
    fn package_hash_of(&self, plugin: &LoadedPlugin) -> String {
        if plugin.source != PluginSource::Installed {
            return String::new();
        }
        let file = plugin.dir().join(install::HASH_FILE);
        if let Ok(h) = std::fs::read_to_string(&file) {
            return h.trim().to_owned();
        }
        // Installed before hashes were recorded: hash once and remember.
        let files = self.registry.prepare(&plugin.pkg).map(|s| s.files).unwrap_or_default();
        let files: Vec<PathBuf> = files.into_iter().chain(plugin.manifest().wasm.clone()).collect();
        let hash = ledger::package_hash(plugin.dir(), &files).unwrap_or_default();
        let _ = std::fs::write(&file, &hash);
        hash
    }

    /// One-time migration from 0.1, where declaring a permission granted it.
    fn migrate_grants(&self, installed: &[PathBuf]) {
        let mut ledger = self.ledger.lock();
        if !ledger.needs_migration() {
            return;
        }
        let manifests: Vec<Manifest> = installed.iter().filter_map(|d| Manifest::load(d).ok()).collect();
        let requests: Vec<Request<'_>> =
            manifests.iter().map(|m| request_for(&Subject::Installed(m.id.clone()), m, "", &[])).collect();
        ledger.migrate(&requests);
        self.save_ledger(&ledger);
    }

    fn record_consent(&self, request: &Request<'_>, consent: &Consent) {
        let accepted: Vec<Capability> = request.optional.iter().filter(|c| consent.accepts(c)).cloned().collect();
        let binaries: BTreeMap<String, BinaryGrant> = request
            .required
            .iter()
            .chain(&accepted)
            .filter_map(|c| match c {
                Capability::Process(program) => self.resolve_binary(program).map(|b| (c.to_string(), b)),
                _ => None,
            })
            .collect();
        let mut ledger = self.ledger.lock();
        ledger.confirm(request, &accepted, binaries);
        self.save_ledger(&ledger);
    }

    fn resolve_binary(&self, program: &str) -> Option<BinaryGrant> {
        let path_var = (self.path_var.read())();
        let path = ledger::resolve_program(program, path_var.as_deref())
            .map_err(|e| tracing::info!("process:{program}: {e}"))
            .ok()?;
        let hash = ledger::file_hash(&path).ok()?;
        Some(BinaryGrant { path, hash })
    }

    fn info(&self, p: &LoadedPlugin) -> PluginInfo {
        let m = p.manifest();
        // The ledger before a plugin's `meta`, as everywhere (`refresh_pins` holds the
        // ledger and locks each plugin's): the other order deadlocks.
        let grant = self.ledger.lock().get(&p.subject()).cloned();
        let meta = p.meta.lock();
        let granted = |c: &Capability| grant.as_ref().is_some_and(|g| g.confirmed && g.has(c));
        let mut capabilities: Vec<CapabilityInfo> =
            m.capabilities.all().map(|c| CapabilityInfo::new(c, m.capabilities.is_optional(c), granted(c))).collect();
        for extra in &meta.declared_extra {
            if !m.declares(extra) {
                capabilities.push(CapabilityInfo::new(extra, true, granted(extra)));
            }
        }
        PluginInfo {
            id: m.id.clone(),
            name: m.name.clone(),
            version: m.version.clone(),
            description: m.description.clone(),
            authors: m.authors.clone(),
            homepage: m.homepage.clone(),
            change_notes: m.change_notes.clone(),
            source: p.source,
            path: p.dir().to_path_buf().into(),
            enabled: !self.state.lock().disabled.contains(&m.id),
            status: meta.status,
            error: meta.error.clone(),
            has_code: m.wasm.is_some(),
            capabilities,
            contributions: self.registry.contributions(&m.id),
            activation: m.activation.iter().map(ToString::to_string).collect(),
            warnings: meta.warnings.clone(),
            stats: PluginStats { p95_call_ms: meta.p95(), ..meta.stats },
            publisher: meta.publisher.clone(),
            previous_version: (p.source == PluginSource::Installed)
                .then(|| install::previous_version(&self.plugins_dir.join(&m.id)))
                .flatten(),
        }
    }
}

impl Drop for PluginHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn request_for<'a>(subject: &Subject, m: &'a Manifest, hash: &'a str, declared: &[Capability]) -> Request<'a> {
    let mut optional = m.capabilities.optional.clone();
    // What declarations need (a language server's `process:`) is optional:
    // refusing it keeps the rest of the plugin working.
    for cap in declared {
        if !m.declares(cap) && !optional.contains(cap) {
            optional.push(cap.clone());
        }
    }
    Request {
        subject: subject.clone(),
        plugin_id: &m.id,
        version: &m.version,
        package_hash: hash,
        required: m.capabilities.required.clone(),
        optional,
    }
}

fn counts(m: &Manifest) -> Vec<ContributionCount> {
    m.declaration_counts().into_iter().map(|(point, count)| ContributionCount { point, count }).collect()
}

fn activation_matches(declared: &ActivationEvent, fired: &ActivationEvent) -> bool {
    match (declared, fired) {
        (ActivationEvent::Language(a), ActivationEvent::Language(b)) => a == b || a == "*",
        (ActivationEvent::View(a), ActivationEvent::View(b)) => a == b,
        (ActivationEvent::File(glob), ActivationEvent::File(path)) => glob_match(glob, path),
        _ => false,
    }
}

/// `**` matches across `/`, `*` and `?` within one segment.
fn glob_match(glob: &str, path: &str) -> bool {
    fn go(p: &[u8], s: &[u8]) -> bool {
        match p.first() {
            None => s.is_empty(),
            Some(b'*') if p.get(1) == Some(&b'*') => {
                let rest = p[2..].strip_prefix(b"/").unwrap_or(&p[2..]);
                if rest.is_empty() {
                    return true;
                }
                (0..=s.len()).any(|i| (i == 0 || s[i - 1] == b'/') && go(rest, &s[i..])) || go(rest, s)
            }
            Some(b'*') => (0..=s.len()).take_while(|&i| i == 0 || s[i - 1] != b'/').any(|i| go(&p[1..], &s[i..])),
            Some(b'?') => s.first().is_some_and(|c| *c != b'/') && go(&p[1..], &s[1..]),
            Some(c) => s.first() == Some(c) && go(&p[1..], &s[1..]),
        }
    }
    go(glob.as_bytes(), path.as_bytes())
}

fn is_hex_color(s: &str) -> bool {
    s.strip_prefix('#').is_some_and(|h| matches!(h.len(), 3 | 6 | 8) && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Subdirectories of `dir` that contain a `plugin.toml`, sorted.
/// The active version of every installed plugin (`<id>/<version>`, or `<id>`
/// for installs from before versioning).
fn package_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.')))
        .filter_map(|p| install::active_dir(&p))
        .collect();
    dirs.sort();
    dirs
}

/// Stand-in for a package whose manifest failed to parse, so it still shows up (as failed).
fn placeholder_manifest(dir: &Path) -> Manifest {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Manifest {
        id: format!("invalid-{}", name.to_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), "-")),
        name,
        version: "0.0.0".into(),
        description: String::new(),
        authors: Vec::new(),
        homepage: None,
        license: None,
        change_notes: None,
        declared_categories: Vec::new(),
        engine: ide_extension::ENGINE_VERSION.into(),
        legacy: false,
        wasm: None,
        activation: Vec::new(),
        capabilities: Default::default(),
        contributes: Default::default(),
    }
}

/// [`PluginHost::syntax_provider`]: plugin languages' `syntax-provider` exports.
struct PluginSyntax(std::sync::Weak<PluginHost>);

type SyntaxFn<R> = fn(&mut Runtime, &str, &str, Duration) -> Result<R, CallError>;

/// A syntax call with its own copies of the arguments, to run on the plugin's thread.
fn owned<R: 'static>(
    lang: &LanguageId,
    text: &str,
    f: SyntaxFn<R>,
) -> impl FnOnce(&mut Runtime, Duration) -> Result<R, CallError> + Send + 'static {
    let (lang, text) = (lang.as_str().to_owned(), text.to_owned());
    move |rt, timeout| f(rt, &lang, &text, timeout)
}

impl ide_language::ExternalSyntax for PluginSyntax {
    fn highlights(&self, lang: &LanguageId, text: &str) -> Option<Vec<ide_language::ExternalToken>> {
        let tokens = self.0.upgrade()?.syntax_call(lang, owned(lang, text, Runtime::syntax_highlights))?;
        Some(
            tokens
                .into_iter()
                .map(|t| ide_language::ExternalToken { start: t.start, end: t.end, kind: t.kind })
                .collect(),
        )
    }

    fn outline(&self, lang: &LanguageId, text: &str) -> Option<Vec<ide_language::ExternalSymbol>> {
        let symbols = self.0.upgrade()?.syntax_call(lang, owned(lang, text, Runtime::syntax_outline))?;
        Some(
            symbols
                .into_iter()
                .map(|s| ide_language::ExternalSymbol {
                    name: s.name,
                    detail: s.detail,
                    kind: s.kind,
                    start: s.start,
                    end: s.end,
                    name_start: s.name_start,
                    name_end: s.name_end,
                    parent: s.parent,
                })
                .collect(),
        )
    }

    fn folding(&self, lang: &LanguageId, text: &str) -> Option<Vec<ide_language::ExternalFold>> {
        let folds = self.0.upgrade()?.syntax_call(lang, owned(lang, text, Runtime::syntax_folding))?;
        Some(
            folds
                .into_iter()
                .map(|f| ide_language::ExternalFold { start_line: f.start_line, end_line: f.end_line, kind: f.kind })
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs() {
        assert!(glob_match("**/*Mapper.xml", "src/main/UserMapper.xml"));
        assert!(glob_match("**/*Mapper.xml", "UserMapper.xml"));
        assert!(!glob_match("*.xml", "a/b.xml"));
        assert!(glob_match("pom.xml", "pom.xml"));
        assert!(glob_match("src/**", "src/a/b"));
        assert!(glob_match("a?c", "abc") && !glob_match("a?c", "a/c"));
    }
}
