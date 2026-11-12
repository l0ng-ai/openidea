//! Reformat Code for Blade templates: the indentation of every line from
//! the nesting of HTML elements (component tags included) and Blade blocks
//! (`@if`/`@else`/`@endif`, `@foreach`, `@section`, `@push`, a custom
//! `@admin … @endadmin`), and the spacing inside echoes (`{{ $x }}`,
//! `{!! $x !!}`). Nothing is rewrapped or moved to another line.
//!
//! - The content of `<script>`, `<style>` and `@php … @endphp` keeps its own
//!   indentation, shifted as a whole one level inside its tag or directive.
//! - `<pre>`, `<textarea>`, `@verbatim`, comments (`{{-- --}}`, `<!-- -->`)
//!   and echoes or directive arguments written over several lines keep
//!   every line they span as written.
//! - The attribute lines of a tag written over several lines go one level
//!   in (a line starting with `>` or `/>` stays at the tag's level).
//! - The PHP of `@php … @endphp` (and `<?php … ?>`) blocks written over
//!   several lines is formatted ([`crate::format`], in Laravel Pint's
//!   style: Blade is Laravel's), and so are an echo's expression and a
//!   directive's arguments when they stay on one line (`@if($a==1)` as
//!   `@if($a == 1)`); code that doesn't parse is left as written.
//! - Trailing whitespace goes, and the text ends with one line break.
//!
//! An element left open where its closing tag is written in another branch
//! of an `@if` shifts what follows by a level, as in other formatters.

use std::ops::Range as Span;

use super::{NodeKind, parse_with};

/// The editor's indentation.
#[derive(Clone, Copy, Debug)]
pub struct BladeFormatOptions {
    pub indent: u32,
    pub use_tabs: bool,
    /// Code Style › Hard wrap at, for the PHP formatted inside.
    pub line_width: u32,
    /// The language level the PHP inside `@php` blocks and echoes is
    /// formatted at (PSR-12, [`crate::format`]); `None` leaves it as written.
    pub php: Option<crate::stubs::PhpVersion>,
}

/// Elements without content (no closing tag).
const VOID: &[&str] =
    &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"];

/// Whether the children of the `<html>` tag spanning `tag` are indented in
/// the template already (Laravel's own templates write `<head>` and
/// `<body>` at its level, as IntelliJ's "Do not indent children of" does).
fn indents_children(text: &str, tag: &Span<u32>) -> bool {
    let lead = |line: &str| line.len() - line.trim_start().len();
    let line_start = text[..tag.start as usize].rfind('\n').map_or(0, |at| at + 1);
    let own = lead(&text[line_start..tag.start as usize]);
    let next = text[tag.end as usize..].split('\n').skip(1).find(|line| !line.trim().is_empty());
    next.is_some_and(|line| lead(line) > own)
}

/// Elements whose next sibling of the same name closes them (`<li>` …).
const SELF_CLOSING_SIBLINGS: &[&str] = &["li", "option", "tr", "td", "th", "dt", "dd"];

/// Blade blocks: the directive and what closes it besides `@end<name>`.
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
    ("hassection", &["endif"]),
    ("sectionmissing", &["endif"]),
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
    ("push", &[]),
    ("pushif", &[]),
    ("pushonce", &[]),
    ("prepend", &[]),
    ("prependonce", &[]),
    ("section", &["show", "stop", "overwrite", "append"]),
    ("teleport", &[]),
];

/// Branches inside a block: the line goes back a level.
const MIDDLES: &[&str] = &["else", "elseif", "elsecan", "elsecannot", "elsecanany", "elseauth", "elseguest", "elseenv"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Open,
    Close,
    Middle,
}

#[derive(Clone, Copy, Debug)]
struct Event {
    at: u32,
    end: u32,
    kind: Kind,
    /// The HTML element it opens or closes (0 for Blade).
    id: u32,
}

/// How a run of lines is laid out.
#[derive(Clone, Debug)]
enum Region {
    /// Left as written (`<pre>`, comments, multi-line echoes).
    Keep(Span<u32>),
    /// Its own indentation, shifted one level inside what opens it
    /// (`<script>`, `@php`); the opener's position.
    Shift(Span<u32>, u32),
    /// The attribute lines of a tag written over several lines; the tag's
    /// start.
    Tag(Span<u32>, u32),
}

/// The template `text` formatted.
pub fn format(text: &str, options: &BladeFormatOptions, custom: &[String]) -> String {
    // `Blade::if('admin')` also makes `@elseadmin`, `@unlessadmin` and
    // `@endadmin`.
    let custom: Vec<String> = custom
        .iter()
        .flat_map(|name| [name.clone(), format!("end{name}"), format!("else{name}"), format!("unless{name}")])
        .collect();
    let custom = custom.as_slice();
    let text = format_code(text, custom, options);
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let (events, regions) = analyse(&text, custom);
    // The base indentation of each shifted region, once.
    let bases: Vec<u32> = regions
        .iter()
        .map(|region| match region {
            Region::Shift(span, _) => shift_base(&text, span, options.indent),
            _ => 0,
        })
        .collect();
    let unit = if options.use_tabs { "\t".to_owned() } else { " ".repeat(options.indent as usize) };
    let indent_of = |depth: i32| unit.repeat(depth.max(0) as usize);
    // Depth before each event, in order.
    let mut depths = Vec::with_capacity(events.len());
    let mut depth = 0i32;
    for event in &events {
        depths.push(depth);
        match event.kind {
            Kind::Open => depth += 1,
            Kind::Close => depth = (depth - 1).max(0),
            Kind::Middle => {}
        }
    }
    let depth_before = |at: u32| -> i32 {
        let i = events.partition_point(|event| event.at < at);
        if i == 0 {
            0
        } else {
            let previous = &events[i - 1];
            let d = depths[i - 1];
            match previous.kind {
                Kind::Open => d + 1,
                Kind::Close => (d - 1).max(0),
                Kind::Middle => d,
            }
        }
    };

    let mut out = String::with_capacity(text.len() + 64);
    let mut start = 0usize;
    let lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for (n, raw) in lines.iter().enumerate() {
        let line_start = start as u32;
        start += raw.len() + 1;
        // The final empty piece after the last line break.
        if n == last && raw.is_empty() {
            break;
        }
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = line.trim_start();
        let first = line_start + (line.len() - trimmed.len()) as u32;
        let content = trimmed.trim_end();
        let inside = |span: &Span<u32>| span.start < line_start && first < span.end;
        // Raw text up to its closer: the whitespace before it is content.
        let raw = |span: &Span<u32>| span.start < line_start && line_start <= span.end;
        let found = regions.iter().position(|region| match region {
            Region::Keep(span) => raw(span),
            Region::Shift(span, _) | Region::Tag(span, _) => inside(span),
        });
        let region = found.map(|at| &regions[at]);
        let formatted = match region {
            Some(Region::Keep(_)) => line.to_owned(),
            _ if content.is_empty() => String::new(),
            Some(Region::Shift(_, opener)) => {
                let base = found.map_or(0, |at| bases[at]);
                let own = columns(&line[..line.len() - trimmed.len()], options.indent);
                let extra = own.saturating_sub(base);
                let depth = depth_before(*opener) + 1;
                format!("{}{}{content}", indent_of(depth), " ".repeat(extra as usize))
            }
            Some(Region::Tag(_, tag)) => {
                let depth = depth_before(*tag) + i32::from(!(content.starts_with('>') || content.starts_with("/>")));
                format!("{}{content}", indent_of(depth))
            }
            None => {
                let mut depth = depth_before(first);
                // Closers and branches the line starts with go back a level.
                let mut cursor = first;
                let mut i = events.partition_point(|event| event.at < first);
                while let Some(event) = events.get(i).filter(|event| event.at == cursor) {
                    match event.kind {
                        Kind::Close => depth -= 1,
                        Kind::Middle => {
                            depth -= 1;
                            break;
                        }
                        Kind::Open => break,
                    }
                    cursor = event.end;
                    let rest = &text[cursor as usize..];
                    cursor += (rest.len() - rest.trim_start_matches([' ', '\t']).len()) as u32;
                    i += 1;
                }
                format!("{}{content}", indent_of(depth))
            }
        };
        out.push_str(&formatted);
        if n < last {
            out.push_str(eol);
        }
    }
    let kept = out.trim_end_matches(['\r', '\n']).len();
    out.truncate(kept);
    out.push_str(eol);
    out
}

/// The code inside the template's Blade constructs: `{{$x}}` as
/// `{{ $x }}` and `{!!$x!!}` as `{!! $x !!}` (one line only), their
/// expression formatted as PHP when it stays on one line, and the PHP of
/// `@php … @endphp` or `<?php … ?>` blocks written over several lines
/// formatted (it starts at column 0 here; the indentation pass shifts it).
/// Code that doesn't parse is left as written.
fn format_code(text: &str, custom: &[String], options: &BladeFormatOptions) -> String {
    let php = options.php.map(|version| {
        let settings = crate::format::FormatOptions {
            indent: options.indent,
            use_tabs: options.use_tabs,
            line_width: options.line_width,
        };
        (version, settings)
    });
    // `source` formatted as a PHP file, without its opening tag.
    let formatted = |source: &str| -> Option<String> {
        let (version, settings) = php.as_ref()?;
        let file = format!("<?php\n{source}\n");
        let edit = crate::format::format_text_with(&file, None, *version, settings.pint_settings());
        let mut printed = file.clone();
        if let Some(edit) = edit {
            printed.replace_range(edit.start as usize..edit.end as usize, &edit.text);
        }
        Some(printed.strip_prefix("<?php")?.trim_matches(['\n', '\r', ' ', '\t']).to_owned())
    };
    let mut out = String::with_capacity(text.len() + 16);
    let mut at = 0usize;
    for node in parse_with(text, custom) {
        let span = node.span.start as usize..node.span.end as usize;
        let Some(code) = &node.code else { continue };
        let inner = &text[code.start as usize..code.end as usize];
        let written = &text[span.clone()];
        let replacement = match &node.kind {
            NodeKind::Echo { raw } => {
                let (open, close) = if *raw { ("{!!", "!!}") } else { ("{{", "}}") };
                if !written.starts_with(open) || !written.ends_with(close) || written.contains('\n') {
                    continue;
                }
                let expression = inner.trim();
                if expression.is_empty() {
                    continue;
                }
                // As the value of an assignment: one line, or as written.
                let printed = formatted(&format!("$__e = {expression};"))
                    .and_then(|printed| {
                        let value = printed.strip_prefix("$__e = ")?.strip_suffix(';')?;
                        (!value.contains('\n')).then(|| value.to_owned())
                    })
                    .unwrap_or_else(|| expression.to_owned());
                format!("{open} {printed} {close}")
            }
            NodeKind::Php if written.contains('\n') && !inner.trim().is_empty() => {
                let Some(printed) = formatted(inner) else { continue };
                // A parse error leaves the file as it was: keep the code.
                if printed.is_empty()
                    || crate::syntax::ParsedFile::parse("b.php", format!("<?php\n{printed}\n")).has_errors()
                {
                    continue;
                }
                let head = &text[span.start..code.start as usize];
                let tail = &text[code.end as usize..span.end];
                // At the indentation the code and the closer had: inside
                // raw text (a `<script>`) nothing indents them again.
                let lead = |line: &str| line[..line.len() - line.trim_start().len()].to_owned();
                let code_lead = inner
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .map(lead)
                    .min_by_key(|lead| columns(lead, options.indent))
                    .unwrap_or_default();
                let line_start = text[..span.start].rfind('\n').map_or(0, |at| at + 1);
                let own = &text[line_start..span.start];
                let tail_lead = if own.trim().is_empty() { own } else { "" };
                let printed: Vec<String> = printed
                    .lines()
                    .map(|line| if line.is_empty() { String::new() } else { format!("{code_lead}{line}") })
                    .collect();
                format!("{head}\n{}\n{tail_lead}{tail}", printed.join("\n"))
            }
            // A directive's arguments, written on one line and closed.
            NodeKind::Directive { name } if !written.contains('\n') && written.ends_with(')') => {
                let arguments = inner.trim();
                let lower = name.to_ascii_lowercase();
                // `@php($x = 1)` is a statement.
                if arguments.is_empty() || lower == "php" {
                    continue;
                }
                // As the PHP construct the arguments are part of.
                let (open, close) = match lower.as_str() {
                    "if" | "elseif" | "unless" | "while" | "switch" | "case" => ("if (", ") {"),
                    "foreach" | "forelse" => ("foreach (", ") {"),
                    "for" => ("for (", ") {"),
                    _ => ("__directive(", ");"),
                };
                let source =
                    if close == ");" { format!("{open}{arguments});") } else { format!("{open}{arguments}) {{\n}}") };
                let Some(printed) = formatted(&source).and_then(|printed| {
                    let rest = printed.strip_prefix(open)?;
                    let end = rest.rfind(close)?;
                    let printed = &rest[..end];
                    (!printed.contains('\n')).then(|| printed.to_owned())
                }) else {
                    continue;
                };
                let head = &text[span.start..code.start as usize];
                let tail = &text[code.end as usize..span.end];
                format!("{head}{printed}{tail}")
            }
            _ => continue,
        };
        out.push_str(&text[at..span.start]);
        out.push_str(&replacement);
        at = span.end;
    }
    out.push_str(&text[at..]);
    out
}

/// The width of leading whitespace, tabs counted as `indent` columns.
fn columns(lead: &str, indent: u32) -> u32 {
    lead.chars().map(|c| if c == '\t' { indent.max(1) } else { 1 }).sum()
}

/// The smallest indentation of the non-blank lines starting inside `span`.
fn shift_base(text: &str, span: &Span<u32>, indent: u32) -> u32 {
    let inner = &text[span.start as usize..span.end as usize];
    inner
        .split('\n')
        .skip(1)
        .filter(|line| !line.trim().is_empty())
        .map(|line| columns(&line[..line.len() - line.trim_start().len()], indent))
        .min()
        .unwrap_or(0)
}

/// The template's nesting events (in text order) and the regions laid out
/// apart.
fn analyse(text: &str, custom: &[String]) -> (Vec<Event>, Vec<Region>) {
    let nodes = parse_with(text, custom);
    let mut events: Vec<Event> = Vec::new();
    let mut regions: Vec<Region> = Vec::new();
    // What the HTML scan skips: Blade constructs and verbatim text.
    // (Bound attributes are inside a tag's quotes: the tag scan reads them.)
    let mut opaque: Vec<Span<u32>> =
        nodes.iter().filter(|node| node.kind != NodeKind::Bound).map(|node| node.span.clone()).collect();
    for span in verbatim(text) {
        regions.push(Region::Keep(span.clone()));
        opaque.push(span);
    }
    opaque.sort_by_key(|span| span.start);

    // Blade.
    let lower = text.to_ascii_lowercase();
    // Open blocks: what closes each, and where it starts.
    let mut blocks: Vec<(Vec<String>, u32)> = Vec::new();
    // The span of every block, for elements opened and closed in different
    // ones.
    let mut spans: Vec<(u32, u32)> = Vec::new();
    for node in &nodes {
        let multiline = text[node.span.start as usize..node.span.end as usize].contains('\n');
        match &node.kind {
            NodeKind::Comment if multiline => regions.push(Region::Keep(node.span.clone())),
            NodeKind::Echo { .. } if multiline => regions.push(Region::Keep(node.span.clone())),
            NodeKind::Php if multiline => {
                // `@php … @endphp` or `<?php … ?>`: the code between.
                let code = node.code.clone().unwrap_or(node.span.clone());
                regions.push(Region::Shift(code, node.span.start));
            }
            NodeKind::Directive { name } => {
                if multiline {
                    regions.push(Region::Keep(node.span.clone()));
                }
                let name = name.to_ascii_lowercase();
                let args = node.code.as_ref().map(|code| super::structure::arguments(text, code).len()).unwrap_or(0);
                let event = |kind| Event { at: node.span.start, end: node.span.end, kind, id: 0 };
                let zero = |kind| Event { at: node.span.start, end: node.span.start, kind, id: 0 };
                let in_switch = blocks.iter().any(|(closers, _)| closers.iter().any(|c| c == "endswitch"));
                if matches!(name.as_str(), "case" | "default") && in_switch {
                    // A case of `@switch`: it ends the one before, and its
                    // content goes a level in.
                    if blocks.last().is_some_and(|(closers, _)| closers.is_empty()) {
                        let (_, start) = blocks.pop().expect("a case");
                        spans.push((start, node.span.start));
                        events.push(zero(Kind::Close));
                    }
                    blocks.push((Vec::new(), node.span.start));
                    events.push(event(Kind::Open));
                } else if let Some(at) = blocks.iter().rposition(|(closers, _)| closers.contains(&name)) {
                    // Blocks left open inside it (a case) close here too.
                    for _ in at + 1..blocks.len() {
                        events.push(zero(Kind::Close));
                    }
                    for (_, start) in blocks.drain(at..) {
                        spans.push((start, node.span.start));
                    }
                    events.push(event(Kind::Close));
                } else if MIDDLES.contains(&name.as_str())
                    || (name == "empty" && node.code.is_none())
                    || (name.starts_with("else") && custom.iter().any(|c| c.eq_ignore_ascii_case(&name)))
                {
                    if !blocks.is_empty() {
                        events.push(event(Kind::Middle));
                    }
                } else if let Some(closers) = block_closers(&name, args, node, &lower) {
                    blocks.push((closers, node.span.start));
                    events.push(event(Kind::Open));
                }
            }
            _ => {}
        }
    }

    // HTML.
    let b = text.as_bytes();
    let n = b.len();
    // Blocks never closed run to the end.
    spans.extend(blocks.iter().map(|(_, start)| (*start, text.len() as u32)));
    // Open elements: their name, whether their children are indented, and
    // their id.
    let mut open: Vec<(String, bool, u32)> = Vec::new();
    let mut next_id = 1u32;
    let mut i = 0usize;
    let mut skip = 0usize;
    while i < n {
        while skip < opaque.len() && (opaque[skip].end as usize) <= i {
            skip += 1;
        }
        if let Some(span) = opaque.get(skip).filter(|span| (span.start as usize) <= i) {
            i = span.end as usize;
            continue;
        }
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        let rest = &text[i..];
        if rest.starts_with("<!--") {
            let end = rest.find("-->").map_or(n, |at| i + at + 3);
            if text[i..end].contains('\n') {
                regions.push(Region::Keep(i as u32..end as u32));
            }
            i = end;
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            i = rest.find('>').map_or(n, |at| i + at + 1);
            continue;
        }
        let closing = rest.starts_with("</");
        let name_start = i + if closing { 2 } else { 1 };
        let name_end = (name_start..n)
            .find(|&at| !(b[at].is_ascii_alphanumeric() || matches!(b[at], b'-' | b'_' | b':' | b'.')))
            .unwrap_or(n);
        if name_end == name_start || !b[name_start].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let mut name = text[name_start..name_end].to_ascii_lowercase();
        // `<x-slot:title>` closes with `</x-slot>`.
        if name.starts_with("x-slot:") {
            name.truncate("x-slot".len());
        }
        let end = tag_end(b, name_end, &opaque);
        let tag = i as u32..end as u32;
        if text[i..end].contains('\n') {
            regions.push(Region::Tag(tag.clone(), i as u32));
        }
        if closing {
            if let Some(at) = open.iter().rposition(|(known, ..)| *known == name) {
                // Elements left open inside it close here too.
                for (_, counted, id) in &open[at + 1..] {
                    if *counted {
                        events.push(Event { at: tag.start, end: tag.start, kind: Kind::Close, id: *id });
                    }
                }
                if open[at].1 {
                    events.push(Event { at: tag.start, end: tag.end, kind: Kind::Close, id: open[at].2 });
                }
                open.truncate(at);
            }
            i = end;
            continue;
        }
        let self_closing = text[..end].ends_with("/>");
        if self_closing || VOID.contains(&name.as_str()) {
            i = end;
            continue;
        }
        if SELF_CLOSING_SIBLINGS.contains(&name.as_str()) && open.last().is_some_and(|(last, ..)| *last == name) {
            let (_, counted, id) = open.pop().expect("a sibling");
            if counted {
                events.push(Event { at: tag.start, end: tag.start, kind: Kind::Close, id });
            }
        }
        let counted = name != "html" || indents_children(text, &tag);
        let id = next_id;
        next_id += 1;
        if counted {
            events.push(Event { at: tag.start, end: tag.end, kind: Kind::Open, id });
        }
        open.push((name.clone(), counted, id));
        i = end;
        // Raw text: up to the closing tag, not scanned.
        if matches!(name.as_str(), "script" | "style" | "pre" | "textarea") {
            let close = format!("</{name}");
            let content_end = lower[end..].find(&close).map_or(n, |at| end + at);
            let content = end as u32..content_end as u32;
            if matches!(name.as_str(), "pre" | "textarea") {
                regions.push(Region::Keep(content));
            } else {
                regions.push(Region::Shift(content, tag.start));
            }
            i = content_end;
        }
    }
    drop_crossing_elements(&mut events, &spans);
    events.sort_by_key(|event| (event.at, event.kind == Kind::Open));
    (events, regions)
}

/// Elements whose opening and closing tags aren't in the same Blade block
/// (a wrapper opened in one `@if` and closed in another) don't nest: their
/// events go. So does one never closed that a block opened.
fn drop_crossing_elements(events: &mut Vec<Event>, spans: &[(u32, u32)]) {
    let innermost = |at: u32| -> Option<(u32, u32)> {
        spans.iter().filter(|(start, end)| *start < at && at < *end).max_by_key(|(start, _)| *start).copied()
    };
    let mut ends: std::collections::HashMap<u32, (u32, Option<u32>)> = std::collections::HashMap::new();
    for event in events.iter().filter(|event| event.id != 0) {
        let entry = ends.entry(event.id).or_insert((event.at, None));
        match event.kind {
            Kind::Open => entry.0 = event.at,
            _ => entry.1 = Some(event.at),
        }
    }
    let crossing: std::collections::HashSet<u32> = ends
        .into_iter()
        .filter(|(_, (open, close))| match close {
            Some(close) => innermost(*open) != innermost(*close),
            None => innermost(*open).is_some(),
        })
        .map(|(id, _)| id)
        .collect();
    events.retain(|event| event.id == 0 || !crossing.contains(&event.id));
}

/// What closes the block a directive `name` opens, or `None` when it opens
/// none: a known block (not written inline, like `@section('a', 'b')`), or
/// any directive whose `@end<name>` the template has.
fn block_closers(name: &str, args: usize, node: &super::Node, lower: &str) -> Option<Vec<String>> {
    let inline = match name {
        "section" | "slot" => args >= 2,
        "pushif" => false,
        "php" => node.code.is_some(),
        _ => false,
    };
    if inline {
        return None;
    }
    let end = format!("end{name}");
    if let Some((_, more)) = BLOCKS.iter().find(|(block, _)| *block == name) {
        let mut closers = vec![end];
        closers.extend(more.iter().map(|close| (*close).to_owned()));
        return Some(closers);
    }
    let after = &lower[node.span.end as usize..];
    let written = format!("@{end}");
    after
        .match_indices(&written)
        .any(|(at, _)| !after[at + written.len()..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
        .then(|| vec![end])
}

/// After the `>` ending the tag whose name ends at `from` (quotes and Blade
/// constructs in its attributes skipped); the end of the text when open.
fn tag_end(b: &[u8], from: usize, opaque: &[Span<u32>]) -> usize {
    let mut i = from;
    let mut quote: Option<u8> = None;
    while i < b.len() {
        // `opaque` is sorted by start.
        if let Ok(at) = opaque.binary_search_by_key(&(i as u32), |span| span.start) {
            i = (opaque[at].end as usize).max(i + 1);
            continue;
        }
        match (quote, b[i]) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, c @ (b'"' | b'\'')) => quote = Some(c),
            (None, b'>') => return i + 1,
            (None, b'<') => return i,
            _ => {}
        }
        i += 1;
    }
    b.len()
}

/// The `@verbatim … @endverbatim` spans of `text` (the parser skips them).
fn verbatim(text: &str) -> Vec<Span<u32>> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find("@verbatim") {
        let start = from + at;
        let end = text[start..].find("@endverbatim").map_or(text.len(), |at| start + at);
        out.push(start as u32..end as u32);
        from = end.max(start + 1);
    }
    out
}

/// The edits turning `text` into `formatted` (from [`format`], which
/// changes lines in place): one per changed line, only those from
/// `lines.0` to `lines.1` when given (a range format); the whole text also
/// gets its trailing blank lines and final line break.
pub fn edits(text: &str, formatted: &str, lines: Option<(u32, u32)>) -> Vec<ide_core::TextEdit> {
    use ide_core::{Pos, Range, TextEdit};
    let utf16 = |s: &str| s.encode_utf16().count() as u32;
    let bare = |line: &str| line.strip_suffix('\r').unwrap_or(line).to_owned();
    let old: Vec<&str> = text.split('\n').collect();
    let new: Vec<&str> = formatted.split('\n').collect();
    let common = old.len().min(new.len());
    let wanted = |line: usize| lines.is_none_or(|(from, to)| (from as usize..=to as usize).contains(&line));
    let mut out = Vec::new();
    for line in 0..common {
        let (was, now) = (bare(old[line]), bare(new[line]));
        if was != now && wanted(line) {
            let range = Range::new(Pos::new(line as u32, 0), Pos::new(line as u32, utf16(&was)));
            out.push(TextEdit { range, new_text: now });
        }
    }
    if lines.is_none() && old.len() != new.len() && common > 0 {
        let last = common - 1;
        let start = Pos::new(last as u32, utf16(&bare(old[last])));
        let end = Pos::new((old.len() - 1) as u32, utf16(old[old.len() - 1]));
        let kept: usize = new[..last].iter().map(|line| line.len() + 1).sum::<usize>() + bare(new[last]).len();
        out.push(TextEdit { range: Range::new(start, end), new_text: formatted[kept..].to_owned() });
    }
    out
}
