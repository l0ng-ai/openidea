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
pub(super) fn type_at_caret(body: &str) -> Option<String> {
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

/// The flow of the scope around the caret of `body` (after [`HEADER`]) and
/// the state of the variable at the caret (`None` when there is no variable
/// there). Offsets in the flow are relative to `body`.
pub(super) fn flow_at_caret(body: &str) -> (Flow, Option<VarState>, usize) {
    let source = format!("{HEADER}{body}");
    let offset = source.find(CARET).unwrap_or_else(|| panic!("no caret in {body}"));
    let source = source.replacen(CARET, "", 1);
    let file = ParsedFile::parse("main.php", source.as_str());
    assert!(!file.has_errors(), "{body}: {:?}", file.errors());
    let lib = ParsedFile::parse("lib.php", LIB);
    let summary = FileSummary::extract(&file);
    let decls = SummarySet::new(vec![summary.clone(), FileSummary::extract(&lib)]);
    let cache = TypeCache::new();
    let resolver = Resolver::new(&decls, &cache, 1);
    let names = FileNames::resolve(&file);
    let types = ExprTypes::new(&file, &names, &summary, &resolver);
    let (expr, frames) = types.find(offset as u32).expect("an expression at the caret");
    let flow = types.flow(&frames);
    let state = match expr {
        Expression::Variable(Variable::Direct(direct)) => flow.variable_at(direct.span.start.offset).cloned(),
        _ => None,
    };
    (flow, state, HEADER.len())
}

pub(super) fn check(table: &[(&str, &str)]) {
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
        ("new class {}/*|*/;", "class@anonymous"),
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
        // Methods of anonymous classes: their native hints.
        ("$o = new class { public function m(Book $b, int ...$n) { $b/*|*/; } };", r"Lib\Book"),
        ("$o = new class { public function m(Book $b, int ...$n) { $n/*|*/; } };", "list<int>"),
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

/// Declarations for the type operator, alias and mixin fixtures (phase 9.3).
const OPERATORS: &str = r#"
class Opts {
    const MAP = ['a' => 1, 'b' => 2];
    const FLAG_A = 1;
    const FLAG_B = 2;
    const FLAG_C = 4;
    const OTHER = 64;
    /** @return key-of<self::MAP> */
    public function key() {}
    /** @return value-of<self::MAP> */
    public function value() {}
    /** @return int-mask-of<self::FLAG_*> */
    public function flags() {}
    /** @return int-mask<1, 2> */
    public function mask() {}
    /** @return value-of<Suit> */
    public function suit() {}
    /** @return array{id: int, name: string}['name'] */
    public function name() {}
}
/** @template T of array */
class Bag {
    /** @return key-of<T> */
    public function firstKey() {}
    /** @return value-of<T> */
    public function firstValue() {}
    /** @return T['x'] */
    public function x() {}
}
/** @return Bag<array{x: Book, y: Author}> */
function bag() {}
class Repo {
    /** @return ($id is int ? Book : list<Book>) */
    public function find(int|array $id) {}
    /**
     * @template T of int|string
     * @param T $key
     * @return (T is int ? Book : Author)
     */
    public function get(int|string $key) {}
    /** @return ($id is not int ? Author : Book) */
    public function negated(int|string $id) {}
}
/** @return ($many is true ? list<Book> : Book) */
function load(bool $many = false) {}
/** @return ($key is null ? Book : ($key is string ? Author : null)) */
function pick($key = null) {}
/** @return ($many is true ? list<Book> : Book) */
function computed(bool $many = PHP_INT_SIZE > 4) {}
/** @return object{id: int, book?: Book} */
function obj() {}
/**
 * @phpstan-type Row array{id: int, book: Book}
 * @psalm-type Rows = list<Row>
 */
class Table {
    /** @return Row */
    public function row() {}
    /** @return Rows */
    public function rows() {}
    /** @param Row $r */
    public function take(array $r) {}
}
/** @phpstan-import-type Row from Table as TableRow */
class Other {
    /** @var TableRow */
    public $row;
    /** @return TableRow */
    public function row() {}
}
/** @template TModel */
class Query {
    /** @return TModel|null */
    public function first() {}
    /** @return $this */
    public function where() { return $this; }
}
/**
 * @template TRelated
 * @mixin Query<TRelated>
 */
class Relation {}
/** @extends Relation<Author> */
class AuthorRelation extends Relation {}
/** @return Relation<Book> */
function relation() {}
"#;

fn check_operators(table: &[(&str, &str)]) {
    let table: Vec<(String, &str)> =
        table.iter().map(|(body, expected)| (format!("{OPERATORS}{body}"), *expected)).collect();
    let table: Vec<(&str, &str)> = table.iter().map(|(body, expected)| (body.as_str(), *expected)).collect();
    check(&table);
}

#[test]
fn type_operators_are_evaluated_where_their_arguments_are_known() {
    check_operators(&[
        // Class constants, wildcards and enums as arguments (the caret
        // shows literals widened; `resolve::tests` checks the literals).
        ("(new Opts)->key()/*|*/;", "string"),
        ("(new Opts)->value()/*|*/;", "int"),
        ("(new Opts)->flags()/*|*/;", "int"),
        ("(new Opts)->suit()/*|*/;", "string"),
        ("(new Opts)->name()/*|*/;", "string"),
        // Template arguments, once the receiver binds them.
        ("bag()->firstKey()/*|*/;", "string"),
        ("bag()->firstValue()/*|*/;", r"Lib\Book|Lib\Author"),
        ("bag()->x()/*|*/;", r"Lib\Book"),
        // A raw `Bag`: the bound `array`, so the widened types.
        ("(new Bag)->firstKey()/*|*/;", "array-key"),
        ("(new Bag)->firstValue()/*|*/;", "mixed"),
    ]);
}

#[test]
fn conditional_return_types_follow_the_arguments() {
    check_operators(&[
        ("(new Repo)->find(1)/*|*/;", r"Lib\Book"),
        ("(new Repo)->find([1, 2])/*|*/;", r"list<Lib\Book>"),
        ("(new Repo)->find(id: 5)/*|*/;", r"Lib\Book"),
        // Unknown: either branch.
        ("function f($x) { return (new Repo)->find($x)/*|*/; }", r"Lib\Book|list<Lib\Book>"),
        ("(new Repo)->find(...)/*|*/;", r"Closure(int|array $id): (Lib\Book|list<Lib\Book>)"),
        // On a template inferred from the argument.
        ("(new Repo)->get(1)/*|*/;", r"Lib\Book"),
        ("(new Repo)->get('k')/*|*/;", r"Lib\Author"),
        ("(new Repo)->negated('k')/*|*/;", r"Lib\Author"),
        ("(new Repo)->negated(3)/*|*/;", r"Lib\Book"),
        // A function's; a left-out argument is its literal default (Laravel's
        // `request()`, `session()`), else leaves both branches.
        ("load(true)/*|*/;", r"list<Lib\Book>"),
        ("load(false)/*|*/;", r"Lib\Book"),
        ("load()/*|*/;", r"Lib\Book"),
        ("pick()/*|*/;", r"Lib\Book"),
        ("pick('k')/*|*/;", r"Lib\Author"),
        ("computed()/*|*/;", r"list<Lib\Book>|Lib\Book"),
    ]);
}

#[test]
fn object_shapes_type_their_properties() {
    check_operators(&[
        ("obj()/*|*/;", r"object{id: int, book?: Lib\Book}"),
        ("obj()->id/*|*/;", "int"),
        ("obj()->book/*|*/;", r"Lib\Book"),
        ("obj()->missing/*|*/;", "mixed"),
    ]);
}

#[test]
fn type_aliases_expand_in_members() {
    check_operators(&[
        ("(new Table)->row()/*|*/;", r"array{id: int, book: Lib\Book}"),
        ("(new Table)->rows()/*|*/;", r"list<array{id: int, book: Lib\Book}>"),
        ("(new Table)->row()['book']/*|*/;", r"Lib\Book"),
        ("(new Other)->row()/*|*/;", r"array{id: int, book: Lib\Book}"),
        ("(new Other)->row/*|*/;", r"array{id: int, book: Lib\Book}"),
        // A parameter inside the method.
        (
            "/** @phpstan-type Pair array{a: Book} */
class T2 { /** @param Pair $p */ public function m(array $p) { $p/*|*/; } }",
            r"array{a: Lib\Book}",
        ),
    ]);
}

#[test]
fn mixin_arguments_bind_the_mixin_templates() {
    check_operators(&[
        ("relation()->first()/*|*/;", r"?Lib\Book"),
        ("relation()->where()/*|*/;", r"App\Query<Lib\Book>"),
        ("relation()->where()->first()/*|*/;", r"?Lib\Book"),
        // Through `@extends` of the class with the `@mixin`.
        ("(new AuthorRelation)->first()/*|*/;", r"?Lib\Author"),
        // Raw: the template's fallback.
        ("(new Relation)->first()/*|*/;", "mixed"),
    ]);
}

/// A generic identity closure, documented in front of its statement.
const IDENTITY: &str = "/**
 * @template T
 * @param T $x
 * @return T
 */
$id = function ($x) { return $x; };
";

/// A function taking a callable and its argument.
const APPLY: &str = r"/**
 * @template A
 * @template B
 * @param \Closure(A): B $f
 * @param A $a
 * @return B
 */
function apply(\Closure $f, $a) { return $f($a); }
";

#[test]
fn closure_templates_bind_where_it_is_called() {
    let call = |body: &str| format!("{IDENTITY}{body}");
    check(&[
        (call("$id/*|*/;").as_str(), "Closure(T $x): T"),
        (call("$id(1)/*|*/;").as_str(), "int"),
        (call("$id(new Book)/*|*/;").as_str(), r"Lib\Book"),
        (call("$id(x: 'a')/*|*/;").as_str(), "string"),
        // Inside, the parameter is the template.
        ("/**\n * @template T\n * @param T $x\n */\n$f = function ($x) { return $x/*|*/; };", "T"),
        // Directly in front of an arrow function, with a generic return.
        (
            "$wrap = /**\n * @template T\n * @param T $x\n * @return list<T>\n */\nfn ($x) => [$x];\n$wrap(new Book)/*|*/;",
            r"list<Lib\Book>",
        ),
        // In front of `return fn …`.
        ("function maker() {\n/**\n * @template T\n * @param T $x\n */\nreturn fn ($x) => $x/*|*/;\n}", "T"),
        // Through the pipe operator.
        (call("$r = new Book |> $id;\n$r/*|*/;").as_str(), r"Lib\Book"),
        // A docblock without templates still types the closure.
        ("$f = /** @return Book */ function () { return untyped(); };\n$f()/*|*/;", r"Lib\Book"),
    ]);
}

#[test]
fn closure_templates_bind_where_it_is_passed() {
    let body = |body: &str| format!("{APPLY}{IDENTITY}{body}");
    check(&[
        (body("apply($id, new Book)/*|*/;").as_str(), r"Lib\Book"),
        (body("apply($id, 3)/*|*/;").as_str(), "int"),
        (
            body(
                "apply(/**\n * @template T\n * @param T $x\n * @return list<T>\n */\nfn ($x) => [$x], new Book)/*|*/;",
            )
            .as_str(),
            r"list<Lib\Book>",
        ),
        // A plain closure as before.
        (body("apply(fn (int $x): string => 'a', 3)/*|*/;").as_str(), "string"),
    ]);
}

#[test]
fn type_aliases_in_inline_var_tags() {
    check_operators(&[
        (
            "/** @phpstan-type Row array{id: int, book: Book} */
class T3 { public function m($x) {
    /** @var Row $row */
    $row = $x;
    $row/*|*/;
} }",
            r"array{id: int, book: Lib\Book}",
        ),
        // Without a name, on an assignment; an element of it.
        (
            "/** @psalm-type Row = array{id: int, book: Book} */
class T4 { public function m($x) {
    /** @var Row */
    $row = $x;
    $row['book']/*|*/;
} }",
            r"Lib\Book",
        ),
        // On `foreach`, through an imported alias.
        (
            "/** @phpstan-import-type Row from Table */
class T5 { public function m(array $rows) {
    /** @var Row $r */
    foreach ($rows as $r) { $r['id']/*|*/; }
} }",
            "int",
        ),
        // Outside the class, the name is a class again.
        (
            "/** @phpstan-type Row array{id: int} */
class T6 {}
/** @var Row $row */
$row = untyped();
$row/*|*/;",
            r"App\Row",
        ),
    ]);
}

/// Laravel's relations and Eloquent builder forward calls to their query
/// and return themselves: `whereNull()` and `with()` on a relation are the
/// relation, through both mixins; `toBase()` returns another object, and
/// `first()` the model.
#[test]
fn laravel_relations_return_themselves_from_forwarded_calls() {
    const LARAVEL: &str = r#"<?php
namespace Illuminate\Database\Query {
    class Builder
    {
        /** @return $this */
        public function whereNull($column) {}
    }
}
namespace Illuminate\Database\Eloquent {
    /**
     * @template TModel
     * @mixin \Illuminate\Database\Query\Builder
     */
    class Builder
    {
        /** @return $this */
        public function with($relations) {}
        /** @return \Illuminate\Database\Query\Builder */
        public function toBase() {}
        /** @return TModel|null */
        public function first() {}
    }
}
namespace Illuminate\Database\Eloquent\Relations {
    /**
     * @template TRelated
     * @mixin \Illuminate\Database\Eloquent\Builder<TRelated>
     */
    abstract class Relation {}
    /**
     * @template TRelated
     * @extends Relation<TRelated>
     */
    class HasMany extends Relation {}
}
namespace App {
    class Comment {}
    /** @return \Illuminate\Database\Eloquent\Relations\HasMany<Comment> */
    function comments() {}
}
"#;
    let type_of = |body: &str| -> Option<String> {
        let source = format!("<?php\nnamespace App;\n{body}");
        let offset = source.find(CARET).unwrap();
        let source = source.replacen(CARET, "", 1);
        let file = ParsedFile::parse("main.php", source.as_str());
        let lib = ParsedFile::parse("laravel.php", LARAVEL);
        assert!(!lib.has_errors(), "{:?}", lib.errors());
        let decls = SummarySet::new(vec![FileSummary::extract(&file), FileSummary::extract(&lib)]);
        let cache = TypeCache::new();
        let resolver = Resolver::new(&decls, &cache, 1);
        type_at(&file, &resolver, offset as u32).map(|ty| ty.to_string())
    };
    let relation = r"Illuminate\Database\Eloquent\Relations\HasMany<App\Comment>";
    let table = [
        ("comments()->whereNull('x')/*|*/;", relation),
        ("comments()->with('post')/*|*/;", relation),
        ("comments()->whereNull('x')->with('post')/*|*/;", relation),
        ("comments()->toBase()/*|*/;", r"Illuminate\Database\Query\Builder"),
        ("comments()->whereNull('x')->first()/*|*/;", r"?App\Comment"),
        // The Eloquent builder: itself from the query builder's methods.
        (
            "(new \\Illuminate\\Database\\Eloquent\\Builder)->whereNull('x')/*|*/;",
            r"Illuminate\Database\Eloquent\Builder",
        ),
    ];
    let failures: Vec<String> = table
        .iter()
        .filter_map(|(body, expected)| {
            let actual = type_of(body);
            (actual.as_deref() != Some(*expected))
                .then(|| format!("{body}\n    expected {expected}\n    got      {actual:?}"))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
