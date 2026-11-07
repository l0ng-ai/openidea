//! Symfony: the service container and Doctrine repositories.
//!
//! - **Container:** `$container->get(Foo::class)` (and `get('App\Foo')`) on
//!   a PSR or Symfony container is `Foo`: with autowiring, a service's id is
//!   its class name. Ids `config/services.yaml` defines
//!   ([`crate::symfony::SymfonyConfig`]) are the class their definition
//!   makes, through aliases and parents: `get('mailer.default')`.
//! - **Doctrine:** `getRepository(Product::class)` on an object manager or
//!   a manager registry is the repository class the entity names
//!   (`#[ORM\Entity(repositoryClass: ProductRepository::class)]`), else
//!   `EntityRepository<Product>`. On a repository of a known entity (a
//!   generic `EntityRepository<Product>`, or a class whose `find()` its
//!   `@extends ServiceEntityRepository<Product>` types), `find()`,
//!   `findOneBy()` and the magic `findOneBy{Field}()` are `?Product`,
//!   `findAll()`, `findBy()` and `findBy{Field}()` are `list<Product>`, and
//!   `count()` and `countBy{Field}()` are `int`. Declared and documented
//!   types win: the provider only answers where they don't name a class.
//!   A repository without generics gets its entity from the entity whose
//!   mapping names it, or from its `parent::__construct($registry,
//!   Product::class)` ([`crate::summary::SymfonyFacts`]).
//! - **Routes** ([`TypeProvider::known_strings`]): the first argument of
//!   `path()` and `url()`, of `generateUrl()` and `redirectToRoute()` on a
//!   controller and of `generate()` on a URL generator is one of the route
//!   names of `config/routes*.yaml` and the `#[Route]` attributes, for
//!   completion and the `PhpUndefinedRoute` inspection. Nothing is known
//!   (and so nothing reported) while the project has no named route.
//! - **Members** ([`TypeProvider::magic_members`]): on such a repository,
//!   `findBy{Field}`, `findOneBy{Field}` and `countBy{Field}` for each of
//!   the entity's properties.
//!
//! Only when symfony/framework-bundle is installed (its `FrameworkBundle`
//! class is known); otherwise every payload falls back to what the other
//! providers say. The behaviour follows Symfony's and Doctrine's public
//! documentation and their MIT source (`EntityRepository::__call`,
//! `ObjectManager::getRepository`).

use super::{
    ArgumentOf, CallKind, CallSite, KnownKind, KnownString, KnownStrings, MagicMember, MagicTarget, TypeProvider,
    provided,
};
use crate::types::{Context, LazyType, Resolver, Type};

const FRAMEWORK_BUNDLE: &str = "Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle";
const PSR_CONTAINER: &str = "Psr\\Container\\ContainerInterface";
const SYMFONY_CONTAINER: &str = "Symfony\\Component\\DependencyInjection\\ContainerInterface";
const OBJECT_MANAGER: &str = "Doctrine\\Persistence\\ObjectManager";
const MANAGER_REGISTRY: &str = "Doctrine\\Persistence\\ManagerRegistry";
const OBJECT_REPOSITORY: &str = "Doctrine\\Persistence\\ObjectRepository";
const ENTITY_REPOSITORY: &str = "Doctrine\\ORM\\EntityRepository";
const ABSTRACT_CONTROLLER: &str = "Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController";
const URL_GENERATOR: &str = "Symfony\\Component\\Routing\\Generator\\UrlGeneratorInterface";

/// Functions taking a route name first (Twig's, sometimes defined in PHP).
const ROUTE_FUNCTIONS: [&str; 2] = ["path", "url"];
/// Controller methods taking a route name first.
const ROUTE_METHODS: [&str; 2] = ["generateUrl", "redirectToRoute"];
/// Every call name whose route argument is known.
const ROUTE_CALLS: &[&str] = &["path", "url", "generateUrl", "redirectToRoute", "generate"];

/// What a repository method returns, by name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Finder {
    /// `?Entity`.
    One,
    /// `list<Entity>`.
    Many,
    /// `int`.
    Count,
}

/// `find`, `findOneBy`, `findOneByName`, `findAll`, `findBy`, `findByName`,
/// `count`, `countByName` (Doctrine's `EntityRepository::__call` prefixes).
fn finder(method: &str) -> Option<Finder> {
    let lower = method.to_ascii_lowercase();
    if lower == "find" || lower.starts_with("findoneby") {
        Some(Finder::One)
    } else if lower == "findall" || lower.starts_with("findby") {
        Some(Finder::Many)
    } else if lower == "count" || lower.starts_with("countby") {
        Some(Finder::Count)
    } else {
        None
    }
}

/// `findByName`, `findOneByName`, `countByName`: a finder `__call` answers.
fn is_magic_finder(method: &str) -> bool {
    let lower = method.to_ascii_lowercase();
    ["findby", "findoneby", "countby"].iter().any(|prefix| lower.len() > prefix.len() && lower.starts_with(prefix))
}

/// See the module documentation.
pub struct SymfonyProvider;

impl SymfonyProvider {
    fn installed(resolver: &Resolver<'_>) -> bool {
        resolver.class_model(FRAMEWORK_BUNDLE).is_some()
    }

    /// True when some class among the members of `ty` is (a subclass of)
    /// one of `classes`.
    fn is_a(resolver: &Resolver<'_>, ty: &Type, context: &Context, classes: &[&str]) -> bool {
        resolver.class_models(ty, context).iter().any(|model| classes.iter().any(|class| model.is_subclass_of(class)))
    }

    /// True when `ty` names some class (not only `object`, `mixed`, arrays
    /// of them or `null`): a declared answer to keep.
    fn names_class(ty: &Type) -> bool {
        ty.members().iter().any(|member| match member {
            Type::Named { .. } => true,
            Type::List { value, .. } | Type::Array { value, .. } => Self::names_class(value),
            _ => false,
        })
    }

    /// The service `get()` returns: the class the configuration's
    /// definition of the id makes, else the class the id names.
    fn service(resolver: &Resolver<'_>, class: &str, string: &str) -> Option<Type> {
        let id = if class.is_empty() { string } else { class };
        let configured = resolver.symfony().config.service_class(id);
        if let Some(configured) = configured.filter(|configured| !configured.eq_ignore_ascii_case(id)) {
            let configured = configured.trim_start_matches('\\');
            return Some(match resolver.class_model(configured) {
                Some(model) => Type::named(model.fqn()),
                None => Type::named(configured),
            });
        }
        if !class.is_empty() {
            return Some(match resolver.class_model(class) {
                Some(model) => Type::named(model.fqn()),
                None => Type::named(class),
            });
        }
        let model = resolver.class_model(string.trim_start_matches('\\'))?;
        Some(Type::named(model.fqn()))
    }

    /// The repository of entity `class`: the class its mapping names, else
    /// the generic entity repository.
    fn repository(resolver: &Resolver<'_>, class: &str, core: &Type) -> Option<Type> {
        let entity = resolver.class_model(class);
        if let Some(repository) = entity.as_ref().and_then(|entity| entity.class.repository.as_deref())
            && let Some(model) = resolver.class_model(repository)
        {
            return Some(Type::named(model.fqn()));
        }
        // A documented `EntityRepository<T>` is as good.
        let generic =
            core.members().iter().any(|member| matches!(member, Type::Named { args, .. } if !args.is_empty()));
        if generic {
            return None;
        }
        let entity = entity.map(|entity| entity.fqn().to_owned()).unwrap_or_else(|| class.to_owned());
        Some(Type::generic(ENTITY_REPOSITORY, vec![Type::named(&entity)]))
    }

    /// The entity of a repository type: its generic argument, else the
    /// class its `find()` returns.
    fn entity(resolver: &Resolver<'_>, receiver: &Type, context: &Context) -> Option<String> {
        for member in receiver.members() {
            let Type::Named { args, .. } = member else { continue };
            if !Self::is_a(resolver, member, context, &[OBJECT_REPOSITORY, ENTITY_REPOSITORY]) {
                continue;
            }
            if let Some(Type::Named { fqn, .. }) = args.first() {
                return Some(fqn.clone());
            }
            let found = resolver.method_return(member, "find", context);
            let entity = found.members().iter().find_map(|found| match found {
                Type::Named { fqn, .. } => Some(fqn.clone()),
                _ => None,
            });
            if entity.is_some() {
                return entity;
            }
        }
        // A repository without generics: what the entities' mappings and
        // the repositories' constructors say.
        let project = resolver.symfony();
        for model in resolver.class_models(receiver, context) {
            let mut class = Some(model);
            for _ in 0..8 {
                let Some(current) = class else { break };
                if let Some(entity) = project.entity_of(current.fqn()) {
                    return Some(
                        resolver.class_model(entity).map_or_else(|| entity.to_owned(), |e| e.fqn().to_owned()),
                    );
                }
                class = current.class.extends.first().and_then(|parent| resolver.class_model(parent));
            }
        }
        None
    }

    /// See [`TypeProvider::known_strings`].
    fn routes(call: ArgumentOf<'_>, index: usize, resolver: &Resolver<'_>, context: &Context) -> Option<KnownStrings> {
        if index != 0 {
            return None;
        }
        let takes_route = match call {
            ArgumentOf::Function(fqn) => {
                ROUTE_FUNCTIONS.iter().any(|name| name.eq_ignore_ascii_case(call.name()))
                    && resolver.declarations().function(fqn).is_none()
            }
            ArgumentOf::Method { receiver, name } => {
                (ROUTE_METHODS.iter().any(|known| known.eq_ignore_ascii_case(name))
                    && Self::is_a(resolver, receiver, context, &[ABSTRACT_CONTROLLER]))
                    || (name.eq_ignore_ascii_case("generate")
                        && Self::is_a(resolver, receiver, context, &[URL_GENERATOR]))
            }
        };
        if !takes_route {
            return None;
        }
        let project = resolver.symfony();
        if project.routes.is_empty() {
            return None;
        }
        let mut values: Vec<KnownString> = Vec::new();
        for route in &project.routes {
            if !values.iter().any(|known| known.value == route.name) {
                values.push(KnownString { value: route.name.clone(), detail: route.path.clone() });
            }
        }
        Some(KnownStrings { kind: KnownKind::Route, values })
    }

    /// The resolve step of a call: `args` are the receiver and what the
    /// providers after this one say.
    fn resolve_call(
        name: &str,
        class: &str,
        string: &str,
        args: &[Type],
        resolver: &Resolver<'_>,
        context: &Context,
    ) -> Option<Type> {
        let receiver = args.first()?;
        let core = args.get(1)?;
        if name.eq_ignore_ascii_case("get") {
            if !Self::is_a(resolver, receiver, context, &[PSR_CONTAINER, SYMFONY_CONTAINER]) {
                return None;
            }
            return Self::service(resolver, class, string);
        }
        if name.eq_ignore_ascii_case("getRepository") {
            if class.is_empty() || !Self::is_a(resolver, receiver, context, &[OBJECT_MANAGER, MANAGER_REGISTRY]) {
                return None;
            }
            return Self::repository(resolver, class, core);
        }
        let finder = finder(name)?;
        if Self::names_class(core) || (finder == Finder::Count && *core != Type::Mixed) {
            return None;
        }
        let entity = Self::entity(resolver, receiver, context)?;
        Some(match finder {
            Finder::One => Type::named(&entity).nullable(),
            Finder::Many => Type::list_of(Type::named(&entity)),
            Finder::Count => Type::Int,
        })
    }

    /// See [`TypeProvider::magic_members`].
    fn members_of(resolver: &Resolver<'_>, receiver: &Type, context: &Context) -> Vec<MagicMember> {
        let Some(entity) = Self::entity(resolver, receiver, context) else { return Vec::new() };
        let Some(entity) = resolver.class_model(&entity) else { return Vec::new() };
        let Some(repository) = resolver
            .class_models(receiver, context)
            .into_iter()
            .find(|model| model.is_subclass_of(OBJECT_REPOSITORY) || model.is_subclass_of(ENTITY_REPOSITORY))
        else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for property in entity.properties.iter().filter(|property| !property.is_static) {
            let field = studly(&property.name);
            for (prefix, method) in [("findBy", "findBy"), ("findOneBy", "findOneBy"), ("countBy", "count")] {
                // Point at the method the magic call ends in, when declared.
                let target = repository
                    .method(method)
                    .map_or_else(|| repository.fqn().to_owned(), |declared| declared.declaring.fqn.clone());
                out.push(MagicMember {
                    name: format!("{prefix}{field}"),
                    is_static: false,
                    target: MagicTarget::Method { class: target, method: method.to_owned() },
                });
            }
        }
        out
    }
}

/// `first_name` or `firstName` → `FirstName`.
fn studly(name: &str) -> String {
    name.split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map(|first| first.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
        })
        .collect()
}

impl TypeProvider for SymfonyProvider {
    fn key(&self) -> &'static str {
        "symfony"
    }

    fn call(&self, site: &CallSite<'_>) -> Option<LazyType> {
        if site.kind != CallKind::Method {
            return None;
        }
        let container = site.name.eq_ignore_ascii_case("get");
        let repository = site.name.eq_ignore_ascii_case("getRepository");
        if !container && !repository && finder(site.name).is_none() {
            return None;
        }
        // In summaries, of the finders only the magic ones: the declared
        // ones (`find()` is a common name) are typed by their generics.
        if site.stored && !container && !repository && !is_magic_finder(site.name) {
            return None;
        }
        let class = site.class_arg().unwrap_or_default();
        let string = match site.args.first() {
            Some(arg) if arg.name.is_none() => arg.string.as_deref().unwrap_or_default(),
            _ => "",
        };
        // `get()` and `getRepository()` without a class or string say
        // nothing (and `get` is a common name).
        if (container || repository) && class.is_empty() && string.is_empty() {
            return None;
        }
        let receiver = site.receiver?.clone();
        let payload = format!("call:{}:{class}:{string}", site.name);
        let next = (site.next)();
        Some(provided(self.key(), payload, vec![receiver, next.clone()], next))
    }

    fn resolve(&self, payload: &str, args: &[Type], resolver: &Resolver<'_>, context: &Context) -> Option<Type> {
        if !Self::installed(resolver) {
            return None;
        }
        // The string argument comes last: it may hold `:`.
        let rest = payload.strip_prefix("call:")?;
        let [name, class, string] = rest.splitn(3, ':').collect::<Vec<_>>()[..] else { return None };
        Self::resolve_call(name, class, string, args, resolver, context)
    }

    fn magic_members(&self, receiver: &Type, resolver: &Resolver<'_>, context: &Context) -> Vec<MagicMember> {
        if !Self::installed(resolver) {
            return Vec::new();
        }
        Self::members_of(resolver, receiver, context)
    }

    fn known_string_calls(&self) -> &'static [&'static str] {
        ROUTE_CALLS
    }

    fn known_strings(
        &self,
        call: ArgumentOf<'_>,
        index: usize,
        resolver: &Resolver<'_>,
        context: &Context,
    ) -> Option<KnownStrings> {
        if !Self::installed(resolver) {
            return None;
        }
        Self::routes(call, index, resolver, context)
    }
}

#[cfg(test)]
#[path = "symfony_tests.rs"]
pub(crate) mod tests;
