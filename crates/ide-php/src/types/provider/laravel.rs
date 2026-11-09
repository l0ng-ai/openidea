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
//!   migrated columns, each with where it comes from. Dynamic `where*` calls
//!   aren't listed.
//!
//! The behaviour follows Laravel's public documentation and its MIT source
//! (`Facade::__callStatic`, `Model::__call`, `Builder::__call`,
//! `Application::registerCoreContainerAliases`).

use super::{AttributeOrigin, CallKind, CallSite, MagicMember, MagicTarget, Source, TypeProvider, provided};
use crate::frameworks::laravel::validation::rule_type;
use crate::summary::{ClassKind, Column, LaravelFacts, ModelCasts, RequestRules, Visibility};
use crate::types::{ClassModel, Context, LazyType, Resolver, Type};

const APPLICATION: &str = "Illuminate\\Foundation\\Application";
const CONTAINER: &str = "Illuminate\\Contracts\\Container\\Container";
const CONTAINER_CLASS: &str = "Illuminate\\Container\\Container";
const FACADE: &str = "Illuminate\\Support\\Facades\\Facade";
const MODEL: &str = "Illuminate\\Database\\Eloquent\\Model";
const FORM_REQUEST: &str = "Illuminate\\Foundation\\Http\\FormRequest";
const ELOQUENT_BUILDER: &str = "Illuminate\\Database\\Eloquent\\Builder";
const QUERY_BUILDER: &str = "Illuminate\\Database\\Query\\Builder";
const DATABASE_MANAGER: &str = "Illuminate\\Database\\DatabaseManager";
const DATABASE_CONNECTION: &str = "Illuminate\\Database\\ConnectionInterface";
const COLLECTION: &str = "Illuminate\\Database\\Eloquent\\Collection";
const ATTRIBUTE: &str = "Illuminate\\Database\\Eloquent\\Casts\\Attribute";
const RELATIONS: &str = "Illuminate\\Database\\Eloquent\\Relations\\";
const RELATION: &str = "Illuminate\\Database\\Eloquent\\Relations\\Relation";
const SUPPORT_COLLECTION: &str = "Illuminate\\Support\\Collection";
const FACTORY: &str = "Illuminate\\Database\\Eloquent\\Factories\\Factory";
const CARBON: &str = "Illuminate\\Support\\Carbon";
const CARBON_IMMUTABLE: &str = "Carbon\\CarbonImmutable";

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

    /// The class behind facade `facade` (what its `getFacadeAccessor()`
    /// names), when it is one class.
    pub(crate) fn facade_class(resolver: &Resolver<'_>, facade: &str) -> Option<String> {
        let service = Self::facade_service(resolver, &Type::named(facade), &Context::default())?;
        match service.members() {
            [Type::Named { fqn, .. }] => Some(fqn.trim_start_matches('\\').to_owned()),
            _ => None,
        }
    }

    /// The `make()` of a container: the binding a string names, else the
    /// class an argument names (`Foo::class`).
    fn make(resolver: &Resolver<'_>, class: &str, string: &str) -> Option<Type> {
        if !string.is_empty() {
            return Self::binding(resolver, string);
        }
        (!class.is_empty()).then(|| Type::named(class))
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
        // A static call on a facade is a call on its service.
        let facade = Self::is_a(resolver, receiver, context, &[FACADE])
            .then(|| Self::facade_service(resolver, receiver, context))
            .flatten();
        let target = facade.as_ref().unwrap_or(receiver);
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
            // is as good.
            let generic =
                core.members().iter().any(|member| matches!(member, Type::Named { args, .. } if !args.is_empty()));
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
        // Eloquent's collection, or the subclass the declaration names.
        let class = core
            .members()
            .iter()
            .find_map(|member| match member {
                Type::Named { fqn, .. } if Self::is_a(resolver, member, context, &[COLLECTION]) => Some(fqn.clone()),
                _ => None,
            })
            .unwrap_or_else(|| COLLECTION.to_owned());
        Some(Type::generic(&class, vec![Type::Int, Type::named(&model)]))
    }

    /// The factory class of `model` by Laravel's convention
    /// (`Factory::resolveFactoryName`): `Database\Factories\` and the
    /// model's name below the app's `Models\` namespace, plus `Factory`.
    pub(crate) fn factory_of(resolver: &Resolver<'_>, model: &str) -> Option<String> {
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
        let this = Type::named(model.fqn());
        let returned = resolver.method_return(&this, name, &Context::default());
        let raw_relation = returned.members().iter().any(|member| {
            matches!(member, Type::Named { fqn, args } if args.is_empty()
                && resolver.class_model(fqn).is_some_and(|class| class.is_subclass_of(RELATION)))
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
                && resolver.class_model(fqn).is_some_and(|class| class.is_subclass_of(RELATION)))
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

    /// The relation `name` (`posts_count`, `blog_posts_count`) counts, as
    /// `withCount()` loads it.
    fn count_relation(resolver: &Resolver<'_>, class: &str, name: &str) -> Option<String> {
        let relation = name.strip_suffix("_count").filter(|relation| !relation.is_empty())?;
        Self::model_relations(resolver, class)
            .into_iter()
            .find(|found| found.name == relation || snake(&found.name) == relation)
            .map(|found| found.name)
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

    /// The magic properties of a model: relations, accessors, casts and
    /// migrated columns (in that order, the first of a name winning).
    fn attributes(resolver: &Resolver<'_>, model: &ClassModel, out: &mut Vec<MagicMember>) {
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
        // `withCount('posts')` loads `posts_count` (laravel-ide-helper lists
        // one for every relation too).
        for relation in Self::model_relations(resolver, &class) {
            let origin = AttributeOrigin::Count { method: relation.name.clone() };
            push(&mut found, format!("{}_count", snake(&relation.name)), origin);
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
                Self::attributes(resolver, &model, &mut out);
            } else if model.is_subclass_of(FORM_REQUEST) {
                Self::request_fields(resolver, &model, &mut out);
            }
        }
        // A builder or relation: the related model's scopes, then what it
        // forwards to.
        for member in receiver.members() {
            let Type::Named { fqn, args } = member else { continue };
            let Some(model) = resolver.class_model(fqn) else { continue };
            let relation = model.is_subclass_of(RELATION);
            if !relation && !model.is_subclass_of(ELOQUENT_BUILDER) {
                continue;
            }
            if let Some(Type::Named { fqn: related, .. }) = args.first() {
                Self::scopes(resolver, related, false, &mut out);
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
            (None, Some(column)) => Type::from_doc(&column.ty, &[]),
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
                if !short.eq_ignore_ascii_case("app") && !short.eq_ignore_ascii_case("resolve") {
                    return None;
                }
                // `app()` without arguments is the application.
                let bare = if site.args.is_empty() { "bare" } else { "args" };
                let payload = format!("helper:{bare}:{}:{class}:{string}", site.name);
                Some(provided(self.key(), payload, Vec::new(), (site.next)()))
            }
            CallKind::Method | CallKind::StaticMethod => {
                let receiver = site.receiver?.clone();
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
                Self::make(resolver, class, string)
            }
            "call" => {
                let [name, class, counted, string] = rest.splitn(4, ':').collect::<Vec<_>>()[..] else {
                    return None;
                };
                self.resolve_call(name, (class, counted == "n"), string, args, resolver, context)
            }
            _ => None,
        }
    }

    fn magic_property(&self, class: &str, name: &str, resolver: &Resolver<'_>) -> Option<Type> {
        if !Self::installed(resolver) {
            return None;
        }
        Self::model_property(resolver, class, name).or_else(|| Self::request_property(resolver, class, name))
    }

    fn magic_members(&self, receiver: &Type, resolver: &Resolver<'_>, context: &Context) -> Vec<MagicMember> {
        if !Self::installed(resolver) {
            return Vec::new();
        }
        Self::members_of(resolver, receiver, context)
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
    }
}

#[cfg(test)]
#[path = "laravel_tests.rs"]
pub(crate) mod tests;
