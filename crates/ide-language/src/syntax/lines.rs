//! Byte offset <-> 0-based line / UTF-16 column conversion for one text snapshot.

use ide_core::{Pos, Range};

/// Distance between UTF-16 checkpoints, so column conversion inside very long
/// (minified) lines stays O(1) instead of O(line length).
const CHECKPOINT: usize = 4096;

pub(crate) struct LineIndex<'a> {
    text: &'a str,
    /// Byte offset of the start of every line; `starts[0] == 0`.
    starts: Vec<usize>,
    /// For non-ASCII text: `(byte, utf16 offset)` at char boundaries roughly
    /// every [`CHECKPOINT`] bytes, starting with `(0, 0)`. Empty for ASCII text.
    checkpoints: Vec<(usize, usize)>,
}

impl<'a> LineIndex<'a> {
    pub(crate) fn new(text: &'a str) -> Self {
        let mut starts = Vec::with_capacity(text.len() / 32 + 1);
        starts.push(0);
        starts.extend(memchr_newlines(text.as_bytes()));
        let mut checkpoints = Vec::new();
        if !text.is_ascii() {
            checkpoints.reserve(text.len() / CHECKPOINT + 1);
            checkpoints.push((0, 0));
            let mut units = 0usize;
            let mut at = 0usize;
            while at < text.len() {
                let mut end = (at + CHECKPOINT).min(text.len());
                while !text.is_char_boundary(end) {
                    end += 1;
                }
                units += utf16_len(&text[at..end]) as usize;
                checkpoints.push((end, units));
                at = end;
            }
        }
        Self { text, starts, checkpoints }
    }

    /// UTF-16 offset of a char-boundary byte offset.
    pub(crate) fn utf16_at(&self, byte: usize) -> usize {
        if self.checkpoints.is_empty() {
            return byte;
        }
        let k = self.checkpoints.partition_point(|&(b, _)| b <= byte) - 1;
        let (b, u) = self.checkpoints[k];
        u + utf16_len(&self.text[b..byte]) as usize
    }

    /// Line containing `byte` (clamped to the text).
    pub(crate) fn line_of(&self, byte: usize) -> usize {
        let byte = byte.min(self.text.len());
        self.starts.partition_point(|&s| s <= byte) - 1
    }

    pub(crate) fn pos(&self, byte: usize) -> Pos {
        let byte = floor_char(self.text, byte.min(self.text.len()));
        let line = self.line_of(byte);
        let start = self.starts[line];
        Pos::new(line as u32, (self.utf16_at(byte) - self.utf16_at(start)) as u32)
    }

    pub(crate) fn range(&self, start: usize, end: usize) -> Range {
        Range::new(self.pos(start), self.pos(end))
    }

    /// Converts a UTF-16 offset into the whole text to a byte offset (clamped).
    pub(crate) fn byte_of_utf16(&self, offset: u32) -> usize {
        let offset = offset as usize;
        if self.checkpoints.is_empty() {
            return offset.min(self.text.len());
        }
        let k = self.checkpoints.partition_point(|&(_, u)| u <= offset) - 1;
        let (b, u) = self.checkpoints[k];
        b + utf16_to_byte(&self.text[b..], offset - u)
    }
}

fn memchr_newlines(bytes: &[u8]) -> impl Iterator<Item = usize> + '_ {
    bytes.iter().enumerate().filter(|&(_, &b)| b == b'\n').map(|(i, _)| i + 1)
}

pub(crate) fn utf16_len(s: &str) -> u32 {
    if s.is_ascii() { s.len() as u32 } else { s.chars().map(|c| c.len_utf16() as u32).sum() }
}

/// Byte offset of `pos` (line, UTF-16 column) in `text`; None past the last line.
pub(crate) fn byte_at(text: &str, pos: Pos) -> Option<usize> {
    let mut start = 0;
    for _ in 0..pos.line {
        start += text[start..].find('\n')? + 1;
    }
    let line_end = text[start..].find('\n').map_or(text.len(), |i| start + i);
    Some(start + utf16_to_byte(&text[start..line_end], pos.col as usize))
}

pub(crate) fn utf16_to_byte(s: &str, offset: usize) -> usize {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units >= offset {
            return i;
        }
        units += c.len_utf16();
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
    fn converts_utf16() {
        let text = "ab\n😀x\n\nzz";
        let idx = LineIndex::new(text);
        assert_eq!(idx.pos(0), Pos::new(0, 0));
        assert_eq!(idx.pos(3), Pos::new(1, 0));
        assert_eq!(idx.pos(7), Pos::new(1, 2));
        assert_eq!(idx.pos(8), Pos::new(1, 3));
        assert_eq!(idx.pos(10), Pos::new(3, 0));
        assert_eq!(idx.byte_of_utf16(5), 7);
        assert_eq!(idx.byte_of_utf16(6), 8);
        assert_eq!(idx.byte_of_utf16(100), text.len());
        let ascii = LineIndex::new("ab\ncd");
        assert_eq!(ascii.pos(4), Pos::new(1, 1));
        assert_eq!(ascii.byte_of_utf16(9), 5);
    }

    #[test]
    fn checkpoints_match_naive_on_long_lines() {
        let text = format!("{}\n{}", "aé😀中".repeat(5000), "x😀".repeat(3000));
        let idx = LineIndex::new(&text);
        assert!(idx.checkpoints.len() > 4);
        let line_start = text.find('\n').unwrap() + 1;
        let (mut units, mut col, mut line) = (0usize, 0u32, 0u32);
        for (i, c) in text.char_indices() {
            if i == line_start {
                (line, col) = (1, 0);
            }
            if i % 7 == 0 || c == '😀' {
                assert_eq!(idx.pos(i), Pos::new(line, col), "byte {i}");
                assert_eq!(idx.byte_of_utf16(units as u32), i);
            }
            units += c.len_utf16();
            col += c.len_utf16() as u32;
        }
        assert!(units > 0);
        // Mid-surrogate offsets round like the naive conversion.
        for off in [1usize, 3, 4, 9999, 40_001] {
            assert_eq!(idx.byte_of_utf16(off as u32), utf16_to_byte(&text, off), "offset {off}");
        }
    }

    #[test]
    fn long_minified_line_is_linear() {
        // 200k symbols-worth of positions on one 4 MB line.
        let text = "é".to_owned() + &"a=1;".repeat(1_000_000);
        let idx = LineIndex::new(&text);
        let start = std::time::Instant::now();
        let mut sum = 0u64;
        for b in (1..text.len()).step_by(20) {
            sum += idx.pos(b).col as u64;
        }
        assert!(sum > 0);
        assert!(start.elapsed() < std::time::Duration::from_secs(10), "{:?}", start.elapsed());
    }
}
