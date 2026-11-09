//! Helpers for the editor's coordinates (0-based lines, UTF-16 columns).

use crate::types::Position;

/// Byte offset of `pos` in `text`, if it exists (a column past the end of
/// the line is clamped to it).
pub fn offset(text: &str, pos: Position) -> Option<usize> {
    let mut line_start = 0;
    for _ in 0..pos.line {
        line_start += text[line_start..].find('\n')? + 1;
    }
    let line_end = text[line_start..].find('\n').map_or(text.len(), |i| line_start + i);
    let mut units = 0u32;
    for (i, ch) in text[line_start..line_end].char_indices() {
        if units >= pos.character {
            return Some(line_start + i);
        }
        units += ch.len_utf16() as u32;
    }
    Some(line_end)
}

/// Position of the byte offset `at` in `text` (clamped to the text).
pub fn position(text: &str, at: usize) -> Position {
    let at = at.min(text.len());
    let before = &text[..at];
    let line = before.matches('\n').count() as u32;
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let character = text[line_start..at].chars().map(|c| c.len_utf16() as u32).sum();
    Position { line, character }
}

/// The text as a JSON string literal's contents (`"`, `\`, control characters).
pub fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// The text of a JSON string literal's contents (`\"`, `\\`, `\n`, `\uXXXX`).
pub fn unescape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                let mut code = u32::from_str_radix(&hex, 16).unwrap_or(0xfffd);
                // A surrogate pair: `\ud83d\ude00`.
                if (0xd800..0xdc00).contains(&code) {
                    let rest: String = chars.clone().take(6).collect();
                    if let Some(low) = rest.strip_prefix("\\u").and_then(|h| u32::from_str_radix(h, 16).ok()) {
                        chars.by_ref().nth(5);
                        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                    }
                }
                out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
            }
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_utf16_columns() {
        let text = "ab\n😀x\nlast";
        for at in [0, 1, 2, 3, 7, 8, 9, text.len()] {
            assert_eq!(offset(text, position(text, at)), Some(at), "{at}");
        }
        assert_eq!(position(text, 7), Position::new(1, 2));
        assert_eq!(offset(text, Position::new(0, 99)), Some(2), "clamped to the line");
        assert_eq!(offset(text, Position::new(5, 0)), None);
    }
}
