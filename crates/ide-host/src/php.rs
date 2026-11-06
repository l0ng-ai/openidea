//! The native PHP engine (`ide-php`) of a project.
//!
//! [`PhpEngineSlot`] holds the project's [`PhpEngine`] while Settings › PHP ›
//! Engine is `Native` ([`PhpEngineSlot::apply`] starts and stops it when the
//! setting changes). The engine itself stays inactive in a project without
//! PHP. Open PHP documents reach it through [`PhpObserver`], watcher batches
//! through [`PhpEngineSlot::files_changed`].
//!
//! The engine's dumb-mode events are merged with the project index's by
//! [`IndexStates`]: the frontend keeps only the latest `IndexState`, so two
//! producers reporting on their own would end each other's dumb mode.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ide_core::settings::{PhpEngineKind, Settings};
use ide_core::{CancellationToken, DocId, EventSink, IdeEvent, Location, OutlineItem, Pos, Range, SharedSink};
use ide_lsp::types::{
    CompletionItem, CompletionKind, CompletionList, GotoKind, Hover, InlayHint, InlayKind, Markup, Signature,
    SignatureHelp, WorkspaceSymbol,
};

use crate::language_service::Answer;
use ide_php::complete::{Completion, CompletionData};
use ide_php::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use ide_php::project::LayoutConfig;
use ide_php::stubs::StubFilter;
use ide_text::AppliedChange;
use ide_workspace::documents::DocumentObserver;
use ide_workspace::{DocumentInfo, Documents};
use parking_lot::{Mutex, RwLock};

/// Whether the settings ask for the native engine.
pub(crate) fn wanted(settings: &Settings) -> bool {
    settings.languages.php.engine == PhpEngineKind::Native
}

/// The layout settings: Settings › PHP include paths and the user's excluded
/// folders (as `ide_php::project::ProjectLayout::from_settings` reads them).
pub(crate) fn layout_config(root: &Path, settings: &Settings) -> LayoutConfig {
    LayoutConfig {
        root: root.to_path_buf(),
        include_paths: ide_sdk::php::include_paths(root, settings).into_iter().map(PathBuf::from).collect(),
        excludes: settings.exclude_globs(),
    }
}

/// The project's PHP engine, while the settings ask for it.
pub struct PhpEngineSlot {
    root: PathBuf,
    cache_dir: PathBuf,
    sink: SharedSink,
    documents: Arc<Documents>,
    engine: RwLock<Option<Arc<PhpEngine>>>,
    /// Serializes starts and stops.
    switching: Mutex<()>,
}

impl PhpEngineSlot {
    /// `project_cache_dir` is the project's cache directory; the index goes in
    /// its `php` subdirectory. `sink` receives the engine's events.
    pub(crate) fn new(root: &Path, project_cache_dir: &Path, sink: SharedSink, documents: Arc<Documents>) -> Self {
        Self {
            root: root.to_path_buf(),
            cache_dir: project_cache_dir.join(CACHE_SUBDIR),
            sink,
            documents,
            engine: RwLock::new(None),
            switching: Mutex::new(()),
        }
    }

    /// The running engine, if Settings › PHP › Engine is `Native`.
    pub fn engine(&self) -> Option<Arc<PhpEngine>> {
        self.engine.read().clone()
    }

    /// Starts the engine when the settings ask for it (feeding it the PHP
    /// documents already open), stops it when they don't, and passes changed
    /// include paths or excluded folders to a running one.
    pub fn apply(&self, settings: &Settings) {
        let _switching = self.switching.lock();
        let config = layout_config(&self.root, settings);
        let current = self.engine();
        match (wanted(settings), current) {
            (true, Some(engine)) => {
                engine.set_layout_config(config);
                engine.set_stub_filter(StubFilter::from_settings(&self.root, settings));
            }
            (true, None) => {
                let engine = match PhpEngine::open(
                    EngineConfig {
                        cache_dir: self.cache_dir.clone(),
                        layout: config,
                        stubs: StubFilter::from_settings(&self.root, settings),
                    },
                    self.sink.clone(),
                ) {
                    Ok(engine) => engine,
                    Err(e) => {
                        tracing::warn!("php engine: {e}");
                        return;
                    }
                };
                *self.engine.write() = Some(engine.clone());
                for doc in self.documents.open_documents() {
                    if let Ok(info) = self.documents.snapshot(doc)
                        && is_php_document(&info)
                    {
                        engine.document_opened(info.id, info.path.as_ref(), info.version, &info.text);
                    }
                }
            }
            (false, Some(_)) => self.shutdown_locked(),
            (false, None) => {}
        }
    }

    /// A watcher batch below the project folder.
    pub(crate) fn files_changed(&self, changed: &[PathBuf], removed: &[PathBuf]) {
        if let Some(engine) = self.engine() {
            engine.files_changed(changed, removed);
        }
    }

    /// Stops the engine (the project closes, or the setting changed).
    pub fn shutdown(&self) {
        let _switching = self.switching.lock();
        self.shutdown_locked();
    }

    fn shutdown_locked(&self) {
        // Stop it before emptying the slot, so whoever sees no engine also
        // sees it stopped (its status and the `LanguageServerRemoved` event).
        let engine = self.engine();
        if let Some(engine) = engine {
            engine.shutdown();
        }
        self.engine.write().take();
    }
}

fn is_php_document(info: &DocumentInfo) -> bool {
    info.language.as_str() == "php" && info.uri.is_none() && !info.large
}

/// Feeds open PHP documents to the engine, so their buffers override the
/// files on disk.
pub(crate) struct PhpObserver(pub(crate) Arc<PhpEngineSlot>);

impl DocumentObserver for PhpObserver {
    fn opened(&self, info: &DocumentInfo) {
        if is_php_document(info)
            && let Some(engine) = self.0.engine()
        {
            engine.document_opened(info.id, info.path.as_ref(), info.version, &info.text);
        }
    }

    fn changed(
        &self,
        doc: DocId,
        _path: &Path,
        version: u32,
        _changes: &[AppliedChange],
        full_text: &dyn Fn() -> String,
    ) {
        if let Some(engine) = self.0.engine()
            && engine.is_open(doc)
        {
            engine.document_changed(doc, version, &full_text());
        }
    }

    fn closed(&self, doc: DocId, _path: &Path) {
        if let Some(engine) = self.0.engine() {
            engine.document_closed(doc);
        }
    }
}

/// The engine as the PHP [`LanguageService`](crate::language_service::LanguageService):
/// registered for `php` in every project, it answers only while the engine
/// runs (Settings › PHP › Engine is `Native`); otherwise requests go to
/// Intelephense. The requests it answers natively are added feature by feature:
/// so far document and workspace symbols, hover, goto definition and type
/// definition (names, members, named arguments and variables),
/// completion with lazily resolved documentation, signature help and inlay
/// hints (parameter names and types; Editor › Inlay Hints decides which
/// kinds the editor shows).
pub(crate) struct PhpService(pub(crate) Arc<PhpEngineSlot>);

/// The most workspace symbols one query returns.
const WORKSPACE_SYMBOLS: usize = 200;

impl crate::language_service::LanguageService for PhpService {
    fn document_symbols(&self, doc: DocId) -> Answer<Option<Vec<OutlineItem>>> {
        let items = self.0.engine()?.document_symbols(doc)?;
        Some(Ok(Some(items)))
    }

    fn workspace_symbols(&self, query: &str, cancel: &CancellationToken) -> Answer<Vec<WorkspaceSymbol>> {
        let engine = self.0.engine()?;
        let symbols = engine.workspace_symbols(query, WORKSPACE_SYMBOLS, cancel).map(|symbols| {
            symbols
                .into_iter()
                .map(|s| WorkspaceSymbol {
                    name: s.name,
                    kind: s.kind,
                    container: s.container,
                    location: Location::file(s.path, s.range),
                })
                .collect()
        });
        Some(symbols)
    }

    fn completion(
        &self,
        doc: DocId,
        pos: Pos,
        trigger: Option<&str>,
        cancel: &CancellationToken,
    ) -> Answer<CompletionList> {
        let engine = self.0.engine()?;
        if !engine.is_open(doc) {
            return None;
        }
        let server = engine.server_id();
        let found = engine.completion(doc, pos, trigger, cancel)?;
        let items = found.items.into_iter().map(|item| completion_item(item, server)).collect();
        Some(Ok(CompletionList { is_incomplete: found.incomplete, items }))
    }

    fn resolve_completion(&self, doc: DocId, item: &CompletionItem) -> Answer<CompletionItem> {
        let engine = self.0.engine()?;
        let data: CompletionData = serde_json::from_value(item.data.clone()?).ok()?;
        let mut item = item.clone();
        if item.documentation.is_none()
            && let Some(markdown) = engine.completion_documentation(doc, &data)
        {
            item.documentation = Some(Markup { kind: "markdown".into(), value: markdown });
        }
        Some(Ok(item))
    }

    fn hover(&self, doc: DocId, pos: Pos, _cancel: &CancellationToken) -> Answer<Option<Hover>> {
        let engine = self.0.engine()?;
        if !engine.is_open(doc) {
            return None;
        }
        let hover = engine.hover(doc, pos).map(|hover| Hover {
            contents: Markup { kind: "markdown".into(), value: hover.markdown },
            range: Some(hover.range),
        });
        Some(Ok(hover))
    }

    fn signature_help(&self, doc: DocId, pos: Pos) -> Answer<Option<SignatureHelp>> {
        let engine = self.0.engine()?;
        if !engine.is_open(doc) {
            return None;
        }
        let help = engine.signature_help(doc, pos).map(|help| SignatureHelp {
            signatures: help
                .signatures
                .into_iter()
                .map(|s| Signature {
                    label: s.label,
                    documentation: s.documentation.map(|value| Markup { kind: "markdown".into(), value }),
                    parameters: s.parameters,
                })
                .collect(),
            active_signature: 0,
            active_parameter: help.active_parameter,
        });
        Some(Ok(help))
    }

    fn inlay_hints(&self, doc: DocId, range: Range) -> Answer<Vec<InlayHint>> {
        use ide_php::signature::InlayHintKind;
        let engine = self.0.engine()?;
        if !engine.is_open(doc) {
            return None;
        }
        let hints = engine.inlay_hints(doc, range)?;
        let hints = hints
            .into_iter()
            .map(|hint| InlayHint {
                position: hint.position,
                label: hint.label,
                kind: match hint.kind {
                    InlayHintKind::Parameter => InlayKind::Parameter,
                    InlayHintKind::Type => InlayKind::Type,
                },
                padding_left: hint.padding_left,
                padding_right: hint.padding_right,
                tooltip: hint.tooltip,
                parts: Vec::new(),
            })
            .collect();
        Some(Ok(hints))
    }

    fn goto(&self, doc: DocId, pos: Pos, kind: GotoKind) -> Answer<Vec<Location>> {
        let engine = self.0.engine()?;
        let targets = match kind {
            GotoKind::Definition | GotoKind::Declaration => engine.definition(doc, pos)?,
            GotoKind::TypeDefinition => engine.type_definition(doc, pos)?,
            GotoKind::Implementation => return None,
        };
        Some(Ok(targets.into_iter().map(|t| Location::file(t.path, t.range)).collect()))
    }
}

/// An engine completion item as the editor takes it.
fn completion_item(item: Completion, server: ide_core::ServerId) -> CompletionItem {
    use ide_php::complete::CompletionKind as Kind;
    let kind = match item.kind {
        Kind::Class | Kind::Trait => CompletionKind::Class,
        Kind::Interface => CompletionKind::Interface,
        Kind::Enum => CompletionKind::Enum,
        Kind::Function => CompletionKind::Function,
        Kind::Method => CompletionKind::Method,
        Kind::Property => CompletionKind::Property,
        Kind::Constant => CompletionKind::Constant,
        Kind::EnumCase => CompletionKind::EnumMember,
        Kind::Variable | Kind::Parameter => CompletionKind::Variable,
        Kind::Keyword => CompletionKind::Keyword,
        Kind::Value => CompletionKind::Value,
    };
    CompletionItem {
        label: item.label,
        label_detail: item.label_detail,
        detail: item.detail,
        kind: Some(kind),
        documentation: None,
        sort_text: Some(item.sort_text),
        filter_text: item.filter_text,
        preselect: false,
        deprecated: item.deprecated,
        insert_text: item.insert_text,
        is_snippet: item.is_snippet,
        replace_range: Some(item.replace),
        replace_range_tab: item.replace_tab,
        additional_edits: item.additional_edits,
        commit_characters: Vec::new(),
        command: None,
        data: item.data.and_then(|data| serde_json::to_value(data).ok()),
        server,
    }
}

/// Merges the `IndexState` events of several producers (the project index,
/// the PHP engine) into one: indexing while any of them is, with the counts
/// of those indexing (of the first producer once none is).
pub(crate) struct IndexStates {
    sink: SharedSink,
    states: Mutex<Vec<Option<(bool, u32, u32)>>>,
}

impl IndexStates {
    pub(crate) fn new(sink: SharedSink, producers: usize) -> Arc<Self> {
        Arc::new(Self { sink, states: Mutex::new(vec![None; producers]) })
    }

    /// The sink producer `slot` emits through: its `IndexState` events are
    /// merged, everything else passes through.
    pub(crate) fn producer(self: &Arc<Self>, slot: usize) -> SharedSink {
        Arc::new(Producer { merge: self.clone(), slot })
    }

    fn update(&self, slot: usize, state: (bool, u32, u32)) {
        let merged = {
            let mut states = self.states.lock();
            states[slot] = Some(state);
            let busy: Vec<(bool, u32, u32)> = states.iter().flatten().copied().filter(|s| s.0).collect();
            if busy.is_empty() {
                let (_, files, symbols) = states.iter().flatten().next().copied().unwrap_or(state);
                (false, files, symbols)
            } else {
                busy.iter().fold((true, 0u32, 0u32), |(_, f, s), (_, files, symbols)| {
                    (true, f.saturating_add(*files), s.saturating_add(*symbols))
                })
            }
        };
        let (indexing, files, symbols) = merged;
        self.sink.emit(IdeEvent::IndexState { indexing, files, symbols });
    }
}

struct Producer {
    merge: Arc<IndexStates>,
    slot: usize,
}

impl EventSink for Producer {
    fn emit(&self, event: IdeEvent) {
        match event {
            IdeEvent::IndexState { indexing, files, symbols } => {
                self.merge.update(self.slot, (indexing, files, symbols))
            }
            other => self.merge.sink.emit(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_states_stay_indexing_while_any_producer_is() {
        let seen: Arc<Mutex<Vec<(bool, u32, u32)>>> = Arc::default();
        let sink: SharedSink = {
            let seen = seen.clone();
            Arc::new(move |e: IdeEvent| {
                if let IdeEvent::IndexState { indexing, files, symbols } = e {
                    seen.lock().push((indexing, files, symbols));
                }
            })
        };
        let merge = IndexStates::new(sink, 2);
        let (index, php) = (merge.producer(0), merge.producer(1));
        index.emit(IdeEvent::IndexState { indexing: true, files: 10, symbols: 100 });
        php.emit(IdeEvent::IndexState { indexing: true, files: 3, symbols: 7 });
        index.emit(IdeEvent::IndexState { indexing: false, files: 12, symbols: 120 });
        php.emit(IdeEvent::IndexState { indexing: false, files: 3, symbols: 7 });
        assert_eq!(
            *seen.lock(),
            [(true, 10, 100), (true, 13, 107), (true, 3, 7), (false, 12, 120)],
            "the index finishing first doesn't end dumb mode; the counts at rest are the index's"
        );
    }

    #[test]
    fn other_events_pass_through() {
        let seen: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
        let sink: SharedSink = {
            let seen = seen.clone();
            Arc::new(move |e: IdeEvent| seen.lock().push(e))
        };
        let merge = IndexStates::new(sink, 2);
        merge.producer(1).emit(IdeEvent::LanguageServerRemoved { server: ide_core::ServerId(7) });
        assert!(matches!(seen.lock().as_slice(), [IdeEvent::LanguageServerRemoved { .. }]));
    }
}
