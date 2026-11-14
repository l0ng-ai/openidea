//! Property tests against a naive `Vec<u16>` model of the document.

use ide_core::{ChangeSet, Pos, Range, TextChange, TextEdit};
use ide_text::{AppliedChange, ByteEdit, BytePoint, Document};
use proptest::prelude::*;

const ALPHABET: &[char] = &['a', 'b', ' ', '\n', 'é', '中', '😀', '\t'];

fn text_strategy(max: usize) -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(ALPHABET), 0..max).prop_map(|cs| cs.into_iter().collect())
}

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// UTF-16 offsets of every char boundary, including the end.
fn boundaries(s: &str) -> Vec<u32> {
    let mut out = vec![0];
    let mut acc = 0u32;
    for c in s.chars() {
        acc += c.len_utf16() as u32;
        out.push(acc);
    }
    out
}

fn naive_apply(s: &str, cs: &ChangeSet) -> String {
    let src = utf16(s);
    let mut out = Vec::new();
    let mut last = 0usize;
    for c in &cs.changes {
        out.extend_from_slice(&src[last..c.from as usize]);
        out.extend(c.insert.encode_utf16());
        last = c.to as usize;
    }
    out.extend_from_slice(&src[last..]);
    String::from_utf16(&out).unwrap()
}

fn naive_pos_to_offset(s: &str, pos: Pos) -> usize {
    let mut off = 0usize;
    for (i, line) in s.split('\n').enumerate() {
        if i == pos.line as usize {
            return off + (pos.col as usize).min(line.encode_utf16().count());
        }
        off += line.encode_utf16().count() + 1;
    }
    s.encode_utf16().count()
}

fn naive_offset_to_pos(s: &str, offset: usize) -> Pos {
    let prefix = String::from_utf16(&utf16(s)[..offset]).unwrap();
    let line = prefix.matches('\n').count() as u32;
    let col = prefix.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
    Pos::new(line, col)
}

fn naive_replay(s: &str, applied: &[AppliedChange]) -> String {
    let mut cur = s.to_owned();
    for a in applied {
        let from = naive_pos_to_offset(&cur, a.range.start);
        let to = naive_pos_to_offset(&cur, a.range.end);
        let mut v = utf16(&cur);
        v.splice(from..to, a.text.encode_utf16());
        cur = String::from_utf16(&v).unwrap();
    }
    cur
}

/// Builds a valid sorted, non-overlapping change set from random picks.
fn build_change_set(doc: &str, picks: &[(usize, usize, String)]) -> ChangeSet {
    let b = boundaries(doc);
    let mut points: Vec<u32> = picks.iter().flat_map(|(x, y, _)| [b[x % b.len()], b[y % b.len()]]).collect();
    points.sort_unstable();
    let changes = points
        .chunks(2)
        .zip(picks)
        .map(|(pair, (_, _, insert))| TextChange { from: pair[0], to: pair[1], insert: insert.clone() })
        .collect();
    ChangeSet { changes }
}

fn byte_point(s: &str, byte: usize) -> BytePoint {
    let prefix = &s[..byte];
    let row = prefix.matches('\n').count();
    let col = byte - prefix.rfind('\n').map_or(0, |i| i + 1);
    BytePoint { row, col }
}

/// Replays byte edits on `s` (as tree-sitter would), checking every point.
fn replay_bytes(s: &str, edits: &[ByteEdit], applied: &[AppliedChange]) -> Result<String, TestCaseError> {
    prop_assert_eq!(edits.len(), applied.len());
    let mut cur = s.to_owned();
    for (e, a) in edits.iter().zip(applied) {
        prop_assert_eq!(e.start, byte_point(&cur, e.start_byte));
        prop_assert_eq!(e.old_end, byte_point(&cur, e.old_end_byte));
        prop_assert_eq!(e.new_end_byte - e.start_byte, a.text.len());
        cur.replace_range(e.start_byte..e.old_end_byte, &a.text);
        prop_assert_eq!(e.new_end, byte_point(&cur, e.new_end_byte));
    }
    Ok(cur)
}

fn picks_strategy() -> impl Strategy<Value = Vec<(usize, usize, String)>> {
    prop::collection::vec((any::<usize>(), any::<usize>(), text_strategy(6)), 0..8)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn change_set_matches_naive(doc_text in text_strategy(60), picks in picks_strategy()) {
        let cs = build_change_set(&doc_text, &picks);
        let mut doc = Document::new(&doc_text);
        let applied = doc.apply(0, &cs).unwrap();
        let expected = naive_apply(&doc_text, &cs);
        prop_assert_eq!(doc.text(), expected.clone());
        prop_assert_eq!(doc.version(), 1);
        prop_assert_eq!(naive_replay(&doc_text, &applied), expected);
    }

    #[test]
    fn byte_edits_replay(doc_text in text_strategy(60), picks in picks_strategy()) {
        let cs = build_change_set(&doc_text, &picks);
        let mut doc = Document::new(&doc_text);
        let (applied, edits) = doc.apply_detailed(0, &cs).unwrap();
        prop_assert_eq!(replay_bytes(&doc_text, &edits, &applied)?, doc.text());
    }

    #[test]
    fn apply_edits_matches_naive(doc_text in text_strategy(60), picks in picks_strategy(), seed in any::<u64>()) {
        let cs = build_change_set(&doc_text, &picks);
        let edits: Vec<TextEdit> = cs
            .changes
            .iter()
            .map(|c| TextEdit {
                range: Range::new(
                    naive_offset_to_pos(&doc_text, c.from as usize),
                    naive_offset_to_pos(&doc_text, c.to as usize),
                ),
                new_text: c.insert.clone(),
            })
            .collect();
        // Shuffle, then restore the relative order of edits with identical ranges
        // (same-position inserts), whose order is significant.
        let mut order: Vec<usize> = (0..edits.len()).collect();
        let mut state = seed | 1;
        for i in (1..order.len()).rev() {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            order.swap(i, (state >> 33) as usize % (i + 1));
        }
        let mut groups: std::collections::HashMap<Range, Vec<usize>> = Default::default();
        for (slot, &orig) in order.iter().enumerate() {
            groups.entry(edits[orig].range).or_default().push(slot);
        }
        for slots in groups.values() {
            let mut originals: Vec<usize> = slots.iter().map(|&k| order[k]).collect();
            originals.sort_unstable();
            for (&k, orig) in slots.iter().zip(originals) {
                order[k] = orig;
            }
        }
        let edits: Vec<TextEdit> = order.iter().map(|&i| edits[i].clone()).collect();
        let mut doc = Document::new(&doc_text);
        let (set, applied) = doc.apply_edits(&edits).unwrap();
        let expected = naive_apply(&doc_text, &cs);
        prop_assert_eq!(doc.text(), expected.clone());
        prop_assert_eq!(naive_apply(&doc_text, &set), expected.clone());
        prop_assert_eq!(naive_replay(&doc_text, &applied), expected);
    }

    #[test]
    fn replace_all_matches(a in text_strategy(40), b in text_strategy(40)) {
        let mut doc = Document::new(&a);
        let set = doc.replace_all(&b);
        prop_assert_eq!(doc.text(), b.clone());
        prop_assert_eq!(naive_apply(&a, &set), b.clone());
        prop_assert!(set.changes.windows(2).all(|w| w[0].to < w[1].from));
        prop_assert_eq!(set.changes.is_empty(), a == b);
    }

    #[test]
    fn coordinate_round_trips(text in text_strategy(80)) {
        let doc = Document::new(&text);
        prop_assert_eq!(doc.len_utf16() as usize, text.encode_utf16().count());
        prop_assert_eq!(doc.line_count() as usize, text.split('\n').count());
        for off in boundaries(&text) {
            let pos = doc.offset_to_pos(off);
            prop_assert_eq!(pos, naive_offset_to_pos(&text, off as usize));
            prop_assert_eq!(doc.pos_to_offset(pos), off);
            let byte = doc.pos_to_byte(pos);
            prop_assert!(text.is_char_boundary(byte));
            prop_assert_eq!(doc.byte_to_pos(byte), pos);
            prop_assert_eq!(doc.offset_to_byte(off), byte);
            prop_assert_eq!(doc.byte_to_offset(byte), off);
        }
        for (i, line) in text.split('\n').enumerate() {
            prop_assert_eq!(doc.line(i as u32).unwrap(), line);
        }
    }

    #[test]
    fn crlf_round_trip(lines in prop::collection::vec(text_strategy(10).prop_map(|s| s.replace('\n', "")), 1..8)) {
        let original = lines.join("\r\n");
        let doc = Document::new(&original);
        prop_assert_eq!(doc.text(), lines.join("\n"));
        if lines.len() > 1 {
            prop_assert_eq!(doc.text_for_save(), original);
        }
    }
}

/// Guards against quadratic paths on huge single-line documents (minified
/// bundles): edits and conversions far into a 10 MB line stay fast.
#[test]
fn long_lines_stay_fast() {
    let line: String = "abcdefé😀".repeat(1_000_000);
    let mut doc = Document::new(&line);
    let len = doc.len_utf16();
    let start = std::time::Instant::now();
    for i in 0..2_000u32 {
        let at = (i.wrapping_mul(2_654_435_761) % len) & !1;
        let pos = doc.offset_to_pos(at);
        let off = doc.pos_to_offset(pos);
        let byte = doc.offset_to_byte(off);
        assert_eq!(doc.byte_to_offset(byte), off);
        let at = doc.pos_to_offset(doc.offset_to_pos(at));
        let cs = ChangeSet { changes: vec![TextChange { from: at, to: at, insert: "x\n".into() }] };
        let (_, edits) = doc.apply_detailed(doc.version(), &cs).unwrap();
        assert_eq!((edits[0].new_end.row, edits[0].new_end.col), (edits[0].start.row + 1, 0));
    }
    let elapsed = start.elapsed();
    assert_eq!(doc.line_count(), 2_001);
    // Generous bound (debug build, slow CI); a quadratic path takes minutes.
    assert!(elapsed < std::time::Duration::from_secs(20), "took {elapsed:?}");
}
