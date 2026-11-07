use std::path::{Path, PathBuf};

use super::*;
use crate::names::RelativeClass;

fn summarize(source: &str) -> FileSummary {
    let file = ParsedFile::parse("summary.php", source);
    assert!(!file.has_errors(), "{:?}", file.errors());
    FileSummary::extract(&file)
}

fn render(source: &str) -> String {
    summarize(source).render()
}

/// The rendering without locations and lazy types, for compact
/// expectations.
fn shape(source: &str) -> Vec<String> {
    shape_with_lazy(source).into_iter().filter(|line| !line.trim_start().starts_with('~')).collect()
}

/// The rendering without locations.
fn shape_with_lazy(source: &str) -> Vec<String> {
    render(source)
        .lines()
        .map(|line| {
            let mut line = line;
            // Drop the trailing `[l:c-l:c]` and `@l:c-l:c` location words.
            while let Some((rest, last)) = line.rsplit_once(' ')
                && is_location(last)
            {
                line = rest;
            }
            line.to_owned()
        })
        .collect()
}

fn is_location(word: &str) -> bool {
    let inner = word.strip_prefix('@').or_else(|| word.strip_prefix('[').and_then(|w| w.strip_suffix(']')));
    inner.is_some_and(|inner| !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit() || c == ':' || c == '-'))
}

#[test]
fn class_like_kinds_and_inheritance() {
    let source = "<?php\nnamespace App;\nuse Lib\\{Base, Contract as C};\n\nabstract class A extends Base implements C, \\Countable {}\nfinal readonly class B {}\ninterface I extends C, Other {}\ntrait T {}\nenum E: string implements C { case X = 'x'; case Y = 'y' . 'z'; }\nenum U { case One; }\n";
    assert_eq!(
        shape(source),
        [
            "class App\\A abstract",
            "  extends Lib\\Base",
            "  implements Lib\\Contract, Countable",
            "class App\\B final readonly",
            "interface App\\I",
            "  extends Lib\\Contract, App\\Other",
            "trait App\\T",
            "enum App\\E final: string",
            "  implements Lib\\Contract",
            "  case X = 'x'",
            "  case Y = 'y' . 'z'",
            "enum App\\U final",
            "  case One",
        ]
    );
}

#[test]
fn methods_and_parameters() {
    let source = "<?php\nnamespace App;\nuse Lib\\Thing;\n\nabstract class A {\n    public function __construct(private readonly Thing $thing, protected int $n = 1, public private(set) ?string $s = null, $plain = [1, 2]) {}\n    abstract protected function f(int &$a, string ...$rest): ?Thing;\n    final public static function &g(self $x, (Thing&\\Countable)|null $y, int|string|null $z): static {}\n    private function h(): void {}\n    function implicit() {}\n}\ninterface I { public function i(): iterable; public static function s(): never; }\n";
    assert_eq!(
        shape(source),
        [
            "class App\\A abstract",
            "  property private readonly promoted Lib\\Thing $thing",
            "  property protected promoted int $n",
            "  property public private(set) promoted ?string $s",
            "  method public __construct(private readonly Lib\\Thing $thing, protected int $n = 1, public private(set) ?string $s = null, $plain = [1, 2])",
            "  method protected abstract f(int &$a, string ...$rest): ?Lib\\Thing",
            "  method public static final &g(self $x, (Lib\\Thing&Countable)|null $y, int|string|null $z): static",
            "  method private h(): void",
            "  method public implicit()",
            "interface App\\I",
            "  method public abstract i(): iterable",
            "  method public static abstract s(): never",
        ]
    );
    let summary = summarize(source);
    let class = summary.class_like("\\app\\a").expect("A");
    let g = class.method("G").expect("g");
    assert!(g.by_ref_return);
    assert_eq!(g.params[0].type_hint, Some(TypeHint::Relative(RelativeClass::Self_)));
    assert_eq!(
        g.params[1].type_hint,
        Some(TypeHint::Union(vec![
            TypeHint::Intersection(vec![TypeHint::Named("Lib\\Thing".into()), TypeHint::Named("Countable".into())]),
            TypeHint::Builtin("null".into()),
        ]))
    );
    assert_eq!(g.return_type, Some(TypeHint::Relative(RelativeClass::Static)));
    let thing = class.property("$thing").expect("promoted");
    assert!(thing.is_promoted && thing.is_readonly && thing.visibility == Visibility::Private);
    // A promoted property points at its parameter.
    assert_eq!(&source[thing.name_loc.start as usize..thing.name_loc.end as usize], "$thing");
    assert!(class.property("plain").is_none());
}

#[test]
fn properties_and_constants() {
    let source = "<?php\nnamespace App;\n\nreadonly class R { public int $a; }\nclass P {\n    public const A = 1, B = self::A + 1;\n    final protected const string C = 'c';\n    private const D = [];\n    const E = 2;\n    public static ?P $instance = null;\n    var $legacy;\n    protected int $x = 1, $y;\n    public string $hooked { get => 'h'; }\n    public readonly array $list;\n}\n";
    assert_eq!(
        shape(source),
        [
            "class App\\R readonly",
            "  property public readonly int $a",
            "class App\\P",
            "  const public A = 1",
            "  const public B = self::A + 1",
            "  const protected final string C = 'c'",
            "  const private D = []",
            "  const public E = 2",
            "  property public static ?App\\P $instance = null",
            "  property public $legacy",
            "  property protected int $x = 1",
            "  property protected int $y",
            "  property public hooked string $hooked",
            "  property public readonly array $list",
        ]
    );
}

#[test]
fn trait_uses_with_insteadof_and_as() {
    let source = "<?php\nnamespace App;\nuse Lib\\Loud;\n\nclass C {\n    use Loud, Quiet {\n        Loud::speak insteadof Quiet;\n        Quiet::speak as protected whisper;\n        shout as private;\n        Loud::speak as yell;\n    }\n    use \\Lib\\Other;\n}\n";
    assert_eq!(
        shape(source),
        [
            "class App\\C",
            "  use Lib\\Loud, App\\Quiet",
            "    Lib\\Loud::speak insteadof App\\Quiet",
            "    App\\Quiet::speak as protected whisper",
            "    shout as private",
            "    Lib\\Loud::speak as yell",
            "  use Lib\\Other",
        ]
    );
    let summary = summarize(source);
    let rules = &summary.class_likes[0].trait_uses[0].rules;
    assert_eq!(
        rules[2],
        TraitRule::Alias {
            trait_name: None,
            method: "shout".into(),
            visibility: Some(Visibility::Private),
            alias: None
        }
    );
}

#[test]
fn functions_and_constants() {
    let source = "<?php\nnamespace App\\Util;\n\nconst A = 1, B = A * 2;\ndefine('GLOBAL_ONE', true);\n\\define(\"App\\\\NS_TWO\", 2);\nDEFINE('UPPER', 3);\ndefine($dynamic, 4);\nfunction slug(string $s, int ...$n): string { return $s; }\nfunction &ref(array &$a) { return $a; }\nif (!function_exists('App\\Util\\maybe')) {\n    function maybe(): void {}\n    define('GUARDED', 1);\n}\n$f = function () {};\n$c = new class { public function anon() {} };\n";
    assert_eq!(
        shape(source),
        [
            "function App\\Util\\slug(string $s, int ...$n): string",
            "function &App\\Util\\ref(array &$a)",
            "function App\\Util\\maybe(): void",
            "const App\\Util\\A = 1",
            "const App\\Util\\B = A * 2",
            "define GLOBAL_ONE = true",
            "define App\\NS_TWO = 2",
            "define UPPER = 3",
            "define GUARDED = 1",
        ]
    );
    let summary = summarize(source);
    let global = &summary.constants[2];
    assert_eq!(global.kind, ConstantKind::Define);
    assert_eq!(&source[global.name_loc.start as usize..global.name_loc.end as usize], "GLOBAL_ONE");
    assert!(summary.function("app\\util\\SLUG").is_some());
}

#[test]
fn attributes_are_resolved_names() {
    let source = "<?php\nnamespace App;\nuse Attr\\Route;\n\n#[Route('/'), \\Attribute]\n#[Local]\nfinal class C {\n    #[Route] public const X = 1;\n    #[Inject] private int $p;\n    #[Route('/m')] public function m(#[\\SensitiveParameter] string $secret) {}\n}\nenum E { #[Route] case A; }\n#[Pure] function f() {}\n";
    assert_eq!(
        shape(source),
        [
            "#[Attr\\Route, Attribute, App\\Local]",
            "class App\\C final",
            "  #[Attr\\Route]",
            "  const public X = 1",
            "  #[App\\Inject]",
            "  property private int $p",
            "  #[Attr\\Route]",
            "  method public m(#[SensitiveParameter] string $secret)",
            "enum App\\E final",
            "  #[Attr\\Route]",
            "  case A",
            "#[App\\Pure]",
            "function App\\f()",
        ]
    );
}

#[test]
fn several_namespaces_and_braced_blocks() {
    let source = "<?php\nnamespace A {\n    use X\\Base;\n    class One extends Base {}\n}\nnamespace {\n    class Two extends Base {}\n    function top() {}\n}\n";
    assert_eq!(shape(source), ["class A\\One", "  extends X\\Base", "class Two", "  extends Base", "function top()"]);
    let source =
        "<?php\nnamespace A;\nuse X\\Base;\nclass One extends Base {}\nnamespace B;\nclass Two extends Base {}\n";
    assert_eq!(shape(source), ["class A\\One", "  extends X\\Base", "class B\\Two", "  extends B\\Base"]);
}

#[test]
fn locations_are_utf16_ranges_and_byte_offsets() {
    let source = "<?php\n$s = '😀'; class Émoji {\n    public function ünïcode(): void {}\n}\n";
    let summary = summarize(source);
    let class = &summary.class_likes[0];
    assert_eq!(&source[class.name_loc.start as usize..class.name_loc.end as usize], "Émoji");
    let col = "$s = '😀'; class ".encode_utf16().count() as u32;
    assert_eq!(class.name_loc.range.start, ide_core::Pos::new(1, col));
    assert_eq!(class.name_loc.range.end, ide_core::Pos::new(1, col + 5));
    assert_eq!(
        &source[class.loc.start as usize..class.loc.end as usize],
        &source[source.find("class").unwrap()..source.len() - 1]
    );
    let method = &class.methods[0];
    assert_eq!(method.name, "ünïcode");
    assert_eq!(method.name_loc.range.start, ide_core::Pos::new(2, 20));
    assert_eq!(method.loc.range.start, ide_core::Pos::new(2, 4));
}

#[test]
fn postcard_round_trip_and_schema_check() {
    let source = "<?php\nnamespace App;\n#[A] final class C extends B { use T { T::a as b; } public const X = 1; public function __construct(private int $p = 2) {} }\nenum E: int { case One = 1; }\nfunction f(?C $c): C|false {}\nconst K = 'k';\ndefine('D', 1);\n";
    let summary = summarize(source);
    let bytes = summary.to_bytes();
    assert_eq!(FileSummary::from_bytes(&bytes), Ok(summary.clone()));

    // The schema version comes first and is checked before anything else.
    let mut stale = summary.clone();
    stale.schema = SCHEMA_VERSION + 1;
    assert_eq!(FileSummary::from_bytes(&stale.to_bytes()), Err(DecodeError::Schema { found: SCHEMA_VERSION + 1 }));
    assert!(matches!(FileSummary::from_bytes(&[]), Err(DecodeError::Corrupt(_))));
    assert!(matches!(FileSummary::from_bytes(&bytes[..bytes.len() / 2]), Err(DecodeError::Corrupt(_))));
}

#[test]
fn broken_files_keep_what_parses() {
    let file = ParsedFile::parse(
        "typing.php",
        "<?php\nnamespace App;\nclass Done { public function a(): int {} }\nclass Typing {\n    public function b(): string {}\n    public function c(",
    );
    let summary = FileSummary::extract(&file);
    assert!(summary.has_errors);
    assert!(summary.render().starts_with("! has errors\n"));
    assert!(summary.class_like("App\\Done").is_some_and(|class| class.method("a").is_some()));
    assert!(summary.class_like("App\\Typing").is_some_and(|class| class.method("b").is_some()));
}

#[test]
fn never_panics_on_any_prefix() {
    let text = "<?php\nnamespace A;\nuse X\\{Y, function z};\n#[Y] abstract class C extends Y implements Z { use T { T::a insteadof U; a as protected b; } public const int K = 1; public function __construct(private readonly ?Y $y = null, int ...$r) {} abstract protected static function &f(): static; }\nenum E: string { case A = 'a'; }\ndefine('D', 1);\nconst Q = 2;\n";
    for end in (0..=text.len()).filter(|&end| text.is_char_boundary(end)) {
        let file = ParsedFile::parse("p.php", &text[..end]);
        let summary = FileSummary::extract(&file);
        let bytes = summary.to_bytes();
        assert_eq!(FileSummary::from_bytes(&bytes).as_ref(), Ok(&summary));
        for class in &summary.class_likes {
            assert!(class.name_loc.end as usize <= end && class.loc.start <= class.name_loc.start);
        }
    }
}

#[test]
fn phpdoc_core_tags_with_resolved_class_names() {
    let source = r#"<?php
namespace App;
use Lib\{Thing, Other as O};

/**
 * Builds things.
 * @deprecated use Factory instead
 */
final class Maker {
    /** @var array<string, Thing> */
    private array $cache = [];
    /** @var int $a the first */
    public $a, $b;
    /** @var list<O> */
    const LIST = [];

    /**
     * @param Thing|null $thing
     * @param \Closure(Thing): O $make
     * @param int ...$rest
     * @param string &$out
     * @return array{thing: Thing, other?: O, 0: \Countable, O::KEY: int}
     * @throws \RuntimeException
     * @throws Error when it breaks
     */
    public function make($thing, $make, &$out, ...$rest) {}

    /**
     * @param int|string $id
     */
    public function __construct(private $id, /** @var non-empty-string */ public $name = 'n') {}
}

/** @return static|self|$this|class-string<Thing>|key-of<O::MAP>|callable-string|resource|Generator<int, Thing, mixed, void> */
function f() {}

/** @var Thing */
const K = 1;
/** @deprecated */
define('D', 2);
"#;
    assert_eq!(
        shape(source),
        [
            "class App\\Maker final",
            "  @deprecated use Factory instead",
            "  const public LIST = []",
            "    @var list<\\Lib\\Other>",
            "  property private array $cache = []",
            "    @var array<string, \\Lib\\Thing>",
            "  property public $a",
            "    @var int $a",
            "  property public $b",
            "    @var int $a",
            "  property private promoted $id",
            "    @var int|string",
            "  property public promoted $name",
            "    @var non-empty-string",
            "  method public make($thing, $make, &$out, ...$rest)",
            "    @param \\Lib\\Thing|null $thing",
            "    @param \\Closure(\\Lib\\Thing): \\Lib\\Other $make",
            "    @param int ...$rest",
            "    @param string &$out",
            "    @return array{thing: \\Lib\\Thing, other?: \\Lib\\Other, 0: \\Countable, \\Lib\\Other::KEY: int}",
            "    @throws \\RuntimeException",
            "    @throws \\App\\Error",
            "  method public __construct(private $id, public $name = 'n')",
            "    @param int|string $id",
            "function App\\f()",
            "  @return static|self|$this|class-string<\\Lib\\Thing>|key-of<\\Lib\\Other::MAP>|callable-string|resource|\\App\\Generator<int, \\Lib\\Thing, mixed, void>",
            "const App\\K = 1",
            "  @var \\Lib\\Thing",
            "define D = 2",
            "  @deprecated ",
        ]
    );
    let summary = summarize(source);
    let class = summary.class_like("App\\Maker").expect("Maker");
    // `@var $a` names one item; `$b` falls back to nothing named `b`.
    let b = class.property("b").and_then(|property| property.doc.as_ref()).expect("doc");
    assert_eq!(b.var_type("b"), None);
    assert_eq!(b.var_type("a"), Some(&DocType("int".into())));
    assert_eq!(summary.constants[1].doc.as_ref().and_then(|doc| doc.deprecated.as_deref()), Some(""));
}

#[test]
fn phpdoc_class_tags_templates_and_magic_members() {
    let source = r#"<?php
namespace App;
use Lib\{Model, Builder};

/**
 * @template-covariant TKey of array-key
 * @template TValue of Model = Model
 * @template-contravariant TIn
 * @extends Base<TKey, TValue>
 * @implements \IteratorAggregate<TKey, TValue>
 * @implements Contract<TValue>
 * @use HasItems<TValue>
 * @mixin Builder<TValue>
 * @property int $count
 * @property-read Model|null $first
 * @property-write string $name
 * @property $untyped
 * @method static Builder<TValue> query()
 * @method TValue find(int|string $id, bool &$found = false, Model ...$rest)
 * @method Items<TKey, U> map<U of Model>(callable(TValue): U $fn) a template method
 * @method void
 */
abstract class Items extends Base implements \IteratorAggregate, Contract {
    use HasItems;

    /**
     * @template U
     * @param callable(TValue): U $fn
     * @return Items<TKey, U>
     */
    abstract public function map(callable $fn): self;

    /** @return TKey|TIn|T */
    abstract public function key(): mixed;
}

/**
 * @template T of object
 * @param class-string<T> $class
 * @return T
 */
function make(string $class): object {}
"#;
    let shape = shape(source);
    let expected = [
        "class App\\Items abstract",
        "  @template-covariant TKey of array-key",
        "  @template TValue of \\Lib\\Model = \\Lib\\Model",
        "  @template-contravariant TIn",
        "  @extends \\App\\Base<TKey, TValue>",
        "  @implements \\IteratorAggregate<TKey, TValue>",
        "  @implements \\App\\Contract<TValue>",
        "  @use \\App\\HasItems<TValue>",
        "  @mixin \\Lib\\Builder<TValue>",
        "  @property int $count",
        "  @property-read \\Lib\\Model|null $first",
        "  @property-write string $name",
        "  @property $untyped",
        "  @method static \\Lib\\Builder<TValue> query()",
        "  @method TValue find(int|string $id, bool &$found = false, \\Lib\\Model ...$rest)",
        "  @method \\App\\Items<TKey, U> map<U of \\Lib\\Model>(callable(TValue): U $fn)",
        "  extends App\\Base",
        "  implements IteratorAggregate, App\\Contract",
        "  use App\\HasItems",
        "  method public abstract map(callable $fn): self",
        "    @template U",
        "    @param callable(TValue): U $fn",
        "    @return \\App\\Items<TKey, U>",
        "  method public abstract key(): mixed",
        "    @return TKey|TIn|\\App\\T",
        "function App\\make(string $class): object",
        "  @template T of object",
        "  @param class-string<T> $class",
        "  @return T",
    ];
    assert_eq!(shape, expected, "{}", shape.join("\n"));
    let summary = summarize(source);
    let doc = summary.class_likes[0].doc.as_ref().expect("class doc");
    assert_eq!(doc.templates[0].variance, Variance::Covariant);
    assert_eq!(doc.properties[1].access, PropertyAccess::Read);
    let first = &doc.properties[1];
    assert_eq!(&source[first.name_loc.start as usize..first.name_loc.end as usize], "$first");
    let find = &doc.methods[1];
    assert_eq!(&source[find.name_loc.start as usize..find.name_loc.end as usize], "find");
    assert_eq!(find.params[1].default.as_deref(), Some("false"));
    assert!(find.params[1].by_ref && find.params[2].variadic && !doc.methods[0].params.iter().any(|p| p.by_ref));
    assert!(doc.methods[0].is_static);
    assert_eq!(doc.local_type_names().collect::<Vec<_>>(), ["TKey", "TValue", "TIn"]);
}

#[test]
fn phpdoc_vendor_tags_take_priority() {
    let source = r#"<?php
namespace App;

/**
 * @phpstan-type Row array{id: int, owner: User}
 * @psalm-import-type Id from Ids as Key
 * @type string $wordpress_hash_key not an alias
 * @template T
 * @psalm-template T of User
 * @extends Base<mixed>
 * @phpstan-extends Base<T>
 * @property mixed $p
 * @phpstan-property-read User $p
 */
class Repo extends Base {
    /**
     * @phpstan-param list<Row> $rows
     * @param array $rows
     * @psalm-return Key
     * @return int
     * @phpstan-var never
     */
    public function save(array $rows): int {}

    /**
     * @return array
     * @phpstan-return list<T>
     */
    public function all(): array {}
}
"#;
    let shape = shape(source);
    let expected = [
        "class App\\Repo",
        "  @template T of \\App\\User",
        "  @type Row = array{id: int, owner: \\App\\User}",
        "  @import-type Id from App\\Ids as Key",
        "  @extends \\App\\Base<T>",
        "  @property-read \\App\\User $p",
        "  extends App\\Base",
        "  method public save(array $rows): int",
        "    @var never",
        "    @param list<Row> $rows",
        "    @return Key",
        "  method public all(): array",
        "    @return list<T>",
    ];
    assert_eq!(shape, expected, "{}", shape.join("\n"));
}

#[test]
fn phpdoc_unparsable_types_become_mixed_per_tag() {
    let source = r#"<?php
/**
 * Registers a hook.
 *
 * @param string $name The hook.
 * @param array $args {
 *     Optional. Arguments.
 *
 *     @type string $type   The type.
 *     @type int    $weight The weight.
 * }
 * @param callable(...mixed): mixed $callback What runs.
 * @param array{ $broken
 * @return array<int,
 * @throws Oops
 */
function add_hook($name, $args, $callback, $broken) {}

class C {
    /** @var Closure(int $x>): void $handler */
    public $handler;
}
"#;
    let file = ParsedFile::parse("hooks.php", source);
    assert!(!file.has_errors(), "{:?}", file.errors());
    let summary = FileSummary::extract(&file);
    let doc = summary.functions[0].doc.as_ref().expect("doc");
    let params: Vec<(&str, &str)> = doc.params.iter().map(|param| (param.name.as_str(), param.ty.as_str())).collect();
    assert_eq!(params[..2], [("name", "string"), ("args", "array")]);
    assert!(
        params.contains(&("callback", "mixed")) || params.contains(&("callback", "callable(...mixed): mixed")),
        "{params:?}"
    );
    assert!(params.contains(&("broken", "mixed")), "{params:?} {doc:#?}");
    assert_eq!(doc.return_type, Some(DocType::mixed()));
    assert_eq!(doc.throws, [DocType("\\Oops".into())]);
    assert!(doc.type_aliases.is_empty());
    let handler = summary.class_likes[0].properties[0].doc.as_ref().expect("doc");
    assert_eq!(handler.var_type("handler"), Some(&DocType::mixed()));
}

/// WordPress documents array keys in a `{ … }` block after the type: the
/// type in front of it is kept.
#[test]
fn phpdoc_hash_notation_keeps_the_type() {
    let source = r#"<?php
namespace App;
/**
 * @return array {
 *     The parts.
 *
 *     @type string $name The name.
 * }
 */
function parts() {}
/**
 * @return array|WP_Error|\Other\Thing {
 *     The parts.
 * }
 */
function maybe() {}
/**
 * @return array<int, {
 * }
 */
function broken() {}
"#;
    let summary = summarize(source);
    let returns: Vec<Option<&str>> = summary
        .functions
        .iter()
        .map(|function| function.doc.as_ref().and_then(|doc| doc.return_type.as_ref()).map(DocType::as_str))
        .collect();
    assert_eq!(returns, [Some("array"), Some(r"array|\App\WP_Error|\Other\Thing"), Some("mixed")]);
}

#[test]
fn phpdoc_assertion_tags() {
    let source = r#"<?php
namespace App;
/**
 * @phpstan-assert-if-true WP_Error $thing
 * @psalm-assert-if-false !null $other
 * @phpstan-assert int $count
 * @phpstan-assert-if-true =string $exact
 * @phpstan-assert !null $this->prop
 */
function is_error($thing, $other, $count, $exact) {}
"#;
    let summary = summarize(source);
    let doc = summary.functions[0].doc.as_ref().expect("doc");
    let asserts: Vec<(AssertWhen, &str, &str, bool)> =
        doc.asserts.iter().map(|a| (a.when, a.param.as_str(), a.ty.as_str(), a.negated)).collect();
    assert_eq!(
        asserts,
        [
            (AssertWhen::IfTrue, "thing", r"\App\WP_Error", false),
            (AssertWhen::IfFalse, "other", "null", true),
            (AssertWhen::Always, "count", "int", false),
            (AssertWhen::IfTrue, "exact", "string", false),
        ]
    );
}

#[test]
fn phpdoc_multiline_types_and_attributes_between() {
    let source = "<?php\nnamespace App;\n/**\n * @return array{\n *     id: int,\n *     user: User,\n * }\n */\nfunction rows(): array {}\n\nclass C {\n    /** @var User */\n    #[Inject]\n    public $user;\n    /** no tags here */\n    public function plain() {}\n}\n";
    assert_eq!(
        shape(source),
        [
            "class App\\C",
            "  #[App\\Inject]",
            "  property public $user",
            "    @var \\App\\User",
            "  method public plain()",
            "function App\\rows(): array",
            "  @return array{ id: int, user: \\App\\User, }",
        ]
    );
    let summary = summarize(source);
    assert!(summary.class_likes[0].method("plain").is_some_and(|method| method.doc.is_none()));
}

#[test]
fn phpdoc_never_panics_on_any_prefix() {
    let text = r#"<?php
namespace A;
use X\Y;
/**
 * @template T of Y
 * @extends B<array{a: Y, b?: list<T>}>
 * @method static Y<T> m(int $a = 1, Y ...$r)
 * @property-read ?Y $p
 * @psalm-type R = array{0: Y::C, ...<string, T>}
 */
class C extends B {
    /** @var Closure(Y): T */
    public $f;
    /**
     * @param callable(...mixed): mixed $c
     * @return (T is Y ? Y : never)
     * @deprecated
     */
    public function g($c) {}
}
"#;
    for end in (0..=text.len()).filter(|&end| text.is_char_boundary(end)) {
        let file = ParsedFile::parse("p.php", &text[..end]);
        let summary = FileSummary::extract(&file);
        assert_eq!(FileSummary::from_bytes(&summary.to_bytes()).as_ref(), Ok(&summary));
    }
    let summary = summarize(text);
    let class = &summary.class_likes[0];
    let doc = class.doc.as_ref().expect("class doc");
    assert_eq!(doc.extends, [DocType(r"\A\B<array{a: \X\Y, b?: list<T>}>".into())]);
    assert_eq!(doc.type_aliases[0].ty, Some(DocType(r"array{0: \X\Y::C, ...<string, T>}".into())));
    let g = class.method("g").and_then(|method| method.doc.as_ref()).expect("g doc");
    assert_eq!(g.return_type, Some(DocType(r"(T is \X\Y ? \X\Y : never)".into())));
}

fn php_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).expect("fixture dir").map(|e| e.expect("entry").path()).collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name != "vendor") {
                php_files(&path, out);
            }
        } else if path.extension().is_some_and(|ext| ext == "php") {
            out.push(path);
        }
    }
}

/// Golden summaries of every PHP file in `fixtures/php-app`.
#[test]
fn php_app_fixture_golden() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/php-app");
    let mut files = Vec::new();
    php_files(&root, &mut files);
    assert!(files.len() >= 15, "{files:?}");
    let mut golden = String::new();
    for path in files {
        // Checkouts may have CRLF line endings; summaries keep source text
        // of defaults and values, so normalise for a stable golden.
        let text = std::fs::read_to_string(&path).expect("read fixture").replace("\r\n", "\n");
        let relative = path.strip_prefix(&root).expect("under root").to_string_lossy().replace('\\', "/");
        let file = ParsedFile::parse(&relative, text.as_str());
        let summary = FileSummary::extract(&file);
        assert_eq!(FileSummary::from_bytes(&summary.to_bytes()).as_ref(), Ok(&summary), "{relative}");
        golden.push_str(&format!("== {relative}\n{}", summary.render()));
    }
    insta::assert_snapshot!("php_app", golden);
}

/// The `~` lines of the rendering: lazy types of untyped declarations.
fn lazy_lines(source: &str) -> Vec<String> {
    shape_with_lazy(source)
        .into_iter()
        .filter(|line| line.trim_start().starts_with('~'))
        .map(|line| line.trim().to_owned())
        .collect()
}

#[test]
fn lazy_types_of_untyped_returns() {
    let source = r#"<?php
namespace App;
use Lib\Repo;
function none() { echo 1; }
function bare() { return; }
function maybe($x) { if ($x) { return 1; } return; }
function lit() { return 'a'; }
function calls() { return helper(); }
function qualified() { return \Lib\make(); }
function created() { return new Repo(); }
function chained() { return (new Repo())->find()->name; }
function nullsafe(Repo $r) { return $r?->find(); }
function statics() { return Repo::create(); }
function constants() { return [PHP_EOL, Repo::KIND, Repo::class]; }
function mixed($x) { return $x; }
function ops($a) { return $a . 'x'; }
function math() { return 1 + 2; }
function closures() { $g = fn() => 2; return function () { return 1; }; }
function generator() { yield 1; }
function both($x) { return $x ? new Repo() : helper(); }
function typed(): int { return 1; }
/** @return string */
function documented() { return 1; }
"#;
    assert_eq!(
        lazy_lines(source),
        [
            "~ returns: void",
            "~ returns: void",
            "~ returns: ?int",
            "~ returns: string",
            r"~ returns: App\helper() ?? helper()",
            r"~ returns: Lib\make()",
            r"~ returns: Lib\Repo",
            r"~ returns: Lib\Repo->find()->$name",
            r"~ returns: null | Lib\Repo->find()",
            // Static calls carry the Laravel provider's payload (facades, models).
            r"~ returns: laravel:call:create::(Lib\Repo, Lib\Repo->create()) ?? Lib\Repo->create()",
            "~ returns: non-empty-list",
            "~ returns: mixed",
            "~ returns: string",
            "~ returns: int",
            "~ returns: Closure",
            "~ returns: Generator",
            r"~ returns: Lib\Repo | App\helper() ?? helper()",
        ]
    );
}

#[test]
fn lazy_returns_of_local_variables() {
    let source = r#"<?php
namespace App;
use Lib\Repo;
function built() { $r = new Repo(); $r->boot(); return $r; }
function chained() { $a = new Repo(); $b = $a; return $b; }
function branches($x) { if ($x) { $v = 1; } else { $v = 'a'; } return $v; }
function called() { $found = Repo::find(); return $found; }
function param(Repo $p) { $p = 1; return $p; }
function untyped($p) { $p = 1; return $p; }
function compound() { $s = 'a'; $s .= 'b'; return $s; }
function element() { $a = []; $a['k'] = 1; return $a; }
function looped(array $xs) { $x = null; foreach ($xs as $x) {} return $x; }
function destructured() { $a = 1; [$a] = [new Repo()]; return $a; }
function captured() { $n = 0; $f = function () use (&$n) { $n = 'x'; }; return $n; }
function globals() { global $g; $g = 1; return $g; }
function statics() { static $s = 0; $s = 1; return $s; }
function inner() { $f = function () { $z = 1; return $z; }; return $z; }
function never_set() { return $missing; }
"#;
    assert_eq!(
        lazy_lines(source),
        [
            r"~ returns: Lib\Repo",
            r"~ returns: Lib\Repo",
            "~ returns: int|string",
            r"~ returns: laravel:call:find::(Lib\Repo, Lib\Repo->find()) ?? Lib\Repo->find()",
            r"~ returns: Lib\Repo",
            "~ returns: mixed",
            "~ returns: mixed",
            "~ returns: mixed",
            "~ returns: mixed",
            "~ returns: mixed",
            "~ returns: mixed",
            "~ returns: mixed",
            "~ returns: mixed",
            "~ returns: mixed",
            "~ returns: mixed",
        ]
    );
}

#[test]
fn lazy_types_of_members_and_constants() {
    let source = r#"<?php
namespace App;
const A = 'x';
const B = A;
define('C', -5);
class K {
    const ONE = 1;
    const TWO = self::ONE;
    const int TYPED = 3;
    /** @var string */
    const DOC = 'd';
    public $plain = [];
    public $map = ['a' => 1, 'b' => 2.5];
    public $none;
    public int $typed = 1;
    /** @var string */
    public $doc = 'x';
    public static $other = Other::X;
    public function __construct(public $promoted = 1) {}
    public function self() { return $this; }
    public function make() { return new static(); }
    public function parent() { return parent::make(); }
    public function cls() { return static::class; }
}
interface I { public function m(); }
"#;
    assert_eq!(
        lazy_lines(source),
        [
            "~ type: 1",
            "~ type: self::ONE",
            "~ type: array",
            "~ type: non-empty-array<string, int|float>",
            r"~ type: App\Other::X",
            "~ returns: $this",
            "~ returns: static",
            "~ returns: parent->make()",
            "~ returns: class-string<static>",
            "~ type: 'x'",
            r"~ type: const(App\A ?? A)",
            "~ type: -5",
        ]
    );
}
