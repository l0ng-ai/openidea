//! Directives from the AST of a `PHPSTORM_META` namespace.

use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Access, Argument, ArrayElement, Call, ClassLikeConstantSelector, ClassLikeMemberSelector, Expression, FunctionCall,
    TokenSeparatedSequence,
};

use super::{Callee, ExpectedArguments, ExpectedReturnValues, MetaDirectives, MetaValue, Override, OverrideKind};
use crate::names::{NameKind, NameScope, Resolution};
use crate::types::Type;
use crate::types::ops::literal_type;

/// Whether `scope` is the metadata namespace.
fn is_meta_namespace(scope: &NameScope) -> bool {
    scope.namespace().eq_ignore_ascii_case("PHPSTORM_META")
}

/// Adds the directive `call` stands for (a top-level `override(…)`,
/// `expectedArguments(…)`, … in the `PHPSTORM_META` namespace) to `out`.
/// Other calls, and directives that can't be read, are ignored. `source`
/// gives the text of a span.
pub(crate) fn directive(
    scope: &NameScope,
    call: &FunctionCall<'_>,
    source: &dyn Fn(Span) -> String,
    out: &mut MetaDirectives,
) {
    if !is_meta_namespace(scope) {
        return;
    }
    let Some(name) = function_name(call.function) else { return };
    let cx = Cx { scope, source };
    let args: Vec<&Expression<'_>> = arguments(&call.argument_list.arguments);
    match name.to_ascii_lowercase().as_str() {
        "override" => {
            let (Some(target), Some(kind)) = (args.first(), args.get(1)) else { return };
            let Some((callee, arg)) = cx.callee(target) else { return };
            let Some(kind) = cx.override_kind(kind) else { return };
            out.overrides.push(Override { callee, arg: arg.unwrap_or(0), kind });
        }
        "expectedarguments" => {
            let (Some(target), Some(index)) = (args.first(), args.get(1)) else { return };
            let Some((callee, _)) = cx.callee(target) else { return };
            let Some(index) = int_of(index) else { return };
            let values = args[2..].iter().filter_map(|value| cx.value(value)).collect();
            out.expected_arguments.push(ExpectedArguments { callee, index, values });
        }
        "expectedreturnvalues" => {
            let Some(target) = args.first() else { return };
            let Some((callee, _)) = cx.callee(target) else { return };
            let values = args[1..].iter().filter_map(|value| cx.value(value)).collect();
            out.expected_return_values.push(ExpectedReturnValues { callee, values });
        }
        "registerargumentsset" => {
            let Some(Some(set)) = args.first().map(|name| string_of(name)) else { return };
            let values = args[1..].iter().filter_map(|value| cx.value(value)).collect();
            out.arguments_sets.push((set, values));
        }
        "exitpoint" => {
            let Some(target) = args.first() else { return };
            let Some((callee, _)) = cx.callee(target) else { return };
            out.exit_points.push(callee);
        }
        _ => {}
    }
}

/// The last segment of a called function's name (`override`,
/// `\PHPSTORM_META\override`).
fn function_name(function: &Expression<'_>) -> Option<String> {
    let Expression::Identifier(identifier) = function else { return None };
    let name = String::from_utf8_lossy(identifier.value());
    Some(name.rsplit('\\').next().unwrap_or_default().to_owned())
}

fn arguments<'a>(list: &'a TokenSeparatedSequence<'a, Argument<'a>>) -> Vec<&'a Expression<'a>> {
    list.iter()
        .map(|argument| match argument {
            Argument::Positional(argument) => argument.value,
            Argument::Named(argument) => argument.value,
        })
        .collect()
}

fn int_of(expr: &Expression<'_>) -> Option<u32> {
    match expr {
        Expression::Literal(literal) => match literal_type(literal) {
            Type::LiteralInt(value) => u32::try_from(value).ok(),
            _ => None,
        },
        _ => None,
    }
}

fn string_of(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::Literal(literal) => match literal_type(literal) {
            Type::LiteralString(value) => Some(value),
            _ => None,
        },
        _ => None,
    }
}

struct Cx<'s> {
    scope: &'s NameScope,
    source: &'s dyn Fn(Span) -> String,
}

impl Cx<'_> {
    fn class(&self, expr: &Expression<'_>) -> Option<String> {
        let Expression::Identifier(identifier) = expr else { return None };
        match self.scope.resolve(NameKind::ClassLike, &String::from_utf8_lossy(identifier.value())).resolution {
            Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => Some(fqn),
            Resolution::Relative(_) => None,
        }
    }

    /// A name used inside the fake `PHPSTORM_META` namespace: written
    /// unqualified, it means the global one.
    fn global(&self, kind: NameKind, name: &[u8]) -> String {
        match self.scope.resolve(kind, &String::from_utf8_lossy(name)).resolution {
            Resolution::Fallback { global, .. } => global,
            Resolution::Fqn(fqn) => fqn,
            Resolution::Relative(_) => String::from_utf8_lossy(name).into_owned(),
        }
    }

    /// `\f(0)` or `\Foo::m(0)`: the callee and the argument index written.
    fn callee(&self, expr: &Expression<'_>) -> Option<(Callee, Option<u32>)> {
        let Expression::Call(call) = expr else { return None };
        let (callee, list) = match call {
            Call::Function(call) => {
                let Expression::Identifier(identifier) = call.function else { return None };
                (Callee::Function(self.global(NameKind::Function, identifier.value())), &call.argument_list)
            }
            Call::StaticMethod(call) => {
                let class = self.class(call.class)?;
                let ClassLikeMemberSelector::Identifier(name) = &call.method else { return None };
                (Callee::Method { class, name: String::from_utf8_lossy(name.value).into_owned() }, &call.argument_list)
            }
            _ => return None,
        };
        let arg = arguments(&list.arguments).first().and_then(|arg| int_of(arg));
        Some((callee, arg))
    }

    /// `map([…])`, `type(n)`, `elementType(n)`.
    fn override_kind(&self, expr: &Expression<'_>) -> Option<OverrideKind> {
        let Expression::Call(Call::Function(call)) = expr else { return None };
        let args = arguments(&call.argument_list.arguments);
        match function_name(call.function)?.to_ascii_lowercase().as_str() {
            "map" => {
                let elements = match args.first()? {
                    Expression::Array(array) => &array.elements,
                    Expression::LegacyArray(array) => &array.elements,
                    _ => return None,
                };
                let entries = elements
                    .iter()
                    .filter_map(|element| match element {
                        ArrayElement::KeyValue(element) => Some((self.key(element.key)?, self.key(element.value)?)),
                        _ => None,
                    })
                    .collect();
                Some(OverrideKind::Map(entries))
            }
            "type" => Some(OverrideKind::Type(int_of(args.first()?)?)),
            "elementtype" => Some(OverrideKind::ElementType(int_of(args.first()?)?)),
            _ => None,
        }
    }

    /// A `map` key or value: a string's value, or the class of `Foo::class`.
    fn key(&self, expr: &Expression<'_>) -> Option<String> {
        match expr {
            Expression::Access(Access::ClassConstant(access)) => match &access.constant {
                ClassLikeConstantSelector::Identifier(constant) if constant.value.eq_ignore_ascii_case(b"class") => {
                    self.class(access.class)
                }
                _ => None,
            },
            other => string_of(other),
        }
    }

    /// An expected value.
    fn value(&self, expr: &Expression<'_>) -> Option<MetaValue> {
        Some(match expr {
            Expression::Literal(literal) => match literal_type(literal) {
                Type::LiteralString(value) => MetaValue::String(value),
                Type::LiteralInt(value) => MetaValue::Int(value),
                _ => MetaValue::Other((self.source)(expr.span())),
            },
            Expression::Access(Access::ClassConstant(access)) => {
                let ClassLikeConstantSelector::Identifier(constant) = &access.constant else { return None };
                let class = self.class(access.class)?;
                if constant.value.eq_ignore_ascii_case(b"class") {
                    MetaValue::Class(class)
                } else {
                    MetaValue::ClassConstant { class, name: String::from_utf8_lossy(constant.value).into_owned() }
                }
            }
            Expression::ConstantAccess(constant) => {
                MetaValue::Constant(self.global(NameKind::Constant, constant.name.value()))
            }
            Expression::Call(Call::Function(call))
                if function_name(call.function).is_some_and(|name| name.eq_ignore_ascii_case("argumentsSet")) =>
            {
                MetaValue::ArgumentsSet(string_of(arguments(&call.argument_list.arguments).first()?)?)
            }
            other => MetaValue::Other((self.source)(other.span())),
        })
    }
}
