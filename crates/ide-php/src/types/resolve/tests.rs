use super::*;
use crate::syntax::ParsedFile;

fn summaries(files: &[&str]) -> SummarySet {
    SummarySet::new(
        files
            .iter()
            .enumerate()
            .map(|(i, source)| {
                let file = ParsedFile::parse(&format!("file{i}.php"), *source);
                assert!(!file.has_errors(), "{source}: {:?}", file.errors());
                FileSummary::extract(&file)
            })
            .collect(),
    )
}

fn named(fqn: &str) -> Type {
    Type::named(fqn)
}

/// Files that call into each other.
const PROJECT: &[&str] = &[
    "<?php\nnamespace App;\nfunction make() { return new Repo(); }\nfunction chain() { return make()->find(); }\n",
    "<?php\nnamespace App;\nclass Repo {\n  public function find() { return $this->first(); }\n  public function first(): ?Book { return null; }\n  public function fluent() { return $this; }\n  public function made() { return new static(); }\n  public static function instance() { return new self(); }\n}\nclass ChildRepo extends Repo {}\n",
    "<?php\nnamespace App;\nclass Book {\n  const KIND = 'book';\n  const ALIAS = self::KIND;\n  public $title = 'Untitled';\n  public $pages = [1, 2];\n  public static $shelf = Shelf::Top;\n  public static function create() { return new static(); }\n  public function shelf() { return static::$shelf; }\n}\nclass Novel extends Book {}\nenum Shelf { case Top; case Bottom; }\nconst DEFAULT_KIND = Book::KIND;\nconst ANSWER = 42;\n",
    "<?php\nnamespace App;\nfunction local_len() { return global_len(); }\nfunction answer() { return ANSWER; }\nfunction global_answer() { return PHP_LIMIT; }\n",
    "<?php\nfunction global_len(): int { return 0; }\nconst PHP_LIMIT = 10;\n",
];

#[test]
fn chains_across_files() {
    let decls = summaries(PROJECT);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let cx = Context::default();

    assert_eq!(r.function_return("App\\make"), Some(named("App\\Repo")));
    // make() -> Repo, Repo::find() -> $this->first() -> ?Book.
    assert_eq!(r.function_return("\\App\\chain"), Some(named("App\\Book").nullable()));
    // An unqualified call falls back to the global function.
    assert_eq!(r.function_return("App\\local_len"), Some(Type::Int));
    // An unqualified constant: the namespaced one, else the global one.
    assert_eq!(r.function_return("App\\answer"), Some(Type::Int));
    assert_eq!(r.function_return("App\\global_answer"), Some(Type::Int));
    assert_eq!(r.function_return("App\\missing"), None);

    // Constant values keep their literal type; defaults are widened.
    assert_eq!(r.constant_type("App\\DEFAULT_KIND"), Some(Type::LiteralString("book".into())));
    assert_eq!(r.class_constant_type(&named("App\\Novel"), "ALIAS", &cx), Type::LiteralString("book".into()));
    assert_eq!(r.property_type(&named("App\\Book"), "title", &cx), Type::string());
    assert_eq!(
        r.property_type(&named("App\\Book"), "pages", &cx),
        Type::List { value: Box::new(Type::Int), non_empty: true }
    );
    // An enum case is the enum.
    assert_eq!(r.property_type(&named("App\\Book"), "shelf", &cx), named("App\\Shelf"));
    assert_eq!(r.method_return(&named("App\\Novel"), "shelf", &cx), named("App\\Shelf"));
    assert_eq!(r.class_constant_type(&named("App\\Shelf"), "Bottom", &cx), named("App\\Shelf"));

    // `static` and `$this` are the receiver, `self` the declaring class.
    assert_eq!(r.method_return(&named("App\\ChildRepo"), "fluent", &cx), named("App\\ChildRepo"));
    assert_eq!(r.method_return(&named("App\\ChildRepo"), "made", &cx), named("App\\ChildRepo"));
    assert_eq!(r.method_return(&named("App\\ChildRepo"), "instance", &cx), named("App\\Repo"));
    assert_eq!(r.method_return(&named("App\\Novel"), "create", &cx), named("App\\Novel"));
    assert_eq!(r.method_return(&named("App\\Repo"), "fluent", &cx), named("App\\Repo"));
    // Inside the class with `static` unknown, the marker stays.
    let inside = Context::in_class("App\\Repo");
    assert_eq!(r.method_return(&Type::Relative(Relative::This), "fluent", &inside), Type::Relative(Relative::This));
    let bound = Context { self_class: Some("App\\Repo".into()), static_type: Some(named("App\\ChildRepo")) };
    assert_eq!(r.method_return(&Type::Relative(Relative::This), "fluent", &bound), named("App\\ChildRepo"));

    // Lazy types built by hand.
    let lazy = LazyType::MethodReturn {
        receiver: Box::new(LazyType::FunctionReturn { fqn: "App\\make".into(), fallback: None }),
        name: "find".into(),
    };
    assert_eq!(r.resolve(&lazy, &cx), named("App\\Book").nullable());
    assert_eq!(r.resolve(&LazyType::Known(Type::Relative(Relative::Self_)), &inside), named("App\\Repo"));
}

#[test]
fn unions_are_resolved_per_member_and_unknowns_are_mixed() {
    let decls = summaries(&[
        "<?php\nclass A { public function name(): string { return ''; } }\nclass B { public function name(): int { return 0; } }\nclass C {}\n",
        "<?php\nfunction pick(bool $f) { return $f ? new A() : new B(); }\nfunction maybe(bool $f) { return $f ? new A() : null; }\nfunction names(bool $f) { return pick($f)->name(); }\nfunction maybe_name(bool $f) { return maybe($f)?->name(); }\nfunction unknown() { return nowhere(); }\nfunction no_method() { return (new C())->name(); }\nfunction scalar() { return 'x'; }\nfunction on_scalar() { return scalar()->name(); }\nfunction param(A $a) { return $a->name(); }\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let cx = Context::default();

    assert_eq!(r.function_return("pick"), Some(Type::union([named("A"), named("B")])));
    assert_eq!(r.function_return("names"), Some(Type::union([Type::string(), Type::Int])));
    // `null` has no members: it contributes nothing, but `?->` adds null.
    assert_eq!(r.function_return("maybe_name"), Some(Type::union([Type::Null, Type::string()])));
    assert_eq!(r.method_return(&named("A").nullable(), "name", &cx), Type::string());
    assert_eq!(r.function_return("unknown"), Some(Type::Mixed));
    assert_eq!(r.function_return("no_method"), Some(Type::Mixed));
    assert_eq!(r.function_return("on_scalar"), Some(Type::Mixed));
    assert_eq!(r.function_return("param"), Some(Type::string()));
    assert_eq!(r.method_return(&Type::Int, "name", &cx), Type::Mixed);
    let intersection = Type::intersection([named("C"), named("B")]);
    assert_eq!(r.method_return(&intersection, "name", &cx), Type::Int);
}

#[test]
fn cycles_end() {
    let decls = summaries(&[
        "<?php\nfunction a() { return a(); }\nfunction b(bool $x) { if ($x) { return 1; } return b($x); }\nfunction c() { return d(); }\nfunction d() { return c(); }\nfunction e(bool $x) { if ($x) { return 'x'; } return f(); }\nfunction f() { return e(true); }\nconst K1 = K2;\nconst K2 = K1;\n",
        "<?php\nclass P { public function m() { return $this->n(); } public function n() { return $this->m(); } public $p = self::Q; const Q = self::R; const R = self::Q; }\nclass X extends Y { public function own() { return $this->own(); } }\nclass Y extends X {}\ninterface I extends J {}\ninterface J extends I {}\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let cx = Context::default();

    assert_eq!(r.function_return("a"), Some(Type::Mixed));
    assert_eq!(r.function_return("b"), Some(Type::Int));
    assert_eq!(r.function_return("c"), Some(Type::Mixed));
    assert_eq!(r.function_return("d"), Some(Type::Mixed));
    // The cycle through f() adds nothing to e()'s own answer.
    assert_eq!(r.function_return("e"), Some(Type::string()));
    assert_eq!(r.function_return("f"), Some(Type::string()));
    assert_eq!(r.constant_type("K1"), Some(Type::Mixed));
    assert_eq!(r.method_return(&named("P"), "m", &cx), Type::Mixed);
    assert_eq!(r.property_type(&named("P"), "p", &cx), Type::Mixed);
    // Cyclic inheritance: lookups stop.
    assert_eq!(r.method_return(&named("Y"), "missing", &cx), Type::Mixed);
    assert_eq!(r.method_return(&named("Y"), "own", &cx), Type::Mixed);
    assert_eq!(r.method_return(&named("I"), "missing", &cx), Type::Mixed);

    // A fresh resolver on a cold cache agrees, whatever is asked first.
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    assert_eq!(r.function_return("f"), Some(Type::string()));
    assert_eq!(r.function_return("e"), Some(Type::string()));
}

#[test]
fn deep_chains_stop_at_the_depth_limit() {
    let mut source = String::from("<?php\n");
    for i in 0..40 {
        source.push_str(&format!("function f{i}() {{ return f{}(); }}\n", i + 1));
    }
    source.push_str("function f40() { return 1; }\n");
    let decls = summaries(&[&source]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    assert_eq!(r.function_return("f0"), Some(Type::Mixed));
    // What was cut short isn't cached: a shorter chain still resolves...
    assert_eq!(r.function_return("f20"), Some(Type::Int));
    // ...and with its end cached, the rest is within reach.
    assert_eq!(r.function_return("f0"), Some(Type::Int));
}

#[test]
fn the_cache_is_dropped_when_the_generation_moves() {
    let before = summaries(&["<?php\nfunction a() { return b(); }\nfunction b() { return 1; }\n"]);
    let after = summaries(&["<?php\nfunction a() { return b(); }\nfunction b() { return 'x'; }\n"]);
    let cache = TypeCache::new();

    assert_eq!(Resolver::new(&before, &cache, 1).function_return("a"), Some(Type::Int));
    assert_eq!(cache.len(1), 2);
    // Same generation: the cached answers stand, even over other files.
    assert_eq!(Resolver::new(&after, &cache, 1).function_return("a"), Some(Type::Int));
    // The counter moved: resolved again.
    assert!(cache.is_empty(2));
    assert_eq!(Resolver::new(&after, &cache, 2).function_return("a"), Some(Type::string()));
    assert_eq!(cache.len(1), 0);
    assert_eq!(cache.len(2), 2);
}

#[test]
fn declared_types_win_over_inference() {
    let decls = summaries(&[
        "<?php\nnamespace App;\n/** @template T */\nclass Box {\n  /** @var list<string> */\n  public $names = [];\n  /** @return T */\n  public function get() { return 1; }\n  /** @return static */\n  public function copy() { return new self(); }\n  public function hinted(): self { return $this; }\n}\nclass Crate extends Box {}\n/** @return non-empty-string */\nfunction label() { return 'x'; }\n/**\n * @property-read int $size\n * @method static Crate open()\n */\nclass Magic {}\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let cx = Context::default();
    assert_eq!(r.property_type(&named("App\\Box"), "names", &cx), Type::list_of(Type::string()));
    assert_eq!(r.method_return(&named("App\\Box"), "get", &cx), Type::Template("T".into()));
    assert_eq!(r.method_return(&named("App\\Crate"), "copy", &cx), named("App\\Crate"));
    assert_eq!(r.method_return(&named("App\\Crate"), "hinted", &cx), named("App\\Box"));
    assert_eq!(r.function_return("App\\label"), Some(Type::String(crate::types::StringKind::NonEmpty)));
    assert_eq!(r.property_type(&named("App\\Magic"), "size", &cx), Type::Int);
    assert_eq!(r.method_return(&named("App\\Magic"), "open", &cx), named("App\\Crate"));
}

#[test]
fn trait_members_see_the_using_class() {
    let decls = summaries(&[
        "<?php\ntrait Makes { public function make() { return new self(); } public function me() { return $this; } }\nclass Factory { use Makes; }\nclass Sub extends Factory {}\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let cx = Context::default();
    assert_eq!(r.method_return(&named("Sub"), "make", &cx), named("Factory"));
    assert_eq!(r.method_return(&named("Sub"), "me", &cx), named("Sub"));
}
