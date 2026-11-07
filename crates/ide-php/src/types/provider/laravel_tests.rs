use super::core_alias;
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::{Resolver, SummarySet, TypeCache, type_at};

const CARET: &str = "/*|*/";

/// Just enough of laravel/framework (the signatures as Laravel declares
/// them, the bodies empty).
const FRAMEWORK: &str = r#"<?php
namespace Illuminate\Contracts\Container {
    interface Container {
        /** @return mixed */
        public function make($abstract, array $parameters = []);
    }
}
namespace Illuminate\Container {
    class Container implements \Illuminate\Contracts\Container\Container {
        /** @return mixed */
        public function make($abstract, array $parameters = []) { return null; }
        /** @return mixed */
        public function makeWith($abstract, array $parameters = []) { return null; }
    }
}
namespace Illuminate\Support\Facades {
    abstract class Facade {
        public static function __callStatic($method, $args): mixed { return null; }
    }
    class App extends Facade {
        protected static function getFacadeAccessor() { return 'app'; }
    }
}
namespace Illuminate\Cache {
    class CacheManager {
        public function store(?string $name = null): Repository { return new Repository(); }
    }
    class Repository {
        public function has(string $key): bool { return false; }
    }
}
namespace Illuminate\Database\Query {
    class Builder {
        public function where($column, $operator = null, $value = null): static { return $this; }
        public function orderBy($column): static { return $this; }
        public function count(): int { return 0; }
    }
}
namespace Illuminate\Database\Eloquent {
    /** @template TModel */
    class Builder {
        /** @return TModel|null */
        public function first() { return null; }
        public function __call($method, $args): mixed { return null; }
    }
    /**
     * @template TKey
     * @template TModel
     */
    class Collection {}
    abstract class Model {
        public function __call($method, $args): mixed { return null; }
        public static function __callStatic($method, $args): mixed { return null; }
        public function __get($key): mixed { return null; }
        public function hasMany($related): Relations\HasMany { return new Relations\HasMany(); }
        public function belongsTo($related): Relations\BelongsTo { return new Relations\BelongsTo(); }
        public function belongsToMany($related): Relations\BelongsToMany { return new Relations\BelongsToMany(); }
        public static function query(): Builder { return new Builder(); }
    }
}
namespace Illuminate\Database\Eloquent\Relations {
    abstract class Relation {
        public function __call($method, $args): mixed { return null; }
    }
    /**
     * @template TRelatedModel
     * @template TDeclaringModel
     */
    class HasMany extends Relation {}
    class BelongsTo extends Relation {}
    class BelongsToMany extends Relation {}
}
namespace Illuminate\Database\Eloquent\Casts {
    /** @template TGet */
    class Attribute {}
}
namespace {
    /** @return mixed */
    function app($abstract = null, array $parameters = []) { return null; }
    /** @return mixed */
    function resolve($name, array $parameters = []) { return null; }
}
"#;

/// The class that says laravel/framework is installed.
const APPLICATION: &str = r#"<?php
namespace Illuminate\Foundation;
class Application extends \Illuminate\Container\Container {
    public function version(): string { return ''; }
}
"#;

const APP: &str = r#"<?php
namespace App\Services {
    class PaymentGateway {
        public function charge(int $cents): bool { return true; }
    }
}
namespace App\Facades {
    use Illuminate\Support\Facades\Facade;
    class Payments extends Facade {
        protected static function getFacadeAccessor(): string { return \App\Services\PaymentGateway::class; }
    }
    class Cache extends Facade {
        protected static function getFacadeAccessor() { return 'cache'; }
    }
    /** @method static int documented() */
    class Documented extends Facade {
        protected static function getFacadeAccessor() { return 'cache'; }
    }
}
namespace App\Models {
    use Illuminate\Database\Eloquent\Builder;
    use Illuminate\Database\Eloquent\Casts\Attribute;
    use Illuminate\Database\Eloquent\Model;
    class Post extends Model {
        public function author() { return $this->belongsTo(User::class); }
    }
    class Tag extends Model {}
    class User extends Model {
        public function posts() { return $this->hasMany(Post::class); }
        public function tags() { return $this->belongsToMany(Tag::class); }
        public function scopeActive(Builder $query) { return $query->where('active', 1); }
        public function getFullNameAttribute(): string { return ''; }
        /** @return Attribute<int> */
        protected function age(): Attribute { return new Attribute(); }
        public function plain(): int { return 1; }
    }
    function admins() { return User::where('admin', 1); }
}
"#;

const HEADER: &str = "<?php
namespace Main;
use App\\Models\\{User, Post};
use App\\Facades\\{Payments, Cache, Documented};
use App\\Services\\PaymentGateway;
use Illuminate\\Support\\Facades\\App;
use function App\\Models\\admins;
";

/// The type at the caret in `HEADER` + `body`, the `libs` declared too.
fn type_in(libs: &[&str], body: &str) -> String {
    let source = format!("{HEADER}{body}");
    let offset = source.find(CARET).unwrap_or_else(|| panic!("no caret in {source}"));
    let source = source.replacen(CARET, "", 1);
    let file = ParsedFile::parse("main.php", source.as_str());
    assert!(!file.has_errors(), "{source}: {:?}", file.errors());
    let mut summaries = vec![FileSummary::extract(&file)];
    for (i, lib) in libs.iter().enumerate() {
        let name = if lib.contains("namespace PHPSTORM_META") {
            ".phpstorm.meta.php".to_owned()
        } else {
            format!("lib{i}.php")
        };
        let lib = ParsedFile::parse(name.as_str(), *lib);
        assert!(!lib.has_errors(), "{:?}", lib.errors());
        summaries.push(FileSummary::extract(&lib));
    }
    let decls = SummarySet::new(summaries);
    let cache = TypeCache::new();
    let resolver = Resolver::new(&decls, &cache, 1);
    type_at(&file, &resolver, offset as u32).map(|ty| ty.to_string()).unwrap_or_else(|| "<none>".to_owned())
}

fn check(libs: &[&str], cases: &[(&str, &str)]) {
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|(body, expected)| {
            let got = type_in(libs, body);
            (got != *expected).then(|| format!("{body}\n  expected {expected}\n  got      {got}"))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

const INSTALLED: &[&str] = &[FRAMEWORK, APPLICATION, APP];
const BUILDER: &str = "Illuminate\\Database\\Eloquent\\Builder<App\\Models\\User>";

#[test]
fn container_helpers() {
    check(
        INSTALLED,
        &[
            ("app(PaymentGateway::class)/*|*/;", "App\\Services\\PaymentGateway"),
            ("\\app('App\\Services\\PaymentGateway')/*|*/;", "App\\Services\\PaymentGateway"),
            ("resolve(PaymentGateway::class)/*|*/;", "App\\Services\\PaymentGateway"),
            ("app('cache')/*|*/;", "Illuminate\\Cache\\CacheManager"),
            ("app('cache')->store()/*|*/;", "Illuminate\\Cache\\Repository"),
            ("app()/*|*/;", "Illuminate\\Foundation\\Application"),
            ("app()->make(PaymentGateway::class)/*|*/;", "App\\Services\\PaymentGateway"),
            ("app()->makeWith('cache', [])/*|*/;", "Illuminate\\Cache\\CacheManager"),
            ("app(PaymentGateway::class)->charge(1)/*|*/;", "bool"),
            // Unknown bindings and dynamic arguments stay unknown.
            ("app('unknown.binding')/*|*/;", "mixed"),
            ("app($name)/*|*/;", "mixed"),
        ],
    );
    // A helper of the same name in the caller's namespace is that one.
    check(INSTALLED, &[("function app(): int { return 1; }\napp(PaymentGateway::class)/*|*/;", "int")]);
    assert_eq!(core_alias("db"), Some("Illuminate\\Database\\DatabaseManager"));
    assert_eq!(core_alias("nope"), None);
}

#[test]
fn facades_forward_to_their_service() {
    check(
        INSTALLED,
        &[
            // A class accessor (with a `: string` hint) and an alias one.
            ("Payments::charge(1)/*|*/;", "bool"),
            ("Cache::store()/*|*/;", "Illuminate\\Cache\\Repository"),
            ("Cache::store()->has('k')/*|*/;", "bool"),
            ("App::make(PaymentGateway::class)/*|*/;", "App\\Services\\PaymentGateway"),
            ("App::make('cache')/*|*/;", "Illuminate\\Cache\\CacheManager"),
            // `@method static` on the facade wins.
            ("Documented::documented()/*|*/;", "int"),
            // Neither the facade nor the service has it.
            ("Payments::refund()/*|*/;", "mixed"),
        ],
    );
}

#[test]
fn eloquent_builder_forwarding() {
    check(
        INSTALLED,
        &[
            ("User::where('a', 1)/*|*/;", BUILDER),
            ("User::whereEmail('a@b.c')/*|*/;", BUILDER),
            ("User::active()/*|*/;", BUILDER),
            ("User::query()/*|*/;", BUILDER),
            ("User::where('a', 1)->active()/*|*/;", BUILDER),
            ("User::where('a', 1)->orderBy('a')->whereName('x')/*|*/;", BUILDER),
            ("User::where('a', 1)->first()/*|*/;", "?App\\Models\\User"),
            ("User::where('a', 1)->count()/*|*/;", "int"),
            ("(new User())->where('a', 1)/*|*/;", BUILDER),
            // Declared methods win; unknown ones stay unknown.
            ("User::plain()/*|*/;", "int"),
            ("User::frobnicate()/*|*/;", "mixed"),
            ("User::where('a', 1)->frobnicate()/*|*/;", "mixed"),
            // Through a summary: another file's untyped function.
            ("admins()/*|*/;", BUILDER),
        ],
    );
}

#[test]
fn eloquent_relations_and_accessors() {
    let has_many = "Illuminate\\Database\\Eloquent\\Relations\\HasMany<App\\Models\\Post, App\\Models\\User>";
    check(
        INSTALLED,
        &[
            ("(new User())->posts()/*|*/;", has_many),
            ("(new User())->posts()->whereTitle('x')/*|*/;", has_many),
            ("(new User())->posts/*|*/;", "Illuminate\\Database\\Eloquent\\Collection<int, App\\Models\\Post>"),
            ("(new User())->tags/*|*/;", "Illuminate\\Database\\Eloquent\\Collection<int, App\\Models\\Tag>"),
            ("(new Post())->author/*|*/;", "?App\\Models\\User"),
            ("(new Post())->author->posts/*|*/;", "Illuminate\\Database\\Eloquent\\Collection<int, App\\Models\\Post>"),
            ("(new User())->full_name/*|*/;", "string"),
            ("(new User())->age/*|*/;", "int"),
            ("(new User())->nothing/*|*/;", "mixed"),
            // Not a relation: a plain method's name isn't a property.
            ("(new User())->plain/*|*/;", "mixed"),
            (
                "class Me extends User { function f() { $this->posts/*|*/; } }",
                "Illuminate\\Database\\Eloquent\\Collection<int, App\\Models\\Post>",
            ),
        ],
    );
}

/// An ide-helper style `.phpstorm.meta.php`.
const META: &str = r#"<?php
namespace PHPSTORM_META {
    override(\app(0), map(['payments' => \App\Services\PaymentGateway::class]));
}
"#;

const STORED: &str = r#"<?php
namespace App\Http;
function payments() { return app('payments'); }
function gateway() { return app(\App\Services\PaymentGateway::class); }
"#;

#[test]
fn meta_overrides_still_apply() {
    let libs = [FRAMEWORK, APPLICATION, APP, META, STORED];
    check(
        &libs,
        &[
            ("app('payments')/*|*/;", "App\\Services\\PaymentGateway"),
            ("app('cache')/*|*/;", "Illuminate\\Cache\\CacheManager"),
            // Through summaries: the stored payload keeps the meta fallback.
            ("\\App\\Http\\payments()/*|*/;", "App\\Services\\PaymentGateway"),
            ("\\App\\Http\\gateway()/*|*/;", "App\\Services\\PaymentGateway"),
        ],
    );
}

#[test]
fn off_without_laravel() {
    // The same code without laravel/framework's `Application`: nothing
    // from the provider.
    check(
        &[FRAMEWORK, APP],
        &[
            ("app(PaymentGateway::class)/*|*/;", "mixed"),
            ("Payments::charge(1)/*|*/;", "mixed"),
            ("User::where('a', 1)/*|*/;", "mixed"),
            ("(new User())->posts/*|*/;", "mixed"),
            ("(new User())->posts()/*|*/;", "Illuminate\\Database\\Eloquent\\Relations\\HasMany"),
            ("User::plain()/*|*/;", "int"),
        ],
    );
}

#[test]
fn facade_accessor_value_is_summarised() {
    let summary = FileSummary::extract(&ParsedFile::parse("app.php", APP));
    let class = summary.class_like("App\\Facades\\Payments").unwrap();
    let accessor = class.methods.iter().find(|method| method.name == "getFacadeAccessor").unwrap();
    assert_eq!(
        accessor.inferred_return.as_ref().map(ToString::to_string).as_deref(),
        Some("class-string<App\\Services\\PaymentGateway>")
    );
}
