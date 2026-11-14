//! Tests of the unused code inspections.

use super::*;

fn messages(inspected: &Inspected) -> Vec<(&'static str, String)> {
    inspected.problems.iter().map(|p| (p.inspection, p.message.clone())).collect()
}

fn project() -> Project {
    let p = Project::with_files(&[
        (
            "src/Model/Book.php",
            "<?php\nnamespace App\\Model;\n\nclass Book {}\nclass Genre {}\nclass Author {}\nfunction helper() {}\nconst LIMIT = 1;\n",
        ),
        (
            "src/Base.php",
            "<?php\nnamespace App;\n\ninterface Handler { public function handle(string $event, array $data): void; }\nabstract class Base {\n    abstract protected function render(array $vars): string;\n    public function hook(int $n): void {}\n}\nclass Child extends Base {\n    protected function render(array $vars): string { return ''; }\n    public function hook(int $n): void { echo $n; }\n}\n",
        ),
    ]);
    p.engine.set_inspections(Inspections::new(vec![
        Arc::new(unused::UnusedImport),
        Arc::new(unused::UnusedPrivateMethod),
        Arc::new(unused::UnusedPrivateField),
        Arc::new(unused::UnusedPrivateConstant),
        Arc::new(unused::UnusedParameter),
    ]));
    p
}

#[test]
fn unused_imports_with_their_fixes() {
    let mut p = project();
    let text = r#"<?php
namespace App;

use App\Model\Book;
use App\Model\Genre;
use App\Model\Book;
use App\Model\{Author, Genre as Kind};
use function App\Model\helper;
use const App\Model\LIMIT;
use App\Model as M;

/** @param Kind $k */
function f(Book $b, $k): void
{
    echo $b, $k, LIMIT, new M\Author();
}
"#;
    let found = p.inspect(text);
    assert_eq!(
        messages(&found),
        [
            ("PhpUnusedAlias", "Unused import class 'App\\Model\\Genre'".to_owned()),
            ("PhpUnusedAlias", "Unused import class 'App\\Model\\Book'".to_owned()),
            ("PhpUnusedAlias", "Unused import class 'App\\Model\\Author'".to_owned()),
            ("PhpUnusedAlias", "Unused import function 'App\\Model\\helper'".to_owned()),
        ]
    );
    assert!(found.problems.iter().all(|p| p.unnecessary && p.severity == Severity::Warning));
    let genre = &found.problems[0];
    let line = text.lines().position(|l| l == "use App\\Model\\Genre;").unwrap() as u32;
    assert_eq!(genre.range, Range::new(Pos::new(line, 4), Pos::new(line, 19)));
    let fix = &genre.fixes[0];
    assert_eq!((fix.title.as_str(), fix.preferred), ("Remove unused import", true));
    assert!(!applied(text, &fix.edit).contains("Genre;"));
    assert!(applied(text, &fix.edit).contains("use App\\Model\\Book;\nuse App\\Model\\Book;\n"));
    // A group item goes with its comma.
    let author = applied(text, &found.problems[2].fixes[0].edit);
    assert!(author.contains("use App\\Model\\{Genre as Kind};"), "{author}");
    // `@noinspection` and the suppress fix come from the framework.
    let suppressed = p.inspect("<?php\nnamespace App;\n\n/** @noinspection PhpUnusedAlias */\nuse App\\Model\\Book;\n");
    assert!(suppressed.problems.is_empty(), "{:?}", messages(&suppressed));
}

#[test]
fn global_and_braced_namespaces() {
    let mut p = project();
    let found = p.inspect(
        "<?php\nnamespace A {\n    use App\\Model\\Book;\n    new Book();\n}\nnamespace B {\n    use App\\Model\\Book;\n}\n",
    );
    assert_eq!(messages(&found), [("PhpUnusedAlias", "Unused import class 'App\\Model\\Book'".to_owned())]);
    assert_eq!(found.problems[0].range.start.line, 6);
    let found = p.inspect("<?php\nuse App\\Model\\Book;\n\necho 1;\n");
    assert_eq!(found.problems.len(), 1);
    // A broken file isn't checked.
    let found = p.inspect("<?php\nuse App\\Model\\Book;\n\nfunction (\n");
    assert!(found.problems.iter().all(|p| p.inspection != "PhpUnusedAlias"));
}

#[test]
fn unused_private_members() {
    let mut p = project();
    let text = r#"<?php
namespace App;

class Shop
{
    private const USED = 1;
    private const IN_DOC = 2;
    private const UNUSED = 3;
    public const PUBLIC = 4;
    private int $used = 0;
    private static array $cache = [];
    private string $unused = '';
    private string $interpolated = '';
    protected string $kept = '';

    public function __construct(private string $promoted) {}

    /** @return int<0, self::IN_DOC> */
    public function run(self $other): int
    {
        $this->helper();
        $cb = [$this, 'callback'];
        $first = self::make(...);
        return $this->used + $other->used + self::USED + count(self::$cache) + strlen("{$this->interpolated}");
    }

    private function helper(): void {}
    private function callback(): void {}
    private static function make(): void {}
    private function unused(): void {}
    private function recursive(): void { $this->recursive(); }
    private function __clone() {}
    #[Route('/x')]
    private function attributed(): void {}
    /** @see Shop::fromDoc() */
    public function documented(): void {}
    private function fromDoc(): void {}
}

enum Suit
{
    case Hearts;
    private const LABEL = 'x';
}
"#;
    let found = p.inspect(text);
    assert_eq!(
        messages(&found),
        [
            ("PhpUnusedPrivateConstant", "Unused private constant 'UNUSED'".to_owned()),
            ("PhpUnusedPrivateField", "Unused private property '$unused'".to_owned()),
            ("PhpUnusedPrivateMethod", "Unused private method 'unused'".to_owned()),
            ("PhpUnusedPrivateConstant", "Unused private constant 'LABEL'".to_owned()),
        ]
    );
    let unused = &found.problems[1];
    assert!(unused.unnecessary);
    assert_eq!(&text[unused.start as usize..unused.end as usize], "$unused");
}

#[test]
fn private_members_reached_dynamically_or_from_elsewhere() {
    let mut p = project();
    let found = p.inspect(
        r#"<?php
namespace App;

trait Greets { public function greet() { return $this->name(); } }

class WithTrait
{
    use Greets;
    private function name(): string { return 'x'; }
}

class Dynamic
{
    private $a;
    private function b() {}
    public function get(string $p, string $m) { return $this->$p ?? $this->$m(); }
}

class Exported
{
    private $a;
    public function toArray(): array { return get_object_vars($this); }
}

class Annotated
{
    /** @ORM\Column(type="string") */
    private $column;
    #[Column]
    private $attributed;
}

class Bound
{
    private $secret;
}

trait Helpers
{
    private function unusedInTrait() {}
}

$peek = function () { return $this->secret; };
$peek->call(new Bound());
"#,
    );
    assert!(found.problems.is_empty(), "{:?}", messages(&found));
}

#[test]
fn unused_parameters() {
    let mut p = project();
    let text = r#"<?php
namespace App;

function f(int $used, int $unused, &$out, $_, ...$rest): int
{
    $out = 1;
    return $used;
}

function g($a, $b) { return func_get_args(); }

function h($a, $b) { return array_map(fn ($x) => $x + $a, [1]); }

function i($a) { return function () use ($a) { return 1; }; }

function j($a) { $$a = 1; }

class Impl implements Handler
{
    public function __construct(private int $promoted, int $plain) {}

    public function handle(string $event, array $data): void {}

    public function own(int $x, int $y): int { return $y; }

    public function __call($name, $arguments) {}

    #[Override]
    public function attributed(int $z): void {}

    private function hidden(int $w): void {}

    public function callbacks(): void
    {
        array_map(function ($ignored) { return 1; }, []);
        array_map(fn ($also) => 1, []);
    }
}

class Leaf extends Child
{
    protected function render(array $vars): string { return ''; }
    public function fresh(int $v): void {}
}

class Open
{
    public function overridden(int $o): void {}
}

class Closed extends Open
{
    public function overridden(int $o): void { echo $o; }
}

interface Contract { public function sign(int $s): void; }

trait T { public function t(int $t): void {} }

abstract class Abs { abstract public function a(int $a): void; }

class Unknown extends \Missing\Base
{
    public function u(int $u): void {}
}
"#;
    let found = p.inspect(text);
    let unused = |name: &str| ("PhpUnusedParameter", format!("Unused parameter '${name}'"));
    assert_eq!(
        messages(&found),
        [unused("unused"), unused("rest"), unused("b"), unused("plain"), unused("x"), unused("w"), unused("v")]
    );
    let first = &found.problems[0];
    assert!(first.unnecessary);
    assert_eq!(&text[first.start as usize..first.end as usize], "$unused");
}

#[test]
fn registered_and_quiet_on_the_fixture_shapes() {
    let ids = Inspections::builtin().ids();
    for id in [
        "PhpUnusedAlias",
        "PhpUnusedPrivateMethod",
        "PhpUnusedPrivateField",
        "PhpUnusedPrivateConstant",
        "PhpUnusedParameter",
    ] {
        assert!(ids.contains(&id), "{id}");
    }
    let mut p = project();
    let found = p.inspect(
        "<?php\nnamespace App;\n\n/** @noinspection PhpUnusedParameterInspection */\nfunction f($a) {}\n\nfunction g($b) {}\n",
    );
    assert_eq!(messages(&found), [("PhpUnusedParameter", "Unused parameter '$b'".to_owned())]);
}
