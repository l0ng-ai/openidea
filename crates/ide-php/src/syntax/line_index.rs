//! Byte offset ⇄ 0-based line / UTF-16 column conversion for one PHP source.
//!
//! Mago spans are byte offsets; the IDE speaks 0-based lines and UTF-16
//! columns (`ide-core::text`). Like `ide-text`, only `\n` breaks a line. A
//! `\r` in front of it belongs to the line but is never a valid caret column
//! target: positions past the line's content clamp to before the `\r\n`.
//!
//! The index is owned (it doesn't borrow the text), so a cached
//! [`ParsedFile`](super::ParsedFile) can hand it out. Per line it remembers
//! only the characters that are not ASCII, so ASCII lines cost one `u32`.

use ide_core::{Pos, Range};
use mago_span::Span;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WideChar {
    /// Byte offset of the character from the start of its line.
    start: u32,
    len_utf8: u8,
    len_utf16: u8,
}

impl WideChar {
    fn extra_bytes(self) -> u32 {
        u32::from(self.len_utf8 - self.len_utf16)
    }
}

#[derive(Clone, Debug)]
pub struct LineIndex {
    /// Byte offset of the start of every line; `starts[0] == 0`.
    starts: Vec<u32>,
    /// Byte offset where each line's content ends, before `\n` or `\r\n`.
    ends: Vec<u32>,
    /// `(line, non-ASCII characters of that line in order)`, sorted by line.
    wide: Vec<(u32, Vec<WideChar>)>,
    len: u32,
}

impl LineIndex {
    /// Indexes `text`. Texts longer than `u32::MAX` bytes are not supported
    /// (Mago's spans are `u32` as well).
    pub fn new(text: &str) -> Self {
        let bytes = text.as_bytes();
        let mut starts = vec![0u32];
        let mut ends = Vec::new();
        for (at, _) in bytes.iter().enumerate().filter(|(_, b)| **b == b'\n') {
            let end = if at > 0 && bytes[at - 1] == b'\r' { at - 1 } else { at };
            ends.push(end as u32);
            starts.push(at as u32 + 1);
        }
        ends.push(text.len() as u32);

        let mut wide: Vec<(u32, Vec<WideChar>)> = Vec::new();
        if !text.is_ascii() {
            let mut line = 0usize;
            for (at, ch) in text.char_indices().filter(|(_, ch)| !ch.is_ascii()) {
                let at = at as u32;
                while line + 1 < starts.len() && starts[line + 1] <= at {
                    line += 1;
                }
                let entry = WideChar {
                    start: at - starts[line],
                    len_utf8: ch.len_utf8() as u8,
                    len_utf16: ch.len_utf16() as u8,
                };
                match wide.last_mut() {
                    Some((l, chars)) if *l == line as u32 => chars.push(entry),
                    _ => wide.push((line as u32, vec![entry])),
                }
            }
        }
        Self { starts, ends, wide, len: text.len() as u32 }
    }

    /// Number of lines; a text ending in `\n` has an empty last line.
    pub fn line_count(&self) -> u32 {
        self.starts.len() as u32
    }

    /// Length of the indexed text in bytes.
    pub fn len(&self) -> u32 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Byte offset of the start of `line`, or `None` past the last line.
    pub fn line_start(&self, line: u32) -> Option<u32> {
        self.starts.get(line as usize).copied()
    }

    /// The line containing `byte` (clamped to the text).
    pub fn line_of(&self, byte: u32) -> u32 {
        let byte = byte.min(self.len);
        (self.starts.partition_point(|&s| s <= byte) - 1) as u32
    }

    fn wide_chars(&self, line: u32) -> &[WideChar] {
        match self.wide.binary_search_by_key(&line, |(l, _)| *l) {
            Ok(i) => &self.wide[i].1,
            Err(_) => &[],
        }
    }

    /// Byte offset → position. Offsets past the end clamp to the end; an
    /// offset inside a multi-byte character rounds down to its start.
    pub fn pos(&self, byte: u32) -> Pos {
        let byte = byte.min(self.len);
        let line = self.line_of(byte);
        let mut col = byte - self.starts[line as usize];
        let mut extra = 0;
        for ch in self.wide_chars(line) {
            if ch.start >= col {
                break;
            }
            if ch.start + u32::from(ch.len_utf8) > col {
                col = ch.start;
                break;
            }
            extra += ch.extra_bytes();
        }
        Pos::new(line, col - extra)
    }

    /// Position → byte offset. A line past the end gives the text length; a
    /// column past the line's content clamps to its end (before `\r\n`); a
    /// column inside a surrogate pair rounds down to the character's start.
    pub fn byte(&self, pos: Pos) -> u32 {
        let Some(&start) = self.starts.get(pos.line as usize) else {
            return self.len;
        };
        let end = self.ends[pos.line as usize];
        let mut extra = 0;
        for ch in self.wide_chars(pos.line) {
            let utf16_start = ch.start - extra;
            if pos.col <= utf16_start {
                break;
            }
            if pos.col < utf16_start + u32::from(ch.len_utf16) {
                return start + ch.start;
            }
            extra += ch.extra_bytes();
        }
        (start + pos.col + extra).min(end)
    }

    /// Byte range → IDE range.
    pub fn range(&self, start: u32, end: u32) -> Range {
        Range::new(self.pos(start), self.pos(end))
    }

    /// Mago span → IDE range.
    pub fn span_range(&self, span: Span) -> Range {
        self.range(span.start.offset, span.end.offset)
    }

    /// IDE range → byte range.
    pub fn byte_range(&self, range: Range) -> (u32, u32) {
        (self.byte(range.start), self.byte(range.end))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Checks every char boundary against a direct UTF-16 count.
    fn check_roundtrip(text: &str) {
        let index = LineIndex::new(text);
        for (byte, _) in text.char_indices().chain([(text.len(), ' ')]) {
            let line_start = text[..byte].rfind('\n').map_or(0, |i| i + 1);
            let line = text[..byte].matches('\n').count() as u32;
            let col = text[line_start..byte].encode_utf16().count() as u32;
            let pos = index.pos(byte as u32);
            assert_eq!(pos, Pos::new(line, col), "byte {byte} of {text:?}");
            let on_cr = text[byte..].starts_with("\r\n");
            if !on_cr && !text[..byte].ends_with('\r') {
                assert_eq!(index.byte(pos), byte as u32, "pos {pos:?} of {text:?}");
            }
        }
    }

    #[test]
    fn ascii_and_multibyte_roundtrip() {
        check_roundtrip("");
        check_roundtrip("<?php\necho 1;\n");
        check_roundtrip("<?php $s = \"😀 café 中文\"; $t = '𝄞';\n// é\n\n😀😀\n");
    }

    #[test]
    fn emoji_is_two_utf16_units() {
        let text = "<?php $a = '😀'; $b;";
        let index = LineIndex::new(text);
        let b = text.find("$b").unwrap() as u32;
        // '😀' is 4 bytes, 2 UTF-16 units.
        assert_eq!(index.pos(b), Pos::new(0, b - 2));
        assert_eq!(index.byte(Pos::new(0, b - 2)), b);
    }

    #[test]
    fn inside_a_character_rounds_down() {
        let text = "x😀y";
        let index = LineIndex::new(text);
        for byte in 2..5 {
            assert_eq!(index.pos(byte), Pos::new(0, 1));
        }
        // Column 2 is between the surrogates of '😀'.
        assert_eq!(index.byte(Pos::new(0, 2)), 1);
        assert_eq!(index.byte(Pos::new(0, 3)), 5);
    }

    #[test]
    fn crlf_lines() {
        let text = "<?php\r\n$a = 'é';\r\n$b;\r\n";
        check_roundtrip(text);
        let index = LineIndex::new(text);
        assert_eq!(index.line_count(), 4);
        let b = text.find("$b").unwrap() as u32;
        assert_eq!(index.pos(b), Pos::new(2, 0));
        // The `\r` is a column of its line, but carets clamp before it.
        assert_eq!(index.pos(5), Pos::new(0, 5));
        assert_eq!(index.byte(Pos::new(0, 99)), 5);
        assert_eq!(index.byte(Pos::new(1, 99)), text.find("\r\n$b").unwrap() as u32);
    }

    #[test]
    fn out_of_range_input_clamps() {
        let text = "ab\ncd";
        let index = LineIndex::new(text);
        assert_eq!(index.pos(99), Pos::new(1, 2));
        assert_eq!(index.byte(Pos::new(7, 0)), 5);
        assert_eq!(index.byte(Pos::new(0, 7)), 2);
        assert_eq!(index.line_of(99), 1);
        assert_eq!(index.line_start(1), Some(3));
        assert_eq!(index.line_start(2), None);
    }

    #[test]
    fn ranges_roundtrip() {
        let text = "<?php\n$x = '中';\n";
        let index = LineIndex::new(text);
        let start = text.find("$x").unwrap() as u32;
        let end = text.find(';').unwrap() as u32;
        let range = index.range(start, end);
        assert_eq!(range, Range::new(Pos::new(1, 0), Pos::new(1, 8)));
        assert_eq!(index.byte_range(range), (start, end));
    }
}
