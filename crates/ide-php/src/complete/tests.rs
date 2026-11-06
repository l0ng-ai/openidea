use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ide_core::{IdeEvent, SharedSink};

use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig};
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;
use crate::syntax::LineIndex;

const WAIT: Duration = Duration::from_secs(60);
const CARET: &str = "/*|*/";

fn caret(source: &str) -> (String, Pos) {
    let at = source.find(CARET).expect("a /*|*/ caret");
    let text = format!("{}{}", &source[..at], &source[at + CARET.len()..]);
    let pos = LineIndex::new(&text).pos(at as u32);
    (text, pos)
}

struct Project {
    _tmp: Option<tempfile::TempDir>,
    root: PathBuf,
    engine: Arc<PhpEngine>,
    next_doc: u32,
}

impl Project {
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
        let engine = open_engine(&root, &base.join("cache"));
        Self { _tmp: Some(tmp), root, engine, next_doc: 1 }
    }

    fn open(&mut self, rel: &str, text: &str) -> DocId {
        let doc = DocId(self.next_doc);
        self.next_doc += 1;
        self.engine.document_opened(doc, &self.root.join(rel), 1, text);
        doc
    }

    /// Completion at the caret of `source`, opened as `rel`.
    fn complete(&mut self, rel: &str, source: &str) -> Completions {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new()).expect("handled");
        self.engine.document_closed(doc);
        found
    }
}

fn open_engine(root: &std::path::Path, cache: &std::path::Path) -> Arc<PhpEngine> {
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let config = EngineConfig {
        cache_dir: cache.join(CACHE_SUBDIR),
        layout: LayoutConfig { root: root.to_path_buf(), ..LayoutConfig::default() },
        stubs: StubFilter::default(),
    };
    let engine = PhpEngine::open(config, sink).unwrap();
    assert!(engine.wait_idle(WAIT));
    engine
}

fn labels(found: &Completions) -> Vec<&str> {
    found.items.iter().map(|item| item.label.as_str()).collect()
}

fn item<'c>(found: &'c Completions, label: &str) -> &'c Completion {
    found.items.iter().find(|item| item.label == label).unwrap_or_else(|| panic!("{label} in {:?}", labels(found)))
}

fn has(found: &Completions, label: &str) -> bool {
    found.items.iter().any(|item| item.label == label)
}

const ITEM: &str = "<?php\nnamespace App\\Model;\n\nabstract class Item\n{\n    protected int $price = 0;\n    private string $secret = '';\n\n    /** Gives the label shown in lists. */\n    abstract public function label(): string;\n\n    protected function cents(): int { return $this->price; }\n}\n";
const BOOK: &str = "<?php\nnamespace App\\Model;\n\nfinal class Book extends Item\n{\n    public const LIMIT = 3;\n    public static int $count = 0;\n\n    public function __construct(public string $title, public ?Genre $genre = null) {}\n\n    public function label(): string { return $this->title; }\n\n    public static function make(string $title): static { return new static($title); }\n\n    /** @deprecated use label() */\n    public function name(): string { return $this->title; }\n}\n";
const GENRE: &str = "<?php\nnamespace App\\Model;\n\nenum Genre: string\n{\n    case Fiction = 'f';\n    case Science = 's';\n    case History = 'h';\n}\n";
const SHELF: &str = "<?php\nnamespace App\\Model;\n\ninterface Shelf {}\n";
const FUNCTIONS: &str = "<?php\nnamespace App;\n\nuse App\\Model\\Genre;\n\nconst VERSION = '1.0';\n\nfunction slugify(string $text, string $separator = '-', bool $lower = true): string\n{\n    return $text;\n}\n\nfunction paint(Genre $genre): void {}\n";
const CONTAINER: &str = "<?php\nnamespace App;\n\nfinal class Container\n{\n    public function make(string $id): object { return new \\stdClass(); }\n}\n";
const META: &str = "<?php\nnamespace PHPSTORM_META {\n    expectedArguments(\\App\\Container::make(), 0, 'books', 'library');\n    expectedArguments(\\App\\slugify(), 1, '-', '_');\n}\n";

fn shop() -> Project {
    Project::new(&[
        ("src/Model/Item.php", ITEM),
        ("src/Model/Book.php", BOOK),
        ("src/Model/Genre.php", GENRE),
        ("src/Model/Shelf.php", SHELF),
        ("src/functions.php", FUNCTIONS),
        ("src/Container.php", CONTAINER),
        (".phpstorm.meta.php", META),
    ])
}

/// `src/run.php` in namespace `App` importing `Book`, then `body`.
fn run(body: &str) -> String {
    format!("<?php\nnamespace App;\n\nuse App\\Model\\Book;\n\nfunction main(Book $book): void\n{{\n{body}\n}}\n")
}

#[test]
fn members_after_arrow_follow_the_receiver_and_visibility() {
    let mut project = shop();
    let found = project.complete("src/run.php", &run("    $book->/*|*/\n    return;"));
    let names = labels(&found);
    for wanted in ["title", "genre", "label", "make", "name"] {
        assert!(names.contains(&wanted), "{wanted} in {names:?}");
    }
    for hidden in ["price", "secret", "cents", "__construct", "LIMIT", "count"] {
        assert!(!names.contains(&hidden), "{hidden} hidden in {names:?}");
    }
    let label = item(&found, "label");
    assert_eq!(label.kind, CompletionKind::Method);
    assert_eq!(label.detail.as_deref(), Some("string"));
    assert_eq!(label.label_detail.as_deref(), Some("()"));
    assert_eq!(label.insert_text, "label()");
    assert!(item(&found, "name").deprecated);
    assert_eq!(item(&found, "genre").detail.as_deref(), Some(r"?App\Model\Genre"));
    // Own members before inherited ones; a prefix filters and ranks.
    let found = project.complete("src/run.php", &run("    $book->la/*|*/;"));
    assert_eq!(labels(&found).first(), Some(&"label"));
    assert!(!has(&found, "title"), "{:?}", labels(&found));
    // The prefix is replaced, the rest of the word with Tab.
    let found = project.complete("src/run.php", &run("    $book->ti/*|*/tle;"));
    let title = item(&found, "title");
    assert_eq!((title.replace.start.col, title.replace.end.col), (11, 13));
    assert_eq!(title.replace_tab.map(|r| r.end.col), Some(16));

    // Inside a subclass, protected members are visible; the parent's
    // private ones are not.
    let source = "<?php\nnamespace App\\Model;\n\nfinal class Comic extends Item\n{\n    public function label(): string { return (string) $this->/*|*/; }\n}\n";
    let found = project.complete("src/Model/Comic.php", source);
    assert!(has(&found, "price") && has(&found, "cents"), "{:?}", labels(&found));
    assert!(!has(&found, "secret"), "{:?}", labels(&found));
    // Nullsafe access goes through the non-null part.
    let found = project.complete("src/run.php", &run("    $book->genre?->/*|*/\n    return;"));
    assert!(has(&found, "name") && has(&found, "value"), "{:?}", labels(&found));
}

#[test]
fn static_members_after_double_colon() {
    let mut project = shop();
    let found = project.complete("src/run.php", &run("    Book::/*|*/\n    return;"));
    let names = labels(&found);
    for wanted in ["LIMIT", "$count", "make", "class"] {
        assert!(names.contains(&wanted), "{wanted} in {names:?}");
    }
    assert!(!names.contains(&"label") && !names.contains(&"title"), "{names:?}");
    let found = project.complete("src/run.php", &run("    Book::$/*|*/\n    return;"));
    assert_eq!(labels(&found), ["$count"]);
    // Enum cases come first.
    let found = project.complete("src/run.php", &run("    \\App\\Model\\Genre::/*|*/\n    return;"));
    assert_eq!(&labels(&found)[..3], ["Fiction", "History", "Science"]);
    assert_eq!(item(&found, "Fiction").kind, CompletionKind::EnumCase);
    // `parent::` offers instance methods too.
    let source = "<?php\nnamespace App\\Model;\n\nfinal class Comic extends Item\n{\n    public function label(): string { return parent::/*|*/; }\n}\n";
    let found = project.complete("src/Model/Comic.php", source);
    assert!(has(&found, "cents") && has(&found, "label"), "{:?}", labels(&found));
}

#[test]
fn variables_in_scope_with_their_types() {
    let mut project = shop();
    let body = "    $count = 1;\n    $names = ['a'];\n    $fn = function (int $x) use ($count) {\n        return $/*|*/;\n    };\n    $later = 2;";
    let found = project.complete("src/run.php", &run(body));
    let names = labels(&found);
    assert!(names.contains(&"$x") && names.contains(&"$count"), "{names:?}");
    assert!(!names.contains(&"$names") && !names.contains(&"$book"), "a closure sees its captures: {names:?}");
    let body = "    $count = 1;\n    if ($book->genre) {\n        $genre = $book->genre;\n    }\n    echo $/*|*/;\n    $later = 2;";
    let found = project.complete("src/run.php", &run(body));
    let names = labels(&found);
    assert!(names.contains(&"$book") && names.contains(&"$count") && names.contains(&"$genre"), "{names:?}");
    assert!(!names.contains(&"$later") && !names.contains(&"$this"), "{names:?}");
    assert_eq!(item(&found, "$count").detail.as_deref(), Some("int"));
    assert_eq!(item(&found, "$book").detail.as_deref(), Some(r"App\Model\Book"));
    assert!(names.contains(&"$_GET"));
    // Locals before superglobals; the prefix filters.
    assert!(names.iter().position(|n| *n == "$book") < names.iter().position(|n| *n == "$_GET"));
    let found = project.complete("src/run.php", &run("    $bo/*|*/"));
    assert_eq!(labels(&found), ["$book"]);
    // `$this` in instance methods only.
    let source = "<?php\nnamespace App;\n\nfinal class Shop\n{\n    public function a(): void { $/*|*/; }\n    public static function b(): void {}\n}\n";
    assert!(has(&project.complete("src/Shop.php", source), "$this"));
    let source = "<?php\nnamespace App;\n\nfinal class Shop\n{\n    public static function b(): void { $/*|*/; }\n}\n";
    assert!(!has(&project.complete("src/Shop.php", source), "$this"));
}

#[test]
fn keywords_by_context() {
    let mut project = shop();
    let found = project.complete("src/run.php", &run("    fore/*|*/"));
    assert!(has(&found, "foreach"), "{:?}", labels(&found));
    let found = project.complete("src/run.php", &run("    $x = ma/*|*/;"));
    assert!(has(&found, "match"), "{:?}", labels(&found));
    assert!(!has(&found, "foreach"), "no statement keywords inside an expression: {:?}", labels(&found));
    let source = "<?php\nnamespace App;\n\nfinal class Shop\n{\n    pub/*|*/\n}\n";
    let found = project.complete("src/Shop.php", source);
    assert_eq!(labels(&found), ["public"]);
    // Nothing in comments, nor where a name is declared.
    assert!(project.complete("src/run.php", &run("    // fore/*|*/")).items.is_empty());
    assert!(project.complete("src/run.php", &run("    function Bo/*|*/")).items.is_empty());
}

#[test]
fn class_names_with_auto_import() {
    let mut project = shop();
    let source = "<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Http;\n\nuse App\\Container;\n\nfunction show(): void\n{\n    $g = Genr/*|*/\n}\n";
    let found = project.complete("src/Http/show.php", source);
    let genre = item(&found, "Genre");
    assert_eq!(genre.kind, CompletionKind::Enum);
    assert_eq!(genre.insert_text, "Genre");
    assert_eq!(genre.detail.as_deref(), Some(r"App\Model"));
    assert!(found.incomplete);
    let (text, _) = caret(source);
    let mut document = ide_text::Document::new(&text);
    document.apply_edits(&genre.additional_edits).unwrap();
    assert!(document.text().contains("use App\\Container;\nuse App\\Model\\Genre;\n"), "{}", document.text());
    // Already imported: no edit. Another class imported under the short
    // name: the fully qualified name.
    let found = project.complete("src/run.php", &run("    $b = Boo/*|*/"));
    assert!(item(&found, "Book").additional_edits.is_empty());
    let source = "<?php\nnamespace App;\n\nuse Other\\Genre;\n\n$g = Genr/*|*/\n";
    let found = project.complete("src/x.php", source);
    let genre = item(&found, "Genre");
    assert_eq!((genre.insert_text.as_str(), genre.additional_edits.len()), (r"\App\Model\Genre", 0));
    // No namespace: the import goes after the opening tag and `declare`.
    let source = "<?php\ndeclare(strict_types=1);\n\n$g = Genr/*|*/\n";
    let found = project.complete("x.php", source);
    let edit = &item(&found, "Genre").additional_edits[0];
    assert_eq!((edit.range.start.line, edit.new_text.as_str()), (1, "\n\nuse App\\Model\\Genre;"));
    // `new` offers classes only; built-in classes come from the stubs.
    let found = project.complete("src/run.php", &run("    $s = new S/*|*/"));
    assert!(!has(&found, "Shelf"), "{:?}", labels(&found));
    assert!(has(&found, "SplStack"), "{:?}", labels(&found));
    let found = project.complete("src/run.php", &run("    $s = $book instanceof Shel/*|*/;"));
    assert_eq!(item(&found, "Shelf").kind, CompletionKind::Interface);
    // Functions and constants.
    let found = project.complete("src/run.php", &run("    $s = slug/*|*/"));
    let slugify = item(&found, "slugify");
    assert_eq!(slugify.insert_text, "slugify($0)");
    assert!(slugify.is_snippet);
    assert_eq!(slugify.detail.as_deref(), Some("string"));
    assert!(slugify.label_detail.as_deref().unwrap().starts_with("(string $text"));
    let found = project.complete("src/run.php", &run("    $s = str_rep/*|*/"));
    assert!(has(&found, "str_replace"), "{:?}", labels(&found));
    let found = project.complete("src/run.php", &run("    $s = VERS/*|*/;"));
    assert_eq!(item(&found, "VERSION").kind, CompletionKind::Constant);
    // A qualified prefix.
    let found = project.complete("src/run.php", &run("    $g = Model\\Gen/*|*/;"));
    let genre = item(&found, "Genre");
    assert_eq!((genre.insert_text.as_str(), genre.additional_edits.len()), (r"Model\Genre", 0));
    // `use` statements take the fully qualified name.
    let found = project.complete("src/y.php", "<?php\nnamespace App;\n\nuse Genr/*|*/\n");
    assert_eq!(item(&found, "Genre").insert_text, r"App\Model\Genre");
}

#[test]
fn named_arguments_expected_values_and_enum_cases() {
    let mut project = shop();
    let found = project.complete("src/run.php", &run("    slugify('a', /*|*/);"));
    let names = labels(&found);
    assert!(names.contains(&"separator:") && names.contains(&"lower:"), "{names:?}");
    assert!(!names.contains(&"text:"), "already passed: {names:?}");
    assert_eq!(item(&found, "lower:").insert_text, "lower: ");
    // `.phpstorm.meta.php` expected arguments, as code and inside a string.
    assert!(names.contains(&"'-'") && names.contains(&"'_'"), "{names:?}");
    let body = "    $c = new Container();\n    $c->make('/*|*/');";
    let found = project.complete("src/run.php", &run(body));
    assert_eq!(labels(&found), ["books", "library"]);
    assert_eq!(item(&found, "books").insert_text, "books");
    let body = "    $c = new Container();\n    $c->make('bo/*|*/');";
    assert_eq!(labels(&project.complete("src/run.php", &run(body))), ["books"]);
    // Named arguments of constructors, and named arguments already given.
    let found = project.complete("src/run.php", &run("    new Book(genre: null, /*|*/);"));
    assert!(has(&found, "title:") && !has(&found, "genre:"), "{:?}", labels(&found));
    // The cases of an enum-typed parameter, imported.
    let found = project.complete("src/run.php", &run("    paint(/*|*/);"));
    let fiction = item(&found, "Genre::Fiction");
    assert_eq!(fiction.insert_text, "Genre::Fiction");
    assert_eq!(fiction.additional_edits[0].new_text, "\nuse App\\Model\\Genre;");
    // Named arguments rank first.
    assert_eq!(found.items[0].kind, CompletionKind::Parameter);
}

#[test]
fn match_arms_offer_the_cases_not_covered() {
    let mut project = shop();
    let body =
        "    $label = match ($book->genre) {\n        \\App\\Model\\Genre::Fiction => 'f',\n        /*|*/\n    };";
    let found = project.complete("src/run.php", &run(body));
    assert!(has(&found, "Genre::Science") && has(&found, "Genre::History"), "{:?}", labels(&found));
    assert!(!has(&found, "Genre::Fiction"), "{:?}", labels(&found));
    let body = "    /** @var 'a'|'b' $mode */\n    $mode = rand(0, 1) ? 'a' : 'b';\n    echo match ($mode) {\n        'a' => 1,\n        /*|*/ => 2,\n    };";
    let found = project.complete("src/run.php", &run(body));
    assert!(has(&found, "'b'") && !has(&found, "'a'"), "{:?}", labels(&found));
}

#[test]
fn array_shape_keys() {
    let mut project = shop();
    let body = "    $row = ['name' => 'x', 'pages' => 3];\n    echo $row['/*|*/'];";
    let found = project.complete("src/run.php", &run(body));
    assert_eq!(labels(&found), ["name", "pages"]);
    assert_eq!(item(&found, "pages").detail.as_deref(), Some("int"));
    let body = "    $row = ['name' => 'x', 'pages' => 3];\n    echo $row[pa/*|*/];";
    let found = project.complete("src/run.php", &run(body));
    assert_eq!(labels(&found), ["pages"]);
    assert_eq!(item(&found, "pages").insert_text, "'pages'");
}

#[test]
fn documentation_is_resolved_lazily() {
    let mut project = shop();
    let (text, pos) = caret(&run("    $book->lab/*|*/;"));
    let doc = project.open("src/run.php", &text);
    let found = project.engine.completion(doc, pos, None, &CancellationToken::new()).unwrap();
    let label = item(&found, "label");
    let data = label.data.clone().expect("resolve data");
    assert_eq!(data, CompletionData::Method { class: r"App\Model\Book".into(), name: "label".into() });
    let json = serde_json::to_value(&data).unwrap();
    assert_eq!(serde_json::from_value::<CompletionData>(json).unwrap(), data);
    let docs = project.engine.completion_documentation(doc, &data).expect("documentation");
    assert!(docs.contains("public function label(): string"), "{docs}");
    assert!(docs.contains("Gives the label shown in lists."), "inherited: {docs}");
    let class =
        project.engine.completion_documentation(doc, &CompletionData::ClassLike { fqn: r"App\Model\Genre".into() });
    assert!(class.unwrap().contains("enum Genre"));
}

#[test]
fn triggers_open_completion_only_where_they_start_a_context() {
    let mut project = shop();
    let (text, pos) = caret(&run("    $x = 1 >/*|*/"));
    let doc = project.open("src/run.php", &text);
    let found = project.engine.completion(doc, pos, Some(">"), &CancellationToken::new()).unwrap();
    assert!(found.items.is_empty(), "{:?}", labels(&found));
    let (text, pos) = caret(&run("    $book->/*|*/"));
    let doc = project.open("src/run2.php", &text);
    let found = project.engine.completion(doc, pos, Some(">"), &CancellationToken::new()).unwrap();
    assert!(has(&found, "title"));
}

/// The roadmap's budget: p95 under 50 ms on the fixture (a release build;
/// debug builds get more room).
#[test]
fn completion_on_the_fixture_is_fast() {
    let root = dunce::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/php-app")).unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut project = Project { _tmp: None, root: root.clone(), engine: open_engine(&root, cache.path()), next_doc: 1 };
    let library = std::fs::read_to_string(root.join("src/Library.php")).unwrap();
    let anchor = "$lent = $book->withAvailability(false);";
    let cases =
        ["        $lent->", "        $genre = Genr", "        $", "        Genre::", "        $this->checkout("];
    let mut times = Vec::new();
    for _ in 0..4 {
        for typed in cases {
            let source = library.replacen(anchor, &format!("{anchor}\n{typed}/*|*/"), 1);
            let started = Instant::now();
            let found = project.complete("src/Library.php", &source);
            times.push(started.elapsed());
            assert!(!found.items.is_empty() || typed.ends_with('('), "{typed}");
        }
    }
    let found =
        project.complete("src/Library.php", &library.replacen(anchor, &format!("{anchor}\n        $lent->/*|*/"), 1));
    assert!(has(&found, "label"), "{:?}", labels(&found));
    times.sort();
    let p95 = times[times.len() * 95 / 100 - 1];
    let budget = if cfg!(debug_assertions) { Duration::from_millis(500) } else { Duration::from_millis(50) };
    assert!(p95 < budget, "p95 {p95:?} over {budget:?}: {times:?}");
}
