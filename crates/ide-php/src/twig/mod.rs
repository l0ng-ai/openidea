//! Twig templates: the structure outline, completion of variables, tags,
//! filters, functions, tests and template names, and goto definition of the
//! templates `{% extends %}`, `{% include %}`, `{% embed %}`, `{% import %}`,
//! `{% from %}`, `{% use %}` and the `include()`/`source()` functions name.
//!
//! Templates are parsed with `mago-twig-syntax` (Twig 3), after the repairs
//! of [`recover`] so that broken templates keep their structure; completion
//! also blanks the tag being typed. Everything here is a pure
//! function of the template text, so `ide-host` serves it for open documents
//! without the PHP engine running. Positions are 0-based lines and UTF-16
//! columns, like the rest of the crate.

pub mod builtins;
mod complete;
mod recover;
pub mod templates;
#[cfg(test)]
mod tests;

use std::path::PathBuf;

use ide_core::{OutlineItem, Pos, Range, SymbolKind};
use mago_allocator::LocalArena;
use mago_database::file::FileId;
use mago_span::{HasSpan, Span};
use mago_twig_syntax::cst::{
    Argument, ArrayElement, BlockBody, Call, Embed, Expression, Extends, From, Import, Include, Sequence, SetBody,
    Statement, Template, Use,
};
use mago_twig_syntax::parser::parse_file_content;
use mago_twig_syntax::walker::Walker;

use crate::syntax::LineIndex;

pub use complete::{TwigCompletion, TwigCompletionKind, completions};
pub use templates::TemplatePaths;

/// Parses `text` (repaired by [`recover::recovered`]) and hands the text
/// parsed and the template to `f`. Offsets in the template are offsets in
/// `text`; the repaired text may have end tags appended after its end.
fn with_template<R>(text: &str, f: impl for<'a> FnOnce(&'a str, &'a Template<'a>) -> R) -> R {
    let text = recover::recovered(text);
    let arena = LocalArena::new();
    let template = parse_file_content(&arena, FileId::zero(), text.as_bytes());
    f(&text, template)
}

fn utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The range of `span`, cut at the end of the text (spans can end in end
/// tags the recovery appended).
fn span_range(index: &LineIndex, span: Span) -> Range {
    index.range(span.start.offset.min(index.len()), span.end.offset.min(index.len()))
}

fn contains(span: Span, offset: u32) -> bool {
    span.start.offset <= offset && offset <= span.end.offset
}

/// The content of a string literal (its quotes removed) and the byte range
/// of that content.
fn string_content(raw: &[u8], span: Span) -> (String, u32, u32) {
    let quoted = raw.len() >= 2 && matches!(raw[0], b'\'' | b'"') && raw[raw.len() - 1] == raw[0];
    if quoted {
        (utf8(&raw[1..raw.len() - 1]), span.start.offset + 1, span.end.offset - 1)
    } else {
        (utf8(raw), span.start.offset, span.end.offset)
    }
}

/// How an outline shows a template expression: the name of a literal, the
/// source of anything else.
fn template_label(text: &str, expression: &Expression<'_>) -> String {
    match expression {
        Expression::String(s) => string_content(s.raw, s.span).0,
        other => {
            let span = other.span();
            text.get(span.start.offset as usize..span.end.offset as usize).unwrap_or_default().to_string()
        }
    }
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

/// The Structure view of a template: the parent template, imported macros,
/// blocks (nested as written), macros, embeds and `set` variables.
pub fn outline(text: &str) -> Vec<OutlineItem> {
    let index = LineIndex::new(text);
    with_template(text, |text, template| {
        let mut out = Vec::new();
        outline_statements(text, &index, &template.statements, &mut out);
        out
    })
}

fn item(name: String, detail: Option<String>, kind: SymbolKind, range: Range, selection: Range) -> OutlineItem {
    OutlineItem { name, detail, kind, range, selection_range: selection, children: Vec::new(), visibility: None }
}

fn outline_statements(
    text: &str,
    index: &LineIndex,
    statements: &Sequence<'_, Statement<'_>>,
    out: &mut Vec<OutlineItem>,
) {
    for statement in statements.iter() {
        let range = span_range(index, statement.span());
        match statement {
            Statement::Extends(n) => out.push(item(
                template_label(text, &n.template),
                Some("extends".into()),
                SymbolKind::File,
                range,
                span_range(index, n.template.span()),
            )),
            Statement::Use(n) => out.push(item(
                template_label(text, &n.template),
                Some("use".into()),
                SymbolKind::File,
                range,
                span_range(index, n.template.span()),
            )),
            Statement::Import(n) => out.push(item(
                utf8(n.alias.value),
                Some(template_label(text, &n.template)),
                SymbolKind::Namespace,
                range,
                span_range(index, n.alias.span),
            )),
            Statement::From(n) => {
                let from = template_label(text, &n.template);
                for imported in n.names.iter() {
                    let name = imported.to.unwrap_or(imported.from);
                    out.push(item(
                        utf8(name.value),
                        Some(from.clone()),
                        SymbolKind::Function,
                        range,
                        span_range(index, name.span),
                    ));
                }
            }
            Statement::Block(n) => {
                let mut block =
                    item(utf8(n.name.value), None, SymbolKind::Module, range, span_range(index, n.name.span));
                if let BlockBody::Long(long) = &n.body {
                    outline_statements(text, index, &long.body, &mut block.children);
                }
                out.push(block);
            }
            Statement::Macro(n) => {
                let arguments: Vec<String> = n.arguments.iter().map(|a| utf8(a.name.value)).collect();
                out.push(item(
                    utf8(n.name.value),
                    Some(format!("({})", arguments.join(", "))),
                    SymbolKind::Function,
                    range,
                    span_range(index, n.name.span),
                ));
            }
            Statement::Embed(n) => {
                let mut embed = item(
                    template_label(text, &n.template),
                    Some("embed".into()),
                    SymbolKind::File,
                    range,
                    span_range(index, n.template.span()),
                );
                outline_statements(text, index, &n.body, &mut embed.children);
                out.push(embed);
            }
            Statement::Set(n) => {
                for name in n.names.iter() {
                    out.push(item(utf8(name.value), None, SymbolKind::Variable, range, span_range(index, name.span)));
                }
                if let SetBody::Capture(capture) = &n.body {
                    outline_statements(text, index, &capture.body, out);
                }
            }
            Statement::If(n) => {
                for branch in n.branches.iter() {
                    outline_statements(text, index, &branch.body, out);
                }
                if let Some(branch) = &n.else_branch {
                    outline_statements(text, index, &branch.body, out);
                }
            }
            Statement::For(n) => {
                outline_statements(text, index, &n.body, out);
                if let Some(branch) = &n.else_branch {
                    outline_statements(text, index, &branch.body, out);
                }
            }
            Statement::With(n) => outline_statements(text, index, &n.body, out),
            Statement::Apply(n) => outline_statements(text, index, &n.body, out),
            Statement::Autoescape(n) => outline_statements(text, index, &n.body, out),
            Statement::Sandbox(n) => outline_statements(text, index, &n.body, out),
            Statement::Guard(n) => outline_statements(text, index, &n.body, out),
            Statement::Cache(n) => outline_statements(text, index, &n.body, out),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Template references
// ---------------------------------------------------------------------------

/// A template name written as a string literal where Twig loads a template.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplateRef {
    pub name: String,
    /// The string's content, without the quotes.
    pub range: Range,
}

/// Every template name the template refers to, in source order.
pub fn template_refs(text: &str) -> Vec<TemplateRef> {
    let index = LineIndex::new(text);
    let mut refs = with_template(text, |_, template| {
        let mut refs = Vec::new();
        RefCollector.walk_template(template, &mut refs);
        refs
    });
    refs.sort_by_key(|(start, _, _)| *start);
    refs.into_iter()
        .filter(|(_, end, _)| *end <= index.len())
        .map(|(start, end, name)| TemplateRef { name, range: index.range(start, end) })
        .collect()
}

/// The template name at `pos`, if the caret is on one.
pub fn template_at(text: &str, pos: Pos) -> Option<TemplateRef> {
    template_refs(text).into_iter().find(|r| r.range.start <= pos && pos <= r.range.end)
}

/// Goto definition: the file of the template named at `pos`, with the range
/// of the name (the origin).
pub fn goto_template(text: &str, pos: Pos, paths: &TemplatePaths) -> Option<(PathBuf, Range)> {
    let found = template_at(text, pos)?;
    Some((paths.resolve(&found.name)?, found.range))
}

/// Byte start, byte end and content of each template string.
type Refs = Vec<(u32, u32, String)>;

struct RefCollector;

/// The string literals of a template expression: a literal, the items of a
/// sequence (`{% extends ['a.twig', 'b.twig'] %}`), both branches of a
/// conditional, or a parenthesized one.
fn template_strings(expression: &Expression<'_>, out: &mut Refs) {
    match expression {
        Expression::String(s) => out.push({
            let (name, start, end) = string_content(s.raw, s.span);
            (start, end, name)
        }),
        Expression::Array(array) => {
            for element in array.elements.iter() {
                if let ArrayElement::Value(value) = element {
                    template_strings(value.value, out);
                }
            }
        }
        Expression::Conditional(conditional) => {
            if let Some(then) = conditional.then {
                template_strings(then, out);
            }
            if let Some(otherwise) = conditional.r#else {
                template_strings(otherwise, out);
            }
        }
        Expression::Parenthesized(inner) => template_strings(inner.inner, out),
        _ => {}
    }
}

impl<'ast, 'arena> Walker<'ast, 'arena, Refs> for RefCollector {
    fn walk_in_extends(&self, node: &'ast Extends<'arena>, refs: &mut Refs) {
        template_strings(&node.template, refs);
    }

    fn walk_in_use(&self, node: &'ast Use<'arena>, refs: &mut Refs) {
        template_strings(&node.template, refs);
    }

    fn walk_in_include(&self, node: &'ast Include<'arena>, refs: &mut Refs) {
        template_strings(&node.template, refs);
    }

    fn walk_in_embed(&self, node: &'ast Embed<'arena>, refs: &mut Refs) {
        template_strings(&node.template, refs);
    }

    fn walk_in_import(&self, node: &'ast Import<'arena>, refs: &mut Refs) {
        template_strings(&node.template, refs);
    }

    fn walk_in_from(&self, node: &'ast From<'arena>, refs: &mut Refs) {
        template_strings(&node.template, refs);
    }

    /// `include('x.twig')`, `source('x.twig')`: the first positional argument
    /// (or the `template`/`name` named one).
    fn walk_in_call(&self, node: &'ast Call<'arena>, refs: &mut Refs) {
        let Expression::Name(callee) = node.callee else { return };
        if !matches!(callee.name, b"include" | b"source") {
            return;
        }
        let first = node.argument_list.arguments.iter().find_map(|argument| match argument {
            Argument::Positional(positional) if positional.ellipsis.is_none() => Some(positional.value),
            Argument::Named(named) if matches!(named.name.value, b"template" | b"name") => Some(named.value),
            _ => None,
        });
        if let Some(first) = first {
            template_strings(first, refs);
        }
    }
}

// ---------------------------------------------------------------------------
// Names in scope
// ---------------------------------------------------------------------------

/// What a name in scope at the caret is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScopeKind {
    /// `{% set %}`, a `for` target, a macro argument.
    Variable,
    /// `loop` in a `for` body.
    Loop,
    /// The alias of `{% import 'x' as forms %}`.
    MacroNamespace,
    /// A macro imported with `{% from %}`, or defined in this template.
    Macro,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScopeName {
    pub name: String,
    pub kind: ScopeKind,
    pub detail: Option<String>,
}

/// The names visible at byte `offset`: template-level `set`s and imports,
/// and the `for` targets, macro arguments and `set`s of the bodies around
/// the offset. The template's own macros are listed too (called through
/// `_self`, but completed by name).
pub(crate) fn scope_names(text: &str, template: &Template<'_>, offset: u32) -> Vec<ScopeName> {
    let mut out = Vec::new();
    scope_statements(text, &template.statements, offset, &mut out);
    out
}

fn push(out: &mut Vec<ScopeName>, name: &[u8], kind: ScopeKind, detail: Option<String>) {
    let name = utf8(name);
    if !out.iter().any(|n| n.name == name) {
        out.push(ScopeName { name, kind, detail });
    }
}

fn scope_statements(text: &str, statements: &Sequence<'_, Statement<'_>>, offset: u32, out: &mut Vec<ScopeName>) {
    for statement in statements.iter() {
        let inside = contains(statement.span(), offset);
        match statement {
            Statement::Set(n) => {
                for name in n.names.iter() {
                    push(out, name.value, ScopeKind::Variable, None);
                }
                if let SetBody::Capture(capture) = &n.body
                    && inside
                {
                    scope_statements(text, &capture.body, offset, out);
                }
            }
            Statement::Import(n) => {
                push(out, n.alias.value, ScopeKind::MacroNamespace, Some(template_label(text, &n.template)))
            }
            Statement::From(n) => {
                let from = template_label(text, &n.template);
                for imported in n.names.iter() {
                    let name = imported.to.unwrap_or(imported.from);
                    push(out, name.value, ScopeKind::Macro, Some(from.clone()));
                }
            }
            Statement::Macro(n) => {
                let arguments: Vec<String> = n.arguments.iter().map(|a| utf8(a.name.value)).collect();
                push(out, n.name.value, ScopeKind::Macro, Some(format!("({})", arguments.join(", "))));
                if inside {
                    for argument in n.arguments.iter() {
                        push(out, argument.name.value, ScopeKind::Variable, None);
                    }
                    scope_statements(text, &n.body, offset, out);
                }
            }
            Statement::For(n) => {
                // The loop body runs from the opening tag to `{% else %}` or `{% endfor %}`.
                let body_end = n.else_branch.as_ref().map_or(n.end_open_tag, |branch| branch.open_tag);
                if n.close_tag.end.offset <= offset && offset <= body_end.start.offset {
                    for target in n.targets.iter() {
                        push(out, target.value, ScopeKind::Variable, None);
                    }
                    push(out, b"loop", ScopeKind::Loop, None);
                    scope_statements(text, &n.body, offset, out);
                } else if let Some(branch) = &n.else_branch
                    && inside
                {
                    scope_statements(text, &branch.body, offset, out);
                }
            }
            Statement::Block(n) => {
                if let BlockBody::Long(long) = &n.body
                    && inside
                {
                    scope_statements(text, &long.body, offset, out);
                }
            }
            Statement::If(n) => {
                for branch in n.branches.iter() {
                    scope_statements(text, &branch.body, offset, out);
                }
                if let Some(branch) = &n.else_branch {
                    scope_statements(text, &branch.body, offset, out);
                }
            }
            Statement::With(n) if inside => scope_statements(text, &n.body, offset, out),
            Statement::Embed(n) if inside => scope_statements(text, &n.body, offset, out),
            Statement::Apply(n) => scope_statements(text, &n.body, offset, out),
            Statement::Autoescape(n) => scope_statements(text, &n.body, offset, out),
            Statement::Sandbox(n) => scope_statements(text, &n.body, offset, out),
            Statement::Guard(n) => scope_statements(text, &n.body, offset, out),
            Statement::Cache(n) => scope_statements(text, &n.body, offset, out),
            _ => {}
        }
    }
}
