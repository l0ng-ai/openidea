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
//! Not yet: `@property` from `$casts`/`casts()` and migrations, and the
//! bindings that service providers register (phase 7.1.b).
//!
//! The behaviour follows Laravel's public documentation and its MIT source
//! (`Facade::__callStatic`, `Model::__call`, `Builder::__call`,
//! `Application::registerCoreContainerAliases`).

use super::{CallKind, CallSite, TypeProvider, provided};
use crate::types::{Context, LazyType, Resolver, Type};

const APPLICATION: &str = "Illuminate\\Foundation\\Application";
const CONTAINER: &str = "Illuminate\\Contracts\\Container\\Container";
const CONTAINER_CLASS: &str = "Illuminate\\Container\\Container";
const FACADE: &str = "Illuminate\\Support\\Facades\\Facade";
const MODEL: &str = "Illuminate\\Database\\Eloquent\\Model";
const ELOQUENT_BUILDER: &str = "Illuminate\\Database\\Eloquent\\Builder";
const QUERY_BUILDER: &str = "Illuminate\\Database\\Query\\Builder";
const COLLECTION: &str = "Illuminate\\Database\\Eloquent\\Collection";
const ATTRIBUTE: &str = "Illuminate\\Database\\Eloquent\\Casts\\Attribute";
const RELATIONS: &str = "Illuminate\\Database\\Eloquent\\Relations\\";
const RELATION: &str = "Illuminate\\Database\\Eloquent\\Relations\\Relation";

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

    /// The class a container binding name stands for: a core alias, or a
    /// class that exists.
    fn binding(resolver: &Resolver<'_>, name: &str) -> Option<Type> {
        if let Some(class) = core_alias(name) {
            return Some(Type::named(class));
        }
        let name = name.trim_start_matches('\\');
        resolver.class_model(name).map(|model| Type::named(model.fqn()))
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
        class: &str,
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

    /// `scope{Name}()` on `model`.
    fn has_scope(resolver: &Resolver<'_>, model: &str, name: &str) -> bool {
        resolver.class_model(model).is_some_and(|model| model.method(&format!("scope{name}")).is_some())
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
            let returned = resolver.method_return(&this, name, &context);
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
        None
    }
}

/// `first_name` → `FirstName`.
fn studly(name: &str) -> String {
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
                let payload = format!("call:{}:{class}:{string}", site.name);
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
                let [name, class, string] = rest.splitn(3, ':').collect::<Vec<_>>()[..] else { return None };
                self.resolve_call(name, class, string, args, resolver, context)
            }
            _ => None,
        }
    }

    fn magic_property(&self, class: &str, name: &str, resolver: &Resolver<'_>) -> Option<Type> {
        if !Self::installed(resolver) {
            return None;
        }
        Self::model_property(resolver, class, name)
    }
}

#[cfg(test)]
#[path = "laravel_tests.rs"]
mod tests;
