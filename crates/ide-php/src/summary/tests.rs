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

/// The rendering without locations, for compact expectations.
fn shape(source: &str) -> Vec<String> {
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
