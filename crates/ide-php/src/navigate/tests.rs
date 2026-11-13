use std::sync::Arc;
use std::time::Duration;

use ide_core::{IdeEvent, SharedSink};

use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig};
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;
use crate::syntax::{LineIndex, ParsedFile};

mod hierarchy;
mod laravel;
mod moves;
mod references;
mod rename;
mod symfony;

const WAIT: Duration = Duration::from_secs(60);
const CARET: &str = "/*|*/";

/// The text without the caret marker, and the caret's position.
fn caret(source: &str) -> (String, Pos) {
    let at = source.find(CARET).expect("a /*|*/ caret");
    let text = format!("{}{}", &source[..at], &source[at + CARET.len()..]);
    let pos = LineIndex::new(&text).pos(at as u32);
    (text, pos)
}

struct Project {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    engine: Arc<PhpEngine>,
    next_doc: u32,
}

impl Project {
    /// A project with these files, indexed.
    fn new(files: &[(&str, &str)]) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        for (rel, text) in files {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        std::fs::create_dir_all(&root).unwrap();
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let config = EngineConfig {
            cache_dir: base.join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        };
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(WAIT));
        Self { _tmp: tmp, root, engine, next_doc: 1 }
    }

    /// Opens `rel` with `text` (which may differ from the disk) as a document.
    fn open(&mut self, rel: &str, text: &str) -> DocId {
        let doc = DocId(self.next_doc);
        self.next_doc += 1;
        self.engine.document_opened(doc, &self.root.join(rel), 1, text);
        doc
    }

    /// Goto definition at the caret of `source`, opened as `rel`: the
    /// targets as `(relative path, line, the text at the range)`.
    fn definition(&mut self, rel: &str, source: &str) -> Option<Vec<(String, u32, String)>> {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let targets = self.engine.definition(doc, pos);
        let found =
            targets.map(|targets| targets.iter().map(|target| self.describe(&target.path, target.range)).collect());
        self.engine.document_closed(doc);
        found
    }

    fn describe(&self, path: &Path, range: Range) -> (String, u32, String) {
        // An open buffer's text, else the file's.
        let text = match self.engine.open_document(path) {
            Some(document) => document.text.to_string(),
            None => std::fs::read_to_string(path).unwrap(),
        };
        let index = LineIndex::new(&text);
        let (start, end) = index.byte_range(range);
        let rel = match path.strip_prefix(&self.root) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => format!("<{}>", path.file_name().unwrap().to_string_lossy()),
        };
        (rel, range.start.line, text[start as usize..end as usize].to_owned())
    }
}

fn target(rel: &str, line: u32, text: &str) -> (String, u32, String) {
    (rel.to_owned(), line, text.to_owned())
}

const BOOK: &str = "<?php\nnamespace App\\Model;\n\nfinal class Book extends Item implements \\Countable\n{\n    public function count(): int { return 1; }\n}\n";
const ITEM: &str = "<?php\nnamespace App\\Model;\n\nabstract class Item {}\n";
const FUNCTIONS: &str = "<?php\nnamespace App;\n\nconst VERSION = '1.0';\n\nfunction slugify(string $text): string\n{\n    return $text;\n}\n";
const REPOSITORY: &str = "<?php\nnamespace App\\Repository;\n\ninterface BookRepository {}\n";

fn library() -> Project {
    Project::new(&[
        ("src/Model/Book.php", BOOK),
        ("src/Model/Item.php", ITEM),
        ("src/functions.php", FUNCTIONS),
        ("src/Repository/BookRepository.php", REPOSITORY),
    ])
}

#[test]
fn outline_lists_declarations_and_members_in_source_order() {
    let source = "<?php\nnamespace App;\n\nfunction helper(int $a, string ...$rest): bool { return true; }\n\nconst LIMIT = 3;\n\nfinal class Library implements Shelf\n{\n    public const MAX = 10;\n    private array $books = [];\n\n    public function __construct(private readonly Clock $clock) {}\n\n    public function add(Book $book): void {}\n\n    protected static function &find(?string $isbn = null): ?Book { return null; }\n}\n\nenum Genre: string\n{\n    case Fiction = 'f';\n}\n\ninterface Shelf {}\ntrait Stamps {}\n";
    let summary = FileSummary::extract(&ParsedFile::parse("outline.php", source));
    let items = outline(&summary);
    let top: Vec<(&str, SymbolKind)> = items.iter().map(|item| (item.name.as_str(), item.kind)).collect();
    assert_eq!(
        top,
        [
            ("helper", SymbolKind::Function),
            ("LIMIT", SymbolKind::Constant),
            ("Library", SymbolKind::Class),
            ("Genre", SymbolKind::Enum),
            ("Shelf", SymbolKind::Interface),
            ("Stamps", SymbolKind::Trait),
        ]
    );
    assert_eq!(items[0].detail.as_deref(), Some("(int $a, string ...$rest): bool"));

    let library = &items[2];
    let members: Vec<(&str, SymbolKind, Option<&str>, Option<ide_core::Visibility>)> = library
        .children
        .iter()
        .map(|item| (item.name.as_str(), item.kind, item.detail.as_deref(), item.visibility))
        .collect();
    use ide_core::Visibility::{Private, Protected, Public};
    assert_eq!(
        members,
        [
            ("MAX", SymbolKind::Constant, None, Some(Public)),
            ("$books", SymbolKind::Property, Some("array"), Some(Private)),
            ("__construct", SymbolKind::Constructor, Some("(App\\Clock $clock)"), Some(Public)),
            ("$clock", SymbolKind::Property, Some("App\\Clock"), Some(Private)),
            ("add", SymbolKind::Method, Some("(App\\Book $book): void"), Some(Public)),
            ("find", SymbolKind::Method, Some("(?string $isbn): ?App\\Book"), Some(Protected)),
        ]
    );
    // Navigation lands on the name, inside the whole declaration.
    for item in std::iter::once(library).chain(&library.children) {
        assert!(item.range.start <= item.selection_range.start && item.selection_range.end <= item.range.end);
    }
    assert_eq!(library.selection_range.start, Pos::new(7, 12));
    assert_eq!(items[3].children[0].name, "Fiction");
    assert_eq!(items[3].children[0].kind, SymbolKind::EnumMember);
}

#[test]
fn document_symbols_follow_the_open_buffer() {
    let mut project = library();
    let doc = project
        .open("src/Model/Item.php", "<?php\nnamespace App\\Model;\n\nabstract class Renamed { function go() {} }\n");
    let items = project.engine.document_symbols(doc).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].name, "Renamed");
    assert_eq!(items[0].children[0].name, "go");
    assert!(project.engine.document_symbols(DocId(999)).is_none(), "not an open document");
}

#[test]
fn goto_class_names_across_files() {
    let mut project = library();
    let book = target("src/Model/Book.php", 3, "Book");
    let source = "<?php\nnamespace App;\n\nuse App\\Model\\Book;\n\n$book = new Bo/*|*/ok();\n";
    assert_eq!(project.definition("bin/run.php", source), Some(vec![book.clone()]), "a `new`");
    let source = "<?php\nnamespace App;\n\nuse App\\Model\\Bo/*|*/ok;\n";
    assert_eq!(project.definition("bin/run.php", source), Some(vec![book.clone()]), "a `use` import");
    let source = "<?php\nnamespace App;\n\nuse App\\Model\\Book as Volume;\n\nfunction f(Volume/*|*/ $v) {}\n";
    assert_eq!(project.definition("bin/run.php", source), Some(vec![book.clone()]), "an alias, caret after it");
    let source = "<?php\nfunction f(\\App\\Model\\BOOK/*|*/ $v) {}\n";
    assert_eq!(project.definition("bin/run.php", source), Some(vec![book.clone()]), "fully qualified, any case");
    let source = "<?php\nnamespace App\\Model;\n\nfinal class Book extends It/*|*/em {}\n";
    assert_eq!(
        project.definition("src/Model/Book.php", source),
        Some(vec![target("src/Model/Item.php", 3, "Item")]),
        "extends, from the class's own file"
    );
    let source = "<?php\nnamespace App;\n\ninterface X extends Repository\\BookRepos/*|*/itory {}\n";
    assert_eq!(
        project.definition("bin/run.php", source),
        Some(vec![target("src/Repository/BookRepository.php", 3, "BookRepository")]),
        "a qualified name relative to the namespace"
    );
    let source = "<?php\nnamespace App;\n\n$x = new Miss/*|*/ing();\n";
    assert_eq!(project.definition("bin/run.php", source), Some(vec![]), "declared nowhere");
    let source = "<?php\n$x = 1 /*|*/ + 2;\n";
    assert_eq!(project.definition("bin/run.php", source), None, "no name at the caret: not handled");
}

#[test]
fn goto_declarations_in_the_document_and_relative_classes() {
    let mut project = library();
    let source = "<?php\nnamespace App\\Model;\n\nfinal class Book extends Item\n{\n    public static function make(): static { return new sel/*|*/f(); }\n}\n";
    assert_eq!(project.definition("src/Model/Book.php", source), Some(vec![target("src/Model/Book.php", 3, "Book")]));
    let source = "<?php\nnamespace App\\Model;\n\nfinal class Book extends Item\n{\n    public function __construct() { par/*|*/ent::__construct(); }\n}\n";
    assert_eq!(project.definition("src/Model/Book.php", source), Some(vec![target("src/Model/Item.php", 3, "Item")]));
    // An edited buffer: the declaration is found where the buffer has it.
    let source = "<?php\nnamespace App\\Model;\n\n\n\nfinal class Bo/*|*/ok {}\n";
    assert_eq!(project.definition("src/Model/Book.php", source), Some(vec![target("src/Model/Book.php", 5, "Book")]));
}

#[test]
fn goto_functions_and_constants_with_the_global_fallback() {
    let mut project = library();
    let source = "<?php\nnamespace App;\n\necho slug/*|*/ify('A b');\n";
    assert_eq!(project.definition("bin/run.php", source), Some(vec![target("src/functions.php", 5, "slugify")]));
    let source = "<?php\nuse function App\\slugify;\n\necho slugify/*|*/('A b');\n";
    assert_eq!(project.definition("bin/run.php", source), Some(vec![target("src/functions.php", 5, "slugify")]));
    let source = "<?php\nnamespace App;\n\necho VER/*|*/SION;\n";
    assert_eq!(project.definition("bin/run.php", source), Some(vec![target("src/functions.php", 3, "VERSION")]));
    let source = "<?php\nnamespace App;\n\necho ver/*|*/sion;\n";
    assert_eq!(project.definition("bin/run.php", source), Some(vec![]), "constant names are case-sensitive");
}

#[test]
fn goto_built_ins_opens_the_bundled_stubs() {
    let mut project = library();
    // Inside a namespace `strlen` falls back to the global function.
    let source = "<?php\nnamespace App;\n\necho str/*|*/len('x');\n";
    let found = project.definition("bin/run.php", source).unwrap();
    assert_eq!(found.len(), 1);
    let (file, _, text) = &found[0];
    assert_eq!((file.as_str(), text.as_str()), ("<Core.php>", "strlen"));

    let source = "<?php\n$it = new \\ArrayIter/*|*/ator([]);\n";
    let found = project.definition("bin/run.php", source).unwrap();
    assert_eq!(found.iter().map(|t| t.2.as_str()).collect::<Vec<_>>(), ["ArrayIterator"]);
    let source = "<?php\necho PHP_E/*|*/OL;\n";
    assert_eq!(project.definition("bin/run.php", source).unwrap()[0].2, "PHP_EOL");

    // A project declaration wins over the stubs.
    let mut project = Project::new(&[("src/polyfill.php", "<?php\nfunction strlen($s) { return 0; }\n")]);
    let source = "<?php\necho strlen/*|*/('x');\n";
    assert_eq!(project.definition("bin/run.php", source), Some(vec![target("src/polyfill.php", 1, "strlen")]));
}

#[test]
fn workspace_symbols_rank_fuzzy_matches() {
    let project = library();
    let cancel = CancellationToken::new();
    let search = |query: &str| -> Vec<(String, SymbolKind, Option<String>)> {
        project
            .engine
            .workspace_symbols(query, 10, &cancel)
            .unwrap()
            .into_iter()
            .map(|symbol| (symbol.name, symbol.kind, symbol.container))
            .collect()
    };
    let book = ("Book".to_owned(), SymbolKind::Class, Some("App\\Model".to_owned()));
    let repository = ("BookRepository".to_owned(), SymbolKind::Interface, Some("App\\Repository".to_owned()));
    assert_eq!(search("book"), [book, repository.clone()], "exact first, then the prefix match");
    assert_eq!(search("bkrepo"), std::slice::from_ref(&repository), "fuzzy");
    assert_eq!(search("Repository\\book"), [repository], "a namespace part filters");
    assert_eq!(search("slug"), [("slugify".to_owned(), SymbolKind::Function, Some("App".to_owned()))]);
    assert_eq!(search("VERSION")[0].1, SymbolKind::Constant);
    assert!(search("").is_empty());
    assert!(search("zzzz").is_empty());

    let found = project.engine.workspace_symbols("Item", 10, &cancel).unwrap();
    assert_eq!(project.describe(&found[0].path, found[0].range), target("src/Model/Item.php", 3, "Item"));

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(project.engine.workspace_symbols("book", 10, &cancelled).is_err());
}

#[test]
fn capitals_in_the_query_start_words() {
    use super::matches_humps;
    assert!(matches_humps("PostController", "PoCo"));
    assert!(!matches_humps("PostFactory", "PoCo"), "the c of Factory starts no word");
    assert!(matches_humps("PostFactory", "poco"), "no capitals after the first: fuzzy");
    assert!(matches_humps("HTMLParser", "HPa"));
    assert!(matches_humps("parse_HTTP_request", "pHR"));
    assert!(matches_humps("Base64Encoder", "B64E"));
    assert!(!matches_humps("Book", "BoK"));
    assert!(matches_humps("VERSION", "VERSION"), "all capitals: fuzzy");
    assert!(!matches_humps("ResponseFactory", "PoFa"), "the first capital starts a word too");
}

#[test]
fn ranking_prefers_exact_then_prefix_then_shorter() {
    let names: Vec<String> = ["bookrepository", "book", "abook", "books", "unrelated"].map(String::from).to_vec();
    let ranked: Vec<&str> = rank(&names, "Book", 10).into_iter().map(|(_, i)| names[i].as_str()).collect();
    assert_eq!(ranked[..3], ["book", "books", "bookrepository"]);
    assert!(ranked.contains(&"abook"));
    assert!(!ranked.contains(&"unrelated"));
    assert_eq!(rank(&names, "book", 1).len(), 1);
}

/// Members, variables, named arguments, type definition and hover.
mod members;

/// `$this` in Pest's test closures.
mod pest;

#[test]
fn this_in_an_anonymous_class_reaches_its_own_and_inherited_members() {
    let base = "<?php\nnamespace App;\n\nabstract class Migration\n{\n    protected function connection(): string { return ''; }\n}\n";
    let own = "<?php\n\nreturn new class extends App\\Migration\n{\n    private int $moved = 0;\n\n    public function up(): void\n    {\n        $this->relo/*|*/cate('a');\n    }\n\n    private function relocate(string $from): void {}\n};\n";
    let mut p = Project::new(&[("src/Migration.php", base), ("database/move.php", own)]);
    assert_eq!(p.definition("database/move.php", own).expect("handled"), [target("database/move.php", 11, "relocate")]);
    let property = own.replace("$this->relo/*|*/cate('a');", "$this->mov/*|*/ed++;");
    assert_eq!(
        p.definition("database/move.php", &property).expect("handled"),
        [target("database/move.php", 4, "$moved")]
    );
    let inherited = own.replace("$this->relo/*|*/cate('a');", "$this->connec/*|*/tion();");
    assert_eq!(
        p.definition("database/move.php", &inherited).expect("handled"),
        [target("src/Migration.php", 5, "connection")]
    );
}

#[test]
fn a_higher_order_collection_proxy_reaches_the_items_methods() {
    let lib = r#"<?php
namespace Illuminate\Foundation { class Application {} }
namespace Illuminate\Support {
    /**
     * @template TKey
     * @template TValue
     */
    class HigherOrderCollectionProxy {}
}
namespace App {
    class Item
    {
        public function delete(): bool { return true; }
    }
    class Bag
    {
        /** @var \Illuminate\Support\HigherOrderCollectionProxy<int, Item> */
        public $each;
    }
}
"#;
    let source = "<?php\nnamespace App;\n\nfunction clear(Bag $bag): void\n{\n    $bag->each->del/*|*/ete();\n}\n";
    let mut p = Project::new(&[("src/lib.php", lib), ("src/clear.php", source)]);
    assert_eq!(p.definition("src/clear.php", source).expect("handled"), [target("src/lib.php", 12, "delete")]);
}

const CALL_SITE_LIB: &str = "<?php\n\nclass Item\n{\n    public function title(): string { return ''; }\n}\n\nclass Other\n{\n    public function label(): string { return ''; }\n}\n";

#[test]
fn an_untyped_parameter_takes_what_its_callers_pass() {
    // A private method: the callers in the file.
    let private = "<?php\n\nclass Printer\n{\n    public function run(): void\n    {\n        $this->show(new Item());\n        $this->show(null);\n    }\n\n    private function show($item): void\n    {\n        $item->tit/*|*/le();\n    }\n}\n";
    let mut p = Project::new(&[("src/lib.php", CALL_SITE_LIB), ("src/Printer.php", private)]);
    assert_eq!(p.definition("src/Printer.php", private).expect("handled"), [target("src/lib.php", 4, "title")]);
    // A declared type, or a `@param`, is never overridden.
    let hinted = private.replace("private function show($item)", "private function show(Other $item)");
    assert_eq!(p.definition("src/Printer.php", &hinted).expect("handled"), []);
    // Two classes: both; more than four different types: none.
    let two = private.replace("$this->show(null);", "$this->show(new Other());").replace("tit/*|*/le", "la/*|*/bel");
    assert_eq!(p.definition("src/Printer.php", &two).expect("handled"), [target("src/lib.php", 9, "label")]);
    let many = private.replace(
        "$this->show(null);",
        "$this->show(new Other()); $this->show(1); $this->show('a'); $this->show(1.5); $this->show([]);",
    );
    assert_eq!(p.definition("src/Printer.php", &many).expect("handled"), []);
    // A spread argument says nothing.
    let spread = private.replace("$this->show(new Item());", "$this->show(...[new Item()]);");
    assert_eq!(p.definition("src/Printer.php", &spread).expect("handled"), []);
}

#[test]
fn callers_in_the_hierarchy_and_in_the_project_type_a_parameter() {
    // A protected method called from a subclass in another file.
    let base = "<?php\n\nabstract class Report\n{\n    protected function line($item): string\n    {\n        return $item->tit/*|*/le();\n    }\n}\n";
    let child = "<?php\n\nclass ItemReport extends Report\n{\n    public function build(): string\n    {\n        return $this->line(new Item());\n    }\n}\n";
    let mut p =
        Project::new(&[("src/lib.php", CALL_SITE_LIB), ("src/Report.php", base), ("src/ItemReport.php", child)]);
    assert_eq!(p.definition("src/Report.php", base).expect("handled"), [target("src/lib.php", 4, "title")]);
    // A public method called on a typed receiver anywhere in the project.
    let service = "<?php\n\nclass Renderer\n{\n    public function render($item): string\n    {\n        return $item->tit/*|*/le();\n    }\n}\n";
    let caller =
        "<?php\n\nfunction show(Renderer $renderer): string\n{\n    return $renderer->render(new Item());\n}\n";
    let mut p =
        Project::new(&[("src/lib.php", CALL_SITE_LIB), ("src/Renderer.php", service), ("src/show.php", caller)]);
    assert_eq!(p.definition("src/Renderer.php", service).expect("handled"), [target("src/lib.php", 4, "title")]);
    // A caller of another class's method of the same name doesn't count.
    let unrelated = caller.replace("Renderer $renderer", "Other $renderer");
    let mut p =
        Project::new(&[("src/lib.php", CALL_SITE_LIB), ("src/Renderer.php", service), ("src/show.php", &unrelated)]);
    assert_eq!(p.definition("src/Renderer.php", service).expect("handled"), []);
}

#[test]
fn hover_says_a_parameters_type_comes_from_its_callers() {
    let source = "<?php\n\nclass Printer\n{\n    public function run(): void\n    {\n        $this->show(new Item());\n    }\n\n    private function show($item): void\n    {\n        echo $it/*|*/em->title();\n    }\n}\n";
    let mut p = Project::new(&[("src/lib.php", CALL_SITE_LIB), ("src/Printer.php", source)]);
    let (text, pos) = caret(source);
    let doc = p.open("src/Printer.php", &text);
    let hover = p.engine.hover(doc, pos).expect("a hover").markdown;
    assert!(hover.contains("Item $item"), "{hover}");
    assert!(hover.contains("inferred from the arguments its callers pass"), "{hover}");
    // A declared parameter says nothing of the kind.
    let declared = source.replace("show($item)", "show(Item $item)");
    let (text, pos) = caret(&declared);
    let doc = p.open("src/Printer.php", &text);
    let hover = p.engine.hover(doc, pos).expect("a hover").markdown;
    assert!(hover.contains("Item $item") && !hover.contains("inferred"), "{hover}");
}

#[test]
fn a_parameter_nobody_calls_stays_unknown_and_object_is_refined() {
    // No caller: `mixed`, not the empty union.
    let source =
        "<?php\n\nclass Printer\n{\n    public function show($item): void\n    {\n        echo $it/*|*/em;\n    }\n}\n";
    let mut p = Project::new(&[("src/lib.php", CALL_SITE_LIB), ("src/Printer.php", source)]);
    let (text, pos) = caret(source);
    let doc = p.open("src/Printer.php", &text);
    let hover = p.engine.hover(doc, pos).expect("a hover").markdown;
    assert!(hover.contains("mixed $item") && !hover.contains("inferred"), "{hover}");
    // Declared `object`: what the callers pass says more.
    let object = "<?php\n\nclass Printer\n{\n    public function run(): void\n    {\n        $this->show(new Item());\n    }\n\n    private function show(object $item): void\n    {\n        $item->tit/*|*/le();\n    }\n}\n";
    assert_eq!(p.definition("src/Printer.php", object).expect("handled"), [target("src/lib.php", 4, "title")]);
}

#[test]
fn a_bare_container_parameter_takes_its_callers_elements() {
    let source = "<?php\n\nclass Printer\n{\n    public function run(): void\n    {\n        $this->all([new Item(), new Item()]);\n    }\n\n    private function all(array $items): void\n    {\n        foreach ($items as $item) {\n            $item->tit/*|*/le();\n        }\n    }\n}\n";
    let mut p = Project::new(&[("src/lib.php", CALL_SITE_LIB), ("src/Printer.php", source)]);
    assert_eq!(p.definition("src/Printer.php", source).expect("handled"), [target("src/lib.php", 4, "title")]);
    // A caller passing something that is no array of known elements: the declared `array` stays.
    let mixed = source.replace("$this->all([new Item(), new Item()]);", "$this->all([new Item()]); $this->all($_GET);");
    assert_eq!(p.definition("src/Printer.php", &mixed).expect("handled"), []);
}

#[test]
fn a_return_the_index_could_not_type_is_read_from_the_body() {
    // `pick()` returns its untyped parameter: only the callers say what.
    let source = "<?php\n\nclass Printer\n{\n    public function run(): void\n    {\n        $this->pick(new Item())->tit/*|*/le();\n    }\n\n    private function pick($item)\n    {\n        if (! $item) {\n            return null;\n        }\n\n        return $item;\n    }\n}\n";
    let mut p = Project::new(&[("src/lib.php", CALL_SITE_LIB), ("src/Printer.php", source)]);
    assert_eq!(p.definition("src/Printer.php", source).expect("handled"), [target("src/lib.php", 4, "title")]);
    // The method in another file.
    let helper = "<?php\n\nclass Picker\n{\n    public function pick($item)\n    {\n        return $item;\n    }\n}\n";
    let caller =
        "<?php\n\nfunction show(Picker $picker): string\n{\n    return $picker->pick(new Item())->tit/*|*/le();\n}\n";
    let mut p = Project::new(&[("src/lib.php", CALL_SITE_LIB), ("src/Picker.php", helper), ("src/show.php", caller)]);
    assert_eq!(p.definition("src/show.php", caller).expect("handled"), [target("src/lib.php", 4, "title")]);
    // A declared return type is never second-guessed.
    let declared = helper.replace("public function pick($item)", "public function pick($item): Other");
    let mut p =
        Project::new(&[("src/lib.php", CALL_SITE_LIB), ("src/Picker.php", &declared), ("src/show.php", caller)]);
    assert_eq!(p.definition("src/show.php", caller).expect("handled"), []);
}
