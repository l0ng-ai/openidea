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

use ide_core::{Diagnostic, OutlineItem, Range, Severity, SymbolKind};

use super::{NodeKind, parse_with, string_args};
use crate::syntax::LineIndex;

/// The source of the template's own diagnostics.
pub const DIAGNOSTIC_SOURCE: &str = "blade";

/// The codes of the template's own problems: a block never closed, and a
/// closing directive with nothing open ([`inspect`]), and, in a Laravel
/// project, a component tag no component has
/// (`crate::frameworks::laravel::components`), and a parameter a Livewire
/// component doesn't take (`crate::frameworks::laravel::livewire_params`).
pub const INSPECTIONS: [&str; 4] =
    ["BladeUnclosedSection", "BladeUnopenedSection", "BladeUndefinedComponent", "BladeUnknownLivewireParameter"];

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
        if name == "props" {
            out.extend(array_entries(text, code));
        }
    }
    out
}

/// The `@aware([...])` entries of a component view (the parent
/// component's data it reads), as [`Prop`]s.
pub fn aware(text: &str) -> Vec<Prop> {
    let mut out = Vec::new();
    for node in parse_with(text, &[]) {
        if let (NodeKind::Directive { name }, Some(code)) = (&node.kind, &node.code)
            && name == "aware"
        {
            out.extend(array_entries(text, code));
        }
    }
    out
}

/// The entries of the array that is the first argument of a directive
/// whose arguments are `code` (`@props([...])`, `@aware([...])`).
pub(crate) fn array_entries(text: &str, code: &Span<u32>) -> Vec<Prop> {
    let mut out = Vec::new();
    let Some(array) = arguments(text, code).into_iter().next() else { return out };
    let inner = &text[array.start as usize..array.end as usize];
    let (open, close) = match (inner.starts_with('['), inner.starts_with("array(")) {
        (true, _) => (1, u32::from(inner.ends_with(']'))),
        (_, true) => (6, u32::from(inner.ends_with(')'))),
        _ => return out,
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
        // Blade calls `compile<Name>` for `@name`, and PHP method names are
        // case-insensitive: `@endpushOnce` closes `@pushOnce`.
        let is = |names: &[&str]| names.iter().any(|known| known.eq_ignore_ascii_case(name));
        if let Some(at) = OPENERS.iter().position(|opener| is(opener.open)) {
            let opener = &OPENERS[at];
            let args = node.code.as_ref().map(|code| arguments(text, code)).unwrap_or_default();
            if opener.inline_args.is_some_and(|inline| args.len() >= inline) {
                continue;
            }
            let index = usize::from(name.eq_ignore_ascii_case("pushIf"));
            let label = args.get(index).and_then(|arg| string_at(text, arg)).map_or_else(String::new, |(n, _)| n);
            open[at].push((label, node.span.clone()));
        } else if let Some(at) = OPENERS.iter().position(|opener| is(opener.close))
            && open[at].pop().is_none()
        {
            let range = lines.range(node.span.start, node.span.end);
            out.push(diagnostic(range, format!("`@{name}` without an open `@{}`", OPENERS[at].label), INSPECTIONS[1]));
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
                INSPECTIONS[0],
            ));
        }
    }
    out.sort_by_key(|d| (d.range.start.line, d.range.start.col));
    out
}

/// Control-flow blocks of the [`outline`] and what closes each (besides
/// `@end<name>`).
const BLOCKS: &[(&str, &[&str])] = &[
    ("if", &[]),
    ("unless", &[]),
    ("isset", &[]),
    ("empty", &[]),
    ("auth", &[]),
    ("guest", &[]),
    ("can", &[]),
    ("cannot", &[]),
    ("canany", &[]),
    ("env", &[]),
    ("production", &[]),
    ("switch", &[]),
    ("foreach", &[]),
    ("forelse", &[]),
    ("for", &[]),
    ("while", &[]),
    ("component", &[]),
    ("slot", &[]),
    ("once", &[]),
    ("error", &[]),
    ("fragment", &[]),
    ("session", &[]),
    ("verbatim", &[]),
    ("php", &[]),
];

/// Directives shown as single entries of the [`outline`].
const LEAVES: &[(&str, SymbolKind)] = &[
    ("extends", SymbolKind::File),
    ("include", SymbolKind::File),
    ("includeIf", SymbolKind::File),
    ("includeWhen", SymbolKind::File),
    ("includeUnless", SymbolKind::File),
    ("includeFirst", SymbolKind::File),
    ("each", SymbolKind::File),
    ("livewire", SymbolKind::File),
    ("yield", SymbolKind::Module),
    ("stack", SymbolKind::Module),
    ("props", SymbolKind::Property),
    ("aware", SymbolKind::Property),
];

/// The template's structure for the Structure view: its sections and
/// stack pushes, the control-flow blocks (`@if`, `@foreach`, `@can`, …)
/// with what they contain, the views it extends or includes, the
/// sections and stacks it shows, and its component tags. A block left
/// open runs to the end of the text.
pub fn outline(text: &str, custom: &[String]) -> Vec<OutlineItem> {
    let lines = LineIndex::new(text);
    // Open blocks: the entry, and the directive names that close it.
    let mut stack: Vec<(OutlineItem, Vec<String>, u32)> = Vec::new();
    let mut roots: Vec<OutlineItem> = Vec::new();
    let finish =
        |item: OutlineItem, stack: &mut Vec<(OutlineItem, Vec<String>, u32)>, roots: &mut Vec<OutlineItem>| match stack
            .last_mut()
        {
            Some((parent, _, _)) => parent.children.push(item),
            None => roots.push(item),
        };
    let entry = |name: String, kind: SymbolKind, span: &Span<u32>, selection: &Span<u32>| OutlineItem {
        name,
        detail: None,
        kind,
        range: lines.range(span.start, span.end),
        selection_range: lines.range(selection.start, selection.end),
        children: Vec::new(),
        visibility: None,
    };
    // Directives and component tags, in text order.
    let mut events: Vec<(u32, Option<super::Node>, Option<super::tags::ComponentTag>)> = parse_with(text, custom)
        .into_iter()
        .filter(|node| matches!(node.kind, NodeKind::Directive { .. }))
        .map(|node| (node.span.start, Some(node), None))
        .collect();
    events.extend(super::tags::component_tags(text).into_iter().map(|tag| (tag.start, None, Some(tag))));
    events.sort_by_key(|(at, _, _)| *at);
    for (_, node, tag) in events {
        if let Some(tag) = tag {
            let name = format!("<x-{}>", tag.name(text));
            let item = entry(name, SymbolKind::Class, &(tag.start..tag.end), &tag.name);
            finish(item, &mut stack, &mut roots);
            continue;
        }
        let Some(node) = node else { continue };
        let NodeKind::Directive { name } = &node.kind else { continue };
        let lower = name.to_ascii_lowercase();
        // A closer: the innermost open block it closes, and those inside it.
        if let Some(at) = stack.iter().rposition(|(_, closers, _)| closers.contains(&lower)) {
            while stack.len() > at {
                let (mut item, _, start) = stack.pop().expect("open block");
                let end = if stack.len() == at { node.span.end } else { node.span.start };
                item.range = lines.range(start, end);
                finish(item, &mut stack, &mut roots);
            }
            continue;
        }
        let label = match &node.code {
            Some(code) => format!("@{name}({})", text[code.start as usize..code.end as usize].trim()),
            None => format!("@{name}"),
        };
        let label = if label.chars().count() > 80 {
            format!("{}…", label.chars().take(79).collect::<String>())
        } else {
            label
        };
        let selection = node.span.start..node.span.start + 1 + name.len() as u32;
        let args = node.code.as_ref().map(|code| arguments(text, code)).unwrap_or_default();
        let opener = OPENERS.iter().find(|opener| opener.open.iter().any(|open| open.eq_ignore_ascii_case(name)));
        if let Some(opener) = opener {
            if opener.inline_args.is_some_and(|inline| args.len() >= inline) {
                finish(entry(label, SymbolKind::Module, &node.span, &selection), &mut stack, &mut roots);
            } else {
                let closers = opener.close.iter().map(|close| close.to_ascii_lowercase()).collect();
                stack.push((entry(label, SymbolKind::Module, &node.span, &selection), closers, node.span.start));
            }
        } else if let Some((block, more)) = BLOCKS.iter().find(|(block, _)| block.eq_ignore_ascii_case(name)) {
            // `@php($x = 1)` is a statement, not a block, and a bare
            // `@empty` is the empty branch of `@forelse`.
            let statement = *block == "php" && node.code.is_some();
            let branch = *block == "empty" && node.code.is_none();
            if statement || branch {
                continue;
            }
            let mut closers = vec![format!("end{block}")];
            closers.extend(more.iter().map(|close| close.to_ascii_lowercase()));
            stack.push((entry(label, SymbolKind::Namespace, &node.span, &selection), closers, node.span.start));
        } else if let Some((_, kind)) = LEAVES.iter().find(|(leaf, _)| leaf.eq_ignore_ascii_case(name)) {
            finish(entry(label, *kind, &node.span, &selection), &mut stack, &mut roots);
        }
    }
    let end = text.len() as u32;
    while let Some((mut item, _, start)) = stack.pop() {
        item.range = lines.range(start, end);
        finish(item, &mut stack, &mut roots);
    }
    roots
}
