//! Tests of the language level and deprecation inspections.

use super::*;
use crate::stubs::PhpVersion;

/// `(id, covered text, message)` of each problem.
fn found(text: &str, inspected: &Inspected) -> Vec<(&'static str, String, String)> {
    inspected
        .problems
        .iter()
        .map(|p| (p.inspection, text[p.start as usize..p.end as usize].to_owned(), p.message.clone()))
        .collect()
}

/// The covered text of each problem.
fn covered(text: &str, inspected: &Inspected) -> Vec<String> {
    found(text, inspected).into_iter().map(|(_, covered, _)| covered).collect()
}

fn project_at(version: &str) -> Project {
    let p = Project::new();
    p.engine.set_stub_filter(StubFilter::all_extensions(PhpVersion::parse(version).unwrap()));
    p.engine.set_inspections(Inspections::new(vec![Arc::new(level::LanguageLevel)]));
    p
}

const PHP80: &str = r#"<?php
namespace App;

#[\Attribute]
class Point {
    public function __construct(private int $x, public readonly int $y = 0) {}
    public function m(int|string $a, mixed $b): static { return $this; }
    public function n(?Point $p): ?int { return $p?->x; }
}
function f($v) {
    $r = match ($v) { 1 => 'a', default => throw new \Exception() };
    throw new \Exception();
    try { f(1); } catch (\Exception) {}
    f(v: 1);
    return $v::class;
}
"#;

#[test]
fn php_8_0_features_at_several_levels() {
    let mut p = project_at("7.4");
    let inspected = p.inspect(PHP80);
    assert_eq!(
        covered(PHP80, &inspected),
        [
            "#[\\Attribute]",
            "private",
            "public readonly",
            "readonly",
            "int|string",
            "mixed",
            "static",
            "?->",
            "match",
            "throw",
            "\\Exception",
            "v:",
            "$v::class",
        ],
        "{:?}",
        found(PHP80, &inspected)
    );
    assert!(inspected.problems.iter().all(|p| p.severity == Severity::Error));
    let readonly = inspected.problems.iter().find(|p| p.message.starts_with("Readonly")).unwrap();
    assert_eq!(
        readonly.message,
        "Readonly properties are only available since PHP 8.1 (the project's language level is PHP 7.4)"
    );
    let promotion = inspected.problems.iter().find(|p| p.message.starts_with("Constructor")).unwrap();
    assert_eq!(
        promotion.message,
        "Constructor property promotion is only available since PHP 8.0 (the project's language level is PHP 7.4)"
    );

    // At 8.0 only the 8.1 readonly property remains.
    let mut p = project_at("8.0");
    let inspected = p.inspect(PHP80);
    assert_eq!(covered(PHP80, &inspected), ["readonly"]);

    let mut p = project_at("8.1");
    assert!(p.inspect(PHP80).problems.is_empty());
}

#[test]
fn php_7_features_at_5_6_and_7_0() {
    let text = r#"<?php
function f(int $a, $b = null): ?string {
    $x = $b ?? 1;
    $y = $a <=> 2;
    [$c, $d] = [1, 2];
    $e = new class {};
    $g = fn($z) => $z;
    $b ??= 1_000;
    $h = [...$x];
    foreach ([[1, 2]] as [$i, $j]) {}
    try {} catch (A | B $e) {}
    return null;
}
interface I { public const C = 1; function o(object $o): void; function it(): iterable; }
"#;
    let mut p = project_at("5.6");
    let inspected = p.inspect(text);
    let messages: Vec<String> = inspected.problems.iter().map(|p| p.message.clone()).collect();
    assert_eq!(
        covered(text, &inspected),
        [
            "int",
            "?string",
            "??",
            "<=>",
            "[$c, $d]",
            "new class",
            "fn",
            "??=",
            "1_000",
            "...$x",
            "[$i, $j]",
            "A | B",
            "public",
            "object",
            "void",
            "iterable",
        ],
        "{messages:?}"
    );
    assert!(messages[0].starts_with("Scalar type declarations are only available since PHP 7.0"));
    // `?string` reports its newest feature only (nullable, 7.1), not the
    // return type (7.0) as well.
    assert!(messages[1].starts_with("Nullable types are only available since PHP 7.1"));

    let mut p = project_at("7.0");
    let inspected = p.inspect(text);
    assert_eq!(
        covered(text, &inspected),
        [
            "?string", "[$c, $d]", "fn", "??=", "1_000", "...$x", "[$i, $j]", "A | B", "public", "object", "void",
            "iterable"
        ]
    );

    let mut p = project_at("7.4");
    assert!(p.inspect(text).problems.is_empty());
}

#[test]
fn php_8_1_to_8_5_features() {
    let text = r#"<?php
enum Suit: string { case Hearts = 'H'; }
readonly class R {}
trait T { const X = 1; }
class C {
    final public const A = 1;
    const string B = 'b';
    public private(set) int $p = 0;
    public int $q { get => 1; }
    public function n(): never { exit; }
    public function i(A&B $x, (A&B)|null $y, true $t, null $n, $d = new \stdClass()) {}
    public function m() {
        $f = strlen(...);
        $o = 0o17;
        $c = static::{'A'};
        $r = new C()->m();
        $s = 'x' |> strlen(...);
        $a = new readonly class {};
    }
}
"#;
    let mut p = project_at("8.0");
    let inspected = p.inspect(text);
    assert_eq!(
        covered(text, &inspected),
        [
            "enum",
            "readonly",
            "const",
            "final",
            "string",
            "private(set)",
            "{ get => 1; }",
            "never",
            "A&B",
            "(A&B)|null",
            "true",
            "null",
            "new",
            "(...)",
            "0o17",
            "{'A'}",
            "new C()",
            "|>",
            "(...)",
            "readonly",
        ],
        "{:?}",
        found(text, &inspected)
    );

    let mut p = project_at("8.3");
    let inspected = p.inspect(text);
    assert_eq!(covered(text, &inspected), ["private(set)", "{ get => 1; }", "new C()", "|>"]);

    let mut p = project_at("8.5");
    assert!(p.inspect(text).problems.is_empty());
}

#[test]
fn deprecated_uses_are_struck_through() {
    let mut p = Project::with_files(&[(
        "src/lib.php",
        r#"<?php
namespace App;

/** @deprecated use Fresh */
class Old { const C = 1; }
class Fresh {
    /** @deprecated */
    public const LIMIT = 10;
    /** @deprecated */
    public int $size = 0;
    #[\Deprecated]
    public function legacy(): void {}
    public function current(): void {}
}
/** @deprecated */
function gone(): void {}
/** @deprecated */
const OLD_FLAG = 1;
enum Mode { /** @deprecated */ case Slow; case Fast; }
"#,
    )]);
    p.engine.set_inspections(Inspections::new(vec![Arc::new(level::Deprecation)]));
    let text = r#"<?php
namespace App;

use App\Old;

/** @deprecated */
function local(): void {}

function f(Fresh $fresh) {
    $o = new Old();
    $fresh->legacy();
    $fresh->current();
    $n = $fresh->size + Fresh::LIMIT + OLD_FLAG;
    gone();
    local();
    $m = Mode::Slow;
    $k = Mode::Fast;
    $l = strlen('x');
}
"#;
    let inspected = p.inspect(text);
    assert_eq!(
        found(text, &inspected).into_iter().map(|(_, covered, message)| (covered, message)).collect::<Vec<_>>(),
        [
            ("App\\Old".to_owned(), "Class 'Old' is deprecated".to_owned()),
            ("Old".to_owned(), "Class 'Old' is deprecated".to_owned()),
            ("legacy".to_owned(), "Method 'legacy' is deprecated".to_owned()),
            ("size".to_owned(), "Property 'size' is deprecated".to_owned()),
            ("LIMIT".to_owned(), "Constant 'LIMIT' is deprecated".to_owned()),
            ("OLD_FLAG".to_owned(), "Constant 'OLD_FLAG' is deprecated".to_owned()),
            ("gone".to_owned(), "Function 'gone' is deprecated".to_owned()),
            ("local".to_owned(), "Function 'local' is deprecated".to_owned()),
            ("Slow".to_owned(), "Enum case 'Slow' is deprecated".to_owned()),
        ]
    );
    assert!(inspected.problems.iter().all(|p| p.deprecated && p.severity == Severity::Warning));
    assert!(inspected.diagnostics.iter().filter(|d| d.code.as_deref() == Some("PhpDeprecation")).all(|d| d.deprecated));
}

#[test]
fn suppressed_registered_and_quiet_in_meta_files() {
    let mut p = project_at("7.4");
    let found = p.inspect("<?php\n/** @noinspection PhpLanguageLevelInspection */\nfunction f(): mixed { return match (1) { default => 1 }; }\n");
    assert!(found.problems.is_empty(), "{:?}", found.problems);
    let ids = Inspections::builtin().ids();
    assert!(ids.contains(&"PhpLanguageLevel") && ids.contains(&"PhpDeprecation"));
    let doc = p.open(".phpstorm.meta.php", "<?php\nnamespace PHPSTORM_META { enum E {} }\n");
    let inspected = p.engine.inspect(doc, &CancellationToken::new()).unwrap();
    assert!(inspected.problems.is_empty(), "{:?}", inspected.problems);
}

#[test]
fn changing_the_language_level_inspects_again() {
    let mut p = project_at("8.1");
    let doc = p.open("src/a.php", "<?php\nenum E {}\n");
    assert!(p.engine.inspected(doc).unwrap().problems.is_empty());
    assert_eq!(p.engine.language_level(), PhpVersion::new(8, 1));
    p.engine.set_stub_filter(StubFilter::all_extensions(PhpVersion::new(8, 0)));
    assert_eq!(p.engine.language_level(), PhpVersion::new(8, 0));
    let inspected = p.engine.inspected(doc).unwrap();
    assert_eq!(inspected.problems.len(), 1, "{:?}", inspected.problems);
}
