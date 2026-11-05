use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::{Hierarchy, Resolver, SummarySet, Type, TypeCache, type_at};

const CARET: &str = "/*|*/";

macro_rules! fixture {
    ($path:literal) => {
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/php-app/src/", $path))
    };
}

/// The fixture's classes that use generics.
const FIXTURE: &[&str] = &[
    fixture!("Support/Collection.php"),
    fixture!("Support/HasTimestamps.php"),
    fixture!("Model/Book.php"),
    fixture!("Model/Genre.php"),
    fixture!("Contracts/Repository.php"),
    fixture!("Repository/AbstractRepository.php"),
    fixture!("Repository/BookRepository.php"),
    fixture!("Library.php"),
];

const FIXTURE_HEADER: &str = "<?php\nnamespace Main;\nuse App\\Support\\Collection;\nuse App\\Model\\Book;\nuse App\\Repository\\BookRepository;\nuse App\\Library;\n";

/// A Laravel-style collection (keys and values, `static<…>` returns, a
/// static constructor with its own templates) and other generic code.
const LIB: &str = r#"<?php
namespace Lib;

class Book { public int $pages = 0; public string $title = ''; }
class Author {}

/**
 * @template TKey of array-key
 * @template-covariant TValue
 * @implements \ArrayAccess<TKey, TValue>
 * @implements \IteratorAggregate<TKey, TValue>
 */
class LCollection implements \ArrayAccess, \IteratorAggregate {
    /** @param array<TKey, TValue> $items */
    public function __construct($items = []) {}

    /**
     * @template TMakeKey of array-key
     * @template TMakeValue
     * @param array<TMakeKey, TMakeValue> $items
     * @return static<TMakeKey, TMakeValue>
     */
    public static function make($items = []) { return new static($items); }

    /**
     * @template TMapValue
     * @param callable(TValue, TKey): TMapValue $callback
     * @return static<TKey, TMapValue>
     */
    public function map(callable $callback) { return $this; }

    /** @return static */
    public function filter(?callable $callback = null) { return $this; }

    /** @return TValue|null */
    public function first() { return null; }

    /** @return array<TKey, TValue> */
    public function all() { return []; }

    /**
     * @param TKey $key
     * @return TValue
     */
    public function offsetGet($key): mixed { return null; }

    /** @return \ArrayIterator<TKey, TValue> */
    public function getIterator(): \Traversable { return new \ArrayIterator([]); }

    public function keys() { return $this->map(fn ($v, $k) => $k); }
}

/** @extends LCollection<int, Book> */
class BookCollection extends LCollection {}

/**
 * @template T
 */
trait HoldsOne {
    /** @var T */
    public $held;
    /** @return T */
    public function held() { return $this->held; }
}

class Shelf {
    /** @use HoldsOne<Book> */
    use HoldsOne;
}

/**
 * @template T of object
 * @template D = Author
 */
class Box {
    /** @return T */
    public function get() {}
    /** @return D */
    public function extra() {}
    /** @return list<T> */
    public function all(): array { return []; }
}

/**
 * @template T of object
 * @param class-string<T> $class
 * @return T
 */
function make(string $class) { return new $class(); }

/**
 * @template T
 * @param array<T> $items
 * @return T
 */
function head(array $items) { return $items[0]; }

/**
 * @template T
 * @param T|null $value
 * @return T
 */
function or_fail($value) { return $value; }

/**
 * @template K
 * @template V
 * @param iterable<K, V> $items
 * @return array<K, V>
 */
function to_array(iterable $items): array { return []; }

/**
 * @template T
 * @param T ...$values
 * @return list<T>
 */
function list_of(...$values): array { return $values; }

/** @return \Generator<int, Book> */
function books() { yield new Book(); }

/** @return ?Book */
function maybe_book() { return null; }
"#;

const LIB_HEADER: &str = "<?php\nnamespace Main;\nuse Lib\\{Book, Author, LCollection, BookCollection, Shelf, Box};\nuse function Lib\\{make, head, or_fail, to_array, list_of, books, maybe_book};\n";

fn type_in(libs: &[&str], header: &str, body: &str) -> String {
    let source = format!("{header}{body}");
    let offset = source.find(CARET).unwrap_or_else(|| panic!("no caret in {body}"));
    let source = source.replacen(CARET, "", 1);
    let file = ParsedFile::parse("main.php", source.as_str());
    assert!(!file.has_errors(), "{body}: {:?}", file.errors());
    let mut summaries = vec![FileSummary::extract(&file)];
    for (i, lib) in libs.iter().enumerate() {
        let lib = ParsedFile::parse(format!("lib{i}.php").as_str(), *lib);
        assert!(!lib.has_errors(), "{:?}", lib.errors());
        summaries.push(FileSummary::extract(&lib));
    }
    let decls = SummarySet::new(summaries);
    let cache = TypeCache::new();
    let resolver = Resolver::new(&decls, &cache, 1);
    type_at(&file, &resolver, offset as u32).map(|ty| ty.to_string()).unwrap_or_else(|| "<none>".to_owned())
}

fn check(libs: &[&str], header: &str, cases: &[(&str, &str)]) {
    let mut failures = Vec::new();
    for (body, expected) in cases {
        let got = type_in(libs, header, body);
        if got != *expected {
            failures.push(format!("{body}\n  expected {expected}\n  got      {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn fixture_collection() {
    let p = "/** @param Collection<Book> $c */\nfunction f(Collection $c) {\n";
    let cases: Vec<(String, &str)> = vec![
        (format!("{p}$c->first()/*|*/;\n}}"), "?App\\Model\\Book"),
        (format!("{p}$c->toArray()/*|*/;\n}}"), "list<App\\Model\\Book>"),
        (format!("{p}$c->filter(fn (Book $b): bool => true)/*|*/;\n}}"), "App\\Support\\Collection<App\\Model\\Book>"),
        (
            format!("{p}$c->push(new Book('', '', \\App\\Model\\Genre::Fiction, 1))->first()/*|*/;\n}}"),
            "?App\\Model\\Book",
        ),
        // A method template inferred from the callback's return type.
        (format!("{p}$c->map(fn (Book $b): string => $b->title)/*|*/;\n}}"), "App\\Support\\Collection<string>"),
        (format!("{p}$c->map(fn (Book $b) => $b->priceCents)->first()/*|*/;\n}}"), "?int"),
        // `foreach` over `IteratorAggregate<int, T>`.
        (format!("{p}foreach ($c as $k => $book) {{ $book/*|*/; }}\n}}"), "App\\Model\\Book"),
        (format!("{p}foreach ($c as $k => $book) {{ $k/*|*/; }}\n}}"), "int"),
        (format!("{p}$c->getIterator()/*|*/;\n}}"), "ArrayIterator<int, App\\Model\\Book>"),
        // Class templates inferred from the constructor.
        ("$n = new Collection([1, 2, 3]);\n$n/*|*/;".to_owned(), "App\\Support\\Collection<int>"),
        ("(new Collection([1, 2]))->first()/*|*/;".to_owned(), "?int"),
        // Nothing to infer: the raw class, its template falling back to mixed.
        ("$e = new Collection();\n$e/*|*/;".to_owned(), "App\\Support\\Collection"),
        ("(new Collection())->first()/*|*/;".to_owned(), "mixed"),
        // `@extends AbstractRepository<Book>`, `@implements Repository<T>`,
        // and `all(): Collection` taking the interface's `@return Collection<T>`.
        ("(new BookRepository())->all()/*|*/;".to_owned(), "App\\Support\\Collection<App\\Model\\Book>"),
        ("(new BookRepository())->find('x')/*|*/;".to_owned(), "?App\\Model\\Book"),
        ("(new BookRepository())->all()->first()/*|*/;".to_owned(), "?App\\Model\\Book"),
        ("function g(Library $l) { $l->available()->first()/*|*/; }".to_owned(), "?App\\Model\\Book"),
    ];
    let cases: Vec<(&str, &str)> = cases.iter().map(|(body, ty)| (body.as_str(), *ty)).collect();
    check(FIXTURE, FIXTURE_HEADER, &cases);
}

#[test]
fn inside_the_generic_class_templates_stay() {
    let body = "namespace App\\Support;\n/** @template T */\nclass Own {\n  /** @return T */\n  public function get() {}\n  public function f() { $this->get()/*|*/; }\n}\n";
    assert_eq!(type_in(&[], "<?php\n", body), "T");
    // And through a parent bound with `@extends`.
    let body = "/** @template T */\nclass Base {\n  /** @return list<T> */\n  public function all() {}\n}\n/** @extends Base<int> */\nclass Ints extends Base {\n  public function f() { $this->all()/*|*/; parent::all(); }\n}\n";
    assert_eq!(type_in(&[], "<?php\n", body), "list<int>");
    let body = "/** @template T */\nclass Base {\n  /** @return list<T> */\n  public function all() {}\n}\n/** @extends Base<int> */\nclass Ints extends Base {\n  public function f() { parent::all()/*|*/; }\n}\n";
    assert_eq!(type_in(&[], "<?php\n", body), "list<int>");
}

#[test]
fn laravel_style_collection() {
    check(
        &[LIB],
        LIB_HEADER,
        &[
            // A static constructor with its own templates, returning `static<…>`.
            ("LCollection::make(['a' => new Book()])/*|*/;", "Lib\\LCollection<string, Lib\\Book>"),
            ("LCollection::make([new Book()])->first()/*|*/;", "?Lib\\Book"),
            ("LCollection::make([1])->map(fn (int $i): string => 'x')/*|*/;", "Lib\\LCollection<int, string>"),
            ("function f(BookCollection $b) { $b->filter()/*|*/; }", "Lib\\BookCollection"),
            // `static` through a generic parent keeps the subclass, whose
            // members are bound by `@extends LCollection<int, Book>`.
            ("function f(BookCollection $b) { $b->filter()->first()/*|*/; }", "?Lib\\Book"),
            ("function f(BookCollection $b) { $b->all()/*|*/; }", "array<int, Lib\\Book>"),
            ("function f(BookCollection $b) { $b[0]/*|*/; }", "Lib\\Book"),
            // `static<K, V>` on a subclass without templates: the declaring class.
            (
                "function f(BookCollection $b) { $b->map(fn (Book $x): int => $x->pages)/*|*/; }",
                "Lib\\LCollection<int, int>",
            ),
            ("function f(BookCollection $b) { foreach ($b as $k => $v) { $v/*|*/; } }", "Lib\\Book"),
            ("function f(BookCollection $b) { foreach ($b as $k => $v) { $k/*|*/; } }", "int"),
            (
                "/** @param LCollection<string, Author> $c */\nfunction f($c) { foreach ($c as $k => $v) { $k/*|*/; } }",
                "string",
            ),
            (
                "/** @param LCollection<string, Author> $c */\nfunction f($c) { $c->getIterator()/*|*/; }",
                "ArrayIterator<string, Lib\\Author>",
            ),
            // An untyped callback's return can't be inferred.
            ("function f(BookCollection $b) { $b->map(fn ($x) => $x)/*|*/; }", "Lib\\LCollection<int, mixed>"),
        ],
    );
}

#[test]
fn function_templates_from_arguments() {
    check(
        &[LIB],
        LIB_HEADER,
        &[
            ("make(Book::class)/*|*/;", "Lib\\Book"),
            ("$class = Author::class;\nmake($class)/*|*/;", "Lib\\Author"),
            ("head([1, 2])/*|*/;", "int"),
            ("head(['a' => new Book()])/*|*/;", "Lib\\Book"),
            ("head(['a', 1])/*|*/;", "string|int"),
            ("or_fail(maybe_book())/*|*/;", "Lib\\Book"),
            ("or_fail(value: new Author())/*|*/;", "Lib\\Author"),
            ("to_array(books())/*|*/;", "array<int, Lib\\Book>"),
            ("list_of(1, 2, 3)/*|*/;", "list<int>"),
            ("list_of(...[new Book()])/*|*/;", "list<Lib\\Book>"),
            // No arguments to infer from: the template's bound.
            ("head([])/*|*/;", "mixed"),
            ("make('nope')/*|*/;", "nope"),
        ],
    );
}

#[test]
fn bounds_defaults_and_trait_use() {
    check(
        &[LIB],
        LIB_HEADER,
        &[
            // Unbound templates fall back to the default, else the bound.
            ("function f(Box $b) { $b->get()/*|*/; }", "object"),
            ("function f(Box $b) { $b->extra()/*|*/; }", "Lib\\Author"),
            ("function f(Box $b) { $b->all()/*|*/; }", "list<object>"),
            ("/** @param Box<Book> $b */\nfunction f($b) { $b->get()/*|*/; }", "Lib\\Book"),
            ("/** @param Box<Book> $b */\nfunction f($b) { $b->extra()/*|*/; }", "Lib\\Author"),
            ("/** @param Box<Book, Book> $b */\nfunction f($b) { $b->extra()/*|*/; }", "Lib\\Book"),
            // `@use HoldsOne<Book>`.
            ("function f(Shelf $s) { $s->held()/*|*/; }", "Lib\\Book"),
            ("function f(Shelf $s) { $s->held/*|*/; }", "Lib\\Book"),
        ],
    );
}

#[test]
fn foreach_over_generic_iterables() {
    check(
        &[LIB],
        LIB_HEADER,
        &[
            ("foreach (books() as $k => $b) { $b/*|*/; }", "Lib\\Book"),
            ("foreach (books() as $k => $b) { $k/*|*/; }", "int"),
            (
                "/** @param iterable<string, Book> $i */\nfunction f(iterable $i) { foreach ($i as $k => $v) { $k/*|*/; } }",
                "string",
            ),
            (
                "/** @param array<string, Author> $a */\nfunction f(array $a) { foreach ($a as $v) { $v/*|*/; } }",
                "Lib\\Author",
            ),
            (
                "/** @param \\Traversable<int, Author> $t */\nfunction f($t) { foreach ($t as $v) { $v/*|*/; } }",
                "Lib\\Author",
            ),
            ("/** @param \\Iterator<Author> $t */\nfunction f($t) { foreach ($t as $v) { $v/*|*/; } }", "Lib\\Author"),
        ],
    );
}

#[test]
fn generic_subtyping_through_parents() {
    let lib = ParsedFile::parse("lib.php", LIB);
    let decls = SummarySet::new(vec![FileSummary::extract(&lib)]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let collection = |key: Type, value: &str| Type::generic("Lib\\LCollection", vec![key, Type::named(value)]);
    let books = Type::named("Lib\\BookCollection");
    assert!(books.is_subtype_of(&collection(Type::Int, "Lib\\Book"), &r));
    assert!(!books.is_subtype_of(&collection(Type::Int, "Lib\\Author"), &r));
    assert!(books.is_subtype_of(&Type::generic("IteratorAggregate", vec![Type::Int, Type::named("Lib\\Book")]), &r));
    assert!(!books.is_subtype_of(&Type::generic("IteratorAggregate", vec![Type::Int, Type::named("Lib\\Author")]), &r));
    assert_eq!(
        r.supertype_args("Lib\\LCollection", &[Type::string(), Type::named("Lib\\Author")], "ArrayAccess"),
        Some(vec![Type::string(), Type::named("Lib\\Author")])
    );
    assert_eq!(r.ancestor_args("Lib\\Shelf", &[], "Lib\\HoldsOne"), Some(vec![Type::named("Lib\\Book")]));
    assert_eq!(r.ancestor_args("Lib\\Book", &[], "Lib\\LCollection"), None);
}

#[test]
fn static_with_arguments_parses_and_prints() {
    let ty = crate::types::parse_doc_type("static<int, T>", &["T"]).expect("parses");
    assert_eq!(ty.to_string(), "static<int, T>");
    let plain = crate::types::parse_doc_type("static", &[]).expect("parses");
    assert_eq!(plain, Type::Relative(crate::types::Relative::Static));
}
