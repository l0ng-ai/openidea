//! Laravel: facades, Eloquent and the service container.
//!
//! - **Container:** `app(Foo::class)`, `resolve(Foo::class)`,
//!   `$container->make(Foo::class)` (and `makeWith`) are `Foo`; a string
//!   argument names a core alias (`app('cache')` is the cache manager);
//!   `app()` is the application.
//! - **Facades:** a static call on a subclass of `Facade` that the facade
//!   itself doesn't declare (or document with `@method static`) is the call
//!   on the service its `getFacadeAccessor()` names (a class, or a core
//!   alias).
//! - **Eloquent:** a call a model doesn't declare is forwarded to its query
//!   builder (`Builder<Model>`): the builder's own methods, local scopes
//!   (`scopeActive()` called as `active()`) and dynamic `where*` calls. On a
//!   builder or a relation, the query builder's fluent methods, scopes and
//!   dynamic wheres keep the receiver. `$this->hasMany(Post::class)` (and the
//!   other relation methods) is `HasMany<Post, Model>`, and the property of
//!   the same name as a relation method is the related model (`?Post`) or a
//!   collection of them (`Collection<int, Post>`). `getFooBarAttribute()`
//!   and `fooBar(): Attribute<T>` accessors type the property `foo_bar`.
//!
//! Only when laravel/framework is installed (its `Application` class is
//! known); otherwise every payload falls back to what the other providers
//! say. Apart from the container calls (whose declared type is `mixed` or a
//! conditional type), declared and documented types win: the provider only
//! answers where they say `mixed`, or a raw builder or relation. It is
//! first in the registry, so its payloads fall back to the
//! `.phpstorm.meta.php` overrides (ide-helper's `override(\app(0), map(…))`)
//! for bindings it doesn't know.
//!
//! In summaries it stores payloads for relation definitions, the helpers
//! and static calls on a class; instance calls on builders are typed when
//! the expression is.
//!
//! - **Attributes:** a model property nothing else types is the attribute
//!   of that name: its cast (`$casts` or `casts()`: built-in casts, enums,
//!   cast classes through their `get()`), else the column migrations give
//!   the model's table (`$table`, else the snake-case plural of the class
//!   name), nullable when the column is.
//! - **Bindings:** besides the core aliases, `app('id')`, `make('id')` and
//!   facade accessors resolve ids that service providers bind
//!   (`$this->app->singleton('id', …)`; see
//!   [`LaravelFacts`](crate::summary::LaravelFacts)).
//!
//! - **Members** ([`TypeProvider::magic_members`]): after `Facade::` the
//!   service's public methods (as static); after `Model::` the model's
//!   local scopes and the Eloquent and query builders' public methods; on a
//!   builder or relation the related model's scopes and the query
//!   builder's methods (a relation's also the Eloquent builder's); after
//!   `$model->` the relation properties, accessors, cast attributes and
//!   migrated columns, each with where it comes from, and the `*_count` of
//!   the relations the model's `$withCount` counts, or the query that
//!   loaded it (`posts_count`, or the alias of `'posts as drafts_count'`).
//!   Dynamic `where*` calls aren't listed.
//! - **Counts:** `withCount()` on a model, builder or relation and
//!   `loadCount()` on a model or collection give the model type an object
//!   shape argument with the counts (`Post<object{tags_count: int}>`),
//!   which templates carry to what the query loads; `$post->loadCount(…);`
//!   as a statement refines `$post` from there on.
//! - **Scopes:** the raw `Builder $query` parameter of a local scope is the
//!   model's builder ([`TypeProvider::parameter`]).
//! - **Accessors:** `fooBar(): Attribute` without `@return` is typed by the
//!   declared return type of the getter it makes (`Attribute::make(get:
//!   fn (): string => …)`).
//! - **Joins:** `join('users', …)` and the other joins on a model's or a
//!   table's builder add the table (as written, with its alias) to the
//!   builder's generic arguments, for the columns of later calls.
//!
//! The behaviour follows Laravel's public documentation and its MIT source
//! (`Facade::__callStatic`, `Model::__call`, `Builder::__call`,
//! `Application::registerCoreContainerAliases`).

use super::{
    AttributeOrigin, CallKind, CallSite, MagicMember, MagicTarget, ParameterSite, Source, TypeProvider, provided,
};
use crate::frameworks::laravel::validation::rule_type;
use crate::summary::{ClassKind, Column, LaravelFacts, ModelCasts, RequestRules, Visibility, counted_spec};
use crate::types::model::Origin;
use crate::types::{ClassModel, Context, LazyType, Resolver, ShapeField, ShapeKey, Type};

const APPLICATION: &str = "Illuminate\\Foundation\\Application";
const CONTAINER: &str = "Illuminate\\Contracts\\Container\\Container";
const CONTAINER_CLASS: &str = "Illuminate\\Container\\Container";
const FACADE: &str = "Illuminate\\Support\\Facades\\Facade";
const MODEL: &str = "Illuminate\\Database\\Eloquent\\Model";
const JSON_RESOURCE: &str = "Illuminate\\Http\\Resources\\Json\\JsonResource";
/// prettus/l5-repository's repository: calls it doesn't declare go to its
/// model (`__call`).
const PRETTUS_REPOSITORY: &str = "Prettus\\Repository\\Eloquent\\BaseRepository";
const FORM_REQUEST: &str = "Illuminate\\Foundation\\Http\\FormRequest";
const ELOQUENT_BUILDER: &str = "Illuminate\\Database\\Eloquent\\Builder";
const QUERY_BUILDER: &str = "Illuminate\\Database\\Query\\Builder";
const DATABASE_MANAGER: &str = "Illuminate\\Database\\DatabaseManager";
const DATABASE_CONNECTION: &str = "Illuminate\\Database\\ConnectionInterface";
const COLLECTION: &str = "Illuminate\\Database\\Eloquent\\Collection";
const ATTRIBUTE: &str = "Illuminate\\Database\\Eloquent\\Casts\\Attribute";
const RELATIONS: &str = "Illuminate\\Database\\Eloquent\\Relations\\";
const RELATION: &str = "Illuminate\\Database\\Eloquent\\Relations\\Relation";
const JOIN_CLAUSE: &str = "Illuminate\\Database\\Query\\JoinClause";
/// What `$collection->each`, `->map`, `->filter`… are: `<TKey, TValue, …>`.
const HIGHER_ORDER_PROXY: &str = "Illuminate\\Support\\HigherOrderCollectionProxy";
/// Validation rules whose `where()` closure gets the query builder.
const DATABASE_RULES: &[&str] = &["Illuminate\\Validation\\Rules\\Exists", "Illuminate\\Validation\\Rules\\Unique"];
/// Query methods whose closure is a nested query of the same kind.
const NESTED_QUERIES: &[&str] = &[
    "where",
    "orWhere",
    "whereNot",
    "orWhereNot",
    "whereNested",
    "whereExists",
    "orWhereExists",
    "whereNotExists",
    "having",
    "orHaving",
    "havingNested",
];
/// Assertions of Laravel's fakes (`Mail`, `Event`, `Bus`, `Queue`,
/// `Notification`) taking a class and a closure about its objects.
const FAKE_ASSERTIONS: &[&str] = &[
    "assertQueued",
    "assertNotQueued",
    "assertSent",
    "assertNotSent",
    "assertDispatched",
    "assertNotDispatched",
    "assertDispatchedSync",
    "assertPushed",
    "assertNotPushed",
    "assertPushedOn",
    "assertSentTo",
    "assertListening",
];

/// `Conditionable` methods, whose closure gets the object itself.
const CONDITIONAL_CLOSURES: &[&str] = &["when", "unless", "tap"];
const SUPPORT_COLLECTION: &str = "Illuminate\\Support\\Collection";
const FACTORY: &str = "Illuminate\\Database\\Eloquent\\Factories\\Factory";
const CARBON: &str = "Illuminate\\Support\\Carbon";
const CARBON_IMMUTABLE: &str = "Carbon\\CarbonImmutable";
const AUTH_FACTORY: &str = "Illuminate\\Contracts\\Auth\\Factory";
const GUARD: &str = "Illuminate\\Contracts\\Auth\\Guard";
const AUTHENTICATABLE: &str = "Illuminate\\Contracts\\Auth\\Authenticatable";
const HTTP_REQUEST: &str = "Illuminate\\Http\\Request";

/// Laravel's castable classes and the type of the attribute they cast to.
const CAST_CLASSES: &[(&str, &str)] = &[
    ("Illuminate\\Database\\Eloquent\\Casts\\AsCollection", SUPPORT_COLLECTION),
    ("Illuminate\\Database\\Eloquent\\Casts\\AsEncryptedCollection", SUPPORT_COLLECTION),
    ("Illuminate\\Database\\Eloquent\\Casts\\AsArrayObject", "Illuminate\\Database\\Eloquent\\Casts\\ArrayObject"),
    (
        "Illuminate\\Database\\Eloquent\\Casts\\AsEncryptedArrayObject",
        "Illuminate\\Database\\Eloquent\\Casts\\ArrayObject",
    ),
    ("Illuminate\\Database\\Eloquent\\Casts\\AsStringable", "Illuminate\\Support\\Stringable"),
];

/// Model methods defining a relation, and the relation class they return
/// (in [`RELATIONS`]).
const RELATION_METHODS: &[(&str, &str)] = &[
    ("hasOne", "HasOne"),
    ("hasMany", "HasMany"),
    ("belongsTo", "BelongsTo"),
    ("belongsToMany", "BelongsToMany"),
    ("hasOneThrough", "HasOneThrough"),
    ("hasManyThrough", "HasManyThrough"),
    ("morphOne", "MorphOne"),
    ("morphMany", "MorphMany"),
    ("morphToMany", "MorphToMany"),
    ("morphedByMany", "MorphToMany"),
];

/// Relations to many models (their subclasses too).
const TO_MANY: &[&str] = &["HasMany", "MorphMany", "BelongsToMany", "HasManyThrough"];

/// Builder and model methods returning the models found as a collection.
const COLLECTING: &[&str] = &["get", "all", "findMany", "hydrate", "fromQuery"];

/// Factory methods making one model, a collection of them, and the
/// factory's models (one, or a collection after `count(n)`).
const FACTORY_ONE: &[&str] = &["createOne", "makeOne", "createOneQuietly"];
const FACTORY_MANY: &[&str] = &["createMany", "createManyQuietly"];
const FACTORY_MAKE: &[&str] = &["create", "make", "createQuietly"];

/// Query methods taking a relation name and a closure on its query
/// (`whereHas('posts', fn ($q) => …)`), or relations as the keys of an
/// array of closures (`with(['posts' => fn ($q) => …])`).
const RELATION_CLOSURES: &[&str] = &[
    "whereHas",
    "orWhereHas",
    "whereDoesntHave",
    "orWhereDoesntHave",
    "withWhereHas",
    "has",
    "orHas",
    "doesntHave",
    "orDoesntHave",
    "with",
    "load",
    "loadMissing",
    "withCount",
    "loadCount",
    "withExists",
];

/// Methods counting the models of relations (`posts_count`): on a model,
/// its builder or a relation (`withCount`), on a model or a collection of
/// them (`loadCount`).
const COUNTING: &[&str] = &["withCount", "loadCount"];

/// Query builder methods joining a table (its first argument).
pub(crate) const JOINS: &[&str] =
    &["join", "leftJoin", "rightJoin", "crossJoin", "joinWhere", "leftJoinWhere", "rightJoinWhere"];

/// Container methods resolving a binding.
const MAKE_METHODS: &[&str] = &["make", "makeWith"];

/// Laravel's core container aliases (`Application::registerCoreContainerAliases`),
/// each with the first class it is registered for.
const CORE_ALIASES: &[(&str, &str)] = &[
    ("app", APPLICATION),
    ("auth", "Illuminate\\Auth\\AuthManager"),
    ("auth.driver", "Illuminate\\Contracts\\Auth\\Guard"),
    ("auth.password", "Illuminate\\Auth\\Passwords\\PasswordBrokerManager"),
    ("auth.password.broker", "Illuminate\\Auth\\Passwords\\PasswordBroker"),
    ("blade.compiler", "Illuminate\\View\\Compilers\\BladeCompiler"),
    ("cache", "Illuminate\\Cache\\CacheManager"),
    ("cache.store", "Illuminate\\Cache\\Repository"),
    ("config", "Illuminate\\Config\\Repository"),
    ("cookie", "Illuminate\\Cookie\\CookieJar"),
    ("db", "Illuminate\\Database\\DatabaseManager"),
    ("db.connection", "Illuminate\\Database\\Connection"),
    ("db.schema", "Illuminate\\Database\\Schema\\Builder"),
    ("encrypter", "Illuminate\\Encryption\\Encrypter"),
    ("events", "Illuminate\\Events\\Dispatcher"),
    ("files", "Illuminate\\Filesystem\\Filesystem"),
    ("filesystem", "Illuminate\\Filesystem\\FilesystemManager"),
    ("filesystem.cloud", "Illuminate\\Contracts\\Filesystem\\Cloud"),
    ("filesystem.disk", "Illuminate\\Contracts\\Filesystem\\Filesystem"),
    ("hash", "Illuminate\\Hashing\\HashManager"),
    ("hash.driver", "Illuminate\\Contracts\\Hashing\\Hasher"),
    ("log", "Illuminate\\Log\\LogManager"),
    ("mail.manager", "Illuminate\\Mail\\MailManager"),
    ("mailer", "Illuminate\\Mail\\Mailer"),
    ("queue", "Illuminate\\Queue\\QueueManager"),
    ("queue.connection", "Illuminate\\Contracts\\Queue\\Queue"),
    ("queue.failer", "Illuminate\\Queue\\Failed\\FailedJobProviderInterface"),
    ("redirect", "Illuminate\\Routing\\Redirector"),
    ("redis", "Illuminate\\Redis\\RedisManager"),
    ("redis.connection", "Illuminate\\Redis\\Connections\\Connection"),
    ("request", "Illuminate\\Http\\Request"),
    ("router", "Illuminate\\Routing\\Router"),
    ("session", "Illuminate\\Session\\SessionManager"),
    ("session.store", "Illuminate\\Session\\Store"),
    ("translator", "Illuminate\\Translation\\Translator"),
    ("url", "Illuminate\\Routing\\UrlGenerator"),
    ("validator", "Illuminate\\Validation\\Factory"),
    ("view", "Illuminate\\View\\Factory"),
];

/// The class a core container alias stands for.
pub fn core_alias(alias: &str) -> Option<&'static str> {
    CORE_ALIASES.iter().find(|(name, _)| *name == alias).map(|(_, class)| *class)
}

/// See the module documentation.
pub struct LaravelProvider;

fn relation_class(method: &str) -> Option<&'static str> {
    RELATION_METHODS.iter().find(|(name, _)| name.eq_ignore_ascii_case(method)).map(|(_, class)| *class)
}

/// What a Prettus repository finder returns: `Some(true)` for a collection
/// of the model, `Some(false)` for the model.
fn prettus_finder(method: &str) -> Option<bool> {
    // With those Bagisto's base repository adds (`findOrFail()`,
    // `findOneByField()`, `findOneWhere()`).
    const MODEL: &[&str] = &[
        "find",
        "findOrFail",
        "findOneByField",
        "findOneWhere",
        "first",
        "firstOrNew",
        "firstOrCreate",
        "create",
        "update",
        "updateOrCreate",
        "getModel",
        "makeModel",
    ];
    const COLLECTION: &[&str] = &[
        "all",
        "get",
        "findByField",
        "findWhere",
        "findWhereIn",
        "findWhereNotIn",
        "findWhereBetween",
        "getByCriteria",
    ];
    if is_one_of(MODEL, method) { Some(false) } else { is_one_of(COLLECTION, method).then_some(true) }
}

/// `hasPosts`, `forAuthor`: a factory's magic relation methods.
fn is_factory_relation(method: &str) -> bool {
    ["has", "for"].iter().any(|prefix| {
        method.strip_prefix(prefix).is_some_and(|rest| rest.starts_with(|first: char| first.is_ascii_uppercase()))
    })
}

/// The class argument of a relation call written `self::class` or
/// `static::class`, in a payload: the receiver's model.
const OWN_CLASS: &str = "@own";

fn is_one_of(list: &[&str], method: &str) -> bool {
    list.iter().any(|name| name.eq_ignore_ascii_case(method))
}

/// A relation of a model: its method, the related model and whether it
/// relates to many models.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModelRelation {
    pub name: String,
    /// The class declaring the method.
    pub class: String,
    pub related: Option<String>,
    pub many: bool,
    /// The relation class's short name (`HasMany`, `BelongsTo`).
    pub kind: String,
}

fn is_make(method: &str) -> bool {
    MAKE_METHODS.iter().any(|name| name.eq_ignore_ascii_case(method))
}

/// The short name of a function FQN (`App\app` is `app`).
fn short_name(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

/// `whereEmail`: a dynamic where clause.
fn is_dynamic_where(method: &str) -> bool {
    method.len() > 5 && method.get(..5).is_some_and(|prefix| prefix.eq_ignore_ascii_case("where"))
}

impl LaravelProvider {
    fn installed(resolver: &Resolver<'_>) -> bool {
        resolver.class_model(APPLICATION).is_some()
    }

    /// True when some class among the members of `ty` is (a subclass of)
    /// one of `classes`.
    fn is_a(resolver: &Resolver<'_>, ty: &Type, context: &Context, classes: &[&str]) -> bool {
        resolver.class_models(ty, context).iter().any(|model| classes.iter().any(|class| model.is_subclass_of(class)))
    }

    /// The first model class among the members of `ty`.
    fn model_class(resolver: &Resolver<'_>, ty: &Type, context: &Context) -> Option<String> {
        resolver
            .class_models(ty, context)
            .iter()
            .find(|model| model.is_subclass_of(MODEL))
            .map(|model| model.fqn().to_owned())
    }

    /// The class a container binding name stands for: a core alias, a
    /// class that exists, or what a service provider binds to the id.
    fn binding(resolver: &Resolver<'_>, name: &str) -> Option<Type> {
        if let Some(class) = core_alias(name) {
            return Some(Type::named(class));
        }
        let trimmed = name.trim_start_matches('\\');
        if let Some(model) = resolver.class_model(trimmed) {
            return Some(Type::named(model.fqn()));
        }
        let facts = resolver.laravel();
        // A later registration replaces an earlier one.
        facts.bindings.iter().rev().filter(|binding| binding.id == name).find_map(|binding| {
            let ty = resolver.resolve(&binding.target, &Context::default());
            let members: Vec<Type> = ty
                .members()
                .iter()
                .filter_map(|member| match member {
                    Type::Named { .. } => Some(member.clone()),
                    Type::ClassString(Some(class)) if matches!(class.as_ref(), Type::Named { .. }) => {
                        Some(class.as_ref().clone())
                    }
                    Type::LiteralString(class) => resolver.class_model(class).map(|model| Type::named(model.fqn())),
                    _ => None,
                })
                .collect();
            (!members.is_empty()).then(|| Type::union(members))
        })
    }

    /// The service behind a facade: what its `getFacadeAccessor()` returns.
    fn facade_service(resolver: &Resolver<'_>, facade: &Type, context: &Context) -> Option<Type> {
        let models = resolver.class_models(facade, context);
        let model = models.iter().find(|model| model.is_subclass_of(FACADE))?;
        let accessor = model.method("getFacadeAccessor")?;
        let lazy = accessor.declared()?.inferred_return.as_ref()?;
        let value = resolver.resolve(lazy, &Context::in_class(&accessor.self_class));
        value.members().iter().find_map(|member| match member {
            Type::LiteralString(name) => Self::binding(resolver, name),
            Type::ClassString(Some(class)) => match class.as_ref() {
                Type::Named { fqn, .. } => Some(Type::named(fqn)),
                _ => None,
            },
            _ => None,
        })
    }

    /// The model of a Prettus repository among the members of `ty`: the
    /// class its `model()` names, or the one model implementing that
    /// interface (a Concord contract, `Webkul\Product\Contracts\Product`).
    fn repository_model(resolver: &Resolver<'_>, ty: &Type, context: &Context) -> Option<String> {
        let models = resolver.class_models(ty, context);
        let repository = models.iter().find(|model| model.is_subclass_of(PRETTUS_REPOSITORY))?;
        Self::model_of_repository(resolver, repository).or_else(|| {
            // `parent::create()` in a repository: the abstract parent names
            // no model, the class the call is in does.
            let own = resolver.class_model(context.self_class.as_deref()?)?;
            (own.fqn() != repository.fqn() && own.is_subclass_of(repository.fqn()))
                .then(|| Self::model_of_repository(resolver, &own))
                .flatten()
        })
    }

    /// The model `repository`'s `model()` names.
    fn model_of_repository(resolver: &Resolver<'_>, repository: &ClassModel) -> Option<String> {
        let method = repository.method("model")?;
        let lazy = method.declared()?.inferred_return.as_ref()?;
        let value = resolver.resolve(lazy, &Context::in_class(&method.self_class));
        let named = value.members().iter().find_map(|member| match member {
            Type::LiteralString(class) => Some(class.clone()),
            Type::ClassString(Some(class)) => match class.as_ref() {
                Type::Named { fqn, .. } => Some(fqn.clone()),
                _ => None,
            },
            _ => None,
        })?;
        let class = resolver.class_model(&named)?;
        if class.is_subclass_of(MODEL) {
            return Some(class.fqn().to_owned());
        }
        Self::contract_model(resolver, &class)
    }

    /// The model a model contract stands for: an interface without methods
    /// that one Eloquent model implements (Concord's contracts,
    /// `Webkul\Checkout\Contracts\Cart`, which Bagisto types with).
    pub(crate) fn contract_model(resolver: &Resolver<'_>, class: &ClassModel) -> Option<String> {
        if class.class.kind != crate::summary::ClassKind::Interface || !class.methods.is_empty() {
            return None;
        }
        let mut implementing = resolver.direct_subclasses(class.fqn()).into_iter().filter(|fqn| {
            resolver.class_model(fqn).is_some_and(|model| {
                model.class.kind == crate::summary::ClassKind::Class && model.is_subclass_of(MODEL)
            })
        });
        let model = implementing.next()?;
        implementing.next().is_none().then_some(model)
    }

    /// The model of the first model contract among the members of `ty`.
    fn contract_of(resolver: &Resolver<'_>, ty: &Type, context: &Context) -> Option<String> {
        resolver.class_models(ty, context).iter().find_map(|class| Self::stands_for(resolver, class))
    }

    /// The class behind facade `facade` (what its `getFacadeAccessor()`
    /// names), when it is one class.
    pub(crate) fn facade_class(resolver: &Resolver<'_>, facade: &str) -> Option<String> {
        let service = Self::facade_service(resolver, &Type::named(facade), &Context::default())?;
        match service.members() {
            [Type::Named { fqn, .. }] => Some(fqn.trim_start_matches('\\').to_owned()),
            _ => None,
        }
    }

    /// `Auth::user()`, `auth()->user()`, `Auth::guard('admin')->user()` and
    /// `$request->user()` (`user('admin')`): the model of the guard's
    /// provider in `config/auth.php` (the default guard's without a name),
    /// in place of `Authenticatable` (`null` stays). `guard('admin')` gives
    /// the guard with its name as a generic argument, for its `user()`.
    fn auth_user(
        resolver: &Resolver<'_>,
        target: &Type,
        name: &str,
        string: &str,
        core: &Type,
        context: &Context,
    ) -> Option<Type> {
        if name.eq_ignore_ascii_case("guard") {
            if string.is_empty() || !Self::is_a(resolver, target, context, &[AUTH_FACTORY]) {
                return None;
            }
            return Self::named_guard(resolver, core, string);
        }
        if !name.eq_ignore_ascii_case("user") {
            return None;
        }
        let guard = if Self::is_a(resolver, target, context, &[HTTP_REQUEST]) {
            string
        } else if Self::is_a(resolver, target, context, &[AUTH_FACTORY, GUARD]) {
            target
                .members()
                .iter()
                .find_map(|member| match member {
                    Type::Named { args, .. } => match args.as_slice() {
                        [Type::LiteralString(guard)] => Some(guard.as_str()),
                        _ => None,
                    },
                    _ => None,
                })
                .unwrap_or_default()
        } else {
            return None;
        };
        let models = resolver.user_models();
        let model = resolver.class_model(models.model(Some(guard))?)?;
        let user = Type::named(model.fqn());
        if *core == Type::Mixed {
            return Some(Type::union([user, Type::Null]));
        }
        let mut replaced = false;
        let ty = core.map(&mut |ty| match ty {
            Type::Named { fqn, .. } if fqn.trim_start_matches('\\').eq_ignore_ascii_case(AUTHENTICATABLE) => {
                replaced = true;
                Some(user.clone())
            }
            _ => None,
        });
        replaced.then_some(ty)
    }

    /// The guards among the members of `ty` (what `guard('admin')` or
    /// `auth('admin')` returns), with the guard's name as their generic
    /// argument; Laravel's guard contract when there are none.
    fn named_guard(resolver: &Resolver<'_>, ty: &Type, guard: &str) -> Option<Type> {
        let name = || vec![Type::LiteralString(guard.to_owned())];
        let guards: Vec<Type> = ty
            .members()
            .iter()
            .filter_map(|member| match member {
                Type::Named { fqn, .. }
                    if resolver.class_model(fqn).is_some_and(|model| model.is_subclass_of(GUARD)) =>
                {
                    Some(Type::generic(fqn, name()))
                }
                _ => None,
            })
            .collect();
        if guards.is_empty() {
            resolver.class_model(GUARD)?;
            return Some(Type::generic(GUARD, name()));
        }
        Some(Type::union(guards))
    }

    /// The `make()` of a container: the binding a string names, else the
    /// class an argument names (`Foo::class`).
    fn make(resolver: &Resolver<'_>, class: &str, string: &str) -> Option<Type> {
        if !string.is_empty() {
            return Self::binding(resolver, string);
        }
        (!class.is_empty()).then(|| Type::named(class))
    }

    /// The classes a class-string argument names (`class-string<Foo>`, a
    /// union of at most four, a literal class name): what the container
    /// makes of it.
    fn made_from(resolver: &Resolver<'_>, argument: &Type) -> Option<Type> {
        let mut made = Vec::new();
        for member in argument.members() {
            let class = match member {
                Type::ClassString(Some(class)) => match class.as_ref() {
                    Type::Named { .. } => class.as_ref().clone(),
                    _ => return None,
                },
                Type::LiteralString(name) => Type::named(resolver.class_model(name)?.fqn()),
                _ => return None,
            };
            if !made.contains(&class) {
                made.push(class);
            }
        }
        (1..=4).contains(&made.len()).then(|| Type::union(made))
    }

    /// The resolve step for a method or static call: `args` are the
    /// receiver and what the providers after this one say.
    fn resolve_call(
        &self,
        name: &str,
        (class, counted): (&str, bool),
        string: &str,
        args: &[Type],
        resolver: &Resolver<'_>,
        context: &Context,
    ) -> Option<Type> {
        let receiver = args.first()?;
        let core = args.get(1)?;
        // `$this->belongsTo(static::class)`: the receiver's model.
        let own = (class == OWN_CLASS).then(|| Self::model_class(resolver, receiver, context).unwrap_or_default());
        let class = own.as_deref().unwrap_or(class);
        // A static call on a facade is a call on its service.
        let facade = Self::is_a(resolver, receiver, context, &[FACADE])
            .then(|| Self::facade_service(resolver, receiver, context))
            .flatten();
        let target = facade.as_ref().unwrap_or(receiver);
        if let Some(ty) = Self::auth_user(resolver, target, name, string, core, context) {
            return Some(ty);
        }
        if is_make(name)
            && Self::is_a(resolver, target, context, &[CONTAINER, CONTAINER_CLASS])
            && let Some(made) = Self::make(resolver, class, string)
        {
            return Some(made);
        }
        // `DB::table('posts')`: a query builder remembering its table (for
        // the columns of `where('…')` and the like).
        if name.eq_ignore_ascii_case("table")
            && !string.is_empty()
            && Self::is_a(resolver, target, context, &[DATABASE_MANAGER, DATABASE_CONNECTION])
        {
            return Some(Type::generic(QUERY_BUILDER, vec![Type::LiteralString(string.to_owned())]));
        }
        if let Some(relation) = relation_class(name)
            && !class.is_empty()
            && let Some(model) = Self::model_class(resolver, receiver, context)
        {
            // A documented generic relation (`HasMany<TRelatedModel, $this>`)
            // is as good, unless it only got the template's bound: the
            // argument isn't a class string the core reads (a Concord
            // proxy's `modelClass()`).
            let bare = |arg: &Type| matches!(arg, Type::Named { fqn, .. } if fqn.trim_start_matches('\\').eq_ignore_ascii_case(MODEL));
            let generic = core
                .members()
                .iter()
                .any(|member| matches!(member, Type::Named { args, .. } if args.first().is_some_and(|arg| !bare(arg))));
            if !generic {
                return Some(Type::generic(
                    &format!("{RELATIONS}{relation}"),
                    vec![Type::named(class), Type::named(&model)],
                ));
            }
            return None;
        }
        if let Some(ty) = Self::eloquent_call(resolver, receiver, name, counted, args, context) {
            return Some(ty);
        }
        // Prettus's own finders, documented `mixed`: the model or a
        // collection of it.
        if *core == Type::Mixed
            && let Some(collection) = prettus_finder(name)
            && let Some(model) = Self::repository_model(resolver, receiver, context)
        {
            let model = Type::named(&model);
            return Some(if collection { Type::generic(COLLECTION, vec![Type::Int, model]) } else { model });
        }
        // A factory's `hasPosts()` and `forAuthor()` (its `__call`): the
        // factory.
        if *core == Type::Mixed && is_factory_relation(name) && Self::is_a(resolver, receiver, context, &[FACTORY]) {
            return Some(receiver.clone());
        }
        // A Prettus repository: what it doesn't declare is a call on its
        // model; so is a call on a model contract.
        if *core == Type::Mixed
            && !resolver.class_models(receiver, context).iter().any(|model| model.method(name).is_some())
            && let Some(model) = Self::repository_model(resolver, receiver, context)
                .or_else(|| Self::contract_of(resolver, receiver, context))
        {
            let instance = Type::named(&model);
            let declared = resolver.method_return(&instance, name, context);
            let args = [instance, declared.clone()];
            return self
                .resolve_call(name, (class, counted), string, &args, resolver, context)
                .or_else(|| (declared != Type::Mixed).then_some(declared));
        }
        if *core != Type::Mixed && !Self::raw_builder(resolver, core, context) {
            return None;
        }
        if let Some(service) = &facade {
            let ty = resolver.method_return(service, name, context);
            return (ty != Type::Mixed).then_some(ty);
        }
        if let Some(model) = Self::model_class(resolver, receiver, context) {
            // `User::query()` declared with a raw `Builder` is the model's.
            let builder = Type::generic(ELOQUENT_BUILDER, vec![Type::named(&model)]);
            return Self::forward(resolver, &builder, &model, name, context)
                .or_else(|| (*core != Type::Mixed).then_some(builder));
        }
        self.on_builder(resolver, receiver, name, core, context)
    }

    /// The model a builder, relation, Eloquent collection or factory is
    /// about (its first generic argument that is a model), or the model
    /// class itself.
    pub(crate) fn about_model(resolver: &Resolver<'_>, ty: &Type, context: &Context) -> Option<String> {
        if let Some(model) = Self::model_class(resolver, ty, context) {
            return Some(model);
        }
        ty.members().iter().find_map(|member| {
            let Type::Named { args, .. } = member else { return None };
            args.iter().find_map(|arg| match arg {
                Type::Named { fqn, .. } => {
                    resolver.class_model(fqn).filter(|model| model.is_subclass_of(MODEL)).map(|m| m.fqn().to_owned())
                }
                _ => None,
            })
        })
    }

    /// `ty` with the builders among its members remembering `table` too
    /// (a literal generic argument after the model or table they query).
    fn joined(resolver: &Resolver<'_>, ty: Type, table: &str, context: &Context) -> Type {
        let joined = Type::LiteralString(table.to_owned());
        Type::union(ty.members().iter().map(|member| match member {
            Type::Named { fqn, args }
                if !args.is_empty()
                    && !args.contains(&joined)
                    && Self::is_a(resolver, member, context, &[ELOQUENT_BUILDER, QUERY_BUILDER]) =>
            {
                let mut args = args.clone();
                args.push(joined.clone());
                Type::generic(fqn, args)
            }
            other => other.clone(),
        }))
    }

    /// The factory class among the members of `ty`, with its arguments.
    fn factory_type(resolver: &Resolver<'_>, ty: &Type) -> Option<(String, Vec<Type>)> {
        ty.members().iter().find_map(|member| match member {
            Type::Named { fqn, args } => {
                let model = resolver.class_model(fqn)?;
                model.is_subclass_of(FACTORY).then(|| (model.fqn().to_owned(), args.clone()))
            }
            _ => None,
        })
    }

    /// Calls Eloquent types differently from what the declarations say:
    /// `get()`/`all()` on a model, its builder or a relation is a
    /// collection of the model; `Model::factory()` is the model's factory
    /// (`PostFactory<Post>`), whose `create()`/`make()` make the model, or
    /// a collection of them after `count(n)` or `factory(n)` (the factory
    /// then has the collection as its second argument).
    fn eloquent_call(
        resolver: &Resolver<'_>,
        receiver: &Type,
        name: &str,
        counted: bool,
        args: &[Type],
        context: &Context,
    ) -> Option<Type> {
        let core = args.get(1)?;
        if let Some((class, factory_args)) = Self::factory_type(resolver, receiver) {
            let model = match factory_args.first() {
                Some(model @ Type::Named { .. }) => model.clone(),
                _ => Type::named(&Self::factory_model(resolver, &class)?),
            };
            let collection = Type::generic(COLLECTION, vec![Type::Int, model.clone()]);
            let many = factory_args.get(1).is_some();
            if is_one_of(FACTORY_ONE, name) {
                return Some(model);
            }
            if is_one_of(FACTORY_MANY, name) {
                return Some(collection);
            }
            if is_one_of(FACTORY_MAKE, name) {
                return Some(if many { collection } else { model });
            }
            if name.eq_ignore_ascii_case("count") || name.eq_ignore_ascii_case("times") {
                return Some(Type::generic(&class, vec![model, collection]));
            }
            // Fluent methods (`state()`, `has()`, `for()`) keep the factory.
            return Self::factory_type(resolver, core).map(|_| Type::generic(&class, factory_args));
        }
        let model = Self::about_model(resolver, receiver, context)?;
        // `$user->posts()` declared `: HasMany`: the relation to its model.
        if Self::model_class(resolver, receiver, context).is_some()
            && let Some(class) = resolver.class_model(&model)
            && class.method(name).is_some_and(|method| !method.is_static)
        {
            let returned = Self::relation_return(resolver, &class, name);
            if returned != *core && Self::is_a(resolver, &returned, context, &[RELATION]) {
                return Some(returned);
            }
        }
        if name.eq_ignore_ascii_case("factory") && Self::model_class(resolver, receiver, context).is_some() {
            let class =
                Self::factory_of(resolver, &model).or_else(|| Self::factory_type(resolver, core).map(|f| f.0))?;
            let model = Type::named(&model);
            return Some(if counted {
                let collection = Type::generic(COLLECTION, vec![Type::Int, model.clone()]);
                Type::generic(&class, vec![model, collection])
            } else {
                Type::generic(&class, vec![model])
            });
        }
        // Only the model, its builder and relations collect models.
        if !is_one_of(COLLECTING, name)
            || !Self::is_a(resolver, receiver, context, &[MODEL, ELOQUENT_BUILDER, RELATION])
        {
            return None;
        }
        let raw = core.members().iter().all(|member| match member {
            Type::Mixed => true,
            Type::Named { args, .. } => {
                args.is_empty() && Self::is_a(resolver, member, context, &[COLLECTION, SUPPORT_COLLECTION])
            }
            _ => false,
        });
        if !raw {
            return None;
        }
        // The model with its arguments: the counts its query loads.
        let is_model = |ty: &Type| match ty {
            Type::Named { fqn, .. } => fqn.trim_start_matches('\\').eq_ignore_ascii_case(&model),
            _ => false,
        };
        let model = receiver
            .members()
            .iter()
            .find_map(|member| match member {
                member if is_model(member) => Some(member.clone()),
                Type::Named { args, .. } => args.iter().find(|arg| is_model(arg)).cloned(),
                _ => None,
            })
            .unwrap_or_else(|| Type::named(&model));
        // Eloquent's collection, or the subclass the declaration names.
        let class = core
            .members()
            .iter()
            .find_map(|member| match member {
                Type::Named { fqn, .. } if Self::is_a(resolver, member, context, &[COLLECTION]) => Some(fqn.clone()),
                _ => None,
            })
            .unwrap_or_else(|| COLLECTION.to_owned());
        Some(Type::generic(&class, vec![Type::Int, model]))
    }

    /// The factory class of `model` by Laravel's convention
    /// (`Factory::resolveFactoryName`): `Database\Factories\` and the
    /// model's name below the app's `Models\` namespace, plus `Factory`.
    pub(crate) fn factory_of(resolver: &Resolver<'_>, model: &str) -> Option<String> {
        // What the model's own `newFactory()` returns comes first.
        let named = resolver.class_model(model).and_then(|class| {
            let method = class.method("newFactory")?;
            let lazy = method.declared()?.inferred_return.as_ref()?;
            let made = resolver.resolve(lazy, &Context::in_class(&method.self_class));
            resolver
                .class_models(&made, &Context::default())
                .iter()
                .find(|found| found.fqn() != FACTORY && found.is_subclass_of(FACTORY))
                .map(|found| found.fqn().to_owned())
        });
        if named.is_some() {
            return named;
        }
        let relative = match model.split_once("\\Models\\") {
            Some((_, rest)) => rest,
            None => model.rsplit('\\').next().unwrap_or(model),
        };
        let class = format!("Database\\Factories\\{relative}Factory");
        resolver.class_model(&class).filter(|found| found.is_subclass_of(FACTORY)).map(|found| found.fqn().to_owned())
    }

    /// The model a factory class makes, by the reverse of the convention
    /// (`Database\Factories\PostFactory` makes `App\Models\Post`, or
    /// `App\Post`).
    fn factory_model(resolver: &Resolver<'_>, factory: &str) -> Option<String> {
        // Its `$model` property (`protected $model = Post::class;`).
        let model = Type::named(factory);
        let named = resolver.property_type(&model, "model", &Context::in_class(factory));
        let named = named.members().iter().find_map(|member| match member {
            Type::ClassString(Some(class)) => match class.as_ref() {
                Type::Named { fqn, .. } => Some(fqn.clone()),
                _ => None,
            },
            Type::LiteralString(class) => Some(class.clone()),
            _ => None,
        });
        if let Some(found) = named.and_then(|class| resolver.class_model(&class)).filter(|m| m.is_subclass_of(MODEL)) {
            return Some(found.fqn().to_owned());
        }
        let relative = factory.strip_prefix("Database\\Factories\\")?.strip_suffix("Factory")?;
        [format!("App\\Models\\{relative}"), format!("App\\{relative}")].into_iter().find_map(|class| {
            resolver.class_model(&class).filter(|m| m.is_subclass_of(MODEL)).map(|m| m.fqn().to_owned())
        })
    }

    /// The relations of model `class`: its methods returning a relation.
    pub(crate) fn model_relations(resolver: &Resolver<'_>, class: &str) -> Vec<ModelRelation> {
        let Some(model) = resolver.class_model(class).filter(|model| model.is_subclass_of(MODEL)) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for method in model.methods.iter() {
            let framework = method.declaring.fqn.starts_with("Illuminate\\");
            if method.is_static
                || framework
                || method.name.starts_with("__")
                || scope_name(&method.name).is_some()
                || method.declared().is_some_and(is_scope_attributed)
                || accessor_name(&method.name).is_some()
            {
                continue;
            }
            let returned = Self::relation_return(resolver, &model, &method.name);
            let found = returned.members().iter().find_map(|member| {
                let Type::Named { fqn, args } = member else { return None };
                let relation = resolver.class_model(fqn).filter(|class| class.is_subclass_of(RELATION))?;
                let related = match args.first() {
                    Some(Type::Named { fqn, .. }) => Some(fqn.trim_start_matches('\\').to_owned()),
                    _ => None,
                };
                let many = TO_MANY.iter().any(|class| relation.is_subclass_of(&format!("{RELATIONS}{class}")));
                Some((related, many, short_name(relation.fqn()).to_owned()))
            });
            if let Some((related, many, kind)) = found {
                out.push(ModelRelation {
                    name: method.name.clone(),
                    class: method.declaring.fqn.clone(),
                    related,
                    many,
                    kind,
                });
            }
        }
        out
    }

    /// The model at the end of the dotted relation path `path` from model
    /// `class` (`posts.comments` from a user is a comment).
    pub(crate) fn relation_path_model(resolver: &Resolver<'_>, class: &str, path: &str) -> Option<String> {
        let mut model = class.to_owned();
        for segment in path.split('.') {
            // `posts:id,title` selects columns of the relation.
            let segment = segment.split(':').next().unwrap_or(segment).trim();
            let relation = Self::model_relations(resolver, &model).into_iter().find(|r| r.name == segment)?;
            model = relation.related?;
        }
        Some(model)
    }

    /// See [`TypeProvider::closure_parameters`]: the related model's
    /// builder for a relation closure.
    fn relation_closure(
        resolver: &Resolver<'_>,
        receiver: &Type,
        method: &str,
        key: &str,
        context: &Context,
    ) -> Option<Vec<Type>> {
        if !is_one_of(RELATION_CLOSURES, method) {
            return None;
        }
        let model = Self::about_model(resolver, receiver, context)?;
        let related = Self::relation_path_model(resolver, &model, key)?;
        Some(vec![Type::generic(ELOQUENT_BUILDER, vec![Type::named(&related)])])
    }

    /// `->leftJoin('posts', function ($join) { $join->on(…); })`: the join
    /// clause, on a builder, relation or model, or a receiver of unknown
    /// type (the method names are the query builder's own).
    fn join_closure(resolver: &Resolver<'_>, receiver: &Type, method: &str, context: &Context) -> Option<Vec<Type>> {
        if !is_one_of(JOINS, method) {
            return None;
        }
        let queries = matches!(receiver, Type::Mixed | Type::Object)
            || Self::is_a(resolver, receiver, context, &[ELOQUENT_BUILDER, QUERY_BUILDER, RELATION, MODEL]);
        let clause = resolver.class_model(JOIN_CLAUSE)?;
        queries.then(|| vec![Type::named(clause.fqn())])
    }

    /// `Mail::assertQueued(Welcome::class, fn ($mail) => …)` and the other
    /// fakes' assertions: the closure gets an object of the class named
    /// before it.
    fn fake_closure(resolver: &Resolver<'_>, method: &str, key: &str) -> Option<Vec<Type>> {
        if key.is_empty() || !is_one_of(FAKE_ASSERTIONS, method) {
            return None;
        }
        let class = resolver.class_model(key)?;
        Some(vec![Type::named(class.fqn())])
    }

    /// `$query->where(function ($q) { … })` and the like: the nested query
    /// is the receiver's own builder (a model's or relation's Eloquent
    /// builder); on a validation rule (`Rule::exists(…)->where(…)`) or a
    /// receiver of unknown type, the query builder.
    fn query_closure(resolver: &Resolver<'_>, receiver: &Type, method: &str, context: &Context) -> Option<Vec<Type>> {
        let conditional = is_one_of(CONDITIONAL_CLOSURES, method);
        if !conditional && !is_one_of(NESTED_QUERIES, method) {
            return None;
        }
        if Self::is_a(resolver, receiver, context, &[ELOQUENT_BUILDER, QUERY_BUILDER]) {
            return Some(vec![receiver.clone()]);
        }
        if Self::is_a(resolver, receiver, context, &[RELATION, MODEL]) {
            let model = Self::about_model(resolver, receiver, context)?;
            return Some(vec![Type::generic(ELOQUENT_BUILDER, vec![Type::named(&model)])]);
        }
        // `when()` is many classes' method: on a known query, or where
        // Laravel's `Conditionable` declares it (collections, factories),
        // the closure gets the object itself.
        if conditional {
            let declared = resolver
                .class_models(receiver, context)
                .iter()
                .any(|model| model.method(method).is_some_and(|found| found.declaring.fqn.ends_with("Conditionable")));
            return declared.then(|| vec![receiver.clone()]);
        }
        let rule = Self::is_a(resolver, receiver, context, DATABASE_RULES);
        if conditional || !(rule || matches!(receiver, Type::Mixed | Type::Object)) {
            return None;
        }
        let builder = resolver.class_model(QUERY_BUILDER)?;
        Some(vec![Type::named(builder.fqn())])
    }

    /// A raw Eloquent or query builder (what a `@mixin` without arguments
    /// gives).
    fn raw_builder(resolver: &Resolver<'_>, ty: &Type, context: &Context) -> bool {
        ty.members().iter().all(|member| match member {
            Type::Named { args, .. } => {
                args.is_empty() && Self::is_a(resolver, member, context, &[ELOQUENT_BUILDER, QUERY_BUILDER])
            }
            _ => false,
        })
    }

    /// A call on a model's query `builder`, forwarded by `Model::__call`.
    fn forward(resolver: &Resolver<'_>, builder: &Type, model: &str, name: &str, context: &Context) -> Option<Type> {
        if Self::has_scope(resolver, model, name) {
            return Some(builder.clone());
        }
        let ty = resolver.method_return(builder, name, context);
        if ty != Type::Mixed {
            return Some(Self::keep_builder(resolver, ty, builder, context));
        }
        let query = resolver.method_return(&Type::named(QUERY_BUILDER), name, context);
        if query != Type::Mixed {
            return Some(Self::keep_builder(resolver, query, builder, context));
        }
        is_dynamic_where(name).then(|| builder.clone())
    }

    /// A call an Eloquent builder or a relation forwards to the query
    /// builder: fluent results keep the receiver.
    fn on_builder(
        &self,
        resolver: &Resolver<'_>,
        receiver: &Type,
        name: &str,
        core: &Type,
        context: &Context,
    ) -> Option<Type> {
        let forwarding = receiver.members().iter().find(|member| {
            matches!(member, Type::Named { .. }) && Self::is_a(resolver, member, context, &[ELOQUENT_BUILDER, RELATION])
        })?;
        let Type::Named { args, .. } = forwarding else { return None };
        let model = match args.first() {
            Some(Type::Named { fqn, .. }) => Some(fqn.as_str()),
            _ => None,
        };
        if model.is_some_and(|model| Self::has_scope(resolver, model, name)) {
            return Some(forwarding.clone());
        }
        if let Some(ty) = model.and_then(|model| Self::builder_tag(resolver, model, name, forwarding, context)) {
            return Some(ty);
        }
        if *core != Type::Mixed {
            return Some(Self::keep_builder(resolver, core.clone(), forwarding, context));
        }
        let query = resolver.method_return(&Type::named(QUERY_BUILDER), name, context);
        if query != Type::Mixed {
            return Some(Self::keep_builder(resolver, query, forwarding, context));
        }
        is_dynamic_where(name).then(|| forwarding.clone())
    }

    /// `ty`, with a raw (or query) builder replaced by `builder`.
    fn keep_builder(resolver: &Resolver<'_>, ty: Type, builder: &Type, context: &Context) -> Type {
        if Self::raw_builder(resolver, &ty, context) { builder.clone() } else { ty }
    }

    /// The `@method static` tags of `model` and its traits (SoftDeletes'
    /// `onlyTrashed()`, `whereTitle()` of a generated docblock): calls the
    /// model forwards to its builder, so members of its builders and
    /// relations too.
    fn builder_tags(resolver: &Resolver<'_>, model: &str, out: &mut Vec<MagicMember>) {
        let Some(class) = resolver.class_model(model) else { return };
        for method in class.methods.iter().filter(|method| method.origin == Origin::Magic && method.is_static) {
            out.push(MagicMember {
                name: method.name.clone(),
                is_static: false,
                target: MagicTarget::Method { class: class.fqn().to_owned(), method: method.name.clone() },
            });
        }
    }

    /// What `@method static` tag `name` of `model` ([`Self::builder_tags`])
    /// returns on `forwarding`, a builder or relation of the model: the
    /// receiver itself where the tag returns a builder, else what the tag
    /// says on the model (`static` the model).
    fn builder_tag(
        resolver: &Resolver<'_>,
        model: &str,
        name: &str,
        forwarding: &Type,
        context: &Context,
    ) -> Option<Type> {
        let class = resolver.class_model(model)?;
        let method = class.method(name)?;
        if method.origin != Origin::Magic || !method.is_static {
            return None;
        }
        let ty = resolver.method_return(&Type::named(class.fqn()), name, context);
        if Self::is_a(resolver, &ty, context, &[ELOQUENT_BUILDER]) {
            return Some(forwarding.clone());
        }
        (ty != Type::Mixed).then_some(ty)
    }

    /// `scope{Name}()` on `model`, or a `#[Scope]` method `name`.
    fn has_scope(resolver: &Resolver<'_>, model: &str, name: &str) -> bool {
        resolver.class_model(model).is_some_and(|model| {
            model.method(&format!("scope{name}")).is_some()
                || model.method(name).and_then(|method| method.declared().map(is_scope_attributed)).unwrap_or(false)
        })
    }

    /// What method `name` of `model` returns: a relation declared raw
    /// (`comments(): HasMany`) takes its related model from what the body
    /// returns (`$this->hasMany(Comment::class)`).
    fn relation_return(resolver: &Resolver<'_>, model: &ClassModel, name: &str) -> Type {
        let returned = Self::declared_relation(resolver, model, name);
        // `product(): MorphTo`: nothing names the related model, the
        // relation's name does when one model is called that (`Product`).
        let morph = format!("{RELATIONS}MorphTo");
        let open = |ty: &Type| {
            match ty {
            Type::Named { fqn, args } => {
                resolver.class_model(fqn).is_some_and(|class| class.is_subclass_of(&morph))
                    && args.first().is_none_or(|arg| {
                        matches!(arg, Type::Named { fqn, .. } if fqn.trim_start_matches('\\').eq_ignore_ascii_case(MODEL))
                    })
            }
            _ => false,
        }
        };
        if !returned.members().iter().any(open) {
            return returned;
        }
        let Some(related) = Self::model_named(resolver, &studly(name)) else { return returned };
        returned.map(&mut |ty| match ty {
            Type::Named { fqn, .. } if open(ty) => {
                Some(Type::generic(fqn, vec![Type::named(&related), Type::named(model.fqn())]))
            }
            _ => None,
        })
    }

    /// The one Eloquent model with short name `name`.
    fn model_named(resolver: &Resolver<'_>, name: &str) -> Option<String> {
        let models: Vec<std::sync::Arc<ClassModel>> = resolver
            .classes_named(name)
            .iter()
            .filter_map(|fqn| resolver.class_model(fqn))
            .filter(|class| class.class.kind == crate::summary::ClassKind::Class && class.is_subclass_of(MODEL))
            .collect();
        // A model extending another of the same name (a package's own
        // `Product`) doesn't make the name ambiguous.
        let mut roots = models.iter().filter(|class| {
            !models.iter().any(|other| other.fqn() != class.fqn() && class.is_subclass_of(other.fqn()))
        });
        let model = roots.next()?;
        roots.next().is_none().then(|| model.fqn().to_owned())
    }

    /// The model an API resource is about when nothing says (`@mixin`
    /// does): the one model its name starts with (`ProductResource`).
    fn resource_model(resolver: &Resolver<'_>, class: &ClassModel) -> Option<String> {
        if !class.is_subclass_of(JSON_RESOURCE) {
            return None;
        }
        let name = class.class.name.strip_suffix("Resource").filter(|name| !name.is_empty())?;
        Self::model_named(resolver, name)
    }

    /// The model `class` stands for: a model contract's, an API resource's.
    fn stands_for(resolver: &Resolver<'_>, class: &ClassModel) -> Option<String> {
        Self::contract_model(resolver, class).or_else(|| Self::resource_model(resolver, class))
    }

    fn declared_relation(resolver: &Resolver<'_>, model: &ClassModel, name: &str) -> Type {
        let this = Type::named(model.fqn());
        let returned = resolver.method_return(&this, name, &Context::default());
        // A raw accessor (`title(): Attribute`) too: `Attribute::make(get:
        // fn (): string => …)` in the body types it.
        let raw_relation = returned.members().iter().any(|member| {
            matches!(member, Type::Named { fqn, args } if args.is_empty()
                && resolver.class_model(fqn).is_some_and(|class| class.is_subclass_of(RELATION) || class.is_subclass_of(ATTRIBUTE)))
        });
        if !raw_relation {
            return returned;
        }
        let inferred = model
            .method(name)
            .and_then(|method| {
                let lazy = method.declared()?.inferred_return.clone()?;
                Some(resolver.resolve(&lazy, &Context::in_class(&method.self_class)))
            })
            .unwrap_or(Type::Mixed);
        let generic = inferred.members().iter().any(|member| {
            matches!(member, Type::Named { fqn, args } if !args.is_empty()
                && resolver.class_model(fqn).is_some_and(|class| class.is_subclass_of(RELATION) || class.is_subclass_of(ATTRIBUTE)))
        });
        if generic { inferred } else { returned }
    }

    /// The type of a model's relation property, or of an accessor.
    fn model_property(resolver: &Resolver<'_>, class: &str, name: &str) -> Option<Type> {
        let model = resolver.class_model(class)?;
        if !model.is_subclass_of(MODEL) {
            return None;
        }
        let this = Type::named(model.fqn());
        let context = Context::default();
        if let Some(method) = model.method(name)
            && !method.is_static
        {
            let returned = Self::relation_return(resolver, &model, name);
            for member in returned.members() {
                let Type::Named { fqn, args } = member else { continue };
                let Some(relation) = resolver.class_model(fqn) else { continue };
                if relation.is_subclass_of(RELATION) {
                    let related = match args.first() {
                        Some(related @ Type::Named { .. }) => related.clone(),
                        _ => Type::named(MODEL),
                    };
                    let many = TO_MANY.iter().any(|class| relation.is_subclass_of(&format!("{RELATIONS}{class}")));
                    return Some(if many {
                        Type::generic(COLLECTION, vec![Type::Int, related])
                    } else {
                        related.nullable()
                    });
                }
                if relation.is_subclass_of(ATTRIBUTE) {
                    return args.first().cloned();
                }
            }
        }
        // `first_name`: `getFirstNameAttribute()`, `firstName(): Attribute`.
        let studly = studly(name);
        if model.method(&format!("get{studly}Attribute")).is_some() {
            let ty = resolver.method_return(&this, &format!("get{studly}Attribute"), &context);
            return (ty != Type::Mixed).then_some(ty);
        }
        let camel = camel(&studly);
        if camel != name && model.method(&camel).is_some() {
            return Self::model_property(resolver, class, &camel);
        }
        Self::attribute(resolver, &model, name)
            .or_else(|| Self::count_relation(resolver, class, name).map(|_| Type::Int))
    }

    /// The relation property `name` (`posts_count`, `blog_posts_count`, an
    /// alias) counts, when the `$withCount` of model `class` (or of a parent)
    /// counts a relation of the model under that name. What a query's
    /// `withCount()` counts is in the type of the models it loads
    /// ([`Self::counting`]).
    fn count_relation(resolver: &Resolver<'_>, class: &str, name: &str) -> Option<String> {
        let model = resolver.class_model(class)?;
        let facts = resolver.laravel();
        let counted: Vec<&str> = facts
            .counted
            .iter()
            .filter(|counted| counted.property == name && model.is_subclass_of(&counted.class))
            .map(|counted| counted.relation.as_str())
            .collect();
        if counted.is_empty() {
            return None;
        }
        Self::model_relations(resolver, class)
            .into_iter()
            .find(|found| counted.iter().any(|relation| found.name.eq_ignore_ascii_case(relation)))
            .map(|found| found.name)
    }

    /// `ty` after `withCount(specs)` or `loadCount(specs)` (`specs` the
    /// counted relations, comma-separated, `'posts as drafts'` with an
    /// alias): a model, or the model a builder, relation or collection is
    /// about, gets an object shape argument with the count properties of
    /// the relations it has (`Post<object{tags_count: int}>`). Template
    /// substitution carries it to what the query loads (`get()`, `first()`,
    /// a `foreach`), so `$post->tags_count` follows the query that loaded
    /// `$post`.
    fn counting(resolver: &Resolver<'_>, ty: Type, specs: &str) -> Type {
        let is_model = |ty: &Type| match ty {
            Type::Named { fqn, .. } => resolver.class_model(fqn).is_some_and(|class| class.is_subclass_of(MODEL)),
            _ => false,
        };
        Type::union(ty.members().iter().map(|member| {
            let Type::Named { fqn, args } = member else { return member.clone() };
            if is_model(member) {
                return Self::with_counts(resolver, member, specs);
            }
            let about = resolver.class_model(fqn).is_some_and(|class| {
                class.is_subclass_of(ELOQUENT_BUILDER)
                    || class.is_subclass_of(RELATION)
                    || class.is_subclass_of(COLLECTION)
            });
            let Some(at) = args.iter().position(is_model).filter(|_| about) else { return member.clone() };
            let mut args = args.clone();
            args[at] = Self::with_counts(resolver, &args[at], specs);
            Type::generic(fqn, args)
        }))
    }

    /// Model type `model` with the counts of `specs` (see
    /// [`Self::counting`]) added to its object shape argument; relations
    /// the model doesn't have aren't counted.
    fn with_counts(resolver: &Resolver<'_>, model: &Type, specs: &str) -> Type {
        let Type::Named { fqn, args } = model else { return model.clone() };
        let relations = Self::model_relations(resolver, fqn);
        let mut fields: Vec<ShapeField> = args
            .iter()
            .find_map(|arg| match arg {
                Type::ObjectShape(fields) => Some(fields.clone()),
                _ => None,
            })
            .unwrap_or_default();
        for spec in specs.split(',') {
            let Some((relation, property)) = counted_spec(spec, snake) else { continue };
            let key = ShapeKey::String(property);
            if !relations.iter().any(|found| found.name.eq_ignore_ascii_case(&relation))
                || fields.iter().any(|field| field.key == key)
            {
                continue;
            }
            fields.push(ShapeField { key, ty: Type::Int, optional: false });
        }
        if fields.is_empty() {
            return model.clone();
        }
        let mut args: Vec<Type> = args.iter().filter(|arg| !matches!(arg, Type::ObjectShape(_))).cloned().collect();
        args.push(Type::ObjectShape(fields));
        Type::generic(fqn, args)
    }

    /// The count properties the type of a model, `ty`, says its query
    /// loaded ([`Self::counting`]), for model class `class`.
    fn counted_in(ty: &Type, class: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for member in ty.members() {
            let Type::Named { fqn, args } = member else { continue };
            if !fqn.trim_start_matches('\\').eq_ignore_ascii_case(class) {
                continue;
            }
            for arg in args {
                let Type::ObjectShape(fields) = arg else { continue };
                for field in fields {
                    if let ShapeKey::String(name) = &field.key
                        && !out.contains(name)
                    {
                        out.push(name.clone());
                    }
                }
            }
        }
        out
    }

    /// Any relation of model `class` counted as `name` (`posts_count`) the
    /// way `withCount('posts')` would, counted anywhere or not: what a
    /// query may name without the inspection knowing about every
    /// `withCount` (scopes, `$withCount`, packages).
    pub(crate) fn any_count_relation(resolver: &Resolver<'_>, class: &str, name: &str) -> bool {
        let Some(relation) = name.strip_suffix("_count").filter(|relation| !relation.is_empty()) else {
            return Self::count_relation(resolver, class, name).is_some();
        };
        Self::model_relations(resolver, class)
            .into_iter()
            .any(|found| found.name == relation || snake(&found.name) == relation)
            || Self::count_relation(resolver, class, name).is_some()
    }

    /// The public methods of `class` other than magic ones, forwarded to.
    fn forwarded_methods(resolver: &Resolver<'_>, class: &str, is_static: bool, out: &mut Vec<MagicMember>) {
        let Some(model) = resolver.class_model(class) else { return };
        for method in model.methods.iter() {
            if method.visibility != Visibility::Public || method.name.starts_with("__") {
                continue;
            }
            out.push(MagicMember {
                name: method.name.clone(),
                is_static,
                target: MagicTarget::Method { class: model.fqn().to_owned(), method: method.name.clone() },
            });
        }
    }

    /// The local scopes of `model` (`scopeActive()` called as `active()`).
    fn scopes(resolver: &Resolver<'_>, model: &str, is_static: bool, out: &mut Vec<MagicMember>) {
        let Some(model) = resolver.class_model(model) else { return };
        for method in model.methods.iter() {
            let name = match scope_name(&method.name) {
                Some(rest) => camel(rest),
                None if method.declared().is_some_and(is_scope_attributed) => method.name.clone(),
                None => continue,
            };
            out.push(MagicMember {
                name,
                is_static,
                target: MagicTarget::Method { class: model.fqn().to_owned(), method: method.name.clone() },
            });
        }
    }

    /// The magic properties of a model: relations, accessors, casts,
    /// migrated columns and counts (in that order, the first of a name
    /// winning); `counted` are the count properties the query that loaded
    /// it gives it ([`Self::counted_in`]).
    fn attributes(resolver: &Resolver<'_>, model: &ClassModel, counted: &[String], out: &mut Vec<MagicMember>) {
        let class = model.fqn().to_owned();
        let mut found: Vec<MagicMember> = Vec::new();
        let push = |found: &mut Vec<MagicMember>, name: String, origin: AttributeOrigin| {
            if model.property(&name).is_some() || found.iter().any(|known| known.name == name) {
                return;
            }
            let Some(ty) = Self::model_property(resolver, &class, &name) else { return };
            let target = MagicTarget::Attribute { class: class.clone(), ty, origin };
            found.push(MagicMember { name, is_static: false, target });
        };
        let this = Type::named(&class);
        let context = Context::default();
        for method in model.methods.iter() {
            // The application's methods, not the framework's own.
            let framework = method.declaring.fqn.starts_with("Illuminate\\");
            if method.is_static
                || framework
                || method.name.starts_with("__")
                || scope_name(&method.name).is_some()
                || method.declared().is_some_and(is_scope_attributed)
            {
                continue;
            }
            if let Some(attribute) = accessor_name(&method.name) {
                let origin = AttributeOrigin::Accessor { method: method.name.clone() };
                push(&mut found, snake(attribute), origin);
                continue;
            }
            let returned = resolver.method_return(&this, &method.name, &context);
            for member in returned.members() {
                let Type::Named { fqn, .. } = member else { continue };
                let Some(returned) = resolver.class_model(fqn) else { continue };
                if returned.is_subclass_of(RELATION) {
                    let origin = AttributeOrigin::Relation { method: method.name.clone() };
                    push(&mut found, method.name.clone(), origin);
                    break;
                }
                if returned.is_subclass_of(ATTRIBUTE) {
                    let origin = AttributeOrigin::Accessor { method: method.name.clone() };
                    push(&mut found, snake(&method.name), origin);
                    break;
                }
            }
        }
        let facts = resolver.laravel();
        if let Some(casts) = Self::casts_of(&facts, model) {
            for cast in &casts.casts {
                let source = casts.file.clone().map(|file| Source { file, loc: cast.loc });
                push(&mut found, cast.attribute.clone(), AttributeOrigin::Cast { cast: cast.cast.clone(), source });
            }
        }
        let table = Self::table(model);
        for (migration, column) in facts.columns(&table) {
            let source = migration.file.clone().map(|file| Source { file, loc: column.loc });
            let origin = AttributeOrigin::Column {
                table: table.clone(),
                ty: column.ty.0.trim_start_matches('\\').to_owned(),
                nullable: column.nullable,
                from: migration.source_label(),
                source,
            };
            push(&mut found, column.name.clone(), origin);
        }
        // `withCount('posts')` loads `posts_count`: only the relations the
        // model's `$withCount` counts, and those the query that loaded the
        // model did (`counted`, from its type).
        let relations = Self::model_relations(resolver, &class);
        let mut counts: Vec<(String, Option<String>)> = Vec::new();
        for counted in facts.counted.iter().filter(|counted| model.is_subclass_of(&counted.class)) {
            if let Some(relation) = relations.iter().find(|r| r.name.eq_ignore_ascii_case(&counted.relation)) {
                counts.push((counted.property.clone(), Some(relation.name.clone())));
            }
        }
        for property in counted {
            // An alias (`'comments as replies'`) doesn't say its relation.
            let relation = relations.iter().find(|r| format!("{}_count", snake(&r.name)) == *property);
            counts.push((property.clone(), relation.map(|r| r.name.clone())));
        }
        for (name, relation) in counts {
            if model.property(&name).is_some() || found.iter().any(|known| known.name == name) {
                continue;
            }
            let origin = AttributeOrigin::Count { method: relation.unwrap_or_default() };
            let target = MagicTarget::Attribute { class: class.clone(), ty: Type::Int, origin };
            found.push(MagicMember { name, is_static: false, target });
        }
        out.extend(found);
    }

    /// The casts a model uses: its own, else a parent's.
    pub(crate) fn casts_of<'f>(facts: &'f LaravelFacts, model: &ClassModel) -> Option<&'f ModelCasts> {
        facts
            .casts
            .iter()
            .filter(|casts| model.is_subclass_of(&casts.class))
            .min_by_key(|casts| !casts.class.eq_ignore_ascii_case(model.fqn()))
    }

    /// See [`TypeProvider::magic_members`].
    fn members_of(resolver: &Resolver<'_>, receiver: &Type, context: &Context) -> Vec<MagicMember> {
        let mut out = Vec::new();
        for model in resolver.class_models(receiver, context) {
            if model.is_subclass_of(FACADE) {
                let Some(service) = Self::facade_service(resolver, &Type::named(model.fqn()), context) else {
                    continue;
                };
                for service in resolver.class_models(&service, context) {
                    Self::forwarded_methods(resolver, service.fqn(), true, &mut out);
                }
            } else if model.is_subclass_of(MODEL) {
                Self::scopes(resolver, model.fqn(), true, &mut out);
                Self::forwarded_methods(resolver, ELOQUENT_BUILDER, true, &mut out);
                Self::forwarded_methods(resolver, QUERY_BUILDER, true, &mut out);
                Self::attributes(resolver, &model, &Self::counted_in(receiver, model.fqn()), &mut out);
            } else if model.is_subclass_of(FORM_REQUEST) {
                Self::request_fields(resolver, &model, &mut out);
            } else if let Some(target) = Self::stands_for(resolver, &model)
                && let Some(target) = resolver.class_model(&target)
            {
                // A model contract: its model's members.
                Self::forwarded_methods(resolver, target.fqn(), false, &mut out);
                Self::scopes(resolver, target.fqn(), false, &mut out);
                Self::forwarded_methods(resolver, ELOQUENT_BUILDER, false, &mut out);
                Self::forwarded_methods(resolver, QUERY_BUILDER, false, &mut out);
                Self::attributes(resolver, &target, &[], &mut out);
            } else if model.is_subclass_of(PRETTUS_REPOSITORY)
                && let Some(target) = Self::repository_model(resolver, &Type::named(model.fqn()), context)
            {
                // Its model's methods and scopes, and what the model forwards to.
                Self::forwarded_methods(resolver, &target, false, &mut out);
                Self::scopes(resolver, &target, false, &mut out);
                Self::forwarded_methods(resolver, ELOQUENT_BUILDER, false, &mut out);
                Self::forwarded_methods(resolver, QUERY_BUILDER, false, &mut out);
            }
        }
        // A builder or relation: the related model's scopes, then what it
        // forwards to.
        for member in receiver.members() {
            let Type::Named { fqn, args } = member else { continue };
            // `$posts->each->delete()`: the proxy calls the items' method.
            if fqn.trim_start_matches('\\').eq_ignore_ascii_case(HIGHER_ORDER_PROXY) {
                if let Some(item) = args.get(1) {
                    for item in resolver.class_models(item, context) {
                        Self::forwarded_methods(resolver, item.fqn(), false, &mut out);
                    }
                }
                continue;
            }
            let Some(model) = resolver.class_model(fqn) else { continue };
            let relation = model.is_subclass_of(RELATION);
            if !relation && !model.is_subclass_of(ELOQUENT_BUILDER) {
                continue;
            }
            if let Some(Type::Named { fqn: related, .. }) = args.first() {
                Self::scopes(resolver, related, false, &mut out);
                Self::builder_tags(resolver, related, &mut out);
            }
            if relation {
                Self::forwarded_methods(resolver, ELOQUENT_BUILDER, false, &mut out);
            }
            Self::forwarded_methods(resolver, QUERY_BUILDER, false, &mut out);
        }
        out
    }

    /// The rules a Form Request validates: its own `rules()`, else a
    /// parent's.
    fn rules_of<'f>(facts: &'f LaravelFacts, model: &ClassModel) -> Option<&'f RequestRules> {
        facts
            .rules
            .iter()
            .filter(|rules| model.is_subclass_of(&rules.class))
            .min_by_key(|rules| !rules.class.eq_ignore_ascii_case(model.fqn()))
    }

    /// The fields a Form Request validates (its own `rules()`, else a
    /// parent's) with their rule names, not the nested ones (`tags.*`,
    /// `address.city`). `None` for a class that isn't a Form Request or
    /// whose rules aren't known.
    pub(crate) fn form_request_fields(resolver: &Resolver<'_>, class: &str) -> Option<Vec<(String, Vec<String>)>> {
        let model = resolver.class_model(class)?;
        if !model.is_subclass_of(FORM_REQUEST) {
            return None;
        }
        let facts = resolver.laravel();
        let rules = Self::rules_of(&facts, &model)?;
        Some(
            rules
                .fields
                .iter()
                .filter(|entry| !entry.field.contains(['.', '*']))
                .map(|entry| (entry.field.clone(), entry.rules.clone()))
                .collect(),
        )
    }

    /// A Form Request's field read as a property (`$request->title`),
    /// typed from its rules.
    fn request_property(resolver: &Resolver<'_>, class: &str, name: &str) -> Option<Type> {
        let model = resolver.class_model(class)?;
        if !model.is_subclass_of(FORM_REQUEST) {
            return None;
        }
        let facts = resolver.laravel();
        let entry = Self::rules_of(&facts, &model)?.fields.iter().find(|entry| entry.field == name)?;
        Some(rule_type(&entry.rules))
    }

    /// The fields of a Form Request's rules as properties (not the nested
    /// `tags.*` ones).
    fn request_fields(resolver: &Resolver<'_>, model: &ClassModel, out: &mut Vec<MagicMember>) {
        let facts = resolver.laravel();
        let Some(rules) = Self::rules_of(&facts, model) else { return };
        for entry in &rules.fields {
            let name = &entry.field;
            if name.is_empty() || name.contains(['.', '*', '-', ' ']) || model.property(name).is_some() {
                continue;
            }
            let source = rules.file.clone().map(|file| Source { file, loc: entry.loc });
            let origin = AttributeOrigin::Rule { rules: entry.rules.join("|"), source };
            let target = MagicTarget::Attribute { class: rules.class.clone(), ty: rule_type(&entry.rules), origin };
            out.push(MagicMember { name: name.clone(), is_static: false, target });
        }
    }

    /// The columns migrations give the table of model `class`, in
    /// migration order, each with the model's cast of it (as written in
    /// the casts, a class with a leading `\`). Empty for other classes.
    pub(crate) fn model_columns(resolver: &Resolver<'_>, class: &str) -> Vec<(Column, Option<String>)> {
        let Some(model) = resolver.class_model(class).filter(|model| model.is_subclass_of(MODEL)) else {
            return Vec::new();
        };
        let facts = resolver.laravel();
        let casts = Self::casts_of(&facts, &model);
        facts
            .columns(&Self::table(&model))
            .into_iter()
            .map(|(_, column)| {
                let cast = casts
                    .and_then(|casts| casts.casts.iter().find(|cast| cast.attribute == column.name))
                    .map(|cast| cast.cast.clone());
                (column.clone(), cast)
            })
            .collect()
    }

    /// A model attribute: its cast, else its migrated column.
    fn attribute(resolver: &Resolver<'_>, model: &ClassModel, name: &str) -> Option<Type> {
        let facts = resolver.laravel();
        let table = Self::table(model);
        let column = facts.columns(&table).into_iter().find(|(_, column)| column.name == name).map(|(_, c)| c.clone());
        // The model's own casts, else a parent's.
        let cast = Self::casts_of(&facts, model)
            .and_then(|casts| casts.casts.iter().find(|cast| cast.attribute == name))
            .and_then(|cast| cast_type(resolver, &cast.cast));
        let ty = match (cast, &column) {
            (Some(ty), _) => ty,
            (None, Some(column)) => Type::from_doc(&column.ty, &[]).settle(),
            (None, None) => return None,
        };
        Some(if column.is_some_and(|column| column.nullable) { ty.nullable() } else { ty })
    }

    /// The table of model `class`; `None` for other classes.
    pub(crate) fn model_table(resolver: &Resolver<'_>, class: &str) -> Option<String> {
        let model = resolver.class_model(class).filter(|model| model.is_subclass_of(MODEL))?;
        Some(Self::table(&model))
    }

    /// A model's table: its `$table`, else the snake-case plural of its
    /// name (`BlogPost` is `blog_posts`).
    fn table(model: &ClassModel) -> String {
        let declared = model
            .property("table")
            .and_then(|property| property.declared())
            .and_then(|property| property.default.as_deref())
            .map(|value| value.trim_matches(|c| c == '\'' || c == '"'))
            .filter(|value| !value.is_empty() && !value.contains(['$', '\'', '"', '.']));
        if let Some(table) = declared {
            return table.to_owned();
        }
        let short = model.fqn().rsplit('\\').next().unwrap_or_default();
        let snake = snake(short);
        let (head, last) = match snake.rsplit_once('_') {
            Some((head, last)) => (format!("{head}_"), last.to_owned()),
            None => (String::new(), snake),
        };
        format!("{head}{}", plural(&last))
    }
}

/// The type an attribute with built-in cast or cast class `cast` has
/// (`HasAttributes::castAttribute` in Laravel's MIT source).
fn cast_type(resolver: &Resolver<'_>, cast: &str) -> Option<Type> {
    if let Some(class) = cast.strip_prefix('\\') {
        if let Some((_, known)) = CAST_CLASSES.iter().find(|(name, _)| name.eq_ignore_ascii_case(class)) {
            return Some(Type::named(known));
        }
        let model = resolver.class_model(class)?;
        if model.kind() == ClassKind::Enum {
            return Some(Type::named(model.fqn()));
        }
        // A `CastsAttributes` class: what its `get()` returns.
        let got = resolver.method_return(&Type::named(model.fqn()), "get", &Context::default());
        return (got != Type::Mixed).then_some(got);
    }
    let (kind, argument) = cast.split_once(':').unwrap_or((cast, ""));
    Some(match kind.to_ascii_lowercase().as_str() {
        "int" | "integer" | "timestamp" => Type::Int,
        "real" | "float" | "double" => Type::Float,
        "decimal" | "string" | "hashed" => Type::string(),
        "bool" | "boolean" => Type::Bool,
        "object" => Type::named("stdClass"),
        "array" | "json" => Type::array(),
        "collection" => Type::named(SUPPORT_COLLECTION),
        "date" | "datetime" | "custom_datetime" => Type::named(CARBON),
        "immutable_date" | "immutable_datetime" | "immutable_custom_datetime" => Type::named(CARBON_IMMUTABLE),
        "encrypted" => match argument.to_ascii_lowercase().as_str() {
            "array" | "json" => Type::array(),
            "collection" => Type::named(SUPPORT_COLLECTION),
            "object" => Type::named("stdClass"),
            _ => Type::string(),
        },
        _ => return None,
    })
}

/// `scopeActive` → `Active`.
pub(crate) fn scope_name(method: &str) -> Option<&str> {
    let rest = method.get(5..).filter(|rest| !rest.is_empty())?;
    method[..5].eq_ignore_ascii_case("scope").then_some(rest)
}

/// Laravel 12's `#[Scope]` attribute marking a local scope method.
pub(crate) const SCOPE_ATTRIBUTE: &str = "Illuminate\\Database\\Eloquent\\Attributes\\Scope";

/// A method marked `#[Scope]`: a local scope called by its own name.
pub(crate) fn is_scope_attributed(method: &crate::summary::Method) -> bool {
    method.attributes.iter().any(|attribute| attribute.trim_start_matches('\\').eq_ignore_ascii_case(SCOPE_ATTRIBUTE))
}

/// `getFullNameAttribute` → `FullName`.
pub(crate) fn accessor_name(method: &str) -> Option<&str> {
    let lower = method.to_ascii_lowercase();
    if method.len() > 12 && lower.starts_with("get") && lower.ends_with("attribute") {
        method.get(3..method.len() - 9)
    } else {
        None
    }
}

/// `BlogPost` → `blog_post`.
pub(crate) fn snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push('_');
        }
        out.extend(c.to_lowercase());
    }
    out
}

/// The English plural of a lower-case word, for the common cases
/// (`post` → `posts`, `category` → `categories`, `box` → `boxes`).
pub(crate) fn plural(word: &str) -> String {
    const IRREGULAR: &[(&str, &str)] =
        &[("person", "people"), ("child", "children"), ("man", "men"), ("woman", "women"), ("mouse", "mice")];
    const SAME: &[&str] = &["data", "equipment", "information", "media", "news", "series", "species"];
    if let Some((_, plural)) = IRREGULAR.iter().find(|(single, _)| *single == word) {
        return (*plural).to_owned();
    }
    if SAME.contains(&word) {
        return word.to_owned();
    }
    let consonant_y = word.len() > 1
        && word.ends_with('y')
        && !matches!(word.as_bytes()[word.len() - 2], b'a' | b'e' | b'i' | b'o' | b'u');
    if consonant_y {
        format!("{}ies", &word[..word.len() - 1])
    } else if ["s", "x", "z", "ch", "sh"].iter().any(|end| word.ends_with(end)) {
        format!("{word}es")
    } else {
        format!("{word}s")
    }
}

/// `first_name` → `FirstName`.
pub(crate) fn studly(name: &str) -> String {
    name.split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map(|first| first.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
        })
        .collect()
}

/// `FirstName` → `firstName`.
fn camel(studly: &str) -> String {
    let mut chars = studly.chars();
    chars.next().map(|first| first.to_lowercase().chain(chars).collect()).unwrap_or_default()
}

impl LaravelProvider {
    /// `Attribute::make(get: fn (): string => …)`: what the getter returns
    /// (its declared return type in summaries), so an accessor declared
    /// with a raw `Attribute` is typed without `@return`.
    fn accessor_getter(site: &CallSite<'_>) -> Option<Type> {
        if site.kind != CallKind::StaticMethod || !site.name.eq_ignore_ascii_case("make") {
            return None;
        }
        let Some(LazyType::Known(Type::Named { fqn, .. })) = site.receiver else { return None };
        if !fqn.trim_start_matches('\\').eq_ignore_ascii_case(ATTRIBUTE) {
            return None;
        }
        let index = site
            .args
            .iter()
            .position(|arg| arg.name.as_deref() == Some("get"))
            .or_else(|| site.args.first().filter(|arg| arg.name.is_none()).map(|_| 0))?;
        match (site.arg_types)().into_iter().nth(index)? {
            LazyType::Known(Type::Closure(Some(signature))) => {
                signature.return_type.filter(|ty| !matches!(ty, Type::Mixed | Type::Void))
            }
            _ => None,
        }
    }
}

impl TypeProvider for LaravelProvider {
    fn key(&self) -> &'static str {
        "laravel"
    }

    fn call(&self, site: &CallSite<'_>) -> Option<LazyType> {
        let class = site.class_arg().unwrap_or_default();
        // A string literal is also a class name when it looks like one;
        // `make()` tries it as a binding first.
        let string = match site.args.first() {
            Some(arg) if arg.name.is_none() => arg.string.as_deref().unwrap_or_default(),
            _ => "",
        };
        match site.kind {
            CallKind::Function => {
                let short = short_name(site.name);
                // `auth('admin')`: the guard, with its name.
                if short.eq_ignore_ascii_case("auth") && !string.is_empty() {
                    let next = (site.next)();
                    let payload = format!("auth:{}:{string}", site.name);
                    return Some(provided(self.key(), payload, vec![next.clone()], next));
                }
                if !short.eq_ignore_ascii_case("app") && !short.eq_ignore_ascii_case("resolve") {
                    return None;
                }
                // `app()` without arguments is the application.
                let bare = if site.args.is_empty() { "bare" } else { "args" };
                let payload = format!("helper:{bare}:{}:{class}:{string}", site.name);
                // No class in the syntax: what the argument's type names
                // (`app($this->helpers[$type])`).
                let dynamic = class.is_empty() && string.is_empty() && !site.args.is_empty() && !site.stored;
                let args = if dynamic { (site.arg_types)().into_iter().take(1).collect() } else { Vec::new() };
                Some(provided(self.key(), payload, args, (site.next)()))
            }
            CallKind::Method | CallKind::StaticMethod => {
                if let Some(getter) = Self::accessor_getter(site) {
                    return Some(LazyType::Known(Type::generic(ATTRIBUTE, vec![getter, Type::Mixed])));
                }
                let receiver = site.receiver?.clone();
                let own = relation_class(site.name).is_some() && site.args.first().is_some_and(|arg| arg.own_class);
                let class = if own { OWN_CLASS } else { class };
                // In summaries, only what is likely to matter there: relation
                // definitions and static calls on a class (facades, models).
                if site.stored
                    && relation_class(site.name).is_none()
                    && !(site.kind == CallKind::StaticMethod && matches!(receiver, LazyType::Known(Type::Named { .. })))
                {
                    return None;
                }
                // `factory(3)`: an integer first argument (a count).
                let counted = match site.args.first() {
                    Some(arg) if arg.name.is_none() && arg.int.is_some() => "n",
                    _ => "",
                };
                // `withCount('posts', 'tags as labels')`, `withCount(['posts'
                // => fn ($q) => …])`: every relation counted.
                let string = if is_one_of(COUNTING, site.name) {
                    let specs: Vec<&str> = site
                        .args
                        .iter()
                        .flat_map(|arg| arg.string.iter().chain(arg.strings.iter()))
                        .map(String::as_str)
                        .filter(|spec| !spec.contains(','))
                        .collect();
                    specs.join(",")
                } else {
                    string.to_owned()
                };
                let payload = format!("call:{}:{class}:{counted}:{string}", site.name);
                let next = (site.next)();
                Some(provided(self.key(), payload, vec![receiver, next.clone()], next))
            }
        }
    }

    fn resolve(&self, payload: &str, args: &[Type], resolver: &Resolver<'_>, context: &Context) -> Option<Type> {
        if !Self::installed(resolver) {
            return None;
        }
        // The string argument comes last: it may hold `:`.
        let (kind, rest) = payload.split_once(':')?;
        match kind {
            "helper" => {
                let [bare, fqn, class, string] = rest.splitn(4, ':').collect::<Vec<_>>()[..] else { return None };
                // A function of the same name in the caller's namespace wins.
                if fqn.contains('\\') && resolver.declarations().function(fqn).is_some() {
                    return None;
                }
                if bare == "bare" {
                    return short_name(fqn).eq_ignore_ascii_case("app").then(|| Type::named(APPLICATION));
                }
                Self::make(resolver, class, string).or_else(|| Self::made_from(resolver, args.first()?))
            }
            "auth" => {
                let (fqn, guard) = rest.split_once(':')?;
                if fqn.contains('\\') && resolver.declarations().function(fqn).is_some() {
                    return None;
                }
                Self::named_guard(resolver, args.first()?, guard)
            }
            "call" => {
                let [name, class, counted, string] = rest.splitn(4, ':').collect::<Vec<_>>()[..] else {
                    return None;
                };
                if is_one_of(COUNTING, name) {
                    let ty = self.resolve_call(name, (class, false), "", args, resolver, context);
                    // A relation forwards `withCount` to its query, and
                    // keeps itself.
                    let base =
                        ty.or_else(|| args.get(1).filter(|core| **core != Type::Mixed).cloned()).or_else(|| {
                            let receiver = args.first()?;
                            Self::is_a(resolver, receiver, context, &[RELATION]).then(|| receiver.clone())
                        })?;
                    return Some(Self::counting(resolver, base, string));
                }
                let ty = self.resolve_call(name, (class, counted == "n"), string, args, resolver, context);
                if is_one_of(JOINS, name) && !string.is_empty() {
                    // The builder remembers the joined table (`'users as u'`)
                    // after the table or model it queries.
                    let base = ty.or_else(|| args.get(1).filter(|core| **core != Type::Mixed).cloned())?;
                    return Some(Self::joined(resolver, base, string, context));
                }
                ty
            }
            _ => None,
        }
    }

    fn magic_property(&self, class: &str, name: &str, resolver: &Resolver<'_>) -> Option<Type> {
        if !Self::installed(resolver) {
            return None;
        }
        Self::model_property(resolver, class, name).or_else(|| Self::request_property(resolver, class, name)).or_else(
            || {
                // A model contract's property is its model's.
                let contract = resolver.class_model(class)?;
                let model = Self::stands_for(resolver, &contract)?;
                Self::model_property(resolver, &model, name)
            },
        )
    }

    fn magic_members(&self, receiver: &Type, resolver: &Resolver<'_>, context: &Context) -> Vec<MagicMember> {
        if !Self::installed(resolver) {
            return Vec::new();
        }
        Self::members_of(resolver, receiver, context)
    }

    fn receiver_refining_methods(&self) -> &'static [&'static str] {
        &["loadCount"]
    }

    /// `$post->loadCount('tags')` (and on a collection of models) counts
    /// on the object itself.
    fn refines_receiver(&self, receiver: &Type, method: &str, resolver: &Resolver<'_>, context: &Context) -> bool {
        method.eq_ignore_ascii_case("loadCount")
            && Self::installed(resolver)
            && Self::is_a(resolver, receiver, context, &[MODEL, COLLECTION])
    }

    fn closure_parameters(
        &self,
        receiver: &Type,
        method: &str,
        key: &str,
        resolver: &Resolver<'_>,
        context: &Context,
    ) -> Option<Vec<Type>> {
        if !Self::installed(resolver) {
            return None;
        }
        Self::relation_closure(resolver, receiver, method, key, context)
            .or_else(|| Self::fake_closure(resolver, method, key))
            .or_else(|| Self::join_closure(resolver, receiver, method, context))
            .or_else(|| Self::query_closure(resolver, receiver, method, context))
            .or_else(|| {
                // `$repository->scopeQuery(fn ($query) => …)`: its model's query.
                if !method.eq_ignore_ascii_case("scopeQuery") {
                    return None;
                }
                let model = Self::repository_model(resolver, receiver, context)?;
                Some(vec![Type::generic(ELOQUENT_BUILDER, vec![Type::named(&model)])])
            })
    }

    /// The `Builder $query` of a model's local scope (`scopePublished`, a
    /// `#[Scope]` method), declared raw or not declared at all
    /// (`scopeActive($query)`), is the model's builder.
    fn parameter(&self, site: &ParameterSite<'_>, resolver: &Resolver<'_>) -> Option<Type> {
        let scope = scope_name(&site.method.name).is_some() || is_scope_attributed(site.method);
        if site.index != 0 || !scope || site.method.is_static {
            return None;
        }
        let raw = *site.declared == Type::Mixed
            || matches!(site.declared, Type::Named { fqn, args }
                if args.is_empty() && fqn.trim_start_matches('\\').eq_ignore_ascii_case(ELOQUENT_BUILDER));
        if !raw || !Self::installed(resolver) {
            return None;
        }
        let model = resolver.class_model(site.class).filter(|model| model.is_subclass_of(MODEL))?;
        Some(Type::generic(ELOQUENT_BUILDER, vec![Type::named(model.fqn())]))
    }
}

#[cfg(test)]
#[path = "laravel_tests.rs"]
pub(crate) mod tests;
