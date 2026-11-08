//! Editor providers of plugins: completion, inline
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
use std::collections::{HashMap, HashSet};
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
    SemanticTokens,
    Hover,
    InlayHints,
    Diagnostics,
    Formatting,
    SignatureHelp,
    DocumentHighlights,
    DocumentLinks,
    CodeLenses,
    SelectionRanges,
    Folding,
    Colors,
    DocumentSymbols,
    Implementation,
    TypeDefinition,
    GutterActions,
    Injections,
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
        self.matching::<Vec<_>>(kind, language).into_iter().map(|(plugin, _)| plugin).collect()
    }

    /// One coherent declaration snapshot, preserving the first match per plugin.
    fn matching<T: FromIterator<(String, u64)>>(&self, kind: ProviderKind, language: &str) -> T {
        let items = self.items.read();
        let mut seen = HashSet::new();
        items
            .iter()
            .filter(|(_, plugin, kinds, languages)| {
                kinds.contains(&kind)
                    && languages.iter().any(|l| l == "*" || l == language)
                    && seen.insert(plugin.as_str())
            })
            .map(|(seq, plugin, ..)| (plugin.clone(), *seq))
            .collect()
    }

    pub(super) fn diagnostic_generations(&self, language: &str) -> HashMap<String, u64> {
        if self.any(ProviderKind::Injections) {
            let mut out = HashMap::new();
            for (seq, plugin, kinds, _) in self.items.read().iter() {
                if kinds.contains(&ProviderKind::Diagnostics) {
                    out.entry(plugin.clone()).or_insert(*seq);
                }
            }
            out
        } else {
            self.matching(ProviderKind::Diagnostics, language)
        }
    }

    pub(super) fn injection_generations(&self, language: &str) -> HashMap<String, u64> {
        self.matching(ProviderKind::Injections, language)
    }
    pub(super) fn formatter_declarations(&self) -> Vec<(String, Vec<String>)> {
        self.items
            .read()
            .iter()
            .filter(|(_, _, k, _)| k.contains(&ProviderKind::Formatting))
            .map(|(_, p, _, l)| (p.clone(), l.clone()))
            .collect()
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
        if d.kinds.contains(&ProviderKind::SemanticTokens) {
            pkg.manifest.needs_api("contributes.providers: semantic-tokens", 3)?;
        }
        if d.kinds.contains(&ProviderKind::Diagnostics) {
            pkg.manifest.needs_api("contributes.providers: diagnostics", 3)?;
        }
        if d.kinds.contains(&ProviderKind::Hover) {
            pkg.manifest.needs_api("contributes.providers: hover", 3)?;
        }
        if d.kinds.contains(&ProviderKind::InlayHints) {
            pkg.manifest.needs_api("contributes.providers: inlay-hints", 3)?;
        }
        if d.kinds.iter().any(|k| {
            matches!(
                k,
                ProviderKind::Formatting
                    | ProviderKind::SignatureHelp
                    | ProviderKind::DocumentHighlights
                    | ProviderKind::DocumentLinks
                    | ProviderKind::CodeLenses
                    | ProviderKind::SelectionRanges
                    | ProviderKind::Folding
                    | ProviderKind::Colors
                    | ProviderKind::DocumentSymbols
                    | ProviderKind::Implementation
                    | ProviderKind::TypeDefinition
                    | ProviderKind::GutterActions
                    | ProviderKind::Injections
            )
        }) {
            pkg.manifest.needs_api("contributes.providers: language features and injections", 4)?;
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

use super::{LoadedPlugin, PluginEvent, PluginHost, PluginStatus};
use ide_core::CancellationToken;
use ide_plugin::{
    ActorError, CallError, CodeAction, CompletionItem, InlineSuggestion, LineMarker, Location, Pending, PluginHover,
    PluginInlayHint, ProviderDocument, Runtime, SemanticToken,
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
    let host = editor_plugin_host()?;
    (host.providers.any(kind) || host.providers.any(ProviderKind::Injections)).then_some(host)
}

pub(crate) fn editor_plugin_host() -> Option<Arc<PluginHost>> {
    EDITOR_PROVIDERS.read().as_ref()?.upgrade()
}

impl PluginHost {
    /// Usable plugins declaring `kind` for `language`.
    pub(super) fn provider_plugins(&self, kind: ProviderKind, language: &str) -> Vec<Arc<LoadedPlugin>> {
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

    /// Edit-path calls (soft / hard deadline) to every usable plugin that
    /// declares `kind` for `language`, in plugin order, leaving out those that
    /// failed or were late. Each plugin runs on its own thread, so the calls
    /// run at the same time: the wait is the slowest plugin's, not the sum.
    pub(super) fn edit_calls<R: Send + 'static>(
        &self,
        kind: ProviderKind,
        language: &str,
        f: impl FnOnce(&mut Runtime, Duration) -> Result<R, CallError> + Clone + Send + 'static,
    ) -> Vec<(Arc<LoadedPlugin>, R)> {
        self.edit_calls_plugins(self.provider_plugins(kind, language), f)
    }

    pub(super) fn document_calls<R: Send + 'static>(
        &self,
        kind: ProviderKind,
        doc: &ProviderDocument,
        f: impl FnOnce(&mut Runtime, Duration) -> Result<R, CallError> + Clone + Send + 'static,
    ) -> Vec<(Arc<LoadedPlugin>, R)> {
        self.document_calls_for(kind, doc, None, f)
    }
    pub(super) fn document_calls_for<R: Send + 'static>(
        &self,
        kind: ProviderKind,
        doc: &ProviderDocument,
        owner: Option<&str>,
        f: impl FnOnce(&mut Runtime, Duration) -> Result<R, CallError> + Clone + Send + 'static,
    ) -> Vec<(Arc<LoadedPlugin>, R)> {
        let plugins = self
            .provider_plugins(kind, &doc.language)
            .into_iter()
            .filter(|p| {
                p.dev_root.as_ref().is_none_or(|r| doc.path.starts_with(r)) && owner.is_none_or(|id| p.id() == id)
            })
            .collect();
        self.edit_calls_plugins(plugins, f)
    }
    fn edit_calls_plugins<R: Send + 'static>(
        &self,
        plugins: Vec<Arc<LoadedPlugin>>,
        f: impl FnOnce(&mut Runtime, Duration) -> Result<R, CallError> + Clone + Send + 'static,
    ) -> Vec<(Arc<LoadedPlugin>, R)> {
        let (soft, hard) = (self.limits.edit_soft, self.limits.edit_hard);
        let queued: Vec<_> = plugins
            .into_iter()
            .filter_map(|plugin| {
                let (actor, activated) = self.ensure_active(&plugin, None).ok()?;
                if activated {
                    self.changed();
                }
                let f = f.clone();
                let started = Instant::now();
                let call = actor.submit(Some(soft), move |rt| f(rt, hard));
                Some((plugin, actor, started, call))
            })
            .collect();
        queued
            .into_iter()
            .filter_map(|(plugin, actor, started, call)| {
                let result = call.and_then(Pending::wait);
                self.finish_provider_call(&plugin, &actor, started, result).map(|r| (plugin, r))
            })
            .collect()
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
                self.record_call(plugin, elapsed, !e.is_failure(), true);
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
        self.feature_documents(doc, Some(at))
            .into_iter()
            .flat_map(|(doc, bounds)| {
                let (d, t) = (Arc::new(doc.clone()), trigger.map(str::to_owned));
                self.document_calls(ProviderKind::Completion, &doc, move |rt, timeout| {
                    rt.provide_completion(&d, at, t.as_deref(), timeout)
                })
                .into_iter()
                .flat_map(|(p, items)| items.into_iter().map(move |i| (p.id().to_owned(), i)))
                .filter_map(move |(p, mut i)| {
                    if i.replace.is_some_and(|r| !bounds.contains(r)) {
                        return None;
                    }
                    i.additional_edits.retain(|e| bounds.contains(e.range));
                    Some((p, i))
                })
            })
            .collect()
    }

    pub fn provide_code_actions(
        &self,
        doc: &ProviderDocument,
        selection: ide_core::Range,
    ) -> Vec<(String, CodeAction)> {
        let d = Arc::new(doc.clone());
        self.edit_calls(ProviderKind::CodeActions, &doc.language, move |rt, timeout| {
            rt.provide_code_actions(&d, selection, timeout)
        })
        .into_iter()
        .flat_map(|(p, actions)| actions.into_iter().map(move |a| (p.id().to_owned(), a)))
        .collect()
    }

    /// The edits of an action `plugin_id` returned with `data`, now that the
    /// user picked it: a call with the command budget, not the edit path's.
    pub fn resolve_code_action(
        &self,
        plugin_id: &str,
        doc: &ProviderDocument,
        action: CodeAction,
        invocation: ide_plugin::Invocation,
    ) -> ide_core::IdeResult<CodeAction> {
        let d = Arc::new(doc.clone());
        let timeout = self.limits.timeout;
        self.code_call(plugin_id, invocation, "resolving the code action", move |rt, inv| {
            rt.resolve_code_action(&d, &action, inv, timeout)
        })
    }

    /// Shows `path` in window `client` after a code action of `plugin_id` was applied.
    pub fn open_file(&self, plugin_id: &str, client: &str, path: ide_core::IpcPath) {
        let event = PluginEvent::OpenLocation { plugin_id: plugin_id.to_owned(), path, line: 0, column: 0 };
        self.emit(Some(client), event);
    }

    pub fn provide_definition(&self, doc: &ProviderDocument, at: ide_core::Pos) -> Vec<Location> {
        let d = Arc::new(doc.clone());
        self.edit_calls(ProviderKind::Definition, &doc.language, move |rt, timeout| {
            rt.provide_definition(&d, at, timeout)
        })
        .into_iter()
        .flat_map(|(_, locations)| locations)
        .collect()
    }

    pub fn provide_line_markers(&self, doc: &ProviderDocument) -> Vec<(String, LineMarker)> {
        let d = Arc::new(doc.clone());
        self.edit_calls(ProviderKind::LineMarkers, &doc.language, move |rt, timeout| {
            rt.provide_line_markers(&d, timeout)
        })
        .into_iter()
        .flat_map(|(p, markers)| markers.into_iter().map(move |m| (p.id().to_owned(), m)))
        .collect()
    }

    pub fn provide_semantic_tokens(&self, doc: &ProviderDocument) -> Vec<SemanticToken> {
        let d = Arc::new(doc.clone());
        self.edit_calls(ProviderKind::SemanticTokens, &doc.language, move |rt, timeout| {
            rt.provide_semantic_tokens(&d, timeout)
        })
        .into_iter()
        .flat_map(|(_, tokens)| tokens)
        .collect()
    }

    pub fn provide_diagnostics(
        &self,
        doc: &ProviderDocument,
        cancel: &CancellationToken,
    ) -> Vec<(String, Vec<ide_core::Diagnostic>)> {
        self.provide_project_diagnostics(None, doc, cancel)
    }

    pub(super) fn diagnostic_plugins(
        &self,
        project: Option<&std::path::Path>,
        language: &str,
    ) -> Vec<Arc<LoadedPlugin>> {
        let plugins = if self.providers.any(ProviderKind::Injections) {
            self.providers
                .diagnostic_generations(language)
                .keys()
                .filter_map(|id| self.get(id).ok())
                .filter(|p| {
                    let m = p.meta.lock();
                    matches!(m.status, PluginStatus::Active | PluginStatus::Inactive) && m.pending.is_empty()
                })
                .collect()
        } else {
            self.provider_plugins(ProviderKind::Diagnostics, language)
        };
        plugins.into_iter().filter(|p| p.dev_root.is_none() || p.dev_root.as_deref() == project).collect()
    }

    pub(super) fn provide_project_diagnostics(
        &self,
        project: Option<&std::path::Path>,
        doc: &ProviderDocument,
        cancel: &CancellationToken,
    ) -> Vec<(String, Vec<ide_core::Diagnostic>)> {
        let mut out = std::collections::BTreeMap::<String, Vec<ide_core::Diagnostic>>::new();
        for (d, bounds) in self.feature_documents(doc, None) {
            if cancel.is_cancelled() {
                break;
            }
            for (id, items) in self.provide_document_diagnostics(project, &d, cancel) {
                out.entry(id).or_default().extend(items.into_iter().filter(|i| bounds.contains(i.range)));
            }
        }
        out.into_iter()
            .map(|(id, mut items)| {
                items.truncate(5000);
                (id, items)
            })
            .collect()
    }

    fn provide_document_diagnostics(
        &self,
        project: Option<&std::path::Path>,
        doc: &ProviderDocument,
        cancel: &CancellationToken,
    ) -> Vec<(String, Vec<ide_core::Diagnostic>)> {
        std::thread::scope(|scope| {
            let calls: Vec<_> = self
                .provider_plugins(ProviderKind::Diagnostics, &doc.language)
                .into_iter()
                .filter(|p| p.dev_root.is_none() || p.dev_root.as_deref() == project)
                .map(|p| {
                    scope.spawn(move || {
                        if cancel.is_cancelled() {
                            return None;
                        }
                        let (actor, activated) = self.ensure_active(&p, None).ok()?;
                        if activated {
                            self.changed();
                        }
                        let (d, timeout) = (doc.clone(), self.limits.edit_hard);
                        let started = Instant::now();
                        let result =
                            actor.call_edit_cancellable(cancel, CANCEL_GRACE, self.limits.edit_soft, move |rt| {
                                rt.provide_diagnostics(&d, timeout)
                            });
                        let items = self.finish_provider_call(&p, &actor, started, result)?;
                        (!cancel.is_cancelled()).then(|| (p.id().to_owned(), items))
                    })
                })
                .collect();
            calls.into_iter().filter_map(|call| call.join().ok().flatten()).collect()
        })
    }

    pub fn provide_hover(&self, doc: &ProviderDocument, at: ide_core::Pos) -> Vec<PluginHover> {
        self.feature_documents(doc, Some(at))
            .into_iter()
            .flat_map(|(doc, bounds)| {
                let d = Arc::new(doc.clone());
                self.document_calls(ProviderKind::Hover, &doc, move |rt, timeout| rt.provide_hover(&d, at, timeout))
                    .into_iter()
                    .filter_map(|(_, h)| h)
                    .filter(move |h| h.range.is_none_or(|r| bounds.contains(r)))
            })
            .collect()
    }

    pub fn provide_inlay_hints(&self, doc: &ProviderDocument, range: ide_core::Range) -> Vec<PluginInlayHint> {
        let d = Arc::new(doc.clone());
        self.edit_calls(ProviderKind::InlayHints, &doc.language, move |rt, timeout| {
            rt.provide_inlay_hints(&d, range, timeout)
        })
        .into_iter()
        .flat_map(|(_, hints)| hints)
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_snapshots_preserve_order_first_generation_and_language_matching() {
        let providers = Arc::new(Providers::default());
        let declare = |plugin: &str, kind, language: &str| {
            providers.add(plugin.into(), Decl { kinds: vec![kind], languages: vec![language.into()] })
        };
        let mut declarations = Vec::new();
        declarations.push(declare("unrelated", ProviderKind::Hover, "*"));
        declarations.push(declare("other-language", ProviderKind::Diagnostics, "rust"));
        for i in 0..256 {
            let plugin = format!("plugin-{i}");
            declarations.push(declare(&plugin, ProviderKind::Diagnostics, "text"));
            declarations.push(declare(&plugin, ProviderKind::Diagnostics, "*"));
        }
        let expected: Vec<_> = (0..256).map(|i| format!("plugin-{i}")).collect();
        assert_eq!(providers.plugins_for(ProviderKind::Diagnostics, "text"), expected);
        let before = providers.diagnostic_generations("text");
        assert_eq!(before.len(), 256);
        assert_eq!(before["plugin-0"], 2);
        assert_eq!(providers.diagnostic_generations("rust").len(), 257);
        assert_eq!(providers.plugins_for(ProviderKind::Hover, "text"), ["unrelated"]);
        // Removing the first matching declaration must invalidate its generation,
        // even while a second declaration still provides the same language.
        drop(declarations.remove(2));
        let after = providers.diagnostic_generations("text");
        assert_eq!(after["plugin-0"], 3);
        assert_ne!(before["plugin-0"], after["plugin-0"]);
        drop(declarations);
        assert!(providers.diagnostic_generations("text").is_empty());
        let _reloaded = declare("plugin-0", ProviderKind::Diagnostics, "text");
        assert_ne!(providers.diagnostic_generations("text")["plugin-0"], after["plugin-0"]);
    }
}
