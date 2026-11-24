//! Searching a big file holds a bounded amount of it in memory, whatever its encoding and the
//! search context. Allocations of the whole process are counted, so this is one test with
//! sequential scenarios.

use ide_core::CancellationToken;
use ide_search::{
    FileMatches, Literals, SearchContext, SearchQuery, SearchScope, SearchSummary, TextSource, search_in_context,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grow(by: usize) {
    let live = LIVE.fetch_add(by, Relaxed) + by;
    PEAK.fetch_max(live, Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        grow(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        grow(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if new_size >= layout.size() {
            grow(new_size - layout.size());
        } else {
            LIVE.fetch_sub(layout.size() - new_size, Relaxed);
        }
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

const MIB: usize = 1024 * 1024;
/// What a search may hold at once: a few buffers of the reader and the decoder. The files are
/// 16 to 40 MiB, so a search that reads one whole (or decodes it whole) is far over.
const BOUND: usize = 4 * MIB;

fn query(context: SearchContext) -> SearchQuery {
    SearchQuery {
        pattern: "needle".into(),
        is_regex: false,
        case_sensitive: true,
        whole_word: false,
        include: vec![],
        exclude: vec![],
        scope: SearchScope::Project,
        max_matches: 1_000_000,
        context,
        include_excluded: false,
    }
}

/// Runs a search and returns its result with the most memory it held over what was live before.
fn measured(
    root: &Path,
    context: SearchContext,
    literals: Option<Literals<'_>>,
) -> (Vec<FileMatches>, SearchSummary, usize) {
    let out = Mutex::new(Vec::new());
    let before = LIVE.load(Relaxed);
    PEAK.store(before, Relaxed);
    let summary = search_in_context(
        root,
        &query(context),
        None,
        literals,
        TextSource::detected(&|_| None),
        &CancellationToken::new(),
        &|f| out.lock().unwrap().push(f),
    )
    .unwrap();
    let held = PEAK.load(Relaxed).saturating_sub(before);
    // The results are in `out` and count against the search; they are small.
    (out.into_inner().unwrap(), summary, held)
}

fn write_repeated(path: &Path, bom: &[u8], block: &[u8], size: usize) {
    use std::io::Write;
    let mut file = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    file.write_all(bom).unwrap();
    for _ in 0..size / block.len() + 1 {
        file.write_all(block).unwrap();
    }
}

fn utf16le(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

#[test]
fn searching_a_big_file_holds_a_bounded_part_of_it() {
    let block = "2026-11-22 13:00:01 INFO caf\u{e9} \u{4e2d}\u{6587} request ok\n".repeat(50)
        + "2026-11-22 13:00:02 ERROR needle marker found\n";
    let latin_text = block.replace(['\u{4e2d}', '\u{6587}'], "x");
    let (latin1, _, _) = encoding_rs::WINDOWS_1252.encode(&latin_text);
    let (gbk, _, _) = encoding_rs::GBK.encode(&block);
    let parsed = Mutex::new(Vec::new());
    let literals = |path: &Path, _: &str| {
        parsed.lock().unwrap().push(path.file_name().unwrap().to_string_lossy().into_owned());
        None
    };

    let dir = tempfile::tempdir().unwrap();
    let mut expected = Vec::new();
    for (name, bom, bytes, size) in [
        ("latin1.log", &b""[..], &latin1[..], 16 * MIB),
        ("gbk.log", &b""[..], &gbk[..], 16 * MIB),
        ("utf16.log", &[0xFF, 0xFE][..], &utf16le(&block)[..], 24 * MIB),
        ("utf8.log", &b""[..], block.as_bytes(), 40 * MIB),
    ] {
        let one = tempfile::tempdir_in(dir.path()).unwrap();
        write_repeated(&one.path().join(name), bom, bytes, size);
        // Plain search: the byte search, then the decoded search of a non-UTF-8 file.
        let (files, summary, held) = measured(one.path(), SearchContext::Any, None);
        assert_eq!(files.len(), 1, "{name}");
        assert!(summary.matches > 100, "{name}");
        assert!(held < BOUND, "{name}: plain search held {} MiB", held / MIB);
        expected.push((name, summary.matches, one));
    }

    // Searching with a context reads a file whole only to find its comments and strings, and
    // past the parser's limit it has none: the file is searched as it is read.
    for (name, matches, one) in &expected {
        for context in [SearchContext::ExceptComments, SearchContext::ExceptCommentsAndStringLiterals] {
            let (files, summary, held) = measured(one.path(), context, Some(&literals));
            if *name == "utf8.log" {
                assert_eq!(summary.matches, *matches, "{name} {context:?}");
                assert_eq!(files.len(), 1);
                assert!(held < BOUND, "{name}: {context:?} held {} MiB", held / MIB);
            }
        }
    }
    let (_, only_in, held) = measured(expected[3].2.path(), SearchContext::InComments, Some(&literals));
    assert_eq!(only_in.matches, 0, "a file without comments has no match in them");
    assert!(held < BOUND, "held {} MiB", held / MIB);
    let parsed = parsed.into_inner().unwrap();
    assert!(parsed.iter().any(|name| name == "gbk.log"), "files within the limit are still analysed");
    assert!(!parsed.iter().any(|name| name == "utf8.log"), "a 40 MiB text is never handed to the parser");
}
