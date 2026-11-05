use super::*;
use crate::types::{SummarySet, TypeCache};

const CARET: &str = "/*|*/";

/// Declarations the snippets use.
const LIB: &str = r#"<?php
namespace Lib;

class Book {
    const KIND = 'book';
    public string $title = '';
    public ?Author $author = null;
    public static int $count = 0;
    public $untyped = [1, 2];
    public function __construct(public int $pages = 0) {}
    public function author(): ?Author { return $this->author; }
    public function withTitle(string $title): static { return $this; }
    public static function create(): self { return new self(); }
    /** @return list<Chapter> */
    public function chapters(): array { return []; }
    public function __invoke(int $x): float { return 1.0; }
}
class Novel extends Book {}
class Author {
    public string $name = '';
    public function shelf(): Shelf { return new Shelf(); }
}
class Chapter {}
class Shelf {
    public function offsetGet(mixed $offset): Book { return new Book(); }
}
enum Suit: string {
    case Hearts = 'H';
}
function make_book(): Book { return new Book(); }
function untyped() { return new Author(); }
/** @param list<Book> $books */
function first(array $books, int ...$rest): Book { return $books[0]; }
const VERSION = '1.0';
"#;

const HEADER: &str = "<?php\nnamespace App;\nuse Lib\\{Book, Novel, Author, Shelf, Suit};\nuse function Lib\\{make_book, untyped, first};\nuse const Lib\\VERSION;\n";

/// The type at the caret of `body` (after [`HEADER`]), displayed.
fn type_at_caret(body: &str) -> Option<String> {
    let source = format!("{HEADER}{body}");
    let offset = source.find(CARET).unwrap_or_else(|| panic!("no caret in {body}"));
    let source = source.replacen(CARET, "", 1);
    let file = ParsedFile::parse("main.php", source.as_str());
    assert!(!file.has_errors(), "{body}: {:?}", file.errors());
    let lib = ParsedFile::parse("lib.php", LIB);
    assert!(!lib.has_errors(), "{:?}", lib.errors());
    let decls = SummarySet::new(vec![FileSummary::extract(&file), FileSummary::extract(&lib)]);
    let cache = TypeCache::new();
    let resolver = Resolver::new(&decls, &cache, 1);
    type_at(&file, &resolver, offset as u32).map(|ty| ty.to_string())
}

fn check(table: &[(&str, &str)]) {
    let mut failures = Vec::new();
    for (body, expected) in table {
        let actual = type_at_caret(body);
        if actual.as_deref() != Some(*expected) {
            failures.push(format!("{body}\n    expected {expected}\n    got      {actual:?}"));
        }
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn literals_and_operators() {
    check(&[
        ("'a'/*|*/;", "string"),
        ("42/*|*/;", "int"),
        ("-1/*|*/;", "int"),
        ("1.5/*|*/;", "float"),
        ("true/*|*/;", "bool"),
        ("null/*|*/;", "null"),
        ("\"x{$y}\"/*|*/;", "string"),
        ("__LINE__/*|*/;", "int"),
        ("__DIR__/*|*/;", "string"),
        ("(1 + 2)/*|*/;", "int"),
        ("(1 + 2.0)/*|*/;", "float"),
        ("(1 / 2)/*|*/;", "int|float"),
        ("(2 ** 3)/*|*/;", "int|float"),
        ("(5 % 2)/*|*/;", "int"),
        ("(1 <=> 2)/*|*/;", "int"),
        ("('a' . 1)/*|*/;", "string"),
        ("(1 < 2)/*|*/;", "bool"),
        ("($a && $b)/*|*/;", "bool"),
        ("(!$x)/*|*/;", "bool"),
        ("((int) $x)/*|*/;", "int"),
        ("((string) $x)/*|*/;", "string"),
        ("((array) $x)/*|*/;", "array"),
        ("isset($x)/*|*/;", "bool"),
        ("(print 'a')/*|*/;", "int"),
        ("($x ? 1 : 'a')/*|*/;", "int|string"),
        ("match ($x) { 1 => 'a', default => 2 }/*|*/;", "string|int"),
        ("($x instanceof Book)/*|*/;", "bool"),
        ("new class {}/*|*/;", "object"),
    ]);
}

#[test]
fn new_calls_and_member_access() {
    check(&[
        ("new Book/*|*/;", r"Lib\Book"),
        ("new Book()/*|*/;", r"Lib\Book"),
        ("make_book()/*|*/;", r"Lib\Book"),
        ("untyped()/*|*/;", r"Lib\Author"),
        ("unknown_function()/*|*/;", "mixed"),
        ("(new Book)->author()/*|*/;", r"?Lib\Author"),
        ("(new Book)->author()?->name/*|*/;", "?string"),
        ("(new Book)->author()?->shelf()/*|*/;", r"?Lib\Shelf"),
        ("(new Book)->withTitle('x')/*|*/;", r"Lib\Book"),
        ("(new Novel)->withTitle('x')/*|*/;", r"Lib\Novel"),
        ("Book::create()/*|*/;", r"Lib\Book"),
        ("Novel::create()/*|*/;", r"Lib\Book"),
        ("(new Book)->title/*|*/;", "string"),
        ("(new Book)->pages/*|*/;", "int"),
        ("(new Book)->untyped/*|*/;", "non-empty-list<int>"),
        ("Book::$count/*|*/;", "int"),
        ("Book::KIND/*|*/;", "string"),
        ("Book::class/*|*/;", r"class-string<Lib\Book>"),
        ("Suit::Hearts/*|*/;", r"Lib\Suit"),
        ("Suit::Hearts->value/*|*/;", "string"),
        ("Suit::from('H')/*|*/;", r"Lib\Suit"),
        ("Suit::tryFrom('H')/*|*/;", r"?Lib\Suit"),
        ("VERSION/*|*/;", "string"),
        ("UNKNOWN_CONSTANT/*|*/;", "mixed"),
        ("clone (new Book)/*|*/;", r"Lib\Book"),
        ("((new Book)->author() ?? new Author)/*|*/;", r"Lib\Author"),
        ("((new Book)->author() ?: 1)/*|*/;", r"Lib\Author|int"),
        ("(new Book)(1)/*|*/;", "float"),
        // The innermost expression: the receiver, not the call.
        ("(new Book)/*|*/->author();", r"Lib\Book"),
        ("first([])/*|*/;", r"Lib\Book"),
    ]);
}

#[test]
fn arrays_and_shapes() {
    check(&[
        ("[]/*|*/;", "array"),
        ("[1, 2]/*|*/;", "list{int, int}"),
        ("['a' => 1, 'b' => new Book]/*|*/;", r"array{a: int, b: Lib\Book}"),
        ("[3 => 'x', 'y']/*|*/;", "array{3: string, 4: string}"),
        ("[$k => 1]/*|*/;", "non-empty-array<int>"),
        ("$a = ['a' => 1, 'b' => new Book];\n$a['b']/*|*/;", r"Lib\Book"),
        ("$a = ['a' => 1, 'b' => new Book];\n$a[$k]/*|*/;", r"int|Lib\Book"),
        ("$l = [new Book];\n$l[0]->title/*|*/;", "string"),
        ("(new Book)->chapters()[0]/*|*/;", r"Lib\Chapter"),
        ("(new Author)->shelf()[0]/*|*/;", r"Lib\Book"),
        ("'abc'[0]/*|*/;", "string"),
        ("$m[0]/*|*/;", "mixed"),
    ]);
}

#[test]
fn variables_and_assignments() {
    check(&[
        ("$x = 1;\n$x = 'a';\n$x/*|*/;", "string"),
        ("$i = 1;\n$i += 2;\n$i/*|*/;", "int"),
        ("$s = 1;\n$s .= 'b';\n$s/*|*/;", "string"),
        ("$n = null;\n$n ??= new Book;\n$n/*|*/;", r"Lib\Book"),
        ("$x = 1;\n$x = $x + 0.5;\n$x/*|*/;", "float"),
        // The assigned variable itself.
        ("$b/*|*/ = new Book;", r"Lib\Book"),
        ("($b = new Book)/*|*/;", r"Lib\Book"),
        // Read before the assignment.
        ("$late/*|*/;\n$late = 1;", "mixed"),
        ("$undefined/*|*/;", "mixed"),
        // Variables of a nested closure don't leak out.
        ("$f = function () { $inner = 1; };\n$inner/*|*/;", "mixed"),
        // Parameters, `@param` first.
        ("function f(Book $b) { return $b/*|*/; }", r"Lib\Book"),
        ("/** @param list<Book> $books */\nfunction g(array $books) { return $books[0]/*|*/; }", r"Lib\Book"),
        ("function h(Book ...$books) { return $books/*|*/; }", r"list<Lib\Book>"),
        ("function u($p) { return $p/*|*/; }", "mixed"),
        // A parameter reassigned.
        ("function k(int $p) { $p = 'a'; return $p/*|*/; }", "string"),
        // Assignments in the function, not the top level.
        ("$v = 1;\nfunction m() { return $v/*|*/; }", "mixed"),
    ]);
}

#[test]
fn classes_and_relative_names() {
    let class = |body: &str| {
        format!(
            "class Shop extends Book {{\n    public Author $owner;\n    public function run(Chapter $c) {{\n        {body}\n    }}\n    public static function make(): static {{ return new static(); }}\n}}\n"
        )
    };
    let table: Vec<(String, &str)> = vec![
        (class("$this/*|*/;"), "$this"),
        (class("$this->owner/*|*/;"), r"Lib\Author"),
        (class("$this->title/*|*/;"), "string"),
        // Declared `: static`.
        (class("$this->withTitle('x')/*|*/;"), "static"),
        (class("self::KIND/*|*/;"), "string"),
        (class("new self()/*|*/;"), r"App\Shop"),
        (class("new static()/*|*/;"), "static"),
        (class("parent::create()/*|*/;"), r"Lib\Book"),
        (class("static::make()/*|*/;"), "static"),
        (class("self::make()/*|*/;"), "static"),
        (class("$c/*|*/;"), r"App\Chapter"),
        (class("$x = fn() => $this;\n$x()/*|*/;"), "$this"),
    ];
    let table: Vec<(&str, &str)> = table.iter().map(|(body, ty)| (body.as_str(), *ty)).collect();
    check(&table);
    // `$this` outside a class is nothing.
    check(&[("$this/*|*/;", "mixed")]);
}

#[test]
fn closures_and_callables() {
    check(&[
        ("fn(int $x) => $x * 2/*|*/;", "int"),
        ("(fn(int $x) => $x * 2)/*|*/;", "Closure(int $x): int"),
        ("(fn(int $x): float => $x)/*|*/;", "Closure(int $x): float"),
        ("$b = new Book;\n(function (string $s = '') use ($b) { return $b; })/*|*/;", r"Closure(string =$s): Lib\Book"),
        ("(function () {})/*|*/;", "Closure(): void"),
        ("(function () { yield 1; })/*|*/;", "Closure(): Generator"),
        ("(function ($c) { if ($c) { return 1; } return; })/*|*/;", "Closure(mixed $c): ?int"),
        ("(function (Book ...$b) { return $b; })/*|*/;", r"Closure(Lib\Book ...$b): list<Lib\Book>"),
        // `use` captures and the arrow function's enclosing scope.
        ("$b = new Book;\n$f = function () use ($b) { return $b/*|*/; };", r"Lib\Book"),
        ("$b = new Book;\n$f = function () { return $b/*|*/; };", "mixed"),
        ("$b = new Book;\n$f = fn() => $b/*|*/;", r"Lib\Book"),
        ("$b = new Book;\n$f = fn(Author $b) => $b/*|*/;", r"Lib\Author"),
        ("function outer(Book $p) { return fn() => fn() => $p/*|*/; }", r"Lib\Book"),
        // Calling closures and invokable objects.
        ("$f = fn(int $x): Book => new Book;\n$f(1)/*|*/;", r"Lib\Book"),
        ("$f = function () { return new Author; };\n$f()/*|*/;", r"Lib\Author"),
        ("$b = new Book;\n$b(1)/*|*/;", "float"),
        // First-class callables.
        ("make_book(...)/*|*/;", r"Closure(): Lib\Book"),
        ("first(...)/*|*/;", r"Closure(list<Lib\Book> $books, int ...$rest): Lib\Book"),
        ("(new Book)->withTitle(...)/*|*/;", r"Closure(string $title): Lib\Book"),
        ("Book::create(...)/*|*/;", r"Closure(): Lib\Book"),
        ("$f = make_book(...);\n$f()/*|*/;", r"Lib\Book"),
        ("unknown_function(...)/*|*/;", "Closure"),
        // The pipe operator.
        ("((new Book) |> fn(Book $b) => $b->title)/*|*/;", "string"),
    ]);
}

#[test]
fn no_expression_at_the_caret() {
    assert_eq!(type_at_caret("$a = 1;\n/*|*/\n$b = 2;"), None);
    assert_eq!(type_at_caret("function f() {/*|*/}"), None);
}

#[test]
fn self_referencing_assignments_end() {
    // Each read looks only at earlier assignments, so this terminates.
    check(&[("$x = 1;\n$x = $x;\n$x = [$x];\n$x/*|*/;", "list{int}")]);
}
