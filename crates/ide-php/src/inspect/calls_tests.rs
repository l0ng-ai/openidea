//! Tests of the call and type inspections.

use super::*;

const IDS: [&str; 5] = [
    "PhpMethodParametersCountMismatch",
    "PhpUnknownNamedArgument",
    "PhpParams",
    "PhpIncompatibleReturnType",
    "PhpFieldAssignmentTypeMismatch",
];

/// `(id, severity, quoted text, message)` of each call/type problem.
fn found(inspected: &Inspected, text: &str) -> Vec<(&'static str, Severity, String, String)> {
    inspected
        .problems
        .iter()
        .filter(|p| IDS.contains(&p.inspection))
        .map(|p| (p.inspection, p.severity, text[p.start as usize..p.end as usize].to_owned(), p.message.clone()))
        .collect()
}

fn project(mode: TypeCheckMode) -> Project {
    let p = Project::with_files(&[(
        "src/Model.php",
        r#"<?php
namespace App\Model;

interface Shape {}
class Circle implements Shape {}
final class Square {}
class Plain {}
enum Suit { case Hearts; }
final class Label { public function __toString(): string { return ''; } }

class Box
{
    public function __construct(public int $n) {}
    public function put(int $x): void {}
    public static function make(string $s): static { return new static(1); }
}
"#,
    )]);
    p.engine.set_inspections(Inspections::builtin_with(mode));
    p
}

fn e(id: &'static str, text: &str, message: &str) -> (&'static str, Severity, String, String) {
    (id, Severity::Error, text.to_owned(), message.to_owned())
}

fn w(id: &'static str, text: &str, message: &str) -> (&'static str, Severity, String, String) {
    (id, Severity::Warning, text.to_owned(), message.to_owned())
}

const COUNT: &str = "PhpMethodParametersCountMismatch";
const NAMED: &str = "PhpUnknownNamedArgument";
const PARAMS: &str = "PhpParams";
const RETURN: &str = "PhpIncompatibleReturnType";
const PROPERTY: &str = "PhpFieldAssignmentTypeMismatch";

const COUNTS: &str = r#"<?php
namespace App;

use App\Model\Box;

function two(int $a, string $b) {}
function opt(int $a, int $b = 0) {}
function rest(int $a, int ...$more) {}

function g(Box $box, array $xs)
{
    two(1);
    opt();
    rest();
    rest(1, 2, 3);
    two(1, 'a', 3);
    strlen('a', 'b');
    two(b: 'x');
    two(1, c: 'x');
    two(1, 'b', a: 2);
    rest(1, extra: 2);
    two(...$xs);
    new Box();
    $box->put();
    Box::make();
    $box->nothing(1);
    opt(1, 2);
}
"#;

#[test]
fn argument_counts_and_named_arguments() {
    let mut p = project(TypeCheckMode::Lenient);
    let found = found(&p.inspect(COUNTS), COUNTS);
    assert_eq!(
        found,
        [
            e(COUNT, "(1)", "Expected 2 arguments, found 1"),
            e(COUNT, "()", "Expected at least 1 argument, found 0"),
            e(COUNT, "()", "Expected at least 1 argument, found 0"),
            e(COUNT, "'b'", "Expected 1 argument, found 2"),
            e(COUNT, "(b: 'x')", "Missing argument for parameter '$a'"),
            e(COUNT, "(1, c: 'x')", "Missing argument for parameter '$b'"),
            e(NAMED, "c", "Unknown named argument '$c'"),
            e(NAMED, "a", "Named argument '$a' overwrites a positional argument"),
            e(COUNT, "()", "Expected 1 argument, found 0"),
            e(COUNT, "()", "Expected 1 argument, found 0"),
            e(COUNT, "()", "Expected 1 argument, found 0"),
        ]
    );
}

#[test]
fn strict_mode_also_reports_extra_arguments_to_user_functions() {
    let mut p = project(TypeCheckMode::Strict);
    let found = found(&p.inspect(COUNTS), COUNTS);
    assert!(found.contains(&w(COUNT, "3", "Expected 2 arguments, found 3")), "{found:#?}");
    // Certain ones stay errors.
    assert!(found.contains(&e(COUNT, "'b'", "Expected 1 argument, found 2")), "{found:#?}");
}

const ARGUMENTS: &str = r#"<?php
namespace App;

use App\Model\{Circle, Label, Plain, Shape, Square, Suit};

function int_(int $i) {}
function str(string $s) {}
function arr(array $a) {}
function shape(Shape $s) {}
function circle(Circle $c) {}
function nullable(?int $i) {}
function implicit(int $i = null) {}
function call(callable $c) {}
function iter(iterable $i) {}
/** @param list<int> $ids */
function ids(array $ids) {}
function byref(int &$out) {}

function check(Plain $p, Square $q, ?Circle $mc, Shape $s, int|string $u, mixed $m)
{
    int_('5');
    int_('abc');
    int_([]);
    int_(null);
    int_(1.5);
    str(new Label());
    str($q);
    str($p);
    arr('x');
    shape($p);
    shape($q);
    shape(Suit::Hearts);
    circle($p);
    circle($s);
    circle($mc);
    nullable(null);
    implicit(null);
    call('strlen');
    call(5);
    iter([1]);
    iter($p);
    iter($q);
    ids(['a']);
    strlen(null);
    int_($u);
    int_($m);
    byref($q);
    int_(i: 'abc');
}
"#;

#[test]
fn argument_types_lenient() {
    let mut p = project(TypeCheckMode::Lenient);
    let found = found(&p.inspect(ARGUMENTS), ARGUMENTS);
    assert_eq!(
        found,
        [
            e(PARAMS, "'abc'", "Expected parameter of type 'int', 'string' provided"),
            e(PARAMS, "[]", "Expected parameter of type 'int', 'array' provided"),
            e(PARAMS, "null", "Expected parameter of type 'int', 'null' provided"),
            e(PARAMS, "$q", "Expected parameter of type 'string', 'App\\Model\\Square' provided"),
            e(PARAMS, "'x'", "Expected parameter of type 'array', 'string' provided"),
            e(PARAMS, "$q", "Expected parameter of type 'App\\Model\\Shape', 'App\\Model\\Square' provided"),
            e(PARAMS, "Suit::Hearts", "Expected parameter of type 'App\\Model\\Shape', 'App\\Model\\Suit' provided"),
            e(PARAMS, "$p", "Expected parameter of type 'App\\Model\\Circle', 'App\\Model\\Plain' provided"),
            e(PARAMS, "5", "Expected parameter of type 'callable', 'int' provided"),
            e(PARAMS, "$q", "Expected parameter of type 'iterable', 'App\\Model\\Square' provided"),
            e(PARAMS, "'abc'", "Expected parameter of type 'int', 'string' provided"),
        ]
    );
}

#[test]
fn argument_types_strict() {
    let mut p = project(TypeCheckMode::Strict);
    let found = found(&p.inspect(ARGUMENTS), ARGUMENTS);
    let warnings: Vec<_> = found.iter().filter(|f| f.1 == Severity::Warning).cloned().collect();
    assert_eq!(
        warnings,
        [
            w(PARAMS, "'5'", "Expected parameter of type 'int', 'string' provided"),
            w(PARAMS, "1.5", "Expected parameter of type 'int', 'float' provided"),
            w(PARAMS, "new Label()", "Expected parameter of type 'string', 'App\\Model\\Label' provided"),
            w(PARAMS, "$p", "Expected parameter of type 'string', 'App\\Model\\Plain' provided"),
            w(PARAMS, "$p", "Expected parameter of type 'App\\Model\\Shape', 'App\\Model\\Plain' provided"),
            w(PARAMS, "$s", "Expected parameter of type 'App\\Model\\Circle', 'App\\Model\\Shape' provided"),
            w(PARAMS, "$mc", "Expected parameter of type 'App\\Model\\Circle', '?App\\Model\\Circle' provided"),
            w(PARAMS, "$p", "Expected parameter of type 'iterable', 'App\\Model\\Plain' provided"),
            w(PARAMS, "['a']", "Expected parameter of type 'list<int>', 'list{string}' provided"),
            w(PARAMS, "null", "Expected parameter of type 'string', 'null' provided"),
            w(PARAMS, "$u", "Expected parameter of type 'int', 'int|string' provided"),
        ]
    );
    // The lenient ones are still errors.
    assert_eq!(found.iter().filter(|f| f.1 == Severity::Error).count(), 11, "{found:#?}");
}

#[test]
fn strict_types_turns_off_scalar_juggling() {
    let mut p = project(TypeCheckMode::Lenient);
    let text = r#"<?php
declare(strict_types=1);

namespace App;

function int_(int $i) {}
function flt(float $f) {}

function check()
{
    int_('5');
    flt(1);
    strlen(null);
    int_(true);
    str_repeat('a', '3');
}
"#;
    let found = found(&p.inspect(text), text);
    assert_eq!(
        found,
        [
            e(PARAMS, "'5'", "Expected parameter of type 'int', 'string' provided"),
            e(PARAMS, "null", "Expected parameter of type 'string', 'null' provided"),
            e(PARAMS, "true", "Expected parameter of type 'int', 'bool' provided"),
            e(PARAMS, "'3'", "Expected parameter of type 'int', 'string' provided"),
        ]
    );
}

#[test]
fn return_types() {
    let text = r#"<?php
namespace App;

use App\Model\Plain;

function a(): int { return 'abc'; }
function b(): int { return '5'; }
function c(): ?Plain { return null; }
function d(): Plain { return null; }
function e(): array { return 1; }
function gen(): \Generator { yield 1; return 'x'; }
function v(): void { return; }
function n() { return 1; }
/** @return list<int> */
function f(): array { return ['a']; }

class K
{
    public function me(): static { return $this; }
    public function same(): self { return new K(); }
    public function other(): self { return new Plain(); }
    public function cl(): \Closure { return function (): int { return []; }; }
}

function arrows()
{
    $f = fn (): int => 'x';
    $g = fn (): string => 'x';
}
"#;
    let mut p = project(TypeCheckMode::Lenient);
    let lenient = found(&p.inspect(text), text);
    assert_eq!(
        lenient,
        [
            e(RETURN, "'abc'", "Return value is expected to be 'int', 'string' returned"),
            e(RETURN, "null", "Return value is expected to be 'App\\Model\\Plain', 'null' returned"),
            e(RETURN, "1", "Return value is expected to be 'array', 'int' returned"),
            e(RETURN, "new Plain()", "Return value is expected to be 'App\\K', 'App\\Model\\Plain' returned"),
            e(RETURN, "[]", "Return value is expected to be 'int', 'array' returned"),
            e(RETURN, "'x'", "Return value is expected to be 'int', 'string' returned"),
        ]
    );
    let mut p = project(TypeCheckMode::Strict);
    let strict = found(&p.inspect(text), text);
    let warnings: Vec<_> = strict.into_iter().filter(|f| f.1 == Severity::Warning).collect();
    assert_eq!(
        warnings,
        [
            w(RETURN, "'5'", "Return value is expected to be 'int', 'string' returned"),
            w(RETURN, "['a']", "Return value is expected to be 'list<int>', 'list{string}' returned"),
        ]
    );
}

#[test]
fn property_types() {
    let text = r#"<?php
namespace App;

use App\Model\Plain;

class Holder
{
    public int $n = 0;
    public ?Plain $p = null;
    public static string $s = '';
    public $untyped;
    /** @var list<int> */
    public array $ids = [];
    public self $me;

    public function __construct(public readonly int $promoted = 0) {}

    public function set(): void
    {
        $this->n = 'abc';
        $this->n = '5';
        $this->p = null;
        $this->p = new Holder();
        self::$s = [];
        $this->untyped = 1;
        $this->ids = ['x'];
        $this->me = $this;
        $this->me = new Plain();
        $this->promoted = 'x';
        $this->n += 1;
    }
}

function h(Holder $h, Plain $plain)
{
    $h->n = [];
    $h->missing = 1;
    $plain->dynamic = 'x';
}
"#;
    let mut p = project(TypeCheckMode::Lenient);
    let lenient = found(&p.inspect(text), text);
    assert_eq!(
        lenient,
        [
            e(PROPERTY, "'abc'", "Property '$n' expects 'int', 'string' assigned"),
            e(PROPERTY, "new Holder()", "Property '$p' expects '?App\\Model\\Plain', 'App\\Holder' assigned"),
            e(PROPERTY, "[]", "Property '$s' expects 'string', 'array' assigned"),
            e(PROPERTY, "new Plain()", "Property '$me' expects 'App\\Holder', 'App\\Model\\Plain' assigned"),
            e(PROPERTY, "'x'", "Property '$promoted' expects 'int', 'string' assigned"),
            e(PROPERTY, "[]", "Property '$n' expects 'int', 'array' assigned"),
        ]
    );
    let mut p = project(TypeCheckMode::Strict);
    let strict = found(&p.inspect(text), text);
    let warnings: Vec<_> = strict.into_iter().filter(|f| f.1 == Severity::Warning).collect();
    assert_eq!(
        warnings,
        [
            w(PROPERTY, "'5'", "Property '$n' expects 'int', 'string' assigned"),
            w(PROPERTY, "['x']", "Property '$ids' expects 'list<int>', 'list{string}' assigned"),
        ]
    );
}

#[test]
fn lenient_mode_trusts_only_what_php_checks() {
    let text = r#"<?php
namespace App;

use App\Model\Plain;

class Engine { public function run(int $speed): int { return $speed; } }

/** @mixin Engine */
class Car
{
    /** @var array */
    public $data;
    public array $typed = [];
    public function __call($name, $args) { return $this; }

    public function drive(): void
    {
        $this->run('fast', 'extra');
        if (is_string($this->typed)) {
            strlen($this->typed);
        }
        strlen($this->data);
    }
}

/** @param string $id */
function find($id, Plain $p, \ArrayAccess $bag, array $a)
{
    array_keys($a);
    array_walk($a, fn ($v) => $v);
    strtr('a', ['a' => 'b']);
    intdiv($id, 2);
    intdiv($bag['k'], 2);
    $bag->offsetGet('k', true);
    $sum = [1] + $a;
    intdiv($sum, 2);
}

function compat(Plain $p)
{
    // Version-dependent code calls APIs of several versions.
    if (method_exists($p, 'old')) {
        intdiv('a', 2);
    }
}
"#;
    let mut p = project(TypeCheckMode::Lenient);
    let found = found(&p.inspect(text), text);
    // Only the array union, which is an array for certain.
    assert_eq!(found, [e(PARAMS, "$sum", "Expected parameter of type 'int', 'array' provided")]);
    // Strict mode still sees the documented types.
    let mut p = project(TypeCheckMode::Strict);
    let strict = self::found(&p.inspect(text), text);
    assert!(strict.contains(&w(PARAMS, "$id", "Expected parameter of type 'int', 'string' provided")), "{strict:#?}");
    assert!(strict.contains(&w(COUNT, "true", "Expected 1 argument, found 2")), "{strict:#?}");
}

#[test]
fn registered_and_suppressible() {
    assert!(IDS.iter().all(|id| Inspections::builtin().ids().contains(id)));
    let mut p = project(TypeCheckMode::Lenient);
    let text = r#"<?php
namespace App;

function int_(int $i) {}

function check()
{
    /** @noinspection PhpParamsInspection */
    int_('abc');
    int_();
}
"#;
    let found = found(&p.inspect(text), text);
    assert_eq!(found, [e(COUNT, "()", "Expected 1 argument, found 0")]);
}
