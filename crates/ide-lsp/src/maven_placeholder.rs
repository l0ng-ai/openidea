//! `@property@` placeholders in YAML resources: Maven resource filtering replaces
//! them before the file is ever read as YAML, so Spring projects use them unquoted
//! (`spring.profiles.active: @profileActive@`). The YAML spec reserves `@` and the
//! `yaml` parser behind `yaml-language-server` therefore reports
//! "Plain value cannot start with reserved character @" for every one of them.
//! The diagnostic is dropped when the reported scalar is exactly a Maven
//! placeholder; anything else the parser flags keeps showing.

use lsp_types as lsp;

const RESERVED_AT: &str = "Plain value cannot start with reserved character @";

/// Whether `diagnostic` is the reserved-`@` parser error on a scalar whose text in
/// `text` is exactly a Maven placeholder (`@token@`).
pub(crate) fn false_positive(text: &str, diagnostic: &lsp::Diagnostic) -> bool {
    diagnostic.message == RESERVED_AT && placeholder_at(text, &diagnostic.range).is_some()
}

/// The name between the `@`s of the diagnostic range, when it covers one whole placeholder.
fn placeholder_at(text: &str, range: &lsp::Range) -> Option<String> {
    if range.start.line != range.end.line {
        return None;
    }
    let line = text.split_inclusive('\n').nth(range.start.line as usize)?;
    let line = line.trim_end_matches(['\n', '\r']);
    let start = utf16_to_byte(line, range.start.character)?.min(line.len());
    // The parser's scalar range ends one past the line (its newline), so the end clamps.
    let end = utf16_to_byte(line, range.end.character).unwrap_or(line.len());
    if end < start {
        return None;
    }
    let inner = line[start..end].strip_prefix('@')?.strip_suffix('@')?;
    (!inner.is_empty() && inner.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')))
        .then(|| inner.to_owned())
}

/// UTF-16 column → byte offset within one line, `None` inside a surrogate pair or past the line.
fn utf16_to_byte(line: &str, col: u32) -> Option<usize> {
    let col = col as usize;
    let mut units = 0usize;
    for (byte, c) in line.char_indices() {
        if units == col {
            return Some(byte);
        }
        units += c.len_utf16();
        if units > col {
            return None;
        }
    }
    (units == col).then_some(line.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::{Position, Range};

    fn at(line: u32, from: u32, to: u32) -> Range {
        Range { start: Position::new(line, from), end: Position::new(line, to) }
    }

    fn across(from: (u32, u32), to: (u32, u32)) -> Range {
        Range { start: Position::new(from.0, from.1), end: Position::new(to.0, to.1) }
    }

    fn diagnostic(range: Range) -> lsp::Diagnostic {
        lsp::Diagnostic { range, message: RESERVED_AT.to_owned(), ..Default::default() }
    }

    #[test]
    fn a_maven_placeholder_placeholder_is_a_false_positive() {
        let text = "spring:\n  profiles:\n    active: @profileActive@\n";
        assert!(false_positive(text, &diagnostic(at(2, 12, 27))));
        // The parser ends the scalar's range one past the line (its newline): still caught.
        assert!(false_positive(text, &diagnostic(at(2, 12, 28))));
        // Columns also decode on a line with non-ASCII text before the scalar.
        let text = "name: 项目\nvalue: @profileActive@\n";
        assert!(false_positive(text, &diagnostic(at(1, 7, 22))));
    }

    #[test]
    fn other_reserved_character_errors_and_shapes_still_show() {
        let text = "active: @profileActive@\n";
        // Not the parser's message (a backtick, a different wording).
        assert!(!false_positive(
            text,
            &lsp::Diagnostic {
                message: "Plain value cannot start with reserved character `".to_owned(),
                ..diagnostic(at(0, 8, 11))
            }
        ));
        // The error's range is stale and no longer covers a placeholder.
        assert!(!false_positive(text, &diagnostic(at(0, 0, 10))));
        // A single `@`, an unpaired one or a name with spaces is no placeholder.
        assert!(!false_positive("active: @\n", &diagnostic(at(0, 8, 9))));
        assert!(!false_positive("active: @profile\n", &diagnostic(at(0, 8, 16))));
        assert!(!false_positive("active: @pro file@\n", &diagnostic(at(0, 8, 18))));
        // A range crossing lines is kept.
        assert!(!false_positive("a: @x@\nb: y\n", &diagnostic(across((0, 3), (1, 0)))));
    }

    #[test]
    fn utf16_columns_decode_multi_byte_and_surrogate_pairs() {
        // "é" is one UTF-16 unit; "😀" is two, and a column inside it is out of range.
        let line = "é😀@token@";
        assert_eq!(utf16_to_byte(line, 0), Some(0));
        assert_eq!(utf16_to_byte(line, 1), Some(2));
        assert_eq!(utf16_to_byte(line, 2), None);
        assert_eq!(utf16_to_byte(line, 3), Some(6));
        assert_eq!(utf16_to_byte(line, 4), Some(7));
        assert_eq!(utf16_to_byte(line, 10), Some(line.len()));
    }
}
