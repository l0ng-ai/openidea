//! Byte offset <-> 0-based line / UTF-16 column, for one text snapshot.
//!
//! Only line starts are indexed (one `memchr` pass); columns are converted
//! within their line, so building the index stays well under a millisecond
//! even for 20k-line files.

use ide_core::{Pos, Range};

pub(crate) struct Lines<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

impl<'a> Lines<'a> {
    pub(crate) fn new(text: &'a str) -> Self {
        let mut starts = Vec::with_capacity(text.len() / 40 + 1);
        starts.push(0);
        starts.extend(memchr::memchr_iter(b'\n', text.as_bytes()).map(|i| i + 1));
        Self { text, starts }
    }

    pub(crate) fn text(&self) -> &'a str {
        self.text
    }

    fn line_of(&self, byte: usize) -> usize {
        self.starts.partition_point(|&s| s <= byte) - 1
    }

    fn line_end(&self, line: usize) -> usize {
        self.starts.get(line + 1).map_or(self.text.len(), |&s| s - 1)
    }

    pub(crate) fn pos(&self, byte: usize) -> Pos {
        let byte = floor_char(self.text, byte.min(self.text.len()));
        let line = self.line_of(byte);
        Pos::new(line as u32, utf16_len(&self.text[self.starts[line]..byte]))
    }

    pub(crate) fn range(&self, start: usize, end: usize) -> Range {
        Range::new(self.pos(start), self.pos(end))
    }

    /// Byte offset of a position, clamped to its line and to the text.
    pub(crate) fn byte(&self, pos: Pos) -> usize {
        let Some(&start) = self.starts.get(pos.line as usize) else { return self.text.len() };
        let line = &self.text[start..self.line_end(pos.line as usize)];
        start + utf16_to_byte(line, pos.col as usize)
    }

    /// `(start, end)` bytes of a range, ordered.
    pub(crate) fn bytes(&self, range: Range) -> (usize, usize) {
        let (a, b) = (self.byte(range.start), self.byte(range.end));
        (a.min(b), a.max(b))
    }
}

pub(crate) fn utf16_len(s: &str) -> u32 {
    if s.is_ascii() {
        return s.len() as u32;
    }
    // One unit per char (each starts with a non-continuation byte), two for
    // 4-byte chars; byte classification vectorizes, unlike decoding `chars()`.
    s.as_bytes().iter().map(|&b| u32::from((b & 0xC0) != 0x80) + u32::from(b >= 0xF0)).sum()
}

fn utf16_to_byte(s: &str, offset: usize) -> usize {
    if s.is_ascii() {
        return offset.min(s.len());
    }
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units >= offset {
            return i;
        }
        units += c.len_utf16();
        if units > offset {
            // Inside a surrogate pair: round down to the char start.
            return i;
        }
    }
    s.len()
}

fn floor_char(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_utf16_both_ways() {
        let text = "ab\n😀x\n\nzz";
        let l = Lines::new(text);
        assert_eq!(l.pos(0), Pos::new(0, 0));
        assert_eq!(l.pos(3), Pos::new(1, 0));
        assert_eq!(l.pos(7), Pos::new(1, 2));
        assert_eq!(l.pos(5), Pos::new(1, 0), "mid-char bytes round down");
        assert_eq!(l.pos(10), Pos::new(3, 0));
        assert_eq!(l.pos(99), Pos::new(3, 2));
        assert_eq!(l.byte(Pos::new(1, 2)), 7);
        assert_eq!(l.byte(Pos::new(1, 1)), 3, "inside a surrogate pair rounds down");
        assert_eq!(l.byte(Pos::new(0, 99)), 2, "clamped to the line");
        assert_eq!(l.byte(Pos::new(9, 0)), text.len());
        for b in [0, 1, 2, 3, 7, 8, 9, 10, 11, 12] {
            assert_eq!(l.byte(l.pos(b)), b, "byte {b}");
        }
    }
}
