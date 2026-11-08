//! Blade templates (Laravel's `*.blade.php` views).
//!
//! [`parse`] splits a template into the parts Blade gives a meaning:
//! comments, echoes (`{{ }}`, `{!! !!}`), PHP blocks (`@php … @endphp`,
//! `<?php … ?>`) and directives (`@if (…)`, `@include(…)`); everything else
//! is HTML. [`compile`] turns those parts into a PHP document — echoes into
//! `echo` statements, control directives into the PHP control structures
//! they stand for, other directives' arguments into array expressions — and
//! keeps where every piece of PHP came from ([`Compiled`]), so the engine
//! answers completion, hover, signature help and goto on the embedded PHP
//! ([`BladeDocument`] and the `blade_*` methods of the engine), with the
//! positions mapped both ways. [`views`] resolves view names and
//! components (`@include('a.b')`, `<x-alert>`) to their files.
//!
//! The directive grammar follows Laravel's `BladeCompiler` (MIT): a directive
//! is `@name` not preceded by a word character, optionally followed by
//! spaces and balanced parentheses; `@@name` and `@{{ }}` escape.

mod engine;
pub mod structure;
pub mod tags;
pub mod views;

#[cfg(test)]
mod tests;

use std::ops::Range as Span;

use ide_core::{Pos, Range};

pub use engine::BladeDocument;

use crate::syntax::LineIndex;

/// The directives the compiler knows (Laravel 11's built-ins and the common
/// package ones): only these are directives; any other `@word` (an e-mail,
/// a CSS at-rule, an Alpine `@click`) is HTML. Completion offers them.
pub const DIRECTIVES: &[&str] = &[
    "append",
    "auth",
    "aware",
    "break",
    "can",
    "canany",
    "cannot",
    "case",
    "checked",
    "choice",
    "class",
    "component",
    "componentFirst",
    "continue",
    "csrf",
    "dd",
    "default",
    "disabled",
    "dump",
    "each",
    "else",
    "elseauth",
    "elsecan",
    "elsecanany",
    "elsecannot",
    "elseenv",
    "elseguest",
    "elseif",
    "empty",
    "endauth",
    "endcan",
    "endcanany",
    "endcannot",
    "endcomponent",
    "endcomponentClass",
    "endempty",
    "endenv",
    "enderror",
    "endfor",
    "endforeach",
    "endforelse",
    "endfragment",
    "endguest",
    "endif",
    "endisset",
    "endonce",
    "endPushOnce",
    "endPrependOnce",
    "endphp",
    "endprepend",
    "endproduction",
    "endpush",
    "endpushIf",
    "endsection",
    "endsession",
    "endslot",
    "endswitch",
    "endunless",
    "endverbatim",
    "endwhile",
    "env",
    "error",
    "extends",
    "extendsFirst",
    "for",
    "foreach",
    "forelse",
    "fragment",
    "guest",
    "hasSection",
    "if",
    "include",
    "includeFirst",
    "includeIf",
    "includeUnless",
    "includeWhen",
    "inject",
    "isset",
    "js",
    "json",
    "lang",
    "livewire",
    "livewireScripts",
    "livewireStyles",
    "method",
    "once",
    "overwrite",
    "parent",
    "php",
    "prepend",
    "prependOnce",
    "production",
    "props",
    "push",
    "pushIf",
    "pushOnce",
    "readonly",
    "required",
    "section",
    "sectionMissing",
    "selected",
    "session",
    "show",
    "slot",
    "stack",
    "stop",
    "style",
    "switch",
    "unless",
    "use",
    "verbatim",
    "vite",
    "viteReactRefresh",
    "while",
    "yield",
];

/// Whether `name` is one of the [`DIRECTIVES`].
pub fn is_directive(name: &str) -> bool {
    DIRECTIVES.contains(&name)
}

/// What a [`Node`] is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeKind {
    /// `{{-- … --}}`.
    Comment,
    /// `{{ … }}` (`raw: false`), `{!! … !!}` or `<?= … ?>` (`raw: true`).
    Echo { raw: bool },
    /// `@php … @endphp` or `<?php … ?>`: PHP statements.
    Php,
    /// `@name`, with the arguments between its parentheses as the code.
    Directive { name: String },
    /// A bound attribute of a component tag (`:message="$m"`, `:$m`), with
    /// its PHP expression as the code.
    Bound,
}

/// One Blade construct of a template.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub kind: NodeKind,
    /// The whole construct, delimiters included (byte offsets).
    pub span: Span<u32>,
    /// The PHP inside: the expression of an echo, the statements of a PHP
    /// block, the arguments of a directive (without the parentheses;
    /// `None` when it has none). It runs to the end of the text (of the
    /// line, for directive arguments) while it isn't closed yet.
    pub code: Option<Span<u32>>,
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn find(b: &[u8], from: usize, pattern: &[u8]) -> Option<usize> {
    if from > b.len() {
        return None;
    }
    b[from..].windows(pattern.len()).position(|w| w == pattern).map(|at| at + from)
}

/// The `)` closing the `(` at `open`, skipping quoted strings.
fn close_paren(b: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            quote @ (b'\'' | b'"') => {
                i += 1;
                while i < b.len() && b[i] != quote {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The Blade constructs of `text`, in order.
pub fn parse(text: &str) -> Vec<Node> {
    parse_with(text, &[])
}

/// [`parse`], with `custom` directives (`Blade::directive('money', …)`)
/// besides the built-in ones.
pub fn parse_with(text: &str, custom: &[String]) -> Vec<Node> {
    let b = text.as_bytes();
    let n = b.len();
    let mut nodes = Vec::new();
    let mut i = 0;
    let span = |start: usize, end: usize| start as u32..end as u32;
    // The PHP of bound attributes, skipped by the scan.
    let mut bound: Vec<Span<u32>> = Vec::new();
    while i < n {
        if let Some(skip) = bound.iter().find(|code| code.start as usize <= i && i < code.end as usize) {
            i = skip.end as usize;
            continue;
        }
        let rest = &b[i..];
        if rest.starts_with(b"<x-") || rest.starts_with(b"<x:") {
            if let Some(tag) = tags::tag_at(text, i) {
                for attribute in &tag.attributes {
                    if let Some(code) = attribute.bound_code(text) {
                        let span = attribute.name.start..code.end;
                        nodes.push(Node { kind: NodeKind::Bound, span, code: Some(code.clone()) });
                        bound.push(code);
                    }
                }
            }
            i += 1;
        } else if rest.starts_with(b"{{--") {
            let end = find(b, i + 4, b"--}}").map_or(n, |at| at + 4);
            nodes.push(Node { kind: NodeKind::Comment, span: span(i, end), code: None });
            i = end;
        } else if rest.starts_with(b"@{{") {
            // Escaped: the braces are output as they are.
            i = find(b, i + 3, b"}}").map_or(n, |at| at + 2);
        } else if rest.starts_with(b"{!!") {
            let close = find(b, i + 3, b"!!}");
            let end = close.map_or(n, |at| at + 3);
            let code = span(i + 3, close.unwrap_or(n));
            nodes.push(Node { kind: NodeKind::Echo { raw: true }, span: span(i, end), code: Some(code) });
            i = end;
        } else if rest.starts_with(b"{{") {
            let close = find(b, i + 2, b"}}");
            let end = close.map_or(n, |at| at + 2);
            let code = span(i + 2, close.unwrap_or(n));
            nodes.push(Node { kind: NodeKind::Echo { raw: false }, span: span(i, end), code: Some(code) });
            i = end;
        } else if rest.starts_with(b"<?php") || rest.starts_with(b"<?=") {
            let (start, kind) =
                if rest.starts_with(b"<?=") { (i + 3, NodeKind::Echo { raw: true }) } else { (i + 5, NodeKind::Php) };
            let close = find(b, start, b"?>");
            let end = close.map_or(n, |at| at + 2);
            nodes.push(Node { kind, span: span(i, end), code: Some(span(start, close.unwrap_or(n))) });
            i = end;
        } else if b[i] == b'@' && (i == 0 || !is_word(b[i - 1])) {
            if b.get(i + 1) == Some(&b'@') {
                // `@@if`: the directive written out.
                i += 2;
                while i < n && is_word(b[i]) {
                    i += 1;
                }
                continue;
            }
            let name_end = (i + 1..n).find(|&at| !is_word(b[at])).unwrap_or(n);
            let name = &text[i + 1..name_end];
            if name.is_empty() || !is_directive(name) && !custom.iter().any(|known| known == name) {
                i = name_end.max(i + 1);
                continue;
            }
            if name == "verbatim" {
                i = find(b, name_end, b"@endverbatim").map_or(n, |at| at + "@endverbatim".len());
                continue;
            }
            let mut after = name_end;
            while after < n && matches!(b[after], b' ' | b'\t') {
                after += 1;
            }
            let has_args = b.get(after) == Some(&b'(');
            if name == "php" && !has_args {
                let close = find(b, name_end, b"@endphp");
                let end = close.map_or(n, |at| at + "@endphp".len());
                let code = span(name_end, close.unwrap_or(n));
                nodes.push(Node { kind: NodeKind::Php, span: span(i, end), code: Some(code) });
                i = end;
                continue;
            }
            let (end, code) = if has_args {
                match close_paren(b, after) {
                    Some(close) => (close + 1, Some(span(after + 1, close))),
                    None => {
                        let eol = find(b, after, b"\n").unwrap_or(n);
                        (eol, Some(span(after + 1, eol)))
                    }
                }
            } else {
                (name_end, None)
            };
            nodes.push(Node { kind: NodeKind::Directive { name: name.to_owned() }, span: span(i, end), code });
            i = end;
        } else {
            i += 1;
        }
    }
    nodes.sort_by_key(|node| node.span.start);
    nodes
}

/// A piece of PHP copied from the template.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Segment {
    blade: u32,
    php: u32,
    len: u32,
}

/// The PHP compiled from a template, with the map between the two.
#[derive(Clone, Debug)]
pub struct Compiled {
    /// The PHP document.
    pub php: String,
    segments: Vec<Segment>,
    blade_lines: LineIndex,
    php_lines: LineIndex,
}

impl Compiled {
    /// The byte offset in the PHP of byte `offset` of the template, when it
    /// is in (or at the end of) embedded PHP.
    pub fn php_offset(&self, offset: u32) -> Option<u32> {
        self.segments
            .iter()
            .find(|s| s.blade <= offset && offset <= s.blade + s.len)
            .map(|s| s.php + (offset - s.blade))
    }

    /// The byte offset in the template of byte `offset` of the PHP, when it
    /// was copied from the template.
    pub fn blade_offset(&self, offset: u32) -> Option<u32> {
        self.segments.iter().find(|s| s.php <= offset && offset <= s.php + s.len).map(|s| s.blade + (offset - s.php))
    }

    /// The position in the PHP of `pos` in the template; `None` outside
    /// embedded PHP.
    pub fn to_php(&self, pos: Pos) -> Option<Pos> {
        let offset = self.php_offset(self.blade_lines.byte(pos))?;
        Some(self.php_lines.pos(offset))
    }

    /// The position in the template of `pos` in the PHP; `None` for the PHP
    /// the compiler wrote.
    pub fn to_blade(&self, pos: Pos) -> Option<Pos> {
        let offset = self.blade_offset(self.php_lines.byte(pos))?;
        Some(self.blade_lines.pos(offset))
    }

    /// [`to_blade`](Self::to_blade) of both ends.
    pub fn range_to_blade(&self, range: Range) -> Option<Range> {
        Some(Range::new(self.to_blade(range.start)?, self.to_blade(range.end)?))
    }
}

/// Builds the PHP and its map.
struct Out<'t> {
    text: &'t str,
    php: String,
    segments: Vec<Segment>,
}

impl Out<'_> {
    fn push(&mut self, php: &str) {
        self.php.push_str(php);
    }

    /// Copies `span` of the template.
    fn code(&mut self, span: &Span<u32>) {
        let segment = Segment { blade: span.start, php: self.php.len() as u32, len: span.end - span.start };
        self.segments.push(segment);
        self.php.push_str(&self.text[span.start as usize..span.end as usize]);
    }

    /// Copies `span`, or writes `fallback` when there is none.
    fn code_or(&mut self, span: Option<&Span<u32>>, fallback: &str) {
        match span {
            Some(span) => self.code(span),
            None => self.push(fallback),
        }
    }
}

/// The PHP block a directive opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Block {
    /// An `if` that `@elseif` and `@else` continue.
    If,
    Plain,
    Loop,
    Switch,
}

/// The string literals among a directive's arguments: `(content, its span
/// without the quotes)`.
pub(crate) fn string_args(text: &str, code: &Span<u32>) -> Vec<(String, Span<u32>)> {
    let b = text.as_bytes();
    let mut found = Vec::new();
    let mut i = code.start as usize;
    let end = code.end as usize;
    while i < end {
        let quote = b[i];
        if quote == b'\'' || quote == b'"' {
            let start = i + 1;
            let mut j = start;
            while j < end && b[j] != quote {
                if b[j] == b'\\' {
                    j += 1;
                }
                j += 1;
            }
            let close = j.min(end);
            found.push((text[start..close].replace("\\\\", "\\"), start as u32..close as u32));
            i = close + 1;
        } else {
            i += 1;
        }
    }
    found
}

/// The prefix of the function a view directive compiles to:
/// `@include('a', [...])` is `__blade_include('a', [...]);`, so the view
/// name is a string argument of a call (the `viewName` string reference)
/// and the data array is typed like any other.
pub const VIEW_CALL_PREFIX: &str = "__blade_";

/// Compiles `text` to PHP. `component`: the template is a component view
/// (below `views/components/`), so `$attributes` and `$slot` are defined.
pub fn compile(text: &str, component: bool) -> Compiled {
    compile_with(text, component, &[], &[])
}

/// [`compile`], with `variables` (`(name, type)`, the variables the view's
/// callers pass it) declared at the top, and `custom` directives.
pub fn compile_with(text: &str, component: bool, variables: &[(String, String)], custom: &[String]) -> Compiled {
    let nodes = parse_with(text, custom);
    let mut out = Out { text, php: String::from("<?php\n"), segments: Vec::new() };

    // `@use` imports go first: PHP takes them only at the top level.
    for node in &nodes {
        if let (NodeKind::Directive { name }, Some(code)) = (&node.kind, &node.code)
            && name == "use"
        {
            let strings = string_args(text, code);
            if let Some((_, class)) = strings.first() {
                out.push("use ");
                out.code(class);
                if let Some((alias, _)) = strings.get(1) {
                    out.push(" as ");
                    out.push(alias);
                }
                out.push(";\n");
            }
        }
    }
    let mut defined = vec![("\\Illuminate\\Support\\ViewErrorBag", "errors")];
    if component {
        defined.push(("\\Illuminate\\View\\ComponentAttributeBag", "attributes"));
        defined.push(("\\Illuminate\\View\\ComponentSlot", "slot"));
    }
    for (class, name) in &defined {
        out.push(&format!("/** @var {class} ${name} */\n${name} = null;\n"));
    }
    for (name, ty) in variables {
        if is_identifier(name) && name != "this" && !defined.iter().any(|(_, known)| known == name) {
            out.push(&format!("/** @var {ty} ${name} */\n${name} = null;\n"));
        }
    }

    let mut blocks: Vec<Block> = Vec::new();
    for node in &nodes {
        let code = node.code.as_ref();
        match &node.kind {
            NodeKind::Comment => {}
            NodeKind::Echo { .. } => {
                out.push("echo ");
                out.code_or(code, "''");
                out.push(";\n");
            }
            NodeKind::Php => {
                if let Some(code) = code {
                    out.code(code);
                }
                out.push("\n;\n");
            }
            NodeKind::Bound => {
                out.push("(");
                out.code_or(code, "null");
                out.push(");\n");
            }
            NodeKind::Directive { name } => directive(&mut out, &mut blocks, name, code),
        }
    }
    for _ in blocks {
        out.push("}\n");
    }
    let blade_lines = LineIndex::new(text);
    let php_lines = LineIndex::new(&out.php);
    Compiled { php: out.php, segments: out.segments, blade_lines, php_lines }
}

fn directive(out: &mut Out, blocks: &mut Vec<Block>, name: &str, code: Option<&Span<u32>>) {
    let open = |out: &mut Out, blocks: &mut Vec<Block>, before: &str, after: &str, block: Block| {
        out.push(before);
        out.code_or(code, "true");
        out.push(after);
        blocks.push(block);
    };
    // `} else {` in an `if`, `} {` after a loop (`@forelse … @empty`), a
    // block of its own when nothing is open.
    let otherwise = |out: &mut Out, blocks: &mut Vec<Block>| match blocks.last() {
        None => {
            blocks.push(Block::Plain);
            out.push("{\n");
        }
        Some(Block::If) => {
            out.push("} else {\n");
            // Nothing continues an `else`.
            blocks.pop();
            blocks.push(Block::Plain);
        }
        Some(_) => out.push("} {\n"),
    };
    let close = |out: &mut Out, blocks: &mut Vec<Block>| {
        if blocks.pop().is_some() {
            out.push("}\n");
        }
    };
    let generic = |out: &mut Out| {
        if let Some(code) = code {
            out.push("[");
            out.code(code);
            out.push("];\n");
        }
    };
    match name {
        "if" => open(out, blocks, "if (", ") {\n", Block::If),
        "unless" => open(out, blocks, "if (!(", ")) {\n", Block::If),
        "isset" => open(out, blocks, "if (isset(", ")) {\n", Block::If),
        "empty" if code.is_some() => open(out, blocks, "if (empty(", ")) {\n", Block::If),
        "while" => open(out, blocks, "while (", ") {\n", Block::Loop),
        "for" if code.is_some() => open(out, blocks, "for (", ") {\n", Block::Loop),
        "foreach" | "forelse" if code.is_some() => {
            open(out, blocks, "foreach (", ") {\n/** @var \\stdClass $loop */\n$loop = null;\n", Block::Loop)
        }
        "for" | "foreach" | "forelse" => open(out, blocks, "if (", ") {\n", Block::Loop),
        "switch" => open(out, blocks, "switch (", ") {\n", Block::Switch),
        "elseif" if blocks.last() == Some(&Block::If) => {
            out.push("} elseif (");
            out.code_or(code, "true");
            out.push(") {\n");
        }
        "elseif" => {
            otherwise(out, blocks);
            open(out, blocks, "if (", ") {\n", Block::Plain);
            blocks.pop();
            out.push("}\n");
        }
        // `@empty` without arguments: the one of a `@forelse`.
        "else" | "empty" => otherwise(out, blocks),
        "case" if blocks.last() == Some(&Block::Switch) => {
            out.push("case ");
            out.code_or(code, "null");
            out.push(":\n");
        }
        "default" if blocks.last() == Some(&Block::Switch) => out.push("default:\n"),
        "break" | "continue" if blocks.iter().any(|b| matches!(b, Block::Loop | Block::Switch)) => match code {
            Some(code) => {
                out.push("if (");
                out.code(code);
                out.push(&format!(") {{ {name}; }}\n"));
            }
            None => out.push(&format!("{name};\n")),
        },
        "error" => {
            generic(out);
            out.push("if (true) {\n/** @var string $message */\n$message = null;\n");
            blocks.push(Block::Plain);
        }
        "endif" | "endunless" | "endisset" | "endempty" | "endwhile" | "endfor" | "endforeach" | "endforelse"
        | "endswitch" | "enderror" => close(out, blocks),
        "php" => {
            if let Some(code) = code {
                out.code(code);
                out.push(";\n");
            }
        }
        "inject" => {
            let strings = code.map(|code| string_args(out.text, code)).unwrap_or_default();
            match strings.as_slice() {
                [(variable, _), (class, _), ..] if is_identifier(variable) => {
                    let class = class.trim_start_matches('\\');
                    out.push(&format!("/** @var \\{class} ${variable} */\n${variable} = null;\n"));
                }
                _ => generic(out),
            }
        }
        "use" => {}
        _ if views::VIEW_DIRECTIVES.contains(&name) && code.is_some() => {
            out.push(&format!("{VIEW_CALL_PREFIX}{name}("));
            out.code_or(code, "");
            out.push(
                ");
",
            );
        }
        _ => generic(out),
    }
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A directive name to complete: the word after an `@` at `pos` (outside
/// echoes and PHP blocks), with the range it covers, `@` excluded.
pub fn directive_prefix(text: &str, pos: Pos) -> Option<(String, Range)> {
    let lines = LineIndex::new(text);
    let offset = lines.byte(pos) as usize;
    let b = text.as_bytes();
    let start = (0..offset).rev().find(|&at| !is_word(b[at])).map_or(0, |at| at + 1);
    if start == 0 || b[start - 1] != b'@' || (start >= 2 && is_word(b[start - 2])) {
        return None;
    }
    let at = start as u32 - 1;
    let inside = parse(text).iter().any(|node| {
        !matches!(node.kind, NodeKind::Directive { .. }) && node.span.start < at && at < node.span.end
            || node.code.as_ref().is_some_and(|code| code.start <= at && at < code.end)
    });
    if inside {
        return None;
    }
    let end = (offset..b.len()).find(|&at| !is_word(b[at])).unwrap_or(b.len());
    Some((text[start..offset].to_owned(), lines.range(start as u32, end as u32)))
}
