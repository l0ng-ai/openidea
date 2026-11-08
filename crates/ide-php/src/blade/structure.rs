//! The layout structure of a template: the sections and stacks it names,
//! the view it extends, its `@props`, and the sections and stacks it leaves
//! open. Follows Laravel's documentation on layouts and stacks (and the
//! `ManagesLayouts`/`ManagesStacks` concerns, MIT).
//!
//! - A **section** is filled with `@section('name')` and shown in the
//!   layout with `@yield('name')` (or a `@section … @show` block, which does
//!   both); `@hasSection`/`@sectionMissing` test for it.
//! - A **stack** is filled with `@push`/`@prepend` (`@pushOnce`,
//!   `@prependOnce`, and `@pushIf($condition, 'name')`) and shown with
//!   `@stack('name')`.

use std::ops::Range as Span;

use ide_core::{Diagnostic, Range, Severity};

use super::{NodeKind, parse_with, string_args};
use crate::syntax::LineIndex;

/// The source of the template's own diagnostics.
pub const DIAGNOSTIC_SOURCE: &str = "blade";

/// What a [`Name`] names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NameKind {
    Section,
    Stack,
}

/// What a template does with a [`Name`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NameRole {
    /// Fills it: `@section`, `@push` and the like.
    Fill,
    /// Shows or tests it: `@yield`, `@hasSection`, `@sectionMissing`,
    /// `@stack`.
    Show,
}

/// A section or stack name in a directive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name {
    pub kind: NameKind,
    pub role: NameRole,
    pub name: String,
    /// The string's content, without the quotes.
    pub span: Span<u32>,
    /// The directive, without the `@`.
    pub directive: String,
}

/// The string argument (by position) of each directive naming a section
/// or stack.
const NAMED: &[(&str, NameKind, NameRole, usize)] = &[
    ("section", NameKind::Section, NameRole::Fill, 0),
    ("yield", NameKind::Section, NameRole::Show, 0),
    ("hasSection", NameKind::Section, NameRole::Show, 0),
    ("sectionMissing", NameKind::Section, NameRole::Show, 0),
    ("push", NameKind::Stack, NameRole::Fill, 0),
    ("prepend", NameKind::Stack, NameRole::Fill, 0),
    ("pushOnce", NameKind::Stack, NameRole::Fill, 0),
    ("prependOnce", NameKind::Stack, NameRole::Fill, 0),
    ("pushIf", NameKind::Stack, NameRole::Fill, 1),
    ("stack", NameKind::Stack, NameRole::Show, 0),
];

/// The top-level arguments of a directive's code (split at commas outside
/// brackets and strings), trimmed.
pub(crate) fn arguments(text: &str, code: &Span<u32>) -> Vec<Span<u32>> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = code.start as usize;
    let mut i = start;
    let end = code.end as usize;
    let push = |from: usize, to: usize, out: &mut Vec<Span<u32>>| {
        let piece = &text[from..to];
        let lead = piece.len() - piece.trim_start().len();
        let trimmed = piece.trim();
        if !trimmed.is_empty() {
            out.push((from + lead) as u32..(from + lead + trimmed.len()) as u32);
        }
    };
    while i < end {
        match b[i] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            quote @ (b'\'' | b'"') => {
                i += 1;
                while i < end && b[i] != quote {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b',' if depth == 0 => {
                push(start, i, &mut out);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    push(start, end.max(start), &mut out);
    out
}

/// The string literal `span` is, if it is one: its content and the
/// content's span.
fn string_at(text: &str, span: &Span<u32>) -> Option<(String, Span<u32>)> {
    let strings = string_args(text, span);
    let (content, inner) = strings.into_iter().next()?;
    // Only the argument itself, not a string inside an expression.
    (inner.start == span.start + 1 && inner.end + 1 >= span.end).then_some((content, inner))
}

/// The sections and stacks `text` names, in order.
pub fn names(text: &str, custom: &[String]) -> Vec<Name> {
    let mut out = Vec::new();
    for node in parse_with(text, custom) {
        let (NodeKind::Directive { name: directive }, Some(code)) = (&node.kind, &node.code) else { continue };
        let Some(&(_, kind, role, index)) = NAMED.iter().find(|(name, ..)| name == directive) else { continue };
        let args = arguments(text, code);
        // While the string is typed (`@section('na`), the code runs to the
        // end of the line, the string to the end of the code.
        let Some(arg) = args.get(index) else { continue };
        let Some((name, span)) = string_at(text, arg) else { continue };
        out.push(Name { kind, role, name, span, directive: directive.clone() });
    }
    out
}

/// The name at byte `offset` (in its string, quotes excluded, ends included).
pub fn name_at(text: &str, offset: u32, custom: &[String]) -> Option<Name> {
    names(text, custom).into_iter().find(|name| name.span.start <= offset && offset <= name.span.end)
}

/// The view `text` extends (`@extends('layouts.app')`), with its span.
pub fn extends(text: &str) -> Option<(String, Span<u32>)> {
    parse_with(text, &[]).into_iter().find_map(|node| match (&node.kind, &node.code) {
        (NodeKind::Directive { name }, Some(code)) if name == "extends" => {
            let first = arguments(text, code).into_iter().next()?;
            string_at(text, &first)
        }
        _ => None,
    })
}

/// One `@props` entry: `'type' => 'info'` or `'message'`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prop {
    pub name: String,
    /// The name's span, quotes excluded.
    pub span: Span<u32>,
    /// The default value as written.
    pub default: Option<String>,
}

/// The `@props([...])` of a component view.
pub fn props(text: &str) -> Vec<Prop> {
    let mut out = Vec::new();
    for node in parse_with(text, &[]) {
        let (NodeKind::Directive { name }, Some(code)) = (&node.kind, &node.code) else { continue };
        if name != "props" {
            continue;
        }
        let Some(array) = arguments(text, code).into_iter().next() else { continue };
        let inner = &text[array.start as usize..array.end as usize];
        let (open, close) = match (inner.starts_with('['), inner.starts_with("array(")) {
            (true, _) => (1, u32::from(inner.ends_with(']'))),
            (_, true) => (6, u32::from(inner.ends_with(')'))),
            _ => continue,
        };
        let elements = array.start + open..array.end - close;
        for element in arguments(text, &elements) {
            let piece = &text[element.start as usize..element.end as usize];
            let (key, default) = match split_arrow(piece) {
                Some(arrow) => {
                    let key = element.start..element.start + piece[..arrow].trim_end().len() as u32;
                    (key, Some(piece[arrow + 2..].trim().to_owned()))
                }
                None => (element.clone(), None),
            };
            if let Some((name, span)) = string_at(text, &key) {
                out.push(Prop { name, span, default });
            }
        }
    }
    out
}

/// The byte offset of the top-level `=>` of an array element.
fn split_arrow(piece: &str) -> Option<usize> {
    let b = piece.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        match b[i] {
            quote @ (b'\'' | b'"') => {
                i += 1;
                while i < b.len() && b[i] != quote {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'=' if b[i + 1] == b'>' => return Some(i),
            b'(' | b'[' => return None,
            _ => {}
        }
        i += 1;
    }
    None
}

/// What closes a block a directive opens.
struct Opener {
    open: &'static [&'static str],
    close: &'static [&'static str],
    /// `@section('a', 'value')` doesn't open a block: the opener's own
    /// arguments say whether it does.
    inline_args: Option<usize>,
    label: &'static str,
}

const OPENERS: &[Opener] = &[
    Opener {
        open: &["section"],
        close: &["endsection", "show", "stop", "overwrite", "append"],
        inline_args: Some(2),
        label: "section",
    },
    Opener { open: &["push", "pushIf"], close: &["endpush", "endPushIf"], inline_args: None, label: "push" },
    Opener { open: &["prepend"], close: &["endprepend"], inline_args: None, label: "prepend" },
    Opener { open: &["pushOnce"], close: &["endPushOnce"], inline_args: None, label: "pushOnce" },
    Opener { open: &["prependOnce"], close: &["endPrependOnce"], inline_args: None, label: "prependOnce" },
];

/// The template's own problems: sections (and stack pushes) that are never
/// closed, and closing directives with nothing open.
pub fn inspect(text: &str, custom: &[String]) -> Vec<Diagnostic> {
    let lines = LineIndex::new(text);
    let mut open: Vec<Vec<(String, Span<u32>)>> = vec![Vec::new(); OPENERS.len()];
    let mut out = Vec::new();
    let diagnostic = |range: Range, message: String, code: &str| Diagnostic {
        range,
        severity: Severity::Error,
        message,
        source: Some(DIAGNOSTIC_SOURCE.into()),
        code: Some(code.into()),
        unnecessary: false,
        deprecated: false,
        server: None,
    };
    for node in parse_with(text, custom) {
        let NodeKind::Directive { name } = &node.kind else { continue };
        if let Some(at) = OPENERS.iter().position(|opener| opener.open.contains(&name.as_str())) {
            let opener = &OPENERS[at];
            let args = node.code.as_ref().map(|code| arguments(text, code)).unwrap_or_default();
            if opener.inline_args.is_some_and(|inline| args.len() >= inline) {
                continue;
            }
            let index = usize::from(name == "pushIf");
            let label = args.get(index).and_then(|arg| string_at(text, arg)).map_or_else(String::new, |(n, _)| n);
            open[at].push((label, node.span.clone()));
        } else if let Some(at) = OPENERS.iter().position(|opener| opener.close.contains(&name.as_str()))
            && open[at].pop().is_none()
        {
            let range = lines.range(node.span.start, node.span.end);
            out.push(diagnostic(
                range,
                format!("`@{name}` without an open `@{}`", OPENERS[at].label),
                "BladeUnopenedSection",
            ));
        }
    }
    for (at, unclosed) in open.into_iter().enumerate() {
        let opener = &OPENERS[at];
        for (name, span) in unclosed {
            let closers = opener.close.iter().map(|close| format!("`@{close}`")).collect::<Vec<_>>().join(", ");
            let what =
                if name.is_empty() { format!("`@{}`", opener.label) } else { format!("`@{}('{name}')`", opener.label) };
            out.push(diagnostic(
                lines.range(span.start, span.end),
                format!("{what} is not closed: add {closers}"),
                "BladeUnclosedSection",
            ));
        }
    }
    out.sort_by_key(|d| (d.range.start.line, d.range.start.col));
    out
}
