//! Tests of the undefined-member inspections.

use super::*;

/// `(id, message)` of each problem.
fn messages(inspected: &Inspected) -> Vec<(&'static str, String)> {
    inspected.problems.iter().map(|p| (p.inspection, p.message.clone())).collect()
}

fn project() -> Project {
    let p = Project::with_files(&[
        // Declared twice (fixtures, polyfills): which one runs isn't known.
        ("src/Twice/One.php", "<?php\nnamespace App\\Model;\nclass Twice { public function one() {} }\n"),
        ("src/Twice/Two.php", "<?php\nnamespace App\\Model;\nclass Twice { public function two() {} }\n"),
        (
            "src/Model/Book.php",
            r#"<?php
namespace App\Model;

interface Titled { const KIND = 'titled'; public function title(): string; }

trait Stamps
{
    public ?string $stamp = null;
    public function stamp(): void { $this->fromUsingClass(); echo self::NOPE; }
}

abstract class Item implements Titled
{
    protected int $id = 0;
    public static int $count = 0;
    public function id(): int { return $this->id; }
    private function secret(): void {}
}

/**
 * @method string magicTitle()
 * @property-read int $pages
 * @mixin Shelf
 */
final class Book extends Item
{
    use Stamps;
    const ISBN_LENGTH = 13;
    public function __construct(public string $isbn) {}
    public function title(): string { return ''; }
}

class Shelf { public string $label = ''; public function place(): void {} }

enum Genre: string { case Fiction = 'f'; }

class Magic
{
    public function __call($name, $args) {}
    public static function __callStatic($name, $args) {}
    public function __get($name) {}
}

class Plain {}

#[\AllowDynamicProperties]
class Loose {}

class Looser extends Loose {}

class Bag extends \stdClass {}

class Partial extends \Vendor\Missing {}
"#,
        ),
    ]);
    // The variable inspections have tests of their own.
    p.engine.set_inspections(super::without_variables());
    p
}

#[test]
fn methods_properties_and_constants() {
    let mut p = project();
    let text = r#"<?php
namespace App;

use App\Model\{Book, Genre, Item, Magic, Plain, Shelf};

function f(Book $b, Item $i, ?Plain $n, Book|Shelf $u, Genre $g)
{
    $b->title();
    $b->id();
    $b->stamp();
    $b->magicTitle();
    $b->place();
    $b->missing();
    $i->title();
    // Defined (private: a matter of access, not of existence).
    $i->secret();
    // Private in the parent: not inherited.
    $b->secret();
    $n?->gone();
    $u->place();
    $u->neither();
    echo $b->isbn, $b->pages, $b->label, $b->stamp, $b->nothing;
    echo Book::ISBN_LENGTH, Book::KIND, Book::LOST, Book::class, Genre::Fiction, Genre::Drama;
    echo $g->value, $g->name, Genre::from('f')->label;
    Genre::cases();
    Book::$count;
    Book::$none;
    Book::make();
    $c = $b->vanish(...);
}
"#;
    let found = p.inspect(text);
    assert_eq!(
        messages(&found),
        [
            ("PhpUndefinedMethod", "Undefined method 'missing' in 'App\\Model\\Book'".to_owned()),
            ("PhpUndefinedMethod", "Undefined method 'secret' in 'App\\Model\\Book'".into()),
            ("PhpUndefinedMethod", "Undefined method 'gone' in 'App\\Model\\Plain'".into()),
            ("PhpUndefinedMethod", "Undefined method 'neither' in 'App\\Model\\Book|App\\Model\\Shelf'".into()),
            ("PhpUndefinedField", "Undefined property '$nothing' in 'App\\Model\\Book'".into()),
            ("PhpUndefinedClassConstant", "Undefined class constant 'LOST' in 'App\\Model\\Book'".into()),
            ("PhpUndefinedClassConstant", "Undefined class constant 'Drama' in 'App\\Model\\Genre'".into()),
            ("PhpUndefinedField", "Undefined property '$label' in 'App\\Model\\Genre'".into()),
            ("PhpUndefinedField", "Undefined property '$none' in 'App\\Model\\Book'".into()),
            ("PhpUndefinedMethod", "Undefined method 'make' in 'App\\Model\\Book'".into()),
            ("PhpUndefinedMethod", "Undefined method 'vanish' in 'App\\Model\\Book'".into()),
        ]
    );
    let missing = found.problems.iter().find(|p| p.message.contains("'missing'")).unwrap();
    let d = missing.to_diagnostic();
    assert_eq!(
        (d.severity, d.code.as_deref(), d.source.as_deref()),
        (Severity::Warning, Some("PhpUndefinedMethod"), Some("php"))
    );
    let line = text.lines().position(|l| l.contains("$b->missing()")).unwrap() as u32;
    let col = text.lines().nth(line as usize).unwrap().find("missing").unwrap() as u32;
    assert_eq!(d.range, Range::new(Pos::new(line, col), Pos::new(line, col + 7)));
}

#[test]
fn magic_and_unknown_receivers_stay_quiet() {
    let mut p = project();
    let found = p.inspect(
        r#"<?php
namespace App;

use App\Model\{Bag, Book, Loose, Looser, Magic, Partial, Plain};

/** @template T */
class Box
{
    /** @var T */
    public $item;

    public function f(mixed $m, object $o, \stdClass $s, Bag $bag, Magic $magic, Partial $partial, Loose $l, Looser $ll, Unknown $u, int $i, \App\Model\Twice $twice)
    {
        $m->anything();
        $o->anything;
        $s->anything;
        $s->anything();
        $bag->anything;
        $magic->anything();
        Magic::anything();
        $magic->anything;
        $partial->anything();
        $l->anything;
        $ll->anything;
        $u->anything();
        $i->anything();
        $twice->one();
        $twice->two();
        $twice->three();
        $this->item->anything();
        $x = json_decode('{}');
        $x->anything;
        $plain = new Plain();
        $plain->later;
        $closure = function () { return $this->bound(); };
        $arrow = fn() => $this->bound;
        return Book::$count;
    }

    public function g(Plain $plain): void
    {
        $plain->later = 1;
        $plain->items[] = 1;
        [$plain->first, 'k' => $plain->second] = [1, 2];
        $plain->lazy ??= 3;
        echo isset($plain->a->b), empty($plain->c), $plain->d ?? 0;
        echo isset($plain->checked) && $plain->checked === false;
        unset($plain->e);
        if (method_exists($plain, 'maybe')) {
            $plain->maybe();
        } else {
            // The older API.
            $plain->older();
        }
        $ffi = \FFI::cdef('size_t page_size(void);');
        $ffi->page_size();
        if (property_exists($plain, 'prop')) {
            echo $plain->prop;
        }
    }

    public function h(Plain $plain): void
    {
        $plain->maybe();
        echo $plain->prop;
    }
}
"#,
    );
    assert_eq!(
        messages(&found),
        [
            ("PhpUndefinedClass", "Undefined class 'Unknown'".to_owned()),
            ("PhpUndefinedMethod", "Undefined method 'maybe' in 'App\\Model\\Plain'".into()),
            ("PhpUndefinedField", "Undefined property '$prop' in 'App\\Model\\Plain'".into()),
        ]
    );
}

#[test]
fn traits_and_relative_receivers() {
    let mut p = project();
    let found = p.inspect(
        r#"<?php
namespace App;

class Base
{
    const A = 1;
    public static function make(): static { return new static(); }
    protected function helper(): void {}
}

class Child extends Base
{
    public function run(): void
    {
        $this->helper();
        self::make();
        static::make()->helper();
        parent::helper();
        echo static::A, self::B, parent::C;
        $this->nope();
        parent::gone();
    }
}

trait Uses
{
    public function t(): void { $this->providedLater(); static::ALSO; self::$too; }
}
"#,
    );
    assert_eq!(
        messages(&found),
        [
            ("PhpUndefinedClassConstant", "Undefined class constant 'B' in 'App\\Child'".to_owned()),
            ("PhpUndefinedClassConstant", "Undefined class constant 'C' in 'App\\Base'".into()),
            ("PhpUndefinedMethod", "Undefined method 'nope' in 'App\\Child'".into()),
            ("PhpUndefinedMethod", "Undefined method 'gone' in 'App\\Base'".into()),
        ]
    );
}

#[test]
fn suppression_and_dumb_mode() {
    let mut p = project();
    let found = p.inspect(
        "<?php\nuse App\\Model\\Plain;\n\nfunction f(Plain $p) {\n    /** @noinspection PhpUndefinedMethodInspection */\n    $p->a();\n    $p->b();\n}\n",
    );
    assert_eq!(messages(&found), [("PhpUndefinedMethod", "Undefined method 'b' in 'App\\Model\\Plain'".to_owned())]);
    p.engine.shutdown();
    let found = p.inspect("<?php\nfunction f(\\App\\Model\\Plain $p) { $p->b(); }\n");
    assert!(found.problems.is_empty(), "{:?}", messages(&found));
}

#[test]
fn polymorphic_code() {
    let mut p = project();
    let found = p.inspect(
        r#"<?php
namespace App;

use App\Model\{Item, Titled};

interface Store { public function get(string $key): mixed; }

final class RedisStore implements Store
{
    public function get(string $key): mixed { return null; }
    public function lock(string $name): void {}
}

function f(Store $store, Item $item, Titled $titled)
{
    $store->lock('x');
    // Book (an indexed file) extends Item, through it implements Titled.
    echo $item->isbn, $titled->isbn, $titled::ISBN_LENGTH;
    $item->magicTitle();
    $store->unlock();
    echo $item->nowhere;
}

final class Holder
{
    public ?Titled $titled = null;

    public function g(\Traversable $t, \ReflectionMethod $m): void
    {
        // Stub subtypes: Iterator, ReflectionNamedType.
        $t->valid();
        $m->getReturnType()->getName();
        // Expressions the flow doesn't narrow.
        if ($this->titled instanceof Store) {
            $this->titled->lock('y');
        }
        if (defined('App\Model\Plain::OPT')) {
            echo \App\Model\Plain::OPT;
        }
        // Still looked up in Store too: the check holds to the end of the
        // function.
        $this->titled->unlock();
        $t->nothingAnywhere();
    }

    public function h(): void
    {
        echo \App\Model\Plain::OPT;
    }

    /** @param class-string<Titled> $class */
    public function k(string $class): void
    {
        if (is_subclass_of($class, Store::class)) {
            $class::get('k');
        }
    }

    /** @param class-string<Titled> $class */
    public function l(string $class): void
    {
        $class::get('k');
    }
}
"#,
    );
    assert_eq!(
        messages(&found),
        [
            ("PhpUndefinedMethod", r"Undefined method 'unlock' in 'App\Store'".to_owned()),
            ("PhpUndefinedField", r"Undefined property '$nowhere' in 'App\Model\Item'".into()),
            ("PhpUndefinedMethod", r"Undefined method 'unlock' in 'App\Model\Titled|App\Store'".into()),
            ("PhpUndefinedMethod", "Undefined method 'nothingAnywhere' in 'Traversable'".into()),
            ("PhpUndefinedClassConstant", r"Undefined class constant 'OPT' in 'App\Model\Plain'".into()),
            ("PhpUndefinedMethod", r"Undefined method 'get' in 'App\Model\Titled'".into()),
        ]
    );
}

/// Fluent chains hundreds of calls long (Symfony's configuration trees)
/// don't exhaust the stack; their first links are still checked.
#[test]
fn long_chains() {
    let mut p = project();
    let chain = "->self()".repeat(400);
    let text = format!(
        "<?php\nnamespace App;\nclass Node {{ public function self(): static {{ return $this; }} }}\nfunction f(Node $n) {{ $n->nope(){chain}->end(); }}\n"
    );
    let found = p.inspect(&text);
    assert_eq!(messages(&found), [("PhpUndefinedMethod", r"Undefined method 'nope' in 'App\Node'".to_owned())]);
}
