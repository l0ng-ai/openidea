//! `PhpUndefinedRoute`: a route name no route defines, passed where a type
//! provider knows the route names ([`TypeProvider::known_strings`]): in a
//! Symfony project, the first argument of `path()`, `url()`,
//! `generateUrl()`, `redirectToRoute()` and a URL generator's `generate()`,
//! checked against `config/routes*.yaml` and the `#[Route]` attributes.
//!
//! Only string literals are checked, and only while the indexes are ready
//! and the project names some route (a project whose routes come from
//! somewhere the engine doesn't read reports nothing).
//!
//! [`TypeProvider::known_strings`]: crate::types::provider::TypeProvider::known_strings

use ide_core::Severity;
use mago_syntax::cst::{Argument, Call, ClassLikeMemberSelector, Expression, Literal};
use mago_syntax::walker::Walker;

use super::{Inspection, InspectionContext, Problems};
use crate::engine::{EngineState, is_meta_path};
use crate::signature::{Callee, callee};
use crate::types::Type;
use crate::types::ops::literal_type;
use crate::types::provider::{ArgumentOf, KnownKind, TypeProviders};

/// `PhpUndefinedRoute`.
pub struct UndefinedRoute;

impl Inspection for UndefinedRoute {
    fn id(&self) -> &'static str {
        "PhpUndefinedRoute"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        if cx.engine.status().state != EngineState::Ready || is_meta_path(cx.path) {
            return;
        }
        let resolver = cx.resolver();
        let providers = resolver.providers();
        let mut calls = Calls { providers, found: Vec::new() };
        CallWalker.walk_program(cx.parsed.program(), &mut calls);
        let types = cx.types();
        for (call, literal) in calls.found {
            if cx.is_cancelled() {
                return;
            }
            let Expression::Literal(literal) = literal else { continue };
            let (Literal::String(string), Type::LiteralString(value)) = (literal, literal_type(literal)) else {
                continue;
            };
            let start = string.span.start.offset;
            let frames = types.locate(start).expression.map(|(_, frames)| frames).unwrap_or_default();
            let Some(target) = callee(types, cx.names(), &resolver, call, &frames) else { continue };
            let argument = match &target {
                Callee::Function(fqn) => ArgumentOf::Function(fqn),
                Callee::Method { receiver, name } => ArgumentOf::Method { receiver, name },
            };
            let context = types.context(&frames);
            let Some(known) = providers.known_strings(argument, 0, &resolver, &context) else { continue };
            if known.kind != KnownKind::Route || known.values.iter().any(|known| known.value == value) {
                continue;
            }
            // Inside the quotes.
            let (from, to) = if string.raw.len() >= 2 {
                (start + 1, string.span.end.offset - 1)
            } else {
                (start, string.span.end.offset)
            };
            out.report(from, to, format!("Route '{value}' is not defined"));
        }
    }
}

/// The calls whose first argument is a string literal and whose name some
/// provider knows string arguments of.
struct Calls<'a, 'p> {
    providers: &'p TypeProviders,
    found: Vec<(&'a Expression<'a>, &'a Expression<'a>)>,
}

struct CallWalker;

impl<'a, 'p> Walker<'a, 'a, Calls<'a, 'p>> for CallWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Calls<'a, 'p>) {
        let Expression::Call(call) = expr else { return };
        let (name, list) = match call {
            Call::Function(call) => match call.function {
                Expression::Identifier(identifier) => {
                    let name = String::from_utf8_lossy(identifier.value()).into_owned();
                    (name.rsplit('\\').next().unwrap_or_default().to_owned(), &call.argument_list)
                }
                _ => return,
            },
            Call::Method(call) => match &call.method {
                ClassLikeMemberSelector::Identifier(name) => {
                    (String::from_utf8_lossy(name.value).into_owned(), &call.argument_list)
                }
                _ => return,
            },
            Call::NullSafeMethod(call) => match &call.method {
                ClassLikeMemberSelector::Identifier(name) => {
                    (String::from_utf8_lossy(name.value).into_owned(), &call.argument_list)
                }
                _ => return,
            },
            Call::StaticMethod(_) => return,
        };
        if !cx.providers.has_known_strings(&name) {
            return;
        }
        if let Some(Argument::Positional(argument)) = list.arguments.first()
            && matches!(argument.value, Expression::Literal(Literal::String(_)))
        {
            cx.found.push((expr, argument.value));
        }
    }
}
