//! Docblocks to [`DocBlock`]s.
//!
//! `mago-phpdoc-syntax` parses each docblock on its own and reports errors per
//! tag: a tag it cannot read becomes `TagValue::Invalid` and the rest of the
//! docblock still parses. Invalid `@param`, `@return` and `@var` tags keep
//! their name with the type `mixed` (the spike found these in WordPress hash
//! notation and in `callable(...mixed)`), and every other invalid tag is
//! dropped.
//!
//! Types are stored as text with class names rewritten to fully qualified
//! names, using the imports in force at the declaration, so a later phase can
//! parse them without this file. Which names are classes follows PHPStan's
//! documented rules: a name that is a template parameter or type alias in
//! scope is not a class, and neither is a keyword or a dashed pseudo-type.

use mago_allocator::LocalArena;
use mago_phpdoc_syntax::PHPDocParser;
use mago_phpdoc_syntax::cst::r#type::{
    GenericParameters, ReferenceKind, ShapeField, ShapeKey, SingleGenericParameter, Type,
};
use mago_phpdoc_syntax::cst::{
    Identifier as DocIdentifier, InvalidTagValue, MethodTagValue, Tag, TagValue, TemplateTagValue,
    TemplateTagValueVariance,
};
use mago_span::{HasSpan, Span};
use mago_syntax::comments::docblock::get_docblock_before_position;

use super::{Extractor, lossy, variable_name};
use crate::names::{NameKind, Resolution};
use crate::summary::{
    DocBlock, DocMethod, DocMethodParam, DocParam, DocProperty, DocTemplate, DocType, DocTypeAlias, DocVar,
    PropertyAccess, Variance,
};

/// Lower-case names that PHPDoc tools treat as types although Mago reads
/// them as class references.
const PSEUDO_TYPES: &[&str] = &["noreturn", "number", "callback", "this", "resource", "void"];

/// How much a tag counts when two describe the same thing: a later tag
/// replaces an earlier one unless it counts less.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Priority {
    /// A tag that did not parse, kept with the type `mixed`.
    Fallback,
    Plain,
    /// `@psalm-*`, `@phpstan-*` and the other tool prefixes.
    Vendor,
}

type Entries<T> = Vec<(Priority, T)>;

fn upsert<T>(list: &mut Entries<T>, priority: Priority, item: T, same: impl Fn(&T, &T) -> bool) {
    match list.iter_mut().find(|(_, old)| same(old, &item)) {
        Some(entry) if priority >= entry.0 => *entry = (priority, item),
        Some(_) => {}
        None => list.push((priority, item)),
    }
}

fn items<T>(list: Entries<T>) -> Vec<T> {
    list.into_iter().map(|(_, item)| item).collect()
}

/// The class part of `Base<Args>`, for matching `@extends` tags.
fn generic_base(ty: &DocType) -> String {
    ty.0.split('<').next().unwrap_or_default().trim().to_ascii_lowercase()
}

#[derive(Default)]
struct Builder {
    deprecated: Option<String>,
    vars: Entries<DocVar>,
    params: Entries<DocParam>,
    return_type: Option<(Priority, DocType)>,
    throws: Entries<DocType>,
    templates: Entries<DocTemplate>,
    extends: Entries<DocType>,
    implements: Entries<DocType>,
    uses: Entries<DocType>,
    mixins: Entries<DocType>,
    properties: Entries<DocProperty>,
    methods: Entries<DocMethod>,
    type_aliases: Entries<DocTypeAlias>,
}

impl Builder {
    fn var(&mut self, priority: Priority, var: DocVar) {
        upsert(&mut self.vars, priority, var, |a, b| a.name == b.name);
    }

    fn param(&mut self, priority: Priority, param: DocParam) {
        upsert(&mut self.params, priority, param, |a, b| a.name == b.name);
    }

    fn return_type(&mut self, priority: Priority, ty: DocType) {
        if self.return_type.as_ref().is_none_or(|(old, _)| priority >= *old) {
            self.return_type = Some((priority, ty));
        }
    }

    fn finish(self) -> DocBlock {
        DocBlock {
            deprecated: self.deprecated,
            vars: items(self.vars),
            params: items(self.params),
            return_type: self.return_type.map(|(_, ty)| ty),
            throws: items(self.throws),
            templates: items(self.templates),
            extends: items(self.extends),
            implements: items(self.implements),
            uses: items(self.uses),
            mixins: items(self.mixins),
            properties: items(self.properties),
            methods: items(self.methods),
            type_aliases: items(self.type_aliases),
        }
    }
}

/// Every class-like name a type refers to, in source order.
fn class_refs<'a>(ty: &Type<'a>, out: &mut Vec<DocIdentifier<'a>>) {
    fn kind<'a>(kind: &ReferenceKind<'a>, out: &mut Vec<DocIdentifier<'a>>) {
        if let ReferenceKind::Identifier(identifier) = kind {
            out.push(*identifier);
        }
    }
    fn generics<'a>(parameters: Option<&GenericParameters<'a>>, out: &mut Vec<DocIdentifier<'a>>) {
        for entry in parameters.into_iter().flat_map(|parameters| parameters.entries.iter()) {
            class_refs(&entry.inner, out);
        }
    }
    fn single<'a>(parameter: &Option<SingleGenericParameter<'a>>, out: &mut Vec<DocIdentifier<'a>>) {
        if let Some(parameter) = parameter {
            class_refs(&parameter.entry.inner, out);
        }
    }
    fn fields<'a, 'f>(fields: impl IntoIterator<Item = &'f ShapeField<'a>>, out: &mut Vec<DocIdentifier<'a>>)
    where
        'a: 'f,
    {
        for field in fields {
            if let Some(ShapeKey::ClassLikeConstant { class_name, .. }) = field.key.as_ref().map(|key| &key.key) {
                out.push(*class_name);
            }
            class_refs(field.value, out);
        }
    }

    match ty {
        Type::Parenthesized(ty) => class_refs(ty.inner, out),
        Type::Nullable(ty) => class_refs(ty.inner, out),
        Type::TrailingPipe(ty) => class_refs(ty.inner, out),
        Type::Union(ty) => {
            class_refs(ty.left, out);
            class_refs(ty.right, out);
        }
        Type::Intersection(ty) => {
            class_refs(ty.left, out);
            class_refs(ty.right, out);
        }
        Type::Array(ty) => generics(ty.parameters.as_ref(), out),
        Type::NonEmptyArray(ty) => generics(ty.parameters.as_ref(), out),
        Type::AssociativeArray(ty) => generics(ty.parameters.as_ref(), out),
        Type::List(ty) => generics(ty.parameters.as_ref(), out),
        Type::NonEmptyList(ty) => generics(ty.parameters.as_ref(), out),
        Type::Iterable(ty) => generics(ty.parameters.as_ref(), out),
        Type::ClassString(ty) => single(&ty.parameter, out),
        Type::ClassLikeString(ty) => single(&ty.parameter, out),
        Type::InterfaceString(ty) => single(&ty.parameter, out),
        Type::EnumString(ty) => single(&ty.parameter, out),
        Type::TraitString(ty) => single(&ty.parameter, out),
        Type::Reference(ty) => {
            kind(&ty.kind, out);
            generics(ty.parameters.as_ref(), out);
        }
        Type::MemberReference(ty) => kind(&ty.kind, out),
        Type::AliasReference(ty) => kind(&ty.class, out),
        Type::Shape(ty) => {
            fields(ty.fields.iter(), out);
            if let Some(additional) = &ty.additional_fields {
                generics(additional.parameters.as_ref(), out);
            }
        }
        Type::Object(ty) => {
            if let Some(properties) = &ty.properties {
                fields(properties.fields.iter(), out);
            }
        }
        Type::Callable(ty) => {
            if let Some(specification) = &ty.specification {
                for parameter in specification.parameters.entries.iter() {
                    if let Some(parameter_type) = &parameter.parameter_type {
                        class_refs(parameter_type, out);
                    }
                }
                if let Some(return_type) = &specification.return_type {
                    class_refs(return_type.return_type, out);
                }
            }
        }
        Type::Conditional(ty) => {
            for part in [ty.subject, ty.target, ty.then, ty.r#else] {
                class_refs(part, out);
            }
        }
        Type::KeyOf(ty) => class_refs(&ty.parameter.entry.inner, out),
        Type::ValueOf(ty) => class_refs(&ty.parameter.entry.inner, out),
        Type::IntMaskOf(ty) => class_refs(&ty.parameter.entry.inner, out),
        Type::New(ty) => class_refs(&ty.parameter.entry.inner, out),
        Type::PropertiesOf(ty) => class_refs(&ty.parameter.entry.inner, out),
        Type::IntMask(ty) => generics(Some(&ty.parameters), out),
        Type::TemplateType(ty) => generics(Some(&ty.parameters), out),
        Type::IndexAccess(ty) => {
            class_refs(ty.target, out);
            class_refs(ty.index, out);
        }
        Type::Negated(ty) => class_refs(ty.operand, out),
        Type::Posited(ty) => class_refs(ty.operand, out),
        Type::Slice(ty) => class_refs(ty.inner, out),
        _ => {}
    }
}

/// Joins a docblock excerpt onto one line: continuation lines lose their
/// indentation and leading `*`.
fn one_line(text: &str) -> String {
    let mut out = String::new();
    for (i, line) in text.split('\n').enumerate() {
        let mut line = line.trim_end();
        if i > 0 {
            line = line.trim_start();
            line = line.strip_prefix('*').unwrap_or(line).trim_start();
            if line.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push(' ');
            }
        }
        out.push_str(line);
    }
    out
}

/// The parameter a tag whose type did not parse names: the first `$name`
/// outside brackets (`callable(...mixed): mixed $callback`), else the last one
/// (`array{ $name` with the bracket never closed).
fn tag_variable(text: &str) -> Option<String> {
    let mut depth = 0usize;
    let mut last = None;
    for (i, c) in text.char_indices() {
        match c {
            '(' | '<' | '[' | '{' => depth += 1,
            ')' | '>' | ']' | '}' => depth = depth.saturating_sub(1),
            '$' => {
                let name: String =
                    text[i + 1..].chars().take_while(|c| c.is_alphanumeric() || *c == '_' || !c.is_ascii()).collect();
                if name.is_empty() {
                    continue;
                }
                if depth == 0 {
                    return Some(name);
                }
                last = Some(name);
            }
            _ => {}
        }
    }
    last
}

impl Extractor<'_> {
    /// The docblock directly in front of a declaration starting at `start`,
    /// or `None` when there is none or it has no tag the summary keeps.
    /// `outer` lists the template and alias names already in scope (those of
    /// the enclosing class).
    pub(super) fn doc_at(&self, start: u32, outer: &[String]) -> Option<Box<DocBlock>> {
        let program = self.file.program();
        let trivia = get_docblock_before_position(program.trivia.as_slice(), start)?;
        let arena = LocalArena::new();
        let document = PHPDocParser::parse_with_span(&arena, trivia.value, trivia.span);

        let mut names = outer.to_vec();
        for tag in document.tags() {
            match &tag.value {
                TagValue::Template(template) => names.push(lossy(template.name.value)),
                TagValue::TypeAlias(alias) if tag.vendor.is_some() => names.push(lossy(alias.alias.value)),
                TagValue::TypeAliasImport(import) => {
                    let local = import.imported_as.as_ref().map_or(&import.imported_alias, |r#as| &r#as.local);
                    names.push(lossy(local.value));
                }
                _ => {}
            }
        }

        let mut builder = Builder::default();
        for tag in document.tags() {
            self.doc_tag(tag, &names, &mut builder);
        }
        let doc = builder.finish();
        (!doc.is_empty()).then(|| Box::new(doc))
    }

    fn doc_tag(&self, tag: &Tag<'_>, names: &[String], b: &mut Builder) {
        let priority = if tag.vendor.is_some() { Priority::Vendor } else { Priority::Plain };
        let ty = |ty: &Type<'_>| self.doc_type(ty, names);
        match &tag.value {
            TagValue::Param(param) => {
                // A `@param` without a variable names no parameter.
                if let Some(variable) = &param.parameter {
                    b.param(
                        priority,
                        DocParam {
                            name: variable_name(variable.value),
                            ty: ty(param.r#type),
                            by_ref: param.ampersand.is_some(),
                            variadic: param.ellipsis.is_some(),
                        },
                    );
                }
            }
            TagValue::Return(value) => b.return_type(priority, ty(value.r#type)),
            TagValue::Var(var) => b.var(
                priority,
                DocVar {
                    name: var.variable.as_ref().map(|variable| variable_name(variable.value)),
                    ty: ty(var.r#type),
                },
            ),
            TagValue::Throws(throws) => upsert(&mut b.throws, priority, ty(throws.r#type), |a, b| a == b),
            TagValue::Mixin(mixin) => upsert(&mut b.mixins, priority, ty(mixin.r#type), |a, b| a == b),
            TagValue::Template(template) => {
                upsert(&mut b.templates, priority, self.doc_template(template, names), |a, b| a.name == b.name);
            }
            TagValue::Extends(value) => {
                upsert(&mut b.extends, priority, ty(value.r#type), |a, b| generic_base(a) == generic_base(b));
            }
            TagValue::Implements(value) => {
                upsert(&mut b.implements, priority, ty(value.r#type), |a, b| generic_base(a) == generic_base(b));
            }
            TagValue::Use(value) => {
                upsert(&mut b.uses, priority, ty(value.r#type), |a, b| generic_base(a) == generic_base(b));
            }
            TagValue::Property(property) | TagValue::PropertyRead(property) | TagValue::PropertyWrite(property) => {
                let access = match &tag.value {
                    TagValue::PropertyRead(_) => PropertyAccess::Read,
                    TagValue::PropertyWrite(_) => PropertyAccess::Write,
                    _ => PropertyAccess::ReadWrite,
                };
                let property = DocProperty {
                    name: variable_name(property.variable.value),
                    name_loc: self.loc(property.variable.span),
                    ty: property.r#type.map(ty),
                    access,
                };
                upsert(&mut b.properties, priority, property, |a, b| a.name == b.name);
            }
            TagValue::Method(method) => {
                upsert(&mut b.methods, priority, self.doc_method(method, names), |a, b| {
                    a.name.eq_ignore_ascii_case(&b.name)
                });
            }
            TagValue::Deprecated(deprecated) => {
                b.deprecated = Some(self.doc_text(deprecated.description.span));
            }
            // A plain `@type` is WordPress's hash notation, not an alias.
            TagValue::TypeAlias(alias) if tag.vendor.is_some() => {
                let alias =
                    DocTypeAlias { name: lossy(alias.alias.value), ty: Some(ty(alias.r#type)), imported_from: None };
                upsert(&mut b.type_aliases, priority, alias, |a, b| a.name == b.name);
            }
            TagValue::TypeAliasImport(import) => {
                let local = import.imported_as.as_ref().map_or(&import.imported_alias, |r#as| &r#as.local);
                let class = match self.doc_class_name(import.imported_from.value, &[]) {
                    Some(fqn) => fqn.trim_start_matches('\\').to_owned(),
                    None => lossy(import.imported_from.value),
                };
                let alias = DocTypeAlias {
                    name: lossy(local.value),
                    ty: None,
                    imported_from: Some((class, lossy(import.imported_alias.value))),
                };
                upsert(&mut b.type_aliases, priority, alias, |a, b| a.name == b.name);
            }
            TagValue::Invalid(invalid) => self.invalid_tag(tag, invalid, b),
            _ => {}
        }
    }

    /// Keeps an unreadable `@param`, `@return` or `@var` with the type `mixed`.
    fn invalid_tag(&self, tag: &Tag<'_>, invalid: &InvalidTagValue<'_>, b: &mut Builder) {
        let raw = lossy(tag.name.value).to_ascii_lowercase();
        let name = match tag.vendor {
            Some(vendor) => raw.strip_prefix(vendor.prefix()).and_then(|rest| rest.strip_prefix('-')).unwrap_or(&raw),
            None => &raw,
        };
        // The invalid value only holds what the parser had not consumed when
        // it failed, so read from the tag name to the end of its line or of
        // the value, whichever is later.
        let start = tag.name.span.end.offset;
        let source = self.file.text();
        let line_end = source
            .get(start as usize..)
            .and_then(|rest| rest.find('\n'))
            .map_or(source.len(), |at| start as usize + at);
        let mut span = invalid.value.span;
        span.start.offset = start;
        span.end.offset = span.end.offset.max(line_end as u32);
        let text = self.doc_text(span);
        match name {
            "param" => {
                if let Some(name) = tag_variable(&text) {
                    let param = DocParam { name, ty: DocType::mixed(), by_ref: false, variadic: false };
                    b.param(Priority::Fallback, param);
                }
            }
            "return" => b.return_type(Priority::Fallback, DocType::mixed()),
            "var" => b.var(Priority::Fallback, DocVar { name: tag_variable(&text), ty: DocType::mixed() }),
            _ => {}
        }
    }

    fn doc_template(&self, template: &TemplateTagValue<'_>, names: &[String]) -> DocTemplate {
        DocTemplate {
            name: lossy(template.name.value),
            variance: match template.variance {
                TemplateTagValueVariance::Invariant => Variance::Invariant,
                TemplateTagValueVariance::Covariant => Variance::Covariant,
                TemplateTagValueVariance::Contravariant => Variance::Contravariant,
            },
            bound: template.bound.as_ref().map(|bound| self.doc_type(bound.r#type, names)),
            default: template.default.as_ref().map(|default| self.doc_type(default.r#type, names)),
        }
    }

    fn doc_method(&self, method: &MethodTagValue<'_>, outer: &[String]) -> DocMethod {
        let templates: Vec<&TemplateTagValue<'_>> =
            method.templates.iter().flat_map(|list| list.entries.iter()).map(|entry| &entry.template).collect();
        let mut names = outer.to_vec();
        names.extend(templates.iter().map(|template| lossy(template.name.value)));
        DocMethod {
            name: lossy(method.name.value),
            name_loc: self.loc(method.name.span),
            is_static: method.r#static.is_some(),
            templates: templates.iter().map(|template| self.doc_template(template, &names)).collect(),
            params: method
                .parameters
                .entries
                .iter()
                .map(|param| DocMethodParam {
                    name: variable_name(param.parameter.value),
                    ty: param.r#type.map(|ty| self.doc_type(ty, &names)),
                    default: param.default.as_ref().map(|default| self.doc_text(default.value.span())),
                    by_ref: param.ampersand.is_some(),
                    variadic: param.ellipsis.is_some(),
                })
                .collect(),
            return_type: method.return_type.map(|ty| self.doc_type(ty, &names)),
        }
    }

    /// Docblock text on one line.
    fn doc_text(&self, span: Span) -> String {
        one_line(&self.source(span))
    }

    /// The fully qualified name (with a leading `\`) a docblock name refers
    /// to, or `None` when it is not a class name.
    fn doc_class_name(&self, value: &[u8], names: &[String]) -> Option<String> {
        let name = lossy(value);
        let bare = !name.contains('\\');
        if name.is_empty()
            || name.contains('-')
            || (bare && names.contains(&name))
            || (bare && PSEUDO_TYPES.contains(&name.to_ascii_lowercase().as_str()))
        {
            return None;
        }
        match self.scope.resolve(NameKind::ClassLike, &name).resolution {
            Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => Some(format!("\\{fqn}")),
            Resolution::Relative(_) => None,
        }
    }

    /// The type as written, on one line, with its class names fully qualified.
    fn doc_type(&self, ty: &Type<'_>, names: &[String]) -> DocType {
        let span = ty.span();
        let mut refs = Vec::new();
        class_refs(ty, &mut refs);
        refs.sort_by_key(|identifier| identifier.span.start.offset);

        let text = self.file.text();
        let mut out = String::new();
        let mut at = span.start.offset as usize;
        for identifier in refs {
            let (start, end) = (identifier.span.start.offset as usize, identifier.span.end.offset as usize);
            let Some(fqn) = self.doc_class_name(identifier.value, names) else { continue };
            let Some(before) = text.get(at..start).filter(|_| end <= text.len()) else {
                // Spans always fall on the source, but never panic on one that
                // does not.
                return DocType(one_line(&ty.to_string()));
            };
            out.push_str(before);
            out.push_str(&fqn);
            at = end;
        }
        match text.get(at..(span.end.offset as usize).max(at)) {
            Some(rest) => out.push_str(rest),
            None => return DocType(one_line(&ty.to_string())),
        }
        DocType(one_line(&out))
    }
}

#[cfg(test)]
mod tests {
    use super::{one_line, tag_variable};

    #[test]
    fn joins_continuation_lines() {
        assert_eq!(one_line("array{\n *     a: int,\n *   }"), "array{ a: int, }");
        assert_eq!(one_line("int  "), "int");
        assert_eq!(one_line("a\r\n * b"), "a b");
    }

    #[test]
    fn finds_the_parameter_outside_brackets() {
        assert_eq!(tag_variable("callable(...mixed $x): mixed $cb the callback").as_deref(), Some("cb"));
        assert_eq!(tag_variable("array{ $a } &...$rest").as_deref(), Some("rest"));
        assert_eq!(tag_variable("array{ $broken").as_deref(), Some("broken"));
        assert_eq!(tag_variable("int"), None);
    }
}
