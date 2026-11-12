//! The manager's own copy of each open document, and position-encoding conversion.
//!
//! Lines split on `\n` only (documents are normalised to `\n` upstream); a `\r`
//! before the `\n` is treated as part of the line terminator.

use ide_core::{Pos, Range};

/// Position encoding negotiated with a server (LSP 3.17 `positionEncoding`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    #[default]
    Utf16,
    Utf32,
}

impl Encoding {
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("utf-8") => Self::Utf8,
            Some("utf-32") => Self::Utf32,
            _ => Self::Utf16,
        }
    }

    fn unit_len(self, c: char) -> usize {
        match self {
            Self::Utf8 => c.len_utf8(),
            Self::Utf16 => c.len_utf16(),
            Self::Utf32 => 1,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct DocText {
    text: String,
    /// Byte offset of the start of each line; always non-empty.
    lines: Vec<usize>,
}

impl DocText {
    pub fn new(text: &str) -> Self {
        let mut doc = Self { text: text.to_owned(), lines: Vec::new() };
        doc.reindex_from(0);
        doc
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// Recomputes line starts for every line at or after `line`.
    fn reindex_from(&mut self, line: usize) {
        let line = line.min(self.lines.len());
        self.lines.truncate(line);
        let start = match self.lines.last() {
            Some(_) => self.lines[line - 1],
            None => {
                self.lines.push(0);
                0
            }
        };
        let bytes = self.text.as_bytes();
        let mut i = start;
        while let Some(off) = memchr(b'\n', &bytes[i..]) {
            i += off + 1;
            self.lines.push(i);
        }
    }

    /// Text of `line` without its terminator; empty for out-of-range lines.
    pub fn line(&self, line: usize) -> &str {
        let Some(&start) = self.lines.get(line) else { return "" };
        let end = self.lines.get(line + 1).map_or(self.text.len(), |&e| e - 1);
        let s = &self.text[start..end];
        s.strip_suffix('\r').unwrap_or(s)
    }

    /// Byte offset of a UTF-16 position, clamped to the document.
    pub fn byte_offset(&self, pos: Pos) -> usize {
        let line = pos.line as usize;
        if line >= self.lines.len() {
            return self.text.len();
        }
        self.lines[line] + col_to_byte(self.line(line), pos.col as usize, Encoding::Utf16)
    }

    /// Applies one LSP-style change (UTF-16 range in the current text).
    /// Fails when the range starts past the end of the document.
    pub fn apply(&mut self, range: Range, text: &str) -> Result<(), ()> {
        if range.start.line as usize >= self.lines.len() || range.end < range.start {
            return Err(());
        }
        let start = self.byte_offset(range.start);
        let end = self.byte_offset(range.end).max(start);
        self.text.replace_range(start..end, text);
        self.reindex_from(range.start.line as usize + 1);
        Ok(())
    }

    pub fn set(&mut self, text: &str) {
        *self = Self::new(text);
    }

    /// Converts an IDE (UTF-16) position into the server's encoding.
    pub fn ide_to_lsp(&self, enc: Encoding, pos: Pos) -> lsp_types::Position {
        if enc == Encoding::Utf16 {
            return lsp_types::Position::new(pos.line, pos.col);
        }
        let line = self.line(pos.line as usize);
        let byte = col_to_byte(line, pos.col as usize, Encoding::Utf16);
        lsp_types::Position::new(pos.line, units(&line[..byte], enc) as u32)
    }

    /// Converts a server position into IDE (UTF-16) coordinates.
    pub fn lsp_to_ide(&self, enc: Encoding, pos: lsp_types::Position) -> Pos {
        if enc == Encoding::Utf16 {
            return Pos::new(pos.line, pos.character);
        }
        convert_line_col(self.line(pos.line as usize), pos, enc)
    }

    /// The identifier-like word touching `pos`, for rename fallbacks.
    pub fn word_range_at(&self, pos: Pos) -> Option<Range> {
        let line = self.line(pos.line as usize);
        let byte = col_to_byte(line, pos.col as usize, Encoding::Utf16);
        let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
        let start = line[..byte].char_indices().rev().take_while(|&(_, c)| is_word(c)).last().map_or(byte, |(i, _)| i);
        let end = line[byte..].char_indices().find(|&(_, c)| !is_word(c)).map_or(line.len(), |(i, _)| byte + i);
        if start == end {
            return None;
        }
        let col = |b: usize| units(&line[..b], Encoding::Utf16) as u32;
        Some(Range::new(Pos::new(pos.line, col(start)), Pos::new(pos.line, col(end))))
    }
}

/// Converts a server column on `line` (given in `enc`) to UTF-16.
pub fn convert_line_col(line: &str, pos: lsp_types::Position, enc: Encoding) -> Pos {
    let byte = col_to_byte(line, pos.character as usize, enc);
    Pos::new(pos.line, units(&line[..byte], Encoding::Utf16) as u32)
}

/// Byte index of column `col` (in `enc` units) within `line`, clamped and
/// snapped to a char boundary.
pub fn col_to_byte(line: &str, col: usize, enc: Encoding) -> usize {
    let mut acc = 0;
    for (i, c) in line.char_indices() {
        if acc >= col {
            return i;
        }
        acc += enc.unit_len(c);
        if acc > col {
            // Inside a multi-unit char: snap to its start.
            return i;
        }
    }
    line.len()
}

/// Length of `s` in `enc` code units.
pub fn units(s: &str, enc: Encoding) -> usize {
    match enc {
        Encoding::Utf8 => s.len(),
        Encoding::Utf16 => s.chars().map(char::len_utf16).sum(),
        Encoding::Utf32 => s.chars().count(),
    }
}

/// Converts a range of `[start, end)` in `enc` units within `s` to UTF-16 units.
pub fn convert_offsets(s: &str, start: usize, end: usize, enc: Encoding) -> (u32, u32) {
    if enc == Encoding::Utf16 {
        return (start as u32, end as u32);
    }
    let b0 = col_to_byte(s, start, enc);
    let b1 = col_to_byte(s, end, enc).max(b0);
    (units(&s[..b0], Encoding::Utf16) as u32, units(&s[..b1], Encoding::Utf16) as u32)
}

fn memchr(needle: u8, hay: &[u8]) -> Option<usize> {
    hay.iter().position(|&b| b == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(l0: u32, c0: u32, l1: u32, c1: u32) -> Range {
        Range::new(Pos::new(l0, c0), Pos::new(l1, c1))
    }

    #[test]
    fn lines_and_offsets() {
        let d = DocText::new("ab\r\ncd\n\né😀x");
        assert_eq!(d.line_count(), 4);
        assert_eq!(d.line(0), "ab");
        assert_eq!(d.line(1), "cd");
        assert_eq!(d.line(2), "");
        assert_eq!(d.line(3), "é😀x");
        assert_eq!(d.line(9), "");
        assert_eq!(d.byte_offset(Pos::new(3, 3)), "ab\r\ncd\n\né😀".len());
        assert_eq!(d.byte_offset(Pos::new(3, 2)), "ab\r\ncd\n\né".len(), "inside surrogate pair snaps back");
        assert_eq!(d.byte_offset(Pos::new(0, 99)), 2);
        assert_eq!(d.byte_offset(Pos::new(99, 0)), d.as_str().len());
    }

    #[test]
    fn apply_sequential_changes() {
        let mut d = DocText::new("fn main() {\n}\n");
        d.apply(r(0, 11, 0, 11), "\n    let x = 1;").unwrap();
        assert_eq!(d.as_str(), "fn main() {\n    let x = 1;\n}\n");
        d.apply(r(1, 8, 1, 9), "yy").unwrap();
        assert_eq!(d.as_str(), "fn main() {\n    let yy = 1;\n}\n");
        d.apply(r(0, 0, 2, 0), "").unwrap();
        assert_eq!(d.as_str(), "}\n");
        assert_eq!(d.line_count(), 2);
        d.apply(r(1, 0, 1, 0), "end").unwrap();
        assert_eq!(d.as_str(), "}\nend");
        assert!(d.apply(r(5, 0, 5, 0), "x").is_err());
    }

    #[test]
    fn encoding_conversion() {
        let d = DocText::new("é😀x");
        let p = Pos::new(0, 3); // after the emoji in UTF-16
        assert_eq!(d.ide_to_lsp(Encoding::Utf8, p), lsp_types::Position::new(0, 6));
        assert_eq!(d.ide_to_lsp(Encoding::Utf32, p), lsp_types::Position::new(0, 2));
        assert_eq!(d.lsp_to_ide(Encoding::Utf8, lsp_types::Position::new(0, 6)), p);
        assert_eq!(d.lsp_to_ide(Encoding::Utf32, lsp_types::Position::new(0, 2)), p);
        assert_eq!(d.lsp_to_ide(Encoding::Utf16, lsp_types::Position::new(0, 3)), p);
        assert_eq!(convert_offsets("😀ab", 4, 6, Encoding::Utf8), (2, 4));
        assert_eq!(convert_offsets("😀ab", 1, 3, Encoding::Utf32), (2, 4));
    }

    #[test]
    fn word_at() {
        let d = DocText::new("let foo_bar = 1;");
        assert_eq!(d.word_range_at(Pos::new(0, 6)), Some(r(0, 4, 0, 11)));
        assert_eq!(d.word_range_at(Pos::new(0, 11)), Some(r(0, 4, 0, 11)));
        assert_eq!(d.word_range_at(Pos::new(0, 12)), None);
    }
}
