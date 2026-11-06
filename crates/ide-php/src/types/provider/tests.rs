use std::sync::Arc;

use super::{CORE_ORDER, CallKind, CallSite, TypeProvider, TypeProviders, provided};
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::{Context, LazyType, Resolver, SummarySet, Type, TypeCache, type_at};

const CARET: &str = "/*|*/";

macro_rules! fixture {
    ($path:literal) => {
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/php-app/", $path))
    };
}

/// The type at the caret in `body` (after `header`), `libs` declared too,
/// with `providers` (the built-in ones when `None`).
fn type_with(providers: Option<&TypeProviders>, libs: &[&str], source: &str) -> String {
    let offset = source.find(CARET).unwrap_or_else(|| panic!("no caret in {source}"));
    let source = source.replacen(CARET, "", 1);
    let file = ParsedFile::parse("main.php", source.as_str());
    assert!(!file.has_errors(), "{source}: {:?}", file.errors());
    let mut summaries = vec![FileSummary::extract(&file)];
    for (i, lib) in libs.iter().enumerate() {
        let lib = ParsedFile::parse(format!("lib{i}.php").as_str(), *lib);
        assert!(!lib.has_errors(), "{:?}", lib.errors());
        summaries.push(FileSummary::extract(&lib));
    }
    let decls = SummarySet::new(summaries);
    let cache = TypeCache::new();
    let mut resolver = Resolver::new(&decls, &cache, 1);
    if let Some(providers) = providers {
        resolver = resolver.with_providers(providers);
    }
    type_at(&file, &resolver, offset as u32).map(|ty| ty.to_string()).unwrap_or_else(|| "<none>".to_owned())
}

fn check(libs: &[&str], header: &str, cases: &[(&str, &str)]) {
    let mut failures = Vec::new();
    for (body, expected) in cases {
        let got = type_with(None, libs, &format!("{header}{body}"));
        if got != *expected {
            failures.push(format!("{body}\n  expected {expected}\n  got      {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

const APP: &str = r#"<?php
namespace App;
interface Mailer { public function send(string $to): bool; }
class Clock { public function now(): int { return 0; } }
abstract class Job { abstract public function run(): void; }
class Factory {
    public function createMock(string $class): Clock { return new Clock(); }
}
"#;

const TEST_HEADER: &str =
    "<?php\nnamespace Tests;\nuse App\\{Mailer, Clock, Job, Factory};\nuse PHPUnit\\Framework\\TestCase;\n";

const MOCK: &str = "PHPUnit\\Framework\\MockObject\\MockObject";

#[test]
fn phpunit_doubles_in_test_cases() {
    let t = |body: &str| {
        format!("final class MailerTest extends TestCase {{\n public function testIt(): void {{\n{body}\n}}\n}}")
    };
    let mailer_mock = format!("App\\Mailer&{MOCK}");
    let clock_mock = format!("App\\Clock&{MOCK}");
    let job_mock = format!("App\\Job&{MOCK}");
    let stub = "App\\Mailer&PHPUnit\\Framework\\MockObject\\Stub".to_owned();
    let builder = "PHPUnit\\Framework\\MockObject\\MockBuilder<App\\Mailer>".to_owned();
    let cases: Vec<(String, String)> = vec![
        (t("$m = $this->createMock(Mailer::class);\n$m/*|*/;"), mailer_mock.clone()),
        (t("$m = $this->createMock(originalClassName: Clock::class);\n$m/*|*/;"), clock_mock.clone()),
        (t("$m = $this->createMock('App\\Clock');\n$m/*|*/;"), clock_mock.clone()),
        (t("$m = self::createConfiguredMock(Mailer::class, ['send' => true]);\n$m/*|*/;"), mailer_mock.clone()),
        (t("$m = $this->createPartialMock(Mailer::class, ['send']);\n$m/*|*/;"), mailer_mock.clone()),
        (t("$m = $this->getMockForAbstractClass(Job::class);\n$m/*|*/;"), job_mock),
        (t("$s = $this->createStub(Mailer::class);\n$s/*|*/;"), stub),
        (t("$b = $this->getMockBuilder(Mailer::class);\n$b/*|*/;"), builder),
        (
            t("$m = $this->getMockBuilder(Mailer::class)->disableOriginalConstructor()->getMock();\n$m/*|*/;"),
            "mixed".into(),
        ),
        (t("$m = $this->getMockBuilder(Mailer::class)->getMock();\n$m/*|*/;"), mailer_mock.clone()),
        // A member of the double: the mocked class's method.
        (t("$this->createMock(Mailer::class)->send('a')/*|*/;"), "bool".into()),
        (t("$this->createMock(Clock::class)->now()/*|*/;"), "int".into()),
        // No class argument: the provider has nothing to say.
        (t("$m = $this->createMock($name);\n$m/*|*/;"), "mixed".into()),
    ];
    let cases: Vec<(&str, &str)> = cases.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    check(&[APP], TEST_HEADER, &cases);
}

#[test]
fn phpunit_only_for_test_cases() {
    // A `createMock` of another class keeps its own return type, and a
    // class that is no test case gets no doubles.
    check(
        &[APP],
        TEST_HEADER,
        &[
            ("(new Factory())->createMock(Mailer::class)/*|*/;", "App\\Clock"),
            ("class NotATest { public function f() { $this->createMock(Mailer::class)/*|*/; } }", "mixed"),
            (
                "class Base extends TestCase {}\nclass Sub extends Base { public function f() { $this->createStub(Clock::class)/*|*/; } }",
                "App\\Clock&PHPUnit\\Framework\\MockObject\\Stub",
            ),
        ],
    );
}

const SETUP_TEST: &str = r#"
final class ClockTest extends TestCase {
    private $clock;
    private $mailer = null;
    private $later;
    /** @var Mailer */
    private $documented;
    private static $shared;
    private int $count = 0;

    protected function setUp(): void {
        $this->clock = new Clock();
        $this->mailer = $this->createMock(Mailer::class);
        $this->documented = $this->createMock(Clock::class);
        self::$shared = new Clock();
    }

    public function testLater(): void {
        $this->later = new Clock();
    }

    public function testIt(): void {
        BODY
    }
}
"#;

#[test]
fn phpunit_set_up_fields() {
    let t = |expr: &str| SETUP_TEST.replace("BODY", &format!("{expr}/*|*/;"));
    let cases = [
        (t("$this->clock"), "App\\Clock".to_owned()),
        (t("$this->clock->now()"), "int".to_owned()),
        (t("$this->mailer"), format!("App\\Mailer&{MOCK}")),
        (t("$this->mailer->send('a')"), "bool".to_owned()),
        // Assigned outside setUp(): not typed by the provider.
        (t("$this->later"), "mixed".to_owned()),
        // A declared type wins.
        (t("$this->documented"), "App\\Mailer".to_owned()),
        (t("$this->count"), "int".to_owned()),
    ];
    let cases: Vec<(&str, &str)> = cases.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    check(&[APP], TEST_HEADER, &cases);

    // The summary stores the provider's payload for the property, so other
    // files see the type too.
    let source = format!("{TEST_HEADER}{}", SETUP_TEST.replace("BODY", ""));
    let summary = FileSummary::extract(&ParsedFile::parse("t.php", source.as_str()));
    let class = summary.class_like("Tests\\ClockTest").unwrap();
    let ty = |name: &str| {
        class.properties.iter().find(|p| p.name == name).unwrap().default_type.as_ref().map(ToString::to_string)
    };
    assert_eq!(ty("clock").as_deref(), Some("phpunit:setUp(Tests\\ClockTest, App\\Clock)"));
    assert!(ty("mailer").unwrap().starts_with("phpunit:setUp(Tests\\ClockTest, phpunit:double:"), "{:?}", ty("mailer"));
    assert_eq!(ty("later"), None);
    assert_eq!(ty("documented"), None);
    assert_eq!(ty("shared"), None);

    // Not a test case: the default value types the property.
    let plain =
        format!("{TEST_HEADER}{}", SETUP_TEST.replace("extends TestCase ", "").replace("BODY", "$this->mailer/*|*/;"));
    assert_eq!(type_with(None, &[APP], &plain), "null");
}

#[test]
fn fixture_phpunit_cases() {
    let libs = [
        fixture!("src/Contracts/Repository.php"),
        fixture!("src/Support/Collection.php"),
        fixture!("src/Model/Book.php"),
        fixture!("src/Model/Genre.php"),
        fixture!("src/Library.php"),
        fixture!("src/Container.php"),
        fixture!("src/Repository/AbstractRepository.php"),
        fixture!("src/Repository/BookRepository.php"),
        fixture!("src/Support/HasTimestamps.php"),
    ];
    // After the last occurrence of `after`.
    let at = |source: &str, after: &str| {
        let end = source.rfind(after).unwrap_or_else(|| panic!("no {after}")) + after.len();
        let source = format!("{}{CARET}{}", &source[..end], &source[end..]);
        type_with(None, &libs, &source)
    };
    let doubles = fixture!("tests/RepositoryDoubleTest.php");
    assert_eq!(at(doubles, "$this->createMock(Repository::class)"), format!("App\\Contracts\\Repository&{MOCK}"));
    assert_eq!(at(doubles, "$this->books"), format!("App\\Contracts\\Repository&{MOCK}"));
    assert_eq!(at(doubles, "$this->books->find('9')"), "?object");
    let library = fixture!("tests/LibraryTest.php");
    assert_eq!(at(library, "$lent = $this->library"), "App\\Library");
}

/// A provider for function `\Lib\magic()` and `\Lib\plain()`, answering
/// with a lazy payload resolved to the class its argument names.
struct Magic;

impl TypeProvider for Magic {
    fn key(&self) -> &'static str {
        "magic"
    }

    fn call(&self, site: &CallSite<'_>) -> Option<LazyType> {
        if site.kind != CallKind::Function {
            return None;
        }
        match site.name {
            "Lib\\magic" | "Lib\\plain" => {
                let class = site.class_arg()?.to_owned();
                Some(provided(self.key(), class, Vec::new(), (site.core)()))
            }
            "Lib\\answer" => Some(LazyType::Known(Type::LiteralInt(42))),
            _ => None,
        }
    }

    fn resolve(&self, payload: &str, _: &[Type], resolver: &Resolver<'_>, _: &Context) -> Option<Type> {
        // Only classes that exist.
        resolver.class_model(payload).map(|_| Type::named(payload))
    }
}

const LIB: &str = r#"<?php
namespace Lib;
class Foo {}
function magic(string $class): object { return new \stdClass(); }
function plain($class) { return $class; }
function answer(): string { return ''; }
"#;

#[test]
fn registry_order_and_resolve_step() {
    let header = "<?php\nnamespace Main;\nuse function Lib\\{magic, plain, answer};\nuse Lib\\Foo;\n";
    let run = |providers: &TypeProviders, body: &str| type_with(Some(providers), &[LIB], &format!("{header}{body}"));

    let builtin = TypeProviders::default();
    assert_eq!(builtin.keys(), ["phpunit", "core"]);
    assert_eq!(run(&builtin, "magic(Foo::class)/*|*/;"), "object");

    // Before the core: overrides declared returns, the resolve step's
    // `None` falls back to the core answer.
    let mut before = TypeProviders::default();
    before.register(CORE_ORDER - 1, Arc::new(Magic));
    assert_eq!(before.keys(), ["phpunit", "magic", "core"]);
    assert_eq!(run(&before, "magic(Foo::class)/*|*/;"), "Lib\\Foo");
    assert_eq!(run(&before, "magic('Lib\\Foo')/*|*/;"), "Lib\\Foo");
    assert_eq!(run(&before, "magic(Missing::class)/*|*/;"), "object");
    assert_eq!(run(&before, "answer()/*|*/;"), "int");

    // After the core: only where the core knows nothing.
    let mut after = TypeProviders::default();
    after.register(CORE_ORDER + 1, Arc::new(Magic));
    assert_eq!(after.keys(), ["phpunit", "core", "magic"]);
    assert_eq!(run(&after, "magic(Foo::class)/*|*/;"), "object");
    assert_eq!(run(&after, "plain(Foo::class)/*|*/;"), "Lib\\Foo");
    assert_eq!(run(&after, "plain(Missing::class)/*|*/;"), "mixed");

    // Without any provider, calls are unknown.
    assert_eq!(run(&TypeProviders::empty(), "answer()/*|*/;"), "mixed");
}

#[test]
fn payloads_print_and_round_trip() {
    let lazy = provided("phpunit", "double:X:Y", vec![LazyType::Known(Type::named("A"))], LazyType::mixed());
    assert_eq!(lazy.to_string(), "phpunit:double:X:Y(A)");
    let with_fallback = provided("k", "p", Vec::new(), LazyType::Known(Type::Int));
    assert_eq!(with_fallback.to_string(), "k:p() ?? int");
    let bytes = postcard::to_allocvec(&lazy).unwrap();
    assert_eq!(postcard::from_bytes::<LazyType>(&bytes).unwrap(), lazy);
}
