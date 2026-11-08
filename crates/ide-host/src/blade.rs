//! Blade views (`ide_php::blade`) as the `blade` [`LanguageService`]:
//! completion of directive names, goto definition of the views and
//! components a view names (`@include('a.b')`, `<x-alert>`), and, while the
//! native PHP engine runs, completion, hover, signature help and goto
//! definition in the PHP of echoes, directives, PHP blocks and bound
//! component attributes; in a Laravel project, custom directives, section
//! and stack names, component tags and attributes (completion and goto),
//! and Find Usages of a view (the one named at the caret, else the
//! view itself) in PHP files and templates, and "Create translation key…"
//! on a translation key. [`BladeObserver`] publishes the
//! template's own problems (unclosed sections) for open views. The engine
//! holds the PHP compiled from the open view as an embedded document under
//! the view's id; `PhpObserver` drops it when the view closes.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ide_core::{CancellationToken, DocId, IdeEvent, Location, Pos, Range, SharedSink};
use ide_lsp::types::{
    CodeAction, CodeActionQuery, CompletionItem, CompletionKind, CompletionList, GotoKind, Hover, Markup, References,
    Signature, SignatureHelp,
};
use ide_php::blade::structure::DIAGNOSTIC_SOURCE;
use ide_php::blade::views::{ViewPaths, ViewRef, goto_view, view_ref_at};
use ide_php::blade::{BladeDocument, DIRECTIVES, compile, directive_prefix};
use ide_php::complete::CompletionData;
use ide_text::AppliedChange;
use ide_workspace::documents::DocumentObserver;
use ide_workspace::{DocumentInfo, Documents};

use crate::language_service::{Answer, LanguageService};
use crate::php::PhpEngineSlot;

pub(crate) struct BladeService {
    root: PathBuf,
    documents: Arc<Documents>,
    php: Arc<PhpEngineSlot>,
    server: ide_core::ServerId,
}

impl BladeService {
    pub(crate) fn new(root: &Path, documents: Arc<Documents>, php: Arc<PhpEngineSlot>) -> Self {
        Self { root: root.to_path_buf(), documents, php, server: ide_core::ServerId::next() }
    }

    /// An open local Blade document (not a virtual or oversized one).
    fn info(&self, doc: DocId) -> Option<DocumentInfo> {
        let info = self.documents.snapshot(doc).ok()?;
        (info.language.as_str() == "blade" && info.uri.is_none() && !info.large).then_some(info)
    }

    /// The "Create translation key…" action at `range`, while the engine
    /// runs.
    fn translation_action(&self, doc: DocId, range: Range, only: &[String]) -> Option<CodeAction> {
        let info = self.info(doc)?;
        let engine = self.php.engine()?;
        crate::php::translation_action(only, engine.server_id(), || {
            engine.blade_translation_request(&blade(&info), range.start)
        })
    }
}

fn blade(info: &DocumentInfo) -> BladeDocument<'_> {
    BladeDocument { doc: info.id, path: info.path.as_ref(), version: info.version, text: &info.text }
}

impl LanguageService for BladeService {
    fn completion(
        &self,
        doc: DocId,
        pos: Pos,
        trigger: Option<&str>,
        cancel: &CancellationToken,
    ) -> Answer<CompletionList> {
        let info = self.info(doc)?;
        let Some(engine) = self.php.engine() else {
            let items = match directive_prefix(&info.text, pos) {
                Some((_, range)) => DIRECTIVES.iter().map(|name| directive_item(name, range, self.server)).collect(),
                None => Vec::new(),
            };
            return Some(Ok(CompletionList { is_incomplete: false, items }));
        };
        let server = engine.server_id();
        let found = engine
            .blade_directive_completion(&info.text, pos)
            .or_else(|| engine.blade_laravel_completion(&blade(&info), pos))
            .or_else(|| engine.blade_completion(&blade(&info), pos, trigger, cancel))
            .unwrap_or_default();
        let items = found.items.into_iter().map(|item| crate::php::completion_item(item, server)).collect();
        Some(Ok(CompletionList { is_incomplete: found.incomplete, items }))
    }

    fn resolve_completion(&self, doc: DocId, item: &CompletionItem) -> Answer<CompletionItem> {
        self.info(doc)?;
        let engine = self.php.engine()?;
        if item.server != engine.server_id() {
            return Some(Ok(item.clone()));
        }
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
        let info = self.info(doc)?;
        let hover = self.php.engine().and_then(|engine| engine.blade_hover(&blade(&info), pos)).map(|hover| Hover {
            contents: Markup { kind: "markdown".into(), value: hover.markdown },
            range: Some(hover.range),
        });
        Some(Ok(hover))
    }

    fn signature_help(&self, doc: DocId, pos: Pos) -> Answer<Option<SignatureHelp>> {
        let info = self.info(doc)?;
        let help = self.php.engine().and_then(|engine| engine.blade_signature_help(&blade(&info), pos)).map(|help| {
            SignatureHelp {
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
            }
        });
        Some(Ok(help))
    }

    /// The usages of the view named at the caret (`@include('a.b')`), or,
    /// outside the template's PHP, of the template's own view. Left to the
    /// other services inside the PHP and outside Laravel projects.
    fn references(
        &self,
        doc: DocId,
        pos: Pos,
        include_declaration: bool,
        _project_wide: bool,
        cancel: &CancellationToken,
    ) -> Answer<References> {
        let info = self.info(doc)?;
        let engine = self.php.engine()?;
        let name = match view_ref_at(&info.text, pos) {
            Some((ViewRef::View(name), _)) => name,
            Some(_) => return None,
            None if compile(&info.text, false).to_php(pos).is_some() => return None,
            None => engine.laravel_view_name(&info.path)?,
        };
        let usages = match engine.laravel_view_usages(&name, cancel)? {
            Ok(usages) => usages,
            Err(e) => return Some(Err(e)),
        };
        let mut locations = Vec::new();
        if include_declaration && let Some(view) = engine.laravel_views().and_then(|views| views.get(&name).cloned()) {
            locations.push(Location::file(view.path, Default::default()));
        }
        locations.extend(usages.into_iter().map(|usage| Location::file(usage.path, usage.range)));
        Some(Ok(References { locations, ..References::default() }))
    }

    /// Laravel's "Create translation key…" on a translation key in the
    /// template's PHP (`@lang('…')`, `{{ __('…') }}`); left to the other
    /// services everywhere else.
    fn code_actions(&self, doc: DocId, range: Range, only: &[String]) -> Answer<Vec<CodeAction>> {
        Some(Ok(vec![self.translation_action(doc, range, only)?]))
    }

    fn code_action_query(
        &self,
        doc: DocId,
        range: Range,
        only: &[String],
        _cancel: &CancellationToken,
    ) -> Answer<CodeActionQuery> {
        let action = self.translation_action(doc, range, only)?;
        Some(Ok(CodeActionQuery { actions: vec![action], advertised_kinds: None }))
    }

    /// The views and components the view names, else the PHP's targets.
    fn goto(&self, doc: DocId, pos: Pos, kind: GotoKind) -> Answer<Vec<Location>> {
        let info = self.info(doc)?;
        if !matches!(kind, GotoKind::Definition | GotoKind::Declaration) {
            return Some(Ok(Vec::new()));
        }
        let engine = self.php.engine();
        if let Some(targets) = engine.as_ref().and_then(|engine| engine.blade_laravel_definition(&blade(&info), pos))
            && !targets.is_empty()
        {
            return Some(Ok(targets.into_iter().map(|target| Location::file(target.path, target.range)).collect()));
        }
        let files = goto_view(&info.text, pos, &ViewPaths::new(&self.root));
        if !files.is_empty() {
            return Some(Ok(files.into_iter().map(|path| Location::file(path, Default::default())).collect()));
        }
        let targets = engine
            .and_then(|engine| engine.blade_definition(&blade(&info), pos))
            .unwrap_or_default()
            .into_iter()
            .map(|target| Location::file(target.path, target.range))
            .collect();
        Some(Ok(targets))
    }
}

/// Publishes the problems of open Blade views (unclosed sections and
/// pushes, closing directives with nothing open) under the `blade` source,
/// with the project's custom directives while the engine runs.
pub(crate) struct BladeObserver {
    pub(crate) php: Arc<PhpEngineSlot>,
    pub(crate) sink: SharedSink,
}

impl BladeObserver {
    fn publish(&self, path: &Path, text: &str) {
        let items = match self.php.engine() {
            Some(engine) => engine.blade_problems(text),
            None => ide_php::blade::structure::inspect(text, &[]),
        };
        self.sink.emit(IdeEvent::Diagnostics { path: path.into(), source: DIAGNOSTIC_SOURCE.into(), items });
    }
}

fn is_blade_document(info: &DocumentInfo) -> bool {
    info.language.as_str() == "blade" && info.uri.is_none() && !info.large
}

impl DocumentObserver for BladeObserver {
    fn opened(&self, info: &DocumentInfo) {
        if is_blade_document(info) {
            self.publish(&info.path, &info.text);
        }
    }

    fn changed(
        &self,
        _doc: DocId,
        path: &Path,
        _version: u32,
        _changes: &[AppliedChange],
        full_text: &dyn Fn() -> String,
    ) {
        if ide_php::frameworks::laravel::views::is_blade(path) {
            self.publish(path, &full_text());
        }
    }

    fn closed(&self, _doc: DocId, path: &Path) {
        if ide_php::frameworks::laravel::views::is_blade(path) {
            self.sink.emit(IdeEvent::Diagnostics {
                path: path.into(),
                source: DIAGNOSTIC_SOURCE.into(),
                items: Vec::new(),
            });
        }
    }
}

fn directive_item(name: &str, range: ide_core::Range, server: ide_core::ServerId) -> CompletionItem {
    CompletionItem {
        label: name.to_owned(),
        label_detail: None,
        detail: Some("Blade directive".into()),
        kind: Some(CompletionKind::Keyword),
        documentation: None,
        sort_text: Some(name.to_ascii_lowercase()),
        filter_text: None,
        preselect: false,
        deprecated: false,
        insert_text: name.to_owned(),
        is_snippet: false,
        replace_range: Some(range),
        replace_range_tab: None,
        additional_edits: Vec::new(),
        commit_characters: Vec::new(),
        command: None,
        data: None,
        server,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{IdeEvent, LanguageId, SharedSink};

    fn documents() -> Arc<Documents> {
        Arc::new(Documents::new(Arc::new(|_: IdeEvent| {}), Box::new(|_, _| LanguageId::new("blade"))))
    }

    #[test]
    fn answers_open_blade_documents_without_the_engine() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let views = root.join("resources/views");
        std::fs::create_dir_all(views.join("layouts")).unwrap();
        std::fs::write(views.join("layouts/app.blade.php"), "@yield('content')").unwrap();
        let page = views.join("page.blade.php");
        std::fs::write(&page, "@extends('layouts.app')\n@fore\n{{ $x }}\n").unwrap();
        let documents = documents();
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let php = Arc::new(PhpEngineSlot::new(&root, &root.join(".cache"), sink, documents.clone()));
        let service = BladeService::new(&root, documents.clone(), php);
        let doc = documents.open(&page).unwrap().id;

        let list = service.completion(doc, Pos::new(1, 5), None, &CancellationToken::new()).unwrap().unwrap();
        let foreach = list.items.iter().find(|i| i.label == "foreach").expect("@foreach");
        assert_eq!(foreach.kind, Some(CompletionKind::Keyword));
        assert_eq!(foreach.replace_range, Some(ide_core::Range::new(Pos::new(1, 1), Pos::new(1, 5))));

        let targets = service.goto(doc, Pos::new(0, 12), GotoKind::Definition).unwrap().unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].path.as_ref() as &Path, views.join("layouts").join("app.blade.php").as_path());

        // No engine: the PHP has no answers, but the request is handled.
        let list = service.completion(doc, Pos::new(2, 5), None, &CancellationToken::new()).unwrap().unwrap();
        assert!(list.items.is_empty());
        assert!(service.hover(doc, Pos::new(2, 4), &CancellationToken::new()).unwrap().unwrap().is_none());
    }

    #[test]
    fn publishes_unclosed_sections_of_open_views() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let views = root.join("resources/views");
        std::fs::create_dir_all(&views).unwrap();
        let page = views.join("page.blade.php");
        std::fs::write(&page, "@section('content')\n<p>x</p>\n").unwrap();
        let published: Arc<parking_lot::Mutex<Vec<(PathBuf, String, usize)>>> = Arc::default();
        let events = published.clone();
        let sink: SharedSink = Arc::new(move |event: IdeEvent| {
            if let IdeEvent::Diagnostics { path, source, items } = event {
                events.lock().push((PathBuf::from(path), source, items.len()));
            }
        });
        let documents = documents();
        let php = Arc::new(PhpEngineSlot::new(&root, &root.join(".cache"), sink.clone(), documents.clone()));
        documents.add_observer(Arc::new(BladeObserver { php, sink }));
        let doc = documents.open(&page).unwrap().id;
        let blade_events = || -> Vec<usize> {
            published.lock().iter().filter(|(_, source, _)| source == "blade").map(|(_, _, n)| *n).collect()
        };
        assert_eq!(blade_events(), [1]);
        assert_eq!(published.lock()[0].0, page);
        documents.close(doc);
        assert_eq!(blade_events(), [1, 0]);
    }

    #[test]
    fn answers_the_php_with_the_engine() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(
            root.join("app/helpers.php"),
            "<?php\n/** Formats cents. */\nfunction money(int $cents): string { return ''; }\n",
        )
        .unwrap();
        let views = root.join("resources/views");
        std::fs::create_dir_all(&views).unwrap();
        let page = views.join("page.blade.php");
        std::fs::write(&page, "<p>{{ mon }}</p>\n<p>{{ money(1) }}</p>\n").unwrap();
        let documents = documents();
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let php = Arc::new(PhpEngineSlot::new(&root, &root.join(".cache"), sink, documents.clone()));
        let mut settings = ide_core::settings::Settings::default();
        settings.languages.php.engine = ide_core::settings::PhpEngineKind::Native;
        php.apply(&settings);
        let engine = php.engine().expect("the engine");
        assert!(engine.wait_idle(std::time::Duration::from_secs(60)));
        let service = BladeService::new(&root, documents.clone(), php.clone());
        let doc = documents.open(&page).unwrap().id;

        let list = service.completion(doc, Pos::new(0, 9), None, &CancellationToken::new()).unwrap().unwrap();
        let money = list.items.iter().find(|i| i.label == "money").expect("money()");
        assert_eq!(money.server, engine.server_id());
        let resolved = service.resolve_completion(doc, money).unwrap().unwrap();
        assert!(resolved.documentation.unwrap().value.contains("Formats cents."));

        let hover = service.hover(doc, Pos::new(1, 8), &CancellationToken::new()).unwrap().unwrap().unwrap();
        assert!(hover.contents.value.contains("money(int $cents): string"), "{}", hover.contents.value);
        let targets = service.goto(doc, Pos::new(1, 8), GotoKind::Definition).unwrap().unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].path.as_ref() as &Path, root.join("app").join("helpers.php").as_path());
        php.shutdown();
    }

    #[test]
    fn finds_usages_of_views_from_templates() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let write = |rel: &str, text: &str| {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            path
        };
        write("composer.json", r#"{"require": {"laravel/framework": "^11.0"}}"#);
        let controller = write("app/Home.php", "<?php\nfunction home() { return view('pages.card'); }\n");
        let card = write("resources/views/pages/card.blade.php", "<p>{{ $title }}</p>\n");
        let list = write("resources/views/pages/list.blade.php", "<ul>\n@include('pages.card')\n</ul>\n");
        let documents = documents();
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let php = Arc::new(PhpEngineSlot::new(&root, &root.join(".cache"), sink, documents.clone()));
        let mut settings = ide_core::settings::Settings::default();
        settings.languages.php.engine = ide_core::settings::PhpEngineKind::Native;
        php.apply(&settings);
        let engine = php.engine().expect("the engine");
        assert!(engine.wait_idle(std::time::Duration::from_secs(60)));
        let service = BladeService::new(&root, documents.clone(), php.clone());
        let cancel = CancellationToken::new();
        let found = |doc: DocId, pos: Pos| -> Vec<(PathBuf, u32)> {
            let refs = service.references(doc, pos, true, true, &cancel).unwrap().unwrap();
            refs.locations.into_iter().map(|l| (PathBuf::from(l.path.clone()), l.range.start.line)).collect()
        };

        // On the template's HTML: the usages of the template's own view.
        let doc = documents.open(&card).unwrap().id;
        assert_eq!(found(doc, Pos::new(0, 1)), [(card.clone(), 0), (controller.clone(), 1), (list.clone(), 1)]);
        // In its PHP: left to the PHP services.
        assert!(service.references(doc, Pos::new(0, 8), true, true, &cancel).is_none());
        // On a view name in a directive.
        let doc = documents.open(&list).unwrap().id;
        assert_eq!(found(doc, Pos::new(1, 12)), [(card, 0), (controller, 1), (list, 1)]);
        php.shutdown();
    }
}
