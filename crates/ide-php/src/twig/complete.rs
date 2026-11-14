//! Completion in Twig templates.
//!
//! The context comes from the text before the caret: the `{{`/`{%` the caret
//! is in (nothing in text or `{# comments #}`), whether it's in a string,
//! and what precedes the word being typed:
//!
//! - the first word of `{%`: tags
//! - after `|` (or `{% apply`): filters
//! - after `is` / `is not`: tests
//! - after `.`: nothing (attributes aren't known)
//! - in the string of `extends`, `include`, `embed`, `import`, `from`, `use`,
//!   `include(` or `source(`: template names
//! - anywhere else in an expression: the variables and macros in scope, the
//!   functions, and the globals.
//!
//! The variables in scope come from the parsed template with the tag being
//! typed blanked out (a half-written tag would end the parse there).

use ide_core::{Pos, Range};

use super::builtins::{self, Builtin};
use super::recover::blank;
use super::templates::TemplatePaths;
use super::{ScopeKind, scope_names, with_template};
use crate::syntax::LineIndex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TwigCompletionKind {
    Variable,
    Macro,
    Tag,
    Filter,
    Function,
    Test,
    Template,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TwigCompletion {
    pub label: String,
    pub kind: TwigCompletionKind,
    /// The arguments (`(format = null, timezone = null)`) or where the name comes from.
    pub detail: Option<String>,
    /// Markdown.
    pub documentation: Option<String>,
    pub insert_text: String,
    /// Groups variables before macros before the built-ins.
    pub sort_text: String,
    /// The word (or template name) the item replaces.
    pub replace: Range,
}

/// Where the caret is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Context {
    Tag,
    Filter,
    Test,
    Expression,
    Template,
}

/// Tags whose first argument is a template name.
const TEMPLATE_TAGS: &[&str] = &["extends", "include", "embed", "import", "from", "use"];

/// Completions at `pos`. `symfony` adds what the Symfony Twig bridge
/// defines; `templates` lists the template names.
pub fn completions(text: &str, pos: Pos, symfony: bool, templates: &TemplatePaths) -> Vec<TwigCompletion> {
    let index = LineIndex::new(text);
    let offset = index.byte(pos) as usize;
    let Some(found) = context_at(text, offset) else { return Vec::new() };
    let replace = index.range(found.start as u32, found.end as u32);
    let mut out = Vec::new();
    let builtin = |out: &mut Vec<TwigCompletion>, list: &[Builtin], kind, rank: &str, source: Option<&str>| {
        for b in list {
            out.push(TwigCompletion {
                label: b.name.to_string(),
                kind,
                detail: b.signature.map(str::to_string).or_else(|| source.map(str::to_string)),
                documentation: Some(b.doc.to_string()),
                insert_text: b.name.to_string(),
                sort_text: format!("{rank}{}", b.name),
                replace,
            });
        }
    };
    match found.context {
        Context::Tag => {
            builtin(&mut out, builtins::TAGS, TwigCompletionKind::Tag, "2", None);
            if symfony {
                builtin(&mut out, builtins::SYMFONY_TAGS, TwigCompletionKind::Tag, "2", Some("Symfony"));
            }
        }
        Context::Filter => {
            builtin(&mut out, builtins::FILTERS, TwigCompletionKind::Filter, "2", None);
            if symfony {
                builtin(&mut out, builtins::SYMFONY_FILTERS, TwigCompletionKind::Filter, "2", Some("Symfony"));
            }
        }
        Context::Test => builtin(&mut out, builtins::TESTS, TwigCompletionKind::Test, "2", None),
        Context::Template => {
            for name in templates.names() {
                out.push(TwigCompletion {
                    label: name.clone(),
                    kind: TwigCompletionKind::Template,
                    detail: None,
                    documentation: None,
                    insert_text: name.clone(),
                    sort_text: name,
                    replace,
                });
            }
        }
        Context::Expression => {
            let blanked = blank(text, found.tag.0, found.tag.1);
            let names = with_template(&blanked, |text, template| scope_names(text, template, offset as u32));
            for name in names {
                let (kind, rank, doc) = match name.kind {
                    ScopeKind::Variable => (TwigCompletionKind::Variable, "0", None),
                    ScopeKind::Loop => (TwigCompletionKind::Variable, "0", Some(builtins::LOOP.doc.to_string())),
                    ScopeKind::MacroNamespace => (TwigCompletionKind::Variable, "1", None),
                    ScopeKind::Macro => (TwigCompletionKind::Macro, "1", None),
                };
                out.push(TwigCompletion {
                    sort_text: format!("{rank}{}", name.name),
                    label: name.name.clone(),
                    kind,
                    detail: name.detail,
                    documentation: doc,
                    insert_text: name.name,
                    replace,
                });
            }
            builtin(&mut out, builtins::GLOBALS, TwigCompletionKind::Variable, "1", None);
            builtin(&mut out, builtins::FUNCTIONS, TwigCompletionKind::Function, "2", None);
            if symfony {
                builtin(&mut out, builtins::SYMFONY_GLOBALS, TwigCompletionKind::Variable, "1", Some("Symfony"));
                builtin(&mut out, builtins::SYMFONY_FUNCTIONS, TwigCompletionKind::Function, "2", Some("Symfony"));
            }
        }
    }
    out
}

struct Found {
    context: Context,
    /// Byte range replaced by an item.
    start: usize,
    end: usize,
    /// Byte range of the tag around the caret (from `{{`/`{%` to its closing
    /// delimiter, or to the end of the word when it isn't closed yet).
    tag: (usize, usize),
}

fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn context_at(text: &str, offset: usize) -> Option<Found> {
    let bytes = text.as_bytes();
    let before = text.get(..offset)?;
    // The last delimiter opening before the caret.
    let (open, kind) =
        ["{{", "{%", "{#"].iter().filter_map(|d| before.rfind(d).map(|at| (at, *d))).max_by_key(|(at, _)| *at)?;
    let close = match kind {
        "{{" => "}}",
        "{%" => "%}",
        _ => return None,
    };
    let mut inner_start = open + 2;
    if inner_start < offset && matches!(bytes.get(inner_start), Some(b'-' | b'~')) {
        inner_start += 1;
    }
    if before.get(inner_start..).is_some_and(|inner| inner.contains(close)) {
        return None;
    }
    let mut word_start = offset;
    while word_start > inner_start && is_word(bytes[word_start - 1]) {
        word_start -= 1;
    }
    let mut word_end = offset;
    while word_end < bytes.len() && is_word(bytes[word_end]) {
        word_end += 1;
    }
    // The closing delimiter, unless another tag opens first (this one isn't closed yet).
    let after = &text[offset..];
    let next_open = ["{{", "{%", "{#"].iter().filter_map(|d| after.find(d)).min();
    let tag_end = after
        .find(close)
        .filter(|at| next_open.is_none_or(|next| *at < next))
        .map_or(word_end, |at| offset + at + close.len());
    let tag = (open, tag_end);
    let inner = &text[inner_start..offset];
    let keyword: String = inner.trim_start().bytes().take_while(|c| is_word(*c)).map(char::from).collect();

    if let Some(quote) = open_quote(inner) {
        let content_start = inner_start + quote + 1;
        let quote_char = bytes[inner_start + quote];
        let lead = inner[..quote].trim_end();
        // The template comes first in these tags: a string after `(` or `{`
        // is an argument or a `with` value instead.
        let in_template_tag = kind == "{%" && TEMPLATE_TAGS.contains(&keyword.as_str()) && !lead.contains(['(', '{']);
        let in_function = lead
            .strip_suffix('(')
            .map(str::trim_end)
            .is_some_and(|callee| ["include", "source"].iter().any(|f| ends_with_word(callee, f)));
        if !(in_template_tag || in_function) {
            return None;
        }
        let mut end = offset;
        while end < bytes.len() && bytes[end] != quote_char && bytes[end] != b'\n' {
            end += 1;
        }
        return Some(Found { context: Context::Template, start: content_start, end, tag });
    }

    let lead = text[inner_start..word_start].trim_end();
    let context = if lead.ends_with('|') {
        Context::Filter
    } else if lead.ends_with('.') {
        return None;
    } else if ends_with_word(lead, "is") || ends_with_word(lead, "is not") {
        Context::Test
    } else if kind == "{%" && lead.is_empty() {
        Context::Tag
    } else if kind == "{%" && keyword == "apply" {
        Context::Filter
    } else {
        Context::Expression
    };
    Some(Found { context, start: word_start, end: word_end, tag })
}

/// Whether `text` ends with the words `word` (not as the tail of a longer word).
fn ends_with_word(text: &str, words: &str) -> bool {
    let words: Vec<&str> = words.split_whitespace().collect();
    let parts: Vec<&str> = text.split_whitespace().collect();
    if parts.len() < words.len() {
        return false;
    }
    let tail = &parts[parts.len() - words.len()..];
    // The first word may be glued to punctuation: `(include`, `,source`.
    tail.iter().zip(&words).enumerate().all(|(i, (got, want))| {
        got == want
            || (i == 0
                && got
                    .strip_suffix(want)
                    .is_some_and(|rest| rest.ends_with(|c: char| !c.is_alphanumeric() && c != '_')))
    })
}

/// The byte offset of the quote opening the string `inner` ends in, if it
/// ends inside one.
fn open_quote(inner: &str) -> Option<usize> {
    let mut open: Option<(usize, u8)> = None;
    let mut escaped = false;
    for (at, c) in inner.bytes().enumerate() {
        match open {
            Some((_, quote)) => {
                if escaped {
                    escaped = false;
                } else if c == b'\\' {
                    escaped = true;
                } else if c == quote {
                    open = None;
                }
            }
            None if c == b'\'' || c == b'"' => open = Some((at, c)),
            None => {}
        }
    }
    open.map(|(at, _)| at)
}
