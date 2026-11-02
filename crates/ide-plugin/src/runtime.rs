//! Wasmtime glue: one shared engine, one `Store` per plugin, host imports.

use crate::manifest::{API_VERSION, CommandDecl, Permission, validate_command_id};
use crate::sandbox;
use crate::theme::ThemeDef;
use crate::types::{Invocation, Limits, NotificationLevel, PluginEvent, PluginEventSink};
use ide_language::LanguageConfig;
use parking_lot::Mutex;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use wasmtime::component::{Component, HasSelf, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

mod bindings {
    wasmtime::component::bindgen!({
        world: "plugin",
        path: "../../wit",
        imports: { default: trappable },
    });
}

use bindings::openidea::plugin::host::{self as wit_host};
use bindings::openidea::plugin::types::{self as wit_types, LogLevel};

/// client → path of its focused editor.
pub(crate) type ActiveFileFn = Arc<dyn Fn(Option<&str>) -> Option<String> + Send + Sync>;

const EPOCH_TICK: Duration = Duration::from_millis(10);
const MAX_TEXT: usize = 1 << 20;
const MAX_TITLE: usize = 256;
const MAX_COMMANDS: usize = 256;
const STDERR_CAPACITY: usize = 256 << 10;

/// Shared compilation engine plus an epoch ticker thread for wall-clock limits.
pub(crate) struct PluginEngine {
    engine: Engine,
    linker: Linker<StoreData>,
}

impl PluginEngine {
    pub fn new() -> Result<Self, String> {
        let mut config = Config::new();
        config.wasm_component_model(true).consume_fuel(true).epoch_interruption(true);
        let engine = Engine::new(&config).map_err(|e| format!("wasm engine: {e}"))?;
        let mut linker = Linker::new(&engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker).map_err(|e| e.to_string())?;
        bindings::Plugin::add_to_linker::<_, HasSelf<_>>(&mut linker, |s| s).map_err(|e| e.to_string())?;

        let weak = engine.weak();
        std::thread::Builder::new()
            .name("plugin-epoch".into())
            .spawn(move || {
                while let Some(engine) = weak.upgrade() {
                    engine.increment_epoch();
                    drop(engine);
                    std::thread::sleep(EPOCH_TICK);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { engine, linker })
    }

    pub fn compile(&self, wasm: &Path) -> Result<Component, String> {
        let bytes = std::fs::read(wasm).map_err(|e| format!("{}: {e}", wasm.display()))?;
        Component::new(&self.engine, &bytes)
            .map_err(|e| format!("{}: not a valid plugin component: {e}", wasm.display()))
    }
}

/// What a plugin contributed (manifest files + runtime registrations).
#[derive(Default, Clone)]
pub(crate) struct Registrations {
    pub commands: Vec<CommandDecl>,
    pub languages: Vec<LanguageConfig>,
    pub themes: Vec<ThemeDef>,
}

impl Registrations {
    pub fn add_command(&mut self, cmd: CommandDecl) -> bool {
        match self.commands.iter_mut().find(|c| c.id == cmd.id) {
            Some(existing) if *existing == cmd => false,
            Some(existing) => {
                *existing = cmd;
                true
            }
            None => {
                self.commands.push(cmd);
                true
            }
        }
    }

    pub fn add_language(&mut self, cfg: LanguageConfig) {
        self.languages.retain(|l| l.id != cfg.id);
        self.languages.push(cfg);
    }

    pub fn add_theme(&mut self, theme: ThemeDef) {
        self.themes.retain(|t| t.id != theme.id);
        self.themes.push(theme);
    }
}

pub(crate) fn parse_language(src: &str) -> Result<LanguageConfig, String> {
    let cfg: LanguageConfig = toml::from_str(src).map_err(|e| format!("invalid language definition: {e}"))?;
    if cfg.id.as_str().is_empty() || cfg.name.trim().is_empty() {
        return Err("language `id` and `name` must not be empty".into());
    }
    Ok(cfg)
}

/// Side effects of one call the host must act on afterwards.
#[derive(Default)]
pub(crate) struct CallEffects {
    pub commands_changed: bool,
    pub themes_changed: Vec<String>,
}

pub(crate) struct StoreData {
    wasi: WasiCtx,
    table: ResourceTable,
    limits: StoreLimits,
    stderr: MemoryOutputPipe,
    stderr_seen: usize,
    plugin_id: String,
    permissions: Vec<Permission>,
    registrations: Arc<Mutex<Registrations>>,
    sink: Arc<dyn PluginEventSink>,
    invocation: Invocation,
    active_file: ActiveFileFn,
    effects: CallEffects,
}

impl WasiView for StoreData {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}

impl StoreData {
    fn require(&self, p: Permission) -> wasmtime::Result<()> {
        if self.permissions.contains(&p) {
            Ok(())
        } else {
            Err(wasmtime::Error::msg(format!(
                "permission denied: add \"{}\" to `permissions` in plugin.toml",
                p.as_str()
            )))
        }
    }

    fn emit(&self, event: PluginEvent) {
        self.sink.emit(self.invocation.client.as_deref(), event);
    }

    /// New guest stderr output since the last call (panic messages, eprintln!).
    fn drain_stderr(&mut self) -> String {
        let all = self.stderr.contents();
        let new = String::from_utf8_lossy(&all[self.stderr_seen.min(all.len())..]).into_owned();
        self.stderr_seen = all.len();
        new
    }
}

fn clip(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

impl wit_types::Host for StoreData {}

impl wit_host::Host for StoreData {
    fn log(&mut self, level: LogLevel, message: String) -> wasmtime::Result<()> {
        let id = &self.plugin_id;
        let message = clip(message, MAX_TEXT);
        match level {
            LogLevel::Trace => tracing::trace!(plugin = %id, "{message}"),
            LogLevel::Debug => tracing::debug!(plugin = %id, "{message}"),
            LogLevel::Info => tracing::info!(plugin = %id, "{message}"),
            LogLevel::Warn => tracing::warn!(plugin = %id, "{message}"),
            LogLevel::Error => tracing::error!(plugin = %id, "{message}"),
        }
        Ok(())
    }

    fn register_command(&mut self, id: String, title: String, category: Option<String>) -> wasmtime::Result<()> {
        validate_command_id(&id).map_err(wasmtime::Error::msg)?;
        let title = clip(title, MAX_TITLE);
        if title.trim().is_empty() {
            return Err(wasmtime::Error::msg(format!("command {id:?} has an empty title")));
        }
        let cmd = CommandDecl { id, title, category: category.map(|c| clip(c, MAX_TITLE)).filter(|c| !c.is_empty()) };
        let mut regs = self.registrations.lock();
        if regs.commands.len() >= MAX_COMMANDS && !regs.commands.iter().any(|c| c.id == cmd.id) {
            return Err(wasmtime::Error::msg(format!("too many commands (max {MAX_COMMANDS})")));
        }
        if regs.add_command(cmd) {
            self.effects.commands_changed = true;
        }
        Ok(())
    }

    fn show_notification(
        &mut self,
        level: wit_types::NotificationLevel,
        title: String,
        body: String,
    ) -> wasmtime::Result<()> {
        let level = match level {
            wit_types::NotificationLevel::Info => NotificationLevel::Info,
            wit_types::NotificationLevel::Warning => NotificationLevel::Warning,
            wit_types::NotificationLevel::Error => NotificationLevel::Error,
        };
        self.emit(PluginEvent::Notification {
            plugin_id: self.plugin_id.clone(),
            level,
            title: clip(title, MAX_TITLE),
            body: clip(body, 16 << 10),
        });
        Ok(())
    }

    fn workspace_root(&mut self) -> wasmtime::Result<Option<String>> {
        self.require(Permission::ProjectRead)?;
        Ok(self.invocation.workspace_root.as_ref().map(|p| p.to_string_lossy().into_owned()))
    }

    fn active_file(&mut self) -> wasmtime::Result<Option<String>> {
        self.require(Permission::EditorRead)?;
        Ok((self.active_file)(self.invocation.client.as_deref()))
    }

    fn read_file(&mut self, path: String) -> wasmtime::Result<Result<String, String>> {
        self.require(Permission::ProjectRead)?;
        let Some(root) = self.invocation.workspace_root.clone() else {
            return Ok(Err("no project is open".into()));
        };
        let real = match sandbox::resolve_in_root(&root, &path) {
            Ok(real) => real,
            Err(e) => return Ok(Err(e)),
        };
        if let Some(text) = self.invocation.buffer_text.as_ref().and_then(|f| f(&real)) {
            return Ok(Ok(text));
        }
        Ok(sandbox::read_text(&real))
    }

    fn list_dir(&mut self, path: String) -> wasmtime::Result<Result<Vec<wit_host::DirEntry>, String>> {
        self.require(Permission::ProjectRead)?;
        let Some(root) = self.invocation.workspace_root.clone() else {
            return Ok(Err("no project is open".into()));
        };
        let real = match sandbox::resolve_in_root(&root, &path) {
            Ok(real) => real,
            Err(e) => return Ok(Err(e)),
        };
        Ok(sandbox::list_dir(&real).map(|entries| {
            entries.into_iter().map(|e| wit_host::DirEntry { name: e.name, is_dir: e.is_dir }).collect()
        }))
    }

    fn insert_text(&mut self, text: String) -> wasmtime::Result<()> {
        self.require(Permission::EditorWrite)?;
        self.emit(PluginEvent::InsertText { plugin_id: self.plugin_id.clone(), text: clip(text, MAX_TEXT) });
        Ok(())
    }

    fn replace_selection(&mut self, text: String) -> wasmtime::Result<()> {
        self.require(Permission::EditorWrite)?;
        self.emit(PluginEvent::ReplaceSelection { plugin_id: self.plugin_id.clone(), text: clip(text, MAX_TEXT) });
        Ok(())
    }

    fn register_language(&mut self, definition: String) -> wasmtime::Result<Result<(), String>> {
        Ok(parse_language(&definition).map(|cfg| {
            self.registrations.lock().add_language(cfg);
            self.effects.commands_changed = true;
        }))
    }

    fn register_theme(&mut self, definition: String) -> wasmtime::Result<Result<(), String>> {
        Ok(ThemeDef::parse(&definition).map(|theme| {
            self.effects.themes_changed.push(theme.id.clone());
            self.registrations.lock().add_theme(theme);
            self.effects.commands_changed = true;
        }))
    }
}

/// A call failed: either the plugin returned an error (it stays usable) or it
/// trapped / ran out of budget (the instance is poisoned and must be dropped).
#[derive(Debug)]
pub(crate) enum CallError {
    Guest(String),
    Trap(String),
}

pub(crate) struct RuntimeSetup {
    pub plugin_id: String,
    pub version: String,
    pub permissions: Vec<Permission>,
    pub registrations: Arc<Mutex<Registrations>>,
    pub sink: Arc<dyn PluginEventSink>,
    pub active_file: ActiveFileFn,
    pub limits: Limits,
}

pub(crate) struct Runtime {
    store: Store<StoreData>,
    plugin: bindings::Plugin,
    limits: Limits,
    version: String,
}

impl Runtime {
    pub fn instantiate(engine: &PluginEngine, component: &Component, setup: RuntimeSetup) -> Result<Self, String> {
        let stderr = MemoryOutputPipe::new(STDERR_CAPACITY);
        // No preopened dirs, env, args or network: host imports are the only way out.
        let wasi = WasiCtx::builder().stderr(stderr.clone()).build();
        let limits = StoreLimitsBuilder::new()
            .memory_size(setup.limits.memory_bytes)
            .instances(32)
            .tables(64)
            .memories(8)
            .trap_on_grow_failure(true)
            .build();
        let data = StoreData {
            wasi,
            table: ResourceTable::new(),
            limits,
            stderr,
            stderr_seen: 0,
            plugin_id: setup.plugin_id,
            permissions: setup.permissions,
            registrations: setup.registrations,
            sink: setup.sink,
            invocation: Invocation::default(),
            active_file: setup.active_file,
            effects: CallEffects::default(),
        };
        let mut store = Store::new(&engine.engine, data);
        store.limiter(|d| &mut d.limits);
        store.epoch_deadline_trap();
        arm(&mut store, &setup.limits).map_err(|e| e.to_string())?;
        let plugin = bindings::Plugin::instantiate(&mut store, component, &engine.linker)
            .map_err(|e| describe_trap(&e, &setup.limits))?;
        Ok(Self { store, plugin, limits: setup.limits, version: setup.version })
    }

    pub fn activate(&mut self) -> Result<CallEffects, CallError> {
        let data = self.store.data();
        let ctx = wit_types::Context {
            plugin_id: data.plugin_id.clone(),
            plugin_version: self.version.clone(),
            api_version: API_VERSION.into(),
            permissions: data.permissions.iter().map(|p| p.as_str().to_owned()).collect(),
        };
        self.call(Invocation::default(), |plugin, store| plugin.call_activate(store, &ctx))
            .and_then(|(r, fx)| r.map(|()| fx).map_err(CallError::Guest))
    }

    pub fn run_command(
        &mut self,
        id: &str,
        arg: Option<&str>,
        invocation: Invocation,
    ) -> Result<(Option<String>, CallEffects), CallError> {
        let (result, fx) = self.call(invocation, |plugin, store| plugin.call_run_command(store, id, arg))?;
        result.map(|v| (v, fx)).map_err(CallError::Guest)
    }

    /// Best effort; errors are logged.
    pub fn deactivate(&mut self) {
        if let Err(CallError::Trap(e) | CallError::Guest(e)) =
            self.call(Invocation::default(), |plugin, store| plugin.call_deactivate(store))
        {
            tracing::warn!(plugin = %self.store.data().plugin_id, "deactivate failed: {e}");
        }
    }

    fn call<R>(
        &mut self,
        invocation: Invocation,
        f: impl FnOnce(&bindings::Plugin, &mut Store<StoreData>) -> wasmtime::Result<R>,
    ) -> Result<(R, CallEffects), CallError> {
        arm(&mut self.store, &self.limits).map_err(|e| CallError::Trap(e.to_string()))?;
        self.store.data_mut().invocation = invocation;
        let result = f(&self.plugin, &mut self.store);
        let data = self.store.data_mut();
        data.invocation = Invocation::default();
        let effects = std::mem::take(&mut data.effects);
        let stderr = data.drain_stderr();
        if !stderr.trim().is_empty() {
            tracing::info!(plugin = %data.plugin_id, "stderr: {}", stderr.trim_end());
        }
        match result {
            Ok(r) => Ok((r, effects)),
            Err(e) => {
                let mut msg = describe_trap(&e, &self.limits);
                // Typically the panic message: "panicked at src/lib.rs:1:2:\nboom".
                let detail: Vec<&str> =
                    stderr.lines().filter(|l| !l.trim().is_empty() && !l.starts_with("note:")).collect();
                if !detail.is_empty() {
                    let tail = detail[detail.len().saturating_sub(4)..].join("\n");
                    msg = format!("{msg}\n{}", clip(tail, 1024));
                }
                Err(CallError::Trap(msg))
            }
        }
    }
}

fn arm(store: &mut Store<StoreData>, limits: &Limits) -> wasmtime::Result<()> {
    store.set_fuel(limits.fuel)?;
    let ticks = (limits.timeout.as_millis() / EPOCH_TICK.as_millis()).max(1) as u64;
    store.set_epoch_deadline(ticks);
    Ok(())
}

fn describe_trap(e: &wasmtime::Error, limits: &Limits) -> String {
    match e.downcast_ref::<wasmtime::Trap>() {
        Some(wasmtime::Trap::OutOfFuel) => format!("exceeded its CPU budget ({} fuel per call)", limits.fuel),
        Some(wasmtime::Trap::Interrupt) => format!("timed out after {:?}", limits.timeout),
        Some(wasmtime::Trap::UnreachableCodeReached) => "crashed (panic / unreachable)".to_owned(),
        Some(trap) => format!("trapped: {trap}"),
        None => {
            let root = e.root_cause().to_string();
            if root.contains("memory") {
                format!("{root} (memory limit {} MiB)", limits.memory_bytes >> 20)
            } else {
                root
            }
        }
    }
}
