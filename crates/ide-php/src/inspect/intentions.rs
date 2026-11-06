//! Context actions on a function or method declaration (kind
//! `refactor.rewrite`), offered when the range touches its signature:
//!
//! - **Add return type** `: T` after the parameter list when there is none:
//!   the `@return` type, else the type inferred from the body's `return`
//!   statements (`void` without any); not for constructors, destructors and
//!   `__clone`.
//! - **Add parameter type** before a parameter without one (the range on
//!   the parameter): its `@param` type, else its default value's type
//!   (nullable for a `null` default).
//! - **Add PHPDoc** when the declaration has no docblock: `@param` for each
//!   parameter (the declared type, else the one above, else `mixed`) and
//!   `@return` unless it is `void`. **Update PHPDoc** when it has one that
//!   misses parameters: their `@param` lines, before `@return`/`@throws`.
//!
//! Types are only added when PHP can declare them at the project's language
//! level (`?T` from 7.1, unions and `static` from 8.0, …); class names are
//! written as the file's imports and namespace read them. IntelliJ documents
//! the same actions for PHP ("Add return type", "Add parameter type",
//! "Generate PHPDoc", "Update PHPDoc comment"); the rules are our own.

use std::path::Path;

use ide_core::TextEdit;
use mago_span::HasSpan;
use mago_syntax::cst::{
    Expression, Function, FunctionLikeParameterList, Literal, Method, MethodBody, TriviaKind, UnaryPrefixOperator,
};
use mago_syntax::walker::Walker;

use super::fixes::{doc_type, is_null, line_indent, line_start, native_type, newline, starts_line};
use crate::engine::PhpEngine;
use crate::imports::{ImportAction, REWRITE, file_edit};
use crate::names::FileNames;
use crate::navigate::enclosing_class;
use crate::summary::{ClassLike, DocBlock, FileSummary, Param};
use crate::syntax::ParsedFile;
use crate::types::{Context, LazyType, Type};

/// A function or method declaration as written.
struct Signature {
    /// The declaration's first byte (attributes and modifiers included).
    start: u32,
    /// Where the body (or the `;` of an abstract method) starts.
    header_end: u32,
    name_start: u32,
    /// Lower-case.
    name: String,
    /// The byte after `)`.
    params_end: u32,
    has_return: bool,
    is_method: bool,
    params: Vec<SignatureParam>,
}

struct SignatureParam {
    start: u32,
    end: u32,
    /// Without `$`.
    name: String,
    has_hint: bool,
    /// Where a type goes: before `&`, `...` or the variable.
    type_at: u32,
    /// The default value's type, `Null` for `null`.
    default: Option<Type>,
}

#[derive(Default)]
struct Signatures(Vec<Signature>);

struct SignatureWalker;

impl<'a> Walker<'a, 'a, Signatures> for SignatureWalker {
    fn walk_in_function(&self, node: &'a Function<'a>, out: &mut Signatures) {
        out.0.push(signature(
            node.span().start.offset,
            node.body.left_brace.start.offset,
            node.name.span.start.offset,
            node.name.value,
            &node.parameter_list,
            node.return_type_hint.is_some(),
            false,
        ));
    }

    fn walk_in_method(&self, node: &'a Method<'a>, out: &mut Signatures) {
        let header_end = match &node.body {
            MethodBody::Concrete(block) => block.left_brace.start.offset,
            MethodBody::Abstract(body) => body.span().start.offset,
        };
        out.0.push(signature(
            node.span().start.offset,
            header_end,
            node.name.span.start.offset,
            node.name.value,
            &node.parameter_list,
            node.return_type_hint.is_some(),
            true,
        ));
    }
}

fn signature(
    start: u32,
    header_end: u32,
    name_start: u32,
    name: &[u8],
    list: &FunctionLikeParameterList<'_>,
    has_return: bool,
    is_method: bool,
) -> Signature {
    let params = list
        .parameters
        .iter()
        .map(|p| {
            let type_at = [p.ampersand, p.ellipsis, Some(p.variable.span)]
                .into_iter()
                .flatten()
                .map(|span| span.start.offset)
                .min()
                .unwrap_or(p.variable.span.start.offset);
            SignatureParam {
                start: p.span().start.offset,
                end: p.span().end.offset,
                name: String::from_utf8_lossy(p.variable.name.strip_prefix(b"$").unwrap_or(p.variable.name)).into(),
                has_hint: p.hint.is_some(),
                type_at,
                default: p.default_value.as_ref().and_then(|d| literal_type(d.value)),
            }
        })
        .collect();
    Signature {
        start,
        header_end,
        name_start,
        name: String::from_utf8_lossy(name).to_ascii_lowercase(),
        params_end: list.right_parenthesis.end.offset,
        has_return,
        is_method,
        params,
    }
}

/// The type of a literal default value.
fn literal_type(expr: &Expression<'_>) -> Option<Type> {
    if is_null(expr) {
        return Some(Type::Null);
    }
    match expr {
        Expression::Literal(Literal::Integer(_)) => Some(Type::Int),
        Expression::Literal(Literal::Float(_)) => Some(Type::Float),
        Expression::Literal(Literal::String(_)) => Some(Type::string()),
        Expression::Literal(Literal::True(_) | Literal::False(_)) => Some(Type::Bool),
        Expression::Array(_) | Expression::LegacyArray(_) => Some(Type::array()),
        Expression::ConstantAccess(access)
            if ["true", "false"].iter().any(|b| access.name.value().eq_ignore_ascii_case(b.as_bytes())) =>
        {
            Some(Type::Bool)
        }
        Expression::UnaryPrefix(unary)
            if matches!(unary.operator, UnaryPrefixOperator::Negation(_) | UnaryPrefixOperator::Plus(_)) =>
        {
            literal_type(unary.operand).filter(|ty| matches!(ty, Type::Int | Type::Float))
        }
        _ => None,
    }
}

/// What the summary knows of a declaration.
struct Declared<'s> {
    class: Option<&'s ClassLike>,
    params: &'s [Param],
    return_hint: bool,
    inferred: Option<&'s LazyType>,
    doc: Option<&'s DocBlock>,
}

fn declared<'s>(summary: &'s FileSummary, signature: &Signature) -> Option<Declared<'s>> {
    if signature.is_method {
        let class = enclosing_class(summary, signature.name_start)?;
        let method = class.methods.iter().find(|m| m.name_loc.start == signature.name_start)?;
        Some(Declared {
            class: Some(class),
            params: &method.params,
            return_hint: method.return_type.is_some(),
            inferred: method.inferred_return.as_ref(),
            doc: method.doc.as_deref(),
        })
    } else {
        let function = summary.functions.iter().find(|f| f.name_loc.start == signature.name_start)?;
        Some(Declared {
            class: None,
            params: &function.params,
            return_hint: function.return_type.is_some(),
            inferred: function.inferred_return.as_ref(),
            doc: function.doc.as_deref(),
        })
    }
}

impl Declared<'_> {
    fn templates(&self) -> Vec<&str> {
        let own = self.doc.into_iter().flat_map(|doc| doc.local_type_names());
        let class =
            self.class.and_then(|class| class.doc.as_deref()).into_iter().flat_map(|doc| doc.local_type_names());
        own.chain(class).collect()
    }

    fn context(&self) -> Context {
        self.class.map(|class| Context::in_class(&class.fqn)).unwrap_or_default()
    }

    /// The documented, else declared, else inferred return type.
    fn return_type(&self, engine: &PhpEngine) -> Option<Type> {
        if let Some(ty) = self.doc.and_then(|doc| doc.return_type.as_ref()) {
            return Some(Type::from_doc(ty, &self.templates()));
        }
        let lazy = self.inferred?;
        Some(engine.resolver().resolve(lazy, &self.context()).widen())
    }

    /// A parameter's documented type, else its default value's.
    fn param_type(&self, param: &SignatureParam) -> Option<Type> {
        let documented = self
            .doc
            .and_then(|doc| doc.params.iter().find(|p| p.name == param.name))
            .map(|p| Type::from_doc(&p.ty, &self.templates()));
        let ty = match (documented, &param.default) {
            (Some(ty), _) => ty,
            (None, Some(Type::Null) | None) => return None,
            (None, Some(ty)) => ty.clone(),
        };
        if matches!(ty, Type::Mixed) {
            return None;
        }
        Some(if param.default == Some(Type::Null) { ty.nullable() } else { ty })
    }
}

fn is_special(name: &str) -> bool {
    matches!(name, "__construct" | "__destruct" | "__clone")
}

/// The docblock right in front of byte `at` (only blank space between).
fn docblock_before(parsed: &ParsedFile, at: u32) -> Option<(u32, u32)> {
    let text = parsed.text();
    parsed
        .program()
        .trivia
        .iter()
        .rev()
        .find(|t| t.span.end.offset <= at && t.kind != TriviaKind::WhiteSpace)
        .filter(|t| {
            t.kind == TriviaKind::DocBlockComment && text[t.span.end.offset as usize..at as usize].trim().is_empty()
        })
        .map(|t| (t.span.start.offset, t.span.end.offset))
}

/// The context actions for bytes `start..end` of an open document.
pub(crate) fn intentions(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    path: &Path,
    start: u32,
    end: u32,
) -> Vec<ImportAction> {
    let mut signatures = Signatures::default();
    SignatureWalker.walk_program(parsed.program(), &mut signatures);
    let Some(signature) =
        signatures.0.iter().filter(|s| s.start <= end && start <= s.header_end).min_by_key(|s| s.header_end - s.start)
    else {
        return Vec::new();
    };
    let summary = FileSummary::extract(parsed);
    if summary.has_errors {
        return Vec::new();
    }
    let Some(declared) = declared(&summary, signature) else { return Vec::new() };
    let text = parsed.text();
    let names = FileNames::resolve(parsed);
    let scope = names.scope_at(signature.start);
    let level = engine.language_level();
    let index = parsed.line_index();
    let action = |title: String, at: u32, to: u32, new_text: String| ImportAction {
        title,
        kind: REWRITE,
        preferred: false,
        edit: file_edit(path, vec![TextEdit { range: index.range(at, to), new_text }]),
    };
    let mut out = Vec::new();
    let return_type = if is_special(&signature.name) { None } else { declared.return_type(engine) };

    // Return type.
    if !signature.has_return
        && let Some(ty) = &return_type
        && let Some(native) = native_type(ty, scope, level)
    {
        let at = signature.params_end;
        out.push(action(format!("Add return type '{native}'"), at, at, format!(": {native}")));
    }

    // Parameter types.
    for param in &signature.params {
        if param.has_hint || param.end < start || param.start > end {
            continue;
        }
        if let Some(native) = declared.param_type(param).and_then(|ty| native_type(&ty, scope, level)) {
            out.push(action(
                format!("Add type '{native}' to parameter '${}'", param.name),
                param.type_at,
                param.type_at,
                format!("{native} "),
            ));
        }
    }

    // PHPDoc.
    let nl = newline(text);
    let param_line = |param: &SignatureParam, declared_param: Option<&Param>| {
        let ty = declared_param
            .and_then(|p| p.type_hint.as_ref())
            .map(Type::from_hint)
            .or_else(|| declared.param_type(param))
            .map_or_else(|| "mixed".to_owned(), |ty| doc_type(&ty, scope));
        let dots = if declared_param.is_some_and(|p| p.variadic) { "..." } else { "" };
        format!("@param {ty} {dots}${}", param.name)
    };
    let declared_param = |name: &str| declared.params.iter().find(|p| p.name.trim_start_matches('$') == name);
    match docblock_before(parsed, signature.start) {
        None if starts_line(text, signature.start) => {
            let mut lines: Vec<String> =
                signature.params.iter().map(|p| param_line(p, declared_param(&p.name))).collect();
            if !is_special(&signature.name) {
                let ty = if declared.return_hint {
                    summary_return_hint(&summary, signature).map(Type::from_hint).or(return_type.clone())
                } else {
                    return_type.clone()
                };
                if let Some(ty) = ty.filter(|ty| !matches!(ty, Type::Void | Type::Mixed)) {
                    lines.push(format!("@return {}", doc_type(&ty, scope)));
                }
            }
            if !lines.is_empty() {
                let indent = line_indent(text, signature.start);
                let mut doc = format!("/**{nl}");
                for line in &lines {
                    doc.push_str(&format!("{indent} * {line}{nl}"));
                }
                doc.push_str(&format!("{indent} */{nl}{indent}"));
                out.push(action("Add PHPDoc".into(), signature.start, signature.start, doc));
            }
        }
        None => {}
        Some((doc_start, doc_end)) => {
            let documented: Vec<&str> =
                declared.doc.map(|doc| doc.params.iter().map(|p| p.name.as_str()).collect()).unwrap_or_default();
            let lines: Vec<String> = signature
                .params
                .iter()
                .filter(|p| !documented.contains(&p.name.as_str()))
                .map(|p| param_line(p, declared_param(&p.name)))
                .collect();
            if !lines.is_empty() {
                let (at, to, new_text) = insert_params(text, doc_start, doc_end, &lines, nl);
                out.push(action("Update PHPDoc".into(), at, to, new_text));
            }
        }
    }
    out
}

fn summary_return_hint<'s>(summary: &'s FileSummary, signature: &Signature) -> Option<&'s crate::summary::TypeHint> {
    if signature.is_method {
        let class = enclosing_class(summary, signature.name_start)?;
        class.methods.iter().find(|m| m.name_loc.start == signature.name_start)?.return_type.as_ref()
    } else {
        summary.functions.iter().find(|f| f.name_loc.start == signature.name_start)?.return_type.as_ref()
    }
}

/// The edit adding `@param` lines to the docblock at `start..end`: before
/// its first `@return` or `@throws` line, else at its end.
fn insert_params(text: &str, start: u32, end: u32, lines: &[String], nl: &str) -> (u32, u32, String) {
    let comment = &text[start as usize..end as usize];
    let mut offset = 0;
    for line in comment.split_inclusive('\n') {
        let body = line.trim_start_matches([' ', '\t']).trim_start_matches('*').trim_start_matches([' ', '\t']);
        if offset > 0 && (body.starts_with("@return") || body.starts_with("@throws")) {
            let at = start + offset as u32;
            let prefix = &line[..line.len() - body.len()];
            let new_text: String = lines.iter().map(|l| format!("{prefix}{l}{nl}")).collect();
            debug_assert_eq!(line_start(text, at), at);
            return (at, at, new_text);
        }
        offset += line.len();
    }
    super::fixes::add_doc_lines(text, start, end, lines, nl)
}
