//! Extraction of [`SymfonyFacts`](crate::summary::SymfonyFacts):
//!
//! - **Routes:** `#[Route]` attributes (`Symfony\Component\Routing\Attribute
//!   \Route`, or the older `…\Annotation\Route`) on methods with a `name`
//!   (named, or the second positional argument), prefixed with the name and
//!   path of the class's own `#[Route]`, as Symfony's attribute loader does.
//! - **Repositories:** an entity's `repositoryClass`, and in a class
//!   extending a `…Repository` class, `parent::__construct($registry,
//!   Product::class)` (Doctrine's `ServiceEntityRepository`).

use mago_span::Span;
use mago_syntax::cst::{
    ArgumentList, AttributeList, ClassLikeMember, ClassLikeMemberSelector, Expression, Literal, PartialArgument,
    Sequence,
};

use super::Extractor;
use crate::summary::{Loc, RepositoryEntity, RouteAttribute};
use crate::types::Type;
use crate::types::ops::literal_type;

const ROUTE_ATTRIBUTES: [&str; 2] =
    ["Symfony\\Component\\Routing\\Attribute\\Route", "Symfony\\Component\\Routing\\Annotation\\Route"];

/// The name and path a `#[Route]` gives, with where the name is written.
#[derive(Default)]
struct Route {
    name: Option<(String, Loc)>,
    path: Option<String>,
}

impl Extractor<'_> {
    /// A string literal's value and the location of its text inside the
    /// quotes.
    fn string_at(&self, expr: &Expression<'_>) -> Option<(String, Loc)> {
        let Expression::Literal(literal) = expr else { return None };
        let Type::LiteralString(value) = literal_type(literal) else { return None };
        let Literal::String(string) = literal else { return None };
        let mut span: Span = string.span;
        if string.raw.len() >= 2 {
            span.start.offset += 1;
            span.end.offset -= 1;
        }
        Some((value, self.loc(span)))
    }

    /// The first `#[Route]` of `lists`.
    fn route(&self, lists: &Sequence<'_, AttributeList<'_>>) -> Option<Route> {
        let attribute = lists.iter().flat_map(|list| list.attributes.iter()).find(|attribute| {
            let name = self.class_name(&attribute.name);
            ROUTE_ATTRIBUTES.iter().any(|route| route.eq_ignore_ascii_case(&name))
        })?;
        let mut route = Route::default();
        let Some(list) = &attribute.argument_list else { return Some(route) };
        for (index, argument) in list.arguments.iter().enumerate() {
            let (name, value) = match argument {
                PartialArgument::Named(argument) => (Some(argument.name.value), argument.value),
                PartialArgument::Positional(argument) => (None, argument.value),
                _ => continue,
            };
            match (name, index) {
                (Some(b"name"), _) | (None, 1) => route.name = self.string_at(value),
                (Some(b"path"), _) | (None, 0) => route.path = self.string_at(value).map(|(path, _)| path),
                _ => {}
            }
        }
        Some(route)
    }

    /// The named `#[Route]`s of a class's methods.
    pub(super) fn routes(
        &mut self,
        attributes: &Sequence<'_, AttributeList<'_>>,
        members: &Sequence<'_, ClassLikeMember<'_>>,
    ) {
        let mut prefix: Option<Route> = None;
        for member in members {
            let ClassLikeMember::Method(method) = member else { continue };
            let Some(route) = self.route(&method.attribute_lists) else { continue };
            let Some((name, loc)) = route.name else { continue };
            let prefix = prefix.get_or_insert_with(|| self.route(attributes).unwrap_or_default());
            let name_prefix = prefix.name.as_ref().map(|(name, _)| name.as_str()).unwrap_or_default();
            let path = match (&prefix.path, route.path) {
                (Some(base), Some(path)) => Some(format!("{}{path}", base.trim_end_matches('/'))),
                (None, path) => path,
                (Some(base), None) => Some(base.clone()),
            };
            self.summary.symfony.routes.push(RouteAttribute { name: format!("{name_prefix}{name}"), path, loc });
        }
    }

    /// An entity's `repositoryClass`.
    pub(super) fn entity_repository(&mut self, entity: &str, repository: Option<&str>) {
        if let Some(repository) = repository {
            self.summary.symfony.repositories.push(RepositoryEntity {
                repository: repository.trim_start_matches('\\').to_owned(),
                entity: entity.to_owned(),
            });
        }
    }

    /// `parent::__construct($registry, Product::class)` in a repository.
    pub(super) fn repository_constructor(
        &mut self,
        class: &Expression<'_>,
        selector: &ClassLikeMemberSelector<'_>,
        list: &ArgumentList<'_>,
    ) {
        let Some(repository) = self.repository_scope.clone() else { return };
        if !matches!(class, Expression::Parent(_)) {
            return;
        }
        let ClassLikeMemberSelector::Identifier(method) = selector else { return };
        if !method.value.eq_ignore_ascii_case(b"__construct") {
            return;
        }
        let Some(entity) = list.arguments.get(1).and_then(|argument| self.class_constant_name(argument.value())) else {
            return;
        };
        let known = self.summary.symfony.repositories.iter().any(|known| known.repository == repository);
        if !known {
            self.summary.symfony.repositories.push(RepositoryEntity { repository, entity });
        }
    }
}

/// Whether a class extending `parent` (FQN) can be a Doctrine repository.
pub(super) fn extends_repository(parent: &str) -> bool {
    parent.rsplit('\\').next().is_some_and(|short| short.ends_with("Repository"))
}
