//! Sandboxed WebAssembly plugin host (Zed-style).
//!
//! A plugin is a directory with a `plugin.toml` manifest ([`PluginManifest`])
//! and, optionally, a WebAssembly component implementing the
//! `openidea:plugin/plugin@0.1.0` world (`wit/plugin.wit`). Contribution-only
//! plugins (themes, languages) need no code.
//!
//! Each plugin with code runs in its own wasmtime `Store` with WASI preview 2
//! (no files, env, network), a fuel budget and wall-clock deadline per call,
//! and a linear-memory cap. A trap (panic, budget exhausted, permission
//! violation) drops the instance and marks the plugin `Failed` for the session;
//! the IDE keeps running.
//!
//! Sources: `<plugins_dir>/<id>/` (installed) and `<project>/.openidea/plugins/*/`
//! (dev plugins, loaded by [`PluginHost::sync_project`]).

mod manifest;
mod runtime;
mod sandbox;
mod theme;
mod types;

pub use manifest::{
    API_VERSION, CommandDecl, Contributions, FileDecl, MANIFEST_FILE, Permission, PluginManifest, ThemeDecl,
};
pub use sandbox::resolve_in_root;
pub use theme::{ThemeDef, ThemeKind};
pub use types::*;

use ide_core::{IdeError, IdeResult};
use ide_language::LanguageConfig;
use parking_lot::{Mutex, RwLock};
use runtime::{CallEffects, CallError, PluginEngine, Registrations, Runtime, RuntimeSetup};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const STATE_FILE: &str = "state.json";
/// Dev plugins live here, relative to a project root.
pub const DEV_PLUGINS_DIR: &str = ".openidea/plugins";

#[derive(Default, Serialize, Deserialize)]
struct PersistedState {
    #[serde(default)]
    disabled: BTreeSet<String>,
    #[serde(default)]
    theme: Option<ThemeRef>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct ThemeRef {
    plugin: String,
    theme: String,
}

struct Meta {
    status: PluginStatus,
    error: Option<String>,
}

struct LoadedPlugin {
    manifest: PluginManifest,
    dir: PathBuf,
    source: PluginSource,
    /// Project that owns a dev plugin.
    dev_root: Option<PathBuf>,
    /// Manifest contributions, restored on every (re)start.
    static_regs: Registrations,
    registrations: Arc<Mutex<Registrations>>,
    meta: Mutex<Meta>,
    runtime: Mutex<Option<Runtime>>,
}

impl LoadedPlugin {
    fn is_live(&self) -> bool {
        matches!(self.meta.lock().status, PluginStatus::Active | PluginStatus::Static)
    }

    fn set_failed(&self, error: String) {
        let mut meta = self.meta.lock();
        meta.status = PluginStatus::Failed;
        meta.error = Some(error);
    }
}

pub struct PluginHost {
    engine: PluginEngine,
    plugins_dir: PathBuf,
    sink: Arc<dyn PluginEventSink>,
    limits: Limits,
    plugins: RwLock<BTreeMap<String, Arc<LoadedPlugin>>>,
    state: Mutex<PersistedState>,
    /// client (window) → path of its focused editor.
    active_files: Arc<Mutex<HashMap<String, String>>>,
    /// Serializes loading / unloading so concurrent windows can't race.
    lifecycle: Mutex<()>,
}

impl PluginHost {
    /// Creates the host; call [`load_all`](Self::load_all) to load installed plugins.
    pub fn new(plugins_dir: PathBuf, sink: Arc<dyn PluginEventSink>, limits: Limits) -> IdeResult<Self> {
        std::fs::create_dir_all(&plugins_dir)?;
        let state = std::fs::read_to_string(plugins_dir.join(STATE_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Ok(Self {
            engine: PluginEngine::new().map_err(IdeError::internal)?,
            plugins_dir,
            sink,
            limits,
            plugins: RwLock::default(),
            state: Mutex::new(state),
            active_files: Arc::default(),
            lifecycle: Mutex::new(()),
        })
    }

    pub fn plugins_dir(&self) -> &Path {
        &self.plugins_dir
    }

    /// Loads every package under the plugins directory (already loaded ones are kept).
    pub fn load_all(&self) {
        let _guard = self.lifecycle.lock();
        for dir in package_dirs(&self.plugins_dir) {
            if !self.is_loaded_from(&dir) {
                self.load_dir(&dir, PluginSource::Installed, None);
            }
        }
        self.emit(None, PluginEvent::CommandsChanged);
    }

    /// Loads new dev plugins from `<root>/.openidea/plugins/` and unloads vanished ones.
    pub fn sync_project(&self, root: &Path) {
        let _guard = self.lifecycle.lock();
        let dirs = package_dirs(&ide_core::project_dir::path(root, "plugins"));
        let stale: Vec<String> = self
            .plugins
            .read()
            .iter()
            .filter(|(_, p)| p.dev_root.as_deref() == Some(root) && !dirs.contains(&p.dir))
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
            self.emit(None, PluginEvent::CommandsChanged);
        }
    }

    /// Installed plugins plus the dev plugins of `project` (if any).
    pub fn list(&self, project: Option<&Path>) -> PluginsSnapshot {
        let mut plugins: Vec<PluginInfo> = self
            .plugins
            .read()
            .values()
            .filter(|p| p.dev_root.is_none() || p.dev_root.as_deref() == project)
            .map(|p| self.info(p))
            .collect();
        plugins.sort_by_key(|p| p.name.to_lowercase());
        PluginsSnapshot { plugins, active_theme: self.active_theme() }
    }

    pub fn info_of(&self, id: &str) -> IdeResult<PluginInfo> {
        Ok(self.info(&*self.get(id)?))
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
        self.emit(None, PluginEvent::CommandsChanged);
        self.emit_theme_if_owned(id);
        Ok(())
    }

    /// Re-reads a plugin from disk (e.g. after rebuilding a dev plugin).
    pub fn reload(&self, id: &str) -> IdeResult<PluginInfo> {
        let _guard = self.lifecycle.lock();
        let plugin = self.get(id)?;
        let (dir, source, root) = (plugin.dir.clone(), plugin.source, plugin.dev_root.clone());
        self.unload(id);
        let new_id = self.load_dir(&dir, source, root);
        self.emit(None, PluginEvent::CommandsChanged);
        self.emit_theme_if_owned(&new_id);
        self.info_of(&new_id)
    }

    /// Copies a plugin package (manifest + referenced files) into the plugins
    /// directory, replacing an installed version with the same id.
    pub fn install_from_dir(&self, src: &Path) -> IdeResult<PluginInfo> {
        let _guard = self.lifecycle.lock();
        let manifest = PluginManifest::load(src).map_err(IdeError::invalid)?;
        for file in manifest.files() {
            if !src.join(file).is_file() {
                return Err(IdeError::invalid(format!(
                    "{} is missing (referenced by plugin.toml); build the plugin first",
                    file.display()
                )));
            }
        }
        if let Some(wasm) = &manifest.wasm {
            self.engine.compile(&src.join(wasm)).map_err(IdeError::invalid)?;
        }
        let id = manifest.id.clone();
        if let Some(existing) = self.plugins.read().get(&id)
            && existing.source == PluginSource::Dev
        {
            return Err(IdeError::new(
                ide_core::error::ErrorKind::AlreadyExists,
                format!("a dev plugin with id {id:?} is loaded from {}", existing.dir.display()),
            ));
        }
        let target = self.plugins_dir.join(&id);
        let same_dir = src.canonicalize().ok().zip(target.canonicalize().ok()).is_some_and(|(a, b)| a == b);
        self.unload(&id);
        if !same_dir {
            let staging = self.plugins_dir.join(format!(".install-{id}"));
            let _ = std::fs::remove_dir_all(&staging);
            let copy = || -> std::io::Result<()> {
                std::fs::create_dir_all(&staging)?;
                std::fs::copy(src.join(MANIFEST_FILE), staging.join(MANIFEST_FILE))?;
                for file in manifest.files() {
                    let to = staging.join(file);
                    if let Some(parent) = to.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::copy(src.join(file), to)?;
                }
                if target.exists() {
                    std::fs::remove_dir_all(&target)?;
                }
                std::fs::rename(&staging, &target)
            };
            if let Err(e) = copy() {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(e.into());
            }
        }
        self.load_dir(&target, PluginSource::Installed, None);
        self.emit(None, PluginEvent::CommandsChanged);
        self.emit_theme_if_owned(&id);
        self.info_of(&id)
    }

    pub fn uninstall(&self, id: &str) -> IdeResult<()> {
        let _guard = self.lifecycle.lock();
        let plugin = self.get(id)?;
        if plugin.source != PluginSource::Installed {
            return Err(IdeError::invalid("dev plugins are removed by deleting them from .openidea/plugins"));
        }
        self.unload(id);
        std::fs::remove_dir_all(&plugin.dir)?;
        let theme_cleared = {
            let mut state = self.state.lock();
            state.disabled.remove(id);
            let owned = state.theme.as_ref().is_some_and(|t| t.plugin == id);
            if owned {
                state.theme = None;
            }
            owned
        };
        self.save_state();
        self.emit(None, PluginEvent::CommandsChanged);
        if theme_cleared {
            self.emit(None, PluginEvent::ThemeChanged { theme: None });
        }
        Ok(())
    }

    /// Runs a plugin command. Blocks for up to the configured time limit.
    pub fn run_command(
        &self,
        id: &str,
        command: &str,
        arg: Option<&str>,
        invocation: Invocation,
    ) -> IdeResult<Option<String>> {
        let plugin = self.get(id)?;
        let client = invocation.client.clone();
        let mut runtime = plugin.runtime.lock();
        let Some(rt) = runtime.as_mut() else {
            let meta = plugin.meta.lock();
            return Err(IdeError::unavailable(match meta.status {
                PluginStatus::Disabled => format!("plugin {id:?} is disabled"),
                PluginStatus::Static => format!("plugin {id:?} has no code to run commands"),
                _ => format!("plugin {id:?} is not running: {}", meta.error.as_deref().unwrap_or("failed")),
            }));
        };
        match rt.run_command(command, arg, invocation) {
            Ok((value, fx)) => {
                drop(runtime);
                self.apply_effects(&plugin, fx);
                Ok(value)
            }
            Err(CallError::Guest(e)) => Err(IdeError::internal(e)),
            Err(CallError::Trap(e)) => {
                *runtime = None;
                drop(runtime);
                self.fail(&plugin, &e, client.as_deref());
                Err(IdeError::internal(format!("plugin {id:?} {e}")))
            }
        }
    }

    /// The UI reports which file its focused editor shows (for `active-file`).
    pub fn set_active_file(&self, client: &str, path: Option<String>) {
        let mut files = self.active_files.lock();
        match path {
            Some(p) => files.insert(client.to_owned(), p),
            None => files.remove(client),
        };
    }

    /// Selects a plugin theme (`None` restores the built-in theme).
    pub fn set_theme(&self, selection: Option<(&str, &str)>) -> IdeResult<Option<ActiveTheme>> {
        if let Some((plugin, theme)) = selection {
            let p = self.get(plugin)?;
            if !p.registrations.lock().themes.iter().any(|t| t.id == theme) {
                return Err(IdeError::not_found(format!("plugin {plugin:?} has no theme {theme:?}")));
            }
        }
        self.state.lock().theme =
            selection.map(|(plugin, theme)| ThemeRef { plugin: plugin.into(), theme: theme.into() });
        self.save_state();
        let active = self.active_theme();
        self.emit(None, PluginEvent::ThemeChanged { theme: active.clone() });
        Ok(active)
    }

    /// The selected plugin theme, when its plugin is enabled and running.
    pub fn active_theme(&self) -> Option<ActiveTheme> {
        let sel = self.state.lock().theme.clone()?;
        let plugin = self.plugins.read().get(&sel.plugin).cloned()?;
        if !plugin.is_live() {
            return None;
        }
        let theme = plugin.registrations.lock().themes.iter().find(|t| t.id == sel.theme).cloned()?;
        Some(ActiveTheme { plugin_id: sel.plugin, theme })
    }

    /// Languages contributed by live plugins (for runtime language registration).
    pub fn languages(&self) -> Vec<LanguageConfig> {
        self.plugins
            .read()
            .values()
            .filter(|p| p.is_live())
            .flat_map(|p| p.registrations.lock().languages.clone())
            .collect()
    }

    /// Deactivates every plugin (also done on drop).
    pub fn shutdown(&self) {
        for plugin in self.plugins.read().values() {
            if let Some(mut rt) = plugin.runtime.lock().take() {
                rt.deactivate();
            }
        }
    }

    // ---- internals ----

    fn get(&self, id: &str) -> IdeResult<Arc<LoadedPlugin>> {
        self.plugins.read().get(id).cloned().ok_or_else(|| IdeError::not_found(format!("no plugin {id:?}")))
    }

    fn is_loaded_from(&self, dir: &Path) -> bool {
        self.plugins.read().values().any(|p| p.dir == dir)
    }

    /// Loads one package and starts it unless disabled. Returns the plugin id.
    fn load_dir(&self, dir: &Path, source: PluginSource, dev_root: Option<PathBuf>) -> String {
        let (manifest, static_regs, error) = match PluginManifest::load(dir) {
            Ok(m) => match static_contributions(dir, &m) {
                Ok(regs) => (m, regs, None),
                Err(e) => (m, Registrations::default(), Some(e)),
            },
            Err(e) => (placeholder_manifest(dir), Registrations::default(), Some(e)),
        };
        let id = manifest.id.clone();
        let plugin = Arc::new(LoadedPlugin {
            manifest,
            dir: dir.to_path_buf(),
            source,
            dev_root,
            registrations: Arc::new(Mutex::new(static_regs.clone())),
            static_regs,
            meta: Mutex::new(Meta { status: PluginStatus::Disabled, error: None }),
            runtime: Mutex::new(None),
        });
        {
            let mut plugins = self.plugins.write();
            if let Some(existing) = plugins.get(&id) {
                tracing::warn!(
                    "plugin {id:?} at {} ignored: already loaded from {}",
                    dir.display(),
                    existing.dir.display()
                );
                return id;
            }
            plugins.insert(id.clone(), plugin.clone());
        }
        if let Some(e) = error {
            tracing::warn!("plugin {}: {e}", dir.display());
            plugin.set_failed(e);
        } else if !self.state.lock().disabled.contains(&id) {
            self.start(&plugin);
        }
        id
    }

    fn unload(&self, id: &str) {
        let Some(plugin) = self.plugins.write().remove(id) else { return };
        self.stop(&plugin);
    }

    fn start(&self, plugin: &Arc<LoadedPlugin>) {
        *plugin.registrations.lock() = plugin.static_regs.clone();
        let Some(wasm) = &plugin.manifest.wasm else {
            *plugin.meta.lock() = Meta { status: PluginStatus::Static, error: None };
            return;
        };
        let started = self.engine.compile(&plugin.dir.join(wasm)).and_then(|component| {
            let active_files = self.active_files.clone();
            let setup = RuntimeSetup {
                plugin_id: plugin.manifest.id.clone(),
                version: plugin.manifest.version.clone(),
                permissions: plugin.manifest.permissions.clone(),
                registrations: plugin.registrations.clone(),
                sink: self.sink.clone(),
                active_file: Arc::new(move |client| client.and_then(|c| active_files.lock().get(c).cloned())),
                limits: self.limits,
            };
            let mut rt = Runtime::instantiate(&self.engine, &component, setup)?;
            match rt.activate() {
                Ok(fx) => Ok((rt, fx)),
                Err(CallError::Guest(e)) => Err(format!("activation failed: {e}")),
                Err(CallError::Trap(e)) => Err(format!("activation {e}")),
            }
        });
        match started {
            Ok((rt, _fx)) => {
                *plugin.runtime.lock() = Some(rt);
                *plugin.meta.lock() = Meta { status: PluginStatus::Active, error: None };
            }
            Err(e) => self.fail(plugin, &e, None),
        }
    }

    fn stop(&self, plugin: &LoadedPlugin) {
        if let Some(mut rt) = plugin.runtime.lock().take() {
            rt.deactivate();
        }
    }

    fn fail(&self, plugin: &LoadedPlugin, error: &str, client: Option<&str>) {
        tracing::warn!(plugin = %plugin.manifest.id, "disabled after failure: {error}");
        plugin.set_failed(error.to_owned());
        self.emit(
            client,
            PluginEvent::Notification {
                plugin_id: plugin.manifest.id.clone(),
                level: NotificationLevel::Error,
                title: format!("Plugin \u{201c}{}\u{201d} was disabled", plugin.manifest.name),
                body: error.to_owned(),
            },
        );
        self.emit(None, PluginEvent::CommandsChanged);
        self.emit_theme_if_owned(&plugin.manifest.id);
    }

    fn apply_effects(&self, plugin: &LoadedPlugin, fx: CallEffects) {
        if fx.commands_changed {
            self.emit(None, PluginEvent::CommandsChanged);
        }
        let sel = self.state.lock().theme.clone();
        if let Some(sel) = sel
            && sel.plugin == plugin.manifest.id
            && fx.themes_changed.contains(&sel.theme)
        {
            self.emit(None, PluginEvent::ThemeChanged { theme: self.active_theme() });
        }
    }

    fn emit_theme_if_owned(&self, id: &str) {
        let owned = self.state.lock().theme.as_ref().is_some_and(|t| t.plugin == id);
        if owned {
            self.emit(None, PluginEvent::ThemeChanged { theme: self.active_theme() });
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

    fn info(&self, p: &LoadedPlugin) -> PluginInfo {
        let m = &p.manifest;
        let regs = p.registrations.lock().clone();
        let meta = p.meta.lock();
        PluginInfo {
            id: m.id.clone(),
            name: m.name.clone(),
            version: m.version.clone(),
            description: m.description.clone(),
            authors: m.authors.clone(),
            homepage: m.homepage.clone(),
            change_notes: m.change_notes.clone(),
            source: p.source,
            path: p.dir.clone().into(),
            enabled: !self.state.lock().disabled.contains(&m.id),
            status: meta.status,
            error: meta.error.clone(),
            has_code: m.wasm.is_some(),
            permissions: m.permissions.clone(),
            commands: regs.commands,
            languages: regs
                .languages
                .iter()
                .map(|l| PluginLanguage {
                    id: l.id.to_string(),
                    name: l.name.clone(),
                    extensions: l.extensions.clone(),
                })
                .collect(),
            themes: regs
                .themes
                .iter()
                .map(|t| PluginTheme { id: t.id.clone(), name: t.name.clone(), kind: t.kind })
                .collect(),
        }
    }
}

impl Drop for PluginHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Plugin packages found in `dirs` (first occurrence of an id wins). Invalid
/// manifests are skipped; packages with missing files carry a `problem`.
pub fn scan_catalog(dirs: &[PathBuf]) -> Vec<CatalogPlugin> {
    let mut out: Vec<CatalogPlugin> = Vec::new();
    for dir in dirs.iter().flat_map(|d| package_dirs(d)) {
        let Ok(m) = PluginManifest::load(&dir) else { continue };
        if out.iter().any(|c| c.id == m.id) {
            continue;
        }
        let problem = m
            .files()
            .into_iter()
            .find(|f| !dir.join(f).is_file())
            .map(|f| format!("{} is missing; build the plugin first", f.display()));
        out.push(CatalogPlugin {
            has_code: m.wasm.is_some(),
            language_count: m.contributes.languages.len() as u32,
            theme_count: m.contributes.themes.len() as u32,
            commands: m.contributes.commands.clone(),
            permissions: m.permissions.clone(),
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

/// Subdirectories of `dir` that contain a `plugin.toml`, sorted.
fn package_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.join(MANIFEST_FILE).is_file()
                && !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.'))
        })
        .collect();
    dirs.sort();
    dirs
}

fn static_contributions(dir: &Path, m: &PluginManifest) -> Result<Registrations, String> {
    let mut regs = Registrations::default();
    for cmd in &m.contributes.commands {
        regs.add_command(cmd.clone());
    }
    let read = |p: &Path| std::fs::read_to_string(dir.join(p)).map_err(|e| format!("{}: {e}", p.display()));
    for f in &m.contributes.languages {
        let cfg = runtime::parse_language(&read(&f.path)?).map_err(|e| format!("{}: {e}", f.path.display()))?;
        regs.add_language(cfg);
    }
    for f in &m.contributes.themes {
        let mut theme = ThemeDef::parse(&read(&f.path)?).map_err(|e| format!("{}: {e}", f.path.display()))?;
        if let Some(scheme) = &f.editor_scheme {
            theme.merge_editor_scheme(&read(scheme)?).map_err(|e| format!("{}: {e}", scheme.display()))?;
        }
        regs.add_theme(theme);
    }
    Ok(regs)
}

/// Stand-in for a package whose manifest failed to parse, so it still shows up (as failed).
fn placeholder_manifest(dir: &Path) -> PluginManifest {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    PluginManifest {
        id: format!("invalid-{}", name.to_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), "-")),
        name,
        version: "0.0.0".into(),
        description: String::new(),
        authors: Vec::new(),
        homepage: None,
        change_notes: None,
        openidea_api: API_VERSION.into(),
        wasm: None,
        permissions: Vec::new(),
        contributes: Contributions::default(),
    }
}
