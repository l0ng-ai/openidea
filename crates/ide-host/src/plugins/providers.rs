//! Editor providers of plugins (docs/plugin_plan.md P6): completion, inline
//! completion, code actions, go to definition and gutter line markers, for
//! the languages a plugin declares. The host calls only plugins whose
//! declaration matches, so the others stay unloaded.
//!
//! ```toml
//! [[contributes.providers]]
//! kinds = ["definition", "line-markers"]
//! languages = ["java", "xml"]        # editor language ids; "*" for any
//! ```
//!
//! And `[[contributes.secrets]]`: secrets the user can store for the plugin
//! (shown in Settings › Plugins), used only through `net` request headers.
//!
//! ```toml
//! [[contributes.secrets]]
//! name = "api-key"
//! label = "API key"
//! description = "Create one at https://example.com/keys"
//! ```

use ide_extension::{Disposable, ExtensionPoint, Package, Placement, Prepared, UiDecl, decode, validate_item_id};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub const POINT_ID: &str = "providers";
pub const SECRETS_POINT: &str = "secrets";

/// What a plugin can provide in the editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Completion,
    InlineCompletion,
    CodeActions,
    Definition,
    LineMarkers,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    kinds: Vec<ProviderKind>,
    languages: Vec<String>,
}

/// (sequence, plugin, kinds, languages) of one declaration.
type Declared = (u64, String, Vec<ProviderKind>, Vec<String>);

/// Provider declarations of enabled plugins.
#[derive(Default)]
pub struct Providers {
    items: RwLock<Vec<Declared>>,
    seq: AtomicU64,
}

impl Providers {
    fn add(self: &Arc<Self>, plugin: String, decl: Decl) -> Disposable {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        self.items.write().push((seq, plugin, decl.kinds, decl.languages));
        let weak = Arc::downgrade(self);
        Disposable::new(move || {
            if let Some(this) = weak.upgrade() {
                this.items.write().retain(|(s, ..)| *s != seq);
            }
        })
    }

    /// Plugins providing `kind` for `language`, in declaration order.
    pub fn plugins_for(&self, kind: ProviderKind, language: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for (_, plugin, kinds, languages) in self.items.read().iter() {
            if kinds.contains(&kind) && languages.iter().any(|l| l == "*" || l == language) && !out.contains(plugin) {
                out.push(plugin.clone());
            }
        }
        out
    }

    /// Whether any plugin provides `kind` (for any language).
    pub fn any(&self, kind: ProviderKind) -> bool {
        self.items.read().iter().any(|(_, _, kinds, _)| kinds.contains(&kind))
    }
}

pub struct ProvidersPoint {
    store: Arc<Providers>,
}

impl ProvidersPoint {
    pub fn new(store: Arc<Providers>) -> Self {
        Self { store }
    }
}

impl ExtensionPoint for ProvidersPoint {
    fn id(&self) -> &'static str {
        POINT_ID
    }

    fn placement(&self) -> Placement {
        Placement::Workspace
    }

    fn prepare(&self, pkg: &Package, decl: toml::Value) -> Result<Prepared, String> {
        let d: Decl = decode(POINT_ID, decl)?;
        if pkg.manifest.wasm.is_none() {
            return Err("contributes.providers: providers need code (`wasm`)".into());
        }
        if d.kinds.is_empty() || d.languages.is_empty() || d.languages.len() > 64 {
            return Err("contributes.providers: give `kinds` and 1–64 `languages`".into());
        }
        for l in &d.languages {
            if l != "*"
                && (l.is_empty()
                    || l.len() > 64
                    || !l.chars().all(|c| c.is_ascii_alphanumeric() || "-_.+#".contains(c)))
            {
                return Err(format!("contributes.providers: invalid language id {l:?}"));
            }
        }
        let label = format!(
            "{} for {}",
            d.kinds
                .iter()
                .map(|k| serde_json::to_value(k).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default())
                .collect::<Vec<_>>()
                .join(", "),
            d.languages.join(", ")
        );
        let (store, plugin) = (self.store.clone(), pkg.id().to_owned());
        Ok(Prepared::new(label, move || Ok(store.add(plugin, d))))
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SecretDecl {
    name: String,
    label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

/// `[[contributes.secrets]]` (a UI point: Settings › Plugins lists them).
pub(super) fn secret(_pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: SecretDecl = decode(SECRETS_POINT, decl)?;
    validate_item_id(&d.name, "secret name")?;
    if d.label.trim().is_empty() || d.label.len() > 128 || d.description.as_ref().is_some_and(|x| x.len() > 1024) {
        return Err(format!("secret {:?}: `label` 1–128 bytes, `description` up to 1 KiB", d.name));
    }
    let json = serde_json::to_value(&d).map_err(|e| e.to_string())?;
    Ok(UiDecl::new(d.name.clone(), d.label, json))
}

// ---- dispatch ---------------------------------------------------------------

use super::{LoadedPlugin, PluginHost, PluginStatus};
use ide_core::CancellationToken;
use ide_plugin::{
    ActorError, CallError, CodeAction, CompletionItem, InlineSuggestion, LineMarker, Location, ProviderDocument,
    Runtime,
};
use std::sync::Weak;
use std::time::{Duration, Instant};

/// How long a superseded inline completion may take to return after its
/// request was cancelled before it is interrupted.
const CANCEL_GRACE: Duration = Duration::from_millis(250);

static EDITOR_PROVIDERS: RwLock<Option<Weak<PluginHost>>> = RwLock::new(None);

/// Makes `host`'s plugin providers part of completion, code actions, go to
/// definition and inline completion (`None` removes them).
pub fn set_editor_providers(host: Option<&Arc<PluginHost>>) {
    *EDITOR_PROVIDERS.write() = host.map(Arc::downgrade);
}

/// The plugin host whose providers take part, when any declares `kind`.
pub(crate) fn editor_providers(kind: ProviderKind) -> Option<Arc<PluginHost>> {
    let host = EDITOR_PROVIDERS.read().as_ref()?.upgrade()?;
    host.providers.any(kind).then_some(host)
}

impl PluginHost {
    /// Usable plugins declaring `kind` for `language`.
    fn provider_plugins(&self, kind: ProviderKind, language: &str) -> Vec<Arc<LoadedPlugin>> {
        self.providers
            .plugins_for(kind, language)
            .into_iter()
            .filter_map(|id| self.get(&id).ok())
            .filter(|p| {
                let m = p.meta.lock();
                matches!(m.status, PluginStatus::Active | PluginStatus::Inactive) && m.pending.is_empty()
            })
            .collect()
    }

    /// One edit-path call (soft / hard deadline); `None` when it failed or was late.
    fn edit_call<R: Send + 'static>(
        &self,
        plugin: &Arc<LoadedPlugin>,
        f: impl FnOnce(&mut Runtime, Duration) -> Result<R, CallError> + Send + 'static,
    ) -> Option<R> {
        let (actor, activated) = self.ensure_active(plugin, None).ok()?;
        if activated {
            self.changed();
        }
        let started = Instant::now();
        let hard = self.limits.edit_hard;
        let result = actor.call(Some(self.limits.edit_soft), move |rt| f(rt, hard));
        self.finish_provider_call(plugin, &actor, started, result)
    }

    pub(super) fn finish_provider_call<R>(
        &self,
        plugin: &Arc<LoadedPlugin>,
        actor: &Arc<ide_plugin::Actor>,
        started: Instant,
        result: Result<R, ActorError>,
    ) -> Option<R> {
        let elapsed = started.elapsed();
        match result {
            Ok(r) => {
                self.record_call(plugin, elapsed, true, true);
                Some(r)
            }
            Err(ActorError::SoftTimeout) => {
                plugin.meta.lock().stats.slow_calls += 1;
                None
            }
            Err(ActorError::Cancelled) => None,
            Err(ActorError::Call(CallError::Guest(e))) => {
                self.record_call(plugin, elapsed, false, true);
                tracing::debug!(plugin = %plugin.id(), "provider: {e}");
                None
            }
            Err(ActorError::Call(CallError::Trap(_)) | ActorError::Stopped) => {
                self.record_call(plugin, elapsed, false, false);
                self.reap(plugin, actor, None);
                None
            }
        }
    }

    pub fn provide_completion(
        &self,
        doc: &ProviderDocument,
        at: ide_core::Pos,
        trigger: Option<&str>,
    ) -> Vec<(String, CompletionItem)> {
        let mut out = Vec::new();
        for p in self.provider_plugins(ProviderKind::Completion, &doc.language) {
            let (d, t) = (doc.clone(), trigger.map(str::to_owned));
            if let Some(items) =
                self.edit_call(&p, move |rt, timeout| rt.provide_completion(&d, at, t.as_deref(), timeout))
            {
                out.extend(items.into_iter().map(|i| (p.id().to_owned(), i)));
            }
        }
        out
    }

    pub fn provide_code_actions(
        &self,
        doc: &ProviderDocument,
        selection: ide_core::Range,
    ) -> Vec<(String, CodeAction)> {
        let mut out = Vec::new();
        for p in self.provider_plugins(ProviderKind::CodeActions, &doc.language) {
            let d = doc.clone();
            if let Some(actions) =
                self.edit_call(&p, move |rt, timeout| rt.provide_code_actions(&d, selection, timeout))
            {
                out.extend(actions.into_iter().map(|a| (p.id().to_owned(), a)));
            }
        }
        out
    }

    pub fn provide_definition(&self, doc: &ProviderDocument, at: ide_core::Pos) -> Vec<Location> {
        let mut out = Vec::new();
        for p in self.provider_plugins(ProviderKind::Definition, &doc.language) {
            let d = doc.clone();
            if let Some(locations) = self.edit_call(&p, move |rt, timeout| rt.provide_definition(&d, at, timeout)) {
                out.extend(locations);
            }
        }
        out
    }

    pub fn provide_line_markers(&self, doc: &ProviderDocument) -> Vec<(String, LineMarker)> {
        let mut out = Vec::new();
        for p in self.provider_plugins(ProviderKind::LineMarkers, &doc.language) {
            let d = doc.clone();
            if let Some(markers) = self.edit_call(&p, move |rt, timeout| rt.provide_line_markers(&d, timeout)) {
                out.extend(markers.into_iter().map(|m| (p.id().to_owned(), m)));
            }
        }
        out
    }

    /// Ghost text from the first plugin that has some. Not bound by the
    /// edit-path soft deadline (it may need the network) but by `cancel`:
    /// the editor cancels a request as soon as the user types on.
    pub fn provide_inline_completion(
        &self,
        doc: &ProviderDocument,
        at: ide_core::Pos,
        cancel: &CancellationToken,
    ) -> Option<(String, InlineSuggestion)> {
        for p in self.provider_plugins(ProviderKind::InlineCompletion, &doc.language) {
            if cancel.is_cancelled() {
                return None;
            }
            let Ok((actor, activated)) = self.ensure_active(&p, None) else { continue };
            if activated {
                self.changed();
            }
            let (d, timeout) = (doc.clone(), self.limits.timeout);
            let started = Instant::now();
            let result =
                actor.call_cancellable(cancel, CANCEL_GRACE, move |rt| rt.provide_inline_completion(&d, at, timeout));
            if let Some(Some(s)) = self.finish_provider_call(&p, &actor, started, result) {
                return Some((p.id().to_owned(), s));
            }
        }
        None
    }
}
