//! Error recovery on top of `mago-twig-syntax`, whose parser keeps no
//! statements at all when a tag fails to parse (only errors it can defer
//! leave the rest of the template). Editors work on broken templates all
//! the time, so before parsing:
//!
//! 1. the blocks left open (`{% if %}` without `{% endif %}`, …) are closed
//!    by end tags appended after the text, and
//! 2. while the parse fails, the tag at the first error is blanked out
//!    (turned into spaces, newlines kept) and the text parsed again.
//!
//! Offsets and lines of the original text don't move: blanking keeps the
//! length, and the end tags go after the last byte.

use std::borrow::Cow;

use mago_allocator::LocalArena;
use mago_database::file::FileId;
use mago_span::HasSpan;
use mago_twig_syntax::parser::parse_file_content;

/// The most tags blanked before giving up (the template then has no statements).
const MAX_REPAIRS: usize = 16;

/// Tags with a body closed by `end<tag>`.
const BLOCK_TAGS: &[&str] =
    &["if", "for", "block", "macro", "embed", "with", "apply", "autoescape", "sandbox", "guard", "cache", "set"];

/// `text`, repaired so that it parses (see the module docs).
pub(super) fn recovered(text: &str) -> Cow<'_, str> {
    let mut current = Cow::Borrowed(text);
    let closing = missing_end_tags(text);
    if !closing.is_empty() {
        current = Cow::Owned(format!("{text}{closing}"));
    }
    for _ in 0..MAX_REPAIRS {
        let Some(at) = fatal_error(&current) else { break };
        let Some((start, end)) = tag_around(&current, at) else { break };
        if current[start..end].trim().is_empty() {
            break;
        }
        current = Cow::Owned(blank(&current, start, end));
    }
    current
}

/// Where the first error is, when the parse kept no statement.
fn fatal_error(text: &str) -> Option<usize> {
    let arena = LocalArena::new();
    let template = parse_file_content(&arena, FileId::zero(), text.as_bytes());
    if !template.statements.is_empty() {
        return None;
    }
    let first = template.errors.iter().map(|e| e.span().start.offset).min()?;
    Some(first as usize)
}

const OPENERS: [&str; 3] = ["{{", "{%", "{#"];

fn closer(opener: &str) -> &'static str {
    match opener {
        "{{" => "}}",
        "{%" => "%}",
        _ => "#}",
    }
}

/// The tag an error at byte `at` belongs to: from the last delimiter opening
/// at or before it to its closing delimiter (or up to the next tag, or the
/// end, when it isn't closed).
fn tag_around(text: &str, at: usize) -> Option<(usize, usize)> {
    let mut limit = (at + 2).min(text.len());
    while !text.is_char_boundary(limit) {
        limit -= 1;
    }
    let head = &text[..limit];
    let (start, opener) = OPENERS.iter().filter_map(|o| head.rfind(o).map(|at| (at, *o))).max_by_key(|(at, _)| *at)?;
    let rest = &text[start + 2..];
    let next_open = OPENERS.iter().filter_map(|o| rest.find(o)).min();
    let end = match rest.find(closer(opener)) {
        Some(close) if next_open.is_none_or(|next| close < next) => start + 2 + close + 2,
        _ => next_open.map_or(text.len(), |next| start + 2 + next),
    };
    Some((start, end))
}

/// End tags closing the blocks `text` leaves open, innermost first.
fn missing_end_tags(text: &str) -> String {
    let mut open: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("{%") {
        let after = &rest[at + 2..];
        let Some(close) = after.find("%}") else { break };
        let inner = after[..close].trim_matches(|c: char| c == '-' || c == '~' || c.is_whitespace());
        let name: String = inner.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        let args = inner[name.len()..].trim();
        rest = &after[close + 2..];
        if matches!(name.as_str(), "verbatim" | "raw") {
            // The body isn't Twig: skip to its end tag.
            let end = format!("end{name}");
            match rest.find(&end) {
                Some(at) => rest = &rest[at..],
                None => open.push(name),
            }
            continue;
        }
        if let Some(ended) = name.strip_prefix("end") {
            if let Some(at) = open.iter().rposition(|o| o == ended) {
                open.truncate(at);
            }
            continue;
        }
        let has_body = BLOCK_TAGS.contains(&name.as_str())
            && match name.as_str() {
                // `{% set x = 1 %}` and `{% block title 'x' %}` have no body.
                "set" => !args.contains('='),
                "block" => !args.contains(char::is_whitespace),
                _ => true,
            };
        if has_body {
            open.push(name);
        }
    }
    open.iter().rev().map(|name| format!("{{% end{name} %}}")).collect()
}

/// `text` with the bytes `start..end` turned into spaces (newlines kept, so
/// offsets and lines don't move).
pub(super) fn blank(text: &str, start: usize, end: usize) -> String {
    let end = end.min(text.len());
    let mut out = String::with_capacity(text.len());
    for (at, c) in text.char_indices() {
        if at >= start && at < end && c != '\n' && c != '\r' {
            out.extend(std::iter::repeat_n(' ', c.len_utf8()));
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closes_open_blocks_innermost_first() {
        assert_eq!(missing_end_tags("{% if a %}{% for x in y %}{% set z %}"), "{% endset %}{% endfor %}{% endif %}");
        assert_eq!(missing_end_tags("{% if a %}{% endif %}{% set z = 1 %}{% block t 'x' %}"), "");
        assert_eq!(missing_end_tags("{% block b %}{% verbatim %}{% if %}{% endverbatim %}"), "{% endblock %}");
        assert_eq!(missing_end_tags("{%- macro m() -%}{{ x }}"), "{% endmacro %}");
    }

    #[test]
    fn blanks_the_broken_tag_and_keeps_offsets() {
        let text = "{% set a = 1 %}\n{{ a| }}\n{% if %}é";
        let fixed = recovered(text);
        assert_eq!(fixed.len(), text.len() + "{% endif %}".len());
        assert!(fixed.starts_with("{% set a = 1 %}\n"));
        assert!(!fixed.contains("{{"));
        assert_eq!(fixed.lines().count(), text.lines().count());
        assert!(fatal_error(&fixed).is_none());
    }

    #[test]
    fn valid_templates_stay_borrowed() {
        assert!(matches!(recovered("{% if a %}{{ b }}{% endif %}"), Cow::Borrowed(_)));
    }

    #[test]
    fn tag_around_handles_unclosed_tags() {
        assert_eq!(tag_around("ab {{ x {% y %}", 6), Some((3, 8)));
        assert_eq!(tag_around("ab {% x ", 8), Some((3, 8)));
        assert_eq!(tag_around("no tags", 3), None);
    }
}
