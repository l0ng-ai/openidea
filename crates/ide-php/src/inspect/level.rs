//! Language level and deprecation.
//!
//! - [`LanguageLevel`] (`PhpLanguageLevel`): syntax newer than the
//!   project's PHP version ([`PhpEngine::language_level`], from Settings ›
//!   PHP or `composer.json`'s `require.php`, the latest the stubs know
//!   otherwise), an error since PHP refuses to compile it:
//!   - 7.0: scalar parameter types, return types, `??`, `<=>`, anonymous
//!     classes
//!   - 7.1: nullable types, `void`, `iterable`, multi-catch, short list
//!     destructuring (`[$a, $b] = …`), class constant visibility
//!   - 7.2: `object`
//!   - 7.4: typed properties, arrow functions, `??=`, spread in array
//!     literals, numeric literal separators
//!   - 8.0: union types, `mixed`, `static` return types, `match`, the
//!     nullsafe operator, named arguments, constructor promotion,
//!     attributes, `throw` as an expression, `$object::class`, `catch`
//!     without a variable
//!   - 8.1: enums, readonly properties, `never`, intersection types,
//!     first-class callables, `new` in parameter defaults, `0o` octal
//!     literals, `final` class constants
//!   - 8.2: readonly classes, DNF types, standalone `null`/`false`/`true`
//!     and `true`, constants in traits
//!   - 8.3: typed class constants, dynamic class constant fetch
//!     (`Foo::{$name}`), readonly anonymous classes
//!   - 8.4: property hooks, asymmetric visibility, `new Foo()->m()`
//!     without parentheses
//!   - 8.5: the pipe operator `|>`
//!
//!   A type declaration reports only its newest feature, once.
//! - [`Deprecation`] (`PhpDeprecation`): uses of class-likes, functions,
//!   constants, methods, properties and enum cases marked `@deprecated`
//!   or `#[\Deprecated]` (also `JetBrains\PhpStorm\Deprecated`), struck
//!   through. The uses are the semantic tokens' (the same lookups as
//!   highlighting): every name but the declaration itself.
//!
//! Neither runs on `.phpstorm.meta.php` files. The feature versions follow
//! the PHP manual's migration guides; the ids follow PhpStorm's naming.

use std::collections::HashSet;

use ide_core::Severity;
use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    AnonymousClass, AssignmentOperator, AttributeList, BinaryOperator, Call, Class, ClassLikeConstant,
    ClassLikeConstantSelector, Enum, Expression, ExpressionStatement, ForeachKeyValueTarget, ForeachValueTarget,
    FunctionLikeParameter, FunctionLikeReturnTypeHint, Hint, HookedProperty, Literal, Modifier, NamedArgument,
    PartialApplication, PartialArgument, PlainProperty, Trait, TryCatchClause, VariadicArrayElement,
};
use mago_syntax::walker::Walker;

use super::{Inspection, InspectionContext, Problems};
use crate::engine::is_meta_path;
use crate::semantic::{TokenType, modifier};
use crate::stubs::PhpVersion;

/// `PhpLanguageLevel`.
pub struct LanguageLevel;

/// `PhpDeprecation`.
pub struct Deprecation;

impl Inspection for LanguageLevel {
    fn id(&self) -> &'static str {
        "PhpLanguageLevel"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        if is_meta_path(cx.path) {
            return;
        }
        let level = cx.engine.language_level();
        for found in features(cx.parsed.program()) {
            if found.since > level {
                out.report(
                    found.start,
                    found.end,
                    format!(
                        "{} {} only available since PHP {} (the project's language level is PHP {level})",
                        found.feature.name,
                        if found.feature.plural { "are" } else { "is" },
                        found.since
                    ),
                );
            }
        }
    }
}

impl Inspection for Deprecation {
    fn id(&self) -> &'static str {
        "PhpDeprecation"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        if is_meta_path(cx.path) {
            return;
        }
        let tokens = cx.engine.semantic_spans(cx.parsed, cx.names(), cx.summary());
        let text = cx.text();
        for (start, (end, ty, modifiers)) in tokens {
            if modifiers & modifier::DEPRECATED == 0 || modifiers & modifier::DECLARATION != 0 {
                continue;
            }
            if cx.is_cancelled() {
                return;
            }
            let what = match ty {
                TokenType::Class => "Class",
                TokenType::Interface => "Interface",
                TokenType::Enum => "Enum",
                TokenType::Function => "Function",
                TokenType::Method => "Method",
                TokenType::Property => "Property",
                TokenType::EnumMember => "Enum case",
                TokenType::Variable if modifiers & modifier::CONSTANT == modifier::CONSTANT => "Constant",
                TokenType::Parameter | TokenType::Variable => continue,
            };
            let name = text.get(start as usize..end as usize).unwrap_or_default();
            // A qualified name (`use App\Old;`) is named by its last part.
            let name = name.rsplit('\\').next().unwrap_or(name);
            out.report(start, end, format!("{what} '{name}' is deprecated")).deprecated();
        }
    }
}

/// A language feature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Feature {
    pub(crate) name: &'static str,
    pub(crate) plural: bool,
}

const fn are(name: &'static str) -> Feature {
    Feature { name, plural: true }
}

const fn is(name: &'static str) -> Feature {
    Feature { name, plural: false }
}

const fn v(major: u8, minor: u8) -> PhpVersion {
    PhpVersion::new(major, minor)
}

/// A use of a feature, over bytes `start..end`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Found {
    pub(crate) feature: Feature,
    pub(crate) since: PhpVersion,
    pub(crate) start: u32,
    pub(crate) end: u32,
}

/// Every versioned feature the program uses, in source order.
pub(crate) fn features(program: &mago_syntax::cst::Program<'_>) -> Vec<Found> {
    let mut scan = Scan::default();
    FeatureWalker.walk_program(program, &mut scan);
    let mut found = scan.found;
    found.sort_by_key(|f| (f.start, f.end));
    found.dedup_by_key(|f| (f.start, f.end, f.feature.name));
    found
}

/// Where a type declaration is.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HintAt {
    Parameter,
    Return,
    Property,
    Constant,
}

#[derive(Default)]
struct Scan {
    found: Vec<Found>,
    /// Starts of `throw` expressions that are statements.
    throw_statements: HashSet<u32>,
    /// Nesting of traits around the walk.
    traits: u32,
}

impl Scan {
    fn add(&mut self, since: PhpVersion, feature: Feature, span: Span) {
        self.found.push(Found { feature, since, start: span.start.offset, end: span.end.offset });
    }

    /// A type declaration: its newest feature (`base` is the declaration's
    /// own, typed properties or constants, return types), once.
    fn hint(&mut self, hint: &Hint<'_>, at: HintAt, base: Option<(PhpVersion, Feature)>) {
        let mut newest = base.map(|(since, feature)| (since, feature, hint.span()));
        let mut consider = |since: PhpVersion, feature: Feature, span: Span| {
            if newest.is_none_or(|(old, _, _)| since > old) {
                newest = Some((since, feature, span));
            }
        };
        hint_features(hint, at, true, &mut consider);
        if let Some((since, feature, span)) = newest {
            self.add(since, feature, span);
        }
    }

    fn modifiers<'m>(&mut self, modifiers: impl IntoIterator<Item = &'m Modifier<'m>>, readonly: Option<(u8, u8)>) {
        for modifier in modifiers {
            match modifier {
                Modifier::PublicSet(_) | Modifier::ProtectedSet(_) | Modifier::PrivateSet(_) => {
                    self.add(v(8, 4), is("Asymmetric visibility"), modifier.span())
                }
                Modifier::Readonly(keyword) => {
                    if let Some((major, minor)) = readonly {
                        let feature = match (major, minor) {
                            (8, 1) => are("Readonly properties"),
                            (8, 2) => are("Readonly classes"),
                            _ => are("Readonly anonymous classes"),
                        };
                        self.add(v(major, minor), feature, keyword.span);
                    }
                }
                _ => {}
            }
        }
    }

    fn expression(&mut self, expr: &Expression<'_>) {
        match expr {
            Expression::Match(node) => self.add(v(8, 0), is("Match expression"), node.r#match.span),
            Expression::Throw(node) => {
                if !self.throw_statements.contains(&node.throw.span.start.offset) {
                    self.add(v(8, 0), is("Throw expression"), node.throw.span);
                }
            }
            Expression::ArrowFunction(node) => self.add(v(7, 4), are("Arrow functions"), node.r#fn.span),
            Expression::Binary(node) => match node.operator {
                BinaryOperator::NullCoalesce(span) => self.add(v(7, 0), is("Null coalescing operator"), span),
                BinaryOperator::Spaceship(span) => self.add(v(7, 0), is("Spaceship operator"), span),
                _ => {}
            },
            Expression::Assignment(node) => {
                if let AssignmentOperator::Coalesce(span) = node.operator {
                    self.add(v(7, 4), is("Null coalescing assignment operator"), span);
                }
                if let Expression::Array(array) = node.lhs {
                    self.add(v(7, 1), is("Short list syntax"), array.span());
                }
            }
            Expression::Pipe(node) => self.add(v(8, 5), is("Pipe operator"), node.operator),
            Expression::Literal(Literal::Integer(literal)) => {
                if literal.raw.contains(&b'_') {
                    self.add(v(7, 4), are("Numeric literal separators"), literal.span);
                }
                if literal.raw.len() > 1 && literal.raw[0] == b'0' && matches!(literal.raw[1], b'o' | b'O') {
                    self.add(v(8, 1), is("Explicit octal notation"), literal.span);
                }
            }
            Expression::Literal(Literal::Float(literal)) => {
                if literal.raw.contains(&b'_') {
                    self.add(v(7, 4), are("Numeric literal separators"), literal.span);
                }
            }
            Expression::Call(Call::NullSafeMethod(node)) => {
                self.add(v(8, 0), is("Nullsafe operator"), node.question_mark_arrow);
                self.new_without_parentheses(node.object);
            }
            Expression::Access(mago_syntax::cst::Access::NullSafeProperty(node)) => {
                self.add(v(8, 0), is("Nullsafe operator"), node.question_mark_arrow);
                self.new_without_parentheses(node.object);
            }
            Expression::Call(Call::Method(node)) => self.new_without_parentheses(node.object),
            Expression::Access(mago_syntax::cst::Access::Property(node)) => self.new_without_parentheses(node.object),
            Expression::Access(mago_syntax::cst::Access::ClassConstant(node)) => match &node.constant {
                ClassLikeConstantSelector::Expression(selector) => {
                    self.add(v(8, 3), is("Dynamic class constant fetch"), selector.span())
                }
                ClassLikeConstantSelector::Identifier(name) => {
                    let named = matches!(
                        node.class,
                        Expression::Identifier(_)
                            | Expression::Self_(_)
                            | Expression::Static(_)
                            | Expression::Parent(_)
                    );
                    if !named && name.value.eq_ignore_ascii_case(b"class") {
                        self.add(v(8, 0), is("'::class' on objects"), node.span());
                    }
                }
                ClassLikeConstantSelector::Missing(_) => {}
            },
            Expression::ArrayAccess(node) => self.new_without_parentheses(node.array),
            Expression::PartialApplication(partial) => {
                let arguments = match partial {
                    PartialApplication::Function(node) => &node.argument_list,
                    PartialApplication::Method(node) => &node.argument_list,
                    PartialApplication::StaticMethod(node) => &node.argument_list,
                };
                let mut all = arguments.arguments.iter();
                if let (Some(PartialArgument::VariadicPlaceholder(_)), None) = (all.next(), all.next()) {
                    self.add(v(8, 1), is("First-class callable syntax"), arguments.span());
                }
            }
            _ => {}
        }
    }

    /// `new Foo()->m()`: member access on `new` with arguments and without
    /// parentheses.
    fn new_without_parentheses(&mut self, object: &Expression<'_>) {
        if let Expression::Instantiation(node) = object
            && node.argument_list.is_some()
        {
            self.add(v(8, 4), is("Member access on 'new' without parentheses"), node.span());
        }
    }

    fn parameter(&mut self, node: &FunctionLikeParameter<'_>) {
        if let Some(hint) = &node.hint {
            self.hint(hint, HintAt::Parameter, None);
        }
        if let (Some(first), Some(last)) = (node.modifiers.first(), node.modifiers.last()) {
            self.add(v(8, 0), is("Constructor property promotion"), first.span().join(last.span()));
        }
        self.modifiers(node.modifiers.iter(), Some((8, 1)));
        if let Some(hooks) = &node.hooks {
            self.add(v(8, 4), are("Property hooks"), hooks.span());
        }
        if let Some(default) = &node.default_value
            && let Expression::Instantiation(new) = default.value
        {
            self.add(v(8, 1), is("'new' in initializers"), new.new.span);
        }
    }

    fn property<'m>(&mut self, modifiers: impl IntoIterator<Item = &'m Modifier<'m>>, hint: Option<&Hint<'_>>) {
        if let Some(hint) = hint {
            self.hint(hint, HintAt::Property, Some((v(7, 4), are("Typed properties"))));
        }
        self.modifiers(modifiers, Some((8, 1)));
    }

    fn class_constant(&mut self, node: &ClassLikeConstant<'_>) {
        if let Some(hint) = &node.hint {
            self.hint(hint, HintAt::Constant, Some((v(8, 3), are("Typed class constants"))));
        }
        for modifier in node.modifiers.iter() {
            match modifier {
                Modifier::Final(keyword) => self.add(v(8, 1), are("Final class constants"), keyword.span),
                Modifier::Public(keyword) | Modifier::Protected(keyword) | Modifier::Private(keyword) => {
                    self.add(v(7, 1), is("Class constant visibility"), keyword.span)
                }
                _ => {}
            }
        }
        if self.traits > 0 {
            self.add(v(8, 2), are("Constants in traits"), node.r#const.span);
        }
    }

    fn catch(&mut self, node: &TryCatchClause<'_>) {
        if let Hint::Union(_) = &node.hint {
            self.add(v(7, 1), is("Catching multiple exception types"), node.hint.span());
        }
        if node.variable.is_none() {
            self.add(v(8, 0), is("Catch without a variable"), node.hint.span());
        }
    }
}

/// Every versioned feature of a type declaration (`top`: the whole of it).
fn hint_features(hint: &Hint<'_>, at: HintAt, top: bool, out: &mut impl FnMut(PhpVersion, Feature, Span)) {
    let span = hint.span();
    let scalar = matches!(at, HintAt::Parameter | HintAt::Return);
    match hint {
        Hint::Union(union) => {
            let dnf = [union.left, union.right]
                .iter()
                .any(|side| matches!(side, Hint::Parenthesized(inner) if matches!(inner.hint, Hint::Intersection(_))));
            if dnf {
                out(v(8, 2), are("Disjunctive normal form types"), span);
            } else {
                out(v(8, 0), are("Union types"), span);
            }
            hint_features(union.left, at, false, out);
            hint_features(union.right, at, false, out);
        }
        Hint::Intersection(intersection) => {
            out(v(8, 1), are("Intersection types"), span);
            hint_features(intersection.left, at, false, out);
            hint_features(intersection.right, at, false, out);
        }
        Hint::Parenthesized(inner) => hint_features(inner.hint, at, false, out),
        Hint::Nullable(nullable) => {
            out(v(7, 1), are("Nullable types"), span);
            hint_features(nullable.hint, at, false, out);
        }
        Hint::Null(_) | Hint::False(_) if top => out(v(8, 2), is("'null' and 'false' as standalone types"), span),
        Hint::True(_) => out(v(8, 2), is("The 'true' type"), span),
        Hint::Void(_) => out(v(7, 1), is("The 'void' type"), span),
        Hint::Never(_) => out(v(8, 1), is("The 'never' type"), span),
        Hint::Mixed(_) => out(v(8, 0), is("The 'mixed' type"), span),
        Hint::Object(_) => out(v(7, 2), is("The 'object' type"), span),
        Hint::Iterable(_) => out(v(7, 1), is("The 'iterable' type"), span),
        Hint::Static(_) if at == HintAt::Return => out(v(8, 0), is("The 'static' return type"), span),
        Hint::Integer(_) | Hint::Float(_) | Hint::Bool(_) | Hint::String(_) if scalar => {
            out(v(7, 0), are("Scalar type declarations"), span)
        }
        _ => {}
    }
}

struct FeatureWalker;

impl<'a> Walker<'a, 'a, Scan> for FeatureWalker {
    fn walk_in_statement_expression(&self, node: &'a ExpressionStatement<'a>, cx: &mut Scan) {
        if let Expression::Throw(throw) = node.expression {
            cx.throw_statements.insert(throw.throw.span.start.offset);
        }
    }

    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Scan) {
        cx.expression(expr);
    }

    fn walk_in_function_like_return_type_hint(&self, node: &'a FunctionLikeReturnTypeHint<'a>, cx: &mut Scan) {
        cx.hint(&node.hint, HintAt::Return, Some((v(7, 0), are("Return type declarations"))));
    }

    fn walk_in_function_like_parameter(&self, node: &'a FunctionLikeParameter<'a>, cx: &mut Scan) {
        cx.parameter(node);
    }

    fn walk_in_plain_property(&self, node: &'a PlainProperty<'a>, cx: &mut Scan) {
        cx.property(node.modifiers.iter(), node.hint.as_ref());
    }

    fn walk_in_hooked_property(&self, node: &'a HookedProperty<'a>, cx: &mut Scan) {
        cx.property(node.modifiers.iter(), node.hint.as_ref());
        cx.add(v(8, 4), are("Property hooks"), node.hook_list.span());
    }

    fn walk_in_class_like_constant(&self, node: &'a ClassLikeConstant<'a>, cx: &mut Scan) {
        cx.class_constant(node);
    }

    fn walk_in_class(&self, node: &'a Class<'a>, cx: &mut Scan) {
        cx.modifiers(node.modifiers.iter(), Some((8, 2)));
    }

    fn walk_in_anonymous_class(&self, node: &'a AnonymousClass<'a>, cx: &mut Scan) {
        cx.add(v(7, 0), are("Anonymous classes"), node.new.span.join(node.class.span));
        cx.modifiers(node.modifiers.iter(), Some((8, 3)));
    }

    fn walk_in_enum(&self, node: &'a Enum<'a>, cx: &mut Scan) {
        cx.add(v(8, 1), are("Enums"), node.r#enum.span);
    }

    fn walk_in_trait(&self, _: &'a Trait<'a>, cx: &mut Scan) {
        cx.traits += 1;
    }

    fn walk_out_trait(&self, _: &'a Trait<'a>, cx: &mut Scan) {
        cx.traits -= 1;
    }

    fn walk_in_try_catch_clause(&self, node: &'a TryCatchClause<'a>, cx: &mut Scan) {
        cx.catch(node);
    }

    fn walk_in_named_argument(&self, node: &'a NamedArgument<'a>, cx: &mut Scan) {
        cx.add(v(8, 0), are("Named arguments"), node.name.span.join(node.colon));
    }

    fn walk_in_attribute_list(&self, node: &'a AttributeList<'a>, cx: &mut Scan) {
        cx.add(v(8, 0), are("Attributes"), node.span());
    }

    fn walk_in_variadic_array_element(&self, node: &'a VariadicArrayElement<'a>, cx: &mut Scan) {
        cx.add(v(7, 4), is("Unpacking inside arrays"), node.span());
    }

    fn walk_in_foreach_value_target(&self, node: &'a ForeachValueTarget<'a>, cx: &mut Scan) {
        if let Expression::Array(array) = node.value {
            cx.add(v(7, 1), is("Short list syntax"), array.span());
        }
    }

    fn walk_in_foreach_key_value_target(&self, node: &'a ForeachKeyValueTarget<'a>, cx: &mut Scan) {
        if let Expression::Array(array) = node.value {
            cx.add(v(7, 1), is("Short list syntax"), array.span());
        }
    }
}
