//! The AST walk that builds a [`FileSummary`].
//!
//! Declarations are collected wherever they appear, not only at the top
//! level: PHP declares a function or class nested in an `if` (the
//! `if (!function_exists('x'))` guard of helper files) when that code runs,
//! and `define()` is usually called inside such blocks too. Anonymous classes
//! and closures are not visible by name, so they are left out.

use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Argument, AttributeList, Class, ClassLikeConstant, ClassLikeMember, Constant, Enum, EnumCase as AstEnumCase,
    EnumCaseItem, Expression, Function, FunctionCall, FunctionLikeParameter, FunctionLikeParameterList,
    FunctionLikeReturnTypeHint, Hint, Identifier, Interface, Literal, LocalIdentifier, Method as AstMethod, MethodBody,
    Modifier, Namespace, NamespaceBody, Property as AstProperty, PropertyItem, Sequence, Trait,
    TraitUse as AstTraitUse, TraitUseAdaptation, TraitUseMethodReference, TraitUseSpecification, Use,
};
use mago_syntax::walker::Walker;

use super::{
    ClassConstant, ClassKind, ClassLike, ClassModifiers, ConstantDecl, ConstantKind, DocBlock, DocVar, EnumCase,
    FileSummary, FunctionDecl, Loc, Method, Param, Promotion, Property, SCHEMA_VERSION, TraitRule, TraitUse, TypeHint,
    Visibility,
};
use crate::names::{NameKind, NameScope, Resolution};
use crate::syntax::ParsedFile;
use crate::types::provider::{Assigned, PropertySite};
use crate::types::{LazyType, Type, TypeProviders};
use infer::{Infer, body_return, this_assignments};

mod infer;
mod phpdoc;

pub(super) fn extract(file: &ParsedFile) -> FileSummary {
    let mut cx = Extractor {
        file,
        scope: NameScope::global(),
        summary: FileSummary { schema: SCHEMA_VERSION, has_errors: file.has_errors(), ..FileSummary::default() },
    };
    SummaryWalker.walk_program(file.program(), &mut cx);
    cx.summary
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A variable name without its `$`.
fn variable_name(name: &[u8]) -> String {
    lossy(name.strip_prefix(b"$").unwrap_or(name))
}

/// A native type hint, its class names resolved in `scope`.
pub(crate) fn type_hint(scope: &NameScope, hint: &Hint<'_>) -> TypeHint {
    let builtin = |name: &str| TypeHint::Builtin(name.to_owned());
    match hint {
        Hint::Identifier(identifier) => {
            match scope.resolve(NameKind::ClassLike, &lossy(identifier.value())).resolution {
                Resolution::Relative(relative) => TypeHint::Relative(relative),
                Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => TypeHint::Named(fqn),
            }
        }
        Hint::Parenthesized(inner) => type_hint(scope, inner.hint),
        Hint::Nullable(inner) => TypeHint::Nullable(Box::new(type_hint(scope, inner.hint))),
        Hint::Union(union) => {
            let mut members = Vec::new();
            for side in [union.left, union.right] {
                match type_hint(scope, side) {
                    TypeHint::Union(inner) => members.extend(inner),
                    other => members.push(other),
                }
            }
            TypeHint::Union(members)
        }
        Hint::Intersection(intersection) => {
            let mut members = Vec::new();
            for side in [intersection.left, intersection.right] {
                match type_hint(scope, side) {
                    TypeHint::Intersection(inner) => members.extend(inner),
                    other => members.push(other),
                }
            }
            TypeHint::Intersection(members)
        }
        Hint::Null(_) => builtin("null"),
        Hint::True(_) => builtin("true"),
        Hint::False(_) => builtin("false"),
        Hint::Array(_) => builtin("array"),
        Hint::Callable(_) => builtin("callable"),
        Hint::Static(_) => TypeHint::Relative(crate::names::RelativeClass::Static),
        Hint::Self_(_) => TypeHint::Relative(crate::names::RelativeClass::Self_),
        Hint::Parent(_) => TypeHint::Relative(crate::names::RelativeClass::Parent),
        Hint::Void(_) => builtin("void"),
        Hint::Never(_) => builtin("never"),
        Hint::Float(_) => builtin("float"),
        Hint::Bool(_) => builtin("bool"),
        Hint::Integer(_) => builtin("int"),
        Hint::String(_) => builtin("string"),
        Hint::Object(_) => builtin("object"),
        Hint::Mixed(_) => builtin("mixed"),
        Hint::Iterable(_) => builtin("iterable"),
    }
}

/// The visibility a modifier sets, if any: (read visibility, write visibility).
fn visibility_of(modifier: &Modifier<'_>) -> (Option<Visibility>, Option<Visibility>) {
    match modifier {
        Modifier::Public(_) => (Some(Visibility::Public), None),
        Modifier::Protected(_) => (Some(Visibility::Protected), None),
        Modifier::Private(_) => (Some(Visibility::Private), None),
        Modifier::PublicSet(_) => (None, Some(Visibility::Public)),
        Modifier::ProtectedSet(_) => (None, Some(Visibility::Protected)),
        Modifier::PrivateSet(_) => (None, Some(Visibility::Private)),
        _ => (None, None),
    }
}

/// The modifiers of a member, folded.
#[derive(Default)]
struct Mods {
    visibility: Option<Visibility>,
    set_visibility: Option<Visibility>,
    is_static: bool,
    is_abstract: bool,
    is_final: bool,
    is_readonly: bool,
}

impl Mods {
    fn of(modifiers: &Sequence<'_, Modifier<'_>>) -> Self {
        let mut mods = Self::default();
        for modifier in modifiers {
            let (read, write) = visibility_of(modifier);
            mods.visibility = read.or(mods.visibility);
            mods.set_visibility = write.or(mods.set_visibility);
            mods.is_static |= modifier.is_static();
            mods.is_abstract |= modifier.is_abstract();
            mods.is_final |= modifier.is_final();
            mods.is_readonly |= modifier.is_readonly();
        }
        mods
    }

    fn any(&self) -> bool {
        self.visibility.is_some() || self.set_visibility.is_some() || self.is_readonly
    }
}

struct Extractor<'f> {
    file: &'f ParsedFile,
    scope: NameScope,
    summary: FileSummary,
}

impl Extractor<'_> {
    fn loc(&self, span: Span) -> Loc {
        let len = self.file.line_index().len();
        let end = span.end.offset.min(len);
        let start = span.start.offset.min(end);
        Loc { start, end, range: self.file.line_index().range(start, end) }
    }

    /// The source text of a node, as written.
    fn source(&self, span: Span) -> String {
        let loc = self.loc(span);
        self.file.text().get(loc.start as usize..loc.end as usize).unwrap_or_default().to_owned()
    }

    fn class_name(&self, identifier: &Identifier<'_>) -> String {
        match self.scope.resolve(NameKind::ClassLike, &lossy(identifier.value())).resolution {
            Resolution::Fqn(fqn) => fqn,
            // Class names never fall back; `self`/`parent` in a class list
            // is an error PHP reports, so keep it as written.
            Resolution::Fallback { namespaced, .. } => namespaced,
            Resolution::Relative(relative) => relative.as_str().to_owned(),
        }
    }

    fn class_names<'n, 'a: 'n>(&self, identifiers: impl IntoIterator<Item = &'n Identifier<'a>>) -> Vec<String> {
        identifiers.into_iter().map(|identifier| self.class_name(identifier)).collect()
    }

    fn attributes(&self, lists: &Sequence<'_, AttributeList<'_>>) -> Vec<String> {
        lists.iter().flat_map(|list| list.attributes.iter()).map(|attribute| self.class_name(&attribute.name)).collect()
    }

    fn hint(&self, hint: &Hint<'_>) -> TypeHint {
        type_hint(&self.scope, hint)
    }

    fn return_type(&self, hint: &Option<FunctionLikeReturnTypeHint<'_>>) -> Option<TypeHint> {
        hint.as_ref().map(|hint| self.hint(&hint.hint))
    }

    fn param(&self, parameter: &FunctionLikeParameter<'_>) -> Param {
        let mods = Mods::of(&parameter.modifiers);
        Param {
            name: variable_name(parameter.variable.name),
            name_loc: self.loc(parameter.variable.span),
            loc: self.loc(parameter.span()),
            type_hint: parameter.hint.as_ref().map(|hint| self.hint(hint)),
            default: parameter.default_value.as_ref().map(|default| self.source(default.value.span())),
            by_ref: parameter.ampersand.is_some(),
            variadic: parameter.ellipsis.is_some(),
            promoted: (mods.any() || parameter.hooks.is_some()).then(|| Promotion {
                visibility: mods.visibility.unwrap_or_default(),
                set_visibility: mods.set_visibility,
                is_readonly: mods.is_readonly,
                has_hooks: parameter.hooks.is_some(),
            }),
            attributes: self.attributes(&parameter.attribute_lists),
        }
    }

    fn params(&self, list: &FunctionLikeParameterList<'_>) -> Vec<Param> {
        list.parameters.iter().map(|parameter| self.param(parameter)).collect()
    }

    fn function(&self, node: &Function<'_>) -> FunctionDecl {
        let params = self.params(&node.parameter_list);
        let return_type = self.return_type(&node.return_type_hint);
        let doc = self.doc_at(node.span().start.offset, &[]);
        let inferred_return =
            self.infers_return(&return_type, &doc).then(|| body_return(&self.infer(&params, &doc, &[]), &node.body));
        FunctionDecl {
            fqn: self.scope.qualify(node.name.value),
            name: lossy(node.name.value),
            name_loc: self.loc(node.name.span),
            loc: self.loc(node.span()),
            by_ref_return: node.ampersand.is_some(),
            params,
            return_type,
            inferred_return,
            attributes: self.attributes(&node.attribute_lists),
            doc,
        }
    }

    /// Whether a function-like's return type has to be inferred: neither a
    /// native return type nor `@return`.
    fn infers_return(&self, return_type: &Option<TypeHint>, doc: &Option<Box<DocBlock>>) -> bool {
        return_type.is_none() && doc.as_ref().is_none_or(|doc| doc.return_type.is_none())
    }

    /// Inference over a function-like body: the parameters have their
    /// `@param` type, else their native one.
    fn infer(&self, params: &[Param], doc: &Option<Box<DocBlock>>, outer: &[String]) -> Infer<'_> {
        let mut templates: Vec<&str> = outer.iter().map(String::as_str).collect();
        templates.extend(doc.iter().flat_map(|doc| doc.local_type_names()));
        let params = params
            .iter()
            .filter_map(|param| {
                let ty = match (doc.as_ref().and_then(|doc| doc.param_type(&param.name)), &param.type_hint) {
                    (Some(ty), _) => Type::from_doc(ty, &templates),
                    (None, Some(hint)) => Type::from_hint(hint),
                    (None, None) => return None,
                };
                let ty = if param.variadic { Type::list_of(ty) } else { ty };
                Some((param.name.clone(), ty))
            })
            .collect();
        Infer { scope: &self.scope, params, literals: false }
    }

    /// The type of a constant value or property default.
    fn value_type(&self, value: &Expression<'_>, literals: bool) -> LazyType {
        Infer { scope: &self.scope, params: Vec::new(), literals }.expr(value)
    }

    fn class_like(
        &self,
        kind: ClassKind,
        name: &LocalIdentifier<'_>,
        span: Span,
        attributes: &Sequence<'_, AttributeList<'_>>,
        members: &Sequence<'_, ClassLikeMember<'_>>,
    ) -> ClassLike {
        let doc = self.doc_at(span.start.offset, &[]);
        // Template and alias names of the class, in scope in every member's
        // docblock.
        let names: Vec<String> = doc.iter().flat_map(|doc| doc.local_type_names()).map(str::to_owned).collect();
        let mut class = ClassLike {
            kind,
            fqn: self.scope.qualify(name.value),
            name: lossy(name.value),
            name_loc: self.loc(name.span),
            loc: self.loc(span),
            modifiers: ClassModifiers::default(),
            extends: Vec::new(),
            implements: Vec::new(),
            backing_type: None,
            trait_uses: Vec::new(),
            constants: Vec::new(),
            cases: Vec::new(),
            properties: Vec::new(),
            methods: Vec::new(),
            attributes: self.attributes(attributes),
            doc,
        };
        for member in members {
            match member {
                ClassLikeMember::TraitUse(trait_use) => {
                    class.trait_uses.push(self.trait_use(trait_use));
                    // `/** @use Foo<Bar> */ use Foo;`: kept with the class's
                    // own `@use` tags.
                    if let Some(use_doc) = self.doc_at(trait_use.span().start.offset, &names)
                        && !use_doc.uses.is_empty()
                    {
                        class.doc.get_or_insert_with(Default::default).uses.extend(use_doc.uses);
                    }
                }
                ClassLikeMember::Constant(constant) => self.class_constant(constant, &names, &mut class.constants),
                ClassLikeMember::Property(property) => self.property(property, &names, &mut class.properties),
                ClassLikeMember::EnumCase(case) => class.cases.push(self.enum_case(case, &names)),
                ClassLikeMember::Method(method) => {
                    let method = self.method(method, kind == ClassKind::Interface, &names);
                    // Promoted constructor parameters are properties too.
                    if method.name.eq_ignore_ascii_case("__construct") {
                        for param in &method.params {
                            if let Some(promotion) = &param.promoted {
                                class.properties.push(Property {
                                    name: param.name.clone(),
                                    name_loc: param.name_loc,
                                    loc: param.loc,
                                    visibility: promotion.visibility,
                                    set_visibility: promotion.set_visibility,
                                    is_static: false,
                                    is_readonly: promotion.is_readonly,
                                    is_abstract: false,
                                    is_final: false,
                                    has_hooks: promotion.has_hooks,
                                    is_promoted: true,
                                    type_hint: param.type_hint.clone(),
                                    default: None,
                                    default_type: None,
                                    attributes: param.attributes.clone(),
                                    doc: self.promoted_doc(param, &method, &names),
                                });
                            }
                        }
                    }
                    class.methods.push(method);
                }
            }
        }
        class
    }

    /// Types from the type providers for the properties with neither a type
    /// hint nor `@var`, from what the class's methods assign to them
    /// (`$this->x = …` in PHPUnit's `setUp()`).
    fn provided_properties(&self, class: &mut ClassLike, members: &Sequence<'_, ClassLikeMember<'_>>) {
        let untyped = |property: &Property| {
            !property.is_promoted
                && !property.is_static
                && property.type_hint.is_none()
                && property.doc.as_ref().is_none_or(|doc| doc.var_type(&property.name).is_none())
        };
        if !class.properties.iter().any(untyped) {
            return;
        }
        let mut assigned: Vec<(String, Assigned)> = Vec::new();
        for member in members {
            let ClassLikeMember::Method(node) = member else { continue };
            let MethodBody::Concrete(body) = &node.body else { continue };
            let start = node.name.span.start.offset;
            let Some(method) = class.methods.iter().find(|method| method.name_loc.start == start) else { continue };
            let found = this_assignments(body);
            if found.is_empty() {
                continue;
            }
            let names: Vec<String> =
                class.doc.iter().flat_map(|doc| doc.local_type_names()).map(str::to_owned).collect();
            let infer = self.infer(&method.params, &method.doc, &names);
            for (property, value) in found {
                assigned.push((property, Assigned { method: method.name.clone(), ty: infer.expr(value) }));
            }
        }
        for i in 0..class.properties.len() {
            let property = &class.properties[i];
            if !untyped(property) {
                continue;
            }
            let own: Vec<Assigned> =
                assigned.iter().filter(|(name, _)| *name == property.name).map(|(_, a)| a.clone()).collect();
            if own.is_empty() {
                continue;
            }
            let site =
                PropertySite { class: &class.fqn, extends: &class.extends, name: &property.name, assigned: &own };
            if let Some(ty) = TypeProviders::builtin().property(&site) {
                class.properties[i].default_type = Some(ty);
            }
        }
    }

    fn trait_use(&self, node: &AstTraitUse<'_>) -> TraitUse {
        let mut rules = Vec::new();
        if let TraitUseSpecification::Concrete(specification) = &node.specification {
            for adaptation in &specification.adaptations {
                match adaptation {
                    TraitUseAdaptation::Precedence(precedence) => rules.push(TraitRule::Insteadof {
                        trait_name: self.class_name(&precedence.method_reference.trait_name),
                        method: lossy(precedence.method_reference.method_name.value),
                        instead_of: self.class_names(&precedence.trait_names),
                    }),
                    TraitUseAdaptation::Alias(alias) => {
                        let (trait_name, method) = match &alias.method_reference {
                            TraitUseMethodReference::Identifier(method) => (None, lossy(method.value)),
                            TraitUseMethodReference::Absolute(absolute) => {
                                (Some(self.class_name(&absolute.trait_name)), lossy(absolute.method_name.value))
                            }
                        };
                        rules.push(TraitRule::Alias {
                            trait_name,
                            method,
                            visibility: alias.modifier.as_ref().and_then(|modifier| visibility_of(modifier).0),
                            alias: alias.alias.as_ref().map(|alias| lossy(alias.value)),
                        });
                    }
                }
            }
        }
        TraitUse { traits: self.class_names(&node.trait_names), rules, loc: self.loc(node.span()) }
    }

    /// A promoted property's docblock: the parameter's own (`/** @var T */`),
    /// with the constructor's `@param` type when that has no `@var`.
    fn promoted_doc(&self, param: &Param, constructor: &Method, names: &[String]) -> Option<Box<DocBlock>> {
        let mut doc = self.doc_at(param.loc.start, names).map(|doc| *doc).unwrap_or_default();
        if doc.vars.is_empty()
            && let Some(ty) = constructor.doc.as_ref().and_then(|doc| doc.param_type(&param.name))
        {
            doc.vars.push(DocVar { name: None, ty: ty.clone() });
        }
        (!doc.is_empty()).then(|| Box::new(doc))
    }

    fn class_constant(&self, node: &ClassLikeConstant<'_>, names: &[String], out: &mut Vec<ClassConstant>) {
        let mods = Mods::of(&node.modifiers);
        let type_hint = node.hint.as_ref().map(|hint| self.hint(hint));
        let attributes = self.attributes(&node.attribute_lists);
        let loc = self.loc(node.span());
        let doc = self.doc_at(node.span().start.offset, names);
        for item in &node.items {
            let name = lossy(item.name.value);
            let typed = type_hint.is_some() || doc.as_ref().is_some_and(|doc| doc.var_type(&name).is_some());
            out.push(ClassConstant {
                value_type: (!typed).then(|| self.value_type(item.value, true)),
                name,
                name_loc: self.loc(item.name.span),
                loc,
                visibility: mods.visibility.unwrap_or_default(),
                is_final: mods.is_final,
                type_hint: type_hint.clone(),
                value: self.source(item.value.span()),
                attributes: attributes.clone(),
                doc: doc.clone(),
            });
        }
    }

    fn property(&self, node: &AstProperty<'_>, names: &[String], out: &mut Vec<Property>) {
        let (attribute_lists, modifiers, hint, items, has_hooks): (_, _, _, Vec<&PropertyItem<'_>>, _) = match node {
            AstProperty::Plain(plain) => {
                (&plain.attribute_lists, &plain.modifiers, &plain.hint, plain.items.iter().collect(), false)
            }
            AstProperty::Hooked(hooked) => {
                (&hooked.attribute_lists, &hooked.modifiers, &hooked.hint, vec![&hooked.item], true)
            }
        };
        let mods = Mods::of(modifiers);
        let type_hint = hint.as_ref().map(|hint| self.hint(hint));
        let attributes = self.attributes(attribute_lists);
        let loc = self.loc(node.span());
        let doc = self.doc_at(node.span().start.offset, names);
        for item in items {
            let (variable, value) = match item {
                PropertyItem::Abstract(item) => (&item.variable, None),
                PropertyItem::Concrete(item) => (&item.variable, Some(item.value)),
            };
            let name = variable_name(variable.name);
            let typed = type_hint.is_some() || doc.as_ref().is_some_and(|doc| doc.var_type(&name).is_some());
            out.push(Property {
                default: value.map(|value| self.source(value.span())),
                default_type: value.filter(|_| !typed).map(|value| self.value_type(value, false)),
                name,
                name_loc: self.loc(variable.span),
                loc,
                visibility: mods.visibility.unwrap_or_default(),
                set_visibility: mods.set_visibility,
                is_static: mods.is_static,
                is_readonly: mods.is_readonly,
                is_abstract: mods.is_abstract,
                is_final: mods.is_final,
                has_hooks,
                is_promoted: false,
                type_hint: type_hint.clone(),
                attributes: attributes.clone(),
                doc: doc.clone(),
            });
        }
    }

    fn enum_case(&self, node: &AstEnumCase<'_>, names: &[String]) -> EnumCase {
        let (name, value) = match &node.item {
            EnumCaseItem::Unit(item) => (&item.name, None),
            EnumCaseItem::Backed(item) => (&item.name, Some(self.source(item.value.span()))),
        };
        EnumCase {
            name: lossy(name.value),
            name_loc: self.loc(name.span),
            loc: self.loc(node.span()),
            value,
            attributes: self.attributes(&node.attribute_lists),
            doc: self.doc_at(node.span().start.offset, names),
        }
    }

    fn method(&self, node: &AstMethod<'_>, in_interface: bool, names: &[String]) -> Method {
        let mods = Mods::of(&node.modifiers);
        let params = self.params(&node.parameter_list);
        let return_type = self.return_type(&node.return_type_hint);
        let doc = self.doc_at(node.span().start.offset, names);
        let inferred_return = match &node.body {
            MethodBody::Concrete(body)
                if self.infers_return(&return_type, &doc) && !node.name.value.eq_ignore_ascii_case(b"__construct") =>
            {
                Some(body_return(&self.infer(&params, &doc, names), body))
            }
            _ => None,
        };
        Method {
            name: lossy(node.name.value),
            name_loc: self.loc(node.name.span),
            loc: self.loc(node.span()),
            visibility: mods.visibility.unwrap_or_default(),
            is_static: mods.is_static,
            is_abstract: mods.is_abstract || (in_interface && matches!(node.body, MethodBody::Abstract(_))),
            is_final: mods.is_final,
            by_ref_return: node.ampersand.is_some(),
            params,
            return_type,
            inferred_return,
            attributes: self.attributes(&node.attribute_lists),
            doc,
        }
    }

    fn push_class(&mut self, class: ClassLike) {
        self.summary.class_likes.push(class);
    }
}

/// `define` as the callee, in any case, with or without the leading `\`.
fn is_define(function: &Expression<'_>) -> bool {
    match function {
        Expression::Identifier(identifier) => {
            let name = identifier.value();
            name.strip_prefix(b"\\").unwrap_or(name).eq_ignore_ascii_case(b"define")
        }
        _ => false,
    }
}

struct SummaryWalker;

impl<'ast, 'arena, 'f> Walker<'ast, 'arena, Extractor<'f>> for SummaryWalker {
    fn walk_in_namespace(&self, node: &'ast Namespace<'arena>, cx: &mut Extractor<'f>) {
        let name = node.name.as_ref().map(|name| name.value()).unwrap_or_default();
        cx.scope = NameScope::for_namespace(&lossy(name));
    }

    fn walk_out_namespace(&self, node: &'ast Namespace<'arena>, cx: &mut Extractor<'f>) {
        // Implicit namespaces run until the next `namespace`, which resets
        // the scope itself; braced ones end here.
        if let NamespaceBody::BraceDelimited(_) = node.body {
            cx.scope = NameScope::global();
        }
    }

    fn walk_in_use(&self, node: &'ast Use<'arena>, cx: &mut Extractor<'f>) {
        cx.scope.add_use(node);
    }

    fn walk_in_class(&self, node: &'ast Class<'arena>, cx: &mut Extractor<'f>) {
        let mut class = cx.class_like(ClassKind::Class, &node.name, node.span(), &node.attribute_lists, &node.members);
        let mods = Mods::of(&node.modifiers);
        class.modifiers =
            ClassModifiers { is_abstract: mods.is_abstract, is_final: mods.is_final, is_readonly: mods.is_readonly };
        if mods.is_readonly {
            for property in &mut class.properties {
                property.is_readonly = true;
            }
        }
        class.extends = node.extends.as_ref().map(|extends| cx.class_names(&extends.types)).unwrap_or_default();
        class.implements =
            node.implements.as_ref().map(|implements| cx.class_names(&implements.types)).unwrap_or_default();
        cx.provided_properties(&mut class, &node.members);
        cx.push_class(class);
    }

    fn walk_in_interface(&self, node: &'ast Interface<'arena>, cx: &mut Extractor<'f>) {
        let mut class =
            cx.class_like(ClassKind::Interface, &node.name, node.span(), &node.attribute_lists, &node.members);
        class.extends = node.extends.as_ref().map(|extends| cx.class_names(&extends.types)).unwrap_or_default();
        cx.push_class(class);
    }

    fn walk_in_trait(&self, node: &'ast Trait<'arena>, cx: &mut Extractor<'f>) {
        let class = cx.class_like(ClassKind::Trait, &node.name, node.span(), &node.attribute_lists, &node.members);
        cx.push_class(class);
    }

    fn walk_in_enum(&self, node: &'ast Enum<'arena>, cx: &mut Extractor<'f>) {
        let mut class = cx.class_like(ClassKind::Enum, &node.name, node.span(), &node.attribute_lists, &node.members);
        class.modifiers.is_final = true;
        class.backing_type = node.backing_type_hint.as_ref().map(|backing| cx.hint(&backing.hint));
        class.implements =
            node.implements.as_ref().map(|implements| cx.class_names(&implements.types)).unwrap_or_default();
        cx.push_class(class);
    }

    fn walk_in_function(&self, node: &'ast Function<'arena>, cx: &mut Extractor<'f>) {
        let function = cx.function(node);
        cx.summary.functions.push(function);
    }

    fn walk_in_constant(&self, node: &'ast Constant<'arena>, cx: &mut Extractor<'f>) {
        let loc = cx.loc(node.span());
        let attributes = cx.attributes(&node.attribute_lists);
        let doc = cx.doc_at(node.span().start.offset, &[]);
        for item in &node.items {
            let constant = ConstantDecl {
                kind: ConstantKind::Const,
                fqn: cx.scope.qualify(item.name.value),
                name_loc: cx.loc(item.name.span),
                loc,
                value: cx.source(item.value.span()),
                value_type: Some(cx.value_type(item.value, true)),
                attributes: attributes.clone(),
                doc: doc.clone(),
            };
            cx.summary.constants.push(constant);
        }
    }

    fn walk_in_function_call(&self, node: &'ast FunctionCall<'arena>, cx: &mut Extractor<'f>) {
        let mut meta = std::mem::take(&mut cx.summary.meta);
        crate::meta::directive(&cx.scope, node, &|span| cx.source(span), &mut meta);
        cx.summary.meta = meta;
        if !is_define(node.function) {
            return;
        }
        let mut arguments = node.argument_list.arguments.iter().map(|argument| match argument {
            Argument::Positional(argument) => argument.value,
            Argument::Named(argument) => argument.value,
        });
        let (Some(Expression::Literal(Literal::String(name))), Some(value)) = (arguments.next(), arguments.next())
        else {
            return;
        };
        let Some(text) = name.value.filter(|text| !text.is_empty()) else { return };
        // The quoted name; point inside the quotes when they are there.
        let mut name_span = name.span;
        if name.raw.len() >= 2 {
            name_span.start.offset += 1;
            name_span.end.offset -= 1;
        }
        let constant = ConstantDecl {
            kind: ConstantKind::Define,
            fqn: lossy(text.strip_prefix(b"\\").unwrap_or(text)),
            name_loc: cx.loc(name_span),
            loc: cx.loc(node.span()),
            value: cx.source(value.span()),
            value_type: Some(cx.value_type(value, true)),
            attributes: Vec::new(),
            doc: cx.doc_at(node.span().start.offset, &[]),
        };
        cx.summary.constants.push(constant);
    }
}
