//! Turns a matched line plus byte ranges into [`LineMatch`]es with UTF-16
//! columns. A very long line is cut into windows: one around its first match
//! and the matches that fit with it, then one around each match left out.

use crate::LineMatch;

/// Lines longer than this (in UTF-16 units) are truncated.
pub(crate) const MAX_LINE_LEN: usize = 500;
/// How much text before the first match a truncated line keeps.
const CONTEXT_BEFORE: usize = 100;

/// Appends the matches of one line to `out`: a single [`LineMatch`], or one per window of a
/// very long line. `line` excludes the line terminator; `ranges` are sorted, non-overlapping
/// byte ranges within `line`.
pub(crate) fn line_matches(line_no: u32, line: &[u8], ranges: &[(usize, usize)], out: &mut Vec<LineMatch>) {
    match std::str::from_utf8(line) {
        Ok(s) => from_str(line_no, s, ranges, out),
        Err(_) => {
            let (s, mapped) = lossy(line, ranges);
            from_str(line_no, &s, &mapped, out)
        }
    }
}

#[cfg(test)]
fn line_match(line_no: u32, line: &[u8], ranges: &[(usize, usize)]) -> LineMatch {
    let mut out = Vec::new();
    line_matches(line_no, line, ranges, &mut out);
    out.swap_remove(0)
}

fn from_str(line_no: u32, s: &str, ranges: &[(usize, usize)], out: &mut Vec<LineMatch>) {
    if s.len() <= MAX_LINE_LEN || utf16_len(s.as_bytes()) <= MAX_LINE_LEN {
        out.push(in_window(line_no, s, ranges, (0, s.len()), 0).0);
        return;
    }
    let mut rest = ranges;
    // UTF-16 offset of the previous window's start: counting from the line start for every
    // window is quadratic in the line length.
    let (mut prev_start, mut prev_offset) = (0, 0);
    loop {
        let bounds = window(s, floor_boundary(s, rest.first().map_or(0, |r| r.0.min(s.len()))));
        let text_offset = if bounds.0 >= prev_start {
            prev_offset + utf16_len(&s.as_bytes()[prev_start..bounds.0])
        } else {
            utf16_len(&s.as_bytes()[..bounds.0])
        };
        (prev_start, prev_offset) = (bounds.0, text_offset);
        // Only the ranges starting in the window: `in_window` reserves room for all it is given,
        // and the rest of a long line can hold every match on it.
        let starting = rest.partition_point(|&(a, _)| a <= bounds.1);
        let (m, used) = in_window(line_no, s, &rest[..starting], bounds, text_offset);
        out.push(m);
        rest = &rest[used.max(1)..];
        if rest.is_empty() {
            break;
        }
    }
}

/// The [`LineMatch`] of the text in `bounds` with the leading `ranges` that end inside it (at
/// least the first one, cut to the window), and how many ranges it took. `text_offset` is the
/// UTF-16 length of `s[..start]`.
fn in_window(
    line_no: u32,
    s: &str,
    ranges: &[(usize, usize)],
    (start, end): (usize, usize),
    text_offset: usize,
) -> (LineMatch, usize) {
    let text = &s[start..end];

    let mut out = Vec::with_capacity(ranges.len());
    let (mut pos, mut col) = (start, 0usize);
    let mut used = 0;
    for &(a, b) in ranges {
        if a > end || (a == end && b > a) || (used > 0 && b > end) {
            break;
        }
        used += 1;
        let (a, b) = (floor_boundary(s, a.max(start)), ceil_boundary(s, b.min(end)));
        if a < pos {
            continue;
        }
        col += utf16_len(&s.as_bytes()[pos..a]);
        let col_a = col;
        col += utf16_len(&s.as_bytes()[a..b]);
        pos = b;
        out.push((col_a as u32, col as u32));
    }
    (LineMatch { line: line_no, text: text.to_owned(), ranges: out, text_offset: text_offset as u32 }, used)
}

/// Byte window `[start, end)` of at most `MAX_LINE_LEN` UTF-16 units that
/// starts a little before `first_match`, on char boundaries.
fn window(s: &str, first_match: usize) -> (usize, usize) {
    let mut start = first_match;
    let mut units = 0;
    for (i, ch) in s[..first_match].char_indices().rev() {
        units += ch.len_utf16();
        if units > CONTEXT_BEFORE {
            break;
        }
        start = i;
    }
    let mut end = start;
    let mut units = 0;
    for ch in s[start..].chars() {
        let w = ch.len_utf16();
        if units + w > MAX_LINE_LEN {
            break;
        }
        units += w;
        end += ch.len_utf8();
    }
    // Near the end of the line: use the spare budget for more leading context.
    if end == s.len() {
        for (i, ch) in s[..start].char_indices().rev() {
            let w = ch.len_utf16();
            if units + w > MAX_LINE_LEN {
                break;
            }
            units += w;
            start = i;
        }
    }
    (start, end)
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// UTF-16 length of valid UTF-8: one unit per char, two for 4-byte chars.
#[inline]
pub(crate) fn utf16_len(bytes: &[u8]) -> usize {
    bytes.iter().map(|&b| usize::from((b & 0xC0) != 0x80) + usize::from(b >= 0xF0)).sum()
}

/// Lossy UTF-8 conversion (as `String::from_utf8_lossy`) that remaps byte
/// ranges into the converted string.
fn lossy(line: &[u8], ranges: &[(usize, usize)]) -> (String, Vec<(usize, usize)>) {
    // (orig start, new start, valid len, invalid len) per chunk.
    let mut chunks = Vec::new();
    let mut out = String::with_capacity(line.len() + 8);
    let mut orig = 0;
    for chunk in line.utf8_chunks() {
        let (valid, invalid) = (chunk.valid(), chunk.invalid());
        chunks.push((orig, out.len(), valid.len(), invalid.len()));
        out.push_str(valid);
        if !invalid.is_empty() {
            out.push(char::REPLACEMENT_CHARACTER);
        }
        orig += valid.len() + invalid.len();
    }
    let map = |off: usize, is_end: bool| -> usize {
        for &(o, n, v, inv) in &chunks {
            if off <= o + v {
                return n + off.saturating_sub(o);
            }
            if off < o + v + inv {
                let replacement = char::REPLACEMENT_CHARACTER.len_utf8();
                return n + v + if is_end { replacement } else { 0 };
            }
        }
        out.len()
    };
    let mapped = ranges.iter().map(|&(a, b)| (map(a, false), map(b, true).max(map(a, false)))).collect();
    (out, mapped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_columns() {
        let s = "中文 😀 foo";
        let a = s.find("foo").unwrap();
        let m = line_match(3, s.as_bytes(), &[(a, a + 3)]);
        // 中 文 space (3) + emoji (2) + space (1) = 6
        assert_eq!(m.ranges, vec![(6, 9)]);
        assert_eq!(m.text_offset, 0);
        assert_eq!(m.text, s);
    }

    #[test]
    fn invalid_utf8_is_replaced() {
        let line = b"ab\xFFcd foo";
        let m = line_match(0, line, &[(6, 9)]);
        assert_eq!(m.text, "ab\u{FFFD}cd foo");
        assert_eq!(m.ranges, vec![(6, 9)]);
    }

    #[test]
    fn long_line_window() {
        let s = format!("{}needle{}", "x".repeat(1000), "y".repeat(1000));
        let m = line_match(0, s.as_bytes(), &[(1000, 1006)]);
        assert_eq!(m.text_offset, 900);
        assert_eq!(m.ranges, vec![(100, 106)]);
        assert_eq!(utf16_len(m.text.as_bytes()), MAX_LINE_LEN);
        assert_eq!(&m.text[100..106], "needle");
    }

    #[test]
    fn long_line_window_at_end() {
        let s = format!("{}needle", "x".repeat(1000));
        let m = line_match(0, s.as_bytes(), &[(1000, 1006)]);
        assert_eq!(m.text_offset, 506);
        assert_eq!(m.ranges, vec![(494, 500)]);
    }

    #[test]
    fn long_line_window_never_splits_surrogates() {
        let s = format!("{}needle{}", "😀".repeat(400), "😀".repeat(400));
        let a = "😀".len() * 400;
        let m = line_match(0, s.as_bytes(), &[(a, a + 6)]);
        assert_eq!(m.text_offset, 700);
        assert_eq!(m.ranges, vec![(100, 106)]);
        assert!(utf16_len(m.text.as_bytes()) <= MAX_LINE_LEN);
    }

    #[test]
    fn matches_outside_the_first_window_get_their_own() {
        // Two matches 100 apart share a window; the one 1000 further gets another.
        let s = format!("{}ab{}cd{}ef{}", "x".repeat(1000), "x".repeat(100), "x".repeat(1000), "x".repeat(10));
        let at = |needle: &str| s.find(needle).unwrap();
        let ranges = [(at("ab"), at("ab") + 2), (at("cd"), at("cd") + 2), (at("ef"), at("ef") + 2)];
        let mut out = Vec::new();
        line_matches(7, s.as_bytes(), &ranges, &mut out);
        let found: Vec<Vec<u32>> =
            out.iter().map(|m| m.ranges.iter().map(|&(a, _)| m.text_offset + a).collect()).collect();
        let col = |needle: &str| at(needle) as u32;
        assert_eq!(found, vec![vec![col("ab"), col("cd")], vec![col("ef")]]);
        assert!(out.iter().all(|m| m.line == 7 && utf16_len(m.text.as_bytes()) <= MAX_LINE_LEN));
        assert_eq!(&out[1].text[out[1].ranges[0].0 as usize..out[1].ranges[0].1 as usize], "ef");
    }

    #[test]
    fn a_match_longer_than_the_window_is_cut_to_it() {
        let s = format!("{}{}tail", "x".repeat(100), "y".repeat(1000));
        let mut out = Vec::new();
        line_matches(0, s.as_bytes(), &[(100, 1100), (1100, 1104)], &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].ranges, vec![(100, 500)]);
        assert_eq!(out[1].text_offset + out[1].ranges[0].0, 1100);
    }

    #[test]
    fn a_long_line_with_many_windows_is_cut_in_linear_time() {
        // 4 MB with a match every 600 bytes: one window each.
        let s = format!("{}function", "x".repeat(592)).repeat(7_000);
        let ranges: Vec<_> = s.match_indices("function").map(|(a, m)| (a, a + m.len())).collect();
        let started = std::time::Instant::now();
        let mut out = Vec::new();
        line_matches(0, s.as_bytes(), &ranges, &mut out);
        assert_eq!(out.len(), 7_000);
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "{:?}", started.elapsed());
    }

    #[test]
    fn each_window_holds_room_for_its_own_matches_only() {
        // 7,000 windows of one match each on a 4 MB line.
        let s = format!("{}function", "x".repeat(592)).repeat(7_000);
        let ranges: Vec<_> = s.match_indices("function").map(|(a, m)| (a, a + m.len())).collect();
        let mut out = Vec::new();
        line_matches(0, s.as_bytes(), &ranges, &mut out);
        let reserved: usize = out.iter().map(|m| m.ranges.capacity()).sum();
        assert!(reserved <= 4 * out.len(), "{reserved} ranges reserved for {} windows", out.len());
    }

    /// `main`'s windowing, which counts each window's offset from the line start.
    fn reference(line_no: u32, line: &[u8], ranges: &[(usize, usize)]) -> Vec<LineMatch> {
        fn from_str(line_no: u32, s: &str, ranges: &[(usize, usize)], out: &mut Vec<LineMatch>) {
            if s.len() <= MAX_LINE_LEN || utf16_len(s.as_bytes()) <= MAX_LINE_LEN {
                out.push(in_window(line_no, s, ranges, (0, s.len()), 0).0);
                return;
            }
            let mut rest = ranges;
            loop {
                let bounds = window(s, floor_boundary(s, rest.first().map_or(0, |r| r.0.min(s.len()))));
                let (m, used) = in_window(line_no, s, rest, bounds, utf16_len(&s.as_bytes()[..bounds.0]));
                out.push(m);
                rest = &rest[used.max(1)..];
                if rest.is_empty() {
                    break;
                }
            }
        }
        let mut out = Vec::new();
        match std::str::from_utf8(line) {
            Ok(s) => from_str(line_no, s, ranges, &mut out),
            Err(_) => {
                let (s, mapped) = lossy(line, ranges);
                from_str(line_no, &s, &mapped, &mut out)
            }
        }
        out
    }

    #[test]
    fn windows_match_the_reference_on_random_lines() {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % n as u64) as usize
        };
        let pieces: [&[u8]; 8] = [b"a", b"x", b" ", "é".as_bytes(), "中".as_bytes(), "😀".as_bytes(), b"ab", b"\xFF"];
        for case in 0..3_000 {
            let len = [next(600), 400 + next(300), next(6_000)][case % 3];
            let mut line = Vec::new();
            while line.len() < len {
                // Invalid UTF-8 in a tenth of the lines.
                let piece = pieces[next(if case % 10 == 0 { 8 } else { 7 })];
                line.extend_from_slice(piece);
            }
            let mut ranges = Vec::new();
            let mut at = if next(4) == 0 { line.len().saturating_sub(next(40)) } else { next(200) };
            while at <= line.len() {
                let end = (at + next(12)).min(line.len());
                ranges.push((at, end));
                at = end + 1 + next([20, 300, 1_500][case % 3]);
            }
            if ranges.is_empty() {
                continue;
            }
            let mut out = Vec::new();
            line_matches(case as u32, &line, &ranges, &mut out);
            let fields = |m: &LineMatch| (m.line, m.text.clone(), m.ranges.clone(), m.text_offset);
            let expected = reference(case as u32, &line, &ranges);
            assert_eq!(out.iter().map(fields).collect::<Vec<_>>(), expected.iter().map(fields).collect::<Vec<_>>());
        }
    }
}
