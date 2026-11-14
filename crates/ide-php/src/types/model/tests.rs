use super::*;
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::{Context, Hierarchy, Relative, Resolver, SummarySet, TypeCache};

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

fn names<T: std::ops::Deref<Target = MemberInfo>>(members: &Members<T>) -> Vec<String> {
    let mut names: Vec<String> = members.iter().map(|member| member.name.clone()).collect();
    names.sort();
    names
}

#[test]
fn diamond_interfaces() {
    let decls = summaries(&[
        "<?php\nnamespace App;\ninterface Base { const VERSION = 1; public function id(): int; }\ninterface Left extends Base { public function left(): string; }\ninterface Right extends Base { public function right(): string; public function id(): int; }\ninterface Both extends Left, Right {}\nabstract class Impl implements Both { public function id(): int { return 1; } }\nclass Concrete extends Impl implements Left { public function left(): string { return ''; } public function right(): string { return ''; } }\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);

    let both = r.class_model("App\\Both").unwrap();
    assert_eq!(both.interfaces, ["App\\Left", "App\\Base", "App\\Right"]);
    assert!(both.parents.is_empty());
    assert_eq!(names(&both.methods), ["id", "left", "right"]);
    // `id` comes once, from the first path that has it.
    assert_eq!(both.method("ID").unwrap().self_class, "App\\Base");
    assert_eq!(both.constant("VERSION").unwrap().self_class, "App\\Base");

    let concrete = r.class_model("\\App\\Concrete").unwrap();
    assert_eq!(concrete.parents, ["App\\Impl"]);
    assert_eq!(concrete.interfaces, ["App\\Both", "App\\Left", "App\\Base", "App\\Right"]);
    assert_eq!(names(&concrete.methods), ["id", "left", "right"]);
    let id = concrete.method("id").unwrap();
    assert_eq!(id.self_class, "App\\Impl");
    assert!(!id.is_abstract);
    // Impl::id implements Base::id; Concrete::left implements Left::left.
    assert_eq!(id.overrides.as_deref(), Some("App\\Base"));
    assert_eq!(concrete.method("left").unwrap().overrides.as_deref(), Some("App\\Left"));
    assert!(concrete.constant("VERSION").is_some());

    for sup in ["App\\Concrete", "App\\Impl", "\\App\\Both", "App\\Base", "app\\right"] {
        assert!(concrete.is_subclass_of(sup), "{sup}");
        assert!(r.is_subclass("App\\Concrete", sup), "{sup}");
    }
    assert!(!concrete.is_subclass_of("App\\Other"));
    assert!(!r.is_subclass("App\\Base", "App\\Concrete"));
    let int = Type::Int;
    assert_eq!(r.method_return(&Type::named("App\\Concrete"), "id", &Context::default()), int);
    assert!(Type::named("App\\Concrete").is_subtype_of(&Type::named("App\\Base"), &r));
}

#[test]
fn trait_aliasing_and_conflicts() {
    let decls = summaries(&[
        "<?php\ntrait Hello { public function say(): string { return 'hello'; } public function hello() {} private function secret(): int { return 1; } }\ntrait World { public function say(): int { return 1; } public function world() {} }\ntrait Greets { use Hello; public function greet() { return $this; } abstract public function name(): string; }\nclass Talker {\n  use Hello, World {\n    Hello::say insteadof World;\n    World::say as protected sayWorld;\n    hello as private;\n    secret as public reveal;\n  }\n}\nclass Base { public function name(): string { return 'base'; } public function greet() { return 1; } }\nclass Greeter extends Base { use Greets; public $own = 1; }\nclass Mine { use Hello; public function say(): float { return 1.0; } }\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let cx = Context::default();

    let talker = r.class_model("Talker").unwrap();
    assert_eq!(names(&talker.methods), ["hello", "reveal", "say", "sayWorld", "secret", "world"]);
    assert_eq!(talker.traits, ["Hello", "World"]);
    let say = talker.method("say").unwrap();
    assert_eq!(say.declaring.fqn, "Hello");
    assert_eq!(say.origin, Origin::Trait);
    assert_eq!(say.self_class, "Talker");
    // The excluded World::say is still reachable through its alias.
    let say_world = talker.method("sayworld").unwrap();
    assert_eq!(say_world.declaring.fqn, "World");
    assert_eq!(say_world.visibility, Visibility::Protected);
    assert_eq!(talker.method("hello").unwrap().visibility, Visibility::Private);
    assert_eq!(talker.method("reveal").unwrap().visibility, Visibility::Public);
    // A trait's private method stays private to the using class.
    assert_eq!(talker.method("secret").unwrap().visibility, Visibility::Private);
    assert_eq!(r.method_return(&Type::named("Talker"), "say", &cx), Type::string());
    assert_eq!(r.method_return(&Type::named("Talker"), "sayWorld", &cx), Type::Int);
    assert_eq!(r.method_return(&Type::named("Talker"), "reveal", &cx), Type::Int);

    // Traits using traits; the class's trait method overrides the parent's,
    // and the abstract trait method is satisfied by the parent's.
    let greeter = r.class_model("Greeter").unwrap();
    assert_eq!(greeter.traits, ["Greets", "Hello"]);
    let greet = greeter.method("greet").unwrap();
    assert_eq!((greet.origin, greet.declaring.fqn.as_str()), (Origin::Trait, "Greets"));
    assert_eq!(greet.overrides.as_deref(), Some("Base"));
    let name = greeter.method("name").unwrap();
    assert_eq!(name.self_class, "Base");
    assert!(!name.is_abstract);
    assert_eq!(greeter.method("say").unwrap().self_class, "Greeter");
    assert_eq!(r.method_return(&Type::named("Greeter"), "greet", &cx), Type::named("Greeter"));
    assert_eq!(r.method_return(&Type::named("Greeter"), "say", &cx), Type::string());

    // The class's own method wins over the trait's.
    let mine = r.class_model("Mine").unwrap();
    assert_eq!(mine.method("say").unwrap().origin, Origin::Declared);
    assert_eq!(r.method_return(&Type::named("Mine"), "say", &cx), Type::Float);
}

#[test]
fn enum_methods() {
    let decls = summaries(&[
        "<?php\nnamespace App;\ninterface HasLabel { public function label(): string; }\nenum Suit: string implements HasLabel {\n  case Hearts = 'H';\n  case Spades = 'S';\n  const Wild = self::Spades;\n  public function label(): string { return ucfirst($this->name); }\n  public static function fromChar(string $c): self { return self::from($c); }\n}\nenum Status { case On; case Off; }\nenum Level: int { case Low = 1; }\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let cx = Context::default();
    let suit = Type::named("App\\Suit");

    let model = r.class_model("App\\Suit").unwrap();
    assert_eq!(names(&model.methods), ["cases", "from", "fromChar", "label", "tryFrom"]);
    assert_eq!(names(&model.properties), ["name", "value"]);
    assert_eq!(names(&model.constants), ["Hearts", "Spades", "Wild"]);
    assert_eq!(model.interfaces, ["App\\HasLabel", "UnitEnum", "BackedEnum"]);
    assert!(model.method("tryfrom").unwrap().is_static);
    assert_eq!(model.method("cases").unwrap().origin, Origin::Builtin);
    assert_eq!(model.method("label").unwrap().overrides.as_deref(), Some("App\\HasLabel"));
    assert!(model.constant("Hearts").unwrap().case().is_some());
    assert!(model.is_subclass_of("BackedEnum"));

    assert_eq!(r.method_return(&suit, "cases", &cx), Type::list_of(suit.clone()));
    assert_eq!(r.method_return(&suit, "from", &cx), suit);
    assert_eq!(r.method_return(&suit, "tryFrom", &cx), suit.clone().nullable());
    assert_eq!(r.method_return(&suit, "fromChar", &cx), suit);
    assert_eq!(r.property_type(&suit, "name", &cx), Type::string());
    assert_eq!(r.property_type(&suit, "value", &cx), Type::string());
    assert_eq!(r.class_constant_type(&suit, "Hearts", &cx), suit);
    assert_eq!(r.class_constant_type(&suit, "Wild", &cx), suit);
    // Inside the enum, `static::cases()` stays late-bound.
    let inside = Context::in_class("App\\Suit");
    assert_eq!(
        r.method_return(&Type::Relative(Relative::Static), "cases", &inside),
        Type::list_of(Type::Relative(Relative::Static))
    );
    // `self::tryFrom()` keeps the late static binding too.
    assert_eq!(
        r.method_return(&Type::Relative(Relative::Self_), "tryFrom", &inside),
        Type::Relative(Relative::Static).nullable()
    );

    // A pure enum has `cases()` and `name` only.
    let status = r.class_model("App\\Status").unwrap();
    assert_eq!(names(&status.methods), ["cases"]);
    assert_eq!(names(&status.properties), ["name"]);
    assert_eq!(status.interfaces, ["UnitEnum"]);
    assert_eq!(r.property_type(&Type::named("App\\Level"), "value", &cx), Type::Int);
}

#[test]
fn magic_members_and_mixins() {
    let decls = summaries(&[
        "<?php\nnamespace App;\nclass Query { public function where(): static { return $this; } public function first(): ?Model { return null; } protected function hidden() {} }\n/**\n * @property int $id\n * @property-read string $slug\n * @method static Query query()\n * @method string name()\n * @mixin Query\n */\nclass Model { public function name(): int { return 1; } public $id = 'x'; }\n/** @method Post fresh() */\nclass Post extends Model {}\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let cx = Context::default();
    let post = Type::named("App\\Post");

    let model = r.class_model("App\\Post").unwrap();
    assert_eq!(names(&model.methods), ["first", "fresh", "name", "query", "where"]);
    assert_eq!(model.mixins, ["App\\Query"]);
    // Real members beat magic ones, magic ones beat mixins.
    assert_eq!(model.method("name").unwrap().origin, Origin::Declared);
    assert_eq!(model.method("query").unwrap().origin, Origin::Magic);
    assert!(model.method("query").unwrap().is_static);
    assert_eq!(model.method("where").unwrap().origin, Origin::Mixin);
    assert!(model.method("hidden").is_none());
    assert_eq!(model.property("id").unwrap().origin, Origin::Declared);
    assert!(model.property("$slug").unwrap().is_readonly);

    assert_eq!(r.method_return(&post, "name", &cx), Type::Int);
    assert_eq!(r.method_return(&post, "fresh", &cx), post);
    assert_eq!(r.method_return(&post, "query", &cx), Type::named("App\\Query"));
    assert_eq!(r.property_type(&post, "slug", &cx), Type::string());
    // In a mixin's method, `static` is the mixin, not the receiver.
    assert_eq!(r.method_return(&post, "where", &cx), Type::named("App\\Query"));
    assert_eq!(r.method_return(&post, "first", &cx), Type::named("App\\Model").nullable());
}

#[test]
fn visibility_from_a_scope() {
    let decls = summaries(&[
        "<?php\nclass A { public function pub() {} protected function prot() {} private function priv() {} private $secret; protected $shared; }\nclass B extends A { private function own() {} }\nclass C extends B {}\nclass Other {}\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let (a, b, c, other) = (
        r.class_model("A").unwrap(),
        r.class_model("B").unwrap(),
        r.class_model("C").unwrap(),
        r.class_model("Other").unwrap(),
    );
    // Private members aren't inherited.
    assert_eq!(names(&b.methods), ["own", "prot", "pub"]);
    assert_eq!(names(&b.properties), ["shared"]);
    assert_eq!(names(&a.properties), ["secret", "shared"]);

    let accessible = |model: &ClassModel, scope: Option<&ClassModel>| {
        let mut names: Vec<String> = model.accessible_methods(scope).map(|m| m.name.clone()).collect();
        names.sort();
        names
    };
    assert_eq!(accessible(&a, None), ["pub"]);
    assert_eq!(accessible(&a, Some(&other)), ["pub"]);
    assert_eq!(accessible(&a, Some(&a)), ["priv", "prot", "pub"]);
    // Protected members of A are reachable from a subclass, and from A on
    // a subclass object; B's private method only inside B.
    assert_eq!(accessible(&a, Some(&c)), ["prot", "pub"]);
    assert_eq!(accessible(&c, Some(&a)), ["prot", "pub"]);
    assert_eq!(accessible(&b, Some(&b)), ["own", "prot", "pub"]);
    assert_eq!(accessible(&c, Some(&b)), ["prot", "pub"]);
    assert_eq!(accessible(&c, Some(&other)), ["pub"]);
    let shared: Vec<&str> = a.accessible_properties(Some(&c)).map(|p| p.name.as_str()).collect();
    assert_eq!(shared, ["shared"]);
}

#[test]
fn self_static_and_parent_in_context() {
    let decls = summaries(&[
        "<?php\nclass Base { public function make(): static { return new static(); } public function me(): self { return $this; } public static function base(): int { return 1; } }\nclass Child extends Base { public function up() { return parent::make(); } public static function child(): string { return ''; } }\nclass Grand extends Child {}\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);

    let fqns = |ty: &Type, cx: &Context| -> Vec<String> {
        r.class_models(ty, cx).iter().map(|model| model.fqn().to_owned()).collect()
    };
    let in_child = Context::in_class("Child");
    assert_eq!(fqns(&Type::Relative(Relative::Self_), &in_child), ["Child"]);
    assert_eq!(fqns(&Type::Relative(Relative::Parent), &in_child), ["Base"]);
    assert_eq!(fqns(&Type::Relative(Relative::Static), &in_child), ["Child"]);
    let late = Context { self_class: Some("Child".into()), static_type: Some(Type::named("Grand")) };
    assert_eq!(fqns(&Type::Relative(Relative::This), &late), ["Grand"]);
    assert_eq!(fqns(&Type::union([Type::named("Base"), Type::Null, Type::named("Missing")]), &in_child), ["Base"]);

    // `parent::make()` in Child returns the late-bound class.
    assert_eq!(r.method_return(&Type::Relative(Relative::Parent), "make", &late), Type::named("Grand"));
    assert_eq!(r.method_return(&Type::named("Grand"), "up", &Context::default()), Type::named("Grand"));
    assert_eq!(r.method_return(&Type::named("Grand"), "me", &Context::default()), Type::named("Base"));
    assert_eq!(r.method_return(&Type::Relative(Relative::Static), "child", &in_child), Type::string());
}

#[test]
fn cyclic_hierarchies_end_and_models_are_cached() {
    let decls = summaries(&[
        "<?php\nclass X extends Y { public function x() {} }\nclass Y extends X { public function y() {} }\ninterface I extends J {}\ninterface J extends I {}\ntrait T { use U; }\ntrait U { use T; public function u() {} }\nclass UsesT { use T; }\n",
    ]);
    let cache = TypeCache::new();
    let r = Resolver::new(&decls, &cache, 1);
    let y = r.class_model("Y").unwrap();
    assert_eq!(names(&y.methods), ["x", "y"]);
    assert!(r.class_model("I").is_some());
    assert_eq!(names(&r.class_model("UsesT").unwrap().methods), ["u"]);
    assert!(r.class_model("Missing").is_none());

    // Built once per generation, rebuilt after the counter moves.
    let again = Resolver::new(&decls, &cache, 1).class_model("Y").unwrap();
    assert!(Arc::ptr_eq(&y, &again));
    let next = Resolver::new(&decls, &cache, 2).class_model("Y").unwrap();
    assert!(!Arc::ptr_eq(&y, &next));
}
