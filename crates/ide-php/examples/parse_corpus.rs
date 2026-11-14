//! Mago test-drive over the PHP corpora (phase 0.5).
//!
//! ```text
//! cargo run --release -p ide-php --example parse_corpus [-- <dir>...]
//! ```
//!
//! Without arguments it reads every corpus under `PHP_CORPUS_DIR` (default
//! `../php-corpus` next to the workspace, set up by `scripts/php-corpus.sh`).
//! It reports parse throughput (one thread and all cores), peak heap while
//! parsing, files with parse errors, and how much of the outline survives when
//! 200 files are cut short at random offsets. Results go in
//! `docs/php-engine/spike.md`.

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashSet;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ide_php::mago::allocator::LocalArena;
use ide_php::mago::database::file::FileId;
use ide_php::mago::syntax::parser::parse_file_content_with_settings;
use ide_php::mago::syntax::settings::ParserSettings;
use ide_php::probe::{DeclKind, Outline, Recovery, outline};

/// Counts live heap bytes so the run can report its peak.
struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call forwards to `System` unchanged; the counters are only bookkeeping.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: same contract as the caller's.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: same contract as the caller's.
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: same contract as the caller's.
        let new = unsafe { System.realloc(ptr, layout, new_size) };
        if !new.is_null() {
            if new_size >= layout.size() {
                let live = LIVE.fetch_add(new_size - layout.size(), Ordering::Relaxed) + new_size - layout.size();
                PEAK.fetch_max(live, Ordering::Relaxed);
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        new
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn reset_peak() -> usize {
    let live = LIVE.load(Ordering::Relaxed);
    PEAK.store(live, Ordering::Relaxed);
    live
}

fn mib(bytes: usize) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

struct SourceFile {
    corpus: String,
    /// `<corpus>/<path inside it>`, with forward slashes.
    path: String,
    text: Vec<u8>,
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if entry.file_name() != ".git" {
                collect(&path, out);
            }
        } else if kind.is_file() && path.extension().is_some_and(|e| e == "php") {
            out.push(path);
        }
    }
}

fn corpus_roots() -> Vec<PathBuf> {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if !args.is_empty() {
        return args;
    }
    let base = std::env::var_os("PHP_CORPUS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../php-corpus"));
    let mut roots: Vec<PathBuf> = std::fs::read_dir(&base)
        .unwrap_or_else(|e| panic!("cannot read corpus dir {}: {e} (run scripts/php-corpus.sh)", base.display()))
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    roots.sort();
    roots
}

/// xorshift64*: deterministic, so every run cuts the same files at the same offsets.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn parse_only(text: &[u8]) -> bool {
    let arena = LocalArena::new();
    let program = parse_file_content_with_settings(&arena, FileId::new(b"corpus"), text, ParserSettings::default());
    program.has_errors()
}

fn rate(files: usize, bytes: usize, elapsed: Duration) -> String {
    let secs = elapsed.as_secs_f64();
    format!("{:.0} files/s, {:.1} MiB/s ({:.2} s)", files as f64 / secs, mib(bytes) / secs, secs)
}

fn key(outline: &Outline) -> HashSet<(DeclKind, &str, u32)> {
    outline.declarations.iter().map(|d| (d.kind, d.name.as_str(), d.name_start)).collect()
}

fn main() {
    let roots = corpus_roots();
    let mut files = Vec::new();
    for root in &roots {
        let corpus = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut paths = Vec::new();
        collect(root, &mut paths);
        paths.sort();
        for path in paths {
            let text = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let inner = path.strip_prefix(root).unwrap_or(&path);
            files.push(SourceFile {
                corpus: corpus.clone(),
                path: format!("{corpus}/{}", inner.to_string_lossy().replace('\\', "/")),
                text,
            });
        }
    }
    let total_bytes: usize = files.iter().map(|f| f.text.len()).sum();
    println!("## Corpus\n");
    for root in &roots {
        let corpus = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let (n, b) = files.iter().filter(|f| f.corpus == corpus).fold((0, 0), |(n, b), f| (n + 1, b + f.text.len()));
        println!("- {corpus}: {n} files, {:.1} MiB", mib(b));
    }
    println!("- total: {} files, {:.1} MiB\n", files.len(), mib(total_bytes));

    // Parser only, one thread.
    let baseline = reset_peak();
    let started = Instant::now();
    let mut panics = Vec::new();
    for file in &files {
        if catch_unwind(AssertUnwindSafe(|| parse_only(&file.text))).is_err() {
            panics.push(file.path.clone());
        }
    }
    let parse_time = started.elapsed();
    let parse_peak = PEAK.load(Ordering::Relaxed) - baseline;

    // Parser only, all cores (each worker takes the next file).
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    let next = AtomicUsize::new(0);
    let started = Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(file) = files.get(i) else { break };
                    let _ = catch_unwind(AssertUnwindSafe(|| parse_only(&file.text)));
                }
            });
        }
    });
    let parallel_time = started.elapsed();

    // Full probe: parse, names, declarations, docblocks.
    let baseline = reset_peak();
    let started = Instant::now();
    let mut outlines: Vec<Option<Outline>> = Vec::with_capacity(files.len());
    for file in &files {
        outlines.push(catch_unwind(AssertUnwindSafe(|| outline(&file.text, Recovery::Default))).ok());
    }
    let probe_time = started.elapsed();
    let probe_peak = PEAK.load(Ordering::Relaxed) - baseline;

    println!("## Throughput\n");
    println!("- parse, 1 thread: {}", rate(files.len(), total_bytes, parse_time));
    println!("- parse, {threads} threads: {}", rate(files.len(), total_bytes, parallel_time));
    println!("- parse + names + outline + docblocks, 1 thread: {}", rate(files.len(), total_bytes, probe_time));
    println!(
        "- peak extra heap, parse one file at a time: {:.1} MiB; with the probe: {:.1} MiB",
        mib(parse_peak),
        mib(probe_peak)
    );
    let largest = files.iter().max_by_key(|f| f.text.len());
    if let Some(largest) = largest {
        let baseline = reset_peak();
        let _ = parse_only(&largest.text);
        println!(
            "- largest file: {} ({:.1} MiB source, {:.1} MiB peak to parse)",
            largest.path,
            mib(largest.text.len()),
            mib(PEAK.load(Ordering::Relaxed) - baseline)
        );
    }
    println!("- panics: {}", panics.len());
    for path in &panics {
        println!("  - {path}");
    }

    println!("\n## Parse errors\n");
    let mut with_errors = Vec::new();
    let (mut decls, mut docblocks, mut names) = (0, 0, 0);
    let mut doc_errors = Vec::new();
    for (file, outline) in files.iter().zip(&outlines) {
        let Some(outline) = outline else { continue };
        decls += outline.declarations.len();
        docblocks += outline.docblocks;
        for (offset, error) in &outline.docblock_errors {
            let line = 1 + file.text[..*offset as usize].iter().filter(|&&b| b == b'\n').count();
            doc_errors.push(format!("{}:{line}: {error}", file.path));
        }
        names += outline.resolved_names;
        if !outline.errors.is_empty() {
            with_errors.push((file, outline));
        }
    }
    println!("- files with errors: {} of {}", with_errors.len(), files.len());
    for (file, outline) in &with_errors {
        println!("  - {} ({} errors): {}", file.path, outline.errors.len(), outline.errors[0]);
    }
    println!("- declarations: {decls}; resolved names: {names}");
    println!("- docblocks on declarations: {docblocks}, with PHPDoc parse errors: {}", doc_errors.len());
    // Every 16th, so the sample spans the corpora instead of the first file.
    for error in doc_errors.iter().step_by(16) {
        println!("  - {error}");
    }

    println!("\n## Recovery on truncated files\n");
    let mut rng = Rng(0x5E_ED0F_7E57);
    let candidates: Vec<usize> = (0..files.len())
        .filter(|&i| outlines[i].as_ref().is_some_and(|o| o.errors.is_empty() && !o.declarations.is_empty()))
        .collect();
    let samples = 200.min(candidates.len());
    let mut chosen = HashSet::new();
    while chosen.len() < samples {
        chosen.insert(candidates[rng.below(candidates.len())]);
    }
    let mut chosen: Vec<usize> = chosen.into_iter().collect();
    chosen.sort_unstable();

    for recovery in [Recovery::Default, Recovery::Incomplete] {
        let (mut expected, mut recovered, mut complete, mut spurious, mut panicked) = (0, 0, 0, 0, 0);
        let mut rng = Rng(0xC_070F_F5E7);
        for &i in &chosen {
            let text = &files[i].text;
            let cut = 1 + rng.below(text.len() - 1);
            let full = outlines[i].as_ref().expect("candidate has an outline");
            let want: HashSet<_> = key(full).into_iter().filter(|&(_, _, start)| start < cut as u32).collect();
            let want: HashSet<_> =
                want.into_iter().filter(|(_, name, start)| (*start as usize + name.len()) <= cut).collect();
            let Ok(cut_outline) = catch_unwind(AssertUnwindSafe(|| outline(&text[..cut], recovery))) else {
                panicked += 1;
                continue;
            };
            let got = key(&cut_outline);
            let hit = want.intersection(&got).count();
            expected += want.len();
            recovered += hit;
            spurious += got.difference(&want).count();
            if hit == want.len() {
                complete += 1;
            }
        }
        println!(
            "- {recovery:?}: {recovered} of {expected} declarations before the cut recovered ({:.1}%); \
             {complete} of {samples} files fully recovered; {spurious} unexpected declarations; {panicked} panics",
            100.0 * recovered as f64 / expected.max(1) as f64
        );
    }
}
