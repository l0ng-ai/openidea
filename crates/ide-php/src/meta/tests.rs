use super::{CallTarget, Callee, MetaValue, OverrideKind, PhpStormMeta};
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::{Context, Resolver, SummarySet, Type, TypeCache, type_at};

const CARET: &str = "/*|*/";

macro_rules! fixture {
    ($path:literal) => {
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/php-app/", $path))
    };
}

fn summary(name: &str, source: &str) -> FileSummary {
    let file = ParsedFile::parse(name, source);
    assert!(!file.has_errors(), "{name}: {:?}", file.errors());
    FileSummary::extract(&file)
}

/// The type at the caret in `source`, `libs` (meta files included)
/// declared too.
fn type_in(libs: &[&str], source: &str) -> String {
    let offset = source.find(CARET).unwrap_or_else(|| panic!("no caret in {source}"));
    let source = source.replacen(CARET, "", 1);
    let file = ParsedFile::parse("main.php", source.as_str());
    assert!(!file.has_errors(), "{source}: {:?}", file.errors());
    let mut summaries = vec![FileSummary::extract(&file)];
    summaries.extend(libs.iter().enumerate().map(|(i, lib)| summary(&format!("lib{i}.php"), lib)));
    let decls = SummarySet::new(summaries);
    let cache = TypeCache::new();
    let resolver = Resolver::new(&decls, &cache, 1);
    type_at(&file, &resolver, offset as u32).map(|ty| ty.to_string()).unwrap_or_else(|| "<none>".to_owned())
}

fn check(libs: &[&str], header: &str, cases: &[(&str, &str)]) {
    let mut failures = Vec::new();
    for (body, expected) in cases {
        let close = if header.contains("function t(") {
            "
}
"
        } else {
            ""
        };
        let got = type_in(libs, &format!("{header}{body}{close}"));
        if got != *expected {
            failures.push(format!("{body}\n  expected {expected}\n  got      {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn fixture_meta_directives() {
    let meta = summary(".phpstorm.meta.php", fixture!(".phpstorm.meta.php")).meta;
    assert_eq!(meta.overrides.len(), 2);
    let make = Callee::Method { class: "App\\Container".into(), name: "make".into() };
    assert_eq!(meta.overrides[0].callee, make);
    assert_eq!(meta.overrides[0].arg, 0);
    assert_eq!(
        meta.overrides[0].kind,
        OverrideKind::Map(vec![
            ("books".into(), "App\\Repository\\BookRepository".into()),
            ("library".into(), "App\\Library".into()),
            ("".into(), "@".into()),
        ])
    );
    assert_eq!(
        meta.overrides[1].callee,
        Callee::Method { class: "App\\Support\\Collection".into(), name: "first".into() }
    );
    assert_eq!(meta.overrides[1].kind, OverrideKind::Type(0));
    assert_eq!(meta.expected_arguments.len(), 1);
    assert_eq!(meta.expected_arguments[0].callee, make);
    assert_eq!(meta.expected_arguments[0].index, 0);
    assert_eq!(
        meta.expected_arguments[0].values,
        [MetaValue::String("books".into()), MetaValue::String("library".into())]
    );
    assert!(meta.exit_points.is_empty());

    // Directives only count in the `PHPSTORM_META` namespace.
    let elsewhere = summary("x.php", "<?php\nnamespace App;\noverride(\\f(0), type(0));\nexitPoint(\\g());\n");
    assert!(elsewhere.meta.is_empty());
}

const META: &str = r#"<?php
namespace PHPSTORM_META {
    use App\Factory;

    override(Factory::make(0), map([
        'clock' => \App\Clock::class,
        'mailer' => 'App\Mailer',
        \App\Clock::class => \App\Mailer::class,
        '' => '@',
    ]));
    override(Factory::build(1), map(['' => '@Builder']));
    override(Factory::many(0), map(['' => '@[]']));
    override(Factory::both(0), map(['' => '@|\App\Mailer']));
    override(\App\pick(0), type(0));
    override(\App\Factory::same(0), type(0));
    override(\App\first(0), elementType(0));
    override(\array_pop(0), elementType(0));
    exitPoint(\App\Factory::fail());
    exitPoint(\App\halt());

    registerArgumentsSet('modes', 'r', 'w', \App\Factory::MODE);
    registerArgumentsSet('all', argumentsSet('modes'), 'x', 1, \PHP_EOL, \App\Clock::class, \App\A | \App\B);
    expectedArguments(\App\Factory::open(), 1, argumentsSet('all'));
    expectedArguments(\App\open(), 0, 'a', argumentsSet('modes'));
    expectedReturnValues(\App\Factory::status(), 200, 404);
}
"#;

const APP: &str = r#"<?php
namespace App;
class Clock { public function now(): int { return 0; } }
class Mailer {}
class ClockBuilder {}
class Factory {
    const MODE = 'rw';
    public function make(string $id): object { return new \stdClass(); }
    public static function build(string $a, string $b): object { return new \stdClass(); }
    public function many(string $class): array { return []; }
    public function both(string $class): object { return new \stdClass(); }
    public function same(mixed $x): mixed { return $x; }
    public function fail(): void {}
    public function open(string $path, string $mode): void {}
    public function status(): int { return 200; }
}
class SubFactory extends Factory {}
class Other { public function make(string $id): object { return new \stdClass(); } }
function pick(mixed $x): mixed { return $x; }
/** @param iterable<mixed> $xs */
function first(iterable $xs): mixed { return null; }
function halt(): void {}
function open(string $mode): void {}
"#;

const HEADER: &str = "<?php\nnamespace Main;\nuse App\\{Factory, SubFactory, Other, Clock};\nuse function App\\{pick, first, halt};\nfunction t(Factory $f, SubFactory $s, Other $o, string $id, array $list) {\n";

#[test]
fn overrides_with_map() {
    check(
        &[META, APP],
        HEADER,
        &[
            ("$f->make('clock')/*|*/;", "App\\Clock"),
            ("$f->make('mailer')/*|*/;", "App\\Mailer"),
            ("$f->make(Clock::class)/*|*/;", "App\\Mailer"),
            // The default entry: the argument itself names the class.
            ("$f->make('App\\Factory')/*|*/;", "App\\Factory"),
            ("$f->make(Other::class)/*|*/;", "App\\Other"),
            // Not a literal: `@` can't be filled, the declared return stays.
            ("$f->make($id)/*|*/;", "object"),
            // Subclasses and static calls; other classes are not affected.
            ("$s->make('clock')/*|*/;", "App\\Clock"),
            ("$o->make('clock')/*|*/;", "object"),
            ("Factory::build('x', 'App\\Clock')/*|*/;", "App\\ClockBuilder"),
            ("$f->many('App\\Clock')/*|*/;", "App\\Clock[]"),
            ("$f->both(Clock::class)/*|*/;", "App\\Clock|App\\Mailer"),
            ("$x = $f->make('clock');\n$x->now()/*|*/;", "int"),
        ],
    );
}

#[test]
fn overrides_with_type_and_element_type() {
    check(
        &[META, APP],
        HEADER,
        &[
            ("pick(1)/*|*/;", "int"),
            ("pick(new Clock())/*|*/;", "App\\Clock"),
            ("pick(Clock::class)/*|*/;", "App\\Clock"),
            ("pick('App\\Clock')/*|*/;", "App\\Clock"),
            ("pick('nope')/*|*/;", "string"),
            ("$f->same([1])/*|*/;", "list{int}"),
            ("first([new Clock()])/*|*/;", "App\\Clock"),
            ("$a = [new Clock()];\n\\array_pop($a)/*|*/;", "App\\Clock"),
            // Nothing to say: the declared return.
            ("pick(null)/*|*/;", "null"),
            ("first($list)/*|*/;", "mixed"),
        ],
    );
}

#[test]
fn exit_points_never_return() {
    check(
        &[META, APP],
        HEADER,
        &[
            ("$f->fail()/*|*/;", "never"),
            ("halt()/*|*/;", "never"),
            ("$o->make('x');\n$f->status()/*|*/;", "int"),
            // The flow sees the exit point: `$x` is only set on the other path.
            ("if ($id) { $x = 1; } else { $f->fail(); }\n$x/*|*/;", "int"),
        ],
    );
}

#[test]
fn expected_values() {
    let decls = SummarySet::new(vec![summary("meta.php", META), summary("app.php", APP)]);
    let cache = TypeCache::new();
    let resolver = Resolver::new(&decls, &cache, 1);
    let meta = resolver.meta();
    let context = Context::default();
    let show = |values: Vec<MetaValue>| values.iter().map(ToString::to_string).collect::<Vec<_>>();

    let factory = Type::named("App\\SubFactory");
    let open = CallTarget::Method { receiver: &factory, name: "open" };
    assert_eq!(
        show(meta.expected_arguments(open, 1, &resolver, &context)),
        ["'r'", "'w'", "\\App\\Factory::MODE", "'x'", "1", "\\PHP_EOL", "\\App\\Clock::class", "\\App\\A | \\App\\B"]
    );
    assert!(meta.expected_arguments(open, 0, &resolver, &context).is_empty());
    let other = Type::named("App\\Other");
    assert!(
        meta.expected_arguments(CallTarget::Method { receiver: &other, name: "open" }, 1, &resolver, &context)
            .is_empty()
    );

    // Functions, also through the global fallback of a namespaced call.
    let function = CallTarget::Function("App\\open");
    assert_eq!(
        show(meta.expected_arguments(function, 0, &resolver, &context)),
        ["'a'", "'r'", "'w'", "\\App\\Factory::MODE"]
    );
    assert!(meta.expected_arguments(CallTarget::Function("Main\\open"), 0, &resolver, &context).is_empty());

    let status = CallTarget::Method { receiver: &factory, name: "status" };
    assert_eq!(show(meta.expected_return_values(status, &resolver, &context)), ["200", "404"]);
    assert_eq!(show(meta.arguments_set("modes")), ["'r'", "'w'", "\\App\\Factory::MODE"]);
    assert!(meta.arguments_set("missing").is_empty());

    assert!(meta.is_exit_point(CallTarget::Method { receiver: &factory, name: "FAIL" }, &resolver, &context));
    assert!(!meta.is_exit_point(CallTarget::Function("Main\\halt"), &resolver, &context));
    assert!(meta.is_exit_point(CallTarget::Function("App\\halt"), &resolver, &context));
}

#[test]
fn arguments_sets_that_refer_to_each_other_end() {
    let meta = summary(
        "meta.php",
        "<?php\nnamespace PHPSTORM_META;\nregisterArgumentsSet('a', 'x', argumentsSet('b'));\nregisterArgumentsSet('b', 'y', argumentsSet('a'));\n",
    )
    .meta;
    let merged = PhpStormMeta::merge([&meta]);
    let values: Vec<String> = merged.arguments_set("a").iter().map(ToString::to_string).collect();
    assert_eq!(values, ["'x'", "'y'"]);
}

#[test]
fn fixture_container() {
    let libs = [
        fixture!(".phpstorm.meta.php"),
        fixture!("src/Container.php"),
        fixture!("src/Library.php"),
        fixture!("src/Repository/BookRepository.php"),
        fixture!("src/Repository/AbstractRepository.php"),
        fixture!("src/Contracts/Repository.php"),
        fixture!("src/Support/Collection.php"),
        fixture!("src/Model/Book.php"),
    ];
    let header = "<?php\nnamespace Main;\nuse App\\{Container, Library};\nuse App\\Support\\Collection;\n$c = Container::boot();\n";
    check(
        &libs,
        header,
        &[
            ("$c->make('books')/*|*/;", "App\\Repository\\BookRepository"),
            ("$c->make('library')/*|*/;", "App\\Library"),
            ("$c->make(Library::class)/*|*/;", "App\\Library"),
            ("$c->make('books')->all()/*|*/;", "App\\Support\\Collection<App\\Model\\Book>"),
            // `type(0)` with no argument: the documented return stays.
            ("/** @var Collection<int> $n */\n$n = new Collection([1]);\n$n->first()/*|*/;", "?int"),
        ],
    );
}

/// What a summary stores: only calls with a string or `::class` argument
/// get a meta payload.
#[test]
fn summary_payloads() {
    let source = "<?php\nnamespace App;\nclass C {\n  public function a(Factory $f) { return $f->make('clock'); }\n  public function b(Factory $f, $x) { return $f->make($x); }\n}\n";
    let summary = summary("c.php", source);
    let returns: Vec<String> = summary.class_likes[0]
        .methods
        .iter()
        .map(|method| method.inferred_return.as_ref().map(ToString::to_string).unwrap_or_default())
        .collect();
    assert_eq!(returns, [r"meta:m:make(App\Factory, 'clock') ?? App\Factory->make()", r"App\Factory->make()"]);
    let decls = SummarySet::new(vec![summary, self::summary("meta.php", META), self::summary("app.php", APP)]);
    let cache = TypeCache::new();
    let resolver = Resolver::new(&decls, &cache, 1);
    assert_eq!(resolver.method_return(&Type::named("App\\C"), "a", &Context::default()).to_string(), "App\\Clock");
    assert_eq!(resolver.method_return(&Type::named("App\\C"), "b", &Context::default()).to_string(), "object");
}
