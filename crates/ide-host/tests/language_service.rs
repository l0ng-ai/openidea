//! `LanguageService` dispatch: a service registered for a document's language
//! answers before the language servers, requests it doesn't handle (and every
//! request without a service) take the unchanged LSP path, and the native PHP
//! engine keeps the PHP language servers from starting.

use ide_core::{
    CancellationToken, DocId, IdeEvent, LanguageId, Location, OutlineItem, Pos, Range, SharedSink, SymbolKind,
};
use ide_host::language_service::{Answer, LanguageService};
use ide_host::{Host, HostConfig, ops};
use ide_lsp::types::*;
use ide_workspace::settings::SettingsScope;
use parking_lot::Mutex;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn host(base: &Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| {
            let sink: SharedSink = Arc::new(|_: IdeEvent| {});
            sink
        }),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn range(line: u32) -> Range {
    Range { start: Pos { line, col: 0 }, end: Pos { line, col: 4 } }
}

/// Answers hover, goto, document symbols and workspace symbols; leaves
/// everything else to the language servers. Records what it was asked.
#[derive(Default)]
struct Mock {
    calls: Mutex<Vec<String>>,
}

impl Mock {
    fn record(&self, what: &str) {
        self.calls.lock().push(what.to_owned());
    }
}

impl LanguageService for Mock {
    fn hover(&self, _doc: DocId, pos: Pos, cancel: &CancellationToken) -> Answer<Option<Hover>> {
        assert!(!cancel.is_cancelled());
        self.record("hover");
        Some(Ok(Some(Hover {
            contents: Markup { kind: "markdown".into(), value: format!("native hover at {}:{}", pos.line, pos.col) },
            range: None,
        })))
    }

    fn goto(&self, _doc: DocId, pos: Pos, kind: GotoKind) -> Answer<Vec<Location>> {
        self.record("goto");
        (kind == GotoKind::Definition).then(|| {
            Ok(vec![Location {
                path: std::path::PathBuf::from("/native/target.txt").into(),
                range: range(pos.line),
                uri: None,
            }])
        })
    }

    fn document_symbols(&self, _doc: DocId) -> Answer<Option<Vec<OutlineItem>>> {
        self.record("document_symbols");
        Some(Ok(Some(vec![OutlineItem {
            name: "NativeSymbol".into(),
            detail: None,
            kind: SymbolKind::Class,
            range: range(0),
            selection_range: range(0),
            children: Vec::new(),
            visibility: None,
        }])))
    }

    fn workspace_symbols(&self, query: &str, _cancel: &CancellationToken) -> Answer<Vec<WorkspaceSymbol>> {
        self.record("workspace_symbols");
        Some(Ok(vec![WorkspaceSymbol {
            name: format!("Native{query}"),
            kind: SymbolKind::Class,
            container: None,
            location: Location {
                path: std::path::PathBuf::from("/native/target.txt").into(),
                range: range(1),
                uri: None,
            },
        }]))
    }

    fn completion(
        &self,
        _doc: DocId,
        _pos: Pos,
        _trigger: Option<&str>,
        _cancel: &CancellationToken,
    ) -> Answer<CompletionList> {
        self.record("completion");
        None
    }
}

fn debug<T: std::fmt::Debug>(v: &T) -> String {
    format!("{v:?}")
}

/// What the language servers answer when asked directly.
async fn lsp_answers(host: &Host, doc: DocId, pos: Pos) -> [String; 4] {
    let project = host.project("main").unwrap();
    let lsp = project.lsp.clone();
    [
        debug(&lsp.hover(doc, pos, CancellationToken::new()).await),
        debug(&lsp.goto(doc, pos, GotoKind::Definition).await),
        debug(&lsp.completion(doc, pos, None, CancellationToken::new()).await),
        debug(&lsp.workspace_symbols("Thing", CancellationToken::new()).await),
    ]
}

/// The same requests through the dispatch in `ops`.
async fn dispatched(host: &Host, doc: DocId, pos: Pos) -> [String; 4] {
    [
        debug(&ops::lsp::lsp_hover(host, "main", ide_core::RequestId(1), doc, pos).await),
        debug(&ops::lsp::lsp_goto(host, "main", doc, pos, GotoKind::Definition).await),
        debug(&ops::lsp::lsp_completion(host, "main", ide_core::RequestId(2), doc, pos, None).await),
        debug(&ops::lsp::lsp_workspace_symbols(host, "main", ide_core::RequestId(3), "Thing".into()).await),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_registered_service_answers_first_and_falls_back_to_lsp() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("notes");
    write(&root.join("todo.txt"), "first line\nsecond line\n");
    let host = host(&base.join("app"));
    let project = host.open_project("main", &root).unwrap();
    let doc = ops::doc::open(&host, "main", root.join("todo.txt")).await.unwrap();
    let pos = Pos { line: 1, col: 2 };

    // No service for the document's language: the LSP path, unchanged.
    let language = project.documents.language(doc.id).unwrap();
    assert!(project.services.get(&language).is_none());
    let direct = lsp_answers(&host, doc.id, pos).await;
    assert_eq!(dispatched(&host, doc.id, pos).await, direct);
    let outline_without = ops::doc::doc_outline(&host, "main", doc.id).await.unwrap();
    assert!(outline_without.iter().all(|i| i.name != "NativeSymbol"));

    // A service for it answers what it handles.
    let mock = Arc::new(Mock::default());
    project.services.register(language.clone(), mock.clone());
    let [hover, goto, completion, symbols] = dispatched(&host, doc.id, pos).await;
    assert!(hover.contains("native hover at 1:2"), "{hover}");
    assert!(goto.contains("target.txt"), "{goto}");
    assert_eq!(completion, direct[2], "not handled: the language servers answer");
    assert!(symbols.contains("NativeThing"), "{symbols}");
    let outline = ops::doc::doc_outline(&host, "main", doc.id).await.unwrap();
    assert_eq!(outline.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["NativeSymbol"]);
    assert_eq!(*mock.calls.lock(), ["hover", "goto", "completion", "workspace_symbols", "document_symbols"]);

    // A service for another language isn't asked about this document, but
    // workspace symbols aren't tied to a document.
    project.services.unregister(&language);
    let other = Arc::new(Mock::default());
    project.services.register(LanguageId::new("not-this-language"), other.clone());
    let [hover, goto, completion, symbols] = dispatched(&host, doc.id, pos).await;
    assert_eq!([hover, goto, completion], [direct[0].clone(), direct[1].clone(), direct[2].clone()]);
    assert!(symbols.contains("NativeThing"), "{symbols}");
    assert_eq!(*other.calls.lock(), ["workspace_symbols"]);

    // Gone again: back to the LSP path.
    project.services.unregister(&LanguageId::new("not-this-language"));
    assert_eq!(dispatched(&host, doc.id, pos).await, direct);
    assert_eq!(mock.calls.lock().len(), 5);
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_native_engine_keeps_the_php_language_servers_stopped() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("shop");
    write(&root.join("composer.json"), r#"{"autoload":{"psr-4":{"App\\":"src/"}}}"#);
    write(&root.join("src/Foo.php"), "<?php\nnamespace App;\n\nclass Foo {}\n");
    let host = host(&base.join("app"));
    // Trusted: language servers may run (and would be listed, even if not installed).
    host.trust.decide(&root, true, false).unwrap();
    let project = host.open_project("main", &root).unwrap();
    assert!(project.services.get(&LanguageId::new("php")).is_some(), "the engine is registered for PHP");

    // The native engine is the default: no setting is needed.
    let doc = ops::doc::open(&host, "main", root.join("src").join("Foo.php")).await.unwrap();
    assert_eq!(doc.language.as_str(), "php");
    let _ = ops::lsp::lsp_hover(&host, "main", ide_core::RequestId(1), doc.id, Pos { line: 3, col: 7 }).await;
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        let servers = ops::lsp::lsp_servers(&host, "main").unwrap();
        assert!(
            !servers.iter().any(|s| s.name == "intelephense"),
            "{:?}",
            servers.iter().map(|s| &s.name).collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    host.close_project("main");
}

/// Settings › PHP › Engine set to Intelephense: the native engine stops and the
/// Intelephense fallback of `languages/php.toml` serves PHP (listed even when it
/// isn't installed); back to Native, it goes away again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_to_the_intelephense_fallback() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("shop");
    write(&root.join("composer.json"), r#"{"autoload":{"psr-4":{"App\\":"src/"}}}"#);
    write(&root.join("src/Foo.php"), "<?php\nnamespace App;\n\nclass Foo {}\n");
    let host = host(&base.join("app"));
    host.trust.decide(&root, true, false).unwrap();
    let project = host.open_project("main", &root).unwrap();
    let doc = ops::doc::open(&host, "main", root.join("src").join("Foo.php")).await.unwrap();
    let intelephense_listed = || ops::lsp::lsp_servers(&host, "main").unwrap().iter().any(|s| s.name == "intelephense");
    until("the native engine", || project.php.engine().is_some()).await;
    assert!(!intelephense_listed());

    ops::project::set_settings(&host, "main", SettingsScope::Project, "languages.php.engine", "\"intelephense\"")
        .unwrap();
    until("the native engine to stop", || project.php.engine().is_none()).await;
    let pos = Pos { line: 3, col: 7 };
    let _ = ops::lsp::lsp_hover(&host, "main", ide_core::RequestId(1), doc.id, pos).await;
    until("the Intelephense fallback", intelephense_listed).await;

    ops::project::set_settings(&host, "main", SettingsScope::Project, "languages.php.engine", "\"native\"").unwrap();
    until("the native engine again", || project.php.engine().is_some()).await;
    until("Intelephense to stop", || !intelephense_listed()).await;
    host.close_project("main");
}

/// Polls until `done` (settings apply asynchronously).
async fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// One format request: the range, tab size, spaces or not, and line length.
type FormatRequest = (Option<Range>, u32, bool, u32);

/// Formats by inserting a marker, and records what it was asked.
#[derive(Default)]
struct Formatter {
    asked: Mutex<Vec<FormatRequest>>,
}

impl LanguageService for Formatter {
    fn format(
        &self,
        _doc: DocId,
        range: Option<Range>,
        options: &FormatOptions,
        line_width: u32,
    ) -> Answer<Vec<ide_core::TextEdit>> {
        self.asked.lock().push((range, options.tab_size, options.insert_spaces, line_width));
        Some(Ok(vec![ide_core::TextEdit { range: range.unwrap_or(range_at(0)), new_text: "formatted".into() }]))
    }
}

fn range_at(line: u32) -> Range {
    Range { start: Pos { line, col: 0 }, end: Pos { line, col: 0 } }
}

/// Reformat Code goes to the document's service when no external formatter
/// takes the file, with the indentation from the request and the line length
/// from Code Style › Hard wrap at (the language's own value first).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_registered_service_formats_with_the_code_style_line_length() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("notes");
    write(&root.join("todo.txt"), "first line\nsecond line\n");
    let host = host(&base.join("app"));
    let project = host.open_project("main", &root).unwrap();
    let doc = ops::doc::open(&host, "main", root.join("todo.txt")).await.unwrap();
    let language = project.documents.language(doc.id).unwrap();
    let service = Arc::new(Formatter::default());
    project.services.register(language.clone(), service.clone());

    let spaces = FormatOptions { tab_size: 2, insert_spaces: true, on_save: false, tool: None };
    let edits = ops::lsp::lsp_format(&host, "main", doc.id, None, spaces.clone()).await.unwrap();
    assert_eq!(edits.iter().map(|e| e.new_text.as_str()).collect::<Vec<_>>(), ["formatted"]);
    ops::project::set_settings(&host, "main", SettingsScope::Project, "editor.codeStyle.hardWrapAt", "100").unwrap();
    let tabs = FormatOptions { tab_size: 8, insert_spaces: false, on_save: false, tool: None };
    ops::lsp::lsp_format(&host, "main", doc.id, Some(range(1)), tabs).await.unwrap();
    let languages = format!(r#"{{"{}":{{"hardWrapAt":72}}}}"#, language.as_str());
    ops::project::set_settings(&host, "main", SettingsScope::Project, "editor.codeStyle.languages", &languages)
        .unwrap();
    ops::lsp::lsp_format(&host, "main", doc.id, None, spaces.clone()).await.unwrap();
    assert_eq!(*service.asked.lock(), [(None, 2, true, 120), (Some(range(1)), 8, false, 100), (None, 2, true, 72)]);

    // Format on save stays off unless Editor › Format on save is on.
    let on_save = FormatOptions { on_save: true, ..spaces };
    assert!(ops::lsp::lsp_format(&host, "main", doc.id, None, on_save).await.unwrap().is_empty());
    assert_eq!(service.asked.lock().len(), 3);
    host.close_project("main");
}
