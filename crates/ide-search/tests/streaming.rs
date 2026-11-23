//! Files that are not UTF-8 are decoded while they are searched. Searching the text decoded whole
//! (what an unsaved editor buffer of the file is) is the reference: the matches must be the same.

use ide_core::CancellationToken;
use ide_search::{FileMatches, SearchQuery, SearchScope, SearchSummary, TextSource, search_in_context};
use std::path::Path;
use std::sync::Mutex;

fn query(pattern: &str, is_regex: bool) -> SearchQuery {
    SearchQuery {
        pattern: pattern.into(),
        is_regex,
        case_sensitive: false,
        whole_word: false,
        include: vec![],
        exclude: vec![],
        scope: SearchScope::Project,
        max_matches: 1_000_000,
        context: Default::default(),
        include_excluded: false,
    }
}

fn run(root: &Path, q: &SearchQuery, source: TextSource<'_>) -> (Vec<FileMatches>, SearchSummary) {
    let out = Mutex::new(Vec::new());
    let summary =
        search_in_context(root, q, None, None, source, &CancellationToken::new(), &|f| out.lock().unwrap().push(f))
            .unwrap();
    let mut files = out.into_inner().unwrap();
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    (files, summary)
}

/// The matches of every file in `root`, read from disk and from its whole decoded text.
fn both_ways(root: &Path, q: &SearchQuery, fallback: Option<&str>) -> (String, String) {
    let streamed = run(root, q, TextSource { overlay: &|_| None, fallback: &|_| fallback.map(str::to_owned) });
    let whole = run(
        root,
        q,
        TextSource {
            overlay: &|path| ide_vfs::decode_text(&std::fs::read(path).unwrap(), fallback),
            fallback: &|_| None,
        },
    );
    let show = |(files, summary): (Vec<FileMatches>, SearchSummary)| {
        format!("{:#?}\nmatches {} limit {}", files, summary.matches, summary.limit_hit)
    };
    (show(streamed), show(whole))
}

fn first_difference(a: &str, b: &str) -> String {
    let (a, b): (Vec<_>, Vec<_>) = (a.lines().collect(), b.lines().collect());
    let at = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    format!(
        "line {at}:\nstreamed {:?}\nwhole    {:?}",
        &a[at.saturating_sub(3)..a.len().min(at + 3)],
        &b[at.saturating_sub(3)..b.len().min(at + 3)]
    )
}

fn utf16(text: &str, bom: bool, big: bool) -> Vec<u8> {
    let mut bytes = if bom { vec![if big { 0xFE } else { 0xFF }, if big { 0xFF } else { 0xFE }] } else { Vec::new() };
    for unit in text.encode_utf16() {
        bytes.extend(if big { unit.to_be_bytes() } else { unit.to_le_bytes() });
    }
    bytes
}

/// Lines of mixed width: ASCII, accents, CJK, astral characters (surrogate pairs), CRLF.
fn lines(count: usize) -> String {
    let mut text = String::new();
    for i in 0..count {
        match i % 6 {
            0 => text.push_str(&format!("{i} needle in plain ascii\n")),
            1 => text.push_str(&format!("{i} caf\u{e9} needle cr\u{e8}me\n")),
            2 => text.push_str(&format!("{i} \u{4e2d}\u{6587} needle \u{6d4b}\u{8bd5}\n")),
            3 => text.push_str(&format!("{i} \u{1f600} needle \u{1f4a9}\n")),
            4 => text.push_str(&format!("{i} crlf needle\r\n")),
            _ => text.push_str(&format!("{i} nothing here\n")),
        }
    }
    text
}

fn write(dir: &Path, name: &str, bytes: &[u8]) {
    std::fs::write(dir.join(name), bytes).unwrap();
}

#[test]
fn decoded_files_give_the_matches_of_their_whole_text() {
    let wide = lines(12_000);
    let gbk_text = wide.replace(['\u{1f600}', '\u{1f4a9}', '\u{e9}', '\u{e8}'], "");
    let latin_text = wide.replace(|c: char| c as u32 > 0xff, "");
    let dir = tempfile::tempdir().unwrap();
    // (BOM-less UTF-16 is not searched in decoded text, and not covered here: only the byte search sees it.)
    // Each file is well past the sizes the decoder reads at a time (64 KiB).
    assert!(wide.len() > 250_000);
    write(dir.path(), "utf16le_bom.txt", &utf16(&wide, true, false));
    write(dir.path(), "utf16be_bom.txt", &utf16(&wide, true, true));
    write(dir.path(), "gbk.txt", &encoding_rs::GBK.encode(&gbk_text).0);
    write(dir.path(), "latin1.txt", &encoding_rs::WINDOWS_1252.encode(&latin_text).0);
    write(dir.path(), "utf8.txt", wide.as_bytes());

    let queries = [
        query("needle", false),
        query("caf\u{e9}", false),
        query("\u{1f600}", false),
        query("\u{4e2d}\u{6587} needle", false),
        query(r"\d+ \S+ needle", true),
        query(r"needle\r?$", true),
        // A multi-line pattern reads the whole text, however it arrives.
        query("needle in plain ascii\n1 caf", false),
        SearchQuery { case_sensitive: true, whole_word: true, ..query("needle", false) },
    ];
    for q in &queries {
        for fallback in [None, Some("gbk"), Some("windows-1252")] {
            let (streamed, whole) = both_ways(dir.path(), q, fallback);
            assert!(
                streamed == whole,
                "{:?} fallback {fallback:?}\n{}",
                q.pattern,
                first_difference(&streamed, &whole)
            );
            assert!(streamed.len() > 100, "{:?} found nothing", q.pattern);
        }
    }
    // The match limit keeps the first matches of a file, and files take their share in any order:
    // one file at a time.
    for name in ["utf16le_bom.txt", "utf16be_bom.txt", "gbk.txt", "latin1.txt"] {
        for max_matches in [7, 64, 65, 5_000] {
            let q = SearchQuery { max_matches, include: vec![name.into()], ..query("needle", false) };
            let (streamed, whole) = both_ways(dir.path(), &q, None);
            assert!(streamed == whole, "{name} limit {max_matches}\n{}", first_difference(&streamed, &whole));
            assert!(streamed.contains(&format!("matches {max_matches} limit true")), "{name} {max_matches}");
        }
    }
}

#[test]
fn decoded_files_keep_their_multibyte_characters_across_every_read_boundary() {
    // A character sits on each of the 64 KiB read boundaries, at all alignments.
    let dir = tempfile::tempdir().unwrap();
    for pad in 0..8usize {
        let mut gbk = "x".repeat(64 * 1024 - 5 + pad);
        let mut utf16_text = gbk.clone();
        for i in 0..40 {
            gbk.push_str("\u{4e2d}\u{6587}");
            utf16_text.push_str(if i % 2 == 0 { "\u{1f600}" } else { "\u{4e2d}" });
            gbk.push_str(&"y".repeat(i % 3));
            utf16_text.push_str(&"y".repeat(i % 3));
        }
        gbk.push_str("yy needle\n");
        utf16_text.push_str("yy needle\n");
        write(dir.path(), &format!("gbk{pad}.txt"), &encoding_rs::GBK.encode(&gbk).0);
        write(dir.path(), &format!("utf16_{pad}.txt"), &utf16(&utf16_text, true, pad % 2 == 0));
        write(
            dir.path(),
            &format!("latin{pad}.txt"),
            &[gbk.as_bytes()[..64 * 1024 - 7 + pad].to_vec(), b"\xe9\xe8 needle\n".to_vec()].concat(),
        );
    }
    for pattern in ["needle", "y+ needle", "\u{4e2d}\u{6587}"] {
        let q = query(pattern, pattern.contains('+'));
        let (streamed, whole) = both_ways(dir.path(), &q, None);
        assert!(streamed == whole, "{pattern}\n{}", first_difference(&streamed, &whole));
        assert!(streamed.len() > 100, "{pattern} found nothing");
    }
}

#[test]
fn nul_characters_in_decoded_text_mark_it_binary_as_in_the_whole_text() {
    // Text held whole is binary when a NUL is in its first 64 KiB or in a line that matches,
    // which is not the same as a NUL anywhere.
    let text = lines(20_000);
    let with_nul = |at: &str| text.replacen(at, &format!("\0{at}"), 1);
    let cases = [
        ("early", with_nul("5 nothing here"), false),
        ("late in a line that does not match", with_nul("19997 nothing here"), true),
        ("late in a line that matches", with_nul("19998 needle"), false),
    ];
    for (name, text, found) in cases {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.txt", &utf16(&text, true, false));
        let (streamed, whole) = both_ways(dir.path(), &query("needle", false), None);
        assert!(streamed == whole, "{name}\n{}", first_difference(&streamed, &whole));
        assert_eq!(streamed.contains("a.txt"), found, "{name}");
    }
}

#[test]
fn a_file_is_decoded_when_its_search_reaches_the_byte_that_is_not_utf8() {
    // Valid UTF-8 up to the last line: the whole file is read as the detected Windows-1252.
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "late.txt", &[lines(1500).as_bytes(), b"caf\xe9 needle\n"].concat());
    for q in [query("needle", false), query("caf", false)] {
        let (streamed, whole) = both_ways(dir.path(), &q, None);
        assert!(streamed == whole, "{}", first_difference(&streamed, &whole));
        assert!(streamed.contains("cafÃ©"), "decoded as Windows-1252");
    }
}
