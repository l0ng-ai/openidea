use super::*;
use crate::names::NameKind;
use ide_core::event::ServerStatus;

const WAIT: Duration = Duration::from_secs(30);

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    cache: PathBuf,
    events: Arc<Mutex<Vec<IdeEvent>>>,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        Self { _tmp: tmp, root, cache: base.join("cache").join(CACHE_SUBDIR), events: Arc::default() }
    }

    fn write(&self, rel: &str, text: &str) -> PathBuf {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    fn config(&self) -> EngineConfig {
        EngineConfig {
            cache_dir: self.cache.clone(),
            layout: LayoutConfig { root: self.root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        }
    }

    fn open(&self) -> Arc<PhpEngine> {
        let events = self.events.clone();
        let sink: SharedSink = Arc::new(move |e: IdeEvent| events.lock().push(e));
        let engine = PhpEngine::open(self.config(), sink).unwrap();
        assert!(engine.wait_idle(WAIT));
        engine
    }

    fn take_events(&self) -> Vec<IdeEvent> {
        std::mem::take(&mut *self.events.lock())
    }
}

fn class(name: &str) -> String {
    let (ns, short) = name.rsplit_once('\\').unwrap();
    format!("<?php\nnamespace {ns};\n\nclass {short} {{}}\n")
}

fn has_class(engine: &PhpEngine, fqn: &str) -> bool {
    !engine.index().unwrap().declarations(NameKind::ClassLike, fqn).unwrap().is_empty()
}

/// The `(indexing, server status)` sequence of the events, in order.
fn summary(events: &[IdeEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            IdeEvent::IndexState { indexing, .. } => Some(format!("index:{indexing}")),
            IdeEvent::LanguageServer { status, name, .. } => {
                assert_eq!(name, SERVER_NAME);
                Some(format!("server:{status:?}"))
            }
            IdeEvent::LanguageServerRemoved { .. } => Some("server:removed".into()),
            _ => None,
        })
        .collect()
}

#[test]
fn indexes_a_php_project_and_reports_dumb_mode() {
    let f = Fixture::new();
    f.write("composer.json", r#"{"autoload":{"psr-4":{"App\\":"src/"}}}"#);
    f.write("src/Foo.php", &class("App\\Foo"));
    f.write("src/Bar.php", &class("App\\Bar"));
    let engine = f.open();

    let status = engine.status();
    assert_eq!(status.state, EngineState::Ready);
    assert_eq!(status.files, 2);
    assert_eq!(status.declarations, 2);
    assert!(status.persistent);
    assert!(f.cache.join(crate::index::FILE_NAME).is_file());
    assert!(has_class(&engine, "App\\Foo"));
    assert!(engine.layout().unwrap().has_composer());
    assert_eq!(
        summary(&f.take_events()),
        ["server:Starting", "index:true", "index:false", "server:Ready"],
        "dumb mode while indexing, then ready like a language server"
    );
    engine.shutdown();
    assert_eq!(engine.status().state, EngineState::Stopped);
    assert_eq!(summary(&f.take_events()), ["server:removed"]);
    engine.shutdown();
    assert!(f.take_events().is_empty(), "shutting down twice reports nothing");
}

#[test]
fn stays_inactive_without_php_until_a_php_file_appears() {
    let f = Fixture::new();
    f.write("README.md", "# no php here\n");
    let engine = f.open();
    assert_eq!(engine.status().state, EngineState::Inactive);
    assert!(engine.index().is_none());
    assert!(!f.cache.exists(), "no index is created for a project without PHP");
    assert!(f.take_events().is_empty(), "an inactive engine is invisible");

    // Other files changing don't wake it.
    let notes = f.write("notes.txt", "x");
    engine.files_changed(&[notes], &[]);
    assert!(engine.wait_idle(WAIT));
    assert_eq!(engine.status().state, EngineState::Inactive);

    let path = f.write("index.php", "<?php\nfunction main() {}\n");
    engine.files_changed(&[path], &[]);
    assert!(engine.wait_idle(WAIT));
    assert_eq!(engine.status().state, EngineState::Ready);
    assert_eq!(engine.status().files, 1);
    assert!(!engine.index().unwrap().declarations(NameKind::Function, "main").unwrap().is_empty());
    assert_eq!(summary(&f.take_events()), ["server:Starting", "index:true", "index:false", "server:Ready"]);
}

#[test]
fn applies_watcher_batches() {
    let f = Fixture::new();
    let foo = f.write("src/Foo.php", &class("App\\Foo"));
    f.write("src/sub/Deep.php", &class("App\\Sub\\Deep"));
    f.write("src/sub/Deeper.php", &class("App\\Sub\\Deeper"));
    let engine = f.open();
    assert_eq!(engine.status().files, 3);
    f.take_events();
    let before = engine.modification_count();

    // Modified, created.
    std::fs::write(&foo, class("App\\Renamed")).unwrap();
    let baz = f.write("src/Baz.php", &class("App\\Baz"));
    engine.files_changed(&[foo.clone(), baz], &[]);
    assert!(engine.wait_idle(WAIT));
    assert!(engine.modification_count() > before, "batches bump the modification counter");
    assert!(!has_class(&engine, "App\\Foo"));
    assert!(has_class(&engine, "App\\Renamed"));
    assert!(has_class(&engine, "App\\Baz"));
    assert_eq!(engine.status().files, 4);

    // A removed folder takes its files along.
    let sub = f.root.join("src").join("sub");
    std::fs::remove_dir_all(&sub).unwrap();
    engine.files_changed(&[], &[sub]);
    assert!(engine.wait_idle(WAIT));
    assert!(!has_class(&engine, "App\\Sub\\Deep"));
    assert!(!has_class(&engine, "App\\Sub\\Deeper"));
    assert_eq!(engine.status().files, 2);

    // A removed file.
    std::fs::remove_file(&foo).unwrap();
    engine.files_changed(&[], &[foo]);
    assert!(engine.wait_idle(WAIT));
    assert!(!has_class(&engine, "App\\Renamed"));
    assert_eq!(engine.status().files, 1);

    // A folder moved in is walked.
    let moved = f.root.join("lib");
    std::fs::create_dir_all(moved.join("inner")).unwrap();
    std::fs::write(moved.join("inner").join("Moved.php"), class("Lib\\Moved")).unwrap();
    engine.files_changed(&[moved], &[]);
    assert!(engine.wait_idle(WAIT));
    assert!(has_class(&engine, "Lib\\Moved"));

    assert!(summary(&f.take_events()).is_empty(), "small batches don't enter dumb mode");
}

#[test]
fn layout_changes_rescan() {
    let f = Fixture::new();
    f.write("src/Foo.php", &class("App\\Foo"));
    f.write("legacy/Old.php", &class("Legacy\\Old"));
    let outside = f.root.parent().unwrap().join("platform");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("Base.php"), class("Platform\\Base")).unwrap();
    let engine = f.open();
    assert!(has_class(&engine, "Legacy\\Old"));
    assert!(!has_class(&engine, "Platform\\Base"));
    f.take_events();

    // Excluded folders and include paths from the settings.
    engine.set_layout_config(LayoutConfig {
        root: f.root.clone(),
        include_paths: vec![outside.clone()],
        excludes: vec!["/legacy".into()],
    });
    assert!(engine.wait_idle(WAIT));
    assert!(!has_class(&engine, "Legacy\\Old"));
    assert!(has_class(&engine, "Platform\\Base"));
    assert_eq!(summary(&f.take_events()), ["server:Busy", "index:true", "index:false", "server:Ready"]);

    // An excluded file changing is not indexed.
    let old = f.write("legacy/Old.php", &class("Legacy\\Older"));
    engine.files_changed(&[old], &[]);
    assert!(engine.wait_idle(WAIT));
    assert!(!has_class(&engine, "Legacy\\Older"));

    // A composer.json appearing reloads the layout: its classmap now counts.
    let vendorish = f.root.parent().unwrap().join("shared");
    std::fs::create_dir_all(&vendorish).unwrap();
    std::fs::write(vendorish.join("Shared.php"), class("Shared\\Thing")).unwrap();
    let manifest = f.write("composer.json", r#"{"autoload":{"classmap":["../shared/"]}}"#);
    engine.files_changed(&[manifest], &[]);
    assert!(engine.wait_idle(WAIT));
    assert!(has_class(&engine, "Shared\\Thing"));
}

#[test]
fn open_documents_override_the_disk() {
    let f = Fixture::new();
    let foo = f.write("src/Foo.php", &class("App\\Foo"));
    let engine = f.open();
    let names = |engine: &PhpEngine| -> Vec<String> {
        engine.summary(&foo).unwrap().unwrap().class_likes.iter().map(|c| c.fqn.clone()).collect()
    };
    assert_eq!(names(&engine), ["App\\Foo"]);

    let doc = DocId::next();
    let before = engine.modification_count();
    engine.document_opened(doc, &foo, 1, &class("App\\Open"));
    assert_eq!(names(&engine), ["App\\Open"]);
    engine.document_changed(doc, 3, &class("App\\Edited"));
    assert_eq!(names(&engine), ["App\\Edited"]);
    // A late, older version doesn't win.
    engine.document_changed(doc, 2, &class("App\\Stale"));
    assert_eq!(names(&engine), ["App\\Edited"]);
    assert_eq!(engine.open_document(&foo).unwrap().version, 3);
    assert!(engine.parsed_document(doc).is_some());
    assert!(engine.modification_count() >= before + 2, "edits bump the modification counter");

    engine.document_closed(doc);
    assert!(engine.open_document(&foo).is_none());
    assert!(engine.parsed_document(doc).is_none());
    assert_eq!(names(&engine), ["App\\Foo"], "closed: the file on disk counts again");
}

#[test]
fn restart_reuses_the_persistent_index() {
    let f = Fixture::new();
    f.write("src/Foo.php", &class("App\\Foo"));
    let engine = f.open();
    assert_eq!(engine.status().files, 1);
    drop(engine);

    let engine = f.open();
    assert_eq!(engine.status().state, EngineState::Ready);
    assert_eq!(engine.status().files, 1);
    assert!(has_class(&engine, "App\\Foo"));
    let index = engine.index().unwrap();
    // Nothing changed on disk: the restart parsed nothing.
    let stats = index.sync(&[f.root.join("src").join("Foo.php")], &CancellationToken::new()).unwrap();
    assert_eq!(stats.parsed, 0);
}

#[test]
fn shutdown_during_a_scan_leaves_dumb_mode() {
    let f = Fixture::new();
    for i in 0..600 {
        f.write(&format!("src/C{i}.php"), &class(&format!("App\\C{i}")));
    }
    let events = f.events.clone();
    let sink: SharedSink = Arc::new(move |e: IdeEvent| events.lock().push(e));
    let engine = PhpEngine::open(f.config(), sink).unwrap();
    engine.shutdown();
    assert_eq!(engine.status().state, EngineState::Stopped);
    let seen = summary(&f.take_events());
    // Either the scan never began, or it ended (finished or cancelled) and
    // dumb mode was left before the engine went away.
    if let Some(last_index) = seen.iter().rposition(|s| s.starts_with("index:")) {
        assert_eq!(seen[last_index], "index:false", "{seen:?}");
    }
    if !seen.is_empty() {
        assert_eq!(seen.last().unwrap(), "server:removed", "{seen:?}");
    }
    assert!(seen.iter().all(|s| s != &format!("server:{:?}", ServerStatus::Crashed)), "{seen:?}");
}

#[test]
fn resolved_types_are_dropped_on_edit() {
    use crate::types::Type;
    let f = Fixture::new();
    f.write(
        "src/a.php",
        "<?php\nnamespace App;\nfunction a() { return b(); }\nfunction len() { return strlen('x'); }\n",
    );
    let b = f.write("src/b.php", "<?php\nnamespace App;\nfunction b() { return 1; }\n");
    let engine = f.open();

    assert_eq!(engine.resolver().function_return(r"App\a"), Some(Type::Int));
    // Built-in functions come from the bundled stubs (`@return int<0,max>`).
    assert_eq!(engine.resolver().function_return(r"App\len"), Some(Type::int_range(Some(0), None)));
    assert!(engine.cached_types() >= 3);

    // An edit bumps the modification counter, which drops the cache.
    let doc = DocId::next();
    engine.document_opened(doc, &b, 1, "<?php\nnamespace App;\nfunction b() { return 'one'; }\n");
    assert_eq!(engine.cached_types(), 0);
    assert_eq!(engine.resolver().function_return(r"App\a"), Some(Type::string()));
    engine.document_changed(doc, 2, "<?php\nnamespace App;\nfunction b() { return new \\ArrayIterator([]); }\n");
    assert_eq!(engine.resolver().function_return(r"App\a"), Some(Type::named("ArrayIterator")));
    engine.document_closed(doc);
    assert_eq!(engine.resolver().function_return(r"App\a"), Some(Type::Int));
}

#[test]
fn expression_type_at_a_position() {
    use crate::types::Type;
    let f = Fixture::new();
    f.write("src/repo.php", "<?php\nnamespace App;\nclass Repo { public function find(): ?Book { return null; } }\n");
    f.write("src/book.php", "<?php\nnamespace App;\nclass Book { public string $title = ''; }\n");
    let main = f.write("src/main.php", "<?php\n");
    let engine = f.open();

    let doc = DocId::next();
    let text = "<?php\nnamespace App;\n$book = (new Repo)->find();\n$book?->title;\n$len = strlen('x');\n";
    engine.document_opened(doc, &main, 1, text);
    // `$book` on line 3, across files.
    assert_eq!(engine.type_at(doc, Pos::new(3, 2)), Some(Type::named(r"App\Book").nullable()));
    // The nullsafe access, at its end.
    assert_eq!(engine.type_at(doc, Pos::new(3, 13)), Some(Type::string().nullable()));
    // A built-in function from the stubs.
    assert_eq!(engine.type_at(doc, Pos::new(4, 3)), Some(Type::int_range(Some(0), None)));
    // Not an expression.
    assert_eq!(engine.type_at(doc, Pos::new(1, 3)), None);
    assert_eq!(engine.type_at(DocId::next(), Pos::new(0, 0)), None);
}

#[test]
fn a_function_declared_twice_resolves_to_the_documented_one() {
    use crate::types::{Declarations, Type};
    let f = Fixture::new();
    // WordPress: `wp-admin/includes/noop.php` sorts before `wp-includes/l10n.php`.
    f.write("a/noop.php", "<?php\n/** @ignore */\nfunction __() {}\n");
    f.write("b/l10n.php", "<?php\n/** @return string */\nfunction __($text, $domain = 'default') { return $text; }\n");
    let main = f.write("main.php", "<?php\n");
    let engine = f.open();
    assert_eq!(engine.function("__").unwrap().params.len(), 2);
    let doc = DocId::next();
    engine.document_opened(doc, &main, 1, "<?php\n$msg = __('Hi');\n");
    assert_eq!(engine.type_at(doc, Pos::new(1, 2)), Some(Type::string()));
    let hover = engine.hover(doc, Pos::new(1, 8)).unwrap();
    assert!(hover.markdown.contains("function __($text"), "{}", hover.markdown);
}

#[test]
fn generic_types_with_the_bundled_stubs() {
    use crate::types::Type;
    let f = Fixture::new();
    f.write(
        "src/list.php",
        "<?php\nnamespace App;\nuse ArrayIterator, IteratorAggregate;\n/**\n * @template T\n * @implements IteratorAggregate<int, T>\n */\nclass Items implements IteratorAggregate {\n  /** @param list<T> $items */\n  public function __construct(private array $items = []) {}\n  /** @return ArrayIterator<int, T> */\n  public function getIterator(): ArrayIterator { return new ArrayIterator($this->items); }\n}\nclass Book {}\n",
    );
    let main = f.write("src/main.php", "<?php\n");
    let engine = f.open();

    let doc = DocId::next();
    let text = "<?php\nnamespace App;\n$items = new Items([new Book()]);\nforeach ($items as $book) {}\nforeach ($items->getIterator() as $it) {}\n";
    engine.document_opened(doc, &main, 1, text);
    let book = Some(Type::named(r"App\Book"));
    // Inferred from the constructor.
    assert_eq!(engine.type_at(doc, Pos::new(2, 2)), Some(Type::generic(r"App\Items", vec![Type::named(r"App\Book")])));
    // `foreach` over `IteratorAggregate<int, T>` (stub interfaces), and over
    // the stubs' `ArrayIterator<int, T>`.
    assert_eq!(engine.type_at(doc, Pos::new(3, 22)), book);
    assert_eq!(engine.type_at(doc, Pos::new(4, 37)), book);
}

#[test]
fn phpstorm_meta_from_the_project() {
    use crate::meta::{CallTarget, MetaValue};
    use crate::types::{Context, Type};
    let f = Fixture::new();
    f.write(
        "src/Factory.php",
        "<?php\nnamespace App;\nclass Clock {}\nclass Factory { public function make(string $id): object { return new \\stdClass(); } }\n",
    );
    let meta = f.write(
        ".phpstorm.meta.php",
        r"<?php
namespace PHPSTORM_META;
override(\App\Factory::make(0), map(['clock' => \App\Clock::class]));
expectedArguments(\App\Factory::make(), 0, 'clock');
",
    );
    // A file inside a `.phpstorm.meta.php` directory counts too.
    f.write(
        "lib/.phpstorm.meta.php/more.php",
        r"<?php
namespace PHPSTORM_META;
expectedArguments(\App\Factory::make(), 0, 'timer');
",
    );
    let main = f.write("src/main.php", "<?php\n");
    let engine = f.open();
    assert_eq!(engine.index().unwrap().meta_files().unwrap().len(), 2);

    let factory = Type::named(r"App\Factory");
    let target = CallTarget::Method { receiver: &factory, name: "make" };
    let resolver = engine.resolver();
    let expected = engine.meta().expected_arguments(target, 0, &resolver, &Context::default());
    assert_eq!(expected, [MetaValue::String("clock".into()), MetaValue::String("timer".into())]);

    let doc = DocId::next();
    engine.document_opened(doc, &main, 1, "<?php\nnamespace App;\n(new Factory)->make('clock');\n");
    assert_eq!(engine.type_at(doc, Pos::new(2, 16)), Some(Type::named(r"App\Clock")));

    // Editing the meta file (an open buffer) takes effect at once.
    let meta_doc = DocId::next();
    engine.document_opened(
        meta_doc,
        &meta,
        1,
        r"<?php
namespace PHPSTORM_META;
override(\App\Factory::make(0), map(['clock' => \App\Factory::class]));
",
    );
    assert_eq!(engine.type_at(doc, Pos::new(2, 16)), Some(Type::named(r"App\Factory")));
    engine.document_closed(meta_doc);
    assert_eq!(engine.type_at(doc, Pos::new(2, 16)), Some(Type::named(r"App\Clock")));
}
