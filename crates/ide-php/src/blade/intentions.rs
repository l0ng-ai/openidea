//! Blade context actions (`refactor.rewrite`), after the intentions
//! IntelliJ documents for Blade; the rules are our own:
//!
//! - **Switch to unescaped echo `{!! !!}`** on a `{{ … }}` echo, and
//!   **Switch to escaped echo `{{ }}`** on a `{!! … !!}` one.
//! - **Convert class attribute to @class**: on the `class="…"` attribute of
//!   an HTML tag (not a component's), writes it as Laravel's `@class([...])`
//!   directive: each class name an entry, `{{ $on ? 'active' : '' }}` a
//!   conditional one (`'active' => $on`), any other echo its expression.
//! - **Wrap class attribute in @class**: the whole value as one entry
//!   (`@class(['btn ' . $size])`), ready for conditional entries; offered
//!   when it differs from the conversion.

use std::ops::Range as Span;
use std::path::Path;

use ide_core::{Range, TextEdit};

use super::{NodeKind, parse};
use crate::imports::{ImportAction, REWRITE, file_edit};
use crate::syntax::LineIndex;

/// One action: its title and byte edits.
pub type Intention = (String, Vec<(u32, u32, String)>);

/// The Blade context actions at `range` of the template `text` at `path`.
pub fn code_actions(path: &Path, text: &str, range: Range) -> Vec<ImportAction> {
    let lines = LineIndex::new(text);
    let (start, end) = lines.byte_range(range);
    intentions(text, start, end)
        .into_iter()
        .map(|(title, edits)| ImportAction {
            title,
            kind: REWRITE,
            preferred: false,
            edit: file_edit(
                path,
                edits
                    .into_iter()
                    .map(|(from, to, new_text)| TextEdit { range: lines.range(from, to), new_text })
                    .collect(),
            ),
            open: None,
        })
        .collect()
}

/// The actions at bytes `start..end` of `text` (see the module
/// documentation).
pub fn intentions(text: &str, start: u32, end: u32) -> Vec<Intention> {
    let mut out = Vec::new();
    out.extend(echo_switch(text, start, end));
    out.extend(class_attribute(text, start, end));
    out
}

fn echo_switch(text: &str, start: u32, end: u32) -> Option<Intention> {
    let node = parse(text)
        .into_iter()
        .find(|node| matches!(node.kind, NodeKind::Echo { .. }) && node.span.start <= start && end <= node.span.end)?;
    let (from, to) = (node.span.start, node.span.end);
    let echo = &text[from as usize..to as usize];
    match node.kind {
        NodeKind::Echo { raw: false } if echo.starts_with("{{") && !echo.starts_with("{{{") && echo.ends_with("}}") => {
            if echo.len() < 4 {
                return None;
            }
            Some((
                "Switch to unescaped echo {!! !!}".to_owned(),
                vec![(from, from + 2, "{!!".to_owned()), (to - 2, to, "!!}".to_owned())],
            ))
        }
        NodeKind::Echo { raw: true } if echo.starts_with("{!!") && echo.ends_with("!!}") && echo.len() >= 6 => Some((
            "Switch to escaped echo {{ }}".to_owned(),
            vec![(from, from + 3, "{{".to_owned()), (to - 3, to, "}}".to_owned())],
        )),
        _ => None,
    }
}

/// An attribute of an HTML tag.
struct Attribute {
    name: Span<usize>,
    /// Inside the quotes; `None` without a quoted value.
    value: Option<Span<usize>>,
}

/// An HTML tag: where it starts and ends, and its attributes.
struct Tag {
    start: usize,
    end: usize,
    attributes: Vec<Attribute>,
}

/// After the Blade echo or comment starting at `at` (`{{`, `{!!`), or
/// `None` when none starts there.
fn skip_echo(text: &str, at: usize) -> Option<usize> {
    let rest = &text[at..];
    let close = if rest.starts_with("{{--") {
        "--}}"
    } else if rest.starts_with("{!!") {
        "!!}"
    } else if rest.starts_with("{{") {
        "}}"
    } else {
        return None;
    };
    Some(rest[2..].find(close).map_or(text.len(), |found| at + 2 + found + close.len()))
}

/// The HTML tag whose `<` is at `start` (not a `<x-…>` component).
fn tag_at(text: &str, start: usize) -> Option<Tag> {
    let b = text.as_bytes();
    let n = b.len();
    if b.get(start) != Some(&b'<') || !b.get(start + 1).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    let name_end = (start + 1..n)
        .find(|&i| !(b[i].is_ascii_alphanumeric() || matches!(b[i], b'-' | b':' | b'.' | b'_')))
        .unwrap_or(n);
    let name = &text[start + 1..name_end];
    if name.starts_with("x-") || name.starts_with("x:") {
        return None;
    }
    let mut tag = Tag { start, end: n, attributes: Vec::new() };
    let mut i = name_end;
    while i < n {
        match b[i] {
            b'>' => {
                tag.end = i + 1;
                return Some(tag);
            }
            b'<' => return None,
            b'{' => i = skip_echo(text, i).unwrap_or(i + 1),
            c if c.is_ascii_whitespace() || c == b'/' => i += 1,
            _ => {
                let name_start = i;
                while i < n && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'<' | b'"' | b'\'') {
                    if b[i] == b'(' {
                        // A directive among the attributes (`@if($x)`).
                        let mut depth = 0usize;
                        while i < n {
                            match b[i] {
                                b'(' => depth += 1,
                                b')' => {
                                    depth -= 1;
                                    if depth == 0 {
                                        break;
                                    }
                                }
                                _ => {}
                            }
                            i += 1;
                        }
                    }
                    i += 1;
                }
                if i == name_start {
                    i += 1;
                    continue;
                }
                let mut attribute = Attribute { name: name_start..i, value: None };
                if b.get(i) == Some(&b'=') && matches!(b.get(i + 1), Some(b'"' | b'\'')) {
                    let quote = b[i + 1];
                    let open = i + 2;
                    let mut at = open;
                    while at < n && b[at] != quote {
                        at = match skip_echo(text, at) {
                            Some(after) => after,
                            None => at + 1,
                        };
                    }
                    attribute.value = Some(open..at.min(n));
                    i = (at + 1).min(n);
                } else if b.get(i) == Some(&b'=') {
                    i += 1;
                    while i < n && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                        i += 1;
                    }
                }
                tag.attributes.push(attribute);
            }
        }
    }
    None
}

/// The tag around byte `at`: the nearest `<name` before it whose tag runs
/// past it.
fn tag_around(text: &str, at: usize) -> Option<Tag> {
    let mut before = at.min(text.len());
    for _ in 0..64 {
        let open = text[..before].rfind('<')?;
        if let Some(tag) = tag_at(text, open) {
            return (tag.start <= at && at < tag.end).then_some(tag);
        }
        before = open;
    }
    None
}

/// Part of a `class` value: literal text or the expression of an echo.
enum Part<'t> {
    Text(&'t str),
    Echo(&'t str),
}

fn parts(value: &str) -> Option<Vec<Part<'_>>> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = value[from..].find('{') {
        let at = from + found;
        let Some(after) = skip_echo(value, at) else {
            from = at + 1;
            continue;
        };
        let rest = &value[at..after];
        if !value[from..at].is_empty() {
            out.push(Part::Text(&value[from..at]));
        }
        if !rest.starts_with("{{--") {
            let (open, close) = if rest.starts_with("{!!") { (3, 3) } else { (2, 2) };
            if rest.len() < open + close {
                return None;
            }
            out.push(Part::Echo(rest[open..rest.len() - close].trim()));
        }
        from = after;
    }
    if from < value.len() {
        out.push(Part::Text(&value[from..]));
    }
    // A directive (`@if`) in the value isn't converted.
    let directive = out.iter().any(|part| match part {
        Part::Text(text) => text.match_indices('@').any(|(at, _)| text[at + 1..].starts_with(char::is_alphabetic)),
        Part::Echo(_) => false,
    });
    (!directive).then_some(out)
}

/// A PHP single-quoted string.
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// `$on ? 'active' : ''` as `'active' => $on`.
fn conditional(expr: &str) -> Option<String> {
    let rest = expr.trim_end();
    let rest = rest.strip_suffix("''").or_else(|| rest.strip_suffix("\"\""))?.trim_end();
    let rest = rest.strip_suffix(':')?.trim_end();
    let quote = rest.chars().last().filter(|c| matches!(c, '\'' | '"'))?;
    let open = rest[..rest.len() - 1].rfind(quote)?;
    let class = &rest[open + 1..rest.len() - 1];
    if class.contains(['\\', '$', '\'', '"']) {
        return None;
    }
    let condition = rest[..open].trim_end().strip_suffix('?')?;
    if condition.ends_with('?') || condition.trim().is_empty() {
        return None;
    }
    Some(format!("{} => {}", quoted(class), condition.trim()))
}

/// The `@class` entries of a value: each class name, each echo.
fn entries(parts: &[Part<'_>]) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        match part {
            Part::Text(text) => {
                // Text glued to an echo makes one class of both.
                let glued_before = i > 0 && !text.starts_with(char::is_whitespace);
                let glued_after = i + 1 < parts.len() && !text.ends_with(char::is_whitespace);
                if (glued_before || glued_after) && !text.trim().is_empty() {
                    return None;
                }
                out.extend(text.split_whitespace().map(quoted));
            }
            Part::Echo("") => {}
            Part::Echo(expr) => {
                if i > 0 && matches!(parts[i - 1], Part::Echo(_)) {
                    return None;
                }
                out.push(conditional(expr).unwrap_or_else(|| (*expr).to_owned()));
            }
        }
    }
    Some(out)
}

/// The whole value as one string expression.
fn wrapped(parts: &[Part<'_>]) -> String {
    let pieces: Vec<String> = parts
        .iter()
        .filter_map(|part| match part {
            Part::Text(text) => Some(quoted(text)),
            Part::Echo("") => None,
            Part::Echo(expr) if expr.contains(char::is_whitespace) || expr.contains('?') => Some(format!("({expr})")),
            Part::Echo(expr) => Some((*expr).to_owned()),
        })
        .collect();
    pieces.join(" . ")
}

fn class_attribute(text: &str, start: u32, end: u32) -> Vec<Intention> {
    let Some(tag) = tag_around(text, start as usize) else { return Vec::new() };
    if text[tag.start..tag.end].contains("@class(") {
        return Vec::new();
    }
    let Some((attribute, value)) = tag.attributes.iter().find_map(|attribute| {
        let value = attribute.value.clone()?;
        let name = &text[attribute.name.clone()];
        let around = attribute.name.start <= start as usize && end as usize <= value.end + 1;
        (name.eq_ignore_ascii_case("class") && around).then_some((attribute, value))
    }) else {
        return Vec::new();
    };
    let content = &text[value.clone()];
    if content.trim().is_empty() {
        return Vec::new();
    }
    let Some(parts) = parts(content) else { return Vec::new() };
    let replaced = (attribute.name.start as u32, (value.end + 1).min(text.len()) as u32);
    let directive = |entries: &[String]| format!("@class([{}])", entries.join(", "));
    let mut out = Vec::new();
    let converted = entries(&parts).filter(|entries| !entries.is_empty()).map(|entries| directive(&entries));
    if let Some(converted) = &converted {
        out.push(("Convert class attribute to @class".to_owned(), vec![(replaced.0, replaced.1, converted.clone())]));
    }
    let wrap = directive(&[wrapped(&parts)]);
    if converted.as_ref() != Some(&wrap) {
        out.push(("Wrap class attribute in @class".to_owned(), vec![(replaced.0, replaced.1, wrap)]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARET: &str = "/*|*/";

    /// The text with every action at the caret applied, by title.
    fn applied(source: &str) -> Vec<(String, String)> {
        let at = source.find(CARET).expect("a caret") as u32;
        let text = source.replacen(CARET, "", 1);
        intentions(&text, at, at)
            .into_iter()
            .map(|(title, mut edits)| {
                edits.sort_by_key(|(from, _, _)| std::cmp::Reverse(*from));
                let mut out = text.clone();
                for (from, to, new_text) in edits {
                    out.replace_range(from as usize..to as usize, &new_text);
                }
                (title, out)
            })
            .collect()
    }

    fn one(source: &str, title: &str) -> Option<String> {
        applied(source).into_iter().find(|(t, _)| t == title).map(|(_, text)| text)
    }

    #[test]
    fn switches_echoes() {
        let unescaped = "Switch to unescaped echo {!! !!}";
        let escaped = "Switch to escaped echo {{ }}";
        assert_eq!(one("<p>{{ $po/*|*/st->body }}</p>", unescaped).as_deref(), Some("<p>{!! $post->body !!}</p>"));
        assert_eq!(one("<p>{!! $po/*|*/st->body !!}</p>", escaped).as_deref(), Some("<p>{{ $post->body }}</p>"));
        assert_eq!(one("<p>/*|*/{{$x}}</p>", unescaped).as_deref(), Some("<p>{!!$x!!}</p>"));
        // Not outside an echo, nor in a comment or an unclosed echo.
        assert!(applied("<p>te/*|*/xt {{ $x }}</p>").is_empty());
        assert!(applied("{{-- a /*|*/comment --}}").is_empty());
        assert!(applied("<p>{{ $x/*|*/").is_empty());
    }

    #[test]
    fn converts_class_attributes() {
        let convert = "Convert class attribute to @class";
        let wrap = "Wrap class attribute in @class";
        let source = "<div id=\"a\" cl/*|*/ass=\"p-4 font-bold\">x</div>";
        assert_eq!(one(source, convert).as_deref(), Some("<div id=\"a\" @class(['p-4', 'font-bold'])>x</div>"));
        assert_eq!(one(source, wrap).as_deref(), Some("<div id=\"a\" @class(['p-4 font-bold'])>x</div>"));
        // A conditional echo, a plain echo.
        let source = "<li class=\"item /*|*/{{ $active ? 'active' : '' }} {{ $extra }}\">";
        assert_eq!(one(source, convert).as_deref(), Some("<li @class(['item', 'active' => $active, $extra])>"));
        assert_eq!(
            one(source, wrap).as_deref(),
            Some("<li @class(['item ' . ($active ? 'active' : '') . ' ' . $extra])>")
        );
        // An echo glued to a class: only wrapped.
        let found = applied("<span class=\"bt/*|*/n-{{ $size }}\"></span>");
        assert_eq!(found, [(wrap.to_owned(), "<span @class(['btn-' . $size])></span>".to_owned())]);
        // One class: the two would be the same, so only the conversion.
        let found = applied("<b class=\"/*|*/bold\">");
        assert_eq!(found, [(convert.to_owned(), "<b @class(['bold'])>".to_owned())]);
        // Echoes with quotes inside the attribute's quotes.
        let source = "<a href=\"{{ route(\"home\") }}\" class=\"link/*|*/ {{ $on ? \"on\" : \"\" }}\">";
        assert_eq!(
            one(source, convert).as_deref(),
            Some("<a href=\"{{ route(\"home\") }}\" @class(['link', 'on' => $on])>")
        );
    }

    #[test]
    fn leaves_other_attributes_and_tags_alone() {
        // Not on another attribute, a component, an empty value, a tag with
        // `@class` already, or a value with a directive.
        for source in [
            "<div id=\"/*|*/a\" class=\"b\">",
            "<x-alert class=\"/*|*/b\" />",
            "<div class=\"/*|*/\">",
            "<div class=\"/*|*/a\" @class(['b'])>",
            "<div class=\"a @if($x) b @endif/*|*/\">",
            "<p>class=\"/*|*/a\"</p>",
        ] {
            assert!(applied(source).is_empty(), "{source}");
        }
    }
}
