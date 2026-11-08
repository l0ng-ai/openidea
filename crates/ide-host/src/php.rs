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
use ide_core::{
    CancellationToken, DocId, EventSink, IdeEvent, Location, OutlineItem, Pos, Range, SharedSink, TextEdit,
    WorkspaceEdit,
};
use ide_lsp::types::{
    CallHierarchy, CodeAction, CodeActionQuery, CodeLens, Command, CompletionItem, CompletionKind, CompletionList,
    FormatOptions, GotoKind, HierarchyChoice, HierarchyClass, HierarchyDirection, HierarchyItem, HierarchyMember,
    HierarchyMemberKind, HierarchyMembers, HierarchyRefactored, HierarchyRefactoring, Highlight, HighlightKind, Hover,
    InlayHint, InlayKind, InlayLabelPart, Markup, ProblemSeverity, RefactoringProblem, References, Renamed,
    SemanticTokens, Signature, SignatureHelp, WorkspaceSymbol,
};

use crate::language_service::Answer;
use ide_php::complete::{Completion, CompletionData};
use ide_php::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use ide_php::inspect::InspectionConfig;
use ide_php::project::LayoutConfig;
use ide_php::refactor::{CHANGE_SIGNATURE, ChangeSignature};
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
    /// include paths, excluded folders, language level and inspection
    /// settings (the inspection profile in effect) to a running one.
    pub fn apply(&self, settings: &Settings) {
        let _switching = self.switching.lock();
        let config = layout_config(&self.root, settings);
        let current = self.engine();
        match (wanted(settings), current) {
            (true, Some(engine)) => {
                engine.set_laravel_settings(settings.languages.php.laravel.clone());
                engine.set_layout_config(config);
                engine.set_stub_filter(StubFilter::from_settings(&self.root, settings));
                engine.configure_inspections(InspectionConfig::from_settings(settings));
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
                engine.configure_inspections(InspectionConfig::from_settings(settings));
                engine.set_laravel_settings(settings.languages.php.laravel.clone());
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
/// completion with lazily resolved documentation, signature help, inlay
/// hints (parameter names and types; Editor › Inlay Hints decides which
/// kinds the editor shows), semantic tokens, find usages, goto
/// implementation (also for the gutter markers), the type and call
/// hierarchies, rename, the document highlights of framework string
/// references, the Laravel route lenses and URI hints, the reference
/// updates of file moves, the
/// code actions (inspection quick-fixes, auto-import fixes, Optimize
/// Imports, the refactorings, Change Signature resolved with the
/// dialog's new signature, and Laravel's "Create translation key…" whose
/// dialog the client runs), Pull Members Up / Push Members Down and
/// Reformat Code. Diagnostics don't go through it: the engine inspects open
/// documents in the background and publishes them itself.
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

    /// Reformat Code through `mago-formatter` (PSR-12 with the editor's
    /// indentation and line length). Files with syntax errors get no edits.
    fn format(
        &self,
        doc: DocId,
        range: Option<Range>,
        options: &FormatOptions,
        line_width: u32,
    ) -> Answer<Vec<TextEdit>> {
        let engine = self.0.engine()?;
        let options =
            ide_php::format::FormatOptions { indent: options.tab_size, use_tabs: !options.insert_spaces, line_width };
        Some(Ok(engine.format(doc, range, &options)?))
    }

    fn inlay_hints(&self, doc: DocId, range: Range) -> Answer<Vec<InlayHint>> {
        use ide_php::signature::InlayHintKind;
        let engine = self.0.engine()?;
        if !engine.is_open(doc) {
            return None;
        }
        let hints = engine.inlay_hints(doc, range)?;
        let routes = engine.laravel_route_hints(doc, range).unwrap_or_default();
        let mut hints: Vec<InlayHint> = hints
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
        // Laravel: the full URI after each route registration.
        hints.extend(routes.into_iter().map(|hint| InlayHint {
            position: hint.position,
            label: hint.label.clone(),
            kind: InlayKind::Other,
            padding_left: true,
            padding_right: false,
            tooltip: None,
            parts: vec![InlayLabelPart {
                value: hint.label,
                tooltip: None,
                location: None,
                command: route_command(String::new(), &hint.routes),
            }],
        }));
        hints.sort_by_key(|hint| (hint.position.line, hint.position.col));
        Some(Ok(hints))
    }

    /// Laravel: the routes pointing to each controller method.
    fn code_lens(&self, doc: DocId) -> Answer<Vec<CodeLens>> {
        let engine = self.0.engine()?;
        if !engine.is_open(doc) {
            return None;
        }
        let lenses = engine.laravel_route_lenses(doc).unwrap_or_default();
        let lenses = lenses
            .into_iter()
            .map(|lens| CodeLens { range: lens.range, command: route_command(lens.title(), &lens.routes) })
            .collect();
        Some(Ok(lenses))
    }

    fn semantic_tokens(&self, doc: DocId) -> Answer<Option<SemanticTokens>> {
        use ide_php::semantic::{TOKEN_MODIFIERS, TOKEN_TYPES};
        let engine = self.0.engine()?;
        let tokens = engine.semantic_tokens(doc)?;
        let mut data = Vec::with_capacity(tokens.len() * 5);
        for token in tokens {
            data.extend([token.start.line, token.start.col, token.len, token.ty.index(), token.modifiers]);
        }
        Some(Ok(Some(SemanticTokens {
            data,
            token_types: TOKEN_TYPES.iter().map(|t| t.to_string()).collect(),
            token_modifiers: TOKEN_MODIFIERS.iter().map(|m| m.to_string()).collect(),
        })))
    }

    fn goto(&self, doc: DocId, pos: Pos, kind: GotoKind) -> Answer<Vec<Location>> {
        let engine = self.0.engine()?;
        let targets = match kind {
            GotoKind::Definition | GotoKind::Declaration => engine.definition(doc, pos)?,
            GotoKind::TypeDefinition => engine.type_definition(doc, pos)?,
            GotoKind::Implementation => match engine.implementations(doc, &[pos], &CancellationToken::new())? {
                Ok(mut found) => found.pop().unwrap_or_default(),
                Err(e) => return Some(Err(e)),
            },
        };
        Some(Ok(targets.into_iter().map(|t| Location::file(t.path, t.range)).collect()))
    }

    /// Gutter markers: the implementations at each position.
    fn implementations(&self, doc: DocId, positions: &[Pos], cancel: &CancellationToken) -> Answer<Vec<Vec<Location>>> {
        let engine = self.0.engine()?;
        let found = engine.implementations(doc, positions, cancel)?.map(|lists| {
            lists
                .into_iter()
                .map(|targets| targets.into_iter().map(|t| Location::file(t.path, t.range)).collect())
                .collect()
        });
        Some(found)
    }

    fn type_hierarchy(&self, doc: DocId, pos: Pos, direction: HierarchyDirection) -> Answer<Vec<HierarchyItem>> {
        let engine = self.0.engine()?;
        let found = engine.type_hierarchy(doc, pos, engine_direction(direction))?;
        Some(found.map(|entries| entries.into_iter().map(hierarchy_item).collect()))
    }

    fn call_hierarchy(
        &self,
        doc: DocId,
        pos: Pos,
        direction: HierarchyDirection,
        cancel: &CancellationToken,
    ) -> Answer<CallHierarchy> {
        let engine = self.0.engine()?;
        let found = engine.call_hierarchy(doc, pos, engine_direction(direction), cancel)?;
        Some(found.map(|entries| CallHierarchy {
            items: entries.into_iter().map(hierarchy_item).collect(),
            incomplete: None,
        }))
    }

    /// Find usages: every file of the engine's index is in scope, so
    /// `project_wide` changes nothing. PHPDoc and string usages are listed
    /// with the code ones.
    fn references(
        &self,
        doc: DocId,
        pos: Pos,
        include_declaration: bool,
        _project_wide: bool,
        cancel: &CancellationToken,
    ) -> Answer<References> {
        let engine = self.0.engine()?;
        let usages = match engine.references(doc, pos, include_declaration, cancel)? {
            Ok(usages) => usages,
            Err(e) => return Some(Err(e)),
        };
        let locations = usages.into_iter().map(|usage| Location::file(usage.path, usage.range)).collect();
        Some(Ok(References { locations, ..References::default() }))
    }

    /// The usages and declaration of a framework string reference
    /// (`config('app.name')`) in the document; other places go to the
    /// language servers as before.
    fn document_highlights(&self, doc: DocId, pos: Pos) -> Answer<Vec<Highlight>> {
        let engine = self.0.engine()?;
        let found = engine.string_highlights(doc, pos)?;
        let highlights = found
            .into_iter()
            .map(|found| Highlight {
                range: found.range,
                kind: if found.write { HighlightKind::Write } else { HighlightKind::Read },
            })
            .collect();
        Some(Ok(highlights))
    }

    fn prepare_rename(&self, doc: DocId, pos: Pos) -> Answer<Option<Range>> {
        let engine = self.0.engine()?;
        Some(Ok(engine.prepare_rename(doc, pos)?))
    }

    /// The edit renames a class's file too when it is named after the class.
    fn rename(&self, doc: DocId, pos: Pos, new_name: &str, cancel: &CancellationToken) -> Answer<Renamed> {
        let engine = self.0.engine()?;
        let edit = engine.rename(doc, pos, new_name, cancel)?;
        Some(edit.map(|edit| Renamed { edit, incomplete: None }))
    }

    /// The quick-fixes of the inspection problems at the range, auto-import
    /// fixes for unresolved names in it, and Optimize Imports
    /// (`source.organizeImports`).
    fn code_actions(&self, doc: DocId, range: Range, only: &[String]) -> Answer<Vec<CodeAction>> {
        let engine = self.0.engine()?;
        let server = engine.server_id();
        let actions = engine.code_actions(doc, range, only)?;
        let mut actions: Vec<CodeAction> = actions.into_iter().map(|action| code_action(action, server)).collect();
        actions.extend(translation_action(only, server, || engine.laravel_translation_request(doc, range.start)));
        Some(Ok(actions))
    }

    fn code_action_query(
        &self,
        doc: DocId,
        range: Range,
        only: &[String],
        _cancel: &CancellationToken,
    ) -> Answer<CodeActionQuery> {
        let engine = self.0.engine()?;
        let server = engine.server_id();
        let actions = engine.code_actions(doc, range, only)?;
        let mut actions: Vec<CodeAction> = actions.into_iter().map(|action| code_action(action, server)).collect();
        actions.extend(translation_action(only, server, || engine.laravel_translation_request(doc, range.start)));
        // Change signature: the editor's dialog asks for the new signature,
        // then resolves the action (`resolve_code_action`).
        let wanted = only.is_empty()
            || only.iter().any(|o| {
                CHANGE_SIGNATURE == o || CHANGE_SIGNATURE.strip_prefix(o.as_str()).is_some_and(|r| r.starts_with('.'))
            });
        if wanted
            && let Some(info) = engine.change_signature_info(doc, range)
            && let Ok(data) = serde_json::to_string(&info)
        {
            actions.push(CodeAction {
                title: format!("Change signature of '{}'", info.signature.name),
                kind: Some(CHANGE_SIGNATURE.to_owned()),
                is_preferred: false,
                disabled_reason: None,
                edit: None,
                command: None,
                data: Some(serde_json::Value::String(data)),
                server,
            });
        }
        Some(Ok(CodeActionQuery {
            actions,
            advertised_kinds: Some(ide_php::imports::ACTION_KINDS.iter().map(|k| k.to_string()).collect()),
        }))
    }

    /// Change signature, with the new signature the editor's dialog put in
    /// the action's `data` ([`ide_php::refactor::ChangeSignature`]).
    fn resolve_code_action(&self, doc: DocId, action: &CodeAction, cancel: &CancellationToken) -> Answer<CodeAction> {
        let engine = self.0.engine()?;
        if action.server != engine.server_id() || action.kind.as_deref() != Some(CHANGE_SIGNATURE) {
            return None;
        }
        let parsed = action.data.as_ref().and_then(|data| match data {
            serde_json::Value::String(json) => serde_json::from_str::<ChangeSignature>(json).ok(),
            other => serde_json::from_value::<ChangeSignature>(other.clone()).ok(),
        });
        let Some(data) = parsed else {
            return Some(Err(ide_core::IdeError::invalid("The Change Signature request is malformed")));
        };
        let Some(change) = &data.change else {
            return Some(Err(ide_core::IdeError::invalid("Choose the new signature first")));
        };
        let edit = match engine.change_signature(doc, data.position, change, cancel)? {
            Ok(edit) => edit,
            Err(e) => return Some(Err(e)),
        };
        Some(Ok(CodeAction { edit: Some(edit), data: None, ..action.clone() }))
    }

    /// Pull Members Up / Push Members Down for PHP classes (the dialog the
    /// Java extension's flow uses).
    fn hierarchy_members(
        &self,
        doc: DocId,
        pos: Pos,
        kind: HierarchyRefactoring,
        cancel: &CancellationToken,
    ) -> Answer<HierarchyMembers> {
        use ide_php::refactor::hierarchy::MovableKind;
        let engine = self.0.engine()?;
        let info = match engine.hierarchy_members(doc, pos, engine_hierarchy(kind), cancel)? {
            Ok(info) => info,
            Err(e) => return Some(Err(e)),
        };
        Some(Ok(HierarchyMembers {
            class_name: info.class_name,
            targets: info
                .targets
                .into_iter()
                .map(|t| HierarchyClass {
                    id: t.id,
                    name: t.name,
                    qualified_name: t.qualified_name,
                    interface: t.interface,
                })
                .collect(),
            members: info
                .members
                .into_iter()
                .map(|m| HierarchyMember {
                    id: m.id,
                    label: m.label,
                    kind: match m.kind {
                        MovableKind::Field => HierarchyMemberKind::Field,
                        MovableKind::Method => HierarchyMemberKind::Method,
                    },
                    selected: m.selected,
                    abstractable: m.abstractable,
                })
                .collect(),
        }))
    }

    fn hierarchy_refactor(
        &self,
        doc: DocId,
        pos: Pos,
        kind: HierarchyRefactoring,
        target: Option<&str>,
        choices: &[HierarchyChoice],
        cancel: &CancellationToken,
    ) -> Answer<HierarchyRefactored> {
        use ide_php::refactor::hierarchy::{HierarchyChoice as Choice, ProblemSeverity as Severity};
        let engine = self.0.engine()?;
        let choices: Vec<Choice> =
            choices.iter().map(|c| Choice { id: c.id.clone(), make_abstract: c.make_abstract }).collect();
        let moved = match engine.hierarchy_refactor(doc, pos, engine_hierarchy(kind), target, &choices, cancel)? {
            Ok(moved) => moved,
            Err(e) => return Some(Err(e)),
        };
        Some(Ok(HierarchyRefactored {
            problems: moved
                .problems
                .into_iter()
                .map(|p| RefactoringProblem {
                    severity: match p.severity {
                        Severity::Info => ProblemSeverity::Info,
                        Severity::Warning => ProblemSeverity::Warning,
                        Severity::Error => ProblemSeverity::Error,
                        Severity::Fatal => ProblemSeverity::Fatal,
                    },
                    message: p.message,
                })
                .collect(),
            edit: moved.edit,
        }))
    }

    /// Moving PHP files inside the autoload roots updates their namespace,
    /// references and imports (and renames a class named after its file).
    fn will_rename_files(&self, moves: &[(PathBuf, PathBuf)], cancel: &CancellationToken) -> Answer<WorkspaceEdit> {
        let engine = self.0.engine()?;
        if !moves.iter().any(|(from, _)| from.is_dir() || ide_php::project::is_php_path(from)) {
            return None;
        }
        Some(engine.file_moves_edit(moves, cancel))
    }
}

/// The command offering the actions on `routes` (go to the declaration,
/// copy the URL, open it, create an HTTP request): its argument is their
/// JSON.
fn route_command(title: String, routes: &[ide_php::frameworks::laravel::RouteInfo]) -> Option<Command> {
    let json = serde_json::to_string(routes).ok()?;
    Some(Command {
        title,
        command: ide_php::frameworks::laravel::route_hints::ROUTE_ACTIONS_COMMAND.to_owned(),
        arguments: vec![serde_json::Value::String(json)],
    })
}

/// Laravel's "Create translation key…" on a translation key string (in PHP
/// or a Blade template), when `only` asks for `refactor.rewrite` actions: the
/// client command opening the dialog that asks for the text per locale,
/// with the [`TranslationRequest`](ide_php::frameworks::laravel::refs::translation_key::TranslationRequest)
/// as its JSON argument.
pub(crate) fn translation_action(
    only: &[String],
    server: ide_core::ServerId,
    request: impl FnOnce() -> Option<ide_php::frameworks::laravel::refs::translation_key::TranslationRequest>,
) -> Option<CodeAction> {
    use ide_php::frameworks::laravel::refs::translation_key::{CREATE_TRANSLATION_COMMAND, create_translation_title};
    use ide_php::imports::REWRITE;
    let wanted = only.is_empty()
        || only.iter().any(|o| REWRITE == o || REWRITE.strip_prefix(o.as_str()).is_some_and(|r| r.starts_with('.')));
    if !wanted {
        return None;
    }
    let request = request()?;
    let json = serde_json::to_string(&request).ok()?;
    let title = create_translation_title(&request.key);
    Some(CodeAction {
        title: title.clone(),
        kind: Some(REWRITE.to_owned()),
        is_preferred: false,
        disabled_reason: None,
        edit: None,
        command: Some(Command {
            title,
            command: CREATE_TRANSLATION_COMMAND.to_owned(),
            arguments: vec![serde_json::Value::String(json)],
        }),
        data: None,
        server,
    })
}

fn code_action(action: ide_php::imports::ImportAction, server: ide_core::ServerId) -> CodeAction {
    CodeAction {
        title: action.title,
        kind: Some(action.kind.to_owned()),
        is_preferred: action.preferred,
        disabled_reason: None,
        edit: Some(action.edit),
        command: None,
        data: None,
        server,
    }
}

fn engine_hierarchy(kind: HierarchyRefactoring) -> ide_php::refactor::hierarchy::HierarchyKind {
    use ide_php::refactor::hierarchy::HierarchyKind;
    match kind {
        HierarchyRefactoring::PullUp => HierarchyKind::PullUp,
        HierarchyRefactoring::PushDown => HierarchyKind::PushDown,
    }
}

/// Incoming (callers, supertypes) is the engine's `Up`.
fn engine_direction(direction: HierarchyDirection) -> ide_php::navigate::Direction {
    match direction {
        HierarchyDirection::Incoming => ide_php::navigate::Direction::Up,
        HierarchyDirection::Outgoing => ide_php::navigate::Direction::Down,
    }
}

fn hierarchy_item(entry: ide_php::navigate::HierarchyEntry) -> HierarchyItem {
    HierarchyItem {
        name: entry.name,
        kind: entry.kind,
        detail: entry.detail,
        path: entry.path.into(),
        uri: None,
        range: entry.range,
        selection_range: entry.selection_range,
        from_ranges: entry.from_ranges,
    }
}

/// An engine completion item as the editor takes it.
pub(crate) fn completion_item(item: Completion, server: ide_core::ServerId) -> CompletionItem {
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
    fn route_commands_carry_the_routes_as_json() {
        use ide_php::frameworks::laravel::RouteInfo;
        let route = RouteInfo {
            name: Some("posts.show".into()),
            methods: vec!["GET".into()],
            uri: "/posts/{post}".into(),
            action: r"App\Http\Controllers\PostController@show".into(),
            middleware: vec!["web".into()],
            path: PathBuf::from("/app/routes/web.php"),
            range: Range::default(),
            url: "http://localhost/posts/{post}".into(),
            request: "### posts.show\nGET http://localhost/posts/{{post}}\n".into(),
        };
        let command = route_command("GET /posts/{post}".into(), std::slice::from_ref(&route)).unwrap();
        assert_eq!(command.command, "laravel.routeActions");
        assert_eq!(command.title, "GET /posts/{post}");
        let [serde_json::Value::String(json)] = command.arguments.as_slice() else { panic!("{:?}", command.arguments) };
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(parsed[0]["uri"], "/posts/{post}");
        assert_eq!(parsed[0]["range"]["start"]["line"], 0);
        assert_eq!(serde_json::from_str::<Vec<RouteInfo>>(json).unwrap(), [route]);
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
