//! Model availability for new tasks. Sessions own selections; discovery owns catalogs.

use crate::{
    AgentCommand, AgentConfigOption, AgentEvent, AgentModelCatalog, Known, Shared, acp, config, native, provider,
};
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::Instant;

const FRESH_FOR: Duration = Duration::from_secs(15 * 60);
const COOLDOWN: Duration = Duration::from_secs(30);

type Store = Arc<Mutex<HashMap<String, Known>>>;
type Key = (PathBuf, PathBuf, String);

/// Backend-wide single-flight model lookups, scoped to project and effective launch configuration.
#[derive(Default)]
pub struct AgentCatalogs {
    state: Mutex<State>,
    #[cfg(test)]
    clock_ms: std::sync::atomic::AtomicU64,
}

#[derive(Default)]
struct State {
    stores: HashMap<PathBuf, Store>,
    entries: HashMap<Key, Entry>,
    subscribers: Vec<Weak<Shared>>,
    generation: u64,
}

struct Entry {
    // Launch credentials remain only in memory, never serialized or logged.
    context: LaunchContext,
    generation: u64,
    completed: Option<Instant>,
    successful: Option<Instant>,
    retry_at_ms: Option<f64>,
    error: Option<String>,
    flight: Option<watch::Receiver<bool>>,
    abort: Option<tokio::task::AbortHandle>,
    flight_model: Option<String>,
    requested_model: Option<String>,
    model_failures: HashMap<String, ModelFailure>,
    catalog: Option<CatalogData>,
}

struct ModelFailure {
    completed: Instant,
    retry_at_ms: f64,
    error: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogData {
    pub config: Vec<AgentConfigOption>,
    pub thought_levels: BTreeMap<String, Vec<AgentConfigOption>>,
    pub refreshed_at_ms: Option<f64>,
}

impl CatalogData {
    fn model_option(&self) -> Option<&AgentConfigOption> {
        self.config.iter().find(|o| o.category.as_deref() == Some("model"))
    }

    fn lists(&self, model: &str) -> bool {
        self.model_option().is_some_and(|o| o.values.iter().any(|v| v.value == model))
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedCatalog {
    /// An opaque cryptographic digest, never raw launch arguments or credentials.
    fingerprint: String,
    #[serde(flatten)]
    catalog: CatalogData,
}

#[derive(PartialEq)]
struct LaunchContext {
    spec: provider::ProviderSpec,
    executable: PathBuf,
    modified: Option<std::time::SystemTime>,
    len: Option<u64>,
}

impl LaunchContext {
    fn new(spec: provider::ProviderSpec, root: &std::path::Path) -> Self {
        let resolved = spec.clone().resolve_for_launch(root);
        let executable = dunce::canonicalize(&resolved.command).unwrap_or_else(|_| PathBuf::from(&resolved.command));
        let metadata = std::fs::metadata(&executable).ok();
        Self {
            spec,
            executable,
            modified: metadata.as_ref().and_then(|m| m.modified().ok()),
            len: metadata.as_ref().map(std::fs::Metadata::len),
        }
    }

    fn fingerprint(&self) -> String {
        let mut hash = blake3::Hasher::new();
        fn field(hash: &mut blake3::Hasher, value: &[u8]) {
            hash.update(&(value.len() as u64).to_le_bytes());
            hash.update(value);
        }
        field(&mut hash, b"openidea-model-catalog-v1");
        field(
            &mut hash,
            match self.spec.driver {
                provider::Driver::Acp => b"acp",
                provider::Driver::Codex => b"codex",
                provider::Driver::Claude => b"claude",
                provider::Driver::Copilot => b"copilot",
            },
        );
        field(&mut hash, self.spec.command.as_bytes());
        hash.update(&(self.spec.args.len() as u64).to_le_bytes());
        for arg in &self.spec.args {
            field(&mut hash, arg.as_bytes());
        }
        hash.update(&(self.spec.env.len() as u64).to_le_bytes());
        for (name, value) in &self.spec.env {
            field(&mut hash, name.as_bytes());
            field(&mut hash, value.as_bytes());
        }
        field(&mut hash, self.executable.to_string_lossy().as_bytes());
        if let Some(modified) = self.modified.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()) {
            hash.update(&modified.as_nanos().to_le_bytes());
        }
        if let Some(len) = self.len {
            hash.update(&len.to_le_bytes());
        }
        hash.finalize().to_hex().to_string()
    }
}

pub(crate) struct Discovered {
    pub config: Vec<AgentConfigOption>,
    pub commands: Option<Vec<AgentCommand>>,
    pub levels: BTreeMap<String, Vec<AgentConfigOption>>,
}

pub(crate) struct KillPeer(pub ide_jsonrpc::Peer);

impl Drop for KillPeer {
    fn drop(&mut self) {
        self.0.kill();
    }
}

impl AgentCatalogs {
    fn now(&self) -> Instant {
        let now = Instant::now();
        #[cfg(test)]
        let now = now + Duration::from_millis(self.clock_ms.load(std::sync::atomic::Ordering::Relaxed));
        now
    }

    fn epoch_ms(&self) -> f64 {
        let now = crate::now_ms();
        #[cfg(test)]
        let now = now + self.clock_ms.load(std::sync::atomic::Ordering::Relaxed) as f64;
        now
    }

    pub(crate) fn store(&self, path: &std::path::Path) -> Store {
        self.state
            .lock()
            .stores
            .entry(path.to_path_buf())
            .or_insert_with(|| {
                Arc::new(Mutex::new(
                    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default(),
                ))
            })
            .clone()
    }

    pub(crate) fn subscribe(&self, shared: &Arc<Shared>) {
        let mut state = self.state.lock();
        state.subscribers.retain(|s| s.strong_count() > 0);
        state.subscribers.push(Arc::downgrade(shared));
    }

    fn key(shared: &Shared, provider: &str) -> Key {
        (shared.paths.models_file.clone(), shared.paths.project_root.clone(), provider.to_owned())
    }

    fn fallback(shared: &Shared, provider: &str) -> CatalogData {
        let cache = shared.known.lock();
        let Some(known) = cache.get(provider) else { return CatalogData::default() };
        known.catalogs.get(&shared.root_key()).map(|saved| saved.catalog.clone()).unwrap_or_else(|| CatalogData {
            config: known.config.clone(),
            thought_levels: known.thought_levels.clone(),
            refreshed_at_ms: None,
        })
    }

    pub(crate) fn cached(&self, shared: &Shared, provider: &str) -> CatalogData {
        self.state
            .lock()
            .entries
            .get(&Self::key(shared, provider))
            .and_then(|e| e.catalog.clone())
            .unwrap_or_else(|| Self::fallback(shared, provider))
    }

    /// Availability for an explicit session switch must come from a recent discovery for this
    /// launch, not from the display fallback or a different project's session report.
    pub(super) fn fresh_model(
        &self,
        shared: &Shared,
        spec: &provider::ProviderSpec,
        model: &str,
    ) -> Option<crate::AgentConfigValue> {
        let context = LaunchContext::new(spec.clone(), &shared.paths.project_root);
        let select = |catalog: &CatalogData| {
            let age = self.epoch_ms() - catalog.refreshed_at_ms?;
            if !(0.0..FRESH_FOR.as_millis() as f64).contains(&age) {
                return None;
            }
            catalog.model_option()?.values.iter().find(|value| value.value == model).cloned()
        };
        let state = self.state.lock();
        if let Some(entry) = state.entries.get(&Self::key(shared, &spec.id)) {
            return select(entry.catalog.as_ref().filter(|_| entry.context == context)?);
        }
        let cache = shared.known.lock();
        let saved = cache.get(&spec.id)?.catalogs.get(&shared.root_key())?;
        (saved.fingerprint == context.fingerprint()).then(|| select(&saved.catalog)).flatten()
    }

    pub(crate) fn levels(&self, shared: &Shared, provider: &str, model: &str) -> Option<Vec<AgentConfigOption>> {
        let state = self.state.lock();
        if let Some(catalog) = state.entries.get(&Self::key(shared, provider)).and_then(|entry| entry.catalog.as_ref())
        {
            return catalog.thought_levels.get(model).cloned();
        }
        drop(state);
        let cache = shared.known.lock();
        let known = cache.get(provider)?;
        known
            .catalogs
            .get(&shared.root_key())
            .map(|saved| &saved.catalog.thought_levels)
            .unwrap_or(&known.thought_levels)
            .get(model)
            .cloned()
    }

    pub(crate) fn evict_if_idle(&self, shared: &Shared, provider: &str) {
        let key = Self::key(shared, provider);
        let mut state = self.state.lock();
        if state.entries.get(&key).is_some_and(|e| e.flight.is_none()) {
            state.entries.remove(&key);
        }
    }

    fn snapshot(&self, shared: &Shared, provider: &str, entry: &Entry) -> AgentModelCatalog {
        let catalog = entry.catalog.clone().unwrap_or_else(|| Self::fallback(shared, provider));
        let model_failure = entry.requested_model.as_ref().and_then(|model| entry.model_failures.get(model));
        let unknown_model = entry
            .requested_model
            .as_deref()
            .is_some_and(|model| catalog.lists(model) && !catalog.thought_levels.contains_key(model));
        AgentModelCatalog {
            provider: provider.to_owned(),
            config: shared.config_for_new_task(catalog.config, provider),
            thought_levels: catalog.thought_levels,
            refreshing: entry.flight.is_some(),
            refreshed_at_ms: catalog.refreshed_at_ms,
            retry_at_ms: model_failure
                .filter(|failure| self.now().duration_since(failure.completed) < COOLDOWN)
                .map(|failure| failure.retry_at_ms)
                .or_else(|| {
                    (!unknown_model)
                        .then_some(entry.retry_at_ms)
                        .flatten()
                        .filter(|_| entry.completed.is_some_and(|at| self.now().duration_since(at) < COOLDOWN))
                }),
            error: model_failure.map(|failure| failure.error.clone()).or_else(|| entry.error.clone()),
        }
    }

    /// Start or join a lookup. No queued refresh can outlive the request that asked for it.
    pub(crate) fn request(
        self: &Arc<Self>,
        shared: &Arc<Shared>,
        spec: provider::ProviderSpec,
        force: bool,
        model: Option<&str>,
    ) -> (AgentModelCatalog, Option<watch::Receiver<bool>>) {
        let key = Self::key(shared, &spec.id);
        let context = LaunchContext::new(spec.clone(), &shared.paths.project_root);
        let now = self.now();
        let mut state = self.state.lock();
        let changed = state.entries.get(&key).is_none_or(|e| e.context != context);
        if changed {
            if let Some(abort) = state.entries.get_mut(&key).and_then(|entry| entry.abort.take()) {
                abort.abort();
            }
            state.generation += 1;
            let generation = state.generation;
            let saved =
                shared.known.lock().get(&spec.id).and_then(|known| known.catalogs.get(&shared.root_key())).cloned();
            let matching = saved.as_ref().is_some_and(|saved| saved.fingerprint == context.fingerprint());
            let age = saved
                .as_ref()
                .filter(|_| matching)
                .and_then(|saved| saved.catalog.refreshed_at_ms)
                .map(|at| self.epoch_ms() - at)
                .filter(|age| *age >= 0.0 && *age < FRESH_FOR.as_millis() as f64)
                .map(|age| Duration::from_secs_f64(age / 1000.0));
            let successful = age.and_then(|age| now.checked_sub(age));
            let completed = age.filter(|age| *age < COOLDOWN).and_then(|age| now.checked_sub(age));
            let retry_at_ms = completed
                .and_then(|_| saved.as_ref().and_then(|s| s.catalog.refreshed_at_ms))
                .map(|at| at + COOLDOWN.as_millis() as f64);
            let catalog = saved.map(|saved| {
                let mut catalog = saved.catalog;
                if !matching {
                    catalog.refreshed_at_ms = None;
                    catalog.thought_levels.clear();
                }
                catalog
            });
            state.entries.insert(
                key.clone(),
                Entry {
                    context,
                    generation,
                    completed,
                    successful,
                    retry_at_ms,
                    catalog,
                    error: None,
                    flight: None,
                    abort: None,
                    flight_model: None,
                    requested_model: None,
                    model_failures: HashMap::new(),
                },
            );
        }
        let fallback =
            state.entries.get(&key).filter(|entry| entry.catalog.is_none()).map(|_| Self::fallback(shared, &spec.id));
        state.generation += 1;
        let generation = state.generation;
        let entry = state.entries.get_mut(&key).expect("catalog entry");
        let catalog = entry.catalog.as_ref().or(fallback.as_ref()).expect("cached catalog");
        let fresh = entry.successful.is_some_and(|at| now.duration_since(at) < FRESH_FOR);
        let target = model
            .filter(|model| {
                (catalog.lists(model) && !catalog.thought_levels.contains_key(*model))
                    || (!fresh && catalog.model_option().is_none())
            })
            .map(str::to_owned);
        if model.is_some() && entry.requested_model.as_deref() != model {
            entry.requested_model = model.map(str::to_owned);
        }
        let superseded = model.is_some()
            && entry.flight.is_some()
            && (entry.flight_model.is_some() || target.is_some())
            && entry.flight_model.as_deref() != target.as_deref();
        if superseded {
            if let Some(abort) = entry.abort.take() {
                abort.abort();
            }
            entry.flight = None;
            entry.generation = generation;
            entry.flight_model = None;
        }
        let cooling = match target.as_ref() {
            Some(model) => entry.model_failures.get(model).is_some_and(|f| now.duration_since(f.completed) < COOLDOWN),
            None => entry.completed.is_some_and(|at| now.duration_since(at) < COOLDOWN),
        };
        let eligible = !cooling && (target.is_some() || force || !fresh);
        let mut start = None;
        if entry.flight.is_none() && eligible {
            let (done, ready) = watch::channel(false);
            entry.flight = Some(ready);
            entry.flight_model = target.clone();
            entry.error = None;
            if let Some(model) = target.as_ref() {
                entry.model_failures.remove(model);
            }
            entry.retry_at_ms = None;
            // Every flight has its own generation, including superseded model selections.
            entry.generation = generation;
            start = Some((entry.generation, target, done));
        }
        let snapshot = self.snapshot(shared, &spec.id, entry);
        let flight = entry.flight.clone();
        drop(state);
        if superseded && start.is_none() {
            self.broadcast(shared, &snapshot);
        }
        if let Some((generation, model, done)) = start {
            self.broadcast(shared, &snapshot);
            let coordinator = self.clone();
            let shared = shared.clone();
            let flight_key = key.clone();
            let task = shared.runtime.clone().spawn(async move {
                let result = discover(&shared, spec, model.as_deref()).await;
                coordinator.complete(&shared, flight_key, generation, model, result);
                let _ = done.send(true);
            });
            // A subscriber can re-enter and change configuration during the start event.
            let mut state = self.state.lock();
            if let Some(entry) = state.entries.get_mut(&key).filter(|entry| entry.generation == generation) {
                if entry.flight.is_some() {
                    entry.abort = Some(task.abort_handle());
                }
            } else {
                task.abort();
            }
        }
        (snapshot, flight)
    }

    fn complete(
        &self,
        shared: &Shared,
        key: Key,
        generation: u64,
        model: Option<String>,
        result: Result<Discovered, String>,
    ) {
        let current = provider::load(shared.paths.custom_agents_dir.as_deref(), shared.env_secrets())
            .into_iter()
            .find(|spec| spec.id == key.2)
            .map(|spec| LaunchContext::new(spec, &shared.paths.project_root));
        let mut state = self.state.lock();
        let Some(entry) = state.entries.get_mut(&key).filter(|e| e.generation == generation) else { return };
        // Configuration may have changed without another refresh request arriving.
        if current.as_ref() != Some(&entry.context) {
            entry.flight = None;
            entry.abort = None;
            entry.flight_model = None;
            entry.completed = None;
            entry.retry_at_ms = None;
            entry.error = None;
            let snapshot = self.snapshot(shared, &key.2, entry);
            state.entries.remove(&key);
            drop(state);
            self.broadcast(shared, &snapshot);
            return;
        }
        let now = self.now();
        if model.is_none() {
            entry.completed = Some(now);
            entry.retry_at_ms = Some(self.epoch_ms() + COOLDOWN.as_millis() as f64);
        }
        entry.flight = None;
        entry.abort = None;
        entry.flight_model = None;
        let success = match result {
            Ok(found) => {
                let previous = entry.catalog.take().unwrap_or_else(|| Self::fallback(shared, &key.2));
                let mut cache = shared.known.lock();
                let known = cache.entry(key.2.clone()).or_default();
                let mut catalog = CatalogData {
                    config: found.config,
                    thought_levels: found.levels,
                    refreshed_at_ms: Some(self.epoch_ms()),
                };
                // Efforts sessions reported for models discovery doesn't read stay while listed.
                for (model, levels) in previous.thought_levels {
                    if catalog.lists(&model) && !catalog.thought_levels.contains_key(&model) {
                        catalog.thought_levels.insert(model, levels);
                    }
                }
                known.config = catalog.config.clone();
                known.thought_levels = catalog.thought_levels.clone();
                if let Some(commands) = found.commands {
                    known.commands.insert(shared.root_key(), commands);
                }
                known.authoritative = true;
                known.refreshed_at_ms = catalog.refreshed_at_ms;
                known.catalogs.insert(
                    shared.root_key(),
                    SavedCatalog { fingerprint: entry.context.fingerprint(), catalog: catalog.clone() },
                );
                entry.catalog = Some(catalog);
                shared.persist_known(&cache);
                entry.successful = Some(now);
                entry.completed = Some(now);
                entry.retry_at_ms = Some(self.epoch_ms() + COOLDOWN.as_millis() as f64);
                entry.model_failures.retain(|model, _| {
                    entry
                        .catalog
                        .as_ref()
                        .is_some_and(|catalog| catalog.lists(model) && !catalog.thought_levels.contains_key(model))
                });
                entry.error = None;
                true
            }
            Err(error) => {
                if let Some(model) = model {
                    entry.model_failures.insert(
                        model,
                        ModelFailure {
                            completed: now,
                            retry_at_ms: self.epoch_ms() + COOLDOWN.as_millis() as f64,
                            error,
                        },
                    );
                } else {
                    entry.error = Some(error);
                }
                false
            }
        };
        let snapshot = self.snapshot(shared, &key.2, entry);
        drop(state);
        self.broadcast(shared, &snapshot);
        if success {
            for subscriber in self.subscribers(shared) {
                subscriber.emit(AgentEvent::Providers);
            }
        }
    }

    /// Records the efforts a session reported for a listed `model` other than the one discovery
    /// read: ACP discovery opens one session, so it knows only that model's efforts.
    pub(crate) fn learn_levels(&self, shared: &Shared, provider: &str, model: &str, levels: Vec<AgentConfigOption>) {
        let lacks = |catalog: &CatalogData| {
            catalog.lists(model)
                && catalog.model_option().and_then(|o| o.current.as_deref()) != Some(model)
                && catalog.thought_levels.get(model) != Some(&levels)
        };
        let key = Self::key(shared, provider);
        let mut state = self.state.lock();
        let mut learned = false;
        if let Some(catalog) = state.entries.get_mut(&key).and_then(|e| e.catalog.as_mut()).filter(|c| lacks(c)) {
            catalog.thought_levels.insert(model.to_owned(), levels.clone());
            learned = true;
        }
        let mut cache = shared.known.lock();
        if let Some(saved) = cache
            .get_mut(provider)
            .and_then(|known| known.catalogs.get_mut(&shared.root_key()))
            .filter(|saved| lacks(&saved.catalog))
        {
            saved.catalog.thought_levels.insert(model.to_owned(), levels);
            learned = true;
        }
        if !learned {
            return;
        }
        shared.persist_known(&cache);
        drop(cache);
        let snapshot = state.entries.get(&key).map(|entry| self.snapshot(shared, provider, entry));
        drop(state);
        if let Some(snapshot) = snapshot {
            self.broadcast(shared, &snapshot);
        }
    }

    fn subscribers(&self, shared: &Shared) -> Vec<Arc<Shared>> {
        self.state
            .lock()
            .subscribers
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|s| {
                s.paths.models_file == shared.paths.models_file && s.paths.project_root == shared.paths.project_root
            })
            .collect()
    }

    fn broadcast(&self, shared: &Shared, catalog: &AgentModelCatalog) {
        for subscriber in self.subscribers(shared) {
            subscriber.emit(AgentEvent::ModelCatalog { catalog: catalog.clone() });
        }
    }
}

impl crate::AgentManager {
    /// Return cached choices immediately and schedule discovery when eligible.
    pub fn refresh_models(&self, provider: &str, force: bool, model: Option<&str>) -> IdeResult<AgentModelCatalog> {
        // Settings and environment secrets can change while this window is open.
        *self.shared.providers.write() =
            provider::load(self.shared.paths.custom_agents_dir.as_deref(), self.shared.env_secrets());
        let spec = self.shared.spec(provider).ok_or_else(|| IdeError::invalid(format!("unknown agent {provider}")))?;
        Ok(self.shared.paths.catalogs.request(&self.shared, spec, force, model).0)
    }
}

async fn discover(
    shared: &Arc<Shared>,
    spec: provider::ProviderSpec,
    model: Option<&str>,
) -> Result<Discovered, String> {
    match spec.driver {
        provider::Driver::Acp => acp::discover::run(shared, &spec, model).await,
        provider::Driver::Codex => native::codex::discover(spec, shared.paths.project_root.clone()).await,
        provider::Driver::Claude => {
            let found = native::claude::discover(spec.clone(), shared.paths.project_root.clone()).await?;
            Ok(Discovered {
                commands: Some(config::commands_of(
                    &serde_json::json!({ "availableCommands": found.commands }),
                    &spec.id,
                )),
                config: config::options_of(&serde_json::json!({ "configOptions": found.options })),
                levels: found
                    .efforts
                    .into_iter()
                    .map(|(model, option)| {
                        let levels = option
                            .map(|o| config::options_of(&serde_json::json!({ "configOptions": [o] })))
                            .unwrap_or_default();
                        (model, levels)
                    })
                    .collect(),
            })
        }
        provider::Driver::Copilot => {
            if shared.uses_copilot_acp_fallback(&spec) {
                let acp_spec = native::copilot::acp_fallback_spec(&spec);
                return acp::discover::run(shared, &acp_spec, model).await;
            }
            match native::copilot::discover(spec.clone(), shared.paths.project_root.clone()).await {
                Ok(found) => Ok(Discovered {
                    commands: Some(config::commands_of(
                        &serde_json::json!({ "availableCommands": found.commands }),
                        &spec.id,
                    )),
                    config: config::options_of(&serde_json::json!({ "configOptions": found.options })),
                    levels: found
                        .per_model
                        .into_iter()
                        .map(|(model, opts)| {
                            let parsed = if opts.is_empty() {
                                Vec::new()
                            } else {
                                config::options_of(&serde_json::json!({ "configOptions": opts }))
                            };
                            (model, parsed)
                        })
                        .collect(),
                }),
                Err(err) if err.allow_acp_fallback => {
                    tracing::warn!(
                        "Copilot headless catalog discovery failed ({}); falling back to `copilot --acp`",
                        err.message
                    );
                    shared.mark_copilot_acp_fallback(&spec);
                    let acp_spec = native::copilot::acp_fallback_spec(&spec);
                    acp::discover::run(shared, &acp_spec, model).await
                }
                Err(err) => Err(err.message),
            }
        }
    }
}

#[cfg(test)]
mod tests;
