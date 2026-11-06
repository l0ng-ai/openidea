//! Hover: the declaration's signature, its type where the caret is, and
//! its PHPDoc as Markdown.
//!
//! The Markdown has the container (the class of a member, the function of a
//! parameter) as inline code, then the declaration in a `php` code block,
//! then the docblock: the description as written (PHPDoc descriptions are
//! Markdown already), then one line per tag, types and variables as code.
//! Member types are those at the caret: a method's return and a property's
//! type are bound to the receiver's generic arguments and inferred from the
//! call's arguments.
//!
//! Docblocks are read from the declaring file's text (the summaries keep
//! tags, not descriptions): the `/** … */` directly in front of the
//! declaration. A member without one, or whose docblock is just
//! `{@inheritDoc}` / `@inheritDoc`, shows the docblock of the member it
//! overrides or implements; an inline `{@inheritDoc}` is replaced by that
//! member's description.

use std::path::Path;

use crate::engine::PhpEngine;
use crate::names::NameKind;
use crate::summary::{ClassKind, ClassLike, FileSummary, Param, Visibility};
use crate::types::{Resolver, SignatureParam, Type};

use super::symbol::{Decl, Member, MemberKind, Subject, file_text};
use super::{namespace_of, short_name};

/// How many overridden members are followed for an inherited docblock.
const MAX_INHERITED: usize = 8;

/// A hover's contents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoverInfo {
    pub markdown: String,
    /// The name under the caret.
    pub range: ide_core::Range,
}

/// The `/** … */` docblock directly in front of byte `start` (only
/// whitespace between them).
pub fn doc_comment_before(text: &str, start: u32) -> Option<&str> {
    let before = text.get(..start as usize)?.trim_end();
    if !before.ends_with("*/") {
        return None;
    }
    let open = before.rfind("/**")?;
    let doc = &before[open..];
    // `/**/` is an empty comment, not a docblock; `/* … */` after a `/**`
    // that closed earlier is another comment.
    if doc.len() < 5 || doc[3..doc.len() - 2].contains("*/") {
        return None;
    }
    Some(doc)
}

/// A docblock split into its description and its tags.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DocText {
    pub description: String,
    /// `(tag name without @, the rest)`, continuation lines joined.
    pub tags: Vec<(String, String)>,
}

impl DocText {
    pub fn parse(doc: &str) -> Self {
        let inner = doc.trim().trim_start_matches("/**").trim_end_matches("*/");
        let mut description: Vec<&str> = Vec::new();
        let mut tags: Vec<(String, String)> = Vec::new();
        for line in inner.lines() {
            let line = line.trim_start();
            let line = line.strip_prefix('*').unwrap_or(line);
            let line = line.strip_prefix(' ').unwrap_or(line).trim_end();
            if let Some(tag) = line.strip_prefix('@') {
                let (name, rest) = tag.split_once(char::is_whitespace).unwrap_or((tag, ""));
                tags.push((name.to_owned(), rest.trim().to_owned()));
            } else if let Some((_, rest)) = tags.last_mut() {
                if !line.trim().is_empty() {
                    if !rest.is_empty() {
                        rest.push(' ');
                    }
                    rest.push_str(line.trim());
                }
            } else {
                description.push(line);
            }
        }
        Self { description: description.join("\n").trim().to_owned(), tags }
    }

    /// Only `{@inheritDoc}` / `@inheritDoc`: the docblock of the overridden
    /// member stands in for this one.
    fn only_inherits(&self) -> bool {
        let description = self.description.trim();
        let tags_inherit = self.tags.iter().all(|(name, _)| name.eq_ignore_ascii_case("inheritdoc"));
        tags_inherit
            && (description.is_empty() || is_inline_inherit(description))
            && (!self.tags.is_empty() || !description.is_empty())
    }

    /// The description of `@param` `$name`.
    fn param(&self, name: &str) -> Option<String> {
        self.tags.iter().filter(|(tag, _)| is_param_tag(tag)).find_map(|(_, rest)| {
            let (ty, rest) = split_type(rest);
            let (variable, description) = if ty.starts_with('$') { (ty, rest) } else { split_word(rest) };
            let variable = variable.trim_start_matches("...").trim_start_matches('&');
            (variable.strip_prefix('$') == Some(name)).then(|| description.trim().to_owned())
        })
    }

    pub fn markdown(&self) -> String {
        let mut out = String::new();
        if !self.description.is_empty() {
            out.push_str(&self.description);
        }
        let tags: Vec<String> = self.tags.iter().map(|(name, rest)| tag_markdown(name, rest)).collect();
        if !tags.is_empty() {
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(&tags.join("  \n"));
        }
        out
    }
}

fn is_inline_inherit(text: &str) -> bool {
    text.eq_ignore_ascii_case("{@inheritdoc}")
}

fn is_param_tag(tag: &str) -> bool {
    matches!(tag.to_ascii_lowercase().as_str(), "param" | "psalm-param" | "phpstan-param")
}

/// One tag as Markdown: `*@param* `int` `$a` description`.
fn tag_markdown(name: &str, rest: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let base = lower
        .rsplit_once('-')
        .filter(|(vendor, _)| matches!(*vendor, "psalm" | "phpstan"))
        .map_or(lower.as_str(), |(_, base)| base);
    let mut out = format!("*@{name}*");
    let push = |out: &mut String, part: &str, code: bool| {
        if part.is_empty() {
            return;
        }
        out.push(' ');
        if code {
            out.push('`');
            out.push_str(part);
            out.push('`');
        } else {
            out.push_str(part);
        }
    };
    match base {
        "param" | "var" | "property" | "property-read" | "property-write" => {
            let (ty, rest) = split_type(rest);
            if ty.starts_with('$') {
                push(&mut out, ty, true);
                push(&mut out, rest.trim(), false);
            } else {
                push(&mut out, ty, true);
                let (variable, rest) = split_word(rest);
                if variable.trim_start_matches("...").trim_start_matches('&').starts_with('$') {
                    push(&mut out, variable, true);
                    push(&mut out, rest.trim(), false);
                } else {
                    push(&mut out, rest.trim(), false);
                }
            }
        }
        "return" | "throws" | "mixin" | "extends" | "implements" | "use" | "see" => {
            let (ty, rest) = split_type(rest);
            push(&mut out, ty, true);
            push(&mut out, rest.trim(), false);
        }
        "template" | "template-covariant" | "template-contravariant" => {
            let (template, rest) = split_word(rest);
            push(&mut out, template, true);
            push(&mut out, rest.trim(), false);
        }
        _ => push(&mut out, rest, false),
    }
    out
}

fn split_word(text: &str) -> (&str, &str) {
    let text = text.trim_start();
    text.split_once(char::is_whitespace).unwrap_or((text, ""))
}

/// Splits a PHPDoc type off the front of `text`: up to the first whitespace
/// outside brackets that doesn't continue the type (`int | string`,
/// `callable(int): bool`).
fn split_type(text: &str) -> (&str, &str) {
    let text = text.trim_start();
    let mut depth = 0usize;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        let (at, c) = chars[i];
        match c {
            '(' | '<' | '[' | '{' => depth += 1,
            ')' | '>' | ']' | '}' => depth = depth.saturating_sub(1),
            c if c.is_whitespace() && depth == 0 => {
                let before = text[..at].trim_end();
                let after = text[at..].trim_start();
                let continues = before.ends_with(['|', '&', ':', ','])
                    || after.starts_with(['|', '&'])
                    || (after.starts_with(':') && before.ends_with(')'));
                if !continues {
                    return (&text[..at], &text[at..]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    (text, "")
}

// ------------------------------------------------------------- signatures

fn visibility(visibility: Visibility) -> &'static str {
    match visibility {
        Visibility::Public => "public",
        Visibility::Protected => "protected",
        Visibility::Private => "private",
    }
}

fn param_text(param: &Param) -> String {
    let mut out = String::new();
    if let Some(hint) = &param.type_hint {
        out.push_str(&hint.to_string());
        out.push(' ');
    }
    if param.by_ref {
        out.push('&');
    }
    if param.variadic {
        out.push_str("...");
    }
    out.push('$');
    out.push_str(&param.name);
    if let Some(default) = &param.default {
        out.push_str(" = ");
        out.push_str(default);
    }
    out
}

/// A parameter with its resolved type, and its default from the
/// declaration when there is one.
fn signature_param_text(param: &SignatureParam, default: Option<&str>) -> String {
    let mut out = format!("{} ", param.ty);
    if param.by_ref {
        out.push('&');
    }
    if param.variadic {
        out.push_str("...");
    }
    out.push('$');
    out.push_str(param.name.as_deref().unwrap_or("arg"));
    match default {
        Some(default) => {
            out.push_str(" = ");
            out.push_str(default);
        }
        None if param.optional && !param.variadic => out.push_str(" = …"),
        None => {}
    }
    out
}

fn class_signature(class: &ClassLike) -> String {
    let mut out = String::new();
    if class.modifiers.is_abstract && class.kind == ClassKind::Class {
        out.push_str("abstract ");
    }
    if class.modifiers.is_final {
        out.push_str("final ");
    }
    if class.modifiers.is_readonly {
        out.push_str("readonly ");
    }
    out.push_str(class.kind.as_str());
    out.push(' ');
    out.push_str(&class.name);
    if let Some(backing) = &class.backing_type {
        out.push_str(&format!(": {backing}"));
    }
    let names =
        |names: &[String]| names.iter().map(|n| format!("\\{}", n.trim_start_matches('\\'))).collect::<Vec<_>>();
    if !class.extends.is_empty() {
        out.push_str(" extends ");
        out.push_str(&names(&class.extends).join(", "));
    }
    if !class.implements.is_empty() {
        out.push_str(" implements ");
        out.push_str(&names(&class.implements).join(", "));
    }
    out
}

/// The hover text: optional container, the code, optional docs.
fn render(container: Option<&str>, code: &str, docs: Option<String>) -> String {
    let mut out = String::new();
    if let Some(container) = container.filter(|c| !c.is_empty()) {
        out.push('`');
        out.push_str(container);
        out.push_str("`\n\n");
    }
    out.push_str("```php\n<?php\n");
    out.push_str(code);
    out.push_str("\n```");
    if let Some(docs) = docs.filter(|docs| !docs.trim().is_empty()) {
        out.push_str("\n\n---\n\n");
        out.push_str(&docs);
    }
    out
}

// ------------------------------------------------------------------ engine

impl PhpEngine {
    /// Hover at `pos` in an open document. `None` when the engine doesn't
    /// hold the document or there is nothing to show there.
    pub fn hover(&self, doc: ide_core::DocId, pos: ide_core::Pos) -> Option<HoverInfo> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let here = FileSummary::extract(&parsed);
        let resolver = self.resolver();
        let offset = parsed.line_index().byte(pos);
        let found = self.at_caret(&parsed, &here, &resolver, offset)?;
        let markdown = match &found.subject {
            Subject::Variable { name, ty, .. } => render(None, &format!("{ty} ${name}"), None),
            Subject::Decls(decls) => self.describe(decls.first()?, &resolver, &path, &here)?,
        };
        Some(HoverInfo { markdown, range: found.range })
    }

    pub(crate) fn describe(
        &self,
        decl: &Decl,
        resolver: &Resolver<'_>,
        here: &Path,
        summary: &FileSummary,
    ) -> Option<String> {
        match decl {
            Decl::ClassLike(fqn) => {
                let class = summary.class_like(fqn).cloned().or_else(|| resolver.declarations().class_like(fqn))?;
                let mut code = String::new();
                let namespace = namespace_of(&class.fqn);
                if !namespace.is_empty() {
                    code.push_str(&format!("namespace {namespace};\n"));
                }
                code.push_str(&class_signature(&class));
                let path = self.class_path(&class, here, summary);
                let docs = path.and_then(|path| self.doc_text(&path, class.loc.start)).map(|doc| doc.markdown());
                Some(render(None, &code, docs))
            }
            Decl::Function(fqn) => {
                let (path, function) = self.function_source(fqn, here, summary)?;
                let params: Vec<String> = function.params.iter().map(param_text).collect();
                let returns = resolver.function_return(fqn).unwrap_or(Type::Mixed);
                let mut code = String::new();
                let namespace = namespace_of(&function.fqn);
                if !namespace.is_empty() {
                    code.push_str(&format!("namespace {namespace};\n"));
                }
                let by_ref = if function.by_ref_return { "&" } else { "" };
                code.push_str(&format!("function {by_ref}{}({}): {returns}", function.name, params.join(", ")));
                let docs = self.doc_text(&path, function.loc.start).map(|doc| doc.markdown());
                Some(render(None, &code, docs))
            }
            Decl::Constant(fqn) => {
                let constant = summary
                    .constants
                    .iter()
                    .find(|c| crate::names::fqn_eq(NameKind::Constant, &c.fqn, fqn))
                    .cloned()
                    .or_else(|| resolver.declarations().constant(fqn))?;
                let mut code = String::new();
                let namespace = namespace_of(&constant.fqn);
                if !namespace.is_empty() {
                    code.push_str(&format!("namespace {namespace};\n"));
                }
                code.push_str(&format!("const {} = {};", short_name(&constant.fqn), constant.value));
                let path = self.source_path(NameKind::Constant, &constant.fqn, constant.name_loc, here, summary);
                let docs = path.and_then(|path| self.doc_text(&path, constant.loc.start)).map(|doc| doc.markdown());
                Some(render(None, &code, docs))
            }
            Decl::Member(member) => {
                let info = member.info()?;
                let code = self.member_signature(member, resolver)?;
                let docs = self.member_doc(member, resolver, here, summary).map(|doc| doc.markdown());
                Some(render(Some(info.declaring.fqn.as_str()), &code, docs))
            }
            Decl::Parameter { owner, name } => {
                let (container, param, doc) = self.parameter_info(owner, name, resolver, here, summary)?;
                let docs = doc.and_then(|doc| doc.param(name));
                Some(render(Some(&container), &param, docs))
            }
        }
    }

    fn member_signature(&self, member: &Member, resolver: &Resolver<'_>) -> Option<String> {
        let name = &member.name;
        match member.kind {
            MemberKind::Method => {
                let method = member.model.method(name)?;
                let mut code = String::from(visibility(method.visibility));
                if method.is_abstract && method.declaring.kind != ClassKind::Interface {
                    code.push_str(" abstract");
                }
                if method.is_final {
                    code.push_str(" final");
                }
                if method.is_static {
                    code.push_str(" static");
                }
                let params = resolver.method_params_on(&member.receiver, name, &member.context).unwrap_or_default();
                let defaults: Vec<(String, String)> = match (method.declared(), method.magic()) {
                    (Some(declared), _) => {
                        declared.params.iter().filter_map(|p| Some((p.name.clone(), p.default.clone()?))).collect()
                    }
                    (None, Some(magic)) => {
                        magic.params.iter().filter_map(|p| Some((p.name.clone(), p.default.clone()?))).collect()
                    }
                    _ => Vec::new(),
                };
                let params: Vec<String> = params
                    .iter()
                    .map(|param| {
                        let default = defaults
                            .iter()
                            .find(|(name, _)| Some(name.as_str()) == param.name.as_deref())
                            .map(|(_, default)| default.as_str());
                        signature_param_text(param, default)
                    })
                    .collect();
                let by_ref = if method.declared().is_some_and(|m| m.by_ref_return) { "&" } else { "" };
                code.push_str(&format!(" function {by_ref}{}({}): {}", method.name, params.join(", "), member.ty));
                Some(code)
            }
            MemberKind::Property => {
                let property = member.model.property(name)?;
                let mut code = String::from(visibility(property.visibility));
                if property.is_static {
                    code.push_str(" static");
                }
                if property.is_readonly {
                    code.push_str(" readonly");
                }
                code.push_str(&format!(" {} ${}", member.ty, property.name));
                Some(code)
            }
            MemberKind::Constant => {
                let constant = member.model.constant(name)?;
                if let Some(case) = constant.case() {
                    return Some(match &case.value {
                        Some(value) => format!("case {} = {value};", case.name),
                        None => format!("case {};", case.name),
                    });
                }
                let declared = constant.declared()?;
                let mut code = String::from(visibility(declared.visibility));
                if declared.is_final {
                    code.push_str(" final");
                }
                code.push_str(" const ");
                if let Some(hint) = &declared.type_hint {
                    code.push_str(&format!("{hint} "));
                }
                code.push_str(&format!("{} = {};", declared.name, declared.value));
                Some(code)
            }
        }
    }

    /// A member's docblock, or the one it inherits.
    fn member_doc(
        &self,
        member: &Member,
        resolver: &Resolver<'_>,
        here: &Path,
        summary: &FileSummary,
    ) -> Option<DocText> {
        let mut model = member.model.clone();
        let mut own: Option<DocText> = None;
        for _ in 0..MAX_INHERITED {
            let (info, start) = match member.kind {
                MemberKind::Method => {
                    let method = model.method(&member.name)?;
                    (method.info.clone(), method.declared().map(|m| m.loc.start))
                }
                MemberKind::Property => {
                    let property = model.property(&member.name)?;
                    (property.info.clone(), property.declared().map(|p| p.loc.start))
                }
                MemberKind::Constant => {
                    let constant = model.constant(&member.name)?;
                    let start =
                        constant.declared().map(|c| c.loc.start).or_else(|| constant.case().map(|c| c.loc.start));
                    (constant.info.clone(), start)
                }
            };
            let doc = start.and_then(|start| {
                let path = self.class_path(&info.declaring, here, summary)?;
                self.doc_text(&path, start)
            });
            match (own.take(), doc) {
                (None, Some(doc)) if !doc.only_inherits() => {
                    if !doc.description.to_ascii_lowercase().contains("{@inheritdoc}") {
                        return Some(doc);
                    }
                    own = Some(doc);
                }
                (Some(mut partial), Some(doc)) if !doc.only_inherits() => {
                    // An inline `{@inheritDoc}`: the parent's description
                    // in its place.
                    partial.description = replace_inherit(&partial.description, &doc.description);
                    if !partial.description.to_ascii_lowercase().contains("{@inheritdoc}") {
                        return Some(partial);
                    }
                    own = Some(partial);
                }
                (kept, _) => own = kept,
            }
            let parent = info.overrides.clone()?;
            model = resolver.class_model(&parent)?;
        }
        own
    }

    /// `(container, the parameter as code, the owner's docblock)`.
    fn parameter_info(
        &self,
        owner: &Decl,
        name: &str,
        resolver: &Resolver<'_>,
        here: &Path,
        summary: &FileSummary,
    ) -> Option<(String, String, Option<DocText>)> {
        match owner {
            Decl::Function(fqn) => {
                let (path, function) = self.function_source(fqn, here, summary)?;
                let doc = function.doc.as_deref();
                let templates: Vec<&str> = doc.iter().flat_map(|doc| doc.local_type_names()).collect();
                let params = crate::types::resolve::declared_params(&function.params, doc, &templates);
                let param = params.iter().find(|p| p.name.as_deref() == Some(name))?;
                let default = function.params.iter().find(|p| p.name == name).and_then(|p| p.default.as_deref());
                let docs = self.doc_text(&path, function.loc.start);
                Some((format!("{}()", function.fqn), signature_param_text(param, default), docs))
            }
            Decl::Member(member) if member.kind == MemberKind::Method => {
                let method = member.model.method(&member.name)?;
                let params = resolver.method_params_on(&member.receiver, &member.name, &member.context)?;
                let param = params.iter().find(|p| p.name.as_deref() == Some(name))?;
                let declared = method.declared();
                let default =
                    declared.and_then(|m| m.params.iter().find(|p| p.name == name)).and_then(|p| p.default.as_deref());
                let docs = self.member_doc(member, resolver, here, summary);
                let container = format!("{}::{}()", method.declaring.fqn, method.name);
                Some((container, signature_param_text(param, default), docs))
            }
            _ => None,
        }
    }

    /// The docblock in front of byte `start` of the file at `path`.
    fn doc_text(&self, path: &Path, start: u32) -> Option<DocText> {
        let text = file_text(self, path)?;
        doc_comment_before(&text, start).map(DocText::parse)
    }

    /// Goto type definition at `pos`: the class-likes of the type of what
    /// the caret is on (a variable's type, a member's or function's type, a
    /// class name itself). `None` when the engine doesn't hold the document
    /// or the caret is on nothing it knows.
    pub fn type_definition(&self, doc: ide_core::DocId, pos: ide_core::Pos) -> Option<Vec<super::Target>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let here = FileSummary::extract(&parsed);
        let resolver = self.resolver();
        let offset = parsed.line_index().byte(pos);
        let found = self.at_caret(&parsed, &here, &resolver, offset)?;
        let ty = match &found.subject {
            Subject::Variable { ty, .. } => ty.clone(),
            Subject::Decls(decls) => match decls.first() {
                None => return Some(Vec::new()),
                Some(Decl::ClassLike(fqn)) => Type::named(fqn),
                Some(Decl::Function(fqn)) => resolver.function_return(fqn).unwrap_or(Type::Mixed),
                Some(Decl::Constant(fqn)) => resolver.constant_type(fqn).unwrap_or(Type::Mixed),
                Some(Decl::Member(member)) => member.ty.clone(),
                Some(Decl::Parameter { owner, name }) => {
                    self.parameter_type(owner, name, &resolver, &path, &here).unwrap_or(Type::Mixed)
                }
            },
        };
        let mut out: Vec<super::Target> = Vec::new();
        for model in resolver.class_models(&ty, &found.context) {
            for target in self.declarations_of(NameKind::ClassLike, model.fqn(), &path, &here) {
                if !out.contains(&target) {
                    out.push(target);
                }
            }
        }
        Some(out)
    }

    fn parameter_type(
        &self,
        owner: &Decl,
        name: &str,
        resolver: &Resolver<'_>,
        here: &Path,
        summary: &FileSummary,
    ) -> Option<Type> {
        match owner {
            Decl::Function(fqn) => {
                let (_, function) = self.function_source(fqn, here, summary)?;
                let doc = function.doc.as_deref();
                let templates: Vec<&str> = doc.iter().flat_map(|doc| doc.local_type_names()).collect();
                let params = crate::types::resolve::declared_params(&function.params, doc, &templates);
                params.into_iter().find(|p| p.name.as_deref() == Some(name)).map(|p| p.ty)
            }
            Decl::Member(member) => resolver
                .method_params_on(&member.receiver, &member.name, &member.context)?
                .into_iter()
                .find(|p| p.name.as_deref() == Some(name))
                .map(|p| p.ty),
            _ => None,
        }
    }
}

fn replace_inherit(description: &str, inherited: &str) -> String {
    let lower = description.to_ascii_lowercase();
    match lower.find("{@inheritdoc}") {
        Some(at) => format!("{}{}{}", &description[..at], inherited, &description[at + "{@inheritdoc}".len()..]),
        None => description.to_owned(),
    }
}
