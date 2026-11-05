//! The version rules of one stub file, collected from the AST: the
//! `#[PhpStormStubsElementAvailable]` and `#[LanguageLevelTypeAware]`
//! attributes and, where they name PHP versions, the `@since` and `@removed`
//! docblock tags. Each rule is keyed by the start of the declaration's name,
//! which is the [`Loc::start`](crate::summary::Loc) of its `name_loc` in the
//! [`FileSummary`](crate::summary::FileSummary).
//!
//! The attribute semantics follow the phpstorm-stubs README and its
//! `JetBrains\PhpStorm\Internal` attribute classes (Apache-2.0): `from` and
//! `to` are inclusive, the first positional argument is `from`, and a
//! `LanguageLevelTypeAware` map entry applies from its version on.

use std::collections::HashMap;

use mago_span::{HasSpan, Span};
use mago_syntax::comments::docblock::get_docblock_before_position;
use mago_syntax::cst::{
    Argument, ArrayElement, AttributeList, Class, ClassLikeMember, Constant, Enum, EnumCaseItem, Expression, Function,
    FunctionCall, FunctionLikeParameterList, Interface, Literal, Namespace, NamespaceBody, PartialArgument, Property,
    PropertyItem, Sequence, Trait, Use,
};
use mago_syntax::walker::Walker;

use super::PhpVersion;
use crate::names::{NameKind, NameScope, Resolution};
use crate::summary::{FileSummary, TypeHint};
use crate::syntax::ParsedFile;

pub(super) type Rules = HashMap<u32, Rule>;

/// When a declaration exists and which type it has, by PHP version.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Rule {
    /// The first version that has it.
    pub from: Option<PhpVersion>,
    /// The last version that has it.
    pub to: Option<PhpVersion>,
    /// The first version that no longer has it (`@removed`).
    pub removed: Option<PhpVersion>,
    pub ty: Option<TypeAware>,
}

impl Rule {
    pub fn available(&self, version: PhpVersion) -> bool {
        self.from.is_none_or(|from| version >= from)
            && self.to.is_none_or(|to| version <= to)
            && self.removed.is_none_or(|removed| version < removed)
    }

    fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// `#[LanguageLevelTypeAware(['8.0' => 'T', …], default: 'D')]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TypeAware {
    /// Ascending by version.
    pub by_version: Vec<(PhpVersion, Option<TypeHint>)>,
    pub default: Option<TypeHint>,
}

impl TypeAware {
    /// The type at `version`: the entry with the highest version not above
    /// it, else the default. `None` means no type.
    pub fn at(&self, version: PhpVersion) -> Option<TypeHint> {
        self.by_version.iter().rev().find(|(since, _)| *since <= version).map_or(&self.default, |(_, ty)| ty).clone()
    }
}

/// The rules of a parsed stub file. `doc_versions` turns on `@since` and
/// `@removed`, for stub sets whose docblocks give PHP versions.
pub(super) fn collect(file: &ParsedFile, doc_versions: bool) -> Rules {
    let mut cx =
        Collector { file, doc_versions, scope: NameScope::global(), types: HashMap::new(), rules: Rules::new() };
    RuleWalker.walk_program(file.program(), &mut cx);
    cx.rules
}

struct Collector<'f> {
    file: &'f ParsedFile,
    doc_versions: bool,
    /// For attribute names (`use … as Available`) and type strings.
    scope: NameScope,
    /// Parsed type strings, by namespace and text.
    types: HashMap<(String, String), Option<TypeHint>>,
    rules: Rules,
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A PHP version named in a docblock: `5.3`, `8.1.0`. Extension versions
/// (`PECL zip >= 1.0`, `0.1`) are not PHP versions and give `None`.
fn doc_version(text: &str) -> Option<PhpVersion> {
    let token = text.split_whitespace().next()?;
    if !token.contains('.') || !token.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    PhpVersion::parse(token).filter(|version| (4..=9).contains(&version.major))
}

impl Collector<'_> {
    /// The text of a string literal, or the source of another expression.
    fn text(&self, expression: &Expression<'_>) -> String {
        match expression {
            Expression::Literal(Literal::String(string)) => string.value.map(lossy).unwrap_or_default(),
            other => {
                let span = other.span();
                self.file
                    .text()
                    .get(span.start.offset as usize..span.end.offset as usize)
                    .unwrap_or_default()
                    .to_owned()
            }
        }
    }

    /// A type written as a string (`'string|false'`, `'?\CurlHandle'`), as
    /// a native hint in the current namespace. `''` is no type.
    fn hint(&mut self, text: &str) -> Option<TypeHint> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        let key = (self.scope.namespace().to_owned(), text.to_owned());
        if let Some(hint) = self.types.get(&key) {
            return hint.clone();
        }
        // The stubs only import their attribute classes, so the namespace is
        // all the context a type string needs.
        let namespace = match self.scope.namespace() {
            "" => String::new(),
            namespace => format!("namespace {namespace};\n"),
        };
        let snippet = ParsedFile::parse("type.php", format!("<?php\n{namespace}function f(): {text} {{}}\n"));
        let hint = FileSummary::extract(&snippet).functions.into_iter().next().and_then(|f| f.return_type).map(builtin);
        self.types.insert(key, hint.clone());
        hint
    }

    /// Records the rule of the declaration whose name starts at `name`.
    /// `decl` is where the declaration (with its attributes) starts, for the
    /// docblock; `None` for parameters, which have none.
    fn record<'n, 'a: 'n>(
        &mut self,
        name: Span,
        lists: impl IntoIterator<Item = &'n AttributeList<'a>>,
        decl: Option<u32>,
    ) {
        let mut rule = Rule::default();
        for attribute in lists.into_iter().flat_map(|list| list.attributes.iter()) {
            // The last segment of the resolved name, lower case.
            let kind = match self.scope.resolve(NameKind::ClassLike, &lossy(attribute.name.value())).resolution {
                Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => fqn,
                Resolution::Relative(_) => continue,
            };
            let kind = kind.rsplit('\\').next().unwrap_or_default().to_ascii_lowercase();
            let Some(arguments) = &attribute.argument_list else { continue };
            // (name, value) with positional arguments named by position.
            let arguments: Vec<(Option<String>, &Expression<'_>)> = arguments
                .arguments
                .iter()
                .filter_map(|argument| match argument {
                    PartialArgument::Positional(argument) => Some((None, argument.value)),
                    PartialArgument::Named(argument) => Some((Some(lossy(argument.name.value)), argument.value)),
                    _ => None,
                })
                .collect();
            let argument = |name: &str, position: usize| {
                arguments
                    .iter()
                    .find(|(named, _)| named.as_deref() == Some(name))
                    .or_else(|| arguments.get(position).filter(|(named, _)| named.is_none()))
                    .map(|(_, value)| *value)
            };
            match kind.as_str() {
                "phpstormstubselementavailable" => {
                    let version = |expression: Option<&Expression<'_>>| {
                        expression.and_then(|expression| PhpVersion::parse(&self.text(expression)))
                    };
                    rule.from = version(argument("from", 0)).or(rule.from);
                    rule.to = version(argument("to", 1)).or(rule.to);
                }
                "languageleveltypeaware" => {
                    let map = argument("languageLevelTypeMap", 0);
                    let default = argument("default", 1).map(|expression| self.text(expression)).unwrap_or_default();
                    let entries: Vec<(String, String)> = match map {
                        Some(Expression::Array(array)) => self.entries(array.elements.iter()),
                        Some(Expression::LegacyArray(array)) => self.entries(array.elements.iter()),
                        _ => Vec::new(),
                    };
                    let mut by_version: Vec<(PhpVersion, Option<TypeHint>)> = entries
                        .iter()
                        .filter_map(|(version, ty)| Some((PhpVersion::parse(version)?, self.hint(ty))))
                        .collect();
                    by_version.sort_by_key(|(version, _)| *version);
                    rule.ty = Some(TypeAware { by_version, default: self.hint(&default) });
                }
                _ => {}
            }
        }
        if self.doc_versions
            && let Some(start) = decl
            && let Some(doc) = get_docblock_before_position(self.file.program().trivia.as_slice(), start)
        {
            for line in String::from_utf8_lossy(doc.value).lines() {
                let line = line.trim_start_matches(|c: char| c.is_whitespace() || c == '*' || c == '/');
                if let Some(rest) = line.strip_prefix("@since") {
                    rule.from = doc_version(rest).max(rule.from);
                } else if let Some(rest) = line.strip_prefix("@removed") {
                    rule.removed = doc_version(rest).or(rule.removed);
                }
            }
        }
        if !rule.is_empty() {
            self.rules.insert(name.start.offset, rule);
        }
    }

    /// The `'version' => 'type'` pairs of an array literal.
    fn entries<'e, 'a: 'e>(&self, elements: impl Iterator<Item = &'e ArrayElement<'a>>) -> Vec<(String, String)> {
        elements
            .filter_map(|element| match element {
                ArrayElement::KeyValue(pair) => Some((self.text(pair.key), self.text(pair.value))),
                _ => None,
            })
            .collect()
    }

    fn params(&mut self, list: &FunctionLikeParameterList<'_>) {
        for parameter in list.parameters.iter() {
            self.record(parameter.variable.span, &parameter.attribute_lists, None);
        }
    }

    fn members(&mut self, members: &Sequence<'_, ClassLikeMember<'_>>) {
        for member in members.iter() {
            match member {
                ClassLikeMember::Method(method) => {
                    self.record(method.name.span, &method.attribute_lists, Some(method.span().start.offset));
                    self.params(&method.parameter_list);
                }
                ClassLikeMember::Property(property) => {
                    let start = Some(property.span().start.offset);
                    match property {
                        Property::Plain(plain) => {
                            for item in plain.items.iter() {
                                self.record(item_variable(item), &plain.attribute_lists, start);
                            }
                        }
                        Property::Hooked(hooked) => {
                            self.record(item_variable(&hooked.item), &hooked.attribute_lists, start)
                        }
                    }
                }
                ClassLikeMember::Constant(constant) => {
                    for item in constant.items.iter() {
                        self.record(item.name.span, &constant.attribute_lists, Some(constant.span().start.offset));
                    }
                }
                ClassLikeMember::EnumCase(case) => {
                    let name = match &case.item {
                        EnumCaseItem::Unit(item) => item.name.span,
                        EnumCaseItem::Backed(item) => item.name.span,
                    };
                    self.record(name, &case.attribute_lists, Some(case.span().start.offset));
                }
                ClassLikeMember::TraitUse(_) => {}
            }
        }
    }
}

fn item_variable(item: &PropertyItem<'_>) -> Span {
    match item {
        PropertyItem::Abstract(item) => item.variable.span,
        PropertyItem::Concrete(item) => item.variable.span,
    }
}

/// `resource` is not a native type keyword, so the parser reads it as a
/// class name; the stubs mean the built-in type.
fn builtin(hint: TypeHint) -> TypeHint {
    match hint {
        TypeHint::Named(name) if name.rsplit('\\').next().is_some_and(|n| n.eq_ignore_ascii_case("resource")) => {
            TypeHint::Builtin("resource".to_owned())
        }
        TypeHint::Nullable(inner) => TypeHint::Nullable(Box::new(builtin(*inner))),
        TypeHint::Union(members) => TypeHint::Union(members.into_iter().map(builtin).collect()),
        TypeHint::Intersection(members) => TypeHint::Intersection(members.into_iter().map(builtin).collect()),
        other => other,
    }
}

struct RuleWalker;

impl<'ast, 'arena, 'f> Walker<'ast, 'arena, Collector<'f>> for RuleWalker {
    fn walk_in_namespace(&self, node: &'ast Namespace<'arena>, cx: &mut Collector<'f>) {
        let name = node.name.as_ref().map(|name| lossy(name.value())).unwrap_or_default();
        cx.scope = NameScope::for_namespace(&name);
    }

    fn walk_out_namespace(&self, node: &'ast Namespace<'arena>, cx: &mut Collector<'f>) {
        if let NamespaceBody::BraceDelimited(_) = node.body {
            cx.scope = NameScope::global();
        }
    }

    fn walk_in_use(&self, node: &'ast Use<'arena>, cx: &mut Collector<'f>) {
        cx.scope.add_use(node);
    }

    fn walk_in_function(&self, node: &'ast Function<'arena>, cx: &mut Collector<'f>) {
        cx.record(node.name.span, &node.attribute_lists, Some(node.span().start.offset));
        cx.params(&node.parameter_list);
    }

    fn walk_in_class(&self, node: &'ast Class<'arena>, cx: &mut Collector<'f>) {
        cx.record(node.name.span, &node.attribute_lists, Some(node.span().start.offset));
        cx.members(&node.members);
    }

    fn walk_in_interface(&self, node: &'ast Interface<'arena>, cx: &mut Collector<'f>) {
        cx.record(node.name.span, &node.attribute_lists, Some(node.span().start.offset));
        cx.members(&node.members);
    }

    fn walk_in_trait(&self, node: &'ast Trait<'arena>, cx: &mut Collector<'f>) {
        cx.record(node.name.span, &node.attribute_lists, Some(node.span().start.offset));
        cx.members(&node.members);
    }

    fn walk_in_enum(&self, node: &'ast Enum<'arena>, cx: &mut Collector<'f>) {
        cx.record(node.name.span, &node.attribute_lists, Some(node.span().start.offset));
        cx.members(&node.members);
    }

    fn walk_in_constant(&self, node: &'ast Constant<'arena>, cx: &mut Collector<'f>) {
        for item in node.items.iter() {
            cx.record(item.name.span, &node.attribute_lists, Some(node.span().start.offset));
        }
    }

    fn walk_in_function_call(&self, node: &'ast FunctionCall<'arena>, cx: &mut Collector<'f>) {
        // `define('NAME', …)`: the summary's name location is inside the quotes.
        let Expression::Identifier(callee) = node.function else { return };
        let callee = callee.value();
        if !callee.strip_prefix(b"\\").unwrap_or(callee).eq_ignore_ascii_case(b"define") {
            return;
        }
        let Some(Argument::Positional(first)) = node.argument_list.arguments.iter().next() else { return };
        let Expression::Literal(Literal::String(name)) = first.value else { return };
        let mut span = name.span;
        if name.raw.len() >= 2 {
            span.start.offset += 1;
        }
        cx.record(span, std::iter::empty::<&AttributeList<'_>>(), Some(node.span().start.offset));
    }
}
